/**
 * 嘉二の墙墙 - 个人主页模块 (profile.js)
 * 功能：Tab切换、我的帖子/收藏/点歌、修改个人信息、修改密码
 * 后端API返回格式：{ code: 200, message: '...', data: {...} }
 */

// 转换内容中的链接（自动识别并添加风险提示）
function convertContentWithLinks(content) {
  if (!content) return '';
  var escaped = escapeHtml(content).replace(/\n/g, '<br>');
  var myHost = window.location.hostname;
  var linkPattern = /((https?:\/\/)[^\s<>"]+)/gi;
  return escaped.replace(linkPattern, function(match, url) {
    var cleanUrl = url.replace(/^https?:\/\//, '').substring(0, 40);
    var isExternal = !url.includes(myHost) && !url.includes('localhost') && !url.includes('127.0.0.1');
    var onclick = isExternal ? " onclick=\"event.stopPropagation();showExternalLinkWarning('" + escapeHtml(url) + "')\"" : '';
    var cls = isExternal ? ' class="external-link"' : '';
    return '<a href="' + escapeHtml(url) + '"' + cls + onclick + ' target="_blank" rel="noopener noreferrer">' + escapeHtml(cleanUrl) + '</a>';
  });
}

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
  modal.onclick = function(e) { if (e.target === modal) modal.remove(); };
};

function updatePasswordStrength(password) {
  var strengthFill = document.getElementById('strengthFill');
  var strengthText = document.getElementById('strengthText');
  if (!strengthFill || !strengthText) return;

  var length = password.length;
  var hasUpperCase = /[A-Z]/.test(password);
  var hasLowerCase = /[a-z]/.test(password);
  var hasNumbers = /\d/.test(password);
  var hasSpecialChars = /[!@#$%^&*(),.?":{}|<>]/.test(password);

  var score = 0;
  if (length >= 6) score++;
  if (length >= 8) score++;
  if (hasUpperCase && hasLowerCase) score++;
  if (hasNumbers) score++;
  if (hasSpecialChars) score++;

  strengthFill.className = 'strength-meter-fill';

  if (length === 0) {
    strengthText.textContent = '请输入新密码';
    strengthFill.style.width = '0%';
  } else if (score <= 2) {
    strengthFill.classList.add('weak');
    strengthText.textContent = '弱';
    strengthText.style.color = '#EF4444';
  } else if (score <= 3) {
    strengthFill.classList.add('medium');
    strengthText.textContent = '中';
    strengthText.style.color = '#F59E0B';
  } else {
    strengthFill.classList.add('strong');
    strengthText.textContent = '强';
    strengthText.style.color = '#10B981';
  }
}

document.addEventListener('DOMContentLoaded', function() {

  // 检查登录状态
  if (!isLoggedIn()) {
    window.location.href = '/login';
    return;
  }

  // 状态变量
  var currentTab = 'posts';   // 当前激活的Tab
  var isLoading = false;
  var postsCurrentPage = 1;
  var favsCurrentPage = 1;
  var postsTotalPages = 1;
  var favsTotalPages = 1;

  // DOM元素引用
  var profileAvatar = document.getElementById('profileAvatar');
  var profileNickname = document.getElementById('profileNickname');
  var profileJoinTime = document.getElementById('profileJoinTime');
  var postListEl = document.getElementById('tabContent');
  var loadMoreBtn = document.getElementById('loadMoreBtn');

  // ============================================
  // 加载并渲染用户信息
  // ============================================
  async function loadUserInfo() {
    var user = getCurrentUser();
    if (!user) return;

    // 从服务器获取最新完整用户信息（包含 gender/mbti/birthday/hobbies）
    try {
      var token = getToken();
      if (token) {
        var meRes = await fetch('/api/auth/me', {
          headers: { 'Authorization': 'Bearer ' + token }
        });
        var meData = await meRes.json();
        if (meData.code === 200 && meData.data) {
          user = meData.data;
          var remembered = !!localStorage.getItem('token');
          saveAuth(token, user, remembered);
        }
      }
    } catch (e) {
      console.warn('[Profile] 获取最新用户信息失败，使用缓存数据:', e);
    }

    if (profileAvatar) {
      var avatarPath = user.avatar;
      if (!avatarPath || avatarPath === '/images/default-avatar.png') {
        avatarPath = '/uploads/avatars/default.png';
      }
      profileAvatar.src = avatarPath;
      profileAvatar.onerror = function() {
        this.src = '/uploads/avatars/default.png';
        this.onerror = null;
      };
      // ===== 🥚 彩蛋：戳头像 =====
      setupAvatarEasterEgg(profileAvatar);
    }
    if (profileNickname) {
      profileNickname.textContent = user.nickname || user.username || '未设置昵称';
    }
    if (profileJoinTime) {
      var createdAt = user.created_at || user.createdAt;
      if (createdAt) {
        var date = new Date(createdAt);
        var dateStr = date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
        profileJoinTime.textContent = '注册时间：' + dateStr;
      } else {
        profileJoinTime.textContent = '注册时间：--';
      }
    }
    
    // 显示用户身份标签
    var profileInfoEl = document.getElementById('profileInfo');
    if (profileInfoEl && user.role) {
      var roleMap = {
        'super_admin': { text: '🏆 超级管理员', color: '#FFD700', bg: '#FFF8DC' },
        'admin': { text: '👑 管理员', color: '#FF6B9D', bg: '#FFF0F5' },
        'reviewer': { text: '🎖️ 审核员', color: '#3B82F6', bg: '#EBF5FF' },
        'radio_admin': { text: '🎵 电台管理员', color: '#10B981', bg: '#ECFDF5' },
        'user': { text: '🌟 普通用户', color: '#9CA3AF', bg: '#F9FAFB' }
      };
      var roleInfo = roleMap[user.role];
      if (roleInfo) {
        profileInfoEl.innerHTML = '<span style="display: inline-block; padding: 6px 14px; background: ' + roleInfo.bg + '; color: ' + roleInfo.color + '; border-radius: 20px; font-weight: 600; font-size: 0.9rem; margin-top: 8px;">' + roleInfo.text + '</span>';
      }
    }

    // 显示用户资料详情（性别/MBTI/生日/爱好）
    renderProfileDetail(user);

    // 从API加载统计数据（localStorage不包含这些）
    loadProfileStats();

    // 加载邮件通知偏好设置
    loadNotifySettings();

    // 检查是否是管理员，显示管理后台入口
    var adminRoles = ['reviewer', 'radio_admin', 'admin', 'super_admin'];
    // 仅记录是否显示管理入口
    var isAdmin = user.role && adminRoles.indexOf(user.role) !== -1;
    if (isAdmin) {
      var adminBtn = document.getElementById('adminPanelBtn');
      if (adminBtn) {
        adminBtn.style.display = 'block';
      }
    }
  }

  // ===== 🥚 彩蛋：戳头像（完整版 inline） =====
  function setupAvatarEasterEgg(avatarEl) {
    if (!avatarEl || avatarEl.dataset.easterEgg) return;
    avatarEl.dataset.easterEgg = '1';
    avatarEl.style.cursor = 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'32\' height=\'32\'%3E%3Ctext y=\'28\' font-size=\'28\'%3E👆%3C/text%3E%3C/svg%3E"), auto';
    avatarEl.style.touchAction = 'manipulation';

    var totalClicks = parseInt(localStorage.getItem('easter_total_clicks') || '0');
    var sessionClicks = 0;
    var resetTimer = null;
    var usedMsgs = [];

    var msgPools = {
      mild: [
        '呜呜...好痛呀(｡ŏ_ŏ)', '嘤！不要戳了啦~', '咿呀！住手！', '呜哇哇 好过分！',
        '呜呜放过我嘛...', 'QAQ 为什么要欺负我', '别别别戳了 求你了~', '啊呜！你手不酸吗！',
        '唔...戳得好痛', '(´;ω;｀) 怎么还戳呀', '呜呜你戳上瘾了是吧',
        '呀！轻一点嘛...', '嗷呜 我错了还不行吗', '呜...不要！', '再戳要哭给你看了😭',
        '嘤嘤嘤 你是坏人！', '呜哇 你怎么这样！', '唔...好委屈的说'
      ],
      protest: [
        '呜呜呜你真的够了！', '救命呀 有人欺负头像啦🚨', '我好想逃 却逃不掉...',
        '你！到！底！想！怎！样！', '呜呜我要告诉老师！', '再戳一下我真的会哭！',
        '戳戳怪 退！退！退！', '你号没了！！😈', '你！完！了！我咬你哦！',
        '我跟你拼了 呜哇！！', '你你你你怎么还在戳！！', '呜呜你再这样我就...我就...',
        '放过孩子吧呜呜呜', '我做错了什么你要这样对我', '呜呜我受不了了啦！',
        '你是不是不爱我了呜呜', '我都这么惨了你还要戳！'
      ],
      rage: [
        '呜呜呜够啦！！！', '我要哭给你看了！！😭', '救命啊——谁来救救我呀！！',
        '我跟你拼了！！呜呜呜...', '你到底要戳到什么时候呀！！', '呜呜太欺负人了！！',
        '我我我我真的生气了！！(｀へ´)', '够了！！我已经忍你好久了！！',
        '呜呜 你戳死我算了', '哇的一声大哭出来😭😭', '你忍心吗 你良心不会痛吗！',
        '我记得你了 呜呜 你给我等着！', '我最后的尊严都被你戳没了...',
        '呜呜呜 我要离家出走！', '你太过分了真的太过分了！！'
      ],
      despair: [
        '呜呜...我放弃了 你爱戳戳吧', '戳吧戳吧 我已经是个废头像了',
        '我的心已经死了 你开心就好...', '呜呜 我不挣扎了 你赢了',
        '生无可恋 呜呜...', '我已经是一颗没有感情的头像了',
        '哀莫大于心死 你继续吧', '呜呜 活着好难 当个头像一个头像更难',
        '你戳你的 我哭我的 呜...', '我连生气的力气都没有了 呜',
        '随便吧 反正也没人在乎我呜呜', '你戳吧 我已经看破红尘了...'
      ],
      milestone: [
        '🎊 呜呜你把我戳秃了...', '🏆 你是魔鬼吗戳了我',
        '👑 封你为终极戳戳魔王！', '💎 解锁成就：我的眼泪汇成了河',
        '🌟 呜呜你戳了我整整'
      ]
    };

    function getAllMsgs() {
      var a = [];
      for (var k in msgPools) a = a.concat(msgPools[k]);
      return a;
    }

    function getUniqueMsg(pool) {
      var list = pool || getAllMsgs();
      var avail = list.filter(function(m) { return usedMsgs.indexOf(m) === -1; });
      if (avail.length === 0) { usedMsgs = []; avail = list; }
      var msg = avail[Math.floor(Math.random() * avail.length)];
      usedMsgs.push(msg);
      return msg;
    }

    function getMsgBySession(session, total) {
      if (session <= 3) return getUniqueMsg(msgPools.mild);
      else if (session <= 6) return getUniqueMsg(msgPools.protest);
      else if (session <= 9) return getUniqueMsg(msgPools.rage);
      else return getUniqueMsg(msgPools.despair);
    }

    var hearts = ['❤️','💕','💗','💖','💘','💝','✨','⭐','🌸','🌺','🦋','💫'];
    var stars  = ['✨','🌟','⭐','💫','🎇','✨','🌟'];
    var emojis = ['🎉','🎊','🥳','🎈','🎁','🌈','🦄','💎','👑','🌟','🔥','⚡','🌊','🍀','🌈'];

    function spawnParticles(items, count) {
      var wrapper = avatarEl.closest('.profile-avatar-wrapper') || avatarEl.parentElement;
      for (var i = 0; i < count; i++) {
        var el = document.createElement('div');
        el.className = 'easter-particle';
        el.textContent = items[Math.floor(Math.random() * items.length)];
        el.style.left = (10 + Math.random() * 80) + '%';
        el.style.animationDuration = (0.6 + Math.random() * 0.8) + 's';
        el.style.fontSize = (14 + Math.random() * 20) + 'px';
        wrapper.appendChild(el);
        setTimeout(function(e) { e.remove(); }, 1600, el);
      }
    }

    function screenShake(intensity, duration) {
      var body = document.body;
      body.style.transition = 'transform ' + (duration || 300) + 'ms';
      body.style.transform = 'translate(' + (Math.random()*intensity*2-intensity) + 'px,' + (Math.random()*intensity*2-intensity) + 'px)';
      setTimeout(function() { body.style.transform = ''; body.style.transition = ''; }, duration || 300);
    }

    function rainbowGlow(duration) {
      var colors = ['#FF6B9D','#FFD700','#00CED1','#7B68EE','#FF1493','#00FF7F','#FF4500'];
      var i = 0;
      avatarEl.style.transition = 'box-shadow 0.2s';
      var interval = setInterval(function() {
        avatarEl.style.boxShadow = '0 0 ' + (15 + Math.sin(i)*10) + 'px ' + colors[i % colors.length] + ', 0 0 ' + (30 + Math.sin(i*2)*10) + 'px ' + colors[(i+2) % colors.length];
        i++;
        if (i > duration / 200) { clearInterval(interval); avatarEl.style.boxShadow = ''; avatarEl.style.transition = ''; }
      }, 200);
    }

    function emojiRain(count) {
      for (var i = 0; i < count; i++) {
        var em = document.createElement('div');
        em.className = 'easter-rain';
        em.textContent = emojis[Math.floor(Math.random() * emojis.length)];
        em.style.left = Math.random() * 100 + '%';
        em.style.animationDuration = (1.5 + Math.random()) + 's';
        em.style.fontSize = (16 + Math.random() * 18) + 'px';
        document.body.appendChild(em);
        setTimeout(function(e) { e.remove(); }, 3000, em);
      }
    }

    function flashBorder(color) {
      var flash = document.createElement('div');
      flash.className = 'easter-flash';
      flash.style.borderColor = color || '#FF6B9D';
      document.body.appendChild(flash);
      setTimeout(function() { flash.remove(); }, 500);
    }

    var milestoneEffects = {
      10: function() { rainbowGlow(800); spawnParticles(hearts, 15); showBubble('🎊 呜呜你把我戳秃了... (' + totalClicks + '次) 🎉'); },
      20: function() { rainbowGlow(1200); spawnParticles(hearts.concat(stars), 20); screenShake(3, 400); showBubble('🏆 你是魔鬼吗戳了我 ' + totalClicks + '次！！🌟'); flashBorder('#FFD700'); },
      30: function() { rainbowGlow(1500); spawnParticles(hearts.concat(stars, emojis), 25); screenShake(5, 500); emojiRain(8); showBubble('👑 封你为终极戳戳魔王！(' + totalClicks + '次) 我的眼泪汇成了河💎'); flashBorder('#7B68EE'); },
      50: function() { rainbowGlow(2000); spawnParticles(hearts.concat(stars, emojis), 35); screenShake(6, 600); emojiRain(15); showBubble('呜呜 ' + totalClicks + '次了！！你是魔鬼吗放过我！！😭🔥'); flashBorder('#FF4500'); },
      100: function() { rainbowGlow(3000); spawnParticles(hearts.concat(stars, emojis, ['🌌','🌠']), 50); screenShake(8, 800); emojiRain(25); showBubble('🌌 ' + totalClicks + '次... 我已经被你戳到怀疑人生了 你赢了呜呜呜🙇😭'); flashBorder('#FF6B9D'); }
    };

    function triggerMilestone(total) {
      var ms = [100, 50, 30, 20, 10];
      for (var i = 0; i < ms.length; i++) {
        if (total === ms[i] && milestoneEffects[ms[i]]) {
          milestoneEffects[ms[i]]();
          return true;
        }
      }
      return false;
    }

    function bounceEffect(el, intensity) {
      intensity = intensity || 1;
      el.style.transition = 'transform 0.08s';
      el.style.transform = 'scale(' + (0.85 - intensity * 0.02) + ')';
      setTimeout(function(e) { e.style.transform = 'scale(' + (1.1 + intensity * 0.02) + ')'; }, 80, el);
      setTimeout(function(e) { e.style.transform = 'scale(' + (0.95 - intensity * 0.01) + ')'; }, 160, el);
      setTimeout(function(e) { e.style.transform = 'scale(1)'; }, 240, el);
      setTimeout(function(e) { e.style.transition = ''; }, 300, el);
    }

    function showBubble(text) {
      var old = document.querySelector('.easter-bubble');
      if (old) old.remove();
      var wrapper = avatarEl.closest('.profile-avatar-wrapper') || avatarEl.parentElement;
      var bubble = document.createElement('div');
      bubble.className = 'easter-bubble';
      bubble.textContent = text;
      wrapper.appendChild(bubble);
      setTimeout(function() { bubble.remove(); }, 2500);
    }

    function handleTap(e) {
      if (e.type === 'touchstart') e.preventDefault();
      sessionClicks++; totalClicks++;
      clearTimeout(resetTimer);
      resetTimer = setTimeout(function() { sessionClicks = 0; }, 3000);
      localStorage.setItem('easter_total_clicks', String(totalClicks));
      bounceEffect(avatarEl, Math.min(totalClicks / 10, 3));
      spawnParticles(hearts, 2 + Math.floor(Math.random() * 5));
      if (triggerMilestone(totalClicks)) { sessionClicks = 0; return; }
      showBubble(getMsgBySession(sessionClicks, totalClicks));
      if (totalClicks >= 30 && Math.random() < 0.1) emojiRain(3);
      else if (totalClicks >= 50 && Math.random() < 0.15) screenShake(2, 200);
      else if (totalClicks >= 80 && Math.random() < 0.05) flashBorder('#FFD700');
    }

    avatarEl.addEventListener('click', handleTap);
    avatarEl.addEventListener('touchstart', handleTap, { passive: false });
  }
  // 显示用户资料详情（性别/MBTI/生日/爱好）
  window.renderProfileDetail = function(user) {
    var el = document.getElementById('profileDetailInfo');
    if (!el) return;
    var items = [];
    // 性别
    if (user.gender) {
      var genderIcon = { '男':'👦', '女':'👧', '保密':'🤫' };
      items.push('<span class="profile-tag">' + (genderIcon[user.gender] || '') + ' ' + escapeHtml(user.gender) + '</span>');
    }
    // MBTI
    if (user.mbti) {
      items.push('<span class="profile-tag">🧠 ' + escapeHtml(user.mbti) + '</span>');
    }
    // 生日（用Date解析时区，避免UTC偏移导致日期错误）
    if (user.birthday) {
      var bd = user.birthday;
      if (typeof bd === 'string' && (bd.includes('T') || bd.includes(' '))) {
        var d = new Date(bd);
        bd = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      }
      items.push('<span class="profile-tag">🎂 ' + escapeHtml(bd) + '</span>');
    }
    // 爱好
    if (user.hobbies) {
      items.push('<span class="profile-tag">🎯 ' + escapeHtml(user.hobbies) + '</span>');
    }
    el.innerHTML = items.length > 0 ? items.join('') : '';
  }

  // ===== 邮件通知偏好设置 =====
  window.loadNotifySettings = async function() {
    var card = document.getElementById('notifySettingsCard');
    var list = document.getElementById('notifySettingsList');
    if (!card || !list) return;
    
    var user = getCurrentUser();
    if (!user) {
      card.style.display = 'none';
      return;
    }
    
    card.style.display = 'block';
    
    // 没绑定邮箱，显示引导
    if (!user.email) {
      list.innerHTML = '<div class="notify-setting-item" style="grid-column:1/-1;justify-content:center;align-items:center;flex-direction:column;gap:10px;padding:20px;text-align:center;">' +
        '<span style="font-size:0.9rem;color:#9CA3AF;">📭 你还没有绑定邮箱</span>' +
        '<a href="/edit-profile" style="font-size:0.85rem;color:#FF6B9D;font-weight:600;">去编辑资料绑定邮箱 →</a>' +
      '</div>';
      return;
    }
    
    try {
      var json = await authFetch('/api/auth/notify-settings');
      var s;
      if (json && (json.code === 200 || json.code === 404)) {
        // 如果是404错误，使用默认设置
        if (json.code === 404) {
          console.log('通知设置API未找到，使用默认设置');
          s = {
            notify_comment: 1, notify_like: 1, notify_mention: 1,
            notify_follower: 1, notify_post_approved: 1, notify_post_rejected: 1,
            notify_song_approved: 1, notify_song_rejected: 1, notify_song_played: 1,
            notify_feedback_reply: 1, notify_follow_post: 1
          };
        } else {
          s = json.data;
        }
      } else {
        // API无响应或其他错误，也使用默认设置
        console.log('无法加载通知设置，使用默认值');
        s = {
          notify_comment: 1, notify_like: 1, notify_mention: 1,
          notify_follower: 1, notify_post_approved: 1, notify_post_rejected: 1,
          notify_song_approved: 1, notify_song_rejected: 1, notify_song_played: 1,
          notify_feedback_reply: 1, notify_follow_post: 1
        };
      }
      
      var items = [
        { key: 'notify_comment', emoji: '💬', label: '收到评论' },
        { key: 'notify_like', emoji: '❤️', label: '收到点赞' },
        { key: 'notify_mention', emoji: '📢', label: '被提及' },
        { key: 'notify_follower', emoji: '🌟', label: '新粉丝' },
        { key: 'notify_post_approved', emoji: '✅', label: '帖子审核通过' },
        { key: 'notify_post_rejected', emoji: '💔', label: '帖子审核未过' },
        { key: 'notify_song_approved', emoji: '🎵', label: '点歌审核通过' },
        { key: 'notify_song_rejected', emoji: '😢', label: '点歌审核未过' },
        { key: 'notify_song_played', emoji: '🎉', label: '点歌已播放' },
        { key: 'notify_feedback_reply', emoji: '💌', label: '反馈回复' },
        { key: 'notify_follow_post', emoji: '👀', label: '关注的人发帖' }
      ];
      
      list.innerHTML = items.map(function(item) {
        var checked = s[item.key] !== 0 ? 'checked' : '';
        return '<div class="notify-setting-item">' +
          '<span class="notify-setting-label"><span class="notify-emoji">' + item.emoji + '</span> ' + item.label + '</span>' +
          '<label class="notify-switch">' +
            '<input type="checkbox" data-key="' + item.key + '" ' + checked + ' onchange="saveNotifySetting(this)">' +
            '<span class="slider"></span>' +
          '</label>' +
        '</div>';
      }).join('');
    } catch (err) {
      console.error('加载通知偏好失败:', err);
    }
  }

  window.saveNotifySetting = function(el) {
    var key = el.dataset.key;
    var val = el.checked ? 1 : 0;
    var data = {};
    data[key] = val;
    
    authFetch('/api/auth/notify-settings', {
      method: 'PUT',
      body: JSON.stringify(data)
    })
    .then(function(json) {
      if (json && (json.code === 200 || json.code === 404)) {
        // 保存成功或API未部署，显示已保存提示
        showToast('设置保存成功', 'success');
      } else {
        showToast('保存失败: ' + (json?.message || '未知错误'), 'error');
        el.checked = !el.checked;
      }
    })
    .catch(function(err) {
      console.log('保存通知设置失败（可能是API未部署）:', err);
      // 即使API不可用，也显示保存成功（避免用户困惑）
      showToast('设置已保存', 'success');
    });
  }

  // 设置统计数字
  var setStat = function(id, val) {
    var el = document.getElementById(id);
    if (el) el.textContent = val != null ? val : 0;
  };
  // 暴露到全局，供 loadOtherUser 使用
  window.setStat = setStat;

  // 加载个人资料统计数据
  var loadProfileStats = async function() {
    try {
      var user = getCurrentUser();
      var uid = user.id || user.userId;
      if (!uid) return;
      var res = await fetch('/api/profile/' + uid);
      var json = await res.json();
      if (json.code === 200 && json.data) {
        var stats = json.data;
        console.log('[Profile] 统计数据:', stats);
        setStat('profilePostCount', stats.post_count);
        setStat('profileCommentCount', stats.comment_count);
        setStat('profileLikeCount', stats.likes_count);
        setStat('profileFollowerCount', stats.followers_count || 0);
        setStat('profileFollowingCount', stats.following_count || 0);

        // 同步更新 localStorage 中的用户缓存，确保个人资料详情正确显示
        var cachedUser = getCurrentUser();
        if (cachedUser) {
          // 合并 API 返回的完整资料到缓存对象
          Object.assign(cachedUser, stats);
          var remembered = !!localStorage.getItem('token');
          saveAuth(getToken(), cachedUser, remembered);
          // 重新渲染个人资料详情
          renderProfileDetail(cachedUser);
        }
      } else {
        console.warn('[Profile] 统计数据API返回异常:', json);
      }
    } catch (e) {
      console.error('[Profile] 加载统计数据失败:', e);
    }
  };

  // ============================================
  // Tab切换
  // ============================================
  var tabsContainer = document.querySelector('.profile-tabs');
  if (tabsContainer) {
    tabsContainer.addEventListener('click', function(e) {
      var tab = e.target.closest('.profile-tab');
      if (!tab) return;

      // 切换激活状态
      var allTabs = tabsContainer.querySelectorAll('.profile-tab');
      for (var i = 0; i < allTabs.length; i++) {
        allTabs[i].classList.remove('active');
      }
      tab.classList.add('active');

      // 更新当前Tab并加载数据
      currentTab = tab.getAttribute('data-tab') || 'posts';
      loadTabData(false);
    });
  }

  /**
   * 根据当前Tab加载数据
   * @param {boolean} append - 是否追加模式
   */
  function loadTabData(append) {
    if (!append) {
      postsCurrentPage = 1;
      favsCurrentPage = 1;
    }
    switch (currentTab) {
      case 'posts':
        loadMyPosts(append);
        break;
      case 'favorites':
        loadMyFavorites(append);
        break;
      case 'songs':
        loadMySongs(append);
        break;
      case 'notifications':
        loadNotifications(append);
        break;
      default:
        loadMyPosts(append);
    }
  }

  /**
   * 更新加载更多按钮的显示状态
   * @param {number} currentPage
   * @param {number} totalPages
   */
  function updateLoadMoreBtn(currentPage, totalPages) {
    if (loadMoreBtn) {
      if (currentPage >= totalPages) {
        loadMoreBtn.style.display = 'none';
      } else {
        loadMoreBtn.style.display = 'block';
      }
    }
  }
  
  // 暴露到全局，供其他模块使用
  window.updateLoadMoreBtn = updateLoadMoreBtn;
  window.updateNotificationBadge = updateNotificationBadge;
  window.markAllAsRead = markAllAsRead;
  window.markAsRead = markAsRead;
  window.loadNotifications = loadNotifications;
  window.loadNotificationCount = loadNotificationCount;

  // ============================================
  // 加载我的帖子
  // ============================================
  async function loadMyPosts(append) {
    if (isLoading) return;
    isLoading = true;

    if (!append && postListEl) {
      postListEl.innerHTML = '<div style="text-align:center;padding:40px 0;"><p>加载中...</p></div>';
    }

    try {
      var data = await authFetch('/api/posts/user/my?page=' + postsCurrentPage + '&limit=10');
      isLoading = false;

      if (data.code === 200) {
        var posts = data.data.posts || data.data || [];
        postsTotalPages = data.data.totalPages || 1;
        renderPostList(posts, append);
        updateLoadMoreBtn(postsCurrentPage, postsTotalPages);
      } else {
        showToast(data.message || '加载失败', 'error');
        if (!append && postListEl) postListEl.innerHTML = '';
      }
    } catch (err) {
      isLoading = false;
      console.error('加载我的帖子失败:', err);
      showToast('网络错误', 'error');
    }
  }

  // ============================================
  // 加载我的收藏
  // ============================================
  async function loadMyFavorites(append) {
    if (isLoading) return;
    isLoading = true;

    if (!append && postListEl) {
      postListEl.innerHTML = '<div style="text-align:center;padding:40px 0;"><p>加载中...</p></div>';
    }

    try {
      var data = await authFetch('/api/posts/user/favorites?page=' + favsCurrentPage + '&limit=10');
      isLoading = false;

      if (data.code === 200) {
        var posts = data.data.posts || data.data || [];
        favsTotalPages = data.data.totalPages || 1;
        renderPostList(posts, append);
        updateLoadMoreBtn(favsCurrentPage, favsTotalPages);
      } else {
        showToast(data.message || '加载失败', 'error');
        if (!append && postListEl) postListEl.innerHTML = '';
      }
    } catch (err) {
      isLoading = false;
      console.error('加载我的收藏失败:', err);
      showToast('网络错误', 'error');
    }
  }

  // ============================================
  // 加载我的点歌
  // ============================================
  async function loadMySongs(append) {
    if (isLoading) return;
    isLoading = true;

    if (!append && postListEl) {
      postListEl.innerHTML = '<div style="text-align:center;padding:40px 0;"><p>加载中...</p></div>';
    }

    try {
      var data = await authFetch('/api/songs/my');
      isLoading = false;

      if (data.code === 200) {
        var songs = data.data.songs || data.data || [];
        renderSongList(songs, append);
        if (loadMoreBtn) loadMoreBtn.style.display = 'none';
      } else {
        showToast(data.message || '加载失败', 'error');
        if (!append && postListEl) postListEl.innerHTML = '';
      }
    } catch (err) {
      isLoading = false;
      console.error('加载我的点歌失败:', err);
      showToast('网络错误', 'error');
    }
  }

  // ============================================
  // 渲染帖子列表（复用类似home.js的渲染逻辑）
  // ============================================
  function renderPostList(posts, append) {
    if (!postListEl) return;

    if (!posts || posts.length === 0) {
      postListEl.innerHTML = '<div class="empty-state"><p>暂无内容</p></div>';
      return;
    }

    var html = '';
    posts.forEach(function(post) {
      html += renderPostCard(post);
    });

    if (append) {
      postListEl.insertAdjacentHTML('beforeend', html);
    } else {
      postListEl.innerHTML = html;
    }
  }

  /**
   * 渲染单个帖子卡片
   * 字段名匹配后端：author_name, author_avatar, likes_count, comments_count,
   *                 images(JSON字符串), is_anonymous, is_liked, is_favorited, time_ago
   */
  function renderPostCard(post) {
    // 处理images字段
    var images = post.images || [];
    if (typeof images === 'string') {
      try { images = JSON.parse(images); } catch (e) { images = []; }
    }

    var authorName = post.is_anonymous ? '匿名用户' : (post.author_name || '未知用户');
    var authorAvatar = post.is_anonymous ? '/uploads/avatars/default.png' : (post.author_avatar || '/uploads/avatars/default.png');

    // 图片区域
    var imageHtml = '';
    if (images.length > 0) {
      imageHtml = '<div class="post-images image-count-' + Math.min(images.length, 3) + '">';
      images.forEach(function(img) {
        imageHtml += '<img class="post-image" src="' + escapeHtml(img) + '" onclick="event.stopPropagation();previewImage(\'' + escapeHtml(img).replace(/'/g, "\\'") + '\')" loading="lazy">';
      });
      imageHtml += '</div>';
    }

    // 应用缓存的点赞状态（优先使用缓存）
    var cachedLikeStatus = getCachedLikeStatus(post.id);
    var isLiked = cachedLikeStatus !== null ? cachedLikeStatus : (post.is_liked || false);

    // 作者头像和名字可点击显示用户卡片（仅在非匿名且知道用户ID时）
    var authorCardClass = (!post.is_anonymous && post.author_id) ? ' user-card-trigger' : '';
    var authorCardAttr = (!post.is_anonymous && post.author_id) ? ' data-user-id="' + post.author_id + '" style="cursor:pointer;"' : '';
    
    return '<article class="post-card" data-id="' + post.id + '" onclick="window.location.href=\'/post/' + post.id + '\'">' +
      '<div class="post-user">' +
        '<img class="user-avatar' + authorCardClass + '"' + authorCardAttr + ' src="' + escapeHtml(authorAvatar) + '">' +
        '<div class="user-info">' +
          '<div class="user-name' + authorCardClass + '"' + authorCardAttr + '>' + escapeHtml(authorName) + '</div>' +
          '<div class="post-time">' + (post.time_ago || '') + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="post-content">' + escapeHtml(post.content) + '</div>' +
      '<div class="post-views">' +
        '<span class="views-icon">👁️</span>' +
        '<span>' + (post.views || 0) + '</span>' +
      '</div>' +
      imageHtml +
      '<div class="post-actions">' +
        '<button class="action-btn ' + (isLiked ? 'liked' : '') + '" onclick="event.stopPropagation();toggleLike(' + post.id + ',this)">' +
          '<span class="action-icon">' + (isLiked ? '❤️' : '🤍') + '</span>' +
          '<span>' + (post.likes_count || 0) + '</span>' +
        '</button>' +
        '<button class="action-btn" onclick="event.stopPropagation();window.location.href=\'/post/' + post.id + '\'">' +
          '<span class="action-icon">💬</span>' +
          '<span>' + (post.comments_count || 0) + '</span>' +
        '</button>' +
        '<button class="action-btn ' + (post.is_favorited ? 'favorited' : '') + '" onclick="event.stopPropagation();handleProfileFavorite(' + post.id + ', this)">' +
          '<span class="action-icon">' + (post.is_favorited ? '⭐' : '☆') + '</span>' +
        '</button>' +
        '<button class="action-btn delete-btn" onclick="event.stopPropagation();deletePost(' + post.id + ', this)" title="删除帖子" style="color: #EF4444;">' +
          '<span class="action-icon">🗑️</span>' +
        '</button>' +
      '</div>' +
    '</article>';
  }

  // 删除帖子（暴露到全局作用域）
  window.deletePost = async function(postId, btn) {
    // 双重确认，更安全
    if (!confirm('确定要删除这条帖子吗？\n\n删除后不可恢复！')) return;
    if (!confirm('⚠️ 再次确认：真的要删除吗？')) return;
    
    try {
      var data = await authFetch('/api/posts/' + postId, { method: 'DELETE' });
      if (data.code === 200) {
        showToast('删除成功', 'success');
        // 从 DOM 中移除卡片
        var card = btn.closest('.post-card');
        if (card) {
          card.style.opacity = '0';
          card.style.transform = 'translateX(-20px)';
          card.style.transition = 'all 0.3s';
          setTimeout(function() {
            card.remove();
            // 如果没有帖子了，显示空状态
            var postListEl = document.getElementById('tabContent');
            if (postListEl && postListEl.querySelectorAll('.post-card').length === 0) {
              postListEl.innerHTML = '<div class="empty-state"><p>暂无内容</p></div>';
            }
          }, 300);
        }
      } else {
        showToast(data.message || '删除失败', 'error');
      }
    } catch (err) {
      showToast('网络错误', 'error');
    }
  }

  // ============================================
  // 渲染点歌列表
  // ============================================
  function renderSongList(songs, append) {
    if (!postListEl) return;

    if (!songs || songs.length === 0) {
      postListEl.innerHTML = '<div class="empty-state"><p>暂无点歌记录</p></div>';
      return;
    }

    var html = '';
    songs.forEach(function(song) {
      // 状态文本
      var statusText = '待审核';
      var statusClass = 'status-pending';
      if (song.status === 'approved') {
        statusText = '已通过';
        statusClass = 'status-approved';
      } else if (song.status === 'rejected') {
        statusText = '已拒绝';
        statusClass = 'status-rejected';
      } else if (song.status === 'played') {
        statusText = '已播放';
        statusClass = 'status-played';
      }

      // 点歌人
      var isAnonymous = song.is_anonymous;
      var senderName = isAnonymous ? '匿名用户' : '我';

      // 只有待审核状态可以删除
      var deleteBtnHtml = '';
      if (song.status === 'pending') {
        deleteBtnHtml = '<button class="action-btn delete-btn" onclick="event.stopPropagation();deleteSong(' + song.id + ', this)" title="取消点歌" style="color: #EF4444; margin-left: 8px;">' +
          '<span class="action-icon">🗑️</span>' +
        '</button>';
      }

      html += '<div class="post-card">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">' +
          '<div style="display:flex;align-items:center;gap:8px;">' +
            '<span style="font-size:1.3rem;">🎵</span>' +
            '<span style="font-weight:600;">' + escapeHtml(song.song_name || '') + '</span>' +
            '<span style="color:#9CA3AF;font-size:0.85rem;">- ' + escapeHtml(song.artist || '') + '</span>' +
          '</div>' +
          '<div style="display:flex;align-items:center;">' +
            '<span class="status-badge ' + statusClass + '">' + statusText + '</span>' +
            deleteBtnHtml +
          '</div>' +
        '</div>' +
        '<div style="font-size:0.9rem;color:#6B7280;margin-bottom:8px;">' +
          '送给：<span style="color:#FF6B9D;">' + escapeHtml(song.to_whom || '') + '</span>' +
        '</div>' +
        (song.message ? '<div style="font-size:0.9rem;padding:10px;background:#FFF5F7;border-radius:8px;margin-bottom:8px;">' + escapeHtml(song.message) + '</div>' : '') +
        '<div style="display:flex;align-items:center;justify-content:space-between;font-size:0.8rem;color:#9CA3AF;">' +
          '<span>点歌人：' + escapeHtml(senderName) + '</span>' +
          '<span>' + (song.time_ago || formatTime(song.created_at)) + '</span>' +
        '</div>' +
      '</div>';
    });

    if (append) {
      postListEl.insertAdjacentHTML('beforeend', html);
    } else {
      postListEl.innerHTML = html;
    }
  }

  // 取消点歌（暴露到全局作用域）
  window.deleteSong = async function(songId, btn) {
    if (!confirm('确定要取消这首点歌吗？')) return;
    
    try {
      var data = await authFetch('/api/songs/' + songId, { method: 'DELETE' });
      if (data.code === 200) {
        showToast('已取消点歌', 'success');
        // 从 DOM 中移除卡片
        var card = btn.closest('.post-card');
        if (card) {
          card.style.opacity = '0';
          card.style.transform = 'translateX(-20px)';
          card.style.transition = 'all 0.3s';
          setTimeout(function() {
            card.remove();
            // 如果没有点歌记录了，显示空状态
            var postListEl = document.getElementById('tabContent');
            if (postListEl && postListEl.querySelectorAll('.post-card').length === 0) {
              postListEl.innerHTML = '<div class="empty-state"><p>暂无点歌记录</p></div>';
            }
          }, 300);
        }
      } else {
        showToast(data.message || '取消失败', 'error');
      }
    } catch (err) {
      showToast('网络错误', 'error');
    }
  }

  // ============================================
  // 加载更多 + 无限滚动
  // ============================================
  if (loadMoreBtn) {
    loadMoreBtn.addEventListener('click', function() {
      if (currentTab === 'posts') {
        postsCurrentPage++;
        loadMyPosts(true);
      } else if (currentTab === 'favorites') {
        favsCurrentPage++;
        loadMyFavorites(true);
      }
    });
  }

  // 无限滚动：滚动到底部自动加载
  var scrollTimer = null;
  window.addEventListener('scroll', function() {
    if (scrollTimer) return;
    scrollTimer = setTimeout(function() {
      scrollTimer = null;
      if (isLoading) return;
      if (!loadMoreBtn || loadMoreBtn.style.display === 'none') return;
      var scrollTop = window.pageYOffset || document.documentElement.scrollTop;
      var windowHeight = window.innerHeight;
      var docHeight = document.documentElement.scrollHeight;
      if (scrollTop + windowHeight >= docHeight - 300) {
        if (currentTab === 'posts') {
          postsCurrentPage++;
          loadMyPosts(true);
        } else if (currentTab === 'favorites') {
          favsCurrentPage++;
          loadMyFavorites(true);
        }
      }
    }, 300);
  }, { passive: true });

  // ============================================
  // 初始化
  // ============================================
  var viewUserId = getUrlParam('user_id');
  if (viewUserId) {
    loadOtherUser(viewUserId);
  } else {
    loadUserInfo();
    loadTabData(false);
    loadNotificationCount();
  }

  // ============================================
  // 编辑资料功能
  // ============================================
  var editProfileBtn = document.getElementById('editProfileBtn');
  var editModal = document.getElementById('editModal');
  var editModalClose = document.getElementById('editModalClose');
  var editModalCancel = document.getElementById('editModalCancel');
  var editSaveBtn = document.getElementById('editSaveBtn');
  var editNickname = document.getElementById('editNickname');
  var editEmail = document.getElementById('editEmail');
  var editBirthday = document.getElementById('editBirthday');
  var editMbti = document.getElementById('editMbti');
  var editGender = document.getElementById('editGender');
  var editHobbies = document.getElementById('editHobbies');
  var editAvatarPreview = document.getElementById('editAvatarPreview');
  var editAvatarInput = document.getElementById('editAvatarInput');
  var avatarUploadArea = document.getElementById('avatarUploadArea');

  // 打开编辑弹窗
  if (editProfileBtn) {
    editProfileBtn.addEventListener('click', function() {
      var user = getCurrentUser();
      if (editNickname) editNickname.value = user.nickname || '';
      if (editEmail) editEmail.value = user.email || '';
      if (editBirthday) {
        var birthday = user.birthday;
        if (birthday) {
          // 如果是ISO格式的日期字符串，转换为yyyy-MM-dd格式
          if (birthday.includes && birthday.includes('T')) {
            birthday = birthday.split('T')[0];
          }
          editBirthday.value = birthday;
        } else {
          editBirthday.value = '';
        }
      }
      if (editMbti) {
        editMbti.value = user.mbti || '';
      }
      if (editGender) {
        editGender.value = user.gender || '';
        var genderTabs = document.querySelectorAll('.edit-gender-tab');
        genderTabs.forEach(function(tab) {
          tab.style.background = '#fff';
          tab.style.borderColor = '#ddd';
          if (tab.getAttribute('data-value') === user.gender) {
            tab.style.background = 'rgba(255, 107, 157, 0.1)';
            tab.style.borderColor = 'var(--primary)';
          }
        });
      }
      if (editHobbies) editHobbies.value = user.hobbies || '';
      if (editAvatarPreview) editAvatarPreview.src = user.avatar || '/uploads/avatars/default.png';
      if (editModal) editModal.style.display = 'flex';
    });
  }

  // 关闭编辑弹窗
  function closeEditModal() {
    if (editModal) editModal.style.display = 'none';
  }
  if (editModalClose) editModalClose.addEventListener('click', closeEditModal);
  if (editModalCancel) editModalCancel.addEventListener('click', closeEditModal);
  if (editModal) editModal.addEventListener('click', function(e) {
    if (e.target === editModal) closeEditModal();
  });
  
  // 性别选项卡点击
  var genderTabs = document.querySelectorAll('.edit-gender-tab');
  if (genderTabs) {
    genderTabs.forEach(function(tab) {
      tab.addEventListener('click', function() {
        genderTabs.forEach(function(t) { 
          t.style.background = '#fff'; 
          t.style.borderColor = '#ddd';
        });
        tab.style.background = 'var(--primary-light)';
        tab.style.borderColor = 'var(--primary)';
        if (editGender) editGender.value = tab.getAttribute('data-value');
      });
    });
  }

  // 头像上传
  if (avatarUploadArea && editAvatarInput) {
    avatarUploadArea.addEventListener('click', function() {
      editAvatarInput.click();
    });
    editAvatarInput.addEventListener('change', function() {
      var file = this.files[0];
      if (!file) return;
      if (file.size > 2 * 1024 * 1024) {
        showToast('头像图片不能超过2MB', 'error');
        return;
      }
      // 预览
      var reader = new FileReader();
      reader.onload = function(e) {
        editAvatarPreview.src = e.target.result;
      };
      reader.readAsDataURL(file);
      // 上传
      var formData = new FormData();
      formData.append('avatar', file);
      fetch('/api/upload/avatar', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + getToken() },
        body: formData
      }).then(function(res) { return res.json(); }).then(function(data) {
        if (data.code === 200) {
          var user = getCurrentUser();
          user.avatar = data.data.avatar;
          var remembered = !!localStorage.getItem('token');
          saveAuth(getToken(), user, remembered);
          loadUserInfo();
          showToast('头像更新成功');
        } else {
          showToast(data.message || '头像上传失败', 'error');
        }
      }).catch(function() {
        showToast('头像上传失败', 'error');
      });
    });
  }

  // 保存昵称
  if (editSaveBtn) {
    editSaveBtn.addEventListener('click', function() {
      var newNickname = editNickname ? editNickname.value.trim() : '';
      var newEmail = editEmail ? editEmail.value.trim() : '';
      var newBirthday = editBirthday ? editBirthday.value : '';
      var newMbti = editMbti ? editMbti.value : '';
      var newGender = editGender ? editGender.value : '';
      var newHobbies = editHobbies ? editHobbies.value.trim() : '';
      
      if (!newNickname) {
        showToast('昵称不能为空', 'error');
        return;
      }
      if (newNickname.length > 20) {
        showToast('昵称不能超过20个字符', 'error');
        return;
      }
      editSaveBtn.disabled = true;
      editSaveBtn.textContent = '保存中...';
      authFetch('/api/auth/profile', {
        method: 'PUT',
        body: JSON.stringify({ 
          nickname: newNickname,
          email: newEmail || null,
          birthday: newBirthday || null,
          mbti: newMbti || null,
          gender: newGender || null,
          hobbies: newHobbies || null
        })
      }).then(function(data) {
        editSaveBtn.disabled = false;
        editSaveBtn.textContent = '💾 保存';
        if (data.code === 200) {
          var user = getCurrentUser();
          // 更新所有字段
          user.nickname = newNickname;
          user.email = newEmail || null;
          user.birthday = newBirthday || null;
          user.mbti = newMbti || null;
          user.gender = newGender || null;
          user.hobbies = newHobbies || null;
          // 同时更新服务器返回的完整用户信息
          if (data.data) {
            // 确保birthday格式正确（dateStrings模式下始终为字符串）
            if (data.data.birthday) {
              var bdStr = String(data.data.birthday);
              data.data.birthday = bdStr.split('T')[0].split(' ')[0];
            }
            Object.assign(user, data.data);
          }
          var remembered = !!localStorage.getItem('token');
          saveAuth(getToken(), user, remembered);
          loadUserInfo();
          closeEditModal();
          showToast('资料更新成功');
        } else {
          showToast(data.message || '更新失败', 'error');
        }
      }).catch(function() {
        editSaveBtn.disabled = false;
        editSaveBtn.textContent = '保存';
        showToast('网络错误', 'error');
      });
    });
  }

  // ============================================
  // 修改密码功能
  // ============================================
  var passwordPanel = document.getElementById('passwordPanel');
  var passwordPanelClose = document.getElementById('passwordPanelClose');
  var passwordPanelCancel = document.getElementById('passwordPanelCancel');
  var passwordSaveBtn = document.getElementById('passwordSaveBtn');
  var changePasswordBtn = document.getElementById('changePasswordBtn');

  function openPasswordPanel() {
    if (passwordPanel) {
      passwordPanel.style.display = 'flex';
      passwordPanel.classList.add('show');
    }
  }

  function closePasswordPanel() {
    if (passwordPanel) {
      passwordPanel.classList.remove('show');
      setTimeout(function() {
        passwordPanel.style.display = 'none';
      }, 300);
    }
    var oldPwd = document.getElementById('oldPassword');
    var newPwd = document.getElementById('newPassword');
    var confirmPwd = document.getElementById('confirmNewPassword');
    if (oldPwd) oldPwd.value = '';
    if (newPwd) newPwd.value = '';
    if (confirmPwd) confirmPwd.value = '';
    var strengthFill = document.getElementById('strengthFill');
    var strengthText = document.getElementById('strengthText');
    if (strengthFill) strengthFill.style.width = '0%';
    if (strengthText) strengthText.textContent = '请输入新密码';
  }

  if (changePasswordBtn) {
    changePasswordBtn.addEventListener('click', openPasswordPanel);
  }

  if (passwordPanelClose) passwordPanelClose.addEventListener('click', closePasswordPanel);
  if (passwordPanelCancel) passwordPanelCancel.addEventListener('click', closePasswordPanel);
  if (passwordPanel) {
    passwordPanel.addEventListener('click', function(e) {
      if (e.target === passwordPanel) closePasswordPanel();
    });
  }

  document.querySelectorAll('.password-visibility-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var targetId = this.getAttribute('data-target');
      var input = document.getElementById(targetId);
      if (input) {
        if (input.type === 'password') {
          input.type = 'text';
          this.querySelector('.visibility-icon').textContent = '🙈';
        } else {
          input.type = 'password';
          this.querySelector('.visibility-icon').textContent = '👁️';
        }
      }
    });
  });

  if (passwordSaveBtn) {
    passwordSaveBtn.addEventListener('click', function() {
      var oldPwd = document.getElementById('oldPassword').value;
      var newPwd = document.getElementById('newPassword').value;
      var confirmPwd = document.getElementById('confirmNewPassword').value;
      if (!oldPwd || !newPwd || !confirmPwd) {
        showToast('请填写所有密码字段', 'error');
        return;
      }
      if (newPwd.length < 6) {
        showToast('新密码至少需要6个字符', 'error');
        return;
      }
      if (newPwd !== confirmPwd) {
        showToast('两次输入的新密码不一致', 'error');
        return;
      }
      passwordSaveBtn.disabled = true;
      passwordSaveBtn.innerHTML = '<span class="btn-icon">⏳</span><span>处理中...</span>';
      authFetch('/api/auth/password', {
        method: 'PUT',
        body: JSON.stringify({ oldPassword: oldPwd, newPassword: newPwd })
      }).then(function(data) {
        passwordSaveBtn.disabled = false;
        passwordSaveBtn.innerHTML = '<span class="btn-icon">💾</span><span>确认修改</span>';
        if (data.code === 200) {
          closePasswordPanel();
          showToast('密码修改成功，请重新登录');
          setTimeout(function() { logout(); }, 1500);
        } else {
          showToast(data.message || '修改失败', 'error');
        }
      }).catch(function() {
        passwordSaveBtn.disabled = false;
        passwordSaveBtn.innerHTML = '<span class="btn-icon">💾</span><span>确认修改</span>';
        showToast('网络错误', 'error');
      });
    });
  }

});

