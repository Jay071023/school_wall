const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../config/database');
const { auth } = require('../middleware/auth');
const JWT_SECRET = require('../config/jwt-secret');
const router = express.Router();

// 验证码存储（内存中，带上限）
const captchaStore = new Map();
const MAX_CAPTCHA_ENTRIES = 1000;
setInterval(() => {
  if (captchaStore.size > MAX_CAPTCHA_ENTRIES) {
    const keys = [...captchaStore.keys()].slice(0, captchaStore.size - MAX_CAPTCHA_ENTRIES);
    keys.forEach(k => captchaStore.delete(k));
  }
}, 60000);

// 注册频率限制（内存中）
const registerRateLimit = new Map();

// 生成验证码
router.get('/captcha', async (req, res) => {
  try {
    // 生成6位随机验证码（数字+大小写字母）
    const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz';
    let code = '';
    for (let i = 0; i < 6; i++) {
      const idx = Math.floor(Math.random() * chars.length);
      code += chars[idx];
    }
    // 生成随机key
    const key = Date.now().toString(36) + Math.random().toString(36).substring(2, 18);
    
    // 存储验证码（5分钟过期）
    captchaStore.set(key, code);
    setTimeout(() => captchaStore.delete(key), 5 * 60 * 1000);
    
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
  const storedCode = captchaStore.get(key);
  if (!storedCode) return false;
  if (storedCode.toUpperCase() !== code.toUpperCase()) return false;
  captchaStore.delete(key);
  return true;
}

// 检查注册频率
function checkRegisterRateLimit(ip) {
  const now = Date.now();
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
    const { username, password, nickname, email, captchaKey, captchaCode } = req.body;
    
    // 检查注册频率
    const clientIp = req.headers['x-forwarded-for'] || req.ip || '';
    if (!checkRegisterRateLimit(clientIp)) {
      return res.json({ code: 429, message: '注册过于频繁，请1小时后再试' });
    }
    
    // 验证验证码
    if (!captchaKey || !captchaCode) {
      return res.json({ code: 400, message: '请填写验证码' });
    }
    if (!verifyCaptcha(captchaKey, captchaCode)) {
      return res.json({ code: 400, message: '验证码错误或已过期' });
    }

    const [settingRows] = await pool.execute('SELECT config_value FROM settings WHERE config_key = ?', ['allow_register']);
    if (settingRows.length > 0 && settingRows[0].config_value === 'false') {
      return res.json({ code: 403, message: '当前暂未开放注册' });
    }

    if (!username || !password || !nickname || !email) {
      return res.json({ code: 400, message: '请填写完整信息' });
    }
    if (username.length < 3 || username.length > 20) {
      return res.json({ code: 400, message: '用户名长度3-20个字符' });
    }
    if (password.length < 6) {
      return res.json({ code: 400, message: '密码至少6个字符' });
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.json({ code: 400, message: '邮箱格式不正确' });
    }

    const [existing] = await pool.execute('SELECT id FROM users WHERE username = ?', [username]);
    if (existing.length > 0) {
      return res.json({ code: 400, message: '用户名已存在' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const [result] = await pool.execute(
      'INSERT INTO users (username, password, nickname, email, created_at) VALUES (?, ?, ?, ?, NOW())',
      [username, hashedPassword, nickname, email || null]
    );

    const token = jwt.sign({ id: result.insertId }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      code: 200,
      message: '注册成功',
      data: { token, user: { id: result.insertId, username, nickname, email: email || null, avatar: '/uploads/avatars/default.png', role: 'user', created_at: new Date().toISOString() } }
    });
  } catch (err) {
    console.error('注册错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 生成微信注册验证码
router.post('/generate-reg-code', async (req, res) => {
  try {
    const { username, password, nickname, email } = req.body;
    if (!username || !password || !nickname) {
      return res.json({ code: 400, message: '请填写完整信息' });
    }

    const regCode = 'REG' + Math.random().toString(36).substring(2, 8).toUpperCase();
    await pool.execute(
      'INSERT INTO wechat_reg_codes (code, form_data, created_at) VALUES (?, ?, NOW())',
      [regCode, JSON.stringify({ username, password, nickname, email })]
    );

    res.json({ code: 200, data: { regCode } });
  } catch (err) {
    console.error('生成注册验证码失败:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 检查微信注册验证码并注册
router.post('/register-wechat', async (req, res) => {
  try {
    const { regCode } = req.body;
    if (!regCode) {
      return res.json({ code: 400, message: '缺少验证码' });
    }

    const [codes] = await pool.execute(
      'SELECT * FROM wechat_reg_codes WHERE code = ? AND verified = 1 AND used = 0 AND created_at >= DATE_SUB(NOW(), INTERVAL 10 MINUTE) LIMIT 1',
      [regCode]
    );

    if (codes.length === 0) {
      return res.json({ code: 400, message: '验证码未验证或已过期，请先在微信公众号发送验证码' });
    }

    const record = codes[0];
    const formData = JSON.parse(record.form_data);
    const { username, password, nickname, email } = formData;
    const openid = record.openid;

    const [existing] = await pool.execute('SELECT id FROM users WHERE username = ?', [username]);
    if (existing.length > 0) {
      return res.json({ code: 400, message: '用户名已存在' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const [result] = await pool.execute(
      'INSERT INTO users (username, password, nickname, email, openid, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
      [username, hashedPassword, nickname, email || null, openid]
    );

    await pool.execute('UPDATE wechat_reg_codes SET used = 1 WHERE id = ?', [record.id]);

    const token = jwt.sign({ id: result.insertId }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      code: 200,
      message: '注册成功',
      data: { token, user: { id: result.insertId, username, nickname, email: email || null, avatar: '/uploads/avatars/default.png', role: 'user', created_at: new Date().toISOString() } }
    });
  } catch (err) {
    console.error('微信注册错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 检查微信注册验证码状态
router.post('/check-reg-code-status', async (req, res) => {
  try {
    const { regCode } = req.body;
    if (!regCode) return res.json({ code: 400, data: { verified: false } });

    const [codes] = await pool.execute(
      'SELECT verified, used FROM wechat_reg_codes WHERE code = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 10 MINUTE) LIMIT 1',
      [regCode]
    );

    if (codes.length === 0) {
      return res.json({ code: 200, data: { verified: false, expired: true } });
    }

    res.json({ code: 200, data: { verified: !!codes[0].verified, expired: false } });
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
    const clientIp = (req.headers['x-forwarded-for'] || req.ip || '').replace(/^::ffff:/, '');
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
    const clientIp = (req.headers['x-forwarded-for'] || req.ip || '').replace(/^::ffff:/, '');
    const { username, password, captchaKey, captchaCode } = req.body;
    
    if (!username || !password) {
      return res.json({ code: 400, message: '请填写用户名和密码' });
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
      return res.json({ code: 403, message: '账号已被禁用' });
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
    try {
      const { getClientIp, getIpRegion } = require('../services/ip-lookup');
      const cleanIp = getClientIp(req).replace(/^::ffff:/, '');
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

    // 如果是管理员登录且IP不同，记录日志
    if (['admin', 'super_admin', 'reviewer'].includes(user.role)) {
      try {
        var [lastLog] = await pool.execute(
          'SELECT last_login_ip, last_login_region FROM users WHERE id = ?', [user.id]
        );
        if (lastLog[0] && lastLog[0].last_login_ip && lastLog[0].last_login_ip !== cleanIp) {
          console.log('[安全] 管理员 ' + user.username + ' 从新IP登录: ' + cleanIp);
        }
      } catch(e) {}
    }

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
    const { nickname, email, birthday, mbti, gender, hobbies } = req.body;

    if (email !== undefined && email !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.json({ code: 400, message: '邮箱格式不正确' });
    }

    if (email !== undefined && email !== '' && email !== null) {
      const [existing] = await pool.execute('SELECT id FROM users WHERE email = ? AND id != ? AND email IS NOT NULL AND email != ""', [email, req.user.id]);
      if (existing.length > 0) {
        return res.json({ code: 400, message: '该邮箱已被使用' });
      }
    }

    // 校验生日格式
    let validBirthday = null;
    if (birthday) {
      const dateMatch = birthday.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (dateMatch) {
        const year = parseInt(dateMatch[1]);
        const month = parseInt(dateMatch[2]);
        const day = parseInt(dateMatch[3]);
        if (year >= 1900 && year <= 2100 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
          validBirthday = birthday;
        }
      }
    }

    // 只更新传了的字段，不清空空字段
    var updates = ['nickname = ?'];
    var values = [nickname || null];

    // 只有明确传了 email 且不为空才更新邮箱
    if (email !== undefined) {
      updates.push('email = ?');
      values.push(email === '' ? null : email);
    }

    if (birthday) { updates.push('birthday = ?'); values.push(validBirthday); }
    if (mbti !== undefined) { updates.push('mbti = ?'); values.push(mbti || null); }
    if (gender !== undefined) { updates.push('gender = ?'); values.push(gender || null); }
    if (hobbies !== undefined) { updates.push('hobbies = ?'); values.push(hobbies || null); }

    values.push(req.user.id);
    await pool.execute('UPDATE users SET ' + updates.join(', ') + ' WHERE id = ?', values);
    
    // 返回更新后的用户信息
    const [users] = await pool.execute(
      'SELECT id, username, nickname, avatar, role, email, birthday, mbti, gender, hobbies FROM users WHERE id = ?',
      [req.user.id]
    );
    
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
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) {
      return res.json({ code: 400, message: '请填写完整' });
    }
    if (newPassword.length < 6) {
      return res.json({ code: 400, message: '新密码至少6个字符' });
    }
    const [users] = await pool.execute('SELECT password FROM users WHERE id = ?', [req.user.id]);
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

// 上传头像
router.post('/avatar', auth, async (req, res) => {
  try {
    if (!req.file) {
      return res.json({ code: 400, message: '请选择图片' });
    }
    const avatar = '/uploads/avatars/' + req.file.filename;
    await pool.execute('UPDATE users SET avatar = ? WHERE id = ?', [avatar, req.user.id]);
    res.json({ code: 200, message: '上传成功', data: { avatar } });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

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
    console.error('获取通知偏好失败:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 保存用户的邮件通知偏好（增量更新 - 只更新传了的字段）
router.put('/notify-settings', auth, async (req, res) => {
  try {
    console.log('[Notify Settings] 收到请求');
    console.log('[Notify Settings] Content-Type:', req.headers['content-type']);
    console.log('[Notify Settings] Body 类型:', typeof req.body);
    console.log('[Notify Settings] Body 内容:', JSON.stringify(req.body));
    console.log('[Notify Settings] Body keys:', Object.keys(req.body || {}));
    
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
      console.log('[Notify Settings] 检查字段:', field, '值:', req.body[field], '类型:', typeof req.body[field]);
      if (req.body[field] !== undefined) {
        updates.push(field + ' = ?');
        values.push(req.body[field] ? 1 : 0);
      }
    }
    
    console.log('[Notify Settings] 需要更新的字段:', updates.length, updates);
    
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
    console.error('保存通知偏好失败:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ===== 密码重置（通过微信验证码） =====
// 验证重置码
router.post('/verify-reset-code', async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.json({ code: 400, message: '请输入验证码' });
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
  try {
    const { code, newPassword } = req.body;
    if (!code || !newPassword) return res.json({ code: 400, message: '请填写完整' });
    if (newPassword.length < 6) return res.json({ code: 400, message: '新密码至少6个字符' });
    const [tokens] = await pool.execute(
      'SELECT id, user_id FROM password_reset_tokens WHERE token = ? AND used = 0 AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1',
      [code.toUpperCase()]
    );
    if (tokens.length === 0) {
      return res.json({ code: 400, message: '验证码无效或已过期' });
    }
    const hashed = await bcrypt.hash(newPassword, 10);
    await pool.execute('UPDATE users SET password = ? WHERE id = ?', [hashed, tokens[0].user_id]);
    await pool.execute('UPDATE password_reset_tokens SET used = 1 WHERE id = ?', [tokens[0].id]);
    res.json({ code: 200, message: '密码重置成功，请重新登录' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

module.exports = router;