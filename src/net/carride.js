// Your car in multiplayer, and riding in someone else's.
//  - Your rental is shown to everyone (the server's 'veh' record: its look from your profile): parked where it stands
//    (that spot is kept in your profile; next time it is put back there, carrental.js resync), or, while you drive,
//    your presence row is the car's pose (x, y, z, yaw, steering, headlights: pose()). Parked and empty it carries
//    "<you>'s car" above it, for you too (Oct 29, the user: "everything you own has your name above if you are not
//    in it"); hidden while it is driven.
//  - Near another player's car: E "Ask <owner> for a ride". The owner gets "Allow <name> to get in your car?" (Y / N);
//    allowed, the server seats you (seat 1 the front passenger, 2.. the back) and you sit in that seat of their car as
//    it is drawn here (net/vehicles.js), moving with it; R first person from your seat / chase; E gets out by your door.
//    The owner driving off, leaving or taking the ride back (seatLost) puts you out too.
//  - The players riding in YOUR car sit in its seats (vehicles.js seatFor / remote.js late()).
// Nothing here runs in single player (net/session.js only builds it in multiplayer).
import * as THREE from 'three';
import { MP } from './mode.js';
import { net } from './client.js';
import { ST, F, W_SHIFT } from './protocol.js';
import { makeTag, carLegs } from './remote.js';

const OWN_TAG_OFF = true;
import { carSeats, seatWorld, parseVeh } from './vehicles.js';
import { busRoads } from '../game/bus/roads.js';
import { cabinLight } from '../game/carlights.js';

const ASK_REACH = 2.2;  // m from the car's body
const TAG_FAR = 130;
const _old = new THREE.Vector3(), _dv = new THREE.Vector3(), _v = new THREE.Vector3(), _eu = new THREE.Euler();

export class CarRide {
  constructor(mp) {
    this.mp = mp;
    this.ride = null;     // { owner, pid, seat, lost }
    this.asking = false;
    this.seat = { pos: new THREE.Vector3(), fwd: new THREE.Vector3(0, 0, 1) }; // (player.sitOn: moved every frame)
    this.local = { group: null, t: null, yaw: 0 };
    this.prompt = { label: '', act: null };
    this.v = { cur: undefined, driving: false, x: 0, z: 0, t: 0 }; // what the server was last told about your car
    this.tag = null;
    this.placed = false;  // your car put back where you left it (once per session)
    this.wanted = null;   // riding with a wanted driver: { owner, stars, search, arrest } (police.js rideW: the WANTED box)
  }
  get g() { return window.__game; }

  /** Your car (driving or parked) for the players riding in it: { group, t } (reused) or null. */
  localCar() {
    const g = this.g, cur = g?.carRental?.current;
    if (!cur?.car) return null;
    const d = g.drive?.d;
    this.local.group = cur.car;
    this.local.t = d && d.e === cur ? d.t : cur.t;
    this.local.yaw = d && d.e === cur ? d.yaw : cur.car.rotation.y;
    return this.local;
  }

  /** Your presence while you drive your car: the car's pose (filled after main.js mpPose). */
  pose(o) {
    const g = this.g, d = g?.drive?.d;
    if (d && d.e && d.e === g.carRental?.current) {
      // (the row goes out early in the frame, before drive.update: the car is where last frame left it, but the row is
      // stamped now. One frame's worth (10-50 ms, more on a hitch) of travel on the others' screens jerked the car back
      // and forth by up to half a metre, worst for a passenger in it (Oct 30, the user: "driving isn't smooth on
      // multiplayer, especially if you're a passenger"): carried on along its speed to now. Paused: standing still.)
      const p = d.e.car.position, still = !!g.paused;
      const ahead = still ? 0 : Math.min(0.1, Math.max(0, (performance.now() - (g.drive.poseT || 0)) / 1000));
      o.x = p.x + d.vx * ahead; o.y = p.y; o.z = p.z + d.vz * ahead; o.yaw = d.yaw + (d.yawRate || 0) * ahead;
      o.vx = still ? 0 : d.vx; o.vy = 0; o.vz = still ? 0 : d.vz;
      // (lean: the body's roll, rolling over in a crash too: the others turn the car as it is here; x/y/z is then the
      // origin of the car as it lies, not its middle)
      o.st = ST.drive; o.crouch = d.steer || 0; o.lean = (d.roll || 0) + (d.crash?.roll || 0);
      o.flags = F.car | (d.lights ? F.lights : 0) | (d.crash ? F.wreck : 0) | (g.police?.wantedBits?.() || 0); // (wanted: your passengers see it)
    } else if (this.ride) { o.st = ST.ride; o.crouch = 0; o.lean = 0; o.flags = 0; o.vx = 0; o.vy = 0; o.vz = 0; }
  }

