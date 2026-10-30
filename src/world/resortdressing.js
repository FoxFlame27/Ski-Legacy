// Resort dressing: what makes the slopes read like a real ski area. Piste signposts (colour-coded arrow
// boards at every piste start, fork and junction, naming where each run takes you; gondola signs at the base
// stations, wayfinding in the village), border markers every ~25 m down both edges of every piste, the continuous
// fences along every run (pistefence.js: B-nets / rope lines, instanced), safety nets wherever a run borders a hazard (orange B-nets, tall red
// A-nets at cliffs) with snow drifts at their base, the World Cup courses' finish arenas (nets both sides,
// blue dye lines, start house, finish arch, grandstand, timing board), the ski lanes' SKI LANE entry banners
// (their nets come with the others), ski patrol huts at the summits and sun-terrace furniture at the huts.
// Repeated props are instanced or merged into a few draw calls, and everything sits on the terrain.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { world } from './world.js';
import { layout, PISTE_WIDTH, cannonSpots, VILLAGE_BUILDINGS } from './layout.js';
import { fitModel, bakeGeometry } from '../core/assets.js';
import { drawnHeight } from './settle.js';
import { hash2 } from '../core/noise.js';
import { sponsorAtlas, bannerUV, pickBanner } from './sponsors.js';
import { quality, onQualityChange } from '../engine/quality.js';
import { propSeats, registerBench } from '../game/seating.js';
import { buildPisteFences } from './pistefence.js';
import { meshGround } from '../modes/parkour/kit.js';

const HAS_DOM = typeof document !== 'undefined';
export const SIGN_FONT = '"Barlow Condensed", "Arial Narrow", "Helvetica Neue", Arial, sans-serif';
// piste colours as on the trail maps (green / blue / red / black)
export const PISTE_COLORS = ['#1f9d4a', '#1f5fd6', '#d42525', '#161616'];
const HOUSE_BLUE = '#1546c8';
const MARKER_ORANGE = '#ff6a12';
const ALT0 = 1245; // the village sits at 1,245 m (the Legacy Gondola sign reads "Summit 2,350 m")

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1);
const _e = new THREE.Euler(), _c = new THREE.Color();

// ------------------------------------------------------------------ geometry helpers
// Bake a primitive into world space with a flat vertex colour (merged later into one draw call).
function baked(geo, matrix, color) {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  g.applyMatrix4(matrix);
  const n = g.attributes.position.count, col = new Float32Array(n * 3);
  _c.set(color);
  for (let i = 0; i < n; i++) { col[i * 3] = _c.r; col[i * 3 + 1] = _c.g; col[i * 3 + 2] = _c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  return g;
}
const mat4 = (x, y, z, yaw = 0, pitch = 0, roll = 0, sx = 1, sy = 1, sz = 1) =>
  new THREE.Matrix4().compose(_p.set(x, y, z), _q.setFromEuler(_e.set(pitch, yaw, roll, 'YXZ')), _s.set(sx, sy, sz));
function mergedMesh(parts, material, { cast = true, receive = true } = {}) {
  if (!parts.length) return null;
  const geo = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = cast; mesh.receiveShadow = receive;
  mesh.matrixAutoUpdate = false;
  return mesh;
}
const vcMat = (o = {}) => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0, ...o });

/**
 * Merge world-space geometries that share one material into a single static mesh (one draw call).
 * Attributes are reduced to position / normal / uv so primitives of different kinds merge cleanly.
 */
export function mergeParts(parts, material, opts) {
  return mergedMesh(parts.map((g) => {
    const h = new THREE.BufferGeometry();
    const src = g.index ? g.toNonIndexed() : g;
    for (const k of ['position', 'normal', 'uv']) if (src.attributes[k]) h.setAttribute(k, src.attributes[k]);
    if (!h.attributes.normal) h.computeVertexNormals();
    if (!h.attributes.uv) h.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(h.attributes.position.count * 2), 2));
    return h;
  }), material, opts);
}

// Lowest terrain under a small footprint, so a prop never floats on a slope (it sinks a touch instead).
// the lowest snow as drawn (the terrain's 2 m mesh) under a round footprint: a flat-bottomed prop set there
// never hangs over the downhill side
function groundMin(x, z, r) {
  let h = drawnHeight(x, z);
  for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; h = Math.min(h, drawnHeight(x + Math.cos(a) * r, z + Math.sin(a) * r)); }
  return h;
}

// canvas texture (null in Node); repainted once the condensed sign font has loaded
function canvasTex(w, h, draw, { wrap = false } = {}) {
  if (!HAS_DOM) return null;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const paint = () => { const g = c.getContext('2d'); g.clearRect(0, 0, w, h); draw(g, w, h); };
  paint();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (wrap) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  const probe = `italic 700 40px ${SIGN_FONT}`;
  if (document.fonts && !document.fonts.check(probe)) document.fonts.load(probe).then(() => { paint(); t.needsUpdate = true; }).catch(() => {});
  return t;
}

