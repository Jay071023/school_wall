'use strict';

// Accepts a pool or transaction connection; never creates or owns a connection.
function createSongMaintenanceRepository(db) {
  return {
    async findDueSongs(today, time) {
      const [rows] = await db.execute(
        `SELECT sr.id, sr.song_name, sr.artist, sr.user_id, u.email, u.nickname, u.username
         FROM song_requests sr
         JOIN slot_dates sd ON sd.id = sr.slot_date_id
         JOIN time_slots ts ON ts.id = sr.slot_id
         LEFT JOIN users u ON u.id = sr.user_id
         WHERE sr.status = 'approved' AND sr.deleted_at IS NULL
           AND (sd.play_date < ? OR (sd.play_date = ? AND ts.end_time <= ?))`,
        [today, today, time]);
      return rows;
    },
    async markPlayed(id) {
      const [result] = await db.execute(
        "UPDATE song_requests SET status = 'played', reject_reason = NULL WHERE id = ? AND status = 'approved' AND deleted_at IS NULL", [id]);
      return result.affectedRows > 0;
    },
    async findActiveSlots() {
      try {
        const [slots] = await db.execute('SELECT id, weekdays, effective_start_date, max_songs FROM time_slots WHERE is_active = 1');
        return { slots, hasSlotCapacity: true };
      } catch (error) {
        const [slots] = await db.execute('SELECT id, weekdays, effective_start_date FROM time_slots WHERE is_active = 1');
        return { slots, hasSlotCapacity: false };
      }
    },
    async findFutureCapacities(today) {
      const [rows] = await db.execute('SELECT slot_id, max_songs, manual_override FROM slot_dates WHERE play_date >= ? ORDER BY play_date DESC, id DESC', [today]);
      return rows;
    },
    async insertDates(batch) {
      const placeholders = batch.map(() => '(?, ?, ?)').join(', ');
      const [result] = await db.execute(
        `INSERT IGNORE INTO slot_dates (slot_id, play_date, max_songs) VALUES ${placeholders}`, batch.flat());
      return result.affectedRows || 0;
    },
    async pruneDates(today, rangeEnd) {
      await db.execute('DELETE FROM slot_dates WHERE play_date < ?', [today]);
      await db.execute(
        'DELETE sd FROM slot_dates sd LEFT JOIN song_requests sr ON sd.id = sr.slot_date_id AND sr.status IN ("pending","approved") ' +
        'WHERE sd.play_date >= ? AND sr.id IS NULL', [rangeEnd]);
    }
  };
}

module.exports = { createSongMaintenanceRepository };
