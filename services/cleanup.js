const fs = require('fs');
const path = require('path');
const { pool } = require('../config/database');
const { UPLOAD_BASE, resolveManagedImagePath } = require('./avatar-storage');

const LOG_RETENTION_DAYS = 30;
const TRASH_RETENTION_DAYS = 7;
const CLEANUP_HOUR = 3;
const POST_IMAGE_RETENTION_DAYS = 7;
const POST_VIDEO_RETENTION_DAYS = 30;
// 兼容旧调用方：图片是现有孤儿文件清理的默认类型。
const POST_UPLOAD_MIN_AGE_DAYS = POST_IMAGE_RETENTION_DAYS;
const POST_FILE = /^post_[^/\\]+\.(jpg|jpeg|png|gif|webp)$/i;
const POST_VIDEO_FILE = /^video_[^/\\]+\.(mp4|webm|ogv)$/i;
const CLEANUP_LOCK_NAME = String(process.env.CLEANUP_LOCK_NAME || 'campus_wall:cleanup:v1').slice(0, 64);
let cleanupInFlight = null;

async function withCleanupLock(task) {
  const connection = await pool.getConnection();
  let acquired = false;
  try {
    const [[lockResult]] = await connection.execute(
      'SELECT GET_LOCK(?, 0) AS acquired',
      [CLEANUP_LOCK_NAME]
    );
    acquired = Number(lockResult && lockResult.acquired) === 1;
    if (!acquired) {
      console.log('🧹 清理任务跳过：已有其他实例正在执行');
      return { skipped: true, reason: 'lock-not-acquired' };
    }
    return await task(connection);
  } finally {
    if (acquired) {
      try {
        await connection.execute('SELECT RELEASE_LOCK(?)', [CLEANUP_LOCK_NAME]);
      } catch (err) {
        // 连接断开时 MySQL 会自动释放命名锁，不阻断本轮清理结果。
        console.warn('🧹 释放清理锁失败:', err.message);
      }
    }
    connection.release();
  }
}

async function runCleanupOnce() {
  try {
    return await withCleanupLock(async function(connection) {
      const [[logsResult], [viewsResult], [pointsResult]] = await Promise.all([
        connection.execute(
        'DELETE FROM admin_logs WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
        [LOG_RETENTION_DAYS]
        ),
        connection.execute(
        'DELETE FROM post_views WHERE viewed_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
        [LOG_RETENTION_DAYS]
        ),
        connection.execute(
        'DELETE FROM points_log WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
        [LOG_RETENTION_DAYS]
        )
      ]);
      if (logsResult.affectedRows > 0) {
        console.log(`🧹 已清理 ${logsResult.affectedRows} 条过期操作日志`);
      }

      if (viewsResult.affectedRows > 0) {
        console.log(`🧹 已清理 ${viewsResult.affectedRows} 条过期浏览记录`);
      }

      if (pointsResult.affectedRows > 0) {
        console.log(`🧹 已清理 ${pointsResult.affectedRows} 条过期积分日志`);
      }

      // 只有明确的软删除标记和删除时间都满足时才永久删除业务记录。
      const [trashPostsResult, trashSongsResult] = await Promise.all([
        connection.execute(
          'DELETE FROM posts WHERE is_deleted = 1 AND deleted_at IS NOT NULL AND deleted_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
          [TRASH_RETENTION_DAYS]
        ),
        connection.execute(
          'DELETE FROM song_requests WHERE deleted_at IS NOT NULL AND deleted_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
          [TRASH_RETENTION_DAYS]
        )
      ]);
      const trashDeleted = trashPostsResult[0].affectedRows + trashSongsResult[0].affectedRows;
      if (trashDeleted > 0) {
        console.log(`🧹 已永久清理回收站内容 ${trashDeleted} 条（帖子 ${trashPostsResult[0].affectedRows}，点歌 ${trashSongsResult[0].affectedRows}）`);
      }

      const unpublishedMedia = await cleanupUnpublishedPostMedia(connection);
      await cleanupGeneratedTitles(connection);
      await removeOrphanPostImages(connection);
      const orphanVideos = await removeOrphanPostVideos(connection);
      return {
        skipped: false,
        logs: logsResult.affectedRows,
        views: viewsResult.affectedRows,
        points: pointsResult.affectedRows,
        trashPosts: trashPostsResult[0].affectedRows,
        trashSongs: trashSongsResult[0].affectedRows,
        unpublishedImages: unpublishedMedia.images,
        unpublishedVideos: unpublishedMedia.videos,
        orphanVideos: orphanVideos.files
      };
    });
  } catch (err) {
    console.error('清理数据失败:', err.message);
    return { skipped: false, failed: true };
  }
}

