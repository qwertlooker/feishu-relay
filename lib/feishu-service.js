'use strict';

const { createFeishuError } = require('./error');
const { serializeMessageContent } = require('./messages');

function ensureSuccess(result) {
  if (result?.code !== undefined && Number(result.code) !== 0) {
    throw createFeishuError(result);
  }
  return result;
}

function createFeishuService(client) {
  if (!client) throw new TypeError('飞书客户端不能为空');

  return {
    async sendMessage({ recipient, message, msgType = 'text', replyTo, replyInThread = false }) {
      const content = serializeMessageContent(message, msgType);
      const result = replyTo
        ? ensureSuccess(await client.im.message.reply({
          path: { message_id: replyTo },
          data: {
            msg_type: msgType,
            content,
            reply_in_thread: Boolean(replyInThread),
          },
        }))
        : ensureSuccess(await client.im.message.create({
          params: { receive_id_type: recipient.receiveIdType },
          data: {
            receive_id: recipient.id,
            msg_type: msgType,
            content,
          },
        }));
      return { result, content };
    },

    async uploadResource({ kind, buffer, fileName }) {
      if (kind === 'image') {
        const result = await client.im.image.create({
          data: { image_type: 'message', image: buffer },
        });
        if (!result?.image_key) throw new Error('飞书未返回 image_key');
        return { key: result.image_key, msgType: 'image' };
      }

      const result = await client.im.file.create({
        data: {
          file_type: 'stream',
          file_name: fileName,
          file: buffer,
        },
      });
      if (!result?.file_key) throw new Error('飞书未返回 file_key');
      return { key: result.file_key, msgType: 'file' };
    },

    async getMessageResource({ messageId, fileKey, type }) {
      return client.im.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type },
      });
    },

    async withdrawMessage(messageId) {
      return ensureSuccess(await client.im.message.delete({
        path: { message_id: messageId },
      }));
    },

    async listChats() {
      return ensureSuccess(await client.im.chat.list({
        params: { page_size: 50, user_id_type: 'open_id' },
      }));
    },
  };
}

module.exports = { createFeishuService, ensureSuccess };
