'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

function testSourceContracts() {
  const follows = read('routes/follows.js');
  assert(follows.includes('await pool.getConnection()') && follows.includes('await connection.beginTransaction()'), '关注切换必须使用事务');
  assert(follows.includes('ORDER BY id FOR UPDATE') && follows.includes('following_id = ? FOR UPDATE'), '关注切换必须锁定双方用户和关注关系');
  assert(follows.includes("reason = 'follow' AND related_id = ?") && follows.includes("reason, related_id) VALUES (?, 1, ?, 'follow', ?)"), '关注积分必须按关注者去重');
  assert(/notifyNewFollower\([\s\S]*?myName,\s*followingId\s*\)/.test(follows), '新粉丝邮件必须传入收件人的用户 ID 以读取通知偏好');
  assert(!/setImmediate\(function\(\)\s*\{\s*pool\.execute\('UPDATE users SET points = points \+ 1/.test(follows), '关注积分不得脱离事务异步写入');

  const messages = read('routes/messages.js');
  assert(messages.includes('sendMessageNotification(senderId, recipientId, content, conversationId)'), '私信邮件必须携带会话 ID');
  assert(messages.includes('user1_dnd') && messages.includes('user2_dnd') && messages.includes('recipient_dnd'), '私信邮件必须读取收件人一侧的会话免打扰设置');
  assert(messages.includes('sendMessageNotification(userId, recipientId, content.trim(), conversationId)'), '发送消息后必须按当前会话检查邮件通知');

  const profile = read('routes/auth.js');
  assert(profile.includes('if (birthday !== undefined)') && profile.includes("birthday === null || birthday === '' ? null : validBirthday"), '明确清空生日时必须写入 NULL');

  const posts = read('routes/posts.js');
  assert(posts.includes('delete post.user_id;') && posts.includes('delete post.ip_address;'), '公开帖子详情不得返回内部用户 ID 或原始 IP');
  assert(posts.includes('delete comment.user_id;') && posts.includes('delete comment.ip_address;'), '公开评论详情不得返回内部用户 ID 或原始 IP');
  assert(posts.includes("? '匿名同学'") && posts.includes('finalIsAnonymous ? \'（匿名评论）\''), '匿名评论提及通知不得暴露真实昵称');
  assert(posts.includes("router.get('/:postId/comments/:commentId/replies', optionalAuth"), '回复列表应识别当前用户并按身份序列化');
  assert(posts.includes('reply.is_anonymous && !isReplyOwner ? null : reply.user_id'), '匿名回复不得向第三人返回作者 ID');

  const frontendDetail = read('frontend/js/detail.js');
  const publicDetail = read('public/js/detail.js');
  const frontendReplies = read('frontend/js/detail-replies.js');
  const publicReplies = read('public/js/detail-replies.js');
  assert(frontendDetail.includes('comment.can_delete === true'), '评论删除按钮应使用服务端权限结果');
  assert(frontendReplies.includes('reply.can_delete === true'), '回复删除按钮应使用服务端权限结果');
  assert.strictEqual(frontendDetail, publicDetail, '详情页源文件与运行文件必须一致');
  assert.strictEqual(frontendReplies, publicReplies, '回复脚本源文件与运行文件必须一致');
}

async function invokeAuth(auth, verifyImpl) {
  const jwt = require('jsonwebtoken');
  jwt.verify = verifyImpl;
  const response = { statusCode: 200, body: null };
  const res = {
    status(code) { response.statusCode = code; return this; },
    json(body) { response.body = body; return this; }
  };
  let nextCalled = false;
  await auth({ headers: { authorization: 'Bearer test-token' }, cookies: {} }, res, function() { nextCalled = true; });
  return { response, nextCalled };
}

async function testAuthFailureClassification() {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'interaction-test-secret';
  const databasePath = require.resolve('../config/database');
  const authPath = require.resolve('../middleware/auth');
  const jwt = require('jsonwebtoken');
  const originalVerify = jwt.verify;
  const originalDatabase = require.cache[databasePath];
  const originalAuth = require.cache[authPath];

  require.cache[databasePath] = {
    id: databasePath,
    filename: databasePath,
    loaded: true,
    exports: { pool: { async execute() { const error = new Error('database unavailable'); error.code = 'ECONNRESET'; throw error; } } }
  };
  delete require.cache[authPath];

  try {
    const { auth } = require('../middleware/auth');
    const databaseFailure = await invokeAuth(auth, function() { return { id: 1 }; });
    assert.strictEqual(databaseFailure.response.statusCode, 503, '数据库故障不应被误报为登录过期');
    assert.strictEqual(databaseFailure.nextCalled, false);

    const tokenFailure = await invokeAuth(auth, function() {
      const error = new Error('bad token');
      error.name = 'JsonWebTokenError';
      throw error;
    });
    assert.strictEqual(tokenFailure.response.statusCode, 401, '无效 JWT 仍应返回 401');
  } finally {
    jwt.verify = originalVerify;
    delete require.cache[authPath];
    if (originalAuth) require.cache[authPath] = originalAuth;
    if (originalDatabase) require.cache[databasePath] = originalDatabase;
    else delete require.cache[databasePath];
  }
}

(async function main() {
  testSourceContracts();
  await testAuthFailureClassification();
  console.log('[interaction-consistency] 通过：关注、私信、登录、资料与匿名身份边界保持一致');
})().catch(function(error) {
  console.error('[interaction-consistency] 失败:', error.message);
  process.exitCode = 1;
});
