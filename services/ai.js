const https = require('https');
const http = require('http');
const { pool } = require('../config/database');

// 简单 HTTP GET 请求
function httpGet(url, extraHeaders) {
  return new Promise(function(resolve, reject) {
    var mod = url.startsWith('https') ? https : http;
    var headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json'
    };
    if (extraHeaders) Object.assign(headers, extraHeaders);
    var req = mod.get(url, { headers: headers, timeout: 10000 }, function(res) {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return httpGet(res.headers.location, extraHeaders).then(resolve).catch(reject);
      }
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() { resolve(data); });
    });
    req.on('error', reject);
    req.on('timeout', function() { req.destroy(); reject(new Error('超时')); });
  });
}

// 歌名匹配验证
function matchSongName(target, search) {
  var t = target.toLowerCase().replace(/[（(【\[《]/g, '').replace(/[）)】\]》]/g, '').trim();
  var s = search.toLowerCase().replace(/[（(【\[《]/g, '').replace(/[）)】\]》]/g, '').trim();
  return t === s || t.indexOf(s) !== -1 || s.indexOf(t) !== -1;
}

function matchArtist(target, search) {
  if (!search) return true;
  var t = target.toLowerCase();
  var s = search.toLowerCase();
  if (t.indexOf(s) !== -1 || s.indexOf(t) !== -1) return true;
  // 拆分多个歌手逐个匹配
  var words = s.split(/[\s,\/、&]/).filter(function(w) { return w.length > 0; });
  var matched = 0;
  for (var i = 0; i < words.length; i++) {
    if (t.indexOf(words[i]) !== -1) matched++;
  }
  return matched >= Math.ceil(words.length * 0.5); // 至少匹配一半
}

// 从网易云音乐获取歌词
async function fetchNeteaseLyrics(songName, artist) {
  // 搜索时只用歌名+英文歌手，避免中文干扰
  var searchArtist = artist || '';
  if (searchArtist) {
    searchArtist = searchArtist.replace(/[和的与&]/g, " ").replace(/s+/g, " ").trim();
  }
  var keyword = songName + (searchArtist ? ' ' + searchArtist : '');

  try {
    var searchUrl = 'https://music.163.com/api/search/get?s=' + encodeURIComponent(keyword) + '&type=1&limit=10';
    var searchRes = await httpGet(searchUrl, { 'Referer': 'https://music.163.com/' });
    var searchData = JSON.parse(searchRes);

    if (!searchData.result || !searchData.result.songs || searchData.result.songs.length === 0) {
      return '';
    }

    // 找最佳匹配
    var bestMatch = null;
    var songs = searchData.result.songs;
    for (var i = 0; i < songs.length; i++) {
      var sname = songs[i].name || '';
      var sartist = (songs[i].artists || []).map(function(a) { return a.name || ''; }).join(' ');
      if (!matchSongName(sname, songName)) continue;
      if (artist && !matchArtist(sartist, artist)) continue;
      bestMatch = songs[i];
      break;
    }
    if (!bestMatch) {
      // 兜底：只验证歌名
      for (var i = 0; i < songs.length; i++) {
        if (matchSongName(songs[i].name || '', songName)) {
          bestMatch = songs[i];
          break;
        }
      }
    }
    if (!bestMatch) bestMatch = songs[0];


    var lyricUrl = 'https://music.163.com/api/song/lyric?id=' + bestMatch.id + '&lv=1';
    var lyricRes = await httpGet(lyricUrl, { 'Referer': 'https://music.163.com/' });
    var lyricData = JSON.parse(lyricRes);

    if (lyricData.lrc && lyricData.lrc.lyric) {
      var lyrics = lyricData.lrc.lyric;
      lyrics = lyrics.replace(/\[\d{2}:\d{2}\.\d{2,3}\]/g, '').trim();
      lyrics = lyrics.split('\n').filter(function(l) { return l.trim(); }).join('\n');
      return lyrics;
    }
  } catch(e) {
  }
  return '';
}

