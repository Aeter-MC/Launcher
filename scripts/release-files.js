/**
 * release-files.js — after `npm run build`, puts the files of a release into release/:
 *   AeterMC-Setup.exe, AeterMC-portable.exe — without the version, so that
 *                  releases/latest/download/<name> always gives the newest one (the site links there)
 *   app.asar     — the app itself, downloaded by the launcher's updater (src/updater.js)
 *   update.json  — { version, electron, asar: { size, sha256 } }, read by the updater
 * Used by .github/workflows/build.yml.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const asar = require('@electron/asar');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const out = path.join(root, 'release');
const { version } = require('../package.json');
const electron = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf-8')).version;
const asarFile = path.join(dist, 'win-unpacked', 'resources', 'app.asar');

// win-unpacked holds the last build, which must be the plain launcher:
// an app.asar of the setup build (aeterSetup) would open the installer after an update
const appPkg = JSON.parse(asar.extractFile(asarFile, 'package.json').toString('utf-8'));
if (appPkg.aeterSetup) throw new Error('app.asar is from the setup build: run the full `npm run build`');
if (appPkg.version !== version) throw new Error(`app.asar is ${appPkg.version}, package.json says ${version}`);

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out);
const exes = { [`AeterMC-Setup-${version}.exe`]: 'AeterMC-Setup.exe', [`AeterMC-${version}-portable.exe`]: 'AeterMC-portable.exe' };
for (const [built, name] of Object.entries(exes)) {
  fs.copyFileSync(path.join(dist, built), path.join(out, name));
}

const data = fs.readFileSync(asarFile);
fs.writeFileSync(path.join(out, 'app.asar'), data);
const manifest = {
  version,
  electron,
  asar: { size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') }
};
fs.writeFileSync(path.join(out, 'update.json'), JSON.stringify(manifest, null, 2) + '\n');

for (const name of fs.readdirSync(out)) {
  console.log(`  ${name}  ${(fs.statSync(path.join(out, name)).size / 1048576).toFixed(1)} MB`);
}
