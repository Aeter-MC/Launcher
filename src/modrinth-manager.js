/**
 * modrinth-manager.js
 * Modrinth API integration: search, install into a build, recognise installed mods by file hash
 * and look for updates that match the build's Minecraft version and loader.
 * The same works for resource packs and shaders: `kind` is one of content-types.js ('mod' by default).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { t } = require('./i18n/i18n');
const { contentType } = require('./content-types');

const MODRINTH_API = 'https://api.modrinth.com/v2';
const USER_AGENT = 'AeterMC/1.0.0 (contact@waruk.dev)';
const HEADERS = { 'User-Agent': USER_AGENT };
const SCAN_CACHE_MS = 10 * 60 * 1000;
const PROJECT_INFO_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Loaders a version has to list to fit the build. Resource packs all say "minecraft", so any fits;
 * shaders run on Iris (Oculus on Forge) or OptiFine, and most packs list both.
 */
function loaderList(loader, kind = 'mod') {
  if (kind === 'resourcepack') return [];
  if (kind === 'shader') return ['iris', 'optifine'];
  if (!loader || loader === 'vanilla') return [];
  return loader === 'quilt' ? ['quilt', 'fabric'] : [loader.toLowerCase()];
}

/** A version fits the build only if it lists the exact Minecraft version and a matching loader. */
function isCompatible(version, gameVersion, loader, kind = 'mod') {
  if (!version) return false;
  const loaders = loaderList(loader, kind);
  return (version.game_versions || []).includes(gameVersion)
    && (!loaders.length || (version.loaders || []).some(l => loaders.includes(l)));
}

function primaryFile(version) {
  return (version.files || []).find(f => f.primary) || (version.files || [])[0] || null;
}

class ModrinthManager {
  constructor(cache = null) {
    this.cache = cache;
    const saved = (cache && cache.read('modrinth')) || {};
    this.hashCache = new Map(Object.entries(saved.hashes || {})); // fullPath -> { size, mtimeMs, sha1 }
    this.projectCache = new Map(Object.entries(saved.projects || {})); // projectId -> { time, title, slug, icon_url }
    this.scanCache = new Map(); // key -> { time, signature, result }
  }

  persist() {
    if (!this.cache) return;
    this.cache.writeLater('modrinth', () => ({
      hashes: Object.fromEntries(this.hashCache),
      projects: Object.fromEntries(this.projectCache)
    }));
  }

  async searchMods(options = {}) {
    const { query = '', gameVersion = '', loader = '', category = '', limit = 20, offset = 0, sortBy = 'relevance', kind = 'mod' } = options;

    const facets = [[`project_type:${contentType(kind).projectType}`]];
    if (gameVersion) facets.push([`versions:${gameVersion}`]);
    const loaders = loaderList(loader, kind);
    if (loaders.length) facets.push(loaders.map(l => `categories:${l}`));
    if (category) facets.push([`categories:${category.toLowerCase()}`]);

    try {
      const response = await axios.get(`${MODRINTH_API}/search`, {
        params: { query, limit, offset, index: sortBy, facets: JSON.stringify(facets) },
        headers: HEADERS,
        timeout: 10000
      });
      return {
        hits: response.data.hits || [],
        totalHits: response.data.total_hits || 0,
        offset: response.data.offset || 0,
        limit: response.data.limit || limit
      };
    } catch (err) {
      throw new Error(t('Ошибка поиска в Modrinth: {error}', { error: err.message }));
    }
  }

  async getProjectVersions(projectIdOrSlug, gameVersion, loader, kind = 'mod') {
    const params = {};
    if (gameVersion) params.game_versions = JSON.stringify([gameVersion]);
    const loaders = loaderList(loader, kind);
    if (loaders.length) params.loaders = JSON.stringify(loaders);

    const response = await axios.get(`${MODRINTH_API}/project/${encodeURIComponent(projectIdOrSlug)}/version`, {
      params,
      headers: HEADERS,
      timeout: 10000
    });
    // The API filter is loose about loaders on multi-loader versions, so check again
    return (response.data || []).filter(v => isCompatible(v, gameVersion, loader, kind));
  }

  // ---------- local files ----------

  sha1Of(fullPath) {
    const stat = fs.statSync(fullPath);
    const cached = this.hashCache.get(fullPath);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.sha1;
    const sha1 = crypto.createHash('sha1').update(fs.readFileSync(fullPath)).digest('hex');
    this.hashCache.set(fullPath, { size: stat.size, mtimeMs: stat.mtimeMs, sha1 });
    this.persist();
    return sha1;
  }

