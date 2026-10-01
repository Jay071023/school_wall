'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const detail = read('frontend/js/detail.js');
const composer = read('frontend/new-post.html');
const home = read('frontend/index.html');
const radio = read('frontend/radio.html');
const radioScript = read('frontend/js/radio.js');
const songRoutes = read('routes/songs.js');

assert(detail.includes('postData.comments_count = postData.comments.length'), '详情页计数必须以接口返回的评论列表为准');
assert(detail.includes('renderComments(comments, totalCount)') && detail.includes("countEl.textContent = String(count)"), '评论区标题必须在初始和排序渲染时同步数量');
assert(detail.includes("sectionCountEl.textContent = postData.comments_count"), '删除评论后顶部和评论区数量必须同步');

const postCategories = [...composer.matchAll(/class="category-tag[^\"]*"[^>]*data-value="([^\"]+)"/g)].map(match => match[1]);
const homeCategories = new Set([...home.matchAll(/class="filter-tag[^\"]*"[^>]*data-category="([^\"]+)"/g)].map(match => match[1]));
for (const category of postCategories) {
  if (category === 'daily') continue;
  assert(homeCategories.has(category), '发布分类必须可以从首页筛选：' + category);
}

assert(composer.includes('署名与可见范围') && composer.includes('所有访客都能浏览'), '编辑器必须说明署名方式和公开可见范围');
assert(composer.includes('管理人员仍可按审核需要核对发布账号'), '匿名说明不得暗示对管理人员匿名');

assert(radio.includes('今日可提交次数与各播放日期名额分别计算'), '个人每日次数与播放日期名额必须明确区分');
assert(radio.includes('目前不提供候补'), '满额日期必须明确没有候补');
assert(radioScript.includes("remaining === 0 ? ' disabled' : ''") && radioScript.includes('已满 · 暂不支持候补'), '满额日期必须显示状态并禁止选择');
assert(radioScript.includes('Number(selectedDate.remaining) <= 0'), '提交前必须再次拒绝已满日期');
assert(songRoutes.includes("if (Number(countResult[0].cnt) >= Number(slotDate.max_songs))") && songRoutes.includes("message: '该时段点歌已满'"), '服务端仍须以事务中的名额检查为准');

console.log('[feedback-clarity] 通过：评论数、匿名与可见范围、满额点歌提示和分类筛选');
