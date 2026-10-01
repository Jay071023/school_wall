'use strict';

// Creating a controller is side-effect free. Only start() allocates timers.
function createIntervalTask(run, intervalMs, options = {}) {
  let interval = null;
  let initial = null;
  let pending = null;
  let stop = null;
  const onError = options.onError || (error => console.error('[Task]', error.message));

  function execute() {
    if (pending || !stop) return;
    pending = Promise.resolve().then(run).catch(onError).finally(() => { pending = null; });
  }

  function start() {
    if (stop) return stop;
    let stopped = false;
    let draining;
    stop = function stopTask() {
      if (stopped) return draining;
      stopped = true;
      clearInterval(interval);
      clearTimeout(initial);
      interval = initial = null;
      stop = null;
      draining = pending || Promise.resolve();
      return draining;
    };
    interval = setInterval(execute, intervalMs);
    if (interval && interval.unref) interval.unref();
    if (options.initialDelayMs !== undefined) {
      initial = setTimeout(execute, options.initialDelayMs);
      if (initial && initial.unref) initial.unref();
    }
    return stop;
  }

  return { start, drain: () => pending || Promise.resolve() };
}

module.exports = { createIntervalTask };
