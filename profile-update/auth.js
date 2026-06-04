const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../config/database');
const { auth } = require('../middleware/auth');
const router = express.Router();

// 注册
router.post('/register', async (req, res) => {
  try {
    const { username, password, nickname } = req.body;

    // 检查是否开放注册
    const [settingRows] = await pool.execute('SELECT config_value FROM settings WHERE config_key = ?', ['allow_register']);
    if (settingRows.length > 0 && settingRows[0].config_value === 'false') {
      return res.json({ code: 403, message: '当前暂未开放注册' });
    }

    if (!username || !password || !nickname) {
      return res.json({ code: 400, message: '请填写完整信息' });
    }
    if (username.length < 3 || username.length > 20) {
      return res.json({ code: 400, message: '用户名长度3-20个字符' });
    }
    if (password.length < 6) {
      return res.json({ code: 400, message: '密码至少6个字符' });
    }

    const [existing] = await pool.execute('SELECT id FROM users WHERE username = ?', [username]);
    if (existing.length > 0) {
      return res.json({ code: 400, message: '用户名已存在' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const [result] = await pool.execute(
      'INSERT INTO users (username, password, nickname) VALUES (?, ?, ?)',
      [username, hashedPassword, nickname]
    );

    const token = jwt.sign({ id: result.insertId }, process.env.JWT_SECRET || 'default_secret', { expiresIn: '7d' });
    res.json({
      code: 200,
      message: '注册成功',
      data: { token, user: { id: result.insertId, username, nickname, avatar: '/uploads/avatars/default.png', role: 'user', created_at: new Date().toISOString() } }
    });
  } catch (err) {
    console.error('注册错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 登录
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.json({ code: 400, message: '请填写用户名和密码' });
    }

    const [users] = await pool.execute('SELECT * FROM users WHERE username = ?', [username]);
    if (users.length === 0) {
      return res.json({ code: 400, message: '用户名或密码错误' });
    }

    const user = users[0];
    if (user.status === 0) {
      return res.json({ code: 403, message: '账号已被禁用' });
    }

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      return res.json({ code: 400, message: '用户名或密码错误' });
    }

    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET || 'default_secret', { expiresIn: '7d' });
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
    res.json({ code: 200, data: users[0] });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 修改个人信息
router.put('/profile', auth, async (req, res) => {
  try {
    const { nickname, email, birthday, mbti, gender, hobbies } = req.body;
    const updates = [];
    const values = [];

    if (nickname) {
      if (nickname.length > 20) {
        return res.json({ code: 400, message: '昵称不能超过20个字符' });
      }
      updates.push('nickname = ?');
      values.push(nickname);
    }
    if (email !== undefined) {
      updates.push('email = ?');
      values.push(email);
    }
    if (birthday !== undefined) {
      updates.push('birthday = ?');
      values.push(birthday || null);
    }
    if (mbti !== undefined) {
      const validMbti = ['INTJ','INTP','ENTJ','ENTP','INFJ','INFP','ENFJ','ENFP','ISTJ','ISFJ','ESTJ','ESFJ','ISTP','ISFP','ESTP','ESFP'];
      if (mbti && !validMbti.includes(mbti.toUpperCase())) {
        return res.json({ code: 400, message: '请选择有效的MBTI类型' });
      }
      updates.push('mbti = ?');
      values.push(mbti ? mbti.toUpperCase() : null);
    }
    if (gender !== undefined) {
      updates.push('gender = ?');
      values.push(gender || null);
    }
    if (hobbies !== undefined) {
      if (hobbies && hobbies.length > 500) {
        return res.json({ code: 400, message: '喜好不能超过500个字符' });
      }
      updates.push('hobbies = ?');
      values.push(hobbies || null);
    }

    if (updates.length === 0) {
      return res.json({ code: 400, message: '没有要修改的内容' });
    }

    values.push(req.user.id);
    await pool.execute(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, values);

    // 返回更新后的用户信息
    const [users] = await pool.execute(
      'SELECT id, username, nickname, avatar, role, email, birthday, mbti, gender, hobbies, created_at FROM users WHERE id = ?',
      [req.user.id]
    );
    res.json({ code: 200, message: '修改成功', data: users[0] });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 修改密码
router.put('/password', auth, async (req, res) => {
  try {
    // 兼容前端蛇形命名和驼峰命名
    const oldPassword = req.body.oldPassword || req.body.old_password;
    const newPassword = req.body.newPassword || req.body.new_password;
    if (!oldPassword || !newPassword) {
      return res.json({ code: 400, message: '请填写旧密码和新密码' });
    }
    if (newPassword.length < 6) {
      return res.json({ code: 400, message: '新密码至少6个字符' });
    }

    const [users] = await pool.execute('SELECT password FROM users WHERE id = ?', [req.user.id]);
    const isValid = await bcrypt.compare(oldPassword, users[0].password);
    if (!isValid) {
      return res.json({ code: 400, message: '旧密码错误' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await pool.execute('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, req.user.id]);
    res.json({ code: 200, message: '密码修改成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

module.exports = router;
