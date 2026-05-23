/**
 * 嘉二の墙墙 - 登录注册模块 (auth.js)
 * 处理登录和注册表单的提交、验证及跳转
 * 后端API返回格式：{ code: 200, message: '...', data: {...} }
 */

document.addEventListener('DOMContentLoaded', function() {

  // 页面加载时检查已登录则跳转首页
  if (isLoggedIn()) {
    window.location.href = '/';
    return;
  }

  // ============================================
  // 记住我复选框 - 确保 UI 响应正常
  // ============================================
  var rememberMeCheckbox = document.getElementById('rememberMe');
  if (rememberMeCheckbox) {
    // 确保 checkbox 可以正常切换
    rememberMeCheckbox.addEventListener('click', function(e) {
      console.log('记住我点击:before:', this.checked);
      // 让浏览器自动处理，不阻止默认行为
    });
    
    rememberMeCheckbox.addEventListener('change', function() {
      console.log('记住我状态变化:', this.checked);
      // 保存状态到 localStorage
      localStorage.setItem('lastRemember', this.checked ? 'true' : 'false');
    });
    
    // 页面加载时恢复上次登录的状态（如果有）
    var lastRemember = localStorage.getItem('lastRemember');
    if (lastRemember === 'true') {
      rememberMeCheckbox.checked = true;
      console.log('恢复记住我状态：已勾选');
    }
  }

  // ============================================
  // 登录表单
  // ============================================
  var loginForm = document.getElementById('loginForm');
  if (loginForm) {
    loginForm.addEventListener('submit', function(e) {
      e.preventDefault();

      var usernameEl = document.getElementById('username');
      var passwordEl = document.getElementById('password');
      var username = usernameEl.value.trim();
      var password = passwordEl.value;

      if (!username) {
        showToast('请输入用户名', 'error');
        usernameEl.focus();
        return;
      }
      if (!password) {
        showToast('请输入密码', 'error');
        passwordEl.focus();
        return;
      }

      var submitBtn = loginForm.querySelector('button[type="submit"]');
      var originalText = submitBtn.textContent;
      submitBtn.disabled = true;
      submitBtn.textContent = '登录中...';

      // 如果验证码可见，带上验证码
      var captchaGroup = document.getElementById('loginCaptchaGroup');
      var hasCaptcha = captchaGroup && captchaGroup.style.display !== 'none';
      var body = { username: username, password: password };
      if (hasCaptcha) {
        var captchaCodeEl = document.getElementById('captchaCode');
        body.captchaKey = window.loginCaptchaKey || '';
        body.captchaCode = captchaCodeEl ? captchaCodeEl.value.trim() : '';
      }

      authFetch('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify(body)
      }).then(function(data) {
        if (data.code === 200) {
          var rememberMe = document.getElementById('rememberMe');
          var remember = rememberMe ? rememberMe.checked : false;
          localStorage.setItem('lastRemember', remember ? 'true' : 'false');
          saveAuth(data.data.token, data.data.user, remember);
          showToast('登录成功');
          var staffRoles = ['reviewer', 'radio_admin', 'admin', 'super_admin'];
          if (staffRoles.indexOf(data.data.user.role) !== -1) {
            window.location.href = '/admin';
          } else {
            window.location.href = '/';
          }
        } else {
          // 如果后端要求验证码，显示并刷新
          if (data.needCaptcha) {
            var captchaGroup = document.getElementById('loginCaptchaGroup');
            if (captchaGroup) {
              captchaGroup.style.display = 'flex';
              var event = new Event('loginCaptchaRequired');
              document.dispatchEvent(event);
            }
          }
          showToast(data.message || '登录失败', 'error');
          submitBtn.disabled = false;
          submitBtn.textContent = originalText;
        }
      }).catch(function(err) {
        console.error('登录请求失败:', err);
        showToast('网络错误，请稍后重试', 'error');
        submitBtn.disabled = false;
        submitBtn.textContent = originalText;
      });
    });
  }

  // ============================================
  // 注册表单
  // ============================================
  var registerForm = document.getElementById('registerForm');
  if (registerForm) {
    registerForm.addEventListener('submit', function(e) {
      // 如果页面中有微信验证方式且当前为微信模式，由页面处理
      if (window.currentVerifyMethod === 'wechat' || document.getElementById('verifyWechat') && document.getElementById('verifyWechat').style.display !== 'none') {
        return;
      }
      e.preventDefault();

      var usernameEl = document.getElementById('username');
      var nicknameEl = document.getElementById('nickname');
      var emailEl = document.getElementById('email');
      var passwordEl = document.getElementById('password');
      var confirmEl = document.getElementById('confirmPassword');

      var username = usernameEl.value.trim();
      var nickname = nicknameEl.value.trim();
      var email = emailEl ? emailEl.value.trim() : '';
      var password = passwordEl.value;
      var confirmPassword = confirmEl.value;

      // 表单验证
      if (!username) {
        showToast('请输入用户名', 'error');
        usernameEl.focus();
        return;
      }
      if (username.length < 3) {
        showToast('用户名至少需要3个字符', 'error');
        usernameEl.focus();
        return;
      }
      if (!nickname) {
        showToast('请输入昵称', 'error');
        nicknameEl.focus();
        return;
      }
      if (!email) {
        showToast('请输入邮箱，用于接收通知和找回密码', 'error');
        emailEl.focus();
        return;
      }
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        showToast('请输入正确的邮箱格式', 'error');
        emailEl.focus();
        return;
      }
      if (!password) {
        showToast('请输入密码', 'error');
        passwordEl.focus();
        return;
      }
      if (password.length < 6) {
        showToast('密码至少需要6位', 'error');
        passwordEl.focus();
        return;
      }
      if (password !== confirmPassword) {
        showToast('两次输入的密码不一致', 'error');
        confirmEl.focus();
        return;
      }

      // 禁用提交按钮
      var submitBtn = registerForm.querySelector('button[type="submit"]');
      var originalText = submitBtn.textContent;
      submitBtn.disabled = true;
      submitBtn.textContent = '注册中...';
      
      // 获取验证码
      var captchaCodeEl = document.getElementById('captchaCode');
      var captchaCode = captchaCodeEl ? captchaCodeEl.value.trim() : '';
      var captchaKey = window.captchaKey || '';

      // 发送注册请求
      authFetch('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({ 
          username: username, 
          nickname: nickname, 
          email: email || null, 
          password: password,
          captchaKey: captchaKey,
          captchaCode: captchaCode
        })
      }).then(function(data) {
        if (data.code === 400 && data.message.includes('验证码')) {
          // 验证码错误，重新加载
          loadCaptcha();
        }
        if (data.code === 200) {
          // 注册成功
          showToast('注册成功，请登录');
          // 跳转登录页
          window.location.href = '/login';
        } else {
          // 注册失败
          showToast(data.message || '注册失败，请稍后重试', 'error');
          submitBtn.disabled = false;
          submitBtn.textContent = originalText;
        }
      }).catch(function(err) {
        console.error('注册请求失败:', err);
        showToast('网络错误，请稍后重试', 'error');
        submitBtn.disabled = false;
        submitBtn.textContent = originalText;
      });
    });
  }

});
