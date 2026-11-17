'use strict';

// MCLC remains the source of JVM/loader arguments. Only a prepared launch is
// exported; this module never starts Java or writes plaintext account material.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PLACEHOLDERS = Object.freeze({ accessToken: '{{AETER_ACCESS_TOKEN}}', username: '{{AETER_USERNAME}}', uuid: '{{AETER_UUID}}', xuid: '{{AETER_XUID}}', clientId: '{{AETER_CLIENT_ID}}' });
const VALUE_OPTIONS = new Set(['-cp', '-classpath', '--class-path', '-p', '--module-path', '--upgrade-module-path', '--add-modules', '--limit-modules', '--add-reads', '--add-exports', '--add-opens', '--patch-module', '--enable-native-access']);

function validString(value, name, limit = 32768) {
  if (typeof value !== 'string' || value.includes('\0') || value.length > limit) throw new Error(`Invalid ${name}`);
  return value;
}

function splitJavaCommand(args) {
  if (!Array.isArray(args) || args.length > 16384) throw new Error('Invalid Java arguments');
  args = args.map(value => validString(String(value), 'Java argument'));
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg.startsWith('@') || ['-jar', '-m', '--module', '--', '--source'].includes(arg) || arg.startsWith('--module=')) throw new Error('Native V2 requires a class-based Minecraft launch');
    if (!arg.startsWith('-')) break;
    if (VALUE_OPTIONS.has(arg)) {
      if (++index >= args.length) throw new Error('Missing JVM option value');
    } else if (arg.startsWith('--') && !arg.includes('=') && !['--enable-preview', '--show-module-resolution', '--disable-@files'].includes(arg)) {
      throw new Error('Unsupported JVM option; Native V2 preparation needs an explicit option value');
    }
    index++;
  }
  const mainClass = args[index];
  if (!mainClass || !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(mainClass)) throw new Error('Missing or invalid Minecraft main class');
  return { jvmArgs: args.slice(0, index), mainClass, gameArgs: args.slice(index + 1) };
}

function assertLocalPath(file, name = 'path') {
  validString(file, name);
  if (!path.isAbsolute(file)) throw new Error(`${name} must be absolute`);
  const resolved = path.resolve(file);
  // reject links on every existing component, not only the final file.
  for (let current = resolved; ; current = path.dirname(current)) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error(`${name} contains a symlink or junction`);
    if (path.dirname(current) === current) break;
  }
  return resolved;
}

