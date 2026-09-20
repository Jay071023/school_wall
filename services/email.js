/**
 * 邮件发送服务 - ✨ 卡哇伊风格邮件模板
 * 所有通知函数统一通过 notifyUser() 分发
 */

const nodemailer = require('nodemailer');
const { escapeHtml } = require('./html-utils');
const { withTimeout } = require('./async-utils');

// 表结构只需确保一次；失败时清空 promise，下一次发送仍可重试。
let emailLogsTablePromise = null;
// transporter 按“实际 SMTP 配置”缓存，而不是按请求缓存。配置变化时先切换新实例，
// 等旧实例没有发送中的邮件后再关闭，避免刷新配置打断正在发送的邮件。
let transporterCache = null;
let transporterRefreshPromise = null;

// SMTP 服务商不可达或限流时必须尽快结束请求，不能让反向代理等待到 524。
const SMTP_CONNECTION_TIMEOUT_MS = 10000;
const SMTP_GREETING_TIMEOUT_MS = 10000;
const SMTP_SOCKET_TIMEOUT_MS = 20000;
const SMTP_SEND_TIMEOUT_MS = 20000;
const EMAIL_LOG_TIMEOUT_MS = 5000;

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

async function logEmailSafely(to, subject, type, contentPreview, status, errorMsg, userName) {
  try {
    await withTimeout(
      logEmail(to, subject, type, contentPreview, status, errorMsg, userName),
      EMAIL_LOG_TIMEOUT_MS,
      '邮件日志写入超时'
    );
  } catch (err) {
    console.warn('[Email] 邮件日志写入失败:', err.message);
  }
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
    siteName: String(settings.site_name || '示例校园墙').replace(/[\r\n<>]/g, '').trim() || '示例校园墙'
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
      tls: { rejectUnauthorized: false },
      connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
      greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
      socketTimeout: SMTP_SOCKET_TIMEOUT_MS
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
    await logEmailSafely(to, subject, type, '无效邮箱', 'fail', '邮箱格式错误', userName);
    return false;
  }
  let result = null;
  try {
    result = await createTransporter();
    if (!result) {
      await logEmailSafely(to, subject, type, 'SMTP未配置', 'fail', 'SMTP未配置或不可用', userName);
      return false;
    }
    const { transporter, smtp_from, smtp_user, entry } = result;
    entry.activeSends += 1;
    const safeSiteName = String(entry.site_name || '示例校园墙').replace(/[\r\n<>]/g, '').trim() || '示例校园墙';
    let from;
    if (smtp_from && smtp_from.indexOf('<') > -1) {
      from = smtp_from;
    } else if (smtp_user) {
      from = smtp_from ? smtp_from + ' <' + smtp_user + '>' : safeSiteName + ' <' + smtp_user + '>';
    } else {
      from = process.env.SMTP_FROM || '"' + safeSiteName + '" <noreply@localhost:3000>';
    }
    await withTimeout(
      transporter.sendMail({ from, to, subject, html }),
      SMTP_SEND_TIMEOUT_MS,
      'SMTP发送超时'
    );
    // 注册验证码不写入日志预览，避免验证码残留在数据库中
    var preview = type === 'register_code'
      ? '注册邮箱验证码邮件'
      : html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().substring(0, 200);
    await logEmailSafely(to, subject, type, preview, 'success', '', userName);
    return true;
  } catch (err) {
    console.error('[Email] 邮件发送失败:', err.message);
    await logEmailSafely(to, subject, type, subject, 'fail', err.message, userName);
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
  const brandName = escapeHtml(siteName || '示例校园墙');
  const safeTitle = escapeHtml(title || '来自站点的一封信');
  const safeSiteUrl = escapeHtml(siteUrl || process.env.SITE_URL || 'http://localhost:3000');
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

// 点歌通知独立使用一套克制、对比度明确的表格模板。邮件客户端对深色模式的
// 改写各不相同，因此这里不用媒体查询或强制深色配色，只给每个区域提供可读的实色。
function formatSongPlayDate(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!match) return raw || '待确认';
  return match[1] + '年' + String(match[2]).padStart(2, '0') + '月' + String(match[3]).padStart(2, '0') + '日';
}

function formatSongTime(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d{1,2}):(\d{2})/);
  return match ? String(match[1]).padStart(2, '0') + ':' + match[2] : '';
}

