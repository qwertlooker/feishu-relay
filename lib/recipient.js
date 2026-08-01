'use strict';

const RECEIVE_ID_TYPES = new Set([
  'chat_id',
  'open_id',
  'user_id',
  'union_id',
  'email',
]);

function resolveRecipient(receiveId, requestedType) {
  const id = typeof receiveId === 'string' ? receiveId.trim() : '';
  if (!id) {
    throw new TypeError('接收 ID 不能为空');
  }

  if (requestedType && !RECEIVE_ID_TYPES.has(requestedType)) {
    throw new TypeError(`不支持的 receiveIdType: ${requestedType}`);
  }

  let receiveIdType = requestedType;
  if (!receiveIdType) {
    if (id.startsWith('ou_')) receiveIdType = 'open_id';
    else if (id.startsWith('on_')) receiveIdType = 'union_id';
    else receiveIdType = 'chat_id';
  }

  return { id, receiveIdType };
}

module.exports = { resolveRecipient };
