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
    this.sets = new Map();
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

  async sadd(key, ...values) {
    const set = this.sets.get(key) || new Set();
    values.forEach(value => set.add(value));
    this.sets.set(key, set);
  }

  async smembers(key) { return [...(this.sets.get(key) || [])]; }

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
  assert.throws(() => loadConfig({
    FEISHU_APP_ID: 'app', FEISHU_APP_SECRET: 'secret',
    UPSTASH_REDIS_REST_URL: 'url', UPSTASH_REDIS_REST_TOKEN: 'token', MAX_CHATS: '0',
  }), /MAX_CHATS/);
});

test('存储模块按会话独立限制消息并限制会话数量', async () => {
  const storage = createStorage(new FakeRedis(), { maxMessagesPerChat: 2, maxChats: 2 });
  await storage.addMessage({ id: 'a1', chatId: 'oc_a' });
  await storage.addMessage({ id: 'a2', chatId: 'oc_a' });
  await storage.addMessage({ id: 'a3', chatId: 'oc_a' });
  await storage.addMessage({ id: 'b1', chatId: 'oc_b' });
  assert.deepEqual((await storage.getRecentMessages('oc_a', 50)).map(item => item.id), ['a2', 'a3']);
  assert.deepEqual((await storage.getRecentMessages('oc_b', 50)).map(item => item.id), ['b1']);
  await assert.rejects(storage.addMessage({ id: 'c1', chatId: 'oc_c' }), /会话数量已达到上限 2/);
  await assert.rejects(storage.saveConversations([{ id: 'a' }, { id: 'b' }, { id: 'c' }]), /不能超过 2/);
  assert.deepEqual(await storage.getSettings(), { theme: 'system' });
});

test('旧全局消息安全迁移到分会话列表且不会重复迁移', async () => {
  const redis = new FakeRedis();
  redis.lists.set('feishu:messages', [
    { id: 'a1', chatId: 'oc_a' },
    { id: 'b1', chatId: 'oc_b' },
    { id: 'a2', chatId: 'oc_a' },
  ]);
  const storage = createStorage(redis, { maxMessagesPerChat: 10, maxChats: 5 });
  assert.equal((await storage.migrateLegacyMessages()).messages, 3);
  assert.deepEqual((await storage.getRecentMessages('oc_a')).map(item => item.id), ['a1', 'a2']);
  assert.deepEqual((await storage.getRecentMessages('oc_b')).map(item => item.id), ['b1']);
  assert.equal((await storage.migrateLegacyMessages()).messages, 0);
  assert.equal(redis.lists.get('feishu:messages').length, 3);
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

test('服务器暴露版本且网页仅在版本不一致时提示刷新', async () => {
  const deps = createTestDependencies();
  const app = createApp({
    ...deps,
    apiSecret: 'token',
    appVersion: '9.8.7',
    logger: { log() {}, error() {} },
  });
  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/health`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).version, '9.8.7');
  });

  const publicDir = path.join(__dirname, '..', 'public');
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const script = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(html, /name="app-version" content="1\.3\.0"/);
  assert.match(html, /id="webVersion"/);
  assert.match(html, /id="serverVersion"/);
  assert.match(html, /id="versionAlert"/);
  assert.match(script, /S\.serverVersion !== WEB_VERSION/);
  assert.match(script, /window\.location\.reload/);
});
