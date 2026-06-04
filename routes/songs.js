const express = require('express');
const { pool } = require('../config/database');
const { auth, optionalAuth } = require('../middleware/auth');
const router = express.Router();

// 获取用户今日剩余点歌次数
router.get('/remaining', auth, async (req, res) => {
  try {
    const [settingsRows] = await pool.execute('SELECT config_value FROM settings WHERE config_key = "daily_song_limit"');
    const dailyLimit = settingsRows.length > 0 ? parseInt(settingsRows[0].config_value) || 3 : 3;
    const [userSongCount] = await pool.execute(
      'SELECT COUNT(*) as cnt FROM song_requests WHERE user_id = ? AND DATE(created_at) = CURDATE()',
      [req.user.id]
    );
    const remaining = Math.max(0, dailyLimit - (userSongCount[0].cnt || 0));
    res.json({ code: 200, data: { remaining, limit: dailyLimit } });
  } catch (err) {
    res.json({ code: 200, data: { remaining: 3, limit: 3 } });
  }
});

// 自动补充未来日期（当天~7天后）
async function ensureFutureDates(pool) {
  try {
    const [slots] = await pool.execute('SELECT id, weekdays FROM time_slots WHERE is_active = 1');
    if (slots.length === 0) return;

    // 读取管理后台设置的点歌上限
    var [limitRows] = await pool.execute("SELECT config_value FROM settings WHERE config_key = 'daily_song_limit'");
    var maxSongs = limitRows.length > 0 ? parseInt(limitRows[0].config_value) || 3 : 3;

    // 同步已有日期到正确的上限值（修复之前硬编码10的问题）
    await pool.execute('UPDATE slot_dates SET max_songs = ? WHERE max_songs != ? AND play_date >= CURDATE()', [maxSongs, maxSongs]);

    const today = new Date();
    let insertedCount = 0;
    for (let i = 0; i < 14; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      const dateStr = d.toISOString().split('T')[0];
      for (const slot of slots) {
        // 如果时段设置了周周期，检查当前日期是否在允许的范围内
        if (slot.weekdays && slot.weekdays !== '') {
          const allowedDays = slot.weekdays.split(',').map(w => parseInt(w));
          const dayOfWeek = d.getDay(); // JS: 0=周日, 1=周一...
          if (!allowedDays.includes(dayOfWeek)) {
            continue; // 跳过不在允许范围内的日期
          }
        }
        try {
          const [result] = await pool.execute(
            'INSERT IGNORE INTO slot_dates (slot_id, play_date, max_songs) VALUES (?, ?, ?)',
            [slot.id, dateStr, maxSongs]
          );
          if (result.affectedRows > 0) insertedCount++;
        } catch (e) { /* 忽略重复键错误 */ }
      }
    }
    // 清理今天之前的已过期日期
    const todayStr = today.toISOString().split('T')[0];
    await pool.execute('DELETE FROM slot_dates WHERE play_date < ?', [todayStr]);
    // 清理14天之后的日期（只清理没有待审核或已通过点歌请求的空闲日期）
    await pool.execute(
      'DELETE sd FROM slot_dates sd LEFT JOIN song_requests sr ON sd.id = sr.slot_date_id AND sr.status IN ("pending","approved") ' +
      'WHERE sd.play_date >= DATE_ADD(CURDATE(), INTERVAL 14 DAY) AND sr.id IS NULL'
    );
    if (insertedCount > 0) {
      console.log('[时段] 自动补充 ' + insertedCount + ' 条未来日期');
    }
  } catch (e) {
    console.error('[时段] 自动补充日期失败:', e.message);
  }
}

