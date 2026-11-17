/**
 * data-dir.js
 * where AeterMC keeps its data (accounts, settings, builds).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const legacyDataDir = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'AeterMC');

const XDG_DATA_HOME = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
const linuxDataDir = path.join(XDG_DATA_HOME, 'AeterMC');
// keep an existing Linux test installation in place, including its instances.
const useLegacy = fs.existsSync(path.join(legacyDataDir, 'settings.json'))
  && !fs.existsSync(path.join(linuxDataDir, 'settings.json'));
const SYSTEM_DATA_DIR = process.platform === 'linux' && !useLegacy ? linuxDataDir : legacyDataDir;

function portableDataDir(env = process.env) {
  if (!env.PORTABLE_EXECUTABLE_FILE) return null;
  const executableDir = env.PORTABLE_EXECUTABLE_DIR || path.dirname(env.PORTABLE_EXECUTABLE_FILE);
  return path.join(path.resolve(executableDir), 'AeterMC-data');
}

const DATA_DIR = portableDataDir() || SYSTEM_DATA_DIR;

module.exports = { DATA_DIR, SYSTEM_DATA_DIR, XDG_DATA_HOME, portableDataDir };
