/**
 * app.js
 * Frontend controller for AeterMC.
 */

// `api` is the global bridge exposed by preload.js (window.api)

const state = {
  settings: {},
  accounts: [],
  activeAccountId: null,
  versions: [],
  latestRelease: '',
  instances: [],
  javaList: [],
  selected: '',          // instance id or version id
  modsTarget: null,      // id of the build whose mods are open
  mods: [],
  versionFilter: 'all',
  versionQuery: '',
  isLaunching: false,
  isGameRunning: false,
  runningInstanceId: null, // build the running game was started from
  syncCategories: [],
  newInstanceLoader: 'vanilla',
  screenshots: null,     // loaded when the page is opened
  shotsFilter: 'all',
  viewerIndex: -1
};

// ================= HELPERS =================
const $ = (id) => document.getElementById(id);
// i18n.js is loaded before this file; the page's language comes in the URL like the theme
const { t } = i18n;
i18n.translateDom(document.documentElement);

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function icon(name, cls = '') {
  return `<svg class="ic ${cls}"><use href="#i-${name}"/></svg>`;
}

function toast(message, type = 'info', duration = 3200) {
  const el = document.createElement('div');
  el.className = `toast ${type === 'error' ? 'error' : ''}`;
  el.textContent = message;
  $('toasts').appendChild(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 200);
  }, duration);
}

function errText(err) {
  // ipcRenderer.invoke wraps errors: "Error invoking remote method 'x': Error: message"
  return String(err && err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

function formatPlaytime(seconds) {
  if (!seconds) return t('0 ч');
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? t('{h} ч {m} мин', { h, m }) : t('{m} мин', { m });
}

function formatAgo(ts) {
  if (!ts) return t('не запускалась');
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60) return t('только что');
  if (diff < 3600) return t('{time} назад', { time: pluralize(Math.floor(diff / 60), ['минуту', 'минуты', 'минут']) });
  const date = new Date(ts);
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (date >= startOfToday) return t('{time} назад', { time: pluralize(Math.floor(diff / 3600), ['час', 'часа', 'часов']) });
  if (date >= yesterday) return t('вчера');
  const opts = date.getFullYear() === today.getFullYear() ? { day: 'numeric', month: 'long' } : { day: 'numeric', month: 'long', year: 'numeric' };
  // "2 сентября 2025 г." -> "2 сентября 2025 года"
  return date.toLocaleDateString(i18n.locale(), opts).replace(/\s?г\.$/, ' года'); // i18n-ignore: only in Russian dates
}

function isRunning(inst) {
  return state.isGameRunning && !!inst && inst.id === state.runningInstanceId;
}

function lastPlayedText(inst) {
  if (isRunning(inst)) return t('Сейчас в игре');
  return inst.lastPlayed ? t('Последний запуск {ago}', { ago: agoSpan(inst.lastPlayed) }) : t('Ещё не запускалась');
}

// short form for cards and rows: "в игре" while this build is running
function lastPlayedShort(inst) {
  return isRunning(inst) ? t('в игре') : agoSpan(inst.lastPlayed);
}

// relative time that keeps itself current: "только что" -> "1 минуту назад" -> ...
function agoSpan(ts) {
  return ts ? `<span data-ago="${ts}">${formatAgo(ts)}</span>` : formatAgo(ts);
}

setInterval(() => {
  document.querySelectorAll('[data-ago]').forEach(el => {
    const text = formatAgo(Number(el.dataset.ago));
    if (el.textContent !== text) el.textContent = text;
  });
}, 30 * 1000);

function formatCount(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(n);
}

function hueFor(text) {
  let h = 0;
  for (const ch of String(text)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

// Default build icons: isometric blocks in the style of the app icon.
// Colors live in design tokens (--color-block-<name>-top/left/right/band-*/ore/tile); the order
// here decides which block a build gets, so append new blocks at the end.
const BLOCKS = [
  { name: 'grass', band: true },
  { name: 'stone' },
  { name: 'sand' },
  { name: 'planks' },
  { name: 'snow', band: true },
  { name: 'diamond', ore: true },
  { name: 'netherrack' },
  { name: 'end-stone' },
  { name: 'obsidian', ore: true },
  { name: 'copper' },
  { name: 'ice' },
  { name: 'moss' }
];

function blockSvg(b) {
  const c = (part) => `style="fill:var(--color-block-${b.name}-${part})"`;
  const band = b.band ? `
    <path d="M6 15 24 24v4L6 19z" ${c('band-left')}/>
    <path d="M24 24 42 15v4l-18 9z" ${c('band-right')}/>` : '';
  const ore = b.ore ? `
    <path d="M11 22l3 1.5v3L11 25z M17 30l3 1.5v3L17 33z M30 27l3-1.5v3L30 30z M35 33l3-1.5v3L35 36z M21 13l3 1.5-3 1.5-3-1.5z M29 15l3 1.5-3 1.5-3-1.5z" ${c('ore')}/>` : '';
  return `<svg viewBox="0 0 48 48" class="block-svg">
    <path d="M24 6 42 15 24 24 6 15z" ${c('top')}/>
    <path d="M6 15 24 24v20L6 35z" ${c('left')}/>
    <path d="M24 24 42 15v20L24 44z" ${c('right')}/>${band}${ore}
    <path d="M24 6 42 15v20L24 44 6 35V15zM6 15l18 9 18-9M24 24v20" style="fill:none;stroke:var(--color-block-outline)" stroke-width="1" stroke-linejoin="round"/>
  </svg>`;
}

function autoBlock(inst) {
  return BLOCKS[hueFor(inst.id || inst.name) % BLOCKS.length];
}

function blockIconHtml(block) {
  return `<div class="inst-icon" style="background:var(--color-block-${block.name}-tile)">${blockSvg(block)}</div>`;
}

/** Custom image, then the block picked by the user, then the automatic block. */
function instanceIconHtml(inst) {
  if (inst.iconImage) return `<div class="inst-icon inst-icon-img"><img src="${esc(inst.iconImage)}" alt=""></div>`;
  return blockIconHtml(BLOCKS.find(b => b.name === inst.iconBlock) || autoBlock(inst));
}

// Small (pixel-art) pictures stay crisp instead of being smeared when scaled up
document.addEventListener('load', (e) => {
  const img = e.target;
  if (img.tagName === 'IMG' && img.parentElement && img.parentElement.classList.contains('inst-icon-img')) {
    img.classList.toggle('pixelated', img.naturalWidth < 64);
  }
}, true);

const LOADER_LABELS = { vanilla: 'Vanilla', fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge', quilt: 'Quilt' };

function avatarUrl(acc) {
  if (!acc) return 'https://mc-heads.net/avatar/MHF_Steve/64';
  if (acc.type === 'elyby') {
    return `https://ely.by/services/skins-renderer?url=http://skinsystem.ely.by/skins/${encodeURIComponent(acc.username)}.png&scale=8&renderFace=1`;
  }
  if (acc.type === 'microsoft' && acc.uuid) return `https://mc-heads.net/avatar/${acc.uuid}/64`;
  return `https://mc-heads.net/avatar/${encodeURIComponent(acc.username)}/64`;
}

function setAvatar(img, acc) {
  img.onerror = () => {
    img.onerror = null;
    img.src = 'https://mc-heads.net/avatar/MHF_Steve/64';
  };
  img.src = avatarUrl(acc);
}

function accountTypeLabel(type) {
  return type === 'microsoft' ? 'Microsoft' : type === 'elyby' ? 'Ely.by' : t('Оффлайн');
}

function findInstance(id) {
  return state.instances.find(i => i.id === id) || null;
}

function findVersion(id) {
  return state.versions.find(v => v.id === id) || null;
}

/** The build whose mods page is open. */
function modsInstance() {
  return state.modsTarget ? findInstance(state.modsTarget) : null;
}

function hasMods(inst) {
  return inst && inst.loader !== 'vanilla';
}

// ================= DIALOG =================
function dialog({ title, text = '', input = null, okText = 'OK', cancelText = t('Отмена'), extraText = null, danger = false }) {
  return new Promise(resolve => {
    const modal = $('modal-dialog');
    const inputEl = $('dialog-input');
    const ok = $('dialog-ok');
    $('dialog-title').textContent = title;
    $('dialog-text').textContent = text;
    ok.textContent = okText;
    $('dialog-cancel').textContent = cancelText;
    $('dialog-extra').textContent = extraText || '';
    $('dialog-extra').classList.toggle('hidden', !extraText);
    ok.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
    inputEl.classList.toggle('hidden', input === null);
    inputEl.value = input || '';
    modal.classList.remove('hidden');
    (input !== null ? inputEl : ok).focus();
    if (input !== null) inputEl.select();

    const finish = (result) => {
      modal.classList.add('hidden');
      ok.onclick = null;
      $('dialog-cancel').onclick = null;
      $('dialog-extra').onclick = null;
      inputEl.onkeydown = null;
      resolve(result);
    };
    ok.onclick = () => finish(input !== null ? inputEl.value.trim() : true);
    $('dialog-cancel').onclick = () => finish(input !== null ? null : false);
    $('dialog-extra').onclick = () => finish('extra');
    inputEl.onkeydown = (e) => { if (e.key === 'Enter') ok.click(); };
  });
}

function openModal(id) { $(id).classList.remove('hidden'); }
function closeModal(el) { el.closest('.modal').classList.add('hidden'); }

// ================= INIT =================
document.addEventListener('DOMContentLoaded', async () => {
  setupWindowControls();
  setupUpdateButton();
  setupNavigation();
  setupSegmented();
  setupModals();
  setupAccounts();
  setupHome();
  setupInstances();
  setupIconPicker();
  setupMods();
  setupPrismImport();
  setupSettings();
  setupLogs();
  setupScreenshots();
  setupSubscriptions();
  setupSetup();
  restoreGameState();

  await loadSettings();
  // after a language change the window reopens on the settings
  if (new URLSearchParams(location.search).get('page') === 'settings') showPage('settings');
  renderGreeting();
  renderTip();
  loadWeekStats();
  // Builds and versions first; accounts, Java and the rest fill in around them
  loadAccounts();
  loadSyncCategories();
  loadJavaList();
  await loadVersionsAndInstances();
  await maybeRunSetup();
  startBackgroundUpdateChecks();

  appendLog('info', t('[LAUNCHER]: AeterMC готов к работе'));
});

// ================= WINDOW =================
function setupWindowControls() {
  $('btn-minimize').addEventListener('click', () => api.minimizeWindow());
  $('btn-maximize').addEventListener('click', () => api.maximizeWindow());
  $('btn-close').addEventListener('click', () => api.closeWindow());
  api.onWindowMaximized((isMax) => {
    $('icon-maximize').innerHTML = isMax
      ? '<rect x="2" y="4" width="6" height="6" rx="1"/><path d="M4 4V2.5A.5.5 0 0 1 4.5 2H9.5a.5.5 0 0 1 .5.5v5a.5.5 0 0 1-.5.5H8"/>'
      : '<rect x="2" y="2" width="8" height="8" rx="1"/>';
  });
}

// ================= LAUNCHER UPDATE =================
// The button left of the window controls, the update menu and its row in the settings;
// checking, downloading and swapping happen in updater.js
const UPDATE_MANUAL_HINTS = {
  portable: t('Портативная версия обновляется новым файлом: скачайте его со страницы релиза'),
  electron: t('Эту версию нужно поставить установщиком со страницы релиза'),
  readonly: t('Нет доступа к папке лаунчера: скачайте установщик со страницы релиза')
};

let updateState = {};
let updateAction = null;            // what the menu's main button does now
let updateNotesVersion;             // the found version the release notes were loaded for

function updatePercent(u) {
  return `${Math.round((u.progress || 0) * 100)}%`;
}

function renderUpdate() {
  renderUpdateButton();
  renderUpdateSettings();
  if (!$('modal-update').classList.contains('hidden')) renderUpdateMenu();
}

function renderUpdateButton() {
  const u = updateState;
  const btn = $('btn-update');
  const views = {
    available: ['download', u.version, t('Доступна версия {version}', { version: u.version })],
    downloading: ['download', updatePercent(u), t('Скачивается версия {version}', { version: u.version })],
    ready: ['refresh', t('Обновить'), t('Версия {version} скачана: перезапустите лаунчер, чтобы обновить', { version: u.version })],
    manual: ['external', u.version, t('Доступна версия {version}', { version: u.version })]
  };
  const view = views[u.status];
  btn.classList.toggle('hidden', !view);
  if (!view) return;
  btn.innerHTML = `${icon(view[0])}<span>${esc(view[1])}</span>`;
  btn.title = view[2];
}

/** One line about the update for the settings page. */
function updateStatusText(u) {
  if (u.status === 'available' || u.status === 'manual') return t('Доступна версия {version}', { version: u.version });
  if (u.status === 'downloading') return t('Скачивается версия {version}: {percent}', { version: u.version, percent: updatePercent(u) });
  if (u.status === 'ready') return t('Версия {version} установится при перезапуске', { version: u.version });
  if (u.enabled === false) return t('Запущено из исходников: обновления работают только в собранном лаунчере');
  if (u.checking) return t('Проверяем обновления…');
  if (u.error) return t('Не удалось проверить обновления');
  return u.checkedAt ? t('Установлена последняя версия') : '';
}

function renderUpdateSettings() {
  const u = updateState;
  $('settings-update-label').textContent = `AeterMC ${u.current || ''}`;
  $('settings-update-hint').textContent = updateStatusText(u);
  $('btn-open-update').textContent = u.status === 'idle' ? t('Проверить обновления') : t('Подробнее');
}

function renderUpdateMenu() {
  const u = updateState;
  const version = esc(u.version);
  const current = esc(u.current);
  let title, sub, action;
  if (u.status === 'available') {
    title = t('Доступна версия {version}', { version });
    sub = t('Сейчас установлена {version}', { version: current }) + (u.size ? ` · ${t('скачать {size}', { size: formatSize(u.size) })}` : '');
    action = { text: t('Скачать'), run: () => api.downloadUpdate() };
  } else if (u.status === 'downloading') {
    title = t('Скачивается версия {version}', { version });
    sub = u.size ? t('{n} из {total}', { n: updatePercent(u), total: formatSize(u.size) }) : updatePercent(u);
    action = { text: t('Скачивается…'), disabled: true };
  } else if (u.status === 'ready') {
    title = t('Версия {version} готова к установке', { version });
    sub = t('Перезапустите лаунчер, иначе она установится, когда вы его закроете');
    action = { text: t('Перезапустить'), run: () => api.restartToUpdate() };
  } else if (u.status === 'manual') {
    title = t('Доступна версия {version}', { version });
    sub = esc(UPDATE_MANUAL_HINTS[u.reason] || '');
    action = { text: t('Открыть страницу релиза'), run: () => api.openUpdatePage() };
  } else {
    title = u.checking ? t('Проверяем обновления…') : u.checkedAt && !u.error ? t('Установлена последняя версия') : `AeterMC ${current}`;
    // with a failed check the error line below says what happened
    sub = u.enabled === false ? esc(updateStatusText(u))
      : u.checking ? t('Установлена версия {version}', { version: current })
      : u.error ? (u.checkedAt ? t('Последняя удачная проверка {ago}', { ago: agoSpan(u.checkedAt) }) : '')
      : u.checkedAt ? `AeterMC ${current} · ${t('проверено {ago}', { ago: agoSpan(u.checkedAt) })}`
      : t('Обновления ещё не проверялись');
    action = { text: u.checking ? t('Проверяем…') : t('Проверить снова'), disabled: u.enabled === false || u.checking, run: () => api.checkUpdate() };
  }
  $('update-title').innerHTML = title;
  $('update-sub').innerHTML = sub;
  $('update-progress').classList.toggle('active', u.status === 'downloading');
  $('update-progress-fill').style.width = updatePercent(u);
  $('update-error').textContent = u.error || '';
  $('update-auto').checked = state.settings.autoUpdate !== false;
  const btn = $('update-action');
  btn.textContent = action.text;
  btn.disabled = !!action.disabled;
  updateAction = action.run || null;
  // a release found while the menu is open isn't in the notes loaded before it
  if ((u.version || null) !== updateNotesVersion) loadReleaseNotes();
}

function openUpdateMenu() {
  openModal('modal-update');
  updateNotesVersion = undefined;
  renderUpdateMenu();
  // opening the menu checks again, unless the last check was a moment ago
  const u = updateState;
  if (u.enabled && !u.checking && u.status === 'idle' && !(u.checkedAt > Date.now() - 5 * 60 * 1000)) api.checkUpdate();
}

async function loadReleaseNotes() {
  const version = updateNotesVersion = updateState.version || null;
  const box = $('update-notes');
  box.innerHTML = `<div class="release-empty">${t('Загружаем список изменений…')}</div>`;
  let html;
  try {
    const releases = await api.getUpdateReleases();
    html = releases.length ? releases.map(renderRelease).join('') : `<div class="release-empty">${t('Список изменений появится с выходом новой версии')}</div>`;
  } catch (e) {
    html = `<div class="release-empty">${t('Не удалось загрузить список изменений: {error}', { error: esc(errText(e)) })}</div>`;
  }
  // a newer load has started meanwhile
  if (version === updateNotesVersion) box.innerHTML = html;
}

function renderRelease(r) {
  const tag = r.version === updateState.current ? `<span class="tag">${t('Установлена')}</span>` : `<span class="tag tag-new">${t('Новая')}</span>`;
  const date = r.date ? new Date(r.date).toLocaleDateString(i18n.locale(), { day: 'numeric', month: 'long', year: 'numeric' }).replace(/\s?г\.$/, '') : '';
  return `<div class="release">
    <div class="release-head"><span class="release-version">${esc(r.version)}</span>${tag}<span class="release-date">${esc(date)}</span></div>
    <div class="release-notes">${releaseNotesHtml(r.notes) || `<p>${t('Без описания')}</p>`}</div>
  </div>`;
}

/** Release notes are Markdown (the Build workflow writes "- " lists): lists, headings, **bold**, `code`, links as text. */
function releaseNotesHtml(text) {
  const inline = (s) => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  let html = '';
  let list = false;
  for (const line of String(text || '').split(/\r?\n/).map(l => l.trim())) {
    const item = /^[-*] +(.*)/.exec(line);
    if (item && !list) html += '<ul>';
    if (!item && list) html += '</ul>';
    list = !!item;
    if (item) html += `<li>${inline(item[1])}</li>`;
    else if (/^#+ /.test(line)) html += `<div class="release-heading">${inline(line.replace(/^#+ /, ''))}</div>`;
    else if (line) html += `<p>${inline(line)}</p>`;
  }
  return list ? html + '</ul>' : html;
}

function setupUpdateButton() {
  $('btn-update').addEventListener('click', openUpdateMenu);
  $('btn-open-update').addEventListener('click', openUpdateMenu);
  $('update-all').addEventListener('click', () => api.openUpdatePage(true));
  $('update-action').addEventListener('click', async () => {
    if (!updateAction) return;
    try {
      await updateAction();
    } catch (e) {
      toast(errText(e), 'error', 6000);
    }
  });
  ['check-auto-update', 'update-auto'].forEach(id => $(id).addEventListener('change', () => {
    const on = $(id).checked;
    $('check-auto-update').checked = on;
    $('update-auto').checked = on;
    saveSettings({ autoUpdate: on });
  }));
  api.onUpdateState((update) => {
    updateState = update;
    renderUpdate();
  });
  api.getUpdateState().then((update) => {
    updateState = update;
    renderUpdate();
  });
}

// ================= NAVIGATION =================
function showPage(name) {
  // A build's mods page lives under "Сборки"
  const navTab = name === 'mods' ? 'instances' : name;
  document.querySelectorAll('.nav-item').forEach(i => i.classList.toggle('active', i.dataset.tab === navTab));
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === `page-${name}`));
  if (name === 'logs') {
    $('log-indicator').classList.remove('active', 'error');
    scrollLogsToBottom();
  }
  if (name === 'mods') loadMods();
  if (name === 'screenshots') loadScreenshots(true);
}

function applySidebarCollapsed(collapsed) {
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  $('btn-sidebar-toggle').title = collapsed ? t('Развернуть меню') : t('Свернуть меню');
}

function setupNavigation() {
  $('btn-sidebar-toggle').addEventListener('click', () => {
    const collapsed = !document.body.classList.contains('sidebar-collapsed');
    applySidebarCollapsed(collapsed);
    saveSettings({ sidebarCollapsed: collapsed });
  });
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => showPage(item.dataset.tab));
  });
  document.querySelectorAll('[data-goto]').forEach(btn => {
    btn.addEventListener('click', () => showPage(btn.dataset.goto));
  });
  document.querySelectorAll('[data-folder]').forEach(btn => {
    btn.addEventListener('click', () => api.openFolder(btn.dataset.folder));
  });
}

