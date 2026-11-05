/**
 * main.js
 * Electron Main Process for AeterMC.
 */

// AeterMC-Setup.exe and `AeterMC.exe --uninstall` are this same app in installer mode
// Its code lives in installer/src and is packed into the app as src/installer
const installerDir = require('fs').existsSync(require('path').join(__dirname, 'installer'))
  ? './installer'
  : '../installer/src';
const installer = require(`${installerDir}/installer-main`);
installer.init(__dirname);
const installerMode = installer.detectMode();
if (installerMode) {
  installer.run(installerMode);
  return;
}

require('./dns-patch');

const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, nativeImage, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { SettingsManager, DEFAULT_MINECRAFT_DIR } = require('./settings-manager');
const i18n = require('./i18n/i18n');
const { t } = i18n;
const { VersionManager } = require('./version-manager');
const { LoaderManager } = require('./loaders');
const { detectJavaInstallations, pickJavaFor, checkJavaPath } = require('./java-detector');
const { DiscordPresence } = require('./discord-rpc');
const { LauncherCore } = require('./launcher-core');
const { AccountsManager } = require('./accounts-manager');
const { InstancesManager } = require('./instances-manager');
const { ModrinthManager } = require('./modrinth-manager');
const { MrpackManager } = require('./mrpack');
const { exportPrism } = require('./prism-export');
const { checkBuild } = require('./mod-check');
const { scanModsDir } = require('./mod-meta');
const { analyzeCrash } = require('./crash-analyzer');
// developer crash samples: kept out of git, so the file may be missing
let devSamples = null;
try { devSamples = require('./dev-samples'); } catch (e) { /* no developer samples */ }
const { contentType, contentDir } = require('./content-types');
const { ElyByManager } = require('./elyby-manager');
const optionsSync = require('./options-sync');
const { describeChange } = require('./options-labels');
const { DiskCache } = require('./disk-cache');
const { PlaytimeLog } = require('./playtime-log');
const { Updater } = require('./updater');
const screenshots = require('./screenshots');
const https = require('https');
const axios = require('axios');

// Reuse TLS connections to Mojang / Modrinth / Fabric instead of a new handshake per request
axios.defaults.httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 16 });

// The UI is flat HTML without heavy animation: software rendering skips GPU process start-up
// (window shows ~0.2 s sooner) and saves ~25 MB of memory.
app.disableHardwareAcceleration();
// same id as the installer's shortcuts, so the taskbar groups the window with the pinned shortcut
app.setAppUserModelId('dev.aetermc.launcher');

let mainWindow = null;
let consoleWindow = null;

// Theme list generated from design/themes by `npm run tokens`
let THEMES = [];
try {
  THEMES = require('./themes.json');
} catch (e) {}

function currentTheme() {
  const id = settingsManager.get().theme;
  return THEMES.find(t => t.id === id) || THEMES.find(t => t.id === 'dark-mono') || THEMES[0] || null;
}

/** The chosen language, or until one is chosen in the settings the system one. */
function applyLanguage() {
  i18n.setLanguage(settingsManager.get().language || i18n.detectLanguage(app.getPreferredSystemLanguages()));
}

/** The pages get the language in the URL: after a change they are loaded again, the main one on the settings. */
function reloadWindows() {
  const theme = currentTheme();
  const query = { theme: theme ? theme.id : '', lang: i18n.language() };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query: { ...query, page: 'settings' } });
  }
  if (consoleWindow && !consoleWindow.isDestroyed()) {
    consoleWindow.setTitle(t('Консоль — AeterMC'));
    consoleWindow.loadFile(path.join(__dirname, 'renderer', 'console.html'), { query });
  }
}

/** Window background before the page paints, and the colors of native parts (title bar of the console window). */
function applyThemeToWindows() {
  const theme = currentTheme();
  if (!theme) return;
  nativeTheme.themeSource = theme.mode;
  for (const win of [mainWindow, consoleWindow]) {
    if (win && !win.isDestroyed()) {
      win.setBackgroundColor(theme.preview.bg);
      win.webContents.send('theme-changed', theme.id);
    }
  }
}
// Same folder for `npm start` and the installed .exe (see data-dir.js)
app.setPath('userData', require('./data-dir').DATA_DIR);
const userDataDir = app.getPath('userData');

const settingsManager = new SettingsManager(userDataDir);
const currentSettings = settingsManager.get();
i18n.setLanguage(currentSettings.language || 'ru');

// Not "cache": on Windows that is the same folder as Chromium's own Cache, which it cleans on startup
const diskCache = new DiskCache(path.join(userDataDir, 'mcl-cache'));
const versionManager = new VersionManager(currentSettings.gameDir, diskCache);
const loaderManager = new LoaderManager(versionManager);
const accountsManager = new AccountsManager(userDataDir, currentSettings.gameDir);
const instancesManager = new InstancesManager(userDataDir, versionManager);
instancesManager.includePrism = currentSettings.prismImport === true;
const modrinthManager = new ModrinthManager(diskCache);
const mrpackManager = new MrpackManager(instancesManager, loaderManager, modrinthManager);
const elyByManager = new ElyByManager(currentSettings.gameDir);
const launcherCore = new LauncherCore();
const playtimeLog = new PlaytimeLog(userDataDir);
const discord = new DiscordPresence();
// Launcher self-update from GitHub Releases (see updater.js)
const updater = new Updater({
  currentVersion: app.getVersion(),
  electronVersion: process.versions.electron,
  resourcesDir: process.resourcesPath,
  exePath: app.getPath('exe'),
  portable: !!process.env.PORTABLE_EXECUTABLE_FILE,
  // only a built launcher updates itself; `npm start` runs from the sources
  enabled: app.isPackaged,
  onChange: (state) => sendToWindow('update-state', state)
});

