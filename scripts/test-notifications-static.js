'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const files = {
  database: fs.readFileSync(path.join(root, 'config/database.js'), 'utf8'),
  service: fs.readFileSync(path.join(root, 'services/notification.js'), 'utf8'),
  userRoutes: fs.readFileSync(path.join(root, 'routes/notifications.js'), 'utf8'),
  adminRoutes: fs.readFileSync(path.join(root, 'routes/admin.js'), 'utf8')
};

const createTableMatches = files.database.match(/CREATE TABLE IF NOT EXISTS notifications/gi) || [];
assert.strictEqual(createTableMatches.length, 1, '通知表建表 SQL 必须只定义一次');
assert(files.database.includes('async function ensureNotificationsTable(executor)'), '缺少共享通知初始化函数');
assert(files.database.includes('await ensureNotificationsTable(connection);'), 'initDB 未初始化通知表');
assert(files.database.includes("['idx_user_read', '(`user_id`, `is_read`)']"), '缺少未读查询索引');
assert(files.database.includes("['idx_notifications_user_created', '(`user_id`, `created_at`)']"), '缺少用户时间索引');
assert(files.database.includes("['idx_created', '(`created_at`)']"), '缺少创建时间索引');
assert(!files.database.includes('DELETE FROM notifications'), '数据库初始化不得删除通知数据');

assert(files.userRoutes.includes('ensureNotificationsTable(pool)'), '普通通知旧初始化接口未复用共享初始化函数');
assert(files.adminRoutes.includes('ensureNotificationsTable(pool)'), '后台通知旧初始化接口未复用共享初始化函数');
assert(!/CREATE TABLE IF NOT EXISTS notifications/i.test(files.userRoutes), '普通通知路由不应重复定义建表 SQL');
assert(!/CREATE TABLE IF NOT EXISTS notifications/i.test(files.adminRoutes), '后台路由不应重复定义建表 SQL');

assert(/ORDER BY created_at DESC, id DESC/.test(files.userRoutes), '普通通知列表缺少 id DESC 稳定排序');
assert(/ORDER BY n\.created_at DESC, n\.id DESC/.test(files.adminRoutes), '后台通知列表缺少 id DESC 稳定排序');

for (const [name, source] of Object.entries(files)) {
  assert(!/console\.(?:error|warn)\([^\n;]*(?:,\s*err(?![.\w])|:\s*err(?![.\w]))\s*\)?\s*;/.test(source), `${name} 不得输出完整错误对象`);
}
assert(/err\s*&&\s*\(err\.code\s*\|\|\s*err\.message\)/.test(files.service), '通知服务日志应保留 code 或 message');

console.log('[notifications-static] 通过：启动初始化、旧接口复用、索引、稳定排序、数据保护和安全错误日志检查');
