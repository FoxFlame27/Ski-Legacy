// Dev helper for the character select / outfit shop: like shoot.mjs, but the game can start from a given save
// (e.g. an old six-skier save, to check its migration) and stays in the menu until a step starts the game.
//   node tools/char-shots.mjs <outDir> <steps.json> [save.json]
// steps: [{ eval?: "js expression", keys?: [codes], wait?: ms, shot?: "name" }]
import puppeteer from 'puppeteer-core';
import { acquireChromeLock } from './chrome-lock.mjs';
import fs from 'node:fs';
const [out, stepsFile, saveFile] = process.argv.slice(2);
const steps = JSON.parse(fs.readFileSync(stepsFile, 'utf8'));
const preload = saveFile ? fs.readFileSync(saveFile, 'utf8') : null;
fs.mkdirSync(out, { recursive: true });
await acquireChromeLock('chars');
const browser = await puppeteer.launch({
  executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  headless: 'new',
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--window-size=1600,900', '--autoplay-policy=no-user-gesture-required'],
  defaultViewport: { width: 1600, height: 900 },
});
let errors = 0;
try {
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => { const t = `[${m.type()}] ${m.text()}`; logs.push(t); if (m.type() === 'error' || m.type() === 'warning') console.log(t.slice(0, 400)); });
  page.on('pageerror', (e) => { errors++; console.log('PAGEERROR', e.message); logs.push('PAGEERROR ' + e.message); });
  if (preload) await page.evaluateOnNewDocument((s) => { if (!sessionStorage.getItem('charshots-seeded')) { localStorage.setItem('ski-legacy-save-v1', s); sessionStorage.setItem('charshots-seeded', '1'); } }, preload);
  const t0 = Date.now();
  const PORT = process.env.PORT || (await fetch('http://localhost:5174/').then((r) => (r.ok ? 5174 : 5173)).catch(() => 5173));
  // a module that fails mid-edit (another agent saving a file) leaves the page without a game: load again
  let ready = false;
  for (let attempt = 0; attempt < 3 && !ready; attempt++) {
    if (attempt) console.log('game did not start, reloading');
    await page.goto(`http://localhost:${PORT}/?nointro`, { waitUntil: 'domcontentloaded' });
    try {
      await page.waitForFunction(() => window.__game?.ready || (performance.now() > 20000 && !window.__game), { timeout: 300000, polling: 250 });
      ready = await page.evaluate(() => !!window.__game?.ready);
    } catch (e) { console.log('load wait failed:', e.message.slice(0, 120)); }
  }
  if (!ready) throw new Error('the game never became ready');
  console.log('loaded in', ((Date.now() - t0) / 1000).toFixed(1), 's');
  for (const [i, s] of steps.entries()) {
    if (s.eval) { try { const r = await page.evaluate(s.eval); if (r !== undefined) console.log('eval', i, JSON.stringify(r).slice(0, 1500)); } catch (e) { console.log('eval error', i, e.message); } }
    if (s.keys) for (const k of s.keys) await page.keyboard.down(k);
    await new Promise((r) => setTimeout(r, s.wait ?? 1200));
    if (s.keys) for (const k of s.keys) await page.keyboard.up(k);
    if (s.shot) { await page.screenshot({ path: `${out}/${s.shot}.jpg`, quality: 85 }); console.log('shot', s.shot); }
  }
  fs.writeFileSync(`${out}/console.log`, logs.join('\n'));
} finally {
  await browser.close();
}
console.log('page errors:', errors);