function setupSegmented() {
  document.querySelectorAll('.segmented, .tabs').forEach(seg => {
    seg.querySelectorAll('button[data-view]').forEach(btn => {
      btn.addEventListener('click', () => {
        seg.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
        seg.querySelectorAll('button[data-view]').forEach(b => {
          $(b.dataset.view).classList.toggle('active', b === btn);
        });
        if (btn.dataset.view === 'view-mods-modrinth' && !$('modrinth-results').children.length) {
          searchModrinth();
        }
      });
    });
  });
}

function setupModals() {
  document.querySelectorAll('[data-close-modal]').forEach(btn => {
    btn.addEventListener('click', () => closeModal(btn));
  });
  document.querySelectorAll('.modal').forEach(m => {
    m.addEventListener('mousedown', (e) => {
      if (e.target === m && !['modal-dialog', 'modal-sync', 'modal-ms', 'modal-prism'].includes(m.id)) m.classList.add('hidden');
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (openMenuEl) {
      openMenuEl.close();
      return;
    }
    const open = [...document.querySelectorAll('.modal:not(.hidden)')].pop();
    if (!open) return;
    if (open.id === 'modal-dialog') $('dialog-cancel').click();
    else if (open.id === 'modal-sync') $('sync-close').click();
    else if (open.id === 'modal-ms') closeMicrosoftLogin();
    else if (open.id === 'modal-prism') $('prism-cancel').click();
    else open.classList.add('hidden');
  });
}

// ================= ACCOUNTS =================
async function loadAccounts() {
  try {
    const data = await api.getAccounts();
    state.accounts = data.accounts || [];
    state.activeAccountId = data.activeAccountId;
    renderAccountChip();
    renderAccountList();
    if (!$('setup').classList.contains('hidden')) renderSetupAccount();
  } catch (e) {
    console.error('Error loading accounts:', e);
  }
}

function activeAccount() {
  return state.accounts.find(a => a.id === state.activeAccountId) || state.accounts[0] || null;
}

function renderAccountChip() {
  const acc = activeAccount();
  $('account-name').textContent = acc ? acc.username : t('Нет аккаунта');
  $('account-type').textContent = acc ? accountTypeLabel(acc.type) : '';
  setAvatar($('account-avatar'), acc);
  renderGreeting();
}

function renderAccountList() {
  const list = $('account-list');
  list.innerHTML = '';
  state.accounts.forEach(acc => {
    const isActive = acc.id === state.activeAccountId;
    const badge = acc.type === 'microsoft' ? 'badge-ms' : acc.type === 'elyby' ? 'badge-ely' : '';
    const row = document.createElement('div');
    row.className = `account-row ${isActive ? 'active' : ''}`;
    row.innerHTML = `
      <img alt="">
      <div class="row-main">
        <span class="row-title">${esc(acc.username)}</span>
        <span class="badge ${badge}">${accountTypeLabel(acc.type)}</span>
      </div>
      ${isActive ? icon('check', 'account-check') : ''}
      ${state.accounts.length > 1 ? `<button class="icon-btn icon-btn-sm danger" title="${t('Удалить')}">${icon('trash', 'ic-sm')}</button>` : ''}
    `;
    setAvatar(row.querySelector('img'), acc);

    row.addEventListener('click', async () => {
      if (isActive) return;
      await api.setActiveAccount(acc.id);
      await loadAccounts();
      toast(t('Аккаунт: {name}', { name: acc.username }));
    });

    const del = row.querySelector('.danger');
    if (del) {
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await dialog({ title: t('Удалить аккаунт?'), text: t('Аккаунт «{name}» будет удалён из лаунчера.', { name: acc.username }), okText: t('Удалить'), danger: true });
        if (!ok) return;
        await api.removeAccount(acc.id);
        await loadAccounts();
      });
    }
    list.appendChild(row);
  });
}

function setupAccounts() {
  $('btn-open-accounts').addEventListener('click', () => {
    renderAccountList();
    openModal('modal-accounts');
  });

  const addOffline = async () => {
    const name = $('input-acc-offline-name').value.trim();
    if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) {
      toast(t('Ник: 3–16 символов, латиница, цифры и «_»'), 'error');
      return;
    }
    await api.addOfflineAccount(name);
    $('input-acc-offline-name').value = '';
    await loadAccounts();
    toast(t('Аккаунт {name} добавлен', { name }));
  };
  $('btn-add-offline-acc').addEventListener('click', addOffline);
  $('input-acc-offline-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') addOffline(); });

  $('btn-login-ms').addEventListener('click', openMicrosoftLogin);
  $('ms-cancel').addEventListener('click', closeMicrosoftLogin);
  $('ms-close').addEventListener('click', closeMicrosoftLogin);
  $('ms-retry').addEventListener('click', startMicrosoftLogin);
  $('ms-browser').addEventListener('click', () => msLogin.code && api.msLoginOpenBrowser(msLogin.code.linkUrl));
  $('ms-link').addEventListener('click', (e) => {
    e.preventDefault();
    if (msLogin.code) api.msLoginOpenBrowser(msLogin.code.linkUrl);
  });
  $('ms-copy').addEventListener('click', () => {
    if (!msLogin.code) return;
    navigator.clipboard.writeText(msLogin.code.userCode);
    toast(t('Код скопирован'));
  });

  const loginEly = async () => {
    const login = $('input-acc-ely-login').value.trim();
    const pass = $('input-acc-ely-pass').value;
    const status = $('ely-status');
    if (!login || !pass) {
      status.className = 'form-status error';
      status.textContent = t('Введите логин и пароль');
      return;
    }
    $('btn-login-ely').disabled = true;
    status.className = 'form-status';
    status.textContent = t('Проверка…');
    try {
      const acc = await api.loginElyBy(login, pass);
      await loadAccounts();
      $('input-acc-ely-pass').value = '';
      status.textContent = '';
      toast(t('Вход выполнен: {name}', { name: acc.username }));
      $('modal-accounts').classList.add('hidden');
    } catch (e) {
      status.className = 'form-status error';
      status.textContent = errText(e);
    } finally {
      $('btn-login-ely').disabled = false;
    }
  };
  $('btn-login-ely').addEventListener('click', loginEly);
  $('input-acc-ely-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') loginEly(); });
}

// ================= MICROSOFT LOGIN =================
const msLogin = { code: null, attempt: 0, timer: null };

function setMsStatus(text, type = 'wait') {
  const el = $('ms-status');
  el.className = `ms-status ${type === 'error' ? 'error' : ''}`;
  el.innerHTML = type === 'wait' ? `<span class="dot"></span><span>${esc(text)}</span>` : esc(text);
}

function openMicrosoftLogin() {
  openModal('modal-ms');
  startMicrosoftLogin();
}

