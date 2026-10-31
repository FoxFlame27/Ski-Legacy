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
// (Oct 30 2026, the user: "can you maybe make the map clearer, it's super messy": a row of layer switches over the map
// (Pistes & lifts, Races, Roads & car parks, Buses & train, Places, Jobs, Mine; remembered per viewer), detail that fades
// in with the zoom (zoomed out: peaks, the village, the lifts, the piste colours, the main roads), icons placed by
// priority with the ones that would sit on another folded into it ("+2", named in its tooltip), labels that never
// overlap (no more forced ones), one icon style (a rounded badge, white rim, white glyph), the legend folded away
// behind a button and listing only the layers that are on, and a tooltip with the name and details of whatever you
// point at (pistes, lifts, roads, stops, buildings, races) instead of every name written on the map. The static map is
// drawn into a cache only when the view, the layers or the hover change (and once a second for the markers); each
// frame only blits it and draws you, the mark, the other players and the patrol cars.)
// (Oct 31 2026, the user: "draw the tunnel stretches of the roads distinctly: a darker, dashed road with small portal
// marks at each end", the name in the tooltip ("Kalkwand-Tunnel · 560 m"), in the Roads layer: busRoads.tunnels, each
// tunnel's stretch of its road (sF0..sF1) as a Path2D in roadCache, stroked over the road in drawRoads, hovered in lineAt.)
import { world, MAIN_SUMMIT } from '../world/world.js';
import { layout, VILLAGE_BUILDINGS } from '../world/layout.js';
import { PISTE_COLORS } from '../world/resortdressing.js';
import { freeCourses } from '../modes/parkour/freeworld.js'; // the World Racing courses on the mountains
import { busRaceEntries } from '../modes/race/busraces.js'; // the ski bus's free races on the pistes (gold tape)
import { brushSVG, brushClip, esc } from './menu.js';
import { busRoads, roadAt } from '../game/bus/roads.js'; // the road network (valley roads, scenic roads, roundabouts, car parks)
import { CHALET_PLACE } from '../game/bus/chaletroad.js'; // (the chalet village's spot before game/chalets.js has built it)

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

