// font-snatcher offscreen document
// Responsibilities:
//   1. WOFF2 -> TTF conversion using the wawoff2 decoder (wasm).
//   2. Creating blob: URLs from binary data (URL.createObjectURL lives here,
//      since service workers may lack it in some runtimes).
// The actual chrome.downloads call happens in the background service worker
// (offscreen documents in some Edge versions do not expose chrome.downloads).
'use strict';

// wawoff2 (Emscripten) exposes the global `Module` once vendor/wawoff2.js
// has been loaded via the <script> tag in offscreen.html.
const decoderReady = new Promise((resolve, reject) => {
  const tryResolve = () => {
    if (Module && typeof Module.decompress === 'function') {
      if (Module.calledRun) return resolve(Module);
      Module.onRuntimeInitialized = () => resolve(Module);
      setTimeout(() => {
        if (!Module.calledRun) reject(new Error('wawoff2 初始化超时'));
      }, 30000);
      return;
    }
    // The script may still be loading; retry shortly.
    setTimeout(tryResolve, 50);
  };
  tryResolve();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // This document ONLY handles conversion/blob requests routed by the
  // background. Everything else (DOWNLOAD_FONT, GET_FONTS, SCAN_FONTS, ...)
  // is addressed to other extension contexts; return false so we never steal
  // the response channel.
  if (!message ||
      (message.type !== 'CONVERT_TO_TTF' &&
       message.type !== 'MAKE_BLOB_URL' &&
       message.type !== 'REVOKE_BLOB_URL')) {
    return false;
  }
  (async () => {
    try {
      switch (message.type) {
        case 'CONVERT_TO_TTF': {
          // { woff2: ArrayBuffer } -> { ok, ttf: ArrayBuffer }
          const woff2Bytes = new Uint8Array(message.woff2);
          const module = await decoderReady;
          const out = module.decompress(woff2Bytes);
          if (!out) throw new Error('WOFF2 解码失败');
          const ttfBytes = out instanceof Uint8Array ? out : new Uint8Array(out);
          if (ttfBytes.length === 0) throw new Error('解码结果为空');
          return { ok: true, ttf: ttfBytes.buffer };
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
          return { ok: false, error: `Unknown offscreen message: ${message.type}` };
      }
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  })().then(sendResponse);
  return true; // async
});