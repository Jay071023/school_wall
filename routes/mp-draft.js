/**
 * 公众号素材管理路由
 * 提供热点采集、草稿创建、素材管理等功能
 * 包含天气、一言、精美卡片样式
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { pool } = require('../config/database');
const mpDraftService = require('../services/mp-draft');
const { escapeHtml } = require('../services/html-utils');
const { auth, isStaff } = require('../middleware/auth');
const { getPagination } = require('../services/pagination');

function normalizeWeeklyPeriod(period) {
  return period === 'month'
    ? { key: 'month', days: 30, label: '本月' }
    : { key: 'week', days: 7, label: '本周' };
}

async function getActiveUsers(period, userIds, limit) {
  const normalized = normalizeWeeklyPeriod(period);
  const params = [];
  let userFilter = '';
  if (Array.isArray(userIds) && userIds.length > 0) {
    userFilter = ` AND u.id IN (${userIds.map(() => '?').join(',')})`;
    params.push(...userIds);
  }
  let limitSql = '';
  if (Number.isInteger(limit) && limit > 0) {
    limitSql = ' LIMIT ?';
    params.push(limit);
  }

  const [users] = await pool.execute(`
    SELECT u.id, u.nickname, u.username, u.avatar,
      COALESCE(pa.post_count, 0) AS post_count,
      COALESCE(ca.comment_count, 0) AS comment_count,
      (COALESCE(pa.likes_received, 0) + COALESCE(pa.post_comment_count, 0) + COALESCE(ca.comment_count, 0)) AS contribution_score
    FROM users u
    LEFT JOIN (
      SELECT user_id, COUNT(*) AS post_count,
        COALESCE(SUM(likes_count), 0) AS likes_received,
        COALESCE(SUM(comments_count), 0) AS post_comment_count
      FROM posts
      WHERE status = 'approved' AND is_deleted = 0
        AND created_at >= DATE_SUB(NOW(), INTERVAL ${normalized.days} DAY)
      GROUP BY user_id
    ) pa ON pa.user_id = u.id
    LEFT JOIN (
      SELECT user_id, COUNT(*) AS comment_count
      FROM comments
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL ${normalized.days} DAY)
      GROUP BY user_id
    ) ca ON ca.user_id = u.id
    WHERE u.role = 'user'
      AND (COALESCE(pa.post_count, 0) > 0 OR COALESCE(ca.comment_count, 0) > 0)
      ${userFilter}
    ORDER BY contribution_score DESC, post_count DESC, comment_count DESC
    ${limitSql}
  `, params);
  return { users, period: normalized };
}

function renderWechatVideoCard(post) {
  if (!post || !post.video_url) return '';
  const postUrl = `https://campus-wall.example/post/${encodeURIComponent(post.id)}`;
  return '<table width="100%" cellpadding="0" cellspacing="0" style="margin:14px 0;"><tr><td style="background:#F3F0FF;padding:16px;text-align:center;border:1px solid #E7DEFF;">' +
    '<div style="font-size:22px;margin-bottom:6px;">🎬</div>' +
    '<div style="font-size:15px;font-weight:bold;color:#6554C0;margin-bottom:6px;">本帖包含视频</div>' +
    '<div style="font-size:12px;color:#888;line-height:1.7;margin-bottom:10px;">公众号草稿不直接嵌入站外视频，点击下方按钮可在校墙播放</div>' +
    '<a href="' + postUrl + '" style="display:inline-block;background:#7259D9;color:#fff;text-decoration:none;padding:9px 18px;border-radius:18px;font-size:13px;">▶ 打开原帖播放视频</a>' +
    '</td></tr></table>';
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
    if (hours < 0) hours = 24;
    if (hours > 24 * 30) hours = 24 * 30;
    const limit = getPagination(req.query, { defaultLimit: 10, maxLimit: 50 }).limit;

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
        p.images, p.video_url, p.video_poster
      FROM posts p
      LEFT JOIN users u ON p.user_id = u.id
      LEFT JOIN comments c ON c.post_id = p.id
      WHERE p.status = 'approved' AND p.is_deleted = 0
        ${timeCondition}
      GROUP BY p.id
      ORDER BY (p.likes_count * 2 + COUNT(DISTINCT c.id) * 3 + COALESCE(p.views, 0) * 0.1) DESC
      LIMIT ?
    `, params);

    res.json({
      code: 200,
      data: posts,
      message: hours > 0 ? `获取最近${hours}小时的${posts.length}条热门帖子` : `获取全站${posts.length}条精华帖`
    });
  } catch (err) {
    console.error('[MP素材] 获取热点帖子失败:', err.message);
    res.json({ code: 500, message: '获取失败，请稍后重试' });
  }
});

/**
 * 获取每周之星（本周最活跃用户）
 * GET /api/mp/weekly-star
 */
router.get('/weekly-star', async (req, res) => {
  try {
    const result = await getActiveUsers(req.query.period, null, 5);
    
    res.json({
      code: 200,
      data: result.users,
      period: result.period.key,
      message: result.period.label + '活跃用户TOP5'
    });
  } catch (err) {
    console.error('[MP素材] 获取每周之星失败:', err.message);
    res.json({ code: 500, message: '获取失败，请稍后重试' });
  }
});

