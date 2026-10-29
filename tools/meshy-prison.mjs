// Generates the PRISON models on Meshy (text-to-3d preview -> refine): the police station / jail that stands in
// Legacy Village (game/prison.js) and the props of its cells and visiting room. The cell bars are not here: they are
// procedural (instanced cylinders), Meshy's simplification would melt them. Raw GLBs go to assets-src/raw/prison,
// optimised copies (webp textures, meshopt) to public/models/prison.
// Resumable: task ids live in tools/meshy-prison-state.json.
// Usage: NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt node tools/meshy-prison.mjs [id ...]
//        ... --redo id ...   (discard old tasks for those ids)
//        ... --optimize [id ...]  (only re-run the optimiser on downloaded raws)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_FILE = path.join(ROOT, 'tools', 'meshy-prison-state.json');
const OUT_DIR = path.join(ROOT, 'public', 'models', 'prison');
const RAW_DIR = path.join(ROOT, 'assets-src', 'raw', 'prison');
const API = 'https://api.meshy.ai/openapi';
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(RAW_DIR, { recursive: true });

const STYLE = 'standing alone, no ground, no base plate, no background, realistic, game asset';
// polys: Meshy's target; px: the texture size after optimisation; ratio: the simplify ratio (1 = keep the remesh)
const ASSETS = [
  {
    id: 'prison_station', polys: 30000, px: 2048, ratio: 1,
    prompt: 'A two storey Swiss alpine village police station and jail building: a heavy grey rough stone ground floor with a solid dark wooden front door in the middle of the long side and small windows with thick black iron bars, a dark larch timber upper storey with wooden balconies and small barred windows, a steep pitched dark slate roof with deep overhanging eaves, a blank white sign board above the door, a blue police lamp beside the door, rectangular footprint about 18 metres long and 11 metres deep',
    tex: 'rough grey granite stone ground floor, weathered dark brown larch timber upper storey, black wrought iron window bars, dark grey slate roof tiles, dark oak front door, a blank white sign above the door, realistic PBR game textures',
  },
  {
    id: 'bunk_bed', polys: 6000, px: 1024, ratio: 1,
    prompt: 'A prison cell bunk bed seen from the side: two single beds stacked one above the other, each 2 metres long and 0.8 metres wide, the top bed 1.5 metres above the floor, a sturdy square steel tube frame painted grey with four corner posts, a solid steel sheet under each mattress, thin blue mattresses with folded grey blankets and white pillows, long and low proportions',
    tex: 'grey painted square steel tubes with scratches, solid grey steel sheets, plain dark blue mattresses, grey wool blankets, white pillows, realistic game textures',
  },
  {
    id: 'cell_toilet', polys: 4000, px: 1024, ratio: 1,
    prompt: 'A brushed stainless steel prison combination unit: a toilet without a lid at the bottom and a small washbasin sink with a push button tap on top, one single seamless steel piece that stands against a wall, flat back',
    tex: 'brushed stainless steel with slight water stains, realistic metal game textures',
  },
  {
    id: 'visit_desk', polys: 5000, px: 1024, ratio: 1,
    prompt: 'A prison visiting room counter: a long plain grey laminate desk with a thick clear glass partition standing on it, a black wall telephone handset on each side of the glass and a simple grey plastic stool in front',
    tex: 'grey laminate desk, clear glass partition with an aluminium frame, black telephone handsets, grey plastic stool, realistic game textures',
  },
  {
    id: 'guard_desk', polys: 6000, px: 1024, ratio: 1,
    prompt: 'A police front desk reception counter: a sturdy dark wooden counter with a computer monitor, a keyboard, a desk lamp, a stack of papers and a ring of keys on top, and an office swivel chair behind it',
    tex: 'dark varnished wood counter, black computer monitor, beige papers, brass keys, black office chair, realistic game textures',
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
log(`building ${queue.length} prison models`);
const failed = [];
await Promise.all(queue.map(async (a) => {
  try { await build(a); } catch (e) { failed.push(a.id); log(`FAILED ${a.id}: ${e.message}`); }
}));
log(failed.length ? `finished, ${failed.length} failed: ${failed.join(', ')}` : 'ALL PRISON MODELS DONE');
