'use strict';

const assert = require('assert');
const Module = require('module');

const executed = [];
let failNextQuery = false;
const fakePool = {
  execute(sql, params) {
    executed.push({ sql, params });
    if (failNextQuery) {
      failNextQuery = false;
      return Promise.reject(new Error('simulated database detail'));
    }
    if (/^\s*CREATE TABLE/i.test(sql)) {
      return Promise.resolve([{}]);
    }
    if (/^\s*INSERT INTO feedbacks/i.test(sql)) {
      return Promise.resolve([{ affectedRows: 1 }]);
    }
    if (/FROM feedbacks/i.test(sql)) {
      return Promise.resolve([[{ id: 1, title: '测试反馈' }]]);
    }
    if (/FROM notices/i.test(sql)) {
      return Promise.resolve([[{ id: 1, title: '测试公告' }]]);
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }
};

function createRouter() {
  const routes = [];
  return {
    get(path, ...handlers) {
      routes.push({ method: 'GET', path, handlers });
    },
    post(path, ...handlers) {
      routes.push({ method: 'POST', path, handlers });
    },
    __routes: routes
  };
}

function loadRouter(routePath, authModule) {
  const originalLoad = Module._load;
  const fakeExpress = { Router: createRouter };
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'express') return fakeExpress;
    if (request === '../config/database') return { pool: fakePool };
    if (request === '../middleware/auth') return authModule;
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const resolved = require.resolve(routePath);
    delete require.cache[resolved];
    return require(routePath);
  } finally {
    Module._load = originalLoad;
  }
}

function findRoute(router, method, path) {
  const route = router.__routes.find((item) => item.method === method && item.path === path);
  assert(route, `route not found: ${method} ${path}`);
  return route;
}

async function invoke(route, req) {
  let response;
  const res = {
    json(payload) {
      response = payload;
      return payload;
    }
  };

  for (const handler of route.handlers) {
    let continued = false;
    const next = () => {
      continued = true;
    };
    const result = handler(req, res, next);
    if (result && typeof result.then === 'function') await result;
    if (response || !continued) break;
  }
  return response;
}

async function main() {
  const auth = (req, res, next) => {
    req.user = { id: 42 };
    next();
  };
  const feedbackRouter = loadRouter('../routes/feedback', { auth });
  const noticesRouter = loadRouter('../routes/notices', {});
  const submit = findRoute(feedbackRouter, 'POST', '/');
  const myFeedback = findRoute(feedbackRouter, 'GET', '/my');
  const notices = findRoute(noticesRouter, 'GET', '/');

  executed.length = 0;
  let result = await invoke(submit, {
    body: { type: 'bug', title: 123, content: '内容' },
    user: { id: 42 }
  });
  assert.deepStrictEqual(result, { code: 400, message: '请输入标题' });
  assert.strictEqual(executed.length, 0, '非法反馈不应访问数据库');

  result = await invoke(submit, {
    body: { type: ' bug ', title: ' 标题 ', content: ' 内容 ', contact: ' 联系方式 ' },
    user: { id: 42 }
  });
  assert.strictEqual(result.code, 200);
  assert.strictEqual(executed.filter((item) => /^\s*CREATE TABLE/i.test(item.sql)).length, 1);
  const insert = executed.find((item) => /^\s*INSERT INTO feedbacks/i.test(item.sql));
  assert.deepStrictEqual(insert.params, [42, 'bug', '标题', '内容', '联系方式', 'pending']);

  result = await invoke(submit, {
    body: { type: 'other', title: '第二条', content: '内容' },
    user: { id: 42 }
  });
  assert.strictEqual(result.code, 200);
  assert.strictEqual(executed.filter((item) => /^\s*CREATE TABLE/i.test(item.sql)).length, 1, '同一进程不应重复执行反馈表 DDL');

  result = await invoke(myFeedback, {
    query: { page: '2', limit: '999999999' },
    user: { id: 42 }
  });
  assert.strictEqual(result.code, 200);
  const feedbackSelect = executed.filter((item) => /FROM feedbacks/i.test(item.sql)).at(-1);
  assert.deepStrictEqual(feedbackSelect.params, [42, 100, 100]);
  assert(Array.isArray(result.data), '我的反馈 data 必须保持数组结构');

  result = await invoke(notices, { query: { page: '-1', limit: '999999999' } });
  assert.strictEqual(result.code, 200);
  const noticeSelect = executed.filter((item) => /FROM notices/i.test(item.sql)).at(-1);
  assert.deepStrictEqual(noticeSelect.params, [50, 0]);
  assert(Array.isArray(result.data), '公告 data 必须保持数组结构');

  failNextQuery = true;
  result = await invoke(notices, { query: {} });
  assert.deepStrictEqual(result, { code: 500, message: '服务器错误' });

  console.log('[feedback/notices] 通过：输入校验、DDL 去重、分页限幅、接口结构和安全错误返回');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