// ------------------------------------------------------------------ polyline helpers
function arcLengths(pts) {
  const acc = [0];
  for (let i = 1; i < pts.length; i++) acc.push(acc[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return acc;
}
// position + unit direction at arc length s
function sampleAt(pts, acc, s) {
  let i = 1;
  while (i < pts.length - 1 && acc[i] < s) i++;
  const a = pts[i - 1], b = pts[i], l = acc[i] - acc[i - 1] || 1, t = Math.min(1, Math.max(0, (s - acc[i - 1]) / l));
  const dx = (b[0] - a[0]) / l, dz = (b[1] - a[1]) / l;
  return { x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, dx, dz };
}
// Spatial hash of all piste centre lines: distance to the nearest *other* piste, minus its half-width.
class PisteIndex {
  constructor(pistes) {
    this.cell = 48; this.map = new Map();
    for (const p of pistes) {
      const w = PISTE_WIDTH[p.diff];
      for (let i = 1; i < p.pts.length; i++) {
        const seg = { p, w, ax: p.pts[i - 1][0], az: p.pts[i - 1][1], bx: p.pts[i][0], bz: p.pts[i][1] };
        const x0 = Math.floor((Math.min(seg.ax, seg.bx) - w - 30) / this.cell), x1 = Math.floor((Math.max(seg.ax, seg.bx) + w + 30) / this.cell);
        const z0 = Math.floor((Math.min(seg.az, seg.bz) - w - 30) / this.cell), z1 = Math.floor((Math.max(seg.az, seg.bz) + w + 30) / this.cell);
        for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
          const k = cx + ',' + cz;
          let arr = this.map.get(k);
          if (!arr) this.map.set(k, (arr = []));
          arr.push(seg);
        }
      }
    }
  }
  // signed clearance from (x, z) to the groomed area of any piste except `skip`
  clearance(x, z, skip = null) {
    const arr = this.map.get(Math.floor(x / this.cell) + ',' + Math.floor(z / this.cell));
    let best = 1e9;
    if (!arr) return best;
    for (const s of arr) {
      if (s.p === skip) continue;
      const ex = s.bx - s.ax, ez = s.bz - s.az, l2 = ex * ex + ez * ez || 1;
      const t = Math.min(1, Math.max(0, ((x - s.ax) * ex + (z - s.az) * ez) / l2));
      const d = Math.hypot(s.ax + ex * t - x, s.az + ez * t - z) - s.w;
      if (d < best) best = d;
    }
    return best;
  }
  // distance from (x, z) to piste `p`'s centre line
  distTo(x, z, p) {
    const arr = this.map.get(Math.floor(x / this.cell) + ',' + Math.floor(z / this.cell));
    let best = 1e9;
    if (!arr) return best;
    for (const s of arr) {
      if (s.p !== p) continue;
      const ex = s.bx - s.ax, ez = s.bz - s.az, l2 = ex * ex + ez * ez || 1;
      const t = Math.min(1, Math.max(0, ((x - s.ax) * ex + (z - s.az) * ez) / l2));
      best = Math.min(best, Math.hypot(s.ax + ex * t - x, s.az + ez * t - z));
    }
    return best;
  }
}
// Point hash of all safety-net lines (markers and signs keep clear of them).
class NetIndex {
  constructor(nets) {
    this.map = new Map();
    for (const n of nets) for (const [x, z] of n.line) {
      const k = Math.floor(x / 16) + ',' + Math.floor(z / 16);
      let arr = this.map.get(k);
      if (!arr) this.map.set(k, (arr = []));
      arr.push(x, z);
    }
  }
  near(x, z, r) {
    const cx = Math.floor(x / 16), cz = Math.floor(z / 16);
    for (let i = cx - 1; i <= cx + 1; i++) for (let j = cz - 1; j <= cz + 1; j++) {
      const arr = this.map.get(i + ',' + j);
      if (!arr) continue;
      for (let k = 0; k < arr.length; k += 2) if (Math.abs(arr[k] - x) < r && Math.abs(arr[k + 1] - z) < r && Math.hypot(arr[k] - x, arr[k + 1] - z) < r) return true;
    }
    return false;
  }
}

// ------------------------------------------------------------------ sign atlas
// All sign faces share one canvas texture. Each piste gets a right- and a left-pointing arrow board
// (the back of a board shows its mirror twin, so text always reads correctly); lift signs are plain.
const BOARD = { len: 1.06, h: 0.235, tip: 0.17, depth: 0.032 };
class SignAtlas {
  constructor() {
    this.W = 1024; this.items = []; this.x = 0; this.y = 0; this.rowH = 0;
  }
  add(w, h, draw) {
    if (this.x + w > this.W) { this.x = 0; this.y += this.rowH + 4; this.rowH = 0; }
    const it = { x: this.x, y: this.y, w, h, draw };
    this.items.push(it);
    this.x += w + 4; this.rowH = Math.max(this.rowH, h);
    return it;
  }
  finish() {
    this.H = 1 << Math.ceil(Math.log2(this.y + this.rowH + 4));
    for (const it of this.items) it.uv = { u0: it.x / this.W, u1: (it.x + it.w) / this.W, v0: 1 - (it.y + it.h) / this.H, v1: 1 - it.y / this.H };
    if (!HAS_DOM) return null;
    const c = document.createElement('canvas');
    c.width = this.W; c.height = this.H;
    const paint = () => {
      const g = c.getContext('2d');
      g.clearRect(0, 0, c.width, c.height);
      for (const it of this.items) { g.save(); g.translate(it.x, it.y); it.draw(g, it.w, it.h); g.restore(); }
    };
    paint();
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    // the condensed sign font may still be loading: repaint once it is there
    const probe = `700 40px ${SIGN_FONT}`;
    if (document.fonts && !document.fonts.check(probe)) {
      document.fonts.load(probe).then(() => { paint(); tex.needsUpdate = true; }).catch(() => {});
    }
    return tex;
  }
}

// arrow board outline in board units (x along the board from the post, y up), pointing +x
function boardOutline(L, H, tip) {
  return [[0, -H / 2], [L - tip, -H / 2], [L, 0], [L - tip, H / 2], [0, H / 2]];
}
function drawBoard(g, w, h, { color, number, name, dir, sub = null }) {
  // dir +1: tip on the right, -1: tip on the left (as seen on this face)
  const L = BOARD.len, H = BOARD.h, tip = BOARD.tip, sx = w / L, sy = h / H;
  const P = boardOutline(L, H, tip).map(([x, y]) => [(dir > 0 ? x : L - x) * sx, (H / 2 - y) * sy]);
  // outline, optionally shrunk toward the board centre by `inset` pixels (for the white border line)
  const path = (inset) => {
    const cx = w / 2, cy = h / 2;
    g.beginPath();
    P.forEach(([x, y], i) => {
      const px = cx + (x - cx) * (1 - (inset * 2) / w), py = cy + (y - cy) * (1 - (inset * 2) / h);
      i ? g.lineTo(px, py) : g.moveTo(px, py);
    });
    g.closePath();
  };
  g.fillStyle = '#e9e4da'; g.fillRect(0, 0, w, h); // raw board edge colour outside the shape
  path(0); g.fillStyle = color; g.fill();
  path(5); g.lineWidth = 3.2; g.strokeStyle = 'rgba(255,255,255,0.95)'; g.stroke();
  // number badge (or none) + name, in the rectangular part of the board
  const rx0 = dir > 0 ? 0 : tip * sx, rx1 = dir > 0 ? (L - tip) * sx : w;
  let tx = rx0 + h * 0.3;
  if (number !== null && number !== undefined) {
    const badge = h * 0.62, bx = rx0 + h * 0.24, by = (h - badge) / 2;
    g.fillStyle = '#ffffff';
    g.beginPath(); g.roundRect ? g.roundRect(bx, by, badge, badge, 6) : g.rect(bx, by, badge, badge); g.fill();
    g.fillStyle = color; g.font = `700 ${Math.round(badge * 0.78)}px ${SIGN_FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(String(number), bx + badge / 2, h / 2 + 1);
    tx = bx + badge + h * 0.22;
  }
  g.fillStyle = '#ffffff'; g.textAlign = 'left'; g.textBaseline = 'middle';
  let size = Math.round(h * (sub ? 0.44 : 0.56));
  g.font = `700 ${size}px ${SIGN_FONT}`;
  const maxW = rx1 - tx - h * 0.15;
  while (g.measureText(name).width > maxW && size > 14) { size -= 1; g.font = `700 ${size}px ${SIGN_FONT}`; }
  g.fillText(name, tx, sub ? h * 0.37 : h / 2 + 1);
  if (sub) { // where the run takes you ("· VILLAGE", "· HIRSCHALM CHAIR")
    let s2 = Math.round(h * 0.3);
    g.font = `600 ${s2}px ${SIGN_FONT}`;
    while (g.measureText(sub).width > maxW && s2 > 11) { s2 -= 1; g.font = `600 ${s2}px ${SIGN_FONT}`; }
    g.globalAlpha = 0.92; g.fillText(sub, tx, h * 0.75); g.globalAlpha = 1;
  }
}
function drawLiftSign(g, w, h, { title, sub }) {
  g.fillStyle = '#7a1010'; g.fillRect(0, 0, w, h);
  g.strokeStyle = '#ffffff'; g.lineWidth = 7; g.strokeRect(9, 9, w - 18, h - 18);
  g.fillStyle = '#ffffff'; g.textAlign = 'center'; g.textBaseline = 'middle';
  let size = Math.round(h * 0.3);
  g.font = `700 ${size}px ${SIGN_FONT}`;
  while (g.measureText(title).width > w - 60 && size > 16) { size -= 1; g.font = `700 ${size}px ${SIGN_FONT}`; }
  g.fillText(title, w / 2, h * 0.4);
  size = Math.round(h * 0.2);
  g.font = `600 ${size}px ${SIGN_FONT}`;
  while (g.measureText(sub).width > w - 50 && size > 12) { size -= 1; g.font = `600 ${size}px ${SIGN_FONT}`; }
  g.fillText(sub, w / 2, h * 0.72);
}

// Extruded arrow board (2 mm bevel) whose front / back caps map onto the given atlas cells.
function boardGeometry(dir, front, back) {
  const L = BOARD.len, H = BOARD.h, tip = BOARD.tip;
  const shape = new THREE.Shape(boardOutline(L, H, tip).map(([x, y]) => new THREE.Vector2(x * dir, y)));
  const geo = new THREE.ExtrudeGeometry(shape, { depth: BOARD.depth, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.004, bevelSegments: 1, curveSegments: 1 });
  geo.translate(0, 0, -BOARD.depth / 2);
  const pos = geo.attributes.position, uv = geo.attributes.uv;
  // caps (group 0) -> atlas; the front cap is the +z face
  const g0 = geo.groups[0];
  const idx = geo.index ? geo.index.array : null;
  const capVerts = new Set();
  for (let i = g0.start; i < g0.start + g0.count; i++) capVerts.add(idx ? idx[i] : i);
  for (const v of capVerts) {
    const x = pos.getX(v), z = pos.getZ(v), y = pos.getY(v);
    const cell = z > 0 ? front : back;
    // board-local x measured from the root, mirrored for the back so it reads from behind
    let t = (x * dir) / L; if (z <= 0) t = 1 - t;
    const s = (y + H / 2) / H;
    uv.setXY(v, cell.u0 + (cell.u1 - cell.u0) * t, cell.v0 + (cell.v1 - cell.v0) * s);
  }
  // sides (group 1) sample the board colour between the white border line and the number badge
  const c = { u: front.u0 + (front.u1 - front.u0) * 0.03, v: front.v0 + (front.v1 - front.v0) * 0.5 };
  for (let v = 0; v < pos.count; v++) if (!capVerts.has(v)) uv.setXY(v, c.u, c.v);
  return geo;
}

// ------------------------------------------------------------------ safety nets
// B-net: orange mesh 1.6 m high on dark posts every ~3.5 m; A-net: red mesh 3.6 m high, posts every ~5 m.
// Posts stand vertical, planted 0.25 m into the snow on stable ground (moved toward the run if the edge is
// too steep). Each panel hangs from a top rope that sags slightly between posts; its bottom edge is pulled
// toward the run (the catch angle) and follows the snow 10 cm above it in <= 0.5 m columns, so it never
// floats or cuts in; a low wind drift of snow banks against its foot. Panels, hems, ropes, posts and drifts
// are merged per ~256 m chunk (two draw calls each); chunks beyond ~470 m are hidden and the mesh fades out
// before that.
const NET = {
  B: { h: 1.6, post: 3.5, lean: 0.28, sag: 0.05, color: '#ff5d17', hem: '#e8470f', postR: 0.034, postH: 1.85, cap: '#f2f2f2' },
  A: { h: 3.6, post: 5.0, lean: 0.45, sag: 0.1, color: '#e0281d', hem: '#b81e16', postR: 0.055, postH: 3.85, cap: '#ff6a12' },
};
export const NET_TYPES = NET;
// the catch angle along a panel (t 0..1 post to post): none at the posts, full a little way in
const netLeanW = (t) => Math.min(1, Math.sin(Math.PI * Math.min(1, Math.max(0, t))) * 2.2);
const POST_COL = '#26282b', ROPE_COL = '#2b2d30';
const NET_CHUNK = 256, NET_FAR = 470;

// mesh texture: a 0.5 m tile of 5 cm square mesh with knotted crossings (tinted by the material colour)
function netTexture() {
  return canvasTex(256, 256, (g) => {
    g.clearRect(0, 0, 256, 256);
    const cell = 25.6;
    g.fillStyle = '#ffffff';
    for (let i = 0; i < 10; i++) {
      g.fillRect(i * cell - 1.6, 0, 3.2, 256); // strands
      g.fillRect(0, i * cell - 1.6, 256, 3.2);
    }
    g.fillStyle = '#d8d8d8';
    for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) g.fillRect(i * cell - 2.6, j * cell - 2.6, 5.2, 5.2); // knots
  }, { wrap: true });
}
// dye spray texture: soft, broken edges (alpha) along a blue line
function dyeTexture() {
  return canvasTex(64, 256, (g) => {
    const img = g.createImageData(64, 256);
    for (let y = 0; y < 256; y++) for (let x = 0; x < 64; x++) {
      const across = Math.abs(x - 31.5) / 32;
      const n = hash2(x >> 2, y >> 2, 7) * 0.5 + hash2(x, y, 9) * 0.5;
      const a = Math.max(0, Math.min(1, (1 - across * across * 1.3) * 1.25 - n * 0.55));
      const k = (y * 64 + x) * 4;
      img.data[k] = 255; img.data[k + 1] = 255; img.data[k + 2] = 255; img.data[k + 3] = Math.round(a * 255);
    }
    g.putImageData(img, 0, 0);
  }, { wrap: true });
}

// Distance fade (and, for the mesh, coverage kept up with the mip level so far nets stay readable as a
// translucent band instead of dissolving). Works with alpha-to-coverage under the post chain's MSAA.
// Net mesh needs alpha to coverage, which only works on a multisampled target: without MSAA (the
// Performance preset) the holes between the strands rendered as opaque black, so the nets read as dark
// walls. There the strands are cut out with an alpha test instead (1 = cut, 0 = leave it to coverage).
export const netCut = { value: quality.msaa ? 0 : 1 };
onQualityChange((q) => { netCut.value = q.msaa ? 0 : 1; });

function fadeShader(mat, near, far, meshCoverage) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uNetCut = netCut;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vFadeW;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        #ifdef USE_INSTANCING
          vFadeW = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
        #else
          vFadeW = (modelMatrix * vec4(transformed, 1.0)).xyz;
        #endif`);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vFadeW;\nuniform float uNetCut;')
      .replace('#include <alphatest_fragment>', `
        float netFar = 0.0; // (cut mode: 0 close .. 1 where the mesh only reads as a band)
        ${meshCoverage ? `#ifdef USE_MAP
          vec2 tdx = dFdx(vMapUv * 256.0), tdy = dFdy(vMapUv * 256.0);
          float mipL = max(0.0, 0.5 * log2(max(dot(tdx, tdx), dot(tdy, tdy))));
          diffuseColor.a = clamp(diffuseColor.a * (1.0 + mipL * 0.22), 0.0, 1.0);
          if (uNetCut > 0.5) {
            // without MSAA: further away (smaller mips) the mesh turns into a solid band in the net's own colour
            // (the holes' black is divided back out) instead of thinning into flickering strands
            netFar = smoothstep(1.2, 2.6, mipL);
            diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb / max(sampledDiffuseColor.a, 0.1) * 0.48, netFar);
          }
        #endif` : ''}
        float netFade = 1.0 - smoothstep(${near.toFixed(1)}, ${far.toFixed(1)}, length(vFadeW - cameraPosition));
        diffuseColor.a *= netFade;
        if (uNetCut > 0.5 && (diffuseColor.a < 0.5 * (1.0 - netFar) || netFade < 0.5)) discard;
        #include <alphatest_fragment>`);
  };
  mat.customProgramCacheKey = () => `fade3-${near}-${far}-${meshCoverage}`;
  return mat;
}

let netMats = null;
function getNetMaterials() {
  if (netMats) return netMats;
  const tex = netTexture();
  const mesh = (color) => fadeShader(new THREE.MeshStandardMaterial({
    color, map: tex, alphaToCoverage: !!tex, transparent: false, side: THREE.DoubleSide, roughness: 0.78,
  }), NET_FAR - 90, NET_FAR - 10, true);
  netMats = {
    B: mesh(NET.B.color), A: mesh(NET.A.color),
    solid: vcMat({ roughness: 0.75, side: THREE.DoubleSide }),
    // sponsor banners tied onto the nets (world/sponsors.js), fading out with the nets
    banner: fadeShader(new THREE.MeshStandardMaterial({ map: sponsorAtlas(), roughness: 0.62, side: THREE.DoubleSide, alphaToCoverage: true }), NET_FAR - 90, NET_FAR - 10, false),
  };
  return netMats;
}

// Growable vertex buffer (positions, colours, uvs, indices) for one chunk's merged geometry.
class Buf {
  constructor() { this.p = []; this.c = []; this.u = []; this.i = []; }
  get n() { return this.p.length / 3; }
  v(x, y, z, col, u = 0, v = 0) { this.p.push(x, y, z); this.c.push(col.r, col.g, col.b); this.u.push(u, v); return this.n - 1; }
  quad(a, b, c, d) { this.i.push(a, b, c, b, d, c); }
  // a vertical cylinder from y0 to y1 with a top cap (no bottom: it stands in the snow), `seg` sides
  cyl(x, z, y0, y1, r0, r1, col, seg = 6) {
    const base = this.n;
    for (let k = 0; k < seg; k++) {
      const a = (k / seg) * Math.PI * 2, c = Math.cos(a), sn = Math.sin(a);
      this.v(x + c * r0, y0, z + sn * r0, col);
      this.v(x + c * r1, y1, z + sn * r1, col);
    }
    const top = this.v(x, y1, z, col);
    for (let k = 0; k < seg; k++) {
      const a0 = base + k * 2, a1 = base + ((k + 1) % seg) * 2;
      this.i.push(a0, a0 + 1, a1, a1, a0 + 1, a1 + 1, a0 + 1, top, a1 + 1);
    }
  }
  mesh(material, name) {
    if (!this.i.length) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(this.u, 2));
    geo.setIndex(this.i);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const m = new THREE.Mesh(geo, material);
    m.name = name; m.matrixAutoUpdate = false;
    return m;
  }
}

