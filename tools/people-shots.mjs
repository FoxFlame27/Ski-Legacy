// Dev helper (living people): boots the game once in Brave, then for every view places the camera, records a
// frame sequence (proof that people move), tiles it into a contact sheet and measures fps + the CPU cost of the
// people systems (__game.profile()).
// Usage: node tools/people-shots.mjs <outDir> <jobs.json>
//   jobs.json: { "setup": "<js evaluated once after the game started>",
//                "views": [{ "name": "tal_platform", "cam": "<js returning {p:[x,y,z], l:[x,y,z]}>", "go": [x, z],
//                            "frames": 8, "every": 350, "pre": 2500, "fps": true, "crop": [x, y, w, h] }] }
// The camera override is applied before every system that culls / picks LODs by the camera (railway.lateUpdate,
// crowds, npcs, village people) and before rendering, so LODs and culling match the picture.
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';
import { acquireChromeLock } from './chrome-lock.mjs';
import fs from 'node:fs';

const out = process.argv[2] || './people-shots';
const jobs = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
fs.mkdirSync(out, { recursive: true });
await acquireChromeLock('people');
const W = jobs.width || 1280, H = jobs.height || 720;
const browser = await puppeteer.launch({
  executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  headless: 'new',
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', `--window-size=${W},${H}`, '--autoplay-policy=no-user-gesture-required'],
  defaultViewport: { width: W, height: H },
});
const report = {};
try {
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => { const t = `[${m.type()}] ${m.text()}`; logs.push(t); if (m.type() === 'error' || m.type() === 'warning') console.log(t.slice(0, 300)); });
  page.on('pageerror', (e) => { console.log('PAGEERROR', e.message); logs.push('PAGEERROR ' + e.message); });
  const PORT = process.env.PORT || (await fetch('http://localhost:5174/').then((r) => (r.ok ? 5174 : 5173)).catch(() => 5173));
  const t0 = Date.now();
  await page.goto(`http://localhost:${PORT}/?nointro${jobs.query ? '&' + jobs.query : ''}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game && window.__game.ready, { timeout: 300000, polling: 250 });
  console.log('loaded in', ((Date.now() - t0) / 1000).toFixed(1), 's');
  await page.evaluate(() => window.__game.startGame());
  await new Promise((r) => setTimeout(r, 1500));
  // camera override, applied before the camera-dependent systems and the render
  await page.evaluate(() => {
    const g = window.__game;
    const apply = () => {
      const c = window.__cam;
      if (!c) return;
      const cam = g.camera;
      cam.up.set(0, 1, 0); cam.position.set(...c.p); cam.lookAt(...c.l);
      if (c.fov && cam.fov !== c.fov) { cam.fov = c.fov; cam.updateProjectionMatrix(); }
      cam.updateMatrixWorld();
    };
    const wrap = (obj, fn) => {
      if (!obj || !obj[fn] || obj[fn].__camWrapped) return;
      const orig = obj[fn];
      obj[fn] = function (...a) { apply(); return orig.apply(this, a); };
      obj[fn].__camWrapped = true;
    };
    wrap(g.railway, 'lateUpdate'); wrap(g.crowds, 'update'); wrap(g.npcs, 'update'); wrap(g.post, 'render');
    window.__applyCam = apply;
    return true;
  });
  if (jobs.setup) { const r = await page.evaluate(jobs.setup); if (r !== undefined) console.log('setup', JSON.stringify(r).slice(0, 400)); }
  for (const v of jobs.views) {
    const tv = Date.now();
    if (v.go) {
      await page.evaluate(async ([x, z]) => { const g = window.__game; g.player.teleport(x, z, 0); await g.streamAround?.(x, z); }, v.go);
    }
    if (v.eval) { const r = await page.evaluate(v.eval); if (r !== undefined) console.log(v.name, 'eval', JSON.stringify(r).slice(0, 400)); }
    const cam = await page.evaluate(v.cam);
    await page.evaluate((c) => { window.__cam = c; }, cam);
    await new Promise((r) => setTimeout(r, v.pre ?? 2500));
    const files = [], times = [];
    for (let k = 0; k < (v.frames ?? 8); k++) {
      const f = `${out}/${v.name}_${String(k).padStart(2, '0')}.jpg`;
      if (v.camSeq) { const c2 = await page.evaluate(v.camSeq, k); if (c2) await page.evaluate((c) => { window.__cam = c; }, c2); }
      times.push(await page.evaluate(() => +(performance.now() / 1000).toFixed(2)));
      await page.screenshot({ path: f, quality: 84 });
      files.push(f);
      await new Promise((r) => setTimeout(r, v.every ?? 350));
    }
    const rec = { cam, times };
    if (v.fps !== false) {
      await page.evaluate(() => window.__game.profile(true));
      rec.fps = await page.evaluate(() => new Promise((res) => { let n = 0; const t = performance.now(); const f = () => { n++; if (performance.now() - t < 3000) requestAnimationFrame(f); else res(+(n / 3).toFixed(1)); }; requestAnimationFrame(f); }));
      rec.prof = await page.evaluate(() => window.__game.profile());
      await page.evaluate(() => window.__game.profile(false));
    }
    if (v.stats) rec.stats = await page.evaluate(v.stats);
    // contact sheet: frames in a grid (half size, optional crop)
    const [cx, cy, cw, ch] = v.crop || [0, 0, W, H];
    const sc = v.scale ?? (cw > 900 ? 0.5 : 1);
    const tw = Math.round(cw * sc), th = Math.round(ch * sc), cols = v.cols ?? 4, rows = Math.ceil(files.length / cols);
    const tiles = await Promise.all(files.map((f) => sharp(f).extract({ left: cx, top: cy, width: cw, height: ch }).resize(tw, th).toBuffer()));
    await sharp({ create: { width: cols * (tw + 4), height: rows * (th + 4), channels: 3, background: '#222' } })
      .composite(tiles.map((b, k) => ({ input: b, left: (k % cols) * (tw + 4), top: Math.floor(k / cols) * (th + 4) })))
      .jpeg({ quality: 86 }).toFile(`${out}/${v.name}_sheet.jpg`);
    report[v.name] = rec;
    console.log(v.name, ((Date.now() - tv) / 1000).toFixed(1) + 's', 'fps', rec.fps, JSON.stringify(rec.prof || {}), rec.stats ? JSON.stringify(rec.stats).slice(0, 300) : '');
  }
  fs.writeFileSync(`${out}/console.log`, logs.join('\n'));
} finally {
  fs.writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 1));
  await browser.close();
}
