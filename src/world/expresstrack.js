// The Legacy Express's fixed installations along the ring of expressroute.js: the double track (ballast on the open
// line, slab track on the viaducts and in the tunnels), the overhead line (masts, cantilevers, contact and messenger
// wires over both tracks), the tunnels (lined double-track tubes with walkways and lamps, modern concrete portals
// with name plates, the terrain clip volumes behind them), the viaducts (concrete box girders on tapered piers down
// to the natural ground; split piers on the tallest) and the stations
// (expressstations.js).
//
// 69 km is far too much to build up front. Everything is an entity that is built when the viewer comes within its
// build range (nearest first, within a few ms per frame), shown within its view range and disposed again past its
// drop range:
//   bed     250 m of ballast / track slab                       built within 2.4 km
//   detail  rails, sleepers (instanced), overhead line, tunnel lining + lamps (the lining only drawn from inside
//           a tunnel or near a portal)                           built within 800 m
//   bridge  a whole viaduct (the showpieces: seen from far)      built within 7.5 km
//   portal  one tunnel mouth                                      built within 4 km
//   station a stop (platforms, the station building, boards)   built within 3.2 km
// The few things that must exist everywhere at once (pier and station colliders, walkable platform / deck surfaces,
// the terrain clip volumes) are plain data, made up front.
//
//   const track = buildExpressTrack(scene, { models, colliders, cameraBlockers })
//   every frame: track.update(camera.position, { inTunnel })   (inTunnel: the viewer rides through a tunnel;
//                                                                optional, else it is guessed from the ground)
//   dusk:        track.setNight(n) (0 day .. 1 night)  /  track.setDay(k) (1 day .. 0 night)
import * as THREE from 'three';
import { world } from './world.js';
import { layout, PISTE_WIDTH, onPiste } from './layout.js';
import { EXPRESS, LENGTH, expressAt, TRACK_OFF, TUBE_H, PORTAL_IN, ringDelta } from './expressroute.js';
import { freeCourses } from '../modes/parkour/freeworld.js';
import { RailBuilder, railMaterials, canvasTex, mouthFade } from './railtrack.js';
import { setTerrainClipSet, terrainClipFocus } from './terrain.js';
import { smoothstep, mulberry32 } from '../core/noise.js';
import { planExpressStations, buildExpressStation } from './expressstations.js';
import { solidifyIdle } from './solidify.js';

const CHUNK = 250;
const GAUGE = 1.0;              // (the Wolkenspitzbahn's railcar: metre gauge)
export const DECK = 0.55;       // top of rail -> the viaduct deck's / tunnel floor's top
const SLAB = 0.25;              // top of rail -> top of the track slab (viaducts, tunnels, the hall)
const BALLAST_TOP = 0.30;       // top of rail -> top of the ballast
const MAST_LAT = TRACK_OFF + 3.1, WIRE_Y = 5.2, MESS_Y = 6.5, MAST_EVERY = 54;
// tube: half width, springline, crown (the shaper keeps 3 m of ground over TUBE_H, its walls at TUBE_W = 6.4)
export const TW = 5.7, TS = 2.6, TC = TUBE_H;
const WALK = 4.3, WALK_Y = 0.25, FLOOR_Y = -0.62;
const R = {
  bed: { buildR: 2400, visR: 2200, dropR: 3000 },
  detail: { buildR: 820, visR: 720, dropR: 1100 },
  bridge: { buildR: 7500, visR: 7000, dropR: 9000 },
  portal: { buildR: 4000, visR: 3600, dropR: 5000 },
  station: { buildR: 3200, visR: 3000, dropR: 4000 },
};

// ------------------------------------------------------------------ frame + spans
const _p = { x: 0, y: 0, z: 0, dx: 0, dz: 1, grade: 0, i: 0 };
/** Frame of the line at s: position (top of rail, centre line), unit tangent (with the grade), horizontal right. */
export function expressFrame(s, out = {}) {
  expressAt(s, _p);
  const l = Math.hypot(1, _p.grade);
  out.x = _p.x; out.y = _p.y; out.z = _p.z;
  out.tx = _p.dx / l; out.ty = _p.grade / l; out.tz = _p.dz / l;
  out.rx = -_p.dz; out.rz = _p.dx;
  out.heading = Math.atan2(_p.dx, _p.dz);
  out.grade = _p.grade;
  return out;
}
const frame = expressFrame;
// the parts of the spans of `list` ({ s0, s1 }; s0 < 0 over the seam) that overlap [a, b] (0 <= a < b <= LENGTH):
// { a, b, t, s0, s1 } with the span shifted round the ring to where it overlaps
function spansIn(list, a, b) {
  const out = [];
  for (const t of list) for (const k of [0, LENGTH, -LENGTH]) {
    const s0 = t.s0 + k, s1 = t.s1 + k;
    if (s1 > a && s0 < b) out.push({ a: Math.max(a, s0), b: Math.min(b, s1), t, s0, s1 });
  }
  return out;
}
// arc lengths from s0 to s1 about `step` apart, both ends exact (neighbouring pieces share their end rings)
function samples(s0, s1, step) {
  const n = Math.max(1, Math.ceil((s1 - s0) / step - 1e-6)), out = [];
  for (let k = 0; k <= n; k++) out.push(k === n ? s1 : s0 + ((s1 - s0) * k) / n);
  return out;
}