/** Checks for a launcher update; with "download automatically" on, a found one is downloaded right away. */
async function checkForUpdate() {
  await updater.check();
  autoDownloadUpdate();
  return updater.state;
}

function autoDownloadUpdate() {
  if (updater.state.status !== 'available' || settingsManager.get().autoUpdate === false) return;
  // a failed download leaves its error in the state for the update menu; the next check tries again
  updater.download().catch(() => {});
}

let javaCache = null;
// Java the launcher downloaded itself lives here (see java-installer.js)
const { JavaInstaller } = require('./java-installer');
const javaInstaller = new JavaInstaller(path.join(userDataDir, 'runtimes'));

async function getJavaList(force = false) {
  if (!javaCache || force) javaCache = await detectJavaInstallations([javaInstaller.dir], diskCache);
  return javaCache;
}

/** Downloads Temurin <major>, reporting progress to the window, and refreshes the Java list. */
async function installJava(major) {
  const exe = await javaInstaller.install(major, (p) => sendToWindow('java-install-progress', { major, ...p }));
  await getJavaList(true);
  return exe;
}

/** Java that fits a Minecraft version: an installed one, otherwise Temurin is downloaded. */
async function javaForVersion(versionId, log = () => {}) {
  const required = await versionManager.getRequiredJava(versionId);
  const java = pickJavaFor(await getJavaList(), required);
  if (java) return java.path;
  log('info', `[JAVA]: ${t('Нужна Java {version}, её нет — скачиваю Eclipse Temurin {version}…', { version: required })}`);
  try {
    const javaPath = await installJava(required);
    log('info', `[JAVA]: ${t('Java {version} установлена: {path}', { version: required, path: javaPath })}`);
    return javaPath;
  } catch (e) {
    throw new Error(t('Не удалось скачать Java {version}: {error}', { version: required, error: e.message }));
  }
}

/** Major version of a java.exe (0 when unknown): from the detected list, otherwise `java -version`. */
async function javaMajorOf(javaPath) {
  if (!javaPath) return 0;
  const known = (await getJavaList()).find(j => path.resolve(j.path).toLowerCase() === path.resolve(javaPath).toLowerCase());
  if (known) return known.major || 0;
  const info = await checkJavaPath(javaPath).catch(() => null);
  return (info && info.major) || 0;
}

/** "Играет в AeterMC" in Discord: the build's name and its loader / Minecraft version. */
function showDiscordPresence(inst, versionLabel) {
  if (settingsManager.get().discordPresence === false) return;
  const details = inst ? inst.name : `Minecraft ${versionLabel}`;
  const state = inst
    ? `${inst.loader !== 'vanilla' ? `${LoaderManager.label(inst.loader)} · ` : ''}Minecraft ${inst.version}`
    : t('Без сборки');
  discord.setActivity({ details, state, start: Date.now(), largeText: `AeterMC ${app.getVersion()}` }).catch(() => {});
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1140,
    height: 740,
    minWidth: 980,
    minHeight: 640,
    frame: false,
    backgroundColor: currentTheme() ? currentTheme().preview.bg : '#111214',
    show: false,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const theme = currentTheme();
  if (theme) nativeTheme.themeSource = theme.mode;
  // `AeterMC.exe --setup` (or `npm start -- --setup`) opens the first-run setup again
  const query = { theme: theme ? theme.id : '', lang: i18n.language() };
  if (process.argv.includes('--setup')) query.setup = '1';
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query });
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Open external links in the system browser instead of a new Electron window
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  const sendMaximized = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window-maximized', mainWindow.isMaximized());
    }
  };
  mainWindow.on('maximize', sendMaximized);
  mainWindow.on('unmaximize', sendMaximized);

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (consoleWindow && !consoleWindow.isDestroyed()) consoleWindow.close();
  });
}

// ================= CONSOLE =================
// All log lines pass through here so a detached console window can show the full history.
const MAX_LOG_BUFFER = 4000;
const logBuffer = [];

function broadcast(channel, data) {
  for (const win of [mainWindow, consoleWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, data);
  }
}

function emitLog(entry) {
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOG_BUFFER) logBuffer.splice(0, logBuffer.length - MAX_LOG_BUFFER);
  broadcast('launch-log', entry);
}

