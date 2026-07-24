/**
 * 微信公众号回复文案 — 统一「学姐」语气
 * 纯文本模板，不含任何数据库或业务逻辑
 * 改语气只改这一个文件
 */

var SITE = 'https://wall.jay23.cn';

module.exports = {
  // ===== 通用 =====
  greet: function(name) {
    return '嗨 ' + name + '～我是墙墙，嘉二校园墙的学姐助手！有什么可以帮你的吗？🌸\n\n回复「帮助」看看我能做什么吧~';
  },

  help: function() {
    return '🌸 学姐小助手 · 功能菜单\n\n' +
      '📝 **投稿** —— 跟我说「投稿」就能在微信里直接发帖~\n' +
      '🎵 **校园点歌** —— 想去广播站放歌？去网站操作哦 👉 ' + SITE + '/radio\n' +
      '🎶 **推歌** —— 有好歌想分享到公众号每日图文？跟我说「推歌」~\n' +
      '🔗 **绑定微信** —— 回复「绑定」把账号和微信连起来\n' +
      '🔑 **找回密码** —— 回复「找回密码」重置\n' +
      '🌤️ **天气** —— 回复「天气」看看今天冷不冷\n\n' +
      '💬 或者直接跟我聊天也行~ 有什么事尽管说！';
  },

  noActiveFlow: function() {
    return '诶？现在没有进行中的操作哦😅\n\n📝 想发帖就说「投稿」\n🎶 想推荐歌曲就说「推歌」\n📖 回复「帮助」看全部功能~';
  },

  tooLong: function() {
    return '哇，好长呀😅 我有点看不过来~\n\n要不简化一下跟我说？或者直接说「投稿」来发帖哦！\n\n🌐 ' + SITE;
  },

  aiFallback: function() {
    return '不好意思呀，我现在有点卡卡的😅\n\n📝 发「投稿」可以发帖\n🎶 发「推歌」推荐歌曲到每日图文\n📖 发「帮助」查看所有功能\n🌐 ' + SITE;
  },

  // ===== 投稿 =====
  submitNeedBind: function() {
    return '🔗 发帖前需要先绑定账号哦~\n\n1️⃣ 打开 ' + SITE + '\n2️⃣ 登录你的账号\n3️⃣ 进入「个人中心」→「绑定微信」\n4️⃣ 完成绑定后对我说「投稿」就可以啦！';
  },

  submitAskTitle: function() {
    return '📝 好的！请告诉我你想要发布的**标题**是什么？\n\n（标题不要太长哦~ 回复「取消」可以随时终止）';
  },

  submitAskContent: function(title) {
    return '📝 标题：「' + title + '」\n\n好的！现在请告诉我**内容**是什么？✏️\n\n（回复「取消」可以随时终止投稿）';
  },

  submitAskPolish: function() {
    return '✏️ 内容已收到！要不要让 AI 润色一下？\n\n✅ 回复「要」让学姐帮忙润色\n❌ 回复「不要」直接使用原文';
  },

  submitPolishing: function() {
    return '⏳ 学姐正在帮你润色，请稍等...';
  },

  submitPolishDone: function(original, polished, title) {
    return '✨ AI润色完成！请选择：\n\n📝 原文：\n' + original.substring(0, 150) + '\n\n✨ 润色版：\n' + polished.substring(0, 150) + '\n\n✅ 回复「确认」使用润色版\n📄 回复「原文」使用原版\n🔄 回复「重写」重新填\n❌ 回复「取消」放弃';
  },

  submitPolishFailed: function(title, content) {
    return '✏️ AI暂时忙不过来，咱们直接发布：\n\n📌 标题：' + title + '\n💬 内容：' + content.substring(0, 100) + (content.length > 100 ? '...' : '') + '\n\n✅ 回复「确认」提交\n🔄 回复「重写」重新来\n❌ 回复「取消」放弃';
  },

  submitSkipPolish: function(title, content) {
    return '📄 好的，直接用原文发布：\n\n📌 标题：' + title + '\n💬 内容：' + content.substring(0, 100) + (content.length > 100 ? '...' : '') + '\n\n✅ 回复「确认」提交\n🔄 回复「重写」重新来\n❌ 回复「取消」放弃';
  },

  submitUsePolished: function(title, content) {
    return '✅ 已使用润色版！\n\n📌 标题：' + title + '\n💬 润色后：' + content.substring(0, 100) + '\n\n✅ 回复「确认」提交\n🔄 回复「重写」重来\n❌ 回复「取消」放弃';
  },

  submitUseOriginal: function(title, content) {
    return '📄 已使用原文！\n\n📌 标题：' + title + '\n💬 内容：' + content.substring(0, 100) + '\n\n✅ 回复「确认」提交\n🔄 回复「重写」重来\n❌ 回复「取消」放弃';
  },

  submitAskReTitle: function() {
    return '好的，重新开始！请告诉我**标题**是什么？📝';
  },

  submitAskImage: function(title) {
    return '📸 最后一步！可以发图片过来一起发布（可选，可发多张）；或者直接回复「确认」完成投稿~\n📌 标题：' + title;
  },

  submitSessionExpired: function() {
    return '诶，投稿会话好像过期了😅 重新发「投稿」开始吧~';
  },

  submitSuccess: function(needReview) {
    return needReview
      ? '🎉 投稿成功！已提交审核~\n\n审核通过后就能在墙上看到你的帖子啦！去 ' + SITE + ' 看看吧~'
      : '🎉 投稿成功！帖子已直接发布~\n去 ' + SITE + ' 看看吧！';
  },

  submitFail: function() {
    return '😅 投稿时出了点问题，稍后再试试？\n或者去 ' + SITE + ' 直接发帖~';
  },

  // ===== 推歌（公众号每日图文）=====
  songStartPush: function() {
    return '🎶 每日推歌 —— 推荐歌曲到公众号每日图文\n\n请告诉学姐想推荐的**歌曲名**是什么？🎵\n\n（回复「取消」可以随时终止）';
  },

  songAskArtist: function(name) {
    return '🎵 收到！《' + name + '》\n\n接下来请告诉学姐是谁演唱的？\n（回复「跳过」可不填）';
  },

  songAskIntro: function() {
    return '✍️ 写一段推荐语吧~\n\n用几句话说说你为什么推荐这首歌，或者这首歌让你想到了什么。\n\n（回复「跳过」跳过，学姐帮你写~）';
  },

  songAskNickname: function() {
    return '😊 最后一步！你希望显示的名字是什么？\n\n（如「小明」、「高三学姐」等，回复「跳过」使用默认昵称）';
  },

  songConfirm: function(name, artist) {
    var info = '🎵 ' + name + (artist ? ' - ' + artist : '');
    return '━━━━━━━━━━━━━━\n' + info + '\n━━━━━━━━━━━━━━\n\n确认推荐这首歌曲吗？\n✅ 回复「确认」发布\n❌ 回复「取消」重填';
  },

  songConfirmRetry: function(name, artist) {
    var info = '🎵 ' + name + (artist ? ' - ' + artist : '');
    return '😅 请回复「确认」发布，或「取消」重填\n\n' + info;
  },

  songNameTooLong: function() {
    return '😅 歌曲名太长了，请简化一下~';
  },

  songPushSuccess: function(name, artist) {
    var info = '🎵 ' + name + (artist ? ' - ' + artist : '');
    return '🎉 推歌成功！\n\n' + info + '\n\n你的推荐有机会出现在每日图文推送中哦~ 让更多人听到这首歌吧！🎶\n\n🌐 ' + SITE;
  },

  songPushFail: function() {
    return '😅 提交失败了，稍后再试试？';
  },

  // ===== 点歌（校园广播） =====
  radioSongGuide: function() {
    return '🎵 校园广播站点歌\n\n在校园广播播放歌曲需要通过网站操作哦~\n\n👇 点击下方链接打开点歌页面：\n🌐 ' + SITE + '/radio\n\n💡 如果是想推荐歌曲到**公众号每日图文**，回复「推歌」即可~';
  },

  // ===== 绑定 =====
  bindGuide: function() {
    return '🔗 微信绑定教程\n\n' +
      '1️⃣ 打开 ' + SITE + '\n' +
      '2️⃣ 登录你的账号\n' +
      '3️⃣ 进入「个人中心」→「绑定微信」\n' +
      '4️⃣ 扫码即可完成绑定\n\n' +
      '绑定后可以接收评论、点赞通知哦~';
  },

  bindSuccess: function() {
    return '✅ 绑定成功！🎉\n\n现在你可以直接对学姐说「投稿」发帖啦~\n或者去 ' + SITE + ' 逛逛吧~';
  },

  bindCodeInvalid: function() {
    return '❌ 验证码无效或已过期，请登录网站重新获取绑定验证码~\n🌐 ' + SITE;
  },

  bindAlreadyBound: function() {
    return '❌ 这个微信已被其他账号绑定了，请先解绑再试~';
  },

  bindError: function() {
    return '😅 绑定出了点问题，请重新获取验证码试试~';
  },

  // ===== 注册 =====
  regCodeInvalid: function() {
    return '❌ 注册验证码无效或已过期，请登录网站重新获取~\n🌐 ' + SITE;
  },

  regAlreadyBound: function() {
    return '❌ 这个微信已绑定其他账号了，无需重新注册哦~\n直接去 ' + SITE + ' 登录吧~';
  },

  regCodeConfirm: function() {
    return '✅ 验证码已确认！🎉\n\n请回到注册页面点击「验证并注册」即可完成注册~\n🌐 ' + SITE + '/register';
  },

  regError: function() {
    return '😅 验证码处理出了点问题，请重新获取试试~';
  },

  // ===== 找回密码 =====
  resetPasswordNotBound: function() {
    return '❌ 你的微信未绑定任何账号哦~\n\n请先在网站上登录后，在「个人中心」→「绑定微信」完成绑定~\n🌐 ' + SITE;
  },

  resetPasswordCode: function(nickname, code) {
    return '🔑 密码重置验证\n\n' +
      '你好 ' + nickname + '！\n' +
      '你的重置验证码是：\n\n' +
      '📌 ' + code + '\n\n' +
      '⚠️ 请在10分钟内使用\n\n' +
      '👇 打开下方链接，输入验证码重置密码：\n' +
      '🌐 ' + SITE + '/reset-password?code=' + code;
  },

  resetPasswordError: function() {
    return '😅 操作出了点问题，请稍后再试~';
  },

  // ===== 天气 =====
  weather: function(city, temperature, weather, wind, humidity) {
    return '🌤️ ' + city + ' 今日天气\n\n' +
      '🌡️ 气温：' + temperature + '\n' +
      '☁️ 天气：' + weather + '\n' +
      '💨 风力：' + wind + '\n' +
      '💧 湿度：' + humidity;
  },

  weatherUnavailable: function() {
    return '🌤️ 当前天气暂时获取不到，去 ' + SITE + ' 看看吧~';
  },

  weatherError: function() {
    return '🌤️ 天气服务暂时不可用~';
  },

  // ===== 非文本消息 =====
  imageReply: function() {
    var tips = [
      '这张图看起来好有意思呀！🖼️',
      '哇塞！这是谁拍的/画的？太强了！🌟',
      '这图我存了！嘿嘿~ 📸',
      '好康好康！多发点（疯狂暗示）👀',
    ];
    return '🖼️ ' + tips[Math.floor(Math.random() * tips.length)] +
      '\n\n不过我现在还看不懂图片内容😅 发文字跟我聊天吧~\n\n' +
      '🔹 回复「帮助」查看所有功能\n📤 或者去 ' + SITE + ' 发帖';
  },

  voiceReply: function() {
    var tips = [
      '哎呀我这耳朵不太好使😅',
      '好像听到了什么有趣的东西~👂',
      '抱歉我还没学会听语音呢🙉',
    ];
    return '🎤 ' + tips[Math.floor(Math.random() * tips.length)] +
      '\n\n暂时听不懂语音消息啦，发文字跟我聊天吧！\n\n' +
      '🔹 回复「帮助」查看所有功能';
  },

  locationReply: function() {
    var tips = [
      '就知道你在那儿！🧐',
      '收到定位！我闻到了嘉二的气息~🏫',
      '原来你在这里呀！🗺️',
    ];
    return '📍 ' + tips[Math.floor(Math.random() * tips.length)] +
      '\n\n不过我不会追踪你的位置啦，放心~😄\n回复关键词跟我聊天吧！\n\n' +
      '🌐 ' + SITE;
  },

  linkReply: function() {
    var tips = [
      '这个链接看起来不错！🔗',
      '让我康康！emmm打不开😅',
      '收到一个神秘链接~ 👀',
    ];
    return '🔗 ' + tips[Math.floor(Math.random() * tips.length)] +
      '\n\n我暂时不能自动打开链接啦😅\n你可以自己去看看哦~\n\n' +
      '🔹 回复「帮助」查看所有功能\n🌐 或者来 ' + SITE + ' 逛逛';
  },

  // ===== 事件 =====
  welcome: function() {
    return '👋 欢迎关注嘉二校园墙！我是墙墙，你的学姐助手~🌸\n\n可以直接跟我聊天，或者去 ' + SITE + ' 逛逛哦~\n投稿、吃瓜、点歌都行~ 有什么想问的尽管说！';
  },

  cancel: function() {
    return '好的，已取消~ 想找学姐的时候随时来呀！😊\n\n🌐 ' + SITE;
  },

  imageSaved: function(count) {
    return '✅ 图片已保存！已收到 ' + count + ' 张图片~\n可以继续发图，或回复「确认」完成投稿 📤';
  },

  imageSaveFailed: function() {
    return '😅 图片上传失败了，再试一次？或者回复「确认」跳过图片直接发布~';
  },

  // ===== 错误 =====
  systemError: function(ctx) {
    return '😅 出了点小问题（' + ctx + '），再试一次？或者去 ' + SITE + ' 看看吧~';
  },
};
