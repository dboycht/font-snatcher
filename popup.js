// font-snatcher popup logic
'use strict';

// ---------------------------------------------------------------------------
// Element refs
// ---------------------------------------------------------------------------
const pickBtn = document.getElementById('pickBtn');
const listToggle = document.getElementById('listToggle');
const listWrap = document.getElementById('listWrap');
const statusEl = document.getElementById('status');
const listEl = document.getElementById('list');
const footerEl = document.getElementById('footer');
const downloadAllBtn = document.getElementById('downloadAllBtn');

let currentTabId = null;
let currentFonts = [];
let busy = false;

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
init();

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab ? tab.id : null;
  if (currentTabId == null) {
    showStatus('无法获取当前标签页。', 'error');
    return;
  }

  // Primary flow: one click -> voice between popup and page.
  pickBtn.addEventListener('click', async () => {
    pickBtn.disabled = true;
    try {
      // Tell the page's content script to enter picker mode.
      await chrome.tabs.sendMessage(currentTabId, { type: 'ENTER_PICKER' });
      // Close popup so the user can see the page.
      window.close();
    } catch (err) {
      showStatus('无法进入拾取模式，请刷新页面后重试。', 'error');
      pickBtn.disabled = false;
    }
  });

  // Secondary: list all fonts of the page.
  listToggle.addEventListener('click', () => {
    if (listWrap.hidden) {
      listWrap.hidden = false;
      scan();
    }
  });
  downloadAllBtn.addEventListener('click', downloadAll);

  // Picker exited by the user (Esc) — refresh state if popup still open.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'PICKER_EXITED') {
      pickBtn.disabled = false;
    }
  });
}

// ---------------------------------------------------------------------------
// Scan (list-all mode)
// ---------------------------------------------------------------------------
async function scan() {
  if (busy) return;
  busy = true;
  setBusy(true);
  showStatus(null);
  listEl.innerHTML = '';
  footerEl.hidden = true;

  try {
    const resp = await chrome.runtime.sendMessage({
      type: 'GET_FONTS',
      tabId: currentTabId,
      selection: false,
    });

    if (!resp || !resp.ok) {
      showStatus((resp && resp.error) || '扫描失败。', 'error');
      return;
    }

    currentFonts = resp.fonts || [];
    renderList(currentFonts);
  } catch (err) {
    showStatus(`扫描出错：${err.message}`, 'error');
  } finally {
    busy = false;
    setBusy(false);
  }
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
function renderList(fonts) {
  footerEl.hidden = fonts.length === 0;
  if (fonts.length === 0) {
    showStatus('未检测到可下载的自定义字体。', 'info');
    return;
  }

  const frag = document.createDocumentFragment();
  for (const font of fonts) {
    const item = document.createElement('div');
    item.className = 'font-item';

    const info = document.createElement('div');
    info.className = 'font-info';

    const name = document.createElement('div');
    name.className = 'font-name';
    name.textContent = font.displayName || font.family;
    name.title = font.displayName || font.family;

    const sub = document.createElement('div');
    sub.className = 'font-sub';
    const srcCount = (font.sources && font.sources.length) || 0;
    sub.textContent = font.url
      ? `${srcCount} 个来源 · ${font.primaryFormat || 'auto'}`
      : '未找到可下载的文件来源';

    info.appendChild(name);
    info.appendChild(sub);

    const actions = document.createElement('div');
    actions.className = 'font-actions';
    const hasUrl = !!font.url;
    actions.appendChild(makeBtn('WOFF2', 'btn-woff2', !hasUrl, (b) => downloadFont(font, 'woff2', b)));
    actions.appendChild(makeBtn('TTF', 'btn-ttf', !hasUrl, (b) => downloadFont(font, 'ttf', b)));

    item.appendChild(info);
    item.appendChild(actions);
    frag.appendChild(item);
  }

  listEl.appendChild(frag);
  downloadAllBtn.textContent = '下载全部 WOFF2';
}

function makeBtn(label, cls, disabled, onClick) {
  const btn = document.createElement('button');
  btn.className = `btn ${cls}`;
  btn.textContent = label;
  btn.disabled = disabled;
  btn.addEventListener('click', () => onClick(btn));
  return btn;
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------
async function downloadFont(font, format, btn) {
  if (!font || !font.url) return;
  if (btn) btn.disabled = true;
  try {
    const resp = await chrome.runtime.sendMessage({
      type: 'DOWNLOAD_FONT',
      url: font.url,
      ttfUrl: font.ttfUrl || null,
      family: font.displayName || font.family,
      format,
      filename: font.displayName || font.family,
      tabId: currentTabId,
      sources: font.sources || [],
    });
    if (!resp || !resp.ok) {
      showStatus((resp && resp.error) || '下载失败。', 'error');
      if (btn) btn.disabled = false;
    }
  } catch (err) {
    showStatus(`下载出错：${err.message}`, 'error');
    if (btn) btn.disabled = false;
  }
}

async function downloadAll() {
  const dl = currentFonts.filter((f) => f.url);
  if (dl.length === 0) return;

  setBusy(true);
  downloadAllBtn.disabled = true;
  let okCount = 0;
  try {
    for (const font of dl) {
      const resp = await chrome.runtime.sendMessage({
        type: 'DOWNLOAD_FONT',
        url: font.url,
        ttfUrl: font.ttfUrl || null,
        family: font.displayName || font.family,
        format: 'woff2',
        filename: font.displayName || font.family,
        tabId: currentTabId,
        sources: font.sources || [],
      });
      if (resp && resp.ok) okCount++;
    }
    showStatus(
      okCount === dl.length
        ? `已全部开始下载（${dl.length} 个）。`
        : `已开始下载 ${okCount}/${dl.length} 个，部分失败见浏览器下载提示。`,
      okCount > 0 ? 'ok' : 'error'
    );
  } catch (err) {
    showStatus(`批量下载出错：${err.message}`, 'error');
  } finally {
    setBusy(false);
    downloadAllBtn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------
function setBusy(b) {
  listToggle.disabled = b;
  listToggle.textContent = b ? '扫描中…' : '📋 查看页面全部字体';
}

function showStatus(text, kind) {
  if (!text) {
    statusEl.className = 'status hidden';
    statusEl.textContent = '';
    return;
  }
  statusEl.textContent = text;
  statusEl.className = `status ${kind || 'info'}`;
}