function openConsoleWindow() {
  if (consoleWindow && !consoleWindow.isDestroyed()) {
    if (consoleWindow.isMinimized()) consoleWindow.restore();
    consoleWindow.focus();
    return;
  }
  const theme = currentTheme();
  if (theme) nativeTheme.themeSource = theme.mode;
  consoleWindow = new BrowserWindow({
    width: 900,
    height: 560,
    minWidth: 480,
    minHeight: 280,
    title: t('Консоль — AeterMC'),
    backgroundColor: theme ? theme.preview.bg : '#0b0c0f',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  if (themedIcon) consoleWindow.setIcon(themedIcon);
  consoleWindow.loadFile(path.join(__dirname, 'renderer', 'console.html'), { query: { theme: theme ? theme.id : '', lang: i18n.language() } });
  consoleWindow.on('closed', () => {
    consoleWindow = null;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('console-window', false);
  });
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('console-window', true);
}

ipcMain.on('write-log', (event, entry) => {
  if (entry && typeof entry.message === 'string') emitLog({ type: String(entry.type || 'info'), message: entry.message });
});
ipcMain.handle('get-log-buffer', () => logBuffer);
ipcMain.handle('clear-logs', () => {
  logBuffer.length = 0;
  broadcast('logs-cleared');
});
ipcMain.handle('open-console-window', () => openConsoleWindow());
ipcMain.handle('console-set-on-top', (event, onTop) => {
  if (consoleWindow && !consoleWindow.isDestroyed()) consoleWindow.setAlwaysOnTop(!!onTop);
});

app.whenReady().then(() => {
  applyLanguage();
  createWindow();

  // Only a built launcher updates itself; `npm start` runs from the sources
  if (app.isPackaged) {
    setTimeout(checkForUpdate, 5000);
    setInterval(checkForUpdate, 6 * 60 * 60 * 1000);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// ================= IPC HANDLERS =================

// Window Controls
// Icon drawn by the page in the current theme accent (see updateWindowIcon in app.js)
let themedIcon = null;
ipcMain.on('window-icon', (event, dataUrl) => {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) return;
  const img = nativeImage.createFromDataURL(dataUrl);
  if (img.isEmpty()) return;
  themedIcon = img;
  for (const win of [mainWindow, consoleWindow]) {
    if (win && !win.isDestroyed()) win.setIcon(img);
  }
});

ipcMain.on('window-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('window-maximize', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});

ipcMain.on('window-close', () => {
  if (mainWindow) mainWindow.close();
});

ipcMain.handle('window-is-maximized', () => {
  return mainWindow ? mainWindow.isMaximized() : false;
});

// Settings
// the developer tools in the settings: `npm start`, or the built app started with --dev
const IS_DEV = !app.isPackaged || process.argv.includes('--dev');

ipcMain.handle('get-settings', () => {
  const totalSystemRam = Math.round(os.totalmem() / (1024 * 1024 * 1024));
  return { ...settingsManager.get(), totalSystemRam, isDev: IS_DEV };
});

ipcMain.handle('save-settings', (event, newSettings) => {
  const ok = settingsManager.save(newSettings);
  if ('theme' in newSettings) applyThemeToWindows();
  if ('language' in newSettings) {
    applyLanguage();
    reloadWindows();
  }
  if (newSettings.gameDir) {
    versionManager.setGameDir(newSettings.gameDir);
    accountsManager.setGameDir(newSettings.gameDir);
    elyByManager.setGameDir(newSettings.gameDir);
  }
  if ('prismImport' in newSettings) {
    instancesManager.includePrism = newSettings.prismImport === true;
  }
  if (newSettings.autoUpdate) autoDownloadUpdate();
  if (newSettings.discordPresence === false) discord.clear();
  return ok;
});

// Accounts
ipcMain.handle('get-accounts', () => {
  return accountsManager.getAccounts();
});

ipcMain.handle('set-active-account', (event, id) => {
  return accountsManager.setActiveAccount(id);
});

ipcMain.handle('add-offline-account', (event, username) => {
  return accountsManager.addOfflineAccount(username);
});

// Microsoft login (device code, like Prism Launcher)
ipcMain.handle('ms-login-start', async () => {
  const code = await accountsManager.startMicrosoftLogin();
  const qr = await require('qrcode').toDataURL(code.linkUrl, { margin: 1, width: 360, color: { dark: '#000000', light: '#ffffff' } });
  return { userCode: code.userCode, verificationUri: code.verificationUri, linkUrl: code.linkUrl, expiresIn: code.expiresIn, qr };
});

ipcMain.handle('ms-login-wait', async () => {
  try {
    return { account: await accountsManager.finishMicrosoftLogin() };
  } catch (e) {
    if (e.cancelled) return { cancelled: true };
    throw e;
  }
});

ipcMain.handle('ms-login-cancel', () => {
  accountsManager.cancelMicrosoftLogin();
  return true;
});

ipcMain.handle('ms-login-open-browser', (event, url) => {
  // Only Microsoft's own sign-in page may be opened from here
  if (/^https:\/\/(www\.)?microsoft\.com\/link/.test(url)) shell.openExternal(url);
});

ipcMain.handle('login-elyby', async (event, username, password) => {
  return await accountsManager.loginElyBy(username, password);
});

ipcMain.handle('remove-account', (event, id) => {
  return accountsManager.removeAccount(id);
});

ipcMain.handle('prism-instances-count', () => {
  return instancesManager.countPrismInstances();
});

ipcMain.handle('prism-list', () => instancesManager.listPrismInstances());

// Copies the chosen Prism builds one by one, reporting progress to the window
ipcMain.handle('prism-import', async (event, keys) => {
  const imported = [];
  for (let i = 0; i < keys.length; i++) {
    const inst = await instancesManager.importPrismInstance(keys[i], (p) => {
      sendToWindow('prism-import-progress', { index: i, count: keys.length, ...p });
    });
    imported.push(inst);
  }
  return imported;
});

// Instances (MCL & Prism Launcher)
ipcMain.handle('list-instances', () => {
  return instancesManager.listInstances();
});

// The loader is installed before the build folder appears, so a failed install leaves nothing behind
ipcMain.handle('create-instance', async (event, options = {}) => {
  const { loader = 'vanilla', version } = options;
  if (loader === 'vanilla') return await instancesManager.createInstance(options);
  const installed = await loaderManager.install(loader, version, options.loaderVersion || '', {
    onStatus: (text) => sendToWindow('loader-install-progress', text),
    getJava: () => javaForVersion(version)
  });
  return await instancesManager.createInstance({ ...options, loaderVersion: installed.loaderVersion, versionId: installed.id });
});

ipcMain.handle('copy-instance', (event, instanceId, newName) => {
  return instancesManager.copyInstance(instanceId, newName);
});

ipcMain.handle('delete-instance', (event, instanceId) => {
  return instancesManager.deleteInstance(instanceId);
});

// choice: { block } | { file: <image path> } | null. Images are center-cropped to a square, at most 256px.
ipcMain.handle('rename-instance', (event, instanceId, name) => {
  return instancesManager.renameInstance(instanceId, name);
});

ipcMain.handle('set-instance-loader', (event, instanceId, version) => {
  if (launcherCore.isRunning || launcherCore.isLaunching) throw new Error(t('Сначала закройте игру'));
  return instancesManager.setLoaderVersion(instanceId, String(version || ''));
});

// Mod problems of a build (mod-check.js), for the launch check and the build's page
ipcMain.handle('check-instance-mods', (event, instanceId) => {
  const inst = findInstanceOrThrow(instanceId);
  return inst.loader === 'vanilla' ? { issues: [], mods: 0 } : checkBuild(inst);
});

// only the report the last crash analysis named can be opened
let lastCrashReport = null;
let lastCrashLog = null;
ipcMain.handle('open-crash-report', () => {
  if (lastCrashReport && fs.existsSync(lastCrashReport)) return shell.openPath(lastCrashReport);
  return false;
});
ipcMain.handle('open-crash-log', () => {
  if (lastCrashLog && fs.existsSync(lastCrashLog)) return shell.openPath(lastCrashLog);
  return false;
});

// ---- developer tools: the crash window on samples or on a build's newest real crash report ----
function devOnly() {
  if (!IS_DEV) throw new Error('Developer tools are off');
}

function devSamplesOrThrow() {
  devOnly();
  if (!devSamples) throw new Error('dev-samples.js is missing');
  return devSamples;
}

/** Runs the real analyzer and opens the crash window as after a real crash. */
function showDevCrash(instanceId, input) {
  const inst = instanceId ? instancesManager.listInstances().find(i => i.id === instanceId) : null;
  const opt = { ...settingsManager.get(), ...((inst && inst.launch) || {}) };
  const analysis = analyzeCrash({
    jars: inst && inst.loader !== 'vanilla' ? scanModsDir(inst.modsDir) : [],
    maxRam: opt.maxRam || 4, javaMajor: 17, ...input
  });
  lastCrashReport = analysis.reportFile;
  lastCrashLog = analysis.logFile || null;
  sendToWindow('game-crashed', { ...analysis, instanceId: inst ? inst.id : null, code: input.exitCode, dev: true });
  return analysis;
}

ipcMain.handle('dev-crash-samples', () => {
  return devSamplesOrThrow().sampleList();
});

ipcMain.handle('dev-crash-sample', (event, instanceId, name) => {
  return showDevCrash(instanceId, devSamplesOrThrow().prepareSample(String(name)));
});

// the newest crash report of the build, whatever its age
ipcMain.handle('dev-crash-latest', (event, instanceId) => {
  devOnly();
  const inst = findInstanceOrThrow(instanceId);
  return showDevCrash(inst.id, { gameDir: inst.minecraftDir, since: 0, output: [], exitCode: -1 });
});

ipcMain.handle('set-instance-launch', (event, instanceId, launch) => {
  return instancesManager.setLaunchSettings(instanceId, launch);
});

ipcMain.handle('set-instance-icon', (event, instanceId, choice) => {
  if (choice && choice.file) {
    let img = nativeImage.createFromPath(choice.file);
    if (img.isEmpty()) throw new Error(t('Не удалось открыть картинку — подойдёт PNG или JPG'));
    const { width, height } = img.getSize();
    const side = Math.min(width, height);
    img = img.crop({ x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side });
    if (side > 256) img = img.resize({ width: 256, height: 256, quality: 'best' });
    choice = { png: img.toPNG() };
  }
  return instancesManager.setInstanceIcon(instanceId, choice);
});

// kind: 'mod' | 'resourcepack' | 'shader' (content-types.js); the mods page works with all three
ipcMain.handle('list-instance-mods', (event, instanceId, kind = 'mod') => {
  return instancesManager.listInstanceMods(instanceId, kind);
});

ipcMain.handle('toggle-instance-mod', (event, instanceId, fileName, enable, kind = 'mod') => {
  return instancesManager.toggleInstanceMod(instanceId, fileName, enable, kind);
});

ipcMain.handle('add-instance-mod', (event, instanceId, filePath, kind = 'mod') => {
  return instancesManager.addModToInstance(instanceId, filePath, kind);
});

ipcMain.handle('delete-instance-mod', (event, instanceId, fileName, kind = 'mod') => {
  return instancesManager.deleteInstanceMod(instanceId, fileName, kind);
});

// Modrinth modpacks (.mrpack)
ipcMain.handle('mrpack-inspect', (event, file) => mrpackManager.inspect(file));

ipcMain.handle('mrpack-import', async (event, file, name) => {
  return await mrpackManager.importPack(file, {
    name: String(name || ''),
    onProgress: (p) => sendToWindow('mrpack-progress', p),
    getJava: (version) => javaForVersion(version)
  });
});

function findInstanceOrThrow(instanceId) {
  const inst = instancesManager.listInstances().find(i => i.id === instanceId);
  if (!inst) throw new Error(t('Сборка не найдена'));
  return inst;
}

ipcMain.handle('mrpack-export-entries', (event, instanceId) => {
  return mrpackManager.listExportEntries(findInstanceOrThrow(instanceId));
});

// The file is picked here, not by the page, so the page cannot write anywhere it likes
ipcMain.handle('mrpack-export', async (event, instanceId, options = {}) => {
  const inst = findInstanceOrThrow(instanceId);
  const name = String(options.name || '').trim() || inst.name;
  const version = String(options.version || '').trim() || '1.0.0';
  const fileName = `${name} ${version}`.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '');
  const prism = options.format === 'prism';
  const result = await dialog.showSaveDialog(mainWindow, prism
    ? {
      title: t('Сохранить сборку для Prism Launcher'),
      defaultPath: path.join(app.getPath('downloads'), `${fileName || 'instance'}.zip`),
      filters: [{ name: t('Сборка Prism Launcher'), extensions: ['zip'] }]
    }
    : {
      title: t('Сохранить модпак'),
      defaultPath: path.join(app.getPath('downloads'), `${fileName || 'modpack'}.mrpack`),
      filters: [{ name: t('Модпак Modrinth'), extensions: ['mrpack'] }]
    });
  if (result.canceled || !result.filePath) return null;
  const include = Array.isArray(options.include) ? options.include.map(String) : [];
  const progress = (p) => sendToWindow('mrpack-progress', p);
  if (prism) {
    const allowed = new Set(mrpackManager.listExportEntries(inst).map(e => e.name));
    // the archive carries the name typed in the dialog, as Prism shows it
    return { format: 'prism', ...(await exportPrism({ ...inst, name }, { include, allowed, file: result.filePath }, progress)) };
  }
  return await mrpackManager.exportPack(inst, { name, version, include, file: result.filePath }, progress);
});

ipcMain.handle('mrpack-reveal', (event, file) => {
  if (typeof file === 'string' && /\.mrpack$/i.test(file) && fs.existsSync(file)) shell.showItemInFolder(path.resolve(file));
});

ipcMain.handle('open-instance-folder', (event, instanceId) => {
  const instances = instancesManager.listInstances();
  const inst = instances.find(i => i.id === instanceId);
  if (inst && fs.existsSync(inst.path)) {
    shell.openPath(inst.path);
    return true;
  }
  return false;
});

// Transfer of game settings (options.txt) between profiles
function listSyncProfiles() {
  const root = settingsManager.get().gameDir || DEFAULT_MINECRAFT_DIR;
  return [
    { id: 'global', name: t('Общая папка .minecraft'), dir: root },
    ...instancesManager.listInstances().map(i => ({ id: i.id, name: i.name, dir: i.minecraftDir, noSync: !!(i.launch && i.launch.noOptionsSync) }))
  ];
}

function findSyncProfile(id) {
  const profile = listSyncProfiles().find(p => p.id === id);
  if (!profile) throw new Error(t('Сборка не найдена'));
  return profile;
}

ipcMain.handle('options-sync-categories', () => {
  return optionsSync.CATEGORIES.map(c => ({ id: c.id, label: c.label }));
});

// Without sourceId picks the profile whose settings were changed most recently
// Builds with "don't sync" are left out of the automatic transfer both ways; a manual one (sourceId) still works.
// details: per category the changed settings in plain words, for the dialog
ipcMain.handle('options-sync-check', (event, targetId, sourceId) => {
  const target = findSyncProfile(targetId);
  if (!sourceId && target.noSync) return { source: null, diff: {}, details: {}, noSync: true };
  const source = sourceId
    ? findSyncProfile(sourceId)
    : optionsSync.findNewestSource(target.dir, listSyncProfiles().filter(p => !p.noSync));
  if (!source) return { source: null, diff: {}, details: {} };
  const from = optionsSync.readOptions(source.dir);
  const to = optionsSync.readOptions(target.dir);
  const diff = optionsSync.diffOptions(from, to);
  const raw = optionsSync.detailOptions(from, to);
  // a mod's key the target has never seen and the source leaves unassigned changes nothing visible
  const visible = (c) => !(c.from === null && /^key_/.test(c.key) && /key\.keyboard\.unknown/.test(c.to));
  const details = Object.fromEntries(Object.entries(raw).map(([cat, list]) => [cat, list.filter(visible).map(c => describeChange(c.key, c.from, c.to))]));
  for (const cat of Object.keys(details)) diff[cat] = details[cat].length;
  return { source: { id: source.id, name: source.name, time: optionsSync.getMtime(source.dir) }, diff, details };
});

ipcMain.handle('options-sync-apply', (event, targetId, sourceId, categoryIds) => {
  if (launcherCore.isRunning || launcherCore.isLaunching) {
    throw new Error(t('Закройте игру перед переносом настроек'));
  }
  const target = findSyncProfile(targetId);
  const source = findSyncProfile(sourceId);
  return optionsSync.applyOptions(source.dir, target.dir, categoryIds);
});

// Modrinth
ipcMain.handle('search-modrinth', async (event, options) => {
  return await modrinthManager.searchMods(options);
});

// Mods, resource packs and shaders are installed only into a build
// Version and loader always come from the build itself, never from the page
function findContentInstance(instanceId, kind = 'mod') {
  contentType(kind);
  const inst = instancesManager.listInstances().find(i => i.id === instanceId);
  if (!inst) throw new Error(t('Моды можно устанавливать только в сборку'));
  // resource packs work everywhere; shaders need Iris or OptiFine, which are mods
  if (kind !== 'resourcepack' && inst.loader === 'vanilla') throw new Error(t('В сборке без загрузчика моды не работают'));
  return { inst, dir: contentDir(inst, kind) };
}

ipcMain.handle('install-modrinth-mod', async (event, projectId, instanceId, kind = 'mod') => {
  const { inst, dir } = findContentInstance(instanceId, kind);
  return await modrinthManager.installMod(projectId, inst.version, inst.loader, dir, kind);
});

ipcMain.handle('scan-instance-mods', async (event, instanceId, force, kind = 'mod') => {
  const { inst, dir } = findContentInstance(instanceId, kind);
  return await modrinthManager.scanMods(dir, inst.version, inst.loader, { force: !!force, kind });
});

ipcMain.handle('update-instance-mod', async (event, instanceId, fileName, kind = 'mod') => {
  const { inst, dir } = findContentInstance(instanceId, kind);
  if (path.basename(fileName) !== fileName) throw new Error(t('Некорректное имя файла'));
  return await modrinthManager.updateMod(dir, fileName, inst.version, inst.loader, kind);
});

// Versions & Java
ipcMain.handle('get-versions', async (event, showSnapshots) => {
  return await versionManager.getAllVersions(showSnapshots);
});

ipcMain.handle('install-fabric', async (event, gameVersion, loaderVersion) => {
  return await versionManager.installFabric(gameVersion, loaderVersion);
});

ipcMain.handle('get-loader-versions', async (event, loader, gameVersion) => {
  return await loaderManager.listVersions(loader, gameVersion);
});

ipcMain.handle('detect-java', async (event, force) => {
  return await getJavaList(!!force);
});

ipcMain.handle('install-java', async (event, major) => {
  const m = Number(major);
  if (![8, 11, 16, 17, 21, 25].includes(m)) throw new Error(t('Неизвестная версия Java'));
  return await installJava(m);
});

// Java versions the launcher's builds need, and whether each is available
ipcMain.handle('java-requirements', async () => {
  const majors = new Set();
  for (const inst of instancesManager.listInstances()) {
    try {
      majors.add(await versionManager.getRequiredJava(inst.version));
    } catch (e) {}
  }
  if (!majors.size) majors.add(21);
  const list = await getJavaList();
  return [...majors].sort((a, b) => a - b).map(major => {
    const found = pickJavaFor(list, major);
    return { major, path: found ? found.path : null };
  });
});

// File dialogs
ipcMain.handle('browse-file', async (event, options = {}) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: options.title || t('Выберите файл'),
    properties: ['openFile'],
    filters: options.filters || []
  });
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

ipcMain.handle('browse-folder', async (event, options = {}) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: options.title || t('Выберите папку'),
    properties: ['openDirectory', 'createDirectory']
  });
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

ipcMain.handle('open-folder', async (event, type) => {
  const baseDir = settingsManager.get().gameDir || DEFAULT_MINECRAFT_DIR;
  let target = baseDir;

  switch (type) {
    case 'instances':
      target = instancesManager.instancesDir;
      break;
    case 'mods':
      target = path.join(baseDir, 'mods');
      break;
    case 'screenshots':
      target = path.join(baseDir, 'screenshots');
      break;
    case 'saves':
      target = path.join(baseDir, 'saves');
      break;
    default:
      target = baseDir;
  }

  if (!fs.existsSync(target)) {
    try {
      fs.mkdirSync(target, { recursive: true });
    } catch (e) {}
  }

  return await shell.openPath(target);
});

// Weekly playtime chart on the home page
ipcMain.handle('get-playtime-days', () => playtimeLog.read());

// Screenshots page
function currentScreenshotSources() {
  const root = settingsManager.get().gameDir || DEFAULT_MINECRAFT_DIR;
  return screenshots.screenshotSources(root, instancesManager.listInstances());
}

function checkedScreenshot(file) {
  if (!screenshots.isScreenshotPath(file, currentScreenshotSources())) throw new Error(t('Это не скриншот'));
  return path.resolve(file);
}

// Folders are (re)watched on every listing, so new builds and changed .minecraft are picked up
let stopScreenshotWatch = null;
ipcMain.handle('list-screenshots', () => {
  const sources = currentScreenshotSources();
  if (stopScreenshotWatch) stopScreenshotWatch();
  stopScreenshotWatch = screenshots.watchScreenshots(sources, () => sendToWindow('screenshots-changed'));
  return screenshots.listScreenshots(sources);
});

ipcMain.handle('screenshot-reveal', (event, file) => {
  shell.showItemInFolder(checkedScreenshot(file));
  return true;
});

ipcMain.handle('screenshot-copy', (event, file) => {
  const image = nativeImage.createFromPath(checkedScreenshot(file));
  if (image.isEmpty()) throw new Error(t('Не удалось прочитать картинку'));
  clipboard.writeImage(image);
  return true;
});

// the editor gets the picture as a data: URL: a file: image would taint its canvas
ipcMain.handle('screenshot-read', async (event, file) => {
  const full = checkedScreenshot(file);
  const ext = path.extname(full).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  return `data:${mime};base64,${(await fs.promises.readFile(full)).toString('base64')}`;
});

function pngFromDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) throw new Error(t('Не удалось прочитать картинку'));
  return Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64');
}

