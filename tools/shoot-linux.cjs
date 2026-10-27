// Linux / cloud variant of shoot.mjs (Playwright + software WebGL; slow: ~90 s to load). Uses the no-reload dev
// server on 5174 (tools/vite.nohmr.config.mjs). Usage: node tools/shoot-linux.cjs <outDir> [steps.json]
// steps: [{ eval: "js", wait: ms, keys: [...], shot: "name" }]
const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const out = process.argv[2], steps = process.argv[3] ? JSON.parse(fs.readFileSync(process.argv[3], 'utf8')) : [];
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ args: ['--disable-dev-shm-usage', '--js-flags=--max-old-space-size=8192', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  const logs = [];
  page.on('console', (m) => { const t = `[${m.type()}] ${m.text()}`; logs.push(t); if (m.type() === 'error') console.log(t.slice(0, 400)); });
  page.on('pageerror', (e) => { console.log('PAGEERROR', e.message); logs.push('PAGEERROR ' + e.message + '\n' + e.stack); });
  const t0 = Date.now();
  await page.goto('http://localhost:' + (process.env.PORT || 5174) + '/?nointro' + (process.env.QUERY ? '&' + process.env.QUERY : ''), { waitUntil: 'domcontentloaded' });
  try { await page.waitForFunction(() => window.__game && window.__game.ready, null, { timeout: 600000, polling: 500 }); } catch (e) { console.log('load timeout'); }
  console.log('loaded in', ((Date.now() - t0) / 1000).toFixed(1), 's');
  if (!process.env.NOPLAY) await page.evaluate(() => window.__game.startGame());
  await page.waitForTimeout(2000);
  for (const [i, s] of steps.entries()) {
    if (s.eval) { try { const r = await page.evaluate(s.eval); if (r !== undefined) console.log('eval', i, JSON.stringify(r).slice(0, 1500)); } catch (e) { console.log('eval error', i, e.message); } }
    if (s.keys) for (const k of s.keys) await page.keyboard.down(k);
    await page.waitForTimeout(s.wait ?? 1500);
    if (s.keys) for (const k of s.keys) await page.keyboard.up(k);
    if (s.shot) await page.screenshot({ path: `${out}/${s.shot}.jpg`, quality: 82, timeout: 300000 });
  }
  fs.writeFileSync(`${out}/console.log`, logs.join('\n'));
  await browser.close();
})();
