'use strict';

const assert = require('assert');
const jwt = require('jsonwebtoken');

async function main() {
  process.env.JWT_SECRET = 'example-http-only';
  process.env.WECHAT_SECRET = 'example-http-only';
  const roles = ['user', 'reviewer', 'radio_admin', 'admin', 'super_admin'];
  let unavailable = false;
  require.cache[require.resolve('../config/database')] = { loaded: true, exports: {
    initDB() { assert.fail('HTTP construction must not initialize the database'); },
    pool: { async execute(sql, params) {
      if (unavailable) throw Object.assign(new Error('Fixture unavailable'), { code: 'FIXTURE' });
      if (sql.includes('SELECT 1')) return [[{ ok: 1 }]];
      if (sql.includes('FROM users WHERE id = ?')) {
        const id = Number(params[0]);
        return [[{ id, username: 'fixture', role: roles[id - 1], status: 1 }]];
      }
      throw new Error('Unexpected fixture SQL');
    } }
  } };
  const signalListeners = process.listenerCount('SIGTERM');
  const errorListeners = process.listenerCount('uncaughtException');
  const { createApp } = require('../app');
  const { API_ROUTES, registerApiRoutes } = require('../http/routes');
  const registered = [];
  registerApiRoutes({ use(prefix, router) { registered.push([prefix, router]); } }, { resolveRouter: path => path });
  assert.deepEqual(registered, API_ROUTES);
  assert.equal(API_ROUTES.length, 19);
  assert.equal(API_ROUTES[0][0], '/api/auth');
  assert.equal(API_ROUTES[API_ROUTES.length - 1][1], '../routes/deploy');
  const app = createApp({ middleware: { logging: false, allowedOrigins: ['https://example.invalid'] } });
  assert.equal(process.listenerCount('SIGTERM'), signalListeners);
  assert.equal(process.listenerCount('uncaughtException'), errorListeners);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = (url, options) => fetch(base + url, options);
  try {
    for (const url of ['/radio', '/messages', '/post/42', '/admin/mp-draft']) {
      const response = await request(url);
      assert.equal(response.status, 200, url);
      assert.match(response.headers.get('cache-control'), /no-cache/);
      assert.match(response.headers.get('content-type'), /text\/html/);
      await response.arrayBuffer();
    }
    const publicCss = await request('/css/style.css');
    assert.match(publicCss.headers.get('cache-control'), /max-age=300/);
    await publicCss.arrayBuffer();
    const adminCss = await request('/admin/css/admin.css');
    assert.match(adminCss.headers.get('cache-control'), /no-cache/);
    await adminCss.arrayBuffer();

    assert.equal((await request('/api/health')).status, 200);
    assert.equal((await request('/api/admin/my-permissions')).status, 401);
    assert.equal((await request('/api/mp/extra-info')).status, 401);
    for (let id = 1; id <= roles.length; id++) {
      const headers = { authorization: 'Bearer ' + jwt.sign({ id }, process.env.JWT_SECRET) };
      const permissions = await request('/api/admin/my-permissions', { headers });
      assert.equal(permissions.status, id === 1 ? 403 : 200);
      if (id > 1) assert.equal((await permissions.json()).data.role, roles[id - 1]);
      if (id < 5) assert.equal((await request('/api/mp/extra-info', { headers })).status, 403);
    }
    const cors = await request('/radio', { headers: { origin: 'https://example.invalid' } });
    assert.equal(cors.headers.get('access-control-allow-origin'), 'https://example.invalid');
    await cors.arrayBuffer();
    unavailable = true;
    assert.equal((await request('/api/health')).status, 503);
    const headers = { authorization: 'Bearer ' + jwt.sign({ id: 2 }, process.env.JWT_SECRET) };
    assert.equal((await request('/api/admin/my-permissions', { headers })).status, 503);
  } finally {
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      if (server.closeIdleConnections) server.closeIdleConnections();
    });
  }
  console.log('[http-application] 通过：19 个挂载项、页面别名、缓存头、跨域及匿名/五种角色/数据库错误状态');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
