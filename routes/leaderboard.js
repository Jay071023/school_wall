const express = require('express');
const { pool } = require('../config/database');
const router = express.Router();

// 排行榜
router.get('/', async (req, res) => {
  try {
    const type = req.query.type || 'likes';
    const limit = parseInt(req.query.limit) || 10;

    let data = [];
    let title = '';

    switch (type) {
      case 'likes':
        title = '🔥 热门帖子（点赞最多）';
        [data] = await pool.execute(`
          SELECT p.id, p.title, SUBSTRING(p.content, 1, 100) as content, p.likes_count, p.views, p.created_at,
                 u.nickname, u.username, u.avatar,
                 (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) as comments_count
          FROM posts p
          LEFT JOIN users u ON p.user_id = u.id
          WHERE p.is_deleted = 0 AND p.status = 'approved'
          ORDER BY p.likes_count DESC
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
          ORDER BY p.views DESC
          LIMIT ?
        `, [limit]);
        break;

      case 'users':
        title = '🏆 活跃用户（发帖最多）';
        [data] = await pool.execute(`
          SELECT u.id, u.nickname, u.username, u.avatar,
                 (SELECT COUNT(*) FROM posts p WHERE p.user_id = u.id AND p.is_deleted = 0 AND p.status = 'approved') as post_count,
                 (SELECT COUNT(*) FROM likes l JOIN posts p ON l.post_id = p.id WHERE p.user_id = u.id) as likes_received
          FROM users u
          HAVING post_count > 0
          ORDER BY post_count DESC
          LIMIT ?
        `, [limit]);
        break;

      case 'comments':
        title = '💬 热门帖子（评论最多）';
        [data] = await pool.execute(`
          SELECT p.id, p.title, SUBSTRING(p.content, 1, 100) as content, p.likes_count, p.views, p.created_at,
                 u.nickname, u.username, u.avatar,
                 (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) as comments_count
          FROM posts p
          LEFT JOIN users u ON p.user_id = u.id
          WHERE p.is_deleted = 0 AND p.status = 'approved'
          ORDER BY comments_count DESC
          LIMIT ?
        `, [limit]);
        break;

      default:
        return res.json({ code: 400, message: '无效的排行榜类型' });
    }

    res.json({ code: 200, data: { title, type, list: data } });
  } catch (err) {
    console.error('排行榜错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

module.exports = router;
