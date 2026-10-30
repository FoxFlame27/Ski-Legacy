// Generates the HOSPITAL interior models on Meshy (text-to-3d preview -> refine): the furniture of the medical
// centre's patient room and its reception (game/hospitalroom.js). Raw GLBs go to assets-src/raw/hospital, optimised
// copies (webp textures, meshopt) to public/models/hospital. Every piece has a procedural stand-in in
// hospitalroom.js until (or if never) its model loads.
// Resumable: task ids live in tools/meshy-hospital-state.json.
// Usage: NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt node tools/meshy-hospital.mjs [id ...]
//        ... --redo id ...   (discard old tasks for those ids)
//        ... --optimize [id ...]  (only re-run the optimiser on downloaded raws)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_FILE = path.join(ROOT, 'tools', 'meshy-hospital-state.json');
const OUT_DIR = path.join(ROOT, 'public', 'models', 'hospital');
const RAW_DIR = path.join(ROOT, 'assets-src', 'raw', 'hospital');
const API = 'https://api.meshy.ai/openapi';
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(RAW_DIR, { recursive: true });

const STYLE = 'standing alone, no ground, no base plate, no background, realistic, game asset';
// polys: Meshy's target; px: the texture size after optimisation; ratio: the simplify ratio (1 = keep the remesh)
const ASSETS = [
  {
    id: 'hospital_bed', polys: 8000, px: 1024, ratio: 1,
    prompt: 'A modern hospital patient bed seen from the side: an adjustable single bed 2.1 metres long and 0.95 metres wide, mattress top 0.65 metres above the floor, the head section slightly raised, a white and light grey frame on four small castor wheels, light birch wood head board and foot board, low folding side rails, a white mattress with a white sheet, a pale blue folded blanket at the foot and a white pillow, long and low proportions',
    tex: 'white powder coated steel frame, light birch wood head and foot boards, white cotton sheet, pale blue wool blanket, white pillow, black rubber castor wheels, clean realistic game textures',
  },
  {
    id: 'bedside_cabinet', polys: 3000, px: 1024, ratio: 1,
    prompt: 'A hospital bedside cabinet: a small square cabinet 0.5 metres wide and 0.8 metres tall on small castors, one drawer on top and a cupboard door below, an open shelf, a white top with a glass of water and a small vase of flowers on it',
    tex: 'light birch wood veneer with white laminate top, brushed steel handles, clear glass of water, small yellow flowers, realistic game textures',
  },
  {
    id: 'patient_monitor', polys: 4000, px: 1024, ratio: 1,
    prompt: 'A medical patient vital signs monitor on a rolling stand: a flat screen monitor showing green and yellow heart rate lines on a black screen, mounted on a slim grey pole on a five wheeled base, a small basket under the screen, about 1.5 metres tall',
    tex: 'light grey plastic monitor housing, black screen with bright green and yellow ECG waveform lines and numbers, chrome pole, black wheels, realistic game textures',
  },
  {
    id: 'iv_stand', polys: 2500, px: 1024, ratio: 1,
    prompt: 'A hospital IV drip stand: a slim chrome pole 1.9 metres tall on a five legged base with small wheels, two hooks at the top with a clear plastic saline drip bag hanging from one, a thin clear tube running down',
    tex: 'polished chrome steel pole and hooks, clear translucent plastic drip bag with a white label, black castor wheels, realistic game textures',
  },
  {
    id: 'privacy_screen', polys: 4000, px: 1024, ratio: 1,
    prompt: 'A hospital folding privacy screen: three tall panels hinged together standing in a gentle zigzag, each panel a slim white steel frame with pale mint green fabric stretched inside, small feet, 1.8 metres tall and about 2.2 metres wide in total',
    tex: 'white powder coated steel frames, pale mint green woven fabric panels, realistic game textures',
  },
  {
    id: 'visitor_chair', polys: 3000, px: 1024, ratio: 1,
    prompt: 'A comfortable hospital visitor armchair: a light birch wooden frame with armrests, a padded seat and back upholstered in warm teal fabric, four straight wooden legs',
    tex: 'light birch wood frame, warm teal upholstery fabric, realistic game textures',
  },
  {
    id: 'reception_desk', polys: 8000, px: 1024, ratio: 1,
    prompt: 'A clinic reception counter: a curved front counter 2.6 metres long and 1.1 metres tall with a lower desk behind it, light birch wood front with a white top, a computer monitor, a keyboard, a small potted plant, a bell and a stack of patient folders on it',
    tex: 'light birch wood veneer front, white solid surface counter top, black computer monitor, green plant, beige folders, realistic game textures',
  },
  {
    id: 'waiting_bench', polys: 4000, px: 1024, ratio: 1,
    prompt: 'A row of three connected waiting room chairs on a single brushed steel beam with legs, each chair a moulded seat and back in light birch plywood with a teal cushion, about 1.8 metres long',
    tex: 'brushed steel beam and legs, light birch plywood seats and backs, teal fabric cushions, realistic game textures',
  },
  {
    id: 'medical_cart', polys: 3000, px: 1024, ratio: 1,
    prompt: 'A hospital supply trolley: a small white cart with three drawers, a tray on top holding bandage rolls, a box of gloves and a bottle of disinfectant, a push handle on one side, four castor wheels, about 1 metre tall',
    tex: 'white and light grey plastic trolley, blue drawer handles, white bandages, blue glove box, clear disinfectant bottle, realistic game textures',
  },
  {
    id: 'medicine_cabinet', polys: 3000, px: 1024, ratio: 1,
    prompt: 'A tall white medical cabinet with glass doors standing against a wall, shelves inside holding medicine boxes, bottles and rolled bandages, a small red cross on the top, 1.9 metres tall, 0.9 metres wide, 0.4 metres deep, flat back',
    tex: 'white painted steel cabinet, clear glass doors, colourful medicine boxes and brown glass bottles, small red cross emblem, realistic game textures',
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

function optimize(a) {
  const raw = path.join(RAW_DIR, `${a.id}.glb`);
  const out = path.join(OUT_DIR, `${a.id}.glb`);
  if (!fs.existsSync(raw)) return;
  execFileSync('npx', ['gltf-transform', 'optimize', raw, out,
    '--texture-compress', 'webp', '--texture-size', String(a.px), '--compress', 'meshopt',
    '--simplify-ratio', String(a.ratio), '--simplify-error', '0.001'], { cwd: ROOT, stdio: 'ignore' });
  log(`${a.id}: optimised -> ${Math.round(fs.statSync(out).size / 1024)} KB`);
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
log(`building ${queue.length} hospital models`);
const failed = [];
await Promise.all(queue.map(async (a) => {
  try { await build(a); } catch (e) { failed.push(a.id); log(`FAILED ${a.id}: ${e.message}`); }
}));
log(failed.length ? `finished, ${failed.length} failed: ${failed.join(', ')}` : 'ALL HOSPITAL MODELS DONE');
