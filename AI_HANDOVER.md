# 嘉二校园墙 - AI 交接文档

## 项目概述

嘉定二中校园墙（wall.jay23.cn），Node.js + MySQL + nginx 架构。

## 技术栈

- **后端**: Node.js 16.20.2，Express 框架
- **数据库**: MySQL（127.0.0.1:3306）
- **服务器**: CentOS，IP: 124.222.255.33
- **前端**: 纯静态 HTML/CSS/JS，前后端分离

## 目录结构

```
campus-wall/           # 后端代码（服务器）/www/wwwroot/wall.jay23.cn/campus-wall/
├── server.js          # Express 入口
├── routes/            # 路由模块
│   ├── posts.js       # 帖子 CRUD + 评论 + 投票 + 点赞
│   ├── auth.js        # 登录注册
│   ├── admin.js       # 管理后台 API
│   └── ...
├── services/          # 业务逻辑
│   ├── email.js       # 邮件通知
│   ├── ai.js          # AI 对接（OpenCode）
│   └── ...
├── middleware/
│   └── auth.js        # JWT 鉴权 + RBAC
├── config/
│   └── database.js    # MySQL 连接池 + 建表
└── public/
    └── uploads/       # 用户上传文件

frontend/              # 前端静态文件（本地开发）
└── ...                # nginx 直接 serve

views/                 # 旧版页面（已废弃，由 frontend/ 替代）

node_wall.conf        # nginx 配置文件
```

## 服务器信息

- **SSH**: `ssh -i ~/.ssh/pcnt_server.key root@124.222.255.33`
- **后端目录**: `/www/wwwroot/wall.jay23.cn/campus-wall/`
- **前端目录**: `/www/wwwroot/wall.jay23.cn/frontend/`
- **systemd 服务**: `systemctl restart wall`

## 常用操作

### 重启服务
```bash
systemctl restart wall
systemctl status wall
journalctl -u wall -n 20
```

### 查看日志
```bash
tail -f /www/wwwroot/wall.jay23.cn/campus-wall/logs/service.log
```

### 部署前端（上传覆盖）
```bash
scp -r frontend/* root@124.222.255.33:/www/wwwroot/wall.jay23.cn/frontend/
```

### 部署后端（单个文件）
```bash
scp routes/posts.js root@124.222.255.33:/www/wwwroot/wall.jay23.cn/campus-wall/routes/
```

## 关键约束

1. **Node 版本**: 必须用 16.20.2，不支持 sharp（需要 ≥18.17）
2. **图片压缩**: 用 ImageMagick `/usr/bin/convert`，不用 sharp
3. **JWT**: 存 httpOnly Cookie，前端自动带
4. **前后端分离**: 前端和后端都有独立的静态文件目录，改 JS/CSS 两边都要同步

## 重要常量

### 分类值（前后端约定）
| 分类 | 值 | 说明 |
|------|-----|------|
| 日常 | `daily` | 英文，与后端一致 |
| 表白 | `confession` | |
| 投票 | `poll` | 用 `pollOptions` 判断，不依赖 category |
| ... | ... | |

### 判断投票帖
```js
// 不要用 category === '投票' 或 category === 'poll'
// 正确方式：
if (post.poll_type) { /* 是投票帖 */ }

// 创建/更新时：
if (pollOptions && Array.isArray(pollOptions) && pollOptions.length >= 2) {
  // 有投票选项
}
```

## 数据库表（投票相关）

```sql
-- poll_options: 投票选项
poll_options (id, post_id, option_text, votes_count, created_at)

-- poll_votes: 投票记录
poll_votes (id, option_id, user_id, created_at)
```

## AI 对接

使用 OpenCode API（OpenAI 兼容格式）：
- URL: `https://opencode.ai/go`
- Key: `sk-zZxyAwW64nl1ReQUmkcaLqgGYp6USIcYF01tGsjpdFD4Kld2QJdmMStDV7vHy8OR`
- Model: `deepseek-v4-flash`

## 权限系统

| 角色 | 说明 |
|------|------|
| `super_admin` | 超级管理员 |
| `admin` | 管理员 |
| `reviewer` | 审核员 |
| `radio_admin` | 电台管理员 |
| `user` | 普通用户 |

中间件: `auth`, `isStaff`, `adminOnly`, `requirePermission('xxx')`

## 注意事项

1. **前后端文件同步**: `frontend/` 和 `public/` 内容应保持一致
2. **nginx 配置**: `node_wall.conf` 是 nginx 配置，不是 server.js 配置
3. **敏感文件**: `.env` 包含数据库密码，已在 gitignore 中
4. **上传路径**: `/uploads/*` 由 nginx 代理到后端 `public/uploads/`

## 常见问题

Q: 投票功能不工作？
A: 检查 `pollOptions` 是否正确传递，检查 `poll_type` 是否设置。

Q: 图片上传失败？
A: 检查 `/www/wwwroot/wall.jay23.cn/campus-wall/public/uploads/` 目录权限。

Q: 登录失效？
A: 检查 JWT 配置，Cookie httpOnly 前端拿不到。