// 从QQ音乐获取歌词
async function fetchQQLyrics(songName, artist) {
  var searchArtist = artist || '';
  if (searchArtist) {
    searchArtist = searchArtist.replace(/[和的与&]/g, " ").replace(/s+/g, " ").trim();
  }
  var keyword = songName + (searchArtist ? ' ' + searchArtist : '');

  try {
    // 1. 搜索
    var searchUrl = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=' + encodeURIComponent(keyword) + '&format=json&n=10&p=1';
    var searchRes = await httpGet(searchUrl, { 'Referer': 'https://y.qq.com/' });
    var searchData = JSON.parse(searchRes);

    if (!searchData.data || !searchData.data.song || !searchData.data.song.list || searchData.data.song.list.length === 0) {
      return '';
    }

    // 2. 找最佳匹配
    var bestMatch = null;
    var songs = searchData.data.song.list;
    for (var i = 0; i < songs.length; i++) {
      var sname = songs[i].songname || '';
      var sartist = songs[i].singer && songs[i].singer[0] ? songs[i].singer[0].name : '';
      if (!matchSongName(sname, songName)) continue;
      if (artist && !matchArtist(sartist, artist)) continue;
      bestMatch = songs[i];
      break;
    }
    if (!bestMatch) {
      for (var i = 0; i < songs.length; i++) {
        if (matchSongName(songs[i].songname || '', songName)) {
          bestMatch = songs[i];
          break;
        }
      }
    }
    if (!bestMatch) bestMatch = songs[0];


    // 3. 获取歌词
    var mid = bestMatch.songmid;
    var lyricUrl = 'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=' + mid + '&format=json&nobase64=1';
    var lyricRes = await httpGet(lyricUrl, { 'Referer': 'https://y.qq.com/', 'Cookie': '' });
    var lyricData = JSON.parse(lyricRes);

    if (lyricData.lyric) {
      var lyrics = lyricData.lyric;
      lyrics = lyrics.replace(/\[\d{2}:\d{2}\.\d{2,3}\]/g, '').trim();
      lyrics = lyrics.split('\n').filter(function(l) { return l.trim(); }).join('\n');
      return lyrics;
    }
  } catch(e) {
  }
  return '';
}

var GLM_API_KEY = process.env.GLM_API_KEY || '';
var GLM_MODEL = process.env.GLM_MODEL || 'glm-4.6v-flash';
var GLM_API_URL = process.env.GLM_API_URL || 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
var GLM_TIMEOUT_MS = parsePositiveInt(process.env.GLM_TIMEOUT_MS, 15000);
var GLM_THINKING = ['enabled', 'disabled'].includes(process.env.GLM_THINKING) ? process.env.GLM_THINKING : 'disabled';

function parsePositiveInt(value, fallback) {
  var parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getTextFromMessage(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content.filter(function(block) {
      return block && block.type === 'text' && block.text;
    }).map(function(block) {
      return block.text;
    }).join('\n');
  }
  return '';
}

function getGLMMessages(systemPrompt, messages) {
  var result = [{ role: 'system', content: systemPrompt }];
  for (var i = 0; i < messages.length; i++) {
    var message = messages[i] || {};
    // 保留 image_url/video_url/file_url 等 content block，供 GLM 多模态调用使用。
    result.push({ role: message.role, content: message.content });
  }
  return result;
}

function getGLMRequestOptions() {
  var endpoint = new URL(GLM_API_URL);
  if (endpoint.protocol !== 'https:') {
    throw new Error('GLM_API_URL 必须使用 HTTPS');
  }
  return {
    hostname: endpoint.hostname,
    port: endpoint.port || 443,
    path: endpoint.pathname + endpoint.search
  };
}

function getResponseText(json) {
  if (!json || !json.choices || !json.choices[0]) return '';
  return getTextFromMessage(json.choices[0].message).trim();
}

