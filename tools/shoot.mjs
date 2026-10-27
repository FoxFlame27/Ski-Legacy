// Dev helper: loads the game in Chrome, runs scripted steps, saves screenshots.
// Usage: node tools/shoot.mjs <outDir> [stepsFile.json]
import puppeteer from 'puppeteer-core';
import { acquireChromeLock } from './chrome-lock.mjs';
import fs from 'node:fs';
const out = process.argv[2] || './shots';
const steps = process.argv[3] ? JSON.parse(fs.readFileSync(process.argv[3], 'utf8')) : [];
fs.mkdirSync(out, { recursive: true });
await acquireChromeLock(process.argv[1].split('/').pop());
const browser = await puppeteer.launch({
  executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  headless: 'new',
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--window-size=1600,900', '--autoplay-policy=no-user-gesture-required'],
  defaultViewport: { width: 1600, height: 900, deviceScaleFactor: Number(process.env.DSF) || 1 },
});
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => { const t = `[${m.type()}] ${m.text()}`; logs.push(t); if (m.type() === 'error' || m.type() === 'warning') console.log(t.slice(0, 400)); });
page.on('pageerror', (e) => { console.log('PAGEERROR', e.message); logs.push('PAGEERROR ' + e.message); });
const t0 = Date.now();
// the no-reload dev server (tools/vite.nohmr.config.mjs, port 5174) when it runs: saving files never reloads a test mid-run
const PORT = process.env.PORT || (await fetch('http://localhost:5174/').then((r) => (r.ok ? 5174 : 5173)).catch(() => 5173));
await page.goto(process.env.INTRO ? `http://localhost:${PORT}/` : `http://localhost:${PORT}/?nointro${process.env.QUERY ? '&' + process.env.QUERY : ''}`, { waitUntil: 'domcontentloaded' });
try {
  await page.waitForFunction(() => window.__game && window.__game.ready, { timeout: 240000, polling: 250 });
} catch (e) {
  console.log('load timeout');
}
console.log('loaded in', ((Date.now() - t0) / 1000).toFixed(1), 's');
await page.screenshot({ path: `${out}/00_title.jpg`, quality: 80 });
if (!process.env.NOPLAY) await page.evaluate(() => window.__game.startGame());
await new Promise((r) => setTimeout(r, 1500));
for (const [i, s] of steps.entries()) {
  if (s.eval) { try { const r = await page.evaluate(s.eval); if (r !== undefined) console.log('eval', i, JSON.stringify(r).slice(0, 600)); } catch (e) { console.log('eval error', e.message); } }
  if (s.keys) for (const k of s.keys) await page.keyboard.down(k);
  await new Promise((r) => setTimeout(r, s.wait ?? 1500));
  if (s.keys) for (const k of s.keys) await page.keyboard.up(k);
  if (s.shot) await page.screenshot({ path: `${out}/${s.shot}.jpg`, quality: 82 });
}
const fps = await page.evaluate(() => new Promise((res) => { let n = 0; const t = performance.now(); const f = () => { n++; if (performance.now() - t < 2000) requestAnimationFrame(f); else res(n / 2); }; requestAnimationFrame(f); }));
console.log('fps', fps);
fs.writeFileSync(`${out}/console.log`, logs.join('\n'));
await browser.close();
