/**
 * 嘉二人の墙墙 - 首页模块 (home.js)
 * 功能：帖子列表加载、分类筛选、排序切换、点赞/收藏、分页加载
 * 后端返回字段：author_name, author_avatar, author_id, likes_count, comments_count,
 *               images(JSON字符串需parse), is_anonymous, is_liked, is_favorited, time_ago
 */

var emptyStateEl = null;
var currentPage = 1;
var currentCategory = '全部';
var currentSort = 'latest';
var currentKeyword = '';
var isLoading = false;
var isLiking = false; // 防止点赞重复触发
var emptyStateEl = null;
var skeletonShown = false;
var pageInitialized = false;
var totalLoaded = 0; // 已加载的总条数
var hasMore = true; // 是否还有更多数据

// 骨架屏HTML - 简化版本，减少DOM操作
function showSkeleton(count) {
  var postListEl = document.getElementById('postList');
  if (!postListEl) return;
  
  // 直接用简单的loading文字，不要复杂的骨架屏
  postListEl.innerHTML = '<div style="text-align:center;padding:40px 0;color:#999;">' +
    '<div style="font-size:2rem;margin-bottom:10px;">⏳</div>' +
    '<div style="font-size:0.9rem;">加载中...</div>' +
  '</div>';
  skeletonShown = true;
}

// 隐藏骨架屏
function hideSkeleton() {
  skeletonShown = false;
}

// 更新分页信息显示 - 已删除（无限滚动模式不需要）

/**
 * 记录帖子浏览量（QQ空间风格）
 * - 1分钟内同一帖子不重复计数
 * - 兼容游客和登录用户
 */
function recordPostView(postId) {
  var key = 'viewed_' + postId;
  var lastView = localStorage.getItem(key);
  var now = Date.now();

  // 1分钟内不重复计数
  if (lastView && (now - parseInt(lastView)) < 60000) {
    return;
  }

  localStorage.setItem(key, now);
  // 异步发送请求，不阻塞页面
  fetch('/api/posts/' + postId + '/view', {
    method: 'POST',
    credentials: 'include'
  }).catch(function() {});
}

/**
 * 初始化浏览量观察器（滚动到可见即计数，QQ空间风格）
 */
var viewObserver = null;
function initViewObserver() {
  if (viewObserver) {
    viewObserver.disconnect();
  }

  // 兼容移动端和PC端，观察所有帖子卡片
  viewObserver = new IntersectionObserver(function(entries) {
    entries.forEach(function(entry) {
      if (entry.isIntersecting) {
        var postCard = entry.target.closest('.post-card[data-id]');
        if (postCard) {
          var postId = postCard.dataset.id;
          if (postId) {
            recordPostView(postId);
            // 观察一次后取消，避免重复触发
            viewObserver.unobserve(entry.target);
          }
        }
      }
    });
  }, {
    // 元素50%可见时触发
    threshold: 0.5,
    // 增加rootMargin，确保移动端也能正确触发
    rootMargin: '0px 0px -50px 0px'
  });

  // 观察所有帖子卡片
  document.querySelectorAll('.post-card[data-id]').forEach(function(card) {
    viewObserver.observe(card);
  });
}

// 页面滚动时动态观察新加载的帖子
window.addEventListener('scroll', function() {
  if (viewObserver) {
    document.querySelectorAll('.post-card[data-id]:not([data-view-observed])').forEach(function(card) {
      card.setAttribute('data-view-observed', 'true');
      viewObserver.observe(card);
    });
  }
}, { passive: true });

/**
 * 加载帖子列表（无限滚动模式）
 * @param {boolean} append - 是否追加模式
 */
