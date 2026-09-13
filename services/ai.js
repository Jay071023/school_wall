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
var GLM_TIMEOUT_MS = parsePositiveInt(process.env.GLM_TIMEOUT_MS, 10000);
var GLM_THINKING = ['enabled', 'disabled'].includes(process.env.GLM_THINKING) ? process.env.GLM_THINKING : 'disabled';
// 仅用于纯文本请求的备用通道；未配置时不会切换，也不会把密钥写入前端。
var QWEN_API_KEY = process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY || '';
var QWEN_MODEL = process.env.QWEN_MODEL || 'qwen-plus';
var QWEN_API_URL = process.env.QWEN_API_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
var QWEN_TIMEOUT_MS = parsePositiveInt(process.env.QWEN_TIMEOUT_MS, 10000);
// 腾讯混元 CloudBase provider：成长计划网关必须通过 CloudBase Node SDK 调用，
// 不能把 CLOUDBASE_APIKEY 直接当作普通 OpenAI 兼容接口的 Bearer token。
var HUNYUAN_MODEL = process.env.HUNYUAN_MODEL || 'hy3';
var CLOUDBASE_ENV_ID = process.env.CLOUDBASE_ENV_ID || process.env.HUNYUAN_ENV_ID || '';
var CLOUDBASE_APIKEY = process.env.CLOUDBASE_APIKEY || process.env.HUNYUAN_API_KEY || '';
var HUNYUAN_TIMEOUT_MS = parsePositiveInt(process.env.HUNYUAN_TIMEOUT_MS, 60000);
var cloudbaseTextModel = null;
var cloudbaseProviderError = null;

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

function getOpenAICompatibleRequestOptions(apiUrl, providerName) {
  var endpoint = new URL(apiUrl);
  if (endpoint.protocol !== 'https:') {
    throw new Error(providerName + '_API_URL 必须使用 HTTPS');
  }
  return {
    hostname: endpoint.hostname,
    port: endpoint.port || 443,
    path: endpoint.pathname + endpoint.search
  };
}

function getTextOnlyMessages(systemPrompt, messages) {
  var result = [{ role: 'system', content: systemPrompt }];
  for (var i = 0; i < messages.length; i++) {
    var message = messages[i] || {};
    var text = getTextFromMessage(message);
    if (text) result.push({ role: message.role || 'user', content: text });
  }
  return result;
}

function getQwenFallbackProvider() {
  if (!QWEN_API_KEY) return null;
  return {
    name: 'Qwen',
    apiKey: QWEN_API_KEY,
    model: QWEN_MODEL,
    apiUrl: QWEN_API_URL,
    timeoutMs: QWEN_TIMEOUT_MS
  };
}

function getHunyuanProvider() {
  if (!CLOUDBASE_ENV_ID || !CLOUDBASE_APIKEY) return null;
  if (cloudbaseTextModel) return {
    name: 'Hunyuan',
    model: HUNYUAN_MODEL,
    sdkModel: cloudbaseTextModel
  };
  if (cloudbaseProviderError) return null;
  try {
    // 延迟加载，未配置混元时不增加服务启动依赖和开销。
    var cloudbase = require('@cloudbase/node-sdk');
    var app = cloudbase.init({
      env: CLOUDBASE_ENV_ID,
      accessKey: CLOUDBASE_APIKEY,
      timeout: HUNYUAN_TIMEOUT_MS
    });
    cloudbaseTextModel = app.ai().createModel('cloudbase');
    return {
      name: 'Hunyuan',
      model: HUNYUAN_MODEL,
      sdkModel: cloudbaseTextModel
    };
  } catch (err) {
    cloudbaseProviderError = err;
    console.warn('[AI] 混元 CloudBase provider 不可用:', err && (err.code || err.message || '初始化失败'));
    return null;
  }
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
          // 免费模型高峰期的 1305、限流和短暂 5xx 都可能在数秒内恢复。
          // 统一交给 callGLM 做有限退避，避免歌曲编辑器直接把瞬时波动报成失败。
          error.retryable = res.statusCode === 429 || res.statusCode >= 500 || providerCode === '1305';
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
      var timeoutError = new Error('GLM超时(' + (GLM_TIMEOUT_MS / 1000) + '秒)');
      timeoutError.code = 'ETIMEDOUT';
      timeoutError.retryable = true;
      reject(timeoutError);
    });
    req.write(body);
    req.end();
  });
}

