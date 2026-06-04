const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

// 从 .env.local 读取所有环境变量
var ENV_VARS = {};
try {
    var envPath = path.join(__dirname, '.env.local');
    if (fs.existsSync(envPath)) {
        var envContent = fs.readFileSync(envPath, 'utf8');
        envContent.split('\n').forEach(function(line) {
            line = line.trim();
            if (!line || line.startsWith('#')) return;
            var eqIdx = line.indexOf('=');
            if (eqIdx > 0) ENV_VARS[line.substring(0, eqIdx).trim()] = line.substring(eqIdx + 1).trim();
        });
    }
} catch(e) {}
console.log('[上传] 环境变量: ' + Object.keys(ENV_VARS).join(', ') || '无');

const SERVER = {
    host: '152.32.226.134',
    port: 22,
    username: 'root',
    privateKey: fs.readFileSync(path.join(__dirname, 'ssh_key_new'))
};

const REMOTE_BASE = '/www/wwwroot/wall.jay23.cn/campus-wall';

// 所有可能上传的文件列表
const ALL_FILES = [
    '.env',
    'server.js',
    'config/database.js',
    'middleware/auth.js',
    'services/ip-lookup.js',
    'routes/posts.js',
    'routes/auth.js',
    'routes/songs.js',
    'routes/admin.js',
    'routes/upload.js',
    'routes/reservations.js',
    'routes/leaderboard.js',
    'routes/follows.js',
    'routes/weather.js',
    'routes/hotsearch.js',
    'routes/site-info.js',
    'routes/wechat.js',
    'routes/messages.js',
    'services/email.js',
    'services/wechat.js',
    'services/mp-draft.js',
    'services/ai.js',
    'routes/mp-draft.js',
    'public/js/detail.js',
    'public/js/detail-replies.js',
    'public/js/detail-emojis.js',
    'public/js/user-card.js',
    'public/js/home.js',
    'public/js/profile.js',
    'public/js/radio.js',
    'public/js/side-cards.js',
    'public/js/messages.js',
    'public/css/user-card.css',
    'public/css/reservation.css',
    'public/css/520.css',
    'public/css/style.css',
    'public/css/mobile-fix.css',
    'public/css/variables.css',
    'public/css/base.css',
    'public/css/animations.css',
    'public/css/responsive.css',
    'public/css/performance.css',
    'public/css/messages.css',
    'public/sitemap.xml',
    'public/robots.txt',
    'views/index.html',
    'views/profile.html',
    'views/post-detail.html',
    'views/radio.html',
    'views/feedback.html',
    'views/login.html',
    'views/register.html',
    'views/new-post.html',
    'views/agreement.html',
    'views/privacy.html',
    'views/messages.html',
    'views/admin/index.html',
    'views/admin/mp-draft.html',
    'auto-publish.js',
    'config/auto-publish.json'
];

// 增量上传：只上传最近修改的文件（默认最近1小时内修改的）
// 用法：node upload.js                    // 增量上传（最近1小时）
//       node upload.js --all              // 全量上传所有文件
//       node upload.js --hours 24         // 上传最近24小时修改的文件
//       node upload.js server.js views/index.html  // 只上传指定文件

function getFilesToUpload() {
    const args = process.argv.slice(2);
    
    // 全量上传
    if (args.includes('--all')) {
        console.log('📦 全量上传模式：将上传所有文件\n');
        return ALL_FILES;
    }
    
    // 指定文件上传
    if (args.length > 0 && !args[0].startsWith('--')) {
        console.log('📄 指定文件模式：将上传以下文件\n');
        return args;
    }
    
    // 增量上传：获取修改时间
    const hours = args.includes('--hours') ? parseInt(args[args.indexOf('--hours') + 1]) || 1 : 1;
    const cutoffTime = Date.now() - (hours * 60 * 60 * 1000);
    
    const modifiedFiles = ALL_FILES.filter(file => {
        try {
            const stats = fs.statSync(path.join(__dirname, file));
            return stats.mtimeMs > cutoffTime;
        } catch (e) {
            return false;
        }
    });
    
    if (modifiedFiles.length === 0) {
        console.log(`⚠️  最近${hours}小时内没有修改的文件`);
        console.log('💡 提示：使用 node upload.js --all 全量上传');
        console.log('💡 提示：使用 node upload.js <文件名> 上传指定文件');
        process.exit(0);
    }
    
    console.log(`⚡ 增量上传模式：最近${hours}小时内修改了 ${modifiedFiles.length} 个文件\n`);
    return modifiedFiles;
}

