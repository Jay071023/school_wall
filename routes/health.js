const express = require('express');
const { pool } = require('../config/database');

const router = express.Router();
const HEALTHCHECK_TIMEOUT_MS = Math.max(Number.parseInt(process.env.HEALTHCHECK_TIMEOUT_MS, 10) || 3000, 500);

function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('health check timeout')), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// 部署和监控使用的轻量健康检查：不返回配置、用户或数据库敏感信息。
router.get(['/health', '/healthz'], async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    await withTimeout(pool.execute('SELECT 1 AS ok'), HEALTHCHECK_TIMEOUT_MS);
    res.json({ code: 200, status: 'ok' });
  } catch (err) {
    console.error('[Health] 数据库检查失败:', err.message);
    res.status(503).json({ code: 503, status: 'unavailable' });
  }
});

module.exports = router;
