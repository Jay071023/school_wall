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
  console.log('[歌词-网易云] 搜索:', keyword);

  try {
    var searchUrl = 'https://music.163.com/api/search/get?s=' + encodeURIComponent(keyword) + '&type=1&limit=10';
    var searchRes = await httpGet(searchUrl, { 'Referer': 'https://music.163.com/' });
    var searchData = JSON.parse(searchRes);

    if (!searchData.result || !searchData.result.songs || searchData.result.songs.length === 0) {
      console.log('[歌词-网易云] 搜索无结果');
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

    console.log('[歌词-网易云] 匹配:', bestMatch.name, '|', (bestMatch.artists || []).map(function(a) { return a.name; }).join('/'));

    var lyricUrl = 'https://music.163.com/api/song/lyric?id=' + bestMatch.id + '&lv=1';
    var lyricRes = await httpGet(lyricUrl, { 'Referer': 'https://music.163.com/' });
    var lyricData = JSON.parse(lyricRes);

    if (lyricData.lrc && lyricData.lrc.lyric) {
      var lyrics = lyricData.lrc.lyric;
      lyrics = lyrics.replace(/\[\d{2}:\d{2}\.\d{2,3}\]/g, '').trim();
      lyrics = lyrics.split('\n').filter(function(l) { return l.trim(); }).join('\n');
      console.log('[歌词-网易云] 成功，长度:', lyrics.length);
      return lyrics;
    }
  } catch(e) {
    console.warn('[歌词-网易云] 失败:', e.message);
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
  console.log('[歌词-QQ] 搜索:', keyword);

  try {
    // 1. 搜索
    var searchUrl = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=' + encodeURIComponent(keyword) + '&format=json&n=10&p=1';
    var searchRes = await httpGet(searchUrl, { 'Referer': 'https://y.qq.com/' });
    var searchData = JSON.parse(searchRes);

    if (!searchData.data || !searchData.data.song || !searchData.data.song.list || searchData.data.song.list.length === 0) {
      console.log('[歌词-QQ] 搜索无结果');
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

    console.log('[歌词-QQ] 匹配:', bestMatch.songname, '|', bestMatch.singer && bestMatch.singer[0] ? bestMatch.singer[0].name : '');

    // 3. 获取歌词
    var mid = bestMatch.songmid;
    var lyricUrl = 'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=' + mid + '&format=json&nobase64=1';
    var lyricRes = await httpGet(lyricUrl, { 'Referer': 'https://y.qq.com/', 'Cookie': '' });
    var lyricData = JSON.parse(lyricRes);

    if (lyricData.lyric) {
      var lyrics = lyricData.lyric;
      lyrics = lyrics.replace(/\[\d{2}:\d{2}\.\d{2,3}\]/g, '').trim();
      lyrics = lyrics.split('\n').filter(function(l) { return l.trim(); }).join('\n');
      console.log('[歌词-QQ] 成功，长度:', lyrics.length);
      return lyrics;
    }
  } catch(e) {
    console.warn('[歌词-QQ] 失败:', e.message);
  }
  return '';
}

var MINIMAX_KEY = process.env.MINIMAX_API_KEY || '';
var DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || '';

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
    console.warn('[AI] 历史失败:', err.message);
    return [];
  }
}

async function saveHistory(openid, userText, aiReply) {
  try {
    await pool.execute('INSERT INTO ai_conversations (openid, role, content) VALUES (?, "user", ?)', [openid, userText]);
    await pool.execute('INSERT INTO ai_conversations (openid, role, content) VALUES (?, "assistant", ?)', [openid, aiReply]);
  } catch (err) {
    console.warn('[AI] 保存失败:', err.message);
  }
}

async function getAIReply(text, openid) {
  var systemPrompt = '你是校园墙助手"墙墙"，一个温柔可爱的学姐。回复要自然亲切，像朋友聊天一样，不要太机械。可以适当使用emoji表情，语气轻松活泼。当用户想聊天时，多问一些开放性问题引导对话；当用户想发帖或点歌时，引导他们去 https://wall.jay23.cn 操作。回复长度适中，不要太短也不要太长，控制在100字以内。';

  // 获取历史记录，提供上下文
  var history = [];
  if (openid) {
    history = await getHistory(openid);
  }
  var messages = history.concat([{ role: 'user', content: [{ type: 'text', text: text }] }]);

  // 先试 MiniMax
  if (MINIMAX_KEY) {
    try {
      var reply = await callMiniMax(systemPrompt, messages);
      if (reply) {
        reply = reply.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        if (reply) {
          if (openid) await saveHistory(openid, text, reply);
          return reply;
        }
      }
    } catch (err) {
      console.warn('[AI] MiniMax失败:', err.message);
    }
  }

  // MiniMax 不可用时，尝试 DeepSeek
  if (DEEPSEEK_KEY) {
    try {
      var reply = await callDeepSeek(systemPrompt, messages);
      if (reply) {
        reply = reply.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        if (reply) {
          if (openid) await saveHistory(openid, text, reply);
          return reply;
        }
      }
    } catch (err) {
      console.warn('[AI] DeepSeek失败:', err.message);
    }
  }

  // 都不可用时，用简单规则回复
  return getRuleReply(text);
}



