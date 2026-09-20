const express = require('express');
const fs = require('fs');
const path = require('path');
const { pool, ensureNotificationsTable } = require('../config/database');
const { auth, isStaff, adminOnly, superAdminOnly, requirePermission, ROLE_NAMES } = require('../middleware/auth');
const { pushPost, pushToBaidu } = require('../services/baidu-push');
const { notifyPostApproved, notifyPostRejected, notifySongApproved, notifySongRejected, notifySongPlayed } = require('../services/email');
const jwt = require('jsonwebtoken');
const mpDraftService = require('../services/mp-draft');
const aiService = require('../services/ai');
const { generateCoverPrompt } = require('../services/cover-prompt');
const { getPagination } = require('../services/pagination');
const { adjustUserPoints, awardTitle } = require('../services/gamification');
const { getReleaseNotes } = require('../services/release-notes');
const { getChinaDate, getChinaJsDayOfWeek } = require('../services/date');
const siteRouter = require('./site');
const router = express.Router();
const { getIpRegion } = require('../services/ip-lookup');
const DEPLOY_STATUS_FILE = path.resolve(
  process.env.DEPLOY_STATUS_FILE || path.join(__dirname, '..', 'logs', 'deploy-status.json')
);
const APP_VERSION = require('../package.json').version;

const SITE_URL = 'http://localhost:3000';
const JWT_SECRET = process.env.JWT_SECRET || require('crypto').randomBytes(32).toString('hex');
const DEFAULT_SONG_REJECT_REASONS = [
  '当前播放时段名额已满，请选择其他时段再点歌。',
  '本周暂未开放点歌，请下周再来。',
  '歌曲内容不适合校园广播，请更换其他歌曲。',
  '歌曲信息不完整，请补充歌名或歌手后重新提交。',
  '该歌曲已重复点歌，请选择其他歌曲。',
  '当前歌曲暂时无法播放，请更换其他歌曲。'
];

function normalizeSongRejectReasons(value) {
  let reasons = value;
  if (typeof reasons === 'string') {
    try {
      reasons = JSON.parse(reasons);
    } catch (e) {
      reasons = reasons.split(/\r?\n/);
    }
  }
  if (!Array.isArray(reasons)) return DEFAULT_SONG_REJECT_REASONS.slice();
  reasons = reasons.map(reason => String(reason || '').trim().slice(0, 500)).filter(Boolean).slice(0, 20);
  return reasons.length > 0 ? reasons : DEFAULT_SONG_REJECT_REASONS.slice();
}

function getErrorDetail(err) {
  return err && (err.code || err.message) || 'unknown error';
}

function normalizeDateOnly(value) {
  if (!value) return null;
  const date = String(value).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

function slotDateValue(value) {
  return value ? String(value).split('T')[0] : '';
}

function parseSongSlotDateId(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

// slot_dates 是已生成的日期记录，周期规则后来被修改时仍可能残留旧记录。
// 审核改期和用户提交都必须再次按当前规则校验，不能把旧记录当作可用时段。
function isSlotDateAllowedByCurrentSchedule(slotDate) {
  const allowedDays = String(slotDate.weekdays || '')
    .split(',').map(Number).filter(day => Number.isInteger(day) && day >= 0 && day <= 6);
  return allowedDays.length === 0 || Number(slotDate.manual_override) === 1 ||
    allowedDays.includes(getChinaJsDayOfWeek(slotDateValue(slotDate.play_date)));
}

function songReviewValidationError(message) {
  const error = new Error(message);
  error.isSongReviewValidationError = true;
  return error;
}

function assertCustomPlayDate(value) {
  const playDate = normalizeDateOnly(value);
  if (!playDate) throw songReviewValidationError('播放日期格式不正确，请选择日期');
  const today = getChinaDate();
  if (playDate < today) throw songReviewValidationError('播放日期不能早于今天');
  if (playDate > getChinaDate(365)) throw songReviewValidationError('播放日期最多只能安排未来一年');
  return playDate;
}

async function createCustomSlotDate(connection, requestedSlotId, requestedPlayDate) {
  const slotId = parseSongSlotDateId(requestedSlotId);
  if (!slotId) throw songReviewValidationError('请选择有效的播放时段');
  const playDate = assertCustomPlayDate(requestedPlayDate);
  const [slots] = await connection.execute(
    'SELECT id, name, start_time, end_time, weekdays, effective_start_date FROM time_slots WHERE id = ? AND is_active = 1 FOR UPDATE',
    [slotId]
  );
  if (slots.length === 0) throw songReviewValidationError('所选播放时段不存在或已关闭');
  const slot = slots[0];
  if (slot.effective_start_date && playDate < slotDateValue(slot.effective_start_date)) {
    throw songReviewValidationError('播放日期早于该时段的生效日期');
  }
  const [existing] = await connection.execute(
    'SELECT sd.id, sd.slot_id, sd.play_date, sd.max_songs, sd.is_active, sd.manual_override, ts.name AS slot_name, ts.start_time, ts.end_time, ts.weekdays ' +
    'FROM slot_dates sd JOIN time_slots ts ON ts.id = sd.slot_id WHERE sd.slot_id = ? AND sd.play_date = ? FOR UPDATE',
    [slotId, playDate]
  );
  if (existing.length > 0) {
    if (Number(existing[0].is_active) !== 1) throw songReviewValidationError('所选日期已被管理员关闭');
    // 明确指定的日期属于单日安排，即使不在周期星期内也允许播放。
    if (Number(existing[0].manual_override) !== 1 && !isSlotDateAllowedByCurrentSchedule(existing[0])) {
      await connection.execute('UPDATE slot_dates SET manual_override = 1 WHERE id = ?', [existing[0].id]);
      existing[0].manual_override = 1;
    }
    return existing[0];
  }
  // 旧版本数据库可能没有 time_slots.max_songs；容量实际保存在 slot_dates，
  // 取该时段最近一条日期配置作为新日期的容量，找不到时使用默认 10 首。
  let maxSongs = 10;
  const [capacityRows] = await connection.execute(
    'SELECT max_songs FROM slot_dates WHERE slot_id = ? ORDER BY play_date DESC, id DESC LIMIT 1 FOR UPDATE',
    [slotId]
  );
  if (capacityRows.length > 0 && Number(capacityRows[0].max_songs) > 0) {
    maxSongs = Number(capacityRows[0].max_songs);
  }
  await connection.execute(
    'INSERT INTO slot_dates (slot_id, play_date, max_songs, is_active, manual_override) VALUES (?, ?, ?, 1, 1)',
    [slotId, playDate, maxSongs]
  );
  const [created] = await connection.execute(
    'SELECT sd.id, sd.slot_id, sd.play_date, sd.max_songs, sd.is_active, sd.manual_override, ts.name AS slot_name, ts.start_time, ts.end_time, ts.weekdays ' +
    'FROM slot_dates sd JOIN time_slots ts ON ts.id = sd.slot_id WHERE sd.slot_id = ? AND sd.play_date = ? FOR UPDATE',
    [slotId, playDate]
  );
  if (created.length === 0) throw songReviewValidationError('创建播放日期失败，请重试');
  return created[0];
}

async function approveSongWithSchedule(connection, songId, requestedSlotDateId, playOrder, requestedPlayDate, requestedSlotId, allowOverbook = false) {
  const [songs] = await connection.execute(
    'SELECT id, status, slot_id, slot_date_id FROM song_requests WHERE id = ? AND deleted_at IS NULL FOR UPDATE',
    [songId]
  );
  if (songs.length === 0) throw songReviewValidationError('点歌记录不存在或已在回收站');
  if (songs[0].status !== 'pending') throw songReviewValidationError('该点歌已不在待审核状态，请刷新后重试');

  let slotDate;
  if (requestedPlayDate) {
    slotDate = await createCustomSlotDate(connection, requestedSlotId || songs[0].slot_id, requestedPlayDate);
  }
  const slotDateId = requestedPlayDate ? slotDate.id : (requestedSlotDateId || parseSongSlotDateId(songs[0].slot_date_id));
  if (!slotDateId) throw songReviewValidationError('请选择有效的播放时段');

  if (!slotDate) {
    const today = getChinaDate();
    const rangeEnd = getChinaDate(14);
    const [slotDates] = await connection.execute(
      'SELECT sd.id, sd.slot_id, sd.play_date, sd.max_songs, sd.manual_override, ts.name AS slot_name, ts.start_time, ts.end_time, ts.weekdays ' +
      'FROM slot_dates sd JOIN time_slots ts ON ts.id = sd.slot_id ' +
      'WHERE sd.id = ? AND sd.is_active = 1 AND ts.is_active = 1 ' +
      'AND (ts.effective_start_date IS NULL OR sd.play_date >= ts.effective_start_date) ' +
      'AND sd.play_date >= ? AND sd.play_date < ? FOR UPDATE',
      [slotDateId, today, rangeEnd]
    );
    if (slotDates.length === 0) throw songReviewValidationError('所选播放时段不可用、已关闭或已过期，请重新选择');
    slotDate = slotDates[0];
  }
  if (!requestedPlayDate && !isSlotDateAllowedByCurrentSchedule(slotDate)) {
    throw songReviewValidationError('所选日期不在当前开放周期内，请重新选择');
  }

  // 当前点歌本身若仍占用这个日期，统计时排除它，避免“改回原时段”被误判为满。
  const [countRows] = await connection.execute(
    'SELECT COUNT(*) AS cnt FROM song_requests WHERE slot_date_id = ? AND id <> ? ' +
    'AND deleted_at IS NULL AND status IN ("pending", "approved")',
    [slotDateId, songId]
  );
  if (!allowOverbook && Number(countRows[0].cnt) >= Number(slotDate.max_songs)) {
    throw songReviewValidationError('所选播放时段已满，请选择其他时段');
  }

  const updates = ['status = ?', 'reject_reason = NULL', 'slot_id = ?', 'slot_date_id = ?'];
  const values = ['approved', slotDate.slot_id, slotDate.id];
  if (playOrder !== undefined) {
    updates.push('play_order = ?');
    values.push(playOrder);
  }
  values.push(songId);
  await connection.execute(
    `UPDATE song_requests SET ${updates.join(', ')} WHERE id = ? AND deleted_at IS NULL`,
    values
  );
  return slotDate;
}

// 已通过点歌的调期必须单独走事务：锁定点歌和目标日期，重新校验日期周期、
// 时段启用状态及容量，避免只依赖后台页面传值或并发审核造成超额播放。
async function rescheduleApprovedSong(connection, songId, requestedSlotDateId, requestedPlayDate, requestedSlotId, allowOverbook = false) {
  const [songs] = await connection.execute(
    'SELECT id, status, slot_id, slot_date_id FROM song_requests WHERE id = ? AND deleted_at IS NULL FOR UPDATE',
    [songId]
  );
  if (songs.length === 0) throw songReviewValidationError('点歌记录不存在或已在回收站');
  if (songs[0].status !== 'approved') throw songReviewValidationError('只有已通过、尚未播放的点歌可以调整播放时间');
  let slotDate;
  if (requestedPlayDate) {
    slotDate = await createCustomSlotDate(connection, requestedSlotId || songs[0].slot_id, requestedPlayDate);
  }
  if (!requestedSlotDateId && !slotDate) throw songReviewValidationError('请选择有效的播放时段');

  if (!slotDate) {
    const today = getChinaDate();
    const [slotDates] = await connection.execute(
    'SELECT sd.id, sd.slot_id, sd.play_date, sd.max_songs, sd.manual_override, ts.name AS slot_name, ts.start_time, ts.end_time, ts.weekdays ' +
    'FROM slot_dates sd JOIN time_slots ts ON ts.id = sd.slot_id ' +
    'WHERE sd.id = ? AND sd.is_active = 1 AND ts.is_active = 1 ' +
    'AND (ts.effective_start_date IS NULL OR sd.play_date >= ts.effective_start_date) ' +
    'AND sd.play_date >= ? FOR UPDATE',
      [requestedSlotDateId, today]
    );
    if (slotDates.length === 0) throw songReviewValidationError('所选播放时段不可用、已关闭或已过期，请重新选择');
    slotDate = slotDates[0];
  }
  if (!requestedPlayDate && !isSlotDateAllowedByCurrentSchedule(slotDate)) {
    throw songReviewValidationError('所选日期不在当前开放周期内，请重新选择');
  }

  const [countRows] = await connection.execute(
    'SELECT COUNT(*) AS cnt FROM song_requests WHERE slot_date_id = ? AND id <> ? ' +
    'AND deleted_at IS NULL AND status IN ("pending", "approved")',
    [slotDate.id, songId]
  );
  if (!allowOverbook && Number(countRows[0].cnt) >= Number(slotDate.max_songs)) {
    throw songReviewValidationError('所选播放时段已满，请选择其他时段');
  }

  const [result] = await connection.execute(
    'UPDATE song_requests SET slot_id = ?, slot_date_id = ? WHERE id = ? AND status = "approved" AND deleted_at IS NULL',
    [slotDate.slot_id, slotDate.id, songId]
  );
  if (result.affectedRows === 0) throw songReviewValidationError('点歌状态已变化，请刷新后重试');
  return slotDate;
}

// 所有管理路由都需要登录 + 是管理后台用户
router.use(auth, isStaff);

// 点歌审核员在“点歌管理”内维护打回理由，不必也不应获得系统设置权限。
router.get('/song-reject-reasons', requirePermission('songs:review'), async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT config_value FROM settings WHERE config_key = ?', ['song_reject_reasons']);
    res.json({
      code: 200,
      data: { song_reject_reasons: normalizeSongRejectReasons(rows[0] && rows[0].config_value) }
    });
  } catch (err) {
    console.error('[Songs] 获取拒绝理由预设失败:', getErrorDetail(err));
    res.json({ code: 500, message: '获取拒绝理由预设失败' });
  }
});

router.put('/song-reject-reasons', requirePermission('songs:review'), async (req, res) => {
  try {
    const reasons = normalizeSongRejectReasons(req.body && req.body.reasons);
    await pool.execute(
      'INSERT INTO settings (config_key, config_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE config_value = ?',
      ['song_reject_reasons', JSON.stringify(reasons), JSON.stringify(reasons)]
    );
    res.json({ code: 200, message: '打回理由预设已保存', data: { song_reject_reasons: reasons } });
  } catch (err) {
    console.error('[Songs] 保存拒绝理由预设失败:', getErrorDetail(err));
    res.json({ code: 500, message: '保存拒绝理由预设失败' });
  }
});

// ===== 获取当前用户权限信息 =====
router.get('/my-permissions', (req, res) => {
  res.json({
    code: 200,
    data: {
      role: req.user.role,
      roleName: req.user.roleName,
      permissions: req.user.permissions
    }
  });
});

// 管理后台查看线上版本与最近部署结果；不向普通用户公开运维信息。
router.get('/deployment-status', requirePermission('settings:view'), (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const raw = JSON.parse(fs.readFileSync(DEPLOY_STATUS_FILE, 'utf8'));
    const status = {
      state: ['starting', 'running', 'success', 'failed', 'unknown'].includes(raw.state) ? raw.state : 'unknown',
      revision: typeof raw.revision === 'string' && /^[a-f0-9]{7,40}$/i.test(raw.revision) ? raw.revision : '',
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
      exitCode: Number.isInteger(raw.exitCode) ? raw.exitCode : null,
      appVersion: APP_VERSION
    };
    res.json({ code: 200, data: status });
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return res.json({ code: 200, data: { state: 'unknown', revision: '', updatedAt: '', exitCode: null, appVersion: APP_VERSION } });
    }
    console.error('[admin] deployment status read failed:', getErrorDetail(err));
    res.status(500).json({ code: 500, message: '部署状态读取失败' });
  }
});

// 发布记录仅在后台展示；由维护 Agent 随发布更新，不提供页面编辑接口。
router.get('/release-notes', requirePermission('settings:view'), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    res.json({ code: 200, data: { notes: await getReleaseNotes() } });
  } catch (err) {
    console.error('[admin] release notes read failed:', getErrorDetail(err));
    res.status(500).json({ code: 500, message: '更新记录读取失败' });
  }
});

