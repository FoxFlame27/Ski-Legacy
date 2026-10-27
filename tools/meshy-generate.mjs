// Generates all Ski Legacy 3D assets on Meshy (text-to-3d preview -> refine -> optional rig),
// downloads GLBs to public/models and thumbnails to assets-src/thumbs.
// Resumable: task ids are stored in tools/meshy-state.json.
// Usage: node tools/meshy-generate.mjs [assetName ...]   (no names = all assets)
//        node tools/meshy-generate.mjs --redo name        (discard old tasks for name and regenerate)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSETS } from './meshy-assets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_FILE = path.join(ROOT, 'tools', 'meshy-state.json');
const MODELS_DIR = path.join(ROOT, 'public', 'models');
const THUMBS_DIR = path.join(ROOT, 'assets-src', 'thumbs');
const API = 'https://api.meshy.ai/openapi';

function loadKey() {
  if (process.env.MESHY_API_KEY) return process.env.MESHY_API_KEY;
  const env = fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8');
  const m = env.match(/MESHY_API_KEY=(\S+)/);
  if (!m) throw new Error('MESHY_API_KEY missing from .env.local');
  return m[1];
}
const KEY = loadKey();

const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, url, body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API + url, {
      method,
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 && attempt < 30) { await sleep(10000); continue; }
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${text}`);
    return text ? JSON.parse(text) : {};
  }
}

async function waitTask(kind, id, name) {
  let last = -1;
  for (;;) {
    const t = await api('GET', `${kind}/${id}`);
    if (t.status === 'SUCCEEDED') return t;
    if (t.status === 'FAILED' || t.status === 'CANCELED') {
      throw new Error(`${name} ${kind} ${t.status}: ${JSON.stringify(t.task_error)}`);
    }
    if (t.progress !== last && t.progress % 25 === 0) log(`${name}: ${kind.split('/').pop()} ${t.status} ${t.progress}%`);
    last = t.progress;
    await sleep(8000);
  }
}

async function download(url, file) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${url} -> ${res.status}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

async function build(asset) {
  const s = (state[asset.name] ??= {});
  const name = asset.name;

  if (!s.preview) {
    const body = {
      mode: 'preview',
      prompt: asset.prompt,
      ai_model: 'meshy-6',
      should_remesh: true,
      topology: 'triangle',
      target_polycount: asset.polycount ?? 20000,
      target_formats: ['glb'],
    };
    if (asset.pose) body.pose_mode = asset.pose;
    s.preview = (await api('POST', '/v2/text-to-3d', body)).result;
    saveState();
    log(`${name}: preview started ${s.preview}`);
  }
  await waitTask('/v2/text-to-3d', s.preview, name);

  if (!s.refine) {
    s.refine = (await api('POST', '/v2/text-to-3d', {
      mode: 'refine',
      preview_task_id: s.preview,
      enable_pbr: true,
      texture_resolution: asset.tex4k ? '4k' : '2k',
      texture_prompt: asset.texture ?? asset.prompt,
      target_formats: ['glb'],
    })).result;
    saveState();
    log(`${name}: refine started ${s.refine}`);
  }
  const refined = await waitTask('/v2/text-to-3d', s.refine, name);
  await download(refined.model_urls.glb, path.join(MODELS_DIR, `${name}.glb`));
  if (refined.thumbnail_url) await download(refined.thumbnail_url, path.join(THUMBS_DIR, `${name}.png`));
  log(`${name}: model downloaded (${refined.consumed_credits} credits)`);

  if (asset.rig) {
    if (!s.rig) {
      s.rig = (await api('POST', '/v1/rigging', { input_task_id: s.refine, height_meters: asset.height ?? 1.78 })).result;
      saveState();
      log(`${name}: rigging started ${s.rig}`);
    }
    const rig = await waitTask('/v1/rigging', s.rig, name);
    await download(rig.result.rigged_character_glb_url, path.join(MODELS_DIR, `${name}_rigged.glb`));
    const anim = rig.result.basic_animations;
    if (anim?.walking_glb_url) await download(anim.walking_glb_url, path.join(MODELS_DIR, `${name}_walk.glb`));
    if (anim?.running_glb_url) await download(anim.running_glb_url, path.join(MODELS_DIR, `${name}_run.glb`));
    log(`${name}: rig + animations downloaded`);
  }
  s.done = true;
  saveState();
}

const args = process.argv.slice(2);
if (args[0] === '--redo') {
  for (const n of args.slice(1)) delete state[n];
  saveState();
  args.shift();
}
const selected = args.length ? ASSETS.filter((a) => args.includes(a.name)) : ASSETS;
const queue = selected.filter((a) => !state[a.name]?.done || !fs.existsSync(path.join(MODELS_DIR, `${a.name}.glb`)));
log(`building ${queue.length} assets: ${queue.map((a) => a.name).join(', ')}`);

const CONCURRENCY = 6;
let failures = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (queue.length) {
    const a = queue.shift();
    try { await build(a); } catch (e) { failures++; log(`FAILED ${a.name}: ${e.message}`); }
  }
}));
log(failures ? `finished with ${failures} failures` : 'ALL ASSETS DONE');
