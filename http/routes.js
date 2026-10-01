'use strict';

const API_ROUTES = Object.freeze([
  Object.freeze(["/api/auth","../routes/auth"]),
  Object.freeze(["/api/posts","../routes/posts"]),
  Object.freeze(["/api/songs","../routes/songs"]),
  Object.freeze(["/api/admin","../routes/admin"]),
  Object.freeze(["/api/upload","../routes/upload"]),
  Object.freeze(["/api/feedback","../routes/feedback"]),
  Object.freeze(["/api/notifications","../routes/notifications"]),
  Object.freeze(["/api/notices","../routes/notices"]),
  Object.freeze(["/api/reservations","../routes/reservations"]),
  Object.freeze(["/api/leaderboard","../routes/leaderboard"]),
  Object.freeze(["/api/follows","../routes/follows"]),
  Object.freeze(["/api/checkin","../routes/checkin"]),
  Object.freeze(["/api/wechat","../routes/wechat"]),
  Object.freeze(["/api/messages","../routes/messages"]),
  Object.freeze(["/api/mp","../routes/mp-draft"]),
  Object.freeze(["/api/proxy/hitokoto","../routes/hitokoto"]),
  Object.freeze(["/api","../routes/site"]),
  Object.freeze(["/api","../routes/health"]),
  Object.freeze(["/api","../routes/deploy"]),
]);

function registerApiRoutes(app, { resolveRouter = modulePath => require(modulePath) } = {}) {
  for (const [prefix, modulePath] of API_ROUTES) app.use(prefix, resolveRouter(modulePath));
}

module.exports = { registerApiRoutes, API_ROUTES };
