/**
 * 邮件发送服务 - ✨ 卡哇伊风格邮件模板
 * 含邮件发送日志功能，所有收发记录可在管理后台查看
 */

const nodemailer = require('nodemailer');

// 确保 email_logs 表存在
async function ensureEmailLogsTable() {
  try {
    const { pool } = require('../config/database');
    await pool.execute(`CREATE TABLE IF NOT EXISTS email_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      to_email VARCHAR(255) NOT NULL COMMENT '收件人',
      subject VARCHAR(500) NOT NULL COMMENT '邮件主题',
      type VARCHAR(50) DEFAULT '' COMMENT '类型(comment/like/song_approved等)',
      content_preview VARCHAR(500) DEFAULT '' COMMENT '内容摘要',
      status ENUM('success','fail') DEFAULT 'success' COMMENT '发送状态',
      error_msg VARCHAR(500) DEFAULT '' COMMENT '错误信息',
      target_user_name VARCHAR(100) DEFAULT '' COMMENT '目标用户昵称',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_created (created_at),
      INDEX idx_type (type),
      INDEX idx_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='邮件发送日志'`);
  } catch(e) { /* 忽略 */ }
}

// 记录邮件日志
async function logEmail(to, subject, type, contentPreview, status, errorMsg, userName) {
  try {
    const { pool } = require('../config/database');
    await ensureEmailLogsTable();
    await pool.execute(
      'INSERT INTO email_logs (to_email, subject, type, content_preview, status, error_msg, target_user_name) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [to, subject, type, (contentPreview || '').substring(0, 500), status, (errorMsg || '').substring(0, 500), (userName || '')]
    );
  } catch(e) { /* 记录日志本身失败不影响主流程 */ }
}

/**
 * 每次发送都重新获取配置 + 创建新 transporter，
 * 确保修改配置后立即生效，不会被旧缓存卡住
 */
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
  if (!settings.email_enabled || settings.email_enabled === '0') {
    console.log('[Email] 邮件通知未启用');
    return null;
  }
  if (!settings.smtp_host || !settings.smtp_user || !settings.smtp_pass) {
    console.log('[Email] SMTP配置不完整，将跳过邮件发送');
    return null;
  }
  const transporter = nodemailer.createTransport({
    host: settings.smtp_host,
    port: parseInt(settings.smtp_port || '587'),
    secure: settings.smtp_port === '465',
    auth: { user: settings.smtp_user, pass: settings.smtp_pass },
    tls: { rejectUnauthorized: false }
  });
  // 返回配置，供 sendEmail 使用
  return { transporter, smtp_from: settings.smtp_from, smtp_user: settings.smtp_user };
}

async function sendEmail(to, subject, html, type, userName) {
  type = type || '';
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    console.log('[Email] 无效的邮箱地址:', to);
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
    // 从html中提取纯文本摘要
    var preview = html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().substring(0, 200);
    await logEmail(to, subject, type, preview, 'success', '', userName);
    console.log('[Email] 邮件发送成功 ->', to);
    return true;
  } catch (err) {
    console.error('[Email] 邮件发送失败:', err.message);
    await logEmail(to, subject, type, subject, 'fail', err.message, userName);
    return false;
  }
}

// ===================== ✨ 卡哇伊风格邮件模板 =====================

