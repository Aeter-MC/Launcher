'use strict';
// V2 writes only its own shortcuts. The caller supplies the persistent runner
// and profile directory; no per-instance executable or runtime compilation.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pngsToIco, quoteWindows } = require('./launch-utils');

function checkedPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\0\r\n]/.test(value)) throw new Error('An absolute shortcut path is required');
  const resolved = path.resolve(value);
  for (let current = resolved; ; current = path.dirname(current)) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Shortcut paths cannot contain symbolic links or junctions');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (path.dirname(current) === current) break;
  }
  return resolved;
}

function ensureDirectory(directory) {
  checkedPath(directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  checkedPath(directory);
  if (!fs.statSync(directory).isDirectory()) throw new Error('Shortcut directory is not a directory');
}

function writeAtomic(file, bytes) {
  checkedPath(file);
  ensureDirectory(path.dirname(file));
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    checkedPath(file);
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

function fittedImage(nativeImage, source, size) {
  const dimensions = source.getSize();
  if (!dimensions.width || !dimensions.height || dimensions.width * dimensions.height > 16777216) throw new Error('Invalid shortcut icon dimensions');
  const ratio = Math.min(size / dimensions.width, size / dimensions.height);
  const width = Math.max(1, Math.round(dimensions.width * ratio));
  const height = Math.max(1, Math.round(dimensions.height * ratio));
  const scaled = source.resize({ width, height, quality: 'best' });
  const pixels = scaled.toBitmap({ scaleFactor: 1 });
  if (pixels.length !== width * height * 4) throw new Error('Invalid shortcut icon bitmap');
  const square = Buffer.alloc(size * size * 4); // transparent BGRA padding
  const left = Math.floor((size - width) / 2), top = Math.floor((size - height) / 2);
  for (let row = 0; row < height; ++row) pixels.copy(square, ((top + row) * size + left) * 4, row * width * 4, (row + 1) * width * 4);
  return nativeImage.createFromBitmap(square, { width: size, height: size, scaleFactor: 1 });
}

function writeShortcutIcon({ app, nativeImage, dataUrl, iconPath, platform = process.platform }) {
  let source;
  if (dataUrl) {
    if (typeof dataUrl !== 'string' || dataUrl.length > 8 * 1024 * 1024 || !/^data:image\/(?:png|x-icon|vnd\.microsoft\.icon);base64,/i.test(dataUrl)) throw new Error('Shortcut icons must be PNG or ICO images');
    source = nativeImage.createFromDataURL(dataUrl);
  } else {
    const file = checkedPath(iconPath || path.resolve(__dirname, '../assets/icon.png'));
    if (!/\.(?:png|ico)$/i.test(file) || !fs.statSync(file).isFile() || fs.statSync(file).size > 8 * 1024 * 1024) throw new Error('Shortcut icons must be PNG or ICO images');
    source = nativeImage.createFromPath(file);
  }
  if (!source || source.isEmpty()) throw new Error('Cannot read shortcut icon');
  const bytes = platform === 'linux'
    ? fittedImage(nativeImage, source, 256).toPNG()
    : pngsToIco([16, 32, 48, 256].map(size => ({ size, png: fittedImage(nativeImage, source, size).toPNG() })));
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const directory = path.join(checkedPath(app.getPath('userData')), 'native-v2', 'icons');
  ensureDirectory(directory);
  const file = checkedPath(path.join(directory, `${hash}.${platform === 'linux' ? 'png' : 'ico'}`));
  if (!fs.existsSync(file)) writeAtomic(file, bytes);
  else if (!fs.readFileSync(file).equals(bytes)) throw new Error('Stored shortcut icon is damaged');
  return file;
}

function desktopString(value) {
  return String(value).replace(/[\\\n\r\t]/g, c => ({ '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t' })[c]);
}
function quoteDesktopExec(value) {
  return desktopString('"' + String(value).replace(/["`$\\]/g, '\\$&').replace(/%/g, '%%') + '"');
}

function createShortcut({ app, shell, instance, iconPath, runner, profile, platform = process.platform, applicationsDirectory }) {
  if (!instance || typeof instance.id !== 'string' || !instance.id || instance.id.length > 1024 || /[\0\r\n]/.test(instance.id)) throw new Error('Invalid shortcut instance ID');
  runner = checkedPath(runner);
  profile = checkedPath(profile);
  iconPath = checkedPath(iconPath);
  if (!fs.statSync(runner).isFile()) throw new Error('Native V2 launcher is missing');
  if (!fs.statSync(iconPath).isFile()) throw new Error('Shortcut icon is missing');
  if (!fs.statSync(profile).isDirectory()) throw new Error('Native V2 profile is missing');
  const id = crypto.createHash('sha256').update(instance.id).digest('hex').slice(0, 16);
  const args = ['--profile', profile, '--instance', instance.id];
  if (platform === 'win32') {
    const directory = checkedPath(app.getPath('desktop'));
    ensureDirectory(directory);
    let name = String(instance.name || 'Minecraft').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 160).replace(/[. ]+$/, '');
    if (/^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³]) *(?:\.|$)/i.test(name)) name = '_' + name;
    const file = checkedPath(path.join(directory, `${name || 'Minecraft'}.lnk`));
    const exists = fs.existsSync(file);
    const options = {
      target: runner, args: args.map(quoteWindows).join(' '), cwd: path.dirname(runner),
      description: `Aeter V2: ${String(instance.name || 'Minecraft').replace(/[\0\r\n]/g, ' ').slice(0, 180)}`,
      icon: iconPath, iconIndex: 0, appUserModelId: 'dev.aetermc.native.v2'
    };
    if (exists) {
      let current;
      try { current = shell.readShortcutLink(file); } catch (_) {}
      const target = current?.target && path.resolve(current.target).toLowerCase();
      const relative = target && path.relative(path.join(profile, 'native-v2', 'runtime').toLowerCase(), target);
      const earlierRuntime = relative && /^[a-f0-9]{64}[\\/]aeternative\.exe$/.test(relative);
      if (!current || (target !== runner.toLowerCase() && !earlierRuntime) || current.args !== options.args) {
        throw new Error('A different shortcut already uses this name. Rename the build or move the existing shortcut.');
      }
    }
    if (!shell.writeShortcutLink(file, exists ? 'replace' : 'create', options)) throw new Error('Could not create Native V2 shortcut');
    return file;
  }
  if (platform === 'linux') {
    const xdg = process.env.XDG_DATA_HOME || path.join(require('os').homedir(), '.local', 'share');
    const directory = checkedPath(applicationsDirectory || path.join(xdg, 'applications'));
    ensureDirectory(directory);
    const file = checkedPath(path.join(directory, `aeter-v2-${id}.desktop`));
    writeAtomic(file, ['[Desktop Entry]', 'Type=Application', `Name=${desktopString(instance.name || 'Minecraft')}`,
      'Comment=Minecraft · Aeter V2', `Exec=${[runner, ...args].map(quoteDesktopExec).join(' ')}`,
      `Path=${desktopString(path.dirname(runner))}`, `Icon=${desktopString(iconPath)}`, 'Terminal=false', 'Categories=Game;', ''].join('\n'));
    return file;
  }
  throw new Error('Native V2 shortcuts require Windows or Linux');
}

function createShortcutV2({ app, shell, nativeImage, instance, iconDataUrl, runner, profile, platform, applicationsDirectory }) {
  const iconPath = writeShortcutIcon({ app, nativeImage, dataUrl: iconDataUrl || instance.iconImage, platform });
  return createShortcut({ app, shell, instance, iconPath, runner, profile, platform, applicationsDirectory });
}

module.exports = { createShortcut, createShortcutV2, writeShortcutIcon, checkedPath, quoteDesktopExec, fittedImage };