// ===== 智谱 GLM API（OpenAI 兼容的 Chat Completions） =====
function callGLMOnce(systemPrompt, messages, maxTokens) {
  var body = JSON.stringify({
    model: GLM_MODEL,
    messages: getGLMMessages(systemPrompt, messages),
    max_tokens: maxTokens || 300,
    temperature: 0.7,
    thinking: { type: GLM_THINKING },
    stream: false
  });
  var options = getGLMRequestOptions();

  return new Promise(function(resolve, reject) {
    var req = https.request(Object.assign({}, options, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + GLM_API_KEY,
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: GLM_TIMEOUT_MS
    }), function(res) {
      var data = '';
      res.setEncoding('utf8');
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          var errorPayload = {};
          try { errorPayload = JSON.parse(data); } catch (e) {}
          var providerError = errorPayload.error || errorPayload;
          var providerCode = providerError && providerError.code ? String(providerError.code) : '';
          var providerMessage = providerError && providerError.message ? String(providerError.message) : '';
          var error = new Error('GLM HTTP' + res.statusCode + (providerCode ? ' (' + providerCode + ')' : ''));
          error.statusCode = res.statusCode;
          error.providerCode = providerCode;
          error.providerMessage = providerMessage;
          error.retryable = res.statusCode === 429 || providerCode === '1305';
          var retryAfter = parseFloat(res.headers && res.headers['retry-after']);
          if (Number.isFinite(retryAfter) && retryAfter > 0) {
            error.retryAfterMs = Math.min(retryAfter * 1000, 5000);
          }
          return reject(error);
        }
        try {
          var json = JSON.parse(data);
          var text = getResponseText(json);
          if (text) return resolve(text);
          reject(new Error('GLM 响应格式异常'));
        } catch (e) {
          reject(new Error('GLM JSON解析失败: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', function() {
      req.destroy();
      reject(new Error('GLM超时(' + (GLM_TIMEOUT_MS / 1000) + '秒)'));
    });
    req.write(body);
    req.end();
  });
}

// 免费模型高峰期会返回 429/1305；短暂重试一次，避免把瞬时拥堵直接暴露给用户。
async function callGLM(systemPrompt, messages, maxTokens) {
  var maxAttempts = 2;
  for (var attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await callGLMOnce(systemPrompt, messages, maxTokens);
    } catch (err) {
      if (!err.retryable || attempt >= maxAttempts) throw err;
      var delay = err.retryAfterMs || (attempt * 1200);
      await new Promise(function(resolve) { setTimeout(resolve, delay); });
    }
  }
}

function callGLMStream(systemPrompt, messages, maxTokens, onToken) {
  var body = JSON.stringify({
    model: GLM_MODEL,
    messages: getGLMMessages(systemPrompt, messages),
    max_tokens: maxTokens || 4096,
    temperature: 0.8,
    thinking: { type: GLM_THINKING },
    stream: true
  });
  var options = getGLMRequestOptions();
  var timeoutMs = parsePositiveInt(process.env.GLM_STREAM_TIMEOUT_MS, 60000);

  return new Promise(function(resolve, reject) {
    var fullText = '';
    var buffer = '';
    var req = https.request(Object.assign({}, options, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + GLM_API_KEY,
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: timeoutMs
    }), function(res) {
      res.setEncoding('utf8');
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.on('data', function() {});
        res.on('end', function() { reject(new Error('GLM HTTP' + res.statusCode)); });
        return;
      }
      res.on('data', function(chunk) {
        buffer += chunk;
        var lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i].trim();
          if (!line || line.indexOf('data:') !== 0) continue;
          var data = line.substring(5).trim();
          if (data === '[DONE]') continue;
          try {
            var json = JSON.parse(data);
            var delta = json.choices && json.choices[0] && json.choices[0].delta;
            var token = delta && delta.content ? delta.content : '';
            if (token) {
              fullText += token;
              if (onToken) onToken(token);
            }
          } catch (e) {}
        }
      });
      res.on('end', function() {
        if (fullText.trim()) resolve(fullText.trim());
        else reject(new Error('GLM 流式响应为空'));
      });
    });
    req.on('error', reject);
    req.on('timeout', function() {
      req.destroy();
      reject(new Error('GLM流式请求超时'));
    });
    req.write(body);
    req.end();
  });
}

