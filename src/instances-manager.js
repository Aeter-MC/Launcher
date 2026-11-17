/**
 * instances-manager.js
 * manages isolated Minecraft instances (like Prism Launcher & Modrinth App).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { t } = require('./i18n/i18n');
const { contentType, contentDir } = require('./content-types');

const { discoverSources, pathKey, realDirectory, readSmallText, externalId } = require('./multimc-sources');

// custom build icon of a native instance, stored next to instance.cfg
const ICON_FILE = 'icon.png';
const ICON_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.bmp': 'image/bmp' };

/** image file as a data: URL (the renderer's CSP allows no file: images), or null. */
function iconDataUrl(file) {
  const mime = ICON_MIME[path.extname(file).toLowerCase()];
  if (!mime) return null;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return null;
    return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
  } catch (e) {
    return null;
  }
}

/** prism keeps custom icons as <iconKey>.<ext> in its icons folder; built-in keys have no file. */
function prismIconFile(iconKey, iconsDir) {
  if (!iconKey || iconKey === 'default' || /[\\/]/.test(iconKey)) return null;
  try {
    const f = fs.readdirSync(iconsDir, { withFileTypes: true }).find(e => e.isFile()
      && path.parse(e.name).name === iconKey && ICON_MIME[path.extname(e.name).toLowerCase()]);
    return f ? path.join(iconsDir, f.name) : null;
  } catch (e) {
    return null;
  }
}

/** sets key=value in the text of a Prism instance.cfg, adding the line when it's missing. */
function setCfgValue(cfg, key, value) {
  const re = new RegExp(`^${key}=.*$`, 'm');
  const line = `${key}=${String(value).replace(/[\r\n]/g, ' ')}`;
  if (re.test(cfg)) return cfg.replace(re, () => line);
  // prism writes CRLF on Windows: keep the file's own line endings
  const eol = cfg.includes('\r\n') ? '\r\n' : '\n';
  return cfg.replace(/\s*$/, eol) + line + eol;
}

function cfgValue(cfg, key) {
  const m = cfg.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return m ? m[1].trim() : null;
}

// launch settings of a build: any field left out means "as in the launcher settings"
const LAUNCH_KEYS = ['maxRam', 'minRam', 'javaPath', 'jvmPreset', 'customJvmArgs', 'resolutionWidth', 'resolutionHeight', 'fullscreen', 'noOptionsSync'];

/** merge validated per-build overrides over the launcher's defaults. */
function resolveLaunchSettings(settings, instance) {
  return { ...settings, ...cleanLaunch(instance?.launch) };
}

/** keeps only known fields with sensible values. */
function cleanLaunch(launch) {
  const out = {};
  if (!launch || typeof launch !== 'object') return out;
  const int = (v, lo, hi) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : undefined; };
  if (launch.maxRam != null) out.maxRam = int(launch.maxRam, 1, 64);
  if (launch.minRam != null) out.minRam = int(launch.minRam, 1, 64);
  if (out.maxRam && out.minRam && out.minRam > out.maxRam) out.minRam = out.maxRam;
  if (typeof launch.javaPath === 'string' && launch.javaPath) out.javaPath = launch.javaPath;
  if (['auto', 'g1', 'zgc', 'shenandoah', 'none'].includes(launch.jvmPreset)) out.jvmPreset = launch.jvmPreset;
  if (typeof launch.customJvmArgs === 'string') out.customJvmArgs = launch.customJvmArgs.trim();
  if (launch.resolutionWidth != null) out.resolutionWidth = int(launch.resolutionWidth, 320, 15360);
  if (launch.resolutionHeight != null) out.resolutionHeight = int(launch.resolutionHeight, 240, 8640);
  if (typeof launch.fullscreen === 'boolean') out.fullscreen = launch.fullscreen;
  // the build keeps its own game settings: no transfer before launch, none taken from it
  if (launch.noOptionsSync === true) out.noOptionsSync = true;
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

/**
 * prism keeps the same settings in instance.cfg under Override* switches (memory in MB);
 * reading and writing them there lets both launchers start the build the same way.
 * the GC preset has no Prism equivalent and is kept as aetermc_jvmPreset.
 */
