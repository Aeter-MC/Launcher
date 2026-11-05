/**
 * options-labels.js
 * options.txt keys and values in plain words for the transfer dialog:
 * "renderDistance: 12 -> 16" becomes "Дальность прорисовки: 12 → 16",
 * "key_key.jump: key.keyboard.space" becomes "Клавиша «Прыжок»: Space".
 * Keys without a name here (mods add their own) are shown as they are.
 */
const { t, plural } = require('./i18n/i18n');
const pluralize = plural;
const chunks = (v) => {
  const n = parseInt(v, 10);
  return pluralize(n, ['чанк', 'чанка', 'чанков']);
};

const on = (v) => (v === 'true' ? t('вкл') : v === 'false' ? t('выкл') : v);
const percent = (v) => `${Math.round(parseFloat(v) * 100)}%`;
const unquote = (v) => String(v).replace(/^"(.*)"$/, '$1');

// key -> [label, value formatter]
const OPTIONS = {
  renderDistance: [() => t('Дальность прорисовки'), chunks],
  simulationDistance: [() => t('Дальность симуляции'), chunks],
  entityDistanceScaling: [() => t('Дальность прорисовки сущностей'), percent],
  fov: [() => t('Поле зрения'), v => String(Math.round(70 + parseFloat(v) * 40))],
  gamma: [() => t('Яркость'), percent],
  guiScale: [() => t('Масштаб интерфейса'), v => (v === '0' ? t('авто') : v)],
  maxFps: [() => t('Макс. FPS'), v => (parseInt(v, 10) >= 260 ? t('без ограничений') : v)],
  enableVsync: [() => t('Вертикальная синхронизация'), on],
  fullscreen: [() => t('Полный экран'), on],
  graphicsMode: [() => t('Графика'), v => ({ 0: t('быстрая'), 1: t('детальная'), 2: t('превосходная') }[v] || unquote(v))],
  graphicsPreset: [() => t('Набор графики'), unquote],
  fancyGraphics: [() => t('Детальная графика'), on],
  particles: [() => t('Частицы'), v => ({ 0: t('все'), 1: t('меньше'), 2: t('минимум') }[v] || v)],
  renderClouds: [() => t('Облака'), v => ({ fast: t('быстрые'), fancy: t('детальные'), false: t('выкл'), true: t('вкл') }[unquote(v)] || unquote(v))],
  entityShadows: [() => t('Тени сущностей'), on],
  ao: [() => t('Мягкое освещение'), on],
  biomeBlendRadius: [() => t('Смешивание биомов'), v => `${v * 2 + 1}×${v * 2 + 1}`],
  mipmapLevels: [() => t('Уровни MIP-текстур'), v => v],
  bobView: [() => t('Покачивание камеры'), on],
  screenEffectScale: [() => t('Эффекты искажения'), percent],
  fovEffectScale: [() => t('Эффекты поля зрения'), percent],
  darknessEffectScale: [() => t('Эффект темноты'), percent],
  vignette: [() => t('Виньетка'), on],
  attackIndicator: [() => t('Индикатор атаки'), v => ({ 0: t('выкл'), 1: t('прицел'), 2: t('панель') }[v] || v)],
  mouseSensitivity: [() => t('Чувствительность мыши'), v => `${Math.round(parseFloat(v) * 200)}%`],
  mouseWheelSensitivity: [() => t('Чувствительность колеса'), v => v],
  invertYMouse: [() => t('Инверсия мыши по вертикали'), on],
  invertXMouse: [() => t('Инверсия мыши по горизонтали'), on],
  rawMouseInput: [() => t('Прямой ввод мыши'), on],
  discrete_mouse_scroll: [() => t('Пошаговая прокрутка'), on],
  autoJump: [() => t('Автопрыжок'), on],
  toggleCrouch: [() => t('Приседание'), v => (v === 'true' ? t('переключать') : t('удерживать'))],
  toggleSprint: [() => t('Бег'), v => (v === 'true' ? t('переключать') : t('удерживать'))],
  mainHand: [() => t('Ведущая рука'), v => ({ left: t('левая'), right: t('правая') }[unquote(v)] || unquote(v))],
  lang: [() => t('Язык игры'), unquote],
  showSubtitles: [() => t('Субтитры'), on],
  directionalAudio: [() => t('Направленный звук'), on],
  soundDevice: [() => t('Устройство вывода'), v => unquote(v) || t('по умолчанию')],
  chatOpacity: [() => t('Прозрачность чата'), percent],
  chatScale: [() => t('Размер чата'), percent],
  narrator: [() => t('Экранный диктор'), v => (v === '0' ? t('выкл') : t('вкл'))],
  pauseOnLostFocus: [() => t('Пауза при сворачивании'), on],
  advancedItemTooltips: [() => t('Подробные подсказки предметов'), on],
  prioritizeChunkUpdates: [() => t('Обновление чанков'), v => ({ 0: t('в фоне'), 1: t('рядом с игроком'), 2: t('ближайшие сразу') }[v] || v)],
  maxAnisotropyBit: [() => t('Анизотропная фильтрация'), v => (v === '0' ? t('выкл') : `${2 ** parseInt(v, 10)}x`)],
  textureFiltering: [() => t('Фильтрация текстур'), v => ({ 0: t('нет'), 1: t('сглаживание'), 2: t('анизотропная') }[v] || v)],
  improvedTransparency: [() => t('Улучшенная прозрачность'), on],
  cutoutLeaves: [() => t('Прозрачная листва'), on],
  chunkSectionFadeInTime: [() => t('Плавное появление чанков'), v => t('{n} с', { n: v })],
  cloudRange: [() => t('Дальность облаков'), chunks],
  weatherRadius: [() => t('Радиус погоды'), v => v],
  inactivityFpsLimit: [() => t('FPS в фоне'), v => ({ afk: t('снижать при бездействии'), minimized: t('снижать в свёрнутом окне') }[unquote(v)] || unquote(v))],
  menuBackgroundBlurriness: [() => t('Размытие фона меню'), v => v],
  darkMojangStudiosBackground: [() => t('Тёмный экран загрузки'), on],
  glintSpeed: [() => t('Скорость блеска зачарований'), percent],
  glintStrength: [() => t('Яркость блеска зачарований'), percent],
  hideLightningFlashes: [() => t('Скрыть вспышки молний'), on],
  hideSplashTexts: [() => t('Скрыть надписи в меню'), on],
  textBackgroundOpacity: [() => t('Фон текста'), percent],
  autoSuggestions: [() => t('Подсказки команд'), on],
  reducedDebugInfo: [() => t('Сокращённый экран отладки'), on],
  forceUnicodeFont: [() => t('Шрифт Unicode'), on]
};

