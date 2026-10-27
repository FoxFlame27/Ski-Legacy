// Dev helper: screenshots of tools/fanlab.html: node tools/fanlab-shots.mjs outDir 'query1' 'query2' ...
import puppeteer from 'puppeteer-core';
import { acquireChromeLock } from './chrome-lock.mjs';
import fs from 'node:fs';
const [out, ...qs] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
await acquireChromeLock(process.argv[1].split('/').pop());
const browser = await puppeteer.launch({
  executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: 'new',
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--window-size=1600,900'], defaultViewport: { width: 1600, height: 900 },
});
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[${m.type()}] ${m.text().slice(0, 600)}`); });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
for (const [i, qq] of qs.entries()) {
  await page.goto(`http://localhost:${process.env.PORT || 5177}/tools/fanlab.html?${qq}`, { waitUntil: 'domcontentloaded' });
  try { await page.waitForFunction(() => window.__done, { timeout: 120000, polling: 200 }); } catch { console.log('timeout', qq); }
  await new Promise((r) => setTimeout(r, +(process.env.WAIT || 400)));
  const ms = await page.evaluate(() => window.__updMs);
  if (process.env.EVAL) { console.log('eval', JSON.stringify(await page.evaluate(process.env.EVAL)).slice(0, 1500)); await new Promise((r) => setTimeout(r, 300)); }
  console.log(i, qq, 'update ms', ms?.toFixed(3));
  await page.screenshot({ path: `${out}/${String(i).padStart(2, '0')}.jpg`, quality: 85 });
}
await browser.close();
