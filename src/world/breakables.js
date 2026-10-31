// Little poles that a car knocks flying (Oct 30, the user: "make sure if you crash into little poles they detach and
// fly away but respawn back after 90 sec"; "also traffic signs"): the roads' snow poles and reflector posts, the
// speed-limit / warning signs and the roundabouts' give-way signs on their single posts, the piste markers, the car
// parks' and the police station's / medical centre's P signs, the bus stop signs, the medical centre's bollards.
//
// Each registers its collider here (add(collider, parts)): `collider.breakable` points back at it. A car (yours:
// drive.js, the snowmobile, and the traffic: update()) running into one faster than 8 km/h knocks it (knock()): the
// pole is hidden where it stood (its instance scaled to nothing, or the object hidden), its collider parked away
// (x, z = 1e9: no longer in anything's way), and a copy of it flies off the car's bumper: a simple rigid-body arc
// (the car's velocity + an upward kick, a spin), a bounce or two on the snow, then it lies down flat. The car only
// loses a little speed (a clack, no crash). After 90 s, once you are 25 m away or not looking that way (or after
// 2 more minutes, with a quick grow-in), it stands where it was again: the copy gone, instance / object and collider
// back. On foot or on skis nothing breaks (the collider stays as it was: the player's collisions never knock).
// Multiplayer (Oct 30, the user: "also for other people the guard rails don't break"): your own knocks (not the
// traffic's) go to the server ('brk' { k: 'pole' | 'rail', id, v }: id the pole's / the rail line's spot rounded to
// 10 cm, the same on every client; v the flight's start velocity), at most 10 a second; everyone else in the world
// knocks the same pole / breaks the same section (the same flight, nobody charged), and a player joining within the
// 90 s gets them already down (session.js: remote(), remoteList()). Single player: nothing sent. Cheap: a 16 m grid for the traffic's lookups, at most 30
// knocked at a time (the oldest stands up again early), no allocation per frame (a copy is built once per pole, on
// its first knock, and kept for the next).
import * as THREE from 'three';
import { world } from './world.js';
import { busRoads } from '../game/bus/roads.js'; // (the guardrails' line colliders: a section another player broke)

export const BREAK_V = 8 / 3.6; // m/s: slower than this a pole is just a bump
// (Oct 31 2026: an AI car through a guardrail: your car's rule, drive.js RAIL_BREAK_V / RAIL_BREAK_SIN: over 100 km/h
// and into it at 15 deg or more; aiRail)
export const AI_RAIL_V = 100 / 3.6, AI_RAIL_SIN = Math.sin(15 * Math.PI / 180);
// (Oct 31 2026, the user: "make sure you break these lamps after 100 kph, and they respawn after 90 sec": the street
// lamps (the Meshy lamp post: the village plaza, the Chaletweg, the car parks) are breakables of the 'lamp' kind
// (add(.., { lamp: true })): only a car faster than LAMP_V snaps one off (e.minV; drive.js, sweep()); at 100 km/h or
// less its collider stays solid, today's knock / crash. Down: heavier than a pole (a lower, slower arc, less spin),
// the lantern's glass shatters (a tinkle), its light pool off (e.light.out: world/pistelights.js), back with it after
// the same 90 s out of view; synced as a 'pole' ('brk': the server knows 'pole' | 'rail', the id its spot))
export const LAMP_V = 100 / 3.6;
const RESPAWN = 90;             // s
const GROW_AFTER = 120;         // s past RESPAWN: still in view and near, it grows back in anyway
const NEAR = 25;                // m: closer than this (and in view) it waits
const MAX_DOWN = 30;
const CELL = 16;
const GRAVITY = 9.81;

const _m = new THREE.Matrix4(), _w = new THREE.Matrix4(), _inv = new THREE.Matrix4(), _v = new THREE.Vector3(), _a = new THREE.Vector3();
const _q = new THREE.Quaternion(), _qd = new THREE.Quaternion(), _up = new THREE.Vector3(0, 1, 0), _h = new THREE.Vector3();
const _fr = new THREE.Frustum(), _pm = new THREE.Matrix4(), _sph = new THREE.Sphere(), _c = new THREE.Color();
const IDENT = new THREE.Matrix4();
const ground = (x, z) => (world.meshHeight ? world.meshHeight(x, z) : world.height(x, z));
const NET_HZ = 10;              // knocks sent a second at most (the server's limit too)
// (a spot's id: x, z rounded to 10 cm; ids are looked up with their neighbours too, against a rounding edge)
const spotId = (x, z) => `${Math.round(x * 10)},${Math.round(z * 10)}`;
// distance from (x, z) to a guardrail line { ax, az, bx, bz }
const segDist = (x, z, L) => { const ex = L.bx - L.ax, ez = L.bz - L.az, t = Math.max(0, Math.min(1, ((x - L.ax) * ex + (z - L.az) * ez) / (ex * ex + ez * ez || 1))); return Math.hypot(x - L.ax - ex * t, z - L.az - ez * t); };

