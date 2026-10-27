// Front-end menus over the live 3D world:
//   Main (PLAY · STATS · SETTINGS · QUIT) -> mode cards (FREE RIDE · RACE · WORLD RACING)
//   -> race setup (course + AI difficulty) / world-racing setup (course + PB + medal)
//   -> character select: MAN or WOMAN on the 3D showcase (main.js renders the skier) -> START,
// plus stats, settings and the in-game pause menu.
// House style: white paint-brush strokes with blue italic condensed lettering.
// Every size is expressed in the CSS unit --u (1u = 1px on a 1280x800 canvas, see style.css),
// so each screen fits anything from 1024x640 up to 2880x1800 without overflowing.
import { save, writeSave, resetSave, skiById } from '../game/economy.js';
import { QUALITY_ORDER, QUALITY_LABELS, normalizeQuality } from '../engine/quality.js';
import { fmtTime, CONTROLS, keysHTML } from './hud.js';
import { SECRET_LIST } from '../world/secrets/list.js';
import { PLAYER_CHARACTERS } from '../game/characters.js';

// ------------------------------------------------------------------ brush art

/** Deterministic pseudo-random sequence for the hand-painted shapes. */
export function rng(seed) {
  let s = seed * 9301 + 49297;
  return () => ((s = (s * 233280 + 49297) % 2147483647) / 2147483647);
}

/**
 * Vertical band (fractions of the stroke height) a label's ink must stay inside. The stroke body is
 * solid paint from edge to edge everywhere left of brushTextEnd(); this band only keeps the letters
 * clear of the gently wavy top and bottom edges (they never come closer than 0.157 / 0.843).
 */
export const TEXT_BAND = [0.2, 0.8];

const TAIL_NOTCH = 0.16; // max depth of the valleys between bristle fingers (x tail length)
const tailLength = (w, h) => Math.min(w * 0.24, h * 0.62);

/** Fraction of the stroke width where the bristle tail begins: labels must end before it. */
export function brushTextEnd(w = 420, h = 96) {
  return (w - tailLength(w, h) * (1 + TAIL_NOTCH)) / w;
}

const n1 = (v) => v.toFixed(1);

// smooth curve through a polyline whose first point is the current pen position
function smoothTo(P) {
  let s = '';
  for (let i = 1; i < P.length - 1; i++) {
    s += ` Q${n1(P[i][0])},${n1(P[i][1])} ${n1((P[i][0] + P[i + 1][0]) / 2)},${n1((P[i][1] + P[i + 1][1]) / 2)}`;
  }
  const L = P[P.length - 1];
  return `${s} L${n1(L[0])},${n1(L[1])}`;
}

/**
 * A paint stroke as an inline SVG (stretched to its box with preserveAspectRatio="none").
 * Blunt left start, gently wobbling edges and a bristle tail fanning out on the right.
 * The body is ONE solid shape: no dry-brush slits, streaks or loose hairs anywhere, so nothing can
 * ever run through a label. The brush character lives only in the silhouette (wavy edges, uneven
 * bristle fingers), and the valleys between the fingers stop right of brushTextEnd().
 * @param {number} seed  shape seed (same seed = same stroke)
 * @param {number} w, h  viewBox size; keep the aspect close to the element's box
 * @param {{fill?: string, cls?: string}} [opt]
 */
export function brushSVG(seed = 1, w = 420, h = 96, opt = {}) {
  const fill = opt.fill || '#fff';
  const cls = opt.cls || 'brush';
  const r = rng(seed);
  r();
  const tail = tailLength(w, h);
  const x1 = w - tail; // bristles start here
  const xa = Math.min(h * 0.16, w * 0.06); // blunt left cap meets the long edges here
  const ph = [r() * 6.283, r() * 6.283, r() * 6.283, r() * 6.283];
  const top = (x) => h * 0.12 + Math.sin((x / w) * 5.1 + ph[0]) * h * 0.022 + Math.sin((x / w) * 12.7 + ph[1]) * h * 0.011;
  const bot = (x) => h * 0.88 + Math.sin((x / w) * 4.3 + ph[2]) * h * 0.022 + Math.sin((x / w) * 11.3 + ph[3]) * h * 0.011;

  // long edges, sampled left -> right (jitter is tiny: the edge never approaches the text band)
  const N = Math.max(8, Math.round((x1 - xa) / (h * 0.42)));
  const T = [], B = [];
  for (let i = 0; i <= N; i++) {
    const x = xa + ((x1 - xa) * i) / N;
    T.push([x, top(x) + (r() - 0.5) * h * 0.008]);
    B.push([x, bot(x) + (r() - 0.5) * h * 0.008]);
  }

  // outline, clockwise on screen: top edge -> bristle tail -> bottom edge -> blunt cap
  let d = `M${n1(T[0][0])},${n1(T[0][1])}${smoothTo(T)}`;
  const yT = T[N][1], yB = B[N][1];
  // bristle tail: 8-12 fingers of uneven width and length; the valleys between them stay shallow
  // (at most TAIL_NOTCH x tail), i.e. always right of the label limit
  const F = 8 + Math.floor(r() * 5);
  const wts = [];
  let sum = 0;
  for (let k = 0; k < F; k++) { const v = 0.45 + r() * 1.1; wts.push(v); sum += v; }
  let y0 = yT, acc = 0;
  for (let k = 0; k < F; k++) {
    acc += wts[k];
    const y1 = k === F - 1 ? yB : yT + ((yB - yT) * acc) / sum;
    const ym = y0 + (y1 - y0) * (0.35 + r() * 0.3);
    const outer = k === 0 || k === F - 1;
    const len = tail * (outer ? 0.25 + r() * 0.35 : 0.3 + r() * 0.7);
    const tipX = Math.min(w - 1, x1 + len);
    d += ` Q${n1(x1 + len * 0.55)},${n1(y0 + (ym - y0) * 0.25)} ${n1(tipX)},${n1(ym)}`;
    if (k < F - 1) {
      const notch = x1 - tail * TAIL_NOTCH * r();
      d += ` Q${n1(x1 + len * 0.45)},${n1(y1 - (y1 - ym) * 0.35)} ${n1(notch)},${n1(y1)}`;
    } else d += ` Q${n1(x1 + len * 0.5)},${n1(y1 - (y1 - ym) * 0.25)} ${n1(x1)},${n1(yB)}`;
    y0 = y1;
  }
  B.reverse();
  d += smoothTo(B);
  const capX = h * (0.015 + r() * 0.03);
  const capY = h * (0.5 + (r() - 0.5) * 0.06);
  d += ` Q${n1(capX + h * 0.02)},${n1(h * 0.86)} ${n1(capX)},${n1(capY)}`;
  d += ` Q${n1(capX + h * 0.02)},${n1(h * 0.14)} ${n1(T[0][0])},${n1(T[0][1])} Z`;

  return `<svg class="${cls}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}" fill="${fill}"/></svg>`;
}

/**
 * Ragged hand-painted silhouette for panels and cards, as a CSS polygon().
 * Perpendicular raggedness is in --u so it looks the same on any panel size.
 * Use as an inline custom property: style="--clip:${brushClip(seed)}" (applied by the ::before paper).
 */
export function brushClip(seed = 1, amp = 6, side = 4) {
  const r = rng(seed + 7);
  r();
  const u = (v) => `calc(var(--u) * ${v.toFixed(1)})`;
  const NX = 14, NY = 5, pts = [];
  for (let i = 0; i <= NX; i++) pts.push(`${((i / NX) * 100).toFixed(1)}% ${u(r() * amp)}`);
  for (let j = 1; j < NY; j++) pts.push(`calc(100% - ${u(r() * side)}) ${((j / NY) * 100).toFixed(1)}%`);
  for (let i = NX; i >= 0; i--) pts.push(`${((i / NX) * 100).toFixed(1)}% calc(100% - ${u(r() * amp)})`);
  for (let j = NY - 1; j >= 1; j--) pts.push(`${u(r() * side)} ${((j / NY) * 100).toFixed(1)}%`);
  return `polygon(${pts.join(', ')})`;
}

