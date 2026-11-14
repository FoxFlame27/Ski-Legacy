// A second player that puts on a show for the native client's `mpshow` check (SKI_LEGACY_DEBUG=mpshow game --mptest URL
// --mp-peers 1 --png out.png): it speaks the game's protocol as the web client does (src/net/protocol.js rows, flags,
// fallFlags; net/rescue.js 'veh' rescue rows) and plays, on the village plaza in front of the native player:
//    0 -  8 s  walking, no skis                     (state walk, flags 0)
//    8 - 16 s  walking, the skis on the back        (flags hasSkis | carry)
//   16 - 22 s  skiing, carving left and right       (state ski, flags skisOn | hasSkis, crouch 0.25, lean +-0.6)
//   22 - 24 s  a jump                               (flags + air, 1.2 m up)
//   24 - 28 s  the tuck                             (flags + tuck, crouch 0.8)
//   28 - 36 s  a wipeout: thrown, tumbling, lying   (state fall, crouch / lean = the tumble's pitch / roll, fallFlags)
//   36 - 62 s  the rescue: the helicopter comes in and hovers, the winch rope down, on the hook (s 1), into the cabin
//              (s 2), the flight to the side and down, the ambulance up to it, into the ambulance (s 3), gone
//   then walking again until the time is up.
// (in tools/browser, outside the exporters the CMake data step watches)
//   node native/tools/browser/mp_show_peer.mjs ws://127.0.0.1:8787/ws [seconds=80]
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '..', '..', '..', 'package.json'));
const WebSocket = require('ws');
const url = process.argv[2] || 'ws://127.0.0.1:8787/ws';
const seconds = Number(process.argv[3]) || 80;
const name = 'ShowPeer' + (100 + Math.floor(Math.random() * 900));
const ws = new WebSocket(url);
const F = { air: 1, tuck: 2, skisOn: 4, carry: 8, hasSkis: 16 };
const ST = { walk: 0, ski: 1, sit: 4, fall: 6 };
const fallFlags = (side, air, ball, up, axis) => {
  const q = (v, n) => Math.round(Math.min(1, Math.max(0, v || 0)) * n);
  const a = Math.round((Math.atan2(Math.sin(axis || 0), Math.cos(axis || 0)) / (Math.PI * 2)) * 32) & 31;
  return (air ? F.air : 0) | (side < 0 ? 256 : 0) | (q(ball, 15) << 9) | (q(up, 31) << 13) | (a << 18);
};
let n = 1, pid = 0, groundY = null, t0 = 0;
const wait = new Map();
const req = (t, d = {}) => new Promise((r) => { const id = n++; wait.set(id, r); ws.send(JSON.stringify({ t, d, id })); });
const log = (s) => console.log('[show] ' + s);
const r2 = (v) => Math.round(v * 100) / 100;
ws.on('message', (b) => {
  const m = JSON.parse(b.toString());
  if (m.t === 'res') { const w = wait.get(m.id); if (w) { wait.delete(m.id); w(m); } return; }
  if (m.t === 'join') log(m.d.name + ' joined (pid ' + m.d.pid + ')');
  if (m.t === 'P') for (const r of m.d) if (r[0] !== pid && groundY === null && Math.hypot(r[2] - 4, r[4] - 50) < 1.5) { /* (the native player on its mpshow spot) */ groundY = r[3]; t0 = Date.now(); log('the native player stands at y ' + groundY.toFixed(2) + ': the show starts'); }
});
ws.on('error', (e) => { log('error ' + e.message); process.exit(2); });
ws.on('open', async () => {
  const rg = await req('register', { name });
  if (!rg.ok) { log('register failed: ' + rg.err); process.exit(2); }
  const li = await req('login', { v: 1, name, token: rg.d.token, look: { c: 'skier_red', o: null, s: 'rental' }, tt: 'peer' });
  if (!li.ok) { log('login failed: ' + li.err); process.exit(2); }
  pid = li.d.pid;
  log(name + ' in world ' + li.d.world.id + ' (pid ' + pid + ')');
  let last = '', rescueOn = false, vt = 0;
  const born = Date.now();
  setInterval(() => {
    const y0 = groundY ?? 0;
    const t = groundY === null ? -1 : (Date.now() - t0) / 1000;
    let x = 4, y = y0, z = 34, yaw = 0, vx = 0, vy = 0, vz = 0, st = ST.walk, crouch = 0, lean = 0, flags = 0, what = 'waiting';
    const circle = (R, w, tt) => { const a = tt * w; x = 4 + Math.sin(a) * R; z = 34 + Math.cos(a) * R; yaw = a + Math.PI / 2; vx = Math.cos(a) * R * w; vz = -Math.sin(a) * R * w; };
    if (t < 0) circle(3, 0.4, (Date.now() - born) / 1000);
    else if (t < 8) { what = 'walk, no skis'; circle(5, 0.36, t); }
    else if (t < 16) { what = 'walk, skis carried'; circle(5, 0.36, t); flags = F.hasSkis | F.carry; }
    else if (t < 28) {
      // skiing across the plaza and back: 9 m/s, carving
      const u = t - 16, p = (u % 6) / 6, dir = p < 0.5 ? 1 : -1, k = p < 0.5 ? p * 2 : (1 - p) * 2;
      x = -8 + 24 * k; z = 34 + Math.sin(u * 2.2) * 1.6; vx = dir * 8; vz = Math.cos(u * 2.2) * 3.5; yaw = Math.atan2(vx, vz);
      st = ST.ski; flags = F.skisOn | F.hasSkis; crouch = 0.25; lean = Math.sin(u * 2.2) * 0.6 * dir; what = 'ski, carving';
      if (t >= 22 && t < 24) { const q = (t - 22) / 2; y = y0 + 4.8 * q * (1 - q); vy = 4.8 * (1 - 2 * q) / 2; flags |= F.air; lean = 0; crouch = 0.45; what = 'ski, jump'; }
      else if (t >= 24) { flags |= F.tuck; crouch = 0.8; lean *= 0.3; what = 'ski, tuck'; }
    } else if (t < 62) {
      // the wipeout at (6, 34): thrown (2 s in the air, somersaulting), rolling, lying; then the rescue's seats
      const u = t - 28;
      x = 6 + Math.min(u, 3) * 1.5; z = 34; yaw = Math.PI / 2;
      st = ST.fall;
      const air = u < 1.2, roll = Math.min(u, 3) / 3;
      if (air) { const q = u / 1.2; y = y0 + 3.2 * q * (1 - q); vx = 6; }
      crouch = air ? u * 5 : 6 + roll * 1.2;            // the body's pitch (somersault)
      lean = roll * 1.57;                               // its roll (onto the side)
      flags = F.skisOn | F.hasSkis | fallFlags(1, air, air ? 0.8 : 0.8 * (1 - roll), 0, 0.3);
      what = air ? 'wipeout, thrown' : u < 3 ? 'wipeout, tumbling' : 'wipeout, lying';
      if (t >= 46 && t < 56) { st = ST.sit; crouch = 0; lean = 0; flags = F.hasSkis; what = t < 50 ? 'on the winch' : 'in the cabin'; }
      if (t >= 56) { st = ST.sit; crouch = 0; lean = 0; flags = F.hasSkis; what = 'in the ambulance'; }
    } else { what = 'walk again'; circle(5, 0.36, t); }
    if (what !== last) { last = what; log((t < 0 ? '--' : t.toFixed(1)) + ' s: ' + what); }
    ws.send(JSON.stringify({ t: 'p', d: [Date.now(), r2(x), r2(y), r2(z), r2(yaw), r2(vx), r2(vy), r2(vz), st, r2(crouch), r2(lean), flags] }));
    // the rescue (net/rescue.js): 'veh' rows about 6 times a second
    if (t >= 36 && t < 62) {
      if ((vt += 1 / 12) >= 1 / 6) {
        vt = 0;
        const u = t - 36, px = 10.5, pz = 34;
        // in from the north-east and down to a hover 9 m over them; from 14 s to the side and down onto the snow
        const hk = Math.min(1, u / 6), away = Math.max(0, Math.min(1, (u - 14) / 5));
        const hx = px + (1 - hk) * 60 + away * 16, hz = pz - (1 - hk) * 80 - away * 10, hy = y0 + 9 + (1 - hk) * 30 - away * 7.3;
        const hyaw = Math.atan2(px - hx, pz - hz) * (1 - hk) + 0.4 * hk;
        const rope = u < 7 ? 0 : u < 10 ? (u - 7) / 3 * 8.2 : u < 14 ? 8.2 * (1 - (u - 10) / 4) : 0;
        const s = u < 10 ? 0 : u < 14 ? 1 : u < 20 ? 2 : 3;
        const amb = u >= 12 ? [r2(hx - 12 + Math.max(0, 19 - u) * 6), r2(y0), r2(hz + 4), r2(Math.PI / 2), u < 19 ? 6 : 0] : null;
        const msg = { k: 'rescue', h: u < 24 ? [r2(hx), r2(hy), r2(hz), r2(hyaw), r2(0.08 * (1 - hk)), 0, away >= 1 && u > 21 ? 0.5 : 1] : null, a: amb, s, rope: r2(rope), l: u >= 12 };
        rescueOn = true;
        req('veh', msg).then((m) => { if (!m.ok && last !== 'veh-err') { last = 'veh-err'; log('veh rescue refused: ' + m.err); } });
      }
    } else if (rescueOn) { rescueOn = false; req('veh', { k: 'rescue', off: true }); log('rescue over'); }
  }, 1000 / 12);
  setTimeout(() => { log('done'); ws.close(1000, 'done'); setTimeout(() => process.exit(0), 300); }, seconds * 1000 + 30000);
});
