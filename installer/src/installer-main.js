/**
 * installer-main.js
 * The installer and uninstaller of AeterMC, drawn in the launcher's own style.
 *
 * There is no separate setup program: AeterMC-Setup.exe is the portable build of the launcher with
 * `aeterSetup: true` in its package.json (see scripts/build.js). The portable stub unpacks the app
 * into a temp folder and starts it; in that mode main.js hands over to this file, which copies the
 * unpacked folder into the install folder, creates shortcuts and registers the app in
 * "Apps & features". The installed copy starts without the stub, so it opens as the normal launcher.
 * `AeterMC.exe --uninstall` (the UninstallString) opens the uninstaller.
 *
 * Not packaged (`npm start -- --installer` / `-- --uninstall`) nothing is written: the steps are
 * simulated so the window can be previewed.
 */
const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme } = require('electron');
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');
const { pathToFileURL } = require('url');
// plain fs sees app.asar as a folder; the installer must copy it as one file
const ofs = require('original-fs');

const APP_NAME = 'AeterMC';
const EXE_NAME = 'AeterMC.exe';
const APP_ID = 'dev.aetermc.launcher';
const UNINSTALL_KEY = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AeterMC';
const DEFAULT_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', APP_NAME);
// the launcher keeps its data here (see main.js); the uninstaller may remove it on request
// Set by start(): the launcher's src folder (themes, styles, data folder, package.json)
let launcherSrc = null;
let DATA_DIR = null;

const simulated = !app.isPackaged;
let win = null;
let busy = false;

// ================= HELPERS =================

function exec(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, encoding: 'utf8' }, (err, stdout) => resolve({ ok: !err, out: stdout || '' }));
  });
}

