// Conversations. Talking to a person (a ski-school guest you guide, a delivery recipient, a skier down
// in the snow, the ticket seller) is a small cinematic: the camera eases in (0.6 s) to an
// over-the-shoulder two-shot that frames the person's face and upper body, with your own shoulder soft
// at the edge of the frame; cinema bars slide in, the HUD fades and the dialog card moves to the side
// of the screen away from the face. The person turns to you, looks you in the eye and talks with a nod
// and an open-hand gesture (the same procedural posing the rigs already use). Your controls are off
// while the dialog is open and you stand still; closing it eases the camera back to the game camera.
//
//   talk.say(speaker, { name, role }, html, options)   // opens hud.dialog as a conversation
//   talk.update(dt)                                    // every frame, after the player and the people moved
//   talk.yawFor(rig, baseYaw, dt)                      // heading for a rig its owner poses (the ticket seller)
//
// speaker: { id, anchor: Vector3 (feet, live), rig?, still?, turn?(yaw, dt) }. `still` = a rig nobody
//          re-poses every frame (a skier sitting in the snow): the head turn is undone each frame instead
//          of piling up. Only people: boards, the ski bus and lifts keep the plain dialog.
// The shot is picked when the conversation starts from a few candidates (over the right shoulder, the
// left, closer, a side-on two-shot, a high one; for someone sitting in the snow, round to where their
// face looks), the first that keeps the camera out of buildings, colliders, trees and the snow with a
// clear view of the face. No depth of field: the game keeps every image sharp on purpose.
import * as THREE from 'three';
import { world } from '../world/world.js';
import { worldPos, worldQuat, setWorldQuat, rotateWorld, solveTwoBone } from './jobs/pose.js';
import { edgeDist } from './jobs/sites.js';

const BLEND = 0.6;       // s to ease in / out
const SWITCH = 0.6;      // s to move from one speaker's shot to the next
const DEG = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);
const EYE = 1.58;        // the player's eye over the snow (standing)
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const easeIO = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// candidate shots, best first: over your right shoulder (you at the left edge under the card, them on
// the right third), the left shoulder, the same closer in, side-on two-shots, a higher one from behind.
// `back` scales with how far apart you stand; the sideways offset is solved so you land at the edge.
const SHOTS = [
  { side: 1, back: 1 },
  { side: -1, back: 1 },
  { side: 1, back: 0.7 },
  { side: -1, back: 0.7 },
  { profile: 1 },
  { profile: -1 },
  { side: 1, back: 1.5, lift: 0.7 },
];
// Someone sitting in the snow can't turn round to you, only their head: the camera goes round to where
// it sees their face (their head turned toward you), a few metres off, with you standing beyond them on
// the side of the screen the dialog card is on.
const RING_STEP = 15 * DEG, RING_R = 2.8;
const HEAD_LIM = 1.1;    // how far a head turns from the body's facing to look at you (rad)
// framing per kind of speaker: how much of them is in frame (m, vertically), where their face goes on
// screen (xs, ys in -1..1) and where your own centre goes (px: just past the edge, only a shoulder shows)
const FRAMING = {
  person: { frame: 1.4, xs: 0.36, ys: 0.3, px: -0.98 },
  seated: { frame: 1.2, xs: 0.34, ys: 0.22, px: -0.95 },
};

const CSS = `
#talk-bars { position: fixed; inset: 0; z-index: 39; pointer-events: none; }
#talk-bars i { position: absolute; left: 0; right: 0; height: 8.5vh; background: #04070d; transition: transform 0.6s cubic-bezier(.65,0,.35,1); }
#talk-bars i:first-child { top: 0; transform: translateY(-101%); }
#talk-bars i:last-child { bottom: 0; transform: translateY(101%); }
#talk-bars.on i { transform: none; }
#hud.talk-hide { opacity: 0; transition: opacity 0.35s ease; }
#hud.talk-show { transition: opacity 0.5s ease; }
#panel.talk { align-items: flex-end; justify-content: flex-start;
  background: linear-gradient(90deg, rgba(4,14,34,0.74) 0%, rgba(4,14,34,0.46) 30%, rgba(4,14,34,0) 58%); }
#panel.talk.talk-right { justify-content: flex-end;
  background: linear-gradient(270deg, rgba(4,14,34,0.74) 0%, rgba(4,14,34,0.46) 30%, rgba(4,14,34,0) 58%); }
#panel.talk .card { width: min(540px, 40vw); max-height: 66vh; margin: 0 4.5vw calc(8.5vh + 3.5vh); animation: talkCard 0.45s cubic-bezier(.2,.9,.2,1) both; }
#panel.talk.talk-right .card { animation-name: talkCardR; }
@keyframes talkCard { from { opacity: 0; translate: -26px 0; } }
@keyframes talkCardR { from { opacity: 0; translate: 26px 0; } }
#panel.talk .dialog .say { margin-top: 12px; }
.dialog .who .talk-name { display: inline-block; padding: 6px 40px 6px 20px; background: #fff; color: var(--blue); clip-path: var(--brush-a);
  font-family: var(--num); font-size: 30px; font-weight: 700; font-style: italic; letter-spacing: 0.03em; text-transform: none; text-shadow: none;
  filter: drop-shadow(0 6px 14px rgba(0,0,0,0.3)); }
.dialog .who .talk-role { display: block; margin: 8px 0 0 4px; }
`;

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3(), _e = new THREE.Vector3();
const _F = new THREE.Vector3(), _T = new THREE.Vector3(), _P = new THREE.Vector3(), _q = new THREE.Quaternion(), _q0 = new THREE.Quaternion();
const _m = new THREE.Matrix4(), _ndc = new THREE.Vector3();
const _base = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), fov: 65 };
const _shot = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), fov: 40, F: new THREE.Vector3() };
const _mix = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), fov: 40 };
const _sol = { pos: new THREE.Vector3(), aim: new THREE.Vector3(), F: new THREE.Vector3(), vf: 30, xs: 0, ys: 0 };

