require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const lark = require('@larksuiteoapi/node-sdk');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── SSE 客户端注册表 ──────────────────────────────────────────
const sseClients = new Map();

// ── 消息历史（内存存储，生产可换 Redis/SQLite）────────────────
const messageStore = [];
const MAX_MESSAGES = 500;

function addMessage(msg) {
  messageStore.push(msg);
  if (messageStore.length > MAX_MESSAGES) messageStore.shift();
}

function broadcastSSE(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach((res, id) => {
    try { res.write(payload); }
    catch { sseClients.delete(id); }
  });
}

// ── 飞书客户端初始化 ──────────────────────────────────────────
const feishuClient = new lark.Client({
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
  loggerLevel: lark.LoggerLevel.warn,
});

// ── 事件分发器 ────────────────────────────────────────────────
const eventDispatcher = new lark.EventDispatcher({
  encryptKey: process.env.FEISHU_ENCRYPT_KEY || '',
}).register({

  // ── 收到消息 ──────────────────────────────────────────────
  'im.message.receive_v1': async (data) => {
    const { message, sender } = data;
    console.log(`[飞书] 收到消息 from ${sender?.sender_id?.open_id} in ${message.chat_id}`);

    let content;
    try { content = JSON.parse(message.content); }
    catch { content = { text: message.content }; }

    const msgData = {
      id: message.message_id,
      chatId: message.chat_id,
      chatType: message.chat_type,
      senderId: sender?.sender_id?.open_id,
      senderType: sender?.sender_type,
      content,
      msgType: message.message_type,
      createTime: message.create_time,
      direction: 'incoming',
    };

    addMessage(msgData);
    broadcastSSE('message', msgData);
  },

  // ── 消息已读回执 ───────────────────────────────────────────
  // 触发：对方在飞书客户端打开了包含你发送消息的会话
  // data.reader.reader_id.open_id  — 谁读了
  // data.message_id_list           — 被标为已读的消息列表
  // data.reader.read_time          — 已读时间戳（ms 字符串）
  'im.message.message_read_v1': async (data) => {
    const { reader, message_id_list } = data;
    const readerId = reader?.reader_id?.open_id;
    console.log(`[飞书] 已读回执 reader=${readerId} msgs=${(message_id_list || []).join(',')}`);

    const receiptData = {
      readerId,
      messageIds: message_id_list || [],
      readTime: reader?.read_time,
      tenantKey: reader?.tenant_key,
    };

    broadcastSSE('read', receiptData);
  },

});

// ── 启动 WebSocket 长连接 ─────────────────────────────────────
const wsClient = new lark.WSClient(feishuClient);

function startFeishuWS() {
  wsClient.start({ eventDispatcher })
    .then(() => {
      console.log('✅ 飞书 WebSocket 长连接已建立');
    })
    .catch((err) => {
      console.error('❌ 飞书 WS 连接失败，5s 后重试:', err.message);
      setTimeout(startFeishuWS, 5000);
    });
}

startFeishuWS();

// ── API 路由 ──────────────────────────────────────────────────

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const clientId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  sseClients.set(clientId, res);

  res.write(`event: connected\ndata: ${JSON.stringify({ clientId, time: Date.now() })}\n\n`);

  const recent = messageStore.slice(-50);
  if (recent.length > 0) {
    res.write(`event: history\ndata: ${JSON.stringify(recent)}\n\n`);
  }

  const heartbeat = setInterval(() => { res.write(': heartbeat\n\n'); }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(clientId);
    console.log(`[SSE] 客户端 ${clientId} 断开`);
  });
});

app.post('/api/send', async (req, res) => {
  const { chatId, message, msgType = 'text' } = req.body;
  if (!chatId || !message) {
    return res.status(400).json({ ok: false, error: 'chatId 和 message 不能为空' });
  }

  try {
    const content = msgType === 'text'
      ? JSON.stringify({ text: message })
      : JSON.stringify(message);

    const result = await feishuClient.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: msgType, content },
    });

    if (result.code !== 0) throw new Error(result.msg || '发送失败');

    const msgData = {
      id: result.data?.message_id,
      chatId,
      content: { text: message },
      msgType,
      createTime: Date.now().toString(),
      direction: 'outgoing',
    };
    addMessage(msgData);
    broadcastSSE('message', msgData);

    res.json({ ok: true, data: result.data });
  } catch (err) {
    console.error('[发送失败]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/chats', async (req, res) => {
  try {
    const result = await feishuClient.im.chat.list({
      params: { page_size: 50, user_id_type: 'open_id' },
    });
    res.json({ ok: true, data: result.data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, clients: sseClients.size, messages: messageStore.length });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Relay 服务启动: http://localhost:${PORT}`);
  console.log(`📡 SSE 端点: http://localhost:${PORT}/api/events`);
});