function cleanupExpiredData() {
  if (cleanupInFlight) return cleanupInFlight;
  cleanupInFlight = runCleanupOnce().finally(function() {
    cleanupInFlight = null;
  });
  return cleanupInFlight;
}

function addReferencedPostImages(referenced, rows) {
  for (const row of rows || []) {
    let images;
    try {
      images = Array.isArray(row.images) ? row.images : JSON.parse(row.images || '[]');
    } catch (_) {
      continue;
    }
    for (const image of images) {
      const raw = String(image || '').split('?')[0].replace(/\\/g, '/');
      const prefix = '/uploads/posts/';
      const filename = raw.startsWith(prefix) ? raw.slice(prefix.length) : '';
      if (filename && POST_FILE.test(filename) && path.posix.basename(filename) === filename) {
        referenced.add(filename);
      }
    }

    const poster = String(row.video_poster || '').split('?')[0].replace(/\\/g, '/');
    const posterPrefix = '/uploads/posts/';
    const posterFilename = poster.startsWith(posterPrefix) ? poster.slice(posterPrefix.length) : '';
    if (posterFilename && POST_FILE.test(posterFilename) && path.posix.basename(posterFilename) === posterFilename) {
      referenced.add(posterFilename);
    }
  }
}

function parseStoredImages(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function resolvePostMediaPath(mediaUrl) {
  const raw = String(mediaUrl || '').split('?')[0].replace(/\\/g, '/');
  let prefix;
  let directory;
  let pattern;
  let kind;
  if (raw.startsWith('/uploads/posts/')) {
    prefix = '/uploads/posts/';
    directory = path.join(UPLOAD_BASE, 'posts');
    pattern = POST_FILE;
    kind = 'image';
  } else if (raw.startsWith('/uploads/videos/')) {
    prefix = '/uploads/videos/';
    directory = path.join(UPLOAD_BASE, 'videos');
    pattern = POST_VIDEO_FILE;
    kind = 'video';
  } else {
    return null;
  }
  const filename = raw.slice(prefix.length);
  if (!filename || filename !== path.posix.basename(filename) || !pattern.test(filename)) return null;
  return { path: path.join(directory, filename), filename, kind, key: path.resolve(directory, filename) };
}

function getPostMediaRefs(row) {
  const refs = [];
  parseStoredImages(row && row.images).forEach(function(url, index) {
    const media = resolvePostMediaPath(url);
    if (media) refs.push({ column: 'images', index, url: String(url), media });
  });
  ['video_url', 'video_poster'].forEach(function(column) {
    const value = row && row[column];
    const media = resolvePostMediaPath(value);
    if (media) refs.push({ column, url: String(value), media });
  });
  return refs;
}

function isPublishedPost(row) {
  return row && String(row.status || '') === 'approved' && Number(row.is_deleted || 0) !== 1;
}

function getRowTimestamp(row) {
  const timestamp = row && (row.updated_at || row.created_at);
  const value = timestamp ? new Date(timestamp).getTime() : 0;
  return Number.isFinite(value) ? value : 0;
}

async function getMediaStat(mediaPath, statCache) {
  if (statCache.has(mediaPath)) return statCache.get(mediaPath);
  let stat = null;
  try {
    stat = await fs.promises.stat(mediaPath);
    if (!stat.isFile()) stat = null;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  statCache.set(mediaPath, stat);
  return stat;
}

async function isMediaExpired(ref, row, statCache) {
  const retentionDays = ref.media.kind === 'video' ? POST_VIDEO_RETENTION_DAYS : POST_IMAGE_RETENTION_DAYS;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const stat = await getMediaStat(ref.media.path, statCache);
  if (stat) return stat.mtimeMs <= cutoff;
  // 文件已经不在磁盘时，只清理已经超过保留期的旧帖子引用，避免短暂的文件系统异常导致误清空。
  return getRowTimestamp(row) > 0 && getRowTimestamp(row) <= cutoff;
}

async function removeExpiredMediaFile(ref, row, statCache) {
  if (!await isMediaExpired(ref, row, statCache)) return false;
  const safePath = resolveManagedImagePath(ref.media.path);
  if (!safePath) return false;
  const stat = await getMediaStat(safePath, statCache);
  if (!stat) return true;
  try {
    await fs.promises.unlink(safePath);
    statCache.set(safePath, null);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') {
      statCache.set(safePath, null);
      return true;
    }
    throw err;
  }
}

async function getActiveWechatSessionReferences(db) {
  const referenced = new Set();
  try {
    const [sessions] = await db.execute(
      'SELECT images, updated_at FROM wechat_submit_sessions WHERE images IS NOT NULL'
    );
    const cutoff = Date.now() - POST_IMAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const session of sessions || []) {
      const updatedAt = new Date(session.updated_at || 0).getTime();
      if (!Number.isFinite(updatedAt) || updatedAt < cutoff) continue;
      for (const image of parseStoredImages(session.images)) {
        const media = resolvePostMediaPath(image);
        if (media && media.kind === 'image') referenced.add(media.key);
      }
    }
  } catch (err) {
    if (err.code !== 'ER_NO_SUCH_TABLE') throw err;
  }
  return referenced;
}

