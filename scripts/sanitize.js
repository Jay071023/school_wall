#!/usr/bin/env node
/**
 * 脱敏脚本：把开发时的具体信息替换为通用占位符
 * 用于把代码转成可公开的"校园墙模板"
 *
 * 使用：node scripts/sanitize.js
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.join(__dirname, '..');

// 替换规则
const REPLACEMENTS = [
  // 域名 → 读环境变量
  { from: /wall\.jay23\.cn/g, to: 'YOUR_DOMAIN', note: '你的域名（如 wall.example.com）' },
  { from: /jay23\.cn/g, to: 'example.com', note: '你的域名' },
  // 服务器IP
  { from: /152\.32\.226\.134/g, to: 'YOUR_SERVER_IP', note: '你的服务器IP' },
  // 学校名
  { from: /嘉定区第二中学/g, to: '你的学校', note: '你的学校全称' },
  { from: /嘉定二中/g, to: '你的学校', note: '你的学校简称' },
  { from: /嘉二/g, to: '你的学校', note: '你的学校简称' },
  { from: /嘉定的墙/g, to: '校园墙', note: '站点名' },
  // 站点信息
  { from: /嘉二の墙墙/g, to: '校园墙', note: '站点名' },
  { from: /嘉二/g, to: '校园墙', note: '站点名' }
];

// 排除的目录和文件
const EXCLUDE_DIRS = ['node_modules', '.git', 'public/admin-vue', 'data', 'uploads', 'public/uploads', '.claude'];
const EXCLUDE_FILES = ['package-lock.json', 'sanitize.js', '.env', '.env.local', 'ssh_key', 'ssh_key_new', 'LICENSE'];

function shouldProcess(file) {
  const basename = path.basename(file);
  if (EXCLUDE_FILES.includes(basename)) return false;
  const ext = path.extname(file);
  return ['.js', '.html', '.json', '.md', '.txt'].includes(ext);
}

function walkDir(dir, files = []) {
  const items = fs.readdirSync(dir);
  for (const item of items) {
    if (EXCLUDE_DIRS.includes(item)) continue;
    const full = path.join(dir, item);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      walkDir(full, files);
    } else if (shouldProcess(full)) {
      files.push(full);
    }
  }
  return files;
}

function main() {
  console.log('🔍 扫描项目中...\n');
  const files = walkDir(ROOT);
  console.log(`找到 ${files.length} 个待处理文件\n`);

  const results = { changed: [], skipped: [] };
  for (const file of files) {
    let content = fs.readFileSync(file, 'utf8');
    let original = content;
    let changes = [];

    for (const rule of REPLACEMENTS) {
      const matches = content.match(rule.from);
      if (matches) {
        content = content.replace(rule.from, rule.to);
        changes.push(`  ${rule.from} → ${rule.to} (${matches.length} 处)`);
      }
    }

    if (content !== original) {
      fs.writeFileSync(file, content, 'utf8');
      results.changed.push({ file, changes });
    } else {
      results.skipped.push(file);
    }
  }

  console.log(`✅ 处理完成！\n`);
  console.log(`📝 改动文件: ${results.changed.length}`);
  for (const item of results.changed) {
    const rel = path.relative(ROOT, item.file);
    console.log(`\n  ${rel}`);
    item.changes.forEach(c => console.log(c));
  }
  console.log(`\n⏭  未改动: ${results.skipped.length}`);
  console.log('\n⚠️  请手动检查以下事项：');
  console.log('  1. .env 文件未在扫描范围（已排除），记得改成新环境的配置');
  console.log('  2. 检查 README.md 里的部署说明是否需要更新');
  console.log('  3. 检查 routes/admin.js 等代码里写死的"嘉定二中"是否都已替换');
  console.log('  4. 建议删除上传的真实数据（帖子/歌曲/评论）再发布');
}

main();
