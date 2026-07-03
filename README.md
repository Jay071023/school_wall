# 🏫 嘉二校园墙

嘉定二中校园墙后端服务，基于 Node.js + Express + MySQL。

## 快速开始

```bash
npm install
npm start
```

访问 http://localhost:3001

## 项目结构

```
├── server.js          # 入口文件
├── routes/            # 路由
│   ├── admin.js      # 管理后台 API
│   ├── mp-draft.js   # 公众号素材
│   └── ...
├── services/         # 业务逻辑
│   ├── mp-draft.js   # 公众号同步
│   ├── wechat.js     # 微信登录
│   └── ...
├── views/            # 前端页面
├── public/           # 静态资源
└── config/           # 配置文件
```

## 主要功能

- 📝 帖子发布 / 审核 / 评论
- 🎵 校园点歌系统
- 📱 公众号素材同步推送
- 🔐 JWT 鉴权 + 微信登录
- 📊 数据统计

## 部署

```bash
# 安装依赖
npm install

# 启动服务
npm start

# systemd 守护（Linux）
sudo cp wall.service /etc/systemd/system/
sudo systemctl enable wall
sudo systemctl start wall
```

## 环境变量

`.env` 文件：
```
PORT=3001
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=xxx
DB_NAME=wall
JWT_SECRET=xxx
WECHAT_APPID=xxx
WECHAT_SECRET=xxx
```

## API 文档

| 接口 | 说明 |
|------|------|
| `POST /api/auth/login` | 登录 |
| `GET /api/posts` | 获取帖子列表 |
| `POST /api/posts` | 发布帖子 |
| `POST /api/mp/sync-draft` | 同步到公众号 |

## 技术栈

Node.js 16 + Express + MySQL + JWT + 微信公众号 API