// ------------------------------------------------------------------ builder
// RailBuilder (vertex colours, optional uv / light) plus raw linear colours and quads that wind themselves to face
// along their first vertex's normal (the sections below are built in whatever order is handy)
const _col = new THREE.Color();
const LIN = new Map();
export function lin(hex) { let c = LIN.get(hex); if (!c) { _col.set(hex); c = [_col.r, _col.g, _col.b]; LIN.set(hex, c); } return c; }
export class XB extends RailBuilder {
  vc(x, y, z, nx, ny, nz, c, u = 0, w = 0, l0 = 0, l1 = 1) {
    this.P.push(x, y, z); this.N.push(nx, ny, nz); this.C.push(c[0], c[1], c[2]);
    if (this.U) this.U.push(u, w);
    if (this.L) this.L.push(l0, l1);
    return this.P.length / 3 - 1;
  }
  aq(a, b, c, d) {
    const P = this.P, N = this.N;
    const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
    let ux = P[b * 3] - ax, uy = P[b * 3 + 1] - ay, uz = P[b * 3 + 2] - az;
    const vx = P[c * 3] - ax, vy = P[c * 3 + 1] - ay, vz = P[c * 3 + 2] - az;
    let cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (cx * cx + cy * cy + cz * cz < 1e-12) { // (a degenerate first triangle: judge by the second)
      ux = P[d * 3] - ax; uy = P[d * 3 + 1] - ay; uz = P[d * 3 + 2] - az;
      cx = vy * uz - vz * uy; cy = vz * ux - vx * uz; cz = vx * uy - vy * ux;
    }
    if (cx * N[a * 3] + cy * N[a * 3 + 1] + cz * N[a * 3 + 2] >= 0) this.I.push(a, b, c, a, c, d);
    else this.I.push(a, c, b, a, d, c);
  }
  at(a, b, c) {
    const P = this.P, N = this.N;
    const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
    const ux = P[b * 3] - ax, uy = P[b * 3 + 1] - ay, uz = P[b * 3 + 2] - az, vx = P[c * 3] - ax, vy = P[c * 3 + 1] - ay, vz = P[c * 3 + 2] - az;
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (cx * N[a * 3] + cy * N[a * 3 + 1] + cz * N[a * 3 + 2] >= 0) this.I.push(a, b, c); else this.I.push(a, c, b);
  }
  // a flat quad p0..p3 (around its edge) facing away from `inside` (a point behind it), with uv in metres / us
  face(p0, p1, p2, p3, inside, c, us = 4) {
    const ex = p1[0] - p0[0], ey = p1[1] - p0[1], ez = p1[2] - p0[2], fx = p3[0] - p0[0], fy = p3[1] - p0[1], fz = p3[2] - p0[2];
    let nx = ey * fz - ez * fy, ny = ez * fx - ex * fz, nz = ex * fy - ey * fx;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    const mx = (p0[0] + p2[0]) / 2 - inside[0], my = (p0[1] + p2[1]) / 2 - inside[1], mz = (p0[2] + p2[2]) / 2 - inside[2];
    if (nx * mx + ny * my + nz * mz < 0) { nx = -nx; ny = -ny; nz = -nz; }
    // uv: planar, along the quad's own edges (formwork joints follow the faces)
    const le = Math.hypot(ex, ey, ez), lf = Math.hypot(fx, fy, fz);
    const a = this.vc(...p0, nx, ny, nz, c, 0, 0), b = this.vc(...p1, nx, ny, nz, c, le / us, 0);
    const cc = this.vc(...p2, nx, ny, nz, c, le / us, lf / us), d = this.vc(...p3, nx, ny, nz, c, 0, lf / us);
    this.aq(a, b, cc, d);
  }
  // a convex prism between two rings of points (same count, closed loops), flat sides, optional caps
  prism(r0, r1, c0, c1 = c0, { cap0 = false, cap1 = false, us = 4 } = {}) {
    const n = r0.length;
    const cx = (r0.reduce((s, p) => s + p[0], 0) + r1.reduce((s, p) => s + p[0], 0)) / (2 * n);
    const cy = (r0.reduce((s, p) => s + p[1], 0) + r1.reduce((s, p) => s + p[1], 0)) / (2 * n);
    const cz = (r0.reduce((s, p) => s + p[2], 0) + r1.reduce((s, p) => s + p[2], 0)) / (2 * n);
    let u = 0;
    for (let k = 0; k < n; k++) {
      const j = (k + 1) % n, a = r0[k], b = r0[j], c = r1[j], d = r1[k];
      const ex = b[0] - a[0], ez = b[2] - a[2], fx = d[0] - a[0], fy = d[1] - a[1], fz = d[2] - a[2], ey = b[1] - a[1];
      let nx = ey * fz - ez * fy, ny = ez * fx - ex * fz, nz = ex * fy - ey * fx;
      const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      const mx = (a[0] + c[0]) / 2 - cx, mz = (a[2] + c[2]) / 2 - cz;
      if (nx * mx + nz * mz < 0) { nx = -nx; ny = -ny; nz = -nz; }
      const le = Math.hypot(ex, ey, ez), h0 = 0, h1 = Math.hypot(fx, fy, fz);
      const i0 = this.vc(...a, nx, ny, nz, c0, u / us, h0 / us), i1 = this.vc(...b, nx, ny, nz, c0, (u + le) / us, h0 / us);
      const i2 = this.vc(...c, nx, ny, nz, c1, (u + le) / us, h1 / us), i3 = this.vc(...d, nx, ny, nz, c1, u / us, h1 / us);
      this.aq(i0, i1, i2, i3);
      u += le;
    }
    for (const [ring, on, up] of [[r0, cap0, -1], [r1, cap1, 1]]) {
      if (!on) continue;
      const m = ring.map((p) => this.vc(...p, 0, up, 0, up > 0 ? c1 : c0, p[0] / us, p[2] / us));
      const ctr = this.vc(ring.reduce((s, p) => s + p[0], 0) / n, ring.reduce((s, p) => s + p[1], 0) / n, ring.reduce((s, p) => s + p[2], 0) / n, 0, up, 0, up > 0 ? c1 : c0);
      for (let k = 0; k < n; k++) this.at(ctr, m[k], m[(k + 1) % n]);
    }
    void cy;
  }
  // an oriented box: centre, unit axes X (across), Z (along; Y = up unless given), half sizes
  obx(c, X, Z, hx, hy, hz, col, colTop = col, Y = [0, 1, 0]) {
    const P = (sx, sy, sz) => [c[0] + X[0] * hx * sx + Y[0] * hy * sy + Z[0] * hz * sz, c[1] + X[1] * hx * sx + Y[1] * hy * sy + Z[1] * hz * sz, c[2] + X[2] * hx * sx + Y[2] * hy * sy + Z[2] * hz * sz];
    const r0 = [P(-1, -1, -1), P(1, -1, -1), P(1, -1, 1), P(-1, -1, 1)], r1 = [P(-1, 1, -1), P(1, 1, -1), P(1, 1, 1), P(-1, 1, 1)];
    this.prism(r0, r1, col, col, { cap1: true });
    if (colTop !== col) { const n = this.C.length; for (let k = n - 15; k < n; k += 3) { this.C[k] = colTop[0]; this.C[k + 1] = colTop[1]; this.C[k + 2] = colTop[2]; } }
  }
  // a round bar from a to b
  rod(a, b, r, c, seg = 6) {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2], len = Math.hypot(dx, dy, dz);
    if (len < 1e-4) return;
    const t = [dx / len, dy / len, dz / len], up = Math.abs(t[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    let u = [t[1] * up[2] - t[2] * up[1], t[2] * up[0] - t[0] * up[2], t[0] * up[1] - t[1] * up[0]];
    const ul = Math.hypot(...u); u = u.map((v) => v / ul);
    const w = [t[1] * u[2] - t[2] * u[1], t[2] * u[0] - t[0] * u[2], t[0] * u[1] - t[1] * u[0]];
    const base = this.P.length / 3;
    for (let i = 0; i <= seg; i++) {
      const g = (i / seg) * Math.PI * 2, ca = Math.cos(g), sa = Math.sin(g);
      const nx = u[0] * ca + w[0] * sa, ny = u[1] * ca + w[1] * sa, nz = u[2] * ca + w[2] * sa;
      this.vc(a[0] + nx * r, a[1] + ny * r, a[2] + nz * r, nx, ny, nz, c);
      this.vc(b[0] + nx * r, b[1] + ny * r, b[2] + nz * r, nx, ny, nz, c);
    }
    for (let i = 0; i < seg; i++) { const k = base + i * 2; this.aq(k, k + 2, k + 3, k + 1); }
  }
}

// Sweep an open section along the line, flat shaded per edge. sec: [[x, y]...] (x right of the centre line + lat,
// y over the top of rail) listed clockwise (outward normal (-dy, dx)); cols: one per edge; uv: arc / us, s / vs.
function sweep(b, s0, s1, step, sec, cols, { lat = 0, us = 4, vs = 4, light = null } = {}) {
  const E = [];
  let arc = 0;
  for (let k = 0; k < sec.length - 1; k++) {
    const [x0, y0] = sec[k], [x1, y1] = sec[k + 1], dx = x1 - x0, dy = y1 - y0, l = Math.hypot(dx, dy);
    if (l > 1e-6) E.push({ x0, y0, x1, y1, nx: -dy / l, ny: dx / l, a0: arc, a1: arc + l, c: cols[Math.min(k, cols.length - 1)] });
    arc += l;
  }
  const f = {};
  let prev = null;
  for (const s of samples(s0, s1, step)) {
    frame(s, f);
    const cx = f.x + f.rx * lat, cz = f.z + f.rz * lat, ring = [];
    const l1 = light ? light(s) : 1;
    for (const e of E) {
      const nx = f.rx * e.nx, nz = f.rz * e.nx;
      ring.push(
        b.vc(cx + f.rx * e.x0, f.y + e.y0, cz + f.rz * e.x0, nx, e.ny, nz, e.c, e.a0 / us, s / vs, 0, l1),
        b.vc(cx + f.rx * e.x1, f.y + e.y1, cz + f.rz * e.x1, nx, e.ny, nz, e.c, e.a1 / us, s / vs, 0, l1),
      );
    }
    if (prev) for (let k = 0; k < E.length; k++) b.aq(prev[2 * k], prev[2 * k + 1], ring[2 * k + 1], ring[2 * k]);
    prev = ring;
  }
}

// ------------------------------------------------------------------ materials
let XM = null;
export function expressMaterials() {
  if (XM) return XM;
  const M = railMaterials();
  // fair-faced concrete: formwork panels (2.5 x 1.25 m) with their joints and tie holes, faint pour lines and
  // streaks under the edges (tile 5 m)
  const formTex = canvasTex(512, 512, (g, w, h) => {
    const rnd = mulberry32(4411);
    g.fillStyle = '#bdbab3'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 120; i++) {
      const x = rnd() * w, y = rnd() * h, r = 20 + rnd() * 60, gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, ['rgba(70,66,60,0.07)', 'rgba(255,255,255,0.08)', 'rgba(120,110,95,0.06)'][i % 3]); gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2);
    }
    for (let i = 0; i < 5000; i++) { g.fillStyle = rnd() < 0.5 ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.07)'; g.fillRect(rnd() * w, rnd() * h, 1.2, 1.2); }
    // panel joints: 2 across, 4 up per tile
    g.fillStyle = 'rgba(40,38,34,0.28)';
    for (let k = 0; k <= 2; k++) g.fillRect((k * w) / 2 - 1, 0, 2, h);
    for (let k = 0; k <= 4; k++) g.fillRect(0, (k * h) / 4 - 1, w, 2);
    // tie holes
    g.fillStyle = 'rgba(45,42,38,0.45)';
    for (let i = 0; i < 2; i++) for (let j = 0; j < 4; j++) for (const [a, b] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
      g.beginPath(); g.arc(((i + a) * w) / 2, ((j + b) * h) / 4, 2.6, 0, Math.PI * 2); g.fill();
    }
    // weather streaks
    for (let i = 0; i < 40; i++) { const x = rnd() * w, y = rnd() * h, l = 30 + rnd() * 120; const gr = g.createLinearGradient(0, y, 0, y + l); gr.addColorStop(0, 'rgba(60,56,50,0.10)'); gr.addColorStop(1, 'rgba(60,56,50,0)'); g.fillStyle = gr; g.fillRect(x, y, 2 + rnd() * 5, l); }
  }, { repeat: true });
  const form = new THREE.MeshStandardMaterial({ map: formTex, vertexColors: true, roughness: 0.86, metalness: 0, color: formTex ? 0xffffff : 0xb5b2ab });
  const sleeper = new THREE.MeshStandardMaterial({ color: 0x8f8c86, roughness: 0.9, metalness: 0 });
  const mast = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.55 });
  const lampX = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xfff3e0, emissiveIntensity: 4, roughness: 0.4 });
  XM = { ...M, form, sleeper, mast, lampX };
  return XM;
}
const MOUTH = { m: null };
// (dissolves within ~70 m of the camera: see mouthFade -- you never ride / walk through a black plane)
function mouthMaterial() { return (MOUTH.m ??= mouthFade(new THREE.MeshBasicMaterial({ color: 0x030405 }))); }

