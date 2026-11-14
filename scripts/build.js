/**
 * build.js — `npm run build`
 * Builds two files into dist/:
 *   AeterMC-Setup-<version>.exe     — the installer in the launcher's style
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
const asar = require('@electron/asar');
const crypto = require('crypto');

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function syncNativeRuntime() {
  const sourceDir = path.join(root, 'native', 'v2', 'bin');
  const targetDir = path.join(root, 'src', 'native-v2-runtime');

  fs.mkdirSync(targetDir, { recursive: true });

  for (const name of ['AeterNative.exe', 'aeter-bootstrap.jar']) {
    const source = path.join(sourceDir, name);
    const target = path.join(targetDir, name);

    const data = fs.readFileSync(source);
    fs.writeFileSync(target, data);

    console.log(`[Native V2] ${name}: ${sha256(data)}`);
  }
}
const { Platform, Arch } = builder;

const root = path.join(__dirname, '..');
const setupOnly = process.argv.includes('--setup-only');
const copyToWorkspace = !process.argv.includes('--no-workspace-copy');
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
    syncNativeRuntime();

    // releases are published by .github/workflows/release.yml, never by electron-builder itself
    await builder.build({ targets: Platform.WINDOWS.createTarget(['portable'], Arch.x64), config: {
      ...config,
      afterPack({ appOutDir }) {
        const archive = path.join(appOutDir, 'resources', 'app.asar');
        for (const name of ['AeterNative.exe', 'aeter-bootstrap.jar']) {
          const internal = path.join('src', 'native-v2-runtime', name);
          const expected = fs.readFileSync(path.join(root, 'native', 'v2', 'bin', name));
          const actual = asar.extractFile(archive, internal);
const staged = fs.readFileSync(
  path.join(root, 'src', 'native-v2-runtime', name)
);

console.log(`[Native V2] ${name}`);
console.log(`SOURCE:   ${sha256(expected)}`);
console.log(`STAGED:   ${sha256(staged)}`);
console.log(`PACKAGED: ${sha256(actual)}`);
          if (!actual.equals(expected)) {
  throw new Error(
    `Packaged Native V2 runtime differs: ${name}\n` +
    `Expected: ${sha256(expected)}\n` +
    `Actual:   ${sha256(actual)}`
  );
}
        }
        console.log('Verified Native V2 runtime in app.asar');
      }
    }, publish: 'never' });
  } finally {
    fse.readFile = readFile;
  }
  if (portableTemplate && !used) throw new Error('electron-builder did not read portable.nsi: the splash was not built in');
}

(async () => {
  require('child_process').execFileSync(process.execPath, [path.join(__dirname, 'build-native-v2.js'), '--release-only'], { stdio: 'inherit' });
  if (!fs.existsSync(SPLASH)) throw new Error('installer/build/splash.exe is missing: run `npm run splash`');
  const template = fs.readFileSync(path.join(INSTALLER, 'splash', 'portable-setup.nsi'), 'utf8')
    .replace('@AETER_SPLASH@', SPLASH);
  await build({
  directories: {
    output: 'dist/setup'
  },
  extraMetadata: {
    aeterSetup: true
  },
  portable: {
    artifactName: 'AeterMC-Setup-${version}.${ext}'
  }
}, template);
const version = require('../package.json').version;
const setupName = `AeterMC-Setup-${version}.exe`;

fs.copyFileSync(
  path.join(root, 'dist', 'setup', setupName),
  path.join(root, 'dist', setupName)
);
  // the installer also goes to the root of the workspace (next to mcl/), where it is uploaded from
  if (copyToWorkspace) {
    const name = `AeterMC-Setup-${require('../package.json').version}.exe`;
    const workspace = path.join(root, '..');
    for (const old of fs.readdirSync(workspace)) {
      if (/^AeterMC-Setup-.*\.exe$/.test(old) && old !== name) fs.rmSync(path.join(workspace, old));
    }
    fs.copyFileSync(path.join(root, 'dist', name), path.join(workspace, name));
    console.log(`  • copied          ${name} → ${workspace}`);
  }
  if (!setupOnly) await build({});
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
