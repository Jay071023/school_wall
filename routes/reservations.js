const express = require('express');
const { pool } = require('../config/database');
const { auth } = require('../middleware/auth');
const router = express.Router();

/**
 * 获取中国时区的日期 (YYYY-MM-DD)
 */
function getChinaDate(offsetDays = 0) {
  const now = new Date();
  const chinaTime = new Date(now.getTime() + 8 * 60 * 60 * 1000 + offsetDays * 24 * 60 * 60 * 1000);
  return chinaTime.toISOString().split('T')[0];
}

// ===== 获取未来一周可预定时段 =====
router.get('/available', auth, async (req, res) => {
  try {
    // 获取所有启用的时段
    const [slots] = await pool.execute(
      'SELECT * FROM song_slots WHERE is_active = 1 ORDER BY start_time'
    );
    
    // 生成未来 7 天的日期
    const dates = [];
    for (let i = 1; i <= 7; i++) {
      dates.push(getChinaDate(i));
    }
    
    // 获取用户已有的预定
    const [userReservations] = await pool.execute(
      'SELECT slot_id, reservation_date FROM slot_reservations WHERE user_id = ? AND status != "cancelled"',
      [req.user.id]
    );
    
    const userReservedMap = {};
    userReservations.forEach(r => {
      const key = `${r.slot_id}_${r.reservation_date}`;
      userReservedMap[key] = true;
    });
    
    // 构建可预定列表（先收集所有符合条件的 slot-date 对）
    const availableSlots = [];
    const slotDatePairs = [];

    for (const date of dates) {
      const dateObj = new Date(date);
      const dayOfWeek = dateObj.getDay() === 0 ? 7 : dateObj.getDay(); // 1-7

      for (const slot of slots) {
        const weekdays = slot.weekdays.split(',').map(Number);
        if (weekdays.includes(dayOfWeek)) {
          slotDatePairs.push({ slot, date, dayOfWeek });
        }
      }
    }

    // 批量查询所有时段的已预定数量（1次查询替代 N 次）
    const countMap = {};
    if (slotDatePairs.length > 0) {
      const placeholders = slotDatePairs.map(() => '(?, ?)').join(',');
      const flatParams = [];
      slotDatePairs.forEach(p => { flatParams.push(p.slot.id, p.date); });
      const [counts] = await pool.execute(
        'SELECT slot_id, reservation_date, COUNT(*) as cnt FROM slot_reservations WHERE (slot_id, reservation_date) IN (' + placeholders + ') AND status != "cancelled" GROUP BY slot_id, reservation_date',
        flatParams
      );
      counts.forEach(c => { countMap[c.slot_id + '_' + c.reservation_date] = c.cnt; });
    }

    for (const pair of slotDatePairs) {
      const key = pair.slot.id + '_' + pair.date;
      const reservedCount = countMap[key] || 0;
      const remaining = Math.max(0, pair.slot.max_songs - reservedCount);
      const isReserved = userReservedMap[key] || false;

      availableSlots.push({
        id: pair.slot.id,
        slot_name: pair.slot.slot_name,
        start_time: pair.slot.start_time,
        end_time: pair.slot.end_time,
        date: pair.date,
        day_of_week: pair.dayOfWeek,
        remaining: remaining,
        is_reserved: isReserved,
        max_songs: pair.slot.max_songs
      });
    }
    
    res.json({
      code: 200,
      data: {
        dates: dates,
        slots: availableSlots
      }
    });
  } catch (err) {
    console.error('获取可预定时段错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ===== 预定时段 =====
router.post('/', auth, async (req, res) => {
  try {
    const { slot_id, reservation_date } = req.body;
    
    if (!slot_id || !reservation_date) {
      return res.json({ code: 400, message: '请提供时段ID和预定日期' });
    }
    
    // 检查日期是否在未来 7 天内
    const today = getChinaDate();
    const maxDate = getChinaDate(7);
    
    if (reservation_date < today || reservation_date > maxDate) {
      return res.json({ code: 400, message: '只能预定未来 7 天内的时段' });
    }
    
    // 检查时段是否存在且在该天开放
    const [slots] = await pool.execute(
      'SELECT * FROM song_slots WHERE id = ? AND is_active = 1',
      [slot_id]
    );
    
    if (slots.length === 0) {
      return res.json({ code: 400, message: '时段不存在或已禁用' });
    }
    
    const slot = slots[0];
    const dateObj = new Date(reservation_date);
    const dayOfWeek = dateObj.getDay() === 0 ? 7 : dateObj.getDay();
    const weekdays = slot.weekdays.split(',').map(Number);
    
    if (!weekdays.includes(dayOfWeek)) {
      return res.json({ code: 400, message: '该时段在选定日期不开放' });
    }
    
    // 检查是否已经预定过
    const [existing] = await pool.execute(
      'SELECT id FROM slot_reservations WHERE user_id = ? AND slot_id = ? AND reservation_date = ? AND status != "cancelled"',
      [req.user.id, slot_id, reservation_date]
    );
    
    if (existing.length > 0) {
      return res.json({ code: 400, message: '您已经预定过该时段' });
    }
    
    // 检查剩余名额
    const [countResult] = await pool.execute(
      'SELECT COUNT(*) as count FROM slot_reservations WHERE slot_id = ? AND reservation_date = ? AND status != "cancelled"',
      [slot_id, reservation_date]
    );
    
    if (countResult[0].count >= slot.max_songs) {
      return res.json({ code: 400, message: '该时段已满，无法预定' });
    }
    
    // 插入预定记录
    await pool.execute(
      'INSERT INTO slot_reservations (user_id, slot_id, reservation_date, status) VALUES (?, ?, ?, "confirmed")',
      [req.user.id, slot_id, reservation_date]
    );
    
    res.json({
      code: 200,
      message: '预定成功',
      data: {
        slot_id: slot_id,
        reservation_date: reservation_date
      }
    });
  } catch (err) {
    console.error('预定时段错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ===== 取消预定 =====
router.delete('/:id', auth, async (req, res) => {
  try {
    const reservationId = req.params.id;
    
    // 检查预定是否存在且属于当前用户
    const [reservations] = await pool.execute(
      'SELECT * FROM slot_reservations WHERE id = ? AND user_id = ?',
      [reservationId, req.user.id]
    );
    
    if (reservations.length === 0) {
      return res.json({ code: 404, message: '预定不存在' });
    }
    
    // 更新状态为已取消
    await pool.execute(
      'UPDATE slot_reservations SET status = "cancelled" WHERE id = ?',
      [reservationId]
    );
    
    res.json({
      code: 200,
      message: '取消预定成功'
    });
  } catch (err) {
    console.error('取消预定错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ===== 获取我的预定 =====
router.get('/my', auth, async (req, res) => {
  try {
    // 获取预定信息，关联歌曲请求和时段信息
    const [reservations] = await pool.execute(`
      SELECT sr.id, sr.user_id, sr.slot_id, DATE_FORMAT(sr.reservation_date, '%Y-%m-%d') as reservation_date,
             sr.status, sr.created_at as res_created_at,
             ss.slot_name, ss.start_time, ss.end_time,
             req.song_name, req.artist, req.to_whom, req.message, req.status as song_status
      FROM slot_reservations sr
      JOIN song_slots ss ON sr.slot_id = ss.id
      LEFT JOIN song_requests req ON req.slot_id = sr.slot_id 
        AND DATE(req.created_at) = sr.reservation_date 
        AND req.user_id = sr.user_id
      WHERE sr.user_id = ? AND sr.status != 'cancelled'
      ORDER BY sr.reservation_date ASC, ss.start_time ASC
    `, [req.user.id]);
    
    res.json({
      code: 200,
      data: reservations
    });
  } catch (err) {
    console.error('获取我的预定错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

module.exports = router;
