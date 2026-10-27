// Race intro: an ~8 s broadcast-style opening before the countdown.
//   Shot A (aerial): high above the start house, the camera swoops down the course on a smooth spline
//     built from the course line, weaving across the piste and past the first set piece (kicker,
//     tunnel, bridge, banked turns...). It stays within ~1 km of the start, where terrain and forest
//     are streamed at full detail.
//   Shot B (crane): a hard cut to the start gate: low in front of the field, the camera cranes up and
//     over the racers and settles into the player's own chase camera (exact hand-over, no snap).
// Letterbox bars and a lower third (course, length, drop, difficulty, weather) run on top; the whole
// thing is skippable. Real time only (never slowed by the presentation time scale).
import * as THREE from 'three';
import { clamp, lerp, smoothstep } from '../../core/noise.js';
import { applyCamera, keepAbove, ground, ease } from './cinecam.js';

const SHOT_A = 4.9;          // s aerial flight
const SHOT_B = 3.5;          // s start-gate crane
const L3_IN = 0.55, L3_OUT = SHOT_A + SHOT_B - 1.0;
const REACH = 950;           // m: straight-line distance from the start the flight may go
const SET_PIECES = ['kicker', 'tabletop', 'bridge', 'tunnel', 'lake', 'slalom', 'narrow', 'cliff', 'bank', 'roller'];

const _pos = new THREE.Vector3(), _look = new THREE.Vector3();

export class CourseIntro {
  /**
   * @param {object} o
   * @param {object} o.track    race Track (src/modes/race/bots.js): frame(s), s0, finishS
   * @param {object} o.course   course contract (start, features, name...)
   * @param {THREE.Camera} o.camera
   * @param {object} o.player   start-gate position + heading, chase camera
   * @param {object} [o.ui]     PresentationUI
   * @param {object} [o.info]   lower third: { kicker, title, stats }
   * @param {object} [o.audio]
   * @param {() => boolean} [o.waiting]  true while a transition still covers the screen (time holds)
   */
  constructor(o) {
    Object.assign(this, o);
    this.t = 0;
    this.done = false;
    this.l3 = 0; // 0 not shown, 1 shown, 2 gone
    this.cut = false;
    this.build();
  }

  get duration() { return SHOT_A + SHOT_B; }

  build() {
    const tr = this.track, c = this.course;
    const s0 = Number.isFinite(c.start?.s) ? c.start.s : tr.s0 + 4;
    const st = tr.frame(s0, {});
    // where the flight ends: past the first set piece within reach, else ~480 m down the course
    const feats = (c.features || []).filter((f) => SET_PIECES.includes(f.type) && f.s0 > s0 + 110 && f.s0 < s0 + 640)
      .sort((a, b) => a.s0 - b.s0);
    const f = feats[0];
    let sEnd = f ? clamp((f.land1 ?? f.s1) + 40, s0 + 360, s0 + 700) : s0 + 480;
    sEnd = Math.min(sEnd, tr.finishS - 40);
    const fr = {};
    while (sEnd > s0 + 250) {
      tr.frame(sEnd, fr);
      if (Math.hypot(fr.x - st.x, fr.z - st.z) < REACH) break;
      sEnd -= 20;
    }
    this.sEnd = sEnd;
    // control points every ~32 m: from 80 m behind and high above the start house, descending toward
    // the piste, weaving from one side of the nets to the other
    const sBack = s0 - 80;
    const n = Math.max(10, Math.round((sEnd - sBack) / 32));
    const side = (c.id ? [...String(c.id)].reduce((a, ch) => a + ch.charCodeAt(0), 0) : 0) & 1 ? 1 : -1;
    const pts = [], looks = [];
    for (let i = 0; i <= n; i++) {
      const u = i / n, s = lerp(sBack, sEnd, u);
      tr.frame(s, fr);
      const h = lerp(52, 16, smoothstep(0, 0.62, u)) + 4 * Math.sin(u * Math.PI * 2.6);
      const lat = side * (fr.w + 12) * Math.sin(u * Math.PI * 1.35) * smoothstep(0.02, 0.3, u);
      const x = fr.x + fr.nx * lat, z = fr.z + fr.nz * lat;
      const outside = Math.abs(lat) > fr.w;
      const y = Math.max(fr.y + h, ground(x, z, fr.y + h + 50) + (outside ? 22 : 11));
      pts.push(new THREE.Vector3(x, y, z));
      // look far down the course and a little above it: the valley and the peaks stay in frame
      const la = tr.frame(Math.min(s + 140, sEnd + 200), {});
      looks.push(new THREE.Vector3(la.x, la.y + 10 + 12 * (1 - u), la.z));
    }
    // smooth the heights (terrain clearance can make neighbours jump), never below the clearance
    const ys = pts.map((p) => p.y);
    for (let it = 0; it < 3; it++) {
      for (let i = 1; i < pts.length - 1; i++) pts[i].y = Math.max(ys[i], (pts[i - 1].y + pts[i].y * 2 + pts[i + 1].y) / 4);
    }
    this.pathA = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    this.lookA = new THREE.CatmullRomCurve3(looks, false, 'centripetal');
  }

