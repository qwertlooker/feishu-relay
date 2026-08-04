'use strict';

const FEISHU_ERROR_HINTS = {
  230002: '请先将机器人加入目标群。',
  230006: '请在飞书开发者后台启用机器人能力，并发布应用版本。',
  230013: '请确认目标用户在机器人的可用范围内。',
  230027: '请检查应用权限，并发布包含新权限的应用版本。',
  230034: '请检查 receive_id 与 receive_id_type 是否匹配。',
  230035: '请检查群禁言、机器人屏蔽或租户沟通权限限制。',
  230038: '飞书不允许通过此接口发送跨租户单聊。',
  230053: '目标用户已关闭接收机器人消息。',
};

function firstDefined(...values) {
  return values.find(value => value !== undefined && value !== null && value !== '');
}

function getPayload(error) {
  const candidates = [
    error?.response?.data,
    error?.response?.body,
    error?.rawResponse?.data,
    error?.data,
    error?.body,
    error,
  ];
  return candidates.find(value => value && typeof value === 'object') || {};
}

function asMessage(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    return firstDefined(value.msg, value.message, value.detail, value.description);
  }
  return undefined;
}

function normalizeError(error) {
  const payload = getPayload(error);
  const nested = payload.error && typeof payload.error === 'object' ? payload.error : {};
  const code = firstDefined(
    error?.feishuCode,
    payload.code,
    nested.code,
    error?.code,
    error?.response?.status,
  );
  const message = firstDefined(
    error?.feishuMessage,
    asMessage(payload.msg),
    asMessage(payload.message),
    asMessage(payload.error),
    asMessage(error?.msg),
    asMessage(error?.message),
  ) || '发送消息失败，请查看错误码和处理建议。';
  const requestId = firstDefined(
    payload.request_id,
    payload.requestId,
    error?.requestId,
    error?.response?.headers?.['x-tt-logid'],
  );
  const numericCode = Number(code);

  return {
    error: message,
    ...(code !== undefined ? { code } : {}),
    ...(FEISHU_ERROR_HINTS[numericCode] ? { hint: FEISHU_ERROR_HINTS[numericCode] } : {}),
    ...(requestId ? { requestId } : {}),
  };
}

function createFeishuError(result) {
  const error = new Error(result?.msg || result?.message || '发送消息失败');
  error.feishuCode = result?.code;
  error.feishuMessage = result?.msg || result?.message;
  error.requestId = result?.request_id || result?.requestId;
  return error;
}

module.exports = { createFeishuError, normalizeError };
