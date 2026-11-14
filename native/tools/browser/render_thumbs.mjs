// The build menu's furniture thumbnails, rendered by the web game itself (src/game/build/furniture.js renderThumbs: a
// 160 x 120 WebGL canvas per catalogue model, its lights, camera and tone mapping) and packed into one atlas for the
// native build menu (game/buildmenu.cpp): public/ui/furniture_thumbs.webp (8 abreast, lossless) + furniture_thumbs.json
// (the ids in atlas order). Needs a browser, so it is not part of the CMake data step (and lives in tools/browser, outside the exporters the data step watches): the two files are committed;
// run it again when the furniture catalogue or its models change:
//   npx vite --port 5174 &          (the game's dev server)
//   node native/tools/browser/render_thumbs.mjs [http://localhost:5174] [/path/to/chrome]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(path.join(root, 'package.json'));
const puppeteer = require('puppeteer-core');
const url = process.argv[2] || 'http://localhost:5174';
const chrome = process.argv[3] || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await puppeteer.launch({
  executablePath: chrome, headless: 'new',
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--window-size=1280,720'],
  defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 200)));
await page.goto(url + '/?nointro', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game && window.__game.ready, { timeout: 300000, polling: 250 });
const res = await page.evaluate(async () => {
  const F = await import('/src/game/build/furniture.js');
  const C = await import('/src/game/build/catalog.js');
  try { localStorage.removeItem('sl-furniture-thumbs-v2'); } catch { /* none */ }
  await F.renderThumbs();
  const ids = C.FURNITURE.map((f) => f.id), COLS = 8, W = 160, H = 120;
  const cv = document.createElement('canvas');
  cv.width = COLS * W; cv.height = Math.ceil(ids.length / COLS) * H;
  const g = cv.getContext('2d');
  const missing = [];
  for (let i = 0; i < ids.length; i++) {
    const u = F.getThumb(ids[i]);
    if (!u) { missing.push(ids[i]); continue; }
    const img = new Image();
    await new Promise((ok, no) => { img.onload = ok; img.onerror = no; img.src = u; });
    g.drawImage(img, (i % COLS) * W, Math.floor(i / COLS) * H);
  }
  return { ids, missing, cols: COLS, w: W, h: H, atlas: cv.toDataURL('image/webp', 1) };
});
await browser.close();
const out = path.join(root, 'public/ui');
fs.writeFileSync(path.join(out, 'furniture_thumbs.webp'), Buffer.from(res.atlas.split(',')[1], 'base64'));
fs.writeFileSync(path.join(out, 'furniture_thumbs.json'), JSON.stringify({ cols: res.cols, w: res.w, h: res.h, ids: res.ids }) + '\n');
console.log(`furniture thumbnails: ${res.ids.length} models (${res.missing.length} missing${res.missing.length ? ': ' + res.missing.join(' ') : ''}) -> public/ui/furniture_thumbs.webp`);
