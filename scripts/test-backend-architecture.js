'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const admin = read('routes/admin.js');
const posts = read('routes/posts.js');
const follows = read('routes/follows.js');
const feedback = read('routes/feedback.js');
const database = read('config/database.js');
const email = read('services/email.js');
const health = read('routes/health.js');
const gamification = read('services/gamification.js');

assert(admin.includes("require('../services/song-scheduling')"), '后台点歌排期规则必须由独立服务维护');
assert(!admin.includes('async function approveSongWithSchedule') && !admin.includes('async function rescheduleApprovedSong'), '后台路由不得继续内联排期事务规则');
assert(admin.includes("require('../config/jwt-secret')"), '后台代登录必须复用全站 JWT 密钥配置');
assert(!admin.includes('randomBytes(32)'), '后台不得在缺少配置时生成临时 JWT 密钥');

assert(!/CREATE TABLE|ALTER TABLE/.test(follows), '关注路由加载和请求期间不得执行 DDL');
assert(!/ALTER TABLE comments ADD COLUMN mentioned_users/.test(posts), '帖子路由加载期间不得执行评论字段迁移');
assert(!/CREATE TABLE IF NOT EXISTS feedbacks/.test(feedback), '反馈路由不得维护重复的建表 SQL');
assert(database.includes('await ensureFollowsTable(connection)') && database.includes('await ensureFeedbackTable(connection)'), '业务表必须由启动初始化统一确保');
assert(database.includes('SHOW COLUMNS FROM comments LIKE "mentioned_users"'), '评论提及字段升级必须在启动迁移中显式检查');

assert(admin.includes("require('../services/async-utils')"), '后台应复用异步工具');
assert(email.includes("require('./async-utils')"), '邮件超时应复用异步工具');
assert(health.includes("require('../services/async-utils')"), '健康检查超时应复用异步工具');
assert(!email.includes('function withTimeout(') && !health.includes('function withTimeout('), '超时实现不得在业务模块重复维护');

assert(gamification.includes('async function applyPointDelta(connection, options)'), '积分服务必须暴露可复用的事务内原子核心');
assert(gamification.includes('reason, related_id') && gamification.includes('options.includeLogs !== false'), '积分核心必须保留关联记录并允许后台任务跳过无用日志查询');
assert(!posts.includes("pool.execute('UPDATE users SET points = points +"), '帖子业务不得绕过统一积分服务直接修改余额');
assert(posts.includes("runBackgroundTask('发帖积分发放失败'") && posts.includes("runBackgroundTask('评论积分发放失败'") && posts.includes("runBackgroundTask('点赞积分发放失败'"), '帖子积分后台任务必须统一捕获异步错误');

const scheduling = require('../services/song-scheduling');
assert.strictEqual(scheduling.normalizeDateOnly('2026-09-21'), '2026-09-21');
assert.strictEqual(scheduling.normalizeDateOnly('2026/09/21'), null);
assert.strictEqual(scheduling.parseSongSlotDateId('42'), 42);
assert.strictEqual(scheduling.parseSongSlotDateId('0'), null);
assert.strictEqual(scheduling.isSlotDateAllowedByCurrentSchedule({ weekdays: '1,3', manual_override: 1, play_date: '2026-09-22' }), true, '管理员单日例外必须继续允许');

console.log('[backend-architecture] 通过：排期、初始化、异步工具、JWT 与积分边界已收敛');
