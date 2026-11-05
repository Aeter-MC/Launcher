/**
 * mod-meta.js
 * What a mod jar says about itself: id, name, version, dependencies and conflicts, read from
 * fabric.mod.json, quilt.mod.json or META-INF/(neoforge.)mods.toml, including jars bundled inside it
 * (Fabric API and many libraries ship their modules that way, so a dependency may be satisfied there).
 * Results are cached per file by size and modification time.
 */
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const NESTED_DEPTH = 2;
const cache = new Map(); // full path -> { stamp, meta }

// ---------- versions (Fabric's extended SemVer, loosely) ----------

/** "1.21.11", "0.19.3", "1.3.15+mc1.21", "2.6.25-beta.1" -> { nums, pre } ; build metadata (+…) is ignored. */
function parseVersion(v) {
  const s = String(v || '').trim().replace(/^v/i, '').split('+')[0];
  const dash = s.indexOf('-');
  const core = dash >= 0 ? s.slice(0, dash) : s;
  const pre = dash >= 0 ? s.slice(dash + 1) : '';
  const nums = core.split('.').map(x => (/^\d+$/.test(x) ? parseInt(x, 10) : NaN));
  if (!nums.length || nums.some(Number.isNaN)) return null;
  return { nums, pre };
}

function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] || 0) - (y.nums[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1; // a release is newer than its pre-releases
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/**
 * Does `version` satisfy a Fabric dependency predicate ("*", ">=0.19.5", "~1.2", "^3", "1.21.x",
 * ">=1.20 <1.22", or an array of those meaning "any of")? Returns null when it cannot tell, so callers
 * never report a problem they are not sure about.
 */
function satisfies(version, predicate) {
  if (Array.isArray(predicate)) {
    if (!predicate.length) return true;
    const results = predicate.map(p => satisfies(version, p));
    if (results.includes(true)) return true;
    return results.includes(null) ? null : false;
  }
  const pred = String(predicate == null ? '*' : predicate).trim();
  if (!pred || pred === '*') return true;
  let unknown = false;
  for (const part of pred.split(/\s+/)) {
    const m = /^(>=|<=|>|<|=|~|\^)?(.+)$/.exec(part);
    if (!m) return null;
    const [, op = '=', target] = m;
    // wildcards: 1.21.x, 1.21.*
    if (/[.][xX*]$/.test(target) || /^[xX*]$/.test(target)) {
      const prefix = target.replace(/[.]?[xX*]$/, '');
      const ok = !prefix || String(version).split('+')[0] === prefix || String(version).startsWith(prefix + '.');
      if (!ok) return false;
      continue;
    }
    const c = compareVersions(version, target);
    if (c === null) { unknown = true; continue; }
    const t = parseVersion(target);
    let ok;
    switch (op) {
      case '>=': ok = c >= 0; break;
      case '<=': ok = c <= 0; break;
      case '>': ok = c > 0; break;
      case '<': ok = c < 0; break;
      case '~': ok = c >= 0 && compareVersions(version, bump(t, 1)) < 0; break;
      case '^': ok = c >= 0 && compareVersions(version, bump(t, 0)) < 0; break;
      default: ok = c === 0;
    }
    if (!ok) return false;
  }
  return unknown ? null : true;
}

/** Next version at position i: bump([1,2,3], 1) -> "1.3". */
function bump(v, i) {
  const nums = v.nums.slice(0, i + 1);
  while (nums.length <= i) nums.push(0);
  nums[i]++;
  return nums.join('.');
}

// ---------- reading jars ----------

function readFabric(json, loader) {
  const toMap = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? o : {});
  return {
    loader,
    id: json.id,
    name: json.name || json.id,
    version: String(json.version || ''),
    provides: Array.isArray(json.provides) ? json.provides.map(p => (typeof p === 'string' ? p : p.id)).filter(Boolean) : [],
    depends: toMap(json.depends),
    breaks: toMap(json.breaks),
    environment: json.environment || '*'
  };
}

function readQuilt(json) {
  const q = json.quilt_loader || {};
  const deps = {};
  for (const d of q.depends || []) {
    if (typeof d === 'string') deps[d] = '*';
    else if (d && d.id && !d.optional) deps[d.id] = d.versions || '*';
  }
  const breaks = {};
  for (const d of q.breaks || []) {
    if (typeof d === 'string') breaks[d] = '*';
    else if (d && d.id) breaks[d.id] = d.versions || '*';
  }
  return {
    loader: 'quilt',
    id: q.id,
    name: (q.metadata && q.metadata.name) || q.id,
    version: String(q.version || ''),
    provides: (q.provides || []).map(p => (typeof p === 'string' ? p : p.id)).filter(Boolean),
    depends: deps,
    breaks,
    environment: '*'
  };
}

/** Minimal mods.toml reading: [[mods]] ids/versions and required [[dependencies.<id>]] entries. */
function readToml(text, loader) {
  const mods = [];
  const deps = {};
  let section = null;
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const head = /^\[\[(.+)\]\]$/.exec(line);
    if (head) {
      section = head[1].trim();
      current = {};
      if (section === 'mods') mods.push(current);
      else if (section.startsWith('dependencies.')) (deps[section.slice(13)] = deps[section.slice(13)] || []).push(current);
      continue;
    }
    if (/^\[/.test(line)) { section = null; current = null; continue; }
    const kv = /^([A-Za-z_]+)\s*=\s*(.+)$/.exec(line);
    if (kv && current) current[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return mods.filter(m => m.modId).map(m => {
    const depends = {};
    for (const d of deps[m.modId] || []) {
      const required = d.mandatory === 'true' || d.type === 'required' || (d.mandatory == null && d.type == null);
      if (required && d.modId) depends[d.modId] = '*'; // Maven ranges are not checked
    }
    return { loader, id: m.modId, name: m.displayName || m.modId, version: m.version || '', provides: [], depends, breaks: {}, environment: '*' };
  });
}

function readZipMeta(zip, depth) {
  const metas = [];
  const text = (name) => {
    const e = zip.getEntry(name);
    return e ? e.getData().toString('utf-8') : null;
  };
  const json = (name) => {
    const s = text(name);
    if (!s) return null;
    try {
      // some mods ship comments or stray control characters in their json
      return JSON.parse(s.replace(/^﻿/, '').replace(/[\u0000-\u0019]+/g, ' '));
    } catch (e) {
      return null;
    }
  };
  const fabric = json('fabric.mod.json');
  const quilt = json('quilt.mod.json');
  if (quilt && quilt.quilt_loader && quilt.quilt_loader.id) metas.push(readQuilt(quilt));
  else if (fabric && fabric.id) metas.push(readFabric(fabric, 'fabric'));
  for (const [file, loader] of [['META-INF/neoforge.mods.toml', 'neoforge'], ['META-INF/mods.toml', 'forge']]) {
    const s = text(file);
    if (s) { metas.push(...readToml(s, loader)); break; }
  }

  // bundled jars: Fabric lists them in "jars", Forge/NeoForge keep them in META-INF/jarjar
  if (depth < NESTED_DEPTH) {
    const nested = new Set();
    if (fabric && Array.isArray(fabric.jars)) fabric.jars.forEach(j => j && j.file && nested.add(j.file));
    zip.getEntries().forEach(e => { if (/^META-INF\/(jars|jarjar)\/[^/]+\.jar$/i.test(e.entryName)) nested.add(e.entryName); });
    for (const name of nested) {
      const e = zip.getEntry(name);
      if (!e) continue;
      try {
        const inner = readZipMeta(new AdmZip(e.getData()), depth + 1);
        inner.forEach(m => { m.bundled = true; });
        metas.push(...inner);
      } catch (err) {}
    }
  }
  return metas;
}

/** Mods declared by one jar: [{ loader, id, name, version, provides, depends, breaks, bundled? }] */
function readJar(full) {
  let stat;
  try {
    stat = fs.statSync(full);
  } catch (e) {
    return [];
  }
  const stamp = `${stat.size}:${stat.mtimeMs}`;
  const hit = cache.get(full);
  if (hit && hit.stamp === stamp) return hit.meta;
  let meta = [];
  try {
    meta = readZipMeta(new AdmZip(full), 0);
  } catch (e) {}
  cache.set(full, { stamp, meta });
  return meta;
}

/** All jars of a mods folder: [{ file, enabled, mods: [...] }], switched-off ones included. */
function scanModsDir(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return [];
  }
  return names
    .filter(n => /\.jar(\.disabled)?$/i.test(n))
    .map(n => ({ file: n, enabled: !/\.disabled$/i.test(n), mods: readJar(path.join(dir, n)) }));
}

module.exports = { parseVersion, compareVersions, satisfies, readJar, scanModsDir };
