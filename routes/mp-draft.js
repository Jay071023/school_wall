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
const { generateCoverPrompt } = require('../services/cover-prompt');
const { escapeHtml } = require('../services/html-utils');
const { auth, isStaff, superAdminOnly, requirePermission } = require('../middleware/auth');
const { getPagination } = require('../services/pagination');
const { getChinaDate, getChinaDayOfWeek } = require('../services/date');

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
  const postUrl = `http://localhost:3000/post/${encodeURIComponent(post.id)}`;
  return '<table width="100%" cellpadding="0" cellspacing="0" style="margin:14px 0;"><tr><td style="background:#F3F0FF;padding:16px;text-align:center;border:1px solid #E7DEFF;">' +
    '<div style="font-size:22px;margin-bottom:6px;">🎬</div>' +
    '<div style="font-size:15px;font-weight:bold;color:#6554C0;margin-bottom:6px;">本帖包含视频</div>' +
    '<div style="font-size:12px;color:#888;line-height:1.7;margin-bottom:10px;">公众号草稿不直接嵌入站外视频，点击下方按钮可在校墙播放</div>' +
    '<a href="' + postUrl + '" style="display:inline-block;background:#7259D9;color:#fff;text-decoration:none;padding:9px 18px;border-radius:18px;font-size:13px;">▶ 打开原帖播放视频</a>' +
    '</td></tr></table>';
}

// 每日推歌的发布状态只由“同步到公众号草稿箱”成功的流程推进。
// 已同步的歌保留三天，方便编辑重新生成；超过窗口后不再进入候选列表。
const DAILY_SONG_REUSE_DAYS = 3;
const DAILY_SONG_REUSE_MS = DAILY_SONG_REUSE_DAYS * 24 * 60 * 60 * 1000;

function normalizeDailySongIds(value) {
  if (value == null) return { ok: true, ids: [] };
  if (!Array.isArray(value) || value.length > 50) return { ok: false, ids: [] };

  const ids = [];
  const seen = new Set();
  for (const valueId of value) {
    if (!Number.isSafeInteger(valueId) || valueId <= 0 || seen.has(valueId)) {
      return { ok: false, ids: [] };
    }
    seen.add(valueId);
    ids.push(valueId);
  }
  return { ok: true, ids };
}

function isDailySongCandidate(song, now) {
  if (!song) return false;
  if (song.candidate_hidden_at) return false;
  if (song.status === 'pending') return true;
  if (song.status !== 'published') return false;
  // 旧数据曾只写入 status 而遗漏 published_at。不能让它因此从候选曲库
  // “消失”，但仍严格按三天窗口处理；created_at 是唯一可靠的旧记录回退。
  const publishedAt = new Date(song.published_at || song.created_at || 0).getTime();
  return Number.isFinite(publishedAt) && publishedAt >= now.getTime() - DAILY_SONG_REUSE_MS;
}

function dailySongCandidateSql(alias) {
  const prefix = alias ? alias + '.' : '';
  // published_at 缺失的历史数据按创建时间回退，防止同步完成后在候选页被筛掉。
  return `${prefix}candidate_hidden_at IS NULL AND (${prefix}status = 'pending' OR (${prefix}status = 'published' AND COALESCE(${prefix}published_at, ${prefix}created_at) >= DATE_SUB(NOW(), INTERVAL ${DAILY_SONG_REUSE_DAYS} DAY)))`;
}

async function getSyncableDailySongs(dbPool, ids, article) {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const [songs] = await dbPool.execute(
    `SELECT id, song_name, status, published_at FROM daily_song_recs WHERE id IN (${placeholders}) AND ${dailySongCandidateSql()}`,
    ids
  );
  if (songs.length !== ids.length) {
    const error = new Error('存在不存在、已超过三天复用期或不可同步的每日推歌');
    error.code = 'DAILY_SONG_NOT_SYNCABLE';
    throw error;
  }

  // 只接受确实出现在本次 article 中的歌曲，避免客户端把未随文推送的歌误标为已发布。
  const articleText = [article.title, article.digest, article.content].filter(Boolean).join('\n');
  const absentSong = songs.find(song => {
    const songName = String(song.song_name || '');
    return !songName || (articleText.indexOf(songName) < 0 && articleText.indexOf(escapeHtml(songName)) < 0);
  });
  if (absentSong) {
    const error = new Error('每日推歌“' + absentSong.song_name + '”不在本次同步文章中');
    error.code = 'DAILY_SONG_NOT_IN_ARTICLE';
    throw error;
  }
  return songs;
}

function createDailySongMarkConflict(requested, affected) {
  const error = new Error('每日推歌状态已变化，仅成功标记 ' + affected + '/' + requested + ' 首；请刷新候选列表，勿重复同步已创建草稿');
  error.code = 'DAILY_SONG_MARK_CONFLICT';
  error.requested = requested;
  error.affected = affected;
  error.markResult = { requested, affected, changed: affected, affectedRows: affected };
  return error;
}

