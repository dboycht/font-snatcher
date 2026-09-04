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
  if (message && (message.type === 'CONVERT_AND_DOWNLOAD' || message.type === 'DOWNLOAD_BYTES')) {
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
// DOWNLOAD_FONT: fetch a font binary and save it to disk.
// MV3 service workers may lack URL.createObjectURL, so the actual conversion
// (WOFF2 -> TTF) and the chrome.downloads call happen in an offscreen
// document, which has the full DOM API.
// ---------------------------------------------------------------------------
async function handleDownloadFont(message) {
  const { url, family, format, filename, ttfUrl } = message;
  if (!url) return { ok: false, error: 'Missing font URL.' };

  // Choose the effective URL:
  //  - TTF requested and a direct ttf/otf source exists -> use it, no conversion.
  //  - TTF requested with only woff2 -> fetch woff2 then convert in offscreen.
  //  - WOFF2 requested -> fetch woff2 directly.
  let effectiveUrl = url;
  let needTtfConversion = false;
  if (format === 'ttf' && ttfUrl) {
    effectiveUrl = ttfUrl;
  } else if (format === 'ttf') {
    needTtfConversion = true; // we will convert whatever we fetch
  }

  let bytes;
  try {
    // Fetch with credentials so font files behind login still work when the
    // user is authenticated in the browser profile.
    const resp = await fetch(effectiveUrl, { credentials: 'include' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    bytes = new Uint8Array(await resp.arrayBuffer());
  } catch (err) {
    return { ok: false, error: `下载字体失败：${err.message}` };
  }

  const wantTtf = format === 'ttf';
  const willConvert = wantTtf && needTtfConversion && isWoff2(bytes);

  // Hand off to the offscreen document: it converts (if needed) and downloads.
  try {
    const offscreen = await ensureOffscreenDocument();
    if (willConvert) {
      return await chrome.runtime.sendMessage({
        type: 'CONVERT_AND_DOWNLOAD',
        woff2: bytes.buffer,
        filename: sanitizeFilename(filename || family || 'font'),
      });
    }
    // Direct download (woff2 / ttf / otf / woff as-is).
    return await chrome.runtime.sendMessage({
      type: 'DOWNLOAD_BYTES',
      bytes: bytes.buffer,
      filename: sanitizeFilename(filename || family || 'font'),
    });
  } catch (err) {
    if (willConvert) {
      return { ok: false, error: `转换 TTF 失败：${err.message}（你可改用 WOFF2 下载）` };
    }
    return { ok: false, error: `下载失败：${err.message}` };
  }
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
    if (contexts.length > 0) return true;
  } catch (_) {
    // getContexts may not exist in older runtimes; fall through to create.
  }

  if (!offscreenCreation) {
    offscreenCreation = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Download font files and convert WOFF2 to TTF using DOM APIs.',
    }).catch((err) => {
      offscreenCreation = null;
      throw err;
    });
  }
  await offscreenCreation;
  return true;
}

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
