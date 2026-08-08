'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFeishuError, normalizeError } = require('../lib/error');

test('保留飞书返回的错误码、原因和处理建议', () => {
  const details = normalizeError(createFeishuError({
    code: 230002,
    msg: 'The bot can not be outside the group.',
    request_id: 'req-123',
  }));

  assert.deepEqual(details, {
    error: 'The bot can not be outside the group.',
    code: 230002,
    hint: '请先将机器人加入目标群。',
    requestId: 'req-123',
  });
});

test('兼容 SDK 通过 response.data 抛出的错误', () => {
  const details = normalizeError({
    message: 'Request failed',
    response: {
      status: 400,
      data: {
        code: 230034,
        msg: 'The receive_id is invalid.',
      },
    },
  });

  assert.equal(details.code, 230034);
  assert.equal(details.error, 'The receive_id is invalid.');
  assert.equal(details.hint, '请检查 receive_id 与 receive_id_type 是否匹配。');
});

test('未知错误也返回可读原因', () => {
  assert.deepEqual(normalizeError(new Error('网络连接失败')), {
    error: '网络连接失败',
  });
});

test('超长和限频错误提供可执行提示', () => {
  assert.match(normalizeError(createFeishuError({ code: 230020 })).hint, /稍后重试/);
  assert.match(normalizeError(createFeishuError({ code: 230025 })).hint, /自动分段/);
});
