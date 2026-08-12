'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const { version: packageVersion } = require('./package.json');
const { normalizeError } = require('./lib/error');
const {
  FEISHU_TEXT_MAX_BYTES,
  getSerializedTextBytes,
  normalizeOutgoingMessage,
} = require('./lib/messages');
const { resolveRecipient } = require('./lib/recipient');
const { persistMessage } = require('./lib/feishu-events');

function createAuthMiddleware(apiSecret) {
  return function authMiddleware(req, res, next) {
    if (!apiSecret) return next();
    const clientToken = req.query.token || req.headers['x-api-key'];
    if (clientToken !== apiSecret) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    next();
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function decodeFileName(value) {
  try {
    return decodeURIComponent(String(value || '')).replace(/[\\/\0-\x1f]/g, '_').slice(0, 255);
  } catch {
    return '';
  }
}

function getUploadFileType(kind, mimeType, fileName) {
  if (kind === 'image') return undefined;
  const mime = String(mimeType || '').toLowerCase();
  const name = String(fileName || '').toLowerCase();
  if (mime === 'audio/ogg' || mime === 'audio/opus' || name.endsWith('.opus')) return 'opus';
  if (mime === 'video/mp4' || name.endsWith('.mp4')) return 'mp4';
  const extension = name.split('.').pop();
  return ['pdf', 'doc', 'xls', 'ppt'].includes(extension) ? extension : 'stream';
}

function getHeader(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name) || undefined;
  return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()];
}

