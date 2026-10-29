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
// The races (the eight World Racing courses, freeCourses()) are drawn to be found at every zoom: the course as a
// race tape in its difficulty colour, a pin with a chequered flag at the start, a chequered finish and a card with
// name, difficulty and prize (labelled first). The Legacy Express (layout.express) is a bold violet line, dashed
// faint through its tunnels, with its stations (each joined to its race by a dotted link).
// Controls while open: drag = move, wheel / + - = zoom, R = back to you, M / Esc / click outside = close,
// click a place (lift station, hut, stop, race, summit...) or anywhere on the map = mark it: `map.target` = { x, z, label } (main.js
// points the compass there until you arrive; clicking it again clears the mark).
// The roads come live from game/bus/roads.js (busRoads.roads / lots / roundabouts / hospital / rental): every road,
// the scenic ones (Panoramastrasse, Passstrasse, Ostalstrasse, Hinterkopfstrasse, Hochalmstrasse, Autohausweg and
// whatever is added later) in amber, the valley roads in grey, the roundabouts, the car parks (P) and the road names
// along them. Their geometry is built once into world-space Path2Ds (rebuilt only when the network changes) and
// stroked under a view transform; the zoom-out limit fits the whole network, the races and the express.
import { world, MAIN_SUMMIT } from '../world/world.js';
import { layout, VILLAGE_BUILDINGS } from '../world/layout.js';
import { PISTE_COLORS } from '../world/resortdressing.js';
import { freeCourses } from '../modes/parkour/freeworld.js'; // the World Racing courses on the mountains
import { brushSVG, brushClip, esc } from './menu.js';
import { busRoads } from '../game/bus/roads.js'; // the road network (valley roads, scenic roads, roundabouts, car parks)

// relief levels: tile size (m) at 64 px per tile, shown from zoom `from` (CSS px per m), contour interval (m)
const LEVELS = [
  { tile: 2048, from: 0, contour: 250 },
  { tile: 512, from: 0.1, contour: 50 },
  { tile: 128, from: 0.42, contour: 25 },
];
const TPX = 64;
const BUDGET_MS = 7;              // relief work per frame while open
const MIN_S = 0.028, MAX_S = 1.6; // zoom range (CSS px per m; zoomed right out the whole Legacy Express ring fits)
const FONT = '"Barlow Condensed", "Arial Narrow", Arial, sans-serif';
const UI = '"Inter Variable", -apple-system, "Helvetica Neue", Arial, sans-serif';
const BLUE = '#1546c8', NAVY = '#15214a', RED = '#e2231a', PARK = '#ff7a1a', GOLD = '#e7a500';
const EXPRESS = '#6a22c9';        // the Legacy Express: violet (no piste, race, lift or railway colour is near it)
const GRADES = ['Easy', 'Intermediate', 'Difficult', 'Expert'];
const RACE_GRADES = [['Easy', '#2fbf5b'], ['Medium', '#2f7bff'], ['Hard', '#e23b3b'], ['Expert', '#161616']];

export { LEVELS, TPX, FONT, UI, BLUE, NAVY, RED, EXPRESS };
/** A race's colour on the map (its difficulty; Expert's black as ink). */
export const raceInk = (c) => (c === '#141414' ? '#161616' : c || BLUE);

/** A race badge: a pin in the race's colour with a white rim and a chequered flag, its tip on (x, y). Returns the
 *  centre of its head (y). Also used by the route picker (ui/travel.js). */
export function racePin(g, x, y, r, col) {
  const d = r * 1.75, cy = y - d, f = Math.acos(r / d);
  g.save();
  g.beginPath(); g.arc(x, cy, r, Math.PI / 2 + f, Math.PI / 2 - f); g.lineTo(x, y); g.closePath();
  g.shadowColor = 'rgba(8,20,60,0.4)'; g.shadowBlur = 5; g.shadowOffsetY = 1.5;
  g.fillStyle = col; g.fill();
  g.shadowColor = 'transparent';
  g.lineJoin = 'round'; g.lineWidth = Math.max(2, r * 0.2); g.strokeStyle = '#fff'; g.stroke();
  // the flag: a pole and a 3 x 2 chequer
  const px = x - r * 0.44, top = cy - r * 0.5, fw = r * 1.02, fh = r * 0.64, cw = fw / 3, ch = fh / 2;
  g.fillStyle = '#fff';
  g.fillRect(px - 0.7, top - 0.5, 1.5, r * 1.12);
  for (let j = 0; j < 2; j++) for (let i = 0; i < 3; i++) if ((i + j) % 2 === 0) g.fillRect(px + 0.8 + i * cw, top + j * ch, cw, ch);
  g.strokeStyle = '#fff'; g.lineWidth = 1; g.strokeRect(px + 0.8, top, fw, fh);
  g.restore();
  return cy;
}

/** The finish: a chequered square (q px) in a white frame. */
export function finishMark(g, x, y, q, col = NAVY) {
  const c = q / 3;
  g.fillStyle = '#fff'; g.fillRect(x - q / 2 - 2, y - q / 2 - 2, q + 4, q + 4);
  g.strokeStyle = col; g.lineWidth = 1.2; g.strokeRect(x - q / 2 - 2, y - q / 2 - 2, q + 4, q + 4);
  g.fillStyle = '#161616';
  for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) if ((i + j) % 2 === 0) g.fillRect(x - q / 2 + i * c, y - q / 2 + j * c, c, c);
}