// 免费模型高峰期会返回 429/1305；有限退避重试，避免把瞬时拥堵直接暴露给用户。
async function callGLM(systemPrompt, messages, maxTokens, options) {
  var maxAttempts = options && Number.isInteger(options.maxAttempts) ? options.maxAttempts : 3;
  for (var attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await callGLMOnce(systemPrompt, messages, maxTokens);
    } catch (err) {
      var transientTransport = !err.statusCode && ['ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ETIMEDOUT'].includes(err.code);
      if ((!err.retryable && !transientTransport) || attempt >= maxAttempts) throw err;
      var delay = err.retryAfterMs || (attempt * 1800);
      await new Promise(function(resolve) { setTimeout(resolve, delay); });
    }
  }
}

function callOpenAICompatibleOnce(provider, systemPrompt, messages, maxTokens) {
  var body = JSON.stringify({
    model: provider.model,
    messages: getTextOnlyMessages(systemPrompt, messages),
    max_tokens: maxTokens || 300,
    temperature: 0.7,
    stream: false
  });
  var options = getOpenAICompatibleRequestOptions(provider.apiUrl, provider.name.toUpperCase());

  return new Promise(function(resolve, reject) {
    var req = https.request(Object.assign({}, options, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + provider.apiKey,
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: provider.timeoutMs
    }), function(res) {
      var data = '';
      res.setEncoding('utf8');
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          var errorPayload = {};
          try { errorPayload = JSON.parse(data); } catch (e) {}
          var providerError = errorPayload.error || errorPayload;
          var error = new Error(provider.name + ' HTTP' + res.statusCode);
          error.statusCode = res.statusCode;
          error.providerCode = providerError && providerError.code ? String(providerError.code) : '';
          error.retryable = res.statusCode === 408 || res.statusCode === 429 || res.statusCode >= 500;
          return reject(error);
        }
        try {
          var text = getResponseText(JSON.parse(data));
          if (text) return resolve(text);
          reject(new Error(provider.name + ' 响应格式异常'));
        } catch (e) {
          reject(new Error(provider.name + ' JSON解析失败: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', function() {
      req.destroy();
      var timeoutError = new Error(provider.name + '超时(' + (provider.timeoutMs / 1000) + '秒)');
      timeoutError.code = 'ETIMEDOUT';
      timeoutError.retryable = true;
      reject(timeoutError);
    });
    req.write(body);
    req.end();
  });
}

async function callHunyuanOnce(provider, systemPrompt, messages, maxTokens) {
  var result = await provider.sdkModel.generateText({
    model: provider.model,
    messages: getTextOnlyMessages(systemPrompt, messages),
    max_tokens: maxTokens || 300,
    temperature: 0.7
  });
  var text = result && typeof result.text === 'string' ? result.text.trim() : '';
  if (!text && result && Array.isArray(result.rawResponses)) {
    for (var i = 0; i < result.rawResponses.length; i++) {
      text = getResponseText(result.rawResponses[i]);
      if (text) break;
    }
  }
  if (!text) throw new Error('Hunyuan 响应为空');
  return text;
}

async function callHunyuanStream(provider, systemPrompt, messages, maxTokens, onToken) {
  var response = await provider.sdkModel.streamText({
    model: provider.model,
    messages: getTextOnlyMessages(systemPrompt, messages),
    max_tokens: maxTokens || 4096,
    temperature: 0.8
  });
  var fullText = '';
  if (!response || !response.textStream || typeof response.textStream[Symbol.asyncIterator] !== 'function') {
    throw new Error('Hunyuan 流式响应格式异常');
  }
  for await (var text of response.textStream) {
    if (!text) continue;
    fullText += text;
    if (onToken) onToken(text);
  }
  if (!fullText.trim()) throw new Error('Hunyuan 流式响应为空');
  return fullText.trim();
}

function shouldTryTextFallback(error) {
  return !!(error && (error.retryable || !error.statusCode || error.statusCode === 408 || error.statusCode === 429 || error.statusCode >= 500));
}

// 混元正常时优先使用；配置了后续 provider 时，前面的模型只尝试一次，
// 让用户尽快得到降级结果，而不是先等待多轮退避。
async function callTextWithFallback(systemPrompt, messages, maxTokens) {
  var hunyuan = getHunyuanProvider();
  var qwen = getQwenFallbackProvider();
  if (!hunyuan && !GLM_API_KEY && !qwen) {
    throw new Error('未配置 CloudBase 混元、GLM 或 DASHSCOPE_API_KEY');
  }

  var lastError = null;
  if (hunyuan) {
    try {
      return { text: await callHunyuanOnce(hunyuan, systemPrompt, messages, maxTokens), provider: 'hunyuan' };
    } catch (hunyuanError) {
      lastError = hunyuanError;
      console.warn('[AI] 混元主服务失败，切换 GLM:', hunyuanError && hunyuanError.message);
    }
  }
  if (GLM_API_KEY) {
    try {
      var glmText = await callGLM(systemPrompt, messages, maxTokens, qwen || hunyuan ? { maxAttempts: 1 } : undefined);
      return { text: glmText, provider: 'glm' };
    } catch (glmError) {
      lastError = glmError;
      if (!qwen && !hunyuan) throw glmError;
      console.warn('[AI] GLM 备用服务失败，切换千问:', glmError && glmError.message);
    }
  }
  if (qwen) {
    try {
      return { text: await callOpenAICompatibleOnce(qwen, systemPrompt, messages, maxTokens), provider: 'qwen' };
    } catch (qwenError) {
      lastError = qwenError;
      console.warn('[AI] Qwen 备用服务失败:', qwenError && qwenError.message);
    }
  }
  throw lastError || new Error('AI 服务不可用');
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
  var systemPrompt = '你是“墙墙”，示例校园校园墙的微信助手。请用简体中文、自然亲切的口吻直接回答，优先给可执行的下一步；普通问题控制在100字以内，不输出思考过程、Markdown标题或模板化客套话。\n\n服务指引：想投稿回复“投稿”；校园广播点歌打开 http://localhost:3000/radio；推荐歌曲到公众号回复“推歌”。严格区分“点歌”（排期播放）和“推歌”（公众号歌曲推荐）。只使用当前对话和已确认的站点信息；不确定时明确说不知道，不编造时间、规则、人物或链接。';

  // 获取历史记录，提供上下文
  var history = [];
  if (openid) {
    history = await getHistory(openid);
  }
  var messages = history.concat([{ role: 'user', content: [{ type: 'text', text: text }] }]);

  if (!getHunyuanProvider() && !GLM_API_KEY && !getQwenFallbackProvider()) {
    return 'AI 服务尚未配置，请联系管理员设置 CloudBase 混元、GLM 或 DASHSCOPE_API_KEY。';
  }
  try {
    var generation = await callTextWithFallback(systemPrompt, messages);
    var reply = generation.text;
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
      { type: 'text', text: prompt || '请用中文简短描述图片中能确认的主要内容；如有清晰可读文字，只提取与问题相关的部分。看不清的内容请明确说明，不要猜测。' }
    ]
  }];
  var reply = await callGLM('你是校园墙微信里的识图助手。只依据图片中确实可见的内容回答，先回应用户问题，再补充必要细节；简洁友好，不推断人物身份、地点、联系方式等隐私，不把模糊内容当成事实，看不清就直说。', messages, 300);
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
    return '🌤️ 天气信息暂时查不到，你可以直接去 http://localhost:3000 看看首页的天气卡片哦~';
  }
  // 投稿
  if (/投稿|发帖|发布/i.test(t)) {
    return '📝 想投稿？很简单！\n\n打开 http://localhost:3000 → 点击"发布"→ 写内容提交就行~\n审核通过后就能在墙上看到啦！';
  }
  // 点歌
  if (/点歌|歌曲|音乐/i.test(t)) {
    return '🎵 想点歌？\n\n打开 http://localhost:3000 → 进入"点歌"页面 → 选时段和歌曲 → 提交~\n校广播站会定时播放哦！';
  }
  // 绑定
  if (/绑定|微信/i.test(t)) {
    return '🔗 微信绑定教程\n\n打开 http://localhost:3000 → 登录 → 个人中心 → 绑定微信 → 扫码即可~\n绑定后能收到评论和点赞通知哦~';
  }
  // 学校
  if (/学校|嘉定|二中/i.test(t)) {
    return '🏫 上海市嘉定区第二中学\n📍 德华路388号\n🌐 校园墙：http://localhost:3000';
  }
  // 夸夸
  if (/真棒|厉害|大佬|牛逼/i.test(t)) {
    return '😄 谢谢夸奖！有什么需要帮忙的尽管说~';
  }
  // 无聊
  if (/无聊|好无聊|闲/i.test(t)) {
    return '😊 无聊的话可以去校园墙逛逛~ http://localhost:3000\n看看大家在聊什么，或者发个帖找人聊天也行！';
  }

  // 兜底
  return '💬 回复"帮助"查看我能做什么吧~\n🌐 http://localhost:3000';
}

