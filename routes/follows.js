/**
 * 关注/粉丝系统
 */
const express = require('express');
const { pool } = require('../config/database');
const { auth } = require('../middleware/auth');
const { getPagination } = require('../services/pagination');
const { createNotification } = require('../services/notification');
const { notifyNewFollower } = require('../services/email');
const router = express.Router();

// 关注/取消关注 (toggle)
router.post('/:userId', auth, async (req, res) => {
  let connection;
  try {
    const followingId = Number(req.params.userId);
    const followerId = req.user.id;

    if (!Number.isInteger(followingId) || followingId <= 0) {
      return res.json({ code: 400, message: '用户参数无效' });
    }
    if (followerId === followingId) {
      return res.json({ code: 400, message: '不能关注自己哦~' });
    }

    connection = await pool.getConnection();
    await connection.beginTransaction();

    // 按固定顺序锁定双方用户，避免并发关注时出现重复关系或积分记录与余额分离。
    const [users] = await connection.execute(
      'SELECT id, nickname, username, email, points FROM users WHERE id IN (?, ?) ORDER BY id FOR UPDATE',
      [followerId, followingId]
    );
    const follower = users.find(function(user) { return user.id === followerId; });
    const target = users.find(function(user) { return user.id === followingId; });
    if (!target || !follower) {
      await connection.rollback();
      return res.json({ code: 404, message: '用户不存在' });
    }

    const [existing] = await connection.execute(
      'SELECT id FROM follows WHERE follower_id = ? AND following_id = ? FOR UPDATE',
      [followerId, followingId]
    );

    if (existing.length > 0) {
      await connection.execute('DELETE FROM follows WHERE follower_id = ? AND following_id = ?', [followerId, followingId]);
      await connection.commit();
      return res.json({ code: 200, message: '已取消关注', data: { followed: false } });
    }

    await connection.execute('INSERT INTO follows (follower_id, following_id) VALUES (?, ?)', [followerId, followingId]);

    // 同一位关注者只奖励被关注者一次，取消后重新关注不能重复刷积分。
    const [rewardLogs] = await connection.execute(
      "SELECT id FROM points_log WHERE user_id = ? AND reason = 'follow' AND related_id = ? LIMIT 1 FOR UPDATE",
      [followingId, followerId]
    );
    if (rewardLogs.length === 0) {
      await connection.execute('UPDATE users SET points = points + 1 WHERE id = ?', [followingId]);
      const [balances] = await connection.execute('SELECT points FROM users WHERE id = ?', [followingId]);
      await connection.execute(
        "INSERT INTO points_log (user_id, points, balance, reason, related_id) VALUES (?, 1, ?, 'follow', ?)",
        [followingId, balances[0].points, followerId]
      );
    }

    await connection.commit();

    const myName = follower.nickname || follower.username || '某用户';
    setImmediate(async () => {
      try {
        await createNotification(followingId, 'follow', '新粉丝', myName + ' 关注了你', null, null);
        if (target.email) {
          await notifyNewFollower(
            target.email,
            target.nickname || target.username || '用户',
            myName,
            followingId
          );
        }
      } catch (err) {
        console.error('[Follow] 发送通知失败:', err.message);
      }
    });

    return res.json({ code: 200, message: '关注成功', data: { followed: true } });
  } catch (err) {
    if (connection) {
      try { await connection.rollback(); } catch (_) {}
    }
    console.error('[Follow] 操作失败:', err.message);
    res.json({ code: 500, message: '服务器错误' });
  } finally {
    if (connection) connection.release();
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
    const { page, limit, offset } = getPagination(req.query, { defaultLimit: 20, maxLimit: 50 });

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
        page
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
    const { page, limit, offset } = getPagination(req.query, { defaultLimit: 20, maxLimit: 50 });

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
        page
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
