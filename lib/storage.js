'use strict';

const { getMessageSearchText } = require('./messages');

const KEYS = Object.freeze({
  legacyMessages: 'feishu:messages',
  messageChats: 'feishu:message_chats',
  migrationV2: 'feishu:messages:migration:v2',
  conversations: 'feishu:convs',
  drafts: 'feishu:drafts',
  settings: 'feishu:settings',
});

class StorageLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StorageLimitError';
    this.code = 'STORAGE_LIMIT';
  }
}

function messageKey(chatId) {
  const value = String(chatId || '').trim();
  if (!value) throw new TypeError('消息必须包含 chatId');
  return `feishu:messages:${encodeURIComponent(value)}`;
}

function safeLimit(value, fallback, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function createStorage(redis, { maxMessagesPerChat = 500, maxChats = 100 } = {}) {
  if (!redis) throw new TypeError('redis 客户端不能为空');

  const messageLimit = safeLimit(maxMessagesPerChat, 500, 10000);
  const chatLimit = safeLimit(maxChats, 100, 1000);

  async function getMessageChats() {
    const chats = await redis.smembers(KEYS.messageChats);
    return (chats || []).filter(Boolean).map(String);
  }

  async function ensureChat(chatId) {
    const chats = await getMessageChats();
    if (chats.includes(chatId)) return;
    if (chats.length >= chatLimit) throw new StorageLimitError(`会话数量已达到上限 ${chatLimit}`);
    await redis.sadd(KEYS.messageChats, chatId);
  }

  return {
    maxMessagesPerChat: messageLimit,
    maxChats: chatLimit,

    async addMessage(message) {
      const chatId = String(message?.chatId || '').trim();
      if (!chatId) throw new TypeError('消息必须包含 chatId');
      await ensureChat(chatId);
      const key = messageKey(chatId);
      await redis.rpush(key, message);
      await redis.ltrim(key, -messageLimit, -1);
    },

    async getRecentMessages(chatId, count = 50) {
      const safeCount = safeLimit(count, 50, messageLimit);
      const messages = await redis.lrange(messageKey(chatId), -safeCount, -1);
      return (messages || []).filter(message => message !== null);
    },

    async getMessages(chatId, { limit = 50, before } = {}) {
      const count = safeLimit(limit, 50, 100);
      const messages = (await redis.lrange(messageKey(chatId), 0, -1) || []).filter(Boolean);
      let end = messages.length;
      if (before) {
        const index = messages.findIndex(message => message?.id === before);
        if (index >= 0) end = index;
      }
      const start = Math.max(0, end - count);
      return {
        items: messages.slice(start, end),
        hasMore: start > 0,
        nextBefore: start > 0 ? messages[start]?.id : undefined,
      };
    },

    async searchMessages(query, { chatId, limit = 50 } = {}) {
      const normalizedQuery = String(query || '').trim().toLocaleLowerCase();
      if (!normalizedQuery) return [];
      const count = safeLimit(limit, 50, 100);
      const chatIds = chatId ? [String(chatId)] : await getMessageChats();
      const groups = await Promise.all(chatIds.map(id => redis.lrange(messageKey(id), 0, -1)));
      return groups.flat()
        .filter(Boolean)
        .filter(message => getMessageSearchText(message).toLocaleLowerCase().includes(normalizedQuery))
        .sort((a, b) => Number(b.createTime || 0) - Number(a.createTime || 0))
        .slice(0, count);
    },

    async markMessageDeleted(messageId, chatId) {
      const chatIds = chatId ? [String(chatId)] : await getMessageChats();
      for (const id of chatIds) {
        const key = messageKey(id);
        const messages = await redis.lrange(key, 0, -1) || [];
        const index = messages.findIndex(message => message?.id === messageId);
        if (index < 0) continue;
        const updated = { ...messages[index], deleted: true, content: { text: '[消息已撤回]' } };
        await redis.lset(key, index, updated);
        return updated;
      }
      return null;
    },

    async migrateLegacyMessages() {
      const legacy = (await redis.lrange(KEYS.legacyMessages, 0, -1) || []).filter(message => message?.chatId);
      if (!legacy.length) {
        await redis.set(KEYS.migrationV2, { completedAt: Date.now(), messages: 0, chats: 0 });
        return { migrated: false, reason: 'empty', messages: 0, chats: 0 };
      }
      const grouped = new Map();
      for (const message of legacy) {
        const chatId = String(message.chatId);
        if (!grouped.has(chatId)) grouped.set(chatId, []);
        grouped.get(chatId).push(message);
      }
      const existingChats = await getMessageChats();
      const newChats = [...grouped.keys()].filter(id => !existingChats.includes(id));
      if (existingChats.length + newChats.length > chatLimit) {
        throw new StorageLimitError(`旧消息会话数超过上限 ${chatLimit}`);
      }
      let migratedMessages = 0;
      for (const [chatId, messages] of grouped) {
        await ensureChat(chatId);
        const key = messageKey(chatId);
        const existing = await redis.lrange(key, 0, -1) || [];
        const signatures = new Set(existing.map(message => message?.id || JSON.stringify(message)));
        const additions = messages.filter(message => !signatures.has(message.id || JSON.stringify(message)));
        if (!additions.length) continue;
        await redis.rpush(key, ...additions);
        await redis.ltrim(key, -messageLimit, -1);
        migratedMessages += additions.length;
      }
      const result = { completedAt: Date.now(), messages: migratedMessages, chats: grouped.size };
      await redis.set(KEYS.migrationV2, result);
      return { migrated: migratedMessages > 0, ...result };
    },

    async getConversations() {
      const value = await redis.get(KEYS.conversations);
      return Array.isArray(value) ? value.slice(0, chatLimit) : [];
    },

    async saveConversations(conversations) {
      if (conversations.length > chatLimit) throw new StorageLimitError(`会话数量不能超过 ${chatLimit}`);
      await redis.set(KEYS.conversations, conversations);
    },

    async getDrafts() {
      const value = await redis.get(KEYS.drafts);
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    },

    async saveDrafts(drafts) {
      await redis.set(KEYS.drafts, drafts);
    },

    async getSettings() {
      const value = await redis.get(KEYS.settings);
      return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : { theme: 'system' };
    },

    async saveSettings(settings) {
      await redis.set(KEYS.settings, settings);
    },
  };
}

module.exports = { createStorage, KEYS, messageKey, StorageLimitError };
