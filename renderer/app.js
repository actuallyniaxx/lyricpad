'use strict';

const $ = (s) => document.querySelector(s);
const editor = $('#editor');
const body = document.body;
const root = document.documentElement;

let settings = {};
let savedContent = '';
let fileName = null; // null = untitled
let S = {}; // UI strings for the current language

function t(key, vars) {
  let str = S[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) str = str.split(`{${k}}`).join(v);
  return str;
}

function applyI18n(lang, strings) {
  S = strings;
  root.lang = lang;
  document.querySelectorAll('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n)));
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
    el.setAttribute('aria-label', el.title);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => (el.placeholder = t(el.dataset.i18nPlaceholder)));
  setFileName(fileName);
  refreshCount();
}
let webview = null;
let currentRhymeUrl = '';
let hasPath = false; // the document lives in a file on disk
let analysis = null; // last result of Prosody.analyze()
const hl = $('#hl');

// ---------- Utilities ----------
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), 1800);
}

function patchSettings(patch) {
  Object.assign(settings, patch);
  window.api.setSettings(patch);
}

function isDirty() {
  return editor.value !== savedContent;
}

let lastDirty = false;
function refreshDirty() {
  const d = isDirty();
  $('#stFile').classList.toggle('dirty', d);
  if (d !== lastDirty) {
    lastDirty = d;
    window.api.setDirty(d);
    if (!d) {
      clearTimeout(draftTimer);
      window.api.clearDraft();
    }
  }
}

// ---------- Autosave and recovery ----------
let draftTimer = null;
let autosaveTimer = null;

function scheduleSaves() {
  // Safety net: mirror unsaved text to a recovery file shortly after typing stops
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    if (isDirty()) window.api.saveDraft(editor.value);
  }, 1000);
  // Real autosave: only for documents that already have a file
  clearTimeout(autosaveTimer);
  if (settings.autosave !== false && hasPath) {
    autosaveTimer = setTimeout(async () => {
      if (!isDirty() || !hasPath || settings.autosave === false) return;
      const ok = await saveDoc(false, true);
      const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
      $('#stSave').textContent = ok ? t('autosaved', { time }) : t('autosaveFail');
    }, 3000);
  }
}

