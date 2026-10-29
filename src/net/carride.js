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
import { ST, F } from './protocol.js';
import { makeTag } from './remote.js';
import { carSeats, seatWorld } from './vehicles.js';
import { busRoads } from '../game/bus/roads.js';

const ASK_REACH = 2.2;  // m from the car's body
const TAG_FAR = 130;
const _old = new THREE.Vector3(), _dv = new THREE.Vector3(), _v = new THREE.Vector3();

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
      const p = d.e.car.position;
      o.x = p.x; o.y = p.y; o.z = p.z; o.yaw = d.yaw;
      o.vx = d.vx; o.vy = 0; o.vz = d.vz;
      o.st = ST.drive; o.crouch = d.steer || 0; o.lean = 0;
      o.flags = F.car | (d.lights ? F.lights : 0);
    } else if (this.ride) { o.st = ST.ride; o.crouch = 0; o.lean = 0; o.flags = 0; o.vx = 0; o.vy = 0; o.vz = 0; }
  }

  // ---------------------------------------------------------------- every frame (before the presence goes out)
  frame(dt) {
    const g = this.g;
    if (!g) return;
    if (!this.placed) { this.placed = true; try { this.putBack(); } catch (e) { console.warn('[mp] car spot', e); } }
    const cur = g.carRental?.current || null, driving = !!(cur && g.drive?.d?.e === cur), V = this.v;
    // tell the server when your car comes, goes, is driven, or stands somewhere new (checked once a second)
    let tell = cur !== V.cur || driving !== V.driving;
    if (!tell && cur && !driving && (V.t += dt) > 1) {
      V.t = 0;
      const p = cur.car.position;
      tell = Math.abs(p.x - V.x) > 0.5 || Math.abs(p.z - V.z) > 0.5;
    }
    if (tell) {
      const had = V.cur !== undefined && V.cur !== null;
      V.cur = cur; V.driving = driving; V.t = 0;
      if (!cur) { if (had) net.request('veh', { k: 'car', off: true }).catch(() => {}); }
      else if (driving) net.request('veh', { k: 'car' }).catch(() => {});
      else {
        const p = cur.car.position;
        V.x = p.x; V.z = p.z;
        net.request('veh', { k: 'car', at: [p.x, p.y, p.z, cur.car.rotation.y] }).catch(() => {});
      }
    }
    this.ownerTag(cur, driving);
    // riding: something else took you out of the seat (a race start, a teleport): the server lets you go too
    if (this.ride && g.player.seat !== this.seat) this.end(false);
  }

  // Back in the world: your car where you left it (profile cars[0].at, the server keeps it) if that spot is free, else
  // a free spot beside it, the nearest free car park bay, or the rental's yard (Oct 29, the user)
  putBack() {
    const g = this.g, R = g.carRental, cur = R?.current, at = MP.profile?.cars?.[0]?.at;
    if (!cur || !at || g.drive?.d?.e === cur) return;
    const yaw = at[3], fx = Math.sin(yaw), fz = Math.cos(yaw);
    const cands = [[0, 0], [2.8, 0], [-2.8, 0], [0, 6], [0, -6], [5.6, 0], [-5.6, 0]].map(([s, f]) => ({ x: at[0] + fz * s + fx * f, z: at[2] - fx * s + fz * f, yaw }));
    const bays = [];
    for (const L of busRoads.lots || []) for (const b of L.bays || []) if (!b.taken) bays.push({ x: b.x, z: b.z, yaw: Math.atan2(b.hx || 0, b.hz || 1), d: Math.hypot(b.x - at[0], b.z - at[2]) });
    bays.sort((a, b) => a.d - b.d);
    cands.push(...bays.slice(0, 12));
    const spot = cands.find((c) => this.spotFree(c.x, c.z, cur));
    if (!spot) return; // (nowhere free: it stays in the yard, where resync put it)
    const p = cur.car.position;
    if (Math.hypot(p.x - spot.x, p.z - spot.z) < 0.3) return;
    R.remove(cur);
    R.current = R.spawn(g.save.rental, spot);
  }
  spotFree(x, z, own) {
    const g = this.g;
    if (g.drive?.clearAt && !g.drive.clearAt(x, z, 1.1, own)) return false;
    for (const r of this.mp.remotes?.players.values() || []) { const a = r.vcar?.at; if (a && Math.hypot(a[0] - x, a[2] - z) < 4.5) return false; } // (another player's car)
    return true;
  }

  // "<you>'s car" over your parked car (drive.js rebuilds the car's children on getting in / out: put back each frame)
  ownerTag(cur, driving) {
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
    if (this.prompt.pid !== best.pid) {
      this.prompt.pid = best.pid;
      this.prompt.label = `Ask ${owner.name} for a ride`;
      this.prompt.act = () => this.ask(owner.name, best.pid);
    }
    return this.prompt;
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
    g.camera.position.add(_dv);
    if (p.camPos?.isVector3) p.camPos.add(_dv);
    if (input?.hit?.('KeyE')) this.end(true);
  }

  /** Out of the car: by your seat's door (stand), or just let go of the seat (something else moved you). */
  end(stand = true, release = true) {
    const r = this.ride;
    if (!r) return;
    this.ride = null;
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
