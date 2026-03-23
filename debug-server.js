require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const lark = require('@larksuiteoapi/node-sdk');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

console.log('=== 调试版本启动 ===');
console.log('App ID:', process.env.FEISHU_APP_ID ? process.env.FEISHU_APP_ID.substring(0, 10) + '...' : 'NOT SET');
console.log('App Secret:', process.env.FEISHU_APP_SECRET ? '***SET***' : 'NOT SET');
console.log('');

// ── 调试用的飞书客户端 ──────────────────────────────────────────
const feishuClient = new lark.Client({
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
  loggerLevel: lark.LoggerLevel.debug, // 改为 debug 级别
});

// ── 事件分发器（调试版）────────────────────────────────────────────
const eventDispatcher = new lark.EventDispatcher({
  encryptKey: process.env.FEISHU_ENCRYPT_KEY || '',
}).register({
  // 捕获所有事件
  '*': async (data) => {
    console.log('\n=== 收到事件 ===');
    console.log('原始数据:', JSON.stringify(data, null, 2));
  },
  // 收到消息事件
  'im.message.receive_v1': async (data) => {
    console.log('\n=== 收到消息事件 ===');
    const { message, sender } = data;
    console.log(`[飞书] 收到消息 from ${sender?.sender_id?.open_id} in ${message.chat_id}`);

    let content;
    try { content = JSON.parse(message.content); }
    catch { content = { text: message.content }; }

    console.log('消息内容:', content);
  },
});

// ── 启动 WebSocket 长连接（调试版）────────────────────────────────────
const wsClient = new lark.WSClient(feishuClient);

function startFeishuWS() {
  console.log('\n=== 尝试连接飞书 WebSocket ===');
  wsClient.start({ eventDispatcher })
    .then(() => {
      console.log('✅ 飞书 WebSocket 长连接已建立');
    })
    .catch((err) => {
      console.error('❌ 飞书 WS 连接失败:', err);
      console.error('错误详情:', JSON.stringify(err, null, 2));
      console.log('5s 后重试...');
      setTimeout(startFeishuWS, 5000);
    });
}

startFeishuWS();

// ── 简单的测试路由 ──────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ ok: true, status: 'debug mode' });
});

// ── 启动服务器 ────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 调试服务器启动: http://localhost:${PORT}`);
  console.log('现在请在飞书中给机器人发消息...');
});
