/**
 * 邮件发送服务 - ✨ 卡哇伊风格邮件模板
 * 所有通知函数统一通过 notifyUser() 分发
 */

const nodemailer = require('nodemailer');
const { escapeHtml } = require('./html-utils');

// 表结构只需确保一次；失败时清空 promise，下一次发送仍可重试。
let emailLogsTablePromise = null;
// transporter 按“实际 SMTP 配置”缓存，而不是按请求缓存。配置变化时先切换新实例，
// 等旧实例没有发送中的邮件后再关闭，避免刷新配置打断正在发送的邮件。
let transporterCache = null;
let transporterRefreshPromise = null;

async function ensureEmailLogsTable() {
  if (emailLogsTablePromise) return emailLogsTablePromise;
  emailLogsTablePromise = (async function() {
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
    } catch (e) {
      // 日志表不可用不应阻断邮件主流程；允许后续请求重试建表。
      emailLogsTablePromise = null;
    }
  })();
  return emailLogsTablePromise;
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
      'SELECT config_key, config_value FROM settings WHERE config_key IN ("email_enabled", "smtp_host", "smtp_port", "smtp_user", "smtp_pass", "smtp_from", "site_name", "site_description")'
    );
    const settings = {};
    rows.forEach(row => { settings[row.config_key] = row.config_value; });
    return settings;
  } catch (err) {
    console.error('[Email] 获取邮件设置失败:', err.message);
    // 与“SMTP 未配置”区分开，避免一次数据库抖动把正在使用的缓存配置
    // 当成新配置并反复创建/销毁 transporter。
    return null;
  }
}

