/* ============================================
   私信功能 JavaScript
   ============================================ */

let currentConversationId = null;
let currentPartner = null;
let conversations = [];
let messageInterval = null;
let currentPage = 1;
let totalPages = 1;
let isLoadingMessages = false;

// API基础URL（app.js 已声明 var API_BASE，此处复用）
API_BASE = '/api/messages';
const MESSAGES_PER_PAGE = 20;

// DOM元素
const dom = {
  conversationList: document.getElementById('conversation-list'),
  messagesList: document.getElementById('messages-list'),
  welcomeMessage: document.getElementById('welcome-message'),
  messagesHeaderBar: document.getElementById('messages-header-bar'),
  partnerAvatar: document.getElementById('partner-avatar'),
  partnerName: document.getElementById('partner-name'),
  partnerStatus: document.getElementById('partner-status'),
  messageInputArea: document.getElementById('message-input-area'),
  messageTextarea: document.getElementById('message-textarea'),
  btnSend: document.getElementById('btn-send'),
  btnNewConversation: document.getElementById('btn-new-conversation'),
  btnRefresh: document.getElementById('btn-refresh'),
  btnClear: document.getElementById('btn-clear'),
  messagesLoading: document.getElementById('messages-loading'),
  newConversationModal: document.getElementById('new-conversation-modal'),
  userSearchInput: document.getElementById('user-search-input'),
  userList: document.getElementById('user-list'),
  modalClose: document.getElementById('modal-close'),
  messageDetailModal: document.getElementById('message-detail-modal'),
  messageDetailContent: document.getElementById('message-detail-content'),
  btnDeleteMessage: document.getElementById('btn-delete-message'),
  messageModalClose: document.getElementById('message-modal-close'),
  btnCloseDetail: document.getElementById('btn-close-detail')
};

// 初始化页面
function initMessagesPage() {
  loadConversations();
  setupEventListeners();
  startMessagePolling();
  initSettings();
}

// 设置事件监听器
function setupEventListeners() {
  // 发送消息
  dom.messageTextarea.addEventListener('input', function() {
    dom.btnSend.disabled = this.value.trim().length === 0;
  });
  
  dom.messageTextarea.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  
  dom.btnSend.addEventListener('click', sendMessage);
  
  // 新会话按钮
  dom.btnNewConversation.addEventListener('click', showNewConversationModal);
  
  // 模态框关闭
  dom.modalClose.addEventListener('click', hideNewConversationModal);
  dom.messageModalClose.addEventListener('click', hideMessageDetailModal);
  dom.btnCloseDetail.addEventListener('click', hideMessageDetailModal);

  // 全局点击遮罩关闭模态框
  
  // 点击遮罩层关闭模态框
  dom.newConversationModal.addEventListener('click', function(e) {
    if (e.target === this) hideNewConversationModal();
  });
  
  dom.messageDetailModal.addEventListener('click', function(e) {
    if (e.target === this) hideMessageDetailModal();
  });
  
  // 用户搜索
  dom.userSearchInput.addEventListener('input', debounce(searchUsers, 300));
  
  // 刷新消息或会话列表
  dom.btnRefresh.addEventListener('click', function() {
    if (currentConversationId) {
      loadMessages(currentConversationId, true);
      showToast('已刷新', 'info');
    } else {
      loadConversations();
      showToast('已刷新会话列表', 'info');
    }
  });
  
  // 清空聊天（仅清空本地显示）
  if (dom.btnClear) {
    dom.btnClear.addEventListener('click', function() {
      if (confirm('确定要清空当前聊天记录吗？(仅清空本地显示，不会删除服务器数据)')) {
        dom.messagesList.innerHTML = '';
      }
    });
  }
  
  // 删除消息按钮
  dom.btnDeleteMessage.addEventListener('click', deleteSelectedMessage);

  // 点击页面其他地方关闭菜单
  document.addEventListener('click', function(e) {
    var menu = document.getElementById('conversation-menu');
    if (menu && !menu.contains(e.target) && !e.target.closest('.btn-conversation-menu')) {
      menu.classList.remove('show');
    }
  });
  
  // 消息点击事件代理（只绑定一次，避免重复绑）
  dom.messagesList.addEventListener('click', function(e) {
    var item = e.target.closest('.message-item');
    if (item) {
      var mid = parseInt(item.getAttribute('data-id'));
      if (mid) showMessageDetail(mid);
    }
  });

  // 滚动加载更多消息（带防抖）
  var scrollTimer = null;
  dom.messagesList.parentElement.addEventListener('scroll', function() {
    if (scrollTimer) return;
    if (this.scrollTop === 0 && !isLoadingMessages && currentPage < totalPages) {
      scrollTimer = setTimeout(function() {
        scrollTimer = null;
        if (dom.messagesList.parentElement.scrollTop === 0) loadMoreMessages();
      }, 200);
    }
  }, { passive: true });
}