  // ---------------------------------------------------------------- every frame (before the presence goes out)
  frame(dt) {
    const g = this.g;
    if (!g) return;
    // (once the other players' records are in: their parked cars' spots are known, putBack keeps clear of them)
    if (!this.placed && this.mp.remotes) { this.placed = true; try { this.putBack(); } catch (e) { console.warn('[mp] car spot', e); } }
    // (your wreck while the tow truck fetches it is still your car to the others: lying there, then on the truck's bed,
    // where it rides with the truck as the others draw it: net/tow.js, vehicles.js; told like driving: no spot)
    const cur = g.carRental?.current || g.carRental?.towed || null, V = this.v;
    const driving = !!(cur && (g.drive?.d?.e === cur || this.mp.towMp?.carAboard(cur)));
    // tell the server when your car comes, goes, is driven, or stands somewhere new (checked once a second)
    const wreck = !!cur?.wrecked;
    let tell = cur !== V.cur || driving !== V.driving || wreck !== V.wreck;
    if (!tell && cur && !driving && (V.t += dt) > 1) {
      V.t = 0;
      const p = cur.car.position;
      tell = Math.abs(p.x - V.x) > 0.5 || Math.abs(p.z - V.z) > 0.5;
    }
    if (tell) {
      const had = V.cur !== undefined && V.cur !== null;
      V.cur = cur; V.driving = driving; V.wreck = wreck; V.t = 0;
      if (!cur) { if (had) net.request('veh', { k: 'car', off: true }).catch(() => {}); }
      else if (driving) net.request('veh', { k: 'car' }).catch(() => {});
      else {
        const p = cur.car.position;
        V.x = p.x; V.z = p.z;
        // (its heading from the whole turn, YXZ as the others build it: a wreck on its side or roof keeps its tilt)
        _eu.setFromQuaternion(cur.car.quaternion, 'YXZ');
        const msg = { k: 'car', at: [p.x, p.y, p.z, _eu.y] };
        if (Math.abs(_eu.x) > 0.03 || Math.abs(_eu.z) > 0.03) msg.tilt = [_eu.x, _eu.z];
        if (wreck) msg.wreck = true;
        net.request('veh', msg).catch(() => {});
      }
    }
    this.ownerTag(cur, driving);
    // riding: something else took you out of the seat (a race start, a teleport): the server lets you go too
    if (this.ride && g.player.seat !== this.seat) this.end(false);
    this.wantedFrame(g);
  }

  // Riding with a wanted driver (the stars in their presence flags, police.js wantedBits): the WANTED box for you too,
  // read-only, and the chase music (police.js rideHud); a flash when it starts (Oct 30, the user: "can you tell
  // passengers wanted too"). Arrested, you go to prison with them (onArrested).
  wantedFrame(g) {
    const r = this.ride && this.mp.remotes?.players.get(this.ride.pid);
    const f = r && r.flags & F.car ? r.flags : 0, stars = (f & F.wanted) >>> W_SHIFT;
    const was = this.wanted;
    if (!stars) { if (was) { this.wanted = null; if (g.police) g.police.rideW = null; } return; }
    const W = this.wanted ||= { owner: '', stars: 0, search: false, arrest: false };
    W.owner = this.ride.owner; W.stars = stars; W.search = !!(f & F.wSearch); W.arrest = !!(f & F.wArrest);
    if (g.police) g.police.rideW = W;
    if (!was) g.hud?.flash(`WANTED · you're riding with ${W.owner} · caught, you go to prison too`, 'bad', 4200);
  }

