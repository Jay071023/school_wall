'use strict';

const { pool } = require('../config/database');

/**
 * 创建站内通知。
 * 通知写入失败只记录日志，不阻断原始的评论/关注/点赞业务。
 */
async function createNotification(userId, type, title, content, relatedId, relatedType) {
  try {
    await pool.execute(
      'INSERT INTO notifications (user_id, type, title, content, related_id, related_type) VALUES (?, ?, ?, ?, ?, ?)',
      [userId, type, title, content || '', relatedId || null, relatedType || null]
    );
  } catch (err) {
    console.error('创建通知失败:', err && (err.code || err.message) || 'unknown error');
  }
}

module.exports = { createNotification };
