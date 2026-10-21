/**
 * version-manager.js
 * Handles fetching Mojang versions, reading local installed versions, and Fabric installation.
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const MOJANG_MANIFEST_URL = 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json';
const FABRIC_META_URL = 'https://meta.fabricmc.net/v2/versions/loader';

const MANIFEST_FRESH_MS = 6 * 60 * 60 * 1000;

class VersionManager {
  constructor(gameDir, cache = null) {
    this.gameDir = gameDir;
    this.cache = cache;
    this.cachedManifest = null;
    this.manifestTimestamp = 0;
    this.refreshing = null;
  }

  setGameDir(dir) {
    this.gameDir = dir;
  }

  /**
   * Fetches the official Mojang version manifest.
   */
  /**
   * The official Mojang version list. A copy on disk is used right away and refreshed
   * in the background when it is older than 6 hours, so startup never waits for the network
   * once the list has been downloaded at least once.
   */
  async getMojangManifest() {
    if (!this.cachedManifest && this.cache) {
      const disk = this.cache.read('version_manifest');
      if (disk && disk.data) {
        this.cachedManifest = disk.data;
        this.manifestTimestamp = disk.time || 0;
      }
    }

    if (this.cachedManifest) {
      if (Date.now() - this.manifestTimestamp > MANIFEST_FRESH_MS) this.refreshManifest().catch(() => {});
      return this.cachedManifest;
    }
    return this.refreshManifest();
  }

  refreshManifest() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = axios.get(MOJANG_MANIFEST_URL, { timeout: 10000 })
      .then(response => {
        this.cachedManifest = response.data;
        this.manifestTimestamp = Date.now();
        if (this.cache) this.cache.write('version_manifest', { time: this.manifestTimestamp, data: response.data });
        return this.cachedManifest;
      })
      .catch(e => {
        if (this.cachedManifest) return this.cachedManifest;
        throw new Error(`Не удалось загрузить список версий Minecraft: ${e.message}`);
      })
      .finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  /**
   * Scans the local .minecraft/versions directory.
   */
  getInstalledVersions() {
    const versionsDir = path.join(this.gameDir, 'versions');
    if (!fs.existsSync(versionsDir)) {
      return [];
    }

    const list = [];
    try {
      const entries = fs.readdirSync(versionsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const jsonPath = path.join(versionsDir, entry.name, `${entry.name}.json`);
          if (fs.existsSync(jsonPath)) {
            let type = 'custom';
            let releaseTime = null;
            let inheritsFrom = null;
            try {
              const meta = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
              type = meta.type || 'custom';
              releaseTime = meta.releaseTime || null;
              inheritsFrom = meta.inheritsFrom || null;
            } catch (e) {}

            list.push({
              id: entry.name,
              type: inheritsFrom ? 'custom' : type,
              installed: true,
              releaseTime: releaseTime,
              inheritsFrom: inheritsFrom,
              isFabric: entry.name.toLowerCase().includes('fabric'),
              isForge: entry.name.toLowerCase().includes('forge') || entry.name.toLowerCase().includes('neoforge')
            });
          }
        }
      }
    } catch (e) {
      console.error('[VersionManager] Error scanning installed versions:', e.message);
    }

    return list;
  }

  /**
   * Combines Mojang manifest with installed local versions.
   */
  async getAllVersions(showSnapshots = false) {
    const installed = this.getInstalledVersions();
    const installedMap = new Map();
    installed.forEach(v => installedMap.set(v.id, v));

    let mojangVersions = [];
    let latestRelease = '1.21.1';
    let latestSnapshot = '';

    try {
      const manifest = await this.getMojangManifest();
      if (manifest && manifest.versions) {
        latestRelease = manifest.latest?.release || latestRelease;
        latestSnapshot = manifest.latest?.snapshot || '';

        mojangVersions = manifest.versions.filter(v => {
          if (v.type === 'release') return true;
          if (showSnapshots && (v.type === 'snapshot' || v.type === 'old_beta' || v.type === 'old_alpha')) return true;
          return false;
        }).map(v => ({
          id: v.id,
          type: v.type,
          releaseTime: v.releaseTime,
          url: v.url,
          installed: installedMap.has(v.id)
        }));
      }
    } catch (e) {
      console.warn('[VersionManager] Using installed versions as fallback:', e.message);
    }

    // Include installed versions that are not in Mojang manifest (e.g. Fabric, Forge, Modpacks)
    const combined = [...installed.filter(iv => !mojangVersions.some(mv => mv.id === iv.id))];
    combined.push(...mojangVersions);

    return {
      latestRelease,
      latestSnapshot,
      versions: combined,
      installedCount: installed.length
    };
  }

  /**
   * Fetches Fabric loader versions available for a game version.
   */
  async getFabricLoaders(gameVersion) {
    try {
      const url = `https://meta.fabricmc.net/v2/versions/loader/${gameVersion}`;
      const res = await axios.get(url, { timeout: 8000 });
      return res.data; // Array of { loader: { version, stable }, ... }
    } catch (e) {
      console.error('[VersionManager] Failed to fetch Fabric loaders:', e.message);
      return [];
    }
  }

  /**
   * Installs Fabric loader for specified Minecraft version.
   */
  async installFabric(gameVersion, loaderVersion) {
    if (!loaderVersion) {
      const loaders = await this.getFabricLoaders(gameVersion);
      if (!loaders || loaders.length === 0) {
        throw new Error(`Fabric недоступен для версии Minecraft ${gameVersion}`);
      }
      loaderVersion = loaders[0].loader.version;
    }

    const profileUrl = `https://meta.fabricmc.net/v2/versions/loader/${gameVersion}/${loaderVersion}/profile/json`;
    const res = await axios.get(profileUrl, { timeout: 10000 });
    const profileJson = res.data;
    const versionId = profileJson.id; // e.g. "fabric-loader-0.16.9-1.21.1"

    const targetDir = path.join(this.gameDir, 'versions', versionId);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const targetFile = path.join(targetDir, `${versionId}.json`);
    fs.writeFileSync(targetFile, JSON.stringify(profileJson, null, 2), 'utf-8');

    return {
      id: versionId,
      gameVersion,
      loaderVersion,
      path: targetFile
    };
  }

  readLocalVersionJson(versionId) {
    const jsonPath = path.join(this.gameDir, 'versions', versionId, `${versionId}.json`);
    if (!fs.existsSync(jsonPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    } catch (e) {
      return null;
    }
  }

  /**
   * Turns a version id from the UI into MCLC launch parameters.
   * Custom versions (Fabric, Forge, ...) inherit from a vanilla version.
   */
  resolveLaunchVersion(versionId) {
    const meta = this.readLocalVersionJson(versionId);
    if (meta && meta.inheritsFrom) {
      return { number: meta.inheritsFrom, custom: versionId };
    }
    return { number: versionId, custom: null };
  }

  /**
   * Returns the Java major version a Minecraft version needs.
   */
  async getRequiredJava(versionId) {
    let id = versionId;
    for (let i = 0; i < 5 && id; i++) {
      const meta = this.readLocalVersionJson(id);
      if (!meta) break;
      if (meta.javaVersion && meta.javaVersion.majorVersion) return meta.javaVersion.majorVersion;
      id = meta.inheritsFrom;
    }

    if (id) {
      try {
        const manifest = await this.getMojangManifest();
        const entry = manifest.versions.find(v => v.id === id);
        if (entry) {
          const res = await axios.get(entry.url, { timeout: 10000 });
          if (res.data.javaVersion && res.data.javaVersion.majorVersion) {
            return res.data.javaVersion.majorVersion;
          }
        }
      } catch (e) {}
    }

    // Fallback heuristic for "1.X.Y" ids
    const m = /^1\.(\d+)(?:\.(\d+))?/.exec(id || versionId || '');
    if (m) {
      const minor = parseInt(m[1], 10);
      const patch = parseInt(m[2] || '0', 10);
      if (minor > 20 || (minor === 20 && patch >= 5)) return 21;
      if (minor >= 18) return 17;
      if (minor === 17) return 16;
      return 8;
    }
    return 21;
  }

  /**
   * Deletes a version directory from .minecraft/versions.
   */
  deleteVersion(versionId) {
    const targetDir = path.join(this.gameDir, 'versions', versionId);
    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
      return true;
    }
    return false;
  }
}

module.exports = {
  VersionManager
};
