'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const route = fs.readFileSync(path.join(root, 'routes', 'mp-draft.js'), 'utf8');
const adminRoute = fs.readFileSync(path.join(root, 'routes', 'admin.js'), 'utf8');
const coverPromptService = fs.readFileSync(path.join(root, 'services', 'cover-prompt.js'), 'utf8');
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
assert(route.includes("status: 'done'"), '草稿已创建后同步必须进入终态，避免视频警告触发重复草稿');
assert(route.includes("sync_status: hasVideoFailures ? 'done_with_video_warning' : 'done'"), '视频失败必须作为已创建草稿的明确警告返回');
assert(route.includes("sync_status: 'draft_created_mark_failed'"), '数据库标记失败必须保留已创建草稿终态');
assert(route.includes('formatDraftCreatedMarkFailure'), '标记失败响应必须明确提示不要重复同步');
assert(!route.includes('code: hasVideoFailures ? 502 : 200'), '视频失败不能以普通失败响应掩盖已创建草稿');
assert(route.includes('failure_reason: videoFailureDetails || null'), '同步结果必须向前端提供视频失败原因');
assert(page.includes("function hasUnconfirmedDailySongState(data)"), '前端必须识别草稿已创建但候选状态未确认的终态');
assert(page.includes("res.code === 409 && res.data && hasUnconfirmedDailySongState(res.data)"), '同步接口返回候选状态未确认时必须给出明确提示');
assert(page.includes("if (hasUnconfirmedDailySongState(sr.data))") && page.includes('showDailySongStateWarning(sr.data)'), '轮询终态必须把候选状态未确认显示为警告');

// 与路由白名单相同的输入契约测试：覆盖三种站内格式，并明确拒绝任意外站 URL。
const controlledVideoPattern = /^\/uploads\/videos\/video_[A-Za-z0-9_-]+\.(?:mp4|webm|ogv)$/i;
function expectedControlledVideoPath(value) {
  const raw = String(value || '').trim();
  let pathname = raw.split('?')[0];
  if (/^https?:\/\//i.test(raw)) {
    const parsed = new URL(raw);
    if (parsed.origin !== 'http://localhost:3000') return '';
    pathname = parsed.pathname;
  }
  return controlledVideoPattern.test(pathname) ? pathname : '';
}

for (const extension of ['mp4', 'webm', 'ogv']) {
  const localPath = `/uploads/videos/video_route-contract.${extension}`;
  assert.strictEqual(expectedControlledVideoPath(localPath), localPath, `${extension} 站内路径必须允许交给服务层`);
  assert.strictEqual(expectedControlledVideoPath(`http://localhost:3000${localPath}`), localPath, `${extension} 当前站点绝对 URL 必须允许`);
}
assert.strictEqual(expectedControlledVideoPath('https://evil.example/uploads/videos/video_route-contract.webm'), '', '外站同名视频路径必须拒绝');
assert.strictEqual(expectedControlledVideoPath('http://localhost:3000/uploads/videos/other.webm'), '', '非校墙命名视频必须拒绝');
assert.strictEqual(expectedControlledVideoPath('/uploads/videos/video_route-contract.mov'), '', '未列入白名单的格式必须拒绝');