/**
 * Build safety-net runs.
 * @param {Array} runs [{ type: 'B' | 'A', line: [[x, z, nx, nz]...] }] lines every ~2 m, n = unit vector
 *   toward the run the net protects (layout.nets), or plain [[x, z]...] lines (B-nets, either side).
 * @returns {{ group: THREE.Group, colliders: object[], chunks: object[], stats: object }}
 */
export function buildNetRuns(runs) {
  const mats = getNetMaterials();
  const group = new THREE.Group();
  group.name = 'safety-nets';
  const colliders = [], chunkMap = new Map();
  const stats = { runs: 0, posts: 0, panels: 0, length: 0, maxPostErr: 0, maxGap: 0, minGap: Infinity, maxPostSlope: 0, posts3: [], perRun: [] };
  const chunkAt = (x, z) => {
    const k = Math.floor(x / NET_CHUNK) + ',' + Math.floor(z / NET_CHUNK);
    let c = chunkMap.get(k);
    if (!c) chunkMap.set(k, (c = { B: new Buf(), A: new Buf(), solid: new Buf(), banner: new Buf(), minx: Infinity, minz: Infinity, maxx: -Infinity, maxz: -Infinity }));
    return c;
  };
  const colPost = new THREE.Color(POST_COL), colRope = new THREE.Color(ROPE_COL), colSnow = new THREE.Color('#eef2f7'), colSnow2 = new THREE.Color('#e3e9f2');
  const slopeAt = (x, z) => { const e = 0.3; return Math.hypot(world.height(x + e, z) - world.height(x - e, z), world.height(x, z + e) - world.height(x, z - e)) / (2 * e); };

  for (const run of runs) {
    const T = NET[run.type] || NET.B;
    const line = run.line.map((p) => (p.length >= 4 ? p : [p[0], p[1], 0, 0]));
    if (line.length < 2) continue;
    const pts = line.map((p) => [p[0], p[1]]), acc = arcLengths(pts), L = acc.at(-1);
    if (L < 4) continue;
    stats.runs++; stats.length += L;
    const rs = { owner: run.owner || '', type: run.type, side: run.side, length: L, posts: 0, panels: 0, maxPostErr: 0, maxGap: 0, minGap: Infinity, maxSlope: 0, endGap: 0, footFloat: 0, postFloat: 0, midFloat: 0, midBuried: 0 };
    // posts: evenly along the run, nudged toward the run (never past 0.6 m from the groomed edge) when the
    // ground is too steep to plant one
    const n = Math.max(1, Math.round(L / T.post)), posts = [];
    for (let k = 0; k <= n; k++) {
      const s = (k / n) * L, q = sampleAt(pts, acc, s);
      let i = 1; while (i < line.length - 1 && acc[i] < s) i++;
      const nx = line[i][2], nz = line[i][3];
      let x = q.x, z = q.z, sl = slopeAt(x, z);
      // (never the run's end posts: the next fence or net joins on that very post)
      for (let m = 1; m <= 3 && sl > 0.9 && (nx || nz) && k > 0 && k < n; m++) {
        const tx = q.x + nx * 0.2 * m, tz = q.z + nz * 0.2 * m, ts = slopeAt(tx, tz);
        if (ts < sl) { x = tx; z = tz; sl = ts; }
      }
      // standing on the snow as drawn (the 2 m terrain mesh, which leaves the analytic surface on bumps and cut
      // edges: posts on world.height floated up to 2.8 m), the foot 0.25 m into it (deeper where the exact surface
      // drops below the drawn one)
      const g = meshGround(x, z);
      posts.push({ x, z, g, y: Math.min(g, world.height(x, z)) - 0.25, top: g + T.postH, nx, nz, end: k === 0 || k === n, dx: q.dx, dz: q.dz });
      rs.maxSlope = Math.max(rs.maxSlope, sl);
    }
    rs.ends = [[posts[0].x, posts[0].z], [posts.at(-1).x, posts.at(-1).z]];
    const colCap = new THREE.Color(T.cap);
    // sponsor banners every few panels on the run side (only where the side facing the run is known)
    let seed = Math.abs(Math.floor(line[0][0] * 7.3 + line[0][1] * 13.1)) % 2147483646 + 1;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const sided = line.some((p) => p[2] || p[3]);
    let nextBanner = 3 + rnd() * 8;
    for (const p of posts) {
      const ch = chunkAt(p.x, p.z), B = ch.solid;
      const r = T.postR * (p.end ? 1.45 : 1);
      // vertical post (base 0.25 m in the snow) with a cap
      B.cyl(p.x, p.z, p.y, p.top, r, r * 0.9, colPost);
      B.cyl(p.x, p.z, p.top - 0.01, p.top + 0.07, r + 0.012, r + 0.012, colCap);
      ch.minx = Math.min(ch.minx, p.x); ch.maxx = Math.max(ch.maxx, p.x); ch.minz = Math.min(ch.minz, p.z); ch.maxz = Math.max(ch.maxz, p.z);
      stats.posts++; rs.posts++;
      // planted at the snow surface at its centre (the base sits 0.25 m below it)
      const err = Math.abs(p.g - meshGround(p.x, p.z));
      rs.postFloat = Math.max(rs.postFloat, p.y - meshGround(p.x, p.z));
      rs.maxPostErr = Math.max(rs.maxPostErr, err);
    }
    // panels between consecutive posts
    const colNet = new THREE.Color(T.color), colHem = new THREE.Color(T.hem);
    for (let k = 1; k < posts.length; k++) {
      const a = posts[k - 1], b = posts[k];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 0.3) continue;
      const ch = chunkAt((a.x + b.x) / 2, (a.z + b.z) / 2), M = ch[run.type === 'A' ? 'A' : 'B'], S = ch.solid;
      const cols = Math.max(1, Math.ceil(len / 1.0)); // <= 1 m columns: the bottom edge follows the snow
      const s0 = (k - 1) * (L / (posts.length - 1));
      // rows per column: bottom edge, top hem, top (rope bottom), rope top; the drift's profile
      const rowB = [], rowH = [], rowT = [], rowR = [];
      const sideU = [];
      for (let j = 0; j <= cols; j++) {
        const t = j / cols;
        const px = a.x + (b.x - a.x) * t, pz = a.z + (b.z - a.z) * t;
        const nx = a.nx + (b.nx - a.nx) * t, nz = a.nz + (b.nz - a.nz) * t, nl = Math.hypot(nx, nz);
        const ux = nl > 0.01 ? nx / nl : -(b.z - a.z) / len, uz = nl > 0.01 ? nz / nl : (b.x - a.x) / len;
        sideU.push([ux, uz]);
        // the panel's bottom edge is pulled toward the run (the catch angle) between the posts, its side edges
        // hanging straight down the posts (a full lean right up to them left the foot 0.25-0.4 m off its post), and
        // follows the snow as drawn
        const lw = T.lean * netLeanW(t), bx = px + ux * lw, bz = pz + uz * lw;
        const by = meshGround(bx, bz) + 0.08;
        const ty = a.top + (b.top - a.top) * t - 0.08 - T.sag * 4 * t * (1 - t);
        // gap under the bottom edge, also checked halfway between the columns
        if (j > 0) {
          const q = rowB[j - 1], mx = (q.x + bx) / 2, mz = (q.z + bz) / 2;
          const gap = (q.y + by) / 2 - meshGround(mx, mz);
          rs.maxGap = Math.max(rs.maxGap, gap); rs.minGap = Math.min(rs.minGap, gap);
        }
        rs.maxGap = Math.max(rs.maxGap, 0.08); rs.minGap = Math.min(rs.minGap, 0.08);
        const f = 1 - Math.min(0.45, 0.07 / (ty - by));
        rowB.push({ x: bx, y: by, z: bz });
        rowH.push({ x: bx + (px - bx) * f, y: by + (ty - by) * f, z: bz + (pz - bz) * f });
        rowT.push({ x: px, y: ty, z: pz });
        rowR.push({ x: px, y: ty + 0.028, z: pz });
      }
      // (Node checks) the panel's side edges against its posts (beyond the post radius), its foot against the snow as drawn
      for (const [j, P] of [[0, a], [cols, b]]) for (const q of [rowB[j], rowT[j]]) rs.endGap = Math.max(rs.endGap, Math.hypot(q.x - P.x, q.z - P.z) - T.postR);
      for (let j = 0; j <= cols; j++) {
        const d = rowB[j].y - meshGround(rowB[j].x, rowB[j].z);
        if (j === 0 || j === cols) rs.footFloat = Math.max(rs.footFloat, d);
        rs.midFloat = Math.max(rs.midFloat, d); rs.midBuried = Math.max(rs.midBuried, -d);
      }
      // mesh body (bottom edge up to the top hem): uv in metres / 0.5 (one texture tile = 0.5 m)
      const ia = [], ib = [];
      for (let j = 0; j <= cols; j++) {
        const lo = rowB[j], hi = rowH[j], u = (s0 + (len * j) / cols) / 0.5;
        ia.push(M.v(lo.x, lo.y, lo.z, colNet, u, 0));
        ib.push(M.v(hi.x, hi.y, hi.z, colNet, u, Math.hypot(hi.x - lo.x, hi.y - lo.y, hi.z - lo.z) / 0.5));
      }
      for (let j = 0; j < cols; j++) M.quad(ia[j], ia[j + 1], ib[j], ib[j + 1]);
      // top hem and the top rope
      const strip = (r0, r1, col) => {
        const i0 = r0.map((p) => S.v(p.x, p.y, p.z, col)), i1 = r1.map((p) => S.v(p.x, p.y, p.z, col));
        for (let j = 0; j < cols; j++) S.quad(i0[j], i0[j + 1], i1[j], i1[j + 1]);
      };
      strip(rowH, rowT, colHem);
      strip(rowT, rowR, colRope);
      if (sided && s0 >= nextBanner && len > 2.4 && s0 + len < L - 1) {
        nextBanner = s0 + (run.type === 'A' ? 16 : 11) + rnd() * 10;
        netBanner(ch.banner, a, b, len, T, run.type === 'A' ? 0.95 : 0.62, pickBanner('resort', rnd));
      }
      // wind drift banked against the foot of the net (toward the run), tapering at the run's ends
      const prof = [[-0.7, -0.07], [-0.25, 0.12], [0.05, 0.16], [0.4, -0.07]];
      const rows = prof.map(() => []);
      for (let j = 0; j <= cols; j++) {
        const t = j / cols, p = rowB[j], [ux, uz] = sideU[j];
        const sAbs = s0 + len * t, taper = Math.min(1, Math.min(sAbs, L - sAbs) / 6);
        const vary = 0.7 + 0.6 * hash2(Math.floor(p.x * 0.7), Math.floor(p.z * 0.7), 3);
        prof.forEach(([o, hgt], r) => {
          const x = p.x + ux * o, z = p.z + uz * o;
          rows[r].push(S.v(x, meshGround(x, z) + (hgt > 0 ? hgt * taper * vary : hgt), z, r === 2 ? colSnow : colSnow2));
        });
      }
      for (let r = 0; r < prof.length - 1; r++) for (let j = 0; j < cols; j++) S.quad(rows[r][j], rows[r][j + 1], rows[r + 1][j], rows[r + 1][j + 1]);
      stats.panels++; rs.panels++;
    }
    // colliders: one thin box per straight stretch of up to ~12 m (posts included)
    for (let i = 0; i < posts.length - 1;) {
      let j = i + 1;
      while (j + 1 < posts.length) {
        const a = posts[i], b = posts[j + 1], l = Math.hypot(b.x - a.x, b.z - a.z);
        if (l > 12) break;
        let dev = 0;
        for (let k = i + 1; k <= j; k++) dev = Math.max(dev, Math.abs(((posts[k].x - a.x) * (b.z - a.z) - (posts[k].z - a.z) * (b.x - a.x)) / (l || 1)));
        if (dev > 0.3) break;
        j++;
      }
      const a = posts[i], b = posts[j], len = Math.hypot(b.x - a.x, b.z - a.z);
      // net: true -> the nets catch skiers softly (no wipeouts against nets, see Player.bounce)
      colliders.push({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, hw: len / 2 + 0.05, hd: 0.3, rot: -Math.atan2(-(b.z - a.z), b.x - a.x), net: true });
      i = j;
    }
    stats.maxPostErr = Math.max(stats.maxPostErr, rs.maxPostErr);
    stats.maxGap = Math.max(stats.maxGap, rs.maxGap); stats.minGap = Math.min(stats.minGap, rs.minGap);
    stats.maxPostSlope = Math.max(stats.maxPostSlope, rs.maxSlope);
    stats.perRun.push(rs);
  }
  const chunks = [];
  for (const ch of chunkMap.values()) {
    const meshes = [ch.B.mesh(mats.B, 'bnet-mesh'), ch.A.mesh(mats.A, 'anet-mesh'), ch.solid.mesh(mats.solid, 'net-solid'), ch.banner.mesh(mats.banner, 'net-banner')].filter(Boolean);
    for (const m of meshes) { m.castShadow = false; m.receiveShadow = true; group.add(m); } // (no shadows from nets)
    const cx = (ch.minx + ch.maxx) / 2, cz = (ch.minz + ch.maxz) / 2;
    chunks.push({ x: cx, z: cz, r: Math.hypot(ch.maxx - ch.minx, ch.maxz - ch.minz) / 2 + 4, meshes });
  }
  return { group, colliders, chunks, stats };
}