export const MEDALS = ['gold', 'silver', 'bronze'];

/** CSS-drawn medal (ribbon + embossed disc). size in u; 'none' renders an empty dashed ring. */
export function medalHTML(medal, size = 48, extra = '') {
  const m = MEDALS.includes(medal) ? medal : 'none';
  const num = m === 'none' ? '' : `<b>${MEDALS.indexOf(m) + 1}</b>`;
  const cls = `medal ${m}${size < 36 ? ' sm' : ''}${extra ? ' ' + extra : ''}`;
  return `<span class="${cls}" style="--s:${size}"><i class="m-ribbon"></i><i class="m-disc">${num}</i></span>`;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Restart a CSS animation class on an element. */
export function replay(el, cls) {
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

const seedOf = (str) => [...String(str)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 9973, 17);
const pad2 = (v) => String(v).padStart(2, '0');
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const fmtMoney = (v) => (v || 0).toLocaleString('en-US');
const fmtLen = (m) => (!Number.isFinite(m) ? '—' : m >= 1000 ? `${(m / 1000).toFixed(1)}<small>KM</small>` : `${Math.round(m)}<small>M</small>`);
const ORD = (n) => (n % 100 >= 11 && n % 100 <= 13 ? 'TH' : ['TH', 'ST', 'ND', 'RD'][n % 10] || 'TH');
const diffKey = (d) => String(d || '').toLowerCase();
// piste-style difficulty mark: green circle / blue square / black diamond
const diffSign = (d) => `<i class="diff-sign ${esc(diffKey(d))}"></i>`;

// ------------------------------------------------------------------ mode card art (photo fallback)
// Poster-style scenes: natural ridgelines (midpoint displacement), every peak split into a lit and
// a shaded face along a jagged fall line (sun from the upper right), horizon haze for depth.

let artUid = 0;

const polyPath = (pts) => `M${pts.map(([x, y]) => `${n1(x)} ${n1(y)}`).join(' L')} Z`;
const SUB = 16; // ridge points per key segment (4 midpoint subdivisions)

// dense jagged polyline through key points [[x, y], ...] (x ascending)
function ridgeLine(keys, rough, r) {
  let pts = keys.map((p) => [p[0], p[1]]);
  let amp = rough;
  for (let it = 0; it < 4; it++) {
    const next = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
      next.push([(ax + bx) / 2 + (r() - 0.5) * (bx - ax) * 0.25, (ay + by) / 2 + (r() - 0.5) * amp], [bx, by]);
    }
    pts = next;
    amp *= 0.55;
  }
  return pts;
}

function ridgeY(P, x) {
  for (let i = 0; i < P.length - 1; i++) {
    if (x >= P[i][0] && x <= P[i + 1][0]) return P[i][1] + ((P[i + 1][1] - P[i][1]) * (x - P[i][0])) / (P[i + 1][0] - P[i][0] || 1);
  }
  return P[P.length - 1][1];
}

/** A mountain range: lit silhouette down to `base`, plus the shaded west face of every peak key. */
function range(keys, { rough = 9, base = 200, lit, shade, seed = 1 }) {
  const r = rng(seed);
  const P = ridgeLine(keys, rough, r);
  let out = `<path d="${polyPath([...P, [P[P.length - 1][0], base], [P[0][0], base]])}" fill="${lit}"/>`;
  for (let k = 1; k < keys.length - 1; k++) {
    if (!(keys[k][1] < keys[k - 1][1] && keys[k][1] < keys[k + 1][1])) continue; // peaks only
    const [ax, ay] = P[k * SUB];
    // the shadow edge runs diagonally down to the right (a wedge), never past the next valley
    const fall = [], cap = keys[k + 1][0] - 2;
    for (let j = 1; j <= 8; j++) {
      let fy = ay + ((base - ay) * j) / 8, fx = ax + (fy - ay) * 0.55;
      const capped = fx >= cap;
      if (capped) { fx = cap; fy = ay + (cap - ax) / 0.55; } // reached the next valley: close from here
      fx += j < 8 && !capped ? (r() - 0.5) * 4 : 0;
      fall.push([fx, Math.max(fy, ridgeY(P, fx) + 0.8)]); // stays under the ridge
      if (capped) break;
    }
    // the crease with the neighbour on the left slants down-left from the valley (no vertical seam)
    const [vx, vy] = P[(k - 1) * SUB];
    const crease = [];
    for (let j = 8; j >= 1; j--) {
      const cy = vy + ((base - vy) * j) / 8;
      const cx = vx - (cy - vy) * 0.3 + (j < 8 ? (r() - 0.5) * 3 : 0);
      crease.push([cx, Math.max(cy, ridgeY(P, cx) + 0.8)]);
    }
    out += `<path d="${polyPath([...P.slice((k - 1) * SUB, k * SUB + 1), ...fall, ...crease])}" fill="${shade}"/>`;
  }
  return out;
}

// three-tier spruce silhouette standing on (x, y), height s
function pine(x, y, s, c) {
  const at = (dx, f) => `${n1(x + s * dx)} ${n1(y - s * f)}`;
  return `<path d="M${at(0, 1)} L${at(0.2, 0.7)} L${at(0.12, 0.7)} L${at(0.3, 0.42)} L${at(0.18, 0.42)} L${at(0.38, 0.1)} L${at(0.05, 0.1)} L${at(0.05, 0)}`
    + ` L${at(-0.05, 0)} L${at(-0.05, 0.1)} L${at(-0.38, 0.1)} L${at(-0.18, 0.42)} L${at(-0.3, 0.42)} L${at(-0.12, 0.7)} L${at(-0.2, 0.7)} Z" fill="${c}"/>`;
}

// a band of trees between x0 and x1 around baseline y (drawn back to front)
function forest(x0, x1, y, count, s0, s1, colors, seed) {
  const r = rng(seed);
  const trees = [];
  for (let i = 0; i < count; i++) trees.push([x0 + r() * (x1 - x0), y + (r() - 0.5) * 8, s0 + r() * (s1 - s0), colors[i % colors.length]]);
  trees.sort((a, b) => a[1] - b[1]);
  return trees.map(([tx, ty, ts, c]) => pine(tx, ty, ts, c)).join('');
}

// small alpine chalet: timber body, snowy roof with a shaded half, warm windows
function chalet(x, y, s) {
  const p = (dx, dy) => `${n1(x + s * dx)} ${n1(y - s * dy)}`;
  return `<path d="M${p(-0.5, 0)} L${p(-0.5, 0.48)} L${p(0.5, 0.48)} L${p(0.5, 0)} Z" fill="#6b4632"/>`
    + `<path d="M${p(-0.66, 0.42)} L${p(0, 0.92)} L${p(0.66, 0.42)} L${p(0.6, 0.36)} L${p(0, 0.82)} L${p(-0.6, 0.36)} Z" fill="#f7faff"/>`
    + `<path d="M${p(-0.66, 0.42)} L${p(0, 0.92)} L${p(0, 0.82)} L${p(-0.6, 0.36)} Z" fill="#cbd9f0"/>`
    + `<rect x="${n1(x - s * 0.3)}" y="${n1(y - s * 0.34)}" width="${n1(s * 0.16)}" height="${n1(s * 0.14)}" fill="#ffd27a"/>`
    + `<rect x="${n1(x + s * 0.14)}" y="${n1(y - s * 0.34)}" width="${n1(s * 0.16)}" height="${n1(s * 0.14)}" fill="#ffd27a"/>`;
}

// slalom gate on the snow: soft shadow, two poles, a panel
function gate(x, y, s, col) {
  return `<ellipse cx="${n1(x + s * 0.32)}" cy="${n1(y + s * 0.03)}" rx="${n1(s * 0.5)}" ry="${n1(s * 0.07)}" fill="#c9d7ee"/>`
    + `<path d="M${n1(x)} ${n1(y)} V${n1(y - s)} M${n1(x + s * 0.64)} ${n1(y)} V${n1(y - s)}" stroke="#20304d" stroke-width="${n1(Math.max(0.8, s * 0.07))}"/>`
    + `<rect x="${n1(x)}" y="${n1(y - s)}" width="${n1(s * 0.64)}" height="${n1(s * 0.48)}" fill="${col}"/>`;
}

// canyon wall: a vertical jagged inner edge (keys [[y, x], ...]) closed against the side `sideX`
function wall(keys, sideX, fill, rim, seed) {
  const r = rng(seed);
  const edge = ridgeLine(keys, 7, r).map(([y, x]) => [x, y]);
  const shifted = edge.map(([x, y]) => [x + (sideX < 0 ? -3 : 3), y]).reverse();
  const top = edge[0][1], bottom = edge[edge.length - 1][1];
  return `<path d="${polyPath([[sideX, top], ...edge, [sideX, bottom]])}" fill="${fill}"/>`
    + `<path d="${polyPath([...edge, ...shifted])}" fill="${rim}"/>`;
}

const grad = (id, stops, vertical = true) => `<linearGradient id="${id}" x1="0" y1="0" x2="${vertical ? 0 : 1}" y2="${vertical ? 1 : 0}">${stops.map(([o, c, a = 1]) => `<stop offset="${o}" stop-color="${c}" stop-opacity="${a}"/>`).join('')}</linearGradient>`;

/** Illustrated scene shown behind each mode card (the photo, when present, fades in over it). */
function modeArt(id) {
  const u = ++artUid;
  const svg = (defs, body) => `<svg class="mc-svg" viewBox="0 0 320 196" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><defs>${defs}</defs>${body}</svg>`;
  if (id === 'race') {
    // race day: a steep groomed course with gates and safety netting under a deep blue sky
    const course = [[34, 106, 7, '#e5352b'], [70, 116, 8.5, '#1f5fe0'], [96, 131, 10.5, '#e5352b'], [140, 143, 13, '#1f5fe0'], [160, 164, 16.5, '#e5352b'], [214, 178, 21, '#1f5fe0']];
    return svg(
      grad(`rs${u}`, [[0, '#0b3593'], [0.6, '#3a74db'], [1, '#a8c7f4']])
      + grad(`rh${u}`, [[0, '#ffffff', 0], [0.2, '#ffffff', 0.1], [0.4, '#ffffff', 0.3], [0.6, '#ffffff', 0.44], [1, '#ffffff', 0.5]])
      + grad(`rf${u}`, [[0, '#ffffff'], [1, '#e6eef9']]),
      `<rect width="320" height="196" fill="url(#rs${u})"/>`
      + range([[-10, 92], [26, 70], [58, 86], [100, 48], [140, 78], [184, 40], [224, 72], [262, 56], [300, 80], [330, 66]], { lit: '#e6eefb', shade: '#a9bfe3', seed: 11, rough: 8 })
      + `<rect y="60" width="320" height="136" fill="url(#rh${u})"/>`
      + range([[-10, 108], [44, 94], [96, 110]], { lit: '#f4f8fe', shade: '#b8cbe9', seed: 12, rough: 5 })
      + `<path d="M-10 102 C 70 98, 150 110, 226 138 S 304 174, 330 180 V 196 H -10 Z" fill="url(#rf${u})"/>`
      + `<path d="M-10 128 C 50 124, 110 140, 152 168 S 186 196, 190 196 H -10 Z" fill="#dce6f6"/>`
      + forest(-6, 30, 110, 7, 9, 15, ['#1d3e5e', '#24507a'], 13)
      + `<path d="M 30 101 C 90 104, 150 122, 214 150 S 292 188, 314 196" fill="none" stroke="#ff7a1a" stroke-width="1.5" stroke-dasharray="5 3"/>`
      + `<path d="M 22 112 C 60 118, 92 126, 120 140 S 176 168, 212 196" fill="none" stroke="#c3d3ee" stroke-width="1.2"/>`
      + course.map(([x, y, s, c]) => gate(x, y, s, c)).join(''),
    );
  }
  if (id === 'trial') {
    // world racing: a moonlit ice canyon under the aurora, the course glowing down the middle
    const r = rng(77);
    let stars = '';
    for (let i = 0; i < 30; i++) stars += `<circle cx="${n1(r() * 320)}" cy="${n1(r() * 74)}" r="${n1(0.35 + r() * 0.85)}" fill="#ffffff" opacity="${(0.3 + r() * 0.55).toFixed(2)}"/>`;
    return svg(
      grad(`ws${u}`, [[0, '#040d28'], [0.55, '#10306f'], [1, '#3a70c8']])
      + grad(`wa${u}`, [[0, '#5ff2d6', 0], [0.45, '#5ff2d6', 0.5], [1, '#7fb6ff', 0]], false)
      + grad(`wh${u}`, [[0, '#9cc4ff', 0], [0.2, '#9cc4ff', 0.08], [0.4, '#9cc4ff', 0.22], [0.6, '#9cc4ff', 0.33], [1, '#9cc4ff', 0.38]])
      + grad(`wi${u}`, [[0, '#b9d0f6'], [1, '#f2f7ff']]),
      `<rect width="320" height="196" fill="url(#ws${u})"/>${stars}`
      + `<path d="M-10 58 C 60 24, 140 70, 200 38 S 300 24, 330 42 L 330 60 C 282 48, 222 84, 160 72 S 40 60, -10 84 Z" fill="url(#wa${u})"/>`
      + range([[-10, 96], [36, 64], [76, 86], [120, 46], [158, 38], [196, 70], [238, 50], [282, 80], [330, 58]], { lit: '#d3e2fb', shade: '#7f9dd3', seed: 21, rough: 8 })
      + `<rect y="70" width="320" height="126" fill="url(#wh${u})"/>`
      + `<path d="M96 196 C 126 160, 146 138, 156 110 L 168 110 C 178 138, 196 160, 228 196 Z" fill="url(#wi${u})"/>`
      + wall([[52, 36], [92, 60], [130, 78], [166, 96], [202, 116]], -12, '#122f69', '#3d6fc8', 22)
      + wall([[58, 286], [96, 264], [132, 248], [168, 230], [202, 210]], 332, '#163a7e', '#5286dc', 23)
      + `<path d="M162 112 C 170 130, 150 146, 160 164 S 178 186, 168 200" fill="none" stroke="#9fd8ff" stroke-width="5" stroke-linecap="round" opacity=".3"/>`
      + `<path d="M162 112 C 170 130, 150 146, 160 164 S 178 186, 168 200" fill="none" stroke="#ffffff" stroke-width="1.6" stroke-linecap="round"/>`,
    );
  }
  // free ride: a sunny morning over the resort, forest, chalets and fresh tracks
  return svg(
    grad(`fs${u}`, [[0, '#2a66d0'], [0.58, '#83b5ee'], [1, '#dbeafb']])
    + `<radialGradient id="fg${u}" cx=".8" cy=".14" r=".55"><stop offset="0" stop-color="#fffbe6" stop-opacity=".95"/><stop offset=".3" stop-color="#fff2c2" stop-opacity=".38"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>`
    + grad(`fh${u}`, [[0, '#ffffff', 0], [0.2, '#ffffff', 0.1], [0.4, '#ffffff', 0.3], [0.6, '#ffffff', 0.47], [1, '#ffffff', 0.55]])
    + grad(`ff${u}`, [[0, '#ffffff'], [1, '#e7eef9']]),
    `<rect width="320" height="196" fill="url(#fs${u})"/><rect width="320" height="196" fill="url(#fg${u})"/>`
    + range([[-10, 108], [30, 88], [64, 100], [106, 64], [142, 88], [180, 50], [218, 82], [256, 70], [292, 92], [330, 80]], { lit: '#e9f1fc', shade: '#bfd0ec', seed: 31, rough: 9 })
    + `<rect y="78" width="320" height="118" fill="url(#fh${u})"/>`
    + range([[-10, 138], [34, 112], [76, 128], [120, 104], [160, 126], [204, 100], [248, 124], [290, 108], [330, 122]], { lit: '#f8fbff', shade: '#b4c8e7', seed: 32, rough: 7 })
    + forest(-8, 128, 150, 26, 7, 13, ['#1b3a58', '#23496e', '#1f4163'], 33)
    + forest(236, 330, 148, 18, 7, 13, ['#1b3a58', '#23496e', '#1f4163'], 34)
    + chalet(178, 156, 15) + chalet(200, 152, 12)
    + `<path d="M-10 196 V 160 C 60 150, 140 154, 210 160 S 300 168, 330 164 V 196 Z" fill="url(#ff${u})"/>`
    + `<path d="M138 196 C 148 186, 126 178, 144 170 S 166 160, 156 152" fill="none" stroke="#a9bfe2" stroke-width="1.4"/>`
    + `<path d="M148 196 C 160 186, 138 178, 156 170 S 178 160, 168 152" fill="none" stroke="#a9bfe2" stroke-width="1.1"/>`,
  );
}

// mode photos (public/ui/mode-*.jpg) are optional: preload once, fade in over the illustration
const photoState = new Map(); // url -> 'ok' | 'fail' | 'loading'
function loadPhotos(root) {
  root.querySelectorAll('.mc-photo[data-img]').forEach((ph) => {
    const url = ph.dataset.img;
    const apply = () => { ph.style.backgroundImage = `url("${url}")`; ph.classList.add('loaded'); };
    const st = photoState.get(url);
    if (st === 'ok') return apply();
    if (st === 'fail') return;
    photoState.set(url, 'loading');
    const img = new Image();
    img.onload = () => { photoState.set(url, 'ok'); apply(); };
    img.onerror = () => photoState.set(url, 'fail');
    img.src = url;
  });
}

// ------------------------------------------------------------------ data

const MODES = [
  { id: 'free', title: 'FREE RIDE', kicker: 'OPEN WORLD', desc: 'Ski the open resort at your own pace.', img: './ui/mode-free.jpg' },
  { id: 'race', title: 'RACE', kicker: 'VS 14 AI RACERS', desc: 'Beat 14 AI rivals to the finish line.', img: './ui/mode-race.jpg' },
  { id: 'trial', title: 'WORLD RACING', kicker: 'TIME TRIAL', desc: 'Chase your ghost, splits and medals.', img: './ui/mode-world.jpg' },
];

const DIFFS = [{ id: 'easy', label: 'EASY' }, { id: 'medium', label: 'MEDIUM' }, { id: 'hard', label: 'HARD' }];

// used only if main.js provides no getCourses() hook
const FALLBACK_COURSES = [
  { id: 'alpine', name: 'Legacy World Downhill', tagline: 'The classic: long, fast and wide open.', difficulty: 'Medium' },
  { id: 'icecanyon', name: 'Ice Canyon', tagline: 'Frozen gorge, bridges, a tunnel and a lake.', difficulty: 'Hard' },
  { id: 'bigair', name: 'Big Air Line', tagline: 'Kickers, tabletops and rollers. Style pays.', difficulty: 'Easy' },
];

// the player characters: MAN and WOMAN (game/characters.js). No names and no stats: both ski exactly the
// same, and every look comes from the ski shop
function normalizeCharacters(list) {
  const src = Array.isArray(list) && list.length ? list : PLAYER_CHARACTERS;
  return src.map((c) => ({ id: c.id, label: String(c.label || c.body || c.id).toUpperCase() }));
}

// last menu choices (per viewer convenience; game progress lives in the save)
const PREFS_KEY = 'ski-legacy-menu';
function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {}; } catch { return {}; }
}
function savePrefs(p) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* storage unavailable */ }
}

