'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { createApp, getUploadFileType } = require('../app');
const { createFeishuService } = require('../lib/feishu-service');
const { normalizeIncomingMessage } = require('../lib/messages');

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

function createP3Dependencies() {
  const calls = [];
  const broadcasts = [];
  const storage = {
    addMessage: async message => calls.push({ type: 'store', message }),
    markMessageDeleted: async messageId => ({ id: messageId, deleted: true }),
    getRecentMessages: async () => [],
    getConversations: async () => [],
    saveConversations: async () => {},
    getDrafts: async () => ({}),
    saveDrafts: async () => {},
    getSettings: async () => ({ theme: 'system' }),
    saveSettings: async () => {},
  };
  const feishuService = {
    uploadResource: async value => {
      calls.push({ type: 'upload', value });
      return value.kind === 'image'
        ? { key: 'img_1', msgType: 'image' }
        : { key: 'file_1', msgType: 'file' };
    },
    sendMessage: async value => {
      calls.push({ type: 'send', value });
      return {
        result: {
          code: 0,
          data: {
            message_id: 'om_reply',
            parent_id: value.replyTo,
            create_time: '123',
          },
        },
        content: JSON.stringify(value.message),
      };
    },
    withdrawMessage: async messageId => calls.push({ type: 'withdraw', messageId }),
    getMessageResource: async () => ({
      headers: { 'content-type': 'application/octet-stream' },
      getReadableStream: () => Readable.from(Buffer.from('fixture-resource')),
    }),
    listChats: async () => ({ code: 0, data: { items: [] } }),
  };
  const sseHub = {
    size: 0,
    add: () => 'client',
    remove: () => {},
    broadcast: (event, data) => broadcasts.push({ event, data }),
  };
  return { storage, feishuService, sseHub, calls, broadcasts };
}

test('飞书服务支持引用回复、图片文件上传和撤回', async () => {
  const calls = {};
  const resource = { getReadableStream() {}, headers: {} };
  const service = createFeishuService({
    im: {
      message: {
        create: async () => { throw new Error('回复时不应调用 create'); },
        reply: async payload => {
          calls.reply = payload;
          return { code: 0, data: { message_id: 'om_2' } };
        },
        delete: async payload => {
          calls.delete = payload;
          return { code: 0, data: {} };
        },
      },
      image: {
        create: async payload => {
          calls.image = payload;
          return { image_key: 'img_1' };
        },
      },
      file: {
        create: async payload => {
          calls.file = payload;
          return { file_key: 'file_1' };
        },
      },
      messageResource: {
        get: async payload => {
          calls.resource = payload;
          return resource;
        },
      },
      chat: { list: async () => ({ code: 0, data: {} }) },
    },
  });

  await service.sendMessage({
    recipient: { id: 'oc_1', receiveIdType: 'chat_id' },
    message: 'reply',
    replyTo: 'om_1',
  });
  assert.equal(calls.reply.path.message_id, 'om_1');
  assert.equal(calls.reply.data.msg_type, 'text');

  assert.deepEqual(await service.uploadResource({
    kind: 'image', buffer: Buffer.from('image'), fileName: 'a.png',
  }), { key: 'img_1', msgType: 'image' });
  assert.equal(Buffer.isBuffer(calls.image.data.image), true);

  assert.deepEqual(await service.uploadResource({
    kind: 'file', buffer: Buffer.from('file'), fileName: 'a.txt',
  }), { key: 'file_1', msgType: 'file' });
  assert.equal(calls.file.data.file_type, 'stream');

  await service.withdrawMessage('om_2');
  assert.equal(calls.delete.path.message_id, 'om_2');
  assert.equal(await service.getMessageResource({
    messageId: 'om_1', fileKey: 'img_1', type: 'image',
  }), resource);
});

test('音视频上传类型正确映射，消息资源失败时回退到应用资源接口', async () => {
  const calls = [];
  const fallbackResource = { getReadableStream() {}, headers: {} };
  const service = createFeishuService({
    im: {
      messageResource: { get: async () => { throw new Error('not available'); } },
      image: {
        get: async payload => { calls.push(['image', payload]); return fallbackResource; },
      },
      file: {
        create: async payload => {
          calls.push(['upload', payload]);
          return { file_key: 'file_media' };
        },
        get: async payload => { calls.push(['file', payload]); return fallbackResource; },
      },
    },
  });

  assert.equal(getUploadFileType('file', 'audio/ogg', 'voice.ogg'), 'opus');
  assert.equal(getUploadFileType('file', 'video/mp4', 'clip.mp4'), 'mp4');
  assert.equal(getUploadFileType('file', 'application/pdf', 'report.pdf'), 'pdf');
  assert.equal(getUploadFileType('file', 'application/zip', 'archive.zip'), 'stream');
  assert.deepEqual(await service.uploadResource({
    kind: 'file', buffer: Buffer.from('audio'), fileName: 'voice.ogg', fileType: 'opus',
  }), { key: 'file_media', msgType: 'audio' });
  assert.deepEqual(await service.uploadResource({
    kind: 'file', buffer: Buffer.from('video'), fileName: 'clip.mp4', fileType: 'mp4',
  }), { key: 'file_media', msgType: 'media' });

  assert.equal(await service.getMessageResource({
    messageId: 'om_out', fileKey: 'img_out', type: 'image',
  }), fallbackResource);
  assert.equal(await service.getMessageResource({
    messageId: 'om_out', fileKey: 'file_out', type: 'file',
  }), fallbackResource);
  assert.equal(calls.some(([type]) => type === 'image'), true);
  assert.equal(calls.some(([type]) => type === 'file'), true);
});