/**
 * 获取那年今日的帖子（同月同日的历史帖子）
 * GET /api/mp/today-history-posts
 */
router.get('/today-history-posts', async (req, res) => {
  try {
    const limit = getPagination(req.query, { defaultLimit: 5, maxLimit: 50 }).limit;
    
    const [posts] = await pool.execute(`
      SELECT 
        p.id, p.title, p.content, p.created_at, p.likes_count,
        p.views as view_count,
        u.username as author,
        YEAR(p.created_at) as post_year,
        COUNT(DISTINCT c.id) as comment_count,
        p.images, p.video_url, p.video_poster
      FROM posts p
      LEFT JOIN users u ON p.user_id = u.id
      LEFT JOIN comments c ON c.post_id = p.id
      WHERE p.status = 'approved' AND p.is_deleted = 0
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
    res.json({ code: 500, message: '获取失败，请稍后重试' });
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
    res.json({ code: 500, message: '获取失败，请稍后重试' });
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
  var seen = new Set();
  while ((match = imgRegex.exec(htmlContent)) !== null) {
    var originalSrc = match[1];
    if (originalSrc.indexOf('mmbiz.qpic.cn') >= 0 || originalSrc.indexOf('mmbiz.qlogo.cn') >= 0 || originalSrc.startsWith('data:')) continue;
    // 相对路径(/开头)直接传,mp-draft服务会读取本地文件;绝对路径则走HTTP下载
    if (!seen.has(originalSrc)) {
      seen.add(originalSrc);
      tasks.push({ original: originalSrc, upload: originalSrc });
    }
  }
  if (tasks.length === 0) return { content: htmlContent, total: 0, uploaded: 0, failed: 0 };

  // 并行上传并汇总错误；存在失败时不提交残缺草稿。
  var uploadResults = await Promise.allSettled(tasks.map(function(task) {
    return mpDraftService.uploadMpImage(task.upload).then(function(url) {
      return { original: task.original, url: url };
    });
  }));
  var uploadedCount = 0;
  var failures = [];
  uploadResults.forEach(function(r, idx) {
    if (r.status === 'fulfilled' && r.value && r.value.url) {
      htmlContent = htmlContent.split(r.value.original).join(r.value.url);
      uploadedCount++;
    } else if (r.status === 'rejected') {
      console.warn('[MP图片] 第' + (idx+1) + '张失败:', r.reason && r.reason.message);
      failures.push('第' + (idx + 1) + '张：' + ((r.reason && r.reason.message) || '上传失败'));
    }
  });
  if (failures.length > 0) {
    throw new Error('有 ' + failures.length + ' 张正文图片上传失败，已停止创建草稿；' + failures.slice(0, 3).join('；'));
  }
  return { content: htmlContent, total: tasks.length, uploaded: uploadedCount, failed: 0 };
}

/**
 * 统一准备公众号草稿正文：先处理视频永久素材，再处理正文图片 CDN，
 * 保证手动同步和“一键发布”不会走两套不同的媒体语义。
 */
async function prepareArticleForWeixin(article, onVideoProgress) {
  var articleCopy = JSON.parse(JSON.stringify(article || {}));
  var videoUpload = await uploadVideosToWeixin(articleCopy.content || '', onVideoProgress);
  articleCopy.content = videoUpload.content;

  // 视频替换后会新增封面图片，必须在这一步统一上传到微信 CDN。
  var imageUpload = await uploadImagesToWeixin(articleCopy.content);
  articleCopy.content = imageUpload.content;
  articleCopy.text_stats = mpDraftService.getArticleTextStats(articleCopy);

  return {
    article: articleCopy,
    video: videoUpload.result,
    image: {
      total: imageUpload.total,
      success: imageUpload.uploaded,
      failed: imageUpload.failed
    }
  };
}

const PUBLIC_WALL_ORIGIN = (process.env.PUBLIC_WALL_ORIGIN || 'https://campus-wall.example').replace(/\/$/, '');

function getPostVideoUrl(value) {
  var pathname = getControlledPostVideoPath(value);
  if (!pathname) return '';
  return PUBLIC_WALL_ORIGIN + pathname;
}

function getPublicAssetPath(value, pattern) {
  var raw = String(value || '').trim();
  var pathname = raw.split('?')[0];
  if (/^https?:\/\//i.test(raw)) {
    try { pathname = new URL(raw).pathname; } catch (e) { return ''; }
  }
  return pattern.test(pathname) ? pathname : '';
}

function getPostVideoPath(value) {
  return getControlledPostVideoPath(value);
}

function getControlledPostVideoPath(value) {
  var raw = String(value || '').trim();
  if (/^https?:\/\//i.test(raw)) {
    try {
      if (new URL(raw).origin !== new URL(PUBLIC_WALL_ORIGIN).origin) return '';
    } catch (e) {
      return '';
    }
  }
  return getPublicAssetPath(raw, /^\/uploads\/videos\/video_[A-Za-z0-9_-]+\.(?:mp4|webm|ogv)$/i);
}

function getPostPosterUrl(value) {
  var pathname = getPublicAssetPath(value, /^\/uploads\/posts\/post_[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|gif|webp)$/i);
  if (!pathname) return '';
  return PUBLIC_WALL_ORIGIN + pathname;
}

/**
 * 公众号正文不依赖外链 video 标签：将受控的 MP4/WebM/OGV 交给服务层处理，再替换成封面、站内入口和明确状态。
 * 仅允许校墙 uploads 路径，避免同步接口被当成任意 URL 下载器。
 */
async function uploadVideosToWeixin(htmlContent, onProgress) {
  var videoRegex = /<video\b([^>]*)>[\s\S]*?<\/video>|<div\b([^>]*data-mp-video-placeholder=["']1["'][^>]*)>[\s\S]*?<\/div>/gi;
  var matches = [];
  var match;
  while ((match = videoRegex.exec(htmlContent)) !== null) matches.push(match);

  var result = { total: matches.length, success: 0, failed: 0, items: [] };
  if (matches.length === 0) return { content: htmlContent, result: result };

  var output = '';
  var cursor = 0;
  for (var i = 0; i < matches.length; i++) {
    var current = matches[i];
    var attrs = current[1] || current[2] || '';
    var source = getPostVideoPath(readHtmlAttribute(attrs, 'src'));
    var posterUrl = getPostPosterUrl(readHtmlAttribute(attrs, 'poster'));
    if (!source) source = getPostVideoPath(readHtmlAttribute(attrs, 'data-mp-video-source'));
    if (!posterUrl) posterUrl = getPostPosterUrl(readHtmlAttribute(attrs, 'data-mp-video-poster'));
    var following = htmlContent.substring(current.index + current[0].length, current.index + current[0].length + 1200);
    var viewUrl = getPostViewUrl(readHtmlAttribute(attrs, 'data-mp-video-view')) || getPostViewUrl(readHtmlAttribute(following, 'href')) || (source ? PUBLIC_WALL_ORIGIN + source : PUBLIC_WALL_ORIGIN);
    var item = { index: i + 1, status: 'failed', message: '' };
    var replacement;

    try {
      if (!source) throw new Error('视频地址不是校墙受控上传路径');
      // 传相对的受控路径，让服务层按实际扩展名选择直传或服务器临时转码。
      await mpDraftService.uploadPermanentVideo(source, {
        title: '校墙投稿视频',
        introduction: '来自校墙的投稿视频，正文保留站内观看入口'
      });
      result.success++;
      item.status = 'success';
      item.message = '视频已上传到公众号永久素材';
      replacement = buildSyncedVideoHTML(posterUrl, viewUrl, true, '视频已同步到公众号素材库');
    } catch (error) {
      result.failed++;
      item.code = error && error.code ? String(error.code).substring(0, 64) : 'MP_VIDEO_UPLOAD_FAILED';
      item.message = error && error.message ? String(error.message).substring(0, 160) : '视频上传失败';
      result.errors = result.errors || [];
      result.errors.push({ index: item.index, code: item.code, message: item.message });
      replacement = buildSyncedVideoHTML(posterUrl, viewUrl, false, '视频上传失败，已保留站内观看入口：' + item.message);
    }
    result.items.push(item);
    output += htmlContent.substring(cursor, current.index) + replacement;
    cursor = current.index + current[0].length;
    if (typeof onProgress === 'function') onProgress(result);
  }
  output += htmlContent.substring(cursor);
  return { content: output, result: result };
}

function formatVideoFailureDetails(videoResult) {
  var errors = videoResult && Array.isArray(videoResult.errors) ? videoResult.errors : [];
  if (errors.length === 0 && videoResult && Array.isArray(videoResult.items)) {
    errors = videoResult.items.filter(function(item) { return item && item.status === 'failed'; });
  }
  return errors.slice(0, 3).map(function(item) {
    var prefix = '视频' + (item.index || '') + (item.code ? ' [' + item.code + ']' : '');
    return prefix + '：' + (item.message || '视频处理失败');
  }).join('；');
}

function readHtmlAttribute(html, attribute) {
  var expression = new RegExp('\\b' + attribute + '\\s*=\\s*["\\\']([^"\\\']+)["\\\']', 'i');
  var match = expression.exec(String(html || ''));
  return match ? match[1] : '';
}

function getPostViewUrl(value) {
  var pathname = getPublicAssetPath(value, /^\/post\/\d+$/);
  return pathname ? PUBLIC_WALL_ORIGIN + pathname : '';
}

function buildSyncedVideoHTML(posterUrl, viewUrl, uploaded, message) {
  var cover = posterUrl
    ? '<img src="' + escapeHtml(posterUrl) + '" alt="视频封面" style="display:block;width:100%;max-height:360px;object-fit:cover;border-radius:9px;background:#172c2a;">'
    : '<div style="display:flex;align-items:center;justify-content:center;min-height:120px;border-radius:9px;background:#172c2a;color:#fff;font-size:38px;">🎬</div>';
  var color = uploaded ? '#2e9b68' : '#c47a00';
  return '<div data-mp-video-status="' + (uploaded ? 'success' : 'failed') + '" style="margin:14px 0;padding:12px;background:#f7f8fc;border-radius:12px;border:1px solid #ececf5;">' +
    cover +
    '<div style="margin-top:8px;font-size:13px;line-height:1.7;color:' + color + ';">' + (uploaded ? '✅ ' : '⚠️ ') + escapeHtml(message) + '</div>' +
    '<div style="margin-top:5px;text-align:center;font-size:12px;line-height:1.6;"><a href="' + escapeHtml(viewUrl) + '" style="color:#667eea;text-decoration:none;">点击打开校墙观看视频 →</a></div>' +
    '</div>';
}

/**
 * 帖子视频在公众号图文中的展示：使用受控占位卡，自动同步时再上传永久 MP4 素材。
 * 正文不依赖外链 video 标签，始终保留封面和站内观看入口。
 */
function buildPostVideoHTML(post) {
  var videoUrl = getPostVideoUrl(post && post.video_url);
  if (!videoUrl) return '';
  var posterUrl = getPostPosterUrl(post && post.video_poster);
  var articleUrl = /^\d+$/.test(String(post && post.id || '')) ? PUBLIC_WALL_ORIGIN + '/post/' + String(post.id) : videoUrl;
  var cover = posterUrl ? '<img src="' + escapeHtml(posterUrl) + '" alt="视频封面" style="display:block;width:100%;max-height:360px;object-fit:cover;border-radius:9px;background:#172c2a;">' : '🎬 ';
  return '<div data-mp-video-placeholder="1" data-mp-video-source="' + escapeHtml(videoUrl) + '" data-mp-video-poster="' + escapeHtml(posterUrl) + '" data-mp-video-view="' + escapeHtml(articleUrl) + '" style="margin:14px 0;padding:12px;background:#f7f8fc;border-radius:12px;border:1px solid #ececf5;text-align:center;">' +
    cover +
    '<br><span style="font-size:13px;color:#667eea;font-weight:600;">🎬 视频投稿 · 同步时上传公众号永久 MP4 素材</span><br>' +
    '<a href="' + escapeHtml(articleUrl) + '" style="color:#667eea;text-decoration:none;font-size:12px;line-height:1.6;">播放器无法显示？点击打开视频页面 →</a>' +
    '</div>';
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
function generateCardHTML(posts, weather, hitokoto, dateInfo, stats, categories, songs, todayHistory, weeklyStar, commentsByPost, includeGaokao, dailySongs, includeSongs) {
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
  html += '<!-- mp-text-stats-start --><table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;"><tr><td style="background:#FFFFF0;padding:12px;border-radius:10px;">';
  html += '<table width="100%" cellpadding="0" cellspacing="0"><tr>';
  html += '<td style="text-align:center;width:50%;padding:4px;border-right:1px dashed #E8D5B5;">';
  html += '<div style="font-size:11px;color:#bbb;margin-bottom:2px;">📝 全文字数</div>';
  html += '<div style="font-size:16px;font-weight:bold;color:#D4876A;">__MP_VISIBLE_TEXT_COUNT__ 字</div>';
  html += '</td>';
  html += '<td style="text-align:center;width:50%;padding:4px;">';
  html += '<div style="font-size:11px;color:#bbb;margin-bottom:2px;">⏱ 阅读时长</div>';
  html += '<div style="font-size:16px;font-weight:bold;color:#D4876A;">约 ' + readMinutes + ' 分钟</div>';
  html += '</td>';
  html += '</tr></table></td></tr></table><!-- mp-text-stats-end -->';

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
  if (includeSongs !== false && songs && songs.length > 0) {
    html += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;"><tr><td style="background:#FFF0F5;padding:12px 14px;">';
    html += '<div style="font-size:13px;color:#999;margin-bottom:6px;">🎵 最近点歌</div>';
    for (var si = 0; si < songs.length; si++) {
      var s = songs[si];
      var authorStr = s.is_anonymous ? '匿名同学' : (s.nickname || s.username || '同学');
      html += '<div style="border-top:' + (si > 0 ? '1px dashed #FFD1DC;' : 'none;') + ';padding:8px 0;">';
      html += '<div style="font-size:14px;color:#555;line-height:1.6;">🎶 <strong>' + escapeHtml(s.song_name || '') + '</strong>' + (s.artist ? ' - <span style="color:#aaa;">' + escapeHtml(s.artist) + '</span>' : '') + '</div>';
      html += '<div style="font-size:12px;color:#bbb;margin-top:3px;line-height:1.5;">';
      if (s.slot_name || s.play_date || s.req_date) html += '📅 ' + (s.slot_name || '') + ((s.play_date || s.req_date) ? ' · ' + (s.play_date || s.req_date) : '') + (s.start_time && s.end_time ? ' ' + s.start_time.substring(0,5) + '-' + s.end_time.substring(0,5) : '');
      if (s.message) html += ' &nbsp;💬 ' + escapeHtml(s.message); // 不再截断点歌留言
      if (s.to_whom) html += ' &nbsp;💝 ' + escapeHtml(s.to_whom);
      html += ' &nbsp;👤 ' + escapeHtml(authorStr);
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
      coverImgs += (ii > 0 ? '<div style="border-top:1px dashed #eee;margin:8px 0;"></div>' : '') + '<img src="' + escapeHtml(allImgs[ii]) + '" style="width:100%;" alt="封面">';
    }
    var videoHtml = buildPostVideoHTML(p);
    var safeTitle = (p.title || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    var content = (p.content || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); // 不再截断，显示完整内容

    html += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:18px;"><tr><td style="border-top:3px solid ' + c + ';background:' + bg + ';padding:16px;">';
    html += '<div style="color:' + c + ';font-weight:bold;font-size:13px;margin-bottom:6px;">#' + (i+1) + ' · 热门帖子</div>';
    html += '<div style="font-weight:bold;font-size:18px;color:#333;margin-bottom:8px;line-height:1.4;">' + safeTitle + '</div>';
    html += coverImgs;
    html += videoHtml;
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
  html += '<img src="https://campus-wall.example/images/gzh.jpg" style="width:200px;display:block;border-radius:6px;margin:0 auto;height:auto;" alt="校园墙二维码">';
  html += '</td></tr></table>';
  html += '</td></tr></table>';
  html += '<p style="color:#bbb;font-size:12px;margin:14px 0 4px 0;letter-spacing:1px;">📱 微信扫一扫 · 获取更多精彩</p>';
  html += '<p style="color:#FF69B4;font-size:13px;font-weight:bold;word-break:break-all;letter-spacing:0.5px;">https://campus-wall.example</p>';
  html += '<div style="width:40px;height:2px;background:#FFB6C1;margin:12px auto 0;border-radius:2px;"></div>';
  html += '</td></tr></table>';
  html += '<p style="text-align:center;color:#ddd;font-size:12px;margin-top:18px;">❀ ' + dateInfo.year + ' 校园墙 ❀ ❀</p>';
  html += '</div>';

  return html;
}

/**
 * 生成图文素材内容（增强版）
 * POST /api/mp/generate-content
 */
router.post('/generate-content', async (req, res) => {
  try {
    const { postIds, template = 'daily-summary', includeWeather = true, includeHitokoto = true, includeWeeklyStar = true, includeGaokao = true, includeSongs = true, weeklyStarUserIds = [] } = req.body;

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
          p.images, p.video_url, p.video_poster
        FROM posts p
        LEFT JOIN users u ON p.user_id = u.id
        LEFT JOIN comments c ON c.post_id = p.id
        WHERE p.status = 'approved' AND p.is_deleted = 0 AND FIND_IN_SET(p.id, ?)
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
      pool.execute("SELECT COUNT(*) as total FROM posts WHERE status='approved' AND is_deleted=0 AND created_at >= CURDATE() AND created_at < DATE_ADD(CURDATE(), INTERVAL 1 DAY)").then(r => r[0][0]),
      // 热门分类
      pool.execute("SELECT category, COUNT(*) as cnt FROM posts WHERE status='approved' AND is_deleted=0 GROUP BY category ORDER BY cnt DESC LIMIT 3").then(r => r[0]),
      // 历史上的今天
      mpDraftService.getTodayInHistory(),
      // 每周之星
      (async function() {
        if (!includeWeeklyStar) return [];
        const result = await getActiveUsers('week', weeklyStarUserIds, weeklyStarUserIds.length > 0 ? null : 3);
        return result.users;
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

    var dailySongs = (includeSongs !== false && Array.isArray(req.body.dailySongs)) ? req.body.dailySongs : [];
    if (posts.length === 0 && dailySongs.length === 0) {
      return res.json({ code: 404, message: '未找到帖子' });
    }

    // 获取点歌数据
    var songReq = [];
    try {
      songReq = await pool.execute("SELECT sr.song_name, sr.artist, sr.message, sr.to_whom, sr.is_anonymous, u.username, u.nickname, ts.name as slot_name, ts.start_time, ts.end_time, DATE_FORMAT(sd.play_date,'%m/%d') as play_date, DATE_FORMAT(sd.play_date,'%Y年%m月%d日') as play_date_full, sr.created_at, DATE_FORMAT(sr.created_at,'%m/%d') as req_date FROM song_requests sr LEFT JOIN time_slots ts ON sr.slot_id=ts.id LEFT JOIN slot_dates sd ON sr.slot_date_id=sd.id LEFT JOIN users u ON sr.user_id=u.id WHERE sr.status='approved' AND sr.deleted_at IS NULL ORDER BY sr.created_at DESC LIMIT 3").then(r => r[0]);
    } catch(e) {}

    // 生成图文内容
    const articles = [];

    if (template === 'daily-summary') {
      // 根据开关决定是否包含推歌
      // 只有显式传入 includeSongs=true 且有选择歌曲时才包含
      const contentHtml = generateCardHTML(posts, weather, hitokoto, dateInfo, stats, categories, songReq, todayHistory, weeklyStar, commentsByPost, includeGaokao, dailySongs, includeSongs);

      articles.push({
        title: `今日校园精选 | ${dateInfo.date}`,
        author: '校园墙',
        digest: `今日${posts.length}条热门帖子精选，含天气、一言等丰富内容`,
        content: contentHtml,
        content_source_url: 'https://campus-wall.example',
        show_cover_pic: 1,
        need_open_comment: 1,
        only_fans_can_comment: 0
      });
    } else {
      // 单篇帖子
      posts.forEach(post => {
        var postImages = [];
        try { postImages = JSON.parse(post.images || '[]'); } catch (e) {}
        if (!Array.isArray(postImages)) postImages = [];
        const coverImg = postImages.map(function(src) {
          return '<img src="' + escapeHtml(src) + '" style="width:100%;margin:10px 0;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.1);">';
        }).join('');
        const videoHtml = buildPostVideoHTML(post);

        const safeContent = (post.content || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        const safeTitle = (post.title || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        const safeAuthor = (post.author || '匿名').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        var postChars = (post.content || '').replace(/\s/g, '').length;
        var postReadMin = Math.max(1, Math.ceil(postChars / 300));
        var readingCard = '<!-- mp-text-stats-start --><table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;"><tr><td style="background:#FFFFF0;padding:10px;border-radius:10px;"><table width="100%" cellpadding="0" cellspacing="0"><tr>' +
          '<td style="text-align:center;width:50%;padding:4px;border-right:1px dashed #E8D5B5;"><div style="font-size:11px;color:#bbb;margin-bottom:2px;">📝 全文字数</div><div style="font-size:15px;font-weight:bold;color:#D4876A;">__MP_VISIBLE_TEXT_COUNT__ 字</div></td>' +
          '<td style="text-align:center;width:50%;padding:4px;"><div style="font-size:11px;color:#bbb;margin-bottom:2px;">⏱ 阅读时长</div><div style="font-size:15px;font-weight:bold;color:#D4876A;">约 ' + postReadMin + ' 分钟</div></td>' +
          '</tr></table></td></tr></table><!-- mp-text-stats-end -->';
        const contentHtml = `
          <section style="padding: 20px; font-family: -apple-system, sans-serif;">
            <h2 style="color: #667eea; font-size: 22px;">${safeTitle}</h2>
            ${coverImg}
            ${videoHtml}
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
          content_source_url: `https://campus-wall.example/post/${post.id}`,
          show_cover_pic: 1,
          need_open_comment: 1,
          only_fans_can_comment: 0
        });
      });
    }

    // 给管理页提供基于最终文章标题和可见正文的统计，避免只统计原始 post.content。
    articles.forEach(function(article) {
      // 先排除统计卡本身，避免“全文字数”把自己的数字再次算进去。
      var initialTextStats = mpDraftService.getArticleTextStats(article);
      article.content = String(article.content || '').replace(/__MP_VISIBLE_TEXT_COUNT__/g, initialTextStats.total.toLocaleString());
      article.text_stats = mpDraftService.getArticleTextStats(article);
    });
    var textStats = articles.reduce(function(total, article) {
      var stats = article.text_stats || {};
      total.title += stats.title || 0;
      total.author += stats.author || 0;
      total.content += stats.content || 0;
      total.total += stats.total || 0;
      return total;
    }, { title: 0, author: 0, content: 0, total: 0 });

    res.json({
      code: 200,
      data: { articles, text_stats: textStats, posts, weather, hitokoto, dateInfo, stats, categories, songs: songReq, todayHistory, weeklyStar, commentsByPost, dailySongs: dailySongs || [] },
      message: '生成成功'
    });
  } catch (err) {
    console.error('[MP素材] 生成内容失败:', err.message);
    res.json({ code: 500, message: '生成失败，请稍后重试' });
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
    res.json({ code: 500, message: '上传失败，请稍后重试' });
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
    res.json({ code: 500, message: '创建失败，请稍后重试' });
  }
});

