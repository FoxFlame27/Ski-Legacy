// Renders tools/icon.html to a 1024px PNG and builds build/icon.icns (macOS app icon).
import puppeteer from 'puppeteer-core';
import { acquireChromeLock } from './chrome-lock.mjs';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
await acquireChromeLock(process.argv[1].split('/').pop());
const browser = await puppeteer.launch({ executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: 'new' });
const page = await browser.newPage();
await page.setViewport({ width: 1024, height: 1024 });
await page.goto('file://' + new URL('./icon.html', import.meta.url).pathname);
await page.screenshot({ path: 'build/icon.png', omitBackground: true });
await browser.close();
fs.rmSync('build/icon.iconset', { recursive: true, force: true });
fs.mkdirSync('build/icon.iconset');
for (const s of [16, 32, 64, 128, 256, 512]) {
  execSync(`sips -z ${s} ${s} build/icon.png --out build/icon.iconset/icon_${s}x${s}.png`);
  execSync(`sips -z ${s * 2} ${s * 2} build/icon.png --out build/icon.iconset/icon_${s}x${s}@2x.png`);
}
execSync('iconutil -c icns build/icon.iconset -o build/icon.icns');
console.log('icon done');