async function startMicrosoftLogin() {
  const attempt = ++msLogin.attempt;
  clearInterval(msLogin.timer);
  msLogin.code = null;
  $('ms-retry').classList.add('hidden');
  $('ms-browser').disabled = true;
  $('ms-code').textContent = '········';
  $('ms-qr').innerHTML = '<div class="ms-qr-loading"></div>';
  setMsStatus(t('Получение кода…'));

  let code;
  try {
    code = await api.msLoginStart();
  } catch (e) {
    if (attempt !== msLogin.attempt) return;
    setMsStatus(errText(e), 'error');
    $('ms-retry').classList.remove('hidden');
    return;
  }
  if (attempt !== msLogin.attempt) return;

  msLogin.code = code;
  $('ms-code').textContent = code.userCode;
  $('ms-qr').innerHTML = `<img src="${code.qr}" alt="${t('QR-код для входа')}">`;
  $('ms-browser').disabled = false;

  const deadline = Date.now() + code.expiresIn * 1000;
  const tick = () => {
    const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    setMsStatus(t('Ожидание входа… код действует {time}', { time: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` }));
  };
  tick();
  msLogin.timer = setInterval(tick, 1000);

  try {
    const res = await api.msLoginWait();
    if (attempt !== msLogin.attempt || res.cancelled) return;
    clearInterval(msLogin.timer);
    await loadAccounts();
    $('modal-ms').classList.add('hidden');
    $('modal-accounts').classList.add('hidden');
    toast(t('Вход выполнен: {name}', { name: res.account.username }));
  } catch (e) {
    if (attempt !== msLogin.attempt) return;
    clearInterval(msLogin.timer);
    msLogin.code = null;
    $('ms-browser').disabled = true;
    setMsStatus(errText(e), 'error');
    $('ms-retry').classList.remove('hidden');
  }
}

function closeMicrosoftLogin() {
  msLogin.attempt++;
  msLogin.code = null;
  clearInterval(msLogin.timer);
  api.msLoginCancel();
  $('modal-ms').classList.add('hidden');
}

// ================= SETTINGS =================
async function loadSettings() {
  try {
    state.settings = await api.getSettings();
  } catch (e) {
    state.settings = {};
  }
  const s = state.settings;
  state.selected = s.selectedVersion || '';

  const total = s.totalSystemRam || 8;
  $('system-ram-total').textContent = t('В системе {n} ГБ', { n: total });
  $('slider-max-ram').max = Math.max(2, Math.min(total, 32));
  $('slider-min-ram').max = Math.max(1, Math.min(total, 16));
  $('slider-max-ram').value = s.maxRam || 4;
  $('slider-min-ram').value = s.minRam || 2;
  updateRamLabels();

  $('input-game-dir').value = s.gameDir || '';
  $('game-dir-hint').textContent = s.gameDir || '';
  $('input-res-w').value = s.resolutionWidth || 1280;
  $('input-res-h').value = s.resolutionHeight || 720;
  $('check-fullscreen').checked = !!s.fullscreen;
  $('check-snapshots').checked = !!s.showSnapshots;
  $('check-prism').checked = s.prismImport === true;
  $('check-show-console').checked = s.showConsole !== false;
  $('check-auto-updates').checked = s.autoCheckModUpdates !== false;
  $('check-auto-update').checked = s.autoUpdate !== false;
  $('select-language').value = i18n.language();
  applySidebarCollapsed(!!s.sidebarCollapsed);
  $('check-animations').checked = s.animations !== false;
  document.documentElement.classList.toggle('no-motion', s.animations === false);
  // The URL theme is the one from window creation; after Ctrl+R the saved setting is newer
  document.documentElement.dataset.theme = currentThemeId();
  renderThemePicker();
  updateWindowIcon();
  applyConsoleVisibility();
  $('select-launch-action').value = s.actionAfterLaunch || 'minimize';
  $('input-jvm-args').value = s.customJvmArgs || '';
}

function updateRamLabels() {
  $('val-max-ram').textContent = t('{n} ГБ', { n: $('slider-max-ram').value });
  $('val-min-ram').textContent = t('{n} ГБ', { n: $('slider-min-ram').value });
}

async function saveSettings(partial) {
  try {
    await api.saveSettings(partial);
    Object.assign(state.settings, partial);
  } catch (e) {
    toast(t('Не удалось сохранить настройки: {error}', { error: errText(e) }), 'error');
  }
}

let settingsTimer;
function saveSettingsFromForm() {
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => {
    let maxRam = parseInt($('slider-max-ram').value, 10);
    let minRam = parseInt($('slider-min-ram').value, 10);
    if (minRam > maxRam) {
      minRam = maxRam;
      $('slider-min-ram').value = minRam;
      updateRamLabels();
    }
    saveSettings({
      maxRam,
      minRam,
      javaPath: $('select-java').value,
      resolutionWidth: parseInt($('input-res-w').value, 10) || 1280,
      resolutionHeight: parseInt($('input-res-h').value, 10) || 720,
      fullscreen: $('check-fullscreen').checked,
      actionAfterLaunch: $('select-launch-action').value,
      customJvmArgs: $('input-jvm-args').value.trim()
    });
    renderHero();
  }, 350);
}

function setupSettings() {
  ['slider-max-ram', 'slider-min-ram'].forEach(id => {
    $(id).addEventListener('input', () => { updateRamLabels(); saveSettingsFromForm(); });
  });
  ['input-res-w', 'input-res-h', 'input-jvm-args'].forEach(id => $(id).addEventListener('input', saveSettingsFromForm));
  ['check-fullscreen', 'select-launch-action', 'select-java'].forEach(id => $(id).addEventListener('change', saveSettingsFromForm));

  $('check-animations').addEventListener('change', () => {
    document.documentElement.classList.toggle('no-motion', !$('check-animations').checked);
    saveSettings({ animations: $('check-animations').checked });
  });

  $('check-auto-updates').addEventListener('change', async () => {
    await saveSettings({ autoCheckModUpdates: $('check-auto-updates').checked });
    if ($('check-auto-updates').checked) backgroundUpdateCheck();
  });

  $('check-show-console').addEventListener('change', async () => {
    await saveSettings({ showConsole: $('check-show-console').checked });
    applyConsoleVisibility();
  });

  $('check-prism').addEventListener('change', async () => {
    await saveSettings({ prismImport: $('check-prism').checked });
    await loadVersionsAndInstances();
  });

  // the main process reloads the windows in the new language
  $('select-language').addEventListener('change', () => saveSettings({ language: $('select-language').value }));
  $('check-snapshots').addEventListener('change', async () => {
    await saveSettings({ showSnapshots: $('check-snapshots').checked });
    loadVersionsAndInstances();
  });

  $('btn-browse-java').addEventListener('click', async () => {
    const filePath = await api.browseFile({ title: t('Выберите java.exe'), filters: [{ name: 'Java', extensions: ['exe'] }] });
    if (!filePath) return;
    ensureJavaOption(filePath);
    $('select-java').value = filePath;
    saveSettingsFromForm();
  });

  $('btn-rescan-java').addEventListener('click', async () => {
    $('btn-rescan-java').classList.add('spinning');
    await loadJavaList(true);
    $('btn-rescan-java').classList.remove('spinning');
    toast(t('Найдено Java: {n}', { n: state.javaList.length }));
  });

  $('btn-browse-gamedir').addEventListener('click', async () => {
    const folder = await api.browseFolder({ title: t('Папка .minecraft') });
    if (!folder) return;
    $('input-game-dir').value = folder;
    $('game-dir-hint').textContent = folder;
    await saveSettings({ gameDir: folder });
    await loadVersionsAndInstances();
    loadMods();
    toast(t('Папка игры изменена'));
  });
}

// ---------- Prism import (copy) ----------
let prismImporting = false;

async function openPrismImport() {
  const list = $('prism-list');
  $('prism-status').textContent = '';
  $('prism-progress').classList.add('hidden');
  list.innerHTML = `<div class="empty empty-sm"><p>${t('Поиск сборок…')}</p></div>`;
  openModal('modal-prism');

  let builds = [];
  try {
    builds = await api.listPrismInstances();
  } catch (e) {}
  list.innerHTML = '';
  if (!builds.length) {
    list.innerHTML = `<div class="empty empty-sm"><p>${t('Сборки Prism Launcher не найдены')}</p></div>`;
    $('prism-start').disabled = true;
    return;
  }

  builds.forEach(b => {
    const row = document.createElement('label');
    row.className = 'sync-check';
    const loader = b.loader === 'vanilla' ? '' : `${LOADER_LABELS[b.loader] || b.loader} · `;
    row.innerHTML = `
      <input type="checkbox" value="${esc(b.key)}" ${b.alreadyImported ? '' : 'checked'}>
      <span class="grow">
        <div>${esc(b.name)}</div>
        <div class="meta">${esc(loader)}Minecraft ${esc(b.version)}${b.modCount ? ` · ${pluralize(b.modCount, ['мод', 'мода', 'модов'])}` : ''}${b.alreadyImported ? ` · ${t('уже импортирована')}` : ''}</div>
      </span>
      <span class="size">${formatSize(b.sizeBytes)}</span>
    `;
    row.querySelector('input').addEventListener('change', updatePrismStartButton);
    list.appendChild(row);
  });
  updatePrismStartButton();
}

function updatePrismStartButton() {
  const n = document.querySelectorAll('#prism-list input:checked').length;
  $('prism-start').disabled = !n || prismImporting;
  $('prism-start').textContent = n ? `${t('Скопировать')} (${n})` : t('Скопировать');
}

function formatSize(bytes) {
  if (bytes >= 1024 ** 3) return t('{n} ГБ', { n: (bytes / 1024 ** 3).toFixed(1) });
  return t('{n} МБ', { n: Math.max(1, Math.round(bytes / 1024 ** 2)) });
}

async function startPrismImport() {
  const inputs = [...document.querySelectorAll('#prism-list input:checked')];
  const keys = inputs.map(i => i.value);
  const names = inputs.map(i => i.closest('.sync-check').querySelector('.grow div').textContent);
  if (!keys.length) return;

  prismImporting = true;
  updatePrismStartButton();
  document.querySelectorAll('#prism-list input').forEach(i => { i.disabled = true; });
  $('prism-progress').classList.remove('hidden');
  $('prism-status').textContent = '';

  const off = api.onPrismImportProgress((p) => {
    const pct = p.totalBytes ? Math.round((p.copiedBytes / p.totalBytes) * 100) : 100;
    $('prism-progress-text').textContent = `${names[p.index]} (${t('{n} из {total}', { n: p.index + 1, total: p.count })}) · ${t('{n} из {total}', { n: formatSize(p.copiedBytes), total: formatSize(p.totalBytes) })}`;
    $('prism-progress-percent').textContent = `${pct}%`;
    $('prism-progress-fill').style.width = `${pct}%`;
  });

  try {
    const imported = await api.importPrismInstances(keys);
    $('modal-prism').classList.add('hidden');
    await loadVersionsAndInstances();
    if (imported[0]) selectProfile(imported[0].id);
    toast(t('Импортировано сборок: {n}', { n: imported.length }));
    showPage('instances');
  } catch (e) {
    $('prism-status').className = 'form-status error';
    $('prism-status').textContent = errText(e);
    await loadVersionsAndInstances();
  } finally {
    off();
    prismImporting = false;
    document.querySelectorAll('#prism-list input').forEach(i => { i.disabled = false; });
    updatePrismStartButton();
  }
}

function setupPrismImport() {
  $('btn-prism-import').addEventListener('click', () => openPrismImport());
  $('prism-start').addEventListener('click', startPrismImport);
  const close = () => {
    if (prismImporting) {
      toast(t('Дождитесь окончания копирования'));
      return;
    }
    $('modal-prism').classList.add('hidden');
  };
  $('prism-cancel').addEventListener('click', close);
  $('prism-close').addEventListener('click', close);
}

// ---------- themes ----------
function currentThemeId() {
  const themes = window.MCL_THEMES || [];
  const id = state.settings.theme;
  return themes.some(t => t.id === id) ? id : 'dark-mono';
}

function renderThemeGrid(grid, mode) {
  const themes = window.MCL_THEMES || [];
  const active = currentThemeId();
  grid.innerHTML = '';
  themes.filter(theme => theme.mode === mode).forEach(theme => {
    const p = theme.preview;
    const btn = document.createElement('button');
    btn.className = `theme-swatch ${theme.id === active ? 'active' : ''}`;
    btn.title = `${mode === 'dark' ? t('Тёмная') : t('Светлая')} ${t(theme.name).toLowerCase()}`;
    btn.innerHTML = `
      <span class="tsw" style="background:${p.bg}">
        <span class="tsw-side" style="background:${p.side}"></span>
        <span class="tsw-body">
          <span class="tsw-line" style="background:${p.text}"></span>
          <span class="tsw-line short" style="background:${p.muted}"></span>
          <span class="tsw-btn" style="background:${p.accent}"></span>
        </span>
        <span class="tsw-check" style="background:${p.accent};color:${p.bg}">${icon('check')}</span>
      </span>
      <span class="tsw-name">${esc(t(theme.name))}</span>
    `;
    btn.addEventListener('click', () => applyTheme(theme.id));
    grid.appendChild(btn);
  });
}

function renderThemePicker() {
  renderThemeGrid($('themes-dark'), 'dark');
  renderThemeGrid($('themes-light'), 'light');
  if (!$('setup').classList.contains('hidden')) renderSetupThemes();
}

/** Draws the logo in the theme accent and makes it the window/taskbar icon. */
async function updateWindowIcon() {
  const symbol = document.getElementById('i-logo');
  if (!symbol || !api.setWindowIcon) return;
  const color = getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim() || '#62b856';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${symbol.getAttribute('viewBox')}" width="256" height="256" fill="${color}">${symbol.innerHTML}</svg>`;
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  try {
    await img.decode();
  } catch (e) {
    return;
  }
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  canvas.getContext('2d').drawImage(img, 0, 0, 256, 256);
  api.setWindowIcon(canvas.toDataURL('image/png'));
}

function applyTheme(id) {
  const root = document.documentElement;
  root.classList.add('theme-switching');
  clearTimeout(applyTheme.timer);
  applyTheme.timer = setTimeout(() => root.classList.remove('theme-switching'), 350);
  root.dataset.theme = id;
  updateWindowIcon();
  state.settings.theme = id;
  saveSettings({ theme: id });
  renderThemePicker();
}

// ================= FIRST-RUN SETUP =================
// Shown on the very first start, or when the launcher is started with --setup.
const setup = { steps: [], index: 0, prismCount: 0, java: [] };

function setupRequested() {
  return new URLSearchParams(location.search).get('setup') === '1';
}

async function maybeRunSetup() {
  if (!setupRequested() && state.settings.setupDone) return;
  try {
    setup.prismCount = await api.countPrismInstances();
  } catch (e) {
    setup.prismCount = 0;
  }
  setup.steps = ['welcome', 'account', 'theme', 'java', ...(setup.prismCount ? ['prism'] : []), 'memory', 'done'];
  setup.index = 0;
  $('setup').classList.remove('hidden');
  renderSetupStep();
}

function renderSetupStep(direction = 1) {
  const name = setup.steps[setup.index];
  document.querySelectorAll('.setup-step').forEach(s => {
    const on = s.dataset.step === name;
    s.classList.toggle('active', on);
    if (on) {
      s.classList.remove('enter-back', 'enter-forward');
      void s.offsetWidth; // restart the slide-in animation
      s.classList.add(direction < 0 ? 'enter-back' : 'enter-forward');
    }
  });
  $('setup-dots').innerHTML = setup.steps.map((s, i) => `<span class="${i < setup.index ? 'done' : i === setup.index ? 'current' : ''}"></span>`).join('');

  const last = setup.index === setup.steps.length - 1;
  $('setup-back').classList.toggle('hidden', setup.index === 0 || last);
  $('setup-skip').classList.toggle('hidden', last);
  $('setup-next').textContent = setup.index === 0 ? t('Начать') : last ? t('Перейти к лаунчеру') : t('Далее');

  if (name === 'account') renderSetupAccount();
  if (name === 'theme') renderSetupThemes();
  if (name === 'java') renderSetupJava();
  if (name === 'prism') {
    $('setup-prism-text').textContent = t('Найдено сборок в Prism Launcher: {n}. Как их подключить?', { n: setup.prismCount });
    document.querySelectorAll('[data-prism]').forEach(b => b.classList.toggle('selected', b.dataset.prism === setup.prismChoice));
  }
  if (name === 'memory') renderSetupMemory();
}

function renderSetupAccount() {
  const acc = activeAccount();
  $('setup-account-current').innerHTML = acc
    ? `<img alt=""><span><b>${esc(acc.username)}</b><small>${accountTypeLabel(acc.type)} · ${t('выбран сейчас')}</small></span>`
    : `<span><small>${t('Аккаунт ещё не добавлен')}</small></span>`;
  const img = $('setup-account-current').querySelector('img');
  if (img) setAvatar(img, acc);
}

function renderSetupThemes() {
  renderThemeGrid($('setup-themes-dark'), 'dark');
  renderThemeGrid($('setup-themes-light'), 'light');
}

async function renderSetupJava() {
  const list = $('setup-java-list');
  if (!setup.java.length) list.innerHTML = `<div class="setup-row"><span class="muted">${t('Проверка…')}</span></div>`;
  try {
    setup.java = await api.getJavaRequirements();
  } catch (e) {
    setup.java = [];
  }
  list.innerHTML = '';
  for (const j of setup.java) {
    const row = document.createElement('div');
    row.className = 'setup-row';
    row.dataset.major = j.major;
    row.innerHTML = j.path
      ? `<span class="setup-row-icon ok">${icon('check', 'ic-sm')}</span><span class="grow"><b>Java ${j.major}</b><small title="${esc(j.path)}">${esc(j.path)}</small></span>`
      : `<span class="setup-row-icon">${icon('coffee', 'ic-sm')}</span><span class="grow"><b>Java ${j.major}</b><small>${t('Не найдена')}</small></span><button class="btn btn-secondary btn-sm">${t('Скачать')}</button>`;
    const btn = row.querySelector('button');
    if (btn) btn.addEventListener('click', () => installJavaFromUi(j.major));
    list.appendChild(row);
  }
  $('setup-java-all').classList.toggle('hidden', !setup.java.some(j => !j.path));
}

const javaInstalls = new Set();
async function installJavaFromUi(major) {
  if (javaInstalls.has(major)) return;
  javaInstalls.add(major);
  const row = document.querySelector(`.setup-row[data-major="${major}"]`);
  const status = row && row.querySelector('small');
  const btn = row && row.querySelector('button');
  if (btn) btn.disabled = true;
  try {
    await api.installJava(major);
    toast(t('Java {major} установлена', { major }));
    await loadJavaList(true);
    if (!$('setup').classList.contains('hidden')) renderSetupJava();
  } catch (e) {
    if (status) status.textContent = errText(e);
    if (btn) btn.disabled = false;
    toast(errText(e), 'error', 6000);
  } finally {
    javaInstalls.delete(major);
  }
}

function onJavaProgress(p) {
  const row = document.querySelector(`.setup-row[data-major="${p.major}"]`);
  const text = p.stage === 'download' && p.total
    ? t('Скачивание… {percent}% из {size}', { percent: Math.round((p.received / p.total) * 100), size: formatSize(p.total) })
    : p.stage === 'extract' ? t('Распаковка…') : p.stage === 'done' ? t('Готово') : t('Подготовка…');
  if (row) row.querySelector('small').textContent = text;
  // the same progress goes to the launch panel when Java is fetched right before a game start
  if (state.isLaunching) setProgress(p.total ? Math.round((p.received / p.total) * 100) : null, `Java ${p.major}: ${text.toLowerCase()}`);
}

function renderSetupMemory() {
  const total = state.settings.totalSystemRam || 8;
  const slider = $('setup-ram');
  slider.max = Math.max(4, Math.min(total, 32));
  slider.value = state.settings.maxRam || Math.min(8, Math.max(2, Math.floor(total / 2)));
  $('setup-ram-value').textContent = t('{n} ГБ', { n: slider.value });
  $('setup-ram-text').textContent = t('Сколько оперативной памяти отдавать игре. В компьютере {n} ГБ.', { n: total });
}

async function setupNext() {
  const name = setup.steps[setup.index];
  if (name === 'prism' && setup.prismChoice) {
    const sync = setup.prismChoice === 'sync';
    await saveSettings({ prismImport: sync });
    $('check-prism').checked = sync;
    if (setup.prismChoice === 'copy') openPrismImport();
    if (sync) loadVersionsAndInstances();
  }
  if (name === 'memory') {
    const v = parseInt($('setup-ram').value, 10);
    $('slider-max-ram').value = v;
    if (parseInt($('slider-min-ram').value, 10) > v) $('slider-min-ram').value = v;
    updateRamLabels();
    await saveSettings({ maxRam: v, minRam: Math.min(state.settings.minRam || 2, v) });
  }
  if (setup.index === setup.steps.length - 1) return finishSetup();
  setup.index++;
  renderSetupStep(1);
}

async function finishSetup() {
  await saveSettings({ setupDone: true });
  const el = $('setup');
  el.classList.add('leaving');
  setTimeout(() => {
    el.classList.add('hidden');
    el.classList.remove('leaving');
  }, 200);
  renderHero();
}

function setupSetup() {
  $('setup-next').addEventListener('click', setupNext);
  $('setup-back').addEventListener('click', () => {
    if (setup.index > 0) {
      setup.index--;
      renderSetupStep(-1);
    }
  });
  $('setup-skip').addEventListener('click', finishSetup);
  $('setup-ms').addEventListener('click', openMicrosoftLogin);
  $('setup-ely').addEventListener('click', () => {
    openModal('modal-accounts');
    document.querySelector('#acc-seg [data-view="acc-ely"]').click();
  });
  const addOffline = async () => {
    const name = $('setup-offline-name').value.trim();
    if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) {
      toast(t('Ник: 3–16 символов, латиница, цифры и «_»'), 'error');
      return;
    }
    await api.addOfflineAccount(name);
    $('setup-offline-name').value = '';
    await loadAccounts();
  };
  $('setup-offline-add').addEventListener('click', addOffline);
  $('setup-offline-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') addOffline(); });
  $('setup-java-all').addEventListener('click', () => setup.java.filter(j => !j.path).forEach(j => installJavaFromUi(j.major)));
  document.querySelectorAll('[data-prism]').forEach(b => b.addEventListener('click', () => {
    setup.prismChoice = b.dataset.prism;
    document.querySelectorAll('[data-prism]').forEach(x => x.classList.toggle('selected', x === b));
  }));
  $('setup-ram').addEventListener('input', () => { $('setup-ram-value').textContent = t('{n} ГБ', { n: $('setup-ram').value }); });
  api.onJavaInstallProgress(onJavaProgress);
}

// ================= JAVA =================
function ensureJavaOption(p) {
  const select = $('select-java');
  if ([...select.options].some(o => o.value === p)) return;
  const opt = document.createElement('option');
  opt.value = p;
  opt.textContent = t('Свой путь — {path}', { path: p });
  select.appendChild(opt);
}

async function loadJavaList(force = false) {
  try {
    state.javaList = await api.detectJava(force);
  } catch (e) {
    state.javaList = [];
  }
  const select = $('select-java');
  select.innerHTML = '';
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = state.javaList.length ? t('Автоматически (по версии игры)') : t('Автоматически — Java не найдена');
  select.appendChild(auto);
  state.javaList.forEach(j => {
    const opt = document.createElement('option');
    opt.value = j.path;
    opt.textContent = `Java ${j.major || '?'} — ${j.path}`;
    select.appendChild(opt);
  });
  if (state.settings.javaPath) ensureJavaOption(state.settings.javaPath);
  select.value = state.settings.javaPath || '';
}

// ================= VERSIONS & INSTANCES =================
async function loadVersionsAndInstances() {
  const [versionsRes, instancesRes] = await Promise.allSettled([
    api.getVersions(!!state.settings.showSnapshots),
    api.listInstances()
  ]);

  if (versionsRes.status === 'fulfilled') {
    state.versions = versionsRes.value.versions || [];
    state.latestRelease = versionsRes.value.latestRelease || '';
  } else {
    toast(t('Не удалось загрузить версии: {error}', { error: errText(versionsRes.reason) }), 'error');
  }
  state.instances = instancesRes.status === 'fulfilled' ? instancesRes.value : [];

  if (!findInstance(state.selected) && !findVersion(state.selected)) {
    state.selected = state.instances[0]?.id || state.latestRelease || state.versions[0]?.id || '';
  }
  if (state.modsTarget && !findInstance(state.modsTarget)) {
    state.modsTarget = null;
    if ($('page-mods').classList.contains('active')) showPage('instances');
  }

  renderAll();
}

function renderAll() {
  renderHero();
  renderRecent();
  renderInstanceGrid();
}

function selectProfile(id, { save = true } = {}) {
  state.selected = id;
  if (save) saveSettings({ selectedVersion: id });
  renderAll();
}

function instanceMeta(inst) {
  const parts = [];
  if (inst.loader !== 'vanilla') parts.push(`${LOADER_LABELS[inst.loader] || inst.loader}${inst.loaderVersion ? ' ' + inst.loaderVersion : ''}`);
  parts.push(`Minecraft ${inst.version}`);
  if (inst.loader !== 'vanilla') parts.push(pluralize(inst.modCount, ['мод', 'мода', 'модов']));
  return parts.join(' · ');
}

/** "12 модов": Russian forms for 1, 2 and 5; the dictionary has the other languages' ones. */
function pluralize(n, forms) {
  return i18n.plural(n, forms);
}

/** Icon color the hero landscape is tinted with: the block's top face, or the accent for pictures. */
function heroTint(inst) {
  if (!inst || inst.iconImage) return 'var(--color-accent)';
  const block = BLOCKS.find(b => b.name === inst.iconBlock) || autoBlock(inst);
  return `var(--color-block-${block.name}-top)`;
}

function renderHero() {
  const inst = findInstance(state.selected);
  const tags = [];
  const meta = [];
  if (inst) {
    $('hero-icon').innerHTML = instanceIconHtml(inst);
    $('hero-title').textContent = inst.name;
    if (hasMods(inst)) tags.push(`${LOADER_LABELS[inst.loader] || inst.loader}${inst.loaderVersion ? ' ' + inst.loaderVersion : ''}`);
    tags.push(`Minecraft ${inst.version}`);
    if (hasMods(inst)) tags.push(pluralize(inst.modCount, ['мод', 'мода', 'модов']));
    meta.push(lastPlayedText(inst));
    if (inst.totalPlaytime) meta.push(t('{time} в игре', { time: formatPlaytime(inst.totalPlaytime) }));
  } else if (state.selected) {
    const v = findVersion(state.selected);
    $('hero-icon').innerHTML = instanceIconHtml({ id: 'vanilla', name: 'vanilla' });
    $('hero-title').textContent = v && v.inheritsFrom ? state.selected : `Minecraft ${state.selected}`;
    tags.push(v && v.inheritsFrom ? t('на основе {version}', { version: v.inheritsFrom }) : t('Без сборки'));
    meta.push(v && v.installed ? t('Установлена') : t('Скачается при запуске'));
  } else {
    $('hero-icon').innerHTML = '';
    $('hero-title').textContent = t('Выберите сборку');
  }
  $('hero').style.setProperty('--hero-tint', heroTint(inst || (state.selected ? { id: 'vanilla', name: 'vanilla' } : null)));
  $('hero-tags').innerHTML = tags.map(t => `<span class="hero-tag">${esc(t)}</span>`).join('');
  $('hero-meta').innerHTML = meta.map(m => `<span>${m}</span>`).join('');
}

function emptyBuilds() {
  return `
    <div class="empty">
      <h3>${t('Сборок пока нет')}</h3>
      <p>${t('Сборка — отдельная папка со своими модами, мирами и настройками.')}</p>
      <button class="btn btn-primary" id="btn-empty-new-inst">${icon('plus', 'ic-sm')}${t('Новая сборка')}</button>
    </div>`;
}

const RECENT_SLOTS = 5;

function renderRecent() {
  const list = $('recent-instances');
  list.innerHTML = '';
  if (!state.instances.length) {
    list.innerHTML = emptyBuilds();
    $('btn-empty-new-inst').addEventListener('click', openNewInstanceModal);
    return;
  }
  const recent = state.instances.slice(0, RECENT_SLOTS);
  recent.forEach(inst => {
    const card = document.createElement('div');
    card.className = `rcard ${inst.id === state.selected ? 'selected' : ''}`;
    card.tabIndex = 0;
    card.innerHTML = `
      <div class="icon-play">
        ${instanceIconHtml(inst)}
        <button class="icon-play-btn" title="${t('Играть в «{name}»', { name: esc(inst.name) })}">${icon('play')}</button>
      </div>
      <div class="rcard-title">${esc(inst.name)}</div>
      <div class="rcard-sub">${esc(hasMods(inst) ? `${LOADER_LABELS[inst.loader] || inst.loader} ${inst.loaderVersion || ''}`.trim() + ` · ${inst.version}` : `Minecraft ${inst.version}`)}</div>
      <div class="rcard-time">${icon('clock')}${lastPlayedShort(inst)}</div>
    `;
    card.addEventListener('click', (e) => {
      if (!e.target.closest('button')) selectProfile(inst.id);
    });
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target === card) selectProfile(inst.id);
    });
    card.querySelector('.icon-play-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      selectProfile(inst.id);
      handleLaunch();
    });
    list.appendChild(card);
  });
  // The row always holds RECENT_SLOTS tiles: the "new build" tile only fills a free slot.
  if (recent.length >= RECENT_SLOTS) return;
  const add = document.createElement('button');
  add.className = 'rcard rcard-new';
  add.innerHTML = `${icon('plus')}<span>${t('Новая сборка')}</span>`;
  add.addEventListener('click', openNewInstanceModal);
  list.appendChild(add);
}

