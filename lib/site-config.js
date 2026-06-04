/**
 * 站点配置中心
 * 所有站点名/域名/校名都从这里读，统一管理
 * 别人 clone 后只改 .env 的 SCHOOL_NAME / SITE_DOMAIN 即可生效
 */

const path = require('path');

// 加载 .env（如果存在）
try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  require('dotenv').config({ path: path.join(__dirname, '..', '.env.local'), override: true });
} catch (e) {}

const config = {
  // 学校名（最常改的）
  schoolName: process.env.SCHOOL_NAME || '你的学校',

  // 站点名（顶部品牌）
  siteName: process.env.SITE_NAME || '校园墙',

  // 完整域名（不含协议）
  domain: process.env.SITE_DOMAIN || 'your-domain.com',

  // 完整 URL（含协议）
  siteUrl: process.env.SITE_URL || (process.env.SITE_DOMAIN ? 'https://' + process.env.SITE_DOMAIN : 'https://your-domain.com'),

  // 联系邮箱
  contactEmail: process.env.CONTACT_EMAIL || 'admin@your-domain.com',

  // 公众号名称（推文署名用）
  mpAuthor: process.env.MP_AUTHOR || process.env.SITE_NAME || '校园墙编辑部',

  // 站点标语
  slogan: process.env.SITE_SLOGAN || '一站式校园生活',

  // 版权年份
  foundedYear: process.env.FOUNDED_YEAR || new Date().getFullYear()
};

module.exports = config;
