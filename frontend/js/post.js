/**
 * 校园墙 - 发帖模块 (post.js)
 * 功能：图片/视频上传（拖拽+点击）、媒体预览和删除、分类选择、匿名开关、表单提交
 * 后端API返回格式：{ code: 200, message: '...', data: {...} }
 * 新增：草稿箱、内容预览、富文本编辑、字数统计
 */

document.addEventListener('DOMContentLoaded', function() {

  // 检查登录状态
  if (!isLoggedIn()) {
    window.location.href = '/login';
    return;
  }

  // 更新导航栏登录状态
  updateNavbar();

  // 状态变量
  var uploadedImages = [];     // 已上传的图片URL列表
  var uploadedVideo = '';      // 已上传的视频URL（每个帖子最多一个）
  var uploadedVideoPoster = ''; // 已上传的视频首帧封面URL
  var MAX_IMAGES = 9;          // 最大图片数量
  var MAX_FILE_SIZE = 5 * 1024 * 1024; // 单张图片最大5MB
  var ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  var isSubmitting = false;

  // DOM元素引用
  var uploadArea = document.querySelector('.image-upload-area');
  var fileInput = document.getElementById('fileInput');
  var imagePreviewList = document.getElementById('imagePreviewList');
  var videoPreviewWrap = document.getElementById('videoPreviewWrap');
  var videoPreview = document.getElementById('videoPreview');
  var videoPreviewCover = document.getElementById('videoPreviewCover');
  var videoPreviewPoster = document.getElementById('videoPreviewPoster');
  var videoPreviewCoverText = document.getElementById('videoPreviewCoverText');
  var videoPreviewStatus = document.getElementById('videoPreviewStatus');
  var videoRemoveBtn = document.getElementById('videoRemoveBtn');
  var postForm = document.getElementById('postForm');
  var contentArea = document.getElementById('postContent');
  var editorSurface = document.getElementById('postContentEditor');
  var charCount = document.getElementById('charCount');
  var postEditor = null;
  var videoUploading = false;
  var localVideoObjectUrl = '';
  var localVideoPosterUrl = '';
  var videoUploadToken = 0;

  // ============================================
  // emoji选择器
  // ============================================
  var EMOJIS = ['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','😉','😊','😇','🥰','😍','🤩','😘','😗','😚','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','🤐','🤨','😐','😑','😶','😏','😒','🙄','😬','🤥','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🤧','🥵','🥶','🥴','😵','🤯','🤠','🥳','🥸','😎','🤓','🧐','😕','😟','🙁','😮','😯','😲','😳','🥺','😦','😧','😱','😨','😰','😥','😢','😭','😱','😩','😬','🤯','💔','💖','💗','💘','💝','💞','💟','❣️','💕','❤️','🧡','💛','💚','💙','💜','🤍','🤎','💯','🔥','⭐','🌟','✨','💫','💥','💢','💣','💦','💨','🌀','🌈','☀️','🌤️','⛅','🌦️','🌧️','⛈️','🌩️','🌨️','❄️','☃️','⛄','🌬️','💨','🎉','🎊','🎈','🎁','🎀','🎫','🏆','🥇','🥈','🥉','🏅','🎖️','🏵️','🎗️','🎟️','🎫','💎','💍','👑','🎩','🧢','👒','🎓','👑','💄','💋','👄','💋','🔥','💯','👍','👎','👏','🙌','🤝','🙏','💪','🤘','🤙','👌','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','👇','👇','☝️','✋','🤚','🖐','🖖','✍','🤲','🙏','💪'];

  // 使用可视化编辑器覆盖旧的字符串包裹逻辑：编辑时直接显示粗体/斜体，
  // hidden textarea 只作为提交和草稿的兼容存储。
  function updatePostCharCount(value, length) {
    if (!charCount) return;
    charCount.textContent = String(length == null ? value.length : length);
    charCount.parentElement.classList.toggle('warning', value.length > 1800);
  }

  postEditor = window.CampusWallPostEditor && window.CampusWallPostEditor.create({
    storage: contentArea,
    surface: editorSurface,
    picker: document.getElementById('emojiPicker'),
    trigger: document.getElementById('postEmojiTrigger'),
    emojis: window.CampusWallPostEmojis || EMOJIS,
    maxLength: 5000,
    onChange: updatePostCharCount
  });

  window.showEmojiPicker = function() { if (postEditor) postEditor.showPicker(); };
  window.insertEmoji = function(emoji) { if (postEditor) postEditor.insertEmoji(emoji); };
  window.insertFormat = function(type) { if (postEditor) postEditor.format(type); };

  // ============================================
  // 草稿箱
  // ============================================
  var DRAFT_KEY = 'post_draft';

  window.saveDraft = function() {
    var title = document.getElementById('postTitle').value.trim();
    var content = postEditor ? postEditor.getValue().trim() : (contentArea ? contentArea.value.trim() : '');
    var selectedCategory = document.querySelector('.category-tag.selected');
    var category = selectedCategory ? selectedCategory.getAttribute('data-value') : '';
    var anonymousToggle = document.getElementById('anonymousToggle');
    var isAnonymous = anonymousToggle ? anonymousToggle.checked : false;

    if (!title && !content) {
      showToast('内容为空，无需保存', 'warning');
      return;
    }

    var draft = {
      title: title,
      content: content,
      category: category,
      isAnonymous: isAnonymous,
      images: uploadedImages.slice(),
      video: uploadedVideo,
      videoPoster: uploadedVideoPoster,
      savedAt: Date.now()
    };

    // 保存投票选项
    var pollInputs = document.querySelectorAll('.poll-option-input');
    if (pollInputs.length > 0) {
      var pollOpts = [];
      pollInputs.forEach(function(inp) {
        var v = inp.value.trim();
        if (v) pollOpts.push(v);
      });
      if (pollOpts.length > 0) draft.pollOptions = pollOpts;
    }
    var pollMultiple = document.getElementById('pollMultiple');
    if (pollMultiple) draft.pollType = pollMultiple.checked ? 'multiple' : 'single';

    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
      showToast('草稿已保存', 'success');
    } catch (e) {
      showToast('草稿保存失败', 'error');
    }
  };

  window.loadDraft = function() {
    try {
      var saved = localStorage.getItem(DRAFT_KEY);
      if (!saved) return;

      var draft = JSON.parse(saved);
      var titleInput = document.getElementById('postTitle');
      if (titleInput && draft.title) titleInput.value = draft.title;
      if (contentArea && draft.content) {
        if (postEditor) postEditor.setValue(draft.content);
        else contentArea.value = draft.content;
        if (charCount && !postEditor) charCount.textContent = draft.content.length;
      }
      if (draft.category) {
        var catTag = document.querySelector('.category-tag[data-value="' + draft.category + '"]');
        if (catTag) {
          document.querySelectorAll('.category-tag').forEach(function(t) { t.classList.remove('selected'); });
          catTag.classList.add('selected');
          // 同步显示对应面板
          var pollGroup = document.getElementById('pollGroup');
          if (pollGroup) pollGroup.style.display = draft.category === 'poll' ? 'block' : 'none';
          var contactGroup = document.getElementById('contactGroup');
          if (contactGroup) contactGroup.style.display = draft.category === 'lost_found' ? 'block' : 'none';
        }
      }
      if (draft.isAnonymous && anonymousToggle) {
        anonymousToggle.checked = true;
      }
      if (draft.images && draft.images.length > 0) {
        uploadedImages = draft.images;
        renderImagePreviews();
      }
      if (draft.video) setUploadedVideo(draft.video, draft.videoPoster || '');

      // 恢复投票选项
      if (draft.pollOptions && draft.pollOptions.length > 0) {
        var container = document.getElementById('pollOptionsContainer');
        if (container) {
          container.innerHTML = '';
          draft.pollOptions.forEach(function(opt, i) {
            var div = document.createElement('div');
            div.className = 'poll-option-row';
            div.innerHTML = '<input type="text" class="form-input poll-option-input" placeholder="选项 ' + (i+1) + '" maxlength="100" value="' + escapeHtml(opt) + '"><button type="button" class="btn-del-option" onclick="this.parentElement.remove()">✕</button>';
            container.appendChild(div);
          });
        }
        var pollMultiple = document.getElementById('pollMultiple');
        if (pollMultiple && draft.pollType === 'multiple') pollMultiple.checked = true;
      }

      if (Date.now() - draft.savedAt > 24 * 60 * 60 * 1000) {
        localStorage.removeItem(DRAFT_KEY);
        showToast('草稿已过期，已自动清除', 'warning');
        return;
      }

      showToast('草稿已恢复', 'success');
    } catch (e) {
      console.error('加载草稿失败:', e);
    }
  };

  setTimeout(loadDraft, 500);

  window.clearDraft = function() {
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch (e) {}
  };

  // ============================================
  // 内容预览
  // ============================================
  window.showPreview = function() {
    var title = document.getElementById('postTitle').value.trim();
    var content = postEditor ? postEditor.getValue().trim() : (contentArea ? contentArea.value.trim() : '');
    var selectedCategory = document.querySelector('.category-tag.selected');
    var category = selectedCategory ? selectedCategory.textContent.trim() : '日常';

    if (!title && !content) {
      showToast('请输入标题后再预览', 'warning');
      return;
    }

    var previewModal = document.getElementById('previewModal');
    var previewContent = document.getElementById('previewContent');
    if (!previewModal || !previewContent) return;

    var htmlContent = escapeHtml(content)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*\n]+?)\*(?!\*)/g, '<em>$1</em>')
      .replace(/\n/g, '<br>');

    var imagesHtml = '';
    if (uploadedImages.length > 0) {
      imagesHtml = '<div class="preview-images">';
      uploadedImages.forEach(function(img) {
        imagesHtml += '<img src="' + escapeHtml(img) + '" onclick="previewImage(\'' + escapeHtml(img).replace(/'/g, "\\'") + '\')">';
      });
      imagesHtml += '</div>';
    }

    var videoHtml = uploadedVideo ? '<video class="preview-video" controls preload="metadata" playsinline' + (uploadedVideoPoster ? ' poster="' + escapeHtml(uploadedVideoPoster) + '"' : '') + ' src="' + escapeHtml(uploadedVideo) + '"></video>' : '';
    previewContent.innerHTML =
      '<span class="preview-category-tag">' + escapeHtml(category) + '</span>' +
      (title ? '<div class="preview-title">' + escapeHtml(title) + '</div>' : '') +
      (content ? '<div class="preview-content">' + htmlContent + '</div>' : '') +
      imagesHtml + videoHtml;

    // 投票选项预览
    if (selectedCategory && selectedCategory.getAttribute('data-value') === 'poll') {
      var pollInputs = document.querySelectorAll('.poll-option-input');
      var pollOptionsHtml = '<div class="preview-poll-section"><div class="preview-poll-title">📊 投票选项</div>';
      var isMultiple = document.getElementById('pollMultiple') && document.getElementById('pollMultiple').checked;
      pollInputs.forEach(function(inp) {
        var val = inp.value.trim();
        if (val) {
          pollOptionsHtml += '<div class="preview-poll-item' + (isMultiple ? ' multi' : '') + '">' + escapeHtml(val) + '</div>';
        }
      });
      pollOptionsHtml += '</div>';
      previewContent.innerHTML += pollOptionsHtml;
    }

    previewModal.classList.add('show');
    document.body.style.overflow = 'hidden';
  };

  window.closePreview = function() {
    var previewModal = document.getElementById('previewModal');
    if (previewModal) {
      previewModal.classList.remove('show');
      document.body.style.overflow = '';
    }
  };

  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') closePreview();
  });

  document.addEventListener('click', function(e) {
    var previewModal = document.getElementById('previewModal');
    if (previewModal && e.target === previewModal) closePreview();
  });

  // ============================================
  // 图片上传区域初始化
  // ============================================
  if (uploadArea && fileInput) {

    // 点击上传区域触发文件选择
    uploadArea.addEventListener('click', function(e) {
      // 如果点击的是删除按钮，不触发上传
      if (e.target.closest('.preview-delete-btn')) return;
      fileInput.click();
    });

    uploadArea.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fileInput.click();
      }
    });

    // 文件选择变化事件
    fileInput.addEventListener('change', function() {
      if (this.files && this.files.length > 0) {
        handleFileSelect(this.files);
        // 清空input值，允许重复选择同一文件
        this.value = '';
      }
    });

    // 拖拽事件
    uploadArea.addEventListener('dragover', function(e) {
      e.preventDefault();
      e.stopPropagation();
      uploadArea.classList.add('drag-over');
    });

    uploadArea.addEventListener('dragleave', function(e) {
      e.preventDefault();
      e.stopPropagation();
      uploadArea.classList.remove('drag-over');
    });

    uploadArea.addEventListener('drop', function(e) {
      e.preventDefault();
      e.stopPropagation();
      uploadArea.classList.remove('drag-over');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        handleFileSelect(e.dataTransfer.files);
      }
    });
  }

  if (videoRemoveBtn) videoRemoveBtn.addEventListener('click', function() { setUploadedVideo(''); });

  var MAX_VIDEO_SIZE = 50 * 1024 * 1024;
  var ALLOWED_VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/ogg'];

  function revokeLocalVideoPreview() {
    if (localVideoObjectUrl) {
      URL.revokeObjectURL(localVideoObjectUrl);
      localVideoObjectUrl = '';
    }
    if (localVideoPosterUrl) {
      URL.revokeObjectURL(localVideoPosterUrl);
      localVideoPosterUrl = '';
    }
  }

  function updateVideoPreviewStatus(text, state) {
    if (!videoPreviewStatus) return;
    videoPreviewStatus.textContent = text || '';
    if (state) videoPreviewStatus.setAttribute('data-state', state);
    else videoPreviewStatus.removeAttribute('data-state');
  }

  function showVideoPreviewCover(posterUrl, text) {
    if (videoPreviewPoster) {
      if (posterUrl) {
        videoPreviewPoster.src = posterUrl;
        videoPreviewPoster.hidden = false;
      } else {
        videoPreviewPoster.removeAttribute('src');
        videoPreviewPoster.hidden = true;
      }
    }
    if (videoPreviewCoverText) videoPreviewCoverText.textContent = text || '点击预览视频';
    if (videoPreviewCover) videoPreviewCover.hidden = false;
  }

  function hideVideoPreviewCover() {
    if (videoPreviewCover) videoPreviewCover.hidden = true;
  }

  if (videoPreviewCover) {
    // iOS Safari/微信内置浏览器通常要求用户手势后才允许本地 blob 视频开始播放。
    videoPreviewCover.addEventListener('click', function() {
      hideVideoPreviewCover();
      if (!videoPreview) return;
      videoPreview.controls = true;
      var playPromise = videoPreview.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch(function() {
          showVideoPreviewCover(videoPreviewPoster && videoPreviewPoster.src, '点击播放视频');
        });
      }
    });
  }

  function showLocalVideoPreview(file) {
    revokeLocalVideoPreview();
    localVideoObjectUrl = URL.createObjectURL(file);
    uploadedVideo = '';
    uploadedVideoPoster = '';

    if (videoPreviewWrap) {
      videoPreviewWrap.hidden = false;
      videoPreviewWrap.classList.add('is-uploading');
      videoPreviewWrap.classList.remove('is-ready', 'is-error');
    }
    if (videoPreview) {
      videoPreview.pause();
      videoPreview.muted = true;
      videoPreview.playsInline = true;
      videoPreview.setAttribute('webkit-playsinline', '');
      videoPreview.removeAttribute('poster');
      videoPreview.src = localVideoObjectUrl;
      videoPreview.load();
    }
    showVideoPreviewCover('', '点击预览视频');
    updateVideoPreviewStatus('本地预览 · 正在准备封面并上传…', 'uploading');
  }

  function setLocalVideoPoster(posterFile) {
    if (!posterFile || !videoPreview) return;
    if (localVideoPosterUrl) URL.revokeObjectURL(localVideoPosterUrl);
    localVideoPosterUrl = URL.createObjectURL(posterFile);
    videoPreview.setAttribute('poster', localVideoPosterUrl);
    showVideoPreviewCover(localVideoPosterUrl, '点击预览视频');
  }

  function setUploadedVideo(url, poster) {
    var localPosterForCover = poster ? '' : localVideoPosterUrl;
    uploadedVideo = url || '';
    uploadedVideoPoster = poster || '';
    if (!uploadedVideo) videoUploadToken++;
    if (uploadedVideo) {
      if (localVideoObjectUrl) {
        URL.revokeObjectURL(localVideoObjectUrl);
        localVideoObjectUrl = '';
      }
      if (localVideoPosterUrl && !localPosterForCover) {
        URL.revokeObjectURL(localVideoPosterUrl);
        localVideoPosterUrl = '';
      }
    } else {
      revokeLocalVideoPreview();
    }
    if (videoPreviewWrap) {
      videoPreviewWrap.hidden = !uploadedVideo;
      videoPreviewWrap.classList.remove('is-uploading');
      videoPreviewWrap.classList.toggle('is-ready', !!uploadedVideo);
      videoPreviewWrap.classList.remove('is-error');
    }
    updateVideoPreviewStatus(uploadedVideo ? '视频已上传，可继续发布' : '', uploadedVideo ? 'success' : '');
    if (videoPreview) {
      videoPreview.pause();
      if (uploadedVideo) {
        videoPreview.src = uploadedVideo;
        var coverUrl = uploadedVideoPoster || localPosterForCover;
        if (coverUrl) videoPreview.setAttribute('poster', coverUrl);
        else videoPreview.removeAttribute('poster');
        videoPreview.load();
        showVideoPreviewCover(coverUrl, '点击预览视频');
      } else {
        videoPreview.removeAttribute('src');
        videoPreview.removeAttribute('poster');
        videoPreview.load();
        hideVideoPreviewCover();
      }
    }
  }

  function createVideoPoster(file) {
    return new Promise(function(resolve) {
      var objectUrl = URL.createObjectURL(file);
      var source = document.createElement('video');
      var finished = false;
      var appendedToDocument = false;
      function finish(result) {
        if (finished) return;
        finished = true;
        URL.revokeObjectURL(objectUrl);
        source.removeAttribute('src');
        source.load();
        if (appendedToDocument && source.parentNode) source.parentNode.removeChild(source);
        resolve(result || null);
      }
      source.muted = true;
      source.playsInline = true;
      source.setAttribute('webkit-playsinline', '');
      source.preload = 'metadata';
      source.setAttribute('aria-hidden', 'true');
      source.style.position = 'fixed';
      source.style.left = '-9999px';
      source.style.top = '0';
      source.style.width = '2px';
      source.style.height = '2px';
      source.style.opacity = '0.01';
      source.style.pointerEvents = 'none';
      if (document.body) {
        document.body.appendChild(source);
        appendedToDocument = true;
      }
      function drawPoster() {
        if (finished || source.readyState < 2 || !source.videoWidth || !source.videoHeight) return;
        try {
          var canvas = document.createElement('canvas');
          var maxSide = 1280;
          var scale = Math.min(1, maxSide / Math.max(source.videoWidth, source.videoHeight));
          canvas.width = Math.max(1, Math.round(source.videoWidth * scale));
          canvas.height = Math.max(1, Math.round(source.videoHeight * scale));
          var context = canvas.getContext('2d');
          if (!context) return;
          context.drawImage(source, 0, 0, canvas.width, canvas.height);
          // iOS 某些版本对 canvas.toBlob 支持不完整，toDataURL 更稳定，再转为 File 上传。
          var dataUrl = canvas.toDataURL('image/jpeg', 0.86);
          var comma = dataUrl.indexOf(',');
          if (comma === -1) return;
          var binary = atob(dataUrl.slice(comma + 1));
          var bytes = new Uint8Array(binary.length);
          for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          finish(new File([new Blob([bytes], { type: 'image/jpeg' })], 'poster.jpg', { type: 'image/jpeg' }));
        } catch (err) {
          console.warn('生成视频封面失败，将使用可点击的视频占位封面:', err);
        }
      }
      source.addEventListener('loadedmetadata', function() {
        try {
          if (Number.isFinite(source.duration) && source.duration > 0) source.currentTime = Math.min(0.1, source.duration / 2);
        } catch (err) {}
      });
      source.addEventListener('loadeddata', drawPoster);
      source.addEventListener('canplay', drawPoster);
      source.addEventListener('seeked', drawPoster);
      source.addEventListener('error', function() { finish(null); }, { once: true });
      window.setTimeout(function() { finish(null); }, 10000);
      source.src = objectUrl;
      source.load();
    });
  }

  function uploadVideo(file) {
    if (uploadedVideo || localVideoObjectUrl || videoUploading) {
      showToast('一条帖子只能添加一个视频，请先移除当前视频', 'warning');
      return;
    }
    var hasAllowedExtension = /\.(mp4|webm|ogv)$/i.test(file.name || '');
    if (ALLOWED_VIDEO_TYPES.indexOf(file.type) === -1 && !hasAllowedExtension) {
      showToast('仅支持 MP4、WebM、OGV 格式的视频', 'error');
      return;
    }
    if (file.size > MAX_VIDEO_SIZE) {
      showToast('视频不能超过 50MB', 'error');
      return;
    }
    var uploadToken = ++videoUploadToken;
    videoUploading = true;
    showToast('正在上传视频...', 'info');
    if (uploadArea) uploadArea.classList.add('is-uploading-video');
    showLocalVideoPreview(file);
    createVideoPoster(file).then(function(posterFile) {
      if (uploadToken !== videoUploadToken) return null;
      if (posterFile) setLocalVideoPoster(posterFile);
      updateVideoPreviewStatus('本地预览 · 正在上传视频…', 'uploading');
      var formData = new FormData();
      formData.append('video', file);
      if (posterFile) formData.append('poster', posterFile);
      return authFetch('/api/upload/post-video', { method: 'POST', body: formData });
    })
      .then(function(data) {
        if (!data || uploadToken !== videoUploadToken) return;
        if (data.code === 200 && data.data && data.data.video) {
          setUploadedVideo(data.data.video, data.data.poster || '');
          showToast('视频上传成功');
        } else {
          if (videoPreviewWrap) {
            videoPreviewWrap.classList.remove('is-uploading');
            videoPreviewWrap.classList.add('is-error');
          }
          updateVideoPreviewStatus('本地预览保留 · 上传失败，请移除后重试', 'error');
          showToast(data.message || '视频上传失败', 'error');
        }
      })
      .catch(function(err) {
        if (uploadToken !== videoUploadToken) return;
        console.error('视频上传失败:', err);
        if (videoPreviewWrap) {
          videoPreviewWrap.classList.remove('is-uploading');
          videoPreviewWrap.classList.add('is-error');
        }
        updateVideoPreviewStatus('本地预览保留 · 上传失败，请移除后重试', 'error');
        showToast('视频上传失败，请重试', 'error');
      })
      .finally(function() {
        videoUploading = false;
        if (uploadArea) uploadArea.classList.remove('is-uploading-video');
        if (uploadToken === videoUploadToken && videoPreviewWrap) {
          videoPreviewWrap.classList.remove('is-uploading');
        }
      });
  }

  /**
   * 图片压缩配置
   */
  var COMPRESSION_CONFIG = {
    maxWidth: 1920,      // 最大宽度
    maxHeight: 1920,     // 最大高度
    quality: 0.8,        // 压缩质量 (0-1)
    maxSizeBeforeCompress: 500 * 1024 // 超过500KB才压缩
  };

  /**
   * 压缩图片文件
   * @param {File} file - 原始图片文件
   * @returns {Promise<File>} - 压缩后的图片文件
   */
  function compressImage(file) {
    return new Promise(function(resolve, reject) {
      // GIF 不压缩，保持动画效果
      if (file.type === 'image/gif') {
        resolve(file);
        return;
      }

      // 小于500KB不压缩
      if (file.size < COMPRESSION_CONFIG.maxSizeBeforeCompress) {
        resolve(file);
        return;
      }

      var reader = new FileReader();
      reader.onload = function(e) {
        var img = new Image();
        img.onload = function() {
          // 计算压缩后的尺寸
          var width = img.width;
          var height = img.height;

          if (width > COMPRESSION_CONFIG.maxWidth || height > COMPRESSION_CONFIG.maxHeight) {
            var ratio = Math.min(COMPRESSION_CONFIG.maxWidth / width, COMPRESSION_CONFIG.maxHeight / height);
            width = Math.round(width * ratio);
            height = Math.round(height * ratio);
          }

          // 创建 Canvas 进行压缩
          var canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;

          var ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);

          // 转换为 Blob
          var mimeType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
          var quality = COMPRESSION_CONFIG.quality;

          canvas.toBlob(function(blob) {
            if (blob) {
              // 生成新的文件名
              var originalName = file.name;
              var ext = originalName.split('.').pop();
              var baseName = originalName.substring(0, originalName.lastIndexOf('.'));
              var newName = baseName + '_compressed.' + ext;

              // 创建新的 File 对象
              var compressedFile = new File([blob], newName, {
                type: mimeType,
                lastModified: Date.now()
              });

              var savedSize = file.size - compressedFile.size;
              var savedPercent = Math.round((savedSize / file.size) * 100);

              resolve(compressedFile);
            } else {
              resolve(file);
            }
          }, mimeType, quality);
        };
        img.onerror = function() {
          reject(new Error('图片加载失败'));
        };
        img.src = e.target.result;
      };
      reader.onerror = function() {
        reject(new Error('文件读取失败'));
      };
      reader.readAsDataURL(file);
    });
  }

  /**
   * 处理文件选择
   * @param {FileList} files - 选择的文件列表
   */
  function handleFileSelect(files) {
    var imageFiles = [];
    var videoFiles = [];
    for (var i = 0; i < files.length; i++) {
      var file = files[i];

      if (ALLOWED_TYPES.indexOf(file.type) !== -1) {
        imageFiles.push(file);
      } else if (ALLOWED_VIDEO_TYPES.indexOf(file.type) !== -1 || /\.(mp4|webm|ogv)$/i.test(file.name || '')) {
        videoFiles.push(file);
      } else {
        showToast('仅支持 JPG、PNG、GIF、WebP 图片和 MP4、WebM、OGV 视频', 'error');
      }
    }

    if (imageFiles.length > 0 && videoFiles.length > 0) {
      showToast('图片和视频不能同时选择，请分开选择', 'warning');
      return;
    }

    if (videoFiles.length > 0) {
      if (uploadedImages.length > 0) {
        showToast('当前已添加图片，不能再添加视频，请先移除图片', 'warning');
        return;
      }
      if (videoFiles.length > 1) showToast('一次只能选择一个视频，已使用第一个', 'warning');
      uploadVideo(videoFiles[0]);
    }

    if (imageFiles.length > 0 && (uploadedVideo || localVideoObjectUrl || videoUploading)) {
      showToast('当前已添加视频，不能再添加图片，请先移除视频', 'warning');
      return;
    }

    var availableImages = MAX_IMAGES - uploadedImages.length;
    if (imageFiles.length > availableImages) {
      showToast('最多只能上传' + MAX_IMAGES + '张图片，超出部分未添加', 'warning');
      imageFiles = imageFiles.slice(0, Math.max(availableImages, 0));
    }
    if (imageFiles.length > 0) {
      imageFiles.forEach(function(file) {
        showUploadPlaceholder();
        compressImage(file).then(function(compressedFile) {
          uploadSingleImage(compressedFile, file.size);
        }).catch(function(err) {
          console.error('图片压缩失败:', err);
          uploadSingleImage(file, file.size);
        }).finally(function() {
          hideUploadPlaceholder();
        });
      });
    }
  }

  function showUploadPlaceholder() {
    var placeholder = document.getElementById('uploadPlaceholder');
    if (placeholder) {
      placeholder.classList.add('uploading');
    }
  }

  function hideUploadPlaceholder() {
    var placeholder = document.getElementById('uploadPlaceholder');
    if (placeholder) {
      placeholder.classList.remove('uploading');
    }
  }

  /**
   * 上传单张图片到服务端
   * @param {File} file - 图片文件
   * @param {number} originalSize - 原始文件大小（用于显示压缩效果）
   */
  function uploadSingleImage(file, originalSize) {
    var formData = new FormData();
    formData.append('images', file);

    // 显示上传中状态
    showToast('正在上传图片...', 'info');

    authFetch('/api/upload/post-images', {
      method: 'POST',
      body: formData
    }).then(function(data) {
      if (data.code === 200) {
        // 获取上传后的图片路径
        var newImages = data.data.images || [];
        newImages.forEach(function(img) {
          if (uploadedImages.length < MAX_IMAGES) {
            uploadedImages.push(img);
          }
        });
        renderImagePreviews();

        // 显示压缩效果
        if (originalSize && file.size < originalSize) {
          var saved = Math.round((originalSize - file.size) / 1024);
          showToast('图片上传成功 (节省' + saved + 'KB)');
        } else {
          showToast('图片上传成功');
        }
      } else {
        showToast(data.message || '图片上传失败', 'error');
      }
    }).catch(function(err) {
      console.error('图片上传失败:', err);
      showToast('图片上传失败，请重试', 'error');
    });
  }

  /**
   * 渲染图片预览列表
   */
  function renderImagePreviews() {
    if (!imagePreviewList) return;

    var html = '';
    for (var i = 0; i < uploadedImages.length; i++) {
      html += '<div class="image-preview-item" data-index="' + i + '">' +
        '<img src="' + escapeHtml(uploadedImages[i]) + '" onclick="previewImage(\'' + escapeHtml(uploadedImages[i]).replace(/'/g, "\\'") + '\')">' +
        '<button type="button" class="preview-delete-btn" data-index="' + i + '" title="删除图片">&times;</button>' +
      '</div>';
    }
    imagePreviewList.innerHTML = html;

    // 更新上传区域显示状态
    if (uploadedImages.length >= MAX_IMAGES) {
      if (uploadArea) uploadArea.style.display = 'none';
    } else {
      if (uploadArea) uploadArea.style.display = '';
    }

    // 绑定删除按钮事件
    var deleteBtns = imagePreviewList.querySelectorAll('.preview-delete-btn');
    for (var j = 0; j < deleteBtns.length; j++) {
      deleteBtns[j].addEventListener('click', function(e) {
        e.stopPropagation();
        var idx = parseInt(this.getAttribute('data-index'));
        uploadedImages.splice(idx, 1);
        renderImagePreviews();
      });
    }
  }

  // ============================================
  function addPollOption() {
  var container = document.getElementById("pollOptionsContainer");
  if (!container) return;
  var num = container.querySelectorAll(".poll-option-input").length + 1;
  var div = document.createElement("div");
  div.className = "poll-option-row";
  div.innerHTML = '<input type="text" class="form-input poll-option-input" placeholder="选项 ' + num + '" maxlength="100"><button type="button" class="btn-del-option" onclick="this.parentElement.remove()">✕</button>';
  container.appendChild(div);
}
window.addPollOption = addPollOption;

// 分类选择
  // ============================================
  var categoryContainer = document.querySelector('.category-tags');
  if (categoryContainer) {
    categoryContainer.addEventListener('click', function(e) {
      var tag = e.target.closest('.category-tag');
      if (!tag) return;

      // 切换选中状态
      var allTags = categoryContainer.querySelectorAll('.category-tag');
      for (var i = 0; i < allTags.length; i++) {
        allTags[i].classList.remove('selected');
      }
      tag.classList.add('selected');

      // 失物招领显示联系方式输入框
      var contactGroup = document.getElementById('contactGroup');
      if (contactGroup) {
        contactGroup.style.display = tag.getAttribute('data-value') === 'lost_found' ? 'block' : 'none';
      }
      // 投票显示投票选项
      var pollGroup = document.getElementById('pollGroup');
      if (pollGroup) {
        pollGroup.style.display = tag.getAttribute('data-value') === 'poll' ? 'block' : 'none';
      }
    });
  }

  // ============================================
  // 匿名开关 - 根据设置显示/隐藏
  // ============================================
  var anonymousOption = document.getElementById('anonymousOption');
  var anonymousToggle = document.getElementById('anonymousToggle');

  (window.CampusWallThemeSettings ? window.CampusWallThemeSettings() : authFetch('/api/site-info')).then(function(settings) {
    if (settings && (settings.anon_post || (settings.data && settings.data.anon_post))) {
      if (anonymousOption) {
        anonymousOption.style.display = 'flex';
      }
    }
  }).catch(function() {
  });

  if (anonymousToggle) {
    anonymousToggle.addEventListener('change', function() {
      // toggle状态自动更新，无需额外处理
    });
  }

  // ============================================
  // 表单提交
  // ============================================
  if (postForm) {
    postForm.addEventListener('submit', function(e) {
      e.preventDefault();
      handleSubmit();
    });
  }

  /**
   * 处理发帖表单提交
   */
  function handleSubmit() {
    if (isSubmitting) return;

    // 获取表单数据
    var titleEl = document.getElementById('postTitle');
    var contentEl = document.getElementById('postContent');
    var selectedCategory = document.querySelector('.category-tag.selected');
    var anonymousToggle = document.getElementById('anonymousToggle');

    var title = titleEl ? titleEl.value.trim() : '';
    var content = postEditor ? postEditor.getValue().trim() : (contentEl ? contentEl.value.trim() : '');
    var category = selectedCategory ? selectedCategory.getAttribute('data-value') || selectedCategory.textContent.trim() : '';
    var isAnonymous = anonymousToggle ? anonymousToggle.checked : false;

    // 表单验证
    if (!title) {
      showToast('请输入帖子标题', 'error');
      if (titleEl) titleEl.focus();
      return;
    }

    if (!category) {
      showToast('请选择帖子分类', 'error');
      return;
    }

    // 开始提交
    isSubmitting = true;
    var submitBtn = postForm.querySelector('button[type="submit"]');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = '发布中...';
    }

    // 获取真实公网IP
    getClientRealIP().then(function(clientIP) {
      // 构建帖子数据
      var postData = {
        title: title,
        content: content,
        images: uploadedImages,
        video_url: uploadedVideo || null,
        video_poster: uploadedVideoPoster || null,
        category: category,
        is_anonymous: isAnonymous,
        contact: document.getElementById('contactInput')?document.getElementById('contactInput').value.trim():'',
        pollOptions: (function(){var inputs=document.querySelectorAll('.poll-option-input');var opts=[];for(var i=0;i<inputs.length;i++){var v=inputs[i].value.trim();if(v)opts.push(v);}return opts;})(),
        pollType: document.getElementById('pollMultiple')&&document.getElementById('pollMultiple').checked?'multiple':'single',
        pollExpiresAt: null,
        client_ip: clientIP // 添加客户端真实IP
      };

      // 发送发帖请求
      return authFetch('/api/posts', {
        method: 'POST',
        body: JSON.stringify(postData)
      }).then(function(data) {
        isSubmitting = false;
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = '发布帖子';
        }

        if (data.code === 200) {
          // 发布成功后清除草稿
          clearDraft();

          // 检查是否需要审核
          if (data.message && data.message.includes('等待审核')) {
            showToast('发布成功，请等待审核通过');
            window.location.href = '/';
          } else {
            showToast('发布成功');
            // 跳转到帖子详情页
            var newPostId = data.data.id;
            if (newPostId) {
              window.location.href = '/post/' + newPostId;
            } else {
              window.location.href = '/';
            }
          }
        } else {
          showToast(data.message || '发布失败，请重试', 'error');
        }
      });
    }).catch(function(err) {
      isSubmitting = false;
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = '发布帖子';
      }
      console.error('发帖失败:', err);
      showToast('网络错误，请稍后重试', 'error');
    });
  }

  /**
   * 获取客户端真实公网IP和地址
   */
  function getClientRealIP() {
    return Promise.resolve(null);
  }

});
