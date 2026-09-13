const assert = require('assert');
const EventEmitter = require('events');
const Module = require('module');
const path = require('path');

process.env.GLM_API_KEY = 'test-glm-key';
process.env.DASHSCOPE_API_KEY = 'test-qwen-key';

const https = require('https');
const originalRequest = https.request;
const originalLoad = Module._load;
let nextResponse = { statusCode: 200, body: { choices: [{ message: { content: 'GLM 测试回复' } }] } };
let responseQueue = [];
let lastRequest = null;
let requestCount = 0;

// ai.js 只在带 openid 时访问数据库；这里替换数据库模块，使 provider 测试无需 MySQL。
const databaseModulePath = path.resolve(__dirname, '..', 'config', 'database.js');
Module._load = function(request, parent, isMain) {
  if (parent && parent.filename && path.resolve(path.dirname(parent.filename), request + '.js') === databaseModulePath) {
    return { pool: { execute: async function() { return [[]]; } } };
  }
  return originalLoad.call(this, request, parent, isMain);
};

https.request = function(options, callback) {
  requestCount += 1;
  lastRequest = { options: options, body: '' };
  const request = new EventEmitter();
  request.write = function(body) { lastRequest.body += body; };
  request.end = function() {
    const responseDef = responseQueue.length ? responseQueue.shift() : nextResponse;
    const response = new EventEmitter();
    response.statusCode = responseDef.statusCode;
    response.setEncoding = function() {};
    callback(response);
    process.nextTick(function() {
      if (responseDef.body !== undefined) response.emit('data', JSON.stringify(responseDef.body));
      response.emit('end');
    });
  };
  request.destroy = function() {};
  return request;
};

const ai = require('../services/ai');

(async function() {
  const reply = await ai.getAIReply('测试文本');
  assert.strictEqual(reply, 'GLM 测试回复');
  assert.strictEqual(lastRequest.options.hostname, 'open.bigmodel.cn');
  assert.strictEqual(lastRequest.options.path, '/api/paas/v4/chat/completions');
  assert.strictEqual(lastRequest.options.headers.Authorization, 'Bearer test-glm-key');
  const payload = JSON.parse(lastRequest.body);
  assert.strictEqual(payload.model, 'glm-4.6v-flash');
  assert.strictEqual(payload.stream, false);
  assert.strictEqual(payload.messages[1].content[0].type, 'text');

  nextResponse = { statusCode: 200, body: { choices: [{ message: { content: '这是一张测试图片' } }] } };
  const imageReply = await ai.getAIImageReply('请描述图片', 'aGVsbG8=', undefined);
  assert.strictEqual(imageReply, '这是一张测试图片');
  const imagePayload = JSON.parse(lastRequest.body);
  assert.strictEqual(imagePayload.model, 'glm-4.6v-flash');
  assert.strictEqual(imagePayload.messages[1].content[0].type, 'image_url');
  assert.strictEqual(imagePayload.messages[1].content[0].image_url.url, 'aGVsbG8=');

  responseQueue = [
    { statusCode: 503, body: { error: { message: 'temporary failure' } } },
    { statusCode: 200, body: { choices: [{ message: { content: '千问备用回复' } }] } }
  ];
  requestCount = 0;
  const fallback = await ai.getAIReply('你好');
  assert.strictEqual(fallback, '千问备用回复');
  assert.strictEqual(requestCount, 2);
  assert.strictEqual(lastRequest.options.hostname, 'dashscope.aliyuncs.com');
  assert.strictEqual(lastRequest.options.path, '/compatible-mode/v1/chat/completions');
  assert.strictEqual(lastRequest.options.headers.Authorization, 'Bearer test-qwen-key');
  const fallbackPayload = JSON.parse(lastRequest.body);
  assert.strictEqual(fallbackPayload.model, 'qwen-plus');
  assert.strictEqual(fallbackPayload.thinking, undefined);
  assert.strictEqual(typeof fallbackPayload.messages[1].content, 'string');

  nextResponse = { statusCode: 429, body: { error: { code: '1305', message: '模型访问量过大' } } };
  requestCount = 0;
  const busy = await ai.getAIReply('高峰期测试');
  assert.match(busy, /访问量较大/);
  assert.strictEqual(requestCount, 2);
  console.log('AI provider tests passed');
})().catch(function(error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(function() {
  https.request = originalRequest;
  Module._load = originalLoad;
});
