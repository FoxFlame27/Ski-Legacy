// LEGACY TAXI: drive fares round the resort in a car of your own. A job like the others (Oct 30, the user: "make taxi
// by jobs but only if you have a car"): the TAXI note on every job board, greyed out until you own a car (bought at the
// Autohaus); take it and you are on duty in your car (the one out; none out: take one out at the Autohaus, MY CARS).
// The dispatcher sends you to someone waiting at a bus stop, a lift station, a hotel, a car park, the chalet village,
// the medical centre... (on foot beside the road: the job people's rigs, jobs/actors.js RigPool). Stop beside them and
// they walk round your car (never through it: walkPath) to the back door on the kerb side and sit in the back seat
// (carpeople.js seats and legs), say where they're going, and the meter runs: a flag fall, a tick every 100 m driven
// (capped near the usual route, so a detour earns nothing), a fixed mountain surcharge for the climb, against a time
// limit (late: a cut and no tip). Stop at their destination and they get out and walk off round the car and pay, with a
// tip for a quick, smooth ride. Knocks and crashes while they're aboard cost you (they complain); wreck the car and
// they leave without paying; a police chase (or jail) ends the fare. The board's note or T in your car ends your shift.
// Pay goes through main.js earn(..., 'job'): the server's job payout in multiplayer (EARN_RULES.job, per payout and per
// hour). Only you see your passenger (jobs keep their people local, as every job does).
import * as THREE from 'three';
import { world } from '../world/world.js';
import { busRoads, stopWaitArea, nearestRoadPoint, laneDistance, ROAD_HALF } from './bus/roads.js';
import { seatsFor, twoBone } from './carpeople.js';
import { driverEye } from './cars.js';
import { GUESTS } from './jobs/catalog.js';
import { makeFallbackFigure } from './jobs/props.js';
import { CHALET_PLACE } from './bus/chaletroad.js';
import { repairCost } from './carrental.js';

// the tariff: a flag fall plus a tick every 100 m (Oct 29, "a realistic way" to earn), priced as every other job
// (Oct 30, as a job on the board: jobs/catalog.js pays ~$150 a minute of the job, ~$9,000 an hour): the resort's road
// trips are 1-8 km, ~1.5-10 min at a mountain road's pace, so $18 every 100 m puts a fare at ~$150-1,500 by distance,
// before the tip (the drive to the pickup is unpaid, as the walk to a job is). One number to change: perKm
export const TARIFF = { flag: 60, perKm: 180, climb: 15 /* per 100 m up */, min: 150, max: 2200, tipQuick: 0.1, tipSmooth: 0.1, lateCut: 0.25 };
const PICK_R = 16;        // m: stop this close to the passenger and they come over
const DROP_R = 20;        // m: ...and this close to the destination's kerb to let them out
const STOP_V = 1.6;       // m/s: stopped (enough)
const WALK_V = 1.5;       // m/s: a passenger walking to / from your car
const SCARY_V = 125 / 3.6; // m/s: faster than this for a few seconds frightens them
const SHOW_R = 420;       // m: the passenger is built (from the pool) when you are this close
const CAR_GAP = 0.55;     // m: a walking passenger keeps this clear of the car's box (walkPath)
// the hotels round the plaza (world/village.js: their spots) and their names on the dispatcher's list
const HOTELS = [[62, 34, 'Hotel Alpenrose'], [-74, 44, 'Hotel Edelweiss'], [100, -34, 'Hotel Bergkristall'], [-108, -60, 'Hotel Gletscherblick'],
  [22, 92, 'Hotel Tannenhof'], [-36, 108, 'Hotel Schneeweiss'], [118, 70, 'Hotel Sonnalp'], [-128, 22, 'Hotel Steinbock']];
