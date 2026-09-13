'use strict';

const assert = require('assert');

// 此测试只验证纯标题策略；不会请求微信接口或读取线上配置。
process.env.WECHAT_SECRET = process.env.WECHAT_SECRET || 'test-secret';
const { generateArticleTitle, sanitizeArticleText, normalizeDraftArticle, toWechatDraftArticle } = require('../services/mp-draft');

const daily = generateArticleTitle({
  type: 'daily',
  dateInfo: { date: '2026年9月4日' },
  posts: [
    { title: '图书馆的空调终于修好了', content: '第一教学楼也有新通知' },
    { title: '操场夜跑的人变多了' },
    { title: '食堂新品测评' }
  ]
});
assert.match(daily.title, /^校园来信｜/);
assert.match(daily.title, /图书馆的空调终于修好了/);
assert.match(daily.title, /操场夜跑的人变多了/);
assert.match(daily.title, /等3封来信/);
assert.doesNotMatch(daily.title, /每日推送/);
assert.doesNotMatch(daily.digest, /校园新鲜事/);
assert.match(daily.digest, /今天的校园来信/);
assert.strictEqual(daily.meta.type, 'daily');

const mixedDaily = generateArticleTitle({
  type: 'daily',
  posts: [{ title: '到底喜欢到什么程度才算爱' }],
  songs: [{ song_name: '晴天', artist: '周杰伦' }]
});
assert.strictEqual(mixedDaily.title, '一封来信，一首歌｜到底喜欢到什么程度才算爱');
assert.strictEqual(mixedDaily.digest, '关于“到底喜欢到什么程度才算爱”的一封校园来信，和《晴天》—周杰伦一起送达。');
assert.doesNotMatch(mixedDaily.title + mixedDaily.digest, /今晚|校园新鲜事/);

const single = generateArticleTitle({
  type: 'post',
  post: { title: '<b>社团招新</b>\u200B\n本周开始' }
});
assert.strictEqual(single.title, '想和你说｜社团招新 本周开始');
assert.ok(!/[<>\n\u200B]/.test(single.title));

const song = generateArticleTitle({
  type: 'song',
  songs: [
    { song_name: '晴天', artist: '周杰伦' },
    { song_name: '稻香', artist: '周杰伦' },
    { song_name: '海阔天空', artist: 'Beyond' }
  ]
});
assert.strictEqual(song.title, '一首歌的时间｜《晴天》—周杰伦、《稻香》—周杰伦等3首');
assert.match(song.digest, /晴天/);
assert.strictEqual(song.meta.type, 'song');

const nextWeekSongs = generateArticleTitle({
  type: 'weekly-song',
  periodLabel: '下周',
  weekLabel: '9月14日—9月20日',
  songs: [{ song_name: '晴天', artist: '周杰伦' }]
});
assert.strictEqual(nextWeekSongs.title, '下周点歌播放表｜9月14日—9月20日');
assert.match(nextWeekSongs.digest, /^下周待播放 1 首点歌/);

const fallback = generateArticleTitle({
  type: 'post',
  content: '午后的操场有同学在练习社团节目。'
});
assert.match(fallback.title, /午后的操场/);

const noisy = sanitizeArticleText('<script>alert(1)</script>\u0000' + '标题'.repeat(80), 64);
assert.ok(!/[<>\u0000]/.test(noisy));
assert.ok(Array.from(noisy).length <= 64);

// 预览 article 与 draft/add 输入共享标准化后的标题、摘要、正文和来源；
// 视频字段仍在标准化对象中保留，交给既有媒体同步链路处理。
const previewArticle = normalizeDraftArticle({
  title: '<b>晚自习后的操场</b>\n',
  digest: '  同学们在聊夜跑。  ',
  content: '<p>实际发送的正文</p>',
  content_source_url: 'http://localhost:3000/post/42',
  thumb_media_id: 'thumb-id',
  video_url: 'https://example.invalid/video.mp4'
});
const draftInput = toWechatDraftArticle(previewArticle);
assert.strictEqual(draftInput.title, previewArticle.title);
assert.strictEqual(draftInput.digest, previewArticle.digest);
assert.strictEqual(draftInput.content, previewArticle.content);
assert.strictEqual(draftInput.content_source_url, previewArticle.content_source_url);
assert.strictEqual(previewArticle.video_url, 'https://example.invalid/video.mp4');

console.log('[mp-draft-title] 通过：按真实内容生成、歌曲标题、文本净化、预览与草稿字段一致均符合预期');
