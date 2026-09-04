'use strict';

function normalizeDate(value) {
  if (value instanceof Date) {
    // 预约日期是业务上的“本地日历日”，不能用 UTC 字符串转换，
    // 否则东八区的本地零点可能被转换成前一天。
    return [
      value.getFullYear(),
      String(value.getMonth() + 1).padStart(2, '0'),
      String(value.getDate()).padStart(2, '0')
    ].join('-');
  }
  return String(value).split('T')[0];
}

function reservationKey(slotId, reservationDate) {
  return String(slotId) + '_' + normalizeDate(reservationDate);
}

function buildReservationMap(rows) {
  const result = new Set();
  for (const row of rows || []) {
    result.add(reservationKey(row.slot_id, row.reservation_date));
  }
  return result;
}

function buildReservationCountMap(rows) {
  const result = Object.create(null);
  for (const row of rows || []) {
    result[reservationKey(row.slot_id, row.reservation_date)] = Number(row.reserved_count) || 0;
  }
  return result;
}

module.exports = {
  buildReservationMap,
  buildReservationCountMap,
  normalizeDate,
  reservationKey
};
