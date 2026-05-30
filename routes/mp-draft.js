/**
 * 公众号素材管理路由
 * 提供热点采集、草稿创建、素材管理等功能
 * 包含天气、一言、精美卡片样式
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const mpDraftService = require('../services/mp-draft');
const { auth, isStaff } = require('../middleware/auth');
// 站点域名（用于补齐相对路径的图片URL）
const SITE_URL = 'https://wall.jay23.cn';

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// 所有公众号素材管理路由都需要登录且是管理后台用户
router.use(auth, isStaff);

/**
 * 获取今日热点帖子
 * GET /api/mp/hot-posts
 */
router.get('/hot-posts', async (req, res) => {
  try {
    let hours = parseInt(req.query.hours);
    if (isNaN(hours)) hours = 24;
    const limit = parseInt(req.query.limit) || 10;

    // hours=0 表示全站精华
    let timeCondition = '';
    let params = [limit];
    if (hours > 0) {
      timeCondition = 'AND p.created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)';
      params.unshift(hours);
    }

    const [posts] = await pool.execute(`
      SELECT 
        p.id, p.title, p.content, p.created_at, p.likes_count,
        p.views as view_count,
        u.username as author,
        COUNT(DISTINCT c.id) as comment_count,
        p.images
      FROM posts p
      LEFT JOIN users u ON p.user_id = u.id
      LEFT JOIN comments c ON c.post_id = p.id
      WHERE p.status = 'approved'
        ${timeCondition}
      GROUP BY p.id
      ORDER BY (p.likes_count * 2 + COUNT(DISTINCT c.id) * 3) DESC
      LIMIT ?
    `, params);

    res.json({
      code: 200,
      data: posts,
      message: hours > 0 ? `获取最近${hours}小时的${posts.length}条热门帖子` : `获取全站${posts.length}条精华帖`
    });
  } catch (err) {
    console.error('[MP素材] 获取热点帖子失败:', err.message);
    res.json({ code: 500, message: '获取失败: ' + err.message });
  }
});

/**
 * 获取每周之星（本周最活跃用户）
 * GET /api/mp/weekly-star
 */
router.get('/weekly-star', async (req, res) => {
  try {
    const period = req.query.period || 'week'; // week 或 month
    
    let interval = 'INTERVAL 7 DAY';
    let label = '本周';
    if (period === 'month') {
      interval = 'INTERVAL 30 DAY';
      label = '本月';
    }
    
    const [users] = await pool.execute(`
      SELECT 
        u.id, u.nickname, u.username, u.avatar,
        COUNT(DISTINCT p.id) as post_count,
        COUNT(DISTINCT c.id) as comment_count,
        (COALESCE(SUM(p.likes_count), 0) + COALESCE(SUM(p.comments_count), 0)) as contribution_score
      FROM users u
      LEFT JOIN posts p ON p.user_id = u.id AND p.status = 'approved' AND p.created_at >= DATE_SUB(NOW(), ${interval})
      LEFT JOIN comments c ON c.user_id = u.id AND c.created_at >= DATE_SUB(NOW(), ${interval})
      WHERE u.role = 'user'
      GROUP BY u.id
      ORDER BY contribution_score DESC
      LIMIT 5
    `);
    
    res.json({
      code: 200,
      data: users,
      message: label + '活跃用户TOP5'
    });
  } catch (err) {
    console.error('[MP素材] 获取每周之星失败:', err.message);
    res.json({ code: 500, message: '获取失败: ' + err.message });
  }
});

/**
 * 获取那年今日的帖子（同月同日的历史帖子）
 * GET /api/mp/today-history-posts
 */
router.get('/today-history-posts', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 5;
    
    const [posts] = await pool.execute(`
      SELECT 
        p.id, p.title, p.content, p.created_at, p.likes_count,
        p.views as view_count,
        u.username as author,
        YEAR(p.created_at) as post_year,
        COUNT(DISTINCT c.id) as comment_count,
        p.images
      FROM posts p
      LEFT JOIN users u ON p.user_id = u.id
      LEFT JOIN comments c ON c.post_id = p.id
      WHERE p.status = 'approved'
        AND MONTH(p.created_at) = MONTH(CURDATE())
        AND DAY(p.created_at) = DAY(CURDATE())
        AND YEAR(p.created_at) < YEAR(CURDATE())
      GROUP BY p.id
      ORDER BY p.likes_count DESC, p.created_at DESC
      LIMIT ?
    `, [limit]);
    
    res.json({
      code: 200,
      data: posts,
      message: `找到 ${posts.length} 条历史同日帖子`
    });
  } catch (err) {
    console.error('[MP素材] 获取历史同日帖子失败:', err.message);
    res.json({ code: 500, message: '获取失败: ' + err.message });
  }
});

/**
 * 获取辅助信息（天气、一言、日期）
 * GET /api/mp/extra-info
 */
router.get('/extra-info', async (req, res) => {
  try {
    const [weather, hitokoto, dateInfo] = await Promise.all([
      mpDraftService.getWeather(),
      mpDraftService.getHitokoto(),
      Promise.resolve(mpDraftService.getDateInfo())
    ]);

    res.json({
      code: 200,
      data: { weather, hitokoto, dateInfo },
      message: '获取成功'
    });
  } catch (err) {
    console.error('[MP素材] 获取辅助信息失败:', err.message);
    res.json({ code: 500, message: '获取失败: ' + err.message });
  }
});

/**
 * 上传帖子中的图片到微信CDN
 * 微信外部图片会被屏蔽，必须换成微信自己的CDN链接
 */
