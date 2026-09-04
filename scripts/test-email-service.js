'use strict';

const assert = require('assert');

const settings = {
  email_enabled: '1',
  smtp_host: 'smtp.example.test',
  smtp_port: '587',
  smtp_user: 'noreply@example.test',
  smtp_pass: 'test-only-password',
  smtp_from: '校园墙'
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
  console.log('Email service tests passed');
}

main().catch(function(err) {
  console.error(err);
  process.exitCode = 1;
});
