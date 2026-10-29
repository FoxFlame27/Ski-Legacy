// LEGACY TAXI: drive fares round the resort in your own (rented) car. Go on duty at a job board (the TAXI note) or
// with T in your car; the dispatcher sends you to someone waiting at a bus stop, a car park, the chalet village, the
// car rental, the medical centre... (on foot beside the road: the job people's rigs, jobs/actors.js RigPool). Stop
// beside them and they walk to your car and get in your passenger seat (multiplayer: the seat behind it, the front one
// stays free for a friend), say where they're going, and the meter runs: an $8 flag fall, $3 every 100 m driven
// (capped near the usual route, so a detour earns nothing), a fixed mountain surcharge for the climb.
// Stop at their destination and they get out and pay, with a tip for a quick, smooth ride. Knocks and crashes
// while they're aboard cost you (they complain); wreck the car and they leave without paying. T again (in your car)
// or the board ends your shift. Pay goes through main.js earn(..., 'job'): the server's job payout in multiplayer.
// Only you see your passenger (jobs keep their people local, as every job does).
import * as THREE from 'three';
import { world } from '../world/world.js';
import { busRoads, stopWaitArea, nearestRoadPoint, laneDistance, ROAD_HALF } from './bus/roads.js';
import { seatsFor, twoBone } from './carpeople.js';
import { driverEye } from './cars.js';
import { GUESTS } from './jobs/catalog.js';
import { makeFallbackFigure } from './jobs/props.js';
import { CHALET_PLACE } from './bus/chaletroad.js';
import { MP } from '../net/mode.js';

// the tariff (Oct 29, the user: "a realistic way" to earn: an $8 flag fall plus $3 a tick. The resort's road trips are
// only 1-8 km, so at $3 a km a fare would be $11-32, below every other job; the meter ticks $3 every 100 m instead,
// a mountain resort's price (a game dollar buys less: a lift ticket is $50), which puts a fare at the asked-for
// $40-250 by distance, before the tip. One number to change: perKm)
export const TARIFF = { flag: 8, perKm: 30, climb: 4 /* per 100 m up */, min: 40, max: 300, tipQuick: 0.1, tipSmooth: 0.1 };
const PICK_R = 16;        // m: stop this close to the passenger and they come over
const DROP_R = 20;        // m: ...and this close to the destination's kerb to let them out
const STOP_V = 1.6;       // m/s: stopped (enough)
const WALK_V = 1.5;       // m/s: a passenger walking to / from your car
const SCARY_V = 125 / 3.6; // m/s: faster than this for a few seconds frightens them
const SHOW_R = 420;       // m: the passenger is built (from the pool) when you are this close
const LINES = {
  hail: ['Hi! Thanks for coming.', 'Oh good, my taxi!', 'Perfect timing.', 'Hello! Am I glad to see you.', 'Grüezi! I booked a cab.'],
  pickup: (to) => [`${to}, please.`, `Could you take me to ${to}?`, `To ${to}, please. No rush.`, `${to}, please. My friends are waiting.`, `Take me to ${to}? Thanks!`],
  knock: ['Ouch! Easy there!', 'Hey, careful!', 'Watch it, please!', 'Whoa! Is this a bumper car?', 'My coffee! Careful!'],
  crash: ['Are you trying to kill me?!', 'That was a crash! I am not paying full fare for this.', 'Unbelievable. Just get me there in one piece.'],
  scary: ['Slow down, please! This is not a race.', 'Could you drive a bit slower? Please?'],
  detour: ['Is this really the way?', 'I think we went the wrong way.'],
  thanks: ['Thanks, lovely ride!', 'Here you go. Keep the change!', 'Smooth as fresh corduroy. Thank you!', 'Great driving, thanks!'],
  meh: ['Thanks... I think.', 'We made it. Somehow.', 'Here. Maybe take a driving lesson.'],
  wreck: ["I'm out of here!", 'I am walking from here. And I am not paying!'],
  dumped: ['You are leaving me HERE? Forget the fare.', 'This is not where I wanted to go!'],
  late: (n) => `${n} gave up waiting and took the bus`,
};
const pick = (a) => a[Math.floor(Math.random() * a.length) % a.length];
const money = (v) => `$${Math.round(v).toLocaleString('en-US')}`;
const hyp = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);
const _v = new THREE.Vector3(), _hip = new THREE.Vector3(), _tgt = new THREE.Vector3(), _pole = new THREE.Vector3();

