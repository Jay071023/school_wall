'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
require('dotenv').config({ path: path.join(ROOT, '.env.local'), override: true });

const { pool } = require('../config/database');
const configuredUploadDir = process.env.UPLOAD_DIR || process.env.UPLOAD_PATH;
const uploadBase = configuredUploadDir
  ? (path.isAbsolute(configuredUploadDir)
    ? path.resolve(configuredUploadDir)
    : path.resolve(ROOT, configuredUploadDir))
  : path.join(ROOT, 'public', 'uploads');
const avatarDirs = [
  path.join(uploadBase, 'avatars'),
  path.join(ROOT, '..', 'uploads', 'avatars')
].filter(function(dir, index, all) {
  return all.indexOf(dir) === index;
});

const AVATAR_PREFIX = '/uploads/avatars/';
const AVATAR_FILE = /^avatar_[^/\\]+\.(jpg|jpeg|png|gif|webp)$/i;

function avatarFilename(value) {
  if (!value) return null;
  const pathname = String(value).split('?')[0];
  if (!pathname.startsWith(AVATAR_PREFIX)) return null;
  const filename = pathname.slice(AVATAR_PREFIX.length);
  if (!AVATAR_FILE.test(filename) || path.posix.basename(filename) !== filename) return null;
  return filename;
}

function parseDays(argv) {
  const value = argv.find(function(arg) { return arg.startsWith('--days='); });
  const days = value ? Number(value.slice('--days='.length)) : 7;
  return Number.isFinite(days) && days >= 0 ? days : 7;
}

async function readAvatarFiles(dir) {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile() || !AVATAR_FILE.test(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      const stat = await fs.promises.stat(fullPath);
      files.push({ path: fullPath, name: entry.name, size: stat.size, mtimeMs: stat.mtimeMs });
    }
    return files;
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function main() {
  const deleteMode = process.argv.includes('--delete');
  const minAgeDays = parseDays(process.argv);
  const cutoff = Date.now() - minAgeDays * 24 * 60 * 60 * 1000;

  try {
    const [users] = await pool.execute('SELECT avatar FROM users WHERE avatar IS NOT NULL');
    const referenced = new Set(users.map(function(user) { return avatarFilename(user.avatar); }).filter(Boolean));
    const allFiles = [];
    for (const dir of avatarDirs) {
      const files = await readAvatarFiles(dir);
      allFiles.push.apply(allFiles, files);
    }

    const orphaned = allFiles.filter(function(file) {
      return !referenced.has(file.name) && file.mtimeMs <= cutoff;
    });
    const bytes = orphaned.reduce(function(total, file) { return total + file.size; }, 0);
    console.log('[avatar-cleanup] mode=' + (deleteMode ? 'delete' : 'dry-run') +
      ' referenced=' + referenced.size + ' scanned=' + allFiles.length +
      ' candidates=' + orphaned.length + ' bytes=' + bytes + ' ageDays=' + minAgeDays);

    if (!deleteMode) {
      console.log('[avatar-cleanup] dry-run only; add --delete after reviewing the candidate count');
      return;
    }

    for (const file of orphaned) {
      await fs.promises.unlink(file.path);
      console.log('[avatar-cleanup] deleted ' + file.path);
    }
  } finally {
    await pool.end();
  }
}

main().catch(function(err) {
  console.error('[avatar-cleanup] failed:', err.message);
  process.exitCode = 1;
});
