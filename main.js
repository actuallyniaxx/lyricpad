const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { strings, LANGS, tr } = require('./i18n');
const updater = require('./updater');

const APP_NAME = 'Lyricpad';

// ---------- Rhyme services ----------
// {word} is replaced by the (URL-encoded) word. {palabra} is accepted too.
const RHYME_SERVICES = [
  { id: 'rimar', label: 'rimar.io (ES)', url: 'https://rimar.io/?Word={word}&loc=hp&adv_rhy=1' },
  { id: 'rhymezone', label: 'RhymeZone (EN)', url: 'https://www.rhymezone.com/r/rhyme.cgi?Word={word}&typeofrhyme=perfect' },
];

// ---------- Persistent settings ----------
const defaults = {
  lang: null, // decided on first run from the system locale
  theme: 'dark',
  align: 'left',
  fontSize: 18,
  rhymesOpen: false,
  splitRatio: 0.55,
  rhymeUrl: RHYME_SERVICES[0].url,
  bounds: { width: 1200, height: 800 },
  maximized: false,
  autoUpdate: true,
  lastUpdateCheck: 0,
  skipVersion: null,
  autosave: true,
  showSyllables: true,
  showRhymes: true,
  internalRhymes: true,
};
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
let settings = { ...defaults };

function loadSettings() {
  try {
    settings = { ...defaults, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) };
  } catch {
    settings = { ...defaults };
  }
  if (!LANGS.includes(settings.lang)) {
    settings.lang = app.getLocale().toLowerCase().startsWith('es') ? 'es' : 'en';
  }
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  } catch (e) {
    console.error('Could not save settings', e);
  }
}

const t = (key, vars) => tr(settings.lang, key, vars);

// ---------- Recovery draft ----------
// While there are unsaved changes, the text is mirrored to a small file in the
// app's data folder. It is removed whenever the document is saved, closed on
// purpose or replaced, so it only survives a crash, a kill or a power cut.
const draftPath = () => path.join(app.getPath('userData'), 'recovery.json');

function writeDraft(content) {
  try {
    const tmp = `${draftPath()}.tmp`;
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ content, path: currentPath, savedAt: Date.now() }));
    fs.renameSync(tmp, draftPath()); // atomic: never leaves a half-written draft
  } catch (e) {
    console.error('Could not write recovery draft', e);
  }
}

function clearDraft() {
  try {
    fs.rmSync(draftPath(), { force: true });
  } catch {}
}

function readDraft() {
  try {
    const d = JSON.parse(fs.readFileSync(draftPath(), 'utf8'));
    return typeof d.content === 'string' && d.content.length ? d : null;
  } catch {
    return null;
  }
}

// ---------- Document state ----------
let win = null;
let currentPath = null;
let dirty = false;
let allowClose = false;

const fileFilters = () => [
  { name: t('fText'), extensions: ['txt', 'md', 'lrc'] },
  { name: t('fAll'), extensions: ['*'] },
];

function updateTitle() {
  if (!win) return;
  const name = currentPath ? path.basename(currentPath) : t('untitled');
  win.setTitle(`${dirty ? '• ' : ''}${name} — ${APP_NAME}`);
  win.setDocumentEdited?.(dirty);
}

function readText(p) {
  let text = fs.readFileSync(p, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM
  return text;
}

// ---------- Window ----------
function createWindow() {
  win = new BrowserWindow({
    ...settings.bounds,
    minWidth: 520,
    minHeight: 360,
    title: APP_NAME,
    backgroundColor: settings.theme === 'dark' ? '#16161a' : '#faf8f4',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      spellcheck: true,
    },
  });
  if (settings.maximized) win.maximize();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Keep our own title (file name + unsaved dot) instead of the page's <title>
  win.on('page-title-updated', (e) => e.preventDefault());
  updateTitle();
  win.once('ready-to-show', () => win.show());
  applySpellcheckLang();

  win.on('close', (e) => {
    settings.maximized = win.isMaximized();
    if (!settings.maximized) settings.bounds = win.getBounds();
    saveSettings();

    if (dirty && !allowClose) {
      e.preventDefault();
      win.webContents.send('request-close');
    }
  });
  win.on('closed', () => (win = null));

  buildMenu();
}

function applySpellcheckLang() {
  // On Windows the OS spellchecker is used and this may be ignored — that's fine.
  try {
    win.webContents.session.setSpellCheckerLanguages([settings.lang === 'es' ? 'es-ES' : 'en-US']);
  } catch {}
}

function send(action, payload) {
  win?.webContents.send('menu', action, payload);
}

