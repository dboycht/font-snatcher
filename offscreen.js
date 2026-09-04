// font-snatcher offscreen document
// Handles WOFF2 -> TTF conversion and file downloads using the full DOM API
// (URL.createObjectURL / Blob) that MV3 service workers may lack.
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
  (async () => {
    try {
      switch (message.type) {
        case 'CONVERT_AND_DOWNLOAD': {
          // { woff2: ArrayBuffer, filename, wantTtf }
          const woff2Bytes = new Uint8Array(message.woff2);
          const module = await decoderReady;
          const out = module.decompress(woff2Bytes);
          if (!out) throw new Error('WOFF2 解码失败');
          const ttfBytes = out instanceof Uint8Array ? out : new Uint8Array(out);
          return await downloadBytes(ttfBytes, message.filename, 'ttf');
        }
        case 'DOWNLOAD_BYTES': {
          // { bytes: ArrayBuffer, filename }
          const bytes = new Uint8Array(message.bytes);
          const ext = detectExtension(bytes);
          return await downloadBytes(bytes, message.filename, ext);
        }
        default:
          return { ok: false, error: `Unknown offscreen message: ${message.type}` };
      }
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  })().then(sendResponse);
  return true; // async
});

async function downloadBytes(bytes, filename, ext) {
  const base = sanitizeFilename(filename || 'font');
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const blobUrl = URL.createObjectURL(blob);
  try {
    const downloadId = await chrome.downloads.download({
      url: blobUrl,
      filename: `${base}.${ext}`,
      saveAs: true,
      conflictAction: 'uniquify',
    });
    return { ok: true, downloadId };
  } finally {
    // Give the download a moment to start before revoking the URL.
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
  }
}

function detectExtension(bytes) {
  if (bytes.length >= 4 && bytes[0] === 0x77 && bytes[1] === 0x4F &&
      bytes[2] === 0x46 && bytes[3] === 0x32) return 'woff2';
  if (bytes.length >= 4 && bytes[0] === 0x77 && bytes[1] === 0x4F &&
      bytes[2] === 0x46 && bytes[3] === 0x46) return 'woff';
  if (bytes.length >= 4) {
    const tag = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    if (tag === 'OTTO') return 'otf';
    if (bytes[0] === 0x00 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) return 'ttf';
  }
  return 'font';
}

function sanitizeFilename(name) {
  return String(name)
    .replace(/[\\/:*?"<>|\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'font';
}