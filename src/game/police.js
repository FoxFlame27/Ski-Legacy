// POLICE (Oct 29, the user: "if you crash into a car or player the police will come after you and you can choose to
// run away and if you escape out of their radius for 3 min they will let you escape but to make you stop they crash
// into you and if you get caught while escaping it costs 2k$ and you have to spend 1 and half min in a new prison ...
// otherwise if you just stop and let them bill you it costs 500$ like gta kinda but if your car becomes wrecked from
// the car crashes from the police it wont get repaired"; "generate police cars with meshy and bots drive after you and
// they also step out of the car to bill you or arrest you").
//
//  - The trigger: driving, you hit a car (traffic, parked, another player's) or a person (peoplehits.js, another
//    player on foot) at TUNING.triggerKmh or more (drive.js onHit). Not in races, the bus intro or interiors; being
//    hit by the police never calls them again (their contacts are handled here, not by drive.js's bash()).
//  - The response: one patrol car (two once you flee) appears out of sight 300-500 m away on the road network (the
//    bus / access roads as one graph, towtruck.js) and chases you: along the roads (shortest way, right-hand lane)
//    while far, straight at you when close or off the roads, steering round colliders and trees, on the terrain.
//    The HUD: a WANTED badge (time wanted, the escape countdown), a siren (audio.setSiren: the two-tone).
//  - Stop (< 3 km/h for 3 s) with them within 40 m: they pull up behind you, an officer gets out, walks to your
//    window, "License and registration... that's a fine ($1,000, +$500 for every earlier one)", walks back; they drive off. Wanted cleared.
//  - Don't stop (TUNING.graceS after they reach you) and you are fleeing: they ram you (real knocks / crashes through
//    drive.js: damage), a second car joins. 1:30 in all further than 100 m from every patrol car: escaped.
//    Rammed / blocked to a stop, or caught on foot within 4 m: arrested ($3,000, +$1,000 for every earlier one; prison.jail(90)). Wrecked by their
//    rams: the car is lost (carrental.js: e.policeWreck, the rental ends, no repair) and you are arrested too.
//  - Multiplayer: the patrol cars are local to the offender; their poses go out as 'veh' { k: 'police', cars } (like
//    the tow truck, net/tow.js) and the others draw them (net/vehicles.js updatePolice). The officers on foot only here.
//    Fines come off save.money (multiplayer: the session's money guard sends them as a 'game' spend: debt allowed).
// The model: Meshy (tools/meshy-police.mjs: a white estate, blue and neon-yellow livery, POLIZEI on the doors, a
// roof bar), public/models/police/police_car.glb; the flashing blue lenses are ours, laid over its roof bar. No model:
// a BMW X3 from the fleet painted white with a POLIZEI band.
import * as THREE from 'three';
import { world } from '../world/world.js';
import { loadGLB } from '../core/assets.js';
import { carTemplate, carInstance, driverEye } from './cars.js';
import { busRoads, laneDistance, ROAD_HALF } from './bus/roads.js';
import { roadGraph, roadNearest, obb } from './towtruck.js';
import { addTrafficBlocker } from './traffic.js';
import { Smoke } from './carlights.js';
import { makeFallbackFigure } from './jobs/props.js';
import { resetRig } from './jobs/actors.js';
import { net } from '../net/client.js';
import { isMP } from '../net/mode.js';
import { ST } from '../net/protocol.js';

// The officers: a Meshy police officer in a navy winter uniform + hi-vis vest (tools/meshy-officer.mjs,
// public/models/police_officer_rigged.glb + _anims.glb), loaded in the background (never blocks the start). Until it is
// in (or without it): a skier from the job pool, else a stand-in figure. Only the police use him (not the NPC lists).
const OFFICER = 'police_officer';

export const TUNING = {
  triggerKmh: 25,    // a hit at this closing speed (km/h) or more calls the police
  fine: 1000,        // stop and pay (the user: $1,000; more each time, see fineNow)
  arrestFine: 3000,  // caught fleeing ($3,000; more each time)
  fineStep: 500,     // $ more for every earlier fine or arrest (save.policeRecord)
  arrestStep: 1000,  // $ more on an arrest for every earlier one
  jailS: 90,         // prison.jail(seconds)
  escapeS: 90,       // s (in all) further than escapeR from every patrol car: escaped (the user: "1 min 30, not 3 min")
  escapeR: 100,      // m
  stopR: 40,         // m: stopped with a patrol car this close: pulled over
  stopKmh: 3,        // ...below this speed
  stopS: 3,          // ...for this long
  spawnMin: 260, spawnMax: 420, // m from you, on the roads, out of sight (Oct 30: nearer, they reach you sooner)
  reachR: 60,        // m: they have reached you (the grace to pull over starts)
  graceS: 6,         // s to pull over once they reach you; still moving after it: fleeing
  footCatchR: 4,     // m: an officer on foot this close: caught
  vRoad: 52,         // m/s (187 km/h) on the roads near you (the bends ahead slow them: A_LAT)
  vTop: 250 / 3.6,   // m/s: never faster (the user: "up to 250 km/h"): the catch-up and a ram run up to it
  vOff: 25,          // m/s off them
  catchUp: 0.34,     // up to this much faster than vRoad while far behind you (120-370 m: GTA's catch-up; 250 km/h)
  catchFrom: 120,    // m: the catch-up starts this far behind you
  ramExtra: 11,      // m/s over your speed at most, closing in for a ram (a PIT: alongside, then a shove)
  ramMult: 1.7,      // a police ram counts this much harder (push bars): drive.js knock / crash speed
  ramMin: 15,        // m/s: a PIT / T-bone that connects counts as at least this (always a real knock, never a brush)
  ramPush: 3.2,      // m/s sideways shove into you on a ram (on top of the impulse)
  spin: 1.5,         // x the spin a ram puts on your car (the rear quarter: a PIT spins you out)
  ramGapS: 1.1,      // s a patrol car drops back after a ram before the next (Oct 30: was 2.5)
  tboneR: 70,        // m: crossing your path (a junction, a side road) this near: it drives into your side
  junctionM: 260,    // m: the second car cuts you off at the next junction on your road within this far
  cooldownS: 6,
  holdR: 12,         // m: a patrol car this close to you for holdS (in all; it ebbs away when they're further) ...
  holdS: 10,         // s: ... and they get out and arrest you (the user: "you can just sit in your car and they won't arrest you")
  wreckKmh: 15,      // you hitting a patrol car: damage % = (km/h closing - this) x wreckPer; 100 %: wrecked
  wreckPer: 0.9,
  backupS: 7,        // s after a patrol car is wrecked before another comes (the chase goes on meanwhile)
  wreckStayS: 45,    // s a wreck stays where it is (then gone once out of sight)
};
const CRASH_V = 70 / 3.6, KNOCK_V = 30 / 3.6; // (drive.js)
const LEN = 4.85, WB = 2.95, LANE = 1.6, WALK_V = 1.6, RUN_V = 5.4;
const MODEL = 'police/police_car';
const SEND_DT = 1 / 6;
const usd = (n) => `$${Math.round(n).toLocaleString('en-US')}`;
const FOOT = new Set([ST.walk, ST.ski, ST.fall]);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const hyp = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const UP = new THREE.Vector3(0, 1, 0);
const _e = new THREE.Euler(0, 0, 0, 'YXZ'), _v = new THREE.Vector3(), _m = new THREE.Matrix4(), _fr = new THREE.Frustum();

// ------------------------------------------------------------------ the model (shared with net/vehicles.js)
let gltfP = null, GL = null, settled = false, FIT = null;
/** Start loading the patrol car's glTF; true once it has loaded (or failed: then the fallback is built). */
export function policeModelReady() {
  if (!gltfP) gltfP = loadGLB(MODEL).then((g) => { GL = g; settled = true; }, () => { settled = true; });
  return settled;
}
// the Meshy model fitted once: nose (its -x) turned to +z, LEN m long, centred, wheels on y 0; its roof bar found by
// rays straight down along the middle (the highest stretch)
function fitted() {
  if (FIT || !GL) return FIT;
  const inner = new THREE.Group(), m = GL.scene.clone(true);
  m.rotation.y = Math.PI / 2;
  inner.add(m);
  inner.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(inner), s = LEN / Math.max(0.1, bb.max.z - bb.min.z);
  inner.scale.setScalar(s);
  inner.position.set(-((bb.min.x + bb.max.x) / 2) * s, -bb.min.y * s, -((bb.min.z + bb.max.z) / 2) * s);
  inner.updateMatrixWorld(true);
  const size = new THREE.Vector3((bb.max.x - bb.min.x) * s, (bb.max.y - bb.min.y) * s, LEN);
  const ray = new THREE.Raycaster(), down = new THREE.Vector3(0, -1, 0), o = new THREE.Vector3(), hits = [];
  for (let z = -1.8; z <= 1.2; z += 0.06) { ray.set(o.set(0, 5, z), down); const h = ray.intersectObject(inner, true)[0]; if (h) hits.push([z, h.point.y]); }
  let bar = { y: size.y - 0.08, z: -0.4, d: 0.3 };
  if (hits.length) {
    const top = Math.max(...hits.map((h) => h[1])), flat = hits.filter((h) => h[1] > top - 0.05);
    const z0 = Math.min(...flat.map((h) => h[0])), z1 = Math.max(...flat.map((h) => h[0]));
    bar = { y: top, z: (z0 + z1) / 2, d: clamp(z1 - z0 + 0.06, 0.2, 0.5) };
  }
  inner.traverse((x) => { if (x.isMesh) { x.castShadow = true; x.receiveShadow = true; } });
  FIT = { inner, size, bar };
  return FIT;
}
let glowTex = null;
function glow() {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'), r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.25, 'rgba(120,160,255,0.8)'); r.addColorStop(1, 'rgba(40,80,255,0)');
  g.fillStyle = r; g.fillRect(0, 0, 64, 64);
  glowTex = new THREE.CanvasTexture(c);
  return glowTex;
}
// the fallback's POLIZEI band (a BMW X3 from the fleet, painted white)
function bandTexture() {
  const c = document.createElement('canvas'); c.width = 1024; c.height = 160;
  const g = c.getContext('2d');
  for (let i = 0; i < 16; i++) { g.fillStyle = i % 2 ? '#1a4fd8' : '#e4ff1a'; g.fillRect(i * 64, 0, 64, 40); g.fillStyle = i % 2 ? '#e4ff1a' : '#1a4fd8'; g.fillRect(i * 64, 120, 64, 40); }
  g.fillStyle = '#ffffff'; g.fillRect(0, 40, 1024, 80);
  g.fillStyle = '#1a4fd8'; g.font = 'bold 74px Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('POLIZEI', 512, 82);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A patrol car: { g (nose +z, origin on the road under its middle), lens: [L, R] materials, glows: [sprites],
 *  size (Vector3: width, height, length), eye (the driver's eye, car frame) }. */
export function buildPoliceCar(models) {
  const g = new THREE.Group();
  g.name = 'police-car';
  const F = fitted();
  let size, bar, eye;
  if (F) {
    g.add(F.inner.clone(true));
    size = F.size; bar = F.bar;
    eye = new THREE.Vector3(0.38, Math.min(1.2, size.y - 0.4), 0.05);
  } else {
    const gl = models?.car_bmw_x3;
    if (gl) {
      const t = carTemplate(gl, 4.7, 'car_bmw_x3'), inst = carInstance(t, { paint: 0xf3f5f7 });
      g.add(inst.group);
      size = new THREE.Vector3(t.size?.x || 1.9, t.size?.y || 1.66, t.size?.z || 4.7);
      eye = driverEye(t);
      const mat = new THREE.MeshStandardMaterial({ map: bandTexture(), roughness: 0.4, polygonOffset: true, polygonOffsetFactor: -2 });
      for (const sd of [1, -1]) {
        const p = new THREE.Mesh(new THREE.PlaneGeometry(size.z * 0.72, size.z * 0.72 * (160 / 1024)), mat);
        p.position.set(sd * (size.x / 2 + 0.015), 0.78, -0.1); p.rotation.y = sd * Math.PI / 2;
        g.add(p);
      }
    } else { // (no car models at all: a white box)
      size = new THREE.Vector3(1.9, 1.55, LEN);
      const b = new THREE.Mesh(new THREE.BoxGeometry(1.9, 1.2, LEN), new THREE.MeshStandardMaterial({ color: 0xf3f5f7, roughness: 0.4 }));
      b.position.y = 0.75; g.add(b);
      eye = new THREE.Vector3(0.38, 1.15, 0.05);
    }
    bar = { y: size.y, z: -0.3, d: 0.28 };
  }
  // the light bar: a dark base and two blue lenses (over the model's own bar), a glow over each
  const base = new THREE.Mesh(new THREE.BoxGeometry(1.16, 0.05, bar.d + 0.06), new THREE.MeshStandardMaterial({ color: 0x15171c, roughness: 0.5 }));
  base.position.set(0, bar.y - 0.07, bar.z);
  g.add(base);
  const lens = [], glows = [];
  for (const sx of [1, -1]) {
    const mat = new THREE.MeshStandardMaterial({ color: 0x0c2a9c, emissive: 0x2f62ff, emissiveIntensity: 0.25, roughness: 0.15, transparent: true, opacity: 0.92 });
    const l = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.1, bar.d), mat);
    l.position.set(sx * 0.29, bar.y - 0.02, bar.z);
    g.add(l);
    lens.push(mat);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow(), color: 0x6f8fff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
    sp.position.set(sx * 0.32, bar.y + 0.06, bar.z);
    sp.scale.setScalar(2.4);
    g.add(sp);
    glows.push(sp);
  }
  return { g, lens, glows, size, eye };
}
/** The blue lights: a double flash, left then right (t: a running time in s). */
export function policeLights(m, on, t) {
  const ph = (t % 0.6) / 0.6;
  const a = on && ((ph < 0.09) || (ph > 0.15 && ph < 0.24)), b = on && ((ph > 0.5 && ph < 0.59) || (ph > 0.65 && ph < 0.74));
  m.lens[0].emissiveIntensity = a ? 7 : 0.25; m.lens[1].emissiveIntensity = b ? 7 : 0.25;
  m.glows[0].material.opacity = a ? 0.95 : 0; m.glows[1].material.opacity = b ? 0.95 : 0;
}
/** The car's group on the ground at (x, z) facing yaw: its height, pitch and roll from the ground under its wheels. */
export function policeGround(g, x, z, yaw, yHint = Infinity) {
  const s = Math.sin(yaw), c = Math.cos(yaw), H = (lx, lz) => world.groundHeight(x + s * lz + c * lx, z + c * lz - s * lx, yHint);
  const f = H(0, 1.45), b = H(0, -1.45), l = H(0.8, 0), r = H(-0.8, 0);
  const y = (f + b) / 2;
  _e.set(-Math.atan2(f - b, 2.9), yaw, Math.atan2(l - r, 1.6) * 0.6);
  g.position.set(x, y + 0.02, z);
  g.quaternion.setFromEuler(_e);
  g.updateMatrixWorld(true);
  return y;
}

