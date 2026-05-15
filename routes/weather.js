const express = require('express');
const router = express.Router();
const http = require('http');

// 国内主要城市 → 天气代码映射
var CITY_CODES = {
  '北京': '101010100', '上海': '101020100', '广州': '101280101',
  '深圳': '101280601', '杭州': '101210101', '南京': '101190101',
  '成都': '101270101', '武汉': '101200101', '重庆': '101040100',
  '西安': '101110101', '天津': '101030100', '苏州': '101190401',
  '长沙': '101250101', '郑州': '101180101', '济南': '101120101',
  '青岛': '101120201', '厦门': '101230201', '福州': '101230101',
  '合肥': '101220101', '宁波': '101210401', '无锡': '101190201',
  '常州': '101190301', '嘉兴': '101210301', '绍兴': '101210501',
  '温州': '101210701', '金华': '101210901', '南通': '101190501'
};

// 根据IP获取城市
function getCityFromIP(ip, callback) {
  http.get('http://whois.pconline.com.cn/ipJson.jsp?ip=' + ip + '&json=true', function(resp) {
    var data = '';
    resp.setEncoding('utf-8');
    resp.on('data', function(chunk) { data += chunk; });
    resp.on('end', function() {
      try {
        var info = JSON.parse(data);
        callback(info.city || '上海');
      } catch (e) {
        callback('上海');
      }
    });
  }).on('error', function() {
    callback('上海');
  });
}

// 根据城市代码获取天气
function getWeatherByCode(code, callback) {
  http.get('http://t.weather.itboy.net/api/weather/city/' + code, function(resp) {
    var data = '';
    resp.on('data', function(chunk) { data += chunk; });
    resp.on('end', function() {
      try {
        var parsed = JSON.parse(data);
        if (parsed && parsed.data && parsed.data.forecast && parsed.data.forecast.length > 0) {
          var today = parsed.data.forecast[0];
          var now = parsed.data.forecast[0];
          callback({
            city: parsed.cityInfo ? parsed.cityInfo.city : '未知',
            current: {
              temperature_2m: parseInt(now.low.replace(/[^0-9]/g, '')) || 20,
              weather_code: 0,
              relative_humidity_2m: 50,
              wind_speed_10m: 0
            }
          });
        } else {
          callback(null);
        }
      } catch (e) {
        callback(null);
      }
    });
  }).on('error', function() {
    callback(null);
  });
}

// 天气路由
router.get('/', async (req, res) => {
  // 5秒超时防御
  var timeout = setTimeout(function() {
    returnDefault(res);
  }, 5000);

  try {
    var ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress || '';
    ip = ip.replace(/^::ffff:/, '').split(',')[0].trim();

    getCityFromIP(ip, function(city) {
      var code = CITY_CODES[city] || '101020100'; // 找不到代码就用上海
      getWeatherByCode(code, function(weather) {
        clearTimeout(timeout);
        if (weather) {
          res.json({ code: 200, data: weather });
        } else {
          getWeatherByCode('101020100', function(shanghai) {
            res.json({ code: 200, data: shanghai || { city: '上海', current: { temperature_2m: 20, weather_code: 0 } } });
          });
        }
      });
    });
  } catch (err) {
    clearTimeout(timeout);
    returnDefault(res);
  }
});

function returnDefault(res) {
  res.json({ code: 200, data: { city: '上海', current: { temperature_2m: 20, weather_code: 0 } } });
}

module.exports = router;
