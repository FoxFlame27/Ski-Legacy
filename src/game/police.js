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
//    window, "License and registration... that's a $500 fine", walks back; they drive off. Wanted cleared.
//  - Don't stop (TUNING.graceS after they reach you) and you are fleeing: they ram you (real knocks / crashes through
//    drive.js: damage), a second car joins. 3 minutes in all further than 150 m from every patrol car: escaped.
//    Rammed / blocked to a stop, or caught on foot within 4 m: arrested ($2,000, prison.jail(90)). Wrecked by their
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
import { busRoads } from './bus/roads.js';
import { roadGraph, roadNearest, roadShortest, obb } from './towtruck.js';
import { addTrafficBlocker } from './traffic.js';
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
  fine: 500,         // stop and pay
  arrestFine: 2000,  // caught fleeing
  jailS: 90,         // prison.jail(seconds)
  escapeS: 150,      // s (in all) further than escapeR from every patrol car: escaped (the user: "a bit easier to escape")
  escapeR: 110,      // m
  stopR: 40,         // m: stopped with a patrol car this close: pulled over
  stopKmh: 3,        // ...below this speed
  stopS: 3,          // ...for this long
  spawnMin: 300, spawnMax: 500, // m from you, on the roads, out of sight
  reachR: 60,        // m: they have reached you (the grace to pull over starts)
  graceS: 8,         // s to pull over once they reach you; still moving after it: fleeing
  footCatchR: 4,     // m: an officer on foot this close: caught
  vRoad: 38,         // m/s (137 km/h) on the roads
  vOff: 22,          // m/s off them
  ramExtra: 8,       // m/s over your speed when they ram
  ramMult: 1.2,      // a police ram counts this much harder (push bars): drive.js knock / crash speed
  ramGapS: 2.5,      // s a patrol car drops back after a ram before the next
  cooldownS: 6,      // s after a chase ends before another hit calls them
};
const CRASH_V = 70 / 3.6, KNOCK_V = 30 / 3.6; // (drive.js)
const LEN = 4.85, WB = 2.95, LANE = 1.6, WALK_V = 1.6, RUN_V = 5.4;
const MODEL = 'police/police_car';
const SEND_DT = 1 / 6;
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
// a road path's points moved LANE m into the right-hand lane (as towtruck.js keepRight)
function keepRight(ids) {
  const G = roadGraph(), P = ids.map((i) => ({ x: G.X[i], z: G.Z[i] }));
  return P.map((p, k) => {
    const a = P[Math.max(0, k - 2)], b = P[Math.min(P.length - 1, k + 2)];
    const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1;
    return { x: p.x - (dz / l) * LANE, z: p.z + (dx / l) * LANE };
  });
}

// a patrol car seen from the side (the WANTED box: one per car after you)
const POLICE_CAR_ICON = '<svg viewBox="0 0 26 13"><path d="M2 9.5V7.2c0-.8.5-1.4 1.3-1.6L7 4.8l3-3.1c.4-.4.9-.6 1.5-.6h5.2c.6 0 1.1.3 1.5.7l2.6 3.1 2.4.5c.9.2 1.5.9 1.5 1.8v2.3c0 .5-.4.9-.9.9h-1.1a2.6 2.6 0 0 0-5.2 0H9.6a2.6 2.6 0 0 0-5.2 0H2.9c-.5 0-.9-.4-.9-.9zM11.8 2.4 9.6 4.9h4.6V2.4zm3.8 0v2.5h4.2l-2.1-2.5z"/><circle cx="7" cy="10.4" r="1.8"/><circle cx="19.2" cy="10.4" r="1.8"/><rect x="12.2" y="0" width="3" height="1.2" rx=".4" fill="#ff4d3d"/></svg>';

