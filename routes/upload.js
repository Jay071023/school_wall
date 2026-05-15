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
    const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
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
    const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  }
});

// 上传帖子图片
router.post('/post-images', auth, postUpload.array('images', 9), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.json({ code: 400, message: '请选择图片' });
    }
    const paths = req.files.map(f => `/uploads/posts/${f.filename}`);
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
    const avatarPath = `/uploads/avatars/${req.file.filename}`;
    console.log(`头像上传: userId=${req.user?.id}, path=${avatarPath}, file=${req.file.path}`);
    await pool.execute('UPDATE users SET avatar = ? WHERE id = ?', [avatarPath, req.user.id]);
    console.log(`✅ 头像更新成功: userId=${req.user?.id}`);
    res.json({ code: 200, message: '上传成功', data: { avatar: avatarPath } });
  } catch (err) {
    console.error('头像上传失败:', err);
    res.json({ code: 500, message: '上传失败: ' + err.message });
  }
});

module.exports = router;
