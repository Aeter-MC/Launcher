/**
 * accounts-manager.js
 * manages player accounts: Offline, Microsoft OAuth, and Ely.by (authlib-injector).
 * accounts.json stays readable, but tokens are kept in an encrypted `secret` field
 * using a private profile key on Linux and system storage elsewhere.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { safeStorage } = require('electron');
const { MicrosoftAuth, toMclcAuth } = require('./microsoft-auth');
const { ElyByManager } = require('./elyby-manager');
const { t } = require('./i18n/i18n');

// account fields that go into the encrypted `secret`
const SECRET_FIELDS = {
  microsoft: ['mclcAuth'],
  elyby: ['accessToken', 'clientToken']
};
const LOCAL_SECRET_PREFIX = 'local-v1:';
// all the window gets: tokens never leave the main process
const PUBLIC_FIELDS = ['id', 'type', 'username', 'uuid', 'skinUrl', 'createdAt'];
const rejectedMicrosoftSessions = new WeakSet();

function needsMicrosoftSignIn(acc) {
  if (acc.type !== 'microsoft') return false;
  const auth = acc.mclcAuth;
  return rejectedMicrosoftSessions.has(acc) || !auth?.access_token ||
    ((!auth.meta?.exp || auth.meta.exp <= Date.now()) && !auth.meta?.refresh);
}

function publicAccount(acc) {
  if (!acc) return null;
  const out = {};
  for (const key of PUBLIC_FIELDS) if (key in acc) out[key] = acc[key];
  if (acc.type === 'microsoft') out.sessionExpired = needsMicrosoftSignIn(acc);
  return out;
}

/** true when Microsoft's login server resolves and answers within a few seconds. */
async function isOnline() {
  try {
    await require('axios').head('https://login.live.com/', { timeout: 4000, validateStatus: () => true });
    return true;
  } catch (e) {
    return false;
  }
}

class AccountsManager {
  constructor(userDataDir, gameDir) {
    this.filePath = path.join(userDataDir, 'accounts.json');
    this.keyPath = path.join(userDataDir, 'accounts.key');
    this.elyByManager = new ElyByManager(gameDir);
    this.msAuth = new MicrosoftAuth();
    this._data = null;
    // set when accounts.json exists but can't be read or moved aside: then nothing is written over it
    this.readOnly = false;
  }

  // loaded on first use: safeStorage can only decrypt once the app is ready
  get data() {
    if (!this._data) this._data = this.load();
    return this._data;
  }

  set data(value) {
    this._data = value;
  }

  setGameDir(dir) {
    this.elyByManager.setGameDir(dir);
  }

  load() {
    let raw = null;
    try {
      raw = fs.readFileSync(this.filePath, 'utf-8');
    } catch (e) {
      if (e.code !== 'ENOENT') {
        console.error('[AccountsManager] Failed to read accounts:', e.message);
        this.readOnly = true;
      }
    }

    if (raw !== null) {
      try {
        const data = JSON.parse(raw);
        if (!data || !Array.isArray(data.accounts)) throw new Error('unexpected format');
        data.accounts.forEach(acc => this.openSecret(acc));
        return data;
      } catch (e) {
        console.error('[AccountsManager] Failed to read accounts:', e.message);
        // keep the broken file for recovery instead of overwriting it with the default account
        try {
          fs.renameSync(this.filePath, `${this.filePath}.broken-${Date.now()}`);
        } catch (err) {
          this.readOnly = true;
        }
      }
    }

    // default offline account
    const defaultAccount = {
      id: 'default-offline',
      type: 'offline',
      username: 'Steve',
      uuid: 'e9df5bd1-28bb-31c6-8eb0-4ad41f47d874',
      skinUrl: 'https://mc-heads.net/avatar/Steve/64',
      createdAt: Date.now()
    };

    const initial = {
      activeAccountId: defaultAccount.id,
      accounts: [defaultAccount]
    };
    this.save(initial);
    return initial;
  }