// keyboard -> menu action (arrows + WASD navigate, Enter/Space confirm, Esc/Backspace go back)
const KEYMAP = {
  ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
  Enter: 'enter', NumpadEnter: 'enter', Space: 'enter', Escape: 'back', Backspace: 'back',
};

const KEYCAPS = {
  updown: '<i class="kc kc-arrow up"></i><i class="kc kc-arrow down"></i>',
  leftright: '<i class="kc kc-arrow left"></i><i class="kc kc-arrow right"></i>',
  enter: '<i class="kc">ENTER</i>',
  esc: '<i class="kc">ESC</i>',
};
const hintsHTML = (list) => list.map(([k, label]) => `<span class="hint"${/back/i.test(label) ? ' data-hint-back style="cursor:pointer;pointer-events:auto"' : ''}>${KEYCAPS[k] || ''}<em>${label}</em></span>`).join(''); // (ESC · BACK is clickable)

// ------------------------------------------------------------------ menu

export class Menu {
  /**
   * @param {object} o
   * @param {Array<{id, body?, label?}>} o.characters  the player characters to choose from (MAN, WOMAN)
   * @param {(sel: {mode: 'free'|'race'|'trial', courseId: string|null, difficulty: 'easy'|'medium'|'hard', character: string}) => void} o.onStart
   * @param {(charId: string|null) => void} [o.onShowcase]  show / swap / remove the 3D showcase skier
   * @param {(deltaYaw: number) => void} [o.onShowcaseSpin]  drag on the showcase turns the skier (radians)
   * @param {() => Array<{id, name, tagline, difficulty, length, drop, par?, medals?, record?: {best, medal}}>} [o.getCourses]
   * @param {() => void} [o.onMainMenu]  pause menu -> MAIN MENU (can also be given to showPause)
   * @param {() => void} [o.onPlay]  legacy: called when onStart is not provided
   */
  constructor(o = {}) {
    this.el = document.getElementById('menu');
    this.audio = o.audio;
    this.characters = o.characters;
    this.chars = normalizeCharacters(o.characters);
    this.onStart = o.onStart;
    this.onShowcase = o.onShowcase;
    this.onShowcaseSpin = o.onShowcaseSpin;
    this.getCourses = o.getCourses;
    this.onMainMenu = o.onMainMenu;
    this.onPlay = o.onPlay;
    this.onQuality = o.onQuality;
    this.onSens = o.onSens;
    this.onVolume = o.onVolume;
    this.prefs = loadPrefs();
    this.sel = {
      mode: MODES.some((m) => m.id === this.prefs.mode) ? this.prefs.mode : 'free',
      difficulty: DIFFS.some((d) => d.id === this.prefs.difficulty) ? this.prefs.difficulty : 'medium',
      courseId: null,
    };
    this.ready = false;
    this.load = { f: 0, t: 'Loading world' };
    this.inGame = false;
    this.screen = null;
    this.cur = null; // { name, def, el }
    this.focusables = [];
    this.fi = -1;
    this.chi = 0;
    this.courses = [];
    this.courseIdx = 0;
    this.showcaseOn = false;
    this.starting = false;
    this.built = false;
  }

