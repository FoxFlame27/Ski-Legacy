import puppeteer from 'puppeteer-core';
import { acquireChromeLock } from './chrome-lock.mjs';
import fs from 'node:fs';
const [out, ...items] = process.argv.slice(2); // items: name[:top[:yaw]]
fs.mkdirSync(out, { recursive: true });
await acquireChromeLock('flood-view');
const browser = await puppeteer.launch({ executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: 'new',
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--window-size=1400,1000'], defaultViewport: { width: 1400, height: 1000 } });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
for (const it of items) {
  const [n, top = '0.25', yaw = '0'] = it.split(':');
  await page.goto(`http://localhost:${process.env.PORT || 5173}/tools/flood-view.html?m=${n}&top=${top}&yaw=${yaw}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__done, { timeout: 120000, polling: 200 });
  await new Promise((r) => setTimeout(r, 300));
  console.log(await page.title());
  await page.screenshot({ path: `${out}/${n}_${yaw}.jpg`, quality: 85 });
}
await browser.close();
