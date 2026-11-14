/**
 * data-dir.js
 * Where AeterMC keeps its data (accounts, settings, builds).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const legacyDataDir = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'AeterMC');

const XDG_DATA_HOME = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
const linuxDataDir = path.join(XDG_DATA_HOME, 'AeterMC');
// Keep an existing Linux test installation in place, including its instances.
const useLegacy = fs.existsSync(path.join(legacyDataDir, 'settings.json'))
  && !fs.existsSync(path.join(linuxDataDir, 'settings.json'));
const DATA_DIR = process.platform === 'linux' && !useLegacy ? linuxDataDir : legacyDataDir;

module.exports = { DATA_DIR, XDG_DATA_HOME };
