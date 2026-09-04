'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const configuredUploadDir = process.env.UPLOAD_DIR || process.env.UPLOAD_PATH;
const UPLOAD_BASE = configuredUploadDir
  ? (path.isAbsolute(configuredUploadDir)
    ? path.resolve(configuredUploadDir)
    : path.resolve(__dirname, '..', configuredUploadDir))
  : path.resolve(__dirname, '../public/uploads');
const LEGACY_UPLOAD_BASE = path.resolve(__dirname, '../../uploads');
const AVATAR_DIR = path.join(UPLOAD_BASE, 'avatars');
const VIDEO_DIR = path.join(UPLOAD_BASE, 'videos');
const LEGACY_AVATAR_DIR = path.join(LEGACY_UPLOAD_BASE, 'avatars');
const DEFAULT_AVATAR = '/uploads/avatars/default.png';
const AVATAR_FILE = /^avatar_[^/\\]+\.(jpg|jpeg|png|gif|webp)$/i;
const MANAGED_IMAGE_DIRS = [AVATAR_DIR, path.join(UPLOAD_BASE, 'posts'), VIDEO_DIR];
const POST_FILE = /^post_[^/\\]+\.(jpg|jpeg|png|gif|webp)$/i;
const POST_VIDEO_FILE = /^video_[^/\\]+\.(mp4|webm|ogv)$/i;

function isPathInsideDirectory(filePath, directory) {
  const relative = path.relative(path.resolve(directory), path.resolve(filePath));
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function resolveManagedImagePath(filePath) {
  if (typeof filePath !== 'string' || !filePath) return null;
  let resolved;
  try {
    resolved = path.resolve(filePath);
  } catch (err) {
    return null;
  }
  if (!path.basename(resolved) || path.basename(resolved) === '.' || path.basename(resolved) === '..') return null;
  const parentDir = MANAGED_IMAGE_DIRS.find(function(dir) {
    return path.dirname(resolved) === path.resolve(dir) && isPathInsideDirectory(resolved, dir);
  });
  if (!parentDir) return null;
  const filename = path.basename(resolved);
  if (path.resolve(parentDir) === path.resolve(AVATAR_DIR) && (filename === 'default.png' || !AVATAR_FILE.test(filename))) return null;
  if (path.resolve(parentDir) === path.resolve(path.join(UPLOAD_BASE, 'posts')) && !POST_FILE.test(filename)) return null;
  if (path.resolve(parentDir) === path.resolve(VIDEO_DIR) && !POST_VIDEO_FILE.test(filename)) return null;
  return resolved;
}

function ensureUploadDirs() {
  [path.join(UPLOAD_BASE, 'posts'), AVATAR_DIR, VIDEO_DIR].forEach(function(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });
}

function resolveStoredAvatarPaths(avatar) {
  if (!avatar || avatar === DEFAULT_AVATAR) return [];
  const pathname = String(avatar).split('?')[0];
  const prefix = '/uploads/avatars/';
  if (!pathname.startsWith(prefix)) return [];
  const filename = pathname.slice(prefix.length);
  if (!AVATAR_FILE.test(filename) || filename !== path.basename(filename)) return [];
  return [path.join(AVATAR_DIR, filename), path.join(LEGACY_AVATAR_DIR, filename)];
}

function removeStoredFile(filePath, reason) {
  const safePath = resolveManagedImagePath(filePath);
  if (!safePath) return false;
  try {
    const stat = fs.lstatSync(safePath);
    if (stat.isFile() || stat.isSymbolicLink()) {
      fs.unlinkSync(safePath);
      return true;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`删除文件失败（${reason}）:`, err.message);
  }
  return false;
}

function detectImageMime(buffer) {
  if (!buffer || buffer.length < 4) return null;
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.subarray(0, 4).toString('ascii') === 'GIF8') return 'image/gif';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

async function validateImageFile(filePath, options) {
  const safePath = resolveManagedImagePath(filePath);
  if (!safePath) return false;
  const maxBytes = options && Number.isFinite(options.maxBytes) ? options.maxBytes : Infinity;
  let handle;
  try {
    const lstat = await fs.promises.lstat(safePath);
    if (!lstat.isFile()) return false;
    const realPath = await fs.promises.realpath(safePath);
    if (!MANAGED_IMAGE_DIRS.some(function(dir) { return isPathInsideDirectory(realPath, dir); })) return false;
    const stat = lstat;
    if (!stat.isFile() || stat.size < 4 || stat.size > maxBytes) return false;
    handle = await fs.promises.open(safePath, 'r');
    const buffer = Buffer.alloc(12);
    const result = await handle.read(buffer, 0, buffer.length, 0);
    return Boolean(detectImageMime(buffer.subarray(0, result.bytesRead)));
  } catch (err) {
    return false;
  } finally {
    if (handle) await handle.close().catch(function() {});
  }
}

function hashFile(filePath) {
  return new Promise(function(resolve, reject) {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', function(chunk) { hash.update(chunk); });
    stream.on('error', reject);
    stream.on('end', function() { resolve(hash.digest('hex')); });
  });
}

async function findExistingAvatar(filePath) {
  const safeFilePath = resolveManagedImagePath(filePath);
  if (!safeFilePath || !isPathInsideDirectory(safeFilePath, AVATAR_DIR)) return null;
  try {
    const currentStat = await fs.promises.stat(safeFilePath);
    if (!currentStat.isFile()) return null;
    const currentHash = await hashFile(safeFilePath);
    const entries = await fs.promises.readdir(AVATAR_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !AVATAR_FILE.test(entry.name)) continue;
      const candidatePath = path.join(AVATAR_DIR, entry.name);
      if (path.resolve(candidatePath) === path.resolve(safeFilePath)) continue;
      let candidateStat;
      try {
        candidateStat = await fs.promises.stat(candidatePath);
      } catch (err) {
        if (err.code === 'ENOENT') continue;
        throw err;
      }
      if (!candidateStat.isFile()) continue;
      if (candidateStat.size !== currentStat.size) continue;
      if (await hashFile(candidatePath) === currentHash) return entry.name;
    }
  } catch (err) {
    console.warn('[avatar] 查找重复头像失败:', err.message);
  }
  return null;
}

module.exports = {
  AVATAR_DIR,
  VIDEO_DIR,
  DEFAULT_AVATAR,
  UPLOAD_BASE,
  ensureUploadDirs,
  findExistingAvatar,
  removeStoredFile,
  resolveStoredAvatarPaths,
  resolveManagedImagePath,
  validateImageFile
};
