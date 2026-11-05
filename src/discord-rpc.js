/**
 * discord-rpc.js
 * Discord Rich Presence over Discord's local IPC pipe, without a library:
 * a frame is opcode (int32 LE) + length (int32 LE) + JSON. The connection is opened when the
 * game starts and closed when it ends, so a launcher in the background talks to Discord only
 * while someone plays. When Discord is not running every call quietly does nothing.
 */
const net = require('net');
const path = require('path');

// Discord application "AeterMC" (discord.com/developers/applications): its name is the "Играет в …" title
const CLIENT_ID = process.env.AETERMC_DISCORD_ID || '1567886541823545375';

// a URL works as an image key: Discord shows it through its media proxy
const LOGO_URL = 'https://raw.githubusercontent.com/Aeter-MC/Launcher/main/assets/icon.png';

const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_CLOSE = 2;
const OP_PING = 3;
const OP_PONG = 4;

function pipePath(n) {
  if (process.platform === 'win32') return `\\\\?\\pipe\\discord-ipc-${n}`;
  const dir = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || '/tmp';
  return path.join(dir, `discord-ipc-${n}`);
}

function encode(op, data) {
  const json = Buffer.from(JSON.stringify(data), 'utf-8');
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(json.length, 4);
  return Buffer.concat([head, json]);
}

/** Connects to the first pipe Discord answers on (it uses 0..9 when several clients run). */
function connectPipe(n = 0) {
  return new Promise((resolve, reject) => {
    if (n > 9) return reject(new Error('Discord is not running'));
    const socket = net.createConnection(pipePath(n));
    const fail = () => {
      socket.destroy();
      connectPipe(n + 1).then(resolve, reject);
    };
    socket.once('connect', () => {
      socket.off('error', fail);
      resolve(socket);
    });
    socket.once('error', fail);
  });
}

class DiscordPresence {
  constructor(clientId = CLIENT_ID) {
    this.clientId = clientId;
    this.socket = null;
    this.ready = null; // promise of the handshake
    this.buffer = Buffer.alloc(0);
    this.nonce = 0;
    this.user = null;
  }

  get available() {
    return !!this.clientId;
  }

  /** Opens the pipe and does the handshake; resolves once Discord sends READY. */
  connect() {
    if (!this.available) return Promise.reject(new Error('No Discord application id'));
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const socket = await connectPipe();
      this.socket = socket;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Discord did not answer')), 5000);
        this.onReady = (user) => {
          clearTimeout(timer);
          resolve(user);
        };
        this.onFail = (err) => {
          clearTimeout(timer);
          reject(err);
        };
        socket.on('data', (chunk) => this.read(chunk));
        socket.on('close', () => this.reset(new Error('Discord closed the connection')));
        socket.on('error', () => {});
        socket.write(encode(OP_HANDSHAKE, { v: 1, client_id: this.clientId }));
      });
    })();
    this.ready.catch(() => this.reset());
    return this.ready;
  }

  read(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 8) {
      const op = this.buffer.readInt32LE(0);
      const len = this.buffer.readInt32LE(4);
      if (this.buffer.length < 8 + len) return;
      let data = null;
      try {
        data = JSON.parse(this.buffer.subarray(8, 8 + len).toString('utf-8'));
      } catch (e) {}
      this.buffer = this.buffer.subarray(8 + len);
      this.handle(op, data);
    }
  }

  handle(op, data) {
    if (op === OP_PING) {
      if (this.socket) this.socket.write(encode(OP_PONG, data));
    } else if (op === OP_CLOSE) {
      // e.g. { code: 4000, message: 'Invalid Client ID' }
      this.reset(new Error((data && data.message) || 'Discord closed the connection'));
    } else if (op === OP_FRAME && data) {
      if (data.evt === 'READY') {
        this.user = data.data && data.data.user;
        if (this.onReady) this.onReady(this.user);
      } else if (data.evt === 'ERROR') {
        console.warn('[Discord]', data.data && data.data.message);
      }
    }
  }

  reset(err) {
    if (this.onFail && err) this.onFail(err);
    this.onReady = this.onFail = null;
    if (this.socket) this.socket.destroy();
    this.socket = null;
    this.ready = null;
    this.buffer = Buffer.alloc(0);
  }

  send(cmd, args) {
    if (!this.socket) return;
    this.socket.write(encode(OP_FRAME, { cmd, args, nonce: String(++this.nonce) }));
  }

  /**
   * Shows "Играет в AeterMC": details / state are the two lines under the title,
   * start is the session start (ms) Discord counts the time from.
   */
  async setActivity({ details, state, start, largeText }) {
    try {
      await this.connect();
    } catch (e) {
      return false;
    }
    const activity = {
      type: 0,
      details: String(details || '').slice(0, 128) || undefined,
      state: String(state || '').slice(0, 128) || undefined,
      timestamps: start ? { start: Math.floor(start / 1000) } : undefined,
      assets: { large_image: LOGO_URL, large_text: largeText || 'AeterMC' },
      instance: false
    };
    this.send('SET_ACTIVITY', { pid: process.pid, activity });
    return true;
  }

  /** Clears the status and closes the pipe. */
  clear() {
    if (!this.socket) return;
    this.send('SET_ACTIVITY', { pid: process.pid });
    const socket = this.socket;
    // give Discord the frame before closing
    setTimeout(() => {
      if (this.socket === socket) this.reset();
    }, 300);
  }
}

module.exports = { DiscordPresence, CLIENT_ID };