// an instance's own copy of an instanced geometry: the shared attributes, its own entries of the per-instance ones
function sliceGeometry(src, k) {
  const g = new THREE.BufferGeometry();
  for (const [name, a] of Object.entries(src.attributes)) {
    if (a.isInstancedBufferAttribute) {
      const n = a.itemSize;
      g.setAttribute(name, new THREE.InstancedBufferAttribute(a.array.slice(k * n, k * n + n), n, a.normalized));
    } else g.setAttribute(name, a);
  }
  if (src.index) g.setIndex(src.index);
  for (const gr of src.groups) g.addGroup(gr.start, gr.count, gr.materialIndex);
  if (!src.boundingSphere) src.computeBoundingSphere();
  g.boundingSphere = src.boundingSphere.clone();
  g.boundingBox = src.boundingBox?.clone() ?? null;
  return g;
}

class Breakables {
  constructor() {
    this.list = [];
    this.grid = new Map();
    this.down = [];
    this.scene = null; this.audio = null; this.camera = null;
    this.stamp = 0;
    this.send = null;   // multiplayer (session.js): (msg) => sent to the server; null in single player
    this.quiet = false; // (knocks that are not yours to send: the traffic's, another player's)
    this.netTok = NET_HZ; this.netT = 0;
    this.byId = null; this.byIdN = -1; this.railIds = null; this.railsOf = null; this.railsN = -1;
  }

  /** main.js: where the knocked copies go, the clack, the camera (respawning out of view). */
  init({ scene, audio = null, camera = null }) { Object.assign(this, { scene, audio, camera }); }

  /**
   * Register a breakable pole. collider: its entry in the shared colliders ({x, z, r} or a box); parts: what is drawn,
   * each [instancedMesh, index] or an Object3D (kept out of merges and of world/solidify.js from now on).
   * o.h: its height (m); o.kind: the impact sound ('metal'); o.loud: 0..1 how loud its clack is.
   */
  add(collider, parts, { h = collider?.h ?? 1.5, kind = 'metal', loud = 0.5, lamp = false, light = null } = {}) {
    if (!collider || !parts?.length || !Number.isFinite(collider.x)) return null;
    const e = {
      c: collider, h, kind, loud, down: false, t: 0, grow: -1, x: collider.x, z: collider.z, copy: null, stamp: 0,
      parts: parts.map((p) => (Array.isArray(p) ? { im: p[0], k: p[1], m0: new Float32Array(16) } : { obj: p, s0: new THREE.Vector3() })),
      p: new THREE.Vector3(), v: new THREE.Vector3(), w: new THREE.Vector3(), base: 0, rest: 0, bounces: 0,
      nk: 'pole', nid: spotId(collider.x, collider.z),
      lamp, minV: lamp ? LAMP_V : BREAK_V, light, // (a street lamp: only over 100 km/h; its light pool, off while down)
    };
    for (const p of e.parts) if (p.obj) { p.obj.userData.noMerge = true; p.obj.userData.noCollide = true; }
    else if (p.im) p.im.userData.noCollide = true; // (no solid box from world/solidify.js round it: it would stop the car short, a knock with damage)
    collider.breakable = e;
    this.list.push(e);
    const key = Math.floor(e.x / CELL) * 100003 + Math.floor(e.z / CELL);
    let cell = this.grid.get(key);
    if (!cell) this.grid.set(key, (cell = []));
    cell.push(e);
    return e;
  }

  /**
   * Instanced poles whose thin colliders (pole: true) were made elsewhere (the piste markers): each instance of
   * ims[0] matched to the collider standing on its spot; every mesh of ims shares the instance index. -> how many
   */
  adoptInstances(ims, colliders, o = {}) {
    ims = (ims || []).filter((m) => m?.isInstancedMesh);
    if (!ims.length || !colliders?.length) return 0;
    const key = (x, z) => Math.round(x * 4) * 1000003 + Math.round(z * 4);
    const at = new Map();
    for (const c of colliders) if (c?.pole && c.r !== undefined && !c.breakable && Number.isFinite(c.x)) at.set(key(c.x, c.z), c);
    const first = ims[0];
    first.updateWorldMatrix(true, false);
    let n = 0;
    for (let k = 0; k < first.count; k++) {
      first.getMatrixAt(k, _m); _m.premultiply(first.matrixWorld);
      const c = at.get(key(_m.elements[12], _m.elements[14]));
      if (c && this.add(c, ims.map((m) => [m, k]), o)) n++;
    }
    for (const m of ims) m.userData.noCollide = true;
    return n;
  }

