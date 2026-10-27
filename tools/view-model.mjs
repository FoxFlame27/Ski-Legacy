// Renders 2x2 inspection views of models: node tools/view-model.mjs outDir name1 name2 ...
import puppeteer from 'puppeteer-core';
import { acquireChromeLock } from './chrome-lock.mjs';
import fs from 'node:fs';
const [out, ...names] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
await acquireChromeLock(process.argv[1].split('/').pop());
const browser = await puppeteer.launch({
  executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  headless: 'new',
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--window-size=1200,900'],
  defaultViewport: { width: 1200, height: 900 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
for (const n of names) {
  await page.goto(`http://localhost:${process.env.VPORT || 5173}/tools/viewer.html?m=${n}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__done, { timeout: 120000, polling: 200 });
  await new Promise((r) => setTimeout(r, 300));
  console.log(await page.title());
  await page.screenshot({ path: `${out}/${n}.jpg`, quality: 85 });
}
await browser.close();
