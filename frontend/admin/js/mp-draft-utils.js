(function (window) {
    'use strict';

    // 公众号草稿页的无副作用工具函数。保持旧函数名为全局 API，兼容页面内联脚本。
    function escapeHtml(text) {
        if (!text) return '';
        var d = document.createElement('div');
        d.appendChild(document.createTextNode(text));
        return d.innerHTML;
    }

    // 统计最终 HTML 的可见文字，不把标签、媒体 URL 和统计标记算入字数。
    function countVisibleText(html) {
        var text = String(html || '')
            .replace(/<!--\s*mp-text-stats-start\s*-->[\s\S]*?<!--\s*mp-text-stats-end\s*-->/gi, '')
            .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<[^>]*>/g, ' ')
            .replace(/&nbsp;/gi, ' ')
            .replace(/&amp;/gi, '&')
            .replace(/&lt;/gi, '<')
            .replace(/&gt;/gi, '>')
            .replace(/&#39;|&apos;/gi, "'")
            .replace(/&quot;/gi, '"')
            .replace(/&#(\d+);/g, function (_, code) { return String.fromCodePoint(Number(code)); })
            .replace(/&#x([\da-f]+);/gi, function (_, code) { return String.fromCodePoint(parseInt(code, 16)); });
        return Array.from(text.replace(/\s/g, '')).length;
    }

    function countText(text) {
        return Array.from(String(text || '').replace(/\s/g, '')).length;
    }

    function getPreviewVideoUrl(value) {
        var pathname = String(value || '').split('?')[0];
        return /^\/uploads\/videos\/video_[A-Za-z0-9_-]+\.(?:mp4|webm|ogv)$/i.test(pathname)
            ? window.location.origin + pathname : '';
    }

    function getPreviewPosterUrl(value) {
        var pathname = String(value || '').split('?')[0];
        return /^\/uploads\/posts\/post_[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|gif|webp)$/i.test(pathname)
            ? window.location.origin + pathname : '';
    }

    function buildPreviewVideoHtml(post) {
        var videoUrl = getPreviewVideoUrl(post && post.video_url);
        if (!videoUrl) return '';
        var posterUrl = getPreviewPosterUrl(post && post.video_poster);
        var articleUrl = /^\d+$/.test(String(post && post.id || ''))
            ? window.location.origin + '/post/' + post.id : videoUrl;
        var cover = posterUrl ? '<img src="' + escapeHtml(posterUrl) + '" alt="视频封面" style="display:block;width:100%;max-height:360px;object-fit:cover;border-radius:10px;background:#172c2a;">' : '🎬 ';
        return '<div data-mp-video-placeholder="1" data-mp-video-source="' + escapeHtml(videoUrl) + '" data-mp-video-poster="' + escapeHtml(posterUrl) + '" data-mp-video-view="' + escapeHtml(articleUrl) + '" style="margin:16px 0 0;padding:12px;background:#F7F8FC;border:1px solid #ECECF5;border-radius:14px;text-align:center;">' +
            cover +
            '<br><span style="font-size:13px;color:#667eea;font-weight:700;">🎬 视频投稿 · 同步时上传公众号永久 MP4 素材</span><br>' +
            '<a href="' + escapeHtml(articleUrl) + '" style="color:#667eea;text-decoration:none;font-size:12px;line-height:1.6;">播放器无法显示？点击打开视频页面 →</a>' +
            '</div>';
    }

    function formatTime(unixTs) {
        if (!unixTs) return '未知';
        var d = new Date(unixTs * 1000);
        return d.getFullYear() + '-' +
            String(d.getMonth() + 1).padStart(2, '0') + '-' +
            String(d.getDate()).padStart(2, '0') + ' ' +
            String(d.getHours()).padStart(2, '0') + ':' +
            String(d.getMinutes()).padStart(2, '0');
    }

    window.escapeHtml = escapeHtml;
    window.countVisibleText = countVisibleText;
    window.countText = countText;
    window.getPreviewVideoUrl = getPreviewVideoUrl;
    window.getPreviewPosterUrl = getPreviewPosterUrl;
    window.buildPreviewVideoHtml = buildPreviewVideoHtml;
    window.formatTime = formatTime;
}(window));