  /**
   * A guardrail broken through (Oct 30, the user: "if you go faster than 100 km/h and then collide into the safety
   * barriers you break through them"; drive.js railHit): rails: busRoads.rails (the car's line colliders; bus.js
   * links each to its drawn 4 m section, `seg`), k: the line hit, (x, z): where, (vx, vz): the car. That section and
   * its neighbour nearer the impact (~8 m) break: their lines off (line.off), the thin boxes along them parked away,
   * their instances hidden, and a bent beam with a post torn off each flies and tumbles like a pole; back after 90 s
   * like the poles. -> true if anything broke (false: not a drawn guardrail, or already broken there)
   */
  breakRail(rails, k, x, z, vx, vz) {
    const L = rails?.[k];
    if (!L?.seg || L.off || !this.scene) return false;
    // (Oct 30 2026, the user: "make sure the breaking guardrails above 100 kph works for all cars, everywhere, always,
    // because right now I don't think it does": the neighbour that broke with it was the one nearer the car's middle;
    // hit near a section's far end at an angle, the middle was still behind it, so the section behind broke and the car
    // ran on into the one ahead, still standing, and bounced back. Now the one ahead along the rail, the way the car is
    // going (and the one behind too when the car's middle is within 1.2 m of that joint); drive.js breaks whatever
    // else of the run the car's body sweeps through (railHit, d.thru))
    const ex = L.bx - L.ax, ez = L.bz - L.az, len = Math.hypot(ex, ez) || 1, t = ((x - L.ax) * ex + (z - L.az) * ez) / (len * len);
    const fwd = vx * ex + vz * ez >= 0;
    const at = (q, end) => { const o = rails[q]; return o?.seg && !o.off && (end ? Math.hypot(o.ax - L.bx, o.az - L.bz) : Math.hypot(o.bx - L.ax, o.bz - L.az)) < 0.05 ? o : null; }; // (a section joined at L's end (1) / start (0))
    const lines = [L], ahead = fwd ? at(k + 1, 1) : at(k - 1, 0), behind = fwd ? (t * len < 1.2 ? at(k - 1, 0) : null) : ((1 - t) * len < 1.2 ? at(k + 1, 1) : null);
    if (ahead) lines.push(ahead);
    if (behind) lines.push(behind);
    let n = 0;
    for (const line of lines) {
      const e = this.railOf(line);
      if (e && this.knock(e, vx * 0.7 + (Math.random() - 0.5) * 2, vz * 0.7 + (Math.random() - 0.5) * 2)) n++;
    }
    return n > 0;
  }

  /**
   * (Oct 31 2026, the user: "Traffic and police cars only bounce off guardrails. Only your car breaks through: make
   * them break through too"): your car's rule (drive.js railHit) for an AI car (traffic.js slide, police.js pushOut /
   * knockStep). (x, z): one of its body circles (radius r), (vx, vz): its velocity, car: its own state (car.thru: where
   * it last broke through, as drive.js d.thru). The drawn, standing guardrail line that circle touches deepest: over
   * AI_RAIL_V and into it at AI_RAIL_SIN or more (the line's own normal, from the car's side): it breaks (breakRail:
   * the follow-through the way the car goes); once through, every section that car touches within 12 m of there in
   * the next 1.5 s, still faster than 30 km/h, breaks too (it carries on through the gap). Below that, or a scrape
   * along it: nothing (the caller bounces it off as before). Not quiet: synced to the others ('brk') as yours.
   * -> 0 nothing broke, else the speed into the rail (m/s; the follow-through: 0.01). Cheap: the 16 m rail grid
   * (bus.js railGrid), no allocation
   */
  aiRail(car, x, z, r, vx, vz) {
    const RG = busRoads.railGrid, rails = busRoads.rails;
    if (!RG?.size || !rails || !this.scene || !car) return 0;
    const sp = Math.hypot(vx, vz), now = performance.now() / 1000, T = car.thru;
    const follow = !!T && now - T.t < 1.5 && Math.hypot(x - T.x, z - T.z) < 12 && sp > 30 / 3.6;
    if (!follow && sp <= AI_RAIL_V) return 0;
    let k = -1, best = 0;
    for (let gx = Math.floor((x - r - 1) / 16); gx <= Math.floor((x + r + 1) / 16); gx++) for (let gz = Math.floor((z - r - 1) / 16); gz <= Math.floor((z + r + 1) / 16); gz++) {
      const cell = RG.get(gx * 100003 + gz);
      if (cell) for (const q of cell) { const L = rails[q]; if (!L?.seg || L.off) continue; const o = r + 0.15 - segDist(x, z, L); if (o > best) { best = o; k = q; } }
    }
    if (k < 0) return 0;
    let into = 0.01;
    if (!follow) {
      const L = rails[k], ex = L.bx - L.ax, ez = L.bz - L.az, el = Math.hypot(ex, ez) || 1;
      let nx = -ez / el, nz = ex / el; // (the line's normal, turned to the car's side of it)
      if ((x - L.ax) * nx + (z - L.az) * nz < 0) { nx = -nx; nz = -nz; }
      into = -(vx * nx + vz * nz);
      if (into < sp * AI_RAIL_SIN) return 0; // (a scrape along it)
    }
    if (!this.breakRail(rails, k, x, z, vx, vz)) return 0;
    if (!follow) {
      car.thru = { x, z, t: now };
      // (the crash of it, quieter far from the camera: the rail's own pieces fly silent, loud 0)
      const cam = this.camera?.position, d = cam ? Math.hypot(cam.x - x, cam.z - z) : 0, amt = 0.95 * Math.max(0, 1 - d / 140);
      if (amt > 0.03) try { this.audio?.impact?.('metal', amt); } catch { /* (silent) */ }
    }
    return into;
  }

