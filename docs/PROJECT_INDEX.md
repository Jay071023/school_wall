# 校墙项目代码索引

> 本文件按当前源码整理，目标是让后续维护可以先定位入口，再阅读局部代码。路径均相对于项目根目录。

> 公开镜像约定：这里不包含生产数据、凭据或部署配置，也不得用它部署生产环境。

## 公开协作入口

- `README.md`：公开项目首页，说明产品能力、原创实现、脱敏边界和本地启动方式。
- `CONTRIBUTING.md`：Issue、分支、镜像同步和 Pull Request 的贡献规则。
- `CODE_OF_CONDUCT.md`：公开协作的行为与隐私边界。
- `SECURITY.md`：私密安全问题反馈规则；漏洞细节不得进入公开 Issue。
- `.github/workflows/ci.yml`：GitHub `main` 推送和 Pull Request 的 Node 20 验证流程，不发布 npm 包或生产服务。
- `.github/ISSUE_TEMPLATE/` 与 `.github/pull_request_template.md`：公开协作模板，要求移除真实内容、凭据、私有地址和安全细节。

## 运行与部署入口

- `server.js`：Express 服务启动入口，负责静态资源、路由挂载和服务启动。
- `config/database.js`：数据库连接池配置。
- `routes/`：HTTP 路由层；认证在 `routes/auth.js`，站点信息/主题在 `routes/site.js`，后台设置在 `routes/admin.js`，部署在 `routes/deploy.js`。
- `services/`：邮件、AI、头像、微信公众号等业务服务；路由层只编排请求和响应。
- `deploy.sh`：服务器端更新脚本；部署前要核对 `server.js`、`routes/deploy.js` 和服务器上的进程管理配置。
- 管理员版本查看：`routes/admin.js` 的 `/api/admin/deployment-status` 读取脱敏部署记录，`frontend/admin/index.html` 的“系统设置”仅向有设置权限的管理员展示提交号、状态和更新时间。
- 管理后台更新记录：发布时由维护 Agent 在 `config/release-notes.json` 写入简短的改动说明；`services/release-notes.js` 统一校验，`routes/admin.js` 的 `/api/admin/release-notes` 仅向有设置权限的管理员只读提供，`frontend/admin/index.html` 的“系统设置”展示。不要做前台入口、强制弹窗或后台编辑器；每次推送 Gitee 并部署前，先把本次功能修复或优化补进该文件。

## 前端页面定位

`frontend/` 是生产 Nginx 使用的页面树，`public/` 是 Node 静态服务使用的镜像树。HTML、页面 JS、页面 CSS 修改后必须保持两棵树一致，优先运行 `npm run check:mirrors`。

| 功能 | 页面 | 主要脚本/样式 |
| --- | --- | --- |
| 首页/校墙 | `frontend/index.html` | `frontend/js/home.js`、`frontend/js/side-cards.js`、`frontend/css/mobile-fix.css` |
| 帖子详情/评论 | `frontend/post-detail.html` | `frontend/js/detail.js`、`frontend/js/detail-emojis.js`、`frontend/css/style.css` |
| 我的/个人中心 | `frontend/profile.html` | 页面内脚本、`frontend/js/profile.js`、`frontend/css/mobile-fix.css`；资料卡含移动端退出登录入口 |
| 广播站/点歌 | `frontend/radio.html` | `frontend/js/radio.js`、`frontend/css/radio.css`（页面终态布局）、`frontend/css/mobile-fix.css`（公共移动兼容） |
| 私信 | `frontend/messages.html` | `frontend/js/messages.js`、`frontend/css/mobile-fix.css` |
| 登录/注册 | `frontend/login.html`、`frontend/register.html` | `frontend/js/auth.js` |
| 管理后台 | `frontend/admin/index.html` | 页面内后台模块脚本和样式 |
| 公众号推送 | `frontend/admin/mp-draft.html` | `frontend/admin/js/mp-draft-utils.js`（文本/视频预览工具）、`frontend/admin/js/mp-draft-ui.js`（状态提示）、`routes/mp-draft.js`、`services/mp-draft.js`；热门帖、周/月活跃榜、图片/视频预览和异步草稿同步，手动同步与一键发布共用微信图片/视频素材处理链 |

发帖媒体链路：`frontend/new-post.html` / `frontend/js/post.js` 负责统一图片+视频选择、预览和提交（最多9张图片、1个视频；iOS 使用可点击封面层和行内播放兜底）；`frontend/js/post-editor.js` 是投稿页和编辑页共用的可视化编辑器，编辑时直接显示粗体/斜体，提交时转换为兼容存储格式；`routes/upload.js` 的 `/api/upload/post-images`、`/api/upload/post-video` 负责鉴权、类型/大小/文件头校验，视频固定落在 `uploads/videos`；`routes/posts.js` 与 `config/database.js` 的 `video_url` 字段负责保存、列表和详情返回；`services/cleanup.js` 每日清理未发布帖子媒体（图片7天、视频30天），已审核通过的帖子媒体受保护；首页/详情展示分别在 `frontend/js/home.js`、`frontend/js/detail.js`。

公众号推送链路：`frontend/admin/mp-draft.html` 选择帖子并生成图文预览，`routes/mp-draft.js` 读取 `video_url` / `video_poster`，在预览和公众号正文中加入视频播放器及站内打开链接；微信侧若过滤外链播放器，链接仍作为兜底入口。同步前由页面的 `getArticleForSync` 校验内存文章；若浏览器状态丢失但预览区仍是有效内容，会从当前预览恢复文章再同步，不能误报“请先生成图文预览”。

