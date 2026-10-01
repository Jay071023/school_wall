# 校墙架构与维护说明

这份文档只记录代码边界、数据生命周期和维护入口，不记录服务器地址、账号、令牌或密钥。

## 目录边界

```text
server.js                 环境加载、运行生命周期与进程退出入口
app.js                    HTTP 应用工厂，不监听或初始化数据库
http/                     中间件、页面静态服务及有序 API 挂载
modules/songs/            点歌模块依赖组装，共享维护服务实例
repositories/             注入连接后的 SQL 数据访问
config/environment.js     .env / .env.local 的启动加载入口
services/runtime.js       数据库、HTTP 监听及有界退出的生命周期
jobs/index.js             后台维护任务统一启停与等待
services/task-lifecycle.js 无加载副作用的定时任务控制器
routes/                   HTTP 路由与参数/权限校验
services/                 可复用业务能力（清理、头像、分页、公众号素材等）
middleware/               认证、权限和请求前置处理
config/database.js        数据库连接与幂等迁移
frontend/                 前端静态源文件
public/                   运行时静态镜像，需与 frontend/ 保持一致
scripts/                  可重复执行的检查与维护脚本
deploy.sh                 拉取、同步、重启、健康检查和回滚
```

路由层负责“请求是否允许、参数是否有效、返回什么”，复杂或可复用的业务应下沉到 `services/`。数据库迁移集中在启动流程中，并用字段/索引存在性检查保证重复启动不会重复创建。

## 点歌维护的依赖边界

点歌 HTTP 路由和后台任务通过 `modules/songs/index.js` 共享维护服务。`services/song-maintenance.js` 只编排日期窗口、时段容量、周期、生效日期、播放归档和通知；数据库访问全部通过注入的 `repositories/song-maintenance.js` 完成。repository 接收现有连接池或事务连接，不创建连接池、不依赖 Express、不发送邮件。时钟与通知发送器可注入以离线验证。

点歌提交、投票和后台审核的既有事务仍由原调用链维护，本次只迁移自动维护职责。`services/date.js` 统一提供中国日期窗口和时间，`services/number-utils.js` 复用正整数上限解析。退出时等待播放归档及由该轮归档安排的通知；不重复通知未成功更新的歌曲。

## 运行生命周期

`app.js` 的 `createApp()` 只组装 HTTP 行为，中间件、静态页面与 API 挂载依次由 `http/` 的三个模块完成。API 表保持原有路径和挂载顺序；应用工厂允许注入静态根目录、跨域配置及路由解析器用于独立验证。`server.js` 兼容导出 `app/start/stop`，仅直接执行时安装进程信号和异常处理器。

加载路由只注册接口与任务控制器，不启动验证码清理、点赞缓存清理、点歌归档、日期维护或公众号状态清理。`server.js` 通过 `services/runtime.js` 先初始化数据库，再确认 HTTP 监听成功，最后调用 `jobs/index.js` 启动任务。启动和停止幂等，监听失败不会启动任务。

收到 SIGTERM/SIGINT 后，服务停止接收新请求并取消维护定时器，等待已接收请求以及执行中的日期维护、数据清理和公众号同步任务，再关闭连接池。退出总等待上限为 10 秒，超时以失败退出，由进程管理器接管；超过窗口的公众号同步仍可能中断，持久任务恢复尚未在本批实现。

`npm run test:runtime` 使用模拟数据库和临时端口真实监听验证加载副作用、慢任务去重、重复启停、启动失败及退出超时，不修改业务数据。

`npm run test:http` 在临时端口验证页面别名、缓存响应头、跨域白名单、匿名和五种角色权限，以及数据库不可用时的状态码，不连接业务数据库或发送外部通知。

## 内容生命周期

帖子和点歌记录的删除采用软删除：

1. 用户端或管理端删除时只写入回收站时间。
2. 普通列表、详情、评论、点赞、收藏、投票、浏览量和公众号素材查询都必须排除已删除记录。
3. 管理员可在回收站恢复或彻底删除。
4. 定时清理任务在保留期后执行物理删除；当前回收站保留期为 7 天。

接口层仍要检查 `affectedRows`，因为页面打开后可能有另一个请求先完成删除、恢复或彻底清理。这样前端收到 404 后可以刷新列表，不会把过期按钮状态当成成功状态。

## 点歌审核和拒绝通知

点歌拒绝理由由后台维护，并随审核结果保留在点歌记录中：