// a car template's seat points (car frame: +x the driver's side, +z forward), as net/vehicles.js carSeats: 0 the
// driver, 1 the front passenger, 2.. the back
const SEATS = new WeakMap();
function carSeats(t) {
  if (!t) return null;
  let out = SEATS.get(t);
  if (out) return out;
  out = [];
  const S = seatsFor(t);
  const pt = (x, s) => new THREE.Vector3(x, s[0] - 0.01, s[1] + s[2] * (0.1 - 0.15) + 0.13);
  if (S) {
    const front = S.d.slice(1);
    out.push(pt(S.d[0], front), pt(-S.d[0], S.p || front));
    if (S.r) { const r = S.r.slice(1); out.push(pt(S.r[0], r), pt(-S.r[0], r)); }
  } else {
    const E = driverEye(t), y = E.y - 0.78, z = E.z - 0.04;
    out.push(new THREE.Vector3(E.x, y, z), new THREE.Vector3(-E.x, y, z), new THREE.Vector3(E.x, y - 0.04, z - 0.86), new THREE.Vector3(-E.x, y - 0.04, z - 0.86));
  }
  SEATS.set(t, out);
  return out;
}
// the passenger's seat: the front passenger seat (multiplayer: the one behind it, when the car has one, so a friend
// can still ride up front)
const paxSeat = (list) => (MP.active && list.length > 3 ? 3 : 1);
// legs to the footwell (the bench 'sit' pose hangs them straight down through the car floor), as net/remote.js does
function carLegs(rig) {
  const b = rig.b;
  if (!b?.hips || !b.lUp || !b.rUp) return;
  const q = rig.root.quaternion;
  rig.root.updateMatrixWorld(true);
  _hip.setFromMatrixPosition(b.hips.matrixWorld);
  for (const [side, up, leg, foot] of [[1, b.lUp, b.lLeg, b.lFoot], [-1, b.rUp, b.rLeg, b.rFoot]]) {
    _tgt.set(side * 0.14, -0.26, 0.74).applyQuaternion(q).add(_hip);
    _pole.set(side * 0.15, 1, 0.5).normalize().applyQuaternion(q);
    try { twoBone(up, leg, foot, _tgt, _pole); } catch { /* (the pose stays as the rig made it) */ }
  }
}

const CSS = `
#taxi-meter { position: absolute; right: 22px; bottom: 132px; min-width: 210px; padding: 10px 22px 12px 24px; background: #fff; color: var(--blue, #1546c8);
  clip-path: var(--brush-a); filter: drop-shadow(0 6px 14px rgba(0, 20, 60, 0.28)); pointer-events: none; text-align: right; }
#taxi-meter .tm-head { font-family: var(--num); font-style: italic; font-weight: 700; font-size: 13px; letter-spacing: 0.08em; color: #ff4d3d; }
#taxi-meter .tm-fare { font-family: var(--num); font-style: italic; font-weight: 700; font-size: 38px; line-height: 1.05; font-variant-numeric: tabular-nums; }
#taxi-meter .tm-row { font-size: 12px; font-weight: 700; opacity: 0.75; font-variant-numeric: tabular-nums; }
#taxi-meter .tm-say { font-size: 12px; font-style: italic; margin-top: 4px; max-width: 240px; margin-left: auto; }
#taxi-meter .tm-say:empty { display: none; }`;

export class Taxi {
  /**
   * @param {object} o
   * @param {THREE.Scene} o.scene
   * @param {object} o.player
   * @param {object} o.drive        Drive (drive.js): the car you drive
   * @param {object} [o.carRental]  CarRental: your rental (carRental.current)
   * @param {object} [o.jobs]       Jobs: its rig pool and characters for the passengers
   * @param {object} o.hud
   * @param {object} [o.audio]
   * @param {(amount: number, label: string) => void} o.earn   paid as a job (multiplayer: the server's 'job' payout)
   * @param {() => boolean} [o.busy]  another job under way (no taxi duty from the board meanwhile)
   * @param {object} [o.layout]     world layout (the chalet village)
   */
  constructor({ scene, player, drive, carRental = null, jobs = null, hud, audio = null, earn, busy = null, layout = null }) {
    Object.assign(this, { scene, player, drive, carRental, jobs, hud, audio, earn, busy, layout });
    this.duty = false;
    this.fare = null;      // the current fare (see dispatch)
    this.pax = null;       // the passenger's body { slot, rig, fig, root, st, pos, heading, acc }
    this.leaving = [];     // passengers walking away after a ride (gone once out of the way)
    this.nextT = 0;
    this.hintT = 0;
    this.wasIn = false;
    this.places = null;    // built on first use (the roads are planned by then)
    this.said = ''; this.saidT = 0;
    this.shift = { fares: 0, earned: 0 };
    this.group = new THREE.Group();
    this.group.name = 'taxi';
    scene?.add(this.group);
    this._wp = { x: 0, z: 0, label: '' };
  }