// ---------- home: greeting, week chart, tips ----------
function renderGreeting() {
  const h = new Date().getHours();
  const hello = h < 5 ? t('Доброй ночи') : h < 12 ? t('Доброе утро') : h < 18 ? t('Добрый день') : h < 23 ? t('Добрый вечер') : t('Доброй ночи');
  const acc = activeAccount();
  $('home-greeting').textContent = acc ? `${hello}, ${acc.username}` : hello;
}
setInterval(renderGreeting, 10 * 60 * 1000);

const WEEKDAYS = [t('Пн'), t('Вт'), t('Ср'), t('Чт'), t('Пт'), t('Сб'), t('Вс')];

function dayKey(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

function formatWeekTotal(seconds) {
  if (seconds < 60) return t('0 ч');
  if (seconds < 3600) return t('{m} мин', { m: Math.round(seconds / 60) });
  const h = seconds / 3600;
  return t('{h} ч', { h: (h < 10 ? Math.round(h * 10) / 10 : Math.round(h)).toLocaleString(i18n.locale()) });
}

/** Monday to Sunday of the current week, from the per-day log the main process keeps. */
async function loadWeekStats() {
  const days = await api.getPlaytimeDays().catch(() => ({}));
  const today = new Date();
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (today.getDay() + 6) % 7);
  const week = WEEKDAYS.map((label, i) => {
    const date = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
    return { label, seconds: days[dayKey(date)] || 0, today: i === (today.getDay() + 6) % 7, date };
  });
  const max = Math.max(...week.map(d => d.seconds), 1);
  $('week-total').textContent = formatWeekTotal(week.reduce((sum, d) => sum + d.seconds, 0));
  $('week-chart').innerHTML = week.map(d => `
    <div class="week-day ${d.today ? 'today' : ''}" title="${d.date.toLocaleDateString(i18n.locale(), { weekday: 'long', day: 'numeric', month: 'long' })}: ${d.seconds ? formatPlaytime(d.seconds) : t('не играли')}">
      <div class="week-bar-wrap"><div class="week-bar" style="height:${Math.round(d.seconds / max * 100)}%"></div></div>
      <span class="week-label">${d.label}</span>
    </div>`).join('');
}

