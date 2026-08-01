'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveRecipient } = require('../lib/recipient');

test('群聊 Chat ID 使用 chat_id', () => {
  assert.deepEqual(resolveRecipient('oc_group'), {
    id: 'oc_group',
    receiveIdType: 'chat_id',
  });
});

test('私聊用户 Open ID 使用 open_id', () => {
  assert.deepEqual(resolveRecipient('ou_user'), {
    id: 'ou_user',
    receiveIdType: 'open_id',
  });
});

test('清理复制 ID 时附带的空白', () => {
  assert.deepEqual(resolveRecipient('  ou_user\r\n'), {
    id: 'ou_user',
    receiveIdType: 'open_id',
  });
});

test('保留调用方明确指定的合法类型', () => {
  assert.deepEqual(resolveRecipient('custom-user', 'user_id'), {
    id: 'custom-user',
    receiveIdType: 'user_id',
  });
});

test('拒绝未知的接收 ID 类型', () => {
  assert.throws(
    () => resolveRecipient('ou_user', 'unknown'),
    /不支持的 receiveIdType/,
  );
});