  // persistent chrome: shades, logo, screen stage, footer with key hints
  ensureChrome() {
    if (this.built && this.stage?.isConnected) return;
    this.el.innerHTML = `
      <div class="menu-shades"><div class="shade shade-left"></div><div class="shade shade-full"></div><div class="shade shade-show"></div></div>
      <div class="menu-logo"><div class="ml-ski">SKI</div><div class="ml-legacy">LEGACY</div></div>
      <div class="menu-mark"><b>SKI</b><span>LEGACY</span></div>
      <div class="menu-stage"></div>
      <div class="menu-foot"><div class="menu-hints"></div><div class="menu-credit">Icecold Studio · Made with Claude</div></div>`;
    this.stage = this.el.querySelector('.menu-stage');
    this.hintsEl = this.el.querySelector('.menu-hints');
    this.hintsEl.addEventListener('click', (e) => { if (e.target.closest('[data-hint-back]')) this.back(false); });
    if (this.built) return;
    this.built = true;
    // capture phase: the menu owns the keyboard while it is visible (game input never sees these keys)
    this.downKeys = new Set();
    addEventListener('keydown', (e) => this.onKey(e), true);
    addEventListener('keyup', (e) => this.downKeys.delete(e.code), true);
    addEventListener('blur', () => this.downKeys.clear());
  }