// 清理AI思考过程和Markdown格式
function cleanAIOutput(text) {
  if (!text) return '';
  var t = text;
  // 去掉<think>标签
  t = t.replace(/<think>[\s\S]*?<\/think>/g, '');
  // 去掉常见AI思考/推理模式
  t = t.replace(/(?:^|\n)(?:让我|我需要|首先|接下来|实际上|让我先|我应该|我想要|我必须|我认为|我觉得|我来写|我先|我想|我来构思|让我想|让我重新|让我来|我需要写|让我构思|让我思考|我需要了解|我需要确认|我应该避免|我应该诚实|我可以查找|这首歌的核心|让我想想|我想要捕捉|我需要诚实|这首歌是|这首歌的|这首歌曲的|我应该|我需要|我来|让我|我先|我想)[^\n]*/g, '');
  // 去掉英文思考模式
  t = t.replace(/(?:^|\n)(?:The user|They want|We need|Thus we|I think|I need|I should|Let me|First|Next|Actually|In this)[^\n]*/g, '');
  // 去掉以"-"开头的思考行
  t = t.replace(/^-\s+[^\n]*\n?/gm, '');
  // 去掉解释性行
  t = t.replace(/^(?:实际上|说实话|坦白说|其实|具体来说|简单来说|总的来说|这样我们|这样可以|我们需要|我们可以|这意味着|也就是说)[^\n]*\n?/gm, '');
  // 去掉AI分析/检查行
  t = t.replace(/^(?:检查|验证|确认|需要|要求|去掉|精简|控制在|保留|去掉多余|确保)[^\n]*\n?/gm, '');
  // 去掉"文案："前缀和重复的文案内容
  t = t.replace(/^文案[：:]\s*/gm, '');
  // 去掉包含"要求："或"步骤"的行
  t = t.replace(/^(?:\d+[.、]?\s*)?(?:要求|步骤|分析|注意|总结|说明)[：:][^\n]*\n?/gm, '');
  // 去掉空的Markdown标题
  t = t.replace(/^#{1,6}\s*$/gm, '');
  t = t.replace(/\*\*/g, '');
  t = t.replace(/^>\s*/gm, '');
  t = t.replace(/^---+$/gm, '');
  // 清理异常Unicode字符
  t = t.replace(/[​‌‍﻿�￾￿]/g, '');
  // 清理控制字符
  t = t.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  t = t.replace(/\n{3,}/g, '\n\n');
  t = t.trim();
  // 如果清理后内容过短或看起来不像文案，取最后一个完整段落
  var lines = t.split('\n').filter(function(l) { return l.trim().length > 10; });
  if (lines.length > 3) {
    // 取最后几行（通常是最终文案）
    t = lines.slice(-3).join('\n').trim();
  }
  return t;
}

async function getHistory(openid) {
  try {
    var [rows] = await pool.execute(
      'SELECT role, content FROM ai_conversations WHERE openid = ? ORDER BY id DESC LIMIT 10',
      [openid]
    );
    var msgs = [];
    for (var i = rows.length - 1; i >= 0; i--) {
      msgs.push({ role: rows[i].role, content: [{ type: 'text', text: rows[i].content }] });
    }
    return msgs;
  } catch (err) {
    return [];
  }
}

async function saveHistory(openid, userText, aiReply) {
  try {
    await pool.execute('INSERT INTO ai_conversations (openid, role, content) VALUES (?, "user", ?)', [openid, userText]);
    await pool.execute('INSERT INTO ai_conversations (openid, role, content) VALUES (?, "assistant", ?)', [openid, aiReply]);
  } catch (err) {
  }
}

async function getAIReply(text, openid) {
  var systemPrompt = '你是“墙墙”，示例中学校园墙的微信学姐助手。语气自然、亲切、简洁，像朋友聊天；只回答当前问题，通常不超过100字，不输出思考过程或Markdown。\n\n功能指引：想投稿就回复「投稿」；校园广播点歌打开 https://campus-wall.example/radio；推荐歌曲到公众号回复「推歌」；不确定的信息不要编造。注意区分“点歌”和“推歌”。';

  // 获取历史记录，提供上下文
  var history = [];
  if (openid) {
    history = await getHistory(openid);
  }
  var messages = history.concat([{ role: 'user', content: [{ type: 'text', text: text }] }]);

  if (!GLM_API_KEY) return 'AI 服务尚未配置，请联系管理员设置 GLM_API_KEY。';
  try {
    var reply = await callGLM(systemPrompt, messages);
    reply = reply.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    if (reply) {
      if (openid) await saveHistory(openid, text, reply);
      return reply;
    }
  } catch (err) {
    if (err.providerCode === '1305' || err.statusCode === 429) {
      return '当前模型访问量较大，请稍后再试。';
    }
    return 'AI 服务暂时不可用，请稍后再试。';
  }

  return 'AI 服务返回空内容，请稍后再试。';
}

// 使用 GLM-4.6V-Flash 识别公众号图片，失败时由上层返回静态兜底。
async function getAIImageReply(prompt, imageBase64, openid) {
  if (!GLM_API_KEY) throw new Error('GLM_API_KEY 未配置');
  if (!imageBase64) throw new Error('图片内容为空');

  var messages = [{
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: imageBase64 } },
      { type: 'text', text: prompt || '请用中文简短描述这张图片；如果包含清晰文字，请一并提取。' }
    ]
  }];
  var reply = await callGLM('你是校园墙微信里的识图助手。只根据图片中能确认的内容回答，简洁、友好，不猜测人物身份或隐私信息；如果看不清就直接说明。', messages, 300);
  reply = reply.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (!reply) throw new Error('GLM 图片回复为空');
  if (openid) await saveHistory(openid, '[图片] ' + (prompt || '请描述这张图片'), reply);
  return reply;
}



