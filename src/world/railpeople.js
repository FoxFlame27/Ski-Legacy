// People at the Wolkenspitzbahn's stations. They live by the timetable: between trains passengers drift onto
// the platform (out of the station building or along the platform from its end, alone or in small parties),
// wander along it, stand about looking at their phones or up the line, check the time, gather in groups and
// chat (one talks with their hands, the others nod); half a minute before a train is due they move up to the
// platform edge by the doors and watch it come in. When it stops the arriving passengers step out of its doors
// and head for the exits, then the waiting ones get in (the doors are where the cars' doors are). The glacier
// station's terrace has its own visitors: out of the building, over to the railing to look at the view and take
// photos, back inside.
//
// They are the instanced crowd people of fans.js (eight Meshy characters, a few draw calls for all of them) with
// the walking / talking poses of FanCrowd.dynamic, moved by peoplesim.js. Each station is simulated only while
// the camera is within ACTIVE m (the rock hall's people only while the camera is underground), drawn within VIEW m
// (three LODs, poses updated less often further out). The timetable time comes from the stations' per-frame
// update (railway.js passes it); without it the people still come and go, just not in step with the trains.
import * as THREE from 'three';
import { loadFanKits, FanCrowd, FAN_KEYS as K } from './fans.js';
import { PeopleSim } from './peoplesim.js';
import { world } from './world.js';
import { RAIL, railAt, trainState, CYCLE, stopWindows } from './railroute.js';
import { mulberry32 } from '../core/noise.js';

const VIEW = 150;                 // m: beyond this a station's people are not drawn
const LOD = [16, 45];             // m: textured near, lighter further out
const ACTIVE = 260;               // m: stations further away are not simulated
const DOORS = [-13.2, -2.05, 2.05, 13.2]; // the cars' doors along the line from the train's middle (either way round)
const EDGE = 1.75;                // the platform edge (m from the track's centre line)
const LANE = [2.55, 4.1];         // where people walk / stand on the platform (benches, lamps and boards behind)
const _f = { x: 0, y: 0, z: 0, dx: 0, dz: 1, grade: 0, i: 0 };
const _frustum = new THREE.Frustum(), _pv = new THREE.Matrix4();
const _ts = {};

// (the stops at a station in cycle time, [{u0, u1, dir (the way it leaves)}]: railroute.js stopWindows)

// ------------------------------------------------------------------ a station platform
class Platform {
  constructor({ st, rec, kits, rnd, n, parent, under = false, exits }) {
    this.id = st.id; this.st = st; this.rec = rec; this.rnd = rnd; this.under = under;
    this.side = st.side;
    this.mid = rec.s;
    this.s0 = st.s0 + 6; this.s1 = st.s1 - 6;
    railAt(this.mid, _f);
    this.y = _f.y + 0.06; // the platform's top
    this.wins = stopWindows(st.id);
    // benches, lamps, the timetable board, the name boards (railstations.js): kept clear when standing
    this.obst = [];
    for (let s = st.s0 + 16; s < st.s1 - 10; s += 24) this.obst.push([s, 4.8, 1.3], [s + 12, 5.3, 0.5]);
    this.obst.push([this.mid - 8, 4.6, 1.0], [st.s0 + 10, 5.6, 1.6], [st.s1 - 10, 5.6, 1.6]);
    this.exits = exits; // [{s, lat, w}]: where people come from / go (a building door, the platform's end)
    const spots = [];
    for (let i = 0; i < n; i++) { const p = this.P(this.mid, 3); spots.push({ x: p.x, y: this.y, z: p.z, yaw: 0, free: 0.5, prop: 0 }); }
    const c = this.P(this.mid, 3);
    this.crowd = new FanCrowd(kits, spots, rnd, { parent, name: `rail-people-${st.id}${under ? '-hall' : ''}`, shadows: false, dynamic: true, glow: under ? 0.32 : 0,
      bounds: { center: new THREE.Vector3(c.x, this.y, c.z), radius: (st.s1 - st.s0) / 2 + 12 } });
    this.sim = new PeopleSim(this.crowd, { groundY: () => this.y });
    this.groups = [];
    this.standing = null; this.prevStanding = null;
    this.spawnT = 0; this.active = false; this.idleFor = 1e9; this.time = 0;
    this.center = new THREE.Vector3(c.x, this.y, c.z);
  }

