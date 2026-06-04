const express = require('express');
const { pool } = require('../config/database');
const { auth } = require('../middleware/auth');
const router = express.Router();

// 创建通知表
router.get('/init-table', auth, async (req, res) => {
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS notifications (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        type VARCHAR(50) NOT NULL COMMENT 'comment|like|follow|mention|system',
        title VARCHAR(255) NOT NULL,
        content TEXT,
        related_id INT COMMENT '关联的帖子或评论ID',
        related_type VARCHAR(50) COMMENT 'post|comment',
        is_read TINYINT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_user_read (user_id, is_read),
        INDEX idx_created (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    res.json({ code: 200, message: '通知表已创建' });
  } catch (err) {
    console.error('创建通知表失败:', err);
    res.json({ code: 500, message: '创建失败' });
  }
});

// 获取我的通知列表
router.get('/', auth, async (req, res) => {
  try {
    const { page = 1, limit = 20, unread_only } = req.query;
    const offset = (page - 1) * limit;
    
    let whereClause = 'user_id = ?';
    const params = [req.user.id];
    
    if (unread_only === 'true') {
      whereClause += ' AND is_read = 0';
    }
    
    const [notifications] = await pool.execute(
      `SELECT * FROM notifications WHERE ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
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
    console.error('获取通知失败:', err);
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
    console.error('获取未读数量失败:', err);
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
    console.error('标记已读失败:', err);
    res.json({ code: 500, message: '操作失败' });
  }
});

// 标记所有通知为已读
router.put('/read-all', auth, async (req, res) => {
  try {
    await pool.execute(
      'DELETE FROM notifications WHERE user_id = ?',
      [req.user.id]
    );
    res.json({ code: 200, message: '已清空所有通知' });
  } catch (err) {
    console.error('清空通知失败:', err);
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
    console.error('删除通知失败:', err);
    res.json({ code: 500, message: '删除失败' });
  }
});

// 辅助函数：创建通知
async function createNotification(userId, type, title, content, relatedId, relatedType) {
  try {
    await pool.execute(
      'INSERT INTO notifications (user_id, type, title, content, related_id, related_type) VALUES (?, ?, ?, ?, ?, ?)',
      [userId, type, title, content || '', relatedId || null, relatedType || null]
    );
  } catch (err) {
    console.error('创建通知失败:', err);
  }
}

module.exports = router;
module.exports.createNotification = createNotification;
