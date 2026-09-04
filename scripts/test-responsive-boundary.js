'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const messages = read('frontend/js/messages.js');
assert(messages.includes('window.innerWidth <= 768 && currentConversationId'), '私信在 768px 时必须走移动布局');
assert(messages.includes('window.innerWidth > 768'), '私信桌面布局必须从 769px 开始');
assert(!messages.includes('window.innerWidth < 768') && !messages.includes('window.innerWidth >= 768'), '私信不得使用与 CSS 不一致的 768px 边界');
assert.strictEqual(messages, read('public/js/messages.js'), '私信脚本镜像必须一致');

const admin = read('frontend/admin/index.html');
assert(admin.includes('var isMobile = window.innerWidth <= 768;'), '后台弹窗在 768px 时必须使用移动布局');
assert(!admin.includes('var isMobile = window.innerWidth < 768;'), '后台不得使用与 CSS 不一致的移动端边界');
assert.strictEqual(admin, read('public/admin/index.html'), '后台页面镜像必须一致');

console.log('[responsive-boundary] 通过：768px 统一归入移动端，769px 起使用桌面逻辑');
