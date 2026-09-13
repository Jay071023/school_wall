'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const routePath = path.join(__dirname, '..', 'routes', 'mp-draft.js');
const source = fs.readFileSync(routePath, 'utf8');
const clientPath = path.join(__dirname, '..', 'frontend', 'admin', 'mp-draft.html');
const clientSource = fs.readFileSync(clientPath, 'utf8');
const weatherServicePath = path.join(__dirname, '..', 'services', 'mp-draft.js');
const weatherServiceSource = fs.readFileSync(weatherServicePath, 'utf8');
// 微信客户端不稳定支持 flex；天气卡固定为 48% + 4% 间距 + 48%，避免列宽与 padding 叠加。
assert.ok(source.includes('table-layout:fixed;border-collapse:collapse'), '天气表格必须使用固定布局');
assert.ok(source.includes('width="48%" style="width:48% !important;vertical-align:top;text-align:center;padding:0;overflow:hidden;"'), '服务端天气两列必须无单元格内边距并保留固定宽度');
assert.ok(source.includes('width="4%" style="width:4% !important;padding:0;font-size:0;line-height:0;"'), '服务端天气列间距必须独立占位，不能挤宽两列');
assert.ok(source.includes('role="presentation" width="100%"'), '天气表格必须保留语义无障碍标记');
assert.ok(source.includes('明日预报暂未更新'), '无明日数据也必须保持第二列');
assert.ok(clientSource.includes('function buildWechatWeatherCardHtml(weather, previewTheme)'), '客户端天气必须集中使用微信兼容卡片生成器');
assert.ok((clientSource.match(/buildWechatWeatherCardHtml\(weather, previewTheme\)/g) || []).length >= 3, '首次生成与主题重渲都必须复用同一套天气卡片');
assert.ok(clientSource.includes('width="48%" style="width:48% !important;vertical-align:top;padding:0;overflow:hidden;"'), '客户端天气今日列必须无内边距并固定为 48% 宽度');
assert.ok(clientSource.includes('function buildWechatTextStatsHtml(readMinutes, postCount)'), '客户端统计栏必须集中使用微信兼容布局生成器');
assert.ok((clientSource.match(/buildWechatTextStatsHtml\(readMinutes, postData\.length\)/g) || []).length >= 2, '客户端预览和实际同步正文的统计栏都必须复用同一套布局');
assert.ok(clientSource.includes('width="31.33%"') && clientSource.includes('width="3%" style="width:3% !important;padding:0;font-size:0;line-height:0;"'), '统计栏三列必须使用独立间隔列，避免 iOS 微信叠加 padding 撑宽');
assert.ok(clientSource.includes('function buildWechatWeatherMetaHtml(value, icon, previewTheme)'), '天气信息行必须使用统一的空值处理，不能显示暂无占位文案');
assert.ok(!clientSource.includes('风况暂无') && !clientSource.includes('湿度暂无') && !source.includes('风况暂无') && !source.includes('湿度暂无'), '天气卡片不得显示风况暂无或湿度暂无');
assert.ok(clientSource.includes('function buildWechatWeeklyStarHtml(weeklyStar)'), '客户端每周之星必须集中使用微信兼容卡片生成器');
assert.ok(clientSource.includes('stars.slice(start, start + 3)'), '每周之星超过三人必须分行，不能继续横向撑宽');
assert.ok(clientSource.includes('width="2%" style="width:2% !important;padding:0;font-size:0;line-height:0;"'), '每周之星卡片必须使用独立间隔列，避免第二张卡片溢出');
assert.ok((clientSource.match(/buildWechatWeeklyStarHtml\(weeklyStar\)/g) || []).length >= 3, '首次生成与主题重渲都必须复用同一套每周之星布局');
assert.ok(clientSource.includes('color:#A2376C'), '推歌标题颜色必须在夜间模式下保持足够对比度');
assert.ok(clientSource.includes('function formatRichTextInline(text)'), '客户端正文必须集中处理加粗和斜体标记');
assert.ok(source.includes('function formatRichTextInline(text)'), '服务端正文必须集中处理加粗和斜体标记');
assert.ok(!clientSource.includes('同步后在此插入音乐卡片') && !source.includes('同步后在此插入音乐卡片'), '推歌模板不得再输出需要手动删除的自动替换提示');
assert.ok(weatherServiceSource.includes('translateWindDirection(c.winddir16Point)'), '英文风向必须在服务端转换为中文');

