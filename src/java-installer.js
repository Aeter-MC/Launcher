/**
 * java-installer.js
 * Downloads Eclipse Temurin (Adoptium) JRE builds into the launcher's own folder,
 * so a game can start even if the right Java is not installed on the system.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { pipeline } = require('stream/promises');
const { promisify } = require('util');
const { JAVA_BINARY } = require('./java-detector');
const axios = require('axios');
const { t } = require('./i18n/i18n');

const run = promisify(execFile);
const API = 'https://api.adoptium.net/v3/assets/latest';

class JavaInstaller {
  constructor(runtimesDir) {
    this.dir = runtimesDir;
    this.pending = new Map(); // major -> Promise (one download per version at a time)
  }

  targetDir(major) {
    return path.join(this.dir, `java-${major}`);
  }

  installedPath(major) {
    return this.findJava(this.targetDir(major));
  }

  findJava(root) {
    if (!fs.existsSync(root)) return null;
    const direct = path.join(root, 'bin', JAVA_BINARY);
    if (fs.existsSync(direct)) return direct;
    // archives unpack into a single top folder like jdk-21.0.12+1-jre
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const exe = path.join(root, entry.name, 'bin', JAVA_BINARY);
      if (entry.isDirectory() && fs.existsSync(exe)) return exe;
    }
    return null;
  }

  /**
   * Installs Temurin JRE <major> for the current platform. onProgress({ stage, received, total, version })
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

    const platform = { win32: 'windows', linux: 'linux' }[process.platform];
    const architecture = { x64: 'x64', arm64: 'aarch64' }[process.arch];
    const extension = platform === 'windows' ? '.zip' : '.tar.gz';
    if (!platform || !architecture) throw new Error(t('Автоустановка Java недоступна на этой платформе'));

    onProgress({ stage: 'info', received: 0, total: 0 });
    let asset;
    for (const imageType of ['jre', 'jdk']) {
      const res = await axios.get(`${API}/${major}/hotspot`, {
        params: { architecture, image_type: imageType, os: platform, vendor: 'eclipse' },
        timeout: 15000,
        validateStatus: status => status === 200 || status === 404
      });
      asset = (res.data || []).find(a => a.binary && a.binary.package && a.binary.package.link.endsWith(extension));
      if (asset) break;
    }
    if (!asset) throw new Error(t('Для Java {major} нет сборки Temurin для этой платформы', { major }));

    const pkg = asset.binary.package;
    const version = asset.version && asset.version.semver;
    fs.mkdirSync(this.dir, { recursive: true });
    const work = fs.mkdtempSync(path.join(this.dir, `.java-${major}-`));
    const archive = path.join(work, `java${extension}`);
    const extracted = path.join(work, 'runtime');
    const target = this.targetDir(major);
    try {
      const res = await axios.get(pkg.link, { responseType: 'stream', timeout: 30000, maxRedirects: 5 });
      const total = Number(res.headers['content-length']) || pkg.size || 0;
      const hash = crypto.createHash('sha256');
      let received = 0;
      let lastReport = 0;
      res.data.on('data', chunk => {
        hash.update(chunk);
        received += chunk.length;
        if (Date.now() - lastReport > 150) {
          lastReport = Date.now();
          onProgress({ stage: 'download', received, total, version });
        }
      });
      await pipeline(res.data, fs.createWriteStream(archive));
      if (!pkg.checksum || hash.digest('hex') !== pkg.checksum) {
        throw new Error(t('Архив Java скачался повреждённым, попробуйте ещё раз'));
      }

      onProgress({ stage: 'extract', received: total, total, version });
      if (platform === 'linux') {
        fs.mkdirSync(extracted);
        await run('tar', ['-xzf', archive, '-C', extracted, '--no-same-owner', '--no-same-permissions']);
      } else {
        require('./safe-zip').extractCheckedZip(archive, extracted);
      }

      const exe = this.findJava(extracted);
      if (!exe) throw new Error(t('В архиве Java не нашлось исполняемого файла'));
      const existing = this.installedPath(major);
      if (existing) return existing;
      fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(extracted, target);
      onProgress({ stage: 'done', received: total, total, version });
      return path.join(target, path.relative(extracted, exe));
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }
}

module.exports = { JavaInstaller };
