'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { synchronize, compareTrees, hashFile } = require('./lib/frontend-assets');
const { getProtectedFiles } = require('./sync-frontend');
const { buildStaticSite } = require('./build-static-site');

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-wall-assets-'));
const root = path.join(fixture, 'project');
const source = path.join(root, 'frontend');
const target = path.join(root, 'public');
function write(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }
function git(args) { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }); }
try {
  write(path.join(source, 'index.html'), '<html>example</html>');
  write(path.join(source, 'admin/index.html'), '<html>example admin</html>');
  write(path.join(source, 'css/site.css'), 'body { color: purple; }');
  write(path.join(source, 'images/example.png'), Buffer.from([0, 1, 2, 3]));
  write(path.join(source, 'uploads/local.txt'), 'example runtime upload');
  write(path.join(source, 'node_modules/local.js'), 'example dependency');
  write(path.join(target, 'uploads/local.txt'), 'example preserved upload');
  assert.equal(synchronize(source, target).copied, 4);
  assert.equal(synchronize(source, target).copied, 0);
  assert.deepEqual(compareTrees(source, target), { count: 4, problems: [] });
  assert.equal(fs.readFileSync(path.join(target, 'uploads/local.txt'), 'utf8'), 'example preserved upload');
  assert(!fs.existsSync(path.join(target, 'node_modules')));

  git(['init', '--quiet']);
  git(['add', 'frontend/index.html', 'frontend/admin/index.html', 'frontend/css/site.css', 'frontend/images/example.png',
    'public/index.html', 'public/admin/index.html', 'public/css/site.css', 'public/images/example.png']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=example@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
  write(path.join(target, 'css/site.css'), 'example independent edit');
  write(path.join(source, 'css/site.css'), 'example source edit');
  write(path.join(source, 'index.html'), '<html>example changed</html>');
  const protectedFiles = getProtectedFiles(root);
  assert(protectedFiles.has('css/site.css'));
  assert.throws(() => synchronize(source, target, { protectedFiles }), /独立未提交修改/);
  assert.equal(fs.readFileSync(path.join(target, 'index.html'), 'utf8'), '<html>example</html>', 'Conflicts must abort before any write');
  assert.equal(fs.readFileSync(path.join(target, 'css/site.css'), 'utf8'), 'example independent edit');
  git(['add', 'public/css/site.css']);
  assert.throws(() => synchronize(source, target, { protectedFiles: getProtectedFiles(root) }), /独立未提交修改/, 'Staged independent edits must also be protected');
  write(path.join(target, 'css/site.css'), 'example source edit');
  assert.equal(synchronize(source, target, { protectedFiles }).copied, 1);
  write(path.join(target, 'orphan.css'), 'example retained');
  assert(synchronize(source, target).problems.some(problem => problem.includes('orphan.css')));
  assert(fs.existsSync(path.join(target, 'orphan.css')), 'Unknown public files must not be deleted');
  fs.unlinkSync(path.join(target, 'orphan.css'));

  write(path.join(source, 'new.js'), 'example source');
  write(path.join(target, 'new.js'), 'example independent untracked');
  assert.throws(() => synchronize(source, target, { protectedFiles: getProtectedFiles(root) }), /独立未提交修改/);
  fs.unlinkSync(path.join(target, 'new.js'));
  // A deliberately deleted tracked public file is also protected.
  fs.unlinkSync(path.join(target, 'index.html'));
  assert.throws(() => synchronize(source, target, { protectedFiles: getProtectedFiles(root) }), /独立未提交修改/);
  write(path.join(target, 'index.html'), '<html>example changed</html>');
  synchronize(source, target);
  assert.throws(() => synchronize(source, source), /不能重叠/);
  assert.throws(() => synchronize(source, path.join(source, 'nested')), /不能重叠/);

  write(path.join(root, 'dist/stale.css'), 'example stale artifact');
  const manifest = buildStaticSite(root, 'example-revision');
  assert.equal(manifest.revision, 'example-revision');
  assert(!fs.existsSync(path.join(root, 'dist/stale.css')));
  assert(!fs.existsSync(path.join(root, 'dist/uploads')));
  for (const [file, hash] of Object.entries(manifest.files)) assert.equal(hashFile(path.join(root, 'dist', file)), hash);
  const firstManifest = fs.readFileSync(path.join(root, 'dist/asset-manifest.json'), 'utf8');
  buildStaticSite(root, 'example-revision');
  assert.equal(fs.readFileSync(path.join(root, 'dist/asset-manifest.json'), 'utf8'), firstManifest, 'Same source and revision must produce the same manifest');
  write(path.join(source, '.env.local'), 'example');
  assert.throws(() => buildStaticSite(root, 'example-revision'), /敏感文件/);
  assert.equal(fs.readFileSync(path.join(root, 'dist/asset-manifest.json'), 'utf8'), firstManifest);
  fs.unlinkSync(path.join(source, '.env.local'));

  const linked = path.join(fixture, 'linked-project');
  const outside = path.join(fixture, 'outside');
  write(path.join(linked, 'frontend/index.html'), 'example');
  write(path.join(linked, 'frontend/admin/index.html'), 'example');
  write(path.join(outside, 'keep.txt'), 'example retained');
  fs.symlinkSync(outside, path.join(linked, 'dist'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => buildStaticSite(linked, 'example-revision'), /拒绝清理/);
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'example retained');
  console.log('[frontend-assets] 通过：统一文件集合、幂等镜像、独立修改保护、上传隔离、可追踪构建与输出边界');
} finally {
  // Remove only the exact temporary fixture created above.
  if (path.dirname(fixture) !== os.tmpdir() || !path.basename(fixture).startsWith('campus-wall-assets-')) throw new Error('Unexpected fixture path');
  fs.rmSync(fixture, { recursive: true, force: true });
}
