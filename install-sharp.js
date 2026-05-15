const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

const SERVER = {
    host: '152.32.226.134',
    port: 22,
    username: 'root',
    privateKey: fs.readFileSync(path.join(__dirname, 'ssh_key_new'))
};

const PROJECT = '/www/wwwroot/wall.jay23.cn/campus-wall';

function exec(conn, command) {
    return new Promise((resolve, reject) => {
        conn.exec(command, (err, stream) => {
            if (err) { reject(err); return; }
            let out = '';
            stream.on('close', (code) => resolve({ code, out }));
            stream.on('data', (data) => { out += data; });
            stream.stderr.on('data', (data) => { out += data; });
        });
    });
}

async function installSharp() {
    let conn;
    try {
        console.log('Connecting to server...');
        conn = await new Promise((resolve, reject) => {
            const c = new Client();
            c.on('ready', () => resolve(c));
            c.on('error', reject);
            c.connect(SERVER);
        });
        console.log('✅ Connected\n');

        console.log('Installing sharp...');
        const result = await exec(conn, `cd ${PROJECT} && npm install sharp`);
        console.log(result.out);

        console.log('\nRestarting service...');
        const restart = await exec(conn, `cd ${PROJECT} && pm2 restart campus-wall`);
        console.log(restart.out);

        conn.end();
        console.log('✅ Done!');
    } catch (error) {
        console.error('❌ Error:', error.message);
        if (conn) conn.end();
    }
}

installSharp();
