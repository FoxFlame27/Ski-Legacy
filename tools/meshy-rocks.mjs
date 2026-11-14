// Generates the alpine ROCK models on Meshy (text-to-3d preview -> refine, PBR: base colour + normal + roughness): the
// boulders, slabs, crag pieces and scree the mountains are dressed with (world/boulders.js, placed by
// world/vegetation.js; the C++ port draws the same GLBs: native/src/world/scenery.cpp). Bare rock, no snow: the snow
// on their tops is the shaders' (it follows how each rock lies, and the weather), like the terrain's.
// Raw GLBs go to assets-src/raw/rocks, optimised copies to public/models/rocks/<id>.glb (webp, meshopt) and a light
// distant level <id>_lo.glb (~1/8 of the triangles, small textures) beside it; the thumbnails to assets-src/raw/rocks.
// Resumable: task ids live in tools/meshy-rocks-state.json.
// Usage: NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt node tools/meshy-rocks.mjs [id ...]
//        ... --redo id ...       (discard old tasks for those ids)
//        ... --optimize [id ...] (only re-run the optimiser on downloaded raws)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_FILE = path.join(ROOT, 'tools', 'meshy-rocks-state.json');
const RAW_DIR = path.join(ROOT, 'assets-src', 'raw', 'rocks');
const OUT_DIR = path.join(ROOT, 'public', 'models', 'rocks');
const API = 'https://api.meshy.ai/openapi';
fs.mkdirSync(RAW_DIR, { recursive: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

const STYLE = 'a single isolated natural rock, photorealistic photogrammetry scan, real geology, flat cut underside where it sits in the ground, no snow, no moss carpet, no grass, no plants, no ground plane, no base plate, no background';
const TEX = 'photorealistic photogrammetry scan texture of real mountain rock, natural muted colours, uniform fine mineral grain, subtle tonal variation, crisp sharp detail, matte, no snow, no moss, no spots, no stripes, no paint, not stylised, not cartoon';
// polys: Meshy's target (remeshed); tris: the budget of the close level after optimisation; px: its texture size; far:
// the distant level's share of the triangles (default 0.12). (A long low bedrock outcrop was tried three times and
// dropped: Meshy made a mini mountain, then masonry; the big slab and boulder, sunk deep, make the outcrops instead.)
const ASSETS = [
  {
    id: 'granite_boulder', polys: 4000, tris: 3000, px: 1024,
    prompt: 'A large weathered alpine granite boulder, a glacial erratic about 3 metres wide and 2 metres tall, massive rounded blocky shape with broad gently curved faces, softened edges, a few deep natural fractures and a chipped corner',
    tex: `medium grey weathered granite with a fine salt-and-pepper grain of tiny grey and black crystals, slightly darker grey in the cracks and on the lower faces, ${TEX}`,
  },
  {
    id: 'limestone_block', polys: 4000, tris: 3000, px: 1024,
    prompt: 'A large angular block of broken grey mountain rock about 2.5 metres wide and 1.5 metres tall, a heavy boulder fallen from a cliff, broken along natural joints into a few flat fracture faces meeting at worn rounded edges, rough uneven surface',
    tex: `medium-dark grey weathered limestone rock with natural tonal variation from blue-grey to brownish grey, darker grey rain streaks, rough granular surface, ${TEX}`,
  },
  {
    id: 'gneiss_slab', polys: 3000, tris: 2400, px: 1024,
    prompt: 'A long flat tilted slab of alpine gneiss bedrock about 4 metres long, 2.5 metres wide and 0.8 metres thick, a low tabular rock plate with a gently sloping weathered top, stepped broken edges and thin foliated layers along its sides',
    tex: `dark grey and silver banded gneiss with wavy light and dark mineral layers, mica glints, weathered grey top surface, faint lichen, ${TEX}`,
  },
  {
    id: 'crag_spire', polys: 5000, tris: 3600, px: 1024,
    prompt: 'A tall upright weathered alpine granite rock about 4 metres tall and 2.5 metres wide, a massive irregular standing boulder with broad rough faces, a few deep natural cracks and a chipped corner, weathered rounded edges, wider at its base',
    tex: `dark grey and silver-grey granite gneiss rock with a fine even mineral grain and subtle darker weathering, uniform natural rock colour like the surrounding cliff, no drawn lines, no black cracks, ${TEX}`,
  },
  {
    id: 'scree_pile', polys: 5000, tris: 3600, px: 1024, far: 0.3,
    prompt: 'A small loose heap of angular broken rocks, alpine talus scree about 3 metres across and 0.7 metres high, about fifteen sharp-edged rock fragments of different sizes from 10 to 60 centimetres tumbled together in a low pile with a flat underside',
    tex: `medium and dark grey freshly broken granite rock fragments, slightly lighter grey fracture faces, ${TEX}`,
  },
];

function loadKey() {
  if (process.env.MESHY_API_KEY) return process.env.MESHY_API_KEY;
  const env = fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8');
  const m = env.match(/MESHY_API_KEY=(\S+)/);
  if (!m) throw new Error('MESHY_API_KEY missing from .env.local');
  return m[1];
}

const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let KEY = null;

async function api(method, url, body) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(API + url, {
        method,
        headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      if (attempt < 10) { await sleep(5000); continue; }
      throw e;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 40) { await sleep(10000); continue; }
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  }
}

async function waitTask(id, name) {
  for (;;) {
    const t = await api('GET', `/v2/text-to-3d/${id}`);
    if (t.status === 'SUCCEEDED') return t;
    if (t.status === 'FAILED' || t.status === 'CANCELED') throw new Error(`${name} ${t.status}: ${JSON.stringify(t.task_error)}`);
    await sleep(8000);
  }
}

async function download(url, file) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`download -> ${res.status}`);
      fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      return;
    } catch (e) { if (i > 4) throw e; await sleep(4000); }
  }
}

