/**
 * 嘉二の墙墙 - 公共模块 (app.js)
 * 所有页面都引用的基础JS文件
 * 包含：API配置、认证管理、Toast提示、工具函数等
 */

// API基础地址
var API_BASE = '/api';

// ===== 全局主题初始化（所有页面生效） =====
(function() {
  var saved = localStorage.getItem('theme');
  if (saved === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
})();

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
  window.location.href = '/login';
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
    window.location.href = '/login';
    return false;
  }
  return true;
}

/**
 * 带认证的fetch请求（自动附加token）
 * @param {string} url - 请求地址
 * @param {Object} options - fetch选项
 * @returns {Promise<Object>} 解析后的JSON数据
 */
async function authFetch(url, options) {
  options = options || {};
  options.headers = options.headers || {};
  var token = getToken();
  if (token) options.headers['Authorization'] = 'Bearer ' + token;
  if (!options.headers['Content-Type'] && !(options.body instanceof FormData)) {
    options.headers['Content-Type'] = 'application/json';
  }
  try {
    var res = await fetch(url, options);
    if (res.status === 401) {
      logout();
      window.location.href = '/login';
      return { code: 401, message: '请先登录' };
    }
    var data = await res.json();
    return data;
  } catch (e) {
    console.error('请求失败:', url, e);
    return { code: 500, message: '网络错误，请稍后重试' };
  }
}

/**
 * 普通fetch请求（无需认证）
 * @param {string} url - 请求地址
 * @param {Object} options - fetch选项
 * @returns {Promise<Object>} 解析后的JSON数据
 */
async function apiFetch(url, options) {
  options = options || {};
  if (!options.headers || !options.headers['Content-Type']) {
    if (!(options && options.body instanceof FormData)) {
      options.headers = options.headers || {};
      options.headers['Content-Type'] = 'application/json';
    }
  }
  try {
    var res = await fetch(url, options);
    if (res.status === 401) {
      logout();
      window.location.href = '/login';
      return { code: 401, message: '请先登录' };
    }
    var data = await res.json();
    return data;
  } catch (e) {
    console.error('请求失败:', url, e);
    return { code: 500, message: '网络错误，请稍后重试' };
  }
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
 * HTML转义，防止XSS攻击
 * @param {string} str - 需要转义的字符串
 * @returns {string} 转义后的安全字符串
 */
function escapeHtml(str) {
  if (!str) return '';
  var div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/**
 * 全屏图片预览
 * @param {string} src - 图片地址
 */
function previewImage(src) {
  var overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.8);z-index:9999;display:flex;align-items:center;justify-content:center;cursor:pointer';
  var img = document.createElement('img');
  img.src = src;
  img.style.cssText = 'max-width:90%;max-height:90%;border-radius:12px;object-fit:contain';
  overlay.appendChild(img);
  overlay.onclick = function() { overlay.remove(); };
  document.body.appendChild(overlay);
}

/**
 * 更新导航栏的登录/用户状态显示
 */
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
    toggle.addEventListener('click', function() {
      links.classList.toggle('show');
    });
    // 点击页面其他区域关闭菜单
    document.addEventListener('click', function(e) {
      if (!toggle.contains(e.target) && !links.contains(e.target)) {
        links.classList.remove('show');
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
    });
  }
}

// 页面初始化
document.addEventListener('DOMContentLoaded', function() {
  updateNavbar();
  initMobileMenu();
  initNavbarScroll();
  
  // 退出登录按钮
  var navLogout = document.getElementById('navLogout');
  if (navLogout) {
    navLogout.addEventListener('click', function() {
      if (!confirm('确定要退出登录吗？')) return;
      
      // 清除登录状态
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      sessionStorage.removeItem('token');
      sessionStorage.removeItem('user');
      
      showToast('已退出登录', 'success');
      
      // 刷新页面
      window.location.href = '/';
    });
  }
});

// ===== 图片灯箱预览 =====
function previewImage(src) {
  // 创建灯箱遮罩
  var overlay = document.createElement('div');
  overlay.id = 'lightbox-overlay';
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.92);z-index:9999;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity 0.25s ease;cursor:zoom-out;';

  // 创建图片
  var img = document.createElement('img');
  img.style.cssText = 'max-width:92vw;max-height:90vh;object-fit:contain;border-radius:8px;box-shadow:0 8px 40px rgba(0,0,0,0.5);transform:scale(0.9);transition:transform 0.3s cubic-bezier(0.4,0,0.2,1);';
  img.src = src;
  img.onclick = function(e) { e.stopPropagation(); };

  // 关闭按钮
  var closeBtn = document.createElement('div');
  closeBtn.style.cssText = 'position:absolute;top:16px;right:16px;width:40px;height:40px;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,0.1);border-radius:50%;color:white;font-size:1.4rem;cursor:pointer;backdrop-filter:blur(10px);transition:background 0.2s;';
  closeBtn.textContent = '✕';
  closeBtn.onclick = function() { closeLightbox(); };

  overlay.appendChild(img);
  overlay.appendChild(closeBtn);
  document.body.appendChild(overlay);

  // 动画显示
  requestAnimationFrame(function() {
    overlay.style.opacity = '1';
    img.style.transform = 'scale(1)';
  });

  // 点击遮罩关闭
  overlay.onclick = function() { closeLightbox(); };

  // ESC关闭
  document.addEventListener('keydown', handleLightboxEsc);
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  var overlay = document.getElementById('lightbox-overlay');
  if (!overlay) return;
  overlay.style.opacity = '0';
  var img = overlay.querySelector('img');
  if (img) img.style.transform = 'scale(0.9)';
  setTimeout(function() {
    overlay.remove();
    document.body.style.overflow = '';
  }, 250);
  document.removeEventListener('keydown', handleLightboxEsc);
}

function handleLightboxEsc(e) {
  if (e.key === 'Escape') closeLightbox();
}

// ===== 移动端输入框防键盘遮挡 =====
(function() {
  if (window.innerWidth > 768) return;
  
  // 监听输入框聚焦
  document.addEventListener('focusin', function(e) {
    var target = e.target;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') {
      // 延迟滚动，等待键盘弹出
      setTimeout(function() {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 300);
    }
  });
})();
