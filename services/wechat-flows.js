const { pool } = require('../config/database');
const aiService = require('./ai');
const wechatService = require('./wechat');
const https = require('https');
const fs = require('fs');
const path = require('path');
const T = require('./wechat-persona');

/**
 * 微信多步流程状态机
 * 投稿流程：awaiting_title → awaiting_content → awaiting_polish_choice → awaiting_polish → awaiting_image → done
 * 推歌流程：song_name → song_artist → song_intro → song_nickname → song_confirm → done
 */

// ===== 投稿流程 =====
async function handleSubmitFlow(openid, text) {
  try {
    var [rows] = await pool.execute(
      'SELECT step, title, content, polished_content, images FROM wechat_submit_sessions WHERE openid = ? AND updated_at > DATE_SUB(NOW(), INTERVAL 10 MINUTE) ORDER BY updated_at DESC LIMIT 1',
      [openid]
    );
    var s = rows[0];
    if (!s || s.step === 'idle') return null;
  } catch (e) {
    console.error('[flow] handleSubmitFlow 查询失败 openid=' + openid + ' err=' + e.message);
    return null;
  }

  // 全局命令
  if (text === '取消' || text === '算了' || text === 'cancel') {
    await del('wechat_submit_sessions', openid);
    return { text: T.cancel() };
  }
  if (['投稿', '发帖', '我要投稿', '我想发帖'].includes(text)) {
    return await restartSubmit(openid);
  }

  switch (s.step) {
    case 'awaiting_title':
      return await stepTitle(openid, text);
    case 'awaiting_content':
      return await stepContent(openid, text);
    case 'awaiting_polish_choice':
      return await stepPolishChoice(openid, s, text);
    case 'awaiting_polish':
      return await stepPolish(openid, s, text);
    case 'awaiting_image':
      return await stepImage(openid, s, text);
    default:
      return null;
  }
}

async function restartSubmit(openid) {
  try {
    var [users] = await pool.execute('SELECT id FROM users WHERE openid = ?', [openid]);
    if (users.length === 0) return { text: T.submitNeedBind() };
    await del('wechat_submit_sessions', openid);
    await pool.execute(
      'INSERT INTO wechat_submit_sessions (openid, step, created_at, updated_at) VALUES (?, "awaiting_title", NOW(), NOW())',
      [openid]
    );
    return { text: T.submitAskTitle() };
  } catch (e) {
    console.error('[flow] restartSubmit 失败 openid=' + openid + ' err=' + e.message);
    return { text: T.systemError('restartSubmit') };
  }
}

async function stepTitle(openid, text) {
  await pool.execute(
    'UPDATE wechat_submit_sessions SET step = "awaiting_content", title = ?, updated_at = NOW() WHERE openid = ?',
    [text, openid]
  );
  return { text: T.submitAskContent(text) };
}

async function stepContent(openid, text) {
  await pool.execute(
    'UPDATE wechat_submit_sessions SET content = ?, step = "awaiting_polish_choice", updated_at = NOW() WHERE openid = ?',
    [text, openid]
  );
  return { text: T.submitAskPolish() };
}

async function stepPolishChoice(openid, s, text) {
  if (['要', '要的', '要润色', '润色', '好', '好的', '嗯', '是', 'yes'].includes(text)) {
    return await doPolish(openid, s);
  }
  await updateStep(openid, 'awaiting_polish');
  return { text: T.submitSkipPolish(s.title, s.content) };
}

async function doPolish(openid, s) {
  return {
    text: T.submitPolishing(),
    deferred: async function() {
      try {
        var polished = await aiService.getAIReply(
          '请帮我润色这段投稿内容，修正语病和错别字，让表达更通顺自然，但不要改变原意和语气风格，不要添加新内容，直接返回润色后的文字即可。原文：' + s.content,
          openid
        );
        if (polished && polished.trim() !== s.content.trim()) {
          await pool.execute(
            'UPDATE wechat_submit_sessions SET polished_content = ?, step = "awaiting_polish", updated_at = NOW() WHERE openid = ?',
            [polished, openid]
          );
          return { text: T.submitPolishDone(s.content, polished, s.title) };
        }
      } catch (e) {
        console.error('[flow] doPolish AI失败 openid=' + openid + ' err=' + e.message);
      }
      await updateStep(openid, 'awaiting_polish');
      return { text: T.submitPolishFailed(s.title, s.content) };
    }
  };
}

