const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const projectRoot = path.resolve(__dirname, '..');
const sourceDir = path.join(projectRoot, 'frontend');
const runtimeDir = path.join(projectRoot, 'public');
const ignoredPrefixes = ['uploads/'];

function normalizeRelative(filePath) {
  return filePath.split(path.sep).join('/');
}

function shouldIgnore(relativePath) {
  return ignoredPrefixes.some(prefix => relativePath === prefix.slice(0, -1) || relativePath.startsWith(prefix));
}

function collectFiles(rootDir, currentDir = rootDir, result = new Set()) {
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    const absolutePath = path.join(currentDir, entry.name);
    const relativePath = normalizeRelative(path.relative(rootDir, absolutePath));
    if (shouldIgnore(relativePath)) continue;
    if (entry.isDirectory()) {
      collectFiles(rootDir, absolutePath, result);
    } else if (entry.isFile()) {
      result.add(relativePath);
    }
  }
  return result;
}

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

if (!fs.existsSync(sourceDir) || !fs.existsSync(runtimeDir)) {
  console.error('[mirror] frontend/ 或 public/ 不存在');
  process.exit(1);
}

const allFiles = new Set([
  ...collectFiles(sourceDir),
  ...collectFiles(runtimeDir)
]);
const problems = [];

for (const relativePath of [...allFiles].sort()) {
  const sourcePath = path.join(sourceDir, relativePath);
  const runtimePath = path.join(runtimeDir, relativePath);
  if (!fs.existsSync(sourcePath)) {
    problems.push(`仅 public 存在: ${relativePath}`);
    continue;
  }
  if (!fs.existsSync(runtimePath)) {
    problems.push(`仅 frontend 存在: ${relativePath}`);
    continue;
  }
  if (hashFile(sourcePath) !== hashFile(runtimePath)) {
    problems.push(`内容不一致: ${relativePath}`);
  }
}

if (problems.length > 0) {
  console.error(`[mirror] 检查失败，共 ${problems.length} 项：`);
  problems.forEach(problem => console.error(`- ${problem}`));
  process.exit(1);
}

console.log(`[mirror] frontend/ 与 public/ 一致，共检查 ${allFiles.size} 个文件`);