// two boxes (x, z, yaw, hw, hd): { nx, nz (from B to A), depth } or null (separating axes)
function contact(A, B) {
  const axes = [[Math.sin(A.yaw), Math.cos(A.yaw)], [Math.cos(A.yaw), -Math.sin(A.yaw)], [Math.sin(B.yaw), Math.cos(B.yaw)], [Math.cos(B.yaw), -Math.sin(B.yaw)]];
  const dx = A.x - B.x, dz = A.z - B.z;
  const rad = (o, ax, az) => o.hd * Math.abs(Math.sin(o.yaw) * ax + Math.cos(o.yaw) * az) + o.hw * Math.abs(Math.cos(o.yaw) * ax - Math.sin(o.yaw) * az);
  let best = Infinity, nx = 0, nz = 0;
  for (const [ax, az] of axes) {
    const dist = dx * ax + dz * az, ov = rad(A, ax, az) + rad(B, ax, az) - Math.abs(dist);
    if (ov <= 0) return null;
    if (ov < best) { best = ov; const sg = dist >= 0 ? 1 : -1; nx = ax * sg; nz = az * sg; }
  }
  return { nx, nz, depth: best };
}
// ---- the patrol cars' driving (Oct 29, the user: "the police ai is very bad"): A* along the road graph to the road
// point nearest where you will be (re-planned about once a second), straight only for the last stretch; pure pursuit
// (a look-ahead growing with the speed), the speed held to what the bends ahead and the steering can take (braking for
// them in time), obstacles probed out to braking distance (colliders, trees, steep ground, the traffic, the bus, the
// other patrol car); no progress: back up and turn out (both ways in turn), as a last resort (out of sight, far) put
// back on a road. Fleeing: a PIT (alongside your rear quarter, then a nudge into it) by the first car, the second cuts
// you off (routes to where you will be in a few seconds, blocks ahead / PITs from the other side).
const A_LAT = 8.5, A_BRAKE = 11, R_MIN = WB / Math.tan(0.7);
const FR = [0.15, 0.3, 0.45, 0.6, 0.8, 1]; // (the probe reaches 70 m at 250 km/h: no pole slips between the samples)
const ANG_L = [0.3, -0.3, 0.6, -0.6, 0.95, -0.95, 1.4, -1.4], ANG_R = ANG_L.map((a) => -a);
// A* over the road graph (towtruck.js roadGraph) from node a to b: the node ids into out (Int32Array), their count
// (0: no way); its buffers kept between calls (a stamp instead of clearing them)
let RT = null;
function routeIds(a, b, out) {
  const G = roadGraph(), X = G.X, Z = G.Z, adj = G.adj;
  if (!RT || RT.G !== G) {
    let E = 1;
    for (const l of adj) E += l.length;
    RT = { G, g: new Float64Array(G.N), prev: new Int32Array(G.N), mark: new Uint32Array(G.N), shut: new Uint32Array(G.N), stamp: 0, hf: new Float64Array(E + 8), hn: new Int32Array(E + 8) };
  }
  const R = RT, g = R.g, prev = R.prev, mark = R.mark, shut = R.shut, hf = R.hf, hn = R.hn, cap = hf.length;
  const st = ++R.stamp, bx = X[b], bz = Z[b];
  if (st >= 0xfffffff0) { R.stamp = 0; mark.fill(0); shut.fill(0); return 0; }
  g[a] = 0; prev[a] = -1; mark[a] = st;
  let hl = 1, found = false;
  hf[0] = Math.hypot(X[a] - bx, Z[a] - bz); hn[0] = a;
  while (hl > 0) {
    const n = hn[0];
    // pop (a binary heap in two typed arrays)
    hl--;
    if (hl > 0) {
      const lf = hf[hl], ln = hn[hl];
      let i = 0;
      for (;;) { const l = 2 * i + 1, r = l + 1; let m = i, mf = lf; if (l < hl && hf[l] < mf) { m = l; mf = hf[l]; } if (r < hl && hf[r] < mf) m = r; if (m === i) break; hf[i] = hf[m]; hn[i] = hn[m]; i = m; }
      hf[i] = lf; hn[i] = ln;
    }
    if (shut[n] === st) continue;
    shut[n] = st;
    if (n === b) { found = true; break; }
    const L = adj[n];
    for (let q = 0; q < L.length; q++) {
      const v = L[q];
      if (shut[v] === st) continue;
      const nd = g[n] + Math.hypot(X[v] - X[n], Z[v] - Z[n]);
      if (mark[v] === st && nd >= g[v]) continue;
      mark[v] = st; g[v] = nd; prev[v] = n;
      if (hl >= cap) continue;
      const f = nd + Math.hypot(X[v] - bx, Z[v] - bz);
      let i = hl++;
      while (i > 0) { const p = (i - 1) >> 1; if (hf[p] <= f) break; hf[i] = hf[p]; hn[i] = hn[p]; i = p; }
      hf[i] = f; hn[i] = v;
    }
  }
  if (!found) return 0;
  let k = 0;
  for (let n = b; n >= 0 && k < out.length; n = prev[n]) { out[k++] = n; if (n === a) break; }
  for (let i = 0, j = k - 1; i < j; i++, j--) { const t = out[i]; out[i] = out[j]; out[j] = t; }
  return k;
}
// from road node i, m metres on along the roads the way (dx, dz) points (at a fork: the branch most that way): where
// you will be on the roads (never a point extrapolated off a bend, nearest some other road)
function roadAhead(i, dx, dz, m) {
  const G = roadGraph(), X = G.X, Z = G.Z;
  let prev = -1, acc = 0;
  for (let guard = 0; guard < 300 && acc < m; guard++) {
    const L = G.adj[i];
    let best = -1, bd = 0.2, bl = 1;
    for (let q = 0; q < L.length; q++) {
      const v = L[q];
      if (v === prev) continue;
      const ex = X[v] - X[i], ez = Z[v] - Z[i], el = Math.hypot(ex, ez) || 1, dd = (ex * dx + ez * dz) / el;
      if (dd > bd) { bd = dd; best = v; bl = el; }
    }
    if (best < 0) break;
    acc += bl; dx = (X[best] - X[i]) / bl; dz = (Z[best] - Z[i]) / bl;
    prev = i; i = best;
  }
  return i;
}
// from road node i the way (dx, dz) points: the first junction (3+ ways) between m0 and m1 metres on along the roads
// (as roadAhead: at a fork, the branch most that way) -> JN { i: the node or -1, m: how far on, ex, ez: the way you
// come into it }; where the second patrol car cuts you off
const JN = { i: -1, m: 0, ex: 0, ez: 0 };
function nextJunction(i, dx, dz, m0, m1) {
  const G = roadGraph(), X = G.X, Z = G.Z;
  let prev = -1, acc = 0;
  JN.i = -1;
  for (let guard = 0; guard < 400 && acc < m1; guard++) {
    const L = G.adj[i];
    if (acc >= m0 && L.length >= 3) { JN.i = i; JN.m = acc; JN.ex = dx; JN.ez = dz; return JN; }
    let best = -1, bd = 0.2, bl = 1;
    for (let q = 0; q < L.length; q++) {
      const v = L[q];
      if (v === prev) continue;
      const ex = X[v] - X[i], ez = Z[v] - Z[i], el = Math.hypot(ex, ez) || 1, dd = (ex * dx + ez * dz) / el;
      if (dd > bd) { bd = dd; best = v; bl = el; }
    }
    if (best < 0) break;
    acc += bl; dx = (X[best] - X[i]) / bl; dz = (Z[best] - Z[i]) / bl;
    prev = i; i = best;
  }
  return JN;
}
// (x, z) inside the box (cx, cz, yaw: its +z, hw, hd) grown by r?
function inBox(x, z, r, cx, cz, yaw, hw, hd) {
  const s = Math.sin(yaw), c = Math.cos(yaw), dx = x - cx, dz = z - cz;
  return Math.abs(dx * c - dz * s) < hw + r && Math.abs(dx * s + dz * c) < hd + r;
}

// a patrol car seen from the side (the WANTED box: one per car after you)
const POLICE_CAR_ICON = '<svg viewBox="0 0 26 13"><path d="M2 9.5V7.2c0-.8.5-1.4 1.3-1.6L7 4.8l3-3.1c.4-.4.9-.6 1.5-.6h5.2c.6 0 1.1.3 1.5.7l2.6 3.1 2.4.5c.9.2 1.5.9 1.5 1.8v2.3c0 .5-.4.9-.9.9h-1.1a2.6 2.6 0 0 0-5.2 0H9.6a2.6 2.6 0 0 0-5.2 0H2.9c-.5 0-.9-.4-.9-.9zM11.8 2.4 9.6 4.9h4.6V2.4zm3.8 0v2.5h4.2l-2.1-2.5z"/><circle cx="7" cy="10.4" r="1.8"/><circle cx="19.2" cy="10.4" r="1.8"/><rect x="12.2" y="0" width="3" height="1.2" rx=".4" fill="#ff4d3d"/></svg>';

const STAR = '<svg viewBox="0 0 24 24"><path d="M12 1.8l3.1 6.6 7.1.9-5.2 4.9 1.4 7.1L12 17.8l-6.4 3.5L7 14.2 1.8 9.3l7.1-.9z"/></svg>';
const CSS = `
#police-hud { position: absolute; left: 22px; bottom: 92px; box-sizing: border-box; width: max(300px, calc(var(--u) * 390)); padding: calc(var(--u) * 14) calc(var(--u) * 34) calc(var(--u) * 20) calc(var(--u) * 28);
  color: var(--blue, #1546c8); pointer-events: none; isolation: isolate; filter: drop-shadow(0 calc(var(--u) * 6) calc(var(--u) * 14) rgba(0, 20, 60, 0.3));
  animation: pl-in 0.45s cubic-bezier(.2,.9,.2,1) backwards; }
#police-hud[hidden] { display: none; }
/* (white paper with a gently ragged edge in u, as the controls card: the % brush is too torn at this size) */
#police-hud::before { content: ''; position: absolute; inset: 0; z-index: -1; background: #fff;
  clip-path: polygon(0 calc(var(--u) * 4), 16% 0, 38% calc(var(--u) * 5), 62% calc(var(--u) * 1), 85% calc(var(--u) * 5), 100% 0, calc(100% - var(--u) * 4) 32%, 100% 66%,
    calc(100% - var(--u) * 2) 100%, 75% calc(100% - var(--u) * 5), 50% 100%, 25% calc(100% - var(--u) * 4), 0 100%, calc(var(--u) * 4) 62%, 0 28%); }
body.wanted #drive-hud .ch-card, body.wanted #controls-hint { opacity: 0; } /* (the same corner: the box takes it) */
#police-hud .pl-lights { display: flex; gap: calc(var(--u) * 6); height: calc(var(--u) * 8); margin: 0 calc(var(--u) * -8) calc(var(--u) * 10); }
#police-hud .pl-lights i { flex: 1; background: #1546c8; clip-path: var(--brush-b); animation: pl-blink 0.5s steps(1) infinite; }
#police-hud .pl-lights i:nth-child(even) { background: #ff4d3d; animation-delay: 0.25s; }
#police-hud .pl-head { display: flex; align-items: flex-end; justify-content: space-between; gap: calc(var(--u) * 12); }
#police-hud .pl-stars { display: flex; gap: calc(var(--u) * 3); margin-bottom: calc(var(--u) * 2); }
#police-hud .pl-stars svg { width: calc(var(--u) * 24); height: calc(var(--u) * 24); min-width: 17px; min-height: 17px; fill: rgba(21, 70, 200, 0.15); transition: fill 0.3s ease; }
#police-hud .pl-stars svg.on { fill: var(--blue, #1546c8); animation: pl-star 0.6s cubic-bezier(.2,1.4,.4,1) backwards; }
#police-hud .pl-title b { display: block; font: italic 700 calc(var(--u) * 56)/0.88 var(--num); letter-spacing: 0.04em; color: #ff4d3d; }
#police-hud .pl-clock { text-align: right; }
#police-hud small { display: block; font: 800 var(--t-xs)/1 var(--ui); letter-spacing: 0.16em; color: var(--blue-dim, #4f72d4); white-space: nowrap; }
#police-hud .pl-t { display: block; margin-top: calc(var(--u) * 3); font: italic 700 calc(var(--u) * 46)/0.9 var(--num); font-variant-numeric: tabular-nums; }
#police-hud .pl-msg { margin: calc(var(--u) * 12) calc(var(--u) * -10) 0 calc(var(--u) * -8); padding: calc(var(--u) * 8) calc(var(--u) * 20) calc(var(--u) * 9) calc(var(--u) * 16);
  background: var(--blue, #1546c8); color: #fff; clip-path: var(--brush-b); font: italic 700 max(15px, calc(var(--u) * 20))/1.12 var(--num); letter-spacing: 0.03em;
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
#police-hud .pl-msg.hot { background: #d0342c; }
#police-hud .pl-esc { margin-top: calc(var(--u) * 14); }
#police-hud .pl-esc[hidden] { display: none; }
#police-hud .pl-row { display: flex; align-items: baseline; justify-content: space-between; gap: calc(var(--u) * 10); }
#police-hud .pl-esc-t { font: italic 700 calc(var(--u) * 28)/1 var(--num); font-variant-numeric: tabular-nums; }
#police-hud .pl-esc-t em { font-style: normal; font-size: 0.7em; color: var(--blue-dim, #4f72d4); }
#police-hud .pl-bar { height: calc(var(--u) * 16); min-height: 10px; margin-top: calc(var(--u) * 6); background: rgba(21, 70, 200, 0.13); clip-path: var(--brush-b); }
#police-hud .pl-bar i { display: block; height: 100%; width: 0; background: linear-gradient(90deg, #1546c8, #3d7bff); transition: width 0.25s linear; }
#police-hud.gain .pl-bar i { animation: pl-pulse 0.9s ease-in-out infinite; }
#police-hud .pl-sub { margin-top: calc(var(--u) * 9); align-items: center; }
#police-hud .pl-cars { display: flex; gap: calc(var(--u) * 6); }
#police-hud .pl-cars svg { width: calc(var(--u) * 36); height: calc(var(--u) * 18); min-width: 26px; min-height: 13px; fill: var(--blue, #1546c8); }
#police-hud .pl-near { font: 800 var(--t-sm)/1 var(--ui); letter-spacing: 0.08em; white-space: nowrap; color: #d0342c; }
#police-hud.gain .pl-near { color: #129a46; }
@keyframes pl-blink { 0% { opacity: 1; } 50% { opacity: 0.15; } }
@keyframes pl-in { from { opacity: 0; translate: calc(var(--u) * -40) 0; } }
@keyframes pl-star { from { scale: 1.8; opacity: 0; } }
@keyframes pl-pulse { 50% { opacity: 0.6; } }`;