// 加载会话列表
async function loadConversations() {
  try {
    showLoading(dom.conversationList);
    
    const response = await fetchWithAuth(`${API_BASE}/conversations`);
    const data = await response.json();
    
    if (data.code === 200) {
      conversations = data.data.conversations;
      renderConversationList();
    } else {
      throw new Error(data.message || '加载会话失败');
    }
  } catch (error) {
    console.error('加载会话失败:', error);
    showError(dom.conversationList, '加载会话失败，请刷新重试');
  }
}

// 渲染会话列表
function renderConversationList() {
  if (!conversations.length) {
    dom.conversationList.innerHTML = `
      <div class="conversation-empty">
        <div class="conversation-empty-icon">💬</div>
        <p>还没有会话，点击上方按钮发起聊天吧</p>
      </div>
    `;
    return;
  }
  
  let html = '';
  conversations.forEach(conv => {
    const isActive = conv.id === currentConversationId;
    const lastMessageTime = conv.last_message_at ? formatTimeAgo(conv.last_message_at) : '暂无消息';
    const lastMessagePreview = conv.last_message ? 
      (conv.last_message.length > 20 ? conv.last_message.substring(0, 20) + '...' : conv.last_message) : 
      '开始聊天吧！';
    const dndIcon = conv.my_dnd ? '<span class="conversation-dnd-icon">🔕</span>' : '';
    
    html += `
      <div class="conversation-item ${isActive ? 'active' : ''}" data-id="${conv.id}" data-partner-id="${conv.partner_id}">
        <img src="${escapeHtml(conv.partner_avatar || '/uploads/avatars/default.png')}" alt="头像" class="conversation-avatar">
        <div class="conversation-info">
          <div class="conversation-partner">
            <span>${escapeHtml(conv.partner_nickname)}${dndIcon}</span>
            <span class="conversation-time">${lastMessageTime}</span>
          </div>
          <div class="conversation-last-message">${escapeHtml(lastMessagePreview)}</div>
        </div>
        ${conv.unread_count > 0 ? `<div class="conversation-unread">${conv.unread_count}</div>` : ''}
      </div>
    `;
  });
  
  dom.conversationList.innerHTML = html;
  
  // 添加会话点击事件
  document.querySelectorAll('.conversation-item').forEach(item => {
    item.addEventListener('click', function() {
      const conversationId = parseInt(this.getAttribute('data-id'));
      const partnerId = parseInt(this.getAttribute('data-partner-id'));
      selectConversation(conversationId, partnerId);
    });
  });
}

// 选择会话
function selectConversation(conversationId, partnerId) {
  if (currentConversationId === conversationId) return;
  
  currentConversationId = conversationId;
  currentPartner = conversations.find(c => c.id === conversationId);
  if (!currentPartner) {
    currentConversationId = null;
    showToast('会话不存在或已被删除', 'error');
    loadConversations();
    return;
  }
  currentPage = 1;
  
  // 更新会话列表的激活状态
  document.querySelectorAll('.conversation-item').forEach(item => {
    const id = parseInt(item.getAttribute('data-id'));
    item.classList.toggle('active', id === conversationId);
  });
  
  // 更新头部信息
  dom.messagesHeaderBar.style.display = 'flex';
  dom.partnerAvatar.src = currentPartner.partner_avatar || '/uploads/avatars/default.png';
  dom.partnerName.textContent = currentPartner.partner_nickname;
  dom.partnerStatus.textContent = formatLastOnline(currentPartner.partner_last_login_at);
  dom.messageInputArea.style.display = 'block';
  dom.welcomeMessage.style.display = 'none';

  // 更新免打扰标志
  updateDndIndicator(currentPartner.my_dnd);
  
  // 加载消息
  loadMessages(conversationId);
  
  // 滚动到消息区域顶部
  dom.messagesList.parentElement.scrollTop = dom.messagesList.parentElement.scrollHeight;
  
  // 移动端切换：隐藏侧栏，显示聊天区
  if (window.innerWidth < 768) {
    document.querySelector('.messages-sidebar').classList.add('hide');
    document.querySelector('.messages-main').classList.add('show');
  }
}