async function uploadImagesToWeixin(htmlContent) {
  // 提取所有img标签的src
  var imgRegex = /<img[^>]+src=["']([^"']+)["']/g;
  var match;
  var tasks = [];
  while ((match = imgRegex.exec(htmlContent)) !== null) {
    var originalSrc = match[1];
    if (originalSrc.indexOf('mmbiz.qpic.cn') >= 0 || originalSrc.indexOf('mmbiz.qlogo.cn') >= 0 || originalSrc.startsWith('data:')) continue;
    var uploadUrl = originalSrc;
    if (uploadUrl.startsWith('/')) uploadUrl = SITE_URL + uploadUrl;
    tasks.push({ original: originalSrc, upload: uploadUrl });
  }
  if (tasks.length === 0) return htmlContent;

  console.log('[MP图片] 发现 ' + tasks.length + ' 张图片');
  for (var i = 0; i < tasks.length; i++) {
    try {
      var weixinUrl = await mpDraftService.uploadMpImage(tasks[i].upload);
      if (weixinUrl) {
        htmlContent = htmlContent.split(tasks[i].original).join(weixinUrl);
        console.log('[MP图片] 第' + (i+1) + '张成功 ' + tasks[i].original.substring(0, 50) + ' -> 微信CDN');
      }
    } catch (e) {
      console.warn('[MP图片] 第' + (i+1) + '张失败:', e.message);
    }
  }
  return htmlContent;
}

/**
 * 自动分段落：将一大段文字按语义拆分成排版优美的段落
 * 1. 优先按双换行（用户手动分段）
 * 2. 其次按单换行
 * 3. 最后按句号/感叹号/问号等句末标点分组，每2-3句一段
 */
function autoFormatContent(text) {
  if (!text) return '';
  var blocks = [];

  // 尝试双换行分段
  var byDoubleNewline = text.split(/\n\s*\n/);
  if (byDoubleNewline.length > 1) {
    blocks = byDoubleNewline;
  } else {
    // 尝试单换行分段
    var byNewline = text.split(/\n/);
    if (byNewline.length > 1) {
      blocks = byNewline;
    } else {
      // 无换行，按标点分组（每2-3句一段）
      // 使用捕获组兼容 Node.js 16
      var raw = text;
      var sentences = [];
      var buffer = '';
      for (var k = 0; k < raw.length; k++) {
        buffer += raw[k];
        if (/[。！？；;!?]/.test(raw[k])) {
          sentences.push(buffer);
          buffer = '';
        }
      }
      if (buffer.trim()) sentences.push(buffer);
      if (sentences.length === 0) sentences = [text];

      for (var g = 0; g < sentences.length; g += 3) {
        blocks.push(sentences.slice(g, g + 3).join(''));
      }
    }
  }

  return blocks.filter(function(b) { return b.trim(); }).map(function(b) {
    return '<p style="text-indent:2em;line-height:2.1;margin-bottom:14px;font-size:15px;color:#444;margin-top:0;letter-spacing:0.5px;">' + b.trim() + '</p>';
  }).join('\n');
}

/**
 * 生成精美卡片HTML（卡哇伊风，兼容微信编辑器）
 */