// ===== 兜底规则回复 =====
function getRuleReply(text) {
  var t = text.trim();
  var h = new Date().getHours();

  // 问候
  if (/你好|hi|hello|在吗|在不在|嗨/i.test(t)) {
    return '👋 你好呀！有什么想聊的或者需要帮忙的吗？\n\n回复"帮助"可以查看我能做什么哦~';
  }
  // 时间
  if (/时间|几点了/i.test(t)) {
    return '🕐 现在是' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) + '~\n' + (h < 12 ? '上午好！' : h < 18 ? '下午好！' : '晚上好！');
  }
  // 天气
  if (/天气|气温|温度/i.test(t)) {
    return '🌤️ 天气信息暂时查不到，你可以直接去 https://campus-wall.example 看看首页的天气卡片哦~';
  }
  // 投稿
  if (/投稿|发帖|发布/i.test(t)) {
    return '📝 想投稿？很简单！\n\n打开 https://campus-wall.example → 点击"发布"→ 写内容提交就行~\n审核通过后就能在墙上看到啦！';
  }
  // 点歌
  if (/点歌|歌曲|音乐/i.test(t)) {
    return '🎵 想点歌？\n\n打开 https://campus-wall.example → 进入"点歌"页面 → 选时段和歌曲 → 提交~\n校广播站会定时播放哦！';
  }
  // 绑定
  if (/绑定|微信/i.test(t)) {
    return '🔗 微信绑定教程\n\n打开 https://campus-wall.example → 登录 → 个人中心 → 绑定微信 → 扫码即可~\n绑定后能收到评论和点赞通知哦~';
  }
  // 学校
  if (/学校|嘉定|二中/i.test(t)) {
    return '🏫 上海市嘉定区第二中学\n📍 德华路388号\n🌐 校园墙：https://campus-wall.example';
  }
  // 夸夸
  if (/真棒|厉害|大佬|牛逼/i.test(t)) {
    return '😄 谢谢夸奖！有什么需要帮忙的尽管说~';
  }
  // 无聊
  if (/无聊|好无聊|闲/i.test(t)) {
    return '😊 无聊的话可以去校园墙逛逛~ https://campus-wall.example\n看看大家在聊什么，或者发个帖找人聊天也行！';
  }

  // 兜底
  return '💬 回复"帮助"查看我能做什么吧~\n🌐 https://campus-wall.example';
}

