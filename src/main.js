'use strict';

import './app.css';
import './parser.js'; // sets window.Parser
import { createC2pa } from '@contentauth/c2pa-web';
import wasmSrc from '@contentauth/c2pa-web/resources/c2pa.wasm?url';

/* global Parser */
(function () {
  const IMAGE_EXT = /\.(jpe?g|png|webp|avif|tiff?|gif|heic|heif|dng|bmp)$/i;
  const VIDEO_EXT = /\.(mp4|mov|m4v|avi|webm|mkv)$/i;
  const C2PA_WEB_VERSION = '0.12.3';

  // Trust-list validation (opt-in). With these, a signer on the Content
  // Credentials trust list yields validation_state "Trusted"; otherwise "Valid".
  // Same lists c2patool uses via --trust_anchors / --allowed_list / --trust_config.
  // Direct verify.contentauthenticity.org URLs (CORS-open) to skip the CC redirect.
  const TRUST_SETTINGS = {
    verify: { verifyTrust: true },
    trust: {
      trustAnchors: 'https://verify.contentauthenticity.org/trust/anchors.pem',
      allowedList: 'https://verify.contentauthenticity.org/trust/allowed.sha256.txt',
      trustConfig: 'https://verify.contentauthenticity.org/trust/store.cfg',
    },
  };
  // Default ON: the trust lists are tiny (~52KB) and CORS-open. Respect an
  // explicit saved choice if the user has toggled it before.
  let trustMode = true;
  try {
    const saved = localStorage.getItem('trust');
    if (saved !== null) trustMode = saved === '1';
  } catch {
    /* ignore */
  }

  // MIME hints for extensions the browser leaves blank (helps c2pa-web pick a parser).
  const MIME_BY_EXT = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
    avif: 'image/avif', tif: 'image/tiff', tiff: 'image/tiff', gif: 'image/gif',
    heic: 'image/heic', heif: 'image/heif', dng: 'image/x-adobe-dng', bmp: 'image/bmp',
    mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime', avi: 'video/x-msvideo',
    webm: 'video/webm', mkv: 'video/x-matroska',
  };

  function mimeOf(file) {
    if (file.type) return file.type;
    const ext = file.name.split('.').pop().toLowerCase();
    return MIME_BY_EXT[ext] || 'application/octet-stream';
  }

  /** @type {Array<{id,file,name,url,status,result,vm,error}>} */
  let items = [];
  let selectedId = null;
  let nextId = 1;
  let currentRaw = '';
  let currentName = 'manifest';
  let currentView = 'summary'; // Raw JSON format: summary | detailed | crjson

  // ---------- c2pa-web engine (WASM, initialized once) ----------
  let c2paPromise = null;
  function getC2pa() {
    // createC2pa returns a Promise<C2paSdk>; cache it so the worker/WASM load once.
    if (!c2paPromise) c2paPromise = createC2pa({ wasmSrc });
    return c2paPromise;
  }

  /**
   * Reads a File in the browser and gathers everything the UI needs.
   * Returns { store, reason, views, thumbs }:
   *  - store set        → a manifest was read
   *  - reason 'empty'   → no manifest in this asset
   *  - throws           → a real read/parse error (surfaced to the UI)
   *  - views  → { summary, detailed, crjson } pretty JSON strings (some may be null)
   *  - thumbs → extracted thumbnail object URLs (must be revoked later)
   */
  async function readManifest(file, trust) {
    const c2pa = await getC2pa();
    // fromBlob resolves to null when the asset carries no C2PA manifest.
    // When trust is on, pass the trust-list settings so the signer is checked.
    const reader = await c2pa.reader.fromBlob(mimeOf(file), file, trust ? TRUST_SETTINGS : undefined);
    if (!reader) return { store: null, reason: 'empty' };
    try {
      const store = await reader.manifestStore();
      if (!store) return { store: null, reason: 'empty' };
      const views = {
        summary: JSON.stringify(store, null, 2),
        detailed: await altView(() => reader.json()),
        crjson: await altView(() => reader.crJson()),
      };
      const thumbs = await extractResources(reader, store);
      return { store, reason: 'ok', views, thumbs };
    } finally {
      // Release the WASM-side reader no matter what.
      try { await reader.free(); } catch { /* ignore */ }
    }
  }

  // Alternate manifest serializations (c2patool's --detailed / --crjson).
  async function altView(fn) {
    try {
      const v = await fn();
      if (v == null) return null;
      return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
    } catch {
      return null;
    }
  }

  // Pull thumbnail bytes out of the reader while it is still alive (before free()).
  async function extractResources(reader, store) {
    const out = { active: null, ingredients: [] };
    const m = store.active_manifest && store.manifests ? store.manifests[store.active_manifest] : null;
    if (!m) return out;
    out.active = await resourceUrl(reader, m.thumbnail);
    for (const ing of Array.isArray(m.ingredients) ? m.ingredients : []) {
      out.ingredients.push({
        title: ing.title || ing.format || 'ingredient',
        url: await resourceUrl(reader, ing.thumbnail),
      });
    }
    return out;
  }

  async function resourceUrl(reader, ref) {
    if (!ref || !ref.identifier) return null;
    try {
      const bytes = await reader.resourceToBytes(ref.identifier);
      if (!bytes || !bytes.length) return null;
      return URL.createObjectURL(new Blob([bytes], { type: ref.format || 'image/jpeg' }));
    } catch {
      return null;
    }
  }

  function revokeThumbs(item) {
    if (!item.thumbs) return;
    if (item.thumbs.active) URL.revokeObjectURL(item.thumbs.active);
    for (const ing of item.thumbs.ingredients || []) if (ing.url) URL.revokeObjectURL(ing.url);
    item.thumbs = null;
  }

  // Best-effort scan of the file bytes for a remote manifest URL (for the Info card).
  async function probeRemoteUrl(file) {
    try {
      const cap = Math.min(file.size, 16 * 1024 * 1024);
      const buf = new Uint8Array(await file.slice(0, cap).arrayBuffer());
      const text = new TextDecoder('latin1').decode(buf);
      const m = text.match(/https?:\/\/[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]*manifests?[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]*/i);
      return m ? m[0].replace(/[)\].,'"]+$/, '') : null;
    } catch {
      return null;
    }
  }

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };
  const esc = (s) =>
    String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

  // ---------- Toolbar buttons ----------
  const fileInput = $('#file-input');
  $('#btn-open').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    addFiles(Array.from(fileInput.files || []));
    fileInput.value = ''; // allow re-picking the same file
  });
  $('#btn-clear').addEventListener('click', () => {
    for (const it of items) {
      if (it.url) URL.revokeObjectURL(it.url);
      revokeThumbs(it);
    }
    items = [];
    selectedId = null;
    renderList();
    showEmpty();
  });

  // ---------- Theme toggle (light / dark, overrides the OS preference) ----------
  const themeBtn = $('#btn-theme');
  const SUN_ICON =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>';
  const MOON_ICON =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';

  function resolvedTheme() {
    const attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'light' || attr === 'dark') return attr;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function paintThemeButton(theme) {
    // Show the icon of what a click switches TO.
    themeBtn.innerHTML = theme === 'dark' ? SUN_ICON : MOON_ICON;
    themeBtn.title = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  }
  function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('theme', theme);
    } catch {
      /* ignore */
    }
    paintThemeButton(theme);
  }
  themeBtn.addEventListener('click', () => setTheme(resolvedTheme() === 'dark' ? 'light' : 'dark'));
  // Keep the icon in sync if the OS theme changes and no manual choice is set.
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!document.documentElement.getAttribute('data-theme')) paintThemeButton(resolvedTheme());
  });
  paintThemeButton(resolvedTheme());

  // ---------- Advanced options menu (gear) ----------
  const advBtn = $('#btn-adv');
  const advMenu = $('#adv-menu');
  const swTrust = $('#sw-trust');

  function openAdv(open) {
    advMenu.classList.toggle('hidden', !open);
    advBtn.classList.toggle('on', open);
    advBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  advBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openAdv(advMenu.classList.contains('hidden'));
  });
  document.addEventListener('click', (e) => {
    if (!advMenu.classList.contains('hidden') && !advMenu.contains(e.target) && e.target !== advBtn) {
      openAdv(false);
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') openAdv(false);
  });

  function paintTrustSwitch() {
    swTrust.classList.toggle('on', trustMode);
    swTrust.setAttribute('aria-checked', trustMode ? 'true' : 'false');
  }
  swTrust.addEventListener('click', async () => {
    trustMode = !trustMode;
    try {
      localStorage.setItem('trust', trustMode ? '1' : '0');
    } catch {
      /* ignore */
    }
    paintTrustSwitch();
    // Re-analyze already-loaded assets under the new mode.
    for (const item of items) await analyzeItem(item);
  });
  paintTrustSwitch();

  // ---------- About / Credits ----------
  const aboutEl = $('#about');
  $('#btn-about').addEventListener('click', () => {
    $('#about-version').textContent = 'c2pa-web v' + C2PA_WEB_VERSION;
    aboutEl.classList.remove('hidden');
  });
  $('#about-close').addEventListener('click', () => aboutEl.classList.add('hidden'));
  aboutEl.addEventListener('click', (e) => {
    if (e.target === aboutEl) aboutEl.classList.add('hidden');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') aboutEl.classList.add('hidden');
  });

  // ---------- Tabs ----------
  function activateTab(which) {
    document
      .querySelectorAll('.tab')
      .forEach((t) => t.classList.toggle('active', t.dataset.tab === which));
    $('#panel-summary').classList.toggle('hidden', which !== 'summary');
    $('#panel-tree').classList.toggle('hidden', which !== 'tree');
    $('#panel-raw').classList.toggle('hidden', which !== 'raw');
  }
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => activateTab(tab.dataset.tab));
  });

  // ---------- Raw format selector (summary / detailed / crJSON) ----------
  function setView(view) {
    currentView = view;
    document
      .querySelectorAll('.rawfmt')
      .forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    const item = items.find((it) => it.id === selectedId);
    if (item) renderRaw(item);
  }
  document.querySelectorAll('.rawfmt').forEach((b) => {
    b.addEventListener('click', () => setView(b.dataset.view));
  });

  function renderRaw(item) {
    const views = item.views || { summary: '' };
    const raw = views[currentView] != null ? views[currentView] : views.summary;
    currentRaw = raw || '';
    document.querySelectorAll('.rawfmt').forEach((b) => {
      const v = views[b.dataset.view];
      b.classList.toggle('unavail', b.dataset.view !== 'summary' && (v == null || v === ''));
    });
    $('#json').innerHTML = currentRaw ? highlightJSON(currentRaw) : emptyJsonNote(item);
    jsonBaseHTML = $('#json').innerHTML;
    if (!findBar.classList.contains('hidden')) runFind();
  }

  // ---------- Raw JSON actions ----------
  $('#btn-copy').addEventListener('click', async () => {
    await copyText(currentRaw);
    flash('Copied to clipboard');
  });
  $('#btn-save').addEventListener('click', () => {
    if (!currentRaw) return;
    const base = currentName.replace(/\.[^.]+$/, '') || 'manifest';
    const blob = new Blob([currentRaw], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = base + '.c2pa.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    flash('Saved');
  });
  function flash(msg) {
    $('#raw-status').textContent = msg;
    if (msg) setTimeout(() => ($('#raw-status').textContent = ''), 2500);
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return;
      }
    } catch {
      /* fall through */
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }

  // ---------- Find in JSON (Ctrl/Cmd+F) ----------
  const findBar = $('#find-bar');
  const findInput = $('#find-input');
  const findCount = $('#find-count');
  let findHits = [];
  let findIndex = -1;
  let jsonBaseHTML = ''; // clean highlighted JSON, before any find marks

  function openFind() {
    if ($('#result').classList.contains('hidden')) return; // nothing to search
    activateTab('raw');
    findBar.classList.remove('hidden');
    findInput.focus();
    findInput.select();
    if (findInput.value) runFind();
  }

  function closeFind() {
    findBar.classList.add('hidden');
    if (jsonBaseHTML) $('#json').innerHTML = jsonBaseHTML;
    findHits = [];
    findIndex = -1;
    findCount.textContent = '';
  }

  function runFind() {
    const q = findInput.value;
    const box = $('#json');
    if (jsonBaseHTML) box.innerHTML = jsonBaseHTML;
    findHits = [];
    findIndex = -1;
    if (!q) {
      findCount.textContent = '';
      return;
    }
    const needle = q.toLowerCase();

    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT, null);
    const nodes = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);

    for (const node of nodes) {
      const text = node.nodeValue;
      const lower = text.toLowerCase();
      let idx = lower.indexOf(needle);
      if (idx === -1) continue;
      const frag = document.createDocumentFragment();
      let last = 0;
      while (idx !== -1) {
        if (idx > last) frag.appendChild(document.createTextNode(text.slice(last, idx)));
        const mark = document.createElement('mark');
        mark.className = 'find-hit';
        mark.textContent = text.slice(idx, idx + q.length);
        frag.appendChild(mark);
        findHits.push(mark);
        last = idx + q.length;
        idx = lower.indexOf(needle, last);
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    }

    if (findHits.length) setFindIndex(0);
    else findCount.textContent = 'No results';
  }

  function setFindIndex(i) {
    if (!findHits.length) return;
    if (findIndex >= 0 && findHits[findIndex]) findHits[findIndex].classList.remove('current');
    findIndex = ((i % findHits.length) + findHits.length) % findHits.length;
    const cur = findHits[findIndex];
    cur.classList.add('current');
    cur.scrollIntoView({ block: 'center', behavior: 'smooth' });
    findCount.textContent = `${findIndex + 1} / ${findHits.length}`;
  }

  findInput.addEventListener('input', runFind);
  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      setFindIndex(findIndex + (e.shiftKey ? -1 : 1));
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeFind();
    }
  });
  $('#find-next').addEventListener('click', () => setFindIndex(findIndex + 1));
  $('#find-prev').addEventListener('click', () => setFindIndex(findIndex - 1));
  $('#find-close').addEventListener('click', closeFind);

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      openFind();
    }
  });

  // ---------- Drag & drop ----------
  const mask = $('#dropmask');
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    mask.classList.remove('hidden');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    if (--dragDepth <= 0) {
      dragDepth = 0;
      mask.classList.add('hidden');
    }
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    mask.classList.add('hidden');
    addFiles(Array.from(e.dataTransfer.files || []));
  });

  // ---------- Core ----------
  async function addFiles(files) {
    if (!files || !files.length) return;
    const fresh = [];
    for (const file of files) {
      const item = {
        id: 'f' + nextId++,
        file,
        name: file.name,
        url: URL.createObjectURL(file),
        status: 'pending',
        result: null,
        vm: null,
        error: null,
      };
      items.push(item);
      fresh.push(item);
    }
    renderList();
    if (!selectedId && fresh.length) select(fresh[0].id);
    for (const item of fresh) {
      await analyzeItem(item);
    }
  }

  function applyStore(item, res) {
    item.views = res.views;
    item.thumbs = res.thumbs;
    item.vm = Parser.parse(res.store);
    if (item.vm) item.vm.trustUnavailable = !!item.trustUnavailable;
    item.status = item.vm ? item.vm.validationBadge : 'none';
    item.reason = 'ok';
    item.error = null;
  }

  async function analyzeItem(item) {
    item.status = 'pending';
    item.reason = 'reading';
    renderList();
    if (selectedId === item.id) renderDetail(item);

    // Read in the browser. For a remote manifest, c2pa-web fetches it directly
    // (subject to the manifest host's CORS policy).
    try {
      let res;
      item.trustUnavailable = false;
      try {
        res = await readManifest(item.file, trustMode);
      } catch (e) {
        // Trust check may have failed because the trust list couldn't be
        // fetched (offline, etc.). Retry without it so the manifest still reads.
        if (trustMode) {
          res = await readManifest(item.file, false);
          item.trustUnavailable = true;
        } else {
          throw e;
        }
      }
      revokeThumbs(item);
      if (res.store) {
        applyStore(item, res);
        item.probe = { remoteUrl: await probeRemoteUrl(item.file) };
      } else {
        item.views = { summary: '' };
        item.vm = null;
        item.probe = null;
        item.status = 'none';
        item.reason = 'empty';
        item.error = null;
      }
    } catch (e) {
      revokeThumbs(item);
      item.views = { summary: '' };
      item.vm = null;
      item.probe = null;
      item.status = 'none';
      item.reason = 'error';
      item.error = (e && e.message) || String(e);
    }
    finishAnalyze(item);
  }

  function finishAnalyze(item) {
    renderList();
    if (selectedId === item.id) renderDetail(item);
  }

  function select(id) {
    selectedId = id;
    renderList();
    const item = items.find((it) => it.id === id);
    if (item) renderDetail(item);
  }

  // ---------- Sidebar ----------
  function renderList() {
    const list = $('#list');
    list.innerHTML = '';
    for (const item of items) {
      const li = el('li', 'list-item' + (item.id === selectedId ? ' active' : ''));
      li.appendChild(thumbEl('li-thumb', item));

      const body = el('div', 'li-body');
      body.appendChild(el('div', 'li-name', esc(item.name)));
      body.appendChild(el('div', 'li-sub', statusText(item)));
      li.appendChild(body);

      li.appendChild(el('span', 'li-status ' + item.status));
      li.addEventListener('click', () => select(item.id));
      list.appendChild(li);
    }
  }

  function statusText(item) {
    if (item.status === 'pending') return 'Analyzing…';
    if (!item.vm) return 'No Content Credentials';
    const a = item.vm.active;
    const gen = a && a.generators[0] ? a.generators[0].name : item.vm.validationState;
    return esc(gen);
  }

  function thumbEl(cls, item) {
    const box = el('div', cls);
    if (IMAGE_EXT.test(item.name) || /^image\//.test(item.file.type)) {
      const img = el('img');
      img.src = item.url;
      img.onerror = () => (box.textContent = '🖼');
      box.appendChild(img);
    } else if (VIDEO_EXT.test(item.name) || /^video\//.test(item.file.type)) {
      const v = el('video');
      v.src = item.url;
      v.muted = true;
      v.preload = 'metadata';
      v.addEventListener('loadeddata', () => {
        try {
          v.currentTime = 0.1;
        } catch {
          /* ignore */
        }
      });
      v.onerror = () => (box.textContent = '🎞');
      box.appendChild(v);
    } else {
      box.textContent = '📄';
    }
    return box;
  }

  // ---------- Detail ----------
  function showEmpty() {
    $('#empty').classList.remove('hidden');
    $('#result').classList.add('hidden');
  }

  function renderDetail(item) {
    $('#empty').classList.add('hidden');
    $('#result').classList.remove('hidden');

    $('#thumb').replaceWith(buildThumb(item));
    $('#r-name').textContent = item.name;
    $('#r-sub').textContent = fmtSize(item.file.size);

    $('#cards').innerHTML = item.vm ? buildCards(item.vm, item) : buildNoManifest(item);
    $('#tree').innerHTML = item.vm
      ? buildTree(item.vm)
      : '<div class="tree-empty muted">No manifest to chart.</div>';

    currentName = item.name;
    renderRaw(item);
  }

  function fmtSize(bytes) {
    if (bytes == null) return '';
    const u = ['B', 'KB', 'MB', 'GB'];
    let n = bytes;
    let i = 0;
    while (n >= 1024 && i < u.length - 1) {
      n /= 1024;
      i++;
    }
    return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
  }

  function buildThumb(item) {
    const box = thumbEl('thumb', item);
    box.id = 'thumb';
    return box;
  }

  function row(k, v, mono) {
    if (v == null || v === '') return '';
    return `<div class="row"><span class="k">${esc(k)}</span><span class="v${mono ? ' mono' : ''}">${v}</span></div>`;
  }

  function card(title, inner, span) {
    if (!inner) return '';
    return `<div class="card${span ? ' span-2' : ''}"><h2>${esc(title)}</h2>${inner}</div>`;
  }

  function fmtTime(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    return isNaN(d) ? esc(iso) : d.toLocaleString();
  }

  function buildCards(P, item) {
    const A = P.active;
    const cards = [];

    // Validation
    let valInner = row('State', `<span class="pill ${P.validationBadge}">${esc(P.validationState)}</span>`);
    let trustVal;
    if (!trustMode) {
      trustVal = '<span class="muted">off (enable in ⚙ to see Trusted/Untrusted)</span>';
    } else if (P.trustUnavailable) {
      trustVal = '<span class="muted">unavailable — could not load the trust list</span>';
    } else {
      trustVal = '<span class="pill accent">verified vs contentcredentials.org</span>';
    }
    valInner += row('Trust check', trustVal);
    valInner += row('Checks passed', P.successes != null ? String(P.successes) : null);
    valInner += row('Manifests in store', String(P.manifests.length));
    if (P.claimVersions && P.claimVersions.length) {
      const multi = P.claimVersions.length > 1;
      const pills = P.claimVersions
        .map((v) => `<span class="pill${multi ? ' multi' : ''}">v${esc(v)}</span>`)
        .join(' ');
      valInner += row(multi ? 'Claim versions ⚠' : 'Claim version', pills);
    }
    for (const f of P.failures) {
      valInner += row(Parser.prettify(f.code), esc(f.explanation));
    }
    for (const f of P.informational) {
      valInner += row(Parser.prettify(f.code), esc(f.explanation));
    }
    cards.push(card('Validation', valInner));

    // Info (c2patool's --info: source, stats)
    const remote = item && item.probe && item.probe.remoteUrl;
    let infoInner = row(
      'Manifest source',
      remote
        ? `<span class="pill">remote</span> <span class="v mono small">${esc(remote)}</span>`
        : 'embedded in the file',
    );
    infoInner += row('Active manifest', P.activeId ? `<span class="mono small">${esc(P.activeId)}</span>` : null);
    infoInner += row('Ingredients', A ? String(A.ingredients.length) : null);
    if (item) infoInner += row('File', `${esc(item.name)} · ${fmtSize(item.file.size)}`);
    cards.push(card('Info', infoInner));

    if (A) {
      // Content credentials
      const gens = A.generators
        .map((g) => `<span class="pill accent">${esc(g.name)}${g.version ? ' ' + esc(g.version) : ''}</span>`)
        .join(' ');
      let ccInner = '';
      if (item && item.thumbs && item.thumbs.active) {
        ccInner += `<div class="cc-thumb"><img src="${item.thumbs.active}" alt="Manifest thumbnail" loading="lazy" /></div>`;
      }
      ccInner += row('Generator', gens || null);
      ccInner += row('Produced by', A.softwareAgent ? esc(A.softwareAgent) : null);
      ccInner += row(
        'Content type',
        A.aiGenerated
          ? `<span class="pill ai">AI-generated</span>`
          : A.digitalSourceLabel
          ? esc(A.digitalSourceLabel)
          : null,
      );
      ccInner += row('Source type', A.aiGenerated && A.digitalSourceLabel ? esc(A.digitalSourceLabel) : null);
      ccInner += row('Format', A.format ? esc(A.format) : null);
      ccInner += row('Claim version', A.claimVersion != null ? String(A.claimVersion) : null);
      cards.push(card('Content Credentials', ccInner));

      // AI model
      if (A.model) {
        let mInner = row('Model', A.model.details ? esc(A.model.details) : null);
        mInner += row('Model version', A.model.version ? esc(A.model.version) : null);
        mInner += row('Model id', A.model.id ? esc(A.model.id) : null);
        mInner += row('Provider type', A.model.type ? esc(A.model.type) : null);
        mInner += row('Gen AI id', A.model.genAiId ? esc(A.model.genAiId) : null, true);
        cards.push(card('AI Model', mInner));
      }

      // Signature
      if (A.signature) {
        const s = A.signature;
        let sInner = row('Issuer', s.issuer ? esc(s.issuer) : null);
        sInner += row('Common name', s.commonName ? esc(s.commonName) : null);
        sInner += row('Algorithm', s.alg ? esc(s.alg) : null);
        sInner += row('Signed at', fmtTime(s.time));
        sInner += row('Cert serial', s.certSerial ? esc(s.certSerial) : null, true);
        cards.push(card('Signature', sInner));
      }

      // Provenance / ingredients
      if (A.ingredients.length) {
        const chain = A.ingredients
          .map((ing, i) => {
            const ref = ing.activeManifest && P.byId[ing.activeManifest];
            const gen = ref && ref.generators[0] ? `${ref.generators[0].name}` : '';
            const signer = ref && ref.signature ? ref.signature.issuer : '';
            const cv = ref && ref.claimVersion != null ? `claim v${ref.claimVersion}` : '';
            const rel = ing.relationship ? `<span class="pill">${esc(ing.relationship)}</span>` : '';
            const meta = [gen, signer, cv].filter(Boolean).map(esc).join(' · ');
            const tu = item && item.thumbs && item.thumbs.ingredients[i] && item.thumbs.ingredients[i].url;
            const lead = tu
              ? `<span class="chain-thumb"><img src="${tu}" alt="" loading="lazy" /></span>`
              : `<span class="idx">${i + 1}</span>`;
            return `<div class="chain-item">${lead}<div><div>${esc(
              ing.title,
            )} ${rel}</div>${meta ? `<div class="li-sub">${meta}</div>` : ''}</div></div>`;
          })
          .join('');
        cards.push(card('Provenance (ingredients)', `<div class="chain">${chain}</div>`, true));
      }
    }

    return cards.join('');
  }

  // ---------- Provenance tree (like c2patool --tree) ----------
  function buildTree(P) {
    if (!P.active) return '<div class="tree-empty muted">No active manifest to chart.</div>';
    const seen = new Set();
    return `<ul class="tree">${manifestBranch(P, P.active, seen, true)}</ul>`;
  }

  function manifestBranch(P, m, seen, isRoot) {
    seen.add(m.id);
    const g = m.generators && m.generators[0];
    const title = g ? esc(g.name) + (g.version ? ' ' + esc(g.version) : '') : 'Unknown generator';
    const isActive = P.active && m.id === P.active.id;
    const state = isActive ? `<span class="pill ${P.validationBadge}">${esc(P.validationState)}</span>` : '';
    const ai = m.aiGenerated ? '<span class="pill ai">AI</span>' : '';
    const cv = m.claimVersion != null ? `<span class="pill">v${esc(m.claimVersion)}</span>` : '';
    const signer = m.signature && m.signature.issuer
      ? `<div class="li-sub">signed by ${esc(m.signature.issuer)}</div>`
      : '';
    const head = `<div class="tnode manifest${isRoot ? ' root' : ''}"><span class="tbadge m">M</span>` +
      `<div class="tname"><div>${title} ${state} ${ai} ${cv}</div>${signer}</div></div>`;

    const ings = Array.isArray(m.ingredients) ? m.ingredients : [];
    const kids = ings.length ? `<ul>${ings.map((ing) => ingredientLi(P, ing, seen)).join('')}</ul>` : '';
    return `<li>${head}${kids}</li>`;
  }

  function ingredientLi(P, ing, seen) {
    const rel = ing.relationship ? `<span class="pill">${esc(ing.relationship)}</span>` : '';
    const node = `<div class="tnode ing"><span class="tbadge i">i</span>` +
      `<div class="tname"><div>${esc(ing.title)} ${rel}</div></div></div>`;
    const ref = ing.activeManifest && P.byId[ing.activeManifest];
    const sub = ref && !seen.has(ref.id) ? `<ul>${manifestBranch(P, ref, seen, false)}</ul>` : '';
    return `<li>${node}${sub}</li>`;
  }

  function buildNoManifest(item) {
    if (item.reason === 'error') {
      const isRemote = /RemoteManifestFetch/i.test(item.error || '');
      const note = isRemote
        ? `<div class="row"><span class="v muted">This asset stores its Content Credentials as a <b>remote manifest</b> (a URL, not embedded). ` +
          `The browser could not fetch it. This usually means the manifest host blocked the request (CORS), ` +
          `or it is on a private network you are not connected to (for some assets you may need the right VPN).</span></div>`
        : '';
      return card(
        isRemote ? 'Remote manifest could not be fetched' : 'Could not read',
        `<div class="row"><span class="v">c2pa-web could not read this file:</span></div>` +
          `<div class="row"><span class="v mono">${esc(item.error)}</span></div>` +
          note,
        true,
      );
    }
    // reason === 'empty' (or unknown): no embedded manifest found.
    return card(
      'No embedded Content Credentials',
      `<div class="row"><span class="v">No C2PA manifest is embedded in this file's bytes.</span></div>` +
        `<div class="row"><span class="v muted">Some tools (e.g. Runway) store credentials as a <b>remote manifest</b> referenced by URL. ` +
        `This in-browser reader only reads embedded manifests; the desktop C2PA Inspector fetches remote ones. ` +
        `To support them here we'd need a small backend that runs c2patool with remote fetch.</span></div>`,
      true,
    );
  }

  function emptyJsonNote(item) {
    const msg = item.error ? esc(item.error) : 'No manifest data.';
    return `<div class="jline"><span class="jcode">${msg}</span></div>`;
  }

  // ---------- JSON syntax highlighter (dependency-free) ----------
  function highlightJSON(value) {
    let json = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    try {
      if (typeof value === 'string') json = JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      /* keep as-is */
    }
    json = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    json = json.replace(
      /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?)/g,
      (m) => {
        let cls = 'tok-num';
        if (/^"/.test(m)) cls = /:\s*$/.test(m) ? 'tok-key' : 'tok-str';
        else if (/^(true|false)$/.test(m)) cls = 'tok-bool';
        else if (/^null$/.test(m)) cls = 'tok-null';
        return `<span class="${cls}">${m}</span>`;
      },
    );
    return json
      .split('\n')
      .map((line) => `<div class="jline"><span class="jcode">${line.length ? line : ' '}</span></div>`)
      .join('');
  }

  // ---------- Init ----------
  $('#tool-version').textContent = 'c2pa-web v' + C2PA_WEB_VERSION;
  // Warm up the WASM engine in the background so the first drop feels instant.
  getC2pa().catch(() => {});
})();
