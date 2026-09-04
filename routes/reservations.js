const express = require('express');
const { pool } = require('../config/database');
const { auth } = require('../middleware/auth');
const { buildReservationMap, buildReservationCountMap } = require('../services/reservation-availability');
const { getChinaDate, getChinaDayOfWeek } = require('../services/date');
const router = express.Router();

function parsePositiveId(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function isValidChinaDate(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const [year, month, day] = text.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function getListPagination(query) {
  const parse = (value, fallback, max) => {
    const text = String(value ?? '').trim();
    if (!/^\d+$/.test(text)) return fallback;
    const parsed = Number(text);
    return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
  };
  const page = parse(query && query.page, 1, 100000);
  const limit = parse(query && query.limit, 20, 100);
  return { limit, offset: (page - 1) * limit };
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
    
    const firstDate = dates[0];
    const lastDate = dates[dates.length - 1];
    // 用户预定和各时段已占用名额一次取回，避免按日期/时段循环发起 N+1 查询。
    const [[userReservations], [reservationCounts]] = await Promise.all([
      pool.execute(
        'SELECT slot_id, reservation_date FROM slot_reservations ' +
        'WHERE user_id = ? AND status != "cancelled" AND reservation_date BETWEEN ? AND ?',
        [req.user.id, firstDate, lastDate]
      ),
      pool.execute(
        'SELECT slot_id, reservation_date, COUNT(*) AS reserved_count FROM slot_reservations ' +
        'WHERE status != "cancelled" AND reservation_date BETWEEN ? AND ? ' +
        'GROUP BY slot_id, reservation_date',
        [firstDate, lastDate]
      )
    ]);

    const userReservedMap = buildReservationMap(userReservations);
    const reservationCountMap = buildReservationCountMap(reservationCounts);
    
    // 构建可预定列表
    const availableSlots = [];
    
    for (const date of dates) {
      const dayOfWeek = getChinaDayOfWeek(date);
      
      for (const slot of slots) {
        const weekdays = String(slot.weekdays || '').split(',').map(Number).filter(Number.isInteger);
        
        // 检查该时段是否在该天开放
        if (weekdays.includes(dayOfWeek)) {
          const key = `${slot.id}_${date}`;
          const isReserved = userReservedMap.has(key);
          
          const reservedCount = reservationCountMap[`${slot.id}_${date}`] || 0;
          const remaining = Math.max(0, slot.max_songs - reservedCount);
          
          availableSlots.push({
            id: slot.id,
            slot_name: slot.slot_name,
            start_time: slot.start_time,
            end_time: slot.end_time,
            date: date,
            day_of_week: dayOfWeek,
            remaining: remaining,
            is_reserved: isReserved,
            max_songs: slot.max_songs
          });
        }
      }
    }
    
    res.json({
      code: 200,
      data: {
        dates: dates,
        slots: availableSlots
      }
    });
  } catch (err) {
    console.error('获取可预定时段错误:', err.message);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ===== 预定时段 =====
router.post('/', auth, async (req, res) => {
  try {
    const { slot_id, reservation_date } = req.body;
    const slotId = parsePositiveId(slot_id);
    const requestedDate = String(reservation_date ?? '').trim();
    
    if (!slotId || !isValidChinaDate(requestedDate)) {
      return res.json({ code: 400, message: '请提供时段ID和预定日期' });
    }
    
    // 检查日期是否在未来 7 天内
    const today = getChinaDate();
    const maxDate = getChinaDate(7);
    
    if (requestedDate < today || requestedDate > maxDate) {
      return res.json({ code: 400, message: '只能预定未来 7 天内的时段' });
    }
    
    // 锁定时段行，把“查重复、查容量、插入”放进同一事务，避免并发超卖。
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      const [slots] = await connection.execute(
        'SELECT * FROM song_slots WHERE id = ? AND is_active = 1 FOR UPDATE',
        [slotId]
      );
      if (slots.length === 0) {
        await connection.rollback();
        return res.json({ code: 400, message: '时段不存在或已禁用' });
      }

      const slot = slots[0];
      const dayOfWeek = getChinaDayOfWeek(requestedDate);
      const weekdays = String(slot.weekdays || '').split(',').map(Number).filter(Number.isInteger);
      if (!weekdays.includes(dayOfWeek)) {
        await connection.rollback();
        return res.json({ code: 400, message: '该时段在选定日期不开放' });
      }

      const [existing] = await connection.execute(
        'SELECT id FROM slot_reservations WHERE user_id = ? AND slot_id = ? AND reservation_date = ? AND status != "cancelled" LIMIT 1',
        [req.user.id, slotId, requestedDate]
      );
      if (existing.length > 0) {
        await connection.rollback();
        return res.json({ code: 400, message: '您已经预定过该时段' });
      }

      const [countResult] = await connection.execute(
        'SELECT COUNT(*) as count FROM slot_reservations WHERE slot_id = ? AND reservation_date = ? AND status != "cancelled"',
        [slotId, requestedDate]
      );
      if (countResult[0].count >= slot.max_songs) {
        await connection.rollback();
        return res.json({ code: 400, message: '该时段已满，无法预定' });
      }

      await connection.execute(
        'INSERT INTO slot_reservations (user_id, slot_id, reservation_date, status) VALUES (?, ?, ?, "confirmed")',
        [req.user.id, slotId, requestedDate]
      );
      await connection.commit();
    } catch (transactionError) {
      try { await connection.rollback(); } catch (_) {}
      if (transactionError.code === 'ER_DUP_ENTRY') {
        return res.json({ code: 400, message: '您已经预定过该时段' });
      }
      throw transactionError;
    } finally {
      connection.release();
    }
    
    res.json({
      code: 200,
      message: '预定成功',
      data: {
        slot_id: slotId,
        reservation_date: requestedDate
      }
    });
  } catch (err) {
    console.error('预定时段错误:', err.message);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ===== 取消预定 =====
router.delete('/:id', auth, async (req, res) => {
  try {
    const reservationId = parsePositiveId(req.params.id);
    if (!reservationId) {
      return res.json({ code: 404, message: '预定不存在' });
    }
    
    // 检查预定是否存在且属于当前用户
    const [updated] = await pool.execute(
      'UPDATE slot_reservations SET status = "cancelled" WHERE id = ? AND user_id = ? AND status != "cancelled"',
      [reservationId, req.user.id]
    );
    
    if (updated.affectedRows === 0) {
      return res.json({ code: 404, message: '预定不存在' });
    }
    
    res.json({
      code: 200,
      message: '取消预定成功'
    });
  } catch (err) {
    console.error('取消预定错误:', err.message);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ===== 获取我的预定 =====
router.get('/my', auth, async (req, res) => {
  try {
    const { limit, offset } = getListPagination(req.query);
    // 获取预定信息，关联歌曲请求和时段信息
    const [reservations] = await pool.execute(`
      SELECT sr.id, sr.user_id, sr.slot_id, DATE_FORMAT(sr.reservation_date, '%Y-%m-%d') as reservation_date,
             sr.status, sr.created_at as res_created_at,
             ss.slot_name, ss.start_time, ss.end_time,
             req.song_name, req.artist, req.to_whom, req.message, req.status as song_status
      FROM slot_reservations sr
      JOIN song_slots ss ON sr.slot_id = ss.id
      LEFT JOIN song_requests req ON req.slot_id = sr.slot_id 
        AND req.created_at >= CONVERT_TZ(CONCAT(sr.reservation_date, ' 00:00:00'), '+08:00', @@session.time_zone)
        AND req.created_at < CONVERT_TZ(CONCAT(DATE_ADD(sr.reservation_date, INTERVAL 1 DAY), ' 00:00:00'), '+08:00', @@session.time_zone)
        AND req.user_id = sr.user_id
        AND req.deleted_at IS NULL
      WHERE sr.user_id = ? AND sr.status != 'cancelled'
      ORDER BY sr.reservation_date ASC, ss.start_time ASC, sr.id ASC
      LIMIT ? OFFSET ?
    `, [req.user.id, limit, offset]);
    
    res.json({
      code: 200,
      data: reservations
    });
  } catch (err) {
    console.error('获取我的预定错误:', err.message);
    res.json({ code: 500, message: '服务器错误' });
  }
});

module.exports = router;
