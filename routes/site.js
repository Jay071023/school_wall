const express = require('express');
const https = require('https');
const { pool } = require('../config/database');
const { getChinaDate, toChinaDate } = require('../services/date');

const router = express.Router();
const SITE_URL = (process.env.SITE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const WEATHER_CACHE_MS = 3 * 60 * 1000;
const HISTORY_CACHE_MS = 5 * 60 * 1000;
let weatherCache = null;
let weatherCacheTime = 0;
let weatherRequest = null;
let historyCache = null;
let historyCacheTime = 0;
let historyRequest = null;
const SITE_INFO_CACHE_MS = 15 * 1000;
let siteInfoCache = null;
let siteInfoCacheTime = 0;
let siteInfoRequest = null;

const FESTIVAL_THEMES = new Set(['teachers_day', '520']);

function normalizeFestivalTheme(value) {
  // 旧 back_to_school 只兼容归一化到教师节，不再作为独立前台主题。
  if (value === 'back_to_school') return 'teachers_day';
  return FESTIVAL_THEMES.has(value) ? value : 'teachers_day';
}

function invalidateSiteInfoCache() {
  siteInfoCache = null;
  siteInfoCacheTime = 0;
  siteInfoRequest = null;
}

// 公开的站点设置 API（无需登录）。
router.get('/site-info', async (req, res) => {
  // 站点公开配置不包含用户数据，允许 CDN/浏览器做极短缓存，避免每个页面都查询数据库。
  res.set('Cache-Control', 'public, max-age=5, stale-while-revalidate=30');
  res.set('Vary', 'Accept-Encoding');

  if (siteInfoCache && Date.now() - siteInfoCacheTime < SITE_INFO_CACHE_MS) {
    return res.json(siteInfoCache);
  }

  if (siteInfoRequest) {
    try {
      return res.json(await siteInfoRequest);
    } catch (err) {
      // 共享请求失败时继续走统一兜底，不能让主题配置阻塞页面。
    }
  }

  siteInfoRequest = (async () => {
    const settingKeys = ['site_name', 'site_description', 'anon_post', 'anon_comment', 'anon_song', 'festival_theme', 'festival_enabled', 'special_mode_520'];
    const placeholders = settingKeys.map(() => '?').join(', ');
    const [rows] = await pool.execute(
      `SELECT config_key, config_value FROM settings WHERE config_key IN (${placeholders})`,
      settingKeys
    );
    const settings = {};
    rows.forEach(row => {
      settings[row.config_key] = row.config_value;
    });
    const festivalEnabled = Object.prototype.hasOwnProperty.call(settings, 'festival_enabled')
      ? settings.festival_enabled === 'true'
      : settings.special_mode_520 === 'true';
    const festivalTheme = Object.prototype.hasOwnProperty.call(settings, 'festival_theme')
      ? normalizeFestivalTheme(settings.festival_theme)
      : (settings.special_mode_520 === 'true' ? '520' : 'teachers_day');
    return {
      code: 200,
      data: {
        site_name: settings.site_name || '示例校园墙',
        site_description: settings.site_description || '',
        anon_post: settings.anon_post === 'true',
        anon_comment: settings.anon_comment === 'true',
        anon_song: settings.anon_song === 'true',
        festival_theme: festivalTheme,
        festival_mode: festivalEnabled,
        festival_enabled: festivalEnabled
      }
    };
  })();

  try {
    const payload = await siteInfoRequest;
    siteInfoCache = payload;
    siteInfoCacheTime = Date.now();
    return res.json(payload);
  } catch (err) {
    // 设置表异常时仍返回可渲染的默认配置，避免首页被非核心配置拖垮。
    return res.json({
      code: 200,
      data: {
        site_name: '示例校园墙',
        site_description: '',
        anon_post: false,
        anon_comment: false,
        anon_song: false,
        festival_theme: 'teachers_day',
        festival_mode: false,
        festival_enabled: false
      }
    });
  } finally {
    siteInfoRequest = null;
  }
});

// 公开的用户信息 API（无需登录，用于查看其他用户资料）。
router.get('/profile/:id', async (req, res) => {
  try {
    const [users] = await pool.execute(
      'SELECT id, username, nickname, avatar, role, created_at, gender, mbti, birthday, hobbies FROM users WHERE id = ?',
      [req.params.id]
    );
    if (users.length === 0) {
      return res.json({ code: 404, message: '用户不存在' });
    }
    const user = users[0];
    if (user.birthday) {
      const birthday = String(user.birthday);
      user.birthday = birthday.split('T')[0].split(' ')[0];
    }

    // 保持原有返回结构；这些统计查询彼此独立，并行执行可减少资料页等待时间。
    const count = (sql, params, fallback) => pool.execute(sql, params)
      .then(result => result[0][0].cnt)
      .catch(err => {
        if (fallback !== undefined && err.code === 'ER_NO_SUCH_TABLE') return fallback;
        throw err;
      });
    const [postCount, commentCount, likeCount, favoriteCount, followersCount, followingCount] = await Promise.all([
      count('SELECT COUNT(*) as cnt FROM posts WHERE user_id = ? AND is_deleted = 0 AND status = "approved"', [user.id]),
      count('SELECT COUNT(*) as cnt FROM comments WHERE user_id = ?', [user.id]),
      count('SELECT COUNT(*) as cnt FROM likes l JOIN posts p ON l.post_id = p.id WHERE p.user_id = ? AND p.is_deleted = 0', [user.id]),
      count('SELECT COUNT(*) as cnt FROM favorites WHERE user_id = ?', [user.id]),
      count('SELECT COUNT(*) as cnt FROM follows WHERE following_id = ?', [user.id], 0),
      count('SELECT COUNT(*) as cnt FROM follows WHERE follower_id = ?', [user.id], 0)
    ]);
    user.post_count = postCount;
    user.comment_count = commentCount;
    user.likes_count = likeCount;
    user.favorite_count = favoriteCount;
    user.followers_count = followersCount;
    user.following_count = followingCount;
    res.json({ code: 200, data: user });
  } catch (err) {
    console.error('获取用户信息错误:', err.message);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 历史上的今天 API（第三方失败时使用本地兜底数据）。
router.get('/hotsearch', async (req, res) => {
  res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  res.set('Vary', 'Accept-Encoding');

  const now = Date.now();
  if (historyCache && now - historyCacheTime < HISTORY_CACHE_MS) {
    return res.json(historyCache);
  }

  if (!historyRequest) {
    historyRequest = fetchJson('https://v2.xxapi.cn/api/history', 5000)
      .then(json => {
        if (json.code !== 200 || !Array.isArray(json.data) || json.data.length === 0) {
          throw new Error('历史数据格式错误');
        }
        return { code: 200, data: json.data.map(title => ({ title })) };
      })
      .catch(err => {
        console.error('历史上的今天 API 错误:', err.message);
        return buildFallbackHistory();
      })
      .then(payload => {
        historyCache = payload;
        historyCacheTime = Date.now();
        return payload;
      })
      .finally(() => {
        historyRequest = null;
      });
  }

  return res.json(await historyRequest);
});

function buildFallbackHistory() {
  const today = getChinaDate();
  const month = today.slice(5, 7);
  const day = today.slice(8, 10);
  const events = [
    `2023年${month}月${day}日 中国海军完成苏丹撤侨任务`,
    `2021年${month}月${day}日 中国空间站天和核心舱成功发射`,
    `2008年${month}月${day}日 北京奥运圣火在香港传递`
  ];
  return { code: 200, data: events.map(title => ({ title })) };
}

// 天气 API：短缓存 + 超时 + 上次成功值兜底，避免第三方波动拖慢首页。
router.get('/weather', async (req, res) => {
  const now = Date.now();
  if (weatherCache && now - weatherCacheTime < WEATHER_CACHE_MS) {
    return res.json(weatherCache);
  }
  if (!weatherRequest) {
    const apiUrl = 'https://api.open-meteo.com/v1/forecast?latitude=31.2304&longitude=121.4737&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&timezone=Asia/Shanghai&forecast_days=1';
    weatherRequest = fetchJson(apiUrl, 5000).then(data => {
      if (!data.current) throw new Error('天气数据格式错误');
      const temperature = Number(data.current.temperature_2m);
      const humidity = Number(data.current.relative_humidity_2m);
      const weatherCode = Number(data.current.weather_code);
      const windSpeed = Number(data.current.wind_speed_10m);
      if (![temperature, humidity, weatherCode, windSpeed].every(Number.isFinite)) {
        throw new Error('天气数据格式错误');
      }
      weatherCache = {
        current: {
          temperature_2m: Math.round(temperature),
          relative_humidity_2m: Math.round(humidity),
          weather_code: weatherCode,
          wind_speed_10m: Math.round(windSpeed)
        },
        city: '上海'
      };
      weatherCacheTime = Date.now();
      return weatherCache;
    }).finally(() => {
      weatherRequest = null;
    });
  }
  try {
    return res.json(await weatherRequest);
  } catch (err) {
    if (weatherCache) return res.json(weatherCache);
    res.status(503).json({ error: true, message: '天气服务暂时不可用' });
  }
});

function fetchJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          return reject(new Error(`HTTP ${response.statusCode}`));
        }
        try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
      });
      response.on('error', reject);
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('请求超时')));
    request.once('error', reject);
  });
}

