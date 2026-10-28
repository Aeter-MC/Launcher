/**
 * console.js
 * Detached console window: shows the launcher/game log history and new lines live.
 */
i18n.translateDom(document.documentElement);

document.addEventListener('DOMContentLoaded', async () => {
  const view = createLogView(document.getElementById('logs'));
  api.onThemeChanged((id) => { document.documentElement.dataset.theme = id; });
  api.getSettings().then((s) => { if (s.theme) document.documentElement.dataset.theme = s.theme; });

  for (const entry of await api.getLogBuffer()) view.append(entry.type, entry.message);
  view.scrollToBottom();

  api.onLaunchLog((entry) => view.append(entry.type, entry.message));
  api.onLogsCleared(() => view.clear());

  document.getElementById('check-show-debug').addEventListener('change', (e) => view.setShowDebug(e.target.checked));
  document.getElementById('check-on-top').addEventListener('change', (e) => api.setConsoleOnTop(e.target.checked));
  document.getElementById('btn-clear-logs').addEventListener('click', () => api.clearLogs());

  const copyBtn = document.getElementById('btn-copy-logs');
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(view.text());
    const label = copyBtn.lastChild;
    label.textContent = i18n.t('Скопировано');
    setTimeout(() => { label.textContent = i18n.t('Копировать'); }, 1200);
  });
});
