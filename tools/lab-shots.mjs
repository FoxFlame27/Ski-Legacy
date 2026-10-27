// Screenshots of a dev lab page (tools/*lab.html exposing window.__lab = { ready, view(name), setHour(h) }).
// ONE browser at a time (8 GB machine).   node tools/lab-shots.mjs <outDir> <page.html> view[:hour] ...
import puppeteer from 'puppeteer-core';
import { acquireChromeLock } from './chrome-lock.mjs';
import fs from 'node:fs';
const [out, pageName, ...specs] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
await acquireChromeLock(process.argv[1].split('/').pop());
const browser = await puppeteer.launch({
  executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  headless: 'new',
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--window-size=1600,900'],
  defaultViewport: { width: 1600, height: 900 },
});
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[${m.type()}] ${m.text().slice(0, 400)}`); });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
const PORT = process.env.PORT || (await fetch('http://localhost:5174/').then((r) => (r.ok ? 5174 : 5173)).catch(() => 5173));
await page.goto(`http://localhost:${PORT}/tools/${pageName}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__lab && window.__lab.ready, { timeout: 120000, polling: 250 });
for (const spec of specs) {
  const [view, hour] = spec.split(':');
  await page.evaluate((v, h) => { if (h) window.__lab.setHour(+h); window.__lab.view(v); }, view, hour);
  await new Promise((r) => setTimeout(r, 700));
  await page.screenshot({ path: `${out}/${view}${hour ? '_' + hour : ''}.jpg`, quality: 85 });
}
await browser.close();
