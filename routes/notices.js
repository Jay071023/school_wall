const express = require('express');
const { pool } = require('../config/database');
const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const [notices] = await pool.execute(
      'SELECT * FROM notices ORDER BY is_top DESC, created_at DESC LIMIT 10'
    );
    console.log('公告API返回:', notices);
    res.json({ code: 200, data: notices });
  } catch (err) {
    console.error('获取公告失败:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

module.exports = router;
