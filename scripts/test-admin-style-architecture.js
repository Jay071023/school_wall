'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const frontendPath = path.join(__dirname, '..', 'frontend', 'admin', 'index.html');
const publicPath = path.join(__dirname, '..', 'public', 'admin', 'index.html');
const frontendCssPath = path.join(__dirname, '..', 'frontend', 'admin', 'css', 'admin.css');
const publicCssPath = path.join(__dirname, '..', 'public', 'admin', 'css', 'admin.css');
const globalCssPath = path.join(__dirname, '..', 'frontend', 'css', 'style.css');
const frontend = fs.readFileSync(frontendPath, 'utf8');
const publicMirror = fs.readFileSync(publicPath, 'utf8');
const frontendCss = fs.readFileSync(frontendCssPath, 'utf8');
const publicCss = fs.readFileSync(publicCssPath, 'utf8');
const globalCss = fs.readFileSync(globalCssPath, 'utf8');

assert.strictEqual(frontend, publicMirror, '后台管理页的 frontend/public 镜像必须完全一致');
assert.strictEqual(frontendCss, publicCss, '后台 CSS 的 frontend/public 镜像必须完全一致');
assert.ok(frontend.includes('href="/admin/css/admin.css"'), '后台必须加载唯一的专属样式入口');
assert.strictEqual((frontend.match(/<style\b/g) || []).length, 0, '后台 HTML 不得再保留静态 style 标签');
assert.strictEqual((frontendCss.match(/点歌管理组件：唯一结构规则/g) || []).length, 1, '点歌管理只能有一个组件结构入口');
assert.ok(frontendCss.includes('--song-pending:') && frontendCss.includes('--song-approved:'), '点歌状态颜色必须由同一组语义 token 提供');
assert.ok(frontendCss.includes('#panel-songs .table-actions-compact .action-approve'), '桌面与移动端必须共用同一通过按钮状态类');
assert.ok(frontendCss.includes('--admin-page-bg:') && frontendCss.includes('--admin-action-primary:'), '后台必须提供独立语义主题 token');
assert.ok(frontendCss.includes('[data-admin-theme="violet"] body.admin-page'), '新增后台主题必须只通过语义 token 映射');
assert.ok(frontend.includes('window.setAdminThemeVariant') && frontend.includes('admin-theme-variant'), '后台必须保留可扩展主题切换入口');
assert.ok(frontendCss.includes('--admin-z-drawer-backdrop:') && frontendCss.includes('var(--admin-z-modal)'), '后台抽屉、弹窗和 toast 必须通过统一层级 token 定位');
assert.ok(frontendCss.includes('body.admin-page .admin-sidebar.sidebar-open') && frontendCss.includes('sidebar-open 作为唯一抽屉状态'), '移动端抽屉必须与脚本的 sidebar-open 状态类保持一致');
assert.ok(frontend.includes("window.matchMedia('(max-width: 768px)').matches") && frontend.includes("if (!isMobileDrawerViewport()) return;"), '抽屉脚本只能在移动断点打开，不能在缩放后的桌面单独打开遮罩');
assert.ok(frontendCss.includes('body.admin-page .sidebar-overlay.show') && frontendCss.includes('抽屉遮罩没有桌面语义'), '桌面端即使遗留遮罩状态也必须强制隐藏，避免全屏阴影');
assert.ok(frontendCss.includes('--admin-sidebar-header-bg: linear-gradient') && frontendCss.includes('Mobile: profile-card visual system'), '后台浅色侧栏与移动端必须使用统一的柔和卡片视觉系统');
assert.ok(frontendCss.includes('#panel-songs .admin-table-wrapper') && frontendCss.includes('max-height: none !important;'), '点歌移动列表不得继承桌面表格的固定最大高度');
assert.ok(frontendCss.includes('body.admin-page .admin-topbar .bell-badge') && frontendCss.includes('var(--admin-surface-raised)'), '通知数字必须使用可随亮暗主题切换的语义色');
assert.ok(frontendCss.includes('--admin-sidebar-header-bg:') && frontendCss.includes('var(--admin-sidebar-header-text) !important'), '侧栏标题区必须使用独立的高对比主题 token');
assert.ok(frontend.includes('class="stories-toolbar"') && frontendCss.includes('#panel-stories .stories-toolbar'), '连载小说工具栏必须有独立结构，不能继续依赖内联彩色按钮');
assert.ok(frontendCss.includes('#panel-stories .admin-table-wrapper') && frontendCss.includes('max-height: none !important;'), '连载小说移动端外层不得截断章节或编辑内容');
assert.ok(frontendCss.includes('@media (min-width: 769px)') && frontendCss.includes('width: calc(100% - 260px);') && frontendCss.includes('box-sizing: border-box;'), '桌面主内容必须扣除固定侧栏宽度，不能以 100% 宽度叠加 margin-left');
assert.ok(frontendCss.includes('@media (max-width: 768px)') && frontendCss.includes('#panel-songs .songs-table tbody tr'), '点歌移动端规则必须明确限定在 768px 及以下');
assert.ok(frontendCss.includes('/* ===== 后台壳层 =====') && frontendCss.includes('body.admin-page .admin-sidebar'), '后台壳层必须由后台专属 CSS 唯一维护');
assert.ok(!globalCss.includes('.admin-layout {') && !globalCss.includes('.admin-sidebar {') && !globalCss.includes('.admin-topbar {'), '全站样式不得再维护后台壳层，避免加载顺序决定布局');
assert.ok(frontendCss.includes('padding: 0 !important;') && frontendCss.includes('padding-left: 36px !important;'), '点歌移动卡片必须清除桌面单元格内边距，避免复选框遮住歌名');
assert.ok(!frontend.includes('style.cssText') && !frontend.includes('<style>'), '运行时浮层不得再注入样式字符串');
assert.ok(!/migrated:|mobile-[\w-]*final|layout-v2/.test(frontendCss), '后台样式不得保留历史 final/v2 覆盖块标记');

console.log('[admin-style-architecture] 通过：后台样式入口、主题 token、点歌组件与镜像边界均已锁定');