/**
 * 生成邮件通用外壳 — 糖果色卡片风格
 */
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
            <!-- 🌈 彩虹渐变头部 -->
            <tr>
              <td style="background:linear-gradient(135deg,#FF9ABF 0%,#C084FC 50%,#93C5FD 100%);padding:32px 24px 28px;text-align:center;">
                <div style="font-size:48px;line-height:1;margin-bottom:8px;">${decoEmoji(title)}</div>
                <div style="color:rgba(255,255,255,0.9);font-size:13px;letter-spacing:6px;">✦ ✦ ✦</div>
                <h1 style="color:#fff;margin:10px 0 0;font-size:22px;font-weight:700;letter-spacing:1px;text-shadow:0 2px 8px rgba(0,0,0,0.08);">${title}</h1>
                <div style="margin-top:8px;font-size:13px;color:rgba(255,255,255,0.75);">💌 来自 嘉二の墙墙 的一封信</div>
              </td>
            </tr>
            <!-- 📝 正文内容 -->
            <tr>
              <td style="padding:28px 24px 24px;background:#FFFCFA;">
                ${bodyContent}
              </td>
            </tr>
            <!-- 🔗 底部 -->
            <tr>
              <td style="padding:0 24px 24px;text-align:center;background:#FFFCFA;">
                <a href="${siteUrl || 'https://wall.jay23.cn'}" style="display:inline-block;padding:10px 28px;background:linear-gradient(135deg,#FF9ABF,#C084FC);color:#fff;text-decoration:none;border-radius:20px;font-size:14px;font-weight:600;box-shadow:0 4px 12px rgba(255,107,157,0.25);">✨ 去看看</a>
              </td>
            </tr>
            <!-- 📮 页脚 -->
            <tr>
              <td style="padding:20px 24px;background:#F8F5FF;border-top:1px solid rgba(255,107,157,0.06);text-align:center;">
                <div style="color:#B8A9D4;font-size:12px;line-height:1.8;">
                  <div>🪄 嘉二の墙墙 — 校园信息交流平台</div>
                  <div style="margin-top:4px;">这是一封系统自动发送的邮件，请勿回复</div>
                </div>
              </td>
            </tr>
          </table>
          <!-- ✨ 装饰 -->
          <div style="margin-top:12px;color:#D4C5F0;font-size:12px;letter-spacing:4px;">✧ 愿你每一天都闪闪发光 ✧</div>
        </td>
      </tr>
    </table>
  </body>
  </html>`;
}

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

/**
 * 内容卡片 — 圆角气泡样式
 */
function contentCard(inner) {
  return `<div style="background:#F8F5FF;border-radius:16px;padding:18px 20px;margin:12px 0 16px;border:1px solid rgba(255,107,157,0.08);">${inner}</div>`;
}

// ===================== 🎯 各场景邮件函数 =====================

/**
 * 检查用户是否开启了指定类型的邮件通知
 * @returns {Promise<boolean>} true=可以发送, false=用户关闭了
 */
async function checkUserNotify(userId, type) {
  try {
    const { pool } = require('../config/database');
    const [rows] = await pool.execute(
      'SELECT * FROM user_notify_settings WHERE user_id = ?',
      [userId]
    );
    if (rows.length === 0) return true; // 没设置就默认发送
    return rows[0][type] !== 0; // 0表示关闭
  } catch (err) {
    return true; // 出错时默认发送
  }
}

// 1. 新评论通知
async function notifyNewComment(postAuthorEmail, postAuthorNickname, commenterNickname, postTitle, commentContent, postAuthorId) {
  if (!postAuthorEmail) return;
  // 检查用户偏好
  if (postAuthorId && !(await checkUserNotify(postAuthorId, 'notify_comment'))) {
    console.log('[Email] 用户 ' + postAuthorId + ' 已关闭评论通知');
    return;
  }
  const body = `
    <p style="font-size:15px;color:#4A3F5C;margin:0 0 12px;line-height:1.7;">
      亲爱的 <strong style="color:#FF6B9D;">${postAuthorNickname}</strong> 同学：
    </p>
    <p style="font-size:15px;color:#4A3F5C;margin:0 0 6px;">
      <strong style="color:#C084FC;">${commenterNickname}</strong> 在您的帖子下留下了评论 💭
    </p>
    <div style="font-size:12px;color:#B8A9D4;margin-bottom:4px;">📌 帖子：《${postTitle}》</div>
    ${contentCard(`<div style="font-size:14px;color:#4A3F5C;line-height:1.8;">${commentContent}</div>`)}
    <p style="font-size:14px;color:#B8A9D4;margin:0;">💡 点击下方按钮去看看小伙伴说了什么~</p>
  `;
  await sendEmail(postAuthorEmail, '💬 收到新评论 · 嘉二の墙墙', kawaiiLayout('有新的评论啦', body), 'comment', postAuthorNickname);
}

// 2. 点赞通知
async function notifyNewLike(userEmail, userNickname, likerNickname, postTitle, userId) {
  if (!userEmail) return;
  if (userId && !(await checkUserNotify(userId, 'notify_like'))) {
    console.log('[Email] 用户 ' + userId + ' 已关闭点赞通知');
    return;
  }
  const body = `
    <p style="font-size:15px;color:#4A3F5C;margin:0 0 12px;line-height:1.7;">
      亲爱的 <strong style="color:#FF6B9D;">${userNickname}</strong> 同学：
    </p>
    <p style="font-size:15px;color:#4A3F5C;margin:0 0 6px;">
      <strong style="color:#FF6B9D;">${likerNickname}</strong> ❤️ 赞了您的帖子
    </p>
    <div style="font-size:12px;color:#B8A9D4;margin-bottom:4px;">📌 帖子：《${postTitle}》</div>
    ${contentCard('<div style="text-align:center;font-size:40px;line-height:1;">❤️</div><div style="text-align:center;font-size:14px;color:#FF6B9D;margin-top:8px;font-weight:600;">收到一个喜欢~</div>')}
    <p style="font-size:14px;color:#B8A9D4;margin:0;">💡 您的帖子得到了认可，继续加油哦！</p>
  `;
  await sendEmail(userEmail, '❤️ 收到点赞 · 嘉二の墙墙', kawaiiLayout('有人喜欢了你的帖子', body), 'like', userNickname);
}

// 3. @提及通知
async function notifyMention(userEmail, userNickname, mentionerNickname, postTitle, commentContent, postId, userId) {
  if (!userEmail) return;
  if (userId && !(await checkUserNotify(userId, 'notify_mention'))) {
    console.log('[Email] 用户 ' + userId + ' 已关闭提及通知');
    return;
  }
  const body = `
    <p style="font-size:15px;color:#4A3F5C;margin:0 0 12px;line-height:1.7;">
      亲爱的 <strong style="color:#C084FC;">${userNickname}</strong> 同学：
    </p>
    <p style="font-size:15px;color:#4A3F5C;margin:0 0 6px;">
      <strong style="color:#FF6B9D;">${mentionerNickname}</strong> 在评论中提到了你 📢
    </p>
    <div style="font-size:12px;color:#B8A9D4;margin-bottom:4px;">📌 帖子：《${postTitle}》</div>
    ${contentCard(`<div style="font-size:14px;color:#4A3F5C;line-height:1.8;">${commentContent}</div>`)}
    <p style="font-size:14px;color:#B8A9D4;margin:0;">💡 快去看看谁在找你吧~</p>
  `;
  await sendEmail(userEmail, '📢 有人提到了你 · 嘉二の墙墙', kawaiiLayout('有人在评论中提到了你', body), 'mention', userNickname);
}

// 4. 新粉丝通知
async function notifyNewFollower(userEmail, userNickname, followerNickname, userId) {
  if (!userEmail) return;
  if (userId && !(await checkUserNotify(userId, 'notify_follower'))) {
    console.log('[Email] 用户 ' + userId + ' 已关闭粉丝通知');
    return;
  }
  const body = `
    <p style="font-size:15px;color:#4A3F5C;margin:0 0 12px;line-height:1.7;">
      亲爱的 <strong style="color:#FF6B9D;">${userNickname}</strong> 同学：
    </p>
    <p style="font-size:15px;color:#4A3F5C;margin:0 0 6px;">
      <strong style="color:#FFD700;">${followerNickname}</strong> ⭐ 关注了你！
    </p>
    ${contentCard('<div style="text-align:center;font-size:40px;line-height:1;">🌟</div><div style="text-align:center;font-size:15px;color:#C084FC;margin-top:8px;font-weight:600;">你多了一个小粉丝~</div>')}
    <p style="font-size:14px;color:#B8A9D4;margin:0;">💡 去ta的主页看看，也许会有惊喜！</p>
  `;
  await sendEmail(userEmail, '🌟 新粉丝 · 嘉二の墙墙', kawaiiLayout('有新的小粉丝', body), 'follower', userNickname);
}

// 5. 帖子审核通过
async function notifyPostApproved(userEmail, userNickname, postTitle, userId) {
  if (!userEmail) return;
  if (userId && !(await checkUserNotify(userId, 'notify_post_approved'))) {
    console.log('[Email] 用户 ' + userId + ' 已关闭帖子审核通过通知');
    return;
  }
  const body = `
    <p style="font-size:15px;color:#4A3F5C;margin:0 0 12px;line-height:1.7;">
      亲爱的 <strong style="color:#FF6B9D;">${userNickname}</strong> 同学：
    </p>
    <p style="font-size:15px;color:#4A3F5C;margin:0 0 6px;">🎉 您的帖子审核通过啦！</p>
    ${contentCard(`<div style="text-align:center;font-size:18px;font-weight:600;color:#10B981;">✅ 《${postTitle}》</div><div style="text-align:center;font-size:13px;color:#6B7280;margin-top:8px;">现在其他同学可以看到你的帖子了~</div>`)}
  `;
  await sendEmail(userEmail, '✅ 帖子审核通过 · 嘉二の墙墙', kawaiiLayout('审核通过啦', body), 'post_approved', userNickname);
}

// 6. 帖子审核未通过
async function notifyPostRejected(userEmail, userNickname, postTitle, reason, userId) {
  if (!userEmail) return;
  if (userId && !(await checkUserNotify(userId, 'notify_post_rejected'))) {
    console.log('[Email] 用户 ' + userId + ' 已关闭帖子审核未通过通知');
    return;
  }
  const body = `
    <p style="font-size:15px;color:#4A3F5C;margin:0 0 12px;line-height:1.7;">
      亲爱的 <strong style="color:#FF6B9D;">${userNickname}</strong> 同学：
    </p>
    <p style="font-size:15px;color:#4A3F5C;margin:0 0 6px;">😢 很抱歉，您的帖子未通过审核</p>
    ${contentCard(`
      <div style="text-align:center;font-size:16px;color:#EF4444;margin-bottom:8px;">💔 《${postTitle}》</div>
      ${reason ? '<div style="text-align:center;font-size:13px;color:#991B1B;background:#FEE2E2;padding:8px 12px;border-radius:10px;">原因：' + reason + '</div>' : ''}
    `)}
    <p style="font-size:14px;color:#B8A9D4;margin:0;">💡 可以修改内容后重新提交哦~</p>
  `;
  await sendEmail(userEmail, '💔 帖子未通过审核 · 嘉二の墙墙', kawaiiLayout('审核未通过', body), 'post_rejected', userNickname);
}

// 7. 点歌审核通过
async function notifySongApproved(userEmail, userNickname, songName, artist, slotName, userId) {
  if (!userEmail) return;
  if (userId && !(await checkUserNotify(userId, 'notify_song_approved'))) {
    console.log('[Email] 用户 ' + userId + ' 已关闭点歌审核通过通知');
    return;
  }
  const body = `
    <p style="font-size:15px;color:#4A3F5C;margin:0 0 12px;line-height:1.7;">
      亲爱的 <strong style="color:#C084FC;">${userNickname}</strong> 同学：
    </p>
    <p style="font-size:15px;color:#4A3F5C;margin:0 0 6px;">🎶 您点的歌审核通过啦！</p>
    ${contentCard(`
      <div style="text-align:center;font-size:18px;font-weight:700;color:#7C3AED;">🎵 ${songName}</div>
      <div style="text-align:center;font-size:14px;color:#8B5CF6;margin-top:6px;">歌手：${artist}</div>
      <div style="text-align:center;font-size:13px;color:#A78BFA;margin-top:4px;">⏰ 时段：${slotName}</div>
    `)}
    <p style="font-size:14px;color:#B8A9D4;margin:0;">💡 记得在广播时间收听哦~</p>
  `;
  await sendEmail(userEmail, '🎵 点歌审核通过 · 嘉二の墙墙', kawaiiLayout('点歌通过啦', body), 'song_approved', userNickname);
}

// 8. 点歌审核未通过
async function notifySongRejected(userEmail, userNickname, songName, artist, reason, userId) {
  if (!userEmail) return;
  if (userId && !(await checkUserNotify(userId, 'notify_song_rejected'))) {
    console.log('[Email] 用户 ' + userId + ' 已关闭点歌审核未通过通知');
    return;
  }
  const body = `
    <p style="font-size:15px;color:#4A3F5C;margin:0 0 12px;line-height:1.7;">
      亲爱的 <strong style="color:#FF6B9D;">${userNickname}</strong> 同学：
    </p>
    <p style="font-size:15px;color:#4A3F5C;margin:0 0 6px;">😢 您点的歌未通过审核</p>
    ${contentCard(`
      <div style="text-align:center;font-size:16px;font-weight:600;color:#92400E;">🎵 ${songName} - ${artist}</div>
      ${reason ? '<div style="text-align:center;font-size:13px;color:#991B1B;background:#FEF3C7;padding:8px 12px;border-radius:10px;margin-top:8px;">原因：' + reason + '</div>' : ''}
    `)}
    <p style="font-size:14px;color:#B8A9D4;margin:0;">💡 可以重新选择其他歌曲哦~</p>
  `;
  await sendEmail(userEmail, '💔 点歌未通过审核 · 嘉二の墙墙', kawaiiLayout('点歌未通过', body), 'song_rejected', userNickname);
}

// 9. 点歌已播放
async function notifySongPlayed(userEmail, userNickname, songName, artist, userId) {
  if (!userEmail) return;
  if (userId && !(await checkUserNotify(userId, 'notify_song_played'))) {
    console.log('[Email] 用户 ' + userId + ' 已关闭点歌已播放通知');
    return;
  }
  const body = `
    <p style="font-size:15px;color:#4A3F5C;margin:0 0 12px;line-height:1.7;">
      亲爱的 <strong style="color:#EC4899;">${userNickname}</strong> 同学：
    </p>
    <p style="font-size:15px;color:#4A3F5C;margin:0 0 6px;">🎉 您点的歌已经在广播站播放啦！</p>
    ${contentCard(`
      <div style="text-align:center;font-size:20px;font-weight:700;color:#BE185D;margin-bottom:6px;">🎵 ${songName}</div>
      <div style="text-align:center;font-size:15px;color:#9D174D;">歌手：${artist}</div>
    `)}
    <p style="font-size:14px;color:#B8A9D4;margin:0;">💡 感谢你的参与，下次继续点歌哦~</p>
  `;
  await sendEmail(userEmail, '🎉 您的点歌已播放 · 嘉二の墙墙', kawaiiLayout('点歌已经播放啦', body), 'song_played', userNickname);
}

// 9. 反馈回复通知
async function notifyFeedbackReply(userEmail, userNickname, feedbackTitle, replyContent, userId) {
  if (!userEmail) return;
  if (userId && !(await checkUserNotify(userId, 'notify_feedback_reply'))) {
    console.log('[Email] 用户 ' + userId + ' 已关闭反馈回复通知');
    return;
  }
  const body = `
    <p style="font-size:15px;color:#4A3F5C;margin:0 0 12px;line-height:1.7;">
      亲爱的 <strong style="color:#FF6B9D;">${userNickname}</strong> 同学：
    </p>
    <p style="font-size:15px;color:#4A3F5C;margin:0 0 6px;"> 管理员已回复您的反馈！</p>
    ${contentCard(`
      <div style="font-size:13px;color:#B8A9D4;margin-bottom:6px;">📌 反馈：${feedbackTitle}</div>
      <div style="font-size:14px;color:#4A3F5C;line-height:1.8;white-space:pre-wrap;">${replyContent}</div>
    `)}
    <p style="font-size:14px;color:#B8A9D4;margin:0;"> 如有其他问题，欢迎继续反馈~</p>
  `;
  await sendEmail(userEmail, ' 反馈收到回复 · 嘉二の墙墙', kawaiiLayout('反馈回复', body), 'feedback_reply', userNickname);
}

// 11. 关注的人发帖通知
async function notifyFollowPost(followerEmail, followerNickname, posterNickname, postTitle, postId, followerId) {
  if (!followerEmail) return;
  if (followerId && !(await checkUserNotify(followerId, 'notify_follow_post'))) {
    console.log('[Email] 用户 ' + followerId + ' 已关闭关注发帖通知');
    return;
  }
  var postLink = 'https://wall.jay23.cn/post/' + postId;
  var body = `
    <p style="font-size:15px;color:#4A3F5C;margin:0 0 12px;line-height:1.7;">
      亲爱的 <strong style="color:#FF6B9D;">${followerNickname}</strong> 同学：
    </p>
    <p style="font-size:15px;color:#4A3F5C;margin:0 0 6px;">
      <strong style="color:#C084FC;">${posterNickname}</strong> 发布了新帖子 📝
    </p>
    <div style="font-size:12px;color:#B8A9D4;margin-bottom:4px;">📌 标题：《${postTitle}》</div>
    ${contentCard('<div style="text-align:center;font-size:40px;line-height:1;">🎉</div><div style="text-align:center;font-size:14px;color:#C084FC;margin-top:8px;font-weight:600;">你关注的人有新动态了~</div>')}
    <p style="font-size:14px;color:#B8A9D4;margin:0;">💡 <a href="${postLink}" style="color:#FF6B9D;text-decoration:none;font-weight:600;">点击查看TA的新帖子 →</a></p>
  `;
  await sendEmail(followerEmail, '📝 关注的人发布了新帖子 · 嘉二の墙墙', kawaiiLayout('关注的人有新帖子', body), 'follow_post', followerNickname);
}

// 12. 新帖子待审核通知（通知所有管理员）
async function notifyAdminNewPostPending(postId, postTitle, posterNickname, postContent) {
  try {
    const { pool } = require('../config/database');
    // 获取所有管理员和超级管理员
    const [admins] = await pool.execute(
      'SELECT id, email, nickname, username FROM users WHERE (role = "admin" OR role = "super_admin") AND email IS NOT NULL AND email != ""'
    );
    
    if (admins.length === 0) {
      console.log('[Email] 没有可通知的管理员邮箱');
      return;
    }
    
    const siteUrl = process.env.SITE_URL || 'https://wall.jay23.cn';
    const adminUrl = siteUrl + '/admin';
    const contentPreview = (postContent || '').substring(0, 100);
    
    const body = `
      <p style="font-size:15px;color:#4A3F5C;margin:0 0 12px;line-height:1.7;">
        亲爱的管理员：
      </p>
      <p style="font-size:15px;color:#4A3F5C;margin:0 0 6px;">
        📝 有一位同学发布了新帖子，等待审核
      </p>
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
          ${postContent ? escapeHtml(contentPreview) + (postContent.length > 100 ? '...' : '') : '(无内容)'}
        </div>
        <div style="text-align:center;margin-top:12px;">
          <a href="${adminUrl}" style="display:inline-block;padding:8px 20px;background:linear-gradient(135deg,#FF6B9D,#A78BFA);color:#fff;text-decoration:none;border-radius:16px;font-size:13px;font-weight:600;"> 前往审核 →</a>
        </div>
      `)}
      <p style="font-size:14px;color:#B8A9D4;margin:0;">💡 请及时登录管理后台审核该帖子</p>
    `;
    
    for (const admin of admins) {
      const adminName = admin.nickname || admin.username || '管理员';
      await sendEmail(admin.email, '📝 新帖子待审核 · 嘉二の墙墙', kawaiiLayout('新帖子待审核', body), 'admin_pending_post', adminName);
    }
    
    console.log('[Email] 已通知 ' + admins.length + ' 位管理员审核新帖子 #' + postId);
  } catch (err) {
    console.error('[Email] 通知管理员审核失败:', err.message);
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = {
  sendEmail,
  kawaiiLayout,
  notifyNewComment,
  notifyNewLike,
  notifyMention,
  notifyNewFollower,
  notifyPostApproved,
  notifyPostRejected,
  notifySongApproved,
  notifySongRejected,
  notifySongPlayed,
  notifyFeedbackReply,
  notifyFollowPost,
  notifyAdminNewPostPending
};
