// Ski Legacy native port: the UI fonts (Phase 4), converted from the game's own @fontsource packages to TTF for
// stb_truetype (native/data/fonts/):
//   barlow-condensed-{500,600,700}.ttf, barlow-condensed-{700,800}-italic.ttf   (@fontsource/barlow-condensed, WOFF)
//   inter.ttf                                                                     (@fontsource-variable/inter, WOFF2:
//                                                                                  Brotli + the glyf / loca transform)
// The menus' headings and the HUD are Barlow Condensed (blue italic), body text Inter (style.css --ui). Inter is the
// variable font; stb_truetype draws its default instance (weight 400). OFL licences (both).
//
// Usage: node native/tools/export_fonts.mjs   (run by export_world.mjs)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const OUT = path.resolve(HERE, '../data/fonts');
fs.mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- sfnt writer
function sfnt(flavor, tables) { // tables: [{ tag (string), data (Buffer) }]
  tables.sort((a, b) => (a.tag < b.tag ? -1 : 1));
  const num = tables.length;
  let sr = 1, es = 0; while (sr * 2 <= num) { sr *= 2; es++; }
  const head = Buffer.alloc(12 + 16 * num);
  head.writeUInt32BE(flavor, 0); head.writeUInt16BE(num, 4); head.writeUInt16BE(sr * 16, 6); head.writeUInt16BE(es, 8); head.writeUInt16BE(num * 16 - sr * 16, 10);
  let at = head.length;
  const body = [];
  tables.forEach((t, i) => {
    const o = 12 + i * 16, d = t.data;
    let sum = 0;
    const p = Buffer.concat([d, Buffer.alloc((4 - (d.length % 4)) % 4)]);
    for (let k = 0; k < p.length; k += 4) sum = (sum + p.readUInt32BE(k)) >>> 0;
    head.write(t.tag, o, 4, 'latin1'); head.writeUInt32BE(sum, o + 4); head.writeUInt32BE(at, o + 8); head.writeUInt32BE(d.length, o + 12);
    body.push(p); at += p.length;
  });
  return Buffer.concat([head, ...body]);
}

// ---------------------------------------------------------------- WOFF 1 (zlib per table)
function woffToTtf(w) {
  const num = w.readUInt16BE(12), flavor = w.readUInt32BE(4), tables = [];
  for (let i = 0; i < num; i++) {
    const o = 44 + i * 20, off = w.readUInt32BE(o + 4), comp = w.readUInt32BE(o + 8), orig = w.readUInt32BE(o + 12);
    const d = w.subarray(off, off + comp);
    tables.push({ tag: w.toString('latin1', o, o + 4), data: comp < orig ? zlib.inflateSync(d) : Buffer.from(d) });
  }
  return sfnt(flavor, tables);
}

// ---------------------------------------------------------------- WOFF 2 (Brotli; glyf / loca reconstructed)
const KNOWN = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT',
  'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC',
  'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar',
  'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill'];

class Reader {
  constructor(b, o = 0) { this.b = b; this.o = o; }
  u8() { return this.b[this.o++]; }
  u16() { const v = this.b.readUInt16BE(this.o); this.o += 2; return v; }
  i16() { const v = this.b.readInt16BE(this.o); this.o += 2; return v; }
  u32() { const v = this.b.readUInt32BE(this.o); this.o += 4; return v; }
  base128() { let v = 0; for (let i = 0; i < 5; i++) { const c = this.u8(); v = v * 128 + (c & 127); if (!(c & 128)) return v; } throw new Error('base128'); }
  u255() { const c = this.u8(); if (c === 253) return this.u16(); if (c === 255) return this.u8() + 253; if (c === 254) return this.u8() + 506; return c; }
  bytes(n) { const s = this.b.subarray(this.o, this.o + n); this.o += n; return s; }
}

