/**
 * updater.js
 * Launcher self-update from GitHub Releases (published by .github/workflows/build.yml).
 * Every release carries update.json ({ version, electron, asar: { size, sha256 } }) and app.asar.
 * The installed launcher downloads the new app.asar next to the old one and swaps it in once it
 * has quit: right away with "restart", otherwise on the next exit. What an app.asar can't update
 * gets a link to the release instead: the portable build (unpacked into a temp folder on every
 * start), a release on another Electron version, an install folder that isn't writable.
 */
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
const axios = require('axios');
// plain fs treats *.asar paths as folders
const ofs = require('original-fs');
const { compareVersions } = require('./loaders');
const { t } = require('./i18n/i18n');

const REPO = 'Aeter-MC/Launcher';
const UNINSTALL_KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AeterMC';
// the GitHub API allows 60 requests an hour without a token: release notes are kept a while
const RELEASES_TTL = 10 * 60 * 1000;

/** A failed request to GitHub in words for the update menu. */
function requestError(e) {
  const status = e.response && e.response.status;
  if (status === 404) return t('на GitHub пока нет релизов с обновлением');
  if (status === 403 || status === 429) return t('GitHub ограничил число запросов, попробуйте позже');
  if (!e.response && e.code) return t('нет связи с GitHub');
  return e.message;
}

class Updater {
  /**
   * resourcesDir: folder with app.asar; exePath: what to start after the swap;
   * portable: started by the portable stub; enabled: false when run from the sources;
   * onChange(state) on every state change.
   * feedUrl, assetUrl(version, file), releasesUrl and uninstallKey point elsewhere in tests.
   */
  constructor({ currentVersion, electronVersion, resourcesDir, exePath, portable, enabled = true, onChange, feedUrl, assetUrl, releasesUrl, uninstallKey }) {
    this.currentVersion = currentVersion;
    this.electronVersion = electronVersion;
    this.asarPath = path.join(resourcesDir, 'app.asar');
    this.newPath = this.asarPath + '.update';
    this.exePath = exePath;
    this.portable = portable;
    this.onChange = onChange || (() => {});
    this.feedUrl = feedUrl || `https://github.com/${REPO}/releases/latest/download/update.json`;
    this.assetUrl = assetUrl || ((version, file) => `https://github.com/${REPO}/releases/download/v${version}/${file}`);
    this.releasesUrl = releasesUrl || `https://api.github.com/repos/${REPO}/releases?per_page=20`;
    this.uninstallKey = uninstallKey || UNINSTALL_KEY;
    this.manifest = null;
    this.releasesCache = null;
    this.swapStarted = false;
    // status: idle | available | downloading | ready | manual (+ version, size, page, progress, reason);
    // checking, checkedAt and error describe the last check or download, for the update menu
    this.state = {
      status: 'idle',
      current: currentVersion,
      enabled,
      releasesPage: `https://github.com/${REPO}/releases`,
      checking: false,
      checkedAt: null,
      error: null
    };
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }

  /** Looks for a newer release. A failed check leaves its error in the state; the next one tries again. */
  async check() {
    const { enabled, checking, status } = this.state;
    if (!enabled || checking || status === 'downloading' || status === 'ready') return this.state;
    this.setState({ checking: true, error: null });
    let manifest;
    try {
      manifest = (await axios.get(this.feedUrl, { timeout: 15000 })).data;
      if (!manifest || typeof manifest.version !== 'string' || !manifest.asar) throw new Error(t('в релизе нет update.json'));
    } catch (e) {
      this.setState({ checking: false, error: t('Не удалось проверить обновления: {error}', { error: requestError(e) }) });
      return this.state;
    }

    const checked = { checking: false, checkedAt: Date.now() };
    if (compareVersions(manifest.version, this.currentVersion) <= 0) {
      this.manifest = null;
      this.setState({ ...checked, status: 'idle', version: null, size: null, page: null, reason: null });
      return this.state;
    }
    this.manifest = manifest;
    // release notes fetched before this release came out don't have it yet
    if (this.releasesCache && !this.releasesCache.list.some(r => r.version === manifest.version)) this.releasesCache = null;
    const reason = this.portable ? 'portable'
      : manifest.electron !== this.electronVersion ? 'electron'
      : !this.canWrite() ? 'readonly'
      : null;
    this.setState({
      ...checked,
      status: reason ? 'manual' : 'available',
      reason,
      version: manifest.version,
      size: manifest.asar.size,
      page: `https://github.com/${REPO}/releases/tag/v${manifest.version}`
    });
    return this.state;
  }

