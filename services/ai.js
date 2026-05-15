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

  // 只用 MiniMax-M2.7
  if (MINIMAX_KEY) {
    try {
      var reply = await callMiniMax(systemPrompt, text);
      if (reply) {
        // 过滤掉推理模型输出的 thinking 内容
        reply = reply.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        if (reply) return reply;
      }
    } catch (err) {
      console.warn('[AI] MiniMax失败:', err.message);
    }
  }

  // AI不可用时，用简单规则回复
  return getRuleReply(text);
}



// ===== MiniMax API (OpenAI 兼容格式 - 回退到稳定版本) =====
function callMiniMax(systemPrompt, text) {
  // 只用 M2.7 模型，增加超时时间到 15 秒
  return callMinimaxWithModel(systemPrompt, text, 'MiniMax-M2.7', 15000);
}

function callMinimaxWithModel(systemPrompt, text, modelName, timeoutMs) {
  // 先用 OpenAI 兼容格式尝试（更稳定的 endpoint）
  var body = JSON.stringify({
    model: modelName,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: text }
    ],
    max_tokens: 300,
    temperature: 0.7,
    stream: false
  });

  return new Promise(function(resolve, reject) {
    console.log('[AI] 尝试调用 MiniMax API:', modelName);
    var req = https.request({
      hostname: 'api.minimaxi.com', 
      port: 443, 
      path: '/v1/chat/completions',  // 回退到稳定的 OpenAI 兼容路径
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + MINIMAX_KEY,
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: timeoutMs || 15000
    }, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        console.log('[AI] MiniMax 响应状态码:', res.statusCode);
        if (res.statusCode === 401) return reject(new Error('MiniMax密钥无效'));
        if (res.statusCode === 404) {
          // 如果是 404，尝试另一个可能的路径
          return reject(new Error('API路径404，尝试备用方案'));
        }
        if (res.statusCode !== 200) {
          return reject(new Error(modelName + ' HTTP' + res.statusCode + ': ' + data.substring(0, 100)));
        }
        try {
          var json = JSON.parse(data);
          if (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) {
            console.log('[AI] MiniMax 调用成功');
            return resolve(json.choices[0].message.content.trim());
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
  }).catch(function(err) {
    // 如果主路径失败，记录详细错误但不再尝试备用路径（避免复杂化）
    console.log('[AI] MiniMax 最终失败:', err.message);
    throw err;
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

module.exports = { getAIReply };
