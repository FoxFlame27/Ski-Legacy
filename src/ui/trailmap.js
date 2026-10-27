// Trail map (M): the resort drawn as a piste map in the house style (white paper, blue italic condensed type).
// Everything comes from the live layout (world/layout.js), so new lifts, pistes, huts and stops show up by
// themselves: pistes coloured by grade with their numbers, lifts with their names, mountain huts, ski-bus
// stops, Legacy Park, race starts, the heli-ski pad and drop zones, job boards, the secrets you have found,
// and you (position + heading). The relief underneath is shaded from the terrain itself (world.height /
// world.forest) in tiles at three detail levels, computed a few per frame while the map is open (coarse ones
// first) and kept for the session. Labels are placed last, by priority, where they don't collide.
//
//   const map = new TrailMap({ player, markers, locationName, onClose })
//   map.toggle()  -> true when it opened (the map runs its own frame loop while open)
// A railway shows up too once something lists it in layout.railways: [{ name, pts: [[x, z]...] or [{x, z}...],
// stations?: [{ name, x, z }] }].
// Controls while open: drag = move, wheel / + - = zoom, R = back to you, M / Esc / click outside = close,
// click a place (lift station, hut, stop, race, summit...) or anywhere on the map = mark it: `map.target` = { x, z, label } (main.js
// points the compass there until you arrive; clicking it again clears the mark).
import { world, MAIN_SUMMIT } from '../world/world.js';
import { layout, VILLAGE_BUILDINGS } from '../world/layout.js';
import { PISTE_COLORS } from '../world/resortdressing.js';
import { freeCourses } from '../modes/parkour/freeworld.js'; // the World Racing courses on the mountains
import { brushSVG, brushClip, esc } from './menu.js';

// relief levels: tile size (m) at 64 px per tile, shown from zoom `from` (CSS px per m), contour interval (m)
const LEVELS = [
  { tile: 2048, from: 0, contour: 250 },
  { tile: 512, from: 0.1, contour: 50 },
  { tile: 128, from: 0.42, contour: 25 },
];
const TPX = 64;
const BUDGET_MS = 7;              // relief work per frame while open
const MIN_S = 0.06, MAX_S = 1.6;  // zoom range (CSS px per m)
const FONT = '"Barlow Condensed", "Arial Narrow", Arial, sans-serif';
const UI = '"Inter Variable", -apple-system, "Helvetica Neue", Arial, sans-serif';
const BLUE = '#1546c8', NAVY = '#15214a', RED = '#e2231a', PARK = '#ff7a1a', GOLD = '#e7a500';
const GRADES = ['Easy', 'Intermediate', 'Difficult', 'Expert'];

export { LEVELS, TPX, FONT, UI, BLUE, NAVY, RED };
const tiles = new Map(); // "level:tx,tz" -> { canvas, born, used }  (the terrain never changes: kept for the session)
const MAX_TILES = 2400;  // (~40 MB at most; the least recently drawn go first)

