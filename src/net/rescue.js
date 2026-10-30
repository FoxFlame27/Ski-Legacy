// Your rescue in multiplayer (game/heli/rescue.js: the helicopter that comes for you after a bad wipeout or a hard hit
// by a car or bus, then the ambulance to the medical centre). It all runs on your own client; this module shows it to
// everyone (Oct 29, the user: "when another player is hit by a car or bus i only see him stand still while on his own
// screen he's knocked down and the helicopter and ambulance come"):
//  'veh' { k: 'rescue', h: [x, y, z, yaw, pitch, roll, rpm] (the helicopter), a: [x, y, z, yaw, v] (the ambulance, null
//  while it is not out), s (where you are: 0 down in the snow, 1 on the winch, 2 in the cabin, 3 in the ambulance),
//  rope (the winch rope's length, 0: none), l (the ambulance's lights) } about 6 times a second while it runs, and
//  { k: 'rescue', off: true } once it is over. The others draw it (net/vehicles.js updateRescue) and seat or hide your
//  avatar by s; lying in the snow your presence row carries the wipeout itself (main.js mpPose).
import { net } from './client.js';

const SEND_DT = 1 / 6;
const r2 = (v) => Math.round((Number.isFinite(v) ? v : 0) * 100) / 100;

export class RescueMp {
  constructor(mp) {
    this.mp = mp;
    this.t = 0;
    this.sent = false;
    this.list = [];
    // (Oct 30 2026, the user: "my heli landed on another heli and went through": the other players' rescue
    // helicopters, for yours to land beside the pad when one stands on it: game/heli/rescue.js padCheck)
    this.others = () => {
      const L = this.list, rs = this.mp.vehicles?.rescues;
      L.length = 0;
      if (rs) for (const w of rs.values()) if (w.model && w.h.posed && w.ref?.h) L.push(w.h);
      return L;
    };
  }
  get h() { return window.__game?.heli || null; }

  /** Every frame (session.update): the rescue's pose out while it runs. */
  frame(dt) {
    const h = this.h, R = h?.rescue;
    if (R && R.others !== this.others) R.others = this.others;
    if (!net.open) return; // (offline: what the server shows is settled once back: sent / reset)
    if (!R?.active) {
      if (this.sent) { this.sent = false; net.request('veh', { k: 'rescue', off: true }).catch(() => {}); }
      return;
    }
    if ((this.t += dt) < SEND_DT && this.sent) return;
    this.t = 0;
    const f = h.flight, p = h.player, amb = R.amb;
    const seat = p?.seat;
    const s = !seat ? 0 : seat === R.ambSeat ? 3 : seat === R.cabinSeat ? 2 : seat === R.winchSeat ? 1 : 0;
    const msg = {
      k: 'rescue',
      // (gone after handing you to the ambulance, Oct 30 2026: null, the others drop it at once: vehicles.js updateRescue)
      h: f && !R.gone ? [r2(f.pos.x), r2(f.pos.y), r2(f.pos.z), r2(f.yaw), r2(f.pitch), r2(f.roll), r2(Math.min(1, Math.max(0, h.rpm || 0)))] : null,
      a: amb?.ok && amb.group?.visible ? [r2(amb.x), r2(amb.group.position.y), r2(amb.z), r2(amb.yaw), r2(Math.max(-40, Math.min(40, amb.v || 0)))] : null,
      s,
      rope: R.rope?.visible ? r2(R.ropeLen) : 0,
      l: R.phase === 'arrive' || R.phase === 'ambulance',
    };
    if (!msg.h && !msg.a) { if (this.sent) { this.sent = false; net.request('veh', { k: 'rescue', off: true }).catch(() => {}); } return; }
    this.sent = true;
    net.send('veh', msg);
  }

  /** Reconnected without the server holding you: send it again. */
  reset() { this.sent = false; this.t = SEND_DT; }

  dispose() { this.sent = false; }
}
