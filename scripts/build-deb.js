/** build a Debian package or AppImage with the locked Electron runtime. */
const fs = require('fs');
const path = require('path');
const builder = require('electron-builder');

const root = path.join(__dirname, '..');
const target = process.argv.includes('--appimage') ? 'AppImage' : 'deb';
const installer = path.join(root, 'installer', 'src');

// the pinned builder infers PNG sizes from filenames when given an icon set.
const iconDirectory = path.join(root, 'dist', 'linux-icons');
fs.mkdirSync(iconDirectory, { recursive: true });
fs.copyFileSync(path.join(root, 'assets', 'icon.png'), path.join(iconDirectory, '256x256.png'));

const config = {
  ...require('../package.json').build,
  extraMetadata: {
    ...(target === 'deb' ? { distribution: 'package-manager' } : {}),
    homepage: 'https://github.com/Aeter-MC/Launcher'
  },
  files: [
    'src/**/*', 'assets/**/*', 'package.json',
    '!src/dev-samples.js', '!src/native-v2-runtime/**/*', '!src/renderer/dev-tools.js',
    { from: installer, to: 'src/installer' }
  ],
  linux: {
    executableName: 'aetermc',
    icon: iconDirectory,
    category: 'Game',
    maintainer: 'AeterMC contributors',
    artifactName: 'AeterMC-${version}-${arch}.${ext}'
  },
  deb: {
    // explicit dependencies keep this compatible with Debian and Ubuntu's t64 transition.
    depends: [
      'libgtk-3-0 | libgtk-3-0t64', 'libnotify4', 'libnss3', 'libxss1',
      'libxtst6', 'libatspi2.0-0 | libatspi2.0-0t64', 'libuuid1',
      'libsecret-1-0', 'libasound2 | libasound2t64', 'xdg-utils', 'tar'
    ]
  }
};
// a separate config file avoids merging these filters with package.json's Windows defaults.
const configPath = path.join(root, 'dist', `${target.toLowerCase()}-builder.json`);
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
builder.build({
  projectDir: root,
  targets: builder.Platform.LINUX.createTarget([target], builder.Arch.x64),
  publish: 'never',
  config: configPath
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
