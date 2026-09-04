const express = require('express');
const { pool } = require('../config/database');
const { getPagination } = require('../services/pagination');
const { getChinaDate } = require('../services/date');
const router = express.Router();

const LEADERBOARD_TYPES = new Set(['likes', 'views', 'users', 'comments', 'weekly-star']);

// 排行榜
router.get('/', async (req, res) => {
  try {
    const type = typeof req.query.type === 'string' && req.query.type.trim()
      ? req.query.type.trim()
      : 'likes';
    const limit = getPagination(req.query, { defaultLimit: 10, maxLimit: 50 }).limit;

    let data = [];
    let title = '';

    switch (type) {
      case 'likes':
        title = '🔥 热门帖子（点赞最多）';
        [data] = await pool.execute(`
          SELECT p.id, p.title, SUBSTRING(p.content, 1, 100) as content, p.likes_count, p.views, p.created_at,
                 u.nickname, u.username, u.avatar,
                 COALESCE(comment_counts.comments_count, 0) as comments_count
          FROM posts p
          LEFT JOIN users u ON p.user_id = u.id
          LEFT JOIN (
            SELECT post_id, COUNT(*) as comments_count
            FROM comments
            GROUP BY post_id
          ) comment_counts ON comment_counts.post_id = p.id
          WHERE p.is_deleted = 0 AND p.status = 'approved'
          ORDER BY p.likes_count DESC, p.id DESC
          LIMIT ?
        `, [limit]);
        break;

      case 'views':
        title = '👁️ 热门帖子（浏览最多）';
        [data] = await pool.execute(`
          SELECT p.id, p.title, SUBSTRING(p.content, 1, 100) as content, p.likes_count, p.views, p.created_at,
                 u.nickname, u.username, u.avatar
          FROM posts p
          LEFT JOIN users u ON p.user_id = u.id
          WHERE p.is_deleted = 0 AND p.status = 'approved'
          ORDER BY p.views DESC, p.id DESC
          LIMIT ?
        `, [limit]);
        break;

      case 'users':
        title = '🏆 活跃用户（发帖最多）';
        [data] = await pool.execute(`
          SELECT u.id, u.nickname, u.username, u.avatar,
                 COUNT(DISTINCT p.id) as post_count,
                 COUNT(l.id) as likes_received
          FROM users u
          INNER JOIN posts p ON p.user_id = u.id AND p.is_deleted = 0 AND p.status = 'approved'
          LEFT JOIN likes l ON l.post_id = p.id
          GROUP BY u.id, u.nickname, u.username, u.avatar
          ORDER BY post_count DESC, likes_received DESC, u.id ASC
          LIMIT ?
        `, [limit]);
        break;

      case 'comments':
        title = '💬 热门帖子（评论最多）';
        [data] = await pool.execute(`
          SELECT p.id, p.title, SUBSTRING(p.content, 1, 100) as content, p.likes_count, p.views, p.created_at,
                 u.nickname, u.username, u.avatar,
                 COALESCE(comment_counts.comments_count, 0) as comments_count
          FROM posts p
          LEFT JOIN users u ON p.user_id = u.id
          LEFT JOIN (
            SELECT post_id, COUNT(*) as comments_count
            FROM comments
            GROUP BY post_id
          ) comment_counts ON comment_counts.post_id = p.id
          WHERE p.is_deleted = 0 AND p.status = 'approved'
          ORDER BY comments_count DESC, p.id DESC
          LIMIT ?
        `, [limit]);
        break;

      case 'weekly-star':
        title = '🏆 本周之星';
        const since = `${getChinaDate(-7)} 00:00:00`;
        [data] = await pool.execute(`
          SELECT p.id, p.title, SUBSTRING(p.content, 1, 100) as content, p.likes_count, p.created_at,
                 u.id as user_id, u.nickname, u.username, u.avatar
          FROM posts p
          LEFT JOIN users u ON p.user_id = u.id
          WHERE p.created_at >= ? AND p.is_deleted = 0 AND p.status = 'approved'
          ORDER BY p.likes_count DESC, p.id DESC
          LIMIT ?
        `, [since, limit]);
        break;

      default:
        return res.json({ code: 400, message: '无效的排行榜类型' });
    }

    if (!LEADERBOARD_TYPES.has(type)) {
      return res.json({ code: 400, message: '无效的排行榜类型' });
    }

    res.json({ code: 200, data: { title, type, list: data } });
  } catch (err) {
    console.error('排行榜错误:', err && (err.code || err.message));
    res.json({ code: 500, message: '服务器错误' });
  }
});

module.exports = router;