// palette (linear)
const C = {
  ballast: lin('#ffffff'), slab: lin('#b4b1aa'), slabSide: lin('#8f8c86'), rail: lin('#8e9399'), railTop: lin('#cfd3d8'),
  conc: lin('#c9c6bf'), concTop: lin('#d9d6cf'), concDark: lin('#9d9a93'), concUnder: lin('#8a8780'), parapet: lin('#d6d3cc'),
  snow: lin('#f1f5fa'), mast: lin('#6b737c'), mastDark: lin('#4f565e'), wire: lin('#3a3d40'), trough: lin('#a7a49d'),
  lamp: lin('#ffffff'), bracket: lin('#2f3338'),
};

// ------------------------------------------------------------------ track
const RAIL_SEC = [[-0.045, -0.15], [-0.045, -0.13], [-0.012, -0.12], [-0.012, -0.04], [-0.032, -0.03], [-0.032, 0], [0.032, 0], [0.032, -0.03], [0.012, -0.04], [0.012, -0.12], [0.045, -0.13], [0.045, -0.15]];
// clockwise order for sweep(): reversed (left side up, over the head, right side down)
const RAIL_CW = RAIL_SEC.slice();
const RAIL_COLS = RAIL_CW.slice(1).map(([, y], k) => (y > -0.005 && RAIL_CW[k][1] > -0.005 ? C.railTop : C.rail));
// the ballast bed of both tracks (one prism), the cable troughs on its shoulders
const BALLAST = [[-TRACK_OFF - 2.45, -0.74], [-TRACK_OFF - 1.6, -BALLAST_TOP], [TRACK_OFF + 1.6, -BALLAST_TOP], [TRACK_OFF + 2.45, -0.74]];
const TROUGH = [[-0.3, -0.74], [-0.3, -0.5], [0.3, -0.5], [0.3, -0.74]];
const TSLAB = [[-1.4, -DECK], [-1.4, -SLAB], [1.4, -SLAB], [1.4, -DECK]];
function buildBed(bd, slab, kind, s0, s1) {
  if (kind === 'open' || kind === 'station') {
    sweep(bd, s0, s1, 4, BALLAST, [C.ballast], { us: 2, vs: 2 });
    for (const sd of [-1, 1]) sweep(slab, s0, s1, 8, TROUGH, [C.trough], { lat: sd * (TRACK_OFF + 3.9) });
  } else {
    for (const sd of [-1, 1]) sweep(slab, s0, s1, 4, TSLAB, [C.slabSide, C.slab, C.slabSide], { lat: sd * TRACK_OFF });
  }
}
function buildRails(steel, s0, s1) {
  for (const sd of [-1, 1]) for (const g of [-GAUGE / 2, GAUGE / 2]) sweep(steel, s0, s1, 4, RAIL_CW, RAIL_COLS, { lat: sd * TRACK_OFF + g });
}
// sleepers: one instanced box per sleeper (both tracks), 0.65 m apart; on the slab track the same blocks sit in the
// slab (their tops 10 cm proud)
const SLEEPER_GEO = { g: null };
function sleeperGeometry() {
  if (SLEEPER_GEO.g) return SLEEPER_GEO.g;
  const g = new THREE.BoxGeometry(1.9, 0.18, 0.26);
  g.translate(0, -0.24, 0);
  SLEEPER_GEO.g = g;
  return g;
}
const _m4 = new THREE.Matrix4(), _vx = new THREE.Vector3(), _vy = new THREE.Vector3(), _vz = new THREE.Vector3();
function sleeperMatrices(list, s0, s1) {
  const f = {};
  for (let s = Math.ceil(s0 / 0.65) * 0.65; s < s1; s += 0.65) {
    frame(s, f);
    // a proper rotation: x = left, y = up (tilted with the grade), z = along
    _vz.set(f.tx, f.ty, f.tz); _vx.set(-f.rx, 0, -f.rz); _vy.crossVectors(_vz, _vx);
    for (const sd of [-1, 1]) {
      _m4.makeBasis(_vx, _vy, _vz).setPosition(f.x + f.rx * sd * TRACK_OFF, f.y, f.z + f.rz * sd * TRACK_OFF);
      list.push(_m4.clone());
    }
  }
}

