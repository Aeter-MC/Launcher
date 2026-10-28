/**
 * java-installer.js
 * Downloads Eclipse Temurin (Adoptium) JRE builds into the launcher's own folder,
 * so a game can start even if the right Java is not installed on the system.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { t } = require('./i18n/i18n');

const API = 'https://api.adoptium.net/v3/assets/latest';

class JavaInstaller {
  constructor(runtimesDir) {
    this.dir = runtimesDir;
    this.pending = new Map(); // major -> Promise (one download per version at a time)
  }

  targetDir(major) {
    return path.join(this.dir, `java-${major}`);
  }

  /** java.exe inside an installed runtime, or null. */
  installedPath(major) {
    const root = this.targetDir(major);
    if (!fs.existsSync(root)) return null;
    const direct = path.join(root, 'bin', 'java.exe');
    if (fs.existsSync(direct)) return direct;
    // archives unpack into a single top folder like jdk-21.0.12+1-jre
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const exe = path.join(root, entry.name, 'bin', 'java.exe');
      if (entry.isDirectory() && fs.existsSync(exe)) return exe;
    }
    return null;
  }

  /**
   * Installs Temurin JRE <major> for Windows x64. onProgress({ stage, received, total, version })
   * stage: 'info' | 'download' | 'extract' | 'done'
   */
  install(major, onProgress = () => {}) {
    if (this.pending.has(major)) return this.pending.get(major);
    const job = this.doInstall(major, onProgress).finally(() => this.pending.delete(major));
    this.pending.set(major, job);
    return job;
  }

  async doInstall(major, onProgress) {
    const existing = this.installedPath(major);
    if (existing) return existing;

    onProgress({ stage: 'info', received: 0, total: 0 });
    let asset;
    for (const imageType of ['jre', 'jdk']) {
      const res = await axios.get(`${API}/${major}/hotspot`, {
        params: { architecture: 'x64', image_type: imageType, os: 'windows', vendor: 'eclipse' },
        timeout: 15000
      });
      asset = (res.data || []).find(a => a.binary && a.binary.package && a.binary.package.link.endsWith('.zip'));
      if (asset) break;
    }
    if (!asset) throw new Error(t('Для Java {major} нет сборки Temurin под Windows', { major }));

    const pkg = asset.binary.package;
    const version = asset.version && asset.version.semver;
    fs.mkdirSync(this.dir, { recursive: true });
    const zipPath = path.join(this.dir, `.java-${major}.zip.part`);

    // download with progress and sha256 check
    const res = await axios.get(pkg.link, { responseType: 'stream', timeout: 30000, maxRedirects: 5 });
    const total = Number(res.headers['content-length']) || pkg.size || 0;
    const hash = crypto.createHash('sha256');
    let received = 0;
    let lastReport = 0;
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(zipPath);
      res.data.on('data', chunk => {
        hash.update(chunk);
        received += chunk.length;
        if (Date.now() - lastReport > 150) {
          lastReport = Date.now();
          onProgress({ stage: 'download', received, total, version });
        }
      });
      res.data.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      res.data.pipe(out);
    });
    if (pkg.checksum && hash.digest('hex') !== pkg.checksum) {
      fs.rmSync(zipPath, { force: true });
      throw new Error(t('Архив Java скачался повреждённым, попробуйте ещё раз'));
    }

    onProgress({ stage: 'extract', received: total, total, version });
    const target = this.targetDir(major);
    const tmp = `${target}.tmp`;
    fs.rmSync(tmp, { recursive: true, force: true });
    const AdmZip = require('adm-zip');
    await new Promise((resolve, reject) => {
      new AdmZip(zipPath).extractAllToAsync(tmp, true, false, err => (err ? reject(err) : resolve()));
    });
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(tmp, target);
    fs.rmSync(zipPath, { force: true });

    const exe = this.installedPath(major);
    if (!exe) throw new Error(t('В архиве Java не нашлось java.exe'));
    onProgress({ stage: 'done', received: total, total, version });
    return exe;
  }
}

module.exports = { JavaInstaller };
