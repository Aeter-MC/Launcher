/**
 * render-icon.js — `npm run icon`
 * Renders assets/logo.svg (monotone) into assets/icon.png (256×256, transparent) in the accent of the
 * default theme. That PNG is the .exe / installer icon; inside the app the icon follows the chosen theme.
 */
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const root = path.join(__dirname, '..');
const THEME = process.argv.find(a => a.startsWith('--theme='))?.slice(8) || 'dark-mono';

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const themes = JSON.parse(fs.readFileSync(path.join(root, 'src', 'themes.json'), 'utf-8'));
  const theme = themes.find(t => t.id === THEME) || themes[0];
  const color = theme.preview.accent;
  const svg = fs.readFileSync(path.join(root, 'assets', 'logo.svg'), 'utf-8')
    .replace(/fill="currentColor"/, `fill="${color}"`)
    .replace(/width="[^"]*" height="[^"]*"/, 'width="256" height="256"');

  const win = new BrowserWindow({ show: false, width: 256, height: 256, transparent: true, frame: false, webPreferences: { offscreen: true } });
  const html = `<html><body style="margin:0;background:transparent">${svg}</body></html>`;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  win.setContentSize(256, 256);
  await new Promise(r => setTimeout(r, 400));
  const image = (await win.webContents.capturePage({ x: 0, y: 0, width: 256, height: 256 })).resize({ width: 256, height: 256 });
  fs.writeFileSync(path.join(root, 'assets', 'icon.png'), image.toPNG());
  console.log(`assets/icon.png: ${color} (${theme.id})`);
  app.exit(0);
});
