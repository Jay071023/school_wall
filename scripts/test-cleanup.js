'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-wall-cleanup-'));
process.env.UPLOAD_DIR = uploadDir;

let lockAcquired = true;
let connectionCount = 0;
let releaseCount = 0;
let releasedConnections = 0;
const imageOldTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
const videoOldTime = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
const mediaRows = [
  {
    id: 10,
    status: 'pending',
    is_deleted: 0,
    images: JSON.stringify(['/uploads/posts/post_pending.png', '/uploads/posts/post_recent_pending.png']),
    video_url: '/uploads/videos/video_pending.mp4',
    video_poster: '/uploads/posts/post_pending_poster.png',
    created_at: imageOldTime,
    updated_at: imageOldTime
  },
  {
    id: 11,
    status: 'approved',
    is_deleted: 0,
    images: JSON.stringify(['/uploads/posts/post_referenced.png']),
    video_url: '/uploads/videos/video_approved.mp4',
    video_poster: null,
    created_at: videoOldTime,
    updated_at: videoOldTime
  }
];
const databasePath = require.resolve('../config/database');
const fakeConnection = function() {
  return {
    async execute(sql, params) {
      if (sql.includes('GET_LOCK')) {
        await new Promise(function(resolve) { setTimeout(resolve, 15); });
        return [[{ acquired: lockAcquired ? 1 : 0 }]];
      }
      if (sql.includes('RELEASE_LOCK')) {
        releaseCount += 1;
        return [[{ released: 1 }]];
      }
      if (sql.includes('SELECT id, status, is_deleted, images, video_url, video_poster')) {
        return [mediaRows];
      }
      if (sql.includes('SELECT images, video_poster FROM posts')) {
        return [mediaRows];
      }
      if (sql.includes('SELECT video_url FROM posts')) {
        return [mediaRows];
      }
      if (sql.includes('UPDATE posts SET images')) {
        const row = mediaRows.find(function(item) { return item.id === params[3]; });
        if (row) {
          row.images = params[0];
          row.video_url = params[1];
          row.video_poster = params[2];
        }
        return [{ affectedRows: row ? 1 : 0 }];
      }
      if (sql.includes('FROM posts WHERE images')) {
        return [[{ images: JSON.stringify(['/uploads/posts/post_referenced.png']) }]];
      }
      if (sql.includes('FROM wechat_submit_sessions')) {
        const err = new Error('optional table absent in test');
        err.code = 'ER_NO_SUCH_TABLE';
        throw err;
      }
      return [{ affectedRows: 0 }];
    },
    release() { releasedConnections += 1; }
  };
};
const fakePool = {
  async getConnection() {
    connectionCount += 1;
    return fakeConnection();
  },
  async execute(sql, params) {
    const connection = fakeConnection();
    return connection.execute(sql, params);
  }
};
require.cache[databasePath] = {
  id: databasePath,
  filename: databasePath,
  loaded: true,
  exports: { pool: fakePool }
};

const cleanup = require('../services/cleanup');
const postDir = path.join(uploadDir, 'posts');
fs.mkdirSync(postDir, { recursive: true });
const oldTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
const recentTime = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
const oldOrphan = path.join(postDir, 'post_orphan.png');
const referenced = path.join(postDir, 'post_referenced.png');
const recentOrphan = path.join(postDir, 'post_recent.png');
const unrelated = path.join(postDir, 'avatar_like.png');
const pendingImage = path.join(postDir, 'post_pending.png');
const pendingRecentImage = path.join(postDir, 'post_recent_pending.png');
const pendingPoster = path.join(postDir, 'post_pending_poster.png');
const approvedVideo = path.join(uploadDir, 'videos', 'video_approved.mp4');
const pendingVideo = path.join(uploadDir, 'videos', 'video_pending.mp4');
fs.mkdirSync(path.dirname(approvedVideo), { recursive: true });
for (const file of [oldOrphan, referenced, recentOrphan, unrelated, pendingImage, pendingRecentImage, pendingPoster, approvedVideo, pendingVideo]) fs.writeFileSync(file, 'test');
fs.utimesSync(oldOrphan, oldTime, oldTime);
fs.utimesSync(referenced, oldTime, oldTime);
fs.utimesSync(recentOrphan, recentTime, recentTime);
fs.utimesSync(unrelated, oldTime, oldTime);
fs.utimesSync(pendingImage, imageOldTime, imageOldTime);
fs.utimesSync(pendingPoster, imageOldTime, imageOldTime);
fs.utimesSync(pendingRecentImage, recentTime, recentTime);
fs.utimesSync(approvedVideo, videoOldTime, videoOldTime);
fs.utimesSync(pendingVideo, videoOldTime, videoOldTime);

async function main() {
  await cleanup.cleanupOrphanPostImages();
  assert.strictEqual(fs.existsSync(oldOrphan), false, '只删除明确命名的过期孤儿帖子图片');
  assert.strictEqual(fs.existsSync(referenced), true, '已被帖子引用的图片不能删除');
  assert.strictEqual(fs.existsSync(recentOrphan), true, '安全缓冲期内的新上传文件不能删除');
  assert.strictEqual(fs.existsSync(unrelated), true, '非帖子图片文件不能删除');

  const first = cleanup.cleanupExpiredData();
  const second = cleanup.cleanupExpiredData();
  assert.strictEqual(first, second, '同一实例的重入调用应复用正在执行的 promise');
  const result = await first;
  assert.strictEqual(result.skipped, false);
  assert.strictEqual(connectionCount, 2, '同一实例重入时只能获取一个数据库连接');
  assert.strictEqual(releaseCount, 2, '成功获取锁后必须释放命名锁');
  assert.strictEqual(releasedConnections, 2, '数据库连接必须释放');
  assert.strictEqual(fs.existsSync(pendingImage), false, '超过7天仍未发布的帖子图片必须清理');
  assert.strictEqual(fs.existsSync(pendingPoster), false, '超过7天仍未发布的视频封面必须清理');
  assert.strictEqual(fs.existsSync(pendingVideo), false, '超过30天仍未发布的帖子视频必须清理');
  assert.strictEqual(fs.existsSync(pendingRecentImage), true, '保留期内的未发布帖子图片不能清理');
  assert.strictEqual(fs.existsSync(referenced), true, '已发布帖子图片不能清理');
  assert.strictEqual(fs.existsSync(approvedVideo), true, '已发布帖子视频不能清理');

  lockAcquired = false;
  const skipped = await cleanup.cleanupExpiredData();
  assert.strictEqual(skipped.skipped, true, '其他实例持锁时本实例应跳过');
  assert.strictEqual(connectionCount, 3);
  assert.strictEqual(releasedConnections, 3);
  console.log('Cleanup service tests passed');
}

main().catch(function(err) {
  console.error(err);
  process.exitCode = 1;
}).finally(function() {
  fs.rmSync(uploadDir, { recursive: true, force: true });
});