  /** Main menu (out of game). Also used to come back from the pause menu's MAIN MENU. */
  show() {
    this.ensureChrome();
    clearTimeout(this.hideT);
    this.el.hidden = false;
    this.el.classList.remove('leaving', 'paused');
    document.body.classList.add('menu-open');
    this.inGame = false;
    this.starting = false;
    this.pauseHandlers = null;
    this.go('main', 0);
  }

  hide() {
    this.leaveShowcase();
    clearTimeout(this.hideT);
    this.el.classList.add('leaving');
    this.hideT = setTimeout(() => {
      this.el.hidden = true;
      this.el.classList.remove('leaving');
      document.body.classList.remove('menu-open');
    }, 500);
  }

  setLoading(f, text) {
    this.load = { f, t: text };
    const t = this.el.querySelector('.menu-screen.current .spin-text');
    if (t) t.textContent = text;
  }

  setReady() {
    this.ready = true;
    // the buttons sweep in once the world is ready
    if (!this.el.hidden && this.cur?.name === 'main') this.go('main', 0);
  }

  // In-game pause (Esc): same brush look over the frozen world.
  // handlers: { onResume, onMainMenu?, onRestart?, onVillage?, onQuit? } (buttons appear per handler)
  showPause(handlers = {}) {
    this.ensureChrome();
    clearTimeout(this.hideT);
    this.pauseHandlers = handlers;
    this.inGame = true;
    this.starting = false; // Esc right after START: the pause menu must respond at once
    this.el.hidden = false;
    this.el.classList.remove('leaving');
    this.el.classList.add('paused');
    document.body.classList.add('menu-open');
    this.go('pause', 0);
  }

  hidePause() {
    this.el.hidden = true;
    this.el.classList.remove('paused');
    document.body.classList.remove('menu-open');
  }

  /**
   * Where main.js should stand the showcase skier: the middle of the free area right of the panel,
   * in normalized screen coordinates (x 0..1 from the left, y 0..1 from the top).
   */
  showcaseAnchor() {
    const W = innerWidth || 1, H = innerHeight || 1;
    const el = this.cur?.name === 'showcase' ? this.cur.el : null;
    const panel = el?.querySelector('.sc-panel')?.getBoundingClientRect();
    if (panel && panel.width > 0) {
      const left = panel.right, right = W * 0.96;
      return { x: (left + right) / 2 / W, y: 0.56, left: left / W, right: 0.96, height: H };
    }
    return { x: 0.68, y: 0.56, left: 0.4, right: 0.96, height: H };
  }

  // ---------------------------------------------------------------- screens

  btn(label, act, seed, cls = '') {
    return `<button class="brush-btn ${cls}" data-act="${act}" data-f data-stagger tabindex="-1">${brushSVG(seed)}<span>${esc(label)}</span></button>`;
  }

  // screen title: a brush strip sized to its text, with an optional white subtitle
  head(title, sub) {
    const w = Math.round(Math.min(760, 150 + title.length * 26));
    return `<div class="menu-head">
        <div class="menu-title" data-stagger style="width:calc(var(--u) * ${Math.round(w * 0.9)})">${brushSVG(seedOf(title), w, 100)}<span>${esc(title)}</span></div>
        ${sub ? `<div class="menu-sub" data-stagger>${esc(sub)}</div>` : ''}
      </div>`;
  }

  buildScreen(name) {
    switch (name) {
      case 'mode': return this.scrMode();
      case 'race': case 'trial': return this.scrCourses(name);
      case 'showcase': return this.scrShowcase();
      case 'controls': return this.scrControls();
      case 'stats': return this.scrStats();
      case 'settings': return this.scrSettings();
      case 'pause': return this.scrPause();
      default: return this.scrMain();
    }
  }

  scrMain() {
    if (!this.ready) {
      return { logo: 'big', shade: 'left', hints: [], html: `<div class="menu-col">
        <div class="menu-spinner"><div class="spin"></div><div class="spin-text">${esc(this.load.t)}</div></div></div>` };
    }
    return {
      logo: 'big', shade: 'left', hints: [['updown', 'Select'], ['enter', 'Confirm']],
      html: `<div class="menu-col">${this.btn('PLAY', 'play', 3, 'big')}${this.btn('CONTROLS', 'controls', 31)}${this.btn('STATS', 'stats', 7)}`
        + `${this.btn('SETTINGS', 'settings', 11)}${this.btn('QUIT', 'quit', 13, 'small')}</div>`,
    };
  }

  // keyboard reference: three white panels (on the snow / in the air / general)
  scrControls() {
    const panels = CONTROLS.map((g, i) => `<div class="menu-panel ctl-panel" data-stagger style="--clip:${brushClip(170 + i, 5, 4)}">
        <div class="mp-head">${esc(g.title)}</div>
        ${g.rows.map(([keys, label, sub]) => `<div class="ctl-row"><span class="ctl-keys">${keysHTML(keys)}</span>`
          + `<span class="ctl-do">${esc(label)}${sub ? `<small>${esc(sub)}</small>` : ''}</span></div>`).join('')}
        ${g.note ? `<div class="ctl-note">${esc(g.note)}</div>` : ''}
      </div>`).join('');
    return {
      logo: 'small', shade: 'full', hints: [['esc', 'Back']],
      html: `${this.head('CONTROLS', 'Keyboard and mouse')}<div class="ctl-wrap">${panels}</div>`,
      back: () => this.go(this.inGame ? 'pause' : 'main', -1),
    };
  }

  scrMode() {
    const cards = MODES.map((m, i) => `
      <button class="mode-card" data-act="mode:${m.id}" data-f data-stagger tabindex="-1" style="--clip:${brushClip(40 + i * 3, 7, 5)}">
        <span class="mc-art" style="--clip:${brushClip(61 + i * 5, 3, 3)}">${modeArt(m.id)}<span class="mc-photo" data-img="${m.img}"></span><span class="mc-shine"></span><span class="mc-num">${pad2(i + 1)}</span></span>
        <span class="mc-body"><span class="mc-kicker">${m.kicker}</span><span class="mc-title">${m.title}</span><span class="mc-desc">${m.desc}</span></span>
        <span class="mc-bar"></span>
      </button>`).join('');
    return {
      logo: 'small', shade: 'full',
      hints: [['leftright', 'Select'], ['enter', 'Confirm'], ['esc', 'Back']],
      html: `${this.head('CHOOSE MODE', 'Three ways to ride the mountain')}
        <div class="mode-row">${cards}</div>`,
      focus: Math.max(0, MODES.findIndex((m) => m.id === this.sel.mode)),
      after: (el) => loadPhotos(el),
      back: () => this.go('main', -1),
    };
  }

  fetchCourses() {
    let list = null;
    try { list = this.getCourses?.(); } catch (e) { console.warn('getCourses failed', e); }
    if (!Array.isArray(list) || !list.length) list = FALLBACK_COURSES.map((c) => ({ ...c, record: save.records?.[c.id] || null }));
    return list;
  }

  courseRow(c, i, kind) {
    const rec = c.record || {};
    const side = kind === 'trial'
      ? `<span class="cr-rec">${Number.isFinite(rec.best) ? `<b>${fmtTime(rec.best)}</b>` : '<em>NO TIME</em>'}${medalHTML(rec.medal, 32)}</span>`
      : `<span class="cr-diff">${diffSign(c.difficulty)}<em>${esc(String(c.difficulty || '').toUpperCase())}</em></span>`;
    return `<button class="course-row${i === this.courseIdx ? ' sel' : ''}" tabindex="-1" data-act="course:${i}" data-stagger style="--clip:${brushClip(120 + i * 7, 4, 3)}">
        <span class="cr-num">${pad2(i + 1)}</span>
        <span class="cr-main"><b class="cr-name">${esc(c.name)}</b><small class="cr-tag">${esc(c.tagline || '')}</small></span>
        ${side}</button>`;
  }

