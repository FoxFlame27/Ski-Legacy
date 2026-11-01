// RACE GUIDE (Nov 1 2026, the user: "once you come out of the Legacy Express to do a race, it's hard to find where
// the race is"): stepping off the Legacy Express, the Wolkenspitzbahn or the ski bus at a stop with a race close by
// (the race you picked when boarding, else the nearest within NEAR m) points you to it: the HUD arrow / waypoint, an
// objective line ("Race: <course> · follow the arrow · 240 m"), a tall soft glowing pillar with a floating race flag
// over its start / race board, and a row of orange pennant poles on the ground pointing the way. It ends when you
// get there (ARRIVE m: "press E to race"), start a race, take another ride, wander clearly elsewhere (1.5x the
// starting distance) or after MAX_T s. The trail map shows the target and the race boards (mapMarkers).
//   const guide = new RaceGuide({ scene, hud, busRaces, stand: () => raceStand });
//   guide.guideFrom(p, { pick: courseId, stop: busStopName })   // off a ride: start guiding (or not: no race near)
//   guide.update(dt, p, { busy })                                // every frame (busy: riding / racing -> it ends)
//   guide.waypoint() / hudLine() / mapMarkers()
import * as THREE from 'three';
import { world } from '../world/world.js';
import { K } from '../ui/prompts.js';
import { freeCourses } from '../modes/parkour/freeworld.js';

const NEAR = 600;       // m: a race this close to the stop is guided to
const PICKED = 2500;    // m: the race you picked as the destination, up to this far
const ARRIVE = 8;       // m from the start / board: there
const MAX_T = 180;      // s: the guide gives up
const POLE_STEP = 30, MAX_POLES = 16; // the pennant poles along the way

