const fs = require('fs');
const path = require('path');

const RELEASE_NOTES_FILE = path.join(__dirname, '..', 'config', 'release-notes.json');
// 更新记录只保留最近 6 条，避免设置页变成长篇档案；详细变更仍在 Git 提交与发布日志中留存。
const MAX_RELEASE_NOTES = 6;

function isCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function normalizeReleaseNote(value) {
  if (!value || typeof value !== 'object') return null;

  const id = typeof value.id === 'string' ? value.id.trim().slice(0, 100) : '';
  const publishedAt = typeof value.published_at === 'string' ? value.published_at.trim() : '';
  const title = typeof value.title === 'string' ? value.title.trim().slice(0, 120) : '';
  const summary = typeof value.summary === 'string' ? value.summary.trim().slice(0, 220) : '';
  const changes = Array.isArray(value.changes)
    ? value.changes
      .filter(change => typeof change === 'string')
      .map(change => change.trim().slice(0, 240))
      .filter(Boolean)
      .slice(0, 6)
    : [];

  if (!id || !isCalendarDate(publishedAt) || !title || !summary || changes.length === 0) {
    return null;
  }

  return { id, published_at: publishedAt, title, summary, changes };
}

async function getReleaseNotes() {
  const raw = await fs.promises.readFile(RELEASE_NOTES_FILE, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('release notes must be an array');
  return parsed.map(normalizeReleaseNote).filter(Boolean).slice(0, MAX_RELEASE_NOTES);
}

module.exports = { getReleaseNotes, normalizeReleaseNote, RELEASE_NOTES_FILE, MAX_RELEASE_NOTES };
