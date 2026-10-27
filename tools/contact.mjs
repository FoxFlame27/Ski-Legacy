// Dev helper: tiles screenshots into one contact sheet so motion can be reviewed frame by frame.
// Usage: node tools/contact.mjs out.jpg cols cropX cropY cropW cropH img1 img2 ...
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const [out, cols, cx, cy, cw, ch, ...imgs] = process.argv.slice(2);
const C = +cols, W = +cw, H = +ch, scale = 0.5;
const cells = imgs.map((f, i) => `<div style="position:relative;width:${W * scale}px;height:${H * scale}px;overflow:hidden;display:inline-block;margin:2px;background:#000">
  <img src="data:image/jpeg;base64,${fs.readFileSync(f).toString('base64')}" style="position:absolute;left:${-cx * scale}px;top:${-cy * scale}px;width:${1600 * scale}px">
  <span style="position:absolute;left:4px;top:2px;color:#fff;font:12px sans-serif;text-shadow:0 0 3px #000">${i + 1}</span></div>`).join('');
const html = `<body style="margin:0;background:#222;width:${C * (W * scale + 4)}px">${cells}</body>`;
const b = await puppeteer.launch({ executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: 'new' });
const p = await b.newPage();
await p.setViewport({ width: Math.ceil(C * (W * scale + 4)), height: Math.ceil(Math.ceil(imgs.length / C) * (H * scale + 4)) });
await p.setContent(html);
await p.screenshot({ path: out, quality: 85, fullPage: true });
await b.close();
