'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const checkerPath = path.relative(projectRoot, __filename).replace(/\\/g, '/');
const riskyName = /(^|\/)(\.env(?!\.example)(?:\.[^/]*)?|.*\.(?:pem|key|p12|pfx)|id_rsa(?:\.[^/]*)?)$/i;
const secretAssignment = /\b(?:api[_-]?key|access[_-]?token|deploy[_-]?secret|jwt[_-]?secret|password)\b\s*[:=]\s*(?!process\.env\b|\$\{|(?:['"]?)(?:your|change|replace|example|placeholder|xxx|这里|填写)\b)(?:[`'"][A-Za-z0-9_+/=-]{16,}[`'"]|[A-Za-z0-9_+/=-]{16,}(?=\s*(?:;|$)))/i;
const shellPasswordArgument = /\b(?:mysql|mysqldump)\b[^\r\n]*\s-p(?!\s*(?:["']?\$|["']?\{))["']?[A-Za-z0-9_+/=-]{4,}/i;
const urlCredential = /[?&](?:token|api[_-]?key|password)=[A-Za-z0-9_+/=-]{16,}/i;
const ipv4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

function isPrivateOrPlaceholderIp(value) {
  const parts = value.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => part < 0 || part > 255)) return true;
  return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    value === '255.255.255.255';
}

function getTrackedFiles() {
  const output = execFileSync('git', ['ls-files', '-z'], { cwd: projectRoot, encoding: 'utf8' });
  return output.split('\0').filter(Boolean);
}

const trackedFiles = getTrackedFiles().filter(file => file !== checkerPath);
const issues = [];
for (const file of trackedFiles) {
  if (riskyName.test(file)) {
    issues.push({ file, line: 1, kind: '敏感文件名' });
    continue;
  }

  const absolutePath = path.join(projectRoot, file);
  // 示例配置本来就允许出现占位符，不把它当作实际泄露。
  if (file.endsWith('.env.example')) continue;
  let content;
  try {
    content = fs.readFileSync(absolutePath, 'utf8');
  } catch (_) {
    continue;
  }
  if (content.includes('\u0000')) continue;

  const lines = content.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (secretAssignment.test(line)) {
      issues.push({ file, line: index + 1, kind: '疑似硬编码凭据' });
    }
    if (shellPasswordArgument.test(line) || urlCredential.test(line)) {
      issues.push({ file, line: index + 1, kind: '疑似命令行或 URL 凭据' });
    }
    const publicIps = /user-agent/i.test(line) ? [] : (line.match(ipv4) || []);
    if (publicIps.some(ip => !isPrivateOrPlaceholderIp(ip))) {
      issues.push({ file, line: index + 1, kind: '疑似公网地址' });
    }
  });
}

if (issues.length > 0) {
  console.error('[privacy] 检查未通过：发现以下文件/行，请移除或改用环境变量：');
  issues.forEach(issue => console.error(`- ${issue.file}:${issue.line} (${issue.kind})`));
  process.exitCode = 1;
} else {
  console.log(`[privacy] 通过：已检查 ${trackedFiles.length} 个已跟踪文件，未发现明显敏感文件或硬编码凭据`);
}
