# 🏫 校墙 (School Wall)

> 一个现代化的校园社交平台，连接每一位同学的校园生活。

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D14.0.0-brightgreen)
![Express](https://img.shields.io/badge/express-4.x-lightgrey)
![Vue](https://img.shields.io/badge/vue-3.x-4FC08D)

---

## 📖 目录

- [项目简介](#项目简介)
- [功能特性](#功能特性)
- [技术栈](#技术栈)
- [项目结构](#项目结构)
- [快速开始](#快速开始)
- [API 文档](#api-文档)
- [部署指南](#部署指南)
- [常见问题](#常见问题)
- [贡献指南](#贡献指南)
- [许可证](#许可证)

---

##  项目简介

校墙是一个专为校园设计的社交平台，提供匿名发帖、消息互动、活动预约等功能。项目采用前后端分离架构，支持微信公众号集成，为用户提供便捷的校园信息交流渠道。

---

## ✨ 功能特性

### 核心功能
- 👤 **用户系统**：注册、登录、个人资料管理
- 📝 **帖子管理**：发布、编辑、删除帖子，支持图片上传
-  **消息通知**：实时消息推送、系统通知
- 🔍 **搜索功能**：全文搜索、标签筛选
- 📊 **数据统计**：热门文章、用户活跃度分析

### 高级功能
- 📱 **微信公众号集成**：自动推送、素材管理
-  **活动预约**：场地预约、活动报名
- 🎵 **点歌系统**：在线点歌、投票排行
-  **意见反馈**：用户反馈收集与处理
- 🔐 **权限管理**：角色分级、访问控制

---

## 🛠 技术栈

| 类别 | 技术 |
|------|------|
| **后端** | Node.js, Express.js |
| **数据库** | MySQL, Sequelize ORM |
| **前端** | Vue.js 3, Element Plus |
| **模板引擎** | EJS |
| **认证** | JWT, bcrypt |
| **文件上传** | Multer, Sharp |
| **部署** | PM2, Nginx |
| **其他** | 微信公众号 API, 邮件服务 |

---

## 📁 项目结构

```
school_wall/
├── config/              # 配置文件
│   ├── database.js      # 数据库配置
│   ── stories/         # 故事配置
── middleware/          # 中间件
│   └── auth.js          # 认证中间件
├── models/              # 数据模型
├── routes/              # API 路由
│   ├── admin.js         # 管理后台路由
│   ├── auth.js          # 认证路由
│   ├── posts.js         # 帖子路由
│   └── wechat.js        # 微信路由
├── services/            # 业务逻辑
│   ├── ai.js            # AI 服务
│   ├── email.js         # 邮件服务
│   └── wechat.js        # 微信服务
├── public/              # 静态资源
│   ├── css/             # 样式文件
│   ├── js/              # 前端脚本
│   └── uploads/         # 上传文件
├── views/               # 页面模板
│   ├── admin/           # 管理后台
│   └── *.html           # 前台页面
── .env.example         # 环境变量示例
├── server.js            # 入口文件
└── package.json         # 项目配置
```

---

## 🚀 快速开始

### 环境要求
- Node.js >= 14.0.0
- MySQL >= 5.7
- npm >= 6.0.0

### 1. 克隆项目
```bash
git clone https://github.com/Jay071023/school_wall.git
cd school_wall
```

### 2. 安装依赖
```bash
npm install
```

### 3. 配置环境变量
```bash
cp .env.example .env
```
编辑 `.env` 文件，填写数据库连接信息、JWT 密钥等配置。

### 4. 初始化数据库
```bash
# 确保 MySQL 服务已启动
# 创建数据库并运行迁移（如有）
```

### 5. 启动服务
```bash
# 开发模式
npm run dev

# 生产模式
npm start

# 使用 PM2（推荐）
pm2 start server.js --name school_wall
```

访问 `http://localhost:3000` 查看应用。

---

## 📚 API 文档

### 认证相关
| 方法 | 路径 | 描述 |
|------|------|------|
| POST | `/api/auth/register` | 用户注册 |
| POST | `/api/auth/login` | 用户登录 |
| GET | `/api/auth/profile` | 获取用户信息 |

### 帖子相关
| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/posts` | 获取帖子列表 |
| POST | `/api/posts` | 创建帖子 |
| PUT | `/api/posts/:id` | 更新帖子 |
| DELETE | `/api/posts/:id` | 删除帖子 |

### 管理后台
| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/admin/users` | 用户管理 |
| GET | `/api/admin/posts` | 帖子审核 |
| POST | `/api/admin/publish` | 公众号发布 |

---

## 🌐 部署指南

### 服务器要求
- Ubuntu 20.04+ / CentOS 7+
- 1GB+ RAM
- Nginx
- PM2

### 部署步骤
1. 上传代码到服务器
2. 安装依赖：`npm install --production`
3. 配置环境变量
4. 使用 PM2 启动：`pm2 start server.js`
5. 配置 Nginx 反向代理

详细部署说明请参考 [DEPLOY.md](DEPLOY.md)

---

##  常见问题

### Q: 如何修改端口？
A: 在 `.env` 文件中设置 `PORT=3000` 或修改 `server.js`。

### Q: 上传文件失败？
A: 检查 `public/uploads/` 目录权限，确保有写入权限。

### Q: 微信公众号配置？
A: 参考 [公众号素材管理说明.md](公众号素材管理说明.md)

---

## 🤝 贡献指南

欢迎提交 Issue 和 Pull Request！

1. Fork 本项目
2. 创建功能分支：`git checkout -b feature/xxx`
3. 提交更改：`git commit -m 'Add xxx'`
4. 推送分支：`git push origin feature/xxx`
5. 提交 Pull Request

---

## 📄 许可证

本项目采用 MIT 许可证 - 查看 [LICENSE](LICENSE) 文件了解详情。

---

## 📞 联系方式

- 作者：Jay071023
- 邮箱：jay071023@example.com
- 项目地址：https://github.com/Jay071023/school_wall

---

<p align="center">Made with ❤️ for Campus Life</p>
