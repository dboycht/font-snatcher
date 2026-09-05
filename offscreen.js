// font-snatcher offscreen document
// Responsibilities:
//   1. WOFF2 -> TTF conversion using pure-JS decoding (foliojs brotli bundle +
//      our woff2dec). No wasm/eval, works under MV3 extension-page CSP.
//   2. Create blob: URLs for large binary downloads.
// chrome.downloads stays in the background service worker.
'use strict';

// woff2dec exposes global.FontSnatcherWoff2; brotli bundle exposes
// global.BrotliDecompressBuffer. Both loaded via <script> in offscreen.html.
function convertWoff2ToTtf(woff2Bytes) {
  const api = globalThis.FontSnatcherWoff2;
  const brotli = globalThis.BrotliDecompressBuffer;
  if (!api || !brotli) throw new Error('解码器未加载（woff2dec/brotli 缺失）');
  const ttf = api.woff2ToTtf(woff2Bytes, (buf) => {
    const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    // BrotliDecompressBuffer accepts Uint8Array (or Buffer); pass bytes only.
    return brotli(b.subarray ? b : b);
  });
  return ttf;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // This document ONLY handles conversion/blob requests routed by the
  // background. Everything else is addressed to other extension contexts;
  // return false so we never steal the response channel.
  if (!message ||
      (message.type !== 'CONVERT_TO_TTF' &&
       message.type !== 'MAKE_BLOB_URL' &&
       message.type !== 'REVOKE_BLOB_URL' &&
       message.type !== 'PING')) {
    return false;
  }
  (async () => {
    try {
      switch (message.type) {
        case 'PING':
          return { ok: true };
        case 'CONVERT_TO_TTF': {
          // { woff2: ArrayBuffer } -> { ok, ttf: ArrayBuffer }
          const woff2Bytes = new Uint8Array(message.woff2);
          const ttf = convertWoff2ToTtf(woff2Bytes);
          if (!ttf || ttf.length === 0) throw new Error('转换结果为空');
          // Copy bytes to an exact-size buffer before structured-clone send.
          return { ok: true, ttf: ttf.buffer };
        }
        case 'MAKE_BLOB_URL': {
          // { bytes: ArrayBuffer, mime? } -> { ok, blobUrl }
          const bytes = new Uint8Array(message.bytes);
          const blob = new Blob([bytes], { type: message.mime || 'application/octet-stream' });
          const blobUrl = URL.createObjectURL(blob);
          return { ok: true, blobUrl };
        }
        case 'REVOKE_BLOB_URL': {
          if (message.blobUrl) URL.revokeObjectURL(message.blobUrl);
          return { ok: true };
        }
        /* istanbul ignore next */
        default:
          return { ok: false, error: 'Unknown offscreen message' };
      }
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  })().then(sendResponse);
  return true; // async
});