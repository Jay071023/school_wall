'use strict';

const path = require('path');
const { execFileSync } = require('child_process');
const { synchronize } = require('./lib/frontend-assets');

function getProtectedFiles(root) {
  const modified = execFileSync('git', ['diff', '--name-only', '-z', 'HEAD', '--', 'public'], { cwd: root, encoding: 'utf8' });
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z', '--', 'public'], { cwd: root, encoding: 'utf8' });
  return new Set((modified + untracked).split('\0').filter(file => file.startsWith('public/')).map(file => file.slice(7)));
}

if (require.main === module) {
  try {
    const root = path.resolve(__dirname, '..');
    const result = synchronize(path.join(root, 'frontend'), path.join(root, 'public'), { protectedFiles: getProtectedFiles(root) });
    console.log(`[sync] 已更新 ${result.copied} 个镜像文件，共 ${result.count} 个静态文件`);
    if (result.problems.length) throw new Error('镜像仍有差异；仅 public 存在的文件保留，请审阅后处理: ' + result.problems.join('; '));
  } catch (error) { console.error('[sync]', error.message); process.exitCode = 1; }
}

module.exports = { getProtectedFiles };
