'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-wall-avatar-'));
process.env.UPLOAD_DIR = testRoot;

const storage = require('../services/avatar-storage');

async function main() {
  storage.ensureUploadDirs();
  const pngHeader = Buffer.from('89504e470d0a1a0a', 'hex');
  const imageBytes = Buffer.concat([pngHeader, Buffer.from('test-image-content')]);
  const existingPath = path.join(storage.AVATAR_DIR, 'avatar_existing.png');
  const duplicatePath = path.join(storage.AVATAR_DIR, 'avatar_upload.png');
  const invalidPath = path.join(storage.AVATAR_DIR, 'avatar_invalid.png');

  fs.writeFileSync(existingPath, imageBytes);
  fs.writeFileSync(duplicatePath, imageBytes);
  fs.writeFileSync(invalidPath, Buffer.from('not-an-image'));

  assert.strictEqual(await storage.validateImageFile(existingPath), true);
  assert.strictEqual(await storage.validateImageFile(invalidPath), false);
  assert.strictEqual(await storage.findExistingAvatar(duplicatePath), 'avatar_existing.png');
  console.log('Avatar storage tests passed');
}

main()
  .catch(function(err) {
    console.error(err.stack || err.message);
    process.exitCode = 1;
  })
  .finally(function() {
    fs.rmSync(testRoot, { recursive: true, force: true });
  });
