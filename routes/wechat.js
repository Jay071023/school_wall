/**
 * 微信消息服务器 - 处理公众号关注/扫码事件
 * 薄路由层：解析 XML → 校验签名 → 解密 → 委托 reply service → 加密返回
 */
const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { pool } = require('../config/database');
const replyService = require('../services/wechat-reply');

const router = express.Router();

const WECHAT_TOKEN = process.env.WECHAT_TOKEN || 'wall_jay23';
const WECHAT_ENCODING_AES_KEY = process.env.WECHAT_ENCODING_AES_KEY || '';
const WECHAT_APPID = process.env.WECHAT_APPID || 'wx513226ad98127a0d';

// 重复请求防抖锁（3秒）
var processingLock = new Map();

// ===== AES 加解密 =====
function decryptMessage(encryptMsg, encodingAESKey) {
  try {
    var keyBuffer = Buffer.from(encodingAESKey + '=', 'base64');
    var encryptedBuffer = Buffer.from(encryptMsg, 'base64');
    var iv = keyBuffer.slice(0, 16);
    var decipher = crypto.createDecipheriv('aes-256-cbc', keyBuffer, iv);
    var decrypted = Buffer.concat([decipher.update(encryptedBuffer), decipher.final()]);
    var content = decrypted.toString('utf8');
    var xmlLen = parseInt(content.substring(16, 20));
    return content.substring(20, 20 + xmlLen);
  } catch (err) {
    console.error('[WeChat] 消息解密失败:', err.message);
    throw err;
  }
}

function encryptMessage(xmlContent, appId, encodingAESKey) {
  try {
    var randomStr = Math.random().toString(36).substring(2, 18);
    var content = randomStr + String(xmlContent.length).padStart(16, '0') + xmlContent + appId;
    var keyBuffer = Buffer.from(encodingAESKey + '=', 'base64');
    var iv = keyBuffer.slice(0, 16);
    var cipher = crypto.createCipheriv('aes-256-cbc', keyBuffer, iv);
    var encrypted = Buffer.concat([cipher.update(Buffer.from(content, 'utf8')), cipher.final()]);
    return encrypted.toString('base64');
  } catch (err) {
    console.error('[WeChat] 消息加密失败:', err.message);
    throw err;
  }
}

// ===== XML 解析辅助 =====
function extractXML(xml, tag) {
  var match = xml.match(new RegExp('<' + tag + '><!\\[CDATA\\[(.*?)\\]\\]><\\/' + tag + '>'));
  return match ? match[1] : '';
}

// ===== 微信服务器验证（GET）=====
router.get('/callback', (req, res) => {
  var signature = req.query.signature;
  var timestamp = req.query.timestamp;
  var nonce = req.query.nonce;
  var echostr = req.query.echostr;
  var msgSignature = req.query.msg_signature;

  if (msgSignature) {
    var arr = [WECHAT_TOKEN, timestamp, nonce, echostr].sort();
    var sha1 = crypto.createHash('sha1').update(arr.join('')).digest('hex');
    if (sha1 !== msgSignature) return res.status(200).send('signature verify fail');
    try {
      res.status(200).send(decryptMessage(echostr, WECHAT_ENCODING_AES_KEY));
    } catch (err) {
      res.status(200).send('decrypt fail');
    }
  } else {
    var arr = [WECHAT_TOKEN, timestamp, nonce].sort();
    var sha1 = crypto.createHash('sha1').update(arr.join('')).digest('hex');
    res.status(200).send(sha1 === signature ? echostr : 'signature error');
  }
});

