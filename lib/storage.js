'use strict';

const KEYS = Object.freeze({
  messages: 'feishu:messages',
  conversations: 'feishu:convs',
  drafts: 'feishu:drafts',
  settings: 'feishu:settings',
});

function createStorage(redis, { maxMessages = 500 } = {}) {
  if (!redis) throw new TypeError('redis 客户端不能为空');

  return {
    async addMessage(message) {
      await redis.rpush(KEYS.messages, message);
      await redis.ltrim(KEYS.messages, -maxMessages, -1);
    },

    async getRecentMessages(count = 50) {
      const safeCount = Math.max(1, Math.min(Number(count) || 50, maxMessages));
      const messages = await redis.lrange(KEYS.messages, -safeCount, -1);
      return (messages || []).filter(message => message !== null);
    },

    async markMessageDeleted(messageId) {
      const messages = await redis.lrange(KEYS.messages, 0, -1);
      const index = (messages || []).findIndex(message => message?.id === messageId);
      if (index < 0) return null;
      const updated = {
        ...messages[index],
        deleted: true,
        content: { text: '[消息已撤回]' },
      };
      await redis.lset(KEYS.messages, index, updated);
      return updated;
    },

    async getConversations() {
      const value = await redis.get(KEYS.conversations);
      return Array.isArray(value) ? value : [];
    },

    async saveConversations(conversations) {
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

module.exports = { createStorage, KEYS };
