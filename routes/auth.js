const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { pool } = require('../config/database');
const { sendRegistrationCodeEmail } = require('../services/email');
const { auth, isStaffRole } = require('../middleware/auth');
const JWT_SECRET = require('../config/jwt-secret');
const { handleAvatarUploadRequest } = require('./upload');
const router = express.Router();

const MAX_PASSWORD_LENGTH = 128;
const MAX_CAPTCHA_LENGTH = 128;
const MAX_RATE_LIMIT_ENTRIES = 10000;

function getRequestBody(req) {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
}

function isSafeText(value, maxLength) {
  return typeof value === 'string' && value.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(value);
}

function validateRegistrationFields(body, requireEmail) {
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = body.password;
  const nickname = typeof body.nickname === 'string' ? body.nickname.trim() : '';
  const email = body.email == null ? '' : (typeof body.email === 'string' ? body.email.trim() : null);
  if (!username || typeof password !== 'string' || !nickname || (requireEmail && !email)) {
    return { error: '请填写完整信息' };
  }
  if (!isSafeText(username, 20) || username.length < 3) return { error: '用户名长度3-20个字符' };
  if (!isSafeText(nickname, 50)) return { error: '昵称长度不能超过50个字符' };
  if (password.length < 6 || password.length > MAX_PASSWORD_LENGTH) return { error: `密码长度应为6-${MAX_PASSWORD_LENGTH}个字符` };
  if (email === null || (email && (!isSafeText(email, 100) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))) {
    return { error: '邮箱格式不正确' };
  }
  return { username, password, nickname, email: email || null };
}

function getClientIdentity(req) {
  const forwarded = typeof req.headers['x-forwarded-for'] === 'string'
    ? req.headers['x-forwarded-for'].split(',')[0].trim()
    : '';
  const value = forwarded || req.ip || 'unknown';
  return String(value).replace(/^::ffff:/, '').slice(0, 64) || 'unknown';
}

function normalizeCaptchaValue(value) {
  return typeof value === 'string' && value.length <= MAX_CAPTCHA_LENGTH ? value.trim() : '';
}

function isBcryptHash(value) {
  return typeof value === 'string' && /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(value);
}

// 验证码存储（内存中，带上限）
const captchaStore = new Map();
const MAX_CAPTCHA_ENTRIES = 1000;
const captchaCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, record] of captchaStore) {
    if (!record || record.expiresAt <= now) captchaStore.delete(key);
  }
  while (captchaStore.size > MAX_CAPTCHA_ENTRIES) captchaStore.delete(captchaStore.keys().next().value);
}, 60000);
// 不让验证码维护定时器阻止测试进程或优雅退出。
if (typeof captchaCleanupTimer.unref === 'function') captchaCleanupTimer.unref();

// 注册频率限制（内存中）
const registerRateLimit = new Map();
const registerEmailCodeStore = new Map();
const registerEmailRateLimit = new Map();
const REGISTER_EMAIL_CODE_TTL = 10 * 60 * 1000;
const REGISTER_EMAIL_RESEND_INTERVAL = 60 * 1000;
const MAX_REGISTER_EMAIL_CODE_ENTRIES = 10000;
const MAX_REGISTER_EMAIL_RATE_ENTRIES = 10000;

