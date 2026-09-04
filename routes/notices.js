const express = require('express');
const { pool } = require('../config/database');
const { getPagination } = require('../services/pagination');
const router = express.Router();

function sendError(res, code, message) {
  return res.json({ code, message });
}

router.get('/', async (req, res) => {
  const { limit, offset } = getPagination(req.query, {
    defaultLimit: 10,
    maxLimit: 50,
    maxPage: 10000
  });

  try {
    const [notices] = await pool.execute(
      'SELECT * FROM notices ORDER BY is_top DESC, created_at DESC, id DESC LIMIT ? OFFSET ?',
      [limit, offset]
    );
    // 保持公开接口 data 为数组；page/limit 仅控制查询窗口，兼容现有客户端。
    res.json({ code: 200, data: notices });
  } catch (err) {
    console.error('获取公告失败:', err);
    sendError(res, 500, '服务器错误');
  }
});

module.exports = router;