// 移动端返回会话列表
function backToConversations() {
  document.querySelector('.messages-sidebar').classList.remove('hide');
  document.querySelector('.messages-main').classList.remove('show');
}

// 加载消息
async function loadMessages(conversationId, forceRefresh = false) {
  if (isLoadingMessages) return;
  
  isLoadingMessages = true;
  dom.messagesLoading.style.display = 'block';
  
  if (forceRefresh || currentPage === 1) {
    dom.messagesList.innerHTML = '';
  }
  
  try {
    const response = await fetchWithAuth(
      `${API_BASE}/conversations/${conversationId}/messages?page=${currentPage}&limit=${MESSAGES_PER_PAGE}`
    );
    const data = await response.json();
    
    if (data.code === 200) {
      const { messages, pagination } = data.data;
      totalPages = pagination.pages;
      
      if (messages.length) {
        renderMessages(messages, currentPage > 1);
        if (currentPage === 1) {
          dom.messagesList.parentElement.scrollTop = dom.messagesList.parentElement.scrollHeight;
        }
      } else if (currentPage === 1) {
        dom.messagesList.innerHTML = `
          <div class="message-empty">
            <div class="message-empty-icon">💬</div>
            <p>发送第一条消息开始对话吧！</p>
          </div>
        `;
      }
      
      // 标记未读消息为已读
      if (currentPage === 1) {
        markMessagesAsRead(conversationId);
      }
    } else {
      throw new Error(data.message || '加载消息失败');
    }
  } catch (error) {
    console.error('加载消息失败:', error);
    showToast('加载消息失败', 'error');
  } finally {
    isLoadingMessages = false;
    dom.messagesLoading.style.display = 'none';
  }
}

// 加载更多消息
function loadMoreMessages() {
  if (currentPage >= totalPages) return;
  
  currentPage++;
  loadMessages(currentConversationId);
}

// 渲染消息
function renderMessages(messages, prepend = false) {
  const currentUserId = window.currentUser?.id;
  
  let html = '';
  messages.forEach(msg => {
    const isSent = msg.sender_id === currentUserId;
    const time = formatMessageTime(msg.created_at);
    
    html += `
      <div class="message-item ${isSent ? 'sent' : 'received'}" data-id="${msg.id}">
        <div class="message-bubble">
          ${escapeHtml(msg.content).replace(/\n/g, '<br>')}
          <div class="message-time">
            ${time}
            ${isSent ? '<span class="message-status">✓</span>' : ''}
          </div>
        </div>
      </div>
    `;
  });
  
  if (prepend) {
    const temp = document.createElement('div');
    temp.innerHTML = html;
    const firstChild = dom.messagesList.firstChild;
    while (temp.firstChild) {
      dom.messagesList.insertBefore(temp.firstChild, firstChild);
    }
  } else {
    dom.messagesList.innerHTML += html;
  }
}

