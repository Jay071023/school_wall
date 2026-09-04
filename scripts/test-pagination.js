'use strict';

const assert = require('assert');
const { getPagination } = require('../services/pagination');

assert.deepStrictEqual(getPagination({}, { defaultLimit: 20, maxLimit: 100 }), {
  page: 1,
  limit: 20,
  offset: 0
});
assert.deepStrictEqual(getPagination({ page: '-4', limit: '0' }, { defaultLimit: 10, maxLimit: 50 }), {
  page: 1,
  limit: 10,
  offset: 0
});
assert.deepStrictEqual(getPagination({ page: '999999999999999999999', limit: '9999' }, { defaultLimit: 10, maxLimit: 50 }), {
  page: 100000,
  limit: 50,
  offset: 4999950
});
assert.deepStrictEqual(getPagination({ page: '2', limit: '50' }, { defaultLimit: 20, maxLimit: 100 }), {
  page: 2,
  limit: 50,
  offset: 50
});

console.log('[pagination] 通过：默认值、异常值、上限和 offset 计算均符合预期');
