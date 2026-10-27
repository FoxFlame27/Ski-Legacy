// Dev helper: screenshots of tools/charlab.html (the six skiers, outfit try-ons) in ONE browser session.
//   node tools/charlab-shots.mjs <outDir> <shots.json>
// shots.json: [{ "shot": "name", "cells": [{ "id": "skier_red", "look": {...}, "pose": "ski", "label": "..." }], "opt": { "view": "front", "cols": 6 } }]
import puppeteer from 'puppeteer-core';
import { acquireChromeLock } from './chrome-lock.mjs';
import fs from 'node:fs';
const [out, file] = process.argv.slice(2);
const shots = JSON.parse(fs.readFileSync(file, 'utf8'));
fs.mkdirSync(out, { recursive: true });
await acquireChromeLock('charlab');
const W = +(process.env.W || 1600), H = +(process.env.H || 900);
const browser = await puppeteer.launch({
  executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: 'new',
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', `--window-size=${W},${H}`], defaultViewport: { width: W, height: H },
});
try {
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning' || process.env.LOG) console.log(`[${m.type()}] ${m.text().slice(0, 2000)}`); });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  const PORT = process.env.PORT || (await fetch('http://localhost:5174/').then((r) => (r.ok ? 5174 : 5173)).catch(() => 5173));
  const t0 = Date.now();
  await page.goto(`http://localhost:${PORT}/tools/charlab.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__done, { timeout: 180000, polling: 200 });
  console.log('lab ready in', ((Date.now() - t0) / 1000).toFixed(1), 's');
  for (const s of shots) {
    if (s.eval) { const r = await page.evaluate(s.eval); if (r !== undefined) console.log('eval', JSON.stringify(r).slice(0, 3000)); }
    if (s.cells) await page.evaluate((c, o) => window.__lab.show(c, o), s.cells, s.opt || {});
    await new Promise((r) => setTimeout(r, 150));
    if (s.shot) { await page.screenshot({ path: `${out}/${s.shot}.jpg`, quality: 88 }); console.log('shot', `${out}/${s.shot}.jpg`); }
  }
} finally {
  await browser.close();
}