// 发送消息
async function sendMessage() {
  const content = dom.messageTextarea.value.trim();
  if (!content || !currentConversationId) return;
  
  // 禁用发送按钮
  dom.btnSend.disabled = true;
  
  try {
    const response = await fetchWithAuth(`${API_BASE}/conversations/${currentConversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    });
    
    const data = await response.json();
    
    if (data.code === 200) {
      // 清空输入框
      dom.messageTextarea.value = '';
      dom.btnSend.disabled = true;
      
      // 添加消息到列表
      const msg = data.data.message;
      renderMessages([msg]);
      
      // 滚动到底部
      dom.messagesList.parentElement.scrollTop = dom.messagesList.parentElement.scrollHeight;
      
      // 更新会话列表的最后消息
      updateConversationLastMessage(currentConversationId, content, msg.created_at);
    } else {
      throw new Error(data.message || '发送失败');
    }
  } catch (error) {
    console.error('发送消息失败:', error);
    showToast('发送失败: ' + error.message, 'error');
    dom.btnSend.disabled = false;
  }
}

// 更新会话的最后消息
function updateConversationLastMessage(conversationId, content, timestamp) {
  const conversation = conversations.find(c => c.id === conversationId);
  if (conversation) {
    conversation.last_message = content;
    conversation.last_message_at = timestamp;
    conversation.unread_count = 0;
    renderConversationList();
  }
}

// 标记消息为已读
async function markMessagesAsRead(conversationId) {
  try {
    // 这里可以调用API标记所有未读消息为已读
    // 目前在后端加载消息时已经自动标记
    // 只需要更新会话列表的未读计数
    const conversation = conversations.find(c => c.id === conversationId);
    if (conversation) {
      conversation.unread_count = 0;
      renderConversationList();
    }
  } catch (error) {
    console.error('标记已读失败:', error);
  }
}

// 显示新会话模态框
function showNewConversationModal() {
  dom.newConversationModal.classList.add('show');
  dom.userSearchInput.value = '';
  document.body.style.overflow = 'hidden';
  loadRecentUsers();
}

// 隐藏新会话模态框
function hideNewConversationModal() {
  dom.newConversationModal.classList.remove('show');
  document.body.style.overflow = '';
}

// 加载最近用户（可以扩展为最近互动用户）
async function loadRecentUsers() {
  try {
    showLoading(dom.userList);
    
    // 这里可以调用API获取推荐用户或最近互动用户
    // 暂时使用搜索空字符串来获取部分用户
    const response = await fetchWithAuth('/api/posts/search-users?q=&limit=20');
    const data = await response.json();
    
    if (data.code === 200) {
      renderUserList(data.data.users);
    } else {
      throw new Error(data.message || '加载用户失败');
    }
  } catch (error) {
    console.error('加载用户失败:', error);
    showError(dom.userList, '加载用户失败');
  }
}

// 搜索用户
async function searchUsers() {
  const query = dom.userSearchInput.value.trim();
  
  if (!query) {
    loadRecentUsers();
    return;
  }
  
  try {
    showLoading(dom.userList);
    
    const response = await fetchWithAuth(`/api/posts/search-users?q=${encodeURIComponent(query)}&limit=20`);
    const data = await response.json();
    
    if (data.code === 200) {
      renderUserList(data.data.users);
    } else {
      throw new Error(data.message || '搜索用户失败');
    }
  } catch (error) {
    console.error('搜索用户失败:', error);
    showError(dom.userList, '搜索失败');
  }
}

// 渲染用户列表
function renderUserList(users) {
  if (!users || !users.length) {
    dom.userList.innerHTML = `
      <div class="conversation-empty">
        <div class="conversation-empty-icon">👤</div>
        <h3 class="conversation-empty-text">没有找到用户</h3>
        <p>尝试其他搜索关键词</p>
      </div>
    `;
    return;
  }
  
  let html = '';
  var currentUserId = window.currentUser ? parseInt(window.currentUser.id) : 0;
  
  users.forEach(function(user) {
    if (parseInt(user.id) === currentUserId || parseInt(user.id) <= 0) return; // 排除自己
    
    html += `
      <div class="user-list-item" data-id="${user.id}">
        <img src="${escapeHtml(user.avatar || '/uploads/avatars/default.png')}" alt="头像" class="user-list-avatar">
        <div class="user-list-info">
          <div class="user-list-name">${escapeHtml(user.nickname)}</div>
          <div class="user-list-username">@${escapeHtml(user.username)}</div>
        </div>
        <button class="btn-start-chat" data-id="${user.id}">💬 聊天</button>
      </div>
    `;
  });
  
  dom.userList.innerHTML = html;
  
  // 添加聊天按钮事件
  document.querySelectorAll('.btn-start-chat').forEach(btn => {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      const userId = parseInt(this.getAttribute('data-id'));
      startNewConversation(userId);
    });
  });
  
  // 添加用户列表项点击事件
  document.querySelectorAll('.user-list-item').forEach(item => {
    item.addEventListener('click', function() {
      const userId = parseInt(this.getAttribute('data-id'));
      startNewConversation(userId);
    });
  });
}

// 开始新会话
async function startNewConversation(userId) {
  try {
    // 防止与自己发起私信
    if (parseInt(userId) === parseInt(window.currentUser?.id)) {
      showToast('不能与自己发起私信', 'error');
      return;
    }
    const response = await fetchWithAuth(`${API_BASE}/conversations/user/${userId}`);
    const data = await response.json();
    
    if (data.code === 200) {
      const { conversation } = data.data;
      
      // 隐藏模态框
      hideNewConversationModal();
      
      // 如果是新会话，添加到列表
      const exists = conversations.find(c => c.id === conversation.id);
      if (!exists) {
        conversations.unshift({
          id: conversation.id,
          partner_id: conversation.partner.id,
          partner_nickname: conversation.partner.nickname,
          partner_avatar: conversation.partner.avatar,
          partner_last_login_at: conversation.partner.last_login_at,
          last_message: null,
          last_message_at: conversation.last_message_at,
          unread_count: 0
        });
        renderConversationList();
      }
      
      // 选择这个会话
      selectConversation(conversation.id, conversation.partner.id);
      
      showToast('会话已创建', 'success');
    } else {
      throw new Error(data.message || '创建会话失败');
    }
  } catch (error) {
    console.error('创建会话失败:', error);
    showToast('创建会话失败: ' + error.message, 'error');
  }
}

// 显示消息详情
async function showMessageDetail(messageId) {
  try {
    const response = await fetchWithAuth(`${API_BASE}/messages/${messageId}`);
    const data = await response.json();
    
    if (data.code === 200) {
      const message = data.data.message;
      const time = formatDetailedTime(message.created_at);
      const isSent = message.sender_id === window.currentUser?.id;
      
      dom.messageDetailContent.innerHTML = `
        <div style="margin-bottom: 20px;">
          <p><strong>发送者:</strong> ${escapeHtml(message.sender_nickname)}</p>
          <p><strong>时间:</strong> ${time}</p>
          <p><strong>状态:</strong> ${message.is_read ? '已读' : '未读'}</p>
        </div>
        <div style="background: #F9FAFB; padding: 20px; border-radius: 12px; border: 1px solid #E5E7EB;">
          <p style="white-space: pre-wrap; line-height: 1.6;">${escapeHtml(message.content)}</p>
        </div>
      `;
      
      // 只有自己发送的消息才能删除
      dom.btnDeleteMessage.style.display = isSent ? 'inline-block' : 'none';
      dom.btnDeleteMessage.setAttribute('data-id', messageId);
      
      dom.messageDetailModal.classList.add('show');
    }
  } catch (error) {
    console.error('获取消息详情失败:', error);
    showToast('获取消息详情失败', 'error');
  }
}

// 隐藏消息详情模态框
function hideMessageDetailModal() {
  dom.messageDetailModal.classList.remove('show');
}

// 删除消息
async function deleteSelectedMessage() {
  const messageId = parseInt(dom.btnDeleteMessage.getAttribute('data-id'));
  
  if (!messageId || !confirm('确定要删除这条消息吗？删除后无法恢复。')) {
    return;
  }
  
  try {
    const response = await fetchWithAuth(`${API_BASE}/messages/${messageId}`, {
      method: 'DELETE'
    });
    
    const data = await response.json();
    
    if (data.code === 200) {
      // 从消息列表中移除
      const messageElement = document.querySelector(`.message-item[data-id="${messageId}"]`);
      if (messageElement) {
        messageElement.remove();
      }
      
      hideMessageDetailModal();
      showToast('消息已删除', 'success');
    } else {
      throw new Error(data.message || '删除失败');
    }
  } catch (error) {
    console.error('删除消息失败:', error);
    showToast('删除失败: ' + error.message, 'error');
  }
}

// 开始轮询新消息
function startMessagePolling() {
  // 每30秒检查一次新消息
  messageInterval = setInterval(() => {
    if (currentConversationId) {
      checkNewMessages();
    }
    updateConversationsUnread();
  }, 30000);
}

// 检查新消息
async function checkNewMessages() {
  if (!currentConversationId || isLoadingMessages) return;
  
  try {
    const response = await fetchWithAuth(
      `${API_BASE}/conversations/${currentConversationId}/messages?page=1&limit=1`
    );
    const data = await response.json();
    
    if (data.code === 200 && data.data.messages.length) {
      const latestMessage = data.data.messages[0];
      const latestMessageId = latestMessage.id;
      
      // 检查是否是新消息
      const existingMessage = document.querySelector(`.message-item[data-id="${latestMessageId}"]`);
      if (!existingMessage) {
        // 有新消息，重新加载第一页
        currentPage = 1;
        loadMessages(currentConversationId, true);
      }
    }
  } catch (error) {
    console.error('检查新消息失败:', error);
  }
}

// 更新会话未读计数
async function updateConversationsUnread() {
  try {
    const response = await fetchWithAuth(`${API_BASE}/conversations`);
    const data = await response.json();
    
    if (data.code === 200) {
      const serverConversations = data.data.conversations;
      
      // 更新未读计数
      conversations.forEach(localConv => {
        const serverConv = serverConversations.find(c => c.id === localConv.id);
        if (serverConv && serverConv.unread_count !== localConv.unread_count) {
          localConv.unread_count = serverConv.unread_count;
        }
      });
      
      // 如果当前不在对话页面，更新列表显示
      if (document.hidden) {
        renderConversationList();
      }
    }
  } catch (error) {
    console.error('更新未读计数失败:', error);
  }
}

// 工具函数：带认证的fetch
async function fetchWithAuth(url, options = {}) {
  const token = localStorage.getItem('token') || getCookie('token');
  const headers = {
    'Authorization': token ? `Bearer ${token}` : '',
    ...options.headers
  };
  
  const response = await fetch(url, { ...options, headers });
  
  if (response.status === 401) {
    // token过期，跳转登录
    window.location.href = '/login.html?redirect=' + encodeURIComponent(window.location.pathname);
    throw new Error('请重新登录');
  }
  
  return response;
}

// 工具函数：防抖
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// 工具函数：显示加载状态
function showLoading(container) {
  container.innerHTML = `
    <div class="loading">
      <div class="loading-spinner"></div>
      <p>加载中...</p>
    </div>
  `;
}

// 工具函数：显示错误
function showError(container, message) {
  container.innerHTML = `
    <div class="conversation-empty">
      <div class="conversation-empty-icon">😢</div>
      <h3 class="conversation-empty-text">${escapeHtml(message)}</h3>
      <button class="btn-new-conversation" style="margin-top: 16px;" onclick="location.reload()">
        刷新页面
      </button>
    </div>
  `;
}

// 工具函数：显示Toast通知
var _toastTimer = null;
function showToast(message, type = 'info') {
  // 清除旧 toast & 旧定时器
  var old = document.querySelector('.toast-custom');
  if (old) old.remove();
  if (_toastTimer) { clearTimeout(_toastTimer); _toastTimer = null; }

  var icons = { success: '✅', error: '❌', info: 'ℹ️' };
  var colors = {
    success: 'linear-gradient(135deg, #10B981, #34D399)',
    error: 'linear-gradient(135deg, #EF4444, #F87171)',
    info: 'linear-gradient(135deg, #3B82F6, #60A5FA)'
  };

  var toast = document.createElement('div');
  toast.className = 'toast-custom';
  toast.innerHTML = '<span style="margin-right:8px;font-size:16px;">' + (icons[type] || 'ℹ️') + '</span><span>' + message + '</span>';
  toast.style.cssText = [
    'position: fixed',
    'top: 80px',
    'left: 50%',
    'transform: translateX(-50%)',
    'background: ' + (colors[type] || colors.info),
    'color: #fff',
    'padding: 14px 24px',
    'border-radius: 14px',
    'z-index: 10001',
    'box-shadow: 0 8px 30px rgba(0,0,0,0.18)',
    'font-size: 14px',
    'font-weight: 500',
    'display: flex',
    'align-items: center',
    'animation: toastFadeIn 0.35s cubic-bezier(0.34,1.56,0.64,1)',
    'backdrop-filter: blur(8px)',
    '-webkit-backdrop-filter: blur(8px)',
    'max-width: 85vw'
  ].join(';');
  document.body.appendChild(toast);
  _toastTimer = setTimeout(function() {
    toast.style.transition = 'opacity 0.3s, transform 0.3s';
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(-50%) translateY(-10px)';
    setTimeout(function() { if (toast.parentNode) toast.remove(); }, 400);
  }, 5000);
}

// 工具函数：上次在线时间（王者荣耀风格）
function formatLastOnline(timestamp) {
  if (!timestamp) return '离线';
  var diffMs = new Date() - new Date(timestamp);
  var diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return '刚刚在线';
  var diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return diffMin + '分钟前在线';
  var diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return diffHour + '小时前在线';
  var diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return diffDay + '天前在线';
  return new Date(timestamp).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }) + '在线';
}

// 工具函数：格式化时间
function formatTimeAgo(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  
  if (diffMins < 1) return '刚刚';
  if (diffMins < 60) return `${diffMins}分钟前`;
  if (diffHours < 24) return `${diffHours}小时前`;
  if (diffDays < 7) return `${diffDays}天前`;
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

function formatMessageTime(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  
  // 如果是今天，显示时间
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  
  // 如果是昨天
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return '昨天 ' + date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  
  // 显示日期和时间
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }) + ' ' + 
         date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function formatDetailedTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

// 工具函数：HTML转义
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// 工具函数：获取Cookie
function getCookie(name) {
  const value = `; ${document.cookie}`;
  const parts = value.split(`; ${name}=`);
  if (parts.length === 2) return parts.pop().split(';').shift();
}

// 工具函数：检查登录状态
async function checkLoginStatus() {
  const token = localStorage.getItem('token') || getCookie('token');
  if (!token) return false;
  
  try {
    const response = await fetch('/api/auth/me', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    if (response.ok) {
      const data = await response.json();
      if (data.code === 200) {
        window.currentUser = data.data.user;
        // 更新导航栏显示用户信息
        if (typeof updateNavbar === 'function') {
          updateNavbar(window.currentUser);
        }
        return true;
      }
    }
  } catch (error) {
    console.error('检查登录状态失败:', error);
  }
  
  return false;
}

// 页面可见性变化时检查新消息
document.addEventListener('visibilitychange', function() {
  if (!document.hidden) {
    if (currentConversationId) {
      loadMessages(currentConversationId, true);
    }
    updateConversationsUnread();
  }
});

// ===== 加载黑名单 =====
async function blockCurrentUser() {
  if (!currentPartner) return;
  if (!confirm('确定要拉黑 ' + currentPartner.partner_nickname + ' 吗？拉黑后将不再收到对方的私信。')) return;
  try {
    var res = await fetchWithAuth(API_BASE + '/block/' + currentPartner.partner_id, { method: 'POST' });
    var data = await res.json();
    showToast(data.message || '已拉黑', data.code === 200 ? 'success' : 'error');
    if (data.code === 200) {
      var menu = document.getElementById('conversation-menu');
      if (menu) menu.classList.remove('show');
      // 刷新会话列表
      loadConversations();
      // 关闭当前对话
      currentConversationId = null;
      currentPartner = null;
      document.getElementById('messages-header-bar').style.display = 'none';
      document.getElementById('message-input-area').style.display = 'none';
      document.getElementById('welcome-message').style.display = 'block';
      document.getElementById('messages-list').innerHTML = '';
    }
  } catch (e) {
    showToast('操作失败', 'error');
  }
}

// ===== 取消拉黑 =====
async function unblockUser(userId) {
  try {
    var res = await fetchWithAuth(API_BASE + '/block/' + userId, { method: 'DELETE' });
    var data = await res.json();
    showToast(data.message || '已取消拉黑', 'success');
    loadBlockList();
  } catch (e) {
    showToast('操作失败', 'error');
  }
}

// ===== 更新免打扰标志显示 =====
function updateDndIndicator(enabled) {
  var badge = document.getElementById('dnd-badge');
  var slider = document.getElementById('dnd-slider');
  if (badge) badge.style.display = enabled ? 'flex' : 'none';
  if (slider) slider.checked = !!enabled;
  // 更新会话列表中的记录
  if (currentConversationId && currentPartner) {
    currentPartner.my_dnd = !!enabled;
    var conv = conversations.find(function(c) { return c.id === currentConversationId; });
    if (conv) conv.my_dnd = !!enabled;
    renderConversationList();
  }
}

// ===== 设置免打扰 =====
async function toggleDnd(enabled) {
  if (!currentConversationId) return;
  try {
    var res = await fetchWithAuth(API_BASE + '/conversations/' + currentConversationId + '/dnd', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: enabled })
    });
    var data = await res.json();
    if (data.code === 200) {
      updateDndIndicator(enabled);
      showToast(enabled ? '🔕 已开启免打扰' : '🔔 已关闭免打扰', 'success');
    } else {
      showToast(data.message || '操作失败', 'error');
      updateDndIndicator(!enabled);
    }
    var menu = document.getElementById('conversation-menu');
    if (menu) menu.classList.remove('show');
  } catch (e) {
    showToast('操作失败', 'error');
    updateDndIndicator(!enabled);
  }
}

// ===== 显示菜单时同步滑块状态 =====
function toggleConversationMenu(e) {
  e.stopPropagation();
  var menu = document.getElementById('conversation-menu');
  if (menu) {
    menu.classList.toggle('show');
    // 打开菜单时同步滑块
    if (menu.classList.contains('show') && currentPartner) {
      var slider = document.getElementById('dnd-slider');
      if (slider) slider.checked = !!currentPartner.my_dnd;
    }
  }
}

// ===== 更新通知设置 =====
var notifyToggleBusy = false;
async function toggleNotifyMessage(enabled) {
  if (notifyToggleBusy) return;
  notifyToggleBusy = true;
  try {
    var res = await fetchWithAuth(API_BASE + '/settings/notify-message', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: enabled })
    });
    var data = await res.json();
    showToast(data.message || '设置已更新', 'success');
  } catch (e) {
    // 恢复复选框状态
    document.getElementById('notify-toggle').checked = !enabled;
    showToast('操作失败', 'error');
  } finally {
    notifyToggleBusy = false;
  }
}

// ===== 加载黑名单 =====
var blockListLoaded = false;
async function showBlockList() {
  try {
    var res = await fetchWithAuth(API_BASE + '/block/list');
    var data = await res.json();
    if (data.code !== 200) { showToast('加载失败', 'error'); return; }
    var users = data.data.users;
    var listEl = document.getElementById('block-list');
    if (!users || !users.length) {
      listEl.innerHTML = '<div class="conversation-empty"><p style="color:#bbb;">暂无拉黑的用户</p></div>';
    } else {
      listEl.innerHTML = users.map(function(u) {
        var safeAvatar = escapeHtml(u.avatar || '/uploads/avatars/default.png');
        return '<div class="user-list-item"><img src="' + safeAvatar + '" class="user-list-avatar"><div class="user-list-info"><div class="user-list-name">' + escapeHtml(u.nickname || '用户') + '</div></div><button class="btn-start-chat" onclick="unblockUser(' + u.user_id + ')">取消拉黑</button></div>';
      }).join('');
    }
    document.getElementById('block-list-modal').classList.add('show');
  } catch (e) {
    showToast('加载失败', 'error');
  }
}

// ===== 加载通知设置 =====
async function loadNotifySettings() {
  try {
    var res = await fetchWithAuth(API_BASE + '/settings');
    var data = await res.json();
    if (data.code === 200) {
      var toggle = document.getElementById('notify-toggle');
      if (toggle) toggle.checked = data.data.notify_message;
    }
  } catch (e) {}
}

// ===== 初始化设置 =====
function initSettings() {
  loadNotifySettings();
}

// ===== 清空聊天记录 =====
async function clearCurrentConversation() {
  if (!currentConversationId) return;
  if (!confirm('确定要清空当前聊天记录吗？\n清空后你这边将看不到这些消息，但管理员仍可查看。\n此操作不可撤销！')) return;
  try {
    var res = await fetchWithAuth(API_BASE + '/conversations/' + currentConversationId + '/clear', { method: 'POST' });
    var data = await res.json();
    if (data.code === 200) {
      dom.messagesList.innerHTML = '<div class="message-empty" style="display:block;"><div class="message-empty-icon">💬</div><h3 class="message-empty-text">聊天记录已清空</h3><p>发送新消息开始对话吧</p></div>';
      var menu = document.getElementById('conversation-menu');
      if (menu) menu.classList.remove('show');
      // 清除本地未读数
      var conv = conversations.find(function(c) { return c.id === currentConversationId; });
      if (conv) { conv.unread_count = 0; renderConversationList(); }
      showToast('✅ 聊天记录已清空', 'success');
    } else {
      showToast(data.message || '清空失败', 'error');
    }
  } catch (e) {
    showToast('清空失败: ' + e.message, 'error');
  }
}

// ===== 删除会话（从列表移除） =====
async function deleteCurrentConversation() {
  if (!currentConversationId) return;
  if (!confirm('确定要删除此会话吗？\n此会话将从你的聊天列表中移除。\n需要对方重新发消息才能恢复。')) return;
  try {
    var res = await fetchWithAuth(API_BASE + '/conversations/' + currentConversationId, { method: 'DELETE' });
    var data = await res.json();
    if (data.code === 200) {
      // 从本地列表中移除
      conversations = conversations.filter(function(c) { return c.id !== currentConversationId; });
      currentConversationId = null;
      currentPartner = null;
      document.getElementById('messages-header-bar').style.display = 'none';
      document.getElementById('message-input-area').style.display = 'none';
      document.getElementById('welcome-message').style.display = 'block';
      document.getElementById('messages-list').innerHTML = '';
      renderConversationList();
      var menu = document.getElementById('conversation-menu');
      if (menu) menu.classList.remove('show');
      showToast('✅ 会话已删除', 'success');
    } else {
      showToast('删除失败: ' + (data.message || '未知错误'), 'error');
    }
  } catch (e) {
    showToast('删除失败: ' + e.message, 'error');
  }
}

// 导出函数
window.initMessagesPage = initMessagesPage;
window.showNewConversationModal = showNewConversationModal;
window.hideNewConversationModal = hideNewConversationModal;
window.backToConversations = backToConversations;
window.blockCurrentUser = blockCurrentUser;
window.unblockUser = unblockUser;
window.toggleDnd = toggleDnd;
window.toggleNotifyMessage = toggleNotifyMessage;
window.showBlockList = showBlockList;
window.clearCurrentConversation = clearCurrentConversation;
window.deleteCurrentConversation = deleteCurrentConversation;