  save(data = this.data) {
    if (this.readOnly) return false;
    const tmp = `${this.filePath}.${crypto.randomUUID()}.tmp`;
    try {
      const onDisk = { ...data, accounts: data.accounts.map(acc => this.sealSecret(acc)) };
      // written next to it and swapped in one step, so a crash mid-write can't leave a half-written file.
      fs.writeFileSync(tmp, JSON.stringify(onDisk, null, 2), { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
      fs.renameSync(tmp, this.filePath);
      this.data = data;
      return true;
    } catch (e) {
      console.error('[AccountsManager] Error saving accounts:', e.message);
      try { fs.rmSync(tmp, { force: true }); } catch {}
      return false;
    }
  }

  localKey(create = false) {
    if (create && !fs.existsSync(this.keyPath)) {
      try {
        fs.writeFileSync(this.keyPath, crypto.randomBytes(32), { mode: 0o600, flag: 'wx' });
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
    }
    const key = fs.readFileSync(this.keyPath);
    if (key.length !== 32) throw new Error('Invalid local account key');
    return key;
  }

  encryptTokens(tokens) {
    const json = JSON.stringify(tokens);
    if (process.platform !== 'linux') {
      return safeStorage.encryptString(json).toString('base64');
    }

    // keep Linux logins readable across sessions with different keyring availability.
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.localKey(true), nonce);
    const ciphertext = Buffer.concat([cipher.update(json, 'utf-8'), cipher.final()]);
    return LOCAL_SECRET_PREFIX + Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64');
  }

  decryptTokens(secret) {
    if (!secret.startsWith(LOCAL_SECRET_PREFIX)) {
      return safeStorage.decryptString(Buffer.from(secret, 'base64'));
    }
    const payload = Buffer.from(secret.slice(LOCAL_SECRET_PREFIX.length), 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.localKey(), payload.subarray(0, 12));
    decipher.setAuthTag(payload.subarray(12, 28));
    return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString('utf-8');
  }

  /** puts the decrypted tokens back on the account; keeps `secret` as is if it can't be decrypted (another PC or Windows user). */
  openSecret(acc) {
    if (!acc.secret) return;
    try {
      Object.assign(acc, JSON.parse(this.decryptTokens(acc.secret)));
      delete acc.secret;
    } catch (e) {
      console.error(`[AccountsManager] Failed to decrypt tokens of ${acc.username}:`, e.message);
    }
  }

  /** copy of the account for the file, with its tokens moved into the encrypted `secret`. */
  sealSecret(acc) {
    const copy = { ...acc };
    const tokens = {};
    for (const key of SECRET_FIELDS[acc.type] || []) {
      if (key in copy) {
        tokens[key] = copy[key];
        delete copy[key];
      }
    }
    if (Object.keys(tokens).length === 0) return copy;
    copy.secret = this.encryptTokens(tokens);
    return copy;
  }

  getAccounts() {
    return {
      activeAccountId: this.data.activeAccountId,
      accounts: (this.data.accounts || []).map(publicAccount)
    };
  }

  getActiveAccount() {
    const list = this.data.accounts || [];
    const active = list.find(a => a.id === this.data.activeAccountId);
    return active || list[0] || null;
  }

  setActiveAccount(id) {
    const found = this.data.accounts.find(a => a.id === id);
    if (!found) throw new Error(t('Аккаунт не найден'));
    this.data.activeAccountId = id;
    this.save();
    return publicAccount(found);
  }

  addOfflineAccount(username) {
    const cleanName = (username || '').trim() || 'Player';
    const uuid = crypto.createHash('md5').update('OfflinePlayer:' + cleanName).digest('hex');

    // check if offline account with this username already exists
    let existing = this.data.accounts.find(a => a.type === 'offline' && a.username.toLowerCase() === cleanName.toLowerCase());
    if (existing) {
      this.data.activeAccountId = existing.id;
      this.save();
      return existing;
    }

    const newAcc = {
      id: crypto.randomUUID(),
      type: 'offline',
      username: cleanName,
      uuid: uuid,
      skinUrl: `https://mc-heads.net/avatar/${cleanName}/64`,
      createdAt: Date.now()
    };

    this.data.accounts.push(newAcc);
    this.data.activeAccountId = newAcc.id;
    this.save();
    return newAcc;
  }

  /**
   * step 1 of Microsoft login: get a code for microsoft.com/link.
   */
  async startMicrosoftLogin() {
    this.msAuth.cancel();
    try {
      this.msCode = await this.msAuth.requestDeviceCode();
    } catch (e) {
      throw new Error(t('Не удалось связаться с Microsoft: {error}', { error: e.message }));
    }
    return this.msCode;
  }

  /**
   * step 2: wait until the user signs in, then create/update the account.
   */
  async finishMicrosoftLogin() {
    if (!this.msCode) throw new Error(t('Вход не начат'));
    const code = this.msCode;
    this.msCode = null;

    const msToken = await this.msAuth.pollForToken(code);
    const result = await this.msAuth.loginToMinecraft(msToken);
    return publicAccount(this.saveMicrosoftAccount(result));
  }

  cancelMicrosoftLogin() {
    this.msAuth.cancel();
    this.msCode = null;
  }

  saveMicrosoftAccount(result) {
    const { profile } = result;
    const existing = this.data.accounts.find(a => a.type === 'microsoft' && a.uuid === profile.id);
    const accData = {
      id: existing ? existing.id : crypto.randomUUID(),
      type: 'microsoft',
      username: profile.name,
      uuid: profile.id,
      mclcAuth: toMclcAuth(result),
      createdAt: existing ? existing.createdAt : Date.now()
    };

    const accounts = existing
      ? this.data.accounts.map(account => account === existing ? { ...existing, ...accData } : account)
      : [...this.data.accounts, accData];
    if (!this.save({ ...this.data, accounts, activeAccountId: accData.id })) {
      throw new Error(t('Не удалось сохранить вход Microsoft'));
    }
    return accData;
  }

  /**
   * returns the active account with fresh tokens, ready for launching.
   */
  async getLaunchAccount(onWarn = () => {}) {
    const acc = this.getActiveAccount();
    if (!acc) return null;

    // tokens stay encrypted when the file came from another PC or Windows user
    if (acc.type === 'microsoft' && needsMicrosoftSignIn(acc)) {
      throw new Error(t('Сессия Microsoft истекла. Войдите в аккаунт заново.'));
    }
    if (acc.type === 'elyby' && !acc.accessToken) {
      throw new Error(t('Сохранённый вход недоступен на этом компьютере. Войдите в аккаунт заново.'));
    }

    if (acc.type === 'microsoft' && acc.mclcAuth) {
      const meta = acc.mclcAuth.meta || {};
      // refresh a few minutes before expiry; accounts saved by msmc use the same client id and token format
      if (!meta.exp || meta.exp - Date.now() < 5 * 60 * 1000) {
        if (!meta.refresh) {
          // keep using a valid token until it actually expires.
          return acc;
        }
        try {
          const msToken = await this.msAuth.refreshMicrosoftToken(meta.refresh);
          const result = await this.msAuth.loginToMinecraft(msToken);
          this.saveMicrosoftAccount(result);
          return this.getActiveAccount();
        } catch (e) {
          if (e.code === 'MICROSOFT_SESSION_EXPIRED') {
            rejectedMicrosoftSessions.add(acc);
            throw e;
          }
          // without internet the old token still starts the game: single player works,
          // servers will ask to log in again. Online, a failed refresh means the session is really gone.
          if (await isOnline()) throw e;
          onWarn(t('Нет связи с серверами Microsoft — игра запустится со старым входом. Одиночная игра работает, на серверы зайти не получится.'));
          return acc;
        }
      }
    } else if (acc.type === 'elyby' && acc.accessToken) {
      const refreshed = await this.elyByManager.refreshIfNeeded(acc);
      if (refreshed) {
        Object.assign(acc, refreshed);
        this.save();
      }
    }
    return acc;
  }

  async loginElyBy(usernameOrEmail, password) {
    const account = await this.elyByManager.authenticate(usernameOrEmail, password);

    let existing = this.data.accounts.find(a => a.type === 'elyby' && a.uuid === account.uuid);
    if (existing) {
      Object.assign(existing, account);
    } else {
      this.data.accounts.push(account);
    }

    this.data.activeAccountId = account.id;
    this.save();
    return publicAccount(account);
  }

  removeAccount(id) {
    this.data.accounts = this.data.accounts.filter(a => a.id !== id);
    if (this.data.accounts.length === 0) {
      this.addOfflineAccount('Steve');
    } else if (this.data.activeAccountId === id) {
      this.data.activeAccountId = this.data.accounts[0].id;
    }
    this.save();
    return true;
  }
}

module.exports = {
  AccountsManager
};