function prismLaunch(cfg) {
  const launch = {};
  const on = (k) => cfgValue(cfg, k) === 'true';
  if (on('OverrideMemory')) {
    const max = parseInt(cfgValue(cfg, 'MaxMemAlloc'), 10);
    const min = parseInt(cfgValue(cfg, 'MinMemAlloc'), 10);
    if (max) launch.maxRam = Math.max(1, Math.round(max / 1024));
    if (min) launch.minRam = Math.max(1, Math.round(min / 1024));
  }
  if (on('OverrideJavaLocation') && cfgValue(cfg, 'JavaPath')) launch.javaPath = cfgValue(cfg, 'JavaPath');
  if (on('OverrideJavaArgs')) launch.customJvmArgs = cfgValue(cfg, 'JvmArgs') || '';
  if (on('OverrideWindow')) {
    launch.resolutionWidth = parseInt(cfgValue(cfg, 'MinecraftWinWidth'), 10) || undefined;
    launch.resolutionHeight = parseInt(cfgValue(cfg, 'MinecraftWinHeight'), 10) || undefined;
    launch.fullscreen = cfgValue(cfg, 'LaunchMaximized') === 'true';
  }
  const preset = cfgValue(cfg, 'aetermc_jvmPreset');
  if (preset) launch.jvmPreset = preset;
  if (cfgValue(cfg, 'aetermc_noOptionsSync') === 'true') launch.noOptionsSync = true;
  const inherited = (cfgValue(cfg, 'aetermc_inheritedLaunchFields') || '').split(',');
  for (const field of inherited) delete launch[field];
  return cleanLaunch(launch);
}

// prism component ids of the loaders, with the display names Prism caches
const LOADER_COMPONENTS = {
  fabric: { uid: 'net.fabricmc.fabric-loader', name: 'Fabric Loader', intermediary: true },
  quilt: { uid: 'org.quiltmc.quilt-loader', name: 'Quilt Loader', intermediary: true },
  forge: { uid: 'net.minecraftforge', name: 'Forge' },
  neoforge: { uid: 'net.neoforged', name: 'NeoForge' }
};

function mmcPack(inst) {
  const components = [
    { cachedName: 'Minecraft', cachedVersion: inst.version, important: true, uid: 'net.minecraft', version: inst.version }
  ];
  const loader = LOADER_COMPONENTS[inst.loader];
  if (loader) {
    // fabric and Quilt map names through Intermediary; Prism would add it too, but only after a refresh
    if (loader.intermediary) {
      components.push({ cachedName: 'Intermediary Mappings', cachedVersion: inst.version, dependencyOnly: true, uid: 'net.fabricmc.intermediary', version: inst.version });
    }
    components.push({ cachedName: loader.name, cachedVersion: inst.loaderVersion, uid: loader.uid, version: inst.loaderVersion || '' });
  }
  return { components, formatVersion: 1 };
}

function prismComponents(pack) {
  const components = Array.isArray(pack?.components) ? pack.components : [];
  const minecraft = components.find(c => c?.uid === 'net.minecraft');
  const version = minecraft?.version || minecraft?.cachedVersion || '';
  // prefer Quilt if a pack also lists Fabric.
  for (const loader of ['quilt', 'fabric', 'neoforge', 'forge']) {
    const component = components.find(c => c?.uid === LOADER_COMPONENTS[loader].uid);
    if (component) return { version, loader, loaderVersion: component.version || component.cachedVersion || '' };
  }
  return { version, loader: 'vanilla', loaderVersion: '' };
}

function writePrismLaunch(cfg, launch, preserveInheritance = false) {
  const set = (k, v) => { cfg = setCfgValue(cfg, k, v); };
  const has = (k) => launch[k] !== undefined;
  set('OverrideMemory', has('maxRam') || has('minRam'));
  if (has('maxRam') || has('minRam')) {
    set('MaxMemAlloc', (launch.maxRam || launch.minRam) * 1024);
    set('MinMemAlloc', (launch.minRam || 1) * 1024);
  }
  set('OverrideJavaLocation', has('javaPath'));
  if (has('javaPath')) set('JavaPath', launch.javaPath);
  set('OverrideJavaArgs', has('customJvmArgs'));
  if (has('customJvmArgs')) set('JvmArgs', launch.customJvmArgs);
  const win = has('resolutionWidth') || has('resolutionHeight') || has('fullscreen');
  set('OverrideWindow', win);
  if (win) {
    if (has('resolutionWidth')) set('MinecraftWinWidth', launch.resolutionWidth);
    if (has('resolutionHeight')) set('MinecraftWinHeight', launch.resolutionHeight);
    set('LaunchMaximized', !!launch.fullscreen);
  }
  if (preserveInheritance) {
    const grouped = ['minRam', 'maxRam', 'resolutionWidth', 'resolutionHeight', 'fullscreen'];
    set('aetermc_inheritedLaunchFields', grouped.filter(key => !has(key)).join(','));
  }
  set('aetermc_jvmPreset', launch.jvmPreset || '');
  set('aetermc_noOptionsSync', !!launch.noOptionsSync);
  return cfg;
}

