/**
 * 微信消息服务器 - 处理公众号关注/扫码事件
 * 需要在公众号管理后台 → 设置 → 服务器配置 中配置此URL
 */
const express = require('express');
const crypto = require('crypto');
const { pool } = require('../config/database');
const mpDraftService = require('../services/mp-draft');
const aiService = require('../services/ai');
const router = express.Router();

const WECHAT_TOKEN = process.env.WECHAT_TOKEN || 'wall_jay23';
const WECHAT_ENCODING_AES_KEY = process.env.WECHAT_ENCODING_AES_KEY || ''; // 请配置 EncodingAESKey
const WECHAT_APPID = process.env.WECHAT_APPID || 'wx513226ad98127a0d';

// 防止重复请求的简单锁机制
var processingRequests = new Map();

// AES 解密辅助函数
function decryptMessage(encryptMsg, encodingAESKey) {
  try {
    // Base64 解码
    const keyBuffer = Buffer.from(encodingAESKey + '=', 'base64');
    const encryptedBuffer = Buffer.from(encryptMsg, 'base64');
    
    // 使用 AES-256-CBC 解密
    const iv = keyBuffer.slice(0, 16);
    const decipher = crypto.createDecipheriv('aes-256-cbc', keyBuffer, iv);
    let decrypted = decipher.update(encryptedBuffer);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    
    // 去除填充和内容长度
    const content = decrypted.toString('utf8');
    const xmlLen = parseInt(content.substring(16, 20));
    const xmlContent = content.substring(20, 20 + xmlLen);
    const appId = content.substring(20 + xmlLen);
    
    return xmlContent;
  } catch (err) {
    console.error('[WeChat] 消息解密失败:', err.message);
    throw err;
  }
}

// AES 加密辅助函数
function encryptMessage(xmlContent, appId, encodingAESKey) {
  try {
    // 生成随机字符串
    const randomStr = Math.random().toString(36).substring(2, 18);
    
    // 拼接内容：随机串 + 消息长度 + 消息内容 + appId
    const content = randomStr + 
                   String(xmlContent.length).padStart(16, '0') + 
                   xmlContent + 
                   appId;
    
    // 使用 AES-256-CBC 加密
    const keyBuffer = Buffer.from(encodingAESKey + '=', 'base64');
    const iv = keyBuffer.slice(0, 16);
    const cipher = crypto.createCipheriv('aes-256-cbc', keyBuffer, iv);
    let encrypted = cipher.update(Buffer.from(content, 'utf8'));
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    
    // Base64 编码
    return encrypted.toString('base64');
  } catch (err) {
    console.error('[WeChat] 消息加密失败:', err.message);
    throw err;
  }
}

// 微信服务器验证（GET请求）
router.get('/callback', (req, res) => {
  var signature = req.query.signature;
  var timestamp = req.query.timestamp;
  var nonce = req.query.nonce;
  var echostr = req.query.echostr;
  var msgSignature = req.query.msg_signature;

  // 如果启用了消息加解密，需要验证 msg_signature
  if (msgSignature) {
    var arr = [WECHAT_TOKEN, timestamp, nonce, echostr].sort();
    var str = arr.join('');
    var sha1 = crypto.createHash('sha1').update(str).digest('hex');
    
    if (sha1 !== msgSignature) {
      console.error('[WeChat] URL验证签名失败');
      console.error('[WeChat] 期望签名:', sha1);
      console.error('[WeChat] 实际签名:', msgSignature);
      return res.status(200).send('signature verify fail');
    }
    
    // 解密 echostr
    try {
      var decryptedEchostr = decryptMessage(echostr, WECHAT_ENCODING_AES_KEY);
      res.status(200).send(decryptedEchostr);
    } catch (err) {
      console.error('[WeChat] 解密echostr失败:', err.message);
      res.status(200).send('decrypt fail');
    }
  } else {
    // 简单模式
    var arr = [WECHAT_TOKEN, timestamp, nonce].sort();
    var str = arr.join('');
    var sha1 = crypto.createHash('sha1').update(str).digest('hex');

    if (sha1 === signature) {
      res.status(200).send(echostr);
    } else {
      console.error('[WeChat] 简单模式签名验证失败');
      res.status(200).send('signature error');
    }
  }
});