const TIPS = [
  t('Перетащи .jar на страницу модов сборки — мод добавится сам.'),
  t('Нажми на иконку сборки на главной, чтобы сменить её на блок или свою картинку.'),
  t('Сборки из Prism Launcher можно не копировать: включи синхронизацию в настройках.'),
  t('Лаунчер сам переносит бинды и настройки графики между сборками — это настраивается в «Переносе настроек игры».'),
  t('Нужную Java лаунчер подберёт и скачает сам под каждую версию Minecraft.'),
  t('Все скриншоты из всех сборок собраны во вкладке «Скриншоты».'),
  t('Консоль можно вынести в отдельное окно и держать поверх игры.')
];

function renderTip() {
  $('home-tip').textContent = TIPS[Math.floor(Math.random() * TIPS.length)];
}

// ---------- builds: grid / list ----------
function buildStats(inst) {
  const stats = [];
  if (hasMods(inst)) stats.push(pluralize(inst.modCount, ['мод', 'мода', 'модов']));
  if (inst.totalPlaytime) stats.push(formatPlaytime(inst.totalPlaytime));
  stats.push(lastPlayedShort(inst));
  return stats;
}

function loaderLine(inst) {
  const loader = inst.loader === 'vanilla' ? '' : `${LOADER_LABELS[inst.loader] || inst.loader}${inst.loaderVersion ? ' ' + inst.loaderVersion : ''} · `;
  return `${loader}Minecraft ${inst.version}`;
}

function syncMark(inst) {
  return inst.isPrism ? `<span class="sync-mark" title="${t('Синхронизируется с Prism Launcher')}">${icon('link')}</span>` : '';
}

function buildActionsHtml(inst) {
  return `
    <div class="row-actions">
      ${hasMods(inst) ? `<button class="icon-btn" data-act="mods" title="${t('Моды')}">${icon('puzzle')}</button>` : ''}
      <button class="icon-btn" data-act="folder" title="${t('Открыть папку')}">${icon('folder')}</button>
      <button class="icon-btn" data-act="sync" title="${t('Перенести настройки из другой сборки')}">${icon('transfer')}</button>
      <button class="icon-btn" data-act="icon" title="${t('Иконка')}">${icon('image')}</button>
      <button class="icon-btn" data-act="copy" title="${t('Копировать')}">${icon('copy')}</button>
      ${inst.isPrism ? '' : `<button class="icon-btn danger" data-act="delete" title="${t('Удалить')}">${icon('trash')}</button>`}
    </div>`;
}

function buildActions(inst) {
  return {
    play: () => {
      selectProfile(inst.id);
      showPage('home');
      handleLaunch();
    },
    mods: () => openBuildMods(inst.id),
    folder: () => api.openInstanceFolder(inst.id),
    sync: () => openManualSync(inst.id),
    icon: () => openIconPicker(inst.id),
    copy: () => copyBuild(inst),
    delete: () => deleteBuild(inst)
  };
}

/** Card "⋯" menu: the same actions as the list row buttons. */
function buildMenuItems(inst, acts) {
  return [
    hasMods(inst) && { label: t('Моды'), icon: 'puzzle', run: acts.mods },
    { label: t('Открыть папку'), icon: 'folder', run: acts.folder },
    { label: t('Перенести настройки из другой сборки'), icon: 'transfer', run: acts.sync },
    { label: t('Сменить иконку'), icon: 'image', run: acts.icon },
    { label: t('Копировать'), icon: 'copy', run: acts.copy },
    !inst.isPrism && 'separator',
    !inst.isPrism && { label: t('Удалить'), icon: 'trash', run: acts.delete, danger: true }
  ].filter(Boolean);
}

function bindBuildActions(el, inst) {
  el.addEventListener('click', (e) => {
    if (!e.target.closest('button')) selectProfile(inst.id);
  });
  const acts = buildActions(inst);
  el.querySelectorAll('[data-act]').forEach(b => {
    const act = b.dataset.act;
    if (act === 'menu') b.addEventListener('click', () => openMenu(b, buildMenuItems(inst, acts)));
    else if (acts[act]) b.addEventListener('click', acts[act]);
  });
}

// ---------- build icon picker ----------
let iconPickerId = null;

function renderIconPicker() {
  const inst = findInstance(iconPickerId);
  if (!inst) return;
  $('icon-picker-name').textContent = inst.name;
  $('icon-picker-preview').innerHTML = instanceIconHtml(inst);
  $('icon-picker-reset').disabled = !inst.iconImage && !inst.iconBlock;
  $('icon-picker-prism').classList.toggle('hidden', !inst.isPrism);
  const grid = $('icon-picker-grid');
  grid.classList.toggle('hidden', inst.isPrism); // Prism stores only image icons
  $('icon-picker-blocks-label').classList.toggle('hidden', inst.isPrism);
  grid.innerHTML = '';
  const current = inst.iconImage ? null : (inst.iconBlock || autoBlock(inst).name);
  for (const block of BLOCKS) {
    const b = document.createElement('button');
    b.className = `icon-choice ${block.name === current ? 'active' : ''}`;
    b.title = block.name;
    b.innerHTML = blockIconHtml(block);
    b.addEventListener('click', () => applyInstanceIcon({ block: block.name }));
    grid.appendChild(b);
  }
}

function openIconPicker(instanceId) {
  iconPickerId = instanceId;
  renderIconPicker();
  openModal('modal-icon');
}

async function applyInstanceIcon(choice) {
  try {
    const updated = await api.setInstanceIcon(iconPickerId, choice);
    const i = state.instances.findIndex(x => x.id === iconPickerId);
    if (updated && i >= 0) state.instances[i] = updated;
    renderAll();
    if (state.modsTarget === iconPickerId) $('mods-head-icon').innerHTML = instanceIconHtml(updated);
    renderIconPicker();
  } catch (e) {
    toast(errText(e), 'error');
  }
}

function setupIconPicker() {
  $('icon-picker-upload').addEventListener('click', async () => {
    const file = await api.browseFile({ title: t('Картинка для иконки'), filters: [{ name: t('Изображения'), extensions: ['png', 'jpg', 'jpeg', 'bmp', 'ico'] }] });
    if (file) applyInstanceIcon({ file });
  });
  $('icon-picker-reset').addEventListener('click', () => applyInstanceIcon(null));
  $('hero-icon').addEventListener('click', () => {
    if (findInstance(state.selected)) openIconPicker(state.selected);
  });
}

async function copyBuild(inst) {
  const name = await dialog({ title: t('Копировать сборку'), text: t('Название новой сборки:'), input: t('{name} (копия)', { name: inst.name }), okText: t('Копировать') });
  if (!name) return;
  try {
    toast(t('Копирование…'));
    const copy = await api.copyInstance(inst.id, name);
    await loadVersionsAndInstances();
    if (copy) selectProfile(copy.id);
    toast(t('Сборка «{name}» создана', { name }));
  } catch (e) {
    toast(errText(e), 'error');
  }
}

async function deleteBuild(inst) {
  const ok = await dialog({ title: t('Удалить сборку?'), text: t('«{name}» будет удалена вместе с модами и мирами. Это нельзя отменить.', { name: inst.name }), okText: t('Удалить'), danger: true });
  if (!ok) return;
  try {
    await api.deleteInstance(inst.id);
    await loadVersionsAndInstances();
    toast(t('Сборка удалена'));
  } catch (e) {
    toast(errText(e), 'error');
  }
}

// ---------- dropdown menu ----------
let openMenuEl = null;

function closeMenu() {
  if (!openMenuEl) return;
  openMenuEl.remove();
  openMenuEl = null;
  document.removeEventListener('mousedown', onMenuOutside, true);
  window.removeEventListener('blur', closeMenu);
  window.removeEventListener('resize', closeMenu);
  document.removeEventListener('scroll', closeMenu, true);
}

function onMenuOutside(e) {
  if (openMenuEl && !openMenuEl.contains(e.target) && !e.target.closest('.menu-anchor-open')) closeMenu();
}

/** Small popup menu under `anchor`. items: [{ label, icon, run, danger } | 'separator'] */
function openMenu(anchor, items) {
  const wasOpen = anchor.classList.contains('menu-anchor-open');
  document.querySelectorAll('.menu-anchor-open').forEach(a => a.classList.remove('menu-anchor-open'));
  closeMenu();
  if (wasOpen) return; // second click on the same button closes it

  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.setAttribute('role', 'menu');
  for (const item of items) {
    if (item === 'separator') {
      menu.insertAdjacentHTML('beforeend', '<div class="menu-sep"></div>');
      continue;
    }
    const b = document.createElement('button');
    b.className = `menu-item ${item.danger ? 'danger' : ''}`;
    b.setAttribute('role', 'menuitem');
    b.innerHTML = `${icon(item.icon, 'ic-sm')}<span>${esc(item.label)}</span>`;
    b.addEventListener('click', () => {
      anchor.classList.remove('menu-anchor-open');
      closeMenu();
      item.run();
    });
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  anchor.classList.add('menu-anchor-open');

  // right-aligned under the button; flips above or left when it would leave the window
  const a = anchor.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  let left = a.right - m.width;
  let top = a.bottom + 4;
  if (left < 8) left = Math.min(a.left, window.innerWidth - m.width - 8);
  if (top + m.height > window.innerHeight - 8) top = a.top - m.height - 4;
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;

  openMenuEl = menu;
  const close = () => {
    anchor.classList.remove('menu-anchor-open');
    closeMenu();
  };
  menu.close = close;
  setTimeout(() => {
    document.addEventListener('mousedown', onMenuOutside, true);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    document.addEventListener('scroll', close, true);
  });
  const first = menu.querySelector('.menu-item');
  if (first) first.focus();
}

function renderInstanceGrid() {
  const container = $('instance-grid');
  const view = state.settings.buildsView === 'list' ? 'list' : 'grid';
  document.querySelectorAll('#builds-view-seg button').forEach(b => b.classList.toggle('active', b.dataset.buildsView === view));
  container.className = view === 'grid' ? 'builds-grid' : 'table';
  container.innerHTML = '';

  if (!state.instances.length) {
    container.className = 'table';
    container.innerHTML = emptyBuilds();
    $('btn-empty-new-inst').addEventListener('click', openNewInstanceModal);
    return;
  }

  state.instances.forEach(inst => {
    const el = document.createElement('div');
    const selected = inst.id === state.selected ? 'selected' : '';
    if (view === 'grid') {
      el.className = `bcard ${selected}`;
      el.innerHTML = `
        <div class="bcard-top">
          ${instanceIconHtml(inst)}
          <div class="bcard-text">
            <div class="bcard-title" title="${esc(inst.name)}"><span class="grow" style="overflow:hidden;text-overflow:ellipsis">${esc(inst.name)}</span>${syncMark(inst)}</div>
            <div class="bcard-sub">${esc(loaderLine(inst))}</div>
          </div>
        </div>
        <div class="bcard-stats">${buildStats(inst).map(s => `<span>${s}</span>`).join('')}</div>
        <div class="bcard-foot">
          <button class="btn btn-secondary btn-sm btn-row-play" data-act="play">${icon('play', 'ic-xs')}${t('Играть')}</button>
          <button class="icon-btn bcard-more" data-act="menu" title="${t('Действия')}" aria-haspopup="menu">${icon('more')}</button>
        </div>
      `;
    } else {
      el.className = `trow trow-click ${selected}`;
      el.innerHTML = `
        ${instanceIconHtml(inst)}
        <div class="trow-main">
          <div class="trow-title">${esc(inst.name)} ${syncMark(inst)}</div>
          <div class="trow-sub">${esc(instanceMeta(inst))}</div>
        </div>
        <div class="trow-aside">
          <div>${lastPlayedShort(inst)}</div>
          <div class="muted-2">${inst.totalPlaytime ? formatPlaytime(inst.totalPlaytime) : ''}</div>
        </div>
        ${buildActionsHtml(inst)}
        <button class="btn btn-secondary btn-sm btn-row-play" data-act="play">${icon('play', 'ic-xs')}${t('Играть')}</button>
      `;
    }
    bindBuildActions(el, inst);
    container.appendChild(el);
  });
}

// ---------- background mod update check ----------
// Silent: results are only shown inside a build's mods page; this just keeps the scan cache warm
// so that page opens with update info right away.
const UPDATE_CHECK_INTERVAL = 30 * 60 * 1000;
const updateCheck = { running: false };

async function backgroundUpdateCheck() {
  if (updateCheck.running || state.settings.autoCheckModUpdates === false) return;
  if (state.isLaunching || state.isGameRunning) return;
  updateCheck.running = true;
  try {
    await Promise.all(state.instances.filter(hasMods).map(inst => api.scanInstanceMods(inst.id, false).catch(() => {})));
  } finally {
    updateCheck.running = false;
  }
}

function startBackgroundUpdateChecks() {
  setTimeout(backgroundUpdateCheck, 5000);
  setInterval(backgroundUpdateCheck, UPDATE_CHECK_INTERVAL);
}

function setupInstances() {
  $('btn-new-instance').addEventListener('click', openNewInstanceModal);
  document.querySelectorAll('#builds-view-seg button').forEach(btn => {
    btn.addEventListener('click', () => {
      saveSettings({ buildsView: btn.dataset.buildsView });
      state.settings.buildsView = btn.dataset.buildsView;
      renderInstanceGrid();
    });
  });

  document.querySelectorAll('#inst-loader-seg button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#inst-loader-seg button').forEach(b => b.classList.toggle('active', b === btn));
      state.newInstanceLoader = btn.dataset.loader;
      renderLoaderVersions();
    });
  });
  $('select-inst-version').addEventListener('change', refreshLoaderChoice);

  $('btn-create-instance').addEventListener('click', async () => {
    const name = $('input-inst-name').value.trim() || t('Моя сборка');
    const version = $('select-inst-version').value;
    const loader = state.newInstanceLoader;
    const loaderVersion = loader === 'vanilla' ? '' : $('select-inst-loader-version').value;
    const status = $('inst-status');
    newInstanceForm.creating = true;
    updateCreateButton();
    status.className = 'form-status';
    status.textContent = loader === 'vanilla' ? t('Создание…') : t('Установка {loader} {version}…', { loader: LOADER_LABELS[loader], version: loaderVersion });
    const stopProgress = api.onLoaderInstallProgress((text) => { status.textContent = text; });
    try {
      const inst = await api.createInstance({ name, version, loader, loaderVersion });
      $('modal-instance').classList.add('hidden');
      await loadVersionsAndInstances();
      if (inst) selectProfile(inst.id);
      toast(t('Сборка «{name}» создана', { name }));
    } catch (e) {
      status.className = 'form-status error';
      status.textContent = errText(e);
    } finally {
      stopProgress();
      newInstanceForm.creating = false;
      updateCreateButton();
    }
  });
}