router.get('/slots', optionalAuth, async (req, res) => {
  try {
    // 每次查询前自动补充未来日期
    await ensureFutureDates(pool);

    // 显示从今天开始的14天内日期
    const [slots] = await pool.execute('SELECT * FROM time_slots WHERE is_active = 1 ORDER BY start_time');
    const [dates] = await pool.execute(
      'SELECT sd.*, ts.name, ts.start_time, ts.end_time FROM slot_dates sd ' +
      'JOIN time_slots ts ON sd.slot_id = ts.id ' +
      'WHERE sd.is_active = 1 AND sd.play_date >= CURDATE() AND sd.play_date < DATE_ADD(CURDATE(), INTERVAL 14 DAY) ' +
      'ORDER BY sd.play_date, ts.start_time'
    );
    
    const [counts] = await pool.execute(
      'SELECT slot_date_id, COUNT(*) as cnt FROM song_requests WHERE status IN ("pending","approved") GROUP BY slot_date_id'
    );
    const countMap = {};
    counts.forEach(c => { countMap[c.slot_date_id] = c.cnt; });
    
    const result = slots.map(slot => {
      let slotDates = dates.filter(d => d.slot_id === slot.id);
      // 根据 weekdays 过滤日期
      if (slot.weekdays && slot.weekdays !== '') {
        const allowedDays = slot.weekdays.split(',').map(w => parseInt(w));
        slotDates = slotDates.filter(d => {
          const dayOfWeek = new Date(d.play_date).getDay(); // JS: 0=周日, 1=周一...
          return allowedDays.includes(dayOfWeek);
        });
      }
      slotDates = slotDates.map(d => {
        let dateStr = d.play_date;
        if (dateStr instanceof Date) {
          const y = dateStr.getFullYear();
          const m = String(dateStr.getMonth() + 1).padStart(2, '0');
          const day = String(dateStr.getDate()).padStart(2, '0');
          dateStr = `${y}-${m}-${day}`;
        } else if (typeof dateStr === 'string') {
          dateStr = dateStr.split('T')[0];
        }
        return {
          id: d.id,
          date: dateStr,
          week: ['周日','周一','周二','周三','周四','周五','周六'][new Date(d.play_date).getDay()],
          remaining: Math.max(0, d.max_songs - (countMap[d.id] || 0)),
          max: d.max_songs
        };
      });
      return {
        id: slot.id,
        name: slot.name,
        start_time: slot.start_time,
        end_time: slot.end_time,
        dates: slotDates
      };
    });
    
    res.json({ code: 200, data: result });
  } catch (err) {
    console.error('获取时段错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.post('/', auth, async (req, res) => {
  try {
    const { song_name, artist, message, to_whom, slot_date_id, slot_id, is_anonymous } = req.body;
    
    if (!song_name || !slot_date_id) {
      return res.json({ code: 400, message: '请填写歌曲名和选择时段日期' });
    }
    
    // 验证 slot_date_id 是否存在
    const [slotDates] = await pool.execute(
      'SELECT sd.*, ts.name as slot_name, ts.start_time, ts.end_time FROM slot_dates sd ' +
      'JOIN time_slots ts ON sd.slot_id = ts.id WHERE sd.id = ?',
      [slot_date_id]
    );
    
    if (slotDates.length === 0) {
      return res.json({ code: 400, message: '该时段日期不可用或已过期' });
    }
    
    // 匿名点歌检查
    if (is_anonymous) {
      const [anonSetting] = await pool.execute("SELECT config_value FROM settings WHERE config_key = 'anon_song'");
      const allowAnonSong = anonSetting.length === 0 || anonSetting[0].config_value !== 'false';
      if (!allowAnonSong) {
        return res.json({ code: 400, message: '匿名点歌已关闭，请取消匿名后再提交' });
      }
    }
    
    const slotDate = slotDates[0];
    const actualSlotId = slotDate.slot_id; // 使用数据库中的实际 slot_id
    
    // 验证 slot_id 存在（如果传了的话）
    if (slot_id) {
      const [slotCheck] = await pool.execute('SELECT id FROM time_slots WHERE id = ?', [slot_id]);
      if (slotCheck.length === 0) {
        return res.json({ code: 400, message: '时段不存在' });
      }
    }
    
    const [countResult] = await pool.execute(
      'SELECT COUNT(*) as cnt FROM song_requests WHERE slot_date_id = ? AND status IN ("pending","approved")',
      [slot_date_id]
    );
    
    if (countResult[0].cnt >= slotDate.max_songs) {
      return res.json({ code: 400, message: '该时段点歌已满' });
    }
    
    // 检查用户今日点歌数量限制
    const [settingsRows] = await pool.execute('SELECT config_value FROM settings WHERE config_key = "daily_song_limit"');
    const dailyLimit = settingsRows.length > 0 ? parseInt(settingsRows[0].config_value) || 3 : 3;
    const [userSongCount] = await pool.execute(
      'SELECT COUNT(*) as cnt FROM song_requests WHERE user_id = ? AND DATE(created_at) = CURDATE()',
      [req.user.id]
    );
    
    if (userSongCount[0].cnt >= dailyLimit) {
      return res.json({ code: 400, message: '您今日已点' + dailyLimit + '首歌，已达到每日上限，请明天再来' });
    }
    
    const [result] = await pool.execute(
      'INSERT INTO song_requests (user_id, song_name, artist, message, to_whom, slot_id, slot_date_id, is_anonymous) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [req.user.id, song_name, artist || '', message || '', to_whom || '', actualSlotId, slot_date_id, is_anonymous ? 1 : 0]
    );
    
    res.json({ code: 200, message: '点歌成功', data: { id: result.insertId } });
  } catch (err) {
    console.error('点歌错误:', err);
    res.json({ code: 500, message: '服务器错误: ' + err.message });
  }
});

router.get('/list', optionalAuth, async (req, res) => {
  try {
    const [songs] = await pool.execute(
      'SELECT sr.*, ts.name as slot_name, DATE_FORMAT(sd.play_date, \'%Y-%m-%d\') as play_date, ' +
      'CASE WHEN sr.is_anonymous = 1 THEN NULL ELSE COALESCE(u.nickname, u.username) END as author_name, ' +
      'CASE WHEN sr.is_anonymous = 1 THEN NULL ELSE u.avatar END as author_avatar ' +
      'FROM song_requests sr ' +
      'LEFT JOIN time_slots ts ON sr.slot_id = ts.id ' +
      'LEFT JOIN slot_dates sd ON sr.slot_date_id = sd.id ' +
      'LEFT JOIN users u ON sr.user_id = u.id ' +
      'WHERE sr.status IN ("approved","played") ORDER BY sd.play_date, ts.start_time LIMIT 50'
    );
    res.json({ code: 200, data: songs });
  } catch (err) {
    console.error('获取列表错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取当前用户的点歌记录
router.get('/my', auth, async (req, res) => {
  try {
    const [songs] = await pool.execute(
      'SELECT sr.*, ts.name as slot_name, ts.start_time, ts.end_time, DATE_FORMAT(sd.play_date, \'%Y-%m-%d\') as play_date FROM song_requests sr ' +
      'LEFT JOIN time_slots ts ON sr.slot_id = ts.id ' +
      'LEFT JOIN slot_dates sd ON sr.slot_date_id = sd.id ' +
      'WHERE sr.user_id = ? ORDER BY sr.created_at DESC LIMIT 20',
      [req.user.id]
    );
    res.json({ code: 200, data: songs });
  } catch (err) {
    console.error('获取我的点歌错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 撤回点歌（仅本人，未播出的可撤回）
router.delete('/:id', auth, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM song_requests WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    if (rows.length === 0) {
      return res.json({ code: 403, message: '无权撤回或记录不存在' });
    }
    if (rows[0].status === 'played') {
      return res.json({ code: 400, message: '该歌曲已播出，无法撤回' });
    }
    await pool.execute('UPDATE song_requests SET deleted_at = NOW() WHERE id = ?', [req.params.id]);
    res.json({ code: 200, message: '已撤回' });
  } catch (err) {
    console.error('撤回点歌错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ===== 投票功能 =====

// 获取热门歌曲排行榜
router.get('/hot', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const [songs] = await pool.execute(
      'SELECT sr.*, ts.name as slot_name, DATE_FORMAT(sd.play_date, \'%Y-%m-%d\') as play_date, ' +
      'CASE WHEN sr.is_anonymous = 1 THEN NULL ELSE COALESCE(u.nickname, u.username) END as author_name, ' +
      'CASE WHEN sr.is_anonymous = 1 THEN NULL ELSE u.avatar END as author_avatar, ' +
      'COALESCE(sr.hot_score, 0) as hot_score ' +
      'FROM song_requests sr ' +
      'LEFT JOIN time_slots ts ON sr.slot_id = ts.id ' +
      'LEFT JOIN slot_dates sd ON sr.slot_date_id = sd.id ' +
      'LEFT JOIN users u ON sr.user_id = u.id ' +
      'WHERE sr.status IN ("pending","approved","played") AND sr.deleted_at IS NULL ' +
      'ORDER BY sr.hot_score DESC, sr.created_at DESC ' +
      'LIMIT ?',
      [limit]
    );
    res.json({ code: 200, data: songs });
  } catch (err) {
    console.error('获取热门歌曲错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 投票/取消投票
router.post('/vote', auth, async (req, res) => {
  try {
    const { song_request_id, vote_type } = req.body;
    
    if (!song_request_id || !vote_type || !['up', 'down'].includes(vote_type)) {
      return res.json({ code: 400, message: '参数错误' });
    }

    // 检查歌曲是否存在
    const [songs] = await pool.execute(
      'SELECT id, hot_score FROM song_requests WHERE id = ? AND deleted_at IS NULL',
      [song_request_id]
    );
    if (songs.length === 0) {
      return res.json({ code: 404, message: '歌曲不存在' });
    }

    const currentScore = songs[0].hot_score || 0;

    // 检查是否已投票
    const [existingVotes] = await pool.execute(
      'SELECT id, vote_type FROM song_votes WHERE song_request_id = ? AND user_id = ?',
      [song_request_id, req.user.id]
    );

    let newScore = currentScore;
    
    if (existingVotes.length > 0) {
      // 已投票，取消投票
      await pool.execute(
        'DELETE FROM song_votes WHERE song_request_id = ? AND user_id = ?',
        [song_request_id, req.user.id]
      );
      // 恢复分数
      newScore = existingVotes[0].vote_type === 'up' ? currentScore - 1 : currentScore + 1;
    } else {
      // 新投票
      await pool.execute(
        'INSERT INTO song_votes (song_request_id, user_id, vote_type) VALUES (?, ?, ?)',
        [song_request_id, req.user.id, vote_type]
      );
      // 更新分数
      newScore = vote_type === 'up' ? currentScore + 1 : currentScore - 1;
    }

    // 更新歌曲热度
    await pool.execute(
      'UPDATE song_requests SET hot_score = ? WHERE id = ?',
      [newScore, song_request_id]
    );

    res.json({ 
      code: 200, 
      message: existingVotes.length > 0 ? '已取消投票' : '投票成功',
      data: { hot_score: newScore }
    });
  } catch (err) {
    console.error('投票错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 超级管理员修改投票数
router.post('/admin/update-score', auth, async (req, res) => {
  try {
    // 检查权限
    if (req.user.role !== 'super_admin') {
      return res.json({ code: 403, message: '权限不足' });
    }

    const { song_request_id, score } = req.body;
    
    if (!song_request_id || score === undefined) {
      return res.json({ code: 400, message: '参数错误' });
    }

    // 检查歌曲是否存在
    const [songs] = await pool.execute(
      'SELECT id FROM song_requests WHERE id = ?',
      [song_request_id]
    );
    if (songs.length === 0) {
      return res.json({ code: 404, message: '歌曲不存在' });
    }

    // 更新热度分数
    await pool.execute(
      'UPDATE song_requests SET hot_score = ? WHERE id = ?',
      [parseInt(score), song_request_id]
    );

    // 记录日志
    await pool.execute(
      'INSERT INTO admin_logs (admin_id, action, detail, level) VALUES (?, ?, ?, ?)',
      [req.user.id, 'update_song_score', `修改歌曲ID ${song_request_id} 的热度为 ${score}`, 'info']
    );

    res.json({ code: 200, message: '修改成功', data: { hot_score: parseInt(score) } });
  } catch (err) {
    console.error('修改热度错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

module.exports = router;