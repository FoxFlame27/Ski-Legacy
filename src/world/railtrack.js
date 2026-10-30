// The Wolkenspitzbahn's fixed installations, built along the alignment of railroute.js: the track (ballast bed,
// sleepers, rails, the Riggenbach ladder rack between them), the overhead line (masts, cantilevers, contact
// wire), the tunnels (shotcrete tubes with lamps and daylight near the portals, concrete portals with name
// plaques; the top station's vaulted rock hall), viaducts over the dips and the passing loop (the stations are in
// railstations.js).
// Everything is merged into chunks of ~250 m (a few draw calls each) that switch off with distance.
import * as THREE from 'three';
import { world } from './world.js';
import { RAIL, railAt, BED_DROP, TUBE_H, PORTAL_IN, PASSING_LOOP } from './railroute.js';
import { smoothstep, mulberry32 } from '../core/noise.js';

const CHUNK = 250;      // m of line per chunk
const NEAR = 1500;      // chunks further than this from the camera are hidden (structures: FAR)
const MID = 600;        // sleepers, rails, masts: only this close
const FAR = 4200;
const GAUGE = 1.0;

const _p = { x: 0, y: 0, z: 0, dx: 0, dz: 1, grade: 0, i: 0 };
const _q = { x: 0, y: 0, z: 0, dx: 0, dz: 1, grade: 0, i: 0 };
// frame of the line at s: position (top of rail), unit tangent (with the grade), horizontal right
function frame(s, out = {}) {
  railAt(s, _p);
  const l = Math.hypot(1, _p.grade);
  out.x = _p.x; out.y = _p.y; out.z = _p.z;
  out.tx = _p.dx / l; out.ty = _p.grade / l; out.tz = _p.dz / l;
  out.rx = -_p.dz; out.rz = _p.dx; // right, looking along the line (horizontal)
  out.heading = Math.atan2(_p.dx, _p.dz);
  out.grade = _p.grade;
  return out;
}
export { frame as railFrame };

