/**
 * i18n.js
 * The launcher is written in Russian; another language is a dictionary keyed by the Russian text
 * (en.js). t('Доступна версия {version}', { version }) looks the text up and fills in the {names};
 * a text missing from the dictionary stays Russian (`npm run i18n` lists them).
 * The main process requires this file; the pages load it with <script> before their own scripts
 * and get the language from the URL (?lang=en), like the theme. Changing the language reloads them.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./en'));
  else root.i18n = factory(root.I18N_EN);
})(this, function (EN) {
  const DICTIONARIES = { en: EN };
  const LOCALES = { ru: 'ru-RU', en: 'en-US' };
  const CYRILLIC = /[А-Яа-яЁё]/;
  let language = 'ru';
  let dict = null;

  function setLanguage(lang) {
    language = DICTIONARIES[lang] ? lang : 'ru';
    dict = DICTIONARIES[language] || null;
    if (typeof document !== 'undefined') document.documentElement.lang = language;
  }

  /** The language for a new launcher: Russian for the CIS languages of the system, English otherwise. */
  function detectLanguage(systemLanguages) {
    const first = String((systemLanguages || [])[0] || '').toLowerCase();
    return /^(ru|be|kk|ky|uz|tg)\b/.test(first) || !first ? 'ru' : 'en';
  }

  function lookup(text) {
    return dict && Object.prototype.hasOwnProperty.call(dict, text) ? dict[text] : text;
  }

  function t(text, vars) {
    const out = lookup(text);
    return vars ? out.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? vars[name] : m)) : out;
  }

  /** "12 модов": forms are the Russian ones for 1, 2 and 5; the dictionary has "мод|мода|модов": "mod|mods". */
  function plural(n, forms) {
    const other = lookup(forms.join('|'));
    if (other !== forms.join('|')) {
      const [one, many] = other.split('|');
      return `${n} ${n === 1 ? one : many}`;
    }
    const m10 = n % 10, m100 = n % 100;
    const word = m10 === 1 && m100 !== 11 ? forms[0] : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? forms[1] : forms[2];
    return `${n} ${word}`;
  }

  /**
   * Translates the Russian text nodes and title / placeholder / aria-label attributes of a page's
   * markup; translate="no" keeps an element as it is (the language names in the settings).
   */
  function translateDom(rootEl) {
    if (!dict) return;
    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.nodeValue;
      if (!CYRILLIC.test(text) || node.parentElement.closest('[translate="no"]')) continue;
      const key = text.replace(/\s+/g, ' ').trim();
      const out = lookup(key);
      if (out !== key) node.nodeValue = text.match(/^\s*/)[0] + out + text.match(/\s*$/)[0];
    }
    for (const el of rootEl.querySelectorAll('[title], [placeholder], [aria-label]')) {
      for (const attr of ['title', 'placeholder', 'aria-label']) {
        const value = el.getAttribute(attr);
        if (value && CYRILLIC.test(value)) el.setAttribute(attr, lookup(value));
      }
    }
  }

  if (typeof location !== 'undefined') setLanguage(new URLSearchParams(location.search).get('lang'));

  return {
    t,
    plural,
    setLanguage,
    detectLanguage,
    translateDom,
    language: () => language,
    locale: () => LOCALES[language]
  };
});
