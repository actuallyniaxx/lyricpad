// Update checker backed by GitHub Releases.
//
// - Installed copy (MSI): downloads the new .msi, verifies it, and installs it
//   when the app closes (or right away if the user says so).
// - Portable copy (ZIP, has a "portable" marker file next to the .exe) or a dev
//   run: just offers to open the release page.
//
// No accounts, no telemetry: it's one anonymous GET to the public GitHub API.

const { app, dialog, net, shell } = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const REPO = 'actuallyniaxx/lyricpad';
// Overridable for testing against a local mock server.
const API_URL = process.env.LYRICPAD_UPDATE_URL || `https://api.github.com/repos/${REPO}/releases/latest`;
const AUTO_CHECK_DELAY_MS = 3000; // shortly after every start
const AUTO_CHECK_INTERVAL_MS = 3 * 60 * 60 * 1000; // and every 3 h while it stays open

let ctx = null; // { getWin, getSettings, saveSettings, t, onStatus }
let busy = false;
let pendingInstaller = null; // path of a downloaded .msi waiting for app exit
let dismissedVersion = null; // "Later" was chosen for this version: don't nag again until restart

// ---------- Helpers ----------
function parseVersion(v) {
  const m = String(v || '').trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!m) return null;
  return { nums: [+m[1], +m[2], +m[3]], pre: m[4] || null };
}

// > 0 if a is newer than b
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] - pb.nums[i];
  if (pa.pre && !pb.pre) return -1; // 1.2.0-beta < 1.2.0
  if (!pa.pre && pb.pre) return 1;
  return 0;
}

function isPortable() {
  if (!app.isPackaged) return true; // dev run: never try to install
  try {
    return fs.existsSync(path.join(path.dirname(process.execPath), 'portable'));
  } catch {
    return true;
  }
}

function status(text) {
  ctx?.onStatus?.(text || '');
}

// ---------- GitHub ----------
async function fetchLatest() {
  const res = await net.fetch(API_URL, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': `Lyricpad/${app.getVersion()}`,
    },
    cache: 'no-store',
  });
  if (res.status === 404) return null; // no releases yet
  if (!res.ok) throw new Error(`GitHub: HTTP ${res.status}`);
  const rel = await res.json();
  if (rel.draft || rel.prerelease) return null;
  const msi = (rel.assets || []).find((a) => /\.msi$/i.test(a.name));
  return {
    version: String(rel.tag_name || '').replace(/^v/i, ''),
    notes: (rel.body || '').trim(),
    pageUrl: rel.html_url || `https://github.com/${REPO}/releases/latest`,
    msi: msi
      ? {
          name: msi.name,
          url: msi.browser_download_url,
          size: msi.size,
          sha256: /^sha256:([0-9a-f]{64})$/i.exec(msi.digest || '')?.[1]?.toLowerCase() || null,
        }
      : null,
  };
}

async function download(asset, onProgress) {
  const dir = path.join(app.getPath('temp'), 'lyricpad-update');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, asset.name.replace(/[^\w.-]/g, '_'));
  const partial = `${dest}.part`;

  const res = await net.fetch(asset.url, { headers: { 'User-Agent': `Lyricpad/${app.getVersion()}` } });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || asset.size || 0;

  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(partial);
  let received = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      received += value.length;
      if (!out.write(value)) await new Promise((r) => out.once('drain', r));
      if (total) onProgress(received / total);
    }
  } finally {
    await new Promise((r) => out.end(r));
  }

  const bad = (asset.size && received !== asset.size) || (asset.sha256 && hash.digest('hex') !== asset.sha256);
  if (bad) {
    fs.rmSync(partial, { force: true });
    throw new Error(ctx.t('upBadFile'));
  }
  fs.renameSync(partial, dest);
  return dest;
}