// triangle count of a GLB (gltf-transform inspect --format csv)
function triCount(file) {
  try {
    const out = execFileSync('npx', ['gltf-transform', 'inspect', file, '--format', 'csv'], { cwd: ROOT, encoding: 'utf8' });
    const m = [...out.matchAll(/,TRIANGLES,\d+,(\d+),/g)];
    return m.length ? m.reduce((s, x) => s + +x[1], 0) : -1;
  } catch { return -1; }
}

function optimizeTo(raw, out, px, ratio, error) {
  execFileSync('npx', ['gltf-transform', 'optimize', raw, out,
    '--texture-compress', 'webp', '--texture-size', String(px), '--compress', 'meshopt',
    '--simplify-ratio', String(ratio), '--simplify-error', String(error)], { cwd: ROOT, stdio: 'ignore' });
}

// The close level: webp textures at a.px, meshopt, simplified toward a.tris (Meshy's UV seams stop it short of that
// on some). Meshy's emissive map (a copy of the albedo) is dropped first: rocks don't glow.
async function optimize(a) {
  const src = path.join(RAW_DIR, `${a.id}.glb`);
  if (!fs.existsSync(src)) return;
  const raw = path.join(RAW_DIR, `${a.id}.noemit.glb`);
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const doc = await io.read(src);
  for (const m of doc.getRoot().listMaterials()) m.setEmissiveTexture(null).setEmissiveFactor([0, 0, 0]);
  for (const t of doc.getRoot().listTextures()) if (!t.listParents().some((p) => p.propertyType === 'Material')) t.dispose();
  await io.write(raw, doc);
  const out = path.join(OUT_DIR, `${a.id}.glb`);
  for (const ratio of [1, 0.75, 0.55, 0.4]) {
    optimizeTo(raw, out, a.px, ratio, 0.005);
    const t = triCount(out);
    log(`${a.id}: ratio ${ratio} -> ${t} tris, ${Math.round(fs.statSync(out).size / 1024)} KB`);
    if (t > 0 && t <= a.tris) break;
  }
  fs.rmSync(raw, { force: true });
}