function buildMenu() {
  const isPreset = RHYME_SERVICES.some((s) => s.url === settings.rhymeUrl);
  const template = [
    {
      label: t('mFile'),
      submenu: [
        { label: t('mNew'), accelerator: 'CmdOrCtrl+N', click: () => send('new') },
        { label: t('mOpen'), accelerator: 'CmdOrCtrl+O', click: () => send('open') },
        { type: 'separator' },
        { label: t('mSave'), accelerator: 'CmdOrCtrl+S', click: () => send('save') },
        { label: t('mSaveAs'), accelerator: 'CmdOrCtrl+Shift+S', click: () => send('saveAs') },
        {
          label: t('mAutosave'),
          type: 'checkbox',
          checked: settings.autosave !== false,
          click: () => send('toggleSetting', 'autosave'),
        },
        { type: 'separator' },
        { label: t('mQuit'), accelerator: 'Alt+F4', click: () => win?.close() },
      ],
    },
    {
      label: t('mEdit'),
      submenu: [
        { label: t('mUndo'), role: 'undo' },
        { label: t('mRedo'), role: 'redo' },
        { type: 'separator' },
        { label: t('mCut'), role: 'cut' },
        { label: t('mCopy'), role: 'copy' },
        { label: t('mPaste'), role: 'paste' },
        { label: t('mSelectAll'), role: 'selectAll' },
        { type: 'separator' },
        { label: t('mRhymeSelection'), accelerator: 'CmdOrCtrl+R', click: () => send('rhymeSelection') },
      ],
    },
    {
      label: t('mView'),
      submenu: [
        {
          label: t('mDarkTheme'),
          type: 'checkbox',
          checked: settings.theme === 'dark',
          accelerator: 'CmdOrCtrl+T',
          click: () => send('toggleTheme'),
        },
        { type: 'separator' },
        {
          label: t('mAlignLeft'),
          type: 'radio',
          checked: settings.align === 'left',
          accelerator: 'CmdOrCtrl+L',
          click: () => send('align', 'left'),
        },
        {
          label: t('mAlignCenter'),
          type: 'radio',
          checked: settings.align === 'center',
          accelerator: 'CmdOrCtrl+E',
          click: () => send('align', 'center'),
        },
        { type: 'separator' },
        {
          label: t('mSyllables'),
          type: 'checkbox',
          checked: settings.showSyllables !== false,
          accelerator: 'CmdOrCtrl+Shift+Y',
          click: () => send('toggleSetting', 'showSyllables'),
        },
        {
          label: t('mRhymeColors'),
          type: 'checkbox',
          checked: settings.showRhymes !== false,
          accelerator: 'CmdOrCtrl+Shift+H',
          click: () => send('toggleSetting', 'showRhymes'),
        },
        {
          label: t('mInternalRhymes'),
          type: 'checkbox',
          checked: settings.internalRhymes !== false,
          enabled: settings.showRhymes !== false,
          click: () => send('toggleSetting', 'internalRhymes'),
        },
        { type: 'separator' },
        {
          label: t('mRhymePanel'),
          type: 'checkbox',
          checked: settings.rhymesOpen,
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => send('toggleRhymes'),
        },
        {
          label: t('mRhymeService'),
          submenu: [
            ...RHYME_SERVICES.map((s) => ({
              label: s.label,
              type: 'radio',
              checked: settings.rhymeUrl === s.url,
              click: () => send('setRhymeUrl', s.url),
            })),
            { type: 'separator' },
            { label: t('mCustom'), type: 'radio', checked: !isPreset, click: () => send('customRhymeUrl') },
          ],
        },
        {
          label: t('mLanguage'),
          submenu: [
            { label: 'English', type: 'radio', checked: settings.lang === 'en', click: () => setLang('en') },
            { label: 'Español', type: 'radio', checked: settings.lang === 'es', click: () => setLang('es') },
          ],
        },
        { type: 'separator' },
        { label: t('mBigger'), accelerator: 'CmdOrCtrl+=', click: () => send('fontBigger') },
        { label: t('mSmaller'), accelerator: 'CmdOrCtrl+-', click: () => send('fontSmaller') },
        { label: t('mResetSize'), accelerator: 'CmdOrCtrl+0', click: () => send('fontReset') },
        { type: 'separator' },
        { label: t('mFullscreen'), role: 'togglefullscreen', accelerator: 'F11' },
        { label: 'DevTools', role: 'toggleDevTools', accelerator: 'CmdOrCtrl+Shift+I', visible: false },
      ],
    },
    {
      label: t('mHelp'),
      submenu: [
        { label: t('mCheckUpdates'), click: () => updater.check() },
        {
          label: t('mAutoUpdate'),
          type: 'checkbox',
          checked: settings.autoUpdate !== false,
          click: (item) => {
            settings.autoUpdate = item.checked;
            saveSettings();
          },
        },
        { type: 'separator' },
        { label: t('mGitHub'), click: () => shell.openExternal('https://github.com/actuallyniaxx/lyricpad') },
        { label: t('mAbout'), click: showAbout },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function showAbout() {
  dialog.showMessageBox(win, {
    type: 'info',
    title: APP_NAME,
    message: `${APP_NAME} ${app.getVersion()}`,
    detail: t(updater.isPortable() ? 'aboutPortable' : 'aboutInstalled') + '\n\ngithub.com/actuallyniaxx/lyricpad\nMIT License',
    buttons: ['OK'],
    noLink: true,
  });
}

function setLang(lang) {
  if (!LANGS.includes(lang) || lang === settings.lang) return;
  settings.lang = lang;
  saveSettings();
  buildMenu();
  updateTitle();
  applySpellcheckLang();
  win?.webContents.send('lang', lang, strings[lang]);
}

// ---------- IPC ----------
ipcMain.handle('settings:get', () => ({
  ...settings,
  defaultRhymeUrl: RHYME_SERVICES[0].url,
  strings: strings[settings.lang],
}));

ipcMain.handle('settings:set', (_e, patch) => {
  const menuRelevant = [
    'theme', 'align', 'rhymesOpen', 'rhymeUrl', 'autosave', 'showSyllables', 'showRhymes', 'internalRhymes',
  ].some(
    (k) => k in patch && patch[k] !== settings[k]
  );
  delete patch.lang; // language only changes through setLang
  settings = { ...settings, ...patch };
  saveSettings();
  if (menuRelevant) buildMenu();
  if (patch.theme && win) win.setBackgroundColor(patch.theme === 'dark' ? '#16161a' : '#faf8f4');
});

ipcMain.handle('menu:rebuild', () => buildMenu());

ipcMain.handle('doc:setDirty', (_e, value) => {
  dirty = !!value;
  updateTitle();
});

ipcMain.handle('draft:save', (_e, content) => writeDraft(String(content)));
ipcMain.handle('draft:clear', () => clearDraft());

// Called once at startup: offers to bring back unsaved work from last time
ipcMain.handle('draft:recover', async () => {
  const d = readDraft();
  if (!d) return null;
  let disk = null;
  if (d.path) {
    try {
      disk = readText(d.path);
    } catch {
      d.path = null; // the file is gone: recover as an untitled document
    }
  }
  if (disk !== null && disk === d.content) {
    clearDraft(); // nothing was actually lost
    return null;
  }
  const when = new Date(d.savedAt || Date.now()).toLocaleString(settings.lang === 'es' ? 'es-ES' : 'en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const name = d.path ? path.basename(d.path) : t('untitled');
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    title: APP_NAME,
    message: t('recTitle'),
    detail: t('recDetail', { name, when }),
    buttons: [t('recRecover'), t('recDiscard')],
    defaultId: 0,
    cancelId: 0, // closing the dialog must never throw the text away
    noLink: true,
  });
  if (response !== 0) {
    clearDraft();
    return null;
  }
  currentPath = d.path || null;
  updateTitle();
  return { content: d.content, name: d.path ? path.basename(d.path) : null, disk: disk ?? '', hasPath: !!d.path };
});

ipcMain.handle('doc:new', () => {
  clearDraft();
  currentPath = null;
  dirty = false;
  updateTitle();
});

ipcMain.handle('doc:open', async (_e, givenPath) => {
  let p = givenPath;
  if (!p) {
    const res = await dialog.showOpenDialog(win, {
      title: t('dOpenTitle'),
      properties: ['openFile'],
      filters: fileFilters(),
    });
    if (res.canceled || !res.filePaths[0]) return null;
    p = res.filePaths[0];
  }
  try {
    const content = readText(p);
    clearDraft();
    currentPath = p;
    dirty = false;
    updateTitle();
    return { path: p, name: path.basename(p), content };
  } catch (err) {
    dialog.showErrorBox(t('dOpenFail'), `${p}\n\n${err.message}`);
    return null;
  }
});

ipcMain.handle('doc:save', async (_e, content, saveAs, silent) => {
  let p = currentPath;
  if (silent && !p) return null; // autosave never opens a dialog
  if (!p || saveAs) {
    const res = await dialog.showSaveDialog(win, {
      title: t('dSaveTitle'),
      defaultPath: currentPath || t('dNewFileName'),
      filters: fileFilters(),
    });
    if (res.canceled || !res.filePath) return null;
    p = res.filePath;
  }
  try {
    fs.writeFileSync(p, content, 'utf8');
    clearDraft();
    currentPath = p;
    dirty = false;
    updateTitle();
    return { path: p, name: path.basename(p) };
  } catch (err) {
    if (!silent) dialog.showErrorBox(t('dSaveFail'), `${p}\n\n${err.message}`);
    return null;
  }
});

ipcMain.handle('doc:confirmDiscard', async () => {
  const name = currentPath ? path.basename(currentPath) : t('untitled');
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: [t('bSave'), t('bDontSave'), t('bCancel')],
    defaultId: 0,
    cancelId: 2,
    title: APP_NAME,
    message: t('dSaveChanges', { name }),
    detail: t('dSaveChangesDetail'),
    noLink: true,
  });
  return ['save', 'discard', 'cancel'][response];
});

ipcMain.handle('app:forceClose', () => {
  clearDraft(); // the user either saved or chose not to
  allowClose = true;
  win?.close();
});

// ---------- Context menu (right click in the editor) ----------
function cleanWord(text) {
  if (!text) return '';
  // Keep the last word: it's the one that rhymes
  const words = text.match(/[\p{L}\p{M}'’-]+/gu);
  if (!words) return '';
  return words[words.length - 1].replace(/^['’-]+|['’-]+$/g, '');
}

async function showEditorContextMenu(contents, params) {
  if (!params.isEditable) return;
  let word = cleanWord(params.selectionText);
  if (!word) {
    try {
      word = cleanWord(await contents.executeJavaScript('window.__wordAtCaret ? window.__wordAtCaret() : ""'));
    } catch {}
  }
  const hasSel = !!params.selectionText;
  const items = [];

  if (params.misspelledWord && params.dictionarySuggestions.length) {
    for (const s of params.dictionarySuggestions.slice(0, 4)) {
      items.push({ label: s, click: () => contents.replaceMisspelling(s) });
    }
    items.push({ type: 'separator' });
  }

  items.push(
    word
      ? { label: t('ctxRhymesFor', { w: word }), click: () => send('rhymes', word) }
      : { label: t('ctxRhymes'), enabled: false },
    { type: 'separator' },
    { label: t('mCut'), role: 'cut', enabled: hasSel },
    { label: t('mCopy'), role: 'copy', enabled: hasSel },
    { label: t('mPaste'), role: 'paste' },
    { type: 'separator' },
    { label: t('mSelectAll'), role: 'selectAll' }
  );
  Menu.buildFromTemplate(items).popup({ window: win });
}

// ---------- Safety: external links and popups ----------
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  if (contents.getType() === 'window') {
    contents.on('will-navigate', (ev) => ev.preventDefault());
    contents.on('context-menu', (_ev, params) => showEditorContextMenu(contents, params));
  }
  if (contents.getType() === 'webview') {
    // Minimal menu inside the rhymes panel
    contents.on('context-menu', (_ev, params) => {
      const canBack = contents.navigationHistory?.canGoBack?.() ?? contents.canGoBack();
      const items = [
        { label: t('ctxBack'), enabled: canBack, click: () => contents.goBack() },
        { label: t('ctxReload'), click: () => contents.reload() },
      ];
      if (params.selectionText) {
        const w = cleanWord(params.selectionText);
        items.unshift(
          { label: t('mCopy'), role: 'copy' },
          ...(w ? [{ label: t('ctxRhymesFor', { w }), click: () => send('rhymes', w) }] : []),
          { type: 'separator' }
        );
      }
      Menu.buildFromTemplate(items).popup({ window: win });
    });
  }
});

// ---------- Startup ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    const f = fileFromArgv(argv);
    if (f) win.webContents.send('open-path', f);
  });

  app.whenReady().then(() => {
    loadSettings();
    createWindow();
    updater.init({
      getWin: () => win,
      getSettings: () => settings,
      saveSettings,
      t,
      onStatus: (text) => win?.webContents.send('update-status', text),
    });
    const f = fileFromArgv(process.argv);
    if (f) win.webContents.once('did-finish-load', () => win.webContents.send('open-path', f));
  });

  app.on('window-all-closed', () => app.quit());
}

function fileFromArgv(argv) {
  const args = argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith('-'));
  const f = args.find((a) => {
    try {
      return fs.statSync(a).isFile();
    } catch {
      return false;
    }
  });
  return f || null;
}
