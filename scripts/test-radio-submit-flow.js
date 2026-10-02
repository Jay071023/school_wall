const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const database = read('config/database.js');
const songsRoute = read('routes/songs.js');
const radioSource = read('frontend/js/radio.js');
const radioHtml = read('frontend/radio.html');

assert(!database.includes('FOREIGN KEY (slot_id) REFERENCES song_slots(id)'), '新建点歌表不能把新版 slot_id 外键指向旧 song_slots 表');
assert(database.includes("TABLE_NAME = ? AND COLUMN_NAME = ? AND REFERENCED_TABLE_NAME = ?") && database.includes("['song_requests', 'slot_id', 'song_slots']"), '数据库启动迁移必须定位旧 song_slots 外键');
assert(database.includes('DROP FOREIGN KEY') && database.includes('legacySongSlotForeignKeys'), '数据库启动迁移必须移除旧 song_slots 外键');
assert(songsRoute.includes('WHERE sd.id = ? AND sd.is_active = 1 AND ts.is_active = 1') && songsRoute.includes('actualSlotId'), '点歌接口必须在事务中依据有效日期验证新版时段 ID');
assert(radioSource.includes('var songSubmitInFlight = false') && radioSource.includes('if (songSubmitInFlight) return;'), '重复触发提交时必须只允许一个请求');
assert(radioSource.includes('async function(e)') && radioSource.includes('songSubmitInFlight = false;') && radioSource.includes("submitBtn.textContent = '提交点歌';"), '提交请求结束后必须恢复状态');
assert(radioHtml.includes('/js/radio.js?v=20261002'), '点歌脚本版本号必须更新以刷新移动端缓存');

console.log('[radio-submit-flow] 通过：旧外键迁移、事务校验、单次提交保护、终态恢复及缓存版本均符合预期');
