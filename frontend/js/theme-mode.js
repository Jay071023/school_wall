/* 统一加载节日主题。旧 back_to_school 仅兼容归一化为教师节，前台只展示教师节或 520。 */
(function () {
  var THEME_NAMES = {
    BACK_TO_SCHOOL: 'back_to_school',
    TEACHERS_DAY: 'teachers_day',
    FIVE_TWENTY: '520'
  };
  var THEME_STYLES = {
    teacher: { id: 'theme-teacher-css', href: '/css/teacher.css' },
    fiveTwenty: { id: 'theme-festival-520-css', href: '/css/festival-520.css' }
  };
  var THEME_HINT_KEY = 'campus-wall-theme-hint-v1';
  var THEME_HINT_TTL_MS = 60 * 60 * 1000;
  var THEME_SETTINGS_TIMEOUT_MS = 3000;
  var TEACHER_THEME_COPY = {
    ariaLabel: '教师节主题寄语',
    eyebrow: "TEACHERS' DAY · 09.10",
    title: '师恩如光，照亮新学期',
    copy: '愿每一次认真讲解，都被记成成长的回响。',
    seal: '师恩<small>难忘</small>'
  };
  var HEART_SVG = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="heartGradient" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" style="stop-color:#FF7A9A"/><stop offset="100%" style="stop-color:#FFB3C6"/></linearGradient></defs><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" fill="url(#heartGradient)"/></svg>';
  var PETALS = ['🌸', '🩷', '🌺', '💮'];
  var SPARKLES = ['✨', '⭐', '✦', '💫'];
  var readySignaled = false;
  var themeSettingsPromise = null;

  function signalThemeReady() {
    if (readySignaled) return;
    readySignaled = true;
    window.dispatchEvent(new Event('festival-theme-ready'));
  }

  function waitForStylesheet(link, callback) {
    if (link.sheet) return callback(true);
    var settled = false;
    var timeoutId = null;
    function finish(loaded) {
      if (settled) return;
      settled = true;
      if (timeoutId) window.clearTimeout(timeoutId);
      callback(loaded);
    }
    // ensureStylesheet 会在 append 前创建该 Promise。动态 CSS 命中缓存时，
    // load 事件可能在本函数添加监听前触发；复用已登记的结果避免误判失败。
    if (link.__campusThemeLoad) {
      timeoutId = window.setTimeout(function () { finish(false); }, 6500);
      link.__campusThemeLoad.then(finish);
      return;
    }
    link.addEventListener('load', function () { finish(true); }, { once: true });
    link.addEventListener('error', function () { finish(false); }, { once: true });
    // 页面 boot gate 最长等待 7 秒；慢网下不能 2.5 秒就放行默认主题导致闪烁。
    timeoutId = window.setTimeout(function () { finish(false); }, 6500);
  }

  // 不要先 append 一个 disabled stylesheet 再启用：部分浏览器会请求文件却不创建
  // CSSStyleSheet，最终触发“加载失败”回退，让后台已开启的主题在前台完全不显示。
  // 主题确定后才插入对应的 link，既避免这个兼容问题，也不会无谓加载另一套主题。
  function ensureStylesheet(definition, stylesheets, key) {
    var link = stylesheets[key] || document.getElementById(definition.id);
    if (!link) {
      link = document.createElement('link');
      link.id = definition.id;
      link.rel = 'stylesheet';
      link.href = definition.href;
      link.__campusThemeLoad = new Promise(function (resolve) {
        var completed = false;
        function finish(loaded) {
          if (completed) return;
          completed = true;
          resolve(loaded);
        }
        link.addEventListener('load', function () { finish(true); }, { once: true });
        link.addEventListener('error', function () { finish(false); }, { once: true });
      });
      document.head.appendChild(link);
    }
    link.disabled = false;
    stylesheets[key] = link;
    return link;
  }

  function createThemeStylesheets() {
    return { teacher: null, fiveTwenty: null };
  }

  function normalizeThemeName(settings) {
    var configuredName = settings && settings.festival_theme;
    if (configuredName === THEME_NAMES.BACK_TO_SCHOOL) return THEME_NAMES.TEACHERS_DAY;
    if (configuredName === THEME_NAMES.TEACHERS_DAY || configuredName === THEME_NAMES.FIVE_TWENTY) {
      return configuredName;
    }
    return null;
  }

  function getThemeState(settings) {
    var configuredName = settings && settings.festival_theme;
    var themeName = normalizeThemeName(settings);
    var enabled = !!(settings && settings.festival_mode === true);
    return {
      enabled: enabled,
      name: enabled ? themeName : null,
      teacher: enabled && themeName === THEME_NAMES.TEACHERS_DAY,
      fiveTwenty: enabled && themeName === THEME_NAMES.FIVE_TWENTY,
      legacyBackToSchool: enabled && configuredName === THEME_NAMES.BACK_TO_SCHOOL
    };
  }

  function readThemeHint() {
    try {
      var raw = window.localStorage.getItem(THEME_HINT_KEY);
      if (!raw) return null;
      var hint = JSON.parse(raw);
      var now = Date.now();
      var timestamp = hint && hint.__ts;
      var validTimestamp = typeof timestamp === 'number' && isFinite(timestamp) && timestamp > 0 &&
        timestamp <= now + THEME_HINT_TTL_MS && now - timestamp <= THEME_HINT_TTL_MS;
      var validMode = hint && typeof hint.festival_mode === 'boolean';
      var validTheme = !hint || !hint.festival_mode || normalizeThemeName(hint) !== null;
      if (!hint || typeof hint !== 'object' || !validTimestamp || !validMode || !validTheme) {
        window.localStorage.removeItem(THEME_HINT_KEY);
        return null;
      }
      return hint;
    } catch (err) {
      return null;
    }
  }

  function writeThemeHint(settings) {
    try {
      var themeName = normalizeThemeName(settings);
      window.localStorage.setItem(THEME_HINT_KEY, JSON.stringify({
        __ts: Date.now(),
        festival_mode: !!(settings && settings.festival_mode === true),
        festival_theme: themeName
      }));
    } catch (err) {
      // 隐私模式或禁用存储时，不影响主题接口和首屏。
    }
  }

  function clear520Effects() {
    if (typeof window.__festival520Cleanup !== 'function') return;
    window.__festival520Cleanup();
    window.__festival520Cleanup = null;
  }

  function get520Container() {
    var container = document.getElementById('hearts-container');
    if (container) {
      container.innerHTML = '';
      return container;
    }
    container = document.createElement('div');
    container.id = 'hearts-container';
    container.className = 'hearts-container';
    container.setAttribute('aria-hidden', 'true');
    document.body.appendChild(container);
    return container;
  }

  function remove520Corners() {
    document.querySelectorAll('.deco-corner').forEach(function (element) { element.remove(); });
  }

  function add520Corner(type, content, corners) {
    var deco = document.createElement('div');
    deco.className = 'deco-corner ' + type;
    deco.setAttribute('aria-hidden', 'true');
    deco.innerHTML = content;
    document.body.appendChild(deco);
    corners.push(deco);
  }

  function create520Corners() {
    remove520Corners();
    var corners = [];
    add520Corner('top-left', '<div class="deco-heart">' + HEART_SVG + '</div>', corners);
    add520Corner('top-right', '<span class="deco-star">✦</span>', corners);
    return corners;
  }

  function schedule520Effects(container, corners) {
    var timers = [];
    var interval = null;
    function active() { return document.body.classList.contains('mode-festival-520'); }
    function removeLater(element, delay) {
      timers.push(window.setTimeout(function () { element.remove(); }, delay));
    }
    function spawn(className, content, style, lifetime) {
      if (!active()) return;
      var element = document.createElement('div');
      element.className = className;
      element.style.cssText = style;
      if (className === 'heart') element.innerHTML = content;
      else element.textContent = content;
      container.appendChild(element);
      removeLater(element, lifetime);
    }
    function spawnHeart() {
      var size = 20 + Math.random() * 18;
      spawn('heart', HEART_SVG, 'width:' + size + 'px;height:' + size + 'px;left:' + (Math.random() * 90) + 'vw;animation-duration:' + (5 + Math.random() * 3) + 's;', 9000);
    }
    function spawnPetal() {
      spawn('petal', PETALS[Math.floor(Math.random() * PETALS.length)], 'font-size:' + (14 + Math.random() * 10) + 'px;left:' + (Math.random() * 88) + 'vw;animation-duration:' + (6 + Math.random() * 4) + 's;', 11000);
    }
    function spawnSparkle() {
      spawn('sparkle', SPARKLES[Math.floor(Math.random() * SPARKLES.length)], 'font-size:' + (12 + Math.random() * 8) + 'px;left:' + (Math.random() * 92) + 'vw;animation-duration:' + (4 + Math.random() * 3) + 's;', 8000);
    }

    for (var i = 0; i < 5; i++) timers.push(window.setTimeout(spawnHeart, 1500 + i * 500));
    for (var j = 0; j < 3; j++) timers.push(window.setTimeout(spawnPetal, 1500 + j * 800));
    for (var k = 0; k < 4; k++) timers.push(window.setTimeout(spawnSparkle, 1500 + k * 400));
    interval = window.setInterval(function () {
      if (!active()) return;
      if (Math.random() > 0.4) spawnHeart();
      if (Math.random() > 0.6) spawnPetal();
      if (Math.random() > 0.5) spawnSparkle();
    }, 1000);

    return function cleanup520Effects() {
      timers.forEach(window.clearTimeout);
      if (interval) window.clearInterval(interval);
      corners.forEach(function (element) { element.remove(); });
      if (container) container.remove();
    };
  }

  function start520Effects() {
    if (!document.body.classList.contains('home-page') || window.__festival520Cleanup) return;
    var container = get520Container();
    var corners = create520Corners();
    window.__festival520Cleanup = schedule520Effects(container, corners);
  }

  function setThemeClasses(state) {
    document.body.classList.toggle('mode-teacher', state.teacher);
    // 旧 class 仍作为兼容别名保留，但 back_to_school 不再是独立展示主题。
    document.body.classList.toggle('mode-back-to-school', state.legacyBackToSchool);
    document.body.classList.toggle('mode-festival-520', state.fiveTwenty);
  }

  function hideTeacherThemeElements(elements) {
    elements.forEach(function (element) { element.hidden = true; });
  }

  function revealTeacherThemeElements(elements) {
    elements.forEach(function (element) {
      element.hidden = false;
      if (!element.classList.contains('teacher-theme-hero')) return;
      var eyebrow = element.querySelector('.teacher-hero-eyebrow');
      var title = element.querySelector('h2');
      var copy = element.querySelector('p');
      var seal = element.querySelector('.teacher-hero-seal');
      element.setAttribute('aria-label', TEACHER_THEME_COPY.ariaLabel);
      if (eyebrow) eyebrow.textContent = TEACHER_THEME_COPY.eyebrow;
      if (title) title.textContent = TEACHER_THEME_COPY.title;
      if (copy) copy.textContent = TEACHER_THEME_COPY.copy;
      if (seal) seal.innerHTML = TEACHER_THEME_COPY.seal;
    });
  }

  function setThemeStylesheets(state, stylesheets) {
    if (state.teacher) ensureStylesheet(THEME_STYLES.teacher, stylesheets, 'teacher');
    else if (stylesheets.teacher) stylesheets.teacher.disabled = true;
    if (state.fiveTwenty) ensureStylesheet(THEME_STYLES.fiveTwenty, stylesheets, 'fiveTwenty');
    else if (stylesheets.fiveTwenty) stylesheets.fiveTwenty.disabled = true;
  }

  function updateThemeColorMeta(state) {
    var meta = document.getElementById('themeColorMeta');
    if (!meta) return;
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    if (state.fiveTwenty) meta.setAttribute('content', dark ? '#2D2438' : '#FF7A9A');
    else if (state.teacher) meta.setAttribute('content', dark ? '#1d2928' : '#f7f1e6');
    else meta.setAttribute('content', dark ? '#1a1423' : '#FAFBFE');
  }

  function finishTheme(state, teacherElements, stylesheets, loaded) {
    if (state.teacher && loaded) {
      revealTeacherThemeElements(teacherElements);
      clear520Effects();
    } else if (state.fiveTwenty && loaded) {
      start520Effects();
    } else if (state.teacher || state.fiveTwenty) {
      // 活动主题 CSS 加载失败时，撤销主题类并停用对应样式，回退到基础主题。
      // 不能留下 mode-teacher/mode-festival-520 造成“半套主题”。
      var baseState = { teacher: false, fiveTwenty: false, legacyBackToSchool: false };
      setThemeClasses(baseState);
      setThemeStylesheets(baseState, stylesheets);
      hideTeacherThemeElements(teacherElements);
      clear520Effects();
      updateThemeColorMeta(baseState);
    } else {
      clear520Effects();
    }
    signalThemeReady();
  }

  function waitForActiveTheme(state, stylesheets, teacherElements) {
    var complete = function (loaded) { finishTheme(state, teacherElements, stylesheets, loaded); };
    if (state.teacher) waitForStylesheet(ensureStylesheet(THEME_STYLES.teacher, stylesheets, 'teacher'), complete);
    else if (state.fiveTwenty) waitForStylesheet(ensureStylesheet(THEME_STYLES.fiveTwenty, stylesheets, 'fiveTwenty'), complete);
    else {
      clear520Effects();
      signalThemeReady();
    }
  }

  function applyTheme(settings, stylesheets, persistHint) {
    var state = getThemeState(settings);
    if (persistHint !== false) writeThemeHint(settings);
    var teacherElements = document.querySelectorAll('.teacher-theme-hero, .teacher-theme-note');
    setThemeClasses(state);
    hideTeacherThemeElements(teacherElements);
    setThemeStylesheets(state, stylesheets);
    waitForActiveTheme(state, stylesheets, teacherElements);
    updateThemeColorMeta(state);
  }

  function loadThemeSettings() {
    if (window.CampusWallSiteInfoPromise) {
      var sharedTimeoutId = null;
      var sharedTimeout = new Promise(function (resolve) {
        sharedTimeoutId = window.setTimeout(function () { resolve(null); }, THEME_SETTINGS_TIMEOUT_MS);
      });
      // 首页会在 defer 主题脚本之前创建共享 Promise；这里也必须有超时，
      // 否则共享请求卡住时主题首屏会失去确定性的回退路径。
      return Promise.race([Promise.resolve(window.CampusWallSiteInfoPromise), sharedTimeout])
        .then(function (json) {
          if (sharedTimeoutId) window.clearTimeout(sharedTimeoutId);
          // 兼容旧页面可能暴露的 Response，同时保证共享 Promise 只消费一次响应体。
          if (json && typeof json.json === 'function') return json.json();
          return json;
        }).then(function (json) {
          return json && json.code === 200 ? (json.data || {}) : null;
        }).catch(function (err) {
          if (sharedTimeoutId) window.clearTimeout(sharedTimeoutId);
          throw err;
        });
    }
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timeoutId = controller ? window.setTimeout(function () { controller.abort(); }, 3000) : null;
    function clearRequestTimeout() {
      if (timeoutId) window.clearTimeout(timeoutId);
    }
    var request = fetch('/api/site-info', {
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller ? controller.signal : undefined
    }).then(function (response) {
      return response.ok ? response.json() : null;
    });
    window.CampusWallSiteInfoPromise = request;
    return request
      .then(function (json) {
        clearRequestTimeout();
        return json && json.code === 200 ? (json.data || {}) : null;
      })
      .catch(function () {
        clearRequestTimeout();
        return null;
      });
  }

  // 同一页面的主题、投稿和详情逻辑共享一次站点配置请求，避免重复访问 /api/site-info。
  function getThemeSettings() {
    if (!themeSettingsPromise) themeSettingsPromise = loadThemeSettings();
    return themeSettingsPromise;
  }

  function loadTheme(stylesheets) {
    getThemeSettings().then(function (settings) {
      if (settings) applyTheme(settings, stylesheets);
      else {
        // 接口失败时仍沿用最近一次已确认的主题，但必须重新走 CSS readiness，
        // 不能直接放行 boot gate 让默认主题先闪出来。
        var cachedHint = readThemeHint();
        applyTheme(cachedHint || { festival_mode: false }, stylesheets, false);
      }
    }).catch(function () {
      // 主题是非核心配置；接口或应用异常时必须放行页面。
      var cachedHint = readThemeHint();
      applyTheme(cachedHint || { festival_mode: false }, stylesheets, false);
    });
  }

  window.CampusWallThemeSettings = getThemeSettings;

  var themeStylesheets = createThemeStylesheets();
  // defer 脚本执行时 DOM 已经解析完成；先用上一次服务端配置预选主题，避免慢网下先出现默认主题。
  var cachedThemeHint = readThemeHint();
  if (cachedThemeHint && document.body) {
    var cachedState = getThemeState(cachedThemeHint);
    setThemeClasses(cachedState);
    setThemeStylesheets(cachedState, themeStylesheets);
    updateThemeColorMeta(cachedState);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { loadTheme(themeStylesheets); });
  } else {
    loadTheme(themeStylesheets);
  }
}());
