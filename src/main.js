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

  // ---------- c2pa-web engine (WASM, initialized once) ----------
  let c2paPromise = null;
  function getC2pa() {
    // createC2pa returns a Promise<C2paSdk>; cache it so the worker/WASM load once.
    if (!c2paPromise) c2paPromise = createC2pa({ wasmSrc });
    return c2paPromise;
  }

  /**
   * Reads a File in the browser.
   * Returns { store, raw, reason }:
   *  - store set        → a manifest was read
   *  - reason 'empty'   → fromBlob returned null: no manifest embedded in the bytes
   *  - throws           → an actual read/parse error (message surfaced to the UI)
   */
  async function readManifest(file) {
    const c2pa = await getC2pa();
    // fromBlob resolves to null when the asset carries no *embedded* C2PA manifest.
    const reader = await c2pa.reader.fromBlob(mimeOf(file), file);
    if (!reader) return { store: null, raw: '', reason: 'empty' };
    try {
      const store = await reader.manifestStore();
      const raw = store ? JSON.stringify(store, null, 2) : '';
      return { store, raw, reason: store ? 'ok' : 'empty' };
    } finally {
      // Release the WASM-side reader no matter what.
      try { await reader.free(); } catch { /* ignore */ }
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
    for (const it of items) if (it.url) URL.revokeObjectURL(it.url);
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
    $('#panel-raw').classList.toggle('hidden', which !== 'raw');
  }
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => activateTab(tab.dataset.tab));
  });

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

  function applyStore(item, store, raw) {
    item.result = { raw };
    item.vm = Parser.parse(store);
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
      const { store, raw } = await readManifest(item.file);
      if (store) {
        applyStore(item, store, raw);
      } else {
        item.result = { raw };
        item.vm = null;
        item.status = 'none';
        item.reason = 'empty';
        item.error = null;
      }
    } catch (e) {
      item.result = { raw: '' };
      item.vm = null;
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

    const badge = $('#r-state');
    if (item.status === 'pending') {
      setBadge(badge, 'none', 'Analyzing…');
    } else if (item.vm) {
      setBadge(badge, item.vm.validationBadge, item.vm.validationState);
    } else {
      setBadge(badge, 'none', 'No Content Credentials');
    }

    $('#cards').innerHTML = item.vm ? buildCards(item.vm) : buildNoManifest(item);

    currentRaw = item.result && item.result.raw ? item.result.raw : '';
    currentName = item.name;
    $('#json').innerHTML = currentRaw ? highlightJSON(currentRaw) : emptyJsonNote(item);
    jsonBaseHTML = $('#json').innerHTML;
    if (!findBar.classList.contains('hidden')) runFind();
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

  function setBadge(node, cls, text) {
    node.className = 'state-badge ' + cls;
    node.textContent = text;
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

  function buildCards(P) {
    const A = P.active;
    const cards = [];

    // Validation
    let valInner = row('State', `<span class="pill ${P.validationBadge}">${esc(P.validationState)}</span>`);
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

    if (A) {
      // Content credentials
      const gens = A.generators
        .map((g) => `<span class="pill accent">${esc(g.name)}${g.version ? ' ' + esc(g.version) : ''}</span>`)
        .join(' ');
      let ccInner = row('Generator', gens || null);
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
            return `<div class="chain-item"><span class="idx">${i + 1}</span><div><div>${esc(
              ing.title,
            )} ${rel}</div>${meta ? `<div class="li-sub">${meta}</div>` : ''}</div></div>`;
          })
          .join('');
        cards.push(card('Provenance (ingredients)', `<div class="chain">${chain}</div>`, true));
      }
    }

    return cards.join('');
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
