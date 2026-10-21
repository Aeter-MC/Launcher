/**
 * screenshots.js
 * Screenshots from the shared .minecraft and from every build, for the "Скриншоты" page.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

/**
 * Folders that may hold screenshots: [{ dir, instanceId, instanceName }].
 * `root` is the shared .minecraft, `instances` comes from InstancesManager.listInstances().
 */
function screenshotSources(root, instances) {
  const seen = new Set();
  const sources = [];
  const add = (dir, instanceId, instanceName) => {
    const resolved = path.resolve(dir);
    if (seen.has(resolved.toLowerCase())) return;
    seen.add(resolved.toLowerCase());
    sources.push({ dir: resolved, instanceId, instanceName });
  };
  add(path.join(root, 'screenshots'), null, 'Общая папка .minecraft');
  for (const inst of instances) add(path.join(inst.minecraftDir, 'screenshots'), inst.id, inst.name);
  return sources;
}

/** All screenshots, newest first. */
async function listScreenshots(sources) {
  const result = [];
  await Promise.all(sources.map(async (src) => {
    let names;
    try {
      names = await fs.promises.readdir(src.dir);
    } catch (e) {
      return;
    }
    await Promise.all(names.filter(n => IMAGE_EXT.test(n)).map(async (name) => {
      const file = path.join(src.dir, name);
      try {
        const st = await fs.promises.stat(file);
        if (!st.isFile()) return;
        result.push({
          path: file,
          url: pathToFileURL(file).href,
          name,
          time: st.mtimeMs,
          size: st.size,
          instanceId: src.instanceId,
          instanceName: src.instanceName
        });
      } catch (e) {}
    }));
  }));
  result.sort((a, b) => b.time - a.time);
  return result;
}

/** True when `file` is an image directly inside one of the screenshot folders (guards the IPC calls). */
function isScreenshotPath(file, sources) {
  if (typeof file !== 'string' || !IMAGE_EXT.test(file)) return false;
  const dir = path.dirname(path.resolve(file)).toLowerCase();
  return sources.some(s => s.dir.toLowerCase() === dir);
}

/**
 * Calls `onChange` (debounced) when screenshots appear, change or disappear in any source folder.
 * A folder that does not exist yet is caught through its parent, when the game creates it.
 * Returns a function that stops watching.
 */
function watchScreenshots(sources, onChange) {
  let timer = null;
  // the game writes a PNG over a few hundred ms: wait for it to settle
  const fire = () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, 700);
  };
  const watchers = [];
  for (const src of sources) {
    try {
      if (fs.existsSync(src.dir)) {
        watchers.push(fs.watch(src.dir, (event, name) => {
          if (!name || IMAGE_EXT.test(name)) fire();
        }));
      } else if (fs.existsSync(path.dirname(src.dir))) {
        watchers.push(fs.watch(path.dirname(src.dir), (event, name) => {
          if (name === path.basename(src.dir)) fire();
        }));
      }
    } catch (e) {}
  }
  for (const w of watchers) w.on('error', () => {});
  return () => {
    clearTimeout(timer);
    watchers.forEach(w => w.close());
  };
}

module.exports = { screenshotSources, listScreenshots, isScreenshotPath, watchScreenshots };