  // world point at arc length s, lat m from the centre line on the platform's side
  P(s, lat) { railAt(s, _f); const l = lat * this.side; return { x: _f.x - _f.dz * l, z: _f.z + _f.dx * l }; }
  // yaw facing the track / up the line (+1) or down (-1) at s
  yawTrack(s) { railAt(s, _f); return Math.atan2(this.side * _f.dz, -this.side * _f.dx); }
  yawLine(s, dir) { railAt(s, _f); return Math.atan2(_f.dx * dir, _f.dz * dir); }
  sOf(p) { // arc length / lat of a person (near the platform)
    railAt(this.mid, _f);
    const dx = p.x - _f.x, dz = p.z - _f.z;
    return { s: this.mid + dx * _f.dx + dz * _f.dz, lat: (-dx * _f.dz + dz * _f.dx) * this.side };
  }
  clear(s, lat, r = 0.75) {
    for (const [os, ol, orad] of this.obst) if (Math.abs(os - s) < orad + r && Math.abs(ol - lat) < 0.45 + r * 0.5) return false;
    return true;
  }
  spot(nearS = null, spread = 30, lat0 = LANE[0], lat1 = LANE[1]) {
    for (let k = 0; k < 20; k++) {
      const s = nearS === null ? this.s0 + 4 + this.rnd() * (this.s1 - this.s0 - 8) : Math.max(this.s0 + 3, Math.min(this.s1 - 3, nearS + (this.rnd() - 0.5) * spread));
      const lat = lat0 + this.rnd() * (lat1 - lat0);
      if (!this.clear(s, lat)) continue;
      let free = true;
      for (const q of this.sim.people) if (q.onStage && (q.state === 'idle' || q.state === 'ready' || q.group)) {
        const t = q.slot || q;
        const P = this.P(s, lat);
        if ((t.x - P.x) ** 2 + (t.z - P.z) ** 2 < 0.8) { free = false; break; }
      }
      if (free) return { s, lat };
    }
    return { s: this.mid + (this.rnd() - 0.5) * 20, lat: 3.2 };
  }
  path(pts) { return pts.map(([s, lat]) => this.P(s, lat)); }

  // seconds until a train stops here (0 while one stands here)
  nextStop(t) {
    let best = Infinity;
    for (const ph of [0, 0.5]) {
      const u = ((((t / CYCLE + ph) % 1) + 1) % 1) * CYCLE;
      for (const w of this.wins) {
        let d = w.u0 - u;
        if (u >= w.u0 && u < w.u1) d = 0; else if (d < 0) d += CYCLE;
        best = Math.min(best, d);
      }
    }
    return best;
  }
  // the train standing at this platform now: { s, dir (the way it leaves) } or null
  trainHere(t) {
    for (const ph of [0, 0.5]) {
      trainState(t, ph, _ts);
      if (_ts.at === this.id && _ts.doors) return { s: _ts.s, dir: this.id === 'tal' ? 1 : this.id === 'platt' ? -1 : _ts.dir || 1, ph };
    }
    return null;
  }
  // how many people wait for the train at time-to-next-stop tn
  waitTarget(tn) {
    const N = this.cap;
    return Math.round(N * Math.max(0.35, Math.min(0.9, 1 - tn / (CYCLE * 0.5))));
  }
  get cap() { return Math.round(this.sim.people.length * 0.66); }

  // ---------------------------------------------------------------- what people do
  free() { return this.sim.people.find((p) => !p.onStage); }
  count(plan) { let n = 0; for (const p of this.sim.people) if (p.onStage && p.fadeTo > 0 && p.plan === plan) n++; return n; }

