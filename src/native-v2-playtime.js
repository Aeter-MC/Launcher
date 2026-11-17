'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

// read both original and new session filenames. Keep the journal separate from
// instance.cfg so counting a session never invalidates its prepared plan.
function readNativePlaytime(profile, now = Date.now()) {
  const totals = new Map(), days = {};
  const cutoff = now - 60 * 86400000;
  const dir = path.join(profile, 'native-v2', 'sessions');
  try {
    for (const part of [profile, path.dirname(dir), dir]) if (!fs.lstatSync(part).isDirectory()) return { totals, days };
    for (const name of fs.readdirSync(dir)) {
      const match = /^([a-f0-9]{64})-\d+(?:-\d+)?\.json$/.exec(name);
      if (!match) continue;
      let data;
      try {
        const file = path.join(dir, name);
        const info = fs.lstatSync(file);
        if (!info.isFile() || info.size > 4096) continue;
        data = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (_) { continue; }
      const { start, durationMs } = data || {};
      if (data?.schema !== 2 || data.event !== 'java-exited' || !Number.isSafeInteger(start) || !Number.isSafeInteger(durationMs) || durationMs < 0 || start < 0 || start + durationMs > now + 60000) continue;
      const tally = totals.get(match[1]) || { seconds: 0, lastPlayed: 0 };
      tally.lastPlayed = Math.max(tally.lastPlayed, start);
      tally.seconds += Math.floor(durationMs / 1000);
      totals.set(match[1], tally);
      const end = start + durationMs;
      for (let at = Math.max(start, cutoff); at < end;) {
        const d = new Date(at), y = d.getFullYear(), m = d.getMonth(), day = d.getDate();
        const next = Math.min(end, new Date(y, m, day + 1).getTime());
        const key = `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        days[key] = (days[key] || 0) + Math.floor((next - start) / 1000) - Math.floor((at - start) / 1000);
        at = next;
      }
    }
  } catch (_) { /* V2 can be absent on profiles that only use the UI. */ }
  return { totals, days };
}

function withNativePlaytime(instances, totals) {
  return instances.map(inst => {
    const native = totals.get(createHash('sha256').update(inst.id).digest('hex'));
    return native ? { ...inst, totalPlaytime: (Number(inst.totalPlaytime) || 0) + native.seconds,
      lastPlayed: Math.max(Number(inst.lastPlayed) || 0, native.lastPlayed) } : inst;
  });
}

module.exports = { readNativePlaytime, withNativePlaytime };
