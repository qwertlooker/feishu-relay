'use strict';

const { normalizeIncomingMessage } = require('./messages');

async function persistMessage(storage, message, logger = console) {
  try {
    await storage.addMessage(message);
  } catch (error) {
    logger.error('[Redis] addMessage 失败', error);
  }
}

function createEventDispatcher(lark, { encryptKey = '', storage, sseHub, logger = console }) {
  return new lark.EventDispatcher({ encryptKey }).register({
    'im.message.receive_v1': async data => {
      const message = normalizeIncomingMessage(data);
      logger.log(`[飞书] 收到消息 from ${message.senderId} in ${message.chatId}`);
      await persistMessage(storage, message, logger);
      sseHub.broadcast('message', message);
    },

    'im.message.message_read_v1': async data => {
      const { reader, message_id_list: messageIds } = data;
      const receipt = {
        readerId: reader?.reader_id?.open_id,
        messageIds: messageIds || [],
        readTime: reader?.read_time,
        tenantKey: reader?.tenant_key,
      };
      logger.log(`[飞书] 已读回执 reader=${receipt.readerId} msgs=${receipt.messageIds.join(',')}`);
      sseHub.broadcast('read', receipt);
    },
  });
}

module.exports = { createEventDispatcher, persistMessage };
