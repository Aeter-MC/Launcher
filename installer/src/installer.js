/**
 * installer.js
 * Page of the installer / uninstaller window. The work itself happens in installer-main.js.
 */
const $ = (id) => document.getElementById(id);

const STEPS = {
  install: [
    { id: 'options', label: 'Параметры' },
    { id: 'progress', label: 'Установка' },
    { id: 'done', label: 'Готово' }
  ],
  uninstall: [
    { id: 'confirm', label: 'Подтверждение' },
    { id: 'progress', label: 'Удаление' },
    { id: 'done', label: 'Готово' }
  ]
};

let info = null;
let busy = false;
let installedExe = null;

// ---------- steps in the left column ----------

function renderSteps(current) {
  const list = STEPS[info.mode];
  const idx = Math.max(0, list.findIndex(s => s.id === (current === 'error' ? 'progress' : current)));
  $('steps').innerHTML = list.map((s, i) => {
    const cls = i < idx || (current === 'done' && i === idx) ? 'done' : i === idx ? 'active' : '';
    const num = cls === 'done' ? '<svg class="ic"><use href="#i-check"/></svg>' : i + 1;
    return `<div class="step ${cls}"><span class="step-num">${num}</span>${s.label}</div>`;
  }).join('');
}

/** Shows a screen and sets the footer buttons: [label, handler] or null to hide. */
function show(screen, { primary = null, secondary = null, note = '' } = {}) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.dataset.screen === screen));
  renderSteps(screen);
  setButton($('primary'), primary);
  setButton($('secondary'), secondary);
  $('foot-note').textContent = note;
}

function setButton(btn, spec) {
  btn.classList.toggle('hidden', !spec);
  if (!spec) return;
  btn.innerHTML = spec[0];
  btn.onclick = spec[1];
  btn.disabled = false;
  btn.className = `btn ${spec[2] || (btn.id === 'primary' ? 'btn-primary' : 'btn-ghost')}`;
}

// ---------- progress ----------

