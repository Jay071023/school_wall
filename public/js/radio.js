var currentUser = JSON.parse(localStorage.getItem('user') || 'null');
var timeSlots = [];
var selectedSlotId = null;
var selectedDateId = null;

function apiFetch(url, options = {}) {
  var token = localStorage.getItem('token') || sessionStorage.getItem('token') || '';
  var headers = { 'Authorization': 'Bearer ' + token };
  if (options.headers) Object.assign(headers, options.headers);
  return fetch(url, Object.assign({ headers }, options)).then(r => r.json());
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function showToast(msg, type = 'info') {
  var toast = document.createElement('div');
  toast.className = 'toast toast-' + type;
  toast.textContent = msg;
  document.body.appendChild(toast);
  requestAnimationFrame(function() {
    toast.classList.add('show');
  });
  setTimeout(function() {
    toast.classList.remove('show');
    setTimeout(function() { toast.remove(); }, 300);
  }, 3000);
}

document.addEventListener('DOMContentLoaded', function() {
  var radioForm = document.getElementById('radioForm');
  var playlist = document.getElementById('playlist');
  var playlistEmpty = document.getElementById('playlistEmpty');
  var slotCardsGrid = document.getElementById('slotCardsGrid');
  var slotSelect = document.getElementById('slotSelect');
  var dateSelect = document.getElementById('dateSelect');
  var dateSelectGroup = document.getElementById('dateSelectGroup');

  // 移除 dateSelect 的 required 属性，避免浏览器验证错误
  if (dateSelect) dateSelect.removeAttribute('required');

  var msgTextarea = document.getElementById('songMessage');
  if (msgTextarea) {
    msgTextarea.addEventListener('input', function() {
      var len = this.value.length;
      var msgCount = document.getElementById('msgCount');
      if (msgCount) {
        msgCount.textContent = len + '/100';
        msgCount.style.color = len > 100 ? '#EF4444' : '#9CA3AF';
        if (len > 100) this.value = this.value.substring(0, 100);
      }
    });
  }

  loadTimeSlots();
  loadPlaylist();
  loadMySongs(); // 加载我的点歌记录
  loadHotSongs(); // 加载热门排行榜

  var hint = document.getElementById('availableDatesHint');
  if (hint) hint.style.display = 'none';

  window.selectSlot = function(slotId) {
    selectedSlotId = slotId;
    slotSelect.value = slotId;

    document.querySelectorAll('.slot-card-item').forEach(function(card) {
      card.classList.remove('selected');
    });
    var selectedCard = document.querySelector('.slot-card-item[data-slot-id="' + slotId + '"]');
    if (selectedCard) selectedCard.classList.add('selected');

    var slot = timeSlots.find(s => s.id == slotId);
    if (slot && slot.dates && slot.dates.length > 0) {
      dateSelectGroup.style.display = 'block';
      var html = '<option value="">请选择播放日期</option>';
      slot.dates.forEach(function(d) {
        html += '<option value="' + d.id + '">' + d.date + '(' + d.week + ') 剩余' + d.remaining + '首</option>';
      });
      dateSelect.innerHTML = html;
    } else {
      dateSelectGroup.style.display = 'none';
    }
  };

  dateSelect.addEventListener('change', function() {
    selectedDateId = this.value;
  });

  async function loadTimeSlots() {
    try {
      var data = await apiFetch('/api/songs/slots');
      if (data.code === 200) {
        timeSlots = data.data || [];
        renderSlotCards();

        var hint = document.getElementById('availableDatesHint');
        if (hint && timeSlots.length > 0) {
          var dates = [];
          timeSlots.forEach(function(s) {
            s.dates && s.dates.forEach(function(d) {
              if (!dates.includes(d.date)) dates.push(d.date + '(' + d.week + ')');
            });
          });
          if (dates.length > 0) {
            hint.innerHTML = '📅 可点歌日期：' + dates.slice(0, 7).join('、');
            hint.style.display = 'block';
          }
        }
      }
    } catch (err) { console.error('加载时段失败:', err); }
  }

  function renderSlotCards() {
    if (!slotCardsGrid) return;
    if (!timeSlots || timeSlots.length === 0) {
      slotCardsGrid.innerHTML = '<div style="padding:20px;text-align:center;color:#9CA3AF;">暂无播放时段</div>';
      return;
    }
    var html = '';
    timeSlots.forEach(function(slot) {
      var hasDates = slot.dates && slot.dates.length > 0;
      var totalRemaining = 0;
      if (hasDates) {
        slot.dates.forEach(function(d) {
          totalRemaining += d.remaining;
        });
      }
      html += '<div class="slot-card-item' + (selectedSlotId == slot.id ? ' selected' : '') + '" data-slot-id="' + slot.id + '" onclick="selectSlot(' + slot.id + ')">';
      html += '<div class="slot-card-name">' + escapeHtml(slot.name) + '</div>';
      html += '<div class="slot-card-time">' + escapeHtml(slot.start_time || '') + ' - ' + escapeHtml(slot.end_time || '') + '</div>';
      if (hasDates) {
        html += '<div class="slot-card-remaining">共' + slot.dates.length + '天可点歌</div>';
      }
      html += '</div>';
    });
    slotCardsGrid.innerHTML = html;
  }

  async function loadPlaylist() {
    try {
      var data = await apiFetch('/api/songs/list');
      if (data.code === 200 && data.data && data.data.length > 0) {
        var now = new Date();
        var chinaNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);
        var todayStr = chinaNow.toISOString().slice(0, 10);
        var currentTime = chinaNow.toISOString().slice(11, 19);
        var html = '';
        data.data.forEach(function(s, i) {
          var rawDate = s.play_date || '';
          // 提取 YYYY-MM-DD 部分
          var dateStr = rawDate.slice(0, 10) || '';
          // 格式化为可读日期
          var displayDate = dateStr ? dateStr.replace(/-/g, '/') : '未知日期';
          var timeStr = s.slot_name || '';
          var authorStr = s.is_anonymous ? '匿名用户' : (s.author_name || '用户');
          
          // 判断状态：played=已播放，其他判断是否已过时
          var isPlayed = s.status === 'played';
          var isPast = dateStr < todayStr || (dateStr === todayStr && s.end_time && currentTime > s.end_time);
          var isToday = dateStr === todayStr;
          var statusClass = isPlayed ? 'played' : (isToday ? 'waiting' : 'waiting');
          
          var tagsHtml = '';
          if (s.to_whom) tagsHtml += '<span class="song-tag to-whom">💝 ' + escapeHtml(s.to_whom) + '</span>';
          tagsHtml += '<span class="song-tag">📅 ' + escapeHtml(displayDate) + '</span>';
          if (timeStr) tagsHtml += '<span class="song-tag">⏰ ' + escapeHtml(timeStr) + '</span>';
          
          html += '<div class="playlist-item ' + statusClass + '">' +
            '<div class="song-main">' +
              '<div class="song-index">' + String(i+1).padStart(2,'0') + '</div>' +
              '<div class="song-content">' +
                '<div class="song-name">' + escapeHtml(s.song_name) + (s.artist ? '<span class="song-artist">' + escapeHtml(s.artist) + '</span>' : '') + '</div>' +
                '<div class="song-footer">' +
                  '<span class="song-author">🎤 ' + escapeHtml(authorStr) + '</span>' +
                  tagsHtml +
                '</div>' +
                (s.message ? '<div class="song-msg-bubble">' + escapeHtml(s.message) + '</div>' : '') +
              '</div>' +
            '</div>' +
            '<div class="song-status-area">' +
              '<span class="song-status">' + (isPlayed ? '✅ 已播放' : (isToday ? '🔔 待播放' : '⏳ 待播放')) + '</span>' +
            '</div>' +
          '</div>';
        });
        playlist.innerHTML = html;
        playlistEmpty.style.display = 'none';
      } else {
        playlist.innerHTML = '';
        playlistEmpty.style.display = 'block';
      }
    } catch (err) {
      playlist.innerHTML = '';
      playlistEmpty.style.display = 'block';
    }
  }

  async function loadMySongs() {
    var token = localStorage.getItem('token') || '';
    if (!token) {
      document.getElementById('mySongsSection').style.display = 'none';
      return;
    }
    try {
      var data = await apiFetch('/api/songs/my');
      var section = document.getElementById('mySongsSection');
      var list = document.getElementById('mySongsList');
      var empty = document.getElementById('mySongsEmpty');
      if (data.code === 200 && data.data && data.data.length > 0) {
        section.style.display = 'block';
        var html = '';
        data.data.forEach(function(s) {
          var dateStr = s.play_date ? new Date(s.play_date).toLocaleDateString('zh-CN', {year:'numeric',month:'2-digit',day:'2-digit'}) : '未知日期';
          var statusMap = { pending: '待审核', approved: '已通过', played: '已播出', rejected: '已拒绝' };
          var status = statusMap[s.status] || s.status;
          var statusColor = { pending: '#F59E0B', approved: '#10B981', played: '#6B7280', rejected: '#EF4444' }[s.status] || '#9CA3AF';
          var statusBg = { pending: 'rgba(245,158,11,0.12)', approved: 'rgba(16,185,129,0.1)', played: 'rgba(107,114,128,0.08)', rejected: 'rgba(239,68,68,0.1)' }[s.status] || 'rgba(156,163,175,0.08)';
          var can撤回 = s.status === 'pending' || s.status === 'approved';
          var songDate = new Date(s.play_date);
          var isFuture = songDate > new Date();
          html += '<div class="my-song-item">' +
            '<div class="my-song-main">' +
              '<div class="my-song-title">' + escapeHtml(s.song_name) + (s.artist ? '<span style="font-weight:400;font-size:0.88rem;color:#9CA3AF;margin-left:4px;">- ' + escapeHtml(s.artist) + '</span>' : '') + '</div>' +
              '<div class="my-song-meta">' +
                '<span class="my-song-date">' + (s.slot_name ? escapeHtml(s.slot_name) + ' · ' : '') + escapeHtml(dateStr) + '</span>' +
                '<span class="my-song-status" style="color:' + statusColor + ';background:' + statusBg + ';padding-left:18px;">' + status + '</span>' +
              '</div>' +
              (s.to_whom ? '<div class="my-song-recipient">💝 ' + escapeHtml(s.to_whom) + '</div>' : '') +
              (s.message ? '<div class="my-song-msg">💌 ' + escapeHtml(s.message) + '</div>' : '') +
            '</div>' +
            (can撤回 && isFuture ? '<button class="my-song-cancel"><span>撤回</span></button>' : '') +
          '</div>';
        });
        list.innerHTML = html;

        // 绑定撤回事件
        list.querySelectorAll('.my-song-cancel').forEach(function(btn, idx) {
          btn.onclick = function() { 撤回MySong(data.data[idx].id, this); };
        });

        empty.style.display = 'none';
      } else {
        section.style.display = 'none';
      }
    } catch (err) {
      console.error('加载我的点歌失败:', err);
    }
  }

  // 撤回点歌
  window.撤回MySong = async function(id, btn) {
    if (!confirm('确定撤回这首点歌吗？')) return;
    btn.textContent = '撤回中...';
    btn.disabled = true;
    try {
      var data = await apiFetch('/api/songs/' + id, { method: 'DELETE' });
      if (data.code === 200) {
        showToast('撤回成功', 'success');
        loadMySongs();
        loadTimeSlots(); // 更新剩余数量
      } else {
        showToast(data.message || '撤回失败', 'error');
        btn.textContent = '撤回';
        btn.disabled = false;
      }
    } catch (err) {
      showToast('网络错误', 'error');
      btn.textContent = '撤回';
      btn.disabled = false;
    }
  };

  if (radioForm) {
    radioForm.addEventListener('submit', function(e) {
      e.preventDefault();
      var songName = document.getElementById('songName').value.trim();
      var artist = document.getElementById('songArtist').value.trim();
      var toWhom = document.getElementById('songRecipient').value.trim();
      var message = document.getElementById('songMessage').value.trim();
      var slotId = slotSelect.value;
      var dateId = dateSelect.value;
      var isAnonymous = document.getElementById('radioAnonymous').checked;
      var submitBtn = document.getElementById('submitSong');

      if (!songName || !slotId || !dateId) {
        showToast('请填写歌曲名并选择时段和日期', 'error');
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = '提交中...';

      fetch('/api/songs', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + (localStorage.getItem('token') || ''), 'Content-Type': 'application/json' },
        body: JSON.stringify({ song_name: songName, artist: artist, to_whom: toWhom, message: message, slot_id: slotId, slot_date_id: dateId, is_anonymous: isAnonymous })
      }).then(function(r) { return r.json(); }).then(function(data) {
        submitBtn.disabled = false;
        submitBtn.textContent = '提交点歌';
        if (data.code === 200) {
          showToast('点歌成功！', 'success');
          radioForm.reset();
          slotSelect.value = '';
          selectedSlotId = null;
          selectedDateId = null;
          document.querySelectorAll('.slot-card-item').forEach(function(card) {
            card.classList.remove('selected');
          });
          dateSelectGroup.style.display = 'none';
          loadTimeSlots();
          loadPlaylist();
          loadMySongs(); // 刷新我的点歌记录
          // 显示提交成功详情
          var info = songName + (artist ? ' - ' + artist : '');
          var selectedDate = dateSelect.querySelector('option[value="' + dateId + '"]');
          var dateInfo = selectedDate ? selectedDate.textContent : '';
          showSongSubmitConfirm(info, dateInfo, toWhom, message);
        } else {
          showToast(data.message || '提交失败', 'error');
        }
      }).catch(function() {
        submitBtn.disabled = false;
        submitBtn.textContent = '提交点歌';
        showToast('网络错误', 'error');
      });
    });
  }

  // 提交成功后弹出确认框
  function showSongSubmitConfirm(songInfo, dateInfo, toWhom, message) {
    var overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px';
    var content = '<div style="background:#FFF;border-radius:16px;padding:32px 28px;max-width:420px;width:100%;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,0.3)">' +
      '<div style="font-size:52px;margin-bottom:16px">🎵</div>' +
      '<div style="font-size:1.2rem;font-weight:700;color:#1F2937;margin-bottom:20px">点歌提交成功！</div>' +
      '<div style="background:#F3F4F6;border-radius:12px;padding:16px;text-align:left;margin-bottom:20px">';
    content += '<div style="font-size:0.85rem;color:#6B7280;margin-bottom:6px">歌曲</div>';
    content += '<div style="font-size:1rem;font-weight:600;color:#1F2937;margin-bottom:12px">' + escapeHtml(songInfo) + '</div>';
    if (dateInfo) {
      content += '<div style="font-size:0.85rem;color:#6B7280;margin-bottom:6px">播放时段</div>';
      content += '<div style="font-size:0.95rem;color:#374151;margin-bottom:12px">' + escapeHtml(dateInfo) + '</div>';
    }
    if (toWhom) {
      content += '<div style="font-size:0.85rem;color:#6B7280;margin-bottom:6px">送给</div>';
      content += '<div style="font-size:0.95rem;color:#374151;margin-bottom:12px">💝 ' + escapeHtml(toWhom) + '</div>';
    }
    if (message) {
      content += '<div style="font-size:0.85rem;color:#6B7280;margin-bottom:6px">祝福语</div>';
      content += '<div style="font-size:0.95rem;color:#374151">💌 ' + escapeHtml(message) + '</div>';
    }
    content += '</div>';
    content += '<button onclick="this.closest(\'.confirm-overlay\').remove()" style="width:100%;padding:14px;border-radius:10px;border:none;background:linear-gradient(135deg,#FF6B9D,#FF8FAB);color:#FFF;font-size:1rem;font-weight:600;cursor:pointer">知道了</button>';
    content += '</div>';
    overlay.innerHTML = content;
    document.body.appendChild(overlay);
    overlay.onclick = function(e) {
      if (e.target === overlay) overlay.remove();
    };
  }

  // ===== 热门歌曲排行榜 =====
  async function loadHotSongs() {
    try {
      var data = await apiFetch('/api/songs/hot');
      var listEl = document.getElementById('hotSongsList');
      var emptyEl = document.getElementById('hotSongsEmpty');
      
      if (data.code === 200 && data.data && data.data.length > 0) {
        var html = '';
        data.data.forEach(function(song, index) {
          var rank = index + 1;
          var rankIcon = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : rank;
          var hotScore = song.hot_score || 0;
          var hotClass = hotScore > 50 ? 'hot' : hotScore > 20 ? 'warm' : 'normal';
          var authorStr = song.is_anonymous ? '匿名用户' : (song.author_name || '用户');
          
          html += '<div class="hot-song-item" data-song-id="' + song.id + '">' +
            '<div class="hot-song-rank">' + rankIcon + '</div>' +
            '<div class="hot-song-content">' +
              '<div class="hot-song-name">' + escapeHtml(song.song_name) + 
                (song.artist ? '<span class="hot-song-artist"> - ' + escapeHtml(song.artist) + '</span>' : '') +
              '</div>' +
              '<div class="hot-song-meta">' +
                '<span class="hot-song-author">🎤 ' + escapeHtml(authorStr) + '</span>' +
                (song.to_whom ? '<span class="hot-song-recipient">💝 ' + escapeHtml(song.to_whom) + '</span>' : '') +
                (song.message ? '<span class="hot-song-message">💬 ' + escapeHtml(song.message.length > 30 ? song.message.substring(0, 30) + '...' : song.message) + '</span>' : '') +
              '</div>' +
            '</div>' +
            '<div class="hot-song-vote">' +
              '<button class="vote-btn vote-up" onclick="voteSong(' + song.id + ', \'up\', this)" title="热度+1">' +
                '<span class="vote-icon">🔥</span>' +
                '<span class="vote-count">' + hotScore + '</span>' +
              '</button>' +
            '</div>' +
          '</div>';
        });
        listEl.innerHTML = html;
        listEl.style.display = 'block';
        emptyEl.style.display = 'none';
      } else {
        listEl.style.display = 'none';
        emptyEl.style.display = 'block';
      }
    } catch (err) {
      console.error('加载热门歌曲失败:', err);
    }
  }

  // 投票
  window.voteSong = async function(songId, voteType, btn) {
    var token = localStorage.getItem('token') || sessionStorage.getItem('token');
    if (!token) {
      showToast('请先登录', 'error');
      window.location.href = '/login';
      return;
    }

    btn.disabled = true;
    btn.style.opacity = '0.5';

    try {
      var data = await apiFetch('/api/songs/vote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ song_request_id: songId, vote_type: voteType })
      });

      if (data.code === 200) {
        showToast(data.message, 'success');
        // 更新显示的热度
        var countEl = btn.querySelector('.vote-count');
        if (countEl) {
          countEl.textContent = data.data.hot_score;
        }
        // 重新加载排行榜
        loadHotSongs();
      } else {
        showToast(data.message || '投票失败', 'error');
        btn.disabled = false;
        btn.style.opacity = '1';
      }
    } catch (err) {
      showToast('网络错误', 'error');
      btn.disabled = false;
      btn.style.opacity = '1';
    }
  };
});