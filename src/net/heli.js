// The helicopter in multiplayer (server: heliRent / heliReturn, the 'heli' state { copies, padAt }). Oct 29, the user:
// "helicopter automatically respawns if someone has rented for 5min or longer but it just spawns a copy".
//  - The pad has a helicopter when the server says so (serverNow >= padAt): 5 min after the last rental, or at once
//    when one comes back. Otherwise the pad stands empty: "Heli-ski · next helicopter in N min".
//  - FLY rents through the server (the price is the server's) instead of the local spend (game/heli.js this.mp).
//  - Yours is shown to everyone: flying, your presence row is its pose (pitch, roll, the rotor); parked out on the
//    mountain, where it stands ('veh' heli with at). Back on the pad (flown home, or the flight ended): returned.
//  - The other players' copies: net/vehicles.js.
import { MP } from './mode.js';
import { net } from './client.js';
import { ST, F } from './protocol.js';

export class MpHeli {
  constructor(mp) {
    this.mp = mp;
    this.rented = false;     // a copy is out on your name
    this.returning = false;  // heliReturn sent, the server's 'heli' not back yet
    this.wasReady = null;
    this.shown = true;
    this.vState = 'none';    // what the server was last told: none | fly | park
    this.wait = { label: 'Heli-ski · next helicopter soon', act: () => this.mp.c.hud.flash(this.wait.label, 'bad', 2200) };
    // game/heli.js uses these in multiplayer
    this.hooks = { ready: () => this.ready(), rent: () => this.rent(), wait: () => this.waitPrompt() };
  }
  get h() { return window.__game?.heli; }

  attach() { const h = this.h; if (h) h.mp = this.hooks; }
  detach() {
    const h = this.h;
    if (!h) return;
    h.mp = null;
    h.model.root.visible = true;
    if (h.state === 'parked' && !h.away) h.syncModel(); // (solid on its pad again)
    this.rented = false; this.returning = false; this.vState = 'none'; this.wasReady = null; this.shown = true;
  }

  /** A helicopter waits on the pad for the next renter. */
  ready() { if (this.returning) return true; const H = MP.heli; return !H || net.serverNow() >= H.padAt; }
  waitPrompt() {
    const H = MP.heli, min = Math.max(1, Math.ceil(((H?.padAt || 0) - net.serverNow()) / 60000));
    this.wait.label = `Heli-ski · the helicopter is out · next one in ${min} min`;
    return this.wait;
  }
  async rent() {
    const d = await this.mp.heliRent();
    if (!d) return false;
    this.rented = true;
    return true;
  }

  /** Your presence while you fly: the helicopter's pose (filled after main.js mpPose). */
  pose(o) {
    const h = this.h;
    if (!h?.active) return;
    const f = h.flight;
    o.x = f.pos.x; o.y = f.pos.y; o.z = f.pos.z; o.yaw = f.yaw;
    o.vx = f.vel?.x || 0; o.vy = f.vel?.y || 0; o.vz = f.vel?.z || 0;
    o.st = ST.fly; o.crouch = f.pitch; o.lean = f.roll;
    o.flags = h.rpm > 0.6 ? F.lights : 0;
  }

  frame() {
    const h = this.h;
    if (!h) return;
    const onPad = h.state === 'parked' && !h.away;
    // back on the pad (flown home by its pilot, or the flight ended): returned, the pad has one again for everyone
    if (this.rented && onPad) {
      this.rented = false; this.returning = true;
      this.mp.heliReturn().then(() => { this.returning = false; });
    }
    // the pad: the helicopter shows when one waits there (yours out: it is yours that flies)
    const ready = this.ready();
    const show = !onPad || ready;
    if (show !== this.shown) {
      this.shown = show;
      h.model.root.visible = show;
      if (show) h.syncModel();
      else { h.cabinCol.x = h.tailCol.x = 1e9; h.cabinCol.z = h.tailCol.z = 1e9; }
    }
    if (this.wasReady === false && ready && onPad && !this.returning) {
      const p = h.player.pos;
      if (Math.hypot(p.x - h.home.x, p.z - h.home.z) < 400) this.mp.c.hud.flash('A helicopter is waiting at the helipad', 'good', 3000);
    }
    this.wasReady = ready;
    // what everyone sees of yours
    const want = !this.rented ? 'none' : h.state === 'flying' || h.state === 'boarding' ? 'fly' : h.state === 'parked' && h.away ? 'park' : 'none';
    if (want !== this.vState) {
      const was = this.vState;
      this.vState = want;
      const f = h.flight;
      if (want === 'fly') net.request('veh', { k: 'heli' }).catch(() => {});
      else if (want === 'park') net.request('veh', { k: 'heli', at: [f.pos.x, f.pos.y, f.pos.z, f.yaw] }).catch(() => {});
      else if (was !== 'none' && this.rented) net.request('veh', { k: 'heli', off: true }).catch(() => {}); // (flying home on its own)
    }
  }

  /** The connection came back: the server returned the copy with the old connection. */
  reset() { this.rented = false; this.returning = false; this.vState = 'none'; }
}
