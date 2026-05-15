const express = require('express');
const { pool } = require('../config/database');
const { auth } = require('../middleware/auth');
const router = express.Router();

// ===== 消息通知 & 邮件发送 =====
async function sendMessageNotification(senderId, recipientId, content) {
  try {
    // 获取接收方邮箱和通知设置
    const [users] = await pool.execute(
      'SELECT email FROM users WHERE id = ? AND status = 1',
      [recipientId]
    );
    if (!users.length || !users[0].email) return;

    const [settings] = await pool.execute(
      'SELECT notify_message FROM user_notify_settings WHERE user_id = ?',
      [recipientId]
    );
    if (settings.length && !settings[0].notify_message) return;

    // 获取发送者昵称
    const [senders] = await pool.execute(
      'SELECT nickname FROM users WHERE id = ?',
      [senderId]
    );
    const senderName = senders.length ? senders[0].nickname : '某位同学';
    const contentPreview = content.length > 100 ? content.substring(0, 100) + '...' : content;

    const subject = '💌 您收到了一条新私信';
    const html = `
      <div style="max-width:560px;margin:0 auto;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;">
        <div style="background:linear-gradient(135deg,#FF6B9D,#C084FC);padding:32px 24px;text-align:center;border-radius:16px 16px 0 0;">
          <div style="font-size:40px;margin-bottom:8px;">💌</div>
          <h1 style="color:#fff;font-size:22px;margin:0;font-weight:700;">您收到了一条新私信</h1>
        </div>
        <div style="background:#fff;padding:28px 24px;border-radius:0 0 16px 16px;box-shadow:0 4px 20px rgba(255,107,157,0.1);">
          <p style="color:#666;font-size:15px;margin:0 0 12px;"><strong style="color:#FF6B9D;">${senderName}</strong> 给您发了一条私信：</p>
          <div style="background:#FFF8FA;border:1px solid rgba(255,107,157,0.15);border-radius:12px;padding:16px;margin-bottom:20px;">
            <p style="color:#333;font-size:14px;line-height:1.7;margin:0;">${contentPreview}</p>
          </div>
          <a href="https://wall.jay23.cn/messages.html" style="display:inline-block;background:linear-gradient(135deg,#FF6B9D,#C084FC);color:#fff;padding:12px 28px;border-radius:24px;text-decoration:none;font-weight:600;font-size:14px;">查看私信 →</a>
        </div>
      </div>
    `;

    try {
      const emailService = require('../services/email');
      await emailService.sendEmail(users[0].email, subject, html, 'message', senderName);
    } catch (e) {
      console.warn('[消息通知] 邮件发送失败:', e.message);
    }
  } catch (e) {
    console.warn('[消息通知] 通知处理失败:', e.message);
  }
}

