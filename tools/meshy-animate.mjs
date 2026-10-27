// Requests a merged animation pack (idle / walk / run / chair-sit) for each rigged character
// from Meshy's animation library and downloads it to public/models/<name>_anims.glb.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').match(/MESHY_API_KEY=(\S+)/)[1];
const state = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'meshy-state.json'), 'utf8'));
// Idle, Casual Walk, Run 2, Chair Sit Idle (female 32 / male 33)
const PACKS = {
  skier_blue: [0, 30, 14, 32], skier_red: [0, 30, 14, 33], skier_green: [0, 30, 14, 33],
  skier_orange: [0, 30, 14, 33], skier_black: [0, 30, 14, 32], skier_purple: [0, 30, 14, 33],
};
// node tools/meshy-animate.mjs [name ...]  (no names = every pack)
const only = process.argv.slice(2);

const api = async (method, url, body) => {
  const r = await fetch('https://api.meshy.ai/openapi' + url, { method, headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${url} ${r.status} ${t}`);
  return JSON.parse(t);
};

await Promise.all(Object.entries(PACKS).filter(([n]) => !only.length || only.includes(n)).map(async ([name, ids]) => {
  const rig = state[name].rig;
  const s = state[name];
  if (!s.anim) {
    s.anim = (await api('POST', '/v1/animations', { rig_task_id: rig, action_ids: ids })).result;
    fs.writeFileSync(path.join(ROOT, 'tools', 'meshy-state.json'), JSON.stringify(state, null, 2));
  }
  for (;;) {
    const t = await api('GET', `/v1/animations/${s.anim}`);
    if (t.status === 'SUCCEEDED') {
      const r = await fetch(t.result.animation_glb_url);
      fs.writeFileSync(path.join(ROOT, 'public', 'models', `${name}_anims.glb`), Buffer.from(await r.arrayBuffer()));
      console.log(name, 'done', t.consumed_credits, 'credits');
      return;
    }
    if (t.status === 'FAILED' || t.status === 'CANCELED') throw new Error(name + ' ' + JSON.stringify(t.task_error));
    await new Promise((r) => setTimeout(r, 6000));
  }
}));
