(function initTextSplitter(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TextSplitter = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createTextSplitter() {
  'use strict';

  const SAFE_TEXT_BYTES = 140 * 1024;
  const PART_LABEL_RESERVED_BYTES = 64;

  function utf8ByteLength(value) {
    const text = String(value);
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).length;
    if (typeof Buffer !== 'undefined') return Buffer.byteLength(text, 'utf8');
    return unescape(encodeURIComponent(text)).length;
  }

  function serializedTextBytes(value) {
    return utf8ByteLength(JSON.stringify({ text: String(value) }));
  }

  function getSegments(text) {
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
      return Array.from(segmenter.segment(text), item => item.segment);
    }
    return Array.from(text);
  }

  function splitText(text, maxBytes = SAFE_TEXT_BYTES) {
    const value = String(text);
    if (!Number.isInteger(maxBytes) || maxBytes <= serializedTextBytes('')) {
      throw new RangeError('maxBytes 必须能容纳一条文本消息');
    }
    if (serializedTextBytes(value) <= maxBytes) return [value];

    const emptyBytes = serializedTextBytes('');
    const parts = [];
    let current = '';
    let currentBytes = emptyBytes;

    for (const grapheme of getSegments(value)) {
      const graphemeBytes = utf8ByteLength(JSON.stringify(grapheme)) - 2;
      // 极端情况下，一个字素可能包含海量组合字符；退化为按码点切分，避免报错或丢字。
      const segments = emptyBytes + graphemeBytes > maxBytes ? Array.from(grapheme) : [grapheme];
      for (const segment of segments) {
        const segmentBytes = utf8ByteLength(JSON.stringify(segment)) - 2;
        if (current && currentBytes + segmentBytes > maxBytes) {
          parts.push(current);
          current = '';
          currentBytes = emptyBytes;
        }
        if (currentBytes + segmentBytes > maxBytes) {
          throw new RangeError('单个 Unicode 码点超过分段大小限制');
        }
        current += segment;
        currentBytes += segmentBytes;
      }
    }
    if (current) parts.push(current);
    return parts;
  }

  function prepareTextParts(text) {
    const value = String(text);
    if (serializedTextBytes(value) <= SAFE_TEXT_BYTES) return [value];
    const rawParts = splitText(value, SAFE_TEXT_BYTES - PART_LABEL_RESERVED_BYTES);
    return rawParts.map((part, index) => `[${index + 1}/${rawParts.length}]\n${part}`);
  }

  return {
    PART_LABEL_RESERVED_BYTES,
    SAFE_TEXT_BYTES,
    prepareTextParts,
    serializedTextBytes,
    splitText,
    utf8ByteLength,
  };
}));
