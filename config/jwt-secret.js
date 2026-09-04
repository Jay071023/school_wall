const crypto = require('crypto');
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('❌ JWT_SECRET 环境变量未设置，请创建 .env 文件并添加 JWT_SECRET=你的密钥');
}
module.exports = JWT_SECRET;