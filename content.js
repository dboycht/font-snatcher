// font-snatcher content script
// Runs in every frame of every page (all_frames: true).
// Responsibilities:
//   1. On SCAN_FONTS: enumerate fonts actually used in this frame.
//      - "selection" mode: only the font(s) of the currently selected text.
//      - otherwise: fonts referenced by any rendered element.
//   2. Resolve each font family to a concrete downloadable font source by
//      reading the underlying font data through the FontFace API where
//      possible, and by parsing @font-face rules from stylesheets.

'use strict';

(() => {
  // Guard against double injection.
  if (window.__fontSnatcherLoaded) return;
  window.__fontSnatcherLoaded = true;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.type === 'SCAN_FONTS') {
      scanFonts(message.selection === true)
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
      return true; // async
    }
    if (message && message.type === 'ENTER_PICKER') {
      // Only engage the picker in the top frame; iframes ignore it.
      if (window.top === window) {
        enterPickerMode();
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: 'ignored in iframe' });
      }
      return true;
    }
    if (message && message.type === 'EXIT_PICKER') {
      if (window.top === window) {
        exitPickerMode();
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: 'ignored in iframe' });
      }
      return true;
    }
    return false;
  });

  // -------------------------------------------------------------------------
  // Main scan
  // -------------------------------------------------------------------------
  async function scanFonts(selectionOnly) {
    const found = [];

    // --- Gather candidate font families ------------------------------------------------------
    let families;
    if (selectionOnly) {
      families = familiesOfSelection();
    } else {
      families = familiesInDocument();
    }

    // --- Enrich with sources ----------------------------------------------------------------
    // Build a map of family -> array of FontFace sources from @font-face rules.
    const { fontFaceMap, crossOriginSheets } = collectFontFaceRules();

    for (const family of families) {
      if (!family || family === '') continue;
      const trimmed = normalizeFamily(family);
      if (isGeneric(trimmed)) continue; // generic families (serif, sans-serif...) are not files

      const info = {
        family: trimmed,
        displayName: trimmed,
        sources: [],
        url: null,
        ttfUrl: null, // direct ttf/otf source if declared in @font-face
      };

      // Enumerate all font-face sources matching this family (may have multiple
      // weights/styles, each potentially a different file).
      const matching = (fontFaceMap.get(trimmed) || []).concat(
        fontFaceMap.get(trimmed.toLowerCase()) || []
      );

      // Dedupe sources by URL.
      const seen = new Set();
      for (const src of matching) {
        if (src && src.url && !seen.has(src.url)) {
          seen.add(src.url);
          info.sources.push({ url: src.url, format: src.format || null });
        }
      }

      // If we couldn't find a @font-face source, try to extract a concrete
      // URL from the loaded FontFace entries in document.fonts.
      if (info.sources.length === 0) {
        const ff = lookupLoadedFontFace(trimmed);
        if (ff) {
          info.sources.push({ url: ff.url, format: ff.format || null });
        }
      }

      // Pick a primary URL for the one-click download.
      if (info.sources.length > 0) {
        // Prefer WOFF2 when present for the best compression, else first.
        const woff2 = info.sources.find((s) => s.format === 'woff2' && /\.woff2(?:$|\?)/i.test(s.url));
        const woff = info.sources.find((s) => s.format === 'woff' && /\.woff(?:$|\?)/i.test(s.url));
        const ttfSrc = info.sources.find(
          (s) => /\.(ttf|otf)(?:$|\?)/i.test(s.url) || (s.format && /^(ttf|otf)$/i.test(s.format))
        );
        const primary = ttfSrc || woff2 || woff || info.sources[0];
        info.url = primary.url;
        info.primaryFormat = primary.format || null;
        // A direct ttf/otf source lets us download TTF without conversion.
        if (ttfSrc) info.ttfUrl = ttfSrc.url;
      }

      found.push(info);
    }

    return { fonts: dedupeFonts(found), crossOriginSheets };
  }

  // -------------------------------------------------------------------------
  // Family collection
  // -------------------------------------------------------------------------
  function familiesOfSelection() {
    const families = new Set();
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return [];
    // For each selected element, read its computed font-family. The selection
    // may span multiple elements with different fonts.
    for (let i = 0; i < sel.rangeCount; i++) {
      const range = sel.getRangeAt(i);
      const container = range.commonAncestorContainer;
      const el = container.nodeType === Node.ELEMENT_NODE
        ? container
        : container.parentElement;
      if (!el) continue;
      const st = window.getComputedStyle(el);
      if (st) splitFamilies(st.fontFamily).forEach((f) => families.add(f));
      // Also walk descendant elements within the range that are block-level
      // text containers and may override the font.
      const nodes = el.querySelectorAll('*');
      nodes.forEach((n) => {
        const st2 = window.getComputedStyle(n);
        if (st2 && st2.display !== 'none') {
          splitFamilies(st2.fontFamily).forEach((f) => families.add(f));
        }
      });
    }
    return Array.from(families);
  }

  function familiesInDocument() {
    const families = new Set();
    // 1) Any @font-face family declared in stylesheets (local + cross-origin).
    const { fontFaceMap } = collectFontFaceRules();
    for (const fam of fontFaceMap.keys()) families.add(fam);

    // 2) Any font-family actually referenced by a rendered element.
    const all = document.querySelectorAll('body *');
    // Cap traversal for very large pages to avoid jank.
    let count = 0;
    const MAX = 20000;
    for (const el of all) {
      if (++count > MAX) break;
      const st = window.getComputedStyle(el);
      if (!st) continue;
      splitFamilies(st.fontFamily).forEach((f) => families.add(f));
    }
    // Also include the body itself.
    if (document.body) {
      const st = window.getComputedStyle(document.body);
      if (st) splitFamilies(st.fontFamily).forEach((f) => families.add(f));
    }
    // And the root element fallback.
    if (document.documentElement) {
      const st = window.getComputedStyle(document.documentElement);
      if (st) splitFamilies(st.fontFamily).forEach((f) => families.add(f));
    }

    return Array.from(families);
  }

  function splitFamilies(familyString) {
    if (!familyString) return [];
    // Font families are comma-separated; quoted families may contain commas.
    return familyString
      .split(/,(?=(?:[^"']*["'][^"']*["'])*[^"']*$)/)
      .map((s) => s.replace(/^["'\s]+|["'\s]+$/g, ''))
      .filter(Boolean);
  }

  function normalizeFamily(name) {
    return name.replace(/^["'\s]+|["'\s]+$/g, '').trim();
  }

  function isGeneric(name) {
    const g = name.toLowerCase();
    const generics = [
      'serif', 'sans-serif', 'sans serif', 'monospace', 'cursive',
      'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace',
      'ui-rounded', 'emoji', 'math', 'fangsong', 'inherit', 'initial',
      'unset', 'revert', 'revert-layer',
    ];
    return generics.includes(g);
  }

  // -------------------------------------------------------------------------
  // @font-face collection
  // -------------------------------------------------------------------------
  // Returns { fontFaceMap: Map<family, sources[]>, crossOriginSheets: string[] }.
  // Fonts loaded from cross-origin stylesheets (Google Fonts, CDNs...) cannot
  // be read via cssRules — we collect those sheet URLs so the background can
  // fetch and parse them (it has <all_urls> host permission).
  function collectFontFaceRules() {
    const map = new Map(); // family -> sources[]
    const crossOriginSheets = [];
    try {
      for (const sheet of document.styleSheets) {
        let rules;
        try {
          rules = sheet.cssRules || sheet.rules;
        } catch (_) {
          // Cross-origin stylesheet -> cannot read rules; remember its href
          // so the background can fetch and parse the raw CSS text.
          if (sheet.href) crossOriginSheets.push(sheet.href);
          continue;
        }
        if (!rules) continue;
        for (const rule of rules) {
          if (rule.type !== CSSRule.FONT_FACE_RULE) continue;
          const family = normalizeFamily(rule.style.getPropertyValue('font-family') || '');
          if (!family) continue;
          const srcList = parseFontFaceSrc(rule.style.getPropertyValue('src'));
          if (srcList.length === 0) continue;
          const existing = map.get(family) || [];
          map.set(family, existing.concat(srcList));
        }
      }
    } catch (e) {
      console.warn('[font-snatcher] failed to read stylesheets:', e);
    }
    // Dedupe cross-origin sheet URLs.
    return { fontFaceMap: map, crossOriginSheets: Array.from(new Set(crossOriginSheets)) };
  }

  function parseFontFaceSrc(srcString) {
    // Format: url("...") format("woff2"), url(...) format("woff"), ...
    const sources = [];
    if (!srcString) return sources;
    // Match each url(...) with optional format(...) following it.
    const urlRe = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
    const formatRe = /format\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
    let m;
    const urls = [];
    while ((m = urlRe.exec(srcString)) !== null) {
      urls.push(m[2]);
    }
    const formats = [];
    while ((m = formatRe.exec(srcString)) !== null) {
      formats.push(m[2]);
    }
    urls.forEach((u, i) => {
      sources.push({
        url: resolveUrl(u),
        format: (formats[i] || '').toLowerCase() || null,
      });
    });
    return sources;
  }

  function resolveUrl(rawUrl) {
    try {
      return new URL(rawUrl, document.baseURI).href;
    } catch (_) {
      return rawUrl;
    }
  }

  // -------------------------------------------------------------------------
  // Loaded FontFace lookup (best-effort for fonts not accessible via CSSOM)
  // -------------------------------------------------------------------------
  function lookupLoadedFontFace(family) {
    const wanted = family.toLowerCase();
    for (const face of document.fonts) {
      try {
        // family may include @font-face style suffix; compare loosely.
        const ffFamily = (face.family || '').trim().toLowerCase();
        if (ffFamily === wanted || ffFamily.startsWith(wanted)) {
          // Extract a source URL is not exposed by FontFace API directly.
          // As a fallback we keep the family so the UI can still offer a
          // textual hint; no URL means no direct download.
          return null;
        }
      } catch (_) { /* ignore */ }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Dedupe / finalize
  // -------------------------------------------------------------------------
  function dedupeFonts(fonts) {
    const map = new Map();
    for (const font of fonts) {
      if (!font || !font.family) continue;
      const key = (font.url || '') + '|' + font.family;
      if (!map.has(key)) map.set(key, font);
    }
    return Array.from(map.values());
  }

  // =========================================================================
  // PICKER MODE — click any text on the page to inspect & download its font
  // =========================================================================
  let pickerActive = false;
  let hoverEl = null;
  let overlayEl = null;      // the floating info panel
  let shadowRoot = null;

  function enterPickerMode() {
    if (pickerActive) return;
    pickerActive = true;
    document.addEventListener('mousemove', onPickerMove, true);
    document.addEventListener('mouseout', onPickerOut, true);
    document.addEventListener('click', onPickerClick, true);
    document.addEventListener('keydown', onPickerKey, true);
    document.addEventListener('scroll', hideOverlay, true);
    showPickerBanner();
  }

  function exitPickerMode() {
    if (!pickerActive) return;
    pickerActive = false;
    document.removeEventListener('mousemove', onPickerMove, true);
    document.removeEventListener('mouseout', onPickerOut, true);
    document.removeEventListener('click', onPickerClick, true);
    document.removeEventListener('keydown', onPickerKey, true);
    document.removeEventListener('scroll', hideOverlay, true);
    clearHover();
    hideOverlay();
    removePickerBanner();
  }

  function onPickerMove(e) {
    if (!pickerActive) return;
    const el = e.target && e.target.nodeType === Node.ELEMENT_NODE ? e.target : null;
    // Only hover text-ish elements (avoid giant containers that would make
    // the highlight visually useless).
    if (el && el !== hoverEl && hasVisibleText(el)) {
      setHover(el);
    }
  }

  function onPickerOut(e) {
    if (!pickerActive) return;
    if (e.target === hoverEl) clearHover();
  }

  function onPickerClick(e) {
    if (!pickerActive) return;
    const el = e.target && e.target.nodeType === Node.ELEMENT_NODE ? e.target : null;
    if (!el) return;
    // Don't react to clicks inside our own overlay.
    if (overlayEl && overlayEl.contains(el)) return;
    e.preventDefault();
    e.stopPropagation();
    inspectElement(el);
  }

  function onPickerKey(e) {
    if (e.key === 'Escape') {
      exitPickerMode();
      // Tell the popup we are done (best-effort; popup may be closed).
      chrome.runtime.sendMessage({ type: 'PICKER_EXITED' }).catch(() => {});
    }
  }

  // -------------------------------------------------------------------------
  // Hover highlight
  // -------------------------------------------------------------------------
  function hasVisibleText(el) {
    // Avoid elements with no text and large chrome-y containers.
    const text = (el.textContent || '').trim();
    if (!text) return false;
    const st = getComputedStyle(el);
    if (!st || st.display === 'none' || st.visibility === 'hidden') return false;
    // Exclude elements whose only text is inside no direct text (i.e. too big).
    const rect = el.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return false;
    // Reasonable upper bound: we don't want to highlight the whole page body.
    if (text.length > 2000) return false;
    return true;
  }

  function setHover(el) {
    clearHover();
    hoverEl = el;
    el.style.outline = '2px dashed #ff5722';
    el.style.outlineOffset = '2px';
  }

  function clearHover() {
    if (hoverEl) {
      hoverEl.style.outline = '';
      hoverEl.style.outlineOffset = '';
      hoverEl = null;
    }
  }

  // -------------------------------------------------------------------------
  // Banner hint (top-right, styled via shadow DOM to resist page CSS)
  // -------------------------------------------------------------------------
  function showPickerBanner() {
    if (document.getElementById('font-snatcher-banner')) return;
    const host = document.createElement('div');
    host.id = 'font-snatcher-banner';
    host.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;';
    host.innerHTML = `
      <div style="background:#21252b;color:#fff;padding:10px 16px;border-radius:8px;
                  font:13px/1.5 system-ui,sans-serif;box-shadow:0 4px 20px rgba(0,0,0,.35);
                  display:flex;align-items:center;gap:12px;">
        <span>🔍 点击页面上的文字查看字体，<b>Esc</b> 退出</span>
        <button id="fs-exit" style="background:#fff;color:#21252b;border:none;border-radius:6px;
                  padding:4px 10px;cursor:pointer;font:13px system-ui,sans-serif;">退出</button>
      </div>`;
    document.documentElement.appendChild(host);
    host.querySelector('#fs-exit').addEventListener('click', () => exitPickerMode());
  }

  function removePickerBanner() {
    const b = document.getElementById('font-snatcher-banner');
    if (b) b.remove();
  }

  // -------------------------------------------------------------------------
  // Inspect & populate overlay
  // -------------------------------------------------------------------------
  async function inspectElement(el) {
    // Gather the family names actually used on this element.
    const st = getComputedStyle(el);
    if (!st) return;
    const families = splitFamilies(st.fontFamily)
      .map(normalizeFamily)
      .filter((f) => f && !isGeneric(f));
    if (families.length === 0) return;

    const resolvedFamily = families[0]; // first concrete family wins
    const { fontFaceMap, crossOriginSheets } = collectFontFaceRules();

    // Try local @font-face map first.
    let sources = fontFaceMap.get(resolvedFamily) || fontFaceMap.get(resolvedFamily.toLowerCase()) || [];

    // If nothing local, ask the background to parse remote stylesheets.
    if (sources.length === 0 && crossOriginSheets.length > 0) {
      try {
        const resp = await chrome.runtime.sendMessage({
          type: 'GET_FONT_SOURCES',
          family: resolvedFamily,
          sheets: crossOriginSheets,
        });
        if (resp && resp.ok && resp.sources && resp.sources.length > 0) {
          sources = resp.sources;
        }
      } catch (_) { /* background unavailable */ }
    }

    if (sources.length === 0) {
      // Still no URL — but we can still show family info without buttons.
      showOverlay(el, resolvedFamily, st, sources, true);
      return;
    }
    showOverlay(el, resolvedFamily, st, sources, false);
  }

  function showOverlay(anchorEl, family, computedStyle, sources, noSource) {
    clearHover(); // give focus to the overlay panel
    hideOverlay();
    if (!overlayEl) {
      overlayEl = document.createElement('div');
      overlayEl.id = 'font-snatcher-overlay';
      overlayEl.style.cssText = 'position:fixed;z-index:2147483646;';
      shadowRoot = overlayEl.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = `
        .panel{background:#fff;color:#1f2328;border:1px solid #d0d7de;border-radius:10px;
               padding:14px 16px;width:300px;font:13px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;
               box-shadow:0 8px 30px rgba(0,0,0,.25);}
        .fam{font-size:15px;font-weight:700;word-break:break-all;margin-bottom:6px;}
        .meta{color:#57606a;font-size:12px;margin-bottom:4px;}
        .meta b{color:#24292f;}
        .srcs{margin:8px 0;max-height:70px;overflow:auto;font-size:11px;color:#6e7781;
              word-break:break-all;}
        .btns{display:flex;gap:8px;margin-top:10px;}
        .btn{flex:1;border:none;border-radius:6px;padding:7px 0;cursor:pointer;
             font:13px/1 system-ui,sans-serif;color:#fff;}
        .btn:disabled{opacity:.5;cursor:default;}
        .btn-woff2{background:#1a73e8;}
        .btn-ttf{background:#188038;}
        .close{position:absolute;top:8px;right:10px;border:none;background:none;font-size:16px;
               cursor:pointer;color:#57606a;line-height:1;padding:2px 4px;}
        .no-src{color:#d93025;font-size:12px;margin-top:8px;}
        .ok{color:#188038;font-size:12px;margin-top:8px;}
        .err{color:#d93025;font-size:12px;margin-top:8px;}
        .prog{display:none;margin-top:10px;}
        .prog.show{display:block;}
        .prog-bar{height:6px;background:#e5e7eb;border-radius:3px;overflow:hidden;}
        .prog-fill{height:100%;width:0%;background:linear-gradient(90deg,#1a73e8,#188038);
                   border-radius:3px;transition:width .2s ease;}
        .prog-label{font-size:11px;color:#6e7781;margin-top:4px;text-align:right;}
      `;
      shadowRoot.appendChild(style);
      document.documentElement.appendChild(overlayEl);
      overlayEl.addEventListener('mousedown', (e) => e.stopPropagation());
    }

    const rect = anchorEl.getBoundingClientRect();
    const panel = document.createElement('div');
    panel.className = 'panel';

    const fam = document.createElement('div');
    fam.className = 'fam';
    fam.textContent = family;

    const meta = document.createElement('div');
    meta.className = 'meta';
    const w = computedStyle.fontWeight || 'normal';
    const s = computedStyle.fontStyle || 'normal';
    const sz = computedStyle.fontSize || '';
    meta.innerHTML = `字重 <b>${w}</b> · 风格 <b>${s}</b> · 字号 <b>${sz}</b>`;

    panel.appendChild(fam);
    panel.appendChild(meta);

    const srcs = document.createElement('div');
    srcs.className = 'srcs';
    if (sources.length > 0) {
      srcs.textContent = sources.map((x) => x.url).join('\n');
    } else {
      srcs.textContent = noSource
        ? '（未在样式表中找到该字体的文件 URL）'
        : '';
    }
    panel.appendChild(srcs);

    if (!noSource) {
      const btns = document.createElement('div');
      btns.className = 'btns';

      const woff2Btn = document.createElement('button');
      woff2Btn.className = 'btn btn-woff2';
      woff2Btn.textContent = '下载 WOFF2';
      woff2Btn.addEventListener('click', () => downloadFromOverlay(family, sources, 'woff2', woff2Btn));

      const ttfBtn = document.createElement('button');
      ttfBtn.className = 'btn btn-ttf';
      ttfBtn.textContent = '下载 TTF';
      ttfBtn.addEventListener('click', () => downloadFromOverlay(family, sources, 'ttf', ttfBtn));

      btns.appendChild(woff2Btn);
      btns.appendChild(ttfBtn);
      panel.appendChild(btns);

      // Progress bar area (shown while a download is in progress).
      const prog = document.createElement('div');
      prog.className = 'prog';
      prog.innerHTML = `
        <div class="prog-bar"><div class="prog-fill"></div></div>
        <div class="prog-label"></div>`;
      panel.appendChild(prog);

      const msg = document.createElement('div');
      msg.className = 'ok';
      msg.textContent = '';
      panel.appendChild(msg);
    } else {
      const ns = document.createElement('div');
      ns.className = 'no-src';
      ns.textContent = '找不到可下载来源，可尝试其他文字或点击「查看全部字体」清单。';
      panel.appendChild(ns);
    }

    const close = document.createElement('button');
    close.className = 'close';
    close.textContent = '✕';
    close.title = '关闭';
    close.addEventListener('click', hideOverlay);
    panel.appendChild(close);

    // Remove old panel if any.
    const old = shadowRoot.querySelector('.panel');
    if (old) old.remove();
    shadowRoot.appendChild(panel);

    // Position: prefer above the clicked element; clamp to viewport.
    const x = Math.min(rect.left, window.innerWidth - 330);
    const y = rect.top - panel.offsetHeight - 8;
    overlayEl.style.left = Math.max(4, x) + 'px';
    overlayEl.style.top = (y > 4 ? y : rect.bottom + 8) + 'px';
  }

  function hideOverlay() {
    if (overlayEl) {
      const panel = shadowRoot && shadowRoot.querySelector('.panel');
      if (panel) panel.remove();
      // Keep host node, just empty it so positions recompute next time.
    }
  }

  // Retry a failed background download using the PAGE's network context
  // (shares user session / clearance cookies for bot-protected sites).
  // Returns true if a download was submitted via the background.
  async function pageContextDownload(family, sources, format, setMsg, btn) {
    const ttfSrc = sources.find(
      (s) => /\.(ttf|otf)(?:$|\?)/i.test(s.url) || (s.format && /^(ttf|otf)$/i.test(s.format))
    );
    const primary = ttfSrc || sources[0];
    if (!primary || !primary.url) return false;
    setMsg('🔄 尝试页面通道下载…');
    try {
      const resp = await fetch(primary.url, { credentials: 'include' });
      if (!resp.ok) return false;
      const buf = await resp.arrayBuffer();
      if (!buf || buf.byteLength === 0) return false;
      // base64 (string) avoids cross-context ArrayBuffer loss.
      const bytes = new Uint8Array(buf);
      const b64 = bytesToBase64(bytes);
      const dl = await chrome.runtime.sendMessage({
        type: 'DOWNLOAD_FONT_B64',
        b64,
        family,
        format,
        filename: family,
      });
      if (!dl || !dl.ok) {
        setMsg(`✗ ${(dl && dl.error) || '下载失败'}`, 'err');
        if (btn) setTimeout(() => { btn.disabled = false; }, 1500);
        return false;
      }
      setMsg(dl.needsConvert ? '⏳ 已提交，正在下载…' : '✓ 已开始下载');
      if (btn) setTimeout(() => { btn.disabled = false; }, 1500);
      return true;
    } catch (err) {
      setMsg('✗ 页面通道失败：' + err.message, 'err');
      if (btn) btn.disabled = false;
      return false;
    }
  }

  function bytesToBase64(bytes) {
    const CHUNK = 0x8000;
    let bin = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  async function downloadFromOverlay(family, sources, format, btn) {
    if (btn) btn.disabled = true;
    const panel = shadowRoot && shadowRoot.querySelector('.panel');
    const msgEl = panel && panel.querySelector('.ok');
    const progEl = panel && panel.querySelector('.prog');
    const fillEl = panel && progEl.querySelector('.prog-fill');
    const labelEl = panel && progEl.querySelector('.prog-label');

    const setMsg = (text, kind) => {
      if (!msgEl) return;
      msgEl.textContent = text;
      msgEl.className = 'ok' + (kind === 'err' ? ' err' : '');
    };
    const setProgress = (pct, label) => {
      if (!progEl) return;
      progEl.classList.add('show');
      if (fillEl) fillEl.style.width = pct + '%';
      if (labelEl) labelEl.textContent = label || (pct + '%');
    };

    try {
      const ttfSrc = sources.find(
        (s) => /\.(ttf|otf)(?:$|\?)/i.test(s.url) || (s.format && /^(ttf|otf)$/i.test(s.format))
      );
      const primary = ttfSrc || sources[0];

      // Show "starting" state; conversion (WOFF2->TTF) can take a while before
      // the download id exists, so label it as converting/preparing.
      setMsg(format === 'ttf' ? '🔄 转换中…' : '🔄 准备中…');
      setProgress(5, '准备中…');

      const resp = await chrome.runtime.sendMessage({
        type: 'DOWNLOAD_FONT',
        url: primary.url,
        ttfUrl: format === 'ttf' ? (ttfSrc ? ttfSrc.url : null) : null,
        family,
        format,
        filename: family,
        sources,
      });

      if (!resp || !resp.ok) {
        // Background fetch may be blocked by the site (403 bot-protection
        // like Cloudflare). Retry IN THE PAGE context: the page shares the
        // user's session / clearance cookies, so page fetch often succeeds
        // where the extension worker's fetch fails.
        const pageOk = await pageContextDownload(family, sources, format, setMsg, btn);
        if (!pageOk) {
          setMsg(`✗ ${(resp && resp.error) || '失败'}`, 'err');
          if (btn) setTimeout(() => { btn.disabled = false; }, 1500);
        }
        return;
      }

      // Track progress: the background (which owns chrome.downloads) pushes
      // DL_PROGRESS messages tagged with this downloadId.
      const downloadId = resp.downloadId;
      if (downloadId != null) {
        const handleProgress = (msg) => {
          if (!msg || msg.type !== 'DL_PROGRESS' || msg.downloadId !== downloadId) return;
          const { pct, received, total, state } = msg;
          if (state === 'in_progress') {
            setProgress(pct, `${pct}% · ${fmtSize(received)} / ${fmtSize(total)}`);
          } else if (state === 'complete') {
            setProgress(100, '100% · 完成');
            setMsg('✓ 下载完成');
            chrome.runtime.onMessage.removeListener(handleProgress);
          } else if (state === 'interrupted') {
            setMsg('✗ 下载中断', 'err');
            chrome.runtime.onMessage.removeListener(handleProgress);
          }
        };
        chrome.runtime.onMessage.addListener(handleProgress);
        // Ask the background to stream progress; it broadcasts DL_PROGRESS and
        // we filter by downloadId (globally unique), so no tabId needed.
        chrome.runtime.sendMessage({ type: 'WATCH_DOWNLOAD', downloadId }).catch(() => {});
        setMsg('⏳ 下载中…');
      } else {
        setMsg('✓ 已开始下载');
      }
      if (btn) setTimeout(() => { btn.disabled = false; }, 1500);
    } catch (err) {
      setMsg('✗ ' + err.message, 'err');
      if (btn) btn.disabled = false;
    }
  }

  function fmtSize(n) {
    if (!n) return '0 B';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }
})();
