/**
 * detail-emojis.js - Emoji picker and mention functionality
 */

var mentionedUsersList = []; // 艾特用户列表

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
    searchUsers('');
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
  // 移动端适配样式
  var isMobile = window.innerWidth <= 768;
  var popupStyles = isMobile ?
    'display: none; position: fixed; background: white; border: 1px solid #ddd; border-radius: 12px; box-shadow: 0 -4px 20px rgba(0,0,0,0.15); max-height: 50vh; overflow-y: auto; z-index: 10000; width: calc(100% - 20px); left: 10px !important; right: 10px; bottom: 10px;' :
    'display: none; position: absolute; background: white; border: 1px solid #ddd; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); max-height: 200px; overflow-y: auto; z-index: 1000; min-width: 200px; max-width: 300px;';
  mentionPopup.style.cssText = popupStyles;
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

    var itemStyle = isMobile ?
      'padding: 12px; cursor: pointer; border-bottom: 1px solid #f0f0f0; display: flex; align-items: center; gap: 12px; min-height: 60px;' :
      'padding: 10px; cursor: pointer; border-bottom: 1px solid #f0f0f0; display: flex; align-items: center; gap: 8px;';
    var imgStyle = isMobile ?
      'width: 44px; height: 44px; border-radius: 50%; object-fit: cover;' :
      'width: 32px; height: 32px; border-radius: 50%; object-fit: cover;';
    var nameStyle = isMobile ?
      'font-weight: 600; font-size: 1rem;' :
      'font-weight: 600;';
    var usernameStyle = isMobile ?
      'font-size: 0.9rem; color: #999;' :
      'font-size: 0.85rem; color: #999;';

    html += '<div class="mention-item" data-index="' + index + '" data-id="' + user.id + '" data-name="' + (user.nickname || user.username) + '" style="' + itemStyle + '">' +
      '<img src="' + (user.avatar || '/uploads/avatars/default.png') + '" style="' + imgStyle + '">' +
      '<div style="flex: 1; overflow: hidden;">' +
        '<div style="' + nameStyle + '">' + escapeHtml(user.nickname || user.username) + ' <span style="color: #FF6B9D;">' + roleText + '</span></div>' +
        '<div style="' + usernameStyle + '">@' + escapeHtml(user.username) + '</div>' +
      '</div>' +
    '</div>';
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
      var userName = this.dataset.name;
      selectMention(userId, userName, inputEl);
    });
    // 触摸反馈
    item.addEventListener('touchstart', function() {
      this.style.background = '#f0f7ff';
    });
    item.addEventListener('touchend', function() {
      this.style.background = 'white';
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
    if (index === mentionSelectIndex) {
      item.style.background = '#f0f7ff';
    } else {
      item.style.background = 'white';
    }
  });
}

async function searchUsers(query) {
  if (!query || query.length < 1) {
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
  var input = inputEl || commentInput;
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
if (commentInput) {
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
          searchUsers(textAfterAt);
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
          var userName = selectedItem.dataset.name;
          selectMention(userId, userName, this);
        }
      } else if (e.key === 'Escape') {
        hideMentionPopup();
      }
    }
  });
}