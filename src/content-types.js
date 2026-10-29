/**
 * content-types.js
 * What a build holds that comes from Modrinth: mods, resource packs and shaders.
 * Each is a Modrinth project type with its own folder in the build and its own kind of files;
 * resource packs and shaders may also be unpacked folders.
 */
const path = require('path');
const { t } = require('./i18n/i18n');

const CONTENT = {
  mod: { projectType: 'mod', folder: 'mods', file: /\.jar(\.disabled)?$/i, ext: '.jar', folders: false },
  resourcepack: { projectType: 'resourcepack', folder: 'resourcepacks', file: /\.zip(\.disabled)?$/i, ext: '.zip', folders: true },
  shader: { projectType: 'shader', folder: 'shaderpacks', file: /\.zip(\.disabled)?$/i, ext: '.zip', folders: true }
};

function contentType(kind = 'mod') {
  const type = Object.prototype.hasOwnProperty.call(CONTENT, kind) ? CONTENT[kind] : null;
  if (!type) throw new Error(t('Неизвестный тип файлов: {kind}', { kind }));
  return type;
}

/** Folder of this kind of content in a build (as read by InstancesManager.readInstance). */
function contentDir(inst, kind = 'mod') {
  return kind === 'mod' ? inst.modsDir : path.join(inst.minecraftDir, contentType(kind).folder);
}

module.exports = {
  CONTENT,
  contentType,
  contentDir
};
