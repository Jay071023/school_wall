'use strict';
const express = require('express');
const path = require('path');

function registerStaticPages(app, { staticRoot = path.resolve(__dirname, '..', 'public') } = {}) {
  // 页面链接统一使用无扩展名 URL；直接运行 Node 时也要和生产反向代理保持一致。
  const pageAliases = {
    '/radio': 'radio.html',
    '/profile': 'profile.html',
    '/login': 'login.html',
    '/register': 'register.html',
    '/new-post': 'new-post.html',
    '/edit-post': 'edit-post.html',
    '/edit-profile': 'edit-profile.html',
    '/feedback': 'feedback.html',
    '/agreement': 'agreement.html',
    '/privacy': 'privacy.html',
    '/messages': 'messages.html',
    '/admin/mp-draft': 'admin/mp-draft.html'
  };

  function setHtmlRevalidationHeaders(res) {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.setHeader('Surrogate-Control', 'no-cache');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }

  function sendHtmlPage(res, relativePath) {
    setHtmlRevalidationHeaders(res);
    return res.sendFile(path.join(staticRoot, relativePath));
  }

  Object.keys(pageAliases).forEach((route) => {
    app.get(route, (req, res) => sendHtmlPage(res, pageAliases[route]));
  });
  app.get('/post/:id', (req, res) => sendHtmlPage(res, 'post-detail.html'));

  app.use(express.static(staticRoot, {
    setHeaders: (res, filePath) => {
      // HTML 必须每次向 CDN/浏览器重新校验，确保部署后的页面引用不会长期过期。
      if (/\.html$/i.test(filePath)) {
        setHtmlRevalidationHeaders(res);
      }

      // 管理后台更看重发布后的即时一致性。管理脚本/样式每次刷新都向服务器
      // 重新校验，避免后台继续执行 stale-while-revalidate 中的旧业务逻辑。
      if (/\.(css|js)$/i.test(filePath) && /[\\/]admin[\\/]/i.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
        res.setHeader('Surrogate-Control', 'no-cache');
        res.setHeader('Pragma', 'no-cache');
      // 公开页面未做文件名指纹的 CSS/JS 使用短缓存 + 后台刷新，兼顾首屏速度。
      } else if (/\.(css|js)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=86400');
        res.setHeader('Surrogate-Control', 'public, max-age=300, stale-while-revalidate=86400');
      }

      // 头像和图片目前使用受控路径；保留 7 天缓存，减少重复下载。
      if (/\.(jpg|jpeg|png|gif|webp|svg|ico)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=604800');
      }

      // 视频上传使用随机文件名，内容不会被原地覆盖，可以安全长期缓存。
      if (/\.(mp4|webm|ogv)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
        res.setHeader('Accept-Ranges', 'bytes');
      }
    }
  }));
}

module.exports = { registerStaticPages };