  // ------------------------------------------------------------------ where people wait
  // Bus stops (their waiting area), car parks, the medical centre, the car rental, the chalet village: each a kerb
  // point on a road (where you stop) and a spot beside it (where they stand). Places closer than 70 m merge.
  buildPlaces() {
    const out = [];
    const near = (x, z) => out.some((p) => hyp(p.x, p.z, x, z) < 70);
    const kerb = (x, z) => { try { return nearestRoadPoint(x, z); } catch { return null; } };
    const add = (name, ax, az, stand = null) => {
      if (!name || !Number.isFinite(ax) || !Number.isFinite(az)) return;
      const k = kerb(ax, az);
      if (!k || k.d > 45 || near(k.x, k.z)) return;
      let sx = stand?.x, sz = stand?.z;
      if (!stand) {
        // beside the road (the side further from any other lane), a step off the plowed edge
        const r = k.r, i = Math.max(1, Math.min(r.n - 2, k.i));
        let dx = r.X[i + 1] - r.X[i - 1], dz = r.Z[i + 1] - r.Z[i - 1];
        const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
        let best = -1;
        for (const sg of [1, -1]) {
          const x = k.x - dz * sg * (ROAD_HALF + 1.8), z = k.z + dx * sg * (ROAD_HALF + 1.8);
          let ld = 0; try { ld = laneDistance(x, z); } catch { ld = ROAD_HALF + 1.8; }
          if (ld > best) { best = ld; sx = x; sz = z; }
        }
      }
      out.push({ name, x: k.x, z: k.z, y: world.height(k.x, k.z), sx, sz });
    };
    for (const s of busRoads.stops || []) {
      if (s.noRoad) continue;
      let a = null; try { a = stopWaitArea(s); } catch { a = null; }
      add(s.name === 'Legacy Village' ? 'Legacy Village plaza' : s.name, a ? a.x : s.x, a ? a.z : s.z, a ? { x: a.x, z: a.z } : null);
    }
    for (const L of busRoads.lots || []) {
      const nm = L.rental ? 'the Car Rental' : L === busRoads.hospital || /medical/i.test(L.name || '') ? 'the medical centre' : L.name;
      add(nm, L.ex ?? L.x, L.ez ?? L.z);
    }
    add('the chalet village', CHALET_PLACE.x, CHALET_PLACE.z); // (when its stop / car park did not already cover it)
    return out;
  }
  get placeList() {
    if (!this.places || (!this.places.length && busRoads.ready)) this.places = busRoads.ready ? this.buildPlaces() : [];
    return this.places;
  }