const FILES = getFilesToUpload();

// 静态资源（仅首次部署或内容变更时取消注释执行）
// 'public/images/gzh.jpg',
// 'public/images/default-cover.png',
// 'public/favicon.png',

async function exec(conn, command) {
    return new Promise((resolve, reject) => {
        conn.exec(command, (err, stream) => {
            if (err) { reject(err); return; }
            let out = '';
            stream.on('close', () => resolve(out));
            stream.on('data', (data) => { out += data; });
            stream.stderr.on('data', (data) => { out += data; });
        });
    });
}

async function uploadFile(sftp, localPath, remotePath) {
    return new Promise((resolve, reject) => {
        sftp.fastPut(localPath, remotePath, (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

async function deploy() {
    let conn;
    try {
        console.log('Connecting...');
        conn = await new Promise((resolve, reject) => {
            const c = new Client();
            c.on('ready', () => resolve(c));
            c.on('error', reject);
            c.connect(SERVER);
        });

        const sftp = await new Promise((resolve, reject) => {
            conn.sftp((err, s) => {
                if (err) reject(err);
                else resolve(s);
            });
        });

        for (const file of FILES) {
            console.log('Uploading ' + file + '...');
            await uploadFile(sftp, file, REMOTE_BASE + '/' + file);
            console.log('OK!');
        }

        console.log('Installing dependencies...');
        await exec(conn, 'cd ' + REMOTE_BASE + ' && npm install qrcode');
        console.log('Setting env vars...');
        var envStr = Object.keys(ENV_VARS).map(function(k) { return k + '=' + ENV_VARS[k]; }).join(' ');
        if (envStr) {
            await exec(conn, 'cd ' + REMOTE_BASE + ' && echo "' + Object.keys(ENV_VARS).map(function(k) { return 'export ' + k + '=' + ENV_VARS[k]; }).join('\n') + '" >> ~/.bashrc');
            console.log('Env vars set in .bashrc');
        }
        var pm2Cmd = envStr ? envStr + ' pm2 start server.js --name campus-wall' : 'pm2 start server.js --name campus-wall';
        await exec(conn, 'cd ' + REMOTE_BASE + ' && pm2 delete campus-wall -s 2>/dev/null; fuser -k 3000/tcp 2>/dev/null; sleep 2; ' + pm2Cmd);
        console.log('Restarting PM2 (force)...');
        console.log('Waiting 3 seconds...');
        await new Promise(resolve => setTimeout(resolve, 3000));

    // 运行数据库修复脚本（点歌投票功能）
    console.log('Running fix-song-tables.js...');
    try {
      await exec(conn, 'cd ' + REMOTE_BASE + ' && node fix-song-tables.js');
      console.log('✅ 点歌投票表修复成功');
    } catch (e) {
      console.log('⚠️ 点歌投票表修复失败或已存在:', e.message);
    }
    // 清理服务器上的测试脚本和日志
    console.log('Cleaning up test scripts and logs on server...');
    await exec(conn, 'cd ' + REMOTE_BASE + ' && rm -f init-email-history.js fix-old-ip.js fix-song-tables.js server.log');
    await exec(conn, 'pm2 flush campus-wall');
    console.log('Cleanup done!');

        const status = await exec(conn, 'pm2 list');
        console.log(status);

        const logs = await exec(conn, 'pm2 logs campus-wall --lines 10 --nostream');
        console.log(logs);

        console.log('Done!');
        conn.end();
    } catch (error) {
        console.error('Error:', error.message);
        if (conn) conn.end();
        process.exit(1);
    }
}

deploy();
