const mysql = require('mysql2/promise');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const DB_NAME = process.env.DB_NAME || 'campus_wall';

// 主连接池（直接连接到目标数据库）
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4',
  dateStrings: true // 日期以字符串返回，避免时区转换
});

// 初始化数据库表
async function initDB() {
  // 第一步：用不带 database 的连接创建数据库（如果不存在）
  const initConn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    charset: 'utf8mb4'
  });

  try {
    await initConn.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    console.log('✅ 数据库已就绪：' + DB_NAME);
  } finally {
    await initConn.end();
  }

  // 第二步：用主连接池（已连到目标库）创建表
  const connection = await pool.getConnection();
  try {
    // 用户表
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INT PRIMARY KEY AUTO_INCREMENT,
        username VARCHAR(50) NOT NULL UNIQUE,
        password VARCHAR(255) NOT NULL,
        nickname VARCHAR(50) NOT NULL,
        avatar VARCHAR(255) DEFAULT '/uploads/avatars/default.png',
        email VARCHAR(100),
        role ENUM('user', 'admin', 'reviewer', 'radio_admin', 'super_admin') DEFAULT 'user' COMMENT 'user普通用户/reviewer审核员/radio_admin广播管理员/admin普通管理员/super_admin超级管理员',
        status TINYINT DEFAULT 1 COMMENT '1正常 0禁用',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    
    // 为已有 users 表添加登录追踪字段（忽略已存在的错误）
    try {
      await connection.execute('ALTER TABLE users ADD COLUMN last_login_at TIMESTAMP NULL COMMENT \'上次登录时间\' AFTER updated_at');
    } catch (e) {}
    try {
      await connection.execute('ALTER TABLE users ADD COLUMN last_login_ip VARCHAR(45) DEFAULT \'\' COMMENT \'上次登录IP\' AFTER last_login_at');
    } catch (e) {}
    try {
      await connection.execute('ALTER TABLE users ADD COLUMN last_login_region VARCHAR(100) DEFAULT \'\' COMMENT \'上次登录IP归属地\' AFTER last_login_ip');
    } catch (e) {}
    // 用户资料扩展字段（编辑资料功能）
    try {
      await connection.execute('ALTER TABLE users ADD COLUMN birthday DATE NULL COMMENT \'生日\' AFTER last_login_region');
    } catch (e) {}
    try {
      await connection.execute('ALTER TABLE users ADD COLUMN mbti VARCHAR(10) DEFAULT \'\' COMMENT \'MBTI性格\' AFTER birthday');
    } catch (e) {}
    try {
      await connection.execute('ALTER TABLE users ADD COLUMN gender VARCHAR(10) DEFAULT \'\' COMMENT \'性别\' AFTER mbti');
    } catch (e) {}
    try {
      await connection.execute('ALTER TABLE users ADD COLUMN hobbies VARCHAR(500) DEFAULT \'\' COMMENT \'兴趣爱好\' AFTER gender');
    } catch (e) {}

    // 帖子表
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS posts (
        id INT PRIMARY KEY AUTO_INCREMENT,
        user_id INT NOT NULL,
        title VARCHAR(200),
        content TEXT NOT NULL,
        images TEXT COMMENT 'JSON数组存储图片路径',
        is_anonymous TINYINT DEFAULT 0 COMMENT '1匿名 0实名',
        category VARCHAR(30) DEFAULT '日常' COMMENT '分类：日常/表白/求助/二手/社团/其他',
        likes_count INT DEFAULT 0,
        comments_count INT DEFAULT 0,
        status ENUM('pending', 'approved', 'rejected') DEFAULT 'approved',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // 评论表
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS comments (
        id INT PRIMARY KEY AUTO_INCREMENT,
        post_id INT NOT NULL,
        user_id INT NOT NULL,
        content TEXT NOT NULL,
        is_anonymous TINYINT DEFAULT 0,
        ip_address VARCHAR(50),
        ip_region VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    
    // 检查并添加评论表的IP字段（如果不存在）
    try {
      await connection.execute('ALTER TABLE comments ADD COLUMN ip_address VARCHAR(50) AFTER is_anonymous');
      await connection.execute('ALTER TABLE comments ADD COLUMN ip_region VARCHAR(100) AFTER ip_address');
    } catch (err) {
      // 字段可能已存在，忽略错误
    }

    // 点赞表
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS likes (
        id INT PRIMARY KEY AUTO_INCREMENT,
        user_id INT NOT NULL,
        post_id INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_like (user_id, post_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // 收藏表
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS favorites (
        id INT PRIMARY KEY AUTO_INCREMENT,
        user_id INT NOT NULL,
        post_id INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_favorite (user_id, post_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // 点歌时段表 (time_slots)
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS time_slots (
        id INT PRIMARY KEY AUTO_INCREMENT,
        name VARCHAR(50) NOT NULL COMMENT '时段名称',
        start_time TIME NOT NULL COMMENT '播放开始时间',
        end_time TIME NOT NULL COMMENT '播放结束时间',
        is_active TINYINT DEFAULT 1 COMMENT '1启用 0禁用',
        weekdays VARCHAR(20) DEFAULT '1,2,3,4,5' COMMENT '生效的星期，1-7',
        max_songs INT DEFAULT 10 COMMENT '最多点歌数',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // 确保 time_slots 表有 weekdays 字段（兼容已有数据库）
    try {
      const [timeColumns] = await connection.execute('SHOW COLUMNS FROM time_slots LIKE "weekdays"');
      if (timeColumns.length === 0) {
        await connection.execute('ALTER TABLE time_slots ADD COLUMN weekdays VARCHAR(20) DEFAULT \'1,2,3,4,5\' COMMENT \'生效的星期\' AFTER is_active');
        console.log('✅ time_slots 表已添加 weekdays 字段');
      }
    } catch (e) {
      // 表可能不存在，忽略错误
    }

    // 时段日期表 (slot_dates)
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS slot_dates (
        id INT PRIMARY KEY AUTO_INCREMENT,
        slot_id INT NOT NULL COMMENT '时段ID',
        play_date DATE NOT NULL COMMENT '播放日期',
        max_songs INT DEFAULT 10 COMMENT '最大点歌数',
        is_active TINYINT DEFAULT 1 COMMENT '1启用 0禁用',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_slot_date (slot_id, play_date)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // 确保 slot_dates 表有 is_active 字段，并修复已有数据
    try {
      const [dateColumns] = await connection.execute('SHOW COLUMNS FROM slot_dates LIKE "is_active"');
      if (dateColumns.length === 0) {
        await connection.execute('ALTER TABLE slot_dates ADD COLUMN is_active TINYINT DEFAULT 1 COMMENT \'1启用 0禁用\' AFTER max_songs');
        console.log('✅ slot_dates 表已添加 is_active 字段');
      }
      // 修复所有日期为启用状态
      await connection.execute('UPDATE slot_dates SET is_active = 1 WHERE is_active = 0 OR is_active IS NULL');
      console.log('✅ slot_dates 表已修复所有日期为启用状态');
    } catch (e) {
      console.error('slot_dates 表检查/修复失败:', e.message);
    }

    // 点歌时段表 (song_slots)
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS song_slots (
        id INT PRIMARY KEY AUTO_INCREMENT,
        slot_name VARCHAR(50) NOT NULL COMMENT '时段名称，如"午间点歌"',
        start_time TIME NOT NULL COMMENT '播放开始时间',
        end_time TIME NOT NULL COMMENT '播放结束时间',
        order_start_time TIME COMMENT '点歌开放开始时间，默认等于start_time',
        order_end_time TIME COMMENT '点歌开放结束时间，默认等于end_time',
        max_songs INT DEFAULT 10 COMMENT '该时段最多点歌数',
        is_active TINYINT DEFAULT 1 COMMENT '1启用 0禁用',
        weekdays VARCHAR(20) DEFAULT '1,2,3,4,5' COMMENT '生效的星期，1-7',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // 确保 song_slots 表有新字段（兼容已有数据库）
    const [slotColumns] = await connection.execute('SHOW COLUMNS FROM song_slots LIKE "order_start_time"');
    if (slotColumns.length === 0) {
      await connection.execute('ALTER TABLE song_slots ADD COLUMN order_start_time TIME DEFAULT NULL COMMENT "点歌开放开始时间"');
      await connection.execute('ALTER TABLE song_slots ADD COLUMN order_end_time TIME DEFAULT NULL COMMENT "点歌开放结束时间"');
      console.log('✅ song_slots 表已添加点歌开放时间字段');
    }
    
    // 确保 song_slots 表有 weekdays 字段
    const [weekdaysCol] = await connection.execute('SHOW COLUMNS FROM song_slots LIKE "weekdays"');
    if (weekdaysCol.length === 0) {
      await connection.execute('ALTER TABLE song_slots ADD COLUMN weekdays VARCHAR(20) DEFAULT \'1,2,3,4,5\' COMMENT \'生效的星期\' AFTER is_active');
      console.log('✅ song_slots 表已添加 weekdays 字段');
    }

    // 点歌记录表
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS song_requests (
        id INT PRIMARY KEY AUTO_INCREMENT,
        user_id INT NOT NULL,
        song_name VARCHAR(200) NOT NULL COMMENT '歌曲名',
        artist VARCHAR(200) COMMENT '歌手',
        message TEXT COMMENT '祝福语/留言',
        to_whom VARCHAR(100) COMMENT '送给谁',
        slot_id INT NOT NULL COMMENT '所属时段',
        is_anonymous TINYINT DEFAULT 0,
        status ENUM('pending', 'approved', 'rejected', 'played') DEFAULT 'pending',
        play_order INT COMMENT '播放顺序',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (slot_id) REFERENCES song_slots(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // 系统配置表
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS settings (
        id INT PRIMARY KEY AUTO_INCREMENT,
        config_key VARCHAR(50) NOT NULL UNIQUE,
        config_value TEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // 管理操作日志表
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS admin_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        admin_id INT NOT NULL,
        action VARCHAR(100) NOT NULL COMMENT '操作类型',
        detail TEXT COMMENT '操作详情',
        level ENUM('info', 'warn', 'warning', 'error') DEFAULT 'info' COMMENT '日志级别',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_admin_id (admin_id),
        INDEX idx_created_at (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='管理操作日志'
    `);

    // 为已有的 admin_logs 表添加 'warn' 枚举值（兼容旧数据库）
    try {
      await connection.execute(`
        ALTER TABLE admin_logs 
        MODIFY COLUMN level ENUM('info', 'warn', 'warning', 'error') DEFAULT 'info' COMMENT '日志级别'
      `);
      console.log('✅ admin_logs 表已添加 warn 枚举值');
    } catch (e) {
      // 忽略错误，可能表不存在或字段已修改
    }

    // 系统公告表
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS notices (
        id INT AUTO_INCREMENT PRIMARY KEY,
        admin_id INT NOT NULL,
        title VARCHAR(200) NOT NULL COMMENT '公告标题',
        content TEXT NOT NULL COMMENT '公告内容',
        is_top TINYINT(1) DEFAULT 0 COMMENT '是否置顶',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_is_top (is_top)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='系统公告'
    `);

    // 插入默认系统设置
    const defaultSettings = [
      { key: 'site_name', value: '嘉二の墙墙' },
      { key: 'site_description', value: '校园信息交流平台' },
      { key: 'allow_register', value: 'true' },
      { key: 'post_review', value: 'true' },
      { key: 'song_enabled', value: 'true' }
    ];
    for (var i = 0; i < defaultSettings.length; i++) {
      var s = defaultSettings[i];
      var [existing] = await connection.execute('SELECT id FROM settings WHERE config_key = ?', [s.key]);
      if (existing.length === 0) {
        await connection.execute('INSERT INTO settings (config_key, config_value) VALUES (?, ?)', [s.key, s.value]);
      }
    }

    // 插入默认时段（已禁用，由管理员手动管理）
    // const [slots] = await connection.execute('SELECT id FROM song_slots');
    // if (slots.length === 0) {
    //   await connection.execute(
    //     'INSERT INTO song_slots (slot_name, start_time, end_time, max_songs, weekdays) VALUES (?, ?, ?, ?, ?)',
    //     ['午间点歌', '12:00:00', '13:00:00', 10, '1,2,3,4,5']
    //   );
    //   await connection.execute(
    //     'INSERT INTO song_slots (slot_name, start_time, end_time, max_songs, weekdays) VALUES (?, ?, ?, ?, ?)',
    //     ['晚间点歌', '18:00:00', '19:00:00', 15, '1,2,3,4,5']
    //   );
    //   console.log('✅ 默认点歌时段已创建');
    // }

    // 确保 posts 表有 IP 字段
    const [postsColumns] = await connection.execute('SHOW COLUMNS FROM posts LIKE "ip_address"');
    if (postsColumns.length === 0) {
      await connection.execute('ALTER TABLE posts ADD COLUMN ip_address VARCHAR(45) DEFAULT NULL COMMENT "发帖IP"');
      await connection.execute('ALTER TABLE posts ADD COLUMN ip_region VARCHAR(100) DEFAULT NULL COMMENT "IP归属地"');
      console.log('✅ posts 表已添加 ip_address 和 ip_region 字段');
    }

    // 确保 posts 表有置顶字段
    const [pinnedColumns] = await connection.execute('SHOW COLUMNS FROM posts LIKE "is_pinned"');
    if (pinnedColumns.length === 0) {
      await connection.execute('ALTER TABLE posts ADD COLUMN is_pinned TINYINT(1) DEFAULT 0 COMMENT "是否置顶"');
      console.log('✅ posts 表已添加 is_pinned 字段');
    }

    // 确保 posts 表有浏览次数字段
    const [viewsColumns] = await connection.execute('SHOW COLUMNS FROM posts LIKE "views"');
    if (viewsColumns.length === 0) {
      await connection.execute('ALTER TABLE posts ADD COLUMN views INT DEFAULT 0 COMMENT "浏览次数"');
      console.log('✅ posts 表已添加 views 字段');
    }

    // 兼容 view_count 字段（某些前端代码使用此名称）
    const [viewCountColumns] = await connection.execute('SHOW COLUMNS FROM posts LIKE "view_count"');
    if (viewCountColumns.length === 0) {
      await connection.execute('ALTER TABLE posts ADD COLUMN view_count INT DEFAULT 0 COMMENT "浏览次数(兼容别名)"');
      // 同步现有 views 数据到 view_count
      await connection.execute('UPDATE posts SET view_count = views');
      console.log('✅ posts 表已添加 view_count 字段（兼容别名）');
    }

    // 浏览记录表（记录谁浏览了什么帖子，用于超级管理员查看）
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS post_views (
        id INT AUTO_INCREMENT PRIMARY KEY,
        post_id INT NOT NULL COMMENT '被浏览的帖子',
        user_id INT COMMENT '浏览的用户，NULL表示未登录',
        viewer_ip VARCHAR(45) COMMENT '浏览者IP',
        viewer_nickname VARCHAR(50) COMMENT '浏览者昵称（如果是匿名用户或未登录用户）',
        viewed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_post_id (post_id),
        INDEX idx_user_id (user_id),
        INDEX idx_viewed_at (viewed_at),
        FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='帖子浏览记录'
    `);

    // 给 post_views 表添加 ip_region 字段
    try {
      await connection.execute(`
        ALTER TABLE post_views
        ADD COLUMN ip_region VARCHAR(100) DEFAULT NULL COMMENT '浏览者IP归属地'
      `);
      console.log('✅ post_views 表已添加 ip_region 字段');
    } catch (e) {
      // 字段可能已存在，忽略错误
    }

    // 头衔表
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS user_titles (
        id INT AUTO_INCREMENT PRIMARY KEY,
        title_name VARCHAR(50) NOT NULL COMMENT '头衔名称',
        title_color VARCHAR(50) DEFAULT '#FF6B9D' COMMENT '头衔颜色',
        title_bg VARCHAR(50) DEFAULT 'rgba(255,107,157,0.1)' COMMENT '头衔背景色',
        icon VARCHAR(10) DEFAULT '⭐' COMMENT '头衔图标',
        sort_order INT DEFAULT 0 COMMENT '排序权重',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户头衔'
    `);

    // 用户头衔关联表
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS user_title_relations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        title_id INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_user_title (user_id, title_id),
        INDEX idx_user_id (user_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (title_id) REFERENCES user_titles(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户头衔关联'
    `);

    // 用户邮件通知偏好表
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS user_notify_settings (
        user_id INT PRIMARY KEY,
        notify_comment TINYINT(1) DEFAULT 1 COMMENT '收到评论',
        notify_like TINYINT(1) DEFAULT 1 COMMENT '收到点赞',
        notify_mention TINYINT(1) DEFAULT 1 COMMENT '被提及',
        notify_follower TINYINT(1) DEFAULT 1 COMMENT '新粉丝',
        notify_post_approved TINYINT(1) DEFAULT 1 COMMENT '帖子审核通过',
        notify_post_rejected TINYINT(1) DEFAULT 1 COMMENT '帖子审核未通过',
        notify_song_approved TINYINT(1) DEFAULT 1 COMMENT '点歌审核通过',
        notify_song_rejected TINYINT(1) DEFAULT 1 COMMENT '点歌审核未通过',
        notify_song_played TINYINT(1) DEFAULT 1 COMMENT '点歌已播放',
        notify_feedback_reply TINYINT(1) DEFAULT 1 COMMENT '反馈回复',
        notify_follow_post TINYINT(1) DEFAULT 1 COMMENT '关注的人发帖',
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户邮件通知偏好'
    `);

    // 兼容旧表：如果缺少字段则补充
    var migrateFields = [
      "ALTER TABLE user_notify_settings ADD COLUMN notify_follow_post TINYINT(1) DEFAULT 1 COMMENT '关注的人发帖' AFTER notify_feedback_reply",
      "ALTER TABLE user_notify_settings ADD COLUMN notify_message TINYINT(1) DEFAULT 1 COMMENT '收到私信' AFTER notify_follow_post",
      "ALTER TABLE conversations ADD COLUMN user1_dnd TINYINT(1) DEFAULT 0 COMMENT '用户1免打扰' AFTER updated_at",
      "ALTER TABLE conversations ADD COLUMN user2_dnd TINYINT(1) DEFAULT 0 COMMENT '用户2免打扰' AFTER user1_dnd",
      "ALTER TABLE conversations ADD COLUMN user1_cleared_at TIMESTAMP NULL COMMENT '用户1清空时间' AFTER user2_dnd",
      "ALTER TABLE conversations ADD COLUMN user2_cleared_at TIMESTAMP NULL COMMENT '用户2清空时间' AFTER user1_cleared_at",
      "ALTER TABLE conversations ADD COLUMN user1_hidden_at TIMESTAMP NULL COMMENT '用户1删除会话时间' AFTER user2_cleared_at",
      "ALTER TABLE conversations ADD COLUMN user2_hidden_at TIMESTAMP NULL COMMENT '用户2删除会话时间' AFTER user1_hidden_at",
      "ALTER TABLE users ADD COLUMN openid VARCHAR(64) DEFAULT NULL COMMENT '微信openid' AFTER email",
      "ALTER TABLE song_requests ADD COLUMN deleted_at TIMESTAMP NULL COMMENT '软删除时间' AFTER play_order"
    ];
    for (var i = 0; i < migrateFields.length; i++) {
      try {
        await pool.execute(migrateFields[i]);
      } catch (e) {
        // 字段已存在则忽略
      }
    }

    // 创建微信绑定记录表
    try {
      await pool.execute(`
        CREATE TABLE IF NOT EXISTS wechat_bindings (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          scene_id VARCHAR(64) NOT NULL COMMENT '场景ID',
          openid VARCHAR(64) DEFAULT NULL COMMENT '微信openid',
          used TINYINT(1) DEFAULT 0 COMMENT '是否已使用',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          bound_at TIMESTAMP NULL COMMENT '绑定时间',
          UNIQUE KEY idx_scene (scene_id),
          INDEX idx_user (user_id),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='微信绑定关系'
      `);
    } catch (e) {
      if (e.code !== 'ER_TABLE_EXISTS_ERR') throw e;
    }

    // 微信待关注队列（订阅号手动验证用）
    try {
      await connection.execute(`
        CREATE TABLE IF NOT EXISTS wechat_pending_follows (
          id INT AUTO_INCREMENT PRIMARY KEY,
          openid VARCHAR(64) NOT NULL COMMENT '微信openid',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_openid (openid),
          INDEX idx_created (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='微信关注待绑定队列'
      `);
    } catch (e) {
      if (e.code !== 'ER_TABLE_EXISTS_ERR') throw e;
    }

    // AI 对话记忆表
    try {
      await connection.execute(`
        CREATE TABLE IF NOT EXISTS ai_conversations (
          id INT AUTO_INCREMENT PRIMARY KEY,
          openid VARCHAR(64) NOT NULL COMMENT '微信用户openid',
          role ENUM('user', 'assistant') NOT NULL COMMENT '角色',
          content TEXT NOT NULL COMMENT '消息内容',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_openid (openid),
          INDEX idx_created (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='AI对话记录'
      `);
      console.log('✅ ai_conversations 表已创建');
    } catch (e) {
      if (e.code !== 'ER_TABLE_EXISTS_ERR') throw e;
    }

    // 私信会话表
    try {
      await connection.execute(`
        CREATE TABLE IF NOT EXISTS conversations (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user1_id INT NOT NULL COMMENT '用户1ID',
          user2_id INT NOT NULL COMMENT '用户2ID',
          last_message_at TIMESTAMP NULL COMMENT '最后消息时间',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY unique_conversation (user1_id, user2_id),
          INDEX idx_user1 (user1_id),
          INDEX idx_user2 (user2_id),
          INDEX idx_last_message (last_message_at),
          FOREIGN KEY (user1_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (user2_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='私信会话'
      `);
      console.log('✅ conversations 表已创建');
    } catch (e) {
      if (e.code !== 'ER_TABLE_EXISTS_ERR') throw e;
    }

    // 私信消息表
    try {
      await connection.execute(`
        CREATE TABLE IF NOT EXISTS messages (
          id INT AUTO_INCREMENT PRIMARY KEY,
          conversation_id INT NOT NULL COMMENT '会话ID',
          sender_id INT NOT NULL COMMENT '发送者ID',
          content TEXT NOT NULL COMMENT '消息内容',
          is_read TINYINT(1) DEFAULT 0 COMMENT '是否已读',
          read_at TIMESTAMP NULL COMMENT '阅读时间',
          deleted_at TIMESTAMP NULL COMMENT '删除时间（软删除）',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_conversation (conversation_id),
          INDEX idx_sender (sender_id),
          INDEX idx_created (created_at),
          INDEX idx_is_read (is_read),
          FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
          FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='私信消息'
      `);
      console.log('✅ messages 表已创建');
    } catch (e) {
      if (e.code !== 'ER_TABLE_EXISTS_ERR') throw e;
    }

    // 用户黑名单表
    try {
      await connection.execute(`
        CREATE TABLE IF NOT EXISTS blocked_users (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL COMMENT '屏蔽者ID',
          blocked_user_id INT NOT NULL COMMENT '被屏蔽者ID',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY unique_block (user_id, blocked_user_id),
          INDEX idx_user (user_id),
          INDEX idx_blocked (blocked_user_id),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (blocked_user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户黑名单'
      `);
      console.log('✅ blocked_users 表已创建');
    } catch (e) {
      if (e.code !== 'ER_TABLE_EXISTS_ERR') throw e;
    }

    for (var i = 0; i < migrateFields.length; i++) {
      try {
        await pool.execute(migrateFields[i]);
      } catch (e) {
        // 字段已存在则忽略
      }
    }
  } catch (err) {
    console.error('❌ 数据库初始化失败:', err.message);
    throw err;
  } finally {
    connection.release();
  }
}

module.exports = { pool, initDB };