// ------------------------------------------------------------------ overhead line
// Masts every MAST_EVERY m on both sides (outside the tracks; behind the platforms at the stations, on the deck's
// edge on the viaducts), a cantilever over each track; in the tunnels drop brackets from the vault. The contact wire
// zigzags ±0.2 m from mast to mast; the messenger sags between them; the far wires are 1-px lines.
function buildCatenary(steel, s0, s1, kindAt, wires, cols = null) {
  const f = {};
  for (let s = Math.ceil(s0 / MAST_EVERY) * MAST_EVERY; s < s1; s += MAST_EVERY) {
    const kind = kindAt(s);
    frame(s, f);
    const k = Math.round(s / MAST_EVERY), zig = k % 2 ? 0.2 : -0.2;
    for (const sd of [-1, 1]) {
      const tx = f.x + f.rx * sd * TRACK_OFF, tz = f.z + f.rz * sd * TRACK_OFF; // over the track
      if (kind === 'tunnel' || kind === 'hall') {
        // drop bracket from the vault
        const top = f.y - 0.15 + (TS + (TC - TS) * Math.sqrt(Math.max(0, 1 - (TRACK_OFF / TW) ** 2)));
        steel.rod([tx, top, tz], [tx, f.y + MESS_Y - 0.6, tz], 0.04, C.mastDark, 4);
        steel.rod([tx - f.rx * 0.5, f.y + MESS_Y - 0.6, tz - f.rz * 0.5], [tx + f.rx * 0.5, f.y + MESS_Y - 0.6, tz + f.rz * 0.5], 0.035, C.mastDark, 4);
        continue;
      }
      // (at a station: none on the station's side in front of the building and its canopy)
      if (kind === 'station' && layout.express?.stations.some((st) => st.side === sd && Math.abs(ringDelta(st.s, s)) < 32)) continue;
      const lat = kind === 'station' ? 9.6 : MAST_LAT;
      const mx = f.x + f.rx * sd * lat, mz = f.z + f.rz * sd * lat;
      // (where the line crosses a piste at grade, no mast on its groomed width: the wires span it)
      if (kind !== 'bridge' && kind !== 'station' && onPiste(mx, mz, 1.5)) continue;
      const foot = kind === 'bridge' ? f.y - DECK : f.y - 0.74;
      const top = f.y + MESS_Y + 0.9;
      // H-section mast (two flanges and a web), a concrete foundation block
      const X = [f.rx, 0, f.rz], Z = [f.tx / Math.hypot(f.tx, f.tz), 0, f.tz / Math.hypot(f.tx, f.tz)];
      for (const fl of [-1, 1]) steel.obx([mx + Z[0] * fl * 0.13, (foot + top) / 2, mz + Z[2] * fl * 0.13], X, Z, 0.16, (top - foot) / 2, 0.02, C.mast);
      steel.obx([mx, (foot + top) / 2, mz], X, Z, 0.02, (top - foot) / 2, 0.12, C.mastDark);
      if (kind !== 'bridge') steel.obx([mx, foot + 0.15, mz], X, Z, 0.4, 0.35, 0.4, C.trough);
      // solid: the foundation block's footprint (not on a viaduct: a footprint has no bottom, it would stand in the valley under the deck)
      if (kind !== 'bridge') cols?.push({ x: mx, z: mz, r: 0.4, h: top - f.y + 0.7 });
      // cantilever: the upper tube to the messenger, the lower (registration) arm to the contact wire, a stay
      const reach = (lat - TRACK_OFF) + 0.6;
      const p = (l, y) => [mx - f.rx * sd * l, f.y + y, mz - f.rz * sd * l];
      steel.rod(p(0, MESS_Y + 0.55), p(reach, MESS_Y + 0.05), 0.045, C.mast, 5);
      steel.rod(p(0, WIRE_Y + 0.35), p(reach - 0.6 + zig * sd, WIRE_Y + 0.1), 0.04, C.mast, 5);
      steel.rod(p(reach - 0.6, MESS_Y + 0.08), p(reach - 0.6, WIRE_Y + 0.1), 0.02, C.mastDark, 4);
      // insulators (dark) at the mast
      steel.rod(p(0.05, MESS_Y + 0.55), p(0.5, MESS_Y + 0.5), 0.07, C.bracket, 6);
      steel.rod(p(0.05, WIRE_Y + 0.35), p(0.5, WIRE_Y + 0.32), 0.07, C.bracket, 6);
    }
  }
  // wires over each track
  for (const sd of [-1, 1]) {
    let prev = null, prevM = null;
    for (const s of samples(s0, s1, 6)) {
      frame(s, f);
      const kind = kindAt(s), inside = kind === 'tunnel' || kind === 'hall';
      const ph = (((s % MAST_EVERY) + MAST_EVERY) % MAST_EVERY) / MAST_EVERY;
      const k = Math.floor(s / MAST_EVERY), zA = k % 2 ? 0.2 : -0.2, zig = zA + (-zA - zA) * ph; // zigzag mast to mast
      const sag = inside ? 0 : 0.55 * 4 * ph * (1 - ph);
      const lat = sd * TRACK_OFF + zig * sd;
      const p = [f.x + f.rx * lat, f.y + WIRE_Y, f.z + f.rz * lat];
      const m = [f.x + f.rx * sd * TRACK_OFF, f.y + (inside ? MESS_Y - 0.6 : MESS_Y) - sag, f.z + f.rz * sd * TRACK_OFF];
      if (prev) {
        steel.rod(prev, p, 0.011, C.wire, 3);
        steel.rod(prevM, m, 0.011, C.wire, 3);
        wires.push(...prev, ...p, ...prevM, ...m);
      }
      prev = p; prevM = m;
    }
  }
}

// ------------------------------------------------------------------ tunnel tube
// The double-track tube (inner): the floor under the slabs, a raised walkway along each wall, vertical walls to the
// springline, an elliptic vault. A closed ring, listed left floor -> left wall -> vault -> right wall -> floor.
const TUBE = (() => {
  const P = [[-WALK, FLOOR_Y], [-WALK, WALK_Y], [-TW, WALK_Y], [-TW, TS]];
  const n = 18;
  for (let k = 1; k < n; k++) { const a = (k / n) * Math.PI; P.push([-TW * Math.cos(a), TS + (TC - TS) * Math.sin(a)]); }
  P.push([TW, TS], [TW, WALK_Y], [WALK, WALK_Y], [WALK, FLOOR_Y], [-WALK, FLOOR_Y]);
  let L = 0;
  const arc = P.map((p, i) => (i ? (L += Math.hypot(p[0] - P[i - 1][0], p[1] - P[i - 1][1])) : 0));
  return { P, arc };
})();
export const tubeProfile = () => TUBE;
const LAMP_EVERY = 24;
// tn: the tunnel span (shifted round the ring like s0..s1), noHall: the village hall's stretch is left out
function buildTube(lining, lampB, tn, s0, s1) {
  const { P, arc } = TUBE;
  const f = {};
  const day = (s) => Math.max(1 - smoothstep(-2, 30, s - tn.s0), smoothstep(tn.s1 - 30, tn.s1 + 2, s));
  const lampAt = (s) => tn.s0 + Math.round((s - tn.s0) / LAMP_EVERY) * LAMP_EVERY;
  let prev = null;
  for (const ss of samples(s0, s1, 3)) {
    frame(ss, f);
    const dl = ss - lampAt(ss), pool = Math.exp(-(dl * dl) / 30), d = day(ss);
    // at a portal the lining flares 0.3 m through the facade's depth (no gap between the concrete and the lining)
    const toPortal = Math.min(ss - tn.s0, tn.s1 - ss);
    const flare = 1 - smoothstep(PORTAL_IN + 0.7, PORTAL_IN + 2.4, toPortal);
    const fx = 1 + flare * (0.3 / TW), fy = 1 + flare * (0.3 / TC);
    const ring = P.map(([x0, y0], k) => {
      const x = x0 * fx, y = y0 > 0 ? y0 * fy : y0;
      const a = P[Math.max(0, k - 1)], b = P[Math.min(P.length - 1, k + 1)];
      let nx = b[1] - a[1], ny = -(b[0] - a[0]); const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
      // (the ring runs left wall -> vault -> right wall: (dy, -dx) points into the tube)
      const low = 1 - smoothstep(0.1, 1.8, y), crown = smoothstep(TC - 1.6, TC, y);
      const g = 0.98 - low * 0.42 - crown * 0.12;
      const lit = Math.min(1, pool * (0.35 + 0.65 * smoothstep(-0.5, 3.5, y)) * (y > 5.6 ? 0.6 : 1) + pool * 0.2);
      return lining.vc(f.x + f.rx * x, f.y + y, f.z + f.rz * x, f.rx * nx, ny, f.rz * nx, [g, g * 0.99, g * 0.965], arc[k] / 6, ss / 6, lit, d);
    });
    if (prev) for (let k = 0; k < ring.length - 1; k++) lining.aq(prev[k], ring[k], ring[k + 1], prev[k + 1]);
    prev = ring;
  }
  // lamp strips on both walls (2.3 m up), on dark brackets
  for (let s = lampAt(s0); s <= s1; s += LAMP_EVERY) {
    if (s < s0 || s < tn.s0 + 6 || s > tn.s1 - 6) continue;
    frame(s, f);
    const Z = [f.tx, f.ty, f.tz], X = [f.rx, 0, f.rz];
    for (const sd of [-1, 1]) {
      const c = [f.x + f.rx * sd * (TW - 0.12), f.y + 2.3, f.z + f.rz * sd * (TW - 0.12)];
      lampB.obx(c, X, Z, 0.07, 0.06, 0.65, C.lamp);
    }
  }
}

