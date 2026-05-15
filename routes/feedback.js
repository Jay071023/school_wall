const express = require('express');
const { pool } = require('../config/database');
const { auth, optionalAuth } = require('../middleware/auth');
const router = express.Router();

// 获取反馈类型列表
router.get('/types', (req, res) => {
  res.json({
    code: 200,
    data: [
      { value: 'suggest', label: '💡 功能建议', desc: '对网站功能有好的想法' },
      { value: 'bug', label: '🐛 Bug反馈', desc: '发现网站有问题' },
      { value: 'complaint', label: '📢 投诉', desc: '对网站或用户有意见' },
      { value: 'other', label: '📝 其他', desc: '其他问题或反馈' }
    ]
  });
});

// 提交反馈（需要登录）
router.post('/', auth, async (req, res) => {
  try {
    // 自动创建表（如果不存在）
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS feedbacks (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        type VARCHAR(50) NOT NULL,
        title VARCHAR(200) NOT NULL,
        content TEXT NOT NULL,
        contact VARCHAR(200),
        status VARCHAR(50) DEFAULT 'pending',
        reply TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_user_id (user_id),
        INDEX idx_status (status)
      )
    `);

    const { type, title, content, contact } = req.body;
    
    if (!type || !title || !content) {
      return res.json({ code: 400, message: '请填写所有必填项' });
    }
    
    if (title.length > 200) {
      return res.json({ code: 400, message: '标题不能超过200字' });
    }
    
    if (content.length > 2000) {
      return res.json({ code: 400, message: '内容不能超过2000字' });
    }
    
    const validTypes = ['suggest', 'bug', 'complaint', 'other'];
    if (!validTypes.includes(type)) {
      return res.json({ code: 400, message: '无效的反馈类型' });
    }
    
    const [result] = await pool.execute(
      'INSERT INTO feedbacks (user_id, type, title, content, contact, status) VALUES (?, ?, ?, ?, ?, ?)',
      [req.user.id, type, title.trim(), content.trim(), contact || null, 'pending']
    );
    
    res.json({ code: 200, message: '反馈提交成功，我们会尽快处理！' });
  } catch (err) {
    console.error('提交反馈失败:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取我的反馈列表（需要登录）
router.get('/my', auth, async (req, res) => {
  try {
    const [feedbacks] = await pool.execute(
      'SELECT * FROM feedbacks WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
      [req.user.id]
    );
    
    res.json({ code: 200, data: feedbacks });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

module.exports = router;