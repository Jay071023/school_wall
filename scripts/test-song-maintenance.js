'use strict';

const assert = require('assert');
const { createSongMaintenance } = require('../services/song-maintenance');
const { createSongMaintenanceRepository } = require('../repositories/song-maintenance');
const { parseBoundedPositiveInt } = require('../services/number-utils');
const { getChinaDate, getChinaJsDayOfWeek, getChinaTime } = require('../services/date');

async function main() {
  const fixedNow = new Date('2026-09-30T16:00:00Z');
  const logs = [];
  const logger = { log() {}, error(...parts) { logs.push(parts); } };
  const calls = [];
  let fallback = false;
  let failure = false;
  let slots = [
    { id: 1, weekdays: '1,3', effective_start_date: '2026-10-02', max_songs: 5 },
    { id: 2, weekdays: '', max_songs: null }
  ];
  const db = { async execute(sql, params = []) {
    calls.push({ sql, params });
    if (failure) throw new Error('Fixture database failed');
    if (sql.includes('FROM time_slots WHERE')) {
      if (fallback && sql.includes('max_songs')) throw Object.assign(new Error('Old schema'), { code: 'ER_BAD_FIELD_ERROR' });
      return [slots];
    }
    if (sql.includes('SELECT slot_id, max_songs')) return [[
      { slot_id: 1, max_songs: 20, manual_override: 0 },
      { slot_id: 2, max_songs: 99, manual_override: 1 },
      { slot_id: 2, max_songs: 7, manual_override: 0 }
    ]];
    if (sql.includes('SELECT sr.id')) return [[
      { id: 1, user_id: 1, email: 'example@example.invalid', nickname: 'fixture', song_name: 'example', artist: 'example' },
      { id: 2, user_id: 2, email: 'example@example.invalid' },
      { id: 3, user_id: 3, email: null }
    ]];
    if (sql.startsWith('UPDATE song_requests')) return [{ affectedRows: params[0] === 2 ? 0 : 1 }];
    return [{ affectedRows: 1 }];
  } };
  const emails = [];
  const maintenance = createSongMaintenance({ repository: createSongMaintenanceRepository(db),
    notifySongPlayed: async (...args) => emails.push(args), now: () => fixedNow, logger });

  const first = maintenance.ensureFutureDates();
  assert.equal(maintenance.ensureFutureDates(), first, 'Concurrent date maintenance must share one task');
  assert.equal(await first, true);
  const inserted = calls.filter(call => call.sql.startsWith('INSERT IGNORE'));
  const rows = inserted.flatMap(call => {
    const rows = []; for (let i = 0; i < call.params.length; i += 3) rows.push(call.params.slice(i, i + 3)); return rows;
  });
  const firstSlot = rows.filter(row => row[0] === 1);
  assert.equal(firstSlot.length, 4);
  assert(firstSlot.every(row => row[1] >= '2026-10-02' && [1, 3].includes(getChinaJsDayOfWeek(row[1])) && row[2] === 5));
  const secondSlot = rows.filter(row => row[0] === 2);
  assert.equal(secondSlot.length, 14);
  assert(secondSlot.every(row => row[2] === 7), 'One-day overrides must not become recurring capacity');
  assert.deepEqual(calls.find(call => call.sql.startsWith('DELETE FROM slot_dates')).params, ['2026-10-01']);
  const prune = calls.find(call => call.sql.startsWith('DELETE sd'));
  assert.deepEqual(prune.params, ['2026-10-15']);
  assert(prune.sql.includes('"pending","approved"') && prune.sql.includes('sr.id IS NULL'));

  calls.length = 0;
  assert.deepEqual(await Promise.all([maintenance.markDueApprovedSongsAsPlayed(), maintenance.markDueApprovedSongsAsPlayed()]), [2, 2]);
  await maintenance.drain();
  assert.equal(calls.filter(call => call.sql.includes('SELECT sr.id')).length, 1);
  assert.deepEqual(calls[0].params, ['2026-10-01', '2026-10-01', '00:00:00']);
  assert(calls[0].sql.includes('ts.end_time <= ?') && calls[0].sql.includes('deleted_at IS NULL'));
  assert.equal(emails.length, 1, 'Only successfully claimed songs with email may notify');
  assert.equal(emails[0][4], 1);

  calls.length = 0;
  fallback = true;
  assert.equal(await maintenance.ensureFutureDates(), true);
  assert(calls.some(call => call.sql === 'SELECT id, weekdays, effective_start_date FROM time_slots WHERE is_active = 1'));
  calls.length = 0;
  fallback = false;
  slots = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, weekdays: '', max_songs: 10 }));
  await maintenance.ensureFutureDates();
  const batches = calls.filter(call => call.sql.startsWith('INSERT IGNORE'));
  assert.equal(batches.length, 7);
  assert(batches.every(batch => batch.params.length === 600));
  failure = true;
  assert.equal(await maintenance.ensureFutureDates(), false);
  assert.equal(await maintenance.markDueApprovedSongsAsPlayed(), 0);
  assert(logs.length >= 2);
  for (const invalid of [0, -1, 'abc', '1.5', Number.MAX_SAFE_INTEGER + 1]) assert.equal(parseBoundedPositiveInt(invalid, 3, 100), 3);
  assert.equal(parseBoundedPositiveInt('999', 3, 100), 100);
  assert.equal(getChinaDate(0, fixedNow), '2026-10-01');
  assert.equal(getChinaTime(fixedNow), '00:00:00');
  console.log('[song-maintenance] 通过：中国日期、周期与生效日、容量来源、批量写入、旧库兼容、并发去重及条件通知');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
