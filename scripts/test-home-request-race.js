'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const homeSource = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'home.js'), 'utf8');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createHarness() {
  const postList = {
    innerHTML: '',
    insertAdjacentHTML(position, html) {
      assert.strictEqual(position, 'beforeend');
      this.innerHTML += html;
    }
  };
  const elements = {
    postList,
    loadMoreBtn: { disabled: false, textContent: '', style: {} }
  };
  const windowObject = {
    innerHeight: 900,
    addEventListener() {},
    setTimeout,
    clearTimeout,
    scrollTo() {}
  };
  const documentObject = {
    addEventListener() {},
    getElementById(id) {
      return elements[id] || null;
    },
    querySelector(selector) {
      return selector === '.load-more-wrapper' ? null : null;
    },
    querySelectorAll() {
      return [];
    }
  };
  class FakeIntersectionObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  const sandbox = {
    console,
    document: documentObject,
    window: windowObject,
    IntersectionObserver: FakeIntersectionObserver,
    localStorage: { getItem() { return null; }, setItem() {} },
    isLoggedIn() { return false; },
    fetch() { return Promise.reject(new Error('unexpected fetch')); },
    setTimeout,
    clearTimeout,
    isFinite,
    FormData: function FormData() {}
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(homeSource, sandbox, { filename: 'frontend/js/home.js' });
  sandbox.renderPostCard = (post) => `<article data-post-id="${post.id}">${post.id}</article>`;
  sandbox.initViewObserver = () => {};
  sandbox.showToast = () => {};
  return { sandbox, postList };
}

function responseWithPosts(ids, hasMore) {
  return {
    code: 200,
    data: {
      posts: ids.map((id) => ({ id, images: [] })),
      has_more: hasMore
    }
  };
}

async function testLatestRequestWins() {
  const { sandbox, postList } = createHarness();
  const requests = [];
  sandbox.authFetch = (url) => {
    const request = deferred();
    requests.push({ url, ...request });
    return request.promise;
  };
  sandbox.pageInitialized = true;
  sandbox.currentCategory = '全部';
  sandbox.currentSort = 'latest';
  sandbox.currentKeyword = '';
  sandbox.totalLoaded = 0;
  sandbox.hasMore = true;

  const oldPromise = sandbox.loadPosts(false);
  assert.strictEqual(requests.length, 1, '首个筛选请求应发出');

  sandbox.currentCategory = '表白';
  sandbox.totalLoaded = 0;
  sandbox.hasMore = true;
  const latestPromise = sandbox.loadPosts(false);
  assert.strictEqual(requests.length, 2, '新筛选请求不能因为旧请求未返回而被跳过');
  assert.match(requests[1].url, /category=%E8%A1%A8%E7%99%BD/, '新请求应携带最新分类');

  requests[1].resolve(responseWithPosts([202], false));
  await latestPromise;
  assert.match(postList.innerHTML, /202/, '最新响应应渲染到列表');

  requests[0].resolve(responseWithPosts([101], false));
  await oldPromise;
  assert.doesNotMatch(postList.innerHTML, /101/, '旧响应不得覆盖最新筛选结果');
  assert.strictEqual(sandbox.totalLoaded, 1, '旧响应不得重复增加已加载数量');
  assert.strictEqual(sandbox.isLoading, false, '最新请求结束后应解除加载状态');
}

async function testLoadMoreRemainsSerialized() {
  const { sandbox, postList } = createHarness();
  const requests = [];
  sandbox.authFetch = (url) => {
    const request = deferred();
    requests.push({ url, ...request });
    return request.promise;
  };
  sandbox.pageInitialized = true;
  sandbox.hasMore = true;

  const firstPromise = sandbox.loadPosts(false);
  requests[0].resolve(responseWithPosts(Array.from({ length: 10 }, (_, i) => i + 1), true));
  await firstPromise;
  assert.strictEqual(sandbox.totalLoaded, 10, '首屏应正常累计帖子数量');

  const appendPromise = sandbox.loadPosts(true);
  assert.strictEqual(requests.length, 2, '加载更多应发出下一页请求');
  const duplicateAppend = await sandbox.loadPosts(true);
  assert.strictEqual(duplicateAppend, false, '同一页加载中不得重复发起加载更多请求');
  assert.strictEqual(requests.length, 2, '无限滚动的互斥行为应保留');

  requests[1].resolve(responseWithPosts([11], false));
  await appendPromise;
  assert.match(postList.innerHTML, /11/, '加载更多响应应追加到列表');
  assert.strictEqual(sandbox.totalLoaded, 11, '加载更多应只累计一次');
}

(async () => {
  await testLatestRequestWins();
  await testLoadMoreRemainsSerialized();
  console.log('[home-request-race] 通过：最新筛选响应优先，旧响应隔离，加载更多仍保持串行');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