// A sponsor banner tied onto the run side of one net panel (posts a -> b): it lies on the leaning net
// face, its bottom edge following the snow, with a plain back so the text never shows mirrored.
const WHITE_C = new THREE.Color('#ffffff');
function netBanner(B, a, b, len, T, bh, index) {
  const { u0, u1, v0, v1 } = bannerUV(index);
  const N = Math.max(2, Math.ceil(len / 1.0));
  const front = [], back = [];
  let ax = 0, az = 0, bxx = 0, bzz = 0, tx = 0, tz = 0;
  for (let j = 0; j <= N; j++) {
    const t = 0.07 + (0.86 * j) / N;
    const px = a.x + (b.x - a.x) * t, pz = a.z + (b.z - a.z) * t;
    const nx = a.nx + (b.nx - a.nx) * t, nz = a.nz + (b.nz - a.nz) * t, nl = Math.hypot(nx, nz) || 1;
    const ux = nx / nl, uz = nz / nl;
    const lw = T.lean * netLeanW(t), bx = px + ux * lw, bz = pz + uz * lw, by = meshGround(bx, bz) + 0.08;
    const ty = a.top + (b.top - a.top) * t - 0.08 - T.sag * 4 * t * (1 - t);
    const span = ty - by, f0 = 0.13 / span, f1 = Math.min(0.13 + bh, span - 0.16) / span;
    const at = (f, off) => [bx + (px - bx) * f + ux * off, by + (ty - by) * f, bz + (pz - bz) * f + uz * off];
    front.push([at(f0, 0.045), at(f1, 0.045)]);
    back.push([at(f0, 0.035), at(f1, 0.035)]);
    if (j === 0) { ax = px; az = pz; tx = ux; tz = uz; }
    if (j === N) { bxx = px; bzz = pz; }
  }
  // the text reads left to right for someone on the run looking at the net
  const right = (bxx - ax) * tz - (bzz - az) * tx > 0;
  const ub = u0 + 0.004, vb = v1 - 0.002;
  const lo = [], hi = [], blo = [], bhi = [];
  for (let j = 0; j <= N; j++) {
    const k = j / N, u = right ? u0 + (u1 - u0) * k : u1 - (u1 - u0) * k;
    lo.push(B.v(...front[j][0], WHITE_C, u, v0)); hi.push(B.v(...front[j][1], WHITE_C, u, v1));
    blo.push(B.v(...back[j][0], WHITE_C, ub, vb)); bhi.push(B.v(...back[j][1], WHITE_C, ub, vb));
  }
  for (let j = 0; j < N; j++) { B.quad(lo[j], lo[j + 1], hi[j], hi[j + 1]); B.quad(blo[j], blo[j + 1], bhi[j], bhi[j + 1]); }
}

// ------------------------------------------------------------------ ski patrol hut (procedural fallback)
// Red board-and-batten cabin with white trim, a snow-loaded gable roof, door, window and a white cross.
function patrolHutGeometry() {
  const parts = [];
  const W = 4.2, D = 3.4, Hw = 2.5, ov = 0.45, pitch = 0.62;
  const red = ['#b3201c', '#a81d19', '#bb2420'];
  // walls: vertical boards on a frame (slight colour variation per board)
  const boards = Math.round(W / 0.21);
  for (let i = 0; i < boards; i++) {
    const x = -W / 2 + (i + 0.5) * (W / boards);
    for (const z of [D / 2, -D / 2]) parts.push(baked(new THREE.BoxGeometry(W / boards - 0.012, Hw, 0.06), mat4(x, Hw / 2, z), red[i % 3]));
  }
  const sideBoards = Math.round(D / 0.21);
  for (let i = 0; i < sideBoards; i++) {
    const z = -D / 2 + (i + 0.5) * (D / sideBoards);
    for (const x of [W / 2, -W / 2]) parts.push(baked(new THREE.BoxGeometry(0.06, Hw, D / sideBoards - 0.012), mat4(x, Hw / 2, z), red[(i + 1) % 3]));
  }
  parts.push(baked(new THREE.BoxGeometry(W - 0.1, Hw, D - 0.1), mat4(0, Hw / 2, 0), '#5a1210')); // inner core
  // gable triangles (front and back)
  const rise = Math.tan(pitch) * (W / 2 + 0.05);
  const gable = new THREE.Shape([new THREE.Vector2(-W / 2, 0), new THREE.Vector2(W / 2, 0), new THREE.Vector2(0, rise)]);
  const gGeo = new THREE.ExtrudeGeometry(gable, { depth: 0.06, bevelEnabled: false });
  for (const z of [D / 2 - 0.03, -D / 2 - 0.03]) parts.push(baked(gGeo, mat4(0, Hw, z), '#a81d19'));
  gGeo.dispose();
  // white corner trim + eave boards
  for (const [x, z] of [[W / 2, D / 2], [-W / 2, D / 2], [W / 2, -D / 2], [-W / 2, -D / 2]]) parts.push(baked(new THREE.BoxGeometry(0.12, Hw, 0.12), mat4(x, Hw / 2, z), '#f4f4f2'));
  for (const z of [D / 2 + 0.04, -D / 2 - 0.04]) parts.push(baked(new THREE.BoxGeometry(W + 0.1, 0.1, 0.05), mat4(0, Hw - 0.05, z), '#f4f4f2'));
  // roof slabs (dark standing-seam metal) + snow cap
  const slab = Math.hypot(W / 2 + ov, rise + ov * Math.tan(pitch));
  for (const sx of [-1, 1]) {
    const cx = sx * (W / 4 + ov / 2), cy = Hw + rise / 2 - ov * Math.tan(pitch) / 2 + 0.06;
    parts.push(baked(new THREE.BoxGeometry(slab, 0.09, D + ov * 2), mat4(cx, cy, 0, 0, 0, -sx * pitch), '#2b2e33'));
    parts.push(baked(new THREE.BoxGeometry(slab - 0.12, 0.2, D + ov * 2 - 0.1), mat4(cx - sx * 0.03, cy + 0.14, 0, 0, 0, -sx * pitch), '#f3f6fb'));
  }
  parts.push(baked(new THREE.CylinderGeometry(0.12, 0.12, D + ov * 2 - 0.1, 8), mat4(0, Hw + rise + 0.13, 0, 0, Math.PI / 2, 0), '#f3f6fb')); // ridge snow
  // door with frame, a window on the front, white cross panel on the gable
  parts.push(baked(new THREE.BoxGeometry(1.0, 2.0, 0.08), mat4(-0.9, 1.0, D / 2 + 0.03), '#f4f4f2'));
  parts.push(baked(new THREE.BoxGeometry(0.84, 1.9, 0.1), mat4(-0.9, 0.97, D / 2 + 0.04), '#5b3a22'));
  parts.push(baked(new THREE.BoxGeometry(0.06, 0.06, 0.06), mat4(-0.57, 1.0, D / 2 + 0.12), '#c9c9c9'));
  parts.push(baked(new THREE.BoxGeometry(1.0, 0.8, 0.08), mat4(0.95, 1.45, D / 2 + 0.03), '#f4f4f2'));
  parts.push(baked(new THREE.BoxGeometry(0.86, 0.66, 0.1), mat4(0.95, 1.45, D / 2 + 0.04), '#22303d'));
  parts.push(baked(new THREE.BoxGeometry(0.05, 0.66, 0.11), mat4(0.95, 1.45, D / 2 + 0.05), '#f4f4f2'));
  parts.push(baked(new THREE.BoxGeometry(0.86, 0.05, 0.11), mat4(0.95, 1.45, D / 2 + 0.05), '#f4f4f2'));
  const cy = Hw + rise * 0.42;
  parts.push(baked(new THREE.BoxGeometry(0.62, 0.62, 0.05), mat4(0, cy, D / 2 + 0.08), '#c41f1b'));
  parts.push(baked(new THREE.BoxGeometry(0.42, 0.12, 0.06), mat4(0, cy, D / 2 + 0.1), '#ffffff'));
  parts.push(baked(new THREE.BoxGeometry(0.12, 0.42, 0.06), mat4(0, cy, D / 2 + 0.1), '#ffffff'));
  // banked snow along the walls, stone footing
  parts.push(baked(new THREE.BoxGeometry(W + 0.3, 0.32, D + 0.3), mat4(0, 0.1, 0), '#7c7f86'));
  for (const sx of [-1, 1]) parts.push(baked(new THREE.CylinderGeometry(0.32, 0.45, D + 0.4, 8, 1), mat4(sx * (W / 2 + 0.2), 0.12, 0, 0, Math.PI / 2, 0, 1, 1, 0.55), '#eef2f8'));
  // rescue sled (akja) leaning by the door
  parts.push(baked(new THREE.BoxGeometry(0.62, 0.12, 2.0), mat4(-2.6 + 0.9, 0.95, D / 2 + 0.38, 0.15, -1.18, 0), '#e2551b'));
  const geo = mergeGeometries(parts);
  parts.forEach((p) => p.dispose());
  return geo;
}

// ------------------------------------------------------------------ main builder
/**
 * Dress the whole resort. Call once after the layout and the village exist.
 * @param {THREE.Scene} scene
 * @param {object} models loaded GLTFs (any may be missing)
 * @returns {THREE.Group} added to the scene; group.userData = { colliders: [{x,z,r} | {x,z,hw,hd,rot}],
 *   setNight(0..1), update(cameraPosition) (hides far net chunks), nets: stats, ... }
 */