async function loadPosts(append) {
  if (isLoading) return;
  if (!hasMore) return;
  isLoading = true;

  var postListEl = document.getElementById('postList');
  var loadMoreWrapper = document.querySelector('.load-more-wrapper');

  // 首次加载显示简单 loading
  if (!append && !skeletonShown && postListEl) {
    postListEl.innerHTML = '<div style="text-align:center;padding:60px 0;color:#999;font-size:0.95rem;">⏳ 加载中...</div>';
  }

  try {
    // 每次加载 10 条，使用 offset
    var url = '/api/posts?limit=10&offset=' + totalLoaded + '&category=' + encodeURIComponent(currentCategory) + '&sort=' + currentSort;
    if (currentKeyword) url += '&keyword=' + encodeURIComponent(currentKeyword);
    var data = await authFetch(url);

    isLoading = false;
    hideSkeleton();

    if (data.code === 200) {
      var posts = data.data.posts || [];

      if (posts.length === 0 && !append) {
        if (postListEl) {
          postListEl.innerHTML = '';
        }
        if (emptyStateEl) emptyStateEl.style.display = 'block';
        if (loadMoreWrapper) loadMoreWrapper.style.display = 'none';
        hasMore = false;
        return;
      }

      if (emptyStateEl) emptyStateEl.style.display = 'none';

      // 预缓存images字段，减少重复JSON.parse和JSON.stringify
      posts.forEach(function(post) {
        if (typeof post.images === 'string') {
          try { post._cachedImages = JSON.parse(post.images); } catch(e) { post._cachedImages = []; }
        } else {
          post._cachedImages = post.images || [];
        }
        post._cachedImagesJson = JSON.stringify(post._cachedImages).replace(/"/g, '&quot;');
      });

      var html = '';
      posts.forEach(function(post) {
        html += renderPostCard(post);
      });
      
      if (postListEl) {
        if (append) {
          // 追加模式：添加到现有内容后面
          postListEl.insertAdjacentHTML('beforeend', html);
        } else {
          // 首次加载：清空后插入
          postListEl.innerHTML = html;
        }
      }

      // 更新已加载总数
      totalLoaded += posts.length;

      // 初始化浏览量观察器（QQ空间风格：滚动到可见即计数）
      initViewObserver();

      // 判断是否还有更多
      hasMore = (totalLoaded < data.data.total);

      // 控制加载更多按钮显示
      if (loadMoreWrapper) {
        if (!hasMore) {
          // 没有更多数据，隐藏加载更多
          loadMoreWrapper.style.display = 'none';
        } else {
          // 还有更多数据，显示加载更多
          loadMoreWrapper.style.display = 'block';
          if (loadMoreBtn) loadMoreBtn.style.display = 'block';
        }
      }
    } else {
      showToast(data.message || '加载失败', 'error');
    }
  } catch (err) {
    console.error('加载帖子失败:', err);
    // 如果是追加模式（无限滚动），静默重试一次
    if (append && totalLoaded > 0) {
      setTimeout(function() {
        loadPosts(true);
      }, 2000);
      // 不显示 toast 避免打扰用户
    } else {
      showToast('网络错误，请稍后重试', 'error');
    }
  } finally {
    isLoading = false;
    hideSkeleton();
  }
}

/**
 * 渲染单个帖子卡片HTML
 * 字段名匹配后端：author_name, author_avatar, likes_count, comments_count,
 *                 images(JSON字符串), is_anonymous, is_liked, is_favorited, time_ago
 * @param {Object} post - 帖子数据对象
 * @returns {string} 帖子卡片HTML字符串
 */
/**
 * 获取角色标签 HTML
 */
function getRoleBadge(role) {
  if (!role || role === 'user') return '';
  
  var roleMap = {
    'super_admin': { text: '👑 超级管理员', class: 'role-badge role-super-admin' },
    'admin': { text: '🛡️ 管理员', class: 'role-badge role-admin' },
    'reviewer': { text: '✅ 审核员', class: 'role-badge role-reviewer' },
    'radio_admin': { text: '📻 广播管理员', class: 'role-badge role-radio-admin' }
  };
  
  var roleInfo = roleMap[role];
  if (!roleInfo) return '';
  
  return '<span class="' + roleInfo.class + '">' + roleInfo.text + '</span>';
}

/**
 * 获取用户头衔 HTML
 */
function getUserTitlesHtml(titles) {
  if (!titles || titles.length === 0) return '';
  
  return titles.map(function(t) {
    var safeColor = t.title_color || '#FF6B9D';
    var safeBg = t.title_bg || 'rgba(255,107,157,0.1)';
    var safeIcon = t.icon || '⭐';
    var safeName = escapeHtml(t.title_name);
    return '<span class="title-badge" style="display:inline-block;padding:2px 8px;border-radius:12px;font-size:0.7rem;font-weight:600;background:' + safeBg + ';color:' + safeColor + ';margin-right:4px;white-space:nowrap;">' + safeIcon + ' ' + safeName + '</span>';
  }).join('');
}

function renderPostCard(post) {
  // 处理images字段（可能是JSON字符串）- 缓存处理结果
  var images = post._cachedImages || (post.images || []);
  if (typeof images === 'string') {
    try {
      images = JSON.parse(images);
    } catch (e) {
      images = [];
    }
    post._cachedImages = images;
  }

  // 处理匿名用户
  var authorName = post.is_anonymous ? '匿名用户' : (post.author_name || '未知用户');
  var authorAvatar = post.is_anonymous ? '/uploads/avatars/default.png' : (post.author_avatar || '/uploads/avatars/default.png');

  // 获取角色标签（匿名用户不显示）
  var roleBadge = post.is_anonymous ? '' : getRoleBadge(post.author_role);

  // 获取头衔标签（匿名用户不显示）
  var titleBadges = post.is_anonymous ? '' : getUserTitlesHtml(post.author_titles);

  // 图片区域 HTML - 微信朋友圈风格
  var imageHtml = '';
  if (images.length > 0) {
    var displayImages = images.slice(0, 3);
    var imageCount = displayImages.length;
    var gridClass = 'image-count-' + (imageCount <= 3 ? imageCount : 'many');
    imageHtml = '<div class="post-images ' + gridClass + '">';
    displayImages.forEach(function(img) {
      imageHtml += '<div class="post-image-wrapper" onclick="event.stopPropagation();previewImage(\'' + escapeHtml(img).replace(/'/g, "\\'") + '\', ' + post._cachedImagesJson + ', 0)">' +
        '<img class="post-image" src="' + escapeHtml(img) + '" loading="lazy">' +
      '</div>';
    });
    if (images.length > 3) {
      imageHtml += '<div class="post-image-more" onclick="event.stopPropagation();previewImage(\'' + escapeHtml(images[0]).replace(/'/g, "\\'") + '\', ' + post._cachedImagesJson + ', 0)">+' + (images.length - 3) + '</div>';
    }
    imageHtml += '</div>';
  }

  var safePostId = post.id || 0;
  var cachedLikeStatus = getCachedLikeStatus(safePostId);
  var isLiked = cachedLikeStatus !== null ? cachedLikeStatus : (post.is_liked || false);

  // 评论预览
  var commentsPreviewHtml = '';
  if (post.preview_comments && post.preview_comments.length > 0) {
    var commentItems = [];
    post.preview_comments.forEach(function(comment) {
      var cAuthor = comment.is_anonymous ? '匿名用户' : (comment.author_name || '未知用户');
      var cRole = comment.is_anonymous ? '' : getRoleBadge(comment.author_role);
      var cTitles = comment.is_anonymous ? '' : getUserTitlesHtml(comment.author_titles);
      var cClass = !comment.is_anonymous && comment.author_id ? ' user-card-trigger' : '';
      var cAttr = !comment.is_anonymous && comment.author_id ? ' data-user-id="' + comment.author_id + '" style="cursor:pointer;"' : '';
      commentItems.push('<div class="comment-preview-item"><span class="comment-preview-author' + cClass + '"' + cAttr + '>' + escapeHtml(cAuthor) + cRole + cTitles + '</span><span class="comment-preview-text">' + escapeHtml(comment.content) + '</span></div>');
    });
    if (post.comments_count > post.preview_comments.length) {
      commentItems.push('<div class="comment-preview-more">查看全部 ' + post.comments_count + ' 条评论</div>');
    }
    commentsPreviewHtml = '<div class="post-comments-preview">' + commentItems.join('') + '</div>';
  }

  var titleHtml = post.title ? '<div class="post-title">' + escapeHtml(post.title) + '</div>' : '';
  var authorCardClass = !post.is_anonymous && post.author_id ? ' user-card-trigger' : '';
  var authorCardAttr = !post.is_anonymous && post.author_id ? ' data-user-id="' + post.author_id + '" style="cursor:pointer;"' : '';

  return '<article class="post-card" data-id="' + safePostId + '" onclick="openPostDetail(' + safePostId + ')">' +
    '<div class="post-user">' +
      '<img class="user-avatar' + authorCardClass + '" src="' + escapeHtml(authorAvatar) + '"' + authorCardAttr + '>' +
      '<div class="user-info">' +
        '<div class="user-name' + authorCardClass + '"' + authorCardAttr + '>' + escapeHtml(authorName) + roleBadge + titleBadges + '</div>' +
        '<div class="post-time">' + (post.time_ago || '') + (post.ip_region ? ' · 📍' + escapeHtml(post.ip_region) : '') + '</div>' +
      '</div>' +
    '</div>' +
    titleHtml +
    '<div class="post-content">' + (post.is_pinned ? '<span style="margin-right:4px;">📌</span>' : '') + convertContentWithLinks(post.content) + '</div>' +
    imageHtml +
    commentsPreviewHtml +
    '<div class="post-actions">' +
      '<button class="action-btn ' + (isLiked ? 'liked' : '') + '" onclick="event.stopPropagation();toggleLike(' + safePostId + ',this)">' +
        '<span class="action-icon">' + (isLiked ? '❤️' : '🤍') + '</span>' +
        '<span>' + (post.likes_count || 0) + '</span>' +
      '</button>' +
      '<button class="action-btn" onclick="event.stopPropagation();openPostDetail(' + safePostId + ')">' +
        '<span class="action-icon">💬</span>' +
        '<span>' + (post.comments_count || 0) + '</span>' +
      '</button>' +
      '<button class="action-btn" onclick="event.stopPropagation();openPostDetail(' + safePostId + ')">' +
        '<span class="action-icon">👁️</span>' +
        '<span>' + (post.views || 0) + '</span>' +
      '</button>' +
      '<button class="action-btn ' + (post.is_favorited ? 'favorited' : '') + '" onclick="event.stopPropagation();toggleFavorite(' + safePostId + ',this)">' +
        '<span class="action-icon">' + (post.is_favorited ? '⭐' : '☆') + '</span>' +
      '</button>' +
    '</div>' +
  '</article>';
}

// 打开帖子详情
function openPostDetail(postId) {
  window.location.href = '/post/' + postId;
}

/**
 * 点赞/取消点赞
 * @param {number} postId - 帖子ID
 * @param {HTMLElement} btn - 按钮元素
 */
async function toggleLike(postId, btn) {
  if (!requireLogin()) { isLiking = false; return; }
  if (isLiking) return;
  isLiking = true;

  try {
    var data = await authFetch('/api/posts/' + postId + '/like', { method: 'POST' });
    if (data.code === 200 && data.data && data.data.liked !== undefined) {
      var icon = btn.querySelector('.action-icon');
      var count = btn.querySelector('span:last-child');
      if (data.data.liked) {
        btn.classList.add('liked');
        icon.textContent = '❤️';
        if (data.data.likes_count !== undefined) {
          count.textContent = data.data.likes_count;
        }
        btn.classList.add('like-animate');
        setTimeout(function() {
          btn.classList.remove('like-animate');
        }, 400);
        cacheLikeStatus(postId, true);
      } else {
        btn.classList.remove('liked');
        icon.textContent = '🤍';
        if (data.data.likes_count !== undefined) {
          count.textContent = data.data.likes_count;
        }
        cacheLikeStatus(postId, false);
      }
    } else {
      showToast(data.message || '操作失败', 'error');
    }
  } catch (err) {
    console.error('点赞失败:', err);
    showToast('操作失败', 'error');
  }
  isLiking = false;
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
 * 收藏/取消收藏
 * @param {number} postId - 帖子ID
 * @param {HTMLElement} btn - 按钮元素
 */
async function toggleFavorite(postId, btn) {
  if (!requireLogin()) return;

  var data = await authFetch('/api/posts/' + postId + '/favorite', { method: 'POST' });
  if (data.code === 200) {
    var icon = btn.querySelector('.action-icon');
    if (data.data.favorited) {
      btn.classList.add('favorited');
      icon.textContent = '⭐';
      // 添加收藏动画
      btn.classList.add('favorite-animate');
      setTimeout(function() {
        btn.classList.remove('favorite-animate');
      }, 500);
    } else {
      btn.classList.remove('favorited');
      icon.textContent = '☆';
    }
  } else {
    showToast(data.message || '操作失败', 'error');
  }
}

// ============================================
// 首页加载点歌播放列表（非阻塞，不会卡住主页面）
// ============================================
async function loadHomePlaylist() {
  var container = document.getElementById('homePlaylist');
  if (!container) {
    return;
  }

  try {
    container.innerHTML = '<div class="playlist-empty">暂无播放曲目</div>';
    
    var response = await fetch('/api/songs/list', {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });
    
    if (!response.ok) {
      container.innerHTML = '<div class="playlist-empty">暂无播放曲目</div>';
      return;
    }
    
    var rawText = await response.text();
    var data;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      container.innerHTML = '<div class="playlist-empty">暂无播放曲目</div>';
      return;
    }

    if (!data || data.code !== 200) {
      container.innerHTML = '<div class="playlist-empty">暂无播放曲目</div>';
      return;
    }

    var songs = data.data;
    
    if (!songs || !Array.isArray(songs) || songs.length === 0) {
      container.innerHTML = '<div class="playlist-empty">暂无播放曲目，快去点一首吧~ 🎵</div>';
      return;
    }
    
    // 获取当前中国时间
    var now = new Date();
    var chinaTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    var currentTime = chinaTime.toISOString().slice(11, 19);
    
    var html = '';
    songs.forEach(function(song, index) {
      var isPlaying = false;
      if (song.status === 'approved' && song.start_time && song.end_time) {
        isPlaying = currentTime >= song.start_time && currentTime <= song.end_time;
      }

      // 隐藏已播放的歌曲
      if (song.status === 'played') return;

      var statusText, statusClass;
      if (song.status === 'played') {
        statusText = '已播放';
        statusClass = 'played';
      } else if (song.status === 'approved') {
        if (isPlaying) {
          statusText = '播放中';
          statusClass = 'playing';
        } else if (currentTime < song.start_time) {
          statusText = '待播放';
          statusClass = 'waiting';
        } else {
          statusText = '等待播放';
          statusClass = 'waiting';
        }
      } else {
        statusText = '排队中';
        statusClass = 'waiting';
      }
      
      var artistInfo = song.artist ? ' - ' + escapeHtml(song.artist) : '';
      var timeStr = song.slot_name || '';
      var dateStr = song.play_date || '';
      var authorStr = song.is_anonymous ? '匿名用户' : (song.author_name || '用户');
      
      html += '<div class="playlist-item ' + statusClass + '">' +
        '<span class="song-index">' + (index + 1) + '</span>' +
        '<div class="song-info">' +
          '<span class="song-name">' + escapeHtml(song.song_name || '') + artistInfo + '</span>' +
          '<span class="song-meta">🎤 ' + escapeHtml(authorStr) + (dateStr ? ' · 📅 ' + dateStr : '') + (timeStr ? ' · ⏰ ' + escapeHtml(timeStr) : '') + '</span>' +
        '</div>' +
        '<span class="song-status">' + statusText + '</span>' +
      '</div>';
    });
    
    container.innerHTML = html;
  } catch (err) {
    container.innerHTML = '<div class="playlist-empty">暂无播放曲目</div>';
  }
}

// 显示用户资料弹窗
window.showUserProfileModal = async function(userId) {
  if (!userId) return;
  
  // 创建弹窗
  var modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity 0.3s;';
  
  modal.innerHTML = '<div class="modal" style="background:#fff;border-radius:16px;padding:32px;max-width:400px;width:90%;max-height:80vh;overflow-y:auto;position:relative;">' +
    '<button class="modal-close" style="position:absolute;top:16px;right:16px;background:none;border:none;font-size:24px;cursor:pointer;color:#999;" onclick="this.closest(\'.modal-overlay\').remove()">✕</button>' +
    '<div id="user-profile-content" style="text-align:center;padding:20px 0;">' +
      '<div style="font-size:2rem;margin-bottom:10px;">⏳</div>' +
      '<div style="color:#999;">加载中...</div>' +
    '</div>' +
  '</div>';
  
  document.body.appendChild(modal);
  
  // 延迟显示动画
  setTimeout(function() {
    modal.style.opacity = '1';
  }, 10);
  
  // 点击背景关闭
  modal.onclick = function(e) {
    if (e.target === modal) {
      modal.style.opacity = '0';
      setTimeout(function() { modal.remove(); }, 300);
    }
  };
  
  // 加载用户资料
  try {
    var res = await fetch('/api/posts/users/' + userId);
    var data = await res.json();
    
    if (data.code === 200) {
      var user = data.data;
      var content = document.getElementById('user-profile-content');
      
      var roleText = '';
      if (user.role === 'super_admin') roleText = '👑 超级管理员';
      else if (user.role === 'admin') roleText = '🛡️ 管理员';
      else if (user.role === 'reviewer') roleText = '✅ 审核员';
      else if (user.role === 'radio_admin') roleText = '📻 广播管理员';
      
      content.innerHTML = '<img src="' + escapeHtml(user.avatar || '/uploads/avatars/default.png') + '" style="width:80px;height:80px;border-radius:50%;object-fit:cover;margin-bottom:16px;border:3px solid var(--primary);">' +
        '<h3 style="margin:0 0 8px 0;font-size:1.5rem;color:var(--text-primary);">' + escapeHtml(user.nickname || user.username || '同学') + '</h3>' +
        (roleText ? '<div style="margin-bottom:16px;"><span class="role-badge role-' + user.role + '">' + roleText + '</span></div>' : '') +
        '<div style="display:flex;justify-content:center;gap:24px;margin-bottom:20px;">' +
          '<div style="text-align:center;">' +
            '<div style="font-size:1.25rem;font-weight:700;color:var(--text-primary);">' + (user.post_count || 0) + '</div>' +
            '<div style="font-size:0.85rem;color:var(--text-secondary);">帖子</div>' +
          '</div>' +
          '<div style="text-align:center;">' +
            '<div style="font-size:1.25rem;font-weight:700;color:var(--text-primary);">' + (user.comment_count || 0) + '</div>' +
            '<div style="font-size:0.85rem;color:var(--text-secondary);">评论</div>' +
          '</div>' +
        '</div>' +
        '<div style="font-size:0.85rem;color:var(--text-secondary);">注册时间：' + new Date(user.created_at).toLocaleDateString('zh-CN') + '</div>';
    } else {
      showToast('用户不存在', 'error');
      modal.remove();
    }
  } catch (err) {
    console.error('加载用户资料失败:', err);
    showToast('加载失败', 'error');
    modal.remove();
  }
};

// 页面初始化
document.addEventListener('DOMContentLoaded', function() {
  // 初始化 emptyState 元素引用
  emptyStateEl = document.getElementById('emptyState');

  updateNavbar();

  // 先滚动到顶部，再加载第一页帖子
  window.scrollTo(0, 0);
  pageInitialized = true;
  totalLoaded = 0;
  hasMore = true;
  loadPosts(false);

  // ===== 移动端下拉刷新 =====
  initPullToRefresh();

  // 非阻塞方式加载歌单（延迟500ms后加载）
  setTimeout(loadHomePlaylist, 500);

  // ============================================
  // 分类筛选
  // ============================================
  var filterContainer = document.querySelector('.filter-categories');
  if (filterContainer) {
    filterContainer.addEventListener('click', function(e) {
      var tag = e.target.closest('.filter-tag');
      if (!tag) return;

      // 切换激活状态
      var allTags = filterContainer.querySelectorAll('.filter-tag');
      for (var i = 0; i < allTags.length; i++) {
        allTags[i].classList.remove('active');
      }
      tag.classList.add('active');

      // 更新当前分类并重新加载，同时滚动到顶部
      currentCategory = tag.getAttribute('data-category') || tag.textContent.trim();
      totalLoaded = 0;
      hasMore = true;
      loadPosts(false);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  // ============================================
  // 排序切换
  // ============================================
  var sortContainer = document.querySelector('.filter-sort');
  if (sortContainer) {
    sortContainer.addEventListener('click', function(e) {
      var btn = e.target.closest('.sort-btn');
      if (!btn) return;

      // 切换激活状态
      var allBtns = sortContainer.querySelectorAll('.sort-btn');
      for (var i = 0; i < allBtns.length; i++) {
        allBtns[i].classList.remove('active');
      }
      btn.classList.add('active');

      // 更新排序方式并重新加载，同时滚动到顶部
      currentSort = btn.getAttribute('data-sort') || 'latest';
      totalLoaded = 0;
      hasMore = true;
      loadPosts(false);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  // ============================================
  // 加载更多 + 无限滚动 + 分页控制
  // ============================================
  var loadMoreBtn = document.getElementById('loadMoreBtn');
  var prevPageBtn = document.getElementById('prevPageBtn');
  var nextPageBtn = document.getElementById('nextPageBtn');
  var pageJumpBtn = document.getElementById('pageJumpBtn');
  var pageJumpInput = document.getElementById('pageJumpInput');
  var paginationContainer = document.getElementById('paginationContainer');
  var currentPageNumEl = document.getElementById('currentPageNum');
  var totalPageNumEl = document.getElementById('totalPageNum');
  window._totalPages = 1; // 全局变量供 updatePaginationInfo 使用
  
  // 更新分页信息显示 - 已移到外部全局函数
  
  // 加载更多按钮 - 无限滚动模式下不需要，因为会自动加载
  // 上一页/下一页/跳转按钮 - 无限滚动模式下已移除
  
  // 无限滚动：滚动到底部自动加载
  var scrollTimer = null;
  
  window.addEventListener('scroll', function() {
    if (scrollTimer) return;
    scrollTimer = setTimeout(function() {
      scrollTimer = null;
      if (isLoading) return;
      if (!hasMore) return;

      var scrollTop = window.pageYOffset || document.documentElement.scrollTop;
      var windowHeight = window.innerHeight;
      var docHeight = document.documentElement.scrollHeight;

      // 距离底部 300px 时触发加载
      if (scrollTop + windowHeight >= docHeight - 300) {
        loadPosts(true);
      }
    }, 500);
  }, { passive: true });

  // ===== 搜索功能 =====
  var searchInput = document.getElementById('searchInput');
  var searchClear = document.getElementById('searchClear');
  var searchTimer = null;

  if (searchInput) {
    searchInput.addEventListener('input', function() {
      clearTimeout(searchTimer);
      var val = this.value.trim();
      if (searchClear) {
        if (val) {
          searchClear.classList.add('show');
        } else {
          searchClear.classList.remove('show');
        }
      }
      searchTimer = setTimeout(function() {
        currentKeyword = val;
        totalLoaded = 0;
        hasMore = true;
        loadPosts(false);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }, 400);
    });

    searchInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        clearTimeout(searchTimer);
        currentKeyword = this.value.trim();
        totalLoaded = 0;
        hasMore = true;
        loadPosts(false);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });
  }

  if (searchClear) {
    searchClear.addEventListener('click', function() {
      if (searchInput) searchInput.value = '';
      searchClear.classList.remove('show');
      currentKeyword = '';
      totalLoaded = 0;
      hasMore = true;
      loadPosts(false);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      searchInput.focus();
    });
  }

});

// ===== 下拉刷新功能 =====
function initPullToRefresh() {
  if (window.innerWidth > 768) return; // 只在移动端启用
  
  var indicator = document.getElementById('pullRefreshIndicator');
  var refreshText = indicator ? indicator.querySelector('.refresh-text') : null;
  var refreshIcon = indicator ? indicator.querySelector('.refresh-icon') : null;
  
  var startY = 0;
  var currentY = 0;
  var isPulling = false;
  var isRefreshing = false;
  var threshold = 80; // 下拉触发刷新的阈值
  
  document.addEventListener('touchstart', function(e) {
    if (isRefreshing) return;
    if (window.scrollY === 0) {
      startY = e.touches[0].pageY;
      isPulling = true;
    }
  }, { passive: true });
  
  document.addEventListener('touchmove', function(e) {
    if (!isPulling || isRefreshing) return;
    
    currentY = e.touches[0].pageY;
    var diff = currentY - startY;
    
    if (diff > 0 && diff < 200) {
      // 显示下拉指示器
      if (indicator) {
        indicator.classList.add('show');
        var progress = Math.min(diff / threshold, 1);
        
        if (progress < 1) {
          refreshText.textContent = '下拉刷新';
          refreshIcon.style.transform = 'rotate(' + (progress * 360) + 'deg)';
        } else {
          refreshText.textContent = '释放刷新';
          refreshIcon.style.transform = 'rotate(360deg)';
        }
      }
    }
  }, { passive: true });
  
  document.addEventListener('touchend', function(e) {
    if (!isPulling || isRefreshing) {
      isPulling = false;
      return;
    }
    
    var diff = currentY - startY;
    isPulling = false;
    
    if (diff > threshold) {
      // 触发刷新
      performRefresh();
    } else {
      // 隐藏指示器
      if (indicator) {
        indicator.classList.remove('show');
      }
    }
  }, { passive: true });
  
  function performRefresh() {
    if (isRefreshing) return;
    isRefreshing = true;
    
    if (indicator) {
      indicator.classList.add('refreshing');
      refreshText.textContent = '刷新中...';
    }
    
    // 重新加载帖子
    totalLoaded = 0;
    hasMore = true;
    loadPosts(false).then(function() {
      // 刷新完成
      setTimeout(function() {
        isRefreshing = false;
        if (indicator) {
          indicator.classList.remove('show', 'refreshing');
        }
        showToast('刷新成功', 'success');
      }, 500);
    }).catch(function() {
      isRefreshing = false;
      if (indicator) {
        indicator.classList.remove('show', 'refreshing');
      }
      showToast('刷新失败', 'error');
    });
  }
}

// ===== 520飘落效果 - 惊艳版 =====
(function() {
  function initFalling() {
    if (!document.body.classList.contains('mode-520')) return;

    var container = document.getElementById('hearts-container');
    if (container) container.innerHTML = '';
    else {
      container = document.createElement('div');
      container.id = 'hearts-container';
      container.className = 'hearts-container';
      document.body.appendChild(container);
    }

    // 角落装饰
    var corners = document.querySelectorAll('.deco-corner');
    corners.forEach(function(c) { c.remove(); });

    function addCorner(type, html) {
      var deco = document.createElement('div');
      deco.className = 'deco-corner ' + type;
      deco.innerHTML = html;
      document.body.appendChild(deco);
    }

    var heartSvg = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="heartGradient" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" style="stop-color:#FF7A9A"/><stop offset="100%" style="stop-color:#FFB3C6"/></linearGradient></defs><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" fill="url(#heartGradient)"/></svg>';
    addCorner('top-left', '<div class="deco-heart">' + heartSvg + '</div>');
    addCorner('top-right', '<span class="deco-star">✦</span>');

    var HEARTS = ['💕', '💗', '💖', '💘', '💓', '🌸', '🌷', '💐'];
    var PETALS = ['🌸', '🩷', '🌺', '💮'];
    var SPARKLES = ['✨', '⭐', '✦', '💫'];

    function spawnHeart() {
      if (!document.body.classList.contains('mode-520')) return;
      var el = document.createElement('div');
      el.className = 'heart';
      var size = 20 + Math.random() * 18;
      el.style.cssText = 'width:' + size + 'px;height:' + size + 'px;left:' + (Math.random() * 90) + 'vw;animation-duration:' + (5 + Math.random() * 3) + 's;';
      el.innerHTML = heartSvg;
      container.appendChild(el);
      setTimeout(function() { try { el.remove(); } catch(e) {} }, 9000);
    }

    function spawnPetal() {
      if (!document.body.classList.contains('mode-520')) return;
      var el = document.createElement('div');
      el.className = 'petal';
      el.textContent = PETALS[Math.floor(Math.random() * PETALS.length)];
      el.style.cssText = 'font-size:' + (14 + Math.random() * 10) + 'px;left:' + (Math.random() * 88) + 'vw;animation-duration:' + (6 + Math.random() * 4) + 's;';
      container.appendChild(el);
      setTimeout(function() { try { el.remove(); } catch(e) {} }, 11000);
    }

    function spawnSparkle() {
      if (!document.body.classList.contains('mode-520')) return;
      var el = document.createElement('div');
      el.className = 'sparkle';
      el.textContent = SPARKLES[Math.floor(Math.random() * SPARKLES.length)];
      el.style.cssText = 'font-size:' + (12 + Math.random() * 8) + 'px;left:' + (Math.random() * 92) + 'vw;animation-duration:' + (4 + Math.random() * 3) + 's;';
      container.appendChild(el);
      setTimeout(function() { try { el.remove(); } catch(e) {} }, 8000);
    }

    setTimeout(function() {
      for (var i = 0; i < 5; i++) setTimeout(spawnHeart, i * 500);
      for (var j = 0; j < 3; j++) setTimeout(spawnPetal, j * 800);
      for (var k = 0; k < 4; k++) setTimeout(spawnSparkle, k * 400);
    }, 1500);

    setInterval(function() {
      if (!document.body.classList.contains('mode-520')) return;
      if (Math.random() > 0.4) spawnHeart();
      if (Math.random() > 0.6) spawnPetal();
      if (Math.random() > 0.5) spawnSparkle();
    }, 1000);
  }

  setTimeout(initFalling, 1500);
})();