  // ------------------------------------------------------------------ duty
  hasCar() { return !!this.drive?.d || !!this.carRental?.current; }
  /** The TAXI note on the job boards (jobs.js extraOffers): plain data for ui/jobboard.js. */
  boardOffer() {
    const car = this.hasCar();
    return {
      id: 'taxi', type: 'taxi', title: this.duty ? 'Legacy Taxi · on duty' : 'Legacy Taxi · drive fares',
      client: 'Legacy Taxi dispatch',
      brief: !car ? 'Drive guests round the resort in your own car. Rent a car at the Car Rental first, then come back.'
        : this.duty ? 'You are on duty: the dispatcher sends fares to your car. Press T in your car to end your shift.'
          : `Drive guests between bus stops, car parks, the chalets, the lift bases and the passes in your car. $${TARIFF.flag} + $${TARIFF.perKm / 10} per 100 m, a mountain surcharge, tips for a quick, smooth ride; knocks cost you, a wreck costs the fare. T in your car goes on or off duty.`,
      reward: 0, payText: '$40–250 a fare', bonus: 1, tipText: 'up to 25%', minutes: 'per fare', diff: 1,
      takeText: !car ? 'RENT A CAR FIRST' : this.duty ? 'END MY SHIFT' : 'GO ON DUTY',
      take: () => (this.duty ? this.goOffDuty() : this.goOnDuty(true)),
    };
  }
  goOnDuty(fromBoard = false) {
    if (!this.hasCar()) { this.hud?.flash('Rent a car at the Car Rental first', 'bad', 2600); this.audio?.play('error'); return false; }
    if (this.duty) { this.hud?.flash('Already on taxi duty · T in your car ends your shift', 'gold', 2400); return true; }
    if (fromBoard && this.busy?.()) { this.hud?.flash('Finish or cancel your current job first', 'bad', 2400); return false; }
    this.duty = true;
    this.shift = { fares: 0, earned: 0 };
    this.nextT = this.drive?.d ? 3 : 0.5;
    this.hud?.flash(this.drive?.d ? 'Taxi duty · waiting for a fare' : 'Taxi duty · get in your car', 'gold', 2400);
    this.audio?.play('click');
    return true;
  }
  goOffDuty(why = '') {
    if (!this.duty && !this.fare) return;
    const f = this.fare;
    if (f) {
      if (f.phase === 'ride') { this.say(f.name, pick(LINES.dumped), 'bad'); this.alight(false); } else this.walkOff();
      this.fare = null;
    }
    this.duty = false;
    const s = this.shift;
    this.hud?.flash(why || (s.fares ? `Shift over · ${s.fares} fare${s.fares > 1 ? 's' : ''} · ${money(s.earned)}` : 'Off duty'), why ? 'bad' : 'gold', 2800);
  }
  toggle() { if (this.duty || this.fare) this.goOffDuty(); else this.goOnDuty(); }

  // ------------------------------------------------------------------ a fare
  dispatch(d) {
    const P = this.placeList;
    if (P.length < 2) { this.goOffDuty('No taxi ranks on these roads'); return; }
    // the pickup: one of the nearer places (not right where you are), the destination well away from it
    const byDist = P.map((p) => ({ p, d: hyp(p.x, p.z, d.x, d.z) })).filter((o) => o.d > 120).sort((a, b) => a.d - b.d);
    if (!byDist.length) { this.nextT = 5; return; }
    const from = byDist[Math.floor(Math.random() * Math.min(4, byDist.length))].p;
    const far = P.filter((p) => p !== from && hyp(p.x, p.z, from.x, from.z) > 450);
    const to = far.length ? pick(far) : pick(P.filter((p) => p !== from));
    const straight = hyp(from.x, from.z, to.x, to.z), dy = to.y - from.y;
    const estKm = Math.max(straight * 1.3, Math.abs(dy) / 0.09) / 1000; // (switchbacks: ~9 % grade up a mountain road)
    const chars = this.jobs?.chars?.length ? this.jobs.chars : ['skier_green'];
    const avoid = this.player?.rigChar;
    const charList = chars.filter((c) => c !== avoid);
    const char = pick(charList.length ? charList : chars);
    const toPick = hyp(from.x, from.z, d.x, d.z);
    this.fare = {
      name: pick(GUESTS), char, from, to, phase: 'pickup', t: 0,
      patience: Math.max(150, toPick / 9 + 120), estKm, capKm: estKm * 1.4 + 0.4, estT: (estKm * 1000) / 12.5 + 25,
      surcharge: Math.round(Math.max(0, dy) / 100 * TARIFF.climb), km: 0, rideT: 0, knocks: 0, crashes: 0, scary: 0, fastT: 0, detour: false,
      dmg: 0, wreck: false,
    };
    this.hud?.flash(`Taxi · fare waiting at ${from.name} · ${toPick < 1000 ? Math.round(toPick) + ' m' : (toPick / 1000).toFixed(1) + ' km'}`, 'gold', 3200);
    this.audio?.play('chime');
  }

  fareNow(f = this.fare) {
    if (!f) return 0;
    return Math.min(TARIFF.max, TARIFF.flag + Math.min(f.km, f.capKm) * TARIFF.perKm + f.surcharge);
  }

  say(name, line, cls = 'good') {
    this.said = `${name}: "${line}"`;
    this.saidT = 6;
    this.hud?.flash(this.said, cls, 3400);
  }