// ------------------------------------------------------------------ shared materials + textures
let MAT = null;
function canvasTex(w, h, draw, { repeat = false, srgb = true } = {}) {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
const FONT = '"Barlow Condensed", "Arial Narrow", "Helvetica Neue", Arial, sans-serif';
function noiseFill(g, w, h, rnd, n, cols, size = 2) { for (let i = 0; i < n; i++) { g.fillStyle = cols[Math.floor(rnd() * cols.length)]; const s = 0.6 + rnd() * size; g.fillRect(rnd() * w, rnd() * h, s, s); } }
export const railUniforms = { uDay: { value: 1 } };
function materials() {
  if (MAT) return MAT;
  // ballast: grey-brown gravel with snow lying between the stones (tile 2 m)
  const ballastTex = canvasTex(256, 256, (g, w, h) => {
    const rnd = mulberry32(3311);
    g.fillStyle = '#76716a'; g.fillRect(0, 0, w, h);
    noiseFill(g, w, h, rnd, 9000, ['#5d5953', '#8d877e', '#4a4743', '#a39d93', '#6b665f'], 3.2);
    g.globalAlpha = 0.55;
    for (let i = 0; i < 90; i++) { const x = rnd() * w, y = rnd() * h, r = 4 + rnd() * 16; const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, '#f2f5fa'); gr.addColorStop(1, 'rgba(242,245,250,0)'); g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2); }
    g.globalAlpha = 1;
  }, { repeat: true });
  const ballast = new THREE.MeshStandardMaterial({ map: ballastTex, vertexColors: true, roughness: 0.95, metalness: 0, color: ballastTex ? 0xffffff : 0x76716a });
  const steel = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.38, metalness: 0.75 });
  const concrete = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.05 });
  // tunnel lining: shotcrete with ring joints (tile 6 x 6 m), lit by the lamps (aLight.x) and the daylight that
  // reaches in from the portals (aLight.y); inside, the sun and the sky barely reach
  const liningTex = canvasTex(256, 256, (g, w, h) => {
    const rnd = mulberry32(9107);
    g.fillStyle = '#8b8984'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 70; i++) { const x = rnd() * w, y = rnd() * h, r = 14 + rnd() * 34; const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, ['rgba(40,38,36,0.07)', 'rgba(255,255,255,0.06)', 'rgba(90,80,66,0.06)'][i % 3]); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2); }
    // faint streaks where water seeps down the shotcrete
    for (let i = 0; i < 26; i++) { const x = rnd() * w, y0 = rnd() * h, l = 20 + rnd() * 70; g.fillStyle = 'rgba(60,56,50,0.05)'; g.fillRect(x, y0, 1 + rnd() * 2, l); }
    noiseFill(g, w, h, rnd, 2600, ['rgba(255,255,255,0.07)', 'rgba(0,0,0,0.08)'], 1.0);
    for (const y of [0, h / 2]) { g.fillStyle = 'rgba(25,24,22,0.32)'; g.fillRect(0, y, w, 2); g.fillStyle = 'rgba(25,24,22,0.08)'; g.fillRect(0, y + 2, w, 5); }
  }, { repeat: true });
  const lining = new THREE.MeshStandardMaterial({ map: liningTex, vertexColors: true, roughness: 0.92, metalness: 0, color: liningTex ? 0xffffff : 0x8b8984 });
  lining.onBeforeCompile = (s) => {
    s.uniforms.uDay = railUniforms.uDay;
    s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nattribute vec2 aLight;\nvarying vec2 vLight;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLight = aLight;');
    s.fragmentShader = s.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uDay;\nvarying vec2 vLight;')
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        // inside the mountain only the portals let daylight in; uDay = 0 when the whole scene is dimmed for
        // the tunnel (then the lamps carry it)
        float dayK = vLight.y;
        reflectedLight.directDiffuse *= dayK;
        reflectedLight.directSpecular *= dayK;
        reflectedLight.indirectDiffuse *= mix(0.03, 1.0, dayK);
        reflectedLight.indirectSpecular *= mix(0.04, 1.0, dayK);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.93, 0.82) * (vLight.x * 1.15 + 0.02);`);
  };
  lining.customProgramCacheKey = () => 'rail-lining';
  const lamp = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xfff0d6, emissiveIntensity: 5, roughness: 0.4 });
  // portals and stations
  const stone = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
  const paint = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.1 });
  const wood = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x9fbfd6, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.25, envMapIntensity: 1.4, depthWrite: false, side: THREE.DoubleSide });
  const warm = new THREE.MeshStandardMaterial({ color: 0x332a22, emissive: 0xffc98a, emissiveIntensity: 0.4, roughness: 0.6 });
  const wire = new THREE.LineBasicMaterial({ color: 0x34383d });
  MAT = { ballast, steel, concrete, lining, lamp, stone, paint, wood, glass, warm, wire };
  return MAT;
}

// arc lengths from s0 to s1 about `step` apart, both ends included exactly: consecutive pieces built by separate
// calls (chunks, tunnel / hall / open stretches) share their end rings, so nothing ever leaves a gap
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
function samples(s0, s1, step) {
  const n = Math.max(1, Math.ceil((s1 - s0) / step - 1e-6)), out = [];
  for (let k = 0; k <= n; k++) out.push(k === n ? s1 : s0 + ((s1 - s0) * k) / n);
  return out;
}

// ------------------------------------------------------------------ builder (vertex colours, optional uv / light)
const _c = new THREE.Color();
// parsed vertex colours ('#rrggbb' -> linear rgb): the builders set hundreds of thousands of vertices
const COLS = new Map();
function rgb(col) {
  let c = COLS.get(col);
  if (!c) { _c.set(col); c = [_c.r, _c.g, _c.b]; COLS.set(col, c); }
  return c;
}
class B {
  constructor({ uv = false, light = false } = {}) { this.P = []; this.N = []; this.C = []; this.U = uv ? [] : null; this.L = light ? [] : null; this.I = []; }
  get n() { return this.P.length / 3; }
  v(x, y, z, nx, ny, nz, col, u = 0, w = 0, l0 = 0, l1 = 1) {
    this.P.push(x, y, z); this.N.push(nx, ny, nz); const c = rgb(col); this.C.push(c[0], c[1], c[2]);
    if (this.U) this.U.push(u, w);
    if (this.L) this.L.push(l0, l1);
    return this.n - 1;
  }
  quad(a, b, c, d) { this.I.push(a, b, c, a, c, d); }
  tri(a, b, c) { this.I.push(a, b, c); }
  // oriented box: centre, half extents along the axes ax (right), ay (up), az (forward)
  obox(cx, cy, cz, ax, ay, az, hx, hy, hz, col, colTop = col) {
    const P = (sx, sy, sz) => [cx + ax[0] * hx * sx + ay[0] * hy * sy + az[0] * hz * sz, cy + ax[1] * hx * sx + ay[1] * hy * sy + az[1] * hz * sz, cz + ax[2] * hx * sx + ay[2] * hy * sy + az[2] * hz * sz];
    const F = [[ax, [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]]], [[-ax[0], -ax[1], -ax[2]], [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]]],
      [ay, [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]]], [[-ay[0], -ay[1], -ay[2]], [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]]],
      [az, [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]], [[-az[0], -az[1], -az[2]], [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]]]];
    for (const [nrm, q] of F) {
      const c = nrm === ay ? colTop : col;
      const idx = q.map((s, k) => this.v(...P(...s), nrm[0], nrm[1], nrm[2], c, k === 1 || k === 2 ? 1 : 0, k >= 2 ? 1 : 0));
      this.quad(...idx);
    }
    return this;
  }
  box(cx, cy, cz, sx, sy, sz, col, colTop = col, yaw = 0) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    return this.obox(cx, cy, cz, [c, 0, -s], [0, 1, 0], [s, 0, c], sx / 2, sy / 2, sz / 2, col, colTop);
  }
  cylY(x, y0, z, r, h, seg, col) {
    const base = this.n;
    for (let i = 0; i <= seg; i++) { const a = (i / seg) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a); this.v(x + ca * r, y0, z + sa * r, ca, 0, sa, col); this.v(x + ca * r, y0 + h, z + sa * r, ca, 0, sa, col); }
    for (let i = 0; i < seg; i++) { const a = base + i * 2; this.quad(a, a + 1, a + 3, a + 2); }
    return this;
  }
  bar(a, b, r, col, seg = 5) {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2], len = Math.hypot(dx, dy, dz);
    if (len < 1e-4) return this;
    const t = [dx / len, dy / len, dz / len];
    const up = Math.abs(t[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    let u = [t[1] * up[2] - t[2] * up[1], t[2] * up[0] - t[0] * up[2], t[0] * up[1] - t[1] * up[0]];
    const ul = Math.hypot(...u); u = u.map((v) => v / ul);
    const w = [t[1] * u[2] - t[2] * u[1], t[2] * u[0] - t[0] * u[2], t[0] * u[1] - t[1] * u[0]];
    const base = this.n;
    for (let i = 0; i <= seg; i++) {
      const ang = (i / seg) * Math.PI * 2, ca = Math.cos(ang), sa = Math.sin(ang);
      const nx = u[0] * ca + w[0] * sa, ny = u[1] * ca + w[1] * sa, nz = u[2] * ca + w[2] * sa;
      this.v(a[0] + nx * r, a[1] + ny * r, a[2] + nz * r, nx, ny, nz, col);
      this.v(b[0] + nx * r, b[1] + ny * r, b[2] + nz * r, nx, ny, nz, col);
    }
    for (let i = 0; i < seg; i++) { const k = base + i * 2; this.quad(k, k + 2, k + 3, k + 1); }
    return this;
  }
  build() {
    if (!this.I.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.N, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.C, 3));
    if (this.U) g.setAttribute('uv', new THREE.Float32BufferAttribute(this.U, 2));
    if (this.L) g.setAttribute('aLight', new THREE.Float32BufferAttribute(this.L, 2));
    g.setIndex(this.n > 65535 ? new THREE.Uint32BufferAttribute(this.I, 1) : new THREE.Uint16BufferAttribute(this.I, 1));
    g.computeBoundingSphere();
    return g;
  }
}

// ------------------------------------------------------------------ the passing loop
// Between LOOP.s0 and LOOP.s1 a second track runs LOOP.off m to the right of the line (the down train takes
// it); the turnouts ease it out and back over LOOP.ease m.
export const LOOP = PASSING_LOOP; // (railroute.js: the timetable makes the trains meet on its middle)
// the top station's rock hall: from just before its platform to the end of the line (platform on its side)
export const HALL = (() => { const st = RAIL.stations.find((x) => x.id === 'platt'); return { s0: st.s0 - 10, side: st.side }; })();
export function loopOffset(s) {
  if (s <= LOOP.s0 || s >= LOOP.s1) return 0;
  return LOOP.off * smoothstep(LOOP.s0, LOOP.s0 + LOOP.ease, s) * (1 - smoothstep(LOOP.s1 - LOOP.ease, LOOP.s1, s));
}

// ------------------------------------------------------------------ track
// One track's ballast, sleepers, rails and rack between s0 and s1, `off` m to the right of the centre line
// (a function of s for the loop's turnouts).
const BALLAST_COL = '#ffffff', SLEEPER_COL = '#6f6a63', RAIL_COL = '#8e9399', RAIL_TOP = '#c9cdd2', RACK_COL = '#5b5f65';
function buildTrack(ballast, concrete, steel, s0, s1, offFn, { slab = false } = {}) {
  const f = {}, step = 2;
  const prof = slab
    ? [[-1.9, -0.42], [1.9, -0.42]] // concrete slab in tunnels
    : [[-2.25, -BED_DROP - 0.02], [-1.55, -0.36], [1.55, -0.36], [2.25, -BED_DROP - 0.02]];
  // ballast ribbon
  let prev = null, vAcc = 0;
  let sPrev = s0;
  for (const s of samples(s0, s1, step)) {
    frame(s, f);
    const off = offFn(s);
    const cx = f.x + f.rx * off, cz = f.z + f.rz * off;
    vAcc += s - sPrev; sPrev = s;
    const ring = prof.map(([x, y], k) => {
      const nx = k === 0 ? -0.6 : k === prof.length - 1 ? 0.6 : 0, ny = 1;
      return ballast.v(cx + f.rx * x, f.y + y, cz + f.rz * x, f.rx * nx, ny, f.rz * nx, slab ? '#a8a6a1' : BALLAST_COL, x / 2, vAcc / 2);
    });
    if (prev) for (let k = 0; k < ring.length - 1; k++) ballast.quad(prev[k], prev[k + 1], ring[k + 1], ring[k]);
    prev = ring;
  }
  // sleepers every 0.8 m (steel sleepers under the rack: dark, with the rack chairs)
  for (let s = s0 + 0.4; s < s1; s += 0.8) {
    frame(s, f);
    const off = offFn(s);
    const cx = f.x + f.rx * off, cz = f.z + f.rz * off;
    const ax = [f.rx, 0, f.rz], az = [f.tx, f.ty, f.tz], ay = [-(az[1] * ax[2] - az[2] * ax[1]) * -1, az[2] * ax[0] - az[0] * ax[2], -(az[0] * ax[1] - az[1] * ax[0]) * -1];
    const upv = [ay[0], Math.abs(ay[1]), ay[2]];
    concrete.obox(cx, f.y - 0.27, cz, ax, upv, az, 1.05, 0.06, 0.1, SLEEPER_COL);
  }
  // rails (head + web) and the ladder rack (two flats with dark rungs between)
  const railPts = [];
  for (const s of samples(s0, s1, step)) { frame(s, f); const off = offFn(s); railPts.push({ x: f.x + f.rx * off, y: f.y, z: f.z + f.rz * off, rx: f.rx, rz: f.rz }); }
  const sweep = (lat, sec, col, colTop = col) => {
    let pr = null;
    for (const p of railPts) {
      const ring = sec.map(([x, y]) => steel.v(p.x + p.rx * (lat + x), p.y + y, p.z + p.rz * (lat + x), p.rx * Math.sign(x), y > -0.03 ? 1 : 0, p.rz * Math.sign(x), y > -0.02 ? colTop : col));
      if (pr) for (let k = 0; k < ring.length - 1; k++) steel.quad(pr[k], pr[k + 1], ring[k + 1], ring[k]);
      pr = ring;
    }
  };
  const RAIL_SEC = [[-0.045, -0.15], [-0.045, -0.13], [-0.012, -0.12], [-0.012, -0.04], [-0.032, -0.03], [-0.032, 0], [0.032, 0], [0.032, -0.03], [0.012, -0.04], [0.012, -0.12], [0.045, -0.13], [0.045, -0.15]];
  for (const lat of [-GAUGE / 2, GAUGE / 2]) sweep(lat, RAIL_SEC, RAIL_COL, RAIL_TOP);
  const RACK_SEC = [[-0.07, -0.2], [-0.07, -0.03], [-0.05, -0.03], [-0.05, -0.2]];
  for (const lat of [-0.0, 0.12]) sweep(lat - 0.06, RACK_SEC, RACK_COL);
}

// ------------------------------------------------------------------ overhead line
function buildCatenary(steel, concrete, s0, s1, tunnel, offFn, wires = null, cols = null) {
  const f = {};
  const wireY = 5.0;
  // masts every 40 m on the left (outside the tunnels), cantilever arm over the track
  if (!tunnel) for (let s = Math.ceil(s0 / 40) * 40; s < s1; s += 40) {
    frame(s, f);
    const off = offFn(s);
    const side = -1, mx = f.x + f.rx * (side * 2.9 + Math.min(0, off)), mz = f.z + f.rz * (side * 2.9 + Math.min(0, off));
    const g = world.height(mx, mz);
    const top = f.y + 6.4;
    steel.box(mx, (g - 0.3 + top) / 2, mz, 0.22, top - g + 0.3, 0.22, '#5d646c', '#5d646c', f.heading);
    concrete.box(mx, g + 0.15, mz, 0.6, 0.5, 0.6, '#9a9893', '#9a9893', f.heading);
    cols?.push({ x: mx, z: mz, r: 0.3, h: top - g }); // solid (its foundation block's footprint)
    const ax = f.x + f.rx * off, az = f.z + f.rz * off;
    steel.bar([mx, top - 0.3, mz], [ax + f.rx * 0.6, top - 0.3, az + f.rz * 0.6], 0.05, '#5d646c');
    steel.bar([mx, f.y + wireY + 0.2, mz], [ax, f.y + wireY + 0.15, az], 0.035, '#5d646c');
    steel.bar([ax, top - 0.3, az], [ax, f.y + wireY + 0.15, az], 0.02, '#4c5258');
  }
  // contact wire (and the catenary wire above it outside the tunnels), sagging a little between masts
  let prev = null, prevC = null;
  for (const s of samples(s0, s1, 5)) {
    frame(s, f);
    const off = offFn(s);
    const ph = ((s % 40) + 40) % 40 / 40, sag = tunnel ? 0 : 0.35 * 4 * ph * (1 - ph);
    const p = [f.x + f.rx * off, f.y + wireY, f.z + f.rz * off];
    const c = [p[0], f.y + wireY + 0.9 - sag, p[2]];
    if (prev) steel.bar(prev, p, 0.012, '#3a3d40', 3);
    if (prevC && !tunnel) steel.bar(prevC, c, 0.012, '#3a3d40', 3);
    // the same wires as 1-pixel lines: far away the thin tubes break up into dashes, the lines stay unbroken
    if (wires && prev) { wires.push(...prev, ...p); if (!tunnel) wires.push(...prevC, ...c); }
    prev = p; prevC = c;
  }
}

// ------------------------------------------------------------------ tunnel tube
// Inner profile (x across, y up from the rail): vertical walls to the springline, an arch to the crown.
const TW = 2.55, TS = 3.4, TC = TUBE_H; // half width, springline, crown
function tubeProfile() {
  // a closed ring: the floor under the ballast, a raised walkway (cable duct) along each wall, the walls, the arch
  const WK = 2.25, WY = -0.22, FY = -0.8;
  const P = [[-WK, FY], [-WK, WY], [-TW, WY], [-TW, 0.8], [-TW, TS]];
  for (let k = 1; k < 14; k++) { const a = (k / 14) * Math.PI; P.push([-TW * Math.cos(a), TS + (TC - TS) * Math.sin(a)]); }
  P.push([TW, TS], [TW, 0.8], [TW, WY], [WK, WY], [WK, FY], [-WK, FY]);
  let L = 0;
  const arc = P.map((p, i) => (i ? (L += Math.hypot(p[0] - P[i - 1][0], p[1] - P[i - 1][1])) : 0));
  return { P, arc };
}
function buildTube(lining, lampB, tn, s0, s1, offFn, bracketB = lampB, heads = null) {
  const { P, arc } = tubeProfile();
  const f = {};
  const day = (s) => Math.max(1 - smoothstep(-2, 26, s - tn.s0), tn.end ? 0 : smoothstep(tn.s1 - 26, tn.s1 + 2, s));
  const lampEvery = 18;
  const lampAt = (s) => { const k = Math.round((s - tn.s0) / lampEvery); return tn.s0 + k * lampEvery; };
  let prev = null;
  for (const ss of samples(s0, s1, 1.5)) {
    frame(ss, f);
    const off = offFn(ss);
    const cx = f.x + f.rx * off, cz = f.z + f.rz * off;
    const dl = ss - lampAt(ss);
    const pool = Math.exp(-(dl * dl) / 18);
    const d = day(ss);
    // at a portal the tube is a little wider than the arch's opening through the facade's depth (1.6 m), then
    // narrows back: seen through the arch there is never a gap between the stone and the lining
    const toPortal = Math.min(ss - tn.s0, tn.end ? 1e9 : tn.s1 - ss);
    const flare = 1 - smoothstep(PORTAL_IN + 0.7, PORTAL_IN + 2.2, toPortal);
    const fx = 1 + flare * (0.3 / TW), fy = 1 + flare * (0.3 / TC);
    const ring = P.map(([x0, y0], k) => {
      const x = x0 * fx, y = y0 > 0 ? y0 * fy : y0;
      const a = P[Math.max(0, k - 1)], b = P[Math.min(P.length - 1, k + 1)];
      let nx = b[1] - a[1], ny = -(b[0] - a[0]); const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
      // (the ring runs left wall -> crown -> right wall -> floor: (dy, -dx) points into the tube)
      const low = 1 - smoothstep(0.1, 1.6, y), crown = smoothstep(TC - 1.4, TC, y);
      const g = 1 - low * 0.45 - crown * 0.15;
      const col = new THREE.Color(g, g * 0.99, g * 0.97).getHexString();
      // lamps on the left wall at 4.2 m: their pool falls on that wall, the floor and across
      const lampSide = x < 0 ? 1 : 0.55;
      const lit = Math.min(1, pool * lampSide * (0.35 + 0.65 * smoothstep(0, 4.5, y)) + pool * 0.25);
      return lining.v(cx + f.rx * x, f.y + y, cz + f.rz * x, f.rx * nx, ny, f.rz * nx, '#' + col, arc[k] / 6, ss / 6, lit, d);
    });
    if (prev) for (let k = 0; k < ring.length - 1; k++) lining.quad(prev[k], ring[k], ring[k + 1], prev[k + 1]);
    prev = ring;
  }
  // lamp fittings on the left wall: mounted on the lining's surface (4.0 m up, on the arch) with a bracket, the
  // glowing tube facing into the tunnel; the brackets are dark steel
  const LY = 4.0, wallX = -TW * Math.cos(Math.asin(clamp01((LY - TS) / (TC - TS))));
  for (let s = lampAt(s0); s <= s1; s += lampEvery) {
    if (s < s0 || s < tn.s0 + 6) continue;
    frame(s, f);
    const off = offFn(s);
    const ax = [f.rx, 0, f.rz], az = [f.tx, f.ty, f.tz], ay = [-f.ty * f.rz * 0 + 0, 1, 0];
    const at = (x, y) => [f.x + f.rx * (off + x), f.y + y, f.z + f.rz * (off + x)];
    bracketB.obox(...at(wallX + 0.07, LY), ax, ay, az, 0.07, 0.05, 0.08, '#2c3036');
    if (TLAMP && heads) {
      // the bank faces into the tunnel and 35 degrees down, its tube on the bracket's end
      bracketB.obox(...at(wallX + 0.25, LY), ax, ay, az, 0.19, 0.035, 0.035, '#3a3f46');
      const zA = new THREE.Vector3(f.rx * Math.cos(0.6), -Math.sin(0.6), f.rz * Math.cos(0.6)).normalize();
      const xA = new THREE.Vector3(f.tx, f.ty, f.tz).normalize();
      const yA = new THREE.Vector3().crossVectors(zA, xA).normalize();
      xA.crossVectors(yA, zA).normalize();
      const p = at(wallX + 0.44, LY - 0.06);
      const m = new THREE.Matrix4().makeBasis(xA, yA, zA).setPosition(p[0], p[1], p[2]);
      heads.push(m);
      // the four glowing floods, a hair in front of the glass
      for (const [x, y, hx, hy] of TLAMP.rects) {
        const c = new THREE.Vector3(x, y, TLAMP.front + 0.004).applyMatrix4(m);
        lampB.obox(c.x, c.y, c.z, [xA.x, xA.y, xA.z], [yA.x, yA.y, yA.z], [zA.x, zA.y, zA.z], hx, hy, 0.002, '#ffffff', '#ffffff');
      }
    } else {
      bracketB.obox(...at(wallX + 0.16, LY - 0.02), ax, ay, az, 0.05, 0.07, 0.62, '#3a3f46');
      lampB.obox(...at(wallX + 0.17, LY - 0.09), ax, ay, az, 0.04, 0.025, 0.56, '#ffffff', '#ffffff');
    }
  }
}

// ------------------------------------------------------------------ the tunnel luminaires (Meshy floodlight_head_c)
// The four-flood bank of pistelights.js, 0.62 m wide, thinned by vertex clustering (uv-aware), mounted on its
// bracket on the left wall facing into the tunnel and down onto the track; emissive quads on its four glasses.
let TLAMP = null;
export function setTunnelLampModel(head) {
  // head: meshyHead(gltf, spec) of pistelights.js ({ geometry, material, rects, front }) scaled to its width
  if (!head?.geometry || TLAMP) return TLAMP;
  const k = 0.9 / head.size[0];
  const g = head.geometry.clone();
  g.scale(k, k, k);
  // (in the tunnel the sun and the sky barely reach: the housing shows its own texture faintly lit by its floods)
  const mat = head.material.clone();
  if (mat.map) { mat.emissive = new THREE.Color(0xffffff); mat.emissiveMap = mat.map; mat.emissiveIntensity = 0.55; mat.map.anisotropy = 16; }
  TLAMP = { geo: clusterGeometry(g, 0.012, 64), mat, rects: head.rects.map(([x, y, hx, hy]) => [x * k, y * k, hx * k, hy * k]), front: head.front * k };
  return TLAMP;
}
function clusterGeometry(geo, cell, uvq) {
  const g = geo.index ? geo : geo;
  const pos = g.attributes.position, uv = g.attributes.uv, n = pos.count;
  const remap = new Int32Array(n), cells = new Map(), outP = [], outU = [];
  for (let i = 0; i < n; i++) {
    const key = Math.round(pos.getX(i) / cell) + ',' + Math.round(pos.getY(i) / cell) + ',' + Math.round(pos.getZ(i) / cell) + (uv ? ',' + Math.round(uv.getX(i) * uvq) + ',' + Math.round(uv.getY(i) * uvq) : '');
    let j = cells.get(key);
    if (j === undefined) { j = outP.length / 3; cells.set(key, j); outP.push(pos.getX(i), pos.getY(i), pos.getZ(i)); if (uv) outU.push(uv.getX(i), uv.getY(i)); }
    remap[i] = j;
  }
  const idx = g.index, tri = [], count = idx ? idx.count : n;
  for (let t = 0; t < count; t += 3) {
    const a = remap[idx ? idx.getX(t) : t], b = remap[idx ? idx.getX(t + 1) : t + 1], c = remap[idx ? idx.getX(t + 2) : t + 2];
    if (a !== b && b !== c && a !== c) tri.push(a, b, c);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(outP, 3));
  if (uv) out.setAttribute('uv', new THREE.Float32BufferAttribute(outU, 2));
  out.setIndex(tri);
  out.computeVertexNormals();
  out.computeBoundingSphere();
  return out;
}

// ------------------------------------------------------------------ the rock hall of the top station
// Under the glacier the tube opens into a vaulted hall: the platform on the station's side runs to the wall, a
// walkway on the other, a high vault with rows of lamps; a wall closes the hall's far end behind the buffer stop.
// HALL_X: the hall's walls (x across the line, + = right); the platform side's wall leaves room for a 5.6 m
// platform.
function hallProfile(side) {
  const xP = side * 7.4, xO = -side * 3.1; // platform-side wall, other wall
  const xL = Math.min(xP, xO), xR = Math.max(xP, xO), SPR = 4.4, CR = 8.6;
  const FY = -0.8, WY = -0.22;
  // the floor on the platform side lies under the platform slab; the walkway on the other side
  const P = side < 0
    ? [[-2.25, FY], [-2.25, -0.7], [xL, -0.7], [xL, SPR]]
    : [[-2.25, FY], [-2.25, WY], [xL, WY], [xL, SPR]];
  const cx = (xL + xR) / 2, rx = (xR - xL) / 2;
  for (let k = 1; k < 18; k++) { const a = (k / 18) * Math.PI; P.push([cx - rx * Math.cos(a), SPR + (CR - SPR) * Math.sin(a)]); }
  if (side < 0) P.push([xR, SPR], [xR, WY], [2.25, WY], [2.25, FY], [-2.25, FY]);
  else P.push([xR, SPR], [xR, -0.7], [2.25, -0.7], [2.25, FY], [-2.25, FY]);
  return P;
}
// resample a closed ring (first point == last) to n points by arc length
function resampleRing(P, n) {
  const acc = [0];
  for (let i = 1; i < P.length; i++) acc.push(acc[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
  const L = acc.at(-1), out = [];
  let j = 1;
  for (let k = 0; k <= n; k++) {
    const t = (k / n) * L;
    while (j < P.length - 1 && acc[j] < t) j++;
    const u = (t - acc[j - 1]) / (acc[j] - acc[j - 1] || 1);
    out.push([P[j - 1][0] + (P[j][0] - P[j - 1][0]) * u, P[j - 1][1] + (P[j][1] - P[j - 1][1]) * u]);
  }
  return out;
}
function buildHall(lining, lampB, tn, s0, s1, side, hallS0, hallS1, steelB = null) {
  const P = hallProfile(side);
  let L = 0;
  const arc = P.map((p, i) => (i ? (L += Math.hypot(p[0] - P[i - 1][0], p[1] - P[i - 1][1])) : 0));
  const f = {};
  const ringAt = (ss, prof, arcs, lit = 1) => {
    frame(ss, f);
    return prof.map(([x, y], k) => {
      const a = prof[Math.max(0, k - 1)], b = prof[Math.min(prof.length - 1, k + 1)];
      let nx = b[1] - a[1], ny = -(b[0] - a[0]); const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
      const low = 1 - smoothstep(0.1, 1.6, y), crown = smoothstep(6.5, 8.6, y);
      const g = 0.98 - low * 0.35 - crown * 0.1;
      const col = new THREE.Color(g, g * 0.985, g * 0.96).getHexString();
      return lining.v(f.x + f.rx * x, f.y + y, f.z + f.rz * x, f.rx * nx, ny, f.rz * nx, '#' + col, (arcs ? arcs[k] : 0) / 6, ss / 6, lit, 0);
    });
  };
  let prev = null;
  for (const ss of samples(s0, s1, 2)) {
    const ring = ringAt(ss, P, arc, 0.95);
    if (prev) for (let k = 0; k < ring.length - 1; k++) lining.quad(prev[k], ring[k], ring[k + 1], prev[k + 1]);
    prev = ring;
  }
  // the hall's entrance wall: from the tube's ring to the hall's (facing back down the line)
  if (s0 <= hallS0 + 1e-6) {
    const N = 72, outer = resampleRing(P, N), inner = resampleRing(tubeProfile().P, N);
    const o = ringAt(hallS0, outer, null, 0.7), i = ringAt(hallS0, inner, null, 0.7);
    frame(hallS0, f);
    for (let k = 0; k < N; k++) lining.quad(o[k], o[k + 1], i[k + 1], i[k]);
  }
  // the far end wall behind the buffer stop
  if (s1 >= hallS1 - 1e-6) {
    const ring = ringAt(hallS1, P, null, 0.8);
    frame(hallS1, f);
    const c = lining.v(f.x + f.rx * (side * 2.2), f.y + 4, f.z + f.rz * (side * 2.2), -f.tx, 0, -f.tz, '#d8d6d0', 0, 0, 0.8, 0);
    for (let k = 0; k < ring.length - 1; k++) lining.tri(ring[k + 1], ring[k], c);
  }
  // two rows of lamp strips along the vault
  for (let s = Math.max(s0, hallS0 + 4); s < Math.min(s1, hallS1 - 2); s += 6) {
    frame(s, f);
    for (const x of [side * 1.8, side * 5.0]) {
      // hung from the vault on two rods
      const y = 7.2 + (Math.abs(x) < 3 ? 0.9 : 0);
      lampB.box(f.x + f.rx * x, f.y + y, f.z + f.rz * x, 0.22, 0.08, 4.2, '#ffffff', '#ffffff', f.heading);
      if (steelB) for (const dz of [-1.6, 1.6]) {
        const px = f.x + f.rx * x + f.tx * dz, pz = f.z + f.rz * x + f.tz * dz, py = f.y + y + f.ty * dz;
        steelB.bar([px, py + 0.04, pz], [px, py + 1.1, pz], 0.012, '#30343a', 4);
      }
    }
  }
}

// ------------------------------------------------------------------ terrain clip volumes (terrain.js setTerrainClips)
// Just behind each portal the terrain rises from the cutting to the cover over the tube (on its 2 m mesh that rise
// runs through the tube, and a cab would pass through it): no terrain inside the tube's profile (the lining's own
// arch; at the portal the lining flares wider and the arch's stones ring it), from the portal plane to past the rise.
export function portalClips() {
  const out = [], f = {};
  const half = (PORTAL_IN + 4.6) / 2;
  for (const tn of RAIL.tunnels) for (const which of tn.end ? [0] : [0, 1]) {
    const into = which === 0 ? 1 : -1;
    frame((which === 0 ? tn.s0 : tn.s1) + into * (half - 0.3), f);
    const h = Math.hypot(f.tx, f.tz);
    out.push({ x: f.x, y: f.y, z: f.z, grade: f.grade, tx: f.tx / h, tz: f.tz / h, a0: -half, a1: half, hw: TW, v0: -0.45, vS: TS, v1: TC });
  }
  return out;
}

// ------------------------------------------------------------------ portal facade
let MOUTH = null;
function mouthMaterial() {
  MOUTH ??= mouthFade(new THREE.MeshBasicMaterial({ color: 0x040506, side: THREE.FrontSide }));
  return MOUTH;
}
/**
 * A portal's dark mouth is only for the view from afar: from within ~70 m it dissolves (screen-door dither, gone by
 * 40 m), so a camera riding / skiing / walking into the tunnel never meets a black wall over the opening (or the
 * train ahead of it vanishing into one) -- up close the tube's own lining, dim past the daylit first metres, shows.
 */
function mouthFade(mat, near = 40, far = 70) {
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vMouthW;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvMouthW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vMouthW;')
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
      float mouthK = smoothstep(${near.toFixed(1)}, ${far.toFixed(1)}, distance(vMouthW, cameraPosition));
      if (mouthK < 1.0 && fract(sin(dot(floor(gl_FragCoord.xy), vec2(12.9898, 78.233))) * 43758.5453) >= mouthK) discard;`);
  };
  mat.customProgramCacheKey = () => `mouth-fade-${near}-${far}`;
  return mat;
}
function buildPortal(stone, paint, tn, which, name) {
  const s = which === 0 ? tn.s0 : tn.s1, f = frame(s, {});
  const dir = which === 0 ? -1 : 1; // the facade faces out of the tunnel
  const fx = f.tx * dir, fz = f.tz * dir;
  // the portal's own frame (x across, y up, z out of the tunnel) is right-handed at both ends of a tunnel: at an exit
  // portal "across" runs the other way (or every face of the stonework would be turned inside out)
  const rX = f.rx * -dir, rZ = f.rz * -dir;
  const g = new B();
  const W = TW + 0.25, Hc = TC + 0.25, D = PORTAL_IN + 0.4, wallW = W + 4.5, wallH = Hc + 3.2;
  // facade wall with the arched opening: built as slabs around the opening
  const ax = [rX, 0, rZ], ay = [0, 1, 0], az = [fx, 0, fz];
  const at = (x, y, zz) => [f.x + rX * x + fx * zz, f.y + y, f.z + rZ * x + fz * zz];
  const C = '#8f8c86', C2 = '#7c7974', CAP = '#b0ada6';
  // side walls of the facade (left / right of the opening), sloping wing walls, the lintel over the arch
  for (const sx of [-1, 1]) {
    const cx = sx * (W + (wallW - W) / 2);
    g.obox(...at(cx, wallH / 2 - 1.2, -D / 2), ax, ay, az, (wallW - W) / 2, wallH / 2 + 1.2, D / 2, C, CAP);
    // wing walls angled back into the slope
    const wing = at(sx * (wallW + 3.2), (wallH - 2.5) / 2 - 1.2, -D / 2 + 2.5);
    g.obox(...wing, [rX * Math.cos(0.5) * sx + fx * Math.sin(0.5), 0, rZ * Math.cos(0.5) * sx + fz * Math.sin(0.5)].map((v, i) => (i === 1 ? 0 : v)), ay, az, 3.3, (wallH - 2.5) / 2 + 1.2, D / 2, C2, CAP);
  }
  // arch: voussoir blocks round the opening, the lintel above
  const n = 17;
  for (let k = 0; k < n; k++) {
    const a0 = (k / n) * Math.PI, a1 = ((k + 1) / n) * Math.PI, am = (a0 + a1) / 2;
    const r = Math.hypot(W, Hc - TS);
    const x = -W * Math.cos(am) * 1.0, y = TS + (Hc - TS) * Math.sin(am);
    const nx = -Math.cos(am), ny = Math.sin(am) * (W / (Hc - TS));
    const nl = Math.hypot(nx, ny);
    const ux = nx / nl, uy = ny / nl;
    const p = at(x + ux * 0.45, y + uy * 0.45, 0.05);
    const ax2 = [rX * uy * -1 * -1, 0, 0];
    void r; void ax2;
    const tang = [-uy, ux];
    const AX = [rX * tang[0], tang[1], rZ * tang[0]], AY = [rX * ux, uy, rZ * ux];
    g.obox(...p, AX, AY, az, ((a1 - a0) * W) / 2 + 0.02, 0.45, D / 2 + 0.15, k % 2 ? '#a19d96' : '#97938c');
  }
  g.obox(...at(0, Hc + (wallH - Hc) / 2 + 0.35, -D / 2), ax, ay, az, W, (wallH - Hc) / 2 - 0.35, D / 2, C, CAP);
  // jambs from the floor to the springline
  for (const sx of [-1, 1]) g.obox(...at(sx * (W + 0.35), (TS - 0.6) / 2, 0.02), ax, ay, az, 0.35, (TS + 0.6) / 2, D / 2 + 0.15, '#a19d96');
  // coping with snow
  g.obox(...at(0, wallH - 1.2 + 0.18, -D / 2), ax, ay, az, wallW + 0.3, 0.18, D / 2 + 0.25, CAP, '#f1f5fa');
  const mesh = new THREE.Mesh(g.build(), stone);
  mesh.castShadow = true; mesh.receiveShadow = true;
  const grp = new THREE.Group();
  grp.add(mesh);
  // the dark mouth: the opening's shape, just inside the arch, facing out (single-sided: from inside the tunnel you
  // look straight through it). From outside a tunnel is dark inside, and the terrain's rise from the cutting to the
  // cover over the tube (just behind the portal plane, on the 2 m terrain mesh) never shows in the opening.
  {
    const m = new B();
    const ring = [];
    const n = 20;
    ring.push([-W - 0.05, -0.9]);
    for (let k = 0; k <= n; k++) { const a = Math.PI - (k / n) * Math.PI; ring.push([W * Math.cos(a) * 1.02, TS + (Hc - TS) * Math.sin(a) + 0.05]); }
    ring.push([W + 0.05, -0.9]);
    const zz = 0.08; // just inside the portal plane
    const c = m.v(...at(0, TS * 0.5, -zz), fx, 0, fz, '#050607');
    const vs = ring.map(([x, y]) => m.v(...at(x, y, -zz), fx, 0, fz, '#050607'));
    for (let k = 0; k < vs.length - 1; k++) m.tri(c, vs[k + 1], vs[k]);
    const mouth = new THREE.Mesh(m.build(), mouthMaterial());
    mouth.renderOrder = 1;
    grp.add(mouth);
  }
  // name plaque over the arch
  const tex = canvasTex(1024, 192, (c, w, h) => {
    c.fillStyle = '#1d2229'; c.fillRect(0, 0, w, h);
    c.strokeStyle = '#e9edf3'; c.lineWidth = 8; c.strokeRect(10, 10, w - 20, h - 20);
    c.fillStyle = '#f2f5fa'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.font = `italic 700 104px ${FONT}`;
    c.fillText(name.toUpperCase(), w / 2, h / 2 + 4);
  });
  if (tex) {
    const pl = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 0.86), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5 }));
    const p = at(0, Hc + 1.05, 0.06);
    pl.position.set(...p);
    pl.rotation.y = Math.atan2(fx, fz);
    grp.add(pl);
  }
  void paint;
  return grp;
}

