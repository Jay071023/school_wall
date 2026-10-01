'use strict';
const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const morgan = require('morgan');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

function registerMiddlewares(app, { logging = true,
  allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000').split(',') } = {}) {
  // 中间件
  app.use(compression()); // 响应压缩
  // CORS：仅允许指定域名
  app.use(cors({
    origin: function(origin, callback) {
      // 允许没有 origin 的请求（postman、curl 等）
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      // 不在白名单则拒绝，但不抛错
      return callback(null, false);  // was: callback(new Error('Not allowed by CORS'));
    },
    credentials: true
  }));
  if (logging) app.use(morgan('dev'));
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

  // 安全头（helmet 提供 CSP、X-Content-Type-Options 等）
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'", 'https://v1.hitokoto.cn', 'https://fonts.googleapis.com', 'https://fonts.gstatic.com'],
        fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
        objectSrc: ["'none'"],
        mediaSrc: ["'self'"],
        frameSrc: ["'none'"]
      }
    },
    crossOriginEmbedderPolicy: false
  }));

  // 手动补充的安全头
  app.use(function(req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  });

  // 全局限流（通用）
  app.use(rateLimit({
    windowMs: 15 * 60 * 1000, // 15分钟
    max: 2000, // 最多2000请求（之前500太少了，后台30秒轮询一次很容易刷满）
    standardHeaders: true,
    legacyHeaders: false
  }));

  // 登录注册限流（更严格）
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20, // 15分钟内最多20次
    standardHeaders: true,
    legacyHeaders: false,
    message: { code: 429, message: '请求过于频繁，请稍后再试' }
  });

  app.use('/api/auth/login', authLimiter);
  app.use('/api/auth/register', authLimiter);
  app.use('/api/auth/send-register-email-code', authLimiter);
}

module.exports = { registerMiddlewares };
