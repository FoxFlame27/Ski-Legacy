// Writing native/data files: every exported .bin / .json goes out zstd-compressed as `<name>.zst` (the C++ reads it
// through AssetPaths::readData, which inflates `<name>.zst` or falls back to a plain `<name>`). Node >= 22.15 has
// zlib.zstdCompressSync; an older Node writes the plain file (bigger, still read by the game).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const HAVE_ZSTD = typeof zlib.zstdCompressSync === 'function';
let warned = false;
// level 19 with a window up to 128 MB (the C++ inflates in one shot into a buffer of the frame's content size)
const LEVEL = Number(process.env.SL_ZSTD_LEVEL || 19);

/** Write `buf` (Buffer / typed array / string) as dir/name.zst (or dir/name without zstd). Returns the bytes written. */
export function writeData(dir, name, buf) {
  const b = typeof buf === 'string' ? Buffer.from(buf, 'utf8') : Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  const plain = path.join(dir, name), packed = plain + '.zst';
  if (!HAVE_ZSTD) {
    if (!warned) { console.warn('[data] this Node has no zstd (needs >= 22.15): writing uncompressed data'); warned = true; }
    fs.writeFileSync(plain, b);
    fs.rmSync(packed, { force: true });
    return b.length;
  }
  const C = zlib.constants;
  const windowLog = Math.max(10, Math.min(27, Math.ceil(Math.log2(Math.max(1024, b.length)))));
  const z = zlib.zstdCompressSync(b, { params: { [C.ZSTD_c_compressionLevel]: LEVEL, [C.ZSTD_c_windowLog]: windowLog, [C.ZSTD_c_checksumFlag]: 1 } });
  fs.writeFileSync(packed, z);
  fs.rmSync(plain, { force: true }); // (a stale plain file would shadow nothing, but wastes space)
  return z.length;
}

/** Tile prediction filter for int16 height grids (S1 x S1): Paeth-free planar predictor (left + up - up-left),
 *  zig-zag, then the low bytes and the high bytes as two planes. Lossless; the C++ undoes it (world.cpp unfilter). */
export function filterGrid(v, S1) {
  const N = S1 * S1, lo = Buffer.alloc(N), hi = Buffer.alloc(N);
  for (let j = 0; j < S1; j++) for (let i = 0; i < S1; i++) {
    const k = j * S1 + i;
    const p = i && j ? v[k - 1] + v[k - S1] - v[k - S1 - 1] : i ? v[k - 1] : j ? v[k - S1] : 0;
    const r = ((v[k] - p) << 16) >> 16, z = ((r << 1) ^ (r >> 15)) & 0xffff;
    lo[k] = z & 255; hi[k] = z >> 8;
  }
  return Buffer.concat([lo, hi]);
}
