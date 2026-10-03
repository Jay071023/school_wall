'use strict';

const assert = require('assert');
const Module = require('module');
const express = require('express');

const settings = { anon_post: 'false', anon_comment: 'false', post_review: 'false' };
let existingPostAnonymous = 0;
const writes = [];
const pool = {
  async execute(sql, params) {
    if (sql.includes('FROM settings WHERE config_key = ?')) {
      const value = settings[params[0]];
      return [value === undefined ? [] : [{ config_value: value }]];
    }
    if (sql.includes('SELECT user_id, title, content, category') && sql.includes('FROM posts')) {
      return [[{ user_id: 7, title: '原帖', content: '正文', is_anonymous: existingPostAnonymous, is_deleted: 0 }]];
    }
    if (sql.includes('SELECT id FROM posts WHERE id = ? AND status = "approved"')) return [[{ id: 3 }]];
    if (sql.includes('SELECT c.id, c.user_id')) return [[{ id: 5, user_id: 7 }]];
    if (sql.includes('SELECT nickname, username FROM users')) return [[{ nickname: '测试用户' }]];
    if (sql.includes('FROM follows f JOIN users u')) return [[]];
    if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)) {
      writes.push({ sql, params });
      return [{ affectedRows: 1, insertId: 9 }];
    }
    throw new Error('Unexpected SQL: ' + sql);
  }
};

const routePath = require.resolve('../routes/posts');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (parent && parent.filename === routePath) {
    if (request === '../config/database') return { pool };
    if (request === '../middleware/auth') {
      return { auth: (req, res, next) => { req.user = { id: 7, nickname: '测试用户' }; next(); }, optionalAuth: (req, res, next) => next(), isStaffRole: () => false };
    }
    if (request === '../services/task-lifecycle') return { createIntervalTask: () => ({ start() {}, stop() {} }) };
    if (request === '../services/ip-lookup') return { getIpRegion: async () => '', getClientIp: () => '127.0.0.1' };
    if (request === '../services/email') return { notifyNewComment() {}, notifyNewLike() {}, notifyMention() {}, notifyFollowPost() {}, notifyAdminNewPostPending() {} };
    if (request === '../services/notification') return { createNotification: async () => {} };
    if (request === '../services/baidu-push') return { pushPost() {} };
    if (request === '../services/gamification') return { adjustUserPoints: async () => {} };
    if (request === '../services/async-utils') return { runBackgroundTask() {} };
  }
  return originalLoad.call(this, request, parent, isMain);
};
let router;
try {
  router = require('../routes/posts');
} finally {
  Module._load = originalLoad;
}

async function main() {
  const app = express();
  app.use(express.json());
  app.use('/posts', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  async function request(path, method, body) {
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return response.json();
  }
  try {
    const postBody = { title: '新帖', content: '正文', is_anonymous: true };
    assert.equal((await request('/posts', 'POST', postBody)).code, 400, '关闭匿名时新帖必须被拒绝');
    assert.equal(writes.length, 0, '拒绝匿名发帖前不得写库');
    assert.equal((await request('/posts/3/comments', 'POST', { content: '评论', is_anonymous: true })).code, 400);
    assert.equal((await request('/posts/3/comments/5/replies', 'POST', { content: '回复', is_anonymous: true })).code, 400);
    assert.equal((await request('/posts/3', 'PUT', { is_anonymous: true })).code, 400, '编辑署名帖不得绕过匿名开关');
    assert.equal(writes.length, 0, '所有被拒绝的匿名请求均不得写库');

    existingPostAnonymous = 1;
    assert.equal((await request('/posts/3', 'PUT', { is_anonymous: true })).code, 200, '旧匿名帖编辑时应保留原有匿名身份');
    existingPostAnonymous = 0;
    assert.equal((await request('/posts', 'POST', { title: '署名帖', content: '正文', is_anonymous: false })).code, 200);
    assert(writes.some(item => item.sql.includes('INSERT INTO posts') && item.params[6] === 0), '署名发帖仍应正常写入');

    settings.anon_post = 'true';
    assert.equal((await request('/posts', 'POST', postBody)).code, 200, '开启匿名后应可正常发匿名帖');
    assert(writes.some(item => item.sql.includes('INSERT INTO posts') && item.params[6] === 1));
    delete settings.anon_post;
    assert.equal((await request('/posts', 'POST', postBody)).code, 400, '缺少匿名设置时应默认拒绝');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  console.log('[anonymous-policy] 通过：关闭后拒绝匿名发帖、评论、回复和编辑，旧帖保留身份，开启后可发布');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