async function markDailySongsPublished(dbPool, ids) {
  if (!ids.length) return { requested: 0, affected: 0, changed: 0, affectedRows: 0 };
  const placeholders = ids.map(() => '?').join(',');
  const updateSql = `UPDATE daily_song_recs
     SET status = 'published',
         published_at = COALESCE(published_at, NOW())
     WHERE id IN (${placeholders})
       AND candidate_hidden_at IS NULL
       AND status IN ('pending', 'published')`;

  // 生产连接池走事务并锁定候选行：已发布且仍在三天复用窗口内的歌曲
  // 不需要再次改写 published_at，但仍要计入逻辑影响量；被管理员移出候选
  // 或在窗口内失效的行则明确报冲突，不能静默少标记。
  if (typeof dbPool.getConnection === 'function') {
    const connection = await dbPool.getConnection();
    let transactionStarted = false;
    try {
      await connection.beginTransaction();
      transactionStarted = true;
      const [rows] = await connection.execute(
        `SELECT id FROM daily_song_recs
         WHERE id IN (${placeholders})
           AND candidate_hidden_at IS NULL
           AND (status = 'pending' OR (status = 'published' AND COALESCE(published_at, created_at) >= DATE_SUB(NOW(), INTERVAL ${DAILY_SONG_REUSE_DAYS} DAY)))
         FOR UPDATE`,
        ids
      );
      const affected = Array.isArray(rows) ? rows.length : 0;
      if (affected !== ids.length) throw createDailySongMarkConflict(ids.length, affected);
      const [result] = await connection.execute(updateSql, ids);
      await connection.commit();
      transactionStarted = false;
      const changed = Number(result && result.affectedRows) || 0;
      return { requested: ids.length, affected, changed, affectedRows: changed };
    } catch (err) {
      if (transactionStarted) {
        try { await connection.rollback(); } catch (rollbackError) {}
      }
      throw err;
    } finally {
      connection.release();
    }
  }

  // 兼容离线测试使用的最小 executor，同时保留 affectedRows 校验。
  const [result] = await dbPool.execute(updateSql, ids);
  const affected = Number(result && result.affectedRows) || 0;
  if (affected !== ids.length) throw createDailySongMarkConflict(ids.length, affected);
  return { requested: ids.length, affected, changed: affected, affectedRows: affected };
}

// 草稿创建失败时绝不写入 published。若草稿已创建但状态更新失败，
// 在异常上挂出 mediaId，调用方必须把它作为“已创建、不可重试”的终态返回。
async function finalizeDailySongSync(createDraft, markPublished, articles, dailySongIds) {
  const mediaId = await createDraft(articles);
  try {
    if (dailySongIds.length) {
      const markResult = await markPublished(dailySongIds);
      if (!markResult || markResult.affected !== dailySongIds.length) {
        throw createDailySongMarkConflict(
          dailySongIds.length,
          markResult && Number.isSafeInteger(markResult.affected) ? markResult.affected : 0
        );
      }
    }
  } catch (err) {
    err.draftCreated = true;
    err.mediaId = mediaId;
    err.dailySongIds = dailySongIds.slice();
    if (!err.code) err.code = 'DAILY_SONG_MARK_FAILED';
    throw err;
  }
  return mediaId;
}

function formatDraftCreatedMarkFailure(err) {
  const mark = err && err.markResult;
  if (mark && Number.isSafeInteger(mark.requested) && Number.isSafeInteger(mark.affected)) {
    return '草稿已创建，但每日推歌状态只更新了 ' + mark.affected + '/' + mark.requested + ' 首；请刷新候选列表核对，勿重复同步此草稿';
  }
  return '草稿已创建，但每日推歌状态更新未确认；请先刷新候选列表和公众号草稿箱，勿重复同步此草稿';
}

function mpEscape(value) {
  return escapeHtml(value == null ? '' : String(value));
}

function addBusinessDays(dateValue, offsetDays) {
  const match = String(dateValue || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + offsetDays));
  return date.toISOString().slice(0, 10);
}

function formatMonthDay(dateValue) {
  const match = String(dateValue || '').match(/^\d{4}-(\d{2})-(\d{2})$/);
  return match ? (Number(match[1]) + '月' + Number(match[2]) + '日') : '';
}

function getWeeklySongScheduleRange(weekOffset) {
  const today = getChinaDate();
  const weekDay = getChinaDayOfWeek(today);
  const weekStart = addBusinessDays(today, 1 - weekDay);
  // 周末主要是在准备下一周的公众号内容：无参数时自动切到下周，
  // 但仍允许前端用 week=current 明确查看本周剩余安排。
  const normalizedOffset = weekOffset === 1 ? 1 : 0;
  const targetStart = addBusinessDays(weekStart, normalizedOffset * 7);
  const weekEnd = addBusinessDays(targetStart, 7);
  // “本周”按完整自然周展示，不能因为今天已经过了周一就漏掉本周前几天的排期；
  // 下周则从下周一开始，方便周末提前整理公众号内容。
  const scheduleStart = targetStart;
  const periodLabel = normalizedOffset === 1 ? '下周' : '本周';
  return {
    today,
    weekStart: targetStart,
    weekEnd,
    scheduleStart,
    weekOffset: normalizedOffset,
    periodLabel,
    label: formatMonthDay(scheduleStart) + '—' + formatMonthDay(addBusinessDays(weekEnd, -1))
  };
}

