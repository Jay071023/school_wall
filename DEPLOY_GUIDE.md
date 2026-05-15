# 嘉二の墙墙 - 部署指南

## 服务器信息

```
主机: 152.32.226.134
端口: 22
用户: root
SSH密钥: 项目根目录下的 ssh_key 文件
项目路径: /www/wwwroot/wall.jay23.cn/campus-wall
```

## 使用 SSH2 连接服务器

```javascript
const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

const SERVER = {
    host: '152.32.226.134',
    port: 22,
    username: 'root',
    privateKey: fs.readFileSync('ssh_key')  // 项目根目录的ssh_key文件
};

const PROJECT_PATH = '/www/wwwroot/wall.jay23.cn/campus-wall';

// 上传文件
function uploadFile(conn, localPath, remotePath) {
    return new Promise((resolve, reject) => {
        conn.sftp((err, sftp) => {
            if (err) { reject(err); return; }
            sftp.fastPut(localPath, remotePath, (err) => {
                if (err) { reject(err); } else { resolve(); }
            });
        });
    });
}
```

## 部署命令

```bash
# 重启服务
pm2 restart campus-wall

# 查看日志
pm2 logs campus-wall
```

## ⚠️ 重要提醒

### 不要覆盖以下文件和目录

```
❌ public/uploads/          ← 用户上传的图片、头像
❌ 数据库文件                ← 数据都在MySQL数据库中
❌ node_modules/            ← 依赖已安装在服务器
```

### 只会更新的目录

```
✅ public/js/         ← JS代码
✅ public/css/       ← CSS样式
✅ views/            ← HTML页面
✅ routes/           ← 后端路由
✅ config/           ← 配置文件
✅ server.js         ← 主程序
✅ middleware/       ← 中间件
```

## 部署原则

1. **只上传代码文件**（.js, .css, .html, .json 等）
2. **不要上传 uploads 文件夹**
3. **不要覆盖 node_modules**
4. 修改完成后执行 `pm2 restart campus-wall`

## 项目结构

```
campus-wall/
├── config/
│   └── database.js          ← 数据库配置
├── middleware/
│   └── auth.js              ← 认证中间件
├── public/
│   ├── css/
│   │   └── style.css        ← 样式文件
│   ├── js/
│   │   ├── app.js           ← 公共模块
│   │   ├── home.js          ← 首页
│   │   ├── detail.js        ← 帖子详情
│   │   ├── post.js          ← 发布帖子
│   │   ├── radio.js         ← 点歌功能
│   │   └── profile.js       ← 个人中心
│   └── uploads/             ← ⚠️ 不要覆盖！用户上传文件
├── routes/
│   ├── admin.js             ← 管理后台
│   ├── auth.js              ← 登录注册
│   ├── posts.js             ← 帖子相关
│   ├── songs.js             ← 点歌相关
│   └── upload.js            ← 上传功能
├── views/
│   ├── index.html           ← 首页
│   ├── login.html           ← 登录页
│   ├── radio.html           ← 点歌页
│   └── ...                  ← 其他页面
├── server.js                ← 主程序
└── package.json             ← 依赖配置
```

## PM2 管理

```bash
# 查看进程状态
pm2 status

# 查看日志
pm2 logs campus-wall

# 重启
pm2 restart campus-wall

# 停止
pm2 stop campus-wall
```