/**
 * 获取每日推歌列表
 * GET /api/mp/daily-songs
 */
router.get('/daily-songs', async (req, res) => {
  try {
    const { status } = req.query;
    const limit = getPagination(req.query, { defaultLimit: 20, maxLimit: 50 }).limit;
    let sql = 'SELECT * FROM daily_song_recs WHERE 1=1';
    const params = [];

    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }

    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const [songs] = await pool.execute(sql, params);
    res.json({ code: 200, data: songs });
  } catch (err) {
    console.error('[MP素材] 获取每日推歌失败:', err.message);
    res.json({ code: 500, message: '获取失败，请稍后重试' });
  }
});

/**
 * 一键生成并发布今日精选（增强版）
 * POST /api/mp/publish-daily
 */
router.post('/publish-daily', async (req, res) => {
  try {
    const requestedHours = Number.parseInt(req.body.hours, 10);
    const hours = Number.isFinite(requestedHours) && requestedHours > 0 ? Math.min(requestedHours, 24 * 30) : 24;
    const requestedLimit = parseInt(req.body.limit, 10);
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 50) : 10;

    // 1. 获取热门帖子
    const [posts] = await pool.execute(`
      SELECT 
        p.id, p.title, p.content, p.created_at, p.likes_count,
        p.views as view_count,
        u.username as author,
        COUNT(DISTINCT c.id) as comment_count,
        p.images, p.video_url, p.video_poster
      FROM posts p
      LEFT JOIN users u ON p.user_id = u.id
      LEFT JOIN comments c ON c.post_id = p.id
      WHERE p.status = 'approved' AND p.is_deleted = 0
        AND p.created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
      GROUP BY p.id
      ORDER BY (p.likes_count * 2 + COUNT(DISTINCT c.id) * 3 + COALESCE(p.views, 0) * 0.1) DESC
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
      author: '校园墙',
      digest: `今日${posts.length}条热门帖子精选，含天气、一言等丰富内容`,
      content: contentHtml,
      content_source_url: 'https://campus-wall.example',
      show_cover_pic: 1,
      need_open_comment: 1,
      only_fans_can_comment: 0
    }];

    // 4. 和手动同步走同一套媒体处理链：视频上传永久素材，图片上传微信 CDN。
    // 过去这里直接 createDraft，导致“一键发布”只生成站内视频占位卡，视频并未同步。
    const prepared = await prepareArticleForWeixin(articles[0]);
    const mediaId = await mpDraftService.createDraft([prepared.article]);
    const videoFailureDetails = formatVideoFailureDetails(prepared.video);
    const hasVideoFailures = Boolean(prepared.video && prepared.video.failed > 0);

    res.json({
      // 草稿可能已创建，但视频未完成时不能给前端伪造“成功”。
      code: hasVideoFailures ? 502 : 200,
      data: { 
        media_id: mediaId,
        post_count: posts.length,
        weather: weather ? `${weather.icon} ${weather.temperature}` : null,
        hitokoto: hitokoto ? hitokoto.text.substring(0, 30) + '...' : null,
        image: prepared.image,
        video: prepared.video,
        sync_status: hasVideoFailures ? 'video_failed' : 'done',
        failure_reason: videoFailureDetails || null,
        text_stats: prepared.article.text_stats
      },
      message: hasVideoFailures
        ? '草稿已创建，但视频素材同步失败：' + videoFailureDetails + '；正文已保留封面和站内观看入口'
        : '草稿创建成功，请在公众号后台审核后发布'
    });
  } catch (err) {
    console.error('[MP素材] 一键发布失败:', err.message);
    res.json({ code: 500, message: '发布失败，请稍后重试' });
  }
});

/**
 * 获取草稿列表
 * GET /api/mp/drafts
 */
router.get('/drafts', async (req, res) => {
  try {
    const requestedOffset = parseInt(req.query.offset, 10);
    const requestedCount = parseInt(req.query.count, 10);
    const offset = Number.isFinite(requestedOffset) && requestedOffset >= 0 ? Math.min(requestedOffset, 100000) : 0;
    const count = Number.isFinite(requestedCount) && requestedCount > 0 ? Math.min(requestedCount, 50) : 20;

    const drafts = await mpDraftService.getDraftList(offset, count);

    res.json({
      code: 200,
      data: drafts,
      message: '获取成功'
    });
  } catch (err) {
    console.error('[MP素材] 获取草稿列表失败:', err.message);
    res.json({ code: 500, message: '获取失败，请稍后重试' });
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
    res.json({ code: 500, message: '删除失败，请稍后重试' });
  }
});

// ===== 同步草稿到公众号 =====
// 后台同步任务池（避免 Cloudflare 100s 超时）
var pendingSyncs = {};

// 定时清理过期同步状态（每 5 分钟清理 >10 分钟的）
var syncCleanupTimer = setInterval(function() {
  var now = Date.now();
  for (var k in pendingSyncs) {
    if (pendingSyncs[k].createdAt && now - pendingSyncs[k].createdAt > 10 * 60 * 1000) {
      delete pendingSyncs[k];
    }
  }
}, 5 * 60 * 1000);
if (syncCleanupTimer.unref) syncCleanupTimer.unref();

/**
 * 同步草稿到公众号（图片上传到微信CDN，视频上传为永久 MP4 素材）
 * POST /api/mp/sync-draft
 */
router.post('/sync-draft', async (req, res) => {
  var { article } = req.body;
  if (!article || typeof article !== 'object') {
    return res.json({ code: 400, message: '请先生成图文内容' });
  }
  if (!article.title || !String(article.title).trim()) {
    return res.json({ code: 400, message: '文章标题不能为空' });
  }
  if (!article.content || !String(article.content).trim()) {
    return res.json({ code: 400, message: '文章正文不能为空' });
  }

  if (typeof article.content !== 'string') {
    return res.json({ code: 400, message: '文章正文格式无效' });
  }

  // 内容大小校验必须按 UTF-8 字节数计算，避免中文按 JS UTF-16 长度误判。
  var articleBytes = Buffer.byteLength(article.content, 'utf8');
  if (articleBytes > 5 * 1024 * 1024) {
    return res.json({ code: 413, message: '文章内容超过 5MB,请减少帖子数或图片数(' + (articleBytes/1024/1024).toFixed(2) + 'MB)' });
  }

  var imgTags = String(article.content).match(/<img[^>]+src=["'][^"']+["'][^>]*>/g) || [];
  var needUpload = [];
  for (var ti = 0; ti < imgTags.length; ti++) {
    var m = imgTags[ti].match(/src=["']([^"']+)["']/);
    if (m && m[1].indexOf('mmbiz.qpic.cn') < 0 && m[1].indexOf('mmbiz.qlogo.cn') < 0 && !m[1].startsWith('data:')) {
      needUpload.push(m[1].substring(0, 80));
    }
  }
  var videoCount = (article.content.match(/<video\b[^>]*>[\s\S]*?<\/video>|<div\b[^>]*data-mp-video-placeholder=["']1["'][^>]*>[\s\S]*?<\/div>/gi) || []).length;
  // 先返回成功，后台处理同步（避免 Cloudflare 100s 超时）
  var ownerId = req.user.id;
  var activeSyncId = Object.keys(pendingSyncs).find(function(id) {
    return pendingSyncs[id].ownerId === ownerId && pendingSyncs[id].status === 'processing';
  });
  if (activeSyncId) {
    return res.json({ code: 409, message: '你已有一个公众号同步任务正在处理，请等待完成后再提交', data: { sync_id: activeSyncId, processing: true } });
  }
  var syncId = 'sync_' + crypto.randomBytes(16).toString('hex');
  var createdAt = Date.now();
  pendingSyncs[syncId] = {
    status: 'processing',
    msg: '正在处理公众号素材...',
    createdAt: createdAt,
    ownerId: ownerId,
    image: { total: needUpload.length, success: 0, failed: 0 },
    video: { total: videoCount, success: 0, failed: 0, items: [] }
  };

  // 立即回复前端，不给 524 机会
  res.json({
    code: 200,
    data: { sync_id: syncId, processing: true, img_count: needUpload.length, video_count: videoCount },
    message: '同步任务已提交(' + syncId + ')，正在后台处理...'
  });

  // 后台异步处理
  (async function() {
    try {
      var prepared = await prepareArticleForWeixin(article, function(progress) {
        if (!pendingSyncs[syncId]) return;
        pendingSyncs[syncId].video = progress;
        pendingSyncs[syncId].msg = '视频素材上传中（成功 ' + progress.success + '/' + progress.total + '，失败 ' + progress.failed + '）';
      });
      var articleCopy = prepared.article;
      if (pendingSyncs[syncId]) {
        pendingSyncs[syncId].video = prepared.video;
        pendingSyncs[syncId].image = prepared.image;
      }

      var mediaId = await mpDraftService.createDraft([articleCopy]);
      var video = prepared.video;
      var videoFailureDetails = formatVideoFailureDetails(video);
      var hasVideoFailures = Boolean(video && video.failed > 0);
      var videoMessage = video.total > 0
        ? '，视频成功 ' + video.success + '/' + video.total + (video.failed > 0 ? '，失败 ' + video.failed + '（正文已保留封面和观看入口）' : '')
        : '';
      var currentState = pendingSyncs[syncId] || {};
      pendingSyncs[syncId] = {
        // 草稿可能已创建，但视频未完成时必须进入 fail 分支，前端才能明确提示用户。
        status: hasVideoFailures ? 'fail' : 'done',
        msg: hasVideoFailures
          ? '同步未完成：视频素材处理失败（' + videoFailureDetails + '）；正文已保留封面和观看入口'
          : '同步成功（图片 ' + prepared.image.success + '/' + prepared.image.total + videoMessage + '）',
        media_id: mediaId,
        image: prepared.image,
        video: video,
        failure_reason: videoFailureDetails || null,
        text_stats: articleCopy.text_stats,
        createdAt: currentState.createdAt || createdAt,
        ownerId: ownerId
      };
    } catch (err) {
      console.error('[MP同步] 后台失败:', err.message);
      pendingSyncs[syncId] = {
        status: 'fail',
        msg: err.message,
        image: pendingSyncs[syncId] && pendingSyncs[syncId].image,
        video: pendingSyncs[syncId] && pendingSyncs[syncId].video,
        createdAt: createdAt,
        ownerId: ownerId
      };
    }
  })();
});

/**
 * 查询同步状态
 * GET /api/mp/sync-status?sync_id=xxx
 */
router.get('/sync-status', async (req, res) => {
  var syncId = req.query.sync_id;
  if (!syncId || !pendingSyncs[syncId] || pendingSyncs[syncId].ownerId !== req.user.id) {
    return res.json({ code: 404, message: '未找到该同步任务' });
  }
  res.json({ code: 200, data: pendingSyncs[syncId] });
});

module.exports = router;