function getSongSchedule(p) {
  const startTime = formatSongTime(p.startTime || p.start_time);
  const endTime = formatSongTime(p.endTime || p.end_time);
  return {
    playDate: formatSongPlayDate(p.playDate || p.play_date),
    slotName: String(p.slotName || p.slot_name || '').trim() || '待确认',
    timeRange: startTime && endTime ? startTime + ' - ' + endTime : '待确认'
  };
}

function songEmailLayout(title, preheader, bodyContent, actionUrl, actionText, options) {
  options = options || {};
  const safeTitle = escapeHtml(title || '广播站点歌通知');
  const safePreheader = escapeHtml(preheader || '示例校园墙广播站通知');
  const safeUrl = escapeHtml(actionUrl || process.env.SITE_URL || 'http://localhost:3000');
  const safeActionText = escapeHtml(actionText || '打开校园墙');
  const accent = options.accent || '#ec4899';
  const accentSoft = options.accentSoft || '#fff1f6';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="x-apple-disable-message-reformatting">
</head>
<body style="margin:0;padding:0;background-color:#fff7fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif;color:#33263d;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${safePreheader}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:#fff7fb;">
    <tr><td align="center" style="padding:18px 10px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background-color:#ffffff;border:1px solid #f1ddea;border-radius:22px;overflow:hidden;">
        <tr><td style="height:6px;padding:0;background-color:${accent};font-size:0;line-height:0;">&nbsp;</td></tr>
        <tr><td style="padding:22px 22px 20px;background-color:${accentSoft};">
          <div style="margin:0 0 7px;color:${accent};font-size:12px;font-weight:800;letter-spacing:1.4px;line-height:18px;">示例校园墙 · 校园广播站</div>
          <div style="margin:0;color:#33263d;font-size:24px;font-weight:800;line-height:32px;">${safeTitle}</div>
          <div style="margin:8px 0 0;color:#8d7795;font-size:12px;line-height:18px;">一封关于你点歌的小消息</div>
        </td></tr>
        <tr><td style="padding:22px 22px 8px;background-color:#ffffff;">
          ${bodyContent}
        </td></tr>
        <tr><td align="center" style="padding:14px 22px 26px;background-color:#ffffff;">
          <a href="${safeUrl}" style="display:inline-block;padding:12px 22px;background-color:${accent};border-radius:999px;color:#ffffff;font-size:15px;font-weight:800;line-height:20px;text-decoration:none;">${safeActionText}　→</a>
        </td></tr>
        <tr><td style="padding:15px 22px;background-color:#fff7fb;border-top:1px solid #f1ddea;">
          <div style="color:#9b849f;font-size:12px;line-height:18px;text-align:center;">系统自动发送 · 愿每一首歌都被认真听见</div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function songScheduleTable(schedule) {
  const rows = [
    ['播放日期', schedule.playDate],
    ['广播时段', schedule.slotName],
    ['播放时间', schedule.timeRange]
  ].map(function(row) {
    return `<tr>
      <td style="width:92px;padding:10px 0;border-bottom:1px solid #d8e1ec;color:#526176;font-size:14px;line-height:20px;vertical-align:top;">${escapeHtml(row[0])}</td>
      <td style="padding:10px 0;border-bottom:1px solid #d8e1ec;color:#172033;font-size:15px;font-weight:700;line-height:20px;vertical-align:top;">${escapeHtml(row[1])}</td>
    </tr>`;
  }).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:18px 0 0;border-top:1px solid #d8e1ec;">${rows}</table>`;
}

function songInfoCard(p, requesterLabel) {
  const songName = escapeHtml(p.songName || '未知歌曲');
  const artist = escapeHtml(p.artist || '未知歌手');
  const requester = escapeHtml(p.userNickname || p.requesterName || '匿名同学');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:0 0 16px;background-color:#fff7fb;border:1px solid #f1ddea;border-radius:16px;">
    <tr><td style="padding:17px 18px 7px;color:#c04b82;font-size:12px;font-weight:800;letter-spacing:1px;line-height:18px;">🎵 这首歌</td></tr>
    <tr><td style="padding:0 18px;color:#33263d;font-size:21px;font-weight:800;line-height:29px;word-break:break-word;">${songName}</td></tr>
    <tr><td style="padding:4px 18px 13px;color:#705d78;font-size:14px;line-height:21px;word-break:break-word;">歌手：${artist}</td></tr>
    <tr><td style="padding:11px 18px;border-top:1px dashed #ead5e3;color:#8d7795;font-size:13px;line-height:20px;">${escapeHtml(requesterLabel || '点歌人')}：<strong style="color:#4c3c55;">${requester}</strong></td></tr>
  </table>`;
}

function songScheduleCard(schedule, label, accent, soft) {
  accent = accent || '#7c3aed';
  soft = soft || '#f6f1ff';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:0 0 16px;background-color:${soft};border:1px solid #e5dafa;border-radius:16px;">
    <tr><td colspan="2" style="padding:15px 18px 8px;color:${accent};font-size:12px;font-weight:800;letter-spacing:1px;line-height:18px;">📅 ${escapeHtml(label || '播放安排')}</td></tr>
    <tr>
      <td style="width:50%;padding:0 10px 15px 18px;vertical-align:top;"><div style="color:#9a88a5;font-size:12px;line-height:18px;">播放日期</div><div style="margin-top:3px;color:#33263d;font-size:15px;font-weight:800;line-height:21px;word-break:break-word;">${escapeHtml(schedule.playDate)}</div></td>
      <td style="width:50%;padding:0 18px 15px 10px;vertical-align:top;"><div style="color:#9a88a5;font-size:12px;line-height:18px;">时段 / 时间</div><div style="margin-top:3px;color:#33263d;font-size:14px;font-weight:800;line-height:21px;word-break:break-word;">${escapeHtml(schedule.slotName)}</div><div style="margin-top:2px;color:${accent};font-size:13px;font-weight:800;line-height:19px;">${escapeHtml(schedule.timeRange)}</div></td>
    </tr>
  </table>`;
}

function songApprovedEmailHtml(p) {
  const schedule = getSongSchedule(p);
  const nickname = escapeHtml(p.userNickname || '同学');
  const body = `<p style="margin:0 0 14px;color:#4c3c55;font-size:16px;line-height:25px;">${nickname} 同学，喜欢的歌已经排上啦 ✨</p>
    ${songInfoCard(p)}
    ${songScheduleCard(schedule, '已加入播放安排', '#7c3aed', '#f6f1ff')}
    <div style="margin:0 0 8px;padding:12px 14px;background-color:#fffaf0;border:1px solid #f4e5bd;border-radius:12px;color:#80632b;font-size:13px;line-height:21px;">到点记得来听听；如果临时调整，后台会再次通知你。</div>`;
  return songEmailLayout('点歌通过啦', '你的点歌已安排在 ' + schedule.playDate + ' ' + schedule.timeRange + ' 播放。', body, process.env.SITE_URL || 'http://localhost:3000/radio', '查看我的点歌', { accent: '#7c3aed', accentSoft: '#f6f1ff' });
}

function songPendingAdminEmailHtml(p, adminUrl) {
  const schedule = getSongSchedule(p);
  const body = `<p style="margin:0 0 14px;color:#4c3c55;font-size:16px;line-height:25px;">有一首同学认真选的歌，正在等你安排 🎧</p>
    ${songInfoCard({ songName: p.songName, artist: p.artist, userNickname: p.requesterName }, '点歌人')}
    ${songScheduleCard(schedule, '同学希望的播放时间', '#2563eb', '#eef5ff')}
    <div style="margin:0 0 8px;padding:12px 14px;background-color:#fff7fb;border:1px solid #f1ddea;border-radius:12px;color:#705d78;font-size:13px;line-height:21px;">请在后台确认是否按预约时间播放；需要调整时，可以直接改到其他已开放的日期和时段。</div>`;
  return songEmailLayout('有新的点歌待审核', '一首点歌等待审核：' + schedule.playDate + ' ' + schedule.timeRange + '。', body, adminUrl, '打开点歌管理', { accent: '#2563eb', accentSoft: '#eef5ff' });
}

function songPlayedEmailHtml(p) {
  const nickname = escapeHtml(p.userNickname || '同学');
  const body = `<p style="margin:0 0 14px;color:#4c3c55;font-size:16px;line-height:25px;">${nickname} 同学，你点的歌已经顺利播放啦 🎉</p>
    ${songInfoCard(p)}
    <div style="margin:0 0 8px;padding:13px 14px;background-color:#eefbf4;border:1px solid #ccefdc;border-radius:12px;color:#3e7154;font-size:13px;line-height:21px;">谢谢你的参与。想把下一首歌送给谁，随时再来点一首。</div>`;
  return songEmailLayout('你的点歌已经播放', '你点的《' + String(p.songName || '这首歌') + '》已经在广播站播放。', body, process.env.SITE_URL || 'http://localhost:3000/radio', '再去点一首歌', { accent: '#159a62', accentSoft: '#eefbf4' });
}

function registrationEmailHtml(code, nickname, siteName, siteDescription, siteUrl) {
  const safeNickname = escapeHtml(nickname || '同学');
  const safeSiteName = escapeHtml(siteName || '示例校园墙');
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
  const siteName = String(settings.site_name || '示例校园墙').replace(/[\r\n]/g, '').trim() || '示例校园墙';
  const siteUrl = process.env.SITE_URL || 'http://localhost:3000';
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
    subject: '💬 收到新评论 · 示例校园墙',
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
    subject: '❤️ 收到点赞 · 示例校园墙',
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
    subject: '📢 有人提到了你 · 示例校园墙',
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
    subject: '🌟 新粉丝 · 示例校园墙',
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
    subject: '✅ 帖子审核通过 · 示例校园墙',
    notifyField: 'notify_post_approved',
    buildBody: function(p) {
      return `<p style="font-size:15px;color:#4A3F5C;margin:0 0 12px;line-height:1.7;">亲爱的 <strong style="color:#FF6B9D;">${p.userNickname}</strong> 同学：</p>
<p style="font-size:15px;color:#4A3F5C;margin:0 0 6px;">🎉 您的帖子审核通过啦！</p>
${contentCard(`<div style="text-align:center;font-size:18px;font-weight:600;color:#10B981;">✅ 《${p.postTitle}》</div><div style="text-align:center;font-size:13px;color:#6B7280;margin-top:8px;">现在其他同学可以看到你的帖子了~</div>`)}`;
    }
  },
  post_rejected: {
    title: '审核未通过',
    subject: '💔 帖子未通过审核 · 示例校园墙',
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
    subject: '🎵 点歌审核通过 · 示例校园墙',
    notifyField: 'notify_song_approved',
    buildBody: function(p) {
      // 审核通过邮件走独立模板，避免旧的卡哇伊布局在各类客户端中出现低对比度文字。
      return songApprovedEmailHtml(p);
    }
  },
  song_rejected: {
    title: '本期暂未选中',
    subject: '🎧 本期点歌暂未选中 · 示例校园墙',
    notifyField: 'notify_song_rejected',
    buildBody: function(p) {
      const schedule = getSongSchedule(p);
      const reason = String(p.reason || '').trim();
      const unavailable = /满|结束|开放|容量|名额|排期/.test(reason);
      const stateLabel = unavailable ? '本期排期已满' : '这次暂未选中';
      const body = `<p style="margin:0 0 14px;color:#4c3c55;font-size:16px;line-height:25px;">${escapeHtml(p.userNickname || '同学')} 同学，这首歌这次暂时没能排上，但它依然值得被听见。</p>
        ${songInfoCard(p)}
        ${songScheduleCard(schedule, '你希望的播放时间', '#d97706', '#fff7ed')}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:0 0 16px;background-color:#fff4ee;border:1px solid #f5d8c8;border-radius:16px;">
          <tr><td style="padding:14px 16px 5px;color:#c45b30;font-size:12px;font-weight:800;letter-spacing:1px;line-height:18px;">💌 ${stateLabel}</td></tr>
          <tr><td style="padding:0 16px 15px;color:#765347;font-size:14px;line-height:22px;word-break:break-word;">${reason ? '原因：' + escapeHtml(reason).replace(/\n/g, '<br>') : '这期安排暂时没有为它留出位置。'}</td></tr>
        </table>
        <div style="margin:0 0 8px;padding:12px 14px;background-color:#fff7fb;border:1px solid #f1ddea;border-radius:12px;color:#705d78;font-size:13px;line-height:21px;">别灰心，欢迎下次再来点歌；我们会继续期待在广播里听到你的选择。</div>`;
      return songEmailLayout('这首歌本期暂未选中', '你点的《' + String(p.songName || '这首歌') + '》本期暂未安排播放，欢迎下次再来点歌。', body, process.env.SITE_URL || 'http://localhost:3000/radio', '再去点一首歌', { accent: '#d97706', accentSoft: '#fff4ee' });
    }
  },
  song_played: {
    title: '点歌已经播放啦',
    subject: '🎉 您的点歌已播放 · 示例校园墙',
    notifyField: 'notify_song_played',
    buildBody: function(p) {
      return songPlayedEmailHtml(p);
    }
  },
  feedback_reply: {
    title: '反馈回复',
    subject: '📬 反馈收到回复 · 示例校园墙',
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
    subject: '📝 关注的人发布了新帖子 · 示例校园墙',
    notifyField: 'notify_follow_post',
    buildBody: function(p) {
      var postLink = 'http://localhost:3000/post/' + p.postId;
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
  if (type === 'song_approved' || type === 'song_rejected' || type === 'song_played') {
    return sendEmail(email, cfg.subject, cfg.buildBody(params), type, nickname);
  }
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

async function notifySongApproved(userEmail, userNickname, songName, artist, slotName, userId, schedule) {
  // `schedule` 为可选参数，保留已有调用方兼容；新调用方应传 playDate、startTime、endTime。
  schedule = schedule || {};
  return notifyUser('song_approved', {
    email: userEmail,
    nickname: userNickname,
    userId: userId,
    userNickname: userNickname,
    songName: songName,
    artist: artist,
    slotName: slotName,
    playDate: schedule.playDate || schedule.play_date,
    startTime: schedule.startTime || schedule.start_time,
    endTime: schedule.endTime || schedule.end_time
  });
}

async function notifySongRejected(userEmail, userNickname, songName, artist, reason, userId, schedule) {
  schedule = schedule || {};
  return notifyUser('song_rejected', { email: userEmail, nickname: userNickname, userId: userId, userNickname: userNickname, songName: songName, artist: artist, reason: reason, playDate: schedule.playDate || schedule.play_date, slotName: schedule.slotName || schedule.slot_name, startTime: schedule.startTime || schedule.start_time, endTime: schedule.endTime || schedule.end_time });
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

    const siteUrl = process.env.SITE_URL || 'http://localhost:3000';
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
      await sendEmail(admin.email, '📝 新帖子待审核 · 示例校园墙', kawaiiLayout('新帖子待审核', body), 'admin_pending_post', adminName);
    }
  } catch (err) {
    console.error('[Email] 通知管理员审核失败:', err.message);
  }
}

/**
 * 普通用户提交点歌后提醒广播管理员和最高管理员。是否发送由最高管理员在系统设置中控制。
 */
async function notifyRadioAdminsNewSongPending(song) {
  try {
    const { pool } = require('../config/database');
    const [notifySetting] = await pool.execute(
      'SELECT config_value FROM settings WHERE config_key = "song_pending_admin_notify" LIMIT 1'
    );
    if (notifySetting.length > 0 && ['false', '0', 'off'].includes(String(notifySetting[0].config_value || '').toLowerCase())) return;
    const [radioAdmins] = await pool.execute(
      'SELECT id, email, nickname, username FROM users WHERE role IN ("radio_admin", "super_admin") AND email IS NOT NULL AND email != ""'
    );
    if (radioAdmins.length === 0) return;

    const siteUrl = process.env.SITE_URL || 'http://localhost:3000';
    const songAdminUrl = siteUrl.replace(/\/$/, '') + '/admin';
    const html = songPendingAdminEmailHtml(song || {}, songAdminUrl);

    const sentEmails = new Set();
    for (const radioAdmin of radioAdmins) {
      if (sentEmails.has(String(radioAdmin.email).toLowerCase())) continue;
      sentEmails.add(String(radioAdmin.email).toLowerCase());
      const adminName = radioAdmin.nickname || radioAdmin.username || '广播管理员';
      await sendEmail(radioAdmin.email, '🎵 新点歌待审核 · 示例校园墙', html, 'song_pending_admin', adminName);
    }
  } catch (err) {
    console.error('[Email] 通知广播管理员审核失败:', err.message);
  }
}

module.exports = {
  sendEmail, kawaiiLayout, sendRegistrationCodeEmail,
  notifyNewComment, notifyNewLike, notifyMention, notifyNewFollower,
  notifyPostApproved, notifyPostRejected, notifySongApproved, notifySongRejected,
  notifySongPlayed, notifyFeedbackReply, notifyFollowPost, notifyAdminNewPostPending,
  notifyRadioAdminsNewSongPending
};
