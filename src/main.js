/**
 * main.js
 * electron Main Process for AeterMC.
 */

// AeterMC-Setup.exe and `AeterMC.exe --uninstall` are this same app in installer mode
// in the source tree the installer lives under installer/src.
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
const AdmZip = require('adm-zip');
const { acquireLaunchLock } = require('./launch-utils');

const { SettingsManager, DEFAULT_MINECRAFT_DIR } = require('./settings-manager');
const { manualSource, pathKey, realDirectory } = require('./multimc-sources');
const { normalizeHomeLayout } = require('./renderer/home-layout');
const i18n = require('./i18n/i18n');
const { t } = i18n;
const { VersionManager } = require('./version-manager');
const { LoaderManager } = require('./loaders');
const { detectJavaInstallations, pickJavaFor, checkJavaPath, checkJavaGc } = require('./java-detector');
const { DiscordPresence } = require('./discord-rpc');
const { LauncherCore } = require('./launcher-core');
const { AccountsManager } = require('./accounts-manager');
const { InstancesManager, resolveLaunchSettings } = require('./instances-manager');
const { ModrinthManager } = require('./modrinth-manager');
const { MrpackManager } = require('./mrpack');
const { exportPrism } = require('./prism-export');
const { inspectInstanceZip, importInstanceZip } = require('./prism-import');
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
const { LaunchProfiler, formatLaunchProfile } = require('./launch-profiler');
const { readNativePlaytime, withNativePlaytime } = require('./native-v2-playtime');
const { Updater } = require('./updater');
const { isPackageManagerInstall } = require('./installation');
const isAppImage = process.platform === 'linux' && !!process.env.APPIMAGE;
const packageManaged = isPackageManagerInstall({
  platform: process.platform,
  appImage: isAppImage,
  isPackaged: app.isPackaged,
  distribution: require('../package.json').distribution,
  appPath: app.getAppPath()
});
const screenshots = require('./screenshots');
const https = require('https');
const axios = require('axios');

// reuse TLS connections to Mojang / Modrinth / Fabric instead of a new handshake per request
axios.defaults.httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 16 });

// the UI is flat HTML without heavy animation: software rendering skips GPU process start-up
// (window shows ~0.2 s sooner) and saves ~25 MB of memory.
app.disableHardwareAcceleration();
// same id as the installer's shortcuts, so the taskbar groups the window with the pinned shortcut
app.setAppUserModelId('dev.aetermc.launcher');

let mainWindow = null;
let mainWindowNativeTitlebar = false;
let consoleWindow = null;

// theme list generated from design/themes by `npm run tokens`
let THEMES = [];
try {
  THEMES = require('./themes.json');
} catch (e) {}

function currentTheme() {
  const id = settingsManager.get().theme;
  return THEMES.find(t => t.id === id) || THEMES.find(t => t.id === 'dark-mono') || THEMES[0] || null;
}

/** the chosen language, or until one is chosen in the settings the system one. */
function applyLanguage() {
  i18n.setLanguage(settingsManager.get().language || i18n.detectLanguage(app.getPreferredSystemLanguages()));
}

/** the pages get the language in the URL: after a change they are loaded again, the main one on the settings. */
function reloadWindows() {
  const theme = currentTheme();
  const query = { theme: theme ? theme.id : '', lang: i18n.language() };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query: { ...query, page: 'settings', nativeTitlebar: String(mainWindowNativeTitlebar) } });
  }
  if (consoleWindow && !consoleWindow.isDestroyed()) {
    consoleWindow.setTitle(t('Консоль — AeterMC'));
    consoleWindow.loadFile(path.join(__dirname, 'renderer', 'console.html'), { query });
  }
}

/** window background before the page paints, and the colors of native parts (title bar of the console window). */
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
app.setPath('userData', require('./data-dir').DATA_DIR);
const userDataDir = app.getPath('userData');

const settingsManager = new SettingsManager(userDataDir);
const currentSettings = settingsManager.get();
i18n.setLanguage(currentSettings.language || 'ru');

// not "cache": on Windows that is the same folder as Chromium's own Cache, which it cleans on startup
const diskCache = new DiskCache(path.join(userDataDir, 'mcl-cache'));
const versionManager = new VersionManager(currentSettings.gameDir, diskCache);
const loaderManager = new LoaderManager(versionManager);
const accountsManager = new AccountsManager(userDataDir, currentSettings.gameDir);
const instancesManager = new InstancesManager(userDataDir, versionManager);
instancesManager.includePrism = currentSettings.prismImport === true;
instancesManager.externalFolders = Array.isArray(currentSettings.externalInstanceFolders)
  ? currentSettings.externalInstanceFolders.filter(folder => typeof folder === 'string' && path.isAbsolute(folder)) : [];