  /** Files of this kind in the folder; unpacked resource packs and shaders come as folders without a hash. */
  listModFiles(modsDir, kind = 'mod') {
    if (!fs.existsSync(modsDir)) return [];
    const type = contentType(kind);
    const list = [];
    for (const fileName of fs.readdirSync(modsDir)) {
      const fullPath = path.join(modsDir, fileName);
      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch (e) {
        continue;
      }
      const isDir = stat.isDirectory();
      if (isDir ? !type.folders : !(stat.isFile() && type.file.test(fileName))) continue;
      list.push({
        fileName,
        fullPath,
        isDir,
        enabled: !fileName.toLowerCase().endsWith('.disabled'),
        sizeBytes: isDir ? 0 : stat.size,
        sha1: isDir ? null : this.sha1Of(fullPath)
      });
    }
    return list;
  }

  // ---------- Modrinth lookups ----------

  async identify(hashes) {
    if (!hashes.length) return {};
    const res = await axios.post(`${MODRINTH_API}/version_files`, { hashes, algorithm: 'sha1' }, { headers: HEADERS, timeout: 15000 });
    return res.data || {};
  }

  async latestFor(hashes, gameVersion, loader, kind = 'mod') {
    if (!hashes.length) return {};
    const body = { hashes, algorithm: 'sha1', game_versions: [gameVersion] };
    const loaders = loaderList(loader, kind);
    if (loaders.length) body.loaders = loaders;
    const res = await axios.post(`${MODRINTH_API}/version_files/update`, body, { headers: HEADERS, timeout: 15000 });
    return res.data || {};
  }

  /** Title/slug/icon/server side of projects; they rarely change, so they are kept for a week. */
  async getProjects(ids) {
    const unique = [...new Set(ids)];
    const result = {};
    const missing = [];
    for (const id of unique) {
      const known = this.projectCache.get(id);
      // entries cached before server_side was kept are asked again
      if (known && 'server_side' in known && Date.now() - known.time < PROJECT_INFO_MS) result[id] = known;
      else missing.push(id);
    }
    for (let i = 0; i < missing.length; i += 100) {
      const res = await axios.get(`${MODRINTH_API}/projects`, {
        params: { ids: JSON.stringify(missing.slice(i, i + 100)) },
        headers: HEADERS,
        timeout: 15000
      });
      for (const p of res.data || []) {
        const info = { time: Date.now(), title: p.title, slug: p.slug, icon_url: p.icon_url, server_side: p.server_side };
        this.projectCache.set(p.id, info);
        result[p.id] = info;
      }
    }
    if (missing.length) this.persist();
    return result;
  }

  /**
   * Local mods of a build, enriched with Modrinth data:
   * which project each file belongs to, whether the installed version fits the build,
   * and the newest version for exactly this Minecraft version + loader.
   */
  async scanMods(modsDir, gameVersion, loader, { force = false, kind = 'mod' } = {}) {
    const files = this.listModFiles(modsDir, kind);
    const key = `${modsDir}|${gameVersion}|${loader}|${kind}`;
    const signature = files.map(f => `${f.fileName}:${f.sha1}`).sort().join(',');
    const cached = this.scanCache.get(key);
    if (!force && cached && cached.signature === signature && Date.now() - cached.time < SCAN_CACHE_MS) {
      return cached.result;
    }

    const hashes = files.filter(f => f.sha1).map(f => f.sha1);
    let current = {};
    let latest = {};
    let projects = {};
    let online = true;
    try {
      [current, latest] = await Promise.all([this.identify(hashes), this.latestFor(hashes, gameVersion, loader, kind)]);
      projects = await this.getProjects(Object.values(current).map(v => v.project_id));
    } catch (e) {
      online = false;
    }

    const mods = files.map(f => {
      const cur = f.sha1 ? current[f.sha1] : null;
      const project = cur ? projects[cur.project_id] : null;
      const next = f.sha1 ? latest[f.sha1] : null;
      const curCompatible = cur ? isCompatible(cur, gameVersion, loader, kind) : null;
      let update = null;
      if (cur && next && next.id !== cur.id && isCompatible(next, gameVersion, loader, kind)) {
        const newer = new Date(next.date_published) > new Date(cur.date_published);
        // Offer it when it is newer, or when the installed file is not even made for this Minecraft version
        if (newer || !curCompatible) {
          update = { versionId: next.id, versionNumber: next.version_number, published: next.date_published };
        }
      }
      return {
        fileName: f.fileName,
        isDir: f.isDir,
        enabled: f.enabled,
        sizeBytes: f.sizeBytes,
        projectId: cur ? cur.project_id : null,
        title: project ? project.title : null,
        slug: project ? project.slug : null,
        iconUrl: project ? project.icon_url : null,
        versionId: cur ? cur.id : null,
        versionNumber: cur ? cur.version_number : null,
        gameVersions: cur ? cur.game_versions : null,
        compatible: curCompatible,
        update
      };
    });

    const result = { online, gameVersion, loader, kind, mods };
    if (online) this.scanCache.set(key, { time: Date.now(), signature, result });
    return result;
  }

  // ---------- downloads ----------

