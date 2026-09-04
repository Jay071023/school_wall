const express = require('express');
const { pool } = require('../config/database');
const { auth } = require('../middleware/auth');
const { getPagination } = require('../services/pagination');
const { getChinaDate } = require('../services/date');
const router = express.Router();

const POINTS = { CHECKIN: 1, POST: 2, COMMENT: 1, LIKE_RECEIVED: 1, FOLLOW_RECEIVED: 1 };

// ===== 签到 =====

router.post('/', auth, async (req, res) => {
  let connection;
  try {
    const userId = req.user.id;
    const today = getChinaDate();
    const yesterday = getChinaDate(-1);
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // 锁定用户行，让同一用户的并发签到串行化，避免重复加积分。
    const [users] = await connection.execute('SELECT points FROM users WHERE id = ? FOR UPDATE', [userId]);
    if (users.length === 0) {
      await connection.rollback();
      connection.release();
      connection = null;
      return res.json({ code: 401, message: '用户不存在' });
    }

    const [existing] = await connection.execute(
      'SELECT id FROM checkins WHERE user_id = ? AND checkin_date = ? LIMIT 1',
      [userId, today]
    );
    if (existing.length > 0) {
      await connection.rollback();
      connection.release();
      connection = null;
      return res.json({ code: 400, message: '今天已经签到了' });
    }

    // 计算连续天数
    const [last] = await connection.execute(
      'SELECT streak FROM checkins WHERE user_id = ? AND checkin_date = ? LIMIT 1',
      [userId, yesterday]
    );
    const streak = (last.length > 0 ? Number(last[0].streak) || 0 : 0) + 1;

    // 积分奖励（连续加成）
    let bonus = 0;
    if (streak >= 30) bonus = 10;
    else if (streak >= 14) bonus = 5;
    else if (streak >= 7) bonus = 3;
    else if (streak >= 3) bonus = 2;
    const pointsEarned = POINTS.CHECKIN + bonus;

    await connection.execute(
      'INSERT INTO checkins (user_id, checkin_date, streak, points_earned) VALUES (?, ?, ?, ?)',
      [userId, today, streak, pointsEarned]
    );
    await connection.execute('UPDATE users SET points = points + ? WHERE id = ?', [pointsEarned, userId]);
    const totalPoints = (Number(users[0].points) || 0) + pointsEarned;
    await connection.execute(
      'INSERT INTO points_log (user_id, points, balance, reason) VALUES (?, ?, ?, ?)',
      [userId, pointsEarned, totalPoints, 'checkin']
    );

    // 检查是否解锁新等级头衔
    await checkLevelTitle(userId, connection, totalPoints);

    await connection.commit();
    connection.release();
    connection = null;

    res.json({ code: 200, message: '签到成功', data: { streak, points_earned: pointsEarned, bonus, total_points: totalPoints } });
  } catch (err) {
    if (connection) {
      try { await connection.rollback(); } catch (rollbackError) {
        console.error('签到回滚失败:', rollbackError.code || rollbackError.message);
      }
      connection.release();
    }
    if (err && err.code === 'ER_DUP_ENTRY') {
      return res.json({ code: 400, message: '今天已经签到了' });
    }
    console.error('签到错误:', err && (err.code || err.message));
    res.json({ code: 500, message: '签到失败' });
  }
});

router.get('/status', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const today = getChinaDate();
    const [lastRecord] = await pool.execute(
      'SELECT id, streak, checkin_date FROM checkins WHERE user_id = ? ORDER BY checkin_date DESC, id DESC LIMIT 1',
      [userId]
    );
    const currentStreak = lastRecord.length > 0 ? Number(lastRecord[0].streak) || 0 : 0;
    const checkedIn = lastRecord.length > 0 && String(lastRecord[0].checkin_date).slice(0, 10) === today;
    const [pointsRow] = await pool.execute('SELECT points FROM users WHERE id = ? LIMIT 1', [userId]);
    const totalPoints = pointsRow.length > 0 ? Number(pointsRow[0].points) || 0 : 0;
    // 等级信息
    const [levelInfo] = await pool.execute('SELECT * FROM level_titles WHERE min_points <= ? ORDER BY min_points DESC LIMIT 1', [totalPoints]);
    const [nextLevel] = await pool.execute('SELECT * FROM level_titles WHERE min_points > ? ORDER BY min_points ASC LIMIT 1', [totalPoints]);

    res.json({
      code: 200,
      data: {
        checked_in: checkedIn,
        streak: currentStreak,
        total_points: totalPoints,
        level: levelInfo.length > 0 ? { id: levelInfo[0].id, level: levelInfo[0].level, title_name: levelInfo[0].title_name, title_color: levelInfo[0].title_color, title_bg: levelInfo[0].title_bg, icon: levelInfo[0].icon } : null,
        next_level: nextLevel.length > 0 ? { level: nextLevel[0].level, min_points: nextLevel[0].min_points, title_name: nextLevel[0].title_name, icon: nextLevel[0].icon } : null
      }
    });
  } catch (err) {
    console.error('查询签到状态错误:', err && (err.code || err.message));
    res.json({ code: 500, message: '查询失败' });
  }
});

// ===== 积分总榜 =====