// 接收微信消息和事件（POST请求）
router.post('/callback', async (req, res) => {
  // 验证签名
  var signature = req.query.signature;
  var timestamp = req.query.timestamp;
  var nonce = req.query.nonce;
  var msgSignature = req.query.msg_signature;

  var arr = [WECHAT_TOKEN, timestamp, nonce].sort();
  var str = arr.join('');
  var sha1 = crypto.createHash('sha1').update(str).digest('hex');

  if (sha1 !== signature) {
    return res.send('signature error');
  }

  // 解析XML消息
  var body = '';
  req.on('data', function(chunk) { body += chunk; });
  req.on('end', async function() {
    try {
      var xmlContent = body;
      
      // 如果启用了消息加解密，需要先解密
      if (msgSignature) {
        // 验证消息体签名
        var encryptMatch = body.match(/<Encrypt><!\[CDATA\[(.*?)\]\]><\/Encrypt>/);
        if (!encryptMatch) {
          console.error('[WeChat] 未找到加密消息体');
          return res.send('');
        }
        
        var encryptMsg = encryptMatch[1];
        var verifyArr = [WECHAT_TOKEN, timestamp, nonce, encryptMsg].sort();
        var verifyStr = verifyArr.join('');
        var verifySha1 = crypto.createHash('sha1').update(verifyStr).digest('hex');
        
        if (verifySha1 !== msgSignature) {
          console.error('[WeChat] 消息体签名验证失败');
          return res.send('');
        }
        
        // 解密消息
        xmlContent = decryptMessage(encryptMsg, WECHAT_ENCODING_AES_KEY);
      }

      // 解析XML提取openid和事件类型
      var openid = (xmlContent.match(/<FromUserName><!\[CDATA\[(.*?)\]\]><\/FromUserName>/) || [])[1];
      var accountId = (xmlContent.match(/<ToUserName><!\[CDATA\[(.*?)\]\]><\/ToUserName>/) || [])[1];
      var event = (xmlContent.match(/<Event><!\[CDATA\[(.*?)\]\]><\/Event>/) || [])[1];
      var eventKey = (xmlContent.match(/<EventKey><!\[CDATA\[(.*?)\]\]><\/EventKey>/) || [])[1];
      var msgType = (xmlContent.match(/<MsgType><!\[CDATA\[(.*?)\]\]><\/MsgType>/) || [])[1];
      var msgContent = (xmlContent.match(/<Content><!\[CDATA\[(.*?)\]\]><\/Content>/) || [])[1];

      if (!openid) {
        return res.send('');
      }

      // 构建文本回复
      function buildTextReply(text) {
        var timestamp = Math.floor(Date.now() / 1000);
        return '<xml>' +
          '<ToUserName><![CDATA[' + openid + ']]></ToUserName>' +
          '<FromUserName><![CDATA[' + accountId + ']]></FromUserName>' +
          '<CreateTime>' + timestamp + '</CreateTime>' +
          '<MsgType><![CDATA[text]]></MsgType>' +
          '<Content><![CDATA[' + text + ']]></Content>' +
        '</xml>';
      }

      // 构建回复消息的函数
      function buildNewsReply(title, description, picUrl, linkUrl) {
        var timestamp = Math.floor(Date.now() / 1000);
        if (!picUrl) picUrl = 'https://wall.jay23.cn/images/show.png';
        if (!linkUrl) linkUrl = 'https://wall.jay23.cn';
        return '<xml>' +
          '<ToUserName><![CDATA[' + openid + ']]></ToUserName>' +
          '<FromUserName><![CDATA[' + accountId + ']]></FromUserName>' +
          '<CreateTime>' + timestamp + '</CreateTime>' +
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

      if (!openid) {
        return res.send('');
      }

      // ===== 文本消息回复 =====
      if (msgType === 'text' && msgContent) {
        // 防止重复请求: 如果同一个 openid 在 3 秒内有未完成的请求,直接返回空
        var requestKey = openid + '_' + msgContent;
        if (processingRequests.has(requestKey)) {
          console.log('[WeChat] 忽略重复请求:', requestKey.substring(0, 50));
          return res.send('');
        }
        processingRequests.set(requestKey, Date.now());
        // 3 秒后清理
        setTimeout(function() { processingRequests.delete(requestKey); }, 3000);

        var text = msgContent.trim();
        var replyText = '';

        if (text === '帮助' || text === 'help' || text === '菜单' || text === '功能') {
          replyText = '🌸 嘉二校园墙 · 帮助菜单\n\n' +
            '📝 投稿：访问网站发帖\n' +
            '🎵 点歌：在网站点歌给TA\n' +
            '🔗 绑定：回复"绑定"获取绑定教程\n' +
            '🌤️ 天气：回复"天气"查看今日天气\n' +
            '💡 更多：访问 https://wall.jay23.cn\n\n' +
            '✨ 回复对应关键词获取帮助~';
        } else if (text === '绑定' || text === '绑定账号') {
          replyText = '🔗 微信绑定教程\n\n' +
            '1️⃣ 打开 https://wall.jay23.cn\n' +
            '2️⃣ 登录你的账号\n' +
            '3️⃣ 进入"个人中心"→"绑定微信"\n' +
            '4️⃣ 扫码即可完成绑定\n\n' +
            '绑定后可以接收评论、点赞通知哦~';
        } else if (text === '投稿' || text === '怎么投稿' || text === '发布') {
          replyText = '📝 投稿指南\n\n' +
            '1️⃣ 打开 https://wall.jay23.cn\n' +
            '2️⃣ 点击"发布"按钮\n' +
            '3️⃣ 填写标题和内容\n' +
            '4️⃣ 可选配图\n' +
            '5️⃣ 提交等待审核\n\n' +
            '审核通过后就能在墙上看到啦~';
        } else if (text === '点歌' || text === '怎么点歌' || text === '点歌') {
          replyText = '🎵 点歌指南\n\n' +
            '1️⃣ 打开 https://wall.jay23.cn\n' +
            '2️⃣ 进入"广播站"页面\n' +
            '3️⃣ 选择可点歌的时段\n' +
            '4️⃣ 填写歌曲名和祝福语\n' +
            '5️⃣ 提交等待播放\n\n' +
            '校广播站会定时播放哦~';
        } else if (text === '天气' || text === '今日天气' || text === 'weather') {
          // 回复天气信息（异步获取）
          try {
            var weather = await mpDraftService.getWeather();
            if (weather && weather.temperature) {
              replyText = '🌤️ ' + (weather.city || '上海') + ' 今日天气\n\n' +
                '🌡️ 气温：' + weather.temperature + '\n' +
                '☁️ 天气：' + (weather.weather || '') + '\n' +
                '💨 风力：' + (weather.wind || '') + '\n' +
                '💧 湿度：' + (weather.humidity || '') + '';
            } else {
              replyText = '🌤️ 当前天气暂时获取不到，去 https://wall.jay23.cn 看看吧~';
            }
          } catch(e) {
            replyText = '🌤️ 天气服务暂时不可用~';
          }
        } else if (text === '你好' || text === 'hi' || text === 'hello' || text === '在吗' || text === '在不在') {
          replyText = '👋 你好呀！我是嘉二校园墙的小助手~\n\n' +
            '有什么想了解的可以回复关键词：\n' +
            '🔹 "帮助" - 查看所有功能\n' +
            '🔹 "天气" - 今日天气\n' +
            '🔹 "绑定" - 微信绑定\n\n' +
            '也可以直接访问 https://wall.jay23.cn 看看~';
        } else if (text === '版本' || text === 'version' || text === '关于') {
          replyText = '🌸 嘉二校园墙 · 更新日志\n\n' +
            '━━ V2.0（当前）━━\n' +
            '📌 微信公众号 + 网页联动版本\n' +
            '✅ 校园投稿/帖子墙\n' +
            '✅ 广播站点歌系统\n' +
            '✅ 微信扫码绑定 + 实时通知\n' +
            '✅ 公众号每日图文推送\n' +
            '✅ 天气/一言/每周之星\n' +
            '✅ 评论/点赞/收藏互动\n' +
            '✅ 反馈/公告/管理员后台\n' +
            '✅ 邮箱通知系统\n\n' +
            '━━ V1.0（已停用）━━\n' +
            '🤖 QQ机器人版本\n\n' +
            '🌐 https://wall.jay23.cn';
        } else if (text === '学校' || text === '嘉定二中' || text === '嘉二') {
          replyText = '🏫 上海市嘉定区第二中学\n\n' +
            '📍 地址：上海市嘉定区德华路388号\n' +
            '🌐 校园墙：https://wall.jay23.cn';
        } else if (text === '老婆' || text === '老公' || text === '女朋友' || text === '男朋友') {
          replyText = '😳 啊这。。我也想有啊！\n\n' +
            '要不你去校园墙发个帖碰碰运气？\n' +
            '说不定你的那个TA正在等你呢~ 💕\n\n' +
            '🌐 https://wall.jay23.cn';
        } else if (text === '晚安' || text === '晚安啦' || text === '睡了') {
          var h = new Date().getHours();
          replyText = '🌙 晚安呀~ 做个好梦！\n\n' +
            (h < 3 ? '这么晚还不睡，小心明天上课打瞌睡哦~😴' : '') +
            (h >= 3 && h < 6 ? '天都快亮了，快睡吧！🌅' : '') +
            (h >= 6 && h < 12 ? '呃... 现在说晚安是不是有点早？🙈' : '') +
            (h >= 12 && h < 18 ? '下午好！午安午安~☀️' : '') +
            (h >= 18 && h < 22 ? '天还早着呢，再玩会儿~✨' : '') +
            '\n\n🌐 https://wall.jay23.cn';
        } else if (text === '早安' || text === '早上好' || text === '早') {
          replyText = '☀️ 早安呀！新的一天又开始啦~\n\n' +
            '今天也要好好学习，开心生活！\n' +
            '💪 加油嘉二人！\n\n' +
            '🌐 https://wall.jay23.cn';
        } else if (text === '饿' || text === '饿了' || text === '吃饭' || text === '食堂') {
          replyText = '🍚 饿了就去食堂干饭！\n\n' +
            '德华路上的小吃街也不错哦~😋\n' +
            '不过别上课迟到啦！\n\n' +
            '🌐 https://wall.jay23.cn';
        } else if (text === '666' || text === '牛逼' || text === '厉害' || text === '大佬') {
          var tips = [
            '大佬带带我！🙇',
            '太强了太强了！👏',
            '这就是嘉二的实力吗！🔥',
            '膜拜大佬！🧎'
          ];
          replyText = '🎉 ' + tips[Math.floor(Math.random() * tips.length)] + '\n\n🌐 https://wall.jay23.cn';
        } else if (text === '无聊' || text === '好无聊' || text === '闲') {
          replyText = '😴 无聊的话...\n\n' +
            '📝 去校园墙发个帖找人聊天？\n' +
            '🎵 点首歌听听？\n' +
            '💬 看看其他人在聊什么？\n\n' +
            '来 https://wall.jay23.cn 逛逛吧~';
        } else if (text === '开心' || text === '好开心' || text === '哈哈哈') {
          replyText = '😄 开心就好呀！\n' +
            '笑容会传染的，把快乐传递给更多人吧~🌈\n\n' +
            '🌐 https://wall.jay23.cn';
        } else if (text === '伤心' || text === '难过' || text === '不开心' || text === '哭了') {
          replyText = '🥺 抱抱~ 不开心的事总会过去的！\n\n' +
            '去校园墙看看大家的帖子，\n' +
            '或者发个帖倾诉一下？\n' +
            '这里有很多温暖的同学~💕\n\n' +
            '🌐 https://wall.jay23.cn';
        } else if (text === '今天星期几' || text === '今天是周几') {
          var days = ['日', '一', '二', '三', '四', '五', '六'];
          var today = '周' + days[new Date().getDay()];
          replyText = '📅 今天是' + today + '~\n\n' +
            (new Date().getDay() === 0 || new Date().getDay() === 6 ? '周末啦！好好放松一下吧~🎉' : '今天也要加油呀！💪') +
            '\n\n🌐 https://wall.jay23.cn';
        } else {
          // 未匹配关键词 → 调用 AI 智能回复（带4.5秒超时保护）
          try {
            console.log('[WeChat] 调用AI回复,用户:', openid.substring(0, 10), '消息:', text.substring(0, 30));
            var aiPromise = aiService.getAIReply(text, openid);
            var timeoutPromise = new Promise(function(_, reject) {
              setTimeout(function() { reject(new Error('AI回复超时(4.8s)')); }, 4800);
            });
            replyText = await Promise.race([aiPromise, timeoutPromise]);
            console.log('[WeChat] AI回复成功:', replyText.substring(0, 50));
          } catch(e) {
            console.error('[WeChat] AI回复异常:', e.message);
            replyText = '回复"帮助"查看我能做什么吧~\n🌐 https://wall.jay23.cn';
          }
        }

        var replyXml = buildTextReply(replyText);
        res.set('Content-Type', 'application/xml; charset=utf-8');
        return res.send(replyXml);
      }

      // ===== 图片消息 =====
      if (msgType === 'image') {
        var imgTips = [
          '这张图看起来好有意思呀！🖼️',
          '哇塞！这是谁拍的/画的？太强了！🌟',
          '这图我存了！嘿嘿~ 📸',
          '好康好康！多发点（疯狂暗示）👀'
        ];
        var replyXml = buildTextReply('🖼️ ' + imgTips[Math.floor(Math.random() * imgTips.length)] + '\n\n' +
          '不过我现在还看不懂图片内容😅\n' +
          '发文字跟我聊天吧~\n\n' +
          '🔹 回复"帮助"查看所有功能\n' +
          '📤 或者去 https://wall.jay23.cn 发帖');
        res.set('Content-Type', 'application/xml; charset=utf-8');
        return res.send(replyXml);
      }

      // ===== 语音消息 =====
      if (msgType === 'voice') {
        var voiceTips = [
          '哎呀我这耳朵不太好使😅',
          '好像听到了什么有趣的东西~👂',
          '抱歉我还没学会听语音呢🙉'
        ];
        var replyXml = buildTextReply('🎤 ' + voiceTips[Math.floor(Math.random() * voiceTips.length)] + '\n\n' +
          '暂时听不懂语音消息啦，发文字跟我聊天吧！\n\n' +
          '🔹 回复"帮助"查看所有功能');
        res.set('Content-Type', 'application/xml; charset=utf-8');
        return res.send(replyXml);
      }

      // ===== 位置消息 =====
      if (msgType === 'location') {
        var locTips = [
          '就知道你在那儿！🧐',
          '收到定位！我闻到了嘉二的气息~🏫',
          '原来你在这里呀！🗺️'
        ];
        var replyXml = buildTextReply('📍 ' + locTips[Math.floor(Math.random() * locTips.length)] + '\n\n' +
          '不过我不会追踪你的位置啦，放心~😄\n' +
          '回复关键词跟我聊天吧！\n\n' +
          '🌐 https://wall.jay23.cn');
        res.set('Content-Type', 'application/xml; charset=utf-8');
        return res.send(replyXml);
      }

      // ===== 链接消息 =====
      if (msgType === 'link') {
        var linkTips = [
          '这个链接看起来不错！🔗',
          '让我康康！emmm打不开😅',
          '收到一个神秘链接~ 👀'
        ];
        var replyXml = buildTextReply('🔗 ' + linkTips[Math.floor(Math.random() * linkTips.length)] + '\n\n' +
          '我暂时不能自动打开链接啦😅\n' +
          '你可以自己去看看哦~\n\n' +
          '🔹 回复"帮助"查看所有功能\n' +
          '🌐 或者来 https://wall.jay23.cn 逛逛');
        res.set('Content-Type', 'application/xml; charset=utf-8');
        return res.send(replyXml);
      }

      if (event === 'subscribe' && eventKey) {
        // 扫码关注：eventKey 格式为 qrscene_场景值
        var sceneId = eventKey.replace('qrscene_', '');
        // 绑定openid
        var [bindings] = await pool.execute(
          'SELECT user_id FROM wechat_bindings WHERE scene_id = ? AND used = 0 LIMIT 1',
          [sceneId]
        );
        if (bindings.length > 0) {
          await pool.execute('UPDATE wechat_bindings SET openid = ?, used = 1, bound_at = NOW() WHERE scene_id = ?', [openid, sceneId]);
          // 更新用户表的openid
          await pool.execute('UPDATE users SET openid = ? WHERE id = ?', [openid, bindings[0].user_id]);
        }
      } else if (event === 'subscribe') {
        // 首次关注 - 用 AI 自然打招呼
        console.log('[WeChat] 新关注用户:', openid);
        try {
          // 存储到待绑定队列（有效期5分钟）
          await pool.execute(
            'INSERT INTO wechat_pending_follows (openid, created_at) VALUES (?, NOW())',
            [openid]
          );
          // 清理5分钟前的旧记录
          await pool.execute(
            'DELETE FROM wechat_pending_follows WHERE created_at < DATE_SUB(NOW(), INTERVAL 5 MINUTE)'
          );
        } catch (e) {
          if (e.code !== 'ER_DUP_ENTRY') {
            console.error('[WeChat] 存储关注记录失败:', e.message);
          }
        }
        // AI 生成欢迎语
        var welcomeReply = '👋 欢迎来到墙墙~ 我是嘉二校园墙的小助手！\n\n可以直接跟我聊天，或者去 https://wall.jay23.cn 逛逛哦~\n投稿、点歌、吃瓜都行~ 有什么想问的尽管说！';
        try {
          var aiReply = await aiService.getAIReply('新同学关注了校园墙，帮我欢迎ta！简短热情一点~');
          if (aiReply && aiReply.length > 5 && aiReply.length < 200) {
            welcomeReply = aiReply;
          }
        } catch (e) {
          // 用默认欢迎语
        }
        var replyXml = buildTextReply(welcomeReply);
        res.set('Content-Type', 'application/xml; charset=utf-8');
        return res.send(replyXml);
      } else if (event === 'unsubscribe') {
        // 取消关注 - 清除绑定
        console.log('[WeChat] 取消关注用户:', openid);
        try {
          // 查找该openid绑定的用户
          var [unsubUsers] = await pool.execute('SELECT id, username FROM users WHERE openid = ?', [openid]);
          if (unsubUsers.length > 0) {
            var unsubUser = unsubUsers[0];
            // 清除绑定
            await pool.execute('UPDATE users SET openid = NULL WHERE id = ?', [unsubUser.id]);
            console.log('[WeChat] 已清除用户 ' + unsubUser.username + '(ID:' + unsubUser.id + ') 的微信绑定');
          } else {
            console.log('[WeChat] 取消关注的openid未绑定任何用户:', openid);
          }
          // 清理待绑定记录
          await pool.execute('DELETE FROM wechat_pending_follows WHERE openid = ?', [openid]);
        } catch (e) {
          console.error('[WeChat] 处理取消关注失败:', e.message);
        }
      } else if (event === 'SCAN') {
        // 已关注用户扫码
        var sceneId = eventKey;
        var [bindings] = await pool.execute(
          'SELECT user_id FROM wechat_bindings WHERE scene_id = ? AND used = 0 LIMIT 1',
          [sceneId]
        );
        if (bindings.length > 0) {
          await pool.execute('UPDATE wechat_bindings SET openid = ?, used = 1, bound_at = NOW() WHERE scene_id = ?', [openid, sceneId]);
          await pool.execute('UPDATE users SET openid = ? WHERE id = ?', [openid, bindings[0].user_id]);
        }
      }

      // 如果需要回复消息，且启用了加密，需要加密后返回
      res.send('');
    } catch (err) {
      console.error('[WeChat] 处理消息失败:', err.message);
      res.send('');
    }
  });
});

// 检查微信绑定状态
router.get('/status', async (req, res) => {
  try {
    var token = req.headers.authorization?.split(' ')[1] || req.cookies?.token;
    if (!token) return res.json({ code: 401, message: '未登录' });

    var jwt = require('jsonwebtoken');
    var decoded = jwt.verify(token, process.env.JWT_SECRET || '114514');
    var [users] = await pool.execute('SELECT openid FROM users WHERE id = ?', [decoded.id]);

    res.json({ code: 200, data: { bound: !!users[0]?.openid } });
  } catch (err) {
    res.json({ code: 401, message: '登录已过期' });
  }
});

// 生成绑定场景ID（订阅号适配：返回固定公众号二维码）
router.post('/generate-bind', async (req, res) => {
  try {
    var token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.json({ code: 401, message: '未登录' });

    var jwt = require('jsonwebtoken');
    var decoded = jwt.verify(token, process.env.JWT_SECRET || '114514');

    // 生成唯一的场景ID（用于后续追踪）
    var sceneId = 'bind_' + decoded.id + '_' + Date.now();

    // 存入绑定记录（订阅号无法通过扫码追踪，但保留记录）
    await pool.execute(
      'INSERT INTO wechat_bindings (user_id, scene_id, created_at) VALUES (?, ?, NOW())',
      [decoded.id, sceneId]
    );

    // 订阅号返回固定的公众号二维码
    var wechatService = require('../services/wechat');
    var qrCodeUrl = wechatService.generateQRCode();

    res.json({ 
      code: 200, 
      message: '请扫描下方二维码关注公众号，关注后系统将自动绑定（订阅号无法追踪扫码状态，请手动刷新页面确认）',
      data: {
        qrCodeUrl: qrCodeUrl,
        sceneId: sceneId
      }
    });
  } catch (err) {
    console.error('[WeChat] 生成绑定失败:', err.message);
    res.json({ code: 500, message: '生成失败' });
  }
});

// 解绑
router.post('/unbind', async (req, res) => {
  try {
    var token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.json({ code: 401, message: '未登录' });
    var jwt = require('jsonwebtoken');
    var decoded = jwt.verify(token, process.env.JWT_SECRET || '114514');
    await pool.execute('UPDATE users SET openid = NULL WHERE id = ?', [decoded.id]);
    res.json({ code: 200, message: '已解绑' });
  } catch (err) {
    res.json({ code: 500, message: '解绑失败' });
  }
});

// 订阅号手动验证：用户关注后点击"我已关注"完成绑定
router.post('/verify-follow', async (req, res) => {
  try {
    var token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.json({ code: 401, message: '未登录' });

    var jwt = require('jsonwebtoken');
    var decoded = jwt.verify(token, process.env.JWT_SECRET || '114514');
    var userId = decoded.id;

    // 检查用户是否已绑定
    var [users] = await pool.execute('SELECT openid FROM users WHERE id = ?', [userId]);
    if (users[0]?.openid) {
      return res.json({ code: 200, message: '已绑定', bound: true });
    }

    // 查找最近的关注记录（2分钟内）
    var [follows] = await pool.execute(
      'SELECT openid FROM wechat_pending_follows WHERE created_at >= DATE_SUB(NOW(), INTERVAL 2 MINUTE) ORDER BY created_at DESC LIMIT 1'
    );

    if (follows.length === 0) {
      return res.json({ code: 400, message: '未检测到新的关注，请确认已关注公众号后重试', bound: false });
    }

    var openid = follows[0].openid;

    // 检查这个openid是否已被其他用户绑定
    var [boundUsers] = await pool.execute('SELECT id FROM users WHERE openid = ?', [openid]);
    if (boundUsers.length > 0 && boundUsers[0].id !== userId) {
      return res.json({ code: 400, message: '该微信已被其他账号绑定', bound: false });
    }

    // 绑定到当前用户
    await pool.execute('UPDATE users SET openid = ? WHERE id = ?', [openid, userId]);

    // 清理已使用的待绑定记录
    await pool.execute('DELETE FROM wechat_pending_follows WHERE openid = ?', [openid]);

    // 更新bindings表
    await pool.execute(
      'UPDATE wechat_bindings SET openid = ?, used = 1, bound_at = NOW() WHERE user_id = ?',
      [openid, userId]
    );

    res.json({ code: 200, message: '绑定成功', bound: true });
  } catch (err) {
    console.error('[WeChat] 验证绑定失败:', err.message);
    res.json({ code: 500, message: '验证失败，请重试' });
  }
});

module.exports = router;
