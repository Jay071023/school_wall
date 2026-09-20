'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function readRoute(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'routes', name), 'utf8');
}

function readFrontend(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', name), 'utf8');
}

function readPublic(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'public', 'js', name), 'utf8');
}

function readService(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'services', name), 'utf8');
}

function readPage(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', 'frontend', relativePath), 'utf8');
}

const songs = readRoute('songs.js');
const slotsGet = songs.slice(songs.indexOf("router.get('/slots'"), songs.indexOf("router.post('/',"));
assert(slotsGet.includes('await ensureFutureDates(pool)'), 'GET /slots 必须先幂等补齐未来日期，避免首次打开点歌页没有可预约日期');
assert(!/\b(?:UPDATE|INSERT|DELETE)\b/i.test(slotsGet), 'GET /slots 不应直接包含写入 SQL');
assert(songs.includes('getChinaDate(14)'), '点歌日期窗口应使用中国业务日期');
assert(!songs.includes('CURDATE()'), '点歌路由不应依赖数据库服务器时区');
assert(songs.includes('startFutureDatesMaintenance(pool);'), '点歌路由应在后台启动日期维护');
assert(songs.includes('FUTURE_DATES_REFRESH_MS'), '日期维护成功后应持续定时刷新');
assert(songs.includes('FUTURE_DATES_RETRY_MS'), '日期维护失败后应使用重试间隔');
assert(songs.includes('futureDatesTimer.unref()'), '日期维护定时器应 unref');
assert(songs.includes('markDueApprovedSongsAsPlayed') && songs.includes('startAutoPlaybackMaintenance()'), '点歌应在后台自动维护已播放状态');
assert(songs.includes("sr.status = 'approved'") && songs.includes('ts.end_time <= ?'), '自动播放标记必须只处理已审核且时段已结束的歌曲');
assert(songs.includes("status = 'played'") && songs.includes('notifySongPlayed'), '自动播放标记后应更新状态并通知点歌人');
const songSubmit = songs.slice(songs.indexOf("router.post('/', auth"), songs.indexOf("router.get('/list'"));
assert(songSubmit.includes('notifyRadioAdminsNewSongPending') && songSubmit.includes('pendingReviewNotice'), '点歌提交成功后应异步提醒广播管理员审核');
assert(songSubmit.indexOf('await connection.commit()') < songSubmit.indexOf('notifyRadioAdminsNewSongPending(pendingReviewNotice)'), '广播管理员邮件必须在点歌事务提交后发送');
const emailService = readService('email.js');
assert(emailService.includes('async function notifyRadioAdminsNewSongPending(song)') && emailService.includes('role IN ("radio_admin", "super_admin") AND email IS NOT NULL AND email != ""'), '待审核点歌邮件只能发送给开启通知的广播管理员和最高管理员');
assert(emailService.includes('song_pending_admin_notify') && emailService.includes("songPendingAdminEmailHtml(song || {}, songAdminUrl)") && emailService.includes("songInfoCard({ songName: p.songName, artist: p.artist, userNickname: p.requesterName }, '点歌人')") && emailService.includes("songScheduleCard(schedule, '同学希望的播放时间'") && emailService.includes("'打开点歌管理'") && emailService.includes('return songEmailLayout('), '待审核点歌邮件必须包含审核链接、预约时段和点歌人');
assert(songs.includes('return true;') && songs.includes('return false;'), '日期维护应向调度器报告成功或失败');
assert(songs.includes('beginTransaction()') && songs.includes('FOR UPDATE'), '点歌写入应在事务中锁定业务行');
assert(songs.includes("CONVERT_TZ(?, '+08:00', @@session.time_zone)"), '点歌每日限制应按中国日期转换时间边界');
assert(songs.includes('LIMIT ? OFFSET ?'), '点歌列表应使用受限分页参数');
const songsList = songs.slice(songs.indexOf("router.get('/list'"), songs.indexOf("// 获取当前用户的点歌记录"));
assert(songsList.includes('WHERE sr.deleted_at IS NULL AND sr.status IN ("approved","played")'), '点歌列表必须排除软删除记录并保留状态筛选');
assert(songsList.includes("'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate'"), '点歌列表响应必须禁止缓存');
assert(songsList.includes("'Pragma': 'no-cache'") && songsList.includes("'Expires': '0'"), '点歌列表响应应提供旧客户端兼容的防缓存头');

