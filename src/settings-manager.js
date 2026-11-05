/**
 * settings-manager.js
 * Reads and persists user settings in launcher-config.json.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { DEFAULT_SYNC_MODES } = require('./options-sync');
const { LEGACY_DEFAULT_ARGS } = require('./jvm-flags');

const DEFAULT_MINECRAFT_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), '.minecraft');

function getSettingsPath(appDataDir) {
  const dir = appDataDir || path.join(os.homedir(), '.mcl-launcher');
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {}
  }
  return path.join(dir, 'settings.json');
}

function getDefaultSettings() {
  const totalMemGb = Math.max(4, Math.floor(os.totalmem() / (1024 * 1024 * 1024)));
  // Recommended allocation: half of total RAM or up to 6 GB
  const defaultRam = Math.min(6, Math.max(2, Math.floor(totalMemGb / 2)));

  return {
    username: 'Steve',
    selectedVersion: '1.21.1',
    gameDir: DEFAULT_MINECRAFT_DIR,
    javaPath: '',
    minRam: 2,
    maxRam: defaultRam,
    totalSystemRam: totalMemGb,
    resolutionWidth: 1280,
    resolutionHeight: 720,
    fullscreen: false,
    jvmPreset: 'auto', // GC and tuning flags, see jvm-flags.js
    customJvmArgs: '',
    discordPresence: true, // "Играет в AeterMC" in Discord while the game runs
    actionAfterLaunch: 'minimize', // 'minimize' | 'hide' | 'keep'
    showSnapshots: false,
    showConsole: true,
    theme: 'dark-mono', // id of a file in design/themes
    autoCheckModUpdates: true,
    autoUpdate: true, // launcher updates: download in the background, put in place on exit
    language: null, // 'ru' | 'en'; null: the system language (see i18n.detectLanguage)
    buildsView: 'grid', // 'grid' | 'list'
    sidebarCollapsed: false,
    animations: true,
    gamepad: true, // launcher control with a gamepad (renderer/gamepad.js)
    setupDone: false,
    prismImport: null, // Prism sync: null = not asked yet, true = show Prism builds in place, false = off
    // per category: 'always' | 'ask' | 'never'
    optionsSync: { ...DEFAULT_SYNC_MODES }
  };
}

class SettingsManager {
  constructor(appDataDir) {
    this.filePath = getSettingsPath(appDataDir);
    this.settings = this.load();
  }

  load() {
    const defaults = getDefaultSettings();
    if (fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        const merged = Object.assign({}, defaults, parsed);
        // settings from before the first-run setup existed: that launcher is already set up
        if (!('setupDone' in parsed)) merged.setupDone = true;
        merged.optionsSync = Object.assign({}, defaults.optionsSync, parsed.optionsSync);
        // the old default arguments are what the G1 preset now does
        if (String(merged.customJvmArgs || '').trim() === LEGACY_DEFAULT_ARGS) merged.customJvmArgs = '';
        return merged;
      } catch (e) {
        console.error('[Settings] Error reading settings file, resetting defaults:', e.message);
      }
    }
    this.save(defaults);
    return defaults;
  }

  save(newSettings) {
    this.settings = Object.assign({}, this.settings, newSettings);
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.settings, null, 2), 'utf-8');
      return true;
    } catch (e) {
      console.error('[Settings] Error saving settings:', e.message);
      return false;
    }
  }

  get() {
    return this.settings;
  }
}

module.exports = {
  SettingsManager,
  DEFAULT_MINECRAFT_DIR,
  getDefaultSettings
};