// ------------------------------------------------------------------ relief tiles
// Soft hillshade lit from the north-west, snow white to pale blue, rock grey-blue on the steep faces, forest a
// light blue-green, faint contour lines (stronger every fifth). A 1 px border ring is shared with the
// neighbours, so the smoothed tiles meet without seams.
function buildTile(li, tx, tz) {
  const L = LEVELS[li], STEP = L.tile / TPX, N = TPX + 2, x0 = tx * L.tile - STEP, z0 = tz * L.tile - STEP;
  const M = N + 2, H = new Float32Array(M * M); // + one more ring for the gradients
  for (let j = 0; j < M; j++) for (let i = 0; i < M; i++) H[j * M + i] = world.height(x0 + (i - 0.5) * STEP, z0 + (j - 0.5) * STEP);
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d');
  const img = g.createImageData(N, N), d = img.data;
  const Lx = -0.55, Ly = 0.62, Lz = -0.56;
  const ci = (h) => Math.floor(h / L.contour), cj = (h) => Math.floor(h / (L.contour * 5));
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = (j + 1) * M + (i + 1), h = H[k];
    const gx = (H[k + 1] - H[k - 1]) / (2 * STEP), gz = (H[k + M] - H[k - M]) / (2 * STEP);
    const slope = Math.hypot(gx, gz);
    const nx = -gx * 1.5, nz = -gz * 1.5, nl = Math.hypot(nx, 1, nz);
    const t = Math.min(1, Math.max(0, ((nx * Lx + Ly + nz * Lz) / nl / Ly - 0.3) / 0.85));
    let r = 200 + 51 * t, gg = 212 + 40 * t, b = 236 + 19 * t;
    const rock = Math.min(1, Math.max(0, (slope - 0.85) / 0.35));
    if (rock > 0) { const rt = 0.8 + 0.2 * t; r += (170 * rt - r) * rock * 0.85; gg += (182 * rt - gg) * rock * 0.85; b += (206 * rt - b) * rock * 0.85; }
    const x = x0 + (i + 0.5) * STEP, z = z0 + (j + 0.5) * STEP;
    const f = world.forest(x, z, h, slope);
    if (f > 0.12) { const ft = Math.min(1, (f - 0.12) / 0.55) * 0.5, fl = 0.8 + 0.2 * t; r += (150 * fl - r) * ft; gg += (176 * fl - gg) * ft; b += (206 * fl - b) * ft; }
    if (ci(H[k + 1]) !== ci(h) || ci(H[k + M]) !== ci(h)) {
      const m = cj(H[k + 1]) !== cj(h) || cj(H[k + M]) !== cj(h) ? 0.87 : 0.94;
      r *= m; gg *= m; b *= m;
    }
    const o = (j * N + i) * 4;
    d[o] = r; d[o + 1] = gg; d[o + 2] = b; d[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return { canvas: c, born: performance.now() };
}

// ------------------------------------------------------------------ the map
export class TrailMap {
  /**
   * @param {object} o
   * @param {{pos: {x, z}, heading: number}} o.player
   * @param {() => {jobs?: Array, heli?: Array, secrets?: Array}} [o.markers]  map markers of the other systems
   *        ({ x, z, kind, label }; secrets: the found ones only)
   * @param {() => string} [o.locationName]
   * @param {() => void} [o.onClose]  e.g. lock the pointer again
   */
  constructor({ player, markers, locationName, onClose, root = null } = {}) {
    Object.assign(this, { player, markers, locationName, onClose });
    this.root = root || document.getElementById('map'); // (ui/travel.js draws its route maps in its own root)
    this.view = { x: 0, z: 0, s: 0.2 };
    this.W = 0; this.H = 0; this.dpr = 1;
    this.drag = null;
    this.raf = 0;
    this.build();
  }

  get isOpen() { return !this.root.hidden; }

  toggle() {
    if (this.isOpen) { this.close(); return false; }
    this.open();
    return true;
  }

  open() {
    const p = this.player.pos, v = this.view;
    // back to you, unless you were just looking at somewhere close by
    if (!this.opened || Math.hypot(v.x - p.x, v.z - p.z) > 400) { v.x = p.x; v.z = p.z; }
    this.opened = true;
    this.root.hidden = false;
    const where = this.locationName?.() || '';
    this.$where.innerHTML = where ? `You are here · <b>${esc(where)}</b>` : 'Legacy Valley';
    this.resize();
    cancelAnimationFrame(this.raf);
    const loop = () => {
      if (!this.isOpen) return;
      this.buildTiles();
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  close() {
    if (!this.isOpen) return;
    this.root.hidden = true;
    cancelAnimationFrame(this.raf);
    this.drag = null;
    this.onClose?.();
  }

  // ---------------------------------------------------------------- DOM
  build() {
    const r = this.root;
    r.className = 'trailmap';
    const sw = (c, label) => `<div class="tm-row"><i class="tm-sw" style="--c:${c}"></i><span>${label}</span></div>`;
    const sym = (cls, label) => `<div class="tm-row"><i class="tm-sym ${cls}"></i><span>${label}</span></div>`;
    r.innerHTML = `
      <div class="tm-head">
        <div class="menu-title" style="width:calc(var(--u) * 290)">${brushSVG(77, 320, 100)}<span>TRAIL MAP</span></div>
        <div class="menu-sub tm-where"></div>
      </div>
      <div class="tm-body">
        <div class="tm-map paper" style="--clip:${brushClip(171, 3, 4)}">
          <canvas class="tm-canvas"></canvas>
          <div class="tm-scale"><i></i><span></span></div>
        </div>
        <div class="tm-legend menu-panel" style="--clip:${brushClip(172, 5, 4)}">
          <div class="mp-head">PISTES</div>
          ${GRADES.map((n, i) => sw(PISTE_COLORS[i], n)).join('')}
          <div class="mp-head">LIFTS</div>
          ${sym('gondola', 'Gondola')}${sym('chair', 'Chairlift')}
          <div class="mp-head">ON THE MAP</div>
          ${sym('hut', 'Mountain hut')}${sym('bus', 'Ski bus')}${sym('park', 'Terrain park')}${sym('race', 'Race start')}
          ${sym('heli', 'Heli-ski')}${sym('jobs', 'Job board')}${sym('secret', 'Secret found')}
        </div>
      </div>
      <div class="tm-hints">
        <span class="hint"><i class="kc">M</i><em>Close</em></span>
        <span class="hint"><i class="kc kc-word">DRAG</i><em>Move</em></span>
        <span class="hint"><i class="kc kc-word">SCROLL</i><em>Zoom</em></span>
        <span class="hint"><i class="kc kc-word">CLICK</i><em>Mark a place</em></span>
        <span class="hint"><i class="kc">R</i><em>Back to you</em></span>
      </div>`;
    this.canvas = r.querySelector('.tm-canvas');
    this.g = this.canvas.getContext('2d');
    this.$where = r.querySelector('.tm-where');
    this.$scale = r.querySelector('.tm-scale');
    // clicks inside the panels never reach main.js's "click outside closes the map"
    for (const el of r.querySelectorAll('.tm-map, .tm-legend, .tm-head, .tm-hints')) el.addEventListener('click', (e) => e.stopPropagation());
    const cv = this.canvas;
    cv.addEventListener('pointerdown', (e) => { this.drag = { x: e.clientX, y: e.clientY, vx: this.view.x, vz: this.view.z, moved: 0 }; cv.setPointerCapture(e.pointerId); cv.classList.add('grab'); });
    cv.addEventListener('pointermove', (e) => {
      if (!this.drag) { this.hover(e); return; }
      this.drag.moved = Math.max(this.drag.moved, Math.hypot(e.clientX - this.drag.x, e.clientY - this.drag.y));
      this.view.x = this.drag.vx - (e.clientX - this.drag.x) / this.view.s;
      this.view.z = this.drag.vz - (e.clientY - this.drag.y) / this.view.s;
    });
    const up = () => { this.drag = null; cv.classList.remove('grab'); };
    cv.addEventListener('pointerup', (e) => { if (this.drag && this.drag.moved < 5) this.pick(e); up(); });
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('wheel', (e) => {
      e.preventDefault(); e.stopPropagation();
      const rc = cv.getBoundingClientRect();
      this.zoomAt(e.clientX - rc.left, e.clientY - rc.top, Math.pow(1.0018, -e.deltaY));
    }, { passive: false });
    cv.addEventListener('dblclick', (e) => { const rc = cv.getBoundingClientRect(); this.zoomAt(e.clientX - rc.left, e.clientY - rc.top, 1.8); });
    // keys while open (capture: the game's input never sees them, so M doesn't reopen the map)
    const KEYS = new Set(['KeyM', 'Escape', 'KeyR', 'Equal', 'Minus', 'NumpadAdd', 'NumpadSubtract', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);
    addEventListener('keydown', (e) => {
      if (!this.isOpen || !KEYS.has(e.code)) return;
      const k = e.code;
      e.preventDefault(); e.stopImmediatePropagation();
      if (k === 'KeyM' || k === 'Escape') this.close();
      else if (k === 'KeyR') { this.view.x = this.player.pos.x; this.view.z = this.player.pos.z; }
      else if (k === 'Equal' || k === 'NumpadAdd') this.zoomAt(this.W / 2, this.H / 2, 1.35);
      else if (k === 'Minus' || k === 'NumpadSubtract') this.zoomAt(this.W / 2, this.H / 2, 1 / 1.35);
      else {
        const d = 140 / this.view.s;
        if (k === 'ArrowLeft') this.view.x -= d;
        if (k === 'ArrowRight') this.view.x += d;
        if (k === 'ArrowUp') this.view.z -= d;
        if (k === 'ArrowDown') this.view.z += d;
      }
    }, true);
    addEventListener('resize', () => { if (this.isOpen) this.resize(); });
  }

  resize() {
    const rc = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(2, devicePixelRatio || 1);
    this.W = Math.max(10, rc.width); this.H = Math.max(10, rc.height);
    this.canvas.width = Math.round(this.W * this.dpr);
    this.canvas.height = Math.round(this.H * this.dpr);
  }

  // ---------------------------------------------------------------- marking a place
  spot(x, y, r, wx, wz, label) { if (label) this.spots.push({ x, y, r, wx, wz, label }); }
  spotAt(e) {
    const rc = this.canvas.getBoundingClientRect(), px = e.clientX - rc.left, py = e.clientY - rc.top;
    let best = null, bd = 1e9;
    for (const s of this.spots || []) { const d = Math.hypot(s.x - px, s.y - py) - s.r; if (d < 10 && d < bd) { bd = d; best = s; } }
    return best;
  }
  hover(e) { this.canvas.classList.toggle('pick', !!this.spotAt(e)); }
  pick(e) {
    const s = this.spotAt(e), t = this.target;
    if (s) { this.target = t && Math.hypot(t.x - s.wx, t.z - s.wz) < 1 ? null : { x: s.wx, z: s.wz, label: s.label }; return; }
    // anywhere else: drop a pin right where you clicked (click the pin again to clear it)
    const rc = this.canvas.getBoundingClientRect(), v = this.view;
    const wx = v.x + (e.clientX - rc.left - this.W / 2) / v.s, wz = v.z + (e.clientY - rc.top - this.H / 2) / v.s;
    if (t && Math.hypot(t.x - wx, t.z - wz) * v.s < 14) { this.target = null; return; }
    this.target = { x: wx, z: wz, label: 'Marked spot' };
  }

  zoomAt(px, py, k) {
    const v = this.view;
    const wx = v.x + (px - this.W / 2) / v.s, wz = v.z + (py - this.H / 2) / v.s; // stays under the cursor
    v.s = Math.min(MAX_S, Math.max(MIN_S, v.s * k));
    v.x = wx - (px - this.W / 2) / v.s;
    v.z = wz - (py - this.H / 2) / v.s;
  }

  // ---------------------------------------------------------------- relief
  range(li) {
    const v = this.view, T = LEVELS[li].tile, hw = this.W / 2 / v.s, hh = this.H / 2 / v.s;
    return { tx0: Math.floor((v.x - hw) / T), tx1: Math.floor((v.x + hw) / T), tz0: Math.floor((v.z - hh) / T), tz1: Math.floor((v.z + hh) / T) };
  }

  // the coarse level everywhere in view first, then the level the zoom wants, nearest the centre first
  buildTiles(budget = BUDGET_MS) {
    const t0 = performance.now(), v = this.view;
    const want = LEVELS.reduce((a, L, i) => (v.s >= L.from ? i : a), 0);
    for (const li of want ? [0, want] : [0]) {
      const { tx0, tx1, tz0, tz1 } = this.range(li), T = LEVELS[li].tile, todo = [];
      for (let tz = tz0; tz <= tz1; tz++) for (let tx = tx0; tx <= tx1; tx++) {
        if (!tiles.has(li + ':' + tx + ',' + tz)) todo.push([tx, tz, Math.hypot((tx + 0.5) * T - v.x, (tz + 0.5) * T - v.z)]);
      }
      todo.sort((a, b) => a[2] - b[2]);
      for (const [tx, tz] of todo) {
        tiles.set(li + ':' + tx + ',' + tz, buildTile(li, tx, tz));
        if (tiles.size > MAX_TILES) {
          const old = [...tiles.entries()].sort((a, b) => (a[1].used || 0) - (b[1].used || 0)).slice(0, 400);
          for (const [k] of old) tiles.delete(k);
        }
        if (performance.now() - t0 > budget) return;
      }
    }
  }

  // ---------------------------------------------------------------- drawing
  draw() {
    const g = this.g, v = this.view, W = this.W, H = this.H, now = performance.now();
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.fillStyle = '#eef2fa';
    g.fillRect(0, 0, W, H);
    this.X = (x) => (x - v.x) * v.s + W / 2;
    this.Z = (z) => (z - v.z) * v.s + H / 2;
    this.drawRelief(now);
    // geometry first (symbols reserve their space), then the labels by priority
    this.boxes = [];
    this.queue = [];
    this.spots = [];
    this.drawVillage();
    this.drawPark();
    this.drawPistes();
    this.drawRaces();
    this.drawRail();
    this.drawLifts();
    this.drawRailway();
    this.drawPlaces();
    this.drawTarget(now);
    this.drawPlayer(now);
    this.placeLabels();
    this.drawScale();
  }

  // relief: each level drawn over the coarser one (tiles fade in as they arrive)
  drawRelief(now) {
    const g = this.g, v = this.view;
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    LEVELS.forEach((L, li) => {
      if (li && v.s < L.from) return;
      const { tx0, tx1, tz0, tz1 } = this.range(li), STEP = L.tile / TPX, sz = (L.tile + 2 * STEP) * v.s;
      for (let tz = tz0; tz <= tz1; tz++) for (let tx = tx0; tx <= tx1; tx++) {
        const t = tiles.get(li + ':' + tx + ',' + tz);
        if (!t) continue;
        t.used = now;
        g.globalAlpha = Math.min(1, (now - t.born) / 280);
        g.drawImage(t.canvas, this.X(tx * L.tile - STEP), this.Z(tz * L.tile - STEP), sz, sz);
      }
    });
    g.globalAlpha = 1;
  }

  reserve(x, y, r) { this.boxes.push([x - r, y - r, x + r, y + r]); }
  inView(x, y, m = 40) { return x > -m && y > -m && x < this.W + m && y < this.H + m; }

  /** Queue a label: tried at each candidate [dx, dy, align] in turn, drawn at the first free one. */
  label(text, x, y, o = {}) { this.queue.push({ text, x, y, prio: o.prio ?? 5, ...o }); }

  placeLabels() {
    const g = this.g, hit = (b) => this.boxes.some((q) => q[0] < b[2] && q[2] > b[0] && q[1] < b[3] && q[3] > b[1]);
    this.queue.sort((a, b) => a.prio - b.prio);
    for (const L of this.queue) {
      const size = L.size ?? 14, weight = L.weight ?? 700;
      g.font = `italic ${weight} ${size}px ${FONT}`;
      const w = g.measureText(L.text).width, h = size * 0.9;
      const cands = L.cands || [[0, 0, L.align || 'left']];
      let pick = null;
      for (const [dx, dy, align, ang = L.angle || 0] of cands) {
        const x = L.x + dx, y = L.y + dy;
        let box;
        if (ang) {
          const c = Math.abs(Math.cos(ang)), s = Math.abs(Math.sin(ang)), bw = w * c + h * s, bh = w * s + h * c;
          box = [x - bw / 2, y - bh / 2, x + bw / 2, y + bh / 2];
        } else {
          const x0 = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
          box = [x0 - 2, y - h / 2 - 2, x0 + w + 2, y + h / 2 + 2];
        }
        const inside = box[0] > 4 && box[1] > 4 && box[2] < this.W - 4 && box[3] < this.H - 4;
        if (!inside) continue;
        if (!hit(box)) { pick = { x, y, align, ang, box }; break; }
        if (L.force && !pick) L.fallback ??= { x, y, align, ang, box };
      }
      pick ??= L.fallback;
      if (!pick) continue;
      this.boxes.push(pick.box);
      g.save();
      g.translate(pick.x, pick.y);
      if (pick.ang) g.rotate(pick.ang);
      g.textAlign = pick.ang ? 'center' : pick.align;
      g.textBaseline = 'middle';
      g.lineJoin = 'round';
      g.strokeStyle = 'rgba(255,255,255,0.94)';
      g.lineWidth = Math.max(3, size * 0.3);
      g.strokeText(L.text, 0, 0);
      g.fillStyle = L.color || NAVY;
      g.fillText(L.text, 0, 0);
      g.restore();
    }
  }

  path(pts) {
    const g = this.g;
    g.beginPath();
    let last = null;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], x = this.X(p[0] ?? p.x), y = this.Z(p[1] ?? p.z);
      if (last && i < pts.length - 1 && Math.abs(x - last[0]) + Math.abs(y - last[1]) < 1.5) continue; // (dense polylines)
      if (!last) g.moveTo(x, y); else g.lineTo(x, y);
      last = [x, y];
    }
  }

  // label candidates around a symbol of radius r: right, left, above, below
  around(r, gap = 5) { return [[r + gap, 0, 'left'], [-r - gap, 0, 'right'], [0, -r - gap - 7, 'center'], [0, r + gap + 7, 'center']]; }

  drawVillage() {
    const g = this.g, s = this.view.s, vx = this.X(0), vy = this.Z(0);
    if (!this.inView(vx, vy, 300)) return;
    g.fillStyle = '#8796bb';
    g.strokeStyle = 'rgba(255,255,255,0.9)';
    g.lineWidth = 1;
    const b = Math.max(2.5, 16 * s);
    for (const [x, z] of VILLAGE_BUILDINGS) {
      const px = this.X(x), py = this.Z(z);
      g.beginPath(); g.rect(px - b / 2, py - b / 2, b, b); g.fill(); g.stroke();
    }
    const off = Math.max(24, 150 * s);
    this.label('LEGACY VILLAGE', vx, vy, { size: 21, color: BLUE, prio: 0, force: true,
      cands: [[0, off, 'center'], [0, -off, 'center'], [-off * 0.8, off * 0.7, 'right'], [off * 0.8, off * 0.7, 'left'], [0, off * 1.7, 'center'], [-off, -off * 0.6, 'right']] });
  }

  drawPark() {
    const p = layout.park;
    if (!p?.line) return;
    const g = this.g, s = this.view.s;
    g.save();
    g.lineCap = 'round'; g.lineJoin = 'round';
    this.path(p.line);
    g.strokeStyle = 'rgba(255,122,26,0.2)';
    g.lineWidth = Math.max(6, 2 * (p.halfWidth || 17) * s);
    g.stroke();
    g.fillStyle = PARK; g.strokeStyle = '#fff'; g.lineWidth = 1.2;
    const d = Math.max(2.5, Math.min(5, 18 * s));
    for (const f of p.features || []) {
      const x = this.X(f.x), y = this.Z(f.z);
      if (!this.inView(x, y)) continue;
      g.beginPath(); g.moveTo(x, y - d); g.lineTo(x + d, y); g.lineTo(x, y + d); g.lineTo(x - d, y); g.closePath(); g.fill(); g.stroke();
    }
    g.restore();
    const m = p.line[Math.floor(p.line.length * 0.45)];
    if (m) {
      const x = this.X(m[0]), y = this.Z(m[1]), r = Math.max(8, (p.halfWidth || 17) * s);
      this.label((p.name || 'Legacy Park').toUpperCase(), x, y, { size: 15, color: '#c75400', prio: 4, cands: this.around(r, 6) });
      const d0 = p.drop || { x: p.line[0][0], z: p.line[0][1] };
      this.spot(this.X(d0.x), this.Z(d0.z), 10, d0.x, d0.z, p.name || 'Legacy Park');
    }
  }

  drawPistes() {
    const g = this.g, s = this.view.s;
    const w = Math.min(7, Math.max(2.6, s * 13));
    const pistes = [...layout.pistes].sort((a, b) => a.diff - b.diff);
    g.save();
    g.lineCap = 'round'; g.lineJoin = 'round';
    for (const pass of [0, 1]) {
      for (const p of pistes) {
        this.path(p.pts);
        g.strokeStyle = pass ? PISTE_COLORS[p.diff] : 'rgba(255,255,255,0.95)';
        g.lineWidth = pass ? w : w + 3.5;
        g.setLineDash(p.lane && pass ? [w * 2.2, w * 1.2] : []);
        g.stroke();
      }
    }
    g.setLineDash([]);
    g.restore();
    // number badges (and the name when zoomed in)
    for (const p of pistes) {
      const q = p.pts[Math.floor(p.pts.length * 0.38)];
      if (!q) continue;
      const x = this.X(q[0] ?? q.x), y = this.Z(q[1] ?? q.z);
      if (!this.inView(x, y)) continue;
      const num = p.number ?? layout.pistes.indexOf(p) + 1, r = 10;
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2);
      g.fillStyle = PISTE_COLORS[p.diff]; g.fill();
      g.lineWidth = 2; g.strokeStyle = '#fff'; g.stroke();
      g.fillStyle = '#fff'; g.font = `italic 700 ${num > 9 ? 12.5 : 14}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(String(num), x, y + 0.5);
      this.reserve(x, y, r + 1);
      if (s > 0.28) this.label(p.name, x, y, { size: 14, weight: 700, color: p.diff === 3 ? '#161616' : PISTE_COLORS[p.diff], prio: 6, cands: this.around(r) });
    }
  }

  // The World Racing courses on the mountains around the resort (free ride races them where they stand): the race
  // line in its difficulty colour and a flag at the start house (click it to mark it as your target).
  drawRaces() {
    const g = this.g, s = this.view.s;
    let list = [];
    try { list = freeCourses(); } catch (e) { list = []; }
    for (const e of list) {
      const col = e.D.color === '#141414' ? '#161616' : e.D.color;
      g.save();
      g.lineCap = 'round'; g.lineJoin = 'round';
      this.path(e.pts);
      g.strokeStyle = '#fff'; g.lineWidth = s < 0.1 ? 3 : 5; g.stroke();
      g.strokeStyle = col; g.lineWidth = s < 0.1 ? 1.6 : 2.6; g.setLineDash([7, 5]); g.stroke();
      g.restore();
      const x = this.X(e.start.x), y = this.Z(e.start.z);
      if (!this.inView(x, y)) continue;
      g.strokeStyle = NAVY; g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x, y - 13); g.stroke();
      g.fillStyle = col;
      g.beginPath(); g.moveTo(x, y - 13); g.lineTo(x + 9, y - 10); g.lineTo(x, y - 7); g.closePath(); g.fill();
      g.strokeStyle = '#fff'; g.lineWidth = 1; g.stroke();
      this.boxes.push([x - 2, y - 14, x + 10, y + 1]);
      this.spot(x + 4, y - 7, 8, e.start.x, e.start.z, e.name);
      if (s > 0.06) this.label(e.name, x + 12, y - 9, { size: 13, weight: 700, color: NAVY, prio: 9 });
    }
  }

  // railways (layout.railways, when there are any): the classic black-and-white map line, stations as bars
  drawRail() {
    const g = this.g;
    for (const r of layout.railways || []) {
      const pts = r.pts || r.line || r.path;
      if (!pts?.length) continue;
      g.save();
      g.lineCap = 'butt'; g.lineJoin = 'round';
      this.path(pts);
      g.strokeStyle = NAVY; g.lineWidth = 5.5; g.stroke();
      g.strokeStyle = '#fff'; g.lineWidth = 3; g.setLineDash([9, 9]); g.stroke();
      g.restore();
      for (const st of r.stations || []) {
        const x = this.X(st.x), y = this.Z(st.z);
        if (!this.inView(x, y)) continue;
        g.fillStyle = '#fff'; g.strokeStyle = NAVY; g.lineWidth = 2;
        g.beginPath(); g.roundRect(x - 7, y - 4.5, 14, 9, 2.5); g.fill(); g.stroke();
        this.reserve(x, y, 8);
        if (st.name) { this.spot(x, y, 8, st.x, st.z, st.name); this.label(st.name, x, y, { size: 14, color: NAVY, prio: 3, cands: this.around(8) }); }
      }
    }
  }

  drawLifts() {
    const g = this.g, s = this.view.s;
    for (const l of layout.lifts) {
      const ax = this.X(l.bottom.x), ay = this.Z(l.bottom.z), bx = this.X(l.top.x), by = this.Z(l.top.z);
      if (Math.max(ax, bx) < -60 || Math.min(ax, bx) > this.W + 60 || Math.max(ay, by) < -60 || Math.min(ay, by) > this.H + 60) continue;
      const gondola = l.type === 'gondola';
      const len = Math.hypot(bx - ax, by - ay), ux = (bx - ax) / (len || 1), uy = (by - ay) / (len || 1);
      g.save();
      g.lineCap = 'round';
      g.strokeStyle = 'rgba(255,255,255,0.95)'; g.lineWidth = gondola ? 6 : 5;
      g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();
      g.strokeStyle = NAVY; g.lineWidth = gondola ? 2.6 : 1.8;
      g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();
      if (s >= 0.1) {
        if (!gondola) {
          g.lineWidth = 1.4; // chairlift: short ticks along the line
          for (let d = 10; d < len - 6; d += 13) {
            const cx = ax + ux * d, cy = ay + uy * d;
            g.beginPath(); g.moveTo(cx - uy * 3.5, cy + ux * 3.5); g.lineTo(cx + uy * 3.5, cy - ux * 3.5); g.stroke();
          }
        } else {
          g.fillStyle = NAVY; // gondola: cabins as dots
          for (let d = 16; d < len - 10; d += 26) { g.beginPath(); g.arc(ax + ux * d, ay + uy * d, 2.1, 0, Math.PI * 2); g.fill(); }
        }
      }
      const st = (x, y, q) => { g.fillStyle = NAVY; g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.beginPath(); g.rect(x - q, y - q, 2 * q, 2 * q); g.fill(); g.stroke(); this.reserve(x, y, q + 1); };
      st(ax, ay, gondola ? 4.5 : 3.5); st(bx, by, gondola ? 4.5 : 3.5);
      this.spot(ax, ay, 6, l.bottom.x, l.bottom.z, `${l.name} · valley station`);
      this.spot(bx, by, 6, l.top.x, l.top.z, `${l.name} · top station`);
      if (l.mid) st(this.X(l.mid.x), this.Z(l.mid.z), 3.5);
      g.restore();
      // the name along the line, upright, on either side, at a few points along it
      if (len > 80 && s >= 0.1) {
        let ang = Math.atan2(by - ay, bx - ax);
        if (ang > Math.PI / 2) ang -= Math.PI; else if (ang < -Math.PI / 2) ang += Math.PI;
        const nx = -Math.sin(ang), ny = Math.cos(ang), off = 11, cands = [];
        for (const t of l.mid ? [0.28, 0.72, 0.5] : [0.5, 0.32, 0.68]) for (const sd of [-1, 1]) cands.push([(bx - ax) * t + nx * off * sd, (by - ay) * t + ny * off * sd, 'center', ang]);
        this.label(l.name, ax, ay, { size: gondola ? 15 : 14, color: NAVY, prio: gondola ? 2 : 3, cands });
      }
    }
  }

  // the Wolkenspitzbahn (layout.railway): the railway symbol (a dark line with white ties), thinner and dashed
  // through the tunnels; its stations as red squares with their names
  drawRailway() {
    const R = layout.railway;
    if (!R) return;
    const g = this.g, s = this.view.s, P = R.pts;
    g.save();
    g.lineCap = 'round'; g.lineJoin = 'round';
    const run = (tunnel, draw) => {
      let open = false;
      for (let i = 0; i < P.length; i++) {
        const on = !!P[i][2] === tunnel || (i > 0 && !!P[i - 1][2] === tunnel);
        const x = this.X(P[i][0]), y = this.Z(P[i][1]);
        if (on && !open) { g.beginPath(); g.moveTo(x, y); open = true; } else if (on) g.lineTo(x, y);
        else if (open) { draw(); open = false; }
      }
      if (open) draw();
    };
    run(false, () => { g.setLineDash([]); g.strokeStyle = '#fff'; g.lineWidth = 6.5; g.stroke(); g.strokeStyle = '#1b1f27'; g.lineWidth = 4; g.stroke(); g.setLineDash([5, 7]); g.strokeStyle = '#fff'; g.lineWidth = 1.6; g.stroke(); });
    run(true, () => { g.setLineDash([4, 4]); g.strokeStyle = '#1b1f27'; g.lineWidth = 2.2; g.stroke(); });
    g.setLineDash([]);
    g.restore();
    for (const st of R.stations) {
      const x = this.X(st.x), y = this.Z(st.z);
      if (!this.inView(x, y)) continue;
      g.fillStyle = RED; g.strokeStyle = '#fff'; g.lineWidth = 1.8;
      g.beginPath(); g.rect(x - 5.5, y - 5.5, 11, 11); g.fill(); g.stroke();
      this.reserve(x, y, 7);
      if (s >= 0.07) this.label(st.name, x, y, { size: 14, color: '#8f1414', prio: 2, cands: this.around(9) });
    }
    // the line's name along its middle stretch
    const m = P[Math.floor(P.length * 0.36)];
    if (m && s >= 0.05) this.label(R.name, this.X(m[0]), this.Z(m[1]), { size: 14, color: '#1b1f27', prio: 3, cands: this.around(12) });
  }

  drawPlaces() {
    const g = this.g, s = this.view.s, X = this.X, Z = this.Z;
    // summits
    for (const p of layout.peaks) {
      const sm = p.summit || (p.id === 'legacy' ? MAIN_SUMMIT : null);
      if (!sm) continue;
      const x = X(sm.x), y = Z(sm.z);
      if (!this.inView(x, y)) continue;
      g.fillStyle = NAVY; g.strokeStyle = '#fff'; g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(x, y - 7); g.lineTo(x + 7, y + 5); g.lineTo(x - 7, y + 5); g.closePath(); g.fill(); g.stroke();
      this.reserve(x, y, 8);
      this.spot(x, y, 8, sm.x, sm.z, `${p.name} summit`);
      this.label(p.name.toUpperCase(), x, y, { size: 17, color: NAVY, prio: 1, cands: [[0, 18, 'center'], [0, -18, 'center'], [12, 0, 'left'], [-12, 0, 'right']] });
    }
    // mountain huts
    for (const h of layout.huts) {
      const x = X(h.x), y = Z(h.z);
      if (!this.inView(x, y)) continue;
      g.fillStyle = '#b8452a'; g.strokeStyle = '#fff'; g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(x, y - 8); g.lineTo(x + 7, y - 2); g.lineTo(x + 7, y + 6); g.lineTo(x - 7, y + 6); g.lineTo(x - 7, y - 2); g.closePath(); g.fill(); g.stroke();
      this.reserve(x, y, 9);
      this.spot(x, y, 9, h.x, h.z, h.name);
      if (s >= 0.09) this.label(h.name, x, y, { size: 14, color: '#8f2f17', prio: 2, cands: this.around(8) });
    }
    // ski-bus stops
    for (const b of layout.busStops) {
      const x = X(b.x), y = Z(b.z);
      if (!this.inView(x, y)) continue;
      g.fillStyle = BLUE; g.strokeStyle = '#fff'; g.lineWidth = 1.5;
      g.beginPath(); g.roundRect(x - 12, y - 7.5, 24, 15, 4); g.fill(); g.stroke();
      g.fillStyle = '#fff'; g.font = `800 8.5px ${UI}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('BUS', x, y + 0.5);
      this.boxes.push([x - 13, y - 9, x + 13, y + 9]);
      this.spot(x, y, 12, b.x, b.z, `Ski bus · ${b.name}`);
      if (s >= 0.12 && b.name !== 'Legacy Village') this.label(b.name, x, y, { size: 13, weight: 600, color: BLUE, prio: 5, cands: this.around(12) });
    }
    // other systems: heli-ski, job boards, the secrets you have found
    const mk = this.markers?.() || {};
    for (const m of mk.heli || []) {
      const x = X(m.x), y = Z(m.z);
      if (!this.inView(x, y)) continue;
      if (m.kind === 'helipad') {
        g.fillStyle = '#fff'; g.strokeStyle = RED; g.lineWidth = 2;
        g.beginPath(); g.arc(x, y, 9, 0, Math.PI * 2); g.fill(); g.stroke();
        g.fillStyle = RED; g.font = `italic 700 13px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('H', x, y + 0.5);
        this.reserve(x, y, 10);
        this.spot(x, y, 10, m.x, m.z, 'Heli-ski');
        if (s >= 0.12) this.label('Heli-ski', x, y, { size: 14, color: RED, prio: 5, cands: this.around(9) });
      } else if (m.kind === 'drop') {
        g.fillStyle = RED; g.strokeStyle = '#fff'; g.lineWidth = 1.5;
        g.beginPath(); g.moveTo(x, y - 7); g.lineTo(x + 6, y + 4); g.lineTo(x - 6, y + 4); g.closePath(); g.fill(); g.stroke();
        this.reserve(x, y, 7);
        this.label(m.label, x, y, { size: 13, weight: 600, color: RED, prio: 8, cands: this.around(7) });
      } else {
        g.fillStyle = RED; g.beginPath(); g.arc(x, y, 5, 0, Math.PI * 2); g.fill();
      }
    }
    for (const m of mk.jobs || []) {
      const x = X(m.x), y = Z(m.z);
      if (!this.inView(x, y)) continue;
      if (m.kind === 'search') {
        g.strokeStyle = GOLD; g.lineWidth = 2; g.setLineDash([5, 4]);
        g.beginPath(); g.arc(x, y, Math.max(8, (m.r || 30) * s), 0, Math.PI * 2); g.stroke(); g.setLineDash([]);
      } else if (m.kind === 'board') {
        g.fillStyle = '#7a4a22'; g.strokeStyle = '#fff'; g.lineWidth = 1.5;
        g.beginPath(); g.rect(x - 4.5, y - 4.5, 9, 9); g.fill(); g.stroke();
        this.reserve(x, y, 6);
        if (s > 0.35) this.label(m.label, x, y, { size: 13, weight: 600, color: '#6a3d17', prio: 10, cands: this.around(5) });
      } else {
        g.fillStyle = GOLD; g.strokeStyle = '#fff'; g.lineWidth = 1.5;
        g.beginPath(); g.arc(x, y, 6, 0, Math.PI * 2); g.fill(); g.stroke();
        this.reserve(x, y, 7);
        if (m.label) this.label(m.label, x, y, { size: 14, color: '#9a6a00', prio: 1, cands: this.around(6) });
      }
    }
    for (const m of mk.secrets || []) {
      const x = X(m.x), y = Z(m.z);
      if (!this.inView(x, y)) continue;
      g.fillStyle = '#ffcf5a'; g.strokeStyle = '#7a5600'; g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(x, y - 7); g.lineTo(x + 7, y); g.lineTo(x, y + 7); g.lineTo(x - 7, y); g.closePath(); g.fill(); g.stroke();
      this.reserve(x, y, 8);
      this.spot(x, y, 8, m.x, m.z, m.label);
      this.label(m.label, x, y, { size: 14, color: '#8a6200', prio: 4, cands: this.around(7) });
    }
  }

  // the place you marked: a red ring that breathes, and its name
  drawTarget(now) {
    const t = this.target;
    if (!t) return;
    const g = this.g, x = this.X(t.x), y = this.Z(t.z);
    if (!this.inView(x, y, 0)) return;
    const r = 13 + Math.sin(now / 260) * 2;
    g.save();
    g.strokeStyle = 'rgba(255,255,255,0.95)'; g.lineWidth = 6;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = RED; g.lineWidth = 3;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke();
    g.restore();
    this.reserve(x, y, r + 3);
    this.label(`MARKED · ${t.label}`, x, y, { size: 14, color: RED, prio: -1, force: true, cands: [[0, -r - 12, 'center'], [0, r + 12, 'center'], [r + 6, 0, 'left'], [-r - 6, 0, 'right']] });
  }

  drawPlayer(now) {
    const g = this.g, p = this.player, x = this.X(p.pos.x), y = this.Z(p.pos.z);
    const m = 18, ex = Math.min(this.W - m, Math.max(m, x)), ey = Math.min(this.H - m, Math.max(m, y));
    g.save();
    if (ex !== x || ey !== y) {
      // off the map: an arrow at the edge pointing to you
      g.translate(ex, ey);
      g.rotate(Math.atan2(y - ey, x - ex));
      g.fillStyle = RED; g.strokeStyle = '#fff'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(10, 0); g.lineTo(-7, -7); g.lineTo(-3, 0); g.lineTo(-7, 7); g.closePath(); g.fill(); g.stroke();
      g.restore();
      return;
    }
    const ph = (now / 1400) % 1; // a soft pulse, then the arrow (heading 0 = +z = down on the map)
    g.strokeStyle = `rgba(226,35,26,${0.5 * (1 - ph)})`; g.lineWidth = 2;
    g.beginPath(); g.arc(x, y, 8 + ph * 18, 0, Math.PI * 2); g.stroke();
    g.translate(x, y);
    g.rotate(Math.atan2(Math.cos(p.heading), Math.sin(p.heading)));
    g.fillStyle = RED; g.strokeStyle = '#fff'; g.lineWidth = 2.5; g.lineJoin = 'round';
    g.beginPath(); g.moveTo(13, 0); g.lineTo(-8, -8.5); g.lineTo(-3.5, 0); g.lineTo(-8, 8.5); g.closePath(); g.stroke(); g.fill();
    g.restore();
    this.reserve(x, y, 13);
  }

  drawScale() {
    const s = this.view.s, steps = [50, 100, 200, 250, 500, 1000, 2000, 2500, 5000];
    let m = steps[0];
    for (const v of steps) if (v * s <= 190) m = v;
    this.$scale.firstElementChild.style.width = `${Math.round(m * s)}px`;
    this.$scale.lastElementChild.textContent = m >= 1000 ? `${m / 1000} km` : `${m} m`;
  }
}