test('上传、引用发送和撤回 API 形成完整链路', async () => {
  const deps = createP3Dependencies();
  const app = createApp({ ...deps, apiSecret: 'token', logger: { log() {}, error() {} } });
  await withServer(app, async baseUrl => {
    const uploadResponse = await fetch(`${baseUrl}/api/upload?kind=image`, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-api-key': 'token',
        'x-file-name': encodeURIComponent('示例.png'),
      },
      body: Buffer.from('image-bytes'),
    });
    const uploaded = await uploadResponse.json();
    assert.deepEqual(uploaded.content, { image_key: 'img_1' });

    const fileUploadResponse = await fetch(`${baseUrl}/api/upload?kind=file`, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-api-key': 'token',
        'x-file-name': encodeURIComponent('说明.txt'),
      },
      body: Buffer.from('file-bytes'),
    });
    const uploadedFile = await fileUploadResponse.json();
    assert.deepEqual(uploadedFile.content, { file_key: 'file_1' });
    assert.equal(uploadedFile.fileName, '说明.txt');

    const sendResponse = await fetch(`${baseUrl}/api/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'token' },
      body: JSON.stringify({
        chatId: 'oc_1',
        message: uploaded.content,
        msgType: 'image',
        replyTo: 'om_parent',
        replyPreview: '原消息',
      }),
    });
    assert.equal(sendResponse.status, 200);

    const fileSendResponse = await fetch(`${baseUrl}/api/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'token' },
      body: JSON.stringify({
        chatId: 'oc_1',
        message: uploadedFile.content,
        msgType: 'file',
        fileName: uploadedFile.fileName,
      }),
    });
    assert.equal(fileSendResponse.status, 200);

    const resourceResponse = await fetch(
      `${baseUrl}/api/messages/om_reply/resources/file_1?type=file`,
      { headers: { 'x-api-key': 'token' } },
    );
    assert.equal(resourceResponse.status, 200);
    assert.equal(resourceResponse.headers.get('content-disposition'), 'attachment');
    assert.equal(await resourceResponse.text(), 'fixture-resource');

    const namedResourceResponse = await fetch(
      `${baseUrl}/api/messages/om_reply/resources/file_1?type=file&name=${encodeURIComponent('说明.txt')}`,
      { headers: { 'x-api-key': 'token' } },
    );
    assert.match(namedResourceResponse.headers.get('content-disposition'), /filename\*=UTF-8''/);
    assert.equal(await namedResourceResponse.text(), 'fixture-resource');

    const deleteResponse = await fetch(`${baseUrl}/api/messages/om_reply`, {
      method: 'DELETE',
      headers: { 'x-api-key': 'token' },
    });
    assert.equal(deleteResponse.status, 200);
  });

  assert.equal(deps.calls.find(call => call.type === 'send').value.replyTo, 'om_parent');
  assert.equal(
    deps.calls.filter(call => call.type === 'store').find(call => call.message.msgType === 'file').message.content.file_name,
    '说明.txt',
  );
  assert.equal(deps.calls.find(call => call.type === 'withdraw').messageId, 'om_reply');
  assert.equal(deps.broadcasts.some(item => item.event === 'message_deleted'), true);
});

test('接收消息保留回复关系和富文本类型', () => {
  const message = normalizeIncomingMessage({
    sender: { sender_id: { open_id: 'ou_1' }, sender_type: 'user' },
    message: {
      message_id: 'om_2',
      root_id: 'om_root',
      parent_id: 'om_parent',
      thread_id: 'omt_1',
      chat_id: 'oc_1',
      chat_type: 'group',
      message_type: 'post',
      create_time: '123',
      content: JSON.stringify({ zh_cn: { title: '标题', content: [[{ tag: 'text', text: '正文' }]] } }),
    },
  });
  assert.equal(message.parentId, 'om_parent');
  assert.equal(message.msgType, 'post');
  assert.equal(message.content.zh_cn.title, '标题');
});

test('前端包含附件、回复、撤回和富文本渲染入口', () => {
  const publicDir = path.join(__dirname, '..', 'public');
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const script = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  assert.match(html, /id="fileInput"/);
  assert.match(html, /id="replyBar"/);
  assert.match(script, /async function handleAttachment/);
  assert.match(script, /async function handleClipboardPaste/);
  assert.match(script, /addEventListener\('paste'/);
  assert.match(script, /item\.type\.startsWith\('image\/'\)/);
  assert.match(script, /async function withdrawMessage/);
  assert.match(script, /function renderMessageContent/);
  assert.match(script, /msg\.msgType === 'audio'/);
  assert.match(script, /msg\.msgType === 'media'/);
  assert.match(script, /content\.image_key && !content\.file_key/);
  assert.match(script, /getComputedStyle\(el\)\.display === 'none'/);
});
