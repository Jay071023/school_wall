const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const avatarFileStorage = require('../services/avatar-storage');
const { auth } = require('../middleware/auth');
const { pool } = require('../config/database');
const router = express.Router();

const { AVATAR_DIR, UPLOAD_BASE } = avatarFileStorage;
avatarFileStorage.ensureUploadDirs();
const POST_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const POST_VIDEO_MAX_BYTES = 50 * 1024 * 1024;
const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp']
]);
const VIDEO_TYPES = new Map([
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.ogv', 'video/ogg']
]);

function getSafeImageExtension(file) {
  if (!file || typeof file.originalname !== 'string') return null;
  if (file.originalname.length > 255 || /[\u0000-\u001f\u007f]/.test(file.originalname)) return null;
  if (/[\\/]/.test(file.originalname)) return null;
  const extension = path.extname(file.originalname).toLowerCase();
  return IMAGE_TYPES.has(extension) ? extension : null;
}

function imageFileFilter(req, file, cb) {
  const extension = getSafeImageExtension(file);
  const mimeType = typeof file.mimetype === 'string' ? file.mimetype.toLowerCase() : '';
  const expectedMimeType = extension && IMAGE_TYPES.get(extension);
  // MIME 只作早期筛选，最终仍由文件头校验；兼容部分客户端发送 octet-stream/空 MIME。
  if (!extension || (mimeType && mimeType !== 'application/octet-stream' && mimeType !== expectedMimeType)) {
    return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
  }
  cb(null, true);
}

function getSafeVideoExtension(file) {
  if (!file || typeof file.originalname !== 'string') return null;
  if (file.originalname.length > 255 || /[\u0000-\u001f\u007f]/.test(file.originalname)) return null;
  if (/[\\/]/.test(file.originalname)) return null;
  const extension = path.extname(file.originalname).toLowerCase();
  return VIDEO_TYPES.has(extension) ? extension : null;
}

function videoFileFilter(req, file, cb) {
  const extension = getSafeVideoExtension(file);
  const mimeType = typeof file.mimetype === 'string' ? file.mimetype.toLowerCase() : '';
  const expectedMimeType = extension && VIDEO_TYPES.get(extension);
  if (!extension || (mimeType && mimeType !== 'application/octet-stream' && mimeType !== expectedMimeType)) {
    return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
  }
  cb(null, true);
}

function createImageStorage(directory, prefix) {
  return multer.diskStorage({
    destination: (req, file, cb) => cb(null, directory),
    filename: (req, file, cb) => {
      const extension = getSafeImageExtension(file);
      if (!extension) return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
      cb(null, `${prefix}_${Date.now()}_${crypto.randomBytes(12).toString('hex')}${extension}`);
    }
  });
}

function createPostVideoStorage() {
  return multer.diskStorage({
    destination: (req, file, cb) => cb(null, file.fieldname === 'poster' ? path.join(UPLOAD_BASE, 'posts') : path.join(UPLOAD_BASE, 'videos')),
    filename: (req, file, cb) => {
      const extension = file.fieldname === 'poster' ? getSafeImageExtension(file) : getSafeVideoExtension(file);
      if (!extension) return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
      const prefix = file.fieldname === 'poster' ? 'post' : 'video';
      cb(null, `${prefix}_${Date.now()}_${crypto.randomBytes(12).toString('hex')}${extension}`);
    }
  });
}

function postVideoFileFilter(req, file, cb) {
  if (file.fieldname === 'poster') return imageFileFilter(req, file, cb);
  if (file.fieldname === 'video') return videoFileFilter(req, file, cb);
  return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
}

// 仅解析本站头像路径，避免把数据库中的普通 URL 或异常路径当成本地文件删除
function resolveStoredAvatarPaths(avatar) {
  return avatarFileStorage.resolveStoredAvatarPaths(avatar);
}

function removeAvatarFile(filePath, reason) {
  return avatarFileStorage.removeStoredFile(filePath, reason);
}

// 帖子图片上传
const postStorage = createImageStorage(path.join(UPLOAD_BASE, 'posts'), 'post');
const postUpload = multer({
  storage: postStorage,
  limits: { fileSize: POST_IMAGE_MAX_BYTES, files: 9, fields: 10, fieldNameSize: 100, fieldSize: 1024 * 1024, parts: 20 },
  fileFilter: imageFileFilter
});
const videoUpload = multer({
  storage: createPostVideoStorage(),
  limits: { fileSize: POST_VIDEO_MAX_BYTES, files: 2, fields: 4, fieldNameSize: 100, fieldSize: 1024 * 1024, parts: 6 },
  fileFilter: postVideoFileFilter
});

