/**
 * 转换帖子内容：转义HTML + 自动识别链接 + 换行转<br>
 * @param {string} content - 原始内容
 * @param {string} currentHost - 当前网站域名
 */
// 已移到 app.js，全局共享

/**
 * 记录帖子浏览量（QQ空间风格）
 * - 1分钟内同一帖子不重复计数
 * - 兼容游客和登录用户
 */
window.recordPostView = function(postId) {
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
};

/**
 * 帖子详情模块 (detail.js)
 * 功能：加载帖子详情、渲染评论、点赞/收藏、提交评论、删除帖子
 */

var postId = null;
var lastLikeTime = 0; // 点赞防抖时间戳

// 点赞按钮事件委托（完全内嵌，不依赖任何全局函数名）
document.addEventListener('click', async function(e) {
  var btn = e.target.closest('#btnLike');
  if (!btn || !document.getElementById('postDetail')) return;
  if (!requireLogin()) return;
  var now = Date.now();
  if (now - lastLikeTime < 800) return;
  lastLikeTime = now;
  try {
    var data = await authFetch('/api/posts/' + postId + '/like', { method: 'POST' });
    if (data.code === 200 && data.data && data.data.liked !== undefined) {
      var icon = btn.querySelector('.action-icon');
      var count = btn.querySelector('span:last-child');
      if (data.data.liked) {
        btn.classList.add('liked');
        icon.textContent = '❤️';
        if (data.data.likes_count !== undefined) count.textContent = data.data.likes_count;
        btn.classList.add('like-animate');
        setTimeout(function() { btn.classList.remove('like-animate'); }, 400);
        cacheLikeStatus(postId, true);
        // 点赞列表添加当前用户
        addCurrentUserToLikesList();
      } else {
        btn.classList.remove('liked');
        icon.textContent = '🤍';
        if (data.data.likes_count !== undefined) count.textContent = data.data.likes_count;
        cacheLikeStatus(postId, false);
        // 点赞列表移除当前用户
        removeCurrentUserFromLikesList();
      }
    } else {
      showToast(data.message || '操作失败', 'error');
    }
  } catch (err) {
    console.error('点赞失败:', err);
    showToast('操作失败', 'error');
  }
});

/**
 * 点赞后把当前用户添加到点赞列表中
 */
function addCurrentUserToLikesList() {
  var likesList = document.querySelector('.likes-list');
  var user = JSON.parse(localStorage.getItem('user') || sessionStorage.getItem('user') || 'null');
  if (!user) return;

  if (likesList) {
    // 已有列表，在前面添加
    var firstLink = likesList.querySelector('.like-user, .likes-text');
    if (firstLink) {
      var userName = escapeHtml(user.nickname || user.username || '用户');
      var newHtml = '、<span class="like-user user-card-trigger" data-user-id="' + user.id + '" style="cursor:pointer;">' + userName + '</span>';
      firstLink.insertAdjacentHTML('beforeend', newHtml);
    }
  } else {
    // 没有列表，创建新的
    var detailActions = document.querySelector('.detail-actions');
    if (!detailActions) return;
    var userName = escapeHtml(user.nickname || user.username || '用户');
    var html = '<div class="likes-list"><span class="likes-text">❤️ <span class="like-user user-card-trigger" data-user-id="' + user.id + '" style="cursor:pointer;">' + userName + '</span></span></div>';
    detailActions.insertAdjacentHTML('afterend', html);
  }
}

/**
 * 取消点赞后把当前用户从点赞列表中移除
 */
function removeCurrentUserFromLikesList() {
  var likesList = document.querySelector('.likes-list');
  if (!likesList) return;
  var user = JSON.parse(localStorage.getItem('user') || sessionStorage.getItem('user') || 'null');
  if (!user) return;

  var userSpans = likesList.querySelectorAll('.like-user');
  var found = false;
  userSpans.forEach(function(span) {
    if (span.getAttribute('data-user-id') == user.id) {
      // 移除这个span以及前面的"、"
      var prev = span.previousSibling;
      if (prev && prev.nodeType === 3 && prev.textContent.trim() === '、') {
        prev.remove();
      }
      span.remove();
      found = true;
    }
  });

  // 如果没有更多用户了，移除整个点赞列表
  var remaining = likesList.querySelectorAll('.like-user');
  if (remaining.length === 0) {
    likesList.remove();
  }
}