// ------------------------------------------------------------------ the police
export class Police {
  /**
   * @param {object} o  scene, models, player, camera, drive, traffic, carRental, jobs, hud, audio, save, writeSave,
   *   colliders, vegetation, transition, mp: () => the multiplayer session or null,
   *   excluded: () => true in races / modes / the bus intro / before the game started (a chase there ends at once),
   *   paused: () => true while inside somewhere (the chase waits)
   */
  constructor(o) {
    Object.assign(this, o);
    this.units = [];      // the patrol cars (built once, reused): see unit()
    this.w = null;        // the chase: { t, esc, fleeing, reached, grace, stopT, scene, spawned2, why }
    this.cool = 0;
    this.time = 0;
    this.netT = 0; this.netSent = false;
    this.sirenOn = false;
    this.lightsT = 0;
    policeModelReady();
    this.officerRigs = []; // the officer's rigs not in use (his own, never the job pool's)
    this.loadOfficer();
    // the traffic brakes for the patrol cars (boxes in its way)
    this.unblock = addTrafficBlocker((out) => { for (const u of this.units) if (u.on) { u.box.x = u.x; u.box.y = u.y; u.box.z = u.z; u.box.yaw = u.yaw; out.push(u.box); } });
    // drive.js: your car hit something (chained: another listener keeps working)
    if (this.drive) { const prev = this.drive.onHit; this.drive.onHit = (kind, v, what) => { try { prev?.(kind, v, what); } finally { this.reportHit(kind, v); } }; }
    this.buildHud();
  }

  get prison() { return this.getPrison?.() || window.__game?.prison || null; }
  get active() { return !!this.w; }

  buildHud() {
    if (typeof document === 'undefined') return;
    if (!document.getElementById('police-css')) { const s = document.createElement('style'); s.id = 'police-css'; s.textContent = CSS; document.head.appendChild(s); }
    const el = document.createElement('div');
    el.id = 'police-hud'; el.hidden = true;
    el.innerHTML = '<div class="pl-lights"><i></i><i></i><i></i><i></i></div>'
      + `<div class="pl-head"><div class="pl-title"><div class="pl-stars">${STAR.repeat(5)}</div><b>WANTED</b></div><div class="pl-clock"><small>CHASE</small><span class="pl-t"></span></div></div>`
      + '<div class="pl-msg"></div>'
      + '<div class="pl-esc"><div class="pl-row"><small>ESCAPE</small><span class="pl-esc-t"></span></div><div class="pl-bar"><i></i></div><div class="pl-row pl-sub"><span class="pl-cars"></span><span class="pl-near"></span></div></div>';
    (document.getElementById('hud') || document.body).appendChild(el);
    this.el = el;
    this.$t = el.querySelector('.pl-t'); this.$cars = el.querySelector('.pl-cars'); this.$msg = el.querySelector('.pl-msg'); this.$escBox = el.querySelector('.pl-esc');
    this.$esc = el.querySelector('.pl-esc-t'); this.$bar = el.querySelector('.pl-bar i'); this.$near = el.querySelector('.pl-near'); this.$stars = [...el.querySelectorAll('.pl-stars svg')];
    this.hudCache = {};
  }
  // the WANTED box: t the chase clock, msg the one status line (hot: red, fleeing), esc the escape clock ('' hides the
  // escape part), frac its bar, cars the patrol cars after you, near the nearest one's distance, stars 1-5
  setHud(show, t = '', msg = '', esc = '', frac = 0, cars = 0, near = '', stars = 1, hot = false, gain = false) {
    if (!this.el) return;
    if (this.el.hidden === show) { this.el.hidden = !show; document.body.classList.toggle('wanted', show); }
    if (!show) return;
    const C = this.hudCache;
    if (C.t !== t) this.$t.textContent = C.t = t;
    if (C.msg !== msg) this.$msg.textContent = C.msg = msg;
    if (C.hot !== hot) this.$msg.classList.toggle('hot', C.hot = hot);
    if (C.gain !== gain) this.el.classList.toggle('gain', C.gain = gain);
    if (C.cars !== cars) { C.cars = cars; this.$cars.innerHTML = POLICE_CAR_ICON.repeat(cars); } // (a little patrol car per car after you)
    if (C.stars !== stars) { C.stars = stars; for (let i = 0; i < 5; i++) this.$stars[i].classList.toggle('on', i < stars); }
    if (C.esc !== esc) { C.esc = esc; this.$esc.innerHTML = esc; this.$escBox.hidden = !esc; }
    if (C.near !== near) this.$near.textContent = C.near = near;
    const w = `${Math.round(frac * 100)}%`;
    if (C.w !== w) this.$bar.style.width = C.w = w;
  }

  // ---------------------------------------------------------------- the trigger
  /** drive.js onHit: your car hit `kind` ('traffic' | 'parked' | 'person' | 'player-car' | 'player') at v m/s closing. */
  reportHit(kind, v) {
    if (this.w || this.cool > 0 || !(v * 3.6 >= TUNING.triggerKmh)) return;
    if (!this.drive?.active || this.excluded?.() || this.paused?.() || this.prison?.active) return;
    this.start(kind);
  }
  start(why) {
    this.w = { t: 0, esc: 0, fleeing: false, reached: false, grace: 0, stopT: 0, footT: 0, scene: null, why, spawned2: false };
    if (!this.spawn(0)) { this.w = null; return; }
    this.note(`Police! Stop to pay a ${usd(this.fineNow())} fine, or get away`);
    this.audio?.play?.('error');
  }