function parseWeeklySongWeekOffset(value, today) {
  if (value === 'next' || value === '1' || value === 1) return 1;
  if (value === 'current' || value === '0' || value === 0) return 0;
  // 中国时区周六、周日默认准备下周；工作日仍显示本周剩余安排。
  return getChinaDayOfWeek(today) >= 6 ? 1 : 0;
}

// 公众号推送及其素材接口属于最高管理员专属能力，普通广播推送员不可进入或调用。
router.use(auth, isStaff, superAdminOnly);

// 推送页封面提示词走 /api/mp/，避免部分站点防火墙把 /api/admin/ 下的 AI 请求误判为后台高频接口。
// 必须放在统一 auth 之后，确保 requirePermission 能拿到已解析的 req.user。
router.post('/cover-prompt', requirePermission('songs:review'), async (req, res) => {
  try {
    const data = await generateCoverPrompt(req.body);
    res.json({ code: 200, data: data });
  } catch (err) {
    const status = Number(err.status) || 502;
    if (status >= 500) console.error('[AI] 生成封面提示词失败:', err.message);
    res.status(status).json({ code: status, message: err.message || '封面提示词生成失败，请稍后重试' });
  }
});

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
  // 同一份 article 先按服务端规则标准化，再按既有顺序处理视频永久素材和正文图片。
  var articleCopy = mpDraftService.normalizeDraftArticle(JSON.parse(JSON.stringify(article)));
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

const PUBLIC_WALL_ORIGIN = (process.env.PUBLIC_WALL_ORIGIN || 'http://localhost:3000').replace(/\/$/, '');

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
function formatRichTextInline(text) {
  var safe = mpEscape(String(text || ''));
  return safe
    .replace(/\*\*\*([^*\n]+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+?)\*(?!\*)/g, '<em>$1</em>');
}

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
    return '<p style="text-indent:2em;line-height:2.1;margin-bottom:14px;font-size:15px;color:#444;margin-top:0;letter-spacing:0.5px;">' + formatRichTextInline(b.trim()) + '</p>';
  }).join('\n');
}

/**
 * 生成精美卡片HTML（卡哇伊风，兼容微信编辑器）
 */
function generateTextStatsHTML(readMinutes, postCount) {
  var html = '<!-- mp-text-stats-start --><table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;table-layout:fixed;border-collapse:collapse;"><tr><td style="background:#FFFFF0;padding:12px;border-radius:10px;">';
  html += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100% !important;table-layout:fixed;border-collapse:collapse;"><tr>';
  html += '<td width="31.33%" style="width:31.33% !important;text-align:center;padding:6px 0;border-right:1px dashed #E8D5B5;overflow:hidden;"><div style="font-size:15px;font-weight:bold;color:#D4876A;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">__MP_VISIBLE_TEXT_COUNT__</div><div style="font-size:11px;color:#756b78;margin-top:3px;white-space:nowrap;">全文字数</div></td>';
  html += '<td width="3%" style="width:3% !important;padding:0;font-size:0;line-height:0;">&nbsp;</td>';
  html += '<td width="31.33%" style="width:31.33% !important;text-align:center;padding:6px 0;border-right:1px dashed #E8D5B5;overflow:hidden;"><div style="font-size:15px;font-weight:bold;color:#8A5AA8;line-height:1.2;white-space:nowrap;">' + readMinutes + '</div><div style="font-size:11px;color:#756b78;margin-top:3px;white-space:nowrap;">阅读分钟</div></td>';
  html += '<td width="3%" style="width:3% !important;padding:0;font-size:0;line-height:0;">&nbsp;</td>';
  html += '<td width="31.33%" style="width:31.33% !important;text-align:center;padding:6px 0;overflow:hidden;"><div style="font-size:15px;font-weight:bold;color:#C23F78;line-height:1.2;white-space:nowrap;">' + postCount + '</div><div style="font-size:11px;color:#756b78;margin-top:3px;white-space:nowrap;">精选帖子</div></td>';
  html += '</tr></table></td></tr></table><!-- mp-text-stats-end -->';
  return html;
}

function generateWeatherMetaHTML(value, icon) {
  var clean = String(value || '').trim();
  var content = clean ? (icon + ' ' + mpEscape(clean)) : '&nbsp;';
  return '<div style="font-size:11px;color:#999;margin-top:4px;line-height:16px;min-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + content + '</div>';
}

