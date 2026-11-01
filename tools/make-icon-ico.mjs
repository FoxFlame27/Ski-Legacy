// Builds the Windows app icon (build/icon.ico) from build/icon.png (the 1024 px macOS icon, see make-icon-from-logo.mjs).
// Run from the game's folder:  node tools/make-icon-ico.mjs
// The macOS art sits on Apple's icon grid (lots of transparent margin); Windows icons fill their square, so the
// transparent border is trimmed first. Every size is stored as a PNG entry (Windows Vista and newer, incl. 11).
import sharp from 'sharp';
import fs from 'node:fs';

const SRC = 'build/icon.png';
const OUT = 'build/icon.ico';
const SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];

const trimmed = await sharp(SRC).ensureAlpha().trim({ threshold: 1 }).toBuffer({ resolveWithObject: true });
const side = Math.max(trimmed.info.width, trimmed.info.height);
const square = await sharp(trimmed.data)
  .resize(side, side, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png().toBuffer();
const pngs = await Promise.all(SIZES.map((s) => sharp(square).resize(s, s, { kernel: 'lanczos3' }).png({ compressionLevel: 9 }).toBuffer()));

// ICO = ICONDIR (6 bytes) + one ICONDIRENTRY (16 bytes) per image + the image data
const header = Buffer.alloc(6 + 16 * SIZES.length);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(SIZES.length, 4);
let offset = header.length;
SIZES.forEach((s, i) => {
  const e = 6 + 16 * i;
  header.writeUInt8(s >= 256 ? 0 : s, e); // width (0 means 256)
  header.writeUInt8(s >= 256 ? 0 : s, e + 1); // height
  header.writeUInt8(0, e + 2); // palette colours
  header.writeUInt8(0, e + 3); // reserved
  header.writeUInt16LE(1, e + 4); // colour planes
  header.writeUInt16LE(32, e + 6); // bits per pixel
  header.writeUInt32LE(pngs[i].length, e + 8);
  header.writeUInt32LE(offset, e + 12);
  offset += pngs[i].length;
});
fs.writeFileSync(OUT, Buffer.concat([header, ...pngs]));
console.log(`${OUT}: ${SIZES.join(', ')} px, ${(offset / 1024).toFixed(0)} KB`);
