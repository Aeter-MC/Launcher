/**
 * theme-init.js
 * runs before the page paints: applies the theme the main process passed in the URL
 * (?theme=dark-mono), so the window never flashes the default colors.
 */
(function () {
  const params = new URLSearchParams(location.search);
  const theme = params.get('theme');
  if (params.get('nativeTitlebar') === 'true') document.documentElement.dataset.nativeTitlebar = '';
  if (theme) document.documentElement.dataset.theme = theme;
})();