// 生成验证码
router.get('/captcha', async (req, res) => {
  try {
    // 生成6位随机验证码（数字+大小写字母）
    const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz';
    let code = '';
    for (let i = 0; i < 6; i++) {
      const idx = crypto.randomInt(chars.length);
      code += chars[idx];
    }
    // 生成随机key
    const key = Date.now().toString(36) + crypto.randomBytes(16).toString('hex');
    
    // 存储验证码（5分钟过期）
    captchaStore.set(key, { code, expiresAt: Date.now() + 5 * 60 * 1000 });
    
    // 生成SVG验证码图片（带干扰）
    const width = 140;
    const height = 50;
    const svgChars = code.split('');
    
    // 生成随机干扰元素
    const lines = Array(8).fill(0).map(() => {
      const x1 = Math.random() * width;
      const y1 = Math.random() * height;
      const x2 = Math.random() * width;
      const y2 = Math.random() * height;
      const color = ['#ccc', '#ddd', '#aaa'][Math.floor(Math.random() * 3)];
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="1" opacity="0.5"/>`;
    }).join('');
    
    const dots = Array(20).fill(0).map(() => {
      const x = Math.random() * width;
      const y = Math.random() * height;
      return `<circle cx="${x}" cy="${y}" r="1" fill="#bbb" opacity="0.4"/>`;
    }).join('');
    
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <rect width="100%" height="100%" fill="#f8f9fa"/>
      ${dots}
      ${lines}
      ${svgChars.map((char, i) => {
        const x = 15 + i * 20;
        const y = 30 + Math.random() * 10 - 5;
        const rotate = -20 + Math.random() * 40;
        const colors = ['#333', '#444', '#555'];
        const color = colors[Math.floor(Math.random() * colors.length)];
        const fonts = ['Georgia', 'Times New Roman', 'Courier New', 'Arial'];
        const font = fonts[Math.floor(Math.random() * fonts.length)];
        return `<text x="${x}" y="${y}" font-family="${font}" font-size="28" font-weight="bold" fill="${color}" transform="rotate(${rotate}, ${x}, ${y})">${char}</text>`;
      }).join('')}
    </svg>`;
    
    res.json({
      code: 200,
      data: {
        key: key,
        captcha: svg
      }
    });
  } catch (err) {
    console.error('生成验证码失败:', err);
    res.json({ code: 500, message: '生成验证码失败' });
  }
});

// 验证验证码
function verifyCaptcha(key, code) {
  key = normalizeCaptchaValue(key);
  code = normalizeCaptchaValue(code);
  if (!key || !code) return false;
  const storedCode = captchaStore.get(key);
  if (!storedCode || storedCode.expiresAt <= Date.now()) {
    captchaStore.delete(key);
    return false;
  }
  if (storedCode.code.toUpperCase() !== code.toUpperCase()) return false;
  captchaStore.delete(key);
  return true;
}

function isSettingEnabled(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function hashRegisterEmailCode(email, code) {
  return crypto.createHash('sha256').update(email + ':' + code).digest('hex');
}

function checkRegisterEmailRateLimit(ip, email) {
  const now = Date.now();
  // 防止攻击者用大量不同的邮箱/IP 组合撑大内存中的限流表。
  if (registerEmailRateLimit.size > MAX_REGISTER_EMAIL_RATE_ENTRIES) {
    for (const [entryKey, entry] of registerEmailRateLimit) {
      if (now - entry.firstTime >= 60 * 60 * 1000 || registerEmailRateLimit.size > MAX_REGISTER_EMAIL_RATE_ENTRIES) {
        registerEmailRateLimit.delete(entryKey);
      }
      if (registerEmailRateLimit.size <= MAX_REGISTER_EMAIL_RATE_ENTRIES) break;
    }
  }
  const key = ip + ':' + email;
  const record = registerEmailRateLimit.get(key);
  if (!record || now - record.firstTime >= 60 * 60 * 1000) {
    registerEmailRateLimit.set(key, { count: 1, firstTime: now, lastSent: now });
    return { allowed: true };
  }
  if (now - record.lastSent < REGISTER_EMAIL_RESEND_INTERVAL) {
    return { allowed: false, message: '验证码发送过于频繁，请稍后再试' };
  }
  if (record.count >= 5) {
    return { allowed: false, message: '验证码发送次数过多，请1小时后再试' };
  }
  record.count++;
  record.lastSent = now;
  return { allowed: true };
}

function verifyRegisterEmailCode(email, code) {
  if (!/^\d{6}$/.test(String(code || ''))) return false;
  const record = registerEmailCodeStore.get(email);
  if (!record || record.expiresAt < Date.now()) {
    if (record) registerEmailCodeStore.delete(email);
    return false;
  }
  const providedHash = hashRegisterEmailCode(email, code);
  const valid = crypto.timingSafeEqual(Buffer.from(record.codeHash), Buffer.from(providedHash));
  if (valid) registerEmailCodeStore.delete(email);
  return valid;
}

async function getRegistrationSettings() {
  const [rows] = await pool.execute(
    'SELECT config_key, config_value FROM settings WHERE config_key IN (?, ?)',
    ['allow_register', 'register_email_verify_enabled']
  );
  const settings = {};
  rows.forEach(row => { settings[row.config_key] = row.config_value; });
  return settings;
}

// 获取注册页面功能开关
router.get('/register-options', async (req, res) => {
  try {
    const settings = await getRegistrationSettings();
    res.json({
      code: 200,
      data: {
        allowRegister: settings.allow_register !== 'false',
        emailVerificationEnabled: isSettingEnabled(settings.register_email_verify_enabled)
      }
    });
  } catch (err) {
    console.error('获取注册配置失败:', err.message);
    res.json({ code: 200, data: { allowRegister: true, emailVerificationEnabled: false } });
  }
});

// 发送注册邮箱验证码
router.post('/send-register-email-code', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.json({ code: 400, message: '请输入正确的邮箱格式' });
    }

    const settings = await getRegistrationSettings();
    if (settings.allow_register === 'false') {
      return res.json({ code: 403, message: '当前暂未开放注册' });
    }
    if (!isSettingEnabled(settings.register_email_verify_enabled)) {
      return res.json({ code: 403, message: '当前未开启邮箱验证注册' });
    }

    const clientIp = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    const rate = checkRegisterEmailRateLimit(clientIp, email);
    if (!rate.allowed) return res.json({ code: 429, message: rate.message });

    const code = crypto.randomInt(100000, 1000000).toString();
    const codeHash = hashRegisterEmailCode(email, code);
    const previous = registerEmailCodeStore.get(email);
    if (previous && previous.timer) clearTimeout(previous.timer);
    if (registerEmailCodeStore.size >= MAX_REGISTER_EMAIL_CODE_ENTRIES) {
      const oldest = registerEmailCodeStore.entries().next().value;
      if (oldest) {
        clearTimeout(oldest[1].timer);
        registerEmailCodeStore.delete(oldest[0]);
      }
    }
    const timer = setTimeout(() => registerEmailCodeStore.delete(email), REGISTER_EMAIL_CODE_TTL);
    registerEmailCodeStore.set(email, { codeHash, expiresAt: Date.now() + REGISTER_EMAIL_CODE_TTL, timer });

    const sent = await sendRegistrationCodeEmail(email, code, String(req.body.nickname || '').trim());
    if (!sent) {
      const current = registerEmailCodeStore.get(email);
      if (current && current.codeHash === codeHash) {
        clearTimeout(current.timer);
        registerEmailCodeStore.delete(email);
      }
      return res.json({ code: 500, message: '验证码发送失败，请联系管理员检查邮件配置' });
    }
    res.json({ code: 200, message: '验证码已发送，请查收邮箱' });
  } catch (err) {
    console.error('发送注册邮箱验证码失败:', err);
    res.json({ code: 500, message: '验证码发送失败，请稍后重试' });
  }
});

