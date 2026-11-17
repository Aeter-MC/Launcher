/** stage an offline makepkg recipe for the archive from build-linux.sh. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const { version } = require('../package.json');
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) {
  throw new Error(`Unsupported package version: ${version}`);
}
const packaging = path.join(root, 'packaging', 'aur');
const output = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'dist', 'arch');
const archive = `AeterMC-${version}-linux.tar.gz`;
const sources = [archive, 'aetermc', 'aetermc.desktop'];
fs.mkdirSync(output, { recursive: true });
fs.copyFileSync(path.join(root, 'dist', archive), path.join(output, archive));
for (const name of sources.slice(1)) {
  fs.copyFileSync(path.join(packaging, name), path.join(output, name));
}
const checksums = sources.map((name) => crypto.createHash('sha256')
  .update(fs.readFileSync(path.join(output, name))).digest('hex'));
let recipe = fs.readFileSync(path.join(packaging, 'PKGBUILD'), 'utf8');
recipe = recipe.replace(/^pkgver=.*$/m, `pkgver=${version.replace(/-/g, '_')}`)
  .replace(/^pkgrel=.*$/m, 'pkgrel=1')
  .replace('"$url/releases/download/v$pkgver/AeterMC-$pkgver-linux.tar.gz"',
    `"$url/releases/download/v${version}/${archive}"`)
  .replace(/sha256sums=\([\s\S]*?\)/, `sha256sums=(${checksums.map((hash) => `'${hash}'`).join('\n            ')})`);
fs.writeFileSync(path.join(output, 'PKGBUILD'), recipe);
console.log(`Arch recipe and verified local sources: ${output}`);
