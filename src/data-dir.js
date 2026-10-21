/**
 * data-dir.js
 * Where AeterMC keeps its data (accounts, settings, builds): %APPDATA%\AeterMC.
 */
const path = require('path');
const os = require('os');

const DATA_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'AeterMC');

module.exports = { DATA_DIR };