/**
 * 点赞/取消点赞（全局函数，供帖子卡片onclick调用）
 */
async function toggleLike(postId, btn) {
  if (!requireLogin()) return;
  if (window.isLiking) return;
  window.isLiking = true;
  try {
    var data = await authFetch('/api/posts/' + postId + '/like', { method: 'POST' });
    if (data.code === 200 && data.data && data.data.liked !== undefined) {
      var icon = btn.querySelector('.action-icon');
      var count = btn.querySelector('span:last-child');
      if (data.data.liked) {
        btn.classList.add('liked');
        icon.textContent = '❤️';
        // 使用后端返回的最新点赞数
        if (data.data.likes_count !== undefined) {
          count.textContent = data.data.likes_count;
        }
        // 添加点赞动画
        btn.classList.add('like-animate');
        setTimeout(function() {
          btn.classList.remove('like-animate');
        }, 400);
        // 缓存点赞状态到 localStorage
        cacheLikeStatus(postId, true);
      } else {
        btn.classList.remove('liked');
        icon.textContent = '🤍';
        // 使用后端返回的最新点赞数
        if (data.data.likes_count !== undefined) {
          count.textContent = data.data.likes_count;
        }
        // 缓存点赞状态到 localStorage
        cacheLikeStatus(postId, false);
      }
    } else {
      showToast(data.message || '操作失败', 'error');
    }
  } catch (e) {
    showToast('网络错误', 'error');
  }
  window.isLiking = false;
}

