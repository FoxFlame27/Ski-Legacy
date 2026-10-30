// Broadcast presentation: the game-wide time scale (slow motion on big moments).
//
//   import { presentation } from './game/presentation/index.js';
//   // main.js, every frame, BEFORE anything simulates:
//   presentation.update(rawDt, { player, paused });
//   const dt = paused ? 0 : rawDt * presentation.timeScale;
//
//   presentation.slowMo({ scale: 0.35, hold: 1 });  // e.g. a photo finish (race session)
//
// Big airs are spotted here for free ride and races alike: a flight predicted to last longer than
// BIG_AIR seconds drops the world to SLOW_SCALE for about a second (eased in and out, in real time), so
// the apex plays in slow motion and normal speed is back for the landing.
// The race intro, replays and the podium (src/modes/race/session.js + this folder) run on real time.
import { smoothstep } from '../../core/noise.js';
import { isMP } from '../../net/mode.js';

export const BIG_AIR = 1.2;        // s of predicted (or actual) airtime that counts as a big air
export const SLOW_SCALE = 0.35;    // world speed at the bottom of a slow-motion moment
const AIR_ARM = 0.3;               // s into the flight before a predicted big air triggers
const COOLDOWN = 1.6;              // real s after a slow-motion before the next one may start

export class Presentation {
  constructor() {
    this.timeScale = 1;
    this.enabled = true;   // false = never slow down (e.g. a settings toggle)
    this.slow = null;      // { t, scale, easeIn, hold, easeOut, reason }
    this.cooldown = 0;
    this.airArmed = true;  // one slow-motion per flight
    this.cinematic = null; // set by the race session while an intro / replay / podium owns the camera
  }

  /** True while a slow-motion moment is running. */
  get slowing() { return !!this.slow; }

  /**
   * Start a slow-motion moment (ignored while one runs or during the cooldown).
   * Durations are real (wall-clock) seconds.
   * @returns {boolean} started
   */
  slowMo({ scale = SLOW_SCALE, easeIn = 0.18, hold = 1.0, easeOut = 0.4, reason = '' } = {}) {
    if (!this.enabled || this.slow || this.cooldown > 0) return false;
    this.slow = { t: 0, scale, easeIn, hold, easeOut, reason };
    return true;
  }

  /** Back to full speed at once (restart, respawn, menus). */
  cancel() {
    this.slow = null;
    this.timeScale = 1;
  }

  /**
   * Per frame with the real frame time. Returns the time scale for this frame.
   * @param {number} rawDt
   * @param {{ player?: object, paused?: boolean }} [ctx]
   */
  update(rawDt, { player, paused = false } = {}) {
    if (paused || !(rawDt > 0)) return this.timeScale;
    // multiplayer: never slow your own world down. Everyone else keeps real time, so each big air's slow motion
    // (~1 s of real time lost, ~40 m at 144 km/h) left you behind your friends (Oct 30: "he overtook me easily")
    if (isMP()) { this.slow = null; this.timeScale = 1; return 1; }
    this.cooldown = Math.max(0, this.cooldown - rawDt);
    if (player && !this.cinematic) this.watchAir(player);
    const s = this.slow;
    if (!s) { this.timeScale = 1; return 1; }
    s.t += rawDt;
    const end = s.easeIn + s.hold + s.easeOut;
    if (s.t >= end || this.cinematic) {
      this.slow = null;
      this.timeScale = 1;
      this.cooldown = COOLDOWN;
      return 1;
    }
    const k = smoothstep(0, s.easeIn, s.t) * (1 - smoothstep(s.easeIn + s.hold, end, s.t));
    this.timeScale = 1 + (s.scale - 1) * k;
    return this.timeScale;
  }

  // Big airs: the player's controller predicts the flight time at take-off (player.airEnd).
  watchAir(pl) {
    if (!pl.air || pl.mode !== 'ski') { this.airArmed = true; return; }
    if (!this.airArmed || pl.frozen) return;
    const t = pl.airTime || 0;
    const predicted = Number.isFinite(pl.airEnd) ? pl.airEnd : 0;
    if ((t > AIR_ARM && predicted >= BIG_AIR) || t >= BIG_AIR) {
      this.airArmed = false;
      // the longer the flight, the longer the slow part (never past the landing)
      const left = Math.max(0, (predicted || t) - t);
      this.slowMo({ hold: Math.min(1.3, Math.max(0.6, left * 1.6)), reason: 'air' });
    }
  }
}

export const presentation = new Presentation();
