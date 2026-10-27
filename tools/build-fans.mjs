// Turns the raw Meshy spectator rigs (assets-src/raw/fan_*.glb, from tools/meshy-fans.mjs) into the game's crowd
// models public/models/fan_*.glb, read by src/world/fans.js:
//  - primitive 0 (near LOD): the full textured mesh (~16.6k triangles: simplifying across Meshy's UV seams smears texels),
//    prop-budget textures (1024 base colour, 512 normal; no metal/roughness, emissive or tangents);
//  - primitives 1, 2 (mid / far LOD): the mesh welded by position and simplified much further (~2.4k / ~700
//    triangles), coloured per vertex with the area-averaged texture colour (Meshy atlases are cut into many
//    small UV islands, so a textured mesh cannot be reduced that far). Same skin, untextured material.
//   node tools/build-fans.mjs [fan_name ...]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { dedup, prune, weld, textureCompress, meshopt } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'assets-src', 'raw');
const OUT = path.join(ROOT, 'public', 'models');
const NEAR_RATIO = +(process.env.NEAR || 1); // Meshy UV seams do not survive simplification: the near LOD keeps every triangle
const FAR_TRIS = [3600, 1000];

await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready, MeshoptSimplifier.ready]);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });

const s2l = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const read = (acc) => { const n = acc.getCount(), k = acc.getElementSize(), out = new Float32Array(n * k), e = new Array(k); for (let i = 0; i < n; i++) { acc.getElement(i, e); for (let j = 0; j < k; j++) out[i * k + j] = e[j]; } return out; };

