// Rasterise the sponsor logos (assets-src/sponsors/*.svg, from Wikimedia Commons) to trimmed PNGs in
// public/sponsors/, which world/sponsors.js draws onto the net banner atlas.
//   node tools/build-sponsor-logos.mjs
import fs from 'node:fs';
import sharp from 'sharp';
const SRC = 'assets-src/sponsors', OUT = 'public/sponsors';
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(SRC).filter((f) => f.endsWith('.svg'))) {
  const id = f.slice(0, -4);
  const png = await sharp(`${SRC}/${f}`, { density: 600 }).resize({ height: 200, width: 900, fit: 'inside' })
    .trim({ threshold: 1 }).png({ compressionLevel: 9 }).toBuffer();
  const m = await sharp(png).metadata();
  fs.writeFileSync(`${OUT}/${id}.png`, png);
  console.log(id, m.width, 'x', m.height, Math.round(png.length / 1024) + ' KB');
}
