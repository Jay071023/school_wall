'use strict';
const express = require('express');
const { registerMiddlewares } = require('./http/middleware');
const { registerStaticPages } = require('./http/static-pages');
const { registerApiRoutes } = require('./http/routes');

// Builds HTTP behavior only; never initializes the DB, listens or starts jobs.
function createApp({ middleware, staticPages, resolveRouter } = {}) {
  const app = express();
  registerMiddlewares(app, middleware);
  registerStaticPages(app, staticPages);
  registerApiRoutes(app, { resolveRouter });
  return app;
}

module.exports = { createApp };