// ===== MiniMax API (Anthropic 兼容格式) =====
function callMiniMax(systemPrompt, messages, maxTokens) {
  return callMinimaxWithModel(systemPrompt, messages, 'MiniMax-M2.7', 15000, maxTokens);
}

function callMinimaxWithModel(systemPrompt, messages, modelName, timeoutMs, maxTokens) {
  var body = JSON.stringify({
    model: modelName,
    system: systemPrompt,
    messages: messages,
    max_tokens: maxTokens || 300,
    temperature: 0.7,
    stream: false
  });

  return new Promise(function(resolve, reject) {
    console.log('[AI] 尝试调用 MiniMax API (Anthropic):', modelName);
    var req = https.request({
      hostname: 'api.minimaxi.com', 
      port: 443, 
      path: '/anthropic/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': MINIMAX_KEY,
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: timeoutMs || 15000
    }, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        console.log('[AI] MiniMax 响应状态码:', res.statusCode);
        if (res.statusCode === 401) return reject(new Error('MiniMax密钥无效'));
        if (res.statusCode !== 200) {
          return reject(new Error(modelName + ' HTTP' + res.statusCode + ': ' + data.substring(0, 100)));
        }
        try {
          var json = JSON.parse(data);
          if (json.content && Array.isArray(json.content)) {
            var textBlock = json.content.find(function(c) { return c.type === 'text' && c.text; });
            if (textBlock) {
              console.log('[AI] MiniMax 调用成功');
              return resolve(textBlock.text.trim());
            }
          }
          reject(new Error(modelName + ' 响应格式异常: ' + JSON.stringify(json).substring(0, 200)));
        } catch (e) { 
          reject(new Error('JSON解析失败: ' + e.message)); 
        }
      });
    });
    req.on('error', function(err) {
      console.log('[AI] MiniMax 网络错误:', err.message);
      reject(err);
    });
    req.on('timeout', function() { 
      req.destroy(); 
      console.log('[AI] MiniMax 请求超时');
      reject(new Error(modelName + '超时(' + (timeoutMs/1000) + '秒)')); 
    });
    req.write(body);
    req.end();
  });
}

