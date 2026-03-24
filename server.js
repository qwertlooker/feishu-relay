require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const lark = require('@larksuiteoapi/node-sdk');

const API_SECRET = process.env.API_SECRET;
const USE_AUTH = !!API_SECRET;

function authMiddleware(req, res, next) {
  if (!USE_AUTH) return next();
  const queryToken = req.query.token;
  const headerToken = req.headers['x-api-key'];
  const clientToken = queryToken || headerToken;
  if (clientToken !== API_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── 数据存储（Redis 可选，无 Redis 时用内存） ─────────────────
let redis = null;
let USE_REDIS = false;
const messageStore = [];
const MAX_MESSAGES = 500;

// 内存存储（用于无 Redis 时）
let inMemoryConvs = [];
let inMemoryDrafts = {};
let inMemorySettings = { theme: 'system' };

try {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    const { Redis } = require('@upstash/redis');
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    USE_REDIS = true;
    console.log('[Redis] 已连接 Upstash Redis');
  }
} catch (err) {
  console.warn('[Redis] Redis 不可用，使用内存存储');
}

async function addMessage(msg) {
  if (USE_REDIS) {
    try {
      await redis.rpush('feishu:messages', JSON.stringify(msg));
      await redis.ltrim('feishu:messages', -MAX_MESSAGES, -1);
    } catch (err) {
      console.error('[Redis] addMessage 失败', err);
    }
  } else {
    messageStore.push(msg);
    if (messageStore.length > MAX_MESSAGES) messageStore.shift();
  }
}

async function getRecentMessages(count = 50) {
  if (USE_REDIS) {
    try {
      const msgs = await redis.lrange('feishu:messages', -count, -1);
      return msgs.map(m => typeof m === 'string' ? JSON.parse(m) : m);
    } catch (err) {
      console.error('[Redis] getRecentMessages 失败', err);
      return [];
    }
  } else {
    return messageStore.slice(-count);
  }
}

// ── SSE 客户端注册表 ──────────────────────────────────────────
const sseClients = new Map();

// ── 广播函数保持不变 ───────────────────────────────────────────
function broadcastSSE(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach((res, id) => {
    try { res.write(payload); }
    catch { sseClients.delete(id); }
  });
}

// ── 飞书客户端初始化（保持不变） ───────────────────────────────
const feishuClient = new lark.Client({
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
  loggerLevel: lark.LoggerLevel.warn,
});

const eventDispatcher = new lark.EventDispatcher({
  encryptKey: process.env.FEISHU_ENCRYPT_KEY || '',
}).register({

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

    await addMessage(msgData);        // ← 改成 await
    broadcastSSE('message', msgData);
  },

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

// WebSocket 长连接启动（保持不变）
const wsClient = new lark.WSClient(feishuClient);

function startFeishuWS() {
  wsClient.start({ eventDispatcher })
    .then(() => console.log('✅ 飞书 WebSocket 长连接已建立'))
    .catch((err) => {
      console.error('❌ 飞书 WS 连接失败，5s 后重试:', err.message);
      setTimeout(startFeishuWS, 5000);
    });
}
startFeishuWS();

// ── API 路由 ──────────────────────────────────────────────────

app.get('/api/events', authMiddleware, async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const clientId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  sseClients.set(clientId, res);

  res.write(`event: connected\ndata: ${JSON.stringify({ clientId, time: Date.now() })}\n\n`);

  // 加载历史消息（从 Upstash 读取）
  const recent = await getRecentMessages(50);
  console.log(`[SSE] 发送 ${recent.length} 条历史消息给 ${clientId}`);
  if (recent.length > 0) {
    console.log(`[SSE] 历史消息示例:`, JSON.stringify(recent[0]).substring(0, 200));
    res.write(`event: history\ndata: ${JSON.stringify(recent)}\n\n`);
  }

  const heartbeat = setInterval(() => { res.write(': heartbeat\n\n'); }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(clientId);
    console.log(`[SSE] 客户端 ${clientId} 断开`);
  });
});

app.post('/api/send', authMiddleware, async (req, res) => {
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

    await addMessage(msgData);        // ← 改成 await
    broadcastSSE('message', msgData);

    res.json({ ok: true, data: result.data });
  } catch (err) {
    console.error('[发送失败]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 会话列表存储 API
app.get('/api/convs', authMiddleware, async (req, res) => {
  try {
    if (USE_REDIS) {
      const data = await redis.get('feishu:convs');
      res.json({ ok: true, data: data ? JSON.parse(data) : [] });
    } else {
      res.json({ ok: true, data: inMemoryConvs });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/convs', authMiddleware, async (req, res) => {
  try {
    if (USE_REDIS) {
      await redis.set('feishu:convs', JSON.stringify(req.body));
    } else {
      inMemoryConvs = req.body;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 草稿存储 API
app.get('/api/drafts', authMiddleware, async (req, res) => {
  try {
    if (USE_REDIS) {
      const data = await redis.get('feishu:drafts');
      res.json({ ok: true, data: data ? JSON.parse(data) : {} });
    } else {
      res.json({ ok: true, data: inMemoryDrafts });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/drafts', authMiddleware, async (req, res) => {
  try {
    if (USE_REDIS) {
      await redis.set('feishu:drafts', JSON.stringify(req.body));
    } else {
      inMemoryDrafts = req.body;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 主题设置 API
app.get('/api/settings', authMiddleware, async (req, res) => {
  try {
    if (USE_REDIS) {
      const data = await redis.get('feishu:settings');
      res.json({ ok: true, data: data ? JSON.parse(data) : { theme: 'system' } });
    } else {
      res.json({ ok: true, data: inMemorySettings });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/settings', authMiddleware, async (req, res) => {
  try {
    if (USE_REDIS) {
      await redis.set('feishu:settings', JSON.stringify(req.body));
    } else {
      inMemorySettings = req.body;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 其他路由（/api/chats、/api/health）保持不变
app.get('/api/chats', authMiddleware, async (req, res) => {
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
  res.json({ ok: true, clients: sseClients.size });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Relay 服务启动: http://localhost:${PORT}`);
  console.log(`📡 SSE 端点: http://localhost:${PORT}/api/events`);
});
