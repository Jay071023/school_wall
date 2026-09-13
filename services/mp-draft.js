/**
 * 微信公众号素材服务
 * 用于将校墙热点内容上传到公众号草稿箱，供手动发布
 * 包含天气、一言等丰富内容
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

// 本地静态文件根路径（用于本地图片/视频不走 HTTP）
const LOCAL_ROOT = path.resolve(__dirname, '..', 'public');
// 微信永久视频素材接口的边界：10 MB，最终上传内容必须是 MP4。
const MP_PERMANENT_VIDEO_MAX_BYTES = 10 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 12 * 1024 * 1024;
const MP_VIDEO_SOURCE_MAX_BYTES = 50 * 1024 * 1024;
const MP_VIDEO_TRANSCODE_TIMEOUT_MS = 180000;
const MP_VIDEO_PROBE_TIMEOUT_MS = 15000;
const MP_VIDEO_TEMP_PREFIX = 'campus-wall-mp-video-';
const CONTROLLED_VIDEO_RELATIVE_RE = /^uploads\/videos\/video_[A-Za-z0-9_-]+\.(?:mp4|webm|ogv)$/i;
const PUBLIC_WALL_ORIGIN = (process.env.PUBLIC_WALL_ORIGIN || 'http://localhost:3000').replace(/\/$/, '');
const FFMPEG_COMMAND = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE_COMMAND = process.env.FFPROBE_PATH || 'ffprobe';

// 微信公众号配置（与 wechat.js 共用 wechat-token.js 统一缓存）
const WECHAT_APPID = process.env.WECHAT_APPID || 'wx513226ad98127a0d';
const WECHAT_SECRET = process.env.WECHAT_SECRET;
if (!WECHAT_SECRET) {
  throw new Error('[mp-draft] 缺少环境变量 WECHAT_SECRET，请检查 .env 配置');
}
const { getAccessToken } = require('./wechat-token');
const CONFIG = {
  // 天气API配置（使用和风天气免费版）
  WEATHER_API_KEY: process.env.WEATHER_API_KEY || '',
  WEATHER_CITY: process.env.WEATHER_CITY || '上海', // 默认城市
  
  // 一言API配置
  HITOKOTO_API: 'https://v1.hitokoto.cn/?c=i&c=d&c=k', // 诗词、文学、动画
};

// 公众号标题应简洁、可读，并且只能来自已选内容。这里不调用 AI：草稿预览和一键发布
// 需要同一份可复现的标题，运营人员也能准确知道标题为何这样生成。
const ARTICLE_TITLE_MAX_LENGTH = 64;
const ARTICLE_DIGEST_MAX_LENGTH = 120;

function truncateText(value, maxLength) {
  var chars = Array.from(String(value || ''));
  if (chars.length <= maxLength) return chars.join('');
  return chars.slice(0, Math.max(1, maxLength - 1)).join('') + '…';
}

/**
 * 将投稿/歌曲等用户输入收敛成可以直接传给公众号 API 的纯文本。
 * 不解码 HTML 实体，避免把实体形式的标签重新变成可执行标记。
 */
