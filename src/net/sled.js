// Your snowmobile in multiplayer (game/snowmobile.js): the parked ones are your own client's (placed at random each
// session), so the one you drive is shown to everyone from here (Oct 30, the user: "you don't see the snowscooter,
// it's just like you're floating"):
//  - driving, your presence row is the snowmobile's pose (pose(): x, y, z on the snow, yaw, crouch = pitch, lean =
//    roll, flags F.sled | F.lights for its headlight); 'veh' { k: 'sled' } once when you get on
//  - off again, 'veh' { k: 'sled', at: [x, y, z, yaw] }: where you left it (checked once a second)
// The others draw it (net/vehicles.js updateSled) and seat your avatar astride it (seatFor, remote.js sledLegs).
import { net } from './client.js';
import { ST, F } from './protocol.js';

const r2 = (v) => Math.round((Number.isFinite(v) ? v : 0) * 100) / 100;

export class SledMp {
  constructor(mp) {
    this.mp = mp;
    this.t = 0;
    this.sent = null; // 'drive' | the parked spot sent ('x,z,yaw')
    this.last = null; // the sled you drove last (game/snowmobile.js list entry)
  }
  get sleds() { return window.__game?.sleds || null; }

  /** Your presence while you drive: the snowmobile's pose (filled after main.js mpPose). */
  pose(o) {
    const S = this.sleds, d = S?.d;
    if (!d || o.interior) return;
    // (taken before this frame's sled update but stamped now: carried on along its speed to now, as net/carride.js)
    const g = d.s.g.position, still = !!window.__game?.paused;
    const ahead = still ? 0 : Math.min(0.1, Math.max(0, (performance.now() - (S.poseT || 0)) / 1000));
    o.x = g.x + d.vx * ahead; o.y = g.y; o.z = g.z + d.vz * ahead; o.yaw = d.heading + (d.yawRate || 0) * ahead;
    o.vx = still ? 0 : d.vx; o.vy = still ? 0 : d.vy; o.vz = still ? 0 : d.vz;
    o.st = ST.drive; o.crouch = d.pitch || 0; o.lean = d.roll || 0;
    o.flags = F.sled | (S.lamp?.intensity > 0 ? F.lights : 0) | (d.air ? F.air : 0);
  }

  /** Every frame (session.update): on / off the snowmobile out to the server. */
  frame(dt) {
    if (!net.open) return;
    const S = this.sleds;
    if (!S) return;
    if (S.d) {
      this.last = S.d.s;
      if (this.sent !== 'drive') { this.sent = 'drive'; net.request('veh', { k: 'sled' }).catch(() => {}); }
      return;
    }
    const s = this.last;
    if (!s) return;
    if ((this.t += dt) < 1 && this.sent !== 'drive') return;
    this.t = 0;
    const key = `${s.x.toFixed(1)},${s.z.toFixed(1)},${s.heading.toFixed(2)}`;
    if (key === this.sent) return;
    this.sent = key;
    net.request('veh', { k: 'sled', at: [r2(s.x), r2(s.y), r2(s.z), r2(s.heading)] }).catch(() => {});
  }

  /** Reconnected without the server holding you: send it again. */
  reset() { this.sent = null; this.t = 1; }

  dispose() { this.sent = null; this.last = null; }
}
