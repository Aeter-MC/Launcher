/**
 * build-splash.js — `npm run splash` (also runs before `npm run build`)
 * Builds installer/build/splash.exe: the animated window AeterMC-Setup.exe shows while it unpacks the app
 * (a few seconds before the installer window appears). Source: splash/Splash.cs, filled in
 * with the default theme's colors (src/themes.json) and the logo from assets/logo.svg, compiled by the C# compiler
 * that comes with Windows. `--theme=<id>` picks another theme.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const THEME = process.argv.find(a => a.startsWith('--theme='))?.slice(8) || 'dark-mono';
const CSC = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const OUT = path.join(__dirname, 'build', 'splash.exe');

const themes = JSON.parse(fs.readFileSync(path.join(root, 'src', 'themes.json'), 'utf-8'));
const theme = themes.find(t => t.id === THEME) || themes[0];

// logo.svg: <g fill-opacity="…"> groups of <polygon points="x,y …">
const svg = fs.readFileSync(path.join(root, 'assets', 'logo.svg'), 'utf-8');
const opacity = [];
const polygons = [];
for (const g of svg.matchAll(/<g[^>]*fill-opacity="([\d.]+)"[^>]*>([\s\S]*?)<\/g>/g)) {
  for (const p of g[2].matchAll(/points="([^"]+)"/g)) {
    opacity.push(g[1] + 'f');
    polygons.push(`new[] { ${p[1].trim().split(/[\s,]+/).join(', ')} }`);
  }
}
if (!polygons.length) throw new Error('assets/logo.svg: no polygons found');

const source = fs.readFileSync(path.join(__dirname, 'splash', 'Splash.cs'), 'utf-8')
  .replace('/*@BG@*/', theme.preview.bg)
  .replace('/*@LINE@*/', theme.preview.line)
  .replace('/*@TEXT@*/', theme.preview.text)
  .replace('/*@MUTED@*/', theme.preview.muted)
  .replace('/*@ACCENT@*/', theme.preview.accent)
  .replace('/*@INSTALLER_TITLE@*/', 'Установка AeterMC')
  .replace('/*@LOGO_OPACITY@*/', opacity.join(', '))
  .replace('/*@LOGO_POLYGONS@*/', polygons.join(',\n        '));

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const tmp = path.join(path.dirname(OUT), 'splash.generated.cs');
fs.writeFileSync(tmp, '\ufeff' + source.replace(/^\ufeff/, ''), 'utf-8');
try {
  execFileSync(CSC, [
    '/nologo', '/optimize+', '/target:winexe', '/codepage:65001',
    '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll',
    `/out:${OUT}`, tmp
  ], { stdio: 'inherit' });
} finally {
  fs.unlinkSync(tmp);
}
console.log(`installer/build/splash.exe: ${theme.id}, ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`);
