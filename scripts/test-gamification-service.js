'use strict';

const assert = require('assert');

async function main() {
  const events = [];
  let failInsert = false;
  const connection = {
    async beginTransaction() { events.push(['begin']); },
    async execute(sql, params) {
      events.push(['execute', sql, params]);
      if (sql.startsWith('SELECT id, points FROM users')) return [[{ id: 7, points: 10 }]];
      if (sql.startsWith('UPDATE users SET points')) return [{ affectedRows: 1 }];
      if (sql.startsWith('INSERT INTO points_log')) {
        if (failInsert) throw new Error('log insert failed');
        return [{ insertId: 1 }];
      }
      if (sql.startsWith('SELECT id, user_id, points')) return [[]];
      throw new Error('unexpected SQL: ' + sql);
    },
    async commit() { events.push(['commit']); },
    async rollback() { events.push(['rollback']); },
    release() { events.push(['release']); }
  };
  const fakePool = { async getConnection() { return connection; } };
  const databasePath = require.resolve('../config/database');
  const servicePath = require.resolve('../services/gamification');
  const originalDatabase = require.cache[databasePath];
  const originalService = require.cache[servicePath];
  require.cache[databasePath] = {
    id: databasePath,
    filename: databasePath,
    loaded: true,
    exports: { pool: fakePool }
  };
  delete require.cache[servicePath];

  try {
    const { adjustUserPoints } = require('../services/gamification');
    const result = await adjustUserPoints(7, 2, 'post', { relatedId: 33, includeLogs: false });
    assert.deepStrictEqual(result, { balance: 12, logs: [] });
    const insert = events.find((event) => event[0] === 'execute' && event[1].startsWith('INSERT INTO points_log'));
    assert.deepStrictEqual(insert[2], [7, 2, 12, 'post', 33], '积分日志必须记录事务内新余额和关联业务 ID');
    assert(!events.some((event) => event[0] === 'execute' && event[1].startsWith('SELECT id, user_id, points')), '后台自动奖励不应读取无用的最近日志');
    assert(events.some((event) => event[0] === 'commit'), '积分与日志写入成功后必须提交');

    events.length = 0;
    failInsert = true;
    await assert.rejects(
      () => adjustUserPoints(7, 1, 'comment', { relatedId: 44, includeLogs: false }),
      /log insert failed/
    );
    assert(events.some((event) => event[0] === 'rollback'), '日志写入失败时余额事务必须回滚');
    assert(events.some((event) => event[0] === 'release'), '失败后必须释放数据库连接');
  } finally {
    delete require.cache[servicePath];
    if (originalService) require.cache[servicePath] = originalService;
    if (originalDatabase) require.cache[databasePath] = originalDatabase;
    else delete require.cache[databasePath];
  }

  console.log('[gamification-service] 通过：积分余额与日志原子更新，后台奖励不读取无用日志');
}

main().catch((error) => {
  console.error('[gamification-service] 失败:', error.message);
  process.exitCode = 1;
});
