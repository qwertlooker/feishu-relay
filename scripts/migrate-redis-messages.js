'use strict';

const fs = require('node:fs');
const { Redis } = require('@upstash/redis');
const { createStorage, KEYS, messageKey } = require('../lib/storage');

function loadCredentials(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(?:"([^"]*)"|'([^']*)'|(.*))$/);
    if (match) values[match[1]] = match[2] ?? match[3] ?? match[4]?.trim();
  }
  if (!values.UPSTASH_REDIS_REST_URL || !values.UPSTASH_REDIS_REST_TOKEN) {
    throw new Error('凭据文件缺少 UPSTASH_REDIS_REST_URL 或 UPSTASH_REDIS_REST_TOKEN');
  }
  return { url: values.UPSTASH_REDIS_REST_URL, token: values.UPSTASH_REDIS_REST_TOKEN };
}

async function audit(redis) {
  const legacy = (await redis.lrange(KEYS.legacyMessages, 0, -1) || []).filter(Boolean);
  const indexedChats = (await redis.smembers(KEYS.messageChats) || []).map(String);
  const counts = {};
  for (const chatId of indexedChats) counts[chatId] = await redis.llen(messageKey(chatId));
  return {
    legacyMessages: legacy.length,
    legacyChats: new Set(legacy.map(message => message?.chatId).filter(Boolean)).size,
    indexedChats: indexedChats.length,
    messageCounts: counts,
    migration: await redis.get(KEYS.migrationV2),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const credentialPath = args.find(arg => !arg.startsWith('--'));
  if (!credentialPath) throw new Error('用法: node scripts/migrate-redis-messages.js <凭据文件> [--dry-run]');
  const redis = new Redis(loadCredentials(credentialPath));
  const before = await audit(redis);
  if (dryRun) {
    console.log(JSON.stringify({ dryRun: true, before }, null, 2));
    return;
  }
  const storage = createStorage(redis, {
    maxMessagesPerChat: Number(process.env.MAX_MESSAGES_PER_CHAT || 500),
    maxChats: Number(process.env.MAX_CHATS || 100),
  });
  const migration = await storage.migrateLegacyMessages();
  const after = await audit(redis);
  console.log(JSON.stringify({ migration, before, after }, null, 2));
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
