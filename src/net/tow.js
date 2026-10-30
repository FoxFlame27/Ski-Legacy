// Your tow truck in multiplayer (game/towtruck.js, owned by the car rental). Every player has their own truck: it
// still runs here with the traffic off, and fetches only your own car (a wreck, or your car towed off a road:
// impound.js). This module:
//  - streams its pose to the others while it is out on a job: 'veh' { k: 'tow', at: [x, y, z, yaw], v, car } about
//    6 times a second (car: your car rides on its bed), and { k: 'tow', off: true } once it is parked again. The others
//    draw it with the same model (net/vehicles.js updateTow), your car on its bed;
//  - gives the truck the other players on foot as obstacles (truck.mp.others); their cars it finds itself (the shared
//    colliders with mp: true). The other players' trucks it ignores: no two trucks fight over the yard's TOW bay.
// The fee and the impound go through the server ('tow' / 'towDone': net/session.js tow()).
import { net } from './client.js';
import { ST } from './protocol.js';
import { MP } from './mode.js';

const SEND_DT = 1 / 6;
const FOOT = new Set([ST.walk, ST.ski, ST.fall, ST.sit]);

export class TowMp {
  constructor(mp) {
    this.mp = mp;
    this.t = 0;
    this.sent = false;
    this.hooks = { others: (add) => this.others(add) };
  }
  get truck() { return window.__game?.carRental?.truck || null; }

  // the other players standing or moving outdoors on foot (in a car: their car's collider; seated / indoors: not there)
  others(add) {
    const rem = this.mp.remotes;
    if (!rem) return;
    for (const r of rem.players.values()) {
      if (!r.ok || r.interior || r.veh || !FOOT.has(r.state)) continue;
      add(r.pos.x, r.pos.z, 0, 0.45, 0.45, null, 'player');
    }
  }

  /** Every frame (session.update): the hooks on, the truck's pose out while it is on a job. */
  frame(dt) {
    const T = this.truck;
    if (!T) return;
    if (T.mp !== this.hooks) T.mp = this.hooks;
    // (the fleet's three TOW bays: yours is pid % 3, so the trucks of different players leave from and park in
    // different bays and are not drawn inside each other)
    if ('prefer' in T) { const k = ((MP.pid | 0) % 3 + 3) % 3; if (T.prefer !== k) T.prefer = k; }
    const j = T.job;
    if (!j) {
      if (this.sent) { this.sent = false; net.request('veh', { k: 'tow', off: true }).catch(() => {}); }
      return;
    }
    if ((this.t += dt) < SEND_DT && this.sent) return;
    this.t = 0;
    if (!net.open) return;
    this.sent = true;
    const r = (v) => Math.round(v * 100) / 100;
    net.send('veh', { k: 'tow', at: [r(T.x), r(T.g.position.y), r(T.z), r(T.yaw)], v: r(T.v || 0), car: !!(j.onBed || j.phase === 'load') });
  }

  /** Loaded on the truck (on its bed, or being lifted onto it): your car rides with the truck, not where it stood. */
  carAboard(e) {
    const T = this.truck, j = T?.trucks ? T.trucks.find((t) => t.job?.e === e)?.job : T?.job; // (the fleet: the truck that has it)
    return !!(e && j && j.e === e && (j.onBed || j.phase === 'load'));
  }

  /** Reconnected without the server holding you: send the truck again. */
  reset() { this.sent = false; this.t = SEND_DT; }

  dispose() {
    const T = this.truck;
    if (T && T.mp === this.hooks) T.mp = null;
    if (T && 'prefer' in T) T.prefer = null;
    this.sent = false;
  }
}
