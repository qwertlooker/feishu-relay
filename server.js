'use strict';

require('dotenv').config();

const lark = require('@larksuiteoapi/node-sdk');
const { Redis } = require('@upstash/redis');
const { createApp } = require('./app');
const { loadConfig } = require('./lib/config');
const { createEventDispatcher } = require('./lib/feishu-events');
const { createFeishuService } = require('./lib/feishu-service');
const { createSseHub } = require('./lib/sse');
const { createStorage } = require('./lib/storage');

function start() {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    console.error('[配置错误]', error.message);
    process.exitCode = 1;
    return;
  }

  if (!config.apiSecret) {
    console.warn('[安全提示] 未设置 API_SECRET，所有 API 将无需鉴权');
  }

  const redis = new Redis({
    url: config.redisUrl,
    token: config.redisToken,
  });
  const storage = createStorage(redis, {
    maxMessagesPerChat: config.maxMessagesPerChat,
    maxChats: config.maxChats,
  });
  storage.migrateLegacyMessages()
    .then(result => console.log('[Redis] 消息分会话迁移:', result))
    .catch(error => console.error('[Redis] 消息分会话迁移失败，旧数据未删除:', error.message));
  const sseHub = createSseHub();
  const feishuClient = new lark.Client({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
    loggerLevel: lark.LoggerLevel.warn,
  });
  const feishuService = createFeishuService(feishuClient);
  const app = createApp({
    apiSecret: config.apiSecret,
    storage,
    feishuService,
    sseHub,
  });

  const eventDispatcher = createEventDispatcher(lark, {
    encryptKey: config.feishuEncryptKey,
    storage,
    sseHub,
  });
  const wsClient = new lark.WSClient(feishuClient);

  function startFeishuWs() {
    wsClient.start({ eventDispatcher })
      .then(() => console.log('✅ 飞书 WebSocket 长连接已建立'))
      .catch(error => {
        console.error('❌ 飞书 WS 连接失败，5s 后重试:', error.message);
        setTimeout(startFeishuWs, 5000);
      });
  }

  startFeishuWs();
  app.listen(config.port, () => {
    console.log(`🚀 Relay 服务启动: http://localhost:${config.port}`);
    console.log(`📡 SSE 端点: http://localhost:${config.port}/api/events`);
  });
}

if (require.main === module) start();

module.exports = { start };
