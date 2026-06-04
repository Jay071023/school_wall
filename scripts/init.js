#!/usr/bin/env node
/**
 * 首次启动初始化助手
 * - 检查 .env 是否存在
 * - 检查 Node/MySQL 版本
 * - 提示填关键配置
 *
 * 使用：node scripts/init.js
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.join(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function ask(question, defaultVal) {
  return new Promise(resolve => {
    rl.question(question + (defaultVal ? ` [${defaultVal}]` : '') + ': ', answer => {
      resolve(answer.trim() || defaultVal || '');
    });
  });
}

async function main() {
  console.log('🎉 欢迎使用校园墙部署助手\n');

  // 1. 检查 Node 版本
  const nodeVer = process.versions.node;
  const major = parseInt(nodeVer.split('.')[0]);
  if (major < 14) {
    console.error('❌ Node 版本过低: ' + nodeVer + '，需要 >= 14');
    process.exit(1);
  }
  console.log('✅ Node 版本: ' + nodeVer);

  // 2. 检查 .env
  if (fs.existsSync(ENV_FILE)) {
    console.log('✅ .env 已存在，跳过创建');
  } else {
    console.log('📝 .env 不存在，开始创建...\n');
    const schoolName = await ask('🏫 学校名称（显示在站点）', '你的学校');
    const siteName = await ask('📛 站点名称（顶部品牌）', '校园墙');
    const domain = await ask('🌐 域名（不含 https://）', 'your-domain.com');
    const dbHost = await ask('🗄️  数据库地址', '127.0.0.1');
    const dbUser = await ask('🗄️  数据库用户名', 'root');
    const dbPass = await ask('🔑 数据库密码', '');
    const dbName = await ask('🗄️  数据库名', 'campus_wall');
    const adminUser = await ask('👤 管理员账号', 'admin');
    const adminPass = await ask('🔐 管理员密码（首次登录后请修改）', 'admin123456');

    // 生成随机 JWT secret
    const jwtSecret = require('crypto').randomBytes(32).toString('hex');

    const envContent = `# 由 init.js 自动生成 - $(date)

PORT=3000
HOST=0.0.0.0

DB_HOST=${dbHost}
DB_PORT=3306
DB_USER=${dbUser}
DB_PASSWORD=${dbPass}
DB_NAME=${dbName}

JWT_SECRET=${jwtSecret}

SCHOOL_NAME=${schoolName}
SITE_NAME=${siteName}
SITE_DOMAIN=${domain}
CONTACT_EMAIL=admin@${domain}

ADMIN_USERNAME=${adminUser}
ADMIN_PASSWORD=${adminPass}

ALLOWED_ORIGINS=https://${domain}
`;

    fs.writeFileSync(ENV_FILE, envContent, 'utf8');
    console.log('\n✅ .env 已创建');
  }

  // 3. 提示
  console.log('\n📋 下一步：');
  console.log('   1) 确保 MySQL 已启动且上面的 DB_USER/DB_PASSWORD 能登录');
  console.log('   2) npm install');
  console.log('   3) node server.js （首次启动会自动建表）');
  console.log('   4) 浏览器打开 http://localhost:3000 试试\n');

  // 4. 提示可选
  console.log('💡 高级配置（可选，编辑 .env 启用）：');
  console.log('   - WECHAT_APPID/SECRET  公众号登录');
  console.log('   - MINIMAX_API_KEY/DEEPSEEK_API_KEY  AI 介绍词生成');
  console.log('   - SMTP_*  邮件通知/找回密码');
  console.log('');

  rl.close();
}

main().catch(e => {
  console.error(e);
  rl.close();
  process.exit(1);
});
