const https = require('https');
const http = require('http');

const BAIDU_SITE_URL = process.env.BAIDU_SITE_URL || 'http://localhost:3000';
const BAIDU_PUSH_TOKEN = process.env.BAIDU_PUSH_TOKEN || '';
const BAIDU_PUSH_API = process.env.BAIDU_PUSH_API || 'http://data.zz.baidu.com/urls';

function getBaiduApiUrl() {
  const url = new URL(BAIDU_PUSH_API);
  url.searchParams.set('site', BAIDU_SITE_URL);
  url.searchParams.set('token', BAIDU_PUSH_TOKEN);
  return url;
}

function pushToBaidu(urls) {
  if (!urls || urls.length === 0) return;
  if (!BAIDU_PUSH_TOKEN) {
    console.warn('[baidu-push] 未配置 BAIDU_PUSH_TOKEN，跳过推送');
    return;
  }
  const body = urls.join('\n');
  const apiUrl = getBaiduApiUrl();
  const client = apiUrl.protocol === 'https:' ? https : http;
  const req = client.request(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' }
  }, res => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try {
        const result = JSON.parse(data);
        console.log(`[baidu-push] ${result.success?.success || 0} success, ${result.error?.message || ''}`);
      } catch (e) {}
    });
  });
  req.on('error', err => console.error('[baidu-push] 推送失败:', err.message));
  req.write(body);
  req.end();
}

function pushPost(postId) {
  pushToBaidu([`${BAIDU_SITE_URL}/post-detail.html?id=${postId}`]);
}

module.exports = { pushToBaidu, pushPost };
