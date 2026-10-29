/**
 * mrpack.js
 * Modrinth modpacks (.mrpack): importing one as a new build and exporting a build as one.
 *
 * An .mrpack is a zip with modrinth.index.json (the Minecraft and loader versions, and the files
 * to download with their hashes) and overrides/ (files copied as they are). On export, mods,
 * resource packs and shaders that Modrinth knows go into the index as links, so the pack stays small.
 * Format: https://support.modrinth.com/en/articles/8802351-modrinth-modpack-format-mrpack
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const AdmZip = require('adm-zip');
const { t } = require('./i18n/i18n');
const { collectFiles } = require('./instances-manager');
const { HEADERS } = require('./modrinth-manager');
const { LoaderManager } = require('./loaders');
const { CONTENT } = require('./content-types');

const INDEX_FILE = 'modrinth.index.json';
const DOWNLOAD_THREADS = 6;

// A build's loader and its key in the pack's dependencies; Quilt first, a Quilt pack may list Fabric too
const LOADER_KEYS = { quilt: 'quilt-loader', fabric: 'fabric-loader', neoforge: 'neoforge', forge: 'forge' };

// Files in the mods, resource pack and shader folders may be on Modrinth: those go into the index as links
const LINKED_FOLDERS = new Set(Object.values(CONTENT).map(c => c.folder));
const CLIENT_ONLY_FOLDERS = new Set([CONTENT.resourcepack.folder, CONTENT.shader.folder]);

// Not offered for export: made again by the game, personal, or the launcher's own
const EXPORT_HIDDEN = new Set([
  'logs', 'crash-reports', '.cache', 'debug', '.fabric', '.quilt', '.mixin.out', 'natives',
  'usercache.json', 'usernamecache.json', 'command_history.txt', 'realms_persistence.json', 'servers.dat_old',
  'instance.json', 'instance.cfg', 'mmc-pack.json', 'icon.png'
]);
// Offered, but off by default: worlds, personal settings, pictures
const EXPORT_OFF = new Set(['saves', 'screenshots', 'options.txt', 'servers.dat', 'backups', 'schematics']);

/** Full path of a pack path inside dir, or null when the path would lead out of it. */
function insideDir(dir, rel) {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) return null;
  const root = path.resolve(dir);
  const full = path.resolve(root, rel);
  return full.startsWith(root + path.sep) ? full : null;
}

function openZip(file) {
  try {
    return new AdmZip(file);
  } catch (e) {
    throw new Error(t('Не удалось открыть модпак: {error}', { error: e.message }));
  }
}

function readIndex(zip) {
  let index;
  try {
    index = JSON.parse(zip.readAsText(INDEX_FILE));
  } catch (e) {
    throw new Error(t('Это не модпак Modrinth: в архиве нет {file}', { file: INDEX_FILE }));
  }
  if (!index || index.game !== 'minecraft' || !index.dependencies || !index.dependencies.minecraft) {
    throw new Error(t('Модпак повреждён: не указана версия Minecraft'));
  }
  if (index.formatVersion !== 1) {
    throw new Error(t('Модпак сделан в неизвестной версии формата ({version})', { version: index.formatVersion }));
  }
  return index;
}

/** { loader, loaderVersion } from the pack's dependencies. */
function packLoader(deps) {
  for (const [loader, key] of Object.entries(LOADER_KEYS)) {
    if (!deps[key]) continue;
    let version = String(deps[key]);
    // some packs give Forge as "1.20.1-47.3.0"
    if (version.startsWith(`${deps.minecraft}-`)) version = version.slice(deps.minecraft.length + 1);
    return { loader, loaderVersion: version };
  }
  return { loader: 'vanilla', loaderVersion: '' };
}

/** Files a client needs: server-only ones are left out. */
function clientFiles(index) {
  return (Array.isArray(index.files) ? index.files : []).filter(f => !(f.env && f.env.client === 'unsupported'));
}

