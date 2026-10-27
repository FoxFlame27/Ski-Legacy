// Dev helper: the on-foot animation in the real game. Loads the game once (Brave, shared lock), runs scripted
// steps and records frame sequences inside the page (each frame cropped right after it renders, so the
// sampling is exact), then tiles each sequence into a contact sheet.
// Usage: node tools/walk-game.mjs <outDir> <steps.json>
//   step: { eval?: "js", up?: [keys released first], keys?: ["KeyW", ...] (held for the step; hold: true keeps them), wait?: ms, shot?: "name",
//           cap?: { name, every: frames between samples, n: samples, delay: ms before the first, crop: [w, h], cols } }
//   In the page: window.__cam = { mode: 'side'|'front'|'back'|'q34'|'fixed', target?: 'player'|<object with pos/heading>,
//   dist, up, p?: [x,y,z], l?: [x,y,z] } places the camera (wraps post.render); window.__wg helpers (see PRELUDE).
import puppeteer from 'puppeteer-core';
import { acquireChromeLock } from './chrome-lock.mjs';
import fs from 'node:fs';
const out = process.argv[2] || './walk-game';
const steps = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
fs.mkdirSync(out, { recursive: true });
await acquireChromeLock('walk');
const PORT = process.env.PORT || (await fetch('http://localhost:5174/').then((r) => (r.ok ? 5174 : 5173)).catch(() => 5173));
const W = 1280, H = 720;
const browser = await puppeteer.launch({
  executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: 'new',
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', `--window-size=${W},${H}`, '--autoplay-policy=no-user-gesture-required'],
  defaultViewport: { width: W, height: H },
});
const PRELUDE = `(() => {
  const g = window.__game;
  if (window.__wg) return 'ok';
  const UP = { x: 0, y: 1, z: 0 };
  const proto = Object.getPrototypeOf(g.post);
  const orig = proto.render;
  window.__frames = []; window.__cap = null;
  const cv = document.createElement('canvas');
  proto.render = function (...a) {
    const c = window.__cam;
    if (c) {
      const cam = this.camera || g.camera;
      let p, l;
      if (c.mode === 'fixed') { p = c.p; l = c.l; }
      else {
        const t = c.target === 'player' || !c.target ? { pos: g.player.pos, heading: g.player.heading } : c.target;
        const P = t.pos, h = t.heading;
        const fx = Math.sin(h), fz = Math.cos(h), rx = -fz, rz = fx, d = c.dist || 4.5;
        const ox = c.mode === 'side' ? rx * d : c.mode === 'front' ? fx * d : c.mode === 'back' ? -fx * d : (fx * 0.72 + rx * 0.7) * d;
        const oz = c.mode === 'side' ? rz * d : c.mode === 'front' ? fz * d : c.mode === 'back' ? -fz * d : (fz * 0.72 + rz * 0.7) * d;
        if (!c.sy) c.sy = P.y; c.sy += (P.y - c.sy) * 0.15; // (vertical: smoothed, the gait's own bob shows)
        p = [P.x + ox, c.sy + (c.up ?? 1.05), P.z + oz]; l = [P.x, c.sy + (c.look ?? 0.9), P.z];
        if (c.lock) { c.lockP ??= [P.x, P.z, h]; } // (side view of a straight line: the camera tracks the body)
      }
      cam.up.set(0, 1, 0); cam.position.set(p[0], p[1], p[2]); cam.lookAt(l[0], l[1], l[2]); cam.fov = c.fov || 32; cam.updateProjectionMatrix(); cam.updateMatrixWorld();
    }
    const r = orig.apply(this, a);
    const C = window.__cap;
    if (C && performance.now() >= C.start) {
      C.k = (C.k || 0) + 1;
      if ((C.k - 1) % C.every === 0 && window.__frames.length < C.n) {
        const gl = g.renderer.domElement, sw = C.crop[0] * gl.width / innerWidth, sh = C.crop[1] * gl.height / innerHeight;
        cv.width = C.crop[0]; cv.height = C.crop[1];
        cv.getContext('2d').drawImage(gl, (gl.width - sw) / 2, (gl.height - sh) / 2 + (C.dy || 0) * gl.height / innerHeight, sw, sh, 0, 0, cv.width, cv.height);
        const P = g.player;
        window.__frames.push({ img: cv.toDataURL('image/jpeg', 0.86), t: performance.now(), v: +(P.speed || 0).toFixed(2), m: P.mode });
      }
    }
    return r;
  };
  window.__wg = {
    hideUI() { for (const e of document.querySelectorAll('body > *:not(canvas)')) if (!e.querySelector('canvas')) e.style.visibility = 'hidden'; },
    cap(o) { window.__frames = []; window.__cap = { every: 2, n: 12, crop: [360, 560], ...o, start: performance.now() + (o.delay || 0) }; },
    // nearest walking villager to the player
    walker() { const ws = g.npcs?.walkers || []; let best = null, bd = 1e9; for (const w of ws) { const d = Math.hypot(w.pos.x - g.player.pos.x, w.pos.z - g.player.pos.z); if (w.target && d < bd) { bd = d; best = w; } } return best; },
  };
  return 'ok';
})()`;
try {
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => { const t = `[${m.type()}] ${m.text()}`; logs.push(t); if (m.type() === 'error') console.log(t.slice(0, 300)); });
  page.on('pageerror', (e) => { console.log('PAGEERROR', e.message); logs.push('PAGEERROR ' + e.message); });
  const t0 = Date.now();
  await page.goto(`http://localhost:${PORT}/?nointro`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game && window.__game.ready, { timeout: 240000, polling: 250 });
  console.log('loaded in', ((Date.now() - t0) / 1000).toFixed(1), 's');
  await page.evaluate(() => window.__game.startGame());
  await new Promise((r) => setTimeout(r, 1500));
  await page.evaluate(PRELUDE);
  const sheets = [];
  for (const [i, s] of steps.entries()) {
    if (s.eval) { try { const r = await page.evaluate(s.eval); if (r !== undefined) console.log('eval', i, JSON.stringify(r).slice(0, 400)); } catch (e) { console.log('eval error', i, e.message); } }
    if (s.up) for (const k of s.up) await page.keyboard.up(k);
    if (s.cap) await page.evaluate((o) => window.__wg.cap(o), s.cap);
    if (s.keys) for (const k of s.keys) await page.keyboard.down(k);
    await new Promise((r) => setTimeout(r, s.wait ?? 1000));
    if (s.cap && s.cap.waitFrames !== false) {
      await page.waitForFunction((n) => window.__frames.length >= n, { timeout: 30000, polling: 100 }, s.cap.n).catch(() => console.log('capture short', s.cap.name));
    }
    if (s.keys && !s.hold) for (const k of s.keys) await page.keyboard.up(k);
    if (s.release) for (const k of s.release) await page.keyboard.up(k);
    if (s.shot) await page.screenshot({ path: `${out}/${s.shot}.jpg`, quality: 85 });
    if (s.cap) {
      const frames = await page.evaluate(() => { const f = window.__frames; window.__cap = null; window.__frames = []; return f; });
      sheets.push({ name: s.cap.name, cols: s.cap.cols || 6, crop: s.cap.crop || [360, 560], frames });
      console.log('captured', s.cap.name, frames.length, 'frames', frames.map((f) => f.v).join(' '));
    }
  }
  // contact sheets (one page, the frames tiled with their index and speed)
  const p2 = await browser.newPage();
  for (const sh of sheets) {
    const [cw, ch] = sh.crop, sc = 0.75, cols = sh.cols, rows = Math.ceil(sh.frames.length / cols);
    const t0f = sh.frames[0]?.t || 0;
    const html = `<body style="margin:0;background:#222;width:${cols * (cw * sc + 4)}px">${sh.frames.map((f, k) => `<div style="position:relative;display:inline-block;margin:2px;width:${cw * sc}px;height:${ch * sc}px"><img src="${f.img}" style="width:100%;height:100%"><span style="position:absolute;left:4px;top:2px;color:#fff;font:600 12px system-ui;text-shadow:0 0 3px #000">${k + 1} · ${((f.t - t0f) / 1000).toFixed(2)}s · ${f.v} m/s ${f.m}</span></div>`).join('')}</body>`;
    await p2.setViewport({ width: Math.ceil(cols * (cw * sc + 4)), height: Math.ceil(rows * (ch * sc + 4)) });
    await p2.setContent(html);
    await p2.screenshot({ path: `${out}/${sh.name}.jpg`, quality: 86, fullPage: true });
  }
  fs.writeFileSync(`${out}/console.log`, logs.join('\n'));
} finally {
  await browser.close();
}
