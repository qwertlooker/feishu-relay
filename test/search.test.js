'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../app');
const { createStorage } = require('../lib/storage');
const { getMessageSearchText } = require('../lib/messages');

class SearchRedis {
  constructor(messages) { this.messages = messages; }
  async lrange() { return this.messages; }
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
});

test('消息搜索 API 校验参数并返回跨会话结果', async () => {
  const storage = createStorage(new SearchRedis([
    { id: '1', chatId: 'oc_a', createTime: '1', content: { text: '项目进度' } },
    { id: '2', chatId: 'oc_b', createTime: '2', content: { text: '项目复盘' } },
  ]));
  const app = createApp({
    apiSecret: 'token',
    storage,
    feishuService: { listChats: async () => ({ code: 0, data: {} }) },
    sseHub: { size: 0, add: () => 'client', remove() {}, broadcast() {} },
    logger: { log() {}, error() {} },
  });
  await withServer(app, async baseUrl => {
    const missing = await fetch(`${baseUrl}/api/messages/search`, { headers: { 'x-api-key': 'token' } });
    assert.equal(missing.status, 400);

    const response = await fetch(`${baseUrl}/api/messages/search?q=${encodeURIComponent('项目')}`, {
      headers: { 'x-api-key': 'token' },
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.data.count, 2);
    assert.deepEqual(body.data.items.map(item => item.id), ['2', '1']);
  });
});

test('前端提供搜索范围、结果列表、跳转和快捷键', () => {
  const publicDir = path.join(__dirname, '..', 'public');
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const script = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(html, /id="searchScope"/);
  assert.match(html, /id="searchResults"/);
  assert.match(script, /async function performMessageSearch/);
  assert.match(script, /async function openSearchResult/);
  assert.match(script, /event\.ctrlKey \|\| event\.metaKey/);
});
