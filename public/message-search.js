(function initMessageSearch(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MessageSearch = api;
}(globalThis, function createMessageSearch() {
  'use strict';

  const labels = Object.freeze({
    all: '全部类型',
    message: '消息',
    file: '文件',
    image: '图片',
    media: '音视频',
    other: '其他',
  });

  function legacyContent(content) {
    if (typeof content !== 'string') return content || {};
    try {
      return JSON.parse(content) || {};
    } catch {
      return {};
    }
  }

  function getMessageType(message) {
    switch (message.msgType) {
      case 'text':
      case 'post': return 'message';
      case 'file': return 'file';
      case 'image':
      case 'sticker': return 'image';
      case 'audio':
      case 'media':
      case 'video': return 'media';
      default: {
        if (message.msgType) return 'other';
        const content = legacyContent(message.content);
        if (content.file_key || content.file_name) return 'file';
        if (content.image_key) return 'image';
        return 'message';
      }
    }
  }

  return { labels, getMessageType };
}));