/** Path of an entry inside the build when it is an override for the client, otherwise null. */
function overridePath(entryName) {
  for (const prefix of ['overrides/', 'client-overrides/']) {
    if (entryName.startsWith(prefix)) return entryName.slice(prefix.length);
  }
  return null;
}

/** Overrides of the pack, client-overrides last so they win over the shared ones. */
function overrideEntries(zip) {
  const entries = zip.getEntries().filter(e => !e.isDirectory && overridePath(e.entryName));
  return entries.sort((a, b) => a.entryName.startsWith('client-') - b.entryName.startsWith('client-'));
}

function describe(file, zip, index) {
  const files = clientFiles(index);
  return {
    name: String(index.name || path.basename(file, path.extname(file))),
    versionId: String(index.versionId || ''),
    summary: String(index.summary || ''),
    minecraft: String(index.dependencies.minecraft),
    ...packLoader(index.dependencies),
    downloadCount: files.length,
    downloadBytes: files.reduce((sum, f) => sum + (Number(f.fileSize) || 0), 0),
    overrideCount: overrideEntries(zip).length
  };
}

async function forEachLimit(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * Downloads one file of the pack, trying its links in turn, and checks its hash.
 * onBytes(n) reports received bytes; a failed attempt takes its bytes back.
 */
async function downloadPackFile(file, dest, onBytes) {
  const urls = (file.downloads || []).filter(u => /^https?:\/\//i.test(u));
  const hashes = file.hashes || {};
  const algo = hashes.sha512 ? 'sha512' : hashes.sha1 ? 'sha1' : null;
  if (!urls.length) throw new Error(t('У файла {file} нет ссылки на скачивание', { file: file.path }));
  if (!algo) throw new Error(t('У файла {file} нет контрольной суммы', { file: file.path }));

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  let lastError = null;
  for (const url of urls) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      let received = 0;
      try {
        const res = await axios.get(url, { responseType: 'stream', headers: HEADERS, timeout: 30000 });
        const hash = crypto.createHash(algo);
        await new Promise((resolve, reject) => {
          const out = fs.createWriteStream(part);
          res.data.on('data', (chunk) => {
            hash.update(chunk);
            received += chunk.length;
            onBytes(chunk.length);
          });
          res.data.on('error', reject);
          out.on('error', reject);
          out.on('finish', resolve);
          res.data.pipe(out);
        });
        if (hash.digest('hex') !== String(hashes[algo]).toLowerCase()) {
          throw new Error(t('Файл {file} скачался повреждённым, попробуйте ещё раз', { file: path.basename(dest) }));
        }
        fs.renameSync(part, dest);
        return;
      } catch (e) {
        onBytes(-received);
        fs.rmSync(part, { force: true });
        lastError = e;
        const status = e.response && e.response.status;
        if (status >= 400 && status < 500) break; // the next link, if there is one
      }
    }
  }
  throw new Error(t('Не удалось скачать {file}: {error}', { file: file.path, error: lastError.message }));
}

/** "required" / "optional" / "unsupported" from a Modrinth project side; unknown counts as required. */
function envSide(side) {
  return ['required', 'optional', 'unsupported'].includes(side) ? side : 'required';
}

class MrpackManager {
  constructor(instancesManager, loaderManager, modrinthManager) {
    this.instancesManager = instancesManager;
    this.loaderManager = loaderManager;
    this.modrinthManager = modrinthManager;
  }

  /** What a pack holds, for the import window, before anything is downloaded. */
  inspect(file) {
    const zip = openZip(file);
    return describe(file, zip, readIndex(zip));
  }

