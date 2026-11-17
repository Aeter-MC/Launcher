# AeterMC

![AeterMC](assets/icon.png)

Minecraft: Java Edition launcher built with Electron. [Website](https://aeter.waruk.xyz)

## Launcher features

- **Settings → Appearance → Home layout editor** opens a live preview. Drag cards between columns, drag a column edge to resize it, or right-click a card for its settings. Open a news card to read the full post inside AeterMC.
- **Settings → MultiMC (and its forks)** can copy compatible instances into AeterMC or show and launch them from their original folders. Prism Launcher, Freesm Launcher, PolyMC and MultiMC share the same `instance.cfg` / `mmc-pack.json` format. Use **Add folder** for portable installs or other forks. A copied instance keeps its game content and portable settings and uses AeterMC's accounts, Java and JVM arguments.

## Build

Run commands from the repository root with Node.js 22 and npm.

### Windows x64

Requires MSVC x64, the Windows SDK, and JDK 21. Set `JAVA_HOME` or put the JDK on `PATH`.

```powershell
npm ci
npm run build -- --no-workspace-copy
```

The installer and portable build go to `dist/`. Add `--setup-only` to build just the installer. The portable build keeps its settings, accounts, instances, cache, and downloaded runtimes in `AeterMC-data` beside the portable executable. New Windows instance shortcuts use Native V2 by default.

For local development, run `npm run native:v2` once to compile the shortcut handler, then `npm start`. The normal build compiles the handler automatically.

### Linux x64

```sh
npm ci
node scripts/build-deb.js
node scripts/build-deb.js --appimage
bash scripts/build-linux.sh
node scripts/prepare-arch.js
```

The Debian package and AppImage go to `dist/`. On Arch, run `makepkg` in `dist/arch/` as a regular user.
