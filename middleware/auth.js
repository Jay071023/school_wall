const jwt = require('jsonwebtoken');
const { pool } = require('../config/database');

const ROLES = {
  user: 0,
  reviewer: 1,
  radio_admin: 1,
  admin: 2,
  super_admin: 3
};

const ROLE_NAMES = {
  user: '普通用户',
  reviewer: '审核员',
  radio_admin: '广播管理员',
  admin: '管理员',
  super_admin: '超级管理员'
};

const ROLE_PERMISSIONS = {
  user: [],
  reviewer: ['posts:review', 'posts:delete'],
  radio_admin: ['songs:review', 'songs:delete', 'slots:manage'],
  admin: ['posts:review', 'posts:delete', 'songs:review', 'songs:delete', 'slots:manage', 'users:view', 'users:status', 'notices:manage', 'feedbacks:manage', 'stats:view'],
  super_admin: ['posts:review', 'posts:delete', 'songs:review', 'songs:delete', 'slots:manage', 'users:view', 'users:status', 'users:role', 'admin:manage', 'stats:view', 'logs:view', 'notices:manage', 'settings:view', 'feedbacks:manage']
};

const auth = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1] || req.cookies?.token;
    if (!token) {
      return res.status(401).json({ code: 401, message: '请先登录' });
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET || null);
    const [users] = await pool.execute('SELECT id, username, nickname, avatar, role, status FROM users WHERE id = ?', [decoded.id]);
    if (users.length === 0) {
      return res.status(401).json({ code: 401, message: '用户不存在' });
    }
    if (users[0].status === 0) {
      return res.status(403).json({ code: 403, message: '账号已被禁用' });
    }
    req.user = users[0];
    req.user.roleName = ROLE_NAMES[users[0].role] || '普通用户';
    req.user.permissions = ROLE_PERMISSIONS[users[0].role] || [];
    next();
  } catch (err) {
    return res.status(401).json({ code: 401, message: '登录已过期，请重新登录' });
  }
};

const optionalAuth = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1] || req.cookies?.token;
    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET || null);
      const [users] = await pool.execute('SELECT id, username, nickname, avatar, role, status FROM users WHERE id = ?', [decoded.id]);
      if (users.length > 0 && users[0].status === 1) {
        req.user = users[0];
        req.user.roleName = ROLE_NAMES[users[0].role] || '普通用户';
        req.user.permissions = ROLE_PERMISSIONS[users[0].role] || [];
      }
    }
  } catch (err) {
  }
  next();
};

const isStaff = (req, res, next) => {
  if (!req.user || ROLES[req.user.role] < 1) {
    return res.status(403).json({ code: 403, message: '无管理权限' });
  }
  next();
};

const adminOnly = (req, res, next) => {
  if (!req.user || ROLES[req.user.role] < 2) {
    return res.status(403).json({ code: 403, message: '需要管理员权限' });
  }
  next();
};

const superAdminOnly = (req, res, next) => {
  if (!req.user || req.user.role !== 'super_admin') {
    return res.status(403).json({ code: 403, message: '需要超级管理员权限' });
  }
  next();
};

const requirePermission = (permission) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ code: 401, message: '请先登录' });
    }
    if (req.user.role === 'super_admin' || (req.user.permissions && req.user.permissions.includes(permission))) {
      return next();
    }
    return res.status(403).json({ code: 403, message: '权限不足' });
  };
};

module.exports = { auth, optionalAuth, adminOnly, isStaff, superAdminOnly, requirePermission, ROLES, ROLE_NAMES, ROLE_PERMISSIONS };