// ------------------------------------------------------------------ viaduct
// Stone arch viaduct: piers every ~18 m down to the ground, round arches between them, the deck with parapets.
function buildViaduct(stone, b, cols = null) {
  const g = new B();
  const f = {}, f2 = {};
  const span = 18;
  const n = Math.max(1, Math.round((b.s1 - b.s0) / span));
  const sp = (b.s1 - b.s0) / n;
  const C = '#8a857c', C2 = '#9a958b', CAP = '#b3aea4';
  for (let k = 0; k <= n; k++) {
    const s = b.s0 + k * sp;
    frame(s, f);
    const g0 = Math.min(world.height(f.x - f.rx * 2, f.z - f.rz * 2), world.height(f.x + f.rx * 2, f.z + f.rz * 2));
    const top = f.y - 0.9;
    if (top - g0 < 1) continue;
    const ax = [f.rx, 0, f.rz], ay = [0, 1, 0], az = [Math.sin(f.heading), 0, Math.cos(f.heading)];
    // pier: battered (wider at the foot)
    const h = top - g0 + 1.5;
    g.obox(f.x, g0 - 1.5 + h / 2, f.z, ax, ay, az, 2.6 + h * 0.03, h / 2, 1.3 + h * 0.015, k % 2 ? C : C2, CAP);
    cols?.push({ x: f.x, z: f.z, hw: 2.6 + h * 0.03, hd: 1.3 + h * 0.015, rot: -f.heading, h: top - g0, top }); // (the pier: solid from the ground; walked over on the deck)
  }
  for (let k = 0; k < n; k++) {
    const sa = b.s0 + k * sp, sb = sa + sp;
    // the arch: a ring of blocks under the deck between two piers
    const m = 12;
    for (let j = 0; j < m; j++) {
      const t0 = j / m, t1 = (j + 1) / m;
      const s0 = sa + (sb - sa) * t0, s1 = sa + (sb - sa) * t1;
      frame(s0, f); frame(s1, f2);
      const a0 = Math.PI * t0, a1 = Math.PI * t1;
      const rise = Math.min(sp * 0.42, Math.max(2, f.y - 1 - world.height(f.x, f.z)));
      const y0 = f.y - 1.0 - rise * (1 - Math.sin(a0)) - 0.2, y1 = f2.y - 1.0 - rise * (1 - Math.sin(a1)) - 0.2;
      const cx = (f.x + f2.x) / 2, cz = (f.z + f2.z) / 2, cy = (y0 + y1) / 2;
      const len = Math.hypot(f2.x - f.x, y1 - y0, f2.z - f.z);
      const az = [(f2.x - f.x) / len, (y1 - y0) / len, (f2.z - f.z) / len];
      const ax = [f.rx, 0, f.rz];
      const ay = [ax[1] * az[2] - ax[2] * az[1], ax[2] * az[0] - ax[0] * az[2], ax[0] * az[1] - ax[1] * az[0]];
      if (ay[1] < 0) { ay[0] *= -1; ay[1] *= -1; ay[2] *= -1; }
      g.obox(cx, cy - 0.35, cz, ax, ay, az, 2.45, 0.4, len / 2 + 0.03, j % 2 ? C2 : C);
      // spandrel wall filling between the arch and the deck
      const top = (f.y + f2.y) / 2 - 1.0;
      if (top - cy > 0.4) g.obox(cx, (cy + top) / 2, cz, ax, [0, 1, 0], [az[0], 0, az[2]].map((v, i, arr) => v / Math.hypot(arr[0], arr[2]) * (i === 1 ? 0 : 1)), 2.45, (top - cy) / 2, len / 2 + 0.05, C);
    }
  }
  // deck slab + parapets
  let pr = null;
  for (const s of samples(b.s0, b.s1, 2)) {
    frame(s, f);
    const ring = [[-2.7, -1.0], [-2.7, 0.55], [-2.45, 0.55], [-2.45, -0.4], [2.45, -0.4], [2.45, 0.55], [2.7, 0.55], [2.7, -1.0]]
      .map(([x, y], k) => g.v(f.x + f.rx * x, f.y + y, f.z + f.rz * x, f.rx * (k < 4 ? -1 : 1) * (y < 0.5 ? 1 : 0), y >= 0.5 ? 1 : 0, f.rz * (k < 4 ? -1 : 1) * (y < 0.5 ? 1 : 0), y >= 0.5 ? CAP : C));
    if (pr) for (let k = 0; k < ring.length - 1; k++) g.quad(pr[k], pr[k + 1], ring[k + 1], ring[k]);
    pr = ring;
  }
  const mesh = new THREE.Mesh(g.build(), stone);
  mesh.castShadow = true; mesh.receiveShadow = true;
  return mesh;
}

