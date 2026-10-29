// Generates the piste fence models on Meshy (text-to-3d preview -> refine), very low poly (they are instanced
// along tens of kilometres of fence), downloads raw GLBs to assets-src/raw/piste and writes optimised copies to
// public/models/piste (used by src/world/pistefence.js).
// Resumable: task ids live in tools/meshy-piste-state.json.
// Usage: NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt node tools/meshy-piste.mjs [id ...]
//        ... --redo id ...   (discard old tasks for those ids)
//        ... --optimize      (only re-run the optimiser on downloaded raws)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_FILE = path.join(ROOT, 'tools', 'meshy-piste-state.json');
const OUT_DIR = path.join(ROOT, 'public', 'models', 'piste');
const RAW_DIR = path.join(ROOT, 'assets-src', 'raw', 'piste');
const API = 'https://api.meshy.ai/openapi';
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(RAW_DIR, { recursive: true });

const STYLE = 'standing alone on nothing, no snow, no ground, no base plate, no background, no text, realistic, low poly game asset';
// polys: Meshy target; tris: the hard budget after optimisation (runtime instancing budget)
const ASSETS = [
  {
    id: 'bnet_panel', polys: 300, tris: 300,
    prompt: 'A single straight section of ski race safety B-net fence, seen from the front: a flat rectangular bright orange plastic mesh net panel 3.5 metres wide and 1.6 metres tall stretched between two thin dark grey metal posts at the left and right ends, with an orange hem along the top edge, perfectly flat and thin',
    tex: 'bright fluorescent orange plastic safety netting with a fine square diamond mesh pattern, dark grey metal posts, clean realistic game textures',
  },
  {
    id: 'flag_pole', polys: 150, tris: 150,
    prompt: 'A single thin straight ski piste marker pole 1.9 metres tall, a slim plastic pole with a small rectangular orange cloth flag attached near the top',
    tex: 'glossy orange and white plastic pole, bright orange nylon flag, clean realistic game textures',
  },
  {
    id: 'rope_pole', polys: 150, tris: 150,
    prompt: 'A single thin straight ski slope rope line stake 1.2 metres tall, a slim orange and white striped plastic pole with a small triangular yellow pennant flag at the top',
    tex: 'glossy orange and white striped plastic pole, bright yellow nylon pennant flag, clean realistic game textures',
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
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
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
    const m = [...out.matchAll(/,TRIANGLES,\d+,(\d+),/g)]; // (MESHES rows: mode, meshPrimitives, glPrimitives)
    return m.length ? m.reduce((s, x) => s + +x[1], 0) : -1;
  } catch { return -1; }
}

function optimize(a) {
  const raw = path.join(RAW_DIR, `${a.id}.glb`);
  const out = path.join(OUT_DIR, `${a.id}.glb`);
  if (!fs.existsSync(raw)) return;
  for (const ratio of [1, 0.6, 0.4, 0.25, 0.15]) {
    execFileSync('npx', ['gltf-transform', 'optimize', raw, out,
      '--texture-compress', 'webp', '--texture-size', '512', '--compress', 'meshopt',
      '--simplify-ratio', String(ratio), '--simplify-error', '0.02'], { cwd: ROOT, stdio: 'ignore' });
    const t = triCount(out);
    log(`${a.id}: ratio ${ratio} -> ${t} tris, ${Math.round(fs.statSync(out).size / 1024)} KB`);
    if (t > 0 && t <= a.tris) break;
  }
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
  await waitTask(s.preview, id);
  if (!s.refine) {
    s.refine = (await api('POST', '/v2/text-to-3d', {
      mode: 'refine', preview_task_id: s.preview, enable_pbr: false,
      texture_prompt: a.tex.slice(0, 600), target_formats: ['glb'],
    })).result;
    saveState();
    log(`${id}: refine started`);
  }
  const refined = await waitTask(s.refine, id);
  await download(refined.model_urls.glb, path.join(RAW_DIR, `${id}.glb`));
  optimize(a);
  s.done = true;
  saveState();
}

const args = process.argv.slice(2);
if (args[0] === '--optimize') {
  for (const a of ASSETS) if (args.length < 2 || args.includes(a.id)) optimize(a);
  process.exit(0);
}
if (args[0] === '--redo') {
  args.shift();
  for (const n of args) delete state[n];
  saveState();
}
KEY = loadKey();
const selected = args.length ? ASSETS.filter((a) => args.includes(a.id)) : ASSETS;
const queue = selected.filter((a) => !state[a.id]?.done || !fs.existsSync(path.join(OUT_DIR, `${a.id}.glb`)));
log(`building ${queue.length} piste models`);
const failed = [];
await Promise.all(queue.map(async (a) => {
  try { await build(a); } catch (e) { failed.push(a.id); log(`FAILED ${a.id}: ${e.message}`); }
}));
log(failed.length ? `finished, ${failed.length} failed: ${failed.join(', ')}` : 'ALL PISTE MODELS DONE');
