#!/bin/bash

# 生产环境部署脚本。
#
# 运行约定：
# - 默认从 Gitee 的 main 拉取，避免把 origin 误当成发布源。
# - DEPLOY_FRONTEND_DIR / FRONTEND_DIR 可指定 Nginx 实际提供的静态目录。
# - DEPLOY_HEALTHCHECK_URL 可指定 Node API 健康检查地址；未配置时依次探测 3001、3000。
# - 新版本启动或健康检查失败时，自动回滚到部署前的提交。
# - 同一时间只允许一个部署运行，避免多个 webhook 交叉 reset/restart。
set -Eeuo pipefail
# 代码、依赖和 Nginx 静态文件必须能被 www/systemd 读取；密钥仍由 .env 的权限单独保护。
umask 022

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="${DEPLOY_DIR:-$SCRIPT_DIR}"
if ! DEPLOY_DIR="$(cd -- "$DEPLOY_DIR" 2>/dev/null && pwd -P)"; then
  echo "[deploy] deployment directory is not accessible"
  exit 1
fi
# 仓库可能是私有仓库，服务器已配置 Gitee SSH 凭据；如使用公开仓库可通过环境变量改为 HTTPS。
DEPLOY_REPO_URL="${DEPLOY_REPO_URL:-git@example.com:example/campus-wall.git}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
DEPLOY_SERVICE="${DEPLOY_SERVICE:-wall}"
DEPLOY_HEALTHCHECK_TIMEOUT="${DEPLOY_HEALTHCHECK_TIMEOUT:-10}"
LOG_FILE="${DEPLOY_LOG_FILE:-$DEPLOY_DIR/logs/deploy.log}"
DEPLOY_LOCK_PATH="${DEPLOY_LOCK_PATH:-$DEPLOY_DIR/.deploy.lock}"
DEPLOY_STATUS_FILE="${DEPLOY_STATUS_FILE:-$DEPLOY_DIR/logs/deploy-status.json}"
DEPLOY_STATE="starting"
# git reset 后重新执行工作树里的新脚本，避免本次部署继续使用旧版本函数。
DEPLOY_REEXEC_AFTER_UPDATE="${DEPLOY_REEXEC_AFTER_UPDATE:-0}"
DEPLOY_LOCK_HELD="${DEPLOY_LOCK_HELD:-0}"
DEPLOY_LOCK_FALLBACK="${DEPLOY_LOCK_FALLBACK:-0}"
DEPLOY_PREVIOUS_REV="${DEPLOY_PREVIOUS_REV:-}"

# systemd 往往使用精简 PATH，面板安装的 Node.js 不一定能被 command -v 找到。
# 优先使用显式配置，其次使用当前 PATH，最后探测常见的宝塔 Node.js 安装目录。
NODE="${NODE_PATH_BIN:-$(command -v node 2>/dev/null || true)}"
if [ -z "$NODE" ]; then
  for candidate in /www/server/nodejs/*/bin/node /usr/local/node*/bin/node; do
    if [ -x "$candidate" ]; then
      NODE="$candidate"
      break
    fi
  done
fi
NODE="${NODE:-node}"

if [ -x "$NODE" ]; then
  NODE_BIN_DIR="$(dirname -- "$NODE")"
  case ":$PATH:" in
    *":$NODE_BIN_DIR:"*) ;;
    *) PATH="$NODE_BIN_DIR:$PATH"; export PATH ;;
  esac
fi

NPM="${NPM_PATH:-$(command -v npm 2>/dev/null || true)}"
if [ -z "$NPM" ] && [ -x "$(dirname -- "$NODE")/npm" ]; then
  NPM="$(dirname -- "$NODE")/npm"
fi
NPM="${NPM:-npm}"

ensure_tool() {
  local label="$1"
  local value="$2"
  if [ -x "$value" ] || command -v "$value" >/dev/null 2>&1; then
    return 0
  fi
  echo "[deploy] $label is unavailable: $value"
  return 1
}

