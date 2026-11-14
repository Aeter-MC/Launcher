/**
 * Imports a Prism/MultiMC instance ZIP as an independent AeterMC build.
 */
const fs = require('fs');
const path = require('path');
const { t } = require('./i18n/i18n');
const { cfgValue, setCfgValue, prismLaunch, prismComponents } = require('./instances-manager');
const { insideDir, openZip, validVersion } = require('./mrpack');
const { checkedEntry } = require('./safe-zip');

function readInstanceZip(file) {
  const zip = openZip(file);
  const entries = zip.getEntries();
  const cfgEntries = entries.filter(entry => !entry.isDirectory && /^(?:[^/]+\/)?instance\.cfg$/.test(entry.entryName));
  if (cfgEntries.length !== 1) throw new Error(t('В ZIP не найдена одна сборка Prism Launcher или MultiMC'));

  const cfgEntry = cfgEntries[0];
  const prefix = cfgEntry.entryName.slice(0, -'instance.cfg'.length);
  const cfg = checkedEntry(cfgEntry, 1024 * 1024).toString('utf-8');
  let components;
  try {
    components = prismComponents(JSON.parse(checkedEntry(zip.getEntry(prefix + 'mmc-pack.json'), 1024 * 1024).toString('utf8')));
  } catch (e) {
    throw new Error(t('В ZIP отсутствует или повреждён mmc-pack.json'));
  }
  if (!validVersion(components.version) || (components.loader !== 'vanilla' && !validVersion(components.loaderVersion))) {
    throw new Error(t('В архиве сборки указана недопустимая версия игры или загрузчика'));
  }

  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory || !entry.entryName.startsWith(prefix)) continue;
    const game = /^(?:minecraft|\.minecraft)\/(.+)$/.exec(entry.entryName.slice(prefix.length));
    if (!game) continue;
    const rel = game[1];
    if (/[\\\x00-\x1f:]/.test(rel) || rel.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error(t('Модпак повреждён: недопустимый путь {path}', { path: entry.entryName }));
    }
    files.push({ entry, rel });
  }

  const iconKey = cfgValue(cfg, 'iconKey');
  const icon = iconKey && /^[\w-]+$/.test(iconKey) ? zip.getEntry(prefix + iconKey + '.png') : null;
  const launch = prismLaunch(cfg);
  // Java executables and JVM arguments are machine-local and can execute arbitrary code.
  delete launch.javaPath;
  delete launch.customJvmArgs;
  return {
    files, icon, launch,
    info: {
      name: cfgValue(cfg, 'name') || path.basename(file, path.extname(file)),
      minecraft: components.version,
      loader: components.loader,
      loaderVersion: components.loaderVersion,
      overrideCount: files.length
    }
  };
}

async function importInstanceZip(file, instances, { name, onProgress }) {
  const { files, icon, launch, info } = readInstanceZip(file);
  const work = fs.mkdtempSync(path.join(path.dirname(instances.instancesDir), '.instance-zip-'));
  try {
    const inst = await instances.createInstance({
      name: name.trim() || info.name,
      version: info.minecraft,
      loader: info.loader,
      loaderVersion: info.loaderVersion,
      versionId: '',
      launch
    }, work);

    for (const [i, { entry, rel }] of files.entries()) {
      const dest = insideDir(inst.minecraftDir, rel);
      if (!dest) throw new Error(t('Модпак повреждён: недопустимый путь {path}', { path: rel }));
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      await fs.promises.writeFile(dest, checkedEntry(entry), { flag: 'wx' });
      if (i % 20 === 0) onProgress({ text: t('Распаковка файлов: {n} из {total}', { n: i + 1, total: files.length }) });
    }

    if (icon && !icon.isDirectory) {
      const png = checkedEntry(icon, 8 * 1024 * 1024);
      if (png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
        fs.writeFileSync(path.join(inst.path, 'icon.png'), png);
        instances.updateInstanceCfg(inst, cfg => setCfgValue(cfg, 'iconKey', 'icon'));
      }
    }

    const dest = path.join(instances.instancesDir, inst.id);
    fs.renameSync(inst.path, dest);
    return instances.readInstance(dest);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

module.exports = { inspectInstanceZip: file => readInstanceZip(file).info, importInstanceZip };