// ---- New build: loader and its version ----
const MOD_LOADERS = ['fabric', 'quilt', 'forge', 'neoforge'];
const newInstanceForm = { creating: false, loaderReady: true, token: 0 };
const loaderVersionLists = new Map(); // "forge|1.20.1" -> promise of [{ version, recommended }]

function loaderVersionList(loader, mcVersion) {
  const key = `${loader}|${mcVersion}`;
  if (!loaderVersionLists.has(key)) {
    const list = api.getLoaderVersions(loader, mcVersion);
    list.catch(() => loaderVersionLists.delete(key)); // asked again next time
    loaderVersionLists.set(key, list);
  }
  return loaderVersionLists.get(key);
}

function updateCreateButton() {
  $('btn-create-instance').disabled = newInstanceForm.creating || !newInstanceForm.loaderReady;
}

// Dims loaders that have no builds for the chosen Minecraft version, then fills the version list
function refreshLoaderChoice() {
  const mcVersion = $('select-inst-version').value;
  MOD_LOADERS.forEach(loader => {
    const btn = document.querySelector(`#inst-loader-seg [data-loader="${loader}"]`);
    btn.classList.remove('unavailable');
    btn.title = '';
    loaderVersionList(loader, mcVersion).then(list => {
      if ($('select-inst-version').value !== mcVersion || list.length) return;
      btn.classList.add('unavailable');
      btn.title = t('{loader} нет для Minecraft {version}', { loader: LOADER_LABELS[loader], version: mcVersion });
    }).catch(() => {});
  });
  renderLoaderVersions();
}

async function renderLoaderVersions() {
  const token = ++newInstanceForm.token;
  const loader = state.newInstanceLoader;
  const mcVersion = $('select-inst-version').value;
  const select = $('select-inst-loader-version');
  const status = $('inst-status');
  const setStatus = (text, error = false) => {
    if (newInstanceForm.creating) return;
    status.className = error ? 'form-status error' : 'form-status';
    status.textContent = text;
  };

  $('inst-loader-version-wrap').classList.toggle('hidden', loader === 'vanilla');
  setStatus('');
  newInstanceForm.loaderReady = loader === 'vanilla';
  updateCreateButton();
  if (loader === 'vanilla') return;

  select.disabled = true;
  select.innerHTML = `<option>${t('Загрузка…')}</option>`;
  try {
    const list = await loaderVersionList(loader, mcVersion);
    if (token !== newInstanceForm.token) return;
    if (!list.length) {
      select.innerHTML = '<option>—</option>';
      setStatus(t('{loader} нет для Minecraft {version}', { loader: LOADER_LABELS[loader], version: mcVersion }), true);
      return;
    }
    select.innerHTML = list.map(v =>
      `<option value="${esc(v.version)}">${esc(v.version)}${v.recommended ? ` — ${t('рекомендуемая')}` : ''}</option>`).join('');
    select.value = (list.find(v => v.recommended) || list[0]).version;
    select.disabled = false;
    newInstanceForm.loaderReady = true;
    updateCreateButton();
  } catch (e) {
    if (token !== newInstanceForm.token) return;
    select.innerHTML = '<option>—</option>';
    setStatus(t('Не удалось получить версии {loader}: {error}', { loader: LOADER_LABELS[loader], error: errText(e) }), true);
  }
}

function openNewInstanceModal() {
  const select = $('select-inst-version');
  select.innerHTML = '';
  state.versions.filter(v => !v.inheritsFrom && (v.type === 'release' || state.settings.showSnapshots)).forEach(v => {
    const o = document.createElement('option');
    o.value = v.id;
    o.textContent = v.type === 'release' ? v.id : `${v.id} (${v.type})`;
    select.appendChild(o);
  });
  if (state.latestRelease) select.value = state.latestRelease;
  $('input-inst-name').value = '';
  if (!newInstanceForm.creating) $('inst-status').textContent = '';
  refreshLoaderChoice();
  openModal('modal-instance');
  $('input-inst-name').focus();
}

// ================= MODS =================
// state.mods: local files, enriched with Modrinth data once a scan finishes
const modsUi = { filter: 'all', scanning: false, scanned: false, online: true, busy: new Set() };

function openBuildMods(id, { filter = null } = {}) {
  const inst = findInstance(id);
  if (!hasMods(inst)) return;
  const changed = state.modsTarget !== id || !!filter;
  state.modsTarget = id;

  $('mods-head-icon').innerHTML = instanceIconHtml(inst);
  $('mods-title').textContent = inst.name;
  $('mods-subtitle').textContent = instanceMeta(inst);
  $('modrinth-context').textContent = t('Только версии для Minecraft {version} и {loader}', { version: inst.version, loader: LOADER_LABELS[inst.loader] || inst.loader });
  if (changed) {
    state.mods = [];
    modsUi.scanned = false;
    modsUi.filter = filter || 'all';
    document.querySelectorAll('#mods-filters .filter').forEach(f => f.classList.toggle('active', f.dataset.filter === modsUi.filter));
    document.querySelectorAll('#mods-seg button').forEach(b => {
      const installed = b.dataset.view === 'view-mods-installed';
      b.classList.toggle('active', filter ? installed : b.classList.contains('active'));
      if (filter) $(b.dataset.view).classList.toggle('active', installed);
    });
    $('search-installed-mods').value = '';
    $('modrinth-results').innerHTML = '';
    if ($('view-mods-modrinth').classList.contains('active')) searchModrinth();
  }
  showPage('mods');
}

/** Lists local files at once, then asks Modrinth what they are and whether updates exist. */
async function loadMods({ force = false } = {}) {
  const inst = modsInstance();
  if (!inst) return;
  if (!modsUi.scanned) {
    try {
      const local = await api.listInstanceMods(inst.id);
      if (state.modsTarget !== inst.id) return;
      state.mods = local.map(m => ({ fileName: m.fileName, enabled: m.enabled, sizeBytes: m.sizeBytes }));
      renderModsList();
    } catch (e) {}
  }
  await scanMods(force);
}

async function scanMods(force = false) {
  const inst = modsInstance();
  if (!inst || modsUi.scanning) return;
  modsUi.scanning = true;
  $('btn-check-updates').disabled = true;
  $('btn-check-updates').classList.add('spinning');
  setScanStatus(force ? t('Проверка обновлений…') : t('Сверка с Modrinth…'));
  try {
    const res = await api.scanInstanceMods(inst.id, force);
    if (state.modsTarget !== inst.id) return;
    state.mods = res.mods;
    modsUi.online = res.online;
    modsUi.scanned = true;
    renderModsList();
    if (force && res.online) {
      const n = res.mods.filter(m => m.update).length;
      toast(n ? t('Доступно обновлений: {n}', { n }) : t('Все моды актуальны'));
    }
  } catch (e) {
    setScanStatus(errText(e));
  } finally {
    modsUi.scanning = false;
    $('btn-check-updates').disabled = false;
    $('btn-check-updates').classList.remove('spinning');
  }
}

function setScanStatus(text) {
  $('mods-scan-status').textContent = text || '';
}

function modDisplayName(mod) {
  return mod.title || mod.fileName.replace(/\.disabled$/i, '').replace(/\.jar$/i, '');
}

function renderModsList() {
  const inst = modsInstance();
  const list = $('mods-list');
  const q = $('search-installed-mods').value.toLowerCase();
  const mods = state.mods;

  const updates = mods.filter(m => m.update);
  const incompatible = mods.filter(m => m.compatible === false && !m.update);
  const disabled = mods.filter(m => !m.enabled);
  $('mods-tab-count').textContent = mods.length || '';
  $('count-updates').textContent = updates.length || '';
  $('count-incompatible').textContent = incompatible.length || '';
  $('count-disabled').textContent = disabled.length || '';
  document.querySelector('#mods-filters [data-filter="updates"]').classList.toggle('hidden', !updates.length);
  document.querySelector('#mods-filters [data-filter="incompatible"]').classList.toggle('hidden', !incompatible.length);
  document.querySelector('#mods-filters [data-filter="disabled"]').classList.toggle('hidden', !disabled.length);

  const updateAll = $('btn-update-all');
  updateAll.classList.toggle('hidden', !updates.length);
  updateAll.querySelector('span').textContent = `${t('Обновить все')} (${updates.length})`;

  if (modsUi.scanned) {
    const known = mods.filter(m => m.projectId).length;
    setScanStatus(modsUi.online
      ? t('{mods}, {known} найдено на Modrinth · проверено для Minecraft {version}', { mods: pluralize(mods.length, ['мод', 'мода', 'модов']), known, version: inst ? inst.version : '' })
      : t('Modrinth недоступен — показаны только файлы'));
  }

  // Before the Modrinth check there are no updates yet: keep the requested filter until it is done
  if (modsUi.scanned) {
    if (modsUi.filter === 'updates' && !updates.length) modsUi.filter = 'all';
    if (modsUi.filter === 'incompatible' && !incompatible.length) modsUi.filter = 'all';
  }
  if (modsUi.filter === 'disabled' && !disabled.length) modsUi.filter = 'all';
  document.querySelectorAll('#mods-filters .filter').forEach(f => f.classList.toggle('active', f.dataset.filter === modsUi.filter));

  const visible = mods
    .filter(m => modsUi.filter === 'all'
      || (modsUi.filter === 'updates' && m.update)
      || (modsUi.filter === 'incompatible' && m.compatible === false && !m.update)
      || (modsUi.filter === 'disabled' && !m.enabled))
    .filter(m => !q || modDisplayName(m).toLowerCase().includes(q) || m.fileName.toLowerCase().includes(q))
    .sort((a, b) => (!!b.update - !!a.update) || modDisplayName(a).localeCompare(modDisplayName(b)));

  list.innerHTML = '';
  if (!mods.length) {
    list.innerHTML = `<div class="empty"><h3>${t('Модов пока нет')}</h3><p>${t('Найдите их в каталоге Modrinth или перетащите .jar в окно.')}</p></div>`;
    return;
  }
  if (!visible.length) {
    const waiting = !modsUi.scanned && modsUi.filter !== 'all' && modsUi.filter !== 'disabled';
    list.innerHTML = `<div class="empty empty-sm"><p>${waiting ? t('Сверка с Modrinth…') : t('Ничего не найдено')}</p></div>`;
    return;
  }

  visible.forEach(mod => {
    const busy = modsUi.busy.has(mod.fileName);
    const row = document.createElement('div');
    row.className = `trow ${mod.enabled ? '' : 'is-off'}`;

    let status = '';
    if (mod.update) {
      status = `<button class="btn btn-update btn-sm" data-act="update" ${busy ? 'disabled' : ''} title="${t('Версия {version} для Minecraft {mc}', { version: esc(mod.update.versionNumber), mc: esc(inst.version) })}">
        ${busy ? t('Обновление…') : `${icon('download', 'ic-xs')}${t('Обновить')}`}</button>`;
    } else if (mod.compatible === false) {
      status = `<span class="tag tag-warn" title="${t('Эта версия мода сделана для {versions}', { versions: esc((mod.gameVersions || []).slice(-3).join(', ')) })}">${t('Не для {version}', { version: esc(inst.version) })}</span>`;
    } else if (modsUi.scanned && modsUi.online && !mod.projectId) {
      status = `<span class="tag" title="${t('Файла нет на Modrinth — обновления не проверяются')}">${t('Не с Modrinth')}</span>`;
    }

    row.innerHTML = `
      <div class="mod-icon">${mod.iconUrl ? '<img alt="">' : icon('puzzle')}</div>
      <div class="trow-main">
        <div class="trow-title">${esc(modDisplayName(mod))}${mod.enabled ? '' : `<span class="off-label">${t('выключен')}</span>`}</div>
        <div class="trow-sub" title="${esc(mod.fileName)}">${mod.update
          ? `${esc(mod.versionNumber)} <span class="ver-arrow">→</span> <span class="ver-new">${esc(mod.update.versionNumber)}</span>`
          : `${mod.versionNumber ? esc(mod.versionNumber) + ' · ' : ''}${esc(mod.fileName)}`}</div>
      </div>
      <div class="trow-status">${status}</div>
      <label class="switch" title="${mod.enabled ? t('Выключить') : t('Включить')}"><input type="checkbox" ${mod.enabled ? 'checked' : ''}><span></span></label>
      <button class="icon-btn danger" data-act="delete" title="${t('Удалить')}">${icon('trash')}</button>
    `;
    const img = row.querySelector('img');
    if (img) {
      img.src = mod.iconUrl;
      img.onerror = () => { img.replaceWith(document.createRange().createContextualFragment(icon('puzzle'))); };
    }

    row.querySelector('input').addEventListener('change', async (e) => {
      try {
        await api.toggleInstanceMod(inst.id, mod.fileName, e.target.checked);
        await loadMods();
      } catch (err) {
        e.target.checked = !e.target.checked;
        toast(errText(err), 'error');
      }
    });
    row.querySelector('[data-act="delete"]').addEventListener('click', async () => {
      const ok = await dialog({ title: t('Удалить мод?'), text: modDisplayName(mod), okText: t('Удалить'), danger: true });
      if (!ok) return;
      await api.deleteInstanceMod(inst.id, mod.fileName);
      await loadMods();
      refreshInstanceCounts();
    });
    const upd = row.querySelector('[data-act="update"]');
    if (upd) upd.addEventListener('click', () => updateMods([mod]));
    list.appendChild(row);
  });
}

