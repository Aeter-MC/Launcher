/**
 * launcher-core.js
 * minecraft game launch orchestrator with support for Instances, Ely.by injection, and Microsoft auth.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { xuidFromToken } = require('./microsoft-auth');
const { t } = require('./i18n/i18n');
const { gcArgs } = require('./jvm-flags');
const { execFile } = require('child_process');

// quotes group whitespace; backslashes are literal except before a quote. No shell.
function parseJvmArgs(value) {
  const result = [];
  let current = '', quote = '', started = false;
  const text = String(value || '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\0') throw new Error('JVM arguments contain a NUL character');
    if (c === '\\' && (text[i + 1] === '"' || text[i + 1] === "'")) { current += text[++i]; started = true; }
    else if (quote) { if (c === quote) quote = ''; else current += c; }
    else if (c === '"' || c === "'") { quote = c; started = true; }
    else if (/\s/.test(c)) { if (started) { result.push(current); current = ''; started = false; } }
    else { current += c; started = true; }
  }
  if (quote) throw new Error('Unclosed quote in JVM arguments');
  if (started) result.push(current);
  return result;
}

function secureJavaCheck(java) {
  return new Promise(resolve => execFile(java, ['-version'], { timeout: 15000, windowsHide: true, maxBuffer: 65536 }, error => {
    resolve(error ? { run: false, message: 'Java could not start; verify the selected executable' } : { run: true });
  }));
}

// MCLC passes the access token as --xuid when meta.xuid is empty, so accounts without an Xbox id get this instead
const NO_XUID = '0';

// java's UUID.nameUUIDFromBytes("OfflinePlayer:" + username). MCLC's
// authenticator caches the first generated UUID process-wide, which makes a
// second offline account launch with the first account's identity.
function offlineAuthorization(username) {
  const bytes = crypto.createHash('md5').update(`OfflinePlayer:${username}`, 'utf8').digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x30;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const uuid = bytes.toString('hex');
  return {
    access_token: uuid,
    client_token: uuid,
    uuid,
    name: username,
    user_properties: '{}',
    meta: { type: 'offline', xuid: NO_XUID }
  };
}

// minecraft-launcher-core takes ~200 ms to load, so it is loaded on the first launch only
let mclc = null;
function launcherLib() {
  if (!mclc) {
    mclc = require('minecraft-launcher-core');
    // the pinned dependency uses child.exec for this one probe. Replace the
    // adapter method before Client.launch constructs its Handler.
    require('minecraft-launcher-core/components/handler').prototype.checkJava = secureJavaCheck;
  }
  return mclc;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    return null;
  }
}

/** assetIndex.id of a version, following inheritsFrom (Fabric/Forge profiles have none of their own). */
function assetIndexId(root, versionId) {
  for (let id = versionId, i = 0; id && i < 5; i++) {
    const meta = readJson(path.join(root, 'versions', id, `${id}.json`));
    if (!meta) return null;
    if (meta.assetIndex && meta.assetIndex.id) return meta.assetIndex.id;
    id = meta.inheritsFrom;
  }
  return null;
}

/**
 * MCLC reads the asset index from assets/indexes/<version id>.json, not <assetIndex.id>.json like
 * the official launcher, and downloads it when missing. Offline that download leaves an empty file
 * and the launch fails (and keeps failing online too). So before the launch: a broken file is
 * removed, and a missing one is copied from any index of the same assetIndex id already on disk
 * (another build of the same Minecraft, or the official launcher's <id>.json).
 */
function prepareAssetIndex(root, versionId, log) {
  const dir = path.join(root, 'assets', 'indexes');
  const target = path.join(dir, `${versionId}.json`);
  if (fs.existsSync(target)) {
    const ok = readJson(target);
    if (ok && ok.objects) return;
    fs.rmSync(target, { force: true });
    log('warn', `[ASSETS]: ${t('Повреждённый индекс ассетов {file} удалён', { file: path.basename(target) })}`);
  }
  const want = assetIndexId(root, versionId);
  if (!want) return;
  let names = [];
  try {
    names = fs.readdirSync(dir).filter(n => n.endsWith('.json'));
  } catch (e) {
    return;
  }
  const own = names.find(n => n === `${want}.json`);
  const source = own || names.find(n => assetIndexId(root, n.slice(0, -5)) === want);
  if (!source || !(readJson(path.join(dir, source)) || {}).objects) return;
  fs.copyFileSync(path.join(dir, source), target);
  log('info', `[ASSETS]: ${t('Индекс ассетов {id} взят из {file}', { id: want, file: source })}`);
}

