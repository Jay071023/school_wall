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

async function setup() {
    try {
        console.log('Connecting...');
        conn = await new Promise((resolve, reject) => {
            const c = new Client();
            c.on('ready', () => resolve(c));
            c.on('error', reject);
            c.connect(SERVER);
        });

        console.log('修改song_requests表添加slot_date_id字段...');
        try {
            await exec(conn, 'mysql -uwall1023 -pwall1023 wall1023 -e "ALTER TABLE song_requests ADD COLUMN slot_date_id INT DEFAULT NULL AFTER slot_id;"');
            console.log('✅ 添加字段成功');
        } catch (e) {
            if (e.message.includes('Duplicate')) console.log('字段已存在');
            else console.log('字段添加:', e.message.split('\n').pop());
        }

        conn.end();
        console.log('\n✅ 完成！');
    } catch (error) {
        console.error('Error:', error.message);
        if (conn) conn.end();
        process.exit(1);
    }
}

setup();