// ------------------------------------------------------------------ portals
// A modern concrete portal: a headwall with the tube's opening, a projecting frame round the arch, parallel wing
// walls retaining the cutting, a coping with snow on it, the name plate over the arch, the dark mouth just inside.
// Local frame: x across, y up from the rail, z out of the tunnel (a right-handed basis at both ends).
// (the headwall reaches back over the whole cut behind the portal plane (the roadbed shaper digs PORTAL_IN m into
// the hill): no gap between its top and the cover over the tube)
const HEAD_W = 12.5, HEAD_H = TC + 4.6, WING_L = 13, HEAD_D = PORTAL_IN + 0.8;
function portalBasis(tn, which) {
  const s = which === 0 ? tn.s0 : tn.s1, f = frame(s, {});
  const dir = which === 0 ? -1 : 1; // out of the tunnel along -t at the entrance, +t at the exit
  const fh = Math.hypot(f.tx, f.tz);
  const Z = new THREE.Vector3((f.tx / fh) * dir, 0, (f.tz / fh) * dir), Y = new THREE.Vector3(0, 1, 0);
  const X = new THREE.Vector3().crossVectors(Y, Z); // (y x z = x)
  return { s, f, X, Y, Z, m: new THREE.Matrix4().makeBasis(X, Y, Z).setPosition(f.x, f.y, f.z) };
}
function archPath(path, w, ys, yc, y0, n = 24, ccw = false) {
  // the opening: from (-w, y0) up the jamb, over the arch, down to (w, y0) (or the other way round)
  const pts = [[-w, y0], [-w, ys]];
  for (let k = 1; k < n; k++) { const a = Math.PI - (k / n) * Math.PI; pts.push([w * Math.cos(a), ys + (yc - ys) * Math.sin(a)]); }
  pts.push([w, ys], [w, y0]);
  if (ccw) pts.reverse();
  return pts;
}
function extrude(shape, depth) {
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 4 });
  return g;
}
const PLATE = new Map();
function plateTexture(title, sub) {
  const key = title + '|' + sub;
  if (PLATE.has(key)) return PLATE.get(key);
  const t = canvasTex(1024, 256, (g, w, h) => {
    g.fillStyle = '#20252c'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#b0121a'; g.fillRect(0, 0, 26, h);
    g.fillStyle = '#f2f5fa'; g.textBaseline = 'middle';
    g.font = `600 58px "Barlow Condensed", "Arial Narrow", Arial, sans-serif`; g.fillText('LEGACY EXPRESS', 64, h * 0.3);
    g.font = `italic 700 104px "Barlow Condensed", "Arial Narrow", Arial, sans-serif`; g.fillText(title, 60, h * 0.68);
    g.textAlign = 'right'; g.font = `600 64px "Barlow Condensed", "Arial Narrow", Arial, sans-serif`; g.fillStyle = '#c9ced6'; g.fillText(sub, w - 40, h * 0.68);
  });
  PLATE.set(key, t);
  return t;
}
function buildPortal(XMat, tn, which, label) {
  const { m, X, Z, f } = portalBasis(tn, which);
  const grp = new THREE.Group();
  const W = TW + 0.3, Hs = TS, Hc = TC + 0.3;
  // headwall: a slab with the opening, HEAD_D deep (into the hill); its opening 5 cm wider than the flared lining
  // (no z-fighting with it)
  // (one polygon round the opening: from the left foot in along the floor, round the arch, out to the right foot)
  const outer = new THREE.Shape([[-HEAD_W, -1.6], ...archPath(null, W + 0.05, Hs, Hc + 0.05, -1.6), [HEAD_W, -1.6], [HEAD_W, HEAD_H], [-HEAD_W, HEAD_H]].map(([x, y]) => new THREE.Vector2(x, y)));
  const head = extrude(outer, HEAD_D); head.translate(0, 0, -HEAD_D);
  // the frame round the arch: a horseshoe band 1.1 m wide, standing 0.9 m proud of the headwall
  const band = new THREE.Shape(archPath(null, W + 1.1, Hs, Hc + 1.1, -0.75).concat(archPath(null, W, Hs, Hc, -0.75).reverse()).map(([x, y]) => new THREE.Vector2(x, y)));
  const fr = extrude(band, 1.6); fr.translate(0, 0, -0.7);
  // wing walls along the cutting (in the planes x = ±(HEAD_W - 1.2)), their tops falling outward
  const wingShape = new THREE.Shape([[0, -1.6], [WING_L, -1.6], [WING_L, 1.4], [0, HEAD_H - 0.6]].map(([a, b]) => new THREE.Vector2(a, b)));
  const wings = [];
  for (const sd of [-1, 1]) {
    const g = extrude(wingShape, 0.9);
    // shape x -> z (out), shape y -> y, extrusion -> x
    // (shape x -> out, shape y -> up, the extrusion -> -x: a proper rotation, the faces stay outward)
    g.applyMatrix4(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0), new THREE.Vector3(-1, 0, 0)));
    g.translate(sd * (HEAD_W - 1.6) + 0.45, 0, 0);
    wings.push(g);
  }
  // coping: a cap along the headwall's top, snow on it
  const cop = new THREE.BoxGeometry(HEAD_W * 2 + 0.5, 0.4, HEAD_D + 0.5); cop.translate(0, HEAD_H + 0.2, 0.25 - HEAD_D / 2);
  const snow = new THREE.BoxGeometry(HEAD_W * 2 + 0.3, 0.22, HEAD_D + 0.3); snow.translate(0, HEAD_H + 0.51, 0.25 - HEAD_D / 2);
  for (const g of [head, fr, ...wings, cop]) {
    g.applyMatrix4(m);
    const mesh = new THREE.Mesh(g, XMat.portal);
    mesh.castShadow = true; mesh.receiveShadow = true;
    grp.add(mesh);
  }
  snow.applyMatrix4(m);
  const sm = new THREE.Mesh(snow, XMat.snow); sm.receiveShadow = true; grp.add(sm);
  // the dark mouth just inside the arch (single-sided, facing out: from inside you look straight through it)
  const mb = new XB();
  const ring = archPath(null, W * 1.01, Hs, Hc + 0.05, FLOOR_Y - 0.2);
  const P = (x, y, z) => new THREE.Vector3(x, y, z).applyMatrix4(m);
  const zz = -0.12;
  const ctr = P(0, TS * 0.5, zz);
  const ci = mb.vc(ctr.x, ctr.y, ctr.z, Z.x, 0, Z.z, C.lamp);
  const vs = ring.map(([x, y]) => { const p = P(x, y, zz); return mb.vc(p.x, p.y, p.z, Z.x, 0, Z.z, C.lamp); });
  for (let k = 0; k < vs.length - 1; k++) mb.at(ci, vs[k], vs[k + 1]);
  const mouth = new THREE.Mesh(mb.build(), mouthMaterial());
  mouth.renderOrder = 1;
  grp.add(mouth);
  // name plate over the arch
  const tex = plateTexture(label.title, label.sub);
  if (tex) {
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0 });
    const pl = new THREE.Mesh(new THREE.PlaneGeometry(6.4, 1.6), mat);
    pl.position.copy(P(0, Hc + 2.6, 0.03));
    pl.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, new THREE.Vector3(0, 1, 0), Z));
    grp.add(pl);
    grp.userData.signs = [mat];
    grp.userData.dispose = [mat];
  }
  void f;
  return grp;
}
// terrain clip volumes: no terrain inside the tube's profile from the portal plane to past the rise behind it
function portalClip(tn, which) {
  const into = which === 0 ? 1 : -1, half = (PORTAL_IN + 5.0) / 2;
  const f = frame((which === 0 ? tn.s0 : tn.s1) + into * (half - 0.4), {});
  const h = Math.hypot(f.tx, f.tz);
  return { x: f.x, y: f.y, z: f.z, grade: f.grade, tx: f.tx / h, tz: f.tz / h, a0: -half, a1: half, hw: TW + 0.25, v0: FLOOR_Y - 0.3, vS: TS, v1: TC + 0.25 };
}

