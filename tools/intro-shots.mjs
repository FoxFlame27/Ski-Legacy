// Dev helper: screenshots the boot intro + menu at fixed times after launch.
// Usage: node tools/intro-shots.mjs <outDir> [ms,ms,...]
import puppeteer from 'puppeteer-core';
import { acquireChromeLock } from './chrome-lock.mjs';
import fs from 'node:fs';
const out = process.argv[2] || './intro-shots';
const times = (process.argv[3] || '300,900,1500,1700,1900,2600,3800,4600,5600,6800,7600,9000,14000').split(',').map(Number);
fs.mkdirSync(out, { recursive: true });
await acquireChromeLock(process.argv[1].split('/').pop());
const browser = await puppeteer.launch({
  executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: 'new',
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
  defaultViewport: { width: 1600, height: 900 },
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) errs.push(m.text()); });
await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
const t0 = Date.now();
for (const t of times) {
  const w = t - (Date.now() - t0);
  if (w > 0) await new Promise((r) => setTimeout(r, w));
  await page.screenshot({ path: `${out}/t${String(t).padStart(5, '0')}.jpg`, quality: 80 });
}
console.log('errors', JSON.stringify(errs.slice(0, 8)));
await browser.close();