// 头像上传
const avatarDiskStorage = createImageStorage(AVATAR_DIR, 'avatar');
const avatarUpload = multer({
  storage: avatarDiskStorage,
  limits: { fileSize: AVATAR_MAX_BYTES, files: 1, fields: 4, fieldNameSize: 100, fieldSize: 1024 * 1024, parts: 5 },
  fileFilter: imageFileFilter
});

function removeUploadedFiles(files) {
  const list = Array.isArray(files)
    ? files
    : Object.keys(files || {}).reduce(function(all, key) { return all.concat(files[key] || []); }, []);
  list.forEach(function(file) {
    if (file && file.path) avatarFileStorage.removeStoredFile(file.path, '回收上传临时文件');
  });
}

function sendUploadMiddlewareError(res, err, mediaType) {
  if (err) console.error('[上传校验失败]', err.code || err.message || 'unknown error');
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.json({ code: 400, message: '文件超过限制大小' });
  }
  return res.json({ code: 400, message: mediaType === 'video' ? '视频格式或上传参数不正确' : '图片格式或上传参数不正确' });
}

async function validateVideoFile(filePath, maxBytes) {
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) return false;
    const handle = await fs.promises.open(filePath, 'r');
    try {
      const header = Buffer.alloc(16);
      const result = await handle.read(header, 0, header.length, 0);
      if (result.bytesRead < 8) return false;
      const ascii = header.toString('ascii');
      return ascii.slice(4, 8) === 'ftyp' || header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) || ascii.slice(0, 4) === 'OggS';
    } finally {
      await handle.close();
    }
  } catch (err) {
    return false;
  }
}

// 上传帖子图片
async function handlePostImagesUpload(req, res) {
  try {
    if (!req.files || req.files.length === 0) {
      return res.json({ code: 400, message: '请选择图片' });
    }
    for (const file of req.files) {
      if (!await avatarFileStorage.validateImageFile(file.path, { maxBytes: POST_IMAGE_MAX_BYTES })) {
        removeUploadedFiles(req.files);
        return res.json({ code: 400, message: '图片内容无效，请重新选择图片' });
      }
    }
    const ts = Date.now();
    const paths = req.files.map(f => `/uploads/posts/${f.filename}?t=${ts}`);
    res.json({ code: 200, message: '上传成功', data: { images: paths } });
  } catch (err) {
    console.error('上传失败:', err.message);
    res.json({ code: 500, message: '上传失败，请稍后重试' });
  }
}

function handlePostImagesUploadRequest(req, res) {
  postUpload.array('images', 9)(req, res, function(err) {
    if (err) {
      removeUploadedFiles(req.files);
      return sendUploadMiddlewareError(res, err);
    }
    return handlePostImagesUpload(req, res);
  });
}

router.post('/post-images', auth, handlePostImagesUploadRequest);

async function handlePostVideoUpload(req, res) {
  try {
    const videoFile = req.files && req.files.video && req.files.video[0];
    const posterFile = req.files && req.files.poster && req.files.poster[0];
    if (!videoFile) return res.json({ code: 400, message: '请选择视频' });
    if (!await validateVideoFile(videoFile.path, POST_VIDEO_MAX_BYTES)) {
      removeUploadedFiles([videoFile, posterFile]);
      return res.json({ code: 400, message: '视频内容无效，请重新选择视频' });
    }
    if (posterFile && !await avatarFileStorage.validateImageFile(posterFile.path, { maxBytes: POST_IMAGE_MAX_BYTES })) {
      removeUploadedFiles([videoFile, posterFile]);
      return res.json({ code: 400, message: '视频封面无效，请重新选择视频' });
    }
    const video = `/uploads/videos/${videoFile.filename}`;
    const poster = posterFile ? `/uploads/posts/${posterFile.filename}` : null;
    return res.json({ code: 200, message: '视频上传成功', data: { video, poster } });
  } catch (err) {
    removeUploadedFiles([req.files && req.files.video && req.files.video[0], req.files && req.files.poster && req.files.poster[0]]);
    console.error('视频上传失败:', err.message);
    return res.json({ code: 500, message: '视频上传失败，请稍后重试' });
  }
}

function handlePostVideoUploadRequest(req, res) {
  videoUpload.fields([{ name: 'video', maxCount: 1 }, { name: 'poster', maxCount: 1 }])(req, res, function(err) {
    if (err) {
      removeUploadedFiles(req.files);
      return sendUploadMiddlewareError(res, err, 'video');
    }
    return handlePostVideoUpload(req, res);
  });
}

router.post('/post-video', auth, handlePostVideoUploadRequest);

