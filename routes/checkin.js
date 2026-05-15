const express = require('express');
const { pool } = require('../config/database');
const { auth } = require('../middleware/auth');
const router = express.Router();

/**
 * 获取中国时区的今天日期 (YYYY-MM-DD)
 */
function getChinaToday() {
  const now = new Date();
  const chinaTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return chinaTime.toISOString().split('T')[0];
}

/**
 * 计算两个日期之间的天数差
 */
function getDaysBetween(date1, date2) {
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  const diffTime = d2.getTime() - d1.getTime();
  return Math.floor(diffTime / (1000 * 60 * 60 * 24));
}

// ===== 获取用户打卡信息 =====
router.get('/my', auth, async (req, res) => {
  try {
    const [userCheckin] = await pool.execute(
      'SELECT level, exp, checkin_streak, last_checkin_date, total_checkins FROM users WHERE id = ?',
      [req.user.id]
    );
    
    if (userCheckin.length === 0) {
      return res.json({ code: 404, message: '用户不存在' });
    }
    
    const user = userCheckin[0];
    const today = getChinaToday();
    const hasCheckedInToday = user.last_checkin_date === today;
    
    // 获取等级信息
    const [levelInfo] = await pool.execute(
      'SELECT * FROM level_config WHERE level = ?',
      [user.level || 1]
    );
    
    // 获取下一等级信息
    const [nextLevelInfo] = await pool.execute(
      'SELECT * FROM level_config WHERE level = ?',
      [(user.level || 1) + 1]
    );
    
    // 默认等级图标映射
    const defaultIcons = {
      1: '🌱', 2: '📖', 3: '✏️', 4: '📚', 5: '🎓',
      6: '🎒', 7: '📝', 8: '🔬', 9: '🏆', 10: '👑'
    };
    
    // 确保图标有效（不是乱码）
    const getValidIcon = (icon, level) => {
      if (icon && icon.length <= 4 && !icon.includes('\ufffd')) {
        return icon;
      }
      return defaultIcons[level] || '🌱';
    };
    
    // 获取本月打卡记录
    const currentMonth = today.substring(0, 7); // YYYY-MM
    const [monthRecords] = await pool.execute(
      'SELECT checkin_date FROM checkin_records WHERE user_id = ? AND checkin_date LIKE ?',
      [req.user.id, currentMonth + '%']
    );
    
    const checkedDates = monthRecords.map(r => r.checkin_date);
    
    const userLevel = user.level || 1;
    
    res.json({
      code: 200,
      data: {
        level: userLevel,
        level_name: levelInfo[0]?.level_name || '新生',
        level_icon: getValidIcon(levelInfo[0]?.icon, userLevel),
        exp: user.exp || 0,
        next_level: nextLevelInfo[0]?.level || null,
        next_level_name: nextLevelInfo[0]?.level_name || null,
        next_level_exp: nextLevelInfo[0]?.exp_required || null,
        exp_to_next: nextLevelInfo[0] ? nextLevelInfo[0].exp_required - (user.exp || 0) : 0,
        checkin_streak: user.checkin_streak || 0,
        total_checkins: user.total_checkins || 0,
        has_checked_in_today: hasCheckedInToday,
        last_checkin_date: user.last_checkin_date,
        checked_dates: checkedDates
      }
    });
  } catch (err) {
    console.error('获取打卡信息错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ===== 执行打卡 =====
router.post('/', auth, async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    const today = getChinaToday();
    
    await connection.beginTransaction();
    
    // 检查今天是否已经打卡（使用唯一索引防止重复）
    const [existingCheckin] = await connection.execute(
      'SELECT id FROM checkin_records WHERE user_id = ? AND checkin_date = ?',
      [req.user.id, today]
    );
    
    if (existingCheckin.length > 0) {
      await connection.rollback();
      return res.json({ code: 400, message: '今天已经打卡过了' });
    }
    
    // 获取用户当前打卡信息（加锁防止并发问题）
    const [userInfo] = await connection.execute(
      'SELECT checkin_streak, last_checkin_date, exp, level FROM users WHERE id = ? FOR UPDATE',
      [req.user.id]
    );
    
    if (userInfo.length === 0) {
      await connection.rollback();
      return res.json({ code: 404, message: '用户不存在' });
    }
    
    const user = userInfo[0];
    let newStreak = 1;
    let expGained = 10; // 基础经验值
    let isContinued = false;
    
    // 计算连续打卡天数
    if (user.last_checkin_date) {
      const diffDays = getDaysBetween(user.last_checkin_date, today);
      
      if (diffDays === 1) {
        // 连续打卡
        newStreak = (user.checkin_streak || 0) + 1;
        isContinued = true;
        
        // 连续打卡奖励
        if (newStreak >= 30) {
          expGained = 50;
        } else if (newStreak >= 14) {
          expGained = 30;
        } else if (newStreak >= 7) {
          expGained = 20;
        }
      } else if (diffDays > 1) {
        // 断签了，重新开始
        newStreak = 1;
      } else {
        // diffDays === 0，今天已经打卡（理论上不会到这里，因为前面已经检查过）
        await connection.rollback();
        return res.json({ code: 400, message: '今天已经打卡过了' });
      }
    }
    
    // 插入打卡记录
    await connection.execute(
      'INSERT INTO checkin_records (user_id, checkin_date, exp_gained, is_continued) VALUES (?, ?, ?, ?)',
      [req.user.id, today, expGained, isContinued ? 1 : 0]
    );
    
    // 更新用户打卡信息
    const newExp = (user.exp || 0) + expGained;
    await connection.execute(
      'UPDATE users SET checkin_streak = ?, last_checkin_date = ?, total_checkins = total_checkins + 1, exp = ? WHERE id = ?',
      [newStreak, today, newExp, req.user.id]
    );
    
    // 检查是否升级
    let leveledUp = false;
    let newLevel = user.level || 1;
    let newLevelName = null;
    let newLevelIcon = null;
    
    const [maxLevel] = await connection.execute(
      'SELECT MAX(level) as max_level FROM level_config'
    );
    
    if (newLevel < maxLevel[0].max_level) {
      const [nextLevel] = await connection.execute(
        'SELECT level, level_name, icon, exp_required FROM level_config WHERE exp_required <= ? AND level > ? ORDER BY level DESC LIMIT 1',
        [newExp, newLevel]
      );
      
      if (nextLevel.length > 0) {
        newLevel = nextLevel[0].level;
        newLevelName = nextLevel[0].level_name;
        newLevelIcon = nextLevel[0].icon;
        
        await connection.execute(
          'UPDATE users SET level = ? WHERE id = ?',
          [newLevel, req.user.id]
        );
        leveledUp = true;
      }
    }
    
    await connection.commit();
    
    res.json({
      code: 200,
      message: '打卡成功',
      data: {
        exp_gained: expGained,
        new_streak: newStreak,
        new_exp: newExp,
        leveled_up: leveledUp,
        new_level: newLevel,
        new_level_name: newLevelName,
        new_level_icon: newLevelIcon,
        is_continued: isContinued
      }
    });
  } catch (err) {
    await connection.rollback();
    console.error('打卡错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  } finally {
    connection.release();
  }
});

// ===== 获取打卡排行榜 =====
router.get('/leaderboard', auth, async (req, res) => {
  try {
    const { type = 'total', limit = 20 } = req.query;
    
    let orderBy;
    switch (type) {
      case 'streak':
        orderBy = 'u.checkin_streak DESC, u.total_checkins DESC';
        break;
      case 'level':
        orderBy = 'u.level DESC, u.exp DESC';
        break;
      case 'total':
      default:
        orderBy = 'u.total_checkins DESC, u.checkin_streak DESC';
    }
    
    const [leaderboard] = await pool.execute(
      `SELECT u.id, u.nickname, u.avatar, u.level, u.checkin_streak, u.total_checkins, u.exp,
             lc.level_name, lc.icon as level_icon
      FROM users u
      LEFT JOIN level_config lc ON u.level = lc.level
      WHERE u.total_checkins > 0
      ORDER BY ${orderBy}
      LIMIT ?`,
      [parseInt(limit)]
    );
    
    // 添加排名
    const result = leaderboard.map((item, index) => ({
      ...item,
      rank: index + 1
    }));
    
    res.json({
      code: 200,
      data: result
    });
  } catch (err) {
    console.error('获取排行榜错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ===== 获取等级配置 =====
router.get('/levels', async (req, res) => {
  try {
    const [levels] = await pool.execute(
      'SELECT * FROM level_config ORDER BY level ASC'
    );
    
    res.json({
      code: 200,
      data: levels
    });
  } catch (err) {
    console.error('获取等级配置错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ===== 获取打卡历史 =====
router.get('/history', auth, async (req, res) => {
  try {
    const { month } = req.query;
    
    let whereClause = 'user_id = ?';
    const params = [req.user.id];
    
    if (month) {
      whereClause += ' AND checkin_date LIKE ?';
      params.push(month + '%');
    }
    
    const [records] = await pool.execute(
      `SELECT checkin_date, exp_gained, is_continued, created_at 
       FROM checkin_records 
       WHERE ${whereClause} 
       ORDER BY checkin_date DESC 
       LIMIT 100`,
      params
    );
    
    res.json({
      code: 200,
      data: records
    });
  } catch (err) {
    console.error('获取打卡历史错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ===== 获取打卡统计 =====
router.get('/stats', auth, async (req, res) => {
  try {
    const today = getChinaToday();
    const currentMonth = today.substring(0, 7);
    const currentYear = today.substring(0, 4);
    
    // 本月打卡天数
    const [monthStats] = await pool.execute(
      'SELECT COUNT(*) as count, SUM(exp_gained) as total_exp FROM checkin_records WHERE user_id = ? AND checkin_date LIKE ?',
      [req.user.id, currentMonth + '%']
    );
    
    // 本年打卡天数
    const [yearStats] = await pool.execute(
      'SELECT COUNT(*) as count, SUM(exp_gained) as total_exp FROM checkin_records WHERE user_id = ? AND checkin_date LIKE ?',
      [req.user.id, currentYear + '%']
    );
    
    // 最长连续打卡
    const [maxStreak] = await pool.execute(
      'SELECT MAX(checkin_streak) as max_streak FROM users WHERE id = ?',
      [req.user.id]
    );
    
    res.json({
      code: 200,
      data: {
        month_checkins: monthStats[0].count || 0,
        month_exp: monthStats[0].total_exp || 0,
        year_checkins: yearStats[0].count || 0,
        year_exp: yearStats[0].total_exp || 0,
        max_streak: maxStreak[0].max_streak || 0
      }
    });
  } catch (err) {
    console.error('获取打卡统计错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

module.exports = router;
