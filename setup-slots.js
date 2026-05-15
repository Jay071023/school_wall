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

        console.log('\n1. 删除旧时段表（如果存在）...');
        try {
            await exec(conn, 'mysql -uwall1023 -pwall1023 wall1023 -e "DROP TABLE IF EXISTS time_slots;"');
            console.log('✅ 删除旧表');
        } catch (e) {}

        console.log('\n2. 创建时段表...');
        const create1 = `CREATE TABLE time_slots (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(100) NOT NULL COMMENT '时段名称',
            start_time TIME NOT NULL COMMENT '开始时间',
            end_time TIME NOT NULL COMMENT '结束时间',
            is_active TINYINT(1) DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`;
        await exec(conn, `mysql -uwall1023 -pwall1023 wall1023 -e "${create1.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`);
        console.log('✅ time_slots表创建成功');

        console.log('\n3. 创建时段日期表...');
        const create2 = `CREATE TABLE slot_dates (
            id INT AUTO_INCREMENT PRIMARY KEY,
            slot_id INT NOT NULL COMMENT '时段ID',
            play_date DATE NOT NULL COMMENT '播放日期',
            max_songs INT DEFAULT 10 COMMENT '最大歌曲数',
            is_active TINYINT(1) DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY unique_slot_date (slot_id, play_date),
            FOREIGN KEY (slot_id) REFERENCES time_slots(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`;
        await exec(conn, `mysql -uwall1023 -pwall1023 wall1023 -e "${create2.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`);
        console.log('✅ slot_dates表创建成功');

        console.log('\n4. 插入默认时段...');
        const insert1 = `INSERT INTO time_slots (name, start_time, end_time) VALUES
            ('早上点歌', '07:00:00', '08:00:00'),
            ('上午点歌', '09:00:00', '10:00:00'),
            ('午间点歌', '11:00:00', '12:00:00'),
            ('下午点歌', '14:00:00', '15:00:00'),
            ('傍晚点歌', '17:00:00', '18:00:00'),
            ('晚间点歌', '19:00:00', '20:00:00'),
            ('夜间点歌', '21:00:00', '22:00:00');`;
        await exec(conn, `mysql -uwall1023 -pwall1023 wall1023 -e "${insert1.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`);
        console.log('✅ 默认时段插入成功');

        console.log('\n5. 为每个时段插入未来第7~35天的日期（与API查询范围对齐）...');
        for (let i = 7; i < 35; i++) {
            const date = new Date();
            date.setDate(date.getDate() + i);
            const dateStr = date.toISOString().split('T')[0];
            await exec(conn, `mysql -uwall1023 -pwall1023 wall1023 -e "INSERT INTO slot_dates (slot_id, play_date, max_songs) SELECT id, '${dateStr}', 10 FROM time_slots ON DUPLICATE KEY UPDATE max_songs=10;"`);
        }
        console.log('✅ 未来第7~35天的日期插入成功');

        // 删除已过期的日期（今天及之前的）
        const todayStr = new Date().toISOString().split('T')[0];
        await exec(conn, `mysql -uwall1023 -pwall1023 wall1023 -e "DELETE FROM slot_dates WHERE play_date <= '${todayStr}';"`);
        console.log('✅ 已清理过期日期');

        console.log('\n6. 查看数据...');
        const slots = await exec(conn, 'mysql -uwall1023 -pwall1023 wall1023 -e "SELECT sd.*, ts.name as slot_name, ts.start_time, ts.end_time FROM slot_dates sd JOIN time_slots ts ON sd.slot_id = ts.id ORDER BY sd.play_date, ts.start_time LIMIT 20;"');
        console.log(slots);

        conn.end();
        console.log('\n✅ 完成！');
    } catch (error) {
        console.error('Error:', error.message);
        if (conn) conn.end();
        process.exit(1);
    }
}

setup();