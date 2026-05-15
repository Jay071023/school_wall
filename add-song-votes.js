/**
 * 添加歌曲投票表
 */
const { pool } = require('./config/database');

async function addSongVotesTable() {
  try {
    // 创建歌曲投票表
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS song_votes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        song_request_id INT NOT NULL COMMENT '点歌记录ID',
        user_id INT NOT NULL COMMENT '投票用户ID',
        vote_type ENUM('up', 'down') DEFAULT 'up' COMMENT '投票类型:up=热度+1,down=热度-1',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_song_user (song_request_id, user_id),
        INDEX idx_song_request (song_request_id),
        INDEX idx_user (user_id),
        FOREIGN KEY (song_request_id) REFERENCES song_requests(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='歌曲投票记录'
    `);
    console.log('✅ song_votes 表已创建');

    // 给 song_requests 表添加热度字段
    try {
      await pool.execute(`
        ALTER TABLE song_requests 
        ADD COLUMN hot_score INT DEFAULT 0 COMMENT '热度分数' AFTER play_order
      `);
      console.log('✅ song_requests 表已添加 hot_score 字段');
    } catch (e) {
      console.log('⚠️ hot_score 字段可能已存在');
    }

    console.log('🎉 歌曲投票功能初始化完成');
  } catch (err) {
    console.error('❌ 初始化失败:', err.message);
    throw err;
  } finally {
    await pool.end();
  }
}

addSongVotesTable();