/**
 * 缓存点赞状态到 localStorage
 */
function cacheLikeStatus(postId, isLiked) {
  try {
    var cache = JSON.parse(localStorage.getItem('likeCache') || '{}');
    cache[postId] = {
      isLiked: isLiked,
      timestamp: Date.now()
    };
    localStorage.setItem('likeCache', JSON.stringify(cache));
  } catch (e) {
    console.error('缓存点赞状态失败:', e);
  }
}

/**
 * 从缓存获取点赞状态
 */
function getCachedLikeStatus(postId) {
  try {
    var cache = JSON.parse(localStorage.getItem('likeCache') || '{}');
    var cached = cache[postId];
    if (cached && Date.now() - cached.timestamp < 3600000) { // 1小时有效期
      return cached.isLiked;
    }
  } catch (e) {}
  return null;
}

/**
 * 收藏/取消收藏（全局函数，供帖子卡片onclick调用）
 */
async function toggleFavorite(postId, btn) {
  if (!requireLogin()) return;
  try {
    var data = await authFetch('/api/posts/' + postId + '/favorite', { method: 'POST' });
    if (data.code === 200) {
      var icon = btn.querySelector('.action-icon');
      if (data.data.favorited) {
        btn.classList.add('favorited');
        icon.textContent = '⭐';
      } else {
        btn.classList.remove('favorited');
        icon.textContent = '☆';
      }
    } else {
      showToast(data.message || '操作失败', 'error');
    }
  } catch (e) {
    showToast('网络错误', 'error');
  }
}