// 检查注册频率
function checkRegisterRateLimit(ip) {
  const now = Date.now();
  if (registerRateLimit.size >= MAX_RATE_LIMIT_ENTRIES && !registerRateLimit.has(ip)) {
    registerRateLimit.delete(registerRateLimit.keys().next().value);
  }
  const record = registerRateLimit.get(ip);
  
  if (!record) {
    registerRateLimit.set(ip, { count: 1, firstTime: now });
    return true;
  }
  
  // 1小时内最多注册3次
  if (now - record.firstTime < 60 * 60 * 1000) {
    if (record.count >= 3) {
      return false;
    }
    record.count++;
  } else {
    // 超过1小时，重置计数
    record.count = 1;
    record.firstTime = now;
  }
  
  return true;
}

// 注册
router.post('/register', async (req, res) => {
  try {
    const body = getRequestBody(req);
    const fields = validateRegistrationFields(body, true);
    if (fields.error) return res.json({ code: 400, message: fields.error });
    const captchaKey = normalizeCaptchaValue(body.captchaKey);
    const captchaCode = normalizeCaptchaValue(body.captchaCode);
    const email = normalizeEmail(fields.email);
    const emailCode = String(body.emailCode || '').trim();
    
    // 检查注册频率
    const clientIp = getClientIdentity(req);
    if (!checkRegisterRateLimit(clientIp)) {
      return res.json({ code: 429, message: '注册过于频繁，请1小时后再试' });
    }
    
    const settings = await getRegistrationSettings();
    if (settings.allow_register === 'false') {
      return res.json({ code: 403, message: '当前暂未开放注册' });
    }

    // 邮箱验证开启后，邮箱验证码承担注册校验；图片验证码保留为未开启邮箱验证时的回退。
    if (!isSettingEnabled(settings.register_email_verify_enabled)) {
      if (!captchaKey || !captchaCode) {
        return res.json({ code: 400, message: '请填写验证码' });
      }
      if (!verifyCaptcha(captchaKey, captchaCode)) {
        return res.json({ code: 400, message: '验证码错误或已过期' });
      }
    }

    const [existing] = await pool.execute('SELECT id FROM users WHERE username = ?', [fields.username]);
    if (existing.length > 0) {
      return res.json({ code: 400, message: '用户名已存在' });
    }

    if (isSettingEnabled(settings.register_email_verify_enabled)) {
      if (!emailCode) return res.json({ code: 400, message: '请填写邮箱验证码' });
      if (!verifyRegisterEmailCode(email, emailCode)) {
        return res.json({ code: 400, message: '邮箱验证码错误或已过期' });
      }
    }

    const hashedPassword = await bcrypt.hash(fields.password, 10);
    const [result] = await pool.execute(
      'INSERT INTO users (username, password, nickname, email, created_at) VALUES (?, ?, ?, ?, NOW())',
      [fields.username, hashedPassword, fields.nickname, fields.email]
    );

    const token = jwt.sign({ id: result.insertId }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      code: 200,
      message: '注册成功',
      data: { token, user: { id: result.insertId, username: fields.username, nickname: fields.nickname, email: fields.email, avatar: '/uploads/avatars/default.png', role: 'user', created_at: new Date().toISOString() } }
    });
  } catch (err) {
    console.error('注册错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 生成微信注册验证码
router.post('/generate-reg-code', async (req, res) => {
  try {
    const fields = validateRegistrationFields(getRequestBody(req), false);
    if (fields.error) return res.json({ code: 400, message: fields.error });

    const regCode = 'REG' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const passwordHash = await bcrypt.hash(fields.password, 10);
    await pool.execute(
      'INSERT INTO wechat_reg_codes (code, form_data, created_at) VALUES (?, ?, NOW())',
      [regCode, JSON.stringify({ username: fields.username, passwordHash, nickname: fields.nickname, email: fields.email })]
    );

    res.json({ code: 200, data: { regCode } });
  } catch (err) {
    console.error('生成注册验证码失败:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 检查微信注册验证码并注册
router.post('/register-wechat', async (req, res) => {
  let connection;
  try {
    const regCode = normalizeCaptchaValue(getRequestBody(req).regCode).toUpperCase();
    if (!/^REG[A-Z0-9]{6,8}$/.test(regCode)) {
      return res.json({ code: 400, message: '缺少验证码' });
    }
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [codes] = await connection.execute(
      'SELECT * FROM wechat_reg_codes WHERE code = ? AND verified = 1 AND used = 0 AND created_at >= DATE_SUB(NOW(), INTERVAL 10 MINUTE) LIMIT 1 FOR UPDATE',
      [regCode]
    );

    if (codes.length === 0) {
      await connection.rollback();
      return res.json({ code: 400, message: '验证码未验证或已过期，请先在微信公众号发送验证码' });
    }

    const record = codes[0];
    let formData;
    try {
      formData = JSON.parse(record.form_data);
    } catch (parseError) {
      await connection.rollback();
      return res.json({ code: 400, message: '注册信息无效，请重新操作' });
    }
    if (!formData || typeof formData !== 'object' || Array.isArray(formData)) {
      await connection.rollback();
      return res.json({ code: 400, message: '注册信息无效，请重新操作' });
    }
    const hasPasswordHash = isBcryptHash(formData.passwordHash);
    const rawPassword = typeof formData.password === 'string' ? formData.password : null;
    const fields = validateRegistrationFields({ ...formData, password: rawPassword || (hasPasswordHash ? 'stored-password-hash' : '') }, false);
    if (fields.error) {
      await connection.rollback();
      return res.json({ code: 400, message: '注册信息无效，请重新操作' });
    }
    if (!hasPasswordHash && !rawPassword) {
      await connection.rollback();
      return res.json({ code: 400, message: '注册信息无效，请重新操作' });
    }
    const passwordHash = hasPasswordHash
      ? formData.passwordHash
      : await bcrypt.hash(fields.password, 10);
    const openid = record.openid;

    const [existing] = await connection.execute('SELECT id FROM users WHERE username = ?', [fields.username]);
    if (existing.length > 0) {
      await connection.rollback();
      return res.json({ code: 400, message: '用户名已存在' });
    }

    const settings = await getRegistrationSettings();
    if (settings.allow_register === 'false') {
      await connection.rollback();
      return res.json({ code: 403, message: '当前暂未开放注册' });
    }
    const emailCode = String(getRequestBody(req).emailCode || '').trim();
    if (isSettingEnabled(settings.register_email_verify_enabled)) {
      if (!emailCode) {
        await connection.rollback();
        return res.json({ code: 400, message: '请填写邮箱验证码' });
      }
      if (!verifyRegisterEmailCode(normalizeEmail(fields.email), emailCode)) {
        await connection.rollback();
        return res.json({ code: 400, message: '邮箱验证码错误或已过期' });
      }
    }

    const [result] = await connection.execute(
      'INSERT INTO users (username, password, nickname, email, openid, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
      [fields.username, passwordHash, fields.nickname, normalizeEmail(fields.email), openid]
    );

    await connection.execute('UPDATE wechat_reg_codes SET used = 1 WHERE id = ?', [record.id]);
    await connection.commit();

    const token = jwt.sign({ id: result.insertId }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      code: 200,
      message: '注册成功',
      data: { token, user: { id: result.insertId, username: fields.username, nickname: fields.nickname, email: fields.email, avatar: '/uploads/avatars/default.png', role: 'user', created_at: new Date().toISOString() } }
    });
  } catch (err) {
    if (connection) {
      try { await connection.rollback(); } catch (rollbackError) {}
    }
    console.error('微信注册错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  } finally {
    if (connection) connection.release();
  }
});

// 检查微信注册验证码状态
router.post('/check-reg-code-status', async (req, res) => {
  try {
    const regCode = normalizeCaptchaValue(getRequestBody(req).regCode).toUpperCase();
    if (!/^REG[A-Z0-9]{6,8}$/.test(regCode)) return res.json({ code: 400, data: { verified: false } });

    const [codes] = await pool.execute(
      'SELECT verified, used FROM wechat_reg_codes WHERE code = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 10 MINUTE) LIMIT 1',
      [regCode]
    );

    if (codes.length === 0) {
      return res.json({ code: 200, data: { verified: false, expired: true } });
    }

    const record = codes[0];
    const state = record.used ? 'registered' : (record.verified ? 'verified' : 'pending');
    res.json({
      code: 200,
      data: {
        verified: !!record.verified && !record.used,
        used: !!record.used,
        expired: false,
        state
      }
    });
  } catch (err) {
    console.error('检查注册验证码状态失败:', err);
    res.json({ code: 500, data: { verified: false } });
  }
});

// 检查登录频率限制
async function checkLoginRateLimit(ip, username) {
  // 同一IP 15分钟内失败5次则限制
  var [ipAttempts] = await pool.execute(
    'SELECT COUNT(*) as cnt FROM login_attempts WHERE ip = ? AND success = 0 AND created_at > DATE_SUB(NOW(), INTERVAL 15 MINUTE)',
    [ip]
  );
  if (ipAttempts[0].cnt >= 5) {
    return { blocked: true, reason: 'IP登录尝试过多，请15分钟后再试', needCaptcha: false };
  }

  // 同一账号 15分钟内失败5次则限制
  var [userAttempts] = await pool.execute(
    'SELECT COUNT(*) as cnt FROM login_attempts WHERE username = ? AND success = 0 AND created_at > DATE_SUB(NOW(), INTERVAL 15 MINUTE)',
    [username]
  );
  if (userAttempts[0].cnt >= 5) {
    return { blocked: true, reason: '该账号登录尝试过多，已临时锁定15分钟', needCaptcha: false };
  }

  // 超过3次失败，下次登录需要验证码
  var [failCount] = await pool.execute(
    'SELECT COUNT(*) as cnt FROM login_attempts WHERE (ip = ? OR username = ?) AND success = 0 AND created_at > DATE_SUB(NOW(), INTERVAL 15 MINUTE)',
    [ip, username]
  );
  return { blocked: false, needCaptcha: failCount[0].cnt >= 3 };
}

async function recordLoginAttempt(ip, username, success) {
  try {
    await pool.execute(
      'INSERT INTO login_attempts (ip, username, success, created_at) VALUES (?, ?, ?, NOW())',
      [ip, username, success ? 1 : 0]
    );
  } catch (e) {}
}

// 获取登录状态（前端判断是否需要验证码）
router.get('/login-status', async (req, res) => {
  try {
    const clientIp = getClientIdentity(req);
    var ipAttempts = 0, userAttempts = 0;
    try {
      var [r1] = await pool.execute(
        'SELECT COUNT(*) as cnt FROM login_attempts WHERE ip = ? AND success = 0 AND created_at > DATE_SUB(NOW(), INTERVAL 15 MINUTE)', [clientIp]
      );
      ipAttempts = r1[0].cnt;
    } catch(e) {}
    res.json({
      code: 200,
      data: {
        needCaptcha: ipAttempts >= 3,
        attempts: ipAttempts
      }
    });
  } catch (e) {
    res.json({ code: 200, data: { needCaptcha: false, attempts: 0 } });
  }
});

// 登录
router.post('/login', async (req, res) => {
  try {
    const clientIp = getClientIdentity(req);
    const body = getRequestBody(req);
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = body.password;
    const captchaKey = normalizeCaptchaValue(body.captchaKey);
    const captchaCode = normalizeCaptchaValue(body.captchaCode);
    
    if (!username || typeof password !== 'string') {
      return res.json({ code: 400, message: '请填写用户名和密码' });
    }
    if (!isSafeText(username, 50) || password.length > MAX_PASSWORD_LENGTH) {
      return res.json({ code: 400, message: '登录参数不正确' });
    }

    // 检查频率限制
    var limit = await checkLoginRateLimit(clientIp, username);
    if (limit.blocked) {
      return res.json({ code: 429, message: limit.reason });
    }

    // 如果需要验证码但没传或错误
    if (limit.needCaptcha) {
      if (!captchaKey || !captchaCode) {
        return res.json({ code: 400, message: '请填写验证码', needCaptcha: true });
      }
      if (!verifyCaptcha(captchaKey, captchaCode)) {
        return res.json({ code: 400, message: '验证码错误', needCaptcha: true });
      }
    }

    const [users] = await pool.execute('SELECT * FROM users WHERE username = ?', [username]);
    if (users.length === 0) {
      await recordLoginAttempt(clientIp, username, false);
      return res.json({ code: 400, message: '用户名或密码错误' });
    }

    const user = users[0];
    if (user.status === 0) {
      await recordLoginAttempt(clientIp, username, false);
      // 记录封禁后登录尝试
      try {
        await pool.execute('UPDATE users SET ban_attempt_ip = ?, ban_attempt_count = ban_attempt_count + 1 WHERE id = ?', [clientIp, user.id]);
      } catch (e) {}
      return res.json({ code: 403, message: '账号已被封禁', ban_reason: user.ban_reason || '违规操作' });
    }

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      await recordLoginAttempt(clientIp, username, false);
      return res.json({ code: 400, message: '用户名或密码错误' });
    }

    // 登录成功，记录
    await recordLoginAttempt(clientIp, username, true);

    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });

    // IP归属地查询
    let cleanIp = clientIp;
    try {
      const { getClientIp, getIpRegion } = require('../services/ip-lookup');
      cleanIp = getClientIp(req).replace(/^::ffff:/, '').slice(0, 45);
      getIpRegion(cleanIp).then(function(region) {
        pool.execute(
          'UPDATE users SET last_login_at = NOW(), last_login_ip = ?, last_login_region = ? WHERE id = ?',
          [cleanIp, region || cleanIp, user.id]
        ).catch(function() {});
      });
    } catch (e) {}

    var cookieOpts = {
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      sameSite: 'strict',
      path: '/'
    };
    if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
      cookieOpts.secure = true;
    }
    res.cookie('token', token, cookieOpts);

    res.json({
      code: 200,
      message: '登录成功',
      data: {
        token,
        user: {
          id: user.id,
          username: user.username,
          nickname: user.nickname,
          avatar: user.avatar || '/uploads/avatars/default.png',
          role: user.role,
          created_at: user.created_at
        }
      }
    });
  } catch (err) {
    console.error('登录错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取当前用户信息
router.get('/me', auth, async (req, res) => {
  try {
    const [users] = await pool.execute(
      'SELECT id, username, nickname, avatar, role, email, birthday, mbti, gender, hobbies, created_at FROM users WHERE id = ?',
      [req.user.id]
    );
    if (users.length === 0) {
      return res.json({ code: 404, message: '用户不存在' });
    }
    var userData = users[0];
    if (userData && userData.birthday) {
      // 直接取日期部分 YYYY-MM-DD（dateStrings模式下始终为字符串）
      var bdStr = String(userData.birthday);
      userData.birthday = bdStr.split('T')[0].split(' ')[0];
    }
    res.json({ code: 200, data: userData });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 更新用户信息
router.put('/profile', auth, async (req, res) => {
  try {
    const body = getRequestBody(req);
    const nickname = typeof body.nickname === 'string' ? body.nickname.trim() : '';
    const email = body.email;
    const birthday = body.birthday;
    const mbti = body.mbti;
    const gender = body.gender;
    const hobbies = body.hobbies;

    if (!nickname || !isSafeText(nickname, 50)) {
      return res.json({ code: 400, message: '昵称不能为空且不能超过50个字符' });
    }

    if (email !== undefined && email !== null && email !== '' &&
      (typeof email !== 'string' || !isSafeText(email, 100) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))) {
      return res.json({ code: 400, message: '邮箱格式不正确' });
    }

    if (email !== undefined && email !== '' && email !== null) {
      const normalizedEmail = email.trim();
      const [existing] = await pool.execute('SELECT id FROM users WHERE email = ? AND id != ? AND email IS NOT NULL AND email != ""', [normalizedEmail, req.user.id]);
      if (existing.length > 0) {
        return res.json({ code: 400, message: '该邮箱已被使用' });
      }
    }

    // 校验生日格式
    let validBirthday = null;
    if (birthday !== undefined && birthday !== null && birthday !== '') {
      if (typeof birthday !== 'string') return res.json({ code: 400, message: '生日格式不正确' });
      const dateMatch = birthday.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (dateMatch) {
        const year = parseInt(dateMatch[1]);
        const month = parseInt(dateMatch[2]);
        const day = parseInt(dateMatch[3]);
        const date = new Date(Date.UTC(year, month - 1, day));
        if (year >= 1900 && year <= 2100 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day) {
          validBirthday = birthday;
        }
      }
      if (!validBirthday) return res.json({ code: 400, message: '生日格式不正确' });
    }

    // 只更新传了的字段，不清空空字段
    var updates = ['nickname = ?'];
    var values = [nickname || null];

    // 只有明确传了 email 且不为空才更新邮箱
    if (email !== undefined) {
      updates.push('email = ?');
      values.push(email === '' || email === null ? null : email.trim());
    }

    if (birthday !== undefined && birthday !== null && birthday !== '') { updates.push('birthday = ?'); values.push(validBirthday); }
    if (mbti !== undefined) {
      if (mbti !== null && !isSafeText(mbti, 10)) return res.json({ code: 400, message: 'MBTI格式不正确' });
      updates.push('mbti = ?'); values.push(mbti || null);
    }
    if (gender !== undefined) {
      if (gender !== null && !isSafeText(gender, 10)) return res.json({ code: 400, message: '性别格式不正确' });
      updates.push('gender = ?'); values.push(gender || null);
    }
    if (hobbies !== undefined) {
      if (hobbies !== null && !isSafeText(hobbies, 500)) return res.json({ code: 400, message: '兴趣爱好不能超过500个字符' });
      updates.push('hobbies = ?'); values.push(hobbies || null);
    }

    values.push(req.user.id);
    await pool.execute('UPDATE users SET ' + updates.join(', ') + ' WHERE id = ?', values);
    
    // 返回更新后的用户信息
    const [users] = await pool.execute(
      'SELECT id, username, nickname, avatar, role, email, birthday, mbti, gender, hobbies FROM users WHERE id = ?',
      [req.user.id]
    );
    if (users.length === 0) return res.json({ code: 404, message: '用户不存在' });
    
    // 格式化生日为 YYYY-MM-DD 本地日期（dateStrings模式，直接取字符串）
    if (users[0].birthday) {
      var bdStr = String(users[0].birthday);
      users[0].birthday = bdStr.split('T')[0].split(' ')[0];
    }
    
    res.json({ code: 200, message: '更新成功', data: users[0] });
  } catch (err) {
    console.error('更新用户信息失败:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 更新密码
router.put('/password', auth, async (req, res) => {
  try {
    const body = getRequestBody(req);
    const oldPassword = body.oldPassword;
    const newPassword = body.newPassword;
    if (typeof oldPassword !== 'string' || typeof newPassword !== 'string' || !oldPassword || !newPassword) {
      return res.json({ code: 400, message: '请填写完整' });
    }
    if (oldPassword.length > MAX_PASSWORD_LENGTH || newPassword.length < 6 || newPassword.length > MAX_PASSWORD_LENGTH) {
      return res.json({ code: 400, message: `新密码长度应为6-${MAX_PASSWORD_LENGTH}个字符` });
    }
    const [users] = await pool.execute('SELECT password FROM users WHERE id = ?', [req.user.id]);
    if (!users[0] || !isBcryptHash(users[0].password)) {
      return res.json({ code: 401, message: '登录状态无效，请重新登录' });
    }
    const isValid = await bcrypt.compare(oldPassword, users[0].password);
    if (!isValid) {
      return res.json({ code: 400, message: '原密码错误' });
    }
    const hashed = await bcrypt.hash(newPassword, 10);
    await pool.execute('UPDATE users SET password = ? WHERE id = ?', [hashed, req.user.id]);
    res.json({ code: 200, message: '密码修改成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 兼容旧客户端：与 /api/upload/avatar 共用同一套文件校验、去重和旧文件回收。
router.post('/avatar', auth, handleAvatarUploadRequest);

// 退出登录
router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ code: 200, message: '已退出登录' });
});

// 获取用户的邮件通知偏好
router.get('/notify-settings', auth, async (req, res) => {
  try {
    const [settings] = await pool.execute(
      'SELECT * FROM user_notify_settings WHERE user_id = ?',
      [req.user.id]
    );
    if (settings.length > 0) {
      res.json({ code: 200, data: settings[0] });
    } else {
      // 返回默认值
      res.json({ code: 200, data: {
        user_id: req.user.id,
        notify_comment: 1, notify_like: 1, notify_mention: 1,
        notify_follower: 1, notify_post_approved: 1, notify_post_rejected: 1,
        notify_song_approved: 1, notify_song_rejected: 1, notify_song_played: 1,
        notify_feedback_reply: 1, notify_follow_post: 1
      }});
    }
  } catch (err) {
    console.error('获取通知偏好失败:', err && (err.code || err.message || 'unknown error'));
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 保存用户的邮件通知偏好（增量更新 - 只更新传了的字段）
router.put('/notify-settings', auth, async (req, res) => {
  try {
    const body = getRequestBody(req);
    
    var allowedFields = [
      'notify_comment', 'notify_like', 'notify_mention', 'notify_follower',
      'notify_post_approved', 'notify_post_rejected',
      'notify_song_approved', 'notify_song_rejected', 'notify_song_played',
      'notify_feedback_reply', 'notify_follow_post'
    ];
    
    var updates = [];
    var values = [];
    for (var i = 0; i < allowedFields.length; i++) {
      var field = allowedFields[i];
      if (body[field] !== undefined) {
        updates.push(field + ' = ?');
        values.push(body[field] ? 1 : 0);
      }
    }
    
    if (updates.length === 0) {
      return res.json({ code: 400, message: '没有需要更新的字段' });
    }
    
    // 先确保行存在（首次保存时插入）
    await pool.execute(
      'INSERT IGNORE INTO user_notify_settings (user_id) VALUES (?)',
      [req.user.id]
    );
    
    // 只更新传了的字段，保留其他字段的原有值
    await pool.execute(
      'UPDATE user_notify_settings SET ' + updates.join(', ') + ' WHERE user_id = ?',
      values.concat([req.user.id])
    );
    
    res.json({ code: 200, message: '保存成功' });
  } catch (err) {
    console.error('保存通知偏好失败:', err && (err.code || err.message || 'unknown error'));
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ===== 密码重置（通过微信验证码） =====
// 验证重置码
router.post('/verify-reset-code', async (req, res) => {
  try {
    const code = normalizeCaptchaValue(getRequestBody(req).code).toUpperCase();
    if (!code || code.length > 64) return res.json({ code: 400, message: '请输入验证码' });
    const [tokens] = await pool.execute(
      'SELECT user_id, expires_at FROM password_reset_tokens WHERE token = ? AND used = 0 AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1',
      [code.toUpperCase()]
    );
    if (tokens.length === 0) {
      return res.json({ code: 400, message: '验证码无效或已过期' });
    }
    res.json({ code: 200, message: '验证成功', data: { user_id: tokens[0].user_id } });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 使用验证码重置密码
router.post('/reset-password', async (req, res) => {
  let connection;
  try {
    const body = getRequestBody(req);
    const code = normalizeCaptchaValue(body.code).toUpperCase();
    const newPassword = body.newPassword;
    if (!code || typeof newPassword !== 'string') return res.json({ code: 400, message: '请填写完整' });
    if (code.length > 64 || newPassword.length < 6 || newPassword.length > MAX_PASSWORD_LENGTH) {
      return res.json({ code: 400, message: `新密码长度应为6-${MAX_PASSWORD_LENGTH}个字符` });
    }
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [tokens] = await connection.execute(
      'SELECT id, user_id FROM password_reset_tokens WHERE token = ? AND used = 0 AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1 FOR UPDATE',
      [code.toUpperCase()]
    );
    if (tokens.length === 0) {
      await connection.rollback();
      return res.json({ code: 400, message: '验证码无效或已过期' });
    }
    const hashed = await bcrypt.hash(newPassword, 10);
    const [updated] = await connection.execute('UPDATE users SET password = ? WHERE id = ?', [hashed, tokens[0].user_id]);
    if (!updated.affectedRows) {
      await connection.rollback();
      return res.json({ code: 400, message: '验证码无效或已过期' });
    }
    await connection.execute('UPDATE password_reset_tokens SET used = 1 WHERE id = ?', [tokens[0].id]);
    await connection.commit();
    res.json({ code: 200, message: '密码重置成功，请重新登录' });
  } catch (err) {
    if (connection) {
      try { await connection.rollback(); } catch (rollbackError) {}
    }
    res.json({ code: 500, message: '服务器错误' });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;