function getDownloadDisposition(fileName) {
  const safeName = decodeFileName(fileName) || 'download';
  const asciiName = safeName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`;
}

function createApp({
  apiSecret = '',
  storage,
  feishuService,
  sseHub,
  logger = console,
  publicDir = path.join(__dirname, 'public'),
  appVersion = packageVersion,
}) {
  if (!storage || !feishuService || !sseHub) {
    throw new TypeError('storage、feishuService 和 sseHub 均为必需依赖');
  }

  const app = express();
  const authMiddleware = createAuthMiddleware(apiSecret);
  app.use(cors());
  app.use(express.json({ limit: '5mb' }));
  app.use(express.static(publicDir));

  app.post(
    '/api/upload',
    authMiddleware,
    express.raw({ type: 'application/octet-stream', limit: '30mb' }),
    async (req, res) => {
      const kind = req.query.kind;
      const fileName = decodeFileName(req.headers['x-file-name']);
      const mimeType = String(req.headers['x-file-type'] || '');
      if (kind !== 'image' && kind !== 'file') {
        return res.status(400).json({ ok: false, error: 'kind 必须是 image 或 file' });
      }
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ ok: false, error: '上传文件不能为空' });
      }
      if (kind === 'image' && req.body.length > 10 * 1024 * 1024) {
        return res.status(413).json({ ok: false, error: '图片不能超过 10 MB' });
      }
      if (kind === 'file' && !fileName) {
        return res.status(400).json({ ok: false, error: '文件名不能为空' });
      }

      try {
        const resource = await feishuService.uploadResource({
          kind,
          buffer: req.body,
          fileName: fileName || 'image',
          fileType: getUploadFileType(kind, mimeType, fileName),
        });
        const content = resource.msgType === 'image'
          ? { image_key: resource.key }
          : { file_key: resource.key };
        res.json({
          ok: true,
          msgType: resource.msgType,
          content,
          ...(resource.msgType !== 'image' ? { fileName } : {}),
        });
      } catch (error) {
        logger.error('[上传失败]', error);
        res.status(502).json({ ok: false, ...normalizeError(error) });
      }
    },
  );

  app.get('/api/events', authMiddleware, async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const clientId = sseHub.add(res);
    res.write(`event: connected\ndata: ${JSON.stringify({
      clientId,
      time: Date.now(),
      version: appVersion,
    })}\n\n`);

    try {
      const recent = await storage.getRecentMessages(50);
      logger.log(`[SSE] 发送 ${recent.length} 条历史消息给 ${clientId}`);
      if (recent.length) {
        res.write(`event: history\ndata: ${JSON.stringify(recent)}\n\n`);
      }
    } catch (error) {
      logger.error('[Redis] getRecentMessages 失败', error);
    }

    const heartbeat = setInterval(() => {
      try { res.write(': heartbeat\n\n'); } catch { /* close 事件负责清理 */ }
    }, 25000);

    req.on('close', () => {
      clearInterval(heartbeat);
      sseHub.remove(clientId);
      logger.log(`[SSE] 客户端 ${clientId} 断开`);
    });
  });

  app.post('/api/send', authMiddleware, async (req, res) => {
    const {
      chatId,
      message,
      msgType = 'text',
      receiveIdType,
      replyTo,
      replyInThread = false,
      replyPreview,
      fileName,
    } = req.body || {};
    if (!chatId || message === undefined || message === null || message === '') {
      return res.status(400).json({ ok: false, error: 'chatId 和 message 不能为空' });
    }
    if (msgType === 'text') {
      const messageBytes = getSerializedTextBytes(message);
      if (messageBytes > FEISHU_TEXT_MAX_BYTES) {
        return res.status(413).json({
          ok: false,
          error: `文本消息序列化后为 ${(messageBytes / 1024).toFixed(1)} KB，超过飞书单条 150 KB 限制`,
          hint: '请使用网页端确认自动分段，或自行缩短消息后重试。',
        });
      }
    }

    let recipient;
    try {
      recipient = resolveRecipient(chatId, receiveIdType);
    } catch (error) {
      return res.status(400).json({ ok: false, error: error.message });
    }

    try {
      const { result, content } = await feishuService.sendMessage({
        recipient,
        message,
        msgType,
        replyTo,
        replyInThread,
      });
      const messageData = normalizeOutgoingMessage({
        result,
        recipient,
        content,
        msgType,
        replyPreview: typeof replyPreview === 'string' ? replyPreview.slice(0, 200) : undefined,
      });
      if (['file', 'audio', 'media'].includes(msgType) && typeof fileName === 'string') {
        messageData.content.file_name = fileName.slice(0, 255);
      }
      await persistMessage(storage, messageData, logger);
      sseHub.broadcast('message', messageData);
      res.json({
        ok: true,
        data: result.data,
        recipient: { id: recipient.id, receiveIdType: recipient.receiveIdType },
      });
    } catch (error) {
      logger.error('[发送失败]', error);
      res.status(502).json({ ok: false, ...normalizeError(error) });
    }
  });

  app.get('/api/messages/search', authMiddleware, async (req, res) => {
    const query = String(req.query.q || '').trim();
    if (!query) {
      return res.status(400).json({ ok: false, error: '搜索关键词不能为空' });
    }
    if (query.length > 200) {
      return res.status(400).json({ ok: false, error: '搜索关键词不能超过 200 个字符' });
    }
    try {
      const items = await storage.searchMessages(query, {
        chatId: req.query.chatId ? String(req.query.chatId) : undefined,
        limit: req.query.limit,
      });
      res.json({ ok: true, data: { items, count: items.length } });
    } catch (error) {
      logger.error('[消息搜索失败]', error);
      res.status(500).json({ ok: false, error: '搜索消息失败，请稍后重试' });
    }
  });

  app.delete('/api/messages/:messageId', authMiddleware, async (req, res) => {
    try {
      await feishuService.withdrawMessage(req.params.messageId);
      const message = await storage.markMessageDeleted(req.params.messageId);
      const event = { messageId: req.params.messageId, message };
      sseHub.broadcast('message_deleted', event);
      res.json({ ok: true, data: event });
    } catch (error) {
      logger.error('[撤回失败]', error);
      res.status(502).json({ ok: false, ...normalizeError(error) });
    }
  });

  app.get(
    '/api/messages/:messageId/resources/:fileKey',
    authMiddleware,
    async (req, res) => {
      const type = String(req.query.type || 'file');
      if (!['image', 'file', 'audio', 'media'].includes(type)) {
        return res.status(400).json({ ok: false, error: '不支持的资源类型' });
      }
      try {
        const resource = await feishuService.getMessageResource({
          messageId: req.params.messageId,
          fileKey: req.params.fileKey,
          type,
        });
        const headers = resource.headers || {};
        const contentType = getHeader(headers, 'content-type')
          || (type === 'image' ? 'image/jpeg'
            : type === 'audio' ? 'audio/ogg'
              : type === 'media' ? 'video/mp4' : 'application/octet-stream');
        res.setHeader(
          'Content-Type',
          contentType,
        );
        const contentLength = getHeader(headers, 'content-length');
        const disposition = getHeader(headers, 'content-disposition');
        if (contentLength) res.setHeader('Content-Length', contentLength);
        if (type === 'file') {
          res.setHeader(
            'Content-Disposition',
            req.query.name ? getDownloadDisposition(req.query.name) : disposition || 'attachment',
          );
        }
        const stream = resource.getReadableStream();
        stream.on('error', error => {
          logger.error('[资源下载失败]', error);
          if (!res.headersSent) res.status(502).end();
          else res.destroy(error);
        });
        stream.pipe(res);
      } catch (error) {
        logger.error('[资源下载失败]', error);
        if (!res.headersSent) res.status(502).json({ ok: false, ...normalizeError(error) });
      }
    },
  );

  app.get('/api/convs', authMiddleware, async (req, res) => {
    try {
      const data = await storage.getConversations();
      res.json({ ok: true, data });
    } catch (error) {
      logger.error('[API] GET /api/convs 错误:', error);
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post('/api/convs', authMiddleware, async (req, res) => {
    if (!Array.isArray(req.body)) {
      return res.status(400).json({ ok: false, error: '会话列表必须是数组' });
    }
    try {
      await storage.saveConversations(req.body);
      res.json({ ok: true });
    } catch (error) {
      logger.error('[API] POST /api/convs 错误:', error);
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get('/api/drafts', authMiddleware, async (req, res) => {
    try {
      res.json({ ok: true, data: await storage.getDrafts() });
    } catch (error) {
      logger.error('[API] GET /api/drafts 错误:', error);
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post('/api/drafts', authMiddleware, async (req, res) => {
    if (!isPlainObject(req.body)) {
      return res.status(400).json({ ok: false, error: '草稿数据必须是对象' });
    }
    try {
      await storage.saveDrafts(req.body);
      res.json({ ok: true });
    } catch (error) {
      logger.error('[API] POST /api/drafts 错误:', error);
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get('/api/settings', authMiddleware, async (req, res) => {
    try {
      res.json({ ok: true, data: await storage.getSettings() });
    } catch (error) {
      logger.error('[API] GET /api/settings 错误:', error);
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post('/api/settings', authMiddleware, async (req, res) => {
    if (!isPlainObject(req.body)) {
      return res.status(400).json({ ok: false, error: '设置数据必须是对象' });
    }
    try {
      await storage.saveSettings(req.body);
      res.json({ ok: true });
    } catch (error) {
      logger.error('[API] POST /api/settings 错误:', error);
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get('/api/chats', authMiddleware, async (req, res) => {
    try {
      const result = await feishuService.listChats();
      res.json({ ok: true, data: result.data });
    } catch (error) {
      logger.error('[API] GET /api/chats 错误:', error);
      res.status(502).json({ ok: false, ...normalizeError(error) });
    }
  });

  app.get('/api/health', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, clients: sseHub.size, version: appVersion });
  });

  app.use((error, req, res, next) => {
    if (error?.type === 'entity.too.large') {
      const isUpload = req.path === '/api/upload';
      return res.status(413).json({
        ok: false,
        error: isUpload ? '上传内容超过 30 MB' : '请求内容过大，JSON 请求体不能超过 5 MB',
      });
    }
    next(error);
  });

  return app;
}

module.exports = {
  createApp,
  createAuthMiddleware,
  decodeFileName,
  getDownloadDisposition,
  getUploadFileType,
  isPlainObject,
};