function refreshCount() {
  const v = editor.value;
  const lines = v.length ? v.split('\n').length : 0;
  const words = (v.match(/[\p{L}\p{N}'’-]+/gu) || []).length;
  let txt = `${lines} ${t(lines === 1 ? 'line' : 'lines')} · ${words} ${t(words === 1 ? 'word' : 'words')}`;
  if (analysis && analysis.stats.lyricLines) {
    const st = analysis.stats;
    if (settings.showSyllables !== false) txt += ` · ⌀ ${st.avgSyl.toFixed(1)} ${t('sylAbbr')}`;
    if (settings.showRhymes !== false) txt += ` · ${t('rhymeAbbr')} ${Math.round(st.density * 100)}%`;
  }
  $('#stCount').textContent = txt;
}

function setFileName(name) {
  fileName = name || null;
  $('#stFile').textContent = fileName || t('untitled');
}

function loadIntoEditor(content, name) {
  editor.value = content;
  savedContent = content;
  setFileName(name);
  editor.setSelectionRange(0, 0);
  editor.scrollTop = 0;
  clearTimeout(draftTimer);
  clearTimeout(autosaveTimer);
  $('#stSave').textContent = '';
  renderOverlay();
  refreshDirty();
  editor.focus();
}

// ---------- Syllables and rhymes layer ----------
// The textarea can't colour its own text, so an identical block of text sits
// right behind it and carries the highlights and the numbers in the margins.
function renderOverlay() {
  const showSyl = settings.showSyllables !== false;
  const showRhy = settings.showRhymes !== false;
  const showStress = settings.showStress !== false;
  const showRep = settings.showRepeats !== false;
  body.classList.toggle('gutter', showSyl || showRhy);
  if (!showSyl && !showRhy && !showStress && !showRep) {
    analysis = null;
    hl.replaceChildren();
    refreshCount();
    return;
  }
  analysis = window.Prosody.analyze(editor.value, { internal: settings.internalRhymes !== false });
  const frag = document.createDocumentFragment();
  for (const l of analysis.lines) {
    const div = document.createElement('div');
    div.className = 'ln';
    if (showSyl && l.syl) div.dataset.syl = l.syl;
    if (showRhy && l.letter) {
      div.dataset.letter = l.letter + (l.full ? ' ≡' : '');
      const endRange = l.ranges.find((r) => r.cls !== 'int' && r.cls !== 'ext');
      if (endRange) div.classList.add(`c${endRange.color}`);
    }
    fillLine(div, l, showRhy ? l.ranges : [], showRep ? l.repeats : [], showStress ? l.beats : []);
    frag.append(div);
  }
  hl.replaceChildren(frag);
  syncScroll();
  markActive();
  refreshCount();
}

// Writes one line into the layer. Rhymes and repeated words can overlap
// (a rhyme usually covers half a word, a repetition the whole word), so the
// line is cut at every boundary and each piece gets the marks that apply.
function fillLine(div, l, rhymes, repeats, beats) {
  const text = l.text;
  if (!text) return;
  const cuts = new Set([0, text.length]);
  for (const r of rhymes) cuts.add(r.start).add(r.end);
  for (const r of repeats) cuts.add(r.start).add(r.end);
  const points = [...cuts].sort((a, b) => a - b);
  let bi = 0; // next syllable dot to place

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const rhyme = rhymes.find((r) => a >= r.start && a < r.end);
    const repeat = repeats.find((r) => a >= r.start && a < r.end);
    let box = div;
    if (rhyme || repeat) {
      box = document.createElement('span');
      if (rhyme) {
        box.className = `r ${rhyme.cls} c${rhyme.color}`;
        box.dataset.key = rhyme.key;
        // keep the rounded ends on the outside when a rhyme is cut in two
        if (a > rhyme.start) box.classList.add('mid-l');
        if (b < rhyme.end) box.classList.add('mid-r');
      }
      if (repeat) {
        box.classList.add('rp');
        box.dataset.word = repeat.key;
      }
      div.append(box);
    }
    // Syllable dots: each one hangs under its vowel
    let pos = a;
    while (bi < beats.length && beats[bi].at < b) {
      const at = beats[bi].at;
      if (at >= pos) {
        if (at > pos) box.append(text.slice(pos, at));
        const dot = document.createElement('span');
        dot.className = beats[bi].stressed ? 'sy st' : 'sy';
        dot.textContent = text[at];
        box.append(dot);
        pos = at + 1;
      }
      bi++;
    }
    if (pos < b) box.append(text.slice(pos, b));
  }
}

function syncScroll() {
  hl.style.transform = `translateY(${-editor.scrollTop}px)`;
}

// Light up every rhyme that shares its sound with the line the cursor is on
function markActive() {
  if (!analysis) {
    $('#stInfo').textContent = '';
    return;
  }
  const caret = editor.selectionStart;
  const before = editor.value.slice(0, caret);
  const lineNo = before.split('\n').length - 1;
  const col = caret - (before.lastIndexOf('\n') + 1);
  const line = analysis.lines[lineNo];

  const key = line?.group || null;
  hl.querySelectorAll('.r.on').forEach((el) => el.classList.remove('on'));
  if (key) hl.querySelectorAll('.r').forEach((el) => el.dataset.key === key && el.classList.add('on'));

  // Repeated word under the cursor: light up every use and say how many
  const rp = settings.showRepeats !== false ? line?.repeats.find((r) => col >= r.start && col <= r.end) : null;
  hl.querySelectorAll('.rp.on').forEach((el) => el.classList.remove('on'));
  if (rp) hl.querySelectorAll('.rp').forEach((el) => el.dataset.word === rp.key && el.classList.add('on'));
  $('#stInfo').textContent = rp ? `«${line.text.slice(rp.start, rp.end)}» ×${rp.count}` : '';
}


// Palabra bajo el cursor (la usa el menú contextual si no hay selección)
window.__wordAtCaret = () => {
  const v = editor.value;
  let s = editor.selectionStart;
  let e = editor.selectionEnd;
  if (s !== e) return v.slice(s, e);
  const isL = (ch) => ch && /[\p{L}\p{M}'’-]/u.test(ch);
  while (s > 0 && isL(v[s - 1])) s--;
  while (e < v.length && isL(v[e])) e++;
  return v.slice(s, e);
};

// ---------- Archivo ----------
async function guardUnsaved() {
  if (!isDirty()) return true;
  const r = await window.api.confirmDiscard();
  if (r === 'cancel') return false;
  if (r === 'save') return await saveDoc(false);
  return true;
}

async function newDoc() {
  if (!(await guardUnsaved())) return;
  await window.api.newDoc();
  hasPath = false;
  loadIntoEditor('', null);
}

async function openDoc(givenPath) {
  if (!(await guardUnsaved())) return;
  const res = await window.api.openDoc(givenPath || null);
  if (res) {
    hasPath = true;
    loadIntoEditor(res.content, res.name);
  }
}

async function saveDoc(saveAs, silent) {
  const content = editor.value;
  const res = await window.api.saveDoc(content, !!saveAs, !!silent);
  if (!res) return false;
  hasPath = true;
  savedContent = content;
  setFileName(res.name);
  refreshDirty();
  if (!silent) {
    $('#stSave').textContent = '';
    toast(t('saved'));
  }
  return true;
}

// ---------- Apariencia ----------
function applyTheme(theme) {
  root.dataset.theme = theme;
}
function toggleTheme() {
  const t = settings.theme === 'dark' ? 'light' : 'dark';
  applyTheme(t);
  patchSettings({ theme: t });
}

function applyAlign(a) {
  editor.classList.toggle('center', a === 'center');
  hl.classList.toggle('center', a === 'center');
  document.querySelector('[data-action="align-left"]').classList.toggle('on', a !== 'center');
  document.querySelector('[data-action="align-center"]').classList.toggle('on', a === 'center');
}
function setAlign(a) {
  applyAlign(a);
  patchSettings({ align: a });
}

function applyFont(px) {
  root.style.setProperty('--fs', `${px}px`);
}
function changeFont(delta) {
  const px = delta === 0 ? 18 : Math.min(40, Math.max(11, settings.fontSize + delta));
  applyFont(px);
  patchSettings({ fontSize: px });
  toast(t('fontSize', { px }));
}

// ---------- Panel de rimas ----------
function buildRhymeUrl(word) {
  const tpl = settings.rhymeUrl || settings.defaultRhymeUrl;
  if (!word) {
    try {
      return new URL(tpl.replace(/\{(word|palabra)\}/g, '')).origin + '/';
    } catch {
      return 'https://rimar.io/';
    }
  }
  return tpl.replace(/\{(word|palabra)\}/g, encodeURIComponent(word));
}

function ensureWebview() {
  if (webview) return webview;
  webview = document.createElement('webview');
  webview.setAttribute('partition', 'persist:rimas');
  webview.setAttribute('src', currentRhymeUrl || buildRhymeUrl(''));
  const msg = $('#rhymeMsg');
  webview.addEventListener('did-start-loading', () => body.classList.add('loading'));
  webview.addEventListener('did-stop-loading', () => body.classList.remove('loading'));
  webview.addEventListener('did-fail-load', (e) => {
    if (e.errorCode === -3 || !e.isMainFrame) return; // -3 = cancelado (normal al navegar rápido)
    msg.innerHTML = '';
    msg.append(
      Object.assign(document.createElement('div'), {
        textContent: t('loadFail', { err: e.errorDescription || e.errorCode }),
      })
    );
    msg.hidden = false;
  });
  webview.addEventListener('did-navigate', (e) => {
    msg.hidden = true;
    currentRhymeUrl = e.url;
  });
  $('#rhymeHost').appendChild(webview);
  return webview;
}

function setRhymesOpen(open) {
  body.classList.toggle('rhymes', open);
  document.querySelector('#toolbar [data-action="rhymes"]').classList.toggle('on', open);
  if (open) ensureWebview();
  if (settings.rhymesOpen !== open) patchSettings({ rhymesOpen: open });
}

function lookupRhymes(word) {
  word = (word || '').trim();
  if (!word) {
    toast(t('selectWordFirst'));
    return;
  }
  $('#rhymeInput').value = word;
  const url = buildRhymeUrl(word);
  currentRhymeUrl = url;
  if (!body.classList.contains('rhymes')) setRhymesOpen(true);
  const wv = ensureWebview();
  $('#rhymeMsg').hidden = true;
  try {
    wv.loadURL(url).catch(() => {});
  } catch {
    wv.setAttribute('src', url); // aún no estaba listo
  }
}

function lastWord(text) {
  const w = (text || '').match(/[\p{L}\p{M}'’-]+/gu);
  return w ? w[w.length - 1] : '';
}

// Divisor arrastrable
(() => {
  const divider = $('#divider');
  const shield = $('#dragShield');
  const split = $('#split');
  root.style.setProperty('--ratio', 0.55);
  divider.addEventListener('mousedown', (e) => {
    e.preventDefault();
    body.classList.add('dragging');
    shield.hidden = false;
    const rect = split.getBoundingClientRect();
    const move = (ev) => {
      const r = Math.min(0.8, Math.max(0.2, (ev.clientX - rect.left) / rect.width));
      root.style.setProperty('--ratio', r);
      settings.splitRatio = r;
    };
    const up = () => {
      body.classList.remove('dragging');
      shield.hidden = true;
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      patchSettings({ splitRatio: settings.splitRatio });
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  divider.addEventListener('dblclick', () => {
    root.style.setProperty('--ratio', 0.55);
    patchSettings({ splitRatio: 0.55 });
  });
})();

// ---------- Focus mode ----------
// Full screen with nothing but the text. The rhymes panel is closed on the
// way in and put back on the way out (it can still be opened while inside).
let panelBeforeFocus = false;
function applyFocus(on) {
  if (on === body.classList.contains('focus')) return;
  if (on) {
    panelBeforeFocus = body.classList.contains('rhymes');
    body.classList.remove('rhymes');
    body.classList.add('focus');
    toast(t('focusHint'));
  } else {
    body.classList.remove('focus');
    body.classList.toggle('rhymes', panelBeforeFocus);
    if (panelBeforeFocus) ensureWebview();
  }
  document.querySelector('#toolbar [data-action="rhymes"]').classList.toggle('on', body.classList.contains('rhymes'));
  editor.focus();
}
window.api.onFocusMode((on) => applyFocus(on));
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && body.classList.contains('focus') && $('#modal').hidden) window.api.setFocusMode(false);
});

// ---------- URL personalizada ----------
function openCustomUrlModal() {
  const modal = $('#modal');
  const input = $('#modalInput');
  const err = $('#modalErr');
  input.value = settings.rhymeUrl;
  err.hidden = true;
  modal.hidden = false;
  input.focus();
  input.select();

  let applied = false;
  const close = () => {
    if (!applied) window.api.rebuildMenu(); // el radio del menú vuelve a su estado real
    modal.hidden = true;
    form.removeEventListener('submit', submit);
    $('#modalCancel').removeEventListener('click', close);
    $('#modalReset').removeEventListener('click', reset);
    editor.focus();
  };
  const apply = (url) => {
    applied = true;
    patchSettings({ rhymeUrl: url });
    const w = $('#rhymeInput').value.trim();
    currentRhymeUrl = buildRhymeUrl(w);
    if (webview) webview.loadURL(currentRhymeUrl).catch(() => {});
    close();
  };
  const submit = (e) => {
    e.preventDefault();
    const v = input.value.trim();
    if (!/^https?:\/\//i.test(v)) return showErr(t('errHttp'));
    if (!v.includes('{word}') && !v.includes('{palabra}')) return showErr(t('errToken'));
    apply(v);
  };
  const reset = () => apply(settings.defaultRhymeUrl);
  const showErr = (m) => {
    err.textContent = m;
    err.hidden = false;
  };
  const form = $('#modalForm');
  form.addEventListener('submit', submit);
  $('#modalCancel').addEventListener('click', close);
  $('#modalReset').addEventListener('click', reset);
  modal.onkeydown = (e) => e.key === 'Escape' && close();
}

// ---------- Acciones ----------
const actions = {
  new: newDoc,
  open: () => openDoc(),
  save: () => saveDoc(false),
  saveAs: () => saveDoc(true),
  theme: toggleTheme,
  toggleTheme,
  'align-left': () => setAlign('left'),
  'align-center': () => setAlign('center'),
  align: (a) => setAlign(a),
  rhymes: () => setRhymesOpen(!body.classList.contains('rhymes')),
  toggleRhymes: () => setRhymesOpen(!body.classList.contains('rhymes')),
  rhymeSelection: () => {
    let w = lastWord(window.__wordAtCaret());
    if (!w) {
      // Nothing under the cursor: use the last word of the closest line above
      const before = editor.value.slice(0, editor.selectionStart).split('\n');
      for (let i = before.length - 1; i >= 0 && !w; i--) w = lastWord(before[i]);
    }
    lookupRhymes(w);
  },
  toggleSetting: (key) => {
    const value = settings[key] === false; // undefined counts as on
    patchSettings({ [key]: value });
    if (key === 'autosave') {
      $('#stSave').textContent = '';
      if (value) scheduleSaves();
      else clearTimeout(autosaveTimer);
    } else {
      renderOverlay();
    }
  },
  rhymeWord: (w) => lookupRhymes(w),
  setRhymeUrl: (url) => {
    patchSettings({ rhymeUrl: url });
    currentRhymeUrl = buildRhymeUrl($('#rhymeInput').value.trim());
    if (webview) webview.loadURL(currentRhymeUrl).catch(() => {});
  },
  customRhymeUrl: openCustomUrlModal,
  fontBigger: () => changeFont(+2),
  fontSmaller: () => changeFont(-2),
  fontReset: () => changeFont(0),
  'rh-back': () => webview?.canGoBack() && webview.goBack(),
  'rh-fwd': () => webview?.canGoForward() && webview.goForward(),
  'rh-external': () => {
    const url = currentRhymeUrl || buildRhymeUrl($('#rhymeInput').value.trim());
    window.open(url); // el proceso principal lo abre en el navegador del sistema
  },
};

document.querySelectorAll('[data-action]').forEach((btn) => {
  btn.addEventListener('click', () => {
    actions[btn.dataset.action]?.();
    if (!btn.closest('#rhymeBar')) editor.focus();
  });
});

window.api.onMenu((action, payload) => {
  if (action === 'rhymes') return lookupRhymes(payload);
  actions[action]?.(payload);
});

$('#rhymeForm').addEventListener('submit', (e) => {
  e.preventDefault();
  lookupRhymes($('#rhymeInput').value);
});

// ---------- Editor ----------
editor.addEventListener('input', () => {
  renderOverlay();
  refreshDirty();
  scheduleSaves();
});
editor.addEventListener('scroll', syncScroll);
document.addEventListener('selectionchange', () => {
  if (document.activeElement === editor) markActive();
});

editor.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    document.execCommand('insertText', false, '\t');
  }
});

// Arrastrar y soltar un archivo en la ventana
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (!f) return;
  const p = window.api.pathForFile(f);
  if (p) openDoc(p);
});

// Wait for startup (and any recovery prompt) before opening a file passed to the app
let startupDone;
const startup = new Promise((r) => (startupDone = r));
window.api.onOpenPath(async (p) => {
  await startup;
  openDoc(p);
});

window.api.onRequestClose(async () => {
  if (await guardUnsaved()) window.api.forceClose();
});

window.api.onLang((lang, strings) => applyI18n(lang, strings));
window.api.onUpdateStatus((text) => ($('#stUpdate').textContent = text));

// ---------- Startup ----------
(async () => {
  settings = await window.api.getSettings();
  applyI18n(settings.lang, settings.strings);
  applyTheme(settings.theme);
  applyAlign(settings.align);
  applyFont(settings.fontSize);
  root.style.setProperty('--ratio', settings.splitRatio);
  if (settings.rhymesOpen) setRhymesOpen(true);
  renderOverlay();
  editor.focus();

  // Unsaved work left over from a crash or a power cut?
  const draft = await window.api.recoverDraft();
  if (draft) {
    hasPath = draft.hasPath;
    loadIntoEditor(draft.content, draft.name);
    savedContent = draft.disk; // what's on disk, so the recovered text counts as unsaved
    refreshDirty();
    window.api.saveDraft(editor.value); // keep the net up until it's really saved
  }
  startupDone();
})();
