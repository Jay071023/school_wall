'use strict';

const assert = require('assert');
const { getReleaseNotes, MAX_RELEASE_NOTES } = require('../services/release-notes');

(async () => {
  const notes = await getReleaseNotes();
  assert(Array.isArray(notes) && notes.length > 0, '应读取至少一条更新记录');
  assert(notes.length <= MAX_RELEASE_NOTES, '更新记录数量应受上限保护');
  notes.forEach((note) => {
    assert(/^\d{4}-\d{2}-\d{2}$/.test(note.published_at), '更新记录必须有有效日期');
    assert(note.title && note.summary, '更新记录必须有标题和摘要');
    assert(Array.isArray(note.changes) && note.changes.length > 0, '更新记录必须包含变更项');
  });
  console.log('[release-notes] 通过：后台更新记录可安全读取');
})().catch((err) => {
  console.error('[release-notes] 失败:', err.message);
  process.exitCode = 1;
});
