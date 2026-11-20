'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../app');
const { createStorage } = require('../lib/storage');
const { getMessageSearchText } = require('../lib/messages');

class SearchRedis {
  constructor(messages) {
    this.groups = new Map();
    for (const message of messages) {
      const key = `feishu:messages:${encodeURIComponent(message.chatId)}`;
      if (!this.groups.has(key)) this.groups.set(key, []);
      this.groups.get(key).push(message);
    }
  }
  async smembers() { return [...this.groups.keys()].map(key => decodeURIComponent(key.slice('feishu:messages:'.length))); }
  async lrange(key, start, end) {
    const messages = this.groups.get(key) || [];
    return messages.slice(start, end === -1 ? undefined : end + 1);
  }
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

test('搜索文本、文件名、富文本和回复摘要，排除已撤回消息', async () => {
  const messages = [
    { id: '1', chatId: 'oc_a', createTime: '1', content: { text: 'Alpha 文本' } },
    { id: '2', chatId: 'oc_b', createTime: '2', content: { file_name: 'Alpha 报告.pdf' } },
    { id: '3', chatId: 'oc_a', createTime: '3', msgType: 'post', content: { zh_cn: { title: 'Alpha 标题', content: [[{ tag: 'text', text: '正文' }]] } } },
    { id: '4', chatId: 'oc_a', createTime: '4', content: { text: '回复' }, replyPreview: 'Alpha 原消息' },
    { id: '5', chatId: 'oc_a', createTime: '5', content: { text: 'Alpha 已撤回' }, deleted: true },
  ];
  const storage = createStorage(new SearchRedis(messages));
  assert.match(getMessageSearchText(messages[2]), /Alpha 标题.*正文/);
  assert.deepEqual((await storage.searchMessages('alpha')).map(item => item.id), ['4', '3', '2', '1']);
  assert.deepEqual((await storage.searchMessages('alpha', { chatId: 'oc_b' })).map(item => item.id), ['2']);
  assert.deepEqual((await storage.searchMessages('alpha', { type: 'message' })).map(item => item.id), ['4', '3', '1']);
  assert.deepEqual((await storage.searchMessages('alpha', { type: 'file' })).map(item => item.id), ['2']);
});

test('类型筛选兼容旧记录和媒体，过滤后再限制结果数量', async () => {
  const messages = [
    { id: 'file', content: '{"file_name":"fixture.pdf"}' },
    { id: 'image', content: { image_key: 'img_1' } },
    { id: 'video', msgType: 'media', content: { file_key: 'file_2', file_name: 'fixture.mp4' } },
    { id: 'audio', msgType: 'audio', content: { file_key: 'file_3' } },
    { id: 'card', msgType: 'interactive', content: {} },
    { id: 'deleted', msgType: 'file', deleted: true, content: { file_name: 'fixture.pdf' } },
  ].map((message, index) => ({
    chatId: 'oc_a', createTime: String(index), replyPreview: 'fixture', ...message,
  }));
  const storage = createStorage(new SearchRedis(messages));
  for (const [type, expected] of Object.entries({ file: ['file'], image: ['image'], media: ['audio', 'video'], other: ['card'] })) {
    assert.deepEqual((await storage.searchMessages('fixture', { type })).map(item => item.id), expected);
  }
  assert.deepEqual((await storage.searchMessages('fixture', { type: 'file', limit: 1 })).map(item => item.id), ['file']);
  assert.equal(getMessageSearchText({ content: 'null' }), '');
});

test('消息搜索 API 校验参数并返回跨会话结果', async () => {
  const storage = createStorage(new SearchRedis([
    { id: '1', chatId: 'oc_a', createTime: '1', content: { text: '项目进度' } },
    { id: '2', chatId: 'oc_b', createTime: '2', msgType: 'file', content: { file_name: '项目复盘.pdf' } },
  ]));
  const app = createApp({
    apiSecret: 'token',
    storage,
    feishuService: { listChats: async () => ({ code: 0, data: {} }) },
    sseHub: { size: 0, add: () => 'client', remove() {}, broadcast() {} },
    logger: { log() {}, error() {} },
  });
  await withServer(app, async baseUrl => {
    const search = query => fetch(`${baseUrl}/api/messages/search${query}`, { headers: { 'x-api-key': 'token' } });
    const missing = await search('');
    assert.equal(missing.status, 400);

    const response = await fetch(`${baseUrl}/api/messages/search?q=${encodeURIComponent('项目')}`, {
      headers: { 'x-api-key': 'token' },
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.data.count, 2);
    assert.deepEqual(body.data.items.map(item => item.id), ['2', '1']);
    assert.equal((await search('?type=file')).status, 400);
    const query = encodeURIComponent('项目');
    assert.deepEqual((await (await search(`?q=${query}&type=file`)).json()).data.items.map(item => item.id), ['2']);
    assert.deepEqual((await (await search(`?q=${query}&type=file&chatId=oc_a`)).json()).data.items, []);
    assert.equal((await search('?type=unknown')).status, 400);
    assert.equal((await search('?type=file&type=message')).status, 400);
  });
});

test('消息历史 API 只返回指定会话', async () => {
  const storage = createStorage(new SearchRedis([
    { id: 'a1', chatId: 'oc_a', createTime: '1', content: { text: 'A' } },
    { id: 'b1', chatId: 'oc_b', createTime: '2', content: { text: 'B' } },
  ]));
  const app = createApp({
    apiSecret: 'token', storage,
    feishuService: { listChats: async () => ({ code: 0, data: {} }) },
    sseHub: { size: 0, add: () => 'client', remove() {}, broadcast() {} },
    logger: { log() {}, error() {} },
  });
  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/chats/oc_a/messages?limit=50`, {
      headers: { 'x-api-key': 'token' },
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(body.data.items.map(item => item.id), ['a1']);
  });
});

test('可读取早期消息两侧的上下文，保留原分页行为', async () => {
  const messages = Array.from({ length: 120 }, (_, index) => ({
    id: `m${index}`, chatId: 'oc_a', deleted: index === 8,
  }));
  messages.push({ id: 'foreign', chatId: 'oc_b' });
  const storage = createStorage(new SearchRedis(messages));
  const app = createApp({
    apiSecret: 'token', storage, feishuService: {},
    sseHub: { size: 0, add: () => 'client', remove() {}, broadcast() {} },
  });
  await withServer(app, async baseUrl => {
    const get = query => fetch(`${baseUrl}/api/chats/oc_a/messages?${query}`, { headers: { 'x-api-key': 'token' } });
    const result = await (await get('around=m30&limit=5')).json();
    assert.deepEqual(result.data.items.map(item => item.id), ['m28', 'm29', 'm30', 'm31', 'm32']);
    assert.equal(result.data.hasNewer, true);
    assert.equal(result.data.hasMore, true);
    assert.equal(result.data.nextBefore, 'm28');
    assert.equal((await (await get('around=m119&limit=5')).json()).data.hasNewer, false);
    assert.deepEqual((await (await get('before=m30&limit=2')).json()).data.items.map(item => item.id), ['m28', 'm29']);
    for (const id of ['m8', 'foreign', 'missing']) assert.equal((await get(`around=${id}`)).status, 404);
    assert.equal((await get('around=m30&before=m20')).status, 400);
  });
});

test('前端提供搜索范围、结果列表、跳转和快捷键', () => {
  const publicDir = path.join(__dirname, '..', 'public');
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const script = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(html, /id="searchScope"/);
  assert.match(html, /id="searchType"/);
  assert.match(html, /id="searchResults"/);
  assert.match(script, /async function performMessageSearch/);
  assert.match(script, /async function openSearchResult/);
  assert.match(script, /api\/chats\/\$\{encodeURIComponent\(id\)\}\/messages/);
  assert.match(script, /event\.ctrlKey \|\| event\.metaKey/);
});