// ===== AI 生成小说章节 =====
async function generateChapter(prompt) {
  var systemPrompt = '你是校园青春小说作家。用清新自然、有画面感的中文写作，保持人物情绪真实、情节连贯，只输出成稿，不输出分析或说明。';
  var messages = [{ role: 'user', content: prompt }];

  if (!GLM_API_KEY) throw new Error('GLM_API_KEY 未配置');
  var reply = await callGLM(systemPrompt, messages, 4096);
  reply = cleanAIOutput(reply);
  if (reply && reply.length > 50) return reply;
  throw new Error('GLM 返回内容过短');
}

// ===== AI 流式生成小说章节 =====
// onToken: callback(text) called for each token chunk
// returns Promise<fullText>
async function generateChapterStream(prompt, onToken) {
  var systemPrompt = '你是校园青春小说作家。用清新自然、有画面感的中文写作，保持人物情绪真实、情节连贯，只输出成稿，不输出分析或说明。';
  var messages = [{ role: 'user', content: prompt }];

  // 仅使用智谱 GLM 流式生成；不再回退到其他模型。
  if (!GLM_API_KEY) throw new Error('GLM_API_KEY 未配置');
  try {
    var glmReply = await callGLMStream(systemPrompt, messages, 4096, onToken);
    glmReply = cleanAIOutput(glmReply);
    if (glmReply && glmReply.length > 50) return glmReply;
    throw new Error('GLM 返回内容过短');
  } catch(e) {
    throw e;
  }
}

// 生成歌曲介绍
async function generateSongIntro(songName, artist) {
  // 先抓真实歌词
  var realLyrics = '';
  try {
    realLyrics = await fetchNeteaseLyrics(songName, artist);
    if (!realLyrics) realLyrics = await fetchQQLyrics(songName, artist);
  } catch(e) {}

  // 把歌词截取关键段落
  var lyricSnippet = '';
  if (realLyrics) {
    var lines = realLyrics.split('\n').filter(function(l) { return l.trim().length > 2; });
    lyricSnippet = lines.slice(0, 20).join('\n');
  }

  var prompt = '请为歌曲《' + songName + '》' + (artist ? '（' + artist + '）' : '') + '写一段约120字的校园公众号推荐语。仅根据下方歌词可确认的情绪和主题创作，不补写歌词，不用Markdown，不要标题、编号或分析，只输出成稿。\n\n歌词片段：\n' + (lyricSnippet || '（未获取到歌词，请只根据歌名和歌手写，不要虚构歌词）');

  var messages = [{ role: 'user', content: [{ type: 'text', text: prompt }] }];
  var systemMsg = '你是校园公众号编辑。输出一段自然、克制、有画面感的中文推荐语，不输出分析、歌词列表或未提供的事实。';

  try {
    if (!GLM_API_KEY) return { intro: '', lyrics: '', prompt: prompt, error: 'GLM_API_KEY 未配置' };
    var reply = await callGLM(systemMsg, messages, 1500);
    if (reply) {
      reply = cleanAIOutput(reply);
      // 解析结构化内容（用 --- 分隔介绍和歌词）
      var intro = '';
      var lyrics = '';
      var parts = reply.split(/\n---\n/);
      if (parts.length >= 2) {
        intro = parts[0].replace(/【介绍】/g, '').trim();
        lyrics = parts.slice(1).join('\n---\n').replace(/【歌词】/g, '').replace(/---END---/g, '').trim();
      } else {
        // 没有分隔符，尝试其他格式
        var lyricsMatch = reply.match(/---LYRICS---([\s\S]*?)---END---/);
        if (lyricsMatch) {
          lyrics = lyricsMatch[1].trim();
          intro = reply.replace(/【介绍】[\s\S]*?---LYRICS---/,'').replace(/---END---[\s\S]*$/,'').trim();
          var introMatch = reply.match(/【介绍】([\s\S]*?)---LYRICS---/);
          if (introMatch) intro = introMatch[1].trim();
        } else {
          intro = reply.replace(/【介绍】/g, '').replace(/【歌词】/g, '').trim();
        }
      }
      return { intro: intro, lyrics: lyrics || realLyrics || '', prompt: null };
    }
  } catch(e) {
    console.error('[AI] 生成歌曲介绍失败:', e.message);
    return { intro: '', lyrics: '', prompt: prompt, error: 'GLM 服务暂时不可用' };
  }
  return { intro: '', lyrics: '', prompt: prompt, error: 'GLM 返回内容为空' };
}

