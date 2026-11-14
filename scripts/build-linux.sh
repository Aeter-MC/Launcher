#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
version=$(node -p 'require("./package.json").version')
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT

mkdir -p "$stage/app/node_modules" "$stage/release" dist
cp -r src assets package.json "$stage/app/"
rm -f "$stage/app/src/"{dev-samples.js,renderer/dev-tools.js}
rm -rf "$stage/app/src/native-v2-runtime"
cp -r installer/src "$stage/app/src/installer"

# System Electron reports app.isPackaged=false even when an Arch package owns app.asar.
node - "$stage/app/package.json" <<'JS'
const fs = require('fs');
const manifestPath = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.distribution = 'package-manager';
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
JS

node <<'JS' > "$stage/production-deps"
const lock = require('./package-lock.json');
for (const [directory, entry] of Object.entries(lock.packages)) {
  if (!directory || entry.dev) continue;
  const manifest = require(`./${directory}/package.json`);
  if (manifest.version !== entry.version) {
    throw new Error(`Run npm ci: ${directory} must be at ${entry.version}`);
  }
  console.log(directory);
}
JS

while IFS= read -r dependency; do
    mkdir -p "$stage/app/$dependency"
    cp -r "$dependency/." "$stage/app/$dependency/"
    # Nested dependencies are copied separately from the lockfile.
    rm -rf "$stage/app/$dependency/node_modules"
done < "$stage/production-deps"

node node_modules/@electron/asar/bin/asar.js pack "$stage/app" "$stage/release/app.asar"
install -m644 assets/icon.png "$stage/release/aetermc.png"
tar -C "$stage/release" --mtime=@0 --owner=0 --group=0 --numeric-owner -czf "dist/AeterMC-$version-linux.tar.gz" app.asar aetermc.png
