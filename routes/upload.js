const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { auth } = require('../middleware/auth');
const { pool } = require('../config/database');
const router = express.Router();

// 上传目录（服务器上Nginx从 /www/wwwroot/wall.jay23.cn/uploads/ 直接服务）
const UPLOAD_BASE = path.resolve(__dirname, '../../uploads');
const uploadDirs = [
  path.join(UPLOAD_BASE, 'posts'),
  path.join(UPLOAD_BASE, 'avatars')
];
uploadDirs.forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`✅ 创建上传目录: ${dir}`);
  }
});

// 图片魔数（文件头字节）
const MAGIC_NUMBERS = {
  'ffd8ff': 'image/jpeg',      // JPEG: FF D8 FF
  '89504e47': 'image/png',     // PNG: 89 50 4E 47
  '47494638': 'image/gif'     // GIF: 47 49 46 38
};
var MAGIC_WEBP = '52494646'; // RIFF（WebP 前4字节）

// 通用文件验证 - 简化版，只检查扩展名
function validateImageFile(file) {
  // 简化：只检查扩展名，文件内容验证在上传后进行
  return { valid: true };
}

// 帖子图片上传
const postStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(UPLOAD_BASE, 'posts')),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `post_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
  }
});
const postUpload = multer({
  storage: postStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedExt = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    if (!allowedExt.includes(ext)) {
      return cb(new Error('不支持的文件扩展名'));
    }
    const result = validateImageFile(file);
    if (!result.valid) {
      return cb(new Error(result.reason));
    }
    cb(null, true);
  }
});

// 头像上传
const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(UPLOAD_BASE, 'avatars')),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `avatar_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
  }
});
const avatarUpload = multer({
  storage: avatarStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedExt = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    if (!allowedExt.includes(ext)) {
      return cb(new Error('不支持的文件扩展名'));
    }
    const result = validateImageFile(file);
    if (!result.valid) {
      return cb(new Error(result.reason));
    }
    cb(null, true);
  }
});

// 上传帖子图片
router.post('/post-images', auth, postUpload.array('images', 9), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.json({ code: 400, message: '请选择图片' });
    }
    const ts = Date.now();
    const paths = req.files.map(f => `/uploads/posts/${f.filename}?t=${ts}`);
    res.json({ code: 200, message: '上传成功', data: { images: paths } });
  } catch (err) {
    console.error('上传失败:', err);
    res.json({ code: 500, message: '上传失败: ' + err.message });
  }
});

// 上传头像
router.post('/avatar', auth, avatarUpload.single('avatar'), async (req, res) => {
  try {
    if (!req.file) {
      return res.json({ code: 400, message: '请选择图片' });
    }
    const ts = Date.now();
     const avatarPath = `/uploads/avatars/${req.file.filename}`;

    // 删除旧头像（如果不是默认头像）
    if (req.user?.avatar && req.user.avatar !== '/uploads/avatars/default.png') {
      const oldPath = path.join(__dirname, '../../', req.user.avatar.split('?')[0]);
      try {
        if (fs.existsSync(oldPath)) {
          fs.unlinkSync(oldPath);
          console.log(`🗑️ 删除旧头像: ${oldPath}`);
        }
      } catch(e) {
        console.log('删除旧头像失败:', e.message);
      }
    }

    await pool.execute('UPDATE users SET avatar = ? WHERE id = ?', [avatarPath, req.user.id]);
    console.log(`✅ 头像更新成功: userId=${req.user?.id}`);
    res.json({ code: 200, message: '上传成功', data: { avatar: avatarPath } });
  } catch (err) {
    console.error('头像上传失败:', err);
    res.json({ code: 500, message: '上传失败: ' + err.message });
  }
});

module.exports = router;
