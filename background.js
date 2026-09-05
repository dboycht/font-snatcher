// font-snatcher background service worker (Manifest V3)
// Responsibilities:
//   1. Fetch font binaries cross-origin (bypassing page CORS).
//   2. Convert WOFF2 -> TTF in-browser when requested.
//   3. Trigger downloads via chrome.downloads.

'use strict';

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Messages addressed to the offscreen document must NOT be handled here:
  // chrome.runtime.sendMessage broadcasts to every extension context. The
  // offscreen document's listener answers them; background just ignores them.
  if (message && (message.type === 'CONVERT_TO_TTF' || message.type === 'CONVERT_AND_DOWNLOAD' ||
      message.type === 'DOWNLOAD_BYTES' || message.type === 'MAKE_BLOB_URL' || message.type === 'REVOKE_BLOB_URL' ||
      message.type === 'DL_PROGRESS' || message.type === 'PING')) {
    return false;
  }
  (async () => {
    try {
      switch (message.type) {
        case 'GET_FONTS':
          return await handleGetFonts(message);
        case 'DOWNLOAD_FONT':
          return await handleDownloadFont(message);
        case 'GET_FONT_SOURCES':
          return await handleGetFontSources(message);
        case 'WATCH_DOWNLOAD':
          // Content script asks to receive progress for a download. Our
          // global downloads.onChanged listener broadcasts DL_PROGRESS to all
          // contexts; the sender filters by downloadId. Nothing to store.
          return { ok: true };
        case 'PICKER_EXITED':
          // informational only (popup may be closed)
          return { ok: true };
        default:
          return { ok: false, error: `Unknown message type: ${message.type}` };
      }
    } catch (err) {
      console.error('[font-snatcher] background error:', err);
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  })().then(sendResponse);
  return true; // keep the message channel open for async response
});

// ---------------------------------------------------------------------------
// GET_FONTS: collect the fonts actually used on the current page.
// We ask the content script to enumerate fonts via document.fonts + computed
// styles, because that information is only reliably available inside the page.
// ---------------------------------------------------------------------------
async function handleGetFonts(message) {
  const tabId = message.tabId;
  if (tabId == null) return { ok: false, error: 'Missing tabId' };

  // Send a scanning request to all frames of the tab. The content script
  // responds with the list of fonts it found in that frame and any
  // cross-origin stylesheet URLs it could not read; we merge here.
  let results;
  try {
    results = await chrome.tabs.sendMessage(tabId, { type: 'SCAN_FONTS', selection: message.selection === true });
  } catch (err) {
    // No content script in the page (e.g. chrome:// pages) or frame closed.
    return { ok: false, error: '无法访问该页面（可能是受保护页面，如 chrome:// 或应用商店）。' };
  }

  if (!results || !results.ok) {
    return { ok: false, error: (results && results.error) || '扫描字体失败。' };
  }

  // Merge fonts across frames, dedupe by "family + source".
  const merged = mergeFonts(results.fonts || []);

  // Cross-origin stylesheets that the content script could not read
  // (Google Fonts & company). Fetch their raw CSS and parse @font-face.
  const sheetUrls = flattenStrings(results.crossOriginSheets);
  if (sheetUrls.length > 0) {
    try {
      const remote = await fetchAndParseFontFaces(sheetUrls); // Map<family, sources[]>
      for (const font of merged) {
        if (font.sources && font.sources.length > 0) continue; // already resolvable
        const extra = remote.get(font.family) || remote.get(font.family.toLowerCase());
        if (!extra || extra.length === 0) continue;
        font.sources = extra;
        const primary = pickPrimary(extra);
        if (primary) {
          font.url = primary.url;
          font.primaryFormat = primary.format || null;
        }
        const ttfSrc = extra.find(
          (s) => /\.(ttf|otf)(?:$|\?)/i.test(s.url) || (s.format && /^(ttf|otf)$/i.test(s.format))
        );
        if (ttfSrc) font.ttfUrl = ttfSrc.url;
      }
    } catch (e) {
      console.warn('[font-snatcher] could not parse remote stylesheets:', e);
    }
  }

  return { ok: true, fonts: merged };
}

function pickPrimary(sources) {
  const ttf = sources.find((s) => /\.(ttf|otf)(?:$|\?)/i.test(s.url));
  const woff2 = sources.find((s) => s.format === 'woff2' && /\.woff2(?:$|\?)/i.test(s.url));
  const woff = sources.find((s) => s.format === 'woff' && /\.woff(?:$|\?)/i.test(s.url));
  return ttf || woff2 || woff || sources[0] || null;
}

