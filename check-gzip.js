const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

const SERVER = {
    host: '152.32.226.134',
    port: 22,
    username: 'root',
    privateKey: fs.readFileSync(path.join(__dirname, 'ssh_key_new'))
};

async function exec(conn, cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) { reject(err); return; }
      let out = '';
      stream.on('data', d => out += d.toString());
      stream.stderr.on('data', d => out += d.toString());
      stream.on('close', () => resolve(out));
    });
  });
}

async function main() {
  const conn = await new Promise((resolve, reject) => {
    const c = new Client();
    c.on('ready', () => resolve(c));
    c.on('error', reject);
    c.connect(SERVER);
  });
  console.log('Connected!\n');

  // 1. 检查 nginx gzip 配置
  console.log('=== Nginx gzip 配置 ===');
  let r = await exec(conn, 'nginx -t 2>&1; grep -r "gzip" /etc/nginx/ 2>/dev/null | head -20');
  console.log(r);

  // 2. 检查宝塔面板的 nginx 配置
  console.log('=== 宝塔 Nginx 配置 ===');
  r = await exec(conn, 'find /www/server/nginx -name "*.conf" 2>/dev/null | head -5; grep -r "gzip" /www/server/nginx/conf/ 2>/dev/null | head -15');
  console.log(r);

  // 3. 查找网站配置文件
  console.log('=== 站点配置 ===');
  r = await exec(conn, 'find /www/server/panel/vhost -name "*.conf" 2>/dev/null | head -10; cat /www/server/panel/vhost/nginx/wall.jay23.cn.conf 2>/dev/null | head -30');
  console.log(r);

  conn.end();
}

main().catch(e => { console.error(e); process.exit(1); });
