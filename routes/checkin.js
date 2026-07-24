const express = require('express');
const { pool } = require('../config/database');
const { auth, optionalAuth } = require('../middleware/auth');
const router = express.Router();

const POINTS = { CHECKIN: 1, POST: 2, COMMENT: 1, LIKE_RECEIVED: 1, FOLLOW_RECEIVED: 1 };

// ===== 签到 =====

router.post('/', auth, async (req, res) => {
  try {
    var userId = req.user.id;
    var today = new Date().toISOString().slice(0, 10);
    var [existing] = await pool.execute('SELECT id FROM checkins WHERE user_id = ? AND checkin_date = ?', [userId, today]);
    if (existing.length > 0) return res.json({ code: 400, message: '今天已经签到了' });

    // 计算连续天数
    var yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
    var yStr = yesterday.toISOString().slice(0, 10);
    var [last] = await pool.execute('SELECT streak FROM checkins WHERE user_id = ? AND checkin_date = ?', [userId, yStr]);
    var streak = (last.length > 0 ? last[0].streak : 0) + 1;

    // 积分奖励（连续加成）
    var bonus = 0;
    if (streak >= 30) bonus = 10;
    else if (streak >= 14) bonus = 5;
    else if (streak >= 7) bonus = 3;
    else if (streak >= 3) bonus = 2;
    var pointsEarned = POINTS.CHECKIN + bonus;

    await pool.execute('INSERT INTO checkins (user_id, checkin_date, streak, points_earned) VALUES (?, ?, ?, ?)', [userId, today, streak, pointsEarned]);
    await pool.execute('UPDATE users SET points = points + ? WHERE id = ?', [pointsEarned, userId]);
    await pool.execute('INSERT INTO points_log (user_id, points, balance, reason) VALUES (?, ?, (SELECT points FROM users WHERE id = ?), ?)', [userId, pointsEarned, userId, 'checkin']);

    // 检查是否解锁新等级头衔
    await checkLevelTitle(userId);

    res.json({ code: 200, message: '签到成功', data: { streak, points_earned: pointsEarned, bonus, total_points: req.user.points + pointsEarned } });
  } catch (err) {
    console.error('签到错误:', err);
    res.json({ code: 500, message: '签到失败' });
  }
});

router.get('/status', auth, async (req, res) => {
  try {
    var userId = req.user.id;
    var today = new Date().toISOString().slice(0, 10);
    var [checked] = await pool.execute('SELECT id, streak FROM checkins WHERE user_id = ? AND checkin_date = ?', [userId, today]);
    var [lastRecord] = await pool.execute('SELECT streak, checkin_date FROM checkins WHERE user_id = ? ORDER BY checkin_date DESC LIMIT 1', [userId]);
    var currentStreak = lastRecord.length > 0 ? lastRecord[0].streak : 0;
    var [pointsRow] = await pool.execute('SELECT points FROM users WHERE id = ?', [userId]);
    var totalPoints = pointsRow.length > 0 ? pointsRow[0].points : 0;
    // 等级信息
    var [levelInfo] = await pool.execute('SELECT * FROM level_titles WHERE min_points <= ? ORDER BY min_points DESC LIMIT 1', [totalPoints]);
    var [nextLevel] = await pool.execute('SELECT * FROM level_titles WHERE min_points > ? ORDER BY min_points ASC LIMIT 1', [totalPoints]);

    res.json({
      code: 200,
      data: {
        checked_in: checked.length > 0,
        streak: currentStreak,
        total_points: totalPoints,
        level: levelInfo.length > 0 ? { id: levelInfo[0].id, level: levelInfo[0].level, title_name: levelInfo[0].title_name, title_color: levelInfo[0].title_color, title_bg: levelInfo[0].title_bg, icon: levelInfo[0].icon } : null,
        next_level: nextLevel.length > 0 ? { level: nextLevel[0].level, min_points: nextLevel[0].min_points, title_name: nextLevel[0].title_name, icon: nextLevel[0].icon } : null
      }
    });
  } catch (err) {
    console.error('查询签到状态错误:', err);
    res.json({ code: 500, message: '查询失败' });
  }
});

// ===== 积分总榜 =====

