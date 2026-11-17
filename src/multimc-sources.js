const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');

const LAUNCHERS = [
  { name: 'Prism Launcher', dirs: ['PrismLauncher'], cfg: 'prismlauncher.cfg', flatpak: 'org.prismlauncher.PrismLauncher' },
  { name: 'Freesm Launcher', dirs: ['FreesmLauncher'], cfg: 'freesmlauncher.cfg', flatpak: 'org.freesmlauncher.FreesmLauncher' },
  { name: 'PolyMC', dirs: ['PolyMC', 'polymc'], cfg: 'polymc.cfg', flatpak: 'org.polymc.PolyMC' },
  { name: 'MultiMC', dirs: ['MultiMC', 'multimc'], cfg: 'multimc.cfg' }
];

function realDirectory(folder) {
  try {
    const real = fs.realpathSync.native(folder);
    return fs.statSync(real).isDirectory() ? real : null;
  } catch { return null; }
}

function pathKey(folder) {
  const resolved = path.resolve(folder);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function readSmallText(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Invalid instance metadata');
  return fs.readFileSync(file, 'utf8');
}

function folderSetting(root, launcher, key, fallback) {
  if (!launcher) return path.join(root, fallback);
  try {
    const text = readSmallText(path.join(root, launcher.cfg));
    const raw = text.match(new RegExp(`^${key}=(.+)$`, 'm'))?.[1].trim().replace(/^"(.*)"$/, '$1');
    if (raw && !raw.startsWith('@')) return path.resolve(root, raw);
  } catch {}
  return path.join(root, fallback);
}

function findLauncher(root) {
  const name = path.basename(root).toLowerCase();
  return LAUNCHERS.find(l => fs.existsSync(path.join(root, l.cfg)))
    || LAUNCHERS.find(l => l.dirs.some(dir => dir.toLowerCase() === name));
}

function hasInstances(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).some(entry => entry.isDirectory()
      && fs.existsSync(path.join(dir, entry.name, 'instance.cfg')) && fs.existsSync(path.join(dir, entry.name, 'mmc-pack.json')));
  } catch { return false; }
}

function manualSource(folder) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) return null;
  const selected = realDirectory(folder);
  if (!selected) return null;
  const launcher = findLauncher(selected);
  const nested = realDirectory(folderSetting(selected, launcher, 'InstanceDir', 'instances'));
  const useRoot = nested && (launcher || hasInstances(nested));
  const dir = useRoot ? nested : selected;
  if (!useRoot && !hasInstances(dir)) return null;
  const root = useRoot ? selected : path.dirname(selected);
  const owner = useRoot ? launcher : findLauncher(root);
  const label = useRoot || path.basename(dir).toLowerCase() === 'instances' ? root : dir;
  return { dir, iconsDir: folderSetting(root, owner, 'IconsDir', 'icons'), name: owner?.name || path.basename(label), legacy: false };
}

function discoverSources(custom = [], { home = os.homedir(), env = process.env, platform = process.platform } = {}) {
  const base = platform === 'win32' ? env.APPDATA || path.join(home, 'AppData', 'Roaming')
    : platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
      : env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  const seen = new Set();
  const sources = [];
  function add(source) {
    if (!source || seen.has(pathKey(source.dir))) return;
    seen.add(pathKey(source.dir));
    sources.push(source);
  }
  for (const launcher of LAUNCHERS) {
    const roots = launcher.dirs.map(dir => path.join(base, dir));
    if (platform === 'linux' && launcher.flatpak) {
      for (const dir of launcher.dirs) roots.push(path.join(home, '.var', 'app', launcher.flatpak, 'data', dir));
    }
    if (platform === 'linux' && launcher.cfg === 'multimc.cfg') roots.push(path.join(home, '.config', 'local', 'multimc'));
    for (const root of roots) {
      const configured = folderSetting(root, launcher, 'InstanceDir', 'instances');
      const dir = realDirectory(configured);
      if (!dir) continue;
      const legacy = launcher === LAUNCHERS[0] && root === roots[0] && configured === path.join(root, 'instances');
      add({ dir, iconsDir: folderSetting(root, launcher, 'IconsDir', 'icons'), name: launcher.name, legacy });
    }
  }
  for (const folder of custom) add(manualSource(folder));
  return sources;
}

function externalId(folder, source) {
  if (source.legacy) return `prism-${path.basename(folder)}`;
  return `mmc-${createHash('sha256').update(pathKey(folder)).digest('hex').slice(0, 24)}`;
}

module.exports = { discoverSources, manualSource, pathKey, realDirectory, readSmallText, externalId };
