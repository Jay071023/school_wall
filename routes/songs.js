const express = require('express');
const { maintenance } = require('../modules/songs');
const { parseBoundedPositiveInt } = require('../services/number-utils');
const { pool } = require('../config/database');
const { auth, optionalAuth } = require('../middleware/auth');
const { getChinaDate, getChinaDayOfWeek, getChinaJsDayOfWeek, getChinaDayRange } = require('../services/date');
const { notifyRadioAdminsNewSongPending } = require('../services/email');
const router = express.Router();

function getListPagination(query, defaultLimit, maxLimit) {
  const page = parseBoundedPositiveInt(query && query.page, 1, 100000);
  const limit = parseBoundedPositiveInt(query && query.limit, defaultLimit, maxLimit);
  return { limit, offset: (page - 1) * limit };
}

function getDailySongLimit(value) {
  return parseBoundedPositiveInt(value, 3, 100);
}

// 获取用户今日剩余点歌次数
router.get('/remaining', auth, async (req, res) => {
  try {
    const [settingsRows] = await pool.execute('SELECT config_value FROM settings WHERE config_key = "daily_song_limit"');
    const dailyLimit = getDailySongLimit(settingsRows.length > 0 ? settingsRows[0].config_value : undefined);
    const { todayStart, tomorrowStart } = getChinaDayRange();
    const [userSongCount] = await pool.execute(
      'SELECT COUNT(*) as cnt FROM song_requests WHERE user_id = ? AND deleted_at IS NULL ' +
      "AND created_at >= CONVERT_TZ(?, '+08:00', @@session.time_zone) " +
      "AND created_at < CONVERT_TZ(?, '+08:00', @@session.time_zone)",
      [req.user.id, todayStart, tomorrowStart]
    );
    const remaining = Math.max(0, dailyLimit - (userSongCount[0].cnt || 0));
    res.json({ code: 200, data: { remaining, limit: dailyLimit } });
  } catch (err) {
    res.json({ code: 200, data: { remaining: 3, limit: 3 } });
  }
});

