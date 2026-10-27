// Generates the race spectator characters on Meshy (text-to-3d preview -> refine -> rig) and saves the raw
// rigged GLBs to assets-src/raw/fan_<name>.glb (tools/build-fans.mjs turns them into the game's crowd models).
// Separate manifest + state file (tools/meshy-fans-state.json) so it never races the main asset pipeline.
// Usage: node tools/meshy-fans.mjs [name ...]   |   node tools/meshy-fans.mjs --redo name
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_FILE = path.join(ROOT, 'tools', 'meshy-fans-state.json');
const RAW = path.join(ROOT, 'assets-src', 'raw');
const THUMBS = path.join(ROOT, 'assets-src', 'thumbs');
const API = 'https://api.meshy.ai/openapi';
const KEY = process.env.MESHY_API_KEY || fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').match(/MESHY_API_KEY=(\S+)/)[1];

const POSE = 'standing upright on flat ground in a strict A-pose: both arms straight with the elbows locked, hanging down and spread 45 degrees away from the body, the hands far away from the body and the clothes, open hands with the fingers together, legs straight and slightly apart, looking straight forward.';
const TAIL = 'Nothing in the hands, nothing on the feet but boots, no skis. Realistic proportions, photorealistic';
export const FANS = [
  {
    name: 'fan_man',
    height: 1.8,
    prompt: `Full body 3D game character of an adult man, a winter sports spectator, ${POSE} Wearing a bright red puffy down winter jacket zipped up, dark blue jeans, a grey knitted beanie with a pom-pom, a dark striped wool scarf, black gloves and brown leather winter boots. Short dark beard, friendly face. ${TAIL}`,
    texture: 'photorealistic bright red quilted down jacket, dark blue denim jeans, grey knitted wool beanie with pom-pom, dark striped wool scarf, black gloves, brown leather winter boots, realistic bearded face',
  },
  {
    name: 'fan_woman',
    height: 1.68,
    prompt: `Full body 3D game character of an adult woman, a winter sports spectator, ${POSE} Wearing a long navy blue padded winter parka reaching the thighs, black snow trousers, a white knitted beanie, a red wool scarf, white gloves and tall beige fur-lined snow boots. Long brown hair under the beanie. ${TAIL}`,
    texture: 'photorealistic navy blue quilted long winter parka, black snow trousers, white cable knit beanie, red wool scarf, white gloves, beige suede snow boots with fur trim, long brown hair, realistic face',
  },
  {
    name: 'fan_elder',
    height: 1.76,
    prompt: `Full body 3D game character of an older man with a grey moustache and a friendly face, a winter sports spectator, ${POSE} Wearing a dark green insulated winter jacket, brown corduroy trousers, a brown knitted wool hat, a beige wool scarf, brown leather gloves and dark brown winter boots. No goggles, no glasses, the face fully visible. ${TAIL}`,
    texture: 'photorealistic dark green insulated winter jacket with pockets, brown corduroy trousers, brown knitted wool hat, beige wool scarf, brown leather gloves, dark brown winter boots, realistic older face with grey moustache, no goggles',
  },
  {
    name: 'fan_girl',
    height: 1.66,
    prompt: `Full body 3D game character of a young woman, a ski race spectator, ${POSE} Wearing a light blue ski jacket, white ski trousers, white fluffy earmuffs, ski goggles pushed up on the forehead, pink gloves and white snow boots. Blonde hair in a ponytail. ${TAIL}`,
    texture: 'photorealistic light blue ski jacket with white zipper, white ski trousers, white fluffy earmuffs, ski goggles on the forehead, pink gloves, white snow boots, blonde ponytail, realistic face',
  },
  {
    name: 'fan_kid',
    height: 1.38,
    prompt: `Full body 3D game character of a ten year old child, a ski race spectator, ${POSE} Wearing a yellow one-piece snowsuit, a red knitted bobble hat, a blue scarf, blue gloves and red snow boots. ${TAIL}`,
    texture: 'photorealistic bright yellow padded one-piece snowsuit, red knitted bobble hat, blue knitted scarf, blue gloves, red snow boots, realistic child face',
  },
  {
    name: 'fan_lady',
    height: 1.64,
    prompt: `Full body 3D game character of an older woman with short grey hair and a warm smile, a winter sports spectator, ${POSE} Wearing a burgundy red padded winter coat reaching the hips, dark grey wool trousers, a cream white knitted hat, black leather gloves and black winter boots. ${TAIL}`,
    texture: 'photorealistic burgundy red quilted winter coat, dark grey wool trousers, cream white knitted hat, black leather gloves, black leather winter boots, short grey hair, realistic older woman face',
  },
  {
    name: 'fan_teen',
    height: 1.74,
    prompt: `Full body 3D game character of a teenage boy, a ski race spectator, ${POSE} Wearing a black and orange snowboard jacket, baggy grey snow pants, an orange knitted beanie, black gloves and black snowboard boots. ${TAIL}`,
    texture: 'photorealistic black snowboard jacket with orange panels, baggy grey snow pants, orange knitted beanie, black gloves, black snowboard boots, realistic teenage face',
  },
  {
    name: 'fan_skier',
    height: 1.82,
    prompt: `Full body 3D game character of a young man in ski clothes watching a ski race, ${POSE} Wearing a royal blue ski jacket with white stripes, black ski pants, a white ski helmet with mirrored goggles pushed up on top of the helmet, black gloves and blue ski boots. The face fully visible. ${TAIL}`,
    texture: 'photorealistic royal blue ski jacket with white stripes, black ski pants, white glossy ski helmet, mirrored goggles on the helmet, black gloves, blue ski boots, realistic face',
  },
];

