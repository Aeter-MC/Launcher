/**
 * generate-themes.js
 * Writes the 16 stock color themes into design/themes/<id>.json.
 *
 * Each theme is described by a hue for the tinted greys and an accent color; the rest of the
 * palette (backgrounds, lines, text, logs, block tiles) is derived from them so every theme has
 * the same contrast steps. The generated files are ordinary token files: after generating you can
 * tweak any value by hand or in Figma — just do not run this script again, or it will overwrite them.
 *
 * Usage: node scripts/generate-themes.js && npm run tokens
 */
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'design', 'themes');
const BASE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'design', 'tokens.json'), 'utf-8'));

// ---------- color helpers ----------
function hsl(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return '#' + [f(0), f(8), f(4)].map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
}
const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const toHex = c => '#' + c.map(x => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => toHex(rgb(a).map((x, i) => x + (rgb(b)[i] - x) * t));
const alpha = (hex, a) => hex + Math.round(a * 255).toString(16).padStart(2, '0');
function luminance(hex) {
  const [r, g, b] = rgb(hex).map(v => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
// Accent used as text/icons (links, "Установлен") must stay readable on the surface:
// step it towards black (light themes) or white (dark themes) until contrast >= 4.5.
function readableOn(color, surface, towards) {
  let c = color;
  for (let i = 0; i < 20 && contrast(c, surface) < 4.5; i++) c = mix(c, towards, 0.08);
  return c;
}
// text on the accent: whichever of near-black / white reads better
const inkFor = (accent, dark, light) => (contrast(accent, dark) >= contrast(accent, light) ? dark : light);

// ---------- theme definitions ----------
const HUES = [
  { key: 'purple', name: 'Фиолетовая', hue: 265, dark: '#a07cf0', light: '#7347d6' },
  { key: 'blue', name: 'Синяя', hue: 218, dark: '#5b9cf5', light: '#2563d9' },
  { key: 'red', name: 'Красная', hue: 358, dark: '#ef6461', light: '#d33434' },
  { key: 'green', name: 'Зелёная', hue: 110, dark: '#62b856', light: '#24802a' },
  { key: 'pink', name: 'Розовая', hue: 328, dark: '#ee76b6', light: '#cf3a88' },
  { key: 'yellow', name: 'Жёлтая', hue: 46, dark: '#e8c547', light: '#e0b10f' },
  { key: 'orange', name: 'Оранжевая', hue: 24, dark: '#f28d45', light: '#e06a17' },
  // Monotone: warm neutral greys like the Claude app, accent is the strongest neutral
  { key: 'mono', name: 'Монотонная', hue: 48, dark: '#ece9df', light: '#1f1e1c', mono: true }
];

function darkTheme(t) {
  const h = t.hue;
  // colored themes: deep, slightly tinted graphite; monotone: lighter warm grey
  const s = t.mono ? 4 : 9;
  const L = t.mono
    ? { side: 11, input: 11.5, bg: 14, surface: 17.5, surface2: 20.5, hover: 23.5, line: 24, lineStrong: 30, scroll: 28, scrollHover: 35, log: 10 }
    : { side: 5.5, input: 6.5, bg: 7.5, surface: 10, surface2: 12, hover: 14.5, line: 16, lineStrong: 21, scroll: 18, scrollHover: 24, log: 4.5 };
  const accent = t.dark;
  const ink = inkFor(accent, hsl(h, 30, 7), '#ffffff');
  const bg = hsl(h, s, L.bg);
  return {
    mode: 'dark',
    color: {
      'bg': bg,
      'bg-side': hsl(h, s, L.side),
      'surface': hsl(h, s, L.surface),
      'surface-2': hsl(h, s, L.surface2),
      'hover': hsl(h, s, L.hover),
      'input': hsl(h, s, L.input),
      'line': hsl(h, s, L.line),
      'line-strong': hsl(h, s, L.lineStrong),
      'scrollbar': hsl(h, s, L.scroll),
      'scrollbar-hover': hsl(h, s, L.scrollHover),
      'text': t.mono ? '#f5f3ec' : hsl(h, 8, 91),
      'text-2': t.mono ? '#b9b6ab' : hsl(h, 6, 62),
      'text-3': t.mono ? '#87847b' : hsl(h, 5, 43),
      'accent': accent,
      'accent-hover': mix(accent, '#ffffff', 0.12),
      'accent-ink': ink,
      'accent-text': readableOn(accent, hsl(h, s, L.surface2), '#ffffff'),
      'accent-soft': alpha(accent, 0.12),
      'accent-border': alpha(accent, 0.55),
      'update': t.key === 'blue' ? '#4fc3e8' : '#5aa0f0',
      'update-soft': alpha(t.key === 'blue' ? '#4fc3e8' : '#5aa0f0', 0.12),
      'update-soft-hover': alpha(t.key === 'blue' ? '#4fc3e8' : '#5aa0f0', 0.2),
      'warn': '#d9a440',
      'warn-soft': alpha('#d9a440', 0.12),
      'danger': '#e5534b',
      'danger-soft': alpha('#e5534b', 0.12),
      'danger-soft-hover': alpha('#e5534b', 0.2),
      'danger-border': alpha('#e5534b', 0.5),
      'danger-text': '#f3b1ac',
      'switch-knob': '#e9e9ea',
      'overlay': alpha('#000000', 0.55),
      'drop-overlay': alpha(bg, 0.92),
      'toast': hsl(h, s, L.line),
      'log': { bg: hsl(h, s, L.log), text: hsl(h, 5, 77), info: '#8fcf86', error: '#f07b74', debug: hsl(h, 4, 39) },
      'ms-button': { 'bg': '#ffffff', 'bg-hover': '#ececec', 'text': '#1b1b1b', 'spinner-track': '#dddddd' }
    },
    blockTiles: (top) => mix(hsl(h, s, L.surface2), top, 0.16),
    shadow: { modal: ['#00000073', '16px', '48px'], toast: ['#00000059', '8px', '24px'], knob: ['#00000040', '1px', '2px'] }
  };
}

function lightTheme(t) {
  const h = t.hue;
  const s = t.mono ? 22 : 18;
  const accent = t.light;
  const ink = inkFor(accent, hsl(h, 40, 10), '#ffffff');
  const bg = t.mono ? '#faf9f5' : hsl(h, s, 97.5);
  return {
    mode: 'light',
    color: {
      'bg': bg,
      'bg-side': t.mono ? '#f2f0e8' : hsl(h, s, 94.5),
      'surface': '#ffffff',
      'surface-2': t.mono ? '#f5f3ec' : hsl(h, s, 95.5),
      'hover': t.mono ? '#ece9df' : hsl(h, s, 92),
      'input': '#ffffff',
      'line': t.mono ? '#e6e3d8' : hsl(h, s - 4, 89),
      'line-strong': t.mono ? '#d4d0c3' : hsl(h, s - 6, 82),
      'scrollbar': t.mono ? '#d4d0c3' : hsl(h, s - 6, 80),
      'scrollbar-hover': t.mono ? '#b9b5a8' : hsl(h, s - 6, 68),
      'text': t.mono ? '#1f1e1c' : hsl(h, 14, 12),
      'text-2': t.mono ? '#5e5c55' : hsl(h, 8, 36),
      'text-3': t.mono ? '#8c8980' : hsl(h, 6, 52),
      'accent': accent,
      'accent-hover': t.mono ? '#3a3935' : mix(accent, '#000000', 0.1),
      'accent-ink': ink,
      'accent-text': readableOn(accent, t.mono ? '#f5f3ec' : hsl(h, s, 95.5), '#000000'),
      'accent-soft': alpha(accent, 0.1),
      'accent-border': alpha(accent, 0.55),
      'update': t.key === 'blue' ? '#0a7397' : '#2563d9',
      'update-soft': alpha(t.key === 'blue' ? '#0a7397' : '#2563d9', 0.1),
      'update-soft-hover': alpha(t.key === 'blue' ? '#0a7397' : '#2563d9', 0.17),
      'warn': '#946000',
      'warn-soft': alpha('#d99a1a', 0.16),
      'danger': '#cc2f2f',
      'danger-soft': alpha('#cc2f2f', 0.09),
      'danger-soft-hover': alpha('#cc2f2f', 0.15),
      'danger-border': alpha('#cc2f2f', 0.45),
      'danger-text': '#a11d1d',
      'switch-knob': '#ffffff',
      'overlay': alpha('#1a1a1a', 0.32),
      'drop-overlay': alpha(bg, 0.92),
      'toast': '#ffffff',
      'log': { bg: t.mono ? '#fdfcf9' : hsl(h, s, 99), text: hsl(h, 10, 24), info: '#2e7d32', error: '#c62828', debug: hsl(h, 6, 62) },
      'ms-button': { 'bg': '#f2f2f2', 'bg-hover': '#e6e6e6', 'text': '#1b1b1b', 'spinner-track': '#dddddd' }
    },
    blockTiles: (top) => mix('#ffffff', top, 0.22),
    shadow: { modal: ['#0000002e', '16px', '48px'], toast: ['#00000024', '8px', '24px'], knob: ['#00000040', '1px', '2px'] }
  };
}

// ---------- write files ----------
const toTokens = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) =>
  [k, typeof v === 'string' ? { $value: v } : toTokens(v)]));

