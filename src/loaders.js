/**
 * loaders.js
 * Mod loaders (Fabric, Quilt, Forge, NeoForge): which versions exist for a Minecraft version,
 * and installing one as a profile in versions/ that MCLC can launch.
 *
 * Forge and NeoForge ship an installer jar. Its libraries are downloaded here and its
 * processors (they patch the Minecraft jar) are run with Java, the same steps the official
 * installer takes, just without its window.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const axios = require('axios');
const AdmZip = require('adm-zip');
const { t } = require('./i18n/i18n');

const LOADER_NAMES = { fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge' };

const FABRIC_META = 'https://meta.fabricmc.net/v2/versions/loader/';
const QUILT_META = 'https://meta.quiltmc.org/v3/versions/loader/';
const FORGE_MAVEN = 'https://maven.minecraftforge.net/net/minecraftforge/forge/';
const FORGE_PROMOTIONS = 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json';
const NEOFORGE_MAVEN = 'https://maven.neoforged.net/releases/net/neoforged/neoforge/';
const NEOFORGE_VERSIONS = 'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge';
const MOJANG_LIBRARIES = 'https://libraries.minecraft.net/';

const LIST_FRESH_MS = 10 * 60 * 1000;
const DOWNLOAD_THREADS = 8;

function splitPre(version) {
  const i = version.indexOf('-');
  return i < 0 ? [version, ''] : [version.slice(0, i), version.slice(i + 1)];
}

/** "0.20.0-beta.9" < "0.20.0" < "0.20.1": numbers part by part, a release above its pre-releases. */
function compareVersions(a, b) {
  const [aMain, aPre] = splitPre(a);
  const [bMain, bPre] = splitPre(b);
  const an = aMain.split('.');
  const bn = bMain.split('.');
  for (let i = 0; i < Math.max(an.length, bn.length); i++) {
    const diff = (parseInt(an[i], 10) || 0) - (parseInt(bn[i], 10) || 0);
    if (diff) return diff;
  }
  if (aPre === bPre) return 0;
  if (!aPre) return 1;
  if (!bPre) return -1;
  return aPre.localeCompare(bPre, 'en', { numeric: true });
}

const newestFirst = (list) => [...list].sort((a, b) => compareVersions(b, a));

/** NeoForge numbers follow Minecraft: 21.1.77 -> 1.21.1, 21.0.5 -> 1.21, 26.1.2.40 -> 26.1.2, 26.3.0.95 -> 26.3 */
function neoforgeMinecraft(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) return null;
  const [major, minor, third] = m.slice(1).map(Number);
  if (major >= 26) return third ? `${major}.${minor}.${third}` : `${major}.${minor}`;
  if (major < 20) return null;
  return minor ? `1.${major}.${minor}` : `1.${major}`;
}