/** A Legacy Express station: a white disc in a violet ring (the village's bigger, with a violet heart). */
export function expressStop(g, x, y, r, big = false) {
  g.beginPath(); g.arc(x, y, r + 1.6, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill();
  g.beginPath(); g.arc(x, y, r - 1.4, 0, Math.PI * 2); g.lineWidth = 2.8; g.strokeStyle = EXPRESS; g.stroke();
  if (big) { g.beginPath(); g.arc(x, y, r * 0.38, 0, Math.PI * 2); g.fillStyle = EXPRESS; g.fill(); }
}
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
    this.fitBounds();
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
    const sym = (cls, label, c = '') => `<div class="tm-row"><i class="tm-sym ${cls}"${c ? ` style="--c:${c}"` : ''}></i><span>${label}</span></div>`;
    // (compact: two columns where the entries are short)
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
          <div class="mp-head">RACES</div>
          <div class="tm-grid">${RACE_GRADES.map(([n, c]) => sym('pin', n, c)).join('')}</div>
          <div class="tm-grid">${sym('finish', 'Finish')}${sym('tape', 'Race line', '#2f7bff')}</div>
          <div class="mp-head">LEGACY EXPRESS</div>
          <div class="tm-grid">${sym('express', 'Line')}${sym('xtunnel', 'Tunnel')}</div>
          ${sym('xstop', 'Station · one per race')}
          <div class="mp-head">PISTES</div>
          <div class="tm-grid">${[0, 1, 2, 3].map((i) => sw(PISTE_COLORS[i], GRADES[i])).join('')}</div>
          <div class="mp-head">LIFTS</div>
          <div class="tm-grid">${sym('gondola', 'Gondola')}${sym('chair', 'Chairlift')}</div>
          <div class="mp-head">ROADS</div>
          <div class="tm-grid">${sym('road', 'Road')}${sym('scenic', 'Scenic road')}${sym('lot', 'Car park')}${sym('ring', 'Roundabout')}</div>
          <div class="mp-head">ON THE MAP</div>
          <div class="tm-grid">${sym('hut', 'Mountain hut')}${sym('bus', 'Ski bus')}${sym('park', 'Terrain park')}${sym('heli', 'Heli-ski')}
          ${sym('shop', 'Ski shop')}${sym('car', 'Car rental')}${sym('med', 'Medical centre')}${sym('chalet', 'Your chalet')}${sym('car mycar', 'Your car')}${sym('car impound', 'Impounded car')}
          ${sym('secret', 'Secret found')}${sym('jobs', 'Job board')}</div>
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
    cv.addEventListener('pointerleave', () => { this.hot = null; });
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
  // (extra: e.g. { race: id } (hovering it highlights the race), { box: [x0, y0, x1, y1] } for a card)
  spot(x, y, r, wx, wz, label, extra) { if (label) this.spots.push({ x, y, r, wx, wz, label, ...extra }); }
  spotAt(e) {
    const rc = this.canvas.getBoundingClientRect(), px = e.clientX - rc.left, py = e.clientY - rc.top;
    let best = null, bd = 1e9;
    for (const s of this.spots || []) {
      const b = s.box, d = b ? (px > b[0] && px < b[2] && py > b[1] && py < b[3] ? -9 : 1e9) : Math.hypot(s.x - px, s.y - py) - s.r;
      if (d < 10 && d < bd) { bd = d; best = s; }
    }
    return best;
  }
  hover(e) { const s = this.spotAt(e); this.hot = s; this.canvas.classList.toggle('pick', !!s); }
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
    v.s = Math.min(MAX_S, Math.max(this.minS ?? MIN_S, v.s * k));
    v.x = wx - (px - this.W / 2) / v.s;
    v.z = wz - (py - this.H / 2) / v.s;
  }

  // the zoom-out limit: the whole world on the map (the road network out to the Ostal / Hinterkopf / Hochalm, every race,
  // the express ring, the stops, the lifts), with a margin; never tighter than MIN_S
  fitBounds() {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    const add = (x, z) => { if (Number.isFinite(x) && Number.isFinite(z)) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; } };
    const rc = this.roadCache();
    if (rc) { add(rc.box[0], rc.box[1]); add(rc.box[2], rc.box[3]); }
    for (const e of this.races()) { add(e.start.x, e.start.z); add(e.finish.x, e.finish.z); }
    for (const p of layout.express?.pts || []) add(p[0], p[1]);
    for (const b of layout.busStops) add(b.x, b.z);
    for (const l of layout.lifts) { add(l.bottom.x, l.bottom.z); add(l.top.x, l.top.z); }
    if (!Number.isFinite(x0)) { this.minS = MIN_S; return; }
    const fit = Math.min(this.W / Math.max(500, x1 - x0), this.H / Math.max(500, z1 - z0)) * 0.9;
    this.minS = Math.max(0.004, Math.min(MIN_S, fit));
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
    this.drawRoads();
    this.drawVillage();
    this.drawChalets();
    this.drawPark();
    this.drawPistes();
    this.drawExpress();
    this.drawRaceLines();
    this.drawRail();
    this.drawLifts();
    this.drawRailway();
    this.drawPlaces();
    this.drawExpressStops();
    this.drawRaceMarks(now);
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

  /** Queue a label: tried at each candidate [dx, dy, align] in turn, drawn at the first free one. With `card`
   *  ({ title, sub: [[text, color]...], more?, color }) it is a card (the races'); `cands` may then be a function
   *  (w, h) => candidates (dy to the card's middle), and `onPlace(box)` is told where it went. */
  label(text, x, y, o = {}) { this.queue.push({ text, x, y, prio: o.prio ?? 5, ...o }); }

  placeLabels() {
    const g = this.g, hit = (b) => this.boxes.some((q) => q[0] < b[2] && q[2] > b[0] && q[1] < b[3] && q[3] > b[1]);
    this.queue.sort((a, b) => a.prio - b.prio);
    for (const L of this.queue) {
      const size = L.size ?? 14, weight = L.weight ?? 700;
      let w, h;
      if (L.card) ({ w, h } = this.cardSize(L.card));
      else { g.font = `italic ${weight} ${size}px ${FONT}`; w = g.measureText(L.text).width; h = size * 0.9; }
      const cands = (typeof L.cands === 'function' ? L.cands(w, h) : L.cands) || [[0, 0, L.align || 'left']];
      const pad = L.card ? 1 : 2;
      let pick = null;
      for (const [dx, dy, align, ang = L.angle || 0] of cands) {
        const x = L.x + dx, y = L.y + dy;
        let box;
        if (ang) {
          const c = Math.abs(Math.cos(ang)), s = Math.abs(Math.sin(ang)), bw = w * c + h * s, bh = w * s + h * c;
          box = [x - bw / 2, y - bh / 2, x + bw / 2, y + bh / 2];
        } else {
          const x0 = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
          box = [x0 - pad, y - h / 2 - pad, x0 + w + pad, y + h / 2 + pad];
        }
        const inside = box[0] > 4 && box[1] > 4 && box[2] < this.W - 4 && box[3] < this.H - 4;
        if (!inside) continue;
        if (!hit(box)) { pick = { x, y, align, ang, box }; break; }
        if (L.force) { // (forced: where it covers least)
          const o = this.boxes.reduce((a, q) => a + Math.max(0, Math.min(q[2], box[2]) - Math.max(q[0], box[0])) * Math.max(0, Math.min(q[3], box[3]) - Math.max(q[1], box[1])), 0);
          if (!L.fallback || o < L.fallback.o) L.fallback = { x, y, align, ang, box, o };
        }
      }
      pick ??= L.fallback;
      if (!pick) continue;
      this.boxes.push(pick.box);
      if (L.card) { this.drawCard(L.card, pick.box[0] + pad, pick.box[1] + pad, w, h); L.onPlace?.(pick.box); continue; }
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

  // race cards: a white card with a bar in the race's colour, the name in capitals, then difficulty · prize (and,
  // zoomed in or hovered, length · drop)
  cardSize(c) {
    const g = this.g;
    g.font = `italic 700 16px ${FONT}`;
    let w = g.measureText(c.title).width;
    g.font = `italic 700 13.5px ${FONT}`;
    w = Math.max(w, c.sub.reduce((a, [t]) => a + g.measureText(t).width, 0));
    if (c.more) { g.font = `italic 600 13px ${FONT}`; w = Math.max(w, g.measureText(c.more).width); }
    return { w: Math.ceil(w) + 21, h: c.more ? 48 : 36 };
  }

  drawCard(c, x, y, w, h) {
    const g = this.g;
    g.save();
    g.beginPath(); g.roundRect(x, y, w, h, 4);
    g.shadowColor = 'rgba(8,20,60,0.3)'; g.shadowBlur = 7; g.shadowOffsetY = 2;
    g.fillStyle = 'rgba(255,255,255,0.97)'; g.fill();
    g.shadowColor = 'transparent';
    if (c.hot) { g.lineWidth = 2.5; g.strokeStyle = c.color; g.stroke(); }
    g.save(); g.clip(); g.fillStyle = c.color; g.fillRect(x, y, 5, h); g.restore();
    g.textAlign = 'left'; g.textBaseline = 'middle';
    g.font = `italic 700 16px ${FONT}`; g.fillStyle = NAVY; g.fillText(c.title, x + 12, y + 12.5);
    g.font = `italic 700 13.5px ${FONT}`;
    let sx = x + 12;
    for (const [t, col] of c.sub) { g.fillStyle = col; g.fillText(t, sx, y + 26.5); sx += g.measureText(t).width; }
    if (c.more) { g.font = `italic 600 13px ${FONT}`; g.fillStyle = '#4a5a85'; g.fillText(c.more, x + 12, y + 39); }
    g.restore();
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

  // ---------------------------------------------------------------- roads (game/bus/roads.js, live)
  // The network as world-space Path2Ds, built once and rebuilt only when it changes (a road, car park or roundabout
  // added): main roads (the valley roads), scenic roads (amber), minor roads (car park accesses, spurs, the Chaletweg),
  // the roundabouts' rings; each named road's label spots (every ~50 m: x, z, angle); the car parks; the bounding box.
  roadCache() {
    const R = busRoads.roads;
    if (!R?.length) return null;
    const lots = busRoads.lots || [], rings = busRoads.roundabouts || [];
    const key = `${R.length}:${lots.length}:${rings.length}:${busRoads.ready ? 1 : 0}`;
    const c0 = this._roads;
    if (c0 && c0.src === R && c0.key === key) return c0;
    const main = new Path2D(), scenic = new Path2D(), minor = new Path2D(), scenicMinor = new Path2D(), ring = new Path2D();
    const named = [], box = [Infinity, Infinity, -Infinity, -Infinity];
    for (const r of R) {
      if (!r?.n || !r.X) continue;
      const isRing = !!r.ringRoad, sc = !!r.scenic && !r.chalet, spur = /spur$/i.test(r.name || '');
      const P = isRing ? ring : sc ? (spur ? scenicMinor : scenic) : r.access || r.chalet ? minor : main;
      const step = r.n > 400 ? 3 : 2; // (samples every 4 m: 8-12 m is plenty for the map)
      for (let i = 0; i < r.n; i += step) {
        const x = r.X[i], z = r.Z[i];
        if (i) P.lineTo(x, z); else P.moveTo(x, z);
        if (x < box[0]) box[0] = x; if (z < box[1]) box[1] = z; if (x > box[2]) box[2] = x; if (z > box[3]) box[3] = z;
      }
      P.lineTo(r.X[r.n - 1], r.Z[r.n - 1]);
      if (r.name && !isRing) {
        const pts = [], k = Math.max(4, Math.round(50 / Math.max(1, r.length / r.n)));
        for (let i = k; i < r.n - k; i += k) pts.push([r.X[i], r.Z[i], Math.atan2(r.Z[i + k] - r.Z[i - k], r.X[i + k] - r.X[i - k])]);
        if (pts.length) named.push({ name: r.name, length: r.length, scenic: sc, minor: spur || (!sc && (r.access || r.chalet)), pts });
      }
    }
    // (the same name on two pieces: labelled once, from the longer)
    named.sort((a, b) => b.length - a.length);
    const seen = new Set(), labels = named.filter((n) => { const k = n.name.replace(/\s*\(.*\)$/, ''); if (seen.has(k)) return false; seen.add(k); return true; });
    this._roads = { src: R, key, main, scenic, minor, scenicMinor, ring, labels, box,
      rings: rings.map((q) => ({ x: q.x, z: q.z, R: q.R || 15, name: q.name })),
      lots: lots.filter((L) => !L.building && Number.isFinite(L.x)).map((L) => ({ x: L.x, z: L.z, hw: L.hw, hd: L.hd, ux: L.ux ?? 1, uz: L.uz ?? 0, vx: L.vx ?? 0, vz: L.vz ?? 1, name: L.name, size: L.size })) };
    return this._roads;
  }

  drawRoads() {
    const C = this.roadCache();
    if (!C) return;
    const g = this.g, v = this.view, s = v.s, d = this.dpr;
    const bx0 = this.X(C.box[0]), by0 = this.Z(C.box[1]), bx1 = this.X(C.box[2]), by1 = this.Z(C.box[3]);
    if (bx1 < -40 || by1 < -40 || bx0 > this.W + 40 || by0 > this.H + 40) return;
    const wMain = Math.max(2.2, Math.min(6, 6.8 * s)), wMinor = Math.max(1.4, Math.min(4.5, 5.5 * s));
    g.save();
    // world space: one transform for the whole network (line widths in CSS px / s)
    g.setTransform(d * s, 0, 0, d * s, d * (this.W / 2 - v.x * s), d * (this.H / 2 - v.z * s));
    g.lineCap = 'round'; g.lineJoin = 'round';
    const stroke = (P, w, casing, col) => {
      g.strokeStyle = casing; g.lineWidth = (w + 2.6) / s; g.stroke(P);
      g.strokeStyle = col; g.lineWidth = w / s; g.stroke(P);
    };
    if (s >= 0.05) { stroke(C.minor, wMinor, 'rgba(255,255,255,0.92)', '#8a8f98'); stroke(C.scenicMinor, wMinor, 'rgba(255,255,255,0.92)', '#d39a3c'); }
    stroke(C.main, wMain, 'rgba(255,255,255,0.95)', '#6f7788');
    stroke(C.scenic, wMain, 'rgba(255,255,255,0.95)', '#c9811a');
    stroke(C.ring, wMain, 'rgba(255,255,255,0.95)', '#c9811a');
    g.restore();
    // the roundabouts: a white island (and the name, zoomed in)
    for (const q of C.rings) {
      const x = this.X(q.x), y = this.Z(q.z);
      if (!this.inView(x, y)) continue;
      const r = Math.max(2.5, (q.R - 4) * s);
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill();
      g.lineWidth = 1.2; g.strokeStyle = '#c9811a'; g.stroke();
      this.reserve(x, y, Math.max(5, q.R * s));
      if (q.name) {
        this.spot(x, y, Math.max(7, q.R * s), q.x, q.z, q.name);
        if (s >= 0.16) this.label(q.name, x, y, { size: 12.5, weight: 600, color: '#8a5a0c', prio: 7, cands: this.around(Math.max(6, q.R * s), 5) });
      }
    }
    // the car parks: the lot's outline zoomed in, a blue P sign
    for (const L of C.lots) {
      const x = this.X(L.x), y = this.Z(L.z);
      if (!this.inView(x, y)) continue;
      if (s >= 0.35) {
        g.beginPath();
        for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { const px = this.X(L.x + L.ux * a * L.hw + L.vx * b * L.hd), py = this.Z(L.z + L.uz * a * L.hw + L.vz * b * L.hd); if (a === -1 && b === -1) g.moveTo(px, py); else g.lineTo(px, py); }
        g.closePath(); g.fillStyle = 'rgba(138,143,152,0.55)'; g.fill(); g.lineWidth = 1; g.strokeStyle = '#fff'; g.stroke();
      }
      if (s < 0.06 && L.size !== 'big') continue;
      const q = s >= 0.2 ? 6.5 : 5;
      g.fillStyle = BLUE; g.strokeStyle = '#fff'; g.lineWidth = 1.5;
      g.beginPath(); g.roundRect(x - q, y - q, 2 * q, 2 * q, 2); g.fill(); g.stroke();
      g.fillStyle = '#fff'; g.font = `800 ${Math.round(q * 1.5)}px ${UI}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('P', x, y + 0.5);
      this.reserve(x, y, q + 1);
      if (L.name) {
        this.spot(x, y, q + 2, L.x, L.z, L.name);
        if (s >= 0.3) this.label(L.name, x, y, { size: 12.5, weight: 600, color: BLUE, prio: 8, cands: this.around(q + 1, 4) });
      }
    }
    // the road names along them (upright, either side, as near the middle of the view as it fits)
    const cx = this.W / 2, cy = this.H / 2;
    g.font = `italic 700 13px ${FONT}`;
    for (const n of C.labels) {
      if (n.minor ? s < 0.22 : s < 0.07) continue;
      const tw = g.measureText(n.name).width;
      if (n.length * s < tw * 1.6) continue; // (the road too short on screen for its name)
      const cands = [];
      for (const [wx, wz, a0] of n.pts) {
        const x = this.X(wx), y = this.Z(wz);
        if (!this.inView(x, y, -30)) continue;
        let ang = a0;
        if (ang > Math.PI / 2) ang -= Math.PI; else if (ang < -Math.PI / 2) ang += Math.PI;
        const off = wMain / 2 + 8, nx = -Math.sin(ang) * off, ny = Math.cos(ang) * off;
        cands.push([Math.hypot(x - cx, y - cy), [x + nx, y + ny, 'center', ang], [x - nx, y - ny, 'center', ang]]);
      }
      if (!cands.length) continue;
      cands.sort((a, b) => a[0] - b[0]);
      this.label(n.name, 0, 0, { size: 13, color: n.scenic ? '#8a5a0c' : '#4a5263', prio: n.minor ? 7.5 : 4.5, cands: cands.slice(0, 14).flatMap((c) => [c[1], c[2]]) });
    }
  }

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

  // the chalet village (game/chalets.js sets layout.chaletVillage): the Chaletweg, each chalet's footprint (yours in
  // gold), the playground; labelled and clickable as a place
  drawChalets() {
    const C = layout.chaletVillage;
    if (!C) return;
    const g = this.g, s = this.view.s, cx = this.X(C.center.x), cy = this.Z(C.center.z);
    if (!this.inView(cx, cy, 400 * s + 60)) return;
    g.save();
    g.lineCap = 'round'; g.lineJoin = 'round';
    this.path(C.road);
    g.strokeStyle = '#fff'; g.lineWidth = Math.max(2.5, 9 * s); g.stroke();
    g.strokeStyle = '#8a8f98'; g.lineWidth = Math.max(1.5, 6.5 * s); g.stroke();
    const mine = C.rented?.();
    for (const h of C.houses) {
      const x = this.X(h.x), y = this.Z(h.z), w = Math.max(3, h.w * s), d = Math.max(4.5, h.d * s);
      g.save(); g.translate(x, y); g.rotate(-h.yaw);
      g.fillStyle = h.id === mine ? GOLD : '#a0522d'; g.strokeStyle = '#fff'; g.lineWidth = 1;
      g.beginPath(); g.rect(-w / 2, -d / 2, w, d); g.fill(); g.stroke();
      g.restore();
      if (h.num && s > 0.9) { g.fillStyle = '#fff'; g.font = `bold ${Math.round(Math.min(14, 5 * s))}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(h.num), x, y); } // (the house numbers, zoomed in)
    }
    const own = C.houses.find((h) => h.id === mine);
    if (own && s < 0.9) { // (your chalet, findable zoomed out: a gold disc on it)
      const ox = this.X(own.x), oy = this.Z(own.z);
      g.beginPath(); g.arc(ox, oy, 5.5, 0, Math.PI * 2); g.fillStyle = GOLD; g.fill(); g.lineWidth = 2; g.strokeStyle = '#fff'; g.stroke();
      this.spot(ox, oy, 8, own.x, own.z, own.name || 'Your chalet');
    }
    if (own) this.label(`YOUR CHALET${own.name ? ` · ${own.name.toUpperCase()}` : ''}`, this.X(own.x), this.Z(own.z), { size: 12, color: '#8a6a00', prio: 1, cands: this.around(Math.max(10, 9 * s), 6) }); // (your chalet: "YOUR CHALET · CHALET 7")
    for (const p of C.playground || []) { g.fillStyle = '#2fbf5b'; g.beginPath(); g.arc(this.X(p.x), this.Z(p.z), Math.max(2.5, 4 * s), 0, Math.PI * 2); g.fill(); }
    g.restore();
    this.reserve(cx, cy, 12);
    this.spot(cx, cy, Math.max(14, 120 * s), C.x, C.z, C.label);
    this.label('CHALET VILLAGE', cx, cy, { size: 15, color: '#8a3a12', prio: 2, cands: this.around(Math.max(14, 130 * s), 6) });
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

  // The World Racing courses on the mountains round the resort (free ride races them where they stand; the Legacy
  // Express stops beside every finish), drawn to be found at every zoom. Under the lifts: each course as a race tape
  // (a soft band in its difficulty colour, a white casing, the colour, white dashes down the middle: it reads apart
  // from the pistes). On top of everything: a chequered finish, a pin with a chequered flag at the start and a card
  // (name, difficulty · prize; zoomed in also length · drop), labelled before anything else but the village.
  // Hovering a pin, card, finish or its express station lights the race up; a click marks it (`target`).
  races() { try { return freeCourses(); } catch { return []; } }

  drawRaceLines() {
    const g = this.g, s = this.view.s, hot = this.hot?.race, w0 = Math.min(6, Math.max(3.2, s * 8));
    g.save();
    g.lineCap = 'round'; g.lineJoin = 'round';
    for (const e of this.races()) {
      const col = raceInk(e.D.color), on = hot === e.id, w = w0 + (on ? 1.5 : 0);
      this.path(e.pts);
      g.globalAlpha = on ? 0.34 : 0.17; g.strokeStyle = col; g.lineWidth = w + Math.max(12, 30 * s); g.stroke();
      g.globalAlpha = 1;
      g.strokeStyle = '#fff'; g.lineWidth = w + 4; g.stroke();
      g.strokeStyle = col; g.lineWidth = w; g.stroke();
      g.setLineDash([w * 1.2, w * 2.4]); g.strokeStyle = 'rgba(255,255,255,0.92)'; g.lineWidth = Math.max(1.2, w * 0.32); g.stroke();
      g.setLineDash([]);
    }
    g.restore();
  }

  drawRaceMarks(now) {
    const g = this.g, s = this.view.s, hot = this.hot?.race;
    for (const e of this.races()) {
      const col = raceInk(e.D.color), on = hot === e.id, tag = { race: e.id };
      const fx = this.X(e.finish.x), fy = this.Z(e.finish.z);
      if (this.inView(fx, fy)) {
        const q = s < 0.07 ? 7.5 : 9;
        finishMark(g, fx, fy, q, col);
        this.reserve(fx, fy, q / 2 + 3);
        this.spot(fx, fy, q / 2 + 3, e.finish.x, e.finish.z, `${e.name} · finish`, tag);
      }
      const x = this.X(e.start.x), y = this.Z(e.start.z);
      if (!this.inView(x, y, 60)) continue;
      const r = on ? 12.5 : 11;
      if (on) {
        const ph = (now / 1300) % 1;
        g.strokeStyle = col; g.globalAlpha = 0.6 * (1 - ph); g.lineWidth = 2.5;
        g.beginPath(); g.arc(x, y - r * 1.75, r + 3 + ph * 18, 0, Math.PI * 2); g.stroke();
        g.globalAlpha = 1;
      }
      const cy = racePin(g, x, y, r, col), tip = y - cy, gap = 5;
      this.boxes.push([x - r - 2, cy - r - 2, x + r + 2, y + 1]);
      this.spot(x, cy, r + 3, e.start.x, e.start.z, e.name, tag);
      const card = {
        title: e.name.toUpperCase(), color: col, hot: on,
        sub: [[e.D.label.toUpperCase(), col], [`  ·  up to $${(e.rewardMax || e.reward).toLocaleString('en-US')}`, NAVY]], // (the Superhard field's 1st prize)
        more: s >= 0.3 ? `${(e.length / 1000).toFixed(1)} km  ·  ${e.drop} m drop` : null,
      };
      this.label(e.name, x, cy, { prio: 0.5, force: true, card,
        cands: (w, h) => {
          const c = [[r + gap, 0, 'left'], [-r - gap, 0, 'right'], [0, -r - gap - h / 2, 'center'], [0, tip + gap + h / 2, 'center'],
            [r, -r - h / 2, 'left'], [-r, -r - h / 2, 'right'], [r, tip + h / 2, 'left'], [-r, tip + h / 2, 'right']];
          // (a crowded spot: a little further out)
          for (const k of [26, 52]) c.push([r + gap + k, 0, 'left'], [-r - gap - k, 0, 'right'], [0, -r - gap - h / 2 - k, 'center'], [0, tip + gap + h / 2 + k, 'center']);
          return c;
        },
        onPlace: (b) => this.spots.push({ box: b, x: (b[0] + b[2]) / 2, y: (b[1] + b[3]) / 2, r: 0, wx: e.start.x, wz: e.start.z, label: e.name, ...tag }) });
    }
  }

  // The Legacy Express (layout.express, from world/expressground.js; nothing when it isn't there): a bold violet line
  // in a white casing with a white hairline down its middle (double track), dashed and faint through the tunnels,
  // its name along it. The stations (drawExpressStops, over the lifts): white discs in violet rings, each joined to
  // its race's finish by a dotted line in the race's colour (and on up to the start while the race is hovered).
  drawExpress() {
    const R = layout.express;
    if (!R?.pts?.length) return;
    const s = this.view.s, w = Math.min(5.5, Math.max(3.4, 2.8 + s * 5)), P = R.pts, cands = [];
    this.strokeExpress(P, w);
    // the name: upright along an open stretch, as near the middle of the view as it fits
    for (let i = 12; i < P.length - 12; i += Math.max(6, Math.round(1.6 / s))) {
      if (P[i][2] || P[i - 10][2] || P[i + 10][2]) continue;
      const x = this.X(P[i][0]), y = this.Z(P[i][1]);
      if (!this.inView(x, y, -40)) continue;
      let ang = Math.atan2(this.Z(P[i + 10][1]) - this.Z(P[i - 10][1]), this.X(P[i + 10][0]) - this.X(P[i - 10][0]));
      if (ang > Math.PI / 2) ang -= Math.PI; else if (ang < -Math.PI / 2) ang += Math.PI;
      const off = w / 2 + 10, nx = -Math.sin(ang) * off, ny = Math.cos(ang) * off, d = Math.hypot(x - this.W / 2, y - this.H / 2);
      cands.push([d, [x + nx, y + ny, 'center', ang], [x - nx, y - ny, 'center', ang]]);
    }
    cands.sort((a, b) => a[0] - b[0]);
    const flat = cands.flatMap((c) => [c[1], c[2]]);
    this.label(R.name.toUpperCase(), 0, 0, { size: 14, color: EXPRESS, prio: 2.5, cands: flat });
    if (s < 0.08) this.label(R.name.toUpperCase(), 0, 0, { size: 14, color: EXPRESS, prio: 7, cands: flat.slice().reverse() });
  }

  /** The express line style (also the route picker's): P = [[x, z, tunnel 0/1]...], w = line width (px). */
  strokeExpress(P, w) {
    const g = this.g;
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
    run(true, () => {
      g.setLineDash([w * 1.4, w * 1.1]);
      g.strokeStyle = 'rgba(255,255,255,0.85)'; g.lineWidth = w * 0.62 + 2.5; g.stroke();
      g.strokeStyle = 'rgba(106,34,201,0.6)'; g.lineWidth = w * 0.62; g.stroke();
    });
    run(false, () => {
      g.setLineDash([]);
      g.strokeStyle = '#fff'; g.lineWidth = w + 4; g.stroke();
      g.strokeStyle = EXPRESS; g.lineWidth = w; g.stroke();
      g.strokeStyle = 'rgba(255,255,255,0.88)'; g.lineWidth = Math.max(1, w * 0.22); g.stroke();
    });
    g.setLineDash([]);
    g.restore();
  }

  drawExpressStops() {
    const R = layout.express;
    if (!R?.stations?.length) return;
    const g = this.g, s = this.view.s, hot = this.hot, races = this.races();
    for (const st of R.stations) {
      const x = this.X(st.x), y = this.Z(st.z), e = st.course && races.find((q) => q.id === st.course);
      if (e) {
        const col = raceInk(e.D.color), on = hot && (hot.race === e.id || hot.station === st.id);
        g.save();
        g.lineCap = 'round'; g.setLineDash([0.1, 5.5]);
        const link = (tx, tz) => {
          g.beginPath(); g.moveTo(x, y); g.lineTo(this.X(tx), this.Z(tz));
          g.strokeStyle = '#fff'; g.lineWidth = 5.5; g.stroke(); g.strokeStyle = col; g.lineWidth = 3; g.stroke();
        };
        link(e.finish.x, e.finish.z);
        if (on) link(e.start.x, e.start.z);
        g.restore();
      }
      if (!this.inView(x, y)) continue;
      const village = st.id === 'village', r = village ? 8.5 : 6.5, b = st.board || st;
      expressStop(g, x, y, r, village);
      this.reserve(x, y, r + 2);
      this.spot(x, y, r + 2, b.x, b.z, `${R.name} · ${village ? 'Village station' : st.name}`, { station: st.id, race: st.course || undefined });
      if (village) this.label(R.name.toUpperCase(), x, y, { size: 15, color: EXPRESS, prio: s < 0.08 ? 3 : 1, force: s >= 0.08, cands: this.around(r + 2, 6) });
      else if (s >= 0.12) this.label(R.name, x, y, { size: 13, color: EXPRESS, prio: 4, cands: this.around(r + 1, 5) });
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
    const CR = busRoads.rental; // (the car rental straight from roads.js when main.js passes none)
    const places = mk.places?.some((m) => m.kind === 'car') || !CR ? mk.places || [] : [...(mk.places || []), { x: CR.ex ?? CR.x, z: CR.ez ?? CR.z, label: 'Car Rental', kind: 'car' }];
    // places worth finding (the Car Rental): a blue square with a little car, always labelled, clickable as a target
    for (const m of places) {
      const x = X(m.x), y = Z(m.z);
      if (!this.inView(x, y)) continue;
      g.fillStyle = '#1f5fd6'; g.strokeStyle = '#fff'; g.lineWidth = 2;
      g.beginPath(); g.roundRect(x - 9, y - 9, 18, 18, 4); g.fill(); g.stroke();
      // the car: body, cabin, two wheels
      g.fillStyle = '#fff';
      g.beginPath(); g.roundRect(x - 6, y - 1, 12, 4, 1.5); g.fill();
      g.beginPath(); g.moveTo(x - 3.5, y - 1); g.lineTo(x - 2, y - 4.5); g.lineTo(x + 2.5, y - 4.5); g.lineTo(x + 4, y - 1); g.closePath(); g.fill();
      g.fillStyle = '#1f5fd6';
      for (const wx of [-3.5, 3.5]) { g.beginPath(); g.arc(x + wx, y + 3.2, 1.6, 0, Math.PI * 2); g.fill(); }
      this.reserve(x, y, 11);
      this.spot(x, y, 11, m.x, m.z, m.label);
      this.label(m.label, x, y, { size: 14, weight: 700, color: '#1f5fd6', prio: 3, cands: this.around(10) });
    }
    // the village services (live: roads.js plans the medical centre and the car rental's lots, village.js the ski shop):
    // a rounded square each, labelled, clickable as a target (the car rental from busRoads when main.js passes none)
    const svc = [];
    const shop = window.__game?.village?.shopDoor;
    if (shop) svc.push({ x: shop.x, z: shop.z, label: 'Ski shop', kind: 'shop' });
    const H = busRoads.hospital;
    if (H) svc.push({ x: H.ex ?? H.x, z: H.ez ?? H.z, label: 'Medical centre', kind: 'med' });
    for (const m of svc) {
      const x = X(m.x), y = Z(m.z);
      if (!this.inView(x, y)) continue;
      const med = m.kind === 'med', col = med ? RED : '#1f5fd6';
      g.fillStyle = med ? '#fff' : col; g.strokeStyle = med ? RED : '#fff'; g.lineWidth = 2;
      g.beginPath(); g.roundRect(x - 9, y - 9, 18, 18, 4); g.fill(); g.stroke();
      if (med) { g.fillStyle = RED; g.fillRect(x - 6, y - 2, 12, 4); g.fillRect(x - 2, y - 6, 4, 12); } // (the cross)
      else { // (a pair of skis)
        g.strokeStyle = '#fff'; g.lineWidth = 2; g.lineCap = 'round';
        g.beginPath(); g.moveTo(x - 5, y + 5.5); g.lineTo(x + 3, y - 5.5); g.moveTo(x - 1.5, y + 5.5); g.lineTo(x + 6, y - 5.5); g.stroke();
        g.lineCap = 'butt';
      }
      this.reserve(x, y, 11);
      this.spot(x, y, 11, m.x, m.z, m.label);
      if (s >= 0.08) this.label(m.label, x, y, { size: 14, weight: 700, color: med ? '#b01810' : col, prio: 3, cands: this.around(10) });
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
    // what you own (game/ownertags.js, hosted by the car rental): your car (gold; grey while impounded) and the
    // helicopter you rented, waiting out on the mountain; your chalet has its gold disc (drawChalets)
    let mine = [];
    try { mine = window.__game?.carRental?.ownerTags?.mapMarkers?.() || []; } catch { mine = []; }
    for (const m of mine) {
      if (m.kind === 'chalet') continue;
      const x = X(m.x), y = Z(m.z);
      if (!this.inView(x, y)) continue;
      const col = m.kind === 'impound' ? '#6f7788' : GOLD;
      g.fillStyle = col; g.strokeStyle = '#fff'; g.lineWidth = 2;
      g.beginPath(); g.roundRect(x - 8, y - 8, 16, 16, 4); g.fill(); g.stroke();
      g.fillStyle = '#fff';
      if (m.kind === 'heli') { g.font = `italic 700 12px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('H', x, y + 0.5); }
      else { // (a little car)
        g.beginPath(); g.roundRect(x - 5.5, y - 0.5, 11, 3.6, 1.4); g.fill();
        g.beginPath(); g.moveTo(x - 3.2, y - 0.5); g.lineTo(x - 1.8, y - 4); g.lineTo(x + 2.2, y - 4); g.lineTo(x + 3.6, y - 0.5); g.closePath(); g.fill();
        g.fillStyle = col; for (const wx of [-3.2, 3.2]) { g.beginPath(); g.arc(x + wx, y + 3.3, 1.4, 0, Math.PI * 2); g.fill(); }
      }
      this.reserve(x, y, 10);
      this.spot(x, y, 10, m.x, m.z, m.label);
      this.label(m.label, x, y, { size: 13.5, weight: 700, color: m.kind === 'impound' ? '#4a5263' : '#8a6a00', prio: 1, cands: this.around(9) });
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
