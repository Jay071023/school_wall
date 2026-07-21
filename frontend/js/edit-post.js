/**
 * 嘉二の墙墙 - 编辑帖子模块 (edit-post.js)
 * 功能：加载帖子数据、图片上传（拖拽+点击）、图片预览和删除、分类选择、匿名开关、表单提交
 * 后端API返回格式：{ code: 200, message: '...', data: {...} }
 */

document.addEventListener('DOMContentLoaded', function() {

  // 检查登录状态
  if (!isLoggedIn()) {
    window.location.href = '/login';
    return;
  }

  // 更新导航栏登录状态
  updateNavbar();

  // 从URL获取帖子ID
  var postId = window.location.pathname.split('/').pop();
  if (!postId || isNaN(postId)) {
    showToast('帖子不存在', 'error');
    window.location.href = '/';
    return;
  }

  // 状态变量
  var uploadedImages = [];     // 已上传的图片URL列表
  var MAX_IMAGES = 9;          // 最大图片数量
  var MAX_FILE_SIZE = 5 * 1024 * 1024; // 单张图片最大5MB
  var ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  var isSubmitting = false;
  var originalPostData = null; // 原始帖子数据

  // DOM元素引用
  var uploadArea = document.querySelector('.image-upload-area');
  var fileInput = document.getElementById('imageInput');
  var imagePreviewList = document.getElementById('imagePreviewList');
  var postForm = document.getElementById('editPostForm');
  var charCount = document.getElementById('charCount');
  var contentTextarea = document.getElementById('postContent');
  var categorySelect = document.getElementById('postCategory');
  var titleInput = document.getElementById('postTitle');
  var anonymousToggle = document.getElementById('anonymousToggle');
  var submitBtn = document.getElementById('submitBtn');

  // ============================================
  // 加载帖子数据
  // ============================================
  loadPostData();

  async function loadPostData() {
    try {
      var data = await authFetch('/api/posts/' + postId + '/edit');
      if (data.code === 200) {
        originalPostData = data.data;
        populateForm(originalPostData);
      } else if (data.code === 403) {
        showToast('无权编辑此帖子', 'error');
        window.location.href = '/post/' + postId;
      } else {
        showToast(data.message || '加载失败', 'error');
        window.location.href = '/';
      }
    } catch (err) {
      console.error('加载帖子数据失败:', err);
      showToast('网络错误，请稍后重试', 'error');
      window.location.href = '/';
    }
  }

  /**
   * 填充表单数据
   */
  function populateForm(post) {
    if (titleInput) titleInput.value = post.title || '';
    if (contentTextarea) contentTextarea.value = post.content || '';
    if (categorySelect) categorySelect.value = post.category || '日常';
    if (anonymousToggle) anonymousToggle.checked = post.is_anonymous;
    
    // 更新字符计数
    if (charCount && contentTextarea) {
      charCount.textContent = contentTextarea.value.length;
    }
    
    // 加载已有图片
    if (post.images && post.images.length > 0) {
      uploadedImages = post.images;
      renderImagePreviews();
    }
  }

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

  /**
   * 处理文件选择
   */
  function handleFileSelect(files) {
    for (var i = 0; i < files.length; i++) {
      var file = files[i];

      // 检查图片数量限制
      if (uploadedImages.length >= MAX_IMAGES) {
        showToast('最多只能上传' + MAX_IMAGES + '张图片', 'error');
        break;
      }

      // 检查文件大小
      if (file.size > MAX_FILE_SIZE) {
        showToast('图片大小不能超过5MB', 'error');
        continue;
      }

      // 检查文件类型
      if (ALLOWED_TYPES.indexOf(file.type) === -1) {
        showToast('仅支持 JPG、PNG、GIF、WebP 格式', 'error');
        continue;
      }

      // 预览图片
      var reader = new FileReader();
      reader.onload = (function(file, index) {
        return function(e) {
          uploadedImages.push(e.target.result);
          renderImagePreviews();
        };
      })(file, i);
      reader.readAsDataURL(file);
    }
  }

  /**
   * 渲染图片预览列表
   */
  function renderImagePreviews() {
    if (!imagePreviewList) return;
    
    var html = '';
    for (var i = 0; i < uploadedImages.length; i++) {
      html += '<div class="image-preview-item" data-index="' + i + '">' +
                '<img src="' + escapeHtml(uploadedImages[i]) + '" alt="预览">' +
                '<button type="button" class="preview-delete-btn" onclick="deleteImage(' + i + ')">✕</button>' +
              '</div>';
    }
    imagePreviewList.innerHTML = html;

    // 更新上传提示
    if (uploadArea) {
      var placeholder = uploadArea.querySelector('.upload-placeholder');
      if (placeholder) {
        placeholder.textContent = uploadedImages.length >= MAX_IMAGES ? '已达上限' : '继续添加';
      }
    }
  }

  // 将删除函数暴露到全局
  window.deleteImage = function(index) {
    uploadedImages.splice(index, 1);
    renderImagePreviews();
  };

  // ============================================
  // 内容输入监听
  // ============================================
  if (contentTextarea && charCount) {
    contentTextarea.addEventListener('input', function() {
      var len = this.value.length;
      charCount.textContent = len;
      if (len > 2000) {
        charCount.style.color = '#EF4444';
      } else {
        charCount.style.color = '';
      }
    });
  }

  // ============================================
  // 表单提交
  // ============================================
  if (postForm) {
    postForm.addEventListener('submit', async function(e) {
      e.preventDefault();
      
      if (isSubmitting) return;
      
      var content = contentTextarea ? contentTextarea.value.trim() : '';
      var title = titleInput ? titleInput.value.trim() : '';
      
      if (!content) {
        showToast('内容不能为空', 'error');
        contentTextarea.focus();
        return;
      }
      
      if (content.length > 2000) {
        showToast('内容不能超过2000字符', 'error');
        return;
      }
      
      isSubmitting = true;
      submitBtn.disabled = true;
      submitBtn.textContent = '保存中...';
      
      try {
        // 先上传新选择的图片
        var finalImages = [];
        
        // 筛选并上传新的图片（未上传过的）
        var newImages = [];
        for (var i = 0; i < uploadedImages.length; i++) {
          if (uploadedImages[i].startsWith('data:')) {
            newImages.push(uploadedImages[i]);
          } else {
            finalImages.push(uploadedImages[i]);
          }
        }
        
        // 上传新图片
        if (newImages.length > 0) {
          var uploadPromises = newImages.map(function(base64) {
            return uploadBase64Image(base64);
          });
          var uploadedUrls = await Promise.all(uploadPromises);
          finalImages = finalImages.concat(uploadedUrls.filter(Boolean));
        }
        
        // 构建提交数据
        var submitData = {
          title: title,
          content: content,
          category: categorySelect ? categorySelect.value : '日常',
          is_anonymous: anonymousToggle ? anonymousToggle.checked : false
        };
        
        // 只在有图片时添加图片字段
        if (finalImages.length > 0) {
          submitData.images = finalImages;
        }
        
        // 提交编辑
        var data = await authFetch('/api/posts/' + postId, {
          method: 'PUT',
          body: JSON.stringify(submitData)
        });
        
        if (data.code === 200) {
          showToast(data.message);
          setTimeout(function() {
            window.location.href = '/post/' + postId;
          }, 1500);
        } else {
          showToast(data.message || '保存失败', 'error');
          isSubmitting = false;
          submitBtn.disabled = false;
          submitBtn.textContent = '保存修改';
        }
      } catch (err) {
        console.error('保存失败:', err);
        showToast('网络错误，请稍后重试', 'error');
        isSubmitting = false;
        submitBtn.disabled = false;
        submitBtn.textContent = '保存修改';
      }
    });
  }

  /**
   * 上传Base64图片
   */
  async function uploadBase64Image(base64) {
    try {
      // 将Base64转换为Blob
      var response = await fetch(base64);
      var blob = await response.blob();
      var file = new File([blob], 'image.jpg', { type: blob.type });
      
      var formData = new FormData();
      formData.append('images', file);
      
      var data = await authFetch('/api/upload/post-images', {
        method: 'POST',
        body: formData
      });
      
      if (data.code === 200 && data.data && data.data.images && data.data.images.length > 0) {
        return data.data.images[0];
      }
      return null;
    } catch (err) {
      console.error('图片上传失败:', err);
      return null;
    }
  }

});
