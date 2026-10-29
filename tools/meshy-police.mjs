// Generates the police car (game/police.js) on Meshy (text-to-3d preview -> refine), downloads the raw GLB to
// assets-src/raw/police and writes the optimised copy to public/models/police/police_car.glb.
// Resumable: task ids live in tools/meshy-police-state.json.
// Usage: NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt node tools/meshy-police.mjs [--redo] [--optimize]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_FILE = path.join(ROOT, 'tools', 'meshy-police-state.json');
const OUT_DIR = path.join(ROOT, 'public', 'models', 'police');
const RAW_DIR = path.join(ROOT, 'assets-src', 'raw', 'police');
const API = 'https://api.meshy.ai/openapi';
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(RAW_DIR, { recursive: true });

const ID = 'police_car';
const PROMPT = 'A modern German police estate car standing alone, side three-quarter view, like a BMW 5 series touring police car: glossy white body with a wide blue and neon fluorescent yellow checkered Battenburg livery stripe along both sides, the word POLIZEI in large blue letters on the front doors, a low flat blue emergency light bar across the roof, black tinted windows, black alloy wheels with winter tyres, headlights, a front grille, no ground, no people, realistic game asset';
const TEX = 'glossy white car paint, blue and neon yellow reflective checkered livery stripe, POLIZEI lettering in blue on the doors, blue roof light bar, black tinted glass, black tyres, clean realistic game textures';

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

async function waitTask(id) {
  for (;;) {
    const t = await api('GET', `/v2/text-to-3d/${id}`);
    if (t.status === 'SUCCEEDED') return t;
    if (t.status === 'FAILED' || t.status === 'CANCELED') throw new Error(`${ID} ${t.status}: ${JSON.stringify(t.task_error)}`);
    log(`${ID}: ${t.status} ${t.progress ?? ''}%`);
    await sleep(10000);
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

function optimize() {
  const raw = path.join(RAW_DIR, `${ID}.glb`);
  const out = path.join(OUT_DIR, `${ID}.glb`);
  if (!fs.existsSync(raw)) return;
  execFileSync('npx', ['gltf-transform', 'optimize', raw, out, '--texture-compress', 'webp', '--texture-size', '2048',
    '--compress', 'meshopt', '--simplify', 'false'], { cwd: ROOT, stdio: 'inherit' });
  log(`${ID}: optimised -> ${Math.round(fs.statSync(out).size / 1024)} KB`);
}

const args = process.argv.slice(2);
if (args.includes('--optimize')) { optimize(); process.exit(0); }
if (args.includes('--redo')) { delete state[ID]; saveState(); }
KEY = loadKey();
const s = (state[ID] ??= {});
if (!s.preview) {
  s.preview = (await api('POST', '/v2/text-to-3d', {
    mode: 'preview', prompt: PROMPT.slice(0, 600), ai_model: 'meshy-6', art_style: 'realistic',
    should_remesh: true, topology: 'triangle', target_polycount: 30000, target_formats: ['glb'],
  })).result;
  saveState();
  log(`${ID}: preview started`);
}
await waitTask(s.preview);
if (!s.refine) {
  s.refine = (await api('POST', '/v2/text-to-3d', {
    mode: 'refine', preview_task_id: s.preview, enable_pbr: true, texture_prompt: TEX.slice(0, 600), target_formats: ['glb'],
  })).result;
  saveState();
  log(`${ID}: refine started`);
}
const refined = await waitTask(s.refine);
await download(refined.model_urls.glb, path.join(RAW_DIR, `${ID}.glb`));
optimize();
s.done = true;
saveState();
log('POLICE CAR DONE');
