const fs = require('fs');
const { spawnSync } = require('child_process');
const path = require('path');
const os = require('os');

const key = path.join(__dirname.replace(/\\/g, '/'), 'ssh_key_new2');
const host = 'root@124.222.255.33';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('用法: node _ssh_upload.js <local> [<remote>]');
  process.exit(1);
}

const localPath = files[0];
const remotePath = files[1];
const base = path.basename(localPath);
const tmp = path.join(os.tmpdir(), 'ush_' + base);

fs.copyFileSync(localPath, tmp);

let remote = remotePath;
if (!remote) {
  remote = '/tmp/' + base;
}
// Git Bash 把 /www/... 解释为相对路径, 加 ./ 前缀绕过
if (remote.startsWith('/') && !remote.startsWith('//')) {
  remote = './' + remote;
}

const r = spawnSync('scp', ['-i', key, '-o', 'StrictHostKeyChecking=no', tmp, `${host}:${remote}`], { stdio: 'inherit', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
fs.unlinkSync(tmp);
process.exit(r.status || 0);