/**
 * 加载通知列表
 */
var notificationsCurrentPage = 1;
var notificationsTotalPages = 1;
var notificationsLoading = false;

async function loadNotifications(append) {
  if (notificationsLoading) return;
  notificationsLoading = true;

  var notificationsContainer = document.getElementById('tabContent');
  if (!append && notificationsContainer) {
    notificationsContainer.innerHTML = '<div style="text-align:center;padding:40px 0;"><p>加载中...</p></div>';
  }

  try {
    var data = await authFetch('/api/notifications?page=' + notificationsCurrentPage + '&limit=20');
    notificationsLoading = false;

    if (data.code === 200) {
      var notifications = data.data.notifications || [];
      notificationsTotalPages = Math.ceil(data.data.total / 20) || 1;
      renderNotifications(notifications, append);
      updateLoadMoreBtn(notificationsCurrentPage, notificationsTotalPages);
      
      // 更新未读数量
      updateNotificationBadge(data.data.unread || 0);
    } else {
      showToast(data.message || '加载失败', 'error');
      if (!append && notificationsContainer) notificationsContainer.innerHTML = '';
    }
  } catch (err) {
    notificationsLoading = false;
    console.error('加载通知失败:', err);
    showToast('网络错误', 'error');
  }
}

/**
 * 渲染通知列表
 */