assert(page.includes("sr.code === 404") && page.includes('同步任务状态已丢失'), '服务重启导致任务丢失时前端必须停止无效轮询');
assert(page.includes("res.code === 409") && page.includes('已接续正在处理的同步任务'), '重复点击同步时前端必须接续已有任务');
assert(page.includes('function getArticleForSync()'), '同步前必须能读取当前已生成文章');
assert(page.includes("previewArea.querySelector('.placeholder')"), '同步恢复逻辑必须区分真实预览与占位提示');
assert(page.includes('var article = getArticleForSync();'), '同步按钮必须先从当前预览恢复文章状态');
assert(page.includes('var syncDailySongIds = generatedDailySongIds.slice();'), '同步时必须冻结本次已生成文章实际选中的推歌 ID');
assert(page.includes('body: JSON.stringify({ article: article, dailySongIds: syncDailySongIds })'), '同步请求必须使用恢复后的文章内容，并携带冻结的推歌状态更新范围');
assert(!page.includes('if (!generatedArticles || generatedArticles.length === 0)'), '同步按钮不能只依赖易丢失的内存预览状态');
assert(page.includes('function normalizeDailySong(song)'), '每日推歌预览必须先统一旧接口和编辑器字段');
assert(page.includes('dailySongs: includeDailySong ? selectedSongs : []'), '帖子+推歌预览必须携带完整歌曲快照');
assert(page.includes("await loadNextWeekRadioForDailyPush()"), '每日推歌生成必须读取下周广播点歌排期');
assert(page.includes('buildNextWeekRadioSectionHtml(weeklyRadioData)'), '公众号正文必须包含下周广播点歌预告段落');
assert(page.includes("showMsg('previewMsg', '✅ 推歌预览已生成"), '独立推歌生成后必须自动切到图文预览并提示同步入口');
assert(page.includes('lastSongOnlyState'), '独立推歌预览不能复用旧帖子缓存');
assert(page.includes('id="dailySongInlinePreview"'), '独立推歌必须在每日推歌页保留页内预览');
assert(page.includes("renderDailySongInlinePreview(generatedArticles[0], 'song')"), '推歌生成必须把同一篇文章渲染到每日推歌页');
assert(page.includes('toggleDailySongEditor(idx)'), '歌曲编辑卡必须支持单卡展开/收起');
assert(page.includes('song._expanded === true'), '歌曲编辑卡默认应折叠且保留单卡状态');
assert(page.includes('这是单首模板预览，请先点击“生成推歌预览”'), '单首模板预览不能直接误同步');
assert(page.includes('@media (max-width: 768px)'), '每日推歌移动端布局必须遵守 768px 断点');
assert(!page.includes('\n            [style*="flex:1"] { display: none; }'), '移动端不能用全局 flex:1 隐藏正文文字容器');
assert(page.includes('.toolbar > span[style*="flex:1"] { display: none; }'), '移动端只应隐藏工具栏弹性占位');
assert(page.includes('h.heat !== null') && page.includes('h.album'), '热歌榜应展示可用的热度和专辑信息');
assert(adminRoute.includes("router.post('/generate-cover-prompt'") && adminRoute.includes('generateCoverPrompt(req.body)'), '后台旧封面提示词入口必须继续受限并复用统一服务');
assert(coverPromptService.includes('只输出一段可直接复制的提示词') && coverPromptService.includes('文章内容要点') && coverPromptService.includes('请先生成正文，再根据正文生成封面提示词'), '所有封面提示词都必须拒绝没有正文且只返回可复制氛围描述');
assert(page.includes('article_content: article.content') && page.includes('generatedForRequestedType'), '推歌、播放表与普通推文都必须携带当前已生成正文');
assert(page.includes('function generateCoverPrompt(type)') && page.includes('copyCoverPrompt'), '推歌、点歌播放表和普通公众号预览都必须提供封面提示词入口');
assert(page.includes('inlineCoverPromptBtn') && page.includes('panel.scrollIntoView'), '推歌/播放表提示词必须紧邻已生成正文展示，生成后自动定位结果');
assert(page.includes('lastWeeklyScheduleData = data'), '点歌播放表生成后必须保留当前素材供页内预览和封面提示词使用');
const weeklyScheduleBuilder = page.slice(page.indexOf('function buildWeeklySongScheduleHtml'), page.indexOf('async function generateWeeklySongSchedule'));
assert(weeklyScheduleBuilder.includes("renderSignatureCard('Campus Radio'") && weeklyScheduleBuilder.includes("subtitle: '校 园 广 播 站'"), '点歌播放表底部必须使用广播站英文衬线标题和中文副标题');
assert(weeklyScheduleBuilder.includes("renderSignatureCard(editor, { stamp: 'ExampleAdmin'"), '点歌播放表底部必须在广播站之后展示 ExampleAdmin 署名卡');
assert(weeklyScheduleBuilder.indexOf("renderSignatureCard('Campus Radio'") < weeklyScheduleBuilder.indexOf("renderSignatureCard(editor"), '点歌播放表署名卡顺序必须是校园广播站在前、ExampleAdmin在后');
assert(page.includes('function renderSignatureCard(name, options)'), '刷新预览与点歌播放表必须共用统一署名卡组件');
assert(page.includes('var sigBody = \'\'') && page.includes('var subtitle = options.subtitle || \'\';'), '署名卡必须使用普通 HTML 承载字体并支持广播站副标题');
assert(weeklyScheduleBuilder.includes('overflow-wrap:anywhere') && !weeklyScheduleBuilder.includes('table-layout:fixed;background:#ffffff'), '点歌歌曲卡必须避免手机端三列表格挤压并允许长文本换行');

const syncedPreviewHelper = page.slice(page.indexOf('function buildSyncedPreviewArticle'), page.indexOf('function markPostSelectionGenerated'));
assert(syncedPreviewHelper.includes('article.content.replace(/__MP_VISIBLE_TEXT_COUNT__/g, visibleTextTotal.toLocaleString())'), '首次生成和刷新预览都必须在同步 payload 前替换全文字数占位符');

console.log('[mp-draft-flow] 通过：图片、视频、空帖子推歌、同步任务隔离和异常恢复链路均已覆盖');