// ------------------------------------------------------------------ viaducts
// A single-cell concrete box girder (13.2 m wide: both tracks, the walkways and the parapets) on piers every ~48 m.
// Section (x right of the centre line, y over the top of rail), clockwise from the left parapet's top.
const GIRDER_D = 3.6; // depth under the deck's top
function girderSection(D = GIRDER_D) {
  return [[-6.6, 0.7], [-6.25, 0.7], [-6.25, -DECK], [6.25, -DECK], [6.25, 0.7], [6.6, 0.7], [6.6, -1.0], [3.5, -1.65], [2.75, -DECK - D], [-2.75, -DECK - D], [-3.5, -1.65], [-6.6, -1.0], [-6.6, 0.7]];
}
const GIRDER_COLS = [C.parapet, C.concTop, C.concTop, C.concTop, C.parapet, C.conc, C.concUnder, C.conc, C.concUnder, C.conc, C.concUnder, C.conc];
const SPAN = 48;
let KEEP = null;
// where no pier may stand: within reach of a race course's line, a lift line, a piste (a 10 m cell set)
function keepOut() {
  if (KEEP) return KEEP;
  const CELL = 10, set = new Set();
  const mark = (ax, az, bx, bz, r) => {
    const len = Math.hypot(bx - ax, bz - az), steps = Math.max(1, Math.ceil(len / CELL));
    for (let k = 0; k <= steps; k++) {
      const x = ax + ((bx - ax) * k) / steps, z = az + ((bz - az) * k) / steps;
      for (let cx = Math.floor((x - r) / CELL); cx <= Math.floor((x + r) / CELL); cx++) for (let cz = Math.floor((z - r) / CELL); cz <= Math.floor((z + r) / CELL); cz++) {
        if (Math.hypot(cx * CELL + CELL / 2 - x, cz * CELL + CELL / 2 - z) < r + CELL * 0.71) set.add(cx * 100000 + cz);
      }
    }
  };
  for (const e of KEEP_COURSES) { const T = e.course?.track; if (!T) continue; for (let i = 0; i + 3 < T.n; i += 3) mark(T.X[i], T.Z[i], T.X[i + 3], T.Z[i + 3], 32); }
  for (const l of layout.lifts || []) mark(l.bottom.x, l.bottom.z, l.top.x, l.top.z, 14);
  // (a piste: its whole groomed width and a few metres beyond, Oct 30: no pier on the groomed snow)
  for (const p of layout.pistes || []) for (let i = 0; i + 1 < p.pts.length; i++) mark(p.pts[i][0], p.pts[i][1], p.pts[i + 1][0], p.pts[i + 1][1], (PISTE_WIDTH[p.diff] ?? 14) + 4);
  KEEP = (x, z) => set.has(Math.floor(x / CELL) * 100000 + Math.floor(z / CELL));
  return KEEP;
}
let KEEP_COURSES = [];
// the pier's half sizes (across, along) at the top and the bottom for a pier h m tall
const pierSize = (h) => ({ a0: 2.5, b0: 1.25, a1: 2.5 + h * 0.028, b1: 1.25 + h * 0.016 });
function soffit(s) { expressAt(s, _p); return _p.y - DECK - GIRDER_D; }
// the lowest natural ground under a footprint (centre, the four corners)
function groundUnder(x, z, rx, rz, a, b) {
  const tx = rz, tz = -rx; // (along: perpendicular to right)
  let g = world.height(x, z);
  for (const [i, j] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) g = Math.min(g, world.height(x + rx * a * i + tx * b * j, z + rz * a * i + tz * b * j));
  return g;
}
function planBridge(b) {
  const keep = keepOut();
  const L = b.s1 - b.s0, n = Math.max(1, Math.round(L / SPAN));
  const piers = [];
  const f = {};
  for (let k = 1; k < n; k++) {
    const s = b.s0 + (L * k) / n;
    // shift the pier along the line off anything it must not stand on (or leave it out: a longer span)
    let best = null;
    for (const off of [0, -5, 5, -10, 10, -15, 15, -20, 20]) {
      const ss = s + off;
      frame(ss, f);
      const y = soffit(ss), g0 = world.height(f.x, f.z), sz = pierSize(Math.max(0, y - g0));
      let blocked = false;
      for (const [i, j] of [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]]) if (keep(f.x + f.rx * sz.a1 * i * 1.4 + f.rz * sz.b1 * j * 1.4, f.z + f.rz * sz.a1 * i * 1.4 - f.rx * sz.b1 * j * 1.4)) blocked = true;
      if (!blocked) { best = ss; break; }
    }
    if (best === null) continue;
    frame(best, f);
    const top = soffit(best);
    let g = world.height(f.x, f.z);
    const sz = pierSize(Math.max(0, top - g));
    g = groundUnder(f.x, f.z, f.rx, f.rz, sz.a1, sz.b1);
    if (top - g < 1.5) continue; // (the deck runs close over the ground here)
    piers.push({ s: best, x: f.x, z: f.z, top, g, h: top - g, heading: f.heading, rx: f.rx, rz: f.rz, ...pierSize(top - g) });
  }
  // abutments at both ends
  const abut = [b.s0, b.s1].map((s, k) => {
    frame(s, f);
    return { s, x: f.x, z: f.z, k, g: Math.min(world.height(f.x + f.rx * 6, f.z + f.rz * 6), world.height(f.x - f.rx * 6, f.z - f.rz * 6), world.height(f.x, f.z)) };
  });
  const mid = frame((b.s0 + b.s1) / 2, {});
  const maxH = piers.reduce((m, p) => Math.max(m, p.h), 0);
  return { b, piers, abut, x: mid.x, z: mid.z, r: L / 2 + 40, maxH };
}
// the pier: a tapered shaft with chamfered corners on a footing, a flared head under the girder; the tall ones
// (over 70 m) split into two legs (along the line) through their top third
function pierRing(x, y, z, X, Zd, a, b, ch) {
  // octagon: a rectangle a (across) x b (along) with its corners chamfered by ch
  const pts = [[-a + ch, -b], [a - ch, -b], [a, -b + ch], [a, b - ch], [a - ch, b], [-a + ch, b], [-a, b - ch], [-a, -b + ch]];
  return pts.map(([u, v]) => [x + X[0] * u + Zd[0] * v, y, z + X[2] * u + Zd[2] * v]);
}
function buildPier(g, p) {
  const X = [p.rx, 0, p.rz], Zd = [p.rz, 0, -p.rx];
  const head = 2.2; // the flared head's height
  const yTop = p.top - head, yBot = p.g - 2.5;
  const tint = (k) => [C.conc[0] * k, C.conc[1] * k, C.conc[2] * k];
  const split = p.h > 70;
  // footing
  const fa = p.a1 + 1.6, fb = p.b1 + 1.6;
  g.prism(pierRing(p.x, p.g - 3, p.z, X, Zd, fa, fb, 0.4), pierRing(p.x, p.g + 0.5, p.z, X, Zd, fa, fb, 0.4), tint(0.78), tint(0.8), { cap1: true });
  if (!split) {
    g.prism(pierRing(p.x, yBot, p.z, X, Zd, p.a1, p.b1, Math.min(p.b1 * 0.45, 1.4)), pierRing(p.x, yTop, p.z, X, Zd, p.a0, p.b0, p.b0 * 0.45), tint(0.82), tint(1.0), { us: 5 });
  } else {
    // the solid lower two thirds, then two legs with a slot between them widening to the top
    const ySplit = yTop - p.h * 0.32;
    const k = (ySplit - yBot) / (yTop - yBot);
    const am = p.a1 + (p.a0 - p.a1) * k, bm = p.b1 + (p.b0 - p.b1) * k;
    g.prism(pierRing(p.x, yBot, p.z, X, Zd, p.a1, p.b1, Math.min(p.b1 * 0.45, 1.6)), pierRing(p.x, ySplit, p.z, X, Zd, am, bm, bm * 0.45), tint(0.82), tint(0.95), { us: 5 });
    const gapTop = 1.4, legB = (bm - 0.25) / 2, legTop = p.b0 * 1.1 - gapTop / 2;
    for (const sd of [-1, 1]) {
      const c0 = [p.x + Zd[0] * sd * (0.25 + legB), p.z + Zd[2] * sd * (0.25 + legB)];
      const c1 = [p.x + Zd[0] * sd * (gapTop / 2 + legTop / 2), p.z + Zd[2] * sd * (gapTop / 2 + legTop / 2)];
      g.prism(pierRing(c0[0], ySplit, c0[1], X, Zd, am, legB, legB * 0.4), pierRing(c1[0], yTop, c1[1], X, Zd, p.a0, legTop / 2, legTop * 0.2), tint(0.95), tint(1.0), { us: 5 });
    }
  }
  // the head: flares from the shaft out to the girder's soffit width, a bearing plinth on it
  const hb = split ? p.b0 * 1.1 : p.b0;
  g.prism(pierRing(p.x, yTop, p.z, X, Zd, p.a0, hb, hb * 0.45), pierRing(p.x, p.top - 0.35, p.z, X, Zd, 3.6, hb + 0.25, 0.3), tint(1.0), tint(1.02), { cap1: true });
  for (const sd of [-1, 1]) g.obx([p.x + X[0] * sd * 2.0, p.top - 0.18, p.z + X[2] * sd * 2.0], X, Zd, 0.5, 0.17, 0.5, C.concDark);
}
function buildAbutment(g, a, b) {
  const f = frame(a.s, {});
  const X = [f.rx, 0, f.rz], Zd = [f.tx / Math.hypot(f.tx, f.tz), 0, f.tz / Math.hypot(f.tx, f.tz)];
  const into = a.k === 0 ? -1 : 1; // (into the embankment)
  const top = f.y - DECK + 0.05, bot = Math.min(a.g, top - GIRDER_D) - 3;
  const c = [f.x + Zd[0] * into * 3.0, (top + bot) / 2, f.z + Zd[2] * into * 3.0];
  g.obx(c, X, Zd, 7.0, (top - bot) / 2, 3.6, C.concDark, C.concTop);
  // a ballast wall over the girder's end and the wing walls into the embankment
  for (const sd of [-1, 1]) g.obx([f.x + X[0] * sd * 7.3 + Zd[0] * into * 5, (top + 0.8 + bot) / 2, f.z + X[2] * sd * 7.3 + Zd[2] * into * 5], X, Zd, 0.45, (top + 0.8 - bot) / 2, 5.5, C.conc, C.parapet);
  void b;
}
function buildBridge(XMat, plan) {
  const { b } = plan;
  const g = new XB({ uv: true });
  sweep(g, b.s0 - 1, b.s1 + 1, 4, girderSection(), GIRDER_COLS, { us: 5, vs: 5 });
  for (const p of plan.piers) buildPier(g, p);
  for (const a of plan.abut) buildAbutment(g, a, b);
  const mesh = new THREE.Mesh(g.build(), XMat.form);
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  return mesh;
}

