'use strict';

const { getChinaDate, getChinaJsDayOfWeek } = require('./date');

function normalizeDateOnly(value) {
  if (!value) return null;
  const date = String(value).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

function slotDateValue(value) {
  return value ? String(value).split('T')[0] : '';
}

function parseSongSlotDateId(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

// slot_dates 是已生成的日期记录，周期规则后来被修改时仍可能残留旧记录。
// 审核改期和用户提交都必须再次按当前规则校验，不能把旧记录当作可用时段。
function isSlotDateAllowedByCurrentSchedule(slotDate) {
  const allowedDays = String(slotDate.weekdays || '')
    .split(',').map(Number).filter(day => Number.isInteger(day) && day >= 0 && day <= 6);
  return allowedDays.length === 0 || Number(slotDate.manual_override) === 1 ||
    allowedDays.includes(getChinaJsDayOfWeek(slotDateValue(slotDate.play_date)));
}

function songReviewValidationError(message) {
  const error = new Error(message);
  error.isSongReviewValidationError = true;
  return error;
}

function assertCustomPlayDate(value) {
  const playDate = normalizeDateOnly(value);
  if (!playDate) throw songReviewValidationError('播放日期格式不正确，请选择日期');
  const today = getChinaDate();
  if (playDate < today) throw songReviewValidationError('播放日期不能早于今天');
  if (playDate > getChinaDate(365)) throw songReviewValidationError('播放日期最多只能安排未来一年');
  return playDate;
}

async function createCustomSlotDate(connection, requestedSlotId, requestedPlayDate) {
  const slotId = parseSongSlotDateId(requestedSlotId);
  if (!slotId) throw songReviewValidationError('请选择有效的播放时段');
  const playDate = assertCustomPlayDate(requestedPlayDate);
  const [slots] = await connection.execute(
    'SELECT id, name, start_time, end_time, weekdays, effective_start_date FROM time_slots WHERE id = ? AND is_active = 1 FOR UPDATE',
    [slotId]
  );
  if (slots.length === 0) throw songReviewValidationError('所选播放时段不存在或已关闭');
  const slot = slots[0];
  if (slot.effective_start_date && playDate < slotDateValue(slot.effective_start_date)) {
    throw songReviewValidationError('播放日期早于该时段的生效日期');
  }
  const [existing] = await connection.execute(
    'SELECT sd.id, sd.slot_id, sd.play_date, sd.max_songs, sd.is_active, sd.manual_override, ts.name AS slot_name, ts.start_time, ts.end_time, ts.weekdays ' +
    'FROM slot_dates sd JOIN time_slots ts ON ts.id = sd.slot_id WHERE sd.slot_id = ? AND sd.play_date = ? FOR UPDATE',
    [slotId, playDate]
  );
  if (existing.length > 0) {
    if (Number(existing[0].is_active) !== 1) throw songReviewValidationError('所选日期已被管理员关闭');
    if (Number(existing[0].manual_override) !== 1 && !isSlotDateAllowedByCurrentSchedule(existing[0])) {
      await connection.execute('UPDATE slot_dates SET manual_override = 1 WHERE id = ?', [existing[0].id]);
      existing[0].manual_override = 1;
    }
    return existing[0];
  }
  let maxSongs = 10;
  const [capacityRows] = await connection.execute(
    'SELECT max_songs FROM slot_dates WHERE slot_id = ? ORDER BY play_date DESC, id DESC LIMIT 1 FOR UPDATE',
    [slotId]
  );
  if (capacityRows.length > 0 && Number(capacityRows[0].max_songs) > 0) {
    maxSongs = Number(capacityRows[0].max_songs);
  }
  await connection.execute(
    'INSERT INTO slot_dates (slot_id, play_date, max_songs, is_active, manual_override) VALUES (?, ?, ?, 1, 1)',
    [slotId, playDate, maxSongs]
  );
  const [created] = await connection.execute(
    'SELECT sd.id, sd.slot_id, sd.play_date, sd.max_songs, sd.is_active, sd.manual_override, ts.name AS slot_name, ts.start_time, ts.end_time, ts.weekdays ' +
    'FROM slot_dates sd JOIN time_slots ts ON ts.id = sd.slot_id WHERE sd.slot_id = ? AND sd.play_date = ? FOR UPDATE',
    [slotId, playDate]
  );
  if (created.length === 0) throw songReviewValidationError('创建播放日期失败，请重试');
  return created[0];
}

async function approveSongWithSchedule(connection, songId, requestedSlotDateId, playOrder, requestedPlayDate, requestedSlotId, allowOverbook = false) {
  const [songs] = await connection.execute(
    'SELECT id, status, slot_id, slot_date_id FROM song_requests WHERE id = ? AND deleted_at IS NULL FOR UPDATE',
    [songId]
  );
  if (songs.length === 0) throw songReviewValidationError('点歌记录不存在或已在回收站');
  if (songs[0].status !== 'pending') throw songReviewValidationError('该点歌已不在待审核状态，请刷新后重试');

  let slotDate;
  if (requestedPlayDate) {
    slotDate = await createCustomSlotDate(connection, requestedSlotId || songs[0].slot_id, requestedPlayDate);
  }
  const slotDateId = requestedPlayDate ? slotDate.id : (requestedSlotDateId || parseSongSlotDateId(songs[0].slot_date_id));
  if (!slotDateId) throw songReviewValidationError('请选择有效的播放时段');

  if (!slotDate) {
    const today = getChinaDate();
    const rangeEnd = getChinaDate(14);
    const [slotDates] = await connection.execute(
      'SELECT sd.id, sd.slot_id, sd.play_date, sd.max_songs, sd.manual_override, ts.name AS slot_name, ts.start_time, ts.end_time, ts.weekdays ' +
      'FROM slot_dates sd JOIN time_slots ts ON ts.id = sd.slot_id ' +
      'WHERE sd.id = ? AND sd.is_active = 1 AND ts.is_active = 1 ' +
      'AND (ts.effective_start_date IS NULL OR sd.play_date >= ts.effective_start_date) ' +
      'AND sd.play_date >= ? AND sd.play_date < ? FOR UPDATE',
      [slotDateId, today, rangeEnd]
    );
    if (slotDates.length === 0) throw songReviewValidationError('所选播放时段不可用、已关闭或已过期，请重新选择');
    slotDate = slotDates[0];
  }
  if (!requestedPlayDate && !isSlotDateAllowedByCurrentSchedule(slotDate)) {
    throw songReviewValidationError('所选日期不在当前开放周期内，请重新选择');
  }

  const [countRows] = await connection.execute(
    'SELECT COUNT(*) AS cnt FROM song_requests WHERE slot_date_id = ? AND id <> ? ' +
    'AND deleted_at IS NULL AND status IN ("pending", "approved")',
    [slotDateId, songId]
  );
  if (!allowOverbook && Number(countRows[0].cnt) >= Number(slotDate.max_songs)) {
    throw songReviewValidationError('所选播放时段已满，请选择其他时段');
  }

  const updates = ['status = ?', 'reject_reason = NULL', 'slot_id = ?', 'slot_date_id = ?'];
  const values = ['approved', slotDate.slot_id, slotDate.id];
  if (playOrder !== undefined) {
    updates.push('play_order = ?');
    values.push(playOrder);
  }
  values.push(songId);
  await connection.execute(
    `UPDATE song_requests SET ${updates.join(', ')} WHERE id = ? AND deleted_at IS NULL`,
    values
  );
  return slotDate;
}

async function rescheduleApprovedSong(connection, songId, requestedSlotDateId, requestedPlayDate, requestedSlotId, allowOverbook = false) {
  const [songs] = await connection.execute(
    'SELECT id, status, slot_id, slot_date_id FROM song_requests WHERE id = ? AND deleted_at IS NULL FOR UPDATE',
    [songId]
  );
  if (songs.length === 0) throw songReviewValidationError('点歌记录不存在或已在回收站');
  if (songs[0].status !== 'approved') throw songReviewValidationError('只有已通过、尚未播放的点歌可以调整播放时间');
  let slotDate;
  if (requestedPlayDate) {
    slotDate = await createCustomSlotDate(connection, requestedSlotId || songs[0].slot_id, requestedPlayDate);
  }
  if (!requestedSlotDateId && !slotDate) throw songReviewValidationError('请选择有效的播放时段');

  if (!slotDate) {
    const today = getChinaDate();
    const [slotDates] = await connection.execute(
      'SELECT sd.id, sd.slot_id, sd.play_date, sd.max_songs, sd.manual_override, ts.name AS slot_name, ts.start_time, ts.end_time, ts.weekdays ' +
      'FROM slot_dates sd JOIN time_slots ts ON ts.id = sd.slot_id ' +
      'WHERE sd.id = ? AND sd.is_active = 1 AND ts.is_active = 1 ' +
      'AND (ts.effective_start_date IS NULL OR sd.play_date >= ts.effective_start_date) ' +
      'AND sd.play_date >= ? FOR UPDATE',
      [requestedSlotDateId, today]
    );
    if (slotDates.length === 0) throw songReviewValidationError('所选播放时段不可用、已关闭或已过期，请重新选择');
    slotDate = slotDates[0];
  }
  if (!requestedPlayDate && !isSlotDateAllowedByCurrentSchedule(slotDate)) {
    throw songReviewValidationError('所选日期不在当前开放周期内，请重新选择');
  }

  const [countRows] = await connection.execute(
    'SELECT COUNT(*) AS cnt FROM song_requests WHERE slot_date_id = ? AND id <> ? ' +
    'AND deleted_at IS NULL AND status IN ("pending", "approved")',
    [slotDate.id, songId]
  );
  if (!allowOverbook && Number(countRows[0].cnt) >= Number(slotDate.max_songs)) {
    throw songReviewValidationError('所选播放时段已满，请选择其他时段');
  }

  const [result] = await connection.execute(
    'UPDATE song_requests SET slot_id = ?, slot_date_id = ? WHERE id = ? AND status = "approved" AND deleted_at IS NULL',
    [slotDate.slot_id, slotDate.id, songId]
  );
  if (result.affectedRows === 0) throw songReviewValidationError('点歌状态已变化，请刷新后重试');
  return slotDate;
}

module.exports = {
  normalizeDateOnly,
  slotDateValue,
  parseSongSlotDateId,
  isSlotDateAllowedByCurrentSchedule,
  songReviewValidationError,
  createCustomSlotDate,
  approveSongWithSchedule,
  rescheduleApprovedSong
};
