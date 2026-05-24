const express = require('express');
const fs = require('fs');
const path = require('path');
const { pool } = require('../config/database');
const { auth, isStaff, superAdminOnly, requirePermission, ROLE_NAMES } = require('../middleware/auth');
const { notifyPostApproved, notifyPostRejected, notifySongApproved, notifySongRejected, notifySongPlayed } = require('../services/email');
const jwt = require('jsonwebtoken');
const mpDraftService = require('../services/mp-draft');
const aiService = require('../services/ai');
const router = express.Router();

const SITE_URL = 'https://wall.jay23.cn';
const JWT_SECRET = process.env.JWT_SECRET || require('crypto').randomBytes(32).toString('hex');

// 所有管理路由都需要登录 + 是管理后台用户
router.use(auth, isStaff);

// ===== 获取当前用户权限信息 =====
router.get('/my-permissions', (req, res) => {
  res.json({
    code: 200,
    data: {
      role: req.user.role,
      roleName: req.user.roleName,
      permissions: req.user.permissions
    }
  });
});

// ===== 统计数据（需要 stats:view 权限）=====
router.get('/stats', requirePermission('stats:view'), async (req, res) => {
  try {
    const [users] = await pool.execute('SELECT COUNT(*) as total FROM users');
    const [regularUsers] = await pool.execute('SELECT COUNT(*) as total FROM users WHERE role = "user"');
    const [posts] = await pool.execute('SELECT COUNT(*) as total FROM posts');
    const [pendingPosts] = await pool.execute('SELECT COUNT(*) as total FROM posts WHERE status = "pending"');
    const [songs] = await pool.execute('SELECT COUNT(*) as total FROM song_requests');
    const [pendingSongs] = await pool.execute('SELECT COUNT(*) as total FROM song_requests WHERE status = "pending"');
    const [todayPosts] = await pool.execute('SELECT COUNT(*) as total FROM posts WHERE DATE(created_at) = CURDATE()');
    const [todaySongs] = await pool.execute('SELECT COUNT(*) as total FROM song_requests WHERE DATE(created_at) = CURDATE()');
    const [todayPostViews] = await pool.execute('SELECT COUNT(*) as total FROM post_views WHERE DATE(viewed_at) = CURDATE()');
    // feedbacks 表可能不存在，查失败就当0处理
    let pendingFeedbacks = [{ total: 0 }];
    try {
      pendingFeedbacks = (await pool.execute('SELECT COUNT(*) as total FROM feedbacks WHERE status = "pending"'))[0];
    } catch (e) {}

    res.json({
      code: 200,
      data: {
        totalUsers: users[0].total,
        regularUsers: regularUsers[0].total,
        totalPosts: posts[0].total,
        pendingPosts: pendingPosts[0].total,
        totalSongs: songs[0].total,
        pendingSongs: pendingSongs[0].total,
        todayPosts: todayPosts[0].total,
        todaySongs: todaySongs[0].total,
        todayPostViews: todayPostViews[0].total,
        pendingFeedbacks: pendingFeedbacks[0].total
      }
    });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ===== 帖子管理（需要 posts:review 权限）=====

// 获取帖子列表
router.get('/posts', requirePermission('posts:review'), async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const offset = (page - 1) * limit;

    let whereClause = '1=1';
    const params = [];
    if (status) {
      whereClause += ' AND p.status = ?';
      params.push(status);
    }

    const [posts] = await pool.execute(`
      SELECT p.*, u.username, u.nickname
      FROM posts p
      LEFT JOIN users u ON p.user_id = u.id
      WHERE ${whereClause}
      ORDER BY p.created_at DESC
      LIMIT ? OFFSET ?
    `, [...params, parseInt(limit), parseInt(offset)]);

    const [countResult] = await pool.execute(`SELECT COUNT(*) as total FROM posts p WHERE ${whereClause}`, params);

    res.json({
      code: 200,
      data: {
        posts: posts.map(p => ({ ...p, images: p.images ? JSON.parse(p.images) : [] })),
        total: countResult[0].total,
        totalPages: Math.ceil(countResult[0].total / limit)
      }
    });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 审核帖子
router.put('/posts/:id/status', requirePermission('posts:review'), async (req, res) => {
  try {
    const { status } = req.body;
    if (!['approved', 'rejected'].includes(status)) {
      return res.json({ code: 400, message: '无效状态' });
    }
    await pool.execute('UPDATE posts SET status = ? WHERE id = ?', [status, req.params.id]);

    // 异步发送邮件通知帖子作者
    setImmediate(async () => {
      try {
        const [posts] = await pool.execute('SELECT p.user_id, p.title, u.email, u.nickname, u.username FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.id = ?', [req.params.id]);
        if (posts.length > 0 && posts[0].email) {
          const user = posts[0];
          if (status === 'approved') {
            await notifyPostApproved(user.email, user.nickname || user.username || '用户', user.title || '无标题', user.user_id);
          } else {
            await notifyPostRejected(user.email, user.nickname || user.username || '用户', user.title || '无标题', '', user.user_id);
          }
        }
      } catch (err) {
        console.error('[Email] 发送帖子审核通知失败:', err.message);
      }
    });

    res.json({ code: 200, message: '操作成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 批量审核帖子
router.put('/posts/batch-status', requirePermission('posts:review'), async (req, res) => {
  try {
    const { ids, status } = req.body;
    if (!Array.isArray(ids) || ids.length === 0 || !['approved', 'rejected'].includes(status)) {
      return res.json({ code: 400, message: '无效参数' });
    }
    const placeholders = ids.map(() => '?').join(',');
    await pool.execute(`UPDATE posts SET status = ? WHERE id IN (${placeholders})`, [status, ...ids]);
    res.json({ code: 200, message: `已批量${status === 'approved' ? '通过' : '拒绝'} ${ids.length} 条` });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取帖子详情
router.get('/posts/:id', requirePermission('posts:review'), async (req, res) => {
  try {
    const [posts] = await pool.execute(`
      SELECT p.*, u.username, u.nickname
      FROM posts p
      LEFT JOIN users u ON p.user_id = u.id
      WHERE p.id = ?
    `, [req.params.id]);

    if (posts.length === 0) {
      return res.json({ code: 404, message: '帖子不存在' });
    }

    const post = posts[0];
    post.images = post.images ? JSON.parse(post.images) : [];

    res.json({ code: 200, data: post });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 初始化回收站字段（运行一次）
router.post('/init-trash-column', requirePermission('admin:manage'), async (req, res) => {
  try {
    await pool.execute(`
      ALTER TABLE posts 
      ADD COLUMN IF NOT EXISTS is_deleted TINYINT(1) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP NULL DEFAULT NULL,
      ADD INDEX idx_deleted (is_deleted)
    `);
    res.json({ code: 200, message: '回收站字段初始化成功' });
  } catch (err) {
    res.json({ code: 500, message: err.message });
  }
});

// 获取回收站帖子列表
router.get('/trash/posts', requirePermission('posts:delete'), async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    const [posts] = await pool.execute(`
      SELECT p.*, u.username, u.nickname
      FROM posts p
      LEFT JOIN users u ON p.user_id = u.id
      WHERE p.is_deleted = 1
      ORDER BY p.deleted_at DESC
      LIMIT ? OFFSET ?
    `, [parseInt(limit), offset]);

    const [countResult] = await pool.execute('SELECT COUNT(*) as total FROM posts WHERE is_deleted = 1');

    res.json({
      code: 200,
      data: {
        posts: posts.map(p => ({ ...p, images: p.images ? JSON.parse(p.images) : [] })),
        total: countResult[0].total,
        totalPages: Math.ceil(countResult[0].total / limit)
      }
    });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取回收站帖子详情
router.get('/trash/posts/:id', requirePermission('posts:delete'), async (req, res) => {
  try {
    const [posts] = await pool.execute(`
      SELECT p.*, u.username, u.nickname
      FROM posts p
      LEFT JOIN users u ON p.user_id = u.id
      WHERE p.id = ? AND p.is_deleted = 1
    `, [req.params.id]);

    if (posts.length === 0) {
      return res.json({ code: 404, message: '帖子不存在或已彻底删除' });
    }

    res.json({ code: 200, data: { ...posts[0], images: posts[0].images ? JSON.parse(posts[0].images) : [] } });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 恢复帖子
router.put('/trash/posts/:id/restore', requirePermission('posts:delete'), async (req, res) => {
  try {
    await pool.execute('UPDATE posts SET is_deleted = 0, deleted_at = NULL WHERE id = ? AND is_deleted = 1', [req.params.id]);
    res.json({ code: 200, message: '恢复成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 彻底删除帖子
router.delete('/trash/posts/:id', requirePermission('posts:delete'), async (req, res) => {
  try {
    await pool.execute('DELETE FROM posts WHERE id = ? AND is_deleted = 1', [req.params.id]);
    res.json({ code: 200, message: '彻底删除成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 清空回收站
router.delete('/trash/posts', requirePermission('admin:manage'), async (req, res) => {
  try {
    await pool.execute('DELETE FROM posts WHERE is_deleted = 1');
    res.json({ code: 200, message: '清空成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 软删除帖子（移入回收站）
router.delete('/posts/:id', requirePermission('posts:delete'), async (req, res) => {
  try {
    const postId = parseInt(req.params.id);
    if (isNaN(postId)) {
      return res.json({ code: 400, message: '无效的帖子ID' });
    }
    
    // 先检查帖子是否存在
    const [posts] = await pool.execute('SELECT id FROM posts WHERE id = ?', [postId]);
    if (posts.length === 0) {
      return res.json({ code: 404, message: '帖子不存在' });
    }
    
    // 尝试软删除（如果字段存在）
    try {
      await pool.execute('UPDATE posts SET is_deleted = 1, deleted_at = NOW() WHERE id = ?', [postId]);
    } catch (err) {
      // 如果字段不存在，直接硬删除
      if (err.code === 'ER_BAD_FIELD_ERROR') {
        await pool.execute('DELETE FROM posts WHERE id = ?', [postId]);
      } else {
        throw err;
      }
    }
    
    res.json({ code: 200, message: '已移入回收站' });
  } catch (err) {
    console.error('删除帖子错误:', err);
    res.json({ code: 500, message: '服务器错误: ' + err.message });
  }
});

// 置顶/取消置顶帖子
router.put('/posts/:id/pin', requirePermission('posts:review'), async (req, res) => {
  try {
    const [post] = await pool.execute('SELECT id, is_pinned FROM posts WHERE id = ?', [req.params.id]);
    if (post.length === 0) return res.json({ code: 404, message: '帖子不存在' });
    const newPinned = post[0].is_pinned ? 0 : 1;
    await pool.execute('UPDATE posts SET is_pinned = ? WHERE id = ?', [newPinned, req.params.id]);
    res.json({ code: 200, message: newPinned ? '已置顶' : '已取消置顶', data: { is_pinned: newPinned } });
  } catch (err) {
    console.error('置顶操作错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ===== 用户管理（需要 users:view 权限）=====

// 获取用户列表
router.get('/users', requirePermission('users:view'), async (req, res) => {
  try {
    const { page = 1, limit = 50, search = '' } = req.query;
    const offset = (page - 1) * limit;

    // 支持模糊搜索用户名和昵称
    let whereClause = '1=1';
    let params = [];
    if (search) {
      whereClause = '(username LIKE ? OR nickname LIKE ?)';
      params = [`%${search}%`, `%${search}%`];
    }

    const [users] = await pool.execute(`
      SELECT id, username, nickname, avatar, email, role, status, created_at,
             last_login_at, last_login_ip, last_login_region FROM users
      WHERE ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `, [...params, parseInt(limit), parseInt(offset)]);

    const [countResult] = await pool.execute(`SELECT COUNT(*) as total FROM users WHERE ${whereClause}`, params);

    res.json({
      code: 200,
      data: {
        users,
        total: countResult[0].total,
        totalPages: Math.ceil(countResult[0].total / limit)
      }
    });
  } catch (err) {
    console.error('获取用户列表错误:', err.message);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 修改用户状态（启用/禁用）
router.put('/users/:id/status', requirePermission('users:status'), async (req, res) => {
  try {
    const { status } = req.body;
    const targetId = parseInt(req.params.id);

    // 不能禁用自己
    if (targetId === req.user.id) {
      return res.json({ code: 400, message: '不能禁用自己的账号' });
    }

    // 不能禁用超级管理员
    const [target] = await pool.execute('SELECT role FROM users WHERE id = ?', [targetId]);
    if (target.length > 0 && target[0].role === 'super_admin') {
      return res.json({ code: 403, message: '不能禁用超级管理员' });
    }

    await pool.execute('UPDATE users SET status = ? WHERE id = ?', [status, targetId]);
    res.json({ code: 200, message: '操作成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ===== 修改用户角色（仅超级管理员）=====
router.put('/users/:id/role', superAdminOnly, async (req, res) => {
  try {
    const { role } = req.body;
    const targetId = parseInt(req.params.id);

    const validRoles = ['user', 'reviewer', 'radio_admin', 'admin', 'super_admin'];
    if (!validRoles.includes(role)) {
      return res.json({ code: 400, message: '无效角色' });
    }

    // 不能修改自己的角色
    if (targetId === req.user.id) {
      return res.json({ code: 400, message: '不能修改自己的角色' });
    }

    // 检查目标用户
    const [target] = await pool.execute('SELECT role FROM users WHERE id = ?', [targetId]);
    if (target.length === 0) {
      return res.json({ code: 404, message: '用户不存在' });
    }

    // 不能修改其他超级管理员的角色
    if (target[0].role === 'super_admin') {
      return res.json({ code: 403, message: '不能修改超级管理员的角色' });
    }

    await pool.execute('UPDATE users SET role = ? WHERE id = ?', [role, targetId]);
    res.json({ code: 200, message: '角色修改成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ===== 删除用户（仅超级管理员）=====
router.delete('/users/:id', superAdminOnly, async (req, res) => {
  try {
    const targetId = parseInt(req.params.id);

    // 不能删除自己
    if (targetId === req.user.id) {
      return res.json({ code: 400, message: '不能删除自己' });
    }

    // 检查目标用户
    const [target] = await pool.execute('SELECT role FROM users WHERE id = ?', [targetId]);
    if (target.length === 0) {
      return res.json({ code: 404, message: '用户不存在' });
    }

    // 不能删除其他超级管理员
    if (target[0].role === 'super_admin') {
      return res.json({ code: 403, message: '不能删除超级管理员' });
    }

    // 删除用户相关数据
    await pool.execute('DELETE FROM song_requests WHERE user_id = ?', [targetId]);
    await pool.execute('DELETE FROM posts WHERE user_id = ?', [targetId]);
    await pool.execute('DELETE FROM users WHERE id = ?', [targetId]);
    res.json({ code: 200, message: '用户已删除' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ===== 重置用户密码（仅超级管理员）=====
router.put('/users/:id/password', superAdminOnly, async (req, res) => {
  try {
    const targetId = parseInt(req.params.id);
    const { new_password } = req.body;

    if (!new_password || new_password.length < 6) {
      return res.json({ code: 400, message: '密码至少6位' });
    }

    // 不能重置自己的密码（请用修改密码功能）
    if (targetId === req.user.id) {
      return res.json({ code: 400, message: '请使用个人设置修改自己的密码' });
    }

    const [target] = await pool.execute('SELECT id FROM users WHERE id = ?', [targetId]);
    if (target.length === 0) {
      return res.json({ code: 404, message: '用户不存在' });
    }

    const bcrypt = require('bcryptjs');
    const hashedPassword = await bcrypt.hash(new_password, 10);
    await pool.execute('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, targetId]);
    res.json({ code: 200, message: '密码已重置' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ===== 点歌管理（需要 songs:review 权限）=====

// 获取点歌列表
router.get('/songs', requirePermission('songs:review'), async (req, res) => {
  try {
    const { page = 1, limit = 20, status, slot_id, keyword } = req.query;
    const offset = (page - 1) * limit;

    let whereClause = 'sr.deleted_at IS NULL';
    const params = [];
    if (status) {
      whereClause += ' AND sr.status = ?';
      params.push(status);
    }
    if (slot_id) {
      whereClause += ' AND sr.slot_id = ?';
      params.push(slot_id);
    }
    if (keyword) {
      whereClause += ' AND (sr.song_name LIKE ? OR sr.artist LIKE ? OR u.nickname LIKE ? OR u.username LIKE ?)';
      const kw = '%' + keyword + '%';
      params.push(kw, kw, kw, kw);
    }

    const [songs] = await pool.execute(`
      SELECT sr.*, ts.name as slot_name, ts.start_time, ts.end_time, u.username, u.nickname,
             DATE_FORMAT(sd.play_date, '%Y-%m-%d') as play_date
      FROM song_requests sr
      JOIN time_slots ts ON sr.slot_id = ts.id
      LEFT JOIN slot_dates sd ON sr.slot_date_id = sd.id
      LEFT JOIN users u ON sr.user_id = u.id
      WHERE ${whereClause}
      ORDER BY sr.hot_score DESC, sr.created_at DESC
      LIMIT ? OFFSET ?
    `, [...params, parseInt(limit), parseInt(offset)]);

    const [countResult] = await pool.execute(`SELECT COUNT(*) as total FROM song_requests sr WHERE ${whereClause}`, params);

    res.json({
      code: 200,
      data: {
        songs,
        total: countResult[0].total,
        totalPages: Math.ceil(countResult[0].total / limit)
      }
    });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取单条点歌详情
router.get('/songs/:id', requirePermission('songs:view'), async (req, res) => {
  try {
    const [songs] = await pool.execute(`
      SELECT sr.*, ts.name as slot_name, ts.start_time, ts.end_time, u.username, u.nickname
      FROM song_requests sr
      JOIN time_slots ts ON sr.slot_id = ts.id
      LEFT JOIN users u ON sr.user_id = u.id
      WHERE sr.id = ?
    `, [req.params.id]);

    if (songs.length === 0) {
      return res.json({ code: 404, message: '点歌记录不存在' });
    }

    res.json({ code: 200, data: songs[0] });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 审核点歌
router.put('/songs/:id/status', requirePermission('songs:review'), async (req, res) => {
  try {
    const { status, play_order } = req.body;
    if (!['approved', 'rejected', 'played', 'pending'].includes(status)) {
      return res.json({ code: 400, message: '无效状态' });
    }
    await pool.execute('UPDATE song_requests SET status = ? WHERE id = ?', [status, req.params.id]);
    if (play_order !== undefined) {
      await pool.execute('UPDATE song_requests SET play_order = ? WHERE id = ?', [play_order, req.params.id]);
    }

    // 异步发送邮件通知点歌用户
    setImmediate(async () => {
      try {
        const [songs] = await pool.execute(`
          SELECT sr.song_name, sr.artist, sr.user_id, ts.name as slot_name, u.email, u.nickname, u.username 
          FROM song_requests sr 
          LEFT JOIN time_slots ts ON sr.slot_id = ts.id 
          LEFT JOIN users u ON sr.user_id = u.id 
          WHERE sr.id = ?
        `, [req.params.id]);
        
        if (songs.length > 0 && songs[0].email) {
          const song = songs[0];
          const userNickname = song.nickname || song.username || '用户';
          
          if (status === 'approved') {
            await notifySongApproved(song.email, userNickname, song.song_name || '未知', song.artist || '未知', song.slot_name || '未知时段', song.user_id);
          } else if (status === 'rejected') {
            await notifySongRejected(song.email, userNickname, song.song_name || '未知', song.artist || '未知', '', song.user_id);
          } else if (status === 'played') {
            await notifySongPlayed(song.email, userNickname, song.song_name || '未知', song.artist || '未知', song.user_id);
          }
        }
      } catch (err) {
        console.error('[Email] 发送点歌审核通知失败:', err.message);
      }
    });

    res.json({ code: 200, message: '操作成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 批量审核点歌
router.put('/songs/batch-status', requirePermission('songs:review'), async (req, res) => {
  try {
    const { ids, status } = req.body;
    if (!Array.isArray(ids) || ids.length === 0 || !['approved', 'rejected', 'pending'].includes(status)) {
      return res.json({ code: 400, message: '无效参数' });
    }
    const placeholders = ids.map(() => '?').join(',');
    await pool.execute(`UPDATE song_requests SET status = ? WHERE id IN (${placeholders})`, [status, ...ids]);
    res.json({ code: 200, message: `已批量${status === 'approved' ? '通过' : status === 'rejected' ? '拒绝' : '设为待审核'} ${ids.length} 条` });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 删除点歌（软删除到回收站）
router.delete('/songs/:id', requirePermission('songs:delete'), async (req, res) => {
  try {
    await pool.execute('UPDATE song_requests SET deleted_at = NOW() WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
    res.json({ code: 200, message: '已移入回收站' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取点歌回收站列表
router.get('/trash/songs', requirePermission('songs:delete'), async (req, res) => {
  try {
    const [songs] = await pool.execute(`
      SELECT sr.*, ts.name as slot_name, u.username, u.nickname
      FROM song_requests sr
      JOIN time_slots ts ON sr.slot_id = ts.id
      LEFT JOIN users u ON sr.user_id = u.id
      WHERE sr.deleted_at IS NOT NULL
      ORDER BY sr.deleted_at DESC
      LIMIT 50
    `);
    res.json({ code: 200, data: { songs } });
  } catch (err) {
    res.json({ code: 500, message: '失败: ' + err.message });
  }
});

// 永久删除点歌（回收站）
router.delete('/trash/songs/:id', requirePermission('songs:delete'), async (req, res) => {
  try {
    await pool.execute('DELETE FROM song_requests WHERE id = ?', [req.params.id]);
    res.json({ code: 200, message: '已永久删除' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 恢复点歌（从回收站恢复）
router.put('/trash/songs/:id/restore', requirePermission('songs:delete'), async (req, res) => {
  try {
    await pool.execute('UPDATE song_requests SET deleted_at = NULL WHERE id = ?', [req.params.id]);
    res.json({ code: 200, message: '已恢复' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ===== 时段管理（需要 slots:manage 权限）=====

// 获取时段列表（包含日期）
router.get('/slots', requirePermission('slots:manage'), async (req, res) => {
  try {
    const [slots] = await pool.execute('SELECT * FROM time_slots ORDER BY start_time');
    
    // 查询今天~14天后的日期
    const [allDates] = await pool.execute(
      'SELECT * FROM slot_dates WHERE play_date >= CURDATE() AND play_date < DATE_ADD(CURDATE(), INTERVAL 14 DAY) ORDER BY play_date'
    );
    
    const result = slots.map(slot => {
      // 根据 weekdays 过滤日期，并格式化日期
      let slotDates = allDates.filter(d => d.slot_id === slot.id).map(d => ({
        ...d,
        play_date: d.play_date instanceof Date 
          ? d.play_date.toISOString().split('T')[0] 
          : String(d.play_date).split('T')[0]
      }));
      if (slot.weekdays && slot.weekdays !== '') {
        const jsDays = slot.weekdays.split(',').map(d => parseInt(d));
        // 将 JS 星期值转换为 MySQL DAYOFWEEK 值
        const mysqlDays = jsDays.map(d => d + 1);
        // 只保留符合星期设置的日期
        slotDates = slotDates.filter(d => {
          const playDate = new Date(d.play_date);
          const dayOfWeek = playDate.getDay(); // JS: 0=周日, 1=周一...
          const mysqlDay = dayOfWeek + 1; // MySQL: 1=周日, 2=周一...
          return mysqlDays.includes(mysqlDay);
        });
      }
      
      const maxSongs = slotDates.length > 0 ? slotDates[slotDates.length - 1].max_songs : 10;
      return { ...slot, dates: slotDates, max_songs: maxSongs };
    });
    
    res.json({ code: 200, data: result });
  } catch (err) {
    console.error('[ERROR] 查询时段失败:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 创建时段
router.post('/slots', requirePermission('slots:manage'), async (req, res) => {
  try {
    const { name, start_time, end_time, is_active, weekdays } = req.body;
    if (!name || !start_time || !end_time) {
      return res.json({ code: 400, message: '请填写完整信息' });
    }
    const [result] = await pool.execute(
      'INSERT INTO time_slots (name, start_time, end_time, is_active, weekdays) VALUES (?, ?, ?, ?, ?)',
      [name, start_time, end_time, is_active !== undefined ? is_active : 1, weekdays || '']
    );

    // 根据 weekdays 设置自动添加未来 N 天的日期
    const slotId = result.insertId;
    const maxSongs = 10;
    const weekdayArr = weekdays ? weekdays.split(',').map(w => parseInt(w.trim())) : [];
    const addedDates = [];
    
    // 如果设置了weekdays，只添加匹配周几的日期
    if (weekdayArr.length > 0) {
      const daysToAdd = 7; // 添加7天
      for (let i = 1; i <= daysToAdd && addedDates.length < weekdayArr.length * 4; i++) {
        const d = new Date();
        d.setDate(d.getDate() + i);
        const dayOfWeek = d.getDay(); // 0=周日, 1=周一, ..., 6=周六
        if (weekdayArr.includes(dayOfWeek)) {
          const dateStr = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
          await pool.execute(
            'INSERT INTO slot_dates (slot_id, play_date, max_songs, is_active) VALUES (?, ?, ?, 1)',
            [slotId, dateStr, maxSongs]
          );
          addedDates.push(dateStr);
        }
      }
    }

    res.json({ code: 200, message: '创建成功', data: { id: slotId, addedDates } });
  } catch (err) {
    console.error('创建时段错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ===== 时段日期管理（必须放在 /slots/:id 之前）=====

// 添加时段日期
router.post('/slots/:slotId/dates', requirePermission('slots:manage'), async (req, res) => {
  try {
    const { play_date, max_songs } = req.body;
    if (!play_date) {
      return res.json({ code: 400, message: '请选择日期' });
    }
    await pool.execute(
      'INSERT INTO slot_dates (slot_id, play_date, max_songs, is_active) VALUES (?, ?, ?, 1) ON DUPLICATE KEY UPDATE max_songs = ?, is_active = 1',
      [req.params.slotId, play_date, max_songs || 10, max_songs || 10]
    );
    res.json({ code: 200, message: '添加成功' });
  } catch (err) {
    console.error('添加时段日期错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 批量添加时段日期
router.post('/slots/:slotId/dates/batch', requirePermission('slots:manage'), async (req, res) => {
  try {
    const { dates, max_songs } = req.body;
    if (!dates || !Array.isArray(dates) || dates.length === 0) {
      return res.json({ code: 400, message: '请选择日期' });
    }
    const maxSongs = max_songs || 10;
    for (const date of dates) {
      await pool.execute(
        'INSERT INTO slot_dates (slot_id, play_date, max_songs, is_active) VALUES (?, ?, ?, 1) ON DUPLICATE KEY UPDATE max_songs = ?, is_active = 1',
        [req.params.slotId, date, maxSongs, maxSongs]
      );
    }
    res.json({ code: 200, message: '批量添加成功' });
  } catch (err) {
    console.error('批量添加时段日期错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 删除时段日期
router.delete('/slots/:slotId/dates/:dateId', requirePermission('slots:manage'), async (req, res) => {
  try {
    await pool.execute('DELETE FROM slot_dates WHERE id = ? AND slot_id = ?', [req.params.dateId, req.params.slotId]);
    res.json({ code: 200, message: '删除成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 修改时段日期
router.put('/slots/:slotId/dates/:dateId', requirePermission('slots:manage'), async (req, res) => {
  try {
    const { max_songs, is_active } = req.body;
    const updates = [];
    const values = [];
    if (max_songs !== undefined) { updates.push('max_songs = ?'); values.push(max_songs); }
    if (is_active !== undefined) { updates.push('is_active = ?'); values.push(is_active); }
    if (updates.length === 0) {
      return res.json({ code: 400, message: '没有修改内容' });
    }
    values.push(req.params.dateId, req.params.slotId);
    await pool.execute(`UPDATE slot_dates SET ${updates.join(', ')} WHERE id = ? AND slot_id = ?`, values);
    res.json({ code: 200, message: '修改成功' });
  } catch (err) {
    console.error('修改时段日期错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 修改时段
router.put('/slots/:id', requirePermission('slots:manage'), async (req, res) => {
  try {
    const slotId = req.params.id;
    const body = req.body || {};
    const { name, start_time, end_time, is_active, weekdays, max_songs } = body;
    
    // 第一步：更新 time_slots 表（只更新核心字段，不包含 weekdays）
    const slotUpdates = [];
    const slotValues = [];
    if (name !== undefined) { slotUpdates.push('name = ?'); slotValues.push(name); }
    if (start_time !== undefined) { slotUpdates.push('start_time = ?'); slotValues.push(start_time); }
    if (end_time !== undefined) { slotUpdates.push('end_time = ?'); slotValues.push(end_time); }
    if (is_active !== undefined) { slotUpdates.push('is_active = ?'); slotValues.push(is_active); }
    if (weekdays !== undefined) { slotUpdates.push('weekdays = ?'); slotValues.push(weekdays); }

    if (slotUpdates.length > 0) {
      slotValues.push(slotId);
      await pool.execute(`UPDATE time_slots SET ${slotUpdates.join(', ')} WHERE id = ?`, slotValues);
    }

    // 第二步：如果传了 max_songs，更新 slot_dates 表（忽略错误）
    if (max_songs !== undefined) {
      try {
        await pool.execute('UPDATE slot_dates SET max_songs = ? WHERE slot_id = ?', [max_songs, slotId]);
      } catch (e) {
        // 忽略错误，可能是列或表不存在
      }
    }

    // 第三步：如果更新了 weekdays，自动删除不符合星期的日期，并补全缺失的日期
    let debugInfo = '';
    if (weekdays !== undefined) {
      debugInfo = `weekdays=${weekdays}`;
      console.log('[DEBUG] weekdays received:', weekdays, 'type:', typeof weekdays);
      try {
        if (weekdays && weekdays !== '') {
          // 将 JavaScript 星期值转换为 MySQL DAYOFWEEK 值
          // JS: 0=周日, 1=周一...6=周六
          // MySQL DAYOFWEEK(): 1=周日, 2=周一...7=周六
          const jsDays = weekdays.split(',').map(d => parseInt(d));
          const mysqlDays = jsDays.map(d => d + 1);
          const mysqlDaysStr = mysqlDays.join(',');
          debugInfo += ` jsDays=${jsDays} mysqlDays=${mysqlDaysStr}`;
          console.log('[DEBUG] jsDays:', jsDays, 'mysqlDays:', mysqlDays, 'mysqlDaysStr:', mysqlDaysStr);
          
          // 删除不符合星期设置的日期
          const sql = `DELETE FROM slot_dates WHERE slot_id = ? AND DAYOFWEEK(play_date) NOT IN (${mysqlDaysStr})`;
          debugInfo += ` sql="${sql}"`;
          console.log('[DEBUG] DELETE SQL:', sql, 'slotId:', slotId);
          const [result] = await pool.execute(sql, [slotId]);
          debugInfo += ` affected=${result.affectedRows}`;
          console.log('[DEBUG] DELETE affected rows:', result.affectedRows);
          
          // 补全缺失的日期：查找未来7天内符合weekday但不存在于slot_dates的日期
          const [existingDates] = await pool.execute(
            'SELECT play_date FROM slot_dates WHERE slot_id = ? AND play_date >= CURDATE() AND play_date < DATE_ADD(CURDATE(), INTERVAL 7 DAY)',
            [slotId]
          );
          const existingSet = new Set(existingDates.map(d => {
            const dt = d.play_date;
            if (dt instanceof Date) return dt.toISOString().split('T')[0];
            return String(dt).split('T')[0];
          }));
          let addedCount = 0;
          const maxSongsVal = max_songs || 10;
          const daysToCheck = 7;
          for (let i = 0; i <= daysToCheck; i++) {
            const d = new Date();
            d.setDate(d.getDate() + i);
            const dayOfWeek = d.getDay(); // 0=周日, 1=周一, ..., 6=周六
            if (jsDays.includes(dayOfWeek)) {
              const dateStr = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
              if (!existingSet.has(dateStr)) {
                await pool.execute(
                  'INSERT INTO slot_dates (slot_id, play_date, max_songs, is_active) VALUES (?, ?, ?, 1) ON DUPLICATE KEY UPDATE max_songs = ?',
                  [slotId, dateStr, maxSongsVal, maxSongsVal]
                );
                existingSet.add(dateStr);
                addedCount++;
              }
            }
          }
          debugInfo += ` added=${addedCount}`;
          console.log('[DEBUG] added missing dates:', addedCount);
        } else {
          // 如果 weekdays 为空，删除所有日期
          await pool.execute('DELETE FROM slot_dates WHERE slot_id = ?', [slotId]);
        }
      } catch (e) {
        debugInfo += ` error=${e.message}`;
        console.error('[DEBUG] weekdays delete error:', e.message);
      }
    }

    res.json({ code: 200, message: '修改成功', debug: debugInfo });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误: ' + err.message });
  }
});

// 删除时段
router.delete('/slots/:id', requirePermission('slots:manage'), async (req, res) => {
  try {
    await pool.execute('DELETE FROM time_slots WHERE id = ?', [req.params.id]);
    res.json({ code: 200, message: '删除成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ===== 操作日志 =====

// 获取操作日志
router.get('/logs', requirePermission('logs:view'), async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    const [logs] = await pool.execute(
      `SELECT al.*, u.username, u.nickname 
       FROM admin_logs al 
       LEFT JOIN users u ON al.admin_id = u.id 
       ORDER BY al.id DESC LIMIT ? OFFSET ?`,
      [parseInt(limit), parseInt(offset)]
    );

    const [countResult] = await pool.execute('SELECT COUNT(*) as total FROM admin_logs');

    res.json({
      code: 200,
      data: {
        logs,
        total: countResult[0].total,
        page: parseInt(page),
        totalPages: Math.ceil(countResult[0].total / limit)
      }
    });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 记录操作日志
router.post('/logs', async (req, res) => {
  try {
    const { action, detail, level = 'info' } = req.body;
    // 规范化level：将warn转换为warning
    const normalizedLevel = level === 'warn' ? 'warning' : level;
    await pool.execute(
      'INSERT INTO admin_logs (admin_id, action, detail, level) VALUES (?, ?, ?, ?)',
      [req.user.id, action, detail, normalizedLevel]
    );
    res.json({ code: 200, message: '记录成功' });
  } catch (err) {
    console.error('[Admin] 记录日志失败:', err.message);
    res.json({ code: 500, message: '服务器错误: ' + err.message });
  }
});

// 清空所有操作日志
router.delete('/logs/all', requirePermission('logs:view'), async (req, res) => {
  try {
    const [result] = await pool.execute('DELETE FROM admin_logs');
    res.json({ code: 200, message: '已清空所有日志', data: { deleted: result.affectedRows } });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 清空N天前的操作日志
router.delete('/logs/old', requirePermission('logs:view'), async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const daysNum = parseInt(days) || 30;
    const [result] = await pool.execute(
      'DELETE FROM admin_logs WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
      [daysNum]
    );
    res.json({ code: 200, message: `已删除 ${daysNum} 天前的日志`, data: { deleted: result.affectedRows } });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 删除单条操作日志
router.delete('/logs/:id', requirePermission('logs:view'), async (req, res) => {
  try {
    const logId = parseInt(req.params.id);
    if (isNaN(logId)) {
      return res.json({ code: 400, message: '无效的日志ID' });
    }
    const [result] = await pool.execute('DELETE FROM admin_logs WHERE id = ?', [logId]);
    if (result.affectedRows === 0) {
      return res.json({ code: 404, message: '日志不存在' });
    }
    res.json({ code: 200, message: '删除成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ===== 公告管理（需要 notices:manage 权限）=====

// 获取公告列表
router.get('/notices', requirePermission('notices:manage'), async (req, res) => {
  try {
    const [notices] = await pool.execute(
      'SELECT * FROM notices ORDER BY is_top DESC, created_at DESC'
    );
    res.json({ code: 200, data: { notices } });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 发布公告
router.post('/notices', requirePermission('notices:manage'), async (req, res) => {
  try {
    const { title, content, is_top = false } = req.body;
    await pool.execute(
      'INSERT INTO notices (admin_id, title, content, is_top) VALUES (?, ?, ?, ?)',
      [req.user.id, title, content, is_top]
    );
    res.json({ code: 200, message: '发布成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 更新公告
router.put('/notices/:id', requirePermission('notices:manage'), async (req, res) => {
  try {
    const { title, content, is_top } = req.body;
    const top = is_top ? 1 : 0;
    await pool.execute(
      'UPDATE notices SET title = ?, content = ?, is_top = ? WHERE id = ?',
      [title, content, top, req.params.id]
    );
    res.json({ code: 200, message: '更新成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 删除公告
router.delete('/notices/:id', requirePermission('notices:manage'), async (req, res) => {
  try {
    await pool.execute('DELETE FROM notices WHERE id = ?', [req.params.id]);
    res.json({ code: 200, message: '删除成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ===== 系统设置（需要 settings:view 权限）=====

// 获取系统设置
router.get('/settings', requirePermission('settings:view'), async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT config_key, config_value FROM settings');
    const settings = {};
    rows.forEach(row => {
      settings[row.config_key] = row.config_value;
    });
    res.json({
      code: 200,
      data: {
        site_name: settings.site_name || '',
        site_description: settings.site_description || '',
        allow_register: settings.allow_register === 'true',
        post_review: settings.post_review === 'true',
        song_enabled: settings.song_enabled === 'true',
        daily_song_limit: parseInt(settings.daily_song_limit) || 3,
        anon_post: settings.anon_post === 'true',
        anon_comment: settings.anon_comment === 'true',
        anon_song: settings.anon_song === 'true',
        email_enabled: settings.email_enabled === 'true',
        smtp_host: settings.smtp_host || '',
        smtp_port: settings.smtp_port || '587',
        smtp_user: settings.smtp_user || '',
        smtp_pass: settings.smtp_pass || '',
        smtp_from: settings.smtp_from || '',
        special_mode_520: settings.special_mode_520 === 'true'
      }
    });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 保存系统设置
router.put('/settings', requirePermission('settings:view'), async (req, res) => {
  try {
    const { site_name, site_description, allow_register, post_review, song_enabled, daily_song_limit, anon_post, anon_comment, anon_song, email_enabled, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from, special_mode_520 } = req.body;
    console.log('[DEBUG] 保存设置请求:', req.body);

    const keys = [
      ['site_name', site_name || ''],
      ['site_description', site_description || ''],
      ['allow_register', allow_register !== undefined ? String(Boolean(allow_register)) : 'true'],
      ['post_review', post_review !== undefined ? String(Boolean(post_review)) : 'false'],
      ['song_enabled', song_enabled !== undefined ? String(Boolean(song_enabled)) : 'true'],
      ['daily_song_limit', daily_song_limit !== undefined ? String(Math.max(1, parseInt(daily_song_limit) || 3)) : '3'],
      ['anon_post', anon_post !== undefined ? String(Boolean(anon_post)) : 'true'],
      ['anon_comment', anon_comment !== undefined ? String(Boolean(anon_comment)) : 'true'],
      ['anon_song', req.body.anon_song !== undefined ? String(Boolean(req.body.anon_song)) : 'true'],
      ['email_enabled', email_enabled !== undefined ? String(Boolean(email_enabled)) : 'false'],
      ['smtp_host', smtp_host || ''],
      ['smtp_port', smtp_port || '587'],
      ['smtp_user', smtp_user || ''],
      ['smtp_pass', smtp_pass || ''],
      ['smtp_from', smtp_from || ''],
      ['special_mode_520', special_mode_520 !== undefined ? String(Boolean(special_mode_520)) : 'false']
    ];
    
    for (const [key, value] of keys) {
      console.log('[DEBUG] 保存配置项:', key, '=', value);
      try {
        const [result] = await pool.execute(
          'INSERT INTO settings (config_key, config_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE config_value = ?',
          [key, value, value]
        );
        console.log('[DEBUG] 保存结果:', result);
      } catch (dbErr) {
        console.error('[ERROR] 保存配置项失败:', key, dbErr);
      }
    }
    
    res.json({ code: 200, message: '保存成功' });
  } catch (err) {
    console.error('[ERROR] 保存设置失败:', err);
    res.json({ code: 500, message: '服务器错误: ' + err.message });
  }
});

// 测试邮件发送
router.post('/test-email', requirePermission('settings:view'), async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.json({ code: 400, message: '请提供测试邮箱地址' });
    }
    const { sendEmail } = require('../services/email');
    const success = await sendEmail(email, '🧪 测试邮件 · 嘉二の墙墙', `
      <div style="text-align:center;padding:20px;font-family:sans-serif;">
        <div style="font-size:48px;margin-bottom:16px;">✉️</div>
        <h2 style="color:#FF6B9D;">邮件配置正确！</h2>
        <p style="color:#4A3F5C;font-size:15px;line-height:1.7;">🎉 恭喜，你的SMTP配置已经生效啦~<br>以后用户就能收到评论、点赞、关注等邮件通知了 ✨</p>
        <div style="margin-top:20px;padding:16px;background:#F8F5FF;border-radius:12px;font-size:13px;color:#B8A9D4;">💌 嘉二の墙墙 — 让每一份心意都被看见</div>
      </div>
    `);
    if (success) {
      res.json({ code: 200, message: '测试邮件发送成功' });
    } else {
      res.json({ code: 500, message: '邮件发送失败，请检查SMTP配置' });
    }
  } catch (err) {
    console.error('[Email] 测试邮件发送失败:', err);
    res.json({ code: 500, message: '邮件发送失败: ' + err.message });
  }
});

// ===== 反馈管理 =====

// 创建反馈表（如果不存在）
router.get('/init-feedback-table', requirePermission('feedbacks:manage'), async (req, res) => {
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS feedbacks (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT,
        type VARCHAR(50) NOT NULL COMMENT '反馈类型：suggest/bug/complaint/other',
        title VARCHAR(200) NOT NULL COMMENT '反馈标题',
        content TEXT NOT NULL COMMENT '反馈内容',
        contact VARCHAR(200) COMMENT '联系方式',
        status VARCHAR(20) DEFAULT 'pending' COMMENT '状态：pending/processing/resolved/closed',
        reply TEXT COMMENT '管理员回复',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_user_id (user_id),
        INDEX idx_status (status),
        INDEX idx_created_at (created_at)
      )
    `);
    res.json({ code: 200, message: '反馈表创建成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取反馈列表
router.get('/feedbacks', requirePermission('feedbacks:manage'), async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const offset = (page - 1) * limit;

    let whereClause = '1=1';
    const params = [];
    if (status) {
      whereClause += ' AND f.status = ?';
      params.push(status);
    }

    const [feedbacks] = await pool.execute(`
      SELECT f.*, u.username, u.nickname
      FROM feedbacks f
      LEFT JOIN users u ON f.user_id = u.id
      WHERE ${whereClause}
      ORDER BY f.created_at DESC
      LIMIT ? OFFSET ?
    `, [...params, parseInt(limit), parseInt(offset)]);

    const [countResult] = await pool.execute(`SELECT COUNT(*) as total FROM feedbacks f WHERE ${whereClause}`, params);

    res.json({
      code: 200,
      data: {
        feedbacks,
        total: countResult[0].total,
        totalPages: Math.ceil(countResult[0].total / limit)
      }
    });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取单条反馈详情
router.get('/feedbacks/:id', requirePermission('feedbacks:manage'), async (req, res) => {
  try {
    const [feedbacks] = await pool.execute(`
      SELECT f.*, u.username, u.nickname
      FROM feedbacks f
      LEFT JOIN users u ON f.user_id = u.id
      WHERE f.id = ?
    `, [req.params.id]);

    if (feedbacks.length === 0) {
      return res.json({ code: 404, message: '反馈不存在' });
    }

    res.json({ code: 200, data: feedbacks[0] });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 回复反馈
router.put('/feedbacks/:id/reply', requirePermission('feedbacks:manage'), async (req, res) => {
  try {
    const { reply, status } = req.body;
    await pool.execute('UPDATE feedbacks SET reply = ?, status = ? WHERE id = ?', [reply, status || 'resolved', req.params.id]);
    
    // 异步发送邮件通知用户
    setImmediate(async () => {
      try {
        const [feedbacks] = await pool.execute(`
          SELECT f.*, u.email, u.nickname, u.username 
          FROM feedbacks f
          LEFT JOIN users u ON f.user_id = u.id
          WHERE f.id = ?
        `, [req.params.id]);
        
        if (feedbacks.length > 0 && feedbacks[0].email) {
          const feedback = feedbacks[0];
          const userNickname = feedback.nickname || feedback.username || '用户';
          const { notifyFeedbackReply } = require('../services/email');
          await notifyFeedbackReply(
            feedback.email,
            userNickname,
            feedback.title,
            reply || '管理员已处理您的反馈',
            feedback.user_id
          );
        }
      } catch (err) {
        console.error('[Email] 发送反馈回复通知失败:', err.message);
      }
    });
    
    res.json({ code: 200, message: '回复成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 删除反馈
router.delete('/feedbacks/:id', requirePermission('feedbacks:manage'), async (req, res) => {
  try {
    await pool.execute('DELETE FROM feedbacks WHERE id = ?', [req.params.id]);
    res.json({ code: 200, message: '删除成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ===== 通知管理 =====

// 创建通知表（如果不存在）
router.get('/init-notifications-table', requirePermission('notices:manage'), async (req, res) => {
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
    res.json({ code: 200, message: '通知表创建成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取所有通知（后台管理）
router.get('/notifications', requirePermission('notices:manage'), async (req, res) => {
  try {
    const { page = 1, limit = 20, user_id, type } = req.query;
    const offset = (page - 1) * limit;
    
    let whereClause = '1=1';
    const params = [];
    
    if (user_id) {
      whereClause += ' AND n.user_id = ?';
      params.push(user_id);
    }
    if (type) {
      whereClause += ' AND n.type = ?';
      params.push(type);
    }
    
    const [notifications] = await pool.execute(`
      SELECT n.*, u.username, u.nickname
      FROM notifications n
      LEFT JOIN users u ON n.user_id = u.id
      WHERE ${whereClause}
      ORDER BY n.created_at DESC
      LIMIT ? OFFSET ?
    `, [...params, parseInt(limit), parseInt(offset)]);
    
    const [countResult] = await pool.execute(`
      SELECT COUNT(*) as total FROM notifications n WHERE ${whereClause}
    `, params);
    
    res.json({
      code: 200,
      data: {
        notifications,
        total: countResult[0].total,
        totalPages: Math.ceil(countResult[0].total / limit)
      }
    });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 发送系统通知（后台管理）
router.post('/notifications/send', requirePermission('notices:manage'), async (req, res) => {
  try {
    const { user_id, type, title, content, related_id, related_type } = req.body;
    
    if (!user_id || !title) {
      return res.json({ code: 400, message: '用户ID和标题不能为空' });
    }
    
    await pool.execute(
      'INSERT INTO notifications (user_id, type, title, content, related_id, related_type) VALUES (?, ?, ?, ?, ?, ?)',
      [user_id, type || 'system', title, content || '', related_id || null, related_type || null]
    );
    
    res.json({ code: 200, message: '通知发送成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 批量发送系统通知
router.post('/notifications/send-batch', requirePermission('notices:manage'), async (req, res) => {
  try {
    const { user_ids, type, title, content, related_id, related_type } = req.body;
    
    if (!user_ids || !Array.isArray(user_ids) || user_ids.length === 0 || !title) {
      return res.json({ code: 400, message: '用户ID列表和标题不能为空' });
    }
    
    // 批量插入（参数化查询）
    for (var ni = 0; ni < user_ids.length; ni++) {
      await pool.execute(
        'INSERT INTO notifications (user_id, type, title, content, related_id, related_type) VALUES (?, ?, ?, ?, ?, ?)',
        [user_ids[ni], type || 'system', title, content || '', related_id || null, related_type || null]
      );
    }
    
    res.json({ code: 200, message: `成功发送${user_ids.length}条通知` });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 删除通知
router.delete('/notifications/:id', requirePermission('notices:manage'), async (req, res) => {
  try {
    await pool.execute('DELETE FROM notifications WHERE id = ?', [req.params.id]);
    res.json({ code: 200, message: '删除成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 清空所有通知
router.delete('/notifications', requirePermission('notices:manage'), async (req, res) => {
  try {
    await pool.execute('DELETE FROM notifications');
    res.json({ code: 200, message: '已清空所有通知' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取帖子浏览记录（超级管理员专用）
router.get('/post-views', requirePermission('posts:view'), async (req, res) => {
  try {
    const { page = 1, limit = 20, post_id, keyword } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    
    let whereClause = '1=1';
    const params = [];
    
    if (post_id) {
      whereClause += ' AND pv.post_id = ?';
      params.push(parseInt(post_id));
    }
    
    if (keyword) {
      whereClause += ' AND (p.title LIKE ? OR p.content LIKE ?)';
      params.push('%' + keyword.trim() + '%', '%' + keyword.trim() + '%');
    }
    
    const [records] = await pool.execute(`
      SELECT pv.id, pv.post_id, pv.user_id, pv.viewer_ip, pv.ip_region, pv.viewer_nickname, pv.viewed_at,
             p.title as post_title, p.content as post_content,
             u.email as user_email
      FROM post_views pv
      LEFT JOIN posts p ON pv.post_id = p.id
      LEFT JOIN users u ON pv.user_id = u.id
      WHERE ${whereClause}
      ORDER BY pv.viewed_at DESC
      LIMIT ? OFFSET ?
    `, [...params, parseInt(limit), offset]);
    
    const [countResult] = await pool.execute(`
      SELECT COUNT(*) as total FROM post_views pv
      LEFT JOIN posts p ON pv.post_id = p.id
      WHERE ${whereClause}
    `, params);
    
    res.json({
      code: 200,
      data: {
        records: records,
        total: countResult[0].total,
        page: parseInt(page),
        totalPages: Math.ceil(countResult[0].total / parseInt(limit))
      }
    });
  } catch (err) {
    console.error('获取浏览记录错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 清空N天前的浏览记录
router.delete('/post-views/old', requirePermission('posts:view'), async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const daysNum = parseInt(days) || 30;
    const [result] = await pool.execute(
      'DELETE FROM post_views WHERE viewed_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
      [daysNum]
    );
    res.json({ code: 200, message: '清空成功', data: { deleted: result.affectedRows } });
  } catch (err) {
    console.error('清空浏览记录错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ===== 头衔管理（仅超级管理员）=====

// 获取头衔列表
router.get('/titles', superAdminOnly, async (req, res) => {
  try {
    const [titles] = await pool.execute('SELECT * FROM user_titles ORDER BY sort_order DESC, id ASC');
    res.json({ code: 200, data: titles });
  } catch (err) {
    console.error('获取头衔列表错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 添加头衔
router.post('/titles', superAdminOnly, async (req, res) => {
  try {
    const { title_name, title_color, title_bg, icon, sort_order } = req.body;
    if (!title_name || !title_name.trim()) {
      return res.json({ code: 400, message: '头衔名称不能为空' });
    }
    const [result] = await pool.execute(
      'INSERT INTO user_titles (title_name, title_color, title_bg, icon, sort_order) VALUES (?, ?, ?, ?, ?)',
      [title_name.trim(), title_color || '#FF6B9D', title_bg || 'rgba(255,107,157,0.1)', icon || '⭐', sort_order || 0]
    );
    res.json({ code: 200, message: '添加成功', data: { id: result.insertId } });
  } catch (err) {
    console.error('添加头衔错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 编辑头衔
router.put('/titles/:id', superAdminOnly, async (req, res) => {
  try {
    const { title_name, title_color, title_bg, icon, sort_order } = req.body;
    const titleId = parseInt(req.params.id);
    if (!title_name || !title_name.trim()) {
      return res.json({ code: 400, message: '头衔名称不能为空' });
    }
    await pool.execute(
      'UPDATE user_titles SET title_name = ?, title_color = ?, title_bg = ?, icon = ?, sort_order = ? WHERE id = ?',
      [title_name.trim(), title_color || '#FF6B9D', title_bg || 'rgba(255,107,157,0.1)', icon || '⭐', sort_order || 0, titleId]
    );
    res.json({ code: 200, message: '修改成功' });
  } catch (err) {
    console.error('编辑头衔错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 删除头衔
router.delete('/titles/:id', superAdminOnly, async (req, res) => {
  try {
    const titleId = parseInt(req.params.id);
    const [result] = await pool.execute('DELETE FROM user_titles WHERE id = ?', [titleId]);
    if (result.affectedRows === 0) {
      return res.json({ code: 404, message: '头衔不存在' });
    }
    res.json({ code: 200, message: '删除成功' });
  } catch (err) {
    console.error('删除头衔错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取用户的头衔
router.get('/users/:id/titles', superAdminOnly, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const [titles] = await pool.execute(`
      SELECT t.* FROM user_titles t
      JOIN user_title_relations r ON t.id = r.title_id
      WHERE r.user_id = ?
      ORDER BY t.sort_order DESC, t.id ASC
    `, [userId]);
    res.json({ code: 200, data: titles });
  } catch (err) {
    console.error('获取用户头衔错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 给用户添加头衔
router.post('/users/:id/titles', superAdminOnly, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const { title_id } = req.body;
    if (!title_id) {
      return res.json({ code: 400, message: '请选择头衔' });
    }
    // 检查用户是否存在
    const [user] = await pool.execute('SELECT id FROM users WHERE id = ?', [userId]);
    if (user.length === 0) {
      return res.json({ code: 404, message: '用户不存在' });
    }
    // 检查头衔是否存在
    const [title] = await pool.execute('SELECT id FROM user_titles WHERE id = ?', [title_id]);
    if (title.length === 0) {
      return res.json({ code: 404, message: '头衔不存在' });
    }
    await pool.execute('INSERT IGNORE INTO user_title_relations (user_id, title_id) VALUES (?, ?)', [userId, title_id]);
    res.json({ code: 200, message: '添加成功' });
  } catch (err) {
    console.error('添加用户头衔错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 移除用户的头衔
router.delete('/users/:userId/titles/:titleId', superAdminOnly, async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const titleId = parseInt(req.params.titleId);
    await pool.execute('DELETE FROM user_title_relations WHERE user_id = ? AND title_id = ?', [userId, titleId]);
    res.json({ code: 200, message: '移除成功' });
  } catch (err) {
    console.error('移除用户头衔错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 清空所有浏览记录
router.delete('/post-views/all', requirePermission('posts:view'), async (req, res) => {
  try {
    const [result] = await pool.execute('DELETE FROM post_views');
    res.json({ code: 200, message: '已清空所有浏览记录', data: { deleted: result.affectedRows } });
  } catch (err) {
    console.error('清空浏览记录错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取用户的公开资料（用于弹窗展示）
router.get('/users/:id/profile', requirePermission('users:view'), async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const [users] = await pool.execute(`
      SELECT id, username, nickname, avatar, email, role, status, created_at 
      FROM users WHERE id = ?
    `, [userId]);
    
    if (users.length === 0) {
      return res.json({ code: 404, message: '用户不存在' });
    }
    
    const user = users[0];
    
    // 获取用户发帖统计
    let postCount = 0;
    try {
      const [posts] = await pool.execute('SELECT COUNT(*) as total FROM posts WHERE user_id = ?', [userId]);
      postCount = posts[0].total;
    } catch (e) {
      // 忽略错误
    }
    user.post_count = postCount;
    
    // 获取用户浏览统计
    let viewCount = 0;
    try {
      const [views] = await pool.execute('SELECT COUNT(*) as total FROM post_views WHERE user_id = ?', [userId]);
      viewCount = views[0].total;
    } catch (e) {
      // 忽略错误
    }
    user.view_count = viewCount;
    
    res.json({ code: 200, data: user });
  } catch (err) {
    console.error('获取用户资料错误:', err.message);
    res.json({ code: 500, message: '服务器错误: ' + err.message });
  }
});

// ===== 邮件群发 =====

// 获取收件人数量
router.get('/email/recipients', requirePermission('notices:manage'), async (req, res) => {
  try {
    const { type = 'all' } = req.query;
    console.log('[邮件群发] 收到type:', type);
    let whereClause = '1=1';
    
    if (type === 'active') {
      whereClause += ' AND last_login_at > DATE_SUB(NOW(), INTERVAL 30 DAY)';
    } else if (type === 'role_user') {
      whereClause += ' AND role = "user"';
    } else if (type === 'role_reviewer') {
      whereClause += ' AND role = "reviewer"';
    } else if (type === 'role_radio_admin') {
      whereClause += ' AND role = "radio_admin"';
    } else if (type === 'role_admin') {
      whereClause += ' AND role = "admin"';
    } else if (type === 'role_super_admin') {
      whereClause += ' AND role = "super_admin"';
    }
    
    // 显示真实人数，发送时会自动过滤无邮箱的用户
    const [countResult] = await pool.execute(
      `SELECT COUNT(*) as total FROM users WHERE ${whereClause}`
    );
    // 同时返回有邮箱的真实可发送数
    const [emailCount] = await pool.execute(
      `SELECT COUNT(*) as total FROM users WHERE ${whereClause} AND email IS NOT NULL AND email != ""`
    );
    console.log('[邮件群发] 总数:', countResult[0].total, '有邮箱:', emailCount[0].total);
    
    res.json({ code: 200, data: { count: countResult[0].total, emailCount: emailCount[0].total } });
  } catch (err) {
    console.error('获取收件人数量错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 发送邮件群发
router.post('/email/send-batch', requirePermission('notices:manage'), async (req, res) => {
  try {
    const { subject, content, link, recipientType = 'all' } = req.body;
    
    if (!subject || !content) {
      return res.json({ code: 400, message: '标题和内容不能为空' });
    }
    
    // 获取收件人列表
    let whereClause = 'email IS NOT NULL AND email != ""';
    if (recipientType === 'active') {
      whereClause += ' AND last_login_at > DATE_SUB(NOW(), INTERVAL 30 DAY)';
    } else if (recipientType === 'role_user') {
      whereClause += ' AND role = "user"';
    } else if (recipientType === 'role_reviewer') {
      whereClause += ' AND role = "reviewer"';
    } else if (recipientType === 'role_radio_admin') {
      whereClause += ' AND role = "radio_admin"';
    } else if (recipientType === 'role_admin') {
      whereClause += ' AND role = "admin"';
    } else if (recipientType === 'role_super_admin') {
      whereClause += ' AND role = "super_admin"';
    }
    
    const [users] = await pool.execute(
      `SELECT id, email, nickname, username FROM users WHERE ${whereClause}`
    );
    
    if (users.length === 0) {
      return res.json({ code: 400, message: '没有符合条件的收件人' });
    }
    
    // 导入邮件服务
    const { sendEmail } = require('../services/email');
    const siteUrl = process.env.SITE_URL || 'https://wall.jay23.cn';
    
    // 生成卡哇伊风格邮件HTML
    const emailHtml = `
      <p style="font-size:15px;color:#4A3F5C;margin:0 0 16px;line-height:1.8;">
        亲爱的同学：
      </p>
      <div style="font-size:14px;color:#4A3F5C;line-height:1.8;white-space:pre-wrap;">${content}</div>
      <p style="font-size:14px;color:#B8A9D4;margin:16px 0 0;"> 来自 嘉二の墙墙 的温馨提醒</p>
    `;
    
    // 使用kawaiiLayout包装
    const { kawaiiLayout } = require('../services/email');
    const fullHtml = kawaiiLayout(subject, emailHtml, link || siteUrl);
    
    // 记录发送历史
    await pool.execute(
      'INSERT INTO email_batch_history (admin_id, subject, content, recipient_type, total_count, status) VALUES (?, ?, ?, ?, ?, ?)',
      [req.user.id, subject, content, recipientType, users.length, 'sending']
    );
    const [historyResult] = await pool.execute('SELECT LAST_INSERT_ID() as id');
    const historyId = historyResult[0].id;
    
    // 异步发送邮件
    let successCount = 0;
    let failCount = 0;
    const logs = [];
    
    for (let i = 0; i < users.length; i++) {
      const user = users[i];
      const userEmail = user.email;
      try {
        const success = await sendEmail(userEmail, subject, fullHtml);
        if (success) {
          successCount++;
          logs.push({ email: userEmail, status: 'success' });
        } else {
          failCount++;
          logs.push({ email: userEmail, status: 'fail' });
        }
      } catch (err) {
        failCount++;
        logs.push({ email: userEmail, status: 'fail', error: err.message });
      }
      
      // 每10封更新一次进度
      if ((i + 1) % 10 === 0 || i === users.length - 1) {
        await pool.execute(
          'UPDATE email_batch_history SET sent_count = ?, fail_count = ?, logs = ? WHERE id = ?',
          [successCount, failCount, JSON.stringify(logs), historyId]
        );
      }
    }
    
    // 更新最终状态
    const finalStatus = failCount === 0 ? 'success' : (successCount > 0 ? 'partial' : 'fail');
    await pool.execute(
      'UPDATE email_batch_history SET status = ?, sent_count = ?, fail_count = ?, logs = ?, finished_at = NOW() WHERE id = ?',
      [finalStatus, successCount, failCount, JSON.stringify(logs), historyId]
    );
    
    res.json({ 
      code: 200, 
      message: '发送完成',
      data: { 
        historyId,
        total: users.length,
        success: successCount,
        fail: failCount,
        status: finalStatus
      }
    });
  } catch (err) {
    console.error('邮件群发错误:', err);
    res.json({ code: 500, message: '服务器错误: ' + err.message });
  }
});

// 获取发送历史
router.get('/email/history', requirePermission('notices:manage'), async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    
    const [history] = await pool.execute(
      `SELECT h.*, u.nickname as admin_nickname 
       FROM email_batch_history h
       LEFT JOIN users u ON h.admin_id = u.id
       ORDER BY h.created_at DESC
       LIMIT ? OFFSET ?`,
      [parseInt(limit), parseInt(offset)]
    );
    
    const [countResult] = await pool.execute('SELECT COUNT(*) as total FROM email_batch_history');
    
    res.json({
      code: 200,
      data: {
        history,
        total: countResult[0].total,
        totalPages: Math.ceil(countResult[0].total / limit)
      }
    });
  } catch (err) {
    console.error('获取发送历史错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ===== 微信测试 =====
// 获取已绑定微信的用户列表
router.get('/wechat/users', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT DISTINCT u.id, u.username, u.nickname, u.role, u.openid, ' +
      'MAX(wb.bound_at) as bound_at ' +
      'FROM users u ' +
      'LEFT JOIN wechat_bindings wb ON u.id = wb.user_id AND wb.used = 1 ' +
      'WHERE u.openid IS NOT NULL ' +
      'GROUP BY u.id ' +
      'ORDER BY bound_at DESC'
    );
    res.json({ code: 200, data: rows });
  } catch (err) {
    console.error('[Admin] 获取微信用户失败:', err.message);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 测试消息推送（订阅号仅能验证连接，不能主动发消息）
router.post('/wechat/test-message', async (req, res) => {
  try {
    var { openid, user_id } = req.body;
    if (!openid) {
      return res.json({ code: 400, message: '缺少openid' });
    }

    // 测试获取AccessToken
    var wechatService = require('../services/wechat');
    var token;
    try {
      token = await wechatService.getAccessToken();
    } catch (e) {
      return res.json({ code: 500, message: '获取AccessToken失败: ' + e.message + '，请检查WECHAT_SECRET配置' });
    }

    // 尝试调用客服消息接口（订阅号不支持主动推送，返回错误正常）
    var postData = JSON.stringify({
      touser: openid,
      msgtype: 'text',
      text: {
        content: '🔔 嘉二の墙墙 - 测试消息'
      }
    });

    var result = await new Promise((resolve, reject) => {
      var https = require('https');
      var url = 'https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=' + token;
      var urlObj = new URL(url);
      var options = {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
      };
      var reqHttps = https.request(options, function(response) {
        var body = '';
        response.on('data', function(chunk) { body += chunk; });
        response.on('end', function() {
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(e); }
        });
      });
      reqHttps.on('error', reject);
      reqHttps.write(postData);
      reqHttps.end();
    });

    if (result && result.errcode === 0) {
      console.log('[Admin] 测试消息推送成功:', openid);
      res.json({ code: 200, message: '✅ 消息推送成功！' });
    } else {
      // 订阅号主动推送会失败，但能拿到token和openid就是配置成功了
      var errMsg = result?.errmsg || '';
      if (errMsg.indexOf('unauthorized') !== -1) {
        res.json({
          code: 200,
          message: '✅ AccessToken获取成功，openid: ' + openid + '\n（订阅号不支持主动推送消息，需用户在公众号发消息后48小时内才能回复）'
        });
      } else {
        res.json({ code: 500, message: '发送失败: ' + errMsg });
      }
    }
  } catch (err) {
    console.error('[Admin] 测试消息推送错误:', err.message);
    res.json({ code: 500, message: '服务器错误: ' + err.message });
  }
});

// ===== 自动发布设置 =====
var AUTO_PUBLISH_CFG = require('path').join(__dirname, '..', 'config', 'auto-publish.json');

function readPubCfg() {
  try { var d = JSON.parse(require('fs').readFileSync(AUTO_PUBLISH_CFG, 'utf8')); return { hour: d.hour || 8, minute: d.minute || 0, enabled: d.enabled !== false, lastRun: d.lastRun || '', include_gaokao: d.include_gaokao !== false }; }
  catch(e) { return { hour: 8, minute: 0, enabled: true, lastRun: '', include_gaokao: true }; }
}

function writePubCfg(hour, minute, enabled, lastRun, includeGaokao) {
  var cfg = readPubCfg();
  if (hour !== undefined) cfg.hour = hour;
  if (minute !== undefined) cfg.minute = minute;
  if (enabled !== undefined) cfg.enabled = enabled;
  if (lastRun !== undefined) cfg.lastRun = lastRun;
  if (includeGaokao !== undefined) cfg.include_gaokao = includeGaokao;
  require('fs').writeFileSync(AUTO_PUBLISH_CFG, JSON.stringify(cfg), 'utf8');
}

// 获取自动发布配置
router.get('/auto-publish-config', (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'super_admin') return res.json({ code: 403, message: '权限不足' });
  res.json({ code: 200, data: readPubCfg() });
});

// 更新自动发布配置
router.post('/auto-publish-config', (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'super_admin') return res.json({ code: 403, message: '权限不足' });
  var hour = parseInt(req.body.hour);
  var minute = parseInt(req.body.minute);
  var enabled = req.body.enabled !== false;
  var includeGaokao = req.body.include_gaokao !== false;
  if (isNaN(hour) || hour < 0 || hour > 23) return res.json({ code: 400, message: '小时范围0-23' });
  if (isNaN(minute) || minute < 0 || minute > 59) return res.json({ code: 400, message: '分钟范围0-59' });
  writePubCfg(hour, minute, enabled, undefined, includeGaokao);
  res.json({ code: 200, message: enabled ? '已设置每天 ' + String(hour).padStart(2,'0') + ':' + String(minute).padStart(2,'0') + ' 自动发布' : '已关闭自动发布' });
});

// 手动触发立即发布
router.post('/trigger-auto-publish', async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'super_admin') return res.json({ code: 403, message: '权限不足' });
  try {
    var{execSync}=require('child_process');
    var out = execSync('/usr/bin/node ' + require('path').join(__dirname, '..', 'auto-publish.js') + ' 2>&1', { timeout: 60000, cwd: require('path').join(__dirname, '..') });
    var lastRun = new Date().toLocaleString('zh-CN');
    writePubCfg(undefined, undefined, undefined, lastRun);
    res.json({ code: 200, data: { output: out.toString().trim() }, message: '✅ 发布完成！上次执行: ' + lastRun });
  } catch (err) {
    res.json({ code: 500, message: '发布失败: ' + err.message });
  }
});

// 获取发布日志
router.get('/auto-publish-logs', (req, res) => {
  try {
    var logPath = require('path').join(__dirname, '..', 'logs', 'auto-publish.log');
    if (require('fs').existsSync(logPath)) {
      var logs = require('fs').readFileSync(logPath, 'utf8').split('\n').filter(Boolean).slice(-20);
      res.json({ code: 200, data: { logs: logs } });
    } else {
      res.json({ code: 200, data: { logs: [] } });
    }
  } catch(e) {
    res.json({ code: 200, data: { logs: [] } });
  }
});

// 清空所有发布日志
router.delete('/auto-publish-logs/all', (req, res) => {
  try {
    var logPath = require('path').join(__dirname, '..', 'logs', 'auto-publish.log');
    if (require('fs').existsSync(logPath)) {
      require('fs').writeFileSync(logPath, '', 'utf8');
    }
    res.json({ code: 200, message: '已清空所有日志' });
  } catch(e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 删除单条发布日志（必须放在 /all 之后，否则会被 :index 匹配到）
router.delete('/auto-publish-logs/:index', (req, res) => {
  try {
    var logPath = require('path').join(__dirname, '..', 'logs', 'auto-publish.log');
    if (!require('fs').existsSync(logPath)) {
      return res.json({ code: 200, message: '日志文件不存在' });
    }
    var logs = require('fs').readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
    var index = parseInt(req.params.index);
    if (isNaN(index) || index < 0 || index >= logs.length) {
      return res.json({ code: 400, message: '无效的日志索引' });
    }
    logs.splice(index, 1);
    require('fs').writeFileSync(logPath, logs.join('\n') + (logs.length > 0 ? '\n' : ''), 'utf8');
    res.json({ code: 200, message: '删除成功' });
  } catch(e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ===== 获取邮件发送日志 =====
router.get('/email-logs', async (req, res) => {
  try {
    var page = parseInt(req.query.page) || 1;
    var ps = Math.min(parseInt(req.query.pageSize) || 30, 100);
    var off = (page - 1) * ps;
    await pool.execute("CREATE TABLE IF NOT EXISTS email_logs (id INT AUTO_INCREMENT PRIMARY KEY,to_email VARCHAR(255) NOT NULL,subject VARCHAR(500) NOT NULL,type VARCHAR(50) DEFAULT '',content_preview VARCHAR(500) DEFAULT '',status ENUM('success','fail') DEFAULT 'success',error_msg VARCHAR(500) DEFAULT '',target_user_name VARCHAR(100) DEFAULT '',created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,INDEX idx_created (created_at)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    var [rows] = await pool.execute("SELECT id,to_email,subject,type,content_preview,status,error_msg,target_user_name,created_at FROM email_logs ORDER BY created_at DESC LIMIT ? OFFSET ?", [ps, off]);
    var [cnt] = await pool.execute("SELECT COUNT(*) as t FROM email_logs");
    res.json({ code: 200, data: { logs: rows, total: cnt[0].t, page: page, pageSize: ps } });
  } catch(e) { res.json({ code: 200, data: { logs: [], total: 0 } }); }
});

// 清空N天前的邮件记录
router.delete('/email-logs/old', async (req, res) => {
  try {
    var days = parseInt(req.query.days) || 30;
    var [result] = await pool.execute(
      'DELETE FROM email_logs WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
      [days]
    );
    res.json({ code: 200, message: '已删除 ' + days + ' 天前的邮件记录', data: { deleted: result.affectedRows } });
  } catch(e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 清空所有邮件记录
router.delete('/email-logs/all', async (req, res) => {
  try {
    var [result] = await pool.execute('DELETE FROM email_logs');
    res.json({ code: 200, message: '已清空所有邮件记录', data: { deleted: result.affectedRows } });
  } catch(e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 删除单条邮件记录（必须放在 /all 和 /old 之后，否则会被 :id 匹配到）
router.delete('/email-logs/:id', async (req, res) => {
  try {
    var logId = parseInt(req.params.id);
    if (isNaN(logId)) {
      return res.json({ code: 400, message: '无效的日志ID' });
    }
    var [result] = await pool.execute('DELETE FROM email_logs WHERE id = ?', [logId]);
    if (result.affectedRows === 0) {
      return res.json({ code: 404, message: '日志不存在' });
    }
    res.json({ code: 200, message: '删除成功' });
  } catch(e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ===== 超级管理员一键登录用户账号 =====
router.post('/login-as-user', superAdminOnly, async (req, res) => {
  try {
    var userId = parseInt(req.body.user_id);
    if (!userId) return res.json({ code: 400, message: '请提供用户ID' });
    var [users] = await pool.execute('SELECT id, username, nickname, role, avatar FROM users WHERE id = ?', [userId]);
    if (users.length === 0) return res.json({ code: 404, message: '用户不存在' });
    var user = users[0];
    var token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      code: 200,
      data: {
        token: token,
        user: {
          id: user.id,
          username: user.username,
          nickname: user.nickname,
          role: user.role,
          avatar: user.avatar
        }
      },
      message: '✅ 已登录到 ' + (user.nickname || user.username) + ' 的账号'
    });
  } catch (err) {
    console.error('[Admin] 登录用户账号失败:', err.message);
    res.json({ code: 500, message: '失败: ' + err.message });
  }
});

// ===== 私信管理（管理员可见所有消息） =====
// 获取所有会话列表（含清空状态，已清空的会话不显示）
router.get('/messages', auth, async (req, res) => {
  try {
    const [convs] = await pool.execute(`
      SELECT c.id, c.user1_id, c.user2_id, c.user1_dnd, c.user2_dnd,
        c.user1_cleared_at, c.user2_cleared_at, c.last_message_at, c.created_at,
        u1.nickname as u1_name, u1.username as u1_username,
        u2.nickname as u2_name, u2.username as u2_username,
        (SELECT content FROM messages WHERE conversation_id = c.id AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1) as last_msg,
        (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) as total_msgs,
        (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id AND deleted_at IS NOT NULL) as deleted_msgs
      FROM conversations c
      LEFT JOIN users u1 ON u1.id = c.user1_id
      LEFT JOIN users u2 ON u2.id = c.user2_id
      WHERE c.id IS NOT NULL
      ORDER BY c.last_message_at DESC
    `);
    res.json({ code: 200, data: { conversations: convs } });
  } catch (err) {
    console.error('[Admin] 获取消息列表失败:', err.message);
    res.status(500).json({ code: 500, message: '失败: ' + err.message });
  }
});

// 获取某个会话的所有消息（包括用户已清空的、软删除的）
router.get('/messages/:id/messages', auth, async (req, res) => {
  try {
    const convId = parseInt(req.params.id);
    const [msgs] = await pool.execute(`
      SELECT m.*, u.nickname as sender_name, u.username as sender_username
      FROM messages m
      LEFT JOIN users u ON u.id = m.sender_id
      WHERE m.conversation_id = ?
      ORDER BY m.created_at ASC
    `, [convId]);
    const [conv] = await pool.execute(`
      SELECT c.*, u1.nickname as u1_name, u2.nickname as u2_name
      FROM conversations c
      LEFT JOIN users u1 ON u1.id = c.user1_id
      LEFT JOIN users u2 ON u2.id = c.user2_id
      WHERE c.id = ?
    `, [convId]);
    res.json({ code: 200, data: { conversation: conv[0] || null, messages: msgs } });
  } catch (err) {
    console.error('[Admin] 获取会话消息失败:', err.message);
    res.status(500).json({ code: 500, message: '失败: ' + err.message });
  }
});

// 永久删除单条消息
router.delete('/messages/:id', auth, async (req, res) => {
  try {
    await pool.execute('DELETE FROM messages WHERE id = ?', [parseInt(req.params.id)]);
    res.json({ code: 200, message: '消息已永久删除' });
  } catch (err) {
    res.status(500).json({ code: 500, message: '失败: ' + err.message });
  }
});

// 清空某个会话（永久删除所有消息+会话本身）
router.post('/conversations/:id/purge', auth, async (req, res) => {
  try {
    await pool.execute('DELETE FROM messages WHERE conversation_id = ?', [parseInt(req.params.id)]);
    await pool.execute('DELETE FROM conversations WHERE id = ?', [parseInt(req.params.id)]);
    res.json({ code: 200, message: '会话及消息已全部永久删除' });
  } catch (err) {
    res.status(500).json({ code: 500, message: '失败: ' + err.message });
  }
});

// ===== 小说管理（支持多本小说） =====
// 存储结构：
//   config/novels.json          - 小说列表
//   config/auto-publish.json    - 其中包含 activeNovelId + 每本小说的配置
//   config/stories/{novelId}/   - 每本小说的章节文件
const fs_stories = require('fs');
const path_stories = require('path');
const STORIES_BASE = path_stories.join(__dirname, '..', 'config', 'stories');
const NOVELS_PATH = path_stories.join(__dirname, '..', 'config', 'novels.json');

if (!fs_stories.existsSync(STORIES_BASE)) {
  fs_stories.mkdirSync(STORIES_BASE, { recursive: true });
}

// ===== 小说管理 =====

function novelsGetList() {
  if (fs_stories.existsSync(NOVELS_PATH)) {
    return JSON.parse(fs_stories.readFileSync(NOVELS_PATH, 'utf8'));
  }
  // 自动迁移：从旧单本小说结构创建默认小说
  var list = [];
  var oldIndexPath = path_stories.join(STORIES_BASE, 'index.json');
  if (fs_stories.existsSync(oldIndexPath)) {
    try {
      var oldIndex = JSON.parse(fs_stories.readFileSync(oldIndexPath, 'utf8'));
      if (Array.isArray(oldIndex) && oldIndex.length > 0) {
        // 已有章节，创建默认小说
        list.push({ id: 'default', title: '致那个夏天的你', author: '嘉二校园墙编辑部', desc: '校园青春小说', createdAt: new Date().toISOString().substring(0, 10) });
        // 把文件从 config/stories/ 移到 config/stories/default/
        var novelDir = path_stories.join(STORIES_BASE, 'default');
        if (!fs_stories.existsSync(novelDir)) fs_stories.mkdirSync(novelDir, { recursive: true });
        fs_stories.renameSync(oldIndexPath, path_stories.join(novelDir, 'index.json'));
        oldIndex.forEach(function(entry) {
          var src = path_stories.join(STORIES_BASE, entry.file);
          if (fs_stories.existsSync(src)) {
            fs_stories.renameSync(src, path_stories.join(novelDir, entry.file));
          }
        });
        // 更新 auto-publish.json
        var autoPubPath = path_stories.join(__dirname, '..', 'config', 'auto-publish.json');
        if (fs_stories.existsSync(autoPubPath)) {
          try {
            var pubConfig = JSON.parse(fs_stories.readFileSync(autoPubPath, 'utf8'));
            pubConfig.activeNovelId = 'default';
            if (!pubConfig.novels) pubConfig.novels = {};
            pubConfig.novels['default'] = {
              currentStoryIndex: pubConfig.currentStoryIndex || 0,
              promptConfig: pubConfig.promptConfig || {}
            };
            delete pubConfig.currentStoryIndex;
            delete pubConfig.promptConfig;
            fs_stories.writeFileSync(autoPubPath, JSON.stringify(pubConfig, null, 2), 'utf8');
          } catch(e) {}
        }
        console.log('[小说] 旧单本结构已自动迁移为多小说结构');
      }
    } catch(e) { console.warn('[小说] 自动迁移失败:', e.message); }
  }
  if (list.length === 0) {
    // 全新安装，创建默认小说
    list.push({ id: 'default', title: '致那个夏天的你', author: '嘉二校园墙编辑部', desc: '校园青春小说', createdAt: new Date().toISOString().substring(0, 10) });
  }
  fs_stories.writeFileSync(NOVELS_PATH, JSON.stringify(list, null, 2), 'utf8');
  return list;
}

function novelsSaveList(list) {
  fs_stories.writeFileSync(NOVELS_PATH, JSON.stringify(list, null, 2), 'utf8');
}

function novelsGetById(id) {
  var list = novelsGetList();
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === id) return list[i];
  }
  return null;
}

function getNovelDir(novelId) {
  return path_stories.join(STORIES_BASE, novelId || 'default');
}

function getNovelPubConfig(pubConfig, novelId) {
  novelId = novelId || pubConfig.activeNovelId || 'default';
  if (!pubConfig.novels) pubConfig.novels = {};
  if (!pubConfig.novels[novelId]) {
    pubConfig.novels[novelId] = { currentStoryIndex: 0, promptConfig: {} };
  }
  return {
    novels: pubConfig.novels,
    currentStoryIndex: pubConfig.novels[novelId].currentStoryIndex || 0,
    promptConfig: pubConfig.novels[novelId].promptConfig || {}
  };
}

function saveNovelPubConfig(pubConfig, novelId, data) {
  novelId = novelId || pubConfig.activeNovelId || 'default';
  if (!pubConfig.novels) pubConfig.novels = {};
  if (!pubConfig.novels[novelId]) pubConfig.novels[novelId] = {};
  if (data.currentStoryIndex !== undefined) pubConfig.novels[novelId].currentStoryIndex = data.currentStoryIndex;
  if (data.promptConfig !== undefined) pubConfig.novels[novelId].promptConfig = data.promptConfig;
  var autoPubPath = path_stories.join(__dirname, '..', 'config', 'auto-publish.json');
  fs_stories.writeFileSync(autoPubPath, JSON.stringify(pubConfig, null, 2), 'utf8');
}

function loadPubConfig() {
  var autoPubPath = path_stories.join(__dirname, '..', 'config', 'auto-publish.json');
  if (fs_stories.existsSync(autoPubPath)) {
    try { return JSON.parse(fs_stories.readFileSync(autoPubPath, 'utf8')); } catch(e) {}
  }
  return { hour: 8, minute: 0, enabled: true, activeNovelId: 'default', novels: {} };
}

// ===== 章节存储辅助函数（支持多小说） =====

function storiesGetIndex(novelId) {
  var dir = getNovelDir(novelId);
  var p = path_stories.join(dir, 'index.json');
  if (fs_stories.existsSync(p)) return JSON.parse(fs_stories.readFileSync(p, 'utf8'));
  // 兼容：当 novelId 为 default 时，检查老位置 config/stories/index.json
  if (!novelId || novelId === 'default') {
    var oldDir = path_stories.join(__dirname, '..', 'config', 'stories');
    var oldP = path_stories.join(oldDir, 'index.json');
    if (fs_stories.existsSync(oldP)) {
      try {
        var oldIndex = JSON.parse(fs_stories.readFileSync(oldP, 'utf8'));
        if (Array.isArray(oldIndex) && oldIndex.length > 0) {
          if (!fs_stories.existsSync(dir)) fs_stories.mkdirSync(dir, { recursive: true });
          // 搬 index
          fs_stories.renameSync(oldP, p);
          // 搬章节文件
          oldIndex.forEach(function(entry) {
            var src = path_stories.join(oldDir, entry.file);
            if (fs_stories.existsSync(src)) {
              fs_stories.renameSync(src, path_stories.join(dir, entry.file));
            }
          });
          console.log('[故事] 从 config/stories/ 迁移到 ' + dir + '，共' + oldIndex.length + '章');
          return JSON.parse(fs_stories.readFileSync(p, 'utf8'));
        }
      } catch(e) { console.warn('[故事] 迁移 config/stories/ 失败:', e.message); }
    }
  }
  // 兼容旧格式：config/stories.json（更古老的格式）
  var oldPath = path_stories.join(__dirname, '..', 'config', 'stories.json');
  if (fs_stories.existsSync(oldPath)) {
    try {
      var oldStories = JSON.parse(fs_stories.readFileSync(oldPath, 'utf8'));
      if (Array.isArray(oldStories) && oldStories.length > 0) {
        if (!fs_stories.existsSync(dir)) fs_stories.mkdirSync(dir, { recursive: true });
        var idx = [];
        oldStories.forEach(function(s, i) {
          var chapFile = i + '.json';
          fs_stories.writeFileSync(path_stories.join(dir, chapFile), JSON.stringify({ title: s.title, content: s.content, author: s.author || '嘉二校园墙编辑部' }, null, 2), 'utf8');
          idx.push({ file: chapFile, title: s.title, author: s.author || '嘉二校园墙编辑部', published: false });
        });
        fs_stories.writeFileSync(p, JSON.stringify(idx, null, 2), 'utf8');
        fs_stories.renameSync(oldPath, oldPath + '.bak');
        console.log('[故事] 旧格式已自动迁移，共' + idx.length + '章');
        return idx;
      }
    } catch(e) { console.warn('[故事] 迁移旧格式失败:', e.message); }
  }
  return [];
}

function storiesSaveIndex(index, novelId) {
  var dir = getNovelDir(novelId);
  if (!fs_stories.existsSync(dir)) fs_stories.mkdirSync(dir, { recursive: true });
  fs_stories.writeFileSync(path_stories.join(dir, 'index.json'), JSON.stringify(index, null, 2), 'utf8');
}

function storiesGetChapter(idx, novelId) {
  var index = storiesGetIndex(novelId);
  var dir = getNovelDir(novelId);
  if (idx >= 0 && idx < index.length) {
    var chapPath = path_stories.join(dir, index[idx].file);
    if (fs_stories.existsSync(chapPath)) return JSON.parse(fs_stories.readFileSync(chapPath, 'utf8'));
  }
  return null;
}

function storiesSaveChapter(idx, data, novelId) {
  var index = storiesGetIndex(novelId);
  var dir = getNovelDir(novelId);
  if (idx >= 0 && idx < index.length) {
    fs_stories.writeFileSync(path_stories.join(dir, index[idx].file), JSON.stringify({ title: data.title, content: data.content, author: data.author }, null, 2), 'utf8');
    index[idx].title = data.title;
    index[idx].author = data.author || '嘉二校园墙编辑部';
    if (index[idx].published === undefined) index[idx].published = false;
    storiesSaveIndex(index, novelId);
  }
}

function storiesAddChapter(title, content, author, novelId) {
  var index = storiesGetIndex(novelId);
  var dir = getNovelDir(novelId);
  if (!fs_stories.existsSync(dir)) fs_stories.mkdirSync(dir, { recursive: true });
  var nextFile = index.length + '.json';
  fs_stories.writeFileSync(path_stories.join(dir, nextFile), JSON.stringify({ title: title, content: content || '', author: author || '嘉二校园墙编辑部' }, null, 2), 'utf8');
  index.push({ file: nextFile, title: title, author: author || '嘉二校园墙编辑部', published: false });
  storiesSaveIndex(index, novelId);
  return index.length - 1;
}

function storiesDeleteChapter(idx, novelId) {
  var index = storiesGetIndex(novelId);
  var dir = getNovelDir(novelId);
  if (idx >= 0 && idx < index.length) {
    try { fs_stories.unlinkSync(path_stories.join(dir, index[idx].file)); } catch(e) {}
    index.splice(idx, 1);
    storiesSaveIndex(index, novelId);
  }
  return index;
}

// ===== 小说 CRUD 路由 =====

// 获取小说列表
router.get('/novels', auth, async (req, res) => {
  try {
    var list = novelsGetList();
    var pubConfig = loadPubConfig();
    res.json({ code: 200, data: { novels: list, activeNovelId: pubConfig.activeNovelId || 'default' } });
  } catch (err) {
    res.json({ code: 500, message: err.message });
  }
});

// 创建新小说
router.post('/novels/create', auth, async (req, res) => {
  try {
    var { title, author, desc } = req.body;
    if (!title) return res.json({ code: 400, message: '小说标题不能为空' });
    var list = novelsGetList();
    var id = 'novel_' + Date.now();
    list.push({ id: id, title: title, author: author || '嘉二校园墙编辑部', desc: desc || '', createdAt: new Date().toISOString().substring(0, 10) });
    novelsSaveList(list);
    // 初始化该小说的目录和配置
    var dir = getNovelDir(id);
    if (!fs_stories.existsSync(dir)) fs_stories.mkdirSync(dir, { recursive: true });
    var pubConfig = loadPubConfig();
    if (!pubConfig.novels) pubConfig.novels = {};
    pubConfig.novels[id] = { currentStoryIndex: 0, promptConfig: { novelTitle: title } };
    fs_stories.writeFileSync(path_stories.join(__dirname, '..', 'config', 'auto-publish.json'), JSON.stringify(pubConfig, null, 2), 'utf8');
    res.json({ code: 200, data: { id: id }, message: '小说「' + title + '」创建成功' });
  } catch (err) {
    res.json({ code: 500, message: err.message });
  }
});

// 删除小说
router.post('/novels/delete', auth, async (req, res) => {
  try {
    var { novelId } = req.body;
    var list = novelsGetList();
    var idx = -1;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === novelId) { idx = i; break; }
    }
    if (idx < 0) return res.json({ code: 400, message: '小说不存在' });
    if (list.length <= 1) return res.json({ code: 400, message: '至少保留一本小说' });
    // 删除章节目录
    var dir = getNovelDir(novelId);
    try {
      var chapIdx = JSON.parse(fs_stories.readFileSync(path_stories.join(dir, 'index.json'), 'utf8') || '[]');
      chapIdx.forEach(function(entry) {
        try { fs_stories.unlinkSync(path_stories.join(dir, entry.file)); } catch(e) {}
      });
      try { fs_stories.unlinkSync(path_stories.join(dir, 'index.json')); } catch(e) {}
      try { fs_stories.rmdirSync(dir); } catch(e) {}
    } catch(e) {}
    list.splice(idx, 1);
    novelsSaveList(list);
    // 清理配置
    var pubConfig = loadPubConfig();
    if (pubConfig.novels && pubConfig.novels[novelId]) {
      delete pubConfig.novels[novelId];
    }
    if (pubConfig.activeNovelId === novelId) {
      pubConfig.activeNovelId = list[0].id;
    }
    fs_stories.writeFileSync(path_stories.join(__dirname, '..', 'config', 'auto-publish.json'), JSON.stringify(pubConfig, null, 2), 'utf8');
    res.json({ code: 200, message: '已删除' });
  } catch (err) {
    res.json({ code: 500, message: err.message });
  }
});

// 设置当前活跃小说
router.post('/novels/set-active', auth, async (req, res) => {
  try {
    var { novelId } = req.body;
    var novel = novelsGetById(novelId);
    if (!novel) return res.json({ code: 400, message: '小说不存在' });
    var pubConfig = loadPubConfig();
    pubConfig.activeNovelId = novelId;
    fs_stories.writeFileSync(path_stories.join(__dirname, '..', 'config', 'auto-publish.json'), JSON.stringify(pubConfig, null, 2), 'utf8');
    res.json({ code: 200, message: '已切换到「' + novel.title + '」' });
  } catch (err) {
    res.json({ code: 500, message: err.message });
  }
});

// ===== 章节路由（支持多小说，通过 query 或 body 传递 novelId）=====

function getNovelId(req) {
  return req.query.novelId || req.body.novelId || '';
}

// 获取所有章节（不含内容）和配置信息
router.get('/stories', auth, async (req, res) => {
  try {
    var novelId = getNovelId(req) || loadPubConfig().activeNovelId || 'default';
    var index = storiesGetIndex(novelId);
    var pubConfig = loadPubConfig();
    var novelCfg = getNovelPubConfig(pubConfig, novelId);
    res.json({
      code: 200,
      data: {
        stories: index,
        currentIndex: novelCfg.currentStoryIndex || 0,
        totalChapters: index.length,
        promptConfig: novelCfg.promptConfig || {}
      }
    });
  } catch (err) {
    res.json({ code: 500, message: err.message });
  }
});

// 获取单章内容
router.get('/stories/chapter-content', auth, async (req, res) => {
  try {
    var novelId = getNovelId(req) || loadPubConfig().activeNovelId || 'default';
    var idx = parseInt(req.query.index);
    var chapter = storiesGetChapter(idx, novelId);
    if (chapter) {
      res.json({ code: 200, data: chapter });
    } else {
      res.json({ code: 404, message: '章节不存在' });
    }
  } catch (err) {
    res.json({ code: 500, message: err.message });
  }
});

// 保存章节
router.post('/stories/save', auth, async (req, res) => {
  try {
    var { index, title, content, author, novelId } = req.body;
    novelId = novelId || loadPubConfig().activeNovelId || 'default';
    storiesSaveChapter(index, { title: title, content: content, author: author }, novelId);
    res.json({ code: 200, message: '保存成功' });
  } catch (err) {
    res.json({ code: 500, message: err.message });
  }
});

// 添加新章节
router.post('/stories/add', auth, async (req, res) => {
  try {
    var { title, content, author, novelId } = req.body;
    novelId = novelId || loadPubConfig().activeNovelId || 'default';
    var newIdx = storiesAddChapter(title || '新章节', content, author, novelId);
    res.json({ code: 200, message: '添加成功', data: { index: newIdx } });
  } catch (err) {
    res.json({ code: 500, message: err.message });
  }
});

// 删除章节
router.post('/stories/delete', auth, async (req, res) => {
  try {
    var { index, novelId } = req.body;
    novelId = novelId || loadPubConfig().activeNovelId || 'default';
    var pubConfig = loadPubConfig();
    var novelCfg = getNovelPubConfig(pubConfig, novelId);
    var resultIndex = storiesDeleteChapter(index, novelId);
    // 如果删除的是当前或之前的章节，调整索引
    if (novelCfg.currentStoryIndex >= index && novelCfg.currentStoryIndex > 0) {
      novelCfg.currentStoryIndex = novelCfg.currentStoryIndex - 1;
      if (novelCfg.currentStoryIndex >= resultIndex.length) novelCfg.currentStoryIndex = 0;
      saveNovelPubConfig(pubConfig, novelId, { currentStoryIndex: novelCfg.currentStoryIndex });
    }
    res.json({ code: 200, message: '删除成功', data: { stories: resultIndex, currentIndex: novelCfg.currentStoryIndex || 0 } });
  } catch (err) {
    res.json({ code: 500, message: err.message });
  }
});

// 设置当前连载章节索引
router.post('/stories/set-current', auth, async (req, res) => {
  try {
    var { index, novelId } = req.body;
    novelId = novelId || loadPubConfig().activeNovelId || 'default';
    var pubConfig = loadPubConfig();
    saveNovelPubConfig(pubConfig, novelId, { currentStoryIndex: index });
    res.json({ code: 200, message: '已设置为第' + (index + 1) + '章' });
  } catch (err) {
    res.json({ code: 500, message: err.message });
  }
});

// 保存提示词模板配置
router.post('/stories/save-prompt-config', auth, async (req, res) => {
  try {
    var { promptConfig, novelId } = req.body;
    novelId = novelId || loadPubConfig().activeNovelId || 'default';
    var pubConfig = loadPubConfig();
    saveNovelPubConfig(pubConfig, novelId, { promptConfig: promptConfig });
    res.json({ code: 200, message: '提示词模板已保存' });
  } catch (err) {
    res.json({ code: 500, message: err.message });
  }
});

// 获取下一个 DeepSeek 提示词
router.get('/stories/next-prompt', auth, async (req, res) => {
  try {
    var novelId = getNovelId(req) || loadPubConfig().activeNovelId || 'default';
    var index = storiesGetIndex(novelId);
    var pubConfig = loadPubConfig();
    var novelCfg = getNovelPubConfig(pubConfig, novelId);
    var cfg = novelCfg.promptConfig || {};
    var nextChapNum = index.length + 1;
    
    // 构建已有章节梗概
    var summaryLines = [];
    for (var si = 0; si < index.length; si++) {
      var chap = storiesGetChapter(si, novelId);
      var contentPreview = chap ? (chap.content || '').replace(/[\n\r]+/g, ' ').substring(0, 80) : '';
      summaryLines.push((si + 1) + '. ' + (index[si].title || '') + '：' + contentPreview + '...');
    }
    var chapterSummary = summaryLines.join('\n');
    
    var novelTitle = cfg.novelTitle || (novelsGetById(novelId) ? novelsGetById(novelId).title : '致那个夏天的你');
    var promptLines = [
      cfg.authorRole || '你是一位校园青春小说作家。',
      '',
      '请写一篇校园青春小说的第' + nextChapNum + '章，继续以下故事：',
      '小说标题：' + novelTitle,
      '',
      '已有章节梗概：'
    ];
    promptLines.push(chapterSummary);
    promptLines.push('');
    promptLines.push('');
    promptLines.push('第' + nextChapNum + '章要求：');
    promptLines.push('- 字数：' + (cfg.wordCount || '800-1200字'));
    promptLines.push('- 风格：' + (cfg.style || '温暖治愈，校园青春'));
    promptLines.push('- ' + (cfg.sceneRequirement || '需要出现1-2个新的校园场景'));
    promptLines.push('- ' + (cfg.endingRequirement || '在章节末尾留下悬念或期待'));
    promptLines.push('- ' + (cfg.titleFormat || '标题自拟（格式如"第X章 标题"）'));
    promptLines.push('- ' + (cfg.dialogueFormat || '注意：章节内容使用中文引号「」或""表示对话'));
    if (cfg.extraRequirements) {
      promptLines.push('- ' + cfg.extraRequirements);
    }
    promptLines.push('');
    promptLines.push(cfg.outputInstruction || '请直接输出章节内容，不要额外说明。');
    
    res.json({ code: 200, data: { prompt: promptLines.join('\n'), nextChapterNum: nextChapNum } });
  } catch (err) {
    res.json({ code: 500, message: err.message });
  }
});

// ===== AI 自动生成章节 =====
router.post('/stories/generate-chapter', auth, async (req, res) => {
  try {
    var novelId = getNovelId(req) || loadPubConfig().activeNovelId || 'default';
    var index = storiesGetIndex(novelId);
    var pubConfig = loadPubConfig();
    var novelCfg = getNovelPubConfig(pubConfig, novelId);
    var cfg = novelCfg.promptConfig || {};
    var nextChapNum = index.length + 1;

    // 构建已有章节梗概
    var summaryLines = [];
    for (var si = 0; si < index.length; si++) {
      var chap = storiesGetChapter(si, novelId);
      var contentPreview = chap ? (chap.content || '').replace(/[\n\r]+/g, ' ').substring(0, 150) : '';
      summaryLines.push('第' + (si + 1) + '章《' + (index[si].title || '') + '》：' + contentPreview + '...');
    }
    var chapterSummary = summaryLines.join('\n');

    var novelTitle = cfg.novelTitle || (novelsGetById(novelId) ? novelsGetById(novelId).title : '致那个夏天的你');
    var aiPrompt = '';
    aiPrompt += '你是一位校园青春小说作家，擅长描写青春期细腻的情感变化，文字清新自然，有画面感。\n\n';
    aiPrompt += '请写一篇校园青春小说的第' + nextChapNum + '章。\n';
    aiPrompt += '小说标题：' + novelTitle + '\n\n';
    if (chapterSummary) {
      aiPrompt += '已有章节梗概：\n' + chapterSummary + '\n\n';
    }
    aiPrompt += '第' + nextChapNum + '章要求：\n';
    aiPrompt += '- 字数：' + (cfg.wordCount || '800-1200字') + '\n';
    aiPrompt += '- 风格：' + (cfg.style || '温暖治愈，校园青春') + '\n';
    aiPrompt += '- ' + (cfg.sceneRequirement || '需要出现1-2个新的校园场景') + '\n';
    aiPrompt += '- ' + (cfg.endingRequirement || '在章节末尾留下悬念或期待') + '\n';
    aiPrompt += '- 标题自拟\n';
    aiPrompt += '- 请注意使用中文引号「」或""表示对话\n';
    if (cfg.extraRequirements) {
      aiPrompt += '- ' + cfg.extraRequirements + '\n';
    }
    aiPrompt += '\n请直接输出章节内容，不要额外说明，不要输出思考过程。';

    var generatedContent = await aiService.generateChapter(aiPrompt);
    if (!generatedContent || generatedContent.length < 50) {
      return res.json({ code: 500, message: '生成内容过短，请重试' });
    }

    var lines = generatedContent.split('\n');
    var aiTitle = '';
    var aiContent = generatedContent;
    
    if (lines.length > 0) {
      var firstLine = lines[0].replace(/^#+\s*/, '').replace(/^第\d+章[：\s]*/, '').trim();
      if (firstLine.length > 0 && firstLine.length < 30) {
        aiTitle = firstLine;
        aiContent = lines.slice(1).join('\n').trim();
      }
    }
    if (!aiTitle) aiTitle = '第' + nextChapNum + '章';

    res.json({
      code: 200,
      data: {
        title: aiTitle,
        content: aiContent,
        chapterNum: nextChapNum
      }
    });
  } catch (err) {
    res.json({ code: 500, message: 'AI生成失败: ' + err.message });
  }
});

// ===== AI 流式生成章节（SSE） =====
router.get('/stories/generate-chapter-stream', async (req, res) => {
  try {
    var token = req.query.token;
    if (!token) return res.status(401).end();
    var decoded;
    try { decoded = jwt.verify(token, JWT_SECRET); } catch(e) { return res.status(401).end(); }

    var novelId = req.query.novelId || loadPubConfig().activeNovelId || getNovelId(req) || 'default';
    var index = storiesGetIndex(novelId);
    var pubConfig = loadPubConfig();
    var novelCfg = getNovelPubConfig(pubConfig, novelId);
    var cfg = novelCfg.promptConfig || {};
    var nextChapNum = index.length + 1;

    var summaryLines = [];
    for (var si = 0; si < index.length; si++) {
      var chap = storiesGetChapter(si, novelId);
      var contentPreview = chap ? (chap.content || '').replace(/[\n\r]+/g, ' ').substring(0, 150) : '';
      summaryLines.push('第' + (si + 1) + '章《' + (index[si].title || '') + '》：' + contentPreview + '...');
    }
    var chapterSummary = summaryLines.join('\n');
    var novelTitle = cfg.novelTitle || (novelsGetById(novelId) ? novelsGetById(novelId).title : '致那个夏天的你');

    var aiPrompt = '';
    aiPrompt += '你是一位校园青春小说作家，擅长描写青春期细腻的情感变化，文字清新自然，有画面感。\n\n';
    aiPrompt += '请写一篇校园青春小说的第' + nextChapNum + '章。\n';
    aiPrompt += '小说标题：' + novelTitle + '\n\n';
    if (chapterSummary) {
      aiPrompt += '已有章节梗概：\n' + chapterSummary + '\n\n';
    }
    aiPrompt += '第' + nextChapNum + '章要求：\n';
    aiPrompt += '- 字数：' + (cfg.wordCount || '800-1200字') + '\n';
    aiPrompt += '- 风格：' + (cfg.style || '温暖治愈，校园青春') + '\n';
    aiPrompt += '- ' + (cfg.sceneRequirement || '需要出现1-2个新的校园场景') + '\n';
    aiPrompt += '- ' + (cfg.endingRequirement || '在章节末尾留下悬念或期待') + '\n';
    aiPrompt += '- 标题自拟\n';
    aiPrompt += '- 请注意使用中文引号「」或""表示对话\n';
    if (cfg.extraRequirements) {
      aiPrompt += '- ' + cfg.extraRequirements + '\n';
    }
    aiPrompt += '\n请直接输出章节内容，不要额外说明，不要输出思考过程。';

    // SSE 头
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });

    var fullText = '';

    var aiService = require('../services/ai');
    var pingTimer = setInterval(function() { res.write(': ping\n\n'); }, 25000);
    await aiService.generateChapterStream(aiPrompt, function(token) {
      fullText += token;
      // 发送 token（避免换行破坏 SSE）
      var safe = token.replace(/\n/g, '\\n').replace(/\r/g, '');
      res.write('data: ' + safe + '\n\n');
    });
    clearInterval(pingTimer);

    // 生成完毕
    var lines = fullText.split('\n');
    var aiTitle = '';
    var aiContent = fullText;
    if (lines.length > 0) {
      var firstLine = lines[0].replace(/^#+\s*/, '').replace(/^第\d+章[：\s]*/, '').trim();
      if (firstLine.length > 0 && firstLine.length < 30) {
        aiTitle = firstLine;
        aiContent = lines.slice(1).join('\n').trim();
      }
    }
    if (!aiTitle) aiTitle = '第' + nextChapNum + '章';

    // 发送完成事件
    res.write('event: done\ndata: ' + JSON.stringify({ title: aiTitle, content: aiContent, chapterNum: nextChapNum }) + '\n\n');
    res.end();
  } catch (err) {
    console.error('[SSE] 生成错误:', err.message);
    if (!res.headersSent) {
      res.writeHead(500);
    }
    res.write('event: error\ndata: ' + err.message + '\n\n');
    res.end();
  }
});

// 手动推送小说章节到微信公众号
function storyEscapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function uploadStoryImages(htmlContent) {
  var imgRegex = /<img[^>]+src=["']([^"']+)["']/g;
  var match;
  var tasks = [];
  while ((match = imgRegex.exec(htmlContent)) !== null) {
    var originalSrc = match[1];
    if (originalSrc.indexOf('mmbiz.qpic.cn') >= 0 || originalSrc.indexOf('mmbiz.qlogo.cn') >= 0 || originalSrc.startsWith('data:')) continue;
    var uploadUrl = originalSrc.startsWith('/') ? SITE_URL + originalSrc : originalSrc;
    tasks.push({ original: originalSrc, upload: uploadUrl });
  }
  if (tasks.length === 0) return htmlContent;
  for (var i = 0; i < tasks.length; i++) {
    try {
      var weixinUrl = await mpDraftService.uploadMpImage(tasks[i].upload);
      if (weixinUrl) htmlContent = htmlContent.split(tasks[i].original).join(weixinUrl);
    } catch (e) { console.warn('[故事推送] 图片上传失败:', e.message); }
  }
  return htmlContent;
}

router.post('/stories/publish-to-wechat', auth, async (req, res) => {
  try {
    var { chapterIndex, novelId } = req.body;
    novelId = novelId || loadPubConfig().activeNovelId || 'default';
    var novel = novelsGetById(novelId);
    var novelTitle = novel ? novel.title : '小说连载';
    var index = storiesGetIndex(novelId);
    if (index.length === 0) return res.json({ code: 400, message: '故事库为空' });
    if (chapterIndex === undefined || chapterIndex < 0 || chapterIndex >= index.length) {
      return res.json({ code: 400, message: '无效的章节索引' });
    }
    
    var chapter = storiesGetChapter(chapterIndex, novelId);
    if (!chapter) return res.json({ code: 400, message: '章节内容不存在' });
    
    var [weather, hitokoto, dateInfo] = await Promise.all([
      mpDraftService.getWeather(),
      mpDraftService.getHitokoto(),
      Promise.resolve(mpDraftService.getDateInfo())
    ]);
    
    var chapNum = chapterIndex + 1;
    var chapTotal = index.length;
    var today = dateInfo.date;
    var week = dateInfo.week;
    var paragraphs = (chapter.content || '').replace(/\r\n/g, '\n').split(/\n\n+/);
    
    var storyHtml = '';
    storyHtml += '<div style="padding:6px 0;">';
    
    // ===== 头部 =====
    storyHtml += '<table width="100%" cellpadding="0" cellspacing="0"><tr><td style="background:linear-gradient(135deg,#FFF0F5,#F8F0FF);padding:22px 16px 18px;text-align:center;">';
    storyHtml += '<div style="color:#A78BFA;font-size:13px;margin-bottom:6px;letter-spacing:2px;">📖 校园小说连载 · 第' + chapNum + '/' + chapTotal + '章</div>';
    storyHtml += '<div style="color:#FF69B4;font-size:22px;font-weight:bold;letter-spacing:1px;">第' + chapNum + '章 ' + storyEscapeHtml(chapter.title) + '</div>';
    storyHtml += '<div style="color:#bbb;font-size:12px;margin-top:8px;">' + today + ' ' + week + ' · ' + storyEscapeHtml(chapter.author || '匿名投稿') + '</div>';
    storyHtml += '<div style="width:40px;height:3px;background:linear-gradient(90deg,#FFB6C1,#A78BFA);margin:14px auto 0;"></div>';
    storyHtml += '</td></tr></table>';
    
    // ===== 阅读信息 =====
    var totalChars = (chapter.content || '').replace(/\s/g, '').length;
    var readMinutes = Math.max(1, Math.ceil(totalChars / 300));
    storyHtml += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;"><tr><td style="background:#FFFFF0;padding:12px;border-radius:10px;">';
    storyHtml += '<table width="100%" cellpadding="0" cellspacing="0"><tr>';
    storyHtml += '<td style="text-align:center;width:33%;padding:4px;border-right:1px dashed #E8D5B5;">';
    storyHtml += '<div style="font-size:11px;color:#bbb;margin-bottom:2px;">📝 全文字数</div>';
    storyHtml += '<div style="font-size:16px;font-weight:bold;color:#D4876A;">' + totalChars.toLocaleString() + ' 字</div>';
    storyHtml += '</td>';
    storyHtml += '<td style="text-align:center;width:33%;padding:4px;border-right:1px dashed #E8D5B5;">';
    storyHtml += '<div style="font-size:11px;color:#bbb;margin-bottom:2px;">⏱ 阅读时长</div>';
    storyHtml += '<div style="font-size:16px;font-weight:bold;color:#D4876A;">约 ' + readMinutes + ' 分钟</div>';
    storyHtml += '</td>';
    storyHtml += '<td style="text-align:center;width:33%;padding:4px;">';
    storyHtml += '<div style="font-size:11px;color:#bbb;margin-bottom:2px;">📚 连载进度</div>';
    storyHtml += '<div style="font-size:16px;font-weight:bold;color:#D4876A;">第' + chapNum + '/' + chapTotal + '章</div>';
    storyHtml += '</td>';
    storyHtml += '</tr></table></td></tr></table>';
    
    // ===== 天气 =====
    if (weather && weather.temperature) {
      storyHtml += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;"><tr><td style="background:linear-gradient(135deg,#E8F4FD,#E0F0FF);padding:16px;">';
      storyHtml += '<div style="font-size:13px;color:#888;margin-bottom:10px;font-weight:500;">🌤️ ' + (weather.city || '') + ' 天气预报</div>';
      storyHtml += '<table width="100%" cellpadding="0" cellspacing="0"><tr>';
      storyHtml += '<td style="width:50%;text-align:center;padding:4px;border-right:1px dashed #B0D4F1;">';
      storyHtml += '<div style="font-size:11px;color:#aaa;margin-bottom:4px;">今日</div>';
      storyHtml += '<div style="font-size:20px;font-weight:bold;color:#4A90D9;">' + (weather.icon || '🌤') + ' ' + (weather.temperature || '') + '</div>';
      storyHtml += '<div style="font-size:12px;color:#666;margin-top:2px;">' + (weather.weather || '') + '</div>';
      storyHtml += '<div style="font-size:11px;color:#999;margin-top:4px;">💨 ' + (weather.wind || '') + ' 💧 ' + (weather.humidity || '') + '</div>';
      storyHtml += '</td>';
      if (weather.tomorrow) {
        storyHtml += '<td style="width:50%;text-align:center;padding:4px;">';
        storyHtml += '<div style="font-size:11px;color:#aaa;margin-bottom:4px;">' + (weather.tomorrow.week || '周五') + '</div>';
        storyHtml += '<div style="font-size:20px;font-weight:bold;color:#4A90D9;">' + (weather.tomorrow.icon || '☀️') + ' ' + (weather.tomorrow.tempRange || '') + '</div>';
        storyHtml += '<div style="font-size:12px;color:#666;margin-top:2px;">' + (weather.tomorrow.weather || '') + '</div>';
        storyHtml += '<div style="font-size:11px;color:#999;margin-top:4px;">📍 预报</div>';
        storyHtml += '</td>';
      } else {
        storyHtml += '<td style="width:50%;text-align:center;padding:4px;color:#ccc;font-size:13px;">🌤️ 暂无预报</td>';
      }
      storyHtml += '</tr></table></td></tr></table>';
    }
    
    // ===== 一言 =====
    if (hitokoto && hitokoto.text) {
      storyHtml += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;"><tr><td style="background:#FFF9F5;padding:16px;border-left:3px solid #A78BFA;">';
      storyHtml += '<p style="font-size:14px;color:#888;margin:0 0 6px 0;line-height:1.8;font-style:italic;">💬 "' + storyEscapeHtml(hitokoto.text) + '"</p>';
      storyHtml += '<p style="text-align:right;color:#ccc;font-size:12px;margin:0;">—— ' + storyEscapeHtml(hitokoto.from_who || hitokoto.from || '') + '</p></td></tr></table>';
    }
    
    // ===== 分割线 =====
    storyHtml += '<div style="text-align:center;margin:18px 0;color:#e8e8e8;font-size:14px;">❀&nbsp;&nbsp;❁&nbsp;&nbsp;❀</div>';
    
    // ===== 小说正文 =====
    storyHtml += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:18px;"><tr><td style="background:#FFFBFF;padding:20px 16px;">';
    storyHtml += '<div style="text-align:center;margin-bottom:20px;">';
    storyHtml += '<div style="display:inline-block;background:linear-gradient(135deg,#FFF0F5,#F8F0FF);padding:6px 20px;border-radius:20px;font-size:12px;color:#A78BFA;letter-spacing:1px;">第' + chapNum + '章</div>';
    storyHtml += '</div>';
    for (var pi = 0; pi < paragraphs.length; pi++) {
      var para = paragraphs[pi].trim();
      if (!para) continue;
      var isDialogue = para.includes('"') || para.includes('"') || para.includes('"');
      if (isDialogue) {
        storyHtml += '<p style="text-indent:2em;line-height:2.1;margin-bottom:14px;font-size:15px;color:#6B4C3B;margin-top:0;letter-spacing:0.5px;background:#FFFBF8;padding:8px 14px;border-radius:8px;border-left:3px solid #FFD4B8;">' + storyEscapeHtml(para) + '</p>';
      } else {
        storyHtml += '<p style="text-indent:2em;line-height:2.1;margin-bottom:14px;font-size:15px;color:#444;margin-top:0;letter-spacing:0.5px;">' + storyEscapeHtml(para) + '</p>';
      }
    }
    if (chapNum < chapTotal) {
      storyHtml += '<div style="text-align:center;margin:24px 0 10px 0;">';
      storyHtml += '<div style="display:inline-block;background:#FFF0F5;padding:8px 24px;border-radius:12px;font-size:13px;color:#FF69B4;">🌟 未完待续 · 同一时间见</div>';
      storyHtml += '</div>';
      storyHtml += '<div style="text-align:center;font-size:12px;color:#ccc;margin-top:6px;">📖 第' + (chapNum + 1) + '/' + chapTotal + '章 敬请期待</div>';
    }
    storyHtml += '</td></tr></table>';
    
    // ===== 引流语 =====
    storyHtml += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;"><tr><td style="background:#FFF8F0;padding:16px;border-radius:12px;">';
    storyHtml += '<div style="font-size:13px;color:#D4876A;line-height:1.8;text-align:center;">';
    storyHtml += '❤️ 校园故事持续征集中<br>';
    storyHtml += '墙墙准备了一篇暖心小说，希望你喜欢 ❤️<br><br>';
    storyHtml += '🎨 如果你也有故事，<strong style="color:#FF6B9D;">欢迎分享给身边的同学哦</strong><br>';
    storyHtml += '📮 想说的，去 <strong style="color:#FF6B9D;">https://wall.jay23.cn</strong> 投稿吧！<br>';
    storyHtml += '你的每一个故事，都有可能成为下篇文章的主角 ❤️';
    storyHtml += '</div></td></tr></table>';
    
    // ===== 底部二维码 =====
    storyHtml += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;"><tr><td style="background:linear-gradient(135deg,#FFF0F5,#FFE4E1);padding:24px 20px;text-align:center;border-radius:16px;">';
    storyHtml += '<div style="font-size:18px;color:#FF69B4;font-weight:bold;margin-bottom:6px;">🌸 校园故事站</div>';
    storyHtml += '<div style="font-size:13px;color:#DDA0DD;margin-bottom:16px;">扫码关注 · 分享身边的美好</div>';
    storyHtml += '<table align="center" style="margin:0 auto;"><tr><td style="background:linear-gradient(135deg,#FF69B4,#FFB6C1);padding:4px;border-radius:16px;">';
    storyHtml += '<table style="width:100%;background:#fff;border-radius:12px;"><tr><td style="padding:12px;">';
    storyHtml += '<img src="https://wall.jay23.cn/images/gzh.jpg" style="width:200px;display:block;border-radius:6px;margin:0 auto;height:auto;" alt="校园墙二维码">';
    storyHtml += '</td></tr></table>';
    storyHtml += '</td></tr></table>';
    storyHtml += '<p style="color:#bbb;font-size:12px;margin:14px 0 4px 0;letter-spacing:1px;">📱 微信扫一扫 · 获取更多精彩</p>';
    storyHtml += '<p style="color:#FF69B4;font-size:13px;font-weight:bold;word-break:break-all;letter-spacing:0.5px;">https://wall.jay23.cn</p>';
    storyHtml += '<div style="width:40px;height:2px;background:#FFB6C1;margin:12px auto 0;border-radius:2px;"></div>';
    storyHtml += '</td></tr></table>';
    storyHtml += '<p style="text-align:center;color:#ddd;font-size:12px;margin-top:18px;">❀ ' + dateInfo.year + ' 嘉二校园墙 ❀ ❀</p>';
    storyHtml += '</div>';
    
    storyHtml = await uploadStoryImages(storyHtml);
    
    var article = {
      title: '小说连载 · 第' + chapNum + '章 ' + chapter.title + ' | ' + dateInfo.date,
      author: 'JAY',
      digest: '小说连载 · ' + novelTitle + ' · ' + chapter.title + '。' + (chapter.content || '').replace(/[\n\r]+/g, '').substring(0, 60) + '...',
      content: storyHtml,
      content_source_url: 'https://wall.jay23.cn',
      show_cover_pic: 1,
      need_open_comment: 1,
      only_fans_can_comment: 0
    };
    
    var mediaId = await mpDraftService.createDraft([article]);
    
    // 标记为已发布
    var idx = storiesGetIndex(novelId);
    if (chapterIndex >= 0 && chapterIndex < idx.length) {
      idx[chapterIndex].published = true;
      storiesSaveIndex(idx, novelId);
    }
    
    res.json({ code: 200, data: { media_id: mediaId }, message: '✅ 已同步到公众号草稿箱' });
  } catch (err) {
    console.error('[故事推送] 失败:', err.message);
    res.json({ code: 500, message: '推送失败: ' + err.message });
  }
});

module.exports = router;