// ===== 获取编辑团队（admin/super_admin 列表）=====
router.get('/editors', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT id, username, nickname, role FROM users WHERE role IN ('admin', 'super_admin') ORDER BY role DESC, id ASC`
    );
    res.json({ code: 200, data: rows || [] });
  } catch (err) {
    console.error('获取编辑列表失败:', getErrorDetail(err));
    res.json({ code: 500, message: '获取失败，请稍后重试' });
  }
});

// ===== 统计数据（需要 stats:view 权限）=====
router.get('/stats', requirePermission('stats:view'), async (req, res) => {
  try {
    // 统计卡片互不依赖，并行查询；日期条件使用范围比较，避免对索引列套 DATE()。
    const [users, regularUsers, posts, pendingPosts, songs, pendingSongs, todayPosts, todaySongs, todayPostViews] = await Promise.all([
      pool.execute('SELECT COUNT(*) as total FROM users'),
      pool.execute('SELECT COUNT(*) as total FROM users WHERE role = "user"'),
      pool.execute('SELECT COUNT(*) as total FROM posts'),
      pool.execute('SELECT COUNT(*) as total FROM posts WHERE status = "pending" AND is_deleted = 0'),
      pool.execute('SELECT COUNT(*) as total FROM song_requests WHERE deleted_at IS NULL'),
      pool.execute('SELECT COUNT(*) as total FROM song_requests WHERE status = "pending" AND deleted_at IS NULL'),
      pool.execute('SELECT COUNT(*) as total FROM posts WHERE created_at >= CURDATE() AND created_at < DATE_ADD(CURDATE(), INTERVAL 1 DAY)'),
      pool.execute('SELECT COUNT(*) as total FROM song_requests WHERE created_at >= CURDATE() AND created_at < DATE_ADD(CURDATE(), INTERVAL 1 DAY) AND deleted_at IS NULL'),
      pool.execute('SELECT COUNT(*) as total FROM post_views WHERE viewed_at >= CURDATE() AND viewed_at < DATE_ADD(CURDATE(), INTERVAL 1 DAY)')
    ]);
    // feedbacks 表可能不存在，查失败就当0处理
    let pendingFeedbacks = [{ total: 0 }];
    try {
      pendingFeedbacks = (await pool.execute('SELECT COUNT(*) as total FROM feedbacks WHERE status = "pending"'))[0];
    } catch (e) {}

    res.json({
      code: 200,
      data: {
        totalUsers: users[0][0].total,
        regularUsers: regularUsers[0][0].total,
        totalPosts: posts[0][0].total,
        pendingPosts: pendingPosts[0][0].total,
        totalSongs: songs[0][0].total,
        pendingSongs: pendingSongs[0][0].total,
        todayPosts: todayPosts[0][0].total,
        todaySongs: todaySongs[0][0].total,
        todayPostViews: todayPostViews[0][0].total,
        pendingFeedbacks: pendingFeedbacks[0].total
      }
    });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ===== 帖子管理（需要 posts:review 权限）=====

// 获取帖子列表
router.get('/posts', requirePermission('posts:review'), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query, { defaultLimit: 20, maxLimit: 100 });
    const { status } = req.query;

    // 已移入回收站的帖子不再出现在正常管理列表，避免软删除后仍可重复操作。
    let whereClause = 'p.is_deleted = 0';
    const params = [];
    if (status) {
      whereClause += ' AND p.status = ?';
      params.push(status);
    }

    const [posts] = await pool.execute(`
      SELECT p.*, u.username, u.nickname
      FROM posts p
      LEFT JOIN users u ON p.user_id = u.id
      WHERE ${whereClause}
      ORDER BY p.created_at DESC
      LIMIT ? OFFSET ?
    `, [...params, parseInt(limit), parseInt(offset)]);

    const [countResult] = await pool.execute(`SELECT COUNT(*) as total FROM posts p WHERE ${whereClause}`, params);

    res.json({
      code: 200,
      data: {
        posts: posts.map(p => ({ ...p, images: p.images ? JSON.parse(p.images) : [] })),
        total: countResult[0].total,
        totalPages: Math.ceil(countResult[0].total / limit)
      }
    });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 审核帖子
router.put('/posts/:id/status', requirePermission('posts:review'), async (req, res) => {
  try {
    const { status } = req.body;
    if (!['approved', 'rejected'].includes(status)) {
      return res.json({ code: 400, message: '无效状态' });
    }
    const [updated] = await pool.execute(
      'UPDATE posts SET status = ? WHERE id = ? AND is_deleted = 0',
      [status, req.params.id]
    );
    if (!updated.affectedRows) {
      return res.json({ code: 404, message: '帖子不存在或已在回收站' });
    }

    // 异步发送邮件通知帖子作者
    setImmediate(async () => {
      try {
        const [posts] = await pool.execute('SELECT p.user_id, p.title, u.email, u.nickname, u.username FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.id = ? AND p.is_deleted = 0', [req.params.id]);
        if (posts.length > 0 && posts[0].email) {
          const user = posts[0];
          if (status === 'approved') {
            await notifyPostApproved(user.email, user.nickname || user.username || '用户', user.title || '无标题', user.user_id);
          } else {
            await notifyPostRejected(user.email, user.nickname || user.username || '用户', user.title || '无标题', '', user.user_id);
          }
        }
      } catch (err) {
        console.error('[Email] 发送帖子审核通知失败:', getErrorDetail(err));
      }
    });

    // 通过时推送给百度收录
    if (status === 'approved') setImmediate(function() { pushPost(req.params.id); });

    res.json({ code: 200, message: '操作成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 批量审核帖子
router.put('/posts/batch-status', requirePermission('posts:review'), async (req, res) => {
  try {
    const { ids, status } = req.body;
    if (!Array.isArray(ids) || ids.length === 0 || !['approved', 'rejected'].includes(status)) {
      return res.json({ code: 400, message: '无效参数' });
    }
    const placeholders = ids.map(() => '?').join(',');
    await pool.execute(`UPDATE posts SET status = ? WHERE id IN (${placeholders}) AND is_deleted = 0`, [status, ...ids]);
    // 批量通过时推送给百度收录
    if (status === 'approved') setImmediate(function() {
      ids.forEach(id => pushPost(id));
    });
    res.json({ code: 200, message: `已批量${status === 'approved' ? '通过' : '拒绝'} ${ids.length} 条` });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取帖子详情
router.get('/posts/:id', requirePermission('posts:review'), async (req, res) => {
  try {
    const [posts] = await pool.execute(`
      SELECT p.*, u.username, u.nickname
      FROM posts p
      LEFT JOIN users u ON p.user_id = u.id
      WHERE p.id = ? AND p.is_deleted = 0
    `, [req.params.id]);

    if (posts.length === 0) {
      return res.json({ code: 404, message: '帖子不存在' });
    }

    const post = posts[0];
    post.images = post.images ? JSON.parse(post.images) : [];

    res.json({ code: 200, data: post });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 初始化回收站字段（运行一次）
router.post('/init-trash-column', requirePermission('admin:manage'), async (req, res) => {
  try {
    const [columns] = await pool.query('SHOW COLUMNS FROM posts WHERE Field IN (?, ?)', ['is_deleted', 'deleted_at']);
    const names = columns.map(column => column.Field);
    res.json({
      code: names.includes('is_deleted') && names.includes('deleted_at') ? 200 : 503,
      message: names.includes('is_deleted') && names.includes('deleted_at')
        ? '回收站字段已就绪'
        : '回收站字段尚未完成初始化，请重启服务执行数据库迁移'
    });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取回收站帖子列表
router.get('/trash/posts', requirePermission('posts:delete'), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query, { defaultLimit: 20, maxLimit: 100 });

    const [posts] = await pool.execute(`
      SELECT p.*, u.username, u.nickname
      FROM posts p
      LEFT JOIN users u ON p.user_id = u.id
      WHERE p.is_deleted = 1
      ORDER BY p.deleted_at DESC
      LIMIT ? OFFSET ?
    `, [parseInt(limit), offset]);

    const [countResult] = await pool.execute('SELECT COUNT(*) as total FROM posts WHERE is_deleted = 1');

    res.json({
      code: 200,
      data: {
        posts: posts.map(p => ({ ...p, images: p.images ? JSON.parse(p.images) : [] })),
        total: countResult[0].total,
        totalPages: Math.ceil(countResult[0].total / limit)
      }
    });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取回收站帖子详情
router.get('/trash/posts/:id', requirePermission('posts:delete'), async (req, res) => {
  try {
    const [posts] = await pool.execute(`
      SELECT p.*, u.username, u.nickname
      FROM posts p
      LEFT JOIN users u ON p.user_id = u.id
      WHERE p.id = ? AND p.is_deleted = 1
    `, [req.params.id]);

    if (posts.length === 0) {
      return res.json({ code: 404, message: '帖子不存在或已彻底删除' });
    }

    res.json({ code: 200, data: { ...posts[0], images: posts[0].images ? JSON.parse(posts[0].images) : [] } });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 恢复帖子
router.put('/trash/posts/:id/restore', requirePermission('posts:delete'), async (req, res) => {
  try {
    const [result] = await pool.execute('UPDATE posts SET is_deleted = 0, deleted_at = NULL WHERE id = ? AND is_deleted = 1', [req.params.id]);
    res.json({
      code: result.affectedRows > 0 ? 200 : 404,
      message: result.affectedRows > 0 ? '恢复成功' : '帖子不在回收站或已被删除'
    });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 彻底删除帖子
router.delete('/trash/posts/:id', requirePermission('posts:delete'), async (req, res) => {
  try {
    const [result] = await pool.execute('DELETE FROM posts WHERE id = ? AND is_deleted = 1', [req.params.id]);
    res.json({
      code: result.affectedRows > 0 ? 200 : 404,
      message: result.affectedRows > 0 ? '彻底删除成功' : '帖子不在回收站或已被删除'
    });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 清空回收站
router.delete('/trash/posts', requirePermission('admin:manage'), async (req, res) => {
  try {
    await pool.execute('DELETE FROM posts WHERE is_deleted = 1');
    res.json({ code: 200, message: '清空成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 软删除帖子（移入回收站）
router.delete('/posts/:id', requirePermission('posts:delete'), async (req, res) => {
  try {
    const postId = parseInt(req.params.id);
    if (isNaN(postId)) {
      return res.json({ code: 400, message: '无效的帖子ID' });
    }
    
    // 先检查帖子是否存在
    const [posts] = await pool.execute('SELECT id, is_deleted FROM posts WHERE id = ?', [postId]);
    if (posts.length === 0) {
      return res.json({ code: 404, message: '帖子不存在' });
    }
    if (posts[0].is_deleted) {
      return res.json({ code: 404, message: '帖子已在回收站，请从回收站处理' });
    }
    
    // 尝试软删除（如果字段存在）
    try {
      const [result] = await pool.execute('UPDATE posts SET is_deleted = 1, deleted_at = NOW() WHERE id = ? AND is_deleted = 0', [postId]);
      if (!result.affectedRows) {
        return res.json({ code: 404, message: '帖子已被其他操作移入回收站' });
      }
    } catch (err) {
      // 如果字段不存在，直接硬删除
      if (err.code === 'ER_BAD_FIELD_ERROR') {
        await pool.execute('DELETE FROM posts WHERE id = ?', [postId]);
      } else {
        throw err;
      }
    }
    
    res.json({ code: 200, message: '已移入回收站' });
  } catch (err) {
    console.error('删除帖子错误:', getErrorDetail(err));
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 置顶/取消置顶帖子
router.put('/posts/:id/pin', requirePermission('posts:review'), async (req, res) => {
  try {
    const [post] = await pool.execute('SELECT id, is_pinned FROM posts WHERE id = ? AND is_deleted = 0', [req.params.id]);
    if (post.length === 0) return res.json({ code: 404, message: '帖子不存在' });
    const newPinned = post[0].is_pinned ? 0 : 1;
    await pool.execute('UPDATE posts SET is_pinned = ? WHERE id = ? AND is_deleted = 0', [newPinned, req.params.id]);
    res.json({ code: 200, message: newPinned ? '已置顶' : '已取消置顶', data: { is_pinned: newPinned } });
  } catch (err) {
    console.error('置顶操作错误:', getErrorDetail(err));
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ===== 用户管理（需要 users:view 权限）=====

// 获取用户列表
router.get('/users', requirePermission('users:view'), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query, { defaultLimit: 50, maxLimit: 100 });
    const { search = '', keyword = '', role = '' } = req.query;
    const query = String(search || keyword || '').trim();
    const roleFilter = String(role || '').trim();
    const validRoles = ['user', 'reviewer', 'radio_admin', 'admin', 'super_admin'];
    if (roleFilter && roleFilter !== 'all' && !validRoles.includes(roleFilter)) {
      return res.json({ code: 400, message: '无效角色筛选条件' });
    }

    const conditions = ['1=1'];
    const params = [];
    if (query) {
      conditions.push('(username LIKE ? OR nickname LIKE ? OR email LIKE ?)');
      const wildcardQuery = `%${query}%`;
      params.push(wildcardQuery, wildcardQuery, wildcardQuery);
    }
    if (roleFilter && roleFilter !== 'all') {
      conditions.push('role = ?');
      params.push(roleFilter);
    }
    const whereClause = conditions.join(' AND ');

    const [users] = await pool.execute(`
      SELECT id, username, nickname, avatar, email, role, status, points, created_at,
             last_login_at, last_login_ip, last_login_region,
             ban_reason, ban_attempt_ip, ban_attempt_count FROM users
      WHERE ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `, [...params, parseInt(limit), parseInt(offset)]);

    const [countResult] = await pool.execute(`SELECT COUNT(*) as total FROM users WHERE ${whereClause}`, params);

    res.json({
      code: 200,
      data: {
        users,
        total: countResult[0].total,
        totalPages: Math.ceil(countResult[0].total / limit)
      }
    });
  } catch (err) {
    console.error('获取用户列表错误:', err.message);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 修改用户状态（启用/禁用/封禁）
router.put('/users/:id/status', requirePermission('users:status'), async (req, res) => {
  try {
    const { status, ban_reason } = req.body;
    const targetId = parseInt(req.params.id);

    // 不能禁用自己
    if (targetId === req.user.id) {
      return res.json({ code: 400, message: '不能禁用自己的账号' });
    }

    // 不能禁用超级管理员
    const [target] = await pool.execute('SELECT role FROM users WHERE id = ?', [targetId]);
    if (target.length > 0 && target[0].role === 'super_admin') {
      return res.json({ code: 403, message: '不能禁用超级管理员' });
    }

    if (status === 0) {
      await pool.execute('UPDATE users SET status = 0, ban_reason = ? WHERE id = ?', [ban_reason || null, targetId]);
    } else {
      await pool.execute('UPDATE users SET status = 1, ban_reason = NULL WHERE id = ?', [targetId]);
    }
    res.json({ code: 200, message: status === 0 ? '已封禁' : '已解封' });
  } catch (err) {
    console.error('修改用户状态错误:', err.message);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ===== 修改用户角色（仅超级管理员）=====
router.put('/users/:id/role', superAdminOnly, async (req, res) => {
  try {
    const { role } = req.body;
    const targetId = parseInt(req.params.id);

    const validRoles = ['user', 'reviewer', 'radio_admin', 'admin', 'super_admin'];
    if (!validRoles.includes(role)) {
      return res.json({ code: 400, message: '无效角色' });
    }

    // 不能修改自己的角色
    if (targetId === req.user.id) {
      return res.json({ code: 400, message: '不能修改自己的角色' });
    }

    // 检查目标用户
    const [target] = await pool.execute('SELECT role FROM users WHERE id = ?', [targetId]);
    if (target.length === 0) {
      return res.json({ code: 404, message: '用户不存在' });
    }

    // 不能修改其他超级管理员的角色
    if (target[0].role === 'super_admin') {
      return res.json({ code: 403, message: '不能修改超级管理员的角色' });
    }

    await pool.execute('UPDATE users SET role = ? WHERE id = ?', [role, targetId]);
    res.json({ code: 200, message: '角色修改成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ===== 删除用户（仅超级管理员）=====
router.delete('/users/:id', superAdminOnly, async (req, res) => {
  try {
    const targetId = parseInt(req.params.id);

    // 不能删除自己
    if (targetId === req.user.id) {
      return res.json({ code: 400, message: '不能删除自己' });
    }

    // 检查目标用户
    const [target] = await pool.execute('SELECT role FROM users WHERE id = ?', [targetId]);
    if (target.length === 0) {
      return res.json({ code: 404, message: '用户不存在' });
    }

    // 不能删除其他超级管理员
    if (target[0].role === 'super_admin') {
      return res.json({ code: 403, message: '不能删除超级管理员' });
    }

    // 删除用户相关数据
    await pool.execute('DELETE FROM song_requests WHERE user_id = ?', [targetId]);
    await pool.execute('DELETE FROM posts WHERE user_id = ?', [targetId]);
    await pool.execute('DELETE FROM users WHERE id = ?', [targetId]);
    res.json({ code: 200, message: '用户已删除' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ===== 重置用户密码（仅超级管理员）=====
router.put('/users/:id/password', superAdminOnly, async (req, res) => {
  try {
    const targetId = parseInt(req.params.id);
    const { new_password } = req.body;

    if (!new_password || new_password.length < 6) {
      return res.json({ code: 400, message: '密码至少6位' });
    }

    // 不能重置自己的密码（请用修改密码功能）
    if (targetId === req.user.id) {
      return res.json({ code: 400, message: '请使用个人设置修改自己的密码' });
    }

    const [target] = await pool.execute('SELECT id FROM users WHERE id = ?', [targetId]);
    if (target.length === 0) {
      return res.json({ code: 404, message: '用户不存在' });
    }

    const bcrypt = require('bcryptjs');
    const hashedPassword = await bcrypt.hash(new_password, 10);
    await pool.execute('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, targetId]);
    res.json({ code: 200, message: '密码已重置' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ===== 点歌管理（需要 songs:review 权限）=====

// 获取点歌列表
router.get('/songs', requirePermission('songs:review'), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query, { defaultLimit: 20, maxLimit: 100 });
    const { status, slot_id, keyword } = req.query;

    let whereClause = 'sr.deleted_at IS NULL';
    const params = [];
    if (status) {
      whereClause += ' AND sr.status = ?';
      params.push(status);
    }
    if (slot_id) {
      whereClause += ' AND sr.slot_id = ?';
      params.push(slot_id);
    }
    if (keyword) {
      whereClause += ' AND (sr.song_name LIKE ? OR sr.artist LIKE ? OR u.nickname LIKE ? OR u.username LIKE ?)';
      const kw = '%' + keyword + '%';
      params.push(kw, kw, kw, kw);
    }

    const [songs] = await pool.execute(`
      SELECT sr.*, ts.name as slot_name, ts.start_time, ts.end_time, u.username, u.nickname,
             DATE_FORMAT(sd.play_date, '%Y-%m-%d') as play_date
      FROM song_requests sr
      JOIN time_slots ts ON sr.slot_id = ts.id
      LEFT JOIN slot_dates sd ON sr.slot_date_id = sd.id
      LEFT JOIN users u ON sr.user_id = u.id
      WHERE ${whereClause}
      ORDER BY sr.hot_score DESC, sr.created_at DESC
      LIMIT ? OFFSET ?
    `, [...params, parseInt(limit), parseInt(offset)]);

    // 关键词过滤会引用用户表，统计查询也必须带同一张表，否则搜索时会出现 Unknown column u.nickname。
    const [countResult] = await pool.execute(`
      SELECT COUNT(*) as total
      FROM song_requests sr
      LEFT JOIN users u ON sr.user_id = u.id
      WHERE ${whereClause}
    `, params);

    res.json({
      code: 200,
      data: {
        songs,
        total: countResult[0].total,
        totalPages: Math.ceil(countResult[0].total / limit)
      }
    });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取单条点歌详情
// 点歌详情属于审核工作流；广播管理员拥有 songs:review 即可查看预约时间并处理审核。
router.get('/songs/:id', requirePermission('songs:review'), async (req, res) => {
  try {
    const [songs] = await pool.execute(`
      SELECT sr.*, ts.name as slot_name, ts.start_time, ts.end_time, u.username, u.nickname,
             DATE_FORMAT(sd.play_date, '%Y-%m-%d') as play_date
      FROM song_requests sr
      JOIN time_slots ts ON sr.slot_id = ts.id
      LEFT JOIN slot_dates sd ON sr.slot_date_id = sd.id
      LEFT JOIN users u ON sr.user_id = u.id
      WHERE sr.id = ? AND sr.deleted_at IS NULL
    `, [req.params.id]);

    if (songs.length === 0) {
      return res.json({ code: 404, message: '点歌记录不存在' });
    }

    res.json({ code: 200, data: songs[0] });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 审核通过/已通过改期前读取可用的实际播放日期。此接口展示所有尚未过期、仍开放且尚有名额的日期；
// 当前点歌在原日期的占用不计入容量，避免管理员不改期时被错误提示“已满”。
router.get('/songs/:id/reschedule-options', requirePermission('songs:review'), async (req, res) => {
  try {
    const songId = parseSongSlotDateId(req.params.id);
    if (!songId) return res.json({ code: 400, message: '点歌编号不正确' });

    const [songs] = await pool.execute(
      'SELECT sr.id, sr.status, sr.slot_id, sr.slot_date_id, ts.name AS slot_name, ts.start_time, ts.end_time, ' +
      "DATE_FORMAT(sd.play_date, '%Y-%m-%d') AS play_date " +
      'FROM song_requests sr LEFT JOIN slot_dates sd ON sd.id = sr.slot_date_id ' +
      'LEFT JOIN time_slots ts ON ts.id = sr.slot_id WHERE sr.id = ? AND sr.deleted_at IS NULL',
      [songId]
    );
    if (songs.length === 0) return res.json({ code: 404, message: '点歌记录不存在或已在回收站' });
    if (!['pending', 'approved'].includes(songs[0].status)) {
      return res.json({ code: 409, message: '只有待审核或已通过的点歌可以选择播放时段' });
    }

    const today = getChinaDate();
    const [rows] = await pool.execute(
      'SELECT sd.id, sd.slot_id, sd.play_date, sd.max_songs, sd.manual_override, ts.name AS slot_name, ts.start_time, ts.end_time, ts.weekdays, ' +
      'COUNT(sr.id) AS occupied_count FROM slot_dates sd JOIN time_slots ts ON ts.id = sd.slot_id ' +
      'LEFT JOIN song_requests sr ON sr.slot_date_id = sd.id AND sr.id <> ? AND sr.deleted_at IS NULL ' +
      'AND sr.status IN ("pending", "approved") ' +
      'WHERE sd.is_active = 1 AND ts.is_active = 1 ' +
      'AND (ts.effective_start_date IS NULL OR sd.play_date >= ts.effective_start_date) ' +
      'AND sd.play_date >= ? ' +
      'GROUP BY sd.id, sd.slot_id, sd.play_date, sd.max_songs, sd.manual_override, ts.name, ts.start_time, ts.end_time, ts.weekdays ' +
      'ORDER BY sd.play_date, ts.start_time, sd.id',
      [songId, today]
    );
    const options = rows
      .filter(isSlotDateAllowedByCurrentSchedule)
      .map(row => ({
        id: row.id,
        slot_id: row.slot_id,
        play_date: slotDateValue(row.play_date),
        slot_name: row.slot_name,
        start_time: row.start_time,
        end_time: row.end_time,
        remaining: Math.max(0, Number(row.max_songs) - Number(row.occupied_count)),
        max_songs: Number(row.max_songs),
        is_full: Number(row.occupied_count) >= Number(row.max_songs)
      }));
    let slotChoices = [];
    try {
      const [rows] = await pool.execute(
        'SELECT id, name AS slot_name, start_time, end_time FROM time_slots WHERE is_active = 1 ORDER BY start_time, id'
      );
      slotChoices = rows;
    } catch (slotChoiceError) {
      console.warn('[Songs] 获取自定义时段列表失败，保留已有日期选项:', getErrorDetail(slotChoiceError));
    }
    res.json({ code: 200, data: { song: songs[0], options, slot_choices: slotChoices, can_custom_date: true } });
  } catch (err) {
    console.error('[Songs] 获取审核改期选项失败:', getErrorDetail(err));
    res.json({ code: 500, message: '获取可用播放时段失败，请稍后重试' });
  }
});

// 已通过点歌调整播放时间：独立权限入口，后端事务会锁定记录和目标日期，
// 原子校验容量、当前周期、日期/时段启用状态后才更新，并发送新的播放安排通知。
router.put('/songs/:id/reschedule', requirePermission('songs:review'), async (req, res) => {
  const requestedSlotDateId = parseSongSlotDateId(req.body && req.body.slot_date_id);
  const requestedPlayDate = req.body && req.body.play_date !== undefined
    ? normalizeDateOnly(req.body.play_date)
    : null;
  const requestedSlotId = parseSongSlotDateId(req.body && req.body.slot_id);
  const allowOverbook = req.body && (req.body.allow_overbook === true || req.body.allow_overbook === 1 || req.body.allow_overbook === '1' || req.body.allow_overbook === 'true');
  if (!requestedSlotDateId && !requestedPlayDate) return res.json({ code: 400, message: '请选择有效的播放日期与时段' });
  if (req.body && req.body.play_date !== undefined && !requestedPlayDate) {
    return res.json({ code: 400, message: '播放日期格式不正确，请选择日期' });
  }
  if (requestedPlayDate && requestedSlotDateId) return res.json({ code: 400, message: '播放日期请使用自定义日期或已有日期之一' });

  try {
    const connection = await pool.getConnection();
    let slotDate;
    try {
      await connection.beginTransaction();
      slotDate = await rescheduleApprovedSong(connection, req.params.id, requestedSlotDateId, requestedPlayDate, requestedSlotId, allowOverbook);
      await connection.commit();
    } catch (err) {
      try { await connection.rollback(); } catch (_) {}
      if (err && err.isSongReviewValidationError) return res.json({ code: 400, message: err.message });
      throw err;
    } finally {
      connection.release();
    }

    // 复用现有“通过”邮件模板，但携带更新后的完整播放日期和时段。
    setImmediate(async () => {
      try {
        const [songs] = await pool.execute(`
          SELECT sr.song_name, sr.artist, sr.user_id, ts.name AS slot_name, ts.start_time, ts.end_time,
                 DATE_FORMAT(sd.play_date, '%Y-%m-%d') AS play_date, u.email, u.nickname, u.username
          FROM song_requests sr
          LEFT JOIN time_slots ts ON sr.slot_id = ts.id
          LEFT JOIN slot_dates sd ON sr.slot_date_id = sd.id
          LEFT JOIN users u ON sr.user_id = u.id
          WHERE sr.id = ? AND sr.deleted_at IS NULL
        `, [req.params.id]);
        if (songs.length > 0 && songs[0].email) {
          const song = songs[0];
          await notifySongApproved(
            song.email,
            song.nickname || song.username || '用户',
            song.song_name || '未知',
            song.artist || '未知',
            song.slot_name || '未知时段',
            song.user_id,
            { playDate: song.play_date, slotName: song.slot_name, startTime: song.start_time, endTime: song.end_time }
          );
        }
      } catch (err) {
        console.error('[Email] 发送点歌改期通知失败:', getErrorDetail(err));
      }
    });

    res.json({
      code: 200,
      message: '播放时间已调整，并已通知点歌用户',
      data: {
        slot_date_id: slotDate.id,
        slot_id: slotDate.slot_id,
        play_date: slotDateValue(slotDate.play_date),
        slot_name: slotDate.slot_name,
        start_time: slotDate.start_time,
        end_time: slotDate.end_time
      }
    });
  } catch (err) {
    console.error('[Songs] 调整已通过点歌播放时间失败:', getErrorDetail(err));
    res.json({ code: 500, message: '调整播放时间失败，请稍后重试' });
  }
});

// 审核点歌
router.put('/songs/:id/status', requirePermission('songs:review'), async (req, res) => {
  try {
    const { status, play_order } = req.body || {};
    const rejectReason = status === 'rejected' ? String((req.body && req.body.reason) || '').trim().slice(0, 500) : null;
    if (!['approved', 'rejected', 'played', 'pending'].includes(status)) {
      return res.json({ code: 400, message: '无效状态' });
    }
    if (status === 'rejected' && !rejectReason) {
      return res.json({ code: 400, message: '请填写拒绝理由' });
    }
    let statusResult;
    if (status === 'approved') {
      const requestedSlotDateId = req.body && req.body.slot_date_id !== undefined
        ? parseSongSlotDateId(req.body.slot_date_id)
        : null;
      const requestedPlayDate = req.body && req.body.play_date !== undefined
        ? normalizeDateOnly(req.body.play_date)
        : null;
      const requestedSlotId = req.body && req.body.slot_id !== undefined
        ? parseSongSlotDateId(req.body.slot_id)
        : null;
      const allowOverbook = req.body && (req.body.allow_overbook === true || req.body.allow_overbook === 1 || req.body.allow_overbook === '1' || req.body.allow_overbook === 'true');
      if (req.body && req.body.slot_date_id !== undefined && !requestedSlotDateId) {
        return res.json({ code: 400, message: '请选择有效的播放时段' });
      }
      if (req.body && req.body.play_date !== undefined && !requestedPlayDate) {
        return res.json({ code: 400, message: '播放日期格式不正确，请选择日期' });
      }
      if (requestedPlayDate && requestedSlotDateId) {
        return res.json({ code: 400, message: '播放日期请使用自定义日期或已有日期之一' });
      }

      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        await approveSongWithSchedule(connection, req.params.id, requestedSlotDateId, play_order, requestedPlayDate, requestedSlotId, allowOverbook);
        await connection.commit();
        statusResult = { affectedRows: 1 };
      } catch (err) {
        try { await connection.rollback(); } catch (_) {}
        if (err && err.isSongReviewValidationError) {
          return res.json({ code: 400, message: err.message });
        }
        throw err;
      } finally {
        connection.release();
      }
    } else {
      [statusResult] = await pool.execute(
        'UPDATE song_requests SET status = ?, reject_reason = ? WHERE id = ? AND deleted_at IS NULL',
      [status, rejectReason, req.params.id]
      );
      if (play_order !== undefined) {
        await pool.execute('UPDATE song_requests SET play_order = ? WHERE id = ? AND deleted_at IS NULL', [play_order, req.params.id]);
      }
    }
    if (!statusResult || statusResult.affectedRows === 0) return res.json({ code: 404, message: '点歌记录不存在或已在回收站' });

    // 异步发送邮件通知点歌用户
    setImmediate(async () => {
      try {
        const [songs] = await pool.execute(`
          SELECT sr.song_name, sr.artist, sr.user_id, ts.name as slot_name, ts.start_time, ts.end_time,
                 DATE_FORMAT(sd.play_date, '%Y-%m-%d') AS play_date, u.email, u.nickname, u.username
          FROM song_requests sr 
          LEFT JOIN time_slots ts ON sr.slot_id = ts.id 
          LEFT JOIN slot_dates sd ON sr.slot_date_id = sd.id
          LEFT JOIN users u ON sr.user_id = u.id 
           WHERE sr.id = ? AND sr.deleted_at IS NULL
        `, [req.params.id]);
        
        if (songs.length > 0 && songs[0].email) {
          const song = songs[0];
          const userNickname = song.nickname || song.username || '用户';
          
          if (status === 'approved') {
            await notifySongApproved(song.email, userNickname, song.song_name || '未知', song.artist || '未知', song.slot_name || '未知时段', song.user_id, {
              playDate: song.play_date,
              slotName: song.slot_name,
              startTime: song.start_time,
              endTime: song.end_time
            });
          } else if (status === 'rejected') {
            await notifySongRejected(song.email, userNickname, song.song_name || '未知', song.artist || '未知', rejectReason, song.user_id, {
              playDate: song.play_date,
              slotName: song.slot_name,
              startTime: song.start_time,
              endTime: song.end_time
            });
          } else if (status === 'played') {
            await notifySongPlayed(song.email, userNickname, song.song_name || '未知', song.artist || '未知', song.user_id);
          }
        }
      } catch (err) {
        console.error('[Email] 发送点歌审核通知失败:', getErrorDetail(err));
      }
    });

    res.json({ code: 200, message: '操作成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 批量审核点歌
router.put('/songs/batch-status', requirePermission('songs:review'), async (req, res) => {
  try {
    const { ids, status } = req.body;
    const rejectReason = status === 'rejected' ? String(req.body.reason || '').trim().slice(0, 500) : null;
    if (!Array.isArray(ids) || ids.length === 0 || !['approved', 'rejected', 'pending'].includes(status)) {
      return res.json({ code: 400, message: '无效参数' });
    }
    if (status === 'rejected' && !rejectReason) {
      return res.json({ code: 400, message: '请填写拒绝理由' });
    }
    // 批量通过同样不能绕过单条审核的日期、容量和事务校验。批量操作不改期，
    // 因此每条都保留原预约；其中任何一条刚好满额时只跳过该条并返回具体数量。
    if (status === 'approved') {
      const reviewIds = Array.from(new Set(ids.map(parseSongSlotDateId).filter(Boolean)));
      const approvedIds = [];
      const failedMessages = [];
      for (const songId of reviewIds) {
        const connection = await pool.getConnection();
        try {
          await connection.beginTransaction();
          await approveSongWithSchedule(connection, songId, null);
          await connection.commit();
          approvedIds.push(songId);
        } catch (err) {
          try { await connection.rollback(); } catch (_) {}
          failedMessages.push(err && err.isSongReviewValidationError ? err.message : '服务器错误');
        } finally {
          connection.release();
        }
      }
      if (approvedIds.length === 0) {
        return res.json({ code: 400, message: failedMessages[0] || '没有可通过的点歌' });
      }

      const approvedPlaceholders = approvedIds.map(() => '?').join(',');
      const [approvedSongs] = await pool.execute(`
        SELECT sr.song_name, sr.artist, sr.user_id, u.email, u.nickname, u.username, ts.name AS slot_name,
               ts.start_time, ts.end_time, DATE_FORMAT(sd.play_date, '%Y-%m-%d') AS play_date
        FROM song_requests sr
        LEFT JOIN time_slots ts ON sr.slot_id = ts.id
        LEFT JOIN slot_dates sd ON sr.slot_date_id = sd.id
        LEFT JOIN users u ON sr.user_id = u.id
        WHERE sr.id IN (${approvedPlaceholders}) AND sr.deleted_at IS NULL
      `, approvedIds);
      setImmediate(async () => {
        for (const song of approvedSongs) {
          if (!song.email) continue;
          try {
            await notifySongApproved(song.email, song.nickname || song.username || '用户', song.song_name || '未知', song.artist || '未知', song.slot_name || '未知时段', song.user_id, {
              playDate: song.play_date,
              slotName: song.slot_name,
              startTime: song.start_time,
              endTime: song.end_time
            });
          } catch (err) {
            console.error('[Email] 批量发送点歌审核通知失败:', err.message);
          }
        }
      });
      const failedCount = reviewIds.length - approvedIds.length;
      return res.json({
        code: 200,
        message: failedCount > 0
          ? `已批量通过 ${approvedIds.length} 条，另有 ${failedCount} 条未通过容量/日期校验`
          : `已批量通过 ${approvedIds.length} 条`
      });
    }
    const placeholders = ids.map(() => '?').join(',');
    let songsToNotify = [];
    if (status === 'approved' || status === 'rejected') {
      const [rows] = await pool.execute(`
        SELECT sr.song_name, sr.artist, sr.user_id, u.email, u.nickname, u.username, ts.name AS slot_name,
               ts.start_time, ts.end_time, DATE_FORMAT(sd.play_date, '%Y-%m-%d') AS play_date
        FROM song_requests sr
        LEFT JOIN time_slots ts ON sr.slot_id = ts.id
        LEFT JOIN slot_dates sd ON sr.slot_date_id = sd.id
        LEFT JOIN users u ON sr.user_id = u.id
        WHERE sr.id IN (${placeholders}) AND sr.deleted_at IS NULL
      `, ids);
      songsToNotify = rows;
    }
    await pool.execute(`UPDATE song_requests SET status = ?, reject_reason = ? WHERE id IN (${placeholders}) AND deleted_at IS NULL`, [status, rejectReason, ...ids]);
    if (songsToNotify.length > 0) {
      setImmediate(async () => {
        for (const song of songsToNotify) {
          if (!song.email) continue;
          const userNickname = song.nickname || song.username || '用户';
          try {
            if (status === 'approved') {
              await notifySongApproved(song.email, userNickname, song.song_name || '未知', song.artist || '未知', song.slot_name || '未知时段', song.user_id, {
                playDate: song.play_date,
                slotName: song.slot_name,
                startTime: song.start_time,
                endTime: song.end_time
              });
            } else {
              await notifySongRejected(song.email, userNickname, song.song_name || '未知', song.artist || '未知', rejectReason, song.user_id, {
                playDate: song.play_date,
                slotName: song.slot_name,
                startTime: song.start_time,
                endTime: song.end_time
              });
            }
          } catch (err) {
            console.error('[Email] 批量发送点歌审核通知失败:', err.message);
          }
        }
      });
    }
    res.json({ code: 200, message: `已批量${status === 'approved' ? '通过' : status === 'rejected' ? '拒绝' : '设为待审核'} ${ids.length} 条` });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 删除点歌（软删除到回收站）
router.delete('/songs/:id', requirePermission('songs:delete'), async (req, res) => {
  try {
    const [result] = await pool.execute(
      'UPDATE song_requests SET deleted_at = NOW() WHERE id = ? AND deleted_at IS NULL',
      [req.params.id]
    );
    res.json({
      code: result.affectedRows > 0 ? 200 : 404,
      message: result.affectedRows > 0 ? '已移入回收站' : '歌曲不存在或已在回收站'
    });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取点歌回收站列表
router.get('/trash/songs', requirePermission('songs:delete'), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query, { defaultLimit: 20, maxLimit: 100 });
    const [songs] = await pool.execute(`
      SELECT sr.*, ts.name as slot_name, u.username, u.nickname
      FROM song_requests sr
      JOIN time_slots ts ON sr.slot_id = ts.id
      LEFT JOIN users u ON sr.user_id = u.id
      WHERE sr.deleted_at IS NOT NULL
      ORDER BY sr.deleted_at DESC
      LIMIT ? OFFSET ?
    `, [limit, offset]);
    const [countResult] = await pool.execute('SELECT COUNT(*) as total FROM song_requests WHERE deleted_at IS NOT NULL');
    res.json({
      code: 200,
      data: {
        songs,
        total: countResult[0].total,
        page,
        limit,
        totalPages: Math.ceil(countResult[0].total / limit)
      }
    });
  } catch (err) {
    console.error('获取点歌回收站失败:', err.message);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

// 永久删除点歌（回收站）
router.delete('/trash/songs/:id', requirePermission('songs:delete'), async (req, res) => {
  try {
    const [result] = await pool.execute('DELETE FROM song_requests WHERE id = ? AND deleted_at IS NOT NULL', [req.params.id]);
    res.json({
      code: result.affectedRows > 0 ? 200 : 404,
      message: result.affectedRows > 0 ? '已永久删除' : '歌曲不存在或不在回收站'
    });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 恢复点歌（从回收站恢复）
router.put('/trash/songs/:id/restore', requirePermission('songs:delete'), async (req, res) => {
  try {
    const [result] = await pool.execute('UPDATE song_requests SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL', [req.params.id]);
    res.json({
      code: result.affectedRows > 0 ? 200 : 404,
      message: result.affectedRows > 0 ? '已恢复' : '歌曲不存在或不在回收站'
    });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ===== 每日推歌管理 =====
router.get('/daily-songs', superAdminOnly, requirePermission('songs:review'), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query, { defaultLimit: 20, maxLimit: 100 });
    const { status, keyword } = req.query;
    const candidate = req.query.candidate === '1' || req.query.candidate === 'true';
    const candidateState = req.query.candidate_state === 'hidden' ? 'hidden' : 'active';

    var sql = 'SELECT * FROM daily_song_recs WHERE 1=1';
    var params = [];

    if (candidateState === 'hidden') {
      // “移出候选”只改变候选可见性，不能篡改已同步状态或发布时间。
      sql += ' AND candidate_hidden_at IS NOT NULL';
    } else if (candidate) {
      // 选稿器：未发布的歌始终可见；已同步的歌仅保留三天供调整后复用。
      // 兼容旧记录只写入 published 状态而缺少 published_at 的情况。
      sql += ' AND candidate_hidden_at IS NULL AND (status = "pending" OR (status = "published" AND COALESCE(published_at, created_at) >= DATE_SUB(NOW(), INTERVAL 3 DAY)))';
    }

    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }

    if (keyword) {
      sql += ' AND (song_name LIKE ? OR artist LIKE ? OR submitter LIKE ?)';
      params.push('%' + keyword + '%', '%' + keyword + '%', '%' + keyword + '%');
    }

    const [countResult] = await pool.execute(sql.replace('SELECT *', 'SELECT COUNT(*) as total'), params);
    const total = countResult[0]?.total || 0;

    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const [songs] = await pool.execute(sql, params);

    res.json({
      code: 200,
      data: {
        songs,
        page: parseInt(page),
        totalPages: Math.ceil(total / limit),
        total
      }
    });
  } catch (err) {
    res.json({ code: 500, message: '查询失败，请稍后重试' });
  }
});

// 手动添加推歌
router.post('/daily-songs', superAdminOnly, requirePermission('songs:review'), async (req, res) => {
  try {
    const songName = String(req.body?.song_name || '').trim();
    const artist = String(req.body?.artist || '').trim();
    const toWhom = String(req.body?.to_whom || '').trim();
    const message = String(req.body?.message || '').trim();
    if (!songName) {
      return res.json({ code: 400, message: '请填写歌曲名' });
    }
    if (!artist) {
      return res.json({ code: 400, message: '请填写歌手' });
    }
    await pool.execute(
      'INSERT INTO daily_song_recs (song_name, artist, to_whom, message, source, submitter, status, created_at) VALUES (?, ?, ?, ?, "manual", "管理员", "pending", NOW())',
      [songName, artist, toWhom, message]
    );
    res.json({ code: 200, message: '添加成功' });
  } catch (err) {
    res.json({ code: 500, message: '添加失败，请稍后重试' });
  }
});

router.post('/daily-songs/:id/publish', superAdminOnly, requirePermission('songs:review'), async (req, res) => {
  // 保留路由以免旧后台直接报 404，但不允许绕过公众号草稿同步伪造已发布状态。
  res.status(409).json({ code: 409, message: '每日推歌只能在“同步到公众号”成功后自动标为已发布' });
});

router.post('/daily-songs/:id/unpublish', superAdminOnly, requirePermission('songs:review'), async (req, res) => {
  // 已同步到公众号的记录保留真实发布时间，不能通过后台回退成“未发布”。
  res.status(409).json({ code: 409, message: '已发布记录不能手动撤回；三天内仍可在公众号推送页复用' });
});

// 批量移出 / 恢复公众号候选。它不修改 status 或 published_at，避免把未同步歌曲伪造成已发布。
router.post('/daily-songs/candidate-visibility', superAdminOnly, requirePermission('songs:review'), async (req, res) => {
  try {
    const rawIds = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const ids = [...new Set(rawIds.map(Number).filter(Number.isSafeInteger))];
    const hidden = req.body?.hidden === true;
    if (ids.length === 0 || ids.length > 100) {
      return res.status(400).json({ code: 400, message: '请选择 1 到 100 首歌曲' });
    }

    const placeholders = ids.map(() => '?').join(',');
    const [result] = await pool.execute(
      `UPDATE daily_song_recs SET candidate_hidden_at = ${hidden ? 'NOW()' : 'NULL'} WHERE id IN (${placeholders})`,
      ids
    );
    res.json({
      code: 200,
      message: hidden ? '已移出公众号候选' : '已取消移出标记',
      data: { updated: result.affectedRows }
    });
  } catch (err) {
    res.status(500).json({ code: 500, message: '更新候选状态失败，请稍后重试' });
  }
});

// 批量删除必须一次提交并返回影响数量；前端据此立即移除卡片和更新计数。
router.delete('/daily-songs', superAdminOnly, requirePermission('songs:delete'), async (req, res) => {
  try {
    const rawIds = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const ids = [...new Set(rawIds.map(Number).filter(Number.isSafeInteger))];
    if (ids.length === 0 || ids.length > 100) {
      return res.status(400).json({ code: 400, message: '请选择 1 到 100 首歌曲' });
    }

    const placeholders = ids.map(() => '?').join(',');
    const [result] = await pool.execute(`DELETE FROM daily_song_recs WHERE id IN (${placeholders})`, ids);
    res.json({ code: 200, message: '已删除', data: { deleted: result.affectedRows } });
  } catch (err) {
    res.status(500).json({ code: 500, message: '删除失败，请稍后重试' });
  }
});

router.delete('/daily-songs/:id', superAdminOnly, requirePermission('songs:delete'), async (req, res) => {
  try {
    const [result] = await pool.execute('DELETE FROM daily_song_recs WHERE id = ?', [req.params.id]);
    res.status(result.affectedRows > 0 ? 200 : 404).json({
      code: result.affectedRows > 0 ? 200 : 404,
      message: result.affectedRows > 0 ? '已删除' : '歌曲不存在或已删除'
    });
  } catch (err) {
    res.json({ code: 500, message: '删除失败，请稍后重试' });
  }
});

// 推歌编辑器共用的数据清洗与更新逻辑。状态、发布时间和候选可见性由各自流程维护，不能从编辑器篡改。
function normalizeDailySongField(body, key, maxLength) {
  if (!Object.prototype.hasOwnProperty.call(body || {}, key)) return { present: false, value: undefined };
  var value = body[key] === null || body[key] === undefined ? '' : String(body[key]).trim();
  if (value.length > maxLength) {
    var labels = { song_name: '歌曲名', artist: '歌手', to_whom: '收件人', message: '祝福语', intro: '介绍词', lyrics: '歌词' };
    throw { status: 400, message: (labels[key] || key) + '不能超过' + maxLength + '字' };
  }
  return { present: true, value: value };
}

async function updateDailySongFields(id, body) {
  var payload = body || {};
  var name = normalizeDailySongField(payload, 'song_name', 200);
  var artist = normalizeDailySongField(payload, 'artist', 200);
  var toWhom = normalizeDailySongField(payload, 'to_whom', 100);
  var message = normalizeDailySongField(payload, 'message', 5000);
  var intro = normalizeDailySongField(payload, 'intro', 5000);
  var lyrics = normalizeDailySongField(payload, 'lyrics', 30000);
  if (name.present && !name.value) throw { status: 400, message: '请填写歌曲名' };
  if (artist.present && !artist.value) throw { status: 400, message: '请填写歌手' };

  var sets = [];
  var values = [];
  [[name, 'song_name'], [artist, 'artist'], [toWhom, 'to_whom'], [message, 'message'], [intro, 'intro'], [lyrics, 'lyrics']].forEach(function(pair) {
    if (pair[0].present) {
      var value = pair[0].value;
      if (pair[1] === 'intro') {
        // 自动清理模型偶尔返回的 JSON/Markdown 包装，避免把标记直接发到公众号。
        if (value.startsWith('{')) {
          try {
            var parsed = JSON.parse(value);
            value = parsed.intro || value;
            if (!lyrics.present && parsed.lyrics) {
              sets.push('lyrics = ?');
              values.push(String(parsed.lyrics).trim().slice(0, 30000));
            }
          } catch (e) {}
        }
        value = value.replace(/^#{1,6}\s+/gm, '').replace(/\*\*/g, '').replace(/^>\s*/gm, '').replace(/【介绍】/g, '').replace(/【歌词】/g, '').trim();
      }
      sets.push(pair[1] + ' = ?');
      values.push(value);
    }
  });

  if (Object.prototype.hasOwnProperty.call(payload, 'song_info')) {
    var songInfo = payload.song_info;
    if (typeof songInfo === 'string' && songInfo.trim()) {
      try { songInfo = JSON.parse(songInfo); } catch (e) { throw { status: 400, message: '歌曲信息格式不正确' }; }
    }
    if (songInfo !== null && songInfo !== undefined && (typeof songInfo !== 'object' || Array.isArray(songInfo))) {
      throw { status: 400, message: '歌曲信息格式不正确' };
    }
    var encodedInfo = songInfo && Object.keys(songInfo).length ? JSON.stringify(songInfo) : null;
    sets.push('song_info = ?');
    values.push(encodedInfo);
  }

  if (!sets.length) throw { status: 400, message: '没有需要保存的内容' };
  values.push(id);
  var result = await pool.execute('UPDATE daily_song_recs SET ' + sets.join(', ') + ' WHERE id = ?', values);
  return result[0];
}

// 保存推歌完整可编辑内容（歌曲名、歌手、收件信息、介绍词、歌词和歌曲资料）。
router.put('/daily-songs/:id', superAdminOnly, requirePermission('songs:review'), async (req, res) => {
  try {
    var result = await updateDailySongFields(req.params.id, req.body);
    if (!result.affectedRows) return res.status(404).json({ code: 404, message: '歌曲不存在或已删除' });
    res.json({ code: 200, message: '已保存' });
  } catch (err) {
    var status = err && Number.isInteger(err.status) ? err.status : 500;
    res.status(status).json({ code: status, message: err.message || '保存失败，请稍后重试' });
  }
});

// 兼容旧后台只保存介绍词/歌词的调用。
router.put('/daily-songs/:id/intro', superAdminOnly, requirePermission('songs:review'), async (req, res) => {
  try {
    var result = await updateDailySongFields(req.params.id, req.body);
    if (!result.affectedRows) return res.status(404).json({ code: 404, message: '歌曲不存在或已删除' });
    res.json({ code: 200, message: '已保存' });
  } catch (err) {
    var status = err && Number.isInteger(err.status) ? err.status : 500;
    res.status(status).json({ code: status, message: err.message || '保存失败，请稍后重试' });
  }
});

// 搜索歌曲信息（用于音乐卡片）
router.post('/search-song-info', requirePermission('songs:review'), async (req, res) => {
  try {
    const { song_name, artist } = req.body;
    if (!song_name) {
      return res.json({ code: 400, message: '请提供歌曲名' });
    }
    const aiService = require('../services/ai');
    const info = await aiService.searchSongInfo(song_name, artist || '');
    if (info) {
      res.json({ code: 200, data: info });
    } else {
      res.json({ code: 500, message: '搜索失败' });
    }
  } catch (err) {
    res.json({ code: 500, message: '搜索失败，请稍后重试' });
  }
});

// 搜索歌曲歌词
router.post('/search-song-lyrics', requirePermission('songs:review'), async (req, res) => {
  try {
    const { song_name, artist } = req.body;
    if (!song_name) {
      return res.json({ code: 400, message: '请提供歌曲名' });
    }
    const aiService = require('../services/ai');
    const lyrics = await aiService.searchSongLyrics(song_name, artist || '');
    if (lyrics) {
      res.json({ code: 200, data: { lyrics } });
    } else {
      res.json({ code: 500, message: '搜索失败' });
    }
  } catch (err) {
    res.json({ code: 500, message: '搜索失败，请稍后重试' });
  }
});

// 生成歌曲介绍
router.post('/generate-song-intro', requirePermission('songs:review'), async (req, res) => {
  try {
    const { song_name, artist } = req.body;
    if (!song_name) {
      return res.json({ code: 400, message: '请提供歌曲名' });
    }
    const aiService = require('../services/ai');
    const result = await aiService.generateSongIntro(song_name, artist || '');
    if (result.intro || result.lyrics) {
      res.json({ code: 200, data: { intro: result.intro || '', lyrics: result.lyrics || '' } });
    } else if (result.error) {
      // 即使上游繁忙也保留已经生成的安全提示词，前端可展示手动兜底，
      // 但 HTTP 状态仍如实表明自动生成未完成。
      const status = /API_KEY 未配置/.test(result.error) ? 503 : 502;
      res.status(status).json({
        code: status,
        message: result.error,
        data: result.prompt ? { prompt: result.prompt } : undefined
      });
    } else if (result.prompt) {
      res.json({ code: 200, data: { intro: '', lyrics: '', prompt: result.prompt, message: 'AI不可用，请复制提示词手动生成' } });
    } else {
      res.json({ code: 500, message: '生成失败' });
    }
  } catch (err) {
    res.json({ code: 500, message: '生成失败，请稍后重试' });
  }
});

// 生成公众号/推歌/点歌播放表封面提示词。只返回可复制的氛围描述，不直接生成图片。
router.post('/generate-cover-prompt', requirePermission('songs:review'), async (req, res) => {
  try {
    const data = await generateCoverPrompt(req.body);
    res.json({ code: 200, data: data });
  } catch (err) {
    const status = Number(err.status) || 502;
    if (status >= 500) console.error('[AI] 生成封面提示词失败:', err.message);
    res.status(status).json({ code: status, message: err.message || '封面提示词生成失败，请稍后重试' });
  }
});

// QQ热歌榜
router.get('/hot-chart', requirePermission('songs:review'), async (req, res) => {
  try {
    var https = require('https');
    var dateStr = new Date().toISOString().slice(0, 10);
    var url = 'https://c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg?tpl=3&page=detail&date=' + dateStr + '&topid=26&type=top&song_begin=0&song_num=10&format=json';
    var data = await new Promise(function(resolve, reject) {
      https.get(url, { headers: { 'Referer': 'https://y.qq.com/' } }, function(resp) {
        var body = '';
        resp.on('data', function(c) { body += c; });
        resp.on('end', function() { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
      }).on('error', reject);
    });
    var songs = (data.songlist || []).slice(0, 10).map(function(item, index) {
      var d = item.data || {};
      var rawHeat = d.rank_value ?? d.cur_count ?? d.listenCount ?? d.hot ?? null;
      var heat = rawHeat === null || rawHeat === '' ? null : Number(rawHeat);
      if (!Number.isFinite(heat)) heat = null;
      var rawTrend = d.in_count ?? d.old_count ?? null;
      var trend = rawTrend === null || rawTrend === '' ? null : Number(rawTrend);
      if (!Number.isFinite(trend)) trend = null;
      return {
        name: d.songname || '',
        artist: (d.singer || []).map(function(s) { return s.name; }).join(' / '),
        album: d.albumname || d.album || '',
        albummid: d.albummid || '',
        rank: Number(d.cur_rank || d.rank || index + 1) || index + 1,
        heat: heat,
        trend: trend,
        heat_label: heat === null ? '' : String(heat)
      };
    });
    res.json({ code: 200, data: songs });
  } catch (err) {
    res.json({ code: 500, message: '获取热歌榜失败，请稍后重试' });
  }
});

// 搜索歌曲封面
router.get('/song-cover', requirePermission('songs:review'), async (req, res) => {
  try {
    var q = req.query.q || '';
    if (!q) return res.json({ code: 400, data: { albummid: '' } });
    var https = require('https');
    // 搜索多条结果，匹配歌手名提高准确度
    var url = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=' + encodeURIComponent(q) + '&format=json&n=5&p=1';
    var data = await new Promise(function(resolve, reject) {
      https.get(url, { headers: { 'Referer': 'https://y.qq.com/' } }, function(resp) {
        var body = '';
        resp.on('data', function(c) { body += c; });
        resp.on('end', function() { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
      }).on('error', reject);
    });
    var mid = '';
    if (data.data && data.data.song && data.data.song.list && data.data.song.list.length > 0) {
      var list = data.data.song.list;
      // 尝试匹配歌手名（从搜索词中提取歌手部分）
      var parts = q.split(/\s+/);
      var artistPart = parts.length > 1 ? parts[parts.length - 1] : '';
      var best = list[0];
      if (artistPart) {
        for (var i = 0; i < list.length; i++) {
          var singers = (list[i].singer || []).map(function(s) { return s.name || ''; }).join(' ');
          if (singers.toLowerCase().indexOf(artistPart.toLowerCase()) !== -1) {
            best = list[i];
            break;
          }
        }
      }
      mid = best.albummid || '';
    }
    res.json({ code: 200, data: { albummid: mid } });
  } catch (err) {
    res.json({ code: 500, data: { albummid: '' } });
  }
});

// ===== 时段管理（需要 slots:manage 权限）=====

// 获取时段列表（包含日期）
router.get('/slots', requirePermission('slots:manage'), async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    const [slots] = await pool.execute('SELECT * FROM time_slots ORDER BY start_time');
    
    // 返回中国业务日期窗口内的实际日期（包括管理员停用的例外），供后台日历标记。
    // 不能使用数据库 CURDATE()：数据库时区与站点业务时区不一致时，
    // 会导致后台日历和用户端点歌日期相差一天。
    const today = getChinaDate();
    const rangeEnd = getChinaDate(14);
    const [allDates] = await pool.execute(
      'SELECT * FROM slot_dates WHERE play_date >= ? AND play_date < ? ORDER BY play_date',
      [today, rangeEnd]
    );
    
    const result = slots.map(slot => {
      // 根据 weekdays 过滤日期，并格式化日期
      const effectiveStartDate = slotDateValue(slot.effective_start_date);
      let slotDates = allDates.filter(d => d.slot_id === slot.id && (!effectiveStartDate || slotDateValue(d.play_date) >= effectiveStartDate)).map(d => ({
        ...d,
        play_date: d.play_date instanceof Date 
          ? d.play_date.toISOString().split('T')[0] 
          : String(d.play_date).split('T')[0]
      }));
      if (slot.weekdays && slot.weekdays !== '') {
        const jsDays = slot.weekdays.split(',').map(d => parseInt(d));
        // 周期日期与管理员明确加/停播的单日例外都必须返回给编辑日历。
        slotDates = slotDates.filter(d => {
          if (Number(d.manual_override) === 1) return true;
          return jsDays.includes(getChinaJsDayOfWeek(d.play_date));
        });
      }
      
      const configuredMaxSongs = Number(slot.max_songs);
      const maxSongs = configuredMaxSongs > 0
        ? Math.min(100, configuredMaxSongs)
        : (slotDates.length > 0 ? Number(slotDates[0].max_songs) || 10 : 10);
      return { ...slot, dates: slotDates, max_songs: maxSongs };
    });
    
    res.json({ code: 200, data: result });
  } catch (err) {
    console.error('[ERROR] 查询时段失败:', getErrorDetail(err));
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 创建时段
router.post('/slots', requirePermission('slots:manage'), async (req, res) => {
  try {
    const { name, start_time, end_time, is_active, weekdays, effective_start_date, max_songs } = req.body;
    if (!name || !start_time || !end_time) {
      return res.json({ code: 400, message: '请填写完整信息' });
    }
    const effectiveStartDate = effective_start_date === '' ? null : normalizeDateOnly(effective_start_date);
    if (effective_start_date && !effectiveStartDate) {
      return res.json({ code: 400, message: '生效日期格式不正确' });
    }
    const [result] = await pool.execute(
      'INSERT INTO time_slots (name, start_time, end_time, is_active, weekdays, effective_start_date) VALUES (?, ?, ?, ?, ?, ?)',
      [name, start_time, end_time, is_active !== undefined ? is_active : 1, weekdays || '', effectiveStartDate]
    );

    // 根据 weekdays 设置自动添加未来 N 天的日期
    const slotId = result.insertId;
    const maxSongs = Math.max(1, Math.min(100, Number(max_songs) || 10));
    try {
      await pool.execute('UPDATE time_slots SET max_songs = ? WHERE id = ?', [maxSongs, slotId]);
    } catch (e) {
      // 旧版本数据库没有 time_slots.max_songs 时，容量由 slot_dates 保存。
    }
    const weekdayArr = weekdays ? weekdays.split(',').map(w => parseInt(w.trim())) : [];
    const addedDates = [];
    
    // 如果设置了weekdays，只添加匹配周几的日期
    for (let i = 0; i < 14; i++) {
      const dateStr = getChinaDate(i);
      if (effectiveStartDate && dateStr < effectiveStartDate) continue;
      if (weekdayArr.length > 0 && !weekdayArr.includes(getChinaJsDayOfWeek(dateStr))) continue;
      await pool.execute(
        'INSERT IGNORE INTO slot_dates (slot_id, play_date, max_songs, is_active) VALUES (?, ?, ?, 1)',
        [slotId, dateStr, maxSongs]
      );
      addedDates.push(dateStr);
    }

    res.json({ code: 200, message: '创建成功', data: { id: slotId, addedDates } });
  } catch (err) {
    console.error('创建时段错误:', getErrorDetail(err));
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ===== 时段日期管理（必须放在 /slots/:id 之前）=====

// 添加时段日期
router.post('/slots/:slotId/dates', requirePermission('slots:manage'), async (req, res) => {
  try {
    const { play_date, max_songs } = req.body;
    if (!play_date) {
      return res.json({ code: 400, message: '请选择日期' });
    }
    await pool.execute(
      'INSERT INTO slot_dates (slot_id, play_date, max_songs, is_active, manual_override) VALUES (?, ?, ?, 1, 1) ON DUPLICATE KEY UPDATE max_songs = ?, is_active = 1, manual_override = 1',
      [req.params.slotId, play_date, max_songs || 10, max_songs || 10]
    );
    res.json({ code: 200, message: '添加成功' });
  } catch (err) {
    console.error('添加时段日期错误:', getErrorDetail(err));
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 批量添加时段日期
router.post('/slots/:slotId/dates/batch', requirePermission('slots:manage'), async (req, res) => {
  try {
    const { dates, max_songs } = req.body;
    if (!dates || !Array.isArray(dates) || dates.length === 0) {
      return res.json({ code: 400, message: '请选择日期' });
    }
    const maxSongs = max_songs || 10;
    for (const date of dates) {
      await pool.execute(
        'INSERT INTO slot_dates (slot_id, play_date, max_songs, is_active, manual_override) VALUES (?, ?, ?, 1, 1) ON DUPLICATE KEY UPDATE max_songs = ?, is_active = 1, manual_override = 1',
        [req.params.slotId, date, maxSongs, maxSongs]
      );
    }
    res.json({ code: 200, message: '批量添加成功' });
  } catch (err) {
    console.error('批量添加时段日期错误:', getErrorDetail(err));
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 编辑时段日历专用：点周期日即停播，点非周期日即加播；均保留为单日例外。
router.post('/slots/:slotId/calendar-date', requirePermission('slots:manage'), async (req, res) => {
  try {
    const playDate = normalizeDateOnly(req.body && req.body.play_date);
    const isActive = req.body && (req.body.is_active === 1 || req.body.is_active === true) ? 1 : 0;
    if (!playDate) return res.json({ code: 400, message: '日期格式不正确' });
    const [slots] = await pool.execute('SELECT id FROM time_slots WHERE id = ?', [req.params.slotId]);
    if (slots.length === 0) return res.json({ code: 404, message: '时段不存在' });
    const [existing] = await pool.execute('SELECT max_songs FROM slot_dates WHERE slot_id = ? AND play_date = ?', [req.params.slotId, playDate]);
    const maxSongs = existing.length > 0 ? existing[0].max_songs : 10;
    await pool.execute(
      'INSERT INTO slot_dates (slot_id, play_date, max_songs, is_active, manual_override) VALUES (?, ?, ?, ?, 1) ON DUPLICATE KEY UPDATE is_active = VALUES(is_active), manual_override = 1',
      [req.params.slotId, playDate, maxSongs, isActive]
    );
    const [rows] = await pool.execute('SELECT * FROM slot_dates WHERE slot_id = ? AND play_date = ?', [req.params.slotId, playDate]);
    res.json({ code: 200, message: isActive ? '已设为当天播放' : '已设为当天不播放', data: rows[0] });
  } catch (err) {
    console.error('[Slots] 日历单日设置失败:', getErrorDetail(err));
    res.json({ code: 500, message: '更新日期失败，请稍后重试' });
  }
});

// 删除时段日期
router.delete('/slots/:slotId/dates/:dateId', requirePermission('slots:manage'), async (req, res) => {
  try {
    // 不能硬删除：自动补齐任务会把符合周期的日期重新插入。
    // 以停用记录保留“这一天不接受投稿”的管理员例外。
    const [result] = await pool.execute(
      'UPDATE slot_dates SET is_active = 0, manual_override = 1 WHERE id = ? AND slot_id = ?',
      [req.params.dateId, req.params.slotId]
    );
    if (result.affectedRows === 0) return res.json({ code: 404, message: '日期不存在' });
    res.json({ code: 200, message: '已关闭该日期投稿，可随时重新开放' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 修改时段日期
router.put('/slots/:slotId/dates/:dateId', requirePermission('slots:manage'), async (req, res) => {
  try {
    const { max_songs, is_active } = req.body;
    const updates = [];
    const values = [];
    if (max_songs !== undefined) { updates.push('max_songs = ?'); values.push(max_songs); }
    if (is_active !== undefined) {
      updates.push('is_active = ?'); values.push(is_active);
      updates.push('manual_override = 1');
    }
    if (updates.length === 0) {
      return res.json({ code: 400, message: '没有修改内容' });
    }
    values.push(req.params.dateId, req.params.slotId);
    await pool.execute(`UPDATE slot_dates SET ${updates.join(', ')} WHERE id = ? AND slot_id = ?`, values);
    res.json({ code: 200, message: '修改成功' });
  } catch (err) {
    console.error('修改时段日期错误:', getErrorDetail(err));
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 修改时段
router.put('/slots/:id', requirePermission('slots:manage'), async (req, res) => {
  try {
    const slotId = req.params.id;
    const body = req.body || {};
    const { name, start_time, end_time, is_active, weekdays, effective_start_date, max_songs } = body;
    
    // 第一步：更新 time_slots 表（只更新核心字段，不包含 weekdays）
    const slotUpdates = [];
    const slotValues = [];
    if (name !== undefined) { slotUpdates.push('name = ?'); slotValues.push(name); }
    if (start_time !== undefined) { slotUpdates.push('start_time = ?'); slotValues.push(start_time); }
    if (end_time !== undefined) { slotUpdates.push('end_time = ?'); slotValues.push(end_time); }
    if (is_active !== undefined) { slotUpdates.push('is_active = ?'); slotValues.push(is_active); }
    if (weekdays !== undefined) { slotUpdates.push('weekdays = ?'); slotValues.push(weekdays); }
    if (effective_start_date !== undefined) {
      const effectiveStartDate = effective_start_date === '' ? null : normalizeDateOnly(effective_start_date);
      if (effective_start_date && !effectiveStartDate) return res.json({ code: 400, message: '生效日期格式不正确' });
      slotUpdates.push('effective_start_date = ?'); slotValues.push(effectiveStartDate);
    }

    if (slotUpdates.length > 0) {
      slotValues.push(slotId);
      await pool.execute(`UPDATE time_slots SET ${slotUpdates.join(', ')} WHERE id = ?`, slotValues);
    }

    // 第二步：如果传了 max_songs，更新 slot_dates 表（忽略错误）
    if (max_songs !== undefined) {
      const normalizedMaxSongs = Math.max(1, Math.min(100, Number(max_songs) || 10));
      // 新库把时段容量存于 time_slots，旧库可能没有该列，保持兼容。
      try {
        await pool.execute('UPDATE time_slots SET max_songs = ? WHERE id = ?', [normalizedMaxSongs, slotId]);
      } catch (e) {
        // 旧版本数据库没有 time_slots.max_songs 时，继续使用 slot_dates。
      }
      try {
        await pool.execute('UPDATE slot_dates SET max_songs = ? WHERE slot_id = ?', [normalizedMaxSongs, slotId]);
      } catch (e) {
        // 忽略错误，可能是列或表不存在
      }
    }

    // 第三步：周期或生效日期变化后，立即补足未来日期。
    // 已被管理员停用的记录使用 INSERT IGNORE 保留，不会被自动重新开放。
    if (weekdays !== undefined || effective_start_date !== undefined) {
      try {
        const [slotRows] = await pool.execute('SELECT weekdays, effective_start_date FROM time_slots WHERE id = ?', [slotId]);
        const slot = slotRows[0];
        if (!slot) throw new Error('时段不存在');
        const jsDays = String(slot.weekdays || '').split(',').map(Number).filter(day => Number.isInteger(day) && day >= 0 && day <= 6);
        const effectiveStartDate = slotDateValue(slot.effective_start_date);
        let maxSongsVal;
        if (max_songs !== undefined) {
          maxSongsVal = Math.max(1, Math.min(100, Number(max_songs) || 10));
        } else {
          maxSongsVal = Number(slot.max_songs) || 10;
          try {
            const [capacityRows] = await pool.execute(
              'SELECT max_songs FROM slot_dates WHERE slot_id = ? AND manual_override = 0 ORDER BY play_date DESC, id DESC LIMIT 1',
              [slotId]
            );
            if (capacityRows.length > 0 && Number(capacityRows[0].max_songs) > 0) {
              maxSongsVal = Math.min(100, Number(capacityRows[0].max_songs));
            }
          } catch (e) {
            // 兼容旧库，保留 time_slots 的容量。
          }
        }
        if (effectiveStartDate) {
          await pool.execute('UPDATE slot_dates SET is_active = 0 WHERE slot_id = ? AND play_date < ?', [slotId, effectiveStartDate]);
        }
        if (jsDays.length > 0) {
          const mysqlDays = jsDays.map(day => day + 1).join(',');
          await pool.execute(
            `UPDATE slot_dates SET is_active = 0 WHERE slot_id = ? AND manual_override = 0 AND play_date >= ? AND DAYOFWEEK(play_date) NOT IN (${mysqlDays})`,
            [slotId, getChinaDate()]
          );
        }
        for (let i = 0; i < 14; i++) {
          const dateStr = getChinaDate(i);
          if (effectiveStartDate && dateStr < effectiveStartDate) continue;
          if (jsDays.length > 0 && !jsDays.includes(getChinaJsDayOfWeek(dateStr))) continue;
          await pool.execute(
            'INSERT IGNORE INTO slot_dates (slot_id, play_date, max_songs, is_active) VALUES (?, ?, ?, 1)',
            [slotId, dateStr, maxSongsVal]
          );
        }
      } catch (e) {
        console.error('[Slots] 更新时段日期失败:', getErrorDetail(e));
      }
    }

    res.json({ code: 200, message: '修改成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 删除时段
router.delete('/slots/:id', requirePermission('slots:manage'), async (req, res) => {
  try {
    await pool.execute('DELETE FROM time_slots WHERE id = ?', [req.params.id]);
    res.json({ code: 200, message: '删除成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ===== 操作日志 =====

// 获取操作日志
router.get('/logs', requirePermission('logs:view'), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query, { defaultLimit: 20, maxLimit: 100 });

    const [logs] = await pool.execute(
      `SELECT al.*, u.username, u.nickname 
       FROM admin_logs al 
       LEFT JOIN users u ON al.admin_id = u.id 
       ORDER BY al.id DESC LIMIT ? OFFSET ?`,
      [parseInt(limit), parseInt(offset)]
    );

    const [countResult] = await pool.execute('SELECT COUNT(*) as total FROM admin_logs');

    res.json({
      code: 200,
      data: {
        logs,
        total: countResult[0].total,
        page: parseInt(page),
        totalPages: Math.ceil(countResult[0].total / limit)
      }
    });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 记录操作日志
router.post('/logs', async (req, res) => {
  try {
    const { action, detail, level = 'info' } = req.body;
    // 规范化level：将warn转换为warning
    const normalizedLevel = level === 'warn' ? 'warning' : level;
    await pool.execute(
      'INSERT INTO admin_logs (admin_id, action, detail, level) VALUES (?, ?, ?, ?)',
      [req.user.id, action, detail, normalizedLevel]
    );
    res.json({ code: 200, message: '记录成功' });
  } catch (err) {
    console.error('[Admin] 记录日志失败:', err.message);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 清空所有操作日志
router.delete('/logs/all', requirePermission('logs:view'), async (req, res) => {
  try {
    const [result] = await pool.execute('DELETE FROM admin_logs');
    res.json({ code: 200, message: '已清空所有日志', data: { deleted: result.affectedRows } });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 清空N天前的操作日志
router.delete('/logs/old', requirePermission('logs:view'), async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const daysNum = parseInt(days) || 30;
    const [result] = await pool.execute(
      'DELETE FROM admin_logs WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
      [daysNum]
    );
    res.json({ code: 200, message: `已删除 ${daysNum} 天前的日志`, data: { deleted: result.affectedRows } });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 删除单条操作日志
router.delete('/logs/:id', requirePermission('logs:view'), async (req, res) => {
  try {
    const logId = parseInt(req.params.id);
    if (isNaN(logId)) {
      return res.json({ code: 400, message: '无效的日志ID' });
    }
    const [result] = await pool.execute('DELETE FROM admin_logs WHERE id = ?', [logId]);
    if (result.affectedRows === 0) {
      return res.json({ code: 404, message: '日志不存在' });
    }
    res.json({ code: 200, message: '删除成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ===== 公告管理（需要 notices:manage 权限）=====

// 获取公告列表
router.get('/notices', requirePermission('notices:manage'), async (req, res) => {
  try {
    const [notices] = await pool.execute(
      'SELECT * FROM notices ORDER BY is_top DESC, created_at DESC'
    );
    res.json({ code: 200, data: { notices } });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 发布公告
router.post('/notices', requirePermission('notices:manage'), async (req, res) => {
  try {
    const { title, content, is_top = false } = req.body;
    await pool.execute(
      'INSERT INTO notices (admin_id, title, content, is_top) VALUES (?, ?, ?, ?)',
      [req.user.id, title, content, is_top]
    );
    res.json({ code: 200, message: '发布成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 更新公告
router.put('/notices/:id', requirePermission('notices:manage'), async (req, res) => {
  try {
    const { title, content, is_top } = req.body;
    const top = is_top ? 1 : 0;
    await pool.execute(
      'UPDATE notices SET title = ?, content = ?, is_top = ? WHERE id = ?',
      [title, content, top, req.params.id]
    );
    res.json({ code: 200, message: '更新成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 删除公告
router.delete('/notices/:id', requirePermission('notices:manage'), async (req, res) => {
  try {
    await pool.execute('DELETE FROM notices WHERE id = ?', [req.params.id]);
    res.json({ code: 200, message: '删除成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ===== 系统设置（需要 settings:view 权限）=====

// 获取系统设置
router.get('/settings', requirePermission('settings:view'), async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT config_key, config_value FROM settings');
    const settings = {};
    rows.forEach(row => {
      settings[row.config_key] = row.config_value;
    });
    res.json({
      code: 200,
      data: {
        site_name: settings.site_name || '',
        site_description: settings.site_description || '',
        allow_register: settings.allow_register === 'true',
        post_review: settings.post_review === 'true',
        song_enabled: settings.song_enabled === 'true',
        daily_song_limit: parseInt(settings.daily_song_limit) || 3,
        anon_post: settings.anon_post === 'true',
        anon_comment: settings.anon_comment === 'true',
        anon_song: settings.anon_song === 'true',
        email_enabled: settings.email_enabled === 'true',
        register_email_verify_enabled: settings.register_email_verify_enabled === 'true',
        smtp_host: settings.smtp_host || '',
        smtp_port: settings.smtp_port || '587',
        smtp_user: settings.smtp_user || '',
        smtp_pass: settings.smtp_pass || '',
        smtp_from: settings.smtp_from || '',
        festival_theme: Object.prototype.hasOwnProperty.call(settings, 'festival_theme')
          ? (settings.festival_theme === '520' ? '520' : 'teachers_day')
          : (settings.special_mode_520 === 'true' ? '520' : 'teachers_day'),
        festival_enabled: Object.prototype.hasOwnProperty.call(settings, 'festival_enabled')
          ? settings.festival_enabled === 'true'
          : settings.special_mode_520 === 'true',
        song_pending_admin_notify: !['false', '0', 'off'].includes(String(settings.song_pending_admin_notify || 'true').toLowerCase()),
        song_reject_reasons: normalizeSongRejectReasons(settings.song_reject_reasons),
        special_mode_520: settings.special_mode_520 === 'true'
      }
    });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 保存系统设置
router.put('/settings', requirePermission('settings:view'), async (req, res) => {
  try {
    const { site_name, site_description, allow_register, post_review, song_enabled, daily_song_limit, anon_post, anon_comment, anon_song, email_enabled, register_email_verify_enabled, song_pending_admin_notify, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from, festival_theme, festival_enabled, song_reject_reasons } = req.body;

    const keys = [
      ['site_name', site_name || ''],
      ['site_description', site_description || ''],
      ['allow_register', allow_register !== undefined ? String(Boolean(allow_register)) : 'true'],
      ['post_review', post_review !== undefined ? String(Boolean(post_review)) : 'false'],
      ['song_enabled', song_enabled !== undefined ? String(Boolean(song_enabled)) : 'true'],
      ['daily_song_limit', daily_song_limit !== undefined ? String(Math.max(1, parseInt(daily_song_limit) || 3)) : '3'],
      ['anon_post', anon_post !== undefined ? String(Boolean(anon_post)) : 'true'],
      ['anon_comment', anon_comment !== undefined ? String(Boolean(anon_comment)) : 'true'],
      ['anon_song', req.body.anon_song !== undefined ? String(Boolean(req.body.anon_song)) : 'true'],
      ['email_enabled', email_enabled !== undefined ? String(Boolean(email_enabled)) : 'false'],
      ['register_email_verify_enabled', register_email_verify_enabled !== undefined ? String(Boolean(register_email_verify_enabled)) : 'false'],
      ['song_pending_admin_notify', song_pending_admin_notify !== undefined ? String(Boolean(song_pending_admin_notify)) : 'true'],
      ['smtp_host', smtp_host || ''],
      ['smtp_port', smtp_port || '587'],
      ['smtp_user', smtp_user || ''],
      ['smtp_pass', smtp_pass || ''],
      ['smtp_from', smtp_from || ''],
      ['festival_theme', festival_theme === '520' ? '520' : 'teachers_day'],
      ['festival_enabled', festival_enabled !== undefined ? String(Boolean(festival_enabled)) : 'false']
    ];
    if (song_reject_reasons !== undefined) {
      keys.push(['song_reject_reasons', JSON.stringify(normalizeSongRejectReasons(song_reject_reasons))]);
    }
    for (const [key, value] of keys) {
      try {
        await pool.execute(
          'INSERT INTO settings (config_key, config_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE config_value = ?',
          [key, value, value]
        );
      } catch (dbErr) {
        console.error('[Settings] 保存配置项失败:', getErrorDetail(dbErr));
      }
    }
    if (typeof siteRouter.invalidateSiteInfoCache === 'function') {
      siteRouter.invalidateSiteInfoCache();
    }
    
    res.json({ code: 200, message: '保存成功' });
  } catch (err) {
    console.error('[ERROR] 保存设置失败:', getErrorDetail(err));
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 单独保存点歌拒绝理由模板，供拒绝弹窗“保存为预设”使用。
router.put('/settings/song-reject-reasons', requirePermission('settings:view'), async (req, res) => {
  try {
    const reasons = normalizeSongRejectReasons(req.body && req.body.reasons);
    await pool.execute(
      'INSERT INTO settings (config_key, config_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE config_value = ?',
      ['song_reject_reasons', JSON.stringify(reasons), JSON.stringify(reasons)]
    );
    res.json({ code: 200, message: '点歌拒绝理由预设已保存', data: { song_reject_reasons: reasons } });
  } catch (err) {
    console.error('[Settings] 保存点歌拒绝理由失败:', err.message);
    res.json({ code: 500, message: '保存点歌拒绝理由失败' });
  }
});

// 测试邮件发送
router.post('/test-email', requirePermission('settings:view'), async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.json({ code: 400, message: '请提供测试邮箱地址' });
    }
    const { sendEmail } = require('../services/email');
    const success = await sendEmail(email, '🧪 测试邮件 · 示例校园墙', `
      <div style="text-align:center;padding:20px;font-family:sans-serif;">
        <div style="font-size:48px;margin-bottom:16px;">✉️</div>
        <h2 style="color:#FF6B9D;">邮件配置正确！</h2>
        <p style="color:#4A3F5C;font-size:15px;line-height:1.7;">🎉 恭喜，你的SMTP配置已经生效啦~<br>以后用户就能收到评论、点赞、关注等邮件通知了 ✨</p>
        <div style="margin-top:20px;padding:16px;background:#F8F5FF;border-radius:12px;font-size:13px;color:#B8A9D4;">💌 示例校园墙 — 让每一份心意都被看见</div>
      </div>
    `);
    if (success) {
      res.json({ code: 200, message: '测试邮件发送成功' });
    } else {
      res.json({ code: 500, message: '邮件发送失败，请检查SMTP配置' });
    }
  } catch (err) {
    console.error('[Email] 测试邮件发送失败:', getErrorDetail(err));
    res.json({ code: 500, message: '邮件发送失败，请检查配置后重试' });
  }
});

// ===== 反馈管理 =====

// 创建反馈表（如果不存在）
router.get('/init-feedback-table', requirePermission('feedbacks:manage'), async (req, res) => {
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS feedbacks (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT,
        type VARCHAR(50) NOT NULL COMMENT '反馈类型：suggest/bug/complaint/other',
        title VARCHAR(200) NOT NULL COMMENT '反馈标题',
        content TEXT NOT NULL COMMENT '反馈内容',
        contact VARCHAR(200) COMMENT '联系方式',
        status VARCHAR(20) DEFAULT 'pending' COMMENT '状态：pending/processing/resolved/closed',
        reply TEXT COMMENT '管理员回复',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_user_id (user_id),
        INDEX idx_status (status),
        INDEX idx_created_at (created_at)
      )
    `);
    res.json({ code: 200, message: '反馈表创建成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取反馈列表
router.get('/feedbacks', requirePermission('feedbacks:manage'), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query, { defaultLimit: 20, maxLimit: 100 });
    const { status } = req.query;

    let whereClause = '1=1';
    const params = [];
    if (status) {
      whereClause += ' AND f.status = ?';
      params.push(status);
    }

    const [feedbacks] = await pool.execute(`
      SELECT f.*, u.username, u.nickname
      FROM feedbacks f
      LEFT JOIN users u ON f.user_id = u.id
      WHERE ${whereClause}
      ORDER BY f.created_at DESC
      LIMIT ? OFFSET ?
    `, [...params, parseInt(limit), parseInt(offset)]);

    const [countResult] = await pool.execute(`SELECT COUNT(*) as total FROM feedbacks f WHERE ${whereClause}`, params);

    res.json({
      code: 200,
      data: {
        feedbacks,
        total: countResult[0].total,
        totalPages: Math.ceil(countResult[0].total / limit)
      }
    });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取单条反馈详情
router.get('/feedbacks/:id', requirePermission('feedbacks:manage'), async (req, res) => {
  try {
    const [feedbacks] = await pool.execute(`
      SELECT f.*, u.username, u.nickname
      FROM feedbacks f
      LEFT JOIN users u ON f.user_id = u.id
      WHERE f.id = ?
    `, [req.params.id]);

    if (feedbacks.length === 0) {
      return res.json({ code: 404, message: '反馈不存在' });
    }

    res.json({ code: 200, data: feedbacks[0] });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 回复反馈
router.put('/feedbacks/:id/reply', requirePermission('feedbacks:manage'), async (req, res) => {
  try {
    const { reply, status } = req.body;
    await pool.execute('UPDATE feedbacks SET reply = ?, status = ? WHERE id = ?', [reply, status || 'resolved', req.params.id]);
    
    // 异步发送邮件通知用户
    setImmediate(async () => {
      try {
        const [feedbacks] = await pool.execute(`
          SELECT f.*, u.email, u.nickname, u.username 
          FROM feedbacks f
          LEFT JOIN users u ON f.user_id = u.id
          WHERE f.id = ?
        `, [req.params.id]);
        
        if (feedbacks.length > 0 && feedbacks[0].email) {
          const feedback = feedbacks[0];
          const userNickname = feedback.nickname || feedback.username || '用户';
          const { notifyFeedbackReply } = require('../services/email');
          await notifyFeedbackReply(
            feedback.email,
            userNickname,
            feedback.title,
            reply || '管理员已处理您的反馈',
            feedback.user_id
          );
        }
      } catch (err) {
        console.error('[Email] 发送反馈回复通知失败:', getErrorDetail(err));
      }
    });
    
    res.json({ code: 200, message: '回复成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 删除反馈
router.delete('/feedbacks/:id', requirePermission('feedbacks:manage'), async (req, res) => {
  try {
    await pool.execute('DELETE FROM feedbacks WHERE id = ?', [req.params.id]);
    res.json({ code: 200, message: '删除成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ===== 通知管理 =====

// 保留历史初始化接口，实际初始化统一由 config/database.js 负责。
router.get('/init-notifications-table', requirePermission('notices:manage'), async (req, res) => {
  try {
    await ensureNotificationsTable(pool);
    res.json({ code: 200, message: '通知表创建成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取所有通知（后台管理）
router.get('/notifications', requirePermission('notices:manage'), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query, { defaultLimit: 20, maxLimit: 100 });
    const { user_id, type } = req.query;
    
    let whereClause = '1=1';
    const params = [];
    
    if (user_id) {
      whereClause += ' AND n.user_id = ?';
      params.push(user_id);
    }
    if (type) {
      whereClause += ' AND n.type = ?';
      params.push(type);
    }
    
    const [notifications] = await pool.execute(`
      SELECT n.*, u.username, u.nickname
      FROM notifications n
      LEFT JOIN users u ON n.user_id = u.id
      WHERE ${whereClause}
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT ? OFFSET ?
    `, [...params, parseInt(limit), parseInt(offset)]);
    
    const [countResult] = await pool.execute(`
      SELECT COUNT(*) as total FROM notifications n WHERE ${whereClause}
    `, params);
    
    res.json({
      code: 200,
      data: {
        notifications,
        total: countResult[0].total,
        totalPages: Math.ceil(countResult[0].total / limit)
      }
    });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 发送系统通知（后台管理）
router.post('/notifications/send', requirePermission('notices:manage'), async (req, res) => {
  try {
    const { user_id, type, title, content, related_id, related_type } = req.body;
    
    if (!user_id || !title) {
      return res.json({ code: 400, message: '用户ID和标题不能为空' });
    }
    
    await pool.execute(
      'INSERT INTO notifications (user_id, type, title, content, related_id, related_type) VALUES (?, ?, ?, ?, ?, ?)',
      [user_id, type || 'system', title, content || '', related_id || null, related_type || null]
    );
    
    res.json({ code: 200, message: '通知发送成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 批量发送系统通知
router.post('/notifications/send-batch', requirePermission('notices:manage'), async (req, res) => {
  try {
    const { user_ids, type, title, content, related_id, related_type } = req.body;
    
    if (!user_ids || !Array.isArray(user_ids) || user_ids.length === 0 || !title) {
      return res.json({ code: 400, message: '用户ID列表和标题不能为空' });
    }
    
    // 批量插入（参数化查询）
    for (var ni = 0; ni < user_ids.length; ni++) {
      await pool.execute(
        'INSERT INTO notifications (user_id, type, title, content, related_id, related_type) VALUES (?, ?, ?, ?, ?, ?)',
        [user_ids[ni], type || 'system', title, content || '', related_id || null, related_type || null]
      );
    }
    
    res.json({ code: 200, message: `成功发送${user_ids.length}条通知` });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 删除通知
router.delete('/notifications/:id', requirePermission('notices:manage'), async (req, res) => {
  try {
    await pool.execute('DELETE FROM notifications WHERE id = ?', [req.params.id]);
    res.json({ code: 200, message: '删除成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 清空所有通知
router.delete('/notifications', requirePermission('notices:manage'), async (req, res) => {
  try {
    await pool.execute('DELETE FROM notifications');
    res.json({ code: 200, message: '已清空所有通知' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取帖子浏览记录（超级管理员专用）
router.get('/post-views', requirePermission('post-views:view'), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query, { defaultLimit: 20, maxLimit: 100 });
    const { post_id, keyword } = req.query;
    
    let whereClause = '1=1';
    const params = [];
    
    if (post_id) {
      whereClause += ' AND pv.post_id = ?';
      params.push(parseInt(post_id));
    }
    
    if (keyword) {
      whereClause += ' AND (p.title LIKE ? OR p.content LIKE ?)';
      params.push('%' + keyword.trim() + '%', '%' + keyword.trim() + '%');
    }
    
    const [records] = await pool.execute(`
      SELECT pv.id, pv.post_id, pv.user_id, pv.viewer_ip, pv.ip_region, pv.viewer_nickname, pv.viewed_at,
             p.title as post_title, p.content as post_content,
             u.email as user_email
      FROM post_views pv
      LEFT JOIN posts p ON pv.post_id = p.id
      LEFT JOIN users u ON pv.user_id = u.id
      WHERE ${whereClause}
      ORDER BY pv.viewed_at DESC
      LIMIT ? OFFSET ?
    `, [...params, parseInt(limit), offset]);
    
    const [countResult] = await pool.execute(`
      SELECT COUNT(*) as total FROM post_views pv
      LEFT JOIN posts p ON pv.post_id = p.id
      WHERE ${whereClause}
    `, params);
    
    res.json({
      code: 200,
      data: {
        records: records,
        total: countResult[0].total,
        page: parseInt(page),
        totalPages: Math.ceil(countResult[0].total / parseInt(limit))
      }
    });
  } catch (err) {
    console.error('获取浏览记录错误:', getErrorDetail(err));
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 清空N天前的浏览记录
router.delete('/post-views/old', requirePermission('post-views:view'), async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const daysNum = parseInt(days) || 30;
    const [result] = await pool.execute(
      'DELETE FROM post_views WHERE viewed_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
      [daysNum]
    );
    res.json({ code: 200, message: '清空成功', data: { deleted: result.affectedRows } });
  } catch (err) {
    console.error('清空浏览记录错误:', getErrorDetail(err));
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ===== 头衔管理（仅超级管理员）=====

// 获取头衔列表
router.get('/titles', superAdminOnly, async (req, res) => {
  try {
    const [titles] = await pool.execute('SELECT * FROM user_titles ORDER BY sort_order DESC, id ASC');
    res.json({ code: 200, data: titles });
  } catch (err) {
    console.error('获取头衔列表错误:', getErrorDetail(err));
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 添加头衔
router.post('/titles', superAdminOnly, async (req, res) => {
  try {
    const { title_name, title_color, title_bg, icon, sort_order } = req.body;
    if (!title_name || !title_name.trim()) {
      return res.json({ code: 400, message: '头衔名称不能为空' });
    }
    const [result] = await pool.execute(
      'INSERT INTO user_titles (title_name, title_color, title_bg, icon, sort_order) VALUES (?, ?, ?, ?, ?)',
      [title_name.trim(), title_color || '#FF6B9D', title_bg || 'rgba(255,107,157,0.1)', icon || '⭐', sort_order || 0]
    );
    res.json({ code: 200, message: '添加成功', data: { id: result.insertId } });
  } catch (err) {
    console.error('添加头衔错误:', getErrorDetail(err));
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 编辑头衔
router.put('/titles/:id', superAdminOnly, async (req, res) => {
  try {
    const { title_name, title_color, title_bg, icon, sort_order } = req.body;
    const titleId = parseInt(req.params.id);
    if (!title_name || !title_name.trim()) {
      return res.json({ code: 400, message: '头衔名称不能为空' });
    }
    await pool.execute(
      'UPDATE user_titles SET title_name = ?, title_color = ?, title_bg = ?, icon = ?, sort_order = ? WHERE id = ?',
      [title_name.trim(), title_color || '#FF6B9D', title_bg || 'rgba(255,107,157,0.1)', icon || '⭐', sort_order || 0, titleId]
    );
    res.json({ code: 200, message: '修改成功' });
  } catch (err) {
    console.error('编辑头衔错误:', getErrorDetail(err));
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 删除头衔
router.delete('/titles/:id', superAdminOnly, async (req, res) => {
  try {
    const titleId = parseInt(req.params.id);
    const [result] = await pool.execute('DELETE FROM user_titles WHERE id = ?', [titleId]);
    if (result.affectedRows === 0) {
      return res.json({ code: 404, message: '头衔不存在' });
    }
    res.json({ code: 200, message: '删除成功' });
  } catch (err) {
    console.error('删除头衔错误:', getErrorDetail(err));
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取用户的头衔
router.get('/users/:id/titles', superAdminOnly, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const [titles] = await pool.execute(`
      SELECT t.* FROM user_titles t
      JOIN user_title_relations r ON t.id = r.title_id
      WHERE r.user_id = ?
      ORDER BY t.sort_order DESC, t.id ASC
    `, [userId]);
    res.json({ code: 200, data: titles });
  } catch (err) {
    console.error('获取用户头衔错误:', getErrorDetail(err));
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 给用户添加头衔
router.post('/users/:id/titles', superAdminOnly, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const { title_id } = req.body;
    if (!title_id) {
      return res.json({ code: 400, message: '请选择头衔' });
    }
    // 检查用户是否存在
    const [user] = await pool.execute('SELECT id FROM users WHERE id = ?', [userId]);
    if (user.length === 0) {
      return res.json({ code: 404, message: '用户不存在' });
    }
    // 检查头衔是否存在
    const [title] = await pool.execute('SELECT id FROM user_titles WHERE id = ?', [title_id]);
    if (title.length === 0) {
      return res.json({ code: 404, message: '头衔不存在' });
    }
    await pool.execute('INSERT IGNORE INTO user_title_relations (user_id, title_id) VALUES (?, ?)', [userId, title_id]);
    res.json({ code: 200, message: '添加成功' });
  } catch (err) {
    console.error('添加用户头衔错误:', getErrorDetail(err));
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 移除用户的头衔
router.delete('/users/:userId/titles/:titleId', superAdminOnly, async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const titleId = parseInt(req.params.titleId);
    await pool.execute('DELETE FROM user_title_relations WHERE user_id = ? AND title_id = ?', [userId, titleId]);
    res.json({ code: 200, message: '移除成功' });
  } catch (err) {
    console.error('移除用户头衔错误:', getErrorDetail(err));
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 清空所有浏览记录
router.delete('/post-views/all', requirePermission('post-views:view'), async (req, res) => {
  try {
    const [result] = await pool.execute('DELETE FROM post_views');
    res.json({ code: 200, message: '已清空所有浏览记录', data: { deleted: result.affectedRows } });
  } catch (err) {
    console.error('清空浏览记录错误:', getErrorDetail(err));
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取用户的公开资料（用于弹窗展示）
router.get('/users/:id/profile', requirePermission('users:view'), async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const [users] = await pool.execute(`
      SELECT id, username, nickname, avatar, email, role, status, created_at,
             ban_reason, ban_attempt_ip, ban_attempt_count
      FROM users WHERE id = ?
    `, [userId]);
    
    if (users.length === 0) {
      return res.json({ code: 404, message: '用户不存在' });
    }
    
    const user = users[0];
    
    // 获取用户发帖统计
    let postCount = 0;
    try {
      const [posts] = await pool.execute('SELECT COUNT(*) as total FROM posts WHERE user_id = ?', [userId]);
      postCount = posts[0].total;
    } catch (e) {
      // 忽略错误
    }
    user.post_count = postCount;
    
    // 获取用户浏览统计
    let viewCount = 0;
    try {
      const [views] = await pool.execute('SELECT COUNT(*) as total FROM post_views WHERE user_id = ?', [userId]);
      viewCount = views[0].total;
    } catch (e) {
      // 忽略错误
    }
    user.view_count = viewCount;
    
    res.json({ code: 200, data: user });
  } catch (err) {
    console.error('获取用户资料错误:', err.message);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ===== 邮件群发 =====

// 获取收件人数量
router.get('/email/recipients', requirePermission('notices:manage'), async (req, res) => {
  try {
    const { type = 'all' } = req.query;
    let whereClause = '1=1';
    
    if (type === 'active') {
      whereClause += ' AND last_login_at > DATE_SUB(NOW(), INTERVAL 30 DAY)';
    } else if (type === 'role_user') {
      whereClause += ' AND role = "user"';
    } else if (type === 'role_reviewer') {
      whereClause += ' AND role = "reviewer"';
    } else if (type === 'role_radio_admin') {
      whereClause += ' AND role = "radio_admin"';
    } else if (type === 'role_admin') {
      whereClause += ' AND role = "admin"';
    } else if (type === 'role_super_admin') {
      whereClause += ' AND role = "super_admin"';
    }
    
    // 显示真实人数，发送时会自动过滤无邮箱的用户
    const [countResult] = await pool.execute(
      `SELECT COUNT(*) as total FROM users WHERE ${whereClause}`
    );
    // 同时返回有邮箱的真实可发送数
    const [emailCount] = await pool.execute(
      `SELECT COUNT(*) as total FROM users WHERE ${whereClause} AND email IS NOT NULL AND email != ""`
    );
    
    res.json({ code: 200, data: { count: countResult[0].total, emailCount: emailCount[0].total } });
  } catch (err) {
    console.error('获取收件人数量错误:', getErrorDetail(err));
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 发送邮件群发
router.post('/email/send-batch', requirePermission('notices:manage'), async (req, res) => {
  try {
    const { subject, content, link, recipientType = 'all' } = req.body;
    
    if (!subject || !content) {
      return res.json({ code: 400, message: '标题和内容不能为空' });
    }
    
    // 获取收件人列表
    let whereClause = 'email IS NOT NULL AND email != ""';
    if (recipientType === 'active') {
      whereClause += ' AND last_login_at > DATE_SUB(NOW(), INTERVAL 30 DAY)';
    } else if (recipientType === 'role_user') {
      whereClause += ' AND role = "user"';
    } else if (recipientType === 'role_reviewer') {
      whereClause += ' AND role = "reviewer"';
    } else if (recipientType === 'role_radio_admin') {
      whereClause += ' AND role = "radio_admin"';
    } else if (recipientType === 'role_admin') {
      whereClause += ' AND role = "admin"';
    } else if (recipientType === 'role_super_admin') {
      whereClause += ' AND role = "super_admin"';
    }
    
    const [users] = await pool.execute(
      `SELECT id, email, nickname, username FROM users WHERE ${whereClause}`
    );
    
    if (users.length === 0) {
      return res.json({ code: 400, message: '没有符合条件的收件人' });
    }
    
    // 导入邮件服务
    const { sendEmail } = require('../services/email');
    const siteUrl = process.env.SITE_URL || 'http://localhost:3000';
    
    // 生成卡哇伊风格邮件HTML
    const emailHtml = `
      <p style="font-size:15px;color:#4A3F5C;margin:0 0 16px;line-height:1.8;">
        亲爱的同学：
      </p>
      <div style="font-size:14px;color:#4A3F5C;line-height:1.8;white-space:pre-wrap;">${content}</div>
      <p style="font-size:14px;color:#B8A9D4;margin:16px 0 0;"> 来自 示例校园墙 的温馨提醒</p>
    `;
    
    // 使用kawaiiLayout包装
    const { kawaiiLayout } = require('../services/email');
    const fullHtml = kawaiiLayout(subject, emailHtml, link || siteUrl);
    
    // 记录发送历史
    await pool.execute(
      'INSERT INTO email_batch_history (admin_id, subject, content, recipient_type, total_count, status) VALUES (?, ?, ?, ?, ?, ?)',
      [req.user.id, subject, content, recipientType, users.length, 'sending']
    );
    const [historyResult] = await pool.execute('SELECT LAST_INSERT_ID() as id');
    const historyId = historyResult[0].id;
    
    // 异步发送邮件
    let successCount = 0;
    let failCount = 0;
    const logs = [];
    
    for (let i = 0; i < users.length; i++) {
      const user = users[i];
      const userEmail = user.email;
      try {
        const success = await sendEmail(userEmail, subject, fullHtml);
        if (success) {
          successCount++;
          logs.push({ email: userEmail, status: 'success' });
        } else {
          failCount++;
          logs.push({ email: userEmail, status: 'fail' });
        }
      } catch (err) {
        failCount++;
        logs.push({ email: userEmail, status: 'fail', error: err.message });
      }
      
      // 每10封更新一次进度
      if ((i + 1) % 10 === 0 || i === users.length - 1) {
        await pool.execute(
          'UPDATE email_batch_history SET sent_count = ?, fail_count = ?, logs = ? WHERE id = ?',
          [successCount, failCount, JSON.stringify(logs), historyId]
        );
      }
    }
    
    // 更新最终状态
    const finalStatus = failCount === 0 ? 'success' : (successCount > 0 ? 'partial' : 'fail');
    await pool.execute(
      'UPDATE email_batch_history SET status = ?, sent_count = ?, fail_count = ?, logs = ?, finished_at = NOW() WHERE id = ?',
      [finalStatus, successCount, failCount, JSON.stringify(logs), historyId]
    );
    
    res.json({ 
      code: 200, 
      message: '发送完成',
      data: { 
        historyId,
        total: users.length,
        success: successCount,
        fail: failCount,
        status: finalStatus
      }
    });
  } catch (err) {
    console.error('邮件群发错误:', getErrorDetail(err));
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取发送历史
router.get('/email/history', requirePermission('notices:manage'), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query, { defaultLimit: 20, maxLimit: 100 });
    
    const [history] = await pool.execute(
      `SELECT h.*, u.nickname as admin_nickname 
       FROM email_batch_history h
       LEFT JOIN users u ON h.admin_id = u.id
       ORDER BY h.created_at DESC
       LIMIT ? OFFSET ?`,
      [parseInt(limit), parseInt(offset)]
    );
    
    const [countResult] = await pool.execute('SELECT COUNT(*) as total FROM email_batch_history');
    
    res.json({
      code: 200,
      data: {
        history,
        total: countResult[0].total,
        totalPages: Math.ceil(countResult[0].total / limit)
      }
    });
  } catch (err) {
    console.error('获取发送历史错误:', getErrorDetail(err));
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ===== 微信测试 =====
// 获取已绑定微信的用户列表
router.get('/wechat/users', requirePermission('wechat:review'), async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT DISTINCT u.id, u.username, u.nickname, u.role, u.openid, ' +
      'MAX(wb.bound_at) as bound_at ' +
      'FROM users u ' +
      'LEFT JOIN wechat_bindings wb ON u.id = wb.user_id AND wb.used = 1 ' +
      'WHERE u.openid IS NOT NULL ' +
      'GROUP BY u.id ' +
      'ORDER BY bound_at DESC'
    );
    res.json({ code: 200, data: rows });
  } catch (err) {
    console.error('[Admin] 获取微信用户失败:', err.message);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 测试消息推送（订阅号仅能验证连接，不能主动发消息）
router.post('/wechat/test-message', requirePermission('wechat:review'), async (req, res) => {
  try {
    var { openid, user_id } = req.body;
    if (!openid) {
      return res.json({ code: 400, message: '缺少openid' });
    }

    // 测试获取AccessToken
    var wechatService = require('../services/wechat');
    var token;
    try {
      token = await wechatService.getAccessToken();
    } catch (e) {
      return res.json({ code: 500, message: '获取AccessToken失败: ' + e.message + '，请检查WECHAT_SECRET配置' });
    }

    // 尝试调用客服消息接口（订阅号不支持主动推送，返回错误正常）
    var postData = JSON.stringify({
      touser: openid,
      msgtype: 'text',
      text: {
        content: '🔔 示例校园墙 - 测试消息'
      }
    });

    var result = await new Promise((resolve, reject) => {
      var https = require('https');
      var url = 'https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=' + token;
      var urlObj = new URL(url);
      var options = {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
      };
      var reqHttps = https.request(options, function(response) {
        var body = '';
        response.on('data', function(chunk) { body += chunk; });
        response.on('end', function() {
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(e); }
        });
      });
      reqHttps.on('error', reject);
      reqHttps.write(postData);
      reqHttps.end();
    });

    if (result && result.errcode === 0) {
      res.json({ code: 200, message: '✅ 消息推送成功！' });
    } else {
      // 订阅号主动推送会失败，但能拿到token和openid就是配置成功了
      var errMsg = result?.errmsg || '';
      if (errMsg.indexOf('unauthorized') !== -1) {
        res.json({
          code: 200,
          message: '✅ AccessToken获取成功，openid: ' + openid + '\n（订阅号不支持主动推送消息，需用户在公众号发消息后48小时内才能回复）'
        });
      } else {
        res.json({ code: 500, message: '发送失败: ' + errMsg });
      }
    }
  } catch (err) {
    console.error('[Admin] 测试消息推送错误:', err.message);
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ===== 获取邮件发送日志 =====
router.get('/email-logs', requirePermission('notices:manage'), async (req, res) => {
  try {
    var emailPagination = getPagination({ page: req.query.page, limit: req.query.pageSize }, { defaultLimit: 30, maxLimit: 100 });
    var page = emailPagination.page;
    var ps = emailPagination.limit;
    var off = emailPagination.offset;
    await pool.execute("CREATE TABLE IF NOT EXISTS email_logs (id INT AUTO_INCREMENT PRIMARY KEY,to_email VARCHAR(255) NOT NULL,subject VARCHAR(500) NOT NULL,type VARCHAR(50) DEFAULT '',content_preview VARCHAR(500) DEFAULT '',status ENUM('success','fail') DEFAULT 'success',error_msg VARCHAR(500) DEFAULT '',target_user_name VARCHAR(100) DEFAULT '',created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,INDEX idx_created (created_at)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    var [rows] = await pool.execute("SELECT id,to_email,subject,type,content_preview,status,error_msg,target_user_name,created_at FROM email_logs ORDER BY created_at DESC LIMIT ? OFFSET ?", [ps, off]);
    var [cnt] = await pool.execute("SELECT COUNT(*) as t FROM email_logs");
    res.json({ code: 200, data: { logs: rows, total: cnt[0].t, page: page, pageSize: ps } });
  } catch(e) { res.json({ code: 200, data: { logs: [], total: 0 } }); }
});

// 清空N天前的邮件记录
router.delete('/email-logs/old', requirePermission('notices:manage'), async (req, res) => {
  try {
    var days = parseInt(req.query.days) || 30;
    var [result] = await pool.execute(
      'DELETE FROM email_logs WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
      [days]
    );
    res.json({ code: 200, message: '已删除 ' + days + ' 天前的邮件记录', data: { deleted: result.affectedRows } });
  } catch(e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 清空所有邮件记录
router.delete('/email-logs/all', requirePermission('notices:manage'), async (req, res) => {
  try {
    var [result] = await pool.execute('DELETE FROM email_logs');
    res.json({ code: 200, message: '已清空所有邮件记录', data: { deleted: result.affectedRows } });
  } catch(e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 删除单条邮件记录（必须放在 /all 和 /old 之后，否则会被 :id 匹配到）
router.delete('/email-logs/:id', requirePermission('notices:manage'), async (req, res) => {
  try {
    var logId = parseInt(req.params.id);
    if (isNaN(logId)) {
      return res.json({ code: 400, message: '无效的日志ID' });
    }
    var [result] = await pool.execute('DELETE FROM email_logs WHERE id = ?', [logId]);
    if (result.affectedRows === 0) {
      return res.json({ code: 404, message: '日志不存在' });
    }
    res.json({ code: 200, message: '删除成功' });
  } catch(e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ===== 超级管理员一键登录用户账号 =====
router.post('/login-as-user', superAdminOnly, async (req, res) => {
  try {
    var userId = parseInt(req.body.user_id);
    if (!userId) return res.json({ code: 400, message: '请提供用户ID' });
    var [users] = await pool.execute('SELECT id, username, nickname, role, avatar FROM users WHERE id = ?', [userId]);
    if (users.length === 0) return res.json({ code: 404, message: '用户不存在' });
    var user = users[0];
    var token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      code: 200,
      data: {
        token: token,
        user: {
          id: user.id,
          username: user.username,
          nickname: user.nickname,
          role: user.role,
          avatar: user.avatar
        }
      },
      message: '✅ 已登录到 ' + (user.nickname || user.username) + ' 的账号'
    });
  } catch (err) {
    console.error('[Admin] 登录用户账号失败:', err.message);
    res.json({ code: 500, message: '操作失败，请稍后重试' });
  }
});

// ===== 私信管理（仅最高管理员可见所有消息） =====
// 获取所有会话列表（含清空状态，已清空的会话不显示）
router.get('/messages', superAdminOnly, async (req, res) => {
  try {
    const [convs] = await pool.execute(`
      SELECT c.id, c.user1_id, c.user2_id, c.user1_dnd, c.user2_dnd,
        c.user1_cleared_at, c.user2_cleared_at, c.last_message_at, c.created_at,
        u1.nickname as u1_name, u1.username as u1_username,
        u2.nickname as u2_name, u2.username as u2_username,
        (SELECT content FROM messages WHERE conversation_id = c.id AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1) as last_msg,
        (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) as total_msgs,
        (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id AND deleted_at IS NOT NULL) as deleted_msgs
      FROM conversations c
      LEFT JOIN users u1 ON u1.id = c.user1_id
      LEFT JOIN users u2 ON u2.id = c.user2_id
      WHERE c.id IS NOT NULL
      ORDER BY c.last_message_at DESC
    `);
    res.json({ code: 200, data: { conversations: convs } });
  } catch (err) {
    console.error('[Admin] 获取消息列表失败:', err.message);
    res.status(500).json({ code: 500, message: '操作失败，请稍后重试' });
  }
});

// 获取某个会话的所有消息（包括用户已清空的、软删除的）
router.get('/messages/:id/messages', superAdminOnly, async (req, res) => {
  try {
    const convId = parseInt(req.params.id);
    const [msgs] = await pool.execute(`
      SELECT m.*, u.nickname as sender_name, u.username as sender_username
      FROM messages m
      LEFT JOIN users u ON u.id = m.sender_id
      WHERE m.conversation_id = ?
      ORDER BY m.created_at ASC
    `, [convId]);
    const [conv] = await pool.execute(`
      SELECT c.*, u1.nickname as u1_name, u2.nickname as u2_name
      FROM conversations c
      LEFT JOIN users u1 ON u1.id = c.user1_id
      LEFT JOIN users u2 ON u2.id = c.user2_id
      WHERE c.id = ?
    `, [convId]);
    res.json({ code: 200, data: { conversation: conv[0] || null, messages: msgs } });
  } catch (err) {
    console.error('[Admin] 获取会话消息失败:', err.message);
    res.status(500).json({ code: 500, message: '操作失败，请稍后重试' });
  }
});

// 永久删除单条消息
router.delete('/messages/:id', superAdminOnly, async (req, res) => {
  try {
    await pool.execute('DELETE FROM messages WHERE id = ?', [parseInt(req.params.id)]);
    res.json({ code: 200, message: '消息已永久删除' });
  } catch (err) {
    res.status(500).json({ code: 500, message: '操作失败，请稍后重试' });
  }
});

// 清空某个会话（永久删除所有消息+会话本身）
router.post('/conversations/:id/purge', superAdminOnly, async (req, res) => {
  try {
    await pool.execute('DELETE FROM messages WHERE conversation_id = ?', [parseInt(req.params.id)]);
    await pool.execute('DELETE FROM conversations WHERE id = ?', [parseInt(req.params.id)]);
    res.json({ code: 200, message: '会话及消息已全部永久删除' });
  } catch (err) {
    res.status(500).json({ code: 500, message: '操作失败，请稍后重试' });
  }
});

// ===== 小说管理（支持多本小说） =====
// 存储结构：
//   config/novels.json          - 小说列表
//   config/auto-publish.json    - 其中包含 activeNovelId + 每本小说的配置
//   config/stories/{novelId}/   - 每本小说的章节文件
const fs_stories = require('fs');
const path_stories = require('path');
const STORIES_BASE = path_stories.join(__dirname, '..', 'config', 'stories');
const NOVELS_PATH = path_stories.join(__dirname, '..', 'config', 'novels.json');

if (!fs_stories.existsSync(STORIES_BASE)) {
  fs_stories.mkdirSync(STORIES_BASE, { recursive: true });
}

// ===== 小说管理 =====

function novelsGetList() {
  if (fs_stories.existsSync(NOVELS_PATH)) {
    return JSON.parse(fs_stories.readFileSync(NOVELS_PATH, 'utf8'));
  }
  // 自动迁移：从旧单本小说结构创建默认小说
  var list = [];
  var oldIndexPath = path_stories.join(STORIES_BASE, 'index.json');
  if (fs_stories.existsSync(oldIndexPath)) {
    try {
      var oldIndex = JSON.parse(fs_stories.readFileSync(oldIndexPath, 'utf8'));
      if (Array.isArray(oldIndex) && oldIndex.length > 0) {
        // 已有章节，创建默认小说
        list.push({ id: 'default', title: '致那个夏天的你', author: '示例校园校园墙编辑部', desc: '校园青春小说', createdAt: new Date().toISOString().substring(0, 10) });
        // 把文件从 config/stories/ 移到 config/stories/default/
        var novelDir = path_stories.join(STORIES_BASE, 'default');
        if (!fs_stories.existsSync(novelDir)) fs_stories.mkdirSync(novelDir, { recursive: true });
        fs_stories.renameSync(oldIndexPath, path_stories.join(novelDir, 'index.json'));
        oldIndex.forEach(function(entry) {
          var src = path_stories.join(STORIES_BASE, entry.file);
          if (fs_stories.existsSync(src)) {
            fs_stories.renameSync(src, path_stories.join(novelDir, entry.file));
          }
        });
        // 更新 auto-publish.json
        var autoPubPath = path_stories.join(__dirname, '..', 'config', 'auto-publish.json');
        if (fs_stories.existsSync(autoPubPath)) {
          try {
            var pubConfig = JSON.parse(fs_stories.readFileSync(autoPubPath, 'utf8'));
            pubConfig.activeNovelId = 'default';
            if (!pubConfig.novels) pubConfig.novels = {};
            pubConfig.novels['default'] = {
              currentStoryIndex: pubConfig.currentStoryIndex || 0,
              promptConfig: pubConfig.promptConfig || {}
            };
            delete pubConfig.currentStoryIndex;
            delete pubConfig.promptConfig;
            fs_stories.writeFileSync(autoPubPath, JSON.stringify(pubConfig, null, 2), 'utf8');
          } catch(e) {}
        }
        console.log('[小说] 旧单本结构已自动迁移为多小说结构');
      }
    } catch(e) { console.warn('[小说] 自动迁移失败:', e.message); }
  }
  if (list.length === 0) {
    // 全新安装，创建默认小说
    list.push({ id: 'default', title: '致那个夏天的你', author: '示例校园校园墙编辑部', desc: '校园青春小说', createdAt: new Date().toISOString().substring(0, 10) });
  }
  fs_stories.writeFileSync(NOVELS_PATH, JSON.stringify(list, null, 2), 'utf8');
  return list;
}

function novelsSaveList(list) {
  fs_stories.writeFileSync(NOVELS_PATH, JSON.stringify(list, null, 2), 'utf8');
}

function novelsGetById(id) {
  var list = novelsGetList();
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === id) return list[i];
  }
  return null;
}

function getNovelDir(novelId) {
  return path_stories.join(STORIES_BASE, novelId || 'default');
}

function getNovelPubConfig(pubConfig, novelId) {
  novelId = novelId || pubConfig.activeNovelId || 'default';
  if (!pubConfig.novels) pubConfig.novels = {};
  if (!pubConfig.novels[novelId]) {
    pubConfig.novels[novelId] = { currentStoryIndex: 0, promptConfig: {} };
  }
  return {
    novels: pubConfig.novels,
    currentStoryIndex: pubConfig.novels[novelId].currentStoryIndex || 0,
    promptConfig: pubConfig.novels[novelId].promptConfig || {}
  };
}

function saveNovelPubConfig(pubConfig, novelId, data) {
  novelId = novelId || pubConfig.activeNovelId || 'default';
  if (!pubConfig.novels) pubConfig.novels = {};
  if (!pubConfig.novels[novelId]) pubConfig.novels[novelId] = {};
  if (data.currentStoryIndex !== undefined) pubConfig.novels[novelId].currentStoryIndex = data.currentStoryIndex;
  if (data.promptConfig !== undefined) pubConfig.novels[novelId].promptConfig = data.promptConfig;
  var autoPubPath = path_stories.join(__dirname, '..', 'config', 'auto-publish.json');
  fs_stories.writeFileSync(autoPubPath, JSON.stringify(pubConfig, null, 2), 'utf8');
}

function loadPubConfig() {
  var autoPubPath = path_stories.join(__dirname, '..', 'config', 'auto-publish.json');
  if (fs_stories.existsSync(autoPubPath)) {
    try { return JSON.parse(fs_stories.readFileSync(autoPubPath, 'utf8')); } catch(e) {}
  }
  return { hour: 8, minute: 0, enabled: true, activeNovelId: 'default', novels: {} };
}

// ===== 章节存储辅助函数（支持多小说） =====

function storiesGetIndex(novelId) {
  var dir = getNovelDir(novelId);
  var p = path_stories.join(dir, 'index.json');
  if (fs_stories.existsSync(p)) return JSON.parse(fs_stories.readFileSync(p, 'utf8'));
  // 兼容：当 novelId 为 default 时，检查老位置 config/stories/index.json
  if (!novelId || novelId === 'default') {
    var oldDir = path_stories.join(__dirname, '..', 'config', 'stories');
    var oldP = path_stories.join(oldDir, 'index.json');
    if (fs_stories.existsSync(oldP)) {
      try {
        var oldIndex = JSON.parse(fs_stories.readFileSync(oldP, 'utf8'));
        if (Array.isArray(oldIndex) && oldIndex.length > 0) {
          if (!fs_stories.existsSync(dir)) fs_stories.mkdirSync(dir, { recursive: true });
          // 搬 index
          fs_stories.renameSync(oldP, p);
          // 搬章节文件
          oldIndex.forEach(function(entry) {
            var src = path_stories.join(oldDir, entry.file);
            if (fs_stories.existsSync(src)) {
              fs_stories.renameSync(src, path_stories.join(dir, entry.file));
            }
          });
          console.log('[故事] 从 config/stories/ 迁移到 ' + dir + '，共' + oldIndex.length + '章');
          return JSON.parse(fs_stories.readFileSync(p, 'utf8'));
        }
      } catch(e) { console.warn('[故事] 迁移 config/stories/ 失败:', e.message); }
    }
  }
  // 兼容旧格式：config/stories.json（更古老的格式）
  var oldPath = path_stories.join(__dirname, '..', 'config', 'stories.json');
  if (fs_stories.existsSync(oldPath)) {
    try {
      var oldStories = JSON.parse(fs_stories.readFileSync(oldPath, 'utf8'));
      if (Array.isArray(oldStories) && oldStories.length > 0) {
        if (!fs_stories.existsSync(dir)) fs_stories.mkdirSync(dir, { recursive: true });
        var idx = [];
        oldStories.forEach(function(s, i) {
          var chapFile = i + '.json';
          fs_stories.writeFileSync(path_stories.join(dir, chapFile), JSON.stringify({ title: s.title, content: s.content, author: s.author || '示例校园校园墙编辑部' }, null, 2), 'utf8');
          idx.push({ file: chapFile, title: s.title, author: s.author || '示例校园校园墙编辑部', published: false });
        });
        fs_stories.writeFileSync(p, JSON.stringify(idx, null, 2), 'utf8');
        fs_stories.renameSync(oldPath, oldPath + '.bak');
        console.log('[故事] 旧格式已自动迁移，共' + idx.length + '章');
        return idx;
      }
    } catch(e) { console.warn('[故事] 迁移旧格式失败:', e.message); }
  }
  return [];
}

function storiesSaveIndex(index, novelId) {
  var dir = getNovelDir(novelId);
  if (!fs_stories.existsSync(dir)) fs_stories.mkdirSync(dir, { recursive: true });
  fs_stories.writeFileSync(path_stories.join(dir, 'index.json'), JSON.stringify(index, null, 2), 'utf8');
}

function storiesGetChapter(idx, novelId) {
  var index = storiesGetIndex(novelId);
  var dir = getNovelDir(novelId);
  if (idx >= 0 && idx < index.length) {
    var chapPath = path_stories.join(dir, index[idx].file);
    if (fs_stories.existsSync(chapPath)) return JSON.parse(fs_stories.readFileSync(chapPath, 'utf8'));
  }
  return null;
}

function storiesSaveChapter(idx, data, novelId) {
  var index = storiesGetIndex(novelId);
  var dir = getNovelDir(novelId);
  if (idx >= 0 && idx < index.length) {
    fs_stories.writeFileSync(path_stories.join(dir, index[idx].file), JSON.stringify({ title: data.title, content: data.content, author: data.author }, null, 2), 'utf8');
    index[idx].title = data.title;
    index[idx].author = data.author || '示例校园校园墙编辑部';
    if (index[idx].published === undefined) index[idx].published = false;
    storiesSaveIndex(index, novelId);
  }
}

function storiesAddChapter(title, content, author, novelId) {
  var index = storiesGetIndex(novelId);
  var dir = getNovelDir(novelId);
  if (!fs_stories.existsSync(dir)) fs_stories.mkdirSync(dir, { recursive: true });
  var nextFile = index.length + '.json';
  fs_stories.writeFileSync(path_stories.join(dir, nextFile), JSON.stringify({ title: title, content: content || '', author: author || '示例校园校园墙编辑部' }, null, 2), 'utf8');
  index.push({ file: nextFile, title: title, author: author || '示例校园校园墙编辑部', published: false });
  storiesSaveIndex(index, novelId);
  return index.length - 1;
}

function storiesDeleteChapter(idx, novelId) {
  var index = storiesGetIndex(novelId);
  var dir = getNovelDir(novelId);
  if (idx >= 0 && idx < index.length) {
    try { fs_stories.unlinkSync(path_stories.join(dir, index[idx].file)); } catch(e) {}
    index.splice(idx, 1);
    storiesSaveIndex(index, novelId);
  }
  return index;
}

// ===== 小说 CRUD 路由 =====

// 获取小说列表
router.get('/novels', requirePermission('stories:review'), async (req, res) => {
  try {
    var list = novelsGetList();
    var pubConfig = loadPubConfig();
    res.json({ code: 200, data: { novels: list, activeNovelId: pubConfig.activeNovelId || 'default' } });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 创建新小说
router.post('/novels/create', requirePermission('stories:review'), async (req, res) => {
  try {
    var { title, author, desc } = req.body;
    if (!title) return res.json({ code: 400, message: '小说标题不能为空' });
    var list = novelsGetList();
    var id = 'novel_' + Date.now();
    list.push({ id: id, title: title, author: author || '示例校园校园墙编辑部', desc: desc || '', createdAt: new Date().toISOString().substring(0, 10) });
    novelsSaveList(list);
    // 初始化该小说的目录和配置
    var dir = getNovelDir(id);
    if (!fs_stories.existsSync(dir)) fs_stories.mkdirSync(dir, { recursive: true });
    var pubConfig = loadPubConfig();
    if (!pubConfig.novels) pubConfig.novels = {};
    pubConfig.novels[id] = { currentStoryIndex: 0, promptConfig: { novelTitle: title } };
    fs_stories.writeFileSync(path_stories.join(__dirname, '..', 'config', 'auto-publish.json'), JSON.stringify(pubConfig, null, 2), 'utf8');
    res.json({ code: 200, data: { id: id }, message: '小说「' + title + '」创建成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 删除小说
router.post('/novels/delete', requirePermission('stories:review'), async (req, res) => {
  try {
    var { novelId } = req.body;
    var list = novelsGetList();
    var idx = -1;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === novelId) { idx = i; break; }
    }
    if (idx < 0) return res.json({ code: 400, message: '小说不存在' });
    if (list.length <= 1) return res.json({ code: 400, message: '至少保留一本小说' });
    // 删除章节目录
    var dir = getNovelDir(novelId);
    try {
      var chapIdx = JSON.parse(fs_stories.readFileSync(path_stories.join(dir, 'index.json'), 'utf8') || '[]');
      chapIdx.forEach(function(entry) {
        try { fs_stories.unlinkSync(path_stories.join(dir, entry.file)); } catch(e) {}
      });
      try { fs_stories.unlinkSync(path_stories.join(dir, 'index.json')); } catch(e) {}
      try { fs_stories.rmdirSync(dir); } catch(e) {}
    } catch(e) {}
    list.splice(idx, 1);
    novelsSaveList(list);
    // 清理配置
    var pubConfig = loadPubConfig();
    if (pubConfig.novels && pubConfig.novels[novelId]) {
      delete pubConfig.novels[novelId];
    }
    if (pubConfig.activeNovelId === novelId) {
      pubConfig.activeNovelId = list[0].id;
    }
    fs_stories.writeFileSync(path_stories.join(__dirname, '..', 'config', 'auto-publish.json'), JSON.stringify(pubConfig, null, 2), 'utf8');
    res.json({ code: 200, message: '已删除' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 设置当前活跃小说
router.post('/novels/set-active', requirePermission('stories:review'), async (req, res) => {
  try {
    var { novelId } = req.body;
    var novel = novelsGetById(novelId);
    if (!novel) return res.json({ code: 400, message: '小说不存在' });
    var pubConfig = loadPubConfig();
    pubConfig.activeNovelId = novelId;
    fs_stories.writeFileSync(path_stories.join(__dirname, '..', 'config', 'auto-publish.json'), JSON.stringify(pubConfig, null, 2), 'utf8');
    res.json({ code: 200, message: '已切换到「' + novel.title + '」' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ===== 章节路由（支持多小说，通过 query 或 body 传递 novelId）=====

function getNovelId(req) {
  return req.query.novelId || req.body.novelId || '';
}

// 获取所有章节（不含内容）和配置信息
router.get('/stories', requirePermission('stories:review'), async (req, res) => {
  try {
    var novelId = getNovelId(req) || loadPubConfig().activeNovelId || 'default';
    var index = storiesGetIndex(novelId);
    var pubConfig = loadPubConfig();
    var novelCfg = getNovelPubConfig(pubConfig, novelId);
    res.json({
      code: 200,
      data: {
        stories: index,
        currentIndex: novelCfg.currentStoryIndex || 0,
        totalChapters: index.length,
        promptConfig: novelCfg.promptConfig || {}
      }
    });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取单章内容
router.get('/stories/chapter-content', requirePermission('stories:review'), async (req, res) => {
  try {
    var novelId = getNovelId(req) || loadPubConfig().activeNovelId || 'default';
    var idx = parseInt(req.query.index);
    var chapter = storiesGetChapter(idx, novelId);
    if (chapter) {
      res.json({ code: 200, data: chapter });
    } else {
      res.json({ code: 404, message: '章节不存在' });
    }
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 保存章节
router.post('/stories/save', requirePermission('stories:review'), async (req, res) => {
  try {
    var { index, title, content, author, novelId } = req.body;
    novelId = novelId || loadPubConfig().activeNovelId || 'default';
    storiesSaveChapter(index, { title: title, content: content, author: author }, novelId);
    res.json({ code: 200, message: '保存成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 添加新章节
router.post('/stories/add', requirePermission('stories:review'), async (req, res) => {
  try {
    var { title, content, author, novelId } = req.body;
    novelId = novelId || loadPubConfig().activeNovelId || 'default';
    var newIdx = storiesAddChapter(title || '新章节', content, author, novelId);
    res.json({ code: 200, message: '添加成功', data: { index: newIdx } });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 删除章节
router.post('/stories/delete', requirePermission('stories:review'), async (req, res) => {
  try {
    var { index, novelId } = req.body;
    novelId = novelId || loadPubConfig().activeNovelId || 'default';
    var pubConfig = loadPubConfig();
    var novelCfg = getNovelPubConfig(pubConfig, novelId);
    var resultIndex = storiesDeleteChapter(index, novelId);
    // 如果删除的是当前或之前的章节，调整索引
    if (novelCfg.currentStoryIndex >= index && novelCfg.currentStoryIndex > 0) {
      novelCfg.currentStoryIndex = novelCfg.currentStoryIndex - 1;
      if (novelCfg.currentStoryIndex >= resultIndex.length) novelCfg.currentStoryIndex = 0;
      saveNovelPubConfig(pubConfig, novelId, { currentStoryIndex: novelCfg.currentStoryIndex });
    }
    res.json({ code: 200, message: '删除成功', data: { stories: resultIndex, currentIndex: novelCfg.currentStoryIndex || 0 } });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 设置当前连载章节索引
router.post('/stories/set-current', requirePermission('stories:review'), async (req, res) => {
  try {
    var { index, novelId } = req.body;
    novelId = novelId || loadPubConfig().activeNovelId || 'default';
    var pubConfig = loadPubConfig();
    saveNovelPubConfig(pubConfig, novelId, { currentStoryIndex: index });
    res.json({ code: 200, message: '已设置为第' + (index + 1) + '章' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 保存提示词模板配置
router.post('/stories/save-prompt-config', requirePermission('stories:review'), async (req, res) => {
  try {
    var { promptConfig, novelId } = req.body;
    novelId = novelId || loadPubConfig().activeNovelId || 'default';
    var pubConfig = loadPubConfig();
    saveNovelPubConfig(pubConfig, novelId, { promptConfig: promptConfig });
    res.json({ code: 200, message: '提示词模板已保存' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// 获取下一个 DeepSeek 提示词
router.get('/stories/next-prompt', requirePermission('stories:review'), async (req, res) => {
  try {
    var novelId = getNovelId(req) || loadPubConfig().activeNovelId || 'default';
    var index = storiesGetIndex(novelId);
    var pubConfig = loadPubConfig();
    var novelCfg = getNovelPubConfig(pubConfig, novelId);
    var cfg = novelCfg.promptConfig || {};
    var nextChapNum = index.length + 1;
    
    // 构建已有章节梗概
    var summaryLines = [];
    for (var si = 0; si < index.length; si++) {
      var chap = storiesGetChapter(si, novelId);
      var contentPreview = chap ? (chap.content || '').replace(/[\n\r]+/g, ' ').substring(0, 80) : '';
      summaryLines.push((si + 1) + '. ' + (index[si].title || '') + '：' + contentPreview + '...');
    }
    var chapterSummary = summaryLines.join('\n');
    
    var novelTitle = cfg.novelTitle || (novelsGetById(novelId) ? novelsGetById(novelId).title : '致那个夏天的你');
    var promptLines = [
      cfg.authorRole || '你是一位校园青春小说作家兼编辑：重视人物动机、情绪真实和前后设定一致，文字清新但不堆砌辞藻。',
      '',
      '请写一篇校园青春小说的第' + nextChapNum + '章，继续以下故事：',
      '小说标题：' + novelTitle,
      '',
      '已有章节梗概：'
    ];
    promptLines.push(chapterSummary);
    promptLines.push('');
    promptLines.push('');
    promptLines.push('第' + nextChapNum + '章要求：');
    promptLines.push('- 字数：' + (cfg.wordCount || '800-1200字'));
    promptLines.push('- 风格：' + (cfg.style || '温暖治愈，校园青春'));
    promptLines.push('- ' + (cfg.sceneRequirement || '需要出现1-2个新的校园场景'));
    promptLines.push('- ' + (cfg.endingRequirement || '在章节末尾留下悬念或期待'));
    promptLines.push('- ' + (cfg.titleFormat || '标题自拟（格式如"第X章 标题"）'));
    promptLines.push('- ' + (cfg.dialogueFormat || '注意：章节内容使用中文引号「」或""表示对话'));
    if (cfg.extraRequirements) {
      promptLines.push('- ' + cfg.extraRequirements);
    }
    promptLines.push('');
    promptLines.push(cfg.outputInstruction || '请直接输出章节正文，不要输出提纲、分析、思考过程、免责声明或“以下是”等套话。');
    
    res.json({ code: 200, data: { prompt: promptLines.join('\n'), nextChapterNum: nextChapNum } });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

// ===== AI 自动生成章节 =====
router.post('/stories/generate-chapter', requirePermission('stories:review'), async (req, res) => {
  try {
    var novelId = getNovelId(req) || loadPubConfig().activeNovelId || 'default';
    var index = storiesGetIndex(novelId);
    var pubConfig = loadPubConfig();
    var novelCfg = getNovelPubConfig(pubConfig, novelId);
    var cfg = novelCfg.promptConfig || {};
    var nextChapNum = index.length + 1;

    // 构建已有章节梗概
    var summaryLines = [];
    for (var si = 0; si < index.length; si++) {
      var chap = storiesGetChapter(si, novelId);
      var contentPreview = chap ? (chap.content || '').replace(/[\n\r]+/g, ' ').substring(0, 150) : '';
      summaryLines.push('第' + (si + 1) + '章《' + (index[si].title || '') + '》：' + contentPreview + '...');
    }
    var chapterSummary = summaryLines.join('\n');

    var novelTitle = cfg.novelTitle || (novelsGetById(novelId) ? novelsGetById(novelId).title : '致那个夏天的你');
    var aiPrompt = '';
    aiPrompt += '你是一位校园青春小说作家兼编辑，擅长描写青春期细腻的情感变化。请保持人物动机清楚、情绪真实克制、场景具体、前后设定一致，避免空泛抒情和重复表达。\n\n';
    aiPrompt += '请写一篇校园青春小说的第' + nextChapNum + '章。\n';
    aiPrompt += '小说标题：' + novelTitle + '\n\n';
    if (chapterSummary) {
      aiPrompt += '已有章节梗概：\n' + chapterSummary + '\n\n';
    }
    aiPrompt += '第' + nextChapNum + '章要求：\n';
    aiPrompt += '- 字数：' + (cfg.wordCount || '800-1200字') + '\n';
    aiPrompt += '- 风格：' + (cfg.style || '温暖治愈，校园青春') + '\n';
    aiPrompt += '- ' + (cfg.sceneRequirement || '需要出现1-2个新的校园场景') + '\n';
    aiPrompt += '- ' + (cfg.endingRequirement || '在章节末尾留下悬念或期待') + '\n';
    aiPrompt += '- 标题自拟\n';
    aiPrompt += '- 请注意使用中文引号「」或""表示对话\n';
    if (cfg.extraRequirements) {
      aiPrompt += '- ' + cfg.extraRequirements + '\n';
    }
    aiPrompt += '\n请直接输出章节正文，不要输出提纲、分析、思考过程、免责声明或“以下是”等套话。';

    var generatedContent = await aiService.generateChapter(aiPrompt);
    if (!generatedContent || generatedContent.length < 50) {
      return res.json({ code: 500, message: '生成内容过短，请重试' });
    }

    var lines = generatedContent.split('\n');
    var aiTitle = '';
    var aiContent = generatedContent;
    
    if (lines.length > 0) {
      var firstLine = lines[0].replace(/^#+\s*/, '').replace(/^第\d+章[：\s]*/, '').trim();
      if (firstLine.length > 0 && firstLine.length < 30) {
        aiTitle = firstLine;
        aiContent = lines.slice(1).join('\n').trim();
      }
    }
    if (!aiTitle) aiTitle = '第' + nextChapNum + '章';

    res.json({
      code: 200,
      data: {
        title: aiTitle,
        content: aiContent,
        chapterNum: nextChapNum
      }
    });
  } catch (err) {
    console.error('[Admin] AI生成失败:', err.message);
    res.json({ code: 500, message: 'AI生成失败，请稍后重试' });
  }
});

// ===== AI 流式生成章节（SSE） =====
router.get('/stories/generate-chapter-stream', requirePermission('stories:review'), async (req, res) => {
  try {
    var novelId = req.query.novelId || loadPubConfig().activeNovelId || getNovelId(req) || 'default';
    var index = storiesGetIndex(novelId);
    var pubConfig = loadPubConfig();
    var novelCfg = getNovelPubConfig(pubConfig, novelId);
    var cfg = novelCfg.promptConfig || {};
    var nextChapNum = index.length + 1;

    var summaryLines = [];
    for (var si = 0; si < index.length; si++) {
      var chap = storiesGetChapter(si, novelId);
      var contentPreview = chap ? (chap.content || '').replace(/[\n\r]+/g, ' ').substring(0, 150) : '';
      summaryLines.push('第' + (si + 1) + '章《' + (index[si].title || '') + '》：' + contentPreview + '...');
    }
    var chapterSummary = summaryLines.join('\n');
    var novelTitle = cfg.novelTitle || (novelsGetById(novelId) ? novelsGetById(novelId).title : '致那个夏天的你');

    var aiPrompt = '';
    aiPrompt += '你是一位校园青春小说作家兼编辑，擅长描写青春期细腻的情感变化。请保持人物动机清楚、情绪真实克制、场景具体、前后设定一致，避免空泛抒情和重复表达。\n\n';
    aiPrompt += '请写一篇校园青春小说的第' + nextChapNum + '章。\n';
    aiPrompt += '小说标题：' + novelTitle + '\n\n';
    if (chapterSummary) {
      aiPrompt += '已有章节梗概：\n' + chapterSummary + '\n\n';
    }
    aiPrompt += '第' + nextChapNum + '章要求：\n';
    aiPrompt += '- 字数：' + (cfg.wordCount || '800-1200字') + '\n';
    aiPrompt += '- 风格：' + (cfg.style || '温暖治愈，校园青春') + '\n';
    aiPrompt += '- ' + (cfg.sceneRequirement || '需要出现1-2个新的校园场景') + '\n';
    aiPrompt += '- ' + (cfg.endingRequirement || '在章节末尾留下悬念或期待') + '\n';
    aiPrompt += '- 标题自拟\n';
    aiPrompt += '- 请注意使用中文引号「」或""表示对话\n';
    if (cfg.extraRequirements) {
      aiPrompt += '- ' + cfg.extraRequirements + '\n';
    }
    aiPrompt += '\n请直接输出章节正文，不要输出提纲、分析、思考过程、免责声明或“以下是”等套话。';

    // SSE 头
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });

    var fullText = '';

    var aiService = require('../services/ai');
    var pingTimer = setInterval(function() { res.write(': ping\n\n'); }, 25000);
    await aiService.generateChapterStream(aiPrompt, function(token) {
      fullText += token;
      // 发送 token（避免换行破坏 SSE）
      var safe = token.replace(/\n/g, '\\n').replace(/\r/g, '');
      res.write('data: ' + safe + '\n\n');
    });
    clearInterval(pingTimer);

    // 生成完毕
    var lines = fullText.split('\n');
    var aiTitle = '';
    var aiContent = fullText;
    if (lines.length > 0) {
      var firstLine = lines[0].replace(/^#+\s*/, '').replace(/^第\d+章[：\s]*/, '').trim();
      if (firstLine.length > 0 && firstLine.length < 30) {
        aiTitle = firstLine;
        aiContent = lines.slice(1).join('\n').trim();
      }
    }
    if (!aiTitle) aiTitle = '第' + nextChapNum + '章';

    // 发送完成事件
    res.write('event: done\ndata: ' + JSON.stringify({ title: aiTitle, content: aiContent, chapterNum: nextChapNum }) + '\n\n');
    res.end();
  } catch (err) {
    console.error('[SSE] 生成错误:', err.message);
    if (!res.headersSent) {
      res.writeHead(500);
    }
    res.write('event: error\ndata: AI生成失败，请稍后重试\n\n');
    res.end();
  }
});

const { escapeHtml } = require('../services/html-utils');

async function uploadStoryImages(htmlContent) {
  var imgRegex = /<img[^>]+src=["']([^"']+)["']/g;
  var match;
  var tasks = [];
  while ((match = imgRegex.exec(htmlContent)) !== null) {
    var originalSrc = match[1];
    if (originalSrc.indexOf('mmbiz.qpic.cn') >= 0 || originalSrc.indexOf('mmbiz.qlogo.cn') >= 0 || originalSrc.startsWith('data:')) continue;
    var uploadUrl = originalSrc.startsWith('/') ? SITE_URL + originalSrc : originalSrc;
    tasks.push({ original: originalSrc, upload: uploadUrl });
  }
  if (tasks.length === 0) return htmlContent;
  for (var i = 0; i < tasks.length; i++) {
    try {
      var weixinUrl = await mpDraftService.uploadMpImage(tasks[i].upload);
      if (weixinUrl) htmlContent = htmlContent.split(tasks[i].original).join(weixinUrl);
    } catch (e) { console.warn('[故事推送] 图片上传失败:', e.message); }
  }
  return htmlContent;
}

router.post('/stories/publish-to-wechat', requirePermission('stories:review'), async (req, res) => {
  try {
    var { chapterIndex, novelId } = req.body;
    novelId = novelId || loadPubConfig().activeNovelId || 'default';
    var novel = novelsGetById(novelId);
    var novelTitle = novel ? novel.title : '小说连载';
    var index = storiesGetIndex(novelId);
    if (index.length === 0) return res.json({ code: 400, message: '故事库为空' });
    if (chapterIndex === undefined || chapterIndex < 0 || chapterIndex >= index.length) {
      return res.json({ code: 400, message: '无效的章节索引' });
    }
    
    var chapter = storiesGetChapter(chapterIndex, novelId);
    if (!chapter) return res.json({ code: 400, message: '章节内容不存在' });
    
    var [weather, hitokoto, dateInfo] = await Promise.all([
      mpDraftService.getWeather(),
      mpDraftService.getHitokoto(),
      Promise.resolve(mpDraftService.getDateInfo())
    ]);
    
    var chapNum = chapterIndex + 1;
    var chapTotal = index.length;
    var today = dateInfo.date;
    var week = dateInfo.week;
    var paragraphs = (chapter.content || '').replace(/\r\n/g, '\n').split(/\n\n+/);
    
    var storyHtml = '';
    storyHtml += '<div style="padding:6px 0;">';
    
    // ===== 头部 =====
    storyHtml += '<table width="100%" cellpadding="0" cellspacing="0"><tr><td style="background:linear-gradient(135deg,#FFF0F5,#F8F0FF);padding:22px 16px 18px;text-align:center;">';
    storyHtml += '<div style="color:#A78BFA;font-size:13px;margin-bottom:6px;letter-spacing:2px;">📖 校园小说连载 · 第' + chapNum + '/' + chapTotal + '章</div>';
    storyHtml += '<div style="color:#FF69B4;font-size:22px;font-weight:bold;letter-spacing:1px;">第' + chapNum + '章 ' + escapeHtml(chapter.title) + '</div>';
    storyHtml += '<div style="color:#bbb;font-size:12px;margin-top:8px;">' + today + ' ' + week + ' · ' + escapeHtml(chapter.author || '匿名投稿') + '</div>';
    storyHtml += '<div style="width:40px;height:3px;background:linear-gradient(90deg,#FFB6C1,#A78BFA);margin:14px auto 0;"></div>';
    storyHtml += '</td></tr></table>';
    
    // ===== 阅读信息 =====
    var totalChars = (chapter.content || '').replace(/\s/g, '').length;
    var readMinutes = Math.max(1, Math.ceil(totalChars / 300));
    storyHtml += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;"><tr><td style="background:#FFFFF0;padding:12px;border-radius:10px;">';
    storyHtml += '<table width="100%" cellpadding="0" cellspacing="0"><tr>';
    storyHtml += '<td style="text-align:center;width:33%;padding:4px;border-right:1px dashed #E8D5B5;">';
    storyHtml += '<div style="font-size:11px;color:#bbb;margin-bottom:2px;">📝 全文字数</div>';
    storyHtml += '<div style="font-size:16px;font-weight:bold;color:#D4876A;">' + totalChars.toLocaleString() + ' 字</div>';
    storyHtml += '</td>';
    storyHtml += '<td style="text-align:center;width:33%;padding:4px;border-right:1px dashed #E8D5B5;">';
    storyHtml += '<div style="font-size:11px;color:#bbb;margin-bottom:2px;">⏱ 阅读时长</div>';
    storyHtml += '<div style="font-size:16px;font-weight:bold;color:#D4876A;">约 ' + readMinutes + ' 分钟</div>';
    storyHtml += '</td>';
    storyHtml += '<td style="text-align:center;width:33%;padding:4px;">';
    storyHtml += '<div style="font-size:11px;color:#bbb;margin-bottom:2px;">📚 连载进度</div>';
    storyHtml += '<div style="font-size:16px;font-weight:bold;color:#D4876A;">第' + chapNum + '/' + chapTotal + '章</div>';
    storyHtml += '</td>';
    storyHtml += '</tr></table></td></tr></table>';
    
    // ===== 天气 =====
    if (weather && weather.temperature) {
      storyHtml += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;"><tr><td style="background:linear-gradient(135deg,#E8F4FD,#E0F0FF);padding:16px;">';
      storyHtml += '<div style="font-size:13px;color:#888;margin-bottom:10px;font-weight:500;">🌤️ ' + (weather.city || '') + ' 天气预报</div>';
      storyHtml += '<table width="100%" cellpadding="0" cellspacing="0"><tr>';
      storyHtml += '<td style="width:50%;text-align:center;padding:4px;border-right:1px dashed #B0D4F1;">';
      storyHtml += '<div style="font-size:11px;color:#aaa;margin-bottom:4px;">今日</div>';
      storyHtml += '<div style="font-size:20px;font-weight:bold;color:#4A90D9;">' + (weather.icon || '🌤') + ' ' + (weather.temperature || '') + '</div>';
      storyHtml += '<div style="font-size:12px;color:#666;margin-top:2px;">' + (weather.weather || '') + '</div>';
      storyHtml += '<div style="font-size:11px;color:#999;margin-top:4px;">💨 ' + (weather.wind || '') + ' 💧 ' + (weather.humidity || '') + '</div>';
      storyHtml += '</td>';
      if (weather.tomorrow) {
        storyHtml += '<td style="width:50%;text-align:center;padding:4px;">';
        storyHtml += '<div style="font-size:11px;color:#aaa;margin-bottom:4px;">' + (weather.tomorrow.week || '周五') + '</div>';
        storyHtml += '<div style="font-size:20px;font-weight:bold;color:#4A90D9;">' + (weather.tomorrow.icon || '☀️') + ' ' + (weather.tomorrow.tempRange || '') + '</div>';
        storyHtml += '<div style="font-size:12px;color:#666;margin-top:2px;">' + (weather.tomorrow.weather || '') + '</div>';
        storyHtml += '<div style="font-size:11px;color:#999;margin-top:4px;">📍 预报</div>';
        storyHtml += '</td>';
      } else {
        storyHtml += '<td style="width:50%;text-align:center;padding:4px;color:#ccc;font-size:13px;">🌤️ 暂无预报</td>';
      }
      storyHtml += '</tr></table></td></tr></table>';
    }
    
    // ===== 一言 =====
    if (hitokoto && hitokoto.text) {
      storyHtml += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;"><tr><td style="background:#FFF9F5;padding:16px;border-left:3px solid #A78BFA;">';
      storyHtml += '<p style="font-size:14px;color:#888;margin:0 0 6px 0;line-height:1.8;font-style:italic;">💬 "' + escapeHtml(hitokoto.text) + '"</p>';
      storyHtml += '<p style="text-align:right;color:#ccc;font-size:12px;margin:0;">—— ' + escapeHtml(hitokoto.from_who || hitokoto.from || '') + '</p></td></tr></table>';
    }
    
    // ===== 分割线 =====
    storyHtml += '<div style="text-align:center;margin:18px 0;color:#e8e8e8;font-size:14px;">❀&nbsp;&nbsp;❁&nbsp;&nbsp;❀</div>';
    
    // ===== 小说正文 =====
    storyHtml += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:18px;"><tr><td style="background:#FFFBFF;padding:20px 16px;">';
    storyHtml += '<div style="text-align:center;margin-bottom:20px;">';
    storyHtml += '<div style="display:inline-block;background:linear-gradient(135deg,#FFF0F5,#F8F0FF);padding:6px 20px;border-radius:20px;font-size:12px;color:#A78BFA;letter-spacing:1px;">第' + chapNum + '章</div>';
    storyHtml += '</div>';
    for (var pi = 0; pi < paragraphs.length; pi++) {
      var para = paragraphs[pi].trim();
      if (!para) continue;
      var isDialogue = para.includes('"') || para.includes('"') || para.includes('"');
      if (isDialogue) {
        storyHtml += '<p style="text-indent:2em;line-height:2.1;margin-bottom:14px;font-size:15px;color:#6B4C3B;margin-top:0;letter-spacing:0.5px;background:#FFFBF8;padding:8px 14px;border-radius:8px;border-left:3px solid #FFD4B8;">' + escapeHtml(para) + '</p>';
      } else {
        storyHtml += '<p style="text-indent:2em;line-height:2.1;margin-bottom:14px;font-size:15px;color:#444;margin-top:0;letter-spacing:0.5px;">' + escapeHtml(para) + '</p>';
      }
    }
    if (chapNum < chapTotal) {
      storyHtml += '<div style="text-align:center;margin:24px 0 10px 0;">';
      storyHtml += '<div style="display:inline-block;background:#FFF0F5;padding:8px 24px;border-radius:12px;font-size:13px;color:#FF69B4;">🌟 未完待续 · 同一时间见</div>';
      storyHtml += '</div>';
      storyHtml += '<div style="text-align:center;font-size:12px;color:#ccc;margin-top:6px;">📖 第' + (chapNum + 1) + '/' + chapTotal + '章 敬请期待</div>';
    }
    storyHtml += '</td></tr></table>';
    
    // ===== 引流语 =====
    storyHtml += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;"><tr><td style="background:#FFF8F0;padding:16px;border-radius:12px;">';
    storyHtml += '<div style="font-size:13px;color:#D4876A;line-height:1.8;text-align:center;">';
    storyHtml += '❤️ 校园故事持续征集中<br>';
    storyHtml += '墙墙准备了一篇暖心小说，希望你喜欢 ❤️<br><br>';
    storyHtml += '🎨 如果你也有故事，<strong style="color:#FF6B9D;">欢迎分享给身边的同学哦</strong><br>';
    storyHtml += '📮 想说的，去 <strong style="color:#FF6B9D;">http://localhost:3000</strong> 投稿吧！<br>';
    storyHtml += '你的每一个故事，都有可能成为下篇文章的主角 ❤️';
    storyHtml += '</div></td></tr></table>';
    
    // ===== 底部二维码 =====
    storyHtml += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;"><tr><td style="background:linear-gradient(135deg,#FFF0F5,#FFE4E1);padding:24px 20px;text-align:center;border-radius:16px;">';
    storyHtml += '<div style="font-size:18px;color:#FF69B4;font-weight:bold;margin-bottom:6px;">🌸 校园故事站</div>';
    storyHtml += '<div style="font-size:13px;color:#DDA0DD;margin-bottom:16px;">扫码关注 · 分享身边的美好</div>';
    storyHtml += '<table align="center" style="margin:0 auto;"><tr><td style="background:linear-gradient(135deg,#FF69B4,#FFB6C1);padding:4px;border-radius:16px;">';
    storyHtml += '<table style="width:100%;background:#fff;border-radius:12px;"><tr><td style="padding:12px;">';
    storyHtml += '<img src="http://localhost:3000/images/gzh.jpg" style="width:200px;display:block;border-radius:6px;margin:0 auto;height:auto;" alt="校园墙二维码">';
    storyHtml += '</td></tr></table>';
    storyHtml += '</td></tr></table>';
    storyHtml += '<p style="color:#bbb;font-size:12px;margin:14px 0 4px 0;letter-spacing:1px;">📱 微信扫一扫 · 获取更多精彩</p>';
    storyHtml += '<p style="color:#FF69B4;font-size:13px;font-weight:bold;word-break:break-all;letter-spacing:0.5px;">http://localhost:3000</p>';
    storyHtml += '<div style="width:40px;height:2px;background:#FFB6C1;margin:12px auto 0;border-radius:2px;"></div>';
    storyHtml += '</td></tr></table>';
    storyHtml += '<p style="text-align:center;color:#ddd;font-size:12px;margin-top:18px;">❀ ' + dateInfo.year + ' 示例校园校园墙 ❀ ❀</p>';
    storyHtml += '</div>';
    
    storyHtml = await uploadStoryImages(storyHtml);
    
    var article = {
      title: '小说连载 · 第' + chapNum + '章 ' + chapter.title + ' | ' + dateInfo.date,
      author: 'ExampleAdmin',
      digest: '小说连载 · ' + novelTitle + ' · ' + chapter.title + '。' + (chapter.content || '').replace(/[\n\r]+/g, '').substring(0, 60) + '...',
      content: storyHtml,
      content_source_url: 'http://localhost:3000',
      show_cover_pic: 1,
      need_open_comment: 1,
      only_fans_can_comment: 0
    };
    
    var mediaId = await mpDraftService.createDraft([article]);
    
    // 标记为已发布
    var idx = storiesGetIndex(novelId);
    if (chapterIndex >= 0 && chapterIndex < idx.length) {
      idx[chapterIndex].published = true;
      storiesSaveIndex(idx, novelId);
    }
    
    res.json({ code: 200, data: { media_id: mediaId }, message: '✅ 已同步到公众号草稿箱' });
  } catch (err) {
    console.error('[故事推送] 失败:', err.message);
    res.json({ code: 500, message: '推送失败，请稍后重试' });
  }
});

// ===== IP归属地查询 =====
router.post('/lookup-ip', auth, isStaff, async (req, res) => {
  try {
    const { ip } = req.body;
    if (!ip) return res.json({ code: 400, message: '请提供IP地址' });
    const region = await getIpRegion(ip.replace(/^::ffff:/, ''));
    res.json({ code: 200, data: { region: region || ip } });
  } catch (err) {
    console.error('[Admin] IP查询失败:', err.message);
    res.json({ code: 500, message: '查询失败，请稍后重试' });
  }
});

// ===== 签到/积分运营数据 =====
router.get('/gamification', superAdminOnly, async (req, res) => {
  try {
    var today = new Date().toISOString().slice(0, 10);
    var [todayCheckins] = await pool.execute('SELECT COUNT(*) as total FROM checkins WHERE checkin_date = ?', [today]);
    var [totalCheckins] = await pool.execute('SELECT COUNT(*) as total FROM checkins');
    var [activeUsers] = await pool.execute('SELECT COUNT(DISTINCT user_id) as total FROM checkins WHERE checkin_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)');
    var [topPoints] = await pool.execute('SELECT u.id, u.nickname, u.username, u.avatar, u.points FROM users u WHERE u.points > 0 ORDER BY u.points DESC LIMIT 10');
    var [topStreak] = await pool.execute('SELECT c.user_id, u.nickname, u.username, MAX(c.streak) as max_streak FROM checkins c JOIN users u ON c.user_id = u.id GROUP BY c.user_id ORDER BY max_streak DESC LIMIT 10');
    var weeklyStar = null;
    try {
      var [ws] = await pool.execute(
        "SELECT utr.user_id, u.nickname, u.username, ut.title_name FROM user_title_relations utr JOIN users u ON utr.user_id = u.id JOIN user_titles ut ON utr.title_id = ut.id WHERE ut.title_name = '本周之星🏆' LIMIT 1"
      );
      if (ws.length > 0) weeklyStar = ws[0];
    } catch (e) {}

    res.json({
      code: 200,
      data: {
        today_checkins: todayCheckins[0].total,
        total_checkins: totalCheckins[0].total,
        active_users_7d: activeUsers[0].total,
        top_points: topPoints,
        top_streak: topStreak,
        weekly_star: weeklyStar
      }
    });
  } catch (err) {
    console.error('[Admin] 获取运营数据失败:', err.message);
    res.json({ code: 500, message: '查询失败' });
  }
});

// ===== 积分管理（手动发放/扣除）=====
router.post('/points', superAdminOnly, async (req, res) => {
  try {
    var { user_id, points, reason } = req.body;
    if (!user_id || points === undefined) {
      return res.json({ code: 400, message: '缺少 user_id 或 points' });
    }
    points = parseInt(points);
    if (isNaN(points) || points === 0) {
      return res.json({ code: 400, message: '积分值无效' });
    }
    if (Math.abs(points) > 1000) {
      return res.json({ code: 400, message: '单次操作不能超过 1000 积分' });
    }
    var result = await adjustUserPoints(user_id, points, reason);
    res.json({ code: 200, message: (points > 0 ? '发放' : '扣除') + '成功', data: result });
  } catch (err) {
    if (err.code === 'USER_NOT_FOUND' || err.code === 'INSUFFICIENT_POINTS') {
      return res.json({ code: 400, message: err.message });
    }
    console.error('[Admin] 积分操作失败:', err.message);
    res.json({ code: 500, message: '操作失败，请稍后重试' });
  }
});

// 获取用户积分日志
router.get('/points', superAdminOnly, async (req, res) => {
  try {
    var userId = parseInt(req.query.user_id) || null;
    var pointsPagination = getPagination(req.query, { defaultLimit: 20, maxLimit: 100 });
    var limit = pointsPagination.limit;
    var page = pointsPagination.page;
    var offset = pointsPagination.offset;

    if (userId) {
      var [logs] = await pool.execute(
        'SELECT pl.*, u.nickname, u.username FROM points_log pl JOIN users u ON pl.user_id = u.id WHERE pl.user_id = ? ORDER BY pl.created_at DESC LIMIT ? OFFSET ?',
        [userId, limit, offset]
      );
      var [total] = await pool.execute('SELECT COUNT(*) as total FROM points_log WHERE user_id = ?', [userId]);
      var [user] = await pool.execute('SELECT id, nickname, username, points FROM users WHERE id = ?', [userId]);
      return res.json({
        code: 200,
        data: { logs: logs, total: total[0].total, user: user[0] || null }
      });
    }

    var [logs] = await pool.execute(
      'SELECT pl.*, u.nickname, u.username FROM points_log pl JOIN users u ON pl.user_id = u.id ORDER BY pl.created_at DESC LIMIT ? OFFSET ?',
      [limit, offset]
    );
    var [total] = await pool.execute('SELECT COUNT(*) as total FROM points_log');
    res.json({ code: 200, data: { logs: logs, total: total[0].total } });
  } catch (err) {
    console.error('[Admin] 查询积分日志失败:', err.message);
    res.json({ code: 500, message: '查询失败' });
  }
});

// 清理积分日志
router.delete('/points/cleanup', superAdminOnly, async (req, res) => {
  try {
    var days = Math.max(parseInt(req.query.days) || 7, 1);
    var [result] = await pool.execute(
      'DELETE FROM points_log WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
      [days]
    );
    res.json({ code: 200, message: `已删除 ${days} 天前的积分记录`, data: { deleted: result.affectedRows } });
  } catch (err) {
    console.error('[Admin] 清理积分日志失败:', err.message);
    res.json({ code: 500, message: '清理失败' });
  }
});

// ─── 称号管理（颁发/候选人预览）────────────────────────────
const TITLE_CONFIG = {
  weekly_star:  { name: '本周之星🏆', color: '#FF6B9D', bg: 'rgba(255,107,157,0.15)', icon: '🏆', points: 10, reason: 'weekly_star' },
  checkin_star: { name: '签到之星⭐', color: '#16a34a', bg: 'rgba(22,163,74,0.15)', icon: '⭐', points: 8, reason: 'checkin_star' },
  popular_star: { name: '人气之星🔥', color: '#f59e0b', bg: 'rgba(245,158,11,0.15)', icon: '🔥', points: 8, reason: 'popular_star' }
};

// 获取候选人列表
router.get('/award-title/candidates', superAdminOnly, async (req, res) => {
  try {
    const { type } = req.query;
    if (!type || !TITLE_CONFIG[type]) {
      return res.json({ code: 400, message: '无效的称号类型' });
    }
    var oneWeekAgo = new Date(); oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
    var since = oneWeekAgo.toISOString().slice(0, 19).replace('T', ' ');
    var candidates = [];

    if (type === 'weekly_star') {
      [candidates] = await pool.execute(`
        SELECT p.id, p.user_id, u.nickname, u.username, u.avatar,
               p.likes_count, p.title as post_title, p.content
        FROM posts p JOIN users u ON p.user_id = u.id
        WHERE p.created_at >= ? AND p.is_deleted = 0 AND p.status = 'approved'
        ORDER BY p.likes_count DESC LIMIT 10
      `, [since]);
      candidates = candidates.map(c => ({
        user_id: c.user_id, nickname: c.nickname, username: c.username, avatar: c.avatar,
        score: c.likes_count, desc: '👍 ' + c.likes_count + ' 赞 · ' + (c.post_title || c.content?.slice(0,30) || '无标题')
      }));
    } else if (type === 'checkin_star') {
      [candidates] = await pool.execute(`
        SELECT c.user_id, u.nickname, u.username, u.avatar, COUNT(*) as cnt
        FROM checkins c JOIN users u ON c.user_id = u.id
        WHERE c.checkin_date >= ? AND u.role != 'banned'
        GROUP BY c.user_id ORDER BY cnt DESC LIMIT 10
      `, [since.slice(0,10)]);
      candidates = candidates.map(c => ({
        user_id: c.user_id, nickname: c.nickname, username: c.username, avatar: c.avatar,
        score: c.cnt, desc: '📅 签到 ' + c.cnt + ' 天'
      }));
    } else if (type === 'popular_star') {
      [candidates] = await pool.execute(`
        SELECT p.user_id, u.nickname, u.username, u.avatar, SUM(p.likes_count) as total_likes
        FROM posts p JOIN users u ON p.user_id = u.id
        WHERE p.created_at >= ? AND p.is_deleted = 0 AND p.status = 'approved'
        GROUP BY p.user_id ORDER BY total_likes DESC LIMIT 10
      `, [since]);
      candidates = candidates.map(c => ({
        user_id: c.user_id, nickname: c.nickname, username: c.username, avatar: c.avatar,
        score: c.total_likes, desc: '👍 收到 ' + c.total_likes + ' 赞'
      }));
    }

    res.json({ code: 200, data: candidates });
  } catch (err) {
    console.error('[Admin] 获取候选人失败:', err.message);
    res.json({ code: 500, message: '获取失败' });
  }
});

// 颁发称号
router.post('/award-title', superAdminOnly, async (req, res) => {
  try {
    const { type, user_id } = req.body;
    if (!type || !user_id) {
      return res.json({ code: 400, message: '缺少参数' });
    }

    // 自定义称号
    var titleConfig;
    if (type === 'custom') {
      var customName = req.body.title_name;
      if (!customName || customName.length > 30) {
        return res.json({ code: 400, message: '请输入有效的称号名称（最多30字）' });
      }
      titleConfig = { name: customName, color: '#8b5cf6', bg: 'rgba(139,92,246,0.15)', icon: '🎖️', points: 5, reason: 'custom_title' };
    } else {
      titleConfig = TITLE_CONFIG[type];
      if (!titleConfig) return res.json({ code: 400, message: '无效的称号类型' });
    }

    var targetId = parseInt(user_id);
    var result = await awardTitle(targetId, type, titleConfig);
    res.json({
      code: 200,
      message: '✅ 已颁发「' + result.title_name + '」给 ' + result.nickname,
      data: result
    });
  } catch (err) {
    if (err.code === 'USER_NOT_FOUND') {
      return res.json({ code: 400, message: err.message });
    }
    console.error('[Admin] 颁发称号失败:', err.message);
    res.json({ code: 500, message: '操作失败' });
  }
});

module.exports = router;
