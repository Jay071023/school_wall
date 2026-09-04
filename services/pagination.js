'use strict';

/**
 * 统一处理列表接口的分页参数。
 * URL 查询参数都是字符串，不能直接参与 offset 计算；同时限制单页大小，
 * 避免异常参数触发大范围查询或让数据库收到负数 LIMIT/OFFSET。
 */
function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getPagination(query, options) {
  const config = options || {};
  const defaultPage = toPositiveInt(config.defaultPage, 1);
  const defaultLimit = toPositiveInt(config.defaultLimit, 20);
  const maxPage = Math.max(defaultPage, toPositiveInt(config.maxPage, 100000));
  const maxLimit = Math.max(defaultLimit, toPositiveInt(config.maxLimit, 100));
  const page = Math.min(toPositiveInt(query && query.page, defaultPage), maxPage);
  const requestedLimit = toPositiveInt(query && query.limit, defaultLimit);
  const limit = Math.min(requestedLimit, maxLimit);

  return {
    page,
    limit,
    offset: (page - 1) * limit
  };
}

module.exports = { getPagination };
