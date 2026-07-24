const { pool } = require('../config/database');
const aiService = require('./ai');
const flows = require('./wechat-flows');
const mpDraftService = require('./mp-draft');
const T = require('./wechat-persona');

/**
 * 微信消息回复 — 路由层
 * 职责：消息分类、关键字路由、状态机路由、AI 默认回复
 * 所有文案委托 wechat-persona.js 生成
 */

// ===== XML 构建 =====
function buildTextReply(openid, accountId, text) {
  var ts = Math.floor(Date.now() / 1000);
  return '<xml>' +
    '<ToUserName><![CDATA[' + openid + ']]></ToUserName>' +
    '<FromUserName><![CDATA[' + accountId + ']]></FromUserName>' +
    '<CreateTime>' + ts + '</CreateTime>' +
    '<MsgType><![CDATA[text]]></MsgType>' +
    '<Content><![CDATA[' + text + ']]></Content>' +
  '</xml>';
}

function buildNewsReply(openid, accountId, title, description, picUrl, linkUrl) {
  var ts = Math.floor(Date.now() / 1000);
  if (!picUrl) picUrl = 'https://wall.jay23.cn/images/show.png';
  if (!linkUrl) linkUrl = 'https://wall.jay23.cn';
  return '<xml>' +
    '<ToUserName><![CDATA[' + openid + ']]></ToUserName>' +
    '<FromUserName><![CDATA[' + accountId + ']]></FromUserName>' +
    '<CreateTime>' + ts + '</CreateTime>' +
    '<MsgType><![CDATA[news]]></MsgType>' +
    '<ArticleCount>1</ArticleCount>' +
    '<Articles>' +
      '<item>' +
        '<Title><![CDATA[' + title + ']]></Title>' +
        '<Description><![CDATA[' + description + ']]></Description>' +
        '<PicUrl><![CDATA[' + picUrl + ']]></PicUrl>' +
        '<Url><![CDATA[' + linkUrl + ']]></Url>' +
      '</item>' +
    '</Articles>' +
  '</xml>';
}

// ===== 关键字注册表 =====
var KEYWORD_HANDLERS = {
  '投稿': 'startSubmit', '发帖': 'startSubmit', '我要投稿': 'startSubmit', '我想发帖': 'startSubmit', '发布': 'startSubmit',
  '每日推歌': 'startPushSong', '推歌': 'startPushSong', '分享歌曲': 'startPushSong', '每日推': 'startPushSong', '推个歌': 'startPushSong',
  '校园点歌': 'guideRadioSong', '怎么点歌': 'guideRadioSong', '点歌': 'guideRadioSong',
  '帮助': 'helpMenu', 'help': 'helpMenu', '菜单': 'helpMenu', '功能': 'helpMenu',
  '绑定': 'bindGuide', '绑定账号': 'bindGuide',
  '怎么投稿': 'howToSubmit',
  '找回密码': 'resetPassword', '重置密码': 'resetPassword', '忘记密码': 'resetPassword', '改密码': 'resetPassword',
  '天气': 'weather', '今日天气': 'weather', 'weather': 'weather',
};

function matchKeyword(text) {
  return KEYWORD_HANDLERS[text] || null;
}

// ===== 关键字处理器 =====
var handlers = {};

handlers.startSubmit = async function(openid) {
  try {
    var [users] = await pool.execute('SELECT id FROM users WHERE openid = ?', [openid]);
    if (users.length === 0) return { text: T.submitNeedBind() };
    await pool.execute(
      'INSERT INTO wechat_submit_sessions (openid, step, created_at, updated_at) VALUES (?, "awaiting_title", NOW(), NOW()) ON DUPLICATE KEY UPDATE step = "awaiting_title", title = NULL, content = NULL, updated_at = NOW()',
      [openid]
    );
    return { text: T.submitAskTitle() };
  } catch (e) {
    console.error('[reply] startSubmit 失败 openid=' + openid + ' err=' + e.message);
    return { text: T.systemError('startSubmit') };
  }
};