  /**
   * Makes a new build from a pack: installs the loader, downloads the files, unpacks the overrides.
   * onProgress({ text, done, total }): done/total in bytes while downloading, otherwise only text.
   * getJava(minecraftVersion) gives Java for the Forge/NeoForge installer. A failed import leaves no build behind.
   */
  async importPack(file, { name = '', onProgress = () => {}, getJava } = {}) {
    const zip = openZip(file);
    const index = readIndex(zip);
    const info = describe(file, zip, index);
    const files = clientFiles(index);

    // A broken or hostile path fails the import before anything is downloaded
    const probe = path.join(this.instancesManager.instancesDir, '_');
    for (const f of files) {
      if (!insideDir(probe, f.path)) throw new Error(t('Модпак повреждён: недопустимый путь {path}', { path: String(f.path) }));
    }
    for (const e of overrideEntries(zip)) {
      if (!insideDir(probe, overridePath(e.entryName))) throw new Error(t('Модпак повреждён: недопустимый путь {path}', { path: e.entryName }));
    }

    // The loader goes first, like for a new build: a failed install leaves nothing behind
    let { loaderVersion } = info;
    let versionId = info.minecraft;
    if (info.loader !== 'vanilla') {
      onProgress({ text: t('Установка {loader} {version}…', { loader: LoaderManager.label(info.loader), version: loaderVersion }) });
      const installed = await this.loaderManager.ensure(info.loader, info.minecraft, loaderVersion, {
        onStatus: (text) => onProgress({ text }),
        getJava: () => getJava(info.minecraft)
      });
      versionId = installed.id;
      loaderVersion = installed.loaderVersion;
    }

    const inst = await this.instancesManager.createInstance({
      name: name.trim() || info.name,
      version: info.minecraft,
      loader: info.loader,
      loaderVersion,
      versionId
    });
    try {
      await this.downloadFiles(files, inst.minecraftDir, onProgress);
      const overrides = overrideEntries(zip);
      overrides.forEach((entry, i) => {
        const dest = insideDir(inst.minecraftDir, overridePath(entry.entryName));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, entry.getData());
        if (i % 20 === 0) onProgress({ text: t('Распаковка файлов: {n} из {total}', { n: i + 1, total: overrides.length }) });
      });
    } catch (e) {
      fs.rmSync(inst.path, { recursive: true, force: true });
      throw e;
    }
    return this.instancesManager.readInstance(inst.path);
  }

  async downloadFiles(files, dir, onProgress) {
    const total = files.reduce((sum, f) => sum + (Number(f.fileSize) || 0), 0);
    let done = 0;
    let count = 0;
    let lastReport = 0;
    const report = (force = false) => {
      if (!force && Date.now() - lastReport < 150) return;
      lastReport = Date.now();
      onProgress({ text: t('Скачивание файлов: {n} из {total}', { n: count, total: files.length }), done, total });
    };
    report(true);
    await forEachLimit(files, DOWNLOAD_THREADS, async (f) => {
      await downloadPackFile(f, insideDir(dir, f.path), (bytes) => {
        done += bytes;
        report();
      });
      count++;
      report();
    });
  }

  /** Top-level files and folders of a build that can go into a pack: [{ name, isDir, sizeBytes, checked }] */
  listExportEntries(inst) {
    const root = inst.minecraftDir;
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (e) {
      return [];
    }
    const list = [];
    for (const e of entries) {
      if (EXPORT_HIDDEN.has(e.name) || !(e.isDirectory() || e.isFile())) continue;
      const full = path.join(root, e.name);
      let sizeBytes = 0;
      if (e.isDirectory()) {
        const files = collectFiles(full);
        if (!files.length) continue; // an empty folder adds nothing to the pack
        sizeBytes = files.reduce((sum, f) => sum + f.size, 0);
      } else {
        try {
          sizeBytes = fs.statSync(full).size;
        } catch (err) {
          continue;
        }
      }
      list.push({ name: e.name, isDir: e.isDirectory(), sizeBytes, checked: !EXPORT_OFF.has(e.name) });
    }
    return list.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));
  }

  /**
   * Writes the build as an .mrpack: files Modrinth knows as links, the rest into overrides/.
   * options: { name, version, include: [top-level names], file }
   * Returns { file, linked, packed, online }.
   */
  async exportPack(inst, { name, version, include = [], file }, onProgress = () => {}) {
    const loaderKey = LOADER_KEYS[inst.loader];
    if (loaderKey && !inst.loaderVersion) throw new Error(t('У сборки не указана версия загрузчика'));

    const root = inst.minecraftDir;
    const allowed = new Set(this.listExportEntries(inst).map(e => e.name));
    const files = [];
    for (const entry of include) {
      if (!allowed.has(entry)) continue;
      const full = path.join(root, entry);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) files.push(...collectFiles(full).map(f => ({ full: f.full, rel: path.join(entry, f.rel) })));
      else files.push({ full, rel: entry });
    }
    const packPath = (f) => f.rel.split(path.sep).join('/');
    const wanted = files.filter(f => !/\.(part|mcl-download)$/i.test(f.rel));

    // Mods, resource packs and shaders Modrinth knows by their hash
    onProgress({ text: t('Поиск файлов на Modrinth…') });
    const linkable = wanted.filter(f => LINKED_FOLDERS.has(packPath(f).split('/')[0]) && /\.(jar|zip)(\.disabled)?$/i.test(f.rel));
    const hashes = linkable.map(f => this.modrinthManager.sha1Of(f.full));
    let known = {};
    let projects = {};
    let online = true;
    try {
      known = await this.modrinthManager.identify(hashes);
      projects = await this.modrinthManager.getProjects(Object.values(known).map(v => v.project_id));
    } catch (e) {
      online = false; // everything is packed as files then
    }

    const indexFiles = [];
    const linked = new Set();
    linkable.forEach((f, i) => {
      const sha1 = hashes[i];
      const version = known[sha1];
      const remote = version && (version.files || []).find(x => x.hashes && x.hashes.sha1 === sha1);
      if (!remote || !remote.url || !remote.hashes.sha512) return;
      const rel = packPath(f);
      const project = projects[version.project_id] || {};
      indexFiles.push({
        path: rel,
        hashes: { sha1, sha512: remote.hashes.sha512 },
        // it is in a client build, so the client needs it; a switched-off mod is offered as optional
        env: {
          client: /\.disabled$/i.test(rel) ? 'optional' : 'required',
          server: CLIENT_ONLY_FOLDERS.has(rel.split('/')[0]) ? 'unsupported' : envSide(project.server_side)
        },
        downloads: [remote.url],
        fileSize: remote.size
      });
      linked.add(f.full);
    });

    const index = {
      formatVersion: 1,
      game: 'minecraft',
      versionId: String(version || '1.0.0'),
      name: String(name || inst.name),
      files: indexFiles,
      dependencies: { minecraft: inst.version, ...(loaderKey ? { [loaderKey]: inst.loaderVersion } : {}) }
    };

    const zip = new AdmZip();
    zip.addFile(INDEX_FILE, Buffer.from(JSON.stringify(index, null, 2), 'utf-8'));
    const packed = wanted.filter(f => !linked.has(f.full));
    packed.forEach((f, i) => {
      zip.addFile(`overrides/${packPath(f)}`, fs.readFileSync(f.full));
      if (i % 20 === 0) onProgress({ text: t('Упаковка файлов: {n} из {total}', { n: i + 1, total: packed.length }) });
    });

    onProgress({ text: t('Запись модпака…') });
    // written next to it and swapped in, so a failed export does not leave half a file
    const part = `${file}.part`;
    try {
      await zip.writeZipPromise(part);
      fs.renameSync(part, file);
    } catch (e) {
      fs.rmSync(part, { force: true });
      throw new Error(t('Не удалось записать модпак: {error}', { error: e.message }));
    }
    return { file, linked: indexFiles.length, packed: packed.length, online };
  }
}

module.exports = {
  MrpackManager,
  insideDir,
  packLoader
};