async function stepPolish(openid, s, text) {
  if (['确认', '确认发布', '发布', '提交', '是的', '确定'].includes(text)) {
    var content = s.polished_content || s.content;
    await pool.execute(
      'UPDATE wechat_submit_sessions SET content = ?, polished_content = NULL, step = "awaiting_image", updated_at = NOW() WHERE openid = ?',
      [content, openid]
    );
    return { text: T.submitAskImage(s.title) };
  }
  if (['用润色版', '润色版', '润色'].includes(text) && s.polished_content) {
    await pool.execute(
      'UPDATE wechat_submit_sessions SET content = polished_content, polished_content = NULL, step = "awaiting_polish", updated_at = NOW() WHERE openid = ?',
      [openid]
    );
    return { text: T.submitUsePolished(s.title, s.polished_content) };
  }
  if (['用原文', '原文'].includes(text)) {
    await pool.execute('UPDATE wechat_submit_sessions SET polished_content = NULL, updated_at = NOW() WHERE openid = ?', [openid]);
    return { text: T.submitUseOriginal(s.title, s.content) };
  }
  if (['重写', '重新', '重新开始', '再来'].includes(text)) {
    await pool.execute(
      'UPDATE wechat_submit_sessions SET step = "awaiting_title", title = NULL, content = NULL, updated_at = NOW() WHERE openid = ?',
      [openid]
    );
    return { text: T.submitAskReTitle() };
  }
  return { text: T.submitSkipPolish(s.title, s.content) };
}

async function stepImage(openid, s, text) {
  if (['确认', '确认发布', '发布', '提交', '是的', '确定', '跳过', '不发了', '不用'].includes(text)) {
    return await publishPost(openid);
  }
  if (['重写', '重新', '重新开始', '再来'].includes(text)) {
    await pool.execute(
      'UPDATE wechat_submit_sessions SET step = "awaiting_title", title = NULL, content = NULL, images = NULL, updated_at = NOW() WHERE openid = ?',
      [openid]
    );
    return { text: T.submitAskReTitle() };
  }
  return { text: T.submitAskImage(s.title) };
}

async function publishPost(openid) {
  try {
    var [rows] = await pool.execute('SELECT title, content, images FROM wechat_submit_sessions WHERE openid = ?', [openid]);
    if (rows.length === 0) return { text: T.submitSessionExpired() };
    var sess = rows[0];
    var [cfg] = await pool.execute("SELECT config_value FROM settings WHERE config_key = 'post_review'");
    var needReview = cfg.length === 0 || cfg[0].config_value === 'true';
    var [users] = await pool.execute('SELECT id FROM users WHERE openid = ?', [openid]);
    await pool.execute(
      'INSERT INTO posts (user_id, title, content, images, status, category, ip_address, created_at) VALUES (?, ?, ?, ?, ?, "daily", ?, NOW())',
      [users[0]?.id || null, sess.title, sess.content, sess.images || '[]', needReview ? 'pending' : 'approved', '微信用户']
    );
    await del('wechat_submit_sessions', openid);
    return { text: T.submitSuccess(needReview) };
  } catch (e) {
    console.error('[flow] publishPost 失败 openid=' + openid + ' err=' + e.message);
    return { text: T.submitFail() };
  }
}

