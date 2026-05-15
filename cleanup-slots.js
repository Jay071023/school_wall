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

async function cleanup() {
    try {
        console.log('Connecting...');
        conn = await new Promise((resolve, reject) => {
            const c = new Client();
            c.on('ready', () => resolve(c));
            c.on('error', reject);
            c.connect(SERVER);
        });

        console.log('\n1. 清空slot_dates表...');
        await exec(conn, 'mysql -uwall1023 -pwall1023 wall1023 -e "DELETE FROM slot_dates;"');
        console.log('✅ slot_dates已清空');

        console.log('\n2. 清空time_slots表...');
        await exec(conn, 'mysql -uwall1023 -pwall1023 wall1023 -e "DELETE FROM time_slots;"');
        console.log('✅ time_slots已清空');

        console.log('\n3. 重置自增ID...');
        await exec(conn, 'mysql -uwall1023 -pwall1023 wall1023 -e "ALTER TABLE slot_dates AUTO_INCREMENT = 1; ALTER TABLE time_slots AUTO_INCREMENT = 1;"');
        console.log('✅ 自增ID已重置');

        console.log('\n4. 查看当前数据...');
        const slots = await exec(conn, 'mysql -uwall1023 -pwall1023 wall1023 -e "SELECT * FROM time_slots;"');
        console.log('time_slots:', slots || '(空)');
        const dates = await exec(conn, 'mysql -uwall1023 -pwall1023 wall1023 -e "SELECT * FROM slot_dates;"');
        console.log('slot_dates:', dates || '(空)');

        conn.end();
        console.log('\n✅ 完成！');
    } catch (error) {
        console.error('Error:', error.message);
        if (conn) conn.end();
        process.exit(1);
    }
}

cleanup();
