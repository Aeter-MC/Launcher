/**
 * launcher-core.js
 * Minecraft game launch orchestrator with support for Instances, Ely.by injection, and Microsoft auth.
 */
const fs = require('fs');
const { xuidFromToken } = require('./microsoft-auth');
const { t } = require('./i18n/i18n');

// MCLC passes the access token as --xuid when meta.xuid is empty, so accounts without an Xbox id get this instead
const NO_XUID = '0';

// minecraft-launcher-core takes ~200 ms to load, so it is loaded on the first launch only
let mclc = null;
function launcherLib() {
  if (!mclc) mclc = require('minecraft-launcher-core');
  return mclc;
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
   * Launch Minecraft.
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
      profileJvmArgs = [],
      resolutionWidth = 1280,
      resolutionHeight = 720,
      fullscreen = false,
      elyByManager
    } = options;

    const { onProgress, onLog, onLaunched, onClose } = callbacks;
    const log = (type, message) => onLog && onLog({ type, message });

    this.isLaunching = true;
    try {
      let authObj = null;
      const extraJvmArgs = [];

      if (account && account.type === 'microsoft' && account.mclcAuth) {
        // Accounts saved before xuid was stored get it from the token
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
        authObj = await launcherLib().Authenticator.getAuth(uName);
        log('info', `[AUTH]: ${t('Оффлайн режим ({name})', { name: uName })}`);
      }

      const customArgs = String(customJvmArgs || '').split(/\s+/).filter(Boolean);
      customArgs.push(...extraJvmArgs, ...profileJvmArgs);

      const max = Math.max(1, Number(maxRam) || 4);
      const min = Math.min(max, Math.max(1, Number(minRam) || 1));

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
      if (javaPath && fs.existsSync(javaPath)) {
        mclOptions.javaPath = javaPath;
        log('info', `[JAVA]: ${javaPath}`);
      } else {
        log('warn', t('[JAVA]: Подходящая Java не найдена, используется "java" из PATH'));
      }

      this.client = new (launcherLib().Client)();
      this.launchStartTime = Date.now();

      let lastDebug = '';
      this.client.on('debug', (msg) => {
        lastDebug = String(msg);
        log('debug', lastDebug);
      });

      this.client.on('data', (data) => {
        const text = String(data).trim();
        if (text) log('stdout', text);
      });

      this.client.on('download-status', (status) => {
        if (!onProgress || !status) return;
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

      this.client.on('close', (code) => {
        const durationSeconds = Math.round((Date.now() - this.launchStartTime) / 1000);
        this.isRunning = false;
        this.gameProcess = null;
        log('info', t('Процесс игры завершен (Код: {code}, Время игры: {m}м {s}с)', { code, m: Math.floor(durationSeconds / 60), s: durationSeconds % 60 }));
        onClose && onClose(code, durationSeconds);
      });

      // MCLC does not throw on failure: it emits a debug message and resolves with null.
      const processHandle = await this.client.launch(mclOptions);
      if (!processHandle) {
        const reason = lastDebug.replace(/^\[MCLC\]:\s*/, '') || t('неизвестная ошибка');
        throw new Error(reason);
      }

      this.gameProcess = processHandle;
      this.isRunning = true;
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
  LauncherCore
};
