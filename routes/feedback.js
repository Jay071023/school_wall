const express = require('express');
const { pool, ensureFeedbackTable } = require('../config/database');
const { getPagination } = require('../services/pagination');
const { auth } = require('../middleware/auth');
const router = express.Router();

const VALID_TYPES = new Set(['suggest', 'bug', 'complaint', 'other']);
function sendError(res, code, message) {
  return res.json({ code, message });
}

function readRequiredString(value, maxLength, label) {
  if (typeof value !== 'string') {
    return { error: `请输入${label}` };
  }

  const valueText = value.trim();
  if (!valueText) {
    return { error: `请输入${label}` };
  }
  if (valueText.length > maxLength) {
    return { error: `${label}不能超过${maxLength}字` };
  }
  return { value: valueText };
}

function readOptionalString(value, maxLength, label) {
  if (value === undefined || value === null || value === '') {
    return { value: null };
  }
  if (typeof value !== 'string') {
    return { error: `${label}格式不正确` };
  }

  const valueText = value.trim();
  if (!valueText) {
    return { value: null };
  }
  if (valueText.length > maxLength) {
    return { error: `${label}不能超过${maxLength}字` };
  }
  return { value: valueText };
}

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
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const type = typeof body.type === 'string' ? body.type.trim() : body.type;
  const titleResult = readRequiredString(body.title, 200, '标题');
  const contentResult = readRequiredString(body.content, 2000, '内容');
  const contactResult = readOptionalString(body.contact, 200, '联系方式');

  if (!VALID_TYPES.has(type)) {
    return sendError(res, 400, '无效的反馈类型');
  }
  if (titleResult.error) {
    return sendError(res, 400, titleResult.error);
  }
  if (contentResult.error) {
    return sendError(res, 400, contentResult.error);
  }
  if (contactResult.error) {
    return sendError(res, 400, contactResult.error);
  }

  try {
    await ensureFeedbackTable(pool);
    await pool.execute(
      'INSERT INTO feedbacks (user_id, type, title, content, contact, status) VALUES (?, ?, ?, ?, ?, ?)',
      [req.user.id, type, titleResult.value, contentResult.value, contactResult.value, 'pending']
    );
    
    res.json({ code: 200, message: '反馈提交成功，我们会尽快处理！' });
  } catch (err) {
    console.error('提交反馈失败:', err);
    sendError(res, 500, '服务器错误');
  }
});

// 获取我的反馈列表（需要登录）
router.get('/my', auth, async (req, res) => {
  const { limit, offset } = getPagination(req.query, {
    defaultLimit: 50,
    maxLimit: 100,
    maxPage: 10000
  });

  try {
    await ensureFeedbackTable(pool);
    const [feedbacks] = await pool.execute(
      'SELECT * FROM feedbacks WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?',
      [req.user.id, limit, offset]
    );

    res.json({ code: 200, data: feedbacks });
  } catch (err) {
    console.error('获取我的反馈失败:', err);
    sendError(res, 500, '服务器错误');
  }
});

module.exports = router;