async function cleanupUnpublishedPostMedia(db) {
  const [rows] = await db.execute(
    'SELECT id, status, is_deleted, images, video_url, video_poster, created_at, updated_at FROM posts WHERE images IS NOT NULL OR video_url IS NOT NULL OR video_poster IS NOT NULL'
  );
  const postRows = rows || [];
  const protectedKeys = new Set();
  const references = new Map();
  const statCache = new Map();

  for (const row of postRows) {
    const refs = getPostMediaRefs(row);
    if (isPublishedPost(row)) {
      refs.forEach(function(ref) { protectedKeys.add(ref.media.key); });
    } else {
      refs.forEach(function(ref) {
        if (!references.has(ref.media.key)) references.set(ref.media.key, []);
        references.get(ref.media.key).push({ row, ref });
      });
    }
  }
  (await getActiveWechatSessionReferences(db)).forEach(function(key) { protectedKeys.add(key); });

  let deletedImages = 0;
  let deletedVideos = 0;
  for (const row of postRows) {
    if (isPublishedPost(row)) continue;
    const refs = getPostMediaRefs(row);
    if (!refs.length) continue;
    const expiredRefs = [];
    for (const ref of refs) {
      if (!await isMediaExpired(ref, row, statCache)) continue;
      let siblingIsLive = false;
      for (const item of references.get(ref.media.key) || []) {
        if (item.row.id !== row.id && !await isMediaExpired(item.ref, item.row, statCache)) {
          siblingIsLive = true;
          break;
        }
      }
      if (!protectedKeys.has(ref.media.key) && !siblingIsLive) expiredRefs.push(ref);
    }
    if (!expiredRefs.length) continue;

    let nextImages = parseStoredImages(row.images);
    let nextVideoUrl = row.video_url;
    let nextVideoPoster = row.video_poster;
    let changed = false;
    for (const ref of expiredRefs) {
      if (!await removeExpiredMediaFile(ref, row, statCache)) continue;
      if (ref.column === 'images') {
        nextImages = nextImages.filter(function(image) { return String(image) !== ref.url; });
        deletedImages += 1;
      } else if (ref.column === 'video_url') {
        nextVideoUrl = null;
        deletedVideos += 1;
      } else if (ref.column === 'video_poster') {
        nextVideoPoster = null;
        deletedImages += 1;
      }
      changed = true;
    }
    if (changed) {
      await db.execute(
        'UPDATE posts SET images = ?, video_url = ?, video_poster = ? WHERE id = ? AND (status <> "approved" OR is_deleted = 1)',
        [nextImages.length ? JSON.stringify(nextImages) : null, nextVideoUrl || null, nextVideoPoster || null, row.id]
      );
    }
  }
  if (deletedImages || deletedVideos) {
    console.log(`🧹 已清理未发布帖子媒体：图片 ${deletedImages} 个，视频 ${deletedVideos} 个`);
  }
  return { images: deletedImages, videos: deletedVideos };
}

