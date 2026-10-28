/**
 * options-sync.js
 * Transfers Minecraft options.txt settings (keybinds, mouse, video, sound, ...) between profiles.
 */
const fs = require('fs');
const path = require('path');
const { t } = require('./i18n/i18n');

const VIDEO_KEYS = new Set([
  'ao', 'biomeBlendRadius', 'chunkSectionFadeInTime', 'cutoutLeaves', 'enableVsync', 'entityDistanceScaling',
  'entityShadows', 'fov', 'fovEffectScale', 'darknessEffectScale', 'glintSpeed', 'glintStrength', 'graphicsMode',
  'graphicsPreset', 'fancyGraphics', 'prioritizeChunkUpdates', 'fullscreen', 'fullscreenResolution', 'gamma',
  'guiScale', 'maxAnisotropyBit', 'textureFiltering', 'maxFps', 'improvedTransparency', 'inactivityFpsLimit',
  'mipmapLevels', 'particles', 'renderClouds', 'cloudRange', 'renderDistance', 'simulationDistance',
  'screenEffectScale', 'vignette', 'weatherRadius', 'bobView', 'menuBackgroundBlurriness', 'attackIndicator'
]);

const CONTROL_KEYS = new Set([
  'autoJump', 'toggleCrouch', 'toggleSprint', 'toggleAttack', 'toggleUse', 'sprintWindow', 'rotateWithMinecart', 'mainHand'
]);

const MOUSE_KEYS = new Set([
  'mouseSensitivity', 'mouseWheelSensitivity', 'invertYMouse', 'invertXMouse', 'rawMouseInput',
  'discrete_mouse_scroll', 'touchscreen', 'allowCursorChanges'
]);

const SOUND_KEYS = new Set(['soundDevice', 'showSubtitles', 'directionalAudio', 'musicToast', 'musicFrequency']);

const OTHER_KEYS = new Set([
  'lang', 'forceUnicodeFont', 'japaneseGlyphVariants', 'narrator', 'narratorHotkey', 'reducedDebugInfo',
  'autoSuggestions', 'textBackgroundOpacity', 'backgroundForChatOnly', 'advancedItemTooltips', 'pauseOnLostFocus',
  'highContrast', 'highContrastBlockOutline', 'hideLightningFlashes', 'hideSplashTexts', 'damageTiltStrength',
  'notificationDisplayTime', 'showAutosaveIndicator', 'darkMojangStudiosBackground', 'panoramaScrollSpeed',
  'hideServerAddress', 'hideMatchedNames', 'onlyShowSecureChat', 'saveChatDrafts'
]);

const CATEGORIES = [
  { id: 'keybinds', label: 'Управление и бинды', match: k => k.startsWith('key_') || CONTROL_KEYS.has(k) }, // i18n-key
  { id: 'mouse', label: 'Мышь', match: k => MOUSE_KEYS.has(k) }, // i18n-key
  { id: 'video', label: 'Графика', match: k => VIDEO_KEYS.has(k) }, // i18n-key
  { id: 'sound', label: 'Звук', match: k => k.startsWith('soundCategory_') || SOUND_KEYS.has(k) }, // i18n-key
  { id: 'other', label: 'Язык, чат и прочее', match: k => k.startsWith('chat') || k.startsWith('modelPart_') || OTHER_KEYS.has(k) } // i18n-key
];

const DEFAULT_SYNC_MODES = Object.fromEntries(CATEGORIES.map(c => [c.id, 'ask']));

function optionsPath(dir) {
  return path.join(dir, 'options.txt');
}

/** Parses options.txt into an ordered Map. Values may contain ':' (JSON lists). */
function readOptions(dir) {
  const map = new Map();
  const file = optionsPath(dir);
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf-8');
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx > 0) map.set(line.slice(0, idx), line.slice(idx + 1));
  }
  return map;
}

function categoryOf(key) {
  const cat = CATEGORIES.find(c => c.match(key));
  return cat ? cat.id : null;
}

/** Counts per category how many values in source differ from target. */
function diffOptions(source, target) {
  const counts = Object.fromEntries(CATEGORIES.map(c => [c.id, 0]));
  if (!source) return counts;
  for (const [key, value] of source) {
    const cat = categoryOf(key);
    if (cat && (!target || target.get(key) !== value)) counts[cat]++;
  }
  return counts;
}

function getMtime(dir) {
  try {
    return fs.statSync(optionsPath(dir)).mtimeMs;
  } catch (e) {
    return 0;
  }
}

/**
 * Finds the profile whose options.txt was changed most recently, if it is newer than the target's.
 * profiles: [{ id, name, dir }]
 */
function findNewestSource(targetDir, profiles) {
  const targetTime = getMtime(targetDir);
  let best = null;
  for (const p of profiles) {
    if (path.resolve(p.dir) === path.resolve(targetDir)) continue;
    const t = getMtime(p.dir);
    if (t > targetTime && (!best || t > best.time)) best = { ...p, time: t };
  }
  return best;
}

/** Copies settings of the chosen categories from sourceDir to targetDir. */
function applyOptions(sourceDir, targetDir, categoryIds) {
  const source = readOptions(sourceDir);
  if (!source) throw new Error(t('В исходной сборке ещё нет options.txt — запустите её хотя бы раз.'));
  const wanted = new Set(categoryIds);
  const target = readOptions(targetDir);
  const result = target ? new Map(target) : new Map();

  // A fresh options.txt needs the data version, otherwise the game tries to upgrade it from an ancient format
  if (!target && source.has('version')) result.set('version', source.get('version'));

  let changed = 0;
  for (const [key, value] of source) {
    const cat = categoryOf(key);
    if (cat && wanted.has(cat) && result.get(key) !== value) {
      result.set(key, value);
      changed++;
    }
  }
  if (!changed) return 0;

  fs.mkdirSync(targetDir, { recursive: true });
  const file = optionsPath(targetDir);
  if (target) fs.copyFileSync(file, `${file}.mcl-backup`);
  const text = [...result].map(([k, v]) => `${k}:${v}`).join('\n') + '\n';
  fs.writeFileSync(file, text, 'utf-8');
  return changed;
}

module.exports = {
  CATEGORIES,
  DEFAULT_SYNC_MODES,
  readOptions,
  diffOptions,
  findNewestSource,
  getMtime,
  applyOptions
};
