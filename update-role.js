const { pool } = require('./config/database');

async function updateRole() {
  try {
    // 把 admin 改成 super_admin
    await pool.execute("UPDATE users SET role = 'super_admin' WHERE username = 'admin'");
    console.log('✅ admin 已升级为 super_admin');
  } catch (e) {
    console.error('失败:', e.message);
  } finally {
    pool.end();
  }
}

updateRole();