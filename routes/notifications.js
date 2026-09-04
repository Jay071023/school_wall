const express = require('express');
const { pool, ensureNotificationsTable } = require('../config/database');
const { auth, isStaff } = require('../middleware/auth');
const { getPagination } = require('../services/pagination');
const { createNotification } = require('../services/notification');
const router = express.Router();

// 保留历史初始化接口，实际初始化统一由 config/database.js 负责。
router.get('/init-table', auth, isStaff, async (req, res) => {
  try {
    await ensureNotificationsTable(pool);
    res.json({ code: 200, message: '通知表已创建' });
  } catch (err) {
    console.error('创建通知表失败:', err && (err.code || err.message) || 'unknown error');
    res.json({ code: 500, message: '创建失败' });
  }
});

// 获取我的通知列表
router.get('/', auth, async (req, res) => {
  try {
    const { limit, offset } = getPagination(req.query, { defaultLimit: 20, maxLimit: 100 });
    const { unread_only } = req.query;
    
    let whereClause = 'user_id = ?';
    const params = [req.user.id];
    
    if (unread_only === 'true') {
      whereClause += ' AND is_read = 0';
    }
    
    const [notifications] = await pool.execute(
      `SELECT * FROM notifications WHERE ${whereClause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), parseInt(offset)]
    );
    
    const [countResult] = await pool.execute(
      `SELECT COUNT(*) as total, SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) as unread FROM notifications WHERE user_id = ?`,
      [req.user.id]
    );
    
    res.json({
      code: 200,
      data: {
        notifications,
        total: countResult[0].total,
        unread: countResult[0].unread || 0
      }
    });
  } catch (err) {
    console.error('获取通知失败:', err && (err.code || err.message) || 'unknown error');
    res.json({ code: 500, message: '获取失败' });
  }
});

// 获取未读通知数量
router.get('/unread-count', auth, async (req, res) => {
  try {
    const [result] = await pool.execute(
      'SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = 0',
      [req.user.id]
    );
    res.json({ code: 200, data: { count: result[0].count } });
  } catch (err) {
    console.error('获取未读数量失败:', err && (err.code || err.message) || 'unknown error');
    res.json({ code: 500, message: '获取失败' });
  }
});

// 标记单条通知为已读
router.put('/:id/read', auth, async (req, res) => {
  try {
    await pool.execute(
      'UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    res.json({ code: 200, message: '已标记为已读' });
  } catch (err) {
    console.error('标记已读失败:', err && (err.code || err.message) || 'unknown error');
    res.json({ code: 500, message: '操作失败' });
  }
});

// 标记所有通知为已读
router.put('/read-all', auth, async (req, res) => {
  try {
    const [result] = await pool.execute(
      'UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0',
      [req.user.id]
    );
    res.json({ code: 200, message: '已全部标记为已读', data: { updated: result.affectedRows } });
  } catch (err) {
    console.error('标记全部已读失败:', err && (err.code || err.message) || 'unknown error');
    res.json({ code: 500, message: '操作失败' });
  }
});

// 删除通知
router.delete('/:id', auth, async (req, res) => {
  try {
    await pool.execute(
      'DELETE FROM notifications WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    res.json({ code: 200, message: '已删除' });
  } catch (err) {
    console.error('删除通知失败:', err && (err.code || err.message) || 'unknown error');
    res.json({ code: 500, message: '删除失败' });
  }
});

module.exports = router;