/** Runs a PowerShell snippet and parses its JSON output (UTF-8, so non-Latin paths come through). */
async function psJson(script) {
  const r = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${script} | ConvertTo-Json -Compress`]);
  if (!r.ok || !r.out.trim()) return null;
  try { return JSON.parse(r.out); } catch (e) { return null; }
}

function exists(p) {
  try { ofs.accessSync(p); return true; } catch (e) { return false; }
}

function isDirEmpty(dir) {
  try { return ofs.readdirSync(dir).length === 0; } catch (e) { return true; }
}

/** The folder holds an installed AeterMC (and so may be emptied on update or uninstall). */
function isOurInstall(dir) {
  return exists(path.join(dir, EXE_NAME)) && exists(path.join(dir, 'resources', 'app.asar'));
}

function samePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function startMenuDir() {
  return path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
}

function shortcutPaths() {
  return {
    desktop: path.join(app.getPath('desktop'), `${APP_NAME}.lnk`),
    startMenu: path.join(startMenuDir(), `${APP_NAME}.lnk`)
  };
}

/** Theme the launcher uses, so the installer of an update looks like the launcher the user knows. */
function pickTheme() {
  let themes = [];
  try { themes = require(path.join(launcherSrc, 'themes.json')); } catch (e) {}
  let id = 'dark-mono';
  try {
    const s = JSON.parse(ofs.readFileSync(path.join(DATA_DIR, 'settings.json'), 'utf8'));
    if (s.theme) id = s.theme;
  } catch (e) {}
  return themes.find(t => t.id === id) || themes.find(t => t.id === 'dark-mono') || themes[0] || null;
}

/** Where AeterMC is installed now, if anywhere. */
async function findInstalled() {
  const entry = await psJson(`Get-ItemProperty -LiteralPath 'Registry::${UNINSTALL_KEY}' -ErrorAction SilentlyContinue | Select-Object InstallLocation,DisplayVersion`);
  if (entry && entry.InstallLocation && exists(path.join(entry.InstallLocation, EXE_NAME))) {
    return { dir: entry.InstallLocation, version: entry.DisplayVersion || null };
  }
  // installed by the old NSIS installer (electron-builder's default location)
  if (exists(path.join(DEFAULT_DIR, EXE_NAME))) return { dir: DEFAULT_DIR, version: null };
  return null;
}

/** AeterMC processes started from `dir`, except this one and its own Chromium helpers. */
async function runningFrom(dir) {
  if (simulated) return [];
  let list = await psJson(`Get-CimInstance Win32_Process -Filter "Name='${EXE_NAME}'" | Select-Object ProcessId,ParentProcessId,ExecutablePath`);
  if (!list) return [];
  if (!Array.isArray(list)) list = [list];
  const target = path.join(dir, EXE_NAME);
  return list
    .filter(p => p.ExecutablePath && samePath(p.ExecutablePath, target))
    .filter(p => p.ProcessId !== process.pid && p.ParentProcessId !== process.pid)
    .map(p => p.ProcessId);
}

async function killAll(pids) {
  for (const pid of pids) await exec('taskkill', ['/pid', String(pid), '/t', '/f']);
  await new Promise(r => setTimeout(r, 600));
}

/** Files of the unpacked app with their sizes; directories first so they can be created in order. */
function listFiles(root) {
  const out = [];
  const walk = (rel) => {
    for (const entry of ofs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = path.join(rel, entry.name);
      if (entry.isDirectory()) walk(r);
      else out.push({ rel: r, size: ofs.statSync(path.join(root, r)).size });
    }
  };
  walk('');
  return out;
}

function copyFile(src, dst, onChunk) {
  return new Promise((resolve, reject) => {
    const rs = ofs.createReadStream(src, { highWaterMark: 1 << 20 });
    const ws = ofs.createWriteStream(dst);
    rs.on('data', (chunk) => onChunk(chunk.length));
    rs.on('error', reject);
    ws.on('error', reject);
    ws.on('finish', resolve);
    rs.pipe(ws);
  });
}

function sendProgress(data) {
  if (win && !win.isDestroyed()) win.webContents.send('progress', data);
}

function dirSizeKb(dir) {
  try { return Math.round(listFiles(dir).reduce((s, f) => s + f.size, 0) / 1024); } catch (e) { return 0; }
}

/** Entries of the old NSIS installer for this app (they would show up twice in "Apps & features"). */
async function removeLegacyNsis(dir) {
  const old = path.join(dir, `Uninstall ${APP_NAME}.exe`);
  try { ofs.rmSync(old, { force: true }); } catch (e) {}
  const r = await exec('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s', '/f', `Uninstall ${APP_NAME}.exe`, '/d']);
  if (!r.ok) return;
  const keys = r.out.split(/\r?\n/).filter(l => /^HKEY_/.test(l.trim())).map(l => l.trim());
  for (const key of keys) {
    if (/\\AeterMC$/i.test(key)) continue;
    await exec('reg', ['delete', key, '/f']);
  }
}

// ================= INSTALL =================

async function install({ dir, desktop, startMenu }) {
  if (!path.isAbsolute(dir)) throw new Error('Укажите полный путь к папке, например C:\\Games\\AeterMC');
  dir = path.resolve(dir);
  const src = path.dirname(process.execPath);
  const target = path.join(dir, EXE_NAME);

  if (simulated) {
    for (let i = 0; i <= 50; i++) {
      sendProgress({ stage: 'copy', done: i * 5242880, total: 50 * 5242880, file: 'resources\\app.asar' });
      await new Promise(r => setTimeout(r, 40));
    }
    sendProgress({ stage: 'shortcuts' });
    await new Promise(r => setTimeout(r, 300));
    return { exe: target };
  }

  if (samePath(src, dir)) throw new Error('AeterMC уже установлен в эту папку');
  if (exists(dir) && !isDirEmpty(dir) && !isOurInstall(dir)) {
    throw new Error('Папка не пуста. Выберите пустую папку или папку с AeterMC.');
  }

  sendProgress({ stage: 'prepare' });
  const files = listFiles(src);
  const total = files.reduce((s, f) => s + f.size, 0);

  // Update: the old files go first so nothing stale from the previous version stays behind
  if (exists(dir)) {
    for (const name of ofs.readdirSync(dir)) {
      ofs.rmSync(path.join(dir, name), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    }
  }

  let done = 0;
  let last = 0;
  for (const f of files) {
    const to = path.join(dir, f.rel);
    ofs.mkdirSync(path.dirname(to), { recursive: true });
    await copyFile(path.join(src, f.rel), to, (n) => {
      done += n;
      const now = Date.now();
      if (now - last > 50) {
        last = now;
        sendProgress({ stage: 'copy', done, total, file: f.rel });
      }
    });
  }
  sendProgress({ stage: 'copy', done: total, total, file: '' });

  sendProgress({ stage: 'shortcuts' });
  const links = shortcutPaths();
  const linkOptions = { target, cwd: dir, description: 'Лаунчер Minecraft', icon: target, iconIndex: 0, appUserModelId: APP_ID };
  if (desktop) shell.writeShortcutLink(links.desktop, 'replace', linkOptions);
  else removeOurShortcut(links.desktop, dir);
  ofs.mkdirSync(startMenuDir(), { recursive: true });
  if (startMenu) shell.writeShortcutLink(links.startMenu, 'replace', linkOptions);
  else removeOurShortcut(links.startMenu, dir);

  await removeLegacyNsis(dir);
  const values = [
    ['DisplayName', 'REG_SZ', APP_NAME],
    ['DisplayVersion', 'REG_SZ', app.getVersion()],
    ['Publisher', 'REG_SZ', APP_NAME],
    ['DisplayIcon', 'REG_SZ', `${target},0`],
    ['InstallLocation', 'REG_SZ', dir],
    ['UninstallString', 'REG_SZ', `"${target}" --uninstall`],
    ['EstimatedSize', 'REG_DWORD', String(dirSizeKb(dir))],
    ['NoModify', 'REG_DWORD', '1'],
    ['NoRepair', 'REG_DWORD', '1']
  ];
  for (const [name, type, data] of values) {
    await exec('reg', ['add', UNINSTALL_KEY, '/v', name, '/t', type, '/d', data, '/f']);
  }

  return { exe: target };
}

function removeOurShortcut(lnk, dir) {
  try {
    if (!exists(lnk)) return;
    const info = shell.readShortcutLink(lnk);
    if (info.target && samePath(path.dirname(info.target), dir)) ofs.rmSync(lnk, { force: true });
  } catch (e) {}
}

// ================= UNINSTALL =================

async function canUninstall() {
  if (simulated) return true;
  const dir = path.dirname(process.execPath);
  const installed = await findInstalled();
  return !!installed && samePath(installed.dir, dir) && isOurInstall(dir) && !process.env.PORTABLE_EXECUTABLE_FILE;
}

async function uninstall({ removeData }) {
  const dir = path.dirname(process.execPath);
  if (simulated) {
    sendProgress({ stage: 'remove' });
    await new Promise(r => setTimeout(r, 900));
    return true;
  }

  // never remove a folder that is not the registered installation (e.g. the portable exe run with --uninstall)
  if (!(await canUninstall())) throw new Error('Этот AeterMC не установлен. Переносную версию достаточно просто удалить.');

  sendProgress({ stage: 'remove' });
  const links = shortcutPaths();
  removeOurShortcut(links.desktop, dir);
  removeOurShortcut(links.startMenu, dir);
  await exec('reg', ['delete', UNINSTALL_KEY, '/f']);

  // The running exe can't delete its own folder: a hidden PowerShell waits until this process
  // exits, then removes the folder (and the launcher data if asked). -EncodedCommand is UTF-16,
  // so folders with Cyrillic names survive the trip.
  const quote = (s) => `'${s.replace(/'/g, "''")}'`;
  const dirs = [dir, ...(removeData ? [DATA_DIR] : [])].map(quote).join(',');
  // Waits for every process started from the folder (Chromium helpers and crashpad outlive the main one).
  const script = [
    `$dir = ${quote(dir)}`,
    `$log = Join-Path $env:TEMP 'aetermc-uninstall.log'`,
    `for ($i = 0; $i -lt 200; $i++) {`,
    `  $left = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($dir + '\\', 'OrdinalIgnoreCase') }`,
    `  if (-not $left) { break }`,
    `  Start-Sleep -Milliseconds 300`,
    `}`,
    `foreach ($d in @(${dirs})) {`,
    `  for ($i = 0; $i -lt 60 -and (Test-Path -LiteralPath $d); $i++) {`,
    `    try { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction Stop } catch { "$(Get-Date -Format s) $d : $($_.Exception.Message)" | Out-File $log -Append -Encoding utf8; Start-Sleep -Seconds 1 }`,
    `  }`,
    `}`
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  // Started through WMI: Electron kills its child processes on exit, and a `detached` PowerShell
  // gets no console and quits without running anything. ShowWindow = 0 keeps it invisible.
  const launcher = [
    `$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }`,
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{`,
    `  CommandLine = 'powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${encoded}'`,
    `  CurrentDirectory = $env:TEMP`,
    `  ProcessStartupInformation = $si`,
    `}`,
    `exit $r.ReturnValue`
  ].join('\n');
  const r = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', launcher]);
  if (!r.ok) throw new Error('Не удалось запустить удаление файлов');
  return true;
}

// ================= WINDOW =================

function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^PORTABLE_EXECUTABLE_/i.test(k)) delete env[k];
  return env;
}

/**
 * installer.html takes the launcher's styles (tokens.css, style.css, theme-init.js), but the two
 * live in different folders in the repo (installer/src/, src/) and in one app.asar when packaged.
 * So the page is written to the installer's temp folder with absolute links to both.
 */
function pageWithLauncherStyles() {
  const url = (p) => pathToFileURL(p).href;
  const html = require('fs').readFileSync(path.join(__dirname, 'installer.html'), 'utf8')
    .replace(/(href|src)="\.\.\/renderer\/([^"]+)"/g, (m, attr, file) => `${attr}="${url(path.join(launcherSrc, 'renderer', file))}"`)
    .replace(/(href|src)="(installer\.(?:css|js))"/g, (m, attr, file) => `${attr}="${url(path.join(__dirname, file))}"`);
  const out = path.join(app.getPath('userData'), 'installer.html');
  ofs.mkdirSync(path.dirname(out), { recursive: true });
  ofs.writeFileSync(out, html);
  return out;
}

function createWindow(mode) {
  const theme = pickTheme();
  if (theme) nativeTheme.themeSource = theme.mode;
  win = new BrowserWindow({
    width: 760,
    height: 500,
    resizable: false,
    maximizable: false,
    frame: false,
    show: false,
    title: mode === 'uninstall' ? `Удаление ${APP_NAME}` : `Установка ${APP_NAME}`,
    backgroundColor: theme ? theme.preview.bg : '#111214',
    icon: path.join(launcherSrc, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'installer-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(pageWithLauncherStyles(), { query: { theme: theme ? theme.id : '', mode } });
  win.once('ready-to-show', () => win.show());
  win.on('close', (e) => { if (busy) e.preventDefault(); });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

function start(mode) {
  if (!launcherSrc) throw new Error('installer: init(launcherSrc) was not called');
  // The installer must not touch the launcher's own data folder (Chromium writes caches there)
  app.setPath('userData', path.join(app.getPath('temp'), 'aetermc-setup'));
  app.disableHardwareAcceleration();
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

  ipcMain.handle('info', async () => {
    const installed = await findInstalled();
    return {
      mode,
      simulated,
      version: app.getVersion(),
      defaultDir: installed ? installed.dir : DEFAULT_DIR,
      installed,
      dataDir: DATA_DIR,
      installDir: mode === 'uninstall' ? path.dirname(process.execPath) : null,
      canUninstall: mode === 'uninstall' ? await canUninstall() : false
    };
  });

  ipcMain.handle('browse', async (event, current) => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Папка для установки',
      defaultPath: current,
      properties: ['openDirectory', 'createDirectory']
    });
    if (r.canceled || !r.filePaths.length) return null;
    const picked = r.filePaths[0];
    // a folder that is not AeterMC's own gets a subfolder, so its contents are never mixed in
    return path.basename(picked).toLowerCase() === APP_NAME.toLowerCase() || exists(path.join(picked, EXE_NAME))
      ? picked
      : path.join(picked, APP_NAME);
  });

  ipcMain.handle('running', async (event, dir) => (await runningFrom(dir)).length);
  ipcMain.handle('kill-running', async (event, dir) => killAll(await runningFrom(dir)));

  ipcMain.handle('install', async (event, opts) => {
    busy = true;
    try {
      return await install(opts);
    } finally {
      busy = false;
    }
  });

  ipcMain.handle('uninstall', async (event, opts) => {
    busy = true;
    try {
      return await uninstall(opts);
    } finally {
      busy = false;
    }
  });

  ipcMain.handle('launch', (event, exe) => {
    if (!simulated) {
      // without the portable stub's variables the installed copy starts as the launcher, not as setup
      spawn(exe, [], { detached: true, stdio: 'ignore', cwd: path.dirname(exe), env: cleanEnv() }).unref();
    }
    app.quit();
  });

  ipcMain.on('minimize', () => win && win.minimize());
  ipcMain.on('close', () => { if (!busy) app.quit(); });

  app.whenReady().then(() => createWindow(mode));
  app.on('window-all-closed', () => app.quit());
}

/** 'install' | 'uninstall' | null — whether this start of the exe is the installer. */
function detectMode() {
  if (process.argv.includes('--uninstall')) return 'uninstall';
  if (process.argv.includes('--installer')) return 'install';
  if (process.env.PORTABLE_EXECUTABLE_FILE) {
    try {
      if (require(path.join(launcherSrc, '..', 'package.json')).aeterSetup) return 'install';
    } catch (e) {}
  }
  return null;
}

/** Called first by the launcher's main.js with its own src folder. */
function init(srcDir) {
  launcherSrc = srcDir;
  DATA_DIR = require(path.join(srcDir, 'data-dir')).DATA_DIR;
}

module.exports = { init, detectMode, run: start };