// The head's forward axis in head-bone space, from the bind pose (characters face +Z at bind).
const headAxes = new WeakMap();
function headAxis(rig) {
  let a = headAxes.get(rig);
  if (a) return a;
  const chain = [];
  for (let o = rig.b.head; o && o !== rig.root; o = o.parent) chain.push(o);
  const q = new THREE.Quaternion();
  for (let i = chain.length - 1; i >= 0; i--) {
    const o = chain[i], k = rig.allBones ? rig.allBones.indexOf(o) : -1;
    q.multiply(k >= 0 && rig.rest?.[k] ? rig.rest[k].q : o.quaternion);
  }
  a = new THREE.Vector3(0, 0, 1).applyQuaternion(q.invert()).normalize();
  headAxes.set(rig, a);
  return a;
}

// A bone the conversation turns on top of its owner's pose. A rig that is re-posed every frame starts
// from the fresh pose; on a rig nobody re-poses (still) last frame's turn is taken back first.
class Guard {
  constructor(bone) { this.bone = bone; this.pre = new THREE.Quaternion(); this.post = new THREE.Quaternion(); this.on = false; }
  begin() {
    const b = this.bone;
    if (this.on && b.quaternion.equals(this.post)) { b.quaternion.copy(this.pre); b.updateMatrixWorld(true); }
    this.pre.copy(b.quaternion);
    this.on = true;
  }
  commit() { this.post.copy(this.bone.quaternion); }
  release() {
    const b = this.bone;
    if (this.on && b.quaternion.equals(this.post)) { b.quaternion.copy(this.pre); b.updateMatrixWorld(true); }
    this.on = false;
  }
}

