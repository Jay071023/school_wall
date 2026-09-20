'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const route = fs.readFileSync(path.join(root, 'routes', 'deploy.js'), 'utf8');
const script = fs.readFileSync(path.join(root, 'deploy.sh'), 'utf8');
const architecture = fs.readFileSync(path.join(root, 'docs', 'ARCHITECTURE.md'), 'utf8');

function includes(source, fragment, message) {
  assert(source.includes(fragment), message);
}

includes(route, "req.headers['x-gitee-token']", 'webhook 必须读取 Gitee token 请求头');
includes(route, "router.get('/deploy-status'", '部署必须提供可查询的状态接口');
includes(route, "req.body && typeof req.body.ref === 'string'", 'webhook 应读取 Gitee 发布分支');
includes(route, '非发布分支，已跳过部署', '非发布分支不得触发部署');
includes(route, 'crypto.timingSafeEqual', 'webhook token 比较必须使用 timingSafeEqual');
includes(route, "spawn(process.env.DEPLOY_BASH || 'bash'", 'webhook 必须使用 spawn 启动部署脚本');
includes(route, 'detached: true', '部署进程必须脱离请求生命周期');
includes(route, "stdio: 'ignore'", '部署子进程不能把 stdout/stderr 回传到请求进程');
includes(route, 'child.unref()', '部署子进程必须 unref');
includes(route, 'wall-deploy.service', 'Webhook 应优先启动独立部署单元');
includes(route, 'DEPLOY_DISABLE_SYSTEMD_LAUNCHER', '部署单元启动必须保留可配置的降级开关');
assert(!route.includes("require('child_process').exec") && !route.includes('exec(`'), 'webhook 不得通过 shell exec 拼接命令');
assert(!route.includes('console.log(token') && !route.includes('console.log(secret'), 'webhook 不得记录 token 或 secret');

includes(script, 'set -Eeuo pipefail', '部署脚本必须在未处理错误时退出');
includes(script, 'umask 022', '部署脚本不能把代码和依赖创建成服务用户不可读');
includes(script, '/www/server/nodejs/*/bin/node', '部署脚本必须兼容宝塔面板的 Node.js 路径');
includes(script, 'ensure_tool npm "$NPM"', '部署脚本必须在安装依赖前确认 npm 可用');
includes(script, '"$NPM" ci --omit=dev || return 1', '存在根锁文件时必须严格使用 npm ci 并在失败时终止部署');
includes(script, '"$NPM" ci || return 1', '存在前端锁文件时必须严格使用 npm ci 并在失败时终止部署');
assert(!script.includes('ci --omit=dev || "$NPM" install') && !script.includes('"$NPM" ci || "$NPM" install'), 'npm ci 失败时不得回退到 npm install 掩盖锁文件不一致');
includes(script, 'check_frontend_mirror_for_rollback', '回滚历史版本时不能强制依赖新版本检查脚本');
includes(script, 'wait_for_health', '部署必须等待服务健康检查通过');
includes(script, 'sudo -n systemctl', '非 root Webhook 进程必须通过受限 sudo 控制服务');
includes(script, 'flock -n 9', '部署脚本必须使用 flock 防止重复部署');
includes(script, 'DEPLOY_LOCK_DIR', '部署脚本必须提供无 flock 时的锁回退');
includes(script, 'DEPLOY_FRONTEND_PARENT', '静态目录必须有独立的受信任父目录配置');
includes(script, 'expected_dir="$parent_dir/frontend"', '静态目标必须精确等于受信任父目录下的 frontend');
includes(script, 'target_real', '静态目标存在时必须校验真实路径，拒绝外部 symlink');
assert(!script.includes('case "$DEPLOY_FRONTEND_DIR" in\n    */frontend)'), '不得仅凭 frontend 后缀授权删除');
includes(script, '+refs/heads/$DEPLOY_BRANCH:$DEPLOY_REMOTE_REF', '部署脚本必须允许 Gitee 历史清理后的远端引用强制更新');
includes(script, 'git reset --hard "$TARGET_REV"', '部署脚本必须切换到拉取到的目标提交');
includes(script, 'DEPLOY_REEXEC_AFTER_UPDATE', '切换提交后必须重新加载新版本部署脚本');
includes(script, 'DEPLOY_PREVIOUS_REV', '重新加载部署脚本时必须保留原提交用于回滚');
includes(script, 'exec "${BASH:-/bin/bash}" "$DEPLOY_DIR/deploy.sh"', '部署脚本必须 exec 新工作树中的自身版本');
includes(script, 'DEPLOY_LOCK_HELD', '重新加载部署脚本时必须继承部署锁');
includes(script, 'rsync -a --delete', 'rsync 路径必须删除静态目录中的过期文件');
includes(script, 'find "$DEPLOY_FRONTEND_DIR" -mindepth 1 -maxdepth 1', '无 rsync 时也必须删除过期静态文件');
includes(script, 'systemctl restart "$DEPLOY_SERVICE"', '部署成功前必须重启 systemd 服务');
assert(!script.includes('systemctl unavailable; skip service restart'), 'systemctl 不可用时不得静默跳过重启');
includes(script, 'rolling back to $PREVIOUS_REV', '新版本失败时必须回滚旧提交');
includes(script, 'deploy exit: $status', '部署日志必须记录最终退出码');
includes(script, 'DEPLOY_STATUS_FILE', '部署必须写入状态文件');
includes(script, 'write_status "$DEPLOY_STATE" "$TARGET_REV" "0"', '部署成功必须记录目标提交');
assert(!/https?:\/\/[^/\s@]+:[^/\s@]+@/.test(script), '脚本不得内置带凭据的远端 URL');

includes(architecture, 'node scripts/test-deployment-static.js', '部署文档必须记录部署静态检查');
includes(architecture, '202 Accepted', '部署文档必须说明 webhook 仅代表异步启动已接受');

console.log('[deployment-static] 通过：webhook 鉴权/异步启动、锁、Gitee 分支拉取、镜像同步、重启、退出码和回滚检查通过');