function formatSize(bytes) {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(0)} МБ` : `${Math.round(bytes / 1024)} КБ`;
}

window.setup.onProgress((p) => {
  const fill = $('progress-fill');
  if (p.stage === 'copy') {
    const pct = p.total ? Math.floor((p.done / p.total) * 100) : 0;
    fill.classList.remove('indeterminate');
    fill.style.width = pct + '%';
    $('progress-pct').textContent = `${pct}%`;
    $('progress-stage').textContent = p.total ? `Копирование файлов · ${formatSize(p.done)} из ${formatSize(p.total)}` : 'Копирование файлов';
    $('progress-file').textContent = p.file || '';
  } else {
    fill.classList.add('indeterminate');
    $('progress-pct').textContent = '';
    $('progress-file').textContent = '';
    $('progress-stage').textContent = {
      prepare: 'Подготовка',
      shortcuts: 'Ярлыки и регистрация в Windows',
      remove: 'Удаление ярлыков и файлов'
    }[p.stage] || '';
  }
});

// ---------- running launcher ----------

async function checkRunning(dir, notice) {
  const count = await window.setup.running(dir);
  $(notice).classList.toggle('hidden', !count);
  return count > 0;
}

// ---------- install ----------

async function startInstall() {
  const dir = $('dir').value.trim();
  if (!dir) { $('dir').focus(); return; }
  $('primary').disabled = true;
  if (await checkRunning(dir, 'running-notice')) { $('primary').disabled = false; return; }

  busy = true;
  $('btn-close').disabled = true;
  $('progress-title').textContent = info.installed ? 'Обновление…' : 'Установка…';
  $('progress-fill').style.width = '0';
  show('progress');
  try {
    const result = await window.setup.install({
      dir,
      desktop: $('opt-desktop').checked,
      startMenu: $('opt-start').checked
    });
    installedExe = result.exe;
    $('done-title').textContent = info.installed ? 'AeterMC обновлён' : 'AeterMC установлен';
    $('done-text').textContent = info.simulated
      ? 'Это предпросмотр: файлы не копировались.'
      : 'Запускайте лаунчер ярлыком или из меню «Пуск». Удалить его можно в «Параметры → Приложения».';
    show('done', {
      primary: ['<svg class="ic ic-sm"><use href="#i-play"/></svg>Запустить', () => window.setup.launch(installedExe)],
      secondary: ['Закрыть', () => window.setup.close()]
    });
  } catch (e) {
    $('error-title').textContent = 'Не получилось установить';
    $('error-text').textContent = cleanError(e);
    show('error', {
      primary: ['Назад', () => showOptions()],
      secondary: ['Закрыть', () => window.setup.close()]
    });
  } finally {
    busy = false;
    $('btn-close').disabled = false;
  }
}

function showOptions() {
  show('options', {
    primary: [info.installed ? '<svg class="ic ic-sm"><use href="#i-download"/></svg>Обновить' : '<svg class="ic ic-sm"><use href="#i-download"/></svg>Установить', startInstall],
    secondary: ['Отмена', () => window.setup.close()],
    note: info.simulated ? 'Предпросмотр — ничего не устанавливается' : ''
  });
}

// ---------- uninstall ----------

async function startUninstall() {
  $('primary').disabled = true;
  if (await checkRunning(info.installDir, 'running-notice-u')) { $('primary').disabled = false; return; }

  busy = true;
  $('btn-close').disabled = true;
  $('progress-title').textContent = 'Удаление…';
  show('progress');
  try {
    await window.setup.uninstall({ removeData: $('opt-data').checked });
    $('done-title').textContent = 'AeterMC удалён';
    $('done-text').textContent = $('opt-data').checked
      ? 'Лаунчер и его данные будут стёрты, как только закроется это окно.'
      : 'Сборки, аккаунты и настройки остались — при повторной установке всё вернётся.';
    show('done', { primary: ['Закрыть', () => window.setup.close()] });
  } catch (e) {
    $('error-title').textContent = 'Не получилось удалить';
    $('error-text').textContent = cleanError(e);
    show('error', { primary: ['Закрыть', () => window.setup.close()] });
  } finally {
    busy = false;
    $('btn-close').disabled = false;
  }
}

function cleanError(e) {
  return String(e && e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

// ---------- start ----------

async function init() {
  info = await window.setup.info();
  document.title = info.mode === 'uninstall' ? 'Удаление AeterMC' : 'Установка AeterMC';
  $('version').textContent = `Версия ${info.version}`;

  $('btn-minimize').onclick = () => window.setup.minimize();
  $('btn-close').onclick = () => { if (!busy) window.setup.close(); };

  if (info.mode === 'uninstall') {
    $('uninstall-dir').textContent = info.installDir;
    $('side-foot').textContent = 'Лаунчер Minecraft';
    if (!info.canUninstall) {
      $('error-title').textContent = 'Удалять нечего';
      $('error-text').textContent = 'Этот AeterMC не установлен через установщик. Переносную версию достаточно просто удалить.';
      show('error', { primary: ['Закрыть', () => window.setup.close()] });
      return;
    }
    $('kill-u').onclick = async () => {
      await window.setup.killRunning(info.installDir);
      checkRunning(info.installDir, 'running-notice-u');
    };
    show('confirm', {
      primary: ['<svg class="ic ic-sm"><use href="#i-trash"/></svg>Удалить', startUninstall, 'btn-danger'],
      secondary: ['Отмена', () => window.setup.close()]
    });
    checkRunning(info.installDir, 'running-notice-u');
    return;
  }

  $('dir').value = info.defaultDir;
  if (info.installed) {
    $('options-title').textContent = 'Обновление AeterMC';
    $('options-lead').textContent = info.installed.version
      ? `Установлена версия ${info.installed.version}, будет ${info.version}. Сборки, аккаунты и настройки сохранятся.`
      : `AeterMC уже установлен — он будет обновлён до версии ${info.version}. Сборки, аккаунты и настройки сохранятся.`;
  }
  $('side-foot').textContent = 'Лаунчер Minecraft';
  $('browse').onclick = async () => {
    const picked = await window.setup.browse($('dir').value);
    if (picked) {
      $('dir').value = picked;
      checkRunning(picked, 'running-notice');
    }
  };
  $('kill').onclick = async () => {
    await window.setup.killRunning($('dir').value);
    checkRunning($('dir').value, 'running-notice');
  };
  showOptions();
  checkRunning(info.defaultDir, 'running-notice');
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.tagName !== 'BUTTON' && !$('primary').disabled && !$('primary').classList.contains('hidden')) $('primary').click();
});

init();
