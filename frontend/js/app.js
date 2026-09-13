/**
 * 示例校园墙 - 公共模块 (app.js)
 * 所有页面都引用的基础JS文件
 * 包含：API配置、认证管理、Toast提示、工具函数等
 */

// API基础地址
var API_BASE = '/api';

// 统一页面切换：只处理本站普通页面链接，不干扰表单、外链、下载和带修饰键的打开方式。
(function initPageTransitions() {
  function start() {
    var body = document.body;
    if (!body || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    body.classList.add('page-transition-enabled');
    window.addEventListener('pageshow', function() { body.classList.remove('page-leaving'); });

    document.addEventListener('click', function(event) {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      var link = event.target.closest && event.target.closest('a[href]');
      if (!link || link.target === '_blank' || link.hasAttribute('download') || link.hasAttribute('data-no-transition')) return;
      var url;
      try { url = new URL(link.href, window.location.href); } catch (e) { return; }
      var sameDocument = url.origin === window.location.origin && url.pathname === window.location.pathname && url.search === window.location.search;
      if (url.origin !== window.location.origin || sameDocument) return;
      event.preventDefault();
      body.classList.add('page-leaving');
      body.setAttribute('aria-busy', 'true');
      window.setTimeout(function() { window.location.assign(url.href); }, 150);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
}());

// 统一处理滚动行为，避免 reduced-motion 用户仍被强制平滑滚动。
function getMotionSafeScrollBehavior() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

// ===== 全局主题初始化（所有页面生效） =====
(function() {
  var saved = localStorage.getItem('theme');
  if (saved === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
})();

// ===== theme-color 动态更新（Safari/iPad 顶部栏颜色） =====
function updateThemeColor() {
  var meta = document.getElementById('themeColorMeta');
  if (!meta) return;
  var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  var is520 = document.body.classList.contains('mode-festival-520');
  var isTeacherFestival = document.body.classList.contains('mode-teacher') || document.body.classList.contains('mode-back-to-school');
  if (is520) {
    meta.setAttribute('content', isDark ? '#2D2438' : '#FF7A9A');
  } else if (isTeacherFestival) {
    meta.setAttribute('content', isDark ? '#1d2928' : '#f7f1e6');
  } else {
    meta.setAttribute('content', isDark ? '#1a1423' : '#FAFBFE');
  }
}

/**
 * 全局HTML转义函数（防止XSS攻击）
 * 所有通过 innerHTML 渲染用户数据的地方都应使用此函数
 */
function escapeHtml(text) {
  if (text == null) return '';
  var d = document.createElement('div');
  d.textContent = String(text);
  return d.innerHTML;
}

/**
 * 获取存储的token
 * 同时检查 localStorage 和 sessionStorage
 */
function getToken() {
  return localStorage.getItem('token') || sessionStorage.getItem('token');
}

/**
 * 获取当前登录用户信息
 * 同时检查 localStorage 和 sessionStorage
 */
function getCurrentUser() {
  try {
    var user = localStorage.getItem('user') || sessionStorage.getItem('user');
    return JSON.parse(user || 'null');
  } catch (e) {
    return null;
  }
}

/**
 * 保存登录信息到本地存储
 * @param {string} token - 认证token
 * @param {Object} user - 用户信息对象
 * @param {boolean} remember - 是否记住登录状态，true使用localStorage，false使用sessionStorage
 */
function saveAuth(token, user, remember) {
  var storage = remember ? localStorage : sessionStorage;
  storage.setItem('token', token);
  storage.setItem('user', JSON.stringify(user));
  updateNavbar();
}

/**
 * 退出登录，清除本地存储并跳转登录页
 * 同时清除 localStorage 和 sessionStorage
 */
function logout() {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  sessionStorage.removeItem('token');
  sessionStorage.removeItem('user');
}

/**
 * 检查用户是否已登录
 */
function isLoggedIn() {
  return !!getToken();
}

/**
 * 要求登录，未登录则跳转登录页
 */
function requireLogin() {
  if (!isLoggedIn()) {
    return false;
  }
  return true;
}

function hasHeader(headers, name) {
  if (!headers) return false;
  var target = name.toLowerCase();
  return Object.keys(headers).some(function(key) { return key.toLowerCase() === target; });
}

async function requestJson(url, options, withAuth) {
  options = options || {};
  options.headers = options.headers || {};
  if (withAuth) {
    var token = getToken();
    if (token) options.headers['Authorization'] = 'Bearer ' + token;
  }
  if (!hasHeader(options.headers, 'Content-Type') && !(options.body instanceof FormData)) {
    options.headers['Content-Type'] = 'application/json';
  }
  var requestOptions = Object.assign({}, options);
  var timeoutMs = Number.parseInt(options.timeoutMs, 10);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = 15000;
  delete requestOptions.timeoutMs;
  var controller = typeof AbortController === 'function' && !requestOptions.signal ? new AbortController() : null;
  var timeoutId = controller ? window.setTimeout(function() { controller.abort(); }, timeoutMs) : null;
  if (controller) requestOptions.signal = controller.signal;
  try {
    var res = await fetch(url, requestOptions);
    if (res.status === 401) {
      logout();
      window.location.href = '/login';
      return { code: 401, message: '请先登录' };
    }

    var contentType = res.headers.get('content-type') || '';
    var data;
    if (contentType.includes('application/json')) {
      data = await res.json();
    } else {
      var text = await res.text();
      data = { code: res.status, message: text || ('请求失败（HTTP ' + res.status + '）') };
    }
    if (!res.ok && (data.code == null || data.code === 200)) data.code = res.status;
    return data;
  } catch (e) {
    return { code: 500, message: e && e.name === 'AbortError' ? '请求超时，请稍后重试' : '网络错误，请稍后重试' };
  } finally {
    if (timeoutId) window.clearTimeout(timeoutId);
  }
}

/** 带认证的请求（自动附加 token）。 */
function authFetch(url, options) {
  return requestJson(url, options, true);
}

/** 普通请求（无需认证）。 */
function apiFetch(url, options) {
  return requestJson(url, options, false);
}

/**
 * 显示Toast提示消息
 * @param {string} message - 提示文本
 * @param {string} type - 类型：success/error/warning/info
 */
var toastCount = 0;
function showToast(message, type) {
  type = type || 'success';
  toastCount++;
  var toast = document.createElement('div');
  toast.className = 'toast toast-' + type;
  toast.textContent = message;
  toast.style.top = (20 + (toastCount - 1) * 52) + 'px';
  document.body.appendChild(toast);
  // 触发动画
  setTimeout(function() { toast.classList.add('show'); }, 10);
  // 自动消失
  setTimeout(function() {
    toast.classList.remove('show');
    toastCount = Math.max(0, toastCount - 1);
    setTimeout(function() { toast.remove(); }, 300);
  }, 3000);
}

/**
 * 将日期字符串格式化为友好的相对时间
 * @param {string} dateStr - ISO日期字符串
 * @returns {string} 格式化后的时间文本
 */
function formatTime(dateStr) {
  if (!dateStr) return '';
  var now = new Date();
  var date = new Date(dateStr);
  var diff = Math.floor((now - date) / 1000);
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + '分钟前';
  if (diff < 86400) return Math.floor(diff / 3600) + '小时前';
  if (diff < 604800) return Math.floor(diff / 86400) + '天前';
  return date.toLocaleDateString('zh-CN');
}

/**
 * 转换内容中的链接（自动识别并添加风险提示）
 * @param {string} content - 原始内容
 * @param {string} currentHost - 当前网站域名
 */
function convertContentWithLinks(content, currentHost) {
  if (!content) return '';
  // 编辑器使用轻量 Markdown 标记，先转义再渲染有限的粗体/斜体，避免把用户内容当成 HTML。
  var escaped = escapeHtml(content)
    .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+?)\*(?!\*)/g, '<em>$1</em>')
    .replace(/\n/g, '<br>');
  var myHost = currentHost || window.location.hostname;
  var linkPattern = /((https?:\/\/)[^\s<>"]+)/gi;
  var converted = escaped.replace(linkPattern, function(match, url, protocol) {
    var cleanUrl = url.replace(/^https?:\/\//, '').substring(0, 40);
    var isExternal = !url.includes(myHost) && !url.includes('localhost') && !url.includes('127.0.0.1');
    var onclick = isExternal ? " onclick=\"event.stopPropagation();showExternalLinkWarning('" + escapeHtml(url) + "')\"" : '';
    var className = isExternal ? ' class="external-link"' : '';
    return '<a href="' + escapeHtml(url) + '"' + className + onclick + ' target="_blank" rel="noopener noreferrer">' + escapeHtml(cleanUrl) + '</a>';
  });
  return converted;
}

/**
 * 外部链接风险提示弹窗
 * @param {string} url - 要访问的URL
 */
window.showExternalLinkWarning = function(url) {
  var modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:10000;display:flex;align-items:center;justify-content:center';
  modal.innerHTML = '<div style="background:#FFF;border-radius:16px;padding:28px 32px;max-width:380px;width:90%;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,0.3)">' +
    '<div style="font-size:48px;margin-bottom:12px">⚠️</div>' +
    '<div style="font-size:1.1rem;font-weight:700;color:#1F2937;margin-bottom:8px">安全风险提示</div>' +
    '<div style="font-size:0.9rem;color:#6B7280;margin-bottom:16px;word-break:break-all;text-align:left;padding:10px;background:#F9FAFB;border-radius:8px;border:1px solid #E5E7EB">' + escapeHtml(url) + '</div>' +
    '<div style="font-size:0.85rem;color:#EF4444;margin-bottom:20px;line-height:1.5">该链接指向外部网站，可能存在安全风险<br>请确认链接来源是否可信</div>' +
    '<div style="display:flex;gap:10px;justify-content:center">' +
      '<button onclick="document.body.removeChild(this.closest(\'div[style*="z-index:10000"]\'))" style="padding:10px 20px;border-radius:8px;border:1px solid #E5E7EB;background:#FFF;color:#6B7280;font-size:0.9rem;cursor:pointer;flex:1">取消</button>' +
      '<button onclick="window.open(\'' + escapeHtml(url) + '\',\'_blank\');document.body.removeChild(this.closest(\'div[style*="z-index:10000"]\'))" style="padding:10px 20px;border-radius:8px;border:none;background:linear-gradient(135deg,#EF4444,#F87171);color:#FFF;font-size:0.9rem;font-weight:600;cursor:pointer;flex:1;box-shadow:0 4px 12px rgba(239,68,68,0.3)">继续访问</button>' +
    '</div>' +
  '</div>';
  document.body.appendChild(modal);
  modal.onclick = function(e) {
    if (e.target === modal) modal.remove();
  };
};

/**
 * 缓存点赞状态（localStorage）
 */
var LIKE_CACHE_PREFIX = 'like_status_';
var LIKE_CACHE_EXPIRY = 7 * 24 * 60 * 60 * 1000; // 7天

function cacheLikeStatus(postId, liked) {
  try {
    var key = LIKE_CACHE_PREFIX + postId;
    var data = { liked: liked, timestamp: Date.now() };
    localStorage.setItem(key, JSON.stringify(data));
  } catch (e) {}
}

function getCachedLikeStatus(postId) {
  try {
    var key = LIKE_CACHE_PREFIX + postId;
    var data = localStorage.getItem(key);
    if (!data) return null;
    var parsed = JSON.parse(data);
    if (Date.now() - parsed.timestamp > LIKE_CACHE_EXPIRY) {
      localStorage.removeItem(key);
      return null;
    }
    return parsed.liked;
  } catch (e) {
    return null;
  }
}

// ===== 图片灯箱预览 =====
function updateNavbar() {
  var user = getCurrentUser();
  var navAuth = document.getElementById('navAuth');
  var navUser = document.getElementById('navUser');
  var navAvatar = document.getElementById('navAvatar');
  var navNickname = document.getElementById('navNickname');
  if (!navAuth || !navUser) return;
  if (user) {
    // 已登录：显示用户信息，隐藏登录注册按钮
    navAuth.style.display = 'none';
    navUser.style.display = 'flex';
    if (navAvatar) navAvatar.querySelector('img').src = user.avatar || '/uploads/avatars/default.png';
    if (navNickname) navNickname.textContent = user.nickname || user.username;

    // 根据角色显示管理入口
    updateAdminLink(user.role);
  } else {
    // 未登录：显示登录注册按钮，隐藏用户信息
    navAuth.style.display = 'flex';
    navUser.style.display = 'none';
    // 移除管理入口
    var adminLink = document.getElementById('navAdminLink');
    if (adminLink) adminLink.remove();
  }
}

// 页面加载时立即更新导航栏状态（避免闪烁）
(function() {
  var user = getCurrentUser();
  var navAuth = document.getElementById('navAuth');
  var navUser = document.getElementById('navUser');
  if (navAuth && navUser) {
    if (user) {
      navAuth.style.display = 'none';
      navUser.style.display = 'flex';
      var navAvatar = document.getElementById('navAvatar');
      var navNickname = document.getElementById('navNickname');
      if (navAvatar) navAvatar.querySelector('img').src = user.avatar || '/uploads/avatars/default.png';
      if (navNickname) navNickname.textContent = user.nickname || user.username;
    } else {
      navAuth.style.display = 'flex';
      navUser.style.display = 'none';
    }
  }
})();

/**
 * 根据用户角色显示/隐藏管理后台入口
 */
function updateAdminLink(role) {
  var navLinks = document.getElementById('navLinks');
  if (!navLinks) return;

  // 移除已有的管理链接
  var existing = document.getElementById('navAdminLink');
  if (existing) existing.remove();

  // 非管理角色不显示
  var adminRoles = ['reviewer', 'radio_admin', 'admin', 'super_admin'];
  if (!role || adminRoles.indexOf(role) === -1) return;

  // 角色对应的显示名称
  var roleLabels = {
    reviewer: '审核管理',
    radio_admin: '广播管理',
    admin: '管理后台',
    super_admin: '管理后台'
  };

  var link = document.createElement('a');
  link.id = 'navAdminLink';
  link.href = '/admin';
  link.className = 'nav-link nav-admin-link';
  link.innerHTML = '<span>⚙️</span> ' + (roleLabels[role] || '管理后台');

  // 插入到导航链接末尾
  navLinks.appendChild(link);
}

/**
 * 移动端菜单切换
 */
function initMobileMenu() {
  var toggle = document.getElementById('navToggle');
  var links = document.getElementById('navLinks');
  if (toggle && links) {
    toggle.setAttribute('aria-expanded', 'false');
    toggle.addEventListener('click', function() {
      var isOpen = links.classList.toggle('show');
      toggle.setAttribute('aria-expanded', String(isOpen));
    });
    // 点击页面其他区域关闭菜单
    document.addEventListener('click', function(e) {
      if (!toggle.contains(e.target) && !links.contains(e.target)) {
        links.classList.remove('show');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') {
        links.classList.remove('show');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
  }
}

/**
 * 导航栏滚动阴影效果
 */
function initNavbarScroll() {
  var navbar = document.getElementById('navbar');
  if (navbar) {
    window.addEventListener('scroll', function() {
      if (window.scrollY > 10) {
        navbar.classList.add('scrolled');
      } else {
        navbar.classList.remove('scrolled');
      }
    }, { passive: true });
  }
}

function initBottomTabs() {
  var tabs = document.querySelectorAll('.bottom-tab-bar .tab-item');
  if (!tabs.length) return;
  var path = window.location.pathname.replace(/\/$/, '') || '/';
  tabs.forEach(function(tab) {
    var href = tab.getAttribute('href') || '';
    var tabPath = href.split('#')[0].split('?')[0].replace(/\/$/, '') || '/';
    var isHomeLike = tab.getAttribute('data-tab') === 'home' && (path === '/' || path.indexOf('/post/') === 0);
    var isActive = isHomeLike || path === tabPath || (tab.getAttribute('data-tab') === 'profile' && ['/feedback', '/edit-profile'].indexOf(path) !== -1);
    tab.classList.toggle('active', isActive);
    if (isActive) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
    if (tab.classList.contains('tab-item-center')) tab.setAttribute('aria-label', '发布帖子');
  });
}

// 页面初始化
document.addEventListener('DOMContentLoaded', function() {
  updateNavbar();
  initMobileMenu();
  initNavbarScroll();
  initBottomTabs();
  
  // 退出登录按钮
  var navLogout = document.getElementById('navLogout');
  if (navLogout) {
    navLogout.addEventListener('click', function() {
      // 显示自定义确认弹窗 - 卡哇伊风格
      var overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.4);z-index:100000;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);';
      overlay.innerHTML = '<div class="logout-confirm-modal">' +
        '<div class="logout-modal-stars">✦ ✧ ★ ✦ ✧</div>' +
        '<div class="logout-modal-icon">👋</div>' +
        '<div class="logout-modal-title">确定要退出登录吗？</div>' +
        '<div class="logout-modal-desc">退出后将返回首页哦～</div>' +
        '<div class="logout-modal-btns">' +
        '<button class="logout-btn-cancel">再想想</button>' +
        '<button class="logout-btn-confirm">确定退出</button>' +
        '</div></div>';
      overlay.className = 'logout-overlay';
      document.body.appendChild(overlay);

      // 绑定按钮事件
      overlay.querySelector('.logout-btn-cancel').addEventListener('click', function() { overlay.remove(); });
      overlay.querySelector('.logout-btn-confirm').addEventListener('click', function() {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        sessionStorage.removeItem('token');
        sessionStorage.removeItem('user');
        overlay.remove();
        window.location.href = '/';
      });
      overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });
    });
  }
});


// ===== 移动端输入框防键盘遮挡 =====
(function() {
  if (window.innerWidth > 768) return;
  
  // 监听输入框聚焦
  document.addEventListener('focusin', function(e) {
    var target = e.target;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') {
      // 延迟滚动，等待键盘弹出
      setTimeout(function() {
        target.scrollIntoView({ behavior: getMotionSafeScrollBehavior(), block: 'center' });
      }, 300);
    }
  });
})();
// ===== 图片灯箱预览 =====
var lightboxImages = [];
var lightboxIndex = 0;
var touchStartX = 0;
var touchStartY = 0;

function previewImage(src, images, index) {
  var existing = document.getElementById('lightbox-overlay');
  if (existing) closeLightbox(true);

  if (images) {
    // 支持 JSON 字符串或数组
    var parsed = typeof images === 'string' ? JSON.parse(images) : images;
    if (Array.isArray(parsed) && parsed.length > 0) {
      lightboxImages = parsed;
      lightboxIndex = index !== undefined ? index : parsed.indexOf(src);
      if (lightboxIndex < 0) lightboxIndex = 0;
    } else {
      lightboxImages = [src];
      lightboxIndex = 0;
    }
  } else {
    lightboxImages = [src];
    lightboxIndex = 0;
  }

  var overlay = document.createElement('div');
  overlay.id = 'lightbox-overlay';
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.97);z-index:9999;opacity:0;transition:opacity 0.25s;';

  var header = document.createElement('div');
  header.style.cssText = 'position:absolute;top:0;left:0;right:0;padding:max(16px, env(safe-area-inset-top)) 16px 12px;display:flex;align-items:center;justify-content:space-between;z-index:10;background:linear-gradient(to bottom,rgba(0,0,0,0.6),transparent);';

  var counter = document.createElement('div');
  counter.id = 'lightbox-counter';
  counter.style.cssText = 'font-size:0.9rem;color:rgba(255,255,255,0.9);font-weight:500;';

  var closeBtn = document.createElement('div');
  closeBtn.style.cssText = 'width:36px;height:36px;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,0.15);border-radius:50%;color:white;font-size:1.2rem;cursor:pointer;';
  closeBtn.innerHTML = '✕';
  closeBtn.onclick = function(e) { e.stopPropagation(); closeLightbox(); };

  header.appendChild(counter);
  header.appendChild(closeBtn);

  var imgContainer = document.createElement('div');
  imgContainer.id = 'lightbox-container';
  imgContainer.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;';

  var img = document.createElement('img');
  img.id = 'lightbox-img';
  img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;transition:opacity 0.2s;';
  img.src = lightboxImages[lightboxIndex];

  var loading = document.createElement('div');
  loading.id = 'lightbox-loading';
  loading.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:40px;height:40px;border:3px solid rgba(255,255,255,0.2);border-top-color:white;border-radius:50%;animation:lbSpin 0.8s linear infinite;';

  imgContainer.appendChild(img);
  imgContainer.appendChild(loading);
  overlay.appendChild(header);
  overlay.appendChild(imgContainer);

  var footer = document.createElement('div');
  footer.style.cssText = 'position:absolute;bottom:0;left:0;right:0;padding:12px 16px max(20px, env(safe-area-inset-bottom));display:flex;align-items:center;justify-content:center;gap:24px;background:linear-gradient(to top,rgba(0,0,0,0.6),transparent);';

  var prevBtn = document.createElement('div');
  prevBtn.id = 'lightbox-prev';
  prevBtn.style.cssText = 'width:48px;height:48px;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,0.15);border-radius:50%;color:white;font-size:1.5rem;cursor:pointer;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);';
  prevBtn.innerHTML = '‹';
  prevBtn.onclick = function(e) { e.stopPropagation(); lightboxGo(-1); };

  var nextBtn = document.createElement('div');
  nextBtn.id = 'lightbox-next';
  nextBtn.style.cssText = 'width:48px;height:48px;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,0.15);border-radius:50%;color:white;font-size:1.5rem;cursor:pointer;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);';
  nextBtn.innerHTML = '›';
  nextBtn.onclick = function(e) { e.stopPropagation(); lightboxGo(1); };

  var saveBtn = document.createElement('div');
  saveBtn.id = 'lightbox-save';
  saveBtn.style.cssText = 'width:48px;height:48px;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,0.15);border-radius:50%;color:white;font-size:1.2rem;cursor:pointer;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);';
  saveBtn.innerHTML = '↓';
  saveBtn.onclick = function(e) { e.stopPropagation(); saveImage(); };

  footer.appendChild(prevBtn);
  footer.appendChild(nextBtn);
  footer.appendChild(saveBtn);
  overlay.appendChild(footer);

  var sp = document.createElement('style');
  sp.textContent = '@keyframes lbSpin{to{transform:translate(-50%,-50%) rotate(360deg)}}';
  overlay.appendChild(sp);

  document.body.appendChild(overlay);

  img.onload = function() { loading.style.display = 'none'; };
  img.onerror = function() { loading.style.display = 'none'; };

  overlay.onclick = function(e) {
    if (e.target === overlay || e.target === imgContainer) closeLightbox();
  };

  overlay.addEventListener('touchstart', function(e) {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }, { passive: true });
  overlay.addEventListener('touchend', function(e) {
    var dx = e.changedTouches[0].clientX - touchStartX;
    var dy = e.changedTouches[0].clientY - touchStartY;
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 60) {
      lightboxGo(dx < 0 ? 1 : -1);
    }
  }, { passive: true });

  requestAnimationFrame(function() { overlay.style.opacity = '1'; });

  document.body.style.overflow = 'hidden';
  updateLightboxUI();
}

function lightboxGo(dir) {
  if (lightboxImages.length <= 1) return;
  lightboxIndex = (lightboxIndex + dir + lightboxImages.length) % lightboxImages.length;
  var img = document.getElementById('lightbox-img');
  var loading = document.getElementById('lightbox-loading');
  if (img) {
    img.style.opacity = '0';
    if (loading) loading.style.display = 'block';
    setTimeout(function() {
      img.src = lightboxImages[lightboxIndex];
      img.onload = function() {
        if (loading) loading.style.display = 'none';
        img.style.opacity = '1';
      };
    }, 150);
  }
  updateLightboxUI();
}

function updateLightboxUI() {
  var prevBtn = document.getElementById('lightbox-prev');
  var nextBtn = document.getElementById('lightbox-next');
  var counter = document.getElementById('lightbox-counter');
  if (prevBtn) prevBtn.style.opacity = lightboxImages.length > 1 ? '1' : '0.3';
  if (nextBtn) nextBtn.style.opacity = lightboxImages.length > 1 ? '1' : '0.3';
  if (counter) counter.textContent = (lightboxIndex + 1) + ' / ' + lightboxImages.length;
}

function saveImage() {
  var img = document.getElementById('lightbox-img');
  if (!img || !img.src) return;
  var a = document.createElement('a');
  a.href = img.src;
  a.download = 'image_' + lightboxIndex + '.jpg';
  a.target = '_blank';
  a.click();
}

function closeLightbox(immediate) {
  var overlay = document.getElementById('lightbox-overlay');
  if (!overlay) return;
  if (immediate) { overlay.remove(); }
  else {
    overlay.style.opacity = '0';
    setTimeout(function() { overlay.remove(); }, 200);
  }
  document.body.style.overflow = '';
  lightboxImages = [];
  lightboxIndex = 0;
}

// 某些弹层在网络异常或浏览器后退时可能来不及执行关闭回调，避免把整页滚动锁死。
function restoreScrollIfNoBlockingLayer() {
  if (!document.body || document.body.style.overflow !== 'hidden') return;
  var selectors = ['#lightbox-overlay', '#userProfileModal', '.notification-sidebar', '.modal-overlay', '.password-panel', '.admin-modal-overlay'];
  var blocking = selectors.some(function(selector) {
    return Array.prototype.some.call(document.querySelectorAll(selector), function(element) {
      var style = window.getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    });
  });
  if (!blocking) {
    document.body.style.overflow = '';
    document.body.style.paddingRight = '';
  }
}

window.addEventListener('wheel', restoreScrollIfNoBlockingLayer, { capture: true, passive: true });
window.addEventListener('touchstart', restoreScrollIfNoBlockingLayer, { capture: true, passive: true });

document.addEventListener('keydown', function(e) {
  var overlay = document.getElementById('lightbox-overlay');
  if (!overlay) return;
  if (e.key === 'Escape') closeLightbox();
  if (e.key === 'ArrowLeft') lightboxGo(-1);
  if (e.key === 'ArrowRight') lightboxGo(1);
});