  /** The police arrested the driver of the car you ride (or rode) in during the chase (server 'arrested'): out of the
   *  car, into a cell, wherever you are now (Oct 30 2026: getting out before they caught him doesn't get you off). */
  onArrested(d) {
    const g = this.g;
    if (!g || !d) return;
    const aboard = !!this.ride;
    if (this.ride) this.end(true, false); // (the server already took your seat)
    if (this.wanted) { this.wanted = null; if (g.police) g.police.rideW = null; }
    const by = String(d.by || 'the driver').slice(0, 24), fine = Number(d.fine) || 0;
    if (fine > 0) { g.hud?.setMoney?.(g.save.money, -fine); g.audio?.play?.('cash'); }
    const msg = `${aboard ? `Arrested with ${by}` : `${by} was caught`} · you're going to jail too${fine > 0 ? ` · -$${Math.round(fine).toLocaleString('en-US')}` : ''}`;
    const pr = g.prison;
    if (pr?.jail && Number.isFinite(d.jailUntil)) {
      if (MP.profile) { MP.profile.jailUntil = d.jailUntil; MP.profile.jailReason = d.reason; }
      try { pr.jail(d.seconds, d.reason || `Arrested with ${by}`, { until: d.jailUntil }); } catch (e) { console.warn('[mp] arrested: prison', e); }
    }
    g.hud?.flash(msg, 'bad', 5000);
  }

  // Back in the world: your car where you left it (profile cars[0].at, the server keeps it) if that spot is free, else
  // a free spot beside it, the nearest free car park bay, or the rental's yard (Oct 29, the user)
  // (Oct 30 2026, the user: "make sure cars don't stack on the parking lot": with no spot kept (a new car, the first
  // session) it stayed in the bay spawn gave it, the first Autohaus bay, the same for every player: now that bay is
  // checked like a kept spot. A bay counts as free with no other player's parked car (their record, or where it is
  // drawn here: vehicles.js unstack) and none of your other kept cars within 2.5 m: its own neighbours stay usable)
  putBack() {
    const g = this.g, R = g.carRental, cur = R?.current;
    if (!cur || g.drive?.d?.e === cur || cur.impound || cur.towing) return; // (impounded: it stays in its impound bay)
    const p0 = cur.car.position, at = MP.profile?.cars?.[0]?.at || [p0.x, p0.y, p0.z, cur.car.rotation.y];
    const yaw = at[3], fx = Math.sin(yaw), fz = Math.cos(yaw);
    const cands = [[0, 0], [2.8, 0], [-2.8, 0], [0, 6], [0, -6], [5.6, 0], [-5.6, 0]].map(([s, f]) => ({ x: at[0] + fz * s + fx * f, z: at[2] - fx * s + fz * f, yaw }));
    const bays = [], pound = R.impound?.pound || [];
    for (const L of busRoads.lots || []) for (const b of L.bays || []) if (!b.taken && !pound.includes(b)) bays.push({ x: b.x, z: b.z, yaw: Math.atan2(b.hx || 0, b.hz || 1), d: Math.hypot(b.x - at[0], b.z - at[2]), bay: true });
    bays.sort((a, b) => a.d - b.d);
    cands.push(...bays.slice(0, 24));
    const spot = cands.find((c) => this.spotFree(c.x, c.z, cur, c.bay ? 2.5 : 4.5));
    if (!spot) return; // (nowhere free: it stays in the yard, where resync put it)
    const p = cur.car.position;
    if (Math.hypot(p.x - spot.x, p.z - spot.z) < 0.3) return;
    R.remove(cur);
    R.current = R.spawn(g.save.rental, spot);
  }
  /** Another player's parked car within r m of (x, z)? (impound.js: an impound bay nobody's car stands in) */
  carNear(x, z, r = 2) {
    for (const p of this.mp.remotes?.players.values() || []) { const a = p.vcar?.at; if (a && Math.hypot(a[0] - x, a[2] - z) < r) return true; }
    return false;
  }
  spotFree(x, z, own, near = 4.5) {
    const g = this.g;
    if (g.drive?.clearAt && !g.drive.clearAt(x, z, 1.1, own)) return false;
    for (const r of this.mp.remotes?.players.values() || []) { const a = r.vcar?.at; if (a && Math.hypot(a[0] - x, a[2] - z) < near) return false; } // (another player's car)
    for (const c of this.mp.vehicles?.cars?.values() || []) if (c.posed && !c.driven && !c.towed && Math.hypot(c.x - x, c.z - z) < near) return false; // (as drawn here; not one with its tow truck: Oct 30 2026)
    for (const k of g.carRental?.kept || []) if (k !== own && !k.driving && k.car?.parent && Math.hypot(k.car.position.x - x, k.car.position.z - z) < 2.5) return false; // (your other cars)
    return true;
  }

