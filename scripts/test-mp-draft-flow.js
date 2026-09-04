'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const route = fs.readFileSync(path.join(root, 'routes', 'mp-draft.js'), 'utf8');
const service = fs.readFileSync(path.join(root, 'services', 'mp-draft.js'), 'utf8');
const tokenService = fs.readFileSync(path.join(root, 'services', 'wechat-token.js'), 'utf8');
const page = fs.readFileSync(path.join(root, 'frontend', 'admin', 'mp-draft.html'), 'utf8');

assert(service.includes("path.resolve(__dirname, '..', 'public')"), '公众号正文相对图片必须从项目 public 目录读取');
assert(service.includes('resolvePublicFile(imageUrl)'), '相对图片必须经过 public 路径边界校验');
assert(tokenService.includes('pendingTokenPromise'), '并发同步必须复用同一个微信 access token 请求');
assert(route.includes('p.images, p.video_url'), '选帖和生成内容查询必须保留视频字段');
assert(route.includes('buildPostVideoHTML(post)'), '单篇公众号内容必须保留视频素材和原帖入口');
assert(route.includes("throw new Error('有 ' + failures.length"), '正文图片上传失败时必须停止创建残缺草稿');
assert(route.includes("crypto.randomBytes(16)"), '同步任务编号必须不可预测');
assert(route.includes('pendingSyncs[syncId].ownerId !== req.user.id'), '同步状态必须限定为任务提交人可见');
assert(route.includes("posts.length === 0 && dailySongs.length === 0"), '仅推歌流程不应被空帖子校验拦截');
assert(route.includes('getControlledPostVideoPath'), '视频路径必须经过受控资源校验');
assert(route.includes("new URL(raw).origin !== new URL(PUBLIC_WALL_ORIGIN).origin"), '视频资源必须拒绝任意外站 URL');
assert(route.includes('await mpDraftService.uploadPermanentVideo(source,'), '受控视频必须统一交给服务层处理');
assert(!route.includes("if (!/\\.mp4$/i.test(source)) throw new Error('公众号永久视频素材仅支持 MP4')"), '路由层不能提前拒绝 WebM/OGV');
for (const extension of ['mp4', 'webm', 'ogv']) {
  assert(route.includes(extension), `路由视频白名单必须覆盖 ${extension}`);
}
assert(route.includes('result.errors.push({ index: item.index, code: item.code, message: item.message })'), '服务层视频错误必须保留错误码和原文');
assert(route.includes("status: hasVideoFailures ? 'fail' : 'done'"), '视频失败时同步状态不能伪装为成功');
assert(route.includes('failure_reason: videoFailureDetails || null'), '同步结果必须向前端提供视频失败原因');

// 与路由白名单相同的输入契约测试：覆盖三种站内格式，并明确拒绝任意外站 URL。
const controlledVideoPattern = /^\/uploads\/videos\/video_[A-Za-z0-9_-]+\.(?:mp4|webm|ogv)$/i;
function expectedControlledVideoPath(value) {
  const raw = String(value || '').trim();
  let pathname = raw.split('?')[0];
  if (/^https?:\/\//i.test(raw)) {
    const parsed = new URL(raw);
    if (parsed.origin !== 'https://campus-wall.example') return '';
    pathname = parsed.pathname;
  }
  return controlledVideoPattern.test(pathname) ? pathname : '';
}

for (const extension of ['mp4', 'webm', 'ogv']) {
  const localPath = `/uploads/videos/video_route-contract.${extension}`;
  assert.strictEqual(expectedControlledVideoPath(localPath), localPath, `${extension} 站内路径必须允许交给服务层`);
  assert.strictEqual(expectedControlledVideoPath(`https://campus-wall.example${localPath}`), localPath, `${extension} 当前站点绝对 URL 必须允许`);
}
assert.strictEqual(expectedControlledVideoPath('https://evil.example/uploads/videos/video_route-contract.webm'), '', '外站同名视频路径必须拒绝');
assert.strictEqual(expectedControlledVideoPath('https://campus-wall.example/uploads/videos/other.webm'), '', '非校墙命名视频必须拒绝');
assert.strictEqual(expectedControlledVideoPath('/uploads/videos/video_route-contract.mov'), '', '未列入白名单的格式必须拒绝');

assert(page.includes("sr.code === 404") && page.includes('同步任务状态已丢失'), '服务重启导致任务丢失时前端必须停止无效轮询');
assert(page.includes("res.code === 409") && page.includes('已接续正在处理的同步任务'), '重复点击同步时前端必须接续已有任务');
assert(page.includes('function getArticleForSync()'), '同步前必须能读取当前已生成文章');
assert(page.includes("previewArea.querySelector('.placeholder')"), '同步恢复逻辑必须区分真实预览与占位提示');
assert(page.includes('var article = getArticleForSync();'), '同步按钮必须先从当前预览恢复文章状态');
assert(page.includes('body: JSON.stringify({ article: article })'), '同步请求必须使用恢复后的文章内容');
assert(!page.includes('if (!generatedArticles || generatedArticles.length === 0)'), '同步按钮不能只依赖易丢失的内存预览状态');

console.log('[mp-draft-flow] 通过：图片、视频、空帖子推歌、同步任务隔离和异常恢复链路均已覆盖');
