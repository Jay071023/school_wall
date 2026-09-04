/**
 * HTML 工具函数
 * 集中管理 HTML 转义等操作，避免多份重复实现
 */

module.exports = {
  escapeHtml: function(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
};
