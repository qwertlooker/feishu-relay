'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../app');
const { loadConfig } = require('../lib/config');
const { createFeishuService } = require('../lib/feishu-service');
const { createSseHub } = require('../lib/sse');
const { createStorage } = require('../lib/storage');

class FakeRedis {
  constructor() {
    this.values = new Map();
    this.lists = new Map();
  }

  async rpush(key, ...values) {
    const list = this.lists.get(key) || [];
    list.push(...values);
    this.lists.set(key, list);
  }

  async ltrim(key, start, stop) {
    const list = this.lists.get(key) || [];
    const from = start < 0 ? Math.max(0, list.length + start) : start;
    const to = stop < 0 ? list.length + stop + 1 : stop + 1;
    this.lists.set(key, list.slice(from, to));
  }

  async lrange(key, start, stop) {
    const list = this.lists.get(key) || [];
    const from = start < 0 ? Math.max(0, list.length + start) : start;
    const to = stop < 0 ? list.length + stop + 1 : stop + 1;
    return list.slice(from, to);
  }

  async lset(key, index, value) {
    const list = this.lists.get(key) || [];
    list[index] = value;
    this.lists.set(key, list);
  }

  async get(key) { return this.values.get(key); }
  async set(key, value) { this.values.set(key, value); }
}

function createTestDependencies(overrides = {}) {
  const storedMessages = [];
  const broadcasts = [];
  const storage = {
    addMessage: async message => storedMessages.push(message),
    getRecentMessages: async () => [],
    getConversations: async () => [],
    saveConversations: async () => {},
    getDrafts: async () => ({}),
    saveDrafts: async () => {},
    getSettings: async () => ({ theme: 'system' }),
    saveSettings: async () => {},
  };
  const feishuService = {
    sendMessage: async ({ message }) => ({
      result: { code: 0, data: { message_id: 'om_test', create_time: '123' } },
      content: JSON.stringify({ text: message }),
    }),
    listChats: async () => ({ code: 0, data: { items: [] } }),
  };
  const sseHub = {
    size: 0,
    add: () => 'client-1',
    remove: () => {},
    broadcast: (event, data) => broadcasts.push({ event, data }),
  };
  return {
    storage,
    feishuService,
    sseHub,
    storedMessages,
    broadcasts,
    ...overrides,
  };
}

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

test('配置加载会报告缺失变量并校验端口', () => {
  assert.throws(() => loadConfig({}), /FEISHU_APP_ID/);
  assert.throws(() => loadConfig({
    FEISHU_APP_ID: 'app',
    FEISHU_APP_SECRET: 'secret',
    UPSTASH_REDIS_REST_URL: 'url',
    UPSTASH_REDIS_REST_TOKEN: 'token',
    PORT: '70000',
  }), /PORT/);
});

test('存储模块保留最近消息并兼容原有设置默认值', async () => {
  const storage = createStorage(new FakeRedis(), { maxMessages: 2 });
  await storage.addMessage({ id: '1' });
  await storage.addMessage({ id: '2' });
  await storage.addMessage({ id: '3' });
  assert.deepEqual(await storage.getRecentMessages(50), [{ id: '2' }, { id: '3' }]);
  assert.deepEqual(await storage.getSettings(), { theme: 'system' });
});

test('飞书服务保持原有文本发送协议', async () => {
  let payload;
  const service = createFeishuService({
    im: {
      message: {
        create: async value => {
          payload = value;
          return { code: 0, data: { message_id: 'om_1' } };
        },
      },
      chat: { list: async () => ({ code: 0, data: {} }) },
    },
  });
  await service.sendMessage({
    recipient: { id: 'oc_1', receiveIdType: 'chat_id' },
    message: 'hello',
  });
  assert.deepEqual(payload, {
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: 'oc_1',
      msg_type: 'text',
      content: JSON.stringify({ text: 'hello' }),
    },
  });
});

test('原有发送 API 继续存储并广播文本消息', async () => {
  const deps = createTestDependencies();
  const app = createApp({ ...deps, apiSecret: 'token', logger: { log() {}, error() {} } });
  await withServer(app, async baseUrl => {
    const unauthorized = await fetch(`${baseUrl}/api/convs`);
    assert.equal(unauthorized.status, 401);

    const response = await fetch(`${baseUrl}/api/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'token' },
      body: JSON.stringify({ chatId: 'oc_1', message: 'hello' }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
  });
  assert.equal(deps.storedMessages[0].content.text, 'hello');
  assert.equal(deps.broadcasts[0].event, 'message');
});

test('前端静态资源已拆分且入口文件存在', () => {
  const publicDir = path.join(__dirname, '..', 'public');
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  assert.match(html, /href="\/styles\.css"/);
  assert.match(html, /src="\/app\.js"/);
  assert.equal(fs.existsSync(path.join(publicDir, 'styles.css')), true);
  assert.equal(fs.existsSync(path.join(publicDir, 'app.js')), true);
});