// ---------------------------------------------------------------------------
// GET_FONT_SOURCES: resolve the downloadable sources for one family, fetching
// and parsing any cross-origin stylesheets that the content script cannot read.
// Results are cached per stylesheet URL to avoid refetching on every click.
// ---------------------------------------------------------------------------
const remoteCssCache = new Map(); // sheetUrl -> Map<family, sources[]>

async function handleGetFontSources(message) {
  const { family, sheets = [] } = message;
  if (!family) return { ok: false, error: 'Missing family.' };

  const map = new Map(); // family -> sources[]
  for (const url of Array.from(new Set(sheets)).filter(Boolean)) {
    let parsed = remoteCssCache.get(url);
    if (!parsed) {
      try {
        const resp = await fetch(url, { credentials: 'include' });
        if (!resp.ok) continue;
        const css = await resp.text();
        parsed = parseFontFacesFromCss(css, url, new Map());
        remoteCssCache.set(url, parsed);
      } catch (err) {
        console.warn('[font-snatcher] fetch stylesheet failed:', url, err);
        continue;
      }
    }
    for (const [fam, srcs] of parsed) {
      const existing = map.get(fam) || [];
      map.set(fam, existing.concat(srcs));
    }
  }

  const sources = map.get(family) || map.get(family.toLowerCase()) || [];
  return { ok: true, sources };
}

// ---------------------------------------------------------------------------
// Remote stylesheet @font-face parsing.
// ---------------------------------------------------------------------------
async function fetchAndParseFontFaces(urls) {
  const map = new Map(); // family -> sources[]
  for (const url of urls) {
    try {
      const resp = await fetch(url, { credentials: 'include' });
      if (!resp.ok) continue;
      const css = await resp.text();
      parseFontFacesFromCss(css, url, map);
    } catch (err) {
      console.warn('[font-snatcher] fetch stylesheet failed:', url, err);
    }
  }
  return map;
}

// Parse @font-face rules out of raw CSS text (used for cross-origin sheets
// whose cssRules are opaque to the content script). Appends into `out`
// (Map<family, sources[]>). Handles braces/comments reasonably well; does
// NOT resolve nested @import (those sheets are fetched separately by the
// same mechanism when listed).
function parseFontFacesFromCss(css, baseUrl, out) {
  const map = out || new Map();
  const text = css.replace(/\/\*[\s\S]*?\*\//g, ''); // strip comments
  // Match @font-face { ... } blocks (allow nested braces via depth counting).
  let i = 0;
  const n = text.length;
  while (i < n) {
    const start = text.indexOf('@font-face', i);
    if (start === -1) break;
    let brace = text.indexOf('{', start);
    if (brace === -1) break;
    let depth = 1;
    let j = brace + 1;
    while (j < n && depth > 0) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}') depth--;
      j++;
    }
    const body = text.slice(brace + 1, j - 1);
    const family = extractFamily(body);
    if (family) {
      const srcList = extractSources(body, baseUrl);
      if (srcList.length > 0) {
        const existing = map.get(family) || [];
        map.set(family, existing.concat(srcList));
      }
    }
    i = j;
  }
  return map;
}

