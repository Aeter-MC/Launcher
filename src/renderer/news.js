const NEWS_URL = 'https://aeter.waruk.xyz/news.json';
const NEWS_CACHE_KEY = 'aetermc-news-cache-v1';
const NEWS_CACHE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
let newsPreviewTrigger = null;
let newsReleaseTag = '';
let newsReleaseRequest = 0;

function newsItems(payload) {
  const items = Array.isArray(payload) ? payload : payload?.items;
  if (!Array.isArray(items)) throw new Error('Invalid news feed');
  return items.slice(0, 40).flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const field = (name, limit) => typeof item[name] === 'string' ? item[name].trim().slice(0, limit) : '';
    const title = field('title', 180);
    const titleEn = field('titleEn', 180);
    if (!title && !titleEn) return [];
    const date = field('date', 60);
    const dateEn = field('dateEn', 60);
    const rawUrl = field('url', 2048);
    let url = '';
    let releaseTag = '';
    try {
      const parsed = new URL(rawUrl);
      if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password) {
        url = parsed.href;
        if (parsed.origin === 'https://github.com') {
          const match = /^\/aeter-mc\/launcher\/releases\/tag\/([^/]+)\/?$/i.exec(parsed.pathname);
          const tag = match ? decodeURIComponent(match[1]) : '';
          if (/^v\d[\w.+-]{0,63}$/.test(tag)) releaseTag = tag;
        }
      }
    } catch {}
    return [{ title, titleEn, date, dateEn, text: field('text', 16000), textEn: field('textEn', 16000), url, releaseTag }];
  });
}

function localNews(item, field) {
  return i18n.language() === 'en' ? item[`${field}En`] || item[field] : item[field] || item[`${field}En`];
}

function displayNewsDate(el, date) {
  const parsed = new Date(date);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(parsed.getTime()) && parsed.toISOString().startsWith(date);
  el.hidden = !date;
  if (!valid) {
    el.removeAttribute('datetime');
    el.textContent = date;
    return;
  }
  el.dateTime = date;
  el.textContent = new Intl.DateTimeFormat(i18n.language(), { dateStyle: 'medium', timeZone: 'UTC' }).format(parsed);
}

function openNewsPreview(item, trigger) {
  newsPreviewTrigger = trigger;
  newsReleaseTag = item.releaseTag;
  newsReleaseRequest++;
  $('news-preview-title').textContent = localNews(item, 'title');
  $('news-preview-text').textContent = localNews(item, 'text');
  displayNewsDate($('news-preview-date'), localNews(item, 'date'));
  const link = $('news-preview-link');
  link.classList.toggle('hidden', !item.url);
  if (item.url) link.href = item.url;
  else link.removeAttribute('href');
  $('news-release').classList.toggle('hidden', !newsReleaseTag);
  if (newsReleaseTag) {
    $('news-release-heading').textContent = t('Изменения в версии {version}', { version: newsReleaseTag.slice(1) });
    loadNewsRelease();
  }
  openModal('modal-news');
  $('news-preview-body').scrollTop = 0;
  $('news-preview-close').focus();
}

function closeNewsPreview() {
  newsReleaseTag = '';
  newsReleaseRequest++;
  $('modal-news').classList.add('hidden');
  (newsPreviewTrigger?.isConnected ? newsPreviewTrigger : $('launcher-news').querySelector('.news-item'))?.focus();
  newsPreviewTrigger = null;
}

async function loadNewsRelease() {
  if (!newsReleaseTag) return;
  const request = ++newsReleaseRequest;
  const status = $('news-release-status');
  const notes = $('news-release-notes');
  const retry = $('news-release-retry');
  if (document.activeElement === retry) $('news-preview-close').focus();
  retry.classList.add('hidden');
  notes.replaceChildren();
  status.textContent = t('Загружаем список изменений…');
  try {
    const markdown = await api.getReleaseNotes(newsReleaseTag);
    if (request !== newsReleaseRequest) return;
    const html = releaseNotesHtml(markdown);
    notes.innerHTML = html;
    status.textContent = html ? '' : t('Без описания');
  } catch {
    if (request !== newsReleaseRequest) return;
    status.textContent = t('Не удалось загрузить список изменений');
    retry.classList.remove('hidden');
  }
}

function setupNewsPreview() {
  $('news-preview-close').addEventListener('click', closeNewsPreview);
  $('news-release-retry').addEventListener('click', loadNewsRelease);
  $('modal-news').addEventListener('keydown', e => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const controls = ['news-preview-close', 'news-release-retry', 'news-preview-link'].map($)
      .filter(el => !el.closest('.hidden'));
    const index = controls.indexOf(document.activeElement);
    const next = index < 0 ? (e.shiftKey ? controls.length - 1 : 0)
      : (index + (e.shiftKey ? -1 : 1) + controls.length) % controls.length;
    controls[next].focus();
  });
}

function renderLauncherNews(items) {
  if (!items.length) {
    renderNewsStatus(t('Пока нет новостей'));
    return;
  }
  const box = $('launcher-news');
  box.className = 'news-list';
  box.removeAttribute('aria-busy');
  box.replaceChildren(...items.slice(0, 3).map(item => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'news-item';
    button.setAttribute('aria-haspopup', 'dialog');
    button.innerHTML = `<span class="news-copy"><time></time><strong></strong><span class="news-summary"></span></span>${icon('chevron', 'ic-sm')}`;
    displayNewsDate(button.querySelector('time'), localNews(item, 'date'));
    button.querySelector('strong').textContent = localNews(item, 'title');
    button.querySelector('.news-summary').textContent = localNews(item, 'text');
    button.addEventListener('click', () => openNewsPreview(item, button));
    return button;
  }));
}

function renderNewsStatus(message, retry = false) {
  const box = $('launcher-news');
  box.className = 'news-empty';
  box.removeAttribute('aria-busy');
  const status = document.createElement('span');
  status.textContent = message;
  box.replaceChildren(status);
  if (retry) {
    const button = document.createElement('button');
    button.className = 'btn btn-secondary btn-sm';
    button.textContent = t('Повторить');
    button.addEventListener('click', loadLauncherNews);
    box.append(button);
  }
}

async function loadLauncherNews() {
  const box = $('launcher-news');
  if (box.hasAttribute('aria-busy')) return;
  let cached = null;
  try {
    const value = JSON.parse(localStorage.getItem(NEWS_CACHE_KEY));
    if (value && Date.now() - value.savedAt < NEWS_CACHE_MAX_AGE) cached = newsItems(value.items);
  } catch {}
  if (cached !== null) renderLauncherNews(cached);
  else renderNewsStatus(t('Загрузка новостей…'));
  box.setAttribute('aria-busy', 'true');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const items = api.previewNews ? newsItems(await api.previewNews()) : await (async () => {
      const response = await fetch(NEWS_URL, { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw new Error(`news http ${response.status}`);
      return newsItems(await response.json());
    })();
    if (!api.previewNews) {
      try { localStorage.setItem(NEWS_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), items })); } catch {}
    }
    renderLauncherNews(items);
  } catch {
    if (cached === null) renderNewsStatus(t('Не удалось подключиться к серверу новостей'), true);
  } finally {
    clearTimeout(timer);
    box.removeAttribute('aria-busy');
  }
}
