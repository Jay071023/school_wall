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

async function addSlotReservation() {
    try {
        console.log('Connecting...');
        conn = await new Promise((resolve, reject) => {
            const c = new Client();
            c.on('ready', () => resolve(c));
            c.on('error', reject);
            c.connect(SERVER);
        });
        
        console.log('Adding slot reservation system to database...');
        
        // 创建预定时段表
        const result1 = await exec(conn, `mysql -u wall1023 -pwall1023 wall1023 -e "
        CREATE TABLE IF NOT EXISTS slot_reservations (
            id INT PRIMARY KEY AUTO_INCREMENT,
            user_id INT NOT NULL COMMENT '预定用户ID',
            slot_id INT NOT NULL COMMENT '时段ID',
            reservation_date DATE NOT NULL COMMENT '预定日期',
            status ENUM('pending', 'confirmed', 'cancelled') DEFAULT 'pending' COMMENT '预定状态',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY unique_reservation (user_id, slot_id, reservation_date),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (slot_id) REFERENCES song_slots(id) ON DELETE CASCADE,
            INDEX idx_reservation_date (reservation_date),
            INDEX idx_status (status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='时段预定表';
        " 2>&1`);
        console.log('Slot reservations table created:', result1);
        
        console.log('Done! Slot reservation system added successfully.');
        conn.end();
    } catch (error) {
        console.error('Error:', error.message);
        if (conn) conn.end();
        process.exit(1);
    }
}

addSlotReservation();
