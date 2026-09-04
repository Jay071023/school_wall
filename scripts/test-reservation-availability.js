'use strict';

const assert = require('assert');
const {
  buildReservationMap,
  buildReservationCountMap,
  normalizeDate
} = require('../services/reservation-availability');
const { getChinaDate, getChinaDayOfWeek, toChinaDate } = require('../services/date');

assert.strictEqual(normalizeDate(new Date('2026-09-01T12:00:00.000Z')), '2026-09-01');
assert.strictEqual(normalizeDate(new Date(2026, 8, 3, 0, 0, 0)), '2026-09-03');
assert.strictEqual(getChinaDate(0, new Date('2026-09-01T15:59:59.000Z')), '2026-09-01');
assert.strictEqual(getChinaDate(0, new Date('2026-09-01T16:00:00.000Z')), '2026-09-02');
assert.strictEqual(getChinaDayOfWeek('2026-09-06'), 7);
assert.strictEqual(getChinaDayOfWeek('2026-09-07T00:00:00.000Z'), 1);
assert.strictEqual(toChinaDate('2026-09-01 23:59:59'), '2026-09-01');
assert.strictEqual(toChinaDate('2026-09-01T16:00:00.000Z'), '2026-09-02');

const rows = [
  { slot_id: 2, reservation_date: '2026-09-02' },
  { slot_id: 2, reservation_date: new Date('2026-09-03T00:00:00.000Z') }
];
const userReservations = buildReservationMap(rows);
assert.strictEqual(userReservations.has('2_2026-09-02'), true);
assert.strictEqual(userReservations.has('2_2026-09-03'), true);

const counts = buildReservationCountMap([
  { slot_id: 2, reservation_date: '2026-09-02', reserved_count: '3' },
  { slot_id: 3, reservation_date: '2026-09-02', reserved_count: 1 }
]);
assert.strictEqual(counts['2_2026-09-02'], 3);
assert.strictEqual(counts['3_2026-09-02'], 1);

console.log('[reservation] 通过：日期规范化、用户预定映射和批量名额统计均符合预期');
