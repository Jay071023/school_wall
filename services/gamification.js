'use strict';

const { pool } = require('../config/database');

class GamificationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GamificationError';
    this.code = code;
  }
}

/**
 * 原子调整用户积分，并同时写入变更后的余额日志。
 * 行锁保证并发发放/扣除不会基于旧余额写出错误日志。
 */
async function adjustUserPoints(userId, points, reason) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [users] = await connection.execute(
      'SELECT id, points FROM users WHERE id = ? FOR UPDATE',
      [userId]
    );
    if (users.length === 0) {
      throw new GamificationError('USER_NOT_FOUND', '用户不存在');
    }

    const currentBalance = Number(users[0].points) || 0;
    const newBalance = currentBalance + points;
    if (newBalance < 0) {
      throw new GamificationError('INSUFFICIENT_POINTS', '积分不足以扣除');
    }

    await connection.execute(
      'UPDATE users SET points = points + ? WHERE id = ?',
      [points, userId]
    );
    await connection.execute(
      'INSERT INTO points_log (user_id, points, balance, reason) VALUES (?, ?, ?, ?)',
      [userId, points, newBalance, String(reason || 'admin_bonus').slice(0, 100)]
    );
    const [logs] = await connection.execute(
      'SELECT id, user_id, points, balance, reason, created_at FROM points_log WHERE user_id = ? ORDER BY created_at DESC LIMIT 20',
      [userId]
    );

    await connection.commit();
    return { balance: newBalance, logs };
  } catch (err) {
    try { await connection.rollback(); } catch (_) {}
    throw err;
  } finally {
    connection.release();
  }
}

/**
 * 原子颁发称号：称号关系、旧称号清理、奖励积分和积分日志必须一起成功。
 */
async function awardTitle(userId, type, titleConfig) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [users] = await connection.execute(
      'SELECT id, nickname, points FROM users WHERE id = ? FOR UPDATE',
      [userId]
    );
    if (users.length === 0) {
      throw new GamificationError('USER_NOT_FOUND', '用户不存在');
    }

    const [titleRows] = await connection.execute(
      'SELECT id FROM user_titles WHERE title_name = ? ORDER BY id ASC LIMIT 1 FOR UPDATE',
      [titleConfig.name]
    );
    let titleId;
    if (titleRows.length === 0) {
      const [inserted] = await connection.execute(
        'INSERT INTO user_titles (title_name, title_color, title_bg, icon) VALUES (?, ?, ?, ?)',
        [titleConfig.name, titleConfig.color, titleConfig.bg, titleConfig.icon]
      );
      titleId = inserted.insertId;
    } else {
      titleId = titleRows[0].id;
    }

    if (type !== 'custom') {
      await connection.execute('DELETE FROM user_title_relations WHERE title_id = ?', [titleId]);
    }

    const [existing] = await connection.execute(
      'SELECT id FROM user_title_relations WHERE user_id = ? AND title_id = ? LIMIT 1',
      [userId, titleId]
    );
    if (existing.length === 0) {
      await connection.execute(
        'INSERT INTO user_title_relations (user_id, title_id, created_at) VALUES (?, ?, NOW())',
        [userId, titleId]
      );
    }

    const rewardPoints = Number(titleConfig.points) || 0;
    const currentBalance = Number(users[0].points) || 0;
    const newBalance = currentBalance + rewardPoints;
    if (rewardPoints > 0) {
      await connection.execute('UPDATE users SET points = points + ? WHERE id = ?', [rewardPoints, userId]);
      await connection.execute(
        'INSERT INTO points_log (user_id, points, balance, reason) VALUES (?, ?, ?, ?)',
        [userId, rewardPoints, newBalance, titleConfig.reason]
      );
    }

    await connection.commit();
    return {
      user_id: userId,
      nickname: users[0].nickname,
      title_name: titleConfig.name,
      points: rewardPoints,
      balance: newBalance
    };
  } catch (err) {
    try { await connection.rollback(); } catch (_) {}
    throw err;
  } finally {
    connection.release();
  }
}

module.exports = { adjustUserPoints, awardTitle, GamificationError };
