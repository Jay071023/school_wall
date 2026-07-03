#!/usr/bin/env node
/**
 * upload-go.js - 自动编译并重启 Go 后端
 *
 * 用法:
 *   node upload-go.js               # 编译并热替换
 *   node upload-go.js --no-restart  # 只编译,不替换运行中的二进制
 *
 * 环境变量:
 *   SSH_KEY   SSH 私钥路径 (默认 ./ssh_key_new2)
 *   SERVER    服务器地址 (默认 root@124.222.255.33)
 *   REMOTE_DIR 远程 Go 项目目录 (默认 /www/wwwroot/wall.jay23.cn/campus-wall-go)
 *
 * 流程:
 *   1. 编译 Go 二进制到 campus-wall-new
 *   2. scp 二进制到服务器
 *   3. kill -STOP PM2 守护进程 (109046)
 *   4. pkill 旧 Go 进程 (释放 3001 端口)
 *   5. cp 新二进制覆盖
 *   6. kill -CONT PM2 守护进程 (自动拉起新进程)
 *   7. 验证 /ping 返回 200
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const CONFIG = {
  sshKey:   process.env.SSH_KEY   || path.join(__dirname, 'ssh_key_new2'),
  server:   process.env.SERVER    || 'root@124.222.255.33',
  remote:   process.env.REMOTE_DIR || '/www/wwwroot/wall.jay23.cn/campus-wall-go',
  goBin:    process.env.GO_BIN    || '/usr/local/go/bin/go',
  pm2Pid:   process.env.PM2_PID   || '109046',
  siteUrl:  process.env.SITE_URL  || 'http://127.0.0.1:3001/ping',
};

const NO_RESTART = process.argv.includes('--no-restart');

function log(msg) {
  console.log('[' + new Date().toLocaleTimeString() + '] ' + msg);
}

function err(msg) {
  console.error('[' + new Date().toLocaleTimeString() + '] ❌ ' + msg);
}

function ssh(cmd) {
  const full = `ssh -i "${CONFIG.sshKey}" -o StrictHostKeyChecking=no ${CONFIG.server} "${cmd}"`;
  const r = spawnSync(full, { shell: true, encoding: 'utf8' });
  if (r.status !== 0) {
    return { ok: false, stdout: r.stdout || '', stderr: r.stderr || '', code: r.status };
  }
  return { ok: true, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

function sshQuote(cmd) {
  // 给命令外面包一层 quotes 防止并发问题
  return `'${cmd.replace(/'/g, "'\\''")}'`;
}

async function checkPing() {
  return new Promise((resolve) => {
    http.get(CONFIG.siteUrl, (res) => {
      resolve(res.statusCode === 200);
    }).on('error', () => resolve(false));
  });
}

async function waitFor(predicate, timeoutMs, intervalMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

async function main() {
  log('🚀 upload-go.js 启动');
  log('配置: server=' + CONFIG.server + ' remote=' + CONFIG.remote);

  if (!fs.existsSync(CONFIG.sshKey)) {
    err('SSH 密钥不存在: ' + CONFIG.sshKey);
    process.exit(1);
  }

  const localDir = path.join(__dirname, 'campus-wall-go');
  if (!fs.existsSync(localDir)) {
    err('本地 Go 项目不存在: ' + localDir);
    process.exit(1);
  }

  // ---------- 步骤 1: 本地编译 ----------
  log('📦 步骤 1/5: 编译 Go 二进制...');
  const buildResult = spawnSync(CONFIG.goBin, ['build', '-o', 'campus-wall-new', '.'], {
    cwd: localDir,
    shell: true,
    encoding: 'utf8',
  });
  if (buildResult.status !== 0) {
    err('编译失败:\n' + (buildResult.stderr || buildResult.stdout));
    process.exit(1);
  }
  const localBin = path.join(localDir, 'campus-wall-new');
  if (!fs.existsSync(localBin)) {
    err('编译后二进制不存在: ' + localBin);
    process.exit(1);
  }
  const sizeMB = (fs.statSync(localBin).size / 1024 / 1024).toFixed(2);
  log('✅ 编译完成: ' + sizeMB + ' MB');

  // ---------- 步骤 2: scp 到服务器 ----------
  log('📤 步骤 2/5: 上传二进制到服务器...');
  const scp = spawnSync('scp', [
    '-i', CONFIG.sshKey,
    '-o', 'StrictHostKeyChecking=no',
    localBin,
    `${CONFIG.server}:${CONFIG.remote}/campus-wall-new`,
  ], { encoding: 'utf8' });
  if (scp.status !== 0) {
    err('scp 失败: ' + (scp.stderr || scp.stdout));
    process.exit(1);
  }
  log('✅ 上传完成');

  if (NO_RESTART) {
    log('⏭️ --no-restart 模式,只编译上传,不重启');
    log('手动执行重启: bash deploy_restart.sh');
    process.exit(0);
  }

  // ---------- 步骤 3: 停 PM2 + 杀旧进程 + 替换 ----------
  log('🔧 步骤 3/5: 暂停 PM2 守护进程 (PID ' + CONFIG.pm2Pid + ')...');
  ssh(`kill -STOP ${CONFIG.pm2Pid}`);
  await new Promise((r) => setTimeout(r, 500));

  log('💀 杀掉旧 Go 进程 (释放 3001 端口)...');
  ssh('pkill -9 -f campus-wall-go 2>/dev/null; sleep 1; true');
  await new Promise((r) => setTimeout(r, 800));

  log('🔄 替换二进制...');
  const cp = ssh(`cp ${CONFIG.remote}/campus-wall-new ${CONFIG.remote}/campus-wall-go && rm -f ${CONFIG.remote}/campus-wall-new && ls -la ${CONFIG.remote}/campus-wall-go`);
  if (!cp.ok) {
    err('替换失败: ' + cp.stderr + ' ' + cp.stdout);
    // 恢复 PM2 防止永久 disabled
    ssh(`kill -CONT ${CONFIG.pm2Pid}`);
    process.exit(1);
  }
  log('✅ 替换: ' + cp.stdout.split('\n').pop().trim());

  // ---------- 步骤 4: 恢复 PM2 (自动拉起新进程) ----------
  log('▶️ 步骤 4/5: 恢复 PM2 守护进程...');
  ssh(`kill -CONT ${CONFIG.pm2Pid}`);

  // ---------- 步骤 5: 验证 ----------
  log('🔍 步骤 5/5: 等待新进程启动并验证...');
  const ok = await waitFor(checkPing, 15000, 1000);
  if (ok) {
    log('✅ /ping 返回 200,服务正常运行');
  } else {
    err('⚠️ 15秒内 /ping 未返回 200,服务可能未起来');
    err('查看服务器日志: ssh 到服务器 tail -20 /tmp/wall.log');
    process.exit(1);
  }

  log('🎉 全部完成');
}

main().catch((e) => {
  err('未捕获错误: ' + e.message);
  console.error(e);
  // 紧急恢复 PM2
  ssh(`kill -CONT ${CONFIG.pm2Pid}`);
  process.exit(1);
});