const SOUNDS = {
  master: () => t('общая'), music: () => t('музыка'), record: () => t('музыкальные блоки'), weather: () => t('погода'),
  block: () => t('блоки'), hostile: () => t('враждебные существа'), neutral: () => t('дружелюбные существа'),
  player: () => t('игроки'), ambient: () => t('окружение'), voice: () => t('голос'), ui: () => t('интерфейс')
};

const ACTIONS = {
  'key.forward': () => t('Вперёд'), 'key.back': () => t('Назад'), 'key.left': () => t('Влево'), 'key.right': () => t('Вправо'),
  'key.jump': () => t('Прыжок'), 'key.sneak': () => t('Красться'), 'key.sprint': () => t('Бег'),
  'key.inventory': () => t('Инвентарь'), 'key.drop': () => t('Выбросить предмет'), 'key.swapOffhand': () => t('Сменить руку'),
  'key.attack': () => t('Атаковать / разрушить'), 'key.use': () => t('Использовать / поставить'), 'key.pickItem': () => t('Выбрать блок'),
  'key.chat': () => t('Чат'), 'key.command': () => t('Команда'), 'key.playerlist': () => t('Список игроков'),
  'key.screenshot': () => t('Скриншот'), 'key.togglePerspective': () => t('Сменить вид'), 'key.smoothCamera': () => t('Плавная камера'),
  'key.fullscreen': () => t('Полный экран'), 'key.advancements': () => t('Достижения'), 'key.socialInteractions': () => t('Взаимодействие с игроками'),
  'key.spectatorOutlines': () => t('Подсветка игроков'), 'key.saveToolbarActivator': () => t('Сохранить панель'), 'key.loadToolbarActivator': () => t('Загрузить панель')
};

const MOUSE = { left: () => t('ЛКМ'), right: () => t('ПКМ'), middle: () => t('СКМ') };

/** "key.keyboard.left.shift" -> "Left Shift", "key.mouse.4" -> "Мышь 4". */
function keyName(v) {
  const s = unquote(v);
  if (!s || s === 'key.keyboard.unknown') return t('не назначено');
  let m = /^key\.mouse\.(.+)$/.exec(s);
  if (m) return MOUSE[m[1]] ? MOUSE[m[1]]() : t('Мышь {n}', { n: m[1] });
  m = /^key\.keyboard\.(.+)$/.exec(s);
  if (!m) return s;
  return m[1].split('.').map(p => (p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1))).join(' ');
}

/** { label, from, to } for one changed option; from is null when the target had no value. */
function describeChange(key, from, to) {
  let label = key;
  let fmt = unquote;
  const known = OPTIONS[key];
  if (known) {
    label = known[0]();
    fmt = known[1];
  } else if (key.startsWith('key_')) {
    const action = key.slice(4);
    // vanilla actions by name, a mod's own as "vivecraft: rotateLeft"
    const mod = /^([\w-]+)\.key\.(.+)$/.exec(action) || /^key\.([\w-]+)\.(.+)$/.exec(action);
    const name = ACTIONS[action] ? ACTIONS[action]() : mod ? `${mod[1]}: ${mod[2]}` : action.replace(/^key\./, '');
    label = t('Клавиша «{action}»', { action: name });
    fmt = keyName;
  } else if (key.startsWith('soundCategory_')) {
    const cat = key.slice('soundCategory_'.length);
    label = t('Громкость: {what}', { what: SOUNDS[cat] ? SOUNDS[cat]() : cat });
    fmt = percent;
  } else if (key.startsWith('modelPart_')) {
    label = t('Скин: {part}', { part: key.slice('modelPart_'.length) });
    fmt = on;
  } else {
    fmt = (v) => on(unquote(v));
  }
  const safe = (v) => {
    if (v == null) return null;
    try {
      const out = fmt(v);
      return out === 'NaN%' || out === 'NaN' ? unquote(v) : String(out);
    } catch (e) {
      return unquote(v);
    }
  };
  return { key, label, from: safe(from), to: safe(to) };
}

module.exports = { describeChange };
