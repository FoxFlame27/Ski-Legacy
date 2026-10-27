// Dev helper: contact sheets of moving people from tools/peoplelab.html (no game boot).
// Usage: node tools/peoplelab-shots.mjs <outDir> 'name=query' ...
import puppeteer from 'puppeteer-core';
import { acquireChromeLock } from './chrome-lock.mjs';
import fs from 'node:fs';
const [out, ...jobs] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
await acquireChromeLock('people');
const PORT = process.env.PORT || (await fetch('http://localhost:5174/').then((r) => (r.ok ? 5174 : 5173)).catch(() => 5173));
const browser = await puppeteer.launch({
  executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: 'new',
  args: ['--use-angle=metal', '--ignore-gpu-blocklist'], defaultViewport: { width: 1400, height: 900 },
});
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/404/.test(m.text())) console.log('[error]', m.text().slice(0, 300)); });
  for (const j of jobs) {
    const [name, qs] = j.split('=', 2).length === 2 ? [j.slice(0, j.indexOf('=')), j.slice(j.indexOf('=') + 1)] : [j, j];
    await page.goto(`http://localhost:${PORT}/tools/peoplelab.html?${qs}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__done, { timeout: 180000, polling: 100 });
    const size = await page.evaluate(() => { const c = document.getElementById('c'); return { w: c.width, h: c.height }; });
    await page.setViewport({ width: size.w, height: size.h });
    await new Promise((r) => setTimeout(r, 150));
    await page.screenshot({ path: `${out}/${name}.jpg`, quality: 86, clip: { x: 0, y: 0, width: size.w, height: size.h } });
    console.log(name, JSON.stringify(await page.evaluate(() => window.__metrics)));
  }
} finally { await browser.close(); }
