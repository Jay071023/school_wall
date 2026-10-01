'use strict';
const { loadEnvironment } = require('./config/environment');
loadEnvironment();
const { createApp } = require('./app');
const { initDB, pool } = require('./config/database');
const { createRuntime } = require('./services/runtime');
const { startBackgroundTasks, drainBackgroundTasks } = require('./jobs');
const { scheduleCleanup } = require('./services/cleanup');

const app = createApp();
const PORT = process.env.PORT || 3000;

const runtime = createRuntime({
  app, initialize: initDB, startTasks: startBackgroundTasks,
  drainTasks: drainBackgroundTasks, closeDatabase: () => pool.end(),
  port: PORT, host: process.env.HOST || '0.0.0.0'
});

async function start() {
  const listener = await runtime.start();
  console.log('[Server] listening on port ' + listener.address().port);
  return listener;
}

if (require.main === module) {
  let exiting = false;
  const shutdown = (exitCode, error) => {
    if (exiting) return;
    exiting = true;
    if (error) console.error('[Server]', error.message || String(error));
    runtime.stop().then(() => process.exit(exitCode), err => {
      console.error('[Server] shutdown failed:', err.message);
      process.exit(1);
    });
  };
  process.once('SIGTERM', () => shutdown(0));
  process.once('SIGINT', () => shutdown(0));
  process.once('uncaughtException', error => shutdown(1, error));
  process.once('unhandledRejection', error => shutdown(1, error));
  start().catch(error => shutdown(1, error));
}

module.exports = { app, createApp, start, stop: runtime.stop, scheduleCleanup };
