/**
 * java-detector.js
 * locates installed Java JDK/JRE runtimes.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, execFile } = require('child_process');

const JAVA_BINARY = process.platform === 'win32' ? 'java.exe' : 'java';

function checkJavaPath(exePath) {
  return new Promise((resolve) => {
    if (!fs.existsSync(exePath)) {
      return resolve(null);
    }

    execFile(exePath, ['-version'], { timeout: 5000, windowsHide: true }, (error, stdout, stderr) => {
      if (error) return resolve(null);
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

      // extract version: e.g. "21.0.12" or "1.8.0_351"
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

function checkJavaGc(exePath, gcFlag) {
  return new Promise((resolve) => {
    if (!fs.existsSync(exePath) || !/^-XX:\+Use(?:Z|Shenandoah)GC$/.test(gcFlag)) return resolve(false);
    execFile(exePath, [gcFlag, '-version'], { timeout: 5000, windowsHide: true }, (error) => resolve(!error));
  });
}

/**
 * recursively looks for the Java executable in bin/ under a folder (limited depth).
 */
function scanForJava(dir, depth, found) {
  if (depth < 0) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  const exe = path.join(dir, 'bin', JAVA_BINARY);
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
 * while the executable has not changed (same size and modification time).
 */
async function detectJavaInstallations(extraRoots = [], cache = null) {
  const foundPaths = new Set();
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const searchRoots = process.platform === 'win32' ? [
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
  ] : ['/usr/lib/jvm', '/usr/lib64/jvm', path.join(os.homedir(), '.minecraft', 'runtime')];
  searchRoots.push(...extraRoots);

  for (const root of searchRoots) {
    if (root && fs.existsSync(root)) scanForJava(root, 4, foundPaths);
  }

  if (process.platform === 'win32') {
    try {
      const output = execFileSync('where.exe', ['java'], { encoding: 'utf-8', timeout: 2000, windowsHide: true });
      for (const candidate of output.trim().split(/\r?\n/)) {
        // skip Oracle's javapath shim, which redirects to a real install.
        if (candidate && fs.existsSync(candidate) && !/javapath/i.test(candidate)) foundPaths.add(candidate);
      }
    } catch (e) {}
  } else {
    for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
      try {
        const candidate = fs.realpathSync(path.resolve(dir, JAVA_BINARY));
        fs.accessSync(candidate, fs.constants.X_OK);
        foundPaths.add(candidate);
      } catch (e) {}
    }
  }

  if (process.env.JAVA_HOME) {
    const homeExe = path.join(process.env.JAVA_HOME, 'bin', JAVA_BINARY);
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
 * picks the best Java for a required major version:
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
  checkJavaGc,
  pickJavaFor,
  JAVA_BINARY
};