  /** Downloads the primary file of a version, checks its sha1 and moves it into place. */
  async downloadVersion(version, modsDir, { disabled = false } = {}) {
    const file = primaryFile(version);
    if (!file || !file.url) throw new Error(t('У этой версии мода нет файла для скачивания'));
    fs.mkdirSync(modsDir, { recursive: true });

    const finalName = disabled ? `${file.filename}.disabled` : file.filename;
    const finalPath = path.join(modsDir, finalName);
    const tmpPath = path.join(modsDir, `.${file.filename}.mcl-download`);

    const res = await axios.get(file.url, { responseType: 'arraybuffer', headers: HEADERS, timeout: 60000 });
    const data = Buffer.from(res.data);
    const sha1 = crypto.createHash('sha1').update(data).digest('hex');
    if (file.hashes && file.hashes.sha1 && file.hashes.sha1 !== sha1) {
      throw new Error(t('Файл {file} скачался повреждённым, попробуйте ещё раз', { file: file.filename }));
    }
    fs.writeFileSync(tmpPath, data);
    fs.renameSync(tmpPath, finalPath);
    return finalName;
  }

  /** Files in the folder that belong to the given Modrinth projects: { projectId: [{ fileName, versionId, enabled }] } */
  async installedProjects(modsDir, kind = 'mod') {
    const files = this.listModFiles(modsDir, kind).filter(f => f.sha1);
    const current = await this.identify(files.map(f => f.sha1));
    const map = {};
    for (const f of files) {
      const v = current[f.sha1];
      if (!v) continue;
      (map[v.project_id] = map[v.project_id] || []).push({ fileName: f.fileName, versionId: v.id, enabled: f.enabled });
    }
    return map;
  }

  /**
   * Installs the newest version of a project that fits the build, replacing an older copy
   * and, for mods, pulling in required dependencies that are missing.
   */
  async installMod(projectId, gameVersion, loader, modsDir, kind = 'mod', _state = null) {
    const state = _state || { installed: await this.installedProjects(modsDir, kind), added: [], depth: 0 };

    const versions = await this.getProjectVersions(projectId, gameVersion, loader, kind);
    if (!versions.length) {
      throw new Error(kind === 'mod'
        ? t('У мода нет версии для Minecraft {version} ({loader})', { version: gameVersion, loader })
        : t('Нет версии для Minecraft {version}', { version: gameVersion }));
    }
    const version = versions[0];
    const existing = state.installed[version.project_id] || [];

    if (existing.some(e => e.versionId === version.id)) {
      if (!_state) throw new Error(kind === 'mod' ? t('Эта версия мода уже установлена') : t('Эта версия уже установлена'));
    } else {
      const disabled = existing.length > 0 && existing.every(e => !e.enabled);
      const newName = await this.downloadVersion(version, modsDir, { disabled });
      for (const e of existing) {
        if (e.fileName !== newName) fs.rmSync(path.join(modsDir, e.fileName), { force: true });
      }
      state.installed[version.project_id] = [{ fileName: newName, versionId: version.id, enabled: !disabled }];
      state.added.push(newName);
    }

    // Required dependencies (Fabric API, libraries, ...); a shader's "dependency" is a mod like Iris, not another shader
    if (kind === 'mod' && state.depth < 3) {
      for (const dep of version.dependencies || []) {
        if (dep.dependency_type !== 'required' || !dep.project_id || state.installed[dep.project_id]) continue;
        state.depth++;
        try {
          await this.installMod(dep.project_id, gameVersion, loader, modsDir, kind, state);
        } catch (e) {
          // a missing optional-in-practice dependency should not undo the main install
        } finally {
          state.depth--;
        }
      }
    }

    return { fileName: state.added[0] || null, added: state.added, versionNumber: version.version_number };
  }

  /** Updates one installed file to the newest version for this Minecraft version + loader. */
  async updateMod(modsDir, fileName, gameVersion, loader, kind = 'mod') {
    const fullPath = path.join(modsDir, fileName);
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) throw new Error(t('Файл мода не найден'));
    const sha1 = this.sha1Of(fullPath);

    const [current, latest] = await Promise.all([this.identify([sha1]), this.latestFor([sha1], gameVersion, loader, kind)]);
    const cur = current[sha1];
    const next = latest[sha1];
    if (!cur) throw new Error(t('Мод не найден на Modrinth'));
    if (!next || next.id === cur.id || !isCompatible(next, gameVersion, loader, kind)) {
      throw new Error(t('Нет обновления для Minecraft {version}', { version: gameVersion }));
    }

    const disabled = fileName.toLowerCase().endsWith('.disabled');
    const newName = await this.downloadVersion(next, modsDir, { disabled });
    if (newName !== fileName) fs.rmSync(fullPath, { force: true });
    return { fileName: newName, versionNumber: next.version_number };
  }
}

module.exports = {
  ModrinthManager,
  isCompatible,
  HEADERS
};
