'use strict';

// local build only. Never invokes the legacy installer or writes outside this checkout.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const native = path.join(root, 'native', 'v2');
const build = path.join(native, 'build');
const state = path.join(root, '.test-state', 'build');
const release = path.join(native, 'bin');
const tests = path.join(native, 'test-bin');
const releaseOnly = process.argv.includes('--release-only');
for (const dir of [build, state, release, tests]) fs.mkdirSync(dir, { recursive: true });
const env = { ...process.env, TEMP: state, TMP: state, TMPDIR: state };
const report = { platform: process.platform, started: new Date().toISOString(), commands: [], artifacts: [] };

function run(file, args, options = {}) {
  report.commands.push({ file, args });
  const output = execFileSync(file, args, { cwd: build, env, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...options });
  if (output) process.stdout.write(output);
  return output;
}
function latestDirectory(dir, pattern) {
  return fs.readdirSync(dir).filter(name => pattern.test(name) && fs.statSync(path.join(dir, name)).isDirectory())
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
}
function record(file) {
  const bytes = fs.readFileSync(file);
  report.artifacts.push({ path: path.relative(root, file), bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
}
try {
  if (process.platform !== 'win32') throw new Error('This local build script targets Windows x64. Linux compilation requires a local Linux toolchain.');
  const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  const vs = run(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath']).trim();
  if (!vs) throw new Error('A local MSVC C++ toolchain was not found; no components were installed.');
  const toolsRoot = path.join(vs, 'VC', 'Tools', 'MSVC');
  const toolsVersion = latestDirectory(toolsRoot, /^\d+\./);
  if (!toolsVersion) throw new Error('MSVC tools directory is missing.');
  const msvc = path.join(toolsRoot, toolsVersion);
  const compilerDirectory = path.join(msvc, 'bin', 'Hostx64', 'x64');
  const compiler = path.join(compilerDirectory, 'cl.exe');
  const sdk = process.env.AETER_V2_BUILD_SDK || path.join(root, 'native', 'bin', 'sdk');
  const installedSdk = process.env.WindowsSdkDir || path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Windows Kits', '10');
  const localIncludes = path.join(sdk, 'headers', 'c', 'Include');
  const useLocalSdk = fs.existsSync(localIncludes);
  const includesRoot = useLocalSdk ? localIncludes : path.join(installedSdk, 'Include');
  const sdkVersion = fs.existsSync(includesRoot) && latestDirectory(includesRoot, /^10\./);
  if (!sdkVersion) throw new Error('Windows SDK not found. Use an installed Windows SDK or the local build SDK.');
  const sdkLib = useLocalSdk ? path.join(sdk, 'libs', 'c') : path.join(installedSdk, 'Lib', sdkVersion);
  env.INCLUDE = [path.join(msvc, 'include'), ...['ucrt', 'shared', 'um'].map(name => path.join(includesRoot, sdkVersion, name))].join(';');
  env.LIB = [path.join(msvc, 'lib', 'x64'), ...['ucrt', 'um'].map(name => path.join(sdkLib, name, 'x64'))].join(';');
  // windows environment names are case-insensitive, including when inherited from Node.
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'Path';
  env[pathKey] = compilerDirectory + ';' + (env[pathKey] || '');
  report.toolchain = { msvc: toolsVersion, sdk: sdkVersion, compiler };
  const common = ['/nologo', '/std:c++20', '/EHsc', '/W4', '/O2', '/MT', '/utf-8', '/guard:cf', '/DUNICODE', '/D_UNICODE', '/DNOMINMAX', '/DWIN32_LEAN_AND_MEAN'];
  const link = ['/link', '/DYNAMICBASE', '/HIGHENTROPYVA', '/NXCOMPAT', '/guard:cf', '/INCREMENTAL:NO'];
  const libs = ['crypt32.lib', 'advapi32.lib', 'shell32.lib', 'user32.lib', 'ole32.lib', 'winhttp.lib', 'bcrypt.lib'];
  const runner = path.join(native, 'runner.cpp');
  if (!fs.existsSync(runner)) throw new Error('native/v2/runner.cpp is not ready.');
  for (const test of releaseOnly ? [false] : [false, true]) {
    const file = path.join(test ? tests : release, test ? 'AeterNativeTest.exe' : 'AeterNative.exe');
    run(compiler, [...common, ...(test ? ['/DAETER_NATIVE_TESTING'] : []), `/Fe:${file}`, `/Fo:${path.join(build, test ? 'runner-test.obj' : 'runner.obj')}`, runner, ...link, '/SUBSYSTEM:WINDOWS', ...libs]);
    record(file);
  }
  const mock = path.join(native, 'test-java.cpp');
  if (!releaseOnly && fs.existsSync(mock)) {
    const file = path.join(tests, 'MockJava.exe');
    run(compiler, [...common, `/Fe:${file}`, `/Fo:${path.join(build, 'test-java.obj')}`, mock, ...link, '/SUBSYSTEM:CONSOLE', ...libs]);
    record(file);
  }
  const jdk = process.env.AETER_V2_BUILD_JDK || process.env.JAVA_HOME;
  const javaTool = name => jdk ? path.join(jdk, 'bin', `${name}.exe`) : `${name}.exe`;
  const classes = path.join(build, 'java-classes');
  fs.mkdirSync(classes, { recursive: true });
  const java = path.join(native, 'java', 'dev', 'aeter', 'nativebridge', 'Main.java');
  run(javaTool('javac'), ['--release', '8', '-encoding', 'UTF-8', '-d', classes, java]);
  const jar = path.join(release, 'aeter-bootstrap.jar');
  run(javaTool('jar'), ['--create', '--file', jar, '--main-class', 'dev.aeter.nativebridge.Main', '-C', classes, '.']);
  record(jar);
  if (!releaseOnly) fs.copyFileSync(jar, path.join(tests, 'aeter-bootstrap.jar'));
  const packagedRuntime = path.join(root, 'src', 'native-v2-runtime');
  fs.mkdirSync(packagedRuntime, { recursive: true });
  for (const name of ['AeterNative.exe', 'aeter-bootstrap.jar']) {
    fs.copyFileSync(path.join(release, name), path.join(packagedRuntime, name));
  }
  report.finished = new Date().toISOString();
  console.log(JSON.stringify(report.artifacts, null, 2));
} catch (error) {
  report.error = error.message;
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(state, 'native-build.json'), JSON.stringify(report, null, 2) + '\n');
}
