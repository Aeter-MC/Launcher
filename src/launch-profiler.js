const fs = require('fs');
const path = require('path');

const HISTORY_LIMIT = 20;

function roundMs(value) {
  return Math.max(0, Math.round(Number(value) || 0));
}

class LaunchProfile {
  constructor(instanceId, now = () => Date.now()) {
    this.instanceId = String(instanceId || 'unknown');
    this.now = now;
    this.startedAt = now();
    this.phases = [];
    this.active = new Map();
  }

  start(name) {
    if (!this.active.has(name)) this.active.set(name, this.now());
  }

  end(name) {
    const started = this.active.get(name);
    if (started == null) return;
    this.active.delete(name);
    this.phases.push({ name, durationMs: roundMs(this.now() - started) });
  }

  finish(status = 'launched', error = null) {
    for (const name of [...this.active.keys()]) this.end(name);
    const finishedAt = this.now();
    return {
      instanceId: this.instanceId,
      startedAt: new Date(this.startedAt).toISOString(),
      status,
      totalMs: roundMs(finishedAt - this.startedAt),
      phases: this.phases.slice(),
      ...(error ? { error: String(error).slice(0, 500) } : {})
    };
  }
}

class LaunchProfiler {
  constructor(userDataDir, options = {}) {
    this.filePath = path.join(userDataDir, 'launch-profiles.json');
    this.limit = options.limit || HISTORY_LIMIT;
    this.now = options.now || (() => Date.now());
  }

  begin(instanceId) { return new LaunchProfile(instanceId, this.now); }

  read() {
    try {
      const value = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch (_) { return {}; }
  }

  save(result) {
    const history = this.read();
    const id = String(result.instanceId || 'unknown');
    history[id] = [result, ...(Array.isArray(history[id]) ? history[id] : [])].slice(0, this.limit);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(history, null, 2), 'utf8');
    fs.renameSync(temporary, this.filePath);
    return result;
  }

  list(instanceId) {
    const entries = this.read()[String(instanceId || '')];
    return Array.isArray(entries) ? entries : [];
  }
}

function formatLaunchProfile(result) {
  const phases = result.phases.map(phase => `${phase.name}: ${phase.durationMs} ms`).join(', ');
  return `Launch profile (${result.status}): ${result.totalMs} ms${phases ? ` — ${phases}` : ''}`;
}

module.exports = { LaunchProfiler, LaunchProfile, formatLaunchProfile, HISTORY_LIMIT };