// ------------------------------------------------------------------ the line's chunks
function kindsOf(c0, c1) {
  const cuts = new Set([c0, c1]);
  const T = spansIn(EXPRESS.tunnels, c0, c1), Bs = spansIn(EXPRESS.bridges, c0, c1);
  const St = spansIn(EXPRESS.stations.map((st) => ({ s0: st.s0 - 6, s1: st.s1 + 6 })), c0, c1);
  for (const sp of [...T, ...Bs, ...St]) { cuts.add(sp.a); cuts.add(sp.b); }
  const list = [...cuts].sort((a, b) => a - b);
  const out = [];
  for (let k = 0; k < list.length - 1; k++) {
    const a = list[k], b = list[k + 1];
    if (b - a < 0.05) continue;
    const m = (a + b) / 2;
    const tn = T.find((sp) => m > sp.a && m < sp.b), br = Bs.find((sp) => m > sp.a && m < sp.b);
    const kind = tn ? 'tunnel' : br ? 'bridge' : St.some((sp) => m > sp.a && m < sp.b) ? 'station' : 'open';
    out.push({ a, b, kind, tn });
  }
  return out;
}
function kindFn(pieces) { return (s) => (pieces.find((p) => s >= p.a && s <= p.b) || pieces[0]).kind; }

function buildChunkBed(XMat, c0, c1) {
  const bd = new XB({ uv: true }), slab = new XB();
  for (const p of kindsOf(c0, c1)) buildBed(bd, slab, p.kind, p.a, p.b);
  const grp = new THREE.Group();
  const add = (b, mat, cast) => { const geo = b.build(); if (!geo) return; const m = new THREE.Mesh(geo, mat); m.receiveShadow = true; m.castShadow = cast; m.matrixAutoUpdate = false; grp.add(m); };
  add(bd, XMat.ballast, false);
  add(slab, XMat.concrete, false);
  return grp;
}
function buildChunkDetail(XMat, c0, c1) {
  const pieces = kindsOf(c0, c1);
  const steel = new XB(), lining = new XB({ uv: true, light: true }), lamps = new XB(), wires = [], sl = [], cols = [];
  buildRails(steel, c0, c1);
  sleeperMatrices(sl, c0, c1);
  buildCatenary(steel, c0, c1, kindFn(pieces), wires, cols);
  for (const p of pieces) if (p.kind === 'tunnel') buildTube(lining, lamps, p.tn, p.a, p.b);
  const grp = new THREE.Group();
  const add = (b, mat, { cast = false } = {}) => { const geo = b.build(); if (!geo) return null; const m = new THREE.Mesh(geo, mat); m.receiveShadow = true; m.castShadow = cast; m.matrixAutoUpdate = false; grp.add(m); return m; };
  add(steel, XMat.mast, { cast: true });
  const inner = [add(lining, XMat.lining), add(lamps, XMat.lampX)].filter(Boolean);
  if (sl.length) {
    const im = new THREE.InstancedMesh(sleeperGeometry(), XMat.sleeper, sl.length);
    sl.forEach((m, i) => im.setMatrixAt(i, m));
    im.instanceMatrix.needsUpdate = true;
    im.receiveShadow = true; im.castShadow = false;
    im.computeBoundingSphere();
    grp.add(im);
  }
  if (wires.length) {
    const wg = new THREE.BufferGeometry();
    wg.setAttribute('position', new THREE.Float32BufferAttribute(wires, 3));
    wg.computeBoundingSphere();
    const wl = new THREE.LineSegments(wg, XMat.wire);
    wl.matrixAutoUpdate = false;
    grp.add(wl);
  }
  grp.userData.inner = inner;
  grp.userData.colliders = cols; // the masts: registered while the chunk is built (update())
  return grp;
}

// ------------------------------------------------------------------ entities
function disposeObj(o) {
  o.traverse((c) => {
    if (c.geometry && c.geometry !== SLEEPER_GEO.g && !c.geometry.userData?.shared) c.geometry.dispose();
    if (c.isInstancedMesh) c.dispose?.();
  });
  for (const m of o.userData.dispose || []) m.dispose();
}

/**
 * Build the Legacy Express's fixed installations (lazily: see the top of this file).
 * @returns {{ group, update(viewer: {x, y, z}, opts?: { inTunnel?: boolean, budget?: number (ms), all?: boolean }),
 *   clips, stations, bridges, setNight(n), setDay(k), stats() }}
 */
