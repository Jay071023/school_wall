// 把字符串里的 https://wall.jay23.cn 替换成 SITE_URL 占位
const fs = require('fs');
const path = require('path');

const files = [
  'services/wechat.js',
  'routes/wechat.js',
  'public/js/app.js',
  'public/js/auth.js',
  'public/js/edit-post.js',
  'public/js/home.js',
  'public/js/post.js',
  'public/js/profile.js',
  'public/js/detail-emojis.js',
  'public/js/detail-replies.js',
  'public/js/detail.js',
  'public/js/radio.js',
  'public/js/messages.js',
  'public/js/user-card.js',
  'public/js/side-cards.js',
  'public/js/novel.js',
  'views/index.html',
  'views/login.html',
  'views/register.html',
  'views/new-post.html',
  'views/profile.html',
  'views/post-detail.html',
  'views/radio.html',
  'views/feedback.html',
  'views/agreement.html',
  'views/privacy.html',
  'views/messages.html',
  'views/reset-password.html',
  'views/admin/index.html',
  'views/admin/mp-draft.html',
  'views/admin/email-settings.html'
];

let totalReplaced = 0;
for (const file of files) {
  const p = path.join(__dirname, '..', file);
  if (!fs.existsSync(p)) {
    console.log('⏭  跳过(不存在):', file);
    continue;
  }
  let c = fs.readFileSync(p, 'utf8');
  const before = c;

  // 在 JS 文件里：'...https://wall.jay23.cn...' → '...' + SITE_URL + '...'
  if (file.endsWith('.js')) {
    c = c.replace(/'([^']*?)https:\/\/wall\.jay23\.cn([^']*?)'/g, function(_, a, b) {
      return "'" + a + "' + SITE_URL + '" + b + "'";
    });
    c = c.replace(/"([^"]*?)https:\/\/wall\.jay23\.cn([^"]*?)"/g, function(_, a, b) {
      // 对反引号保留为 ${SITE_URL}
      return '`' + a + '${SITE_URL}' + b + '`';
    });
  } else if (file.endsWith('.html')) {
    // HTML 文件里直接显示 URL，不能用 + 号。改为 window.SITE_URL 或后端渲染注入
    // 简单做法：直接改成 / 开头相对路径
    c = c.replace(/https:\/\/wall\.jay23\.cn/g, '');
  }

  if (c !== before) {
    fs.writeFileSync(p, c, 'utf8');
    const diff = (c.match(/SITE_URL/g) || []).length - (before.match(/SITE_URL/g) || []).length;
    totalReplaced += diff;
    console.log('✅ ' + file + ' (+' + diff + ')');
  } else {
    console.log('   无变化: ' + file);
  }
}
console.log('\n总共新增 SITE_URL 引用: ' + totalReplaced);
