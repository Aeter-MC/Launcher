/**
 * mod-check.js
 * Problems in a build's mods found before the game starts, in plain words with a fix where one is clear:
 *   - the same mod twice (two versions)                         -> switch the older one off
 *   - mods known not to work together (OptiFine + Sodium, …)
 *   - a mod's own "breaks" list naming another installed mod
 *   - a missing required mod, or one in a version the mod does not accept
 *   - the loader or Minecraft version a mod requires            -> update the loader
 *   - a mod for another loader (Forge mod in a Fabric build)
 * Only what is certain is reported: an unreadable version range is never an error.
 */
const { scanModsDir, satisfies, compareVersions } = require('./mod-meta');
const { t } = require('./i18n/i18n');

// provided by the game or the loader itself
const BUILTIN = new Set(['minecraft', 'java', 'fabricloader', 'fabric-loader', 'quilt_loader', 'mixinextras', 'forge', 'neoforge', 'javafml', 'lowcodefml', 'mcp']);
const LOADER_IDS = { fabric: 'fabricloader', quilt: 'quilt_loader' };
// old id of Fabric API that some mods still depend on
const ALIASES = { fabric: 'fabric-api' };

// pairs that crash or break rendering together, whatever their versions
const KNOWN_CONFLICTS = [
  { a: ['optifine', 'optifabric'], b: ['sodium', 'embeddium', 'rubidium', 'magnesium', 'iris', 'oculus', 'nvidium'], why: 'OptiFine заменяет рендер так же, как {b}: вместе они не запускаются. Оставьте один из них (обычно {b} быстрее).' }, // i18n-key
  { a: ['sodium'], b: ['embeddium', 'rubidium'], why: '{a} и {b} — две версии одного мода, нужен только один.' }, // i18n-key
  { a: ['iris'], b: ['oculus'], why: '{a} и {b} — две версии одного мода, нужен только один.' }, // i18n-key
  { a: ['phosphor'], b: ['starlight'], why: '{a} и {b} оба переписывают освещение, нужен только один.' } // i18n-key
];

function displayName(mod) {
  return mod.name && mod.name !== mod.id ? mod.name : mod.id;
}

/**
 * inst: { loader, loaderVersion, version, modsDir }. Returns { issues, mods } where
 * issue = { level: 'error'|'warn', text, files: [jar], fix?: { type: 'disable', file } | { type: 'loader', version } }.
 */
