/**
 * java-detector.js
 * Scans Windows directories and system registry/PATH to locate installed Java JDK/JRE runtimes.
 */
const fs = require('fs');
const path = require('path');
const { execSync, exec } = require('child_process');

function checkJavaPath(exePath) {
  return new Promise((resolve) => {
    if (!fs.existsSync(exePath)) {
      return resolve(null);
    }

    exec(`"${exePath}" -version`, { timeout: 5000, windowsHide: true }, (error, stdout, stderr) => {
      const output = (stderr || stdout || '').toString();
      if (!output) {
        return resolve({
          path: exePath,
          name: path.basename(path.dirname(path.dirname(exePath))),
          version: 'Unknown',
          major: 0,
          is64Bit: true
        });
      }

      // Extract version: e.g. "21.0.12" or "1.8.0_351"
      const verMatch = output.match(/version\s+"([^"]+)"/i) || output.match(/openjdk\s+(\S+)/i);
      const versionStr = verMatch ? verMatch[1] : 'Unknown';
      let major = 0;
      if (versionStr.startsWith('1.')) {
        major = parseInt(versionStr.split('.')[1], 10);
      } else {
        major = parseInt(versionStr.split('.')[0], 10);
      }

      const is64Bit = output.includes('64-Bit') || output.includes('64-bit') || process.arch === 'x64';
      const folderName = path.basename(path.dirname(path.dirname(exePath)));

      resolve({
        path: exePath,
        name: `${folderName} (Java ${major || versionStr})`,
        version: versionStr,
        major: major || 0,
        is64Bit
      });
    });
  });
}

/**
 * Recursively looks for bin/java.exe under a folder (limited depth).
 */
function scanForJava(dir, depth, found) {
  if (depth < 0) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  const exe = path.join(dir, 'bin', 'java.exe');
  if (fs.existsSync(exe)) {
    found.add(exe);
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name !== 'bin') {
      scanForJava(path.join(dir, entry.name), depth - 1, found);
    }
  }
}

/**
 * cache: optional DiskCache. Running `java -version` is the slow part, so its result is reused
 * while java.exe itself has not changed (same size and modification time).
 */
async function detectJavaInstallations(extraRoots = [], cache = null) {
  const foundPaths = new Set();
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const searchRoots = [
    path.join(pf, 'Eclipse Adoptium'),
    path.join(pf, 'Java'),
    path.join(pf, 'BellSoft'),
    path.join(pf, 'Amazon Corretto'),
    path.join(pf, 'Zulu'),
    path.join(pf, 'Microsoft'),
    path.join(pf86, 'Java'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Eclipse Adoptium'),
    path.join(process.env.APPDATA || '', '.minecraft', 'runtime'),
    path.join(process.env.APPDATA || '', 'PrismLauncher', 'java'),
    ...extraRoots
  ];

  for (const root of searchRoots) {
    if (root && fs.existsSync(root)) scanForJava(root, 4, foundPaths);
  }

  try {
    const whereOutput = execSync('where java', { encoding: 'utf-8', timeout: 2000, windowsHide: true }).trim().split(/\r?\n/);
    for (const p of whereOutput) {
      // Skip Oracle's javapath shim, it just redirects to a real install
      if (p && fs.existsSync(p) && !/javapath/i.test(p)) foundPaths.add(p);
    }
  } catch (e) {}

  if (process.env.JAVA_HOME) {
    const homeExe = path.join(process.env.JAVA_HOME, 'bin', 'java.exe');
    if (fs.existsSync(homeExe)) foundPaths.add(homeExe);
  }

  const known = (cache && cache.read('java')) || {};
  const fresh = {};
  const results = (await Promise.all([...foundPaths].map(async (p) => {
    let stamp = '';
    try {
      const st = fs.statSync(p);
      stamp = `${st.size}:${st.mtimeMs}`;
    } catch (e) {
      return null;
    }
    const hit = known[p];
    const info = hit && hit.stamp === stamp ? hit.info : await checkJavaPath(p);
    if (info) fresh[p] = { stamp, info };
    return info;
  }))).filter(Boolean);
  if (cache) cache.write('java', fresh);
  results.sort((a, b) => b.major - a.major);
  return results;
}

/**
 * Picks the best Java for a required major version:
 * exact match first, then the closest newer one (Java 8 games need exactly 8).
 */
function pickJavaFor(list, requiredMajor) {
  if (!list || list.length === 0) return null;
  const exact = list.find(j => j.major === requiredMajor);
  if (exact) return exact;
  if (requiredMajor <= 8) return null;
  const newer = list.filter(j => j.major > requiredMajor).sort((a, b) => a.major - b.major);
  return newer[0] || null;
}

module.exports = {
  detectJavaInstallations,
  checkJavaPath,
  pickJavaFor
};