1. 系统设置中的“点歌拒绝理由预设”按每行一个模板保存，后台审核弹窗可以选择、直接修改、更新当前预设，或另存为新预设。
2. 预设存放在 `settings.song_reject_reasons`，最多保留 20 条，每条最多 500 个字符；单独保存接口为 `PUT /api/admin/settings/song-reject-reasons`。
3. 拒绝单条或批量点歌时必须提交理由。审核接口把理由写入 `song_requests.reject_reason`，详情页用于追溯，邮件模板也会展示该理由。
4. 点歌审核通知沿用用户邮件通知偏好 `notify_song_approved` / `notify_song_rejected`。实际发信还要求用户有有效邮箱、系统邮件开关已开启且 SMTP 配置完整；不满足条件时不会把“接口成功”当成邮件已送达。

`config/database.js` 启动时会幂等补充 `song_requests.reject_reason` 字段，并初始化默认模板。修改数据库结构或邮件配置后，应在目标环境查看邮件日志和健康检查；本地静态检查不能证明线上 SMTP 投递成功。

## 分页约定

所有列表接口优先使用 `services/pagination.js` 的 `getPagination()`：

- 非法页码和页大小回退到默认值。
- 页大小按接口用途设置上限。
- 页码和 offset 也设上限，避免异常请求生成超大数据库 offset。
- 接口响应中的页码、总页数使用数字，不直接透传查询字符串。

## 前端静态文件

`frontend/` 是唯一静态源码，`public/` 是当前运行镜像。修改前端后执行：

```powershell
npm run sync:frontend
npm run check:mirrors
npm run build
```

同步、检查和构建共用 `scripts/lib/frontend-assets.js` 的文件收集规则。同步只复制变化文件，遇到 `public/` 的独立未提交改动会停止，额外镜像文件保留并报错，交给开发者审阅。上传目录和依赖不参与生成；链接和敏感文件会被拒绝。

`npm run build` 先同步并检查镜像，再生成 `dist/` 和包含提交号、逐文件 SHA-256 的 `asset-manifest.json`。构建只清理经过路径校验的项目 `dist/`，拒绝链接输出目录。生产仍沿用现有静态目录部署流程，尚未切换为发布 `dist/`。`npm run test:frontend-assets` 在临时目录验证同步冲突、幂等、上传保留、路径保护和构建清单。

## 部署安全边界

`deploy.sh` 的流程是：

```text
拉取指定发布源
  -> 安装依赖
  -> 检查 frontend/public 镜像
  -> 同步 Nginx 静态目录（如配置）
  -> 重启服务
  -> 请求健康检查
       ├─ 成功：保留新版本
       └─ 失败：恢复部署前提交并再次健康检查
```

脚本使用单实例锁，避免多个 webhook 同时 reset、安装和重启。健康检查只验证应用可用性，不把凭据写入日志。

Gitee webhook 使用 `X-Gitee-Token` 与环境变量 `DEPLOY_SECRET` 做定时安全比较，并只响应 `DEPLOY_BRANCH`（默认 `main`）的推送；请求返回 `202 Accepted` 只表示部署子进程已接受启动，不代表新版本已经上线。`GET /api/deploy-status` 使用同一凭据返回不含敏感信息的状态、提交和退出码，状态文件由脚本原子写入部署目录的日志目录。实际结果也写入部署日志，webhook 进程只记录不含凭据的启动错误。生产环境应由 Webhook 启动独立的 `wall-deploy.service`，让部署进程脱离 `wall.service` 的控制组；脚本默认通过服务器已配置凭据的 Gitee SSH 仓库拉取 `main`（可用环境变量切换为其他受信任地址），并在重启和健康检查失败时恢复部署前提交。由于 systemd 的 PATH 可能不包含面板 Node.js，脚本会探测 `/www/server/nodejs/*/bin/node` 并在安装依赖前确认 node/npm 可用；Webhook 以 `www` 用户运行时，仅通过 sudoers 授权启动部署单元、重启 `wall` 服务和查询状态。

无 `rsync` 时脚本也会先清理静态目录再复制，避免旧资源残留；这一步只有在 `DEPLOY_FRONTEND_DIR` 精确等于 `DEPLOY_FRONTEND_PARENT/frontend`、父目录为绝对路径且不在部署目录内部、目标真实路径未越界时才允许执行。`systemctl` 不可用会使部署失败并进入回滚流程，不会把旧进程误判为新版本成功。线上 webhook、systemd、Nginx 路径和日志只能在服务器上验证，本仓库检查不替代线上验证。

## 审核前检查

不启动本地服务时，可执行以下静态检查：

```powershell
npm run test:pagination
npm run check:mirrors
npm run check:privacy
node scripts/test-deployment-static.js
git diff --check
```

后台内联脚本还应使用 Node 的 `--check` 检查；真实手机和 PC 的视觉验收仍需在目标环境完成，静态检查不能替代真机观察。
