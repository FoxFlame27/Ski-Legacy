// Generates the DECOR models on Meshy (text-to-3d preview -> refine): natural snow drifts / ploughed heaps that bank
// against the police station's walls and line its forecourt (game/prisonoutside.js), and the station's lamps and
// house plants (game/prison.js front office, the lanterns outside). Raw GLBs go to assets-src/raw/decor, optimised
// copies (webp textures, meshopt) to public/models/<dir>/<id>.glb; the preview thumbnails to assets-src/raw/decor.
// Resumable: task ids live in tools/meshy-decor-state.json.
// Usage: NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt node tools/meshy-decor.mjs [id ...]
//        ... --redo id ...   (discard old tasks for those ids)
//        ... --optimize [id ...]  (only re-run the optimiser on downloaded raws)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_FILE = path.join(ROOT, 'tools', 'meshy-decor-state.json');
const RAW_DIR = path.join(ROOT, 'assets-src', 'raw', 'decor');
const API = 'https://api.meshy.ai/openapi';
fs.mkdirSync(RAW_DIR, { recursive: true });
const outFile = (a) => path.join(ROOT, 'public', 'models', a.dir, `${a.id}.glb`);

const STYLE = 'standing alone, no ground, no base plate, no background, realistic, game asset';
const SNOW_STYLE = 'isolated object with a flat underside, nothing else, no rocks, no plants, no ground plane, low poly smooth game asset';
const SNOW_TEX = 'clean fresh pure white snow with very soft pale blue shading in the hollows, fine powder texture, no rocks, no dirt, realistic game texture';
// polys: Meshy's target; px: the texture size after optimisation; ratio: the simplify ratio (1 = keep the remesh)
const ASSETS = [
  {
    id: 'drift_long', dir: 'snow', polys: 3000, px: 512, ratio: 1, style: SNOW_STYLE, tex: SNOW_TEX,
    prompt: 'A long straight snow bank: one continuous low ridge of wind-blown snow about 5 metres long, 1.3 metres wide and 0.7 metres high, the same height along its whole length tapering only at both rounded ends, a smooth gently convex windward slope up to a soft wind-sculpted crest running the full length, a steeper smooth lee side, like snow drifted against a wall',
  },
  {
    id: 'snow_heap', dir: 'snow', polys: 3000, px: 512, ratio: 1, style: SNOW_STYLE, tex: SNOW_TEX,
    prompt: 'A ploughed snow heap, a large pile of pushed snow about 2.5 metres wide and 1.3 metres high, rounded lumpy mound of packed snow with soft clumps and smooth wind-rounded flanks, natural shape',
  },
  {
    id: 'snow_mound', dir: 'snow', polys: 2000, px: 512, ratio: 1, style: SNOW_STYLE, tex: SNOW_TEX,
    prompt: 'A small low smooth snow mound, a soft wind-rounded oval hump of fresh snow about 1.5 metres long, 1 metre wide and 0.35 metres high, gently sculpted by the wind with a faint ripple, smooth flowing surface',
  },
  {
    id: 'plant_ficus', dir: 'decor', polys: 8000, px: 1024, ratio: 1, style: STYLE,
    prompt: 'A potted ficus benjamina tree for an office: a slender braided trunk and a lush rounded crown of many small glossy green leaves, in a round glazed cream ceramic pot, about 1.5 metres tall',
    tex: 'glossy dark and light green small ficus leaves, light brown braided bark, cream glazed ceramic pot, dark potting soil, realistic game textures',
  },
  {
    id: 'plant_monstera', dir: 'decor', polys: 8000, px: 1024, ratio: 1, style: STYLE,
    prompt: 'A potted monstera deliciosa house plant: large glossy split heart-shaped green leaves on long stems spreading out, in a tall cylindrical dark terracotta ceramic pot, about 1.1 metres tall',
    tex: 'glossy deep green monstera leaves with natural splits and lighter veins, green stems, dark terracotta glazed ceramic pot, dark soil, realistic game textures',
  },
  {
    id: 'lamp_pendant', dir: 'decor', polys: 4000, px: 1024, ratio: 1, style: STYLE,
    prompt: 'An alpine chalet ceiling pendant lamp: a wide round dark green enamelled metal shade with a warm white glass bulb inside, hanging from a short black metal rod with a small round wooden ceiling cap, rustic cosy style',
    tex: 'dark green enamelled metal shade with a white inside, warm white frosted glass bulb, black iron rod, warm brown oak wood ceiling cap, realistic game textures',
  },
  {
    id: 'lamp_banker', dir: 'decor', polys: 4000, px: 1024, ratio: 1, style: STYLE,
    prompt: 'A traditional green bankers lamp for an office desk: a horizontal half-cylinder dark emerald green glass shade, wide and low, held over a polished brass stem on a round heavy brass foot, a small brass pull chain hanging under the shade, classic library lamp, about 40 cm tall and 30 cm wide',
    tex: 'dark emerald green cased glass shade, glossy, white opal glass inside, polished antique brass stem, foot and pull chain, realistic game textures',
  },
  {
    id: 'parking_sign', dir: 'decor', polys: 4000, px: 1024, ratio: 1, style: STYLE,
    prompt: 'A European road parking sign: one straight round galvanised steel post about 2.5 metres tall, at its top a flat square blue sign plate with a white rounded border and a large white letter P, directly below it a smaller flat white rectangular additional plate with a thin black border, both plates clamped flat to the front of the post with metal brackets, plain flat sign faces, seen from the front',
    tex: 'blue enamel parking sign plate with a white border and a white letter P, plain white additional plate with a thin black border and no text, galvanised grey steel post, brackets and plate backs, light road grime, realistic game textures',
  },
  {
    id: 'notice_frame', dir: 'decor', polys: 3000, px: 1024, ratio: 1, style: STYLE,
    prompt: 'An empty wall-mounted notice board: a flat portrait rectangular panel about 0.9 metres wide and 1.1 metres tall set in a thick dark larch wood picture frame with a moulded profile and slightly rounded edges, a plain flat cream panel inside the frame, a small brass screw in each corner of the frame, flat back to hang on a wall, seen from the front',
    tex: 'dark brown oiled larch wood frame with visible fine grain, plain flat off-white cream panel, small polished brass screws, realistic game textures',
  },
  {
    id: 'lantern_wall', dir: 'decor', polys: 4000, px: 1024, ratio: 1, style: STYLE,
    prompt: 'A black wrought iron alpine wall lantern: a square lantern with four warm frosted glass panes and a pointed little roof with a finial, hanging from an ornate scrolled iron wall bracket with a wall plate at the back, rustic chalet style',
    tex: 'matte black wrought iron, warm yellow-white frosted glass panes, realistic game textures',
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
log(`building ${queue.length} decor models`);
const failed = [];
await Promise.all(queue.map(async (a) => {
  try { await build(a); } catch (e) { failed.push(a.id); log(`FAILED ${a.id}: ${e.message}`); }
}));
log(failed.length ? `finished, ${failed.length} failed: ${failed.join(', ')}` : 'ALL DECOR MODELS DONE');
try { log('credits left:', (await api('GET', '/v1/balance')).balance); } catch { /* */ }