  exitPath(fromS, ex) {
    if (ex.end) return [[ex.s, 3.3]];
    return [[ex.s, 3.4], [ex.s, ex.lat - 0.7]];
  }
  pickExit() {
    let r = this.rnd() * this.exits.reduce((a, e) => a + e.w, 0);
    for (const e of this.exits) { r -= e.w; if (r <= 0) return e; }
    return this.exits[0];
  }
  // a party of 1-3 arriving: from an exit to a spot on the platform
  arrive(shown = false, linger = this.rnd() < 0.22) {
    const k = this.rnd() < 0.55 ? 1 : this.rnd() < 0.7 ? 2 : 3;
    const ex = this.pickExit();
    const dest = this.spot(this.mid, 90); // (around the middle, where the cars' doors stop)
    const party = [];
    const skis = !linger && this.rnd() < (this.id === 'platt' ? 0.25 : 0.45); // skiers carry their skis over the shoulder
    for (let j = 0; j < k; j++) {
      const p = this.free();
      if (!p) break;
      const ps = ex.end ? [ex.s, 3.3] : [ex.s, ex.lat];
      const at = this.P(ps[0] + (ex.end ? 0 : (j - (k - 1) / 2) * 0.7), ps[1] + (ex.end ? (j - (k - 1) / 2) * 0.7 : 0));
      this.sim.spawn(p, at.x, at.z, this.yawLine(ps[0], ex.end && ps[0] < this.mid ? 1 : ex.end ? -1 : 1), { vmax: 1.15 + this.rnd() * 0.25 });
      if (!ex.end) p.yaw = this.yawTrack(ps[0]);
      p.plan = linger ? 'stay' : 'ride'; p.state = 'enter'; p.carry = skis ? 1 : 0;
      p.leaveAt = this.time + 45 + this.rnd() * 110;
      p.dir = this.st.halt ? (this.rnd() < 0.6 ? 1 : -1) : this.id === 'tal' ? 1 : -1;
      party.push(p);
    }
    if (!party.length) return;
    party.forEach((p, j) => {
      const off = (j - (party.length - 1) / 2) * 0.75;
      const pts = ex.end ? [[dest.s + off * 0.3, dest.lat + off]] : [[ex.s + off, 3.6], [dest.s + off * 0.3, dest.lat + off * 0.6]];
      this.sim.setPath(p, this.path(pts), () => { p.state = 'idle'; if (party.length > 1 && !skis) { if (j === party.length - 1) this.makeGroup(party); } else this.idle(p); });
      p.state = 'enter';
    });
    if (shown) {
      // (stage set when the camera arrives: people are already where they were going)
      for (const p of party) { const last = p.path[p.path.length - 1]; p.x = last.x; p.z = last.z; p.alpha = 1; p.path = null; p.state = 'idle'; }
      if (party.length > 1 && !skis && this.rnd() < 0.4) this.makeGroup(party); else for (const p of party) { this.idle(p); p.until = this.time + this.rnd() * 3; }
    }
  }
  // standing about: phone, a look at the watch, up the line, around
  idle(p) {
    p.state = 'idle'; p.group = null; p.slot = null; p.talkTo = 0;
    const { s } = this.sOf(p), r = this.rnd();
    p.face = this.yawTrack(s) + (this.rnd() - 0.5) * 1.6;
    p.look = null; p.holdTo = 0;
    if (r < 0.32) { p.hold = K.PHONE; p.holdTo = 1; } else if (r < 0.4) { p.hold = K.WATCH; p.holdTo = 1; p.watchT = this.time + 2.5; } else if (r < 0.6) {
      const dir = this.id === 'tal' ? 1 : this.id === 'platt' ? -1 : (p.dir || 1) > 0 ? -1 : 1; // where the train comes from
      p.face = this.yawLine(s, dir) + this.side * 0.5; const q = this.P(s + dir * 60, 0); p.look = { x: q.x, z: q.z };
    } else if (r < 0.7) { p.hold = this.rnd() < 0.5 ? K.HOLD : K.POCKET; p.holdTo = 1; }
    p.until = this.time + 3 + this.rnd() * 7; // (short: a platform between trains is never a still life)
  }
  mill(p) {
    const { s } = this.sOf(p);
    const d = this.spot(s, 18);
    p.state = 'mill'; p.holdTo = this.rnd() < 0.2 ? 1 : 0; p.hold = K.PHONE; p.look = null;
    this.sim.setPath(p, this.path([[d.s, d.lat]]), () => this.idle(p));
  }
  // two to four people who stand close start a conversation (a circle, each facing its middle)
  tryChat(p) {
    if (p.carry) return false;
    const mates = [];
    for (const q of this.sim.people) {
      if (q === p || !q.onStage || q.state !== 'idle' || q.plan === 'leave' || q.fadeTo <= 0 || q.carry) continue;
      if ((q.x - p.x) ** 2 + (q.z - p.z) ** 2 < 49) mates.push(q);
      if (mates.length >= 1 + Math.floor(this.rnd() * 3)) break;
    }
    if (!mates.length) return false;
    this.makeGroup([p, ...mates]);
    return true;
  }
  makeGroup(members) {
    const n = members.length;
    let cx = 0, cz = 0;
    for (const m of members) { cx += m.x; cz += m.z; }
    cx /= n; cz /= n;
    // keep the circle on the platform lane
    const c = this.sOf({ x: cx, z: cz }), r = n === 2 ? 0.58 : 0.7;
    const cs = Math.max(this.s0 + 2, Math.min(this.s1 - 2, c.s)), cl = Math.max(LANE[0] + r, Math.min(LANE[1] - 0.2, c.lat));
    const C = this.P(cs, cl);
    const g = { members, x: C.x, z: C.z, until: this.time + 8 + this.rnd() * 16, speaker: 0, swap: this.time + 3 };
    const a0 = this.rnd() * Math.PI * 2;
    members.forEach((m, j) => {
      const a = a0 + (j / n) * Math.PI * 2;
      m.group = g; m.slot = { x: C.x + Math.sin(a) * r, z: C.z + Math.cos(a) * r };
      m.state = 'chat'; m.holdTo = 0; m.look = null;
      this.sim.setPath(m, [m.slot], () => { m.face = Math.atan2(g.x - m.x, g.z - m.z); });
    });
    this.groups.push(g);
  }
  endGroup(g) {
    this.groups.splice(this.groups.indexOf(g), 1);
    for (const m of g.members) if (m.group === g) { m.group = null; m.slot = null; m.talkTo = 0; if (m.state === 'chat') this.idle(m); m.until = this.time + 1 + this.rnd() * 6; }
  }
  // up to the platform edge by a door, facing the track, watching the train come in
  gather(p) {
    if (p.group) this.leaveGroup(p);
    const { s } = this.sOf(p);
    let best = 0, bd = Infinity;
    DOORS.forEach((o, k) => { const d = Math.abs(this.mid + o - s) + this.rnd() * 6; if (d < bd) { bd = d; best = k; } });
    const ds = this.mid + DOORS[best] + (this.rnd() - 0.5) * 3.4, lat = LANE[0] + 0.05 + this.rnd() * 0.75;
    p.state = 'gather'; p.holdTo = 0; p.look = null;
    this.sim.setPath(p, this.path([[ds, lat]]), () => {
      p.state = 'ready';
      const dir = this.id === 'tal' ? 1 : this.id === 'platt' ? -1 : (p.dir || 1) > 0 ? -1 : 1;
      p.face = this.yawTrack(ds) + dir * this.side * 0.45 + (this.rnd() - 0.5) * 0.4;
      const q = this.P(ds + dir * 80, 0); p.look = { x: q.x, z: q.z };
      if (this.rnd() < 0.25) { p.hold = K.PHONE; p.holdTo = 1; }
    });
  }
  leaveGroup(p) {
    const g = p.group;
    if (!g) return;
    g.members = g.members.filter((m) => m !== p);
    p.group = null; p.slot = null; p.talkTo = 0;
    if (g.members.length < 2) this.endGroup(g);
  }
  // into the train: to the nearest door, step in (fading out inside)
  board(p, train) {
    if (p.group) this.leaveGroup(p);
    const { s } = this.sOf(p);
    let ds = train.s + DOORS[0], bd = Infinity;
    for (const o of DOORS) { const d = Math.abs(train.s + o - s); if (d < bd) { bd = d; ds = train.s + o; } }
    p.state = 'board'; p.holdTo = 0; p.look = null; p.talkTo = 0;
    const off = (this.rnd() - 0.5) * 0.5;
    this.sim.setPath(p, this.path([[ds + off * 0.5 + (s > ds ? 0.9 : -0.9), 2.5], [ds + off * 0.3, 2.05]]), () => {
      this.sim.setPath(p, this.path([[ds, EDGE - 0.6]]), null);
      this.sim.hide(p, 2.2);
      p.state = 'gone';
    });
  }
  // somebody in a hurry for the train standing here: straight to a door
  late(train) {
    const p = this.free();
    if (!p) return;
    const ex = this.pickExit();
    const at = ex.end ? this.P(ex.s, 3.3) : this.P(ex.s, ex.lat);
    this.sim.spawn(p, at.x, at.z, ex.end ? this.yawLine(ex.s, ex.s < this.mid ? 1 : -1) : this.yawTrack(ex.s), { vmax: 1.38 });
    p.plan = 'ride'; p.dir = train.dir; p.state = 'enter'; p.carry = this.rnd() < 0.45 ? 1 : 0;
    this.board(p, train);
  }
  // out of the train's door, then off to an exit
  alight(train, k, delay) {
    const p = this.free();
    if (!p) return;
    const ds = train.s + DOORS[k] + (this.rnd() - 0.5) * 0.4;
    const at = this.P(ds, EDGE - 0.35);
    this.sim.spawn(p, at.x, at.z, this.yawTrack(ds) + Math.PI, { vmax: 1.15 + this.rnd() * 0.25 });
    p.alpha = 0; p.fadeTo = 0; p.state = 'alight'; p.plan = 'leave'; p.wake = this.time + delay;
    p.carry = this.rnd() < (this.id === 'platt' ? 0.55 : 0.4) ? 1 : 0;
    p.alightS = ds;
  }
  leave(p) {
    const ex = this.pickExit(), { s } = this.sOf(p);
    p.state = 'leave'; p.holdTo = 0; p.look = null; p.talkTo = 0;
    const pts = this.exitPath(s, ex);
    this.sim.setPath(p, this.path(pts), () => {
      if (!ex.end) this.sim.setPath(p, this.path([[ex.s, ex.lat + 0.6]]), null);
      this.sim.hide(p, ex.end ? 1.6 : 2.0);
      p.state = 'gone';
    });
  }
  think(p) {
    if (p.plan === 'leave' || (p.plan === 'stay' && this.time > p.leaveAt)) { p.plan = 'leave'; return this.leave(p); }
    const r = this.rnd();
    if (r < 0.18 && this.tryChat(p)) return;
    if (r < 0.8) return this.mill(p);
    this.idle(p);
  }

