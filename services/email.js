/**
 * 邮件发送服务 - ✨ 卡哇伊风格邮件模板
 * 所有通知函数统一通过 notifyUser() 分发
 */

const nodemailer = require('nodemailer');
const { escapeHtml } = require('./html-utils');

async function ensureEmailLogsTable() {
  try {
    const { pool } = require('../config/database');
    await pool.execute(`CREATE TABLE IF NOT EXISTS email_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      to_email VARCHAR(255) NOT NULL,
      subject VARCHAR(500) NOT NULL,
      type VARCHAR(50) DEFAULT '',
      content_preview VARCHAR(500) DEFAULT '',
      status ENUM('success','fail') DEFAULT 'success',
      error_msg VARCHAR(500) DEFAULT '',
      target_user_name VARCHAR(100) DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_created (created_at),
      INDEX idx_type (type),
      INDEX idx_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  } catch(e) {}
}

async function logEmail(to, subject, type, contentPreview, status, errorMsg, userName) {
  try {
    const { pool } = require('../config/database');
    await ensureEmailLogsTable();
    await pool.execute(
      'INSERT INTO email_logs (to_email, subject, type, content_preview, status, error_msg, target_user_name) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [to, subject, type, (contentPreview || '').substring(0, 500), status, (errorMsg || '').substring(0, 500), (userName || '')]
    );
  } catch(e) {}
}

async function getEmailSettings() {
  try {
    const { pool } = require('../config/database');
    const [rows] = await pool.execute(
      'SELECT config_key, config_value FROM settings WHERE config_key IN ("email_enabled", "smtp_host", "smtp_port", "smtp_user", "smtp_pass", "smtp_from")'
    );
    const settings = {};
    rows.forEach(row => { settings[row.config_key] = row.config_value; });
    return settings;
  } catch (err) {
    console.error('[Email] 获取邮件设置失败:', err.message);
    return {};
  }
}

async function createTransporter() {
  const settings = await getEmailSettings();
  if (!settings.email_enabled || settings.email_enabled === '0') return null;
  if (!settings.smtp_host || !settings.smtp_user || !settings.smtp_pass) return null;
  const transporter = nodemailer.createTransport({
    host: settings.smtp_host,
    port: parseInt(settings.smtp_port || '587'),
    secure: settings.smtp_port === '465',
    auth: { user: settings.smtp_user, pass: settings.smtp_pass },
    tls: { rejectUnauthorized: false }
  });
  return { transporter, smtp_from: settings.smtp_from, smtp_user: settings.smtp_user };
}

async function sendEmail(to, subject, html, type, userName) {
  type = type || '';
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    await logEmail(to, subject, type, '无效邮箱', 'fail', '邮箱格式错误', userName);
    return false;
  }
  try {
    const result = await createTransporter();
    if (!result) {
      await logEmail(to, subject, type, 'SMTP未配置', 'fail', 'SMTP未配置或不可用', userName);
      return false;
    }
    const { transporter, smtp_from, smtp_user } = result;
    let from;
    if (smtp_from && smtp_from.indexOf('<') > -1) {
      from = smtp_from;
    } else if (smtp_user) {
      from = smtp_from ? smtp_from + ' <' + smtp_user + '>' : smtp_user;
    } else {
      from = process.env.SMTP_FROM || '"嘉二の墙墙" <noreply@wall.jay23.cn>';
    }
    await transporter.sendMail({ from, to, subject, html });
    var preview = html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().substring(0, 200);
    await logEmail(to, subject, type, preview, 'success', '', userName);
    return true;
  } catch (err) {
    console.error('[Email] 邮件发送失败:', err.message);
    await logEmail(to, subject, type, subject, 'fail', err.message, userName);
    return false;
  }
}

// ===== 邮件模板 =====

function decoEmoji(title) {
  if (title.includes('评论')) return '💬';
  if (title.includes('点赞')) return '❤️';
  if (title.includes('粉丝') || title.includes('关注')) return '🌟';
  if (title.includes('提到') || title.includes('@')) return '📢';
  if (title.includes('审核通过')) return '✅';
  if (title.includes('未通过') || title.includes('拒绝')) return '💔';
  if (title.includes('播放') || title.includes('点歌')) return '🎵';
  return '💌';
}

function kawaiiLayout(title, bodyContent, siteUrl) {
  return `
  <!DOCTYPE html>
  <html>
  <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
  <body style="margin:0;padding:0;background:#F8F5FF;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Helvetica Neue','Microsoft YaHei',sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#F8F5FF;padding:20px 10px;">
      <tr>
        <td align="center">
          <table width="100%" style="max-width:560px;background:#FFFCFA;border-radius:24px;overflow:hidden;box-shadow:0 8px 32px rgba(255,107,157,0.10),0 2px 8px rgba(0,0,0,0.04);">
            <tr>
              <td style="background:linear-gradient(135deg,#FF9ABF 0%,#C084FC 50%,#93C5FD 100%);padding:32px 24px 28px;text-align:center;">
                <div style="font-size:48px;line-height:1;margin-bottom:8px;">${decoEmoji(title)}</div>
                <div style="color:rgba(255,255,255,0.9);font-size:13px;letter-spacing:6px;">✦ ✦ ✦</div>
                <h1 style="color:#fff;margin:10px 0 0;font-size:22px;font-weight:700;letter-spacing:1px;text-shadow:0 2px 8px rgba(0,0,0,0.08);">${title}</h1>
                <div style="margin-top:8px;font-size:13px;color:rgba(255,255,255,0.75);">💌 来自 嘉二の墙墙 的一封信</div>
              </td>
            </tr>
            <tr>
              <td style="padding:28px 24px 24px;background:#FFFCFA;">
                ${bodyContent}
              </td>
            </tr>
            <tr>
              <td style="padding:0 24px 24px;text-align:center;background:#FFFCFA;">
                <a href="${siteUrl || 'https://wall.jay23.cn'}" style="display:inline-block;padding:10px 28px;background:linear-gradient(135deg,#FF9ABF,#C084FC);color:#fff;text-decoration:none;border-radius:20px;font-size:14px;font-weight:600;box-shadow:0 4px 12px rgba(255,107,157,0.25);">✨ 去看看</a>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 24px;background:#F8F5FF;border-top:1px solid rgba(255,107,157,0.06);text-align:center;">
                <div style="color:#B8A9D4;font-size:12px;line-height:1.8;">
                  <div>🪄 嘉二の墙墙 — 校园信息交流平台</div>
                  <div style="margin-top:4px;">这是一封系统自动发送的邮件，请勿回复</div>
                </div>
              </td>
            </tr>
          </table>
          <div style="margin-top:12px;color:#D4C5F0;font-size:12px;letter-spacing:4px;">✧ 愿你每一天都闪闪发光 ✧</div>
        </td>
      </tr>
    </table>
  </body>
  </html>`;
}

function contentCard(inner) {
  return `<div style="background:#F8F5FF;border-radius:16px;padding:18px 20px;margin:12px 0 16px;border:1px solid rgba(255,107,157,0.08);">${inner}</div>`;
}

// ===== 用户偏好检查 =====

async function checkUserNotify(userId, type) {
  try {
    const { pool } = require('../config/database');
    const [rows] = await pool.execute('SELECT * FROM user_notify_settings WHERE user_id = ?', [userId]);
    if (rows.length === 0) return true;
    return rows[0][type] !== 0;
  } catch (err) {
    return true;
  }
}

// ===== 统一通知分发 =====

const NOTIFY_TYPES = {
  comment: {
    title: '有新的评论啦',
    subject: '💬 收到新评论 · 嘉二の墙墙',
    notifyField: 'notify_comment',
    buildBody: function(p) {
      return `<p style="font-size:15px;color:#4A3F5C;margin:0 0 12px;line-height:1.7;">亲爱的 <strong style="color:#FF6B9D;">${p.postAuthorNickname}</strong> 同学：</p>
<p style="font-size:15px;color:#4A3F5C;margin:0 0 6px;"><strong style="color:#C084FC;">${p.commenterNickname}</strong> 在您的帖子下留下了评论 💭</p>
<div style="font-size:12px;color:#B8A9D4;margin-bottom:4px;">📌 帖子：《${p.postTitle}》</div>
${contentCard(`<div style="font-size:14px;color:#4A3F5C;line-height:1.8;">${p.commentContent}</div>`)}
<p style="font-size:14px;color:#B8A9D4;margin:0;">💡 点击下方按钮去看看小伙伴说了什么~</p>`;
    }
  },
  like: {
    title: '有人喜欢了你的帖子',
    subject: '❤️ 收到点赞 · 嘉二の墙墙',
    notifyField: 'notify_like',
    buildBody: function(p) {
      return `<p style="font-size:15px;color:#4A3F5C;margin:0 0 12px;line-height:1.7;">亲爱的 <strong style="color:#FF6B9D;">${p.userNickname}</strong> 同学：</p>
<p style="font-size:15px;color:#4A3F5C;margin:0 0 6px;"><strong style="color:#FF6B9D;">${p.likerNickname}</strong> ❤️ 赞了您的帖子</p>
<div style="font-size:12px;color:#B8A9D4;margin-bottom:4px;">📌 帖子：《${p.postTitle}》</div>
${contentCard('<div style="text-align:center;font-size:40px;line-height:1;">❤️</div><div style="text-align:center;font-size:14px;color:#FF6B9D;margin-top:8px;font-weight:600;">收到一个喜欢~</div>')}
<p style="font-size:14px;color:#B8A9D4;margin:0;">💡 您的帖子得到了认可，继续加油哦！</p>`;
    }
  },
  mention: {
    title: '有人在评论中提到了你',
    subject: '📢 有人提到了你 · 嘉二の墙墙',
    notifyField: 'notify_mention',
    buildBody: function(p) {
      return `<p style="font-size:15px;color:#4A3F5C;margin:0 0 12px;line-height:1.7;">亲爱的 <strong style="color:#C084FC;">${p.userNickname}</strong> 同学：</p>
<p style="font-size:15px;color:#4A3F5C;margin:0 0 6px;"><strong style="color:#FF6B9D;">${p.mentionerNickname}</strong> 在评论中提到了你 📢</p>
<div style="font-size:12px;color:#B8A9D4;margin-bottom:4px;">📌 帖子：《${p.postTitle}》</div>
${contentCard(`<div style="font-size:14px;color:#4A3F5C;line-height:1.8;">${p.commentContent}</div>`)}
<p style="font-size:14px;color:#B8A9D4;margin:0;">💡 快去看看谁在找你吧~</p>`;
    }
  },
  follower: {
    title: '有新的小粉丝',
    subject: '🌟 新粉丝 · 嘉二の墙墙',
    notifyField: 'notify_follower',
    buildBody: function(p) {
      return `<p style="font-size:15px;color:#4A3F5C;margin:0 0 12px;line-height:1.7;">亲爱的 <strong style="color:#FF6B9D;">${p.userNickname}</strong> 同学：</p>
<p style="font-size:15px;color:#4A3F5C;margin:0 0 6px;"><strong style="color:#FFD700;">${p.followerNickname}</strong> ⭐ 关注了你！</p>
${contentCard('<div style="text-align:center;font-size:40px;line-height:1;">🌟</div><div style="text-align:center;font-size:15px;color:#C084FC;margin-top:8px;font-weight:600;">你多了一个小粉丝~</div>')}
<p style="font-size:14px;color:#B8A9D4;margin:0;">💡 去ta的主页看看，也许会有惊喜！</p>`;
    }
  },
  post_approved: {
    title: '审核通过啦',
    subject: '✅ 帖子审核通过 · 嘉二の墙墙',
    notifyField: 'notify_post_approved',
    buildBody: function(p) {
      return `<p style="font-size:15px;color:#4A3F5C;margin:0 0 12px;line-height:1.7;">亲爱的 <strong style="color:#FF6B9D;">${p.userNickname}</strong> 同学：</p>
<p style="font-size:15px;color:#4A3F5C;margin:0 0 6px;">🎉 您的帖子审核通过啦！</p>
${contentCard(`<div style="text-align:center;font-size:18px;font-weight:600;color:#10B981;">✅ 《${p.postTitle}》</div><div style="text-align:center;font-size:13px;color:#6B7280;margin-top:8px;">现在其他同学可以看到你的帖子了~</div>`)}`;
    }
  },
  post_rejected: {
    title: '审核未通过',
    subject: '💔 帖子未通过审核 · 嘉二の墙墙',
    notifyField: 'notify_post_rejected',
    buildBody: function(p) {
      return `<p style="font-size:15px;color:#4A3F5C;margin:0 0 12px;line-height:1.7;">亲爱的 <strong style="color:#FF6B9D;">${p.userNickname}</strong> 同学：</p>
<p style="font-size:15px;color:#4A3F5C;margin:0 0 6px;">😢 很抱歉，您的帖子未通过审核</p>
${contentCard(`
      <div style="text-align:center;font-size:16px;color:#EF4444;margin-bottom:8px;">💔 《${p.postTitle}》</div>
      ${p.reason ? '<div style="text-align:center;font-size:13px;color:#991B1B;background:#FEE2E2;padding:8px 12px;border-radius:10px;">原因：' + p.reason + '</div>' : ''}
    `)}
<p style="font-size:14px;color:#B8A9D4;margin:0;">💡 可以修改内容后重新提交哦~</p>`;
    }
  },
  song_approved: {
    title: '点歌通过啦',
    subject: '🎵 点歌审核通过 · 嘉二の墙墙',
    notifyField: 'notify_song_approved',
    buildBody: function(p) {
      return `<p style="font-size:15px;color:#4A3F5C;margin:0 0 12px;line-height:1.7;">亲爱的 <strong style="color:#C084FC;">${p.userNickname}</strong> 同学：</p>
<p style="font-size:15px;color:#4A3F5C;margin:0 0 6px;">🎶 您点的歌审核通过啦！</p>
${contentCard(`
      <div style="text-align:center;font-size:18px;font-weight:700;color:#7C3AED;">🎵 ${p.songName}</div>
      <div style="text-align:center;font-size:14px;color:#8B5CF6;margin-top:6px;">歌手：${p.artist}</div>
      <div style="text-align:center;font-size:13px;color:#A78BFA;margin-top:4px;">⏰ 时段：${p.slotName}</div>
    `)}
<p style="font-size:14px;color:#B8A9D4;margin:0;">💡 记得在广播时间收听哦~</p>`;
    }
  },
  song_rejected: {
    title: '点歌未通过',
    subject: '💔 点歌未通过审核 · 嘉二の墙墙',
    notifyField: 'notify_song_rejected',
    buildBody: function(p) {
      return `<p style="font-size:15px;color:#4A3F5C;margin:0 0 12px;line-height:1.7;">亲爱的 <strong style="color:#FF6B9D;">${p.userNickname}</strong> 同学：</p>
<p style="font-size:15px;color:#4A3F5C;margin:0 0 6px;">😢 您点的歌未通过审核</p>
${contentCard(`
      <div style="text-align:center;font-size:16px;font-weight:600;color:#92400E;">🎵 ${p.songName} - ${p.artist}</div>
      ${p.reason ? '<div style="text-align:center;font-size:13px;color:#991B1B;background:#FEF3C7;padding:8px 12px;border-radius:10px;margin-top:8px;">原因：' + p.reason + '</div>' : ''}
    `)}
<p style="font-size:14px;color:#B8A9D4;margin:0;">💡 可以重新选择其他歌曲哦~</p>`;
    }
  },
  song_played: {
    title: '点歌已经播放啦',
    subject: '🎉 您的点歌已播放 · 嘉二の墙墙',
    notifyField: 'notify_song_played',
    buildBody: function(p) {
      return `<p style="font-size:15px;color:#4A3F5C;margin:0 0 12px;line-height:1.7;">亲爱的 <strong style="color:#EC4899;">${p.userNickname}</strong> 同学：</p>
<p style="font-size:15px;color:#4A3F5C;margin:0 0 6px;">🎉 您点的歌已经在广播站播放啦！</p>
${contentCard(`
      <div style="text-align:center;font-size:20px;font-weight:700;color:#BE185D;margin-bottom:6px;">🎵 ${p.songName}</div>
      <div style="text-align:center;font-size:15px;color:#9D174D;">歌手：${p.artist}</div>
    `)}
<p style="font-size:14px;color:#B8A9D4;margin:0;">💡 感谢你的参与，下次继续点歌哦~</p>`;
    }
  },
  feedback_reply: {
    title: '反馈回复',
    subject: '📬 反馈收到回复 · 嘉二の墙墙',
    notifyField: 'notify_feedback_reply',
    buildBody: function(p) {
      return `<p style="font-size:15px;color:#4A3F5C;margin:0 0 12px;line-height:1.7;">亲爱的 <strong style="color:#FF6B9D;">${p.userNickname}</strong> 同学：</p>
<p style="font-size:15px;color:#4A3F5C;margin:0 0 6px;">📬 管理员已回复您的反馈！</p>
${contentCard(`
      <div style="font-size:13px;color:#B8A9D4;margin-bottom:6px;">📌 反馈：${p.feedbackTitle}</div>
      <div style="font-size:14px;color:#4A3F5C;line-height:1.8;white-space:pre-wrap;">${p.replyContent}</div>
    `)}
<p style="font-size:14px;color:#B8A9D4;margin:0;">📬 如有其他问题，欢迎继续反馈~</p>`;
    }
  },
  follow_post: {
    title: '关注的人有新帖子',
    subject: '📝 关注的人发布了新帖子 · 嘉二の墙墙',
    notifyField: 'notify_follow_post',
    buildBody: function(p) {
      var postLink = 'https://wall.jay23.cn/post/' + p.postId;
      return `<p style="font-size:15px;color:#4A3F5C;margin:0 0 12px;line-height:1.7;">亲爱的 <strong style="color:#FF6B9D;">${p.followerNickname}</strong> 同学：</p>
<p style="font-size:15px;color:#4A3F5C;margin:0 0 6px;"><strong style="color:#C084FC;">${p.posterNickname}</strong> 发布了新帖子 📝</p>
<div style="font-size:12px;color:#B8A9D4;margin-bottom:4px;">📌 标题：《${p.postTitle}》</div>
${contentCard('<div style="text-align:center;font-size:40px;line-height:1;">🎉</div><div style="text-align:center;font-size:14px;color:#C084FC;margin-top:8px;font-weight:600;">你关注的人有新动态了~</div>')}
<p style="font-size:14px;color:#B8A9D4;margin:0;">💡 <a href="${postLink}" style="color:#FF6B9D;text-decoration:none;font-weight:600;">点击查看TA的新帖子 →</a></p>`;
    }
  }
};

async function notifyUser(type, params) {
  var cfg = NOTIFY_TYPES[type];
  if (!cfg) { console.warn('[Email] 未知通知类型:', type); return; }
  var email = params.email, nickname = params.nickname, userId = params.userId;
  if (!email) return;
  if (userId && !(await checkUserNotify(userId, cfg.notifyField))) return;
  var body = cfg.buildBody(params);
  await sendEmail(email, cfg.subject, kawaiiLayout(cfg.title, body), type, nickname);
}

// ===== 保留向后兼容的命名函数 =====

async function notifyNewComment(postAuthorEmail, postAuthorNickname, commenterNickname, postTitle, commentContent, postAuthorId) {
  return notifyUser('comment', { email: postAuthorEmail, nickname: postAuthorNickname, userId: postAuthorId, postAuthorNickname: postAuthorNickname, commenterNickname: commenterNickname, postTitle: postTitle, commentContent: commentContent });
}

async function notifyNewLike(userEmail, userNickname, likerNickname, postTitle, userId) {
  return notifyUser('like', { email: userEmail, nickname: userNickname, userId: userId, userNickname: userNickname, likerNickname: likerNickname, postTitle: postTitle });
}

async function notifyMention(userEmail, userNickname, mentionerNickname, postTitle, commentContent, postId, userId) {
  return notifyUser('mention', { email: userEmail, nickname: userNickname, userId: userId, userNickname: userNickname, mentionerNickname: mentionerNickname, postTitle: postTitle, commentContent: commentContent });
}

async function notifyNewFollower(userEmail, userNickname, followerNickname, userId) {
  return notifyUser('follower', { email: userEmail, nickname: userNickname, userId: userId, userNickname: userNickname, followerNickname: followerNickname });
}

async function notifyPostApproved(userEmail, userNickname, postTitle, userId) {
  return notifyUser('post_approved', { email: userEmail, nickname: userNickname, userId: userId, userNickname: userNickname, postTitle: postTitle });
}

async function notifyPostRejected(userEmail, userNickname, postTitle, reason, userId) {
  return notifyUser('post_rejected', { email: userEmail, nickname: userNickname, userId: userId, userNickname: userNickname, postTitle: postTitle, reason: reason });
}

async function notifySongApproved(userEmail, userNickname, songName, artist, slotName, userId) {
  return notifyUser('song_approved', { email: userEmail, nickname: userNickname, userId: userId, userNickname: userNickname, songName: songName, artist: artist, slotName: slotName });
}

async function notifySongRejected(userEmail, userNickname, songName, artist, reason, userId) {
  return notifyUser('song_rejected', { email: userEmail, nickname: userNickname, userId: userId, userNickname: userNickname, songName: songName, artist: artist, reason: reason });
}

async function notifySongPlayed(userEmail, userNickname, songName, artist, userId) {
  return notifyUser('song_played', { email: userEmail, nickname: userNickname, userId: userId, userNickname: userNickname, songName: songName, artist: artist });
}

async function notifyFeedbackReply(userEmail, userNickname, feedbackTitle, replyContent, userId) {
  return notifyUser('feedback_reply', { email: userEmail, nickname: userNickname, userId: userId, userNickname: userNickname, feedbackTitle: feedbackTitle, replyContent: replyContent });
}

async function notifyFollowPost(followerEmail, followerNickname, posterNickname, postTitle, postId, followerId) {
  return notifyUser('follow_post', { email: followerEmail, nickname: followerNickname, userId: followerId, followerNickname: followerNickname, posterNickname: posterNickname, postTitle: postTitle, postId: postId });
}

async function notifyAdminNewPostPending(postId, postTitle, posterNickname, postContent) {
  try {
    const { pool } = require('../config/database');
    const [admins] = await pool.execute(
      'SELECT id, email, nickname, username FROM users WHERE (role = "admin" OR role = "super_admin") AND email IS NOT NULL AND email != ""'
    );
    if (admins.length === 0) return;

    const siteUrl = process.env.SITE_URL || 'https://wall.jay23.cn';
    const adminUrl = siteUrl + '/admin';
    const contentPreview = (postContent || '').substring(0, 100);

    const body = `
      <p style="font-size:15px;color:#4A3F5C;margin:0 0 12px;line-height:1.7;">亲爱的管理员：</p>
      <p style="font-size:15px;color:#4A3F5C;margin:0 0 6px;">📝 有一位同学发布了新帖子，等待审核</p>
      ${contentCard(`
        <div style="margin-bottom:8px;">
          <span style="font-size:12px;color:#B8A9D4;">发帖人：</span>
          <span style="font-size:14px;color:#4A3F5C;font-weight:600;">${posterNickname}</span>
        </div>
        <div style="margin-bottom:4px;">
          <span style="font-size:12px;color:#B8A9D4;">帖子标题：</span>
          <span style="font-size:14px;color:#4A3F5C;font-weight:600;">${postTitle || '(无标题)'}</span>
        </div>
        <div style="margin-top:8px;padding:10px;background:#FEF9F0;border-radius:10px;font-size:13px;color:#6B7280;line-height:1.6;">
          ${escapeHtml(contentPreview)}${(postContent || '').length > 100 ? '...' : ''}
        </div>
        <div style="text-align:center;margin-top:12px;">
          <a href="${adminUrl}" style="display:inline-block;padding:8px 20px;background:linear-gradient(135deg,#FF6B9D,#A78BFA);color:#fff;text-decoration:none;border-radius:16px;font-size:13px;font-weight:600;">📋 前往审核 →</a>
        </div>
      `)}
      <p style="font-size:14px;color:#B8A9D4;margin:0;">💡 请及时登录管理后台审核该帖子</p>`;

    for (const admin of admins) {
      const adminName = admin.nickname || admin.username || '管理员';
      await sendEmail(admin.email, '📝 新帖子待审核 · 嘉二の墙墙', kawaiiLayout('新帖子待审核', body), 'admin_pending_post', adminName);
    }
    console.log('[Email] 已通知 ' + admins.length + ' 位管理员审核新帖子 #' + postId);
  } catch (err) {
    console.error('[Email] 通知管理员审核失败:', err.message);
  }
}

module.exports = {
  sendEmail, kawaiiLayout,
  notifyNewComment, notifyNewLike, notifyMention, notifyNewFollower,
  notifyPostApproved, notifyPostRejected, notifySongApproved, notifySongRejected,
  notifySongPlayed, notifyFeedbackReply, notifyFollowPost, notifyAdminNewPostPending
};