// ===== DeepSeek API =====
function callDeepSeek(systemPrompt, messages) {
  // DeepSeek 使用 OpenAI 格式，content 为字符串
  var dsMessages = [{ role: 'system', content: systemPrompt }];
  for (var i = 0; i < messages.length; i++) {
    var m = messages[i];
    var content = '';
    if (typeof m.content === 'string') {
      content = m.content;
    } else if (Array.isArray(m.content)) {
      var textBlock = m.content.find(function(c) { return c.type === 'text' && c.text; });
      content = textBlock ? textBlock.text : '';
    }
    dsMessages.push({ role: m.role, content: content });
  }
  var body = JSON.stringify({
    model: 'deepseek-chat',
    messages: dsMessages,
    max_tokens: 300,
    temperature: 0.7,
    stream: false
  });

  return new Promise(function(resolve, reject) {
    console.log('[AI] 尝试调用 DeepSeek API');
    var req = https.request({
      hostname: 'api.deepseek.com',
      port: 443,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + DEEPSEEK_KEY,
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 15000
    }, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        console.log('[AI] DeepSeek 响应状态码:', res.statusCode);
        if (res.statusCode === 401) return reject(new Error('DeepSeek密钥无效'));
        if (res.statusCode !== 200) {
          return reject(new Error('DeepSeek HTTP' + res.statusCode + ': ' + data.substring(0, 100)));
        }
        try {
          var json = JSON.parse(data);
          if (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) {
            console.log('[AI] DeepSeek 调用成功');
            return resolve(json.choices[0].message.content.trim());
          }
          reject(new Error('DeepSeek 响应格式异常: ' + JSON.stringify(json).substring(0, 200)));
        } catch (e) {
          reject(new Error('JSON解析失败: ' + e.message));
        }
      });
    });
    req.on('error', function(err) {
      console.log('[AI] DeepSeek 网络错误:', err.message);
      reject(err);
    });
    req.on('timeout', function() {
      req.destroy();
      console.log('[AI] DeepSeek 请求超时');
      reject(new Error('DeepSeek超时(15秒)'));
    });
    req.write(body);
    req.end();
  });
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
    return '🌤️ 天气信息暂时查不到，你可以直接去 https://wall.jay23.cn 看看首页的天气卡片哦~';
  }
  // 投稿
  if (/投稿|发帖|发布/i.test(t)) {
    return '📝 想投稿？很简单！\n\n打开 https://wall.jay23.cn → 点击"发布"→ 写内容提交就行~\n审核通过后就能在墙上看到啦！';
  }
  // 点歌
  if (/点歌|歌曲|音乐/i.test(t)) {
    return '🎵 想点歌？\n\n打开 https://wall.jay23.cn → 进入"点歌"页面 → 选时段和歌曲 → 提交~\n校广播站会定时播放哦！';
  }
  // 绑定
  if (/绑定|微信/i.test(t)) {
    return '🔗 微信绑定教程\n\n打开 https://wall.jay23.cn → 登录 → 个人中心 → 绑定微信 → 扫码即可~\n绑定后能收到评论和点赞通知哦~';
  }
  // 学校
  if (/学校|嘉定|二中/i.test(t)) {
    return '🏫 上海市嘉定区第二中学\n📍 德华路388号\n🌐 校园墙：https://wall.jay23.cn';
  }
  // 夸夸
  if (/真棒|厉害|大佬|牛逼/i.test(t)) {
    return '😄 谢谢夸奖！有什么需要帮忙的尽管说~';
  }
  // 无聊
  if (/无聊|好无聊|闲/i.test(t)) {
    return '😊 无聊的话可以去校园墙逛逛~ https://wall.jay23.cn\n看看大家在聊什么，或者发个帖找人聊天也行！';
  }

  // 兜底
  return '💬 回复"帮助"查看我能做什么吧~\n🌐 https://wall.jay23.cn';
}

// ===== AI 生成小说章节 =====
async function generateChapter(prompt) {
  if (!MINIMAX_KEY) {
    throw new Error('MINIMAX_API_KEY 未配置');
  }

  var systemPrompt = '你是一位校园青春小说作家，擅长描写青春期细腻的情感变化，文字清新自然，有画面感。';

  var body = JSON.stringify({
    model: 'MiniMax-M2.7',
    system: systemPrompt,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 4096,
    temperature: 0.8,
    stream: false
  });

  return new Promise(function(resolve, reject) {
    console.log('[AI] 开始生成小说章节...');
    var aborted = false;
    var timer = setTimeout(function() {
      aborted = true;
      req.destroy();
      reject(new Error('生成超时(45秒)'));
    }, 45000);

    var req = https.request({
      hostname: 'api.minimaxi.com',
      port: 443,
      path: '/anthropic/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': MINIMAX_KEY,
        'Content-Length': Buffer.byteLength(body)
      }
    }, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        if (aborted) return;
        clearTimeout(timer);
        if (res.statusCode === 401) return reject(new Error('MiniMax密钥无效'));
        if (res.statusCode !== 200) return reject(new Error('HTTP' + res.statusCode + ': ' + data.substring(0, 200)));
        try {
          var json = JSON.parse(data);
          if (json.content && Array.isArray(json.content)) {
            var textBlock = json.content.find(function(c) { return c.type === 'text' && c.text; });
            if (textBlock) {
              var content = textBlock.text.trim();
              content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
              console.log('[AI] 章节生成成功，长度:', content.length);
              return resolve(content);
            }
          }
          reject(new Error('响应格式异常: ' + JSON.stringify(json).substring(0, 200)));
        } catch (e) { reject(new Error('JSON解析失败: ' + e.message)); }
      });
    });

    req.on('error', function(err) {
      if (aborted) return;
      clearTimeout(timer);
      reject(err);
    });
    req.write(body);
    req.end();
  });
}

