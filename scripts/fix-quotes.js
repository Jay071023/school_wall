// 修复 routes/admin.js 和 routes/mp-draft.js 里单引号字符串中的 ${SITE_URL}
const fs = require('fs');
const path = require('path');

const files = ['routes/admin.js', 'routes/mp-draft.js', 'routes/messages.js'];

for (const file of files) {
  const p = path.join(__dirname, '..', file);
  let c = fs.readFileSync(p, 'utf8');
  const before = c;
  // 把 '...${SITE_URL}...' → '...' + SITE_URL + '...'
  c = c.replace(/'([^']*?)\$\{SITE_URL\}([^']*?)'/g, function(_, a, b) {
    return "'" + a + "' + SITE_URL + '" + b + "'";
  });
  if (c !== before) {
    fs.writeFileSync(p, c, 'utf8');
    console.log('✅ Fixed', file);
  } else {
    console.log('⏭  No changes:', file);
  }
}
