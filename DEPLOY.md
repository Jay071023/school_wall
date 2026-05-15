# 嘉二の墙墙网站 + 广播站点歌系统 部署指南

## 📦 项目结构

```
campus-wall/
├── server.js              # 主服务器入口
├── package.json           # 项目依赖
├── .env.example           # 环境变量模板
├── config/
│   └── database.js        # 数据库配置和初始化
├── middleware/
│   └── auth.js            # JWT认证中间件
├── routes/
│   ├── auth.js            # 用户认证API
│   ├── posts.js           # 帖子API
│   ├── songs.js           # 点歌API
│   ├── admin.js           # 管理后台API
│   └── upload.js          # 文件上传API
├── views/                 # 前端页面
│   ├── index.html         # 首页
│   ├── login.html         # 登录页
│   ├── register.html      # 注册页
│   ├── new-post.html      # 发帖页
│   ├── post-detail.html   # 帖子详情页
│   ├── profile.html       # 个人主页
│   ├── radio.html         # 广播点歌页
│   ├── 404.html           # 404页面
│   └── admin/
│       └── index.html     # 管理后台
└── public/
    ├── css/
    │   └── style.css      # 全局样式
    ├── js/
    │   ├── app.js         # 公共模块
    │   ├── auth.js        # 登录注册
    │   ├── home.js        # 首页
    │   ├── post.js        # 发帖
    │   ├── detail.js      # 帖子详情
    │   ├── profile.js     # 个人主页
    │   └── radio.js       # 广播点歌
    └── uploads/
        ├── posts/         # 帖子图片
        └── avatars/       # 用户头像
```

## 🚀 宝塔面板部署步骤

### 1. 准备工作
- 宝塔面板已安装 Node.js 管理器
- 已创建 MySQL 数据库

### 2. 上传项目
将 `campus-wall` 文件夹上传到网站根目录（如 `/www/wwwroot/campus-wall/`）

### 3. 安装依赖
通过宝塔终端或SSH执行：
```bash
cd /www/wwwroot/campus-wall
npm install
```

### 4. 配置环境变量
```bash
cp .env.example .env
```
编辑 `.env` 文件，修改以下配置：
```env
# 数据库配置（填写你的MySQL信息）
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=你的数据库密码
DB_NAME=campus_wall

# JWT密钥（请修改为随机字符串）
JWT_SECRET=你的随机密钥

# 管理员初始账号
ADMIN_USERNAME=admin
ADMIN_PASSWORD=你的管理员密码

# 学校名称
SCHOOL_NAME=你的大学名称

# 端口
PORT=3000
```

### 5. 创建MySQL数据库
在宝塔面板 → 数据库 → 添加数据库：
- 数据库名：`campus_wall`
- 用户名：与 .env 中的 DB_USER 一致
- 密码：与 .env 中的 DB_PASSWORD 一致
- 字符集：utf8mb4

> 注意：不需要手动建表，程序启动时会自动创建所有表

### 6. 启动项目
```bash
cd /www/wwwroot/campus-wall
node server.js
```

看到以下输出表示启动成功：
```
🎉 嘉二の墙墙网站启动成功！
📡 访问地址: http://localhost:3000
🔧 管理后台: http://localhost:3000/admin
👤 默认管理员: admin / admin123
```

### 7. 配置反向代理（宝塔）
1. 宝塔面板 → 网站 → 添加站点
2. 设置域名（如 wall.yourschool.edu.cn）
3. 网站设置 → 反向代理 → 添加反向代理
   - 目标URL：`http://127.0.0.1:3000`
   - 发送域名：`$host`
4. 开启SSL（可选）

### 8. 配置PM2守护进程（推荐）
```bash
npm install -g pm2
cd /www/wwwroot/campus-wall
pm2 start server.js --name campus-wall
pm2 save
pm2 startup
```

## 🔧 功能说明

### 前台功能
| 功能 | 说明 |
|------|------|
| 用户注册登录 | 用户名+密码注册，JWT认证 |
| 发帖 | 支持文字+图片（最多9张），可选匿名 |
| 分类 | 日常/表白/求助/二手/社团/其他 |
| 评论 | 支持匿名评论 |
| 点赞/收藏 | 一键点赞收藏 |
| 广播点歌 | 在管理员设置的时段内提交点歌 |
| 个人主页 | 查看我的帖子/收藏/点歌记录 |

### 管理后台功能
| 功能 | 说明 |
|------|------|
| 数据概览 | 用户数、帖子数、今日数据统计 |
| 帖子管理 | 审核/删除帖子 |
| 用户管理 | 启用/禁用用户 |
| 点歌管理 | 审核/管理点歌请求 |
| 时段设置 | 设置可点歌的时间段 |

### 默认管理员
- 用户名：`admin`（可在.env中修改）
- 密码：`admin123`（可在.env中修改）
- 管理后台地址：`http://你的域名/admin`

## ⚠️ 注意事项

1. **首次启动**会自动创建数据库表和默认管理员账号
2. **上传目录** `public/uploads/` 需要有写入权限
3. **生产环境**请务必修改 JWT_SECRET 和管理员密码
4. **图片存储**默认本地存储，如需云存储请配置 .env 中的 OSS 相关参数
5. 建议使用 **PM2** 或 **systemd** 管理进程，保证服务稳定运行