function generateCardHTML(posts, weather, hitokoto, dateInfo, stats, categories, songs, todayHistory, weeklyStar, commentsByPost, includeGaokao, dailySongs) {
  const today = dateInfo.date;
  const week = dateInfo.week;

  var html = '';
  html += '<div style="padding:6px 0;">';

  // ===== 头部 =====
  html += '<table width="100%" cellpadding="0" cellspacing="0"><tr><td style="background:linear-gradient(135deg,#FFF0F5,#F8F0FF);padding:22px 16px 18px;text-align:center;">';
  html += '<div style="color:#A78BFA;font-size:13px;margin-bottom:6px;letter-spacing:2px;">📖 今日校园精选</div>';
  html += '<div style="color:#FF69B4;font-size:22px;font-weight:bold;letter-spacing:1px;">🌸 今日校园精选</div>';
  html += '<div style="color:#bbb;font-size:12px;margin-top:8px;">' + today + ' ' + week + '</div>';
  html += '<div style="width:40px;height:3px;background:linear-gradient(90deg,#FFB6C1,#A78BFA);margin:14px auto 0;"></div>';
  html += '</td></tr></table>';

  // ===== 阅读信息 =====
  var totalChars = 0;
  for (var pc = 0; pc < posts.length; pc++) {
    totalChars += (posts[pc].content || '').replace(/\s/g, '').length;
  }
  var readMinutes = Math.max(1, Math.ceil(totalChars / 300));
  html += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;"><tr><td style="background:#FFFFF0;padding:12px;border-radius:10px;">';
  html += '<table width="100%" cellpadding="0" cellspacing="0"><tr>';
  html += '<td style="text-align:center;width:50%;padding:4px;border-right:1px dashed #E8D5B5;">';
  html += '<div style="font-size:11px;color:#bbb;margin-bottom:2px;">📝 全文字数</div>';
  html += '<div style="font-size:16px;font-weight:bold;color:#D4876A;">' + totalChars.toLocaleString() + ' 字</div>';
  html += '</td>';
  html += '<td style="text-align:center;width:50%;padding:4px;">';
  html += '<div style="font-size:11px;color:#bbb;margin-bottom:2px;">⏱ 阅读时长</div>';
  html += '<div style="font-size:16px;font-weight:bold;color:#D4876A;">约 ' + readMinutes + ' 分钟</div>';
  html += '</td>';
  html += '</tr></table></td></tr></table>';

  // ===== 天气卡片 =====
  if (weather && weather.temperature) {
    html += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;"><tr><td style="background:linear-gradient(135deg,#E8F4FD,#E0F0FF);padding:16px;">';
    html += '<div style="font-size:13px;color:#888;margin-bottom:10px;font-weight:500;">🌤️ ' + (weather.city || '') + ' 天气预报</div>';
    html += '<table width="100%" cellpadding="0" cellspacing="0"><tr>';
    html += '<td style="width:50%;text-align:center;padding:4px;border-right:1px dashed #B0D4F1;">';
    html += '<div style="font-size:11px;color:#aaa;margin-bottom:4px;">今日</div>';
    html += '<div style="font-size:20px;font-weight:bold;color:#4A90D9;">' + (weather.icon || '🌤') + ' ' + (weather.temperature || '') + '</div>';
    html += '<div style="font-size:12px;color:#666;margin-top:2px;">' + (weather.weather || '') + '</div>';
    html += '<div style="font-size:11px;color:#999;margin-top:4px;">💨 ' + (weather.wind || '') + ' 💧 ' + (weather.humidity || '') + '</div>';
    html += '</td>';
    if (weather.tomorrow) {
      html += '<td style="width:50%;text-align:center;padding:4px;">';
      html += '<div style="font-size:11px;color:#aaa;margin-bottom:4px;">' + (weather.tomorrow.week || '周五') + '</div>';
      html += '<div style="font-size:20px;font-weight:bold;color:#4A90D9;">' + (weather.tomorrow.icon || '☀️') + ' ' + (weather.tomorrow.tempRange || '') + '</div>';
      html += '<div style="font-size:12px;color:#666;margin-top:2px;">' + (weather.tomorrow.weather || '') + '</div>';
      html += '<div style="font-size:11px;color:#999;margin-top:4px;">📍 预报</div>';
      html += '</td>';
    } else {
      html += '<td style="width:50%;text-align:center;padding:4px;color:#ccc;font-size:13px;">🌤️ 暂无预报</td>';
    }
    html += '</tr></table>';
    html += '</td></tr></table>';
  }

  // ===== 一言卡片 =====
  if (hitokoto && hitokoto.text) {
    html += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;"><tr><td style="background:#FFF9F5;padding:16px;border-left:3px solid #A78BFA;">';
    html += '<p style="font-size:14px;color:#888;margin:0 0 6px 0;line-height:1.8;font-style:italic;">💬 "' + escapeHtml(hitokoto.text) + '"</p>';
    html += '<p style="text-align:right;color:#ccc;font-size:12px;margin:0;">—— ' + escapeHtml(hitokoto.from_who || hitokoto.from || '') + '</p>';
    html += '</td></tr></table>';
  }

  // ===== 高考倒计时卡片 =====
  console.log('DEBUG includeGaokao:', includeGaokao, typeof includeGaokao);
  if (includeGaokao === true) {
    var gaokaoDate = new Date();
    gaokaoDate.setMonth(5); // 6月
    gaokaoDate.setDate(7);
    gaokaoDate.setHours(9, 0, 0);
    if (gaokaoDate < new Date()) {
      gaokaoDate.setFullYear(gaokaoDate.getFullYear() + 1);
    }
    var gaokaoDiff = Math.ceil((gaokaoDate - new Date()) / (1000 * 60 * 60 * 24));
    var gaokaoPercent = Math.round((365 - gaokaoDiff) / 365 * 100);
    html += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;"><tr><td style="background:linear-gradient(135deg,#FFF8E1,#FFE4B5);padding:16px;">';
    html += '<table width="100%" cellpadding="0" cellspacing="0"><tr>';
    html += '<td style="text-align:center;padding:4px;border-right:1px dashed #E8D5B5;">';
    html += '<div style="font-size:11px;color:#888;margin-bottom:4px;">📚 距离高考</div>';
    html += '<div style="font-size:24px;font-weight:bold;color:#FF8C00;">' + gaokaoDiff + '</div>';
    html += '<div style="font-size:12px;color:#666;">天</div>';
    html += '</td>';
    html += '<td style="text-align:center;padding:4px;">';
    html += '<div style="font-size:11px;color:#888;margin-bottom:4px;">⏳ 进度</div>';
    html += '<div style="font-size:20px;font-weight:bold;color:#FF8C00;">' + gaokaoPercent + '%</div>';
    html += '<div style="font-size:12px;color:#666;">已完成</div>';
    html += '</td>';
    html += '</tr></table>';
    html += '</td></tr></table>';
  }

  // ===== 数据统计 =====
  if (stats && stats.total > 0) {
    html += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;"><tr><td style="background:#F0FFF0;padding:14px;text-align:center;">';
    html += '<div style="font-size:14px;color:#666;line-height:1.6;">📊 今日校园 · 共 <strong style="color:#43e97b;font-size:18px;">' + stats.total + '</strong> 篇新帖子</div>';
    html += '</td></tr></table>';
  }

  // ===== 热门分类 =====
  if (categories && categories.length > 0) {
    var catNames = { 'daily':'日常', 'confession':'表白', 'help':'求助', 'secondhand':'二手', 'club':'社团', 'other':'其他' };
    var catEmoji = { '日常':'🌸', '表白':'💕', '求助':'🆘', '二手':'🛍️', '社团':'🎪', '其他':'📌' };
    html += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;"><tr><td style="background:#FFFFF0;padding:12px 14px;">';
    html += '<div style="font-size:13px;color:#999;margin-bottom:6px;">🏷️ 热门分类</div>';
    html += '<div style="font-size:14px;color:#666;line-height:1.8;">';
    for (var ci = 0; ci < categories.length; ci++) {
      var cat = categories[ci];
      var cName = catNames[cat.category] || cat.category;
      html += (ci > 0 ? '&nbsp;&nbsp;&nbsp;·&nbsp;&nbsp;&nbsp;' : '') + (catEmoji[cName] || '📌') + ' ' + cName + ' <strong style="color:#FFB6C1;font-size:14px;">' + cat.cnt + '</strong>';
    }
    html += '</div></td></tr></table>';
  }

  // ===== 历史的今天 =====
  if (todayHistory && todayHistory.title) {
    var htParts = (todayHistory.title || '').split(' ');
    var datePart = htParts.length > 1 ? htParts[0] : '';
    var eventPart = htParts.length > 1 ? htParts.slice(1).join(' ') : todayHistory.title;
    html += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;"><tr><td style="background:#F8F0FF;padding:12px 14px;">';
    html += '<div style="font-size:13px;color:#999;margin-bottom:5px;">📜 历史上的今天</div>';
    html += '<div style="font-size:14px;color:#666;line-height:1.7;">' + (datePart ? '<span class="history-date">' + escapeHtml(datePart) + '</span> ' : '') + '<span class="history-event">' + escapeHtml(eventPart) + '</span></div>';
    html += '</td></tr></table>';
  }

  // ===== 点歌卡片 =====
  if (songs && songs.length > 0) {
    html += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;"><tr><td style="background:#FFF0F5;padding:12px 14px;">';
    html += '<div style="font-size:13px;color:#999;margin-bottom:6px;">🎵 最近点歌</div>';
    for (var si = 0; si < songs.length; si++) {
      var s = songs[si];
      var authorStr = s.is_anonymous ? '匿名同学' : (s.nickname || s.username || '同学');
      html += '<div style="border-top:' + (si > 0 ? '1px dashed #FFD1DC;' : 'none;') + ';padding:8px 0;">';
      html += '<div style="font-size:14px;color:#555;line-height:1.6;">🎶 <strong>' + (s.song_name || '') + '</strong>' + (s.artist ? ' - <span style="color:#aaa;">' + s.artist + '</span>' : '') + '</div>';
      html += '<div style="font-size:12px;color:#bbb;margin-top:3px;line-height:1.5;">';
      if (s.slot_name || s.play_date || s.req_date) html += '📅 ' + (s.slot_name || '') + ((s.play_date || s.req_date) ? ' · ' + (s.play_date || s.req_date) : '') + (s.start_time && s.end_time ? ' ' + s.start_time.substring(0,5) + '-' + s.end_time.substring(0,5) : '');
      if (s.message) html += ' &nbsp;💬 ' + s.message; // 不再截断点歌留言
      if (s.to_whom) html += ' &nbsp;💝 ' + s.to_whom;
      html += ' &nbsp;👤 ' + authorStr;
      html += '</div>';
      html += '</div>';
    }
    html += '</td></tr></table>';
  }

  // ===== 每周之星 =====
  if (weeklyStar && weeklyStar.length > 0) {
    var medals = ['🥇', '🥈', '🥉'];
    html += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;"><tr><td style="background:#FFF9F9;padding:14px 14px 18px;">';
    html += '<div style="font-size:13px;color:#999;margin-bottom:10px;">⭐ 每周之星</div>';
    html += '<table width="100%" cellpadding="0" cellspacing="0"><tr>';
    for (var wi = 0; wi < weeklyStar.length; wi++) {
      var w = weeklyStar[wi];
      var wName = w.nickname || w.username || '同学';
      html += '<td style="text-align:center;width:' + (100 / weeklyStar.length) + '%;padding:4px;">';
      html += '<div style="font-size:20px;">' + (medals[wi] || '🏅') + '</div>';
      html += '<div style="font-weight:600;font-size:13px;color:#555;margin-top:4px;">' + escapeHtml(wName) + '</div>';
      html += '<div style="font-size:11px;color:#bbb;margin-top:2px;">📝' + (w.post_count || 0) + ' 💬' + (w.comment_count || 0) + '</div>';
      html += '</td>';
    }
    html += '</tr></table></td></tr></table>';
  }

  // ===== 每日推歌卡片 =====
  if (dailySongs && dailySongs.length > 0) {
    html += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;"><tr><td style="background:#FFF0F5;padding:14px;">';
    html += '<div style="font-size:13px;color:#999;margin-bottom:10px;">🎵 每日推歌</div>';
    for (var si = 0; si < dailySongs.length; si++) {
      var s = dailySongs[si];
      html += '<div style="border-top:' + (si > 0 ? '1px dashed #FFD1DC;' : 'none;') + ';padding:10px 0;">';
      html += '<div style="font-size:15px;color:#555;line-height:1.6;">🎶 <strong>' + escapeHtml(s.song_name || '') + '</strong>' + (s.artist ? ' - <span style="color:#aaa;">' + escapeHtml(s.artist) + '</span>' : '') + '</div>';
      html += '<div style="font-size:12px;color:#bbb;margin-top:4px;line-height:1.5;">';
      if (s.to_whom) html += '💝 送给 ' + escapeHtml(s.to_whom) + ' &nbsp;';
      if (s.message) html += '💬 ' + escapeHtml(s.message) + ' &nbsp;';
      html += '👤 ' + escapeHtml(s.submitter || '同学');
      html += '</div>';
      if (s.intro) {
        html += '<div style="font-size:12px;color:#888;margin-top:6px;padding:8px 10px;background:#FFF9F5;border-radius:8px;border-left:3px solid #FFB7C5;line-height:1.5;">';
        html += '📖 ' + escapeHtml(s.intro);
        html += '</div>';
      }
      html += '</div>';
    }
    html += '</td></tr></table>';
  }

  // ===== 分割线 =====
  html += '<div style="text-align:center;margin:18px 0;color:#e8e8e8;font-size:14px;">❀&nbsp;&nbsp;❁&nbsp;&nbsp;❀</div>';

  // ===== 帖子卡片 =====
  posts.forEach((p, i) => {
    var colors = ['#FFB6C1','#DDA0DD','#87CEEB','#98FB98','#FFD700'];
    var bgColors = ['#FFF0F5','#F8F0FF','#F0F8FF','#F0FFF0','#FFFFF0'];
    var c = colors[i % colors.length];
    var bg = bgColors[i % bgColors.length];
    var allImgs = [];
    try { if (p.images) { var parsed = JSON.parse(p.images); if (Array.isArray(parsed)) allImgs = parsed; } } catch(e) {}
    var coverImgs = '';
    for (var ii = 0; ii < allImgs.length; ii++) {
      coverImgs += (ii > 0 ? '<div style="border-top:1px dashed #eee;margin:8px 0;"></div>' : '') + '<img src="' + allImgs[ii] + '" style="width:100%;" alt="封面">';
    }
    var safeTitle = (p.title || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    var content = (p.content || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); // 不再截断，显示完整内容

    html += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:18px;"><tr><td style="border-top:3px solid ' + c + ';background:' + bg + ';padding:16px;">';
    html += '<div style="color:' + c + ';font-weight:bold;font-size:13px;margin-bottom:6px;">#' + (i+1) + ' · 热门帖子</div>';
    html += '<div style="font-weight:bold;font-size:18px;color:#333;margin-bottom:8px;line-height:1.4;">' + safeTitle + '</div>';
    html += coverImgs;
    html += '<div style="margin:12px 0 0 0;">' + autoFormatContent(content) + '</div>';
    html += '<div style="font-size:13px;color:#bbb;margin-top:12px;padding-top:10px;border-top:1px solid #eee;line-height:1.6;">';
    html += '👤 ' + (p.author || '匿名同学') + '&nbsp;&nbsp;&nbsp;❤️ ' + (p.likes_count || 0) + '&nbsp;&nbsp;&nbsp;💬 ' + (p.comment_count || 0) + '</div>';
    // 展示评论
    if (commentsByPost && commentsByPost[p.id] && commentsByPost[p.id].length > 0) {
      html += '<div style="margin-top:10px;">';
      commentsByPost[p.id].forEach(function(comment) {
        var commAuthor = comment.author || '同学';
        var commContent = comment.content || '';
        var safeCommAuthor = (commAuthor).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        var safeCommText = (commContent).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        html += '<div style="background:#f9f9f9;border-radius:8px;padding:8px 12px;margin-top:6px;font-size:13px;">';
        html += '<span style="color:#667eea;font-weight:600;">' + safeCommAuthor + '</span>';
        html += '<span style="color:#999;">: </span>';
        html += '<span style="color:#555;">' + safeCommText + '</span>';
        html += '</div>';
      });
      html += '</div>';
    }
    html += '</td></tr></table>';
  });

  // ===== 尾部 =====
  html += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;"><tr><td style="background:linear-gradient(135deg,#FFF0F5,#FFE4E1);padding:24px 20px;text-align:center;border-radius:16px;">';
  html += '<div style="font-size:18px;color:#FF69B4;font-weight:bold;margin-bottom:6px;">🌸 校园故事站</div>';
  html += '<div style="font-size:13px;color:#DDA0DD;margin-bottom:16px;">扫码关注 · 分享身边的美好</div>';
  html += '<table align="center" style="margin:0 auto;"><tr><td style="background:linear-gradient(135deg,#FF69B4,#FFB6C1);padding:4px;border-radius:16px;">';
  html += '<table style="width:100%;background:#fff;border-radius:12px;"><tr><td style="padding:12px;">';
  html += '<img src="https://wall.jay23.cn/images/gzh.jpg" style="width:200px;display:block;border-radius:6px;margin:0 auto;height:auto;" alt="校园墙二维码">';
  html += '</td></tr></table>';
  html += '</td></tr></table>';
  html += '<p style="color:#bbb;font-size:12px;margin:14px 0 4px 0;letter-spacing:1px;">📱 微信扫一扫 · 获取更多精彩</p>';
  html += '<p style="color:#FF69B4;font-size:13px;font-weight:bold;word-break:break-all;letter-spacing:0.5px;">https://wall.jay23.cn</p>';
  html += '<div style="width:40px;height:2px;background:#FFB6C1;margin:12px auto 0;border-radius:2px;"></div>';
  html += '</td></tr></table>';
  html += '<p style="text-align:center;color:#ddd;font-size:12px;margin-top:18px;">❀ ' + dateInfo.year + ' 嘉二校园墙 ❀ ❀</p>';
  html += '</div>';

  return html;
}

/**
 * 生成图文素材内容（增强版）
 * POST /api/mp/generate-content
 */
router.post('/generate-content', async (req, res) => {
  try {
    const { postIds, template = 'daily-summary', includeWeather = true, includeHitokoto = true, includeWeeklyStar = true, includeGaokao = true, weeklyStarUserIds = [] } = req.body;

    if (!postIds || !Array.isArray(postIds)) {
      return res.json({ code: 400, message: '请提供帖子ID列表' });
    }

    // 并行获取帖子和辅助信息
    let postsQuery;
    if (postIds.length > 0) {
      const postIdsStr = postIds.join(',');
      postsQuery = pool.execute(`
        SELECT 
          p.id, p.title, p.content, p.created_at, p.likes_count,
          p.views as view_count,
          u.username as author,
          COUNT(DISTINCT c.id) as comment_count,
          p.images
        FROM posts p
        LEFT JOIN users u ON p.user_id = u.id
        LEFT JOIN comments c ON c.post_id = p.id
        WHERE FIND_IN_SET(p.id, ?)
        GROUP BY p.id
        ORDER BY FIELD(p.id, ?)
      `, [postIdsStr, postIdsStr]);
    } else {
      postsQuery = Promise.resolve([[]]);
    }
    const [postsResult, weather, hitokoto, dateInfo, statsResult, catResult, todayHistory, weeklyStarResult, commentsResult] = await Promise.all([
      postsQuery,
      includeWeather ? mpDraftService.getWeather() : Promise.resolve(null),
      includeHitokoto ? mpDraftService.getHitokoto() : Promise.resolve(null),
      Promise.resolve(mpDraftService.getDateInfo()),
      // 数据统计
      pool.execute("SELECT COUNT(*) as total FROM posts WHERE status='approved' AND DATE(created_at)=CURDATE()").then(r => r[0][0]),
      // 热门分类
      pool.execute("SELECT category, COUNT(*) as cnt FROM posts WHERE status='approved' GROUP BY category ORDER BY cnt DESC LIMIT 3").then(r => r[0]),
      // 历史上的今天
      mpDraftService.getTodayInHistory(),
      // 每周之星
      (async function() {
        if (!includeWeeklyStar) return [];
        if (weeklyStarUserIds.length > 0) {
          const placeholders = weeklyStarUserIds.map(() => '?').join(',');
          const [rows] = await pool.execute(`
            SELECT u.id, u.nickname, u.username,
              COUNT(DISTINCT p.id) as post_count,
              COUNT(DISTINCT c.id) as comment_count,
              (COALESCE(SUM(p.likes_count), 0) + COALESCE(SUM(p.comments_count), 0)) as contribution_score
            FROM users u
            LEFT JOIN posts p ON p.user_id = u.id AND p.status = 'approved' AND p.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
            LEFT JOIN comments c ON c.user_id = u.id AND c.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
            WHERE u.role = 'user' AND u.id IN (${placeholders})
            GROUP BY u.id
            ORDER BY contribution_score DESC
          `, weeklyStarUserIds);
          return rows;
        }
        const [rows] = await pool.execute(`
          SELECT u.id, u.nickname, u.username,
            COUNT(DISTINCT p.id) as post_count,
            COUNT(DISTINCT c.id) as comment_count,
            (COALESCE(SUM(p.likes_count), 0) + COALESCE(SUM(p.comments_count), 0)) as contribution_score
          FROM users u
          LEFT JOIN posts p ON p.user_id = u.id AND p.status = 'approved' AND p.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
          LEFT JOIN comments c ON c.user_id = u.id AND c.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
          WHERE u.role = 'user'
          GROUP BY u.id
          ORDER BY contribution_score DESC
          LIMIT 3
        `);
        return rows;
      })(),
      // 帖子评论
      (async function() {
        if (postIds.length === 0) return {};
        const idsStr = postIds.join(',');
        const [rows] = await pool.execute(`
          SELECT c.post_id, c.content, c.created_at, u.username as author
          FROM comments c
          LEFT JOIN users u ON c.user_id = u.id
          WHERE FIND_IN_SET(c.post_id, ?)
          ORDER BY c.created_at ASC
          LIMIT 50
        `, [idsStr]);
        // 按 post_id 分组
        var grouped = {};
        rows.forEach(function(r) {
          if (!grouped[r.post_id]) grouped[r.post_id] = [];
          grouped[r.post_id].push(r);
        });
        return grouped;
      })(),
    ]);

    const posts = postsResult[0];
    const stats = statsResult || {};
    const categories = catResult || [];
    const weeklyStar = weeklyStarResult || [];
    const commentsByPost = commentsResult || {};

    if (posts.length === 0) {
      return res.json({ code: 404, message: '未找到帖子' });
    }

    // 获取点歌数据
    var songReq = [];
    try {
      songReq = await pool.execute("SELECT sr.song_name, sr.artist, sr.message, sr.to_whom, sr.is_anonymous, u.username, u.nickname, ts.name as slot_name, ts.start_time, ts.end_time, DATE_FORMAT(sd.play_date,'%m/%d') as play_date, DATE_FORMAT(sd.play_date,'%Y年%m月%d日') as play_date_full, sr.created_at, DATE_FORMAT(sr.created_at,'%m/%d') as req_date FROM song_requests sr LEFT JOIN time_slots ts ON sr.slot_id=ts.id LEFT JOIN slot_dates sd ON sr.slot_date_id=sd.id LEFT JOIN users u ON sr.user_id=u.id WHERE sr.status='approved' ORDER BY sr.created_at DESC LIMIT 3").then(r => r[0]);
    } catch(e) {}

    // 生成图文内容
    const articles = [];

    if (template === 'daily-summary') {
      // 使用用户选择的推歌，或获取所有已发布推歌
      var dailySongs = req.body.dailySongs || [];
      if (dailySongs.length === 0) {
        try {
          dailySongs = await pool.execute(
            'SELECT * FROM daily_song_recs WHERE status = "published" ORDER BY published_at DESC LIMIT 10'
          ).then(r => r[0]);
        } catch(e) {}
      }

      const contentHtml = generateCardHTML(posts, weather, hitokoto, dateInfo, stats, categories, songReq, todayHistory, weeklyStar, commentsByPost, includeGaokao, dailySongs);

      articles.push({
        title: `今日校园精选 | ${dateInfo.date}`,
        author: '嘉二校园墙',
        digest: `今日${posts.length}条热门帖子精选，含天气、一言等丰富内容`,
        content: contentHtml,
        content_source_url: 'https://wall.jay23.cn',
        show_cover_pic: 1,
        need_open_comment: 1,
        only_fans_can_comment: 0
      });
    } else {
      // 单篇帖子
      posts.forEach(post => {
        const coverImg = post.cover_image 
          ? `<img src="${post.cover_image}" style="width: 100%; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">`
          : '';

        const safeContent = (post.content || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        const safeTitle = (post.title || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        const safeAuthor = (post.author || '匿名').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        var postChars = (post.content || '').replace(/\s/g, '').length;
        var postReadMin = Math.max(1, Math.ceil(postChars / 300));
        var readingCard = '<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;"><tr><td style="background:#FFFFF0;padding:10px;border-radius:10px;"><table width="100%" cellpadding="0" cellspacing="0"><tr>' +
          '<td style="text-align:center;width:50%;padding:4px;border-right:1px dashed #E8D5B5;"><div style="font-size:11px;color:#bbb;margin-bottom:2px;">📝 全文字数</div><div style="font-size:15px;font-weight:bold;color:#D4876A;">' + postChars.toLocaleString() + ' 字</div></td>' +
          '<td style="text-align:center;width:50%;padding:4px;"><div style="font-size:11px;color:#bbb;margin-bottom:2px;">⏱ 阅读时长</div><div style="font-size:15px;font-weight:bold;color:#D4876A;">约 ' + postReadMin + ' 分钟</div></td>' +
          '</tr></table></td></tr></table>';
        const contentHtml = `
          <section style="padding: 20px; font-family: -apple-system, sans-serif;">
            <h2 style="color: #667eea; font-size: 22px;">${safeTitle}</h2>
            ${coverImg}
            ${readingCard}
            ${autoFormatContent(safeContent)}
            <section style="margin-top: 25px; padding: 15px; background: #f8f9fa; border-radius: 8px; display: flex; justify-content: space-between; font-size: 13px; color: #999;">
              <span>👤 ${safeAuthor}</span>
              <span>❤️ ${post.likes_count} 赞</span>
              <span>🕒 ${new Date(post.created_at).toLocaleString('zh-CN')}</span>
            </section>
          </section>
        `;

        articles.push({
          title: post.title || '校园动态',
          author: post.author || '匿名',
          digest: post.content, // 使用完整内容作为摘要
          content: contentHtml,
          content_source_url: `https://wall.jay23.cn/post/${post.id}`,
          show_cover_pic: 1,
          need_open_comment: 1,
          only_fans_can_comment: 0
        });
      });
    }

    res.json({
      code: 200,
      data: { articles, posts, weather, hitokoto, dateInfo, stats, categories, songs: songReq, todayHistory, weeklyStar, commentsByPost, dailySongs: dailySongs || [] },
      message: '生成成功'
    });
  } catch (err) {
    console.error('[MP素材] 生成内容失败:', err.message);
    res.json({ code: 500, message: '生成失败: ' + err.message });
  }
});

/**
 * 上传封面图片并获取 media_id
 * POST /api/mp/upload-cover
 * 参数：
 *   - imageUrl: 图片URL
 */
router.post('/upload-cover', async (req, res) => {
  try {
    const { imageUrl } = req.body;

    if (!imageUrl) {
      return res.json({ code: 400, message: '请提供图片URL' });
    }

    const mediaId = await mpDraftService.uploadMedia(imageUrl, 'image');

    res.json({
      code: 200,
      data: { media_id: mediaId },
      message: '上传成功'
    });
  } catch (err) {
    console.error('[MP素材] 上传封面失败:', err.message);
    res.json({ code: 500, message: '上传失败: ' + err.message });
  }
});

/**
 * 创建草稿
 * POST /api/mp/create-draft
 * 参数：
 *   - articles: 图文数组
 */
router.post('/create-draft', async (req, res) => {
  try {
    const { articles } = req.body;

    if (!articles || !Array.isArray(articles) || articles.length === 0) {
      return res.json({ code: 400, message: '请提供图文内容' });
    }

    // 如果有封面图片URL，先上传获取media_id
    for (let article of articles) {
      if (article.cover_image_url && !article.thumb_media_id) {
        try {
          article.thumb_media_id = await mpDraftService.uploadMedia(article.cover_image_url, 'image');
        } catch (err) {
          console.warn('[MP素材] 上传封面失败，使用默认:', err.message);
          // 使用默认封面（需要在微信后台上传一次获取media_id）
          article.thumb_media_id = process.env.MP_DEFAULT_THUMB_MEDIA_ID || '';
        }
      }
    }

    const mediaId = await mpDraftService.createDraft(articles);

    res.json({
      code: 200,
      data: { media_id: mediaId },
      message: '草稿创建成功，请在公众号后台查看'
    });
  } catch (err) {
    console.error('[MP素材] 创建草稿失败:', err.message);
    res.json({ code: 500, message: '创建失败: ' + err.message });
  }
});

/**
 * 获取每日推歌列表
 * GET /api/mp/daily-songs
 */
router.get('/daily-songs', async (req, res) => {
  try {
    const { status, limit = 20 } = req.query;
    let sql = 'SELECT * FROM daily_song_recs WHERE 1=1';
    const params = [];

    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }

    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(parseInt(limit));

    const [songs] = await pool.execute(sql, params);
    res.json({ code: 200, data: songs });
  } catch (err) {
    res.json({ code: 500, message: '获取失败: ' + err.message });
  }
});

/**
 * 一键生成并发布今日精选（增强版）
 * POST /api/mp/publish-daily
 */
router.post('/publish-daily', async (req, res) => {
  try {
    const hours = parseInt(req.body.hours) || 24;
    const limit = parseInt(req.body.limit) || 10;

    // 1. 获取热门帖子
    const [posts] = await pool.execute(`
      SELECT 
        p.id, p.title, p.content, p.created_at, p.likes_count,
        p.views as view_count,
        u.username as author,
        COUNT(DISTINCT c.id) as comment_count,
        p.images
      FROM posts p
      LEFT JOIN users u ON p.user_id = u.id
      LEFT JOIN comments c ON c.post_id = p.id
      WHERE p.status = 'approved'
        AND p.created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
      GROUP BY p.id
      ORDER BY (p.likes_count * 2 + COUNT(DISTINCT c.id) * 3) DESC
      LIMIT ?
    `, [hours, limit]);

    if (posts.length === 0) {
      return res.json({ code: 400, message: '暂无热门帖子' });
    }

    // 2. 获取辅助信息
    const [weather, hitokoto, dateInfo] = await Promise.all([
      mpDraftService.getWeather(),
      mpDraftService.getHitokoto(),
      Promise.resolve(mpDraftService.getDateInfo())
    ]);

    // 获取每日推歌数据
    var dailySongs = [];
    try {
      dailySongs = await pool.execute(
        'SELECT * FROM daily_song_recs WHERE status = "published" ORDER BY published_at DESC LIMIT 10'
      ).then(r => r[0]);
    } catch(e) {}

    // 3. 生成精美卡片内容
    const contentHtml = generateCardHTML(posts, weather, hitokoto, dateInfo, null, null, [], null, [], {}, true, dailySongs);

    const articles = [{
      title: `📚 今日校园精选 | ${dateInfo.date}`,
      author: '嘉二校园墙',
      digest: `今日${posts.length}条热门帖子精选，含天气、一言等丰富内容`,
      content: contentHtml,
      content_source_url: 'https://wall.jay23.cn',
      show_cover_pic: 1,
      need_open_comment: 1,
      only_fans_can_comment: 0
    }];

    // 4. 创建草稿
    const mediaId = await mpDraftService.createDraft(articles);

    res.json({
      code: 200,
      data: { 
        media_id: mediaId,
        post_count: posts.length,
        weather: weather ? `${weather.icon} ${weather.temperature}` : null,
        hitokoto: hitokoto ? hitokoto.text.substring(0, 30) + '...' : null
      },
      message: '草稿创建成功，请在公众号后台审核后发布'
    });
  } catch (err) {
    console.error('[MP素材] 一键发布失败:', err.message);
    res.json({ code: 500, message: '发布失败: ' + err.message });
  }
});

/**
 * 获取草稿列表
 * GET /api/mp/drafts
 */
router.get('/drafts', async (req, res) => {
  try {
    const offset = parseInt(req.query.offset) || 0;
    const count = parseInt(req.query.count) || 20;

    const drafts = await mpDraftService.getDraftList(offset, count);

    res.json({
      code: 200,
      data: drafts,
      message: '获取成功'
    });
  } catch (err) {
    console.error('[MP素材] 获取草稿列表失败:', err.message);
    res.json({ code: 500, message: '获取失败: ' + err.message });
  }
});

/**
 * 删除草稿
 * DELETE /api/mp/draft/:mediaId
 */
router.delete('/draft/:mediaId', async (req, res) => {
  try {
    const { mediaId } = req.params;

    await mpDraftService.deleteDraft(mediaId);

    res.json({
      code: 200,
      message: '删除成功'
    });
  } catch (err) {
    console.error('[MP素材] 删除草稿失败:', err.message);
    res.json({ code: 500, message: '删除失败: ' + err.message });
  }
});

// ===== 同步草稿到公众号 =====
/**
 * 同步草稿到公众号（自动上传图片到微信CDN）
 * POST /api/mp/sync-draft
 */
router.post('/sync-draft', async (req, res) => {
  try {
    var { article } = req.body;
    if (!article) {
      return res.json({ code: 400, message: '请先生成图文内容' });
    }

    // 调试：检查内容中有多少需要上传的图片
    var imgTags = article.content.match(/<img[^>]+src="[^"]+"[^>]*>/g) || [];
    var needUpload = [];
    for (var ti = 0; ti < imgTags.length; ti++) {
      var m = imgTags[ti].match(/src="([^"]+)"/);
      if (m && m[1].indexOf('mmbiz.qpic.cn') < 0 && m[1].indexOf('mmbiz.qlogo.cn') < 0 && !m[1].startsWith('data:')) {
        needUpload.push(m[1].substring(0, 80));
      }
    }
    console.log('[MP同步] img标签:', imgTags.length, '需上传:', needUpload.length);
    if (needUpload.length > 0) console.log('[MP同步] 图片URL:', JSON.stringify(needUpload));

    var beforeCount = (article.content.match(/mmbiz.qpic.cn/g) || []).length;
    article.content = await uploadImagesToWeixin(article.content);
    var afterCount = (article.content.match(/mmbiz.qpic.cn/g) || []).length;
    var uploaded = afterCount - beforeCount;
    console.log('[MP同步] 上传成功:', uploaded, '/' , needUpload.length, '张');

    var mediaId = await mpDraftService.createDraft([article]);
    var msg = '同步成功';
    if (needUpload.length > 0) msg += ' (图片' + uploaded + '/' + needUpload.length + ')';
    console.log('[MP同步] 草稿ID:', mediaId, '| 图片状态:', uploaded, '/', needUpload.length);
    res.json({ code: 200, data: { media_id: mediaId, img_found: needUpload.length, img_uploaded: uploaded }, message: msg });
  } catch (err) {
    console.error('[MP素材] 同步失败:', err.message);
    res.json({ code: 500, message: err.message });
  }
});

module.exports = router;
