'use strict';

// 离线状态机回归：不连 MySQL、不请求微信。
const assert = require('assert');
const fs = require('fs');
const Module = require('module');

const originalLoad = Module._load;
const originalSetInterval = global.setInterval;
Module._load = function(request, parent, isMain) {
  if (request === 'express') {
    return { Router: function() {
      return {
        use() {}, get() {}, post() {}, delete() {}
      };
    }};
  }
  if (request === '../config/database') return { pool: {} };
  if (request === '../services/mp-draft') return {};
  if (request === '../middleware/auth') return { auth() {}, isStaff() {}, requirePermission() { return function() {}; } };
  if (request === '../services/pagination') return { getPagination() { return { limit: 20 }; } };
  if (request === '../services/html-utils') return { escapeHtml(value) { return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); } };
  return originalLoad.call(this, request, parent, isMain);
};
global.setInterval = function() { return null; };

let state;
try {
  delete require.cache[require.resolve('../routes/mp-draft')];
  state = require('../routes/mp-draft')._dailySongState;
} finally {
  Module._load = originalLoad;
  global.setInterval = originalSetInterval;
}

assert.ok(state, '每日推歌状态机测试入口缺失');
const now = new Date('2026-09-04T12:00:00.000Z');
assert.strictEqual(state.isDailySongCandidate({ status: 'pending' }, now), true, '未发布歌曲必须始终可见');
assert.strictEqual(state.isDailySongCandidate({ status: 'pending', candidate_hidden_at: '2026-09-04T10:00:00.000Z' }, now), false, '已移出候选的歌曲不得继续出现在公众号推送页');
assert.strictEqual(state.isDailySongCandidate({ status: 'published', published_at: '2026-09-01T12:00:00.000Z' }, now), true, '刚好三天内的已发布歌曲仍可复用');
assert.strictEqual(state.isDailySongCandidate({ status: 'published', published_at: '2026-09-01T11:59:59.999Z' }, now), false, '超过三天的已发布歌曲不可再选');
assert.strictEqual(state.isDailySongCandidate({ status: 'published', published_at: null, created_at: '2026-09-02T12:00:00.000Z' }, now), true, '旧记录缺少发布时间时，三天内应按创建时间继续可见');
assert.strictEqual(state.isDailySongCandidate({ status: 'published', published_at: null, created_at: '2026-08-30T12:00:00.000Z' }, now), false, '旧记录回退到创建时间后仍必须遵守三天窗口');

