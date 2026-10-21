/**
 * theme-init.js
 * Runs before the page paints: applies the theme the main process passed in the URL
 * (?theme=dark-mono), so the window never flashes the default colors.
 */
(function () {
  const theme = new URLSearchParams(location.search).get('theme');
  if (theme) document.documentElement.dataset.theme = theme;
})();
