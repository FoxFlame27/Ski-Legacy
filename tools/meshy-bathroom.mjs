// Generates the chalet's fixed fittings on Meshy (text-to-3d preview -> refine), low-poly game-ready: the bathroom
// sanitary ware (public/models/bathroom/) and the built-in lamps (public/models/lamps/), used by game/chaletroom.js.
// Raw GLBs in assets-src/raw/chalet. Resumable: task ids in tools/meshy-bathroom-state.json.
// Usage: NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt node tools/meshy-bathroom.mjs [id ...]
//        ... --redo id ...   ... --optimize
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_FILE = path.join(ROOT, 'tools', 'meshy-bathroom-state.json');
const RAW_DIR = path.join(ROOT, 'assets-src', 'raw', 'chalet');
const API = 'https://api.meshy.ai/openapi';
fs.mkdirSync(RAW_DIR, { recursive: true });

const SAN = 'clean glossy white ceramic, chrome fittings, modern alpine chalet bathroom, standing alone, no floor, no wall, no room, no background, no text, low poly game asset';
const LAMP = 'alpine Austrian chalet style, warm glowing light, standing alone, no ceiling, no wall, no room, no background, no text, low poly game asset';
const ITEMS = [
  { id: 'toilet', dir: 'bathroom', prompt: `A modern floor standing toilet with a white ceramic bowl, closed white seat lid and a ceramic cistern tank behind it, ${SAN}`, tex: 'glossy white ceramic, chrome flush button' },
  { id: 'washbasin', dir: 'bathroom', prompt: `A bathroom vanity unit: a white ceramic washbasin with a chrome mixer tap on a small warm oak wood cabinet with two doors, ${SAN}`, tex: 'glossy white ceramic basin, chrome tap, warm oak wood cabinet' },
  { id: 'shower', dir: 'bathroom', prompt: `A square walk-in shower enclosure: a low white shower tray, two clear glass walls with thin chrome frames, a chrome shower riser rail with a round rain shower head, ${SAN}`, tex: 'clear glass panels, chrome frame, white ceramic tray' },
  { id: 'bathtub', dir: 'bathroom', prompt: `A rectangular built-in white bathtub with a chrome tap and spout at one end, ${SAN}`, tex: 'glossy white enamel bathtub, chrome tap' },
  { id: 'bath_mirror', dir: 'bathroom', prompt: `A rectangular bathroom wall mirror with a thin warm oak wood frame, flat back for hanging on a wall, ${SAN}`, tex: 'reflective silver mirror glass, oak frame' },
  { id: 'towel_hooks', dir: 'bathroom', prompt: `A wall mounted oak wood board with three chrome towel hooks and one folded white towel hanging, flat back, ${SAN}`, tex: 'oak wood, chrome hooks, white cotton towel' },
  { id: 'snowman', dir: 'garden', small: true, prompt: 'A friendly snowman made of three stacked snowballs, coal eyes and buttons, a carrot nose, a red knitted scarf and a small black hat, standing alone, no ground, no background, no text, low poly game asset', tex: 'white packed snow, black coal, orange carrot, red wool scarf' },
  { id: 'sledge', dir: 'garden', small: true, prompt: 'A traditional wooden Davos sledge toboggan with slatted wooden seat and curved wooden runners with metal strips, standing alone, no ground, no background, no text, low poly game asset', tex: 'warm varnished ash wood, dark iron runners' },
  // (Oct 29: the ceiling lamps again (the candle ring and the antler chandelier before), precise prompts, a few
  // generations each into assets-src/lamp-candidates/; the best by its geometry copied to public/models/lamps/:
  // pendant_drum_c -> pendant_drum.glb, chandelier_a -> chandelier.glb)
  ...['a', 'b'].map((v) => ({ id: `pendant_drum_${v}`, dir: '../../assets-src/lamp-candidates', prompt: `A simple rustic alpine chalet ceiling pendant lamp, hanging straight down: a small round wooden ceiling canopy disc at the very top, one thin straight black iron rod below it, and a single cylindrical cream linen drum lampshade at the bottom, open at the bottom, symmetrical, upright, ${LAMP}`, tex: 'warm oak wood canopy, matte black iron rod, cream linen drum shade' })),
  ...['c', 'd'].map((v) => ({ id: `pendant_drum_${v}`, dir: '../../assets-src/lamp-candidates', prompt: `A ceiling pendant light hanging straight down: at the very top a flat round light oak ceiling canopy plate, under it one thin straight matte black metal rod, at the bottom one large white fabric cylinder drum lampshade glowing warm from inside, simple and symmetrical, upright, ${LAMP}`, tex: 'light oak wood canopy, matte black metal rod, off-white linen fabric drum shade glowing warm' })),
  ...['a', 'b'].map((v) => ({ id: `chandelier_${v}`, dir: '../../assets-src/lamp-candidates', prompt: `A wrought iron candle style chandelier for an alpine chalet, hanging straight down: a round black iron ceiling canopy at the very top, a short black chain, a central iron stem and four curved iron arms each holding a cream candle with a small bulb, symmetrical, upright, ${LAMP}`, tex: 'matte black wrought iron, cream candle sleeves, warm glowing bulbs' })),
  { id: 'wall_lamp', dir: 'lamps', prompt: `A wall mounted lamp sconce: a carved wooden back plate with a wrought iron arm holding a small cream linen lampshade, flat back, ${LAMP}`, tex: 'warm wood, black iron, cream linen shade' },
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

function optimize(id) {
  const item = ITEMS.find((i) => i.id === id), OUT_DIR = path.join(ROOT, 'public', 'models', item.dir);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const raw = path.join(RAW_DIR, `${id}.glb`);
  const out = path.join(OUT_DIR, `${id}.glb`);
  if (!fs.existsSync(raw)) return;
  const run = (tex, ratio) => execFileSync('npx', ['gltf-transform', 'optimize', raw, out,
    '--texture-compress', 'webp', '--texture-size', String(tex), '--compress', 'meshopt',
    '--simplify-ratio', String(ratio)], { cwd: ROOT, stdio: 'ignore' });
  run(512, 0.3);
  if (fs.statSync(out).size > 500 * 1024) run(256, 0.2);
  log(`${id}: optimised -> ${Math.round(fs.statSync(out).size / 1024)} KB`);
}

async function build(item) {
  const id = item.id;
  const s = (state[id] ??= {});
  const prompt = item.prompt;
  if (!s.preview) {
    s.preview = (await api('POST', '/v2/text-to-3d', {
      mode: 'preview', prompt: prompt.slice(0, 600), ai_model: 'meshy-6', art_style: 'realistic',
      should_remesh: true, topology: 'triangle', target_polycount: item.flat ? 1500 : item.small ? 3000 : 6000, target_formats: ['glb'],
    })).result;
    saveState();
    log(`${id}: preview started`);
  }
  await waitTask(s.preview, id);
  if (!s.refine) {
    s.refine = (await api('POST', '/v2/text-to-3d', {
      mode: 'refine', preview_task_id: s.preview, enable_pbr: false,
      texture_prompt: item.tex, target_formats: ['glb'],
    })).result;
    saveState();
    log(`${id}: refine started`);
  }
  const refined = await waitTask(s.refine, id);
  await download(refined.model_urls.glb, path.join(RAW_DIR, `${id}.glb`));
  optimize(id);
  s.done = true;
  saveState();
}

const args = process.argv.slice(2);
if (args[0] === '--optimize') {
  for (const f of ITEMS) optimize(f.id);
  process.exit(0);
}
if (args[0] === '--redo') {
  args.shift();
  for (const n of args) delete state[n];
  saveState();
}
KEY = loadKey();
const selected = args.length ? ITEMS.filter((a) => args.includes(a.id)) : ITEMS;
const queue = selected.filter((a) => !state[a.id]?.done || !fs.existsSync(path.join(ROOT, 'public', 'models', a.dir, `${a.id}.glb`)));
log(`building ${queue.length} chalet fittings`);
const CONCURRENCY = 10;
const failed = [];
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (queue.length) {
    const a = queue.shift();
    try { await build(a); } catch (e) { failed.push(a.id); log(`FAILED ${a.id}: ${e.message}`); }
  }
}));
log(failed.length ? `finished, ${failed.length} failed: ${failed.join(', ')}` : 'ALL CHALET FITTINGS DONE');