assert.deepStrictEqual(state.normalizeDailySongIds(undefined), { ok: true, ids: [] });
assert.deepStrictEqual(state.normalizeDailySongIds([7, 9]), { ok: true, ids: [7, 9] });
assert.strictEqual(state.normalizeDailySongIds([7, 7]).ok, false, '重复 ID 不能导致重复标记');
assert.strictEqual(state.normalizeDailySongIds(['7']).ok, false, 'ID 必须是整数，不能接受字符串参数');
assert.strictEqual(state.normalizeDailySongIds(Array.from({ length: 51 }, (_, index) => index + 1)).ok, false, '同步数量必须受限');
assert.match(state.dailySongCandidateSql(), /status = 'pending'/);
assert.match(state.dailySongCandidateSql(), /INTERVAL 3 DAY/);
assert.match(state.dailySongCandidateSql(), /candidate_hidden_at IS NULL/, '公众号推送候选查询必须排除已移出的歌曲');
assert.match(state.dailySongCandidateSql(), /COALESCE\(/, '候选查询必须兼容已发布但缺少发布时间的旧记录');

// 候选曲库的管理操作不能伪造已发布；仅允许移出候选或真正删除。
const adminRoute = fs.readFileSync(require.resolve('../routes/admin'), 'utf8');
const adminPage = fs.readFileSync(require.resolve('../frontend/admin/index.html'), 'utf8');
assert.match(adminRoute, /candidate_hidden_at IS NULL/, '公众号候选查询必须排除被移出的歌曲');
assert.match(adminRoute, /daily-songs\/candidate-visibility/, '后台必须提供独立的候选可见性接口');
assert.match(adminRoute, /UPDATE daily_song_recs SET candidate_hidden_at/, '移出候选不得改写发布状态');
assert.match(adminRoute, /router\.delete\('\/daily-songs'/, '批量删除必须走单次接口并返回实际影响数量');
assert.match(adminPage, /dailySongsPageSize/, '候选曲库必须支持每页显示数量');
assert.match(adminPage, /已同步，无需再次推送/, '已发布歌曲不得继续提示重复推送');
assert.match(adminPage, /列表已即时更新/, '删除成功后必须给出即时反馈');

(async function() {
  const events = [];
  const mediaId = await state.finalizeDailySongSync(
    async function(articles) { events.push(['create', articles.length]); return 'media-ok'; },
    async function(ids) { events.push(['mark', ids]); return { requested: ids.length, affected: ids.length, changed: ids.length, affectedRows: ids.length }; },
    [{ title: '测试文章' }],
    [7, 9]
  );
  assert.strictEqual(mediaId, 'media-ok');
  assert.deepStrictEqual(events, [['create', 1], ['mark', [7, 9]]], '创建草稿成功后才可标记已发布');

  let markedAfterFailure = false;
  await assert.rejects(
    state.finalizeDailySongSync(
      async function() { throw new Error('wechat unavailable'); },
      async function() { markedAfterFailure = true; },
      [{ title: '失败文章' }],
      [7]
    ),
    /wechat unavailable/
  );
  assert.strictEqual(markedAfterFailure, false, '同步失败或仅生成预览时不得误标已发布');

  let markError;
  await assert.rejects(
    state.finalizeDailySongSync(
      async function() { return 'media-created-before-mark-error'; },
      async function() { throw new Error('database unavailable'); },
      [{ title: '标记失败文章' }],
      [7]
    ),
    function(error) {
      markError = error;
      return error && error.draftCreated === true && error.mediaId === 'media-created-before-mark-error' && error.code === 'DAILY_SONG_MARK_FAILED';
    },
    '草稿创建后标记失败必须保留已创建草稿的媒体 ID'
  );
  assert.match(state.formatDraftCreatedMarkFailure(markError), /草稿已创建/);

  await assert.rejects(
    state.finalizeDailySongSync(
      async function() { return 'media-created-before-short-mark'; },
      async function() { return { requested: 2, affected: 1, changed: 1, affectedRows: 1 }; },
      [{ title: '并发变化文章' }],
      [7, 9]
    ),
    function(error) {
      return error && error.draftCreated === true && error.code === 'DAILY_SONG_MARK_CONFLICT' && error.markResult.affected === 1;
    },
    '标记实际影响量不足时必须报告并发冲突，不能当成普通失败'
  );

  let executed;
  const markResult = await state.markDailySongsPublished({
    async execute(sql, params) { executed = { sql, params }; return [{ affectedRows: 2 }]; }
  }, [7, 9]);
  assert.deepStrictEqual(executed.params, [7, 9]);
  assert.match(executed.sql, /published_at = COALESCE\(published_at, NOW\(\)\)/);
  assert.deepStrictEqual(markResult, { requested: 2, affected: 2, changed: 2, affectedRows: 2 }, '标记必须返回实际影响量');

  let transactionEvents = [];
  const transactionMark = await state.markDailySongsPublished({
    async getConnection() {
      return {
        async beginTransaction() { transactionEvents.push('begin'); },
        async execute(sql) {
          transactionEvents.push(sql.startsWith('SELECT') ? 'select' : 'update');
          return sql.startsWith('SELECT')
            ? [[{ id: 7 }, { id: 9 }]]
            : [{ affectedRows: 1 }];
        },
        async commit() { transactionEvents.push('commit'); },
        async rollback() { transactionEvents.push('rollback'); },
        release() { transactionEvents.push('release'); }
      };
    }
  }, [7, 9]);
  assert.deepStrictEqual(transactionMark, { requested: 2, affected: 2, changed: 1, affectedRows: 1 }, '事务标记应区分逻辑影响量和实际字段变更量');
  assert.deepStrictEqual(transactionEvents, ['begin', 'select', 'update', 'commit', 'release']);

  let conflictEvents = [];
  await assert.rejects(
    state.markDailySongsPublished({
      async getConnection() {
        return {
          async beginTransaction() { conflictEvents.push('begin'); },
          async execute() { conflictEvents.push('select'); return [[{ id: 7 }]]; },
          async rollback() { conflictEvents.push('rollback'); },
          release() { conflictEvents.push('release'); }
        };
      }
    }, [7, 9]),
    function(error) {
      return error && error.code === 'DAILY_SONG_MARK_CONFLICT' && error.affected === 1 && error.requested === 2;
    },
    '被移出候选的歌曲必须被识别为并发冲突'
  );
  assert.deepStrictEqual(conflictEvents, ['begin', 'select', 'rollback', 'release']);

  console.log('[daily-song-state] 通过：候选窗口、参数边界、草稿已创建终态、事务标记及并发冲突均符合预期');
})().catch(function(err) {
  console.error(err);
  process.exitCode = 1;
});
