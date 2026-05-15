const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

const SERVER = {
    host: '152.32.226.134',
    port: 22,
    username: 'root',
    privateKey: fs.readFileSync(path.join(__dirname, 'ssh_key_new'))
};

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

let conn;

async function check() {
    try {
        console.log('Connecting...');
        conn = await new Promise((resolve, reject) => {
            const c = new Client();
            c.on('ready', () => resolve(c));
            c.on('error', reject);
            c.connect(SERVER);
        });

        console.log('\n在admin/index.html中搜索反馈相关代码...');
        const result = await exec(conn, 'grep -n "反馈" /www/wwwroot/wall.jay23.cn/campus-wall/views/admin/index.html');
        console.log(result);

        console.log('\n搜索sidebar-link...');
        const sidebarLinks = await exec(conn, 'grep -n "sidebar-link" /www/wwwroot/wall.jay23.cn/campus-wall/views/admin/index.html | tail -10');
        console.log(sidebarLinks);

        conn.end();
        console.log('\n检查完成！');
    } catch (error) {
        console.error('Error:', error.message);
        if (conn) conn.end();
        process.exit(1);
    }
}

check();
