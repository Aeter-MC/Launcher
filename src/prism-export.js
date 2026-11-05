/**
 * prism-export.js
 * A build as a Prism Launcher instance archive (.zip), the same layout Prism's own "Export instance"
 * writes and its "Import" takes:
 *   instance.cfg      name, icon and the build's own launch settings (Override* keys)
 *   mmc-pack.json     components: Minecraft and the loader; Prism adds LWJGL and the rest itself
 *   <iconKey>.png     a custom icon, picked up by Prism on import
 *   minecraft/…       the chosen top-level files and folders of the game folder
 */
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { t } = require('./i18n/i18n');
const { collectFiles, writePrismLaunch } = require('./instances-manager');

// Prism component ids of the loaders, with the display names Prism caches
const LOADER_COMPONENTS = {
  fabric: { uid: 'net.fabricmc.fabric-loader', name: 'Fabric Loader', intermediary: true },
  quilt: { uid: 'org.quiltmc.quilt-loader', name: 'Quilt Loader', intermediary: true },
  forge: { uid: 'net.minecraftforge', name: 'Forge' },
  neoforge: { uid: 'net.neoforged', name: 'NeoForge' }
};

function mmcPack(inst) {
  const components = [
    { cachedName: 'Minecraft', cachedVersion: inst.version, important: true, uid: 'net.minecraft', version: inst.version }
  ];
  const loader = LOADER_COMPONENTS[inst.loader];
  if (loader) {
    if (!inst.loaderVersion) throw new Error(t('У сборки не указана версия загрузчика'));
    // Fabric and Quilt map names through Intermediary; Prism would add it too, but only after a refresh
    if (loader.intermediary) {
      components.push({ cachedName: 'Intermediary Mappings', cachedVersion: inst.version, dependencyOnly: true, uid: 'net.fabricmc.intermediary', version: inst.version });
    }
    components.push({ cachedName: loader.name, cachedVersion: inst.loaderVersion, uid: loader.uid, version: inst.loaderVersion });
  }
  return { components, formatVersion: 1 };
}

/** Icon of the build as PNG bytes, or null (block icons are AeterMC's own and have no file). */
function iconPng(inst) {
  const m = /^data:image\/png;base64,(.+)$/.exec(inst.iconImage || '');
  return m ? Buffer.from(m[1], 'base64') : null;
}

function instanceCfg(inst, iconKey) {
  let cfg = '[General]\nConfigVersion=1.2\nInstanceType=OneSix\n';
  cfg += `name=${String(inst.name).replace(/[\r\n]/g, ' ')}\n`;
  cfg += `iconKey=${iconKey || 'default'}\n`;
  if (inst.totalPlaytime) cfg += `totalTimePlayed=${Math.round(inst.totalPlaytime)}\n`;
  return writePrismLaunch(cfg, inst.launch || {});
}

/**
 * Writes the archive. include: top-level names of the game folder (see MrpackManager.listExportEntries).
 * Returns { file, packed }.
 */
async function exportPrism(inst, { include = [], allowed, file }, onProgress = () => {}) {
  const root = inst.minecraftDir;
  const files = [];
  for (const entry of include) {
    if (!allowed.has(entry)) continue;
    const full = path.join(root, entry);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) files.push(...collectFiles(full).map(f => ({ full: f.full, rel: path.join(entry, f.rel) })));
    else files.push({ full, rel: entry });
  }
  const wanted = files.filter(f => !/\.(part|mcl-download)$/i.test(f.rel));

  const zip = new AdmZip();
  const png = iconPng(inst);
  const iconKey = png ? `aetermc_${String(inst.id).replace(/[^a-zA-Z0-9_-]/g, '_')}` : null;
  zip.addFile('instance.cfg', Buffer.from(instanceCfg(inst, iconKey), 'utf-8'));
  zip.addFile('mmc-pack.json', Buffer.from(JSON.stringify(mmcPack(inst), null, 2), 'utf-8'));
  if (png) zip.addFile(`${iconKey}.png`, png);

  wanted.forEach((f, i) => {
    zip.addFile(`minecraft/${f.rel.split(path.sep).join('/')}`, fs.readFileSync(f.full));
    if (i % 20 === 0) onProgress({ text: t('Упаковка файлов: {n} из {total}', { n: i + 1, total: wanted.length }) });
  });

  onProgress({ text: t('Запись архива…') });
  const part = `${file}.part`;
  try {
    await zip.writeZipPromise(part);
    fs.renameSync(part, file);
  } catch (e) {
    fs.rmSync(part, { force: true });
    throw new Error(t('Не удалось записать архив: {error}', { error: e.message }));
  }
  return { file, packed: wanted.length };
}

module.exports = { exportPrism, mmcPack };
