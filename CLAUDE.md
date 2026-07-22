# 嘉二校园墙 — Project Guide

## Architecture

```
nginx (wall.jay23.cn)
  ├── /*          → 前端静态文件 /www/wwwroot/.../frontend/
  ├── /uploads/*  → /www/wwwroot/.../campus-wall/public/uploads/
  └── /api/*      → proxy_pass → Node:3001（纯 API，不渲染页面）
```

前后端分离。后端只返回 JSON，前端由 nginx 直服静态文件。

## Directory

### 后端 `/www/wwwroot/wall.jay23.cn/campus-wall/`

| 文件 | 职责 |
|------|------|
| `server.js` | Express 入口，注册 API 路由、中间件 |
| `routes/` | 15 个路由模块（auth/posts/admin/mp/songs/…） |
| `services/` | 业务逻辑（wechat/mp-draft/email/ip-lookup/ai） |
| `services/wechat-token.js` | Access Token 统一缓存，wechat.js 和 mp-draft.js 共用 |
| `middleware/auth.js` | JWT 鉴权 + RBAC 5 角色权限 |
| `config/database.js` | MySQL 连接池 + 建表 SQL |
| `public/uploads/` | 用户上传图片 |

### 前端 `/www/wwwroot/wall.jay23.cn/frontend/`

views/ + public/ 合并后的纯静态文件，nginx 直接 serve。

## Commands

### 后端
```bash
systemctl restart wall      # 重启
systemctl status wall        # 查看
journalctl -u wall -n 20     # 日志
tail -f /www/.../campus-wall/logs/service.log
```

### 前端（部署）
```bash
# 直接把 frontend/ 目录上传覆盖
scp -r frontend/* root@服务器:/www/wwwroot/wall.jay23.cn/frontend/
```

## Key Constraints

- **Node 16.20.2** — 不支持 sharp（需要 ≥18.17），图片压缩用 ImageMagick `convert`
- **MySQL** — 127.0.0.1:3306，不暴露公网
- **ImageMagick** — 已装 `/usr/bin/convert`，用于 >9MB 图片压缩
- **JWT** — 存 httpOnly Cookie，前端浏览器自动带，不需要手动传 Header

## Common Tasks

### 加新页面
1. HTML 放到 `frontend/`
2. 如果路径不是实际文件名（如 `/login` → `login.html`），在 `node_wall.conf` 加 rewrite 或 `$uri.html` 会兜底

### 加新 API
1. `routes/` 下新建文件或用已有路由
2. `server.js` 注册 `app.use('/api/xxx', require(...))`
3. 前端用 `apiFetch('/api/xxx')` 调用

### 权限控制
```js
// 中间件层级
const { auth, isStaff, adminOnly, requirePermission } = require('../middleware/auth');
router.use(auth, isStaff);                          // 所有路由都需要管理登录
router.get('/stats', requirePermission('stats:view')); // 精确到权限点
```

### 微信相关
- `WECHAT_APPID` 配置在 `.env`，缺了服务启动报错
- Access Token 自动缓存（wechat-token.js），调用方 `const { getAccessToken } = require('./wechat-token')`
- 公众号素材同步已异步化，不走 Cloudflare 524 超时（但 100s 硬限改不了）

## Gotchas

- **前端目录 frontend/** 和 **后端目录 campus-wall/public/** 是两份独立文件。改前端 JS/CSS 记得两边都同步
- 帖子图片路径是 `/uploads/posts/xxx.jpg`，由 nginx 的 `/uploads/` location 代理到后端目录
- 非 pending 状态帖子的通过/拒绝按钮不会显示在弹窗里
- `.env` 不改时 gitignore 保护，不会上传到仓库
