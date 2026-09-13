'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const database = read('config/database.js');
const admin = read('routes/admin.js');
const songs = read('routes/songs.js');
const adminHtml = read('frontend/admin/index.html');
const { getChinaJsDayOfWeek } = require(path.join(root, 'services', 'date'));

assert(database.includes('effective_start_date DATE DEFAULT NULL'), 'time_slots 必须保存周期生效日期');
assert(database.includes('manual_override TINYINT DEFAULT 0'), 'slot_dates 必须保存单日播放例外');
assert(database.includes('UPDATE slot_dates SET is_active = 1 WHERE is_active IS NULL'), '迁移只能补齐空状态，不能重置管理员关闭的日期');
assert(!database.includes('UPDATE slot_dates SET is_active = 1 WHERE is_active = 0 OR is_active IS NULL'), '不能在启动时重新开放已关闭日期');
assert(songs.includes('effective_start_date') && songs.includes('dateStr < effectiveStartDate'), '自动补齐必须遵守周期生效日期');
assert(!songs.includes('UPDATE slot_dates SET max_songs = ? WHERE max_songs != ? AND play_date >= ?'), '自动补齐不得用全局设置覆盖所有时段容量');
assert(songs.includes('slotCapacityById') && songs.includes('manual_override') && songs.includes('max_songs FROM time_slots'), '自动补齐必须按时段读取容量并跳过单日例外');
assert(songs.includes('该日期不在当前开放周期内'), '提交点歌必须再次校验当前星期周期');
assert.strictEqual(getChinaJsDayOfWeek('2026-09-08'), 2, '周二必须使用历史时段数据的值 2');
assert.strictEqual(getChinaJsDayOfWeek('2026-09-06'), 0, '周日必须使用历史时段数据的值 0');
assert(songs.indexOf('该日期不在当前开放周期内') < songs.indexOf('await connection.commit()'), '星期校验必须在提交事务前完成');
assert(admin.includes("UPDATE slot_dates SET is_active = 0, manual_override = 1 WHERE id = ? AND slot_id = ?"), '移除日期必须保留为禁用例外，防止自动补齐复活');
assert(admin.includes('INSERT IGNORE INTO slot_dates'), '补齐日期不能覆盖管理员关闭的记录');
assert(admin.includes("router.post('/slots/:slotId/calendar-date'"), '编辑日历必须有单日加播或停播接口');
assert(admin.includes('manual_override = 1'), '单日加播或停播必须保留为例外，不能被星期周期覆盖');
assert(songs.includes('Number(d.manual_override) === 1'), '用户投稿列表必须识别非周期日的单日加播');
assert(adminHtml.includes('id="slot-start-date-calendar"'), '后台必须提供可直接点击的播放日历，不依赖手机 yyyy/mm/dd 输入');
assert(adminHtml.includes('点紫色日期可设为不播放') && adminHtml.includes('点灰色日期可临时加播'), '日历必须直接表达取消播放和临时加播');
assert(adminHtml.includes('renderSlotStartDateCalendar') && adminHtml.includes('toggleSlotEditCalendarDate'), '切换星期或点击日期必须即时刷新播放安排');
assert(adminHtml.includes('loadSlotEditCalendarDates(id)'), '编辑既有时段时必须载入单日例外');
assert(!adminHtml.includes('manageSlotDates'), '时段列表不应再提供重复的日期管理入口');
assert(!adminHtml.includes('id="slot-dates-modal"'), '日期管理弹窗应收拢到编辑日历，避免两处操作');
assert(!adminHtml.includes('id="slot-date-input"'), '日期管理不应继续暴露手机难操作的 YYYY-MM-DD 输入');
assert(admin.includes('createCustomSlotDate'), '无预约日期的旧点歌必须支持审核时创建单日播放日期');
assert(admin.includes('requestedPlayDate') && adminHtml.includes('play_date: customDate'), '审核和改期必须支持管理员指定播放日期');
assert(admin.includes('slot_choices: slotChoices'), '审核接口必须返回可选播放时段供无日期点歌补全');
assert(admin.includes('is_full: Number(row.occupied_count) >= Number(row.max_songs)'), '审核选项必须保留已满日期并标注容量状态');
assert(admin.includes('allowOverbook') && admin.includes('if (!allowOverbook && Number(countRows[0].cnt)'), '管理员超额排入必须由后端显式开关控制');
assert(adminHtml.includes('id="song-approval-custom-date"') && adminHtml.includes('id="song-approval-custom-slot"'), '后台审核弹窗必须提供自定义日期和时段');
assert(adminHtml.includes('approvalBody.play_date = customDate'), '后台确认通过必须提交自定义播放日期');
assert(adminHtml.includes('song-approval-allow-overbook') && adminHtml.includes('approvalBody.allow_overbook = true'), '前端必须提供管理员超额排入选项并提交开关');
assert.strictEqual(adminHtml, read('public/admin/index.html'), '后台审核页面镜像必须一致');
assert.strictEqual(read('frontend/admin/css/admin.css'), read('public/admin/css/admin.css'), '后台样式镜像必须一致');

console.log('[radio-slot-schedule] 通过：星期周期与单日加播/停播例外均已收拢到编辑日历');
