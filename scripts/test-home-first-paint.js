const assert = require('assert');
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(projectRoot, relativePath), 'utf8').replace(/\r\n/g, '\n');

const frontendHome = read('frontend/index.html');
const publicHome = read('public/index.html');
const frontendHomeScript = read('frontend/js/home.js');
const publicHomeScript = read('public/js/home.js');
const frontendAppScript = read('frontend/js/app.js');
const publicAppScript = read('public/js/app.js');
const themeMode = read('frontend/js/theme-mode.js');
const serverSource = read('server.js');
const mobileFixCss = read('frontend/css/mobile-fix.css');

assert.strictEqual(frontendHome, publicHome, 'frontend/index.html 与 public/index.html 必须保持一致');
assert.strictEqual(frontendHomeScript, publicHomeScript, 'frontend/js/home.js 与 public/js/home.js 必须保持一致');
assert.strictEqual(frontendAppScript, publicAppScript, 'frontend/js/app.js 与 public/js/app.js 必须保持一致');

const bootStyleStart = frontendHome.indexOf('<style id="app-boot-style">');
const bootStyleEnd = frontendHome.indexOf('</style>', bootStyleStart);
assert(bootStyleStart >= 0 && bootStyleEnd > bootStyleStart, '首页必须包含前置 boot 样式');
const bootStyle = frontendHome.slice(bootStyleStart, bootStyleEnd);
assert(bootStyleStart < frontendHome.indexOf('<link rel="stylesheet"'), '降级样式必须先于外部 CSS');

assert(bootStyle.includes('html.app-booting body { visibility: hidden; }'), '主题就绪前必须隐藏未准备好的首页');
assert(bootStyle.includes('html.app-booting::before'), 'boot gate 必须提供独立的首屏加载反馈');
assert(bootStyle.includes('.pull-refresh-indicator'), '首页内联样式必须覆盖下拉刷新指示器');
assert(bootStyle.includes('.pull-refresh-indicator.show'), '下拉刷新显示态必须有内联样式');
assert(bootStyle.includes('.pull-refresh-indicator.refreshing .refresh-icon'), '刷新中必须有内联动画样式');
assert(bootStyle.includes('.feed-state'), '帖子加载/错误状态必须有内联容器样式');
assert(bootStyle.includes('.feed-state-retry'), '帖子失败重试按钮必须有内联样式');
assert(bootStyle.includes('overscroll-behavior-y: auto'), '首页必须保留移动端原生纵向滚动');
assert(!frontendHome.includes('media="print"') && !frontendHome.includes("onload=\"this.media='all'\""), '关键首页 CSS 不得延迟到页面加载后再二次启用');
assert(read('frontend/css/style.css').includes('body.post-detail-page .main-content {\n  width: 100%;\n  max-width: 1120px;'), '详情页基础布局必须以桌面宽度为默认结构');

assert(frontendHome.includes('class="teacher-theme-hero" aria-label="教师节主题寄语" hidden') && frontendHome.includes('class="teacher-theme-note"'), '教师节主题节点必须保留且默认隐藏');
assert(themeMode.includes("festival-theme-ready"), '首页必须等待节日主题就绪事件');
assert(themeMode.includes('THEME_HINT_KEY') && themeMode.includes('readThemeHint'), '主题首屏必须支持本地提示缓存');
assert(frontendHome.includes('hardTimeoutId') && frontendHome.includes('release(true)'), '主题接口异常时 boot gate 必须安全放行');
assert(serverSource.includes('stale-while-revalidate=86400'), '静态 CSS/JS 应使用短缓存并后台刷新');
assert(serverSource.includes('max-age=2592000, immutable'), '随机视频文件应使用长期不可变缓存');
assert(read('routes/site.js').includes('SITE_INFO_CACHE_MS'), '站点配置接口应合并并短缓存数据库请求');

assert(frontendHomeScript.includes('window.__pullToRefreshInitialized'), '下拉刷新初始化必须防止重复绑定');
assert(frontendHomeScript.includes("target.closest('a, button, input, textarea, select, [data-no-pull-refresh]')"), '交互控件触摸不得误触发下拉刷新');
assert(frontendHomeScript.includes('currentY = startY'), '每次触摸开始必须重置位移，避免复用上一次手势');
assert(frontendHomeScript.includes('if (window.innerWidth > 768 || !isPulling'), '桌面端不得处理移动端触摸刷新');
assert(frontendHomeScript.includes('loadPosts(false).then(function(success)'), '刷新必须等待帖子请求结果再反馈成功或失败');
assert(frontendHomeScript.includes('if (isLoading) {'), '首屏请求进行中时刷新必须排队');
assert(frontendHomeScript.includes("showToast(success ? '刷新成功' : '刷新失败'"), '刷新反馈必须区分成功和失败');
assert(frontendHomeScript.includes('loadCheckinStatus') && frontendHomeScript.includes('syncCheckinPlacement'), '签到状态加载与断点恢复逻辑必须保留');
assert(frontendAppScript.includes('restoreScrollIfNoBlockingLayer'), '页面滚动锁必须在弹层异常退出后自动恢复');
assert(frontendHomeScript.includes('initHomeWheelScroll'), '首页必须初始化桌面端滚轮滚动兜底');
const wheelHandler = frontendHomeScript.slice(frontendHomeScript.indexOf('function initHomeWheelScroll'), frontendHomeScript.indexOf('// 页面初始化'));
assert(!wheelHandler.includes("addEventListener('wheel'") && !wheelHandler.includes('state.frame'), '首页不得安装自定义滚轮位移，避免桌面端卡顿');
assert(mobileFixCss.includes('body.home-page #postList') && mobileFixCss.includes('touch-action: pan-y'), '移动端首页主内容和帖子必须放行纵向触摸滚动');
assert(mobileFixCss.includes('body.home-page {\n        overscroll-behavior-y: auto;'), '移动端首页不得用 overscroll contain 阻断根页面滚动');

console.log('[home-first-paint] 通过：boot gate、CSS 缺失降级样式、触摸刷新状态、主题无闪烁和签到恢复静态检查');