async function updateMods(mods) {
  const inst = modsInstance();
  if (!inst || !mods.length) return;
  mods.forEach(m => modsUi.busy.add(m.fileName));
  renderModsList();
  let done = 0;
  const failed = [];
  for (const mod of mods) {
    try {
      await api.updateInstanceMod(inst.id, mod.fileName);
      done++;
      if (mods.length > 1) $('btn-update-all').querySelector('span').textContent = `${t('Обновление…')} ${done}/${mods.length}`;
    } catch (e) {
      failed.push(`${modDisplayName(mod)}: ${errText(e)}`);
    }
    modsUi.busy.delete(mod.fileName);
  }
  modsUi.scanned = false;
  await loadMods();
  if (done) toast(mods.length === 1 ? t('{name} обновлён', { name: modDisplayName(mods[0]) }) : t('Обновлено модов: {n}', { n: done }));
  if (failed.length) {
    toast(t('Не удалось обновить: {n}', { n: failed.length }), 'error', 6000);
    failed.forEach(f => appendLog('error', `[MODS]: ${f}`));
  }
}

async function refreshInstanceCounts() {
  try {
    state.instances = await api.listInstances();
    renderHero();
    renderRecent();
    renderInstanceGrid();
  } catch (e) {}
}

async function addModFiles(paths) {
  const inst = modsInstance();
  if (!inst) return;
  let added = 0;
  for (const p of paths) {
    try {
      await api.addInstanceMod(inst.id, p);
      added++;
    } catch (e) {
      toast(`${p}: ${errText(e)}`, 'error');
    }
  }
  if (added) {
    await loadMods();
    refreshInstanceCounts();
    toast(t('Добавлено модов: {n}', { n: added }));
  }
}

function setupMods() {
  $('btn-mods-back').addEventListener('click', () => showPage('instances'));
  $('search-installed-mods').addEventListener('input', renderModsList);
  document.querySelectorAll('#mods-filters .filter').forEach(f => {
    f.addEventListener('click', () => {
      modsUi.filter = f.dataset.filter;
      renderModsList();
    });
  });
  $('btn-check-updates').addEventListener('click', () => scanMods(true));
  $('btn-update-all').addEventListener('click', () => updateMods(state.mods.filter(m => m.update)));

  $('btn-open-mods-dir').addEventListener('click', () => {
    if (state.modsTarget) api.openInstanceFolder(state.modsTarget);
  });

  $('btn-add-mod').addEventListener('click', async () => {
    const filePath = await api.browseFile({ title: t('Выберите мод (.jar)'), filters: [{ name: 'Minecraft Mod', extensions: ['jar'] }] });
    if (filePath) addModFiles([filePath]);
  });

  // Drag & drop .jar files: into the open build, or the selected build with a loader
  const overlay = $('drop-overlay');
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (dragDepth++ === 0) {
      if (!$('page-mods').classList.contains('active')) {
        const selected = findInstance(state.selected);
        if (!hasMods(selected)) return;
        openBuildMods(selected.id);
      }
      overlay.classList.remove('hidden');
    }
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    if (--dragDepth <= 0) {
      dragDepth = 0;
      overlay.classList.add('hidden');
    }
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    overlay.classList.add('hidden');
    if (!$('page-mods').classList.contains('active')) {
      if (e.dataTransfer?.files?.length) toast(t('Моды ставятся в сборку: откройте её моды или выберите сборку с загрузчиком модов'), 'error');
      return;
    }
    const jars = [...(e.dataTransfer?.files || [])].filter(f => f.name.endsWith('.jar')).map(f => f.path);
    if (jars.length) addModFiles(jars);
    else if (e.dataTransfer?.files?.length) toast(t('Можно добавлять только .jar файлы'), 'error');
  });

  // Modrinth
  let timer;
  $('modrinth-search-input').addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(searchModrinth, 350);
  });
  $('modrinth-category-filter').addEventListener('change', searchModrinth);
  $('modrinth-sort-filter').addEventListener('change', searchModrinth);
}

let modrinthRequest = 0;
async function searchModrinth() {
  const list = $('modrinth-results');
  const reqId = ++modrinthRequest;
  const inst = modsInstance();
  if (!inst) return;
  list.innerHTML = Array.from({ length: 6 }, () => '<div class="trow skeleton-row"><div class="sk sk-icon"></div><div class="trow-main"><div class="sk sk-line"></div><div class="sk sk-line short"></div></div></div>').join('');

  // Installed state of catalog entries comes from the scan
  if (!modsUi.scanned) scanMods().then(() => {
    if (reqId === modrinthRequest && lastHits) renderModrinthResults(lastHits);
  });

  try {
    const res = await api.searchModrinth({
      query: $('modrinth-search-input').value.trim(),
      gameVersion: inst.version,
      loader: inst.loader,
      category: $('modrinth-category-filter').value,
      sortBy: $('modrinth-sort-filter').value,
      limit: 30
    });
    if (reqId !== modrinthRequest) return;
    lastHits = res.hits || [];
    renderModrinthResults(lastHits);
  } catch (e) {
    if (reqId !== modrinthRequest) return;
    list.innerHTML = `<div class="empty"><h3>${t('Modrinth недоступен')}</h3><p>${esc(errText(e))}</p></div>`;
  }
}

let lastHits = null;

// Modrinth content categories; loader tags (fabric, babric, ...) are left out on purpose
const CATEGORY_LABELS = {
  adventure: t('приключения'), cursed: t('странное'), decoration: t('декор'), economy: t('экономика'),
  equipment: t('снаряжение'), food: t('еда'), 'game-mechanics': t('механики'), library: t('библиотека'),
  magic: t('магия'), management: t('управление'), minigame: t('мини-игры'), mobs: t('мобы'),
  optimization: t('оптимизация'), social: t('общение'), storage: t('хранение'), technology: t('технологии'),
  transportation: t('транспорт'), utility: t('утилиты'), worldgen: t('генерация мира')
};

function installedByProject() {
  const map = {};
  for (const m of state.mods) if (m.projectId) map[m.projectId] = m;
  return map;
}

function renderModrinthResults(hits) {
  const list = $('modrinth-results');
  list.innerHTML = '';
  if (!hits.length) {
    list.innerHTML = `<div class="empty"><h3>${t('Ничего не найдено')}</h3><p>${t('Для этой версии Minecraft и загрузчика подходящих модов нет.')}</p></div>`;
    return;
  }
  hits.forEach(hit => {
    const row = document.createElement('div');
    row.className = 'trow trow-catalog';
    const cats = (hit.display_categories || hit.categories || []).map(c => CATEGORY_LABELS[c]).filter(Boolean).slice(0, 3);
    row.innerHTML = `
      <div class="mod-icon mod-icon-lg">${hit.icon_url ? '<img alt="">' : icon('puzzle')}</div>
      <div class="trow-main">
        <div class="trow-title">${esc(hit.title)} <span class="by">${esc(hit.author)}</span></div>
        <div class="trow-desc">${esc(hit.description || '')}</div>
        <div class="trow-sub">${icon('download', 'ic-xs')} ${formatCount(hit.downloads || 0)}${cats.length ? ' · ' + cats.join(', ') : ''}</div>
      </div>
      <div class="trow-status"></div>
    `;
    const img = row.querySelector('img');
    if (img) {
      img.src = hit.icon_url;
      img.onerror = () => { img.style.visibility = 'hidden'; };
    }

    const slot = row.querySelector('.trow-status');
    const renderAction = () => {
      const l = installedByProject()[hit.project_id];
      if (l && l.update) {
        slot.innerHTML = `<button class="btn btn-update btn-sm">${icon('download', 'ic-xs')}${t('Обновить')}</button>`;
        slot.querySelector('button').addEventListener('click', async () => {
          slot.innerHTML = `<span class="tag">${t('Обновление…')}</span>`;
          await updateMods([l]);
          renderAction();
        });
      } else if (l) {
        slot.innerHTML = `<span class="tag tag-ok">${icon('check', 'ic-xs')}${t('Установлен')}</span>`;
      } else {
        slot.innerHTML = `<button class="btn btn-secondary btn-sm">${t('Установить')}</button>`;
        const btn = slot.querySelector('button');
        btn.addEventListener('click', async () => {
          const inst = modsInstance();
          if (!inst) return;
          btn.disabled = true;
          btn.textContent = t('Загрузка…');
          try {
            const res = await api.installModrinthMod(hit.project_id, inst.id);
            const extra = res.added.length > 1 ? ` (${t('+ зависимости: {n}', { n: res.added.length - 1 })})` : '';
            toast(t('Установлен {name}', { name: hit.title }) + extra);
            modsUi.scanned = false;
            await loadMods();
            refreshInstanceCounts();
            renderAction();
          } catch (e) {
            btn.disabled = false;
            btn.textContent = t('Установить');
            toast(errText(e), 'error', 5000);
          }
        });
      }
    };
    renderAction();
    list.appendChild(row);
  });
}

// ================= GAME SETTINGS TRANSFER =================
const SYNC_MODES = [['always', t('Всегда')], ['ask', t('Спрашивать')], ['never', t('Никогда')]];

async function loadSyncCategories() {
  try {
    // labels are the Russian texts of options-sync.js, translated here
    state.syncCategories = (await api.getSyncCategories()).map(c => ({ ...c, label: t(c.label) }));
  } catch (e) {
    state.syncCategories = [];
  }
  renderSyncSettings();
}

function syncModes() {
  return state.settings.optionsSync || {};
}

function renderSyncSettings() {
  const rows = $('sync-rows');
  rows.innerHTML = '';
  state.syncCategories.forEach(cat => {
    const mode = syncModes()[cat.id] || 'ask';
    const row = document.createElement('div');
    row.className = 'setting';
    row.innerHTML = `
      <div class="setting-text"><div class="setting-label">${esc(cat.label)}</div></div>
      <div class="segmented">
        ${SYNC_MODES.map(([m, label]) => `<button data-mode="${m}" class="${m === mode ? 'active' : ''}">${label}</button>`).join('')}
      </div>
    `;
    row.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        row.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
        saveSettings({ optionsSync: { ...syncModes(), [cat.id]: btn.dataset.mode } });
      });
    });
    rows.appendChild(row);
  });
}

function profileName(id) {
  if (id === 'global') return t('Общая папка .minecraft');
  const inst = findInstance(id);
  return inst ? inst.name : id;
}

function pluralChanges(n) {
  return pluralize(n, ['изменение', 'изменения', 'изменений']);
}

/**
 * Shows the transfer dialog. Resolves with the chosen category ids, or null when skipped.
 * manual: lets the user pick the source profile.
 */
function syncDialog({ targetId, sourceId, diff, categories, manual }) {
  return new Promise(resolve => {
    const modal = $('modal-sync');
    const checks = $('sync-checks');
    const status = $('sync-status');
    const sourceSelect = $('select-sync-source');
    let currentSource = sourceId;
    let currentDiff = diff;

    $('sync-source-wrap').classList.toggle('hidden', !manual);
    $('sync-skip').textContent = manual ? t('Отмена') : t('Не переносить');
    status.textContent = '';

    const renderText = () => {
      $('sync-text').textContent = manual
        ? t('Настройки будут скопированы в «{name}».', { name: profileName(targetId) })
        : t('В «{source}» настройки игры менялись позже, чем в «{target}». Перенести их перед запуском?', { source: profileName(currentSource), target: profileName(targetId) });
    };

    const renderChecks = () => {
      checks.innerHTML = '';
      categories.forEach(cat => {
        const n = (currentDiff && currentDiff[cat.id]) || 0;
        const row = document.createElement('label');
        row.className = `sync-check ${n ? '' : 'off'}`;
        row.innerHTML = `
          <input type="checkbox" value="${cat.id}" ${n ? 'checked' : 'disabled'}>
          <span>${esc(cat.label)}</span>
          <span class="muted small">${n ? pluralChanges(n) : t('совпадает')}</span>
        `;
        checks.appendChild(row);
      });
    };

    if (manual) {
      sourceSelect.innerHTML = '';
      ['global', ...state.instances.map(i => i.id)].filter(id => id !== targetId).forEach(id => {
        const o = document.createElement('option');
        o.value = id;
        o.textContent = profileName(id);
        sourceSelect.appendChild(o);
      });
      if (currentSource) sourceSelect.value = currentSource;
      currentSource = sourceSelect.value;
      sourceSelect.onchange = async () => {
        currentSource = sourceSelect.value;
        currentDiff = (await api.checkOptionsSync(targetId, currentSource)).diff;
        renderChecks();
      };
    }

    renderText();
    renderChecks();
    modal.classList.remove('hidden');

    const finish = (result) => {
      modal.classList.add('hidden');
      $('sync-apply').onclick = $('sync-skip').onclick = $('sync-close').onclick = sourceSelect.onchange = null;
      resolve(result);
    };
    $('sync-skip').onclick = () => finish(null);
    $('sync-close').onclick = () => finish(null);
    $('sync-apply').onclick = () => {
      const chosen = [...checks.querySelectorAll('input:checked')].map(i => i.value);
      if (!chosen.length) {
        status.className = 'form-status error';
        status.textContent = t('Нечего переносить');
        return;
      }
      finish({ sourceId: currentSource, categories: chosen });
    };
  });
}

/** Called before launch: applies "always" categories and asks about "ask" ones. */
async function maybeSyncOptions(targetId) {
  const modes = syncModes();
  if (state.syncCategories.every(c => (modes[c.id] || 'ask') === 'never')) return;

  let check;
  try {
    check = await api.checkOptionsSync(targetId);
  } catch (e) {
    return;
  }
  if (!check.source) return;

  // Don't ask again about the same source state the user already decided on
  const seen = (state.settings.optionsSyncSeen || {})[targetId];
  if (seen && seen.sourceId === check.source.id && seen.time === check.source.time) return;

  const changed = (id) => (check.diff[id] || 0) > 0;
  const always = state.syncCategories.filter(c => (modes[c.id] || 'ask') === 'always' && changed(c.id)).map(c => c.id);
  const ask = state.syncCategories.filter(c => (modes[c.id] || 'ask') === 'ask' && changed(c.id));

  let chosen = [...always];
  if (ask.length) {
    const answer = await syncDialog({ targetId, sourceId: check.source.id, diff: check.diff, categories: ask, manual: false });
    if (answer) chosen.push(...answer.categories);
  }

  if (chosen.length) {
    try {
      const count = await api.applyOptionsSync(targetId, check.source.id, chosen);
      const labels = state.syncCategories.filter(c => chosen.includes(c.id)).map(c => c.label.toLowerCase());
      appendLog('info', `[LAUNCHER]: ${t('Перенесено из «{name}»: {what} ({n} параметров)', { name: check.source.name, what: labels.join(', '), n: count })}`);
      toast(t('Настройки перенесены из «{name}»', { name: check.source.name }));
    } catch (e) {
      toast(t('Не удалось перенести настройки: {error}', { error: errText(e) }), 'error');
    }
  }

  if (always.length || ask.length) {
    saveSettings({ optionsSyncSeen: { ...(state.settings.optionsSyncSeen || {}), [targetId]: { sourceId: check.source.id, time: check.source.time } } });
  }
}