export function buildResortDressing(scene, models = {}) {
  const group = new THREE.Group();
  group.name = 'resort-dressing';
  const colliders = [];
  const index = new PisteIndex(layout.pistes);
  const nets = new NetIndex(layout.nets);
  const hazardNets = new NetIndex(layout.nets.filter((n) => !n.fence));
  const cannons = cannonSpots();
  const nearCannon = (x, z, r) => cannons.some(([cx, cz]) => Math.abs(cx - x) < r && Math.abs(cz - z) < r && Math.hypot(cx - x, cz - z) < r);
  const stations = layout.lifts.flatMap((l) => [l.bottom, l.top, ...(l.mid ? [l.mid] : [])]);
  const nearStation = (x, z, r) => stations.some((s) => Math.hypot(s.x - x, s.z - z) < r);
  const inVillage = (x, z) => Math.hypot(x, z) < 240;

  buildSignposts(group, colliders, index, nets, models);
  buildMarkers(group, index, hazardNets, nearCannon, nearStation, inVillage);
  const netBuild = buildNetRuns(layout.nets.filter((n) => !n.fence));
  group.add(netBuild.group);
  colliders.push(...netBuild.colliders);
  // the continuous fences along every run (instanced, streamed round the camera; a pool of soft colliders)
  const fences = buildPisteFences(layout.nets.filter((n) => n.fence), { netMaterial: getNetMaterials().B });
  group.add(fences.group);
  colliders.push(...fences.colliders);
  buildArenas(group, colliders, models);
  buildLaneGates(group, colliders);
  buildPatrolHuts(group, colliders, models);
  buildTerraces(group, colliders, models, index);

  group.userData.colliders = colliders;
  group.userData.nets = netBuild.stats;
  group.userData.netChunks = netBuild.chunks;
  group.userData.fences = fences.stats;
  group.userData.fenceBuild = fences;
  // night: 0..1 (e.g. the village's nightUniform.value) - sign faces glow faintly like the village signs
  group.userData.setNight = (night) => { const m = group.userData.signFaceMaterial; if (m) m.emissiveIntensity = night * 0.25; };
  // per frame (cheap): net chunks out of range are hidden (they have faded out by then)
  group.userData.update = (cam) => {
    for (const c of netBuild.chunks) {
      const d = Math.hypot(cam.x - c.x, cam.z - c.z) - c.r;
      const vis = d < NET_FAR;
      for (const m of c.meshes) m.visible = vis;
    }
    fences.update(cam);
  };
  scene?.add(group);
  return group;
}

// ------------------------------------------------------------------ signposts
function pisteNumber(p) { return p.number ?? layout.pistes.indexOf(p) + 1; }
// where a run takes you: the village, the lift at its foot, or (a run that ends on another run) wherever that one goes
export function pisteDest(p, depth = 0) {
  const [x, z] = p.pts.at(-1);
  if (Math.hypot(x, z) < 330) return 'Village';
  let lift = null, bd = 95;
  for (const l of layout.lifts) { const d = Math.hypot(l.bottom.x - x, l.bottom.z - z); if (d < bd) { bd = d; lift = l; } }
  if (lift) return lift.village || Math.hypot(lift.bottom.x, lift.bottom.z) < 330 ? 'Village' : lift.name;
  if (depth < 3) {
    for (const q of layout.pistes) {
      if (q === p || q.lane) continue;
      for (const [qx, qz] of q.pts) if (Math.hypot(qx - x, qz - z) < PISTE_WIDTH[q.diff] + 12) return pisteDest(q, depth + 1);
    }
  }
  return null;
}

function buildSignposts(group, colliders, index, nets, models) {
  const atlas = new SignAtlas();
  const cells = new Map(); // piste -> { right, left }
  const cw = 320, ch = Math.round((320 * BOARD.h) / BOARD.len);
  for (const p of layout.pistes) {
    const dest = pisteDest(p);
    const opts = { color: PISTE_COLORS[p.diff], number: pisteNumber(p), name: p.name.toUpperCase(), sub: dest ? `· ${dest.toUpperCase()}` : null };
    cells.set(p, { right: atlas.add(cw, ch, (g, w, h) => drawBoard(g, w, h, { ...opts, dir: 1 })), left: atlas.add(cw, ch, (g, w, h) => drawBoard(g, w, h, { ...opts, dir: -1 })) });
  }
  // gondola signs at the base stations (all but the Legacy Gondola, whose sign stands in the plaza)
  const gondolas = layout.lifts.filter((l) => l.type === 'gondola' && !l.main && !l.procedural);
  const liftSigns = [];
  for (const l of gondolas) {
    const alt = Math.round(ALT0 + l.top.y);
    const sub = l.mid ? `${l.mid.name} · Top station ${alt.toLocaleString('en-US')} m` : `Top station ${alt.toLocaleString('en-US')} m`;
    liftSigns.push({ l, cell: atlas.add(504, 174, (g, w, h) => drawLiftSign(g, w, h, { title: l.name.toUpperCase(), sub })) });
  }
  // village wayfinding: dark red arrow boards to every gondola, the park and the ski bus
  const WAY = '#7a1010';
  const dist = (x, z) => { const d = Math.hypot(x, z); return d < 950 ? `${Math.round(d / 10) * 10} m` : `${(d / 1000).toFixed(1)} km`; };
  const ways = [];
  for (const l of gondolas) ways.push({ name: `${l.name.toUpperCase()} · ${dist(l.bottom.x, l.bottom.z)}`, x: l.bottom.x, z: l.bottom.z });
  if (layout.park) ways.push({ name: `LEGACY PARK · ${dist(layout.park.drop.x, layout.park.drop.z)}`, x: layout.park.drop.x, z: layout.park.drop.z });
  const rail = layout.railway?.stations[0]; // the Wolkenspitzbahn's valley station (transport.js)
  if (rail) ways.push({ name: `WOLKENSPITZBAHN · ${dist(rail.x, rail.z)}`, x: rail.x, z: rail.z });
  for (const w of ways) w.cells = { right: atlas.add(cw, ch, (g, ww, hh) => drawBoard(g, ww, hh, { color: WAY, number: null, name: w.name, dir: 1 })), left: atlas.add(cw, ch, (g, ww, hh) => drawBoard(g, ww, hh, { color: WAY, number: null, name: w.name, dir: -1 })) };
  const tex = atlas.finish();
  // printed faces glow faintly at night like the village signs (driven by setNight)
  const faceMat = new THREE.MeshStandardMaterial({
    map: tex, color: tex ? 0xffffff : 0x8a8a8a, roughness: 0.55, emissiveMap: tex, emissive: tex ? 0xffffff : 0x000000, emissiveIntensity: 0,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2, // printed faces stay on top of their backing boards
  });
  faceMat.userData.isSign = true;

  // --- where the posts go: every piste start (one post per top station) and every fork
  const sites = []; // { x, z, facing (yaw the boards face), boards: [{ piste | cells, toward: [x, z] }] }
  const ahead = (p, s0, d = 70) => { const acc = arcLengths(p.pts); const q = sampleAt(p.pts, acc, Math.min(acc.at(-1), s0 + d)); return [q.x, q.z]; };
  // one post per group of piste starts (the top station; the Panorama starts at the Legacy Mid-Station): every
  // run (the ones outside the peaks too: the Bunny Hill, the valley runs) gets its numbered board at its start
  const groups = [];
  for (const p of layout.pistes.filter((q) => q.pts.length > 4 && !q.lane)) {
    const g = groups.find((gr) => Math.hypot(gr.x - p.pts[0][0], gr.z - p.pts[0][1]) < 150);
    if (g) g.pistes.push(p); else groups.push({ x: p.pts[0][0], z: p.pts[0][1], pistes: [p] });
  }
  for (const { pistes } of groups) {
    // mean start of the group's pistes and their mean initial direction
    let sx = 0, sz = 0, dx = 0, dz = 0;
    for (const p of pistes) {
      const acc = arcLengths(p.pts), a = sampleAt(p.pts, acc, 0), b = sampleAt(p.pts, acc, 60);
      sx += a.x; sz += a.z; dx += b.x - a.x; dz += b.z - a.z;
    }
    sx /= pistes.length; sz /= pistes.length;
    const dl = Math.hypot(dx, dz) || 1; dx /= dl; dz /= dl;
    // the post stands a little to the side of the start area, boards facing back up toward the station
    let x = sx - dx * 6 + dz * 9, z = sz - dz * 6 - dx * 9;
    if (index.clearance(x, z) < -8) { x = sx - dx * 6 - dz * 9; z = sz - dz * 6 + dx * 9; }
    sites.push({ x, z, facing: Math.atan2(-dx, -dz), boards: pistes.map((p) => ({ piste: p, toward: ahead(p, 0) })) });
  }
  // forks: where one piste leaves another (any two runs, across the mountains too)
  {
    const ps = layout.pistes.filter((p) => !p.lane && p.pts.length > 3); // a lane is fenced: no forks off it
    for (const a of ps) for (const b of ps) {
      if (a === b) continue;
      const accB = arcLengths(b.pts), L = accB.at(-1);
      let together = false;
      for (let s = 40; s < L - 150; s += 8) {
        const q = sampleAt(b.pts, accB, s);
        const d = index.distTo(q.x, q.z, a);
        const close = d < (PISTE_WIDTH[a.diff] + PISTE_WIDTH[b.diff]) * 0.55;
        if (together && !close && a.pts.length > 3) {
          // b leaves a here: post at the fork, boards for both lines
          const back = sampleAt(b.pts, accB, Math.max(0, s - 45));
          const fx = q.x - back.x, fz = q.z - back.z, fl = Math.hypot(fx, fz) || 1;
          const [ax, az] = ahead(a, nearestArc(a, q.x, q.z), 70);
          const [bx, bz] = ahead(b, s, 70);
          const mx = (ax + bx) / 2, mz = (az + bz) / 2;
          // between the two branches, a few metres down from the fork
          let x = q.x + (mx - q.x) * 0.12, z = q.z + (mz - q.z) * 0.12;
          if (index.clearance(x, z) < -6) { x = q.x - (fz / fl) * (PISTE_WIDTH[b.diff] + 2); z = q.z + (fx / fl) * (PISTE_WIDTH[b.diff] + 2); }
          if (!sites.some((t) => Math.hypot(t.x - x, t.z - z) < 60)) {
            sites.push({ x, z, facing: Math.atan2(-fx / fl, -fz / fl), boards: [{ piste: a, toward: [ax, az] }, { piste: b, toward: [bx, bz] }] });
          }
          break;
        }
        if (close) together = true;
      }
    }
  }
  // junctions: where a run ends on another one away from a station (the Talweg into the Sonnenhang): a post
  // ~50 m before the merge, its board pointing down the run you join ("12 SONNENHANG · VILLAGE")
  const liftEnds = layout.lifts.flatMap((l) => [l.bottom, l.top, ...(l.mid ? [l.mid] : [])]);
  for (const b of layout.pistes) {
    if (b.lane || b.pts.length < 4) continue;
    const [ex, ez] = b.pts.at(-1);
    if (liftEnds.some((st) => Math.hypot(st.x - ex, st.z - ez) < 90) || Math.hypot(ex, ez) < 330) continue;
    for (const a of layout.pistes) {
      if (a === b || a.lane) continue;
      if (index.distTo(ex, ez, a) > PISTE_WIDTH[a.diff] + PISTE_WIDTH[b.diff] * 0.6) continue;
      const accA = arcLengths(a.pts), sa = nearestArc(a, ex, ez);
      if (accA.at(-1) - sa < 120) continue;
      const accB = arcLengths(b.pts), q = sampleAt(b.pts, accB, Math.max(0, accB.at(-1) - 50));
      const [ax, az] = ahead(a, sa, 70);
      // on the run's edge on the side the joined run continues to, 3 m in from the groomed edge
      const rx = -q.dz, rz = q.dx, side = (ax - q.x) * rx + (az - q.z) * rz >= 0 ? 1 : -1, off = PISTE_WIDTH[b.diff] - 3;
      const x = q.x + rx * side * off, z = q.z + rz * side * off;
      if (!sites.some((t) => Math.hypot(t.x - x, t.z - z) < 50)) sites.push({ x, z, facing: Math.atan2(-q.dx, -q.dz), boards: [{ piste: a, toward: [ax, az] }], junction: true });
      break;
    }
  }
  // the village wayfinding post: on the plaza, facing where you arrive (the spawn by the bus stop)
  if (ways.length) {
    const x = 20, z = 12;
    sites.push({ x, z, facing: Math.atan2(4 - x, 34 - z), boards: ways.map((w) => ({ cells: w.cells, toward: [w.x, w.z], order: -w.z })), way: true });
  }
  // a sign never stands in a net: step it toward its run
  for (const site of sites) {
    for (let k = 0; k < 4 && nets.near(site.x, site.z, 2.5); k++) { site.x += Math.sin(site.facing) * 2; site.z += Math.cos(site.facing) * 2; }
  }

  // --- build: posts + boards (one mesh each for the whole resort)
  const posts = [], boardsGeo = [], poles = [];
  for (const site of sites) {
    const gy = groundMin(site.x, site.z, 0.3) - 0.25;
    const n = site.boards.length;
    const postH = 2.15 + n * 0.3;
    poles.push({ x: site.x, y: gy, z: site.z, h: postH + 0.12, yaw: site.facing });
    colliders.push({ x: site.x, z: site.z, r: 0.2 });
    // boards face uphill (yaw = facing); each points left or right toward its piste
    const fx = Math.sin(site.facing), fz = Math.cos(site.facing); // toward the reader
    const rx = -fz, rz = fx; // reader's right... seen from the front the board's +x is the reader's left
    site.boards
      .sort((u, v) => (u.piste && v.piste ? u.piste.diff - v.piste.diff : (u.order ?? 0) - (v.order ?? 0)))
      .forEach((b, i) => {
        const tx = b.toward[0] - site.x, tz = b.toward[1] - site.z;
        // +1 = points to the reader's right
        const side = tx * -rx + tz * -rz >= 0 ? 1 : -1;
        const y = gy + postH - 0.2 - i * 0.3;
        const c = b.cells || cells.get(b.piste);
        // the board is built pointing along its local +x (the reader's right when it faces the reader);
        // a left-pointing board is the same board turned round, showing its back cap (the left cell)
        const geo = boardGeometry(1, c.right.uv, c.left.uv);
        const yaw = site.facing + (side > 0 ? 0 : Math.PI);
        geo.applyMatrix4(mat4(site.x + (-rx) * side * 0.07, y, site.z + (-rz) * side * 0.07, yaw));
        boardsGeo.push(geo);
      });
  }
  // gondola signs: big board on two posts beside each base station, facing the arriving skiers
  for (const { l, cell } of liftSigns) {
    const dx = l.top.x - l.bottom.x, dz = l.top.z - l.bottom.z, dl = Math.hypot(dx, dz);
    const ux = dx / dl, uz = dz / dl;
    // 24 m in front of the station on the village / valley side, 12 m to the side of the line (in the village:
    // on the side clear of the buildings)
    const at = (s) => [l.bottom.x - ux * 24 - uz * 12 * s, l.bottom.z - uz * 24 + ux * 12 * s];
    const room = (s) => Math.min(...VILLAGE_BUILDINGS.map(([bx, bz]) => Math.hypot(at(s)[0] - bx, at(s)[1] - bz)));
    const [x, z] = at(l.village && room(-1) > room(1) ? -1 : 1);
    const gy = groundMin(x, z, 1.4) - 0.1;
    const yaw = Math.atan2(-ux, -uz); // faces away from the station, toward arrivals
    const Wd = 2.6, Hd = 0.9, postH = 1.35;
    const plane = new THREE.PlaneGeometry(Wd, Hd);
    const uv = plane.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, cell.uv.u0 + (cell.uv.u1 - cell.uv.u0) * uv.getX(i), cell.uv.v0 + (cell.uv.v1 - cell.uv.v0) * uv.getY(i));
    const face = plane.toNonIndexed();
    face.setAttribute('color', new THREE.BufferAttribute(new Float32Array(face.attributes.position.count * 3).fill(1), 3));
    face.applyMatrix4(mat4(0, postH + Hd / 2, 0.042));
    face.applyMatrix4(mat4(x, gy, z, yaw));
    boardsGeo.push(face);
    const backing = [baked(new THREE.BoxGeometry(Wd + 0.12, Hd + 0.12, 0.07), mat4(0, postH + Hd / 2, 0), '#3a2716')];
    for (const sx of [-1, 1]) backing.push(baked(new THREE.BoxGeometry(0.13, postH + Hd + 0.1, 0.13), mat4(sx * (Wd / 2 - 0.18), (postH + Hd) / 2, -0.07), '#3a2716'));
    for (const b of backing) { b.applyMatrix4(mat4(x, gy, z, yaw)); posts.push(b); }
    colliders.push({ x, z, hw: Wd / 2, hd: 0.3, rot: -yaw });
  }
  const postMesh = mergedMesh(posts, vcMat({ roughness: 0.85 }));
  if (postMesh) group.add(postMesh);
  // the signposts themselves: the Meshy square larch pole (sign_pole, metal cap) stretched to each post's height,
  // 13 cm thick, one instanced draw for the resort
  if (poles.length && models.sign_pole) {
    const pg = bakeGeometry(models.sign_pole, { size: 1, axis: 'y' });
    const k = 0.13 / Math.max(pg.size.x, pg.size.z);
    const inst = new THREE.InstancedMesh(pg.geometry, pg.material, poles.length);
    poles.forEach((q, i) => inst.setMatrixAt(i, mat4(q.x, q.y, q.z, q.yaw, 0, 0, k, q.h, k)));
    inst.name = 'signpost-poles';
    inst.castShadow = true; inst.receiveShadow = true; inst.computeBoundingSphere();
    group.add(inst);
  }
  // boards: caps carry the atlas; give every vertex a white colour so vertexColors stays neutral
  for (const g of boardsGeo) {
    if (!g.attributes.color) g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 3).fill(1), 3));
    if (g.attributes.normal === undefined) g.computeVertexNormals();
  }
  const boards = mergedMesh(boardsGeo.map((g) => { const h = new THREE.BufferGeometry(); for (const k of ['position', 'normal', 'uv', 'color']) h.setAttribute(k, g.attributes[k]); return h; }), faceMat);
  if (boards) group.add(boards);
  group.userData.signFaceMaterial = faceMat;
  group.userData.signSites = sites.length;
  group.userData.signStats = { starts: groups.length, forks: sites.filter((t) => !t.way && !t.junction).length - groups.length, junctions: sites.filter((t) => t.junction).length, boards: sites.reduce((n, t) => n + t.boards.length, 0) };
}