function extractFamily(body) {
  const m = body.match(/font-family\s*:\s*(['"]?)([^;'"]+)\1\s*;?/i);
  if (!m) return null;
  return m[2].trim().replace(/^["'\s]+|["'\s]+$/g, '');
}

// Parse `src: url(...) format(...), local(...), ...` into [{url, format}].
function extractSources(body, baseUrl) {
  const m = body.match(/src\s*:\s*([^;]+)/i);
  if (!m) return [];
  const srcListRaw = m[1];
  const sources = [];
  // Split on commas that are not inside parentheses.
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of srcListRaw) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur);

  for (const part of parts) {
    const urlMatch = part.match(/url\(\s*(['"]?)(.*?)\1\s*\)/i);
    if (!urlMatch) continue; // local(...) or tech() only
    const formatMatch = part.match(/format\(\s*(['"]?)(.*?)\1\s*\)/i);
    let url = urlMatch[2];
    try {
      url = new URL(url, baseUrl).href;
    } catch (_) { /* keep raw */ }
    sources.push({
      url,
      format: formatMatch ? formatMatch[2].trim().toLowerCase() : null,
    });
  }
  return sources;
}

function mergeFonts(fontLists) {
  const map = new Map();
  const flat = [];
  const stack = Array.isArray(fontLists) ? fontLists.slice() : [fontLists];
  while (stack.length) {
    const item = stack.pop();
    if (Array.isArray(item)) {
      for (const el of item.reverse()) stack.push(el);
    } else {
      flat.push(item);
    }
  }
  for (const font of flat) {
    if (!font || typeof font !== 'object') continue;
    if (!font.family) continue;
    const key = (font.postscriptName || font.family) + '|' + (font.source || '');
    if (!map.has(key)) map.set(key, font);
  }
  return Array.from(map.values());
}

// Many frames may each return arrays of strings; flatten any nesting.
function flattenStrings(value) {
  const out = [];
  const stack = Array.isArray(value) ? value.slice() : [value];
  while (stack.length) {
    const item = stack.pop();
    if (Array.isArray(item)) {
      for (const el of item.reverse()) stack.push(el);
    } else if (typeof item === 'string' && item) {
      out.push(item);
    }
  }
  return Array.from(new Set(out));
}

// ---------------------------------------------------------------------------
// DOWNLOAD_FONT: fetch a font binary, convert WOFF2 -> TTF if requested, and
// save it with chrome.downloads.
//
// Architecture notes:
//  - MV3 service workers lack URL.createObjectURL in some runtimes, so we
//    download via a DATA URL (base64) which is fully supported by
//    chrome.downloads.download in the service worker.
//  - WOFF2 -> TTF conversion happens in the offscreen document (wawoff2 wasm
//    loaded there). The offscreen doc returns the TTF bytes; background saves.
//  - The offscreen document does NOT use chrome.downloads: some Edge versions
//    do not expose chrome.downloads in offscreen documents.
// ---------------------------------------------------------------------------
async function handleDownloadFont(message) {
  const { url, family, format, filename, ttfUrl, sources } = message;
  if (!url) return { ok: false, error: 'Missing font URL.' };

  // Candidate URLs in priority order:
  //  - TTF requested + direct ttf/otf source -> that first.
  //  - Otherwise the primary URL, then any fallback sources of this family.
  let candidates = [];
  if (format === 'ttf' && ttfUrl) {
    candidates.push(ttfUrl);
  }
  candidates.push(url);
  if (Array.isArray(sources) && sources.length) {
    for (const s of sources) {
      if (s && s.url && !candidates.includes(s.url)) candidates.push(s.url);
    }
  }

  // Fetch the first URL that succeeds (handles stale 404 font hashes by
  // falling back to other variants declared for the same family).
  let bytes = null;
  let lastErr = null;
  for (const candidateUrl of candidates) {
    try {
      const resp = await fetch(candidateUrl, { credentials: 'include' });
      if (!resp.ok) {
        lastErr = new Error(`HTTP ${resp.status}`);
        continue;
      }
      const buf = await resp.arrayBuffer();
      if (buf.byteLength === 0) { lastErr = new Error('空文件'); continue; }
      bytes = new Uint8Array(buf);
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!bytes) {
    return { ok: false, error: `下载字体失败：${lastErr ? lastErr.message : '未找到可用来源'}` };
  }

  const wantTtf = format === 'ttf';
  const willConvert = wantTtf && !ttfUrl && isWoff2(bytes);

  try {
    let finalBytes = bytes;
    let ext = detectExtension(bytes);

    if (willConvert) {
      // Convert WOFF2 -> TTF. Primary path: in the offscreen document (its
      // document context + CSP-with-eval lets wawoff2's embind bind fully).
      // Fallback: try the SW-inline decoder if it ever becomes available.
      let ttf = null;
      const swDecoder = self.__fontSnatcherDecoder;
      if (swDecoder && typeof swDecoder.decompress === 'function') {
        try { ttf = swDecoder.decompress(bytes); } catch (_) { ttf = null; }
      }
      if (!ttf) {
        await ensureOffscreenDocument();
        const resp = await withTimeout(
          chrome.runtime.sendMessage({ type: 'CONVERT_TO_TTF', woff2: bytes.buffer }),
          60000,
          '转换超时'
        );
        if (!resp || !resp.ok) {
          throw new Error((resp && resp.error) || '转换失败');
        }
        ttf = new Uint8Array(resp.ttf);
      }
      finalBytes = ttf instanceof Uint8Array ? ttf : new Uint8Array(ttf);
      ext = 'ttf';
    }

    return await saveDownload(finalBytes, ext, sanitizeFilename(filename || family || 'font'));
  } catch (err) {
    if (willConvert) {
      return { ok: false, error: `转换 TTF 失败：${err.message}（你可改用 WOFF2 下载）` };
    }
    return { ok: false, error: `下载失败：${err.message}` };
  }
}

// Save bytes via chrome.downloads.
// Strategy:
//  - Always try a data URL first (works in the SW, no cross-context risk).
//  - For very large payloads a data URL may be rejected by the download
//    manager; fall back to a blob URL created in the offscreen document
//    (with a timeout so we never hang forever).
async function saveDownload(bytes, ext, base) {
  const filename = `${base}.${ext}`;
  try {
    // Attempt 1: data URL (works in SW without createObjectURL).
    const dataUrl = bytesToDataUrl(bytes);
    try {
      const downloadId = await chrome.downloads.download({
        url: dataUrl,
        filename,
        saveAs: true,
        conflictAction: 'uniquify',
      });
      return { ok: true, downloadId };
    } catch (_) {
      // Large payload or runtime constraint -> fall through to blob URL.
    }

    // Attempt 2: blob URL via offscreen document (with timeout).
    await ensureOffscreenDocument();
    const resp = await withTimeout(
      chrome.runtime.sendMessage({
        type: 'MAKE_BLOB_URL',
        bytes: bytes.buffer,
        mime: 'application/octet-stream',
      }),
      15000,
      'offscreen 响应超时'
    );
    if (!resp || !resp.ok || !resp.blobUrl) {
      throw new Error((resp && resp.error) || '创建下载链接失败');
    }
    const blobUrl = resp.blobUrl;
    try {
      const downloadId = await chrome.downloads.download({
        url: blobUrl,
        filename,
        saveAs: true,
        conflictAction: 'uniquify',
      });
      return { ok: true, downloadId };
    } finally {
      // Revoke after the download read the bytes.
      setTimeout(() => chrome.runtime.sendMessage({ type: 'REVOKE_BLOB_URL', blobUrl }).catch(() => {}), 120000);
    }
  } catch (err) {
    return { ok: false, error: `保存失败：${err.message}` };
  }
}

function withTimeout(promise, ms, msg) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg || '超时')), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

function bytesToDataUrl(bytes) {
  // Build base64 in chunks to avoid call-stack limits on large buffers.
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return 'data:application/octet-stream;base64,' + btoa(binary);
}

// ---------------------------------------------------------------------------
// Offscreen document management.
// ---------------------------------------------------------------------------
let offscreenCreation = null;

async function ensureOffscreenDocument() {
  // If we already have an offscreen document, reuse it.
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL('offscreen.html')],
    });
    if (contexts.length > 0) return await waitForOffscreenReady();
  } catch (_) {
    // getContexts may not exist in older runtimes; fall through to create.
  }

  if (!offscreenCreation) {
    offscreenCreation = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Convert WOFF2 to TTF and create blob URLs for font downloads.',
    }).catch((err) => {
      offscreenCreation = null;
      // "already exists" is fine — some runtimes keep the doc alive across
      // service worker restarts; treat it as success.
      if (/already exists|existing offscreen/i.test(String(err && err.message))) return;
      throw err;
    });
  }
  await offscreenCreation;
  if (offscreenCreation !== false) return await waitForOffscreenReady();
  return true;
}

// The offscreen document registers its message listener only after its JS
// has loaded. Ping until it responds (bounded) so a conversion message sent
// right after createDocument never hangs for lack of a listener.
async function waitForOffscreenReady() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const resp = await withTimeout(chrome.runtime.sendMessage({ type: 'PING' }), 2000, 'ping timeout');
      if (resp && resp.ok) return true;
    } catch (_) { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('offscreen 文档未就绪');
}

// ---------------------------------------------------------------------------
// WOFF2 -> TTF conversion, INLINE in the service worker.
//
// wawoff2 (vendor/wawoff2.js) is a single self-contained Emscripten build
// (wasm inlined as base64). It is loaded once via importScripts at startup;
// afterwards `Module.decompress(woff2Bytes)` returns a Uint8Array VIEW over
// the wasm heap — always `.slice()` it before use.
// ---------------------------------------------------------------------------
let woff2ModulePromise = null;

async function initWoff2Decoder() {
  if (woff2ModulePromise) return woff2ModulePromise;
  woff2ModulePromise = (async () => {
    try {
      importScripts('vendor/wawoff2.js');
    } catch (e) {
      try {
        importScripts(chrome.runtime.getURL('vendor/wawoff2.js'));
      } catch (e2) {
        throw new Error('无法加载 wawoff2 解码器：' + e2.message);
      }
    }
    const mod = self.Module || self.wawoff2;
    if (!mod || typeof mod.decompress !== 'function') {
      throw new Error('wawoff2 未暴露 decompress() 函数');
    }
    if (!mod.calledRun) {
      await new Promise((resolve, reject) => {
        mod.onRuntimeInitialized = () => resolve(mod);
        setTimeout(() => reject(new Error('wawoff2 初始化超时')), 60000);
      });
    }
    // Embind type converters (emscripten::val, std::string...) register
    // ASYNCHRONOUSLY after runtime init. Probe with a tiny valid call until
    // the "unbound types" race clears, with a hard timeout.
    const probe = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0]);
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {
        mod.decompress(probe); // garbage woff2 -> returns false once bound
        break; // no throw => types bound
      } catch (e) {
        if (!/unbound types/i.test(String(e && e.message))) throw e;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    if (Date.now() >= deadline) throw new Error('wawoff2 embind 类型绑定超时');
    return mod;
  })().catch((err) => {
    woff2ModulePromise = null; // allow retry
    throw err;
  });
  return woff2ModulePromise;
}

// Asynchronous conversion: ensures the decoder is initialised (warm path uses
// the value set at startup; cold path lazily loads it), then converts.
async function woff2ToTtf(woff2Bytes) {
  let decoder = self.__fontSnatcherDecoder;
  if (!decoder || typeof decoder.decompress !== 'function') {
    decoder = await initWoff2Decoder();
    self.__fontSnatcherDecoder = decoder;
  }
  const out = decoder.decompress(woff2Bytes);
  if (!out) throw new Error('WOFF2 解码失败');
  const view = out instanceof Uint8Array ? out : new Uint8Array(out);
  const copy = view.slice();
  if (copy.length === 0) throw new Error('解码结果为空');
  return copy;
}

// (SW-inline conversion is only a best-effort fallback: the primary path is
// the offscreen document, whose CSP-with-eval lets wawoff2's embind bind
// reliably. We deliberately do NOT warm the decoder at startup — initiating
// importScripts here produces noisy CSP errors in the SW logs and the SW
// embind binding is unreliable; lazy init keeps console clean.)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function isWoff2(bytes) {
  // WOFF2 magic: 0x77 'w' 0x4F 'O' 0x46 'F' 0x32 '2'
  return bytes.length >= 4 &&
    bytes[0] === 0x77 && bytes[1] === 0x4F &&
    bytes[2] === 0x46 && bytes[3] === 0x32;
}

function isWoff1(bytes) {
  // WOFF1 magic: 'wOFF'
  return bytes.length >= 4 && bytes[0] === 0x77 && bytes[1] === 0x4F &&
    bytes[2] === 0x46 && bytes[3] === 0x46;
}

function isCompressedSfnt(bytes) {
  return isWoff2(bytes) || isWoff1(bytes);
}

function detectExtension(bytes) {
  if (isWoff2(bytes)) return 'woff2';
  // WOFF1 magic: 'wOFF'
  if (bytes.length >= 4 && bytes[0] === 0x77 && bytes[1] === 0x4F &&
      bytes[2] === 0x46 && bytes[3] === 0x46) return 'woff';
  // TTF/OTF: 0x00010000 (TTF) or 'OTTO' (OTF)
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

// ---------------------------------------------------------------------------
// Download progress streaming.
// The service worker owns chrome.downloads; content scripts cannot access it.
// On any change of a download, we broadcast a compact DL_PROGRESS message to
// every extension context; the content overlay filters by downloadId.
// ---------------------------------------------------------------------------
chrome.downloads.onChanged.addListener((delta) => {
  const d = delta || {};
  if (d.id == null) return;
  const state = d.state && d.state.current;
  let pct = 0;
  let received = 0;
  let total = 0;
  if (d.receivedBytes && d.receivedBytes.current != null) received = d.receivedBytes.current;
  if (d.totalBytes && d.totalBytes.current != null) total = d.totalBytes.current;
  if (total > 0) pct = Math.min(100, Math.round((received / total) * 100));
  // Only broadcast meaningful progress states.
  if (!state || state === 'in_progress' || state === 'complete' || state === 'interrupted') {
    chrome.runtime.sendMessage({
      type: 'DL_PROGRESS',
      downloadId: d.id,
      state,
      pct,
      received,
      total,
    }).catch(() => {});
  }
});
