'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-wall-multer-'));
process.env.UPLOAD_DIR = testRoot;
process.env.JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

const express = require('express');
const multerPackage = require('multer/package.json');
const uploadRoute = require('../routes/upload');

async function main() {
  assert(/^2\./.test(multerPackage.version), '上传中间件必须使用已修复安全问题的 Multer 2.x');

  const app = express();
  app.post('/upload', function(req, res) {
    uploadRoute.avatarUpload.single('avatar')(req, res, function(err) {
      if (err) return res.status(400).json({ code: err.code || 'UPLOAD_ERROR' });
      return res.json({ filename: req.file && req.file.filename, size: req.file && req.file.size });
    });
  });

  const server = http.createServer(app);
  await new Promise(function(resolve, reject) {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const address = server.address();
    const endpoint = 'http://127.0.0.1:' + address.port + '/upload';
    const pngBytes = Buffer.concat([
      Buffer.from('89504e470d0a1a0a', 'hex'),
      Buffer.from('multer-2-upload-regression')
    ]);
    const validForm = new FormData();
    validForm.append('avatar', new Blob([pngBytes], { type: 'image/png' }), 'avatar.png');
    const validResponse = await fetch(endpoint, { method: 'POST', body: validForm });
    const validBody = await validResponse.json();
    assert.strictEqual(validResponse.status, 200);
    assert(/^avatar_\d+_[a-f0-9]{24}\.png$/.test(validBody.filename || ''), '合法头像应使用随机安全文件名落盘');
    assert.strictEqual(validBody.size, pngBytes.length);
    assert(fs.existsSync(path.join(testRoot, 'avatars', validBody.filename)), '合法上传文件必须写入隔离测试目录');

    const invalidForm = new FormData();
    invalidForm.append('unexpected', new Blob([pngBytes], { type: 'image/png' }), 'avatar.png');
    const invalidResponse = await fetch(endpoint, { method: 'POST', body: invalidForm });
    const invalidBody = await invalidResponse.json();
    assert.strictEqual(invalidResponse.status, 400);
    assert.strictEqual(invalidBody.code, 'LIMIT_UNEXPECTED_FILE', '非白名单字段必须被 Multer 拒绝');

    console.log('[upload-middleware] 通过：Multer 2.x 头像上传、随机文件名和字段白名单均正常');
  } finally {
    await new Promise(function(resolve) { server.close(resolve); });
  }
}

main()
  .catch(function(err) {
    console.error(err.stack || err.message);
    process.exitCode = 1;
  })
  .finally(function() {
    fs.rmSync(testRoot, { recursive: true, force: true });
  });
