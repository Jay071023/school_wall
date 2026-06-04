// 修复 services/ai.js：把单引号里的 ${} 模板字符串改成字符串拼接
const fs = require('fs');
const path = require('path');

const p = path.join(__dirname, '..', 'services', 'ai.js');
let c = fs.readFileSync(p, 'utf8');
const before = c;

// '...https://${process.env.X || 'def'}...'  → '...https://' + (process.env.X || 'def') + '...'
c = c.replace(/'([^']*?)https:\/\/\$\{([^}]+)\}([^']*?)'/g, function(match, before, expr, after) {
  return "'" + before + "https://' + (" + expr + ") + '" + after + "'";
});

if (c !== before) {
  fs.writeFileSync(p, c, 'utf8');
  console.log('✅ Fixed');
  console.log('差异: ' + (c.length - before.length) + ' 字符');
} else {
  console.log('⏭  No changes');
}