// ===== AI 流式生成小说章节 =====
// onToken: callback(text) called for each token chunk
// returns Promise<fullText>
async function generateChapterStream(prompt, onToken) {
  if (!MINIMAX_KEY) {
    throw new Error('MINIMAX_API_KEY 未配置');
  }

  var systemPrompt = '你是一位校园青春小说作家，擅长描写青春期细腻的情感变化，文字清新自然，有画面感。';

  var body = JSON.stringify({
    model: 'MiniMax-M2.7',
    system: systemPrompt,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 4096,
    temperature: 0.8,
    stream: true
  });

  return new Promise(function(resolve, reject) {
    console.log('[AI] 开始流式生成小说章节...');
    var fullText = '';
    var aborted = false;
    var timer = setTimeout(function() {
      aborted = true;
      req.destroy();
      reject(new Error('生成超时(60秒)'));
    }, 60000);

    var req = https.request({
      hostname: 'api.minimaxi.com',
      port: 443,
      path: '/anthropic/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': MINIMAX_KEY,
        'Content-Length': Buffer.byteLength(body)
      }
    }, function(res) {
      if (res.statusCode !== 200) {
        var errData = '';
        res.on('data', function(chunk) { errData += chunk; });
        res.on('end', function() {
          clearTimeout(timer);
          if (res.statusCode === 401) return reject(new Error('MiniMax密钥无效'));
          reject(new Error('HTTP' + res.statusCode + ': ' + errData.substring(0, 200)));
        });
        return;
      }

      var buffer = '';
      var currentEvent = '';

      res.on('data', function(chunk) {
        if (aborted) return;
        buffer += chunk.toString();
        var lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          if (line.startsWith('event: ')) {
            currentEvent = line.substring(7).trim();
          } else if (line.startsWith('data: ')) {
            var dataStr = line.substring(6).trim();
            if (currentEvent === 'content_block_delta' && dataStr) {
              try {
                var data = JSON.parse(dataStr);
                if (data.delta && data.delta.type === 'text_delta' && data.delta.text) {
                  var token = data.delta.text;
                  fullText += token;
                  if (onToken) onToken(token);
                }
              } catch (e) {}
            } else if (currentEvent === 'message_stop') {
              // stream done
            }
          }
        }
      });

      res.on('end', function() {
        if (aborted) return;
        clearTimeout(timer);
        fullText = fullText.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        console.log('[AI] 流式生成完成，长度:', fullText.length);
        resolve(fullText);
      });
    });

    req.on('error', function(err) {
      if (aborted) return;
      clearTimeout(timer);
      reject(err);
    });
    req.write(body);
    req.end();
  });
}

// 生成歌曲介绍
async function generateSongIntro(songName, artist) {
  // 先抓真实歌词
  var realLyrics = '';
  try {
    realLyrics = await fetchNeteaseLyrics(songName, artist);
    if (!realLyrics) realLyrics = await fetchQQLyrics(songName, artist);
  } catch(e) {}

  var lyricsSection = realLyrics ? '\n\n以下是这首歌的歌词，请基于歌词内容来写推荐语：\n' + realLyrics.substring(0, 2000) : '';

  // 把歌词截取关键段落
  var lyricSnippet = '';
  if (realLyrics) {
    var lines = realLyrics.split('\n').filter(function(l) { return l.trim().length > 2; });
    lyricSnippet = lines.slice(0, 20).join('\n');
  }

  var prompt = '歌曲《' + songName + '》的歌词：\n\n' + (lyricSnippet || '（无歌词）') + '\n\n请根据歌词写一段150字左右的推荐文案。要求：\n1. 自然融入1-2句歌词（不加引号，像聊天随口提到）\n2. 不要编造歌词，不要用Markdown\n3. 只输出最终文案，不要标题、不要编号、不要分析过程\n4. 直接开始写文案内容';

  var messages = [{ role: 'user', content: [{ type: 'text', text: prompt }] }];
  var systemMsg = '你是校园公众号编辑，只写推荐文案。绝对不要输出分析、推理、思考过程、步骤说明或歌词原文列表。只输出一段流畅的推荐文字。';

  try {
    var reply = null;
    if (MINIMAX_KEY) {
      try {
        reply = await callMiniMax(systemMsg, messages, 1500);
        console.log('[AI] MiniMax生成歌曲介绍成功:', reply ? reply.substring(0, 50) : '空');
      } catch(e) {
        console.warn('[AI] MiniMax生成歌曲介绍失败:', e.message);
      }
    }
    if (!reply && DEEPSEEK_KEY) {
      try {
        reply = await callDeepSeek(systemMsg, messages);
        console.log('[AI] DeepSeek生成歌曲介绍成功:', reply ? reply.substring(0, 50) : '空');
      } catch(e) {
        console.warn('[AI] DeepSeek生成歌曲介绍失败:', e.message);
      }
    }
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
  }
  // 都失败时返回提示词，让管理员手动去生成
  return { intro: '', lyrics: '', prompt: prompt };
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
  console.log('[歌曲信息] 搜索关键词:', keyword, '| 原始歌手:', artist || '');

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
        console.log('[歌曲信息] 匹配:', best.name, '|', (best.artists||[]).map(function(a){return a.name}).join('/'), '|', albumName, year, duration);

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
  } catch(e) { console.warn('[歌曲信息] 网易云失败:', e.message); }

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
        console.log('[歌曲信息] QQ:', best.songname, '|', albumName);
        return { album: albumName, year: '-', duration: dur };
      }
    }
  } catch(e) { console.warn('[歌曲信息] QQ失败:', e.message); }

  return null;
}