// The distant level: Meshy's UV atlas is cut into many islands, so a simplifier that keeps the texture can hardly
// remove a triangle (it stalls at ~half); far off the texture is a few pixels anyway. So: the base colour is sampled
// onto the vertices (a small box filter round each one's UV), the vertices welded by position (seams gone, colours and
// normals averaged), simplified to `ratio` of the triangles, and written with vertex colours and no texture at all.
async function farLevel(a) {
  const ratio = a.far ?? 0.12;
  const raw = path.join(RAW_DIR, `${a.id}.glb`), lo = path.join(OUT_DIR, `${a.id}_lo.glb`), tmp = lo + '.tmp.glb';
  if (!fs.existsSync(raw)) return;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const doc = await io.read(raw);
  const root = doc.getRoot();
  const node = root.listNodes().find((n) => n.getMesh());
  const prim = node.getMesh().listPrimitives()[0];
  const M = node.getWorldMatrix();
  const P = prim.getAttribute('POSITION'), N = prim.getAttribute('NORMAL'), UV = prim.getAttribute('TEXCOORD_0');
  const tex = prim.getMaterial().getBaseColorTexture();
  const img = await sharp(Buffer.from(tex.getImage())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = img.info.width, Hh = img.info.height, px = img.data;
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const sample = (u, v) => { // (linear, box filtered over 9 x 9 texels)
    const cx = Math.floor((u - Math.floor(u)) * W), cy = Math.floor((v - Math.floor(v)) * Hh), c = [0, 0, 0];
    let n = 0;
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = Math.min(W - 1, Math.max(0, cx + dx)), y = Math.min(Hh - 1, Math.max(0, cy + dy)), o = (y * W + x) * 4;
      c[0] += lin(px[o]); c[1] += lin(px[o + 1]); c[2] += lin(px[o + 2]); n++;
    }
    return c.map((x) => x / n);
  };
  const tr = (x, y, z, w) => [M[0] * x + M[4] * y + M[8] * z + M[12] * w, M[1] * x + M[5] * y + M[9] * z + M[13] * w, M[2] * x + M[6] * y + M[10] * z + M[14] * w];
  const count = P.getCount(), ext = [Infinity, -Infinity];
  const pos = [], nor = [], col = [];
  for (let i = 0; i < count; i++) {
    const p = P.getElement(i, []), n = N.getElement(i, []), uv = UV.getElement(i, []);
    const q = tr(p[0], p[1], p[2], 1), m = tr(n[0], n[1], n[2], 0), l = Math.hypot(m[0], m[1], m[2]) || 1;
    pos.push(q); nor.push(m.map((x) => x / l)); col.push(sample(uv[0], uv[1]));
    for (const x of q) { ext[0] = Math.min(ext[0], x); ext[1] = Math.max(ext[1], x); }
  }
  // weld by position (1e-4 of the size)
  const eps = (ext[1] - ext[0]) * 1e-4, map = new Map(), remap = new Uint32Array(count), wp = [], wn = [], wc = [], wk = [];
  for (let i = 0; i < count; i++) {
    const k = pos[i].map((x) => Math.round(x / eps)).join(',');
    let j = map.get(k);
    if (j === undefined) { j = wp.length; map.set(k, j); wp.push(pos[i]); wn.push([0, 0, 0]); wc.push([0, 0, 0]); wk.push(0); }
    remap[i] = j;
    for (let c = 0; c < 3; c++) { wn[j][c] += nor[i][c]; wc[j][c] += col[i][c]; }
    wk[j]++;
  }
  const idx = prim.getIndices().getArray(), I = new Uint32Array(idx.length);
  for (let i = 0; i < idx.length; i++) I[i] = remap[idx[i]];
  await MeshoptSimplifier.ready;
  const flat = new Float32Array(wp.flat());
  const target = Math.max(36, Math.floor((I.length / 3) * ratio) * 3);
  const [S] = MeshoptSimplifier.simplify(I, flat, 3, target, 0.05, []);
  // compact the vertices still used
  const used = new Map(), oP = [], oN = [], oC = [];
  const oI = new Uint32Array(S.length);
  for (let i = 0; i < S.length; i++) {
    let j = used.get(S[i]);
    if (j === undefined) {
      j = used.size; used.set(S[i], j);
      const v = S[i], n = wn[v], l = Math.hypot(n[0], n[1], n[2]) || 1;
      oP.push(...wp[v]); oN.push(n[0] / l, n[1] / l, n[2] / l); oC.push(...wc[v].map((x) => x / wk[v]), 1);
    }
    oI[i] = j;
  }
  // a fresh document: one mesh, vertex colours, a plain rough material
  const { Document } = await import('@gltf-transform/core');
  const out = new Document();
  const buf = out.createBuffer();
  const acc = (type, arr) => out.createAccessor().setType(type).setArray(arr).setBuffer(buf);
  const mat = out.createMaterial('rock_far').setBaseColorFactor([1, 1, 1, 1]).setRoughnessFactor(1).setMetallicFactor(0);
  const pr = out.createPrimitive().setMaterial(mat).setIndices(acc('SCALAR', oI))
    .setAttribute('POSITION', acc('VEC3', new Float32Array(oP))).setAttribute('NORMAL', acc('VEC3', new Float32Array(oN)))
    .setAttribute('COLOR_0', acc('VEC4', new Float32Array(oC)));
  out.createScene().addChild(out.createNode().setMesh(out.createMesh().addPrimitive(pr)));
  await new NodeIO().write(tmp, out);
  execFileSync('npx', ['gltf-transform', 'meshopt', tmp, lo], { cwd: ROOT, stdio: 'ignore' });
  fs.rmSync(tmp, { force: true });
  log(`${a.id}_lo: ${S.length / 3} tris (of ${idx.length / 3}), ${Math.round(fs.statSync(lo).size / 1024)} KB`);
}

