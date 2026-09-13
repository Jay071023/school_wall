'use strict';

const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function formatUtcDate(date) {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0')
  ].join('-');
}

/**
 * 返回中国时区的业务日期。使用 UTC getter，避免服务器系统时区影响结果。
 */
function getChinaDate(offsetDays = 0, now = new Date()) {
  const chinaNow = new Date(now.getTime() + CHINA_OFFSET_MS + offsetDays * DAY_MS);
  return formatUtcDate(chinaNow);
}

/**
 * 将 YYYY-MM-DD 转为中国业务周几，周一为 1，周日为 7。
 */
function getChinaDayOfWeek(value) {
  if (value instanceof Date) {
    value = [
      value.getFullYear(),
      String(value.getMonth() + 1).padStart(2, '0'),
      String(value.getDate()).padStart(2, '0')
    ].join('-');
  }
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return NaN;
  const day = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay();
  return day === 0 ? 7 : day;
}

/**
 * 返回与浏览器 Date#getDay() 一致的星期值：周日为 0，周一至周六为 1-6。
 * 点歌时段的 weekdays 历史数据和后台按钮均采用这一套值，不能与上面的
 * 业务周几（周一为 1、周日为 7）混用。
 */
function getChinaJsDayOfWeek(value) {
  if (value instanceof Date) {
    value = [
      value.getFullYear(),
      String(value.getMonth() + 1).padStart(2, '0'),
      String(value.getDate()).padStart(2, '0')
    ].join('-');
  }
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return NaN;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay();
}

/**
 * 将 Date、ISO 时间或数据库常见的本地时间字符串转为中国业务日期。
 * 数据库时间字符串直接取日期部分，避免 Node 按服务器时区重复偏移。
 */
function toChinaDate(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:\s|$)/.test(value.trim())) {
    return value.trim().slice(0, 10);
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : getChinaDate(0, date);
}

module.exports = { getChinaDate, getChinaDayOfWeek, getChinaJsDayOfWeek, toChinaDate };