  // ---------------------------------------------------------------- the patrol cars
  unit(k) {
    if (this.units[k]) return this.units[k];
    const m = buildPoliceCar(this.models);
    m.g.visible = false;
    this.scene.add(m.g);
    const hw = m.size.x / 2 - 0.05, hd = m.size.z / 2;
    const col = { x: 1e9, z: 1e9, hw, hd, rot: 0, h: 1.7, police: 'local' };
    this.colliders?.push(col);
    const u = { k, m, g: m.g, col, hw, hd, box: { hw, hd: hd + 0.3, police: true }, on: false, x: 0, y: 0, z: 0, yaw: 0, v: 0, steer: 0, path: null, pi: 0, repath: 0,
      probeT: 0, avoid: { turn: 0, vmax: 99 }, stuck: 0, rev: 0, revSteer: 0, mode: 'chase', officer: null, driver: null, gone: 0, leaveTo: null,
      // (the driving: the road way (ids, its points in the lane PX / PZ, pn of them, pi the nearest), the goal it was
      // planned to (gx, gz); progress (stX / stZ every stT s, stuckN failures in a row); the PIT (pitSide, pitT);
      // on foot: fg, the nearest reachable point to you (fgT: re-found); boost: the catch-up)
      ids: null, PX: null, PZ: null, pn: 0, gx: 1e9, gz: 1e9, stX: 0, stZ: 0, stT: 0, stuckN: 0, uturn: 0,
      pitSide: 0, pitT: 0, ramCool: 0, ram: false, fg: { x: 0, z: 0, ok: false, park: false }, fgT: 0, boost: 1, parked: false,
      dmg: 0, wrecked: false, wreckT: 0, smoke: null }; // (you can wreck it: hits(), wreck())
    this.units[k] = u;
    return u;
  }
  // the police officer model, loaded after the start; once in, every officer on foot is one and the patrol cars'
  // driver is him baked seated (carpeople.js)
  loadOfficer() {
    const m = this.models;
    if (!m || this.officerLoading) return;
    this.officerLoading = Promise.all([loadGLB(`${OFFICER}_rigged`), loadGLB(`${OFFICER}_anims`)]).then(async ([rig, anims]) => {
      if (!rig || this.disposed) return false;
      m[`${OFFICER}_rigged`] = rig;
      if (anims) m[`${OFFICER}_anims`] = anims;
      this.hasOfficer = true;
      try { await this.bakeOfficerDriver(); } catch (e) { console.warn('police officer driver', e); }
      return true;
    }).catch((e) => { console.warn('police officer', e); return false; });
  }
  newOfficerRig() {
    try {
      const rig = this.jobs?.makeRig?.(OFFICER, 'rental');
      if (rig?.root && typeof rig.update === 'function') return { own: true, char: OFFICER, rig };
    } catch (e) { console.warn('police officer rig', e); }
    this.hasOfficer = false; // (never retried: the skiers stand in)
    return null;
  }
  // the officer baked seated as the patrol cars' driver; drivers already at the wheel swap to him
  async bakeOfficerDriver() {
    const people = this.traffic?.people;
    if (!people?.bakeDriver) return;
    await people.ready;
    const rig = this.jobs?.makeRig?.(OFFICER, 'rental');
    const fig = rig ? await people.bakeDriver(rig) : null;
    if (!fig || this.disposed) return;
    this.officerFig = fig;
    for (const u of this.units) {
      if (!u.driver) continue;
      const vis = u.driver.visible;
      u.driver.removeFromParent(); u.driver = null;
      this.seatDriver(u);
      if (u.driver) u.driver.visible = vis;
    }
  }
  // a driver at the wheel: the officer (above), else traffic.js's baked seated figures (carpeople.js)
  seatDriver(u) {
    if (u.driver) return;
    const figs = this.traffic?.people?.figs?.driver;
    const fig = this.officerFig || (figs?.length ? figs[u.k % figs.length] : null);
    if (!fig) return;
    const E = u.m.eye, o = new THREE.Group();
    o.position.set(E.x - fig.eye.x, E.y - fig.eye.y, E.z - fig.eye.z);
    for (const p of fig.parts) { const mesh = new THREE.Mesh(p.geo, p.mat); mesh.castShadow = false; o.add(mesh); }
    u.g.add(o);
    u.driver = o;
  }
  // out of sight 300-500 m from you on the roads, facing the way to you (no roads: off-road behind the camera);
  // strict (a stuck car put back on a road): only out of sight within lo-hi, else nothing happens (false)
  spawn(k, lo0 = TUNING.spawnMin, hi0 = TUNING.spawnMax, strict = false) {
    if (this.units[k]?.wrecked) k = this.freeUnit(); // (a wreck still stands there: another car)
    if (k < 0) return false;
    const u = this.unit(k), p = this.target();
    if (!p) return false;
    let best = null;
    try {
      const G = busRoads.roads.length ? roadGraph() : null;
      if (G?.N) {
        this.camera?.updateMatrixWorld?.();
        _fr.setFromProjectionMatrix(_m.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse));
        const other = this.units.find((x) => x.on && x !== u), cand = [];
        for (let pass = 0; pass < (strict ? 1 : 3) && !cand.length; pass++) {
          const lo = pass === 2 ? 120 : lo0, hi = pass === 0 ? hi0 : pass === 1 ? Math.max(800, hi0) : 1500;
          for (let i = 0; i < G.N; i += 1) {
            const d = hyp(G.X[i], G.Z[i], p.x, p.z);
            if (d < lo || d > hi) continue;
            if (other && hyp(G.X[i], G.Z[i], other.x, other.z) < (strict ? 80 : 40)) continue;
            if (strict && p.sp > 3 && (G.X[i] - p.x) * p.vx + (G.Z[i] - p.z) * p.vz > 0) continue; // (put back: behind you)
            const seen = pass === 0 && _fr.containsPoint(_v.set(G.X[i], world.height(G.X[i], G.Z[i]) + 1, G.Z[i]));
            if (!seen) cand.push(i);
          }
        }
        if (cand.length) {
          const i = cand[Math.floor(Math.random() * cand.length)], b = roadNearest(p.x, p.z);
          const ids = (this._sid ||= { a: new Int32Array(0) });
          if (ids.a.length !== G.N) ids.a = new Int32Array(G.N);
          const cnt = b.i >= 0 ? routeIds(i, b.i, ids.a) : 0;
          const n = cnt > 1 ? ids.a[Math.min(2, cnt - 1)] : -1;
          const yaw = n >= 0 ? Math.atan2(G.X[n] - G.X[i], G.Z[n] - G.Z[i]) : Math.atan2(p.x - G.X[i], p.z - G.Z[i]);
          best = { x: G.X[i] - Math.cos(yaw) * LANE, z: G.Z[i] + Math.sin(yaw) * LANE, yaw };
        }
      }
    } catch (e) { console.warn('police spawn', e); }
    if (!best && strict) return false;
    if (!best) {
      const cy = this.camera ? Math.atan2(-this.camera.matrixWorld.elements[8], -this.camera.matrixWorld.elements[10]) : 0;
      const a = cy + Math.PI + (Math.random() - 0.5);
      const x = p.x + Math.sin(a) * TUNING.spawnMin, z = p.z + Math.cos(a) * TUNING.spawnMin;
      best = { x, z, yaw: Math.atan2(p.x - x, p.z - z) };
    }
    u.on = true; u.x = best.x; u.z = best.z; u.yaw = best.yaw; u.v = 8; u.steer = 0; u.path = null; u.repath = 0; u.mode = 'chase';
    u.stuck = 0; u.rev = 0; u.gone = 0; u.leaveTo = null;
    u.pn = 0; u.gx = 1e9; u.stX = u.x; u.stZ = u.z; u.stT = 0; u.stuckN = 0; u.uturn = 0; u.pitT = 0; u.pitSide = 0; u.ramCool = 0; u.ram = false;
    u.fgT = 0; u.fg.ok = false; u.boost = 1; u.parked = false; u.avoid.turn = 0; u.avoid.vmax = 99; u.dmg = 0;
    u.y = world.groundHeight(u.x, u.z);
    u.g.visible = true;
    this.seatDriver(u);
    if (u.driver) u.driver.visible = true;
    this.place(u);
    return true;
  }
  // a patrol car index free to (re)use: not out, not a wreck still standing; -1: all four taken
  freeUnit() {
    for (let k = 0; k < 4; k++) { const u = this.units[k]; if (!u || (!u.on && !u.wrecked)) return k; }
    return -1;
  }
  // (the user: "make it so you can hit the police cars too") wrecked: it stops where it is, lights out, smoking,
  // still solid; out of the chase (no ram, not counted for your escape); another comes after backupS
  wreck(u) {
    if (u.wrecked) return;
    this.dropOfficer(u);
    u.on = false; u.wrecked = true; u.wreckT = TUNING.wreckStayS; u.v = 0; u.ram = false; u.path = null;
    u.col.police = 'wreck'; // (a plain solid box now: your car hits it as any obstacle, drive.js; the other patrol cars steer round it)
    policeLights(u.m, false, 0);
    u.smoke ||= new Smoke(this.scene);
    if (this.w) { this.w.backupT = TUNING.backupS; this.w.wrecks = (this.w.wrecks || 0) + 1; this.note('Police car wrecked! · more are on the way'); }
    try { this.audio?.impact ? this.audio.impact('car', 1) : this.audio?.play?.('land', 1); } catch { /* (silent) */ }
  }
  // the wrecks: smoking; gone once their time is up and you can't see them (or are far away)
  wrecks(dt) {
    for (const u of this.units) {
      if (!u.wrecked) continue;
      u.wreckT -= dt;
      if (u.smoke) { const b = (this._wb ||= new THREE.Vector3()).set(0, u.m.size.y * 0.78, u.m.size.z / 2 - 0.8); u.g.localToWorld(b); u.smoke.rate = u.wreckT > TUNING.wreckStayS - 20 ? 5 : 1.5; u.smoke.update(dt, b, this.camera, 0, (this._wf ||= new THREE.Vector3()).set(Math.sin(u.yaw), 0, Math.cos(u.yaw)), 0); }
      const T = this.target(), far = !T || hyp(u.x, u.z, T.x, T.z) > 150;
      if (u.wreckT <= 0 && (far || !this.inView(u))) { u.wrecked = false; u.smoke?.clear(); u.g.visible = false; u.col.x = 1e9; u.col.z = 1e9; u.col.police = 'local'; if (u.driver) u.driver.visible = true; }
    }
  }
  despawn(u) {
    this.dropOfficer(u);
    u.on = false; u.g.visible = false; u.v = 0; u.path = null; u.pn = 0;
    u.col.x = 1e9; u.col.z = 1e9;
  }
  place(u) {
    u.y = policeGround(u.g, u.x, u.z, u.yaw, u.y + 2);
    u.col.x = u.x; u.col.z = u.z; u.col.rot = -u.yaw;
  }

  // ---------------------------------------------------------------- you
  // where you are: { x, z, yaw, vx, vz, sp, car (drive.d or null), foot (on foot / skis), y }
  target() {
    const d = this.drive?.d, p = this.player;
    const t = (this._tg ||= {});
    if (d) { t.x = d.x; t.z = d.z; t.y = d.y; t.yaw = d.yaw; t.vx = d.vx; t.vz = d.vz; t.car = d; t.foot = false; }
    else if (p?.pos) {
      t.x = p.pos.x; t.z = p.pos.z; t.y = p.pos.y; t.vx = p.vel?.x || 0; t.vz = p.vel?.z || 0; t.yaw = Math.atan2(t.vx, t.vz); t.car = null;
      t.foot = (p.mode === 'walk' || p.mode === 'ski' || p.mode === 'fall') && !p.seat;
    } else return null;
    t.sp = Math.hypot(t.vx, t.vz);
    return t;
  }
  // a point in your car's frame (lx: + the driver's side, lz: + ahead) in the world
  carPoint(d, lx, lz, out = { x: 0, z: 0 }) {
    const s = Math.sin(d.yaw), c = Math.cos(d.yaw);
    out.x = d.x + c * lx + s * lz; out.z = d.z - s * lx + c * lz;
    return out;
  }

  // ---------------------------------------------------------------- per frame
  update(dt) {
    if (!(dt > 0)) { if (this.sirenOn) { this.sirenOn = false; this.audio?.setSiren?.({ on: false }); } return; } // (paused: silent)
    this.time += dt;
    this.cool = Math.max(0, this.cool - dt);
    if (this.jailing) { // (arrested: everything goes once you are in the cell)
      this.jailing -= dt;
      for (const u of this.units) if (u.on && u.officer) this.poseOfficer(u.officer, dt);
      if (this.jailing <= 0 || this.prison?.inside) { this.jailing = 0; this.clear(true); }
      this.siren(true); this.hudFrame(true);
      return;
    }
    const W = this.w;
    if (W && (this.excluded?.() || this.prison?.active)) { this.clear(); return; }
    // hiding in a chalet (Oct 30, the user): the police are still looking but can't find you: the WANTED box says so,
    // the escape time runs on while you stay inside (they lose you once it is up); out again, the chase goes on for
    // the time that is left (not while being fined / arrested)
    const hiding = !!(W && !W.scene && globalThis.window?.__game?.chalets?.inside);
    if (hiding) {
      W.t += dt; W.esc += dt; W.near = Infinity;
      if (W.esc >= TUNING.escapeS) { this.escaped('They never found you · you escaped'); return; }
    }
    const paused = !!this.paused?.();
    try {
      if (W && !paused) this.chase(dt, W);
      // being arrested in your car: it is held (drive.js: no throttle, no steering, brakes on, no getting out)
      if (this.drive) this.drive.held = !!((W?.scene?.kind === 'arrest' && !W.scene.abort) || this.jailing) && !!this.drive.active;
      for (const u of this.units) if (u.on) { if (!W) this.leave(u, dt); if (u.on) policeLights(u.m, true, this.time + u.k * 0.21); }
      this.hits(dt);
      this.wrecks(dt);
    } catch (e) { if (!this.err) { this.err = true; console.warn('police', e); } }
    this.siren(paused);
    this.hudFrame(paused && !hiding, hiding);
    try { this.netFrame(dt); } catch (e) { console.warn('police mp', e); }
  }

  chase(dt, W) {
    W.t += dt;
    const T = this.target();
    if (!T) return;
    const live = this.units.filter((u) => u.on);
    // reinforcements after a wreck (meanwhile the escape keeps counting: nobody is after you)
    if (W.backupT > 0) { W.backupT -= dt; if (W.backupT <= 0 && live.length < 2) { const k = this.freeUnit(); if (k >= 0) this.spawn(k); } }
    if (!live.length) {
      if (W.backupT > 0 && !W.scene) { W.near = Infinity; W.esc += dt; if (W.esc >= TUNING.escapeS) this.escaped(); return; }
      this.clear(); return;
    }
    let near = Infinity, lead = live[0];
    for (const u of live) { const d = hyp(u.x, u.z, T.x, T.z); if (d < near) { near = d; lead = u; } }
    W.near = near;
    // (how hard you are slowing, smoothed: pulling over, no ram)
    W.dec = (W.dec || 0) * 0.9 + (((W.lastSp ?? T.sp) - T.sp) / dt) * 0.1; W.lastSp = T.sp;
    // the escape: in all, further than escapeR from every patrol car
    if (near > TUNING.escapeR && !W.scene) W.esc += dt;
    if (W.esc >= TUNING.escapeS) { this.escaped(); return; }
    // wrecked by their rams: lost, and you are caught
    const wreck = this.wreckE;
    if (wreck && !W.scene && !T.car && wreck.wrecked) { this.wreckE = null; this.begin(W, 'arrest', lead, 'wrecked'); }
    if (W.scene) { this.sceneStep(dt, W, T); return; }
    // they reached you: the grace to pull over, then fleeing
    if (!W.reached && near < TUNING.reachR) { W.reached = true; W.grace = TUNING.graceS; this.note(`Pull over now: stop to pay the ${usd(this.fineNow())} fine`); }
    if (W.reached && !W.fleeing) {
      W.grace -= dt;
      const away = (T.vx * (T.x - lead.x) + T.vz * (T.z - lead.z)) / Math.max(1, near); // (on foot: running away from them)
      const moving = T.car ? T.sp > 4 : T.foot && away > 2.2;
      if (W.grace <= 0 && moving) this.flee(W);
    }
    // boxed in: a patrol car within holdR of you for holdS in all (it ebbs away twice as fast when they're further):
    // they get out and arrest you, whatever your speed (you can't sit it out in the car, nor drive off: drive.held)
    W.holdT = near < TUNING.holdR ? (W.holdT || 0) + dt : Math.max(0, (W.holdT || 0) - dt * 2);
    if (W.holdT >= TUNING.holdS) { W.holdT = 0; this.begin(W, 'arrest', lead, 'held'); return; }
    // stopped with them close: pulled over (a fine) or caught (fleeing: arrested)
    const still = T.car ? T.sp * 3.6 < TUNING.stopKmh : T.foot && T.sp < 0.8;
    // (on foot off the roads: parked as near you as a car gets counts as close)
    const close = near < TUNING.stopR || (T.foot && lead.parked && near < 90);
    W.stopT = still && close ? W.stopT + dt : 0;
    if (W.stopT >= TUNING.stopS) { this.begin(W, W.fleeing ? 'arrest' : 'fine', lead, W.fleeing ? 'stopped' : ''); return; }
    // fleeing on foot: an officer runs after you once his car is close (or as close as it gets)
    if (W.fleeing && T.foot && (near < 16 || (lead.parked && near < 90)) && !lead.officer) { this.begin(W, 'arrest', lead, 'foot'); return; }
    if (W.fleeing && !W.spawned2 && W.t > 2) { W.spawned2 = true; const k = this.freeUnit(); if (k >= 0) this.spawn(k); }
    for (const u of live) this.drivePursuit(u, dt, T, W, u === lead);
  }

  flee(W) {
    if (W.fleeing) return;
    W.fleeing = true;
    const foot = !this.drive?.active;
    this.note(`${foot ? 'Running from the police' : 'Fleeing · they will ram you'} · stay ${TUNING.escapeR} m away for ${mmss(TUNING.escapeS)}`);
  }

  // one patrol car chasing (the driving notes: above routeIds). Not fleeing: to where you will be, then tailing 10 m
  // behind you (the other one 18 m). Fleeing: the first one PITs you (pit()), dropping back ramGapS after a hit; the
  // second cuts you off (its own way to where you will be in a few seconds), blocks the road ahead of you or PITs
  // from the other side. You slowing to a stop: no ram, they box you in. On foot: to the nearest point a car can
  // reach near you (footGoal), parked there.
  drivePursuit(u, dt, T, W, lead) {
    const d = hyp(u.x, u.z, T.x, T.z);
    u.ramCool = Math.max(0, u.ramCool - dt);
    u.ram = false;
    u.boost = 1 + TUNING.catchUp * clamp((d - TUNING.catchFrom) / 250, 0, 1);
    if (!T.car && !T.foot) { u.parked = false; this.step(u, dt, u.x + Math.sin(u.yaw) * 3, u.z + Math.cos(u.yaw) * 3, 0); return; } // (on a lift, in the helicopter...: they wait)
    // stuck again and again, far and out of sight: back on a road nearer you (the last resort)
    if (u.stuckN >= 3 && d > 150 && !this.inView(u) && this.spawn(u.k, 160, 380, true)) return;
    const vMax = Math.min(TUNING.vTop, TUNING.vRoad * u.boost);
    if (T.foot) {
      this.footGoal(u, T, dt);
      const F = u.fg, g = hyp(u.x, u.z, F.x, F.z);
      u.parked = g < 3.5 && Math.abs(u.v) < 1.5;
      this.step(u, dt, F.x, F.z, g < 0.8 ? 0 : Math.min(vMax, 1.5 + Math.sqrt(2 * 5 * g)));
      return;
    }
    u.parked = false;
    const C = T.car, s = Math.sin(C.yaw), c = Math.cos(C.yaw);
    const lxU = (u.x - C.x) * c - (u.z - C.z) * s, lzU = (u.x - C.x) * s + (u.z - C.z) * c; // (it, in your car's frame)
    const fwd = T.vx * s + T.vz * c; // (your speed along your heading)
    // where you will be: led by the time to get there (clamped); the second car (fleeing) further: cutting you off
    const ex = (T.x - u.x) / Math.max(d, 0.1), ez = (T.z - u.z) / Math.max(d, 0.1);
    const closing = Math.max(4, (Math.sin(u.yaw) * u.v - T.vx) * ex + (Math.cos(u.yaw) * u.v - T.vz) * ez);
    const tl = !lead && W.fleeing ? clamp(d / Math.max(12, Math.abs(u.v)), 2, 7) : clamp(d / closing, 0, 3.5);
    let px = T.x + T.vx * tl, pz = T.z + T.vz * tl;
    // (further off, you on a road: that far on along it, re-found 2.5 times a second; the second car, fleeing: the
    // next junction on your way it gets to before you (+1.5 s): it waits there, across your way (T-bone / road block))
    if (d > 40 && busRoads.roads.length) {
      if ((u.goT = (u.goT || 0) - dt) <= 0) {
        u.goT = 0.4; u.goOk = false; u.goJ = false;
        const n = roadNearest(T.x, T.z);
        if (n.i >= 0 && n.d < 15) {
          const G = roadGraph(), dx = T.sp > 2 ? T.vx / T.sp : s, dz = T.sp > 2 ? T.vz / T.sp : c;
          let j = T.sp > 2 ? roadAhead(n.i, dx, dz, T.sp * tl) : n.i;
          if (!lead && W.fleeing && T.sp > 6) {
            const J = nextJunction(n.i, dx, dz, 35, TUNING.junctionM);
            if (J.i >= 0 && (hyp(u.x, u.z, G.X[J.i], G.Z[J.i]) * 1.25) / (TUNING.vRoad * u.boost) < J.m / T.sp + 1.5) { j = J.i; u.goJ = true; }
          }
          u.goX = G.X[j]; u.goZ = G.Z[j]; u.goOk = true;
        }
      }
      if (u.goOk) { px = u.goX; pz = u.goZ; }
    }
    // fleeing, it crossing your way ahead of / beside you (a junction, a side road) and getting there about when you
    // do: straight into your side at full speed (a T-bone: hits() makes it a real crash)
    const sx = Math.sin(u.yaw - C.yaw) * (lxU >= 0 ? 1 : -1); // (< 0: heading across toward your line)
    if (W.fleeing && fwd > 9 && d < TUNING.tboneR && u.ramCool <= 0 && lzU > -C.half && Math.abs(lxU) > C.w * 0.5 + u.hw && sx < -0.5
      && lzU / fwd < 3.5 && Math.abs(lxU) / Math.max(6, Math.abs(u.v) * -sx) < 3.5) {
      const tt = clamp(Math.abs(lxU) / Math.max(10, Math.abs(u.v) * -sx + 4), 0, 2.5);
      const P = this.carPoint(C, 0, fwd * tt + C.half * 0.3, this._pt ||= {});
      u.ram = true; u.direct = true; u.pitT = 0; u.pitSide = 0;
      this.step(u, dt, P.x, P.z, TUNING.vTop);
      return;
    }
    // coming at you (oncoming, ahead of you, near): it brakes hard and turns round (a three-point turn on a road)
    // where it is, so it is on your tail as you pass (and in your way while it turns)
    if (fwd > 3 && lzU > -1 && lzU < 25 + Math.max(0, u.v) * 3.2 && Math.cos(u.yaw - C.yaw) < -0.3 && !(W.fleeing && !lead)) {
      u.pitT = 0; u.pitSide = 0;
      // (fleeing: braking, it swerves into your line: in your way while it turns)
      if (u.v > 6) { const P = W.fleeing ? this.carPoint(C, 0, lzU, this._pt ||= {}) : null; this.step(u, dt, P ? P.x : u.x + Math.sin(u.yaw) * 4, P ? P.z : u.z + Math.cos(u.yaw) * 4, 0); }
      else { const P = this.carPoint(C, -LANE, lzU + 15, this._pt ||= {}); this.step(u, dt, P.x, P.z, 6); }
      return;
    }
    if (!W.fleeing) {
      if (d < 60) { this.follow(u, dt, C, lead ? 0 : 1.4, -C.half - u.hd - (lead ? 10 : 18), fwd, lxU, lzU, vMax, 12); return; }
      this.step(u, dt, px, pz, Math.min(vMax, Math.max(0, fwd) + 4 + Math.sqrt(2 * A_BRAKE * Math.max(0, d - 25))));
      return;
    }
    // you slowing to a stop (or stopped): no ram; the first boxes you in from behind, the second ahead (if it is there)
    if ((T.sp < 4 || (T.sp < 10 && (W.dec || 0) > 1.5)) && d < 60) {
      u.pitT = 0; u.pitSide = 0;
      if (!lead && lzU > C.half + 2) { const P = this.carPoint(C, 0.4, C.half + 6 + u.hd, this._pt ||= {}); this.step(u, dt, P.x, P.z, clamp(hyp(u.x, u.z, P.x, P.z) * 0.8, 0, 12), wrapPi(C.yaw + Math.PI)); }
      else this.follow(u, dt, C, lead ? 0.3 : 2.4, -C.half - u.hd - (lead ? 4 : 5), fwd, lxU, lzU, vMax, 8);
      return;
    }
    if (d < 45) {
      // the second one ahead of you, facing you: a road block (it stops in your way)
      if (!lead && lzU > C.half + 8 && Math.cos(u.yaw - C.yaw) < -0.3) {
        const P = this.carPoint(C, 0, lzU, this._pt ||= {});
        this.step(u, dt, P.x, P.z, lzU < 30 ? 0 : 10);
        return;
      }
      if (u.ramCool > 0) { this.follow(u, dt, C, lxU > 0 ? 1.2 : -1.2, -C.half - u.hd - 4, fwd, lxU, lzU, vMax, 4); return; } // (just hit you: a moment back, then again)
      let other = 0;
      for (const o of this.units) if (o !== u && o.on && o.pitSide) other = o.pitSide;
      this.pit(u, dt, C, fwd, lxU, lzU, vMax, lead ? 0 : -other);
      return;
    }
    u.pitT = 0; u.pitSide = 0;
    // (waiting at the junction it cut you off at: pulls up on it)
    this.step(u, dt, px, pz, u.goJ ? Math.min(vMax, 1 + Math.sqrt(2 * A_BRAKE * hyp(u.x, u.z, px, pz))) : vMax);
  }
  // keeping station at (lx, lz) in your car's frame: straight for it while it is well ahead, else along your line there
  // (aiming ahead along it: never a U-turn back to a spot it has overshot, it lets you pass); faster the further back
  follow(u, dt, C, lx, lz, fwd, lxU, lzU, vMax, extra) {
    const gap = lz - lzU, look = 6 + Math.abs(u.v) * 0.45;
    const P = this.carPoint(C, lx, Math.max(lz + Math.max(0, fwd) * 0.3, lzU + look), this._pf ||= {});
    u.noYou = true; // (your car: kept off by the speed here, not steered round)
    const rel = gap > 0 ? Math.min(Math.sqrt(10 * gap), gap > 15 ? extra + 8 : extra + 3) : Math.max(-6, gap * 0.8); // (closing, easing in)
    this.step(u, dt, P.x, P.z, clamp(fwd + rel, 0, vMax));
  }
  // a PIT: alongside you, its nose at your rear wheels (the side it is on, or `side`), then a nudge into your rear
  // quarter (pitT; hits(): the spin); missed: it drops back a moment and lines up again. You slow (< 6 m/s): a bump
  // from behind instead
  pit(u, dt, C, fwd, lxU, lzU, vMax, side) {
    u.ram = true;
    if (!u.pitSide) u.pitSide = side || (lxU >= 0 ? 1 : -1);
    const sg = u.pitSide, lxT = sg * (C.w / 2 + u.hw + 0.45), lzT = -C.half * 0.45 - u.hd;
    if (u.pitT > 0) {
      u.pitT -= dt;
      const P = this.carPoint(C, sg * (C.w / 2 - 1.1), -C.half * 0.5 + 3 + Math.abs(u.v) * 0.25, this._pt ||= {});
      this.step(u, dt, P.x, P.z, clamp(fwd + 5, 0, vMax * 1.25));
      if (u.pitT <= 0) { u.pitSide = 0; u.ramCool = 0.4; }
      return;
    }
    if (fwd <= 6) { const P = this.carPoint(C, 0, -C.half + 1, this._pt ||= {}); this.step(u, dt, P.x, P.z, Math.max(0, fwd) + 6); return; }
    if (Math.abs(lzT - lzU) < 2.2 && Math.abs(lxT - lxU) < 1.6) u.pitT = 1.1;
    this.follow(u, dt, C, lxT, lzT, fwd, lxU, lzU, TUNING.vTop, TUNING.ramExtra);
  }
  // on foot: the nearest point a patrol car gets to near you: 9 m short of you by a road, else from the road point
  // nearest you toward you while the ground is drivable (not steep, nothing solid), up to 9 m short of you
  footGoal(u, T, dt) {
    const F = u.fg;
    if ((u.fgT -= dt) > 0 && F.ok) return;
    u.fgT = 0.8; F.ok = true;
    const n = busRoads.roads.length ? roadNearest(T.x, T.z) : null;
    if (!n || n.i < 0 || n.d <= 12) {
      const D = hyp(u.x, u.z, T.x, T.z), k = D > 9 ? (D - 9) / D : 0;
      F.x = u.x + (T.x - u.x) * k; F.z = u.z + (T.z - u.z) * k;
      return;
    }
    const G = roadGraph(), sx = G.X[n.i], sz = G.Z[n.i], dx = (T.x - sx) / n.d, dz = (T.z - sz) / n.d;
    let hp = world.height(sx, sz);
    F.x = sx; F.z = sz;
    for (let s = 4; s <= Math.min(n.d - 9, 120); s += 4) {
      const x = sx + dx * s, z = sz + dz * s, h = world.height(x, z);
      if (Math.abs(h - hp) > 4 * 0.55 || this.solidAt(x, z, u.hw + 0.4, u)) break;
      F.x = x; F.z = z; hp = h;
    }
  }
  // on screen? (the camera's frustum, once a frame)
  inView(u) {
    try {
      if (this.frT !== this.time) { this.frT = this.time; this.camera.updateMatrixWorld(); _fr.setFromProjectionMatrix(_m.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse)); }
      return _fr.containsPoint(_v.set(u.x, u.y + 1, u.z));
    } catch { return true; }
  }
  // the way to (tx, tz) along the roads (A*), its points in the right-hand lane; from the point nearest the car
  plan(u, tx, tz) {
    u.repath = 0.9 + u.k * 0.2; u.gx = tx; u.gz = tz; u.pn = 0;
    const a = roadNearest(u.x, u.z), b = roadNearest(tx, tz);
    if (a.i < 0 || b.i < 0 || a.d > 150 || b.d > 250 || a.i === b.i) return;
    const G = roadGraph(), X = G.X, Z = G.Z;
    if (!u.ids || u.ids.length !== G.N) { u.ids = new Int32Array(G.N); u.PX = new Float32Array(G.N); u.PZ = new Float32Array(G.N); }
    const ids = u.ids, n = routeIds(a.i, b.i, ids);
    if (n < 2) return;
    for (let k = 0; k < n; k++) {
      const p = ids[Math.max(0, k - 2)], q = ids[Math.min(n - 1, k + 2)], dx = X[q] - X[p], dz = Z[q] - Z[p], l = Math.hypot(dx, dz) || 1, i = ids[k];
      u.PX[k] = X[i] - (dz / l) * LANE; u.PZ[k] = Z[i] + (dx / l) * LANE;
    }
    u.pn = n;
    let best = 0, bd = Infinity;
    for (let k = 0; k < Math.min(n, 16); k++) { const dd = hyp(u.x, u.z, u.PX[k], u.PZ[k]); if (dd < bd) { bd = dd; best = k; } }
    u.pi = best;
  }

  // ---------------------------------------------------------------- driving a patrol car
  // to (tx, tz) at up to vt: along the roads (A*, plan()) unless close, then straight; pure pursuit, the speed held to
  // the bends ahead / the arc it is on; round what's in the way (probe()); no progress: backs up and turns out
  step(u, dt, tx, tz, vt, face = null) {
    const d = hyp(u.x, u.z, tx, tz);
    // the way: re-planned about once a second, or when the goal has moved 30 m; straight only for the last stretch
    u.repath -= dt;
    if (d > 25 && busRoads.roads.length && !u.direct) { if (u.repath <= 0 || hyp(tx, tz, u.gx, u.gz) > 30) this.plan(u, tx, tz); }
    else u.pn = 0;
    const sp = Math.abs(u.v), ld = clamp(5 + sp * 0.55, 6, 42);
    let ax = tx, az = tz, onRoad = false, vCurve = 99;
    if (u.pn > 1) {
      const PX = u.PX, PZ = u.PZ, last = u.pn - 1;
      // (the nearest point onward; the aim: the first point ld or more away, else (the way ends) the goal)
      for (let it = 0; it < 40 && u.pi < last && hyp(u.x, u.z, PX[u.pi + 1], PZ[u.pi + 1]) <= hyp(u.x, u.z, PX[u.pi], PZ[u.pi]) + 0.3; it++) u.pi++;
      let k = u.pi;
      while (k < last && hyp(u.x, u.z, PX[k], PZ[k]) < ld) k++;
      if (hyp(u.x, u.z, PX[k], PZ[k]) >= ld) { ax = PX[k]; az = PZ[k]; }
      onRoad = true;
      // the bends ahead: no faster than the grip takes round them (A_LAT), braking for them in time
      let s = hyp(u.x, u.z, PX[u.pi], PZ[u.pi]);
      const reach = 20 + (sp * sp) / (2 * A_BRAKE);
      for (let j = Math.max(u.pi, 2); j < last - 1 && s < reach; j++) {
        const x1 = PX[j] - PX[j - 2], z1 = PZ[j] - PZ[j - 2], x2 = PX[j + 2] - PX[j], z2 = PZ[j + 2] - PZ[j];
        const l1 = Math.hypot(x1, z1), l2 = Math.hypot(x2, z2);
        if (l1 > 0.5 && l2 > 0.5) {
          const kap = (2 * Math.abs(Math.atan2(x1 * z2 - z1 * x2, x1 * x2 + z1 * z2))) / (l1 + l2);
          if (kap > 0.002) vCurve = Math.min(vCurve, Math.sqrt(A_LAT / kap + 2 * A_BRAKE * Math.max(0, s - 3)));
        }
        s += hyp(PX[j], PZ[j], PX[j + 1], PZ[j + 1]);
      }
    }
    // pulling up facing `face`: from behind the spot (a point back along face, closing in on the spot)
    if (face !== null && d < 16 && d > 0.6) { const b = Math.min(d * 0.6, 7); ax = tx - Math.sin(face) * b; az = tz - Math.cos(face) * b; }
    let want = d < 0.6 && face !== null ? face : Math.atan2(ax - u.x, az - u.z);
    const la = Math.max(0.1, hyp(u.x, u.z, ax, az));
    // round what's in the way (probed ~7 times a second, out to braking distance; never beyond the aim)
    if ((u.probeT -= dt) <= 0) { u.probeT = 0.14; this.probe(u, want, vt, Math.min(la, d) + 3, onRoad); }
    want += u.avoid.turn;
    const paved = onRoad || !!world.isRoadNear?.(u.x, u.z);
    let v = Math.min(vt, u.avoid.vmax, vCurve, paved ? Math.min(TUNING.vTop, TUNING.vRoad * (u.ram ? 1 + TUNING.catchUp : u.boost)) : TUNING.vOff + (u.ram ? 6 : 0));
    // pure pursuit: the arc through the aim point (behind it: a U-turn at full lock and a crawl, one way until round)
    const alpha = wrapPi(want - u.yaw);
    let kap;
    // (a spot just behind it (pulling up, parking): straight back to it, not round in a circle)
    const back = vt > 0 && d < 12 && d > 0.6 && Math.abs(alpha) > 2.2 && u.rev <= 0;
    if (back) { const ar = wrapPi(want - u.yaw - Math.PI); kap = -(2 * Math.sin(ar)) / Math.max(3, la); v = -Math.min(3.5, 0.5 + d * 0.6); u.uturn = 0; }
    else if (Math.abs(alpha) > 1.75 || (u.uturn && Math.abs(alpha) > 1.0)) {
      if (!u.uturn) { u.uturn = alpha >= 0 ? 1 : -1; u.kturn = paved; }
      kap = u.uturn / R_MIN; v = Math.min(v, 4.5);
      // on a road: a three-point turn (the nose at the edge: back up on the other lock), never round through the snow
      if (u.kturn && u.rev <= 0 && u.v > 0.5 && laneDistance(u.x + Math.sin(u.yaw) * (u.hd + 0.8), u.z + Math.cos(u.yaw) * (u.hd + 0.8)) > ROAD_HALF + 0.4) { u.rev = 1.1; u.revSteer = -u.uturn * 0.6; }
    } else { u.uturn = 0; kap = (2 * Math.sin(alpha)) / Math.max(4, la); }
    if (Math.abs(kap) > 1e-3 && !back) v = Math.min(v, Math.max(4, Math.sqrt(A_LAT / Math.abs(kap))));
    if (d < 0.6) v = 0;
    if (u.rev > 0) {
      u.rev -= dt;
      u.steer += clamp(u.revSteer - u.steer, -3 * dt, 3 * dt);
      u.v += clamp(-4.5 - u.v, -12 * dt, 8 * dt);
      u.stT = 0; u.stX = u.x; u.stZ = u.z;
      if (u.rev <= 0) u.probeT = 0;
    } else {
      // (the lock the speed allows: never more sideways grip than A_LAT x 1.3)
      const lim = Math.min(0.7, Math.atan((WB * A_LAT * 1.3) / Math.max(1, u.v * u.v)) + 0.02);
      u.steer += clamp(clamp(Math.atan(WB * kap), -lim, lim) - u.steer, -3 * dt, 3 * dt);
      const acc = u.v < 0 ? 10 : 8.5 * (1 - 0.6 * clamp(u.v / TUNING.vTop, 0, 1)); // (0-250 km/h in ~13 s, pursuit-spec)
      u.v += clamp(v - u.v, -A_BRAKE * 1.1 * dt, acc * dt);
      // progress: wanting to go but hardly moved in a second: back up and turn out (the other way each time); a few
      // in a row: drivePursuit puts it back on a road out of sight
      u.stT += dt;
      if (u.v < -0.3) u.stNeg = true; // (backing up in this second (a three-point turn, parking): not stuck)
      if (u.stT >= 1.1) {
        const moved = hyp(u.x, u.z, u.stX, u.stZ);
        if (v > 2.5 && moved < 1.6 && !u.stNeg) {
          u.stuckN++; u.okT = 0; u.uturn = 0; u.avoid.turn = 0;
          u.rev = 1.1 + Math.min(3, u.stuckN) * 0.3;
          u.revSteer = -(alpha >= 0 ? 1 : -1) * (u.stuckN % 2 ? 1 : -1) * 0.6;
        } else if (moved > 4) { u.okT = (u.okT || 0) + u.stT; if (u.okT > 5) u.stuckN = 0; }
        u.stT = 0; u.stX = u.x; u.stZ = u.z; u.stNeg = false;
      }
    }
    u.yaw = wrapPi(u.yaw + (u.v / WB) * Math.tan(u.steer) * dt);
    u.x += Math.sin(u.yaw) * u.v * dt; u.z += Math.cos(u.yaw) * u.v * dt;
    this.pushOut(u);
    this.place(u);
    u.noYou = false; u.direct = false;
  }
  // something solid at (x, z) within r? (buildings, rocks, poles, parked cars, other players' cars, guardrails; trees);
  // dyn (the probe): also the other patrol car, the traffic and the bus (and the guardrails a little narrower: the aim
  // across a bend's chord grazes them)
  solidAt(x, z, r, u, dyn = false) {
    // your car: steered round unless they mean to ram it (or keep their distance behind it by the speed)
    const d = this.drive?.d;
    if (d && !u.ram && !(dyn && u.noYou) && Math.abs(d.x - x) < 4 + r && Math.abs(d.z - z) < 4 + r) {
      const s = Math.sin(d.yaw), c = Math.cos(d.yaw), lx = (x - d.x) * c - (z - d.z) * s, lz = (x - d.x) * s + (z - d.z) * c;
      if (Math.abs(lx) < d.w / 2 + r && Math.abs(lz) < d.half + r) return (this._yc ||= { x: 0, z: 0, hw: 0, hd: 0, rot: 0 }, Object.assign(this._yc, { x: d.x, z: d.z, hw: d.w / 2, hd: d.half, rot: -d.yaw }));
    }
    const mine = this.drive?.d?.e?.collider;
    for (const c of this.colliders || []) {
      if (c === u.col || c.net || c.police === 'local' || c === mine) continue;
      let rr = r;
      if (c.rail) { if (c.top !== undefined && Math.abs(c.top - u.y) > 3.5) continue; if (dyn) rr = Math.max(0.3, r - 0.45); } // (a guardrail: solid)
      else if (c.soft) continue;
      const size = c.r ?? Math.max(c.hw, c.hd);
      if (Math.abs(c.x - x) > size + rr || Math.abs(c.z - z) > size + rr) continue;
      if (c.r !== undefined) { if (Math.hypot(x - c.x, z - c.z) < c.r + rr) return c; continue; }
      const cs = Math.cos(-c.rot), sn = Math.sin(-c.rot), lx = (x - c.x) * cs - (z - c.z) * sn, lz = (x - c.x) * sn + (z - c.z) * cs;
      if (Math.abs(lx) < c.hw + rr && Math.abs(lz) < c.hd + rr) return c;
    }
    if (dyn && this.dynAt(x, z, r, u)) return true;
    const t = this.vegetation?.collide?.(x, z, r, 0.6, true);
    return t ? { x: t.x, z: t.z, r: t.trunk ?? t.r ?? 0.4 } : null;
  }
  // (the probe) the other patrol car, the traffic (stretched a little the way it is moving), the ski bus
  dynAt(x, z, r, u) {
    for (const o of this.units) if (o !== u && o.on && Math.abs(o.x - x) < 6 + r && Math.abs(o.z - z) < 6 + r && inBox(x, z, r, o.x, o.z, o.yaw, o.hw, o.hd)) return true;
    for (const c of this.traffic?.cars || []) {
      if (c.mode === 'gone' || !c.g?.visible || Math.abs(c.x - x) > 9 + r || Math.abs(c.z - z) > 9 + r) continue;
      const a = (c.mode === 'road' ? c.v || 0 : 0) * 0.4 * (c.rev ? -1 : 1);
      if (inBox(x, z, r, c.x + Math.sin(c.yaw) * a, c.z + Math.cos(c.yaw) * a, c.yaw, c.w / 2, c.l / 2 + Math.abs(a))) return true;
    }
    const line = this.traffic?.skibus?.line, bg = line?.bus?.group;
    return !!(bg?.visible && Math.abs(bg.position.x - x) < 9 + r && Math.abs(bg.position.z - z) < 9 + r && inBox(x, z, r, bg.position.x, bg.position.z, line.yaw || 0, 1.3, 6));
  }
  // what's in the way along `want` (out to braking distance, never beyond `reach`): the free heading nearest it (the
  // side it went last first: no flip-flopping), slower the further off; nothing free: braking short of it. On the
  // roads: no faster than the traffic on the way ahead + 6 m/s once near it (then round it)
  probe(u, want, vt, reach, onRoad) {
    const A = u.avoid, sp = Math.max(Math.abs(u.v), 5);
    const L = Math.min(clamp(6 + sp * 0.3 + ((sp * sp) / (2 * A_BRAKE)) * 0.6, 7, 70), Math.max(6, reach));
    A.vmax = 99;
    if (vt < 1) { A.turn = 0; return; }
    const b0 = this.ray(u, want, L);
    if (b0 >= L) A.turn = 0;
    else {
      let best = 0, bd = b0, found = false;
      for (const a of A.turn < 0 ? ANG_R : ANG_L) {
        const b = this.ray(u, want + a, L);
        if (b >= L) { A.turn = a; A.vmax = Math.max(6, vt * (1 - Math.abs(a) * 0.35)); found = true; break; }
        if (b > bd) { bd = b; best = a; }
      }
      if (!found) { A.turn = best; A.vmax = Math.max(3, Math.sqrt(2 * A_BRAKE * Math.max(0, bd - 4))); }
    }
    const cars = this.traffic?.cars;
    if (onRoad && u.pn > 1 && cars?.length) {
      const R = 14 + (sp * sp) / (2 * A_BRAKE);
      let s = 0;
      for (let j = u.pi; j < u.pn - 2 && s < R; j += 2) {
        const qx = u.PX[j], qz = u.PZ[j];
        for (const c of cars) {
          if (c.mode === 'gone' || !c.g?.visible || Math.abs(c.x - qx) > 2.8 || Math.abs(c.z - qz) > 2.8) continue;
          const vl = Math.max(0, (c.mode === 'road' ? c.v || 0 : 0) * Math.cos(c.yaw - u.yaw) * (c.rev ? -1 : 1));
          A.vmax = Math.min(A.vmax, vl + 6 + Math.sqrt(2 * A_BRAKE * Math.max(0, s - 14)));
        }
        s += hyp(qx, qz, u.PX[j + 2], u.PZ[j + 2]);
      }
    }
  }
  // how far along heading `ang` (up to L) it is clear: nothing solid, the ground not too steep (off the roads)
  ray(u, ang, L) {
    const s = Math.sin(ang), c = Math.cos(ang), r = u.hw + 0.25;
    let hp = world.height(u.x, u.z), pd = 0;
    for (let i = 0; i < FR.length; i++) {
      const dd = L * FR[i], x = u.x + s * dd, z = u.z + c * dd;
      if (this.solidAt(x, z, r, u, true)) return pd;
      const h = world.height(x, z);
      if (Math.abs(h - hp) > (dd - pd) * 0.7 && !world.isRoadNear?.(x, z)) return pd;
      hp = h; pd = dd;
    }
    return L;
  }
  // out of whatever it ran into (three circles along it), a scrape of speed; a guardrail: a glance (turned along it,
  // a little speed lost)
  pushOut(u) {
    const s = Math.sin(u.yaw), c = Math.cos(u.yaw), R = u.hw;
    let hit = false, rail = null;
    for (const k of [u.hd - R, 0, -(u.hd - R)]) {
      for (let it = 0; it < 2; it++) {
        const cx = u.x + s * k, cz = u.z + c * k, o = this.solidAt(cx, cz, R, u);
        if (!o) break;
        let nx, nz, depth;
        if (o.r !== undefined) { const dx = cx - o.x, dz = cz - o.z, l = Math.hypot(dx, dz) || 1; nx = dx / l; nz = dz / l; depth = (o.r + R) - l; }
        else {
          const cs = Math.cos(-o.rot), sn = Math.sin(-o.rot), lx = (cx - o.x) * cs - (cz - o.z) * sn, lz = (cx - o.x) * sn + (cz - o.z) * cs;
          const ox = o.hw + R - Math.abs(lx), oz = o.hd + R - Math.abs(lz);
          let nlx = 0, nlz = 0;
          if (ox < oz) { nlx = Math.sign(lx) || 1; depth = ox; } else { nlz = Math.sign(lz) || 1; depth = oz; }
          const c2 = Math.cos(o.rot), s2 = Math.sin(o.rot);
          nx = nlx * c2 - nlz * s2; nz = nlx * s2 + nlz * c2;
        }
        if (!(depth > 0)) break;
        u.x += nx * Math.min(depth, 1.5); u.z += nz * Math.min(depth, 1.5);
        if (o.rail) rail = o; else hit = true;
      }
    }
    if (hit) u.v *= 0.92;
    else if (rail) {
      let e = wrapPi(-rail.rot - u.yaw);
      if (Math.abs(e) > Math.PI / 2) e = wrapPi(e + Math.PI);
      u.yaw = wrapPi(u.yaw + clamp(e * 0.3, -0.08, 0.08));
      u.v *= 0.985;
    }
  }

  // ---------------------------------------------------------------- contacts: you, the traffic, the other players
  hits(dt) {
    const d = this.drive?.d, W = this.w;
    // the patrol cars into each other: apart, a scrape of speed
    for (let i = 0; i < this.units.length; i++) {
      const a = this.units[i];
      if (!a.on) continue;
      for (let j = i + 1; j < this.units.length; j++) {
        const b = this.units[j];
        if (!b.on || Math.abs(a.x - b.x) > 7 || Math.abs(a.z - b.z) > 7) continue;
        const A1 = (a.A ||= {}), B1 = (b.A ||= {});
        A1.x = a.x; A1.z = a.z; A1.yaw = a.yaw; A1.hw = a.hw; A1.hd = a.hd; B1.x = b.x; B1.z = b.z; B1.yaw = b.yaw; B1.hw = b.hw; B1.hd = b.hd;
        const ct = contact(A1, B1);
        if (!ct) continue;
        a.x += ct.nx * ct.depth * 0.5; a.z += ct.nz * ct.depth * 0.5; b.x -= ct.nx * ct.depth * 0.5; b.z -= ct.nz * ct.depth * 0.5;
        a.v *= 0.9; b.v *= 0.9;
        this.place(a); this.place(b);
      }
    }
    for (const u of this.units) {
      if (!u.on) continue;
      const A = (u.A ||= {}); A.x = u.x; A.z = u.z; A.yaw = u.yaw; A.hw = u.hw; A.hd = u.hd;
      // the traffic: shoved aside
      for (const c of this.traffic?.cars || []) {
        if (c.mode === 'gone' || !c.g?.visible || Math.abs(c.x - u.x) > 8 || Math.abs(c.z - u.z) > 8) continue;
        const B = (this._tb ||= {}); B.x = c.x; B.z = c.z; B.yaw = c.yaw; B.hw = c.w / 2; B.hd = c.l / 2;
        if (!obb(u.x, u.z, u.yaw, u.hw, u.hd, B)) continue;
        const ct = contact(B, A);
        if (!ct) continue;
        c.x += ct.nx * ct.depth; c.z += ct.nz * ct.depth;
        if (Math.abs(u.v) > 2) { this.traffic.knock?.(c, ct.nx * Math.abs(u.v) * 0.6 + Math.sin(u.yaw) * u.v * 0.3, ct.nz * Math.abs(u.v) * 0.6 + Math.cos(u.yaw) * u.v * 0.3, (Math.random() - 0.5) * 2); u.v *= 0.8; }
      }
      // your car
      if (!d || d.crash) continue;
      const P = (this._pb ||= {}); P.x = d.x; P.z = d.z; P.yaw = d.yaw; P.hw = d.w / 2 - 0.08; P.hd = d.half;
      const ct = contact(P, A); // (normal from the patrol car to you)
      if (!ct) continue;
      const { nx, nz, depth } = ct;
      d.x += nx * depth * 0.55; d.z += nz * depth * 0.55; u.x -= nx * depth * 0.45; u.z -= nz * depth * 0.45;
      const ux = Math.sin(u.yaw) * u.v, uz = Math.cos(u.yaw) * u.v;
      const vn = (d.vx - ux) * nx + (d.vz - uz) * nz;
      if (vn >= 0) { this.place(u); continue; }
      const yours = -(d.vx * nx + d.vz * nz); // (your own speed into them)
      const m1 = 1800, m2 = 1900, J = (-(1.3) * vn) / (1 / m1 + 1 / m2);
      d.vx += (J / m1) * nx; d.vz += (J / m1) * nz;
      const nux = ux - (J / m2) * nx, nuz = uz - (J / m2) * nz;
      u.v = nux * Math.sin(u.yaw) + nuz * Math.cos(u.yaw);
      this.place(u);
      const closing = -vn;
      if (u.ram && W?.fleeing) {
        // their ram: real damage (drive.js knock / crash), a spin from where it hit: the point of your car nearest its
        // middle, the push about your middle (a rear quarter: a PIT, you spin out)
        // (a PIT / T-bone that connects is never a brush: at least ramMin; the spin and a sideways shove after the
        // knock / crash, which sets its own)
        const eff = Math.max(closing * TUNING.ramMult, TUNING.ramMin);
        const sy = Math.sin(d.yaw), cy = Math.cos(d.yaw), qx = u.x - d.x, qz = u.z - d.z;
        const lx = clamp(qx * cy - qz * sy, -d.w / 2, d.w / 2), lz = clamp(qx * sy + qz * cy, -d.half, d.half);
        const rx = cy * lx + sy * lz, rz = -sy * lx + cy * lz;
        const e = d.e;
        if (eff > CRASH_V && this.drive.canCrash()) this.drive.crash(eff, nx, nz, 'car');
        else if (eff > KNOCK_V) this.drive.knock(eff, nx, nz);
        d.yawRate = clamp((d.yawRate || 0) + clamp((nx * rz - nz * rx) * (0.5 + closing * 0.16) * TUNING.spin, -3, 3), -3.6, 3.6);
        d.vx += nx * TUNING.ramPush; d.vz += nz * TUNING.ramPush;
        if (this.drive.d?.crash) { e.policeWreck = true; this.wreckE = e; } // (wrecked by the police: not repaired, carrental.js)
        u.dmg += Math.max(0, closing * 3.6 - TUNING.wreckKmh) * TUNING.wreckPer * 0.35; // (their ram hurts them a little)
        u.v *= u.pitT > 0 ? 0.92 : 0.75; u.ramCool = TUNING.ramGapS; u.pitT = 0; u.pitSide = 0;
      } else if (closing > KNOCK_V && yours > KNOCK_V * 0.6) {
        // you drove into them: your knock, their damage, and (not fleeing yet) now you are
        this.drive.knock(closing, nx, nz);
        u.dmg += Math.max(0, closing * 3.6 - TUNING.wreckKmh) * TUNING.wreckPer;
        if (W && !W.fleeing && closing * 3.6 >= TUNING.triggerKmh) this.flee(W);
      }
      if (u.dmg >= 100) this.wreck(u);
      if (performance.now() - (this.bangT || 0) > 300) { this.bangT = performance.now(); try { this.audio?.impact ? this.audio.impact('car', Math.min(1, 0.3 + closing / 15)) : this.audio?.play?.('land', 0.6); } catch { /* (silent) */ } }
    }
    // other players on foot run into at speed (multiplayer): they call the police too
    if (d && !this.w && this.cool <= 0 && isMP()) {
      const sp = Math.hypot(d.vx, d.vz);
      if (sp * 3.6 >= TUNING.triggerKmh) {
        const fx = Math.sin(d.yaw), fz = Math.cos(d.yaw);
        for (const r of this.mp?.()?.remotes?.players?.values?.() || []) {
          if (!r.ok || r.interior || r.veh || !FOOT.has(r.state)) continue;
          const dx = r.pos.x - d.x, dz = r.pos.z - d.z, lz = dx * fx + dz * fz, lx = dx * fz - dz * fx;
          if (Math.abs(lz) < d.half + 0.4 && Math.abs(lx) < d.w / 2 + 0.4) { this.reportHit('player', sp); break; }
        }
      }
    }
    void dt;
  }

  // ---------------------------------------------------------------- pulled over / arrested: the officer
  begin(W, kind, u, why = '') {
    if (W.scene) return;
    W.scene = { kind, u, why, step: 'pull', t: 0, said: false };
    W.stopT = 0;
    for (const x of this.units) if (x.on) x.ram = false;
    if (kind === 'fine') this.note('Pulled over · stay where you are');
    else if (why === 'wrecked') this.note('Your car is wrecked · the police are coming for you');
    else if (why === 'stopped') this.note('Stopped · you are under arrest');
    else if (why === 'held') this.note('Boxed in by the police · you are under arrest');
  }
  // the officer: the police officer's rig on foot (his own, see loadOfficer), else a skier from the job pool
  // (jobs/actors.js), else a stand-in figure
  spawnOfficer(u) {
    if (u.officer) return u.officer;
    const s = Math.sin(u.yaw), c = Math.cos(u.yaw);
    const x = u.x + c * (u.hw + 0.6) + s * 0.2, z = u.z - s * (u.hw + 0.6) + c * 0.2; // (out by the driver's door: +x)
    const pos = new THREE.Vector3(x, world.groundHeight(x, z, u.y + 2), z);
    const st = { mode: 'idle', heading: u.yaw, speed: 0, crouch: 0, lean: 0, plow: 0, tuck: false, normal: UP, air: false, carry: false, seat: null };
    let slot = this.hasOfficer ? this.officerRigs.pop() || this.newOfficerRig() : null;
    if (slot) resetRig(slot.rig);
    else { const pool = this.jobs?.pool; slot = pool ? pool.take('skier_blue', this.player?.rigChar) : null; }
    const rig = slot?.rig || null;
    let root;
    if (rig) {
      root = rig.root;
      this.scene.add(rig.root); if (rig.gear) this.scene.add(rig.gear);
      rig.setSkisVisible?.(false); rig.setCarry?.(false);
      rig.root.position.copy(pos);
      try { rig.update(1 / 30, st); rig.update(1 / 30, st); } catch { /* (posed next frame) */ }
      if (rig.fx) rig.fx.length = 0;
    } else { root = makeFallbackFigure('stand', '#1b3f9e'); root.position.copy(pos); this.scene.add(root); }
    if (u.driver) u.driver.visible = false; // (he was the driver)
    u.officer = { slot, rig, root, st, pos, heading: u.yaw, acc: 0 };
    return u.officer;
  }
  dropOfficer(u) {
    const o = u.officer;
    if (!o) return;
    if (o.rig) {
      o.rig.root.removeFromParent(); o.rig.gear?.removeFromParent();
      if (o.slot?.own) { resetRig(o.rig); this.officerRigs.push(o.slot); } else if (o.slot) this.jobs?.pool?.give(o.slot);
    }
    else { o.root.removeFromParent(); o.root.userData?.ownGeometry?.dispose?.(); }
    u.officer = null;
    if (u.driver) u.driver.visible = true;
  }
  walkOfficer(o, tx, tz, v, dt) {
    const dx = tx - o.pos.x, dz = tz - o.pos.z, l = Math.hypot(dx, dz);
    if (l < 0.08) { o.st.mode = 'idle'; o.st.speed = 0; return l; }
    const s = Math.min(l, v * dt);
    o.pos.x += (dx / l) * s; o.pos.z += (dz / l) * s;
    o.pos.y = world.groundHeight(o.pos.x, o.pos.z, o.pos.y + 1.5);
    o.heading = Math.atan2(dx, dz);
    o.st.mode = 'walk'; o.st.speed = v;
    return l - s;
  }
  poseOfficer(o, dt, face = null) {
    if (face !== null) o.heading = face;
    o.st.heading = o.heading;
    if (!o.rig) { o.root.position.copy(o.pos); o.root.rotation.y = o.heading; return; }
    o.rig.root.position.copy(o.pos);
    try { o.rig.update(dt, o.st); } catch (e) { if (!this.poseErr) { this.poseErr = true; console.warn('police officer pose', e); } }
    if (o.rig.fx) o.rig.fx.length = 0;
  }
  doorOf(u, out = { x: 0, z: 0 }) {
    const s = Math.sin(u.yaw), c = Math.cos(u.yaw);
    out.x = u.x + c * (u.hw + 0.6) + s * 0.2; out.z = u.z - s * (u.hw + 0.6) + c * 0.2;
    return out;
  }

  sceneStep(dt, W, T) {
    const S = W.scene, u = S.u;
    S.t += dt;
    if (!u.on) { W.scene = null; return; }
    // the other car stays back (behind the lead, a little to the side)
    for (const x of this.units) if (x.on && x !== u) { const b = this.carPoint({ x: u.x, z: u.z, yaw: u.yaw }, 1.4, -11, this._p2 ||= {}); this.step(x, dt, b.x, b.z, clamp(hyp(x.x, x.z, b.x, b.z) * 0.8, 0, 14), u.yaw); }
    // you drive off (or run off) mid-scene: fleeing again; the officer back to his car
    const off = T.car ? S.kind === 'fine' && T.sp > 4.5 : T.foot && S.kind === 'fine' && T.sp > 2.6 && S.step !== 'pull'; // (an arrest in the car: held, drive.js)
    if (off && (S.step === 'pull' || S.step === 'walk' || (S.step === 'talk' && !S.said))) {
      this.flee(W);
      if (u.officer) { S.step = 'back'; S.abort = true; } else { W.scene = null; return; }
    }
    if (S.step === 'pull') {
      // pull up: behind your car (8 m), or ~8 m short of you on foot
      let px, pz, face = null;
      if (T.car) { const P = this.carPoint(T.car, 0.3, -T.car.half - 7.5, this._pt ||= {}); px = P.x; pz = P.z; face = T.car.yaw; }
      else { this.footGoal(u, T, dt); px = u.fg.x; pz = u.fg.z; } // (on foot: as near you as a car gets, footGoal)
      const g = hyp(u.x, u.z, px, pz);
      this.step(u, dt, px, pz, g < 0.8 ? 0 : clamp(1 + g * 0.9, 0, 16), face);
      if ((g < 2.2 && Math.abs(u.v) < 1) || (S.t > 14 && Math.abs(u.v) < 1.5) || (T.foot && (hyp(u.x, u.z, T.x, T.z) < 14 || g < 3.5) && Math.abs(u.v) < 6)) { u.v = 0; S.step = 'walk'; S.t = 0; this.spawnOfficer(u); }
      return;
    }
    this.step(u, dt, u.x + Math.sin(u.yaw) * 0.3, u.z + Math.cos(u.yaw) * 0.3, 0);
    const o = u.officer || this.spawnOfficer(u);
    if (S.step === 'walk') {
      // to your window (in the car), or to you (on foot: running while you run)
      let tx = T.x, tz = T.z, reach = TUNING.footCatchR * 0.5;
      if (T.car) { const E = driverEye(T.car.t || { size: { x: T.car.w, y: 1.5, z: T.car.half * 2 } }), sg = E.x >= 0 ? 1 : -1; const P = this.carPoint(T.car, sg * (T.car.w / 2 + 0.55), E.z, this._pw ||= {}); tx = P.x; tz = P.z; reach = 0.25; }
      const run = !T.car && (S.kind === 'arrest' ? T.sp > 1.2 || hyp(o.pos.x, o.pos.z, T.x, T.z) > 6 : false);
      const left = this.walkOfficer(o, tx, tz, run ? RUN_V : WALK_V, dt);
      this.poseOfficer(o, dt);
      const dist = hyp(o.pos.x, o.pos.z, T.x, T.z);
      // on foot: caught within 4 m
      if ((!T.car && dist < TUNING.footCatchR) || (T.car && left <= reach)) { S.step = 'talk'; S.t = 0; }
      // outrun on foot (or got into a car): back to the car, the chase goes on
      else if (!T.car && S.kind === 'arrest' && hyp(o.pos.x, o.pos.z, u.x, u.z) > 110) { S.step = 'back'; S.abort = true; }
      return;
    }
    if (S.step === 'talk') {
      const face = Math.atan2(T.x - o.pos.x, T.z - o.pos.z);
      o.st.mode = 'idle'; o.st.speed = 0;
      this.poseOfficer(o, dt, face);
      if (!S.said) {
        S.said = true;
        if (S.kind === 'fine') {
          const f = this.fineNow();
          this.say('Officer', `License and registration, please... You caused a collision back there.${this.record() ? ' And not for the first time.' : ''} That's a ${usd(f)} fine.`);
          this.charge(f); this.addRecord();
        } else {
          const f = this.arrestNow(), a = usd(f);
          this.say('Officer', S.why === 'wrecked' ? `Stay right there! You are under arrest. That car is going nowhere. ${a} and you're coming with us.`
            : T.car ? `Out of the car! You are under arrest for fleeing the police. That's ${a}.` : `Stop right there! You are under arrest for fleeing the police. That's ${a}.`);
          this.charge(f); this.lastArrest = f; this.addRecord();
        }
      }
      if (S.kind === 'arrest' && S.t > 2.2 && !S.jailed) { S.jailed = true; this.arrest(); return; }
      if (S.kind === 'fine' && S.t > 3.4) { S.step = 'back'; S.t = 0; this.note('Fine paid · drive safely'); }
      return;
    }
    if (S.step === 'back') {
      const D = this.doorOf(u, this._pd ||= {});
      const left = this.walkOfficer(o, D.x, D.z, S.abort ? RUN_V : WALK_V * 1.1, dt);
      this.poseOfficer(o, dt);
      if (left < 0.3) {
        this.dropOfficer(u);
        if (S.abort) { W.scene = null; return; }
        S.step = 'done'; S.t = 0;
        this.end('paid');
      }
    }
  }
  say(who, line) { this.note(`${who}: "${line}"`, 7); }
  // a message in the WANTED box for a while (the user: one box, not pop-ups on top of it); no chase: a normal flash
  note(text, s = 7) {
    if (!this.w) { this.hud?.flash?.(text, 'bad', s * 1000); return; }
    this.noteText = text; this.noteUntil = performance.now() + s * 1000;
  }
  // a fine off your money (single player: the save; multiplayer: the session's money guard sends it to the server as
  // a 'game' spend, which may take you into debt like any of the game's own charges)
  // the fines grow with your record (the user: "if you do it more than once it keeps increasing"): every earlier
  // fine or arrest adds fineStep / arrestStep (save.policeRecord, kept in the save: the multiplayer one too)
  record() { return Math.max(0, this.save?.policeRecord | 0); }
  addRecord() { if (this.save) { this.save.policeRecord = this.record() + 1; this.writeSave?.(); } }
  fineNow() { return TUNING.fine + TUNING.fineStep * this.record(); }
  arrestNow() { return TUNING.arrestFine + TUNING.arrestStep * this.record(); }
  charge(amount) {
    const s = this.save;
    if (!s) return;
    s.money = (s.money || 0) - amount;
    this.writeSave?.();
    this.hud?.setMoney?.(s.money, -amount);
    this.audio?.play?.('cash');
  }
  // the fade: out of the car (it stays where it stopped), the patrol cars gone, into the prison
  // (the prison does its own fade and takes you out of the car: main.js prisonClear; the patrol cars wait where they
  // are until you are in the cell)
  arrest() {
    const pr = this.prison;
    if (pr?.jail) {
      try {
        this.w = null; this.jailing = 4;
        pr.jail(TUNING.jailS, 'fleeing the police');
        return;
      } catch (e) { console.warn('police: prison', e); this.jailing = 0; }
    }
    const go = () => {
      try { if (this.drive?.active) this.drive.abort(); } catch (e) { console.warn('police: out of the car', e); }
      this.clear(true);
      this.hud?.flash?.(`Arrested · -${usd(this.lastArrest || TUNING.arrestFine)}`, 'bad', 4000);
    };
    if (this.transition?.fade) this.transition.fade(go); else go();
  }

  // ---------------------------------------------------------------- the end of a chase
  escaped(msg = 'You escaped the police') {
    this.hud?.flash?.(msg, 'good', 4200);
    this.end('escaped');
  }
  // the chase over: the patrol cars drive off (out of sight: gone)
  end(why) {
    this.w = null; this.cool = TUNING.cooldownS; this.wreckE = null;
    for (const u of this.units) if (u.on) { u.mode = 'leave'; u.ram = false; u.gone = 0; u.leaveTo = null; u.path = null; }
    void why;
  }
  /** Everything gone at once (an arrest's fade, a race, the prison). */
  clear(quiet = false) {
    this.w = null; this.cool = TUNING.cooldownS; this.wreckE = null;
    if (this.drive) this.drive.held = false;
    for (const u of this.units) if (u.on) this.despawn(u);
    if (!quiet) this.setHud(false);
  }
  leave(u, dt) {
    if (u.officer) { // (an officer still out: back to the car first)
      const D = this.doorOf(u, this._pd ||= {});
      const left = this.walkOfficer(u.officer, D.x, D.z, WALK_V * 1.3, dt);
      this.poseOfficer(u.officer, dt);
      if (left < 0.3) this.dropOfficer(u);
      this.place(u);
      return;
    }
    const T = this.target();
    if (!u.leaveTo) { // (somewhere 600 m on, the way it faces)
      const L = 600;
      u.leaveTo = { x: u.x + Math.sin(u.yaw) * L, z: u.z + Math.cos(u.yaw) * L };
      try {
        const G = busRoads.roads.length ? roadGraph() : null;
        if (G?.N) {
          let best = -1, bs = -Infinity;
          for (let i = 0; i < G.N; i += 3) { const dd = T ? hyp(G.X[i], G.Z[i], T.x, T.z) : 0, du = hyp(G.X[i], G.Z[i], u.x, u.z); if (dd < 350 || du > 1200) continue; const sc = -Math.abs(du - 600) + Math.random() * 120; if (sc > bs) { bs = sc; best = i; } }
          if (best >= 0) u.leaveTo = { x: G.X[best], z: G.Z[best] };
        }
      } catch { /* (straight on) */ }
    }
    this.step(u, dt, u.leaveTo.x, u.leaveTo.z, TUNING.vRoad * 0.6);
    u.gone += dt;
    const d = T ? hyp(u.x, u.z, T.x, T.z) : 1e9;
    let seen = false;
    try { this.camera?.updateMatrixWorld?.(); _fr.setFromProjectionMatrix(_m.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse)); seen = _fr.containsPoint(_v.set(u.x, u.y + 1, u.z)); } catch { /* (gone by distance) */ }
    if ((d > 160 && !seen) || d > 450 || u.gone > 45 || hyp(u.x, u.z, u.leaveTo.x, u.leaveTo.z) < 15) this.despawn(u);
  }

  // ---------------------------------------------------------------- sound, HUD, the map, multiplayer
  siren(paused) {
    const W = this.w, T = W && !paused ? this.target() : null;
    const chasing = !!T && !W.scene && this.units.some((u) => u.on);
    if (!chasing) { if (this.sirenOn) { this.sirenOn = false; this.audio?.setSiren?.({ on: false }); } return; }
    let best = null, bd = Infinity;
    for (const u of this.units) if (u.on) { const d = hyp(u.x, u.z, T.x, T.z); if (d < bd) { bd = d; best = u; } }
    // pitch by the closing speed (doppler)
    const dx = T.x - best.x, dz = T.z - best.z, l = Math.hypot(dx, dz) || 1;
    const closing = (Math.sin(best.yaw) * best.v - T.vx) * (dx / l) + (Math.cos(best.yaw) * best.v - T.vz) * (dz / l);
    this.sirenOn = true;
    this.audio?.setSiren?.({ on: true, dist: bd, doppler: clamp(343 / (343 - clamp(closing, -60, 60)), 0.85, 1.18) });
  }
  hudFrame(paused, hiding = false) {
    const W = this.w;
    if (!W || paused) { this.setHud(false); return; }
    const S = W.scene;
    if (hiding) { // (in a chalet: the box stays up, the escape time runs)
      this.setHud(true, mmss(W.t), "Hiding · the police are still looking for you · stay inside", `${mmss(W.esc)} <em>/ ${mmss(TUNING.escapeS)} · hidden</em>`, W.esc / TUNING.escapeS, 0, 'THEY CAN\'T FIND YOU', 2, false, true);
      return;
    }
    const msg = S ? (S.kind === 'fine' ? (S.step === 'back' || S.step === 'done' ? 'Fine paid' : `Pulled over · stay in the car · ${usd(this.fineNow())} fine`) : 'Under arrest')
      : W.fleeing ? 'Fleeing · they will ram you · stop to give up'
        : W.reached ? `Pull over now: stop to pay the ${usd(this.fineNow())} fine${W.grace > 0 ? ` (${Math.ceil(W.grace)})` : ''}` : `Police! Stop to pay a ${usd(this.fineNow())} fine, or get away`;
    const msg2 = this.noteUntil > performance.now() ? this.noteText : msg;
    const far = !Number.isFinite(W.near) || W.near > TUNING.escapeR;
    const near = Number.isFinite(W.near) ? `${far ? 'LOSING THEM' : 'TOO CLOSE'} · ${Math.round(W.near)} M` : 'NO POLICE NEAR';
    const esc = S ? '' : `${mmss(W.esc)} <em>/ ${mmss(TUNING.escapeS)} · ${TUNING.escapeR} m+</em>`;
    let cars = 0; for (const u of this.units) if (u.on) cars++;
    const stars = clamp(1 + (W.reached ? 1 : 0) + (W.fleeing ? 1 : 0) + ((W.wrecks || 0) > 0 ? 1 : 0) + (W.fleeing && W.t > 60 ? 1 : 0), 1, 5);
    this.setHud(true, mmss(W.t), msg2, esc, S ? 0 : W.esc / TUNING.escapeS, cars, near, stars, !!(W.fleeing || (S && S.kind === 'arrest')), !S && far);
  }
  /** Trail map: the patrol cars while you are wanted (blue dots). */
  mapMarkers() {
    if (!this.w) return [];
    return this.units.filter((u) => u.on).map((u) => ({ x: u.x, z: u.z, kind: 'police', label: 'Police' }));
  }
  // your patrol cars to the other players: 'veh' { k: 'police', cars: [[x, y, z, yaw, v], ...] } ~6 times a second;
  // { k: 'police', off: true } once they are gone
  netFrame(dt) {
    if (!isMP() || !net.open) { this.netSent = false; return; }
    const live = this.units.filter((u) => u.on);
    if (!live.length) {
      if (this.netSent) { this.netSent = false; net.request('veh', { k: 'police', off: true }).catch(() => {}); }
      return;
    }
    if ((this.netT += dt) < SEND_DT && this.netSent) return;
    this.netT = 0;
    this.netSent = true;
    const r = (v) => Math.round(v * 100) / 100;
    net.send('veh', { k: 'police', cars: live.map((u) => [r(u.x), r(u.y), r(u.z), r(u.yaw), r(clamp(u.v, -75, 75))]) });
  }

  dispose() {
    this.disposed = true;
    this.clear(true);
    this.unblock?.();
    for (const u of this.units) { u.g.removeFromParent(); const i = this.colliders?.indexOf(u.col); if (i >= 0) this.colliders.splice(i, 1); }
    this.units.length = 0;
    this.el?.remove();
  }
}
