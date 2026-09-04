const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

const router = express.Router();

function safeTokenEqual(received, expected) {
  if (typeof received !== 'string' || typeof expected !== 'string' || !received || !expected) return false;
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return receivedBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}

const deployScript = path.resolve(__dirname, '..', 'deploy.sh');
const deployUnit = process.env.DEPLOY_SYSTEMD_UNIT || 'wall-deploy.service';
const deployUnitPath = process.env.DEPLOY_SYSTEMD_UNIT_PATH || `/etc/systemd/system/${deployUnit}`;
const deployStatusFile = path.resolve(
  process.env.DEPLOY_STATUS_FILE || path.join(path.dirname(deployScript), 'logs', 'deploy-status.json')
);

function canUseSystemdDeployUnit() {
  return process.platform === 'linux'
    && process.env.DEPLOY_DISABLE_SYSTEMD_LAUNCHER !== '1'
    && fs.existsSync(deployUnitPath);
}

function isAuthorized(req) {
  const secret = process.env.DEPLOY_SECRET;
  const token = req.headers['x-gitee-token'];
  return Boolean(secret) && safeTokenEqual(token, secret);
}

function rejectUnauthorized(req, res) {
  if (!process.env.DEPLOY_SECRET) {
    res.status(500).json({ code: 500, message: '部署服务未配置' });
    return true;
  }
  if (!isAuthorized(req)) {
    res.status(403).json({ code: 403, message: '无效的部署凭证' });
    return true;
  }
  return false;
}

// Gitee Webhook：只负责鉴权和启动部署，不把部署过程阻塞在请求生命周期内。
router.post('/deploy-webhook', (req, res) => {
  if (rejectUnauthorized(req, res)) return;

  const deployBranch = process.env.DEPLOY_BRANCH || 'main';
  const ref = req.body && typeof req.body.ref === 'string' ? req.body.ref : '';
  if (ref && ref !== `refs/heads/${deployBranch}`) {
    return res.status(202).json({ code: 202, message: '非发布分支，已跳过部署' });
  }

  try {
    fs.accessSync(deployScript, fs.constants.R_OK);
  } catch (err) {
    console.error('[deploy] launch failed: deploy.sh is not readable');
    return res.status(500).json({ code: 500, message: '部署脚本不可用' });
  }

  let child;
  try {
    if (canUseSystemdDeployUnit()) {
      const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
      const command = isRoot ? 'systemctl' : (process.env.DEPLOY_SUDO || 'sudo');
      const args = isRoot
        ? ['start', deployUnit]
        : ['-n', 'systemctl', 'start', deployUnit];
      child = spawn(command, args, {
        detached: true,
        stdio: 'ignore',
        shell: false
      });
    } else {
      child = spawn(process.env.DEPLOY_BASH || 'bash', [deployScript], {
        detached: true,
        stdio: 'ignore',
        shell: false
      });
    }
  } catch (err) {
    console.error('[deploy] launch failed:', err.code || 'spawn_error');
    return res.status(500).json({ code: 500, message: '部署启动失败' });
  }

  child.once('error', (err) => {
    // deploy.sh 自己负责完整输出；这里只记录启动失败的非敏感错误码。
    console.error('[deploy] launch failed:', err.code || 'spawn_error');
  });
  child.unref();

  res.status(202).json({ code: 202, message: '部署已启动' });
});

// 只返回不含凭据的部署状态，方便确认 202 之后究竟是否已经上线。
router.get('/deploy-status', (req, res) => {
  if (rejectUnauthorized(req, res)) return;

  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');

  try {
    const status = JSON.parse(fs.readFileSync(deployStatusFile, 'utf8'));
    return res.json({ code: 200, status });
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return res.status(503).json({ code: 503, message: '尚无部署记录', status: { state: 'unknown' } });
    }
    console.error('[deploy] status read failed:', err && (err.code || err.message || 'unknown error'));
    return res.status(500).json({ code: 500, message: '部署状态不可用' });
  }
});

module.exports = router;