async function removeOrphanPostImages(db) {
  db = db || pool;
  const postDir = path.join(UPLOAD_BASE, 'posts');
  let files;
  try {
    files = await fs.promises.readdir(postDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }

  const referenced = new Set();
  const [posts] = await db.execute('SELECT images, video_poster FROM posts WHERE images IS NOT NULL OR video_poster IS NOT NULL');
  addReferencedPostImages(referenced, posts);
  try {
    const [sessions] = await db.execute('SELECT images, updated_at FROM wechat_submit_sessions WHERE images IS NOT NULL');
    const cutoff = Date.now() - POST_IMAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    addReferencedPostImages(referenced, (sessions || []).filter(function(session) {
      const updatedAt = new Date(session.updated_at || 0).getTime();
      return Number.isFinite(updatedAt) && updatedAt >= cutoff;
    }));
  } catch (err) {
    if (err.code !== 'ER_NO_SUCH_TABLE') throw err;
  }

  const cutoff = Date.now() - POST_IMAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let deletedCount = 0;
  let deletedBytes = 0;
  for (const entry of files) {
    if (!entry.isFile() || !POST_FILE.test(entry.name) || referenced.has(entry.name)) continue;
    const filePath = path.join(postDir, entry.name);
    let stat;
    try {
      stat = await fs.promises.stat(filePath);
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    if (stat.mtimeMs > cutoff) continue;
    try {
      await fs.promises.unlink(filePath);
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    deletedCount += 1;
    deletedBytes += stat.size;
  }
  if (deletedCount > 0) {
    console.log(`🧹 已清理 ${deletedCount} 个孤儿帖子图片文件（${deletedBytes} bytes）`);
  }
}

async function removeOrphanPostVideos(db) {
  db = db || pool;
  const videoDir = path.join(UPLOAD_BASE, 'videos');
  let files;
  try {
    files = await fs.promises.readdir(videoDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return { files: 0, bytes: 0 };
    throw err;
  }

  const referenced = new Set();
  const [posts] = await db.execute('SELECT video_url FROM posts WHERE video_url IS NOT NULL');
  for (const row of posts || []) {
    const media = resolvePostMediaPath(row.video_url);
    if (media) referenced.add(media.filename);
  }
  const cutoff = Date.now() - POST_VIDEO_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let deletedCount = 0;
  let deletedBytes = 0;
  for (const entry of files || []) {
    if (!entry.isFile() || !POST_VIDEO_FILE.test(entry.name) || referenced.has(entry.name)) continue;
    const filePath = path.join(videoDir, entry.name);
    let stat;
    try {
      stat = await fs.promises.stat(filePath);
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    if (stat.mtimeMs > cutoff) continue;
    try {
      await fs.promises.unlink(filePath);
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    deletedCount += 1;
    deletedBytes += stat.size;
  }
  if (deletedCount > 0) {
    console.log(`🧹 已清理 ${deletedCount} 个孤儿帖子视频文件（${deletedBytes} bytes）`);
  }
  return { files: deletedCount, bytes: deletedBytes };
}

// 对外暴露的单项清理也必须经过同一把锁，避免手工触发与定时任务并发。
async function cleanupOrphanPostImages() {
  return withCleanupLock(function(connection) {
    return removeOrphanPostImages(connection);
  });
}

async function cleanupGeneratedTitles(db) {
  db = db || pool;
  try {
    const [result] = await db.execute(
      `DELETE utr FROM user_title_relations utr
       JOIN user_titles ut ON utr.title_id = ut.id
       WHERE ut.icon IN ('🏆', '⭐', '🔥')
       AND utr.created_at < DATE_SUB(NOW(), INTERVAL 7 DAY)`
    );
    if (result.affectedRows > 0) {
      console.log(`🧹 已清理 ${result.affectedRows} 个过期称号`);
    }
  } catch (err) {
    // 旧库没有称号字段时不影响其他清理任务。
    if (err.code !== 'ER_BAD_FIELD_ERROR' && err.code !== 'ER_NO_SUCH_TABLE') {
      console.error('清理称号失败:', err.message);
    }
  }
}

function scheduleCleanup() {
  const runCleanup = function() {
    return cleanupExpiredData();
  };

  // 启动时立即执行一次，避免错过服务重启期间的清理窗口。
  runCleanup();

  const now = new Date();
  const nextRun = new Date(now);
  nextRun.setHours(CLEANUP_HOUR, 0, 0, 0);
  if (now >= nextRun) nextRun.setDate(nextRun.getDate() + 1);
  const delay = nextRun.getTime() - now.getTime();
  let interval = null;
  const timeout = setTimeout(() => {
    runCleanup();
    interval = setInterval(runCleanup, 24 * 60 * 60 * 1000);
  }, delay);

  console.log(`⏰ 数据自动清理已启动（日志${LOG_RETENTION_DAYS}天，回收站${TRASH_RETENTION_DAYS}天，每日凌晨${CLEANUP_HOUR}点执行）`);
  return function stopCleanup() {
    clearTimeout(timeout);
    if (interval) clearInterval(interval);
  };
}

module.exports = {
  cleanupExpiredData,
  scheduleCleanup,
  LOG_RETENTION_DAYS,
  TRASH_RETENTION_DAYS,
  cleanupOrphanPostImages,
  cleanupUnpublishedPostMedia,
  removeOrphanPostVideos,
  CLEANUP_LOCK_NAME,
  POST_UPLOAD_MIN_AGE_DAYS,
  POST_IMAGE_RETENTION_DAYS,
  POST_VIDEO_RETENTION_DAYS,
  resolvePostMediaPath
};