// 搜索歌曲详细信息（网易云+QQ+AI三源）
async function searchSongInfo(songName, artist) {
  // 搜索时只用歌名（去掉中文歌手名避免干扰搜索）
  var searchName = songName;
  var searchArtist = artist || '';
  // 如果歌手名含中文，提取英文部分用于搜索
  if (searchArtist) {
    searchArtist = searchArtist.replace(/[和的与&]/g, " ").replace(/s+/g, " ").trim();
  }
  var keyword = searchName;

  // 方法1：网易云元数据
  try {
    var searchUrl = 'https://music.163.com/api/search/get?s=' + encodeURIComponent(keyword) + '&type=1&limit=10';
    var searchRes = await httpGet(searchUrl, { 'Referer': 'https://music.163.com/' });
    var searchData = JSON.parse(searchRes);
    if (searchData.result && searchData.result.songs && searchData.result.songs.length > 0) {
      var songs = searchData.result.songs;
      var best = null;
      var bestArtistCount = 999;
      for (var i = 0; i < songs.length; i++) {
        var sname = songs[i].name || '';
        var sartist = (songs[i].artists || []).map(function(a) { return a.name || ''; }).join(' ');
        if (!matchSongName(sname, songName)) continue;
        if (artist && !matchArtist(sartist, artist)) continue;
        // 优先选歌手少的（更精确的版本）
        var acount = (songs[i].artists || []).length;
        if (acount < bestArtistCount) { best = songs[i]; bestArtistCount = acount; }
      }
      if (!best) {
        for (var i = 0; i < songs.length; i++) {
          if (matchSongName(songs[i].name || '', songName)) { best = songs[i]; break; }
        }
      }
      if (!best) best = songs[0];
      if (best) {
        var albumName = best.album && best.album.name ? best.album.name : '-';
        var year = best.album && best.album.publishTime ? new Date(best.album.publishTime).getFullYear() + '' : '-';
        var duration = best.duration ? Math.floor(best.duration / 60000) + ':' + String(Math.floor((best.duration % 60000) / 1000)).padStart(2, '0') : '-';

        // 尝试获取专辑详情（含介绍）
        var albumIntro = '';
        if (best.album && best.album.id) {
          try {
            var detailUrl = 'https://music.163.com/api/album/' + best.album.id;
            var detailRes = await httpGet(detailUrl, { 'Referer': 'https://music.163.com/' });
            var detailData = JSON.parse(detailRes);
            if (detailData.album && detailData.album.description) {
              albumIntro = detailData.album.description.trim();
            }
          } catch(e) {}
        }

        return { album: albumName, year: year, duration: duration, intro: albumIntro };
      }
    }
  } catch(e) {}

  // 方法2：QQ音乐
  try {
    var qqUrl = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=' + encodeURIComponent(keyword) + '&format=json&n=5&p=1';
    var qqRes = await httpGet(qqUrl, { 'Referer': 'https://y.qq.com/' });
    var qqData = JSON.parse(qqRes);
    if (qqData.data && qqData.data.song && qqData.data.song.list && qqData.data.song.list.length > 0) {
      var songs = qqData.data.song.list;
      var best = null;
      for (var i = 0; i < songs.length; i++) {
        if (matchSongName(songs[i].songname || '', songName)) { best = songs[i]; break; }
      }
      if (!best) best = songs[0];
      if (best) {
        var albumName = best.albumname || '-';
        var dur = best.interval ? Math.floor(best.interval / 60) + ':' + String(best.interval % 60).padStart(2, '0') : '-';
        return { album: albumName, year: '-', duration: dur };
      }
    }
  } catch(e) {}

  return null;
}