// arc length on piste p closest to (x, z)
function nearestArc(p, x, z) {
  const acc = arcLengths(p.pts);
  let best = 1e9, at = 0;
  for (let i = 0; i < p.pts.length; i++) {
    const d = Math.hypot(p.pts[i][0] - x, p.pts[i][1] - z);
    if (d < best) { best = d; at = acc[i]; }
  }
  return at;
}

// ------------------------------------------------------------------ piste border markers
function buildMarkers(group, index, nets, nearCannon, nearStation, inVillage) {
  const spots = [];
  for (const p of layout.pistes) {
    if (p.lane) continue; // the nets mark a lane's edges
    const acc = arcLengths(p.pts), L = acc.at(-1), w = PISTE_WIDTH[p.diff] + 0.1;
    // every ~25 m down both edges, just inside the fence line (Oct 29: the user couldn't tell where the runs go)
    const step = 25, n = Math.floor((L - 40) / step);
    for (let k = 0; k <= n; k++) {
      const s = 20 + k * step + ((k * 7) % 5) * 0.4 - 0.8; // a slightly irregular rhythm, like hand-set poles
      const q = sampleAt(p.pts, acc, s);
      const rx = -q.dz, rz = q.dx; // right, looking downhill
      for (const side of [1, -1]) {
        const x = q.x + rx * w * side, z = q.z + rz * w * side;
        if (inVillage(x, z) || nearStation(x, z, 40) || nearCannon(x, z, 3.5)) continue;
        if (index.clearance(x, z, p) < 1.5) continue; // inside another piste
        if (world.padInfluence(x, z) > 0.05) continue;
        if (nets.near(x, z, 0.8)) continue; // a hazard net stands right here (the nets stand 1.1 m further out)
        world.corridorAt(x, z, _corr);
        if (_corr.kind === 'race' && _corr.d < 0) continue; // on a World Cup course
        spots.push({ x, z, diff: p.diff, right: side > 0, lean: ((k * 13 + (side > 0 ? 5 : 0)) % 7 - 3) * 0.006 });
      }
    }
  }
  if (!spots.length) return;
  const POLE_H = 1.85, BAND = 0.32;
  const body = new THREE.CylinderGeometry(0.026, 0.032, POLE_H - BAND, 6);
  body.translate(0, (POLE_H - BAND) / 2, 0);
  const top = new THREE.CylinderGeometry(0.026, 0.026, BAND, 6);
  top.translate(0, POLE_H - BAND / 2, 0);
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.05 });
  const bodies = new THREE.InstancedMesh(body, mat, spots.length);
  const tops = new THREE.InstancedMesh(top, mat, spots.length);
  bodies.name = 'piste-markers'; tops.name = 'piste-marker-tops';
  const colors = PISTE_COLORS.map((c) => new THREE.Color(c)), orange = new THREE.Color(MARKER_ORANGE);
  spots.forEach((s, i) => {
    const y = world.height(s.x, s.z) - 0.3; // planted in the snow
    _m.copy(mat4(s.x, y, s.z, (i * 2.4) % 6.28, s.lean, -s.lean * 0.7));
    bodies.setMatrixAt(i, _m); tops.setMatrixAt(i, _m);
    bodies.setColorAt(i, colors[s.diff]);
    // the right-hand edge (looking downhill) carries an orange top, the left one stays in the piste colour
    tops.setColorAt(i, s.right ? orange : colors[s.diff]);
  });
  for (const m of [bodies, tops]) { m.castShadow = false; m.receiveShadow = true; m.computeBoundingSphere(); group.add(m); } // (thousands of thin poles: no shadow pass)
  group.userData.markers = spots.length;
}
const _corr = { d: 1e9, kind: null, dx: 0, dz: 1, groomed: false };

// ------------------------------------------------------------------ World Cup arenas
// For every arena course (race.arena): blue dye lines down both sides of the racing corridor, a red finish
// line, a start house behind the start, a big finish arch in the house style, a grandstand on its terrace
// facing the finish, a timing board and banner boards along the finish straight.
function drawArenaBanner(g, w, h, text) {
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
  g.fillStyle = HOUSE_BLUE; g.fillRect(0, h * 0.86, w, h * 0.14);
  g.fillStyle = '#e2231a'; g.fillRect(0, h * 0.8, w, h * 0.06);
  g.fillStyle = HOUSE_BLUE; g.textAlign = 'center'; g.textBaseline = 'middle';
  let size = Math.round(h * 0.56);
  g.font = `italic 700 ${size}px ${SIGN_FONT}`;
  while (g.measureText(text).width > w * 0.92 && size > 12) { size -= 2; g.font = `italic 700 ${size}px ${SIGN_FONT}`; }
  g.fillText(text, w / 2, h * 0.42);
}
function drawTimingBoard(g, w, h, name) {
  g.fillStyle = '#0d1014'; g.fillRect(0, 0, w, h);
  g.strokeStyle = '#2b3138'; g.lineWidth = 8; g.strokeRect(4, 4, w - 8, h - 8);
  g.fillStyle = '#ffffff'; g.textAlign = 'left'; g.textBaseline = 'middle';
  g.font = `italic 700 ${Math.round(h * 0.16)}px ${SIGN_FONT}`;
  g.fillText(name.toUpperCase(), w * 0.05, h * 0.18);
  const rows = [['1', 'LEGACY', '1:52.47'], ['2', 'BRUNNER', '+0.38'], ['3', 'MORETTI', '+0.91']];
  rows.forEach(([p, n, t], i) => {
    const y = h * (0.42 + i * 0.19);
    g.fillStyle = '#ffd34d'; g.font = `700 ${Math.round(h * 0.15)}px ${SIGN_FONT}`; g.textAlign = 'left';
    g.fillText(p, w * 0.05, y);
    g.fillStyle = '#ffffff'; g.fillText(n, w * 0.13, y);
    g.fillStyle = i ? '#ff6b5e' : '#7dff8a'; g.textAlign = 'right'; g.fillText(t, w * 0.95, y);
  });
}