const modrinthManager = new ModrinthManager(diskCache);
const mrpackManager = new MrpackManager(instancesManager, loaderManager, modrinthManager);
const elyByManager = new ElyByManager(currentSettings.gameDir);
const launcherCore = new LauncherCore();
const playtimeLog = new PlaytimeLog(userDataDir);
const launchProfiler = new LaunchProfiler(userDataDir);
const discord = new DiscordPresence();

const BLOCK_TEXTURES = {
  grass: 'grass_block_top',
  stone: 'stone',
  sand: 'sand',
  planks: 'oak_planks',
  snow: 'snow',
  diamond: 'diamond_ore',
  netherrack: 'netherrack',
  'end-stone': 'end_stone',
  obsidian: 'obsidian',
  copper: 'copper_block',
  ice: 'ice',
  moss: 'moss_block'
};
let blockTextureCache = { gameDir: '', icons: null };

function minecraftBlockTextures() {
  if (blockTextureCache.gameDir === versionManager.gameDir && Object.keys(blockTextureCache.icons || {}).length) return blockTextureCache.icons;
  const icons = {};
  const versionsDir = path.join(versionManager.gameDir, 'versions');
  if (fs.existsSync(versionsDir)) {
    const jars = fs.readdirSync(versionsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(versionsDir, entry.name, `${entry.name}.jar`))
      .filter(file => fs.existsSync(file))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const jar of jars) {
      try {
        const zip = new AdmZip(jar);
        for (const [name, texture] of Object.entries(BLOCK_TEXTURES)) {
          const entry = zip.getEntry(`assets/minecraft/textures/block/${texture}.png`);
          if (entry) icons[name] = `data:image/png;base64,${entry.getData().toString('base64')}`;
        }
        if (Object.keys(icons).length) break;
      } catch (e) {}
    }
  }
  blockTextureCache = { gameDir: versionManager.gameDir, icons };
  return icons;
}
// launcher self-update from GitHub Releases (see updater.js)
const updater = new Updater({
  currentVersion: app.getVersion(),
  electronVersion: process.versions.electron,
  resourcesDir: process.resourcesPath,
  exePath: app.getPath('exe'),
  portable: !!process.env.PORTABLE_EXECUTABLE_FILE,
  // the in-place updater uses Windows tooling.
  enabled: (app.isPackaged && process.platform === 'win32') || isAppImage,
  packageManaged,
  onChange: (state) => sendToWindow('update-state', state)
});

/** checks for a launcher update; with "download automatically" on, a found one is downloaded right away. */
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
// java the launcher downloaded itself lives here (see java-installer.js)
const { JavaInstaller } = require('./java-installer');
const javaInstaller = new JavaInstaller(path.join(userDataDir, 'runtimes'));

async function getJavaList(force = false) {
  if (!javaCache || force) javaCache = await detectJavaInstallations([javaInstaller.dir], diskCache);
  return javaCache;
}

/** downloads Temurin <major>, reporting progress to the window, and refreshes the Java list. */
async function installJava(major) {
  const exe = await javaInstaller.install(major, (p) => sendToWindow('java-install-progress', { major, ...p }));
  await getJavaList(true);
  return exe;
}

/** java that fits a Minecraft version: an installed one, otherwise Temurin is downloaded. */
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

/** major version of a java.exe (0 when unknown): from the detected list, otherwise `java -version`. */
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

function disableReloadShortcut(win) {
  win.webContents.on('before-input-event', (event, input) => {
    if (input.control && input.key.toLowerCase() === 'r') event.preventDefault();
  });
}

