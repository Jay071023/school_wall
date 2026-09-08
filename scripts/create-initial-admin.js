'use strict';

const path = require('path');
const bcrypt = require('bcryptjs');
const dotenv = require('dotenv');

const rootDir = path.join(__dirname, '..');
dotenv.config({ path: path.join(rootDir, '.env') });
dotenv.config({ path: path.join(rootDir, '.env.local'), override: true });

const { pool, initDB } = require('../config/database');

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`缺少 ${name}，请先在 .env 中填写后再执行此命令`);
  return value;
}

async function main() {
  const username = required('INITIAL_ADMIN_USERNAME');
  const password = required('INITIAL_ADMIN_PASSWORD');
  const nickname = String(process.env.INITIAL_ADMIN_NICKNAME || '站点管理员').trim() || '站点管理员';

  if (!/^[A-Za-z0-9_-]{3,50}$/.test(username)) {
    throw new Error('INITIAL_ADMIN_USERNAME 只能使用 3-50 位字母、数字、下划线或连字符');
  }
  if (password.length < 12) {
    throw new Error('INITIAL_ADMIN_PASSWORD 至少需要 12 位');
  }

  await initDB();

  const [existing] = await pool.execute('SELECT id FROM users WHERE username = ?', [username]);
  if (existing.length > 0) {
    throw new Error(`用户 ${username} 已存在；为保护现有账号，本命令不会修改其角色或密码`);
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await pool.execute(
    'INSERT INTO users (username, password, nickname, role, status) VALUES (?, ?, ?, ?, 1)',
    [username, passwordHash, nickname, 'super_admin']
  );

  console.log(`已创建超级管理员 ${username}。请妥善保管密码，并在首次登录后检查后台设置。`);
}

main()
  .catch((err) => {
    console.error(`创建初始管理员失败：${err.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