// ===== 推歌流程 =====
async function handleSongFlow(openid, text) {
  try {
    var [rows] = await pool.execute(
      'SELECT step, song_name, artist, intro, display_name FROM wechat_song_recs WHERE openid = ? AND step != "idle" AND updated_at > DATE_SUB(NOW(), INTERVAL 15 MINUTE) ORDER BY updated_at DESC LIMIT 1',
      [openid]
    );
    var s = rows[0];
    if (!s) return null;
  } catch (e) {
    console.error('[flow] handleSongFlow 查询失败 openid=' + openid + ' err=' + e.message);
    return null;
  }

  if (text === '取消' || text === 'cancel') {
    await del('wechat_song_recs', openid);
    return { text: T.cancel() };
  }

  switch (s.step) {
    case 'song_name':
      return await stepSongName(openid, text);
    case 'song_artist':
      return await stepSongArtist(openid, text);
    case 'song_intro':
      return await stepSongIntro(openid, text);
    case 'song_nickname':
      return await stepSongNickname(openid, s, text);
    case 'song_confirm':
      return await stepSongConfirm(openid, s, text);
    default:
      return null;
  }
}

async function stepSongName(openid, text) {
  if (text.length > 100) return { text: T.songNameTooLong() };
  await pool.execute(
    'UPDATE wechat_song_recs SET step = "song_artist", song_name = ?, updated_at = NOW() WHERE openid = ?',
    [text, openid]
  );
  return { text: T.songAskArtist(text) };
}

async function stepSongArtist(openid, text) {
  await pool.execute(
    'UPDATE wechat_song_recs SET step = "song_intro", artist = ?, updated_at = NOW() WHERE openid = ?',
    [text === '跳过' ? '' : text, openid]
  );
  return { text: T.songAskIntro() };
}

async function stepSongIntro(openid, text) {
  await pool.execute(
    'UPDATE wechat_song_recs SET step = "song_nickname", intro = ?, updated_at = NOW() WHERE openid = ?',
    [text === '跳过' ? '' : text.substring(0, 500), openid]
  );
  return { text: T.songAskNickname() };
}

async function stepSongNickname(openid, s, text) {
  await pool.execute(
    'UPDATE wechat_song_recs SET step = "song_confirm", display_name = ?, updated_at = NOW() WHERE openid = ?',
    [text === '跳过' ? '' : text.substring(0, 30), openid]
  );
  return { text: T.songConfirm(s.song_name, s.artist) };
}

async function stepSongConfirm(openid, s, text) {
  if (!['确认', '是的'].includes(text)) return { text: T.songConfirmRetry(s.song_name, s.artist) };
  return await confirmSong(openid, s);
}

async function confirmSong(openid, s) {
  try {
    var [nickRows] = await pool.execute(
      'SELECT display_name FROM wechat_song_recs WHERE openid = ? AND step = "song_confirm" AND updated_at > DATE_SUB(NOW(), INTERVAL 15 MINUTE) ORDER BY updated_at DESC LIMIT 1',
      [openid]
    );
    var displayName = '';
    if (nickRows.length > 0 && nickRows[0].display_name) {
      displayName = nickRows[0].display_name;
    } else {
      var [users] = await pool.execute('SELECT nickname FROM users WHERE openid = ?', [openid]);
      displayName = users.length > 0 && users[0].nickname ? users[0].nickname : '';
    }
    var submitter = displayName || '匿名同学';

    var [introRows] = await pool.execute(
      'SELECT intro FROM wechat_song_recs WHERE openid = ? AND step = "song_confirm" AND updated_at > DATE_SUB(NOW(), INTERVAL 15 MINUTE) ORDER BY updated_at DESC LIMIT 1',
      [openid]
    );
    var userIntro = introRows.length > 0 ? (introRows[0].intro || '') : '';

    await pool.execute(
      'INSERT INTO daily_song_recs (song_name, artist, to_whom, message, source, submitter, openid, status, intro, created_at) VALUES (?, ?, ?, ?, "wechat", ?, ?, "pending", ?, NOW())',
      [s.song_name, s.artist || '', '', '', submitter, openid, userIntro]
    );
    await del('wechat_song_recs', openid);

    // 后台异步：AI生成介绍词/歌词/歌曲信息
    triggerBgTasks(openid, s.song_name, s.artist, userIntro);

    return { text: T.songPushSuccess(s.song_name, s.artist) };
  } catch (e) {
    console.error('[flow] confirmSong 失败 openid=' + openid + ' err=' + e.message);
    return { text: T.songPushFail() };
  }
}