const frontendHome = readFrontend('home.js');
const publicHome = readPublic('home.js');
const playlistFetchStart = frontendHome.indexOf("fetch('/api/songs/list'");
const playlistFetchEnd = frontendHome.indexOf('});', playlistFetchStart);
assert(playlistFetchStart >= 0 && playlistFetchEnd > playlistFetchStart, '首页应请求点歌列表接口');
assert(frontendHome.slice(playlistFetchStart, playlistFetchEnd).includes("cache: 'no-store'"), '首页点歌列表请求必须使用 no-store');
assert(frontendHome.includes("!song.deleted_at"), '首页渲染必须再次排除软删除歌曲');
assert(!frontendHome.includes('mode-520') && !frontendHome.includes('520飘落'), '首页不得保留旧 520 动画逻辑');
assert.strictEqual(frontendHome, publicHome, 'frontend/js/home.js 与 public/js/home.js 必须保持一致');

const frontendRadio = readFrontend('radio.js');
const publicRadio = readPublic('radio.js');
assert(frontendRadio.includes("!song.deleted_at"), '点歌页渲染必须再次排除软删除歌曲');
assert.strictEqual(frontendRadio, publicRadio, 'frontend/js/radio.js 与 public/js/radio.js 必须保持一致');

const reservations = readRoute('reservations.js');
assert(reservations.includes('userReservedMap.has(key)'), '预约状态应使用 Set.has 查询');
assert(reservations.includes("/^\\d{4}-\\d{2}-\\d{2}$/"), '预约日期应严格校验为 YYYY-MM-DD');
assert(reservations.includes('ER_DUP_ENTRY'), '预约应安全处理数据库唯一约束冲突');
assert(reservations.includes('beginTransaction()') && reservations.includes('FOR UPDATE'), '预约写入应在事务中锁定时段行');
assert(reservations.includes('status != "cancelled"'), '取消预约应使用原子状态条件');
assert(reservations.includes('LIMIT ? OFFSET ?'), '我的预约应使用受限分页参数');
assert(reservations.includes("CONVERT_TZ(CONCAT(sr.reservation_date"), '预约关联点歌应按中国业务日期边界匹配');

const site = readRoute('site.js');
assert(site.includes('weatherRequest'), '天气请求应合并并发缓存未命中请求');
assert(site.includes('LIMIT 50000'), 'Sitemap 查询应有标准数量边界');
assert(site.includes('config_key IN (${placeholders})'), '站点设置查询应限制在公开配置键');
assert(site.includes("'festival_theme', 'festival_enabled', 'special_mode_520'"), '公开设置白名单应包含节日主题和新开关');
assert(site.includes('festival_mode: festivalEnabled'), '公开接口应由新节日开关计算节日模式');
assert(site.includes('festival_theme: festivalTheme'), '公开接口应返回规范化后的节日主题');
assert(site.includes("FESTIVAL_THEMES = new Set(['teachers_day', '520'])"), '公开接口应只暴露教师节和 520 节日预设');
assert(site.includes("if (value === 'back_to_school') return 'teachers_day'"), '旧开学季值应兼容归一化为教师节');
assert(site.includes('function invalidateSiteInfoCache()') && site.includes('router.invalidateSiteInfoCache = invalidateSiteInfoCache'), '站点设置更新后应提供缓存失效入口');
assert(!site.includes('smtp_host') && !site.includes('smtp_pass'), '公开站点设置不得包含 SMTP 私密字段');
assert(!site.includes('res.json({ code: 500, message: err.message'), '站点接口不应向客户端回传内部错误信息');
assert(!site.includes("router.get('/release-notes'"), '更新记录不得通过站点公开接口提供');