  // ------------------------------------------------------------------ the passenger's body
  spawnPax(f) {
    if (this.pax) return;
    const pool = this.jobs?.pool;
    const slot = pool ? pool.take(f.char, this.player?.rigChar) : null;
    const rig = slot?.rig || null;
    const pos = new THREE.Vector3(f.from.sx, world.groundHeight(f.from.sx, f.from.sz), f.from.sz);
    const heading = Math.atan2(f.from.x - f.from.sx, f.from.z - f.from.sz); // (facing the road)
    const st = { mode: 'idle', heading, speed: 0, crouch: 0, lean: 0, plow: 0, tuck: false, normal: new THREE.Vector3(0, 1, 0), air: false, carry: false, seat: null };
    let root, fig = null;
    if (rig) {
      root = rig.root;
      this.group.add(rig.root);
      if (rig.gear) this.group.add(rig.gear);
      rig.setSkisVisible?.(false);
      rig.setCarry?.(false);
      rig.root.position.copy(pos);
      rig.root.rotation.y = heading;
      try { rig.update(1 / 30, st); rig.update(1 / 30, st); } catch { /* (posed next frame) */ }
      if (rig.fx) rig.fx.length = 0;
    } else {
      fig = makeFallbackFigure('stand');
      fig.position.copy(pos); fig.rotation.y = heading;
      this.group.add(fig);
      root = fig;
    }
    this.pax = { slot, rig, fig, root, st, pos, heading, acc: 0, seated: false };
  }
  dropPax(p = this.pax) {
    if (!p) return;
    if (p.rig) {
      this.group.remove(p.rig.root);
      if (p.rig.gear) this.group.remove(p.rig.gear);
      if (p.slot) this.jobs?.pool?.give(p.slot);
    } else if (p.fig) { this.group.remove(p.fig); p.fig.userData.ownGeometry?.dispose?.(); }
    if (p === this.pax) this.pax = null;
  }
  seatPoint(d, out) {
    const list = carSeats(d.t);
    if (!list?.length) return null;
    out.copy(list[Math.min(list.length - 1, paxSeat(list))]);
    return d.e.car.localToWorld(out);
  }
  doorPoint(d, out) {
    const list = carSeats(d.t);
    const s = list?.[Math.min(list.length - 1, paxSeat(list))];
    const sg = s && s.x > 0 ? 1 : -1, half = (d.t?.size?.x || 1.9) / 2;
    out.set(sg * (half + 0.55), 0, s ? s.z : -0.4);
    d.e.car.localToWorld(out);
    out.y = world.groundHeight(out.x, out.z);
    return out;
  }
  posePax(dt, d) {
    const p = this.pax;
    if (!p) return;
    const cam = this.player?.pos;
    const far = cam ? hyp(p.root.position.x, p.root.position.z, cam.x, cam.z) : 0;
    if (p.seated && d) {
      if (!this.seatPoint(d, p.pos)) return;
      p.st.mode = 'sit'; p.st.seat = p.pos; p.st.speed = 0; p.st.heading = d.yaw;
    }
    if (!p.rig) { p.root.position.copy(p.pos); p.root.rotation.y = p.heading; p.root.visible = !p.seated && far < SHOW_R; return; }
    const show = far < SHOW_R;
    if (p.rig.root.visible !== show) { p.rig.root.visible = show; if (p.rig.gear) p.rig.gear.visible = show; }
    if (!show) return;
    p.acc += dt;
    if (!p.seated && far > 60 && p.acc < 0.1) return;
    if (!p.seated) p.st.heading = p.heading;
    p.rig.root.position.copy(p.pos);
    try {
      p.rig.update(p.acc || 1 / 60, p.st);
      if (p.seated) carLegs(p.rig);
    } catch (e) { if (!this.poseErr) { this.poseErr = true; console.warn('taxi passenger pose', e); } }
    if (p.rig.fx) p.rig.fx.length = 0;
    p.acc = 0;
  }
  walk(p, tx, tz, dt) {
    const dx = tx - p.pos.x, dz = tz - p.pos.z, l = Math.hypot(dx, dz);
    if (l < 0.05) { p.st.mode = 'idle'; p.st.speed = 0; return l; }
    const s = Math.min(l, WALK_V * dt);
    p.pos.x += (dx / l) * s; p.pos.z += (dz / l) * s;
    p.pos.y = world.groundHeight(p.pos.x, p.pos.z);
    p.heading = Math.atan2(dx, dz);
    p.st.mode = 'walk'; p.st.speed = WALK_V; p.st.seat = null;
    return l - s;
  }

