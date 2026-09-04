/**
 * 校园墙 - 首页模块 (home.js)
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
var HOME_PAGE_SIZE = 10;
var loadMoreObserver = null;
var loadMoreWrapperEl = null;
// 请求序号只允许最新一轮请求修改列表和加载状态。
// 首屏筛选请求可以覆盖正在进行的请求；同一轮的加载更多仍由 isLoading 互斥。
var latestFeedRequestId = 0;

function getFeedPayload(data) {
  return data && data.data && typeof data.data === 'object' ? data.data : {};
}

function hasUsableTotal(total) {
  if (typeof total === 'number') return isFinite(total) && total >= 0;
  return typeof total === 'string' && total.trim() !== '' && isFinite(Number(total)) && Number(total) >= 0;
}

function resolveHasMore(payload, loadedCount) {
  if (typeof payload.has_more === 'boolean') return payload.has_more;
  if (typeof payload.hasMore === 'boolean') return payload.hasMore;
  if (hasUsableTotal(payload.total)) return totalLoaded < Number(payload.total);
  // 没有可靠 total 时，以“本次拿满一页”作为继续加载的信号；空页会在 loadPosts 中终止。
  return loadedCount >= HOME_PAGE_SIZE;
}

function rearmLoadMoreObserver() {
  if (!loadMoreObserver || !loadMoreWrapperEl) return;
  loadMoreObserver.unobserve(loadMoreWrapperEl);
  loadMoreObserver.observe(loadMoreWrapperEl);
}

function checkHomeLoadMore() {
  if (!pageInitialized || isLoading || !hasMore || !loadMoreWrapperEl) return;
  var rect = loadMoreWrapperEl.getBoundingClientRect();
  if (rect.top <= window.innerHeight + 320) loadPosts(true);
}

// 骨架屏HTML - 简化版本，减少DOM操作
function showSkeleton(count) {
  var postListEl = document.getElementById('postList');
  if (!postListEl) return;
  
  // 直接用简单的loading文字，不要复杂的骨架屏
  postListEl.innerHTML = '<div class="feed-state feed-state-loading" role="status" aria-live="polite">' +
    '<div class="feed-state-icon" aria-hidden="true">⏳</div>' +
    '<div>加载中...</div>' +
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
  if (!hasMore) return false;

  // 加载更多必须保持串行，避免同一个 offset 被重复请求。
  // 首屏请求（append=false）代表新的分类/排序/搜索条件，即使旧请求尚未返回也必须启动。
  if (append && isLoading) return false;

  var requestId = ++latestFeedRequestId;
  isLoading = true;

  var postListEl = document.getElementById('postList');
  var loadMoreWrapper = document.querySelector('.load-more-wrapper');
  var loadMoreBtn = document.getElementById('loadMoreBtn');

  // 首次加载显示简单 loading
  if (!append && !skeletonShown && postListEl) showSkeleton(1);

  // 加载更多按钮 loading 态
  if (loadMoreBtn) {
    loadMoreBtn.disabled = true;
    loadMoreBtn.textContent = '加载中...';
  }

  try {
    // 每次加载 10 条，使用 offset
    var url = '/api/posts?limit=10&offset=' + totalLoaded + '&category=' + encodeURIComponent(currentCategory) + '&sort=' + currentSort;
    if (currentKeyword) url += '&keyword=' + encodeURIComponent(currentKeyword);
    var data = await authFetch(url);

    // 筛选条件变化后，旧请求的响应、错误和 finally 都不能再污染当前列表。
    if (requestId !== latestFeedRequestId) return false;

    isLoading = false;
    hideSkeleton();

    if (data && data.code === 200) {
      var payload = getFeedPayload(data);
      var posts = Array.isArray(payload.posts) ? payload.posts : [];

      if (posts.length === 0) {
        if (postListEl) {
          if (!append) postListEl.innerHTML = '';
        }
        if (!append && emptyStateEl) emptyStateEl.style.display = 'block';
        hasMore = false;
        if (loadMoreBtn) loadMoreBtn.style.display = 'none';
        return true;
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
      hasMore = resolveHasMore(payload, posts.length);

      // 控制加载更多按钮显示
      if (loadMoreWrapper) {
        // wrapper 必须始终保留几何尺寸，作为 IntersectionObserver sentinel。
        loadMoreWrapper.style.display = 'block';
        if (loadMoreBtn) loadMoreBtn.style.display = hasMore ? 'block' : 'none';
      }
      rearmLoadMoreObserver();
      window.setTimeout(checkHomeLoadMore, 0);
      return true;
    } else {
      var errorMessage = data && data.message ? data.message : '加载失败';
      if (!append) {
        hasMore = false;
        if (postListEl) renderFeedError(errorMessage || '帖子暂时无法加载');
      } else {
        hasMore = false;
      }
      showToast(errorMessage, 'error');
      // 恢复按钮为重试态
      if (loadMoreBtn) {
        loadMoreBtn.textContent = '加载失败,点击重试';
        loadMoreBtn.disabled = false;
      }
      return false;
    }
  } catch (err) {
    if (requestId !== latestFeedRequestId) return false;
    console.error('加载帖子失败:', err);
    // 如果是追加模式（无限滚动），静默重试一次
    if (append && totalLoaded > 0) {
      hasMore = false;
      setTimeout(function() {
        hasMore = true;
        loadPosts(true);
      }, 2000);
      // 不显示 toast 避免打扰用户
    } else {
      if (!append && postListEl) renderFeedError('网络不稳定，请稍后重试');
      if (typeof showToast === 'function') showToast('网络不稳定,请稍后重试', 'error');
    }
    // 加载更多按钮恢复重试态
    if (loadMoreBtn) {
      loadMoreBtn.textContent = '加载失败,点击重试';
      loadMoreBtn.disabled = false;
    }
    return false;
  } finally {
    if (requestId !== latestFeedRequestId) return;
    isLoading = false;
    hideSkeleton();
    // 成功完成时,按钮恢复 "加载更多"(前提是还有更多)
    if (loadMoreBtn && hasMore) {
      loadMoreBtn.textContent = '加载更多';
      loadMoreBtn.disabled = false;
    }
  }
}

function renderFeedError(message) {
  var postListEl = document.getElementById('postList');
  if (!postListEl) return;
  var loadMoreWrapper = document.querySelector('.load-more-wrapper');
  if (loadMoreWrapper) loadMoreWrapper.style.display = 'block';
  postListEl.innerHTML = '<div class="feed-state feed-state-error" role="alert">' +
    '<div class="feed-state-icon" aria-hidden="true">⚠️</div>' +
    '<div class="feed-state-title">' + escapeHtml(message || '帖子暂时无法加载') + '</div>' +
    '<button type="button" class="feed-state-retry" onclick="window.retryPostFeed()">重新加载</button>' +
  '</div>';
}

window.retryPostFeed = function() {
  totalLoaded = 0;
  hasMore = true;
  if (emptyStateEl) emptyStateEl.style.display = 'none';
  loadPosts(false);
};

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
        '<img class="post-image" src="' + escapeHtml(img) + '" >' +
      '</div>';
    });
    if (images.length > 3) {
      imageHtml += '<div class="post-image-more" onclick="event.stopPropagation();previewImage(\'' + escapeHtml(images[0]).replace(/'/g, "\\'") + '\', ' + post._cachedImagesJson + ', 0)">+' + (images.length - 3) + '</div>';
    }
    imageHtml += '</div>';
  }
  var videoHtml = '';
  if (post.video_url && /^\/uploads\/videos\/video_[A-Za-z0-9_-]+\.(?:mp4|webm|ogv)$/i.test(post.video_url)) {
    var posterAttr = post.video_poster && /^\/uploads\/posts\/post_[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|gif|webp)$/i.test(post.video_poster)
      ? ' poster="' + escapeHtml(post.video_poster) + '"'
      : '';
    videoHtml = '<div class="post-video-wrap" onclick="event.stopPropagation()"><video class="post-video" controls preload="metadata" playsinline' + posterAttr + ' src="' + escapeHtml(post.video_url) + '"></video></div>';
  }

  // 投票预览
  var pollPreviewHtml = '';
  if (post.poll_type) {
    var pollLabel = post.poll_type === 'multiple' ? '多选' : '单选';
    pollPreviewHtml = '<div class="profile-poll-preview">📊 投票 <span class="profile-poll-label">' + pollLabel + '</span></div>';
  }

  var safePostId = post.id || 0;
  var likesCount = Number(post.likes_count) || 0;
  var commentsCount = Number(post.comments_count) || 0;
  var viewsCount = Number(post.views) || 0;
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
    if (commentsCount > post.preview_comments.length) {
      commentItems.push('<div class="comment-preview-more">查看全部 ' + commentsCount + ' 条评论</div>');
    }
    commentsPreviewHtml = '<div class="post-comments-preview">' + commentItems.join('') + '</div>';
  }

  var titleHtml = post.title ? '<div class="post-title">' + escapeHtml(post.title) + '</div>' : '';
  var authorCardClass = !post.is_anonymous && post.author_id ? ' user-card-trigger' : '';
  var authorCardAttr = !post.is_anonymous && post.author_id ? ' data-user-id="' + post.author_id + '" style="cursor:pointer;"' : '';

  return '<article class="post-card" data-id="' + safePostId + '" onclick="openPostDetail(' + safePostId + ')">' +
    '<div class="post-user">' +
      '<img class="user-avatar' + authorCardClass + '" src="' + escapeHtml(authorAvatar) + '"  decoding="async"' + authorCardAttr + '>' +
      '<div class="user-info">' +
        '<div class="user-name' + authorCardClass + '"' + authorCardAttr + '>' + escapeHtml(authorName) + roleBadge + titleBadges + '</div>' +
        '<div class="post-time">' + (post.time_ago || '') + (post.ip_region ? ' · 📍' + escapeHtml(post.ip_region) : '') + '</div>' +
      '</div>' +
    '</div>' +
    titleHtml +
    '<div class="post-content">' + (post.is_pinned ? '<span style="margin-right:4px;">📌</span>' : '') + convertContentWithLinks(post.content) + '</div>' +
    imageHtml +
    videoHtml +
    pollPreviewHtml +
    commentsPreviewHtml +
    '<div class="post-actions">' +
      '<button type="button" class="action-btn ' + (isLiked ? 'liked' : '') + '" aria-label="' + (isLiked ? '取消点赞' : '点赞') + '" aria-pressed="' + (isLiked ? 'true' : 'false') + '" title="' + (isLiked ? '取消点赞' : '点赞') + '" onclick="event.stopPropagation();toggleLike(' + safePostId + ',this)">' +
        '<span class="action-icon" aria-hidden="true">' + (isLiked ? '❤️' : '🤍') + '</span>' +
        '<span class="action-count">' + likesCount + '</span>' +
      '</button>' +
      '<button type="button" class="action-btn" aria-label="查看评论，共 ' + commentsCount + ' 条" title="查看评论" onclick="event.stopPropagation();openPostDetail(' + safePostId + ')">' +
        '<span class="action-icon" aria-hidden="true">💬</span>' +
        '<span class="action-count">' + commentsCount + '</span>' +
      '</button>' +
      '<button type="button" class="action-btn" aria-label="查看动态，共浏览 ' + viewsCount + ' 次" title="查看动态" onclick="event.stopPropagation();openPostDetail(' + safePostId + ')">' +
        '<span class="action-icon" aria-hidden="true">👁️</span>' +
        '<span class="action-count">' + viewsCount + '</span>' +
      '</button>' +
      '<button type="button" class="action-btn ' + (post.is_favorited ? 'favorited' : '') + '" aria-label="' + (post.is_favorited ? '取消收藏' : '收藏') + '" aria-pressed="' + (post.is_favorited ? 'true' : 'false') + '" title="' + (post.is_favorited ? '取消收藏' : '收藏') + '" onclick="event.stopPropagation();toggleFavorite(' + safePostId + ',this)">' +
        '<span class="action-icon" aria-hidden="true">' + (post.is_favorited ? '⭐' : '☆') + '</span>' +
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

  // 乐观更新:先在 UI 上 +1 / -1
  var icon = btn.querySelector('.action-icon');
  var count = btn.querySelector('span:last-child');
  var wasLiked = btn.classList.contains('liked');
  var prevCount = parseInt(count.textContent, 10) || 0;
  if (wasLiked) {
    btn.classList.remove('liked');
    icon.textContent = '🤍';
    count.textContent = Math.max(0, prevCount - 1);
  } else {
    btn.classList.add('liked');
    icon.textContent = '❤️';
    count.textContent = prevCount + 1;
    btn.classList.add('like-animate');
    setTimeout(function() { btn.classList.remove('like-animate'); }, 400);
  }

  try {
    var data = await authFetch('/api/posts/' + postId + '/like', { method: 'POST' });
    if (data.code === 200 && data.data && data.data.liked !== undefined) {
      // 用服务端真实值覆盖乐观值
      if (data.data.liked) {
        btn.classList.add('liked');
        icon.textContent = '❤️';
      } else {
        btn.classList.remove('liked');
        icon.textContent = '🤍';
      }
      if (data.data.likes_count !== undefined) {
        count.textContent = data.data.likes_count;
      }
      cacheLikeStatus(postId, data.data.liked);
    } else {
      // 回滚
      rollbackLike(btn, icon, count, wasLiked, prevCount);
      showToast(data.message || '操作失败', 'error');
    }
  } catch (err) {
    // 回滚
    rollbackLike(btn, icon, count, wasLiked, prevCount);
    console.error('点赞失败:', err);
    if (typeof showToast === 'function') showToast('网络不稳定,请稍后重试', 'error');
  }
  isLiking = false;
}

// 点赞失败回滚辅助
function rollbackLike(btn, icon, count, wasLiked, prevCount) {
  if (wasLiked) {
    btn.classList.add('liked');
    icon.textContent = '❤️';
  } else {
    btn.classList.remove('liked');
    icon.textContent = '🤍';
  }
  count.textContent = prevCount;
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
      cache: 'no-store',
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

    // 防御旧版本接口或中间缓存误返回软删除记录，前台绝不渲染已删除歌曲。
    var songs = Array.isArray(data.data) ? data.data.filter(function(song) {
      return song && !song.deleted_at;
    }) : [];
    
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

// 保留旧入口以兼容其他首页初始化代码；桌面端滚轮完全交给浏览器原生处理。
function initHomeWheelScroll() {
  if (window.__homeWheelScrollInitialized) return;
  window.__homeWheelScrollInitialized = true;
  // 不在这里安装 wheel 监听、requestAnimationFrame 补偿或
  // scroller.style.scrollBehavior = 'auto'，避免自定义位移造成双滚动。
}

// 页面初始化
document.addEventListener('DOMContentLoaded', function() {
  // 初始化 emptyState 元素引用
  emptyStateEl = document.getElementById('emptyState');

  updateNavbar();
  initHomeWheelScroll();

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

      // 切换激活状态 (P0-8: 用 aria-pressed 同步)
      var allTags = filterContainer.querySelectorAll('.filter-tag');
      for (var i = 0; i < allTags.length; i++) {
        allTags[i].classList.remove('active');
        allTags[i].setAttribute('aria-pressed', 'false');
      }
      tag.classList.add('active');
      tag.setAttribute('aria-pressed', 'true');

      // 更新当前分类并重新加载，同时滚动到顶部
      currentCategory = tag.getAttribute('data-category') || tag.textContent.trim();
      totalLoaded = 0;
      hasMore = true;
      loadPosts(false);
      window.scrollTo({ top: 0, behavior: getMotionSafeScrollBehavior() });
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
      window.scrollTo({ top: 0, behavior: getMotionSafeScrollBehavior() });
    });
  }

  // ============================================
  // 加载更多 + 无限滚动 + 分页控制
  // ============================================
  var loadMoreWrapper = document.querySelector('.load-more-wrapper');
  var loadMoreBtn = document.getElementById('loadMoreBtn');
  var prevPageBtn = document.getElementById('prevPageBtn');
  var nextPageBtn = document.getElementById('nextPageBtn');
  var pageJumpBtn = document.getElementById('pageJumpBtn');
  var pageJumpInput = document.getElementById('pageJumpInput');
  var paginationContainer = document.getElementById('paginationContainer');
  var currentPageNumEl = document.getElementById('currentPageNum');
  var totalPageNumEl = document.getElementById('totalPageNum');
  window._totalPages = 1; // 全局变量供 updatePaginationInfo 使用

  // 加载更多按钮点击(支持重试)
  if (loadMoreBtn) {
    loadMoreBtn.addEventListener('click', function() {
      if (isLoading) return;
      if (!hasMore) return;
      loadPosts(true);
    });
  }

  // 更新分页信息显示 - 已移到外部全局函数
  
  // 加载更多按钮 - 无限滚动模式下不需要，因为会自动加载
  // 上一页/下一页/跳转按钮 - 无限滚动模式下已移除
  
  // 无限滚动：优先使用 IntersectionObserver，避免每次滚动都读取布局尺寸。
  // 不支持的浏览器仍保留下面的 scroll 兜底。
  loadMoreWrapperEl = loadMoreWrapper;
  if (loadMoreWrapperEl && 'IntersectionObserver' in window) {
    loadMoreObserver = new IntersectionObserver(function(entries) {
      if (!entries.some(function(entry) { return entry.isIntersecting; })) return;
      if (!isLoading && hasMore) loadPosts(true);
    }, { rootMargin: '0px 0px 320px 0px' });
    loadMoreObserver.observe(loadMoreWrapperEl);
  }

  // 无限滚动：即使 IntersectionObserver 已触发过，也保留轻量滚动兜底，
  // 防止 sentinel 在追加内容后仍处于相交状态而不再产生新回调。
  var scrollTimer = null;
  
  window.addEventListener('scroll', function() {
    if (scrollTimer) return;
    scrollTimer = setTimeout(function() {
      scrollTimer = null;
      checkHomeLoadMore();
    }, 120);
  }, { passive: true });
  window.addEventListener('resize', checkHomeLoadMore, { passive: true });

  // ===== 搜索功能(含 debounce) =====
  var searchInput = document.getElementById('searchInput');
  var searchClear = document.getElementById('searchClear');

  // 简单的 debounce 工具
  function debounce(fn, wait) {
    var t = null;
    function debounced() {
      var args = arguments;
      var ctx = this;
      clearTimeout(t);
      t = setTimeout(function() { fn.apply(ctx, args); }, wait);
    }
    debounced.cancel = function() {
      clearTimeout(t);
      t = null;
    };
    return debounced;
  }

  var debouncedSearch = debounce(function(val) {
    currentKeyword = val;
    totalLoaded = 0;
    hasMore = true;
    loadPosts(false);
    window.scrollTo({ top: 0, behavior: getMotionSafeScrollBehavior() });
  }, 350);

  if (searchInput) {
    searchInput.addEventListener('input', function() {
      var val = this.value.trim();
      if (searchClear) {
        if (val) {
          searchClear.classList.add('show');
        } else {
          searchClear.classList.remove('show');
        }
      }
      debouncedSearch(val);
    });

    searchInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        // Enter 立即触发,不等 debounce
        debouncedSearch.cancel();
        currentKeyword = this.value.trim();
        totalLoaded = 0;
        hasMore = true;
        loadPosts(false);
        window.scrollTo({ top: 0, behavior: getMotionSafeScrollBehavior() });
      }
    });
  }

  if (searchClear) {
    searchClear.addEventListener('click', function() {
      debouncedSearch.cancel();
      if (searchInput) searchInput.value = '';
      searchClear.classList.remove('show');
      currentKeyword = '';
      totalLoaded = 0;
      hasMore = true;
      loadPosts(false);
      window.scrollTo({ top: 0, behavior: getMotionSafeScrollBehavior() });
      searchInput.focus();
    });
  }

});

// ===== 下拉刷新功能 =====
function initPullToRefresh() {
  if (window.__pullToRefreshInitialized) return;
  window.__pullToRefreshInitialized = true;
  
  var indicator = document.getElementById('pullRefreshIndicator');
  var refreshText = indicator ? indicator.querySelector('.refresh-text') : null;
  var refreshIcon = indicator ? indicator.querySelector('.refresh-icon') : null;
  
  var startY = 0;
  var currentY = 0;
  var isPulling = false;
  var isRefreshing = false;
  var threshold = 80; // 下拉触发刷新的阈值
  
  document.addEventListener('touchstart', function(e) {
    if (window.innerWidth > 768 || isRefreshing) return;
    var target = e.target;
    if (target && target.closest && target.closest('a, button, input, textarea, select, [data-no-pull-refresh]')) return;
    if (window.scrollY <= 0 && e.touches && e.touches[0]) {
      startY = e.touches[0].pageY;
      currentY = startY;
      isPulling = true;
    }
  }, { passive: true });
  
  document.addEventListener('touchmove', function(e) {
    if (window.innerWidth > 768 || !isPulling || isRefreshing || !e.touches || !e.touches[0]) return;
    
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
          indicator.classList.remove('pull-ready');
        } else {
          refreshText.textContent = '释放刷新';
          refreshIcon.style.transform = 'rotate(360deg)';
          indicator.classList.add('pull-ready');
        }
      }
    } else if (diff <= 0 && indicator) {
      indicator.classList.remove('show', 'pull-ready');
    }
  }, { passive: true });
  
  document.addEventListener('touchend', function(e) {
    if (window.innerWidth > 768 || !isPulling || isRefreshing) {
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

    function startRequest() {
      // 首屏请求尚未结束时排队，避免把仍在加载中的请求误报为“刷新成功”。
      if (isLoading) {
        window.setTimeout(startRequest, 50);
        return;
      }

      totalLoaded = 0;
      hasMore = true;
      loadPosts(false).then(function(success) {
        window.setTimeout(function() {
          isRefreshing = false;
          if (indicator) {
            indicator.classList.remove('show', 'refreshing', 'pull-ready');
          }
          showToast(success ? '刷新成功' : '刷新失败', success ? 'success' : 'error');
        }, success ? 500 : 0);
      });
    }

    startRequest();
  }
}

// 旧版 520 爱心动画已移除；节日装饰统一由 theme-mode.js 与 teacher.css 管理。

// ============================================
// 签到 & 积分系统
// ============================================
(function() {
  if (!isLoggedIn()) return;

  function renderCheckinCard(target) {
    var checkinCard = document.createElement('div');
    checkinCard.className = 'side-card glass-effect' + (window.innerWidth <= 768 ? ' mobile-checkin-card' : '');
    checkinCard.id = 'sideCheckin';
    checkinCard.setAttribute('aria-busy', 'true');
    checkinCard.innerHTML = '<div class="checkin-card-heading"><div class="side-card-icon">📅</div><div class="checkin-card-copy"><div class="side-card-title">每日签到</div><div class="checkin-card-subtitle">坚持签到，收获成长值</div></div></div><div class="side-card-body" id="checkinBody"><div style="font-size:0.8rem;color:#999;text-align:center;padding:8px 0;">加载中...</div></div>';
    if (target === desktopSideGroup) {
      target.insertBefore(checkinCard, target.firstElementChild);
    } else {
      target.appendChild(checkinCard);
    }
  }

  function renderCheckinError(message) {
    var body = document.getElementById('checkinBody');
    if (!body) return;
    var card = document.getElementById('sideCheckin');
    if (card) card.setAttribute('aria-busy', 'false');
    body.innerHTML = '<div class="checkin-error" role="status"><span>' + escapeHtml(message || '签到状态暂时不可用') + '</span><button type="button" class="checkin-retry" onclick="window.retryCheckinStatus()">重试</button></div>';
  }

  function loadCheckinStatus() {
    authFetch('/api/checkin/status').then(function(d) {
      if (d.code !== 200) {
        renderCheckinError(d.message);
        return;
      }
      var data = d.data;
      var body = document.getElementById('checkinBody');
      if (!body) return;
      var card = document.getElementById('sideCheckin');
      if (card) card.setAttribute('aria-busy', 'false');
      var streakHtml = data.checked_in
        ? '<div class="checkin-status-row"><span class="checkin-streak">连续 <strong>' + data.streak + '</strong> 天</span><span class="checkin-done">已签到</span></div>'
        : '<div class="checkin-action-row"><span class="checkin-streak">连续 <strong>' + data.streak + '</strong> 天</span><button class="btn-checkin" onclick="doCheckin()">签到</button></div>';
      body.innerHTML = streakHtml;
    }).catch(function() {
      renderCheckinError('网络不稳定，请稍后重试');
    });
  }

  window.retryCheckinStatus = loadCheckinStatus;

  // 移动端放入主内容流；中等桌面使用主内容备用位；宽屏放入左侧栏首位。
  var desktopSideGroup = document.querySelector('.side-cards-left');
  var desktopSlot = document.getElementById('desktopCheckinSlot');
  var mobileSlot = document.getElementById('mobileCheckinSlot');

  function getDesktopCheckinTarget() {
    return window.matchMedia('(min-width: 1600px)').matches && desktopSideGroup
      ? desktopSideGroup
      : desktopSlot;
  }

  function placeCheckinCard(target, card, isMobile) {
    if (card.parentElement === target) return;
    if (isMobile || target === desktopSlot) {
      target.appendChild(card);
    } else {
      target.insertBefore(card, target.firstElementChild);
    }
  }

  // 处理横竖屏或窗口缩放跨越断点：在移动流、中等桌面流和宽屏侧栏之间移动同一张卡。
  function syncCheckinPlacement() {
    var card = document.getElementById('sideCheckin');
    var isMobile = window.matchMedia('(max-width: 768px)').matches;
    var target = isMobile ? mobileSlot : getDesktopCheckinTarget();
    if (!target) {
      if (card) card.remove();
      return;
    }

    if (!card) {
      renderCheckinCard(target);
      card = document.getElementById('sideCheckin');
    } else {
      placeCheckinCard(target, card, isMobile);
    }

    if (card) card.classList.toggle('mobile-checkin-card', isMobile);
  }

  syncCheckinPlacement();
  window.addEventListener('resize', syncCheckinPlacement, { passive: true });

  loadCheckinStatus();
  window.doCheckin = function() {
    var btn = document.querySelector('.btn-checkin');
    if (btn) { btn.disabled = true; btn.textContent = '签到中...'; }
    authFetch('/api/checkin', { method: 'POST' }).then(function(d) {
      if (d.code === 200) {
        showToast('签到成功 +' + d.data.points_earned + '分' + (d.data.bonus > 0 ? ' (连续加成+' + d.data.bonus + ')' : ''));
        loadCheckinStatus();
      } else {
        showToast(d.message || '签到失败', 'error');
        if (btn) { btn.disabled = false; btn.textContent = '签到'; }
      }
    }).catch(function() { showToast('网络错误', 'error'); if (btn) { btn.disabled = false; btn.textContent = '签到'; } });
  };
})();
