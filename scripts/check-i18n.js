/**
 * check-i18n.js — `npm run i18n`
 * Collects the Russian texts the launcher translates (src/i18n/i18n.js) and checks them against
 * the English dictionary src/i18n/en.js:
 *   - t('…') / i18n.t('…'), pluralize(n, ['…', '…', '…']) and literals on lines marked // i18n-key;
 *   - text and title / placeholder / aria-label of the pages' markup (not inside translate="no");
 *   - the theme names (src/themes.json).
 * Reports texts missing from the dictionary, {placeholders} that differ, dictionary entries nothing
 * uses and Russian literals in the code that aren't passed through t() (// i18n-ignore keeps one).
 * `--skeleton` prints the missing texts as dictionary lines. Exits with 1 when something is missing.
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const CYRILLIC = /[А-Яа-яЁё]/;
const EN = require(path.join(SRC, 'i18n', 'en.js'));

const keys = new Map(); // text -> first place it's used
const unwrapped = [];

function use(key, where) {
  if (!keys.has(key)) keys.set(key, where);
}

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'i18n' || e.name === 'installer' ? [] : jsFiles(full);
    return e.name.endsWith('.js') && e.name !== 'themes.js' ? [full] : [];
  });
}

const unquote = (s) => s.replace(/\\(.)/g, '$1');

for (const file of jsFiles(SRC)) {
  const rel = path.relative(SRC, file);
  let inBlock = false;
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
    const where = `${rel}:${i + 1}`;
    const trimmed = line.trim();
    if (inBlock) { if (trimmed.includes('*/')) inBlock = false; return; }
    if (trimmed.startsWith('/*')) { if (!trimmed.includes('*/')) inBlock = true; return; }
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
    const code = line.replace(/\s\/\/ .*$/, '');
    for (const m of code.matchAll(/\bt\('((?:[^'\\]|\\.)*)'/g)) use(unquote(m[1]), where);
    for (const m of code.matchAll(/plurali[sz]e\([^,]+,\s*\[\s*'([^']*)',\s*'([^']*)',\s*'([^']*)'\s*\]/g)) use(`${m[1]}|${m[2]}|${m[3]}`, where);
    if (line.includes('i18n-key')) {
      for (const m of code.matchAll(/'((?:[^'\\]|\\.)*)'/g)) if (CYRILLIC.test(m[1])) use(unquote(m[1]), where);
      return;
    }
    if (line.includes('i18n-ignore')) return;
    // what's left after the translated parts shouldn't be Russian
    const rest = code
      .replace(/\bt\('(?:[^'\\]|\\.)*'/g, '')
      .replace(/plurali[sz]e\([^,]+,\s*\[[^\]]*\]/g, '')
      .replace(/\/(?:[^/\\\n]|\\.)+\/[gimsuy]*/g, m => (CYRILLIC.test(m) && /[\\^$]/.test(m) ? '' : m));
    if (CYRILLIC.test(rest)) unwrapped.push(`${where}: ${trimmed.slice(0, 140)}`);
  });
}

// Markup: text nodes and attributes, skipping <script>, <style> and translate="no" elements
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
for (const name of fs.readdirSync(path.join(SRC, 'renderer')).filter(n => n.endsWith('.html'))) {
  const html = fs.readFileSync(path.join(SRC, 'renderer', name), 'utf8');
  const lineOf = (index) => html.slice(0, index).split('\n').length;
  const stack = [];
  const skipped = () => stack.some(e => e.skip);
  for (const m of html.matchAll(/<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>|([^<]+)/g)) {
    const where = `renderer/${name}:${lineOf(m.index)}`;
    if (m[0].startsWith('<!--')) continue;
    if (m[5] !== undefined) {
      const top = stack[stack.length - 1];
      if (top && (top.tag === 'script' || top.tag === 'style')) continue;
      const text = m[5].replace(/\s+/g, ' ').trim();
      if (CYRILLIC.test(text) && !skipped()) use(text, where);
      continue;
    }
    const [, closing, tagName, attrs, selfClosing] = m;
    const tag = tagName.toLowerCase();
    if (closing) {
      const at = stack.map(e => e.tag).lastIndexOf(tag);
      if (at >= 0) stack.length = at;
      continue;
    }
    if (!skipped() && !/translate="no"/.test(attrs)) {
      for (const a of attrs.matchAll(/\b(title|placeholder|aria-label)="([^"]*)"/g)) if (CYRILLIC.test(a[2])) use(a[2], where);
    }
    if (!selfClosing && !VOID.has(tag)) stack.push({ tag, skip: /translate="no"/.test(attrs) });
  }
}

for (const theme of JSON.parse(fs.readFileSync(path.join(SRC, 'themes.json'), 'utf8'))) use(theme.name, 'themes.json');

const names = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');
const missing = [...keys.keys()].filter(k => !(k in EN));
const mismatched = [...keys.keys()].filter(k => k in EN && names(k) !== names(EN[k]));
const unused = Object.keys(EN).filter(k => !keys.has(k));

if (process.argv.includes('--skeleton')) {
  for (const k of missing) console.log(`  ${JSON.stringify(k)}: '',`);
  process.exit(0);
}
const section = (title, list) => {
  if (!list.length) return;
  console.log(`\n${title} (${list.length}):`);
  for (const line of list) console.log(`  ${line}`);
};
section('Нет в en.js', missing.map(k => `${keys.get(k)}  ${k}`));
section('Не совпадают {подстановки}', mismatched.map(k => `${k}  →  ${EN[k]}`));
section('Не переведены (нет t())', unwrapped);
section('Не используются в коде', unused);
console.log(`\n${keys.size} текстов, в en.js ${Object.keys(EN).length}`);
process.exit(missing.length || mismatched.length ? 1 : 0);