async function build(a) {
  const id = a.id;
  const s = (state[id] ??= {});
  if (!s.preview) {
    s.preview = (await api('POST', '/v2/text-to-3d', {
      mode: 'preview', prompt: `${a.prompt}, ${STYLE}`.slice(0, 600), ai_model: 'meshy-6', art_style: 'realistic',
      should_remesh: true, topology: 'triangle', target_polycount: a.polys, target_formats: ['glb'],
    })).result;
    saveState();
    log(`${id}: preview started`);
  }
  const pv = await waitTask(s.preview, id);
  if (pv.thumbnail_url && !fs.existsSync(path.join(RAW_DIR, `${id}_preview.png`))) await download(pv.thumbnail_url, path.join(RAW_DIR, `${id}_preview.png`)).catch(() => {});
  log(`${id}: preview done`);
  if (!s.refine) {
    s.refine = (await api('POST', '/v2/text-to-3d', {
      mode: 'refine', preview_task_id: s.preview, enable_pbr: true, texture_resolution: '2k',
      texture_prompt: a.tex.slice(0, 600), target_formats: ['glb'],
    })).result;
    saveState();
    log(`${id}: refine started`);
  }
  const refined = await waitTask(s.refine, id);
  await download(refined.model_urls.glb, path.join(RAW_DIR, `${id}.glb`));
  if (refined.thumbnail_url) await download(refined.thumbnail_url, path.join(RAW_DIR, `${id}.png`)).catch(() => {});
  await optimize(a);
  await farLevel(a);
  s.done = true;
  saveState();
}

const args = process.argv.slice(2);
if (args[0] === '--optimize') {
  for (const a of ASSETS) if (args.length < 2 || args.includes(a.id)) { await optimize(a); await farLevel(a); }
  process.exit(0);
}
if (args[0] === '--redo') {
  args.shift();
  for (const n of args) delete state[n];
  saveState();
}
KEY = loadKey();
try { log('credits:', (await api('GET', '/v1/balance')).balance); } catch { /* (no balance endpoint) */ }
const selected = args.length ? ASSETS.filter((a) => args.includes(a.id)) : ASSETS;
const queue = selected.filter((a) => !state[a.id]?.done || !fs.existsSync(path.join(OUT_DIR, `${a.id}.glb`)));
log(`building ${queue.length} rock models`);
const failed = [];
await Promise.all(queue.map(async (a) => {
  try { await build(a); } catch (e) { failed.push(a.id); log(`FAILED ${a.id}: ${e.message}`); }
}));
log(failed.length ? `finished, ${failed.length} failed: ${failed.join(', ')}` : 'ALL ROCK MODELS DONE');
try { log('credits left:', (await api('GET', '/v1/balance')).balance); } catch { /* */ }