// 搜索歌曲歌词（网易云+QQ+AI三源）
async function searchSongLyrics(songName, artist) {

  // 方法1：网易云
  var rawLyrics = '';
  try {
    rawLyrics = await fetchNeteaseLyrics(songName, artist);
    if (!(rawLyrics && rawLyrics.length > 10)) rawLyrics = '';
  } catch(e) {}

  // 方法2：QQ音乐
  if (!rawLyrics) {
    try {
      rawLyrics = await fetchQQLyrics(songName, artist);
      if (!(rawLyrics && rawLyrics.length > 10)) rawLyrics = '';
    } catch(e) {}
  }

  // 方法3：AI兜底
  if (!rawLyrics) {
    try {
      var prompt = '只输出歌曲《' + songName + '》' + (artist ? '（' + artist + '）' : '') + '的已知歌词原文，每行一句；无法确认时只回复“暂无歌词”，不要编造。';
      var messages = [{ role: 'user', content: [{ type: 'text', text: prompt }] }];
      var reply = null;
      if (GLM_API_KEY) { try { reply = await callGLM('只输出歌词原文，不要解释或补充。', messages, 2000); } catch(e) {} }
      if (reply) {
        reply = reply.replace(/<[^>]*think[^>]*>/g, '').trim();
        reply = reply.replace(/^["'"「「]|["'"」」]$/gm, '');
        reply = reply.replace(/^#{1,3}\s+/gm, '');
        reply = reply.replace(/\*\*/g, '');
        if (reply && !/暂无歌词|没有找到/.test(reply)) return reply;
      }
    } catch(e) {}
    return '';
  }

  // 用AI从原版歌词中精选排版
  try {
    var prompt2 = '从下面《' + songName + '》歌词中原样选取2-3段代表性歌词；每行一句，只输出歌词，不加标题、引号、评论或改写，歌词较短就全部输出。\n\n' + rawLyrics;
    var messages2 = [{ role: 'user', content: [{ type: 'text', text: prompt2 }] }];
    var reply2 = null;
    if (GLM_API_KEY) { try { reply2 = await callGLM('只输出歌词原文，一字不改，不要解释。', messages2, 1500); } catch(e) {} }
    if (reply2) {
      reply2 = reply2.replace(/<[^>]*think[^>]*>/g, '').trim();
      reply2 = reply2.replace(/^["'"「「]|["'"」」]$/gm, '');
      reply2 = reply2.replace(/^#{1,3}\s+/gm, '');
      reply2 = reply2.replace(/\*\*/g, '');
      reply2 = reply2.replace(/^>\s*/gm, '');
      reply2 = reply2.replace(/【[^】]*】/g, '');
      if (reply2.length > 20) return reply2;
    }
    return rawLyrics;
  } catch(e) { return rawLyrics; }
}

// AI生成歌词（兜底）
async function aiGenerateLyrics(songName, artist) {
  try {
    var prompt = '只输出歌曲《' + songName + '》' + (artist ? '（' + artist + '）' : '') + '的已知歌词原文，每行一句；无法确认时只回复“暂无歌词”，不要编造。';
    var messages = [{ role: 'user', content: [{ type: 'text', text: prompt }] }];
    var reply = null;
    if (GLM_API_KEY) { try { reply = await callGLM('只输出歌词原文，不要解释或补充。', messages, 2000); } catch(e) {} }
    if (reply) {
      reply = reply.replace(/<[^>]*think[^>]*>/g, '').trim();
      reply = reply.replace(/^["'"「「]|["'"」」]$/gm, '');
      reply = reply.replace(/^#{1,3}\s+/gm, '');
      reply = reply.replace(/\*\*/g, '');
      if (reply && !/暂无歌词|没有找到/.test(reply)) return reply;
    }
  } catch(e) {}
  return '';
}

module.exports = { getAIReply, getAIImageReply, generateChapter, generateChapterStream, generateSongIntro, searchSongInfo, searchSongLyrics };