function woff2ToTtf(w) {
  if (w.toString('latin1', 0, 4) !== 'wOF2') throw new Error('not WOFF2');
  const flavor = w.readUInt32BE(4), num = w.readUInt16BE(12), compLen = w.readUInt32BE(20);
  const r = new Reader(w, 48), dir = [];
  for (let i = 0; i < num; i++) {
    const f = r.u8(), tag = (f & 63) === 63 ? r.bytes(4).toString('latin1') : KNOWN[f & 63], ver = (f >> 6) & 3;
    const orig = r.base128();
    const transformed = tag === 'glyf' || tag === 'loca' ? ver === 0 : ver !== 0;
    const tlen = transformed ? r.base128() : orig;
    dir.push({ tag, orig, transformed, tlen });
  }
  const data = zlib.brotliDecompressSync(w.subarray(r.o, r.o + compLen));
  let at = 0;
  for (const t of dir) { t.data = data.subarray(at, at + t.tlen); at += t.tlen; }
  const out = [];
  const glyf = dir.find((t) => t.tag === 'glyf'), loca = dir.find((t) => t.tag === 'loca');
  let headFix = null;
  if (glyf?.transformed) {
    const { glyfData, locaData } = rebuildGlyf(glyf.data);
    out.push({ tag: 'glyf', data: glyfData }, { tag: 'loca', data: locaData });
    headFix = 1; // long loca
  }
  for (const t of dir) {
    if ((t.tag === 'glyf' || t.tag === 'loca') && glyf?.transformed) continue;
    if (t.transformed) throw new Error(`WOFF2 transform of ${t.tag} not supported`);
    let d = Buffer.from(t.data);
    if (t.tag === 'head') { d.writeUInt32BE(0, 8); if (headFix != null) d.writeInt16BE(headFix, 50); }
    out.push({ tag: t.tag, data: d });
  }
  void loca;
  return sfnt(flavor, out);
}

