// Screenshots of the look-dev sandbox. ONE Chrome at a time (8 GB machine).
//   node tools/lookdev-shots.mjs <outDir> "view:hour:weather" ["view:hour:weather" ...]
//   e.g. node tools/lookdev-shots.mjs /tmp/look village:10.5:clear sun:15.5:clear summit:11:cloudy
import puppeteer from 'puppeteer-core';
import { acquireChromeLock } from './chrome-lock.mjs';
import fs from 'node:fs';
const [out, ...specs] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
await acquireChromeLock(process.argv[1].split('/').pop());
const browser = await puppeteer.launch({
  executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  headless: 'new',
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--window-size=1600,900'],
  defaultViewport: { width: 1600, height: 900 },
});
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[${m.type()}] ${m.text().slice(0, 300)}`); });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
const [v0, h0, w0] = (specs[0] || 'village:10.5:clear').split(':');
const t0 = Date.now();
await page.goto(`http://localhost:5173/tools/lookdev.html?view=${v0}&hour=${h0}&weather=${w0}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__look && window.__look.ready, { timeout: 240000, polling: 250 });
console.log('loaded in', ((Date.now() - t0) / 1000).toFixed(1), 's');
for (const spec of specs.length ? specs : ['village:10.5:clear']) {
  const [view, hour, weather] = spec.split(':');
  await page.evaluate(async (v, h, w) => {
    const L = window.__look;
    L.setWeather(w || 'clear');
    L.setHour(+(h || 10.5));
    await L.setView(v);
  }, view, hour, weather);
  await new Promise((r) => setTimeout(r, 1800));
  const file = `${out}/${view}_${String(hour).replace('.', '-')}_${weather || 'clear'}.jpg`;
  await page.screenshot({ path: file, quality: 88 });
  console.log('shot', file);
}
const fps = await page.evaluate(() => new Promise((res) => { let n = 0; const t = performance.now(); const f = () => { n++; if (performance.now() - t < 2000) requestAnimationFrame(f); else res(n / 2); }; requestAnimationFrame(f); }));
console.log('fps', fps);
await browser.close();