function sanitizeArticleText(value, maxLength) {
  var text = String(value == null ? '' : value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g, ' ')
    .replace(/[<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return truncateText(text, maxLength || ARTICLE_TITLE_MAX_LENGTH);
}

/**
 * 预览、同步和微信 draft/add 共用这一份标准化结果。
 * 除标题/摘要外完全保留调用方字段（包括视频媒体字段、URL 和封面信息）。
 */
function normalizeDraftArticle(article) {
  var normalized = Object.assign({}, article || {});
  normalized.title = sanitizeArticleText(normalized.title || normalized.digest, ARTICLE_TITLE_MAX_LENGTH) || '校园新鲜事';
  normalized.digest = sanitizeArticleText(normalized.digest || normalized.title, ARTICLE_DIGEST_MAX_LENGTH) || normalized.title;
  return normalized;
}

/**
 * 微信 draft/add 的单篇文章 payload。调用方可离线验证此结构，避免预览与实际发送漂移。
 */
function toWechatDraftArticle(article) {
  article = normalizeDraftArticle(article);
  // 先复制调用方完整对象，再覆写微信公众号的标准文章字段。视频 media_id、
  // 转码结果、站内 URL 等非标准字段也必须随对象保留，供后续媒体处理链使用。
  var payload = Object.assign({}, article);
  function normalizeFlag(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    return value === false || value === 0 || value === '0' ? 0 : 1;
  }

  payload.title = article.title;
  payload.author = article.author || '示例校园校园墙';
  payload.digest = article.digest;
  payload.content_source_url = article.content_source_url || 'http://localhost:3000';
  payload.show_cover_pic = normalizeFlag(article.show_cover_pic, 1);
  payload.need_open_comment = normalizeFlag(article.need_open_comment, 1);
  payload.only_fans_can_comment = normalizeFlag(article.only_fans_can_comment, 0);
  return payload;
}

function getDateLabel(dateInfo) {
  var raw = sanitizeArticleText(dateInfo && dateInfo.date, 32);
  var match = raw.match(/(?:\d{4}年)?(\d{1,2})月(\d{1,2})日/);
  return match ? (match[1] + '月' + match[2] + '日') : '';
}

function getPostTopics(posts, maxTopics) {
  var topics = [];
  var seen = {};
  (Array.isArray(posts) ? posts : []).forEach(function(post) {
    if (topics.length >= (maxTopics || 2)) return;
    post = post || {};
    var topic = sanitizeArticleText(post.title, 22) || sanitizeArticleText(post.content, 22);
    if (!topic || seen[topic]) return;
    seen[topic] = true;
    topics.push(topic);
  });
  return topics;
}

function getSongTopics(songs, maxSongs) {
  var topics = [];
  var seen = {};
  (Array.isArray(songs) ? songs : []).forEach(function(song) {
    if (topics.length >= (maxSongs || 2)) return;
    song = song || {};
    var name = sanitizeArticleText(song.song_name || song.title || song.name, 20);
    var artist = sanitizeArticleText(song.artist || song.singer, 16);
    var topic = name ? ('《' + name + '》' + (artist ? '—' + artist : '')) : '';
    if (!topic || seen[topic]) return;
    seen[topic] = true;
    topics.push(topic);
  });
  return topics;
}

function makeTopicSuffix(topics, total, unit) {
  if (topics.length === 0) return '';
  var suffix = topics.join('、');
  if (total > topics.length) suffix += '等' + total + unit;
  return suffix;
}

/**
 * 基于真实投稿或歌曲生成一个可读、不过度承诺的公众号标题和摘要。
 * type: daily | post | song | weekly-song；其它值会按单篇帖子处理，便于旧调用方渐进接入。
 */
function generateArticleTitle(options) {
  options = options || {};
  var type = String(options.type || 'post').toLowerCase();
  var posts = Array.isArray(options.posts) ? options.posts : [];
  var songs = Array.isArray(options.songs) ? options.songs : [];
  var dateLabel = getDateLabel(options.dateInfo);
  var title;
  var digest;
  var topics;

  if (type === 'weekly-song') {
    var weeklyLabel = sanitizeArticleText(options.weekLabel, 32) || dateLabel;
    var periodLabel = sanitizeArticleText(options.periodLabel, 8) || '本周';
    title = weeklyLabel ? (periodLabel + '点歌播放表｜' + weeklyLabel) : (periodLabel + '点歌播放表');
    digest = songs.length
      ? (periodLabel + '待播放 ' + songs.length + ' 首点歌，已按日期和时段排好。')
      : (periodLabel + '待播放点歌已按日期和时段排好。');
  } else if (type === 'song' || (type === 'daily' && posts.length === 0 && songs.length > 0)) {
    topics = getSongTopics(songs, 2);
    var songSuffix = makeTopicSuffix(topics, songs.length, '首');
    title = songSuffix ? ('一首歌的时间｜' + songSuffix) : '一首歌的时间｜今天想分享给你';
    digest = songSuffix ? ('留一点时间给 ' + songSuffix + '，愿它陪你度过一段校园时光。') : '今天挑了几首歌，想和你分享。';
    type = 'song';
  } else if (type === 'daily') {
    topics = getPostTopics(posts, 2);
    var postSuffix = makeTopicSuffix(topics, posts.length, '个话题');
    var letterSuffix = postSuffix.replace(/等(\d+)个话题$/, '等$1封来信');
    var songTopics = getSongTopics(songs, 1);
    var featuredSong = songTopics[0] || '';
    if (featuredSong) {
      // 合集同时带有来信和推歌时，标题与摘要都要让读者一眼知道两种内容，
      // 不使用“今晚”之类依赖实际发送时间的词，也不把来信误称为“新鲜事”。
      title = letterSuffix ? ('一封来信，一首歌｜' + letterSuffix) : '一封来信，一首歌｜校园里的片刻分享';
      digest = topics.length === 1
        ? ('关于“' + topics[0] + '”的一封校园来信，和' + featuredSong + '一起送达。')
        : ('校园来信，和' + featuredSong + '一起送达。');
    } else {
      title = letterSuffix ? ('校园来信｜' + letterSuffix) : ((dateLabel ? dateLabel : '今天') + '的校园来信');
      digest = topics.length === 1
        ? ('关于“' + topics[0] + '”的一封校园来信。')
        : (letterSuffix ? ('今天的校园来信，聊聊 ' + letterSuffix + '。') : '来自校园的一页真实日常。');
    }
  } else {
    var post = posts[0] || options.post || {};
    var topic = sanitizeArticleText(post.title, 38) || sanitizeArticleText(post.content || options.content, 38);
    title = topic ? ('想和你说｜' + topic) : '校园来信｜今天的一页日常';
    digest = topic ? ('想和你分享这件校园小事：' + topic) : '来自校园墙的一页真实日常。';
    type = 'post';
  }

  return {
    title: sanitizeArticleText(title, ARTICLE_TITLE_MAX_LENGTH) || '校园新鲜事',
    digest: sanitizeArticleText(digest, ARTICLE_DIGEST_MAX_LENGTH) || '来自校园墙的真实分享。',
    meta: {
      strategy: 'content-based-v1',
      type: type,
      source_count: (type === 'song' || type === 'weekly-song') ? songs.length : posts.length,
      date_label: dateLabel || undefined
    }
  };
}

async function uploadMedia(imageUrl, type = 'image') {
  try {
    const token = await getAccessToken();
    
    // 判断是远程URL还是本地文件
    let imageBuffer;
    if (imageUrl.startsWith('http')) {
      // 从远程URL下载图片
      imageBuffer = await downloadImage(imageUrl);
    } else if (imageUrl.startsWith('/')) {
      imageBuffer = fs.readFileSync(resolvePublicFile(imageUrl));
    } else {
      // 读取本地文件
      imageBuffer = fs.readFileSync(imageUrl);
    }

    // 根据文件扩展名设置正确的 Content-Type
    var ext = path.extname(imageUrl).toLowerCase();
    var contentType = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
    var filename = 'image' + ext;

    return new Promise((resolve, reject) => {
      const url = `https://api.weixin.qq.com/cgi-bin/media/upload?access_token=${token}&type=${type}`;
      const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
      
      const postData = Buffer.concat([
        Buffer.from(`--${boundary}\r\n`),
        Buffer.from(`Content-Disposition: form-data; name="media"; filename="${filename}"\r\n`),
        Buffer.from(`Content-Type: ${contentType}\r\n\r\n`),
        imageBuffer,
        Buffer.from(`\r\n--${boundary}--\r\n`)
      ]);

      const options = {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': postData.length
        }
      };

      const req = https.request(url, options, function(res) {
        var data = '';
        res.on('data', function(chunk) { data += chunk; });
        res.on('end', function() {
          try {
            var json = JSON.parse(data);
            if (json.media_id) {
              resolve(json.media_id);
            } else {
              reject(new Error('上传素材失败: ' + data));
            }
          } catch (e) {
            reject(e);
          }
        });
      });
      req.setTimeout(30000, function() {
        try { req.destroy(); } catch(e) {}
        reject(new Error('上传素材请求超时(30s)'));
      });
      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  } catch (err) {
    console.error('[MP素材] 上传媒体失败:', err.message);
    throw err;
  }
}

function createMediaValidationError(message, code) {
  var error = new Error(message);
  error.code = code;
  error.statusCode = code === 'MP_VIDEO_TOO_LARGE' || code === 'MP_VIDEO_SOURCE_TOO_LARGE' ? 413 : 400;
  return error;
}

function createVideoProcessingError(message, code, statusCode) {
  var error = createMediaValidationError(message, code);
  if (statusCode) error.statusCode = statusCode;
  return error;
}

/**
 * 永久视频素材的纯边界校验，供路由和静态测试复用。
 * 0 字节不允许，恰好 10 MB 允许，超过 10 MB 拒绝。
 */
function validatePermanentVideoSize(byteLength) {
  if (!Number.isInteger(byteLength) || byteLength <= 0) {
    return { ok: false, code: 'MP_VIDEO_EMPTY', message: '视频文件为空' };
  }
  if (byteLength > MP_PERMANENT_VIDEO_MAX_BYTES) {
    return {
      ok: false,
      code: 'MP_VIDEO_TOO_LARGE',
      message: '视频超过公众号永久素材上限 10MB'
    };
  }
  return { ok: true, code: null, message: '' };
}

function resolveLocalMediaPath(filePath) {
  var value = String(filePath || '');
  if (value.startsWith('/')) {
    return path.join(LOCAL_ROOT, value.replace(/^[/\\]+/, ''));
  }
  return value;
}

function getControlledVideoCandidate(videoSource) {
  var raw = String(videoSource || '').trim();
  if (!raw) {
    throw createVideoProcessingError('视频地址不能为空', 'MP_VIDEO_SOURCE_INVALID');
  }

  var sourcePath = raw.split(/[?#]/)[0];
  var isSiteUrl = false;
  if (/^https?:\/\//i.test(raw)) {
    var parsed;
    try {
      parsed = new URL(raw);
    } catch (error) {
      throw createVideoProcessingError('视频地址格式无效', 'MP_VIDEO_SOURCE_INVALID');
    }
    var allowedOrigin;
    try {
      allowedOrigin = new URL(PUBLIC_WALL_ORIGIN);
    } catch (error) {
      throw createVideoProcessingError('服务器站点地址配置无效', 'MP_VIDEO_SOURCE_INVALID', 500);
    }
    if (parsed.origin !== allowedOrigin.origin) {
      throw createVideoProcessingError('视频地址不是当前校墙的受控资源', 'MP_VIDEO_SOURCE_NOT_ALLOWED');
    }
    sourcePath = parsed.pathname;
    isSiteUrl = true;
  }

  var candidate;
  // URL 的 pathname（以及 /uploads/... 这种站内相对路径）必须映射到
  // 当前实例的 public 目录，不能被 path.resolve 当成操作系统根路径。
  if (isSiteUrl || /^[/\\]?uploads[/\\]/i.test(sourcePath)) {
    candidate = path.resolve(LOCAL_ROOT, sourcePath.replace(/^[/\\]+/, ''));
  } else if (path.isAbsolute(sourcePath)) {
    candidate = path.resolve(sourcePath);
  } else {
    candidate = path.resolve(LOCAL_ROOT, sourcePath.replace(/^[/\\]+/, ''));
  }

  var relativePath = path.relative(LOCAL_ROOT, candidate).replace(/\\/g, '/');
  if (relativePath === '..' || relativePath.startsWith('../') || path.isAbsolute(relativePath)) {
    throw createVideoProcessingError('视频路径超出受控上传目录', 'MP_VIDEO_PATH_TRAVERSAL');
  }
  if (!CONTROLLED_VIDEO_RELATIVE_RE.test(relativePath)) {
    throw createVideoProcessingError('视频地址不是校墙受控上传路径', 'MP_VIDEO_SOURCE_NOT_ALLOWED');
  }

  return { candidate: candidate, relativePath: relativePath };
}

async function resolveControlledVideoFile(videoSource) {
  var candidate = getControlledVideoCandidate(videoSource);
  var realRoot;
  var realFile;
  try {
    realRoot = await fs.promises.realpath(LOCAL_ROOT);
    realFile = await fs.promises.realpath(candidate.candidate);
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      throw createVideoProcessingError('视频文件不存在', 'MP_VIDEO_NOT_FOUND', 404);
    }
    throw createVideoProcessingError('读取视频文件失败: ' + error.message, 'MP_VIDEO_READ_FAILED', 500);
  }

  var realRelativePath = path.relative(realRoot, realFile).replace(/\\/g, '/');
  if (realRelativePath === '..' || realRelativePath.startsWith('../') || path.isAbsolute(realRelativePath)) {
    throw createVideoProcessingError('视频文件实际路径超出受控上传目录', 'MP_VIDEO_PATH_TRAVERSAL');
  }
  if (!CONTROLLED_VIDEO_RELATIVE_RE.test(realRelativePath)) {
    throw createVideoProcessingError('视频文件不是校墙受控上传文件', 'MP_VIDEO_SOURCE_NOT_ALLOWED');
  }

  var stat;
  try {
    stat = await fs.promises.stat(realFile);
  } catch (error) {
    throw createVideoProcessingError('读取视频文件失败: ' + error.message, 'MP_VIDEO_READ_FAILED', 500);
  }
  if (!stat.isFile()) {
    throw createVideoProcessingError('视频源不是普通文件', 'MP_VIDEO_SOURCE_INVALID');
  }
  if (stat.size > MP_VIDEO_SOURCE_MAX_BYTES) {
    throw createVideoProcessingError('视频源超过上传限制 50MB', 'MP_VIDEO_SOURCE_TOO_LARGE', 413);
  }
  if (stat.size <= 0) {
    throw createMediaValidationError('视频文件为空', 'MP_VIDEO_EMPTY');
  }

  return { path: realFile, extension: path.extname(realFile).toLowerCase(), size: stat.size };
}

function formatBitrate(bitsPerSecond) {
  return Math.max(16, Math.floor(bitsPerSecond / 1000)) + 'k';
}

function shouldTranscodeVideo(extension, byteLength) {
  return String(extension || '').toLowerCase() !== '.mp4' || Number(byteLength) > MP_PERMANENT_VIDEO_MAX_BYTES;
}

function calculateTranscodeBitrate(durationSeconds) {
  var duration = Number(durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw createVideoProcessingError('无法读取视频时长', 'MP_FFPROBE_FAILED');
  }

  // 留出 MP4 容器和 faststart 元数据空间；最终仍会再做文件大小校验。
  var targetBytes = Math.floor(MP_PERMANENT_VIDEO_MAX_BYTES * 0.92);
  var totalBitsPerSecond = Math.floor((targetBytes * 8) / duration);
  var audioBitsPerSecond = totalBitsPerSecond >= 192000 ? 96000 : totalBitsPerSecond >= 128000 ? 64000 : 32000;
  var videoBitsPerSecond = Math.max(16000, Math.floor((totalBitsPerSecond - audioBitsPerSecond) * 0.92));
  return {
    video: formatBitrate(videoBitsPerSecond),
    audio: formatBitrate(audioBitsPerSecond)
  };
}

function getCommandError(toolName, error, stderr) {
  var output = String(stderr || (error && error.message) || '').replace(/\s+/g, ' ').trim().substring(0, 240);
  var label = toolName === 'ffprobe' ? 'ffprobe' : toolName === 'ffmpeg' ? 'FFmpeg' : 'ImageMagick';
  var unavailableCode = toolName === 'ffprobe' ? 'MP_FFPROBE_UNAVAILABLE' : toolName === 'ffmpeg' ? 'MP_FFMPEG_UNAVAILABLE' : 'MP_IMAGE_TOOL_UNAVAILABLE';
  var timeoutCode = toolName === 'ffprobe' ? 'MP_FFPROBE_TIMEOUT' : toolName === 'ffmpeg' ? 'MP_FFMPEG_TIMEOUT' : 'MP_IMAGE_TOOL_TIMEOUT';
  var failedCode = toolName === 'ffprobe' ? 'MP_FFPROBE_FAILED' : toolName === 'ffmpeg' ? 'MP_VIDEO_TRANSCODE_FAILED' : 'MP_IMAGE_TOOL_FAILED';
  if (error && error.code === 'ENOENT') {
    return createVideoProcessingError('服务器未找到 ' + label + (toolName === 'image' ? '，图片压缩已跳过' : '，请安装对应工具或配置路径环境变量'), unavailableCode, 503);
  }
  if (error && (error.code === 'ETIMEDOUT' || error.killed)) {
    return createVideoProcessingError(label + '处理超时', timeoutCode, 504);
  }
  return createVideoProcessingError(label + '执行失败' + (output ? ': ' + output : ''), failedCode, 422);
}

async function runExternalCommand(command, args, options) {
  var toolName = arguments.length > 3 ? arguments[3] : command;
  try {
    return await execFileAsync(command, args, Object.assign({ windowsHide: true, maxBuffer: 1024 * 1024 }, options || {}));
  } catch (error) {
    throw getCommandError(toolName, error, error && error.stderr);
  }
}

async function removeTemporaryDirectory(directory) {
  if (!directory) return;
  try {
    await fs.promises.rm(directory, { recursive: true, force: true });
  } catch (error) {
    // Node 旧版本没有 fs.promises.rm 时，目录通常只有两个文件，逐个兜底清理。
    try {
      var entries = await fs.promises.readdir(directory);
      await Promise.all(entries.map(function(entry) {
        return fs.promises.unlink(path.join(directory, entry)).catch(function() {});
      }));
      await fs.promises.rmdir(directory).catch(function() {});
    } catch (fallbackError) {
      console.warn('[MP视频] 清理临时目录失败:', fallbackError.message);
    }
  }
}

function downloadBinary(url, timeoutMs, maxBytes, label) {
  timeoutMs = timeoutMs || 30000;
  label = label || '媒体';
  return new Promise(function(resolve, reject) {
    var protocol = url.startsWith('https') ? https : http;
    var settled = false;
    var chunks = [];
    var total = 0;
    var req = protocol.get(url, function(res) {
      if (res.statusCode !== 200) {
        res.resume();
        settled = true;
        reject(new Error('下载' + label + '失败: ' + res.statusCode));
        return;
      }
      var declaredLength = Number(res.headers['content-length']);
      if (maxBytes && Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        res.resume();
        settled = true;
        reject(createMediaValidationError(label + '超过公众号永久素材上限 10MB', 'MP_VIDEO_TOO_LARGE'));
        return;
      }
      res.on('data', function(chunk) {
        total += chunk.length;
        if (maxBytes && total > maxBytes) {
          try { req.destroy(); } catch (e) {}
          if (!settled) {
            settled = true;
            reject(createMediaValidationError(label + '超过公众号永久素材上限 10MB', 'MP_VIDEO_TOO_LARGE'));
          }
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', function() {
        if (!settled) {
          settled = true;
          resolve(Buffer.concat(chunks));
        }
      });
      res.on('error', function(error) {
        if (!settled) { settled = true; reject(error); }
      });
    });
    req.setTimeout(timeoutMs, function() {
      try { req.destroy(); } catch (e) {}
      if (!settled) {
        settled = true;
        reject(new Error('下载' + label + '超时(' + timeoutMs + 'ms)'));
      }
    });
    req.on('error', function(error) {
      if (!settled) { settled = true; reject(error); }
    });
  });
}

async function readVideoSource(videoSource) {
  var source = await resolveControlledVideoFile(videoSource);
  // 小于等于 10MB 的 MP4 保持原文件直传；大 MP4 也必须经过转码，
  // WebM/OGV 则始终转为临时 MP4，最终统一执行 10MB 硬校验。
  if (!shouldTranscodeVideo(source.extension, source.size)) {
    var directBuffer = await fs.promises.readFile(source.path);
    var directCheck = validatePermanentVideoSize(directBuffer.length);
    if (!directCheck.ok) throw createMediaValidationError(directCheck.message, directCheck.code);
    return directBuffer;
  }

  var probe;
  try {
    probe = await runExternalCommand(FFPROBE_COMMAND, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      source.path
    ], { timeout: MP_VIDEO_PROBE_TIMEOUT_MS }, 'ffprobe');
  } catch (error) {
    // runExternalCommand 已把 ENOENT、超时和非零退出统一为机器可读错误。
    throw error;
  }

  var duration = Number(String(probe.stdout || '').trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw createVideoProcessingError('ffprobe 未能读取视频时长', 'MP_FFPROBE_FAILED', 422);
  }

  var bitrate = calculateTranscodeBitrate(duration);
  var temporaryDirectory;
  try {
    temporaryDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), MP_VIDEO_TEMP_PREFIX));
    var outputPath = path.join(temporaryDirectory, 'video.mp4');
    await runExternalCommand(FFMPEG_COMMAND, [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-i', source.path,
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-vf', "scale='min(1920,iw)':-2",
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-profile:v', 'main',
      '-pix_fmt', 'yuv420p',
      '-b:v', bitrate.video,
      '-maxrate', bitrate.video,
      '-bufsize', bitrate.video,
      '-c:a', 'aac',
      '-b:a', bitrate.audio,
      '-ar', '44100',
      '-ac', '2',
      '-movflags', '+faststart',
      outputPath
    ], { timeout: MP_VIDEO_TRANSCODE_TIMEOUT_MS }, 'ffmpeg');

    var outputStat;
    try {
      outputStat = await fs.promises.stat(outputPath);
    } catch (error) {
      throw createVideoProcessingError('FFmpeg 未生成可用的 MP4 文件', 'MP_VIDEO_TRANSCODE_FAILED', 422);
    }
    var outputCheck = validatePermanentVideoSize(outputStat.size);
    if (!outputCheck.ok) {
      throw createMediaValidationError('服务器转码后的 MP4 超过公众号永久素材上限 10MB', outputCheck.code);
    }
    return await fs.promises.readFile(outputPath);
  } finally {
    await removeTemporaryDirectory(temporaryDirectory);
  }
}

/**
 * 上传帖子视频为微信公众号永久素材。
 * 返回 { media_id, url }，正文不能依赖该接口返回可公开播放地址，需由调用方提供站内观看入口。
 */
async function uploadPermanentVideo(videoSource, metadata) {
  var videoBuffer = await readVideoSource(videoSource);
  var token = await getAccessToken();
  var title = String((metadata && metadata.title) || '校园墙视频').trim().substring(0, 100) || '校园墙视频';
  var introduction = String((metadata && metadata.introduction) || '来自校墙的投稿视频').trim().substring(0, 1000);
  var description = JSON.stringify({ title: title, introduction: introduction });

  return new Promise(function(resolve, reject) {
    var url = 'https://api.weixin.qq.com/cgi-bin/material/add_material?access_token=' + token + '&type=video';
    var boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
    var postData = Buffer.concat([
      Buffer.from('--' + boundary + '\r\n'),
      Buffer.from('Content-Disposition: form-data; name="media"; filename="video.mp4"\r\n'),
      Buffer.from('Content-Type: video/mp4\r\n\r\n'),
      videoBuffer,
      Buffer.from('\r\n--' + boundary + '\r\n'),
      Buffer.from('Content-Disposition: form-data; name="description"\r\n\r\n'),
      Buffer.from(description, 'utf8'),
      Buffer.from('\r\n--' + boundary + '--\r\n')
    ]);
    var req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': postData.length
      }
    }, function(res) {
      var data = '';
      res.setEncoding('utf8');
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        try {
          var json = JSON.parse(data);
          if (json.media_id) return resolve({ media_id: json.media_id, url: json.url || null });
          reject(new Error('上传永久视频失败: ' + (json.errmsg || data.substring(0, 200))));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.setTimeout(60000, function() {
      try { req.destroy(); } catch (e) {}
      reject(new Error('上传永久视频请求超时(60s)'));
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

/**
 * 下载图片
 */
function downloadImage(url, timeoutMs, redirectCount) {
  timeoutMs = timeoutMs || 8000;
  redirectCount = redirectCount || 0;
  return new Promise(function(resolve, reject) {
    var protocol = url.startsWith('https') ? https : http;
    var settled = false;
    var req = protocol.get(url, function(res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectCount >= 3) {
          if (!settled) { settled = true; reject(new Error('下载图片重定向次数过多')); }
          return;
        }
        var redirectUrl;
        try { redirectUrl = new URL(res.headers.location, url).toString(); }
        catch (e) { if (!settled) { settled = true; reject(new Error('图片重定向地址无效')); } return; }
        settled = true;
        downloadImage(redirectUrl, timeoutMs, redirectCount + 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        if (!settled) { settled = true; reject(new Error('下载图片失败: ' + res.statusCode)); }
        return;
      }
      var chunks = [];
      var total = 0;
      res.on('data', function(chunk) {
        if (settled) return;
        total += chunk.length;
        if (total > MAX_DOWNLOAD_BYTES) {
          settled = true;
          try { req.destroy(); } catch(e) {}
          reject(new Error('下载图片超过 12MB 限制'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', function() { if (!settled) { settled = true; resolve(Buffer.concat(chunks)); } });
    });
    req.on('error', function(e) { if (!settled) { settled = true; reject(e); } });
    req.setTimeout(timeoutMs, function() {
      try { req.destroy(); } catch(e) {}
      if (!settled) { settled = true; reject(new Error('下载图片超时(' + timeoutMs + 'ms) url=' + url.substring(0, 60))); }
    });
  });
}

function resolvePublicFile(imageUrl) {
  var pathname = String(imageUrl || '').split(/[?#]/)[0].replace(/^[/\\]+/, '');
  var resolved = path.resolve(LOCAL_ROOT, pathname);
  if (resolved !== LOCAL_ROOT && !resolved.startsWith(LOCAL_ROOT + path.sep)) {
    throw new Error('本地图片路径超出 public 目录');
  }
  return resolved;
}

function getImageExtension(imageUrl) {
  var pathname = String(imageUrl || '').split(/[?#]/)[0];
  var ext = path.extname(pathname).toLowerCase();
  return ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'].includes(ext) ? ext : '.jpg';
}

/**
 * 用 ImageMagick 将图片压缩到 <= targetBytes
 * 支持 JPEG/PNG/GIF/WebP，转 JPEG 输出降低体积
 * 失败返回 null，由调用方走原图
 */
async function compressImageWithMagick(srcBuffer, targetBytes) {
  var temporaryDirectory;
  try {
    temporaryDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'campus-wall-mp-image-'));
    var tmpIn = path.join(temporaryDirectory, 'input.jpg');
    var tmpOut = path.join(temporaryDirectory, 'output.jpg');
    await fs.promises.writeFile(tmpIn, srcBuffer);
    // 试三档：质量 85、70、55，最长边逐步缩小到 1920/1600/1280
    var presets = [
      { q: 85, w: 1920 },
      { q: 70, w: 1600 },
      { q: 55, w: 1280 }
    ];
    for (var i = 0; i < presets.length; i++) {
      var p = presets[i];
      try {
        await runExternalCommand('convert', [tmpIn, '-strip', '-resize', p.w + 'x>', '-quality', String(p.q), tmpOut], { timeout: 20000 }, 'image');
        var out = await fs.promises.readFile(tmpOut);
        if (out.length <= targetBytes) return { buffer: out, ext: '.jpg', contentType: 'image/jpeg' };
      } catch (e) {
        console.warn('[MP压缩] 第' + (i+1) + '档失败:', e.message);
      }
    }
    // 三档都不够，最后再降一档试一次更狠
    try {
      await runExternalCommand('convert', [tmpIn, '-strip', '-resize', '1024x>', '-quality', '45', tmpOut], { timeout: 20000 }, 'image');
      var finalOut = await fs.promises.readFile(tmpOut);
      return { buffer: finalOut, ext: '.jpg', contentType: 'image/jpeg' };
    } catch (e) {
      console.warn('[MP压缩] 最终档失败:', e.message);
      return null;
    }
  } catch (e) {
    console.warn('[MP压缩] 写入临时文件失败:', e.message);
    return null;
  } finally {
    await removeTemporaryDirectory(temporaryDirectory);
  }
}

/**
 * 上传图文素材内的图片（获取URL）
 * @param {string} imageUrl - 图片URL
 * @returns {string} 微信图片URL
 */
async function uploadMpImage(imageUrl) {
  try {
    const token = await getAccessToken();
    let imageBuffer;
    if (imageUrl.startsWith('http')) {
      imageBuffer = await downloadImage(imageUrl, 10000);
    } else if (imageUrl.startsWith('/')) {
      // 本地相对路径，直接从文件系统读取
      var localPath = resolvePublicFile(imageUrl);
      imageBuffer = fs.readFileSync(localPath);
    } else {
      imageBuffer = fs.readFileSync(imageUrl);
    }

    // 微信 CDN 限制:图片 ≤ 10MB,>9MB 才尝试压缩(留余量)
    if (imageBuffer.length > 9 * 1024 * 1024) {
      var compressed = await compressImageWithMagick(imageBuffer, 9 * 1024 * 1024);
      if (compressed && compressed.buffer.length <= imageBuffer.length) {
        imageBuffer = compressed.buffer;
        var ext = compressed.ext;
        var contentType = compressed.contentType;
        var filename = 'image' + ext;
      } else {
        console.warn('[MP素材] 压缩失败,仍按原图上传');
        var ext = getImageExtension(imageUrl);
        var contentType = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
        var filename = 'image' + ext;
      }
    } else {
      var ext = getImageExtension(imageUrl);
      var contentType = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
      var filename = 'image' + ext;
    }

    return new Promise(function(resolve, reject) {
      var settled = false;
      var url = 'https://api.weixin.qq.com/cgi-bin/media/uploadimg?access_token=' + token;
      var boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
      var postData = Buffer.concat([
        Buffer.from('--' + boundary + '\r\n'),
        Buffer.from('Content-Disposition: form-data; name="media"; filename="' + filename + '"\r\n'),
        Buffer.from('Content-Type: ' + contentType + '\r\n\r\n'),
        imageBuffer,
        Buffer.from('\r\n--' + boundary + '--\r\n')
      ]);
      var options = {
        method: 'POST',
        headers: {
          'Content-Type': 'multipart/form-data; boundary=' + boundary,
          'Content-Length': postData.length
        }
      };
      var req = https.request(url, options, function(res) {
        var data = '';
        res.on('data', function(chunk) { data += chunk; });
        res.on('end', function() {
          if (settled) return; settled = true;
          try {
            var json = JSON.parse(data);
            if (json.url) resolve(json.url);
            else reject(new Error('上传图片失败: ' + data.substring(0, 200)));
          } catch (e) { reject(e); }
        });
      });
      req.setTimeout(15000, function() {
        try { req.destroy(); } catch(e) {}
        if (!settled) { settled = true; reject(new Error('上传图片到微信CDN超时(15s)')); }
      });
      req.on('error', function(e) { if (!settled) { settled = true; reject(e); } });
      req.write(postData);
      req.end();
    });
  } catch (err) {
    console.error('[MP素材] 上传图片失败:', err.message);
    throw err;
  }
}

/**
 * 统计最终 HTML 中用户可见的文字；标签、脚本、样式和媒体 URL 不计入。
 * 文章标题/作者等元数据由 getArticleTextStats 另行计入。
 */
function countVisibleText(value) {
  var text = String(value || '')
    .replace(/<!--\s*mp-text-stats-start\s*-->[\s\S]*?<!--\s*mp-text-stats-end\s*-->/gi, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, function(_, code) { return String.fromCodePoint(Number(code)); })
    .replace(/&#x([\da-f]+);/gi, function(_, code) { return String.fromCodePoint(parseInt(code, 16)); });
  return Array.from(text.replace(/\s/g, '')).length;
}

function getArticleTextStats(article) {
  article = article || {};
  var titleChars = countVisibleText(article.title);
  var authorChars = countVisibleText(article.author);
  var contentChars = countVisibleText(article.content);
  return {
    title: titleChars,
    author: authorChars,
    content: contentChars,
    total: titleChars + authorChars + contentChars
  };
}

/**
 * 上传默认封面图片并获取 media_id（缓存，避免重复上传）
 */
/**
 * 上传永久素材（用于封面图，media_id 可被 draft/add 使用）
 * @param {string} filePath - 本地文件路径
 * @returns {string} media_id
 */
async function uploadPermanentImage(filePath) {
  var token = await getAccessToken();
  var ext = path.extname(filePath).toLowerCase();
  var contentType = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
  var filename = 'image' + ext;
  var imageBuffer = fs.readFileSync(filePath);

  return new Promise(function(resolve, reject) {
    var url = `https://api.weixin.qq.com/cgi-bin/material/add_material?access_token=${token}&type=image`;
    var boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
    var postData = Buffer.concat([
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="media"; filename="${filename}"\r\n`),
      Buffer.from(`Content-Type: ${contentType}\r\n\r\n`),
      imageBuffer,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);

    var options = {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': postData.length
      }
    };

    var req = https.request(url, options, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        try {
          var json = JSON.parse(data);
          if (json.media_id) {
            resolve(json.media_id);
          } else {
            console.error('[MP永久素材] 上传失败:', data);
            reject(new Error('上传永久素材失败: ' + (json.errmsg || data)));
          }
        } catch (e) { reject(e); }
      });
    });
    req.setTimeout(30000, function() {
      try { req.destroy(); } catch(e) {}
      reject(new Error('上传永久素材请求超时(30s)'));
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

let cachedDefaultThumbMediaId = null;
let defaultThumbFailed = false; // 标记是否失败过，避免重复尝试

async function getDefaultThumbMediaId() {
  // 如果已缓存，直接返回
  if (cachedDefaultThumbMediaId) return cachedDefaultThumbMediaId;
  // 如果之前上传失败过，直接返回null，不重复尝试
  if (defaultThumbFailed) return process.env.MP_DEFAULT_THUMB_MEDIA_ID || null;
  
  // 先检查环境变量中是否已经配置了media_id
  if (process.env.MP_DEFAULT_THUMB_MEDIA_ID) {
    cachedDefaultThumbMediaId = process.env.MP_DEFAULT_THUMB_MEDIA_ID;
    return cachedDefaultThumbMediaId;
  }

  try {
    var candidates = [
      // 校园号默认封面：无独立文章封面时上传为微信永久素材。
      path.join(__dirname, '..', 'public', 'images', 'mp-campus-cover-2026.png'),
      path.join(__dirname, '..', 'public', 'images', 'default-cover.png'),
      path.join(__dirname, '..', 'public', 'favicon.png')
    ];
    var foundPath = null;
    for (var i = 0; i < candidates.length; i++) {
      if (fs.existsSync(candidates[i])) {
        foundPath = candidates[i];
        break;
      }
    }
    if (foundPath) {
      // 必须用永久素材 (material/add_material)，临时素材 (media/upload) 的 media_id 不能用于草稿封面
      cachedDefaultThumbMediaId = await uploadPermanentImage(foundPath);
      return cachedDefaultThumbMediaId;
    } else {
      console.warn('[MP素材] 未找到默认封面图片文件');
    }
  } catch (e) {
    console.warn('[MP素材] 上传默认封面失败:', e.message);
  }
  // 标记失败，避免每次调用都重复尝试
  defaultThumbFailed = true;
  // 最后兜底：检查环境变量
  if (process.env.MP_DEFAULT_THUMB_MEDIA_ID) {
    cachedDefaultThumbMediaId = process.env.MP_DEFAULT_THUMB_MEDIA_ID;
    return cachedDefaultThumbMediaId;
  }
  return null;
}

/**
 * 创建草稿（图文消息）
 * @param {Array} articles - 图文数组
 * @returns {string} media_id
 */
async function createDraft(articles) {
  try {
    const token = await getAccessToken();

    // 确保每个文章都有有效的 thumb_media_id
    for (var i = 0; i < articles.length; i++) {
      var article = articles[i];
      if (!article.thumb_media_id) {
        article.thumb_media_id = await getDefaultThumbMediaId();
      }
      if (!article.thumb_media_id) {
        throw new Error('无法获取封面media_id，请在.env中配置 MP_DEFAULT_THUMB_MEDIA_ID');
      }
    }

    const data = {
      articles: articles.map(function(article) {
        return toWechatDraftArticle(article);
      })
    };

    return new Promise((resolve, reject) => {
      const url = `https://api.weixin.qq.com/cgi-bin/draft/add?access_token=${token}`;
      const postData = JSON.stringify(data);
      
      const options = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      var req = https.request(url, options, function(res) {
        var responseData = '';
        res.on('data', function(chunk) { responseData += chunk; });
        res.on('end', function() {
          try {
            var json = JSON.parse(responseData);
            if (json.media_id) {
              resolve(json.media_id);
            } else {
              reject(new Error('创建草稿失败: ' + responseData));
            }
          } catch (e) {
            reject(e);
          }
        });
      });
      req.setTimeout(30000, function() {
        try { req.destroy(); } catch(e) {}
        reject(new Error('创建草稿请求超时(30s),可能内容过大'));
      });
      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  } catch (err) {
    console.error('[MP素材] 创建草稿失败:', err.message);
    throw err;
  }
}

/**
 * 获取草稿列表
 */
async function getDraftList(offset = 0, count = 20) {
  try {
    const token = await getAccessToken();
    
    const data = { offset, count, no_content: 1 };

    return new Promise((resolve, reject) => {
      const url = `https://api.weixin.qq.com/cgi-bin/draft/batchget?access_token=${token}`;
      const postData = JSON.stringify(data);
      
      const options = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      const req = https.request(url, options, function(res) {
        var responseData = '';
        res.on('data', function(chunk) { responseData += chunk; });
        res.on('end', function() {
          try {
            var json = JSON.parse(responseData);
            if (json.item) {
              resolve(json);
            } else {
              reject(new Error('获取草稿列表失败: ' + responseData));
            }
          } catch (e) {
            reject(e);
          }
        });
      });
      req.setTimeout(30000, function() {
        try { req.destroy(); } catch(e) {}
        reject(new Error('获取草稿列表请求超时(30s)'));
      });
      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  } catch (err) {
    console.error('[MP素材] 获取草稿列表失败:', err.message);
    throw err;
  }
}

/**
 * 删除草稿
 */
async function deleteDraft(mediaId) {
  try {
    const token = await getAccessToken();
    
    const data = { media_id: mediaId };

    return new Promise((resolve, reject) => {
      const url = `https://api.weixin.qq.com/cgi-bin/draft/delete?access_token=${token}`;
      const postData = JSON.stringify(data);
      
      const options = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      const req = https.request(url, options, function(res) {
        var responseData = '';
        res.on('data', function(chunk) { responseData += chunk; });
        res.on('end', function() {
          try {
            var json = JSON.parse(responseData);
            if (json.errcode === 0) {
              resolve(true);
            } else {
              reject(new Error('删除草稿失败: ' + responseData));
            }
          } catch (e) {
            reject(e);
          }
        });
      });
      req.setTimeout(30000, function() {
        try { req.destroy(); } catch(e) {}
        reject(new Error('删除草稿请求超时(30s)'));
      });
      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  } catch (err) {
    console.error('[MP素材] 删除草稿失败:', err.message);
    throw err;
  }
}

/**
 * 带超时的HTTP请求
 */
function httpGetWithTimeout(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        resolve(data);
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, function() {
      req.destroy();
      reject(new Error('请求超时'));
    });
  });
}

/**
 * 获取天气信息（带超时，3秒没响应就返回默认）
 * @param {string} city - 城市名称
 * @returns {Object} 天气信息
 */

/** 英文天气描述 → 中文 */
function translateWeather(text) {
  const map = {
    'clear': '晴', 'sunny': '晴', 'fair': '晴',
    'partly cloudy': '多云', 'cloudy': '多云', 'overcast': '阴天',
    'mist': '雾', 'fog': '雾', 'haze': '霾',
    'rain': '雨', 'light rain': '小雨', 'moderate rain': '中雨', 'heavy rain': '大雨',
    'drizzle': '毛毛雨', 'showers': '阵雨', 'light showers': '小阵雨', 'heavy showers': '强阵雨',
    'thunderstorm': '雷暴', 'thundery outbreaks': '雷暴',
    'snow': '雪', 'light snow': '小雪', 'moderate snow': '中雪', 'heavy snow': '大雪',
    'sleet': '雨夹雪', 'freezing rain': '冻雨',
    'blizzard': '暴风雪', 'windy': '大风', 'dust': '扬尘'
  };
  var lower = text.toLowerCase().trim();
  // 先尝试完全匹配
  if (map[lower]) return map[lower];
  // 再尝试关键词匹配
  for (var key in map) {
    if (lower.includes(key)) return map[key];
  }
  return text;
}
async function getWeather(city = CONFIG.WEATHER_CITY) {
  try {
    if (CONFIG.WEATHER_API_KEY) {
      // 和风天气（需要配置API Key，免费注册：https://dev.qweather.com）
      // 获取今天实时天气
      const nowDataStr = await httpGetWithTimeout(
        `https://devapi.qweather.com/v7/weather/now?location=${encodeURIComponent(city)}&key=${CONFIG.WEATHER_API_KEY}`,
        3000
      );
      const nowJson = JSON.parse(nowDataStr);
      // 获取3天预报（拿明天的）
      const fcDataStr = await httpGetWithTimeout(
        `https://devapi.qweather.com/v7/weather/3d?location=${encodeURIComponent(city)}&key=${CONFIG.WEATHER_API_KEY}`,
        3000
      );
      const fcJson = JSON.parse(fcDataStr);
      if (nowJson.code === '200' && nowJson.now) {
        var result = {
          city: city,
          weather: nowJson.now.text,
          temperature: nowJson.now.temp + '°C',
          wind: `${nowJson.now.windDir} ${nowJson.now.windScale}级`,
          humidity: nowJson.now.humidity + '%',
          icon: getWeatherEmoji(nowJson.now.text)
        };
        // 添加明天的数据
        if (fcJson.code === '200' && fcJson.daily && fcJson.daily.length >= 2) {
          var tmw = fcJson.daily[1];
          result.tomorrow = {
            week: getWeekdayName(new Date(tmw.fxDate).getDay()),
            weather: tmw.textDay,
            tempRange: tmw.tempMin + '°C~' + tmw.tempMax + '°C',
            icon: getWeatherEmoji(tmw.textDay)
          };
        }
        return result;
      }
      throw new Error('和风天气数据异常');
    }

    // 无API Key时，先用 wttr.in（中国服务器可能连不上）
    try {
      const dataStr = await httpGetWithTimeout(
        `https://wttr.in/${encodeURIComponent(city)}?format=j1&lang=zh`,
        2000
      );
      const json = JSON.parse(dataStr);
      if (json.current_condition && json.current_condition[0]) {
        const c = json.current_condition[0];
        var result = {
          city: city,
          weather: translateWeather(c.weatherDesc ? c.weatherDesc[0].value : '未知'),
          temperature: c.temp_C + '°C',
          wind: translateWindDirection(c.winddir16Point) + ' ' + c.windspeedKmph + 'km/h',
          humidity: c.humidity + '%',
          icon: getWeatherEmoji(c.weatherDesc ? c.weatherDesc[0].value : '')
        };
        // 添加明天的数据（wttr.in 的 weather 数组第2项）
        if (json.weather && json.weather.length >= 2) {
          var tmw = json.weather[1];
          result.tomorrow = {
            week: getWeekdayName(new Date(tmw.date).getDay()),
            weather: translateWeather(tmw.astronomy ? (tmw.astronomy[0] ? tmw.astronomy[0].sunrise : '') : ''),
            tempRange: (tmw.mintempC || '?') + '°C~' + (tmw.maxtempC || '?') + '°C',
            icon: getWeatherEmoji(tmw.hourly ? (tmw.hourly[4] ? (tmw.hourly[4].weatherDesc ? tmw.hourly[4].weatherDesc[0].value : '') : '') : '')
          };
          // 从 hourly 取中午的天气描述更准确
          if (tmw.hourly && tmw.hourly.length > 0) {
            var midIdx = Math.min(4, tmw.hourly.length - 1);
            var midWeather = tmw.hourly[midIdx].weatherDesc ? tmw.hourly[midIdx].weatherDesc[0].value : '';
            if (midWeather) result.tomorrow.weather = translateWeather(midWeather);
            result.tomorrow.icon = getWeatherEmoji(midWeather || '');
          }
        }
        return result;
      }
    } catch (e) {
      console.warn('[MP素材] wttr.in失败, 改用baidu:', e.message);
    }
    // wttr.in 连不上时用百度天气（国内可访问，只有今天）
    try {
      const baiduStr = await httpGetWithTimeout(
        `https://weathernew.pae.baidu.com/weathernew/pc?query=${encodeURIComponent(city)}&srcid=4982`,
        2000
      );
      const match = baiduStr.match(/"weather":"([^"]+)"/);
      const tempMatch = baiduStr.match(/"temperature":"([^"]+)"/);
      if (match && tempMatch) {
        return {
          city: city,
          weather: match[1],
          temperature: tempMatch[1],
          wind: '',
          humidity: '',
          icon: getWeatherEmoji(match[1])
        };
      }
    } catch (e2) {
      console.warn('[MP素材] 所有天气源都失败:', e2.message);
    }
    return null;
  } catch (err) {
    if (err.message === '请求超时') {
      console.warn('[MP素材] 天气API超时');
    } else {
      console.error('[MP素材] 获取天气失败:', err.message);
    }
    return null;
  }
}

function getWeekdayName(dayIndex) {
  var names = ['周日','周一','周二','周三','周四','周五','周六'];
  return names[dayIndex] || '';
}

/**
 * 根据天气文字获取标准天气 emoji。
 * 不使用旧的替代字符（例如雾天的 ▒），避免看起来像乱码。
 */
function getWeatherEmoji(text) {
  if (!text) return '☀️';
  var lower = text.toLowerCase();
  if (lower.includes('雷') || lower.includes('thunder') || lower.includes('storm')) return '⛈️';
  if (lower.includes('雪') || lower.includes('snow') || lower.includes('sleet')) return '❄️';
  if (lower.includes('雨') || lower.includes('rain') || lower.includes('drizzle') || lower.includes('shower')) return '🌧️';
  if (lower.includes('雾') || lower.includes('fog') || lower.includes('mist') || lower.includes('haze')) return '🌫️';
  if (lower.includes('阴')) return '☁️';
  if (lower.includes('云') || lower.includes('cloud') || lower.includes('overcast')) return '☁️';
  if (lower.includes('晴') || lower.includes('clear') || lower.includes('sunny') || lower.includes('fair')) return '☀️';
  return '🌤️';
}

function translateWindDirection(direction) {
  var normalized = String(direction || '').trim().toUpperCase();
  var directions = {
    N: '北风', NNE: '东北风', NE: '东北风', ENE: '东北风',
    E: '东风', ESE: '东南风', SE: '东南风', SSE: '东南风',
    S: '南风', SSW: '西南风', SW: '西南风', WSW: '西南风',
    W: '西风', WNW: '西北风', NW: '西北风', NNW: '西北风',
    VAR: '风向多变', CALM: '静风'
  };
  return directions[normalized] || String(direction || '').trim();
}

/**
 * 获取每日一言（带超时，3秒没响应返回默认）
 * @returns {Object} 一言信息
 */
async function getHitokoto() {
  try {
    const dataStr = await httpGetWithTimeout(CONFIG.HITOKOTO_API, 3000);
    const json = JSON.parse(dataStr);
    return {
      text: json.hitokoto || '保持热爱，奔赴山海。',
      from: json.from || '',
      from_who: json.from_who || ''
    };
  } catch (err) {
    if (err.message === '请求超时') {
      console.warn('[MP素材] 一言API超时');
    }
    return null;
  }
}

/**
 * 获取日期信息
 */
function getDateInfo() {
  const now = new Date();
  const weekDays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  
  return {
    date: now.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }),
    week: weekDays[now.getDay()],
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    day: now.getDate()
  };
}

/**
 * 使用测试号配置创建草稿
 * @param {Object} article - 图文对象
 * @param {Object} config - { appId, appSecret }
 * @returns {string} media_id
 */
async function createDraftWithConfig(article, config) {
  // 用测试号的 appid/secret 获取 access_token
  var token = await new Promise(function(resolve, reject) {
    var url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${config.appId}&secret=${config.appSecret}`;
    var tokenReq = https.get(url, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        try {
          var json = JSON.parse(data);
          if (json.access_token) {
            resolve(json.access_token);
          } else {
            reject(new Error('获取token失败: ' + (json.errmsg || JSON.stringify(json))));
          }
        } catch (e) { reject(e); }
      });
    });
    tokenReq.setTimeout(10000, function() {
      try { tokenReq.destroy(); } catch(e) {}
      reject(new Error('测试号access_token请求超时'));
    });
    tokenReq.on('error', reject);
  });

  // 上传默认封面
  var testCoverCandidates = [
    path.join(__dirname, '..', 'public', 'images', 'mp-campus-cover-2026.png'),
    path.join(__dirname, '..', 'public', 'images', 'default-cover.png'),
    path.join(__dirname, '..', 'public', 'favicon.png')
  ];
  var defaultImgPath = testCoverCandidates.find(function(candidate) {
    return fs.existsSync(candidate);
  });
  var thumbMediaId = null;
  if (defaultImgPath && fs.existsSync(defaultImgPath)) {
    thumbMediaId = await uploadMediaWithToken(defaultImgPath, token);
  }
  if (!thumbMediaId) {
    throw new Error('无法上传封面图片');
  }

  // 使用 draft/add API（测试号支持）
  var draftArticle = Object.assign({}, article, { thumb_media_id: thumbMediaId });
  var draftData = { articles: [toWechatDraftArticle(draftArticle)] };

  return new Promise(function(resolve, reject) {
    var url = `https://api.weixin.qq.com/cgi-bin/draft/add?access_token=${token}`;
    var postData = JSON.stringify(draftData);
    var options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };
    var req = https.request(url, options, function(res) {
      var responseData = '';
      res.on('data', function(chunk) { responseData += chunk; });
      res.on('end', function() {
        try {
          var json = JSON.parse(responseData);
          if (json.media_id) {
            resolve(json.media_id);
          } else {
            reject(new Error('创建草稿失败: ' + (json.errmsg || responseData)));
          }
        } catch (e) { reject(e); }
      });
    });
    req.setTimeout(30000, function() {
      try { req.destroy(); } catch(e) {}
      reject(new Error('测试号创建草稿请求超时(30s)'));
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

/**
 * 使用已有的 token 上传永久素材（用于草稿封面）
 */
async function uploadMediaWithToken(filePath, token) {
  var ext = path.extname(filePath).toLowerCase();
  var contentType = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
  var filename = 'image' + ext;
  var imageBuffer = fs.readFileSync(filePath);

  return new Promise(function(resolve, reject) {
    var url = `https://api.weixin.qq.com/cgi-bin/material/add_material?access_token=${token}&type=image`;
    var boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
    var postData = Buffer.concat([
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="media"; filename="${filename}"\r\n`),
      Buffer.from(`Content-Type: ${contentType}\r\n\r\n`),
      imageBuffer,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);
    var options = {
      method: 'POST',
      headers: {
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': postData.length
      }
    };
    var req = https.request(url, options, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        try {
          var json = JSON.parse(data);
          if (json.media_id) {
            resolve(json.media_id);
          } else {
            console.error('[MP永久素材] 上传失败:', data);
            resolve(null);
          }
        } catch (e) { resolve(null); }
      });
    });
    req.setTimeout(30000, function() {
      try { req.destroy(); } catch(e) {}
      resolve(null);
    });
    req.on('error', function() { resolve(null); });
    req.write(postData);
    req.end();
  });
}

/**
 * 获取历史上的今天
 */
async function getTodayInHistory() {
  try {
    var dataStr = await httpGetWithTimeout('https://api.vvhan.com/api/history?type=json', 3000);
    var json = JSON.parse(dataStr);
    if (json.data && json.data.length > 0) {
      // 取第一条
      var item = json.data[0];
      return { title: item.title || '', year: item.year || '' };
    }
  } catch (e) {
    console.warn('[MP素材] 历史的今天获取失败:', e.message);
  }
  return null;
}

module.exports = {
  getAccessToken,
  uploadMedia,
  uploadPermanentVideo,
  uploadPermanentImage,
  uploadMpImage,
  validatePermanentVideoSize,
  shouldTranscodeVideo,
  calculateTranscodeBitrate,
  countVisibleText,
  getArticleTextStats,
  MP_PERMANENT_VIDEO_MAX_BYTES,
  createDraft,
  createDraftWithConfig,
  getDraftList,
  deleteDraft,
  getWeather,
  getHitokoto,
  getDateInfo,
  getTodayInHistory,
  sanitizeArticleText,
  generateArticleTitle,
  normalizeDraftArticle,
  toWechatDraftArticle
};
