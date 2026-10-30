// Generates the MEDICAL CENTRE's outside props on Meshy (text-to-3d preview -> refine): the planters, bollards, litter
// bin and grit box on its forecourt (game/hospital.js; each has a procedural stand-in until, or if never, it loads).
// Raw GLBs go to assets-src/raw/decor, optimised copies (webp textures, meshopt) to public/models/<dir>/<id>.glb.
// Resumable: task ids live in tools/meshy-hospital-outside-state.json.
// Usage: NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt node tools/meshy-hospital-outside.mjs [id ...]
//        ... --redo id ...   (discard old tasks for those ids)
//        ... --optimize [id ...]  (only re-run the optimiser on downloaded raws)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_FILE = path.join(ROOT, 'tools', 'meshy-hospital-outside-state.json');
const RAW_DIR = path.join(ROOT, 'assets-src', 'raw', 'decor');
const API = 'https://api.meshy.ai/openapi';
fs.mkdirSync(RAW_DIR, { recursive: true });
const outFile = (a) => path.join(ROOT, 'public', 'models', a.dir, `${a.id}.glb`);

const STYLE = 'standing alone, no ground, no base plate, no background, realistic, game asset';
// polys: Meshy's target; px: the texture size after optimisation; ratio: the simplify ratio (1 = keep the remesh)
const ASSETS = [
  {
    id: 'planter_spruce', dir: 'decor', polys: 6000, px: 1024, ratio: 1, style: STYLE,
    prompt: 'A square wooden planter box made of weathered larch planks with dark iron corner bands, about 0.8 metres wide and 0.6 metres tall, a small dwarf spruce tree growing in it, a light dusting of snow on the spruce and on the soil, alpine chalet style',
    tex: 'weathered honey brown larch wood planks, dark iron bands, dark green spruce needles with white snow on top, realistic game textures',
  },
  {
    id: 'bollard_steel', dir: 'decor', polys: 2500, px: 512, ratio: 1, style: STYLE,
    prompt: 'A single street bollard: a round brushed stainless steel post 0.9 metres tall and 15 centimetres wide with a rounded domed top and two red reflective bands near the top',
    tex: 'brushed stainless steel, bright red reflective bands, realistic game textures',
  },
  {
    id: 'litter_bin', dir: 'decor', polys: 3000, px: 1024, ratio: 1, style: STYLE,
    prompt: 'A public outdoor litter bin on a single post: a round dark grey steel bin with a small rain hood on top, slotted sides, mounted on a short black steel post, about 1 metre tall',
    tex: 'dark anthracite grey powder coated steel, black post, realistic game textures',
  },
  {
    id: 'grit_box', dir: 'decor', polys: 3000, px: 1024, ratio: 1, style: STYLE,
    prompt: 'A yellow road grit salt box: a sturdy rectangular plastic storage bin about 1 metre wide and 0.7 metres tall with a hinged sloping lid, typical roadside winter salt box',
    tex: 'bright yellow weathered plastic, dark grey hinges, a little dirt at the bottom, realistic game textures',
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
log(`building ${queue.length} medical centre props`);
const failed = [];
await Promise.all(queue.map(async (a) => {
  try { await build(a); } catch (e) { failed.push(a.id); log(`FAILED ${a.id}: ${e.message}`); }
}));
log(failed.length ? `finished, ${failed.length} failed: ${failed.join(', ')}` : 'ALL MEDICAL CENTRE PROPS DONE');
try { log('credits left:', (await api('GET', '/v1/balance')).balance); } catch { /* */ }