router.get('/slots', optionalAuth, async (req, res) => {
  try {
    // 时段状态由管理员日历实时控制，禁止浏览器/CDN继续使用旧的开放日期。
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    // 首次打开点歌页时，后台维护任务可能尚未完成；在查询前幂等补齐未来日期，
    // 避免刚配置的周期因 slot_dates 尚未生成而被误报“没有可用时段”。
    await maintenance.ensureFutureDates();
    // 显示从今天开始的14天内日期
    const { today, rangeEnd } = getChinaDayRange();
    const [[slots], [dates], [counts]] = await Promise.all([
      pool.execute('SELECT * FROM time_slots WHERE is_active = 1 ORDER BY start_time'),
      pool.execute(
        'SELECT sd.*, ts.name, ts.start_time, ts.end_time, ts.weekdays, ts.effective_start_date FROM slot_dates sd ' +
        'JOIN time_slots ts ON sd.slot_id = ts.id ' +
        'WHERE sd.is_active = 1 AND ts.is_active = 1 AND (ts.effective_start_date IS NULL OR sd.play_date >= ts.effective_start_date) AND sd.play_date >= ? AND sd.play_date < ? ' +
        'ORDER BY sd.play_date, ts.start_time, sd.id',
        [today, rangeEnd]
      ),
      pool.execute(
        'SELECT sr.slot_date_id, COUNT(*) as cnt FROM song_requests sr ' +
        'JOIN slot_dates sd ON sd.id = sr.slot_date_id ' +
        'WHERE sr.deleted_at IS NULL AND sr.status IN ("pending","approved") ' +
        'AND sd.is_active = 1 AND sd.play_date >= ? AND sd.play_date < ? ' +
        'GROUP BY sr.slot_date_id',
        [today, rangeEnd]
      )
    ]);
    const countMap = Object.create(null);
    counts.forEach(c => { countMap[c.slot_date_id] = c.cnt; });

    const datesBySlotId = new Map();
    dates.forEach(date => {
      if (!datesBySlotId.has(date.slot_id)) datesBySlotId.set(date.slot_id, []);
      datesBySlotId.get(date.slot_id).push(date);
    });

    const result = slots.map(slot => {
      let slotDates = datesBySlotId.get(slot.id) || [];
      // 根据 weekdays 过滤日期
      if (slot.weekdays && slot.weekdays !== '') {
        const allowedDays = slot.weekdays.split(',').map(w => Number(w.trim())).filter(Number.isInteger);
        slotDates = slotDates.filter(d => {
          const dayOfWeek = getChinaJsDayOfWeek(d.play_date);
          return Number(d.manual_override) === 1 || allowedDays.includes(dayOfWeek);
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
          week: ['','周一','周二','周三','周四','周五','周六','周日'][getChinaDayOfWeek(dateStr)],
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
    console.error('获取时段错误:', err.message);
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.post('/', auth, async (req, res) => {
  try {
    const { song_name, artist, message, to_whom, slot_date_id, slot_id, is_anonymous } = req.body;
    const songName = String(song_name || '').trim();
    const songArtist = String(artist || '').trim();
    const slotDateId = parseBoundedPositiveInt(slot_date_id, null, Number.MAX_SAFE_INTEGER);
    const anonymous = is_anonymous === true || is_anonymous === 1 || is_anonymous === '1' || is_anonymous === 'true';
    
    if (!songName || !songArtist || !slotDateId) {
      return res.json({ code: 400, message: '歌曲名和歌手为必填项，请选择播放时段和日期' });
    }

    // 日期补充属于显式写入请求，GET /slots 保持纯查询。
    await ensureFutureDates(pool);
    
    // 匿名点歌检查
    if (anonymous) {
      const [anonSetting] = await pool.execute("SELECT config_value FROM settings WHERE config_key = 'anon_song'");
      const allowAnonSong = anonSetting.length > 0 && anonSetting[0].config_value === 'true';
      if (!allowAnonSong) {
        return res.json({ code: 400, message: '匿名点歌已关闭，请取消匿名后再提交' });
      }
    }
    
    let pendingReviewNotice = null;
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const { today, rangeEnd } = getChinaDayRange();

      // 锁定用户和日期行，使每日上限、名额检查与插入保持同一事务。
      await connection.execute('SELECT id FROM users WHERE id = ? FOR UPDATE', [req.user.id]);
      const [slotDates] = await connection.execute(
        'SELECT sd.*, ts.name as slot_name, ts.start_time, ts.end_time, ts.weekdays, ts.effective_start_date FROM slot_dates sd ' +
        'JOIN time_slots ts ON sd.slot_id = ts.id ' +
        'WHERE sd.id = ? AND sd.is_active = 1 AND ts.is_active = 1 AND (ts.effective_start_date IS NULL OR sd.play_date >= ts.effective_start_date) AND sd.play_date >= ? AND sd.play_date < ? FOR UPDATE',
        [slotDateId, today, rangeEnd]
      );
    if (slotDates.length === 0) {
        await connection.rollback();
        return res.json({ code: 400, message: '该时段日期不可用或已过期' });
      }

      const slotDate = slotDates[0];
      const actualSlotId = slotDate.slot_id;
      if (slot_id && String(slot_id) !== String(actualSlotId)) {
        await connection.rollback();
        return res.json({ code: 400, message: '时段日期不匹配' });
      }

      // 数据库中的 slot_dates 是历史生成记录；周期配置可能已被管理员调整。
      // 提交时在同一事务中再次校验，避免旧日期绕过当前星期限制。
      const allowedDays = String(slotDate.weekdays || '')
        .split(',').map(Number).filter(day => Number.isInteger(day) && day >= 0 && day <= 6);
      if (allowedDays.length > 0 && Number(slotDate.manual_override) !== 1 && !allowedDays.includes(getChinaJsDayOfWeek(slotDate.play_date))) {
        await connection.rollback();
        return res.json({ code: 400, message: '该日期不在当前开放周期内，请选择其他日期' });
      }

      const [countResult] = await connection.execute(
        'SELECT COUNT(*) as cnt FROM song_requests WHERE slot_date_id = ? AND deleted_at IS NULL AND status IN ("pending","approved")',
        [slotDateId]
      );
      if (Number(countResult[0].cnt) >= Number(slotDate.max_songs)) {
        await connection.rollback();
        return res.json({ code: 400, message: '该时段点歌已满' });
      }

      const [settingsRows] = await connection.execute('SELECT config_value FROM settings WHERE config_key = "daily_song_limit"');
      const dailyLimit = getDailySongLimit(settingsRows.length > 0 ? settingsRows[0].config_value : undefined);
      const { todayStart, tomorrowStart } = getChinaDayRange();
      const [userSongCount] = await connection.execute(
        'SELECT COUNT(*) as cnt FROM song_requests WHERE user_id = ? AND deleted_at IS NULL ' +
        "AND created_at >= CONVERT_TZ(?, '+08:00', @@session.time_zone) " +
        "AND created_at < CONVERT_TZ(?, '+08:00', @@session.time_zone)",
        [req.user.id, todayStart, tomorrowStart]
      );
      if (Number(userSongCount[0].cnt) >= dailyLimit) {
        await connection.rollback();
        return res.json({ code: 400, message: '您今日已点' + dailyLimit + '首歌，已达到每日上限，请明天再来' });
      }

      const [result] = await connection.execute(
        'INSERT INTO song_requests (user_id, song_name, artist, message, to_whom, slot_id, slot_date_id, is_anonymous) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [req.user.id, songName, songArtist, message || '', to_whom || '', actualSlotId, slotDateId, anonymous ? 1 : 0]
      );
      await connection.commit();
      pendingReviewNotice = {
        songName,
        artist: songArtist,
        playDate: slotDate.play_date,
        slotName: slotDate.slot_name,
        startTime: slotDate.start_time,
        endTime: slotDate.end_time,
        requesterName: anonymous ? '匿名' : (req.user.nickname || req.user.username || '同学')
      };
      res.json({ code: 200, message: '点歌成功', data: { id: result.insertId } });
    } catch (transactionError) {
      try { await connection.rollback(); } catch (_) {}
      throw transactionError;
    } finally {
      connection.release();
    }

    // 邮件只在事务提交成功后异步发送；SMTP 或邮件日志失败均不能影响点歌结果。
    if (pendingReviewNotice) {
      setImmediate(function() {
        notifyRadioAdminsNewSongPending(pendingReviewNotice).catch(function(err) {
          console.error('[Songs] 通知广播管理员审核失败:', err.message);
        });
      });
    }
  } catch (err) {
    console.error('点歌错误:', err.message);
    res.json({ code: 500, message: '服务器错误，请稍后重试' });
  }
});

router.get('/list', optionalAuth, async (req, res) => {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  try {
    const { limit, offset } = getListPagination(req.query, 50, 100);
    const [songs] = await pool.execute(
      'SELECT sr.*, ts.name as slot_name, DATE_FORMAT(sd.play_date, \'%Y-%m-%d\') as play_date, ' +
      'CASE WHEN sr.is_anonymous = 1 THEN NULL ELSE COALESCE(u.nickname, u.username) END as author_name, ' +
      'CASE WHEN sr.is_anonymous = 1 THEN NULL ELSE u.avatar END as author_avatar ' +
      'FROM song_requests sr ' +
      'LEFT JOIN time_slots ts ON sr.slot_id = ts.id ' +
      'LEFT JOIN slot_dates sd ON sr.slot_date_id = sd.id ' +
      'LEFT JOIN users u ON sr.user_id = u.id ' +
      'WHERE sr.deleted_at IS NULL AND sr.status IN ("approved","played") ' +
      'ORDER BY sd.play_date, ts.start_time, sr.id LIMIT ? OFFSET ?',
      [limit, offset]
    );
    res.json({ code: 200, data: songs });
  } catch (err) {
    console.error('获取列表错误:', err.message);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取当前用户的点歌记录
router.get('/my', auth, async (req, res) => {
  try {
    const { limit, offset } = getListPagination(req.query, 20, 100);
    const [songs] = await pool.execute(
      'SELECT sr.*, ts.name as slot_name, ts.start_time, ts.end_time, DATE_FORMAT(sd.play_date, \'%Y-%m-%d\') as play_date FROM song_requests sr ' +
      'LEFT JOIN time_slots ts ON sr.slot_id = ts.id ' +
      'LEFT JOIN slot_dates sd ON sr.slot_date_id = sd.id ' +
      'WHERE sr.user_id = ? AND sr.deleted_at IS NULL ORDER BY sr.created_at DESC, sr.id DESC LIMIT ? OFFSET ?',
      [req.user.id, limit, offset]
    );
    res.json({ code: 200, data: songs });
  } catch (err) {
    console.error('获取我的点歌错误:', err.message);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 撤回点歌（仅本人，未播出的可撤回）
router.delete('/:id', auth, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM song_requests WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
      [req.params.id, req.user.id]
    );
    if (rows.length === 0) {
      return res.json({ code: 403, message: '无权撤回或记录不存在' });
    }
    if (rows[0].status === 'played') {
      return res.json({ code: 400, message: '该歌曲已播出，无法撤回' });
    }
    const [updated] = await pool.execute('UPDATE song_requests SET deleted_at = NOW() WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [req.params.id, req.user.id]);
    res.json({
      code: updated.affectedRows > 0 ? 200 : 404,
      message: updated.affectedRows > 0 ? '已撤回' : '歌曲不存在或已撤回'
    });
  } catch (err) {
    console.error('撤回点歌错误:', err.message);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ===== 投票功能 =====

// 获取热门歌曲排行榜
router.get('/hot', async (req, res) => {
  try {
    const { limit, offset } = getListPagination(req.query, 50, 100);
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
      'ORDER BY sr.hot_score DESC, sr.created_at DESC, sr.id DESC ' +
      'LIMIT ? OFFSET ?',
      [limit, offset]
    );
    res.json({ code: 200, data: songs });
  } catch (err) {
    console.error('获取热门歌曲错误:', err.message);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 投票/取消投票
router.post('/vote', auth, async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    const { song_request_id, vote_type } = req.body;
    
    if (!song_request_id || !vote_type || !['up', 'down'].includes(vote_type)) {
      return res.json({ code: 400, message: '参数错误' });
    }

    await connection.beginTransaction();

    // 锁定歌曲行，把同一首歌的投票切换串行化，避免并发请求覆盖热度。
    const [songs] = await connection.execute(
      'SELECT id, hot_score FROM song_requests WHERE id = ? AND deleted_at IS NULL FOR UPDATE',
      [song_request_id]
    );
    if (songs.length === 0) {
      await connection.rollback();
      return res.json({ code: 404, message: '歌曲不存在' });
    }

    const currentScore = songs[0].hot_score || 0;

    // 检查是否已投票
    const [existingVotes] = await connection.execute(
      'SELECT id, vote_type FROM song_votes WHERE song_request_id = ? AND user_id = ? FOR UPDATE',
      [song_request_id, req.user.id]
    );

    let newScore = currentScore;
    
    if (existingVotes.length > 0) {
      // 已投票，取消投票
      await connection.execute(
        'DELETE FROM song_votes WHERE song_request_id = ? AND user_id = ?',
        [song_request_id, req.user.id]
      );
      // 恢复分数
      newScore = existingVotes[0].vote_type === 'up' ? currentScore - 1 : currentScore + 1;
    } else {
      // 新投票
      await connection.execute(
        'INSERT INTO song_votes (song_request_id, user_id, vote_type) VALUES (?, ?, ?)',
        [song_request_id, req.user.id, vote_type]
      );
      // 更新分数
      newScore = vote_type === 'up' ? currentScore + 1 : currentScore - 1;
    }

    // 更新歌曲热度
    await connection.execute(
      'UPDATE song_requests SET hot_score = ? WHERE id = ?',
      [newScore, song_request_id]
    );

    await connection.commit();

    res.json({ 
      code: 200, 
      message: existingVotes.length > 0 ? '已取消投票' : '投票成功',
      data: { hot_score: newScore }
    });
  } catch (err) {
    if (connection) {
      try { await connection.rollback(); } catch (_) {}
    }
    console.error('投票错误:', err.message);
    res.json({ code: 500, message: '服务器错误' });
  } finally {
    if (connection) connection.release();
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
      'SELECT id FROM song_requests WHERE id = ? AND deleted_at IS NULL',
      [song_request_id]
    );
    if (songs.length === 0) {
      return res.json({ code: 404, message: '歌曲不存在' });
    }

    // 更新热度分数
    await pool.execute(
      'UPDATE song_requests SET hot_score = ? WHERE id = ? AND deleted_at IS NULL',
      [parseInt(score), song_request_id]
    );

    // 记录日志
    await pool.execute(
      'INSERT INTO admin_logs (admin_id, action, detail, level) VALUES (?, ?, ?, ?)',
      [req.user.id, 'update_song_score', `修改歌曲ID ${song_request_id} 的热度为 ${score}`, 'info']
    );

    res.json({ code: 200, message: '修改成功', data: { hot_score: parseInt(score) } });
  } catch (err) {
    console.error('修改热度错误:', err.message);
    res.json({ code: 500, message: '服务器错误' });
  }
});

module.exports = router;
