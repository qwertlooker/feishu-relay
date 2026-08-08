'use strict';

const FEISHU_TEXT_MAX_BYTES = 150 * 1024;

function getSerializedTextBytes(message) {
  return Buffer.byteLength(JSON.stringify({ text: String(message) }), 'utf8');
}

function parseContent(content) {
  if (content && typeof content === 'object') return content;
  try {
    return JSON.parse(content);
  } catch {
    return { text: String(content || '') };
  }
}

function getPostSearchText(content) {
  if (!content || typeof content !== 'object') return '';
  const post = Array.isArray(content.content)
    ? content
    : content.zh_cn || content.en_us || content.zh_hk || content.zh_tw
      || Object.values(content).find(value => value && Array.isArray(value.content));
  if (!post || !Array.isArray(post.content)) return '';
  const body = post.content.flat().map(item => {
    if (!item || typeof item !== 'object') return '';
    return item.text || item.name || item.user_name || '';
  });
  return [post.title, ...body].filter(Boolean).join(' ');
}

function getMessageSearchText(message) {
  if (!message || message.deleted) return '';
  const content = parseContent(message.content);
  return [
    content.text,
    content.file_name,
    getPostSearchText(content),
    message.replyPreview,
  ].filter(value => typeof value === 'string' && value).join(' ');
}

function getPostSearchText(content) {
  if (!content || typeof content !== 'object') return '';
  const post = Array.isArray(content.content)
    ? content
    : content.zh_cn || content.en_us || content.zh_hk || content.zh_tw
      || Object.values(content).find(value => value && Array.isArray(value.content));
  if (!post || !Array.isArray(post.content)) return '';
  const body = post.content.flat().map(item => {
    if (!item || typeof item !== 'object') return '';
    return item.text || item.name || item.user_name || '';
  });
  return [post.title, ...body].filter(Boolean).join(' ');
}

function getMessageSearchText(message) {
  if (!message || message.deleted) return '';
  const content = parseContent(message.content);
  return [
    content.text,
    content.file_name,
    getPostSearchText(content),
    message.replyPreview,
  ].filter(value => typeof value === 'string' && value).join(' ');
}

function normalizeIncomingMessage(data) {
  const { message, sender } = data;
  return {
    id: message.message_id,
    rootId: message.root_id,
    parentId: message.parent_id,
    threadId: message.thread_id,
    chatId: message.chat_id,
    chatType: message.chat_type,
    senderId: sender?.sender_id?.open_id,
    senderType: sender?.sender_type,
    content: parseContent(message.content),
    msgType: message.message_type,
    createTime: message.create_time,
    mentions: message.mentions || [],
    deleted: Boolean(message.deleted),
    direction: 'incoming',
  };
}

function normalizeOutgoingMessage({ result, recipient, content, msgType, replyPreview }) {
  return {
    id: result.data?.message_id,
    rootId: result.data?.root_id,
    parentId: result.data?.parent_id,
    threadId: result.data?.thread_id,
    chatId: recipient.id,
    receiveIdType: recipient.receiveIdType,
    content: parseContent(content),
    msgType,
    createTime: result.data?.create_time || Date.now().toString(),
    replyPreview: replyPreview || undefined,
    direction: 'outgoing',
  };
}

function serializeMessageContent(message, msgType = 'text') {
  return msgType === 'text'
    ? JSON.stringify({ text: String(message) })
    : JSON.stringify(message);
}

module.exports = {
  FEISHU_TEXT_MAX_BYTES,
  getSerializedTextBytes,
  getMessageSearchText,
  getMessageSearchText,
  normalizeIncomingMessage,
  normalizeOutgoingMessage,
  parseContent,
  serializeMessageContent,
};
