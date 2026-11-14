# AeterMC

![AeterMC](assets/icon.png)

Minecraft: Java Edition launcher built with Electron. [Website](https://aeter.waruk.xyz)

## Build

Run commands from the repository root with Node.js 22 and npm.

### Windows x64

Requires MSVC x64, the Windows SDK, and JDK 21. Set `JAVA_HOME` or put the JDK on `PATH`.

```powershell
npm ci
npm run build -- --no-workspace-copy
```

The installer and portable build go to `dist/`. Add `--setup-only` to build just the installer. New Windows instance shortcuts use Native V2 by default.

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
