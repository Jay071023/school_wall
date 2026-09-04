# Campus Wall · sanitized public mirror

一个面向校园社区的 Node.js + Express Web 应用示例，涵盖投稿、互动、广播站点歌、私信、签到、主题与内容管理。

> 这是公开的**脱敏镜像**，用于展示代码结构和产品能力：不包含生产数据库、用户投稿、上传媒体、日志、服务器地址、真实第三方凭据或运维配置。生产完整版独立维护，不从本仓库部署。

## Product preview

以下均为不含真实学校、用户或内容的脱敏界面示意，用来展示信息架构与视觉方向，而非生产截图。

| Community home | Mobile experience | Admin workspace |
| --- | --- | --- |
| ![Desktop community preview](docs/public/screenshots/home-desktop-preview.png) | ![Mobile community preview](docs/public/screenshots/mobile-preview.png) | ![Admin publishing preview](docs/public/screenshots/admin-preview.png) |

## What it includes

- Responsive campus feed: posts, comments, reactions, favourites and full-text pagination.
- Sign-in, email verification, user profile and private messages.
- Radio request page with a desktop two-column layout and mobile safe-area spacing.
- Image/video submission: up to nine images or one video per post, plus delayed cleanup for unpublished media.
- Admin console for moderation, site settings, scheduled content and public-account drafts.
- Theme boot gate for an intentional first paint, including the teacher-themed presentation.

## Getting started

```bash
npm install
Copy-Item .env.example .env
npm start
```

Before starting, replace the placeholder values in `.env` with a local MySQL connection and a strong `JWT_SECRET`. Do not commit `.env`, upload folders, logs or database files.

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | Yes | MySQL connection |
| `JWT_SECRET` | Yes | Session signing secret |
| `WECHAT_APPID`, `WECHAT_SECRET` | Optional | Public-account and OAuth integration |
| `FFMPEG_PATH`, `FFPROBE_PATH` | Optional | Override video tools for public-account material conversion |

The checked-in story and automatic-publish configuration is an inert example (`enabled: false`) with no production story data.

## Media and public-account drafts

Post media is accepted by the upload route, stored outside source control, and cleaned if an unpublished item expires. Public-account drafts retain an article link for every video. Controlled local MP4 files can be uploaded directly; WebM/OGV and oversize MP4 files are converted in a temporary directory to a compatible H.264/AAC MP4 when `ffmpeg` and `ffprobe` are available. The original site video is never overwritten.

## Architecture

![Campus Wall architecture](docs/public/architecture.svg)

The editable source is [docs/public/architecture.mmd](docs/public/architecture.mmd). It intentionally uses generic labels and no production endpoint or infrastructure details.

## Project layout

```text
frontend/ and public/  mirrored static page trees
routes/                HTTP endpoints and access control
services/              mail, media, AI, notification and draft workflows
middleware/            shared authentication and request handling
config/                local configuration templates and database access
scripts/               focused static and behavior checks
docs/                  code map, architecture and public documentation assets
```

Changes to `frontend/` must be mirrored to `public/`. The repository enforces this with `npm run check:mirrors`.

## Verification

```bash
npm run check:mirrors
npm run check:privacy
npm test
git diff --check
```

## Public-mirror boundaries

- This branch deliberately excludes runtime uploads, databases, logs, backups and production story content.
- Example integration identifiers are placeholders only; provide credentials through local environment variables.
- The public mirror has automatic publishing disabled by default.
- Treat any pull request as application code review, not permission to access a production service.
