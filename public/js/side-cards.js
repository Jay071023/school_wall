/**
 * 侧边卡片组件 (side-cards.js)
 * 在大屏上显示左右两侧的浮动功能卡片：高考倒计时、天气、一言、历史上的今天
 * 自动注入到页面中，无需在 HTML 中手动添加
 */
(function() {
  // 如果已存在则不重复注入 HTML，但仍执行更新逻辑
  var hasExistingCards = document.getElementById('sideGaokao') !== null;
  // 极小屏不显示
  if (window.innerWidth <= 600) return;

  var html =
    '<div class="side-cards-container">' +
    '  <div class="side-cards-group side-cards-left">' +
    // 高考倒计时
    '    <div class="side-card glass-effect" id="sideGaokao">' +
    '      <div class="side-card-icon">📚</div>' +
    '      <div class="side-card-title">高考倒计时</div>' +
    '      <div class="side-card-countdown" id="sideGaokaoCountdown"></div>' +
    '      <div class="side-card-progress">' +
    '        <div class="progress-ring">' +
    '          <svg class="progress-svg" viewBox="0 0 100 100">' +
    '            <defs>' +
    '              <linearGradient id="progressGradient" x1="0%" y1="0%" x2="100%" y2="0%">' +
    '                <stop offset="0%" style="stop-color:#F59E0B"/>' +
    '                <stop offset="50%" style="stop-color:#D97706"/>' +
    '                <stop offset="100%" style="stop-color:#B45309"/>' +
    '              </linearGradient>' +
    '            </defs>' +
    '            <circle class="progress-bg" cx="50" cy="50" r="45"/>' +
    '            <circle class="progress-bar" cx="50" cy="50" r="45" id="progressBar"/>' +
    '          </svg>' +
    '          <div class="progress-text" id="progressText">0%</div>' +
    '        </div>' +
    '      </div>' +
    '      <div class="side-card-decoration">' +
    '        <span class="float-element float-1">✨</span>' +
    '        <span class="float-element float-2">🌟</span>' +
    '        <span class="float-element float-3">💫</span>' +
    '      </div>' +
    '    </div>' +
    // 天气
    '    <div class="side-card glass-effect" id="sideWeather">' +
    '      <div class="side-card-icon">⛅</div>' +
    '      <div class="side-card-title">上海天气</div>' +
    '      <div class="weather-main">' +
    '        <span class="weather-temp" id="weatherTemp">--°</span>' +
    '        <span class="weather-icon" id="weatherIcon">🌤️</span>' +
    '      </div>' +
    '      <div class="weather-info">' +
    '        <div class="weather-item" id="weatherCondition">加载中...</div>' +
    '        <div class="weather-detail">' +
    '          <span>💧 <span id="weatherHumidity">--%</span></span>' +
    '          <span>💨 <span id="weatherWind">--级</span></span>' +
    '        </div>' +
    '      </div>' +
    '      <div class="weather-aqi" id="weatherAqi">' +
    '        <span class="aqi-label">空气</span>' +
    '        <span class="aqi-value" id="aqiValue">--</span>' +
    '      </div>' +
    '      <div class="side-card-decoration">' +
    '        <span class="float-element float-1">☁️</span>' +
    '        <span class="float-element float-2">🌤️</span>' +
    '      </div>' +
    '    </div>' +
    '  </div>' +
    // 右侧卡片组
    '  <div class="side-cards-group side-cards-right">' +
    // 一言
    '    <div class="side-card glass-effect" id="sideHitokoto">' +
    '      <div class="side-card-icon">💬</div>' +
    '      <div class="side-card-title">一言</div>' +
    '      <div class="side-card-content" id="sideHitokotoText">加载中...</div>' +
    '      <div class="side-card-meta">' +
    '        <span class="hitokoto-author" id="hitokotoAuthor"></span>' +
    '        <span class="hitokoto-from" id="hitokotoFrom"></span>' +
    '      </div>' +
    '      <button class="refresh-btn" id="refreshHitokoto">🔄</button>' +
    '      <div class="side-card-decoration">' +
    '        <span class="float-element float-1">💭</span>' +
    '        <span class="float-element float-2">✨</span>' +
    '      </div>' +
    '    </div>' +
    // 历史上的今天
    '    <div class="side-card glass-effect" id="sideHotsearch">' +
    '      <div class="side-card-icon">📜</div>' +
    '      <div class="side-card-title">历史上的今天</div>' +
    '      <div class="hotsearch-list" id="hotsearchList">' +
    '        <div class="hotsearch-item loading">加载中...</div>' +
    '      </div>' +
    '      <button class="refresh-btn" id="refreshHotsearch">🔄</button>' +
    '      <div class="side-card-decoration">' +
    '        <span class="float-element float-1">📈</span>' +
    '        <span class="float-element float-2">🔥</span>' +
    '      </div>' +
    '    </div>' +
    '  </div>' +
    '</div>';

  // 注入到 body 中 main-content 之后
  function inject() {
    if (!hasExistingCards) {
      var mainContent = document.querySelector('.main-content');
      if (mainContent) {
        mainContent.insertAdjacentHTML('afterend', html);
      } else {
        document.body.insertAdjacentHTML('beforeend', html);
      }
    }
    initAll();
  }

  function initAll() {
    // ===== 高考倒计时 =====
    (function() {
      var sideEl = document.getElementById('sideGaokaoCountdown');
      var progressBar = document.getElementById('progressBar');
      var progressText = document.getElementById('progressText');
      var sideGaokao = document.getElementById('sideGaokao');
      var sideGaokaoTitle = sideGaokao ? sideGaokao.querySelector('.side-card-title') : null;
      var sideGaokaoIcon = sideGaokao ? sideGaokao.querySelector('.side-card-icon') : null;

      var currentMode = 'gaokao';
      var exams = {
        gaokao: { name: '高考', month: 6, day: 7, hour: 9, icon: '📚' },
        dengkao: { name: '等级考', month: 5, day: 5, hour: 9, icon: '📝' }
      };

      function getExamDate(exam) {
        var now = new Date();
        var year = now.getFullYear();
        var examDate = new Date(year, exam.month - 1, exam.day, exam.hour, 0, 0);
        if (now > examDate) {
          examDate = new Date(year + 1, exam.month - 1, exam.day, exam.hour, 0, 0);
        }
        return examDate;
      }

      function update() {
        var now = new Date();
        var exam = exams[currentMode];
        var examDate = getExamDate(exam);
        var diff = examDate - now;
        var totalDays = 365;
        var days = Math.floor(diff / (1000 * 60 * 60 * 24));
        var hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        var minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

        var isMobile = window.innerWidth <= 768;
        var displayText = isMobile ? (days + '天' + hours + '时' + minutes + '分') : (days + '天' + hours + '时');

        if (sideEl) sideEl.textContent = displayText;
        if (sideGaokaoTitle) sideGaokaoTitle.textContent = exam.name + '倒计时';
        if (sideGaokaoIcon) sideGaokaoIcon.textContent = exam.icon;

        var elapsed = totalDays - days;
        var percent = Math.max(0, Math.min(100, (elapsed / totalDays) * 100));

        if (progressBar) {
          var circumference = 2 * Math.PI * 45;
          var offset = circumference * (1 - percent / 100);
          progressBar.style.strokeDashoffset = offset;
        }
        if (progressText) progressText.textContent = Math.round(percent) + '%';
      }

      function switchMode() {
        currentMode = currentMode === 'gaokao' ? 'dengkao' : 'gaokao';
        update();
      }

      update();
      setInterval(update, 60000);

      if (sideGaokao) {
        sideGaokao.style.cursor = 'pointer';
        sideGaokao.addEventListener('click', function() {
          switchMode();
          this.style.transform = 'translateY(-50%) scale(0.92)';
          setTimeout(function() { this.style.transform = ''; }.bind(this), 150);
        });

        // 自动轮播每5秒切换
        setInterval(function() {
          switchMode();
        }, 5000);
      }
    })();

    // ===== 一言 =====
    (function() {
      var sideEl = document.getElementById('sideHitokotoText');
      var authorEl = document.getElementById('hitokotoAuthor');
      var fromEl = document.getElementById('hitokotoFrom');
      var refreshBtn = document.getElementById('refreshHitokoto');
      var sideHitokoto = document.getElementById('sideHitokoto');

      function load() {
        if (refreshBtn) refreshBtn.classList.add('spinning');

        fetch('https://v1.hitokoto.cn/?c=a&c=b&c=d&c=i&c=k')
          .then(function(r) { return r.json(); })
          .then(function(data) {
            if (data.hitokoto) {
              var text = data.hitokoto;
              if (sideEl) sideEl.textContent = text.length > 30 ? text.substring(0, 30) + '...' : text;
              if (authorEl) authorEl.textContent = '— ' + (data.from || '未知');
              if (fromEl) fromEl.textContent = data.type ? getTypeName(data.type) : '';
            } else {
              if (sideEl) sideEl.textContent = '生活明朗，万物可爱';
            }
            if (refreshBtn) setTimeout(function() { refreshBtn.classList.remove('spinning'); }, 300);
          })
          .catch(function() {
            if (sideEl) sideEl.textContent = '生活明朗，万物可爱';
            if (refreshBtn) refreshBtn.classList.remove('spinning');
          });
      }

      function getTypeName(type) {
        var types = { a:'动画', b:'漫画', c:'游戏', d:'文学', e:'原创', f:'来自网络', g:'其他', h:'影视', i:'诗词', j:'网易云', k:'哲学', l:'抖机灵' };
        return types[type] || '';
      }

      setTimeout(load, 100);
      if (refreshBtn) refreshBtn.addEventListener('click', function(e) { e.stopPropagation(); if (sideEl) sideEl.textContent = '加载中...'; load(); });
      if (sideHitokoto) sideHitokoto.addEventListener('click', function(e) { if (e.target !== refreshBtn) { if (sideEl) sideEl.textContent = '加载中...'; load(); } });
    })();

    // ===== 天气 =====
    (function() {
      var weatherTemp = document.getElementById('weatherTemp');
      var weatherIcon = document.getElementById('weatherIcon');
      var weatherCondition = document.getElementById('weatherCondition');
      var weatherHumidity = document.getElementById('weatherHumidity');
      var weatherWind = document.getElementById('weatherWind');
      var aqiValue = document.getElementById('aqiValue');
      var sideWeather = document.getElementById('sideWeather');
      var weatherTitle = sideWeather ? sideWeather.querySelector('.side-card-title') : null;

      function getWeatherIcon(code) {
        if (code === 0) return '☀️';
        if (code >= 1 && code <= 3) return '⛅';
        if (code >= 45 && code <= 48) return '🌫️';
        if (code >= 51 && code <= 57) return '🌧️';
        if (code >= 61 && code <= 67) return '🌧️';
        if (code >= 71 && code <= 77) return '🌨️';
        if (code >= 80 && code <= 82) return '🌧️';
        if (code >= 95 && code <= 99) return '⛈️';
        return '🌤️';
      }

      function getWeatherText(code) {
        var map = {0:'晴',1:'晴间多云',2:'多云',3:'阴天',45:'雾',48:'霜雾',51:'毛毛雨',53:'毛毛雨',55:'毛毛雨',56:'冻毛毛雨',57:'冻毛毛雨',61:'小雨',63:'中雨',65:'大雨',66:'冻雨',67:'冻雨',71:'小雪',73:'中雪',75:'大雪',77:'雪粒',80:'阵雨',81:'中阵雨',82:'强阵雨',85:'阵雪',86:'强阵雪',95:'雷暴',96:'雷暴+冰雹',99:'强雷暴+冰雹'};
        return map[code] || '多云';
      }

      function getCityName(city) {
        var map = {'Shanghai':'上海','Beijing':'北京','Guangzhou':'广州','Shenzhen':'深圳','Hangzhou':'杭州','Nanjing':'南京','Chengdu':'成都','Wuhan':'武汉',"Xi'an":'西安','Chongqing':'重庆','Tianjin':'天津','Suzhou':'苏州','Zhengzhou':'郑州','Changsha':'长沙','Qingdao':'青岛','Dalian':'大连','Ningbo':'宁波','Xiamen':'厦门','Hefei':'合肥','Jiading':'嘉定'};
        return map[city] || city;
      }

      function load() {
        if (weatherCondition) weatherCondition.textContent = '加载中...';
        fetch('/api/weather')
          .then(function(r) { return r.json(); })
          .then(function(data) {
            var city = '上海';
            if (data && data.city) city = getCityName(data.city);
            if (data && data.current) {
              var current = data.current;
              if (weatherTemp) weatherTemp.textContent = Math.round(current.temperature_2m) + '°';
              if (weatherIcon) weatherIcon.textContent = getWeatherIcon(current.weather_code);
              if (weatherCondition) weatherCondition.textContent = getWeatherText(current.weather_code);
              if (weatherHumidity) weatherHumidity.textContent = current.relative_humidity_2m + '%';
              if (weatherWind) weatherWind.textContent = current.wind_speed_10m + '级';
              if (weatherTitle) weatherTitle.textContent = city + '天气';
              if (aqiValue) { aqiValue.textContent = '良'; aqiValue.className = 'aqi-value moderate'; }
            } else { showDefault(); }
          })
          .catch(function() { showDefault(); });
      }

      function showDefault() {
        if (weatherTitle) weatherTitle.textContent = '上海天气';
        if (weatherTemp) weatherTemp.textContent = '--°';
        if (weatherIcon) weatherIcon.textContent = '🌤️';
        if (weatherCondition) weatherCondition.textContent = '加载中...';
        if (weatherHumidity) weatherHumidity.textContent = '--%';
        if (weatherWind) weatherWind.textContent = '--级';
        if (aqiValue) { aqiValue.textContent = '--'; aqiValue.className = 'aqi-value'; }
      }

      setTimeout(load, 100);
      if (sideWeather) sideWeather.addEventListener('click', function() { if (weatherCondition) weatherCondition.textContent = '加载中...'; load(); });
    })();

    // ===== 历史上的今天 =====
    (function() {
      var hotsearchList = document.getElementById('hotsearchList');
      var refreshBtn = document.getElementById('refreshHotsearch');
      var sideHotsearch = document.getElementById('sideHotsearch');

      // 标题加上今天日期
      function updateTitleDate() {
        var titleEl = sideHotsearch ? sideHotsearch.querySelector('.side-card-title') : null;
        if (titleEl) {
          var today = new Date();
          titleEl.innerHTML = '📜 <span>' + (today.getMonth() + 1) + '月' + today.getDate() + '日</span>';
        }
      }
      updateTitleDate();

      function load() {
        if (refreshBtn) refreshBtn.classList.add('spinning');
        if (hotsearchList) hotsearchList.innerHTML = '<div class="hotsearch-item loading">加载中...</div>';

        fetch('/api/hotsearch')
          .then(function(r) { return r.json(); })
          .then(function(data) {
            if (hotsearchList) hotsearchList.innerHTML = '';
            if (data && data.data && data.data.length > 0) {
              data.data.slice(0, 5).forEach(function(item, i) {
                var div = document.createElement('div');
                div.className = 'hotsearch-item history-item';
                var txt = typeof item === 'string' ? item : (item.title || item.text || item.content || '');
                // 提取日期前缀（如"2003年05月02日 "）
                var datePart = '';
                var eventPart = txt;
                var match = txt.match(/^(\d{4}年\d{2}月\d{2}日)\s*/);
                if (match) {
                  datePart = match[1];
                  eventPart = txt.substring(match[0].length);
                }
                if (eventPart.length > 15) eventPart = eventPart.substring(0, 15) + '…';
                 div.innerHTML = '<span class="hotsearch-rank">' + (i + 1) + '.</span>' +
                   '<span class="history-text">' +
                     (datePart ? '<span class="history-date">' + escapeHtml(datePart) + '</span>' : '') +
                     (datePart && eventPart ? ' ' : '') +
                     '<span class="history-event">' + escapeHtml(eventPart) + '</span>' +
                   '</span>';
                if (hotsearchList) hotsearchList.appendChild(div);
              });
            } else {
              if (hotsearchList) hotsearchList.innerHTML = '<div class="hotsearch-item loading">暂无数据</div>';
            }
            if (refreshBtn) setTimeout(function() { refreshBtn.classList.remove('spinning'); }, 300);
          })
          .catch(function() {
            if (hotsearchList) hotsearchList.innerHTML = '<div class="hotsearch-item loading">加载失败</div>';
            if (refreshBtn) refreshBtn.classList.remove('spinning');
          });
      }

      setTimeout(load, 100);
      if (refreshBtn) refreshBtn.addEventListener('click', function(e) { e.stopPropagation(); load(); });
      if (sideHotsearch) sideHotsearch.addEventListener('click', function(e) { if (e.target !== refreshBtn) load(); });
    })();

    // 小工具
    function escapeHtml(str) {
      if (!str) return '';
      return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }
  }

  // 在 DOMContentLoaded 或立即执行
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject);
  } else {
    inject();
  }
})();
