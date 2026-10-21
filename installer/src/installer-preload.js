/**
 * installer-preload.js
 * API of the installer window (see installer-main.js).
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('setup', {
  info: () => ipcRenderer.invoke('info'),
  browse: (current) => ipcRenderer.invoke('browse', current),
  running: (dir) => ipcRenderer.invoke('running', dir),
  killRunning: (dir) => ipcRenderer.invoke('kill-running', dir),
  install: (opts) => ipcRenderer.invoke('install', opts),
  uninstall: (opts) => ipcRenderer.invoke('uninstall', opts),
  launch: (exe) => ipcRenderer.invoke('launch', exe),
  minimize: () => ipcRenderer.send('minimize'),
  close: () => ipcRenderer.send('close'),
  onProgress: (callback) => ipcRenderer.on('progress', (event, data) => callback(data))
});
