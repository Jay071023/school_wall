const mysql = require('mysql2/promise');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const DB_NAME = process.env.DB_NAME || 'campus_wall';

const NOTIFICATIONS_TABLE_SQL = `
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
    INDEX idx_notifications_user_created (user_id, created_at),
    INDEX idx_created (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

const NOTIFICATIONS_INDEXES = [
  ['idx_user_read', '(`user_id`, `is_read`)'],
  ['idx_notifications_user_created', '(`user_id`, `created_at`)'],
  ['idx_created', '(`created_at`)']
];

/**
 * 确保通知表及其查询索引存在。
 * 共享给启动初始化和历史初始化接口，避免重复维护建表 SQL。
 */
async function ensureNotificationsTable(executor) {
  await executor.execute(NOTIFICATIONS_TABLE_SQL);

  for (const [indexName, indexDefinition] of NOTIFICATIONS_INDEXES) {
    const [indexes] = await executor.query(
      'SHOW INDEX FROM notifications WHERE Key_name = ?',
      [indexName]
    );
    if (indexes.length === 0) {
      try {
        await executor.query(
          `ALTER TABLE notifications ADD INDEX \`${indexName}\` ${indexDefinition}`
        );
      } catch (err) {
        // 并发初始化时可能由另一请求先完成建索引。
        if (err.code !== 'ER_DUP_KEYNAME') throw err;
      }
    }
  }
}

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
        openid VARCHAR(64) DEFAULT NULL COMMENT '微信openid，用于微信登录',
        role ENUM('user', 'admin', 'reviewer', 'radio_admin', 'super_admin') DEFAULT 'user' COMMENT 'user普通用户/reviewer审核员/radio_admin广播管理员/admin普通管理员/super_admin超级管理员',
        status TINYINT DEFAULT 1 COMMENT '1正常 0禁用',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // 为已有 users 表添加 openid 字段
    try {
      await connection.execute('ALTER TABLE users ADD COLUMN openid VARCHAR(64) DEFAULT NULL COMMENT \'微信openid\' AFTER email');
    } catch (e) { console.error('[DB迁移]', e.message); }
    
    // 为已有 users 表添加登录追踪字段（忽略已存在的错误）
    try {
      await connection.execute('ALTER TABLE users ADD COLUMN last_login_at TIMESTAMP NULL COMMENT \'上次登录时间\' AFTER updated_at');
    } catch (e) { console.error('[DB迁移]', e.message); }
    try {
      await connection.execute('ALTER TABLE users ADD COLUMN last_login_ip VARCHAR(45) DEFAULT \'\' COMMENT \'上次登录IP\' AFTER last_login_at');
    } catch (e) { console.error('[DB迁移]', e.message); }
    try {
      await connection.execute('ALTER TABLE users ADD COLUMN last_login_region VARCHAR(100) DEFAULT \'\' COMMENT \'上次登录IP归属地\' AFTER last_login_ip');
    } catch (e) { console.error('[DB迁移]', e.message); }
    // 用户资料扩展字段（编辑资料功能）
    try {
      await connection.execute('ALTER TABLE users ADD COLUMN birthday DATE NULL COMMENT \'生日\' AFTER last_login_region');
    } catch (e) { console.error('[DB迁移]', e.message); }
    try {
      await connection.execute('ALTER TABLE users ADD COLUMN mbti VARCHAR(10) DEFAULT \'\' COMMENT \'MBTI性格\' AFTER birthday');
    } catch (e) { console.error('[DB迁移]', e.message); }
    try {
      await connection.execute('ALTER TABLE users ADD COLUMN gender VARCHAR(10) DEFAULT \'\' COMMENT \'性别\' AFTER mbti');
    } catch (e) { console.error('[DB迁移]', e.message); }
    try {
      await connection.execute('ALTER TABLE users ADD COLUMN hobbies VARCHAR(500) DEFAULT \'\' COMMENT \'兴趣爱好\' AFTER gender');
    } catch (e) { console.error('[DB迁移]', e.message); }
    // 封禁理由
    try {
      await connection.execute('ALTER TABLE users ADD COLUMN ban_reason VARCHAR(500) DEFAULT NULL COMMENT \'封禁原因\' AFTER status');
    } catch (e) { console.error('[DB迁移]', e.message); }
    // 封禁后登录尝试记录
    try {
      await connection.execute('ALTER TABLE users ADD COLUMN ban_attempt_ip VARCHAR(45) DEFAULT \'\' COMMENT \'封禁后最后一次登录IP\' AFTER ban_reason');
    } catch (e) { console.error('[DB迁移]', e.message); }
    try {
      await connection.execute('ALTER TABLE users ADD COLUMN ban_attempt_count INT DEFAULT 0 COMMENT \'封禁后登录尝试次数\' AFTER ban_attempt_ip');
    } catch (e) { console.error('[DB迁移]', e.message); }

    // 通知表必须在启动时完成，保证业务通知写入不依赖管理员手动访问初始化接口。
    await ensureNotificationsTable(connection);

    // 帖子表
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS posts (
        id INT PRIMARY KEY AUTO_INCREMENT,
        user_id INT NOT NULL,
        title VARCHAR(200),
        content TEXT NOT NULL,
        images TEXT COMMENT 'JSON数组存储图片路径',
        video_url VARCHAR(500) DEFAULT NULL COMMENT '帖子视频路径',
        video_poster VARCHAR(500) DEFAULT NULL COMMENT '视频首帧封面路径',
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

    // 评论点赞表
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS comment_likes (
        id INT PRIMARY KEY AUTO_INCREMENT,
        comment_id INT NOT NULL,
        user_id INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_comment_like (comment_id, user_id),
        FOREIGN KEY (comment_id) REFERENCES comments(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // 检查并添加评论点赞数字段（如果不存在）
    try {
      await connection.execute('ALTER TABLE comments ADD COLUMN likes_count INT DEFAULT 0 AFTER is_anonymous');
    } catch (err) {
      // 字段可能已存在，忽略错误
    }

    // 评论回复表
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS comment_replies (
        id INT PRIMARY KEY AUTO_INCREMENT,
        comment_id INT NOT NULL,
        user_id INT NOT NULL,
        content TEXT NOT NULL,
        is_anonymous TINYINT DEFAULT 0,
        ip_address VARCHAR(50),
        ip_region VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (comment_id) REFERENCES comments(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // 检查并添加评论回复的IP字段（如果不存在）
    try {
      await connection.execute('ALTER TABLE comment_replies ADD COLUMN ip_address VARCHAR(50) AFTER is_anonymous');
      await connection.execute('ALTER TABLE comment_replies ADD COLUMN ip_region VARCHAR(100) AFTER ip_address');
    } catch (err) {
      // 字段可能已存在，忽略错误
    }

    // 检查并添加评论回复的点赞数字段
    try {
      await connection.execute('ALTER TABLE comment_replies ADD COLUMN likes_count INT DEFAULT 0 AFTER is_anonymous');
    } catch (err) {
      // 字段可能已存在，忽略错误
    }

    // 回复点赞表
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS comment_reply_likes (
        id INT PRIMARY KEY AUTO_INCREMENT,
        reply_id INT NOT NULL,
        user_id INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_reply_like (reply_id, user_id),
        FOREIGN KEY (reply_id) REFERENCES comment_replies(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

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

    // 覆盖首页评论、收藏列表和帖子浏览记录的常用筛选/排序组合。
    // 用 SHOW INDEX 判断，兼容已有数据库和 MySQL 5.7。
    const supportingIndexes = [
      ['comments', 'idx_comments_post_created', '(`post_id`, `created_at`)'],
      ['favorites', 'idx_favorites_user_created', '(`user_id`, `created_at`)']
    ];
    for (const [tableName, indexName, indexDefinition] of supportingIndexes) {
      const [indexes] = await connection.query(`SHOW INDEX FROM \`${tableName}\` WHERE Key_name = ?`, [indexName]);
      if (indexes.length === 0) {
        await connection.query(`ALTER TABLE \`${tableName}\` ADD INDEX \`${indexName}\` ${indexDefinition}`);
      }
    }

    // 点歌时段表 (time_slots)
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS time_slots (
        id INT PRIMARY KEY AUTO_INCREMENT,
        name VARCHAR(50) NOT NULL COMMENT '时段名称',
        start_time TIME NOT NULL COMMENT '播放开始时间',
        end_time TIME NOT NULL COMMENT '播放结束时间',
        is_active TINYINT DEFAULT 1 COMMENT '1启用 0禁用',
        weekdays VARCHAR(20) DEFAULT '1,2,3,4,5' COMMENT '生效的星期，周日0至周六6',
        effective_start_date DATE DEFAULT NULL COMMENT '周期从此日期开始生效，NULL表示立即生效',
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

    // 周期时段的生效日期。NULL 兼容旧时段，表示不限制起始日。
    try {
      const [timeStartDateColumns] = await connection.execute('SHOW COLUMNS FROM time_slots LIKE "effective_start_date"');
      if (timeStartDateColumns.length === 0) {
        await connection.execute('ALTER TABLE time_slots ADD COLUMN effective_start_date DATE DEFAULT NULL COMMENT \'周期从此日期开始生效，NULL表示立即生效\' AFTER weekdays');
        console.log('✅ time_slots 表已添加周期生效日期字段');
      }
    } catch (e) {
      console.error('time_slots 生效日期字段检查失败:', e.message);
    }

    // 时段日期表 (slot_dates)
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS slot_dates (
        id INT PRIMARY KEY AUTO_INCREMENT,
        slot_id INT NOT NULL COMMENT '时段ID',
        play_date DATE NOT NULL COMMENT '播放日期',
        max_songs INT DEFAULT 10 COMMENT '最大点歌数',
        is_active TINYINT DEFAULT 1 COMMENT '1启用 0禁用',
        manual_override TINYINT DEFAULT 0 COMMENT '1为管理员单日例外，不随星期周期重置',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_slot_date (slot_id, play_date)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // 确保 slot_dates 表有 is_active 字段。is_active=0 是管理员保留的
    // “该日期不开放投稿”例外，绝不能在启动时重置，否则自动补齐会让
    // 已关闭日期重新对用户开放。
    try {
      const [dateColumns] = await connection.execute('SHOW COLUMNS FROM slot_dates LIKE "is_active"');
      if (dateColumns.length === 0) {
        await connection.execute('ALTER TABLE slot_dates ADD COLUMN is_active TINYINT DEFAULT 1 COMMENT \'1启用 0禁用\' AFTER max_songs');
        console.log('✅ slot_dates 表已添加 is_active 字段');
      }
      await connection.execute('UPDATE slot_dates SET is_active = 1 WHERE is_active IS NULL');
    } catch (e) {
      console.error('slot_dates 表检查/修复失败:', e.message);
    }

    // 单日例外：允许在编辑日历中临时加播或停播，后续改星期时不能被周期维护覆盖。
    try {
      const [overrideColumns] = await connection.execute('SHOW COLUMNS FROM slot_dates LIKE "manual_override"');
      if (overrideColumns.length === 0) {
        await connection.execute('ALTER TABLE slot_dates ADD COLUMN manual_override TINYINT DEFAULT 0 COMMENT \'1为管理员单日例外，不随星期周期重置\' AFTER is_active');
        console.log('✅ slot_dates 表已添加单日例外字段');
      }
      await connection.execute('UPDATE slot_dates SET manual_override = 0 WHERE manual_override IS NULL');
    } catch (e) {
      console.error('slot_dates 单日例外字段检查失败:', e.message);
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

    // 点歌拒绝理由：保留最近一次审核使用的说明，方便后台追溯。
    const [songRejectReasonCol] = await connection.execute('SHOW COLUMNS FROM song_requests LIKE "reject_reason"');
    if (songRejectReasonCol.length === 0) {
      await connection.execute('ALTER TABLE song_requests ADD COLUMN reject_reason VARCHAR(500) DEFAULT NULL COMMENT \'审核拒绝理由\' AFTER status');
      console.log('✅ song_requests 表已添加 reject_reason 字段');
    }

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
      { key: 'site_name', value: '示例校园墙' },
      { key: 'site_description', value: '校园信息交流平台' },
      { key: 'allow_register', value: 'true' },
      { key: 'register_email_verify_enabled', value: 'false' },
      { key: 'post_review', value: 'true' },
      { key: 'song_enabled', value: 'true' },
      { key: 'song_reject_reasons', value: JSON.stringify([
        '当前播放时段名额已满，请选择其他时段再点歌。',
        '本周暂未开放点歌，请下周再来。',
        '歌曲内容不适合校园广播，请更换其他歌曲。',
        '歌曲信息不完整，请补充歌名或歌手后重新提交。',
        '该歌曲已重复点歌，请选择其他歌曲。',
        '当前歌曲暂时无法播放，请更换其他歌曲。'
      ]) }
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

    try {
      const [indexes] = await connection.query('SHOW INDEX FROM `post_views` WHERE Key_name = ?', ['idx_post_views_post_viewed']);
      if (indexes.length === 0) {
        await connection.query('ALTER TABLE `post_views` ADD INDEX `idx_post_views_post_viewed` (`post_id`, `viewed_at`)');
      }
    } catch (e) {
      console.error('[DB迁移] post_views 联合索引创建失败:', e.message);
    }

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

    // 点歌表历史版本缺少部分字段时，先补字段再创建查询索引。
    // 使用 SHOW COLUMNS/SHOW INDEX 兼容 MySQL 5.7，不依赖 ADD IF NOT EXISTS。
    const songRequestColumns = [
      ['slot_date_id', 'INT NULL COMMENT \'所属时段日期\' AFTER slot_id'],
      ['hot_score', 'INT NOT NULL DEFAULT 0 COMMENT \'投票热度\' AFTER play_order']
    ];
    for (const [columnName, definition] of songRequestColumns) {
      const [columns] = await connection.query('SHOW COLUMNS FROM song_requests LIKE ?', [columnName]);
      if (columns.length === 0) {
        await connection.query(`ALTER TABLE song_requests ADD COLUMN \`${columnName}\` ${definition}`);
      }
    }

    // 歌曲热度投票表必须由启动初始化兜底创建，避免新环境只部署代码后
    // /api/songs/vote 因缺表直接返回 500。同一用户对同一首歌只保留一票。
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS song_votes (
        id INT PRIMARY KEY AUTO_INCREMENT,
        song_request_id INT NOT NULL,
        user_id INT NOT NULL,
        vote_type ENUM('up', 'down') NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_song_vote (song_request_id, user_id),
        INDEX idx_song_votes_user (user_id),
        FOREIGN KEY (song_request_id) REFERENCES song_requests(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='点歌热度投票'
    `);
    const songRequestIndexes = [
      ['idx_song_deleted_status_created', '(`deleted_at`, `status`, `created_at`)'],
      ['idx_song_slot_status_deleted', '(`slot_date_id`, `status`, `deleted_at`)'],
      ['idx_song_user_created', '(`user_id`, `created_at`)'],
      ['idx_song_user_slot_created', '(`user_id`, `slot_id`, `created_at`, `deleted_at`)']
    ];
    for (const [indexName, indexDefinition] of songRequestIndexes) {
      const [indexes] = await connection.query('SHOW INDEX FROM song_requests WHERE Key_name = ?', [indexName]);
      if (indexes.length === 0) {
        await connection.query(`ALTER TABLE song_requests ADD INDEX \`${indexName}\` ${indexDefinition}`);
      }
    }

    // 回收站字段必须由启动迁移保证存在，不能只依赖管理员手动点击初始化接口。
    const postColumns = [
      ['is_deleted', 'TINYINT(1) NOT NULL DEFAULT 0 COMMENT \'是否已移入回收站\''],
      ['deleted_at', 'TIMESTAMP NULL DEFAULT NULL COMMENT \'移入回收站时间\''],
      ['video_url', 'VARCHAR(500) DEFAULT NULL COMMENT \'帖子视频路径\''],
      ['video_poster', 'VARCHAR(500) DEFAULT NULL COMMENT \'视频首帧封面路径\''],
      ['poll_type', 'ENUM(\'single\', \'multiple\') DEFAULT NULL COMMENT \'投票类型\''],
      ['poll_expires_at', 'DATETIME DEFAULT NULL COMMENT \'投票截止时间\'']
    ];
    for (const [columnName, definition] of postColumns) {
      const [columns] = await connection.query('SHOW COLUMNS FROM posts LIKE ?', [columnName]);
      if (columns.length === 0) {
        await connection.query(`ALTER TABLE posts ADD COLUMN \`${columnName}\` ${definition}`);
      }
    }
    const postIndexes = [
      ['idx_posts_feed', '(`is_deleted`, `status`, `created_at`)'],
      ['idx_posts_author_status', '(`user_id`, `is_deleted`, `status`, `created_at`)']
    ];
    for (const [indexName, indexDefinition] of postIndexes) {
      const [indexes] = await connection.query('SHOW INDEX FROM posts WHERE Key_name = ?', [indexName]);
      if (indexes.length === 0) {
        await connection.query(`ALTER TABLE posts ADD INDEX \`${indexName}\` ${indexDefinition}`);
      }
    }

    // 投票帖选项与投票记录也纳入启动迁移，保证全新数据库与线上历史库
    // 使用同一套初始化路径。路由中的事务会再锁定帖子行处理并发投票。
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS poll_options (
        id INT PRIMARY KEY AUTO_INCREMENT,
        post_id INT NOT NULL,
        option_text VARCHAR(255) NOT NULL,
        votes_count INT NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_poll_options_post (post_id),
        FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='帖子投票选项'
    `);
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS poll_votes (
        id INT PRIMARY KEY AUTO_INCREMENT,
        option_id INT NOT NULL,
        user_id INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_poll_vote (option_id, user_id),
        INDEX idx_poll_votes_user (user_id),
        FOREIGN KEY (option_id) REFERENCES poll_options(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='帖子投票记录'
    `);

    // 列表、清理和预约名额查询使用的联合索引。SHOW INDEX + ALTER TABLE
    // 保持 MySQL 5.7 兼容；预约表由旧版本/独立迁移创建时，暂时不存在也不阻塞启动。
    const optionalPerformanceIndexes = [
      ['users', 'idx_users_created_at', '(`created_at`)'],
      ['comments', 'idx_comments_post_created_id', '(`post_id`, `created_at`, `id`)'],
      ['slot_reservations', 'idx_reservations_slot_date_status', '(`slot_id`, `reservation_date`, `status`)'],
      ['slot_reservations', 'idx_reservations_user_slot_date_status', '(`user_id`, `slot_id`, `reservation_date`, `status`)']
    ];
    for (const [tableName, indexName, indexDefinition] of optionalPerformanceIndexes) {
      try {
        const [indexes] = await connection.query(
          `SHOW INDEX FROM \`${tableName}\` WHERE Key_name = ?`,
          [indexName]
        );
        if (indexes.length === 0) {
          await connection.query(
            `ALTER TABLE \`${tableName}\` ADD INDEX \`${indexName}\` ${indexDefinition}`
          );
        }
      } catch (e) {
        if (e.code !== 'ER_NO_SUCH_TABLE') {
          console.error(`[DB迁移] ${tableName}.${indexName} 创建失败:`, e.message);
        }
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
    // 兼容旧表缺少 bind_code 列
    try { await connection.execute("SELECT bind_code FROM wechat_bindings LIMIT 0"); } catch (e) {
      try { await connection.execute('ALTER TABLE wechat_bindings ADD COLUMN bind_code VARCHAR(20) DEFAULT NULL COMMENT \'验证码\' AFTER scene_id'); } catch (e2) { if (e2.code !== 'ER_DUP_FIELDNAME') throw e2; }
    }

    // 登录失败记录表（防暴力破解）
    try {
      await connection.execute(`
        CREATE TABLE IF NOT EXISTS login_attempts (
          id INT AUTO_INCREMENT PRIMARY KEY,
          ip VARCHAR(45) NOT NULL COMMENT '登录IP',
          username VARCHAR(50) NOT NULL COMMENT '尝试的用户名',
          success TINYINT(1) DEFAULT 0 COMMENT '是否成功',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_ip (ip),
          INDEX idx_username (username),
          INDEX idx_created (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='登录尝试记录'
      `);
      console.log('✅ login_attempts 表已创建');
    } catch (e) {
      if (e.code !== 'ER_TABLE_EXISTS_ERR') throw e;
    }

    // 微信注册验证码表（注册流程用）
    try {
      await connection.execute(`
        CREATE TABLE IF NOT EXISTS wechat_reg_codes (
          id INT AUTO_INCREMENT PRIMARY KEY,
          code VARCHAR(20) NOT NULL COMMENT '验证码 REG_ 开头',
          openid VARCHAR(64) DEFAULT NULL COMMENT '验证用户的微信openid',
          form_data JSON COMMENT '注册表单数据',
          verified TINYINT(1) DEFAULT 0 COMMENT '是否已验证（用户在微信发送了code）',
          used TINYINT(1) DEFAULT 0 COMMENT '是否已用于注册',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          verified_at TIMESTAMP NULL COMMENT '微信验证时间',
          INDEX idx_code (code),
          INDEX idx_verified (verified)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='微信注册验证码'
      `);
      console.log('✅ wechat_reg_codes 表已创建');
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

    // 微信投稿会话表
    try {
      await connection.execute(`
        CREATE TABLE IF NOT EXISTS wechat_submit_sessions (
          openid VARCHAR(64) PRIMARY KEY COMMENT '微信用户openid',
          step VARCHAR(30) DEFAULT 'idle' COMMENT '状态: idle/awaiting_title/awaiting_content/awaiting_polish_choice/awaiting_polish/awaiting_image',
          title VARCHAR(200) COMMENT '投稿标题',
          content TEXT COMMENT '投稿内容（用户原文）',
          polished_content TEXT COMMENT 'AI润色后的内容',
          images TEXT COMMENT 'JSON数组: 已上传图片路径',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='微信投稿会话状态'
      `);
      console.log('✅ wechat_submit_sessions 表已创建');
    } catch (e) {
      if (e.code !== 'ER_TABLE_EXISTS_ERR') throw e;
    }
    // 兼容旧表缺少 polished_content / images 列
    try { await connection.execute("SELECT polished_content FROM wechat_submit_sessions LIMIT 0"); } catch (e) {
      try { await connection.execute('ALTER TABLE wechat_submit_sessions ADD COLUMN polished_content TEXT COMMENT \'AI润色后的内容\' AFTER content'); } catch (e2) { if (e2.code !== 'ER_DUP_FIELDNAME') throw e2; }
    }
    try { await connection.execute("SELECT images FROM wechat_submit_sessions LIMIT 0"); } catch (e) {
      try { await connection.execute('ALTER TABLE wechat_submit_sessions ADD COLUMN images TEXT COMMENT \'JSON数组: 已上传图片路径\' AFTER polished_content'); } catch (e2) { if (e2.code !== 'ER_DUP_FIELDNAME') throw e2; }
    }
    // 兼容旧表 step 列长度不足
    try { await connection.execute('ALTER TABLE wechat_submit_sessions MODIFY COLUMN step VARCHAR(30) DEFAULT \'idle\' COMMENT \'状态: idle/awaiting_title/awaiting_content/awaiting_polish_choice/awaiting_polish/awaiting_image\''); } catch (e) { console.error('[DB迁移]', e.message); }

    // 微信点歌会话表（每日推歌专用）
    try {
      await connection.execute(`
        CREATE TABLE IF NOT EXISTS wechat_song_recs (
          openid VARCHAR(64) PRIMARY KEY COMMENT '微信用户openid',
          step VARCHAR(30) DEFAULT 'idle' COMMENT '状态: idle/song_awaiting_song/song_awaiting_artist/song_awaiting_to_whom/song_awaiting_message/song_awaiting_confirm',
          song_name VARCHAR(200),
          artist VARCHAR(200),
          to_whom VARCHAR(100),
          message TEXT,
          intro TEXT,
          display_name VARCHAR(30) DEFAULT '' COMMENT '用户自选显示昵称',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='微信推歌会话状态'
      `);
      console.log('✅ wechat_song_recs 表已创建');
    } catch (e) {
      if (e.code !== 'ER_TABLE_EXISTS_ERR') throw e;
    }

    // 每日推歌推荐表（和校墙电台点歌完全独立）
    try {
      await connection.execute(`
        CREATE TABLE IF NOT EXISTS daily_song_recs (
          id INT PRIMARY KEY AUTO_INCREMENT,
          song_name VARCHAR(200) NOT NULL COMMENT '歌曲名',
          artist VARCHAR(200) COMMENT '歌手',
          to_whom VARCHAR(100) COMMENT '送给谁',
          message TEXT COMMENT '祝福语',
          source ENUM('wechat','manual') DEFAULT 'wechat' COMMENT '来源',
          submitter VARCHAR(100) COMMENT '提交者昵称',
          openid VARCHAR(64) COMMENT '微信openid',
          status ENUM('pending','published') DEFAULT 'pending' COMMENT '同步状态: pending未发布/published已同步公众号草稿',
          published_at TIMESTAMP NULL COMMENT '公众号草稿同步成功时间',
          candidate_hidden_at TIMESTAMP NULL COMMENT '从公众号候选中移出时间，不改变同步状态',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='每日推歌推荐'
      `);
      console.log('✅ daily_song_recs 表已创建');
    } catch (e) {
      if (e.code !== 'ER_TABLE_EXISTS_ERR') throw e;
    }

    // 添加 intro 字段
    try {
      await connection.execute("ALTER TABLE daily_song_recs ADD COLUMN intro TEXT COMMENT 'AI生成的歌曲介绍' AFTER published_at");
      console.log('✅ daily_song_recs 表已添加 intro 字段');
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') console.error('[DB迁移]', e.message);
    }

    // 候选可见性独立于发布状态：管理员可以先将不再需要的推荐移出候选，
    // 但不能伪造“已同步公众号”的 published / published_at。
    try {
      await connection.execute("ALTER TABLE daily_song_recs ADD COLUMN candidate_hidden_at TIMESTAMP NULL COMMENT '从公众号候选中移出时间，不改变同步状态' AFTER published_at");
      console.log('✅ daily_song_recs 表已添加候选移出字段');
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') console.error('[DB迁移]', e.message);
    }

    // 添加 intro 字段到 wechat_song_recs
    try {
      await connection.execute("ALTER TABLE wechat_song_recs ADD COLUMN intro TEXT COMMENT '用户自定义推荐语' AFTER message");
      console.log('✅ wechat_song_recs 表已添加 intro 字段');
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') console.error('[DB迁移]', e.message);
    }

    // 添加 display_name 字段到 wechat_song_recs
    try {
      await connection.execute("ALTER TABLE wechat_song_recs ADD COLUMN display_name VARCHAR(30) DEFAULT '' COMMENT '用户自选显示昵称' AFTER intro");
      console.log('✅ wechat_song_recs 表已添加 display_name 字段');
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') console.error('[DB迁移]', e.message);
    }

    // 添加 lyrics 字段
    try {
      await connection.execute("ALTER TABLE daily_song_recs ADD COLUMN lyrics TEXT COMMENT '歌曲歌词' AFTER intro");
      console.log('✅ daily_song_recs 表已添加 lyrics 字段');
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') console.error('[DB迁移]', e.message);
    }

    // 添加 song_info 字段
    try {
      await connection.execute("ALTER TABLE daily_song_recs ADD COLUMN song_info JSON COMMENT '歌曲详细信息(专辑/年份/曲风等)' AFTER lyrics");
      console.log('✅ daily_song_recs 表已添加 song_info 字段');
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') console.error('[DB迁移]', e.message);
    }

    const dailySongIndexes = [
      ['idx_daily_status_published', '(`status`, `published_at`, `created_at`)'],
      ['idx_daily_candidate_visible', '(`candidate_hidden_at`, `status`, `published_at`)'],
      ['idx_daily_created', '(`created_at`)']
    ];
    for (const [indexName, indexDefinition] of dailySongIndexes) {
      const [indexes] = await connection.query('SHOW INDEX FROM daily_song_recs WHERE Key_name = ?', [indexName]);
      if (indexes.length === 0) {
        await connection.query(`ALTER TABLE daily_song_recs ADD INDEX \`${indexName}\` ${indexDefinition}`);
      }
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

    // 私信按会话读取未删除消息时使用的联合索引。
    try {
      const [indexes] = await connection.query('SHOW INDEX FROM `messages` WHERE Key_name = ?', ['idx_messages_conversation_deleted_created']);
      if (indexes.length === 0) {
        await connection.query('ALTER TABLE `messages` ADD INDEX `idx_messages_conversation_deleted_created` (`conversation_id`, `deleted_at`, `created_at`)');
      }
    } catch (e) {
      console.error('[DB迁移] messages 联合索引创建失败:', e.message);
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

    // 密码重置令牌表
    try {
      await connection.execute(`
        CREATE TABLE IF NOT EXISTS password_reset_tokens (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          token VARCHAR(64) NOT NULL UNIQUE,
          openid VARCHAR(64) DEFAULT NULL COMMENT '微信openid',
          expires_at TIMESTAMP NOT NULL,
          used TINYINT DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_token (token),
          INDEX idx_user (user_id),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='密码重置令牌'
      `);
      console.log('✅ password_reset_tokens 表已创建');
    } catch (e) {
      if (e.code !== 'ER_TABLE_EXISTS_ERR') throw e;
    }

    // ===== 积分 & 签到系统 =====
    // users 表加 points 列
    try {
      await connection.execute("ALTER TABLE users ADD COLUMN points INT DEFAULT 0 COMMENT '总积分' AFTER avatar");
      console.log('✅ users 表已添加 points 列');
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') console.error('[DB迁移]', e.message);
    }
    // 签到记录表
    try {
      await connection.execute(`
        CREATE TABLE IF NOT EXISTS checkins (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          checkin_date DATE NOT NULL COMMENT '签到日期',
          streak INT DEFAULT 1 COMMENT '连续签到天数',
          points_earned INT DEFAULT 0 COMMENT '本次签到获得的积分',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY unique_user_date (user_id, checkin_date),
          INDEX idx_user_date (user_id, checkin_date DESC),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='签到记录'
      `);
      console.log('✅ checkins 表已创建');
    } catch (e) {
      if (e.code !== 'ER_TABLE_EXISTS_ERR') throw e;
    }
    // 积分变动记录表
    try {
      await connection.execute(`
        CREATE TABLE IF NOT EXISTS points_log (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          points INT NOT NULL COMMENT '变动积分（正=加，负=扣）',
          balance INT DEFAULT 0 COMMENT '变动后余额',
          reason VARCHAR(50) NOT NULL COMMENT 'checkin|post|comment|like|follow|bonus|weekly_star',
          related_id INT DEFAULT NULL COMMENT '关联ID（帖子ID等）',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_user (user_id),
          INDEX idx_reason (reason),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='积分变动日志'
      `);
      console.log('✅ points_log 表已创建');
    } catch (e) {
      if (e.code !== 'ER_TABLE_EXISTS_ERR') throw e;
    }
    try {
      const [indexes] = await connection.query(
        'SHOW INDEX FROM `points_log` WHERE Key_name = ?',
        ['idx_points_user_created']
      );
      if (indexes.length === 0) {
        await connection.query(
          'ALTER TABLE `points_log` ADD INDEX `idx_points_user_created` (`user_id`, `created_at`)'
        );
      }
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE') {
        console.error('[DB迁移] points_log.idx_points_user_created 创建失败:', e.message);
      }
    }
    // 等级头衔表
    try {
      await connection.execute(`
        CREATE TABLE IF NOT EXISTS level_titles (
          id INT AUTO_INCREMENT PRIMARY KEY,
          level INT NOT NULL COMMENT '等级',
          min_points INT NOT NULL COMMENT '所需最低积分',
          title_name VARCHAR(50) NOT NULL COMMENT '等级头衔名',
          title_color VARCHAR(50) DEFAULT '#FF6B9D',
          title_bg VARCHAR(50) DEFAULT 'rgba(255,107,157,0.1)',
          icon VARCHAR(10) DEFAULT '⭐',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY unique_level (level),
          INDEX idx_min_points (min_points)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='等级头衔配置'
      `);
      console.log('✅ level_titles 表已创建');
    } catch (e) {
      if (e.code !== 'ER_TABLE_EXISTS_ERR') throw e;
    }
    // 插入默认等级
    var defaultLevels = [
      [1, 0, '校园新鮮人', '#A78BFA', 'rgba(167,139,250,0.1)', '🌱'],
      [2, 10, '校园住民', '#3B82F6', 'rgba(59,130,246,0.1)', '🏠'],
      [3, 30, '活跃分子', '#10B981', 'rgba(16,185,129,0.1)', '🔥'],
      [4, 60, '校园达人', '#F59E0B', 'rgba(245,158,11,0.1)', '⭐'],
      [5, 100, '人气之星', '#FF6B9D', 'rgba(255,107,157,0.1)', '🌟'],
      [6, 200, '校园传奇', '#EF4444', 'rgba(239,68,68,0.1)', '👑']
    ];
    for (var li = 0; li < defaultLevels.length; li++) {
      try {
        await connection.execute(
          'INSERT IGNORE INTO level_titles (level, min_points, title_name, title_color, title_bg, icon) VALUES (?, ?, ?, ?, ?, ?)',
          defaultLevels[li]
        );
      } catch (e) {}
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

module.exports = { pool, initDB, ensureNotificationsTable };
