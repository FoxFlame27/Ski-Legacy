// Prints the final in-game W x D x H (metres) of every catalog item: each GLB's bounds run through the same
// fitScales() the game uses (src/game/build/placement.js). Usage: node tools/furniture-sizes.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { getBounds } from '@gltf-transform/functions';
import { MeshoptDecoder } from 'meshoptimizer';
import { FURNITURE } from '../src/game/build/catalog.js';
import { fitScales } from '../src/game/build/placement.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const f2 = (v) => v.toFixed(2).padStart(5);
console.log('id                 W     D     H    catalog W×D×H     KB');
for (const item of FURNITURE) {
  const file = path.join(ROOT, 'public/models/furniture', `${item.id}.glb`);
  const [w, h, d] = item.size;
  if (!fs.existsSync(file)) { console.log(`${item.id.padEnd(16)}  (no model: box ${w}×${d}×${h})`); continue; }
  const doc = await io.read(file);
  const b = getBounds(doc.getRoot().getDefaultScene());
  const raw = [0, 1, 2].map((i) => b.max[i] - b.min[i]);
  const fit = fitScales(item, raw);
  let [x, y, z] = raw;
  if (fit.layFlat) [y, z] = [z, y];
  if (fit.turn) [x, z] = [z, x];
  const [sx, sy, sz] = fit.scale;
  console.log(`${item.id.padEnd(16)} ${f2(x * sx)} ${f2(z * sz)} ${f2(y * sy)}   ${f2(w)}×${f2(d)}×${f2(h)}  ${String(Math.round(fs.statSync(file).size / 1024)).padStart(4)}`);
}
