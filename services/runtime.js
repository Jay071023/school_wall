'use strict';

// Owns listening, task startup and shutdown; all resources are injected.
function createRuntime({ app, initialize, startTasks, drainTasks, closeDatabase,
  port, host = '0.0.0.0', shutdownTimeoutMs = 10000 }) {
  let server = null;
  let starting = null;
  let stopping = null;
  let stopTasks = null;
  let initialized = false;
  let stopped = false;

  function start() {
    if (stopped) return Promise.reject(new Error('Runtime has stopped'));
    if (starting) return starting;
    starting = (async () => {
      await initialize();
      initialized = true;
      if (stopped) throw new Error('Runtime is stopping');
      await new Promise((resolve, reject) => {
        server = app.listen(port, host);
        function onError(error) { server.removeListener('listening', onListening); reject(error); }
        function onListening() { server.removeListener('error', onError); resolve(); }
        server.once('error', onError);
        server.once('listening', onListening);
      });
      if (stopped) throw new Error('Runtime is stopping');
      stopTasks = startTasks();
      return server;
    })();
    return starting;
  }

  function stop() {
    if (stopping) return stopping;
    stopped = true;
    stopping = (async () => {
      let timeout;
      const shutdown = async () => {
        if (starting) await starting.catch(() => {});
        const closeHttp = server && server.listening
          ? new Promise((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
            if (server.closeIdleConnections) server.closeIdleConnections();
          }) : Promise.resolve();
        try {
          await Promise.all([closeHttp, stopTasks ? stopTasks() : Promise.resolve()]);
          // Requests accepted before close() may have submitted new async tasks.
          if (drainTasks) await drainTasks();
        } finally {
          if (initialized || starting) await closeDatabase();
        }
      };
      const deadline = new Promise((_, reject) => {
        timeout = setTimeout(() => {
          if (server && server.closeAllConnections) server.closeAllConnections();
          reject(new Error('Shutdown deadline exceeded'));
        }, shutdownTimeoutMs);
      });
      try { await Promise.race([shutdown(), deadline]); }
      finally { clearTimeout(timeout); }
    })();
    return stopping;
  }

  return { start, stop };
}

module.exports = { createRuntime };