function launchInstaller(msiPath) {
  // Run the MSI exactly as if the user had double-clicked it:
  // - msiexec is started directly (no cmd.exe, so no console window flashes);
  // - no /passive or /quiet: the installer only relaunches Lyricpad when it
  //   runs with its normal UI level, and it has no dialogs to click anyway.
  // By the time msiexec reaches the file-copy phase Lyricpad has already
  // exited, since this is called while the app is quitting.
  try {
    const child = spawn('msiexec.exe', ['/i', msiPath, '/norestart'], {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', (e) => console.error('Could not start installer:', e.message));
    child.unref();
  } catch (e) {
    console.error('Could not start installer:', e.message);
  }
}

// ---------- Flow ----------
async function check({ manual }) {
  if (busy || !ctx) return;
  if (pendingInstaller) {
    if (manual) await promptInstallNow(pendingInstaller.version);
    return;
  }
  busy = true;
  const { t, getWin, getSettings, saveSettings } = ctx;
  const win = getWin();
  try {
    if (manual) status(t('upChecking'));
    const latest = await fetchLatest();
    getSettings().lastUpdateCheck = Date.now();
    saveSettings();
    status('');

    const current = app.getVersion();
    if (!latest || compareVersions(latest.version, current) <= 0) {
      if (manual) {
        await dialog.showMessageBox(win, {
          type: 'info',
          title: 'Lyricpad',
          message: t('upLatest'),
          detail: t('upLatestDetail', { v: current }),
          buttons: ['OK'],
          noLink: true,
        });
      }
      return;
    }

    // Respect "skip this version" and "later" on automatic checks only
    if (!manual && (getSettings().skipVersion === latest.version || dismissedVersion === latest.version)) return;

    const portable = isPortable() || !latest.msi;
    const notes = latest.notes ? `\n\n${latest.notes.slice(0, 600)}${latest.notes.length > 600 ? '…' : ''}` : '';
    const buttons = portable
      ? [t('upOpenPage'), t('upLater'), t('upSkip')]
      : [t('upInstall'), t('upLater'), t('upSkip')];
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      title: 'Lyricpad',
      message: t('upAvailable', { v: latest.version }),
      detail: t(portable ? 'upDetailPortable' : 'upDetailInstall', { v: latest.version, cur: current }) + notes,
      buttons,
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });

    if (response === 2) {
      getSettings().skipVersion = latest.version;
      saveSettings();
      return;
    }
    if (response !== 0) {
      dismissedVersion = latest.version;
      return;
    }

    if (portable) {
      shell.openExternal(latest.pageUrl);
      return;
    }

    // Installed copy: download and install
    let msiPath;
    try {
      status(t('upDownloading', { p: 0 }));
      msiPath = await download(latest.msi, (f) => {
        getWin()?.setProgressBar(f);
        status(t('upDownloading', { p: Math.round(f * 100) }));
      });
    } catch (err) {
      getWin()?.setProgressBar(-1);
      status('');
      const r = await dialog.showMessageBox(getWin(), {
        type: 'error',
        title: 'Lyricpad',
        message: t('upDownloadFail'),
        detail: String(err.message || err),
        buttons: [t('upOpenPage'), t('bCancel')],
        noLink: true,
      });
      if (r.response === 0) shell.openExternal(latest.pageUrl);
      return;
    }
    getWin()?.setProgressBar(-1);
    status('');

    pendingInstaller = { path: msiPath, version: latest.version };
    // If the user closes the app normally later, install on the way out
    app.once('will-quit', () => {
      if (pendingInstaller) launchInstaller(pendingInstaller.path);
    });
    await promptInstallNow(latest.version);
  } catch (err) {
    status('');
    if (manual) {
      await dialog.showMessageBox(win, {
        type: 'warning',
        title: 'Lyricpad',
        message: t('upCheckFail'),
        detail: String(err.message || err),
        buttons: ['OK'],
        noLink: true,
      });
    } else {
      console.warn('Update check failed:', err.message || err);
    }
  } finally {
    busy = false;
  }
}

async function promptInstallNow(version) {
  const { t, getWin } = ctx;
  const { response } = await dialog.showMessageBox(getWin(), {
    type: 'question',
    title: 'Lyricpad',
    message: t('upReady', { v: version }),
    detail: t('upReadyDetail'),
    buttons: [t('upRestartNow'), t('upOnExit')],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (response === 0) {
    // Goes through the normal close flow, so unsaved work still gets the
    // "save changes?" prompt. If the user cancels there, it installs on exit.
    getWin()?.close();
  } else {
    status(t('upPending', { v: version }));
  }
}

function init(context) {
  ctx = context;
  const auto = () => {
    if (ctx.getSettings().autoUpdate !== false) check({ manual: false });
  };
  setTimeout(auto, AUTO_CHECK_DELAY_MS);
  setInterval(auto, AUTO_CHECK_INTERVAL_MS);
}

module.exports = { init, check: () => check({ manual: true }), compareVersions, isPortable };
