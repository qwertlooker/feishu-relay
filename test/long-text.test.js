'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../app');
const {
  FEISHU_TEXT_MAX_BYTES,
  getSerializedTextBytes,
} = require('../lib/messages');
const {
  SAFE_TEXT_BYTES,
  prepareTextParts,
  serializedTextBytes,
  splitText,
} = require('../public/text-splitter');

async function withServer(app, callback) {
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();
  try {
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

function dependencies() {
  return {
    storage: {
      addMessage: async () => {},
      getRecentMessages: async () => [],
      getConversations: async () => [],
      saveConversations: async () => {},
      getDrafts: async () => ({}),
      saveDrafts: async () => {},
      getSettings: async () => ({ theme: 'system' }),
      saveSettings: async () => {},
    },
    feishuService: {
      sendMessage: async () => { throw new Error('超限文本不应发往飞书'); },
      listChats: async () => ({ code: 0, data: { items: [] } }),
    },
    sseHub: { size: 0, add: () => 'client', remove() {}, broadcast() {} },
  };
}

test('超长文本按 UTF-8 字节安全分段并保留全部 Unicode 内容', () => {
  const source = `${'飞书🚀e\u0301\n'.repeat(18000)}结束`;
  const rawParts = splitText(source, SAFE_TEXT_BYTES);
  assert.ok(rawParts.length > 1);
  assert.equal(rawParts.join(''), source);
  assert.ok(rawParts.every(part => serializedTextBytes(part) <= SAFE_TEXT_BYTES));

  const labeledParts = prepareTextParts(source);
  assert.equal(labeledParts.length, rawParts.length);
  assert.ok(labeledParts.every(part => serializedTextBytes(part) <= SAFE_TEXT_BYTES));
  assert.match(labeledParts[0], /^\[1\/\d+\]\n/);
});

test('普通文本保持单条且内容不变', () => {
  assert.deepEqual(prepareTextParts('普通消息'), ['普通消息']);
  assert.equal(getSerializedTextBytes('普通消息'), serializedTextBytes('普通消息'));
});

test('超长组合字素退化为码点切分且不丢内容', () => {
  const source = `e${'\u0301'.repeat(200)}`;
  const parts = splitText(source, 64);
  assert.ok(parts.length > 1);
  assert.equal(parts.join(''), source);
  assert.ok(parts.every(part => serializedTextBytes(part) <= 64));
});

test('后端明确拒绝超过飞书 150 KB 的单条文本', async () => {
  const app = createApp({
    ...dependencies(),
    apiSecret: 'token',
    logger: { log() {}, error() {} },
  });
  const oversized = '中'.repeat(FEISHU_TEXT_MAX_BYTES);
  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'token' },
      body: JSON.stringify({ chatId: 'oc_1', message: oversized }),
    });
    const body = await response.json();
    assert.equal(response.status, 413);
    assert.match(body.error, /超过飞书单条 150 KB 限制/);
    assert.match(body.hint, /自动分段/);
  });
});

test('过大的普通 JSON 与上传请求返回各自准确提示', async () => {
  const app = createApp({
    ...dependencies(),
    apiSecret: 'token',
    logger: { log() {}, error() {} },
  });
  await withServer(app, async baseUrl => {
    const jsonResponse = await fetch(`${baseUrl}/api/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'token' },
      body: JSON.stringify({ chatId: 'oc_1', message: 'a'.repeat(6 * 1024 * 1024) }),
    });
    assert.equal(jsonResponse.status, 413);
    assert.match((await jsonResponse.json()).error, /JSON 请求体不能超过 5 MB/);

    const uploadResponse = await fetch(`${baseUrl}/api/upload?kind=file`, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-api-key': 'token',
        'x-file-name': 'large.bin',
      },
      body: Buffer.alloc(31 * 1024 * 1024),
    });
    assert.equal(uploadResponse.status, 413);
    assert.match((await uploadResponse.json()).error, /上传内容超过 30 MB/);
  });
});
