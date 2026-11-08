// A second player for the native client's multiplayer check (game --mptest URL --mp-peers 1): a JS client speaking the
// game's protocol (as server/test.mjs's fake clients do) that registers a fresh name, joins the world, walks in a
// circle on the village plaza sending presence at 12 Hz, says hello in the chat, allows any car ride / chalet visit
// asked of it, and watches for the native player's presence rows. Prints what it saw; exit 0 if a native player
// ("Native...") showed up with presence.
// With 'car': it earns two job payouts, buys a Golf at the Autohaus (the server's 'buy'), parks it on the plaza ('veh'
// at) and reports whether the native player rode in it (their presence's vehicle 'car:<name>:<seat>').
//   node native/tools/mp_peer.mjs ws://127.0.0.1:8787/ws [seconds=90] [car]
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '..', '..', 'server', 'package.json'));
const WebSocket = require('ws');

const url = process.argv[2] || 'ws://127.0.0.1:8787/ws';
const seconds = Number(process.argv[3]) || 90;
const withCar = process.argv[4] === 'car';
const name = 'JsPeer' + (1000 + Math.floor(Math.random() * 9000));
const ws = new WebSocket(url);
let n = 1, pid = 0, groundY = 0; // (the plaza's height: taken from the native player's rows once they come)
let rode = null;
const wait = new Map();
const req = (t, d = {}) => new Promise((r) => { const id = n++; wait.set(id, r); ws.send(JSON.stringify({ t, d, id })); });
const seen = new Map(); // pid -> { name, rows, last }
const names = new Map();
const log = (s) => console.log('[peer] ' + s);

ws.on('message', (b) => {
  const m = JSON.parse(b.toString());
  if (m.t === 'res') { const w = wait.get(m.id); if (w) { wait.delete(m.id); w(m); } return; }
  if (m.t === 'join') { names.set(m.d.pid, m.d.name); log(m.d.name + ' joined (pid ' + m.d.pid + ')'); }
  if (m.t === 'leave') log(m.d.name + ' left');
  if (m.t === 'chat') log('chat ' + m.d.name + ': ' + m.d.text);
  if (m.t === 'permAsk') { log(m.d.from + ' asks ' + m.d.kind + ': allowed'); req('permAnswer', { rid: m.d.rid, allow: true }); }
  if (m.t === 'P') for (const r of m.d) {
    if (r[0] === pid) continue;
    const e = seen.get(r[0]) || { name: names.get(r[0]) || '?', rows: 0, last: null };
    e.rows++; e.last = r; e.name = names.get(r[0]) || e.name;
    if (r[9] === 0 && Math.hypot(r[2] - 4, r[4] - 30) < 40) groundY = r[3];
    if (typeof r[13] === 'string' && r[13].startsWith('car:' + name + ':') && !rode) { rode = r[13]; log(e.name + ' is riding in my car (' + r[13] + ')'); }
    seen.set(r[0], e);
  }
});
ws.on('error', (e) => { log('error ' + e.message); process.exit(2); });
ws.on('open', async () => {
  const rg = await req('register', { name });
  if (!rg.ok) { log('register failed: ' + rg.err); process.exit(2); }
  const li = await req('login', { v: 1, name, token: rg.d.token, look: { c: 'skier_red', o: null, s: 'rental' }, tt: 'peer' });
  if (!li.ok) { log('login failed: ' + li.err); process.exit(2); }
  pid = li.d.pid;
  for (const p of li.d.world.players) names.set(p.pid, p.name);
  log(name + ' in world ' + li.d.world.id + ' (pid ' + pid + '), ' + (li.d.world.players.length - 1) + ' other(s) there');
  setTimeout(() => ws.send(JSON.stringify({ t: 'chat', d: { text: 'hello from ' + name } })), 4000);
  const t0 = Date.now();
  const tick = setInterval(() => {
    const t = (Date.now() - t0) / 1000, a = t * 0.35, R = 6;
    const x = 4 + Math.sin(a) * R, z = 30 + Math.cos(a) * R, yaw = a + Math.PI / 2;
    ws.send(JSON.stringify({ t: 'p', d: [Date.now(), x, groundY, z, yaw, Math.cos(a) * R * 0.35, 0, -Math.sin(a) * R * 0.35, 0, 0, 0, 0] }));
  }, 1000 / 12);
  if (withCar) {
    for (let i = 0; i < 2; i++) { const e = await req('earn', { amount: 6000, source: 'job' }); if (!e.ok) log('earn: ' + e.err); }
    const b = await req('buy', { kind: 'car', cfg: { id: 'car_vw_golf_gti', paint: 'red', interior: 'orig', rims: 'orig' } });
    if (!b.ok) log('buy car: ' + b.err);
    else {
      log('bought a ' + b.d.car.id + ' (' + b.d.car.plate + ') for $' + b.d.price + ', money $' + b.d.money);
      const v = await req('veh', { k: 'car', at: [16, groundY, 24, Math.PI / 2] });
      log('car parked on the plaza: ' + (v.ok ? 'ok' : v.err));
    }
  }
  setTimeout(() => {
    clearInterval(tick);
    let ok = false;
    for (const [p, e] of seen) {
      const r = e.last;
      log('saw ' + e.name + ' (pid ' + p + '): ' + e.rows + ' presence rows, last at (' + r[2].toFixed(1) + ', ' + r[3].toFixed(1) + ', ' + r[4].toFixed(1) + ') state ' + r[9] + ' flags ' + r[12] + (r[13] ? ' vehicle ' + r[13] : ''));
      if (/^Native/.test(e.name) && e.rows >= 5) ok = true;
    }
    if (withCar) { log(rode ? 'the native player rode in my car (' + rode + ')' : 'nobody rode in my car'); ok = ok && !!rode; }
    log(ok ? 'PASS: the native player was seen' : 'FAIL: no native player seen');
    ws.close(1000, 'done');
    setTimeout(() => process.exit(ok ? 0 : 1), 300);
  }, seconds * 1000);
});