const releaseNotes = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'release-notes.json'), 'utf8'));
assert(Array.isArray(releaseNotes) && releaseNotes.length > 0, '发布记录文件必须至少保留一条管理员可见更新');
releaseNotes.forEach((note) => {
  assert(note && typeof note.id === 'string' && /^\d{4}-\d{2}-\d{2}/.test(note.id), '发布记录必须有日期化 ID');
  assert(/^\d{4}-\d{2}-\d{2}$/.test(note.published_at || ''), '发布记录必须有发布日期');
  assert(typeof note.title === 'string' && note.title.trim(), '发布记录必须有标题');
  assert(typeof note.summary === 'string' && note.summary.trim(), '发布记录必须有简短摘要');
  assert(Array.isArray(note.changes) && note.changes.length > 0, '发布记录必须列出用户可感知的变更');
});

const admin = readRoute('admin.js');
const authMiddleware = fs.readFileSync(path.join(__dirname, '..', 'middleware', 'auth.js'), 'utf8');
const checkin = readRoute('checkin.js');
const usersList = admin.slice(
  admin.indexOf("router.get('/users'"),
  admin.indexOf("// 修改用户状态")
);
assert(usersList.includes("const { search = '', keyword = '', role = '' } = req.query"), '用户列表接口应接收角色筛选参数');
assert(usersList.includes("const validRoles = ['user', 'reviewer', 'radio_admin', 'admin', 'super_admin']"), '用户列表角色筛选必须覆盖所有既有角色');
assert(usersList.includes("conditions.push('role = ?')") && usersList.includes('params.push(roleFilter)'), '用户列表角色筛选必须传给 SQL 参数');
assert(usersList.includes('username LIKE ? OR nickname LIKE ? OR email LIKE ?'), '用户关键词筛选应覆盖用户名、昵称和邮箱');
assert(usersList.includes('LIMIT ? OFFSET ?') && usersList.includes('SELECT COUNT(*) as total FROM users WHERE ${whereClause}'), '用户筛选分页与总数统计必须使用同一筛选条件');
const slotsUpdate = admin.slice(
  admin.indexOf("router.put('/slots/:id'"),
  admin.indexOf("router.delete('/slots/:id'")
);
assert(!slotsUpdate.includes('debugInfo') && !slotsUpdate.includes('debug:'), '时段修改成功响应不得包含调试字段');
assert(!slotsUpdate.includes('[DEBUG]') && !/console\.log\([^\n]*(?:weekday|SQL|affected)/i.test(slotsUpdate), '时段接口不得输出 weekday、SQL 或影响行调试信息');
assert(slotsUpdate.includes("res.json({ code: 200, message: '修改成功' })"), '时段修改成功响应应保留');
const settings = admin.slice(
  admin.indexOf("router.get('/settings'"),
  admin.indexOf("router.post('/test-email'")
);
assert(settings.includes('festival_theme'), '后台系统设置应支持 festival_theme');
assert(settings.includes('festival_enabled'), '后台系统设置应使用 festival_enabled 开关');
assert(admin.includes('siteRouter.invalidateSiteInfoCache()'), '保存后台设置后应清理公开站点设置缓存');
assert(admin.includes("router.get('/song-reject-reasons', requirePermission('songs:review')") && admin.includes("router.put('/song-reject-reasons', requirePermission('songs:review')"), '打回理由预设应由点歌审核权限维护，而非系统设置权限');
assert(admin.includes("router.get('/songs/:id', requirePermission('songs:review')"), '广播管理员应可查看点歌详情与预约播放时间');
assert(authMiddleware.includes("reviewer: ['posts:review']"), '审核员只能保留帖子管理权限');
assert(authMiddleware.includes("radio_admin: ['songs:review', 'songs:delete', 'slots:manage', 'stats:view']"), '广播管理员应只保留点歌、时段和数据概览权限');
assert(authMiddleware.includes("admin: ['posts:review', 'posts:delete', 'songs:review', 'songs:delete', 'slots:manage', 'users:view', 'users:status', 'notices:manage', 'feedbacks:manage']"), '管理员权限必须限定为日常运营菜单');
assert(admin.includes("router.get('/gamification', superAdminOnly") && admin.includes("router.post('/points', superAdminOnly") && admin.includes("router.get('/messages', superAdminOnly"), '积分运营和私信管理接口必须仅允许最高管理员');
assert(checkin.includes("router.post('/weekly-star', auth, superAdminOnly"), '本周之星发放必须仅允许最高管理员');
assert(!settings.includes("console.log('[Settings]"), '系统设置接口不得输出无意义调试日志');
const emailRoutes = admin.slice(
  admin.indexOf("router.get('/email/recipients'"),
  admin.indexOf('// ===== 微信测试 =====')
);
assert(!emailRoutes.includes('console.log('), '邮件接口不得输出无意义调试日志');
assert(!/console\.error\([^\n;]*,\s*err\s*\)/.test(emailRoutes), '邮件接口错误日志不得输出完整错误对象');

const songsRoute = readRoute('songs.js');
const songVoteRoute = songsRoute.slice(
  songsRoute.indexOf("router.post('/vote'"),
  songsRoute.indexOf("router.post('/admin/update-score'")
);
assert(songVoteRoute.includes('beginTransaction()') && songVoteRoute.includes('FOR UPDATE'), '歌曲热度投票必须在事务中锁定歌曲，避免并发覆盖分数');
assert(songVoteRoute.includes('connection.commit()') && songVoteRoute.includes('connection.rollback()'), '歌曲热度投票必须完整提交或回滚');

const commentLikeRoute = readRoute('posts.js').slice(
  readRoute('posts.js').indexOf("router.post('/comments/:commentId/like'"),
  readRoute('posts.js').indexOf("router.get('/:postId/comments/:commentId/replies'")
);
assert(commentLikeRoute.includes('beginTransaction()') && commentLikeRoute.includes('FOR UPDATE'), '评论点赞切换必须串行化并保持点赞记录与计数一致');
const replyLikeRoute = readRoute('posts.js').slice(
  readRoute('posts.js').indexOf("router.post('/:postId/comments/:commentId/replies/:replyId/like'"),
  readRoute('posts.js').indexOf('// 点赞/取消点赞防抖')
);
assert(replyLikeRoute.includes('beginTransaction()') && replyLikeRoute.includes('FOR UPDATE'), '回复点赞切换必须串行化并保持点赞记录与计数一致');
const postViewRoute = readRoute('posts.js').slice(
  readRoute('posts.js').indexOf("router.post('/:id/view'"),
  readRoute('posts.js').indexOf("router.get('/:id/views'")
);
assert(postViewRoute.includes('beginTransaction()') && postViewRoute.includes('FOR UPDATE'), '浏览记录去重与计数更新必须在同一事务中完成');
assert(postViewRoute.indexOf('INSERT INTO post_views') < postViewRoute.indexOf('UPDATE posts SET view_count'), '浏览记录应先写入，再在同一事务中增加计数');

const database = fs.readFileSync(path.join(__dirname, '..', 'config', 'database.js'), 'utf8');
assert(database.includes('CREATE TABLE IF NOT EXISTS song_votes'), '启动迁移必须创建歌曲投票表');
assert(database.includes('CREATE TABLE IF NOT EXISTS poll_options') && database.includes('CREATE TABLE IF NOT EXISTS poll_votes'), '启动迁移必须创建帖子投票选项与记录表');
assert(database.includes("['poll_type'") && database.includes("['poll_expires_at'"), '启动迁移必须补齐帖子投票字段');

const auth = readRoute('auth.js');
const notifySettings = auth.slice(
  auth.indexOf("router.get('/notify-settings'"),
  auth.indexOf('// ===== 密码重置')
);
assert(notifySettings.includes("console.error('获取通知偏好失败:', err && (err.code || err.message || 'unknown error'))"), '获取通知偏好异常日志应仅记录错误代码或消息');
assert(notifySettings.includes("console.error('保存通知偏好失败:', err && (err.code || err.message || 'unknown error'))"), '保存通知偏好异常日志应仅记录错误代码或消息');
assert(!/console\.(?:log|error|warn)\([^\n;]*\berr\s*\)/.test(notifySettings), '通知偏好日志不应输出完整错误对象');
assert(!/console\.(?:log|error|warn)\([^\n;]*(?:body\[field\]|updates|values|req\.body|Content-Type|Body)/i.test(notifySettings), '通知偏好日志不应输出请求体、用户设置值或请求元数据');
assert(notifySettings.includes("var allowedFields = ["), '通知偏好字段白名单应保留');
assert(notifySettings.includes("'INSERT IGNORE INTO user_notify_settings (user_id) VALUES (?)'"), '通知偏好首次保存写库逻辑应保留');
assert(notifySettings.includes("'UPDATE user_notify_settings SET ' + updates.join(', ') + ' WHERE user_id = ?'"), '通知偏好增量更新写库逻辑应保留');
assert(notifySettings.includes("res.json({ code: 200, message: '保存成功' })"), '通知偏好成功响应应保留');
assert(notifySettings.includes("res.json({ code: 500, message: '服务器错误' })"), '通知偏好异常响应应保留');

const adminPage = readPage('admin/index.html');
const adminCss = readPage('admin/css/admin.css');
assert(adminPage.includes('<tbody id="posts-tbody">') && adminPage.includes('<td colspan="8">'), '帖子管理空状态应覆盖实际八列');
assert(adminPage.includes('<tbody id="users-tbody">') && adminPage.includes('<td colspan="9">'), '用户管理空状态应覆盖实际九列');
assert(adminPage.includes('id="users-role-filter"') && adminPage.includes('value="radio_admin"'), '用户管理应提供广播管理员等身份筛选选项');
assert(adminPage.includes('function changeUsersRoleFilter(role)') && adminPage.includes("params.append('role', usersRoleFilter)"), '用户身份筛选应重置分页并传给后台接口');
assert(adminPage.includes('<tbody id="daily-songs-tbody">') && adminPage.includes('<td colspan="3" class="admin-empty">'), '每日推歌空状态应覆盖实际三列');
assert(adminPage.includes('name="festival_theme" value="520"'), '后台节日主题应保留 520 选项');
assert(adminPage.includes('_themeSavePending') && adminPage.includes('主题已保存'), '后台主题选择应显示保存结果并在选中后收起选项');
assert(adminPage.includes('id="song-reject-library"') && adminPage.includes('打回理由预设'), '打回理由预设应放在点歌管理面板内');
assert(!adminPage.includes('id="setting-song-reject-reasons"'), '系统设置页不应再保留打回理由文本框');
assert(adminPage.includes("authFetch('/api/admin/song-reject-reasons')") && adminPage.includes('renderSongRejectReasonEditor'), '点歌管理应加载并编辑打回理由预设');
assert(adminCss.includes('点歌管理组件：唯一结构规则') && /grid-template-areas:\r?\n\s+"name name"/.test(adminCss), '后台点歌管理在移动端应使用分层卡片布局');
assert(adminPage.includes('推歌候选曲库') && adminPage.includes('多首歌曲在这里整理'), '推歌候选页应明确用于多首歌曲整理');
assert(adminPage.includes('待在公众号页统一推送') && !adminPage.includes('title="去公众号推送页"'), '候选页不得提供单曲推送按钮，应统一到公众号推送页处理');
assert(adminPage.includes('data-panel="daily-songs"') && adminPage.includes('data-super-admin-only="true"') && adminPage.includes('data-title="推歌候选"'), '推歌候选菜单必须标记为最高管理员专属');
assert(adminPage.includes('href="/admin/mp-draft"') && adminPage.includes('data-super-admin-only="true"') && adminPage.includes('data-title="公众号推送"'), '公众号推送入口必须标记为最高管理员专属');
assert(adminPage.includes('data-panel="messages" data-super-admin-only="true"') && adminPage.includes('href="/admin/gamification.html" class="sidebar-link" data-super-admin-only="true"'), '私信管理和积分运营入口必须仅对最高管理员显示');
assert(adminPage.includes("const menuLinks = document.querySelectorAll('.sidebar-link[data-permission], .sidebar-link[data-super-admin-only]')"), '后台菜单权限检查必须覆盖最高管理员专属入口');
assert(admin.includes("router.get('/daily-songs', superAdminOnly") && admin.includes("router.post('/daily-songs', superAdminOnly"), '每日推歌查询和添加接口必须仅允许最高管理员');
assert(admin.includes("router.delete('/daily-songs', superAdminOnly") && admin.includes("router.put('/daily-songs/:id/intro', superAdminOnly"), '每日推歌删除和编辑接口必须仅允许最高管理员');
assert(!adminPage.includes("console.error('[后台JS错误]'"), '后台全局错误捕获不得向控制台输出错误对象');
assert(adminPage.includes('公众号图文与草稿箱') && adminPage.includes('href="/admin/mp-draft"'), '日志页公众号入口必须跳转到真实推送工作台');
assert(!admin.includes("'/trigger-auto-publish'") && !admin.includes("execSync('/usr/bin/node"), '后台不得保留调用不存在脚本的伪自动发布接口');
assert(!adminPage.includes('每天定时生成公众号图文') && !adminPage.includes('function savePubConfig()'), '后台不得继续展示没有调度器的自动发布开关');

const mpDraftPage = readPage('admin/mp-draft.html');
assert(!mpDraftPage.includes('body前200字') && !mpDraftPage.includes("console.error('[apiFetch]"), '公众号请求不得向控制台输出 URL 或响应正文');
assert(mpDraftPage.includes('data-tab="daily" data-super-admin-only="true"') && mpDraftPage.includes('function applyDailySongPermissions'), '公众号页的推歌入口必须仅对最高管理员显示');
assert(mpDraftPage.includes("res.data.role !== 'super_admin'") && mpDraftPage.includes("canManageDailySongs = res.data.role === 'super_admin'") && mpDraftPage.includes("name === 'daily' && !canManageDailySongs"), '公众号页必须只允许最高管理员进入并按角色保护推歌页签');
const adminRoute = readRoute('admin.js');
const mpDraftRoute = readRoute('mp-draft.js');
assert(mpDraftRoute.includes("const { auth, isStaff, superAdminOnly, requirePermission }") && mpDraftRoute.includes('router.use(auth, isStaff, superAdminOnly)') && mpDraftRoute.includes("router.get('/daily-songs', superAdminOnly"), '公众号推送及每日推歌接口必须仅允许最高管理员读取');
assert(mpDraftRoute.includes("router.get('/weekly-song-schedule', superAdminOnly") && mpDraftRoute.includes('仅超级管理员可同步每日推歌'), '公众号点歌排期和每日推歌同步必须仅允许最高管理员');
assert(mpDraftRoute.includes("const canPushDailySongs = req.user && req.user.role === 'super_admin'") && mpDraftRoute.includes('includeDailySongs'), '普通广播推送员生成普通图文时不得注入每日推歌');
const releaseNotesService = readService('release-notes.js');
assert(adminRoute.includes("router.get('/deployment-status', requirePermission('settings:view')"), '部署状态只能通过管理后台权限接口读取');
assert(adminPage.includes('id="deployment-state"') && adminPage.includes("authFetch('/api/admin/deployment-status?ts='"), '系统设置应展示并刷新线上部署状态');
assert(adminRoute.includes("router.get('/release-notes', requirePermission('settings:view')"), '更新记录只能通过后台设置权限接口读取');
assert(!adminRoute.includes("router.put('/release-notes'") && !adminRoute.includes("router.post('/release-notes'"), '更新记录接口不得提供后台编辑能力');
assert(releaseNotesService.includes('normalizeReleaseNote') && releaseNotesService.includes('MAX_RELEASE_NOTES'), '更新记录必须经过统一字段校验和数量限制');
assert(adminPage.includes('id="admin-release-notes"') && adminPage.includes("authFetch('/api/admin/release-notes?ts='"), '系统设置应展示并读取管理员更新记录');
assert(adminPage.includes('changeItem.textContent = change'), '后台更新记录必须按文本节点渲染');
assert(!adminPage.includes('release-note-modal') && !adminPage.includes('homeReleaseNotes'), '更新说明不得作为后台编辑页或首页入口存在');
assert(!frontendHome.includes("fetch('/api/release-notes'") && !frontendHome.includes('renderHomeReleaseNotes'), '首页不得请求或渲染更新记录');
assert(!readPage('index.html').includes('id="homeReleaseNotes"'), '首页不得保留更新入口');

const homePage = readPage('index.html');
assert(homePage.includes('festival-theme-ready'), '首页应等待主题就绪事件后再显示');
assert(!homePage.includes('window.addEventListener("load", release'), '首页不得在主题准备前由 window.load 提前放行');
assert(!homePage.includes('app-booting::after'), '首页不得显示独立的粉色加载圈');

const publicPageNames = [
  '404.html', 'agreement.html', 'edit-post.html', 'edit-profile.html', 'feedback.html', 'index.html',
  'login.html', 'messages.html', 'new-post.html', 'post-detail.html', 'privacy.html', 'profile.html',
  'radio.html', 'register.html', 'reset-password.html'
];
publicPageNames.forEach((pageName) => {
  const page = readPage(pageName);
  assert(page.includes('/js/theme-mode.js'), `${pageName} 应加载统一节日主题脚本`);
  assert(!page.includes('id="theme-520-css"') && !page.includes('href="/css/520.css"'), `${pageName} 不得继续加载旧 520 样式`);
  assert(page.includes('festival-theme-ready'), `${pageName} 应等待主题就绪后再显示`);
  assert(!page.includes('window.addEventListener("load", release'), `${pageName} 不得在主题准备前提前放行`);
  assert(!page.includes('app-booting::after'), `${pageName} 不得显示旧粉色加载圈`);
});
const themeMode = readFrontend('theme-mode.js');
assert(themeMode.includes('theme-festival-520-css') && themeMode.includes('mode-festival-520'), '统一主题脚本应加载并应用 520 预设');
assert(themeMode.includes('function ensureStylesheet') && !themeMode.includes('link.disabled = true;\n    document.head.appendChild(link);'), '主题样式应在主题确定后再创建，避免 disabled 动态样式表导致前台回退');
assert(themeMode.includes('} else if (state.fiveTwenty && loaded) {') && themeMode.includes('} else if (state.teacher || state.fiveTwenty) {'), '教师节与 520 主题成功加载后不得误走失败回退分支');
assert(!readFrontend('app.js').includes("classList.contains('mode-520')"), '全局主题色逻辑不得继续依赖旧 520 模式');

console.log('[route-stability] 通过：日期、GET 纯读、事务边界、并发预约、分页、错误信息和通知偏好日志隐私静态检查');
