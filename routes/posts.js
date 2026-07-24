const express = require('express');
const { pool } = require('../config/database');
const { auth, optionalAuth, isStaffRole } = require('../middleware/auth');
const { getIpRegion, getClientIp } = require('../services/ip-lookup');
const { notifyNewComment, notifyNewLike, notifyMention, notifyFollowPost, notifyAdminNewPostPending } = require('../services/email');
const { createNotification } = require('./notifications');
const router = express.Router();

// ORDER BY 白名单（防 SQL 注入）
const ORDER_BY_WHITELIST = {
  latest: 'p.is_pinned DESC, p.created_at DESC',
  hot: 'p.is_pinned DESC, p.likes_count DESC, p.created_at DESC',
};
const ORDER_BY_MAP = ORDER_BY_WHITELIST;

// 初始化comments表的mentioned_users字段
(async function initMentionedUsersField() {
  try {
    await pool.execute('ALTER TABLE comments ADD COLUMN mentioned_users TEXT');
    console.log('[DB] comments.mentioned_users 字段已添加');
  } catch (err) {
    if (err.code === 'ER_DUP_FIELDNAME') {
      console.log('[DB] comments.mentioned_users 字段已存在');
    } else {
      console.error('[DB] 初始化mentioned_users字段失败:', err.message);
    }
  }
})();

