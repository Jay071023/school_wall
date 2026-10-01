'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function collectFiles(rootDir) {
  const files = new Set();
  const rootStat = fs.lstatSync(rootDir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('静态根目录必须是实际目录');
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(rootDir, absolute).split(path.sep).join('/');
      if (relative.split('/').some(segment => ['uploads', 'node_modules', 'dist'].includes(segment))) continue;
      if (entry.isSymbolicLink()) throw new Error('静态资源不能包含链接: ' + relative);
      if (/(^|\/)(\.env(?!\.example)(?:\..*)?|.*\.(?:pem|key|p12|pfx)|id_rsa(?:\..*)?)$/i.test(relative)) {
        throw new Error('静态资源包含敏感文件: ' + relative);
      }
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.add(relative);
    }
  }
  visit(rootDir);
  return files;
}

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function compareTrees(sourceDir, targetDir) {
  const sourceFiles = collectFiles(sourceDir);
  const targetFiles = collectFiles(targetDir);
  const allFiles = new Set([...sourceFiles, ...targetFiles]);
  const problems = [];
  for (const relative of [...allFiles].sort()) {
    if (!sourceFiles.has(relative)) problems.push('仅 public 存在: ' + relative);
    else if (!targetFiles.has(relative)) problems.push('仅 frontend 存在: ' + relative);
    else if (hashFile(path.join(sourceDir, relative)) !== hashFile(path.join(targetDir, relative))) problems.push('内容不一致: ' + relative);
  }
  return { count: allFiles.size, problems };
}

function synchronize(sourceDir, targetDir, { protectedFiles = new Set() } = {}) {
  const source = path.resolve(sourceDir);
  const target = path.resolve(targetDir);
  const relative = path.relative(source, target);
  const reverse = path.relative(target, source);
  if (!relative || (!relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) ||
      (!reverse.startsWith('..' + path.sep) && !path.isAbsolute(reverse))) throw new Error('源码和输出目录不能重叠');
  const files = collectFiles(source);
  if (fs.existsSync(target)) collectFiles(target);
  const changed = [...files].filter(relative => {
    const destination = path.join(target, relative);
    return !fs.existsSync(destination) || hashFile(path.join(source, relative)) !== hashFile(destination);
  });
  const conflicts = changed.filter(relative => protectedFiles.has(relative));
  if (conflicts.length) throw new Error('public 有独立未提交修改，请先审阅: ' + conflicts.join(', '));
  fs.mkdirSync(target, { recursive: true });
  for (const relative of changed) {
    const destination = path.join(target, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(source, relative), destination);
  }
  return { copied: changed.length, ...compareTrees(source, target) };
}

module.exports = { collectFiles, hashFile, compareTrees, synchronize };
