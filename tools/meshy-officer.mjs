// Generates the police officer (game/police.js: the one who gets out of the patrol car, fines / arrests you and runs
// after you on foot; baked seated as the patrol car's driver) on Meshy: text-to-3d preview -> refine -> rig ->
// animation pack (idle / walk / run / chair sit, as tools/meshy-animate.mjs). The raw downloads go to
// assets-src/raw/police/, the optimised copies to public/models/police_officer_rigged.glb + police_officer_anims.glb
// (same gltf-transform settings as tools/optimize-models.sh: 2048 px WebP textures + meshopt; 64 px for the anims).
// Separate manifest + state file (tools/meshy-officer-state.json, task ids saved as soon as they exist) so a restart
// resumes instead of paying again.
// Usage: NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt node tools/meshy-officer.mjs [--redo] [--optimize]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_FILE = path.join(ROOT, 'tools', 'meshy-officer-state.json');
const OUT_DIR = path.join(ROOT, 'public', 'models');
const RAW_DIR = path.join(ROOT, 'assets-src', 'raw', 'police');
const THUMBS = path.join(ROOT, 'assets-src', 'thumbs');
const API = 'https://api.meshy.ai/openapi';
for (const d of [RAW_DIR, THUMBS]) fs.mkdirSync(d, { recursive: true });

const ID = 'police_officer';
const HEIGHT = 1.82;
// Idle, Casual Walk, Run 2, Chair Sit Idle (male), as the skiers' packs
const ACTIONS = [0, 30, 14, 33];
// (the A-pose as tools/meshy-fans.mjs, a little shorter: Meshy takes 600 characters)
const POSE = 'standing upright on flat ground in a strict A-pose: both arms straight, hanging down and spread 45 degrees away from the body, the hands far from the body, open empty hands, legs straight and slightly apart, looking forward.';
const PROMPT = `Full body 3D game character of an adult male police officer, ${POSE} Dark navy blue winter police uniform: peaked police cap with a badge, navy winter jacket with a silver chest badge and a POLICE patch, yellow high-visibility reflective vest, black duty belt with radio and holster, dark trousers, black boots. No gun in hand. Realistic proportions, photorealistic`;
const TEX = 'photorealistic dark navy blue police uniform, navy peaked police cap with silver badge, navy winter jacket with silver badge and POLICE patch, fluorescent yellow reflective safety vest with silver stripes, black leather duty belt with radio and holster, dark navy trousers, black leather boots, realistic clean-shaven male face';

function loadKey() {
  if (process.env.MESHY_API_KEY) return process.env.MESHY_API_KEY;
  const m = fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').match(/MESHY_API_KEY=(\S+)/);
  if (!m) throw new Error('MESHY_API_KEY missing from .env.local');
  return m[1];
}

const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
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
async function waitTask(kind, id) {
  let last = -1;
  for (;;) {
    const t = await api('GET', `${kind}/${id}`);
    if (t.status === 'SUCCEEDED') return t;
    if (t.status === 'FAILED' || t.status === 'CANCELED') throw new Error(`${ID} ${kind} ${t.status}: ${JSON.stringify(t.task_error)}`);
    if (t.progress !== last) log(`${ID}: ${kind.split('/').pop()} ${t.status} ${t.progress ?? ''}%`);
    last = t.progress;
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

function optimize() {
  for (const [name, size] of [[`${ID}_rigged`, 2048], [`${ID}_anims`, 64]]) {
    const raw = path.join(RAW_DIR, `${name}.glb`), out = path.join(OUT_DIR, `${name}.glb`);
    if (!fs.existsSync(raw)) continue;
    execFileSync('npx', ['gltf-transform', 'optimize', raw, out, '--texture-compress', 'webp', '--texture-size', String(size),
      '--compress', 'meshopt', '--simplify', 'false', '--instance', 'false', '--join', 'false'], { cwd: ROOT, stdio: 'inherit' });
    log(`${name}: optimised -> ${Math.round(fs.statSync(out).size / 1024)} KB`);
  }
}

const args = process.argv.slice(2);
if (args.includes('--optimize')) { optimize(); process.exit(0); }
if (args.includes('--redo')) { delete state[ID]; saveState(); }
if (PROMPT.length > 600 || TEX.length > 600) throw new Error(`prompt too long: ${PROMPT.length} / ${TEX.length}`);
KEY = loadKey();
const s = (state[ID] ??= {});
if (!s.preview) {
  s.preview = (await api('POST', '/v2/text-to-3d', {
    mode: 'preview', prompt: PROMPT, ai_model: 'meshy-6', art_style: 'realistic', should_remesh: true, topology: 'triangle',
    target_polycount: 30000, target_formats: ['glb'], pose_mode: 'a-pose',
  })).result;
  saveState(); log(`${ID}: preview ${s.preview}`);
}
await waitTask('/v2/text-to-3d', s.preview);
if (!s.refine) {
  s.refine = (await api('POST', '/v2/text-to-3d', {
    mode: 'refine', preview_task_id: s.preview, enable_pbr: true, texture_resolution: '2k', texture_prompt: TEX, target_formats: ['glb'],
  })).result;
  saveState(); log(`${ID}: refine ${s.refine}`);
}
const refined = await waitTask('/v2/text-to-3d', s.refine);
if (refined.thumbnail_url) await download(refined.thumbnail_url, path.join(THUMBS, `${ID}.png`)).catch(() => {});
if (!s.rig) {
  s.rig = (await api('POST', '/v1/rigging', { input_task_id: s.refine, height_meters: HEIGHT })).result;
  saveState(); log(`${ID}: rig ${s.rig}`);
}
const rig = await waitTask('/v1/rigging', s.rig);
await download(rig.result.rigged_character_glb_url, path.join(RAW_DIR, `${ID}_rigged.glb`));
if (!s.anim) {
  s.anim = (await api('POST', '/v1/animations', { rig_task_id: s.rig, action_ids: ACTIONS })).result;
  saveState(); log(`${ID}: animations ${s.anim}`);
}
const anim = await waitTask('/v1/animations', s.anim);
await download(anim.result.animation_glb_url, path.join(RAW_DIR, `${ID}_anims.glb`));
optimize();
s.done = true;
saveState();
log('POLICE OFFICER DONE');