  // "<you>'s car" over your parked car (drive.js rebuilds the car's children on getting in / out: put back each frame)
  ownerTag(cur, driving) {
    // (off: game/ownertags.js already puts your gold name tag over your own car; two tags stacked over it, Oct 29)
    if (OWN_TAG_OFF) { if (this.tag) this.tag.visible = false; return; }
    const tag = this.tag ||= makeTag(`${MP.name}'s car`, '#0f2f6b');
    if (!cur || driving) { if (tag.visible) tag.visible = false; return; }
    if (tag.parent !== cur.car) { cur.car.add(tag); tag.position.set(0, (cur.t?.size?.y || 1.5) + 0.55, 0); }
    const cam = this.g.camera.position, d = _v.copy(cur.car.position).sub(cam).length(), on = d < TAG_FAR;
    if (tag.visible !== on) tag.visible = on;
    if (on) { const k = tag.userData.base * 0.85 * Math.max(0.6, Math.min(1, 1.15 - d / 220)); tag.scale.set(k * (512 / 96), k, 1); }
  }

  // ---------------------------------------------------------------- asking for a ride
  /** E near another player's car: "Ask <owner> for a ride" (main.js findInteraction), or null. */
  interaction(pos) {
    const veh = this.mp.vehicles, rem = this.mp.remotes, p = this.g?.player;
    if (this.ride || this.asking || !veh || !rem || !p || p.mode === 'sit' || p.mode === 'fall') return null;
    let best = null, bd = ASK_REACH;
    for (const c of veh.cars.values()) {
      if (!c.posed || !c.group.visible || Math.abs(c.u) > 3) continue;
      const dx = pos.x - c.x, dz = pos.z - c.z;
      if (Math.abs(dx) > 8 || Math.abs(dz) > 8) continue;
      const lx = dx * Math.cos(c.yaw) - dz * Math.sin(c.yaw), lz = dx * Math.sin(c.yaw) + dz * Math.cos(c.yaw);
      const d = Math.hypot(Math.max(0, Math.abs(lx) - (c.t.size?.x || 1.9) / 2), Math.max(0, Math.abs(lz) - (c.t.size?.z || 4.6) / 2));
      if (d < bd) { bd = d; best = c; }
    }
    const owner = best && rem.players.get(best.pid);
    if (!owner) return null;
    // every passenger seat taken (Oct 30, the user: "no option at all to ask to join a car, it just says car full"):
    // no ask, just "<owner>'s car · full"
    const full = this.riders(owner.name, rem) >= carSeats(best.t).length - 1;
    if (this.prompt.pid !== best.pid || this.prompt.full !== full) {
      this.prompt.pid = best.pid; this.prompt.full = full;
      this.prompt.label = full ? `${owner.name}'s car · full` : `Ask ${owner.name} for a ride`;
      this.prompt.act = full ? () => this.g.hud.flash(`${owner.name}'s car is full`, 'bad', 2000) : () => this.ask(owner.name, best.pid);
    }
    return this.prompt;
  }