  courseDetail(c, kind) {
    const rec = c.record || {};
    const cells = [
      ['LENGTH', fmtLen(c.length)],
      ['DROP', Number.isFinite(c.drop) ? `${Math.round(c.drop)}<small>M</small>` : '—'],
      ['LEVEL', `${diffSign(c.difficulty)}${esc(String(c.difficulty || '—').toUpperCase())}`],
    ];
    if (Number.isFinite(c.par)) cells.push(['PAR TIME', fmtTime(c.par)]);
    // race: best finishing place (+ podium medal); world racing: personal best time (+ time medal)
    const place = Number(rec.bestRace);
    const best = kind === 'race'
      ? (place > 0
        ? `<div class="cd-best"><span class="cd-label">BEST FINISH</span><b>${place}<small>${ORD(place)}</small></b>${medalHTML(rec.raceMedal, 46)}</div>`
        : '<div class="cd-best none"><span class="cd-label">BEST FINISH</span><em>No race finished yet</em></div>')
      : Number.isFinite(rec.best)
        ? `<div class="cd-best"><span class="cd-label">PERSONAL BEST</span><b>${fmtTime(rec.best)}</b>${medalHTML(rec.medal, 46)}</div>`
        : '<div class="cd-best none"><span class="cd-label">PERSONAL BEST</span><em>No time set yet</em></div>';
    const medals = kind === 'trial' && c.medals
      ? `<div class="cd-medals">${MEDALS.filter((m) => Number.isFinite(c.medals[m])).map((m) => `<span>${medalHTML(m, 24)}<b>${fmtTime(c.medals[m])}</b></span>`).join('')}</div>`
      : '';
    return `<div class="cd-kicker">${kind === 'trial' ? 'WORLD RACING' : 'RACE'} · COURSE ${pad2(this.courseIdx + 1)}</div>
      <div class="cd-name">${esc(c.name)}</div>
      <div class="cd-tag">${esc(c.tagline || '')}</div>
      <div class="cd-grid">${cells.map(([k, v]) => `<div class="cd-cell"><span class="cd-label">${k}</span><b>${v}</b></div>`).join('')}</div>
      ${best}${medals}`;
  }

  scrCourses(kind) {
    const race = kind === 'race';
    this.courses = this.fetchCourses();
    const want = this.prefs.course?.[kind];
    this.courseIdx = Math.max(0, this.courses.findIndex((c) => c.id === want));
    this.sel.courseId = this.courses[this.courseIdx]?.id ?? null;
    const sel = this.courses[this.courseIdx];
    const diff = race ? `<div class="setup-label">AI DIFFICULTY</div>
        <div class="seg-brush" data-stagger>${DIFFS.map((d) => `<button tabindex="-1" data-act="diff:${d.id}" class="${this.sel.difficulty === d.id ? 'on' : ''}">${d.label}</button>`).join('')}</div>` : '';
    return {
      logo: 'small', shade: 'left',
      hints: race ? [['updown', 'Course'], ['leftright', 'Difficulty'], ['enter', 'Continue'], ['esc', 'Back']]
        : [['updown', 'Course'], ['enter', 'Continue'], ['esc', 'Back']],
      html: `${this.head(race ? 'RACE' : 'WORLD RACING', race ? 'Fifteen racers, one course. First across the line wins.' : 'Time trial against the ghost of your personal best.')}
        <div class="setup">
          <div class="setup-col">
            <div class="setup-label">COURSE</div>
            <div class="course-list${this.courses.length > 3 ? ' scroll' : ''}">${this.courses.map((c, i) => this.courseRow(c, i, kind)).join('')}</div>
            ${diff}
            <div class="setup-actions">${this.btn('CONTINUE', 'continue', 17, 'mid')}</div>
          </div>
          <div class="course-detail" data-stagger style="--clip:${brushClip(77, 6, 4)}">${sel ? this.courseDetail(sel, kind) : ''}</div>
        </div>`,
      // Enter presses the highlighted button (CONTINUE unless the mouse moved the highlight to BACK)
      keys: {
        up: () => this.selectCourse(this.courseIdx - 1),
        down: () => this.selectCourse(this.courseIdx + 1),
        left: () => (race ? this.stepDifficulty(-1) : this.selectCourse(this.courseIdx - 1)),
        right: () => (race ? this.stepDifficulty(1) : this.selectCourse(this.courseIdx + 1)),
      },
      back: () => this.go('mode', -1),
    };
  }

  selectCourse(i, silent = false) {
    const list = this.courses, el = this.cur?.el;
    if (!list.length || !el) return;
    i = ((i % list.length) + list.length) % list.length;
    const changed = i !== this.courseIdx;
    this.courseIdx = i;
    this.sel.courseId = list[i].id;
    const kind = this.cur.name;
    this.prefs.course = { ...(this.prefs.course || {}), [kind]: list[i].id };
    savePrefs(this.prefs);
    el.querySelectorAll('.course-row').forEach((row, j) => row.classList.toggle('sel', j === i));
    el.querySelector('.course-row.sel')?.scrollIntoView?.({ block: 'nearest' });
    const det = el.querySelector('.course-detail');
    if (det && changed) { det.innerHTML = this.courseDetail(list[i], kind); replay(det, 'swap'); }
    if (!silent && changed) this.audio?.play('tick');
  }

  setDifficulty(id, silent = false) {
    if (!DIFFS.some((d) => d.id === id)) return;
    const changed = id !== this.sel.difficulty;
    this.sel.difficulty = id;
    this.prefs.difficulty = id;
    savePrefs(this.prefs);
    this.cur?.el.querySelectorAll('.seg-brush [data-act^="diff:"]').forEach((b) => b.classList.toggle('on', b.dataset.act === `diff:${id}`));
    if (!silent && changed) this.audio?.play('tick');
  }

  stepDifficulty(d) {
    const i = DIFFS.findIndex((x) => x.id === this.sel.difficulty);
    this.setDifficulty(DIFFS[Math.max(0, Math.min(DIFFS.length - 1, i + d))].id);
  }

  modeLine() {
    const m = this.sel.mode;
    if (m === 'free') return 'Free ride · the open resort';
    const c = this.courses.find((x) => x.id === this.sel.courseId);
    const name = c ? c.name : '';
    if (m === 'race') return `Race · ${name} · ${cap(this.sel.difficulty)} AI`;
    return `World racing · ${name}`;
  }

  // Character select: MAN or WOMAN. main.js stands the chosen skier in 3D (ski stance, dressed as equipped)
  // in the free area on the right; the panel only holds the two choices: every look is bought in the ski
  // shop, and nothing differs in how they ski (no names, no stats).
  scrShowcase() {
    this.chi = Math.max(0, this.chars.findIndex((c) => c.id === save.character));
    const picks = this.chars.map((c, i) => `<button class="${i === this.chi ? 'on' : ''}" tabindex="-1" data-act="pick:${i}">${esc(c.label)}</button>`).join('');
    const spin = typeof this.onShowcaseSpin === 'function';
    return {
      logo: 'small', shade: 'show',
      hints: [['leftright', 'Man / woman'], ['enter', 'Start'], ['esc', 'Back'], ...(spin ? [['', 'Drag to rotate']] : [])],
      html: `${spin ? '<div class="sc-drag" aria-hidden="true"></div>' : ''}${this.head('CHOOSE YOUR SKIER', this.modeLine())}
        <div class="sc-panel" data-stagger style="--clip:${brushClip(140, 6, 4)}">
          <div class="seg-brush sc-pick">${picks}</div>
          <div class="sc-note">Customize your look in the ski shop: jackets, trousers, helmets and goggles.</div>
        </div>
        <div class="sc-actions">${this.btn('START', 'start', 17, 'big')}</div>`,
      after: (el) => {
        // drag across the free area to turn the 3D skier (main.js applies the yaw)
        const drag = el.querySelector('.sc-drag');
        if (drag) {
          let lastX = null;
          drag.addEventListener('pointerdown', (e) => { lastX = e.clientX; drag.setPointerCapture?.(e.pointerId); drag.classList.add('dragging'); });
          drag.addEventListener('pointermove', (e) => {
            if (lastX === null) return;
            this.onShowcaseSpin?.((e.clientX - lastX) * 0.012);
            lastX = e.clientX;
          });
          const end = () => { lastX = null; drag.classList.remove('dragging'); };
          drag.addEventListener('pointerup', end);
          drag.addEventListener('pointercancel', end);
        }
      },
      // left / right pick MAN / WOMAN; Enter presses the highlighted button (START by default)
      keys: { left: () => this.pickChar(this.chi - 1), right: () => this.pickChar(this.chi + 1), up: () => {}, down: () => {} },
      back: () => this.go(this.sel.mode === 'free' ? 'mode' : this.sel.mode, -1),
    };
  }

