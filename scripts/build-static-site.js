'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { collectFiles, hashFile, synchronize } = require('./lib/frontend-assets');

function buildStaticSite(projectRoot, revision) {
  const root = fs.realpathSync(projectRoot);
  const source = path.join(root, 'frontend');
  const output = path.join(root, 'dist');
  const files = collectFiles(source);
  if (!files.has('index.html') || !files.has('admin/index.html')) throw new Error('静态源码缺少首页或管理后台入口');
  if (files.has('asset-manifest.json')) throw new Error('asset-manifest.json 是构建保留文件');
  // Verify the resolved generated output before any recursive removal.
  if (path.dirname(output) !== root || path.basename(output) !== 'dist') throw new Error('拒绝清理非项目 dist 目录');
  if (fs.existsSync(output) && (fs.lstatSync(output).isSymbolicLink() || fs.realpathSync(output) !== output)) throw new Error('拒绝清理链接或越界输出目录');
  fs.rmSync(output, { recursive: true, force: true });
  synchronize(source, output);
  const manifest = { revision, files: {} };
  for (const file of [...files].sort()) manifest.files[file] = hashFile(path.join(output, file));
  fs.writeFileSync(path.join(output, 'asset-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

if (require.main === module) {
  try {
    const root = path.resolve(__dirname, '..');
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const manifest = buildStaticSite(root, revision);
    console.log('[build] 已生成完整静态站点：dist/（' + Object.keys(manifest.files).length + ' 个文件），含提交及 SHA-256 清单');
  } catch (error) { console.error('[build]', error.message); process.exitCode = 1; }
}

module.exports = { buildStaticSite };