// 上传头像：/api/upload/avatar 与 /api/auth/avatar 共用同一套处理逻辑。
async function handleAvatarUpload(req, res) {
  try {
    if (!req.file) {
      return res.json({ code: 400, message: '请选择图片' });
    }
    if (!await avatarFileStorage.validateImageFile(req.file.path, { maxBytes: AVATAR_MAX_BYTES })) {
      avatarFileStorage.removeStoredFile(req.file.path, '回收无效头像');
      return res.json({ code: 400, message: '图片内容无效，请重新选择图片' });
    }

    let existingFilename = await avatarFileStorage.findExistingAvatar(req.file.path);
    let selectedFilename = existingFilename || req.file.filename;
    let selectedFilePath = path.join(AVATAR_DIR, selectedFilename);
    // 去重扫描与后续更新之间文件可能被清理，丢失时回退到本次上传文件。
    try {
      const selectedStat = await fs.promises.stat(selectedFilePath);
      if (!selectedStat.isFile()) throw new Error('头像不是普通文件');
    } catch (err) {
      existingFilename = null;
      selectedFilename = req.file.filename;
      selectedFilePath = path.join(AVATAR_DIR, selectedFilename);
    }
    if (existingFilename) {
      avatarFileStorage.removeStoredFile(req.file.path, '回收重复头像');
    }
    const avatarPath = `/uploads/avatars/${selectedFilename}`;
    let oldAvatar;
    try {
      // 锁定用户行后读取旧头像，避免并发替换时用过期 req.user.avatar 删除文件。
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [users] = await connection.execute('SELECT avatar FROM users WHERE id = ? FOR UPDATE', [req.user.id]);
        if (users.length === 0) {
          await connection.rollback();
          if (!existingFilename) removeAvatarFile(req.file.path, '回收不存在用户的新头像');
          return res.json({ code: 404, message: '用户不存在' });
        }
        oldAvatar = users[0].avatar;
        await connection.execute('UPDATE users SET avatar = ? WHERE id = ?', [avatarPath, req.user.id]);
        await connection.commit();
      } catch (transactionError) {
        try { await connection.rollback(); } catch (rollbackError) {}
        throw transactionError;
      } finally {
        connection.release();
      }
    } catch (dbError) {
      // 数据库失败时回收 multer 已经落盘的新文件，避免产生孤儿文件。
      if (!existingFilename) removeAvatarFile(req.file.path, '回收数据库更新失败的新头像');
      throw dbError;
    }

    await removeUnreferencedAvatar(oldAvatar, selectedFilePath);

    res.json({ code: 200, message: '上传成功', data: { avatar: avatarPath } });
  } catch (err) {
    console.error('头像上传失败:', err.message);
    res.json({ code: 500, message: '上传失败，请稍后重试' });
  }
}

async function removeUnreferencedAvatar(avatar, protectedFilePath) {
  const oldAvatarPaths = resolveStoredAvatarPaths(avatar);
  if (!oldAvatarPaths.length) return;
  const pathname = String(avatar).split('?')[0];
  const filename = path.basename(pathname);
  const canonicalPath = `/uploads/avatars/${filename}`;
  try {
    const [references] = await pool.execute(
      "SELECT id FROM users WHERE SUBSTRING_INDEX(COALESCE(avatar, ''), '?', 1) = ? LIMIT 1",
      [canonicalPath]
    );
    if (references.length > 0) {
      return;
    }
  } catch (err) {
    // 引用状态无法确认时宁可保留文件，交给后续安全清理任务处理。
    console.warn('检查旧头像引用失败，暂不删除:', err.message);
    return;
  }
  oldAvatarPaths.forEach(function(oldAvatarPath) {
    if (path.resolve(oldAvatarPath) !== path.resolve(protectedFilePath)) {
      removeAvatarFile(oldAvatarPath, '删除未引用旧头像');
    }
  });
}

function handleAvatarUploadRequest(req, res) {
  avatarUpload.single('avatar')(req, res, function(err) {
    if (err) {
      removeUploadedFiles(req.file ? [req.file] : req.files);
      return sendUploadMiddlewareError(res, err);
    }
    return handleAvatarUpload(req, res);
  });
}

router.post('/avatar', auth, handleAvatarUploadRequest);

module.exports = router;
module.exports.avatarUpload = avatarUpload;
module.exports.handleAvatarUpload = handleAvatarUpload;
module.exports.handleAvatarUploadRequest = handleAvatarUploadRequest;
module.exports.getSafeImageExtension = getSafeImageExtension;
module.exports.imageFileFilter = imageFileFilter;
module.exports.getSafeVideoExtension = getSafeVideoExtension;
module.exports.videoFileFilter = videoFileFilter;
module.exports.validateVideoFile = validateVideoFile;