  canWrite() {
    try {
      ofs.writeFileSync(this.newPath, '');
      ofs.rmSync(this.newPath, { force: true });
      return true;
    } catch (e) {
      return false;
    }
  }

  /** Downloads app.asar of the found release next to the current one and checks it. */
  async download() {
    if (this.state.status !== 'available') return this.state;
    const { version, asar } = this.manifest;
    this.setState({ status: 'downloading', progress: 0, error: null });
    try {
      const res = await axios.get(this.assetUrl(version, 'app.asar'), { responseType: 'stream', timeout: 30000 });
      const hash = crypto.createHash('sha256');
      let done = 0;
      await new Promise((resolve, reject) => {
        const out = ofs.createWriteStream(this.newPath);
        res.data.on('data', (chunk) => {
          hash.update(chunk);
          done += chunk.length;
          // whole percents only: a few dozen messages to the window, not thousands
          const progress = Math.min(1, done / asar.size);
          if (Math.floor(progress * 100) > Math.floor(this.state.progress * 100)) this.setState({ progress });
        });
        res.data.on('error', reject);
        out.on('error', reject);
        out.on('finish', resolve);
        res.data.pipe(out);
      });
      if (done !== asar.size || hash.digest('hex') !== asar.sha256) throw new Error(t('файл повреждён'));
      this.setState({ status: 'ready', progress: 1 });
      return this.state;
    } catch (e) {
      ofs.rmSync(this.newPath, { force: true });
      const error = t('Не удалось скачать обновление: {error}', { error: requestError(e) });
      this.setState({ status: 'available', progress: 0, error });
      throw new Error(error);
    }
  }

  /**
   * Release notes for the update menu: the releases newer than this launcher and its own one,
   * newest first, as { version, date, notes, url }. Pre-releases are left out, like in check().
   */
  async releases() {
    if (this.releasesCache && Date.now() - this.releasesCache.time < RELEASES_TTL) return this.releasesCache.list;
    let data;
    try {
      data = (await axios.get(this.releasesUrl, { timeout: 15000, headers: { Accept: 'application/vnd.github+json' } })).data;
    } catch (e) {
      throw new Error(requestError(e));
    }
    const list = (Array.isArray(data) ? data : [])
      .filter(r => !r.draft && !r.prerelease && /^v\d/.test(r.tag_name || ''))
      .map(r => ({ version: r.tag_name.slice(1), date: r.published_at, notes: r.body || '', url: r.html_url }))
      .filter(r => compareVersions(r.version, this.currentVersion) >= 0)
      .sort((a, b) => compareVersions(b.version, a.version));
    this.releasesCache = { time: Date.now(), list };
    return list;
  }

  /**
   * Starts a hidden PowerShell that waits for this process to exit, puts the downloaded app.asar
   * in place and, with restart, starts the launcher again. Returns false when there is nothing to swap.
   */
  startSwap(restart) {
    if (this.state.status !== 'ready' || this.swapStarted) return false;
    this.swapStarted = true;
    const q = (p) => `'${p.replace(/'/g, "''")}'`;
    const script = [
      `try { Wait-Process -Id ${process.pid} -Timeout 120 -ErrorAction Stop } catch {}`,
      // the other Electron processes may hold app.asar for a moment longer
      `$ok = $false; for ($i = 0; $i -lt 40; $i++) { try { Move-Item -LiteralPath ${q(this.newPath)} -Destination ${q(this.asarPath)} -Force -ErrorAction Stop; $ok = $true; break } catch { Start-Sleep -Milliseconds 250 } }`,
      // the version shown in "Apps & features" (written by the installer)
      `if ($ok) { Set-ItemProperty -LiteralPath ${q(this.uninstallKey)} -Name DisplayVersion -Value ${q(String(this.state.version))} -ErrorAction SilentlyContinue }`,
      restart ? `Start-Process -FilePath ${q(this.exePath)}` : ''
    ].join('; ');
    // Through `cmd start`: a direct child is killed together with the launcher (libuv puts it in a
    // kill-on-close job) and a detached one doesn't start everywhere. -EncodedCommand keeps cmd away
    // from quotes, % and non-Latin letters in the paths.
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    spawn('cmd.exe', ['/d', '/c', `start "" /b powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${encoded}`], {
      stdio: 'ignore',
      windowsHide: true,
      windowsVerbatimArguments: true
    }).unref();
    return true;
  }
}

module.exports = { Updater };
