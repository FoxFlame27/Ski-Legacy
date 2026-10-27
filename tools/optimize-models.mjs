// Re-export Meshy GLBs for the game with a GPU-memory budget per texture slot.
// Originals stay in assets-src/raw; optimized copies go to public/models.
//   node tools/optimize-models.mjs            -> only models whose original is newer / output missing
//   node tools/optimize-models.mjs --all      -> everything
//   node tools/optimize-models.mjs --only a,b -> just these (re-exported even when up to date)
// Meshy ships an emissive map the size of the base colour on almost every model, mostly pure black: such a map is
// dropped (with the emissive factor zeroed), which looks identical and frees its GPU memory (22 MB at 2048).
// Fresh Meshy downloads dropped into public/models (no meshopt compression yet) are archived first.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { dedup, prune, weld, textureCompress, meshopt } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'assets-src', 'raw');
const OUT = path.join(ROOT, 'public', 'models');
const all = process.argv.includes('--all');
const onlyArg = process.argv.indexOf('--only');
const only = onlyArg > 0 ? new Set(process.argv[onlyArg + 1].split(',').map((n) => n.trim().replace(/\.glb$/, '') + '.glb')) : null;

// [baseColor, normal, metallicRoughness/other] max texture sizes
const HERO = [2048, 1024, 512];   // seen up close: characters, skis, buildings
const PROP = [1024, 512, 256];    // small props, decor, trees, rocks, lift hardware
const ANIM = [64, 64, 64];        // animation packs: only the clips are used
const SMALL = [512, 256, 128];   // hand-sized props (lost items)
function budget(name) {
  if (/_anims\.glb$/.test(name)) return ANIM;
  if (/^(ski_glove|ski_goggles|beanie|compact_camera|smartphone|mail_bag)/.test(name)) return SMALL;
  if (/^ski_(cruiser|park|powder|touring|carver|gs|superg|legend)/.test(name)) return PROP;
  if (/^(skier_|ski_|rental_shop|hotel_chalet|mountain_hut|gondola_station|gondola_terminal|ticket_booth|shop_counter|rail_car2|rail_seat_pair|car_|driving_hand)/.test(name)) return HERO;
  // ridden in or walked right up to (the cabin / chair / heli you sit in, the lift huts you board at)
  if (/^(gondola_cabin|chairlift_chair|chair_terminal|chair_bullwheel|heli_body|lift_tower|patrol_hut|market_stall|job_board|snowcat)\.glb$/.test(name)) return HERO;
  return PROP;
}

await MeshoptEncoder.ready;
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder,
});

fs.mkdirSync(RAW, { recursive: true });
// archive fresh downloads
for (const f of fs.readdirSync(OUT).filter((f) => f.endsWith('.glb'))) {
  const p = path.join(OUT, f);
  if (!fs.readFileSync(p).includes('EXT_meshopt_compression')) {
    fs.copyFileSync(p, path.join(RAW, f));
    console.log('archived fresh download', f);
  }
}

// an emissive map that never lights anything up (max channel <= 32 of 255, or a few dim specks on black)
async function blackEmissive(tex) {
  try {
    const st = await sharp(Buffer.from(tex.getImage())).stats();
    const rgb = st.channels.slice(0, 3), max = Math.max(...rgb.map((c) => c.max)), mean = Math.max(...rgb.map((c) => c.mean));
    return max <= 32 || (mean < 1 && max < 96);
  } catch { return false; }
}

for (const f of fs.readdirSync(RAW).filter((f) => f.endsWith('.glb'))) {
  const src = path.join(RAW, f), dst = path.join(OUT, f);
  if (only ? !only.has(f) : !all && fs.existsSync(dst) && fs.statSync(dst).mtimeMs > fs.statSync(src).mtimeMs
      && fs.readFileSync(dst).includes('EXT_meshopt_compression')) continue;
  const [base, normal, other] = budget(f);
  const doc = await io.read(src);
  let dropped = 0;
  for (const m of doc.getRoot().listMaterials()) {
    const t = m.getEmissiveTexture();
    if (t && await blackEmissive(t)) { m.setEmissiveTexture(null); m.setEmissiveFactor([0, 0, 0]); dropped++; }
  }
  if (dropped) console.log(`  ${f}: black emissive map dropped`);
  await doc.transform(
    dedup(),
    prune(),
    weld(),
    // (a glow map needs no more detail than the normal map: lit windows, lamp glass)
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [base, base], slots: /^baseColorTexture$/ }),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [normal, normal], slots: /^normalTexture$|^emissiveTexture$/ }),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [other, other], slots: /^(?!baseColorTexture$|emissiveTexture$|normalTexture$).*/ }),
    meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
  );
  doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  await io.write(dst, doc);
  console.log(`exported ${f} -> ${Math.round(fs.statSync(dst).size / 1024)} KB [${base}/${normal}/${other}]`);
}