fs.mkdirSync(OUT_DIR, { recursive: true });
const blocks = Object.entries(BASE.color.block).filter(([k, v]) => !k.startsWith('$') && v.top);
let count = 0;
const report = [];

for (const mode of ['dark', 'light']) {
  for (const t of HUES) {
    const theme = mode === 'dark' ? darkTheme(t) : lightTheme(t);
    const id = `${mode}-${t.key}`;
    const color = toTokens(theme.color);
    color.$type = 'color';
    color.block = {};
    for (const [name, b] of blocks) color.block[name] = { tile: { $value: theme.blockTiles(b.top.$value) } };

    const shadow = { $type: 'shadow' };
    for (const [k, [c, y, blur]] of Object.entries(theme.shadow)) {
      shadow[k] = { $value: { color: c, offsetX: '0px', offsetY: y, blur, spread: '0px' } };
    }

    const file = {
      $description: `${mode === 'dark' ? 'Тёмная' : 'Светлая'} ${t.name.toLowerCase()} тема. Переопределяет цвета и тени из tokens.json.`,
      $extensions: { 'mcl.theme': { id, name: t.name, mode, order: HUES.indexOf(t) } },
      color,
      shadow
    };
    fs.writeFileSync(path.join(OUT_DIR, `${id}.json`), JSON.stringify(file, null, 2) + '\n', 'utf-8');
    count++;

    const c = theme.color;
    report.push(`${id.padEnd(13)} text/bg ${contrast(c.text, c.bg).toFixed(1)}  text-2/surface ${contrast(c['text-2'], c.surface).toFixed(1)}  ink/accent ${contrast(c['accent-ink'], c.accent).toFixed(1)}  accent-text/surface ${contrast(c['accent-text'], c.surface).toFixed(1)}  update/surface ${contrast(c.update, c.surface).toFixed(1)}  warn/surface ${contrast(c.warn, c.surface).toFixed(1)}`);
  }
}

console.log(`Wrote ${count} themes to design/themes`);
if (process.argv.includes('--report')) console.log(report.join('\n'));