function gradTex() {
  const c = document.createElement('canvas');
  c.width = 4; c.height = 128;
  const g = c.getContext('2d'), gr = g.createLinearGradient(0, 0, 0, 128);
  gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.55, 'rgba(255,255,255,0.35)'); gr.addColorStop(1, 'rgba(255,255,255,1)');
  g.fillStyle = gr; g.fillRect(0, 0, 4, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
// a round race badge: white rim, the race's colour, a chequered flag
function flagTex(col) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.beginPath(); g.arc(64, 64, 60, 0, Math.PI * 2); g.fill();
  g.fillStyle = col; g.beginPath(); g.arc(64, 64, 52, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#ffffff'; g.fillRect(40, 30, 5, 70); // the pole
  const sq = 9;
  for (let i = 0; i < 5; i++) for (let j = 0; j < 4; j++) { g.fillStyle = (i + j) % 2 ? '#111111' : '#ffffff'; g.fillRect(45 + i * sq, 30 + j * sq, sq, sq); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const groundY = (x, z) => { try { const h = world.height(x, z); return Number.isFinite(h) ? h : 0; } catch { return 0; } };

export class RaceGuide {
  constructor({ scene, hud, busRaces = null, stand = null }) {
    this.scene = scene;
    this.hud = hud;
    this.busRaces = busRaces;
    this.stand = stand; // () => the village RACING stand (game/racestand.js), if there is one
    this.target = null; // { id, name, x, z, y?, color, at: 'start' | 'board', r }
    this.d = 0; this.d0 = 0; this.t = 0;
    this.group = null;
    this.poles = [];
  }

  /** The races you can be guided to: the World Racing courses' starts and the bus races' boards (else their starts). */
  races() {
    const out = [];
    try { for (const e of freeCourses()) out.push({ id: e.id, name: e.name, x: e.start.x, z: e.start.z, y: e.start.y, color: e.D?.color, at: 'start', r: 24 }); } catch { /* no courses */ }
    try {
      for (const e of this.busRaces?.list || []) {
        const f = e.board?.front;
        out.push(f ? { id: e.id, name: e.name, x: f.x, z: f.z, color: e.D?.color || '#e8a400', at: 'board', r: 2.3, stop: e.stop }
          : { id: e.id, name: e.name, x: e.start.x, z: e.start.z, y: e.start.y, color: e.D?.color || '#e8a400', at: 'start', r: 24, stop: e.stop });
      }
    } catch { /* no bus races */ }
    return out;
  }

  /** Off a ride at p: guide to the race picked (`pick`: a course id), the bus race at that stop, else the nearest. */
  guideFrom(p, { pick = null, stop = null } = {}) {
    this.clear();
    const list = this.races(), dist = (r) => Math.hypot(r.x - p.x, r.z - p.z);
    let t = pick != null ? list.find((r) => r.id === pick) : null;
    if (t && dist(t) > PICKED) t = null;
    if (!t && stop) { t = list.find((r) => r.stop === stop) || null; if (t && dist(t) > NEAR) t = null; }
    if (!t) { let best = NEAR; for (const r of list) { const d = dist(r); if (d < best) { best = d; t = r; } } }
    if (!t) return null;
    this.target = t;
    this.d = this.d0 = dist(t);
    this.t = 0;
    this.show(p);
    this.hud?.flash(`Race: ${t.name} · follow the arrow · ${Math.round(this.d)} m`, 'good', 4200);
    return t;
  }

  clear() {
    this.target = null;
    if (this.group) this.group.visible = false;
    for (const m of this.poles) this.group?.remove(m);
    this.poles.length = 0;
  }

  /** Every frame: ends the guide when you are there, racing, riding, gone elsewhere or after MAX_T s. */
  update(dt, p, { busy = false } = {}) {
    const t = this.target;
    if (!t) return;
    if (busy) { this.clear(); return; }
    this.t += dt;
    this.d = Math.hypot(t.x - p.x, t.z - p.z);
    if (this.d < ARRIVE) {
      this.hud?.flash(`${t.name} · press ${K('interact')} ${t.at === 'board' ? 'at the race board' : 'at the start'} to race`, 'gold', 3500);
      this.clear();
      return;
    }
    if (this.t > MAX_T || this.d > Math.max(this.d0 * 1.5, this.d0 + 80)) { this.clear(); return; }
    // the beacon: a slow pulse; the flag badge keeps a readable size at any distance and hides close up
    const k = 0.5 + 0.5 * Math.sin(this.t * 2.4);
    if (this.pillarMat) this.pillarMat.opacity = 0.35 + 0.2 * k;
    if (this.badge) {
      const s = Math.min(40, Math.max(2.4, this.d * 0.045));
      this.badge.scale.set(s, s, 1);
      this.badge.position.y = this.baseY + 7 + s * 0.6 + Math.sin(this.t * 1.6) * 0.4;
      this.badge.visible = this.d > 14;
    }
  }

  /** The HUD arrow's target ({ x, z, label }), or null. */
  waypoint() { const t = this.target; return t ? { x: t.x, z: t.z, label: `Race · ${t.name}` } : null; }

  /** The objective line while guided, or ''. */
  hudLine() {
    const t = this.target;
    if (!t) return '';
    if (this.d < t.r + 4) return `Race: ${t.name} · press ${K('interact')} ${t.at === 'board' ? 'at the race board' : 'at the start'}`;
    return `Race: ${t.name} · follow the arrow · ${Math.round(this.d)} m`;
  }

  /** Trail map (its jobs layer): the guided race and the race boards (bus races, the village RACING stand). */
  mapMarkers() {
    const out = [];
    try {
      for (const e of this.busRaces?.list || []) if (e.board) out.push({ x: e.board.x, z: e.board.z, kind: 'board', label: `Race board · ${e.name}`, what: `Free race · press ${K('interact')} at the board` });
      const s = this.stand?.()?.spot;
      if (s) out.push({ x: s.x, z: s.z, kind: 'board', label: 'Racing stand', what: 'Race just for fun' });
    } catch { /* none */ }
    const t = this.target;
    if (t) out.push({ x: t.x, z: t.z, kind: 'target', label: `Race · ${t.name}`, what: 'Your race · follow the arrow' });
    return out;
  }

  // ---------------------------------------------------------------- the world-space markers
  build() {
    const g = new THREE.Group();
    g.name = 'race-guide';
    const tex = gradTex();
    this.pillarMat = new THREE.MeshBasicMaterial({ map: tex, color: 0xff3b2f, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
    this.coreMat = new THREE.MeshBasicMaterial({ map: tex, color: 0xffffff, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
    const H = 110;
    const outer = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, H, 20, 1, true).translate(0, H / 2, 0), this.pillarMat);
    const core = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, H, 10, 1, true).translate(0, H / 2, 0), this.coreMat);
    for (const m of [outer, core]) { m.frustumCulled = false; m.renderOrder = 5; g.add(m); }
    this.pillar = new THREE.Group();
    this.pillar.add(outer, core);
    g.add(this.pillar);
    this.badgeMat = new THREE.SpriteMaterial({ map: flagTex('#d8231a'), transparent: true, depthTest: false, depthWrite: false, fog: false });
    this.badge = new THREE.Sprite(this.badgeMat);
    this.badge.renderOrder = 10;
    g.add(this.badge);
    // the pennant poles: one shared pole and one pennant (pointing local +x)
    this.poleGeo = new THREE.CylinderGeometry(0.04, 0.04, 1.8, 6).translate(0, 0.9, 0);
    this.poleMat = new THREE.MeshBasicMaterial({ color: 0xeeeeee });
    this.penGeo = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 1.78, 0, 0, 1.3, 0, 0.62, 1.54, 0], 3));
    this.penMat = new THREE.MeshBasicMaterial({ color: 0xff5a1f, side: THREE.DoubleSide });
    this.scene.add(g);
    return g;
  }

  show(from) {
    const t = this.target;
    if (!t) return;
    try {
      this.group ||= this.build();
      const g = this.group;
      g.visible = true;
      const col = new THREE.Color(t.color && t.color !== '#141414' ? t.color : '#ff3b2f');
      this.pillarMat.color.copy(col);
      if (this.badgeMat.map) this.badgeMat.map.dispose();
      this.badgeMat.map = flagTex(t.color || '#d8231a');
      this.badgeMat.needsUpdate = true;
      this.baseY = Number.isFinite(t.y) ? t.y : groundY(t.x, t.z);
      this.pillar.position.set(t.x, this.baseY - 1, t.z);
      this.badge.position.set(t.x, this.baseY + 9, t.z);
      // the poles: along the straight line from where you got off, clear of the platform and of the target
      const dx = t.x - from.x, dz = t.z - from.z, L = Math.hypot(dx, dz);
      if (L < 40) return;
      const ux = dx / L, uz = dz / L, yaw = Math.atan2(-uz, ux);
      const n = Math.min(MAX_POLES, Math.floor((L - 30) / POLE_STEP));
      const step = (L - 30) / Math.max(1, n);
      for (let i = 1; i <= n; i++) {
        const s = 15 + i * step - step / 2, x = from.x + ux * s, z = from.z + uz * s;
        const m = new THREE.Group();
        m.add(new THREE.Mesh(this.poleGeo, this.poleMat), new THREE.Mesh(this.penGeo, this.penMat));
        m.position.set(x, groundY(x, z) - 0.05, z);
        m.rotation.y = yaw;
        g.add(m);
        this.poles.push(m);
      }
    } catch (e) { console.warn('Race guide markers', e); }
  }
}
