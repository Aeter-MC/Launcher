'use strict';
const fs = require('node:fs');
const path = require('node:path');
const AdmZip = require('adm-zip');

const MiB = 1024 * 1024;
function zipPath(name) {
  if (typeof name !== 'string' || !name || name.length > 4096 || /[\\<>:"|?*\x00-\x1f]/.test(name)) return false;
  return name.split('/').every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part) &&
    !/^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³]) *(?:\.|$)/i.test(part));
}
function checkedDestination(root, relative) {
  if (!zipPath(relative)) return null;
  const base = path.resolve(root), full = path.resolve(base, relative), rel = path.relative(base, full);
  if (!rel || path.isAbsolute(rel) || rel === '..' || rel.startsWith('..' + path.sep)) return null;
  for (let p = full; ; p = path.dirname(p)) {
    try { if (fs.lstatSync(p).isSymbolicLink()) return null; } catch (error) { if (error.code !== 'ENOENT') return null; }
    if (p === path.dirname(p)) break;
  }
  return full;
}
function openCheckedZip(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > 768 * MiB) throw new Error('Invalid or oversized ZIP file');
  const zip = new AdmZip(file);
  const entries = zip.getEntries();
  if (entries.length > 50000) throw new Error('Too many ZIP entries');
  const destinations = new Set(); let total = 0;
  for (const entry of entries) {
    const name = entry.isDirectory ? entry.entryName.replace(/\/$/, '') : entry.entryName;
    const key = name.toLowerCase();
    if (!zipPath(name) || destinations.has(key)) throw new Error('Invalid or duplicate ZIP path');
    destinations.add(key);
    const mode = (entry.attr >>> 16) & 0xf000;
    if ((mode && mode !== 0x8000 && mode !== 0x4000) || (entry.attr & 0x400)) throw new Error('Linked or special ZIP entry');
    const { size, compressedSize, method, encrypted } = entry.header;
    total += size;
    if (encrypted || ![0, 8].includes(method) || size > 256 * MiB || total > 2048 * MiB ||
      (size > 0 && compressedSize === 0) || size > Math.max(MiB, compressedSize * 1500) ||
      (method === 0 && size !== compressedSize)) throw new Error('Unsupported ZIP entry or expansion limit exceeded');
  }
  return zip;
}
function checkedEntry(entry, limit = 256 * MiB) {
  if (!entry || entry.isDirectory || entry.header.size > limit || (entry.header.size === 0 && entry.header.method === 8)) throw new Error('Invalid ZIP entry size');
  const data = entry.getData();
  if (data.length !== entry.header.size) throw new Error('Invalid ZIP entry size');
  return data;
}
function extractCheckedZip(file, createdRoot) {
  const entries = openCheckedZip(file).getEntries();
  fs.mkdirSync(createdRoot, { mode: 0o700 });
  for (const entry of entries) {
    const out = checkedDestination(createdRoot, entry.isDirectory ? entry.entryName.replace(/\/$/, '') : entry.entryName);
    if (!out) throw new Error('Unsafe ZIP destination');
    if (entry.isDirectory) fs.mkdirSync(out, { recursive: true });
    else { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, checkedEntry(entry), { flag: 'wx' }); }
  }
}
module.exports = { zipPath, checkedDestination, openCheckedZip, checkedEntry, extractCheckedZip };
