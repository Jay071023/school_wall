'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const radioHtml = read('frontend/radio.html');
const radioJs = read('frontend/js/radio.js');
const radioCss = read('frontend/css/radio.css');

assert(radioHtml.includes('id="playlistNotice"'), '点歌页必须提供播放状态通知条');
assert(radioHtml.includes('class="radio-card radio-playlist-card"'), '点歌列表必须有卡片容器');
assert(radioHtml.includes('class="radio-form-card"'), '点歌表单必须有卡片容器');
assert(radioHtml.includes('radio-slot-group'), '播放时段必须与送给谁保持同一桌面网格行');
assert(!radioHtml.includes('id="playlistEmpty"'), '点歌列表不能同时渲染重复的空状态灰框');
assert(radioHtml.indexOf('id="songRecipient"') < radioHtml.indexOf('id="slotCardsGrid"'), '送给谁必须和播放时段处于同一桌面表单行');
assert(radioHtml.indexOf('id="slotCardsGrid"') < radioHtml.indexOf('id="songMessage"'), '祝福语应排在送给谁和播放时段之后');
assert(radioCss.includes('grid-template-columns: minmax(0, 6fr) minmax(0, 4fr)'), '桌面点歌页必须使用6:4双栏栅格');
assert(radioCss.includes('max-width: 1200px'), '桌面点歌页主容器应适度放宽');
assert(radioCss.includes('min-height: 40px') && radioCss.includes('radio-slot-group .slot-cards-grid.radio-state'), '播放时段空状态必须使用紧凑高度');
assert(radioCss.includes('#f97316'), '提交点歌按钮必须使用暖色主题');
assert(radioCss.includes('padding-bottom: calc(90px + env(safe-area-inset-bottom, 0px))'), '移动端主容器必须预留底部安全距离');
assert(radioCss.includes('@media (max-width: 768px)'), '移动端布局必须使用768px断点');
assert(radioHtml.indexOf('class="radio-section playlist-section"') < radioHtml.indexOf('class="radio-section radio-form-section"'), '移动端播放状态必须排在表单之前');
assert(radioHtml.indexOf('class="radio-section radio-form-section"') < radioHtml.indexOf('class="radio-section hot-songs-section"'), '移动端表单必须排在排行榜之前');
assert(radioJs.includes('visibleCount > 0') && radioJs.includes('📢 今日排歌进行中'), '播放列表加载后必须更新通知条');
assert(radioHtml.includes('<link rel="stylesheet" href="/css/radio.css">'), '点歌页必须加载专属样式表');
assert(!radioHtml.includes('id="page-responsive-fix"') && !radioHtml.includes('id="radio-layout-rebuild"'), '点歌页不应保留重复的内联终态样式');
assert(radioHtml.includes('for="songName"') && radioHtml.includes('for="songArtist"') && radioHtml.includes('for="songRecipient"'), '表单标签必须关联输入字段');
assert(radioHtml.includes('id="slotSelectLabel"') && radioHtml.includes('aria-labelledby="slotSelectLabel"'), '播放时段必须提供可访问名称');
assert(radioJs.includes('role="radio"') && radioJs.includes('aria-checked') && radioJs.includes('ArrowRight'), '播放时段必须支持键盘选择并反馈当前状态');
assert(!/class="slot-card-item[^>]*onclick=/.test(radioJs), '播放时段不能只依赖 inline onclick');
assert.strictEqual(radioHtml, read('public/radio.html'), '点歌页面镜像必须一致');
assert.strictEqual(radioJs, read('public/js/radio.js'), '点歌脚本镜像必须一致');
assert.strictEqual(radioCss, read('public/css/radio.css'), '点歌样式镜像必须一致');

console.log('[radio-layout] 通过：移动端安全底距、桌面6:4布局、卡片容器和通知条已收口');
