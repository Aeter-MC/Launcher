/**
 * build.js — `npm run build`
 * Builds two files into dist/:
 *   AeterMC-Setup-<version>.exe     — the installer in the launcher's style (installer/)
 *   AeterMC-<version>-portable.exe  — the launcher without installation
 * Both are electron-builder "portable" packages of the same app; the setup one carries
 * `aeterSetup: true` in its package.json, which makes main.js open the installer window.
 * `npm run build -- --setup-only` skips the portable one.
 *
 * The setup stub uses installer/splash/portable-setup.nsi instead of electron-builder's
 * portable.nsi, so it can show the animated splash (installer/build/splash.exe, `npm run splash`)
 * while it unpacks. electron-builder has no option for a custom portable template, so its
 * template read is redirected for the duration of that build.
 */
const fs = require('fs');
const path = require('path');
const builder = require('electron-builder');
const { Platform, Arch } = builder;

const root = path.join(__dirname, '..');
const setupOnly = process.argv.includes('--setup-only');
const INSTALLER = path.join(root, 'installer');
const SPLASH = path.join(INSTALLER, 'build', 'splash.exe');

// the fs-extra instance app-builder-lib reads its NSIS templates with
const fse = require(require.resolve('fs-extra', { paths: [require.resolve('app-builder-lib')] }));

async function build(config, portableTemplate) {
  const readFile = fse.readFile;
  let used = false;
  if (portableTemplate) {
    fse.readFile = function (file, ...rest) {
      if (typeof file === 'string' && path.basename(file) === 'portable.nsi') {
        used = true;
        return Promise.resolve(portableTemplate);
      }
      return readFile.call(this, file, ...rest);
    };
  }
  try {
    await builder.build({ targets: Platform.WINDOWS.createTarget(['portable'], Arch.x64), config });
  } finally {
    fse.readFile = readFile;
  }
  if (portableTemplate && !used) throw new Error('electron-builder did not read portable.nsi: the splash was not built in');
}

(async () => {
  if (!fs.existsSync(SPLASH)) throw new Error('installer/build/splash.exe is missing: run `npm run splash`');
  const template = fs.readFileSync(path.join(INSTALLER, 'splash', 'portable-setup.nsi'), 'utf8')
    .replace('@AETER_SPLASH@', SPLASH);
  await build({
    extraMetadata: { aeterSetup: true },
    portable: { artifactName: 'AeterMC-Setup-${version}.${ext}' }
  }, template);
  // the installer also goes to the project root, where it is uploaded from
  const name = `AeterMC-Setup-${require('../package.json').version}.exe`;
  const workspace = root;
  for (const old of fs.readdirSync(workspace)) {
    if (/^AeterMC-Setup-.*\.exe$/.test(old) && old !== name) fs.rmSync(path.join(workspace, old));
  }
  fs.copyFileSync(path.join(root, 'dist', name), path.join(workspace, name));
  console.log(`  • copied          ${name} → ${workspace}`);
  if (!setupOnly) await build({});
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