const LINES = {
  hail: ['Hi! Thanks for coming.', 'Oh good, my taxi!', 'Perfect timing.', 'Hello! Am I glad to see you.', 'Grüezi! I booked a cab.'],
  pickup: (to) => [`${to}, please.`, `Could you take me to ${to}?`, `To ${to}, please. No rush.`, `${to}, please. My friends are waiting.`, `Take me to ${to}? Thanks!`],
  knock: ['Ouch! Easy there!', 'Hey, careful!', 'Watch it, please!', 'Whoa! Is this a bumper car?', 'My coffee! Careful!'],
  crash: ['Are you trying to kill me?!', 'That was a crash! I am not paying full fare for this.', 'Unbelievable. Just get me there in one piece.'],
  scary: ['Slow down, please! This is not a race.', 'Could you drive a bit slower? Please?'],
  detour: ['Is this really the way?', 'I think we went the wrong way.'],
  // paying, in their own words (finish: how the ride went; the only text shown with the money)
  paidGreat: ['Wow, you got me there fast! And so smooth!', 'Best taxi in the Alps. Keep the change!', 'Quick and smooth as fresh corduroy. Thank you!'],
  paidFast: ['Wow, you got me there fast!', 'That was quick, thanks!', 'Made it in no time!'],
  paidSmooth: ['Thanks, smooth ride!', 'Lovely ride, thank you!', 'Nice and relaxed, thanks.'],
  paidOk: ['Thanks for the ride.', 'Here you go, thanks.', 'Cheers, see you around.'],
  paidSlow: ['That took forever...', 'Finally. I am so late now.', 'Next time I take the bus.'],
  paidBumpy: ['Bit of a bumpy ride...', 'We made it. Somehow.', 'Thanks... I think. Mind the kerbs.'],
  paidScary: ['Never again that fast, please.', 'My heart is still racing...', 'You drive like it is a race!'],
  paidCrash: ['You crashed! I am not paying full fare.', 'Here. Take a driving lesson.', 'I am lucky to be alive...'],
  wreck: ["I'm out of here!", 'I am walking from here. And I am not paying!'],
  dumped: ['You are leaving me HERE? Forget the fare.', 'This is not where I wanted to go!'],
  late: (n) => `${n} gave up waiting and took the bus`,
  overdue: ['We are late. I said I was in a hurry!', 'Finally. That took forever.', 'I missed my lesson because of this.'],
  police: ["I'm not riding with a criminal!", 'Police?! Let me out, NOW!', 'I am not part of this! Let me out!', 'No way. I will walk from here.'],
  policeWait: ["The police are after you? I'm not getting in!", 'Is that a police car after you? Forget it.'],
};
const pick = (a) => a[Math.floor(Math.random() * a.length) % a.length];
const money = (v) => `$${Math.round(v).toLocaleString('en-US')}`;
const hyp = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);
const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const far = (m) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);
const _v = new THREE.Vector3(), _door = new THREE.Vector3(), _hip = new THREE.Vector3(), _tgt = new THREE.Vector3(), _pole = new THREE.Vector3();

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
// the passenger's seat: the back seat behind the front passenger (the kerb side; a car without a back seat: the front
// passenger seat). Multiplayer: the front one stays free for a friend either way
const paxSeat = (list) => (list.length > 3 ? 3 : 1);
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

// ROUND THE CAR, NOT THROUGH IT (Oct 30, the user): a walking passenger's way between two points in the car's own frame
// (x across, z along; the car centred), keeping out of its box widened by CAR_GAP (hx, hz): straight when the line is
// clear, otherwise the shortest way via the box's corners (round the bonnet or round the boot, whichever is shorter).
// Starting inside the box (stood right against the car): out sideways first. Returns the points after `a` (b last).
function segHitsBox(ax, az, bx, bz, hx, hz) {
  // (slab test, the box shrunk a hair so a corner-to-corner leg along its edge counts as clear)
  const ex = hx - 0.02, ez = hz - 0.02;
  let t0 = 0, t1 = 1;
  for (const [p, d, h] of [[ax, bx - ax, ex], [az, bz - az, ez]]) {
    if (Math.abs(d) < 1e-9) { if (p <= -h || p >= h) return false; continue; }
    let u = (-h - p) / d, v = (h - p) / d;
    if (u > v) [u, v] = [v, u];
    t0 = Math.max(t0, u); t1 = Math.min(t1, v);
    if (t0 >= t1) return false;
  }
  return true;
}
export function pathRound(ax, az, bx, bz, hx, hz) {
  const out = [];
  if (Math.abs(ax) < hx && Math.abs(az) < hz) { // (inside: the nearer long side first)
    ax = (ax >= 0 ? 1 : -1) * (hx + 0.05); out.push({ x: ax, z: az });
  }
  if (!segHitsBox(ax, az, bx, bz, hx, hz)) { out.push({ x: bx, z: bz }); return out; }
  // the corners (just outside), a, b: shortest way through those that see each other (6 points, Dijkstra by hand)
  const cx = hx + 0.05, cz = hz + 0.05;
  const P = [{ x: ax, z: az }, { x: cx, z: cz }, { x: -cx, z: cz }, { x: -cx, z: -cz }, { x: cx, z: -cz }, { x: bx, z: bz }];
  const n = P.length, dist = new Array(n).fill(Infinity), prev = new Array(n).fill(-1), done = new Array(n).fill(false);
  dist[0] = 0;
  for (let k = 0; k < n; k++) {
    let i = -1;
    for (let j = 0; j < n; j++) if (!done[j] && (i < 0 || dist[j] < dist[i])) i = j;
    if (i < 0 || dist[i] === Infinity) break;
    done[i] = true;
    for (let j = 0; j < n; j++) {
      if (done[j] || segHitsBox(P[i].x, P[i].z, P[j].x, P[j].z, hx, hz)) continue;
      const nd = dist[i] + Math.hypot(P[i].x - P[j].x, P[i].z - P[j].z);
      if (nd < dist[j]) { dist[j] = nd; prev[j] = i; }
    }
  }
  if (prev[n - 1] < 0) { out.push({ x: bx, z: bz }); return out; } // (never: the corners always see round)
  const way = [];
  for (let j = n - 1; j > 0; j = prev[j]) way.unshift(P[j]);
  return out.concat(way);
}

