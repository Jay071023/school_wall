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
assert(!slotsGet.includes('ensureFutureDates'), 'GET /slots 不应触发日期维护任务');
assert(!/\b(?:UPDATE|INSERT|DELETE)\b/i.test(slotsGet), 'GET /slots 不应包含写入 SQL');
assert(songs.includes('getChinaDate(14)'), '点歌日期窗口应使用中国业务日期');
assert(!songs.includes('CURDATE()'), '点歌路由不应依赖数据库服务器时区');
assert(songs.includes('startFutureDatesMaintenance(pool);'), '点歌路由应在后台启动日期维护');
assert(songs.includes('FUTURE_DATES_REFRESH_MS'), '日期维护成功后应持续定时刷新');
assert(songs.includes('FUTURE_DATES_RETRY_MS'), '日期维护失败后应使用重试间隔');
assert(songs.includes('futureDatesTimer.unref()'), '日期维护定时器应 unref');
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
assert(!settings.includes("console.log('[Settings]"), '系统设置接口不得输出无意义调试日志');
const emailRoutes = admin.slice(
  admin.indexOf("router.get('/email/recipients'"),
  admin.indexOf('// ===== 微信测试 =====')
);
assert(!emailRoutes.includes('console.log('), '邮件接口不得输出无意义调试日志');
assert(!/console\.error\([^\n;]*,\s*err\s*\)/.test(emailRoutes), '邮件接口错误日志不得输出完整错误对象');

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
assert(adminPage.includes('<tbody id="posts-tbody">') && adminPage.includes('<td colspan="8">'), '帖子管理空状态应覆盖实际八列');
assert(adminPage.includes('<tbody id="users-tbody">') && adminPage.includes('<td colspan="9">'), '用户管理空状态应覆盖实际九列');
assert(adminPage.includes('<tbody id="daily-songs-tbody">') && adminPage.includes('<td colspan="3" class="admin-empty">'), '每日推歌空状态应覆盖实际三列');
assert(adminPage.includes('name="festival_theme" value="520"'), '后台节日主题应保留 520 选项');
assert(!adminPage.includes("console.error('[后台JS错误]'"), '后台全局错误捕获不得向控制台输出错误对象');

const mpDraftPage = readPage('admin/mp-draft.html');
assert(!mpDraftPage.includes('body前200字') && !mpDraftPage.includes("console.error('[apiFetch]"), '公众号请求不得向控制台输出 URL 或响应正文');
const adminRoute = readRoute('admin.js');
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
assert(!readFrontend('app.js').includes("classList.contains('mode-520')"), '全局主题色逻辑不得继续依赖旧 520 模式');

console.log('[route-stability] 通过：日期、GET 纯读、事务边界、并发预约、分页、错误信息和通知偏好日志隐私静态检查');
