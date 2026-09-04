'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const pageNames = [
  '404.html', 'edit-post.html', 'edit-profile.html', 'feedback.html', 'index.html',
  'login.html', 'new-post.html', 'post-detail.html', 'profile.html', 'radio.html', 'register.html'
];

pageNames.forEach((pageName) => {
  const page = read(`frontend/${pageName}`);
  const siteInfoFetches = page.match(/fetch\(\s*['"]\/api\/site-info['"]/g) || [];
  assert.strictEqual(siteInfoFetches.length, 1, `${pageName} 应只有一个站点配置请求入口`);
  assert(page.includes('var siteInfoRequest = window.CampusWallSiteInfoPromise;'), `${pageName} 应优先复用共享站点配置 Promise`);
  assert(page.includes('window.CampusWallSiteInfoPromise = siteInfoRequest;'), `${pageName} 未命中共享请求时应登记 Promise`);
});

const themeMode = read('frontend/js/theme-mode.js');
assert(themeMode.includes("typeof json.json === 'function'"), '主题脚本应兼容旧页面暴露的 Response');
assert(themeMode.includes('return response.ok ? response.json() : null;'), '主题脚本应把站点配置响应解析为可共享的数据 Promise');
assert.strictEqual(read('frontend/js/theme-mode.js'), read('public/js/theme-mode.js'), '主题脚本镜像必须一致');

console.log('[site-info-sharing] 通过：页面共享单一站点配置请求，主题脚本避免重复消费 Response');