function triggerBgTasks(openid, songName, artist, userIntro) {
  (async function() {
    try {
      var [rows] = await pool.execute(
        'SELECT id FROM daily_song_recs WHERE openid = ? AND song_name = ? ORDER BY id DESC LIMIT 1',
        [openid, songName]
      );
      var id = rows.length > 0 ? rows[0].id : null;
      if (!id) return;

      if (!userIntro) {
        try {
          var r = await aiService.generateSongIntro(songName, artist || '');
          if (r && r.intro) await pool.execute('UPDATE daily_song_recs SET intro = ? WHERE id = ?', [r.intro, id]);
          if (r && r.lyrics) await pool.execute('UPDATE daily_song_recs SET lyrics = ? WHERE id = ?', [r.lyrics, id]);
        } catch (e) { console.warn('[flow] generateSongIntro 失败 id=' + id + ' err=' + e.message); }
      }
      try {
        var si = await aiService.searchSongInfo(songName, artist || '');
        if (si) await pool.execute('UPDATE daily_song_recs SET song_info = ? WHERE id = ?', [JSON.stringify(si), id]);
      } catch (e) { console.warn('[flow] searchSongInfo 失败 id=' + id + ' err=' + e.message); }
      try {
        var lr = await aiService.searchSongLyrics(songName, artist || '');
        if (lr && lr.lyrics) await pool.execute('UPDATE daily_song_recs SET lyrics = ? WHERE id = ?', [lr.lyrics, id]);
      } catch (e) { console.warn('[flow] searchSongLyrics 失败 id=' + id + ' err=' + e.message); }
    } catch (e) { console.error('[flow] triggerBgTasks 失败 err=' + e.message); }
  })();
}

// ===== 投稿图片处理 =====
async function handleImageForSubmit(openid, mediaId) {
  try {
    var [rows] = await pool.execute(
      'SELECT step, images FROM wechat_submit_sessions WHERE openid = ? AND step = "awaiting_image" AND updated_at > DATE_SUB(NOW(), INTERVAL 30 MINUTE) ORDER BY updated_at DESC LIMIT 1',
      [openid]
    );
    if (rows.length === 0) return null;

    var token = await wechatService.getAccessToken();
    var imgUrl = 'https://api.weixin.qq.com/cgi-bin/media/get?access_token=' + token + '&media_id=' + mediaId;
    var fileName = 'post_wechat_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8) + '.jpg';
    var savePath = path.join(__dirname, '..', 'public', 'uploads', 'posts', fileName);

    await new Promise(function(resolve, reject) {
      https.get(imgUrl, function(res) {
        if (res.statusCode !== 200) return reject(new Error('HTTP' + res.statusCode));
        var ws = fs.createWriteStream(savePath);
        res.pipe(ws);
        ws.on('finish', function() { ws.close(); resolve(); });
      }).on('error', reject);
    });

    var imgList = JSON.parse(rows[0].images || '[]');
    imgList.push('/uploads/posts/' + fileName);
    await pool.execute('UPDATE wechat_submit_sessions SET images = ?, updated_at = NOW() WHERE openid = ?', [JSON.stringify(imgList), openid]);

    return { text: T.imageSaved(imgList.length) };
  } catch (e) {
    console.error('[flow] handleImageForSubmit 失败 openid=' + openid + ' err=' + e.message);
    return { text: T.imageSaveFailed() };
  }
}

// ===== 工具函数 =====
async function updateStep(openid, step) {
  await pool.execute('UPDATE wechat_submit_sessions SET step = ?, updated_at = NOW() WHERE openid = ?', [step, openid]);
}

async function del(table, openid) {
  await pool.execute('DELETE FROM ' + table + ' WHERE openid = ?', [openid]);
}

module.exports = { handleSubmitFlow, handleSongFlow, handleImageForSubmit };