function createWindow() {
  mainWindowNativeTitlebar = settingsManager.get().nativeTitlebar === true;
  mainWindow = new BrowserWindow({
    width: 1140,
    height: 740,
    minWidth: 980,
    minHeight: 640,
    frame: mainWindowNativeTitlebar,
    autoHideMenuBar: mainWindowNativeTitlebar,
    backgroundColor: currentTheme() ? currentTheme().preview.bg : '#111214',
    show: false,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  disableReloadShortcut(mainWindow);

  const theme = currentTheme();
  if (theme) nativeTheme.themeSource = theme.mode;
  // `AeterMC.exe --setup` (or `npm start -- --setup`) opens the first-run setup again
  const query = {
    theme: theme ? theme.id : '',
    lang: i18n.language(),
    nativeTitlebar: String(mainWindowNativeTitlebar)
  };
  if (process.argv.includes('--setup')) query.setup = '1';
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query });
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // open external links in the system browser instead of a new Electron window
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

// console
// all log lines pass through here so a detached console window can show the full history.
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
  disableReloadShortcut(consoleWindow);
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

app.whenReady().then(async () => {
  applyLanguage();
  instancesManager.migrateLegacyInstances();
  createWindow();

  if (updater.state.enabled) {
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

// ipc handlers

// window Controls
// icon drawn by the page in the current theme accent (see updateWindowIcon in app.js)
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

// settings
// the developer tools in the settings: `npm start`, or the built app started with --dev
const IS_DEV = !app.isPackaged || process.argv.includes('--dev');

ipcMain.handle('get-settings', () => {
  const totalSystemRam = Math.round(os.totalmem() / (1024 * 1024 * 1024));
  return { ...settingsManager.get(), totalSystemRam, isDev: IS_DEV };
});

ipcMain.handle('save-settings', (event, newSettings) => {
  newSettings = { ...newSettings };
  delete newSettings.externalInstanceFolders;
  if ('homeLayout' in newSettings) newSettings.homeLayout = normalizeHomeLayout(newSettings.homeLayout);
  const ok = settingsManager.save(newSettings);
  if (!ok) return false;
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

// accounts
ipcMain.handle('get-accounts', () => {
  return accountsManager.getAccounts();
});

ipcMain.handle('set-active-account', (event, id) => {
  return accountsManager.setActiveAccount(id);
});

ipcMain.handle('add-offline-account', (event, username) => {
  return accountsManager.addOfflineAccount(username);
});

// microsoft login (device code, like Prism Launcher)
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
  // only Microsoft's own sign-in page may be opened from here
  if (/^https:\/\/(www\.)?microsoft\.com\/link/.test(url)) shell.openExternal(url);
});

ipcMain.handle('login-elyby', async (event, username, password) => {
  return await accountsManager.loginElyBy(username, password);
});

ipcMain.handle('remove-account', (event, id) => {
  return accountsManager.removeAccount(id);
});

ipcMain.handle('prism-instances-count', () => {
  return instancesManager.listExternalInstances().length;
});

ipcMain.handle('prism-list', () => instancesManager.listExternalImports());

function saveExternalFolders(folders) {
  if (!settingsManager.save({ externalInstanceFolders: folders })) throw new Error(t('Не удалось сохранить папки сборок'));
  instancesManager.externalFolders = folders;
  return folders;
}

ipcMain.handle('mmc-add-folder', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: t('Выберите папку лаунчера или сборок'), properties: ['openDirectory']
  });
  if (canceled || !filePaths[0]) return null;
  const folder = realDirectory(filePaths[0]);
  const source = folder && manualSource(folder);
  const own = pathKey(realDirectory(instancesManager.instancesDir) || instancesManager.instancesDir);
  if (!source || pathKey(source.dir) === own || pathKey(source.dir).startsWith(own + path.sep)) {
    throw new Error(t('В выбранной папке нет совместимых сборок'));
  }
  const folders = instancesManager.externalFolders;
  if (folders.some(item => pathKey(manualSource(item)?.dir || item) === pathKey(source.dir))) return folders;
  return saveExternalFolders([...folders, folder]);
});

ipcMain.handle('mmc-remove-folder', (event, folder) => {
  return saveExternalFolders(instancesManager.externalFolders.filter(item => item !== folder));
});

// copies the chosen Prism builds one by one, reporting progress to the window
ipcMain.handle('prism-import', async (event, keys) => {
  if (!Array.isArray(keys)) return [];
  keys = [...new Set(keys.filter(key => typeof key === 'string'))];
  const candidates = instancesManager.listExternalInstances();
  const imported = [];
  for (let i = 0; i < keys.length; i++) {
    const inst = await instancesManager.importExternalInstance(keys[i], (p) => {
      sendToWindow('prism-import-progress', { index: i, count: keys.length, ...p });
    }, candidates);
    imported.push(inst);
  }
  return imported;
});

// instances (MCL & Prism Launcher)
ipcMain.handle('list-instances', () => {
  const instances = instancesManager.listInstances();
  return withNativePlaytime(instances, readNativePlaytime(userDataDir).totals);
});
ipcMain.handle('default-instance-icons', () => minecraftBlockTextures());

// the loader is installed before the build folder appears, so a failed install leaves nothing behind
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

// mod problems of a build (mod-check.js), for the launch check and the build's page
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

/** runs the real analyzer and opens the crash window as after a real crash. */
function showDevCrash(instanceId, input) {
  const inst = instanceId ? instancesManager.listInstances().find(i => i.id === instanceId) : null;
  const opt = resolveLaunchSettings(settingsManager.get(), inst);
  const analysis = analyzeCrash({
    jars: inst.loader !== 'vanilla' ? scanModsDir(inst.modsDir) : [],
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

// modrinth modpacks (.mrpack)
ipcMain.handle('mrpack-inspect', (event, file) => mrpackManager.inspect(file));

ipcMain.handle('instance-zip-inspect', (event, file) => inspectInstanceZip(file));
ipcMain.handle('instance-zip-import', (event, file, name) => importInstanceZip(file, instancesManager, {
  name: String(name || ''),
  onProgress: (p) => sendToWindow('mrpack-progress', p)
}));

ipcMain.handle('mrpack-import', async (event, file, name) => {
  return await mrpackManager.importPack(file, {
    name: String(name || ''),
    onProgress: (p) => sendToWindow('mrpack-progress', p),
    getJava: (version) => javaForVersion(version)
  });
});

ipcMain.handle('modrinth-project-preview', (event, projectId) => modrinthManager.getProjectPreview(projectId));

ipcMain.handle('modrinth-pack-versions', async (event, projectId) => {
  const versions = await modrinthManager.getModpackVersions(projectId);
  return versions.map(({ id, name, version_number, version_type, game_versions, loaders }) => ({
    id, name, version_number, version_type, game_versions, loaders
  }));
});

ipcMain.handle('modrinth-pack-install', (event, projectId, versionId) => mrpackManager.installModrinthPack(projectId, versionId, {
  onProgress: (p) => event.sender.isDestroyed() || event.sender.send('modrinth-pack-progress', p),
  getJava: (version) => javaForVersion(version)
}));

function findInstanceOrThrow(instanceId) {
  const inst = instancesManager.listInstances().find(i => i.id === instanceId);
  if (!inst) throw new Error(t('Сборка не найдена'));
  return inst;
}

ipcMain.handle('mrpack-export-entries', (event, instanceId) => {
  return mrpackManager.listExportEntries(findInstanceOrThrow(instanceId));
});

// the file is picked here, not by the page, so the page cannot write anywhere it likes
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

// transfer of game settings (options.txt) between profiles
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

// without sourceId picks the profile whose settings were changed most recently
// builds with "don't sync" are left out of the automatic transfer both ways; a manual one (sourceId) still works.
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

// modrinth
ipcMain.handle('search-modrinth', async (event, options) => {
  return await modrinthManager.searchMods(options);
});

// mods, resource packs and shaders are installed only into a build
// version and loader always come from the build itself, never from the page
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

// versions & Java
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

// java versions the launcher's builds need, and whether each is available
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

// file dialogs
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

// daily totals for the home page playtime cards
ipcMain.handle('get-playtime-days', () => {
  const days = playtimeLog.read();
  for (const [day, seconds] of Object.entries(readNativePlaytime(userDataDir).days)) days[day] = (Number(days[day]) || 0) + seconds;
  return days;
});

// screenshots page
function currentScreenshotSources() {
  const root = settingsManager.get().gameDir || DEFAULT_MINECRAFT_DIR;
  return screenshots.screenshotSources(root, instancesManager.listInstances());
}

function checkedScreenshot(file) {
  if (!screenshots.isScreenshotPath(file, currentScreenshotSources())) throw new Error(t('Это не скриншот'));
  return path.resolve(file);
}

// folders are (re)watched on every listing, so new builds and changed .minecraft are picked up
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
 * saves an edited screenshot next to the original: mode 'copy' as <name>-edited.png (-2, -3… when taken),
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

// game Launching
function sendToWindow(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

// true for the whole launch, including loader/Java preparation before launcherCore starts
let launchInProgress = false;
let preparingShortcut = false;
const pendingShortcuts = new Map();
let runningInstanceId = null; // build the running game was started from
let killedByUser = false; // "Stop" in the launcher is not a crash

ipcMain.handle('create-instance-shortcut', async (event, id, iconDataUrl) => {
  const instance = instancesManager.listInstances().find(i => i.id === id);
  if (!instance) throw new Error(t('Сборка не найдена'));
  if (process.platform !== 'win32') throw new Error(t('Ярлыки сборок пока доступны только в Windows'));
  if (!['microsoft', 'offline'].includes(accountsManager.getActiveAccount()?.type)) {
    throw new Error(t('Для ярлыка выберите аккаунт Microsoft или офлайн-аккаунт.'));
  }
  const pending = pendingShortcuts.get(id);
  if (pending) return pending;
  const creation = createNativeV2Shortcut(id, instance, iconDataUrl);
  pendingShortcuts.set(id, creation);
  try {
    return await creation;
  } finally {
    pendingShortcuts.delete(id);
  }
});

async function createNativeV2Shortcut(id, instance, iconDataUrl) {
  const v2 = require('./native-v2');
  const runner = v2.runnerPath(app);
  if (!fs.existsSync(runner)) throw new Error('Build Native V2 with npm run native:v2 before creating a shortcut');
  const prepared = await launchGame({ instanceId: id }, { prepareOnly: true });
  if (!prepared.success) {
    const issues = prepared.modIssues?.filter(issue => issue.level === 'error').map(issue => issue.text);
    throw new Error(prepared.error || issues?.join('\n') || 'Minecraft preparation failed');
  }
  const profile = userDataDir;
  const payload = v2.makeProvision({
    command: prepared.command, account: prepared.account, instance,
    root: settingsManager.get().gameDir, profile,
    settingsPath: settingsManager.filePath, accountsPath: accountsManager.filePath,
    customVersion: prepared.customVersion, appVersion: app.getVersion(),
    rpcEnabled: settingsManager.get().discordPresence !== false
  });
  await v2.provision({ runner, profile, payload });
  return require('./native-v2-shortcuts').createShortcutV2({ app, shell, nativeImage, instance, iconDataUrl, runner, profile });
}

ipcMain.handle('launch-game', (event, launchOpts = {}) => launchGame(launchOpts));

async function launchGame(launchOpts = {}, { prepareOnly = false } = {}) {
  if (preparingShortcut) return { success: false, error: t('Дождитесь создания ярлыка сборки.') };
  if (launchInProgress || launcherCore.isLaunching) return { success: false, error: t('Minecraft готовится к запуску. Подождите.') };
  if (launcherCore.isRunning) return { success: false, error: t('Игра уже запущена!') };
  const id = launchOpts?.instanceId;
  const inst = id && instancesManager.listInstances().find(i => i.id === id);
  if (!inst) return { success: false, error: t('Сборка не найдена') };

  const settings = settingsManager.get();
  const root = settings.gameDir || DEFAULT_MINECRAFT_DIR;
  const log = (type, message) => emitLog({ type, message });

  if (prepareOnly) preparingShortcut = true;
  else launchInProgress = true;
  let releaseLock = null;
  let transferred = false;
  const profile = !prepareOnly && settings.launchProfiling === true
    ? launchProfiler.begin(inst.id)
    : null;
  let profileSaved = false;
  const phase = async (name, work) => {
    if (!profile) return work();
    profile.start(name);
    try { return await work(); } finally { profile.end(name); }
  };
  const saveProfile = (status, error = null) => {
    if (!profile || profileSaved) return;
    profileSaved = true;
    const result = launchProfiler.save(profile.finish(status, error));
    log(status === 'failed' ? 'warn' : 'info', `[PERF]: ${formatLaunchProfile(result)}`);
  };
  try {
    // versions, libraries and assets are shared in root; saves/mods are per instance.
    const instanceId = inst.id;
    const gameDir = inst.minecraftDir;
    const versionNumber = inst.version;
    let customVersion = null;
    releaseLock = acquireLaunchLock(gameDir);
    const account = await phase('account', () => accountsManager.getLaunchAccount((text) => log('warn', `[AUTH]: ${text}`)));

    // mods that will not start together: asked before anything is downloaded or started
    if (inst.loader !== 'vanilla') {
      profile?.start('mod-check');
      const check = checkBuild(inst);
      profile?.end('mod-check');
      check.issues.filter(i => i.level === 'warn').forEach(i => log('warn', `[MODS]: ${i.text}`));
      const errors = check.issues.filter(i => i.level === 'error');
      if (errors.length && !launchOpts.ignoreModIssues) {
        errors.forEach(i => log('warn', `[MODS]: ${i.text}`));
        saveProfile('blocked', errors.map(issue => issue.text).join('; '));
        return { success: false, modIssues: check.issues, instanceId: inst.id };
      }
    }

    if (inst.loader !== 'vanilla') {
      // installed when the build was made; builds from Prism or a cleaned versions/ get it now
      log('info', `[LAUNCHER]: ${t('Подготовка {loader} {version} для {mc}', { loader: LoaderManager.label(inst.loader), version: inst.loaderVersion || '', mc: inst.version })}`);
      const loaderProfile = await phase('loader', () => loaderManager.ensure(inst.loader, inst.version, inst.loaderVersion, {
        knownId: inst.versionId,
        onStatus: (text, { progress } = {}) => { if (!progress) log('info', `[LAUNCHER]: ${text}`); },
        getJava: () => javaForVersion(inst.version, log)
      }));
      customVersion = loaderProfile.id;
    }

    // the build's own launch settings over the launcher ones (see instances-manager.js LAUNCH_KEYS)
    const own = inst.launch || {};
    if (Object.keys(own).length) log('info', `[LAUNCHER]: ${t('У сборки свои настройки запуска')}`);
    const opt = resolveLaunchSettings(settings, inst);

    // java: explicit choice from the build or settings, otherwise the one matching the version
    const javaPath = opt.javaPath || await phase('java-discovery', () => javaForVersion(customVersion || versionNumber, log));
    const javaMajor = await phase('java-version', () => javaMajorOf(javaPath));
    const shenandoahSupported = opt.jvmPreset === 'shenandoah'
      ? await phase('gc-check', () => checkJavaGc(javaPath, '-XX:+UseShenandoahGC'))
      : null;

    log('info', `[LAUNCHER]: ${t('Версия {version}, папка игры: {dir}', { version: customVersion || versionNumber, dir: gameDir })}`);

    // the game's own output of this session, for the crash analysis
    const sessionStart = Date.now();
    const output = [];
    killedByUser = false;

    profile?.start('launcher-core');
    const command = await launcherCore.launch(
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
        shenandoahSupported,
        profileJvmArgs: customVersion ? loaderManager.jvmArgs(customVersion) : [],
        resolutionWidth: opt.resolutionWidth || 1280,
        resolutionHeight: opt.resolutionHeight || 720,
        fullscreen: opt.fullscreen || false,
        elyByManager,
        prepareOnly
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
          profile?.end('launcher-core');
          saveProfile('launched');
          transferred = true;
          instancesManager.markLaunched(instanceId);
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
          if (prepareOnly) return;
          if (releaseLock) releaseLock();
          runningInstanceId = null;
          discord.clear();
          // a crash: an error exit code, or a crash report written during the session
          if (!killedByUser) {
            try {
              const analysis = analyzeCrash({
                gameDir, since: sessionStart, output, exitCode: code,
                jars: inst.loader !== 'vanilla' ? scanModsDir(inst.modsDir) : [],
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

    if (prepareOnly) return { success: true, command, account, customVersion };
    return { success: true };
  } catch (err) {
    saveProfile('failed', err.message);
    if (!prepareOnly) sendToWindow('launch-error', err.message);
    return { success: false, error: err.message };
  } finally {
    if (!transferred && releaseLock) releaseLock();
    if (prepareOnly) preparingShortcut = false;
    else launchInProgress = false;
  }
}

// lets a reloaded window (Ctrl+R) pick up a game that is still starting or running
ipcMain.handle('get-game-state', () => ({
  running: !!launcherCore.isRunning,
  instanceId: launcherCore.isRunning ? runningInstanceId : null,
  launching: launchInProgress || !!launcherCore.isLaunching
}));

// launcher update: the button left of the window controls and the update menu
ipcMain.handle('update-get-state', () => updater.state);
ipcMain.handle('update-check', () => checkForUpdate());
ipcMain.handle('update-releases', () => updater.releases());
ipcMain.handle('release-notes', (_event, tag) => updater.releaseNotes(tag));
ipcMain.handle('update-download', () => updater.download());
ipcMain.handle('update-restart', () => {
  if (preparingShortcut || pendingShortcuts.size || launchInProgress || launcherCore.isRunning || launcherCore.isLaunching) {
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
