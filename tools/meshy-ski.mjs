// Generates the ski shop's beginner ski, the "Pistenfuchs 165" (economy.js SKIS id 'cruiser', model
// 'ski_pistenfuchs'), on Meshy: text-to-3d preview -> refine with PBR textures, raw GLB to
// assets-src/raw/skis, optimised copy to public/models (the meshy-furniture.mjs pattern).
// (Oct 31 2026, the user: "also replace the Alpine skis 160 with some other skis, use Meshy for the ski models":
// the old Alpine Cruiser 160 (ski_cruiser.glb) is replaced by this all-mountain carver; same id, price and stats)
// Resumable: task ids live in tools/meshy-ski-state.json.
// Usage: NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt node tools/meshy-ski.mjs [id ...]
//        ... --redo id ...   (discard old tasks for those ids)
//        ... --optimize      (only re-run the optimiser on downloaded raws)
//        ... --thumb         (only fetch the shop thumbnails, public/thumbs/<id>.png)
// Check the result with: node tools/inspect-glb.mjs public/models/ski_pistenfuchs.glb (length along X, thin in Y:
// player/skier.js reads Meshy skis with their length along the file's X axis and the binding up +Y)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_FILE = path.join(ROOT, 'tools', 'meshy-ski-state.json');
const OUT_DIR = path.join(ROOT, 'public', 'models');
const RAW_DIR = path.join(ROOT, 'assets-src', 'raw', 'skis');
const API = 'https://api.meshy.ai/openapi';
fs.mkdirSync(RAW_DIR, { recursive: true });

const STYLE = 'one single ski only, lying flat, seen from the side and above, standing alone, no second ski, no poles, no boot, no snow, no ground, no background, no people, realistic product model';
const SKIS = [
  {
    id: 'ski_pistenfuchs',
    // (Oct 31 2026, the user's "some other skis": a modern all-mountain carver, about 1.65 m, thin, slight rocker
    // tip, binding mounted in the middle, a clean topsheet in alpine colours)
    // (the first try came out as a round log, 0.3 m thick: this prompt asks for a flat thin plank like a ruler)
    prompt: 'A single flat alpine carving ski with a ski binding, lying flat on its base, seen from above at an angle, 1.65 meters long, only 8 centimeters wide and 2 centimeters thick, a very thin flat plank like a long ruler, much wider than it is thick, the tip gently curved upward, the tail slightly raised, a compact black and red ski binding with toe piece and heel piece mounted on top in the middle, glossy white topsheet with red and deep blue diagonal stripes and a small fox logo',
    texture: 'glossy white ski topsheet with crisp red and deep blue diagonal racing stripes and a small orange fox head logo, black base with steel edges, black and red metal ski binding, clean realistic PBR product textures',
    polycount: 10000,
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

// (the shop's skis are seen close up on the wall and at your boots: a finer texture and a lighter simplify than
// the furniture, still under ~500 KB)
function optimize(id) {
  const raw = path.join(RAW_DIR, `${id}.glb`);
  const out = path.join(OUT_DIR, `${id}.glb`);
  if (!fs.existsSync(raw)) return;
  const run = (tex, ratio) => execFileSync('npx', ['gltf-transform', 'optimize', raw, out,
    '--texture-compress', 'webp', '--texture-size', String(tex), '--compress', 'meshopt',
    '--simplify-ratio', String(ratio)], { cwd: ROOT, stdio: 'ignore' });
  run(1024, 0.6);
  if (fs.statSync(out).size > 480 * 1024) run(1024, 0.4);
  if (fs.statSync(out).size > 480 * 1024) run(512, 0.4);
  if (fs.statSync(out).size > 480 * 1024) run(512, 0.25);
  log(`${id}: optimised -> ${Math.round(fs.statSync(out).size / 1024)} KB`);
}

// The ski shop list (ui/hud.js shop) shows ./thumbs/<model>.png: Meshy's render of the refined model, 512 px
async function thumb(id, refined) {
  refined ??= await api('GET', `/v2/text-to-3d/${state[id]?.refine}`);
  if (!refined?.thumbnail_url) return;
  const raw = path.join(RAW_DIR, `${id}_thumb`);
  await download(refined.thumbnail_url, raw);
  const sharp = (await import('sharp')).default;
  await sharp(raw).resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toFile(path.join(ROOT, 'public', 'thumbs', `${id}.png`));
  log(`${id}: thumbnail -> public/thumbs/${id}.png`);
}

async function build(item) {
  const id = item.id;
  const s = (state[id] ??= {});
  const prompt = `${item.prompt}, ${STYLE}`;
  if (!s.preview) {
    s.preview = (await api('POST', '/v2/text-to-3d', {
      mode: 'preview', prompt: prompt.slice(0, 600), ai_model: 'meshy-6', art_style: 'realistic',
      should_remesh: true, topology: 'triangle', target_polycount: item.polycount, target_formats: ['glb'],
    })).result;
    saveState();
    log(`${id}: preview started`);
  }
  await waitTask(s.preview, id);
  if (!s.refine) {
    s.refine = (await api('POST', '/v2/text-to-3d', {
      mode: 'refine', preview_task_id: s.preview, enable_pbr: true,
      texture_prompt: item.texture.slice(0, 600), target_formats: ['glb'],
    })).result;
    saveState();
    log(`${id}: refine started`);
  }
  const refined = await waitTask(s.refine, id);
  await download(refined.model_urls.glb, path.join(RAW_DIR, `${id}.glb`));
  optimize(id);
  await thumb(id, refined);
  s.done = true;
  saveState();
}

const args = process.argv.slice(2);
if (args[0] === '--optimize') {
  for (const k of SKIS) optimize(k.id);
  process.exit(0);
}
if (args[0] === '--redo') {
  args.shift();
  for (const n of args) delete state[n];
  saveState();
}
KEY = loadKey();
if (args[0] === '--thumb') {
  for (const k of SKIS) if (state[k.id]?.refine) await thumb(k.id);
  process.exit(0);
}
const selected = args.length ? SKIS.filter((a) => args.includes(a.id)) : SKIS;
const queue = selected.filter((a) => !state[a.id]?.done || !fs.existsSync(path.join(OUT_DIR, `${a.id}.glb`)));
log(`building ${queue.length} ski models`);
const failed = [];
for (const a of queue) {
  try { await build(a); } catch (e) { failed.push(a.id); log(`FAILED ${a.id}: ${e.message}`); }
}
log(failed.length ? `finished, ${failed.length} failed: ${failed.join(', ')}` : 'ALL SKIS DONE');
