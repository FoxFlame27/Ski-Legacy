// Re-sharpen shipped Meshy models from their originals in assets-src/raw/** (Nov 1 2026, the user: "why are so many
// models so blurry and weird ... fix ALL those"). The interior / decor sets were exported at 512 px (furniture,
// bathroom, lamps, train seats, piste poles, snow) or 1024 px (hospital, prison, garage decor) although Meshy delivered
// 2048 px maps. This swaps each shipped texture for the original image at a larger cap, as high-quality webp; the
// shipped geometry (simplified / trimmed meshes, node layout) is left exactly as it is, so nothing that sizes or
// places the models changes. Each shipped map is matched to its original by image content (a 16 px thumbnail), so
// renamed exports (lamps/chandelier from chandelier_a / _b, garden/, snow/, bathroom/) find their source.
// The game still downsizes these at load on the lighter presets (quality.texCap: Super Performance 512, Performance
// 1024, Balanced 2048), so only Balanced and up get the extra detail.
//   node tools/upres-textures.mjs            -> every entry below
//   node tools/upres-textures.mjs --dry      -> report matches / sizes only
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'assets-src', 'raw');
const OUT = path.join(ROOT, 'public', 'models');
const dry = process.argv.includes('--dry');

// [base colour, normal / emissive, other] caps. BIG: walked up to / sat on in interiors, large surfaces;
// NEAR: smaller pieces seen within a few metres.
const BIG = [2048, 2048, 1024], NEAR = [1024, 1024, 512];
const big = new Set([
  'furniture/armchair', 'furniture/sofa', 'furniture/double_bed', 'furniture/single_bed', 'furniture/wardrobe',
  'furniture/bookshelf', 'furniture/kitchen_counter', 'furniture/kitchen_sink', 'furniture/dining_table',
  'furniture/desk', 'furniture/fireplace_stove', 'furniture/stove', 'furniture/fridge', 'furniture/blanket_chest',
  'furniture/tv_unit', 'furniture/rug',
  'bathroom/bathtub', 'bathroom/shower', 'bathroom/washbasin', 'bathroom/toilet',
  'hospital/hospital_bed', 'hospital/reception_desk', 'hospital/waiting_bench', 'hospital/privacy_screen',
  'prison/bunk_bed', 'prison/guard_desk', 'prison/visit_desk', 'prison/cell_toilet',
  'train/train_double_seat',
  'decor/garage_workbench', 'decor/garage_lift', 'decor/garage_toolwall', 'decor/garage_tyres', 'decor/garage_drums',
  'decor/grit_box', 'decor/parking_sign', 'decor/plant_ficus', 'decor/plant_monstera', 'decor/planter_spruce',
  'ski_pistenfuchs',
]);
// shipped model -> raw folder(s) holding its original
const SETS = {
  furniture: ['furniture'], bathroom: ['chalet'], lamps: ['chalet'], garden: ['chalet'], snow: ['decor'],
  decor: ['decor'], hospital: ['hospital'], prison: ['prison'], train: ['train'], piste: ['piste'], '': ['skis'],
};
const SKIP = /gondola|police|_anims/; // (gondola stations are being replaced; police maps already ship at 2048)

await MeshoptEncoder.ready;
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder,
});

const thumb = async (buf) => sharp(Buffer.from(buf)).resize(16, 16, { fit: 'fill' }).removeAlpha().raw().toBuffer();
const diff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2; return Math.sqrt(s / a.length); };
function slotOf(doc, tex) {
  for (const m of doc.getRoot().listMaterials()) {
    if (m.getBaseColorTexture() === tex) return 0;
    if (m.getNormalTexture() === tex || m.getEmissiveTexture() === tex) return 1;
  }
  return 2;
}

// originals: every texture of every raw GLB in the folders, with its thumbnail
const rawCache = new Map();
async function originals(dir) {
  if (rawCache.has(dir)) return rawCache.get(dir);
  const list = [];
  const d = path.join(RAW, dir);
  for (const f of fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.glb')) : []) {
    const doc = await io.read(path.join(d, f));
    for (const t of doc.getRoot().listTextures()) {
      const img = t.getImage();
      if (!img) continue;
      list.push({ file: `${dir}/${f}`, slot: slotOf(doc, t), size: t.getSize(), img, th: await thumb(img) });
    }
  }
  rawCache.set(dir, list);
  return list;
}

let before = 0, after = 0;
for (const [set, dirs] of Object.entries(SETS)) {
  const outDir = path.join(OUT, set);
  const files = fs.readdirSync(outDir).filter((f) => f.endsWith('.glb'));
  const pool = (await Promise.all(dirs.map(originals))).flat();
  for (const f of files) {
    const key = (set ? set + '/' : '') + f.replace(/\.glb$/, '');
    if (SKIP.test(key)) continue;
    const stem = f.replace(/\.glb$/, '');
    const cands = pool.filter((o) => path.basename(o.file, '.glb').replace(/_[a-d]$/, '') === stem);
    if (!cands.length) continue;
    const caps = big.has(key) ? BIG : NEAR;
    const dst = path.join(outDir, f);
    const size0 = fs.statSync(dst).size;
    const doc = await io.read(dst);
    let changed = 0;
    const notes = [];
    for (const t of doc.getRoot().listTextures()) {
      const img = t.getImage(), sz = t.getSize();
      if (!img || !sz) continue;
      const slot = slotOf(doc, t), th = await thumb(img);
      let best = null, bd = 1e9;
      for (const o of cands) { if (o.slot !== slot) continue; const d = diff(th, o.th); if (d < bd) { bd = d; best = o; } }
      const cap = caps[slot];
      if (!best || bd > 18) { notes.push(`no match (${bd.toFixed(1)})`); continue; }
      const target = Math.min(cap, Math.max(...best.size));
      if (target <= Math.max(...sz)) { notes.push(`${Math.max(...sz)} kept`); continue; }
      if (!dry) {
        const q = slot === 1 ? 95 : 92;
        const out = await sharp(Buffer.from(best.img)).resize(target, target, { fit: 'inside', withoutEnlargement: true, kernel: 'lanczos3' })
          .webp({ quality: q, effort: 5, smartSubsample: true }).toBuffer();
        t.setImage(new Uint8Array(out)).setMimeType('image/webp');
        if (t.getURI()) t.setURI(t.getURI().replace(/\.(png|jpe?g)$/i, '.webp'));
      }
      changed++;
      notes.push(`${Math.max(...sz)}->${target} (${path.basename(best.file)}, d${bd.toFixed(1)})`);
    }
    if (changed && !dry) await io.write(dst, doc);
    const size1 = fs.statSync(dst).size;
    before += size0; after += size1;
    console.log(`${key}: ${notes.join(', ')}  ${Math.round(size0 / 1024)} -> ${Math.round(size1 / 1024)} KB`);
  }
}
console.log(`total ${(before / 1048576).toFixed(1)} -> ${(after / 1048576).toFixed(1)} MB`);