// 收藏按钮事件委托
document.addEventListener('click', function(e) {
  var btn = e.target.closest('#btnFavorite');
  if (btn && document.getElementById('postDetail')) {
    handleFavorite(btn);
  }
});


/**
 * 缓存点赞状态到 localStorage
 */
// 已移到 app.js，全局共享

// ============================================
// 全局函数：收藏
// ============================================
async function handleFavorite(btn) {
  if (!requireLogin()) return;

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
}

document.addEventListener('DOMContentLoaded', function() {

  // 更新导航栏登录状态
  updateNavbar();

  // 从URL获取帖子ID
  postId = window.location.pathname.split('/').pop();
  var postData = null;
  var isSubmittingComment = false;

  if (!postId) {
    showToast('帖子不存在', 'error');
    window.location.href = '/';
    return;
  }

  // ============================================
  // 匿名评论开关 - 根据设置显示/隐藏
  // ============================================
  var commentAnonymousOption = document.getElementById('commentAnonymousOption');
  authFetch('/api/site-info').then(function(data) {
    if (data && data.code === 200 && data.data.anon_comment) {
      if (commentAnonymousOption) {
        commentAnonymousOption.style.display = 'flex';
      }
    }
  }).catch(function() {
    // 获取站点设置失败，静默处理
  });

  // ============================================
  // 加载帖子详情
  // ============================================
  loadPostDetail();

  // 详情页：进入页面即计浏览（QQ空间风格）
  recordPostView(postId);

  async function loadPostDetail() {
    var detailEl = document.getElementById('postDetail');
    if (detailEl) {
      detailEl.innerHTML = '<div style="text-align:center;padding:60px 0;"><p>加载中...</p></div>';
    }

    try {
      var data = await apiFetch('/api/posts/' + postId);
      if (data.code === 200) {
        postData = data.data;
        renderPostDetail(postData);
        // 渲染评论列表
        renderComments(postData.comments || []);
      } else {
        showToast(data.message || '加载失败', 'error');
        setTimeout(function() { window.location.href = '/'; }, 1500);
      }
    } catch (err) {
      console.error('加载帖子详情失败:', err);
      showToast('网络错误，请稍后重试', 'error');
    }
  }

  // ============================================
  // 渲染帖子详情
  // ============================================
  function renderPostDetail(post) {
    var detailEl = document.getElementById('postDetail');
    if (!detailEl) return;

    // 处理匿名用户
    var authorName = post.is_anonymous ? '匿名用户' : (post.author_name || '未知用户');
    var authorAvatar = post.is_anonymous ? '/uploads/avatars/default.png' : (post.author_avatar || '/uploads/avatars/default.png');
    
    // 处理管理员标签（使用与首页相同的CSS类）
    var roleLabel = '';
    if (!post.is_anonymous && post.author_role) {
      var roleMap = {
        'super_admin': { text: '👑 超级管理员', class: 'role-badge role-super-admin' },
        'admin': { text: '🛡️ 管理员', class: 'role-badge role-admin' },
        'reviewer': { text: '✅ 审核员', class: 'role-badge role-reviewer' },
        'radio_admin': { text: '📻 广播管理员', class: 'role-badge role-radio-admin' }
      };
      var roleInfo = roleMap[post.author_role];
      if (roleInfo) {
        roleLabel = '<span class="' + roleInfo.class + '">' + roleInfo.text + '</span>';
      }
    }

    // 处理用户头衔（与首页样式一致）
    var titlesHtml = '';
    if (!post.is_anonymous && post.author_titles && post.author_titles.length > 0) {
      titlesHtml = post.author_titles.map(function(t) {
        var safeColor = t.title_color || '#FF6B9D';
        var safeBg = t.title_bg || 'rgba(255,107,157,0.1)';
        var safeIcon = t.icon || '⭐';
        var safeName = escapeHtml(t.title_name);
        return '<span class="title-badge" style="display:inline-block;padding:2px 8px;border-radius:12px;font-size:0.7rem;font-weight:600;background:' + safeBg + ';color:' + safeColor + ';margin-right:4px;white-space:nowrap;">' + safeIcon + ' ' + safeName + '</span>';
      }).join('');
    }

    // 处理images字段（可能是JSON字符串）
    var images = post.images || [];
    if (typeof images === 'string') {
      try {
        images = JSON.parse(images);
      } catch (e) {
        images = [];
      }
    }

    // 应用缓存的点赞状态（优先使用缓存）
    var cachedLikeStatus = getCachedLikeStatus(post.id);
    var isLiked = cachedLikeStatus !== null ? cachedLikeStatus : (post.is_liked || false);
    var isFavorited = post.is_favorited || false;

    // 标题
    var titleHtml = post.title ? '<h1 class="detail-title">' + escapeHtml(post.title) + '</h1>' : '';

    // 内容（转义HTML + 自动识别链接 + 换行转<br>）
    var contentHtml = convertContentWithLinks(post.content || '');

    // 图片区域
    var imagesHtml = '';
    if (images.length > 0) {
      imagesHtml = '<div class="detail-images">';
      images.forEach(function(img) {
        imagesHtml += '<img class="detail-image" src="' + escapeHtml(img) + '" onclick="previewImage(\'' + escapeHtml(img).replace(/'/g, "\\'") + '\')" loading="lazy">';
      });
      imagesHtml += '</div>';
    }

    // 判断是否是自己的帖子（可删除/编辑）
    var currentUser = getCurrentUser();
    var isOwner = currentUser && (post.actual_user_id === currentUser.id || post.actual_user_id === currentUser._id);

    // 删除和编辑按钮（使用onclick确保移动端兼容）
    var actionBtnHtml = '';
    if (isOwner) {
      actionBtnHtml = 
        '<button class="btn btn-ghost" onclick="window.location.href=\'/edit-post/' + postId + '\'" style="margin-left:auto;color:#3B82F6;">编辑</button>' +
        '<button class="btn btn-ghost" onclick="window.handleDeletePost()" style="color:#F87171;">删除</button>';
    }

    // 组装详情HTML - 作者头像和名字可点击
    var authorCardClass = (!post.is_anonymous && post.author_id) ? ' user-card-trigger' : '';
    var authorCardAttr = (!post.is_anonymous && post.author_id) ? ' data-user-id="' + post.author_id + '" style="cursor:pointer;"' : '';
    
    detailEl.innerHTML =
      titleHtml +
      '<div class="detail-author">' +
        '<img class="author-avatar' + authorCardClass + '"' + authorCardAttr + ' src="' + escapeHtml(authorAvatar) + '">' +
        '<div class="author-info">' +
          '<span class="author-name' + authorCardClass + '"' + authorCardAttr + '>' + escapeHtml(authorName) + ' ' + roleLabel + ' ' + titlesHtml + '</span>' +
          '<span class="post-time">' + (post.time_ago || '') + (post.ip_region ? ' · 📍' + escapeHtml(post.ip_region) : '') + '</span>' +
        '</div>' +
        actionBtnHtml +
      '</div>' +
      '<div class="detail-content">' + contentHtml + '</div>' +
      imagesHtml +
  '<div class="detail-actions">' +
    '<button class="action-btn ' + (isLiked ? 'liked' : '') + '" id="btnLike">' +
      '<span class="action-icon">' + (isLiked ? '❤️' : '🤍') + '</span>' +
      '<span class="action-count">' + (post.likes_count || 0) + '</span>' +
    '</button>' +
        '<button class="action-btn" id="btnComment" onclick="event.stopPropagation();document.getElementById(\'commentInput\').focus()">' +
          '<span class="action-icon">💬</span>' +
          '<span class="action-count">' + (post.comments_count || 0) + '</span>' +
        '</button>' +
        '<button class="action-btn" id="btnViews">' +
          '<span class="action-icon">👁️</span>' +
          '<span class="action-count">' + (post.views || 0) + '</span>' +
        '</button>' +
        '<button class="action-btn ' + (isFavorited ? 'favorited' : '') + '" id="btnFavorite">' +
          '<span class="action-icon">' + (isFavorited ? '⭐' : '☆') + '</span>' +
          '<span class="action-count"></span>' +
        '</button>' +
      '</div>';

    // 渲染点赞列表（朋友圈风格）
    renderLikesList(post.likes_list, post.is_liked);
  }

  // ============================================
  // 渲染点赞列表（朋友圈风格）
  // ============================================
  function renderLikesList(likesList, isLiked) {
    var detailActions = document.querySelector('.detail-actions');
    if (!detailActions) return;

    // 移除已存在的点赞列表
    var existingLikesList = document.querySelector('.likes-list');
    if (existingLikesList) existingLikesList.remove();

    if (!likesList || likesList.length === 0) return;

    var html = '<div class="likes-list">';
    
    // 创建点赞用户链接 - 修改为可点击显示用户卡片
    var likeLinks = [];
    likesList.forEach(function(user, index) {
      var displayName = user.is_anonymous ? '匿名用户' : (user.nickname || '用户');
      var avatar = user.avatar || '/uploads/avatars/default.png';
      // 非匿名用户可点击显示资料卡片
      if (!user.is_anonymous && user.id) {
        likeLinks.push('<span class="user-card-trigger like-user" data-user-id="' + user.id + '" title="' + escapeHtml(displayName) + '" style="cursor:pointer;">' + escapeHtml(displayName) + '</span>');
      } else {
        likeLinks.push('<span class="like-user" title="' + escapeHtml(displayName) + '">' + escapeHtml(displayName) + '</span>');
      }
    });

    html += '<span class="likes-text">❤️ ' + likeLinks.join('、') + '</span>';
    html += '</div>';

    // 插入到actions之后
    detailActions.insertAdjacentHTML('afterend', html);
  }

  // ============================================
  // 渲染评论列表
  // ============================================
  var currentReplyTo = null; // 当前回复目标
  var currentCommentSort = 'latest'; // 评论排序

  // 取消回复
  window.cancelReply = function() {
    currentReplyTo = null;
    var replyTarget = document.getElementById('replyTarget');
    if (replyTarget) replyTarget.style.display = 'none';
    var commentInput = document.getElementById('commentInput');
    if (commentInput) commentInput.placeholder = '写下你的评论...';
  };

  // 切换评论排序
  window.switchCommentSort = function(sort) {
    currentCommentSort = sort;
    document.querySelectorAll('.comment-sort-bar .sort-btn').forEach(function(btn) {
      btn.classList.toggle('active', btn.dataset.sort === sort);
    });
    loadCommentsWithSort(sort);
  };

  async function loadCommentsWithSort(sort) {
    try {
      var data = await authFetch('/api/posts/' + postId + '/comments?sort=' + sort);
      if (data.code === 200) {
        renderComments(data.data.comments || []);
        var countEl = document.getElementById('commentCount');
        if (countEl && data.data.total !== undefined) {
          countEl.textContent = data.data.total;
        }
      }
    } catch (err) {
      console.error('加载评论失败:', err);
    }
  }

  // 加载单条评论的回复
  var loadedReplies = {};
  async function loadRepliesForComment(commentId) {
    if (loadedReplies[commentId]) {
      return loadedReplies[commentId];
    }
    try {
      var data = await authFetch('/api/posts/' + postId + '/comments/' + commentId + '/replies');
      if (data.code === 200) {
        loadedReplies[commentId] = data.data.replies || [];
        return loadedReplies[commentId];
      }
    } catch (err) {
      console.error('加载回复失败:', err);
    }
    return [];
  }

  // 显示/隐藏评论的回复
  window.toggleReplies = async function(commentId) {
    var repliesContainer = document.getElementById('replies-' + commentId);
    var toggleBtn = document.getElementById('toggle-replies-' + commentId);
    if (!repliesContainer) return;

    if (repliesContainer.style.display === 'none' || !repliesContainer.style.display) {
      if (!loadedReplies[commentId]) {
        var replies = await loadRepliesForComment(commentId);
        renderRepliesHtml(commentId, replies);
      } else {
        renderRepliesHtml(commentId, loadedReplies[commentId]);
      }
      repliesContainer.style.display = 'block';
      if (toggleBtn) toggleBtn.textContent = '收起回复';
    } else {
      repliesContainer.style.display = 'none';
      if (toggleBtn) toggleBtn.textContent = '查看回复';
    }
  };

  function renderRepliesHtml(commentId, replies) {
    var container = document.getElementById('replies-' + commentId);
    if (!container) return;
    if (!replies || replies.length === 0) {
      container.innerHTML = '<div style="padding:10px;color:#999;font-size:0.85rem;">暂无回复</div>';
      return;
    }

    var html = '';
    replies.forEach(function(reply) {
      var replyAuthorName = reply.is_anonymous ? '匿名用户' : (reply.author_name || '未知用户');
      var replyContent = escapeHtml(reply.content || '').replace(/\n/g, '<br>');
      replyContent = replyContent.replace(/@(\S+)/g, function(match, username) {
        return '<span class="mentioned-user">@' + escapeHtml(username) + '</span>';
      });
      var replyAuthorId = reply.author_id || reply.user_id;
      var isReplyOwner = currentUser && (replyAuthorId === currentUser.id || replyAuthorId === currentUser._id);
      var isReplyLiked = reply.is_liked || false;

      html += '<div class="comment-reply-item" data-reply-id="' + reply.id + '">' +
        '<img class="reply-avatar' + ((!reply.is_anonymous && replyAuthorId) ? ' user-card-trigger" data-user-id="' + replyAuthorId + '"' : '"') + ' src="' + escapeHtml(reply.author_avatar || '/uploads/avatars/default.png') + '">' +
        '<div class="reply-body">' +
          '<div class="reply-header">' +
            '<span class="reply-author-name' + ((!reply.is_anonymous && replyAuthorId) ? ' user-card-trigger" data-user-id="' + replyAuthorId + '"' : '"') + '>' + escapeHtml(replyAuthorName) + '</span>' +
            '<span class="reply-time">' + (reply.time_ago || '') + '</span>' +
          '</div>' +
          '<div class="reply-content">' + replyContent + '</div>' +
          '<div class="reply-actions">' +
            '<button class="comment-like-btn' + (isReplyLiked ? ' liked' : '') + '" onclick="handleReplyLike(' + reply.id + ', ' + commentId + ', this)">' +
              '<span class="like-icon">' + (isReplyLiked ? '❤️' : '🤍') + '</span>' +
              '<span class="like-count">' + (reply.likes_count > 0 ? reply.likes_count : '') + '</span>' +
            '</button>' +
            '<button class="comment-action-btn reply-btn" onclick="startReplyToReply(\'' + escapeHtml(replyAuthorName) + '\', ' + reply.id + ', ' + commentId + ')">回复</button>' +
            (isReplyOwner ? '<button class="comment-delete-btn" onclick="handleDeleteReply(' + reply.id + ', ' + commentId + ', this)">删除</button>' : '') +
          '</div>' +
        '</div>' +
      '</div>';
    });
    container.innerHTML = html;
  }

  // 回复点赞
  window.handleReplyLike = async function(replyId, commentId, btn) {
    if (!requireLogin()) return;
    try {
      var data = await authFetch('/api/posts/' + postId + '/comments/' + commentId + '/replies/' + replyId + '/like', { method: 'POST' });
      if (data.code === 200) {
        var isLiked = data.data.liked;
        var countEl = btn.querySelector('.like-count');
        var iconEl = btn.querySelector('.like-icon');
        btn.classList.toggle('liked', isLiked);
        iconEl.textContent = isLiked ? '❤️' : '🤍';
        var currentCount = parseInt(countEl.textContent) || 0;
        countEl.textContent = isLiked ? currentCount + 1 : Math.max(0, currentCount - 1);
      } else {
        showToast(data.message || '操作失败', 'error');
      }
    } catch (err) {
      console.error('回复点赞失败:', err);
    }
  };

  // 删除回复
  window.handleDeleteReply = async function(replyId, commentId, btn) {
    if (!confirm('确定要删除这条回复吗？')) return;
    try {
      var data = await authFetch('/api/posts/' + postId + '/comments/' + commentId + '/replies/' + replyId, { method: 'DELETE' });
      if (data.code === 200) {
        var replyItem = btn.closest('.comment-reply-item');
        if (replyItem) replyItem.remove();
        showToast('回复已删除');
        delete loadedReplies[commentId];
      } else {
        showToast(data.message || '删除失败', 'error');
      }
    } catch (err) {
      console.error('删除回复失败:', err);
      showToast('网络错误，请稍后重试', 'error');
    }
  };

  function renderComments(comments) {
    var commentListEl = document.getElementById('commentList');
    var commentEmptyEl = document.getElementById('commentEmpty');
    var sortBar = document.getElementById('commentSortBar');
    if (!commentListEl) return;

    // 显示排序栏
    if (sortBar) sortBar.style.display = 'flex';

    if (!comments || comments.length === 0) {
      commentListEl.innerHTML = '';
      if (commentEmptyEl) commentEmptyEl.style.display = 'block';
      return;
    }

    if (commentEmptyEl) commentEmptyEl.style.display = 'none';

    var html = '';
    comments.forEach(function(comment) {
      var isAnonymous = comment.is_anonymous;
      var cAuthorName = isAnonymous ? '匿名用户' : (comment.author_name || '未知用户');
      var cAuthorAvatar = isAnonymous ? '/uploads/avatars/default.png' : (comment.author_avatar || '/uploads/avatars/default.png');
      var cTime = comment.time_ago || formatTime(comment.created_at);
      var cIpRegion = comment.ip_region ? ' · 📍' + escapeHtml(comment.ip_region) : '';

      // 处理@mention高亮
      var cContent = escapeHtml(comment.content || '').replace(/\n/g, '<br>');
      cContent = cContent.replace(/@(\S+)/g, function(match, username) {
        return '<span class="mentioned-user" data-username="' + escapeHtml(username) + '">@' + escapeHtml(username) + '</span>';
      });

      var cAuthorId = comment.actual_user_id || comment.user_id || comment.author_id;
      var isCommentOwner = currentUser && (cAuthorId === currentUser.id || cAuthorId === currentUser._id);
      var isLiked = comment.is_liked || false;
      var likesCount = comment.likes_count || 0;
      var repliesCount = comment.replies_count || 0;

      // 处理评论者的管理员标签
      var commentRoleLabel = '';
      if (!isAnonymous && comment.author_role) {
        var roleMap = {
          'super_admin': { text: '🏆 超级管理员', color: '#FFD700' },
          'admin': { text: '👑 管理员', color: '#FF6B9D' },
          'reviewer': { text: '🎖️ 审核员', color: '#3B82F6' },
          'radio_admin': { text: '🎵 电台管理员', color: '#10B981' }
        };
        var roleInfo = roleMap[comment.author_role];
        if (roleInfo) {
          commentRoleLabel = '<span class="role-badge" style="color: ' + roleInfo.color + '; font-weight: 600; margin-left: 6px; font-size: 0.85rem;">' + roleInfo.text + '</span>';
        }
      }

      html += '<div class="comment-item" data-comment-id="' + comment.id + '">' +
        '<img class="comment-avatar' + ((!isAnonymous && cAuthorId) ? ' user-card-trigger" data-user-id="' + cAuthorId + '" style="cursor:pointer;"' : '"') + ' src="' + escapeHtml(cAuthorAvatar) + '">' +
        '<div class="comment-body">' +
          '<div class="comment-header">' +
            (!isAnonymous && cAuthorId ?
              '<span class="comment-author user-card-trigger" data-user-id="' + cAuthorId + '" style="cursor:pointer;">' + escapeHtml(cAuthorName) + commentRoleLabel + '</span>' :
              '<span class="comment-author">' + escapeHtml(cAuthorName) + commentRoleLabel + '</span>') +
            '<span class="comment-time">' + cTime + '</span>' +
          '</div>' +
          '<div class="comment-text">' + cContent + '</div>' +
          '<div class="comment-actions">' +
            '<button class="comment-like-btn' + (isLiked ? ' liked' : '') + '" onclick="handleCommentLike(' + comment.id + ', this)">' +
              '<span class="like-icon">' + (isLiked ? '❤️' : '🤍') + '</span>' +
              '<span class="like-count">' + (likesCount > 0 ? likesCount : '') + '</span>' +
            '</button>' +
            '<button class="comment-action-btn reply-btn" onclick="startReply(\'' + escapeHtml(cAuthorName) + '\', ' + comment.id + ')">回复</button>' +
            (isCommentOwner ? '<button class="comment-delete-btn" onclick="handleDeleteComment(' + comment.id + ', this)">删除</button>' : '') +
          '</div>' +
          '<div class="comment-replies-section">' +
            '<button class="toggle-replies-btn" id="toggle-replies-' + comment.id + '" onclick="toggleReplies(' + comment.id + ')">' +
              (repliesCount > 0 ? '查看' + repliesCount + '条回复' : '添加回复') +
            '</button>' +
            '<div class="comment-replies-container" id="replies-' + comment.id + '" style="display:none;"></div>' +
          '</div>' +
        '</div>' +
      '</div>';
    });
    commentListEl.innerHTML = html;
  }

  // 开始回复
  function startReply(authorName, commentId) {
    if (!requireLogin()) return;
    currentReplyTo = { id: commentId, name: authorName };
    var replyTarget = document.getElementById('replyTarget');
    var commentInput = document.getElementById('commentInput');
    if (replyTarget) {
      replyTarget.style.display = 'flex';
      replyTarget.querySelector('.reply-target-text').innerHTML = '回复 <span class="reply-to-name">@' + escapeHtml(authorName) + '</span> 的评论';
    }
    if (commentInput) {
      commentInput.placeholder = '回复 @' + authorName + '...';
      commentInput.focus();
    }
  }

  // 开始回复回复
  function startReplyToReply(authorName, replyId, commentId) {
    if (!requireLogin()) return;
    currentReplyTo = { id: replyId, name: authorName, commentId: commentId };
    var replyTarget = document.getElementById('replyTarget');
    var commentInput = document.getElementById('commentInput');
    if (replyTarget) {
      replyTarget.style.display = 'flex';
      replyTarget.querySelector('.reply-target-text').innerHTML = '回复 <span class="reply-to-name">@' + escapeHtml(authorName) + '</span>';
    }
    if (commentInput) {
      commentInput.placeholder = '回复 @' + authorName + '...';
      commentInput.focus();
    }
  }

  // 评论点赞
  window.handleCommentLike = async function(commentId, btn) {
    if (!requireLogin()) return;
    try {
      var data = await authFetch('/api/posts/comments/' + commentId + '/like', { method: 'POST' });
      if (data.code === 200) {
        var isLiked = data.data.liked;
        var countEl = btn.querySelector('.like-count');
        var iconEl = btn.querySelector('.like-icon');
        btn.classList.toggle('liked', isLiked);
        iconEl.textContent = isLiked ? '❤️' : '🤍';
        var currentCount = parseInt(countEl.textContent) || 0;
        countEl.textContent = isLiked ? currentCount + 1 : Math.max(0, currentCount - 1);
      } else {
        showToast(data.message || '操作失败', 'error');
      }
    } catch (err) {
      console.error('评论点赞失败:', err);
    }
  };

  // ============================================
  // 事件绑定
  // ============================================
  function bindDetailEvents() {
    var detailEl = document.getElementById('postDetail');
    if (detailEl && detailEl.getAttribute('data-events-bound')) return;
    if (detailEl) detailEl.setAttribute('data-events-bound', '1');

    // 评论按钮（聚焦到评论输入框）
    var commentBtn = document.getElementById('btnComment');
    if (commentBtn) {
      commentBtn.addEventListener('click', function() {
        var input = document.getElementById('commentInput');
        if (input) input.focus();
      });
    }
  }

  // ============================================
  // 提交评论
  // ============================================
  var submitCommentBtn = document.getElementById('submitComment');
  var commentInput = document.getElementById('commentInput');

  if (submitCommentBtn) {
    submitCommentBtn.addEventListener('click', function() {
      handleCommentSubmit();
    });
  }

  // 回车发送（Ctrl+Enter）
  if (commentInput) {
    commentInput.addEventListener('keydown', function(e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        handleCommentSubmit();
      }
    });
  }

  // 表情选择器初始化
  initEmojiPicker();

  // 表情选择器
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

  // 插入表情
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

  // 显示艾特选择器（手动触发）
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

  async function handleCommentSubmit() {
    if (!requireLogin()) return;
    if (isSubmittingComment) return;

    var input = document.getElementById('commentInput');
    var anonymousCheckbox = document.getElementById('commentAnonymous');
    if (!input) return;

    var content = input.value.trim();
    if (!content) {
      showToast('请输入评论内容', 'error');
      input.focus();
      return;
    }

    if (content.length > 500) {
      showToast('评论内容不能超过500字', 'error');
      return;
    }

    var isAnonymous = anonymousCheckbox ? anonymousCheckbox.checked : false;

    isSubmittingComment = true;
    if (submitCommentBtn) {
      submitCommentBtn.disabled = true;
      submitCommentBtn.textContent = '发送中...';
    }

    try {
      var clientIP = await getClientRealIP();

      // 提取艾特的用户ID
      var mentionedUsers = extractMentions(content);

      // 构建请求数据
      var requestData = {
        content: content,
        is_anonymous: isAnonymous,
        client_ip: clientIP,
        mentioned_users: mentionedUsers
      };

      var apiUrl = '/api/posts/' + postId + '/comments';

      // 如果是回复评论或回复的回复，发送到不同的端点
      if (currentReplyTo) {
        if (currentReplyTo.commentId) {
          // 回复回复
          apiUrl = '/api/posts/' + postId + '/comments/' + currentReplyTo.commentId + '/replies';
        } else {
          // 回复评论
          apiUrl = '/api/posts/' + postId + '/comments/' + currentReplyTo.id + '/replies';
        }
      }

      var data = await authFetch(apiUrl, {
        method: 'POST',
        body: JSON.stringify(requestData)
      });

      isSubmittingComment = false;
      if (submitCommentBtn) {
        submitCommentBtn.disabled = false;
        submitCommentBtn.textContent = '发送';
      }

      if (data.code === 200) {
        showToast(currentReplyTo ? '回复成功' : '评论成功');
        input.value = '';
        // 清空艾特列表
        mentionedUsersList = [];
        hideMentionPopup();
        // 取消回复状态
        cancelReply();

        // 如果是回复，需要清除缓存并刷新
        if (currentReplyTo) {
          if (currentReplyTo.commentId) {
            // 回复回复，清除整个评论的缓存
            delete loadedReplies[currentReplyTo.commentId];
          } else {
            // 回复评论，清除该评论的缓存
            delete loadedReplies[currentReplyTo.id];
          }
          loadPostDetail();
        } else {
          loadPostDetail();
        }
      } else {
        showToast(data.message || '评论失败', 'error');
      }
    } catch (err) {
      isSubmittingComment = false;
      if (submitCommentBtn) {
        submitCommentBtn.disabled = false;
        submitCommentBtn.textContent = '发送';
      }
      console.error('评论失败:', err);
      showToast('网络错误，请稍后重试', 'error');
    }
  }
  
  // ============================================
  // 艾特功能
  // ============================================
  var mentionedUsersList = [];
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

  function getClientRealIP() {
    return Promise.resolve(null);
  }

  // ============================================
  // 删除评论
  // ============================================
  window.handleDeleteComment = async function(commentId, btn) {
    if (!confirm('确定要删除这条评论吗？')) return;
    
    try {
      var data = await authFetch('/api/posts/' + postId + '/comments/' + commentId, { method: 'DELETE' });
      if (data.code === 200) {
        var commentItem = btn.closest('.comment-item');
        if (commentItem) commentItem.remove();
        showToast('评论已删除');
        if (postData && postData.comments_count) {
          postData.comments_count = Math.max(0, postData.comments_count - 1);
          var commentCountEl = document.getElementById('btnComment').querySelector('span:last-child');
          if (commentCountEl) commentCountEl.textContent = postData.comments_count;
        }
      } else {
        showToast(data.message || '删除失败', 'error');
      }
    } catch (err) {
      console.error('删除评论失败:', err);
      showToast('网络错误，请稍后重试', 'error');
    }
  }

  // ============================================
  // 删除帖子
  // ============================================
  var isDeleting = false;
  
  window.handleDeletePost = async function() {
    if (isDeleting) return;
    if (!confirm('确定要删除这篇帖子吗？删除后不可恢复。')) return;
    
    isDeleting = true;

    try {
      var data = await authFetch('/api/posts/' + postId, { method: 'DELETE' });

      if (data.code === 200) {
        showToast('帖子已删除');
        setTimeout(function() {
          window.location.href = '/';
        }, 500);
      } else {
        showToast(data.message || '删除失败', 'error');
        isDeleting = false;
      }
    } catch (err) {
      console.error('删除帖子失败:', err);
      showToast('网络错误，请稍后重试', 'error');
      isDeleting = false;
    }
  }

});
