// Generates the WERKSTATT (the repair garage beside the Autohaus, game/werkstatt.js) props on Meshy (text-to-3d preview
// -> refine): the tool wall, the two-post lift, the tyre stack, the workbench, the oil drums and the hanging sign by
// the door (each has a procedural stand-in until, or if never, it loads).
// Raw GLBs go to assets-src/raw/decor, optimised copies (webp textures, meshopt) to public/models/<dir>/<id>.glb.
// Resumable: task ids live in tools/meshy-werkstatt-state.json.
// Usage: NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt node tools/meshy-werkstatt.mjs [id ...]
//        ... --redo id ...   (discard old tasks for those ids)
//        ... --optimize [id ...]  (only re-run the optimiser on downloaded raws)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_FILE = path.join(ROOT, 'tools', 'meshy-werkstatt-state.json');
const RAW_DIR = path.join(ROOT, 'assets-src', 'raw', 'decor');
const API = 'https://api.meshy.ai/openapi';
fs.mkdirSync(RAW_DIR, { recursive: true });
const outFile = (a) => path.join(ROOT, 'public', 'models', a.dir, `${a.id}.glb`);

const STYLE = 'standing alone, no ground, no base plate, no background, realistic, game asset';
// polys: Meshy's target; px: the texture size after optimisation; ratio: the simplify ratio (1 = keep the remesh)
const ASSETS = [
  {
    id: 'garage_toolwall', dir: 'decor', polys: 8000, px: 1024, ratio: 1, style: STYLE,
    prompt: 'A flat workshop tool wall: a wide perforated pegboard panel 2.4 metres wide and 1.6 metres tall, mounted flat, with hand tools hanging on hooks: spanners of graded sizes, screwdrivers, pliers, hammers, a saw, socket sets, a coiled air hose, neatly arranged, thin flat panel seen from the front',
    tex: 'light grey painted perforated steel pegboard, chrome spanners and tools with red and blue handles, realistic game textures',
  },
  {
    id: 'garage_lift', dir: 'decor', polys: 9000, px: 1024, ratio: 1, style: STYLE,
    prompt: 'A two post car lift for a repair garage: two tall steel columns about 3.6 metres tall standing 3.4 metres apart, joined by a crossbar across the top, each column with two folded swing lift arms near the floor, hydraulic cylinder and cable on one column, no car',
    tex: 'bright red powder coated steel columns, dark grey lift arms with black rubber pads, yellow and black safety stripes at the base, realistic game textures',
  },
  {
    id: 'garage_tyres', dir: 'decor', polys: 5000, px: 1024, ratio: 1, style: STYLE,
    prompt: 'A neat stack of four used car tyres lying flat on top of each other, about 0.65 metres wide and 0.9 metres tall, deep winter tread pattern',
    tex: 'black rubber tyres with deep winter tread, slightly dusty, realistic game textures',
  },
  {
    id: 'garage_workbench', dir: 'decor', polys: 7000, px: 1024, ratio: 1, style: STYLE,
    prompt: 'A heavy workshop workbench 2 metres long, 0.75 metres deep and 0.9 metres tall: a thick wooden top on a steel frame with drawers and a cabinet underneath, a bench vice bolted on one end, a toolbox, a few spanners and a rag lying on top',
    tex: 'worn oiled beech wood top, dark blue painted steel drawers and frame, grey steel vice, red toolbox, realistic game textures',
  },
  {
    id: 'garage_drums', dir: 'decor', polys: 5000, px: 1024, ratio: 1, style: STYLE,
    prompt: 'Three steel 200 litre oil drums standing together in a tight cluster, about 1.3 metres wide and 0.9 metres tall, ribbed barrels with lids and bungs, one with a hand pump on top',
    tex: 'two drums glossy blue painted steel and one red, scratched and slightly oily, white label patches with no text, realistic game textures',
  },
  {
    id: 'garage_signbracket', dir: 'decor', polys: 4000, px: 1024, ratio: 1, style: STYLE,
    prompt: 'A traditional alpine wrought iron wall sign bracket sticking out from a wall, with ornamental scrolls, holding a hanging round shield shaped emblem in the shape of a large crossed spanner and wrench, no text, about 1.2 metres long',
    tex: 'black wrought iron with scrolls, gilded gold spanner and wrench emblem, realistic game textures',
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
  const out = outFile(a);
  fs.mkdirSync(path.dirname(out), { recursive: true });
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
      mode: 'preview', prompt: `${a.prompt}, ${a.style}`.slice(0, 600), ai_model: 'meshy-6', art_style: 'realistic',
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
      mode: 'refine', preview_task_id: s.preview, enable_pbr: false,
      texture_prompt: a.tex.slice(0, 600), target_formats: ['glb'],
    })).result;
    saveState();
    log(`${id}: refine started`);
  }
  const refined = await waitTask(s.refine, id);
  await download(refined.model_urls.glb, path.join(RAW_DIR, `${id}.glb`));
  if (refined.thumbnail_url) await download(refined.thumbnail_url, path.join(RAW_DIR, `${id}.png`)).catch(() => {});
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
try { log('credits:', (await api('GET', '/v1/balance')).balance); } catch { /* (no balance endpoint) */ }
const selected = args.length ? ASSETS.filter((a) => args.includes(a.id)) : ASSETS;
const queue = selected.filter((a) => !state[a.id]?.done || !fs.existsSync(outFile(a)));
log(`building ${queue.length} garage props`);
const failed = [];
await Promise.all(queue.map(async (a) => {
  try { await build(a); } catch (e) { failed.push(a.id); log(`FAILED ${a.id}: ${e.message}`); }
}));
log(failed.length ? `finished, ${failed.length} failed: ${failed.join(', ')}` : 'ALL WERKSTATT PROPS DONE');
try { log('credits left:', (await api('GET', '/v1/balance')).balance); } catch { /* */ }
