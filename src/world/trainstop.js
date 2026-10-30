// Trains stop for you (both lines: railway.js, express.js). Standing, walking or skiing on a track ahead of a
// train makes it brake (the service brake once it needs SERVICE m/s^2 to stand GAP m short of you; harder only when
// you step out right in front of it) and wait there while you stay on the track; it pulls away again when you
// step off. The lines run on timetables, so a train's real speed is its timetable speed times a clock rate (0..1):
// a held train slows its line's (railway) or direction's (express) whole clock, the trains behind it keep their
// spacing. The cars near you are solid too: box colliders (player.collide) moved onto them every frame.
import { CAR } from './train.js';

export const GAP = 20;              // m short of you the train stands
const HOLD = 45;                    // m: a train this near (stopped, or crawling) stays put while you are on its track
const SERVICE = 0.8, PULL = 0.7;    // m/s^2: braking starts when it needs this much; pulling away again
const HORN_R = 600, HORN_EVERY = 7; // m: the driver sounds the horn at you from this near, every few seconds
const PARK = 1e6;                   // where an unused collider waits (far off everything)

/**
 * One train's brakes. b: its own state ({ ve: real speed, horn }); v: its timetable speed now (m/s); D: m from its
 * nose to you along its track ahead (null: the line ahead is clear). Returns the rate its clock may run at (0..1).
 */
export function brakeFor(b, v, D, dt, audio = null) {
  let ve = Math.min(b.ve ?? v, v);
  if (D === null) { ve = Math.min(v, ve + PULL * dt); b.horn = 0; }
  else {
    const gap = D - GAP;
    if (gap <= 0.3 || (D < HOLD && ve < 0.4)) ve = 0; // (stood short of you / you stepped out under its nose)
    else {
      const need = (ve * ve) / (2 * gap); // m/s^2 to stand exactly GAP short of you
      ve = need > SERVICE ? Math.max(0, ve - need * dt) : Math.min(v, ve + PULL * dt);
    }
    // the horn while it comes at you (and once more now and then while you stand in front of it): the loco's Typhon
    // (audio.horn, Oct 30 2026, the user: "make the horn of the bus and train super realistic like in real life"),
    // in the drivers' patterns: long-short (the "Achtung") from afar, one long warning blast once it is close and
    // still coming, a single short toot from a train standing in front of you; pitched up by its closing speed
    if (audio && D < HORN_R && (ve > 0.5 || v > 0.5) && (b.horn = (b.horn || 0) - dt) <= 0) {
      const moving = ve > 0.5;
      b.horn = moving ? (D < 160 ? HORN_EVERY * 0.75 : HORN_EVERY) : HORN_EVERY * 2;
      try {
        if (audio.horn) audio.horn(!moving ? 'train_short' : D < 160 ? 'train_long' : 'train', { dist: D, doppler: 343 / (343 - Math.min(60, ve)) });
        else audio.play('horn', Math.max(0.2, Math.min(1, 1.15 - D / HORN_R)));
      } catch (e) { /* (no audio) */ }
    }
  }
  b.ve = ve;
  return v > 0.05 ? ve / v : D !== null && D < HOLD + 30 ? 0 : 1; // (standing in a timetable stop: hold the stop)
}
/** No player about (riding, or the clock jumped): every train at its timetable speed again. */
export function release(b, v) { b.ve = v; b.horn = 0; }

/**
 * Is p on a track? c: the centre line at its nearest point ({ x, y, z, dx, dz }); returns the lateral offset (m,
 * + = right of +s, the trackAt / trackPoint convention) or null when p is not at the rail's height (a bridge over
 * it, a tunnel under it, a chair lift).
 */
export function latOf(p, c) {
  const dy = p.y - c.y;
  if (dy < -1.8 || dy > 2.6) return null;
  return (p.x - c.x) * -c.dz + (p.z - c.z) * c.dx;
}

/** A pool of car colliders ({ x, z, hw, hd, rot, top }) pushed into the game's list once; moved onto the cars near you. */
export class CarColliders {
  constructor(colliders, n, hd = CAR.half) {
    this.list = Array.from({ length: n }, () => ({ x: PARK, z: PARK, hw: CAR.hw, hd, rot: 0, top: -1e9, train: true }));
    colliders?.push(...this.list);
    this.k = 0;
  }
  begin() { this.k = 0; }
  // a car's middle (x, y = rail, z) heading (dx, dz); skipped when you are well below its floor (a tunnel under it)
  add(x, y, z, dx, dz, p) {
    if (this.k >= this.list.length || p.y < y - 2.5) return;
    const c = this.list[this.k++];
    c.x = x; c.z = z; c.rot = -Math.atan2(dx, dz); c.top = y + CAR.roofTop;
    // (rot: the box's local z (hd) runs along the heading; see player.collide)
  }
  end() { for (let i = this.k; i < this.list.length; i++) { const c = this.list[i]; c.x = PARK; c.z = PARK; } }
}