// 搜索歌曲歌词（网易云+QQ+AI三源）
async function searchSongLyrics(songName, artist) {
  console.log('[歌词] 搜索:', songName, artist || '');

  // 方法1：网易云
  var rawLyrics = '';
  try {
    rawLyrics = await fetchNeteaseLyrics(songName, artist);
    if (rawLyrics && rawLyrics.length > 10) { console.log('[歌词] 网易云成功'); }
    else { rawLyrics = ''; }
  } catch(e) { console.warn('[歌词] 网易云失败:', e.message); }

  // 方法2：QQ音乐
  if (!rawLyrics) {
    try {
      rawLyrics = await fetchQQLyrics(songName, artist);
      if (rawLyrics && rawLyrics.length > 10) { console.log('[歌词] QQ成功'); }
      else { rawLyrics = ''; }
    } catch(e) { console.warn('[歌词] QQ失败:', e.message); }
  }

  // 方法3：AI兜底
  if (!rawLyrics) {
    console.log('[歌词] 双源无结果，用AI');
    try {
      var prompt = '请输出歌曲《' + songName + '》' + (artist ? '(' + artist + ')' : '') + '的歌词。只输出歌词原文，每行一句。';
      var messages = [{ role: 'user', content: [{ type: 'text', text: prompt }] }];
      var reply = null;
      if (MINIMAX_KEY) { try { reply = await callMiniMax('只输出歌词原文', messages, 2000); } catch(e) {} }
      if (!reply && DEEPSEEK_KEY) { try { reply = await callDeepSeek('只输出歌词原文', messages); } catch(e) {} }
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
  console.log('[歌词] 用AI精选排版...');
  try {
    var prompt2 = '以下是歌曲《' + songName + '》的完整歌词：\n\n' + rawLyrics + '\n\n请从上面的歌词中精选2-3段最经典的歌词。\n\n要求：\n1. 只输出歌词原文，一字不改\n2. 每行一句歌词\n3. 不要加标题、引号、括号说明、场景描述、评论\n4. 不要输出"适合场景"、"推荐理由"等附加内容\n5. 如果歌词太短就全部输出';
    var messages2 = [{ role: 'user', content: [{ type: 'text', text: prompt2 }] }];
    var reply2 = null;
    if (MINIMAX_KEY) { try { reply2 = await callMiniMax('只输出歌词原文', messages2, 1500); } catch(e) {} }
    if (!reply2 && DEEPSEEK_KEY) { try { reply2 = await callDeepSeek('只输出歌词原文', messages2); } catch(e) {} }
    if (reply2) {
      reply2 = reply2.replace(/<[^>]*think[^>]*>/g, '').trim();
      reply2 = reply2.replace(/^["'"「「]|["'"」」]$/gm, '');
      reply2 = reply2.replace(/^#{1,3}\s+/gm, '');
      reply2 = reply2.replace(/\*\*/g, '');
      reply2 = reply2.replace(/^>\s*/gm, '');
      reply2 = reply2.replace(/【[^】]*】/g, '');
      if (reply2.length > 20) { console.log('[歌词] AI排版完成'); return reply2; }
    }
    console.log('[歌词] AI排版失败，返回原版');
    return rawLyrics;
  } catch(e) { return rawLyrics; }
}

// AI生成歌词（兜底）
async function aiGenerateLyrics(songName, artist) {
  try {
    var prompt = '请输出歌曲《' + songName + '》' + (artist ? '(' + artist + ')' : '') + '的歌词。只输出歌词原文，每行一句。';
    var messages = [{ role: 'user', content: [{ type: 'text', text: prompt }] }];
    var reply = null;
    if (MINIMAX_KEY) { try { reply = await callMiniMax('只输出歌词原文', messages, 2000); } catch(e) {} }
    if (!reply && DEEPSEEK_KEY) { try { reply = await callDeepSeek('只输出歌词原文', messages); } catch(e) {} }
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

module.exports = { getAIReply, generateChapter, generateChapterStream, generateSongIntro, searchSongInfo, searchSongLyrics };