  // a guardrail line's breakable entry (made on first use), with its network id (the line's middle)
  railOf(line) {
    const e = line.brk || (line.brk = this.railEntry(line));
    if (e && !e.nk) { e.nk = 'rail'; e.nid = spotId((line.ax + line.bx) / 2, (line.az + line.bz) / 2); }
    return e;
  }

  // the breakable entry of one guardrail line (its drawn section: seg.ims at seg.k)
  railEntry(line) {
    const s = line.seg, a = s.a, b = s.b;
    if (!s.ims?.length) return null;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) || 4;
    const cy = (a[1] - a[3] + b[1] - b[3]) / 2 + 0.53;
    _a.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize();
    const e = {
      c: { x: (a[0] + b[0]) / 2, z: (a[2] + b[2]) / 2 }, h: len, kind: 'metal', loud: 0, down: false, t: 0, grow: -1, copy: null, parts: [],
      x: (a[0] + b[0]) / 2, z: (a[2] + b[2]) / 2, cy, base: cy - len / 2, q0: new THREE.Quaternion().setFromUnitVectors(_up, _a), line,
      p: new THREE.Vector3(), v: new THREE.Vector3(), w: new THREE.Vector3(), rest: 0, bounces: 0, boxes: [],
      make: () => this.railPiece(len),
      hide: () => {
        line.off = true;
        for (const im of s.ims) { im.instanceMatrix.array.fill(0, s.k * 16, s.k * 16 + 16); im.instanceMatrix.needsUpdate = true; }
        // (a thin box can span several sections: parked while any of them is down, back only when the last one
        // stands again; before, the first section back put the box up across a neighbour still broken through: an
        // invisible wall in the gap)
        e.boxes.length = 0;
        for (const c of s.boxes || []) { if (!c.railDown) { c.x0 = c.x; c.z0 = c.z; c.x = 1e9; c.z = 1e9; } c.railDown = (c.railDown || 0) + 1; e.boxes.push(c); }
      },
      show: () => {
        line.off = false;
        for (const im of s.ims) { _m.identity().toArray(im.instanceMatrix.array, s.k * 16); im.instanceMatrix.needsUpdate = true; }
        for (const c of e.boxes) if (--c.railDown <= 0) { c.railDown = 0; c.x = c.x0; c.z = c.z0; }
        e.boxes.length = 0;
      },
    };
    return e;
  }

  // a torn-off piece of guardrail: the beam bent in the middle (along local y), a post still bolted on
  railPiece(len) {
    if (!this.railMat) {
      this.railMat = new THREE.MeshStandardMaterial({ color: 0xd9dee3, metalness: 0.7, roughness: 0.42 });
      this.postMat = new THREE.MeshStandardMaterial({ color: 0x9aa1a7, metalness: 0.6, roughness: 0.5 });
    }
    const g = new THREE.Group();
    g.name = 'broken-guardrail'; g.userData.noMerge = true; g.userData.noCollide = true;
    const half = new THREE.BoxGeometry(0.05, len / 2, 0.31);
    for (const sd of [-1, 1]) {
      const m = new THREE.Mesh(half, this.railMat);
      m.position.set(0.12, sd * len * 0.24, 0); m.rotation.z = sd * 0.22; // (kinked where the car hit it)
      m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false;
      g.add(m);
    }
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.1, 0.95), this.postMat);
    post.position.set(0.05, len * 0.22, 0.42); post.rotation.x = 0.3;
    post.castShadow = true; post.frustumCulled = false;
    g.add(post);
    return g;
  }

  /** A breakable pole registered within r of (x, z) (standing or knocked)? (drive.js: a solid box some audit put round one is ignored) */
  at(x, z, r = 0.6) {
    const cell = this.grid.get(Math.floor(x / CELL) * 100003 + Math.floor(z / CELL));
    if (cell) for (const e of cell) if ((e.x - x) ** 2 + (e.z - z) ** 2 < r * r) return e;
    for (let gx = Math.floor((x - r) / CELL); gx <= Math.floor((x + r) / CELL); gx++) for (let gz = Math.floor((z - r) / CELL); gz <= Math.floor((z + r) / CELL); gz++) {
      const c2 = this.grid.get(gx * 100003 + gz);
      if (c2 && c2 !== cell) for (const e of c2) if ((e.x - x) ** 2 + (e.z - z) ** 2 < r * r) return e;
    }
    return null;
  }

  /** A vehicle at (x, z) (reach r) moving (vx, vz): knocks the poles it touches. -> how many it knocked */
  sweep(x, z, r, vx, vz) {
    if (vx * vx + vz * vz < BREAK_V * BREAK_V) return 0;
    let n = 0;
    for (let gx = Math.floor((x - r - 1) / CELL); gx <= Math.floor((x + r + 1) / CELL); gx++) {
      for (let gz = Math.floor((z - r - 1) / CELL); gz <= Math.floor((z + r + 1) / CELL); gz++) {
        const cell = this.grid.get(gx * 100003 + gz);
        if (!cell) continue;
        for (let i = 0; i < cell.length; i++) {
          const e = cell[i];
          if (e.down || (e.minV > BREAK_V && vx * vx + vz * vz <= e.minV * e.minV)) continue; // (a street lamp: only over 100 km/h)
          const reach = r + (e.c.r ?? Math.max(e.c.hw || 0, e.c.hd || 0));
          const dx = e.x - x, dz = e.z - z;
          if (dx * dx + dz * dz < reach * reach && this.knock(e, vx, vz)) n++;
        }
      }
    }
    return n;
  }

  /** Knock pole e flying (a car moving (vx, vz); fv: the flight's start velocity, given: another player's knock). -> true if it was standing */
  knock(e, vx, vz, fv = null) {
    if (!e || e.down || !this.scene) return false;
    if (this.down.length >= MAX_DOWN) this.restore(this.down[0]);
    let copy;
    try { copy = e.copy || (e.copy = e.make ? e.make(e) : this.makeCopy(e)); } catch (err) { console.warn('breakables', err); return false; }
    if (!copy) return false;
    // hide it where it stood, its collider out of the way
    if (e.hide) e.hide(e);
    for (const p of e.parts) {
      if (p.im) {
        const arr = p.im.instanceMatrix.array;
        for (let i = 0; i < 16; i++) { p.m0[i] = arr[p.k * 16 + i]; arr[p.k * 16 + i] = 0; }
        p.im.instanceMatrix.needsUpdate = true;
      } else { p.s0.copy(p.obj.scale); p.obj.visible = false; }
    }
    e.c.x = 1e9; e.c.z = 1e9;
    if (e.light) e.light.out = true; // (a street lamp's pool of light: off while it lies in the snow)
    e.down = true; e.t = 0; e.grow = -1; e.rest = 0; e.bounces = 0;
    this.down.push(e);
    // the flight: off the bumper, a kick up, a tumble
    const sp = Math.hypot(vx, vz), k = Math.min(1, 16 / Math.max(sp, 1e-3)) * 1.05; // (never faster than ~17 m/s)
    e.p.set(e.x, e.cy ?? e.base + e.h * 0.5, e.z);
    if (fv) { e.v.set(fv[0], fv[1], fv[2]); vx = fv[0]; vz = fv[2]; }
    else if (e.lamp) e.v.set(vx * k * 0.7 + (Math.random() - 0.5), Math.min(3.2, 1 + sp * 0.07), vz * k * 0.7 + (Math.random() - 0.5)); // (a heavy cast-iron post: lower, shorter)
    else e.v.set(vx * k + (Math.random() - 0.5) * 1.5, Math.min(7, 2 + sp * 0.3), vz * k + (Math.random() - 0.5) * 1.5);
    _a.set(vz, 0, -vx).normalize();
    e.w.copy(_a).multiplyScalar((4 + Math.random() * 5) * (e.lamp ? 0.5 : 1));
    e.w.y += (Math.random() - 0.5) * (e.lamp ? 1.5 : 4);
    copy.position.copy(e.p); if (e.q0) copy.quaternion.copy(e.q0); else copy.quaternion.identity(); copy.scale.setScalar(1);
    this.scene.add(copy);
    // the clack (quieter far from the camera: the traffic's)
    if (this.audio?.impact) {
      const cam = this.camera?.position, d = cam ? Math.hypot(cam.x - e.x, cam.z - e.z) : 0;
      const amt = e.loud * Math.min(1, 0.35 + sp / 25) * Math.max(0, 1 - d / 80);
      if (amt > 0.03 && !this.silent) try { this.audio.impact(e.kind, amt); } catch { /* (silent) */ }
      // (a street lamp: its lantern's glass shattering, a tinkle just after the clang)
      if (e.lamp && amt > 0.03 && !this.silent) try { this.audio.shot?.('glass', { sprite: true, vol: 0.3 + 0.5 * amt, rate: 1.1 + Math.random() * 0.2, delay: 0.04 }); } catch { /* (silent) */ }
    }
    if (this.send && !this.quiet && e.nk) this.emit(e);
    return true;
  }

  // ---------------------------------------------------------------- multiplayer
  // your knock to the server (at most NET_HZ a second: the rest stay yours alone)
  emit(e) {
    const now = performance.now() / 1000;
    this.netTok = Math.min(NET_HZ, this.netTok + (now - this.netT) * NET_HZ); this.netT = now;
    if (this.netTok < 1) return;
    this.netTok--;
    const r = (n) => Math.round(n * 100) / 100;
    try { this.send({ k: e.nk, id: e.nid, v: [r(e.v.x), r(e.v.y), r(e.v.z)] }); } catch { /* (offline: yours alone) */ }
  }

  // the entry another player's knock names (k 'pole' | 'rail', id a spot), or null
  lookup(k, id) {
    const m = /^(-?\d+),(-?\d+)$/.exec(String(id));
    if (!m) return null;
    let map;
    if (k === 'rail') {
      const rails = busRoads.rails;
      if (!rails?.length) return null;
      if (this.railsOf !== rails || this.railsN !== rails.length) {
        this.railsOf = rails; this.railsN = rails.length; this.railIds = new Map();
        for (const L of rails) if (L?.seg) { const sid = spotId((L.ax + L.bx) / 2, (L.az + L.bz) / 2); if (!this.railIds.has(sid)) this.railIds.set(sid, L); }
      }
      map = this.railIds;
    } else {
      if (this.byIdN !== this.list.length) {
        this.byIdN = this.list.length; this.byId = new Map();
        for (const e of this.list) if (!this.byId.has(e.nid)) this.byId.set(e.nid, e);
      }
      map = this.byId;
    }
    const x = +m[1], z = +m[2];
    let hit = map.get(`${x},${z}`);
    for (let i = 0; i < 9 && !hit; i++) hit = map.get(`${x + (i % 3) - 1},${z + Math.floor(i / 3) - 1}`);
    return hit ? (k === 'rail' ? this.railOf(hit) : hit) : null;
  }

  /**
   * Another player knocked a pole / broke a guardrail section (session.js, the server's 'brk' { k, id, v }): the same
   * one knocked here, the same flight, nobody charged. age: ms since (a joiner's list): the flight played forward, the
   * 90 s counted from then. Already down here: nothing. -> true if it was knocked
   */
  remote(d, age = 0) {
    if (!d || !this.scene || !Array.isArray(d.v) || d.v.length !== 3 || !d.v.every(Number.isFinite)) return false;
    age = Math.max(0, +age || 0) / 1000;
    if (age >= RESPAWN) return false;
    const e = this.lookup(d.k, d.id);
    if (!e || e.down) return false;
    this.quiet = true; this.silent = age > 0.5;
    let ok = false;
    try { ok = this.knock(e, d.v[0], d.v[2], d.v); } finally { this.quiet = false; this.silent = false; }
    if (ok && age > 0) {
      // (knocked a while ago: where it flew to by now)
      for (let t = 0; t < Math.min(age, 8) && e.rest < 2; t += 1 / 30) { e.t = t; this.fly(e, 1 / 30); }
      e.t = age;
    }
    return ok;
  }

  /** The world's knocks of the last 90 s (session.js: the world snapshot's brk [{ k, id, v, age }]). */
  remoteList(list) {
    if (!Array.isArray(list)) return;
    for (const d of list) try { this.remote(d, d?.age || 0); } catch (err) { console.warn('breakables', err); }
  }

  // the flying copy of e: a group at its middle, each part as drawn (an instance: its own one-instance mesh, sharing
  // the geometry and material; an object: its meshes)
  makeCopy(e) {
    const g = new THREE.Group();
    g.name = 'knocked-pole';
    g.userData.noMerge = true; g.userData.noCollide = true;
    let base = Infinity;
    const W = [];
    for (const p of e.parts) {
      if (p.im) {
        p.im.updateWorldMatrix(true, false);
        p.im.getMatrixAt(p.k, _m);
        const m = new THREE.Matrix4().multiplyMatrices(p.im.matrixWorld, _m);
        W.push(m);
        base = Math.min(base, m.elements[13]);
      } else {
        p.obj.updateWorldMatrix(true, true);
        W.push(null);
        base = Math.min(base, p.obj.matrixWorld.elements[13]);
      }
    }
    if (!Number.isFinite(base)) base = ground(e.x, e.z);
    e.base = Math.max(base, ground(e.x, e.z) - 0.4);
    _inv.makeTranslation(-e.x, -(e.base + e.h * 0.5), -e.z);
    e.parts.forEach((p, i) => {
      if (p.im) {
        const m = new THREE.InstancedMesh(sliceGeometry(p.im.geometry, p.k), p.im.material, 1);
        m.setMatrixAt(0, IDENT);
        if (p.im.instanceColor) { p.im.getColorAt(p.k, _c); m.setColorAt(0, _c); }
        m.matrixAutoUpdate = false; m.matrix.multiplyMatrices(_inv, W[i]);
        m.castShadow = p.im.castShadow; m.receiveShadow = p.im.receiveShadow;
        m.frustumCulled = false;
        g.add(m);
      } else {
        p.obj.traverse((o) => {
          if (!o.isMesh || o.isSkinnedMesh || !o.visible) return;
          const m = o.isInstancedMesh ? null : new THREE.Mesh(o.geometry, o.material);
          if (!m) return;
          m.matrixAutoUpdate = false; m.matrix.multiplyMatrices(_inv, o.matrixWorld);
          m.castShadow = o.castShadow; m.receiveShadow = o.receiveShadow;
          m.frustumCulled = false;
          g.add(m);
        });
      }
    });
    return g.children.length ? g : null;
  }

  // stands up again where it was
  restore(e) {
    if (!e.down) return;
    if (e.show) e.show(e);
    for (const p of e.parts) {
      if (p.im) {
        p.im.instanceMatrix.array.set(p.m0, p.k * 16);
        p.im.instanceMatrix.needsUpdate = true;
      } else { p.obj.scale.copy(p.s0); p.obj.visible = true; }
    }
    e.c.x = e.x; e.c.z = e.z;
    if (e.light) e.light.out = false; // (the street lamp's light back on with it)
    e.down = false; e.grow = -1;
    if (e.copy?.parent) e.copy.parent.remove(e.copy);
    const i = this.down.indexOf(e);
    if (i >= 0) this.down.splice(i, 1);
  }

  // growing back in view: its parts scaled g (0..1) about their own origins
  growTo(e, g) {
    for (const p of e.parts) {
      if (p.im) {
        const arr = p.im.instanceMatrix.array, o = p.k * 16;
        for (let i = 0; i < 12; i++) arr[o + i] = p.m0[i] * g;
        for (let i = 12; i < 16; i++) arr[o + i] = p.m0[i];
        p.im.instanceMatrix.needsUpdate = true;
      } else { p.obj.visible = true; p.obj.scale.copy(p.s0).multiplyScalar(Math.max(1e-3, g)); }
    }
  }

  /**
   * Every frame (main.js): the flights, the respawns, the traffic's knocks.
   * pos: the player (no pole stands up into you); cars: the traffic's cars ({x, z, yaw, v, mode}).
   */
  update(dt, pos = null, cars = null) {
    if (!(dt > 0)) return;
    if (cars) {
      for (let i = 0; i < cars.length; i++) {
        const c = cars[i];
        if (!c || !(Math.abs(c.v) > BREAK_V) || c.mode === 'parked' || c.mode === 'gone' || !Number.isFinite(c.x)) continue;
        const fx = Math.sin(c.yaw || 0), fz = Math.cos(c.yaw || 0), vx = fx * c.v, vz = fz * c.v;
        this.quiet = true; // (the traffic is each player's own: its knocks stay local)
        try {
          this.sweep(c.x + fx * 1.4, c.z + fz * 1.4, 1.0, vx, vz);
          this.sweep(c.x - fx * 1.4, c.z - fz * 1.4, 1.0, vx, vz);
        } finally { this.quiet = false; }
      }
    }
    if (!this.down.length) return;
    let frustum = false;
    for (let i = this.down.length - 1; i >= 0; i--) {
      const e = this.down[i];
      if (!e) continue;
      e.t += dt;
      if (e.grow >= 0) { // growing back in
        e.grow = Math.min(1, e.grow + dt / 0.45);
        this.growTo(e, e.grow);
        if (e.grow >= 1) { e.grow = 0; this.restore(e); }
        continue;
      }
      if (e.t >= RESPAWN) {
        const cam = this.camera?.position;
        // (never up through you or your car; a guardrail section: 3.5 m clear of its whole length, Oct 30 2026: a car
        // standing in the gap more than 2.5 m from the section's middle could have the rail come back up through it)
        const clear = !pos || (e.line ? segDist(pos.x, pos.z, e.line) > 3.5 : Math.hypot(pos.x - e.x, pos.z - e.z) > 2.5);
        if (clear) {
          const far = !cam || Math.hypot(cam.x - e.x, cam.z - e.z) > NEAR;
          let unseen = far;
          if (!far) {
            if (!frustum) { frustum = true; this.camera.updateMatrixWorld(); _pm.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse); _fr.setFromProjectionMatrix(_pm); }
            _sph.center.set(e.x, e.base + e.h * 0.5, e.z); _sph.radius = e.h * 0.6 + 0.3;
            unseen = !_fr.intersectsSphere(_sph);
          }
          if (unseen) { this.restore(e); continue; }
          if (e.t > RESPAWN + GROW_AFTER && e.show) { this.restore(e); continue; } // (a guardrail section: just back)
          if (e.t > RESPAWN + GROW_AFTER) { // (still right there in view: a quick grow-in)
            if (e.copy?.parent) e.copy.parent.remove(e.copy);
            e.c.x = e.x; e.c.z = e.z;
            e.grow = 0; this.growTo(e, 0);
            continue;
          }
        }
      }
      if (e.rest >= 2) continue; // (lying in the snow)
      this.fly(e, dt);
    }
  }

  // one step of a knocked pole's flight / settling
  fly(e, dt) {
    const copy = e.copy;
    if (!copy) return;
    _v.copy(_up).applyQuaternion(copy.quaternion);
    if (e.rest === 0) {
      // flying: gravity, the tumble, a bounce off the snow (its lower end)
      e.v.y -= GRAVITY * dt;
      e.p.addScaledVector(e.v, dt);
      const wl = e.w.length();
      if (wl > 1e-4) { _qd.setFromAxisAngle(_a.copy(e.w).divideScalar(wl), wl * dt); copy.quaternion.premultiply(_qd); }
      const gy = ground(e.p.x, e.p.z), low = e.p.y - Math.abs(_v.y) * e.h * 0.5 - 0.04;
      if (low < gy) {
        e.p.y += gy - low;
        if (e.v.y < 0) {
          e.bounces++;
          e.v.y = -e.v.y * 0.35; e.v.x *= 0.55; e.v.z *= 0.55; e.w.multiplyScalar(0.45);
          if (e.bounces >= 3 || e.v.y < 1.0) e.rest = 1;
        }
      }
      if (e.t > 6) e.rest = 1;
      if (e.rest === 1) { // lay it down: its long axis turned flat (keeping its roll)
        _h.set(_v.x, 0, _v.z);
        if (_h.lengthSq() < 1e-4) _h.set(e.v.x || 1, 0, e.v.z);
        _h.normalize();
        _qd.setFromUnitVectors(_v, _h);
        e.qT = (e.qT || new THREE.Quaternion()).copy(_qd).multiply(copy.quaternion);
      }
    } else {
      // settling: sliding to a stop, turning flat onto the snow
      const f = Math.min(1, dt * 6);
      e.v.x *= 1 - f * 0.6; e.v.z *= 1 - f * 0.6;
      e.p.x += e.v.x * dt; e.p.z += e.v.z * dt;
      copy.quaternion.slerp(e.qT, f);
      const gy = ground(e.p.x, e.p.z) + 0.05;
      e.p.y += (gy - e.p.y) * f;
      if (copy.quaternion.angleTo(e.qT) < 0.01 && Math.abs(gy - e.p.y) < 0.01) { copy.quaternion.copy(e.qT); e.p.y = gy; e.rest = 2; }
    }
    copy.position.copy(e.p);
  }
}

export const breakables = new Breakables();