// 搜索用户（用于艾特功能、私信搜索）
router.get('/search-users', auth, async (req, res) => {
  try {
    const { q, limit = 20 } = req.query;
    const currentUserId = req.user.id;
    
    let users;
    if (!q || q.trim().length < 1) {
      // 无搜索词时返回最近活跃用户
      [users] = await pool.execute(
        'SELECT id, nickname, username, avatar, role FROM users WHERE status = 1 AND id != ? ORDER BY created_at DESC LIMIT ?',
        [currentUserId, parseInt(limit)]
      );
    } else {
      const searchTerm = '%' + q.trim() + '%';
      [users] = await pool.execute(
        'SELECT id, nickname, username, avatar, role FROM users WHERE (nickname LIKE ? OR username LIKE ?) AND status = 1 AND id != ? LIMIT ?',
        [searchTerm, searchTerm, currentUserId, parseInt(limit)]
      );
    }
    
    res.json({ code: 200, data: { users } });
  } catch (err) {
    console.error('搜索用户错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取公开用户资料（不需要登录）
router.get('/users/:id', async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const [users] = await pool.execute(
      'SELECT id, username, nickname, avatar, role, created_at FROM users WHERE id = ?',
      [userId]
    );
    
    if (users.length === 0) {
      return res.json({ code: 404, message: '用户不存在' });
    }
    
    const user = users[0];
    
    // 获取用户发帖数
    let postCount = 0;
    try {
      const [posts] = await pool.execute(
        'SELECT COUNT(*) as total FROM posts WHERE user_id = ? AND status = "approved"',
        [userId]
      );
      postCount = posts[0].total;
    } catch (e) {
      // 忽略错误
    }
    
    // 获取用户发布的评论数（不是获得的评论数）
    let commentCount = 0;
    try {
      const [comments] = await pool.execute(
        'SELECT COUNT(*) as total FROM comments WHERE user_id = ?',
        [userId]
      );
      commentCount = comments[0].total;
    } catch (e) {
      // 忽略错误
    }
    
    // 获取用户获得的赞数（所有帖子的点赞数之和）
    let likesCount = 0;
    try {
      const [likes] = await pool.execute(`
        SELECT COALESCE(SUM(likes_count), 0) as total FROM posts 
        WHERE user_id = ? AND status = "approved"
      `, [userId]);
      likesCount = likes[0].total;
    } catch (e) {
      // 忽略错误
    }
    
    // 获取用户头衔
    let titles = [];
    try {
      const [titleRows] = await pool.execute(`
        SELECT t.icon, t.title_name, t.title_color, t.title_bg 
        FROM user_titles t
        JOIN user_title_relations r ON t.id = r.title_id
        WHERE r.user_id = ?
        ORDER BY t.sort_order DESC, t.id ASC
        LIMIT 5
      `, [userId]);
      titles = titleRows;
    } catch (e) {
      // 忽略错误，头衔功能可能未启用
    }

    // 获取关注/粉丝数
    let followersCount = 0;
    let followingCount = 0;
    try {
      const [followers] = await pool.execute('SELECT COUNT(*) as count FROM follows WHERE following_id = ?', [userId]);
      const [following] = await pool.execute('SELECT COUNT(*) as count FROM follows WHERE follower_id = ?', [userId]);
      followersCount = followers[0].count;
      followingCount = following[0].count;
    } catch (e) {
      // follows 表可能尚未创建
    }

    res.json({
      code: 200,
      data: {
        ...user,
        post_count: postCount,
        comment_count: commentCount,
        likes_count: likesCount,
        titles: titles,
        followers_count: followersCount,
        following_count: followingCount
      }
    });
  } catch (err) {
    console.error('获取用户资料错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取帖子列表（带分页、分类筛选）
router.get('/', optionalAuth, async (req, res) => {
  try {
    const { page = 1, limit = 10, offset, category, sort = 'latest', keyword, user_id } = req.query;
    // 支持直接传 offset 或通过 page 计算
    const finalOffset = offset ? parseInt(offset) : ((page - 1) * limit);
    const finalLimit = parseInt(limit);

    let whereClause = 'p.status = "approved" AND p.is_deleted = 0';
    const params = [];

    if (category && category !== '全部') {
      whereClause += ' AND p.category = ?';
      params.push(category);
    }

    if (keyword && keyword.trim()) {
      whereClause += ' AND (p.title LIKE ? OR p.content LIKE ?)';
      params.push('%' + keyword.trim() + '%', '%' + keyword.trim() + '%');
    }

    if (user_id) {
      whereClause += ' AND p.user_id = ?';
      params.push(parseInt(user_id));
    }

    let orderBy = ORDER_BY_MAP.latest;
    if (ORDER_BY_MAP[sort]) orderBy = ORDER_BY_MAP[sort];

    // 获取帖子列表
    const [posts] = await pool.execute(`
      SELECT p.id, p.title, p.content, p.images, p.is_anonymous, p.category,
             p.likes_count, p.comments_count, p.views, p.created_at, p.ip_region, p.is_pinned,
             p.poll_type,
             CASE WHEN p.is_anonymous = 1 THEN NULL ELSE u.nickname END as author_name,
             CASE WHEN p.is_anonymous = 1 THEN NULL ELSE u.avatar END as author_avatar,
             CASE WHEN p.is_anonymous = 1 THEN NULL ELSE u.id END as author_id,
             CASE WHEN p.is_anonymous = 1 THEN NULL ELSE u.role END as author_role
      FROM posts p
      LEFT JOIN users u ON p.user_id = u.id
      WHERE ${whereClause}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `, [...params, finalLimit, finalOffset]);

    // 获取所有帖子的作者头衔
    if (posts.length > 0) {
      const authorIds = posts.filter(p => p.author_id).map(p => p.author_id);
      if (authorIds.length > 0) {
        const placeholders = authorIds.map(() => '?').join(',');
        const [titleRelations] = await pool.execute(`
          SELECT utr.user_id, ut.id as title_id, ut.title_name, ut.title_color, ut.title_bg, ut.icon
          FROM user_title_relations utr
          JOIN user_titles ut ON utr.title_id = ut.id
          WHERE utr.user_id IN (${placeholders})
          ORDER BY ut.sort_order DESC, ut.id ASC
        `, authorIds);
        
        // 将头衔分组到每个作者
        const titlesByUser = {};
        titleRelations.forEach(tr => {
          if (!titlesByUser[tr.user_id]) {
            titlesByUser[tr.user_id] = [];
          }
          titlesByUser[tr.user_id].push({
            id: tr.title_id,
            title_name: tr.title_name,
            title_color: tr.title_color,
            title_bg: tr.title_bg,
            icon: tr.icon
          });
        });
        
        // 将头衔添加到帖子数据中
        posts.forEach(post => {
          post.author_titles = titlesByUser[post.author_id] || [];
        });
      }
    }

    // 获取每个帖子的最新 3 条评论（朋友圈风格预览）
    if (posts.length > 0) {
      const postIds = posts.map(p => p.id);
      const placeholders = postIds.map(() => '?').join(',');
      const [comments] = await pool.execute(`
        SELECT c.id, c.post_id, c.content, c.is_anonymous, c.created_at, c.ip_region,
               CASE WHEN c.is_anonymous = 1 THEN NULL ELSE cu.nickname END as author_name,
               CASE WHEN c.is_anonymous = 1 THEN NULL ELSE cu.avatar END as author_avatar,
               CASE WHEN c.is_anonymous = 1 THEN NULL ELSE cu.id END as author_id,
               CASE WHEN c.is_anonymous = 1 THEN NULL ELSE cu.role END as author_role
        FROM comments c
        LEFT JOIN users cu ON c.user_id = cu.id
        WHERE c.post_id IN (${placeholders})
        ORDER BY c.post_id, c.created_at DESC
      `, postIds);

      // 获取评论作者的头衔
      const commentAuthorIds = comments.filter(c => c.author_id).map(c => c.author_id);
      if (commentAuthorIds.length > 0) {
        const cPlaceholders = commentAuthorIds.map(() => '?').join(',');
        const [commentTitles] = await pool.execute(`
          SELECT utr.user_id, ut.id as title_id, ut.title_name, ut.title_color, ut.title_bg, ut.icon
          FROM user_title_relations utr
          JOIN user_titles ut ON utr.title_id = ut.id
          WHERE utr.user_id IN (${cPlaceholders})
          ORDER BY ut.sort_order DESC, ut.id ASC
        `, commentAuthorIds);
        
        const titlesByCommentAuthor = {};
        commentTitles.forEach(ct => {
          if (!titlesByCommentAuthor[ct.user_id]) {
            titlesByCommentAuthor[ct.user_id] = [];
          }
          titlesByCommentAuthor[ct.user_id].push({
            id: ct.title_id,
            title_name: ct.title_name,
            title_color: ct.title_color,
            title_bg: ct.title_bg,
            icon: ct.icon
          });
        });
        
        // 将头衔添加到评论数据中
        comments.forEach(comment => {
          comment.author_titles = titlesByCommentAuthor[comment.author_id] || [];
        });
      }

      // 将评论按帖子分组，每个帖子只保留最新 3 条
      const commentsByPost = {};
      comments.forEach(comment => {
        if (!commentsByPost[comment.post_id]) {
          commentsByPost[comment.post_id] = [];
        }
        if (commentsByPost[comment.post_id].length < 3) {
          commentsByPost[comment.post_id].push({
            id: comment.id,
            content: comment.content,
            is_anonymous: comment.is_anonymous,
            author_name: comment.author_name,
            author_avatar: comment.author_avatar,
            author_id: comment.author_id,
            author_role: comment.author_role,
            author_titles: comment.author_titles || [],
            time_ago: getTimeAgo(comment.created_at),
            ip_region: comment.ip_region
          });
        }
      });

      // 将评论添加到帖子数据中
      posts.forEach(post => {
        post.preview_comments = commentsByPost[post.id] || [];
      });
    }

    // 获取总数
    const [countResult] = await pool.execute(`
      SELECT COUNT(*) as total FROM posts p WHERE ${whereClause}
    `, params);

    // 如果用户已登录，检查是否点赞/收藏（只查当前页帖子，避免全量查询）
    let userLikes = new Set();
    let userFavorites = new Set();
    if (req.user && posts.length > 0) {
      const postIds = posts.map(p => p.id);
      if (postIds.length > 0) {
        const placeholders = postIds.map(() => '?').join(',');
        const [likes] = await pool.execute(
          'SELECT post_id FROM likes WHERE user_id = ? AND post_id IN (' + placeholders + ')',
          [req.user.id, ...postIds]
        );
        const [favorites] = await pool.execute(
          'SELECT post_id FROM favorites WHERE user_id = ? AND post_id IN (' + placeholders + ')',
          [req.user.id, ...postIds]
        );
        userLikes = new Set(likes.map(l => l.post_id));
        userFavorites = new Set(favorites.map(f => f.post_id));
      }
    }

    const processedPosts = posts.map(post => ({
      ...post,
      images: post.images ? JSON.parse(post.images) : [],
      is_liked: userLikes.has(post.id),
      is_favorited: userFavorites.has(post.id),
      time_ago: getTimeAgo(post.created_at)
    }));

    res.json({
      code: 200,
      data: {
        posts: processedPosts,
        total: countResult[0].total,
        page: parseInt(page),
        totalPages: Math.ceil(countResult[0].total / limit)
      }
    });
  } catch (err) {
    console.error('获取帖子列表错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取我的帖子
router.get('/user/my', auth, async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;
    const offset = (page - 1) * limit;

    const [posts] = await pool.execute(`
      SELECT p.*,
             CASE WHEN p.is_anonymous = 1 THEN NULL ELSE u.nickname END as author_name,
             CASE WHEN p.is_anonymous = 1 THEN NULL ELSE u.avatar END as author_avatar
      FROM posts p
      LEFT JOIN users u ON p.user_id = u.id
      WHERE p.user_id = ? AND p.is_deleted = 0 ORDER BY p.created_at DESC LIMIT ? OFFSET ?
    `, [req.user.id, parseInt(limit), parseInt(offset)]);

    const [countResult] = await pool.execute('SELECT COUNT(*) as total FROM posts WHERE user_id = ? AND is_deleted = 0', [req.user.id]);

    // 获取当前用户点赞和收藏的帖子ID
    const postIds = posts.map(p => p.id);
    let userLikes = new Set();
    let userFavorites = new Set();
    if (postIds.length > 0) {
      const placeholders = postIds.map(() => '?').join(',');
      const [likes] = await pool.execute(
        `SELECT post_id FROM likes WHERE user_id = ? AND post_id IN (${placeholders})`,
        [req.user.id, ...postIds]
      );
      const [favorites] = await pool.execute(
        `SELECT post_id FROM favorites WHERE user_id = ? AND post_id IN (${placeholders})`,
        [req.user.id, ...postIds]
      );
      userLikes = new Set(likes.map(l => l.post_id));
      userFavorites = new Set(favorites.map(f => f.post_id));
    }

    const processedPosts = posts.map(post => ({
      ...post,
      images: post.images ? JSON.parse(post.images) : [],
      time_ago: getTimeAgo(post.created_at),
      is_liked: userLikes.has(post.id),
      is_favorited: userFavorites.has(post.id)
    }));

    res.json({
      code: 200,
      data: {
        posts: processedPosts,
        total: countResult[0].total,
        totalPages: Math.ceil(countResult[0].total / limit)
      }
    });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取我的收藏
router.get('/user/favorites', auth, async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;
    const offset = (page - 1) * limit;

    const [posts] = await pool.execute(`
      SELECT p.*,
             CASE WHEN p.is_anonymous = 1 THEN NULL ELSE u.nickname END as author_name,
             CASE WHEN p.is_anonymous = 1 THEN NULL ELSE u.avatar END as author_avatar
      FROM favorites f
      JOIN posts p ON f.post_id = p.id
      LEFT JOIN users u ON p.user_id = u.id
      WHERE f.user_id = ?
      ORDER BY f.created_at DESC
      LIMIT ? OFFSET ?
    `, [req.user.id, parseInt(limit), parseInt(offset)]);

    const [countResult] = await pool.execute('SELECT COUNT(*) as total FROM favorites WHERE user_id = ?', [req.user.id]);

    // 获取当前用户点赞的帖子ID
    const postIds = posts.map(p => p.id);
    let userLikes = new Set();
    if (postIds.length > 0) {
      const placeholders = postIds.map(() => '?').join(',');
      const [likes] = await pool.execute(
        `SELECT post_id FROM likes WHERE user_id = ? AND post_id IN (${placeholders})`,
        [req.user.id, ...postIds]
      );
      userLikes = new Set(likes.map(l => l.post_id));
    }

    const processedPosts = posts.map(post => ({
      ...post,
      images: post.images ? JSON.parse(post.images) : [],
      time_ago: getTimeAgo(post.created_at),
      is_liked: userLikes.has(post.id),
      is_favorited: true  // 收藏列表中的帖子都是已收藏的
    }));

    res.json({
      code: 200,
      data: {
        posts: processedPosts,
        total: countResult[0].total,
        totalPages: Math.ceil(countResult[0].total / limit)
      }
    });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取帖子详情
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const [posts] = await pool.execute(`
      SELECT p.*, 
             CASE WHEN p.is_anonymous = 1 THEN NULL ELSE u.nickname END as author_name,
             CASE WHEN p.is_anonymous = 1 THEN NULL ELSE u.avatar END as author_avatar,
             CASE WHEN p.is_anonymous = 1 THEN NULL ELSE u.id END as author_id,
             CASE WHEN p.is_anonymous = 1 THEN NULL ELSE u.role END as author_role,
             p.user_id as actual_user_id
      FROM posts p
      LEFT JOIN users u ON p.user_id = u.id
      WHERE p.id = ? AND p.status = 'approved' AND p.is_deleted = 0
    `, [req.params.id]);

    if (posts.length === 0) {
      return res.json({ code: 404, message: '帖子不存在' });
    }

    const post = posts[0];
    post.images = post.images ? JSON.parse(post.images) : [];
    post.time_ago = getTimeAgo(post.created_at);

    // 获取评论
    const [comments] = await pool.execute(`
      SELECT c.*,
             CASE WHEN c.is_anonymous = 1 THEN NULL ELSE u.nickname END as author_name,
             CASE WHEN c.is_anonymous = 1 THEN NULL ELSE u.avatar END as author_avatar,
             CASE WHEN c.is_anonymous = 1 THEN NULL ELSE u.role END as author_role,
             c.user_id as actual_user_id
      FROM comments c
      LEFT JOIN users u ON c.user_id = u.id
      WHERE c.post_id = ?
      ORDER BY c.created_at ASC
    `, [req.params.id]);

    // 帖子作者可以看到匿名评论的真实作者
    var isPostAuthor = req.user && req.user.id === post.actual_user_id;
    post.comments = comments.map(function(c) {
      var comment = Object.assign({}, c, { time_ago: getTimeAgo(c.created_at) });
      if (isPostAuthor && c.is_anonymous && c.actual_user_id) {
        comment.author_name = '匿名同学（仅作者可见）';
        comment.is_anonymous_revealed = true;
      }
      return comment;
    });

    // 检查是否点赞/收藏
    if (req.user) {
      const [likes] = await pool.execute('SELECT id FROM likes WHERE user_id = ? AND post_id = ?', [req.user.id, req.params.id]);
      const [favorites] = await pool.execute('SELECT id FROM favorites WHERE user_id = ? AND post_id = ?', [req.user.id, req.params.id]);
      post.is_liked = likes.length > 0;
      post.is_favorited = favorites.length > 0;
    } else {
      post.is_liked = false;
      post.is_favorited = false;
    }

    // 获取点赞用户列表（朋友圈风格）
    const [likesList] = await pool.execute(`
      SELECT u.id, u.nickname, u.avatar, l.created_at 
      FROM likes l 
      JOIN users u ON l.user_id = u.id 
      WHERE l.post_id = ? 
      ORDER BY l.created_at DESC 
      LIMIT 20
    `, [req.params.id]);
    post.likes_list = likesList;

    // 获取作者头衔
    if (!post.is_anonymous && post.author_id) {
      try {
        const [titles] = await pool.execute(`
          SELECT t.icon, t.title_name, t.title_color, t.title_bg
          FROM user_titles t
          JOIN user_title_relations r ON t.id = r.title_id
          WHERE r.user_id = ?
          ORDER BY t.sort_order DESC, t.id ASC
          LIMIT 5
        `, [post.author_id]);
        post.author_titles = titles;
      } catch (e) {
        post.author_titles = [];
      }
    } else {
      post.author_titles = [];
    }

    // 获取投票数据（如果是投票帖）
    if (post.poll_type) {
      try {
        var [pollOptions] = await pool.execute(
          'SELECT id, option_text, votes_count FROM poll_options WHERE post_id = ? ORDER BY id',
          [req.params.id]
        );
        post.poll_options = pollOptions;
        post.poll_total = pollOptions.reduce(function(s, o) { return s + o.votes_count; }, 0);
        // 检查当前用户是否已投票
        if (req.user) {
          var [userVotes] = await pool.execute(
            'SELECT option_id FROM poll_votes v JOIN poll_options o ON v.option_id = o.id WHERE o.post_id = ? AND v.user_id = ?',
            [req.params.id, req.user.id]
          );
          post.poll_user_votes = userVotes.map(function(v) { return v.option_id; });
        } else {
          post.poll_user_votes = [];
        }
      } catch (e) {
        post.poll_options = [];
        post.poll_total = 0;
        post.poll_user_votes = [];
      }
    }

    res.json({ code: 200, data: post });
  } catch (err) {
    console.error('获取帖子详情错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 发布帖子
router.post('/', auth, async (req, res) => {
  try {
    const { title, content, images, is_anonymous, category, contact, pollOptions, pollType, pollExpiresAt, client_ip } = req.body;
    if (!content || content.trim() === '') {
      return res.json({ code: 400, message: '请输入内容' });
    }
    if (content.length > 5000) {
      return res.json({ code: 400, message: '内容不能超过5000字' });
    }
    if (title && title.length > 100) {
      return res.json({ code: 400, message: '标题不能超过100字' });
    }

    // 检查是否允许匿名发帖
    const [anonPostSetting] = await pool.execute('SELECT config_value FROM settings WHERE config_key = ?', ['anon_post']);
    const allowAnonPost = anonPostSetting.length === 0 || anonPostSetting[0].config_value === 'true';
    
    // 如果不允许匿名发帖，强制设置为非匿名
    const finalIsAnonymous = allowAnonPost ? (is_anonymous ? 1 : 0) : 0;

    // 优先使用前端传来的真实IP，否则使用服务器获取的IP
    var clientIp = client_ip || getClientIp(req);

    const imagesJson = images ? JSON.stringify(images) : null;
    const contactValue = (category === 'lost_found' && contact) ? contact.trim() : '';

    // 检查是否需要审核
    const [settingRows] = await pool.execute('SELECT config_value FROM settings WHERE config_key = ?', ['post_review']);
    const needReview = settingRows.length > 0 && settingRows[0].config_value === 'true';
    const postStatus = needReview ? 'pending' : 'approved';

    const [result] = await pool.execute(
      'INSERT INTO posts (user_id, title, content, images, is_anonymous, category, contact, ip_address, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [req.user.id, title || '', content.trim(), imagesJson, finalIsAnonymous, category || '日常', contactValue, clientIp, postStatus]
    );

    // 异步查询IP归属地并更新（不阻塞响应）
    getIpRegion(clientIp).then(region => {
      pool.execute('UPDATE posts SET ip_region = ? WHERE id = ?', [region, result.insertId]).catch(() => {});
    });

    // 如果需要审核，异步通知所有管理员审核
    if (needReview) {
      var postId = result.insertId;
      var posterNickname = req.user.nickname || req.user.username;
      var postTitle = title || '无标题';
      var postContent = content || '';
      setImmediate(function() {
        notifyAdminNewPostPending(postId, postTitle, posterNickname, postContent).catch(function(e) {
          console.error('通知管理员审核失败:', e.message);
        });
      });
    }

    // 异步通知关注者（不阻塞响应）
    if (!finalIsAnonymous && postStatus !== 'rejected') {
      var postId = result.insertId;
      var posterId = req.user.id;
      var posterNickname = req.user.nickname || req.user.username;
      var postTitle = title || '无标题';
      (async function() {
        try {
          var [followers] = await pool.execute(
            'SELECT u.id, u.email, u.nickname, u.username FROM follows f JOIN users u ON f.follower_id = u.id WHERE f.following_id = ? AND u.email IS NOT NULL AND u.email != ""',
            [posterId]
          );
          for (var fi = 0; fi < followers.length; fi++) {
            var f = followers[fi];
            notifyFollowPost(f.email, f.nickname || f.username, posterNickname, postTitle, postId, f.id);
          }
        } catch (e) {
          console.error('通知关注者失败:', e.message);
        }
      })();
    }

    // 如果有投票选项，插入投票数据
    if (pollOptions && Array.isArray(pollOptions) && pollOptions.length >= 2) {
      var validOptions = pollOptions.filter(function(o) { return o && o.trim(); });
      for (var pi = 0; pi < validOptions.length; pi++) {
        await pool.execute('INSERT INTO poll_options (post_id, option_text) VALUES (?, ?)', [result.insertId, validOptions[pi].trim()]);
      }
      await pool.execute('UPDATE posts SET poll_type = ?, poll_expires_at = ? WHERE id = ?', [
        pollType || 'single',
        pollExpiresAt || null,
        result.insertId
      ]);
    }

    // 发帖送积分（不阻塞）
    if (postStatus === 'approved') {
      var pid = result.insertId;
      (async function() {
        try {
          await pool.execute('UPDATE users SET points = points + ? WHERE id = ?', [2, req.user.id]);
          await pool.execute('INSERT INTO points_log (user_id, points, balance, reason, related_id) VALUES (?, 2, (SELECT points FROM users WHERE id = ?), ?, ?)', [req.user.id, req.user.id, 'post', pid]);
        } catch (e) {}
      })();
    }

    res.json({ code: 200, message: needReview ? '发布成功，等待审核' : '发布成功', data: { id: result.insertId } });
  } catch (err) {
    console.error('发布帖子错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 评论
router.post('/:id/comments', auth, async (req, res) => {
  try {
    const { content, is_anonymous, client_ip, mentioned_users } = req.body;
    if (!content || content.trim() === '') {
      return res.json({ code: 400, message: '请输入评论内容' });
    }
    if (content.length > 500) {
      return res.json({ code: 400, message: '评论不能超过500字' });
    }
    
    // 检查是否允许匿名评论
    const [anonCommentSetting] = await pool.execute('SELECT config_value FROM settings WHERE config_key = ?', ['anon_comment']);
    const allowAnonComment = anonCommentSetting.length === 0 || anonCommentSetting[0].config_value === 'true';
    
    // 如果不允许匿名评论，强制设置为非匿名
    const finalIsAnonymous = allowAnonComment ? (is_anonymous ? 1 : 0) : 0;
    
    // 获取客户端IP
    var clientIp = client_ip || getClientIp(req);

    // 处理艾特的用户ID列表
    var mentionedUsersJson = null;
    if (mentioned_users && Array.isArray(mentioned_users) && mentioned_users.length > 0) {
      mentionedUsersJson = JSON.stringify(mentioned_users);
    }

    // 尝试插入评论（包含 mentioned_users 字段）
    let result;
    try {
      [result] = await pool.execute(
        'INSERT INTO comments (post_id, user_id, content, is_anonymous, ip_address, mentioned_users) VALUES (?, ?, ?, ?, ?, ?)',
        [req.params.id, req.user.id, content.trim(), finalIsAnonymous, clientIp, mentionedUsersJson]
      );
    } catch (insertErr) {
      // 如果 mentioned_users 字段不存在，尝试不带该字段的插入
      if (insertErr.code === 'ER_BAD_FIELD_ERROR') {
        [result] = await pool.execute(
          'INSERT INTO comments (post_id, user_id, content, is_anonymous, ip_address) VALUES (?, ?, ?, ?, ?)',
          [req.params.id, req.user.id, content.trim(), finalIsAnonymous, clientIp]
        );
      } else {
        throw insertErr;
      }
    }
    
    // 异步查询IP归属地并更新
    getIpRegion(clientIp).then(region => {
      pool.execute('UPDATE comments SET ip_region = ? WHERE id = ?', [region, result.insertId]).catch(() => {});
    });
    
    await pool.execute('UPDATE posts SET comments_count = comments_count + 1 WHERE id = ?', [req.params.id]);

    // 异步发送邮件通知帖子作者
    setImmediate(async () => {
      try {
        const [posts] = await pool.execute('SELECT p.user_id, p.title, u.email, u.nickname, u.username FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.id = ?', [req.params.id]);
        const [commenters] = await pool.execute('SELECT nickname, username FROM users WHERE id = ?', [req.user.id]);
        
        if (posts.length > 0) {
          const commenter = commenters[0] || {};
          // 发送应用内通知
          await createNotification(
            posts[0].user_id,
            'comment',
            '收到新评论',
            commenter.nickname || commenter.username + ' 评论了你的帖子: ' + content.trim().substring(0, 50),
            req.params.id,
            'post'
          );
          
          // 发送邮件通知（如果有邮箱）
          if (posts[0].email) {
            await notifyNewComment(
              posts[0].email,
              posts[0].nickname || posts[0].username || '用户',
              commenter.nickname || commenter.username || '某用户',
              posts[0].title || '无标题',
              is_anonymous ? '（匿名评论）' : content.trim().substring(0, 100),
              posts[0].user_id
            );
          }
        }
      } catch (err) {
        console.error('[Email] 发送评论通知失败:', err.message);
      }
    });

    // 异步发送@提及通知
    if (mentioned_users && Array.isArray(mentioned_users) && mentioned_users.length > 0) {
      setImmediate(async () => {
        try {
          const [posts] = await pool.execute('SELECT p.title FROM posts p WHERE p.id = ?', [req.params.id]);
          const [commenter] = await pool.execute('SELECT nickname, username FROM users WHERE id = ?', [req.user.id]);
          const postTitle = posts[0] ? (posts[0].title || '无标题') : '无标题';
          const commenterName = commenter[0] ? (commenter[0].nickname || commenter[0].username) : '某用户';
          const visibleContent = is_anonymous ? '（匿名评论）' : content.trim().substring(0, 100);

          // 查询所有被@用户的信息
          const placeholders = mentioned_users.map(() => '?').join(',');
          const [mentionedUsers] = await pool.execute(
            `SELECT id, nickname, username, email FROM users WHERE id IN (${placeholders}) AND id != ?`,
            [...mentioned_users, req.user.id]
          );

          for (const mu of mentionedUsers) {
            // 应用内通知
            await createNotification(
              mu.id,
              'mention',
              '有人提到了你',
              commenterName + ' 在评论中提到了你: ' + visibleContent,
              req.params.id,
              'post'
            );
            // 邮件通知
            if (mu.email) {
              await notifyMention(mu.email, mu.nickname || mu.username, commenterName, postTitle, visibleContent, req.params.id, mu.id);
            }
          }
        } catch (err) {
          console.error('[Email] 发送@提及通知失败:', err.message);
        }
      });
    }

    // 评论送积分
    (async function() {
      try {
        await pool.execute('UPDATE users SET points = points + ? WHERE id = ?', [1, req.user.id]);
        await pool.execute('INSERT INTO points_log (user_id, points, balance, reason) VALUES (?, 1, (SELECT points FROM users WHERE id = ?), ?)', [req.user.id, req.user.id, 'comment']);
      } catch (e) {}
    })();

    res.json({ code: 200, message: '评论成功' });
  } catch (err) {
    console.error('评论错误:', err.message);
    res.json({ code: 500, message: '服务器错误: ' + err.message });
  }
});

// 删除评论
router.delete('/:postId/comments/:commentId', auth, async (req, res) => {
  try {
    const [comments] = await pool.execute('SELECT user_id, post_id FROM comments WHERE id = ?', [req.params.commentId]);
    if (comments.length === 0) {
      return res.json({ code: 404, message: '评论不存在' });
    }
    
    const comment = comments[0];
    const isCommentAuthor = comment.user_id === req.user.id;
    
    // 检查是否是帖子作者
    const [posts] = await pool.execute('SELECT user_id FROM posts WHERE id = ?', [comment.post_id]);
    const isPostAuthor = posts.length > 0 && posts[0].user_id === req.user.id;
    
    // 只有评论作者、帖子作者或管理员可以删除
    if (!isCommentAuthor && !isPostAuthor && !isStaffRole(req.user.role)) {
      return res.json({ code: 403, message: '无权删除此评论' });
    }
    
    await pool.execute('DELETE FROM comments WHERE id = ?', [req.params.commentId]);
    await pool.execute('UPDATE posts SET comments_count = GREATEST(comments_count - 1, 0) WHERE id = ?', [comment.post_id]);
    res.json({ code: 200, message: '删除成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 评论点赞
router.post('/comments/:commentId/like', auth, async (req, res) => {
  try {
    const commentId = req.params.commentId;
    const userId = req.user.id;

    // 检查评论是否存在
    const [comments] = await pool.execute('SELECT id, post_id FROM comments WHERE id = ?', [commentId]);
    if (comments.length === 0) {
      return res.json({ code: 404, message: '评论不存在' });
    }

    // 检查是否已经点赞
    const [existing] = await pool.execute(
      'SELECT id FROM comment_likes WHERE comment_id = ? AND user_id = ?',
      [commentId, userId]
    );

    let liked = false;
    if (existing.length > 0) {
      // 取消点赞
      await pool.execute('DELETE FROM comment_likes WHERE comment_id = ? AND user_id = ?', [commentId, userId]);
      await pool.execute('UPDATE comments SET likes_count = GREATEST(likes_count - 1, 0) WHERE id = ?', [commentId]);
    } else {
      // 添加点赞
      await pool.execute('INSERT INTO comment_likes (comment_id, user_id) VALUES (?, ?)', [commentId, userId]);
      await pool.execute('UPDATE comments SET likes_count = likes_count + 1 WHERE id = ?', [commentId]);
      liked = true;
    }

    // 获取最新点赞数
    const [updated] = await pool.execute('SELECT likes_count FROM comments WHERE id = ?', [commentId]);
    const likesCount = updated[0]?.likes_count || 0;

    res.json({ code: 200, data: { liked, likes_count: likesCount } });
  } catch (err) {
    console.error('评论点赞错误:', err.message);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取评论的回复列表
router.get('/:postId/comments/:commentId/replies', async (req, res) => {
  try {
    const { commentId } = req.params;
    const { sort = 'latest' } = req.query;

    let orderBy = 'created_at DESC';
    if (sort === 'hot') {
      orderBy = 'likes_count DESC, created_at DESC';
    }
    // 白名单校验（防止注入）
    if (!['created_at DESC', 'likes_count DESC, created_at DESC'].includes(orderBy)) {
      orderBy = 'created_at DESC';
    }

    const [replies] = await pool.execute(
      `SELECT r.*, u.nickname, u.username, u.avatar, u.role as author_role
       FROM comment_replies r
       LEFT JOIN users u ON r.user_id = u.id
       WHERE r.comment_id = ?
       ORDER BY ${orderBy}`,
      [commentId]
    );

    const formattedReplies = replies.map(reply => ({
      id: reply.id,
      content: reply.content,
      is_anonymous: reply.is_anonymous,
      author_name: reply.is_anonymous ? '匿名用户' : (reply.nickname || reply.username || '用户'),
      author_avatar: reply.is_anonymous ? '/uploads/avatars/default.png' : (reply.avatar || '/uploads/avatars/default.png'),
      author_id: reply.user_id,
      author_role: reply.author_role,
      time_ago: getTimeAgo(reply.created_at),
      ip_region: reply.ip_region,
      likes_count: reply.likes_count || 0,
      created_at: reply.created_at
    }));

    res.json({ code: 200, data: { replies: formattedReplies, total: replies.length } });
  } catch (err) {
    console.error('获取回复列表错误:', err.message);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 发送评论回复
router.post('/:postId/comments/:commentId/replies', auth, async (req, res) => {
  try {
    const { commentId, postId } = req.params;
    const { content, is_anonymous, client_ip } = req.body;

    if (!content || content.trim() === '') {
      return res.json({ code: 400, message: '请输入回复内容' });
    }
    if (content.length > 500) {
      return res.json({ code: 400, message: '回复不能超过500字' });
    }

    // 检查评论是否存在
    const [comments] = await pool.execute('SELECT id, user_id FROM comments WHERE id = ?', [commentId]);
    if (comments.length === 0) {
      return res.json({ code: 404, message: '评论不存在' });
    }

    // 获取客户端IP
    var clientIp = client_ip || getClientIp(req);

    // 插入回复
    const [result] = await pool.execute(
      'INSERT INTO comment_replies (comment_id, user_id, content, is_anonymous, ip_address) VALUES (?, ?, ?, ?, ?)',
      [commentId, req.user.id, content.trim(), is_anonymous ? 1 : 0, clientIp]
    );

    // 异步查询IP归属地并更新
    getIpRegion(clientIp).then(region => {
      pool.execute('UPDATE comment_replies SET ip_region = ? WHERE id = ?', [region, result.insertId]).catch(() => {});
    });

    // 获取当前用户信息用于通知
    const [users] = await pool.execute('SELECT nickname, username FROM users WHERE id = ?', [req.user.id]);
    const commenter = users[0] || {};

    // 获取原评论作者并发送通知
    const commentAuthorId = comments[0].user_id;
    if (commentAuthorId !== req.user.id) {
      createNotification(
        commentAuthorId,
        'comment_reply',
        '收到新回复',
        commenter.nickname || commenter.username + ' 回复了你的评论: ' + content.trim().substring(0, 50),
        postId,
        'post'
      ).catch(err => {
        console.error('[通知] 发送回复通知失败:', err.message);
      });
    }

    res.json({ code: 200, message: '回复成功' });
  } catch (err) {
    console.error('评论回复错误:', err.message);
    res.json({ code: 500, message: '服务器错误: ' + err.message });
  }
});

// 删除评论回复
router.delete('/:postId/comments/:commentId/replies/:replyId', auth, async (req, res) => {
  try {
    const { replyId, commentId } = req.params;

    const [replies] = await pool.execute('SELECT user_id, comment_id FROM comment_replies WHERE id = ?', [replyId]);
    if (replies.length === 0) {
      return res.json({ code: 404, message: '回复不存在' });
    }

    const reply = replies[0];
    const isReplyAuthor = reply.user_id === req.user.id;

    if (!isReplyAuthor && !isStaffRole(req.user.role)) {
      return res.json({ code: 403, message: '无权删除此回复' });
    }

    await pool.execute('DELETE FROM comment_replies WHERE id = ?', [replyId]);
    res.json({ code: 200, message: '删除成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 回复点赞
router.post('/:postId/comments/:commentId/replies/:replyId/like', auth, async (req, res) => {
  try {
    const { replyId } = req.params;
    const userId = req.user.id;

    // 检查回复是否存在
    const [replies] = await pool.execute('SELECT id FROM comment_replies WHERE id = ?', [replyId]);
    if (replies.length === 0) {
      return res.json({ code: 404, message: '回复不存在' });
    }

    // 检查是否已经点赞
    const [existing] = await pool.execute(
      'SELECT id FROM comment_reply_likes WHERE reply_id = ? AND user_id = ?',
      [replyId, userId]
    );

    let liked = false;
    if (existing.length > 0) {
      await pool.execute('DELETE FROM comment_reply_likes WHERE reply_id = ? AND user_id = ?', [replyId, userId]);
      await pool.execute('UPDATE comment_replies SET likes_count = GREATEST(likes_count - 1, 0) WHERE id = ?', [replyId]);
    } else {
      await pool.execute('INSERT INTO comment_reply_likes (reply_id, user_id) VALUES (?, ?)', [replyId, userId]);
      await pool.execute('UPDATE comment_replies SET likes_count = likes_count + 1 WHERE id = ?', [replyId]);
      liked = true;
    }

    const [updated] = await pool.execute('SELECT likes_count FROM comment_replies WHERE id = ?', [replyId]);
    const likesCount = updated[0]?.likes_count || 0;

    res.json({ code: 200, data: { liked, likes_count: likesCount } });
  } catch (err) {
    console.error('回复点赞错误:', err.message);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 点赞/取消点赞防抖（同一用户同一帖子1秒内只处理一次）
const likeDebounce = new Map();
const MAX_DEBOUNCE_ENTRIES = 5000;
setInterval(function() {
  if (likeDebounce.size > MAX_DEBOUNCE_ENTRIES) {
    const keys = [...likeDebounce.keys()].slice(0, likeDebounce.size - MAX_DEBOUNCE_ENTRIES);
    keys.forEach(k => likeDebounce.delete(k));
  } else {
    likeDebounce.clear();
  }
}, 5000); // 每5秒清一次（超出上限则只清理超出的部分）

router.post('/:id/like', auth, async (req, res) => {
  const key = req.user.id + ':' + req.params.id;
  var now = Date.now();
  if (likeDebounce.has(key) && now - likeDebounce.get(key) < 1000) {
    return res.json({ code: 200, message: 'ok', data: {} }); // 重复请求不返回 liked/likes_count，前端会跳过 UI 更新
  }
  likeDebounce.set(key, now);

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    
    const postId = req.params.id;
    
    // 先查询是否已点赞（使用 FOR UPDATE 锁定，防止竞态条件）
    const [existing] = await connection.execute(
      'SELECT id FROM likes WHERE user_id = ? AND post_id = ? FOR UPDATE',
      [req.user.id, postId]
    );
    
    if (existing.length > 0) {
      // 已点赞，执行取消点赞
      await connection.execute('DELETE FROM likes WHERE user_id = ? AND post_id = ?', [req.user.id, postId]);
      await connection.execute('UPDATE posts SET likes_count = GREATEST(likes_count - 1, 0) WHERE id = ?', [postId]);
      
      await connection.commit();
      
      const [updated] = await connection.execute('SELECT likes_count FROM posts WHERE id = ?', [postId]);
      
      res.json({ 
        code: 200, 
        message: '取消点赞', 
        data: { 
          liked: false,
          likes_count: updated[0].likes_count
        } 
      });
    } else {
      // 新点赞
      try {
        await connection.execute('INSERT INTO likes (user_id, post_id) VALUES (?, ?)', [req.user.id, postId]);
      } catch (insertErr) {
        if (insertErr.code === 'ER_DUP_ENTRY') {
          // 重复键错误（理论上不应该发生，因为已经加了 FOR UPDATE 锁）
          await connection.rollback();
          return res.json({ code: 500, message: '操作失败，请稍后重试' });
        }
        throw insertErr;
      }
      
      await connection.execute('UPDATE posts SET likes_count = likes_count + 1 WHERE id = ?', [postId]);
      
      await connection.commit();
      
      // 获取最新的点赞数
      const [updated] = await connection.execute('SELECT likes_count FROM posts WHERE id = ?', [postId]);
      
      // 给被点赞者加积分
      setImmediate(function() {
        pool.execute('SELECT p.user_id FROM posts p WHERE p.id = ?', [postId]).then(function(rows) {
          if (rows[0].length > 0 && rows[0][0].user_id !== req.user.id) {
            pool.execute('UPDATE users SET points = points + 1 WHERE id = ?', [rows[0][0].user_id]).catch(function(){});
            pool.execute("INSERT INTO points_log (user_id, points, balance, reason, related_id) VALUES (?, 1, (SELECT points FROM users WHERE id = ?), 'like', ?)", [rows[0][0].user_id, rows[0][0].user_id, postId]).catch(function(){});
          }
        }).catch(function(){});
      });

      // 发送点赞通知
      setImmediate(async () => {
        try {
          const [posts] = await pool.execute('SELECT p.user_id, p.title, u.email, u.nickname, u.username FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.id = ?', [postId]);
          const [users] = await pool.execute('SELECT nickname, username FROM users WHERE id = ?', [req.user.id]);
          if (posts.length > 0 && users.length > 0 && posts[0].user_id !== req.user.id) {
            const liker = users[0];
            const likerName = liker.nickname || liker.username || '某用户';
            await createNotification(
              posts[0].user_id,
              'like',
              '收到点赞',
              likerName + ' 点赞了你的帖子: ' + (posts[0].title || '无标题').substring(0, 30),
              postId,
              'post'
            );
            // 发送邮件通知
            if (posts[0].email) {
              await notifyNewLike(
                posts[0].email,
                posts[0].nickname || posts[0].username || '用户',
                likerName,
                posts[0].title || '无标题',
                posts[0].user_id
              );
            }
          }
        } catch (err) {
          console.error('发送点赞通知失败:', err.message);
        }
      });
      
      res.json({ 
        code: 200, 
        message: '点赞成功', 
        data: { 
          liked: true,
          likes_count: updated[0].likes_count
        } 
      });
    }
  } catch (err) {
    await connection.rollback();
    console.error('点赞错误:', err.message);
    console.error('点赞错误堆栈:', err.stack);
    res.json({ code: 500, message: '服务器错误: ' + err.message });
  } finally {
    connection.release();
  }
});

// 收藏/取消收藏
router.post('/:id/favorite', auth, async (req, res) => {
  try {
    const postId = req.params.id;
    const [existing] = await pool.execute('SELECT id FROM favorites WHERE user_id = ? AND post_id = ?', [req.user.id, postId]);

    if (existing.length > 0) {
      await pool.execute('DELETE FROM favorites WHERE user_id = ? AND post_id = ?', [req.user.id, postId]);
      res.json({ code: 200, message: '取消收藏', data: { favorited: false } });
    } else {
      await pool.execute('INSERT INTO favorites (user_id, post_id) VALUES (?, ?)', [req.user.id, postId]);
      res.json({ code: 200, message: '收藏成功', data: { favorited: true } });
    }
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});
// 删除自己的帖子
router.delete('/:id', auth, async (req, res) => {
  try {
    const [posts] = await pool.execute('SELECT user_id FROM posts WHERE id = ?', [req.params.id]);
    if (posts.length === 0) {
      return res.json({ code: 404, message: '帖子不存在' });
    }
    if (posts[0].user_id !== req.user.id && !isStaffRole(req.user.role)) {
      return res.json({ code: 403, message: '无权删除' });
    }
    await pool.execute('DELETE FROM posts WHERE id = ?', [req.params.id]);
    res.json({ code: 200, message: '删除成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 编辑自己的帖子
router.put('/:id', auth, async (req, res) => {
  try {
    const [posts] = await pool.execute('SELECT user_id, title, content, category, images, is_anonymous FROM posts WHERE id = ?', [req.params.id]);
    if (posts.length === 0) {
      return res.json({ code: 404, message: '帖子不存在' });
    }

    const post = posts[0];
    if (post.user_id !== req.user.id) {
      return res.json({ code: 403, message: '无权编辑此帖子' });
    }

    const { title, content, category, images, is_anonymous, pollOptions, pollType } = req.body;

    if (!title && !content) {
      return res.json({ code: 400, message: '标题和内容不能都为空' });
    }

    // 检查是否开启了帖子审核
    const [settingRows] = await pool.execute('SELECT config_value FROM settings WHERE config_key = ?', ['post_review']);
    const needReview = settingRows.length > 0 && settingRows[0].config_value === 'true';
    const postStatus = needReview ? 'pending' : 'approved';

    const updateFields = [];
    const updateValues = [];

    if (title !== undefined) {
      updateFields.push('title = ?');
      updateValues.push(title);
    }
    if (content !== undefined) {
      updateFields.push('content = ?');
      updateValues.push(content.trim());
    }
    if (category !== undefined) {
      updateFields.push('category = ?');
      updateValues.push(category);
    }
    if (images !== undefined) {
      updateFields.push('images = ?');
      updateValues.push(images ? JSON.stringify(images) : null);
    }
    if (is_anonymous !== undefined) {
      updateFields.push('is_anonymous = ?');
      updateValues.push(is_anonymous ? 1 : 0);
    }

    // 编辑后需要重新审核
    updateFields.push('status = ?');
    updateValues.push(postStatus);
    updateFields.push('updated_at = ?');
    updateValues.push(new Date());

    updateValues.push(req.params.id);

    await pool.execute(
      `UPDATE posts SET ${updateFields.join(', ')} WHERE id = ?`,
      updateValues
    );

    // 如果传了 pollOptions，更新投票选项
    // 注意：编辑已有选项会清空原 votes_count，需谨慎
    if (pollOptions && Array.isArray(pollOptions) && pollOptions.length >= 2) {
      var validOptions = pollOptions.filter(function(o) { return o && (o.text || typeof o === 'string') && (o.text || o).trim(); });
      if (validOptions.length >= 2) {
        // 删除旧选项（包括 votes_count），插入新选项（votes_count 归零）
        await pool.execute('DELETE FROM poll_votes WHERE option_id IN (SELECT id FROM poll_options WHERE post_id = ?)', [req.params.id]);
        await pool.execute('DELETE FROM poll_options WHERE post_id = ?', [req.params.id]);
        for (var pi = 0; pi < validOptions.length; pi++) {
          var optText = typeof validOptions[pi] === 'string' ? validOptions[pi] : validOptions[pi].text;
          await pool.execute('INSERT INTO poll_options (post_id, option_text) VALUES (?, ?)', [req.params.id, optText.trim()]);
        }
        // 更新 poll_type
        await pool.execute('UPDATE posts SET poll_type = ? WHERE id = ?', [pollType || 'single', req.params.id]);
      } else {
        return res.json({ code: 400, message: '投票选项至少需要2项' });
      }
    } else if (!pollOptions && post.poll_type) {
      // 原来是投票帖，现在没传投票选项，清理投票数据
      await pool.execute('DELETE FROM poll_votes WHERE option_id IN (SELECT id FROM poll_options WHERE post_id = ?)', [req.params.id]);
      await pool.execute('DELETE FROM poll_options WHERE post_id = ?', [req.params.id]);
      await pool.execute('UPDATE posts SET poll_type = NULL WHERE id = ?', [req.params.id]);
    }

    if (needReview) {
      res.json({ code: 200, message: '编辑成功，帖子正在等待审核', data: { status: 'pending' } });
    } else {
      res.json({ code: 200, message: '编辑成功', data: { status: 'approved' } });
    }
  } catch (err) {
    console.error('编辑帖子错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取帖子详情（编辑用）
router.get('/:id/edit', auth, async (req, res) => {
  try {
    const [posts] = await pool.execute(
      'SELECT id, title, content, category, images, is_anonymous, user_id, poll_type, poll_expires_at FROM posts WHERE id = ?',
      [req.params.id]
    );

    if (posts.length === 0) {
      return res.json({ code: 404, message: '帖子不存在' });
    }

    const post = posts[0];
    if (post.user_id !== req.user.id) {
      return res.json({ code: 403, message: '无权编辑此帖子' });
    }

    // 如果是投票帖，加载投票选项
    let pollOptions = [];
    if (post.poll_type) {
      const [options] = await pool.execute(
        'SELECT id, option_text FROM poll_options WHERE post_id = ? ORDER BY id',
        [req.params.id]
      );
      pollOptions = options.map(function(o) { return { id: o.id, text: o.option_text }; });
    }

    res.json({
      code: 200,
      data: {
        id: post.id,
        title: post.title,
        content: post.content,
        category: post.category,
        images: post.images ? JSON.parse(post.images) : [],
        is_anonymous: post.is_anonymous === 1,
        poll_options: pollOptions,
        poll_type: post.poll_type || 'single'
      }
    });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ===== 投票帖功能 =====

// 投票
router.post('/:id/vote', auth, async (req, res) => {
  try {
    var postId = req.params.id;
    var userId = req.user.id;
    var { option_id } = req.body;

    if (!option_id) return res.json({ code: 400, message: '请选择投票选项' });

    // 检查帖子是否存在且为投票帖
    var [posts] = await pool.execute('SELECT id, poll_type, poll_expires_at, user_id FROM posts WHERE id = ?', [postId]);
    if (posts.length === 0) return res.json({ code: 404, message: '帖子不存在' });
    var post = posts[0];
    if (!post.poll_type) return res.json({ code: 400, message: '此帖不是投票帖' });

    // 检查是否过期
    if (post.poll_expires_at && new Date(post.poll_expires_at) < new Date()) {
      return res.json({ code: 400, message: '投票已结束' });
    }

    // 检查选项是否属于该帖子
    var [options] = await pool.execute('SELECT id FROM poll_options WHERE id = ? AND post_id = ?', [option_id, postId]);
    if (options.length === 0) return res.json({ code: 400, message: '投票选项不存在' });

    if (post.poll_type === 'single') {
      // 单选：检查是否已投过任何选项
      var [existing] = await pool.execute('SELECT id FROM poll_votes WHERE option_id IN (SELECT id FROM poll_options WHERE post_id = ?) AND user_id = ?', [postId, userId]);
      if (existing.length > 0) return res.json({ code: 400, message: '你已经投过票了' });
    } else if (post.poll_type === 'multiple') {
      // 多选：检查是否已投过该选项
      var [existing] = await pool.execute('SELECT id FROM poll_votes WHERE option_id = ? AND user_id = ?', [option_id, userId]);
      if (existing.length > 0) return res.json({ code: 400, message: '你已经投过该选项了' });
    } else {
      return res.json({ code: 400, message: '不支持的投票类型' });
    }

    await pool.execute('INSERT INTO poll_votes (option_id, user_id) VALUES (?, ?)', [option_id, userId]);
    await pool.execute('UPDATE poll_options SET votes_count = votes_count + 1 WHERE id = ?', [option_id]);

    return res.json({ code: 200, message: '投票成功', data: { hasVoted: true } });

  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.json({ code: 400, message: '你已经投过票了' });
    console.error('投票错误:', err);
    res.json({ code: 500, message: '投票失败' });
  }
});

// 获取投票结果
router.get('/:id/poll', optionalAuth, async (req, res) => {
  try {
    var postId = req.params.id;
    var [options] = await pool.execute('SELECT * FROM poll_options WHERE post_id = ? ORDER BY id', [postId]);
    if (options.length === 0) return res.json({ code: 404, message: '此帖无投票' });

    var totalVotes = options.reduce(function(sum, o) { return sum + o.votes_count; }, 0);
    var userVote = null;
    if (req.user) {
      var [votes] = await pool.execute(
        'SELECT option_id FROM poll_votes v JOIN poll_options o ON v.option_id = o.id WHERE o.post_id = ? AND v.user_id = ? LIMIT 1',
        [postId, req.user.id]
      );
      if (votes.length > 0) userVote = votes[0].option_id;
    }

    res.json({ code: 200, data: { options: options, totalVotes: totalVotes, userVote: userVote } });
  } catch (err) {
    res.json({ code: 500, message: '获取投票失败' });
  }
});

// 增加帖子浏览量（前端主动调用，1分钟内同IP/同用户去重）
router.post('/:id/view', optionalAuth, async (req, res) => {
  try {
    const viewerIp = getClientIp(req);
    const viewerNickname = req.user ? (req.user.nickname || req.user.username) : null;
    const userId = req.user ? req.user.id : null;
    const postId = req.params.id;

    // 检查1分钟内是否已浏览过（同IP或同用户）
    let hasRecentView = false;
    if (userId) {
      const [recent] = await pool.execute(
        'SELECT id FROM post_views WHERE post_id = ? AND user_id = ? AND viewed_at > DATE_SUB(NOW(), INTERVAL 1 MINUTE) LIMIT 1',
        [postId, userId]
      );
      hasRecentView = recent.length > 0;
    } else {
      const [recent] = await pool.execute(
        'SELECT id FROM post_views WHERE post_id = ? AND viewer_ip = ? AND viewed_at > DATE_SUB(NOW(), INTERVAL 1 MINUTE) LIMIT 1',
        [postId, viewerIp]
      );
      hasRecentView = recent.length > 0;
    }

    if (hasRecentView) {
      return res.json({ code: 200, message: 'duplicate' });
    }

    // 异步增加，不阻塞响应
    setImmediate(async () => {
      try {
        const ipRegion = await getIpRegion(viewerIp);
        await pool.execute('UPDATE posts SET view_count = view_count + 1, views = views + 1 WHERE id = ?', [postId]);
        await pool.execute(
          'INSERT INTO post_views (post_id, user_id, viewer_ip, ip_region, viewer_nickname) VALUES (?, ?, ?, ?, ?)',
          [postId, userId, viewerIp, ipRegion, viewerNickname]
        );
      } catch (err) {
        console.error('增加浏览次数失败:', err.message);
      }
    });

    res.json({ code: 200, message: 'ok' });
  } catch (err) {
    console.error('增加浏览量错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取帖子浏览记录（超级管理员专用）
router.get('/:id/views', auth, async (req, res) => {
  try {
    if (req.user.role !== 'super_admin') {
      return res.json({ code: 403, message: '无权限访问' });
    }
    
    const { page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    
    const [records] = await pool.execute(`
      SELECT pv.id, pv.post_id, pv.user_id, pv.viewer_ip, pv.viewer_nickname, pv.viewed_at,
             p.title as post_title, p.content as post_content
      FROM post_views pv
      LEFT JOIN posts p ON pv.post_id = p.id
      WHERE pv.post_id = ?
      ORDER BY pv.viewed_at DESC
      LIMIT ? OFFSET ?
    `, [req.params.id, parseInt(limit), offset]);
    
    const [countResult] = await pool.execute('SELECT COUNT(*) as total FROM post_views WHERE post_id = ?', [req.params.id]);
    
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

function getTimeAgo(dateStr) {
  const now = new Date();
  const date = new Date(dateStr);
  const diff = Math.floor((now - date) / 1000);

  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + '分钟前';
  if (diff < 86400) return Math.floor(diff / 3600) + '小时前';
  if (diff < 604800) return Math.floor(diff / 86400) + '天前';
  return date.toLocaleDateString('zh-CN');
}

module.exports = router;
