'use strict';

const assert = require('assert');

const settings = {
  email_enabled: '1',
  smtp_host: 'smtp.example.test',
  smtp_port: '587',
  smtp_user: 'noreply@example.test',
  smtp_pass: 'test-only-password',
  smtp_from: '示例校园墙'
};
let createCount = 0;
let closeCount = 0;
const sent = [];

const databasePath = require.resolve('../config/database');
const fakePool = {
  async execute(sql) {
    if (sql.includes('FROM settings')) {
      return [Object.keys(settings).map(function(config_key) {
        return { config_key, config_value: settings[config_key] };
      })];
    }
    if (sql.includes('FROM user_notify_settings')) return [[]];
    if (sql.includes('FROM users WHERE role IN ("admin", "super_admin")')) {
      return [[
        { id: 1, email: 'admin@example.test', nickname: '管理员' },
        { id: 2, email: 'ADMIN@example.test', nickname: '重复邮箱' },
        { id: 3, email: 'super@example.test', nickname: '超级管理员' }
      ]];
    }
    return [{ affectedRows: 0 }];
  }
};
require.cache[databasePath] = {
  id: databasePath,
  filename: databasePath,
  loaded: true,
  exports: { pool: fakePool }
};

const nodemailer = require('nodemailer');
nodemailer.createTransport = function(options) {
  createCount += 1;
  return {
    options,
    async sendMail(message) { sent.push(message); },
    close() { closeCount += 1; }
  };
};

const email = require('../services/email');

async function main() {
  const firstBatch = await Promise.all([
    email.sendEmail('one@example.test', 'one', '<p>one</p>'),
    email.sendEmail('two@example.test', 'two', '<p>two</p>')
  ]);
  assert.deepStrictEqual(firstBatch, [true, true]);
  assert.strictEqual(createCount, 1, '并发发送同一 SMTP 配置只应创建一个 transporter');

  settings.smtp_host = 'smtp-rotated.example.test';
  assert.strictEqual(await email.sendEmail('three@example.test', 'three', '<p>three</p>'), true);
  assert.strictEqual(createCount, 2, 'SMTP 配置变化后应创建新 transporter');
  assert.strictEqual(closeCount, 1, '无发送中的旧 transporter 应被关闭');
  assert.strictEqual(sent.length, 3);

  await email.notifySongApproved(
    'student@example.test', '小明', 'A < B', '歌手 & 乐队', '午间广播', 42,
    { playDate: '2026-09-07', startTime: '12:10:00', endTime: '12:40:00' }
  );
  const songApproval = sent[3];
  assert.strictEqual(songApproval.subject, '🎵 点歌审核通过 · 示例校园墙');
  assert(songApproval.html.includes('2026年09月07日'), '审核通过邮件必须明确播放日期');
  assert(songApproval.html.includes('12:10 - 12:40'), '审核通过邮件必须明确开始和结束时间');
  assert(songApproval.html.includes('午间广播'), '审核通过邮件必须明确时段名');
  assert(songApproval.html.includes('点歌人：') && songApproval.html.includes('小明'), '审核通过邮件必须明确点歌人');
  assert(songApproval.html.includes('A &lt; B') && songApproval.html.includes('歌手 &amp; 乐队'), '点歌信息必须进行 HTML 转义');
  assert(!songApproval.html.includes('@media') && !songApproval.html.includes('linear-gradient'), '点歌通知应使用不依赖客户端主题规则的实色内联样式');
  await email.notifySongRejected(
    'student@example.test', '小明', 'A < B', '歌手 & 乐队', '当天排期已满，请下次再点歌', 42,
    { playDate: '2026-09-07', slotName: '午间广播', startTime: '12:10:00', endTime: '12:40:00' }
  );
  const songRejected = sent[4];
  assert(songRejected.html.includes('当天排期已满') && songRejected.html.includes('欢迎下次再来点歌'), '未安排邮件应友好说明原因并提示下次再点');
  assert(songRejected.html.includes('点歌人：') && songRejected.html.includes('A &lt; B'), '未安排邮件必须明确点歌人和歌曲信息');
  assert(songRejected.html.includes('你希望的播放时间') && songRejected.html.includes('2026年09月07日'), '未安排邮件必须保留用户原本预约的播放安排');
  assert(songRejected.html.includes('本期排期已满'), '排期容量原因应显示明确的未安排状态');
  await email.notifySongPlayed('student@example.test', '小明', 'A < B', '歌手 & 乐队', 42);
  const songPlayed = sent[5];
  assert(songPlayed.html.includes('你的点歌已经播放') && songPlayed.html.includes('A &lt; B'), '已播放邮件也应使用统一的点歌信息卡');
  assert(songPlayed.html.includes('歌手：歌手 &amp; 乐队'), '已播放邮件中的歌手信息必须转义并清晰展示');
  await email.notifyAdminsNewFeedback({
    id: 73, type: 'bug', title: '<故障>', content: '<script>alert(1)</script>', requesterName: '小明 & 同学'
  });
  const feedbackEmails = sent.slice(6);
  assert.deepStrictEqual(feedbackEmails.map(message => message.to), ['admin@example.test', 'super@example.test']);
  assert(feedbackEmails.every(message => message.subject.includes('新意见反馈')));
  assert(feedbackEmails[0].html.includes('&lt;故障&gt;') && feedbackEmails[0].html.includes('小明 &amp; 同学'));
  assert(feedbackEmails[0].html.includes('&lt;script&gt;') && !feedbackEmails[0].html.includes('<script>'));
  assert(feedbackEmails[0].html.includes('/admin'), '管理员邮件应指向反馈管理所在后台');
  console.log('Email service tests passed');
}

main().catch(function(err) {
  console.error(err);
  process.exitCode = 1;
});
