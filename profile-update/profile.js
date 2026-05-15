/**
 * 嘉二の墙墙 - 个人主页模块 (profile.js)
 * 功能：Tab切换、我的帖子/收藏/点歌、修改个人信息、修改密码
 * 后端API返回格式：{ code: 200, message: '...', data: {...} }
 */

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
  function loadUserInfo() {
    var user = getCurrentUser();
    if (!user) return;

    if (profileAvatar) {
      profileAvatar.src = user.avatar || '/uploads/avatars/default.png';
    }
    if (profileNickname) {
      profileNickname.textContent = user.nickname || user.username || '未设置昵称';
    }
    if (profileJoinTime) {
      var createdAt = user.created_at || user.createdAt;
      profileJoinTime.textContent = createdAt ? '注册时间：' + formatTime(createdAt) : '注册时间：--';
    }

    // 渲染个人标签
    var tagsEl = document.getElementById('profileInfoTags');
    if (tagsEl) {
      var tags = [];
      if (user.gender) tags.push('🛍️ ' + user.gender);
      if (user.mbti) tags.push('🧠 ' + user.mbti);
      if (user.birthday) tags.push('🎂 ' + user.birthday);
      if (user.hobbies) {
        var hobbyList = user.hobbies.split(/[,，、]/).slice(0, 5);
        hobbyList.forEach(function(h) { if (h.trim()) tags.push('❤️ ' + h.trim()); });
      }
      tagsEl.innerHTML = tags.map(function(t) {
        return '<span style="display:inline-block;padding:3px 10px;border-radius:20px;font-size:0.75rem;background:var(--bg-secondary);color:var(--text-secondary);">' + t + '</span>';
      }).join('');
    }
  }

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

    return '<article class="post-card" onclick="window.location.href=\'/post/' + post.id + '\'">' +
      '<div class="post-user">' +
        '<img class="user-avatar" src="' + escapeHtml(authorAvatar) + '">' +
        '<div class="user-info">' +
          '<div class="user-name">' + escapeHtml(authorName) + '</div>' +
          '<div class="post-time">' + (post.time_ago || '') + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="post-content">' + escapeHtml(post.content) + '</div>' +
      imageHtml +
      '<div class="post-actions">' +
        '<button class="action-btn ' + (post.is_liked ? 'liked' : '') + '" onclick="event.stopPropagation();toggleLike(' + post.id + ',this)">' +
          '<span class="action-icon">' + (post.is_liked ? '❤️' : '🤍') + '</span>' +
          '<span>' + (post.likes_count || 0) + '</span>' +
        '</button>' +
        '<button class="action-btn" onclick="event.stopPropagation();window.location.href=\'/post/' + post.id + '\'">' +
          '<span class="action-icon">💬</span>' +
          '<span>' + (post.comments_count || 0) + '</span>' +
        '</button>' +
        '<button class="action-btn ' + (post.is_favorited ? 'favorited' : '') + '" onclick="event.stopPropagation();toggleFavorite(' + post.id + ',this)">' +
          '<span class="action-icon">' + (post.is_favorited ? '⭐' : '☆') + '</span>' +
        '</button>' +
      '</div>' +
    '</article>';
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
      }

      // 点歌人
      var isAnonymous = song.is_anonymous;
      var senderName = isAnonymous ? '匿名用户' : '我';

      html += '<div class="post-card">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">' +
          '<div style="display:flex;align-items:center;gap:8px;">' +
            '<span style="font-size:1.3rem;">🎵</span>' +
            '<span style="font-weight:600;">' + escapeHtml(song.song_name || '') + '</span>' +
            '<span style="color:#9CA3AF;font-size:0.85rem;">- ' + escapeHtml(song.artist || '') + '</span>' +
          '</div>' +
          '<span class="status-badge ' + statusClass + '">' + statusText + '</span>' +
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
  });

  // ============================================
  // 初始化
  // ============================================
  loadUserInfo();
  loadTabData(false);

  // ============================================
  // 修改密码功能
  // ============================================
  var passwordModal = document.getElementById('passwordModal');
  var passwordModalClose = document.getElementById('passwordModalClose');
  var passwordModalCancel = document.getElementById('passwordModalCancel');
  var passwordSaveBtn = document.getElementById('passwordSaveBtn');
  var changePasswordBtn = document.getElementById('changePasswordBtn');

  // 独立的修改密码按钮
  if (changePasswordBtn) {
    changePasswordBtn.addEventListener('click', function() {
      if (passwordModal) passwordModal.style.display = 'flex';
    });
  }

  function closePasswordModal() {
    if (passwordModal) passwordModal.style.display = 'none';
    var oldPwd = document.getElementById('oldPassword');
    var newPwd = document.getElementById('newPassword');
    var confirmPwd = document.getElementById('confirmNewPassword');
    if (oldPwd) oldPwd.value = '';
    if (newPwd) newPwd.value = '';
    if (confirmPwd) confirmPwd.value = '';
  }
  if (passwordModalClose) passwordModalClose.addEventListener('click', closePasswordModal);
  if (passwordModalCancel) passwordModalCancel.addEventListener('click', closePasswordModal);
  if (passwordModal) passwordModal.addEventListener('click', function(e) {
    if (e.target === passwordModal) closePasswordModal();
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
      passwordSaveBtn.textContent = '修改中...';
      authFetch('/api/auth/password', {
        method: 'PUT',
        body: JSON.stringify({ old_password: oldPwd, new_password: newPwd })
      }).then(function(data) {
        passwordSaveBtn.disabled = false;
        passwordSaveBtn.textContent = '修改密码';
        if (data.code === 200) {
          closePasswordModal();
          showToast('密码修改成功，请重新登录');
          setTimeout(function() { logout(); }, 1500);
        } else {
          showToast(data.message || '修改失败', 'error');
        }
      }).catch(function() {
        passwordSaveBtn.disabled = false;
        passwordSaveBtn.textContent = '修改密码';
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
  try {
    var data = await authFetch('/api/posts/' + postId + '/like', { method: 'POST' });
    if (data.code === 200) {
      var icon = btn.querySelector('.action-icon');
      var count = btn.querySelector('span:last-child');
      if (data.data.liked) {
        btn.classList.add('liked');
        icon.textContent = '❤️';
        count.textContent = parseInt(count.textContent) + 1;
      } else {
        btn.classList.remove('liked');
        icon.textContent = '🤍';
        count.textContent = parseInt(count.textContent) - 1;
      }
    } else {
      showToast(data.message || '操作失败', 'error');
    }
  } catch (e) {
    showToast('网络错误', 'error');
  }
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