// ===== 接收微信消息和事件（POST）=====
router.post('/callback', async (req, res) => {
  var signature = req.query.signature;
  var timestamp = req.query.timestamp;
  var nonce = req.query.nonce;
  var msgSignature = req.query.msg_signature;

  // 验证签名
  var arr = [WECHAT_TOKEN, timestamp, nonce].sort();
  var sha1 = crypto.createHash('sha1').update(arr.join('')).digest('hex');
  if (sha1 !== signature) return res.send('signature error');

  // 收集请求 body
  var body = '';
  req.on('data', function(chunk) { body += chunk; });
  req.on('end', async function() {
    try {
      var xmlContent = body;

      // 解密（如果启用加密模式）
      if (msgSignature) {
        var encryptMatch = body.match(/<Encrypt><!\[CDATA\[(.*?)\]\]><\/Encrypt>/);
        if (!encryptMatch) return res.send('');
        var encryptMsg = encryptMatch[1];
        var verifyArr = [WECHAT_TOKEN, timestamp, nonce, encryptMsg].sort();
        var verifySha1 = crypto.createHash('sha1').update(verifyArr.join('')).digest('hex');
        if (verifySha1 !== msgSignature) return res.send('');
        xmlContent = decryptMessage(encryptMsg, WECHAT_ENCODING_AES_KEY);
      }

      // 提取基本信息
      var openid = extractXML(xmlContent, 'FromUserName');
      var accountId = extractXML(xmlContent, 'ToUserName');
      var event = extractXML(xmlContent, 'Event');
      var eventKey = extractXML(xmlContent, 'EventKey');
      var msgType = extractXML(xmlContent, 'MsgType');
      var msgContent = extractXML(xmlContent, 'Content');
      var mediaId = extractXML(xmlContent, 'MediaId');

      if (!openid) return res.send('');

      var replyXml = '';

      // ===== 事件处理 =====
      if (event) {
        if (event === 'subscribe') {
          var result = replyService.handleEventSubscribe(openid, accountId, eventKey);
          // 扫码关注：绑定账号
          if (result.sceneId) {
            try {
              var [bindings] = await pool.execute(
                'SELECT user_id FROM wechat_bindings WHERE scene_id = ? AND used = 0 LIMIT 1',
                [result.sceneId]
              );
              if (bindings.length > 0) {
                await pool.execute('UPDATE wechat_bindings SET openid = ?, used = 1, bound_at = NOW() WHERE scene_id = ?', [openid, result.sceneId]);
                await pool.execute('UPDATE users SET openid = ? WHERE id = ?', [openid, bindings[0].user_id]);
              }
            } catch(e) { console.error('[WeChat] 扫码关注绑定失败:', e.message); }
          }
          // 记录待绑定 + 清理旧记录
          try {
            await pool.execute('INSERT INTO wechat_pending_follows (openid, created_at) VALUES (?, NOW())', [openid]);
            await pool.execute('DELETE FROM wechat_pending_follows WHERE created_at < DATE_SUB(NOW(), INTERVAL 5 MINUTE)');
          } catch(e) {}
          replyXml = replyService.buildTextReply(openid, accountId, result.replyText);
        } else if (event === 'unsubscribe') {
          replyService.handleEventUnsubscribe(openid);
          replyXml = '';
        } else if (event === 'SCAN') {
          var sceneId = eventKey;
          try {
            var [bindings] = await pool.execute(
              'SELECT user_id FROM wechat_bindings WHERE scene_id = ? AND used = 0 LIMIT 1',
              [sceneId]
            );
            if (bindings.length > 0) {
              await pool.execute('UPDATE wechat_bindings SET openid = ?, used = 1, bound_at = NOW() WHERE scene_id = ?', [openid, sceneId]);
              await pool.execute('UPDATE users SET openid = ? WHERE id = ?', [openid, bindings[0].user_id]);
            }
          } catch(e) {}
        }
        return res.send(replyXml);
      }

      // ===== 文本消息 =====
      if (msgType === 'text' && msgContent) {
        console.log('[WeChat] 文本消息, openid:', openid.substring(0, 10), '内容:', msgContent.substring(0, 40));
        var requestKey = openid + '_' + msgContent;
        if (processingLock.has(requestKey)) return res.send('');
        processingLock.set(requestKey, Date.now());
        setTimeout(function() { processingLock.delete(requestKey); }, 3000);
        replyXml = await replyService.handleText(openid, accountId, msgContent);
        return res.send(replyXml);
      }

      // ===== 图片消息 =====
      if (msgType === 'image') {
        replyXml = await replyService.handleImage(openid, accountId, mediaId);
        return res.send(replyXml);
      }

      // ===== 其他消息类型 =====
      if (msgType === 'voice') {
        replyXml = replyService.handleVoice(openid, accountId);
      } else if (msgType === 'location') {
        replyXml = replyService.handleLocation(openid, accountId);
      } else if (msgType === 'link') {
        replyXml = replyService.handleLink(openid, accountId);
      }

      res.send(replyXml || '');
    } catch (err) {
      console.error('[WeChat] 处理消息失败:', err.message);
      res.send('');
    }
  });
});

// ===== REST API（绑定/状态/解绑） =====
router.get('/status', async (req, res) => {
  try {
    var token = req.headers.authorization?.split(' ')[1] || req.cookies?.token;
    if (!token) return res.json({ code: 401, message: '未登录' });
    var decoded = jwt.verify(token, process.env.JWT_SECRET || require('../config/jwt-secret'));
    var [users] = await pool.execute('SELECT openid FROM users WHERE id = ?', [decoded.id]);
    res.json({ code: 200, data: { bound: !!users[0]?.openid } });
  } catch (err) {
    res.json({ code: 401, message: '登录已过期' });
  }
});

router.post('/generate-bind', async (req, res) => {
  try {
    var token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.json({ code: 401, message: '未登录' });
    var decoded = jwt.verify(token, process.env.JWT_SECRET || require('../config/jwt-secret'));
    var userId = decoded.id;
    var [users] = await pool.execute('SELECT openid FROM users WHERE id = ?', [userId]);
    if (users[0]?.openid) return res.json({ code: 200, message: '已绑定', data: { bound: true } });

    var bindCode = 'BIND' + Math.random().toString(36).substring(2, 6).toUpperCase();
    var sceneId = 'bind_' + userId + '_' + Date.now();
    await pool.execute(
      'INSERT INTO wechat_bindings (user_id, scene_id, bind_code, created_at) VALUES (?, ?, ?, NOW())',
      [userId, sceneId, bindCode]
    );
    var wechatService = require('../services/wechat');
    res.json({ code: 200, data: { qrCodeUrl: wechatService.generateQRCode(), sceneId: sceneId, bindCode: bindCode } });
  } catch (err) {
    console.error('[WeChat] 生成绑定验证码失败:', err.message);
    res.json({ code: 500, message: '生成失败' });
  }
});

router.post('/unbind', async (req, res) => {
  try {
    var token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.json({ code: 401, message: '未登录' });
    var decoded = jwt.verify(token, process.env.JWT_SECRET || require('../config/jwt-secret'));
    await pool.execute('UPDATE users SET openid = NULL WHERE id = ?', [decoded.id]);
    res.json({ code: 200, message: '已解绑' });
  } catch (err) {
    res.json({ code: 500, message: '解绑失败' });
  }
});

router.post('/verify-follow', async (req, res) => {
  try {
    var token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.json({ code: 401, message: '未登录' });
    var decoded = jwt.verify(token, process.env.JWT_SECRET || require('../config/jwt-secret'));
    var [users] = await pool.execute('SELECT openid FROM users WHERE id = ?', [decoded.id]);
    res.json({ code: 200, message: users[0]?.openid ? '已绑定' : '未绑定', bound: !!users[0]?.openid });
  } catch (err) {
    res.json({ code: 500, message: '查询失败' });
  }
});

module.exports = router;
