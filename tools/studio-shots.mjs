// Dev helper: frames + contact sheets of the Icecold Studio ident (tools/studiotest.html), never the full game.
// Usage: node tools/studio-shots.mjs <outDir> [still|tall|resize|hidpi|audio|all]
//   still   1920x1080, every 0.25 s plus the frames around the hit (drawn on demand: exact times)
//   tall    a narrow / tall window (900x1400)
//   resize  real time at 1600x900, resized to 1280x1000 mid-ident (the app goes fullscreen while it plays)
//   hidpi   1440x900 at 2x (a fullscreen MacBook): crispness
//   audio   the ident's sound rendered offline: peak / RMS against the clip's recorded hits
import puppeteer from 'puppeteer-core';
import { acquireChromeLock } from './chrome-lock.mjs';
import fs from 'node:fs';
const out = process.argv[2] || './studio-shots';
const what = (process.argv[3] || 'all').split(',');
const on = (k) => what.includes(k) || what.includes('all');
fs.mkdirSync(out, { recursive: true });
await acquireChromeLock('studio');
const PORT = process.env.PORT || (await fetch('http://localhost:5174/').then((r) => (r.ok ? 5174 : 5173)).catch(() => 5173));
const URL0 = `http://localhost:${PORT}/tools/studiotest.html`;
const browser = await puppeteer.launch({
  executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: 'new',
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
  defaultViewport: { width: 1920, height: 1080 },
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.text()); });

  async function stills(tag, w, h, dpr, times, query = '') {
    await page.setViewport({ width: w, height: h, deviceScaleFactor: dpr });
    await page.goto(`${URL0}?still=1&mute=1${query}${process.env.VARIANT ? '&studio=' + process.env.VARIANT : ''}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__studioReady !== undefined, { timeout: 20000 });
    const files = [];
    for (const t of times) {
      await page.evaluate((t) => window.__seek(t), t);
      await sleep(80);
      const f = `${out}/${tag}_t${t.toFixed(2)}.jpg`;
      await page.screenshot({ path: f, quality: 90 });
      files.push([f, `${t.toFixed(2)} s`]);
    }
    return files;
  }

  async function sheet(file, cells, tileW, tileH, cols) {
    const html = `<body style="margin:0;background:#1a1a1a;font:13px -apple-system,sans-serif;color:#ddd">${cells.map(([f, label]) =>
      `<div style="display:inline-block;margin:3px;vertical-align:top"><img src="data:image/jpeg;base64,${fs.readFileSync(f).toString('base64')}" style="width:${tileW}px;height:${tileH}px;display:block;object-fit:contain;background:#000"><div style="padding:2px 0">${label}</div></div>`).join('')}</body>`;
    const p = await browser.newPage();
    await p.setViewport({ width: cols * (tileW + 6), height: 400 });
    await p.setContent(html);
    await p.screenshot({ path: file, quality: 86, fullPage: true });
    await p.close();
    console.log('sheet', file);
  }

  if (on('still')) {
    const times = [0, 0.25, 0.4, 0.5, 0.6, 0.75, 0.85, 0.94, 0.96, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5, 2.75, 2.88];
    const f = await stills('hd', 1920, 1080, 1, times);
    await sheet(`${out}/sheet_1920x1080.jpg`, f, 480, 270, 4);
  }
  if (on('tall')) {
    const f = await stills('tall', 900, 1400, 1, [0.5, 0.85, 1.0, 1.5, 2.2]);
    await sheet(`${out}/sheet_900x1400.jpg`, f, 225, 350, 5);
  }
  if (on('hidpi')) {
    await stills('hidpi', 1440, 900, 2, [0.7, 1.6]);
  }
  if (on('resize')) {
    // real time, like the app: the window changes size while the ident plays
    await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
    await page.goto(`${URL0}?mute=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__studioT0 !== undefined, { timeout: 20000 });
    const t0 = await page.evaluate(() => window.__studioT0);
    const at = async (s) => { const now = await page.evaluate(() => performance.now()); const w = t0 + s * 1000 - now; if (w > 0) await sleep(w); };
    const files = [];
    const shot = async (label) => {
      const t = ((await page.evaluate(() => performance.now())) - t0) / 1000;
      const f = `${out}/resize_${label}.jpg`;
      await page.screenshot({ path: f, quality: 88 });
      files.push([f, `${label} (${t.toFixed(2)} s)`]);
    };
    await at(0.35); await shot('a_1600x900');
    await page.setViewport({ width: 1280, height: 1000, deviceScaleFactor: 1 });
    await shot('b_just-resized');
    await at(0.8); await shot('c_1280x1000');
    await at(1.3); await shot('d_after-hit');
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
    await at(1.9); await shot('e_1920x1080');
    await at(2.6); await shot('f_exit');
    await page.waitForFunction(() => window.__studioDone, { timeout: 8000 });
    const stats = await page.evaluate(() => window.__stats);
    console.log('realtime stats', JSON.stringify(stats));
    await sheet(`${out}/sheet_resize.jpg`, files, 400, 280, 3);
  }
  if (what.includes('specimen')) {
    // look variants stacked (SPEC env: JSON list of engine opts), at a few times
    const list = process.env.SPEC || '[{"flat":0},{"flat":0.2}]';
    const n = JSON.parse(list).length;
    await page.setViewport({ width: 1600, height: 450 * n, deviceScaleFactor: 1 });
    for (const t of (process.env.TIMES || '0.6,1.0,2.0').split(',')) {
      await page.goto(`${URL0}?specimen=${encodeURIComponent(list)}&t=${t}`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__studioReady, { timeout: 20000 });
      await sleep(120);
      await page.screenshot({ path: `${out}/specimen_t${t}.jpg`, quality: 90 });
    }
  }
  if (what.includes('intro')) {
    // the real boot intro (no game): the clip hands off to the studio ident, then the Claude card; and a skip
    await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
    await page.goto(`${URL0}?intro=1`, { waitUntil: 'domcontentloaded' });
    const files = [];
    // frames relative to when each scene really starts (the clip's own load time varies)
    const grab = async (sel, offsets, tag) => {
      await page.waitForSelector(sel, { timeout: 20000 });
      const t1 = Date.now();
      for (const o of offsets) {
        const w = t1 + o * 1000 - Date.now();
        if (w > 0) await sleep(w);
        const f = `${out}/intro_${tag}_${o.toFixed(1)}.jpg`;
        await page.screenshot({ path: f, quality: 85 });
        files.push([f, `${tag} +${o.toFixed(1)} s`]);
      }
    };
    await grab('.scene-clip', [3.6], 'clip');
    await grab('.scene-studio', [0.1, 0.6, 1.3, 2.0, 2.6], 'studio');
    await grab('.scene-claude', [0.2, 1.2], 'claude');
    await page.waitForFunction(() => window.__introDone, { timeout: 15000 });
    console.log('intro done at', await page.evaluate(() => window.__introDone));
    await sheet(`${out}/sheet_intro.jpg`, files, 400, 225, 3);
    await page.goto(`${URL0}?intro=1&skip=5.4`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__introDone, { timeout: 15000 });
    console.log('skipped intro done at', await page.evaluate(() => window.__introDone));
  }
  if (on('audio')) {
    await page.goto(`${URL0}?offline=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__audioReport, { timeout: 30000 });
    const r = await page.evaluate(() => window.__audioReport);
    for (const [k, v] of Object.entries(r)) console.log('audio', k, JSON.stringify(v));
  }
  console.log('errors', JSON.stringify(errs.slice(0, 10)));
} finally {
  await browser.close();
}