export function buildExpressTrack(scene, { models = null, colliders = [], cameraBlockers = [], courses = null } = {}) {
  const XMat = expressMaterials();
  if (!XMat.portal) {
    // (the extruded portals' uv are in metres: the formwork tile is 5 m)
    const map = XMat.form.map?.clone();
    if (map) { map.repeat.set(0.2, 0.2); map.needsUpdate = true; }
    XMat.portal = new THREE.MeshStandardMaterial({ color: map ? 0xffffff : 0xb9b6af, roughness: 0.82, metalness: 0, map: map || null });
    XMat.snow = new THREE.MeshStandardMaterial({ color: 0xf1f5fa, roughness: 0.7 });
  }
  const group = new THREE.Group();
  group.name = 'legacy-express';
  scene?.add(group);
  if (!EXPRESS.ready || !layout.express) { console.warn('Legacy Express: the line is not fitted (buildExpressGround)'); return { group, update() {}, clips: [], stations: [], bridges: [], setNight() {}, setDay() {}, stats: () => ({}) }; }
  try { KEEP_COURSES = courses || freeCourses(); } catch { KEEP_COURSES = []; }
  const ents = [];
  const ent = (kind, x, z, r, build, extra = {}) => { const e = { kind, x, z, r, build, obj: null, ...R[kind], ...extra }; ents.push(e); return e; };
  // the chunks
  for (let c0 = 0; c0 < LENGTH; c0 += CHUNK) {
    const c1 = Math.min(LENGTH, c0 + CHUNK);
    const m = frame((c0 + c1) / 2, {});
    // (a chunk's points lie within ~CHUNK / 2 of its middle: the line's curves are gentle)
    ent('bed', m.x, m.z, CHUNK * 0.55, () => buildChunkBed(XMat, c0, c1), { y: m.y });
    const portalHere = EXPRESS.tunnels.some((t) => [t.s0, t.s1].some((s) => { const d = ((s - (c0 + c1) / 2) % LENGTH + LENGTH * 1.5) % LENGTH - LENGTH / 2; return Math.abs(d) < CHUNK / 2 + 160; }));
    ent('detail', m.x, m.z, CHUNK * 0.55, () => buildChunkDetail(XMat, c0, c1), { y: m.y, portalHere });
  }
  // the viaducts (planned up front: their piers' colliders)
  const bridges = EXPRESS.bridges.map((b) => planBridge(b));
  for (const pl of bridges) {
    ent('bridge', pl.x, pl.z, pl.r, () => buildBridge(XMat, pl));
    for (const p of pl.piers) if (p.h > 1.5) colliders.push({ x: p.x, z: p.z, hw: p.a1 + 0.3, hd: p.b1 + 0.3, rot: -p.heading, top: p.top }); // (top: walked over on the deck)
  }
  // the portals and their clip volumes
  const clips = [];
  EXPRESS.tunnels.forEach((t, k) => {
    for (const which of [0, 1]) {
      const s = which ? t.s1 : t.s0, f = frame(s, {});
      const label = { title: `TUNNEL ${k + 1}`, sub: `${Math.round(t.s1 - t.s0).toLocaleString('en-US')} m` };
      ent('portal', f.x, f.z, 30, () => buildPortal(XMat, t, which, label));
      clips.push(portalClip(t, which));
    }
  });
  // the stations
  const stations = planExpressStations({ colliders, cameraBlockers, clips, models });
  for (const rec of stations) ent('station', rec.x, rec.z, rec.r, () => buildExpressStation(rec, XMat, models), { rec });
  setTerrainClipSet('express', clips);

  let night = 0;
  const signs = new Set();
  const applyNight = (o) => {
    for (const m of o.userData.signs || []) { signs.add(m); m.emissiveIntensity = night * 0.45; }
    o.userData.setNight?.(night);
  };
  // a dropped chunk takes its mast colliders with it (the shared array: compacted in place, others keep their order)
  const unregister = (o) => {
    const gone = o.userData.colliders;
    if (!gone?.length) return;
    const set = new Set(gone);
    let j = 0;
    for (let i = 0; i < colliders.length; i++) if (!set.has(colliders[i])) colliders[j++] = colliders[i];
    colliders.length = j;
  };
  const solid = (e) => {
    if (e.solidified || e.failed || !e.obj?.visible || (e.kind !== 'station' && e.kind !== 'portal' && e.kind !== 'bridge')) return;
    e.solidified = true;
    solidifyIdle([{ root: e.obj, area: 'express ' + e.kind, blob: false, tiles: true, whole: e.kind !== 'station' }], colliders).catch((err) => console.warn('Legacy Express: colliders', e.kind, err));
  };
  const queue = [];
  const update = (v, { inTunnel = null, budget = 4, all = false } = {}) => {
    terrainClipFocus(v.x, v.z);
    const under = inTunnel ?? (world.height(v.x, v.z) > v.y + 1.5);
    queue.length = 0;
    for (const e of ents) {
      const d = Math.hypot(v.x - e.x, v.z - e.z) - e.r;
      e.d = d;
      if (!e.obj) { if (d < e.buildR) queue.push(e); continue; }
      if (d > e.dropR) { unregister(e.obj); group.remove(e.obj); disposeObj(e.obj); for (const m of e.obj.userData.signs || []) signs.delete(m); e.obj = null; continue; }
      const vis = d < e.visR;
      if (e.obj.visible !== vis) { e.obj.visible = vis; solid(e); }
      if (vis && e.obj.userData.inner) {
        const near = e.portalHere || (under && d < 700);
        for (const m of e.obj.userData.inner) if (m.visible !== near) m.visible = near;
      }
      if (vis && e.kind === 'station') e.obj.userData.view?.(v, under);
    }
    // build the nearest first, within the time budget (at least one per frame)
    queue.sort((a, b) => a.d - b.d);
    const t0 = performance.now();
    for (const e of queue) {
      try { e.obj = e.build(); } catch (err) { console.warn('Legacy Express build', e.kind, err); e.obj = new THREE.Group(); e.failed = true; }
      for (const c of e.obj.userData.colliders || []) colliders.push(c); // (the chunk's catenary masts: solid only while it stands)
      e.obj.visible = e.d < e.visR;
      group.add(e.obj);
      applyNight(e.obj);
      if (e.obj.userData.inner) for (const m of e.obj.userData.inner) m.visible = e.portalHere || under;
      if (e.kind === 'station') e.obj.userData.view?.(v, under);
      // (a station's, a portal's, a viaduct's first build: colliders for whatever of it is drawn and not solid yet, the
      // platform furniture, railings, shelters' posts, the portal's wing walls, the parapets (world/solidify.js, in
      // slices; the decks and platforms are walked on). They stay when it is dropped: it comes back the same)
      solid(e);
      if (!all && performance.now() - t0 > budget) break;
    }
  };
  const setNight = (n) => {
    n = Math.round(n * 20) / 20;
    if (n === night) return;
    night = n;
    for (const m of signs) m.emissiveIntensity = n * 0.45;
    XMat.lampX.emissiveIntensity = 3 + n * 2;
    for (const e of ents) if (e.obj) e.obj.userData.setNight?.(n);
  };
  const stats = () => {
    const out = { built: {}, tris: 0, draws: 0 };
    for (const e of ents) if (e.obj) {
      out.built[e.kind] = (out.built[e.kind] || 0) + 1;
      if (!e.obj.visible) continue;
      e.obj.traverse((o) => {
        if (!o.visible || !(o.isMesh || o.isLineSegments)) return;
        let p = o.parent; while (p && p !== group) { if (!p.visible) return; p = p.parent; }
        out.draws++;
        const g = o.geometry, n = g.index ? g.index.count / 3 : g.attributes.position.count / 3;
        out.tris += Math.round(n * (o.isInstancedMesh ? o.count : 1));
      });
    }
    return out;
  };
  return { group, update, clips, stations, bridges, ents, setNight, setDay: (k) => setNight(1 - k), stats, materials: XMat };
}
