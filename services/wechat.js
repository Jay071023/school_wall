/**
 * 微信服务 - 订阅号适配版本
 * 支持功能：基础消息、用户信息获取
 * 不支持：带参数二维码、模板消息（订阅号限制）
 */

const https = require('https');
const crypto = require('crypto');

// 微信公众号配置（从环境变量读取，由 upload.js 自动配置）
const WECHAT_APPID = process.env.WECHAT_APPID || 'wx513226ad98127a0d';
const WECHAT_SECRET = process.env.WECHAT_SECRET || '';

/**
 * 获取微信 Access Token（全局缓存，2小时有效）
 */
let cachedAccessToken = null;
let tokenExpireTime = 0;

async function getAccessToken() {
  if (cachedAccessToken && Date.now() < tokenExpireTime) {
    return cachedAccessToken;
  }
  
  return new Promise((resolve, reject) => {
    const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${WECHAT_APPID}&secret=${WECHAT_SECRET}`;
    https.get(url, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        try {
          var json = JSON.parse(data);
          if (json.access_token) {
            cachedAccessToken = json.access_token;
            tokenExpireTime = Date.now() + (json.expires_in - 200) * 1000;
            resolve(json.access_token);
          } else {
            reject(new Error('获取access_token失败: ' + data));
          }
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

/**
 * 生成微信扫码登录二维码链接
 */
function getQRCodeUrl(redirectUri, state) {
  return `https://open.weixin.qq.com/connect/qrconnect?appid=${WECHAT_APPID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=snsapi_login&state=${state}#wechat_redirect`;
}

/**
 * 通过code获取 openid 和 access_token
 */
async function getOpenidByCode(code) {
  return new Promise((resolve, reject) => {
    const url = `https://api.weixin.qq.com/sns/oauth2/access_token?appid=${WECHAT_APPID}&secret=${WECHAT_SECRET}&code=${code}&grant_type=authorization_code`;
    https.get(url, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        try {
          var json = JSON.parse(data);
          if (json.openid) {
            resolve({ openid: json.openid, access_token: json.access_token });
          } else {
            reject(new Error('获取openid失败: ' + data));
          }
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

/**
 * 获取用户基本信息（包含昵称、头像）
 */
async function getUserInfo(openid) {
  try {
    var token = await getAccessToken();
    return new Promise((resolve, reject) => {
      const url = `https://api.weixin.qq.com/cgi-bin/user/info?access_token=${token}&openid=${openid}&lang=zh_CN`;
      https.get(url, function(res) {
        var data = '';
        res.on('data', function(chunk) { data += chunk; });
        res.on('end', function() {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      }).on('error', reject);
    });
  } catch (e) {
    console.error('[WeChat] 获取用户信息失败:', e.message);
    return null;
  }
}

/**
 * 发送微信模板消息（仅服务号支持）
 * @deprecated 订阅号不支持模板消息，此方法已禁用
 */
async function sendTemplateMessage(openid, templateId, data, url) {
  console.warn('[WeChat] 订阅号不支持模板消息功能');
  return false;
}

/**
 * 发送帖子通知模板消息（关注的人发帖）
 */
async function sendFollowPostNotify(openid, posterNickname, postTitle, postId) {
  // 模板ID需要在微信后台配置
  var templateId = process.env.WECHAT_TEMPLATE_FOLLOW_POST || 'YOUR_TEMPLATE_ID';
  var data = {
    first: { value: `${posterNickname}发布了新帖子`, color: '#FF6B9D' },
    keyword1: { value: postTitle, color: '#4A3F5C' },
    keyword2: { value: '帖子', color: '#4A3F5C' },
    keyword3: { value: new Date().toLocaleString('zh-CN'), color: '#B8A9D4' },
    remark: { value: '点击查看TA的新帖子', color: '#C084FC' }
  };
  var url = `https://wall.jay23.cn/post/${postId}`;
  return sendTemplateMessage(openid, templateId, data, url);
}

/**
 * 发送评论通知模板消息
 */
async function sendCommentNotify(openid, commenterNickname, postTitle, postId) {
  var templateId = process.env.WECHAT_TEMPLATE_COMMENT || 'YOUR_TEMPLATE_ID';
  var data = {
    first: { value: `有新的评论`, color: '#FF6B9D' },
    keyword1: { value: commenterNickname, color: '#C084FC' },
    keyword2: { value: postTitle, color: '#4A3F5C' },
    keyword3: { value: new Date().toLocaleString('zh-CN'), color: '#B8A9D4' },
    remark: { value: '点击查看评论内容', color: '#C084FC' }
  };
  var url = `https://wall.jay23.cn/post/${postId}`;
  return sendTemplateMessage(openid, templateId, data, url);
}

/**
 * 发送点歌播放通知模板消息
 */
async function sendSongPlayedNotify(openid, songName, artist) {
  var templateId = process.env.WECHAT_TEMPLATE_SONG || 'YOUR_TEMPLATE_ID';
  var data = {
    first: { value: '🎉 你的点歌被播放了！', color: '#FF6B9D' },
    keyword1: { value: songName, color: '#4A3F5C' },
    keyword2: { value: artist, color: '#4A3F5C' },
    keyword3: { value: new Date().toLocaleString('zh-CN'), color: '#B8A9D4' },
    remark: { value: '感谢你的参与，继续加油点歌哦~', color: '#C084FC' }
  };
  var url = 'https://wall.jay23.cn/radio';
  return sendTemplateMessage(openid, templateId, data, url);
}

/**
 * 生成公众号二维码（订阅号使用）
 * @returns {string} 公众号二维码图片URL
 * @note 订阅号不支持带参数二维码，返回固定公众号二维码
 */
function generateQRCode() {
  // 订阅号只能使用固定的公众号二维码
  console.warn('[WeChat] 订阅号不支持带参数二维码，使用固定公众号二维码');
  return '/images/gzh.jpg'; // 公众号二维码图片路径
}

module.exports = {
  getAccessToken,
  getQRCodeUrl,
  getOpenidByCode,
  getUserInfo,
  sendTemplateMessage,
  sendFollowPostNotify,
  sendCommentNotify,
  sendSongPlayedNotify,
  generateQRCode
};