export class Talk {
  /**
   * @param {object} o
   * @param {THREE.PerspectiveCamera} o.camera
   * @param {object} o.player       Player (pos, heading, mode, view, rig, vel)
   * @param {object} o.hud          HUD (dialog)
   * @param {object[]} [o.colliders]  the player's colliders (the camera stays out of them)
   * @param {THREE.Object3D[]} [o.blockers]  buildings the camera must not go into or look through
   * @param {object} [o.vegetation]  trees (collide(x, z, r))
   */
  constructor({ camera, player, hud, colliders = [], blockers = [], vegetation = null }) {
    this.camera = camera;
    this.player = player;
    this.hud = hud;
    this.colliders = colliders;
    this.blockers = blockers;
    this.vegetation = vegetation;
    this.on = false;          // a conversation dialog is open
    this.blend = BLEND;       // s to ease in / out
    this.t = 0;               // 0..1 blend progress (eased into k)
    this.k = 0;
    this.speaker = null;
    this.shot = null;         // chosen candidate for the speaker
    this.switchT = 1;         // moving from one speaker's shot to another's
    this.from = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), fov: 40 };
    this.sP = new THREE.Vector3(); this.sN = new THREE.Vector3();
    this.faceH = 1.6;
    this.cfg = FRAMING.person;
    this.lineT = 0;           // s since the current line was said
    this.gw = 0;              // gesture weight
    this.arm = 1;             // gesturing arm (0 left, 1 right)
    this.guards = [];
    this.yaws = new WeakMap();
    this.viewWas = null;
    this.eyeBase = null;      // the first-person view you started talking from
    this.cardRight = false;
    this.ray = new THREE.Raycaster();
    this.dom = null;
    this.why = '';            // why the last candidate shot was turned down (tests read `tried`)
    this.tried = [];
  }

  get active() { return this.on; }
  /** The camera is (partly) in a conversation shot. */
  get busy() { return this.on || this.k > 0; }

  // ------------------------------------------------------------------ dialog
  /** Open a dialog as a conversation with `speaker` (falls back to a plain dialog without one). */
  say(speaker, head, html, options) {
    const name = head?.name || '', role = head?.role || '';
    if (!speaker || !this.player) {
      this.hud.dialog(esc(role ? `${name} · ${role}` : name), html, options);
      return;
    }
    this.begin(speaker);
    this.lineT = 0;
    this.hud.dialog(`<span class="talk-name">${esc(name)}</span>${role ? `<span class="talk-role">${esc(role)}</span>` : ''}`, html, options);
    this.markPanel();
  }

  markPanel() {
    const p = this.dom?.panel;
    if (!p) return;
    p.classList.add('talk');
    p.classList.toggle('talk-right', this.cardRight);
  }

  dialogOpen() {
    const p = this.dom?.panel;
    if (!p || p.hidden) return false;
    return !!p.querySelector('.talk-name');
  }

  ensureDom() {
    if (this.dom || typeof document === 'undefined') return;
    if (!document.getElementById('talk-style')) {
      const st = document.createElement('style');
      st.id = 'talk-style';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    let bars = document.getElementById('talk-bars');
    if (!bars) {
      bars = document.createElement('div');
      bars.id = 'talk-bars';
      bars.innerHTML = '<i></i><i></i>';
      document.body.appendChild(bars);
    }
    this.dom = { bars, panel: document.getElementById('panel'), hud: document.getElementById('hud') };
  }

  // ------------------------------------------------------------------ start / end
  begin(sp) {
    this.ensureDom();
    const pl = this.player;
    const same = this.speaker && this.speaker.id === sp.id;
    if (!same) {
      const switching = this.speaker && this.k > 0.01;
      if (switching) {
        // carry on from wherever the camera is now
        this.from.pos.copy(this.camera.position); this.from.quat.copy(this.camera.quaternion);
        this.from.fov = (2 * Math.atan(Math.tan((this.camera.fov * DEG) / 2) / (this.camera.zoom || 1))) / DEG; // the lens it shows now
        this.switchT = 0;
      } else this.switchT = 1;
      this.releaseGuards();
      this.speaker = sp;
      this.measure(sp);
      if (!switching) this.sN.copy(sp.anchor);
      this.sP.copy(pl.pos);
      this.shot = this.pickShot();
      this.gw = 0;
      // the hand on the camera's side gestures
      if (sp.rig?.b?.rArm) {
        const h = sp.rig.root.rotation.y, rx = -Math.cos(h), rz = Math.sin(h);
        const cx = this.shotCam(this.shot, _a);
        this.arm = cx ? ((cx.x - sp.anchor.x) * rx + (cx.z - sp.anchor.z) * rz >= 0 ? 1 : 0) : 1;
      }
    }
    if (!this.on) {
      this.on = true;
      if (!same && this.k <= 0) this.sP.copy(pl.pos);
      // see yourself over the shoulder (first person hides the body)
      // (the shot eases in from the eye, while the third-person camera settles unseen behind you)
      if (pl.view === 'first') {
        const cam = this.camera;
        this.viewWas = 'first'; pl.view = 'third'; pl.camPos?.copy(cam.position);
        this.eyeBase = { pos: cam.position.clone(), quat: cam.quaternion.clone(), fov: (2 * Math.atan(Math.tan((cam.fov * DEG) / 2) / (cam.zoom || 1))) / DEG };
      }
      // stand still for the conversation
      if (pl.mode === 'ski' && !pl.air) { pl.vel.set(0, 0, 0); pl.parked = true; }
      else if (pl.mode === 'walk') pl.vel.set(0, 0, 0);
      this.dom?.bars.classList.add('on');
      if (this.dom?.hud) { this.dom.hud.classList.remove('talk-show'); this.dom.hud.classList.add('talk-hide'); }
    }
  }

  end() {
    if (!this.on) return;
    this.on = false;
    const p = this.dom?.panel;
    p?.classList.remove('talk', 'talk-right');
    this.dom?.bars.classList.remove('on');
    if (this.dom?.hud) { this.dom.hud.classList.remove('talk-hide'); this.dom.hud.classList.add('talk-show'); }
    if (this.viewWas) { this.player.view = this.viewWas; this.viewWas = null; }
    this.eyeBase = null;
  }

  // how tall the speaker is where the face is, and how much of them to frame
  measure(sp) {
    let h = 1.6;
    const head = sp.rig?.b?.head;
    if (head) {
      sp.rig.root.updateMatrixWorld(true);
      h = worldPos(head, _a).y - sp.anchor.y + 0.07;
    }
    this.faceH = clamp(Number.isFinite(h) ? h : 1.6, 0.45, 1.95);
    this.cfg = this.faceH < 1.2 ? FRAMING.seated : FRAMING.person;
  }

  // ------------------------------------------------------------------ shots
  // the line from you to them, and your right when facing them
  axes(out) {
    const P = this.sP, N = this.sN;
    let ux = N.x - P.x, uz = N.z - P.z;
    const L = Math.hypot(ux, uz);
    if (L < 0.3) { ux = Math.sin(this.player.heading); uz = Math.cos(this.player.heading); } else { ux /= L; uz /= L; }
    out.ux = ux; out.uz = uz; out.rx = -uz; out.rz = ux; out.L = L;
    return out;
  }

  facePoint(out) {
    const N = this.sN;
    return out.set(N.x, N.y + this.faceH, N.z);
  }

  // Solve a candidate: camera position, lens, where the aim point goes on screen.
  solve(sh, out) {
    const A = this.axes(this._ax ??= {}), P = this.sP, F = this.facePoint(out.F);
    const cfg = this.cfg, asp = this.camera.aspect || 16 / 9, C = out.pos;
    out.aim.copy(F);
    if (sh.ring !== undefined) {
      const V = this.sN;
      const R = sh.R ?? RING_R;
      C.set(V.x + Math.sin(sh.ring) * R, F.y + 0.4, V.z + Math.cos(sh.ring) * R);
      out.vf = clamp((2 * Math.atan(0.8 / Math.max(0.5, C.distanceTo(F)))) / DEG, 26, 44);
      out.xs = 0.3; out.ys = 0.16;
    } else if (sh.profile) {
      // side-on: both of you in frame, centred between you
      const mx = (P.x + this.sN.x) / 2, mz = (P.z + this.sN.z) / 2, d = clamp(A.L * 0.9 + 1.5, 2.3, 3.8);
      C.set(mx + A.rx * sh.profile * d - A.ux * 0.45, (P.y + EYE + F.y) / 2 + 0.06, mz + A.rz * sh.profile * d - A.uz * 0.45);
      out.aim.set((F.x + P.x) / 2, (F.y + P.y + EYE) / 2, (F.z + P.z) / 2);
      const sep = A.L + 1.6; // frame width needed
      out.vf = clamp((2 * Math.atan(sep / 2 / Math.max(0.5, C.distanceTo(out.aim)) / asp)) / DEG, 26, 50);
      out.xs = 0; out.ys = 0.2;
    } else {
      // over the shoulder: eye level between your eyes and theirs (looking down at someone sitting)
      const hc = (this.cfg === FRAMING.seated ? clamp(F.y - P.y + 0.62, 1.25, 1.55) : clamp(0.55 * (F.y - P.y) + 0.45 * EYE, 0.95, 1.72)) + (sh.lift || 0);
      const D = Math.max(0.6, A.L), b = clamp(0.62 * D, 0.75, 1.5) * sh.back;
      // sideways offset so that you sit at px and they at xs: the angle between you two seen from the
      // camera, atan(s/b) - atan(s/(b+D)), must match the angle between those two screen points
      const gap = (x) => Math.atan(x / b) - Math.atan(x / (b + D));
      const sMax = Math.min(2.2, Math.sqrt(b * (b + D)));
      let s = 1, vf = 30;
      for (let it = 0; it < 3; it++) {
        const dist = Math.hypot(D + b, s, F.y - P.y - hc);
        vf = clamp((2 * Math.atan(cfg.frame / 2 / dist)) / DEG, 20, 46);
        const th = Math.tan((vf * DEG) / 2) * asp;
        const want = Math.atan(cfg.xs * th) - Math.atan(cfg.px * th);
        if (gap(sMax) <= want) s = sMax;
        else {
          let lo = 0.2, hi = sMax;
          for (let k = 0; k < 22; k++) { const m = (lo + hi) / 2; if (gap(m) < want) lo = m; else hi = m; }
          s = (lo + hi) / 2;
        }
      }
      const sd = s * sh.side;
      C.set(P.x - A.ux * b + A.rx * sd, P.y + hc, P.z - A.uz * b + A.rz * sd);
      out.vf = vf; out.xs = cfg.xs * sh.side; out.ys = cfg.ys;
    }
    const g = world.groundHeight(C.x, C.z, C.y + 1);
    if (Number.isFinite(g) && C.y < g + 0.38) C.y = g + 0.38;
    return out;
  }

  // camera position of a candidate (null if none)
  shotCam(sh, out) {
    if (!sh) return null;
    return out.copy(this.solve(sh, _sol).pos);
  }

  // full pose of a candidate shot: position, orientation and vertical fov
  shotPose(sh, out) {
    const S = this.solve(sh, _sol), asp = this.camera.aspect || 16 / 9;
    const C = out.pos.copy(S.pos), aim = S.aim, vf = S.vf;
    out.F.copy(S.F);
    const vx = aim.x - C.x, vy = aim.y - C.y, vz = aim.z - C.z;
    const th = Math.tan((vf * DEG) / 2) * asp;
    const yaw = Math.atan2(vx, vz) + Math.atan(S.xs * th);
    const pitch = Math.atan2(vy, Math.hypot(vx, vz)) - Math.atan(S.ys * Math.tan((vf * DEG) / 2));
    _d.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
    _m.lookAt(C, _e.copy(C).add(_d), UP);
    out.quat.setFromRotationMatrix(_m);
    out.fov = vf;
    return out;
  }

  // Shots around someone who can't turn to you, best first: close to where their face looks (their body's
  // facing, the head turned your way as far as it goes), with you on the screen's left of them.
  ringShots() {
    const sp = this.speaker, V = this.sN, P = this.sP, h = sp.rig?.root?.rotation.y;
    if (!Number.isFinite(h)) return [];
    const toYou = Math.atan2(P.x - V.x, P.z - V.z);
    const face = h + clamp(wrap(toYou - h), -HEAD_LIM, HEAD_LIM); // where their face will look (see lookAt)
    const out = [];
    for (const R of [RING_R, RING_R + 0.7]) {
      for (let k = -5; k <= 5; k++) {
        const yaw = face + k * RING_STEP;
        const cx = V.x + Math.sin(yaw) * R, cz = V.z + Math.cos(yaw) * R;
        // where you stand on screen relative to them (+ = to the right), seen from there
        const ax = V.x - cx, az = V.z - cz, bx = P.x - cx, bz = P.z - cz;
        const sep = Math.atan2(-az * bx + ax * bz, ax * bx + az * bz);
        let score = Math.abs(k) + (R > RING_R ? 1.5 : 0);
        if (sep > -0.15) score += 20;          // you would be behind them or on their right: the card covers them
        if (Math.abs(wrap(yaw - toYou)) < 0.6) score += 40; // between you two: your back to the lens
        out.push({ ring: yaw, R, score });
      }
    }
    return out.sort((a, b) => a.score - b.score);
  }

  // A scratch camera posed as a candidate shot would be (to see where things land on screen).
  probe(sh) {
    const pose = this.shotPose(sh, _shot), cam = (this.probeCam ??= new THREE.PerspectiveCamera());
    cam.aspect = this.camera.aspect || 16 / 9; cam.fov = pose.fov; cam.near = 0.1; cam.far = 1000;
    cam.position.copy(pose.pos); cam.quaternion.copy(pose.quat);
    cam.updateMatrixWorld(); cam.updateProjectionMatrix();
    return cam;
  }

  // where you would stand on screen in a shot: x of your middle (-9 off to the left .. 9 off to the right)
  // and how far you are from the lens
  youOnScreen(sh) {
    const cam = this.probe(sh), P = this.sP;
    _ndc.set(P.x, P.y + 1, P.z).project(cam);
    const x = _ndc.z > 1 ? 9 : _ndc.x;
    return { x, d: cam.position.distanceTo(_T.set(P.x, P.y + 1, P.z)) };
  }

  // the first candidate that keeps the camera clear (null: no move, just the bars and the person)
  pickShot() {
    const F = this.facePoint(_P.clone());
    let list = SHOTS;
    if (this.speaker.still) {
      // round someone sitting in the snow: you are better out of shot (or small at its edge) than
      // standing big in the middle of it, legs and poles across their face
      const ring = this.ringShots();
      for (const sh of ring) {
        const y = this.youOnScreen(sh);
        if (y.x > -1.02 && y.x < 1.02 && y.d < 5) sh.score += y.x > -0.55 ? 25 : 8;
      }
      ring.sort((a, b) => a.score - b.score);
      list = [...ring, ...SHOTS];
    }
    this.tried = [];
    for (const sh of list) {
      const C = this.shotCam(sh, _c);
      const ok = !!C && this.clear(C, F);
      this.tried.push(ok ? 'ok' : this.why);
      if (ok) {
        // which side of the screen the face ends up on: the card goes to the other side
        _ndc.copy(F).project(this.probe(sh));
        this.cardRight = _ndc.x < 0;
        return sh;
      }
    }
    this.cardRight = false;
    return null;
  }

  // the camera point is out of every building, collider, tree and person, and sees the face
  clear(C, F) {
    const P = this.player.pos, N = this.speaker.anchor;
    if (Math.hypot(C.x - N.x, C.z - N.z) < 0.75) { this.why = 'near them'; return false; }
    if (Math.hypot(C.x - P.x, C.z - P.z) < 0.5) { this.why = 'near you'; return false; }
    const gy = world.groundHeight(C.x, C.z, C.y + 1);
    for (const c of this.colliders) {
      const reach = (c.r ?? Math.max(c.hw, c.hd)) + 0.4;
      if (Math.abs(C.x - c.x) > reach || Math.abs(C.z - c.z) > reach) continue;
      if (c.top !== undefined && C.y > c.top + 0.3) continue;
      if (edgeDist(c, C.x, C.z) < 0.3) { this.why = 'collider'; return false; }
    }
    // no lift station or other building (a big collider) between the camera and the face
    for (const f of [0.2, 0.4, 0.6, 0.75]) {
      const x = C.x + (F.x - C.x) * f, z = C.z + (F.z - C.z) * f;
      for (const c of this.colliders) {
        const size = c.r ?? Math.max(c.hw, c.hd);
        if (size < 1.6 || Math.abs(x - c.x) > size + 0.5 || Math.abs(z - c.z) > size + 0.5) continue;
        if (c.top !== undefined && C.y + (F.y - C.y) * f > c.top) continue;
        if (edgeDist(c, x, z) < 0) { this.why = 'building between'; return false; }
      }
    }
    // trees: the camera never sits in the branches, and no trunk stands in the way
    const veg = this.vegetation;
    if (veg?.collide) {
      const t = veg.collide(C.x, C.z, 1.1);
      if (t && C.y < t.y + t.s + 0.5) { this.why = 'tree at camera'; return false; }
      for (const f of [0.3, 0.55, 0.8]) {
        const x = C.x + (F.x - C.x) * f, z = C.z + (F.z - C.z) * f;
        if (veg.collide(x, z, 0.15)) { this.why = 'trunk between'; return false; }
      }
    }
    // the snow (a bump between the camera and the face)
    for (const f of [0.35, 0.7]) {
      const x = C.x + (F.x - C.x) * f, z = C.z + (F.z - C.z) * f, y = C.y + (F.y - C.y) * f;
      if (world.groundHeight(x, z, y + 1) > y - 0.1) { this.why = 'snow between'; return false; }
    }
    if (!Number.isFinite(gy)) { this.why = 'no ground'; return false; }
    // buildings: none between you and the camera, none between the camera and the face (the booth
    // window's own frame right around the seller's face does not count)
    if (this.blockers?.length) {
      const chest = _a.set(P.x, P.y + 1.3, P.z);
      if (this.hits(chest, C, 0.25)) { this.why = 'wall behind you'; return false; }
      if (this.hits(C, F, 0.9)) { this.why = 'wall between'; return false; }
    }
    this.why = '';
    return true;
  }

  hits(from, to, spare) {
    const d = _b.subVectors(to, from), len = d.length();
    if (len < 1e-3) return false;
    this.ray.set(from, d.divideScalar(len));
    this.ray.far = Math.max(0.01, len - spare + 0.3);
    const h = this.ray.intersectObjects(this.blockers, true)[0];
    return !!h && h.distance < len - spare + 0.3;
  }

  // ------------------------------------------------------------------ per frame
  update(dt) {
    if (!this.speaker && this.k <= 0) return;
    dt = Math.min(Math.max(dt || 0, 0), 0.05);
    const pl = this.player;
    if (this.on && (!this.dialogOpen() || pl.mode === 'sit' || pl.mode === 'fall')) this.end();
    this.t = clamp(this.t + (this.on ? dt / this.blend : -dt / this.blend), 0, 1);
    this.k = easeIO(this.t);
    const sp = this.speaker;
    if (sp) {
      const s = 1 - Math.exp(-dt * 6);
      this.sN.lerp(sp.anchor, s);
      this.sP.lerp(pl.pos, s);
      this.lineT += dt;
      if (this.on) {
        // face each other
        const N = this.sN, P = pl.pos;
        const toThem = Math.atan2(N.x - P.x, N.z - P.z);
        if (Math.hypot(N.x - P.x, N.z - P.z) > 0.3 && (pl.mode === 'walk' || (pl.mode === 'ski' && !pl.air))) {
          pl.heading += wrap(toThem - pl.heading) * (1 - Math.exp(-dt * 5));
        }
        if (pl.mode === 'ski' && !pl.air) { pl.vel.set(0, 0, 0); pl.parked = true; }
        sp.turn?.(Math.atan2(P.x - sp.anchor.x, P.z - sp.anchor.z), dt);
      }
      // the person talks: look at you, nod, gesture
      this.gw += ((this.on ? 1 : 0) - this.gw) * (1 - Math.exp(-dt * (this.on ? 3 : 5)));
      if (sp.rig?.b?.head && this.gw > 0.002) this.animate(sp);
      else this.releaseGuards();
      if (this.switchT < 1) this.switchT = Math.min(1, this.switchT + dt / (SWITCH * this.blend / BLEND));
    }
    if (this.k > 0 && this.shot) this.applyCamera();
    else if (this.camera.zoom !== 1) { this.camera.zoom = 1; this.camera.updateProjectionMatrix(); }
    if (!this.on && this.t <= 0) {
      this.releaseGuards();
      this.speaker = null;
      this.shot = null;
      if (this.camera.zoom !== 1) { this.camera.zoom = 1; this.camera.updateProjectionMatrix(); }
      if (this.dom?.hud) this.dom.hud.classList.remove('talk-show');
    }
  }

  // Blend the game camera (already posed this frame by the player) with the conversation shot. The
  // position swings around you (never through you) and the lens narrows through camera.zoom, so the
  // game camera's own FOV smoothing is never disturbed.
  applyCamera() {
    const cam = this.camera, k = this.k, live = cam.fov;
    const E = this.on ? this.eyeBase : null;
    if (E) { _base.pos.copy(E.pos); _base.quat.copy(E.quat); _base.fov = E.fov; } else { _base.pos.copy(cam.position); _base.quat.copy(cam.quaternion); _base.fov = live; }
    const S = this.shotPose(this.shot, _shot);
    let tgt = S;
    if (this.switchT < 1) {
      const e = easeIO(this.switchT);
      this.arc(this.from.pos, S.pos, e, _mix.pos);
      _mix.quat.slerpQuaternions(this.from.quat, S.quat, e);
      _mix.fov = this.from.fov + (S.fov - this.from.fov) * e;
      tgt = _mix;
    }
    this.arc(_base.pos, tgt.pos, k, cam.position);
    // a slow, barely-there drift, as if the camera were held (a locked-off frame looks frozen)
    const tt = performance.now() * 0.001;
    cam.position.x += Math.sin(tt * 0.37) * 0.014 * k;
    cam.position.y += Math.sin(tt * 0.29 + 1.3) * 0.01 * k;
    cam.position.z += Math.sin(tt * 0.31 + 2.1) * 0.014 * k;
    if (k < 1 || this.switchT < 1) this.keepClear(cam.position);
    cam.quaternion.slerpQuaternions(_base.quat, tgt.quat, k);
    const f = _base.fov + (tgt.fov - _base.fov) * k;
    cam.zoom = Math.tan((live * DEG) / 2) / Math.tan((f * DEG) / 2);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }

  // on the way between two clear camera spots: never under the snow, never through a wall
  keepClear(C) {
    const g = world.groundHeight(C.x, C.z, C.y + 1);
    if (Number.isFinite(g) && C.y < g + 0.3) C.y = g + 0.3;
    if (!this.blockers?.length) return;
    const P = this.player.pos, chest = _a.set(P.x, P.y + 1.3, P.z);
    const d = _b.subVectors(C, chest), len = d.length();
    if (len < 0.3) return;
    this.ray.set(chest, d.divideScalar(len));
    this.ray.far = len + 0.3;
    const h = this.ray.intersectObjects(this.blockers, true)[0];
    if (h && h.distance < len + 0.3) C.copy(chest).addScaledVector(this.ray.ray.direction, Math.max(0.4, h.distance - 0.3));
  }

  // interpolate two camera points around you: angle, distance and height separately
  arc(a, b, t, out) {
    const P = this.player.pos, px = P.x, pz = P.z;
    const ax = a.x - px, az = a.z - pz, bx = b.x - px, bz = b.z - pz;
    const ra = Math.hypot(ax, az), rb = Math.hypot(bx, bz);
    if (ra < 0.2 || rb < 0.2) return out.lerpVectors(a, b, t);
    const ya = Math.atan2(ax, az), yb = ya + wrap(Math.atan2(bx, bz) - ya);
    const y = ya + (yb - ya) * t, r = ra + (rb - ra) * t;
    out.set(px + Math.sin(y) * r, a.y + (b.y - a.y) * t, pz + Math.cos(y) * r);
    return out;
  }

  // ------------------------------------------------------------------ the person
  guardsFor(rig, gesture) {
    const b = rig.b;
    const want = [b.neck, b.head];
    if (gesture) {
      const i = this.arm;
      want.push(i ? b.rArm : b.lArm, i ? b.rFore : b.lFore, i ? b.rHand : b.lHand);
    }
    const list = want.filter(Boolean);
    if (this.guards.length !== list.length || this.guards.some((g, k) => g.bone !== list[k])) {
      this.releaseGuards();
      this.guards = list.map((bn) => new Guard(bn));
    }
    return this.guards;
  }

  releaseGuards() {
    for (let i = this.guards.length - 1; i >= 0; i--) this.guards[i].release();
    this.guards = [];
  }

  animate(sp) {
    const rig = sp.rig, b = rig.b;
    const w = smooth(0, 1, this.gw);
    // a hand gesture only standing on foot (a skier on skis or sitting in the snow just turns the head)
    const gesture = !sp.still && rig.mode === 'foot' && b.rArm && b.rFore && b.rHand && b.lArm && b.lFore && b.lHand;
    const guards = this.guardsFor(rig, gesture);
    for (const g of guards) g.begin();
    if (sp.still) rig.root.updateMatrixWorld(true);
    // talking for the first few seconds of each line, then listening (an occasional small nod)
    const t = this.lineT;
    const talking = 1 - smooth(2.4, 3.6, t);
    const nod = talking * 0.055 * Math.sin(t * 5.1) * (0.55 + 0.45 * Math.sin(t * 1.7))
      + (1 - talking) * 0.04 * Math.max(0, Math.sin(t * 1.9)) ** 6;
    // the hand comes up as they start to speak and goes back down when they are done
    const hand = smooth(0.1, 0.5, t) * (1 - smooth(2.7, 3.3, t));
    if (gesture) this.gestureArm(rig, w * hand * (0.92 + 0.08 * Math.sin(t * 2.3)), t);
    // look you in the eye
    const eye = this.player.rig?.b?.head ? worldPos(this.player.rig.b.head, _T).add(_e.set(0, 0.06, 0)) : _T.set(this.player.pos.x, this.player.pos.y + EYE, this.player.pos.z);
    this.lookAt(rig, eye, w, nod);
    for (const g of guards) g.commit();
  }

  lookAt(rig, target, w, nod) {
    const head = rig.b.head, neck = rig.b.neck, ax = headAxis(rig);
    const hp = worldPos(head, _a);
    const d = _b.subVectors(target, hp).normalize();
    const fw = _c.copy(ax).applyQuaternion(worldQuat(head, _q));
    // toward you, but never further round than the body allows (you behind them: over the shoulder on
    // the side the camera expects, see ringShots)
    const body = rig.root.rotation.y;
    const want = body + clamp(wrap(Math.atan2(d.x, d.z) - body), -HEAD_LIM, HEAD_LIM);
    const dy = clamp(wrap(want - Math.atan2(fw.x, fw.z)), -1.6, 1.6) * w;
    if (neck) rotateWorld(neck, UP, dy * 0.4);
    rotateWorld(head, UP, dy * (neck ? 0.6 : 1));
    fw.copy(ax).applyQuaternion(worldQuat(head, _q));
    const dp = clamp(Math.asin(clamp(d.y, -1, 1)) - Math.asin(clamp(fw.y, -1, 1)), -0.5, 0.45) * w + nod * w;
    const right = _d.crossVectors(fw, UP);
    if (right.lengthSq() > 1e-6) rotateWorld(head, right.normalize(), dp);
  }

  // An open hand in front of the body, palm up, moving a little with the words.
  gestureArm(rig, g, t) {
    if (g < 0.002) return;
    const b = rig.b, i = this.arm, side = i ? 1 : -1;
    const arm = i ? b.rArm : b.lArm, fore = i ? b.rFore : b.lFore, hand = i ? b.rHand : b.lHand;
    const h = rig.root.rotation.y;
    const fx = Math.sin(h), fz = Math.cos(h), rx = -fz, rz = fx;
    const S = worldPos(arm, _a);
    const H0 = worldPos(hand, _b);
    const beat = Math.sin(t * 2.6) * 0.5 + Math.sin(t * 4.3 + 1) * 0.25;
    const L = rig.armLen || 0.55;
    // forearm raised in front, the open hand a little out to the side at the height of the lower chest
    const tgt = _c.set(
      S.x + fx * L * 0.55 + rx * side * L * (0.42 + beat * 0.08),
      S.y - L * 0.2 + beat * 0.04,
      S.z + fz * L * 0.55 + rz * side * L * (0.42 + beat * 0.08),
    );
    tgt.x += rx * side * beat * 0.02; tgt.z += rz * side * beat * 0.02;
    const T = H0.lerp(tgt, g);
    // the hand's own (posed) orientation, to blend the open palm in
    const q0 = worldQuat(hand, _q0);
    const pole = _d.set(-fx * 0.45 + rx * side * 0.3, -0.85, -fz * 0.45 + rz * side * 0.3).normalize(); // elbow down by the side
    solveTwoBone(arm, fore, hand, T, pole);
    if (typeof rig.aimHand === 'function') {
      // fingers forward and a little out, palm up and in
      const dir = _e.set(fx * 0.85 + rx * side * 0.35, -0.08, fz * 0.85 + rz * side * 0.35).normalize();
      const palm = _F.set(-rx * side * 0.45, 0.9, -rz * side * 0.45).normalize();
      rig.aimHand(i, dir, palm);
      const q1 = worldQuat(hand, _q);
      setWorldQuat(hand, q0.slerp(q1, g));
    }
  }

  /** Heading for a rig its owner poses every frame (main.js: the ticket seller): turns to you while you talk. */
  yawFor(rig, base, dt) {
    let s = this.yaws.get(rig);
    if (!s) { s = { yaw: base }; this.yaws.set(rig, s); }
    let goal = base;
    if (this.on && this.speaker?.rig === rig) {
      const p = this.player.pos, r = rig.root.position;
      goal = base + clamp(wrap(Math.atan2(p.x - r.x, p.z - r.z) - base), -1.0, 1.0);
    }
    s.yaw += wrap(goal - s.yaw) * (1 - Math.exp(-(dt || 0) * 3));
    return s.yaw;
  }
}
