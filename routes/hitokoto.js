// P0-13: 一言 API 代理 - 减少跨域/CSP 复杂度,避免被广告注入
const express = require('express');
const router = express.Router();
const https = require('https');

const HITOKOTO_HOST = 'v1.hitokoto.cn';
const CACHE_TTL = 60 * 1000; // 60 秒
let cache = { ts: 0, data: null };

function fetchRemote() {
  return new Promise(function(resolve, reject) {
    const req = https.get({
      host: HITOKOTO_HOST,
      path: '/?c=a&c=b&c=d&c=i&c=k&charset=utf-8',
      headers: { 'User-Agent': 'school-wall/1.0' },
      timeout: 4000
    }, function(res) {
      let body = '';
      res.on('data', function(chunk) { body += chunk; });
      res.on('end', function() {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', function() { req.destroy(new Error('hitokoto timeout')); });
  });
}

router.get('/', async function(req, res) {
  try {
    const now = Date.now();
    if (cache.data && (now - cache.ts) < CACHE_TTL) {
      return res.json({ code: 200, data: cache.data, cached: true });
    }
    const data = await fetchRemote();
    cache = { ts: now, data: data };
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ code: 200, data: data });
  } catch (err) {
    // 失败时返回降级数据
    const fallback = { id: 0, hitokoto: '生活明朗,万物可爱', type: 'd', from: '降级文案', from_who: '', creator: 'system' };
    res.json({ code: 200, data: fallback, fallback: true });
  }
});

module.exports = router;
