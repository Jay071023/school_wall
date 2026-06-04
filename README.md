# 🏫 校墙 (School Wall)

> 一个功能完善的现代化校园社交平台，连接每一位同学的校园生活。

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D14.0.0-brightgreen)
![Express](https://img.shields.io/badge/express-4.x-lightgrey)

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
- **互动社区**：点赞、评论、回复、收藏功能，营造健康的社区氛围。
- **内容审核**：AI 智能辅助 + 人工审核机制，过滤敏感内容。
- **热门榜单**：基于算法的热门帖子推荐，展示校园热点。
- **QQ空间风格浏览量**：滚动可见即计数，1分钟内不重复记录。

### 🎵 2. 广播点歌台 (Radio & Songs)
- **在线点歌**：用户可在线提交点歌申请，填写歌曲名、歌手及寄语。
- **投票排行**：支持对点歌进行投票，票数高的歌曲优先播放。
- **时段预约**：支持预约特定的广播时段，避免冲突。
- **播放记录**：自动记录已播放歌曲，防止重复。

### 📱 3. 微信公众号集成 (WeChat Integration)
- **素材管理**：后台直接管理公众号图文素材。
- **草稿箱同步**：支持将平台内容一键同步至公众号草稿箱。
- **自动发布**：配置定时任务，实现内容自动推送。
- **粉丝互动**：通过微信接口接收用户消息和反馈。

### 🛡 4. 用户与权限系统 (User & Auth)
- **多角色管理**：普通用户、审核员、广播管理员、管理员、超级管理员多级权限。
- **个人资料**：自定义头像、昵称、生日、MBTI、兴趣爱好。
- **消息中心**：系统通知、点赞提醒、评论回复实时推送。
- **安全认证**：JWT Token 统一密钥、密码加密存储，防止 XSS/CSRF 攻击。

### 📊 5. 管理后台 (Admin Dashboard)
- **数据看板**：用户增长、帖子数量、活跃度、浏览量统计。
- **内容管理**：一键置顶、删除违规帖子、管理评论、用户状态管理。
- **系统配置**：动态修改站点信息、公告、邮件服务配置。

### 🏆 6. 打卡排行榜 (Check-in Leaderboard)
- **每日打卡**：用户每日签到积累连续打卡天数。
- **排行榜**：按连续天数、总打卡次数、等级多维度排行。
- **等级系统**：根据打卡次数自动升级，解锁不同称号。

---

## 🛠 技术栈

| 类别 | 技术 |
|------|------|
| **后端** | Node.js, Express.js |
| **数据库** | MySQL |
| **前端** | 原生 JavaScript, EJS 模板 |
| **认证** | JWT, bcrypt |
| **安全** | XSS 防护、SQL 白名单校验、passive event listener |
| **性能** | Compression 响应压缩、IntersectionObserver 浏览计数 |
| **文件处理** | Multer (上传) |
| **部署** | PM2, Nginx |
| **第三方** | 微信公众号 API, SMTP 邮件服务, AI 辅助审核 |

---

## 📁 项目结构

```
school_wall/
├── config/
│   ├── database.js      # 数据库连接配置
│   ├── jwt-secret.js     # JWT 统一密钥
│   └── auto-publish.json # 自动发布配置
├── middleware/
│   └── auth.js          # 权限验证中间件（多角色权限系统）
├── routes/
│   ├── admin.js         # 管理后台接口
│   ├── auth.js          # 登录注册接口
│   ├── posts.js         # 帖子相关接口
│   ├── songs.js         # 点歌系统接口
│   ├── checkin.js       # 打卡系统接口
│   ├── leaderboard.js   # 排行榜接口
│   ├── wechat.js        # 微信接口
│   └── mp-draft.js      # 公众号草稿箱接口
├── services/
│   ├── ai.js            # AI 辅助服务
│   ├── email.js         # 邮件发送服务
│   └── ip-lookup.js     # IP 归属地查询
├── public/
│   ├── css/
│   │   ├── style.css        # 主样式
│   │   ├── mobile-fix.css   # 移动端适配
│   │   ├── 520.css         # 520特殊模式
│   │   ├── variables.css    # CSS变量
│   │   ├── base.css        # 基础样式
│   │   └── animations.css  # 动画效果
│   ├── js/
│   │   ├── app.js           # 公共模块（含 escapeHtml 等工具函数）
│   │   ├── home.js          # 首页模块
│   │   ├── detail.js        # 帖子详情模块
│   │   ├── detail-emojis.js # 表情选择器
│   │   ├── detail-replies.js# 评论回复模块
│   │   ├── profile.js       # 个人中心模块
│   │   ├── radio.js         # 电台模块
│   │   └── messages.js      # 消息模块
│   └── uploads/             # 用户上传文件
├── views/                   # EJS 模板页面
├── server.js               # 程序入口
├── upload.js               # 服务器部署脚本
└── package.json            # 项目依赖
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
pm2 start server.js --name campus-wall
```

---

## 📚 API 接口说明

### 认证模块
- `POST /api/auth/register` - 用户注册（支持验证码防刷）
- `POST /api/auth/login` - 用户登录
- `GET /api/auth/profile` - 获取当前用户信息

### 帖子模块
- `GET /api/posts` - 获取帖子列表（支持分页、分类筛选、排序）
- `POST /api/posts` - 发布新帖子
- `POST /api/posts/:id/like` - 点赞/取消点赞
- `POST /api/posts/:id/favorite` - 收藏/取消收藏
- `POST /api/posts/:id/view` - 记录浏览量（QQ空间风格）
- `PUT /api/posts/:id` - 编辑帖子
- `DELETE /api/posts/:id` - 删除帖子

### 点歌模块
- `GET /api/songs` - 获取点歌列表
- `POST /api/songs` - 提交点歌申请
- `POST /api/songs/:id/vote` - 投票

### 管理模块
- `GET /api/admin/stats` - 数据概览（需管理员权限）
- `GET /api/admin/posts` - 帖子管理
- `PUT /api/admin/posts/:id/status` - 修改帖子状态

---

## 📋 更新日志

### v2.0.0 (2025-05-23)
**代码质量与安全**
- 新增 `config/jwt-secret.js` 统一 JWT 密钥，避免多模块独立生成导致 token 验证失败
- `server.js` 全局异常添加 `process.exit(1)` 交给 PM2 重启
- SQL ORDER BY 添加白名单校验，防止注入攻击
- 内存 Map 限制上限（captchaStore 1000条、likeDebounce 5000条），防止内存泄漏
- 数据库迁移错误添加日志输出

**性能优化**
- 新增 `compression` 响应压缩中间件，API 响应自动 gzip
- 滚动事件添加 `{ passive: true }`，消除浏览器 Violation 警告
- 清理全项目 `console.log` 调试日志

**前端优化**
- 公共函数集中到 `app.js`：`escapeHtml`、`showExternalLinkWarning`、`convertContentWithLinks`、`cacheLikeStatus`、`getCachedLikeStatus`
- 表情选择器改为 8 列网格布局（移动端 6 列），优化视觉效果
- 工具按钮改为圆形样式，hover 渐变背景
- 详情页/首页浏览量改为 QQ 空间风格（IntersectionObserver 可见即计数 + 1分钟去重）
- 删除 `home.js` 中被 alert 覆盖的 `showUserProfileModal` 死代码

**权限系统**
- `reviewer` 和 `radio_admin` 角色增加 `stats:view` 权限，可查看数据概览

---

## 部署指南

详细部署步骤请参考 [DEPLOY.md](DEPLOY.md)。

**简要步骤：**
1. 配置 Nginx 反向代理到 `localhost:3000`。
2. 配置 SSL 证书 (HTTPS)。
3. 使用 PM2 守护进程：`pm2 start server.js --name campus-wall`
4. 配置 MySQL 数据库并导入数据。
5. 运行 `node upload.js` 可一键部署到服务器

---

## 📞 联系方式

如有问题或建议，欢迎联系：

- **作者**: Jay071023
- **邮箱**: 2108474355@qq.com
- **GitHub**: https://github.com/Jay071023

---

<p align="center">Made with ❤️ for Campus Life</p>
