/** System Electron can run an installed app.asar with app.isPackaged === false. */
function isPackageManagerInstall({ platform, appImage, isPackaged, distribution, appPath }) {
  return platform === 'linux' && !appImage && (
    distribution === 'package-manager' || isPackaged === true ||
    // Compatibility with Arch packages built before the distribution marker was added.
    appPath === '/usr/lib/aetermc/app.asar'
  );
}

module.exports = { isPackageManagerInstall };