function rebuildGlyf(b) {
  const h = new Reader(b, 0);
  h.u16(); const opt = h.u16(), numGlyphs = h.u16(); h.u16();
  const sizes = []; for (let i = 0; i < 7; i++) sizes.push(h.u32());
  let o = h.o;
  const streams = sizes.map((n) => { const s = new Reader(b, o); o += n; return s; });
  const [nContour, nPoints, flagS, glyphS, compS, bboxS, instrS] = streams;
  void opt;
  const bitmapLen = 4 * Math.floor((numGlyphs + 31) / 32);
  const bboxBitmap = bboxS.bytes(bitmapLen);
  const hasBox = (i) => (bboxBitmap[i >> 3] & (0x80 >> (i & 7))) !== 0;
  const parts = [], offsets = [0];
  let total = 0;
  const push = (buf) => { const pad = (4 - (buf.length % 4)) % 4; parts.push(buf, Buffer.alloc(pad)); total += buf.length + pad; offsets.push(total); };
  for (let g = 0; g < numGlyphs; g++) {
    const nc = nContour.i16();
    if (nc === 0) { offsets.push(total); continue; }
    if (nc < 0) { // composite: copied as is, its bbox from the stream
      const start = compS.o;
      let flags, more = true, instr = false;
      while (more) {
        flags = compS.u16(); compS.u16();
        compS.o += flags & 1 ? 4 : 2;
        if (flags & 8) compS.o += 2; else if (flags & 0x40) compS.o += 4; else if (flags & 0x80) compS.o += 8;
        if (flags & 0x100) instr = true;
        more = (flags & 0x20) !== 0;
      }
      const comp = b.subarray(start, compS.o);
      const box = bboxS.bytes(8);
      let ins = Buffer.alloc(0), insHead = Buffer.alloc(0);
      if (instr) { const n = glyphS.u255(); insHead = Buffer.alloc(2); insHead.writeUInt16BE(n); ins = instrS.bytes(n); }
      const hd = Buffer.alloc(2); hd.writeInt16BE(-1);
      push(Buffer.concat([hd, box, comp, insHead, ins]));
      continue;
    }
    const ends = [];
    let np = 0;
    for (let c = 0; c < nc; c++) { np += nPoints.u255(); ends.push(np - 1); }
    const xs = new Int32Array(np), ys = new Int32Array(np), on = new Uint8Array(np);
    let x = 0, y = 0;
    for (let i = 0; i < np; i++) {
      let f = flagS.u8();
      on[i] = f >> 7 ? 0 : 1; f &= 0x7f;
      let dx, dy;
      const ws = (fl, v) => (fl & 1 ? v : -v);
      if (f < 10) { dx = 0; dy = ws(f, ((f & 14) << 7) + glyphS.u8()); }
      else if (f < 20) { dx = ws(f, (((f - 10) & 14) << 7) + glyphS.u8()); dy = 0; }
      else if (f < 84) { const b0 = f - 20, b1 = glyphS.u8(); dx = ws(f, 1 + (b0 & 0x30) + (b1 >> 4)); dy = ws(f >> 1, 1 + ((b0 & 0x0c) << 2) + (b1 & 0x0f)); }
      else if (f < 120) { const b0 = f - 84; dx = ws(f, 1 + (Math.floor(b0 / 12) << 8) + glyphS.u8()); dy = ws(f >> 1, 1 + (((b0 % 12) >> 2) << 8) + glyphS.u8()); }
      else if (f < 124) { const b1 = glyphS.u8(), b2 = glyphS.u8(), b3 = glyphS.u8(); dx = ws(f, (b1 << 4) + (b2 >> 4)); dy = ws(f >> 1, ((b2 & 0x0f) << 8) + b3); }
      else { const b1 = glyphS.u8(), b2 = glyphS.u8(), b3 = glyphS.u8(), b4 = glyphS.u8(); dx = ws(f, (b1 << 8) + b2); dy = ws(f >> 1, (b3 << 8) + b4); }
      x += dx; y += dy; xs[i] = x; ys[i] = y;
    }
    const nIns = glyphS.u255(), ins = instrS.bytes(nIns);
    let box;
    if (hasBox(g)) box = bboxS.bytes(8);
    else {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < np; i++) { x0 = Math.min(x0, xs[i]); y0 = Math.min(y0, ys[i]); x1 = Math.max(x1, xs[i]); y1 = Math.max(y1, ys[i]); }
      box = Buffer.alloc(8); box.writeInt16BE(x0, 0); box.writeInt16BE(y0, 2); box.writeInt16BE(x1, 4); box.writeInt16BE(y1, 6);
    }
    // plain encoding: a flag per point (on-curve bit only), int16 deltas
    const g0 = Buffer.alloc(10 + 2 * nc + 2 + nIns + np + 4 * np);
    let p = 0;
    g0.writeInt16BE(nc, p); p += 2; box.copy(g0, p); p += 8;
    for (const e of ends) { g0.writeUInt16BE(e, p); p += 2; }
    g0.writeUInt16BE(nIns, p); p += 2; ins.copy(g0, p); p += nIns;
    for (let i = 0; i < np; i++) g0[p++] = on[i];
    for (let i = 0; i < np; i++) { g0.writeInt16BE(xs[i] - (i ? xs[i - 1] : 0), p); p += 2; }
    for (let i = 0; i < np; i++) { g0.writeInt16BE(ys[i] - (i ? ys[i - 1] : 0), p); p += 2; }
    push(g0);
  }
  const locaData = Buffer.alloc(4 * offsets.length);
  offsets.forEach((v, i) => locaData.writeUInt32BE(v, i * 4));
  return { glyfData: Buffer.concat(parts), locaData };
}

// ---------------------------------------------------------------- the fonts
const BC = (f) => path.join(ROOT, 'node_modules/@fontsource/barlow-condensed/files', f);
const jobs = [
  ['barlow-condensed-500.ttf', BC('barlow-condensed-latin-500-normal.woff')],
  ['barlow-condensed-600.ttf', BC('barlow-condensed-latin-600-normal.woff')],
  ['barlow-condensed-700.ttf', BC('barlow-condensed-latin-700-normal.woff')],
  ['barlow-condensed-700-italic.ttf', BC('barlow-condensed-latin-700-italic.woff')],
  ['barlow-condensed-800-italic.ttf', BC('barlow-condensed-latin-800-italic.woff')],
  ['inter.ttf', path.join(ROOT, 'node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2')],
];
let bad = 0;
for (const [name, src] of jobs) {
  if (!fs.existsSync(src)) { console.error(`[fonts] missing ${path.relative(ROOT, src)} (run npm install in the repo root)`); bad++; continue; }
  const buf = fs.readFileSync(src);
  const ttf = src.endsWith('.woff2') ? woff2ToTtf(buf) : woffToTtf(buf);
  fs.writeFileSync(path.join(OUT, name), ttf);
  console.log(`[fonts] ${name} ${(ttf.length / 1024).toFixed(0)} KB`);
}
if (bad) process.exitCode = 1;