function generateCardHTML(posts, weather, hitokoto, dateInfo, stats, categories, songs, todayHistory, weeklyStar, commentsByPost, includeGaokao, dailySongs, includeSongs, articleTitle) {
  const today = dateInfo.date;
  const week = dateInfo.week;
  const safeArticleTitle = mpEscape(articleTitle || '校园来信');

  var html = '';
  html += '<div style="padding:6px 0;">';

  // ===== 头部 =====
  html += '<table width="100%" cellpadding="0" cellspacing="0"><tr><td style="background:linear-gradient(135deg,#FFF0F5,#F8F0FF);padding:22px 16px 18px;text-align:center;">';
  html += '<div style="color:#A78BFA;font-size:13px;margin-bottom:6px;letter-spacing:1px;">示例校园校园墙 · 校园来信</div>';
  html += '<div style="color:#FF69B4;font-size:22px;font-weight:bold;letter-spacing:0.5px;line-height:1.45;">' + safeArticleTitle + '</div>';
  html += '<div style="color:#999;font-size:12px;margin-top:8px;">' + mpEscape(today) + ' ' + mpEscape(week) + ' · 把今天的校园日常，写给你</div>';
  html += '<div style="width:40px;height:3px;background:linear-gradient(90deg,#FFB6C1,#A78BFA);margin:14px auto 0;"></div>';
  html += '</td></tr></table>';

  // ===== 阅读信息 =====
  var totalChars = 0;
  for (var pc = 0; pc < posts.length; pc++) {
    totalChars += (posts[pc].content || '').replace(/\s/g, '').length;
  }
  var readMinutes = Math.max(1, Math.ceil(totalChars / 300));
  html += generateTextStatsHTML(readMinutes, posts.length);

  // ===== 天气卡片 =====
  if (weather && weather.temperature) {
    html += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;"><tr><td style="background:linear-gradient(135deg,#E8F4FD,#E0F0FF);padding:16px;">';
    html += '<div style="font-size:13px;color:#666;margin-bottom:10px;font-weight:600;">☁️ ' + mpEscape(weather.city || '') + ' 校园天气</div>';
    // 微信手机端不依赖 flex；单元格无内边距，间距单独占 4%，避免百分比宽度和 padding 被叠加计算。
    html += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100% !important;table-layout:fixed;border-collapse:collapse;"><tr>';
    html += '<td width="48%" style="width:48% !important;vertical-align:top;text-align:center;padding:0;overflow:hidden;">';
    html += '<div style="box-sizing:border-box;overflow:hidden;padding:8px 2px;border-right:1px dashed #B0D4F1;">';
    html += '<div style="font-size:11px;color:#aaa;margin-bottom:4px;">今日</div>';
    html += '<div style="font-size:17px;font-weight:bold;color:#4A90D9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + mpEscape(weather.icon || '☀️') + ' ' + mpEscape(weather.temperature || '') + '</div>';
    html += '<div style="font-size:12px;color:#666;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + mpEscape(weather.weather || '') + '</div>';
    html += generateWeatherMetaHTML(weather.wind, '💨');
    html += generateWeatherMetaHTML(weather.humidity, '💧');
    html += '</div></td><td width="4%" style="width:4% !important;padding:0;font-size:0;line-height:0;">&nbsp;</td>';
    if (weather.tomorrow) {
      html += '<td width="48%" style="width:48% !important;vertical-align:top;text-align:center;padding:0;overflow:hidden;">';
      html += '<div style="box-sizing:border-box;overflow:hidden;padding:8px 2px;">';
      html += '<div style="font-size:11px;color:#aaa;margin-bottom:4px;">明日 ' + mpEscape(weather.tomorrow.week || '') + '</div>';
      html += '<div style="font-size:17px;font-weight:bold;color:#4A90D9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + mpEscape(weather.tomorrow.icon || '☀️') + ' ' + mpEscape(weather.tomorrow.tempRange || '') + '</div>';
      html += '<div style="font-size:12px;color:#666;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + mpEscape(weather.tomorrow.weather || '') + '</div>';
      html += generateWeatherMetaHTML(weather.tomorrow.wind, '💨');
      html += generateWeatherMetaHTML(weather.tomorrow.humidity, '💧');
      html += '</div></td>';
    } else {
      html += '<td width="48%" style="width:48% !important;vertical-align:top;text-align:center;padding:8px 2px;color:#999;font-size:12px;">明日预报暂未更新</td>';
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
      html += '<div style="font-size:14px;color:#555;line-height:1.6;">🎶 <strong>' + mpEscape(s.song_name || '') + '</strong>' + (s.artist ? ' - <span style="color:#aaa;">' + mpEscape(s.artist) + '</span>' : '') + '</div>';
      html += '<div style="font-size:12px;color:#bbb;margin-top:3px;line-height:1.5;">';
      if (s.slot_name || s.play_date || s.req_date) html += '📅 ' + mpEscape(s.slot_name || '') + ((s.play_date || s.req_date) ? ' · ' + mpEscape(s.play_date || s.req_date) : '') + (s.start_time && s.end_time ? ' ' + mpEscape(s.start_time.substring(0,5)) + '-' + mpEscape(s.end_time.substring(0,5)) : '');
      if (s.message) html += ' &nbsp;💬 ' + mpEscape(s.message); // 不再截断点歌留言
      if (s.to_whom) html += ' &nbsp;💝 ' + mpEscape(s.to_whom);
      html += ' &nbsp;👤 ' + mpEscape(authorStr);
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
    for (var wsStart = 0; wsStart < weeklyStar.length; wsStart += 3) {
      var wsRow = weeklyStar.slice(wsStart, wsStart + 3);
      var wsWidth = ((100 - ((wsRow.length - 1) * 2)) / wsRow.length).toFixed(2) + '%';
    html += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100% !important;table-layout:fixed;border-collapse:collapse;' + (wsStart ? 'margin-top:8px;' : '') + '"><tr>';
      for (var wi = 0; wi < wsRow.length; wi++) {
        var w = wsRow[wi];
        var wName = w.nickname || w.username || '同学';
        if (wi > 0) html += '<td width="2%" style="width:2% !important;padding:0;font-size:0;line-height:0;">&nbsp;</td>';
        html += '<td width="' + wsWidth + '" style="width:' + wsWidth + ' !important;text-align:center;vertical-align:top;padding:0;overflow:hidden;">';
        html += '<div style="width:100%;box-sizing:border-box;overflow:hidden;">';
        html += '<div style="font-size:20px;">' + (medals[(wsStart + wi) % medals.length] || '🏅') + '</div>';
        html += '<div style="font-weight:600;font-size:13px;color:#555;margin-top:4px;word-break:break-all;">' + escapeHtml(wName) + '</div>';
        html += '<div style="font-size:11px;color:#bbb;margin-top:2px;word-break:break-all;">📝' + (w.post_count || 0) + ' 💬' + (w.comment_count || 0) + '</div>';
        html += '</div></td>';
      }
      html += '</tr></table>';
    }
    html += '</td></tr></table>';
  }

  // ===== 每日推歌卡片 =====
  if (dailySongs && dailySongs.length > 0) {
    html += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;"><tr><td style="background:#FFF0F5;padding:14px;">';
    html += '<div style="font-size:13px;color:#A2376C;font-weight:700;margin-bottom:10px;">🎵 一首歌的时间</div>';
    for (var si = 0; si < dailySongs.length; si++) {
      var s = dailySongs[si];
      html += '<div style="border-top:' + (si > 0 ? '1px dashed #FFD1DC;' : 'none;') + ';padding:10px 0;">';
      html += '<div style="font-size:15px;color:#2E2438;line-height:1.6;">🎶 <strong>' + escapeHtml(s.song_name || '') + '</strong>' + (s.artist ? ' - <span style="color:#75677B;">' + escapeHtml(s.artist) + '</span>' : '') + '</div>';
      html += '<div style="font-size:12px;color:#6F6077;margin-top:4px;line-height:1.5;">';
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
      coverImgs += (ii > 0 ? '<div style="border-top:1px dashed #eee;margin:8px 0;"></div>' : '') + '<img src="' + mpEscape(allImgs[ii]) + '" style="width:100%;" alt="帖子配图">';
    }
    var videoHtml = buildPostVideoHTML(p);
    var safeTitle = (p.title || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    var content = p.content || ''; // 富文本标记在 autoFormatContent 内安全转换

    html += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:18px;"><tr><td style="border-top:3px solid ' + c + ';background:' + bg + ';padding:16px;">';
    html += '<div style="color:' + c + ';font-weight:bold;font-size:13px;margin-bottom:6px;">#' + (i+1) + ' · 热门帖子</div>';
    html += '<div style="font-weight:bold;font-size:18px;color:#333;margin-bottom:8px;line-height:1.4;">' + safeTitle + '</div>';
    html += coverImgs;
    html += videoHtml;
    html += '<div style="margin:12px 0 0 0;">' + autoFormatContent(content) + '</div>';
    html += '<div style="font-size:13px;color:#bbb;margin-top:12px;padding-top:10px;border-top:1px solid #eee;line-height:1.6;">';
    html += '👤 ' + mpEscape(p.author || '匿名同学') + '&nbsp;&nbsp;&nbsp;❤️ ' + (p.likes_count || 0) + '&nbsp;&nbsp;&nbsp;💬 ' + (p.comment_count || 0) + '</div>';
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
  html += '<div style="font-size:18px;color:#FF69B4;font-weight:bold;margin-bottom:6px;">🌸 示例校园校园墙</div>';
  html += '<div style="font-size:13px;color:#DDA0DD;margin-bottom:16px;">同学正在发生的事，等你来聊</div>';
  html += '<table align="center" style="margin:0 auto;"><tr><td style="background:linear-gradient(135deg,#FF69B4,#FFB6C1);padding:4px;border-radius:16px;">';
  html += '<table style="width:100%;background:#fff;border-radius:12px;"><tr><td style="padding:12px;">';
  html += '<img src="http://localhost:3000/images/gzh.jpg" style="width:200px;display:block;border-radius:6px;margin:0 auto;height:auto;" alt="校园墙二维码">';
  html += '</td></tr></table>';
  html += '</td></tr></table>';
  html += '<p style="color:#bbb;font-size:12px;margin:14px 0 4px 0;letter-spacing:1px;">📱 微信扫一扫 · 获取更多精彩</p>';
  html += '<p style="color:#FF69B4;font-size:13px;font-weight:bold;word-break:break-all;letter-spacing:0.5px;">http://localhost:3000</p>';
  html += '<div style="width:40px;height:2px;background:#FFB6C1;margin:12px auto 0;border-radius:2px;"></div>';
  html += '</td></tr></table>';
  html += '<p style="text-align:center;color:#ddd;font-size:12px;margin-top:18px;">❀ ' + dateInfo.year + ' 示例校园校园墙 ❀ ❀</p>';
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
    // 每日推歌是最高管理员专属能力；普通广播推送员只能生成普通图文。
    const canPushDailySongs = req.user && req.user.role === 'super_admin';
    const includeDailySongs = canPushDailySongs && includeSongs !== false;

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

    var dailySongs = (includeDailySongs && Array.isArray(req.body.dailySongs)) ? req.body.dailySongs : [];
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
      const titleInfo = mpDraftService.generateArticleTitle({
        type: 'daily', posts: posts, songs: dailySongs, dateInfo: dateInfo
      });
      const contentHtml = generateCardHTML(posts, weather, hitokoto, dateInfo, stats, categories, songReq, todayHistory, weeklyStar, commentsByPost, includeGaokao, dailySongs, includeDailySongs, titleInfo.title);

      articles.push(mpDraftService.normalizeDraftArticle({
        title: titleInfo.title,
        title_meta: titleInfo.meta,
        author: '示例校园校园墙',
        digest: titleInfo.digest,
        content: contentHtml,
        content_source_url: 'http://localhost:3000',
        show_cover_pic: 1,
        need_open_comment: 1,
        only_fans_can_comment: 0
      }));
    } else {
      // 单篇帖子
      posts.forEach(post => {
        var postImages = [];
        try { postImages = JSON.parse(post.images || '[]'); } catch (e) {}
        if (!Array.isArray(postImages)) postImages = [];
        const coverImg = postImages.map(function(src) {
          return '<img src="' + mpEscape(src) + '" style="width:100%;margin:10px 0;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.1);">';
        }).join('');
        const videoHtml = buildPostVideoHTML(post);
        const titleInfo = mpDraftService.generateArticleTitle({ type: 'post', post: post, dateInfo: dateInfo });

        const rawContent = post.content || '';
        const safeTitle = (post.title || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        const safeAuthor = (post.author || '匿名').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        var postChars = (post.content || '').replace(/\s/g, '').length;
        var postReadMin = Math.max(1, Math.ceil(postChars / 300));
        var readingCard = generateTextStatsHTML(postReadMin, 1);
        const contentHtml = `
          <section style="padding: 20px; font-family: -apple-system, sans-serif;">
            <div style="color:#A78BFA;font-size:12px;letter-spacing:1px;margin-bottom:6px;">示例校园校园墙 · 想和你说</div>
            <h2 style="color: #667eea; font-size: 22px;line-height:1.45;">${mpEscape(titleInfo.title)}</h2>
            ${coverImg}
            ${videoHtml}
            ${readingCard}
            ${autoFormatContent(rawContent)}
            <section style="margin-top: 25px; padding: 15px; background: #f8f9fa; border-radius: 8px; display: flex; justify-content: space-between; font-size: 13px; color: #999;">
              <span>👤 ${safeAuthor}</span>
              <span>❤️ ${post.likes_count} 赞</span>
              <span>🕒 ${new Date(post.created_at).toLocaleString('zh-CN')}</span>
            </section>
          </section>
        `;

        articles.push(mpDraftService.normalizeDraftArticle({
          title: titleInfo.title,
          title_meta: titleInfo.meta,
          author: post.author || '匿名',
          digest: titleInfo.digest,
          content: contentHtml,
          content_source_url: `http://localhost:3000/post/${post.id}`,
          show_cover_pic: 1,
          need_open_comment: 1,
          only_fans_can_comment: 0
        }));
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
router.get('/daily-songs', superAdminOnly, async (req, res) => {
  try {
    const { status } = req.query;
    const candidate = req.query.candidate === '1' || req.query.candidate === 'true';
    const limit = getPagination(req.query, { defaultLimit: 20, maxLimit: 50 }).limit;
    let sql = 'SELECT * FROM daily_song_recs WHERE 1=1';
    const params = [];

    if (candidate) {
      sql += ' AND ' + dailySongCandidateSql();
    } else if (status) {
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
 * 本周待播放点歌单。只读取已审核、排期仍开放的点歌；与每日推歌发布状态完全独立。
 * GET /api/mp/weekly-song-schedule
 */
router.get('/weekly-song-schedule', superAdminOnly, async (req, res) => {
  try {
    const range = getWeeklySongScheduleRange(parseWeeklySongWeekOffset(req.query.week, getChinaDate()));
    const [songs] = await pool.execute(`
      SELECT sr.id, sr.song_name, sr.artist, sr.message, sr.to_whom, sr.is_anonymous, sr.play_order,
             COALESCE(u.nickname, u.username) AS requester_name,
             DATE_FORMAT(sd.play_date, '%Y-%m-%d') AS play_date,
             DATE_FORMAT(sd.play_date, '%m月%d日') AS play_date_label,
             CASE DAYOFWEEK(sd.play_date)
               WHEN 1 THEN '周日' WHEN 2 THEN '周一' WHEN 3 THEN '周二' WHEN 4 THEN '周三'
               WHEN 5 THEN '周四' WHEN 6 THEN '周五' ELSE '周六'
             END AS weekday,
             ts.name AS slot_name,
             TIME_FORMAT(ts.start_time, '%H:%i') AS start_time,
             TIME_FORMAT(ts.end_time, '%H:%i') AS end_time
      FROM song_requests sr
      JOIN slot_dates sd ON sr.slot_date_id = sd.id
      JOIN time_slots ts ON sd.slot_id = ts.id
      LEFT JOIN users u ON sr.user_id = u.id
      WHERE sr.status = 'approved' AND sr.deleted_at IS NULL
        AND sd.is_active = 1 AND ts.is_active = 1
        AND (ts.effective_start_date IS NULL OR sd.play_date >= ts.effective_start_date)
        AND sd.play_date >= ? AND sd.play_date < ?
      ORDER BY sd.play_date, ts.start_time, COALESCE(sr.play_order, 2147483647), sr.created_at, sr.id
    `, [range.scheduleStart, range.weekEnd]);
    const titleInfo = mpDraftService.generateArticleTitle({
      type: 'weekly-song', songs, weekLabel: range.label, periodLabel: range.periodLabel
    });
    res.json({
      code: 200,
      data: {
        songs,
        week_start: range.weekStart,
        schedule_start: range.scheduleStart,
        week_end: addBusinessDays(range.weekEnd, -1),
        week_label: range.label,
        period_label: range.periodLabel,
        week_offset: range.weekOffset,
        title: titleInfo.title,
        digest: titleInfo.digest,
        title_meta: titleInfo.meta
      }
    });
  } catch (err) {
    console.error('[MP素材] 获取本周点歌排期失败:', err.message);
    res.json({ code: 500, message: '获取本周点歌排期失败，请稍后重试' });
  }
});

/**
 * 一键生成并发布今日精选（增强版）
 * POST /api/mp/publish-daily
 */
router.post('/publish-daily', requirePermission('songs:review'), async (req, res) => {
  try {
    const canPushDailySongs = req.user && req.user.role === 'super_admin';
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

    // 仅取未发布，或已同步未满三天、可调整后复用的歌曲。
    var dailySongs = [];
    try {
      if (!canPushDailySongs) {
        dailySongs = [];
      } else {
        dailySongs = await pool.execute(
          'SELECT * FROM daily_song_recs WHERE ' + dailySongCandidateSql() + ' ORDER BY CASE WHEN status = "pending" THEN 0 ELSE 1 END, created_at DESC LIMIT 10'
        ).then(r => r[0]);
      }
    } catch(e) {}

    const titleInfo = mpDraftService.generateArticleTitle({
      type: 'daily', posts: posts, songs: dailySongs, dateInfo: dateInfo
    });
    // 3. 标题、摘要与正文先组成同一个 article，再直接发送到草稿箱。
    const contentHtml = generateCardHTML(posts, weather, hitokoto, dateInfo, null, null, [], null, [], {}, true, dailySongs, canPushDailySongs, titleInfo.title);

    const articles = [mpDraftService.normalizeDraftArticle({
      title: titleInfo.title,
      title_meta: titleInfo.meta,
      author: '示例校园校园墙',
      digest: titleInfo.digest,
      content: contentHtml,
      content_source_url: 'http://localhost:3000',
      show_cover_pic: 1,
      need_open_comment: 1,
      only_fans_can_comment: 0
    })];

    // 4. 和手动同步走同一套媒体处理链：视频上传永久素材，图片上传微信 CDN。
    // 过去这里直接 createDraft，导致“一键发布”只生成站内视频占位卡，视频并未同步。
    const prepared = await prepareArticleForWeixin(articles[0]);
    const videoFailureDetails = formatVideoFailureDetails(prepared.video);
    const hasVideoFailures = Boolean(prepared.video && prepared.video.failed > 0);
    // 草稿创建成功后，才将本次实际包含的每日推歌推进为已发布。
    // 先完成既有的视频转码/永久素材和图片 CDN 链路，不能绕开该顺序。
    const dailySongIds = dailySongs.map(song => song.id).filter(Number.isSafeInteger);
    const mediaId = await finalizeDailySongSync(
      draftArticles => mpDraftService.createDraft(draftArticles),
      ids => markDailySongsPublished(pool, ids),
      [prepared.article],
      dailySongIds
    );

    res.json({
      // 草稿创建成功就是本次同步的终态；视频失败仅作为草稿内的明确警告，
      // 因为每日推歌已经按同一草稿成功标记，不能提示用户重新同步。
      code: 200,
      data: { 
        media_id: mediaId,
        post_count: posts.length,
        weather: weather ? `${weather.icon} ${weather.temperature}` : null,
        hitokoto: hitokoto ? hitokoto.text.substring(0, 30) + '...' : null,
        image: prepared.image,
        video: prepared.video,
        sync_status: hasVideoFailures ? 'done_with_video_warning' : 'done',
        daily_song_count: dailySongIds.length,
        failure_reason: videoFailureDetails || null,
        text_stats: prepared.article.text_stats
      },
      message: hasVideoFailures
        ? '草稿已创建，但视频素材同步失败：' + videoFailureDetails + '；正文已保留封面和站内观看入口；每日推歌已按草稿标记，请勿重复同步'
        : '草稿创建成功，请在公众号后台审核后发布'
    });
  } catch (err) {
    console.error('[MP素材] 一键发布失败:', err.message);
    if (err && err.draftCreated) {
      return res.status(409).json({
        code: 409,
        data: {
          media_id: err.mediaId,
          sync_status: 'draft_created_mark_failed',
          daily_song_ids: err.dailySongIds || [],
          mark_result: err.markResult || null
        },
        message: formatDraftCreatedMarkFailure(err)
      });
    }
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
if (syncCleanupTimer && syncCleanupTimer.unref) syncCleanupTimer.unref();

/**
 * 同步草稿到公众号（图片上传到微信CDN，视频上传为永久 MP4 素材）
 * POST /api/mp/sync-draft
 */
router.post('/sync-draft', requirePermission('songs:review'), async (req, res) => {
  var { article, dailySongIds } = req.body;
  if (!article || typeof article !== 'object') {
    return res.json({ code: 400, message: '请先生成图文内容' });
  }
  if (!article.title || !String(article.title).trim()) {
    return res.json({ code: 400, message: '文章标题不能为空' });
  }
  if (!article.content || !String(article.content).trim()) {
    return res.json({ code: 400, message: '文章正文不能为空' });
  }

  const normalizedSongIds = normalizeDailySongIds(dailySongIds);
  if (!normalizedSongIds.ok) {
    return res.status(400).json({ code: 400, message: '每日推歌参数无效' });
  }
  if (normalizedSongIds.ids.length > 0 && (!req.user || req.user.role !== 'super_admin')) {
    return res.status(403).json({ code: 403, message: '仅超级管理员可同步每日推歌' });
  }

  let syncedDailySongs;
  try {
    syncedDailySongs = await getSyncableDailySongs(pool, normalizedSongIds.ids, article);
  } catch (err) {
    const status = err.code === 'DAILY_SONG_NOT_SYNCABLE' || err.code === 'DAILY_SONG_NOT_IN_ARTICLE' ? 409 : 500;
    return res.status(status).json({ code: status, message: err.message || '每日推歌校验失败' });
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
    video: { total: videoCount, success: 0, failed: 0, items: [] },
    daily_song_count: syncedDailySongs.length,
    daily_song_ids: normalizedSongIds.ids
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

      var video = prepared.video;
      var videoFailureDetails = formatVideoFailureDetails(video);
      var hasVideoFailures = Boolean(video && video.failed > 0);
      var videoMessage = video.total > 0
        ? '，视频成功 ' + video.success + '/' + video.total + (video.failed > 0 ? '，失败 ' + video.failed + '（正文已保留封面和观看入口）' : '')
        : '';
      var currentState = pendingSyncs[syncId] || {};
      // 仅在本次草稿真正创建成功后标记实际随文同步的歌曲；预览和异常路径不会写状态。
      var mediaId = await finalizeDailySongSync(
        draftArticles => mpDraftService.createDraft(draftArticles),
        ids => markDailySongsPublished(pool, ids),
        [articleCopy],
        normalizedSongIds.ids
      );
      pendingSyncs[syncId] = {
        // 草稿创建成功就是同步终态；视频失败保留为可见警告，避免歌曲已经标记
        // 后前端显示普通失败并再次创建重复草稿。
        status: 'done',
        sync_status: hasVideoFailures ? 'done_with_video_warning' : 'done',
        msg: hasVideoFailures
          ? '草稿已创建；视频素材处理失败（' + videoFailureDetails + '），正文已保留封面和观看入口；每日推歌已按草稿标记，请勿重复同步'
          : '同步成功（图片 ' + prepared.image.success + '/' + prepared.image.total + videoMessage + '）',
        media_id: mediaId,
        image: prepared.image,
        video: video,
        failure_reason: videoFailureDetails || null,
        text_stats: articleCopy.text_stats,
        createdAt: currentState.createdAt || createdAt,
        ownerId: ownerId,
        daily_song_count: syncedDailySongs.length,
        daily_song_ids: normalizedSongIds.ids
      };
    } catch (err) {
      console.error('[MP同步] 后台失败:', err.message);
      if (err && err.draftCreated) {
        const currentState = pendingSyncs[syncId] || {};
        pendingSyncs[syncId] = {
          // 草稿已经存在，必须让前端看到终态并阻止用户按普通失败重试。
          status: 'done',
          sync_status: 'draft_created_mark_failed',
          msg: formatDraftCreatedMarkFailure(err),
          media_id: err.mediaId,
          failure_reason: err.message,
          image: currentState.image,
          video: currentState.video,
          createdAt: currentState.createdAt || createdAt,
          ownerId: ownerId,
          daily_song_count: syncedDailySongs.length,
          daily_song_ids: normalizedSongIds.ids,
          mark_result: err.markResult || null
        };
        return;
      }
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

// 仅供离线状态机测试使用；不暴露为 HTTP 接口。
router._dailySongState = {
  DAILY_SONG_REUSE_DAYS,
  normalizeDailySongIds,
  isDailySongCandidate,
  dailySongCandidateSql,
  markDailySongsPublished,
  finalizeDailySongSync,
  formatDraftCreatedMarkFailure
};

module.exports = router;
