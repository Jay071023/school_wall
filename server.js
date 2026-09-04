const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const morgan = require('morgan');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
// 先加载 .env（基础配置），再加载 .env.local（本地覆盖，含敏感信息）
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config({ path: path.join(__dirname, '.env.local'), override: true });

// 全局异常保护，防止未捕获错误导致服务崩溃
process.on('uncaughtException', function(err) {
  console.error('未捕获异常:', err.message);
  process.exit(1);
});
process.on('unhandledRejection', function(err) {
  console.error('未处理Promise拒绝:', err && err.message || err);
  process.exit(1);
});

const { initDB } = require('./config/database');
const { scheduleCleanup } = require('./services/cleanup');

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
app.use(compression()); // 响应压缩
// CORS：仅允许指定域名
var allowedOrigins = (process.env.ALLOWED_ORIGINS || 'https://campus-wall.example').split(',');
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
app.use(morgan('dev'));
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

// 页面链接统一使用无扩展名 URL；直接运行 Node 时也要和生产反向代理保持一致。
const pageAliases = {
  '/radio': 'radio.html',
  '/profile': 'profile.html',
  '/login': 'login.html',
  '/register': 'register.html',
  '/new-post': 'new-post.html',
  '/edit-post': 'edit-post.html',
  '/edit-profile': 'edit-profile.html',
  '/feedback': 'feedback.html',
  '/agreement': 'agreement.html',
  '/privacy': 'privacy.html',
  '/messages': 'messages.html',
  '/admin/mp-draft': 'admin/mp-draft.html'
};
Object.keys(pageAliases).forEach((route) => {
  app.get(route, (req, res) => res.sendFile(path.join(__dirname, 'public', pageAliases[route])));
});
app.get('/post/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'post-detail.html')));

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    // HTML 必须每次向 CDN/浏览器重新校验，确保部署后的页面引用不会长期过期。
    if (/\.html$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }

    // 未做文件名指纹的 CSS/JS 使用短缓存 + 后台刷新，兼顾首屏速度与发布后的可见性。
    if (/\.(css|js)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=86400');
      res.setHeader('Surrogate-Control', 'public, max-age=300, stale-while-revalidate=86400');
    }

    // 头像和图片目前使用受控路径；保留 7 天缓存，减少重复下载。
    if (/\.(jpg|jpeg|png|gif|webp|svg|ico)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=604800');
    }

    // 视频上传使用随机文件名，内容不会被原地覆盖，可以安全长期缓存。
    if (/\.(mp4|webm|ogv)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
      res.setHeader('Accept-Ranges', 'bytes');
    }
  }
}));

// API路由
app.use('/api/auth', require('./routes/auth'));
app.use('/api/posts', require('./routes/posts'));
app.use('/api/songs', require('./routes/songs'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/upload', require('./routes/upload'));
app.use('/api/feedback', require('./routes/feedback'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/notices', require('./routes/notices'));
app.use('/api/reservations', require('./routes/reservations'));
app.use('/api/leaderboard', require('./routes/leaderboard'));
app.use('/api/follows', require('./routes/follows'));
app.use('/api/checkin', require('./routes/checkin'));
app.use('/api/wechat', require('./routes/wechat'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/mp', require('./routes/mp-draft'));
app.use('/api/proxy/hitokoto', require('./routes/hitokoto'));
app.use('/api', require('./routes/site'));
app.use('/api', require('./routes/health'));
app.use('/api', require('./routes/deploy'));

// 启动服务器
async function start() {
  try {
    await initDB();
    app.listen(PORT, process.env.HOST || '0.0.0.0', () => {
      console.log(`
  🎉 校园墙网站启动成功！
  📡 访问地址: http://localhost:${PORT}
  🔧 管理后台: http://localhost:${PORT}/admin
      `);

      // 定时清理操作日志（每天凌晨3点清理30天前的日志）
      scheduleCleanup();
    });
  } catch (err) {
    console.error('启动失败:', err);
    process.exit(1);
  }
}

// 仅直接执行 server.js 时启动监听；被测试或其他模块引入时只提供 app/start。
if (require.main === module) {
  start();
}

module.exports = { app, start, scheduleCleanup };
