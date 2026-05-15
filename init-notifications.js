const { pool } = require('./config/database');

async function initNotificationsTable() {
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
    console.log('✅ 通知表已创建/已存在');
  } catch (err) {
    console.error('❌ 创建通知表失败:', err.message);
  } finally {
    process.exit(0);
  }
}

initNotificationsTable();