router.get('/leaderboard', async (req, res) => {
  try {
    var limit = parseInt(req.query.limit) || 20;
    var [rows] = await pool.execute(
      'SELECT u.id, u.nickname, u.username, u.avatar, u.points FROM users u WHERE u.points > 0 ORDER BY u.points DESC LIMIT ?', [limit]
    );
    res.json({ code: 200, data: rows });
  } catch (err) {
    console.error('积分排行榜错误:', err);
    res.json({ code: 500, message: '查询失败' });
  }
});

// ===== 等级头衔检查与发放 =====

async function checkLevelTitle(userId) {
  try {
    var [user] = await pool.execute('SELECT points FROM users WHERE id = ?', [userId]);
    if (user.length === 0) return;
    var points = user[0].points;
    var [levels] = await pool.execute('SELECT * FROM level_titles WHERE min_points <= ? ORDER BY min_points DESC', [points]);
    if (levels.length === 0) return;
    var highest = levels[0];
    // 检查用户是否已有该等级头衔
    var [existing] = await pool.execute(
      'SELECT utr.id FROM user_title_relations utr JOIN user_titles ut ON utr.title_id = ut.id WHERE utr.user_id = ? AND ut.title_name = ?',
      [userId, highest.title_name]
    );
    if (existing.length === 0) {
      // 创建或复用 user_titles 记录
      var [titleRows] = await pool.execute('SELECT id FROM user_titles WHERE title_name = ?', [highest.title_name]);
      var titleId;
      if (titleRows.length === 0) {
        var [r] = await pool.execute('INSERT INTO user_titles (title_name, title_color, title_bg, icon) VALUES (?, ?, ?, ?)',
          [highest.title_name, highest.title_color, highest.title_bg, highest.icon]);
        titleId = r.insertId;
      } else {
        titleId = titleRows[0].id;
      }
      await pool.execute('INSERT IGNORE INTO user_title_relations (user_id, title_id) VALUES (?, ?)', [userId, titleId]);
    }
  } catch (e) {
    console.error('等级头衔发放错误:', e);
  }
}

// ===== 本周之星（管理员调用） =====

router.post('/weekly-star', auth, async (req, res) => {
  try {
    // 仅管理员可用
    if (req.user.role !== 'super_admin' && req.user.role !== 'admin') {
      return res.json({ code: 403, message: '无权操作' });
    }
    var oneWeekAgo = new Date(); oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
    var since = oneWeekAgo.toISOString().slice(0, 19).replace('T', ' ');
    var [topPosts] = await pool.execute(`
      SELECT p.id, p.user_id, p.likes_count, p.title, u.nickname
      FROM posts p JOIN users u ON p.user_id = u.id
      WHERE p.created_at >= ? AND p.is_deleted = 0 AND p.status = 'approved'
      ORDER BY p.likes_count DESC LIMIT 1
    `, [since]);
    if (topPosts.length === 0) return res.json({ code: 400, message: '近7天无帖子' });

    var winner = topPosts[0];
    var titleName = '本周之星🏆';
    var [titleRows] = await pool.execute('SELECT id FROM user_titles WHERE title_name = ?', [titleName]);
    var titleId;
    if (titleRows.length === 0) {
      var [r] = await pool.execute(
        "INSERT INTO user_titles (title_name, title_color, title_bg, icon) VALUES (?, '#FF6B9D', 'rgba(255,107,157,0.15)', '🏆')",
        [titleName]
      );
      titleId = r.insertId;
    } else {
      titleId = titleRows[0].id;
    }
    // 先移除旧的每周之星
    await pool.execute('DELETE FROM user_title_relations WHERE title_id = ?', [titleId]);
    await pool.execute('INSERT INTO user_title_relations (user_id, title_id) VALUES (?, ?)', [winner.user_id, titleId]);
    // 奖励积分
    await pool.execute('UPDATE users SET points = points + 10 WHERE id = ?', [winner.user_id]);
    await pool.execute('INSERT INTO points_log (user_id, points, reason) VALUES (?, 10, ?)', [winner.user_id, 'weekly_star']);

    res.json({ code: 200, message: '本周之星已颁发', data: { user_id: winner.user_id, nickname: winner.nickname, post_id: winner.id, post_title: winner.title, likes: winner.likes_count } });
  } catch (err) {
    console.error('本周之星错误:', err);
    res.json({ code: 500, message: '操作失败' });
  }
});

module.exports = router;
