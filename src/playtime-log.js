/**
 * playtime-log.js
 * Seconds played per calendar day (all builds together) for the weekly chart on the home page.
 * Stored in playtime-log.json as { "2026-10-21": 5400, ... }; days older than 60 are dropped.
 */
const fs = require('fs');
const path = require('path');

const KEEP_DAYS = 60;

function dayKey(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

class PlaytimeLog {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'playtime-log.json');
  }

  read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf-8')) || {};
    } catch (e) {
      return {};
    }
  }

  /** Adds a session that ended now; a session over midnight is split between the days. */
  add(seconds) {
    if (!seconds || seconds < 1) return;
    const days = this.read();
    let end = Date.now();
    let left = seconds * 1000;
    while (left > 0) {
      const endDate = new Date(end);
      const startOfDay = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate()).getTime();
      const part = Math.min(left, end - startOfDay || left);
      const key = dayKey(endDate);
      days[key] = (days[key] || 0) + Math.round(part / 1000);
      left -= part;
      end = startOfDay - 1;
    }
    const cutoff = dayKey(new Date(Date.now() - KEEP_DAYS * 86400000));
    for (const key of Object.keys(days)) if (key < cutoff) delete days[key];
    try {
      fs.writeFileSync(this.file, JSON.stringify(days, null, 2), 'utf-8');
    } catch (e) {}
  }
}

module.exports = { PlaytimeLog };