function fingerprint(file) {
  file = assertLocalPath(file, 'input');
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('Invalid launch configuration input');
  return { path: file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
}

function versionInputs(root, version) {
  const result = [], seen = new Set();
  for (let i = 0; version && i < 16; i++) {
    if (seen.has(version) || !/^[^\\/\0]+$/.test(version) || ['.', '..'].includes(version)) throw new Error('Invalid version inheritance');
    seen.add(version);
    const file = path.join(root, 'versions', version, `${version}.json`);
    const input = fingerprint(file);
    result.push(input);
    version = JSON.parse(fs.readFileSync(file, 'utf8')).inheritsFrom;
  }
  if (version) throw new Error('Version inheritance is too deep');
  return result;
}

function requiredFiles(java, jvmArgs) {
  const result = new Set([assertLocalPath(java, 'Java executable')]);
  for (let i = 0; i < jvmArgs.length; i++) {
    const arg = jvmArgs[i];
    let entries;
    if (['-cp', '-classpath', '--class-path', '-p', '--module-path'].includes(arg)) entries = jvmArgs[++i];
    else if (/^--(?:class|module)-path=/.test(arg)) entries = arg.slice(arg.indexOf('=') + 1);
    if (entries !== undefined) {
      for (const item of entries.split(path.delimiter)) {
        if (!item || item.includes('*')) throw new Error('Native V2 requires explicit absolute library paths');
        result.add(assertLocalPath(item, 'library'));
      }
    }
  }
  for (const file of result) if (!fs.statSync(file).isFile()) throw new Error('Required Java/library file is missing');
  return [...result];
}

function credentialsFor(account, authorization) {
  if (!account || !['offline', 'microsoft'].includes(account.type)) throw new Error('Native V2 supports offline and Microsoft accounts; prepare other accounts with Aeter');
  if (!authorization) throw new Error('Prepared authorization is missing');
  const credentials = {
    type: account.type,
    accessToken: String(authorization.access_token || ''),
    refreshToken: account.type === 'microsoft' ? String(authorization.meta?.refresh || '') : '',
    expiresAt: account.type === 'microsoft' ? Number(authorization.meta?.exp || 0) : 0,
    username: String(authorization.name || account.username || ''),
    uuid: String(authorization.uuid || account.uuid || ''),
    xuid: String(authorization.meta?.xuid || '0'),
    clientId: String(authorization.meta?.clientId || authorization.client_token || authorization.uuid || '')
  };
  for (const [key, value] of Object.entries(credentials)) if (typeof value === 'string') validString(value, key);
  if (!credentials.username || !credentials.uuid || !credentials.accessToken || !Number.isFinite(credentials.expiresAt)) throw new Error('Account is not ready for native launch');
  return credentials;
}

function replaceIdentity(args, credentials) {
  const fields = new Map([['--accessToken', 'accessToken'], ['--session', 'accessToken'], ['--username', 'username'], ['--uuid', 'uuid'], ['--xuid', 'xuid'], ['--clientId', 'clientId']]);
  // long secrets are replaced inside composite values too. Short identities (0,
  // a one-character offline name) are only replaced in their typed game fields.
  const replacements = Object.keys(PLACEHOLDERS).filter(key => credentials[key].length >= 8)
    .sort((a, b) => credentials[b].length - credentials[a].length);
  return args.map((value, index) => {
    const typed = fields.get(args[index - 1]);
    if (typed) return PLACEHOLDERS[typed];
    const equal = value.indexOf('=');
    if (equal >= 0 && fields.has(value.slice(0, equal))) return value.slice(0, equal + 1) + PLACEHOLDERS[fields.get(value.slice(0, equal))];
    let result = value;
    for (const key of replacements) result = result.split(credentials[key]).join(PLACEHOLDERS[key]);
    return result;
  });
}

function makeProvision({ command, account, instance, root, profile, settingsPath, accountsPath, customVersion, appVersion, rpcEnabled = true }) {
  if (!instance || !validString(instance.id, 'instance ID', 512)) throw new Error('Missing instance ID');
  const credentials = credentialsFor(account, command.authorization);
  const split = splitJavaCommand(command.args);
  // secrets must never be passed as JVM flags/properties: only bootstrap input.
  const secrets = [credentials.accessToken, credentials.refreshToken].filter(value => value.length >= 4);
  if (split.jvmArgs.some(arg => secrets.some(secret => arg.includes(secret)))) throw new Error('A secret occurs in JVM arguments; remove it before preparing the shortcut');
  const inputs = [settingsPath, accountsPath, path.join(instance.path, 'instance.cfg'), path.join(instance.path, 'mmc-pack.json'), path.join(instance.path, 'instance.json')]
    .filter(file => file && fs.existsSync(file)).map(fingerprint);
  inputs.push(...versionInputs(root, customVersion || instance.version));
  const plan = {
    schema: 2, id: instance.id,
    java: assertLocalPath(command.java, 'Java executable'), cwd: assertLocalPath(command.cwd, 'game directory'),
    jvmArgs: split.jvmArgs, mainClass: split.mainClass, gameArgs: replaceIdentity(split.gameArgs, credentials),
    accountId: validString(String(account.id || ''), 'account ID', 512),
    inputs: [...new Map(inputs.map(input => [input.path, input])).values()],
    requiredFiles: requiredFiles(command.java, split.jvmArgs),
    rpc: { enabled: !!rpcEnabled, details: String(instance.name || 'Minecraft').slice(0, 128),
      state: `${instance.loader && instance.loader !== 'vanilla' ? instance.loader.charAt(0).toUpperCase() + instance.loader.slice(1) + ' · ' : ''}Minecraft ${instance.version}`.slice(0, 128),
      largeText: `AeterMC ${appVersion || ''}`.trim().slice(0, 128) }
  };
  if (!plan.accountId) throw new Error('Missing account ID');
  // the plan is sealed too, but still reject credential residue in fields that
  // can become OS-visible arguments or diagnostic data.
  if (secrets.some(secret => JSON.stringify(plan).includes(secret))) throw new Error('Credentials could not be removed from the prepared plan');
  assertLocalPath(profile, 'native profile');
  return { plan, credentials };
}

function runnerPath(app) {
  if (!app.isPackaged) return path.join(__dirname, '..', 'native', 'v2', 'bin', 'AeterNative.exe');
  const assets = path.join(__dirname, 'native-v2-runtime');
  const files = ['AeterNative.exe', 'aeter-bootstrap.jar'].map(name => ({ name, bytes: fs.readFileSync(path.join(assets, name)) }));
  const hash = crypto.createHash('sha256');
  for (const { name, bytes } of files) hash.update(name).update(crypto.createHash('sha256').update(bytes).digest());
  const directory = assertLocalPath(path.join(app.getPath('userData'), 'native-v2', 'runtime', hash.digest('hex')));
  fs.mkdirSync(directory, { recursive: true });
  for (const { name, bytes } of files) {
    const destination = assertLocalPath(path.join(directory, name));
    if (!fs.existsSync(destination)) {
      const temp = `${destination}.${crypto.randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temp, bytes, { flag: 'wx' });
        if (!fs.existsSync(destination)) fs.renameSync(temp, destination);
      } finally { fs.rmSync(temp, { force: true }); }
    }
    if (!fs.readFileSync(destination).equals(bytes)) throw new Error('Native V2 runtime verification failed');
  }
  return path.join(directory, 'AeterNative.exe');
}

function provision({ runner, profile, payload, spawnProcess = spawn }) {
  runner = assertLocalPath(runner, 'native executable');
  profile = assertLocalPath(profile, 'native profile');
  const bytes = Buffer.from(JSON.stringify(payload));
  if (bytes.length > 4 * 1024 * 1024) throw new Error('Native plan is too large');
  return new Promise((resolve, reject) => {
    const child = spawnProcess(runner, ['--provision', '--profile', profile, '--instance', payload.plan.id], { windowsHide: true, shell: false, stdio: ['pipe', 'ignore', 'pipe'] });
    child.stderr?.resume();
    const timer = setTimeout(() => { child.kill(); }, 30000);
    const finish = error => { clearTimeout(timer); bytes.fill(0); error ? reject(error) : resolve(); };
    child.once('error', () => finish(new Error('Native launcher could not start')));
    child.once('exit', code => finish(code === 0 ? null : new Error('Native provisioning failed; verify the profile and prepared files')));
    child.stdin.on('error', () => {});
    child.stdin.end(bytes, () => bytes.fill(0));
  });
}

module.exports = { PLACEHOLDERS, splitJavaCommand, fingerprint, makeProvision, provision, runnerPath, replaceIdentity, assertLocalPath };