/**
 * Saves an edited screenshot next to the original: mode 'copy' as <name>-edited.png (-2, -3… when taken),
 * 'replace' puts the original in the Recycle Bin and writes <name>.png in its place.
 */
ipcMain.handle('screenshot-save', async (event, file, dataUrl, mode) => {
  const full = checkedScreenshot(file);
  const png = pngFromDataUrl(dataUrl);
  const dir = path.dirname(full);
  const stem = path.basename(full, path.extname(full));
  let target;
  if (mode === 'replace') {
    target = path.join(dir, `${stem}.png`);
    await shell.trashItem(full);
  } else {
    const clean = stem.replace(/-edited(-\d+)?$/, '');
    target = path.join(dir, `${clean}-edited.png`);
    for (let n = 2; fs.existsSync(target); n++) target = path.join(dir, `${clean}-edited-${n}.png`);
  }
  await fs.promises.writeFile(target, png);
  return target;
});

ipcMain.handle('image-copy-data', (event, dataUrl) => {
  const image = nativeImage.createFromBuffer(pngFromDataUrl(dataUrl));
  if (image.isEmpty()) throw new Error(t('Не удалось прочитать картинку'));
  clipboard.writeImage(image);
  return true;
});

// to the Recycle Bin, so a mistake can be undone
ipcMain.handle('screenshot-delete', async (event, file) => {
  await shell.trashItem(checkedScreenshot(file));
  return true;
});