  /** The passengers in <owner>'s car: the server's seat registry ('seats' broadcasts), or the players whose presence
   *  has them in its passenger seats, whichever counts more. */
  riders(owner, rem) {
    let reg = 0, pres = 0;
    for (const [s] of this.mp.seatsOf('car', owner)) if (s !== 0) reg++;
    for (const r of rem?.players.values() || []) {
      parseVeh(r);
      if (r.vehK === 'car' && r.vehOwner === owner && r.vehSeat > 0) pres++;
    }
    return Math.max(reg, pres);
  }

  async ask(owner, pid) {
    if (this.asking || this.ride) return;
    const hud = this.g.hud;
    this.asking = true;
    try {
      hud.flash(`Asking ${owner} for a ride…`, 'good', 2400);
      const r = await this.mp.ask('carRide', { to: owner });
      if (!r?.allow) { if (!r?.error) hud.flash(r?.reason === 'timeout' ? `${owner} did not answer` : `${owner} said no`, 'bad', 2600); return; }
      const c = this.mp.vehicles?.carOf(pid);
      if (!c) { hud.flash(`${owner}'s car is gone`, 'bad', 2200); return; }
      if (this.riders(owner, this.mp.remotes) >= carSeats(c.t).length - 1) { hud.flash(`${owner}'s car is full`, 'bad', 2200); return; } // (filled up meanwhile)
      const s = await this.mp.claimSeat('car', owner, { n: carSeats(c.t).length });
      if (!s) return;
      if (!this.board(owner, pid, s.seat)) this.mp.releaseSeat();
    } finally { this.asking = false; }
  }

  board(owner, pid, seat) {
    const g = this.g, p = g.player, c = this.mp.vehicles?.carOf(pid);
    if (!c || p.mode === 'sit' || p.mode === 'fall' || g.drive?.active || g.heli?.active) return false;
    if (p.skisOn) p.setSkisOn(false);
    this.ride = { owner, pid, seat, lost: 0 };
    seatWorld(c.group, c.t, seat, this.seat.pos);
    this.seat.fwd.set(Math.sin(c.yaw), 0, Math.cos(c.yaw));
    p.sitOn(this.seat);
    p.pos.copy(this.seat.pos);
    p.rig.snapPose?.();
    p.rig.gear.visible = false; // (your skis stay out of the cabin)
    g.audio?.play?.('board');
    g.hud.flash(`${owner}'s car · ${seat === 1 ? 'front seat' : 'back seat'} · E to get out · R first person / chase`, 'good', 3600);
    return true;
  }

  /** The server took you out of the car (the owner took the ride back, left the world). */
  onSeatLost(d) {
    if (!this.ride || d?.k !== 'car' || d.v !== this.ride.owner) return;
    const owner = this.ride.owner;
    this.end(true, false);
    this.g?.hud.flash(`Out of ${owner}'s car`, 'bad', 2400);
  }

