'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'frontend');
const output = path.join(root, 'dist');

if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
  throw new Error('frontend 静态站点目录不存在');
}
if (path.dirname(output) !== root || path.basename(output) !== 'dist') {
  throw new Error('拒绝清理非项目 dist 目录');
}

fs.rmSync(output, { recursive: true, force: true });
fs.cpSync(source, output, { recursive: true, force: true });

let fileCount = 0;
function countFiles(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) countFiles(target);
    else if (entry.isFile()) fileCount += 1;
  }
}
countFiles(output);

if (!fs.existsSync(path.join(output, 'index.html')) || !fs.existsSync(path.join(output, 'admin', 'index.html'))) {
  throw new Error('静态构建缺少首页或管理后台入口');
}

console.log(`[build] 已生成完整静态站点：dist/（${fileCount} 个文件）`);