  // ---------------------------------------------------------------- per frame
  update(dt, t, cam) {
    this.time += dt;
    // stage set: arriving from far away, the platform already has its people
    if (!this.active) {
      this.active = true;
      if (this.idleFor > 60) {
        const tn = t === null ? 200 : this.nextStop(t);
        const want = this.waitTarget(tn);
        for (let k = 0; k < 14 && this.count('ride') < want; k++) this.arrive(true, false);
        for (let k = 0; k < 4 && this.count('stay') < Math.round(this.cap * 0.22); k++) this.arrive(true, true);
        // (and half of them already about to do something else, the first conversations short: nobody waits for
        // the camera to start moving)
        for (const p of this.sim.people) if (p.onStage && p.state === 'idle' && this.rnd() < 0.5) p.until = this.time + this.rnd() * 2;
        for (const g of this.groups) g.until = Math.min(g.until, this.time + 3 + this.rnd() * 7);
      }
    }
    this.idleFor = 0;
    const train = t === null ? null : this.trainHere(t);
    const tn = t === null ? 200 : train ? 0 : this.nextStop(t);
    // a train came in: people get off first, then the waiting ones get on
    if (train && !this.standing) {
      const k = 3 + Math.floor(this.rnd() * (this.st.halt ? 4 : 8));
      for (let j = 0; j < k; j++) this.alight(train, Math.floor(this.rnd() * 4), j * 0.9 + this.rnd() * 1.2);
      for (const p of this.sim.people) {
        if (!p.onStage || p.plan !== 'ride' || p.state === 'gone' || p.fadeTo <= 0) continue;
        if (this.st.halt && p.dir !== train.dir) continue;
        const { s } = this.sOf(p);
        if (Math.abs(s - train.s) > 34) continue; // too far along the platform: the next one
        p.boardAt = this.time + 2.5 + this.rnd() * 5;
      }
    }
    if (!train && this.standing) {
      // it left: whoever did not make it waits for the next one
      for (const p of this.sim.people) { p.boardAt = undefined; if (p.onStage && p.state === 'board') { p.state = 'idle'; p.path = null; this.idle(p); } }
    }
    this.standing = train;
    // more passengers drift in until the next train (some in a hurry while it stands here), a few who stay
    this.spawnT -= dt;
    if (this.spawnT <= 0) {
      this.spawnT = 3 + this.rnd() * 6;
      if (train) { if (this.rnd() < 0.35) this.late(train); } else if (this.count('ride') < this.waitTarget(tn)) this.arrive(false);
      else if (this.count('stay') < Math.round(this.cap * 0.22)) this.arrive(false, true);
    }
    // conversations: the speaker changes now and then, they break up after a while
    for (let gi = this.groups.length - 1; gi >= 0; gi--) {
      const g = this.groups[gi];
      if (this.time > g.until || tn < 40) { this.endGroup(g); continue; }
      if (this.time > g.swap) { g.speaker = (g.speaker + 1 + Math.floor(this.rnd() * (g.members.length - 1))) % g.members.length; g.swap = this.time + 2.5 + this.rnd() * 6; }
      g.members.forEach((m, j) => {
        if (m.path) return;
        m.talkTo = j === g.speaker ? 1 : 0.22;
        m.face = Math.atan2(g.x - m.x, g.z - m.z);
        const sp = g.members[g.speaker];
        m.look = j === g.speaker ? { x: g.x, z: g.z } : { x: sp.x, z: sp.z };
      });
    }
    for (const p of this.sim.people) {
      if (!p.onStage) continue;
      if (p.state === 'alight') {
        if (this.time < p.wake) continue;
        p.state = 'out'; p.fadeTo = 1; p.fadeRate = 2.6;
        this.sim.setPath(p, this.path([[p.alightS + (this.rnd() - 0.5) * 1.2, 2.9]]), () => this.leave(p));
        continue;
      }
      if (p.boardAt !== undefined && train && this.time > p.boardAt && p.state !== 'board' && p.state !== 'gone') { p.boardAt = undefined; this.board(p, train); continue; }
      if (p.plan === 'ride' && tn < 32 && !train && (p.state === 'idle' || p.state === 'chat' || p.state === 'mill')) { this.gather(p); continue; }
      if (p.state === 'idle') {
        if (p.hold === K.WATCH && p.holdTo && this.time > (p.watchT || 0)) p.holdTo = 0;
        if (this.time > p.until) this.think(p);
      }
    }
    this.sim.update(dt);
  }
  sleep(dt) { this.idleFor += dt; this.active = false; }
}