  // ---------------------------------------------------------------- after your car moved (main.js, after drive.update)
  late(dt, input) {
    const r = this.ride;
    if (!r) return;
    const g = this.g, p = g.player;
    if (p.seat !== this.seat) { this.end(false); return; }
    const c = this.mp.vehicles?.carOf(r.pid);
    if (!c) { if ((r.lost += dt) > 1.5) { this.end(true); g.hud.flash(`${r.owner}'s car is gone`, 'bad', 2200); } return; }
    r.lost = 0;
    // the seat where the car is drawn this frame (the player and the camera were placed from last frame's): move
    // you, your rig and the camera along by the difference, so you never lag the car
    _old.copy(this.seat.pos);
    seatWorld(c.group, c.t, r.seat, this.seat.pos);
    this.seat.fwd.set(Math.sin(c.yaw), 0, Math.cos(c.yaw));
    _dv.subVectors(this.seat.pos, _old);
    p.pos.add(_dv); p.rig.root.position.add(_dv);
    // your legs to this car's footwell, as the others see you (remote.js carLegs): player.js poses you in the plain
    // 'sit' (a bench's: the shins hung 0.36 m under the seat), so the feet went down through the car's floor and out
    // under it in a low car (Oct 30, the user: "the feet of the passenger were stuck out of the car")
    if (p.mode === 'sit' && p.rig?.root) { this.legs ||= {}; this.legs.carG = c.group; this.legs.carT = c.t; this.legs.carSeat = r.seat; carLegs(p.rig, this.legs); }
    g.camera.position.add(_dv);
    if (p.camPos?.isVector3) p.camPos.add(_dv);
    // the cabin lit softly round you, its screens glowing (carlights.js cabinLight: the one cabin light)
    if (this.cab?.inst !== c.inst) { if (this.cab) cabinLight(this.cab.inst, this.cab.t, { on: false }); this.cab = { inst: c.inst, t: c.t }; }
    cabinLight(c.inst, c.t, { on: true, inside: p.view === 'first' });
    if (input?.hit?.('KeyE')) this.end(true);
  }

  /** Out of the car: by your seat's door (stand), or just let go of the seat (something else moved you). */
  end(stand = true, release = true) {
    const r = this.ride;
    if (!r) return;
    this.ride = null;
    if (this.cab) { cabinLight(this.cab.inst, this.cab.t, { on: false }); this.cab = null; }
    // (stepping out of a wanted driver's car (Oct 30 2026, the user: "even if the passenger steps out and the person
    // driving gets caught the passenger goes free, fix that"): you were in it, so you are still in it: the server keeps
    // you as an accomplice until the chase is over (server.js accompliceStep); a warning as you go)
    if (this.wanted) { if (stand && release && !this.wanted.arrest) this.g?.hud?.flash(`You rode with ${this.wanted.owner || 'a wanted driver'} · caught, you go to jail too`, 'bad', 4200); this.wanted = null; if (this.g?.police) this.g.police.rideW = null; }
    if (release) this.mp.releaseSeat();
    const g = this.g, p = g?.player;
    if (!p) return;
    p.rig.gear.visible = true;
    p.rig.setSkisVisible?.(p.hasSkis);
    if (!stand || p.seat !== this.seat) return;
    const c = this.mp.vehicles?.carOf(r.pid);
    let x = p.pos.x, z = p.pos.z, heading = p.heading;
    if (c) {
      const s = carSeats(c.t)[Math.min(r.seat, carSeats(c.t).length - 1)], side = s.x >= 0 ? 1 : -1;
      _v.set(side * ((c.t.size?.x || 1.9) / 2 + 0.9), 0, s.z);
      c.group.localToWorld(_v);
      x = _v.x; z = _v.z; heading = c.yaw + side * Math.PI / 2;
    }
    p.seat = null;
    p.standUp(x, z, heading);
    p.rig.snapPose?.();
    g.audio?.play?.('board');
  }

  /** The connection came back (the server dropped your seat and records): tell it again. */
  reset() { this.v.cur = undefined; if (this.ride) this.end(true, false); }

  dispose() {
    if (this.ride) this.end(true);
    if (this.tag) { this.tag.removeFromParent(); this.tag.material.map.dispose(); this.tag.material.dispose(); this.tag = null; }
    this.v.cur = undefined; this.placed = false;
  }
}