const only = process.argv.slice(2);
for (const f of fs.readdirSync(RAW).filter((f) => /^fan_.*\.glb$/.test(f) && (!only.length || only.includes(f.replace('.glb', ''))))) {
  const doc = await io.read(path.join(RAW, f));
  const root = doc.getRoot();
  const mat = root.listMaterials()[0];
  mat.setMetallicRoughnessTexture(null).setEmissiveTexture(null).setEmissiveFactor([0, 0, 0]).setMetallicFactor(0).setRoughnessFactor(0.86);
  for (const mesh of root.listMeshes()) for (const p of mesh.listPrimitives()) p.setAttribute('TANGENT', null);
  await doc.transform(dedup(), prune(), weld());

  const mesh = root.listMeshes()[0], full = mesh.listPrimitives()[0];
  const buffer = root.listBuffers()[0];
  const P = read(full.getAttribute('POSITION')), N = read(full.getAttribute('NORMAL')), UV = read(full.getAttribute('TEXCOORD_0'));
  const J = read(full.getAttribute('JOINTS_0')), W = read(full.getAttribute('WEIGHTS_0'));
  const idx = full.getIndices(), I = new Uint32Array(idx.getCount());
  for (let i = 0; i < I.length; i++) I[i] = idx.getScalar(i);
  const nv = P.length / 3;

  // texture colour (linear) for the untextured LODs
  const img = await sharp(Buffer.from(mat.getBaseColorTexture().getImage())).resize(512, 512).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const TW = img.info.width, TH = img.info.height, px = img.data;
  const tex = (u, v, out) => {
    const x = Math.min(TW - 1, Math.max(0, Math.floor(u * TW))), y = Math.min(TH - 1, Math.max(0, Math.floor(v * TH)));
    const o = (y * TW + x) * 3;
    out[0] += s2l(px[o] / 255); out[1] += s2l(px[o + 1] / 255); out[2] += s2l(px[o + 2] / 255);
  };

  // near LOD: seam-preserving simplification of the textured mesh
  const near = NEAR_RATIO >= 1 ? I : MeshoptSimplifier.simplify(I, P, 3, Math.floor((I.length * NEAR_RATIO) / 3) * 3, 0.02, [])[0];

  // weld by position -> representative vertex per position
  const key = new Map(), rep = new Uint32Array(nv);
  for (let i = 0; i < nv; i++) {
    const k = `${P[i * 3].toFixed(6)},${P[i * 3 + 1].toFixed(6)},${P[i * 3 + 2].toFixed(6)}`;
    if (!key.has(k)) key.set(k, i);
    rep[i] = key.get(k);
  }
  const reps = [...new Set(rep)], slot = new Map(reps.map((v, i) => [v, i]));
  // the simplifier needs a compact vertex list (unreferenced duplicates would lock the vertices they share)
  const PC = new Float32Array(reps.length * 3);
  reps.forEach((v, i) => PC.set(P.subarray(v * 3, v * 3 + 3), i * 3));
  const IW = I.map((v) => slot.get(rep[v]));
  // area-weighted colour samples per welded vertex (each triangle splats its texture colour to its corners)
  const col = new Float64Array(nv * 3), area = new Float64Array(nv), nrm = new Float64Array(nv * 3);
  const c = [0, 0, 0];
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t], b = I[t + 1], d = I[t + 2];
    const ex = P[b * 3] - P[a * 3], ey = P[b * 3 + 1] - P[a * 3 + 1], ez = P[b * 3 + 2] - P[a * 3 + 2];
    const fx = P[d * 3] - P[a * 3], fy = P[d * 3 + 1] - P[a * 3 + 1], fz = P[d * 3 + 2] - P[a * 3 + 2];
    const ar = 0.5 * Math.hypot(ey * fz - ez * fy, ez * fx - ex * fz, ex * fy - ey * fx);
    c[0] = c[1] = c[2] = 0;
    const S = [[1 / 3, 1 / 3, 1 / 3], [0.6, 0.2, 0.2], [0.2, 0.6, 0.2], [0.2, 0.2, 0.6]];
    for (const [wa, wb, wd] of S) tex(UV[a * 2] * wa + UV[b * 2] * wb + UV[d * 2] * wd, UV[a * 2 + 1] * wa + UV[b * 2 + 1] * wb + UV[d * 2 + 1] * wd, c);
    for (const v of [a, b, d]) {
      const r = rep[v];
      for (let k = 0; k < 3; k++) { col[r * 3 + k] += (c[k] / S.length) * ar; nrm[r * 3 + k] += N[v * 3 + k] * ar; }
      area[r] += ar;
    }
  }

  const lods = FAR_TRIS.map((tris) => {
    const [outC] = MeshoptSimplifier.simplify(IW, PC, 3, tris * 3, 0.5, []);
    const out = Array.from(outC, (i) => reps[i]);
    // compact the kept vertices
    const keep = [...new Set(out)], map = new Map(keep.map((v, i) => [v, i]));
    // every welded vertex lends its colour to the nearest kept vertex driven by the same main bone
    const main = (v) => { let bi = 0; for (let k = 1; k < 4; k++) if (W[v * 4 + k] > W[v * 4 + bi]) bi = k; return J[v * 4 + bi]; };
    const kc = new Float64Array(keep.length * 3), ka = new Float64Array(keep.length), kn = new Float64Array(keep.length * 3);
    const kb = keep.map(main);
    for (const v of reps) {
      if (!area[v]) continue;
      const mv = main(v);
      let best = -1, bd = Infinity, any = -1, ad = Infinity;
      for (let i = 0; i < keep.length; i++) {
        const k = keep[i];
        const d = (P[k * 3] - P[v * 3]) ** 2 + (P[k * 3 + 1] - P[v * 3 + 1]) ** 2 + (P[k * 3 + 2] - P[v * 3 + 2]) ** 2;
        if (d < ad) { ad = d; any = i; }
        if (kb[i] === mv && d < bd) { bd = d; best = i; }
      }
      const i = best >= 0 && bd < ad * 4 + 1e-9 ? best : any;
      for (let k = 0; k < 3; k++) { kc[i * 3 + k] += col[v * 3 + k]; kn[i * 3 + k] += nrm[v * 3 + k]; }
      ka[i] += area[v];
    }
    const pos = new Float32Array(keep.length * 3), nor = new Float32Array(keep.length * 3), clr = new Float32Array(keep.length * 3);
    const jo = new Uint8Array(keep.length * 4), we = new Float32Array(keep.length * 4);
    keep.forEach((v, i) => {
      for (let k = 0; k < 3; k++) { pos[i * 3 + k] = P[v * 3 + k]; clr[i * 3 + k] = ka[i] ? kc[i * 3 + k] / ka[i] : 0.5; }
      const l = Math.hypot(kn[i * 3], kn[i * 3 + 1], kn[i * 3 + 2]) || 1;
      for (let k = 0; k < 3; k++) nor[i * 3 + k] = kn[i * 3 + k] / l;
      for (let k = 0; k < 4; k++) { jo[i * 4 + k] = J[v * 4 + k]; we[i * 4 + k] = W[v * 4 + k]; }
    });
    return { pos, nor, clr, jo, we, idx: Uint16Array.from(out, (v) => map.get(v)), tris: out.length / 3 };
  });

  full.setIndices(doc.createAccessor().setArray(nv < 65536 ? Uint16Array.from(near) : near).setType('SCALAR').setBuffer(buffer));
  const flat = doc.createMaterial('FanLod').setBaseColorFactor([1, 1, 1, 1]).setMetallicFactor(0).setRoughnessFactor(0.86).setDoubleSided(mat.getDoubleSided());
  for (const l of lods) {
    const acc = (arr, type) => doc.createAccessor().setArray(arr).setType(type).setBuffer(buffer);
    const p = doc.createPrimitive().setMaterial(flat).setIndices(acc(l.idx, 'SCALAR'))
      .setAttribute('POSITION', acc(l.pos, 'VEC3')).setAttribute('NORMAL', acc(l.nor, 'VEC3')).setAttribute('COLOR_0', acc(l.clr, 'VEC3'))
      .setAttribute('JOINTS_0', acc(l.jo, 'VEC4')).setAttribute('WEIGHTS_0', acc(l.we, 'VEC4'));
    mesh.addPrimitive(p);
  }
  await doc.transform(
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024], slots: /^baseColorTexture$/ }),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [512, 512], slots: /^normalTexture$/ }),
    prune(),
    meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
  );
  doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  const dst = path.join(OUT, f);
  await io.write(dst, doc);
  console.log(`${f}: ${I.length / 3} tris -> near ${near.length / 3}, mid ${lods[0].tris}, far ${lods[1].tris}; ${Math.round(fs.statSync(dst).size / 1024)} KB`);
}