  skip() {
    if (this.done) return;
    this.done = true;
    this.finishUI();
  }

  finishUI() {
    this.ui?.hideLowerThird();
    this.ui?.skipHint(null);
  }

  /** Per frame (real dt) after player.update(): poses the camera. Returns false once finished. */
  update(dt) {
    if (this.done) return false;
    const holding = this.waiting?.();
    if (!holding) this.t += dt;
    const t = this.t;
    if (t >= this.duration) { this.done = true; this.finishUI(); return false; }
    if (!holding && this.l3 === 0 && t >= L3_IN) { this.l3 = 1; if (this.info) this.ui?.lowerThird(this.info); this.ui?.skipHint('SKIP'); }
    if (this.l3 === 1 && t >= L3_OUT) { this.l3 = 2; this.ui?.hideLowerThird(); }
    if (t < SHOT_A) this.shotA(t / SHOT_A);
    else {
      if (!this.cut) { this.cut = true; this.audio?.play?.('whoosh'); }
      this.shotB((t - SHOT_A) / SHOT_B);
    }
    return true;
  }

  shotA(k) {
    // slow start out of the reveal, fast through the middle, easing into the set piece before the cut
    const u = clamp(0.22 * k + 0.78 * (k * k * (3 - 2 * k)), 0, 1);
    this.pathA.getPoint(u, _pos);
    this.lookA.getPoint(u, _look);
    keepAbove(_pos, 6);
    applyCamera(this.camera, _pos, _look, lerp(52, 44, u));
  }

  shotB(k) {
    const pl = this.player, p = pl.pos;
    const h = this.heading ?? pl.heading;
    const fx = Math.sin(h), fz = Math.cos(h), rx = -fz, rz = fx;
    const e = ease(k);
    // crane: in front of the field (looking up at the racers and the start house), up and over to one
    // side, down behind the player
    const a = lerp(0.18, Math.PI, e);
    // (inside the START arch, which stands 12 m below the gate: from 14 m out the crane rose straight through
    // its banner, a screen-filling blur of lettering)
    const R = lerp(9.5, 7, e);
    const side = this.craneSide ?? 1;
    const lift = Math.sin(a);
    _pos.set(
      p.x + fx * R * Math.cos(a) + rx * side * R * 0.55 * lift,
      p.y + 1.5 + 8 * lift + 0.04 * Math.sin(k * 9),
      p.z + fz * R * Math.cos(a) + rz * side * R * 0.55 * lift,
    );
    keepAbove(_pos, 1.2);
    _look.set(p.x + fx * 1.5 * e, p.y + 1.25, p.z + fz * 1.5 * e);
    // the last third blends into the gameplay chase camera (computed by player.update this frame)
    applyCamera(this.camera, _pos, _look, lerp(36, 52, e), smoothstep(0.6, 1, k));
  }
}