const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, url, body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API + url, { method, headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
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
    if (t.status === 'FAILED' || t.status === 'CANCELED') throw new Error(`${name} ${kind} ${t.status}: ${JSON.stringify(t.task_error)}`);
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

async function build(a) {
  const s = (state[a.name] ??= {});
  if (!s.preview) {
    s.preview = (await api('POST', '/v2/text-to-3d', {
      mode: 'preview', prompt: a.prompt, ai_model: 'meshy-6', should_remesh: true, topology: 'triangle',
      target_polycount: a.polycount ?? 16000, target_formats: ['glb'], pose_mode: 'a-pose',
    })).result;
    saveState(); log(`${a.name}: preview ${s.preview}`);
  }
  await waitTask('/v2/text-to-3d', s.preview, a.name);
  if (!s.refine) {
    s.refine = (await api('POST', '/v2/text-to-3d', {
      mode: 'refine', preview_task_id: s.preview, enable_pbr: true, texture_resolution: '2k', texture_prompt: a.texture, target_formats: ['glb'],
    })).result;
    saveState(); log(`${a.name}: refine ${s.refine}`);
  }
  const refined = await waitTask('/v2/text-to-3d', s.refine, a.name);
  if (refined.thumbnail_url) await download(refined.thumbnail_url, path.join(THUMBS, `${a.name}.png`));
  if (!s.rig) {
    s.rig = (await api('POST', '/v1/rigging', { input_task_id: s.refine, height_meters: a.height })).result;
    saveState(); log(`${a.name}: rig ${s.rig}`);
  }
  const rig = await waitTask('/v1/rigging', s.rig, a.name);
  await download(rig.result.rigged_character_glb_url, path.join(RAW, `${a.name}.glb`));
  s.done = true; saveState();
  log(`${a.name}: rigged model saved`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === '--redo') { for (const n of args.slice(1)) delete state[n]; saveState(); args.shift(); }
  const queue = FANS.filter((a) => (!args.length || args.includes(a.name)) && !(state[a.name]?.done && fs.existsSync(path.join(RAW, `${a.name}.glb`))));
  log(`building ${queue.map((a) => a.name).join(', ')}`);
  let fails = 0;
  await Promise.all(queue.map((a) => build(a).catch((e) => { fails++; log(`FAILED ${a.name}: ${e.message}`); })));
  log(fails ? `${fails} failed` : 'ALL FANS DONE');
}