# 兼容旧运维配置：旧配置若使用 FRONTEND_DIR，仍可作为 Nginx 静态目录。
DEPLOY_FRONTEND_DIR="${DEPLOY_FRONTEND_DIR:-${FRONTEND_DIR:-}}"
DEPLOY_FRONTEND_SOURCE="${DEPLOY_FRONTEND_SOURCE:-$DEPLOY_DIR/frontend}"
DEPLOY_FRONTEND_PARENT="${DEPLOY_FRONTEND_PARENT:-$(dirname -- "$DEPLOY_DIR")}"
if [ -z "$DEPLOY_FRONTEND_DIR" ] && [ -d "$DEPLOY_DIR/../frontend" ] && [ "$DEPLOY_DIR/../frontend" != "$DEPLOY_FRONTEND_SOURCE" ]; then
  DEPLOY_FRONTEND_DIR="$(dirname -- "$DEPLOY_DIR")/frontend"
fi

DEPLOY_HOME_DIR="${DEPLOY_HOME_DIR:-${HOME:-/home/www}}"
DEPLOY_SSH_CONFIG="${DEPLOY_SSH_CONFIG:-$DEPLOY_HOME_DIR/.ssh/config}"

mkdir -p "$(dirname -- "$LOG_FILE")" "$(dirname -- "$DEPLOY_LOCK_PATH")"
exec >> "$LOG_FILE" 2>&1

log_stamp() {
  date '+%Y-%m-%d %H:%M:%S'
}

write_status() {
  local state="$1"
  local revision="${2:-${TARGET_REV:-${PREVIOUS_REV:-}}}"
  local exit_code="${3:-}"
  local updated_at
  local temp_file
  updated_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  temp_file="${DEPLOY_STATUS_FILE}.tmp.$$"
  mkdir -p "$(dirname -- "$DEPLOY_STATUS_FILE")" || return 0
  if [ -n "$exit_code" ]; then
    printf '{"state":"%s","revision":"%s","updatedAt":"%s","exitCode":%s}\n' \
      "$state" "$revision" "$updated_at" "$exit_code" > "$temp_file"
  else
    printf '{"state":"%s","revision":"%s","updatedAt":"%s"}\n' \
      "$state" "$revision" "$updated_at" > "$temp_file"
  fi
  mv -f -- "$temp_file" "$DEPLOY_STATUS_FILE" || rm -f -- "$temp_file"
}

on_exit() {
  local status=$?
  if [ "$status" -ne 0 ] && [ "$DEPLOY_STATE" != "failed" ]; then
    DEPLOY_STATE="failed"
    write_status "$DEPLOY_STATE" "${TARGET_REV:-${PREVIOUS_REV:-}}" "$status" || true
  fi
  if [ "${FALLBACK_LOCK_HELD:-0}" = 1 ]; then
    rm -f -- "$DEPLOY_LOCK_DIR/pid" 2>/dev/null || true
    rmdir "$DEPLOY_LOCK_DIR" 2>/dev/null || true
  fi
  echo "[$(log_stamp)] deploy exit: $status"
}
trap on_exit EXIT

echo "[$(log_stamp)] deploy start"
write_status "$DEPLOY_STATE" "" "" || true

ensure_tool node "$NODE" || exit 1
ensure_tool npm "$NPM" || exit 1

# 不接受把凭据直接塞进远端 URL；否则 git 的错误输出可能把它带入部署日志。
case "$DEPLOY_REPO_URL" in
  http://*@*|https://*@*)
    echo "[deploy] refusing repository URL with embedded credentials"
    exit 1
    ;;
esac

if [ -f "$DEPLOY_SSH_CONFIG" ]; then
  export GIT_SSH_COMMAND="ssh -F $DEPLOY_SSH_CONFIG"
fi

cd "$DEPLOY_DIR" || {
  echo "[deploy] deployment directory is not accessible"
  exit 1
}

