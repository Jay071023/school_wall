/**
 * 嘉二の墙墙 - 发帖模块 (post.js)
 * 功能：图片上传（拖拽+点击）、图片预览和删除、分类选择、匿名开关、表单提交
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

  // 状态变量
  var uploadedImages = [];     // 已上传的图片URL列表
  var MAX_IMAGES = 9;          // 最大图片数量
  var MAX_FILE_SIZE = 5 * 1024 * 1024; // 单张图片最大5MB
  var ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  var isSubmitting = false;

  // DOM元素引用
  var uploadArea = document.querySelector('.image-upload-area');
  var fileInput = document.getElementById('fileInput');
  var imagePreviewList = document.getElementById('imagePreviewList');
  var postForm = document.getElementById('postForm');

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
              console.log('图片压缩: ' + originalName + ' (' + Math.round(file.size/1024) + 'KB) -> ' + newName + ' (' + Math.round(compressedFile.size/1024) + 'KB), 节省 ' + savedPercent + '%');

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
    var pendingCount = 0;

    for (var i = 0; i < files.length; i++) {
      var file = files[i];

      // 检查图片数量限制
      if (uploadedImages.length >= MAX_IMAGES) {
        showToast('最多只能上传' + MAX_IMAGES + '张图片', 'error');
        break;
      }

      // 检查文件类型
      if (ALLOWED_TYPES.indexOf(file.type) === -1) {
        showToast('仅支持 JPG、PNG、GIF、WebP 格式的图片', 'error');
        continue;
      }

      pendingCount++;
      var originalSize = file.size;

      // 先显示占位预览
      showUploadPlaceholder();

      // 压缩并上传
      compressImage(file).then(function(compressedFile) {
        uploadSingleImage(compressedFile, originalSize);
        pendingCount--;
        if (pendingCount === 0) {
          hideUploadPlaceholder();
        }
      }).catch(function(err) {
        console.error('图片压缩失败:', err);
        uploadSingleImage(file, originalSize);
        pendingCount--;
        if (pendingCount === 0) {
          hideUploadPlaceholder();
        }
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
    });
  }

  // ============================================
  // 匿名开关 - 根据设置显示/隐藏
  // ============================================
  var anonymousOption = document.getElementById('anonymousOption');
  var anonymousToggle = document.getElementById('anonymousToggle');
  
  authFetch('/api/site-info').then(function(data) {
    if (data && data.code === 200 && data.data.anon_post) {
      if (anonymousOption) {
        anonymousOption.style.display = 'flex';
      }
    }
  }).catch(function() {
    console.log('无法获取站点设置，隐藏匿名选项');
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
    var content = contentEl ? contentEl.value.trim() : '';
    var category = selectedCategory ? selectedCategory.getAttribute('data-value') || selectedCategory.textContent.trim() : '';
    var isAnonymous = anonymousToggle ? anonymousToggle.checked : false;

    // 表单验证
    if (!content) {
      showToast('请输入帖子内容', 'error');
      if (contentEl) contentEl.focus();
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
        category: category,
        is_anonymous: isAnonymous,
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