async function openManualSync(targetId) {
  if (state.isGameRunning || state.isLaunching) {
    toast(t('Закройте игру перед переносом настроек'), 'error');
    return;
  }
  let check = { source: null, diff: {} };
  try {
    check = await api.checkOptionsSync(targetId);
  } catch (e) {}
  let sourceId = check.source ? check.source.id : null;
  let diff = check.diff;
  if (!sourceId) {
    sourceId = ['global', ...state.instances.map(i => i.id)].find(id => id !== targetId);
    if (!sourceId) return;
    diff = (await api.checkOptionsSync(targetId, sourceId)).diff;
  }

  const answer = await syncDialog({ targetId, sourceId, diff, categories: state.syncCategories, manual: true });
  if (!answer) return;
  try {
    const count = await api.applyOptionsSync(targetId, answer.sourceId, answer.categories);
    toast(count ? t('Перенесено параметров: {n}', { n: count }) : t('Настройки уже совпадают'));
  } catch (e) {
    toast(errText(e), 'error');
  }
}

// ================= HOME / LAUNCH =================
function setupHome() {
  $('btn-launch').addEventListener('click', async (e) => {
    // while the game runs the same button closes it
    if (!e.currentTarget.classList.contains('running')) return handleLaunch();
    const ok = await dialog({ title: t('Закрыть игру?'), text: t('Процесс Minecraft будет завершён принудительно. Несохранённый прогресс может потеряться.'), okText: t('Закрыть'), danger: true });
    if (ok) api.killGame();
  });
}

function setLaunchUi(mode, text) {
  const btn = $('btn-launch');
  btn.classList.toggle('btn-launch-loading', mode === 'launching');
  btn.classList.toggle('running', mode === 'running');
  btn.disabled = mode === 'launching';
  $('btn-launch-icon').setAttribute('href', mode === 'running' ? '#i-stop' : '#i-play');
  $('btn-launch-text').textContent = text || (mode === 'idle' ? t('Играть') : mode === 'running' ? t('Закрыть игру') : t('Запуск…'));
  $('progress').classList.toggle('active', mode === 'launching');
}

function setProgress(percent, text) {
  const fill = $('progress-fill');
  if (percent === null) {
    fill.classList.add('indeterminate');
    $('progress-percent').textContent = '';
  } else {
    fill.classList.remove('indeterminate');
    fill.style.width = `${percent}%`;
    $('progress-percent').textContent = `${percent}%`;
  }
  if (text) $('progress-text').textContent = text;
}

async function handleLaunch() {
  if (state.isLaunching || state.isGameRunning || !state.selected) return;

  state.isLaunching = true;
  setLaunchUi('launching');
  setProgress(null, t('Проверка файлов…'));

  const inst = findInstance(state.selected);
  setProgress(null, t('Проверка настроек…'));
  await maybeSyncOptions(inst ? inst.id : 'global');
  setProgress(null, t('Проверка файлов…'));

  appendLog('info', `[LAUNCHER]: ${inst ? t('Запуск сборки «{name}»', { name: inst.name }) : t('Запуск {version}', { version: state.selected })}`);

  const result = await api.launchGame(inst ? { instanceId: inst.id } : { version: state.selected })
    .catch(e => ({ success: false, error: errText(e) }));

  state.isLaunching = false;
  if (!result.success) {
    setLaunchUi('idle');
    appendLog('error', `[LAUNCHER]: ${result.error}`);
    toast(result.error, 'error', 7000);
  }
}

const PROGRESS_LABELS = {
  assets: t('Загрузка ресурсов'),
  'assets-copy': t('Копирование ресурсов'),
  classes: t('Загрузка библиотек'),
  'classes-custom': t('Загрузка библиотек загрузчика'),
  'classes-maven-custom': t('Загрузка библиотек загрузчика'),
  natives: t('Распаковка нативных библиотек'),
  'version-jar': t('Загрузка Minecraft')
};

// after a reload the window starts fresh, but the game may still be running
async function restoreGameState() {
  const game = await api.getGameState().catch(() => null);
  if (!game) return;
  if (game.running) {
    state.isGameRunning = true;
    state.runningInstanceId = game.instanceId || null;
    setLaunchUi('running');
    if (state.instances.length) renderAll(); // otherwise the builds are drawn once they load
  } else if (game.launching && !state.isLaunching) {
    // the launch call belongs to the old page, so its result arrives only as events
    state.isLaunching = true;
    state.restoredLaunch = true;
    setLaunchUi('launching');
    setProgress(null, t('Запуск…'));
  }
}

function setupSubscriptions() {
  api.onLaunchError((message) => {
    if (!state.restoredLaunch) return; // handleLaunch reports its own errors
    state.restoredLaunch = false;
    state.isLaunching = false;
    setLaunchUi('idle');
    appendLog('error', `[LAUNCHER]: ${message}`);
    toast(message, 'error', 7000);
  });

  api.onLaunchProgress((data) => {
    if (!state.isLaunching) return;
    const label = PROGRESS_LABELS[data.type] || (data.name ? t('Загрузка {name}', { name: data.name }) : t('Загрузка…'));
    if (data.total > 1) setProgress(data.percent, label);
    else setProgress(null, label);
  });


  api.onGameLaunched((instanceId) => {
    state.isLaunching = false;
    state.restoredLaunch = false;
    state.isGameRunning = true;
    state.runningInstanceId = instanceId || null;
    setLaunchUi('running');
    refreshInstanceCounts(); // launch time was just recorded
  });

  api.onGameClosed((code) => {
    state.isLaunching = false;
    state.isGameRunning = false;
    state.runningInstanceId = null;
    setLaunchUi('idle');
    if (code && code !== 0) {
      toast(t('Игра завершилась с ошибкой (код {code}). Подробности в консоли.', { code }), 'error', 6000);
      $('log-indicator').classList.add('active', 'error');
    }
    refreshInstanceCounts().then(renderAll);
    loadWeekStats();
    state.screenshots = null; // new screenshots may have been taken
    if ($('page-screenshots').classList.contains('active')) loadScreenshots();
  });
}

// ================= SCREENSHOTS =================
function visibleShots() {
  const all = state.screenshots || [];
  if (state.shotsFilter === 'all') return all;
  return all.filter(s => (s.instanceId || 'global') === state.shotsFilter);
}

function shotsSignature(list) {
  return (list || []).map(s => `${s.path}|${s.time}`).join('|');
}

/** Reads the folders again; the grid is redrawn only when something actually changed. */
async function loadScreenshots(force = false) {
  if (state.screenshots && !force) return renderScreenshots();
  if (!state.screenshots) $('shots-list').innerHTML = `<div class="empty"><p>${t('Ищу скриншоты…')}</p></div>`;
  const before = state.screenshots;
  const viewed = currentShot();
  let list;
  try {
    list = await api.listScreenshots();
  } catch (e) {
    list = [];
    toast(t('Не удалось прочитать скриншоты: {error}', { error: errText(e) }), 'error');
  }
  if (before && shotsSignature(before) === shotsSignature(list)) return;
  state.screenshots = list;
  renderScreenshots();
  // keep the viewer on the same picture even if new ones were added before it
  if (viewed) {
    const index = visibleShots().findIndex(s => s.path === viewed.path);
    openViewer(index >= 0 ? index : state.viewerIndex);
  }
}

function renderShotsFilter() {
  const counts = new Map();
  for (const s of state.screenshots || []) {
    const key = s.instanceId || 'global';
    const entry = counts.get(key) || { name: s.instanceName, count: 0 };
    entry.count++;
    counts.set(key, entry);
  }
  if (state.shotsFilter !== 'all' && !counts.has(state.shotsFilter)) state.shotsFilter = 'all';
  const options = [`<option value="all">${t('Все сборки')}</option>`]
    .concat([...counts].map(([key, e]) => `<option value="${esc(key)}">${esc(e.name)} (${e.count})</option>`));
  $('shots-filter').innerHTML = options.join('');
  $('shots-filter').value = state.shotsFilter;
  $('shots-filter').disabled = counts.size < 2;
}

function shotDayLabel(ts) {
  const date = new Date(ts);
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (ts >= start) return t('Сегодня');
  if (ts >= start - 86400000) return t('Вчера');
  const opts = date.getFullYear() === today.getFullYear() ? { day: 'numeric', month: 'long' } : { day: 'numeric', month: 'long', year: 'numeric' };
  return date.toLocaleDateString(i18n.locale(), opts).replace(/\s?г\.$/, '');
}

function shotTime(ts) {
  return new Date(ts).toLocaleTimeString(i18n.locale(), { hour: '2-digit', minute: '2-digit' });
}

function renderScreenshots() {
  renderShotsFilter();
  const shots = visibleShots();
  $('shots-count').textContent = shots.length ? shots.length : '';
  const list = $('shots-list');
  if (!shots.length) {
    list.innerHTML = `
      <div class="empty">
        <h3>${t('Скриншотов пока нет')}</h3>
        <p>${t('Нажмите F2 в игре — снимок появится здесь. Сюда собираются скриншоты из всех сборок.')}</p>
      </div>`;
    return;
  }
  // grouped by day, newest first
  let html = '';
  let day = null;
  shots.forEach((s, i) => {
    const label = shotDayLabel(s.time);
    if (label !== day) {
      if (day !== null) html += '</div>';
      html += `<h2 class="shots-day">${esc(label)}</h2><div class="shots-grid">`;
      day = label;
    }
    html += `
      <button class="shot" data-index="${i}" title="${esc(s.name)}">
        <img src="${esc(s.url)}" alt="" loading="lazy" decoding="async">
        <span class="shot-cap"><span>${esc(s.instanceName)}</span><span>${shotTime(s.time)}</span></span>
      </button>`;
  });
  list.innerHTML = html + '</div>';
}

function openViewer(index) {
  const shots = visibleShots();
  if (!shots.length) return closeViewer();
  state.viewerIndex = Math.max(0, Math.min(index, shots.length - 1));
  const s = shots[state.viewerIndex];
  $('viewer-img').src = s.url;
  $('viewer-name').textContent = s.name;
  $('viewer-sub').textContent = `${s.instanceName} · ${shotDayLabel(s.time)}, ${shotTime(s.time)} · ${formatSize(s.size)} · ${t('{n} из {total}', { n: state.viewerIndex + 1, total: shots.length })}`;
  $('viewer-prev').disabled = state.viewerIndex === 0;
  $('viewer-next').disabled = state.viewerIndex === shots.length - 1;
  $('viewer').classList.remove('hidden');
}

function closeViewer() {
  $('viewer').classList.add('hidden');
  $('viewer-img').removeAttribute('src');
  state.viewerIndex = -1;
}

function currentShot() {
  return state.viewerIndex >= 0 ? visibleShots()[state.viewerIndex] : null;
}

async function deleteCurrentShot() {
  const shot = currentShot();
  if (!shot) return;
  try {
    await api.deleteScreenshot(shot.path);
  } catch (e) {
    return toast(t('Не удалось удалить: {error}', { error: errText(e) }), 'error');
  }
  state.screenshots = state.screenshots.filter(s => s.path !== shot.path);
  toast(t('Скриншот перемещён в корзину'));
  renderScreenshots();
  openViewer(state.viewerIndex);
}

function setupScreenshots() {
  $('shots-filter').addEventListener('change', (e) => {
    state.shotsFilter = e.target.value;
    renderScreenshots();
  });
  // new screenshots (F2 in the game) and files deleted in Explorer show up by themselves
  api.onScreenshotsChanged(() => {
    if ($('page-screenshots').classList.contains('active')) loadScreenshots(true);
    else state.screenshots = null;
  });
  $('shots-list').addEventListener('click', (e) => {
    const shot = e.target.closest('.shot');
    if (shot) openViewer(Number(shot.dataset.index));
  });

  $('viewer-close').addEventListener('click', closeViewer);
  $('viewer-prev').addEventListener('click', () => openViewer(state.viewerIndex - 1));
  $('viewer-next').addEventListener('click', () => openViewer(state.viewerIndex + 1));
  $('viewer-reveal').addEventListener('click', () => currentShot() && api.revealScreenshot(currentShot().path));
  $('viewer-copy').addEventListener('click', async () => {
    try {
      await api.copyScreenshot(currentShot().path);
      toast(t('Картинка скопирована'));
    } catch (e) {
      toast(t('Не удалось скопировать: {error}', { error: errText(e) }), 'error');
    }
  });
  $('viewer-delete').addEventListener('click', deleteCurrentShot);
  // a click on the dark backdrop closes the viewer
  document.querySelector('.viewer-stage').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeViewer();
  });
  document.addEventListener('keydown', (e) => {
    if ($('viewer').classList.contains('hidden')) return;
    if (e.key === 'Escape') closeViewer();
    else if (e.key === 'ArrowLeft') openViewer(state.viewerIndex - 1);
    else if (e.key === 'ArrowRight') openViewer(state.viewerIndex + 1);
    else if (e.key === 'Delete') deleteCurrentShot();
    else if (e.key === 'c' && e.ctrlKey) $('viewer-copy').click();
  });
}

// ================= LOGS =================
let logView;

function setupLogs() {
  logView = createLogView($('logs'));
  $('check-show-debug').addEventListener('change', (e) => logView.setShowDebug(e.target.checked));
  $('btn-clear-logs').addEventListener('click', () => api.clearLogs());
  $('btn-copy-logs').addEventListener('click', () => {
    navigator.clipboard.writeText(logView.text());
    toast(t('Логи скопированы'));
  });
  $('btn-detach-console').addEventListener('click', () => api.openConsoleWindow());

  // Lines come back from the main process, which also feeds the detached console window
  api.onLaunchLog((entry) => showLogLine(entry.type, entry.message));
  api.onLogsCleared(() => logView.clear());
  api.onConsoleWindow((open) => {
    $('btn-detach-console').disabled = open;
    if (open && $('page-logs').classList.contains('active')) showPage('home');
  });
}

function scrollLogsToBottom() {
  if (logView) logView.scrollToBottom();
}

/** Sends a launcher message to the console (main window and detached window). */
function appendLog(type, message) {
  api.writeLog(type, message);
}

function showLogLine(type, message) {
  const level = logView.append(type, message);
  const consoleVisible = state.settings.showConsole !== false;
  if (consoleVisible && !$('page-logs').classList.contains('active') && level !== 'debug' && level !== 'stdout') {
    $('log-indicator').classList.add('active');
    if (level === 'error') $('log-indicator').classList.add('error');
  }
}

function applyConsoleVisibility() {
  const show = state.settings.showConsole !== false;
  document.querySelector('.nav-item[data-tab="logs"]').classList.toggle('hidden', !show);
  if (!show && $('page-logs').classList.contains('active')) showPage('home');
}
