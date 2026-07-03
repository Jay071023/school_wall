# 🏫 嘉二校园墙

嘉定二中校园墙平台服务端，支持帖子、点歌、公众号推送等校园社交功能。

---

## 📌 功能介绍

### 帖子系统
- 用户发布帖子（支持 9 张图片）
- 分类标签：日常、表白、求助、二手、社团等
- 点赞、评论互动
- 管理员审核机制（通过/拒绝）
- IP 归属地记录

### 校园点歌
- 用户点歌、留言、匿名送歌
- 管理员排班播放时段
- 点歌审核与播放状态管理

### 公众号素材同步
- 一键生成精美图文卡片（天气、一言、热门帖子）
- 自动上传图片到微信 CDN
- 同步到公众号草稿箱
- 定时自动发布（可选）

### 管理后台
- 帖子/用户/点歌/评论管理
- 操作日志记录
- 数据统计面板
- 公告发布

### 其他功能
- 找回密码（邮箱验证）
- 微信扫码登录
- 高考倒计时
- 历史上的今天

---

## 🏗️ 技术架构

```
┌─────────────────────────────────────────────────────────┐
│                     Nginx 反向代理                       │
│                   (wall.jay23.cn)                       │
└───────────────────────┬─────────────────────────────────┘
                        │ Port 3001
┌───────────────────────▼─────────────────────────────────┐
│                   Node.js 16.20.2                       │
│                    Express.js                            │
├─────────────┬──────────────┬─────────────┬───────────────┤
│  routes/   │  services/   │  middleware/│    config/    │
│  · admin   │  · mp-draft │  · auth    │  · database  │
│  · posts   │  · wechat   │  · rateLimit│             │
│  · auth    │  · email    │             │              │
│  · mp-draft│  · ip-lookup│             │              │
│  · upload  │             │             │              │
├─────────────┴──────────────┴─────────────┴───────────────┤
│                      MySQL 3306                          │
└─────────────────────────────────────────────────────────┘
```

### 核心文件

| 目录 | 说明 |
|------|------|
| `server.js` | 入口，启动 Express 服务 |
| `routes/` | 路由层，处理 API 请求 |
| `services/` | 业务逻辑层 |
| `middleware/` | 中间件（鉴权、限流） |
| `views/` | 服务器渲染的 HTML 页面 |
| `public/` | 静态资源（CSS、JS、图片） |
| `config/` | 数据库配置 |

### 数据库表

- `users` - 用户
- `posts` - 帖子
- `comments` - 评论
- `song_requests` - 点歌
- `time_slots` - 播放时段
- `admin_logs` - 操作日志
- `wechat_reg_codes` - 微信注册码
- `daily_song_recs` - 每日推歌

---

## 🚀 安装部署

### 环境要求

- Node.js 16.x
- MySQL 5.7+
- Nginx
- CentOS/OpenCloudOS Linux

### 1. 克隆项目

```bash
git clone https://gitee.com/jay1023666/campus-wall.git
cd campus-wall
```

### 2. 安装依赖

```bash
npm install
```

### 3. 配置环境变量

创建 `.env` 文件：

```env
PORT=3001
HOST=0.0.0.0

# 数据库
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=你的数据库密码
DB_NAME=wall

# JWT 密钥
JWT_SECRET=随机字符串

# 微信公众号
WECHAT_APPID=wx开头的AppID
WECHAT_SECRET=公众号AppSecret

# 天气 API（可选，和风天气免费版）
WEATHER_API_KEY=你的API密钥
```

### 4. 创建数据库

```sql
CREATE DATABASE wall DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

### 5. 启动服务

**手动启动：**
```bash
npm start
```

**后台运行：**
```bash
nohup node server.js > logs/access.log 2>&1 &
```

### 6. 配置 Nginx 反向代理

```nginx
server {
    listen 80;
    server_name wall.jay23.cn;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

### 7. 配置 systemd 守护（推荐）

```bash
sudo cp wall.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable wall
sudo systemctl start wall
```

相关命令：
```bash
systemctl status wall    # 查看状态
systemctl restart wall   # 重启
systemctl stop wall      # 停止
journalctl -u wall -f   # 查看日志
```

---

## 📡 API 概览

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/auth/register` | 注册 |
| POST | `/api/auth/login` | 登录 |
| GET | `/api/posts` | 帖子列表 |
| POST | `/api/posts` | 发布帖子 |
| POST | `/api/posts/:id/like` | 点赞 |
| POST | `/api/mp/sync-draft` | 同步到公众号 |
| GET | `/api/mp/hot-posts` | 热门帖子 |

---

## 🔧 常用操作

**推送到 Gitee：**
```bash
./push.bat
```

**重启服务：**
```bash
systemctl restart wall
```

**查看日志：**
```bash
tail -f /www/wwwroot/wall.jay23.cn/campus-wall/logs/service.log
```

---

## 📄 License

MIT