const CFG_HEADER = '[General]\nConfigVersion=1.2\nInstanceType=OneSix\n';

function componentSignature(inst) {
  return [inst.version, inst.loader, inst.loaderVersion].join('|');
}

function nativeConfig(cfg, inst) {
  const values = {
    name: inst.name,
    iconKey: inst.customIcon ? 'icon' : 'default',
    lastLaunchTime: inst.lastPlayed || 0,
    totalTimePlayed: inst.totalPlaytime || 0,
    aetermc_id: inst.id,
    aetermc_created: inst.created || Date.now(),
    aetermc_icon: inst.icon || 'grass',
    aetermc_iconBlock: inst.iconBlock || '',
    aetermc_importedFrom: inst.importedFrom || '',
    aetermc_versionId: inst.versionId || '',
    aetermc_versionSignature: componentSignature(inst)
  };
  for (const [key, value] of Object.entries(values)) cfg = setCfgValue(cfg, key, value);
  return cfg;
}

function writeAtomic(file, text) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, text, 'utf-8');
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

// not worth copying when importing: regenerated by the game
const SKIP_ON_IMPORT = new Set(['logs', 'crash-reports', '.cache', 'debug']);

/** all files under dir: [{ full, rel, size, mtime, atime }], skipping top-level folders in `skip`. */
function collectFiles(dir, skip = new Set()) {
  const out = [];
  const walk = (current, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const e of entries) {
      if (!rel && skip.has(e.name)) continue;
      const full = path.join(current, e.name);
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) walk(full, r);
      else if (e.isFile()) {
        try {
          const st = fs.statSync(full);
          out.push({ full, rel: r, size: st.size, mtime: st.mtime, atime: st.atime });
        } catch (err) {}
      }
    }
  };
  walk(dir, '');
  return out;
}

class InstancesManager {
  constructor(userDataDir, versionManager) {
    this.instancesDir = path.join(userDataDir, 'instances');
    this.versionManager = versionManager;
    this.includePrism = false;
    this.externalFolders = [];
    this.ensureDir(this.instancesDir);
  }

