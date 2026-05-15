# 🏫 校墙 (School Wall)

> 一个功能完善的现代化校园社交平台，连接每一位同学的校园生活。

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D14.0.0-brightgreen)
![Express](https://img.shields.io/badge/express-4.x-lightgrey)
![Vue](https://img.shields.io/badge/vue-3.x-4FC08D)

---

## 📖 目录

- [项目简介](#项目简介)
- [✨ 核心功能详解](#-核心功能详解)
- [🛠 技术栈](#-技术栈)
- [📁 项目结构](#-项目结构)
- [🚀 快速开始](#-快速开始)
- [📚 API 接口说明](#-api-接口说明)
- [🌐 部署指南](#-部署指南)
- [📞 联系方式](#-联系方式)

---

## 📖 项目简介

校墙是一个专为高校设计的综合性社交平台，旨在打破信息壁垒，提供安全、便捷的校园信息交流渠道。项目涵盖了**匿名社交、广播点歌、场地预约、公众号管理**等多个核心场景，采用前后端分离架构，支持微信公众号深度集成。

---

## ✨ 核心功能详解

### 📝 1. 校园墙 (Social Wall)
- **匿名/实名发帖**：支持纯文本、图文混排，用户可选择匿名发布保护隐私。
- **互动社区**：点赞、评论、举报功能，营造健康的社区氛围。
- **内容审核**：后台自动/人工审核机制，过滤敏感内容。
- **热门榜单**：基于算法的热门帖子推荐，展示校园热点。

### 🎵 2. 广播点歌台 (Radio & Songs)
- **在线点歌**：用户可在线提交点歌申请，填写歌曲名、歌手及寄语。
- **投票排行**：支持对点歌进行投票，票数高的歌曲优先播放。
- **时段预约**：支持预约特定的广播时段，避免冲突。
- **播放记录**：自动记录已播放歌曲，防止重复。

###  3. 场地与活动预约 (Reservations)
- **时段管理**：管理员可设置可预约的时间段（Slots）。
- **冲突检测**：系统自动检测时间冲突，防止重复预约。
- **预约审核**：支持自动通过或人工审核预约申请。
- **状态通知**：预约成功/失败通过系统消息或邮件通知用户。

### 📱 4. 微信公众号集成 (WeChat Integration)
- **素材管理**：后台直接管理公众号图文素材。
- **草稿箱同步**：支持将平台内容一键同步至公众号草稿箱。
- **自动发布**：配置定时任务，实现内容自动推送。
- **粉丝互动**：通过微信接口接收用户消息和反馈。

### 🛡 5. 用户与权限系统 (User & Auth)
- **多角色管理**：支持普通用户、版主、管理员等多级权限。
- **个人资料**：自定义头像、昵称、个性签名。
- **消息中心**：系统通知、点赞提醒、评论回复实时推送。
- **安全认证**：JWT Token 认证，密码加密存储，防止 XSS/CSRF 攻击。

### 📊 6. 管理后台 (Admin Dashboard)
- **Vue 3 驱动**：基于 Vue 3 + Element Plus 构建的现代化管理界面。
- **数据看板**：用户增长、帖子数量、活跃度等数据可视化。
- **内容管理**：一键置顶、删除违规帖子、管理评论。
- **系统配置**：动态修改站点信息、公告、邮件服务配置。

---

## 🛠 技术栈

| 类别 | 技术 |
|------|------|
| **后端** | Node.js, Express.js |
| **数据库** | MySQL, Sequelize ORM |
| **前端** | Vue.js 3, Element Plus, EJS |
| **认证** | JWT, bcrypt |
| **文件处理** | Multer (上传), Sharp (图片压缩) |
| **部署** | PM2, Nginx |
| **第三方** | 微信公众号 API, SMTP 邮件服务 |

---

## 📁 项目结构

```
school_wall/
├── config/              # 配置文件
│   ├── database.js      # 数据库连接配置
│   └── stories/         # 故事/内容配置
├── middleware/          # 中间件
│   └── auth.js          # 权限验证中间件
├── models/              # 数据库模型定义
├── routes/              # API 路由
│   ├── admin.js         # 管理后台接口
│   ├── auth.js          # 登录注册接口
│   ├── posts.js         # 帖子相关接口
│   ├── songs.js         # 点歌系统接口
│   ├── reservations.js  # 预约系统接口
│   └── wechat.js        # 微信接口
├── services/            # 核心业务逻辑
│   ├── ai.js            # AI 辅助服务
│   ├── email.js         # 邮件发送服务
│   ── wechat.js        # 微信 API 封装
├── public/              # 静态资源
│   ├── admin-vue/       # Vue 后台构建产物
│   ├── css/             # 样式文件
│   ├── js/              # 前端交互脚本
│   └── uploads/         # 用户上传文件
── views/               # EJS 模板页面
│   ├── admin/           # 后台管理页面
│   └── *.html           # 前台页面
├── .env.example         # 环境变量模板
├── server.js            # 程序入口
└── package.json         # 项目依赖
```

---

## 🚀 快速开始

### 1. 环境准备
- Node.js >= 14.0.0
- MySQL >= 5.7

### 2. 安装与配置
```bash
# 克隆项目
git clone https://github.com/Jay071023/school_wall.git
cd school_wall

# 安装依赖
npm install

# 复制环境变量
cp .env.example .env
# 编辑 .env 填写数据库密码、JWT 密钥等信息
```

### 3. 启动服务
```bash
# 开发模式
npm start

# 生产模式 (推荐)
pm2 start server.js --name school_wall
```

---

## 📚 API 接口说明

### 认证模块
- `POST /api/auth/register` - 用户注册
- `POST /api/auth/login` - 用户登录
- `GET /api/auth/profile` - 获取当前用户信息

### 帖子模块
- `GET /api/posts` - 获取帖子列表 (支持分页、筛选)
- `POST /api/posts` - 发布新帖子
- `PUT /api/posts/:id` - 编辑帖子
- `DELETE /api/posts/:id` - 删除帖子

### 点歌模块
- `GET /api/songs` - 获取点歌列表
- `POST /api/songs` - 提交点歌申请
- `POST /api/songs/:id/vote` - 投票

---

##  部署指南

详细部署步骤请参考 [DEPLOY.md](DEPLOY.md)。

**简要步骤：**
1. 配置 Nginx 反向代理到 `localhost:3000`。
2. 配置 SSL 证书 (HTTPS)。
3. 使用 PM2 守护进程。
4. 配置 MySQL 数据库并导入数据。

---

## 📞 联系方式

如有问题或建议，欢迎联系：

- **作者**: Jay071023
- **邮箱**: 邮箱@qq.com
- **GitHub**: https://github.com/Jay071023

---

<p align="center">Made with ❤️ for Campus Life</p>
