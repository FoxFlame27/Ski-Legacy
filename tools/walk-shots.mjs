// Dev helper: contact sheets of the on-foot animation from tools/walklab.html (no game boot).
// Usage: node tools/walk-shots.mjs <outDir> <jobs.json>
//   jobs.json: [{ "name": "walk_side", "q": "chars=all&speeds=1.7&view=side" }, ...]
// One browser for all jobs; each job is one screenshot (the page draws the whole sheet) plus its metrics.
import puppeteer from 'puppeteer-core';
import { acquireChromeLock } from './chrome-lock.mjs';
import fs from 'node:fs';
const out = process.argv[2] || './walk-shots';
const jobs = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
fs.mkdirSync(out, { recursive: true });
await acquireChromeLock('walk');
const PORT = process.env.PORT || (await fetch('http://localhost:5174/').then((r) => (r.ok ? 5174 : 5173)).catch(() => 5173));
const browser = await puppeteer.launch({
  executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: 'new',
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'],
  defaultViewport: { width: 1200, height: 800 },
});
const metrics = {};
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[${m.type()}]`, m.text().slice(0, 300)); });
  for (const j of jobs) {
    const t0 = Date.now();
    await page.goto(`http://localhost:${PORT}/tools/walklab.html?${j.q}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__done, { timeout: 120000, polling: 100 });
    const size = await page.evaluate(() => { const c = document.getElementById('c'); return { w: c.width, h: c.height }; });
    await page.setViewport({ width: size.w, height: size.h });
    await new Promise((r) => setTimeout(r, 150));
    await page.screenshot({ path: `${out}/${j.name}.jpg`, quality: 88, clip: { x: 0, y: 0, width: size.w, height: size.h } });
    metrics[j.name] = await page.evaluate(() => window.__metrics);
    console.log(j.name, ((Date.now() - t0) / 1000).toFixed(1) + 's', JSON.stringify(metrics[j.name].map((m) => ({ c: m.char.replace('skier_', ''), v: m.speed, slide: m.slide, knee: [m.kneeMinDeg, m.kneeMaxDeg], toe: m.toeMinH, eyeBob: m.eyeBob, hipBob: m.hipBob }))));
  }
} finally {
  fs.writeFileSync(`${out}/metrics.json`, JSON.stringify(metrics, null, 1));
  await browser.close();
}