  ensureDir(dir) {
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (e) {}
    }
  }

  migrateLegacyInstances() {
    let entries;
    try {
      entries = fs.readdirSync(this.instancesDir, { withFileTypes: true });
    } catch (e) {
      console.error('[Instances] Could not read the instance library:', e.message);
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(this.instancesDir, entry.name);
      try {
        this.migrateLegacyInstance(dir);
      } catch (e) {
        console.error(`[Instances] Could not migrate ${entry.name}:`, e.message);
      }
    }
  }

  migrateLegacyInstance(dir) {
    const legacy = path.join(dir, 'instance.json');
    if (!fs.existsSync(legacy)) return;
    const data = JSON.parse(fs.readFileSync(legacy, 'utf-8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid instance.json');
    const cfgPath = path.join(dir, 'instance.cfg');
    const packPath = path.join(dir, 'mmc-pack.json');
    const current = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, 'utf-8') : null;
    if (!current || !cfgValue(current, 'aetermc_id')) {
      const saved = { version: data.version || '1.21.1', loader: data.loader || 'vanilla', loaderVersion: data.loaderVersion || '' };
      let components = saved;
      try {
        const parsed = prismComponents(JSON.parse(fs.readFileSync(packPath, 'utf-8')));
        if (parsed.version) components = parsed;
      } catch (e) {}
      if (components === saved) writeAtomic(packPath, JSON.stringify(mmcPack(saved), null, 2));
      const cfg = current ?? writePrismLaunch(CFG_HEADER, cleanLaunch(data.launch), true);
      writeAtomic(cfgPath, nativeConfig(cfg, {
        ...data,
        ...components,
        id: data.id || path.basename(dir),
        name: cfgValue(cfg, 'name') || data.name || path.basename(dir),
        versionId: componentSignature(saved) === componentSignature(components) ? data.versionId : ''
      }));
    }
    const backup = `${legacy}.legacy`;
    fs.renameSync(legacy, fs.existsSync(backup) ? `${backup}-${crypto.randomUUID()}` : backup);
  }

  updateInstanceCfg(target, update) {
    if (!target.isPrism) this.migrateLegacyInstance(target.path);
    const file = path.join(target.path, 'instance.cfg');
    const cfg = target.isPrism ? readSmallText(file) : fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : CFG_HEADER;
    writeAtomic(file, update(cfg));
  }

  rereadInstance(target) {
    return this.readInstance(target.path, target.isPrism ? {
      name: target.externalSource, iconsDir: target.externalIconsDir, legacy: target.id.startsWith('prism-')
    } : null);
  }

  /**
   * reads an instance from a directory.
   */
  readInstance(dirPath, source = null) {
    const configJson = path.join(dirPath, 'instance.json');
    const mmcPackJson = path.join(dirPath, 'mmc-pack.json');
    const instanceCfg = path.join(dirPath, 'instance.cfg');

    // 1. Native MCL Instance
    if (!source && fs.existsSync(configJson)) {
      try {
        const data = JSON.parse(fs.readFileSync(configJson, 'utf-8'));
        const cfg = fs.existsSync(instanceCfg) ? fs.readFileSync(instanceCfg, 'utf-8') : null;
        const saved = { version: data.version || '1.21.1', loader: data.loader || 'vanilla', loaderVersion: data.loaderVersion || '' };
        let components = saved;
        try {
          if (fs.existsSync(mmcPackJson)) {
            const parsed = prismComponents(JSON.parse(fs.readFileSync(mmcPackJson, 'utf-8')));
            if (parsed.version) components = parsed;
          }
        } catch (e) {}
        const sameComponents = Object.keys(saved).every(key => saved[key] === components[key]);
        const mcDir = path.join(dirPath, 'minecraft');
        const modsDir = fs.existsSync(mcDir) ? path.join(mcDir, 'mods') : path.join(dirPath, 'mods');

        let modCount = 0;
        if (fs.existsSync(modsDir)) {
          modCount = fs.readdirSync(modsDir).filter(f => f.endsWith('.jar')).length;
        }

        return {
          id: data.id || path.basename(dirPath),
          name: (cfg && cfgValue(cfg, 'name')) || data.name || path.basename(dirPath),
          ...components,
          versionId: sameComponents ? data.versionId || '' : '',
          icon: data.icon || 'grass',
          iconBlock: data.iconBlock || null,
          iconImage: data.customIcon ? iconDataUrl(path.join(dirPath, ICON_FILE)) : null,
          path: dirPath,
          minecraftDir: fs.existsSync(mcDir) ? mcDir : dirPath,
          modsDir: modsDir,
          modCount: modCount,
          lastPlayed: data.lastPlayed || null,
          totalPlaytime: data.totalPlaytime || 0,
          importedFrom: data.importedFrom || null,
          launch: cfg !== null ? prismLaunch(cfg) : cleanLaunch(data.launch),
          isPrism: false
        };
      } catch (e) {
        console.error('Error reading instance.json:', e);
      }
    }

    // 2. AeterMC and Prism Launcher config format
    if (fs.existsSync(mmcPackJson) || fs.existsSync(instanceCfg)) {
      const isPrism = !!source;
      const cfg = source ? readSmallText(instanceCfg) : fs.existsSync(instanceCfg) ? fs.readFileSync(instanceCfg, 'utf-8') : '';
      const ownId = isPrism ? null : cfgValue(cfg, 'aetermc_id');
      const name = cfgValue(cfg, 'name') || path.basename(dirPath);
      const iconKey = cfgValue(cfg, 'iconKey') || 'default';
      const launch = prismLaunch(cfg);
      const lastPlayed = Number(cfgValue(cfg, 'lastLaunchTime')) || null;
      const totalPlaytime = Number(cfgValue(cfg, 'totalTimePlayed')) || 0;
      let version = '1.21.1';
      let loader = 'vanilla';
      let loaderVersion = '';

      if (source || fs.existsSync(mmcPackJson)) {
        try {
          const pack = JSON.parse(source ? readSmallText(mmcPackJson) : fs.readFileSync(mmcPackJson, 'utf-8'));
          if (pack.components) {
            const components = prismComponents(pack);
            const valid = value => typeof value === 'string' && /^[\w.+-]{1,128}$/.test(value) && value !== '.' && value !== '..';
            if (source && (!valid(components.version) || (components.loader !== 'vanilla' && !valid(components.loaderVersion)))) return null;
            version = components.version || version;
            loader = components.loader;
            loaderVersion = components.loaderVersion;
          } else if (source) return null;
        } catch (e) { if (source) return null; }
      }

      const gameFolders = source?.name === 'MultiMC' ? ['.minecraft', 'minecraft'] : ['minecraft', '.minecraft'];
      const mcDir = gameFolders.map(d => path.join(dirPath, d)).find(d => fs.existsSync(d)) || path.join(dirPath, gameFolders[0]);
      if (source) {
        try { if (!fs.lstatSync(mcDir).isDirectory()) return null; }
        catch (error) { if (error.code !== 'ENOENT') return null; }
      }
      const gameDir = source || fs.existsSync(mcDir) ? mcDir : dirPath;
      const modsDir = path.join(gameDir, 'mods');

      let modCount = 0;
      if (fs.existsSync(modsDir)) {
        modCount = fs.readdirSync(modsDir).filter(f => f.endsWith('.jar')).length;
      }

      return {
        id: source ? externalId(dirPath, source) : ownId || path.basename(dirPath),
        name,
        version,
        loader,
        loaderVersion,
        versionId: !isPrism && cfgValue(cfg, 'aetermc_versionSignature') === componentSignature({ version, loader, loaderVersion })
          ? cfgValue(cfg, 'aetermc_versionId') || '' : '',
        icon: isPrism ? iconKey : cfgValue(cfg, 'aetermc_icon') || 'grass',
        iconBlock: isPrism ? null : cfgValue(cfg, 'aetermc_iconBlock'),
        iconImage: isPrism
          ? (() => { const f = prismIconFile(iconKey, source.iconsDir); return f ? iconDataUrl(f) : null; })()
          : iconKey === 'icon' ? iconDataUrl(path.join(dirPath, ICON_FILE)) : null,
        importedFrom: isPrism ? null : cfgValue(cfg, 'aetermc_importedFrom'),
        path: dirPath,
        minecraftDir: gameDir,
        modsDir: modsDir,
        modCount: modCount,
        lastPlayed: lastPlayed,
        totalPlaytime: totalPlaytime,
        launch,
        isPrism,
        ...(source && { externalSource: source.name, externalIconsDir: source.iconsDir })
      };
    }

    return null;
  }

  /**
   * lists all available instances.
   */
  listInstances({ includeExternal = this.includePrism } = {}) {
    const list = [];

    // 1. MCL native instances
    if (fs.existsSync(this.instancesDir)) {
      try {
        const dirs = fs.readdirSync(this.instancesDir, { withFileTypes: true });
        for (const d of dirs) {
          if (d.isDirectory()) {
            const fullPath = path.join(this.instancesDir, d.name);
            const inst = this.readInstance(fullPath);
            if (inst) {
              list.push(inst);
            }
          }
        }
      } catch (e) {}
    }

    if (includeExternal) list.push(...this.listExternalInstances());

    // most recently played first, then alphabetically
    list.sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0) || a.name.localeCompare(b.name));
    return list;
  }

  listExternalInstances() {
    const own = pathKey(realDirectory(this.instancesDir) || this.instancesDir);
    const instances = [];
    for (const source of discoverSources(this.externalFolders)) {
      const key = pathKey(source.dir);
      if (key === own || key.startsWith(own + path.sep)) continue;
      let entries;
      try { entries = fs.readdirSync(source.dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        try {
          const inst = this.readInstance(path.join(source.dir, entry.name), source);
          if (inst) instances.push(inst);
        } catch {}
      }
    }
    return instances;
  }

  listExternalImports() {
    const imported = new Set(this.listInstances({ includeExternal: false }).filter(i => i.importedFrom)
      .map(i => pathKey(realDirectory(i.importedFrom) || i.importedFrom)));
    return this.listExternalInstances().map(inst => {
      const files = collectFiles(inst.minecraftDir, SKIP_ON_IMPORT);
      return {
        key: inst.id,
        source: inst.externalSource,
        name: inst.name,
        version: inst.version,
        loader: inst.loader,
        loaderVersion: inst.loaderVersion,
        modCount: inst.modCount,
        sizeBytes: files.reduce((sum, f) => sum + f.size, 0),
        alreadyImported: imported.has(pathKey(inst.path))
      };
    }).sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name));
  }

  /**
   * copies a Prism Launcher instance into MCL. The original is left untouched.
   * onProgress({ copiedBytes, totaLBytes })
   */
  async importExternalInstance(key, onProgress, candidates = this.listExternalInstances()) {
    const src = candidates.find(inst => inst.id === key);
    if (!src) throw new Error(t('Внешняя сборка не найдена'));

    const slug = (src.name.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase().slice(0, 48) || 'instance') + '_' + crypto.randomUUID();
    const destDir = path.join(this.instancesDir, slug);
    const work = fs.mkdtempSync(path.join(path.dirname(this.instancesDir), '.mmc-import-'));
    const destMc = path.join(work, 'minecraft');

    const files = fs.existsSync(src.minecraftDir) ? collectFiles(src.minecraftDir, SKIP_ON_IMPORT) : [];
    const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
    let copiedBytes = 0;
    let lastReport = 0;

    try {
      for (const f of files) {
        const dest = path.join(destMc, f.rel);
        await fs.promises.mkdir(path.dirname(dest), { recursive: true });
        await fs.promises.copyFile(f.full, dest);
        // keep timestamps: settings transfer compares options.txt modification times
        await fs.promises.utimes(dest, f.atime, f.mtime).catch(() => {});
        copiedBytes += f.size;
        if (onProgress && Date.now() - lastReport > 150) {
          lastReport = Date.now();
          onProgress({ copiedBytes, totalBytes });
        }
      }
      this.ensureDir(path.join(destMc, 'mods'));

      const launch = { ...src.launch };
      delete launch.javaPath;
      delete launch.customJvmArgs;
      const png = src.iconImage?.startsWith('data:image/png;base64,') ? Buffer.from(src.iconImage.split(',')[1], 'base64') : null;
      const customIcon = !!png?.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
      if (customIcon) fs.writeFileSync(path.join(work, ICON_FILE), png);
      this.writeNewInstance(work, { ...src, id: slug, icon: 'grass', customIcon, launch, importedFrom: src.path });
      fs.renameSync(work, destDir);
    } catch (e) {
      throw new Error(t('Не удалось скопировать «{name}»: {error}', { name: src.name, error: e.message }));
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }

    if (onProgress) onProgress({ copiedBytes: totalBytes, totalBytes });
    return this.readInstance(destDir);
  }

  /**
   * creates a new isolated Minecraft instance.
   */
  async createInstance(options, parentDir = this.instancesDir) {
    const {
      name = 'New Instance',
      version = '1.21.1',
      loader = 'vanilla',
      loaderVersion = '',
      versionId = version, // loader profile in versions/, installed by the caller
      icon = 'grass',
      launch = {}
    } = options;

    const safeSlug = (name.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase().slice(0, 48) || 'instance') + '_' + crypto.randomBytes(6).toString('hex');
    const instDir = path.join(parentDir, safeSlug);
    const mcDir = path.join(instDir, 'minecraft');
    const modsDir = path.join(mcDir, 'mods');

    this.ensureDir(modsDir);
    this.ensureDir(path.join(mcDir, 'saves'));
    this.ensureDir(path.join(mcDir, 'resourcepacks'));
    this.ensureDir(path.join(mcDir, 'shaderpacks'));

    const instData = {
      id: safeSlug,
      name: name,
      version: version,
      versionId: versionId,
      loader: loader,
      loaderVersion: loaderVersion,
      icon: icon,
      created: Date.now(),
      lastPlayed: null,
      totalPlaytime: 0
    };

    this.writeNewInstance(instDir, { ...instData, launch });

    return this.readInstance(instDir);
  }

  writeNewInstance(dir, inst) {
    const cfg = nativeConfig(writePrismLaunch(CFG_HEADER, cleanLaunch(inst.launch), true), inst);
    writeAtomic(path.join(dir, 'mmc-pack.json'), JSON.stringify(mmcPack(inst), null, 2));
    writeAtomic(path.join(dir, 'instance.cfg'), cfg);
  }

  /**
   * copies/duplicates an existing instance.
   */
  copyInstance(instanceId, newName) {
    const instances = this.listInstances();
    const source = instances.find(i => i.id === instanceId);
    if (!source) throw new Error(t('Сборка не найдена'));

    const safeSlug = (newName.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase() || 'instance') + '_' + Date.now().toString(36);
    const destDir = path.join(this.instancesDir, safeSlug);

    fs.cpSync(source.path, destDir, { recursive: true });

    try {
      this.migrateLegacyInstance(destDir);
      const file = path.join(destDir, 'instance.cfg');
      const cfg = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : CFG_HEADER;
      writeAtomic(file, nativeConfig(cfg, {
        ...source,
        id: safeSlug,
        name: newName,
        created: Date.now(),
        lastPlayed: null,
        totalPlaytime: 0,
        customIcon: fs.existsSync(path.join(destDir, ICON_FILE))
      }));
      if (!fs.existsSync(path.join(destDir, 'mmc-pack.json'))) {
        writeAtomic(path.join(destDir, 'mmc-pack.json'), JSON.stringify(mmcPack(source), null, 2));
      }
    } catch (e) {
      fs.rmSync(destDir, { recursive: true, force: true });
      throw e;
    }
    return this.readInstance(destDir);
  }

  /**
   * deletes an instance.
   */
  deleteInstance(instanceId) {
    const instances = this.listInstances();
    const target = instances.find(i => i.id === instanceId);
    if (!target) return false;
    if (target.isPrism) {
      throw new Error(t('Удалите сборку в исходном лаунчере'));
    }

    if (fs.existsSync(target.path)) {
      fs.rmSync(target.path, { recursive: true, force: true });
      return true;
    }
    return false;
  }

  /**
   * sets the build icon. choice: { block: '<block name>' } | { png: Buffer } | null (back to the automatic one).
   * prism instances only take an image: it goes to Prism's icons folder so Prism shows it too.
   */
  setInstanceIcon(instanceId, choice) {
    const target = this.listInstances().find(i => i.id === instanceId);
    if (!target) throw new Error(t('Сборка не найдена'));

    if (target.isPrism) {
      if (choice && !choice.png) throw new Error(t('Для внешней сборки можно выбрать только картинку'));
      const key = 'aetermc_' + (target.id.startsWith('prism-') ? path.basename(target.path) : target.id).replace(/[^a-zA-Z0-9_-]/g, '_');
      const own = prismIconFile(key, target.externalIconsDir);
      const iconPath = path.join(target.externalIconsDir, key + '.png');
      if (choice) {
        this.ensureDir(target.externalIconsDir);
        writeAtomic(iconPath, choice.png);
      }
      this.updateInstanceCfg(target, cfg => setCfgValue(cfg, 'iconKey', choice ? key : 'default'));
      if (own && (!choice || pathKey(own) !== pathKey(iconPath))) fs.rmSync(own, { force: true });
      return this.rereadInstance(target);
    }

    this.migrateLegacyInstance(target.path);
    const iconPath = path.join(target.path, ICON_FILE);
    if (choice?.png) fs.writeFileSync(iconPath, choice.png);
    else fs.rmSync(iconPath, { force: true });
    this.updateInstanceCfg(target, cfg => {
      cfg = setCfgValue(cfg, 'iconKey', choice?.png ? 'icon' : 'default');
      return setCfgValue(cfg, 'aetermc_iconBlock', choice?.block || '');
    });
    return this.rereadInstance(target);
  }

  /** renames a build (the folder stays); a Prism build is renamed in Prism too. */
  renameInstance(instanceId, name) {
    const target = this.listInstances().find(i => i.id === instanceId);
    if (!target) throw new Error(t('Сборка не найдена'));
    const clean = String(name || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 64);
    if (!clean) throw new Error(t('Введите название сборки'));
    this.updateInstanceCfg(target, cfg => setCfgValue(cfg, 'name', clean));
    return this.rereadInstance(target);
  }

  /**
   * sets the loader version of a build; the new loader is installed on the next launch.
   * prism builds get it in mmc-pack.json, so Prism uses the same version.
   */
  setLoaderVersion(instanceId, version) {
    const target = this.listInstances().find(i => i.id === instanceId);
    if (!target) throw new Error(t('Сборка не найдена'));
    if (!version || target.loader === 'vanilla') throw new Error(t('У сборки нет загрузчика'));
    if (!target.isPrism) this.migrateLegacyInstance(target.path);
    const packPath = path.join(target.path, 'mmc-pack.json');
    const pack = JSON.parse(target.isPrism ? readSmallText(packPath) : fs.readFileSync(packPath, 'utf-8'));
    const comp = (pack.components || []).find(c => c.uid === LOADER_COMPONENTS[target.loader].uid);
    if (!comp) throw new Error(t('В сборке не найден загрузчик'));
    comp.version = version;
    comp.cachedVersion = version;
    writeAtomic(packPath, JSON.stringify(pack, null, 2));
    if (!target.isPrism) this.updateInstanceCfg(target, cfg => setCfgValue(cfg, 'aetermc_versionId', ''));
    return this.rereadInstance(target);
  }

  /** saves a build's own launch settings (see LAUNCH_KEYS); {} goes back to the launcher settings. */
  setLaunchSettings(instanceId, launch) {
    const target = this.listInstances().find(i => i.id === instanceId);
    if (!target) throw new Error(t('Сборка не найдена'));
    this.updateInstanceCfg(target, cfg => writePrismLaunch(cfg, cleanLaunch(launch), !target.isPrism));
    return this.rereadInstance(target);
  }

  /**
   * records the launch time as soon as the game has started, not when it closes:
   * otherwise a running build still shows its previous launch.
   */
  markLaunched(instanceId) {
    const target = this.listInstances().find(i => i.id === instanceId);
    if (!target) return;

    try {
      this.updateInstanceCfg(target, cfg => setCfgValue(cfg, 'lastLaunchTime', Date.now()));
    } catch (e) {
      console.error('[Instances] Could not record the launch:', e.message);
    }
  }

  /** updates playtime for an instance. */
  updatePlaytime(instanceId, seconds) {
    const target = this.listInstances().find(i => i.id === instanceId);
    if (!target) return;
    try {
      this.updateInstanceCfg(target, cfg => {
        cfg = setCfgValue(cfg, 'totalTimePlayed', (target.totalPlaytime || 0) + seconds);
        return setCfgValue(cfg, 'lastTimePlayed', seconds);
      });
    } catch (e) {
      console.error('[Instances] Could not record playtime:', e.message);
    }
  }

  /**
   * folder of a build's mods, resource packs or shaders (kind, see content-types.js),
   * and the full path of one of its entries; a name that leads out of the folder is refused.
   */
  contentPath(instanceId, kind, fileName = null) {
    const target = this.listInstances().find(i => i.id === instanceId);
    if (!target) throw new Error(t('Сборка не найдена'));
    const dir = contentDir(target, kind);
    if (fileName === null) return { dir };
    if (typeof fileName !== 'string' || !fileName || path.basename(fileName) !== fileName || fileName === '..') {
      throw new Error(t('Некорректное имя файла'));
    }
    return { dir, full: path.join(dir, fileName) };
  }

  /**
   * lists mods (or resource packs / shaders) inside an instance.
   */
  listInstanceMods(instanceId, kind = 'mod') {
    const type = contentType(kind);
    const { dir } = this.contentPath(instanceId, kind);
    if (!fs.existsSync(dir)) return [];

    const list = [];
    try {
      for (const file of fs.readdirSync(dir)) {
        const full = path.join(dir, file);
        const stat = fs.statSync(full);
        const isDir = stat.isDirectory();
        if (isDir ? !type.folders : !(stat.isFile() && type.file.test(file))) continue;
        list.push({
          fileName: file,
          fullPath: full,
          isDir,
          enabled: !file.toLowerCase().endsWith('.disabled'),
          sizeBytes: isDir ? 0 : stat.size
        });
      }
    } catch (e) {}

    return list;
  }

  /**
   * toggles a mod in an instance: a switched-off file (or unpacked pack) gets ".disabled" at the end.
   */
  toggleInstanceMod(instanceId, fileName, enable, kind = 'mod') {
    const { dir, full: currPath } = this.contentPath(instanceId, kind, fileName);
    if (!fs.existsSync(currPath)) throw new Error(t('Мод не найден'));

    const base = fileName.replace(/\.disabled$/i, '');
    const newName = enable ? base : `${base}.disabled`;
    fs.renameSync(currPath, path.join(dir, newName));
    return { oldName: fileName, newName, enabled: enable };
  }

  /**
   * adds a mod (or resource pack / shader file) to an instance.
   */
  addModToInstance(instanceId, sourceFilePath, kind = 'mod') {
    const type = contentType(kind);
    const fileName = path.basename(sourceFilePath);
    if (!type.file.test(fileName)) throw new Error(t('Сюда подходят только файлы {ext}', { ext: type.ext }));
    const { dir, full: dest } = this.contentPath(instanceId, kind, fileName);

    this.ensureDir(dir);
    fs.copyFileSync(sourceFilePath, dest);
    return { fileName, dest };
  }

  /**
   * deletes a mod (or resource pack / shader, also an unpacked one) from an instance.
   */
  deleteInstanceMod(instanceId, fileName, kind = 'mod') {
    const { full } = this.contentPath(instanceId, kind, fileName);
    if (!fs.existsSync(full)) return false;
    fs.rmSync(full, { recursive: true, force: true });
    return true;
  }
}

module.exports = {
  LAUNCH_KEYS,
  resolveLaunchSettings,
  writePrismLaunch,
  prismLaunch,
  prismComponents,
  mmcPack,
  cfgValue,
  setCfgValue,
  cleanLaunch,
  InstancesManager,
  collectFiles
};
