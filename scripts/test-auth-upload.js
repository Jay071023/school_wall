'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-wall-auth-upload-'));
process.env.UPLOAD_DIR = testRoot;

const storage = require('../services/avatar-storage');
const upload = require('../routes/upload');
require('../routes/auth');

function filterResult(file) {
  return new Promise(function(resolve, reject) {
    upload.imageFileFilter({}, file, function(err, accepted) {
      if (err) return resolve({ err, accepted });
      resolve({ err: null, accepted });
    });
  });
}

async function main() {
  storage.ensureUploadDirs();
  const validPng = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  const validPath = path.join(storage.AVATAR_DIR, 'avatar_valid.png');
  const oversizedPath = path.join(storage.AVATAR_DIR, 'avatar_oversized.png');
  fs.writeFileSync(validPath, validPng);
  fs.writeFileSync(oversizedPath, Buffer.concat([validPng, Buffer.alloc(16)]));

  assert.strictEqual(storage.resolveManagedImagePath(path.join(storage.AVATAR_DIR, '..', 'outside.txt')), null);
  assert.strictEqual(storage.resolveManagedImagePath(path.join(storage.AVATAR_DIR, 'default.png')), null);
  assert.strictEqual(await storage.validateImageFile(validPath, { maxBytes: 1024 }), true);
  assert.strictEqual(await storage.validateImageFile(oversizedPath, { maxBytes: 12 }), false);
  assert.strictEqual(upload.getSafeImageExtension({ originalname: 'avatar.PNG' }), '.png');
  assert.strictEqual(upload.getSafeImageExtension({ originalname: '../avatar.png' }), null);
  assert.strictEqual((await filterResult({ fieldname: 'avatar', originalname: 'a.png', mimetype: 'image/png' })).accepted, true);
  assert.strictEqual((await filterResult({ fieldname: 'avatar', originalname: 'a.svg', mimetype: 'image/svg+xml' })).err.code, 'LIMIT_UNEXPECTED_FILE');
  console.log('Auth/upload security tests passed');
}

main()
  .catch(function(err) {
    console.error(err.stack || err.message);
    process.exitCode = 1;
  })
  .finally(function() {
    fs.rmSync(testRoot, { recursive: true, force: true });
  });
