# 🏫 校园墙 (Campus Wall)

> 一套面向中小学校/高校的轻量级校园社交平台开源自部署方案。
> 匿名树洞、广播点歌、场地预约、公众号管理——一站搞定。

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D14.0.0-brightgreen)
![MySQL](https://img.shields.io/badge/mysql-5.7%2B-blue)
![Express](https://img.shields.io/badge/express-4.x-lightgrey)

[演示站 / 截图] ｜ [Issues](https://github.com/Jay071023/school_wall/issues)

---

## ✨ 这是什么

一个**完整可跑通**的校园墙项目，作者本人高三期间在真实校园运行了1年。
如果你也是学生/老师，想给自己的学校搭一个"表白墙+点歌+树洞"集合体，可以直接 fork 走，改两个环境变量就能跑。

不是 SaaS，不是收费系统 —— 纯开源，**保留所有权利**。

## 🎯 功能特性

### 用户端
- 📝 **树洞 / 表白墙** — 匿名/实名发帖，点赞、评论、收藏
- 🎵 **广播点歌** — 点歌到校园广播站，含时段预约和投票
- 📅 **场地预约** — 教室/活动室预约系统
- 👤 **个人主页** — 头像、MBTI、爱好、生日
- 💬 **私信** — 用户间一对一聊天
- 🔔 **通知中心** — 评论/点赞/被点歌 实时推送
- 🔐 **微信绑定** — 公众号扫码登录 + 消息推送
- 📱 **PWA / 移动端适配** — 完美适配手机浏览器
- 🎲 **历史上的今天** / 🌤 **天气卡片** / 📜 **一言**

### 管理端
- 📊 **审核工作台** — 帖子/评论/点歌 待审核队列
- 🎨 **公众号推文生成器** — 12 套风格模板 + 4 套配色主题
- 📚 **连载小说** — 多小说管理、章节预览、AI 辅助写作
- 🤖 **AI 介绍词生成** — 自动抓取歌曲信息+歌词+AI 文案
- 📈 **数据统计** — 用户、帖子、评论、点歌 实时数据
- 🔧 **系统设置** — 站点配置、轮播图、分类、限流、敏感词

### 技术亮点
- 🚀 **Express + MySQL**，单进程可支撑 5k+ 日活
- 🔒 **完整鉴权**（JWT + 角色权限 + 操作日志）
- 🛡️ **限流/防刷**（登录/注册/上传 单独限流）
- 📦 **PM2 部署** + 上传脚本 + 一键热更新
- 🌍 **CORS/Helmet** 安全头完善

---

## 🚀 5分钟快速开始

### 1. 准备环境
- Node.js >= 14
- MySQL >= 5.7
- 一个域名（可选，没域名也能用 IP 访问）

### 2. 克隆项目
```bash
git clone https://github.com/Jay071023/school_wall.git
cd school_wall
npm install
```

### 3. 配置环境
```bash
cp .env.example .env
# 编辑 .env，至少填这三项：
#   DB_PASSWORD=你的MySQL密码
#   JWT_SECRET=随机32位字符串 (node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
#   SCHOOL_NAME=你的学校名
```

### 4. 初始化数据库
首次启动会自动建表。**默认管理员账号**：
- 用户名：`admin`
- 密码：`admin123456`（首次登录后请立即修改！）

```bash
npm start
```

打开 `http://localhost:3000` 试试。

---

## 📁 项目结构

```
school_wall/
├── server.js              # 主入口
├── config/                # 数据库连接 + 表结构迁移
├── routes/                # 路由（按业务模块拆分）
├── services/              # 业务服务层（AI / 微信 / 邮件 / IP）
├── middleware/            # 中间件（鉴权 / 限流）
├── views/                 # 模板（前台 + 后台）
├── public/                # 静态资源（CSS / JS / 图片 / 上传）
├── auto-publish.js        # 定时任务（连载小说自动发布）
├── upload.js              # 部署脚本（SSH 到服务器热更新）
├── package.json
└── .env.example
```

---

## 🔧 进阶配置

### 微信公众号集成
1. 申请 [微信公众平台](https://mp.weixin.qq.com) 服务号
2. 在 `.env` 填入 `WECHAT_APPID` / `WECHAT_SECRET` 等
3. 后台 → 公众号管理 → 绑定

### AI 功能
支持 MiniMax（Anthropic 兼容）+ DeepSeek 任选其一。填入 `MINIMAX_API_KEY` 或 `DEEPSEEK_API_KEY` 即可。

### 部署到生产
推荐 PM2：
```bash
npm install -g pm2
pm2 start server.js --name campus-wall
pm2 save
pm2 startup
```

HTTPS 反代推荐 Nginx + Let's Encrypt。

详见 [DEPLOY.md](./DEPLOY.md)

---

## 🤝 二次开发

### 加新功能
- 新建 `routes/your-feature.js`
- 在 `server.js` 里 `app.use('/api/your-feature', require('./routes/your-feature'))`
- 前端在 `public/js/` 加对应 JS，模板在 `views/` 加 HTML

### 数据库迁移
所有建表语句在 `config/database.js` 的 `initDB()` 函数里，遵循"CREATE IF NOT EXISTS + ALTER ADD COLUMN"模式，新增字段直接追加即可。

### API 风格
- RESTful
- 鉴权：Header `Authorization: Bearer <token>`
- 响应：`{ code: 200, data: {...} }` 或 `{ code: 4xx, message: '...' }`
- 权限：`requirePermission('xxx:yyy')` 中间件

---

## 📜 License

MIT License — 商用/二开/转售 都欢迎，但请保留原作者版权。

详细见 [LICENSE](./LICENSE)

---

## 🙏 致谢

这个项目最初是为了解决"学校里大家想说但不敢说"的问题。
希望它能帮到其他有同样需求的学校。

如果用了这个项目觉得不错，给个 ⭐ Star 就是最大的支持。

---

## 📮 联系

- Issue: 任何问题/Bug/建议 欢迎 [提 Issue](https://github.com/Jay071023/school_wall/issues)
- Email: 你的邮箱