class LauncherCore {
  constructor() {
    this.client = null;
    this.gameProcess = null;
    this.isRunning = false;
    this.isLaunching = false;
    this.launchStartTime = 0;
  }

  /**
   * launch Minecraft.
   *
   * root      - shared directory with versions/libraries/assets (main .minecraft)
   * gameDir   - directory with saves/mods/options (instance folder or root itself)
   * version   - vanilla Minecraft version number (e.g. "1.21.1")
   * customVersion - id of a custom version json in root/versions (e.g. Fabric profile)
   * profileJvmArgs - JVM arguments that profile needs (Forge/NeoForge module path etc.)
   */
  async launch(options, callbacks = {}) {
    if (this.isRunning || this.isLaunching) {
      throw new Error(t('Игра уже запущена!'));
    }

    const {
      account,
      root,
      gameDir,
      version,
      customVersion,
      versionType = 'release',
      javaPath,
      minRam = 2,
      maxRam = 4,
      customJvmArgs = '',
      jvmPreset = 'auto',
      javaMajor = 0,
      shenandoahSupported = null,
      profileJvmArgs = [],
      resolutionWidth = 1280,
      resolutionHeight = 720,
      fullscreen = false,
      elyByManager,
      prepareOnly = false
    } = options;

    const { onProgress, onLog, onLaunched, onClose } = callbacks;
    const log = (type, message) => onLog && onLog({ type, message });

    this.isLaunching = true;
    try {
      let authObj = null;
      const extraJvmArgs = [];

      if (account && account.type === 'microsoft' && account.mclcAuth) {
        // accounts saved before xuid was stored get it from the token
        const meta = account.mclcAuth.meta || {};
        const xuid = meta.xuid || xuidFromToken(account.mclcAuth.access_token) || NO_XUID;
        authObj = { ...account.mclcAuth, meta: { ...meta, xuid } };
        log('info', `[AUTH]: ${t('Авторизация через Microsoft ({name})', { name: account.username })}`);
      } else if (account && account.type === 'elyby' && account.accessToken) {
        authObj = {
          access_token: account.accessToken,
          client_token: account.clientToken,
          uuid: account.uuid,
          name: account.username,
          user_properties: account.userProperties || '{}',
          meta: { type: 'mojang', xuid: NO_XUID }
        };
        if (elyByManager) {
          extraJvmArgs.push(await elyByManager.getJvmArgs());
          log('info', `[AUTH]: ${t('Ely.by authlib-injector подключен ({name})', { name: account.username })}`);
        }
      } else {
        const uName = (account && account.username) || 'Player';
        authObj = offlineAuthorization(uName);
        log('info', `[AUTH]: ${t('Оффлайн режим ({name})', { name: uName })}`);
      }

      const max = Math.max(1, Number(maxRam) || 4);
      const min = Math.min(max, Math.max(1, Number(minRam) || 1));

      const ownArgs = parseJvmArgs(customJvmArgs);
      const gc = gcArgs({ preset: jvmPreset, javaMajor, maxRamGb: max, customArgs: ownArgs, shenandoahSupported });
      if (gc.gc) log('info', `[JVM]: ${t('Сборщик мусора {gc}, флаги подобраны под {ram} ГБ', { gc: gc.gc, ram: max })}`);
      if (gc.note === 'own-gc') log('info', `[JVM]: ${t('Сборщик мусора задан в своих аргументах — готовые флаги не добавлены')}`);
      if (gc.note === 'zgc-old-java') log('warn', `[JVM]: ${t('ZGC нужна Java 17 или новее (сейчас {java}) — используется G1', { java: javaMajor })}`);
      if (gc.note === 'shenandoah-old-java') log('warn', `[JVM]: ${t('Shenandoah нужна Java 17 или новее (сейчас {java}) — используется G1', { java: javaMajor })}`);
      if (gc.note === 'shenandoah-unavailable') log('warn', `[JVM]: ${t('Эта сборка Java не поддерживает Shenandoah — используется G1')}`);
      // own arguments go after the preset, so an own -XX:G1... value wins over the preset's
      const customArgs = [...gc.args, ...ownArgs, ...extraJvmArgs, ...profileJvmArgs];

      const mclOptions = {
        authorization: authObj,
        root,
        version: { number: version, type: versionType || 'release' },
        memory: { max: `${max}G`, min: `${min}G` },
        window: fullscreen
          ? { fullscreen: true }
          : { width: resolutionWidth || 1280, height: resolutionHeight || 720 },
        customArgs,
        overrides: {}
      };

      if (customVersion) {
        mclOptions.version.custom = customVersion;
      }
      if (gameDir && gameDir !== root) {
        mclOptions.overrides.gameDirectory = gameDir;
      }
      // MCLC starts Java in root (the shared .minecraft) unless told otherwise. Mods that open files
      // by relative path (logs/, Vivecraft's openvr/ and its settings, some configs) then use the shared
      // folder instead of the build's own and behave differently than in Prism, which starts in the build folder.
      mclOptions.overrides.cwd = gameDir || root;
      fs.mkdirSync(mclOptions.overrides.cwd, { recursive: true });
      if (javaPath && fs.existsSync(javaPath)) {
        mclOptions.javaPath = javaPath;
        log('info', `[JAVA]: ${javaPath}`);
      } else {
        log('warn', t('[JAVA]: Подходящая Java не найдена, используется "java" из PATH'));
      }

      try {
        prepareAssetIndex(root, customVersion || version, log);
      } catch (e) {
        log('warn', `[ASSETS]: ${e.message}`);
      }

      this.client = new (launcherLib().Client)();
      this.launchStartTime = Date.now();

      // prepare the same command and files, but let the native runner start Java.
      let prepared = null;
      if (prepareOnly) {
        this.client.startMinecraft = args => {
          // MCLC includes numeric window dimensions. child_process.spawn normally
          // coerces those to strings; our native handoff must do the same.
          prepared = { java: mclOptions.javaPath || 'java', cwd: mclOptions.overrides.cwd, args: args.map(String) };
          return prepared;
        };
      }

      let lastDebug = '';
      this.client.on('debug', (msg) => {
        // MCLC's argument dump contains the access token.
        if (String(msg).includes('Launching with arguments')) return;
        lastDebug = String(msg);
        log('debug', lastDebug);
      });

      this.client.on('data', (data) => {
        const text = String(data).trim();
        if (text) log('stdout', text);
      });

      this.client.on('download-status', (status) => {
        // asset byte events are per file. The progress event counts the entire index.
        if (!onProgress || !status || status.type === 'assets') return;
        const total = status.total || 0;
        const current = status.current || 0;
        onProgress({
          type: status.type || 'download',
          name: status.name || '',
          current,
          total,
          percent: total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0
        });
      });

      this.client.on('progress', (e) => {
        if (!onProgress || !e) return;
        const total = e.total || 0;
        const current = e.task || 0;
        onProgress({
          type: e.type || 'progress',
          name: '',
          current,
          total,
          percent: total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0
        });
      });

      let gameFinished = false;
      const finishGame = (code) => {
        if (!this.isRunning || gameFinished) return;
        gameFinished = true;
        const durationSeconds = Math.round((Date.now() - this.launchStartTime) / 1000);
        this.isRunning = false;
        this.gameProcess = null;
        log('info', t('Процесс игры завершен (Код: {code}, Время игры: {m}м {s}с)', { code, m: Math.floor(durationSeconds / 60), s: durationSeconds % 60 }));
        onClose && onClose(code, durationSeconds);
      };
      this.client.on('close', finishGame);

      // MCLC does not throw on failure: it emits a debug message and resolves with null.
      const processHandle = await this.client.launch(mclOptions);
      if (!processHandle) {
        const reason = lastDebug.replace(/^\[MCLC\]:\s*/, '') || t('неизвестная ошибка');
        throw new Error(reason);
      }

      if (prepareOnly) return { ...prepared, authorization: authObj };

      this.gameProcess = processHandle;
      this.isRunning = true;
      // MCLC reports close only after stdio closes. A descendant can keep
      // those pipes open after Java exits, leaving the launch lock held.
      processHandle.once?.('exit', (code, signal) => finishGame(code ?? (signal ? 1 : null)));
      processHandle.once?.('error', () => finishGame(1));
      log('info', t('Minecraft успешно запущен!'));
      onLaunched && onLaunched();
      return processHandle;
    } catch (err) {
      log('error', t('Ошибка запуска: {error}', { error: err.message }));
      throw err;
    } finally {
      this.isLaunching = false;
    }
  }

  kill() {
    if (this.gameProcess) {
      try {
        this.gameProcess.kill();
        return true;
      } catch (e) {
        console.error('[LauncherCore] Error killing process:', e.message);
      }
    }
    return false;
  }
}

module.exports = {
  LauncherCore, parseJvmArgs, secureJavaCheck, offlineAuthorization
};