function renderNotifications(notifications, append) {
  var notificationsContainer = document.getElementById('tabContent');
  if (!notificationsContainer) return;

  if (!notifications || notifications.length === 0) {
    notificationsContainer.innerHTML = '<div class="notification-empty">' +
      '<div class="notification-empty-icon">🔔</div>' +
      '<div class="notification-empty-text">暂无通知</div>' +
    '</div>';
    return;
  }

  var html = '';
  
  // 添加工具栏
  if (!append) {
    html += '<div class="notification-toolbar">' +
      '<button class="btn-mark-all" onclick="markAllAsRead()">✓ 全部标记为已读</button>' +
      '<button class="btn-clear-all" onclick="clearAllNotifications()">🗑️ 清空通知</button>' +
    '</div>';
  }

  notifications.forEach(function(notification) {
    var iconClass = notification.type || 'system';
    var iconMap = {
      'comment': '💬',
      'like': '❤️',
      'system': '🔔',
      'mention': '@'
    };
    var icon = iconMap[iconClass] || '🔔';
    
    var timeAgo = getTimeAgo(notification.created_at);
    var unreadClass = notification.is_read === 0 ? 'unread' : '';
    
    html += '<div class="notification-item ' + unreadClass + '" data-id="' + notification.id + '">' +
      '<div class="notification-icon ' + iconClass + '">' + icon + '</div>' +
      '<div class="notification-content">' +
        '<div class="notification-title">' + escapeHtml(notification.title) + '</div>' +
        '<div class="notification-text">' + escapeHtml(notification.content || '') + '</div>' +
        '<div class="notification-time">' + timeAgo + '</div>' +
        '<div class="notification-actions">' +
          '<button class="btn-read" onclick="markAsRead(' + notification.id + ', this)">已读</button>' +
          '</div>' +
      '</div>' +
    '</div>';
  });

  var notificationsContainer = document.getElementById('tabContent');
  if (append) {
    notificationsContainer.insertAdjacentHTML('beforeend', html);
  } else {
    notificationsContainer.innerHTML = html;
  }
}

