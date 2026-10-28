// Generates the chalet furniture catalog on Meshy (text-to-3d preview -> refine), low-poly game-ready,
// downloads raw GLBs to assets-src/raw/furniture and writes optimised copies to public/models/furniture.
// Resumable: task ids live in tools/meshy-furniture-state.json (separate from meshy-state.json so it can
// run alongside other generators).
// Usage: NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt node tools/meshy-furniture.mjs [id ...]
//        ... --redo id ...   (discard old tasks for those ids)
//        ... --optimize      (only re-run the optimiser on downloaded raws)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FURNITURE } from '../src/game/build/catalog.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_FILE = path.join(ROOT, 'tools', 'meshy-furniture-state.json');
const OUT_DIR = path.join(ROOT, 'public', 'models', 'furniture');
const RAW_DIR = path.join(ROOT, 'assets-src', 'raw', 'furniture');
const API = 'https://api.meshy.ai/openapi';
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(RAW_DIR, { recursive: true });

const STYLE = 'alpine Austrian chalet style, warm honey and walnut wood, standing alone, no floor, no room, no background, no text, low poly game asset';
const TEX = 'warm natural wood with visible grain, realistic PBR, clean game textures';
const PROMPTS = {
  sofa: 'A cosy three seat sofa with a solid carved wooden frame and thick green loden wool cushions and two plaid pillows',
  armchair: 'A wingback armchair with a carved wooden frame and red and cream checked upholstery',
  coffee_table: 'A low rectangular solid oak coffee table with thick legs and a lower shelf',
  tv_unit: 'A low wooden TV sideboard cabinet with two doors and a modern black flat screen television standing on top of it',
  rug: 'A flat rectangular woven wool rug with a red, cream and dark green traditional alpine pattern and short fringe, completely flat',
  bookshelf: 'A tall open wooden bookshelf with five shelves filled with colourful books and a few small ornaments',
  fireplace_stove: 'A black cast iron wood burning stove with a glass door showing logs, standing on a stone base with a black chimney pipe going straight up',
  log_basket: 'A woven wicker basket filled with split firewood logs',
  kitchen_counter: 'A kitchen base cabinet unit with two wooden doors and a drawer and a thick butcher block wooden worktop',
  kitchen_sink: 'A kitchen base cabinet unit with wooden doors, a thick wooden worktop and a white ceramic farmhouse sink with a brass tap',
  fridge: 'A tall retro cream coloured refrigerator with rounded corners and chrome handles',
  stove: 'A cream enamel kitchen range cooker with four burners on top and an oven door with a chrome handle',
  dining_table: 'A long rustic farmhouse dining table made of thick solid wooden planks with sturdy legs',
  dining_chair: 'A traditional Tyrolean wooden dining chair with a heart shape carved into the backrest',
  wall_shelf: 'A rustic wall mounted wooden kitchen shelf with small jars, a teapot and plates on it, flat back',
  double_bed: 'A large double bed with a carved solid wooden headboard and footboard, white duvet with a red checked blanket and two pillows',
  single_bed: 'A single bed with a simple wooden frame and headboard, white duvet with a green checked blanket and one pillow',
  wardrobe: 'A tall two door wooden wardrobe painted with traditional alpine flower folk art',
  nightstand: 'A small wooden bedside nightstand with one drawer and an open shelf',
  desk: 'A wooden writing desk with three drawers on one side and four straight legs',
  desk_chair: 'A wooden desk chair with armrests and a red cushion seat',
  blanket_chest: 'A wooden blanket chest trunk with iron hinges and painted flowers on the front',
  bath_rug: 'A flat rectangular fluffy cream bath mat, completely flat',
  towel_rack: 'A wooden ladder towel rack leaning upright with two white towels hanging on it',
  mirror_cabinet: 'A wall mounted bathroom mirror cabinet with a wooden frame and a mirror door, flat back',
  laundry_basket: 'A tall woven wicker laundry basket with a lid',
  plant_tall: 'A tall leafy green indoor plant in a round terracotta pot',
  plant_small: 'A small green potted herb plant in a terracotta pot',
  ski_rack: 'A freestanding wooden ski rack holding two pairs of alpine skis and poles upright',
  picture_mountain: 'A framed oil painting of snowy alpine mountains and a lake, in a thick carved wooden frame, flat picture',
  picture_deer: 'A framed oil painting of a red deer stag in a forest, in a carved wooden frame, portrait orientation, flat picture',
  antlers: 'A deer antler trophy mounted on a carved wooden shield plaque, flat back for hanging on a wall',
  cuckoo_clock: 'A traditional Black Forest cuckoo clock with a carved wooden roof, leaves and a small bird, with pine cone weights hanging below',
  floor_lamp: 'A standing floor lamp with a turned wooden pole and a cream linen lampshade',
  table_lamp: 'A small table lamp with a turned wooden base and a cream fabric lampshade',
  ceiling_lamp: 'A rustic antler chandelier with six candle style light bulbs, hanging from a short chain',
  wall_sconce: 'A wall mounted wrought iron and wood candle lantern sconce light, flat back plate',
  lantern: 'A small wooden and glass candle lantern with a carry handle',
  geranium_box: 'A small rectangular wooden flower box planter full of red geraniums with green leaves',
  herb_pot: 'A small terracotta pot with fresh green basil herbs',
  cactus: 'A tiny round green cactus in a small painted ceramic pot',
  vase: 'A small blue and white painted ceramic vase with a few wildflowers and edelweiss',
  tealight_lantern: 'A small glass candle jar with a lit candle inside and a wooden lid',
  deer_figurine: 'A small hand carved wooden deer figurine standing on a little wooden base',
  photo_frame: 'A small standing wooden picture frame with a family photo of skiers in the mountains',
};

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
  const raw = path.join(RAW_DIR, `${id}.glb`);
  const out = path.join(OUT_DIR, `${id}.glb`);
  if (!fs.existsSync(raw)) return;
  const run = (tex, ratio) => execFileSync('npx', ['gltf-transform', 'optimize', raw, out,
    '--texture-compress', 'webp', '--texture-size', String(tex), '--compress', 'meshopt',
    '--simplify-ratio', String(ratio)], { cwd: ROOT, stdio: 'ignore' });
  run(512, 0.3);
  if (fs.statSync(out).size > 300 * 1024) run(256, 0.2); // (keep every model under ~300 KB)
  if (fs.statSync(out).size > 300 * 1024) run(256, 0.1);
  log(`${id}: optimised -> ${Math.round(fs.statSync(out).size / 1024)} KB`);
}

async function build(item) {
  const id = item.id;
  const s = (state[id] ??= {});
  const prompt = `${PROMPTS[id] ?? item.name}, ${STYLE}`;
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
      texture_prompt: `${PROMPTS[id] ?? item.name}, ${TEX}`.slice(0, 600), target_formats: ['glb'],
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
  for (const f of FURNITURE) optimize(f.id);
  process.exit(0);
}
if (args[0] === '--redo') {
  args.shift();
  for (const n of args) delete state[n];
  saveState();
}
KEY = loadKey();
const selected = args.length ? FURNITURE.filter((a) => args.includes(a.id)) : FURNITURE;
const queue = selected.filter((a) => !state[a.id]?.done || !fs.existsSync(path.join(OUT_DIR, `${a.id}.glb`)));
log(`building ${queue.length} furniture models`);
const CONCURRENCY = 10;
const failed = [];
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (queue.length) {
    const a = queue.shift();
    try { await build(a); } catch (e) { failed.push(a.id); log(`FAILED ${a.id}: ${e.message}`); }
  }
}));
log(failed.length ? `finished, ${failed.length} failed: ${failed.join(', ')}` : 'ALL FURNITURE DONE');
