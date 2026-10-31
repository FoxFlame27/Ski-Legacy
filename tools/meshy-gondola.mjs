// Generates the gondola end stations on Meshy (text-to-3d preview -> refine, PBR on), modelled on a modern
// Doppelmayr D-Line 10-seater station: the valley station (larger, with a ticket hall) and the compact mountain
// station. Raw GLBs go to assets-src/raw/gondola, optimised copies (WebP textures, meshopt) to public/models.
// (Oct 31 2026, the user: "please make the gondola station way better, the Meshy models are very bad, please fix
// that": the old gondola_station.glb was a 2.8 MB blob; these are prompted as long buildings open at both short
// ends, the cable line along their length, and lifts.js cuts the cabin lanes clear anyway.)
// Resumable: task ids live in tools/meshy-gondola-state.json.
// Usage: NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt node tools/meshy-gondola.mjs [id ...]
//        ... --redo id ...   (discard old tasks for those ids)
//        ... --optimize      (only re-run the optimiser on downloaded raws)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_FILE = path.join(ROOT, 'tools', 'meshy-gondola-state.json');
const OUT_DIR = path.join(ROOT, 'public', 'models');
const RAW_DIR = path.join(ROOT, 'assets-src', 'raw', 'gondola');
const API = 'https://api.meshy.ai/openapi';
fs.mkdirSync(RAW_DIR, { recursive: true });

const STYLE = 'modern Doppelmayr D-Line detachable gondola lift terminal, contemporary alpine architecture, standing alone on a flat base, no terrain, no snow, no people, no cabins, no cables, no text, no logos, game asset';
const TEX = 'clean realistic PBR materials: brushed silver steel, dark anthracite steel frame, clear blue tinted glass, smooth light grey board-formed concrete, warm larch wood accents';
const ITEMS = [
  {
    id: 'gondola_station',
    poly: 30000,
    prompt: 'A long low modern gondola valley station building, rectangular footprint twice as long as wide. A sleek curved glass and silver steel roof canopy arches over the whole length like a wing, its two short ends wide open as big arched portals where the gondola cabins enter and leave. Under the canopy a boarding platform with a U shaped turnaround at the back. Along one long side a light grey concrete base with floor to ceiling glass walls forming a ticket hall with an entrance. Slim dark steel columns, flat roof edges',
    texture: 'modern gondola valley station: curved silver steel and glass roof canopy, dark grey steel columns, light grey concrete base, floor to ceiling clear glass walls, larch wood ticket hall',
  },
  {
    id: 'gondola_station_top',
    poly: 24000,
    prompt: 'A compact modern gondola mountain top station, rectangular footprint about one and a half times as long as wide. A sleek curved glass and silver steel roof canopy arches over it like a wing, one short end wide open as a large arched portal where the gondola cabins enter and leave, a U shaped turnaround under the canopy at the closed back end. A light grey concrete base with large glass walls on both long sides, slim dark steel columns',
    texture: 'modern gondola mountain station: curved silver steel and glass roof canopy, dark grey steel columns, light grey concrete base, large clear glass walls',
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

// (the same optimise step as the furniture / train tools: WebP textures, meshopt; kept under ~2 MB)
function optimize(id) {
  const raw = path.join(RAW_DIR, `${id}.glb`);
  const out = path.join(OUT_DIR, `${id}.glb`);
  if (!fs.existsSync(raw)) return;
  const run = (tex, ratio) => execFileSync('npx', ['gltf-transform', 'optimize', raw, out,
    '--texture-compress', 'webp', '--texture-size', String(tex), '--compress', 'meshopt',
    '--simplify-ratio', String(ratio)], { cwd: ROOT, stdio: 'ignore' });
  run(1024, 0.6);
  if (fs.statSync(out).size > 2 * 1024 * 1024) run(1024, 0.35);
  if (fs.statSync(out).size > 2 * 1024 * 1024) run(512, 0.3);
  log(`${id}: optimised -> ${Math.round(fs.statSync(out).size / 1024)} KB`);
}

async function build(item) {
  const id = item.id;
  const s = (state[id] ??= {});
  const prompt = `${item.prompt}, ${STYLE}`;
  if (!s.preview) {
    s.preview = (await api('POST', '/v2/text-to-3d', {
      mode: 'preview', prompt: prompt.slice(0, 600), ai_model: 'meshy-6', art_style: 'realistic',
      should_remesh: true, topology: 'triangle', target_polycount: item.poly, target_formats: ['glb'],
    })).result;
    saveState();
    log(`${id}: preview started`);
  }
  await waitTask(s.preview, id);
  if (!s.refine) {
    s.refine = (await api('POST', '/v2/text-to-3d', {
      mode: 'refine', preview_task_id: s.preview, enable_pbr: true,
      texture_prompt: `${item.texture}, ${TEX}`.slice(0, 600), target_formats: ['glb'],
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
  for (const it of ITEMS) optimize(it.id);
  process.exit(0);
}
if (args[0] === '--redo') {
  args.shift();
  for (const n of args) delete state[n];
  saveState();
}
KEY = loadKey();
const selected = args.length ? ITEMS.filter((a) => args.includes(a.id)) : ITEMS;
const queue = selected.filter((a) => !state[a.id]?.done);
log(`building ${queue.length} gondola station models`);
const failed = [];
await Promise.all(queue.map(async (a) => {
  try { await build(a); } catch (e) { failed.push(a.id); log(`FAILED ${a.id}: ${e.message}`); }
}));
log(failed.length ? `finished, ${failed.length} failed: ${failed.join(', ')}` : 'ALL GONDOLA STATIONS DONE');
