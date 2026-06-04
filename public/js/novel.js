// ===== 连载小说管理 =====
(function() {
    if (typeof window === 'undefined') return;
    // 站点配置（由后端注入到 window）
    var SITE_NAME = window.SITE_NAME || '校园墙';

    var storiesData = { stories: [], currentIndex: 0, editingIndex: -1, promptConfig: {} };
    var currentNovelId = '';
    var novelsList = [];
    var storyHasUnsavedChanges = false;
    var storyOriginalContent = '';
    var storyOriginalTitle = '';
    var storyAutoSaveTimer = null;
    var currentAIGenMode = 'continue';

    var aiModeDescs = {
        continue: '续写：基于当前章节内容，AI 续写下一章故事情节',
        expand: '扩写：对已有内容进行细节补充和场景扩展',
        rewrite: '改写：用不同的表达方式重写当前章节',
        summary: '概括：生成当前章节的内容摘要或章节要点'
    };

    // 从 localStorage 恢复上次选中的小说和章节
    (function restoreNovelState() {
        var saved = localStorage.getItem('novelState');
        if (saved) {
            try {
                var state = JSON.parse(saved);
                currentNovelId = state.novelId || '';
            } catch(e) {}
        }
    })();

    async function loadNovels() {
        try {
            var token = localStorage.getItem('token') || sessionStorage.getItem('token');
            var res = await fetch('/api/admin/novels', {
                headers: { 'Authorization': 'Bearer ' + token }
            });
            var json = await res.json();
            if (json.code === 200) {
                novelsList = json.data.novels || [];
                currentNovelId = json.data.activeNovelId || '';
                renderNovelSelector();
                return novelsList;
            }
        } catch(e) {
            console.warn('加载小说列表失败:', e.message);
        }
        return [];
    }

    function renderNovelSelector() {
        var sel = document.getElementById('novel-selector');
        if (!sel) return;
        sel.innerHTML = '';
        novelsList.forEach(function(n) {
            var opt = document.createElement('option');
            opt.value = n.id;
            opt.textContent = n.title;
            if (n.id === currentNovelId) opt.selected = true;
            sel.appendChild(opt);
        });
    }

    function switchNovel(novelId) {
        currentNovelId = novelId;
        localStorage.setItem('novelState', JSON.stringify({ novelId: novelId, chapterIndex: -1 }));
        var loading = document.getElementById('stories-loading');
        if (loading) loading.style.display = 'block';
        document.getElementById('stories-chapter-list').innerHTML = '';
        loadStoriesForNovel(novelId);
    }

    async function loadStoriesForNovel(novelId) {
        try {
            var token = localStorage.getItem('token') || sessionStorage.getItem('token');
            var url = '/api/admin/stories';
            if (novelId) url += '?novelId=' + encodeURIComponent(novelId);
            var res = await fetch(url, {
                headers: { 'Authorization': 'Bearer ' + token }
            });
            var json = await res.json();
            var loading = document.getElementById('stories-loading');
            if (loading) loading.style.display = 'none';
            if (json.code === 200) {
                storiesData = json.data;
                // 异步加载每个章节的字数和预览
                (function loadCharCounts() {
                    var token = localStorage.getItem('token') || sessionStorage.getItem('token');
                    storiesData.stories.forEach(function(story, i) {
                        fetch('/api/admin/stories/chapter-content?index=' + i + '&novelId=' + encodeURIComponent(novelId), {
                            headers: { 'Authorization': 'Bearer ' + token }
                        }).then(function(r) { return r.json(); }).then(function(j) {
                            if (j.code === 200 && j.data && j.data.content) {
                                var content = j.data.content;
                                var count = content.length;
                                story.charCount = count;
                                story.preview = content.replace(/\n+/g, ' ').substring(0, 50);
                                // 只刷新列表，不中断用户当前操作
                                if (storiesData.editingIndex !== i) renderChapterList();
                            }
                        }).catch(function() {});
                    });
                })();
                renderChapterList();
                if (storiesData.stories.length > 0) {
                    var savedState = localStorage.getItem('novelState');
                    var savedIdx = -1;
                    if (savedState) {
                        try {
                            var state = JSON.parse(savedState);
                            if (state.novelId === novelId && state.chapterIndex >= 0 && state.chapterIndex < storiesData.stories.length) {
                                savedIdx = state.chapterIndex;
                            }
                        } catch(e) {}
                    }
                    var idx = savedIdx >= 0 ? savedIdx : (storiesData.currentIndex >= 0 ? storiesData.currentIndex : 0);
                    storySelectForNovel(idx, novelId);
                }
                return storiesData;
            } else {
                showToast('加载小说失败: ' + (json.message || ''), 'error');
            }
        } catch(e) {
            var loading = document.getElementById('stories-loading');
            if (loading) loading.style.display = 'none';
            showToast('加载小说失败', 'error');
        }
    }

    function storySelectForNovel(index, novelId) {
        storySelect(index);
    }

    async function createNovel(title, author, desc) {
        try {
            var token = localStorage.getItem('token') || sessionStorage.getItem('token');
            var res = await fetch('/api/admin/novels/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                body: JSON.stringify({ title: title, author: author, desc: desc })
            });
            var json = await res.json();
            if (json.code === 200) {
                showToast('✅ ' + (json.message || '创建成功'), 'success');
                await loadNovels();
                switchNovel(json.data.id);
            } else {
                showToast('创建失败: ' + (json.message || ''), 'error');
            }
        } catch(e) {
            showToast('创建失败: ' + e.message, 'error');
        }
    }

    async function deleteCurrentNovel() {
        if (novelsList.length <= 1) { showToast('至少保留一本小说', 'error'); return; }
        if (!confirm('确定删除当前小说及其所有章节？此操作不可恢复！')) return;
        try {
            var token = localStorage.getItem('token') || sessionStorage.getItem('token');
            var res = await fetch('/api/admin/novels/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                body: JSON.stringify({ novelId: currentNovelId })
            });
            var json = await res.json();
            if (json.code === 200) {
                showToast('✅ 删除成功', 'success');
                await loadNovels();
                if (novelsList.length > 0) switchNovel(novelsList[0].id);
            } else {
                showToast('删除失败', 'error');
            }
        } catch(e) { showToast('删除失败', 'error'); }
    }

    function loadStories() { return loadNovels().then(function() { return loadStoriesForNovel(currentNovelId); }); }

    function renderChapterList() {
        var list = document.getElementById('stories-chapter-list');
        if (!storiesData.stories || storiesData.stories.length === 0) {
            list.innerHTML = '<div class="stories-empty"><div class="empty-icon">📭</div><div>暂无章节，点击"+ 新建"开始</div></div>';
            return;
        }
        var html = '';
        for (var i = 0; i < storiesData.stories.length; i++) {
            var s = storiesData.stories[i];
            var isActive = i === storiesData.editingIndex;
            var isCurrent = i === storiesData.currentIndex;
            var charCount = s.charCount || (s.content || '').length;
            var preview = s.preview || (s.content || '').replace(/\n+/g, ' ').substring(0, 50) || '';

            html += '<div class="story-chapter-item' + (isActive ? ' active' : '') + '" onclick="storySelect(' + i + ')">';
            html += '<div class="chap-num">' + (i + 1) + '</div>';
            html += '<div style="flex:1;min-width:0;">';
            html += '<div class="chap-title">' + (s.title || '无标题') + '</div>';
            if (charCount > 0) html += '<div class="chap-preview">' + preview + '</div>';
            html += '<div class="chap-meta">';
            if (charCount > 0) {
                html += '<span class="chap-wordcount">' + charCount + '字</span>';
                var readMin = charCount > 0 ? Math.ceil(charCount / 400) : 1;
                html += '<span>⏱' + readMin + '分钟</span>';
            } else {
                html += '<span style="color:#ccc;font-size:0.65rem;">待加载</span>';
            }
            if (isCurrent) html += '<span class="chap-current-badge">连载中</span>';
            if (s.published) html += '<span class="chap-current-badge" style="background:#43e97b;">已发布</span>';
            html += '</div></div></div>';
        }
        list.innerHTML = html;
    }

    function storySelect(index) {
        if (index < 0 || index >= storiesData.stories.length) return;
        if (storyHasUnsavedChanges) {
            if (!confirm('有未保存的更改，确定要切换章节吗？')) return;
        }
        storiesData.editingIndex = index;
        try {
            var state = JSON.parse(localStorage.getItem('novelState') || '{}');
            state.chapterIndex = index;
            localStorage.setItem('novelState', JSON.stringify(state));
        } catch(e) {}
        var s = storiesData.stories[index];
        var body = document.getElementById('stories-editor-body');
        document.getElementById('stories-editor-title').textContent = '📝 编辑：第' + (index + 1) + '章 ' + (s.title || '');

        storyHasUnsavedChanges = false;
        storyOriginalContent = s.content || '';
        storyOriginalTitle = s.title || '';

        body.innerHTML =
            '<div class="story-form-group">' +
                '<div style="display:flex;align-items:center;justify-content:space-between;">' +
                    '<label style="margin:0;">章节标题</label>' +
                    '<span class="save-status saved" id="storySaveStatus">✓ 已保存</span>' +
                '</div>' +
                '<input type="text" id="story-edit-title" value="' + escapeHtml(s.title || '') + '" placeholder="输入章节标题" oninput="storyMarkUnsaved()">' +
            '</div>' +
            '<div class="story-form-group">' +
                '<label>作者</label>' +
                '<input type="text" id="story-edit-author" value="' + escapeHtml(s.author || SITE_NAME + '编辑部') + '">' +
            '</div>' +
            '<div class="story-form-group">' +
                '<label>章节内容</label>' +
                '<textarea id="story-edit-content" placeholder="正在加载章节内容..." oninput="storyMarkUnsaved()">⏳ 加载中...</textarea>' +
                '<div class="word-progress" id="storyWordProgress">' +
                    '<div class="word-progress-text"><span id="storyWordCount">0 字</span><span id="storyReadTime">约 1 分钟</span></div>' +
                    '<div class="word-progress-bar"><div class="word-progress-fill" id="storyWordFill" style="width:0%"></div></div>' +
                    '<div class="word-progress-text"><span>目标: 2000字</span><span id="storyProgressPercent">0%</span></div>' +
                '</div>' +
                '<div class="char-count"><span id="story-char-count">0 字</span><span id="story-auto-save-status" style="color:#bbb;font-size:12px;margin-left:8px;"></span></div>' +
            '</div>' +
            '<div class="story-actions">' +
                '<button class="story-btn story-btn-primary" onclick="storySave()">💾 保存</button>' +
                '<button class="story-btn story-btn-success" style="background:linear-gradient(135deg,#667eea,#764ba2);" onclick="storySetCurrent(' + index + ')">📌 设为连载</button>' +
                '<button class="story-btn story-btn-primary" style="background:linear-gradient(135deg,#43e97b,#38f9d7) !important;" onclick="storyPublishToWechat(' + index + ')">📤 推送</button>' +
                '<button class="story-btn story-btn-danger" onclick="storyDelete(' + index + ')">🗑 删除</button>' +
            '</div>' +
            '<div class="shortcuts-hint">' +
                '<span><kbd>Ctrl+S</kbd> 保存</span>' +
                '<span><kbd>Ctrl+Enter</kbd> 发布</span>' +
                '<span><kbd>Esc</kbd> 取消</span>' +
            '</div>';

        loadChapterContent(index);
        document.getElementById('story-btn-prev').disabled = index <= 0;
        document.getElementById('story-btn-next').disabled = index >= storiesData.stories.length - 1;
    }

    async function loadChapterContent(index) {
        try {
            var token = localStorage.getItem("token") || sessionStorage.getItem("token");
            var res = await fetch('/api/admin/stories/chapter-content?index=' + index + '&novelId=' + encodeURIComponent(currentNovelId), {
                headers: { 'Authorization': 'Bearer ' + token }
            });
            var json = await res.json();
            if (json.code === 200) {
                var chapter = json.data;
                var ta = document.getElementById('story-edit-content');
                if (ta) {
                    var content = chapter.content || '';
                    ta.value = content;
                    updateStoryWordStats(content);
                    storyOriginalContent = content;
                    storyHasUnsavedChanges = false;
                    updateSaveStatus('saved');
                }
                if (storiesData.stories[index]) {
                    storiesData.stories[index].content = chapter.content;
                    renderChapterList();
                }
            } else {
                var cachedContent = storiesData.stories[index]?.content || '';
                var ta = document.getElementById('story-edit-content');
                if (ta) { ta.value = cachedContent; updateStoryWordStats(cachedContent); }
            }
        } catch(e) {
            var ta = document.getElementById('story-edit-content');
            if (ta) {
                var cachedContent = storiesData.stories[index]?.content || '';
                ta.value = cachedContent || '加载失败';
                updateStoryWordStats(cachedContent);
            }
        }
    }

    function updateStoryWordStats(content) {
        var charCount = content.length;
        var targetCount = 2000;
        var percent = Math.min(100, Math.round((charCount / targetCount) * 100));
        var readTime = Math.max(1, Math.ceil(charCount / 400));
        var cc = document.getElementById('story-char-count');
        var wc = document.getElementById('storyWordCount');
        var rt = document.getElementById('storyReadTime');
        var wf = document.getElementById('storyWordFill');
        var pp = document.getElementById('storyProgressPercent');
        if (cc) cc.textContent = charCount + ' 字';
        if (wc) wc.textContent = charCount + ' 字';
        if (rt) rt.textContent = '约 ' + readTime + ' 分钟';
        if (wf) wf.style.width = percent + '%';
        if (pp) pp.textContent = percent + '%';
    }

    function storyMarkUnsaved() {
        if (!storyHasUnsavedChanges) {
            storyHasUnsavedChanges = true;
            updateSaveStatus('unsaved');
        }
        var ta = document.getElementById('story-edit-content');
        if (ta) updateStoryWordStats(ta.value);
    }

    function updateSaveStatus(status) {
        var el = document.getElementById('storySaveStatus');
        if (!el) return;
        el.className = 'save-status ' + status;
        if (status === 'saved') el.innerHTML = '✓ 已保存';
        else if (status === 'unsaved') el.innerHTML = '● 未保存';
        else if (status === 'saving') el.innerHTML = '⏳ 保存中...';
    }

    async function storySave() {
        var title = document.getElementById('story-edit-title').value.trim();
        var content = document.getElementById('story-edit-content').value;
        var author = document.getElementById('story-edit-author').value.trim();
        if (!title) { showToast('请输入章节标题', 'error'); return; }
        if (!content) { showToast('请输入章节内容', 'error'); return; }
        if (!author) author = '匿名';
        try {
            var token = localStorage.getItem("token") || sessionStorage.getItem("token");
            if (storiesData.editingIndex < 0) {
                var addRes = await fetch('/api/admin/stories/add', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                    body: JSON.stringify({ title: title, content: content, author: author, novelId: currentNovelId })
                });
                var addJson = await addRes.json();
                if (addJson.code === 200) {
                    await loadStories();
                    showToast('✅ 章节已创建并保存', 'success');
                    storySelect(storiesData.stories.length - 1);
                } else { showToast('创建失败: ' + addJson.message, 'error'); }
            } else {
                var res = await fetch('/api/admin/stories/save', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                    body: JSON.stringify({ index: storiesData.editingIndex, title: title, content: content, author: author, novelId: currentNovelId })
                });
                var json = await res.json();
                if (json.code === 200) {
                    showToast('✅ 第' + (storiesData.editingIndex + 1) + '章保存成功', 'success');
                    storiesData.stories[storiesData.editingIndex] = { file: storiesData.stories[storiesData.editingIndex].file, title: title, content: content, author: author };
                    storyOriginalContent = content;
                    storyOriginalTitle = title;
                    storyHasUnsavedChanges = false;
                    updateSaveStatus('saved');
                    renderChapterList();
                } else { showToast('保存失败: ' + json.message, 'error'); }
            }
        } catch(e) { showToast('保存失败', 'error'); }
    }

    function storyAutoSave() {
        var textarea = document.getElementById('story-edit-content');
        var statusEl = document.getElementById('story-auto-save-status');
        updateStoryWordStats(textarea.value);
        if (statusEl) statusEl.textContent = '⏳ 自动保存...';
        if (storyAutoSaveTimer) clearTimeout(storyAutoSaveTimer);
        storyAutoSaveTimer = setTimeout(function() {
            var title = document.getElementById('story-edit-title').value.trim();
            if (!title || !textarea.value) { if (statusEl) statusEl.textContent = ''; return; }
            storySaveSilent(title, textarea.value);
        }, 2000);
    }

    async function storySaveSilent(title, content) {
        if (storiesData.editingIndex < 0) return;
        var author = document.getElementById('story-edit-author').value.trim();
        var statusEl = document.getElementById('story-auto-save-status');
        try {
            var token = localStorage.getItem("token") || sessionStorage.getItem("token");
            var res = await fetch('/api/admin/stories/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                body: JSON.stringify({ index: storiesData.editingIndex, title: title, content: content, author: author, novelId: currentNovelId })
            });
            var json = await res.json();
            if (json.code === 200) {
                if (statusEl) statusEl.textContent = '✓ 已自动保存 ' + new Date().toLocaleTimeString('zh-CN', {hour:'2-digit', minute:'2-digit'});
                storyHasUnsavedChanges = false;
                updateSaveStatus('saved');
                storiesData.stories[storiesData.editingIndex] = { file: storiesData.stories[storiesData.editingIndex].file, title: title, content: content, author: author };
                renderChapterList();
            } else { if (statusEl) statusEl.textContent = '自动保存失败'; }
        } catch(e) { if (statusEl) statusEl.textContent = '自动保存失败'; }
    }

    async function storyNew() {
        var title = document.getElementById('story-edit-title')?.value?.trim() || '';
        var content = document.getElementById('story-edit-content')?.value || '';
        var author = document.getElementById('story-edit-author')?.value?.trim() || SITE_NAME + '编辑部';
        var defaultTitle = '第' + (storiesData.stories.length + 1) + '章';
        title = prompt('请输入新章节标题：', defaultTitle);
        if (!title) return;
        try {
            var token = localStorage.getItem("token") || sessionStorage.getItem("token");
            var res = await fetch('/api/admin/stories/add', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                body: JSON.stringify({ title: title, content: content || '', author: author, novelId: currentNovelId })
            });
            var json = await res.json();
            if (json.code === 200) {
                showToast('✅ 章节已创建', 'success');
                storySelect(json.data.index);
            } else { showToast('创建失败', 'error'); }
        } catch(e) { showToast('创建失败', 'error'); }
    }

    async function storyDelete(index) {
        if (!confirm('确定删除本章？')) return;
        try {
            var token = localStorage.getItem("token") || sessionStorage.getItem("token");
            var res = await fetch('/api/admin/stories/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                body: JSON.stringify({ index: index, novelId: currentNovelId })
            });
            var json = await res.json();
            if (json.code === 200) {
                showToast('✅ 已删除', 'success');
                storiesData.stories = json.data.stories;
                storiesData.currentIndex = json.data.currentIndex;
                storiesData.editingIndex = -1;
                document.getElementById('stories-editor-body').innerHTML = '<div class="stories-empty"><div class="empty-icon">👈</div><div>点击左侧章节进行编辑</div></div>';
                document.getElementById('stories-editor-title').textContent = '📝 请选择一个章节';
                renderChapterList();
            } else { showToast('删除失败', 'error'); }
        } catch(e) { showToast('删除失败', 'error'); }
    }

    async function storySetCurrent(index) {
        try {
            var token = localStorage.getItem("token") || sessionStorage.getItem("token");
            var res = await fetch('/api/admin/stories/set-current', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                body: JSON.stringify({ index: index, novelId: currentNovelId })
            });
            var json = await res.json();
            if (json.code === 200) {
                showToast('✅ 已设为当前连载', 'success');
                storiesData.currentIndex = index;
                renderChapterList();
            } else { showToast('设置失败', 'error'); }
        } catch(e) { showToast('设置失败', 'error'); }
    }

    function storyNavigate(direction) {
        var newIndex = storiesData.editingIndex + direction;
        if (newIndex >= 0 && newIndex < storiesData.stories.length) storySelect(newIndex);
    }

    function setAIGenMode(btn) {
        document.querySelectorAll('.ai-mode-btn').forEach(function(b) { b.classList.remove('active'); });
        btn.classList.add('active');
        currentAIGenMode = btn.dataset.mode;
        document.getElementById('aiModeDesc').textContent = aiModeDescs[currentAIGenMode];
    }

    async function storyGeneratePrompt() {
        try {
            var token = localStorage.getItem("token") || sessionStorage.getItem("token");
            var res = await fetch('/api/admin/stories/next-prompt?novelId=' + encodeURIComponent(currentNovelId), {
                headers: { 'Authorization': 'Bearer ' + token }
            });
            var json = await res.json();
            if (json.code === 200) {
                document.getElementById('stories-prompt-text').value = json.data.prompt;
                showToast('✅ 提示词已生成', 'success');
            } else { showToast('生成失败', 'error'); }
        } catch(e) { showToast('生成失败', 'error'); }
    }

    function copyPrompt() {
        var ta = document.getElementById('stories-prompt-text');
        if (!ta.value) { showToast('请先生成提示词', 'error'); return; }
        ta.select();
        document.execCommand('copy');
        showToast('📋 已复制', 'success');
    }

    async function storyPublishToWechat(index) {
        if (index === undefined) index = storiesData.editingIndex;
        if (index < 0) { showToast('请先选择章节', 'error'); return; }
        if (!confirm('确定推送到公众号？')) return;
        try {
            var token = localStorage.getItem("token") || sessionStorage.getItem("token");
            var res = await fetch('/api/admin/stories/publish-to-wechat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                body: JSON.stringify({ chapterIndex: index, novelId: currentNovelId })
            });
            var json = await res.json();
            if (json.code === 200) {
                showToast('✅ 推送成功', 'success');
                storiesData.stories[index].published = true;
                renderChapterList();
            } else { showToast('推送失败: ' + (json.message || ''), 'error'); }
        } catch(e) { showToast('推送失败', 'error'); }
    }

    var storyStreamController = null;
    var currentNovelChapterIndex = 0;

    async function storyGenerateByAI() {
        var btn = document.getElementById('storyGenBtn');
        var loading = document.getElementById('storyGenLoading');
        var ta = document.getElementById('stories-prompt-text');
        if (!btn || !loading || !ta) return;
        btn.disabled = true;
        btn.textContent = '⏳ 连接中...';
        loading.style.display = 'block';
        loading.innerHTML = '⏳ 正在连接 AI 服务...';
        ta.value = '';
        ta.style.display = 'none';

        try {
            var token = localStorage.getItem("token") || sessionStorage.getItem("token");
            btn.textContent = '⏳ 生成中...';
            loading.innerHTML = '🤖 AI 正在创作...<br><span id="streamContent" style="font-size:13px;color:var(--text-primary);display:block;margin-top:8px;text-align:left;background:rgba(255,255,255,0.5);padding:8px 12px;border-radius:6px;max-height:200px;overflow-y:auto;white-space:pre-wrap;"></span>';

            var streamDiv = document.getElementById('streamContent');
            var fullText = '';
            var doneMeta = null;
            var url = '/api/admin/stories/generate-chapter-stream?token=' + encodeURIComponent(token) + '&novelId=' + encodeURIComponent(currentNovelId);

            storyStreamController = new AbortController();
            var res = await fetch(url, { signal: storyStreamController.signal });
            if (!res.ok) {
                loading.style.display = 'none';
                ta.style.display = '';
                showToast('❌ 服务器错误', 'error');
                return;
            }

            var reader = res.body.getReader();
            var decoder = new TextDecoder();
            var buffer = '';
            var currentEvent = '';

            while (true) {
                var result = await reader.read();
                if (result.done) break;

                buffer += decoder.decode(result.value, { stream: true });
                var lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (var li = 0; li < lines.length; li++) {
                    var line = lines[li];
                    if (line.startsWith('event: ')) {
                        currentEvent = line.substring(7).trim();
                    } else if (line.startsWith('data: ')) {
                        var content = line.substring(6);
                        if (currentEvent === 'done') {
                            try { doneMeta = JSON.parse(content); } catch(e) {}
                            currentEvent = '';
                        } else if (currentEvent === 'error') {
                            showToast('❌ 生成失败: ' + content, 'error');
                            currentEvent = '';
                        } else if (content !== '__DONE__') {
                            var text = content.replace(/\\n/g, '\n');
                            fullText += text;
                            if (streamDiv) {
                                streamDiv.textContent = fullText;
                                streamDiv.scrollTop = streamDiv.scrollHeight;
                            }
                        }
                        currentEvent = '';
                    }
                }
            }

            var aiTitle = '';
            var aiContent = fullText;

            if (doneMeta && doneMeta.title) {
                aiTitle = doneMeta.title;
                aiContent = doneMeta.content || fullText;
            } else {
                var contentLines = fullText.split('\n');
                if (contentLines.length > 0) {
                    var firstLine = contentLines[0].replace(/^#+\s*/, '').replace(/^第\d+章[：\s]*/, '').trim();
                    if (firstLine.length > 0 && firstLine.length < 30) {
                        aiTitle = firstLine;
                        aiContent = contentLines.slice(1).join('\n').trim();
                    }
                }
                if (!aiTitle) aiTitle = '第 ' + (parseInt(currentNovelChapterIndex || 0) + 1) + ' 章';
            }

            loading.style.display = 'none';
            ta.style.display = '';
            ta.value = fullText;

            var titleInput = document.getElementById('story-edit-title');
            var contentInput = document.getElementById('story-edit-content');
            var authorInput = document.getElementById('story-edit-author');
            if (titleInput) titleInput.value = aiTitle;
            if (contentInput) contentInput.value = aiContent;
            if (authorInput) authorInput.value = 'AI 辅助创作';
            if (typeof updateStoryWordStats === 'function') updateStoryWordStats(aiContent);
            showToast('✨ AI 生成完成，请确认后手动保存', 'success');

            var panelBtns = document.querySelectorAll('#panel-stories .tabs-header button');
            for (var pi = 0; panelBtns && pi < panelBtns.length; pi++) {
                if (panelBtns[pi].textContent.includes('编辑')) {
                    panelBtns[pi].click(); break;
                }
            }
        } catch(e) {
            if (e.name === 'AbortError') {
                showToast('已取消生成', 'info');
            } else {
                loading.style.display = 'none';
                ta.style.display = '';
                ta.value = '❌ 生成失败: ' + e.message;
                showToast('❌ 生成失败: ' + e.message, 'error');
            }
        } finally {
            btn.disabled = false;
            btn.textContent = '✨ AI 生成';
            storyStreamController = null;
        }
    }

    function showCreateNovel() {
        var title = prompt('请输入小说标题：');
        if (!title) return;
        var author = prompt('请输入作者（默认为' + SITE_NAME + '编辑部）：') || SITE_NAME + '编辑部';
        var desc = prompt('请输入简介（可选）：') || '';
        createNovel(title, author, desc);
    }

    function loadPromptConfig() {
        if (e.detail && e.detail.panel === 'stories') {
            var cfg = storiesData.promptConfig || {};
            var fields = ['novelTitle','authorRole','wordCount','style','sceneRequirement','endingRequirement','extraRequirements'];
            fields.forEach(function(f) {
                var el = document.getElementById('pc-' + f);
                if (el && cfg[f]) el.value = cfg[f];
            });
        }
    }

    function savePromptConfig() {
        var cfg = {};
        var fields = ['novelTitle','authorRole','wordCount','style','sceneRequirement','endingRequirement','extraRequirements'];
        fields.forEach(function(f) {
            var el = document.getElementById('pc-' + f);
            if (el) cfg[f] = el.value;
        });
        var cfgJson = JSON.stringify(cfg);
        fetch('/api/admin/stories/save-prompt-config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (localStorage.getItem('token') || sessionStorage.getItem('token')) },
            body: JSON.stringify({ promptConfig: cfg, novelId: currentNovelId })
        }).then(function(res) { return res.json(); }).then(function(json) {
            if (json.code === 200) { showToast('✅ 配置已保存', 'success'); storiesData.promptConfig = cfg; }
            else showToast('保存失败', 'error');
        });
    }

    // 快捷键
    document.addEventListener('keydown', function(e) {
        if (window.currentPanel !== 'stories') return;
        if (storiesData.editingIndex < 0) return;
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
            if (e.key === 's' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); storySave(); return; }
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); storyPublishToWechat(); return; }
            return;
        }
        if (e.key === 'ArrowLeft') { e.preventDefault(); storyNavigate(-1); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); storyNavigate(1); }
        else if (e.key === 's' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); storySave(); }
        else if (e.key === 'Escape') {
            if (storyHasUnsavedChanges) { if (!confirm('有未保存的更改，确定要离开吗？')) return; }
            storiesData.editingIndex = -1;
            document.getElementById('stories-editor-body').innerHTML = '<div class="stories-empty"><div class="empty-icon">👈</div><div>点击左侧章节进行编辑</div></div>';
            document.getElementById('stories-editor-title').textContent = '📝 请选择一个章节';
            renderChapterList();
        }
    });

    // 监听面板切换
    document.addEventListener('panelChanged', function(e) {
        if (e.detail && e.detail.panel === 'stories') {
            loadStories().then(function() { loadPromptConfig(); });
        }
    });

    // 暴露全局函数
    window.storySelect = storySelect;
    window.renderChapterList = renderChapterList;
    window.storySave = storySave;
    window.storyDelete = storyDelete;
    window.storySetCurrent = storySetCurrent;
    window.storyNew = storyNew;
    window.storyPublishToWechat = storyPublishToWechat;
    window.switchNovel = switchNovel;
    window.showCreateNovel = showCreateNovel;
    window.loadStories = loadStories;
    window.loadNovels = loadNovels;
    window.storyGeneratePrompt = storyGeneratePrompt;
    window.storyGenerateByAI = storyGenerateByAI;
    window.copyPrompt = copyPrompt;
    window.savePromptConfig = savePromptConfig;
    window.setAIGenMode = setAIGenMode;
    window.storyMarkUnsaved = storyMarkUnsaved;
    window.updateStoryWordStats = updateStoryWordStats;
    window.updateSaveStatus = updateSaveStatus;
    window.storyNavigate = storyNavigate;

})();