// ------------------------------------------------------------------ the glacier station's terrace
class Terrace {
  constructor({ rec, kits, rnd, n, parent }) {
    this.rec = rec; this.rnd = rnd;
    const ex = rec.exit, door = rec.board;
    this.ex = ex; this.door = door;
    this.fx = Math.sin(ex.heading); this.fz = Math.cos(ex.heading); // toward the view (the village)
    // the deck (railstations.js buildGlacierStation): the station's origin 2.6 m behind the door, its top 0.16 m
    // over the ground there; x along the front, the railing 8.5 m out from the building
    this.H = { x: door.x - this.fx * 2.6, z: door.z - this.fz * 2.6 };
    this.y = (rec.surface?.y ?? world.height(ex.x, ex.z)) + 0.16;
    const spots = Array.from({ length: n }, () => ({ x: ex.x, y: this.y, z: ex.z, yaw: ex.heading, free: 0.5, prop: 0 }));
    this.crowd = new FanCrowd(kits, spots, rnd, { parent, name: 'rail-people-terrace', shadows: false, dynamic: true, bounds: { center: new THREE.Vector3(ex.x, this.y, ex.z), radius: 16 } });
    this.sim = new PeopleSim(this.crowd, { groundY: () => this.y });
    this.center = new THREE.Vector3(ex.x, this.y, ex.z);
    this.time = 0; this.spawnT = 0; this.active = false; this.idleFor = 1e9;
  }
  spot() {
    // on the deck: most at the railing looking out, some further back (clear of the telescopes)
    const rx = -this.fz, rz = this.fx, H = this.H;
    for (let k = 0; k < 16; k++) {
      const f = this.rnd() < 0.6 ? 7.6 + this.rnd() * 0.5 : 2.2 + this.rnd() * 4.5, l = (this.rnd() - 0.5) * 21;
      if (Math.abs(l + 6.5) < 1 || Math.abs(l - 7.5) < 1) continue;
      const x = H.x + this.fx * f + rx * l, z = H.z + this.fz * f + rz * l;
      let ok = true;
      for (const q of this.sim.people) if (q.onStage && q !== this && ((q.slot || q).x - x) ** 2 + ((q.slot || q).z - z) ** 2 < 0.9) { ok = false; break; }
      if (ok) return { x, z };
    }
    return { x: H.x + this.fx * 5, z: H.z + this.fz * 5 };
  }
  out(shown) {
    const p = this.sim.people.find((q) => !q.onStage);
    if (!p) return;
    const d = this.door, s = this.spot();
    this.sim.spawn(p, d.x + (this.rnd() - 0.5) * 1.2, d.z + (this.rnd() - 0.5) * 1.2, this.ex.heading, { vmax: 1.0 + this.rnd() * 0.3 });
    p.state = 'enter'; p.carry = this.rnd() < 0.35 ? 1 : 0;
    this.sim.setPath(p, [s], () => this.view(p));
    if (shown) { p.x = s.x; p.z = s.z; p.alpha = 1; p.path = null; this.view(p); }
  }
  view(p) {
    p.state = 'view';
    p.face = this.ex.heading + (this.rnd() - 0.5) * 1.2;
    p.look = { x: p.x + Math.sin(p.face) * 200, y: p.y - 30, z: p.z + Math.cos(p.face) * 200 };
    const r = this.rnd();
    p.holdTo = r < 0.55 ? 1 : 0; p.hold = r < 0.3 ? K.PHONE : r < 0.42 ? K.POINT : K.HOLD;
    p.talkTo = 0;
    p.until = this.time + 5 + this.rnd() * 10;
    p.stays = (p.stays || 0) + 1;
  }
  update(dt) {
    this.time += dt;
    if (!this.active) {
      this.active = true;
      if (this.idleFor > 60) for (let k = 0; k < 7; k++) this.out(true);
    }
    this.idleFor = 0;
    this.spawnT -= dt;
    let on = 0;
    for (const p of this.sim.people) if (p.onStage && p.fadeTo > 0) on++;
    if (this.spawnT <= 0) { this.spawnT = 4 + this.rnd() * 8; if (on < 9) this.out(false); }
    for (const p of this.sim.people) {
      if (!p.onStage || p.state !== 'view' || this.time < p.until) continue;
      const r = this.rnd();
      if (p.stays > 2 || r < 0.3) { // back inside
        p.state = 'in'; p.holdTo = 0; p.look = null;
        this.sim.setPath(p, [{ x: this.door.x, z: this.door.z }], () => { this.sim.hide(p, 2.4); p.state = 'gone'; });
        this.sim.hide(p, 0.45);
      } else if (r < 0.65) { const s = this.spot(); p.state = 'mill'; p.holdTo = 0; p.look = null; this.sim.setPath(p, [s], () => this.view(p)); } else this.view(p);
    }
    this.sim.update(dt);
  }
  sleep(dt) { this.idleFor += dt; this.active = false; }
}

