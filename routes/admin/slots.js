const express = require('express');
const { pool } = require('../../config/database');
const { requirePermission } = require('../../middleware/auth');
const { getChinaDate, getChinaJsDayOfWeek } = require('../../services/date');
const { getErrorDetail } = require('../../services/async-utils');
const { normalizeDateOnly, slotDateValue } = require('../../services/song-scheduling');

const router = express.Router();

// ===== 时段管理（需要 slots:manage 权限）=====

// 获取时段列表（包含日期）
router.get('/', requirePermission('slots:manage'), async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    const [slots] = await pool.execute('SELECT * FROM time_slots ORDER BY start_time');

    // 返回中国业务日期窗口内的实际日期（包括管理员停用的例外），供后台日历标记。
    // 不能使用数据库 CURDATE()：数据库时区与站点业务时区不一致时，
    // 会导致后台日历和用户端点歌日期相差一天。
    const today = getChinaDate();
    // 编辑日历展示未来 28 天；接口也要覆盖同一窗口，否则保存较后日期后
    // 重新打开时拿不到手动例外，页面会误显示为按星期周期播放。
    const rangeEnd = getChinaDate(28);
    const [allDates] = await pool.execute(
      'SELECT * FROM slot_dates WHERE play_date >= ? AND play_date < ? ORDER BY play_date',
      [today, rangeEnd]
    );

    const result = slots.map(slot => {
      // 根据 weekdays 过滤日期，并格式化日期
      const effectiveStartDate = slotDateValue(slot.effective_start_date);
      let slotDates = allDates.filter(d => d.slot_id === slot.id && (!effectiveStartDate || slotDateValue(d.play_date) >= effectiveStartDate)).map(d => ({
        ...d,
        play_date: d.play_date instanceof Date
          ? d.play_date.toISOString().split('T')[0]
          : String(d.play_date).split('T')[0]
      }));
      if (slot.weekdays && slot.weekdays !== '') {
        const jsDays = slot.weekdays.split(',').map(d => parseInt(d));
        // 周期日期与管理员明确加/停播的单日例外都必须返回给编辑日历。
        slotDates = slotDates.filter(d => {
          if (Number(d.manual_override) === 1) return true;
          return jsDays.includes(getChinaJsDayOfWeek(d.play_date));
        });
      }

      const configuredMaxSongs = Number(slot.max_songs);
      const maxSongs = configuredMaxSongs > 0
        ? Math.min(100, configuredMaxSongs)
        : (slotDates.length > 0 ? Number(slotDates[0].max_songs) || 10 : 10);
      return { ...slot, dates: slotDates, max_songs: maxSongs };
    });

    res.json({ code: 200, data: result });
  } catch (err) {
    console.error('[ERROR] 查询时段失败:', getErrorDetail(err));
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 创建时段
router.post('/', requirePermission('slots:manage'), async (req, res) => {
  try {
    const { name, start_time, end_time, is_active, weekdays, effective_start_date, max_songs } = req.body;
    if (!name || !start_time || !end_time) {
      return res.json({ code: 400, message: '请填写完整信息' });
    }
    const effectiveStartDate = effective_start_date === '' ? null : normalizeDateOnly(effective_start_date);
    if (effective_start_date && !effectiveStartDate) {
      return res.json({ code: 400, message: '生效日期格式不正确' });
    }
    const [result] = await pool.execute(
      'INSERT INTO time_slots (name, start_time, end_time, is_active, weekdays, effective_start_date) VALUES (?, ?, ?, ?, ?, ?)',
      [name, start_time, end_time, is_active !== undefined ? is_active : 1, weekdays || '', effectiveStartDate]
    );

    // 根据 weekdays 设置自动添加未来 N 天的日期
    const slotId = result.insertId;
    const maxSongs = Math.max(1, Math.min(100, Number(max_songs) || 10));
    try {
      await pool.execute('UPDATE time_slots SET max_songs = ? WHERE id = ?', [maxSongs, slotId]);
    } catch (e) {
      // 旧版本数据库没有 time_slots.max_songs 时，容量由 slot_dates 保存。
    }
    const weekdayArr = weekdays ? weekdays.split(',').map(w => parseInt(w.trim())) : [];
    const addedDates = [];

    // 如果设置了weekdays，只添加匹配周几的日期
    for (let i = 0; i < 14; i++) {
      const dateStr = getChinaDate(i);
      if (effectiveStartDate && dateStr < effectiveStartDate) continue;
      if (weekdayArr.length > 0 && !weekdayArr.includes(getChinaJsDayOfWeek(dateStr))) continue;
      await pool.execute(
        'INSERT IGNORE INTO slot_dates (slot_id, play_date, max_songs, is_active) VALUES (?, ?, ?, 1)',
        [slotId, dateStr, maxSongs]
      );
      addedDates.push(dateStr);
    }

    res.json({ code: 200, message: '创建成功', data: { id: slotId, addedDates } });
  } catch (err) {
    console.error('创建时段错误:', getErrorDetail(err));
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ===== 时段日期管理（必须放在 /slots/:id 之前）=====

// 添加时段日期
router.post('/:slotId/dates', requirePermission('slots:manage'), async (req, res) => {
  try {
    const { play_date, max_songs } = req.body;
    if (!play_date) {
      return res.json({ code: 400, message: '请选择日期' });
    }
    await pool.execute(
      'INSERT INTO slot_dates (slot_id, play_date, max_songs, is_active, manual_override) VALUES (?, ?, ?, 1, 1) ON DUPLICATE KEY UPDATE max_songs = ?, is_active = 1, manual_override = 1',
      [req.params.slotId, play_date, max_songs || 10, max_songs || 10]
    );
    res.json({ code: 200, message: '添加成功' });
  } catch (err) {
    console.error('添加时段日期错误:', getErrorDetail(err));
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 批量添加时段日期
router.post('/:slotId/dates/batch', requirePermission('slots:manage'), async (req, res) => {
  try {
    const { dates, max_songs } = req.body;
    if (!dates || !Array.isArray(dates) || dates.length === 0) {
      return res.json({ code: 400, message: '请选择日期' });
    }
    const maxSongs = max_songs || 10;
    for (const date of dates) {
      await pool.execute(
        'INSERT INTO slot_dates (slot_id, play_date, max_songs, is_active, manual_override) VALUES (?, ?, ?, 1, 1) ON DUPLICATE KEY UPDATE max_songs = ?, is_active = 1, manual_override = 1',
        [req.params.slotId, date, maxSongs, maxSongs]
      );
    }
    res.json({ code: 200, message: '批量添加成功' });
  } catch (err) {
    console.error('批量添加时段日期错误:', getErrorDetail(err));
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 编辑时段日历专用：点周期日即停播，点非周期日即加播；均保留为单日例外。
router.put('/:slotId/calendar-dates', requirePermission('slots:manage'), async (req, res) => {
  const rawDates = req.body && req.body.dates;
  if (!Array.isArray(rawDates) || rawDates.length === 0) {
    return res.json({ code: 200, message: '没有需要保存的日期调整', data: { dates: [] } });
  }

  const changes = new Map();
  for (const item of rawDates.slice(0, 60)) {
    const playDate = normalizeDateOnly(item && (item.play_date || item.date));
    if (!playDate) return res.json({ code: 400, message: '日期格式不正确' });
    const isActive = item && (item.is_active === 1 || item.is_active === true || item.is_active === '1') ? 1 : 0;
    changes.set(playDate, isActive);
  }

  const today = getChinaDate();
  const latestDate = getChinaDate(365);
  for (const playDate of changes.keys()) {
    if (playDate < today || playDate > latestDate) {
      return res.json({ code: 400, message: '日期必须在今天起一年内' });
    }
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [slotRows] = await connection.execute(
      'SELECT id FROM time_slots WHERE id = ? FOR UPDATE',
      [req.params.slotId]
    );
    if (slotRows.length === 0) {
      await connection.rollback();
      return res.json({ code: 404, message: '时段不存在' });
    }
    // 旧数据库可能还没有 time_slots.max_songs；缺列时保持默认容量，不能让
    // 日历例外保存整体失败。已有日期仍优先沿用自己的 max_songs。
    let slotDefaultMaxSongs = 10;
    try {
      const [capacityRows] = await connection.execute(
        'SELECT max_songs FROM time_slots WHERE id = ?',
        [req.params.slotId]
      );
      if (capacityRows.length > 0 && Number(capacityRows[0].max_songs) > 0) {
        slotDefaultMaxSongs = Number(capacityRows[0].max_songs);
      }
    } catch (_) {}

    for (const [playDate, isActive] of changes.entries()) {
      const [existing] = await connection.execute(
        'SELECT max_songs FROM slot_dates WHERE slot_id = ? AND play_date = ? FOR UPDATE',
        [req.params.slotId, playDate]
      );
      const maxSongs = existing.length > 0 && Number(existing[0].max_songs) > 0
        ? Number(existing[0].max_songs)
        : slotDefaultMaxSongs;
      await connection.execute(
        'INSERT INTO slot_dates (slot_id, play_date, max_songs, is_active, manual_override) VALUES (?, ?, ?, ?, 1) ' +
        'ON DUPLICATE KEY UPDATE is_active = VALUES(is_active), manual_override = 1',
        [req.params.slotId, playDate, maxSongs, isActive]
      );
    }

    await connection.commit();
    const placeholders = Array.from(changes.keys()).map(() => '?').join(',');
    const [rows] = await connection.execute(
      `SELECT * FROM slot_dates WHERE slot_id = ? AND play_date IN (${placeholders}) ORDER BY play_date`,
      [req.params.slotId, ...changes.keys()]
    );
    res.json({ code: 200, message: '日期调整已保存', data: { dates: rows } });
  } catch (err) {
    if (connection) {
      try { await connection.rollback(); } catch (_) {}
    }
    console.error('[Slots] 批量保存日历失败:', getErrorDetail(err));
    res.json({ code: 500, message: '日期调整保存失败，请重试' });
  } finally {
    if (connection) connection.release();
  }
});

router.post('/:slotId/calendar-date', requirePermission('slots:manage'), async (req, res) => {
  try {
    const playDate = normalizeDateOnly(req.body && req.body.play_date);
    const isActive = req.body && (req.body.is_active === 1 || req.body.is_active === true) ? 1 : 0;
    if (!playDate) return res.json({ code: 400, message: '日期格式不正确' });
    const [slots] = await pool.execute('SELECT id FROM time_slots WHERE id = ?', [req.params.slotId]);
    if (slots.length === 0) return res.json({ code: 404, message: '时段不存在' });
    const [existing] = await pool.execute('SELECT max_songs FROM slot_dates WHERE slot_id = ? AND play_date = ?', [req.params.slotId, playDate]);
    const maxSongs = existing.length > 0 ? existing[0].max_songs : 10;
    await pool.execute(
      'INSERT INTO slot_dates (slot_id, play_date, max_songs, is_active, manual_override) VALUES (?, ?, ?, ?, 1) ON DUPLICATE KEY UPDATE is_active = VALUES(is_active), manual_override = 1',
      [req.params.slotId, playDate, maxSongs, isActive]
    );
    const [rows] = await pool.execute('SELECT * FROM slot_dates WHERE slot_id = ? AND play_date = ?', [req.params.slotId, playDate]);
    res.json({ code: 200, message: isActive ? '已设为当天播放' : '已设为当天不播放', data: rows[0] });
  } catch (err) {
    console.error('[Slots] 日历单日设置失败:', getErrorDetail(err));
    res.json({ code: 500, message: '更新日期失败，请稍后重试' });
  }
});

// 删除时段日期
router.delete('/:slotId/dates/:dateId', requirePermission('slots:manage'), async (req, res) => {
  try {
    // 不能硬删除：自动补齐任务会把符合周期的日期重新插入。
    // 以停用记录保留“这一天不接受投稿”的管理员例外。
    const [result] = await pool.execute(
      'UPDATE slot_dates SET is_active = 0, manual_override = 1 WHERE id = ? AND slot_id = ?',
      [req.params.dateId, req.params.slotId]
    );
    if (result.affectedRows === 0) return res.json({ code: 404, message: '日期不存在' });
    res.json({ code: 200, message: '已关闭该日期投稿，可随时重新开放' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 修改时段日期
router.put('/:slotId/dates/:dateId', requirePermission('slots:manage'), async (req, res) => {
  try {
    const { max_songs, is_active } = req.body;
    const updates = [];
    const values = [];
    if (max_songs !== undefined) { updates.push('max_songs = ?'); values.push(max_songs); }
    if (is_active !== undefined) {
      updates.push('is_active = ?'); values.push(is_active);
      updates.push('manual_override = 1');
    }
    if (updates.length === 0) {
      return res.json({ code: 400, message: '没有修改内容' });
    }
    values.push(req.params.dateId, req.params.slotId);
    await pool.execute(`UPDATE slot_dates SET ${updates.join(', ')} WHERE id = ? AND slot_id = ?`, values);
    res.json({ code: 200, message: '修改成功' });
  } catch (err) {
    console.error('修改时段日期错误:', getErrorDetail(err));
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 修改时段
router.put('/:id', requirePermission('slots:manage'), async (req, res) => {
  try {
    const slotId = req.params.id;
    const body = req.body || {};
    const { name, start_time, end_time, is_active, weekdays, effective_start_date, max_songs } = body;

    // 第一步：更新 time_slots 表（只更新核心字段，不包含 weekdays）
    const slotUpdates = [];
    const slotValues = [];
    if (name !== undefined) { slotUpdates.push('name = ?'); slotValues.push(name); }
    if (start_time !== undefined) { slotUpdates.push('start_time = ?'); slotValues.push(start_time); }
    if (end_time !== undefined) { slotUpdates.push('end_time = ?'); slotValues.push(end_time); }
    if (is_active !== undefined) { slotUpdates.push('is_active = ?'); slotValues.push(is_active); }
    if (weekdays !== undefined) { slotUpdates.push('weekdays = ?'); slotValues.push(weekdays); }
    if (effective_start_date !== undefined) {
      const effectiveStartDate = effective_start_date === '' ? null : normalizeDateOnly(effective_start_date);
      if (effective_start_date && !effectiveStartDate) return res.json({ code: 400, message: '生效日期格式不正确' });
      slotUpdates.push('effective_start_date = ?'); slotValues.push(effectiveStartDate);
    }

    if (slotUpdates.length > 0) {
      slotValues.push(slotId);
      await pool.execute(`UPDATE time_slots SET ${slotUpdates.join(', ')} WHERE id = ?`, slotValues);
    }

    // 第二步：如果传了 max_songs，更新 slot_dates 表（忽略错误）
    if (max_songs !== undefined) {
      const normalizedMaxSongs = Math.max(1, Math.min(100, Number(max_songs) || 10));
      // 新库把时段容量存于 time_slots，旧库可能没有该列，保持兼容。
      try {
        await pool.execute('UPDATE time_slots SET max_songs = ? WHERE id = ?', [normalizedMaxSongs, slotId]);
      } catch (e) {
        // 旧版本数据库没有 time_slots.max_songs 时，继续使用 slot_dates。
      }
      try {
        await pool.execute('UPDATE slot_dates SET max_songs = ? WHERE slot_id = ?', [normalizedMaxSongs, slotId]);
      } catch (e) {
        // 忽略错误，可能是列或表不存在
      }
    }

    // 第三步：周期或生效日期变化后，立即补足未来日期。
    // 已被管理员停用的记录使用 INSERT IGNORE 保留，不会被自动重新开放。
    if (weekdays !== undefined || effective_start_date !== undefined) {
      try {
        const [slotRows] = await pool.execute('SELECT weekdays, effective_start_date FROM time_slots WHERE id = ?', [slotId]);
        const slot = slotRows[0];
        if (!slot) throw new Error('时段不存在');
        const jsDays = String(slot.weekdays || '').split(',').map(Number).filter(day => Number.isInteger(day) && day >= 0 && day <= 6);
        const effectiveStartDate = slotDateValue(slot.effective_start_date);
        let maxSongsVal;
        if (max_songs !== undefined) {
          maxSongsVal = Math.max(1, Math.min(100, Number(max_songs) || 10));
        } else {
          maxSongsVal = Number(slot.max_songs) || 10;
          try {
            const [capacityRows] = await pool.execute(
              'SELECT max_songs FROM slot_dates WHERE slot_id = ? AND manual_override = 0 ORDER BY play_date DESC, id DESC LIMIT 1',
              [slotId]
            );
            if (capacityRows.length > 0 && Number(capacityRows[0].max_songs) > 0) {
              maxSongsVal = Math.min(100, Number(capacityRows[0].max_songs));
            }
          } catch (e) {
            // 兼容旧库，保留 time_slots 的容量。
          }
        }
        if (effectiveStartDate) {
          await pool.execute('UPDATE slot_dates SET is_active = 0 WHERE slot_id = ? AND play_date < ?', [slotId, effectiveStartDate]);
        }
        if (jsDays.length > 0) {
          const mysqlDays = jsDays.map(day => day + 1).join(',');
          await pool.execute(
            `UPDATE slot_dates SET is_active = 0 WHERE slot_id = ? AND manual_override = 0 AND play_date >= ? AND DAYOFWEEK(play_date) NOT IN (${mysqlDays})`,
            [slotId, getChinaDate()]
          );
        }
        for (let i = 0; i < 14; i++) {
          const dateStr = getChinaDate(i);
          if (effectiveStartDate && dateStr < effectiveStartDate) continue;
          if (jsDays.length > 0 && !jsDays.includes(getChinaJsDayOfWeek(dateStr))) continue;
          await pool.execute(
            'INSERT IGNORE INTO slot_dates (slot_id, play_date, max_songs, is_active) VALUES (?, ?, ?, 1)',
            [slotId, dateStr, maxSongsVal]
          );
        }
      } catch (e) {
        console.error('[Slots] 更新时段日期失败:', getErrorDetail(e));
      }
    }

    res.json({ code: 200, message: '修改成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 删除时段
router.delete('/:id', requirePermission('slots:manage'), async (req, res) => {
  try {
    await pool.execute('DELETE FROM time_slots WHERE id = ?', [req.params.id]);
    res.json({ code: 200, message: '删除成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

module.exports = router;
