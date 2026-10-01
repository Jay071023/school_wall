'use strict';
const path = require('path');
const { compareTrees } = require('./lib/frontend-assets');

try {
  const root = path.resolve(__dirname, '..');
  const result = compareTrees(path.join(root, 'frontend'), path.join(root, 'public'));
  if (result.problems.length) throw new Error('检查失败，共 ' + result.problems.length + ' 项:\n- ' + result.problems.join('\n- '));
  console.log('[mirror] frontend/ 与 public/ 一致，共检查 ' + result.count + ' 个文件');
} catch (error) { console.error('[mirror]', error.message); process.exitCode = 1; }