// 获取客户端 IP（用于 IP 归属地查询）。
router.get('/ip', (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] || req.socket?.remoteAddress || req.ip || '';
  res.json({ ip: ip.replace(/^::ffff:/, '').replace(/^::1$/, '127.0.0.1') });
});

// 动态 Sitemap：包含静态页面和已发布帖子。
router.get('/sitemap.xml', async (req, res) => {
  try {
    const staticPages = [
      { loc: `${SITE_URL}/`, priority: 1.0, changefreq: 'daily' },
      { loc: `${SITE_URL}/radio`, priority: 0.9, changefreq: 'daily' },
      { loc: `${SITE_URL}/feedback`, priority: 0.7, changefreq: 'monthly' },
      { loc: `${SITE_URL}/agreement`, priority: 0.6, changefreq: 'monthly' },
      { loc: `${SITE_URL}/privacy`, priority: 0.6, changefreq: 'monthly' }
    ];
    const [posts] = await pool.execute(
      'SELECT id, updated_at FROM posts WHERE status = "approved" AND is_deleted = 0 ORDER BY updated_at DESC, id DESC LIMIT 50000'
    );
    const date = getChinaDate();
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
    staticPages.forEach(page => {
      xml += `  <url>\n    <loc>${escapeXml(page.loc)}</loc>\n    <lastmod>${date}</lastmod>\n    <changefreq>${page.changefreq}</changefreq>\n    <priority>${page.priority}</priority>\n  </url>\n`;
    });
    posts.forEach(post => {
      const mod = toChinaDate(post.updated_at) || date;
      xml += `  <url>\n    <loc>${escapeXml(`${SITE_URL}/post-detail.html?id=${post.id}`)}</loc>\n    <lastmod>${mod}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.8</priority>\n  </url>\n`;
    });
    res.type('application/xml').send(`${xml}</urlset>`);
  } catch (err) {
    console.error('生成 sitemap 失败:', err.message);
    res.status(500).send('Internal Server Error');
  }
});

function escapeXml(value) {
  return String(value).replace(/[<>&'\"]/g, char => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;'
  }[char]));
}

router.invalidateSiteInfoCache = invalidateSiteInfoCache;

module.exports = router;
