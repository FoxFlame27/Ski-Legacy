// Personal bests in free ride: a new top speed, the longest jump, the biggest air and distance milestones.
// Each is announced once, with a small card in the top-right corner (the trick popups' house style, under
// them) and a soft chime: no clutter in the world, nothing over the slope ahead. Records live in save.stats
// (topSpeed is kept by main.js; this adds longestJump, bestAir and the last distance milestone reached).
// Races keep their own HUD: nothing is announced while one runs, but its speeds still count.

const KMH = 3.6;
const SPEED_MIN = 50 / KMH;      // records start counting from 50 km/h (no toast storm on a first run)
const SPEED_STEP = 2 / KMH;      // a new top speed must beat the old one by 2 km/h
const SPEED_SETTLE = 4 / KMH;    // ...and is announced once the skier is 4 km/h below the new peak
const JUMP_MIN = 10, JUMP_STEP = 1;   // m
const AIR_MIN = 1.2, AIR_STEP = 0.15; // s
const MILESTONES_KM = [5, 10, 25, 50, 100, 250, 500, 1000];

export class PersonalBests {
  /**
   * @param {object} o
   * @param {object} o.player       the Player (speed, mode, air, airTime, pos, lastLanding)
   * @param {object} o.save         the save game (stats)
   * @param {() => void} o.writeSave
   * @param {{best(o: object): void}} o.raceHud  shows the card
   * @param {{play(name: string): void}} [o.audio]
   */
  constructor({ player, save, writeSave, raceHud, audio }) {
    Object.assign(this, { player, save, writeSave, raceHud, audio });
    const st = save.stats;
    st.longestJump ??= 0;
    st.bestAir ??= 0;
    st.milestoneKm ??= MILESTONES_KM.filter((km) => st.distance >= km * 1000).pop() || 0;
    this.speedBest = st.topSpeed || 0; // the record as it stood before this peak
    this.peak = 0;
    this.wasAir = false;
    this.takeoff = { x: 0, z: 0 };
    this.queue = [];
    this.cooldown = 0;
  }

  /** Every frame while playing. `busy`: a race runs (or another full-screen UI is up). */
  update(dt, busy = false) {
    const p = this.player, st = this.save.stats;
    this.cooldown = Math.max(0, this.cooldown - dt);
    const sp = p.mode === 'ski' ? p.speed : 0;

    // ---- top speed: wait for the peak, then announce it once
    if (busy) {
      this.speedBest = Math.max(this.speedBest, sp);
      this.peak = 0;
    } else if (sp > Math.max(SPEED_MIN, this.speedBest + SPEED_STEP) || (this.peak && sp > this.peak)) {
      this.peak = Math.max(this.peak, sp);
    } else if (this.peak && sp < this.peak - SPEED_SETTLE) {
      this.speedBest = this.peak;
      // (a record that ends in a wipeout still counts, it just isn't celebrated)
      if (p.mode === 'ski') this.push({ kicker: 'PERSONAL BEST', title: 'TOP SPEED', value: Math.round(this.peak * KMH), unit: 'KM/H' });
      this.peak = 0;
    }

    // ---- jumps: distance over the snow from takeoff to landing, and time in the air
    const air = p.mode === 'ski' && p.air;
    if (air && !this.wasAir) this.takeoff = { x: p.pos.x, z: p.pos.z };
    if (!air && this.wasAir && p.mode === 'ski' && p.lastLanding?.landed !== 'crash') {
      // every landed jump counts for the records (races too); only clear new bests are announced
      let dist = Math.hypot(p.pos.x - this.takeoff.x, p.pos.z - this.takeoff.z);
      const t = p.airTime || 0;
      if (dist > Math.max(4, t * 40)) dist = 0; // moved by a teleport (respawn, lift), not by a jump
      const jumpPB = dist >= JUMP_MIN && dist >= st.longestJump + JUMP_STEP;
      const airPB = t >= AIR_MIN && t >= st.bestAir + AIR_STEP;
      st.longestJump = Math.max(st.longestJump, dist);
      st.bestAir = Math.max(st.bestAir, t);
      if (jumpPB && !busy) this.push({ kicker: 'PERSONAL BEST', title: 'LONGEST JUMP', value: Math.round(dist), unit: 'M', delay: 1.2 });
      else if (airPB && !busy) this.push({ kicker: 'PERSONAL BEST', title: 'BIGGEST AIR', value: t.toFixed(1), unit: 'SEC', delay: 1.2 });
      if (jumpPB || airPB) this.writeSave?.();
    }
    this.wasAir = air;

    // ---- distance milestones
    const next = MILESTONES_KM.find((km) => km > st.milestoneKm);
    if (next && st.distance >= next * 1000) {
      st.milestoneKm = next;
      if (!busy) this.push({ kicker: 'MILESTONE', title: 'DISTANCE SKIED', value: next, unit: 'KM' });
    }

    // ---- show (one card at a time, a short gap between them; never during a race)
    for (const q of this.queue) q.delay = Math.max(0, (q.delay || 0) - dt);
    if (!busy && this.cooldown <= 0 && this.queue.length && this.queue[0].delay <= 0) {
      const card = this.queue.shift();
      this.raceHud.best(card);
      this.audio?.play('gate');
      this.cooldown = 3.2;
    }
    if (busy) this.queue.length = 0;
  }

  push(card) {
    // a newer record of the same kind replaces one still waiting
    this.queue = this.queue.filter((q) => q.title !== card.title);
    this.queue.push(card);
  }
}