// Game Launching
function sendToWindow(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

// true for the whole launch, including loader/Java preparation before launcherCore starts
let launchInProgress = false;
let runningInstanceId = null; // build the running game was started from
let killedByUser = false; // "Stop" in the launcher is not a crash

ipcMain.handle('launch-game', async (event, launchOpts = {}) => {
  const settings = settingsManager.get();
  const root = settings.gameDir || DEFAULT_MINECRAFT_DIR;
  const log = (type, message) => emitLog({ type, message });

  launchInProgress = true;
  try {
    const account = await accountsManager.getLaunchAccount((text) => log('warn', `[AUTH]: ${text}`));

    // Work out which version to start and where the game files live.
    // Versions, libraries and assets are shared in root; saves/mods are per instance.
    let gameDir = root;
    let versionNumber;
    let customVersion = null;
    let instanceId = null;
    let inst = null;

    if (launchOpts.instanceId) {
      inst = instancesManager.listInstances().find(i => i.id === launchOpts.instanceId);
      if (!inst) throw new Error(t('Сборка не найдена'));
      instanceId = inst.id;
      gameDir = inst.minecraftDir;
      versionNumber = inst.version;

      // mods that will not start together: asked before anything is downloaded or started
      if (inst.loader !== 'vanilla') {
        const check = checkBuild(inst);
        check.issues.filter(i => i.level === 'warn').forEach(i => log('warn', `[MODS]: ${i.text}`));
        const errors = check.issues.filter(i => i.level === 'error');
        if (errors.length && !launchOpts.ignoreModIssues) {
          errors.forEach(i => log('warn', `[MODS]: ${i.text}`));
          return { success: false, modIssues: check.issues, instanceId: inst.id };
        }
      }

      if (inst.loader !== 'vanilla') {
        // installed when the build was made; builds from Prism or a cleaned versions/ get it now
        log('info', `[LAUNCHER]: ${t('Подготовка {loader} {version} для {mc}', { loader: LoaderManager.label(inst.loader), version: inst.loaderVersion || '', mc: inst.version })}`);
        const profile = await loaderManager.ensure(inst.loader, inst.version, inst.loaderVersion, {
          knownId: inst.versionId,
          onStatus: (text, { progress } = {}) => { if (!progress) log('info', `[LAUNCHER]: ${text}`); },
          getJava: () => javaForVersion(inst.version, log)
        });
        customVersion = profile.id;
      }
    } else {
      const resolved = versionManager.resolveLaunchVersion(launchOpts.version || settings.selectedVersion || '1.21.1');
      versionNumber = resolved.number;
      customVersion = resolved.custom;
    }

    // the build's own launch settings over the launcher ones (see instances-manager.js LAUNCH_KEYS)
    const own = (inst && inst.launch) || {};
    if (Object.keys(own).length) log('info', `[LAUNCHER]: ${t('У сборки свои настройки запуска')}`);
    const opt = { ...settings, ...own };

    // Java: explicit choice from the build or settings, otherwise the one matching the version
    const javaPath = opt.javaPath || await javaForVersion(customVersion || versionNumber, log);
    const javaMajor = await javaMajorOf(javaPath);

    log('info', `[LAUNCHER]: ${t('Версия {version}, папка игры: {dir}', { version: customVersion || versionNumber, dir: gameDir })}`);

    // the game's own output of this session, for the crash analysis
    const sessionStart = Date.now();
    const output = [];
    killedByUser = false;

    await launcherCore.launch(
      {
        account,
        root,
        gameDir,
        version: versionNumber,
        customVersion,
        versionType: 'release',
        javaPath,
        minRam: opt.minRam || 2,
        maxRam: opt.maxRam || 4,
        customJvmArgs: opt.customJvmArgs || '',
        jvmPreset: opt.jvmPreset || 'auto',
        javaMajor,
        profileJvmArgs: customVersion ? loaderManager.jvmArgs(customVersion) : [],
        resolutionWidth: opt.resolutionWidth || 1280,
        resolutionHeight: opt.resolutionHeight || 720,
        fullscreen: opt.fullscreen || false,
        elyByManager
      },
      {
        onProgress: (progressData) => sendToWindow('launch-progress', progressData),
        onLog: (logData) => {
          if (logData.type === 'stdout' || logData.type === 'error') {
            output.push(String(logData.message));
            if (output.length > 3000) output.splice(0, output.length - 3000);
          }
          emitLog(logData);
        },
        onLaunched: () => {
          if (instanceId) instancesManager.markLaunched(instanceId);
          runningInstanceId = instanceId;
          sendToWindow('game-launched', instanceId);
          showDiscordPresence(inst, customVersion || versionNumber);
          if (!mainWindow || mainWindow.isDestroyed()) return;
          if (settings.actionAfterLaunch === 'minimize') {
            mainWindow.minimize();
          } else if (settings.actionAfterLaunch === 'hide') {
            mainWindow.hide();
          }
        },
        onClose: (code, durationSeconds) => {
          runningInstanceId = null;
          discord.clear();
          // a crash: an error exit code, or a crash report written during the session
          if (!killedByUser) {
            try {
              const analysis = analyzeCrash({
                gameDir, since: sessionStart, output, exitCode: code,
                jars: inst && inst.loader !== 'vanilla' ? scanModsDir(inst.modsDir) : [],
                maxRam: opt.maxRam || 4, javaMajor
              });
              if ((code !== 0 && code !== null) || analysis.reportFile) {
                lastCrashReport = analysis.reportFile;
                lastCrashLog = analysis.logFile || null;
                log('error', `[CRASH]: ${analysis.title}. ${analysis.text}`);
                sendToWindow('game-crashed', { ...analysis, instanceId, code });
              }
            } catch (e) {
              console.error('[Crash analysis]', e);
            }
          }
          playtimeLog.add(durationSeconds || 0);
          if (instanceId) {
            instancesManager.updatePlaytime(instanceId, durationSeconds || 0);
          }
          sendToWindow('game-closed', code);
          if (mainWindow && !mainWindow.isDestroyed() && settings.actionAfterLaunch !== 'keep') {
            mainWindow.show();
            mainWindow.restore();
          }
        }
      }
    );

    return { success: true };
  } catch (err) {
    sendToWindow('launch-error', err.message);
    return { success: false, error: err.message };
  } finally {
    launchInProgress = false;
  }
});

// lets a reloaded window (Ctrl+R) pick up a game that is still starting or running
ipcMain.handle('get-game-state', () => ({
  running: !!launcherCore.isRunning,
  instanceId: launcherCore.isRunning ? runningInstanceId : null,
  launching: launchInProgress || !!launcherCore.isLaunching
}));

// Launcher update: the button left of the window controls and the update menu
ipcMain.handle('update-get-state', () => updater.state);
ipcMain.handle('update-check', () => checkForUpdate());
ipcMain.handle('update-releases', () => updater.releases());
ipcMain.handle('update-download', () => updater.download());
ipcMain.handle('update-restart', () => {
  if (launchInProgress || launcherCore.isRunning || launcherCore.isLaunching) {
    throw new Error(t('Сначала закройте игру: лаунчер перезапустится для обновления'));
  }
  if (!updater.startSwap(true)) return false;
  app.quit();
  return true;
});
// the found release, or with all = true the list of every release
ipcMain.handle('update-open-page', (event, all) => {
  const page = all ? updater.state.releasesPage : updater.state.page;
  if (page) shell.openExternal(page);
});
// a downloaded update is put in place on exit even without "restart"
app.on('will-quit', () => updater.startSwap(false));

ipcMain.handle('kill-game', () => {
  killedByUser = true;
  return launcherCore.kill();
});