/**
 * 标记单条通知为已读
 */
async function markAsRead(notificationId, btn) {
  try {
    // 标记已读 = 删除通知（直接调用删除接口）
    var data = await authFetch('/api/notifications/' + notificationId, { method: 'DELETE' });
    console.log('[通知] 删除响应:', data);
    if (data.code === 200) {
      var item = btn.closest('.notification-item');
      if (item) {
        item.style.transition = 'opacity 0.3s, transform 0.3s';
        item.style.opacity = '0';
        item.style.transform = 'translateX(20px)';
        setTimeout(function() {
          item.remove();
          // 更新未读数量
          loadNotificationCount();
          // 检查是否为空
          var container = document.getElementById('tabContent');
          if (container && container.querySelectorAll('.notification-item').length === 0) {
            container.innerHTML = '<div style="text-align:center;padding:40px 0;color:#9CA3AF;">暂无通知</div>';
          }
        }, 300);
      }
    }
  } catch (err) {
    console.error('[通知] 删除失败:', err);
    showToast('操作失败', 'error');
  }
}

/**
 * 标记所有通知为已读
 */
async function markAllAsRead() {
  try {
    var data = await authFetch('/api/notifications/read-all', { method: 'PUT' });
    console.log('[通知] 标记全部已读响应:', data);
    if (data.code === 200) {
      showToast('已清空所有通知', 'success');
      // 删除所有通知（带动画）
      var container = document.getElementById('tabContent');
      var items = container ? container.querySelectorAll('.notification-item') : [];
      items.forEach(function(item, index) {
        setTimeout(function() {
          item.style.transition = 'opacity 0.3s, transform 0.3s';
          item.style.opacity = '0';
          item.style.transform = 'translateX(20px)';
          setTimeout(function() { item.remove(); }, 300);
        }, index * 50);
      });
      // 全部删除后显示空状态
      setTimeout(function() {
        if (container) {
          container.innerHTML = '<div style="text-align:center;padding:40px 0;color:#9CA3AF;">暂无通知</div>';
        }
        // 更新徽章
        if (typeof window.updateNotificationBadge === 'function') {
          window.updateNotificationBadge(0);
        }
      }, items.length * 50 + 400);
    } else {
      showToast(data.message || '标记失败', 'error');
    }
  } catch (err) {
    console.error('[通知] 标记全部已读失败:', err);
    showToast('操作失败', 'error');
  }
}

