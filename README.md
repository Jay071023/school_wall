# 校墙 (School Wall)

校墙是一个基于 Node.js 的校园社交平台后端项目，提供帖子发布、用户管理、消息通知等功能。

## 技术栈

- **后端**: Node.js, Express
- **数据库**: MySQL (通过 Sequelize 或类似 ORM)
- **前端**: Vue.js (管理后台), EJS/HTML (前台)
- **部署**: PM2, Nginx

## 功能特性

- 用户注册与登录
- 帖子发布与管理
- 消息通知系统
- 微信公众号集成
- 后台管理系统

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境

复制 `.env.example` 为 `.env` 并填写数据库及密钥信息：

```bash
cp .env.example .env
```

### 3. 启动服务

```bash
npm start
# 或者使用 PM2
pm2 start server.js
```

## 项目结构

```
── routes/          # API 路由
├── models/          # 数据模型
── services/        # 业务逻辑
├── middleware/      # 中间件
├── public/          # 静态资源
├── views/           # 页面模板
└── config/          # 配置文件
```

## 许可证

MIT
