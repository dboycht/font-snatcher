// font-snatcher offscreen document
// Responsibilities:
//   1. WOFF2 -> TTF conversion using wawoff2 (needs a document context: the
//      service worker's embind binding does not complete reliably, and the
//      extension-page CSP now allows wasm + eval).
//   2. Create blob: URLs from binary data (URL.createObjectURL lives here,
//      since service workers may lack it in some runtimes).
// The actual chrome.downloads call happens in the background service worker
// (offscreen docs in some Edge versions don't expose chrome.downloads).
'use strict';

// wawoff2 (Emscripten) exposes the global `Module` once vendor/wawoff2.js
// has been loaded via the <script> tag in offscreen.html.
const decoderReady = new Promise((resolve, reject) => {
  const tryResolve = () => {
    if (Module && typeof Module.decompress === 'function') {
      if (Module.calledRun) {
        // Embind types register asynchronously after run; probe until bound.
        const probe = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0]);
        const deadline = Date.now() + 15000;
        const poll = () => {
          try { Module.decompress(probe); return resolve(Module); }
          catch (e) {
            if (!/unbound types/i.test(String(e && e.message))) return reject(new Error('wawoff2 初始化失败：' + (e && e.message)));
            if (Date.now() < deadline) setTimeout(poll, 100);
            else reject(new Error('wawoff2 初始化超时'));
          }
        };
        return poll();
      }
      Module.onRuntimeInitialized = () => {
        const probe = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0]);
        const deadline = Date.now() + 15000;
        const poll = () => {
          try { Module.decompress(probe); return resolve(Module); }
          catch (e) {
            if (!/unbound types/i.test(String(e && e.message))) return reject(new Error('wawoff2 初始化失败：' + (e && e.message)));
            if (Date.now() < deadline) setTimeout(poll, 100);
            else reject(new Error('wawoff2 初始化超时'));
          }
        };
        poll();
      };
      setTimeout(() => {
        if (Module && !Module.calledRun) reject(new Error('wawoff2 初始化超时'));
      }, 60000);
      return;
    }
    // The script may still be loading; retry shortly.
    setTimeout(tryResolve, 50);
  };
  tryResolve();
});

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
          const module = await decoderReady;
          const out = module.decompress(woff2Bytes);
          if (!out) throw new Error('WOFF2 解码失败');
          // embind returns a VIEW over the wasm heap; .buffer is the whole
          // heap. slice() to get exact bytes before sending to background.
          const view = out instanceof Uint8Array ? out : new Uint8Array(out);
          const ttfBytes = view.slice();
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