function normalizeEmailSettings(settings) {
  if (!settings || !settings.email_enabled || settings.email_enabled === '0') return null;
  const port = Number.parseInt(settings.smtp_port || '587', 10);
  const smtpHost = String(settings.smtp_host || '').trim();
  const smtpUser = String(settings.smtp_user || '').trim();
  const smtpPass = String(settings.smtp_pass || '');
  if (!smtpHost || !smtpUser || !smtpPass || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return {
    smtpHost,
    smtpPort: port,
    secure: port === 465,
    smtpUser,
    smtpPass,
    smtpFrom: String(settings.smtp_from || '').trim(),
    siteName: String(settings.site_name || '校园墙').replace(/[\r\n<>]/g, '').trim() || '校园墙'
  };
}

function closeRetiredTransporter(entry) {
  if (!entry || !entry.retired || entry.activeSends > 0 || entry.closed) return;
  entry.closed = true;
  if (entry.transporter && typeof entry.transporter.close === 'function') {
    try { entry.transporter.close(); } catch (err) {
      console.warn('[Email] 关闭旧 SMTP transporter 失败:', err.message);
    }
  }
}

function retireTransporter(entry) {
  if (!entry) return;
  entry.retired = true;
  closeRetiredTransporter(entry);
}

async function refreshTransporter() {
  const settings = await getEmailSettings();
  // 数据库短暂抖动时继续复用最近一次有效配置，避免通知链路被瞬时查询失败拖垮。
  if (settings === null) {
    return transporterCache && !transporterCache.closed ? transporterCache : null;
  }

  const normalized = normalizeEmailSettings(settings);
  if (!normalized) {
    retireTransporter(transporterCache);
    transporterCache = null;
    return null;
  }

  const cacheKey = JSON.stringify(normalized);
  if (transporterCache && transporterCache.cacheKey === cacheKey && !transporterCache.closed) {
    return transporterCache;
  }

  const next = {
    cacheKey,
    transporter: nodemailer.createTransport({
      host: normalized.smtpHost,
      port: normalized.smtpPort,
      secure: normalized.secure,
      auth: { user: normalized.smtpUser, pass: normalized.smtpPass },
      tls: { rejectUnauthorized: false }
    }),
    smtp_from: normalized.smtpFrom,
    smtp_user: normalized.smtpUser,
    site_name: normalized.siteName,
    activeSends: 0,
    retired: false,
    closed: false
  };
  const previous = transporterCache;
  transporterCache = next;
  retireTransporter(previous);
  return next;
}

async function getTransporterEntry() {
  if (transporterRefreshPromise) return transporterRefreshPromise;
  transporterRefreshPromise = refreshTransporter().finally(function() {
    transporterRefreshPromise = null;
  });
  return transporterRefreshPromise;
}

async function createTransporter() {
  const entry = await getTransporterEntry();
  if (!entry) return null;
  return { transporter: entry.transporter, smtp_from: entry.smtp_from, smtp_user: entry.smtp_user, entry };
}

async function sendEmail(to, subject, html, type, userName) {
  type = type || '';
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    await logEmail(to, subject, type, '无效邮箱', 'fail', '邮箱格式错误', userName);
    return false;
  }
  let result = null;
  try {
    result = await createTransporter();
    if (!result) {
      await logEmail(to, subject, type, 'SMTP未配置', 'fail', 'SMTP未配置或不可用', userName);
      return false;
    }
    const { transporter, smtp_from, smtp_user, entry } = result;
    entry.activeSends += 1;
    const safeSiteName = String(entry.site_name || '校园墙').replace(/[\r\n<>]/g, '').trim() || '校园墙';
    let from;
    if (smtp_from && smtp_from.indexOf('<') > -1) {
      from = smtp_from;
    } else if (smtp_user) {
      from = smtp_from ? smtp_from + ' <' + smtp_user + '>' : safeSiteName + ' <' + smtp_user + '>';
    } else {
      from = process.env.SMTP_FROM || '"' + safeSiteName + '" <noreply@campus-wall.example>';
    }
    await transporter.sendMail({ from, to, subject, html });
    // 注册验证码不写入日志预览，避免验证码残留在数据库中
    var preview = type === 'register_code'
      ? '注册邮箱验证码邮件'
      : html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().substring(0, 200);
    await logEmail(to, subject, type, preview, 'success', '', userName);
    return true;
  } catch (err) {
    console.error('[Email] 邮件发送失败:', err.message);
    await logEmail(to, subject, type, subject, 'fail', err.message, userName);
    return false;
  } finally {
    if (result && result.entry) {
      result.entry.activeSends = Math.max(0, result.entry.activeSends - 1);
      closeRetiredTransporter(result.entry);
    }
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

function kawaiiLayout(title, bodyContent, siteUrl, siteName) {
  const brandName = escapeHtml(siteName || '校园墙');
  const safeTitle = escapeHtml(title || '来自站点的一封信');
  const safeSiteUrl = escapeHtml(siteUrl || process.env.SITE_URL || 'https://campus-wall.example');
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
                <h1 style="color:#fff;margin:10px 0 0;font-size:22px;font-weight:700;letter-spacing:1px;text-shadow:0 2px 8px rgba(0,0,0,0.08);">${safeTitle}</h1>
                <div style="margin-top:8px;font-size:13px;color:rgba(255,255,255,0.75);">💌 来自 ${brandName} 的一封信</div>
              </td>
            </tr>
            <tr>
              <td style="padding:28px 24px 24px;background:#FFFCFA;">
                ${bodyContent}
              </td>
            </tr>
            <tr>
              <td style="padding:0 24px 24px;text-align:center;background:#FFFCFA;">
                <a href="${safeSiteUrl}" style="display:inline-block;padding:10px 28px;background:linear-gradient(135deg,#FF9ABF,#C084FC);color:#fff;text-decoration:none;border-radius:20px;font-size:14px;font-weight:600;box-shadow:0 4px 12px rgba(255,107,157,0.25);">✨ 去看看</a>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 24px;background:#F8F5FF;border-top:1px solid rgba(255,107,157,0.06);text-align:center;">
                <div style="color:#B8A9D4;font-size:12px;line-height:1.8;">
                  <div>🪄 ${brandName} — 校园信息交流平台</div>
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

function registrationEmailHtml(code, nickname, siteName, siteDescription, siteUrl) {
  const safeNickname = escapeHtml(nickname || '同学');
  const safeSiteName = escapeHtml(siteName || '校园墙');
  const safeDescription = escapeHtml(siteDescription || '校园信息交流平台');
  const safeCode = escapeHtml(code);
  const body = `
    <p style="font-size:15px;color:#4A3F5C;margin:0 0 12px;line-height:1.7;">亲爱的 <strong style="color:#FF6B9D;">${safeNickname}</strong> 同学：</p>
    <p style="font-size:15px;color:#4A3F5C;margin:0 0 14px;line-height:1.8;">欢迎注册 <strong style="color:#C084FC;">${safeSiteName}</strong>！请使用下面的验证码完成邮箱验证。</p>
    <div style="background:linear-gradient(135deg,#FFF0F6 0%,#F3EDFF 100%);border:1px solid rgba(192,132,252,.24);border-radius:18px;padding:20px 16px;margin:16px 0;text-align:center;">
      <div style="font-size:12px;color:#9B8BB8;letter-spacing:2px;margin-bottom:8px;">EMAIL VERIFICATION CODE</div>
      <div style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:34px;line-height:1.2;letter-spacing:10px;color:#7C3AED;font-weight:800;padding-left:10px;user-select:all;">${safeCode}</div>
      <div style="font-size:12px;color:#9B8BB8;margin-top:10px;">验证码 10 分钟内有效，请勿泄露给他人</div>
    </div>
    <div style="background:#FFFAF2;border-radius:14px;padding:14px 16px;margin:16px 0;color:#6B5A45;font-size:13px;line-height:1.8;">
      <div style="font-weight:700;color:#B7791F;margin-bottom:4px;">✨ 注册完成后，你可以</div>
      <div>💬 分享校园里的新鲜事，和同学友好交流</div>
      <div>🎵 参与广播站点歌与校园活动</div>
      <div>🌟 关注感兴趣的内容，收获属于你的校园记忆</div>
    </div>
    <p style="font-size:14px;color:#8B7BA5;margin:0;line-height:1.8;">${safeDescription}，期待在这里遇见你～</p>
    <p style="font-size:13px;color:#B8A9D4;margin:14px 0 0;line-height:1.7;">如果这不是你本人的操作，请忽略此邮件。为了保护账号安全，请不要转发验证码。</p>`;
  return kawaiiLayout('注册邮箱验证码', body, siteUrl, siteName);
}

async function sendRegistrationCodeEmail(email, code, nickname) {
  const settings = await getEmailSettings();
  const siteName = String(settings.site_name || '校园墙').replace(/[\r\n]/g, '').trim() || '校园墙';
  const siteUrl = process.env.SITE_URL || 'https://campus-wall.example';
  const subject = '【' + siteName + '】注册邮箱验证码';
  const html = registrationEmailHtml(code, nickname, siteName, settings.site_description, siteUrl);
  return sendEmail(email, subject, html, 'register_code', nickname);
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
    subject: '💬 收到新评论 · 校园墙',
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
    subject: '❤️ 收到点赞 · 校园墙',
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
    subject: '📢 有人提到了你 · 校园墙',
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
    subject: '🌟 新粉丝 · 校园墙',
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
    subject: '✅ 帖子审核通过 · 校园墙',
    notifyField: 'notify_post_approved',
    buildBody: function(p) {
      return `<p style="font-size:15px;color:#4A3F5C;margin:0 0 12px;line-height:1.7;">亲爱的 <strong style="color:#FF6B9D;">${p.userNickname}</strong> 同学：</p>
<p style="font-size:15px;color:#4A3F5C;margin:0 0 6px;">🎉 您的帖子审核通过啦！</p>
${contentCard(`<div style="text-align:center;font-size:18px;font-weight:600;color:#10B981;">✅ 《${p.postTitle}》</div><div style="text-align:center;font-size:13px;color:#6B7280;margin-top:8px;">现在其他同学可以看到你的帖子了~</div>`)}`;
    }
  },
  post_rejected: {
    title: '审核未通过',
    subject: '💔 帖子未通过审核 · 校园墙',
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
    subject: '🎵 点歌审核通过 · 校园墙',
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
    subject: '💔 点歌未通过审核 · 校园墙',
    notifyField: 'notify_song_rejected',
    buildBody: function(p) {
      return `<p style="font-size:15px;color:#4A3F5C;margin:0 0 12px;line-height:1.7;">亲爱的 <strong style="color:#FF6B9D;">${p.userNickname}</strong> 同学：</p>
<p style="font-size:15px;color:#4A3F5C;margin:0 0 6px;">😢 您点的歌未通过审核</p>
${contentCard(`
      <div style="text-align:center;font-size:16px;font-weight:600;color:#92400E;">🎵 ${p.songName} - ${p.artist}</div>
      ${p.reason ? '<div style="text-align:center;font-size:13px;color:#991B1B;background:#FEF3C7;padding:8px 12px;border-radius:10px;margin-top:8px;">原因：' + escapeHtml(p.reason).replace(/\n/g, '<br>') + '</div>' : ''}
    `)}
<p style="font-size:14px;color:#B8A9D4;margin:0;">💡 可以重新选择其他歌曲哦~</p>`;
    }
  },
  song_played: {
    title: '点歌已经播放啦',
    subject: '🎉 您的点歌已播放 · 校园墙',
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
    subject: '📬 反馈收到回复 · 校园墙',
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
    subject: '📝 关注的人发布了新帖子 · 校园墙',
    notifyField: 'notify_follow_post',
    buildBody: function(p) {
      var postLink = 'https://campus-wall.example/post/' + p.postId;
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

    const siteUrl = process.env.SITE_URL || 'https://campus-wall.example';
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
      await sendEmail(admin.email, '📝 新帖子待审核 · 校园墙', kawaiiLayout('新帖子待审核', body), 'admin_pending_post', adminName);
    }
  } catch (err) {
    console.error('[Email] 通知管理员审核失败:', err.message);
  }
}

module.exports = {
  sendEmail, kawaiiLayout, sendRegistrationCodeEmail,
  notifyNewComment, notifyNewLike, notifyMention, notifyNewFollower,
  notifyPostApproved, notifyPostRejected, notifySongApproved, notifySongRejected,
  notifySongPlayed, notifyFeedbackReply, notifyFollowPost, notifyAdminNewPostPending
};