// ===== 拉黑用户 =====
router.post('/block/:userId', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const targetId = parseInt(req.params.userId);
    if (userId === targetId) return res.status(400).json({ code: 400, message: '不能拉黑自己' });
    await pool.execute(
      'INSERT IGNORE INTO blocked_users (user_id, blocked_user_id) VALUES (?, ?)',
      [userId, targetId]
    );
    res.json({ code: 200, message: '已拉黑该用户' });
  } catch (error) {
    console.error('拉黑失败:', error);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

// ===== 取消拉黑 =====
router.delete('/block/:userId', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const targetId = parseInt(req.params.userId);
    await pool.execute(
      'DELETE FROM blocked_users WHERE user_id = ? AND blocked_user_id = ?',
      [userId, targetId]
    );
    res.json({ code: 200, message: '已取消拉黑' });
  } catch (error) {
    console.error('取消拉黑失败:', error);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

// ===== 获取黑名单列表 =====
router.get('/block/list', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const [blocks] = await pool.execute(`
      SELECT b.blocked_user_id as user_id, u.nickname, u.avatar
      FROM blocked_users b
      LEFT JOIN users u ON u.id = b.blocked_user_id
      WHERE b.user_id = ?
      ORDER BY b.created_at DESC
    `, [userId]);
    res.json({ code: 200, data: { users: blocks } });
  } catch (error) {
    console.error('获取黑名单失败:', error);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

// ===== 检查是否被拉黑 =====
router.get('/check-block/:userId', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const targetId = parseInt(req.params.userId);
    const [rows] = await pool.execute(
      'SELECT id FROM blocked_users WHERE user_id = ? AND blocked_user_id = ?',
      [targetId, userId]
    );
    const [myRows] = await pool.execute(
      'SELECT id FROM blocked_users WHERE user_id = ? AND blocked_user_id = ?',
      [userId, targetId]
    );
    res.json({
      code: 200,
      data: {
        blocked_by_them: rows.length > 0,
        blocked_by_me: myRows.length > 0
      }
    });
  } catch (error) {
    console.error('检查拉黑状态失败:', error);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

// ===== 设置会话免打扰 =====
router.put('/conversations/:id/dnd', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const conversationId = parseInt(req.params.id);
    const { enabled } = req.body;

    const [convs] = await pool.execute(
      'SELECT id, user1_id, user2_id FROM conversations WHERE id = ? AND (user1_id = ? OR user2_id = ?)',
      [conversationId, userId, userId]
    );
    if (!convs.length) return res.status(403).json({ code: 403, message: '无权操作' });

    const conv = convs[0];
    const field = conv.user1_id === userId ? 'user1_dnd' : 'user2_dnd';
    await pool.execute(
      `UPDATE conversations SET ${field} = ? WHERE id = ?`,
      [enabled ? 1 : 0, conversationId]
    );

    res.json({ code: 200, message: enabled ? '已开启免打扰' : '已关闭免打扰' });
  } catch (error) {
    console.error('设置免打扰失败:', error);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

// ===== 更新私信通知设置 =====
router.put('/settings/notify-message', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { enabled } = req.body;

    await pool.execute(
      'INSERT INTO user_notify_settings (user_id, notify_message) VALUES (?, ?) ON DUPLICATE KEY UPDATE notify_message = ?',
      [userId, enabled ? 1 : 0, enabled ? 1 : 0]
    );

    res.json({ code: 200, message: enabled ? '已开启私信邮件通知' : '已关闭私信邮件通知' });
  } catch (error) {
    console.error('更新通知设置失败:', error);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

// ===== 获取当前用户的全部设置 =====
router.get('/settings', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const [settings] = await pool.execute(
      'SELECT notify_message FROM user_notify_settings WHERE user_id = ?',
      [userId]
    );
    res.json({
      code: 200,
      data: {
        notify_message: settings.length ? !!settings[0].notify_message : true
      }
    });
  } catch (error) {
    console.error('获取设置失败:', error);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

// 获取当前用户的会话列表
router.get('/conversations', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    
    const [conversations] = await pool.execute(`
      SELECT 
        c.id, 
        c.user1_id, 
        c.user2_id,
        c.user1_dnd,
        c.user2_dnd,
        c.last_message_at,
        c.created_at,
        c.updated_at,
        GREATEST(c.user1_id, c.user2_id) as other_user_id,
        CASE 
          WHEN c.user1_id = ? THEN u2.id
          ELSE u1.id
        END as partner_id,
        CASE 
          WHEN c.user1_id = ? THEN u2.nickname
          ELSE u1.nickname
        END as partner_nickname,
        CASE 
          WHEN c.user1_id = ? THEN u2.avatar
          ELSE u1.avatar
        END as partner_avatar,
        CASE 
          WHEN c.user1_id = ? THEN u2.last_login_at
          ELSE u1.last_login_at
        END as partner_last_login_at,
        m.content as last_message_content,
        m.created_at as last_message_created_at,
        (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id AND sender_id != ? AND is_read = 0 AND created_at > COALESCE(CASE WHEN c.user1_id = ? THEN c.user1_cleared_at WHEN c.user2_id = ? THEN c.user2_cleared_at END, '1970-01-01')) as unread_count
      FROM conversations c
      LEFT JOIN users u1 ON u1.id = c.user1_id
      LEFT JOIN users u2 ON u2.id = c.user2_id
      LEFT JOIN messages m ON m.id = (
        SELECT id FROM messages 
        WHERE conversation_id = c.id 
        AND deleted_at IS NULL
        ORDER BY created_at DESC LIMIT 1
      )
      WHERE (c.user1_id = ? OR c.user2_id = ?)
      AND ((c.user1_id = ? AND c.user1_hidden_at IS NULL) OR (c.user2_id = ? AND c.user2_hidden_at IS NULL))
      ORDER BY c.last_message_at DESC, c.updated_at DESC
    `, [userId, userId, userId, userId, userId, userId, userId, userId, userId, userId, userId]);
    
    res.json({ 
      code: 200, 
      data: { 
        conversations: conversations.map(conv => ({
          id: conv.id,
          partner_id: conv.partner_id,
          partner_nickname: conv.partner_nickname,
          partner_avatar: conv.partner_avatar,
          partner_last_login_at: conv.partner_last_login_at,
          last_message: conv.last_message_content,
          last_message_at: conv.last_message_created_at,
          unread_count: conv.unread_count,
          my_dnd: conv.user1_id === userId ? !!conv.user1_dnd : !!conv.user2_dnd,
          created_at: conv.created_at,
          updated_at: conv.updated_at
        }))
      }
    });
  } catch (error) {
    console.error('获取会话列表失败:', error);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

// 获取或创建与特定用户的会话
router.get('/conversations/user/:userId', auth, async (req, res) => {
  try {
    const currentUserId = req.user.id;
    const targetUserId = parseInt(req.params.userId);
    
    if (currentUserId === targetUserId) {
      return res.status(400).json({ code: 400, message: '不能与自己发起私信' });
    }
    
    // 检查目标用户是否存在
    const [targetUsers] = await pool.execute(
      'SELECT id, nickname, avatar, last_login_at FROM users WHERE id = ? AND status = 1',
      [targetUserId]
    );
    
    if (targetUsers.length === 0) {
      return res.status(404).json({ code: 404, message: '用户不存在或已被禁用' });
    }
    
    const targetUser = targetUsers[0];
    
    // 查找现有会话（确保user1_id < user2_id的顺序，但我们的唯一约束已保证不会重复）
    const [existingConversations] = await pool.execute(`
      SELECT id FROM conversations 
      WHERE (user1_id = ? AND user2_id = ?) 
         OR (user1_id = ? AND user2_id = ?)
    `, [currentUserId, targetUserId, targetUserId, currentUserId]);
    
    let conversationId;
    
    if (existingConversations.length > 0) {
      conversationId = existingConversations[0].id;
      
      // 更新最后消息时间
      await pool.execute(
        'UPDATE conversations SET last_message_at = NOW() WHERE id = ?',
        [conversationId]
      );
    } else {
      // 创建新会话
      const [result] = await pool.execute(
        'INSERT INTO conversations (user1_id, user2_id, last_message_at, created_at) VALUES (?, ?, NOW(), NOW())',
        [Math.min(currentUserId, targetUserId), Math.max(currentUserId, targetUserId)]
      );
      conversationId = result.insertId;
    }
    
    // 获取会话详情
    const [conversations] = await pool.execute(`
      SELECT 
        c.id, 
        c.user1_id, 
        c.user2_id,
        c.last_message_at,
        c.created_at,
        u1.nickname as user1_nickname,
        u1.avatar as user1_avatar,
        u1.last_login_at as user1_last_login_at,
        u2.nickname as user2_nickname,
        u2.avatar as user2_avatar,
        u2.last_login_at as user2_last_login_at
      FROM conversations c
      LEFT JOIN users u1 ON u1.id = c.user1_id
      LEFT JOIN users u2 ON u2.id = c.user2_id
      WHERE c.id = ?
    `, [conversationId]);
    
    if (conversations.length === 0) {
      return res.status(404).json({ code: 404, message: '会话不存在' });
    }
    
    const conv = conversations[0];
    const partner = currentUserId === conv.user1_id 
      ? { id: conv.user2_id, nickname: conv.user2_nickname, avatar: conv.user2_avatar, last_login_at: conv.user2_last_login_at }
      : { id: conv.user1_id, nickname: conv.user1_nickname, avatar: conv.user1_avatar, last_login_at: conv.user1_last_login_at };
    
    res.json({ 
      code: 200, 
      data: { 
        conversation: {
          id: conv.id,
          partner: partner,
          last_message_at: conv.last_message_at,
          created_at: conv.created_at
        }
      }
    });
  } catch (error) {
    console.error('获取/创建会话失败:', error);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

// 获取会话中的消息
router.get('/conversations/:conversationId/messages', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const conversationId = parseInt(req.params.conversationId);
    
    // 验证用户是否参与此会话
    const [conversations] = await pool.execute(
      'SELECT id, user1_id, user2_id, user1_cleared_at, user2_cleared_at FROM conversations WHERE id = ? AND (user1_id = ? OR user2_id = ?)',
      [conversationId, userId, userId]
    );
    
    if (conversations.length === 0) {
      return res.status(403).json({ code: 403, message: '无权访问此会话' });
    }
    
    const conv = conversations[0];
    // 用户是否清空过：获取该用户的 cleared_at
    const clearedAt = conv.user1_id === userId ? conv.user1_cleared_at : conv.user2_cleared_at;
    
    const { page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    
    // 获取消息（过滤已删除 AND 清空时间）
    let clearFilter = '';
    let queryParams = [conversationId];
    if (clearedAt) {
      clearFilter = ' AND m.created_at > ?';
      queryParams.push(clearedAt);
    }
    queryParams.push(parseInt(limit), offset);
    
    const [messages] = await pool.execute(`
      SELECT 
        m.id,
        m.conversation_id,
        m.sender_id,
        m.content,
        m.is_read,
        m.read_at,
        m.created_at,
        u.nickname as sender_nickname,
        u.avatar as sender_avatar
      FROM messages m
      LEFT JOIN users u ON u.id = m.sender_id
      WHERE m.conversation_id = ? AND m.deleted_at IS NULL${clearFilter}
      ORDER BY m.created_at DESC
      LIMIT ? OFFSET ?
    `, queryParams);
    
    // 获取消息总数
    let countParams = [conversationId];
    let countFilter = '';
    if (clearedAt) {
      countFilter = ' AND created_at > ?';
      countParams.push(clearedAt);
    }
    const [totalResult] = await pool.execute(
      'SELECT COUNT(*) as total FROM messages WHERE conversation_id = ? AND deleted_at IS NULL' + countFilter,
      countParams
    );
    const total = totalResult[0].total;
    
    // 标记对方发送的未读消息为已读
    await pool.execute(
      'UPDATE messages SET is_read = 1, read_at = NOW() WHERE conversation_id = ? AND sender_id != ? AND is_read = 0',
      [conversationId, userId]
    );
    
    // 更新会话的最后消息时间为当前时间（用户已查看）
    await pool.execute(
      'UPDATE conversations SET last_message_at = NOW() WHERE id = ?',
      [conversationId]
    );
    
    res.json({ 
      code: 200, 
      data: { 
        messages: messages.reverse(), // 反转数组，让最早的消息在前
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: total,
          pages: Math.ceil(total / parseInt(limit))
        }
      }
    });
  } catch (error) {
    console.error('获取消息失败:', error);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

// 发送消息
router.post('/conversations/:conversationId/messages', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const conversationId = parseInt(req.params.conversationId);
    const { content } = req.body;
    
    if (!content || content.trim().length === 0) {
      return res.status(400).json({ code: 400, message: '消息内容不能为空' });
    }
    
    if (content.length > 2000) {
      return res.status(400).json({ code: 400, message: '消息内容过长（最多2000字）' });
    }
    
    // 验证用户是否参与此会话
    const [conversations] = await pool.execute(
      'SELECT id, user1_id, user2_id FROM conversations WHERE id = ? AND (user1_id = ? OR user2_id = ?)',
      [conversationId, userId, userId]
    );
    
    if (conversations.length === 0) {
      return res.status(403).json({ code: 403, message: '无权发送消息到此会话' });
    }
    
    const conversation = conversations[0];
    const recipientId = conversation.user1_id === userId ? conversation.user2_id : conversation.user1_id;

    // 检查是否被对方拉黑
    const [blocked] = await pool.execute(
      'SELECT id FROM blocked_users WHERE user_id = ? AND blocked_user_id = ?',
      [recipientId, userId]
    );
    if (blocked.length > 0) {
      return res.status(403).json({ code: 403, message: '消息发送失败：你已被对方拉黑' });
    }
    
    // 插入消息
    const [result] = await pool.execute(
      'INSERT INTO messages (conversation_id, sender_id, content, created_at) VALUES (?, ?, ?, NOW())',
      [conversationId, userId, content.trim()]
    );
    
    // 更新会话的最后消息时间
    await pool.execute(
      'UPDATE conversations SET last_message_at = NOW(), updated_at = NOW() WHERE id = ?',
      [conversationId]
    );
    
    // 获取刚刚插入的消息详情
    const [messages] = await pool.execute(`
      SELECT 
        m.id,
        m.conversation_id,
        m.sender_id,
        m.content,
        m.is_read,
        m.read_at,
        m.created_at,
        u.nickname as sender_nickname,
        u.avatar as sender_avatar
      FROM messages m
      LEFT JOIN users u ON u.id = m.sender_id
      WHERE m.id = ?
    `, [result.insertId]);
    
    // 发送邮件通知（异步，不阻塞响应）
    sendMessageNotification(userId, recipientId, content.trim());
    
    res.json({ 
      code: 200, 
      data: { 
        message: messages[0],
        recipient_id: recipientId
      }
    });
  } catch (error) {
    console.error('发送消息失败:', error);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

// 标记消息为已读
router.put('/messages/:messageId/read', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const messageId = parseInt(req.params.messageId);
    
    // 验证用户是否参与此消息所在的会话
    const [messages] = await pool.execute(`
      SELECT m.id, m.conversation_id, m.sender_id
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE m.id = ? AND (c.user1_id = ? OR c.user2_id = ?) AND m.deleted_at IS NULL
    `, [messageId, userId, userId]);
    
    if (messages.length === 0) {
      return res.status(404).json({ code: 404, message: '消息不存在或无权操作' });
    }
    
    const message = messages[0];
    
    // 只能标记对方发送的消息为已读
    if (message.sender_id === userId) {
      return res.status(400).json({ code: 400, message: '不能标记自己发送的消息为已读' });
    }
    
    // 标记为已读
    await pool.execute(
      'UPDATE messages SET is_read = 1, read_at = NOW() WHERE id = ?',
      [messageId]
    );
    
    res.json({ code: 200, message: '消息已标记为已读' });
  } catch (error) {
    console.error('标记消息已读失败:', error);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

// 获取单条消息详情
router.get('/messages/:messageId', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const messageId = parseInt(req.params.messageId);

    const [messages] = await pool.execute(`
      SELECT 
        m.id,
        m.conversation_id,
        m.sender_id,
        m.content,
        m.is_read,
        m.read_at,
        m.created_at,
        u.nickname as sender_nickname,
        u.avatar as sender_avatar
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      LEFT JOIN users u ON u.id = m.sender_id
      WHERE m.id = ? AND (c.user1_id = ? OR c.user2_id = ?) AND m.deleted_at IS NULL
    `, [messageId, userId, userId]);

    if (messages.length === 0) {
      return res.status(404).json({ code: 404, message: '消息不存在或无权查看' });
    }

    res.json({ code: 200, data: { message: messages[0] } });
  } catch (error) {
    console.error('获取消息详情失败:', error);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

// 删除消息（软删除）
router.delete('/messages/:messageId', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const messageId = parseInt(req.params.messageId);
    
    // 验证用户是否发送了此消息（只能删除自己发送的消息）
    const [messages] = await pool.execute(
      'SELECT id FROM messages WHERE id = ? AND sender_id = ? AND deleted_at IS NULL',
      [messageId, userId]
    );
    
    if (messages.length === 0) {
      return res.status(404).json({ code: 404, message: '消息不存在或无权删除' });
    }
    
    // 软删除
    await pool.execute(
      'UPDATE messages SET deleted_at = NOW() WHERE id = ?',
      [messageId]
    );
    
    res.json({ code: 200, message: '消息已删除' });
  } catch (error) {
    console.error('删除消息失败:', error);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

// ===== 用户删除会话（从列表移除） =====
router.delete('/conversations/:id', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const conversationId = parseInt(req.params.id);
    const [convs] = await pool.execute(
      'SELECT id, user1_id, user2_id FROM conversations WHERE id = ? AND (user1_id = ? OR user2_id = ?)',
      [conversationId, userId, userId]
    );
    if (!convs.length) return res.status(403).json({ code: 403, message: '无权操作' });
    const conv = convs[0];
    const field = conv.user1_id === userId ? 'user1_hidden_at' : 'user2_hidden_at';
    await pool.execute('UPDATE conversations SET ' + field + ' = NOW() WHERE id = ?', [conversationId]);
    res.json({ code: 200, message: '会话已删除' });
  } catch (e) {
    console.error('删除会话失败:', e);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

// ===== 用户清空聊天记录（伪删除，管理员仍可查看） =====
router.post('/conversations/:id/clear', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const conversationId = parseInt(req.params.id);
    const [convs] = await pool.execute(
      'SELECT id, user1_id, user2_id FROM conversations WHERE id = ? AND (user1_id = ? OR user2_id = ?)',
      [conversationId, userId, userId]
    );
    if (!convs.length) return res.status(403).json({ code: 403, message: '无权操作' });
    const conv = convs[0];
    const field = conv.user1_id === userId ? 'user1_cleared_at' : 'user2_cleared_at';
    await pool.execute('UPDATE conversations SET ' + field + ' = NOW() WHERE id = ?', [conversationId]);
    res.json({ code: 200, message: '聊天记录已清空' });
  } catch (e) {
    console.error('清空聊天记录失败:', e);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

module.exports = router;