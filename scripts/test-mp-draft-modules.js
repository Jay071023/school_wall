const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pairs = [
  ['frontend/admin/mp-draft.html', 'public/admin/mp-draft.html'],
  ['frontend/admin/js/mp-draft-utils.js', 'public/admin/js/mp-draft-utils.js'],
  ['frontend/admin/js/mp-draft-ui.js', 'public/admin/js/mp-draft-ui.js']
];

for (const [left, right] of pairs) {
  const leftText = fs.readFileSync(path.join(root, left), 'utf8');
  const rightText = fs.readFileSync(path.join(root, right), 'utf8');
  if (leftText !== rightText) {
    throw new Error(`mp-draft 镜像不一致: ${left} != ${right}`);
  }
}

const html = fs.readFileSync(path.join(root, 'frontend/admin/mp-draft.html'), 'utf8');
const utilsIndex = html.indexOf('<script src="/admin/js/mp-draft-utils.js"></script>');
const uiIndex = html.indexOf('<script src="/admin/js/mp-draft-ui.js"></script>');
const inlineIndex = html.indexOf('<script>', Math.max(utilsIndex, uiIndex));
if (utilsIndex < 0 || uiIndex < 0 || inlineIndex < 0 || utilsIndex > uiIndex || uiIndex > inlineIndex) {
  throw new Error('mp-draft 工具脚本必须在页面内联主脚本之前按顺序引入');
}

const inlineScript = html.slice(inlineIndex);
for (const name of [
  'setStatus', 'showMsg', 'showToast', 'escapeHtml', 'countVisibleText',
  'countText', 'getPreviewVideoUrl', 'getPreviewPosterUrl', 'buildPreviewVideoHtml', 'formatTime'
]) {
  const declaration = new RegExp(`function\\s+${name}\\s*\\(`);
  if (declaration.test(inlineScript)) {
    throw new Error(`工具函数仍重复声明在 mp-draft 内联脚本中: ${name}`);
  }
}

console.log('mp-draft 模块拆分静态检查通过');
