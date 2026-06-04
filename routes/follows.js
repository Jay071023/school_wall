/**
 * 关注/粉丝系统
 */
const express = require('express');
const { pool } = require('../config/database');
const { auth } = require('../middleware/auth');
const { createNotification } = require('./notifications');
const { notifyNewFollower } = require('../services/email');
const router = express.Router();

// 初始化关注表
(async function initFollowsTable() {
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS follows (
        id INT AUTO_INCREMENT PRIMARY KEY,
        follower_id INT NOT NULL COMMENT '关注者',
        following_id INT NOT NULL COMMENT '被关注者',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_follow (follower_id, following_id),
        INDEX idx_follower (follower_id),
        INDEX idx_following (following_id),
        FOREIGN KEY (follower_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (following_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='关注关系'
    `);
    console.log('[Follows] 关注表已就绪');
  } catch (err) {
    if (err.code !== 'ER_TABLE_EXISTS_ERR') {
      console.error('[Follows] 初始化关注表失败:', err.message);
    }
  }
})();

// 关注/取消关注 (toggle)
router.post('/:userId', auth, async (req, res) => {
  try {
    const followingId = parseInt(req.params.userId);
    const followerId = req.user.id;

    if (followerId === followingId) {
      return res.json({ code: 400, message: '不能关注自己哦~' });
    }

    // 检查用户是否存在
    const [users] = await pool.execute('SELECT id, nickname, username, email FROM users WHERE id = ?', [followingId]);
    if (users.length === 0) {
      return res.json({ code: 404, message: '用户不存在' });
    }

    // 检查是否已关注
    const [existing] = await pool.execute(
      'SELECT id FROM follows WHERE follower_id = ? AND following_id = ?',
      [followerId, followingId]
    );

    if (existing.length > 0) {
      // 取消关注
      await pool.execute('DELETE FROM follows WHERE follower_id = ? AND following_id = ?', [followerId, followingId]);
      res.json({ code: 200, message: '已取消关注', data: { followed: false } });
    } else {
      // 关注
      await pool.execute('INSERT INTO follows (follower_id, following_id) VALUES (?, ?)', [followerId, followingId]);

      // 发送通知给被关注者
      const [me] = await pool.execute('SELECT nickname, username FROM users WHERE id = ?', [followerId]);
      const myName = me[0].nickname || me[0].username || '某用户';

      setImmediate(async () => {
        try {
          await createNotification(
            followingId,
            'follow',
            '新粉丝',
            myName + ' 关注了你',
            null,
            null
          );
          // 发送邮件通知
          if (users[0].email) {
            await notifyNewFollower(
              users[0].email,
              users[0].nickname || users[0].username || '用户',
              myName
            );
          }
        } catch (err) {
          console.error('[Follow] 发送通知失败:', err.message);
        }
      });

      res.json({ code: 200, message: '关注成功', data: { followed: true } });
    }
  } catch (err) {
    console.error('[Follow] 操作失败:', err.message);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取关注状态
router.get('/status/:userId', auth, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT id FROM follows WHERE follower_id = ? AND following_id = ?',
      [req.user.id, parseInt(req.params.userId)]
    );
    res.json({ code: 200, data: { followed: rows.length > 0 } });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取用户的粉丝列表
router.get('/:userId/followers', auth, async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const { page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    const [list] = await pool.execute(`
      SELECT u.id, u.nickname, u.username, u.avatar, u.role, f.created_at as followed_at
      FROM follows f
      JOIN users u ON f.follower_id = u.id
      WHERE f.following_id = ?
      ORDER BY f.created_at DESC
      LIMIT ? OFFSET ?
    `, [userId, parseInt(limit), parseInt(offset)]);

    const [countResult] = await pool.execute(
      'SELECT COUNT(*) as total FROM follows WHERE following_id = ?',
      [userId]
    );

    res.json({
      code: 200,
      data: {
        list,
        total: countResult[0].total,
        page: parseInt(page)
      }
    });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取用户的关注列表（正在关注的人）
router.get('/:userId/following', auth, async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const { page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    const [list] = await pool.execute(`
      SELECT u.id, u.nickname, u.username, u.avatar, u.role, f.created_at as followed_at
      FROM follows f
      JOIN users u ON f.following_id = u.id
      WHERE f.follower_id = ?
      ORDER BY f.created_at DESC
      LIMIT ? OFFSET ?
    `, [userId, parseInt(limit), parseInt(offset)]);

    const [countResult] = await pool.execute(
      'SELECT COUNT(*) as total FROM follows WHERE follower_id = ?',
      [userId]
    );

    res.json({
      code: 200,
      data: {
        list,
        total: countResult[0].total,
        page: parseInt(page)
      }
    });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取关注/粉丝数量
router.get('/:userId/count', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const [followers] = await pool.execute('SELECT COUNT(*) as count FROM follows WHERE following_id = ?', [userId]);
    const [following] = await pool.execute('SELECT COUNT(*) as count FROM follows WHERE follower_id = ?', [userId]);

    res.json({
      code: 200,
      data: {
        followers_count: followers[0].count,
        following_count: following[0].count
      }
    });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

module.exports = router;
