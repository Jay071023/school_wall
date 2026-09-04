'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const detail = read('frontend/js/detail.js');
const detailEmojis = read('frontend/js/detail-emojis.js');
const detailCss = read('frontend/css/style.css');
const detailHtml = read('frontend/post-detail.html');

assert(detail.includes("searchUsers('', true)"), '详情页手动 @ 必须请求空查询的最近用户');
assert(detail.includes('data-username=') && detailEmojis.includes('data-username='), '@候选项必须携带可插入的用户名 ID');
assert(detail.includes('window.CampusWallMentionedUsers'), '评论提交和 @ 选择必须共享提及用户状态');
assert(detailEmojis.includes('document.getElementById(\'commentInput\')'), '表情/@模块必须通过 DOM 获取评论输入框');
assert(detailEmojis.includes('!window.__detailMentionInputBound'), '表情/@模块不得重复绑定详情页 @监听');
assert(detailCss.includes('.comment-footer-left'), '评论工具和匿名开关必须使用左侧工具组');
assert(detailCss.includes('body.post-detail-page .comment-footer-left') && detailCss.includes('grid-column: 1;'), '移动端匿名工具组必须左对齐');
assert(detailCss.includes('z-index: 12000 !important'), '表情浮层必须位于评论上方内容之上');
assert(detailCss.includes('body.post-detail-page .comment-section,') && detailCss.includes('overflow: visible;'), '评论浮层容器不得裁剪表情/@面板');
assert(!detailCss.includes('float-deco-side'), '详情页不得保留左侧来回漂浮装饰');
assert(detailHtml.includes('class="comment-footer-left"'), '详情页 HTML 必须包含评论左侧工具组');

assert.strictEqual(detail, read('public/js/detail.js'), '详情脚本镜像必须一致');
assert.strictEqual(detailEmojis, read('public/js/detail-emojis.js'), '表情/@脚本镜像必须一致');
assert.strictEqual(detailCss, read('public/css/style.css'), '详情样式镜像必须一致');
assert.strictEqual(detailHtml, read('public/post-detail.html'), '详情页面镜像必须一致');

console.log('[detail-interactions] 通过：评论布局、表情浮层、@用户名插入和详情滚动规则已收口');
