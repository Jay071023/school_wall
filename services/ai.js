const https = require('https');
const { pool } = require('../config/database');

var MINIMAX_KEY = process.env.MINIMAX_API_KEY || '';
var DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || '';

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
function callMiniMax(systemPrompt, messages) {
  return callMinimaxWithModel(systemPrompt, messages, 'MiniMax-M2.7', 15000);
}

function callMinimaxWithModel(systemPrompt, messages, modelName, timeoutMs) {
  var body = JSON.stringify({
    model: modelName,
    system: systemPrompt,
    messages: messages,
    max_tokens: 300,
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

module.exports = { getAIReply, generateChapter, generateChapterStream };
