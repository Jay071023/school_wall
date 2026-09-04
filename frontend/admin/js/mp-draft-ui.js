(function (window) {
    'use strict';

    // 公众号草稿页的轻量 UI 提示函数。保留全局名称，兼容 HTML 内联按钮和主脚本。
    function setStatus(msg, type) {
        type = type || 'info';
        var el = document.getElementById('statusBar');
        if (type === 'loading') {
            el.innerHTML = '<span class="loading"></span> ' + msg;
        } else {
            el.innerHTML = msg;
        }
    }

    function showMsg(elId, text, type) {
        var el = document.getElementById(elId);
        if (!el) return;
        el.className = 'msg ' + type;
        el.innerHTML = text;
        setTimeout(function () { el.className = 'msg'; }, 6000);
    }

    function showToast(text, type) {
        var toast = document.createElement('div');
        toast.style.cssText = 'position:fixed;top:20px;right:20px;padding:12px 20px;border-radius:10px;color:#fff;font-size:14px;z-index:9999;animation:fadeIn 0.3s;';
        toast.style.background = type === 'success' ? 'linear-gradient(135deg,#10b981,#34d399)' : type === 'error' ? 'linear-gradient(135deg,#ef4444,#f87171)' : 'linear-gradient(135deg,#3b82f6,#60a5fa)';
        toast.textContent = text;
        document.body.appendChild(toast);
        setTimeout(function () { toast.remove(); }, 3000);
    }

    window.setStatus = setStatus;
    window.showMsg = showMsg;
    window.showToast = showToast;
}(window));
