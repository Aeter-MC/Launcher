/**
 * preload.js
 * Exposes a secure API bridge between Electron and the Renderer.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  // Accounts
  getAccounts: () => ipcRenderer.invoke('get-accounts'),
  setActiveAccount: (id) => ipcRenderer.invoke('set-active-account', id),
  addOfflineAccount: (username) => ipcRenderer.invoke('add-offline-account', username),
  msLoginStart: () => ipcRenderer.invoke('ms-login-start'),
  msLoginWait: () => ipcRenderer.invoke('ms-login-wait'),
  msLoginCancel: () => ipcRenderer.invoke('ms-login-cancel'),
  msLoginOpenBrowser: (url) => ipcRenderer.invoke('ms-login-open-browser', url),
  loginElyBy: (username, password) => ipcRenderer.invoke('login-elyby', username, password),
  removeAccount: (id) => ipcRenderer.invoke('remove-account', id),

  // Instances
  listInstances: () => ipcRenderer.invoke('list-instances'),
  countPrismInstances: () => ipcRenderer.invoke('prism-instances-count'),
  listPrismInstances: () => ipcRenderer.invoke('prism-list'),
  importPrismInstances: (keys) => ipcRenderer.invoke('prism-import', keys),
  onPrismImportProgress: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('prism-import-progress', handler);
    return () => ipcRenderer.removeListener('prism-import-progress', handler);
  },
  createInstance: (options) => ipcRenderer.invoke('create-instance', options),
  copyInstance: (id, newName) => ipcRenderer.invoke('copy-instance', id, newName),
  deleteInstance: (id) => ipcRenderer.invoke('delete-instance', id),
  setInstanceIcon: (id, choice) => ipcRenderer.invoke('set-instance-icon', id, choice),
  listInstanceMods: (id) => ipcRenderer.invoke('list-instance-mods', id),
  toggleInstanceMod: (id, fileName, enable) => ipcRenderer.invoke('toggle-instance-mod', id, fileName, enable),
  addInstanceMod: (id, filePath) => ipcRenderer.invoke('add-instance-mod', id, filePath),
  deleteInstanceMod: (id, fileName) => ipcRenderer.invoke('delete-instance-mod', id, fileName),
  openInstanceFolder: (id) => ipcRenderer.invoke('open-instance-folder', id),

  // Game settings transfer
  getSyncCategories: () => ipcRenderer.invoke('options-sync-categories'),
  checkOptionsSync: (targetId, sourceId) => ipcRenderer.invoke('options-sync-check', targetId, sourceId),
  applyOptionsSync: (targetId, sourceId, categoryIds) => ipcRenderer.invoke('options-sync-apply', targetId, sourceId, categoryIds),

  // Modrinth
  searchModrinth: (options) => ipcRenderer.invoke('search-modrinth', options),
  installModrinthMod: (projectId, instanceId) => ipcRenderer.invoke('install-modrinth-mod', projectId, instanceId),
  scanInstanceMods: (instanceId, force) => ipcRenderer.invoke('scan-instance-mods', instanceId, force),
  updateInstanceMod: (instanceId, fileName) => ipcRenderer.invoke('update-instance-mod', instanceId, fileName),

  // Versions & Java
  getVersions: (showSnapshots) => ipcRenderer.invoke('get-versions', showSnapshots),
  installFabric: (gameVersion, loaderVersion) => ipcRenderer.invoke('install-fabric', gameVersion, loaderVersion),
  detectJava: (force) => ipcRenderer.invoke('detect-java', force),
  installJava: (major) => ipcRenderer.invoke('install-java', major),
  getJavaRequirements: () => ipcRenderer.invoke('java-requirements'),
  onJavaInstallProgress: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('java-install-progress', handler);
    return () => ipcRenderer.removeListener('java-install-progress', handler);
  },

  // Game Control
  launchGame: (options) => ipcRenderer.invoke('launch-game', options),
  killGame: () => ipcRenderer.invoke('kill-game'),
  getGameState: () => ipcRenderer.invoke('get-game-state'),

  // File and Folder Dialogs
  browseFile: (options) => ipcRenderer.invoke('browse-file', options),
  browseFolder: (options) => ipcRenderer.invoke('browse-folder', options),
  openFolder: (type) => ipcRenderer.invoke('open-folder', type),

  // Home stats and screenshots
  getPlaytimeDays: () => ipcRenderer.invoke('get-playtime-days'),
  listScreenshots: () => ipcRenderer.invoke('list-screenshots'),
  revealScreenshot: (file) => ipcRenderer.invoke('screenshot-reveal', file),
  copyScreenshot: (file) => ipcRenderer.invoke('screenshot-copy', file),
  deleteScreenshot: (file) => ipcRenderer.invoke('screenshot-delete', file),
  onScreenshotsChanged: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('screenshots-changed', handler);
    return () => ipcRenderer.removeListener('screenshots-changed', handler);
  },

  // Window Controls
  setWindowIcon: (dataUrl) => ipcRenderer.send('window-icon', dataUrl),
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  maximizeWindow: () => ipcRenderer.send('window-maximize'),
  closeWindow: () => ipcRenderer.send('window-close'),
  isMaximized: () => ipcRenderer.invoke('window-is-maximized'),

  // Console
  writeLog: (type, message) => ipcRenderer.send('write-log', { type, message }),
  getLogBuffer: () => ipcRenderer.invoke('get-log-buffer'),
  clearLogs: () => ipcRenderer.invoke('clear-logs'),
  openConsoleWindow: () => ipcRenderer.invoke('open-console-window'),
  setConsoleOnTop: (onTop) => ipcRenderer.invoke('console-set-on-top', onTop),
  onLogsCleared: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('logs-cleared', handler);
    return () => ipcRenderer.removeListener('logs-cleared', handler);
  },
  onConsoleWindow: (callback) => {
    const handler = (event, open) => callback(open);
    ipcRenderer.on('console-window', handler);
    return () => ipcRenderer.removeListener('console-window', handler);
  },

  onThemeChanged: (callback) => {
    const handler = (event, id) => callback(id);
    ipcRenderer.on('theme-changed', handler);
    return () => ipcRenderer.removeListener('theme-changed', handler);
  },

  // Event Subscriptions
  onWindowMaximized: (callback) => {
    const handler = (event, isMax) => callback(isMax);
    ipcRenderer.on('window-maximized', handler);
    return () => ipcRenderer.removeListener('window-maximized', handler);
  },
  onLaunchProgress: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('launch-progress', handler);
    return () => ipcRenderer.removeListener('launch-progress', handler);
  },
  onLaunchLog: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('launch-log', handler);
    return () => ipcRenderer.removeListener('launch-log', handler);
  },
  onGameLaunched: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('game-launched', handler);
    return () => ipcRenderer.removeListener('game-launched', handler);
  },
  onGameClosed: (callback) => {
    const handler = (event, code) => callback(code);
    ipcRenderer.on('game-closed', handler);
    return () => ipcRenderer.removeListener('game-closed', handler);
  },
  onLaunchError: (callback) => {
    const handler = (event, err) => callback(err);
    ipcRenderer.on('launch-error', handler);
    return () => ipcRenderer.removeListener('launch-error', handler);
  }
});