// the layers you switch on and off over the map (Oct 30 2026, the user: "make the map clearer"): [id, name, colour]
const LAYERS = [
  ['pistes', 'Pistes & lifts', '#2f7bff'],
  ['races', 'Races', '#e23b3b'],
  ['roads', 'Roads & car parks', '#6f7788'],
  ['transit', 'Buses & train', EXPRESS],
  ['places', 'Places', '#1f5fd6'],
  ['jobs', 'Jobs', '#7a4a22'],
  ['mine', 'Mine', GOLD],
];
const LAYER_KEY = 'ski-legacy-map-layers';
/** 0..1: how far something that shows from zoom `from` has faded in (nothing below 3/4 of it). */
const fadeIn = (s, from) => Math.min(1, Math.max(0, (s - from * 0.75) / (from * 0.25)));
const segDist = (px, pz, ax, az, bx, bz) => {
  const dx = bx - ax, dz = bz - az, l = dx * dx + dz * dz, t = l ? Math.min(1, Math.max(0, ((px - ax) * dx + (pz - az) * dz) / l)) : 0;
  return Math.hypot(px - ax - dx * t, pz - az - dz * t);
};
const fmtLen = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`);
const ptx = (p) => p[0] ?? p.x, ptz = (p) => p[1] ?? p.z;

// One icon style for everything on the map (Oct 30 2026, the user: "cleaner icons"): a rounded badge (a disc for the
// round ones) in the thing's colour, a white rim and a white glyph drawn in a 9-px-radius box. Also the legend's.
const carGlyph = (g, I) => {
  g.beginPath(); g.roundRect(-6, -1, 12, 4.2, 1.5); g.fill();
  g.beginPath(); g.moveTo(-3.5, -1); g.lineTo(-2, -4.8); g.lineTo(2.5, -4.8); g.lineTo(4, -1); g.closePath(); g.fill();
  g.fillStyle = I.fill; for (const wx of [-3.5, 3.5]) { g.beginPath(); g.arc(wx, 3.3, 1.6, 0, Math.PI * 2); g.fill(); }
};
const houseGlyph = (g) => { g.beginPath(); g.moveTo(0, -6.5); g.lineTo(6.5, -0.5); g.lineTo(6.5, 5.5); g.lineTo(-6.5, 5.5); g.lineTo(-6.5, -0.5); g.closePath(); g.fill(); };
const textGlyph = (t, px, font = UI, w = 800, it = '') => (g) => { g.font = `${it}${w} ${px}px ${font}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(t, 0, 0.7); };
const ICONS = {
  lot: { fill: BLUE, glyph: textGlyph('P', 12.5) },
  depot: { fill: '#c99400', glyph: textGlyph('B', 12.5) },
  bus: { fill: BLUE, glyph: textGlyph('BUS', 6.8) },
  train: { fill: RED, glyph: (g) => { g.lineWidth = 1.8; g.beginPath(); g.roundRect(-4.5, -6, 9, 10, 2.2); g.stroke(); g.fillRect(-4.5, -1.5, 9, 1.6); g.beginPath(); g.moveTo(-3, 4); g.lineTo(-5, 7); g.moveTo(3, 4); g.lineTo(5, 7); g.stroke(); } },
  hut: { fill: '#b8452a', glyph: houseGlyph },
  shop: { fill: '#1f5fd6', glyph: (g) => { g.lineWidth = 2.2; g.beginPath(); g.moveTo(-5, 5.5); g.lineTo(3, -5.5); g.moveTo(-1.5, 5.5); g.lineTo(6, -5.5); g.stroke(); } },
  car: { fill: '#1f5fd6', glyph: carGlyph },
  garage: { fill: '#1f5fd6', glyph: (g) => { g.lineWidth = 2.6; g.beginPath(); g.moveTo(-4.5, 4.5); g.lineTo(2, -2); g.stroke(); g.lineWidth = 2; g.beginPath(); g.arc(3, -3, 3, Math.PI * 0.95, Math.PI * 2.55); g.stroke(); } },
  police: { fill: '#1f3fa8', glyph: (g) => { for (const bx of [-5, -1.5, 2]) g.fillRect(bx, -6, 2, 12); g.fillRect(-6, -6, 12, 1.6); g.fillRect(-6, 4.4, 12, 1.6); } },
  med: { fill: RED, glyph: (g) => { g.fillRect(-6, -2, 12, 4); g.fillRect(-2, -6, 4, 12); } },
  heli: { fill: RED, round: true, glyph: textGlyph('H', 13, FONT, 700, 'italic ') },
  policeheli: { fill: '#1f3fa8', round: true, glyph: textGlyph('H', 13, FONT, 700, 'italic ') }, // (the police helicopter while it is out: drawLive)
  drop: { fill: RED, round: true, glyph: (g) => { g.beginPath(); g.moveTo(0, -5); g.lineTo(5.5, 4); g.lineTo(-5.5, 4); g.closePath(); g.fill(); } },
  board: { fill: '#7a4a22', glyph: (g) => { g.lineWidth = 1.6; g.strokeRect(-4.5, -5, 9, 11); g.fillRect(-2.5, -6.5, 5, 2.5); g.fillRect(-2.5, -1.5, 5, 1.3); g.fillRect(-2.5, 1.5, 5, 1.3); } },
  job: { fill: GOLD, round: true, glyph: textGlyph('!', 13) },
  secret: { fill: '#c98a00', round: true, glyph: (g) => { g.beginPath(); g.moveTo(0, -6); g.lineTo(5, 0); g.lineTo(0, 6); g.lineTo(-5, 0); g.closePath(); g.fill(); } },
  chalet: { fill: GOLD, glyph: houseGlyph },
  chaletv: { fill: '#8a3a12', glyph: houseGlyph }, // (the chalet village)
  mycar: { fill: GOLD, glyph: carGlyph },
  impound: { fill: '#6f7788', glyph: carGlyph },
  myheli: { fill: GOLD, glyph: textGlyph('H', 13, FONT, 700, 'italic ') },
  dot: { fill: RED, round: true },
};
export function mapIcon(g, kind, x, y, r = 9) {
  const I = ICONS[kind] || ICONS.dot;
  g.save();
  g.translate(x, y);
  g.beginPath();
  if (I.round) g.arc(0, 0, r, 0, Math.PI * 2); else g.roundRect(-r, -r, 2 * r, 2 * r, r * 0.36);
  g.shadowColor = 'rgba(8,20,60,0.35)'; g.shadowBlur = 3; g.shadowOffsetY = 1;
  g.fillStyle = I.fill; g.fill();
  g.shadowColor = 'transparent';
  g.lineWidth = 2; g.strokeStyle = '#fff'; g.stroke();
  g.scale(r / 9, r / 9);
  g.fillStyle = g.strokeStyle = '#fff';
  g.lineCap = 'round'; g.lineJoin = 'round';
  I.glyph?.(g, I);
  g.restore();
}
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
    // (Oct 30, the user: "make the map as a default pretty zoomed in": opened on you, close in: the streets, huts and
    // stops round you readable; scroll out for the rest)
    if (!this.opened || Math.hypot(v.x - p.x, v.z - p.z) > 400) { v.x = p.x; v.z = p.z; v.s = 0.75; }
    this.opened = true;
    this.root.hidden = false;
    const where = this.locationName?.() || '';
    this.$where.innerHTML = where ? `You are here · <b>${esc(where)}</b>` : 'Legacy Valley';
    this.resize();
    this.fitBounds();
    this.baseKey = null;
    cancelAnimationFrame(this.raf);
    const loop = () => {
      if (!this.isOpen) return;
      this.tilesBuilt = this.buildTiles() > 0;
      this.draw();
      if (this.hoverAt) this.updateHover();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  close() {
    if (!this.isOpen) return;
    this.root.hidden = true;
    cancelAnimationFrame(this.raf);
    this.drag = null;
    this.hideTip();
    this.onClose?.();
  }

  // ---------------------------------------------------------------- layers (Oct 30 2026, the user: "make the map clearer")
  // on by default; your choice is remembered in this browser (localStorage, which may be unavailable: then just this session)
  loadLayers() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(LAYER_KEY) || 'null'); } catch { saved = null; }
    this.layers = {};
    for (const [id] of LAYERS) this.layers[id] = saved && typeof saved[id] === 'boolean' ? saved[id] : true;
  }
  /** Is a layer on? (always, on maps without the switches: ui/travel.js's route picker) */
  on(id) { return !this.layers || this.layers[id] !== false; }
  setLayer(id, v) {
    this.layers[id] = v;
    try { localStorage.setItem(LAYER_KEY, JSON.stringify(this.layers)); } catch { /* storage unavailable: this session only */ }
    this.syncLayers();
  }
  syncLayers() {
    for (const b of this.root.querySelectorAll('.tm-layer')) { const on = this.on(b.dataset.layer); b.classList.toggle('off', !on); b.setAttribute('aria-pressed', String(on)); }
    for (const sec of this.root.querySelectorAll('.tm-legend [data-layer]')) sec.hidden = !this.on(sec.dataset.layer);
    this.hot = null; this.hideTip();
  }
  layerKey() { return LAYERS.map(([id]) => (this.on(id) ? 1 : 0)).join(''); }

  // ---------------------------------------------------------------- DOM
  build() {
    const r = this.root;
    r.className = 'trailmap';
    const sw = (c, label) => `<div class="tm-row"><i class="tm-sw" style="--c:${c}"></i><span>${label}</span></div>`;
    const sym = (cls, label, c = '') => `<div class="tm-row"><i class="tm-sym ${cls}"${c ? ` style="--c:${c}"` : ''}></i><span>${label}</span></div>`;
    const ico = (kind, label) => `<div class="tm-row"><canvas class="tm-ico" data-ico="${kind}"></canvas><span>${label}</span></div>`;
    const sec = (layer, head, body) => `<div class="tm-lsec"${layer ? ` data-layer="${layer}"` : ''}><div class="mp-head">${head}</div>${body}</div>`;
    // (Oct 30 2026, the user: the layer switches over the map, the legend folded behind a button (only the layers that
    // are on), a tooltip for what you point at; compact: two columns where the entries are short)
    r.innerHTML = `
      <div class="tm-head">
        <div class="menu-title" style="width:calc(var(--u) * 290)">${brushSVG(77, 320, 100)}<span>TRAIL MAP</span></div>
        <div class="menu-sub tm-where"></div>
      </div>
      <div class="tm-body">
        <div class="tm-map paper" style="--clip:${brushClip(171, 3, 4)}">
          <canvas class="tm-canvas"></canvas>
          <div class="tm-scale"><i></i><span></span></div>
          <div class="tm-tip" hidden></div>
          <div class="tm-over">
            <div class="tm-bar">
              <div class="tm-layers">${LAYERS.map(([id, n, c]) => `<button class="tm-layer" data-layer="${id}" style="--c:${c}" aria-pressed="true"><i></i>${n}</button>`).join('')}</div>
              <button class="tm-legbtn" aria-expanded="false">Legend</button>
            </div>
            <div class="tm-legend menu-panel" hidden style="--clip:${brushClip(172, 5, 4)}">
              ${sec('', 'MAP', `<div class="tm-grid">${ico('you', 'You')}${ico('peak', 'Summit')}${ico('mark', 'Marked spot')}${ico('cluster', 'More here')}</div>`)}
              ${sec('pistes', 'PISTES & LIFTS', `<div class="tm-grid">${[0, 1, 2, 3].map((i) => sw(PISTE_COLORS[i], GRADES[i])).join('')}${sym('gondola', 'Gondola')}${sym('chair', 'Chairlift')}${sym('park', 'Terrain park')}${ico('heli', 'Heli-ski')}${ico('drop', 'Drop zone')}${ico('pnum', 'Piste number')}</div>`)}
              ${sec('races', 'RACES', `<div class="tm-grid">${RACE_GRADES.map(([n, c]) => sym('pin', n, c)).join('')}${sym('finish', 'Finish')}${sym('tape', 'Race line', '#2f7bff')}</div>`)}
              ${sec('roads', 'ROADS & CAR PARKS', `<div class="tm-grid">${sym('road', 'Road')}${sym('scenic', 'Scenic road')}${ico('lot', 'Car park')}${sym('ring', 'Roundabout')}${ico('depot', 'Bus depot')}</div>`)}
              ${sec('transit', 'BUSES & TRAIN', `<div class="tm-grid">${sym('express', 'Legacy Express')}${sym('xtunnel', 'Tunnel')}${ico('xstop', 'Station')}${ico('bus', 'Ski bus')}${ico('train', 'Railway')}</div>`)}
              ${sec('places', 'PLACES', `<div class="tm-grid">${ico('chaletv', 'Chalet village')}${ico('hut', 'Mountain hut')}${ico('shop', 'Ski shop')}${ico('car', 'Autohaus')}${ico('garage', 'Werkstatt')}${ico('med', 'Medical centre')}${ico('police', 'Police')}${ico('secret', 'Landmark')}</div>`)}
              ${sec('jobs', 'JOBS', `<div class="tm-grid">${ico('board', 'Job board')}${ico('job', 'Job target')}</div>`)}
              ${sec('mine', 'MINE', `<div class="tm-grid">${ico('chalet', 'Your chalet')}${ico('mycar', 'Your car')}${ico('impound', 'Impounded')}${ico('myheli', 'Your heli')}</div>`)}
            </div>
          </div>
        </div>
      </div>
      <div class="tm-hints">
        <span class="hint"><i class="kc">M</i><em>Close</em></span>
        <span class="hint"><i class="kc kc-word">DRAG</i><em>Move</em></span>
        <span class="hint"><i class="kc kc-word">SCROLL</i><em>Zoom</em></span>
        <span class="hint"><i class="kc kc-word">POINT</i><em>Info</em></span>
        <span class="hint"><i class="kc kc-word">CLICK</i><em>Mark a place</em></span>
        <span class="hint"><i class="kc">R</i><em>Back to you</em></span>
      </div>`;
    this.canvas = r.querySelector('.tm-canvas');
    this.g = this.canvas.getContext('2d');
    this.$where = r.querySelector('.tm-where');
    this.$scale = r.querySelector('.tm-scale');
    this.$tip = r.querySelector('.tm-tip');
    this.$legend = r.querySelector('.tm-legend');
    this.loadLayers();
    for (const c of r.querySelectorAll('canvas.tm-ico')) this.legendIcon(c);
    for (const b of r.querySelectorAll('.tm-layer')) b.addEventListener('click', () => this.setLayer(b.dataset.layer, !this.on(b.dataset.layer)));
    const lb = r.querySelector('.tm-legbtn');
    lb.addEventListener('click', () => { const open = this.$legend.hidden; this.$legend.hidden = !open; lb.setAttribute('aria-expanded', String(open)); lb.classList.toggle('on', open); });
    this.syncLayers();
    // clicks inside the panels never reach main.js's "click outside closes the map"
    for (const el of r.querySelectorAll('.tm-map, .tm-legend, .tm-head, .tm-hints')) el.addEventListener('click', (e) => e.stopPropagation());
    const cv = this.canvas;
    cv.addEventListener('pointerdown', (e) => { this.drag = { x: e.clientX, y: e.clientY, vx: this.view.x, vz: this.view.z, moved: 0 }; cv.setPointerCapture(e.pointerId); cv.classList.add('grab'); });
    cv.addEventListener('pointermove', (e) => {
      if (!this.drag) { this.hoverAt = { clientX: e.clientX, clientY: e.clientY }; return; } // (looked up once a frame)
      this.drag.moved = Math.max(this.drag.moved, Math.hypot(e.clientX - this.drag.x, e.clientY - this.drag.y));
      if (this.drag.moved > 4) this.hideTip();
      this.view.x = this.drag.vx - (e.clientX - this.drag.x) / this.view.s;
      this.view.z = this.drag.vz - (e.clientY - this.drag.y) / this.view.s;
    });
    const up = () => { this.drag = null; cv.classList.remove('grab'); };
    cv.addEventListener('pointerup', (e) => { if (this.drag && this.drag.moved < 5) this.pick(e); up(); });
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('pointerleave', () => { this.hot = null; this.hoverAt = null; this.hideTip(); });
    cv.addEventListener('wheel', (e) => {
      e.preventDefault(); e.stopPropagation();
      const rc = cv.getBoundingClientRect();
      this.zoomAt(e.clientX - rc.left, e.clientY - rc.top, Math.pow(1.0018, -e.deltaY));
      this.hoverAt = { clientX: e.clientX, clientY: e.clientY }; // (what's under the pointer after the zoom)
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
    for (const list of [this.spots, this.dynSpots]) for (const s of list || []) {
      const b = s.box, d = b ? (px > b[0] && px < b[2] && py > b[1] && py < b[3] ? -9 : 1e9) : Math.hypot(s.x - px, s.y - py) - s.r;
      if (d < 10 && d < bd) { bd = d; best = s; }
    }
    return best;
  }
  hover(e) { this.hoverAt = { clientX: e.clientX, clientY: e.clientY }; this.updateHover(); }
  // what the pointer is on (a place, else a piste, lift, road, line or race under it): the highlight and the tooltip
  // (Oct 30 2026, the user: "hover/click for info" instead of every name written on the map)
  updateHover() {
    const e = this.hoverAt;
    this.hoverAt = null;
    if (!e || this.drag) return;
    const s = this.spotAt(e), line = s ? null : this.lineAt(e);
    this.hot = s || (line?.race ? line : null); // (a race line lights its race up too)
    this.canvas.classList.toggle('pick', !!(s || line));
    const it = s || line;
    if (!it) { this.hideTip(); return; }
    let tip = typeof it.tip === 'function' ? it.tip() : it.tip;
    tip = tip ? { ...tip } : { title: it.label };
    if (it.more?.length) tip.more = it.more;
    const rc = this.canvas.getBoundingClientRect();
    this.showTip(tip, e.clientX - rc.left, e.clientY - rc.top);
  }
  showTip(t, px, py) {
    const el = this.$tip;
    if (!el) return;
    el.innerHTML = `<b>${esc(t.title || '')}</b>${(t.lines || []).filter(Boolean).map((l) => `<span>${esc(l)}</span>`).join('')}`
      + (t.more ? `<span class="tm-tmore">Also here: ${t.more.map(esc).join(' · ')}</span>` : '')
      + '<em>Click to mark</em>';
    el.hidden = false;
    const ox = this.canvas.offsetLeft, oy = this.canvas.offsetTop, w = el.offsetWidth, h = el.offsetHeight;
    const x = px + 16 + w > this.W ? px - 12 - w : px + 16, y = py + 18 + h > this.H ? py - 12 - h : py + 18;
    el.style.left = `${Math.round(ox + Math.max(4, x))}px`;
    el.style.top = `${Math.round(oy + Math.max(4, y))}px`;
  }
  hideTip() { if (this.$tip) this.$tip.hidden = true; }

  // the line under the pointer (within 7 px): a piste, lift, road, the express, the railway or a race (layers on only)
  lineAt(e) {
    const rc = this.canvas.getBoundingClientRect(), v = this.view, s = v.s;
    const wx = v.x + (e.clientX - rc.left - this.W / 2) / s, wz = v.z + (e.clientY - rc.top - this.H / 2) / s;
    let best = null, bd = 7 / s;
    const poly = (pts, mk, step = 1) => {
      for (let i = step; i < pts.length; i += step) {
        const a = pts[i - step], b = pts[i], d = segDist(wx, wz, ptx(a), ptz(a), ptx(b), ptz(b));
        if (d < bd) { bd = d; best = mk; }
      }
    };
    if (this.on('pistes')) {
      for (const p of layout.pistes) poly(p.pts, { label: p.name, tip: () => this.pisteTip(p) });
      for (const l of layout.lifts) { const d = segDist(wx, wz, l.bottom.x, l.bottom.z, l.top.x, l.top.z); if (d < bd) { bd = d; best = { label: l.name, tip: () => this.liftTip(l) }; } }
    }
    if (this.on('races')) for (const r of this.races()) poly(r.pts, { label: r.name, tip: () => this.raceTip(r), race: r.id });
    if (this.on('transit')) {
      const X = layout.express;
      if (X?.pts?.length) poly(X.pts, { label: X.name, tip: { title: X.name, lines: ['Train', `${X.stations?.length || 0} stations`] } });
      const R = layout.railway;
      if (R?.pts?.length) poly(R.pts, { label: R.name, tip: { title: R.name, lines: ['Railway', R.stations?.length ? R.stations.map((q) => q.name).join(' · ') : ''] } });
      for (const q of layout.railways || []) { const P = q.pts || q.line || q.path; if (P?.length) poly(P, { label: q.name || 'Railway', tip: { title: q.name || 'Railway', lines: ['Railway'] } }); }
    }
    if (this.on('roads')) {
      const C = this.roadCache();
      if (C && wx > C.box[0] - bd && wx < C.box[2] + bd && wz > C.box[1] - bd && wz < C.box[3] + bd) {
        let tun = null, td = Infinity; // (Oct 31 2026, the user: the tunnel's name in the tooltip, "Kalkwand-Tunnel · 560 m")
        for (const T of C.tunnels) for (let i = 1; i < T.pts.length; i++) {
          const a = T.pts[i - 1], b = T.pts[i], dd = segDist(wx, wz, a[0], a[1], b[0], b[1]);
          if (dd < td) { td = dd; tun = T; }
        }
        for (const r of busRoads.roads) {
          if (!r?.n || !r.X || r.ringRoad) continue;
          for (let i = 2; i < r.n; i += 2) {
            const d = segDist(wx, wz, r.X[i - 2], r.Z[i - 2], r.X[i], r.Z[i]);
            if (d < bd) { bd = d; best = r; }
          }
        }
        // (a hair of slack: the tunnel wins over its own road, which runs under it)
        if (tun && td < bd + 1.5 / s) { bd = Math.min(bd, td); best = { label: tun.name, tip: { title: `${tun.name} · ${Math.round(tun.length)} m`, lines: ['Road tunnel', tun.road] } }; }
        else tun = null;
        if (!tun && best && best.X) {
          const r = best, name = (r.name || 'Road').replace(/\s*\(.*\)$/, '');
          best = { label: name, tip: { title: name, lines: [r.scenic && !r.chalet ? 'Scenic road' : r.access ? 'Car park access' : r.chalet ? 'Chalet road' : 'Valley road', r.length ? fmtLen(r.length) : ''] } };
        }
      }
    }
    if (best) Object.assign(best, { wx, wz });
    return best;
  }

  pisteTip(p) {
    let len = 0;
    for (let i = 1; i < p.pts.length; i++) len += Math.hypot(ptx(p.pts[i]) - ptx(p.pts[i - 1]), ptz(p.pts[i]) - ptz(p.pts[i - 1]));
    const a = p.pts[0], b = p.pts[p.pts.length - 1], drop = a && b ? Math.round(Math.abs(world.height(ptx(a), ptz(a)) - world.height(ptx(b), ptz(b)))) : 0;
    const num = p.number ?? layout.pistes.indexOf(p) + 1;
    return { title: `${num} · ${p.name}`, lines: [`${GRADES[p.diff] || ''} piste${p.lane ? ' · ski lane' : ''}`, `${fmtLen(len)} · ${drop} m drop`] };
  }
  liftTip(l) {
    const len = Math.hypot(l.top.x - l.bottom.x, l.top.z - l.bottom.z), rise = Math.round(world.height(l.top.x, l.top.z) - world.height(l.bottom.x, l.bottom.z));
    return { title: l.name, lines: [l.type === 'gondola' ? 'Gondola' : 'Chairlift', `${fmtLen(len)} · ${rise} m up`] };
  }
  raceTip(e) {
    return { title: e.name, lines: [e.bus ? `Free race · ski bus: ${e.stop}` : `${e.D.label} · up to $${(e.rewardMax || e.reward).toLocaleString('en-US')}`,
      `${(e.length / 1000).toFixed(1)} km · ${e.drop} m drop`] };
  }

  pick(e) {
    const s = this.spotAt(e) || this.lineAt(e), t = this.target;
    if (s) { this.target = t && Math.hypot(t.x - s.wx, t.z - s.wz) < 1 ? null : { x: s.wx, z: s.wz, label: s.label }; return; }
    // anywhere else: drop a pin right where you clicked (click the pin again to clear it)
    const rc = this.canvas.getBoundingClientRect(), v = this.view;
    const wx = v.x + (e.clientX - rc.left - this.W / 2) / v.s, wz = v.z + (e.clientY - rc.top - this.H / 2) / v.s;
    if (t && Math.hypot(t.x - wx, t.z - wz) * v.s < 14) { this.target = null; return; }
    this.target = { x: wx, z: wz, label: 'Marked spot' };
  }

  // the legend's icons: drawn with the map's own icon code, so they always match
  legendIcon(c) {
    const k = c.dataset.ico, d = 2, w = 24, h = 20, g = c.getContext('2d');
    c.width = w * d; c.height = h * d;
    g.scale(d, d);
    const x = w / 2, y = h / 2;
    if (k === 'you') this.arrow(g, x, y, 0, 0.62);
    else if (k === 'peak') { g.fillStyle = NAVY; g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x, y - 7); g.lineTo(x + 7.5, y + 6); g.lineTo(x - 7.5, y + 6); g.closePath(); g.fill(); g.stroke(); }
    else if (k === 'mark') { g.strokeStyle = RED; g.lineWidth = 2.5; g.beginPath(); g.arc(x, y, 6.5, 0, Math.PI * 2); g.stroke(); }
    else if (k === 'cluster') this.clusterBadge(g, x, y, 3, 8);
    else if (k === 'xstop') expressStop(g, x, y, 6.5);
    else if (k === 'pnum') this.pisteBadge(g, x, y, 7, PISTE_COLORS[1], 4);
    else mapIcon(g, k, x, y, 8);
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
    let n = 0; // (how many were built: the cached map is redrawn while tiles arrive)
    const want = LEVELS.reduce((a, L, i) => (v.s >= L.from ? i : a), 0);
    for (const li of want ? [0, want] : [0]) {
      const { tx0, tx1, tz0, tz1 } = this.range(li), T = LEVELS[li].tile, todo = [];
      for (let tz = tz0; tz <= tz1; tz++) for (let tx = tx0; tx <= tx1; tx++) {
        if (!tiles.has(li + ':' + tx + ',' + tz)) todo.push([tx, tz, Math.hypot((tx + 0.5) * T - v.x, (tz + 0.5) * T - v.z)]);
      }
      todo.sort((a, b) => a[2] - b[2]);
      for (const [tx, tz] of todo) {
        tiles.set(li + ':' + tx + ',' + tz, buildTile(li, tx, tz)); n++;
        if (tiles.size > MAX_TILES) {
          const old = [...tiles.entries()].sort((a, b) => (a[1].used || 0) - (b[1].used || 0)).slice(0, 400);
          for (const [k] of old) tiles.delete(k);
        }
        if (performance.now() - t0 > budget) return n;
      }
    }
    return n;
  }

  // ---------------------------------------------------------------- drawing
  // (Oct 30 2026, the user: "keep it performant": the map itself is drawn into a cache only when the view, the layers,
  // the hover or the mark change, while relief tiles arrive, and once a second for the markers of the other systems;
  // each frame blits it and draws only what moves: you, the mark's ring, the other players, the patrol cars)
  draw() {
    const v = this.view, now = performance.now(), t = this.target, hot = this.hot;
    const key = `${v.x}|${v.z}|${v.s}|${this.W}|${this.H}|${this.dpr}|${this.layerKey()}|${hot?.race ?? ''}|${hot?.station ?? ''}|${t ? `${t.x},${t.z}` : ''}`;
    if (key !== this.baseKey || this.tilesBuilt || now < (this.fadeUntil || 0) || now - (this.baseAt || 0) > 1000) {
      this.drawBase(now);
      this.baseKey = key; this.baseAt = now;
    }
    const g = this.g;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(this.base, 0, 0);
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawLive(now);
  }

  drawBase(now) {
    const main = this.g, v = this.view, W = this.W, H = this.H;
    if (!this.base) { this.base = document.createElement('canvas'); this.baseG = this.base.getContext('2d'); }
    if (this.base.width !== this.canvas.width || this.base.height !== this.canvas.height) { this.base.width = this.canvas.width; this.base.height = this.canvas.height; }
    this.g = this.baseG;
    const g = this.g;
    try {
      g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      g.fillStyle = '#eef2fa';
      g.fillRect(0, 0, W, H);
      this.X = (x) => (x - v.x) * v.s + W / 2;
      this.Z = (z) => (z - v.z) * v.s + H / 2;
      this.drawRelief(now);
      // geometry first (symbols reserve their space), then the icons by priority (one that would sit on another is
      // folded into it), then the labels by priority
      this.boxes = [];
      this.queue = [];
      this.spots = [];
      this.icons = [];
      this.pins = new Map();
      this.mk = this.markers?.() || {};
      if (this.on('roads')) this.drawRoads();
      this.drawVillage();
      this.drawChalets();
      if (this.on('pistes')) { this.drawPark(); this.drawPistes(); }
      if (this.on('transit')) this.drawExpress();
      if (this.on('races')) this.drawRaceLines();
      if (this.on('transit')) this.drawRail();
      if (this.on('pistes')) this.drawLifts();
      if (this.on('transit')) this.drawRailway();
      this.drawPlaces();
      if (this.on('transit')) this.drawExpressStops();
      if (this.on('races')) this.drawRaceMarks(now);
      this.drawTarget(now);
      this.placeIcons();
      this.placeLabels();
      this.drawScale();
    } finally { this.g = main; }
  }

  // what moves, every frame, over the cached map: the mark's breathing ring, the hovered race's pulse, the other
  // players (multiplayer), the patrol cars while you are wanted, and you
  drawLive(now) {
    const g = this.g, s = this.view.s, X = this.X, Z = this.Z;
    this.dynSpots = [];
    const t = this.target;
    if (t) {
      const x = X(t.x), y = Z(t.z), r = 13 + Math.sin(now / 260) * 2;
      if (this.inView(x, y, 0)) {
        g.save();
        g.strokeStyle = 'rgba(255,255,255,0.95)'; g.lineWidth = 6; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke();
        g.strokeStyle = RED; g.lineWidth = 3; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke();
        g.restore();
      }
    }
    const pin = this.hot?.race && this.pins?.get(this.hot.race);
    if (pin) {
      const ph = (now / 1300) % 1;
      g.strokeStyle = pin.col; g.globalAlpha = 0.6 * (1 - ph); g.lineWidth = 2.5;
      g.beginPath(); g.arc(pin.x, pin.cy, pin.r + 3 + ph * 18, 0, Math.PI * 2); g.stroke();
      g.globalAlpha = 1;
    }
    let mk = {};
    try { mk = this.markers?.() || {}; } catch { mk = {}; }
    // multiplayer: the other players (net/remote.js mapMarkers), live: a green dot with their heading and their name
    for (const m of mk.players || []) {
      const x = X(m.x), y = Z(m.z);
      if (!this.inView(x, y)) continue;
      const fx = Math.sin(m.yaw || 0), fz = Math.cos(m.yaw || 0), dx = X(m.x + fx) - x, dy = Z(m.z + fz) - y, l = Math.hypot(dx, dy) || 1;
      const ux = dx / l, uy = dy / l;
      g.fillStyle = '#12a150'; g.strokeStyle = '#fff'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(x + ux * 12, y + uy * 12); g.lineTo(x - uy * 5.5, y + ux * 5.5); g.lineTo(x + uy * 5.5, y - ux * 5.5); g.closePath(); g.fill(); // (the heading)
      g.beginPath(); g.arc(x, y, 7, 0, Math.PI * 2); g.fill(); g.stroke();
      if (m.label) {
        g.font = `italic 700 14px ${FONT}`; g.textAlign = 'left'; g.textBaseline = 'middle'; g.lineJoin = 'round';
        g.strokeStyle = 'rgba(255,255,255,0.94)'; g.lineWidth = 4; g.strokeText(m.label, x + 11, y);
        g.fillStyle = '#0d7a3c'; g.fillText(m.label, x + 11, y);
        this.dynSpots.push({ x, y, r: 9, wx: m.x, wz: m.z, label: m.label, tip: { title: m.label, lines: ['Player'] } });
      }
    }
    // the patrol cars while you are wanted (game/police.js): blue dots
    for (const m of mk.police || []) {
      const x = X(m.x), y = Z(m.z);
      if (!this.inView(x, y)) continue;
      // (Oct 31 2026, the user: "It's on the trail map as a police heli icon while it's out": a navy round H, a pulsing
      // red ring while it has you in its light)
      if (m.kind === 'heli') {
        if (m.sees) { g.strokeStyle = '#d0342c'; g.lineWidth = 2.5; g.globalAlpha = 0.5 + 0.4 * Math.sin(now / 180); g.beginPath(); g.arc(x, y, 13, 0, Math.PI * 2); g.stroke(); g.globalAlpha = 1; }
        mapIcon(g, 'policeheli', x, y, 9);
        this.dynSpots.push({ x, y, r: 10, wx: m.x, wz: m.z, label: 'Police helicopter', tip: { title: 'Police helicopter', lines: [m.sees ? 'It is tracking you' : 'Searching for you'] } });
        continue;
      }
      g.fillStyle = '#1f4fff'; g.strokeStyle = '#fff'; g.lineWidth = 2;
      g.beginPath(); g.arc(x, y, s >= 0.2 ? 7 : 6, 0, Math.PI * 2); g.fill(); g.stroke();
      this.dynSpots.push({ x, y, r: 8, wx: m.x, wz: m.z, label: 'Police', tip: { title: 'Police patrol', lines: ['You are wanted'] } });
    }
    this.drawPlayer(now);
  }

  // ---------------------------------------------------------------- icons (Oct 30 2026, the user: "no overlaps")
  /** Queue an icon: { x, y (screen), r, prio, kind (mapIcon) or draw(g, o), alpha, wx, wz, label, tip, extra,
   *  lab (its label's text), labo (label options) }. Placed by priority after the geometry; one that would overlap an
   *  icon already placed is folded into it: a "+n" on that one, and their names in its tooltip. */
  icon(o) { if ((o.alpha ?? 1) > 0.04 && this.inView(o.x, o.y, 20)) this.icons.push(o); }

  placeIcons() {
    const g = this.g, placed = [];
    this.icons.sort((a, b) => a.prio - b.prio);
    for (const o of this.icons) {
      const host = placed.find((p) => Math.hypot(p.x - o.x, p.y - o.y) < p.r + o.r + 1);
      if (host) { if (o.label) (host.more ||= []).push(o.label); continue; }
      placed.push(o);
      g.globalAlpha = o.alpha ?? 1;
      if (o.draw) o.draw(g, o); else mapIcon(g, o.kind, o.x, o.y, o.r);
      g.globalAlpha = 1;
      if (o.box) this.boxes.push(o.box); else this.reserve(o.x, o.y, o.r + 1);
      if (o.lab) this.label(o.lab, o.x, o.y, { cands: this.around(o.r + 1, 4), alpha: o.alpha, ...o.labo });
    }
    for (const p of placed) {
      if (p.more) this.clusterBadge(g, p.x + p.r * 0.85, p.y - p.r * 0.85, p.more.length + 1);
      if (p.label) this.spot(p.x, p.spotY ?? p.y, p.r + 2, p.wx, p.wz, p.label, { tip: p.tip, more: p.more, ...p.extra });
    }
  }

  /** "+n": n things at this spot (zoom in to see them all). */
  clusterBadge(g, x, y, n, r = 7) {
    g.save();
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2);
    g.fillStyle = NAVY; g.fill(); g.lineWidth = 1.5; g.strokeStyle = '#fff'; g.stroke();
    g.fillStyle = '#fff'; g.font = `800 ${n > 9 ? 7.5 : 8.5}px ${UI}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(`+${n - 1}`, x, y + 0.5);
    g.restore();
  }

  /** A piste's number on a disc in its colour. */
  pisteBadge(g, x, y, r, col, num) {
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2);
    g.fillStyle = col; g.fill();
    g.lineWidth = 2; g.strokeStyle = '#fff'; g.stroke();
    g.fillStyle = '#fff'; g.font = `italic 700 ${Math.round(r * (num > 9 ? 1.2 : 1.4))}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(String(num), x, y + 0.5);
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
        if (g.globalAlpha < 1) this.fadeUntil = Math.max(this.fadeUntil || 0, t.born + 300); // (still fading in: redraw)
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
      if ((L.alpha ?? 1) < 0.05) continue; // (not faded in yet at this zoom: takes no room either)
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
      if (L.card) { g.globalAlpha = L.alpha ?? 1; this.drawCard(L.card, pick.box[0] + pad, pick.box[1] + pad, w, h); g.globalAlpha = 1; L.onPlace?.(pick.box); continue; }
      g.save();
      g.globalAlpha = L.alpha ?? 1;
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
    const tuns = busRoads.tunnels || [];
    const key = `${R.length}:${lots.length}:${rings.length}:${tuns.length}:${busRoads.ready ? 1 : 0}`;
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
    // the road tunnels (Oct 31 2026, the user: "a darker, dashed road with small portal marks at each end"): each one's
    // stretch of its road (portal to portal, a point every ~6 m) and its two portals (x, z, the road's direction there)
    const tunnel = new Path2D(), tunnels = [], TQ = {};
    for (const t of tuns) {
      const r = t.road;
      if (!r?.n || !r.X || !(t.sF1 > t.sF0)) continue;
      const pts = [], k = Math.max(2, Math.ceil((t.sF1 - t.sF0) / 6));
      for (let j = 0; j <= k; j++) { roadAt(r, t.sF0 + ((t.sF1 - t.sF0) * j) / k, TQ); pts.push([TQ.x, TQ.z]); }
      pts.forEach(([x, z], j) => (j ? tunnel.lineTo(x, z) : tunnel.moveTo(x, z)));
      const ends = [t.sF0, t.sF1].map((sv) => { roadAt(r, sv, TQ); return { x: TQ.x, z: TQ.z, dx: TQ.dx, dz: TQ.dz }; });
      tunnels.push({ name: t.name || 'Tunnel', length: t.length || t.sF1 - t.sF0, road: (r.name || 'Road').replace(/\s*\(.*\)$/, ''), pts, ends });
    }
    this._roads = { src: R, key, main, scenic, minor, scenicMinor, ring, labels, box, tunnel, tunnels,
      rings: rings.map((q) => ({ x: q.x, z: q.z, R: q.R || 15, name: q.name })),
      lots: lots.filter((L) => (!L.building || L.depot) && Number.isFinite(L.x)).map((L) => ({ x: L.x, z: L.z, hw: L.hw, hd: L.hd, ux: L.ux ?? 1, uz: L.uz ?? 0, vx: L.vx ?? 0, vz: L.vz ?? 1, name: L.name, size: L.size, depot: !!L.depot })) }; // (the bus depot too: a yellow B)
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
    // the tunnels (Oct 31 2026, the user: "a darker, dashed road"): the road under them washed out to the paper, then
    // a dark slate dash down it (world space: the dash in CSS px / s, so it keeps its size at every zoom)
    if (C.tunnels.length) {
      g.lineCap = 'butt';
      g.strokeStyle = 'rgba(246,247,249,0.97)'; g.lineWidth = (wMain + 0.8) / s; g.stroke(C.tunnel);
      g.setLineDash([5 / s, 3.5 / s]); g.strokeStyle = '#3b4150'; g.lineWidth = Math.max(1.6, wMain * 0.62) / s; g.stroke(C.tunnel);
      g.setLineDash([]); g.lineCap = 'round';
    }
    g.restore();
    // the portals: a small dark bracket across the road at each end, its wings pointing out of the mountain
    if (C.tunnels.length && s >= 0.04) {
      const hw = wMain / 2 + 2.6, wing = Math.max(2, Math.min(4.5, 3 * s + 1.5));
      g.save(); g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = '#2a2f3a'; g.lineWidth = Math.max(1.4, Math.min(2.4, wMain * 0.4));
      for (const T of C.tunnels) T.ends.forEach((e, j) => {
        const x = this.X(e.x), y = this.Z(e.z);
        if (!this.inView(x, y, 20)) return;
        const o = j ? 1 : -1, ax = e.dx * o, ay = e.dz * o, nx = -e.dz, ny = e.dx; // (a: out of the tunnel; n: across)
        g.beginPath();
        g.moveTo(x + nx * hw + ax * wing, y + ny * hw + ay * wing); g.lineTo(x + nx * hw, y + ny * hw);
        g.lineTo(x - nx * hw, y - ny * hw); g.lineTo(x - nx * hw + ax * wing, y - ny * hw + ay * wing);
        g.stroke();
      });
      g.restore();
    }
    // the roundabouts: a white island (and the name, zoomed right in; else in the tooltip)
    for (const q of C.rings) {
      const x = this.X(q.x), y = this.Z(q.z);
      if (!this.inView(x, y) || s < 0.05) continue;
      const r = Math.max(2.5, (q.R - 4) * s);
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill();
      g.lineWidth = 1.2; g.strokeStyle = '#c9811a'; g.stroke();
      this.reserve(x, y, Math.max(5, q.R * s));
      if (q.name) {
        this.spot(x, y, Math.max(7, q.R * s), q.x, q.z, q.name, { tip: { title: q.name, lines: ['Roundabout'] } });
        if (s >= 0.4) this.label(q.name, x, y, { size: 12.5, weight: 600, color: '#8a5a0c', prio: 7, alpha: fadeIn(s, 0.4), cands: this.around(Math.max(6, q.R * s), 5) });
      }
    }
    // the car parks: the lot's outline zoomed in, a P badge (the big ones from further out; the bus depot a yellow B)
    const IR = s >= 0.25 ? 10 : 8.5;
    for (const L of C.lots) {
      const x = this.X(L.x), y = this.Z(L.z);
      if (!this.inView(x, y)) continue;
      if (s >= 0.35) {
        g.beginPath();
        for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { const px = this.X(L.x + L.ux * a * L.hw + L.vx * b * L.hd), py = this.Z(L.z + L.uz * a * L.hw + L.vz * b * L.hd); if (a === -1 && b === -1) g.moveTo(px, py); else g.lineTo(px, py); }
        g.closePath(); g.fillStyle = 'rgba(138,143,152,0.55)'; g.fill(); g.lineWidth = 1; g.strokeStyle = '#fff'; g.stroke();
      }
      const big = L.size === 'big' || L.depot, name = L.name || (L.depot ? 'Bus depot' : 'Car park');
      this.icon({ kind: L.depot ? 'depot' : 'lot', x, y, r: big ? IR : IR - 1.5, prio: big ? 5 : 6.5, alpha: fadeIn(s, big ? 0.06 : 0.16),
        wx: L.x, wz: L.z, label: name, tip: { title: name, lines: [L.depot ? 'Bus depot' : `Car park${L.size ? ` · ${L.size}` : ''}`] },
        lab: s >= 0.5 && L.name ? L.name : null, labo: { size: 12.5, weight: 600, color: L.depot ? '#8a6200' : BLUE, prio: 8 } });
    }
    // the road names along them (upright, either side, as near the middle of the view as it fits)
    const cx = this.W / 2, cy = this.H / 2;
    g.font = `italic 700 13px ${FONT}`;
    for (const n of C.labels) {
      if (n.minor ? s < 0.35 : s < 0.1) continue; // (zoomed out: the roads without their names; they're in the tooltip)
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
      this.label(n.name, 0, 0, { size: 13, color: n.scenic ? '#8a5a0c' : '#4a5263', prio: n.minor ? 7.5 : 4.5, alpha: fadeIn(s, n.minor ? 0.35 : 0.1), cands: cands.slice(0, 14).flatMap((c) => [c[1], c[2]]) });
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
  // (Oct 30 2026, the user: "where are the chalets": the chalet village is in Places as a chalet badge with its name from a medium
  // zoom out, even before game/chalets.js has built it (then from roads.js's plan, busRoads.chalets / CHALET_PLACE))
  drawChalets() {
    const C = layout.chaletVillage, P = C?.center || busRoads.chalets?.place || CHALET_PLACE;
    const g = this.g, s = this.view.s, cx = this.X(P.x), cy = this.Z(P.z), mine = C?.rented?.();
    const own = C?.houses.find((h) => h.id === mine);
    // (your chalet is in the Mine layer: a gold house badge, labelled; the chalet village in Places)
    if (own && this.on('mine')) this.icon({ kind: 'chalet', x: this.X(own.x), y: this.Z(own.z), r: s >= 0.25 ? 10 : 8.5, prio: 0.7, wx: own.x, wz: own.z,
      label: own.name || 'Your chalet', tip: { title: 'Your chalet', lines: [own.name || ''] },
      lab: `YOUR CHALET${own.name ? ` · ${own.name.toUpperCase()}` : ''}`, labo: { size: 12, color: '#8a6a00', prio: 1 } }); // (your chalet: "YOUR CHALET · CHALET 7")
    if (!this.on('places') || !this.inView(cx, cy, 400 * s + 60)) return;
    const n = C?.houses.length || busRoads.chalets?.plots?.filter((q) => !q.playground).length || 18, R = s >= 0.25 ? 11 : 10;
    const tip = { title: 'Chalet village', lines: ['Up the Chaletweg north of Legacy Village', `${n} chalets to buy · ski bus stop Chalet Village`] }; // (Oct 30, the user: "make sure you see chalet village on the map, don't call anything like that the chalet village")
    if (s < 0.6) this.icon({ kind: 'chaletv', x: cx, y: cy, r: R, prio: 1.4, wx: C?.x ?? P.x, wz: C?.z ?? P.z, label: 'Chalet village', tip });
    else this.spot(cx, cy, Math.max(14, 120 * s), C?.x ?? P.x, C?.z ?? P.z, 'Chalet village', { tip });
    // (its own label, not the icon's: it stays even where the badge folds into your chalet's)
    this.label('CHALET VILLAGE', cx, cy, { size: 15, color: '#8a3a12', prio: 1.5, alpha: fadeIn(s, 0.03), cands: s < 0.6 ? this.around(R + 1, 5) : this.around(Math.max(14, 130 * s), 6) });
    if (!C) return;
    g.save();
    g.lineCap = 'round'; g.lineJoin = 'round';
    this.path(C.road);
    g.strokeStyle = '#fff'; g.lineWidth = Math.max(2.5, 9 * s); g.stroke();
    g.strokeStyle = '#8a8f98'; g.lineWidth = Math.max(1.5, 6.5 * s); g.stroke();
    for (const h of C.houses) {
      const x = this.X(h.x), y = this.Z(h.z), w = Math.max(3, h.w * s), d = Math.max(4.5, h.d * s);
      g.save(); g.translate(x, y); g.rotate(-h.yaw);
      g.fillStyle = h.id === mine ? GOLD : '#a0522d'; g.strokeStyle = '#fff'; g.lineWidth = 1;
      g.beginPath(); g.rect(-w / 2, -d / 2, w, d); g.fill(); g.stroke();
      g.restore();
      if (h.num && s > 0.9) { g.fillStyle = '#fff'; g.font = `bold ${Math.round(Math.min(14, 5 * s))}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(h.num), x, y); } // (the house numbers, zoomed in)
    }
    for (const p of C.playground || []) { g.fillStyle = '#2fbf5b'; g.beginPath(); g.arc(this.X(p.x), this.Z(p.z), Math.max(2.5, 4 * s), 0, Math.PI * 2); g.fill(); }
    g.restore();
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
    for (const f of s >= 0.08 ? p.features || [] : []) { // (the features zoomed in only)
      const x = this.X(f.x), y = this.Z(f.z);
      if (!this.inView(x, y)) continue;
      g.beginPath(); g.moveTo(x, y - d); g.lineTo(x + d, y); g.lineTo(x, y + d); g.lineTo(x - d, y); g.closePath(); g.fill(); g.stroke();
    }
    g.restore();
    const m = p.line[Math.floor(p.line.length * 0.45)];
    if (m) {
      const x = this.X(m[0]), y = this.Z(m[1]), r = Math.max(8, (p.halfWidth || 17) * s);
      this.label((p.name || 'Legacy Park').toUpperCase(), x, y, { size: 15, color: '#c75400', prio: 4, alpha: fadeIn(s, 0.1), cands: this.around(r, 6) });
      const d0 = p.drop || { x: p.line[0][0], z: p.line[0][1] };
      this.spot(this.X(d0.x), this.Z(d0.z), 10, d0.x, d0.z, p.name || 'Legacy Park', { tip: { title: p.name || 'Legacy Park', lines: ['Terrain park', `${p.features?.length || 0} features`] } });
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
    // number badges from a little way in (the name written zoomed right in; else in the tooltip)
    const a = fadeIn(s, 0.07);
    for (const p of a > 0 ? pistes : []) {
      const q = p.pts[Math.floor(p.pts.length * 0.38)];
      if (!q) continue;
      const x = this.X(ptx(q)), y = this.Z(ptz(q)), num = p.number ?? layout.pistes.indexOf(p) + 1, col = PISTE_COLORS[p.diff];
      this.icon({ x, y, r: 10, prio: 3, alpha: a, draw: (g2, o) => this.pisteBadge(g2, o.x, o.y, o.r, col, num),
        wx: ptx(q), wz: ptz(q), label: p.name, tip: () => this.pisteTip(p),
        lab: s >= 0.45 ? p.name : null, labo: { size: 14, weight: 700, color: p.diff === 3 ? '#161616' : col, prio: 6, alpha: fadeIn(s, 0.45) } });
    }
  }

  // The World Racing courses on the mountains round the resort (free ride races them where they stand; the Legacy
  // Express stops beside every finish), drawn to be found at every zoom. Under the lifts: each course as a race tape
  // (a soft band in its difficulty colour, a white casing, the colour, white dashes down the middle: it reads apart
  // from the pistes). On top of everything: a chequered finish, a pin with a chequered flag at the start and a card
  // (name, difficulty · prize; zoomed in also length · drop), labelled before anything else but the village.
  // Hovering a pin, card, finish or its express station lights the race up; a click marks it (`target`).
  races() { try { return [...freeCourses(), ...busRaceEntries()]; } catch { return []; } }

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
      const fx = this.X(e.finish.x), fy = this.Z(e.finish.z), q = s < 0.07 ? 7.5 : 9;
      this.icon({ x: fx, y: fy, r: q / 2 + 3, prio: 2.6, alpha: fadeIn(s, 0.04), draw: (g2) => finishMark(g2, fx, fy, q, col),
        wx: e.finish.x, wz: e.finish.z, label: `${e.name} · finish`, tip: () => ({ ...this.raceTip(e), title: `${e.name} · finish` }), extra: tag });
      const x = this.X(e.start.x), y = this.Z(e.start.z);
      if (!this.inView(x, y, 60)) continue;
      // the pin (an icon: folds what it would cover; it collides by its head)
      const r = on ? 12.5 : 11, cy = y - r * 1.75, tip = y - cy, gap = 5;
      this.pins.set(e.id, { x, cy, r, col });
      this.icon({ x, y: cy, r: r + 1, prio: 1, draw: (g2) => racePin(g2, x, y, r, col), box: [x - r - 2, cy - r - 2, x + r + 2, y + 1],
        wx: e.start.x, wz: e.start.z, label: e.name, tip: () => this.raceTip(e), extra: tag });
      if (s < 0.09) continue; // (zoomed out: just the pins; the card is in the tooltip)
      const card = {
        title: e.name.toUpperCase(), color: col, hot: on,
        sub: e.bus ? [['FREE RACE', col], [`  ·  ski bus: ${e.stop}`, NAVY]] // (a bus race: its stop)
          : [[e.D.label.toUpperCase(), col], [`  ·  up to $${(e.rewardMax || e.reward).toLocaleString('en-US')}`, NAVY]], // (the Superhard field's 1st prize)
        more: s >= 0.3 ? `${(e.length / 1000).toFixed(1)} km  ·  ${e.drop} m drop${e.bus ? `  ·  free entry  ·  1st $${e.reward.toLocaleString('en-US')}` : ''}` : null,
      };
      this.label(e.name, x, cy, { prio: 0.5, force: on, alpha: fadeIn(s, 0.09), card,
        cands: (w, h) => {
          const c = [[r + gap, 0, 'left'], [-r - gap, 0, 'right'], [0, -r - gap - h / 2, 'center'], [0, tip + gap + h / 2, 'center'],
            [r, -r - h / 2, 'left'], [-r, -r - h / 2, 'right'], [r, tip + h / 2, 'left'], [-r, tip + h / 2, 'right']];
          // (a crowded spot: a little further out)
          for (const k of [26, 52]) c.push([r + gap + k, 0, 'left'], [-r - gap - k, 0, 'right'], [0, -r - gap - h / 2 - k, 'center'], [0, tip + gap + h / 2 + k, 'center']);
          return c;
        },
        onPlace: (b) => this.spots.push({ box: b, x: (b[0] + b[2]) / 2, y: (b[1] + b[3]) / 2, r: 0, wx: e.start.x, wz: e.start.z, label: e.name, tip: () => this.raceTip(e), ...tag }) });
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
    this.label(R.name.toUpperCase(), 0, 0, { size: 14, color: EXPRESS, prio: 2.5, alpha: fadeIn(s, 0.05), cands: flat }); // (once: it's in the tooltip too)
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
      if (e && this.on('races')) { // (the dotted link to its race: with the races on)
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
      const village = st.id === 'village', r = village ? 9 : 7, b = st.board || st, name = village ? 'Village station' : st.name;
      this.icon({ x, y, r: r + 1, prio: village ? 1.2 : 2.2, alpha: village ? 1 : fadeIn(s, 0.045), draw: (g2) => expressStop(g2, x, y, r, village),
        wx: b.x, wz: b.z, label: `${R.name} · ${name}`, extra: { station: st.id, race: st.course || undefined },
        tip: { title: name, lines: [`${R.name} station`, e ? `Race: ${e.name}` : ''] },
        lab: village ? R.name.toUpperCase() : s >= 0.25 ? st.name : null,
        labo: village ? { size: 15, color: EXPRESS, prio: s < 0.08 ? 3 : 1.5 } : { size: 13, color: EXPRESS, prio: 6, alpha: fadeIn(s, 0.25) } });
    }
  }

  // railways (layout.railways, when there are any): the classic black-and-white map line, stations as bars
  drawRail() {
    const g = this.g, s0 = this.view.s;
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
        this.icon({ kind: 'train', x, y, r: 9, prio: 2, wx: st.x, wz: st.z, label: st.name, tip: { title: st.name || 'Station', lines: [`${r.name || 'Railway'} station`] },
          lab: s0 >= 0.1 ? st.name : null, labo: { size: 14, color: NAVY, prio: 3, alpha: fadeIn(s0, 0.1) } });
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
      if (!gondola && s < 0.06) g.globalAlpha = 0.55; // (zoomed out the gondolas read first)
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
      this.spot(ax, ay, 6, l.bottom.x, l.bottom.z, `${l.name} · valley station`, { tip: () => ({ ...this.liftTip(l), title: `${l.name} · valley station` }) });
      this.spot(bx, by, 6, l.top.x, l.top.z, `${l.name} · top station`, { tip: () => ({ ...this.liftTip(l), title: `${l.name} · top station` }) });
      if (l.mid) st(this.X(l.mid.x), this.Z(l.mid.z), 3.5);
      g.restore();
      // the name along the line, upright, on either side, at a few points along it
      // (zoomed out: the gondolas' names only; the chairlifts' from a little way in; all of them in the tooltip)
      if (len > 80 && s >= (gondola ? 0.07 : 0.14)) {
        let ang = Math.atan2(by - ay, bx - ax);
        if (ang > Math.PI / 2) ang -= Math.PI; else if (ang < -Math.PI / 2) ang += Math.PI;
        const nx = -Math.sin(ang), ny = Math.cos(ang), off = 11, cands = [];
        for (const t of l.mid ? [0.28, 0.72, 0.5] : [0.5, 0.32, 0.68]) for (const sd of [-1, 1]) cands.push([(bx - ax) * t + nx * off * sd, (by - ay) * t + ny * off * sd, 'center', ang]);
        this.label(l.name, ax, ay, { size: gondola ? 15 : 14, color: NAVY, prio: gondola ? 2 : 3, alpha: fadeIn(s, gondola ? 0.07 : 0.14), cands });
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
      this.icon({ kind: 'train', x, y, r: s >= 0.25 ? 10 : 8.5, prio: 2, wx: st.x, wz: st.z, label: st.name, tip: { title: st.name, lines: [`${R.name} station`] },
        lab: s >= 0.07 ? st.name : null, labo: { size: 14, color: '#8f1414', prio: 2, alpha: fadeIn(s, 0.07) } });
    }
    // the line's name along its middle stretch
    const m = P[Math.floor(P.length * 0.36)];
    if (m && s >= 0.08) this.label(R.name, this.X(m[0]), this.Z(m[1]), { size: 14, color: '#1b1f27', prio: 3, alpha: fadeIn(s, 0.08), cands: this.around(12) });
  }

  // Everything that is a place, as icons in the one style (placed by priority, folded where they would overlap; the
  // smaller ones fade in with the zoom; names written zoomed in, always in the tooltip). Summits always; the rest by
  // layer: Pistes & lifts (heli-ski), Places (huts, the village services, the Autohaus / Werkstatt, landmarks), Jobs,
  // Mine (your car, the impounded one, the helicopter you rented; your chalet is drawChalets'). The other players and
  // the patrol cars move: drawLive. (Oct 30 2026, the user: "make the map clearer")
  drawPlaces() {
    const g = this.g, s = this.view.s, X = this.X, Z = this.Z, IR = s >= 0.25 ? 10 : 8.5, mk = this.mk || {};
    // summits
    for (const p of layout.peaks) {
      const sm = p.summit || (p.id === 'legacy' ? MAIN_SUMMIT : null);
      if (!sm) continue;
      const x = X(sm.x), y = Z(sm.z);
      if (!this.inView(x, y)) continue;
      this.icon({ x, y, r: 8, prio: 0, wx: sm.x, wz: sm.z, label: `${p.name} summit`,
        tip: () => ({ title: p.name, lines: [`Summit · ${Math.round(world.height(sm.x, sm.z))} m`] }),
        draw: () => { g.fillStyle = NAVY; g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x, y - 7.5); g.lineTo(x + 8, y + 5.5); g.lineTo(x - 8, y + 5.5); g.closePath(); g.fill(); g.stroke(); } });
      this.label(p.name.toUpperCase(), x, y, { size: 17, color: NAVY, prio: 1, cands: [[0, 18, 'center'], [0, -18, 'center'], [12, 0, 'left'], [-12, 0, 'right']] });
    }
    // ski-bus stops (Buses & train; the village's from far out, the rest fade in)
    if (this.on('transit')) for (const b of layout.busStops) {
      const village = b.name === 'Legacy Village';
      this.icon({ kind: 'bus', x: X(b.x), y: Z(b.z), r: IR, prio: village ? 2.3 : 4, alpha: village ? 1 : fadeIn(s, 0.06), wx: b.x, wz: b.z, label: `Ski bus · ${b.name}`,
        tip: { title: b.name, lines: ['Ski bus stop'] }, lab: s >= 0.35 && !village ? b.name : null, labo: { size: 13, weight: 600, color: BLUE, prio: 5 } });
    }
    // heli-ski (Pistes & lifts): the pad, the drop zones zoomed in
    if (this.on('pistes')) for (const m of mk.heli || []) {
      const x = X(m.x), y = Z(m.z);
      if (m.kind === 'helipad') this.icon({ kind: 'heli', x, y, r: IR, prio: 2.5, alpha: fadeIn(s, 0.04), wx: m.x, wz: m.z, label: 'Heli-ski', tip: { title: 'Heli-ski', lines: ['Helicopter pad · flights to the drop zones'] },
        lab: s >= 0.2 ? 'Heli-ski' : null, labo: { size: 14, color: RED, prio: 5 } });
      else if (m.kind === 'drop') this.icon({ kind: 'drop', x, y, r: IR - 1.5, prio: 7, alpha: fadeIn(s, 0.1), wx: m.x, wz: m.z, label: m.label, tip: { title: m.label || 'Drop zone', lines: ['Heli-ski drop zone'] },
        lab: s >= 0.3 ? m.label : null, labo: { size: 13, weight: 600, color: RED, prio: 8 } });
      else this.icon({ kind: 'dot', x, y, r: 5, prio: 6, wx: m.x, wz: m.z, label: m.label || 'Heli-ski', tip: { title: m.label || 'Heli-ski' } });
    }
    if (this.on('places')) {
      // mountain huts
      for (const h of layout.huts) this.icon({ kind: 'hut', x: X(h.x), y: Z(h.z), r: IR, prio: 3, alpha: fadeIn(s, 0.05), wx: h.x, wz: h.z, label: h.name,
        tip: { title: h.name, lines: ['Mountain hut'] }, lab: s >= 0.3 ? h.name : null, labo: { size: 14, color: '#8f2f17', prio: 5 } });
      // the village services (live: roads.js plans the medical centre and the car rental, village.js the ski shop, prison.js
      // the police station; main.js passes the Autohaus and the Werkstatt, else the car rental straight from roads.js)
      const CR = busRoads.rental, svc = [];
      const places = mk.places?.some((m) => m.kind === 'car') || !CR ? mk.places || [] : [...(mk.places || []), { x: CR.ex ?? CR.x, z: CR.ez ?? CR.z, label: 'Autohaus', kind: 'car' }];
      for (const m of places) svc.push({ ...m, kind: m.kind === 'garage' ? 'garage' : 'car', what: m.kind === 'garage' ? 'Car repairs' : 'Cars to rent and buy' });
      const shop = window.__game?.village?.shopDoor;
      if (shop) svc.push({ x: shop.x, z: shop.z, label: 'Ski shop', kind: 'shop', what: 'Skis, boards and gear' });
      const H = busRoads.hospital;
      if (H) svc.push({ x: H.ex ?? H.x, z: H.ez ?? H.z, label: 'Medical centre', kind: 'med', what: 'Hospital' });
      const PD = window.__game?.prison?.door;
      if (PD) svc.push({ x: PD.x, z: PD.z, label: 'Police / Prison', kind: 'police', what: 'Police station' });
      const ink = { med: '#b01810', police: '#1f3fa8' };
      for (const m of svc) this.icon({ kind: m.kind, x: X(m.x), y: Z(m.z), r: IR, prio: 2, alpha: fadeIn(s, 0.045), wx: m.x, wz: m.z, label: m.label,
        tip: { title: m.label, lines: [m.what] }, lab: s >= 0.18 ? m.label : null, labo: { size: 14, color: ink[m.kind] || '#1f5fd6', prio: 3, alpha: fadeIn(s, 0.18) } });
      // the landmarks you have found (the Adlertor, the Försterweg...)
      for (const m of mk.secrets || []) this.icon({ kind: 'secret', x: X(m.x), y: Z(m.z), r: IR - 1, prio: 4, alpha: fadeIn(s, 0.07), wx: m.x, wz: m.z, label: m.label,
        tip: { title: m.label, lines: ['Landmark · found'] }, lab: s >= 0.3 ? m.label : null, labo: { size: 14, color: '#8a6200', prio: 4 } });
    }
    if (this.on('jobs')) for (const m of mk.jobs || []) {
      const x = X(m.x), y = Z(m.z);
      if (m.kind === 'search') {
        if (!this.inView(x, y, 200)) continue;
        g.strokeStyle = GOLD; g.lineWidth = 2; g.setLineDash([5, 4]);
        g.beginPath(); g.arc(x, y, Math.max(8, (m.r || 30) * s), 0, Math.PI * 2); g.stroke(); g.setLineDash([]);
        this.spot(x, y, Math.max(8, (m.r || 30) * s), m.x, m.z, m.label || 'Search area', { tip: { title: m.label || 'Search area', lines: ['Job · search here'] } });
      } else if (m.kind === 'board') this.icon({ kind: 'board', x, y, r: IR - 1.5, prio: 7, alpha: fadeIn(s, 0.12), wx: m.x, wz: m.z, label: m.label || 'Job board',
        tip: { title: m.label || 'Job board', lines: ['Job board'] }, lab: s >= 0.5 ? m.label : null, labo: { size: 13, weight: 600, color: '#6a3d17', prio: 10 } });
      else this.icon({ kind: 'job', x, y, r: IR, prio: 0.6, wx: m.x, wz: m.z, label: m.label || 'Job', tip: { title: m.label || 'Job', lines: ['Job target'] },
        lab: m.label || null, labo: { size: 14, color: '#9a6a00', prio: 1 } });
    }
    // what you own (game/ownertags.js, hosted by the car rental): your car (gold; grey while impounded) and the
    // helicopter you rented, waiting out on the mountain
    if (this.on('mine')) {
      let mine = [];
      try { mine = window.__game?.carRental?.ownerTags?.mapMarkers?.() || []; } catch { mine = []; }
      for (const m of mine) {
        if (m.kind === 'chalet') continue;
        const kind = m.kind === 'impound' ? 'impound' : m.kind === 'heli' ? 'myheli' : 'mycar';
        this.icon({ kind, x: X(m.x), y: Z(m.z), r: IR, prio: 0.7, wx: m.x, wz: m.z, label: m.label,
          tip: { title: m.label, lines: [kind === 'impound' ? 'Impounded · at the police station' : kind === 'myheli' ? 'Your helicopter' : 'Your car'] },
          lab: m.label, labo: { size: 13.5, weight: 700, color: kind === 'impound' ? '#4a5263' : '#8a6a00', prio: 1 } });
      }
    }
  }

  // the place you marked: its name (the breathing red ring is drawLive's)
  drawTarget() {
    const t = this.target;
    if (!t) return;
    const x = this.X(t.x), y = this.Z(t.z);
    if (!this.inView(x, y, 0)) return;
    this.reserve(x, y, 16);
    this.label(`MARKED · ${t.label}`, x, y, { size: 14, color: RED, prio: -1, force: true, cands: [[0, -27, 'center'], [0, 27, 'center'], [21, 0, 'left'], [-21, 0, 'right']] });
  }

  /** You: a big red arrow in a white halo (Oct 30 2026, the user: "always easy to find"); heading in radians on the map. */
  arrow(g, x, y, ang, k = 1) {
    g.save();
    g.translate(x, y);
    g.beginPath(); g.arc(0, 0, 17 * k, 0, Math.PI * 2);
    g.fillStyle = 'rgba(255,255,255,0.82)'; g.fill();
    g.lineWidth = 1.5; g.strokeStyle = 'rgba(226,35,26,0.55)'; g.stroke();
    g.rotate(ang);
    g.scale(k, k);
    g.shadowColor = 'rgba(8,20,60,0.4)'; g.shadowBlur = 4; g.shadowOffsetY = 1;
    g.fillStyle = RED; g.strokeStyle = '#fff'; g.lineWidth = 2.5; g.lineJoin = 'round';
    g.beginPath(); g.moveTo(14, 0); g.lineTo(-9, -10); g.lineTo(-4, 0); g.lineTo(-9, 10); g.closePath(); g.stroke(); g.fill();
    g.restore();
  }

  drawPlayer(now) {
    const g = this.g, p = this.player, x = this.X(p.pos.x), y = this.Z(p.pos.z);
    const m = 20, ex = Math.min(this.W - m, Math.max(m, x)), ey = Math.min(this.H - m, Math.max(m, y));
    g.save();
    if (ex !== x || ey !== y) {
      // off the map: an arrow at the edge pointing to you
      g.translate(ex, ey);
      g.rotate(Math.atan2(y - ey, x - ex));
      g.fillStyle = RED; g.strokeStyle = '#fff'; g.lineWidth = 2.5; g.lineJoin = 'round';
      g.beginPath(); g.moveTo(13, 0); g.lineTo(-9, -9); g.lineTo(-4, 0); g.lineTo(-9, 9); g.closePath(); g.stroke(); g.fill();
      g.restore();
      return;
    }
    const ph = (now / 1400) % 1; // a soft pulse, then the arrow in its halo (heading 0 = +z = down on the map)
    g.strokeStyle = `rgba(226,35,26,${0.55 * (1 - ph)})`; g.lineWidth = 2.5;
    g.beginPath(); g.arc(x, y, 17 + ph * 20, 0, Math.PI * 2); g.stroke();
    g.restore();
    this.arrow(g, x, y, Math.atan2(Math.cos(p.heading), Math.sin(p.heading)));
    this.reserve(x, y, 17);
  }

  drawScale() {
    const s = this.view.s, steps = [50, 100, 200, 250, 500, 1000, 2000, 2500, 5000];
    let m = steps[0];
    for (const v of steps) if (v * s <= 190) m = v;
    this.$scale.firstElementChild.style.width = `${Math.round(m * s)}px`;
    this.$scale.lastElementChild.textContent = m >= 1000 ? `${m / 1000} km` : `${m} m`;
  }
}
