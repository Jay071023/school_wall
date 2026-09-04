# 校墙架构与维护说明

这份文档只记录代码边界、数据生命周期和维护入口，不记录服务器地址、账号、令牌或密钥。

## 目录边界

```text
server.js                 应用组装、启动和定时任务入口
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

`frontend/` 是修改源，`public/` 是部署镜像。修改前端后执行：

```powershell
npm run check:mirrors
```

这个检查会逐文件比较两棵静态树，上传前必须通过。上传目录属于运行时数据，不参与静态镜像比较。

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