const CSS = `
#taxi-meter { position: absolute; right: 22px; bottom: 132px; box-sizing: border-box; width: max(270px, calc(var(--u) * 340)); padding: calc(var(--u) * 14) calc(var(--u) * 30) calc(var(--u) * 18) calc(var(--u) * 30);
  color: var(--blue, #1546c8); pointer-events: none; isolation: isolate; filter: drop-shadow(0 calc(var(--u) * 6) calc(var(--u) * 14) rgba(0, 20, 60, 0.3));
  animation: tm-in 0.45s cubic-bezier(.2,.9,.2,1) backwards; }
#taxi-meter[hidden] { display: none; }
/* (white paper with a gently ragged edge in u, as the controls card: the % brush is too torn at this size) */
#taxi-meter::before { content: ''; position: absolute; inset: 0; z-index: -1; background: #fff;
  clip-path: polygon(0 calc(var(--u) * 4), 18% 0, 41% calc(var(--u) * 5), 64% calc(var(--u) * 1), 87% calc(var(--u) * 5), 100% 0, calc(100% - var(--u) * 4) 34%, 100% 68%,
    calc(100% - var(--u) * 2) 100%, 73% calc(100% - var(--u) * 5), 48% 100%, 23% calc(100% - var(--u) * 4), 0 100%, calc(var(--u) * 4) 60%, 0 30%); }
#taxi-meter .tm-strip { height: calc(var(--u) * 9); margin: 0 calc(var(--u) * -8) calc(var(--u) * 10); clip-path: var(--brush-b);
  background: repeating-linear-gradient(90deg, #ffc21a 0 calc(var(--u) * 12), #14213d calc(var(--u) * 12) calc(var(--u) * 24)); }
#taxi-meter .tm-top { display: flex; align-items: center; justify-content: space-between; gap: calc(var(--u) * 10); }
#taxi-meter .tm-tag { padding: calc(var(--u) * 3) calc(var(--u) * 16) calc(var(--u) * 3) calc(var(--u) * 11); background: #ffc21a; color: #14213d; clip-path: var(--brush-b);
  font: italic 700 calc(var(--u) * 22)/1 var(--num); letter-spacing: 0.1em; }
#taxi-meter .tm-state { display: flex; align-items: center; gap: calc(var(--u) * 6); font: 800 var(--t-xs)/1 var(--ui); letter-spacing: 0.16em; color: var(--blue-dim, #4f72d4); white-space: nowrap; }
#taxi-meter .tm-state::before { content: ''; width: calc(var(--u) * 8); height: calc(var(--u) * 8); min-width: 6px; min-height: 6px; border-radius: 50%; background: currentColor; }
#taxi-meter.ride .tm-state { color: #ff4d3d; }
#taxi-meter.ride .tm-state::before { animation: tm-blink 1s steps(1) infinite; }
#taxi-meter .tm-big { margin: calc(var(--u) * 6) 0 calc(var(--u) * 2); font: italic 700 calc(var(--u) * 66)/0.95 var(--num); letter-spacing: 0.01em; font-variant-numeric: tabular-nums; white-space: nowrap; }
#taxi-meter.idle .tm-big { font-size: calc(var(--u) * 44); }
#taxi-meter .tm-grid { display: grid; grid-template-columns: 1fr 1fr; gap: calc(var(--u) * 12); padding: calc(var(--u) * 8) 0; border-top: 2px solid rgba(21, 70, 200, 0.14); border-bottom: 2px solid rgba(21, 70, 200, 0.14); }
#taxi-meter .tm-grid div + div { text-align: right; }
#taxi-meter small { display: block; font: 800 var(--t-xs)/1 var(--ui); letter-spacing: 0.16em; color: var(--blue-dim, #4f72d4); white-space: nowrap; }
#taxi-meter .tm-grid b { display: block; margin-top: calc(var(--u) * 3); font: italic 700 calc(var(--u) * 30)/1 var(--num); font-variant-numeric: tabular-nums; white-space: nowrap; }
#taxi-meter .tm-line { display: grid; grid-template-columns: calc(var(--u) * 92) minmax(0, 1fr) auto; align-items: baseline; gap: calc(var(--u) * 8); margin-top: calc(var(--u) * 8); }
#taxi-meter .tm-line span { font: italic 700 max(15px, calc(var(--u) * 21))/1.1 var(--num); letter-spacing: 0.02em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#taxi-meter .tm-line em { font: 700 var(--t-sm)/1 var(--ui); font-style: normal; color: var(--blue-dim, #4f72d4); font-variant-numeric: tabular-nums; white-space: nowrap; }
#taxi-meter .tm-line:has(span:empty), #taxi-meter .tm-grid:has(b:empty) { display: none; }
#taxi-meter .tm-extra { margin-top: calc(var(--u) * 6); font: 700 var(--t-xs)/1.2 var(--ui); letter-spacing: 0.04em; color: var(--blue-dim, #4f72d4); }
#taxi-meter .tm-say { position: relative; margin-top: calc(var(--u) * 10); padding: calc(var(--u) * 7) calc(var(--u) * 16) calc(var(--u) * 8) calc(var(--u) * 14); background: var(--blue, #1546c8); color: #fff;
  clip-path: var(--brush-b); font: italic 600 var(--t-sm)/1.3 var(--ui); }
#taxi-meter .tm-say.bad { background: #d0342c; }
#taxi-meter .tm-extra:empty, #taxi-meter .tm-say:empty { display: none; }
@keyframes tm-in { from { opacity: 0; translate: calc(var(--u) * 40) 0; } }
@keyframes tm-blink { 50% { opacity: 0.15; } }`;

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
   * @param {object} [o.layout]     world layout (the lift stations)
   * @param {() => boolean} [o.chased]  a police chase (or jail) under way: the fare is off
   */
  constructor({ scene, player, drive, carRental = null, jobs = null, hud, audio = null, earn, busy = null, layout = null, chased = null }) {
    Object.assign(this, { scene, player, drive, carRental, jobs, hud, audio, earn, busy, layout, chased });
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
  // Bus stops (their waiting area), the lift stations, the hotels, car parks, the medical centre, the car rental, the
  // chalet village: each a kerb point on a road (where you stop) and a spot beside it (where they stand). Places closer
  // than 70 m merge (the first named wins: a bus stop before the lift station beside it).
  buildPlaces() {
    const out = [];
    const near = (x, z) => out.some((p) => hyp(p.x, p.z, x, z) < 70);
    const kerb = (x, z) => { try { return nearestRoadPoint(x, z); } catch { return null; } };
    const add = (name, ax, az, stand = null, reach = 45) => {
      if (!name || !Number.isFinite(ax) || !Number.isFinite(az)) return;
      const k = kerb(ax, az);
      if (!k || k.d > reach || near(k.x, k.z)) return;
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
    for (const l of this.layout?.lifts || []) { // (the bottom stations: where skiers wait for a ride back)
      if (l?.bottom && l.name) add(`the ${l.name} station`, l.bottom.x, l.bottom.z, null, 60);
    }
    for (const [x, z, name] of HOTELS) add(name, x, z, null, 70);
    for (const L of busRoads.lots || []) {
      const nm = L.rental ? 'the Autohaus' : L === busRoads.hospital || /medical/i.test(L.name || '') ? 'the medical centre' : L.name;
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
  /** Do you own a car? (your garage: single player save.garage, multiplayer the server's profile cars) */
  hasCar() { return (this.carRental?.garage?.length || 0) > 0; }
  /** Your car you drive now (a car of your garage: drive.js only lets you into your own) or null. */
  myDrive() { const d = this.drive?.d; return d && d.e?.rental ? d : null; }
  /** Your car standing in the world: the one out, else another of yours parked out (carRental.kept). */
  myCar() { const R = this.carRental; return R?.current?.car || R?.kept?.find?.((e) => e?.car && !e.wrecked)?.car || null; }
  /** A damaged car can't start a taxi job or take a new fare (Oct 30, the user: "you can not start a taxi ride if your
   *  car is damaged"): the car you drive (else the one out) with any damage the Werkstatt would repair (its quote: the
   *  damage %, dents) or wrecked -> the message, '' when it is fine. A fare under way still finishes. */
  damageBlock() {
    const e = this.myDrive()?.e || this.carRental?.current;
    if (!e) return '';
    let frac = e.wrecked || this.myDrive()?.crash ? 1 : Math.max(0, Math.min(1, (e.damage || 0) / 100));
    if (frac <= 0 && e.dents?.length) frac = 0.01;
    if (!(frac > 0)) return '';
    let fee = 0; try { fee = repairCost(e.cfg?.id || e.name, frac); } catch { fee = 0; }
    return `Your car is damaged · repair it at the Werkstatt first${fee > 0 ? ` (${money(fee)})` : ''}`;
  }
  /** The TAXI note on the job boards (jobs.js extraOffers): plain data for ui/jobboard.js. No car of your own (or your
   *  car damaged): greyed out (locked), "Buy a car at the Autohaus first" / "Your car is damaged · repair it...". */
  boardOffer() {
    const car = this.hasCar(), dmg = car && !this.duty ? this.damageBlock() : '';
    return {
      id: 'taxi', type: 'taxi', title: this.duty ? 'Legacy Taxi · on duty' : 'Legacy Taxi · drive fares',
      client: 'Legacy Taxi dispatch',
      brief: !car ? 'Drive guests round the resort in your own car. Buy a car at the Autohaus first, then come back.'
        : this.duty ? 'You are on duty: the dispatcher sends fares to your car. End your shift here, or with T in your car.'
          : 'Drive guests between bus stops, lift stations, hotels, car parks and the chalets in your own car. The meter pays by distance, with a tip for a quick, smooth ride; knocks and crashes cost you, a wreck or a police chase costs the fare.',
      reward: 0, payText: `$${TARIFF.min}–1,500 a fare`, bonus: 1, tipText: 'up to 25%', minutes: 'per fare', diff: 1,
      locked: (!car || !!dmg) && !this.duty, lockText: !car ? 'Buy a car at the Autohaus first' : dmg,
      takeText: !car ? 'BUY A CAR FIRST' : this.duty ? 'END MY SHIFT' : dmg ? 'REPAIR YOUR CAR FIRST' : 'GO ON DUTY',
      take: () => (this.duty ? this.goOffDuty() : this.goOnDuty()),
    };
  }
  goOnDuty() {
    if (!this.hasCar()) { this.hud?.flash('Buy a car at the Autohaus first', 'bad', 2600); this.audio?.play('error'); return false; }
    if (this.duty) { this.hud?.flash('Already on taxi duty · T in your car ends your shift', 'gold', 2400); return true; }
    if (this.busy?.()) { this.hud?.flash('Finish or cancel your current job first', 'bad', 2400); return false; }
    if (this.chased?.()) { this.hud?.flash('Not while the police are after you', 'bad', 2400); return false; }
    const dmg = this.damageBlock();
    if (dmg) { this.hud?.flash(dmg, 'bad', 3000); this.audio?.play('error'); return false; }
    this.duty = true;
    this.shift = { fares: 0, earned: 0 };
    this.nextT = this.myDrive() ? 3 : 0.5;
    this.hud?.flash(this.myDrive() ? 'Taxi duty · waiting for a fare' : this.myCar() ? 'Taxi duty · get in your car' : 'Taxi duty · take a car out at the Autohaus (MY CARS)', 'gold', 2800);
    this.audio?.play('click');
    return true;
  }
  goOffDuty(why = '', lines = LINES.dumped) {
    if (!this.duty && !this.fare) return;
    const f = this.fare;
    if (f) {
      if (f.phase === 'ride') { this.say(f.name, pick(lines), 'bad'); this.alight(false); } else this.walkOff();
      this.fare = null;
    }
    this.duty = false;
    const s = this.shift;
    this.hud?.flash(why || (s.fares ? `Shift over · ${s.fares} fare${s.fares > 1 ? 's' : ''} · ${money(s.earned)}` : 'Off duty'), why ? 'bad' : 'gold', 2800);
  }
  /** Wanted (the police after you, a chase, jail): the fare is cancelled, nothing paid (Oct 30, the user: "make sure
   *  the taxi ride gets cancelled when you are in police chase"). Waiting for you: they walk off at once. Aboard: they
   *  get out as soon as the car stops (step: f.cancel), round the car, and walk off. Your shift goes on, but no new
   *  fares come while you are wanted (update). */
  policeCancel() {
    const f = this.fare;
    if (!f || f.cancel) return;
    if (f.phase === 'ride') { f.cancel = true; this.said = `${f.name}: "${pick(LINES.police)}"`; this.saidT = 8; this.sayBad = true; this.hud?.flash(`Taxi cancelled · stop and let ${f.name} out`, 'bad', 3200); this.audio?.play('error'); return; }
    const line = pick(LINES.policeWait);
    this.walkOff(); this.fare = null; this.nextT = 8;
    this.said = `${f.name}: "${line}"`; this.saidT = 6; this.sayBad = true;
    this.hud?.flash(`Taxi cancelled · '${line}'`, 'bad', 3600);
  }
  /** A cancelled fare's passenger out of the car (stopped, or you got out): no pay. */
  cancelOut(f) {
    const line = pick(LINES.police);
    this.alight(false); this.fare = null; this.nextT = 8;
    this.said = `${f.name}: "${line}"`; this.saidT = 6; this.sayBad = true;
    this.hud?.flash(`Taxi cancelled · '${line}'`, 'bad', 3600);
  }

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
      limit: Math.round(((estKm * 1000) / 12.5 + 25) * 1.6 + 45), late: false, // (the time to get them there: late, a cut and no tip)
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
    this.saidT = 6; this.sayBad = cls === 'bad';
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
  doorPoint(d, out, local = false) {
    const list = carSeats(d.t);
    const s = list?.[Math.min(list.length - 1, paxSeat(list))];
    const sg = s && s.x > 0 ? 1 : -1, half = (d.t?.size?.x || 1.9) / 2;
    out.set(sg * (half + CAR_GAP + 0.1), 0, s ? s.z : -0.4); // (just outside the box walkPath keeps clear of)
    if (local) return out;
    d.e.car.localToWorld(out);
    out.y = world.groundHeight(out.x, out.z);
    return out;
  }
  /** The car's box a passenger walks round (its own frame, centred): half width and half length plus CAR_GAP. */
  carBox(obj, t, length) {
    return { hx: (t?.size?.x || 1.9) / 2 + CAR_GAP, hz: (length || t?.size?.z || 4.6) / 2 + CAR_GAP, obj };
  }
  /** World waypoints from (ax, az) to (bx, bz) round the car `box` (carBox), as it stands now. */
  planRound(box, ax, az, bx, bz) {
    const o = box?.obj;
    if (!o) return [{ x: bx, z: bz }];
    o.updateMatrixWorld(true);
    const a = o.worldToLocal(_v.set(ax, world.groundHeight(ax, az), az)), lax = a.x, laz = a.z;
    const b = o.worldToLocal(_v.set(bx, world.groundHeight(bx, bz), bz)), lbx = b.x, lbz = b.z;
    return pathRound(lax, laz, lbx, lbz, box.hx, box.hz).map((q, i, L) => {
      if (i === L.length - 1) return { x: bx, z: bz };
      o.localToWorld(_v.set(q.x, 0, q.z));
      return { x: _v.x, z: _v.z };
    });
  }
  /** Along `way` (world points; the first one dropped as it is reached). Returns the way still left (m). */
  walkPath(p, way, dt) {
    if (!way.length) { p.st.mode = 'idle'; p.st.speed = 0; return 0; }
    let left = this.walk(p, way[0].x, way[0].z, dt);
    if (left < 0.12 && way.length > 1) { way.shift(); left = this.walk(p, way[0].x, way[0].z, 0); }
    for (let i = 1; i < way.length; i++) left += hyp(way[i - 1].x, way[i - 1].z, way[i].x, way[i].z);
    return left;
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

  // out of the car (paid: true) beside its rear door (outside the box they walk round), then they walk off toward their
  // place round the car (planRound: never through it) and go
  alight(paid) {
    const p = this.pax, f = this.fare, d = this.myDrive() || this.drive?.d;
    if (!p) return;
    p.seated = false;
    let box = null;
    if (d) { this.doorPoint(d, p.pos); box = this.carBox(d.e.car, d.t, d.e.length); p.heading = d.yaw + (this.doorPoint(d, _door, true).x > 0 ? Math.PI / 2 : -Math.PI / 2); }
    else {
      const pp = this.player?.pos, car = this.myCar();
      if (pp) p.pos.set(pp.x + 1.5, world.groundHeight(pp.x + 1.5, pp.z), pp.z);
      if (car) box = this.carBox(car, null, 5);
    }
    p.st.mode = 'idle'; p.st.seat = null; p.st.speed = 0;
    p.rig?.snapPose?.();
    const goal = paid && f ? { x: f.to.sx, z: f.to.sz } : { x: p.pos.x + Math.sin(p.heading) * 25, z: p.pos.z + Math.cos(p.heading) * 25 };
    this.leaving.push({ p, way: this.planRound(box, p.pos.x, p.pos.z, goal.x, goal.z), t: 0 });
    this.pax = null;
  }
  // a passenger who never got in (cancelled, gave up): walks off (round your car when it stands by) and goes once out of the way
  walkOff() {
    const p = this.pax;
    if (!p) return;
    p.seated = false;
    const d = this.myDrive(), box = d ? this.carBox(d.e.car, d.t, d.e.length) : null;
    const gx = p.pos.x - Math.sin(p.heading) * 30, gz = p.pos.z - Math.cos(p.heading) * 30;
    this.leaving.push({ p, way: this.planRound(box, p.pos.x, p.pos.z, gx, gz), t: 0 });
    this.pax = null;
  }
  updateLeaving(dt) {
    const cam = this.player?.pos;
    for (let i = this.leaving.length - 1; i >= 0; i--) {
      const L = this.leaving[i];
      L.t += dt;
      const left = L.t > 1.2 ? this.walkPath(L.p, L.way, dt) : 1;
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
    const d = this.myDrive();
    try {
      // (the first time in your car each session, off duty: where the taxi job is)
      if (d && !this.wasIn && !this.hinted && !this.duty && !this.busy?.()) { this.hintT = 8; this.hinted = true; }
      this.wasIn = !!d;
      if (live) { this.hintT = Math.max(0, this.hintT - dt); this.saidT = Math.max(0, this.saidT - dt); }
      // T in your car ends the shift (going on duty is the job board's TAXI note)
      if (live && d && !d.crash && (this.duty || this.fare) && input.hit?.('KeyT')) this.goOffDuty();
      const wanted = !!this.chased?.();
      if (this.fare && wanted) this.policeCancel();
      if (this.duty && !this.hasCar() && !this.fare) this.goOffDuty('Taxi duty over · no car');
      if ((this.duty || this.fare) && this.busy?.()) this.goOffDuty('Taxi shift over · you took another job');
      const f = this.fare;
      if (f && live) this.step(f, dt, d);
      else if (this.duty && live && d && !d.crash && !wanted && !this.damageBlock()) { this.nextT -= dt; if (this.nextT <= 0) this.dispatch(d); } // (no new fares while wanted or with a damaged car)
      this.posePax(dt, d);
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
      // boarding: walking round the car (the shorter way, round the bonnet or the boot; planned afresh each frame from
      // where they are, so a creeping car is followed) to its back door; you drive off, they stop where they are and wait
      const p = this.pax;
      if (!d || d.crash || !p) { f.phase = 'pickup'; return; }
      if (sp > 2.5) { f.phase = 'pickup'; p.st.mode = 'idle'; p.st.speed = 0; f.from = { ...f.from, sx: p.pos.x, sz: p.pos.z }; return; }
      const door = this.doorPoint(d, _door);
      const left = this.walkPath(p, this.planRound(this.carBox(d.e.car, d.t, d.e.length), p.pos.x, p.pos.z, door.x, door.z), dt);
      if (left < 0.4 || f.t > 25) {
        p.seated = true; p.rig?.snapPose?.();
        f.phase = 'ride'; f.t = 0; f.dmg = d.e.damage || 0;
        this.audio?.play('click');
        this.say(f.name, pick(LINES.pickup(f.to.name)));
      }
      return;
    }
    if (f.phase !== 'ride') return;
    // cancelled by the police: out as soon as you stop (or get out), nothing paid
    if (f.cancel) { if (!d || (!d.crash && sp < STOP_V)) this.cancelOut(f); return; } // (a wreck: once it lies still and you are out)
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
    if (!f.late && f.rideT > f.limit) { f.late = true; this.say(f.name, pick(LINES.overdue), 'bad'); }
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
    const smooth = !f.knocks && !f.crashes && !f.scary, quick = !f.late && f.rideT <= f.estT;
    let tipK = 0;
    if (!f.crashes && !f.late) tipK = (quick ? TARIFF.tipQuick : 0) + (smooth ? TARIFF.tipSmooth + Math.random() * 0.05 : 0);
    const pay = Math.max(1, Math.round(fare * (f.late ? 1 - TARIFF.lateCut : 1) + base * tipK));
    // what you see (Oct 30, the user): only the amount and the passenger's own reason, never the sum behind it
    const why = pick(f.crashes ? LINES.paidCrash : f.late ? LINES.paidSlow : f.knocks ? LINES.paidBumpy : f.scary ? LINES.paidScary
      : quick && smooth ? LINES.paidGreat : quick ? LINES.paidFast : smooth ? LINES.paidSmooth : LINES.paidOk);
    const good = !f.crashes && !f.late && !f.knocks && !f.scary;
    this.said = `${f.name}: "${why}"`; this.saidT = 6; this.sayBad = !good;
    this.alight(true);
    this.fare = null;
    this.nextT = 5 + Math.random() * 6;
    this.shift.fares++; this.shift.earned += pay;
    try { this.earn?.(pay, 'Taxi fare'); } catch (e) { console.warn('taxi pay', e); }
    this.hud?.flash(`+${money(pay)} · '${why}'`, good ? 'gold' : 'bad', 4200);
  }

  // ------------------------------------------------------------------ HUD, waypoint, map
  hudLine() {
    const f = this.fare, d = this.myDrive();
    if (f) {
      if (f.phase === 'pickup') return d ? `Taxi · pick up ${f.name} at ${f.from.name} · ${Math.max(0, Math.ceil(f.patience / 60))} min` : `Taxi · get back in your car · ${f.name} is waiting`;
      if (f.phase === 'board') return `Taxi · ${f.name} is getting in`;
      if (f.cancel) return `Taxi cancelled · stop and let ${f.name} out`;
      if (!d) return `Taxi · ${f.name} is waiting in your car · get back in`;
      const left = f.limit - f.rideT;
      return `Taxi · take ${f.name} to ${f.to.name} · ${left > 0 ? mmss(left) + ' left' : 'running late'}`;
    }
    const dmg = this.duty ? this.damageBlock() : '';
    if (dmg) return `Taxi · ${dmg}`;
    if (this.duty && d && this.chased?.()) return 'Taxi · no fares while the police are after you';
    if (this.duty) return d ? 'Taxi · on duty · waiting for a fare (T: off duty)' : this.myCar() ? 'Taxi duty · get in your car' : 'Taxi duty · take a car out at the Autohaus (MY CARS)';
    if (d && this.hintT > 0) return 'Earn fares with your car: take the TAXI note at any job board';
    return '';
  }
  waypoint(pos) {
    const f = this.fare, w = this._wp;
    if (f) {
      if (f.phase === 'ride') { w.x = f.to.x; w.z = f.to.z; w.label = f.to.name; return w; }
      const car = this.myDrive() ? null : this.myCar();
      if (f.phase === 'pickup' && car) { w.x = car.position.x; w.z = car.position.z; w.label = 'Your car'; return w; }
      w.x = f.from.x; w.z = f.from.z; w.label = `${f.name} · ${f.from.name}`; return w;
    }
    const car = this.duty && !this.myDrive() ? this.myCar() : null;
    if (car) { w.x = car.position.x; w.z = car.position.z; w.label = 'Your car'; return w; }
    void pos;
    return null;
  }
  mapMarkers() {
    const f = this.fare;
    if (!f) return [];
    if (f.phase === 'ride') return [{ x: f.to.x, z: f.to.z, kind: 'target', label: `Taxi · ${f.to.name}` }];
    return [{ x: f.from.x, z: f.from.z, kind: 'target', label: `Taxi · ${f.name}` }, { x: f.to.x, z: f.to.z, kind: 'target', label: `→ ${f.to.name}` }];
  }

  // the taxi card (bottom right, over the speedometer): on duty, in your car. Riding: the meter (the fare, big), the
  // distance and time, where to and how far still, the passenger, what they said; picking up: how far to them, their
  // patience; waiting for a fare: FOR HIRE
  meter() {
    if (typeof document === 'undefined') return;
    const f = this.fare, d = this.myDrive();
    const phase = !d || d.crash ? '' : f ? (f.phase === 'ride' ? 'ride' : 'pick') : this.duty ? 'idle' : '';
    if (!phase) { if (this.el && !this.el.hidden) this.el.hidden = true; return; }
    if (!this.el) {
      if (!document.getElementById('taxi-css')) { const s = document.createElement('style'); s.id = 'taxi-css'; s.textContent = CSS; document.head.appendChild(s); }
      const el = document.createElement('div');
      el.id = 'taxi-meter';
      el.innerHTML = '<div class="tm-strip"></div><div class="tm-top"><span class="tm-tag">TAXI</span><span class="tm-state"></span></div><div class="tm-big"></div>'
        + '<div class="tm-grid"><div><small></small><b></b></div><div><small></small><b></b></div></div>'
        + '<div class="tm-line"><small></small><span></span><em></em></div><div class="tm-line"><small></small><span></span><em></em></div><div class="tm-extra"></div><div class="tm-say"></div>';
      (document.getElementById('hud') || document.body).appendChild(el);
      this.el = el;
      const q = (c) => [...el.querySelectorAll(c)];
      this.tm = [el.querySelector('.tm-state'), el.querySelector('.tm-big'), ...q('.tm-grid small, .tm-grid b'), ...q('.tm-line small, .tm-line span, .tm-line em'), el.querySelector('.tm-extra'), el.querySelector('.tm-say')];
      this.tmPhase = '';
    }
    this.el.hidden = false;
    if (this.tmPhase !== phase) { this.el.classList.remove('ride', 'pick', 'idle'); this.el.classList.add(phase); this.tmPhase = phase; }
    const said = this.saidT > 0 ? this.said : '';
    const v = this._tmv ||= new Array(13).fill('');
    if (phase === 'ride') {
      v[0] = 'METER RUNNING'; v[1] = `$${this.fareNow(f).toFixed(2)}`;
      const left = f.limit - f.rideT;
      v[2] = 'DISTANCE'; v[3] = `${f.km.toFixed(2)} km`; v[4] = left > 0 ? 'TIME LEFT' : 'LATE'; v[5] = mmss(Math.abs(left));
      v[6] = 'TO'; v[7] = f.to.name; v[8] = far(hyp(d.x, d.z, f.to.x, f.to.z));
      v[9] = 'PASSENGER'; v[10] = f.name; v[11] = '';
      v[12] = left > 0 ? '' : `${f.name} is running late`;
    } else if (phase === 'pick') {
      const px = this.pax?.pos.x ?? f.from.sx ?? f.from.x, pz = this.pax?.pos.z ?? f.from.sz ?? f.from.z;
      v[0] = f.phase === 'board' ? 'GETTING IN' : 'PICK UP'; v[1] = f.phase === 'board' ? 'Boarding…' : far(hyp(d.x, d.z, px, pz));
      v[2] = 'WAITING'; v[3] = mmss(Math.max(0, f.patience)); v[4] = 'TRIP'; v[5] = far(hyp(f.from.x, f.from.z, f.to.x, f.to.z));
      v[6] = 'AT'; v[7] = f.from.name; v[8] = '';
      v[9] = 'PASSENGER'; v[10] = f.name; v[11] = '';
      v[12] = f.phase === 'board' ? '' : 'Stop beside them and they get in';
    } else {
      v[0] = 'ON DUTY'; v[1] = 'FOR HIRE';
      v[2] = 'FARES'; v[3] = String(this.shift?.fares || 0); v[4] = 'EARNED'; v[5] = money(this.shift?.earned || 0);
      v[6] = ''; v[7] = ''; v[8] = ''; v[9] = ''; v[10] = ''; v[11] = '';
      v[12] = this.damageBlock() || (this.chased?.() ? 'No fares while the police are after you' : 'Waiting for the dispatcher · T: off duty');
    }
    const E = this.tm;
    for (let k = 0; k < 12; k++) if (E[k].textContent !== v[k]) E[k].textContent = v[k];
    if (E[12].textContent !== v[12]) E[12].textContent = v[12];
    if (E[13].textContent !== said) E[13].textContent = said;
    const bad = said && this.sayBad;
    if (E[13].classList.contains('bad') !== !!bad) E[13].classList.toggle('bad', !!bad);
  }

  dispose() {
    this.dropPax();
    for (const L of this.leaving) this.dropPax(L.p);
    this.leaving.length = 0;
    this.group.parent?.remove(this.group);
    this.el?.remove();
  }
}