# flock 释放依赖进程退出；没有 flock 的系统使用原子目录锁，并在退出时清理。
# 重新执行新脚本时继承已持有的锁，不重复抢锁。
if [ "$DEPLOY_LOCK_HELD" = 1 ]; then
  if [ "$DEPLOY_LOCK_FALLBACK" = 1 ]; then
    DEPLOY_LOCK_DIR="${DEPLOY_LOCK_PATH}.d"
    FALLBACK_LOCK_HELD=1
  fi
elif command -v flock >/dev/null 2>&1; then
  exec 9>"$DEPLOY_LOCK_PATH"
  if ! flock -n 9; then
    echo "[deploy] another deployment is already running"
    exit 1
  fi
else
  DEPLOY_LOCK_DIR="${DEPLOY_LOCK_PATH}.d"
  FALLBACK_LOCK_HELD=0
  acquire_fallback_lock() {
    if mkdir "$DEPLOY_LOCK_DIR" 2>/dev/null; then
      FALLBACK_LOCK_HELD=1
      printf '%s\n' "$$" > "$DEPLOY_LOCK_DIR/pid"
      return 0
    fi

    local owner_pid=""
    if [ -r "$DEPLOY_LOCK_DIR/pid" ]; then
      owner_pid="$(<"$DEPLOY_LOCK_DIR/pid")"
    fi
    if [ -n "$owner_pid" ] && kill -0 "$owner_pid" 2>/dev/null; then
      echo "[deploy] another deployment is already running"
      return 1
    fi

    # 只移除确认没有存活进程的锁目录，不递归删除，避免误删部署目录。
    if ! rm -f -- "$DEPLOY_LOCK_DIR/pid" || ! rmdir "$DEPLOY_LOCK_DIR" 2>/dev/null; then
      echo "[deploy] another deployment is already running"
      return 1
    fi
    mkdir "$DEPLOY_LOCK_DIR" || return 1
    FALLBACK_LOCK_HELD=1
    printf '%s\n' "$$" > "$DEPLOY_LOCK_DIR/pid"
  }
  acquire_fallback_lock
fi

PREVIOUS_REV="${DEPLOY_PREVIOUS_REV:-$(git rev-parse HEAD 2>/dev/null || true)}"
if [ -z "$PREVIOUS_REV" ]; then
  echo "[deploy] current checkout is not a git repository"
  exit 1
fi

run_npm_install() {
  cd "$DEPLOY_DIR" || return 1
  if [ -f package-lock.json ]; then
    # 锁文件存在时必须严格按锁文件安装。npm ci 失败通常意味着锁文件不一致，
    # 不能再用 npm install 改写依赖树后继续上线。
    "$NPM" ci --omit=dev || return 1
  else
    "$NPM" install --omit=dev || return 1
  fi

  if [ -d "$DEPLOY_DIR/frontend" ] && [ -f "$DEPLOY_DIR/frontend/package.json" ]; then
    cd "$DEPLOY_DIR/frontend"
    if [ -f package-lock.json ]; then
      "$NPM" ci || return 1
    else
      "$NPM" install || return 1
    fi
  fi
}

check_frontend_mirror() {
  local checker="$DEPLOY_DIR/scripts/check-frontend-mirror.js"
  if [ ! -f "$checker" ]; then
    echo "[deploy] frontend/public mirror checker is missing"
    return 1
  fi
  "$NODE" "$checker" || return 1
}

check_frontend_mirror_for_rollback() {
  local checker="$DEPLOY_DIR/scripts/check-frontend-mirror.js"
  if [ ! -f "$checker" ]; then
    # 回滚到历史版本时，检查脚本可能尚未存在；不能因此阻断旧版本恢复。
    echo "[deploy] legacy revision has no frontend mirror checker; skipping optional check"
    return 0
  fi
  "$NODE" "$checker" || return 1
}

