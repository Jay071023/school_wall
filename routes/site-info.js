const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');

// 获取网站公开信息
router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      "SELECT config_key, config_value FROM settings WHERE config_key IN ('school_name', 'site_title', 'site_description', 'site_logo', 'allow_register', 'site_notice')"
    );
    var data = {};
    rows.forEach(function(row) {
      data[row.config_key] = row.config_value;
    });
    res.json({ code: 200, data: data });
  } catch (err) {
    console.error('获取站点信息失败:', err);
    res.json({ code: 500, message: '获取站点信息失败' });
  }
});

module.exports = router;
