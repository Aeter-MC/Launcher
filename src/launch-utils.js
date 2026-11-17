const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function quoteWindows(value) {
  return '"' + String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
}

function pngsToIco(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, index) => {
    const at = 6 + index * 16;
    header[at] = header[at + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(png.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map(image => image.png)]);
}

function acquireLaunchLock(gameDir) {
  fs.mkdirSync(gameDir, { recursive: true });
  const file = path.join(gameDir, '.aetermc-launch.lock');
  const token = crypto.randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try {
      fd = fs.openSync(file, 'wx');
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token }));
      fs.closeSync(fd);
      return () => {
        try { if (JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.unlinkSync(file); } catch (_) {}
      };
    } catch (err) {
      if (fd !== undefined) fs.closeSync(fd);
      if (err.code !== 'EEXIST') throw err;
      let live = true;
      try {
        const lock = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!Number.isInteger(lock.pid) || lock.pid <= 0) throw new Error('Invalid launch lock');
        try { process.kill(lock.pid, 0); } catch (e) { if (e.code === 'ESRCH') live = false; }
      } catch (_) {
        // a concurrent writer may not have finished; do not remove a fresh lock.
        live = Date.now() - fs.statSync(file).mtimeMs < 60000;
      }
      if (live) throw new Error('This instance is already running or being prepared');
      try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  }
  throw new Error('Could not lock the instance');
}

module.exports = { quoteWindows, acquireLaunchLock, pngsToIco };
