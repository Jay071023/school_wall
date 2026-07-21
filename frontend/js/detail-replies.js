/**
 * detail-replies.js - Reply functionality for post detail page
 */

/**
 * 加载单条评论的回复
 */
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

/**
 * 显示/隐藏评论的回复
 */
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

/**
 * 渲染回复HTML
 */
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

/**
 * 回复点赞
 */
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

/**
 * 删除回复
 */
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

/**
 * 取消回复
 */
window.cancelReply = function() {
  currentReplyTo = null;
  var replyTarget = document.getElementById('replyTarget');
  if (replyTarget) replyTarget.style.display = 'none';
  var commentInput = document.getElementById('commentInput');
  if (commentInput) commentInput.placeholder = '写下你的评论...';
};

/**
 * 切换评论排序
 */
window.switchCommentSort = function(sort) {
  currentCommentSort = sort;
  document.querySelectorAll('.comment-sort-bar .sort-btn').forEach(function(btn) {
    btn.classList.toggle('active', btn.dataset.sort === sort);
  });
  loadCommentsWithSort(sort);
};

/**
 * 加载带排序的评论
 */
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

/**
 * 开始回复评论
 */
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

/**
 * 开始回复回复
 */
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

/**
 * 评论点赞
 */
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

/**
 * 删除评论
 */
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
};