  // out of the car (paid: true) beside its rear door, then they walk off toward their place and go
  alight(paid) {
    const p = this.pax, f = this.fare, d = this.drive?.d;
    if (!p) return;
    p.seated = false;
    if (d) this.doorPoint(d, p.pos);
    else { const pp = this.player?.pos; if (pp) p.pos.set(pp.x + 1.5, world.groundHeight(pp.x + 1.5, pp.z), pp.z); }
    p.st.mode = 'idle'; p.st.seat = null; p.st.speed = 0;
    p.rig?.snapPose?.();
    const goal = paid && f ? { x: f.to.sx, z: f.to.sz } : { x: p.pos.x + Math.sin(p.heading) * 25, z: p.pos.z + Math.cos(p.heading) * 25 };
    this.leaving.push({ p, goal, t: 0 });
    this.pax = null;
  }
  // a passenger who never got in (cancelled, gave up): walks off and goes once out of the way
  walkOff() {
    const p = this.pax;
    if (!p) return;
    p.seated = false;
    this.leaving.push({ p, goal: { x: p.pos.x - Math.sin(p.heading) * 30, z: p.pos.z - Math.cos(p.heading) * 30 }, t: 0 });
    this.pax = null;
  }
  updateLeaving(dt) {
    const cam = this.player?.pos;
    for (let i = this.leaving.length - 1; i >= 0; i--) {
      const L = this.leaving[i];
      L.t += dt;
      const left = L.t > 1.2 ? this.walk(L.p, L.goal.x, L.goal.z, dt) : 1;
      if (L.t <= 1.2) { L.p.st.mode = 'idle'; L.p.st.speed = 0; }
      const far = cam ? hyp(L.p.pos.x, L.p.pos.z, cam.x, cam.z) : 999;
      if ((left < 0.3 && far > 25) || far > 120 || L.t > 40) { this.dropPax(L.p); this.leaving.splice(i, 1); continue; }
      const pp = this.pax; this.pax = L.p; this.posePax(dt, null); this.pax = pp;
    }
  }

  // ------------------------------------------------------------------ every frame
  update(dt, input) {
    if (!(dt > 0)) return;
    const live = !!input;
    const d = this.drive?.d || null;
    try {
      if (d && !this.wasIn) this.hintT = this.duty || this.busy?.() ? 0 : 12;
      this.wasIn = !!d;
      if (live) { this.hintT = Math.max(0, this.hintT - dt); this.saidT = Math.max(0, this.saidT - dt); }
      if (live && d && !d.crash && input.hit?.('KeyT')) this.toggle();
      if (this.duty && !this.hasCar() && !this.fare) this.goOffDuty('Taxi duty over · no car');
      if ((this.duty || this.fare) && this.busy?.()) this.goOffDuty('Taxi shift over · you took another job');
      const f = this.fare;
      if (f && live) this.step(f, dt, d);
      else if (this.duty && live && d && !d.crash) { this.nextT -= dt; if (this.nextT <= 0) this.dispatch(d); }
      this.posePax(dt, this.drive?.d || null);
      this.updateLeaving(dt);
    } catch (e) { if (!this.err) { this.err = true; console.warn('taxi', e); } }
    this.meter();
  }