  // MAN / WOMAN (left / right keys stop at the ends, like the difficulty switch)
  pickChar(i, silent = false) {
    const n = this.chars.length;
    if (!n || this.cur?.name !== 'showcase') return;
    i = Math.max(0, Math.min(n - 1, i));
    if (i === this.chi) return;
    this.chi = i;
    const c = this.chars[i];
    save.character = c.id; // written to disk on START
    const btns = [...this.cur.el.querySelectorAll('.sc-pick [data-act^="pick:"]')];
    btns.forEach((b, j) => b.classList.toggle('on', j === i));
    if (btns[i]) replay(btns[i], 'kick');
    if (this.showcaseOn) this.onShowcase?.(c.id);
    if (!silent) this.audio?.play('tick');
  }

  enterShowcase() {
    this.showcaseOn = true;
    this.onShowcase?.(this.chars[this.chi]?.id ?? null);
  }

  leaveShowcase() {
    if (!this.showcaseOn) return;
    this.showcaseOn = false;
    this.onShowcase?.(null);
  }

  start() {
    const c = this.chars[this.chi];
    if (this.starting || !c) return;
    this.starting = true;
    save.character = c.id;
    writeSave();
    savePrefs(this.prefs);
    const mode = this.sel.mode;
    const payload = { mode, courseId: mode === 'free' ? null : this.sel.courseId, difficulty: this.sel.difficulty, character: c.id };
    // the showcase skier stays until main.js hides the menu (hide() calls onShowcase(null)),
    // so it never pops out before a transition has covered the screen
    if (this.onStart) this.onStart(payload);
    else this.onPlay?.(payload);
    // if main.js did not take us out of the menu, re-arm START instead of locking it forever
    setTimeout(() => { this.starting = false; }, 1500);
  }

  scrStats() {
    const st = save.stats;
    const ski = save.skis ? skiById(save.skis)?.name || '—' : 'None yet';
    const rows = [
      ['Money', `$${fmtMoney(save.money)}`], ['Races won', `${st.wins} / ${st.races}`],
      ['Top speed', `${Math.round(st.topSpeed * 3.6)} km/h`],
      ['Longest jump', st.longestJump >= 1 ? `${Math.round(st.longestJump)} m` : '—'], ['Biggest air', st.bestAir >= 0.1 ? `${st.bestAir.toFixed(1)} s` : '—'],
      ['Distance skied', `${(st.distance / 1000).toFixed(1)} km`],
      ['Secrets found', `${(save.secrets || []).filter((id) => SECRET_LIST.some((q) => q.id === id)).length} / ${SECRET_LIST.length}`],
      ['Prize money', `$${fmtMoney(st.earned)}`], ['Skis', ski], ['Day', String(save.day)],
    ];
    const recs = this.fetchCourses().map((c) => {
      const r = c.record || {};
      return `<div class="mp-row"><span class="mp-name">${esc(c.name)}</span><span class="mp-rec">${Number.isFinite(r.best) ? `<b>${fmtTime(r.best)}</b>` : '<em>No time</em>'}${medalHTML(r.medal, 28)}</span></div>`;
    }).join('');
    return {
      logo: 'small', shade: 'left', hints: [['esc', 'Back']],
      html: `${this.head('STATS', 'Your career on the mountain')}
        <div class="stats-wrap">
          <div class="menu-panel" data-stagger style="--clip:${brushClip(150, 5, 4)}"><div class="mp-head">CAREER</div>
            ${rows.map(([k, v]) => `<div class="mp-row"><span>${k}</span><b>${esc(v)}</b></div>`).join('')}</div>
          <div class="menu-panel" data-stagger style="--clip:${brushClip(151, 5, 4)}"><div class="mp-head">WORLD RACING RECORDS</div>${recs}</div>
        </div>`,
      back: () => this.go(this.inGame ? 'pause' : 'main', -1),
    };
  }

  scrSettings() {
    const qs = QUALITY_ORDER; // performance, balanced, high, ultra (engine/quality.js)
    const q = normalizeQuality(save.quality) || 'high';
    this.pendingQ = q;
    return {
      logo: 'small', shade: 'left',
      hints: [['updown', 'Select'], ['leftright', 'Adjust'], ['enter', 'Apply'], ['esc', 'Back']],
      html: `${this.head('SETTINGS', 'Performance runs smoothest on laptops · changing the graphics restarts the game')}
        <div class="menu-panel settings" data-stagger style="--clip:${brushClip(160, 5, 4)}">
          <div class="mp-row" data-f data-row="quality"><span>Graphics</span><div class="seg">${qs.map((x) => `<button tabindex="-1" data-q="${x}" class="${q === x ? 'on' : ''}">${QUALITY_LABELS[x]}</button>`).join('')}</div></div>
          <div class="mp-row" data-f data-row="sens"><span>Mouse sensitivity</span><input class="m-sens" type="range" min="0.3" max="2.5" step="0.1" value="${save.sensitivity}"></div>
          <div class="mp-row" data-f data-row="vol"><span>Volume</span><input class="m-vol" type="range" min="0" max="1" step="0.05" value="${save.volume ?? 0.8}"></div>
          <div class="mp-row" data-f data-row="reset"><span>Progress</span><button class="mp-danger" tabindex="-1">Reset all progress</button></div>
        </div>`,
      after: (el) => this.bindSettings(el),
      keys: { left: () => this.adjustSetting(-1), right: () => this.adjustSetting(1), enter: () => this.activateSetting() },
      back: () => this.go(this.inGame ? 'pause' : 'main', -1),
    };
  }

  bindSettings(el) {
    el.querySelectorAll('[data-q]').forEach((b) => b.addEventListener('click', () => {
      this.audio?.play('click');
      if (b.dataset.q !== save.quality) this.onQuality?.(b.dataset.q);
    }));
    const sens = el.querySelector('.m-sens'), vol = el.querySelector('.m-vol');
    sens.addEventListener('input', () => this.onSens?.(parseFloat(sens.value)));
    vol.addEventListener('input', () => { save.volume = parseFloat(vol.value); writeSave(); this.onVolume?.(save.volume); });
    // sliders give the keyboard back to the menu once released
    for (const s of [sens, vol]) s.addEventListener('change', () => s.blur());
    const reset = el.querySelector('.mp-danger');
    reset.addEventListener('click', () => {
      this.audio?.play('click');
      if (reset.dataset.confirm) resetSave();
      else { reset.dataset.confirm = '1'; reset.textContent = 'Click again to confirm'; }
    });
  }

