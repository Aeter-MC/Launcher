/**
 * disk-cache.js
 * Small JSON files in userData/mcl-cache that survive restarts (version list, Java list, mod hashes).
 */
const fs = require('fs');
const path = require('path');

class DiskCache {
  constructor(dir) {
    this.dir = dir;
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {}
    this.timers = new Map();
  }

  file(name) {
    return path.join(this.dir, `${name}.json`);
  }

  read(name) {
    try {
      return JSON.parse(fs.readFileSync(this.file(name), 'utf-8'));
    } catch (e) {
      return null;
    }
  }

  write(name, data) {
    try {
      const tmp = `${this.file(name)}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, this.file(name));
    } catch (e) {}
  }

  /** Coalesces frequent writes (e.g. many hashes in a row) into one. */
  writeLater(name, getData, delay = 1500) {
    clearTimeout(this.timers.get(name));
    this.timers.set(name, setTimeout(() => this.write(name, getData()), delay));
  }
}

module.exports = { DiskCache };
