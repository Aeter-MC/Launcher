/**
 * log-view.js
 * Console output list shared by the main window and the detached console window.
 */
const MAX_LOG_LINES = 4000;

function classifyLog(type, message) {
  let level = type || 'stdout';
  if (level === 'stdout' && /\b(ERROR|FATAL|Exception)\b/.test(message)) level = 'error';
  else if (level === 'stdout' && /\bWARN\b/.test(message)) level = 'warn';
  return level;
}

function createLogView(container) {
  container.classList.add('hide-debug');

  return {
    /** Adds a line, keeps the view pinned to the bottom if it already was. Returns the level. */
    append(type, message) {
      const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 60;
      const level = classifyLog(type, message);
      const line = document.createElement('div');
      line.className = `log-line log-${level}`;
      line.textContent = message;
      container.appendChild(line);
      while (container.children.length > MAX_LOG_LINES) container.firstChild.remove();
      if (nearBottom) container.scrollTop = container.scrollHeight;
      return level;
    },
    clear() {
      container.innerHTML = '';
    },
    setShowDebug(show) {
      container.classList.toggle('hide-debug', !show);
      this.scrollToBottom();
    },
    scrollToBottom() {
      container.scrollTop = container.scrollHeight;
    },
    /** Visible text, without hidden debug lines. */
    text() {
      const hideDebug = container.classList.contains('hide-debug');
      return [...container.children]
        .filter(l => !hideDebug || !l.classList.contains('log-debug'))
        .map(l => l.textContent)
        .join('\n');
    }
  };
}