  adjustSetting(d) {
    const row = this.focusables[this.fi];
    const kind = row?.dataset.row;
    if (kind === 'quality') {
      const bs = [...row.querySelectorAll('[data-q]')];
      const qs = bs.map((b) => b.dataset.q);
      const i = Math.max(0, Math.min(qs.length - 1, qs.indexOf(this.pendingQ) + d));
      this.pendingQ = qs[i];
      bs.forEach((b) => b.classList.toggle('pending', b.dataset.q === this.pendingQ && this.pendingQ !== save.quality));
      this.audio?.play('tick');
    } else if (kind === 'sens' || kind === 'vol') {
      const inp = row.querySelector('input');
      const step = parseFloat(inp.step) || 0.1;
      const v = Math.min(parseFloat(inp.max), Math.max(parseFloat(inp.min), parseFloat(inp.value) + d * step));
      inp.value = String(Math.round(v * 100) / 100);
      inp.dispatchEvent(new Event('input'));
      this.audio?.play('tick');
    }
  }

  activateSetting() {
    const row = this.focusables[this.fi];
    const kind = row?.dataset.row;
    if (kind === 'quality') { if (this.pendingQ && this.pendingQ !== save.quality) this.onQuality?.(this.pendingQ); }
    else if (kind === 'reset') row.querySelector('.mp-danger').click();
    else if (row?.dataset.act) row.click();
  }

  scrPause() {
    const h = this.pauseHandlers || {};
    const items = [['RESUME', 'resume', 'big']];
    if (h.onRestart) items.push(['RESTART', 'restart']);
    items.push(['CONTROLS', 'controls']);
    // at most 7 rows: STATS gives way when both RESTART and RETURN TO VILLAGE are offered
    if (!(h.onRestart && h.onVillage)) items.push(['STATS', 'stats']);
    items.push(['SETTINGS', 'settings']);
    if (h.onMainMenu || this.onMainMenu) items.push(['MAIN MENU', 'mainmenu']);
    if (h.onVillage) items.push(['RETURN TO VILLAGE', 'village', 'wide']);
    items.push(['QUIT GAME', 'quit', 'small']);
    const seeds = { resume: 5, restart: 29, controls: 31, stats: 7, settings: 11, mainmenu: 23, village: 19, quit: 13 };
    const roomy = items.length <= 5;
    return {
      logo: roomy ? 'big' : 'small', shade: 'left', cls: roomy ? '' : 'tight',
      hints: [['updown', 'Select'], ['enter', 'Confirm'], ['esc', 'Resume']],
      html: `<div class="menu-col compact">${items.map(([l, a, c]) => this.btn(l, a, seeds[a], c || '')).join('')}</div>`,
      back: () => this.action('resume'),
    };
  }

  // ---------------------------------------------------------------- navigation

  /** Switch screens with a slide/fade (dir 1 = forward, -1 = back, 0 = crossfade). */
  go(name, dir = 1) {
    this.ensureChrome();
    const def = this.buildScreen(name);
    this.screen = name;
    this.el.dataset.screen = name;
    this.el.dataset.shade = def.shade || 'left';
    this.el.classList.toggle('logo-big', def.logo === 'big');
    this.hintsEl.innerHTML = hintsHTML(def.hints || []);

    this.stage.querySelectorAll('.menu-screen.exit').forEach((s) => s.remove());
    const prev = this.stage.querySelector('.menu-screen.current');
    const el = document.createElement('div');
    el.className = `menu-screen scr-${name}${def.cls ? ' ' + def.cls : ''}`;
    el.style.setProperty('--dir', String(dir));
    el.innerHTML = def.html;
    el.querySelectorAll('[data-stagger]').forEach((x, i) => { x.style.animationDelay = `${70 + i * 60}ms`; });
    this.stage.appendChild(el);
    if (prev) {
      prev.classList.remove('current');
      prev.style.setProperty('--dir', String(dir));
      prev.classList.add('exit');
      prev.inert = true;
      setTimeout(() => prev.remove(), 450);
    }
    el.classList.add('enter');
    void el.offsetWidth; // apply the start state so the slide-in transitions
    el.classList.remove('enter');
    el.classList.add('current');

    this.cur = { name, def, el };
    this.bindScreen(el);
    def.after?.(el);
    this.fi = -1;
    this.setFocus(def.focus ?? 0, true);
    // the 3D showcase skier follows the character screen
    if (name === 'showcase') this.enterShowcase();
    else this.leaveShowcase();
  }

  bindScreen(el) {
    this.focusables = [...el.querySelectorAll('[data-f]')];
    this.focusables.forEach((b, i) => b.addEventListener('mouseenter', () => this.setFocus(i)));
    el.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => {
      if (b.disabled || !el.classList.contains('current') || this.starting) return;
      this.audio?.play('click');
      this.action(b.dataset.act, true);
    }));
    // buttons never take DOM focus: the menu handles the keyboard itself
    el.addEventListener('mousedown', (e) => { if (e.target.closest?.('button')) e.preventDefault(); });
  }

  setFocus(i, silent = false) {
    const list = this.focusables, n = list.length;
    if (!n) { this.fi = -1; return; }
    i = ((i % n) + n) % n;
    if (i === this.fi) return;
    list.forEach((b, j) => b.classList.toggle('is-focus', j === i));
    this.fi = i;
    if (!silent) this.audio?.play('tick');
  }

  moveFocus(d) {
    const n = this.focusables.length;
    if (!n) return;
    let i = Math.max(0, this.fi);
    for (let k = 0; k < n; k++) {
      i = (i + d + n) % n;
      if (!this.focusables[i].disabled) break;
    }
    this.setFocus(i);
  }

  back(sound = true) {
    const b = this.cur?.def.back;
    if (!b) return;
    if (sound) this.audio?.play('click');
    b();
  }

  onKey(e) {
    if (this.el.hidden || !this.cur?.el.isConnected || this.el.classList.contains('leaving')) return;
    const a = KEYMAP[e.code];
    if (!a) return;
    // a slider the mouse is still holding keeps its own arrow keys
    if (document.activeElement?.tagName === 'INPUT' && (a === 'left' || a === 'right')) return;
    e.preventDefault();
    e.stopPropagation();
    // START was pressed: main.js is taking us into the game (a transition may be covering the
    // screen), so the menu must not navigate away underneath it
    if (this.starting) return;
    // auto-repeat only counts for keys pressed while the menu is open (a steering key still held
    // from gameplay must not spin the focus), and never for confirm / back
    if (!e.repeat) this.downKeys.add(e.code);
    else if (!this.downKeys.has(e.code) || a === 'enter' || a === 'back') return;
    const keys = this.cur.def.keys || {};
    if (keys[a]) { keys[a](); return; }
    if (a === 'up' || a === 'left') this.moveFocus(-1);
    else if (a === 'down' || a === 'right') this.moveFocus(1);
    else if (a === 'enter') {
      const b = this.focusables[this.fi];
      if (b && !b.disabled) b.click();
    } else if (a === 'back') this.back();
  }

  action(act, fromClick = false) {
    const [a, arg] = String(act).split(':');
    switch (a) {
      case 'play': return this.go('mode', 1);
      case 'controls': return this.go('controls', 1);
      case 'stats': return this.go('stats', 1);
      case 'settings': return this.go('settings', 1);
      case 'back': return this.back(!fromClick);
      case 'mode':
        if (!MODES.some((m) => m.id === arg)) return undefined;
        this.sel.mode = arg;
        this.prefs.mode = arg;
        savePrefs(this.prefs);
        return this.go(arg === 'free' ? 'showcase' : arg, 1);
      case 'course': return this.selectCourse(Number(arg), fromClick);
      case 'diff': return this.setDifficulty(arg, fromClick);
      case 'continue': return this.courses.length ? this.go('showcase', 1) : undefined;
      case 'pick': return this.pickChar(Number(arg), fromClick);
      case 'start': return this.start();
      case 'resume': return this.pauseHandlers?.onResume?.();
      case 'restart': return this.pauseHandlers?.onRestart?.();
      case 'mainmenu': return (this.pauseHandlers?.onMainMenu || this.onMainMenu)?.();
      case 'village': return this.pauseHandlers?.onVillage?.();
      case 'quit':
        this.pauseHandlers?.onQuit?.();
        return window.close();
      default: return undefined;
    }
  }
}