// ------------------------------------------------------------------ the whole line
/**
 * Build the line's meshes. Returns { group, chunks: [{ group, x, z, r, far }], update(cameraPosition),
 * stations: [{ id, ... world positions for signs / props }] }.
 */
export function buildRailway(scene) {
  const M = materials();
  const group = new THREE.Group();
  group.name = 'wolkenspitzbahn';
  const chunks = [], cols = []; // cols: the masts' and the viaduct piers' colliders (railway.js registers them)
  const L = RAIL;
  const tunnels = L.tunnels;
  // chunk the line
  for (let c0 = 0; c0 < L.length; c0 += CHUNK) {
    const c1 = Math.min(L.length, c0 + CHUNK);
    const cg = new THREE.Group();
    const ballast = new B({ uv: true }), concrete = new B(), steel = new B(), lining = new B({ uv: true, light: true }), lampB = new B();
    const wires = [], heads = [];
    // split the chunk into open / tunnel stretches
    const cuts = [c0];
    for (const t of tunnels) { if (t.s0 > c0 && t.s0 < c1) cuts.push(t.s0); if (t.s1 > c0 && t.s1 < c1) cuts.push(t.s1); }
    cuts.push(c1);
    cuts.sort((a, b) => a - b);
    for (let k = 0; k < cuts.length - 1; k++) {
      const a = cuts[k], b = cuts[k + 1];
      if (b - a < 0.5) continue;
      const mid = (a + b) / 2;
      const tn = tunnels.find((t) => mid > t.s0 && mid < t.s1);
      buildTrack(ballast, concrete, steel, a, b, () => 0, { slab: !!tn });
      buildCatenary(steel, concrete, a, b, !!tn, () => 0, wires, cols);
      if (tn && tn.end && b > HALL.s0) {
        // the top station's rock hall at the end of the line
        if (a < HALL.s0) buildTube(lining, lampB, tn, a, HALL.s0, () => 0, steel, heads);
        buildHall(lining, lampB, tn, Math.max(a, HALL.s0), b, HALL.side, HALL.s0, tn.s1, steel);
      } else if (tn) buildTube(lining, lampB, tn, a, b, () => 0, steel, heads);
    }
    // the passing loop's second track
    const la = Math.max(c0, LOOP.s0), lb = Math.min(c1, LOOP.s1);
    if (lb > la) {
      buildTrack(ballast, concrete, steel, la, lb, loopOffset);
      buildCatenary(steel, concrete, la, lb, false, loopOffset, wires, cols);
    }
    const add = (bd, mat, { cast = true, receive = true } = {}) => {
      const geo = bd.build();
      if (!geo) return null;
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = cast; m.receiveShadow = receive;
      m.matrixAutoUpdate = false;
      cg.add(m);
      return m;
    };
    add(ballast, M.ballast, { cast: false });
    const concreteMesh = add(concrete, M.concrete);
    const steelMesh = add(steel, M.steel);
    const liningMesh = add(lining, M.lining, { cast: false });
    const lampMesh = add(lampB, M.lamp, { cast: false });
    let headMesh = null;
    if (TLAMP && heads.length) {
      headMesh = new THREE.InstancedMesh(TLAMP.geo, TLAMP.mat, heads.length);
      heads.forEach((m, i) => headMesh.setMatrixAt(i, m));
      headMesh.instanceMatrix.needsUpdate = true;
      headMesh.castShadow = false; headMesh.receiveShadow = false;
      headMesh.computeBoundingSphere();
      cg.add(headMesh);
    }
    if (wires.length) {
      const wg = new THREE.BufferGeometry();
      wg.setAttribute('position', new THREE.Float32BufferAttribute(wires, 3));
      wg.computeBoundingSphere();
      const wl = new THREE.LineSegments(wg, M.wire);
      wl.matrixAutoUpdate = false;
      cg.add(wl);
    }
    const mid = railAt((c0 + c1) / 2, {});
    // the tunnel lining deep inside the mountain is only drawn with the camera close by, inside a tunnel or near a
    // portal (where you can look in): from the village the Adlerhorn-Tunnel's middle never costs a triangle
    const portalHere = tunnels.some((t) => (c1 > t.s0 - 10 && c0 < t.s0 + 140) || (!t.end && c1 > t.s1 - 140 && c0 < t.s1 + 10));
    const inner = (liningMesh || lampMesh) && !portalHere ? [liningMesh, lampMesh, headMesh].filter(Boolean) : null;
    // the small parts (sleepers, rails, rack, masts, cantilevers) only within MID m: beyond that they are under a
    // pixel wide, the ballast bed and the wires (1 px lines) carry the line
    const detail = [concreteMesh, steelMesh].filter(Boolean);
    chunks.push({ group: cg, x: mid.x, z: mid.z, y: mid.y, r: CHUNK * 0.7, far: false, inner, detail });
    group.add(cg);
  }
  // portals (visible from afar)
  for (const t of tunnels) {
    for (const which of t.end ? [0] : [0, 1]) {
      const p = buildPortal(M.stone, M.paint, t, which, t.name);
      p.name = 'rail-portal'; // (main.js: world/solidify.js gives its walls colliders)
      const s = which ? t.s1 : t.s0, q = railAt(s, {});
      chunks.push({ group: p, x: q.x, z: q.z, r: 30, far: true });
      group.add(p);
    }
  }
  // viaducts
  for (const b of L.bridges || []) {
    const v = buildViaduct(M.stone, b, cols);
    v.name = 'rail-viaduct'; // (main.js: world/solidify.js gives its parapets colliders; the deck is walked on)
    const q = railAt((b.s0 + b.s1) / 2, {});
    chunks.push({ group: v, x: q.x, z: q.z, r: (b.s1 - b.s0) / 2 + 20, far: true });
    group.add(v);
  }
  scene?.add(group);
  // portals: from near one (or from inside a tunnel) the whole tube can be in view
  const portals = [];
  for (const t of tunnels) for (const s of t.end ? [t.s0] : [t.s0, t.s1]) { const q = railAt(s, {}); portals.push([q.x, q.y, q.z]); }
  const update = (cam, { inTunnel = false } = {}) => {
    const byPortal = inTunnel || portals.some(([x, y, z]) => Math.abs(cam.x - x) < 260 && Math.abs(cam.z - z) < 260 && Math.hypot(cam.x - x, cam.y - y, cam.z - z) < 260);
    for (const c of chunks) {
      const d = Math.hypot(cam.x - c.x, cam.z - c.z) - c.r;
      const vis = d < (c.far ? FAR : NEAR);
      if (c.group.visible !== vis) c.group.visible = vis;
      if (vis && c.detail?.length) {
        const det = d < MID;
        if (c.detail[0].visible !== det) for (const m of c.detail) m.visible = det;
      }
      if (vis && c.inner) {
        const near = byPortal || (d < 160 && Math.abs(cam.y - c.y) < 120);
        if (c.inner[0].visible !== near) for (const m of c.inner) m.visible = near;
      }
    }
  };
  return { group, chunks, update, materials: M, colliders: cols };
}
export { B as RailBuilder, materials as railMaterials, canvasTex, mouthFade };
