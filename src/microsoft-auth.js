/**
 * microsoft-auth.js
 * Microsoft account login via the device code flow (like Prism Launcher):
 * the user opens microsoft.com/link (or scans a QR code), enters a short code,
 * and the launcher polls until the sign-in completes.
 * Then: Microsoft token -> Xbox Live -> XSTS -> Minecraft token -> profile.
 */
const axios = require('axios');

// Same public client id the official launcher (and msmc) uses, so older refresh tokens keep working
const CLIENT_ID = '00000000402b5328';
const SCOPE = 'service::user.auth.xboxlive.com::MBI_SSL';
const DEVICE_CODE_URL = 'https://login.live.com/oauth20_connect.srf';
const TOKEN_URL = 'https://login.live.com/oauth20_token.srf';

const form = (data) => new URLSearchParams(data).toString();
const FORM_HEADERS = { 'Content-Type': 'application/x-www-form-urlencoded' };
const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' };

const XSTS_ERRORS = {
  2148916233: 'У этого аккаунта Microsoft нет профиля Xbox. Зайдите на xbox.com и создайте его.',
  2148916235: 'Xbox Live недоступен в вашей стране.',
  2148916236: 'Аккаунт требует подтверждения возраста на xbox.com.',
  2148916237: 'Аккаунт требует подтверждения возраста на xbox.com.',
  2148916238: 'Это детский аккаунт — его нужно добавить в семейную группу на account.microsoft.com.'
};

class LoginCancelled extends Error {
  constructor() {
    super('Вход отменён');
    this.cancelled = true;
  }
}

class MicrosoftAuth {
  constructor() {
    this.pending = null;
  }

  /** Requests a device code. Returns { userCode, verificationUri, linkUrl, expiresIn, interval, deviceCode }. */
  async requestDeviceCode() {
    const res = await axios.post(DEVICE_CODE_URL, form({
      client_id: CLIENT_ID,
      scope: SCOPE,
      response_type: 'device_code'
    }), { headers: FORM_HEADERS, timeout: 15000 });
    const d = res.data;
    return {
      userCode: d.user_code,
      deviceCode: d.device_code,
      verificationUri: d.verification_uri,
      linkUrl: `${d.verification_uri}?otc=${encodeURIComponent(d.user_code)}`,
      expiresIn: d.expires_in,
      interval: d.interval || 5
    };
  }

  /** Polls the token endpoint until the user finishes signing in. */
  async pollForToken(code) {
    const session = { cancelled: false };
    this.pending = session;
    const deadline = Date.now() + code.expiresIn * 1000;
    let interval = code.interval * 1000;

    try {
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, interval));
        if (session.cancelled) throw new LoginCancelled();

        const res = await axios.post(TOKEN_URL, form({
          client_id: CLIENT_ID,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: code.deviceCode
        }), { headers: FORM_HEADERS, timeout: 15000, validateStatus: () => true });

        if (session.cancelled) throw new LoginCancelled();
        if (res.status === 200 && res.data.access_token) return res.data;

        const err = res.data && res.data.error;
        if (err === 'authorization_pending') continue;
        if (err === 'slow_down') { interval += 5000; continue; }
        if (err === 'authorization_declined') throw new Error('Вход отклонён в окне Microsoft');
        if (err === 'expired_token') break;
        throw new Error(`Microsoft: ${(res.data && (res.data.error_description || err)) || res.status}`);
      }
      throw new Error('Код истёк. Попробуйте войти ещё раз.');
    } finally {
      if (this.pending === session) this.pending = null;
    }
  }

  cancel() {
    if (this.pending) this.pending.cancelled = true;
  }

  async refreshMicrosoftToken(refreshToken) {
    const res = await axios.post(TOKEN_URL, form({
      client_id: CLIENT_ID,
      scope: SCOPE,
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    }), { headers: FORM_HEADERS, timeout: 15000, validateStatus: () => true });
    if (res.status !== 200 || !res.data.access_token) {
      throw new Error('Сессия Microsoft истекла. Войдите в аккаунт заново.');
    }
    return res.data;
  }

  /** Microsoft token -> Minecraft access token + profile. */
  async loginToMinecraft(msToken) {
    // Live tokens are accepted with "d=" by most accounts, some only with "t=": try both
    let xbl;
    for (const prefix of ['d=', 't=']) {
      try {
        xbl = await axios.post('https://user.auth.xboxlive.com/user/authenticate', {
          Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: prefix + msToken.access_token },
          RelyingParty: 'http://auth.xboxlive.com',
          TokenType: 'JWT'
        }, { headers: JSON_HEADERS, timeout: 15000 });
        break;
      } catch (e) {
        if (prefix === 't=' || !e.response) throw new Error(`Ошибка входа в Xbox Live: ${e.response ? e.response.status : e.message}`);
      }
    }

    const userHash = xbl.data.DisplayClaims.xui[0].uhs;

    let xsts;
    try {
      xsts = await axios.post('https://xsts.auth.xboxlive.com/xsts/authorize', {
        Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.data.Token] },
        RelyingParty: 'rp://api.minecraftservices.com/',
        TokenType: 'JWT'
      }, { headers: JSON_HEADERS, timeout: 15000 });
    } catch (e) {
      const xerr = e.response && e.response.data && e.response.data.XErr;
      throw new Error(XSTS_ERRORS[xerr] || `Ошибка Xbox Live: ${xerr || e.message}`);
    }

    const mc = await axios.post('https://api.minecraftservices.com/authentication/login_with_xbox', {
      identityToken: `XBL3.0 x=${userHash};${xsts.data.Token}`
    }, { headers: JSON_HEADERS, timeout: 15000 });

    let profile;
    try {
      const res = await axios.get('https://api.minecraftservices.com/minecraft/profile', {
        headers: { Authorization: `Bearer ${mc.data.access_token}` },
        timeout: 15000
      });
      profile = res.data;
    } catch (e) {
      if (e.response && e.response.status === 404) {
        throw new Error('На этом аккаунте Microsoft не куплен Minecraft: Java Edition.');
      }
      throw e;
    }

    return {
      accessToken: mc.data.access_token,
      expiresAt: Date.now() + (mc.data.expires_in || 86400) * 1000,
      refreshToken: msToken.refresh_token,
      profile: { id: profile.id, name: profile.name }
    };
  }
}

/** The Minecraft access token is a JWT whose payload carries the player's Xbox user id. Returns '' if it can't be read. */
function xuidFromToken(accessToken) {
  try {
    const payload = JSON.parse(Buffer.from(String(accessToken).split('.')[1], 'base64url').toString('utf-8'));
    return payload.xuid ? String(payload.xuid) : '';
  } catch (e) {
    return '';
  }
}

/** Auth object in the format minecraft-launcher-core expects. */
function toMclcAuth(result) {
  return {
    access_token: result.accessToken,
    client_token: result.profile.id,
    uuid: result.profile.id,
    name: result.profile.name,
    user_properties: '{}',
    meta: { type: 'msa', demo: false, xuid: xuidFromToken(result.accessToken), exp: result.expiresAt, refresh: result.refreshToken }
  };
}

module.exports = {
  MicrosoftAuth,
  toMclcAuth,
  xuidFromToken
};