handlers.startPushSong = async function(openid) {
  try {
    await pool.execute(
      'INSERT INTO wechat_song_recs (openid, step, created_at, updated_at) VALUES (?, "song_name", NOW(), NOW()) ON DUPLICATE KEY UPDATE step = "song_name", song_name = NULL, artist = NULL, intro = NULL, display_name = NULL, updated_at = NOW()',
      [openid]
    );
    return { text: T.songStartPush() };
  } catch (e) {
    console.error('[reply] startPushSong 失败 openid=' + openid + ' err=' + e.message);
    return { text: T.systemError('startPushSong') };
  }
};

handlers.guideRadioSong = async function() {
  return { text: T.radioSongGuide() };
};

handlers.helpMenu = async function() {
  return { text: T.help() };
};

handlers.bindGuide = async function() {
  return { text: T.bindGuide() };
};

handlers.howToSubmit = async function() {
  return { text: T.submitNeedBind() };
};

handlers.resetPassword = async function(openid) {
  try {
    var [users] = await pool.execute('SELECT id, username, nickname FROM users WHERE openid = ?', [openid]);
    if (users.length === 0) return { text: T.resetPasswordNotBound() };
    var user = users[0];
    var code = '';
    var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (var i = 0; i < 6; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
    await pool.execute('DELETE FROM password_reset_tokens WHERE user_id = ? AND used = 0', [user.id]);
    await pool.execute(
      'INSERT INTO password_reset_tokens (user_id, token, openid, expires_at) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE))',
      [user.id, code, openid]
    );
    return { text: T.resetPasswordCode(user.nickname || user.username, code) };
  } catch (e) {
    console.error('[reply] resetPassword 失败 openid=' + openid + ' err=' + e.message);
    return { text: T.resetPasswordError() };
  }
};

handlers.weather = async function() {
  try {
    var w = await mpDraftService.getWeather();
    if (w && w.temperature) {
      return { text: T.weather(w.city || '上海', w.temperature, w.weather || '', w.wind || '', w.humidity || '') };
    }
    return { text: T.weatherUnavailable() };
  } catch (e) {
    return { text: T.weatherError() };
  }
};

// ===== 验证码处理 =====
async function handleBindCode(openid, code) {
  try {
    var [bindings] = await pool.execute(
      'SELECT id, user_id FROM wechat_bindings WHERE bind_code = ? AND used = 0 AND created_at >= DATE_SUB(NOW(), INTERVAL 10 MINUTE) LIMIT 1',
      [code]
    );
    if (bindings.length === 0) return { text: T.bindCodeInvalid() };
    var b = bindings[0];
    var [users] = await pool.execute('SELECT id FROM users WHERE openid = ?', [openid]);
    if (users.length > 0 && users[0].id !== b.user_id) return { text: T.bindAlreadyBound() };
    await pool.execute('UPDATE users SET openid = ? WHERE id = ?', [openid, b.user_id]);
    await pool.execute('UPDATE wechat_bindings SET openid = ?, used = 1, bound_at = NOW() WHERE id = ?', [openid, b.id]);
    return { text: T.bindSuccess() };
  } catch (e) {
    console.error('[reply] handleBindCode 失败 openid=' + openid + ' err=' + e.message);
    return { text: T.bindError() };
  }
}

async function handleRegCode(openid, code) {
  try {
    var [codes] = await pool.execute(
      'SELECT id FROM wechat_reg_codes WHERE code = ? AND verified = 0 AND used = 0 AND created_at >= DATE_SUB(NOW(), INTERVAL 10 MINUTE) LIMIT 1',
      [code]
    );
    if (codes.length === 0) return { text: T.regCodeInvalid() };
    var [users] = await pool.execute('SELECT id FROM users WHERE openid = ?', [openid]);
    if (users.length > 0) return { text: T.regAlreadyBound() };
    await pool.execute('UPDATE wechat_reg_codes SET verified = 1, openid = ?, verified_at = NOW() WHERE id = ?', [openid, codes[0].id]);
    return { text: T.regCodeConfirm() };
  } catch (e) {
    console.error('[reply] handleRegCode 失败 openid=' + openid + ' err=' + e.message);
    return { text: T.regError() };
  }
}

// ===== 默认 AI 回复 =====
async function aiReply(text, openid) {
  try {
    return { text: await aiService.getAIReply(text, openid) };
  } catch (e) {
    console.error('[reply] aiReply 失败 openid=' + openid + ' err=' + e.message);
    return { text: T.aiFallback() };
  }
}

// ===== 状态机路由 =====
async function routeStateMachine(openid, text) {
  var result = await flows.handleSubmitFlow(openid, text);
  if (result) {
    if (result.deferred) result = await result.deferred();
    return result;
  }
  result = await flows.handleSongFlow(openid, text);
  return result;
}

// ===== 主入口 =====
async function handleText(openid, accountId, text) {
  text = text.trim();
  if (text.length > 200) return buildTextReply(openid, accountId, T.tooLong());

  // 1. 状态机（投稿/推歌流程）
  var flowResult = await routeStateMachine(openid, text);
  if (flowResult) return buildTextReply(openid, accountId, flowResult.text);

  // 2. 验证码
  if (/^BIND[A-Z0-9]{4}$/i.test(text)) {
    var result = await handleBindCode(openid, text.toUpperCase());
    return buildTextReply(openid, accountId, result.text);
  }
  if (/^REG[A-Z0-9]{6}$/i.test(text)) {
    var result = await handleRegCode(openid, text.toUpperCase());
    return buildTextReply(openid, accountId, result.text);
  }

  // 3. 关键字路由
  var matched = matchKeyword(text);
  if (matched && handlers[matched]) {
    var result = await handlers[matched](openid);
    return buildTextReply(openid, accountId, result.text);
  }

  // 4. 未匹配的流程命令 → 兜底
  if (['确认', '是的', '确定', '跳过', '重写', '重新', '重新开始', '再来', '用润色版', '润色版', '用原文'].includes(text)) {
    return buildTextReply(openid, accountId, T.noActiveFlow());
  }

  // 5. AI
  var aiResult = await aiReply(text, openid);
  return buildTextReply(openid, accountId, aiResult.text);
}

async function handleImage(openid, accountId, mediaId) {
  var result = await flows.handleImageForSubmit(openid, mediaId);
  if (result) return buildTextReply(openid, accountId, result.text);
  return buildTextReply(openid, accountId, T.imageReply());
}

function handleVoice(openid, accountId) {
  return buildTextReply(openid, accountId, T.voiceReply());
}

function handleLocation(openid, accountId) {
  return buildTextReply(openid, accountId, T.locationReply());
}

function handleLink(openid, accountId) {
  return buildTextReply(openid, accountId, T.linkReply());
}

function handleEventSubscribe(openid, accountId, eventKey) {
  var sceneId = eventKey ? eventKey.replace('qrscene_', '') : null;
  return { sceneId, replyText: T.welcome() };
}

function handleEventUnsubscribe(openid) {
  (async function() {
    try {
      var [users] = await pool.execute('SELECT id, username FROM users WHERE openid = ?', [openid]);
      if (users.length > 0) {
        await pool.execute('UPDATE users SET openid = NULL WHERE id = ?', [users[0].id]);
        console.log('[unbind] 已清除用户 ' + users[0].username + '(ID:' + users[0].id + ') 的微信绑定');
      }
      await pool.execute('DELETE FROM wechat_pending_follows WHERE openid = ?', [openid]);
    } catch (e) {
      console.error('[unbind] 处理取消关注失败 openid=' + openid + ' err=' + e.message);
    }
  })();
}

module.exports = {
  buildTextReply, buildNewsReply,
  handleText, handleImage, handleVoice, handleLocation, handleLink,
  handleEventSubscribe, handleEventUnsubscribe,
};