公众号视频链路：`routes/mp-draft.js` 必须在热点列表和生成内容查询中保留 `video_url`；公众号正文使用“打开原帖播放视频”的稳定入口（站外视频不直接嵌入草稿），`frontend/admin/mp-draft.html` 的客户端预览模板也必须保留同一入口，避免二次渲染时丢失。同步公众号永久素材时，站内允许上传的 MP4、WebM、OGV 均通过 `services/mp-draft.js` 的同一媒体链路处理：MP4 直接上传，其他格式仅在服务器临时转为兼容 MP4 后上传，站内原视频不会改写或删除。生产环境须提供 `ffmpeg` 与 `ffprobe`（可用 `FFMPEG_PATH`、`FFPROBE_PATH` 指定路径）；缺失、转码失败或结果超过微信大小上限时必须把明确失败原因回传同步结果，不能伪造成功。

其他协议、编辑、反馈和错误页也加载统一主题脚本：`agreement.html`、`privacy.html`、`edit-post.html`、`edit-profile.html`、`new-post.html`、`post-detail.html`、`feedback.html`、`404.html`、`reset-password.html`。

## 主题与首屏启动

- `frontend/js/theme-mode.js` 与 `public/js/theme-mode.js`：读取 `/api/site-info`，只应用教师节（含黑板/开学季氛围）或 `520` 主题，切换 `mode-teacher` / `mode-festival-520` 并发出 `festival-theme-ready`；仅使用带时效的已确认本地提示提前预载主题 CSS，最终仍以接口结果为准。
- `frontend/css/teacher.css` 与 `public/css/teacher.css`：教师节视觉主题。
- `frontend/css/festival-520.css` 与 `public/css/festival-520.css`：520 主题视觉和装饰。
- 各页面 `<head>` 的 `app-boot-style` / `app-booting`：主题就绪前隐藏页面，监听 `festival-theme-ready` 后释放；必须保留短超时兜底，不能使用 `load` 事件提前放行。
- `frontend/admin/index.html` 中的节日设置是唯一主题选择入口，选项应保持“教师节 / 黑板主题”和“520 告白季”两项；后端兼容旧值 `back_to_school` 时归一化为教师节。

## 邮箱验证码

- 前端发送入口：`frontend/js/auth.js` 的注册邮箱验证码请求；输入和复制按钮在 `frontend/register.html`。
- 后端发送入口：`routes/auth.js` 的 `/api/auth/send-register-email-code`。
- 后端生成/校验：使用 Node `crypto` 生成验证码，服务端只保存哈希和过期时间，注册时再次哈希比对；前端只提交邮箱和验证码，不生成、不回传验证码。
- 邮件发送：`services/email.js`。后台开关和 SMTP 配置在 `routes/admin.js`、`frontend/admin/index.html`。
- 图片验证码是兼容回退，不应在邮箱验证已开启时阻塞默认注册流程；修改认证流程时必须同时覆盖 `frontend/public` 和后端路由测试。

## 响应式约定

- 断点约定：`min-width: 769px` 为桌面布局，`max-width: 768px` 才允许移动布局；不要用“内容少/卡片窄”代替 viewport 断点判断。
- 公共层：`frontend/css/style.css`、`base.css`、`responsive.css`、`mobile-fix.css`，对应 `public/css/` 镜像。
- 页面专属样式尽量作用域到页面根类（如 `.home-page`、`.profile-page`、`.radio-page`），移动规则写在明确的 `@media (max-width: 768px)` 中，避免全局选择器反向覆盖桌面布局。
- 首页侧栏定位：`frontend/index.html` 的 `side-cards-left/right` 与 `frontend/js/side-cards.js`；签到卡由 `frontend/js/home.js` 的 `loadCheckinStatus` / `syncCheckinPlacement` 管理。
- 动态互动区：`frontend/js/home.js` 的 `renderPostCard`、`toggleLike`、`toggleFavorite`，样式集中在 `mobile-fix.css` 的首页作用域块。

## 常用检查

```powershell
npm run check:mirrors
npm run check:privacy
npm test
node scripts/test-cleanup.js
node scripts/test-radio-layout.js
node scripts/test-site-info-sharing.js
node scripts/test-home-request-race.js
node scripts/test-responsive-boundary.js
node scripts/test-detail-interactions.js
node scripts/test-post-media-editor.js
node scripts/test-mp-draft-modules.js
node --check frontend/js/home.js
node --check frontend/js/theme-mode.js
```

涉及首屏、主题、路由或验证码时，额外运行对应 `scripts/test-*.js`，并检查 `git diff --check`。部署前确认工作区干净、目标提交已推送到 Gitee，部署后核对健康检查和线上提交号。

## 低耦合整理建议

以下是后续建议，不是本文件对源码行为的替代说明：

1. 把各页面重复的 `app-booting` 内联逻辑收敛为一个极小的公共启动约定；首屏关键 CSS 可以保留内联，业务逻辑不要复制到每个 HTML。
2. 把首页侧栏卡片的渲染、排列和断点判断集中到一个模块，页面只提供容器和数据入口。
3. 把注册/登录的验证码状态机集中在认证模块，HTML 只保留表单和无障碍状态节点。
4. 继续保持 `frontend/` 与 `public/` 的镜像检查，不要让一个目录成为“临时修改目录”而忘记同步。
5. 大范围视觉调整先改公共 token/页面作用域，再改组件细节，避免用更高优先级的全局规则层层覆盖旧规则。
