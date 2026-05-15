const express = require('express');
const { pool } = require('../config/database');
const { auth, optionalAuth } = require('../middleware/auth');
const router = express.Router();

// 自动补充未来日期（当天~28天后）
async function ensureFutureDates(pool) {
  try {
    const [slots] = await pool.execute('SELECT id, weekdays FROM time_slots WHERE is_active = 1');
    if (slots.length === 0) return;

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
            'INSERT IGNORE INTO slot_dates (slot_id, play_date, max_songs) VALUES (?, ?, 10)',
            [slot.id, dateStr]
          );
          if (result.affectedRows > 0) insertedCount++;
        } catch (e) { /* 忽略重复键错误 */ }
      }
    }
    const todayStr = today.toISOString().split('T')[0];
    await pool.execute('DELETE FROM slot_dates WHERE play_date < ?', [todayStr]);
    if (insertedCount > 0) {
      console.log('[时段-new] 自动补充 ' + insertedCount + ' 条未来日期');
    }
  } catch (e) {
    console.error('[时段-new] 自动补充日期失败:', e.message);
  }
}

router.get('/slots', optionalAuth, async (req, res) => {
  try {
    // 每次查询前自动补充未来日期
    await ensureFutureDates(pool);

    // 显示从今天开始28天内日期
    const todayStr = new Date().toISOString().split('T')[0];
    
    const [slots] = await pool.execute('SELECT * FROM time_slots WHERE is_active = 1 ORDER BY start_time');
    const [dates] = await pool.execute(
      'SELECT sd.*, ts.name, ts.start_time, ts.end_time FROM slot_dates sd ' +
      'JOIN time_slots ts ON sd.slot_id = ts.id ' +
      'WHERE sd.is_active = 1 AND sd.play_date >= ? ' +
      'ORDER BY sd.play_date, ts.start_time',
      [todayStr]
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
      slotDates = slotDates.map(d => ({
        id: d.id,
        date: d.play_date,
        week: ['周日','周一','周二','周三','周四','周五','周六'][new Date(d.play_date).getDay()],
        remaining: Math.max(0, d.max_songs - (countMap[d.id] || 0)),
        max: d.max_songs
      }));
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
    
    const [slotDates] = await pool.execute(
      'SELECT sd.*, ts.name as slot_name, ts.start_time, ts.end_time FROM slot_dates sd ' +
      'JOIN time_slots ts ON sd.slot_id = ts.id WHERE sd.id = ?',
      [slot_date_id]
    );
    
    if (slotDates.length === 0) {
      return res.json({ code: 400, message: '该时段日期不可用' });
    }
    
    const slotDate = slotDates[0];
    const [countResult] = await pool.execute(
      'SELECT COUNT(*) as cnt FROM song_requests WHERE slot_date_id = ? AND status IN ("pending","approved")',
      [slot_date_id]
    );
    
    if (countResult[0].cnt >= slotDate.max_songs) {
      return res.json({ code: 400, message: '该时段点歌已满' });
    }
    
    const [result] = await pool.execute(
      'INSERT INTO song_requests (user_id, song_name, artist, message, to_whom, slot_id, slot_date_id, is_anonymous) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [req.user.id, song_name, artist || '', message || '', to_whom || '', slot_id, slot_date_id, is_anonymous ? 1 : 0]
    );
    
    res.json({ code: 200, message: '点歌成功', data: { id: result.insertId } });
  } catch (err) {
    console.error('点歌错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.get('/list', optionalAuth, async (req, res) => {
  try {
    const [songs] = await pool.execute(
      'SELECT sr.*, ts.name as slot_name, sd.play_date FROM song_requests sr ' +
      'LEFT JOIN time_slots ts ON sr.slot_id = ts.id ' +
      'LEFT JOIN slot_dates sd ON sr.slot_date_id = sd.id ' +
      'WHERE sr.status IN ("approved","played") ORDER BY sd.play_date, ts.start_time LIMIT 50'
    );
    res.json({ code: 200, data: songs });
  } catch (err) {
    console.error('获取列表错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

module.exports = router;