  step(f, dt, d) {
    f.t += dt;
    const sp = this.drive?.speed || 0;
    if (f.phase === 'pickup' || f.phase === 'board') {
      f.patience -= dt;
      const pp = this.player?.pos;
      if (!this.pax && pp && hyp(pp.x, pp.z, f.from.sx, f.from.sz) < SHOW_R) this.spawnPax(f);
      if (f.patience <= 0 && f.phase === 'pickup') {
        this.hud?.flash(LINES.late(f.name), 'bad', 3000);
        this.walkOff(); this.fare = null; this.nextT = 6; return;
      }
      if (f.phase === 'pickup') {
        if (this.pax) { this.pax.st.mode = 'idle'; this.pax.st.speed = 0; }
        if (d && !d.crash && this.pax && sp < STOP_V && hyp(d.x, d.z, this.pax.pos.x, this.pax.pos.z) < PICK_R) {
          f.phase = 'board'; f.t = 0;
          this.say(f.name, pick(LINES.hail));
        }
        // (the pax faces your car as you pull up)
        if (d && this.pax && hyp(d.x, d.z, this.pax.pos.x, this.pax.pos.z) < 40) this.pax.heading = Math.atan2(d.x - this.pax.pos.x, d.z - this.pax.pos.z);
        return;
      }
      // boarding: walking to the rear door; you drive off, they stop where they are and wait
      const p = this.pax;
      if (!d || d.crash || !p) { f.phase = 'pickup'; return; }
      if (sp > 2.5) { f.phase = 'pickup'; p.st.mode = 'idle'; p.st.speed = 0; f.from = { ...f.from, sx: p.pos.x, sz: p.pos.z }; return; }
      const door = this.doorPoint(d, _v);
      const left = this.walk(p, door.x, door.z, dt);
      if (left < 0.4 || f.t > 12) {
        p.seated = true; p.rig?.snapPose?.();
        f.phase = 'ride'; f.t = 0; f.dmg = d.e.damage || 0;
        this.audio?.play('click');
        this.say(f.name, pick(LINES.pickup(f.to.name)));
      }
      return;
    }
    if (f.phase !== 'ride') return;
    // riding
    if (!d) {
      // out of the car: wrecked (they leave, no pay), at the destination (paid), anywhere else they wait a little
      // (back in within 25 s and the ride goes on), then leave without paying
      const pp = this.player?.pos;
      if (f.wreck) { this.say(f.name, pick(LINES.wreck), 'bad'); this.alight(false); this.fare = null; this.nextT = 8; return; }
      if (pp && hyp(pp.x, pp.z, f.to.x, f.to.z) < 60) { this.finish(f); return; }
      f.outT = (f.outT || 0) + dt;
      if (f.outT < 25) return;
      this.say(f.name, pick(LINES.dumped), 'bad'); this.alight(false); this.fare = null; this.nextT = 8; return;
    }
    f.outT = 0;
    if (d.crash) { f.wreck = true; return; } // (out once the wreck comes to rest: drive.js wreckOut)
    f.km += (sp * dt) / 1000;
    f.rideT += dt;
    // knocks and crashes: the car's damage jumping (drive.js knock / crash)
    const dmg = d.e.damage || 0;
    if (dmg > f.dmg + 0.5) {
      const jump = dmg - f.dmg;
      if (jump >= 10) { f.crashes++; this.say(f.name, pick(LINES.crash), 'bad'); }
      else { f.knocks++; if (performance.now() - (this.complainAt || 0) > 2500) this.say(f.name, pick(LINES.knock), 'bad'); }
      this.complainAt = performance.now();
    }
    f.dmg = dmg;
    // flat out on a mountain road
    f.fastT = sp > SCARY_V ? f.fastT + dt : 0;
    if (f.fastT > 3 && !f.scary) { f.scary = 1; this.say(f.name, pick(LINES.scary), 'bad'); }
    if (!f.detour && f.km > f.capKm) { f.detour = true; this.say(f.name, pick(LINES.detour), 'bad'); }
    // at the destination, stopped
    if (sp < STOP_V && hyp(d.x, d.z, f.to.x, f.to.z) < DROP_R) this.finish(f);
  }

  finish(f) {
    const base = Math.max(TARIFF.min, this.fareNow(f));
    const cut = Math.min(0.7, f.knocks * 0.12 + f.crashes * 0.3);
    const fare = Math.round(base * (1 - cut));
    const smooth = !f.knocks && !f.crashes && !f.scary, quick = f.rideT <= f.estT;
    let tipK = 0;
    if (!f.crashes) tipK = (quick ? TARIFF.tipQuick : 0) + (smooth ? TARIFF.tipSmooth + Math.random() * 0.05 : 0);
    const tip = Math.round(base * tipK);
    const pay = fare + tip;
    this.say(f.name, pick(tipK > 0.12 ? LINES.thanks : cut > 0 ? LINES.meh : LINES.thanks), cut > 0 ? 'bad' : 'good');
    this.alight(true);
    this.fare = null;
    this.nextT = 5 + Math.random() * 6;
    this.shift.fares++; this.shift.earned += pay;
    try { this.earn?.(pay, `Taxi fare · ${f.to.name}`); } catch (e) { console.warn('taxi pay', e); }
    const parts = [`Fare ${money(fare)}`];
    if (cut > 0) parts.push(`−${Math.round(cut * 100)}% for the bumps`);
    if (tip) parts.push(`tip ${money(tip)}`);
    setTimeout(() => this.hud?.flash(`${parts.join(' · ')} · ${money(pay)}`, 'gold', 3400), 1800);
  }