router.get('/leaderboard', async (req, res) => {
  try {
    const limit = getPagination(req.query, { defaultLimit: 20, maxLimit: 100 }).limit;
    const [rows] = await pool.execute(
      'SELECT u.id, u.nickname, u.username, u.avatar, u.points FROM users u WHERE u.points > 0 ORDER BY u.points DESC, u.id ASC LIMIT ?', [limit]
    );
    res.json({ code: 200, data: rows });
  } catch (err) {
    console.error('积分排行榜错误:', err && (err.code || err.message));
    res.json({ code: 500, message: '查询失败' });
  }
});

// ===== 等级头衔检查与发放 =====

async function checkLevelTitle(userId, db = pool, knownPoints) {
  try {
    let points = knownPoints;
    if (points === undefined) {
      const [user] = await db.execute('SELECT points FROM users WHERE id = ? LIMIT 1', [userId]);
      if (user.length === 0) return;
      points = user[0].points;
    }
    points = Number(points) || 0;
    const [levels] = await db.execute('SELECT * FROM level_titles WHERE min_points <= ? ORDER BY min_points DESC', [points]);
    if (levels.length === 0) return;
    const highest = levels[0];
    // 检查用户是否已有该等级头衔
    const [existing] = await db.execute(
      'SELECT utr.id FROM user_title_relations utr JOIN user_titles ut ON utr.title_id = ut.id WHERE utr.user_id = ? AND ut.title_name = ? LIMIT 1',
      [userId, highest.title_name]
    );
    if (existing.length === 0) {
      // 创建或复用 user_titles 记录
      const [titleRows] = await db.execute('SELECT id FROM user_titles WHERE title_name = ? ORDER BY id ASC LIMIT 1', [highest.title_name]);
      let titleId;
      if (titleRows.length === 0) {
        const [r] = await db.execute('INSERT INTO user_titles (title_name, title_color, title_bg, icon) VALUES (?, ?, ?, ?)',
          [highest.title_name, highest.title_color, highest.title_bg, highest.icon]);
        titleId = r.insertId;
      } else {
        titleId = titleRows[0].id;
      }
      await db.execute('INSERT IGNORE INTO user_title_relations (user_id, title_id) VALUES (?, ?)', [userId, titleId]);
    }
  } catch (e) {
    console.error('等级头衔发放错误:', e && (e.code || e.message));
  }
}

// ===== 本周之星（管理员调用） =====

router.post('/weekly-star', auth, async (req, res) => {
  let connection;
  try {
    // 仅管理员可用
    if (req.user.role !== 'super_admin' && req.user.role !== 'admin') {
      return res.json({ code: 403, message: '无权操作' });
    }
    // 以中国业务日期作为边界，避免服务器时区在凌晨切日时改变榜单范围。
    const since = `${getChinaDate(-7)} 00:00:00`;
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [topPosts] = await connection.execute(`
      SELECT p.id, p.user_id, p.likes_count, p.title, u.nickname
      FROM posts p JOIN users u ON p.user_id = u.id
      WHERE p.created_at >= ? AND p.is_deleted = 0 AND p.status = 'approved'
      ORDER BY p.likes_count DESC, p.id DESC LIMIT 1
    `, [since]);
    if (topPosts.length === 0) {
      await connection.rollback();
      connection.release();
      connection = null;
      return res.json({ code: 400, message: '近7天无帖子' });
    }

    const winner = topPosts[0];
    const titleName = '本周之星🏆';
    const [titleRows] = await connection.execute(
      'SELECT id FROM user_titles WHERE title_name = ? ORDER BY id ASC LIMIT 1 FOR UPDATE',
      [titleName]
    );
    let titleId;
    if (titleRows.length === 0) {
      const [r] = await connection.execute(
        "INSERT INTO user_titles (title_name, title_color, title_bg, icon) VALUES (?, '#FF6B9D', 'rgba(255,107,157,0.15)', '🏆')",
        [titleName]
      );
      titleId = r.insertId;
    } else {
      titleId = titleRows[0].id;
    }
    // 先移除旧的每周之星
    await connection.execute('DELETE FROM user_title_relations WHERE title_id = ?', [titleId]);
    await connection.execute('INSERT IGNORE INTO user_title_relations (user_id, title_id) VALUES (?, ?)', [winner.user_id, titleId]);
    // 奖励积分
    await connection.execute('UPDATE users SET points = points + 10 WHERE id = ?', [winner.user_id]);
    const [updatedUser] = await connection.execute('SELECT points FROM users WHERE id = ? LIMIT 1', [winner.user_id]);
    const totalPoints = updatedUser.length > 0 ? Number(updatedUser[0].points) || 0 : 0;
    await connection.execute(
      'INSERT INTO points_log (user_id, points, balance, reason) VALUES (?, 10, ?, ?)',
      [winner.user_id, totalPoints, 'weekly_star']
    );

    await connection.commit();
    connection.release();
    connection = null;

    res.json({ code: 200, message: '本周之星已颁发', data: { user_id: winner.user_id, nickname: winner.nickname, post_id: winner.id, post_title: winner.title, likes: winner.likes_count } });
  } catch (err) {
    if (connection) {
      try { await connection.rollback(); } catch (rollbackError) {
        console.error('本周之星回滚失败:', rollbackError.code || rollbackError.message);
      }
      connection.release();
    }
    console.error('本周之星错误:', err && (err.code || err.message));
    res.json({ code: 500, message: '操作失败' });
  }
});

module.exports = router;
