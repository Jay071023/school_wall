/**
 * 微信 Access Token 统一缓存
 * 被 wechat.js 和 mp-draft.js 共用，避免重复调用
 */

const https = require('https');

let cachedToken = null;
let expireAt = 0;  // 过期时间戳（提前 3 分钟过期防临界）

function getWechatConfig() {
  const appId = process.env.WECHAT_APPID || 'wx513226ad98127a0d';
  const secret = process.env.WECHAT_SECRET;
  if (!secret) throw new Error('缺少环境变量 WECHAT_SECRET');
  return { appId, secret };
}

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < expireAt) {
    return cachedToken;
  }

  const { appId, secret } = getWechatConfig();

  return new Promise((resolve, reject) => {
    const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${appId}&secret=${secret}`;
    const req = https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.access_token) {
            cachedToken = json.access_token;
            expireAt = Date.now() + ((json.expires_in || 7200) - 180) * 1000;
            resolve(json.access_token);
          } else {
            reject(new Error('获取access_token失败: ' + data.substring(0, 200)));
          }
        } catch (e) { reject(e); }
      });
    });
    req.setTimeout(15000, () => {
      try { req.destroy(); } catch(e) {}
      reject(new Error('access_token请求超时(15s)'));
    });
    req.on('error', reject);
  });
}

module.exports = { getAccessToken };