function buildArenas(group, colliders, models) {
  const arenas = layout.races.filter((r) => r.arena);
  if (!arenas.length) return;
  const dyeTex = dyeTexture();
  const dye = new Buf(), red = new Buf(), solid = [], pylons = [];
  const white = new THREE.Color(1, 1, 1);
  // a dye strip along a polyline [[x, z]...] (ribbon on the snow, a few cm up)
  const ribbon = (B, line, width) => {
    const acc = arcLengths(line), L = acc.at(-1);
    const n = Math.max(2, Math.ceil(L / 1.0));
    let prev = null;
    for (let k = 0; k <= n; k++) {
      const q = sampleAt(line, acc, (k / n) * L), rx = -q.dz, rz = q.dx;
      const ax = q.x - rx * width / 2, az = q.z - rz * width / 2, bx = q.x + rx * width / 2, bz = q.z + rz * width / 2;
      const i0 = B.v(ax, world.height(ax, az) + 0.035, az, white, 0, (k / n) * L / 1.6);
      const i1 = B.v(bx, world.height(bx, bz) + 0.035, bz, white, 1, (k / n) * L / 1.6);
      if (prev) B.quad(prev[0], prev[1], i0, i1); // wound to face up (the decal material is single-sided)
      prev = [i0, i1];
    }
  };
  const bannerItems = [];
  for (const r of arenas) {
    const path = r.path, n = path.length;
    // dye lines 2.2 m inside the corridor edges (they break where another run joins)
    for (const side of [1, -1]) {
      let seg = [];
      const flush = () => { if (seg.length > 6) ribbon(dye, seg, 0.32); seg = []; };
      for (let i = 4; i < n - 4; i++) {
        const [ax, az] = path[i - 1], [bx, bz] = path[i + 1], l = Math.hypot(bx - ax, bz - az) || 1;
        const x = path[i][0] - ((bz - az) / l) * (r.halfWidth - 2.2) * side, z = path[i][1] + ((bx - ax) / l) * (r.halfWidth - 2.2) * side;
        world.corridorAt(x, z, _corr);
        if (_corr.kind === 'lift' && _corr.d < 0) { flush(); continue; }
        seg.push([x, z]);
      }
      flush();
    }
    // finish line across the course, red
    const [fx, fz] = path[n - 1], [px, pz] = path[Math.max(0, n - 4)];
    const fl = Math.hypot(fx - px, fz - pz) || 1, dx = (fx - px) / fl, dz = (fz - pz) / fl, rx = -dz, rz = dx;
    ribbon(red, [[fx - rx * (r.halfWidth - 1), fz - rz * (r.halfWidth - 1)], [fx + rx * (r.halfWidth - 1), fz + rz * (r.halfWidth - 1)]], 0.5);
    const fyaw = Math.atan2(dx, dz);
    // finish arch: two red pylons and a truss beam carrying the banner (both faces)
    {
      const span = r.halfWidth * 2 + 2, ph = 7.2;
      const top = Math.max(world.height(fx + rx * span / 2, fz + rz * span / 2), world.height(fx - rx * span / 2, fz - rz * span / 2), world.height(fx, fz)) + ph;
      for (const sd of [1, -1]) {
        const x = fx + rx * sd * span / 2, z = fz + rz * sd * span / 2, g0 = groundMin(x, z, 1.6) - 0.15; // (under its whole base plate)
        pylons.push({ x, y: g0, z, h: top - g0, yaw: fyaw });
        colliders.push({ x, z, r: 0.9 });
      }
      // beam (across the course: the box's x axis turned with the course heading)
      solid.push(baked(new THREE.BoxGeometry(span + 1.3, 1.9, 1.1), mat4(fx, top + 0.95, fz, fyaw), '#c8261d'));
      bannerItems.push({ text: `${r.name.toUpperCase()} · FINISH`, w: span - 0.4, h: 1.5, x: fx, y: top + 0.95, z: fz, yaw: fyaw + Math.PI, off: 0.56 });
      bannerItems.push({ text: 'SKI LEGACY · FINISH', w: span - 0.4, h: 1.5, x: fx, y: top + 0.95, z: fz, yaw: fyaw, off: 0.56 });
    }
    // banner boards along the last 60 m of both sides (where the nets stop), facing the course
    for (const side of [1, -1]) {
      for (let i = n - 2; i > Math.max(4, n - 17); i -= 2) {
        const [ax, az] = path[i - 1], [bx, bz] = path[i + 1], l = Math.hypot(bx - ax, bz - az) || 1;
        const nx = -(bz - az) / l * side, nz = (bx - ax) / l * side;
        const x = path[i][0] + nx * (r.halfWidth + 0.8), z = path[i][1] + nz * (r.halfWidth + 0.8);
        const yaw = Math.atan2(-nx, -nz), g0 = groundMin(x, z, 1.5);
        solid.push(baked(new THREE.BoxGeometry(3.9, 1.0, 0.12), mat4(x, g0 + 0.5, z, yaw), '#e9ecef'));
        bannerItems.push({ text: (i / 2) % 2 ? 'SKI LEGACY' : r.name.toUpperCase(), w: 3.8, h: 0.9, x: x + Math.sin(yaw) * 0.065, y: g0 + 0.5, z: z + Math.cos(yaw) * 0.065, yaw, off: 0, board: true });
        colliders.push({ x, z, hw: 1.95, hd: 0.2, rot: -yaw });
      }
    }
    // start house, just behind the start platform, facing down the course
    {
      const [sx, sz] = path[0], [qx, qz] = path[Math.min(n - 1, 4)], sl = Math.hypot(qx - sx, qz - sz) || 1;
      const ux = (qx - sx) / sl, uz = (qz - sz) / sl, syaw = Math.atan2(ux, uz);
      const hx = sx - ux * 8, hz = sz - uz * 8;
      if (models.start_house) {
        const m = fitModel(models.start_house, { size: 6, axis: 'z' });
        m.position.set(hx, groundMin(hx, hz, 2.5) - 0.15, hz);
        m.rotation.y = syaw;
        m.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
        m.updateMatrix(); m.matrixAutoUpdate = false; m.updateMatrixWorld(true);
        group.add(m);
      } else {
        const g0 = groundMin(hx, hz, 2.5) - 0.1;
        solid.push(baked(new THREE.BoxGeometry(4.2, 3.0, 3.6), mat4(hx, g0 + 1.5, hz, syaw), '#7a5634'));
        solid.push(baked(new THREE.BoxGeometry(4.8, 0.3, 4.4), mat4(hx, g0 + 3.15, hz, syaw), '#c8261d'));
        solid.push(baked(new THREE.BoxGeometry(4.6, 0.22, 4.2), mat4(hx, g0 + 3.4, hz, syaw), '#eef3f9'));
        solid.push(baked(new THREE.BoxGeometry(2.4, 2.1, 0.1), mat4(hx + ux * 1.82, g0 + 1.05, hz + uz * 1.82, syaw), '#1c2733'));
      }
      colliders.push({ x: hx, z: hz, hw: 2.4, hd: 2.2, rot: -syaw });
      // start banner on two masts across the gate
      // (high enough to clear the inflatable start arch races.js may put on the line)
      const span = 9, gy = world.height(sx, sz);
      for (const sd of [1, -1]) {
        const x = sx + -uz * sd * span / 2, z = sz + ux * sd * span / 2, g0 = world.height(x, z) - 0.3;
        solid.push(baked(new THREE.CylinderGeometry(0.09, 0.11, gy + 5.6 - g0, 10), mat4(x, (gy + 5.6 + g0) / 2, z), '#2a2e33'));
        colliders.push({ x, z, r: 0.25 });
      }
      bannerItems.push({ text: `START · ${r.name.toUpperCase()}`, w: span - 0.6, h: 1.1, x: sx, y: gy + 4.85, z: sz, yaw: syaw + Math.PI, off: 0.01, two: true });
    }
    // grandstand on its terrace beside the finish, and the timing board
    const plan = r.arenaPlan;
    if (plan) {
      const { x, z, yaw } = plan.stand;
      if (models.grandstand) { // (the Meshy stand; the old box bleachers are gone)
        const m = fitModel(models.grandstand, { size: 22, axis: 'x' });
        m.position.set(x, groundMin(x, z, 6) - 0.1, z);
        m.rotation.y = yaw;
        m.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
        m.updateMatrix(); m.matrixAutoUpdate = false; m.updateMatrixWorld(true);
        group.add(m);
      }
      colliders.push({ x, z, hw: 10.5, hd: 6, rot: -yaw });
      // the Meshy timing board on its own two legs at the end of the stand nearest the finish (7 m wide: clear of
      // the 22 m stand's end)
      const bx = x + Math.cos(yaw) * 15.2, bz = z - Math.sin(yaw) * 15.2;
      if (models.timing_board) {
        const m = fitModel(models.timing_board, { size: 7, axis: 'x' });
        m.position.set(bx, groundMin(bx, bz, 3) - 0.08, bz);
        m.rotation.y = yaw;
        m.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
        m.updateMatrix(); m.matrixAutoUpdate = false; m.updateMatrixWorld(true);
        group.add(m);
        colliders.push({ x: bx, z: bz, hw: 3.4, hd: 0.4, rot: -yaw });
      }
    }
  }
  // dye (blue) + finish line (red): decals on the snow, fading out with distance
  const dyeMat = (color) => fadeShader(new THREE.MeshStandardMaterial({ color, map: dyeTex, transparent: true, depthWrite: false, roughness: 0.9,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }), 260, 360, false);
  const dm = dye.mesh(dyeMat('#1f55e0'), 'arena-dye'), rm = red.mesh(dyeMat('#d8231a'), 'arena-finish-line');
  for (const m of [dm, rm]) if (m) { m.receiveShadow = true; m.renderOrder = 1; group.add(m); }
  // printed banners: one atlas of all texts (white house style), mapped onto planes
  // (one cell per distinct text and shape: the boards along the finish repeat a few texts)
  const atlas = new SignAtlas(), cellOf = new Map();
  for (const b of bannerItems) {
    const pw = b.timing ? 512 : b.board ? 512 : 1024, ph = b.timing ? 272 : Math.min(200, Math.max(48, Math.round((pw * b.h) / b.w)));
    const key = `${b.text}|${pw}x${ph}|${b.timing ? 't' : 'b'}`;
    if (!cellOf.has(key)) cellOf.set(key, atlas.add(pw, ph, (g, w, h) => (b.timing ? drawTimingBoard(g, w, h, b.text) : drawArenaBanner(g, w, h, b.text))));
    b.cell = cellOf.get(key);
  }
  const tex = atlas.finish();
  const faces = [];
  for (const b of bannerItems) {
    const plane = new THREE.PlaneGeometry(b.w, b.h).toNonIndexed();
    const uv = plane.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, b.cell.uv.u0 + (b.cell.uv.u1 - b.cell.uv.u0) * uv.getX(i), b.cell.uv.v0 + (b.cell.uv.v1 - b.cell.uv.v0) * uv.getY(i));
    const fx = Math.sin(b.yaw), fz = Math.cos(b.yaw);
    plane.applyMatrix4(mat4(b.x + fx * b.off, b.y, b.z + fz * b.off, b.yaw));
    faces.push(plane);
    if (b.two) { // a banner hung between masts reads from both sides
      const back = new THREE.PlaneGeometry(b.w, b.h).toNonIndexed();
      const uv2 = back.attributes.uv;
      for (let i = 0; i < uv2.count; i++) uv2.setXY(i, b.cell.uv.u0 + (b.cell.uv.u1 - b.cell.uv.u0) * uv2.getX(i), b.cell.uv.v0 + (b.cell.uv.v1 - b.cell.uv.v0) * uv2.getY(i));
      back.applyMatrix4(mat4(b.x - fx * 0.02, b.y, b.z - fz * 0.02, b.yaw + Math.PI));
      faces.push(back);
      solid.push(baked(new THREE.BoxGeometry(b.w + 0.1, b.h + 0.1, 0.012), mat4(b.x - fx * 0.01, b.y, b.z - fz * 0.01, b.yaw), '#ffffff'));
    }
  }
  const printMat = new THREE.MeshStandardMaterial({ map: tex, color: tex ? 0xffffff : 0xf2f2f2, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  const pm = mergeParts(faces, printMat, { cast: false });
  if (pm) { pm.name = 'arena-prints'; group.add(pm); }
  // the finish arches' pylons: the Meshy lattice truss tower (truss_pylon: white truss, red head, base plate), its
  // tower 1.25 m wide, stretched to carry the beam (one instanced draw)
  if (pylons.length && models.truss_pylon) {
    const tg = bakeGeometry(models.truss_pylon, { size: 1, axis: 'y' });
    const k = 1.25 / (tg.size.x * 0.42); // (the tower is ~42 % of the model's width: its head and base plate are wider)
    const inst = new THREE.InstancedMesh(tg.geometry, tg.material, pylons.length);
    pylons.forEach((q, i) => inst.setMatrixAt(i, mat4(q.x, q.y, q.z, q.yaw, 0, 0, k, q.h, k)));
    inst.name = 'finish-arch-pylons';
    inst.castShadow = true; inst.receiveShadow = true; inst.computeBoundingSphere();
    group.add(inst);
  }
  const sm = mergedMesh(solid, vcMat({ roughness: 0.7 }));
  if (sm) { sm.name = 'arena-structures'; group.add(sm); }
}

// ------------------------------------------------------------------ ski lane entry banners
// Over the entry of every ski lane, where it leaves its gondola stop: a banner in the house style (white
// cloth, SKI LANE in blue italic, the lane's name and length, a red rule over the blue hem) hung on a carrier
// cable between two steel masts at the lane's edges, high enough to ski under; it prints on both faces.
function drawLaneBanner(g, w, h, lane) {
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
  g.fillStyle = HOUSE_BLUE; g.fillRect(0, 0, w, h * 0.04); g.fillRect(0, h * 0.89, w, h * 0.11);
  g.fillStyle = '#e2231a'; g.fillRect(0, h * 0.84, w, h * 0.05);
  g.fillStyle = HOUSE_BLUE; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `italic 700 ${Math.round(h * 0.5)}px ${SIGN_FONT}`;
  g.fillText('SKI LANE', w / 2, h * 0.37);
  g.font = `700 ${Math.round(h * 0.15)}px ${SIGN_FONT}`;
  const len = arcLengths(lane.pts).at(-1);
  g.fillText(`${lane.name.toUpperCase()}  ·  ${(len / 1000).toFixed(1)} KM`, w / 2, h * 0.71);
  g.fillStyle = '#9aa3ad'; // grommets
  for (const x of [h * 0.1, w - h * 0.1]) for (const y of [h * 0.13, h * 0.78]) { g.beginPath(); g.arc(x, y, h * 0.03, 0, 7); g.fill(); }
}

function buildLaneGates(group, colliders) {
  if (!layout.lanes.length) return;
  const atlas = new SignAtlas();
  const items = layout.lanes.map((lane) => ({ lane, cell: atlas.add(1024, 190, (g, w, h) => drawLaneBanner(g, w, h, lane)) }));
  const tex = atlas.finish();
  const steel = [], faces = [];
  const STEEL = '#2a2e33', BW = 10, BH = 1.85;
  for (const { lane, cell } of items) {
    const acc = arcLengths(lane.pts), q = sampleAt(lane.pts, acc, 8), a = sampleAt(lane.pts, acc, 2), b = sampleAt(lane.pts, acc, 20);
    const dl = Math.hypot(b.x - a.x, b.z - a.z) || 1, dx = (b.x - a.x) / dl, dz = (b.z - a.z) / dl, rx = -dz, rz = dx; // down the lane, its right
    const half = PISTE_WIDTH[lane.diff] - 1.2;
    const masts = [-1, 1].map((s) => { const x = q.x + rx * s * half, z = q.z + rz * s * half; return { x, z, g: groundMin(x, z, 0.3) }; });
    let gMax = -Infinity;
    for (let k = -4; k <= 4; k++) gMax = Math.max(gMax, world.height(q.x + rx * (k / 4) * half, q.z + rz * (k / 4) * half));
    const top = gMax + 6.3, by = top - 0.45 - BH / 2;
    for (const m of masts) {
      steel.push(baked(new THREE.CylinderGeometry(0.075, 0.1, top - m.g + 0.3, 12), mat4(m.x, (top + m.g - 0.3) / 2, m.z), STEEL));
      steel.push(baked(new THREE.SphereGeometry(0.12, 12, 8), mat4(m.x, top + 0.04, m.z), STEEL));
      colliders.push({ x: m.x, z: m.z, r: 0.25 });
    }
    // the cloth (front faces up the lane; the back sheet reads from below), on a thin white backing
    const yaw = Math.atan2(-dx, -dz);
    for (const [s, turn] of [[1, 0], [-1, Math.PI]]) {
      const plane = new THREE.PlaneGeometry(BW, BH).toNonIndexed(), uv = plane.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, cell.uv.u0 + (cell.uv.u1 - cell.uv.u0) * uv.getX(i), cell.uv.v0 + (cell.uv.v1 - cell.uv.v0) * uv.getY(i));
      plane.applyMatrix4(mat4(q.x - dx * 0.012 * s, by, q.z - dz * 0.012 * s, yaw + turn));
      faces.push(plane);
    }
    steel.push(baked(new THREE.BoxGeometry(BW + 0.06, BH + 0.06, 0.012), mat4(q.x, by, q.z, yaw), '#f4f5f7'));
    // carrier cable over the masts, and tension lines from the cloth's corners out to the masts
    const cable = (x0, z0, x1, z1, y, r = 0.012) => {
      const len = Math.hypot(x1 - x0, z1 - z0);
      steel.push(baked(new THREE.CylinderGeometry(r, r, len, 5), mat4((x0 + x1) / 2, y, (z0 + z1) / 2, Math.atan2(-(z1 - z0), x1 - x0), 0, Math.PI / 2), STEEL));
    };
    cable(masts[0].x, masts[0].z, masts[1].x, masts[1].z, top - 0.12, 0.016);
    for (const s of [-1, 1]) {
      const m = masts[s < 0 ? 0 : 1], ex = q.x + rx * s * BW / 2, ez = q.z + rz * s * BW / 2;
      for (const y of [by + BH / 2 - 0.06, by - BH / 2 + 0.06]) cable(ex, ez, m.x, m.z, y);
    }
  }
  const printMat = new THREE.MeshStandardMaterial({ map: tex, color: tex ? 0xffffff : 0xf2f2f2, roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  const pm = mergeParts(faces, printMat, { cast: true });
  if (pm) { pm.name = 'lane-banners'; group.add(pm); }
  const sm = mergedMesh(steel, vcMat({ roughness: 0.5, metalness: 0.4 }));
  if (sm) { sm.name = 'lane-masts'; group.add(sm); }
  group.userData.laneGates = items.length;
}

// ------------------------------------------------------------------ ski patrol huts
function buildPatrolHuts(group, colliders, models) {
  let proto = null, size = null;
  if (models.patrol_hut) {
    proto = fitModel(models.patrol_hut, { size: 4.4, axis: 'x' });
    size = proto.userData.size;
  }
  const procGeo = proto ? null : patrolHutGeometry();
  const procMat = proto ? null : vcMat({ roughness: 0.78 });
  for (const pk of layout.peaks) {
    if (!pk.patrol || !pk.lift) continue;
    const { x, z } = pk.patrol;
    // front faces the top station
    const yaw = Math.atan2(pk.lift.top.x - x, pk.lift.top.z - z);
    const y = groundMin(x, z, 2.2) - 0.12;
    let obj;
    if (proto) { obj = proto.clone(true); obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } }); }
    else { obj = new THREE.Mesh(procGeo, procMat); obj.castShadow = true; obj.receiveShadow = true; }
    obj.position.set(x, y, z);
    obj.rotation.y = yaw;
    obj.updateMatrix(); obj.matrixAutoUpdate = false;
    obj.updateMatrixWorld(true);
    group.add(obj);
    const hw = size ? size.x / 2 : 2.2, hd = size ? size.z / 2 : 1.8;
    colliders.push({ x, z, hw: hw * 0.9, hd: hd * 0.9, rot: -yaw });
  }
}

