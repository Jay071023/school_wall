'use strict';

const assert = require('assert');
const http = require('http');
const { createRuntime } = require('../services/runtime');
const { createIntervalTask } = require('../services/task-lifecycle');

async function main() {
  const originals = { setInterval, clearInterval, setTimeout, clearTimeout };
  const intervals = new Set();
  const timeouts = new Set();
  global.setInterval = callback => { const timer = { callback, unref() {} }; intervals.add(timer); return timer; };
  global.clearInterval = timer => intervals.delete(timer);
  global.setTimeout = (callback, delay) => { const timer = { callback, delay, unref() {} }; timeouts.add(timer); return timer; };
  global.clearTimeout = timer => timeouts.delete(timer);
  try {
    // Route imports must neither query the database nor allocate maintenance timers.
    process.env.JWT_SECRET = 'example-runtime-only';
    process.env.WECHAT_SECRET = 'example-runtime-only';
    require.cache[require.resolve('../config/database')] = { exports: { pool: {
      execute() { throw new Error('Database accessed while importing a route'); }
    } } };
    for (const route of ['auth', 'posts', 'songs', 'mp-draft']) require('../routes/' + route);
    assert.equal(intervals.size, 0);
    assert.equal(timeouts.size, 0);

    let release;
    let count = 0;
    const task = createIntervalTask(() => { count++; return new Promise(resolve => { release = resolve; }); }, 20, { initialDelayMs: 5 });
    const stop = task.start();
    assert.equal(task.start(), stop);
    assert.equal(intervals.size, 1);
    assert.equal(timeouts.size, 1);
    const timer = [...intervals][0];
    timer.callback();
    await Promise.resolve();
    timer.callback();
    assert.equal(count, 1, 'A slow task must not overlap itself');
    const draining = stop();
    assert.equal(stop(), draining);
    assert.equal(intervals.size, 0);
    assert.equal(timeouts.size, 0);
    const nextStop = task.start();
    stop();
    assert.equal(intervals.size, 1, 'An old stop handle must not stop a restarted task');
    release();
    await draining;
    await nextStop();

    // An in-flight date maintenance run must not reschedule after being stopped.
    const { maintenance: songs } = require('../modules/songs');
    const stopSongs = songs.start();
    assert.equal(intervals.size, 1);
    assert.equal(timeouts.size, 2);
    let releaseDates;
    require('../config/database').pool.execute = () => new Promise(resolve => { releaseDates = resolve; });
    const dateTimer = [...timeouts].find(timer => timer.delay === 5000);
    timeouts.delete(dateTimer);
    dateTimer.callback();
    const songsStopping = stopSongs();
    releaseDates([[]]);
    await songsStopping;
    assert.equal(intervals.size, 0);
    assert.equal(timeouts.size, 0);
  } finally { Object.assign(global, originals); }

  const events = [];
  let initialized = false;
  const app = { listen(port, host) {
    assert(initialized, 'The database must initialize before listening');
    return http.createServer((req, res) => res.end('ok')).listen(port, host);
  } };
  const runtime = createRuntime({ app, port: 0, host: '127.0.0.1',
    initialize: async () => { initialized = true; events.push('init'); },
    startTasks: () => { events.push('tasks'); return () => events.push('stop'); },
    drainTasks: async () => events.push('drain'),
    closeDatabase: async () => events.push('database') });
  const firstStart = runtime.start();
  assert.equal(runtime.start(), firstStart);
  const server = await firstStart;
  assert(server.listening);
  const response = await fetch('http://127.0.0.1:' + server.address().port);
  assert.equal(await response.text(), 'ok');
  const firstStop = runtime.stop();
  assert.equal(runtime.stop(), firstStop);
  await firstStop;
  assert(!server.listening);
  assert.deepEqual(events, ['init', 'tasks', 'stop', 'drain', 'database']);
  await assert.rejects(runtime.start(), /stopped/);

  let closed = 0;
  const failed = createRuntime({ app, port: 0, initialize: async () => { throw new Error('init failed'); },
    startTasks: () => { throw new Error('Tasks started after initialization failure'); },
    closeDatabase: async () => closed++ });
  await assert.rejects(failed.start(), /init failed/);
  await failed.stop();
  assert.equal(closed, 1);

  let finishInitialization;
  const interrupted = createRuntime({ app, port: 0,
    initialize: () => new Promise(resolve => { finishInitialization = resolve; }),
    startTasks: () => assert.fail('Shutdown during initialization must not start tasks'),
    closeDatabase: async () => closed++ });
  const interruptedStart = interrupted.start();
  const interruptedStop = interrupted.stop();
  finishInitialization();
  await assert.rejects(interruptedStart, /stopping/);
  await interruptedStop;
  assert.equal(closed, 2);

  const occupied = http.createServer().listen(0, '127.0.0.1');
  await new Promise(resolve => occupied.once('listening', resolve));
  const conflict = createRuntime({ app, port: occupied.address().port, host: '127.0.0.1',
    initialize: async () => {}, startTasks: () => assert.fail('Tasks must not start when listen fails'),
    closeDatabase: async () => closed++ });
  try {
    await assert.rejects(conflict.start(), { code: 'EADDRINUSE' });
    await conflict.stop();
    assert.equal(closed, 3);
  } finally { await new Promise(resolve => occupied.close(resolve)); }

  const hanging = createRuntime({ app, port: 0, host: '127.0.0.1', shutdownTimeoutMs: 15,
    initialize: async () => {}, startTasks: () => () => new Promise(() => {}), closeDatabase: async () => {} });
  await hanging.start();
  await assert.rejects(hanging.stop(), /deadline/);
  console.log('[runtime-lifecycle] 通过：加载无任务副作用、幂等启停、任务去重、监听失败与有界退出');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