sync_frontend() {
  if [ -z "$DEPLOY_FRONTEND_DIR" ] || [ "$DEPLOY_FRONTEND_DIR" = "$DEPLOY_FRONTEND_SOURCE" ]; then
    return 0
  fi
  if [ ! -d "$DEPLOY_FRONTEND_SOURCE" ]; then
    echo "[deploy] frontend source not found: $DEPLOY_FRONTEND_SOURCE"
    return 1
  fi
  local target_dir="${DEPLOY_FRONTEND_DIR%/}"
  local parent_dir
  local expected_dir
  local target_real

  if [ -z "$target_dir" ] || [ "$target_dir" = "/" ]; then
    echo "[deploy] refusing unsafe frontend target"
    return 1
  fi
  case "$DEPLOY_FRONTEND_PARENT" in
    /*) ;;
    *)
      echo "[deploy] frontend parent must be an absolute path"
      return 1
      ;;
  esac
  if [ ! -d "$DEPLOY_FRONTEND_PARENT" ]; then
    echo "[deploy] frontend parent directory does not exist"
    return 1
  fi
  parent_dir="$(cd -- "$DEPLOY_FRONTEND_PARENT" && pwd -P)" || return 1
  case "$parent_dir" in
    "/"|"$DEPLOY_DIR"|"$DEPLOY_DIR"/*)
      echo "[deploy] refusing frontend parent inside deployment directory"
      return 1
      ;;
  esac
  expected_dir="$parent_dir/frontend"
  if [ "$target_dir" != "$expected_dir" ]; then
    echo "[deploy] frontend target must be the configured parent's frontend directory"
    return 1
  fi
  if [ -e "$target_dir" ]; then
    target_real="$(cd -- "$target_dir" && pwd -P)" || return 1
    if [ "$target_real" != "$expected_dir" ]; then
      echo "[deploy] refusing frontend target symlink outside configured parent"
      return 1
    fi
  fi
  mkdir -p "$DEPLOY_FRONTEND_DIR" || return 1
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete -- "$DEPLOY_FRONTEND_SOURCE/" "$DEPLOY_FRONTEND_DIR/" || return 1
  else
    # cp 没有删除语义；先清空已通过路径校验的静态目录，确保旧资源不会残留。
    find "$DEPLOY_FRONTEND_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + || return 1
    cp -a "$DEPLOY_FRONTEND_SOURCE/." "$DEPLOY_FRONTEND_DIR/" || return 1
  fi
}

run_systemctl() {
  if [ "$(id -u)" -eq 0 ]; then
    systemctl "$@"
    return $?
  fi
  if ! command -v sudo >/dev/null 2>&1; then
    echo "[deploy] sudo unavailable for non-root service control"
    return 1
  fi
  sudo -n systemctl "$@"
}

restart_service() {
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "[deploy] systemctl unavailable; refusing to report a deployment without restart"
    return 1
  fi
  if ! run_systemctl restart "$DEPLOY_SERVICE"; then
    echo "[deploy] service restart failed"
    return 1
  fi
  if ! run_systemctl is-active "$DEPLOY_SERVICE" >/dev/null 2>&1; then
    echo "[deploy] service is not active after restart"
    return 1
  fi
}

check_url() {
  local url="$1"
  local body
  if ! command -v curl >/dev/null 2>&1; then
    echo "[deploy] curl unavailable; health check cannot run"
    return 1
  fi
  if ! body="$(curl --fail --silent --show-error --max-time "$DEPLOY_HEALTHCHECK_TIMEOUT" "$url" 2>/dev/null)"; then
    echo "[deploy] health check request failed"
    return 1
  fi
  if [[ "$url" == */api/site-info ]]; then
    echo "$body" | grep -Eq '"code"[[:space:]]*:[[:space:]]*200' || return 1
  fi
}