const CSS = `
#police-hud { position: absolute; left: 22px; bottom: 92px; width: 260px; padding: 12px 24px 14px 22px; background: #fff; color: var(--blue, #1546c8);
  clip-path: var(--brush-a); filter: drop-shadow(0 6px 14px rgba(0, 20, 60, 0.28)); pointer-events: none; }
#police-hud[hidden] { display: none; }
body.wanted #drive-hud .ch-card, body.wanted #controls-hint { opacity: 0; } /* (the same corner: the box takes it) */
#police-hud .pl-lights { display: flex; gap: 6px; margin-bottom: 6px; }
#police-hud .pl-lights i { flex: 1; height: 4px; border-radius: 2px; background: #1546c8; animation: pl-blink 0.5s steps(1) infinite; }
#police-hud .pl-lights i + i { background: #ff4d3d; animation-delay: 0.25s; }
#police-hud .pl-head { display: flex; align-items: baseline; justify-content: space-between; font-family: var(--num); font-style: italic; font-weight: 700; }
#police-hud .pl-head b { font-size: 26px; letter-spacing: 0.06em; color: #ff4d3d; }
#police-hud .pl-t { font-size: 22px; font-variant-numeric: tabular-nums; }
#police-hud .pl-cars { display: flex; gap: 4px; margin-left: auto; margin-right: 10px; align-self: center; }
#police-hud .pl-cars svg { width: 26px; height: 13px; fill: #1546c8; }
#police-hud .pl-msg { margin-top: 4px; font-size: 13px; font-weight: 700; line-height: 1.3; }
#police-hud .pl-esc { margin-top: 8px; padding-top: 7px; border-top: 1px solid rgba(21, 70, 200, 0.18); }
#police-hud .pl-esc[hidden] { display: none; }
#police-hud .pl-esc span { display: block; font-size: 12px; font-weight: 700; color: var(--blue-dim, #4f72d4); font-variant-numeric: tabular-nums; }
#police-hud .pl-bar { height: 6px; margin-top: 5px; background: rgba(21, 70, 200, 0.14); clip-path: var(--brush-b); }
#police-hud .pl-bar i { display: block; height: 100%; width: 0; background: #1546c8; }
@keyframes pl-blink { 0% { opacity: 1; } 50% { opacity: 0.15; } }`;

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
    el.innerHTML = '<div class="pl-lights"><i></i><i></i></div><div class="pl-head"><b>WANTED</b><span class="pl-cars"></span><span class="pl-t"></span></div><div class="pl-msg"></div><div class="pl-esc"><span></span><div class="pl-bar"><i></i></div></div>';
    (document.getElementById('hud') || document.body).appendChild(el);
    this.el = el;
    this.$t = el.querySelector('.pl-t'); this.$cars = el.querySelector('.pl-cars'); this.$msg = el.querySelector('.pl-msg'); this.$escBox = el.querySelector('.pl-esc'); this.$esc = el.querySelector('.pl-esc span'); this.$bar = el.querySelector('.pl-bar i');
    this.hudCache = {};
  }
  setHud(show, t = '', msg = '', esc = '', frac = 0, cars = 0) {
    if (!this.el) return;
    if (this.el.hidden === show) { this.el.hidden = !show; document.body.classList.toggle('wanted', show); }
    if (!show) return;
    const C = this.hudCache;
    if (C.t !== t) this.$t.textContent = C.t = t;
    if (C.msg !== msg) this.$msg.textContent = C.msg = msg;
    if (C.cars !== cars) { C.cars = cars; this.$cars.innerHTML = POLICE_CAR_ICON.repeat(cars); } // (a little patrol car per car after you)
    if (C.esc !== esc) { this.$esc.textContent = C.esc = esc; this.$escBox.hidden = !esc; }
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
    this.note('Police! Stop to pay a $500 fine, or get away');
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
    const u = { k, m, g: m.g, col, hw, hd, box: { hw, hd: hd + 0.3 }, on: false, x: 0, y: 0, z: 0, yaw: 0, v: 0, steer: 0, path: null, pi: 0, repath: 0,
      probeT: 0, avoid: { turn: 0, vmax: 99 }, stuck: 0, rev: 0, revSteer: 0, mode: 'chase', officer: null, driver: null, gone: 0, leaveTo: null };
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
  // out of sight 300-500 m from you on the roads, facing the way to you (no roads: off-road behind the camera)
  spawn(k) {
    const u = this.unit(k), p = this.target();
    if (!p) return false;
    let best = null;
    try {
      const G = busRoads.roads.length ? roadGraph() : null;
      if (G?.N) {
        this.camera?.updateMatrixWorld?.();
        _fr.setFromProjectionMatrix(_m.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse));
        const other = this.units.find((x) => x.on && x !== u), cand = [];
        for (let pass = 0; pass < 3 && !cand.length; pass++) {
          const lo = pass === 2 ? 120 : TUNING.spawnMin, hi = pass === 0 ? TUNING.spawnMax : pass === 1 ? 800 : 1500;
          for (let i = 0; i < G.N; i += 1) {
            const d = hyp(G.X[i], G.Z[i], p.x, p.z);
            if (d < lo || d > hi) continue;
            if (other && hyp(G.X[i], G.Z[i], other.x, other.z) < 40) continue;
            const seen = pass === 0 && _fr.containsPoint(_v.set(G.X[i], world.height(G.X[i], G.Z[i]) + 1, G.Z[i]));
            if (!seen) cand.push(i);
          }
        }
        if (cand.length) {
          const i = cand[Math.floor(Math.random() * cand.length)], b = roadNearest(p.x, p.z);
          const ids = b.i >= 0 ? roadShortest(i, b.i) : null;
          const n = ids && ids.length > 1 ? ids[1] : -1;
          const yaw = n >= 0 ? Math.atan2(G.X[n] - G.X[i], G.Z[n] - G.Z[i]) : Math.atan2(p.x - G.X[i], p.z - G.Z[i]);
          best = { x: G.X[i] - Math.cos(yaw) * LANE, z: G.Z[i] + Math.sin(yaw) * LANE, yaw };
        }
      }
    } catch (e) { console.warn('police spawn', e); }
    if (!best) {
      const cy = this.camera ? Math.atan2(-this.camera.matrixWorld.elements[8], -this.camera.matrixWorld.elements[10]) : 0;
      const a = cy + Math.PI + (Math.random() - 0.5);
      const x = p.x + Math.sin(a) * TUNING.spawnMin, z = p.z + Math.cos(a) * TUNING.spawnMin;
      best = { x, z, yaw: Math.atan2(p.x - x, p.z - z) };
    }
    u.on = true; u.x = best.x; u.z = best.z; u.yaw = best.yaw; u.v = 8; u.steer = 0; u.path = null; u.repath = 0; u.mode = 'chase';
    u.stuck = 0; u.rev = 0; u.gone = 0; u.leaveTo = null;
    u.y = world.groundHeight(u.x, u.z);
    u.g.visible = true;
    this.seatDriver(u);
    if (u.driver) u.driver.visible = true;
    this.place(u);
    return true;
  }
  despawn(u) {
    this.dropOfficer(u);
    u.on = false; u.g.visible = false; u.v = 0; u.path = null;
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
    const paused = !!this.paused?.();
    try {
      if (W && !paused) this.chase(dt, W);
      for (const u of this.units) if (u.on) { if (!W) this.leave(u, dt); if (u.on) policeLights(u.m, true, this.time + u.k * 0.21); }
      this.hits(dt);
    } catch (e) { if (!this.err) { this.err = true; console.warn('police', e); } }
    this.siren(paused);
    this.hudFrame(paused);
    try { this.netFrame(dt); } catch (e) { console.warn('police mp', e); }
  }

  chase(dt, W) {
    W.t += dt;
    const T = this.target();
    if (!T) return;
    const live = this.units.filter((u) => u.on);
    if (!live.length) { this.clear(); return; }
    let near = Infinity, lead = live[0];
    for (const u of live) { const d = hyp(u.x, u.z, T.x, T.z); if (d < near) { near = d; lead = u; } }
    W.near = near;
    // the escape: in all, further than escapeR from every patrol car
    if (near > TUNING.escapeR && !W.scene) W.esc += dt;
    if (W.esc >= TUNING.escapeS) { this.escaped(); return; }
    // wrecked by their rams: lost, and you are caught
    const wreck = this.wreckE;
    if (wreck && !W.scene && !T.car && wreck.wrecked) { this.wreckE = null; this.begin(W, 'arrest', lead, 'wrecked'); }
    if (W.scene) { this.sceneStep(dt, W, T); return; }
    // they reached you: the grace to pull over, then fleeing
    if (!W.reached && near < TUNING.reachR) { W.reached = true; W.grace = TUNING.graceS; this.note('Pull over now: stop to pay the $500 fine'); }
    if (W.reached && !W.fleeing) {
      W.grace -= dt;
      const away = (T.vx * (T.x - lead.x) + T.vz * (T.z - lead.z)) / Math.max(1, near); // (on foot: running away from them)
      const moving = T.car ? T.sp > 4 : T.foot && away > 2.2;
      if (W.grace <= 0 && moving) this.flee(W);
    }
    // stopped with them close: pulled over (a fine) or caught (fleeing: arrested)
    const still = T.car ? T.sp * 3.6 < TUNING.stopKmh : T.foot && T.sp < 0.8;
    W.stopT = still && near < TUNING.stopR ? W.stopT + dt : 0;
    if (W.stopT >= TUNING.stopS) { this.begin(W, W.fleeing ? 'arrest' : 'fine', lead, W.fleeing ? 'stopped' : ''); return; }
    // fleeing on foot: an officer runs after you once his car is close
    if (W.fleeing && T.foot && near < 16 && !lead.officer) { this.begin(W, 'arrest', lead, 'foot'); return; }
    if (W.fleeing && !W.spawned2 && W.t > 2) { W.spawned2 = true; this.spawn(1); }
    for (const u of live) this.drivePursuit(u, dt, T, W, u === lead);
  }

  flee(W) {
    if (W.fleeing) return;
    W.fleeing = true;
    const foot = !this.drive?.active;
    this.note(`${foot ? 'Running from the police' : 'Fleeing · they will ram you'} · stay ${TUNING.escapeR} m away for ${mmss(TUNING.escapeS)} to escape`);
  }

  // one patrol car chasing: tail you (not fleeing), ram you (fleeing; the second one cuts in ahead), on foot: stop short
  drivePursuit(u, dt, T, W, lead) {
    const d = hyp(u.x, u.z, T.x, T.z);
    let tx = T.x, tz = T.z, vt = TUNING.vRoad, ram = false;
    if (!T.car && !T.foot) { // (on a lift, in the helicopter...: they wait where they are)
      this.step(u, dt, u.x + Math.sin(u.yaw), u.z + Math.cos(u.yaw), 0); return;
    }
    if (T.foot) {
      // on foot: up to ~9 m from you, then stop
      const k = d > 0.1 ? Math.max(0, d - 9) / d : 0;
      tx = u.x + (T.x - u.x) * k; tz = u.z + (T.z - u.z) * k;
      vt = clamp((d - 9) * 0.9, 0, TUNING.vRoad);
    } else if (W.fleeing && d < 70 && (u.ramCool || 0) <= 0) {
      // ramming: where you will be (lead), or ahead of you (the other one: a block)
      ram = true;
      const lookT = clamp(d / Math.max(8, u.v), 0, 1.2);
      tx = T.x + T.vx * lookT; tz = T.z + T.vz * lookT;
      if (!lead) { const f = T.sp > 3 ? 1 / T.sp : 0; tx += T.vx * f * 14; tz += T.vz * f * 14; }
      vt = d > 25 ? TUNING.vRoad : T.sp + TUNING.ramExtra; // (closing in flat out, then just faster than you)
    } else if (!W.fleeing && d < 45) {
      // tailing: 10 m behind you (the other one 18 m), matching your speed
      const back = lead ? 10 : 18, P = this.carPoint(T.car, lead ? 0 : 1.2, -T.car.half - back, this._pt ||= {});
      tx = P.x; tz = P.z;
      const gap = hyp(u.x, u.z, P.x, P.z);
      vt = clamp(T.sp + gap * 0.8, 0, TUNING.vRoad);
      if (gap < 2) vt = Math.min(vt, T.sp);
    }
    else if (W.fleeing && d < 70) { // (just rammed you: dropping back a moment before the next one)
      const P = this.carPoint(T.car, 0, -T.car.half - 9, this._pt ||= {});
      tx = P.x; tz = P.z; vt = Math.max(0, T.sp - 2);
    }
    u.ramCool = Math.max(0, (u.ramCool || 0) - dt);
    u.ram = ram;
    this.step(u, dt, tx, tz, vt);
  }

  // ---------------------------------------------------------------- driving a patrol car
  // to (tx, tz) at up to vt: along the road graph while far, straight there when close / off the roads; steering round
  // colliders and trees; stuck: backs up and turns
  step(u, dt, tx, tz, vt, face = null) {
    const d = hyp(u.x, u.z, tx, tz);
    let ax = tx, az = tz, onRoad = false;
    if (d > 90 && busRoads.roads.length) {
      u.repath -= dt;
      if (!u.path || u.repath <= 0) {
        u.repath = 2.5; u.path = null;
        const a = roadNearest(u.x, u.z), b = roadNearest(tx, tz);
        if (a.i >= 0 && b.i >= 0 && a.d < 35 && b.d < 80 && a.i !== b.i) { const ids = roadShortest(a.i, b.i); if (ids?.length > 1) { u.path = keepRight(ids); u.pi = 0; } }
      }
      if (u.path) {
        const P = u.path, look = 9 + Math.abs(u.v) * 0.55;
        while (u.pi < P.length - 1 && hyp(u.x, u.z, P[u.pi].x, P[u.pi].z) < look) u.pi++;
        if (u.pi < P.length - 1) { ax = P[u.pi].x; az = P[u.pi].z; onRoad = true; } else u.path = null;
      }
    } else u.path = null;
    let want = Math.atan2(ax - u.x, az - u.z);
    if (d < 0.6 && face !== null) want = face;
    // round what's in the way (probed a few times a second)
    if ((u.probeT -= dt) <= 0) { u.probeT = 0.15; this.probe(u, want, vt); }
    want += u.avoid.turn;
    let v = Math.min(vt, u.avoid.vmax, onRoad ? TUNING.vRoad : TUNING.vOff + (u.ram ? 6 : 0));
    const err = wrapPi(want - u.yaw);
    if (u.rev > 0) {
      u.rev -= dt;
      u.steer += clamp(u.revSteer - u.steer, -3 * dt, 3 * dt);
      u.v += clamp(-5 - u.v, -8 * dt, 6 * dt);
    } else {
      // behind it and close: a tight turn at a crawl
      if (Math.abs(err) > 2.2 && d < 12) v = Math.min(v, 3);
      v *= 1 - Math.min(0.72, Math.abs(err) * (u.v > 10 ? 0.75 : 0.35));
      if (d < 0.6) v = 0;
      const st = clamp(err * 1.9, -0.6, 0.6);
      u.steer += clamp(st - u.steer, -2.6 * dt, 2.6 * dt);
      u.v += clamp(v - u.v, -11 * dt, 6.5 * dt);
      // stuck (wants to go, not moving): back up, wheels the other way
      if (v > 2 && Math.abs(u.v) < 1.1) { if ((u.stuck += dt) > 1.4) { u.stuck = 0; u.rev = 1.3; u.revSteer = -Math.sign(err || 1) * 0.6; } } else u.stuck = 0;
    }
    u.yaw = wrapPi(u.yaw + (u.v / WB) * Math.tan(u.steer) * dt);
    u.x += Math.sin(u.yaw) * u.v * dt; u.z += Math.cos(u.yaw) * u.v * dt;
    this.pushOut(u);
    this.place(u);
  }
  // something solid at (x, z) within r? (buildings, rocks, poles, parked cars, other players' cars; trees)
  solidAt(x, z, r, u) {
    // your car: steered round unless they mean to ram it
    const d = this.drive?.d;
    if (d && !u.ram && Math.abs(d.x - x) < 4 + r && Math.abs(d.z - z) < 4 + r) {
      const s = Math.sin(d.yaw), c = Math.cos(d.yaw), lx = (x - d.x) * c - (z - d.z) * s, lz = (x - d.x) * s + (z - d.z) * c;
      if (Math.abs(lx) < d.w / 2 + r && Math.abs(lz) < d.half + r) return (this._yc ||= { x: 0, z: 0, hw: 0, hd: 0, rot: 0 }, Object.assign(this._yc, { x: d.x, z: d.z, hw: d.w / 2, hd: d.half, rot: -d.yaw }));
    }
    for (const c of this.colliders || []) {
      if (c === u.col || c.soft || c.net || c.rail || c.police === 'local' || c === this.drive?.d?.e?.collider) continue;
      const size = c.r ?? Math.max(c.hw, c.hd);
      if (Math.abs(c.x - x) > size + r || Math.abs(c.z - z) > size + r) continue;
      if (c.r !== undefined) { if (Math.hypot(x - c.x, z - c.z) < c.r + r) return c; continue; }
      const cs = Math.cos(-c.rot), sn = Math.sin(-c.rot), lx = (x - c.x) * cs - (z - c.z) * sn, lz = (x - c.x) * sn + (z - c.z) * cs;
      if (Math.abs(lx) < c.hw + r && Math.abs(lz) < c.hd + r) return c;
    }
    const t = this.vegetation?.collide?.(x, z, r, 0.6, true);
    return t ? { x: t.x, z: t.z, r: t.trunk ?? t.r ?? 0.4 } : null;
  }
  probe(u, want, vt) {
    const L = clamp(Math.abs(u.v) * 0.9, 6, 22), A = u.avoid;
    A.turn = 0; A.vmax = 99;
    const free = (a) => {
      const s = Math.sin(want + a), c = Math.cos(want + a);
      for (const f of [0.5, 1]) if (this.solidAt(u.x + s * L * f, u.z + c * L * f, u.hw + 0.2, u)) return false;
      return true;
    };
    if (vt < 1 || free(0)) return;
    for (const a of [0.35, -0.35, 0.7, -0.7, 1.1, -1.1]) if (free(a)) { A.turn = a; A.vmax = Math.max(5, vt * (1 - Math.abs(a) * 0.5)); return; }
    A.vmax = 4;
  }
  // out of whatever it ran into (three circles along it), a scrape of speed
  pushOut(u) {
    const s = Math.sin(u.yaw), c = Math.cos(u.yaw), R = u.hw;
    let hit = false;
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
        hit = true;
      }
    }
    if (hit) u.v *= 0.92;
  }

  // ---------------------------------------------------------------- contacts: you, the traffic, the other players
  hits(dt) {
    const d = this.drive?.d, W = this.w;
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
        // their ram: real damage (drive.js knock / crash), a spin from where it hit
        const eff = closing * TUNING.ramMult;
        const side = (d.x - u.x) * Math.cos(d.yaw) - (d.z - u.z) * Math.sin(d.yaw);
        d.yawRate = clamp((d.yawRate || 0) + Math.sign(side || 1) * Math.min(1.4, closing * 0.09), -2.5, 2.5);
        const e = d.e;
        if (eff > CRASH_V && this.drive.canCrash()) this.drive.crash(eff, nx, nz, 'car');
        else if (eff > KNOCK_V) this.drive.knock(eff, nx, nz);
        if (this.drive.d?.crash) { e.policeWreck = true; this.wreckE = e; } // (wrecked by the police: not repaired, carrental.js)
        u.v *= 0.5; u.ramCool = TUNING.ramGapS;
      } else if (closing > KNOCK_V && yours > KNOCK_V * 0.6) {
        // you drove into them: your knock, and (not fleeing yet) now you are
        this.drive.knock(closing, nx, nz);
        if (W && !W.fleeing && closing * 3.6 >= TUNING.triggerKmh) this.flee(W);
      }
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
    const off = T.car ? T.sp > 4.5 : T.foot && S.kind === 'fine' && T.sp > 2.6 && S.step !== 'pull';
    if (off && (S.step === 'pull' || S.step === 'walk' || (S.step === 'talk' && !S.said))) {
      this.flee(W);
      if (u.officer) { S.step = 'back'; S.abort = true; } else { W.scene = null; return; }
    }
    if (S.step === 'pull') {
      // pull up: behind your car (8 m), or ~8 m short of you on foot
      let px, pz, face = null;
      if (T.car) { const P = this.carPoint(T.car, 0.3, -T.car.half - 7.5, this._pt ||= {}); px = P.x; pz = P.z; face = T.car.yaw; }
      else { const d = hyp(u.x, u.z, T.x, T.z), k = d > 0.1 ? Math.max(0, d - 8) / d : 0; px = u.x + (T.x - u.x) * k; pz = u.z + (T.z - u.z) * k; }
      const g = hyp(u.x, u.z, px, pz);
      this.step(u, dt, px, pz, clamp(g * 0.9, 0, 16), face);
      if ((g < 2.2 && Math.abs(u.v) < 1) || (S.t > 14 && Math.abs(u.v) < 1.5) || (T.foot && hyp(u.x, u.z, T.x, T.z) < 14 && Math.abs(u.v) < 6)) { u.v = 0; S.step = 'walk'; S.t = 0; this.spawnOfficer(u); }
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
      else if (!T.car && S.kind === 'arrest' && hyp(o.pos.x, o.pos.z, u.x, u.z) > 45) { S.step = 'back'; S.abort = true; }
      return;
    }
    if (S.step === 'talk') {
      const face = Math.atan2(T.x - o.pos.x, T.z - o.pos.z);
      o.st.mode = 'idle'; o.st.speed = 0;
      this.poseOfficer(o, dt, face);
      if (!S.said) {
        S.said = true;
        if (S.kind === 'fine') {
          this.say('Officer', 'License and registration, please... You caused a collision back there. That\'s a $500 fine.');
          this.charge(TUNING.fine);
        } else {
          this.say('Officer', S.why === 'wrecked' ? 'Stay right there! You are under arrest. That car is going nowhere. $2,000 and you\'re coming with us.'
            : T.car ? 'Out of the car! You are under arrest for fleeing the police. That\'s $2,000.' : 'Stop right there! You are under arrest for fleeing the police. That\'s $2,000.');
          this.charge(TUNING.arrestFine);
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
  note(text, s = 5) {
    if (!this.w) { this.hud?.flash?.(text, 'bad', s * 1000); return; }
    this.noteText = text; this.noteUntil = performance.now() + s * 1000;
  }
  // a fine off your money (single player: the save; multiplayer: the session's money guard sends it to the server as
  // a 'game' spend, which may take you into debt like any of the game's own charges)
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
      this.hud?.flash?.(`Arrested · -$${TUNING.arrestFine.toLocaleString('en-US')}`, 'bad', 4000);
    };
    if (this.transition?.fade) this.transition.fade(go); else go();
  }

  // ---------------------------------------------------------------- the end of a chase
  escaped() {
    this.hud?.flash?.('You escaped the police', 'good', 3600);
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
  hudFrame(paused) {
    const W = this.w;
    if (!W || paused) { this.setHud(false); return; }
    const S = W.scene;
    const msg = S ? (S.kind === 'fine' ? (S.step === 'back' || S.step === 'done' ? 'Fine paid' : 'Pulled over · stay in the car · $500 fine') : 'Under arrest')
      : W.fleeing ? 'Fleeing · they will ram you · stop to give up'
        : W.reached ? `Pull over now: stop to pay the $500 fine${W.grace > 0 ? ` (${Math.ceil(W.grace)})` : ''}` : 'Police! Stop to pay a $500 fine, or get away';
    const msg2 = this.noteUntil > performance.now() ? this.noteText : msg;
    const near = Number.isFinite(W.near) ? ` · police ${Math.round(W.near)} m` : '';
    const esc = S ? '' : `Escape ${mmss(W.esc)} / ${mmss(TUNING.escapeS)} · stay ${TUNING.escapeR} m+ away${near}`;
    let cars = 0; for (const u of this.units) if (u.on) cars++;
    this.setHud(true, mmss(W.t), msg2, esc, S ? 0 : W.esc / TUNING.escapeS, cars);
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
    net.send('veh', { k: 'police', cars: live.map((u) => [r(u.x), r(u.y), r(u.z), r(u.yaw), r(clamp(u.v, -60, 60))]) });
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
