/**
 * elyby-manager.js
 * Handles Ely.by authentication via Yggdrasil API and manages authlib-injector.jar.
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const { t } = require('./i18n/i18n');

const AUTHLIB_INJECTOR_URL = 'https://github.com/yushijinhun/authlib-injector/releases/download/v1.2.5/authlib-injector-1.2.5.jar';
const ELY_AUTH_URL = 'https://authserver.ely.by/auth/authenticate';
const ELY_VALIDATE_URL = 'https://authserver.ely.by/auth/validate';
const ELY_REFRESH_URL = 'https://authserver.ely.by/auth/refresh';
const ELY_API_URL = 'https://authserver.ely.by/api/authlib-injector';

class ElyByManager {
  constructor(gameDir) {
    this.gameDir = gameDir;
  }

  setGameDir(dir) {
    this.gameDir = dir;
  }

  getInjectorPath() {
    return path.join(this.gameDir, 'authlib-injector.jar');
  }

  /**
   * Ensures authlib-injector.jar is downloaded into gameDir.
   */
  async ensureInjector() {
    const jarPath = this.getInjectorPath();
    if (fs.existsSync(jarPath) && fs.statSync(jarPath).size > 50000) {
      return jarPath;
    }

    if (!fs.existsSync(this.gameDir)) {
      try {
        fs.mkdirSync(this.gameDir, { recursive: true });
      } catch (e) {}
    }

    try {
      const res = await axios.get(AUTHLIB_INJECTOR_URL, {
        responseType: 'arraybuffer',
        timeout: 15000
      });
      fs.writeFileSync(jarPath, Buffer.from(res.data));
      return jarPath;
    } catch (e) {
      console.error('[ElyByManager] Failed to download authlib-injector:', e.message);
      throw new Error(t('Не удалось загрузить authlib-injector.jar: {error}', { error: e.message }));
    }
  }

  /**
   * Authenticates with Ely.by credentials.
   */
  async authenticate(usernameOrEmail, password) {
    const clientToken = crypto.randomUUID();

    try {
      const response = await axios.post(ELY_AUTH_URL, {
        agent: {
          name: 'Minecraft',
          version: 1
        },
        username: usernameOrEmail,
        password: password,
        clientToken: clientToken,
        requestUser: true
      }, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000
      });

      const data = response.data;
      const profile = data.selectedProfile || (data.availableProfiles && data.availableProfiles[0]);

      if (!profile) {
        throw new Error(t('Профиль Ely.by не найден для данного аккаунта.'));
      }

      // Download injector in advance
      await this.ensureInjector();

      return {
        id: crypto.randomUUID(),
        type: 'elyby',
        username: profile.name,
        uuid: profile.id,
        accessToken: data.accessToken,
        clientToken: data.clientToken || clientToken,
        userProperties: JSON.stringify(data.user?.properties || {}),
        skinUrl: `https://ely.by/services/skins-renderer?url=http://skinsystem.ely.by/skins/${encodeURIComponent(profile.name)}.png&scale=8&renderFace=1`,
        createdAt: Date.now()
      };
    } catch (err) {
      if (err.response && err.response.data && err.response.data.errorMessage) {
        throw new Error(err.response.data.errorMessage);
      }
      throw new Error(t('Ошибка входа Ely.by: {error}', { error: err.message }));
    }
  }

  /**
   * Validates the access token and refreshes it if it has expired.
   * Returns updated token fields, or null when nothing changed.
   */
  async refreshIfNeeded(account) {
    try {
      await axios.post(ELY_VALIDATE_URL, { accessToken: account.accessToken }, { timeout: 8000 });
      return null;
    } catch (e) {
      if (!e.response) return null; // offline: let the game try with the old token
    }

    try {
      const res = await axios.post(ELY_REFRESH_URL, {
        accessToken: account.accessToken,
        clientToken: account.clientToken,
        requestUser: true
      }, { timeout: 10000 });
      return {
        accessToken: res.data.accessToken,
        clientToken: res.data.clientToken || account.clientToken
      };
    } catch (e) {
      throw new Error(t('Сессия Ely.by истекла. Войдите в аккаунт заново.'));
    }
  }

  /**
   * Returns JVM arguments required for Ely.by injection.
   */
  async getJvmArgs() {
    const jarPath = await this.ensureInjector();
    return `-javaagent:${jarPath}=${ELY_API_URL}`;
  }
}

module.exports = {
  ElyByManager
};