health_check() {
  local api_url
  local public_url
  if [ -n "${DEPLOY_HEALTHCHECK_URL:-}" ]; then
    check_url "$DEPLOY_HEALTHCHECK_URL" || return 1
  else
    # 历史生产配置使用 3001，源码默认端口为 3000；兼容两种配置。
    check_url "http://127.0.0.1:${DEPLOY_PORT:-3001}/api/site-info" 2>/dev/null && api_url="ok" || api_url=""
    if [ -z "$api_url" ]; then
      check_url "http://127.0.0.1:${PORT:-3000}/api/site-info" || return 1
    fi
  fi
  public_url="${DEPLOY_PUBLIC_HEALTHCHECK_URL:-}"
  if [ -n "$public_url" ]; then
    check_url "$public_url" || return 1
  fi
}

wait_for_health() {
  local attempts="${DEPLOY_HEALTHCHECK_ATTEMPTS:-12}"
  local interval="${DEPLOY_HEALTHCHECK_INTERVAL:-2}"
  local attempt
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    if health_check; then
      return 0
    fi
    if [ "$attempt" -lt "$attempts" ]; then
      sleep "$interval"
    fi
  done
  return 1
}

rollback() {
  local rollback_ok=1
  echo "[deploy] rolling back to $PREVIOUS_REV"
  if git reset --hard "$PREVIOUS_REV" && run_npm_install && check_frontend_mirror_for_rollback && sync_frontend && restart_service && wait_for_health; then
    rollback_ok=0
    echo "[deploy] rollback complete"
  else
    echo "[deploy] rollback health check failed; manual intervention required"
  fi
  return "$rollback_ok"
}

if ! git check-ref-format --branch "$DEPLOY_BRANCH" >/dev/null 2>&1; then
  echo "[deploy] invalid deployment branch configuration"
  exit 1
fi

DEPLOY_REMOTE_REF="refs/remotes/deploy/$DEPLOY_BRANCH"
# 发布源是受信任的 Gitee main；主分支可能经过已审计的历史清理，
# 因此必须允许服务器上的远端跟踪引用从旧历史切换到新历史。
if ! git fetch --prune "$DEPLOY_REPO_URL" "+refs/heads/$DEPLOY_BRANCH:$DEPLOY_REMOTE_REF"; then
  echo "[deploy] failed to fetch Gitee source"
  exit 1
fi

TARGET_REV="$(git rev-parse "$DEPLOY_REMOTE_REF")"
echo "[deploy] target revision: $TARGET_REV"
DEPLOY_STATE="running"
write_status "$DEPLOY_STATE" "$TARGET_REV" "" || true
if ! git reset --hard "$TARGET_REV"; then
  echo "[deploy] failed to update checkout"
  if ! rollback; then
    exit 2
  fi
  exit 1
fi

# 当前 shell 已加载的是旧版本 deploy.sh；切换代码后重新 exec 新文件，
# 并把原提交和锁状态传递过去，确保新逻辑真正参与本次部署。
if [ "$DEPLOY_REEXEC_AFTER_UPDATE" != 1 ]; then
  export DEPLOY_REEXEC_AFTER_UPDATE=1
  export DEPLOY_LOCK_HELD=1
  export DEPLOY_PREVIOUS_REV="$PREVIOUS_REV"
  if [ "${FALLBACK_LOCK_HELD:-0}" = 1 ]; then
    export DEPLOY_LOCK_FALLBACK=1
  fi
  exec "${BASH:-/bin/bash}" "$DEPLOY_DIR/deploy.sh"
fi

if ! run_npm_install || ! check_frontend_mirror || ! sync_frontend || ! restart_service || ! wait_for_health; then
  echo "[deploy] new version failed startup or health check"
  DEPLOY_STATE="failed"
  write_status "$DEPLOY_STATE" "$TARGET_REV" "1" || true
  if ! rollback; then
    exit 2
  fi
  exit 1
fi

DEPLOY_STATE="success"
write_status "$DEPLOY_STATE" "$TARGET_REV" "0" || true
echo "[$(date '+%Y-%m-%d %H:%M:%S')] deploy complete: $TARGET_REV"
