const HOME_WIDGETS = ['hero', 'recent', 'news', 'playtime', 'tip', 'monthPlaytime'];
const HOME_COLUMNS = ['left', 'main', 'right'];
const DEFAULT_HOME_SIDE_WIDTH = 280;
const HOME_SIDE_WIDTH_MIN = 240;
const HOME_SIDE_WIDTH_MAX = 340;
const HOME_SIDE_WIDTH_STEP = 10;
const HOME_RECENT_ROWS_MAX = 4;
const HOME_RECENT_COLUMNS_MAX = 5;

function normalizeHomeSideWidth(width) {
  const rounded = Math.round(width / HOME_SIDE_WIDTH_STEP) * HOME_SIDE_WIDTH_STEP;
  return Math.min(HOME_SIDE_WIDTH_MAX, Math.max(HOME_SIDE_WIDTH_MIN, rounded));
}

function normalizeHomeLayout(value) {
  const raw = value && typeof value === 'object' ? value : {};
  const layout = { left: [], main: [], right: [] };
  const legacySide = raw.sideLeft === true ? 'left' : 'right';
  const hidden = new Set();
  const seen = new Set();
  for (const column of HOME_COLUMNS) {
    const source = raw[column] ?? (column === legacySide ? raw.side : null);
    const entries = Array.isArray(source) ? source : [];
    for (const id of entries) {
      if (!HOME_WIDGETS.includes(id) || seen.has(id)) continue;
      seen.add(id);
      layout[column].push(id);
    }
  }
  if (!seen.has('recent')) layout.main.splice(layout.main.indexOf('hero') + 1, 0, 'recent');
  if (!seen.has('hero')) layout.main.unshift('hero');
  for (const id of ['news', 'playtime', 'tip']) if (!seen.has(id)) layout[legacySide].push(id);
  if (!seen.has('monthPlaytime')) {
    const column = HOME_COLUMNS.find(key => layout[key].includes('playtime'));
    layout[column].splice(layout[column].indexOf('playtime') + 1, 0, 'monthPlaytime');
  }
  if (Array.isArray(raw.hidden)) for (const id of raw.hidden) if (HOME_WIDGETS.includes(id)) hidden.add(id);
  const width = typeof raw.sideWidth === 'number' && Number.isFinite(raw.sideWidth) ? raw.sideWidth : DEFAULT_HOME_SIDE_WIDTH;
  return {
    ...layout, hidden: [...hidden],
    sideWidth: normalizeHomeSideWidth(width),
    heroCompact: raw.heroCompact === true,
    recentRows: Number.isInteger(raw.recentRows) && raw.recentRows >= 1 && raw.recentRows <= HOME_RECENT_ROWS_MAX ? raw.recentRows : 0,
    recentColumns: Number.isInteger(raw.recentColumns) && raw.recentColumns >= 1 && raw.recentColumns <= HOME_RECENT_COLUMNS_MAX ? raw.recentColumns : 0,
    weekVertical: raw.weekVertical === true
  };
}

if (typeof module === 'object') module.exports = { normalizeHomeLayout };
