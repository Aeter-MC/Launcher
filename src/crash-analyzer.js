/**
 * crash-analyzer.js
 * After the game exits with an error: what most likely happened, in plain words, and what to do.
 * Looks at the newest crash report written during the session (crash-reports/), a JVM fatal error
 * log (hs_err_pid*.log) and the game's own output, and returns
 *   { title, text, culprits: [{ id, name, file }], actions: [{ type, … }], details, reportFile }.
 * The mods of the build (mod-meta.js) turn mod ids from stack traces into names and jar files.
 */
const fs = require('fs');
const path = require('path');
const { t } = require('./i18n/i18n');

// class file version -> Java
const CLASS_VERSIONS = { 52: 8, 55: 11, 60: 16, 61: 17, 65: 21, 66: 22, 67: 23, 68: 24, 69: 25, 70: 26 };
// ids that appear in stack traces but are never the cause
const NOT_CULPRITS = new Set(['minecraft', 'java', 'fabricloader', 'fabric-api', 'fabric', 'mixinextras', 'forge', 'neoforge', 'fabric-api-base']);

function newestFile(dir, test, since) {
  let best = null;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!test(name)) continue;
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.mtimeMs >= since - 2000 && (!best || st.mtimeMs > best.time)) best = { file: full, time: st.mtimeMs };
    }
  } catch (e) {}
  return best && best.file;
}

function read(file, max = 400000) {
  try {
    const s = fs.readFileSync(file, 'utf-8');
    return s.length > max ? s.slice(0, max) : s;
  } catch (e) {
    return '';
  }
}

/** id -> { id, name, file } over the build's jars, bundled mods pointing at their outer jar. */
function modIndex(jars) {
  const index = new Map();
  for (const jar of jars || []) {
    for (const mod of jar.mods || []) {
      if (!mod.id || (index.has(mod.id) && mod.bundled)) continue;
      index.set(mod.id, { id: mod.id, name: mod.name || mod.id, file: jar.file, bundled: !!mod.bundled });
    }
  }
  return index;
}