export class RailPeople {
  constructor(scene, stations) {
    this.group = new THREE.Group();
    this.group.name = 'rail-people';
    scene.add(this.group);
    this.stages = [];
    this.time = 0;
    this.railT = null;
    // the timetable time: railway.js hands it to the stations every frame
    const prev = stations.update;
    stations.update = (viewer, t) => { if (Number.isFinite(t)) this.railT = t; return prev?.call(stations, viewer, t); };
    loadFanKits().then((kits) => {
      if (!kits.length) return;
      const rnd = mulberry32(8812);
      for (const st of RAIL.stations) {
        const rec = stations.list.find((r) => r.id === st.id);
        if (!rec) continue;
        try {
          const mid = rec.s;
          if (st.id === 'tal') {
            // the building's door, the platform's village end, its far end (fewer)
            this.stages.push(new Platform({ st, rec, kits, rnd, n: 40, parent: this.group,
              exits: [{ s: mid - 1.5, lat: 6.3, w: 3 }, { s: st.s0 + 5, end: true, w: 2 }, { s: st.s1 - 5, end: true, w: 0.6 }] }));
          } else if (st.halt) { // (Wolkensee; the quieter Adlerwald)
            this.stages.push(new Platform({ st, rec, kits, rnd, n: st.id === 'see' ? 18 : 10, parent: this.group,
              exits: [{ s: mid - 1.5, lat: 6.3, w: 2 }, { s: st.s0 + 5, end: true, w: 1 }, { s: st.s1 - 5, end: true, w: 1 }] }));
          } else {
            // the rock hall under the glacier (its way out: the passage at the back wall), the terrace above
            this.stages.push(new Platform({ st, rec, kits, rnd, n: 22, parent: this.group, under: true,
              exits: [{ s: mid - 6, lat: 6.9, w: 3 }, { s: st.s1 - 5, end: true, w: 0.5 }] }));
            if (rec.exit && rec.board) this.stages.push(new Terrace({ rec, kits, rnd, n: 12, parent: this.group }));
          }
        } catch (e) { console.warn('rail people', st.id, e.message); }
      }
    }).catch((e) => console.warn('rail people', e));
  }

  /** Each frame (after the camera is placed): the people's day at every station near the camera. */
  update(dt, camera) {
    if (!this.stages.length || !camera) return;
    const t0 = performance.now();
    this.time = (this.time + dt) % 3600;
    camera.updateMatrixWorld();
    _frustum.setFromProjectionMatrix(_pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const cam = camera.position;
    for (const sg of this.stages) {
      const d = cam.distanceTo(sg.center);
      // (the rock hall's people only for a camera down there, the terrace's only for one up there)
      const vis = d < ACTIVE && (sg.under ? cam.y < sg.y + 12 : sg instanceof Terrace ? cam.y > sg.y - 12 : true);
      if (!vis) { if (sg.active) { sg.crowd.group.visible = false; sg.crowd.visible = false; } sg.sleep(dt); continue; }
      sg.update(dt, this.railT, cam);
      sg.crowd.update(dt, { cam, frustum: _frustum, view: VIEW, lod: LOD, cheer: 0, player: null, time: this.time, shadows: false });
    }
    this.ms = (this.ms || 0) * 0.95 + (performance.now() - t0) * 0.05;
  }
}