  // ------------------------------------------------------------------ HUD, waypoint, map
  hudLine() {
    const f = this.fare, d = this.drive?.d;
    if (f) {
      if (f.phase === 'pickup') return d ? `Taxi · pick up ${f.name} at ${f.from.name} · ${Math.max(0, Math.ceil(f.patience / 60))} min` : `Taxi · get back in your car · ${f.name} is waiting`;
      if (f.phase === 'board') return `Taxi · ${f.name} is getting in`;
      if (!d) return `Taxi · ${f.name} is waiting in your car · get back in`;
      return `Taxi · take ${f.name} to ${f.to.name}`;
    }
    if (this.duty) return d ? 'Taxi · on duty · waiting for a fare (T: off duty)' : 'Taxi duty · get in your car';
    if (d && this.hintT > 0) return 'Press T to go on taxi duty and earn fares';
    return '';
  }
  waypoint(pos) {
    const f = this.fare, w = this._wp;
    if (f) {
      if (f.phase === 'ride') { w.x = f.to.x; w.z = f.to.z; w.label = f.to.name; return w; }
      if (f.phase === 'pickup' && !this.drive?.d && this.carRental?.current?.car) { const c = this.carRental.current.car.position; w.x = c.x; w.z = c.z; w.label = 'Your car'; return w; }
      w.x = f.from.x; w.z = f.from.z; w.label = `${f.name} · ${f.from.name}`; return w;
    }
    if (this.duty && !this.drive?.d && this.carRental?.current?.car) { const c = this.carRental.current.car.position; w.x = c.x; w.z = c.z; w.label = 'Your car'; return w; }
    void pos;
    return null;
  }
  mapMarkers() {
    const f = this.fare;
    if (!f) return [];
    if (f.phase === 'ride') return [{ x: f.to.x, z: f.to.z, kind: 'target', label: `Taxi · ${f.to.name}` }];
    return [{ x: f.from.x, z: f.from.z, kind: 'target', label: `Taxi · ${f.name}` }, { x: f.to.x, z: f.to.z, kind: 'target', label: `→ ${f.to.name}` }];
  }

  meter() {
    if (typeof document === 'undefined') return;
    const f = this.fare, on = !!f && f.phase === 'ride' && !!this.drive?.d;
    if (!on) { if (this.el && !this.el.hidden) this.el.hidden = true; return; }
    if (!this.el) {
      if (!document.getElementById('taxi-css')) { const s = document.createElement('style'); s.id = 'taxi-css'; s.textContent = CSS; document.head.appendChild(s); }
      const el = document.createElement('div');
      el.id = 'taxi-meter';
      el.innerHTML = '<div class="tm-head">TAXI · METER</div><div class="tm-fare"></div><div class="tm-row tm-dist"></div><div class="tm-row tm-to"></div><div class="tm-say"></div>';
      (document.getElementById('hud') || document.body).appendChild(el);
      this.el = el;
      this.elF = el.querySelector('.tm-fare'); this.elD = el.querySelector('.tm-dist'); this.elT = el.querySelector('.tm-to'); this.elS = el.querySelector('.tm-say');
    }
    this.el.hidden = false;
    const fare = `$${this.fareNow(f).toFixed(2)}`;
    const dist = `${f.km.toFixed(2)} km · ${Math.floor(f.rideT / 60)}:${String(Math.floor(f.rideT % 60)).padStart(2, '0')}${f.surcharge ? ` · incl. $${f.surcharge} mountain` : ''}`;
    const to = `${f.name} → ${f.to.name}`;
    const said = this.saidT > 0 ? this.said : '';
    if (this.elF.textContent !== fare) this.elF.textContent = fare;
    if (this.elD.textContent !== dist) this.elD.textContent = dist;
    if (this.elT.textContent !== to) this.elT.textContent = to;
    if (this.elS.textContent !== said) this.elS.textContent = said;
  }

  dispose() {
    this.dropPax();
    for (const L of this.leaving) this.dropPax(L.p);
    this.leaving.length = 0;
    this.group.parent?.remove(this.group);
    this.el?.remove();
  }
}