/** Mod ids named by a crash: Fabric's "Suspected Mods" line and mixin handler names in the stack trace. */
function suspects(text, index) {
  const ids = [];
  const push = (id) => { if (id && !NOT_CULPRITS.has(id) && !ids.includes(id)) ids.push(id); };
  const suspected = /Suspected Mods?:\s*(.+)/i.exec(text);
  if (suspected && !/None|Unknown/i.test(suspected[1])) {
    for (const m of suspected[1].matchAll(/\(([a-z0-9_.-]+)\)/gi)) push(m[1]);
  }
  // only the exception's own stack, not the long system details below it
  const stack = text.split(/\n-- |\nA detailed walkthrough/)[0];
  // mixin-merged methods are named like handler$zlb000$debugify$scaleNearClipDistance
  for (const m of stack.matchAll(/\$[a-z]{3}\d{3}\$([a-z][a-z0-9_]*)\$/g)) push(m[1]);
  // frames of a mod's own classes: match package names against the mod ids we know
  for (const m of stack.matchAll(/^\s*at (?:[\w.-]+\/\/)?([\w.$]+)\.[\w$<>]+\(/gm)) {
    const pkg = m[1].toLowerCase();
    if (/^(java|jdk|sun|net\.minecraft|com\.mojang|org\.lwjgl|it\.unimi|com\.google|org\.spongepowered|net\.fabricmc|cpw|net\.neoforged|net\.minecraftforge)\./.test(pkg)) continue;
    for (const id of index.keys()) {
      const key = id.replace(/[-_]/g, '');
      if (key.length >= 4 && pkg.split('.').some(seg => seg.replace(/[-_]/g, '') === key)) push(id);
    }
  }
  return ids;
}

function culpritList(ids, index) {
  return ids.map(id => index.get(id) || { id, name: id, file: null }).slice(0, 4);
}

/**
 * gameDir: the build's game folder; since: launch time (ms); output: the game's console lines (strings);
 * jars: scanModsDir() of the build; maxRam: GB; javaMajor.
 */
function analyzeCrash({ gameDir, since, output = [], jars = [], maxRam = 4, javaMajor = 0, exitCode = null }) {
  const index = modIndex(jars);
  const reportFile = newestFile(path.join(gameDir, 'crash-reports'), n => /\.txt$/i.test(n), since);
  const hsErr = newestFile(gameDir, n => /^hs_err_pid\d+\.log$/i.test(n), since);
  const report = reportFile ? read(reportFile) : '';
  const out = output.join('\n');
  // a JVM fatal error log names the failing DLL (graphics driver) in its "Problematic frame"
  const all = `${report}\n${out}\n${hsErr ? read(hsErr, 20000) : ''}`;
  const result = { title: t('Игра вылетела'), text: '', culprits: [], actions: [], details: '', reportFile: reportFile || hsErr || null };
  // a jar that is already switched off is not offered again
  const disable = (c) => c.file && !/\.disabled$/i.test(c.file) && result.actions.push({ type: 'disable', file: c.file, label: t('Выключить «{name}»', { name: c.name }) });

  // 1. Fabric refused the mod set before the game started
  if (/Incompatible mods? found|Some of your mods are incompatible/i.test(all)) {
    const lines = (all.match(/^\s*- (?:Replace|Remove|Install|Mod ').*$/gm) || []).map(s => s.trim().replace(/^- /, ''));
    result.title = t('Моды несовместимы');
    result.text = t('Fabric не стал запускать игру: часть модов требует другие версии модов или загрузчика.');
    result.details = [...new Set(lines)].slice(0, 12).join('\n');
    const loader = /Replace mod 'Fabric Loader' \(fabricloader\) \S+ with version (\d+(?:\.\d+)*)/.exec(all);
    if (loader) result.actions.push({ type: 'loader', version: loader[1], label: t('Обновить Fabric Loader до {version}', { version: loader[1] }) });
    result.actions.push({ type: 'mods', label: t('Открыть моды') });
    return result;
  }

  // 2. out of memory
  if (/java\.lang\.OutOfMemoryError|Out of memory|insufficient memory for the Java Runtime/i.test(all)) {
    const native = /insufficient memory for the Java Runtime|Native memory allocation/i.test(all);
    result.title = t('Не хватило памяти');
    result.text = native
      ? t('Системе не хватило оперативной памяти для Java. Закройте лишние программы или уменьшите максимум памяти (сейчас {ram} ГБ).', { ram: maxRam })
      : t('Игре не хватило выделенной памяти ({ram} ГБ). Для больших сборок обычно нужно 6–8 ГБ.', { ram: maxRam });
    result.actions.push({ type: 'launch-settings', label: t('Настройки сборки') });
    return result;
  }

  // 3. Java too old for the game or a mod
  const classVer = /UnsupportedClassVersionError.*?class file version (\d+)/.exec(all);
  if (classVer) {
    const need = CLASS_VERSIONS[parseInt(classVer[1], 10)] || `${parseInt(classVer[1], 10) - 44}`;
    result.title = t('Нужна более новая Java');
    result.text = t('Игре или моду нужна Java {need}, а запущена Java {have}. Выберите «Автоматически» или Java {need} в настройках сборки.', { need, have: javaMajor || '?' });
    result.actions.push({ type: 'launch-settings', label: t('Настройки сборки') });
    return result;
  }

  // 4. the JVM did not start with these arguments
  const badOption = /Unrecognized VM option '([^']+)'|Unrecognized option: (\S+)|Error: Could not create the Java Virtual Machine|Conflicting collector combinations|Multiple garbage collectors selected/i.exec(all);
  if (badOption) {
    const opt = badOption[1] || badOption[2];
    result.title = t('Java не приняла аргументы запуска');
    result.text = opt
      ? t('Java не знает аргумент {option}. Уберите его из своих аргументов JVM или выберите другую Java.', { option: opt })
      : t('Java не запустилась с такими аргументами JVM. Проверьте свои аргументы и оптимизацию JVM.');
    result.actions.push({ type: 'launch-settings', label: t('Настройки сборки') });
    return result;
  }

  // 5. graphics driver
  const driver = /(atio6axx|atioglxx|amdxx64|nvoglv64|ig\d+icd64|ig\w*64)\.dll/i.exec(all);
  if (driver || /Pixel format not accelerated|GLFW error 65542|WGL: The driver does not appear to support OpenGL/i.test(all)) {
    result.title = t('Ошибка видеодрайвера');
    result.text = driver
      ? t('Игра упала внутри видеодрайвера ({dll}). Обновите драйвер видеокарты; если не поможет — попробуйте без шейдеров.', { dll: driver[0] })
      : t('Видеодрайвер не поддерживает нужный OpenGL. Обновите драйвер видеокарты.');
    const shader = ['iris', 'oculus', 'optifine'].map(id => index.get(id)).find(Boolean);
    if (shader) disable(shader);
    return result;
  }

  // 6. a class that is not there: usually a missing dependency or a mod for another version
  const missing = /(?:NoClassDefFoundError|ClassNotFoundException):?\s*([\w/.$]+)/.exec(all);

  // 7. ordinary crash report: the exception and the mods involved
  const desc = /^Description:\s*(.+)$/m.exec(report);
  const exception = report
    ? (report.split(/\r?\n/).find((l, i, arr) => i > 0 && /^\S/.test(l) && /(Exception|Error)\b/.test(l) && arr[i - 1].trim() === '') || '')
    : (out.match(/^.*(?:Exception|Error)[:\s].*$/m) || [''])[0];
  const ids = suspects(report || out, index);
  result.culprits = culpritList(ids, index);

  if (missing && /net[./]fabricmc[./]fabric[./]api/i.test(missing[1]) && !index.has('fabric-api')) {
    result.title = t('Нет Fabric API');
    result.text = t('Модам нужен Fabric API, а его нет в сборке. Установите его на странице модов.');
    result.actions.push({ type: 'search', query: 'fabric-api', label: t('Найти Fabric API') });
    return result;
  }

  if (hsErr && !report) {
    const frame = /# Problematic frame:\s*\n#\s*(.+)/.exec(read(hsErr));
    result.title = t('Java упала с системной ошибкой');
    result.text = t('Это сбой внутри Java или драйвера, а не обычная ошибка мода. Часто помогает обновить видеодрайвер или выбрать другую Java.');
    result.details = frame ? frame[1].trim() : '';
    result.actions.push({ type: 'launch-settings', label: t('Настройки сборки') });
    return result;
  }

  if (result.culprits.length) {
    const names = result.culprits.map(c => `«${c.name}»`).join(', ');
    result.title = result.culprits.length === 1 ? t('Вероятная причина: {name}', { name: result.culprits[0].name }) : t('Вероятная причина — моды');
    result.text = result.culprits.length === 1
      ? t('Ошибка произошла в коде мода {names}. Обновите его или выключите и запустите снова.', { names })
      : t('В ошибке участвуют моды {names}: скорее всего, они конфликтуют. Попробуйте выключить один из них или обновить оба.', { names });
    result.culprits.filter(c => !c.bundled).forEach(disable);
  } else if (missing) {
    result.title = t('Не найден класс');
    result.text = t('Игра не нашла {cls}. Обычно это мод для другой версии Minecraft или не хватает мода-зависимости.', { cls: missing[1].replace(/\//g, '.') });
  } else {
    // nothing recognised: say so instead of guessing, and point at the game's own log
    result.unknown = true;
    result.title = t('Неизвестная ошибка');
    result.text = t('Лаунчер не смог определить причину вылета. Посмотрите лог игры: в его конце видно, на чём она остановилась.');
    if (exitCode !== null && exitCode !== 0) result.text += ' ' + t('Код выхода: {code}.', { code: exitCode });
  }
  result.details = [desc && desc[1], exception.trim()].filter(Boolean).join('\n');
  if (missing || result.culprits.length) result.actions.push({ type: 'mods', label: t('Открыть моды') });
  if (result.unknown) {
    const log = path.join(gameDir, 'logs', 'latest.log');
    // the log of this session only; a game that died before logging has just the console
    let fresh = false;
    try {
      fresh = fs.statSync(log).mtimeMs >= since - 2000;
    } catch (e) {}
    if (fresh) {
      result.logFile = log;
      result.actions.push({ type: 'log', label: t('Открыть лог') });
    } else {
      result.actions.push({ type: 'console', label: t('Открыть консоль') });
    }
  }
  return result;
}

module.exports = { analyzeCrash, suspects };