/**
 * 删除单条通知
 */
async function deleteNotification(notificationId, btn) {
  if (!confirm('确定要删除这条通知吗？')) return;
  
  try {
    var data = await authFetch('/api/notifications/' + notificationId, { method: 'DELETE' });
    if (data.code === 200) {
      var item = btn.closest('.notification-item');
      if (item) {
        item.style.opacity = '0';
        item.style.transform = 'translateX(-20px)';
        item.style.transition = 'all 0.3s';
        setTimeout(function() {
          item.remove();
        }, 300);
      }
      // 更新未读数量
      loadNotificationCount();
    }
  } catch (err) {
    showToast('删除失败', 'error');
  }
}

/**
 * 清空所有通知
 */
async function clearAllNotifications() {
  if (!confirm('确定要清空所有通知吗？此操作不可恢复！')) return;
  
  try {
    var data = await authFetch('/api/notifications', { method: 'DELETE' });
    if (data.code === 200) {
      showToast('已清空所有通知', 'success');
      notificationsCurrentPage = 1;
      loadNotifications(false);
    }
  } catch (err) {
    showToast('清空失败', 'error');
  }
}

/**
 * 更新通知徽章
 */
function updateNotificationBadge(count) {
  var badge = document.getElementById('notificationBadge');
  if (badge) {
    if (count > 0) {
      badge.textContent = count > 99 ? '99+' : count;
      badge.style.display = 'inline-flex';
    } else {
      badge.style.display = 'none';
    }
  }
}