// ------------------------------------------------------------------ hut sun terraces
// The village builds each mountain hut facing hut.yaw (front = +z for yaw 0) with its sign on the
// left of the door; the terrace lies in front: deck chairs facing the view, benches and tables.
function buildTerraces(group, colliders, models, index) {
  const chairs = [], items = [];
  for (const hut of layout.huts) {
    const yaw = hut.yaw ?? 0, fx = Math.sin(yaw), fz = Math.cos(yaw), sx = fz, sz = -fx; // sx: hut's local +x
    const at = (lx, lz) => [hut.x + sx * lx + fx * lz, hut.z + sz * lx + fz * lz];
    const free = (x, z, r) => index.clearance(x, z) > r + 1 && world.padInfluence(x, z) > 0.6;
    // a row of deck chairs along the terrace edge (clear of the door and the sign)
    for (const lx of [1.9, 3.15, 4.4, 5.65, 6.9, -5.6, -6.85]) {
      const [x, z] = at(lx, 12.6);
      if (free(x, z, 0.8)) chairs.push({ x, z, yaw: yaw + (((lx * 7) % 3) - 1) * 0.05 });
    }
    for (const [name, lx, lz, ry, size, axis, r] of [
      ['picnic_table', 6.4, 9.6, 0.06, 2.0, 'xz', 1.0], ['picnic_table', -7.2, 9.8, -0.08, 2.0, 'xz', 1.0],
      ['wooden_bench', 4.4, 8.0, 0, 1.8, 'xz', 0.6], ['wooden_bench', -6.8, 7.6, 0, 1.8, 'xz', 0.6],
    ]) {
      const [x, z] = at(lx, lz);
      if (free(x, z, r)) items.push({ name, x, z, yaw: yaw + ry, size, axis, r });
    }
  }
  // Meshy benches / tables (skipped when a model is missing)
  for (const it of items) {
    const gltf = models[it.name];
    if (!gltf) continue;
    const m = fitModel(gltf, { size: it.size, axis: it.axis });
    m.position.set(it.x, groundMin(it.x, it.z, 0.8) - 0.04, it.z);
    m.rotation.y = it.yaw;
    m.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    m.updateMatrix(); m.matrixAutoUpdate = false; m.updateMatrixWorld(true);
    group.add(m);
    colliders.push({ x: it.x, z: it.z, r: it.r });
    propSeats(it.name, m, it.size); // (benches: you can sit on them)
  }
  // the Meshy deck chair (striped canvas on a beech frame, facing +z like the terrace rows), one instanced draw
  if (!chairs.length || !models.deck_chair) return;
  const dc = bakeGeometry(models.deck_chair, { size: 0.95, axis: 'y' });
  if (!dc.geometry) return;
  const deck = new THREE.InstancedMesh(dc.geometry, dc.material, chairs.length);
  deck.name = 'deckchairs';
  chairs.forEach((c, i) => {
    const y = groundMin(c.x, c.z, 0.75) - 0.02;
    deck.setMatrixAt(i, mat4(c.x, y, c.z, c.yaw));
    registerBench({ x: c.x, y: y + 0.38, z: c.z, yaw: c.yaw, n: 1, off: -0.12, floorY: y }); // (sit in it)
  });
  deck.castShadow = true; deck.receiveShadow = true; deck.computeBoundingSphere();
  group.add(deck);
  group.userData.deckChairs = chairs.length;
}
