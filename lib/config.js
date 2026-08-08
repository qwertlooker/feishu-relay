'use strict';

const REQUIRED_ENV = [
  'FEISHU_APP_ID',
  'FEISHU_APP_SECRET',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
];

function loadConfig(env = process.env) {
  const missing = REQUIRED_ENV.filter(name => !String(env[name] || '').trim());
  if (missing.length) {
    throw new Error(`缺少必需环境变量: ${missing.join(', ')}`);
  }

  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT 必须是 1-65535 之间的整数，当前值: ${env.PORT}`);
  }

  return Object.freeze({
    apiSecret: String(env.API_SECRET || ''),
    feishuAppId: String(env.FEISHU_APP_ID),
    feishuAppSecret: String(env.FEISHU_APP_SECRET),
    feishuEncryptKey: String(env.FEISHU_ENCRYPT_KEY || ''),
    redisUrl: String(env.UPSTASH_REDIS_REST_URL),
    redisToken: String(env.UPSTASH_REDIS_REST_TOKEN),
    port,
  });
}

module.exports = { loadConfig, REQUIRED_ENV };