/**
 * 加载未读通知数量
 */
async function loadNotificationCount() {
  try {
    var data = await authFetch('/api/notifications/unread-count');
    if (data.code === 200) {
      updateNotificationBadge(data.data.count || 0);
    }
  } catch (err) {
    console.error('加载未读数量失败:', err);
  }
}

/**
 * 获取相对时间
 */
function getTimeAgo(dateStr) {
  if (!dateStr) return '';
  
  var now = new Date();
  var date = new Date(dateStr);
  var diff = Math.floor((now - date) / 1000);
  
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + '分钟前';
  if (diff < 86400) return Math.floor(diff / 3600) + '小时前';
  if (diff < 2592000) return Math.floor(diff / 86400) + '天前';
  
  return date.toLocaleDateString('zh-CN');
}

/**
 * HTML转义
 */
function escapeHtml(text) {
  if (!text) return '';
  var div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// 获取URL参数
function getUrlParam(name) {
  if (window.URLSearchParams) {
    return new URLSearchParams(window.location.search).get(name) || null;
  }
  var match = window.location.search.match(new RegExp('[?&]' + name + '=([^&#]*)'));
  return match ? decodeURIComponent(match[1] || '') : null;
}

// 加载其他用户的资料
async function loadOtherUser(userId) {
  console.log('[Profile-Other] 开始加载用户资料, userId:', userId);
  var btns = document.querySelectorAll('.btn-edit-profile, #changePasswordBtn, #adminPanelBtn');
  btns.forEach(function(b) { b.style.display = 'none'; });

  var profileAvatar = document.getElementById('profileAvatar');
  var profileNickname = document.getElementById('profileNickname');
  var profileJoinTime = document.getElementById('profileJoinTime');
  var profileInfoEl = document.getElementById('profileInfo');
  var tabContent = document.getElementById('tabContent');

  if (!userId || userId === 'null' || userId === 'undefined') {
    console.error('[Profile-Other] 无效的userId:', userId);
    if (profileNickname) profileNickname.textContent = '用户ID无效';
    return;
  }

  // 优先使用 fetch，失败时降级到 XMLHttpRequest
  var json;
  try {
    var url = '/api/profile/' + userId;
    console.log('[Profile-Other] 请求URL:', url);
    var res = await fetch(url);
    if (!res.ok) {
      console.error('[Profile-Other] HTTP错误:', res.status, res.statusText);
      json = null;
    } else {
      json = await res.json();
    }
  } catch (fetchErr) {
    console.warn('[Profile-Other] fetch失败，降级到XHR:', fetchErr.message);
    json = await new Promise(function(resolve) {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', '/api/profile/' + userId, true);
      xhr.onreadystatechange = function() {
        if (xhr.readyState === 4) {
          try { resolve(JSON.parse(xhr.responseText)); }
          catch(e) { resolve(null); }
        }
      };
      xhr.onerror = function() { resolve(null); };
      xhr.send();
    });
  }

  if (json && json.code === 200) {
    try {
      var user = json.data;
      console.log('[Profile-Other] 用户资料:', user);
      if (profileAvatar) profileAvatar.src = user.avatar || '/uploads/avatars/default.png';
      if (profileNickname) profileNickname.textContent = user.nickname || user.username;
      if (profileJoinTime) {
        var d = user.created_at ? new Date(user.created_at).toLocaleDateString('zh-CN', { year:'numeric', month:'long', day:'numeric' }) : '--';
        profileJoinTime.textContent = '注册时间：' + d;
      }
      if (profileInfoEl && user.role) {
        var roleMap = { super_admin:'🏆 超级管理员', admin:'👑 管理员', reviewer:'🎖️ 审核员', radio_admin:'🎵 电台管理员', user:'🌟 普通用户' };
        profileInfoEl.innerHTML = '<span style="display:inline-block;padding:6px 14px;background:#F3F4F6;color:#6B7280;border-radius:20px;font-weight:600;font-size:0.9rem;margin-top:8px;">' + (roleMap[user.role] || '普通用户') + '</span>';
      }
      renderProfileDetail(user);
      setStat('profilePostCount', user.post_count);
      setStat('profileCommentCount', user.comment_count);
      setStat('profileLikeCount', user.likes_count);
      setStat('profileFollowerCount', user.followers_count || 0);
      setStat('profileFollowingCount', user.following_count || 0);
      var tabs = document.querySelector('.profile-tabs');
      if (tabs) tabs.style.display = 'none';
      var loadMore = document.getElementById('loadMoreBtn');
      if (loadMore) loadMore.style.display = 'none';
      if (tabContent) {
        tabContent.innerHTML = '<div style="text-align:center;padding:30px;color:#999;">加载中...</div>';
        fetch('/api/posts?user_id=' + userId + '&limit=20&t=' + Date.now())
          .then(function(r) { return r.json(); })
          .then(function(j) {
            if (j.code === 200 && j.data && j.data.posts && j.data.posts.length > 0) {
              tabContent.innerHTML = j.data.posts.map(function(p) {
                var title = p.title || '';
                var txt = p.content || '';
                if (txt.length > 80) txt = txt.substring(0,80) + '…';
                return '<div class="post-card" data-id="' + p.id + '" onclick="window.location.href=\'/post/' + p.id + '\'" style="margin-bottom:10px;padding:14px;border:1px solid var(--border-color);border-radius:12px;cursor:pointer;background:var(--bg-card);">' +
                  (title ? '<div style="font-size:0.95rem;font-weight:600;color:var(--text-primary);margin-bottom:4px;">' + escapeHtml(title) + '</div>' : '') +
                  '<div style="font-size:0.85rem;color:var(--text-secondary);margin-bottom:6px;">' + escapeHtml(txt) + '</div>' +
                  '<div style="font-size:0.75rem;color:var(--text-light);">❤️ ' + (p.likes_count||0) + '  💬 ' + (p.comments_count||0) + '  👁️ ' + (p.views||0) + '</div>' +
                '</div>';
              }).join('');
            } else {
              tabContent.innerHTML = '<div style="text-align:center;padding:40px;color:#999;">该用户暂无帖子</div>';
            }
          })
          .catch(function(err) { console.error('[Profile-Other] 加载帖子失败:', err); tabContent.innerHTML = '<div style="text-align:center;padding:40px;color:#999;">加载失败</div>'; });
      }
    } catch (err) {
      // 渲染出错时，把错误信息显示在页面上
      console.error('[Profile-Other] 渲染错误:', err);
      var errMsg = err.message || String(err);
      if (profileNickname) profileNickname.textContent = '❌ ' + errMsg;
      if (tabContent) tabContent.innerHTML = '<div style="text-align:center;padding:40px;color:#EF4444;font-size:13px;">❌ ' + escapeHtml(errMsg) + '</div>';
    }
  } else {
    if (profileNickname) profileNickname.textContent = '用户不存在或数据异常';
    if (tabContent) tabContent.innerHTML = '<div style="text-align:center;padding:40px;color:#999;">用户不存在或数据异常</div>';
  }
}


