/**
 * 每日自动生成并发布公众号图文
 * 使用方式：node auto-publish.js
 * 设置定时：crontab -e 添加以下行
 *   0 8 * * * cd /path/to/campus-wall && node auto-publish.js >> logs/auto-publish.log 2>&1
 *   (每天早上8点执行)
 */

const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const siteConfig = require('./lib/site-config');
// QRCode was removed - using local image instead

// 项目根目录
const ROOT = __dirname;
process.chdir(ROOT);

// 加载环境变量
require('dotenv').config({ path: path.join(ROOT, '.env') });
const { pool } = require('./config/database');
const mpDraftService = require('./services/mp-draft');

async function main() {
  // 使用本地图片，不再生成二维码

  // 读取发布配置
  var configPath = path.join(__dirname, 'config', 'auto-publish.json');
  var pubConfig = { hour: 8, minute: 0, enabled: true, lastRun: '' };
  try {
    if (fs.existsSync(configPath)) {
      pubConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch(e) {}

  // 检查是否开启
  if (!pubConfig.enabled) {
    console.log('[' + new Date().toLocaleString('zh-CN') + '] ⏸️ 自动发布已关闭，跳过');
    process.exit(0);
  }

  // 检查当前时间是否匹配
  var now = new Date();
  var curHour = now.getHours();
  var curMin = now.getMinutes();
  var tarHour = pubConfig.hour;
  var tarMin = pubConfig.minute;
  var today = now.toLocaleDateString('zh-CN');

  // 如果今天已经运行过，跳过（防止1小时内多次触发）
  if (pubConfig.lastRun && pubConfig.lastRun.startsWith(today)) {
    console.log('[' + new Date().toLocaleString('zh-CN') + '] ⏭️ 今天(' + today + ')已执行过，跳过');
    process.exit(0);
  }

  // 检查时间是否匹配（允许±2分钟误差，因为cron可能延迟几秒）
  var diffMinutes = Math.abs((curHour * 60 + curMin) - (tarHour * 60 + tarMin));
  if (diffMinutes > 2) {
    console.log('[' + new Date().toLocaleString('zh-CN') + '] ⏳ 当前时间 ' + String(curHour).padStart(2,'0') + ':' + String(curMin).padStart(2,'0') + '，目标 ' + String(tarHour).padStart(2,'0') + ':' + String(tarMin).padStart(2,'0') + '，跳过');
    process.exit(0);
  }

  console.log('[' + new Date().toLocaleString('zh-CN') + '] 🚀 开始自动生成今日精选...');

  // 1. 获取热门帖子 - 优先24h，没有则7天，再没有则全站精华
  var posts = [];
  var sourceLabel = '';
  
  // 尝试24小时
  var [posts24h] = await pool.execute(`
    SELECT p.id, p.title, p.content, p.created_at, p.likes_count,
      p.views as view_count, u.username as author,
      COUNT(DISTINCT c.id) as comment_count, p.images
    FROM posts p
    LEFT JOIN users u ON p.user_id = u.id
    LEFT JOIN comments c ON c.post_id = p.id
    WHERE p.status = 'approved'
      AND p.created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
    GROUP BY p.id
    ORDER BY (p.likes_count * 2 + COUNT(DISTINCT c.id) * 3) DESC
    LIMIT 10
  `);
  
  if (posts24h.length > 0) {
    posts = posts24h;
    sourceLabel = '24小时热门';
  } else {
    // 尝试7天
    var [posts7d] = await pool.execute(`
      SELECT p.id, p.title, p.content, p.created_at, p.likes_count,
        p.views as view_count, u.username as author,
        COUNT(DISTINCT c.id) as comment_count, p.images
      FROM posts p
      LEFT JOIN users u ON p.user_id = u.id
      LEFT JOIN comments c ON c.post_id = p.id
      WHERE p.status = 'approved'
        AND p.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
      GROUP BY p.id
      ORDER BY (p.likes_count * 2 + COUNT(DISTINCT c.id) * 3) DESC
      LIMIT 10
    `);
    if (posts7d.length > 0) {
      posts = posts7d;
      sourceLabel = '本周回顾';
    } else {
      // 全站精华
      var [postsAll] = await pool.execute(`
        SELECT p.id, p.title, p.content, p.created_at, p.likes_count,
          p.views as view_count, u.username as author,
          COUNT(DISTINCT c.id) as comment_count, p.images
        FROM posts p
        LEFT JOIN users u ON p.user_id = u.id
        LEFT JOIN comments c ON c.post_id = p.id
        WHERE p.status = 'approved'
        GROUP BY p.id
        ORDER BY (p.likes_count * 2 + COUNT(DISTINCT c.id) * 3) DESC
        LIMIT 10
      `);
      posts = postsAll;
      sourceLabel = '精华帖回顾';
    }
  }
  
  // 如果全站都没有帖子，尝试加载连载小说
  var storyData = null;
  if (posts.length === 0) {
    storyData = loadStoryChapter(pubConfig);
    sourceLabel = storyData ? '小说连载' : '特别精选';
    if (storyData) {
      console.log('📖 今日无帖子，加载小说连载: 第' + (storyData.index + 1) + '/' + storyData.total + '章 ' + storyData.chapter.title);
    }
  }
  
  console.log('✅ ' + sourceLabel + '：获取到 ' + posts.length + ' 篇帖子');

  // 2. 获取辅助数据
  var [weather, hitokoto, dateInfo] = await Promise.all([
    mpDraftService.getWeather(),
    mpDraftService.getHitokoto(),
    Promise.resolve(mpDraftService.getDateInfo())
  ]);

  // 3. 获取统计数据 + 每周之星 + 点歌 + 历史
  var [stats] = await pool.execute("SELECT COUNT(*) as total FROM posts WHERE status='approved' AND DATE(created_at)=CURDATE()");
  var [categories] = await pool.execute("SELECT category, COUNT(*) as cnt FROM posts WHERE status='approved' GROUP BY category ORDER BY cnt DESC LIMIT 3");
  var [songs] = await pool.execute("SELECT sr.song_name, sr.artist, sr.message, sr.to_whom, sr.is_anonymous, u.username, u.nickname, ts.name as slot_name, ts.start_time, ts.end_time, DATE_FORMAT(sd.play_date,'%m/%d') as play_date, DATE_FORMAT(sd.play_date,'%Y年%m月%d日') as play_date_full FROM song_requests sr LEFT JOIN time_slots ts ON sr.slot_id=ts.id LEFT JOIN slot_dates sd ON sr.slot_date_id=sd.id LEFT JOIN users u ON sr.user_id=u.id WHERE sr.status='approved' ORDER BY sr.created_at DESC LIMIT 3");
  var todayHistory = await mpDraftService.getTodayInHistory();
  
  // 每周之星
  var [weeklyStar] = await pool.execute(`
    SELECT u.id, u.nickname, u.username,
      COUNT(DISTINCT p.id) as post_count,
      COUNT(DISTINCT c.id) as comment_count,
      (COALESCE(SUM(p.likes_count), 0) + COALESCE(SUM(p.comments_count), 0)) as contribution_score
    FROM users u
    LEFT JOIN posts p ON p.user_id = u.id AND p.status = 'approved' AND p.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
    LEFT JOIN comments c ON c.user_id = u.id AND c.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
    WHERE u.role = 'user'
    GROUP BY u.id
    ORDER BY contribution_score DESC
    LIMIT 3
  `);

  // 4. 生成HTML内容
  var html;
  if (storyData) {
    html = buildStoryArticleHTML(storyData, weather, hitokoto, dateInfo, weeklyStar);
  } else {
    html = buildArticleHTML(posts, weather, hitokoto, dateInfo, stats[0], categories, songs, todayHistory, weeklyStar, sourceLabel);
  }
  console.log('✅ 文章HTML生成完成');

  // 5. 上传文章中的图片到微信CDN
  // 提取所有img标签的src
  var imgRegex = /<img[^>]+src=["']([^"']+)["']/g;
  var match;
  var tasks = [];
  while ((match = imgRegex.exec(html)) !== null) {
    var originalSrc = match[1];
    if (originalSrc.indexOf('mmbiz.qpic.cn') >= 0 || originalSrc.indexOf('mmbiz.qlogo.cn') >= 0) continue;
    var uploadUrl = originalSrc;
    if (uploadUrl.startsWith('/')) uploadUrl = siteConfig.siteUrl + uploadUrl;
    tasks.push({ original: originalSrc, upload: uploadUrl });
  }

  if (tasks.length > 0) {
    console.log('🖼️ 发现 ' + tasks.length + ' 张图片，上传到微信CDN...');
    for (var i = 0; i < tasks.length; i++) {
      try {
        var weixinUrl = await mpDraftService.uploadMpImage(tasks[i].upload);
        if (weixinUrl) {
          html = html.split(tasks[i].original).join(weixinUrl);
          console.log('  第' + (i+1) + '张成功');
        }
      } catch (e) {
        console.warn('  第' + (i+1) + '张失败:', e.message);
      }
    }
  }

  // 6. 创建草稿
  var article;
  if (storyData) {
    article = {
      title: '小说连载 · ' + storyData.chapter.title + ' | ' + dateInfo.date,
      author: storyData.chapter.author || siteConfig.mpAuthor,
      digest: '小说连载 · ' + storyData.chapter.title + '。' + (storyData.chapter.content ? storyData.chapter.content.replace(/[\n\r]+/g, '').substring(0, 60) + '...' : ''),
      content: html,
      content_source_url: siteConfig.siteUrl,
      show_cover_pic: 1,
      need_open_comment: 1,
      only_fans_can_comment: 0
    };
  } else {
    article = {
      title: (sourceLabel ? sourceLabel + ' | ' : '') + dateInfo.date,
      author: siteConfig.mpAuthor,
      digest: (sourceLabel || '今日精选') + '：' + posts.length + '条帖子，含天气、每周之星等丰富内容',
      content: html,
      content_source_url: siteConfig.siteUrl,
      show_cover_pic: 1,
      need_open_comment: 1,
      only_fans_can_comment: 0
    };
  }

  var mediaId = await mpDraftService.createDraft([article]);
  console.log('✅ 草稿创建成功！media_id:', mediaId);

  // 更新上次执行时间
  try {
    pubConfig.lastRun = new Date().toLocaleString('zh-CN');
    if (storyData) {
      // 更新到下一章（循环）
      var nextIndex = storyData.index + 1;
      if (nextIndex >= storyData.total) nextIndex = 0;
      pubConfig.currentStoryIndex = nextIndex;
      console.log('📖 下次连载: 第' + (nextIndex + 1) + '/' + storyData.total + '章');
    }
    fs.writeFileSync(configPath, JSON.stringify(pubConfig), 'utf8');
  } catch(e) {}

  console.log('[' + new Date().toLocaleString('zh-CN') + '] 🎉 自动发布完成！');
  process.exit(0);
}

// ===== 连载小说加载 =====
function loadStoryChapter(config) {
  var storiesDir = path.join(__dirname, 'config', 'stories');
  var indexPath = path.join(storiesDir, 'index.json');
  var oldPath = path.join(__dirname, 'config', 'stories.json');
  var index = [];
  
  // 尝试新格式
  if (fs.existsSync(indexPath)) {
    try {
      index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    } catch(e) {
      console.warn('⚠️ 读取故事索引失败:', e.message);
    }
  }
  
  // 兼容旧格式
  if (!Array.isArray(index) || index.length === 0) {
    if (fs.existsSync(oldPath)) {
      try {
        var oldStories = JSON.parse(fs.readFileSync(oldPath, 'utf8'));
        if (Array.isArray(oldStories) && oldStories.length > 0) {
          // 自动迁移
          if (!fs.existsSync(storiesDir)) fs.mkdirSync(storiesDir, { recursive: true });
          index = [];
          oldStories.forEach(function(s, i) {
            fs.writeFileSync(path.join(storiesDir, i + '.json'), JSON.stringify({ title: s.title, content: s.content, author: s.author || siteConfig.mpAuthor + '编辑部' }, null, 2), 'utf8');
            index.push({ file: i + '.json', title: s.title, author: s.author || siteConfig.mpAuthor + '编辑部' });
          });
          fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf8');
          fs.renameSync(oldPath, oldPath + '.bak');
          console.log('📖 旧格式已自动迁移');
        }
      } catch(e) {
        console.warn('⚠️ 迁移旧格式失败:', e.message);
      }
    }
  }
  
  if (!Array.isArray(index) || index.length === 0) {
    console.warn('⚠️ 故事库为空，无法加载连载');
    return null;
  }
  
  var idx = config.currentStoryIndex || 0;
  if (idx >= index.length) idx = 0;
  
  // 读取章节内容
  var chapterFile = index[idx].file;
  var chapterPath = path.join(storiesDir, chapterFile);
  var chapter = null;
  try {
    if (fs.existsSync(chapterPath)) {
      chapter = JSON.parse(fs.readFileSync(chapterPath, 'utf8'));
    }
  } catch(e) {
    console.warn('⚠️ 读取章节文件失败:', chapterFile, e.message);
  }
  
  if (!chapter) {
    console.warn('⚠️ 章节内容为空');
    return null;
  }
  
  return {
    chapter: chapter,
    index: idx,
    total: index.length
  };
}

// ===== 连载小说HTML生成 =====
function buildStoryArticleHTML(storyData, weather, hitokoto, dateInfo, weeklyStar) {
  var today = dateInfo.date;
  var week = dateInfo.week;
  var chapter = storyData.chapter;
  var chapNum = storyData.index + 1;
  var chapTotal = storyData.total;

  // 将故事内容按段落分割
  var paragraphs = (chapter.content || '').replace(/\r\n/g, '\n').split(/\n\n+/);

  var html = '';
  html += '<div style="padding:6px 0;">';

  // ===== 头部 =====
  html += '<table width="100%" cellpadding="0" cellspacing="0"><tr><td style="background:linear-gradient(135deg,#FFF0F5,#F8F0FF);padding:22px 16px 18px;text-align:center;">';
  html += '<div style="color:#A78BFA;font-size:13px;margin-bottom:6px;letter-spacing:2px;">📖 校园小说连载 · 第' + chapNum + '章</div>';
  html += '<div style="color:#FF69B4;font-size:22px;font-weight:bold;letter-spacing:1px;">' + escapeHtml(chapter.title) + '</div>';
  html += '<div style="color:#bbb;font-size:12px;margin-top:8px;">' + today + ' ' + week + ' · ' + escapeHtml(chapter.author || (siteConfig.mpAuthor + '编辑部')) + '</div>';
  html += '<div style="width:40px;height:3px;background:linear-gradient(90deg,#FFB6C1,#A78BFA);margin:14px auto 0;"></div>';
  html += '</td></tr></table>';

  // 天气（优先显示第二天预报）
  var weatherHtml = '';
  if (weather && weather.temperature) {
    weatherHtml += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;"><tr><td style="background:linear-gradient(135deg,#E8F4FD,#E0F0FF);padding:16px;">';
    weatherHtml += '<div style="font-size:13px;color:#888;margin-bottom:10px;font-weight:500;">🌤️ ' + (weather.city || '') + ' 天气预报</div>';
    weatherHtml += '<table width="100%" cellpadding="0" cellspacing="0"><tr>';
    // 今天
    weatherHtml += '<td style="width:50%;text-align:center;padding:4px;border-right:1px dashed #B0D4F1;">';
    weatherHtml += '<div style="font-size:11px;color:#aaa;margin-bottom:4px;">今日</div>';
    weatherHtml += '<div style="font-size:20px;font-weight:bold;color:#4A90D9;">' + (weather.icon || '🌤') + ' ' + (weather.temperature || '') + '</div>';
    weatherHtml += '<div style="font-size:12px;color:#666;margin-top:2px;">' + (weather.weather || '') + '</div>';
    weatherHtml += '<div style="font-size:11px;color:#999;margin-top:4px;">💨 ' + (weather.wind || '') + ' 💧 ' + (weather.humidity || '') + '</div>';
    weatherHtml += '</td>';
    // 明天
    if (weather.tomorrow) {
      weatherHtml += '<td style="width:50%;text-align:center;padding:4px;">';
      weatherHtml += '<div style="font-size:11px;color:#aaa;margin-bottom:4px;">' + (weather.tomorrow.week || '明日') + '</div>';
      weatherHtml += '<div style="font-size:20px;font-weight:bold;color:#4A90D9;">' + (weather.tomorrow.icon || '🌤') + ' ' + (weather.tomorrow.tempRange || '') + '</div>';
      weatherHtml += '<div style="font-size:12px;color:#666;margin-top:2px;">' + (weather.tomorrow.weather || '') + '</div>';
      weatherHtml += '<div style="font-size:11px;color:#999;margin-top:4px;">📍 预报</div>';
      weatherHtml += '</td>';
    } else {
      weatherHtml += '<td style="width:50%;text-align:center;padding:4px;color:#ccc;font-size:12px;">🌤️ 暂无明日预报</td>';
    }
    weatherHtml += '</tr></table></td></tr></table>';
  }
  html += weatherHtml;

  // 一言
  if (hitokoto && hitokoto.text) {
    html += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;"><tr><td style="background:#FFF9F5;padding:16px;border-left:3px solid #A78BFA;">';
    html += '<p style="font-size:14px;color:#888;margin:0 0 6px 0;line-height:1.8;font-style:italic;">💕 "' + escapeHtml(hitokoto.text) + '"</p>';
    html += '<p style="text-align:right;color:#ccc;font-size:11px;margin:0;">—— ' + escapeHtml(hitokoto.from_who || hitokoto.from || '') + '</p></td></tr></table>';
  }

  // ===== 分割线 =====
  html += '<div style="text-align:center;margin:18px 0;color:#e8e8e8;font-size:14px;">✨&nbsp;&nbsp;📖&nbsp;&nbsp;✨</div>';

  // ===== 小说正文 =====
  html += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:18px;"><tr><td style="background:#FFFBFF;padding:20px 16px;">';
  
  // 章节编号装饰
  html += '<div style="text-align:center;margin-bottom:20px;">';
  html += '<div style="display:inline-block;background:linear-gradient(135deg,#FFF0F5,#F8F0FF);padding:6px 20px;border-radius:20px;font-size:12px;color:#A78BFA;letter-spacing:1px;">第' + chapNum + '章</div>';
  html += '</div>';

  // 段落渲染
  for (var pi = 0; pi < paragraphs.length; pi++) {
    var para = paragraphs[pi].trim();
    if (!para) continue;
    // 检测是否为对话（含引号）
    var isDialogue = para.includes('"') || para.includes('"') || para.includes('"');
    if (isDialogue) {
      html += '<p style="text-indent:2em;line-height:2.1;margin-bottom:14px;font-size:15px;color:#6B4C3B;margin-top:0;letter-spacing:0.5px;background:#FFFBF8;padding:8px 14px;border-radius:8px;border-left:3px solid #FFD4B8;">' + escapeHtml(para) + '</p>';
    } else {
      html += '<p style="text-indent:2em;line-height:2.1;margin-bottom:14px;font-size:15px;color:#444;margin-top:0;letter-spacing:0.5px;">' + escapeHtml(para) + '</p>';
    }
  }

  // 未完待续
  if (chapNum < chapTotal) {
    html += '<div style="text-align:center;margin:24px 0 10px 0;">';
    html += '<div style="display:inline-block;background:#FFF0F5;padding:8px 24px;border-radius:12px;font-size:13px;color:#FF69B4;">💫 未完待续 · 明天同一时间见</div>';
    html += '</div>';
    html += '<div style="text-align:center;font-size:12px;color:#ccc;margin-top:6px;">📖 明天继续更新第' + (chapNum + 1) + '章</div>';
  }

  html += '</td></tr></table>';

  // ===== 每周之星 =====
  if (weeklyStar && weeklyStar.length > 0) {
    var medals = ['🥇', '🥈', '🥉'];
    html += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;"><tr><td style="background:#FFF9F9;padding:14px 14px 18px;">';
    html += '<div style="font-size:13px;color:#999;margin-bottom:10px;">⭐ 每周之星</div>';
    html += '<table width="100%" cellpadding="0" cellspacing="0"><tr>';
    for (var wi = 0; wi < weeklyStar.length; wi++) {
      var w = weeklyStar[wi];
      var wName = w.nickname || w.username || '同学';
      html += '<td style="text-align:center;width:' + (100 / weeklyStar.length) + '%;padding:4px;">';
      html += '<div style="font-size:20px;">' + (medals[wi] || '🏅') + '</div>';
      html += '<div style="font-weight:600;font-size:13px;color:#555;margin-top:4px;">' + escapeHtml(wName) + '</div>';
      html += '<div style="font-size:11px;color:#bbb;margin-top:2px;">📝' + (w.post_count || 0) + ' 💬' + (w.comment_count || 0) + '</div>';
      html += '</td>';
    }
    html += '</tr></table></td></tr></table>';
  }

  // ===== 引流语 =====
  html += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;"><tr><td style="background:#FFF8F0;padding:16px;border-radius:12px;">';
  html += '<div style="font-size:13px;color:#D4876A;line-height:1.8;text-align:center;">';
  html += '📢 今日校园暂无新投稿～<br>';
  html += '墙墙准备了一篇暖心小说，希望你喜欢 💕<br><br>';
  html += '📤 如果觉得不错，<strong style="color:#FF6B9D;">欢迎分享给同学和朋友</strong><br>';
  html += '📝 有想说的？来 <strong>' + siteConfig.siteUrl + '</strong> 投稿吧！<br>';
  html += '你的每一条分享，都可能成为明天的推送内容 ✨';
  html += '</div></td></tr></table>';

  // ===== 底部 =====
  html += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;"><tr><td style="background:linear-gradient(135deg,#FFF0F5,#FFE4E1);padding:24px 20px;text-align:center;border-radius:16px;">';
  html += '<div style="font-size:18px;color:#FF69B4;font-weight:bold;margin-bottom:6px;">🎉 更多校园精彩</div>';
  html += '<div style="font-size:13px;color:#DDA0DD;margin-bottom:16px;">扫码进入 · 发现身边的新鲜事</div>';
  html += '<table align="center" style="margin:0 auto;"><tr><td style="background:linear-gradient(135deg,#FF69B4,#FFB6C1);padding:4px;border-radius:16px;">';
  html += '<table style="width:100%;background:#fff;border-radius:12px;"><tr><td style="padding:12px;">';
  html += '<img src="' + siteConfig.siteUrl + '/images/gzh.jpg" style="width:200px;height:200px;display:block;border-radius:6px;margin:0 auto;" alt="校园墙二维码">';
  html += '</td></tr></table>';
  html += '</td></tr></table>';
  html += '<p style="color:#bbb;font-size:12px;margin:14px 0 4px 0;letter-spacing:1px;">📱 微信扫一扫 · 发现更多精彩</p>';
  html += '<p style="color:#FF69B4;font-size:13px;font-weight:bold;word-break:break-all;letter-spacing:0.5px;">' + siteConfig.siteUrl + '</p>';
  html += '<div style="width:40px;height:2px;background:#FFB6C1;margin:12px auto 0;border-radius:2px;"></div>';
  html += '</td></tr></table>';
  html += '<p style="text-align:center;color:#ddd;font-size:12px;margin-top:18px;">© ' + dateInfo.year + ' ' + siteConfig.mpAuthor + ' · 💕</p>';
  html += '</div>';

  return html;
}

// ===== 文章HTML生成（与 routes/mp-draft.js 中的 generateCardHTML 保持一致） =====
function buildArticleHTML(posts, weather, hitokoto, dateInfo, stats, categories, songs, todayHistory, weeklyStar, sourceLabel) {
  var today = dateInfo.date;
  var week = dateInfo.week;

  var html = '';
  html += '<div style="padding:6px 0;">';

  // 头部
  html += '<table width="100%" cellpadding="0" cellspacing="0"><tr><td style="background:#FFF0F5;padding:22px 16px 18px;text-align:center;">';
  html += '<div style="color:#FF69B4;font-size:24px;font-weight:bold;letter-spacing:2px;">🌸 今日校园精选</div>';
  html += '<div style="color:#bbb;font-size:13px;margin-top:8px;">' + today + ' ' + week + '</div>';
  html += '<div style="width:40px;height:3px;background:#FFB6C1;margin:14px auto 0;"></div></td></tr></table>';

  // 天气
  if (weather && weather.temperature) {
    html += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;"><tr><td style="background:#E0F0FF;padding:16px;">';
    html += '<table width="100%" cellpadding="0" cellspacing="0"><tr>';
    html += '<td style="font-size:24px;font-weight:bold;color:#4A90D9;padding:0;">' + (weather.icon || '🌤') + ' ' + (weather.temperature || '') + '</td>';
    html += '<td style="font-size:13px;color:#666;text-align:right;padding:0;line-height:1.7;">📍 ' + (weather.city || '') + '<br>💨 ' + (weather.wind || '') + '<br>💧 ' + (weather.humidity || '') + '</td>';
    html += '</tr></table>';
    html += '<div style="font-size:14px;color:#555;margin-top:6px;">' + (weather.weather || '') + '</div></td></tr></table>';
  }

  // 一言
  if (hitokoto && hitokoto.text) {
    html += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;"><tr><td style="background:#FFF9F5;padding:16px;border-left:3px solid #FFB6C1;">';
    html += '<p style="font-size:15px;color:#666;margin:0 0 8px 0;line-height:1.9;font-style:italic;">💕 "' + hitokoto.text + '"</p>';
    html += '<p style="text-align:right;color:#ccc;font-size:12px;margin:0;">—— ' + (hitokoto.from_who || hitokoto.from || '') + '</p></td></tr></table>';
  }

  // 统计
  if (stats && stats.total > 0) {
    html += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;"><tr><td style="background:#F0FFF0;padding:14px;text-align:center;">';
    html += '<div style="font-size:14px;color:#666;line-height:1.6;">📊 今日校园 · 共 <strong style="color:#43e97b;font-size:18px;">' + stats.total + '</strong> 篇新帖子</div></td></tr></table>';
  }

  // 热门分类
  if (categories && categories.length > 0) {
    var catNames = { 'daily':'日常', 'confession':'表白', 'help':'求助', 'secondhand':'二手', 'club':'社团', 'other':'其他' };
    var catEmoji = { '日常':'🌸', '表白':'💕', '求助':'🆘', '二手':'🛍️', '社团':'🎪', '其他':'📌' };
    html += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;"><tr><td style="background:#FFFFF0;padding:12px 14px;">';
    html += '<div style="font-size:13px;color:#999;margin-bottom:6px;">🏷️ 热门分类</div><div style="font-size:14px;color:#666;line-height:1.8;">';
    for (var ci = 0; ci < categories.length; ci++) {
      var cName = catNames[categories[ci].category] || categories[ci].category;
      html += (ci > 0 ? '&nbsp;&nbsp;&nbsp;·&nbsp;&nbsp;&nbsp;' : '') + (catEmoji[cName] || '📌') + ' ' + cName + ' <strong style="color:#FFB6C1;font-size:14px;">' + categories[ci].cnt + '</strong>';
    }
    html += '</div></td></tr></table>';
  }

  // 历史的今天
  if (todayHistory && todayHistory.title) {
    html += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;"><tr><td style="background:#F8F0FF;padding:12px 14px;">';
    html += '<div style="font-size:13px;color:#999;margin-bottom:5px;">📜 历史上的今天</div>';
    html += '<div style="font-size:14px;color:#666;line-height:1.7;">' + todayHistory.title + '</div></td></tr></table>';
  }

  // 每周之星
  if (weeklyStar && weeklyStar.length > 0) {
    var medals = ['🥇', '🥈', '🥉'];
    html += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;"><tr><td style="background:#FFF9F9;padding:14px 14px 18px;">';
    html += '<div style="font-size:13px;color:#999;margin-bottom:10px;">⭐ 每周之星</div>';
    html += '<table width="100%" cellpadding="0" cellspacing="0"><tr>';
    for (var wi = 0; wi < weeklyStar.length; wi++) {
      var w = weeklyStar[wi];
      var wName = w.nickname || w.username || '同学';
      html += '<td style="text-align:center;width:' + (100 / weeklyStar.length) + '%;padding:4px;">';
      html += '<div style="font-size:20px;">' + (medals[wi] || '🏅') + '</div>';
      html += '<div style="font-weight:600;font-size:13px;color:#555;margin-top:4px;">' + escapeHtml(wName) + '</div>';
      html += '<div style="font-size:11px;color:#bbb;margin-top:2px;">📝' + (w.post_count || 0) + ' 💬' + (w.comment_count || 0) + '</div>';
      html += '</td>';
    }
    html += '</tr></table></td></tr></table>';
  }

  // 点歌
  if (songs && songs.length > 0) {
    html += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;"><tr><td style="background:#FFF0F5;padding:12px 14px;">';
    html += '<div style="font-size:13px;color:#999;margin-bottom:6px;">🎵 最近点歌</div>';
    for (var si = 0; si < songs.length; si++) {
      var s = songs[si];
      var authorStr = s.is_anonymous ? '匿名同学' : (s.nickname || s.username || '同学');
      html += '<div style="border-top:' + (si > 0 ? '1px dashed #FFD1DC;' : 'none;') + ';padding:8px 0;">';
      html += '<div style="font-size:14px;color:#555;line-height:1.6;">🎶 <strong>' + escapeHtml(s.song_name || '') + '</strong>' + (s.artist ? ' - <span style="color:#aaa;">' + escapeHtml(s.artist) + '</span>' : '') + '</div>';
      html += '<div style="font-size:12px;color:#bbb;margin-top:3px;line-height:1.5;">';
      if (s.slot_name || s.play_date) html += '📅 ' + escapeHtml(s.slot_name || '') + (s.play_date ? ' · ' + escapeHtml(s.play_date) : '') + (s.start_time && s.end_time ? ' ' + escapeHtml(s.start_time.substring(0,5) + '-' + s.end_time.substring(0,5)) : '');
      if (s.to_whom) html += ' &nbsp;💝 ' + escapeHtml(s.to_whom);
      html += ' &nbsp;👤 ' + escapeHtml(authorStr);
      html += '</div></div>';
    }
    html += '</td></tr></table>';
  }

  html += '<div style="text-align:center;margin:22px 0;color:#e8e8e8;font-size:14px;">✨&nbsp;&nbsp;💕&nbsp;&nbsp;✨</div>';

  // 帖子
  posts.forEach(function(p, i) {
    var colors = ['#FFB6C1','#DDA0DD','#87CEEB','#98FB98','#FFD700'];
    var bgColors = ['#FFF0F5','#F8F0FF','#F0F8FF','#F0FFF0','#FFFFF0'];
    var c = colors[i % colors.length];
    var bg = bgColors[i % bgColors.length];
    var allImgs = [];
    try { if (p.images) { var parsed = JSON.parse(p.images); if (Array.isArray(parsed)) allImgs = parsed; } } catch(e) {}
    var coverImgs = '';
    for (var ii = 0; ii < allImgs.length; ii++) {
      coverImgs += (ii > 0 ? '<div style="border-top:1px dashed #eee;margin:8px 0;"></div>' : '') + '<img src="' + allImgs[ii] + '" style="width:100%;" alt="封面">';
    }
    var content = (p.content || '').length > 200 ? p.content.substring(0, 200) + '...' : (p.content || '');

    html += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:18px;"><tr><td style="border-top:3px solid ' + c + ';background:' + bg + ';padding:16px;">';
    html += '<div style="color:' + c + ';font-weight:bold;font-size:13px;margin-bottom:6px;">#' + (i+1) + ' · 热门帖子</div>';
    html += '<div style="font-weight:bold;font-size:18px;color:#333;margin-bottom:8px;line-height:1.4;">' + escapeHtml(p.title || '无标题') + '</div>';
    html += coverImgs;
    html += '<p style="font-size:15px;color:#555;margin:12px 0 0 0;line-height:1.9;">' + escapeHtml(content) + '</p>';
    html += '<div style="font-size:13px;color:#bbb;margin-top:12px;padding-top:10px;border-top:1px solid #eee;line-height:1.6;">';
    html += '👤 ' + escapeHtml(p.author || '匿名同学') + '&nbsp;&nbsp;&nbsp;❤️ ' + (p.like_count || 0) + '&nbsp;&nbsp;&nbsp;💬 ' + (p.comment_count || 0) + '</div></td></tr></table>';
  });

  // 引流语
  html += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;"><tr><td style="background:#FFF8F0;padding:16px;border-radius:12px;">';
  html += '<div style="font-size:13px;color:#D4876A;line-height:1.8;text-align:center;">';
  html += '📤 如果觉得不错，<strong style="color:#FF6B9D;">欢迎分享给同学和朋友</strong><br>';
  html += '📝 有想说的？来 <strong>' + siteConfig.siteUrl + '</strong> 投稿吧！<br>';
  html += '你的每一条分享，都可能成为明天的推送内容 ✨';
  html += '</div></td></tr></table>';

  // 底部
  html += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;"><tr><td style="background:linear-gradient(135deg,#FFF0F5,#FFE4E1);padding:24px 20px;text-align:center;border-radius:16px;">';
  html += '<div style="font-size:18px;color:#FF69B4;font-weight:bold;margin-bottom:6px;">🎉 更多校园精彩</div>';
  html += '<div style="font-size:13px;color:#DDA0DD;margin-bottom:16px;">扫码进入 · 发现身边的新鲜事</div>';
  html += '<table align="center" style="margin:0 auto;"><tr><td style="background:linear-gradient(135deg,#FF69B4,#FFB6C1);padding:4px;border-radius:16px;">';
  html += '<table style="width:100%;background:#fff;border-radius:12px;"><tr><td style="padding:12px;">';
  html += '<img src="' + siteConfig.siteUrl + '/images/gzh.jpg" style="width:200px;height:200px;display:block;border-radius:6px;margin:0 auto;" alt="校园墙二维码">';
  html += '</td></tr></table>';
  html += '</td></tr></table>';
  html += '<p style="color:#bbb;font-size:12px;margin:14px 0 4px 0;letter-spacing:1px;">📱 微信扫一扫 · 发现更多精彩</p>';
  html += '<p style="color:#FF69B4;font-size:13px;font-weight:bold;word-break:break-all;letter-spacing:0.5px;">' + siteConfig.siteUrl + '</p>';
  html += '<div style="width:40px;height:2px;background:#FFB6C1;margin:12px auto 0;border-radius:2px;"></div>';
  html += '</td></tr></table>';
  html += '<p style="text-align:center;color:#ddd;font-size:12px;margin-top:18px;">© ' + dateInfo.year + ' ' + siteConfig.mpAuthor + ' · 💕</p>';
  html += '</div>';

  return html;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

main().catch(function(err) {
  console.error('[' + new Date().toLocaleString('zh-CN') + '] ❌ 自动发布失败:', err.message);
  console.error(err.stack);
  process.exit(1);
});
