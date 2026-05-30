const express = require('express');
const path = require('path');
const https = require('https');
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

const { pool, initDB } = require('./config/database');

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
app.use(compression()); // 响应压缩
// CORS：仅允许指定域名
var allowedOrigins = (process.env.ALLOWED_ORIGINS || 'https://wall.jay23.cn').split(',');
app.use(cors({
  origin: function(origin, callback) {
    // 允许没有 origin 的请求（postman、curl 等）
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    callback(new Error('Not allowed by CORS'));
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
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'https://v1.hitokoto.cn'],
      fontSrc: ["'self'", 'data:'],
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
  max: 500, // 最多500请求
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

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    // CSS/JS 不缓存，开发时每次都是最新的
    if (/\.(css|js|html)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
    // 图片文件缓存 7 天
    if (/\.(jpg|jpeg|png|gif|webp|svg|ico)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=604800');
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
app.use('/api/wechat', require('./routes/wechat'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/mp', require('./routes/mp-draft'));


// 公开的站点设置API（无需登录）
app.get('/api/site-info', async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT config_key, config_value FROM settings');
    const settings = {};
    rows.forEach(row => {
      settings[row.config_key] = row.config_value;
    });
    res.json({
      code: 200,
      data: {
        site_name: settings.site_name || '嘉二の墙墙',
        site_description: settings.site_description || '',
        anon_post: settings.anon_post === 'true',
        anon_comment: settings.anon_comment === 'true',
        anon_song: settings.anon_song === 'true',
        special_mode_520: settings.special_mode_520 === 'true'
      }
    });
  } catch (err) {
    res.json({
      code: 200,
      data: {
        site_name: '嘉二の墙墙',
        site_description: '',
        anon_post: false,
        anon_comment: false,
        anon_song: false
      }
    });
  }
});

// 私信页面路由
app.get('/messages.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'views/messages.html'));
});

// 公开的用户信息API（无需登录，用于查看其他用户资料）
app.get('/api/profile/:id', async (req, res) => {
  try {
    const [users] = await pool.execute(
      'SELECT id, username, nickname, avatar, role, created_at, gender, mbti, birthday, hobbies FROM users WHERE id = ?',
      [req.params.id]
    );
    if (users.length === 0) {
      return res.json({ code: 404, message: '用户不存在' });
    }
    const user = users[0];
    // 格式化生日（避免时区偏移导致日期错误）
    if (user.birthday) {
      var bdStr = String(user.birthday);
      user.birthday = bdStr.split('T')[0].split(' ')[0];
    }
    const [postCount] = await pool.execute(
      'SELECT COUNT(*) as cnt FROM posts WHERE user_id = ? AND is_deleted = 0 AND status = "approved"', [user.id]
    );
    const [commentCount] = await pool.execute(
      'SELECT COUNT(*) as cnt FROM comments WHERE user_id = ?', [user.id]
    );
    const [likeCount] = await pool.execute(
      'SELECT COUNT(*) as cnt FROM likes l JOIN posts p ON l.post_id = p.id WHERE p.user_id = ? AND p.is_deleted = 0', [user.id]
    );
    const [favCount] = await pool.execute(
      'SELECT COUNT(*) as cnt FROM favorites WHERE user_id = ?', [user.id]
    );
    let followersCount = 0, followingCount = 0;
    try {
      const [followers] = await pool.execute('SELECT COUNT(*) as cnt FROM follows WHERE following_id = ?', [user.id]);
      const [following] = await pool.execute('SELECT COUNT(*) as cnt FROM follows WHERE follower_id = ?', [user.id]);
      followersCount = followers[0].cnt;
      followingCount = following[0].cnt;
    } catch (e) { /* follows表可能不存在 */ }
    user.post_count = postCount[0].cnt;
    user.comment_count = commentCount[0].cnt;
    user.likes_count = likeCount[0].cnt;
    user.favorite_count = favCount[0].cnt;
    user.followers_count = followersCount;
    user.following_count = followingCount;
    res.json({ code: 200, data: user });
  } catch (err) {
    console.error('获取用户信息错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 历史上的今天API（调用第三方接口）
app.get('/api/hotsearch', async (req, res) => {
  try {
    const https = require('https');
    const url = 'https://v2.xxapi.cn/api/history';
    const controller = new AbortController();
    const timeout = setTimeout(function() { controller.abort(); }, 5000);

    https.get(url, { signal: controller.signal }, function(apiRes) {
      var data = '';
      apiRes.on('data', function(chunk) { data += chunk; });
      apiRes.on('end', function() {
        clearTimeout(timeout);
        try {
          var json = JSON.parse(data);
          if (json.code === 200 && json.data && json.data.length > 0) {
            res.json({
              code: 200,
              data: json.data.map(function(e) { return { title: e }; })
            });
          } else {
            getFallbackHistory(res);
          }
        } catch (e) {
          getFallbackHistory(res);
        }
      });
    }).on('error', function() {
      clearTimeout(timeout);
      getFallbackHistory(res);
    });
  } catch (err) {
    console.error('历史上的今天API错误:', err);
    getFallbackHistory(res);
  }
});

/** 历史上的今天 - 本地兜底数据 */
function getFallbackHistory(res) {
  var today = new Date();
  var month = String(today.getMonth() + 1).padStart(2, '0');
  var day = String(today.getDate()).padStart(2, '0');
  var events = [
    '2023年' + month + '月' + day + '日 中国海军完成苏丹撤侨任务',
    '2021年' + month + '月' + day + '日 中国空间站天和核心舱成功发射',
    '2008年' + month + '月' + day + '日 北京奥运圣火在香港传递'
  ];
  res.json({
    code: 200,
    data: events.map(function(e) { return { title: e }; })
  });
}

// 天气API缓存（5分钟更新一次）
let weatherCache = null;
let weatherCacheTime = 0;
const WEATHER_CACHE_MINUTES = 5;

app.get('/api/weather', async (req, res) => {
  try {
    const cityName = '上海';
    const now = Date.now();
    
    // 检查缓存（3分钟更新一次）
    if (weatherCache && (now - weatherCacheTime) < 3 * 60 * 1000) {
      return res.json(weatherCache);
    }
    
    // 使用 Open-Meteo API（免费、稳定、无需API密钥）
    const apiUrl = 'https://api.open-meteo.com/v1/forecast?latitude=31.2304&longitude=121.4737&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&timezone=Asia/Shanghai&forecast_days=1';
    
    const data = await new Promise((resolve, reject) => {
      https.get(apiUrl, (apiRes) => {
        let body = '';
        apiRes.on('data', chunk => body += chunk);
        apiRes.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
        apiRes.on('error', reject);
      }).on('error', reject);
    });
    
    if (data.current) {
      weatherCache = {
        current: {
          temperature_2m: Math.round(data.current.temperature_2m),
          relative_humidity_2m: Math.round(data.current.relative_humidity_2m),
          weather_code: data.current.weather_code,
          wind_speed_10m: Math.round(data.current.wind_speed_10m)
        },
        city: cityName
      };
      weatherCacheTime = now;
      
      return res.json(weatherCache);
    } else {
      throw new Error('数据格式错误');
    }
  } catch (err) {
    // 如果有缓存，返回缓存
    if (weatherCache) {
      return res.json(weatherCache);
    }
    
    // 没有缓存时返回错误
    res.status(503).json({
      error: true,
      message: '天气服务暂时不可用'
    });
  }
});

// 获取客户端IP（用于IP归属地查询）
app.get('/api/ip', (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
             req.headers['x-real-ip'] ||
             req.socket?.remoteAddress ||
             req.ip ||
             '';
  // 清理IPv6格式的本地地址
  const cleanIP = ip.replace(/^::ffff:/, '').replace(/^::1$/, '127.0.0.1');
  res.json({ ip: cleanIP });
});

// 前端页面路由
app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'register.html'));
});

app.get('/post/:id', (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'views', 'post-detail.html'));
});

// 禁止HTML缓存中间件
function noCache(req, res, next) {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  next();
}

app.get('/new-post', noCache, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'new-post.html'));
});

app.get('/edit-post/:id', noCache, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'edit-post.html'));
});

app.get('/profile', noCache, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'profile.html'));
});

app.get('/edit-profile', noCache, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'edit-profile.html'));
});

app.get('/radio', noCache, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'radio.html'));
});

app.get('/feedback', noCache, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'feedback.html'));
});

app.get('/agreement', noCache, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'agreement.html'));
});

app.get('/privacy', noCache, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'privacy.html'));
});

// 管理后台（HTML版本）
app.get('/admin', (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate, private, max-age=0');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.sendFile(path.join(__dirname, 'views', 'admin', 'index.html'));
});

// 公众号推送管理
app.get('/admin/mp-draft', (req, res) => {
  if (!req.query.v) {
    var stat = fs.statSync(path.join(__dirname, 'views', 'admin', 'mp-draft.html'));
    return res.redirect(302, '/admin/mp-draft?v=' + stat.mtimeMs);
  }
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate, private, max-age=0');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.sendFile(path.join(__dirname, 'views', 'admin', 'mp-draft.html'));
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
