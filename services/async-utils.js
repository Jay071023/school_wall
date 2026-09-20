'use strict';

function withTimeout(promise, timeoutMs, message = 'operation timeout') {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function getErrorDetail(error) {
  return error && (error.code || error.message) || 'unknown error';
}

function runBackgroundTask(label, task) {
  setImmediate(() => {
    Promise.resolve()
      .then(task)
      .catch((error) => console.error(`[Background] ${label}:`, getErrorDetail(error)));
  });
}

module.exports = { withTimeout, getErrorDetail, runBackgroundTask };
