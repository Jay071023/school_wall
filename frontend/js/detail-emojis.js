/**
 * detail-emojis.js - Emoji picker and mention functionality
 */

var mentionedUsersList = window.CampusWallMentionedUsers || []; // 艾特用户列表
window.CampusWallMentionedUsers = mentionedUsersList;

/**
 * 初始化表情选择器
 */
function initEmojiPicker() {
  var btnEmoji = document.getElementById('btnEmoji');
  var emojiPicker = document.getElementById('emojiPicker');
  var emojiGrid = document.getElementById('emojiGrid');
  if (!btnEmoji || !emojiGrid) return;

  var emojis = ['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','😊','😇','🥰','😍','🤩','😘','😋','😛','🤪','😜','🤗','🤭','🙄','😒','😌','😔','😴','🤤','😷','🤒','🤕','🤢','🥵','🥶','🥴','🤯','🤠','🥳','😎','🤓','🧐','😺','😸','😹','😻','😼','😽','🙀','😿','😾','👋','👏','🙌','👐','🤲','🙏','💪','🤝','👍','👎','👊','✊','🤛','🤜','☝️','✋','🤚','🖐️','🖖','👌','🤌','✌️','🤘','🤟','👈','👉','👆','🖕','👇','☝️','👍','👎','✊','👊','💯','🔥','⭐','🌟','💫','✨','💥','💢','💬','💭','🗯️','💤','🏃','🚶','💃','🕺','🏄','🏊','🚴','🚵','🎮','🎯','🎲','🧩','🎭','🎨','🎬','🎤','🎧','🎵','🎶','🎹','🎸','🎺','🎷','🪘','🎻','🏆','🥇','🥈','🥉','🏅','🎖','🏵','🎗','🎫','🎟','🎪','🤹','🎭','🛋️','🛍️','🛒','📱','💻','🖥️','⌨️','🖱️','🖲','💽','💾','💿','📀','📼','📷','📸','📹','🎥','📽️','🎞️','📞','☎️','📟','📠','📺','📻','🧭','⏰','⏱️','⏲️','🕰️','⌚','📡','🔋','🔌','💡','🔦','🕯️','🧯','🛢️','💸','💵','💴','💶','💷','💰','💳','💎','⚖️','🔧','🔨','⚒️','🛠️','⛏️','🔩','⚙️','🧱','⛓️','🧲','🔫','💣','🧨','🪓','🔪','🗡️','⚔️','🛡️','🚬','⚰️','🪦','⚱️','🏺','🔮','📿','🧿','💈','⚗️','🔭','🔬','🕳️','🩹','🩺','💊','💉','🩸','🧬','🦠','🧫','🧪','🌡️','🧹','🪠','🧷','🧸','🧰','🧲','🧳','🧱','📌','📍','✂️','🖊️','🖋️','✒️','📏','📐','🗃️','🗄️','🗑️','📈','📉','📊','📋','📌','📍','🗒️','🗓️','📔','📕','📖','📗','📘','📙','📚','📃','📄','📑','🗞️','📰','🗼','🗽','⛪','🕌','🛕','🕍','⛩️','🕋','⛲','⛺','🌁','🌂','☂️','⛱️','🌤️','⛅','🌥️','☁️','🌦️','🌧️','⛈️','🌩️','🌨️','❄️','☃️','⛄','🌬️','💨','🌪️','🌫️','🌪️','☔','⚡','🌈','☔','🌂'];

  var html = '';
  emojis.forEach(function(emoji) {
    html += '<div class="emoji-item" onclick="insertEmoji(\'' + emoji.replace(/'/g, "\\'") + '\')">' + emoji + '</div>';
  });
  emojiGrid.innerHTML = html;

  // 点击外部关闭
  document.addEventListener('click', function(e) {
    if (!btnEmoji.contains(e.target) && !emojiPicker.contains(e.target)) {
      emojiPicker.style.display = 'none';
    }
  });

  btnEmoji.addEventListener('click', function(e) {
    e.stopPropagation();
    emojiPicker.style.display = emojiPicker.style.display === 'none' ? 'block' : 'none';
  });
}

/**
 * 插入表情到评论输入框
 */
window.insertEmoji = function(emoji) {
  var input = document.getElementById('commentInput');
  if (!input) return;
  var cursorPos = input.selectionStart;
  var value = input.value;
  input.value = value.substring(0, cursorPos) + emoji + value.substring(cursorPos);
  input.focus();
  input.setSelectionRange(cursorPos + emoji.length, cursorPos + emoji.length);
  document.getElementById('emojiPicker').style.display = 'none';
};

/**
 * 显示艾特选择器（手动触发）
 */
window.showMentionPicker = function() {
  var input = document.getElementById('commentInput');
  if (!input) return;
  mentionInput = input;
  var cursorPos = input.selectionStart;
  var value = input.value;
  var textBeforeCursor = value.substring(0, cursorPos);
  // 在光标位置插入@
  var newValue = textBeforeCursor + '@' + value.substring(cursorPos);
  input.value = newValue;
  input.focus();
  input.setSelectionRange(cursorPos + 1, cursorPos + 1);
  // 触发搜索
  searchTimeout = setTimeout(function() {
  searchUsers('', true);
  }, 300);
};

// ========== Mention functionality (embedded from detail.js) ==========

var mentionPopup = null;
var mentionInput = null;
var mentionSelectIndex = -1;
var searchTimeout = null;

function createMentionPopup() {
  if (mentionPopup) return;
  mentionPopup = document.createElement('div');
  mentionPopup.className = 'mention-popup';
  mentionPopup.style.display = 'none';
  document.body.appendChild(mentionPopup);
}

function showMentionPopup(users, query, inputEl) {
  createMentionPopup();
  if (!users || users.length === 0) {
    mentionPopup.style.display = 'none';
    return;
  }

  var isMobile = window.innerWidth <= 768;
  var html = '';
  users.forEach(function(user, index) {
    var roleText = '';
    if (user.role && user.role !== 'user') {
      var roleMap = {
        'super_admin': '🏆',
        'admin': '👑',
        'reviewer': '🎖️',
        'radio_admin': '🎵'
      };
      roleText = roleMap[user.role] || '';
    }

    var displayName = user.nickname || user.username || '用户';
    var username = user.username || displayName;
    var avatar = user.avatar || '/uploads/avatars/default.png';
    html += '<button type="button" class="mention-item" data-index="' + index + '" data-id="' + user.id + '" data-name="' + escapeHtml(displayName) + '" data-username="' + escapeHtml(username) + '">' +
      '<img class="mention-avatar" src="' + escapeHtml(avatar) + '" alt="">' +
      '<span class="mention-info">' +
        '<strong class="mention-name">' + escapeHtml(displayName) + (roleText ? '<span class="mention-role">' + roleText + '</span>' : '') + '</strong>' +
        '<span class="mention-username">@' + escapeHtml(username) + '</span>' +
      '</span>' +
    '</button>';
  });

  mentionPopup.innerHTML = html;
  mentionSelectIndex = 0;
  updateMentionSelection();

  // 定位弹窗
  if (isMobile) {
    // 移动端固定在底部
    mentionPopup.style.display = 'block';
    mentionPopup.style.bottom = '10px';
    mentionPopup.style.top = 'auto';
    mentionPopup.style.left = '10px';
    mentionPopup.style.right = '10px';
  } else {
    // PC端定位在输入框下方
    var rect = inputEl.getBoundingClientRect();
    var popupHeight = mentionPopup.offsetHeight || 200;
    var viewportHeight = window.innerHeight;
    var spaceBelow = viewportHeight - rect.bottom;

    // 如果下方空间不够，弹到上方
    if (spaceBelow < popupHeight + 10) {
      mentionPopup.style.top = (rect.top + window.scrollY - popupHeight - 5) + 'px';
    } else {
      mentionPopup.style.top = (rect.bottom + window.scrollY + 5) + 'px';
    }
    mentionPopup.style.left = rect.left + 'px';
    mentionPopup.style.right = 'auto';
    mentionPopup.style.bottom = 'auto';
    mentionPopup.style.display = 'block';
  }

  // 绑定点击事件
  mentionPopup.querySelectorAll('.mention-item').forEach(function(item) {
    item.addEventListener('click', function() {
      var userId = parseInt(this.dataset.id);
      var userName = this.dataset.username || this.dataset.name;
      selectMention(userId, userName, inputEl);
    });
  });
}

function hideMentionPopup() {
  if (mentionPopup) {
    mentionPopup.style.display = 'none';
  }
  mentionSelectIndex = -1;
}

function updateMentionSelection() {
  if (!mentionPopup) return;
  var items = mentionPopup.querySelectorAll('.mention-item');
  items.forEach(function(item, index) {
    item.classList.toggle('is-selected', index === mentionSelectIndex);
  });
}

async function searchUsers(query, allowEmpty) {
  if ((!query || query.length < 1) && !allowEmpty) {
    hideMentionPopup();
    return;
  }

  // 检查是否登录
  if (!isLoggedIn()) {
    return;
  }

  try {
    var data = await authFetch('/api/posts/search-users?q=' + encodeURIComponent(query) + '&limit=8');
    if (data && data.code === 200) {
      if (data.data.users && data.data.users.length > 0) {
        showMentionPopup(data.data.users, query, mentionInput);
      } else {
        hideMentionPopup();
        showToast('没有找到匹配的用户', 'info');
      }
    } else if (data && data.code === 401) {
      showToast('请先登录后再使用艾特功能', 'warning');
    }
  } catch (err) {
    console.error('搜索用户失败:', err);
    showToast('搜索用户失败', 'error');
  }
}

function selectMention(userId, userName, inputEl) {
  var input = inputEl || document.getElementById('commentInput');
  if (!input) return;

  // 在@符号后插入用户名
  var value = input.value;
  var cursorPos = input.selectionStart;

  // 找到最后一个@的位置
  var atIndex = value.lastIndexOf('@', cursorPos - 1);
  if (atIndex === -1) return;

  // 替换@xxx为@username
  var before = value.substring(0, atIndex);
  var after = value.substring(cursorPos);
  var newValue = before + '@' + userName + ' ' + after;

  input.value = newValue;
  input.focus();

  // 设置光标位置
  var newPos = atIndex + userName.length + 2;
  setTimeout(function() {
    input.setSelectionRange(newPos, newPos);
  }, 0);

  // 添加到艾特列表
  if (!mentionedUsersList.includes(userId)) {
    mentionedUsersList.push(userId);
  }

  hideMentionPopup();
}

function extractMentions(content) {
  var mentions = [];
  var regex = /@(\S+)/g;
  var match;
  while ((match = regex.exec(content)) !== null) {
    var username = match[1];
    // 这里简化处理，实际应该通过API查询用户ID
    // 由于我们已经在选择时记录了mentionedUsersList，可以直接使用
  }
  return mentionedUsersList;
}

// 评论输入框的@监听
var commentInput = document.getElementById('commentInput');
if (!window.__detailMentionInputBound && commentInput) {
  commentInput.addEventListener('input', function(e) {
    var cursorPos = this.selectionStart;
    var value = this.value;

    // 检查是否在@后面
    var textBeforeCursor = value.substring(0, cursorPos);
    var lastAtIndex = textBeforeCursor.lastIndexOf('@');

    if (lastAtIndex !== -1) {
      var textAfterAt = textBeforeCursor.substring(lastAtIndex + 1);
      // 如果@后面没有空格或特殊字符
      if (!textAfterAt.includes(' ') && !textAfterAt.includes('\n')) {
        mentionInput = this;
        if (searchTimeout) clearTimeout(searchTimeout);
        searchTimeout = setTimeout(function() {
          searchUsers(textAfterAt, textAfterAt.length === 0);
        }, 300);
      } else {
        hideMentionPopup();
      }
    } else {
      hideMentionPopup();
    }
  });

  // 上下键选择艾特用户
  commentInput.addEventListener('keydown', function(e) {
    if (mentionPopup && mentionPopup.style.display !== 'none') {
      var users = mentionPopup.querySelectorAll('.mention-item');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        mentionSelectIndex = Math.min(mentionSelectIndex + 1, users.length - 1);
        updateMentionSelection();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        mentionSelectIndex = Math.max(mentionSelectIndex - 1, 0);
        updateMentionSelection();
      } else if (e.key === 'Enter' && mentionSelectIndex >= 0) {
        e.preventDefault();
        var selectedItem = users[mentionSelectIndex];
        if (selectedItem) {
          var userId = parseInt(selectedItem.dataset.id);
          var userName = selectedItem.dataset.username || selectedItem.dataset.name;
          selectMention(userId, userName, this);
        }
      } else if (e.key === 'Escape') {
        hideMentionPopup();
      }
    }
  });
}
