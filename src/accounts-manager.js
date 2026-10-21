/**
 * accounts-manager.js
 * Manages player accounts: Offline, Microsoft OAuth, and Ely.by (authlib-injector).
 * accounts.json stays readable, but tokens are kept in an encrypted `secret` field
 * (safeStorage: DPAPI on Windows, so they only decrypt under the same Windows user).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { safeStorage } = require('electron');
const { MicrosoftAuth, toMclcAuth } = require('./microsoft-auth');
const { ElyByManager } = require('./elyby-manager');

// Account fields that go into the encrypted `secret`
const SECRET_FIELDS = {
  microsoft: ['mclcAuth'],
  elyby: ['accessToken', 'clientToken']
};
// All the window gets: tokens never leave the main process
const PUBLIC_FIELDS = ['id', 'type', 'username', 'uuid', 'skinUrl', 'createdAt'];

function publicAccount(acc) {
  if (!acc) return null;
  const out = {};
  for (const key of PUBLIC_FIELDS) if (key in acc) out[key] = acc[key];
  return out;
}

class AccountsManager {
  constructor(userDataDir, gameDir) {
    this.filePath = path.join(userDataDir, 'accounts.json');
    this.elyByManager = new ElyByManager(gameDir);
    this.msAuth = new MicrosoftAuth();
    this._data = null;
    // Set when accounts.json exists but can't be read or moved aside: then nothing is written over it
    this.readOnly = false;
  }

  // Loaded on first use: safeStorage can only decrypt once the app is ready
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
        // Keep the broken file for recovery instead of overwriting it with the default account
        try {
          fs.renameSync(this.filePath, `${this.filePath}.broken-${Date.now()}`);
        } catch (err) {
          this.readOnly = true;
        }
      }
    }

    // Default offline account
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
    this.data = data;
    if (this.readOnly) return false;
    try {
      const onDisk = { ...data, accounts: data.accounts.map(acc => this.sealSecret(acc)) };
      // Written next to it and swapped in one step, so a crash mid-write can't leave a half-written file
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(onDisk, null, 2), 'utf-8');
      fs.renameSync(tmp, this.filePath);
      return true;
    } catch (e) {
      console.error('[AccountsManager] Error saving accounts:', e.message);
      return false;
    }
  }

  /** Puts the decrypted tokens back on the account; keeps `secret` as is if it can't be decrypted (another PC or Windows user). */
  openSecret(acc) {
    if (!acc.secret) return;
    try {
      Object.assign(acc, JSON.parse(safeStorage.decryptString(Buffer.from(acc.secret, 'base64'))));
      delete acc.secret;
    } catch (e) {
      console.error(`[AccountsManager] Failed to decrypt tokens of ${acc.username}:`, e.message);
    }
  }

  /** Copy of the account for the file, with its tokens moved into the encrypted `secret`. */
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
    copy.secret = safeStorage.encryptString(JSON.stringify(tokens)).toString('base64');
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
    if (!found) throw new Error('Аккаунт не найден');
    this.data.activeAccountId = id;
    this.save();
    return publicAccount(found);
  }

  addOfflineAccount(username) {
    const cleanName = (username || '').trim() || 'Player';
    const uuid = crypto.createHash('md5').update('OfflinePlayer:' + cleanName).digest('hex');

    // Check if offline account with this username already exists
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
   * Step 1 of Microsoft login: get a code for microsoft.com/link.
   */
  async startMicrosoftLogin() {
    this.msAuth.cancel();
    try {
      this.msCode = await this.msAuth.requestDeviceCode();
    } catch (e) {
      throw new Error(`Не удалось связаться с Microsoft: ${e.message}`);
    }
    return this.msCode;
  }

  /**
   * Step 2: wait until the user signs in, then create/update the account.
   */
  async finishMicrosoftLogin() {
    if (!this.msCode) throw new Error('Вход не начат');
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

    if (existing) {
      Object.assign(existing, accData);
    } else {
      this.data.accounts.push(accData);
    }
    this.data.activeAccountId = accData.id;
    this.save();
    return accData;
  }

  /**
   * Returns the active account with fresh tokens, ready for launching.
   */
  async getLaunchAccount() {
    const acc = this.getActiveAccount();
    if (!acc) return null;

    // Tokens stay encrypted when the file came from another PC or Windows user
    if ((acc.type === 'microsoft' && !acc.mclcAuth) || (acc.type === 'elyby' && !acc.accessToken)) {
      throw new Error('Сохранённый вход недоступен на этом компьютере. Войдите в аккаунт заново.');
    }

    if (acc.type === 'microsoft' && acc.mclcAuth) {
      const meta = acc.mclcAuth.meta || {};
      // Refresh a few minutes before expiry; accounts saved by msmc use the same client id and token format
      if (!meta.exp || meta.exp - Date.now() < 5 * 60 * 1000) {
        if (!meta.refresh) {
          throw new Error('Сессия Microsoft истекла. Войдите в аккаунт заново.');
        }
        const msToken = await this.msAuth.refreshMicrosoftToken(meta.refresh);
        const result = await this.msAuth.loginToMinecraft(msToken);
        this.saveMicrosoftAccount(result);
        return this.getActiveAccount();
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
