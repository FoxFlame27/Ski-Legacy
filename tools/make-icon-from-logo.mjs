// Builds the macOS app icon (build/icon.icns) from the Ski Legacy logo art (assets-src/branding/ski-legacy-logo.png).
// The art is a rounded square on white: cut it out with a rounded-rect mask, fit it to Apple's icon grid
// (824 px shape on a 1024 canvas) and add the soft drop shadow macOS icons have.
import sharp from 'sharp';
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const SRC = 'assets-src/branding/ski-legacy-logo.png';
const S = 1024, SHAPE = 824, PAD = (S - SHAPE) / 2;
// bounds of the rounded square inside the source art (measured: x 7..1247, y 0..1236, corner radius ~271)
const box = { left: 7, top: 0, width: 1241, height: 1237 };
const radius = 271 * (SHAPE / box.width) + 2; // a hair larger than the art's own corner, so no white fringe

const art = await sharp(SRC).extract(box).resize(SHAPE, SHAPE, { fit: 'fill' }).ensureAlpha().toBuffer();
const mask = Buffer.from(`<svg width="${SHAPE}" height="${SHAPE}"><rect x="1.5" y="1.5" width="${SHAPE - 3}" height="${SHAPE - 3}" rx="${radius}" ry="${radius}" fill="#fff"/></svg>`);
const shapePng = await sharp(art).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
const shadow = await sharp({ create: { width: S, height: S, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite([{ input: Buffer.from(`<svg width="${S}" height="${S}"><rect x="${PAD}" y="${PAD + 10}" width="${SHAPE}" height="${SHAPE}" rx="${radius}" ry="${radius}" fill="rgba(0,0,0,0.38)"/></svg>`) }])
  .blur(14).png().toBuffer();
await sharp({ create: { width: S, height: S, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite([{ input: shadow }, { input: shapePng, left: PAD, top: PAD }])
  .png().toFile('build/icon.png');

fs.rmSync('build/icon.iconset', { recursive: true, force: true });
fs.mkdirSync('build/icon.iconset');
for (const s of [16, 32, 64, 128, 256, 512]) {
  execSync(`sips -z ${s} ${s} build/icon.png --out build/icon.iconset/icon_${s}x${s}.png`);
  execSync(`sips -z ${s * 2} ${s * 2} build/icon.png --out build/icon.iconset/icon_${s}x${s}@2x.png`);
}
execSync('iconutil -c icns build/icon.iconset -o build/icon.icns');
// in-game copy (loading screen / menu branding): the full-bleed v2 art at 1024 px, sharp on Retina at loading-screen size
const G = 1024, gRadius = 271 * (G / box.width) + 2;
const gArt = await sharp('assets-src/branding/ski-legacy-logo-v2.png').resize(G, G, { fit: 'fill' }).ensureAlpha().toBuffer();
const gMask = Buffer.from(`<svg width="${G}" height="${G}"><rect x="1.5" y="1.5" width="${G - 3}" height="${G - 3}" rx="${gRadius}" ry="${gRadius}" fill="#fff"/></svg>`);
fs.mkdirSync('public/ui', { recursive: true });
await sharp(gArt).composite([{ input: gMask, blend: 'dest-in' }]).webp({ quality: 90 }).toFile('public/ui/logo.webp');
console.log('icon done');
