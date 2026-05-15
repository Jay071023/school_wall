const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const morgan = require('morgan');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { pool, initDB } = require('./config/database');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== 安全中间件 =====
// 安全HTTP头
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: false
}));

// 全局请求频率限制（每IP每分钟最多100次请求）
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: 429, message: '请求过于频繁，请稍后再试' }
});
app.use(globalLimiter);

// API请求极限流（每IP每分钟最多60次）
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: 429, message: 'API请求过于频繁，请稍后再试' }
});
app.use('/api', apiLimiter);

// 中间件
app.use(cors());
app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// API路由
app.use('/api/auth', require('./routes/auth'));
app.use('/api/posts', require('./routes/posts'));
app.use('/api/songs', require('./routes/songs'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/upload', require('./routes/upload'));

// 前端页面路由
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'register.html'));
});

app.get('/post/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'post-detail.html'));
});

app.get('/new-post', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'new-post.html'));
});

app.get('/profile', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'profile.html'));
});

app.get('/edit-profile', (req, res) => { res.sendFile(path.join(__dirname, 'views', 'edit-profile.html')); });

app.get('/radio', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'radio.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin', 'index.html'));
});

// 404处理
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'views', '404.html'));
});

// 错误处理
app.use((err, req, res, next) => {
  console.error('服务器错误:', err);
  res.status(500).json({ code: 500, message: '服务器内部错误' });
});

// 定时清理操作日志（保留30天）
function scheduleLogCleanup() {
  const CLEANUP_DAYS = 30;
  async function cleanLogs() {
    try {
      const [result] = await pool.execute(
        'DELETE FROM admin_logs WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
        [CLEANUP_DAYS]
      );
      if (result.affectedRows > 0) {
        console.log(`🧹 已清理 ${result.affectedRows} 条过期操作日志（>${CLEANUP_DAYS}天）`);
      }
    } catch (err) {
      console.error('清理日志失败:', err.message);
    }
  }

  // 启动时立即执行一次
  cleanLogs();

  // 每天凌晨3点执行
  const now = new Date();
  const next3am = new Date(now);
  next3am.setHours(3, 0, 0, 0);
  if (now >= next3am) next3am.setDate(next3am.getDate() + 1);
  const delay = next3am - now;

  setTimeout(() => {
    cleanLogs();
    // 之后每24小时执行一次
    setInterval(cleanLogs, 24 * 60 * 60 * 1000);
  }, delay);

  console.log(`⏰ 日志自动清理已启动（每${CLEANUP_DAYS}天清理一次）`);
}

// 启动服务器
async function start() {
  try {
    await initDB();
    app.listen(PORT, process.env.HOST || '0.0.0.0', () => {
      console.log(`
  🎉 嘉二の墙墙网站启动成功！
  📡 访问地址: http://localhost:${PORT}
  🔧 管理后台: http://localhost:${PORT}/admin
  👤 默认管理员: ${process.env.ADMIN_USERNAME || 'admin'} / ${process.env.ADMIN_PASSWORD || 'admin123'}
      `);

      // 定时清理操作日志（每天凌晨3点清理30天前的日志）
      scheduleLogCleanup();
    });
  } catch (err) {
    console.error('启动失败:', err);
    process.exit(1);
  }
}

start();