/** "group:artifact:version[:classifier][@ext]" -> "group/path/artifact/version/artifact-version[-classifier].ext" */
function mavenPath(coord) {
  const [spec, ext = 'jar'] = coord.split('@');
  const [group, artifact, version, classifier] = spec.split(':');
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${artifact}-${version}${classifier ? `-${classifier}` : ''}.${ext}`;
}

/** Where a library goes in libraries/ and where to get it. Old profiles give only a name and a maven base URL. */
function libraryFile(lib) {
  const artifact = lib.downloads && lib.downloads.artifact;
  if (artifact && artifact.path) return { path: artifact.path, url: artifact.url || '', sha1: artifact.sha1 || null };
  const rel = mavenPath(lib.name);
  const base = lib.url || MOJANG_LIBRARIES;
  return { path: rel, url: `${base.endsWith('/') ? base : base + '/'}${rel}`, sha1: null };
}

function sha1File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    fs.createReadStream(file)
      .on('error', reject)
      .on('data', chunk => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/** The file is there and, when a hash is known, has that hash. */
async function fileMatches(file, sha1) {
  if (!fs.existsSync(file)) return false;
  if (!sha1) return true;
  try {
    return (await sha1File(file)) === sha1;
  } catch (e) {
    return false;
  }
}

async function downloadOnce(url, dest, sha1) {
  const part = `${dest}.part`;
  const res = await axios.get(url, { responseType: 'stream', timeout: 30000 });
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(part);
    res.data.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    res.data.pipe(out);
  });
  if (sha1 && (await sha1File(part)) !== sha1) {
    fs.rmSync(part, { force: true });
    throw new Error(t('Файл скачался с ошибкой: {file}', { file: path.basename(dest) }));
  }
  fs.renameSync(part, dest);
}

/** Downloads with two more tries on network errors; a missing file (4xx) fails at once. */
async function download(url, dest, sha1 = null) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  for (let attempt = 1; ; attempt++) {
    try {
      return await downloadOnce(url, dest, sha1);
    } catch (e) {
      const status = e.response && e.response.status;
      if (attempt >= 3 || (status >= 400 && status < 500)) throw e;
    }
  }
}

async function forEachLimit(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function jarMainClass(jar) {
  const manifest = new AdmZip(jar).readAsText('META-INF/MANIFEST.MF');
  const m = /^Main-Class:\s*(.+?)\s*$/m.exec(manifest);
  return m ? m[1] : null;
}

/** Runs Java and rejects with the last lines of its output when it fails. */
function runJava(java, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(java, args, { cwd, windowsHide: true });
    const tail = [];
    const collect = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line.trim()) continue;
        tail.push(line.trim());
        if (tail.length > 5) tail.shift();
      }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(t('код {code}', { code }) + (tail.length ? `: ${tail.slice(-2).join(' ')}` : '')));
    });
  });
}

class LoaderManager {
  constructor(versionManager) {
    this.versionManager = versionManager;
    this.lists = new Map(); // url -> { time, data }
  }

  get root() {
    return this.versionManager.gameDir;
  }

  static label(loader) {
    return LOADER_NAMES[loader] || loader;
  }

  /** GET with a short memory cache; an old copy is used when the network is down. */
  async fetchList(url, options = {}) {
    const hit = this.lists.get(url);
    if (hit && Date.now() - hit.time < LIST_FRESH_MS) return hit.data;
    try {
      const res = await axios.get(url, { timeout: 15000, ...options });
      this.lists.set(url, { time: Date.now(), data: res.data });
      return res.data;
    } catch (e) {
      // the meta servers answer 400/404 for Minecraft versions they do not know
      if (e.response && (e.response.status === 400 || e.response.status === 404)) return null;
      if (hit) return hit.data;
      throw e;
    }
  }

  /** { versions: newest first, recommended } for one loader and Minecraft version. */
  async versionsOf(loader, gameVersion) {
    switch (loader) {
      case 'fabric': {
        const data = await this.fetchList(FABRIC_META + encodeURIComponent(gameVersion)) || [];
        const stable = data.find(e => e.loader.stable);
        return { versions: data.map(e => e.loader.version), recommended: stable ? stable.loader.version : null };
      }
      case 'quilt': {
        const data = await this.fetchList(QUILT_META + encodeURIComponent(gameVersion)) || [];
        const versions = newestFirst(data.map(e => e.loader.version));
        return { versions, recommended: versions.find(v => !v.includes('-')) || null };
      }
      case 'forge': {
        const xml = String(await this.fetchList(FORGE_MAVEN + 'maven-metadata.xml', { responseType: 'text' }) || '');
        const prefix = `${gameVersion}-`;
        const versions = newestFirst([...xml.matchAll(/<version>([^<]+)<\/version>/g)]
          .map(m => m[1])
          .filter(v => v.startsWith(prefix))
          .map(v => v.slice(prefix.length)));
        let recommended = null;
        if (versions.length) {
          try {
            const promos = (await this.fetchList(FORGE_PROMOTIONS) || {}).promos || {};
            const promo = promos[`${gameVersion}-recommended`];
            // promotions leave out the "-1.7.10" ending of old versions
            if (promo) recommended = versions.find(v => v === promo || v.startsWith(`${promo}-`)) || null;
          } catch (e) {}
        }
        return { versions, recommended };
      }
      case 'neoforge': {
        const data = await this.fetchList(NEOFORGE_VERSIONS) || {};
        // alpha builds are for snapshots of the next version
        const versions = newestFirst((data.versions || [])
          .filter(v => !/alpha|snapshot/i.test(v) && neoforgeMinecraft(v) === gameVersion));
        return { versions, recommended: versions.find(v => !v.includes('-')) || null };
      }
      default:
        throw new Error(t('Неизвестный загрузчик: {loader}', { loader }));
    }
  }

  /** Versions for the new build dialog: [{ version, recommended }], newest first. */
  async listVersions(loader, gameVersion) {
    const { versions, recommended } = await this.versionsOf(loader, gameVersion);
    return versions.map(version => ({ version, recommended: version === recommended }));
  }

  profileExists(id) {
    return !!id && fs.existsSync(path.join(this.root, 'versions', id, `${id}.json`));
  }

  /** Id of an installed profile for this loader version, or null. */
  findInstalled(loader, gameVersion, loaderVersion, knownId = null) {
    const candidates = {
      fabric: [`fabric-loader-${loaderVersion}-${gameVersion}`],
      quilt: [`quilt-loader-${loaderVersion}-${gameVersion}`],
      neoforge: [`neoforge-${loaderVersion}`],
      // modern ids, then old ones like "1.7.10-Forge10.13.4.1614-1.7.10"
      forge: [`${gameVersion}-forge-${loaderVersion}`, `${gameVersion}-Forge${loaderVersion}`, `${gameVersion}-Forge${loaderVersion}-${gameVersion}`]
    }[loader] || [];
    if (knownId && knownId.includes(loaderVersion)) candidates.unshift(knownId);
    return candidates.find(id => this.profileExists(id)) || null;
  }

  /**
   * Makes sure the loader profile is in versions/ and returns { id, loaderVersion }.
   * An installed profile is used as is, so launching works offline.
   */
  async ensure(loader, gameVersion, loaderVersion, options = {}) {
    const id = loaderVersion && this.findInstalled(loader, gameVersion, loaderVersion, options.knownId);
    if (id) return { id, loaderVersion };
    return this.install(loader, gameVersion, loaderVersion, options);
  }

  /**
   * Installs a loader version (the recommended one when none is given).
   * options.onStatus(text, { progress }) reports progress (progress: a counter repeated many times), options.getJava() gives Java for the Forge/NeoForge processors.
   */
  async install(loader, gameVersion, loaderVersion, options = {}) {
    const name = LoaderManager.label(loader);
    if (!LOADER_NAMES[loader]) throw new Error(t('Неизвестный загрузчик: {loader}', { loader }));
    if (!loaderVersion) {
      const { versions, recommended } = await this.versionsOf(loader, gameVersion);
      loaderVersion = recommended || versions[0];
      if (!loaderVersion) throw new Error(t('{loader} нет для Minecraft {version}', { loader: name, version: gameVersion }));
    }

    switch (loader) {
      case 'fabric': {
        const res = await this.versionManager.installFabric(gameVersion, loaderVersion);
        return { id: res.id, loaderVersion: res.loaderVersion };
      }
      case 'quilt':
        return this.installQuilt(gameVersion, loaderVersion);
      default:
        return this.installFromInstaller(loader, gameVersion, loaderVersion, options);
    }
  }

  writeProfile(id, json) {
    const dir = path.join(this.root, 'versions', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(json, null, 2), 'utf-8');
  }

  async installQuilt(gameVersion, loaderVersion) {
    const url = `${QUILT_META}${encodeURIComponent(gameVersion)}/${encodeURIComponent(loaderVersion)}/profile/json`;
    const res = await axios.get(url, { timeout: 15000 });
    this.writeProfile(res.data.id, res.data);
    return { id: res.data.id, loaderVersion };
  }

  /** Full Forge maven version: "1.20.1-47.3.0", or "1.7.10-10.13.4.1614-1.7.10" for old ones. */
  async forgeMavenVersion(gameVersion, loaderVersion) {
    try {
      const { versions } = await this.versionsOf('forge', gameVersion);
      if (!versions.includes(loaderVersion)) {
        // Prism stores old versions without the "-1.7.10" ending
        const full = versions.find(v => v.startsWith(`${loaderVersion}-`));
        if (full) return `${gameVersion}-${full}`;
      }
    } catch (e) {}
    return `${gameVersion}-${loaderVersion}`;
  }

  /** versions/<mc>/<mc>.jar and its json: the processors patch this jar. */
  async ensureClientJar(mcVersion) {
    const dir = path.join(this.root, 'versions', mcVersion);
    let meta = this.versionManager.readLocalVersionJson(mcVersion);
    if (!meta || !meta.downloads || !meta.downloads.client) {
      const manifest = await this.versionManager.getMojangManifest();
      const entry = manifest.versions.find(v => v.id === mcVersion);
      if (!entry) throw new Error(t('Minecraft {version} нет в списке версий', { version: mcVersion }));
      meta = (await axios.get(entry.url, { timeout: 15000 })).data;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${mcVersion}.json`), JSON.stringify(meta, null, 2), 'utf-8');
    }
    const jar = path.join(dir, `${mcVersion}.jar`);
    const client = meta.downloads.client;
    if (!(await fileMatches(jar, client.sha1))) await download(client.url, jar, client.sha1);
    return jar;
  }

  /**
   * Libraries from the profile: bundled in the installer (maven/...), downloaded, or,
   * without a URL, made later by the processors.
   */
  async fetchLibraries(libs, zip, onProgress) {
    const libDir = path.join(this.root, 'libraries');
    const seen = new Set();
    const files = libs.map(libraryFile).filter(f => !seen.has(f.path) && seen.add(f.path));
    let done = 0;
    await forEachLimit(files, DOWNLOAD_THREADS, async ({ path: rel, url, sha1 }) => {
      const file = path.join(libDir, rel);
      if (!(await fileMatches(file, sha1))) {
        const bundled = zip.getEntry(`maven/${rel}`);
        if (bundled) {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, bundled.getData());
        } else if (url) {
          try {
            await download(url, file, sha1);
          } catch (e) {
            throw new Error(t('Не удалось скачать {file}: {error}', { file: path.basename(rel), error: e.message }));
          }
        }
      }
      onProgress(++done, files.length);
    });
  }

  async installFromInstaller(loader, gameVersion, loaderVersion, { onStatus = () => {}, getJava } = {}) {
    const name = LoaderManager.label(loader);
    const coord = loader === 'forge' ? await this.forgeMavenVersion(gameVersion, loaderVersion) : loaderVersion;
    const url = loader === 'forge'
      ? `${FORGE_MAVEN}${coord}/forge-${coord}-installer.jar`
      : `${NEOFORGE_MAVEN}${coord}/neoforge-${coord}-installer.jar`;

    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aetermc-loader-'));
    try {
      onStatus(t('Скачивание установщика {loader} {version}…', { loader: name, version: loaderVersion }));
      const installer = path.join(work, 'installer.jar');
      try {
        await download(url, installer);
      } catch (e) {
        if (e.response && e.response.status === 404) throw new Error(t('{loader} {version} для Minecraft {mc} не найден', { loader: name, version: loaderVersion, mc: gameVersion }));
        throw e;
      }

      const zip = new AdmZip(installer);
      const readJson = (entry) => {
        try {
          return JSON.parse(zip.readAsText(entry));
        } catch (e) {
          throw new Error(t('Установщик {loader} повреждён ({file})', { loader: name, file: entry }));
        }
      };
      const profile = readJson('install_profile.json');

      // Old Forge installers (up to 1.12.2): the profile and the Forge jar sit right in the installer
      if (profile.install && profile.versionInfo) {
        return await this.installLegacyForge(zip, profile, loaderVersion, onStatus);
      }

      const versionJson = readJson((profile.json || '/version.json').replace(/^\//, ''));
      const id = versionJson.id;
      const mcVersion = profile.minecraft || gameVersion;
      const libDir = path.join(this.root, 'libraries');

      onStatus(t('Скачивание Minecraft {version}…', { version: mcVersion }));
      const clientJar = await this.ensureClientJar(mcVersion);

      const libs = [...(profile.libraries || []), ...(versionJson.libraries || [])];
      // the loader's own jar, only ever taken from the installer
      if (profile.path) libs.push({ name: profile.path, downloads: { artifact: { path: mavenPath(profile.path), url: '' } } });
      await this.fetchLibraries(libs, zip, (done, total) => onStatus(t('Библиотеки {loader}: {n} из {total}', { loader: name, n: done, total }), { progress: true }));

      // Values the processor arguments refer to as {KEY}
      const data = {
        SIDE: 'client',
        MINECRAFT_JAR: clientJar,
        MINECRAFT_VERSION: mcVersion,
        ROOT: this.root,
        INSTALLER: installer,
        LIBRARY_DIR: libDir
      };
      for (const [key, value] of Object.entries(profile.data || {})) {
        const v = String(value.client);
        if (/^\[.+\]$/.test(v)) {
          data[key] = path.join(libDir, mavenPath(v.slice(1, -1)));
        } else if (/^'.*'$/.test(v)) {
          data[key] = v.slice(1, -1);
        } else {
          // a file inside the installer, e.g. /data/client.lzma
          const entryName = v.replace(/^\//, '');
          const entry = zip.getEntry(entryName);
          if (!entry) throw new Error(t('Установщик {loader} повреждён ({file})', { loader: name, file: entryName }));
          const out = path.join(work, entryName);
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.writeFileSync(out, entry.getData());
          data[key] = out;
        }
      }
      const fill = (arg) => {
        if (/^\[.+\]$/.test(arg)) return path.join(libDir, mavenPath(arg.slice(1, -1)));
        if (/^'.*'$/.test(arg)) return arg.slice(1, -1);
        return arg.replace(/\{(\w+)\}/g, (match, key) => {
          if (!(key in data)) throw new Error(t('Установщик {loader}: неизвестный параметр {key}', { loader: name, key }));
          return data[key];
        });
      };

      const processors = (profile.processors || []).filter(p => !p.sides || p.sides.includes('client'));
      const java = processors.length ? await getJava() : null;
      for (const [i, proc] of processors.entries()) {
        onStatus(t('Установка {loader}: шаг {n} из {total}…', { loader: name, n: i + 1, total: processors.length }));
        const outputs = Object.entries(proc.outputs || {}).map(([file, sha1]) => [fill(file), fill(sha1)]);
        const matches = async () => (await Promise.all(outputs.map(([file, sha1]) => fileMatches(file, sha1)))).every(Boolean);
        if (outputs.length && (await matches())) continue;

        const jar = path.join(libDir, mavenPath(proc.jar));
        const mainClass = fs.existsSync(jar) ? jarMainClass(jar) : null;
        if (!mainClass) throw new Error(t('Установщик {loader}: не найден {file}', { loader: name, file: path.basename(jar) }));
        const classpath = [jar, ...(proc.classpath || []).map(c => path.join(libDir, mavenPath(c)))].join(path.delimiter);
        try {
          await runJava(java, ['-cp', classpath, mainClass, ...proc.args.map(fill)], work);
        } catch (e) {
          throw new Error(t('Установка {loader} не удалась на шаге {n}: {error}', { loader: name, n: i + 1, error: e.message }));
        }
        if (outputs.length && !(await matches())) {
          throw new Error(t('Установка {loader} не удалась на шаге {n}: файлы не совпали', { loader: name, n: i + 1 }));
        }
      }

      this.finishProfile(id, versionJson, clientJar);
      return { id, loaderVersion };
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }

  async installLegacyForge(zip, profile, loaderVersion, onStatus) {
    const { install, versionInfo } = profile;
    onStatus(t('Скачивание Minecraft {version}…', { version: install.minecraft }));
    const clientJar = await this.ensureClientJar(install.minecraft);

    const entry = zip.getEntry(install.filePath);
    if (!entry) throw new Error(t('Установщик {loader} повреждён ({file})', { loader: 'Forge', file: install.filePath }));
    const forgeJar = path.join(this.root, 'libraries', mavenPath(install.path));
    fs.mkdirSync(path.dirname(forgeJar), { recursive: true });
    fs.writeFileSync(forgeJar, entry.getData());

    const libs = versionInfo.libraries.filter(lib => lib.name !== install.path);
    await this.fetchLibraries(libs, zip, (done, total) => onStatus(t('Библиотеки {loader}: {n} из {total}', { loader: 'Forge', n: done, total }), { progress: true }));

    this.finishProfile(versionInfo.id, versionInfo, clientJar);
    return { id: versionInfo.id, loaderVersion };
  }

  /**
   * MCLC puts versions/<id>/<id>.jar on the classpath and downloads it again when it is missing.
   * The json is written last: a profile in versions/ means the install finished.
   */
  finishProfile(id, json, clientJar) {
    const dir = path.join(this.root, 'versions', id);
    fs.mkdirSync(dir, { recursive: true });
    const jar = path.join(dir, `${id}.jar`);
    if (!fs.existsSync(jar)) fs.copyFileSync(clientJar, jar);
    this.writeProfile(id, json);
  }

  /**
   * JVM arguments a loader profile needs (module path, --add-opens, ...).
   * MCLC does not read them from the profile, so they are passed as extra arguments.
   */
  jvmArgs(id) {
    const meta = this.versionManager.readLocalVersionJson(id);
    if (!meta || !meta.inheritsFrom || !meta.arguments || !Array.isArray(meta.arguments.jvm)) return [];
    const libDir = path.join(this.root, 'libraries');
    return meta.arguments.jvm
      .filter(arg => typeof arg === 'string')
      .map(arg => arg
        .replace(/\$\{library_directory\}/g, libDir)
        .replace(/\$\{classpath_separator\}/g, path.delimiter)
        .replace(/\$\{version_name\}/g, id))
      .filter(arg => !arg.includes('${'));
  }
}

module.exports = {
  LoaderManager,
  compareVersions,
  neoforgeMinecraft
};
