/**
 * IP归属地查询服务
 * 统一使用 ip2region 离线库 + ip-api.com 在线API 兜底
 * 支持 IPv4 和 IPv6
 */

const path = require('path');
const IP2Region = require('ip2region').default;

// 初始化 ip2region
let ip2region = null;
try {
  const dbPath = path.join(__dirname, '../data/ip2region.xdb');
  ip2region = new IP2Region(dbPath);
} catch (err) {
  // ip2region 初始化失败，仅使用在线API
}

// 归属地缓存
const regionCache = new Map();
const CACHE_MAX = 500;
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7天

/**
 * 获取客户端真实IP
 */
function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
         req.headers['x-real-ip'] ||
         req.socket?.remoteAddress ||
         req.ip ||
         '';
}

/**
 * 获取IP归属地
 * @param {string} ip - 原始IP地址
 * @returns {Promise<string>} 归属地字符串（如"上海 · 上海"），查询失败返回IP本身
 */
async function getIpRegion(ip) {
  if (!ip) return '未知';

  // 本地地址
  const localIps = ['::1', '127.0.0.1', '0.0.0.0', 'localhost'];
  if (localIps.some(localIp => ip === localIp || ip === '::ffff:' + localIp)) {
    return '本地';
  }

  // 清理 ::ffff: 前缀
  let cleanIp = ip;
  if (ip.indexOf('::ffff:') === 0) {
    cleanIp = ip.substring(7);
  }

  // IPv4：优先用 ip2region 离线库
  const isIPv6 = cleanIp.includes(':');
  if (!isIPv6 && ip2region) {
    try {
      const result = ip2region.search(cleanIp);
      if (result && result.province) {
        let region = result.province;
        if (result.city && result.city !== '0') {
          region += ' · ' + result.city;
        }
        return region;
      }
    } catch (err) {
      // ip2region 失败，走在线API兜底
    }
  }

  // 在线API查询（优先 ip-api.com，失败时用 ipinfo.io 兜底）
  const cached = regionCache.get(cleanIp);
  if (cached && Date.now() - cached.time < CACHE_TTL) {
    return cached.region;
  }

  const https = require('https');

  // 通用在线查询函数
  async function queryOnline(url, timeoutMs) {
    return new Promise((resolve) => {
      const req = https.get(url, { timeout: timeoutMs }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            resolve(null);
          }
        });
      });
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.on('error', () => resolve(null));
    });
  }

  // 尝试多个API，直到一个成功
  const apis = [
    // API 1: ip-api.com（中文、准确、支持IPv4和IPv6）
    {
      url: `https://ip-api.com/json/${cleanIp}?lang=zh-CN&fields=status,regionName,city`,
      timeout: 4000,
      parse: function(json) {
        if (json && json.status === 'success' && (json.regionName || json.city)) {
          let r = '';
          if (json.regionName) r += json.regionName;
          if (json.city && json.city !== json.regionName) {
            r += (r ? ' · ' : '') + json.city;
          }
          return r || null;
        }
        return null;
      }
    },
    // API 2: ipinfo.io（兜底，支持IPv4和IPv6，返回城市+地区+国家）
    {
      url: `https://ipinfo.io/${cleanIp}?token=`,
      timeout: 3000,
      parse: function(json) {
        if (json && (json.city || json.region)) {
          let r = '';
          if (json.city) r += json.city;
          if (json.region) r += (r ? ' · ' : '') + json.region;
          if (json.country && json.country !== 'CN') r += ' · ' + json.country;
          return r || null;
        }
        return null;
      }
    }
  ];

  for (const api of apis) {
    try {
      const json = await queryOnline(api.url, api.timeout);
      const r = api.parse(json);
      if (r) {
        regionCache.set(cleanIp, { region: r, time: Date.now() });
        if (regionCache.size > CACHE_MAX) {
          const firstKey = regionCache.keys().next().value;
          regionCache.delete(firstKey);
        }
        return r;
      }
    } catch (err) {
      // 继续尝试下一个API
    }
  }

  // 所有API都失败，返回原始IP
  return cleanIp;
}

/** 常用中文城市/地区英文→中文映射 */
var CN_MAP = {
  'Shanghai':'上海', 'Beijing':'北京', 'Guangzhou':'广州', 'Shenzhen':'深圳',
  'Chengdu':'成都', 'Hangzhou':'杭州', 'Wuhan':'武汉', 'Nanjing':'南京',
  'Chongqing':'重庆', 'Tianjin':'天津', 'Shenyang':'沈阳', 'Suzhou':'苏州',
  'Xi\'an':'西安', 'Changsha':'长沙', 'Zhengzhou':'郑州', 'Dongguan':'东莞',
  'Qingdao':'青岛', 'Ningbo':'宁波', 'Kunming':'昆明', 'Dalian':'大连',
  'Xiamen':'厦门', 'Fuzhou':'福州', 'Hefei':'合肥', 'Harbin':'哈尔滨',
  'Jinan':'济南', 'Wuxi':'无锡', 'Changchun':'长春', 'Guiyang':'贵阳',
  'Nanning':'南宁', 'Zhuhai':'珠海', 'Taiyuan':'太原', 'Xuzhou':'徐州',
  'Lanzhou':'兰州', 'Haikou':'海口', 'Urumqi':'乌鲁木齐', 'Hohhot':'呼和浩特',
  'Macau':'澳门', 'Hong Kong':'香港', 'Taipei':'台北', 'Taichung':'台中',
  'Kaohsiung':'高雄', 'Tainan':'台南',
  // 省份
  'Zhejiang':'浙江', 'Jiangsu':'江苏', 'Guangdong':'广东', 'Sichuan':'四川',
  'Fujian':'福建', 'Hubei':'湖北', 'Hunan':'湖南', 'Shandong':'山东',
  'Henan':'河南', 'Hebei':'河北', 'Anhui':'安徽', 'Jiangxi':'江西',
  'Liaoning':'辽宁', 'Yunnan':'云南', 'Shanxi':'山西', 'Jilin':'吉林',
  'Heilongjiang':'黑龙江', 'Shaanxi':'陕西', 'Gansu':'甘肃', 'Guizhou':'贵州',
  'Hainan':'海南', 'Qinghai':'青海', 'Neimenggu':'内蒙古', 'Xizang':'西藏',
  'Ningxia':'宁夏', 'Xinjiang':'新疆', 'Guangxi':'广西'
};

/** 将IP归属地字符串中的英文名转为中文 */
function toChineseRegion(region) {
  if (!region) return region;
  var result = region;
  for (var key in CN_MAP) {
    // 替换英文名称为中文（区分大小写，独立词匹配）
    var regex = new RegExp('\\b' + key + '\\b', 'g');
    result = result.replace(regex, CN_MAP[key]);
  }
  return result;
}

// 重写getIpRegion，对结果应用中文映射
var originalGetIpRegion = getIpRegion;
getIpRegion = async function(ip) {
  var result = await originalGetIpRegion(ip);
  var cnResult = toChineseRegion(result);
  if (result !== cnResult) {
    console.log('[IP] 中文映射: ' + result + ' → ' + cnResult);
  }
  return cnResult;
};

module.exports = { getIpRegion, getClientIp, toChineseRegion };