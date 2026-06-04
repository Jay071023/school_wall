/**
 * 微信公众号素材服务
 * 用于将校墙热点内容上传到公众号草稿箱，供手动发布
 * 包含天气、一言等丰富内容
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// 微信公众号配置（与 wechat.js 保持一致）
const WECHAT_APPID = 'wx513226ad98127a0d';
const WECHAT_SECRET = process.env.WECHAT_SECRET || 'YOUR_APP_SECRET';

// 配置项
const CONFIG = {
  // 天气API配置（使用和风天气免费版）
  WEATHER_API_KEY: process.env.WEATHER_API_KEY || '',
  WEATHER_CITY: process.env.WEATHER_CITY || '上海', // 默认城市
  
  // 一言API配置
  HITOKOTO_API: 'https://v1.hitokoto.cn/?c=i&c=d&c=k', // 诗词、文学、动画
};

/**
 * 获取微信 Access Token
 */
async function getAccessToken() {
  return new Promise((resolve, reject) => {
    const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${WECHAT_APPID}&secret=${WECHAT_SECRET}`;
    https.get(url, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        try {
          var json = JSON.parse(data);
          if (json.access_token) {
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
 * 上传临时素材（图片）
 * @param {string} imageUrl - 图片URL或本地路径
 * @param {string} type - 媒体类型：image
 * @returns {string} media_id
 */
async function uploadMedia(imageUrl, type = 'image') {
  try {
    const token = await getAccessToken();
    
    // 判断是远程URL还是本地文件
    let imageBuffer;
    if (imageUrl.startsWith('http')) {
      // 从远程URL下载图片
      imageBuffer = await downloadImage(imageUrl);
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

      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  } catch (err) {
    console.error('[MP素材] 上传媒体失败:', err.message);
    throw err;
  }
}

/**
 * 下载图片
 */
function downloadImage(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    protocol.get(url, function(res) {
      if (res.statusCode !== 200) {
        return reject(new Error('下载图片失败: ' + res.statusCode));
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

/**
 * 上传图文素材内的图片（获取URL）
 * @param {string} imageUrl - 图片URL
 * @returns {string} 微信图片URL
 */
async function uploadMpImage(imageUrl) {
  try {
    const token = await getAccessToken();
    const imageBuffer = imageUrl.startsWith('http') 
      ? await downloadImage(imageUrl) 
      : fs.readFileSync(imageUrl);

    var ext = path.extname(imageUrl).toLowerCase();
    var contentType = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
    var filename = 'image' + ext;

    return new Promise((resolve, reject) => {
      const url = `https://api.weixin.qq.com/cgi-bin/media/uploadimg?access_token=${token}`;
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
            if (json.url) {
              resolve(json.url);
            } else {
              reject(new Error('上传图片失败: ' + data));
            }
          } catch (e) {
            reject(e);
          }
        });
      });

      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  } catch (err) {
    console.error('[MP素材] 上传图片失败:', err.message);
    throw err;
  }
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
            console.log('[MP永久素材] 上传成功, media_id:', json.media_id);
            resolve(json.media_id);
          } else {
            console.error('[MP永久素材] 上传失败:', data);
            reject(new Error('上传永久素材失败: ' + (json.errmsg || data)));
          }
        } catch (e) { reject(e); }
      });
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
    console.log('[MP素材] 使用环境变量封面 media_id:', cachedDefaultThumbMediaId);
    return cachedDefaultThumbMediaId;
  }

  try {
    var candidates = [
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
      console.log('[MP素材] 默认封面 media_id:', cachedDefaultThumbMediaId);
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
        return {
          title: article.title,
          author: article.author || '嘉二校园墙',
          digest: article.digest || article.title.substring(0, 50),
          content: article.content,
          content_source_url: article.content_source_url || 'https://wall.jay23.cn',
          thumb_media_id: article.thumb_media_id,
          show_cover_pic: article.show_cover_pic || 1,
          need_open_comment: article.need_open_comment || 1,
          only_fans_can_comment: article.only_fans_can_comment || 0
        };
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

      const req = https.request(url, options, function(res) {
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
          wind: c.winddir16Point + ' ' + c.windspeedKmph + 'km/h',
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
 * 根据天气文字获取emoji
 */
function getWeatherEmoji(text) {
  if (!text) return '🌤️';
  var lower = text.toLowerCase();
  if (lower.includes('晴') || lower.includes('clear') || lower.includes('sunny') || lower.includes('fair')) return '☀️';
  if (lower.includes('云') || lower.includes('cloud') || lower.includes('阴') || lower.includes('overcast')) return '⛅';
  if (lower.includes('阴')) return '☁️';
  if (lower.includes('雨') || lower.includes('雨') || lower.includes('rain') || lower.includes('drizzle') || lower.includes('shower')) return '🌧️';
  if (lower.includes('雪') || lower.includes('snow') || lower.includes('sleet')) return '❄️';
  if (lower.includes('雾') || lower.includes('fog') || lower.includes('mist') || lower.includes('haze')) return '🌫️';
  if (lower.includes('雷') || lower.includes('thunder') || lower.includes('storm')) return '⛈️';
  return '🌤️';
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
    https.get(url, function(res) {
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
    }).on('error', reject);
  });

  // 上传默认封面
  var defaultImgPath = path.join(__dirname, '..', 'public', 'images', 'default-cover.png');
  var thumbMediaId = null;
  if (fs.existsSync(defaultImgPath)) {
    thumbMediaId = await uploadMediaWithToken(defaultImgPath, token);
  }
  if (!thumbMediaId) {
    throw new Error('无法上传封面图片');
  }

  // 使用 draft/add API（测试号支持）
  var draftData = {
    articles: [{
      title: article.title,
      author: article.author || '嘉二校园墙',
      digest: article.digest || article.title.substring(0, 50),
      content: article.content,
      content_source_url: article.content_source_url || 'https://wall.jay23.cn',
      thumb_media_id: thumbMediaId,
      show_cover_pic: 1,
      need_open_comment: 1,
      only_fans_can_comment: 0
    }]
  };

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
            console.log('[MP测试号] 草稿创建成功, media_id:', json.media_id);
            resolve(json.media_id);
          } else {
            reject(new Error('创建草稿失败: ' + (json.errmsg || responseData)));
          }
        } catch (e) { reject(e); }
      });
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
            console.log('[MP永久素材] 上传成功, media_id:', json.media_id);
            resolve(json.media_id);
          } else {
            console.error('[MP永久素材] 上传失败:', data);
            resolve(null);
          }
        } catch (e) { resolve(null); }
      });
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
  uploadPermanentImage,
  uploadMpImage,
  createDraft,
  createDraftWithConfig,
  getDraftList,
  deleteDraft,
  getWeather,
  getHitokoto,
  getDateInfo,
  getTodayInHistory
};
