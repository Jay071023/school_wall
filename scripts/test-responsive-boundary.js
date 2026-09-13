'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8').replace(/\r\n/g, '\n');

const messages = read('frontend/js/messages.js');
assert(messages.includes('window.innerWidth <= 768 && currentConversationId'), '私信在 768px 时必须走移动布局');
assert(messages.includes('window.innerWidth > 768'), '私信桌面布局必须从 769px 开始');
assert(!messages.includes('window.innerWidth < 768') && !messages.includes('window.innerWidth >= 768'), '私信不得使用与 CSS 不一致的 768px 边界');
assert.strictEqual(messages, read('public/js/messages.js'), '私信脚本镜像必须一致');

const admin = read('frontend/admin/index.html');
assert(admin.includes('var isMobile = window.innerWidth <= 768;'), '后台弹窗在 768px 时必须使用移动布局');
assert(!admin.includes('var isMobile = window.innerWidth < 768;'), '后台不得使用与 CSS 不一致的移动端边界');
assert.strictEqual(admin, read('public/admin/index.html'), '后台页面镜像必须一致');

const mpDraftCss = read('frontend/admin/css/mp-draft.css');
assert.strictEqual(mpDraftCss, read('public/admin/css/mp-draft.css'), '公众号推送页样式镜像必须一致');
const mpDraftPage = read('frontend/admin/mp-draft.html');
assert.strictEqual(mpDraftPage, read('public/admin/mp-draft.html'), '公众号推送页结构镜像必须一致');
assert(mpDraftCss.includes('@media (max-width: 768px)'), '公众号推送页必须在 768px 及以下启用移动布局');
assert(mpDraftCss.includes('body.admin-mp-page .selection-action-bar .btn {\n    width: auto !important;'), '移动端悬浮生成按钮不得继承全宽按钮样式');
assert(mpDraftCss.includes('left: 10px;') && mpDraftCss.includes('width: auto;'), '移动端悬浮操作栏必须由左右边距约束，不能被固定宽度撑出屏幕');
assert(mpDraftCss.includes('/* 桌面端入场动画含 translateX(50%) 用于居中；移动端左右贴边时不能复用。 */\n    animation: none;'), '移动端悬浮操作栏不得继承桌面端的横向位移动画');
assert(mpDraftCss.includes('grid-template-areas:\n      "check title"\n      ". author"\n      ". stats";'), '移动端选帖记录必须使用勾选框与内容分区的卡片布局');
assert(mpDraftCss.includes('width: auto !important;\n    min-width: 0;'), '移动端选帖单元格不得保留桌面表格的全宽规则');
assert(mpDraftCss.includes('tr.post-row') && mpDraftPage.includes("'<tr class=\"post-row '"), '单条和多条真实帖子都必须使用移动卡片布局，不能误判单条帖子为空状态');

console.log('[responsive-boundary] 通过：768px 统一归入移动端，769px 起使用桌面逻辑');