// ===== AI 生成小说章节 =====
async function generateChapter(prompt) {
  var systemPrompt = '你是校园青春小说编辑兼作者。根据用户提供的设定写出连贯成稿：人物动机清楚，情绪克制真实，场景具体但不堆砌辞藻，前后设定不能自相矛盾。只输出正文，不输出提纲、分析、免责声明或“以下是”等套话；没有给出的关键信息不要擅自补成既定事实。';
  var messages = [{ role: 'user', content: prompt }];

  if (!getHunyuanProvider() && !GLM_API_KEY && !getQwenFallbackProvider()) {
    throw new Error('未配置 CloudBase 混元、GLM 或 DASHSCOPE_API_KEY');
  }
  var generation = await callTextWithFallback(systemPrompt, messages, 4096);
  var reply = generation.text;
  reply = cleanAIOutput(reply);
  if (reply && reply.length > 50) return reply;
  throw new Error('AI 返回内容过短');
}

// ===== AI 流式生成小说章节 =====
// onToken: callback(text) called for each token chunk
// returns Promise<fullText>
async function generateChapterStream(prompt, onToken) {
  var systemPrompt = '你是校园青春小说编辑兼作者。根据用户提供的设定写出连贯成稿：人物动机清楚，情绪克制真实，场景具体但不堆砌辞藻，前后设定不能自相矛盾。只输出正文，不输出提纲、分析、免责声明或“以下是”等套话；没有给出的关键信息不要擅自补成既定事实。';
  var messages = [{ role: 'user', content: prompt }];

  var hunyuan = getHunyuanProvider();
  if (hunyuan) {
    try {
      var hunyuanReply = await callHunyuanStream(hunyuan, systemPrompt, messages, 4096, onToken);
      hunyuanReply = cleanAIOutput(hunyuanReply);
      if (hunyuanReply && hunyuanReply.length > 50) return hunyuanReply;
    } catch (hunyuanError) {
      console.warn('[AI] 混元流式服务失败，切换 GLM:', hunyuanError && hunyuanError.message);
    }
  }
  if (!GLM_API_KEY) {
    if (getQwenFallbackProvider()) {
      var qwenGeneration = await callTextWithFallback(systemPrompt, messages, 4096);
      var qwenReply = cleanAIOutput(qwenGeneration.text);
      if (qwenReply && qwenReply.length > 50) return qwenReply;
    }
    throw new Error('未配置可用的流式 AI provider');
  }
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

  var prompt = '请为歌曲《' + songName + '》' + (artist ? '（' + artist + '）' : '') + '写一段适合校园公众号的推荐语。要求：\n1）80—120字，开头有画面或情绪钩子，但不夸张、不标题党；\n2）语气自然、有校园共鸣，明确写出适合什么场景聆听；\n3）只能使用已提供的歌名、歌手和歌词片段，不补写歌词，不杜撰发行年份、故事、榜单或歌手经历；\n4）不使用Markdown、标题、编号、引号或“作为AI”等说明，只输出可直接发布的正文。\n\n已确认的歌词片段（仅供理解情绪，不能改写或续写）：\n' + (lyricSnippet || '（未获取到歌词；只根据歌名和歌手写，不要声称了解歌词内容）');

  var messages = [{ role: 'user', content: [{ type: 'text', text: prompt }] }];
  var systemMsg = '你是校园公众号的资深音乐编辑。先核对输入事实，再写一段可直接发布的中文推荐语；文案具体、有节奏、有校园场景，但不过度煽情。严禁编造歌词、发行信息、榜单、歌手经历或输入中没有的事实；只输出正文，不输出分析、标题、编号和歌词列表。';

  try {
    if (!getHunyuanProvider() && !GLM_API_KEY && !getQwenFallbackProvider()) return { intro: '', lyrics: '', prompt: prompt, error: 'AI_API_KEY 未配置' };
    var generation = await callTextWithFallback(systemMsg, messages, 1500);
    var reply = generation.text;
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
      return { intro: intro, lyrics: lyrics || realLyrics || '', prompt: null, provider: generation.provider };
    }
  } catch(e) {
    console.error('[AI] 生成歌曲介绍失败:', e.message);
    var isBusy = e && (e.statusCode === 429 || e.providerCode === '1305');
    var isTimeout = e && (e.code === 'ETIMEDOUT' || /超时/.test(e.message || ''));
    return {
      intro: '',
      lyrics: '',
      prompt: prompt,
      error: isBusy ? 'AI 服务当前繁忙，已自动重试，请稍后再试' : (isTimeout ? 'AI 请求超时，请稍后再试' : 'GLM 服务暂时不可用')
    };
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
      var prompt = '核对歌曲《' + songName + '》' + (artist ? '（' + artist + '）' : '') + '的歌词。只有在来源确实能确认时才逐行输出原文；无法确认或不确定时只回复“暂无歌词”。不得根据记忆补写、改写、拼接或续写歌词，不要输出解释、标题或版权声明。';
      var messages = [{ role: 'user', content: [{ type: 'text', text: prompt }] }];
      var reply = null;
      if (getHunyuanProvider() || GLM_API_KEY || getQwenFallbackProvider()) {
        try {
          var lyricGeneration = await callTextWithFallback('你是歌词核对助手。只输出已确认的歌词原文；不确定就只输出“暂无歌词”，绝不猜测或改写。', messages, 2000);
          reply = lyricGeneration.text;
        } catch(e) {}
      }
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
    var prompt2 = '从下面已经确认的《' + songName + '》歌词中原样选取2—3段适合公众号卡片展示的片段。每行一句，保持字词、标点和顺序完全一致；歌词较短就全部保留。只输出选中的歌词，不加标题、引号、评论，不改写、不拼接、不续写。\n\n' + rawLyrics;
    var messages2 = [{ role: 'user', content: [{ type: 'text', text: prompt2 }] }];
    var reply2 = null;
    if (getHunyuanProvider() || GLM_API_KEY || getQwenFallbackProvider()) {
      try {
        var lyricSelection = await callTextWithFallback('你是歌词排版助手。只输出输入中原样存在的歌词，一字不改；不要解释，不要补写。', messages2, 1500);
        reply2 = lyricSelection.text;
      } catch(e) {}
    }
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
    var prompt = '核对歌曲《' + songName + '》' + (artist ? '（' + artist + '）' : '') + '的歌词。只有在来源确实能确认时才逐行输出原文；无法确认或不确定时只回复“暂无歌词”。不得根据记忆补写、改写、拼接或续写歌词，不要输出解释、标题或版权声明。';
    var messages = [{ role: 'user', content: [{ type: 'text', text: prompt }] }];
    var reply = null;
    if (getHunyuanProvider() || GLM_API_KEY || getQwenFallbackProvider()) {
      try {
        var lyricGeneration = await callTextWithFallback('你是歌词核对助手。只输出已确认的歌词原文；不确定就只输出“暂无歌词”，绝不猜测或改写。', messages, 2000);
        reply = lyricGeneration.text;
      } catch(e) {}
    }
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
