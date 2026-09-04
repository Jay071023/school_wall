'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { getChinaDate } = require('../services/date');

const routeRoot = path.join(__dirname, '..', 'routes');
const checkinSource = fs.readFileSync(path.join(routeRoot, 'checkin.js'), 'utf8');
const leaderboardSource = fs.readFileSync(path.join(routeRoot, 'leaderboard.js'), 'utf8');

// 固定边界时间：UTC 15:59 是中国次日 23:59，UTC 16:00 应切到新业务日。
assert.strictEqual(getChinaDate(0, new Date('2026-08-31T15:59:59.000Z')), '2026-08-31');
assert.strictEqual(getChinaDate(0, new Date('2026-08-31T16:00:00.000Z')), '2026-09-01');
assert.strictEqual(getChinaDate(-1, new Date('2026-09-01T00:30:00+08:00')), '2026-08-31');

// 防止签到回退到服务器时区或拆开的多连接写入流程。
assert.match(checkinSource, /require\('\.\.\/services\/date'\)/);
assert.doesNotMatch(checkinSource, /new Date\(\)\.toISOString\(\)/);
assert.match(checkinSource, /beginTransaction\(\)/);
assert.match(checkinSource, /SELECT points FROM users WHERE id = \? FOR UPDATE/);
assert.match(checkinSource, /connection\.commit\(\)/);
assert.match(checkinSource, /connection\.release\(\)/);

// 排行榜的周榜必须使用同一业务日期来源，用户榜不再为每个用户执行相关子查询。
assert.match(leaderboardSource, /require\('\.\.\/services\/date'\)/);
assert.doesNotMatch(leaderboardSource, /toISOString\(\)/);
assert.match(leaderboardSource, /GROUP BY u\.id, u\.nickname, u\.username, u\.avatar/);
assert.match(leaderboardSource, /LEFT JOIN \(\s*SELECT post_id, COUNT\(\*\)/s);

console.log('[checkin-leaderboard] 通过：中国日期切换、签到事务和排行榜查询结构检查均符合预期');