function checkBuild(inst, jars = scanModsDir(inst.modsDir)) {
  const issues = [];
  const enabled = jars.filter(j => j.enabled);
  const fabricLike = inst.loader === 'fabric' || inst.loader === 'quilt';

  // what is installed: id -> [{ mod, file }], including bundled jars and "provides"
  const present = new Map();
  const add = (id, mod, file) => {
    if (!id) return;
    if (!present.has(id)) present.set(id, []);
    present.get(id).push({ mod, file });
  };
  for (const jar of enabled) {
    for (const mod of jar.mods) {
      add(mod.id, mod, jar.file);
      (mod.provides || []).forEach(p => add(p, mod, jar.file));
    }
  }
  const has = (id) => present.has(ALIASES[id] || id) || present.has(id);
  const first = (id) => (present.get(ALIASES[id] || id) || present.get(id) || [])[0];

  // 1. the same mod in two files
  const tops = new Map(); // id -> [{ mod, file }] of top-level mods only
  for (const jar of enabled) {
    const top = jar.mods.find(m => !m.bundled && (!fabricLike || m.loader !== 'forge' && m.loader !== 'neoforge')) || jar.mods.find(m => !m.bundled);
    if (top && top.id) {
      if (!tops.has(top.id)) tops.set(top.id, []);
      tops.get(top.id).push({ mod: top, file: jar.file });
    }
  }
  for (const [, list] of tops) {
    if (list.length < 2) continue;
    const sorted = list.slice().sort((x, y) => compareVersions(y.mod.version, x.mod.version) || 0);
    const newest = sorted[0];
    for (const old of sorted.slice(1)) {
      issues.push({
        level: 'error',
        text: t('«{name}» установлен дважды: {a} и {b}. Игра не запустится с двумя версиями одного мода.', { name: displayName(newest.mod), a: newest.mod.version || newest.file, b: old.mod.version || old.file }),
        files: [old.file, newest.file],
        fix: { type: 'disable', file: old.file, label: t('Выключить {file}', { file: old.file }) }
      });
    }
  }

  // 2. known conflicts (OptiFine is often a jar without readable metadata, so its file name counts too)
  const optifineFile = enabled.find(j => /optifine|optifabric/i.test(j.file));
  if (optifineFile && !has('optifine')) add('optifine', { id: 'optifine', name: 'OptiFine', version: '' }, optifineFile.file);
  for (const rule of KNOWN_CONFLICTS) {
    const a = rule.a.find(has);
    const b = rule.b.find(has);
    if (!a || !b) continue;
    const ma = first(a), mb = first(b);
    if (ma.file === mb.file) continue;
    issues.push({
      level: 'error',
      text: t(rule.why, { a: displayName(ma.mod), b: displayName(mb.mod) }),
      files: [ma.file, mb.file],
      fix: { type: 'disable', file: ma.file, label: t('Выключить {file}', { file: ma.file }) }
    });
  }

  // 3-5. each mod's own requirements
  let loaderNeeded = null; // the highest ">=x" a mod asks of the loader
  for (const jar of enabled) {
    const own = jar.mods.filter(m => !m.bundled);
    const mod = own[0];
    if (!mod) continue;

    // a mod for another loader
    if (fabricLike && own.every(m => m.loader === 'forge' || m.loader === 'neoforge') && !has('connector')) {
      issues.push({ level: 'error', text: t('«{name}» — мод для Forge/NeoForge, в сборке на {loader} он не загрузится.', { name: displayName(mod), loader: inst.loader === 'quilt' ? 'Quilt' : 'Fabric' }), files: [jar.file], fix: { type: 'disable', file: jar.file, label: t('Выключить {file}', { file: jar.file }) } });
      continue;
    }
    if ((inst.loader === 'forge' || inst.loader === 'neoforge') && own.every(m => m.loader === 'fabric' || m.loader === 'quilt')) {
      issues.push({ level: 'error', text: t('«{name}» — мод для Fabric, в сборке на {loader} он не загрузится.', { name: displayName(mod), loader: inst.loader === 'neoforge' ? 'NeoForge' : 'Forge' }), files: [jar.file], fix: { type: 'disable', file: jar.file, label: t('Выключить {file}', { file: jar.file }) } });
      continue;
    }
    if (mod.environment === 'server') {
      issues.push({ level: 'warn', text: t('«{name}» — серверный мод, в клиенте он не нужен.', { name: displayName(mod) }), files: [jar.file], fix: { type: 'disable', file: jar.file, label: t('Выключить {file}', { file: jar.file }) } });
    }

    for (const [rawId, pred] of Object.entries(mod.depends || {})) {
      const id = ALIASES[rawId] || rawId;
      if (id === 'minecraft') {
        if (fabricLike && satisfies(inst.version, pred) === false) {
          issues.push({ level: 'error', text: t('«{name}» сделан для Minecraft {need}, а сборка на {have}.', { name: displayName(mod), need: [].concat(pred).join(' / '), have: inst.version }), files: [jar.file], fix: { type: 'disable', file: jar.file, label: t('Выключить {file}', { file: jar.file }) } });
        }
        continue;
      }
      if (fabricLike && id === LOADER_IDS[inst.loader]) {
        if (inst.loaderVersion && satisfies(inst.loaderVersion, pred) === false) {
          const min = [].concat(pred).map(p => (/^>=\s*(\S+)$/.exec(String(p).trim()) || [])[1]).filter(Boolean)[0];
          if (min && (!loaderNeeded || compareVersions(min, loaderNeeded.version) > 0)) loaderNeeded = { version: min, mod: displayName(mod) };
          if (!min) issues.push({ level: 'error', text: t('«{name}» требует {loader} {need}, а в сборке {have}.', { name: displayName(mod), loader: 'Fabric Loader', need: [].concat(pred).join(' / '), have: inst.loaderVersion }), files: [jar.file] });
        }
        continue;
      }
      if (BUILTIN.has(id) || (inst.loader === 'quilt' && id === 'fabricloader')) continue;
      if (!has(id)) {
        issues.push({ level: 'error', text: t('«{name}» не работает без мода «{dep}» — его нет в сборке.', { name: displayName(mod), dep: rawId }), files: [jar.file], fix: { type: 'search', query: rawId, label: t('Найти «{dep}»', { dep: rawId }) } });
        continue;
      }
      if (fabricLike) {
        const dep = first(id);
        if (dep && dep.mod.version && satisfies(dep.mod.version, pred) === false) {
          issues.push({ level: 'error', text: t('«{name}» требует «{dep}» {need}, а установлен {have}.', { name: displayName(mod), dep: displayName(dep.mod), need: [].concat(pred).join(' / '), have: dep.mod.version }), files: [jar.file, dep.file] });
        }
      }
    }

    for (const [id, pred] of Object.entries(mod.breaks || {})) {
      if (BUILTIN.has(id)) continue;
      const other = first(id);
      if (other && other.file !== jar.file && satisfies(other.mod.version, pred) === true) {
        issues.push({ level: 'error', text: t('«{name}» несовместим с «{other}» {version}.', { name: displayName(mod), other: displayName(other.mod), version: other.mod.version }), files: [jar.file, other.file], fix: { type: 'disable', file: other.file, label: t('Выключить {file}', { file: other.file }) } });
      }
    }
  }

  if (loaderNeeded) {
    issues.unshift({
      level: 'error',
      text: t('Модам нужен {loader} {need} или новее, а в сборке {have} (первым это требует «{mod}»).', { loader: inst.loader === 'quilt' ? 'Quilt Loader' : 'Fabric Loader', need: loaderNeeded.version, have: inst.loaderVersion, mod: loaderNeeded.mod }),
      files: [],
      fix: { type: 'loader', version: loaderNeeded.version, label: t('Обновить загрузчик') }
    });
  }

  // one line per problem, even when several mods report the same thing
  const seen = new Set();
  return {
    issues: issues.filter(i => !seen.has(i.text) && seen.add(i.text)),
    mods: enabled.length
  };
}

module.exports = { checkBuild };