// 服务端生成的 article 在预览与草稿发送前使用同一个标准化入口。
assert.ok(source.includes('generateCardHTML(posts, weather, hitokoto, dateInfo, stats, categories, songReq, todayHistory, weeklyStar, commentsByPost, includeGaokao, dailySongs, includeDailySongs, titleInfo.title)'), '合集正文必须接收同一 article 标题');
assert.ok(source.includes('mpDraftService.normalizeDraftArticle(JSON.parse(JSON.stringify(article)))'), '同步前必须以服务端规则最终标准化');
assert.ok(!source.includes('校园故事站'), '旧栏目名不得继续出现在公众号模板');
assert.ok(source.includes('一首歌的时间'), '推歌栏目名应与当前栏目命名一致');
assert.ok(source.includes("router.get('/weekly-song-schedule'"), '本周点歌单必须提供独立排期接口');
assert.ok(source.includes("sr.status = 'approved' AND sr.deleted_at IS NULL"), '本周点歌单只能读取已审核且未删除的点歌');
assert.ok(source.includes('sd.is_active = 1 AND ts.is_active = 1'), '本周点歌单必须排除已关闭的播放时段');
assert.ok(clientSource.includes('function generateWeeklySongSchedule('), '后台必须可以生成独立本周/下周点歌单');
assert.ok(clientSource.includes("generatedDailySongIds = [];"), '同步本周点歌单不能误改每日推歌发布状态');
assert.ok(clientSource.includes('本周点歌播放表'), '本周点歌单必须使用独立的用户可见标题');
assert.ok(clientSource.includes('table-layout:fixed;background:#ffffff;border:1px solid #d6e4ec'), '本周点歌单的歌曲行必须使用公众号兼容表格布局');
assert.ok(clientSource.includes('function shouldSelectDailySongByDefault(song)'), '每日推歌候选必须集中定义默认勾选规则');
assert.ok(clientSource.includes("song.status !== 'published'"), '已发布但可复用的歌曲默认不得勾选');
assert.ok(clientSource.includes('song._selected = false;'), '同步后本地候选必须立即取消已发布歌曲的勾选');
assert.ok(clientSource.includes('候选曲目已经在“今日推歌选择”工作区内'), '候选曲列表不得再渲染嵌套卡片容器');
assert.ok(clientSource.includes('#dailySongSelector #dailySongList.daily-song-list'), '候选列表必须以足够高的选择器优先级清除旧版容器样式');
assert.ok(!clientSource.includes('dailySongList" class="daily-song-list" style="max-height:300px;overflow-y:auto;background:#fff'), '候选列表初始结构不得保留白底嵌套卡片');
assert.ok(clientSource.includes('daily-song-item-badges'), '候选状态标签必须有独立容器，避免挤占编辑按钮网格');
assert.ok(clientSource.includes('grid-template-areas:'), '候选卡片头部必须明确各元素网格区域，避免编辑按钮拉伸覆盖整行');
assert.ok(!clientSource.includes('". badges badges"'), '候选状态标签不得再占用独立网格行而把每首歌曲异常撑高');
assert.ok(clientSource.includes('grid-template-columns: 20px minmax(0, 1fr) 96px !important;'), '桌面候选项必须为编辑按钮保留固定右侧列');
assert.ok(clientSource.includes('width: 96px !important;'), '桌面编辑按钮必须固定宽度，避免形成向左倾斜的按钮列');
assert.ok(clientSource.includes("html += '</div>'; // 关闭本首候选项，避免后续歌曲递归嵌套"), '每首候选项必须闭合，后续歌曲不得嵌套进前一首');
assert.ok(clientSource.includes("apiFetch('/api/mp/cover-prompt'"), '推送页封面提示词必须走 /api/mp/，避免被后台路径防火墙拦截');
assert.ok(source.includes("router.post('/cover-prompt', requirePermission('songs:review')"), '公众号推送路由必须提供受权限保护的封面提示词入口');
assert.ok(source.indexOf("router.post('/cover-prompt'") > source.indexOf('router.use(auth, isStaff, superAdminOnly);'), '封面提示词接口必须在统一鉴权后注册，令牌才能写入 req.user');
assert.ok(clientSource.includes('window.switchTab = switchTab;'), '内联页签按钮必须能从 window 找到 switchTab');
assert.ok(clientSource.includes('window.openDailySongTab = openDailySongTab;'), '内联每日推歌入口必须能从 window 找到 openDailySongTab');

console.log('[mp-draft-layout] 通过：天气横排、正文标题一致性和栏目替换静态检查均符合预期');
