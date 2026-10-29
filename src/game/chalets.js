// THE CHALET VILLAGE (Almdorf): two-storey chalets (the user's Meshy chalet: white plaster below, timber above,
// snowy roofs) on terraces on both sides of the Chaletweg up the gentle forested slope north of Legacy Village (its
// layout, its ground and its road: game/bus/chaletroad.js, part of busRoads; its bus stop "Almdorf" at the junction
// with the valley road). 18 chalets, numbered up the Chaletweg ("Chalet 1" is the first you reach from the valley
// road): a blue enamel number plaque by each front door and the number on the mailbox at the garden gate. Every plot:
// the chalet facing the road, a snowy garden inside ONE continuous picket fence (gaps for the drive and the gate),
// small spruces, a bench, a shed or a snowman, a sledge in the garden, stepping stones from the gate to the front
// steps, and a private parking space beside the house (two 2.5 x 5 m bays, "PRIVAT" painted in each, a "P PRIVAT"
// sign) with its drive off the road. The playground on a plot of its own.
// Outside you always see the Meshy model: the full textured chalet.glb on the chalet you're nearest, the low-poly
// chalet_lo.glb (one instanced mesh) on the rest; never both on one plot.
// Cheap: everything small is merged or instanced (the fences: two meshes for the whole village; the posts, stones,
// mailboxes and sign posts: one; the plaques, number plates and signs: one atlas mesh); no shadows from small props;
// no per-frame work while you're away from the village.
// BUY A CHALET ($50,000, yours for good, ONE each: save.chalet = { id, name, owned, since, furniture, layout }).
// E at a chalet's front door: buy it, or have a look inside; your own one: go in. Going in: a short fade, and the
// interior (game/chaletroom.js, its own scene: post.setView) with the real world in its windows; E at its front door:
// a fade, and you're back outside in front of the chalet.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { world } from '../world/world.js';
import { layout } from '../world/layout.js';
import { busRoads } from './bus/roads.js';
import { chaletLampSpots, driveHeight, driveDistance, DRIVE_W } from './bus/chaletroad.js';
import { loadGLB, fitModel, clusterDecimate } from '../core/assets.js';
import { addNightGlow, nightUniform } from '../world/village.js';
import { addStreetLamps } from '../world/pistelights.js';
import { HX, HZ, G, DOOR, MODEL, FOOT, STEPS, IX, IZ } from './chaletplan.js';
import { ChaletRoom, setChaletInterior } from './chaletroom.js';

export const CHALET_PRICE = 50000; // (bought for good, not rented)
export const SAVE_LAYOUT = 3;      // save.chalet.layout: the 18-chalet village (Oct 29); older saves are moved onto it
const S = MODEL.scale;
const POST_STEP = 1.8;             // m between the fence's posts
const PICKET = 0.16;               // m: one picket and its gap (the fence's texture repeats every PICKET)
const FENCE_H = 1.0;
const HI_R = 60;                   // m: the full model on the chalet you're nearest, within this
const PLAQUE = { x: 4.015, y: 1.85, z: 1.45, w: 0.22, h: 0.165 }; // house frame: on the plaster right of the door (measured flat there)
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const _l = new THREE.Vector3();
const LAMP_H = 3.6, LAMP_LIGHT_Y = 3.1; // the lamp post (as in Legacy Village), its lantern
export const NEAR_HOME = 300;        // m: the marker / waypoint to your chalet show within this (+50 m fade)
const MARK_Y = 11.5;                    // m over the pad: the marker over your own chalet
const UP = new THREE.Vector3(0, 1, 0);
// the chalet model's own windows (their glass, house frame: measured off chalet.glb with orthographic renders and
// rays, Oct 29): [outward normal, x, y (centre), z, width, height]; lit warm at night (buildWindows)
const MODEL_WINDOWS = [
  ['x', 3.857, 2.06, 3.14, 0.72, 0.96], ['x', 3.856, 2.06, -2.93, 0.74, 0.96], ['x', 3.85, 5.35, 0.99, 0.62, 0.55], ['x', 3.85, 5.35, -0.82, 0.62, 0.55],
  ['-x', -3.842, 5.32, 1.04, 0.72, 0.6], ['-x', -3.837, 5.31, -0.47, 0.74, 0.58], ['-x', -3.855, 2.06, -2.92, 0.72, 0.96], ['-x', -3.852, 2.06, 3.11, 0.7, 0.96],
  ['z', -1.68, 5.11, 5.943, 0.68, 1.02], ['z', -0.81, 5.11, 5.938, 0.62, 1.02], ['z', 0.85, 5.11, 5.95, 0.66, 1.02], ['z', 1.72, 5.12, 5.95, 0.64, 1.0],
  ['z', -2.11, 2.07, 5.902, 0.86, 0.96], ['z', -0.12, 1.55, 5.913, 0.68, 1.98], ['z', 1.96, 2.06, 5.9, 0.9, 0.96],
  ['-z', -0.5, 5.37, -5.862, 1.08, 0.94], ['-z', 1.49, 2.06, -5.83, 0.7, 0.96], ['-z', -1.67, 2.06, -5.91, 0.7, 0.96],
];
const hash = (i) => { const v = Math.sin(i * 91.7 + 17.3) * 43758.5453; return v - Math.floor(v); };

// ------------------------------------------------------------------ where everything stands (pure: the game and the
// Node checks use it). Items: { kind, x, z, yaw, y, ... } in the world; boxes for the checks: { hw, hd, y0, y1 }
// round (x, z) turned by yaw (three.js rotation.y), flat: laid on the ground.
export function houseFrame(p) {
  const f = new THREE.Object3D();
  f.position.set(p.house.x, p.y, p.house.z); f.rotation.y = -Math.PI / 2 + p.house.yaw; // (+x, the door, to the road)
  f.updateMatrixWorld(true);
  return f;
}
export function villagePlacements(V, height = (x, z) => world.height(x, z)) {
  const out = [];
  const put = (o) => { out.push(o); return o; };
  // one fence per plot: a closed loop of runs (corner to corner), each run cut by its gaps [[u0, u1]] (m along it);
  // every straight stretch: a 'fence' item (a -> b, its posts every ~POST_STEP), posts at its ends
  const fenceRun = (pid, ax, az, bx, bz, gaps = []) => {
    const L = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / L, uz = (bz - az) / L, yaw = Math.atan2(-uz, ux);
    let u = 0;
    const cuts = gaps.filter((g) => g[1] > 0 && g[0] < L).sort((a, b) => a[0] - b[0]);
    cuts.push([L, L]);
    for (const [g0, g1] of cuts) {
      const a = Math.max(0, u), b = Math.min(g0, L);
      if (b - a > 0.3) {
        const x0 = ax + ux * a, z0 = az + uz * a, x1 = ax + ux * b, z1 = az + uz * b;
        put({ kind: 'fence', pid, ax: x0, az: z0, bx: x1, bz: z1, x: (x0 + x1) / 2, z: (z0 + z1) / 2, yaw, len: b - a, hw: (b - a) / 2, hd: 0.06, y0: 0, y1: FENCE_H, col: true });
      }
      u = Math.max(u, g1);
    }
  };
  const loop = (pid, xa, xb, zf, zb, frontGaps) => { // (front: xa -> xb at zf; then down the far side, the back, up)
    fenceRun(pid, xa, zf, xb, zf, frontGaps);
    fenceRun(pid, xb, zf, xb, zb);
    fenceRun(pid, xb, zb, xa, zb);
    fenceRun(pid, xa, zb, xa, zf);
  };
  for (const p of V.plots) {
    const sd = p.side, zIn = (d) => p.front + sd * d, depth = Math.abs(p.back - p.front), yawOut = sd < 0 ? 0 : Math.PI; // (facing the road)
    const xa = p.x0 + 0.2, xb = p.x1 - 0.2, zf = zIn(0.25), zb = zIn(depth - 0.25);
    if (p.playground) {
      const x = (p.x0 + p.x1) / 2, z = zIn(depth / 2 + 0.5);
      put({ kind: 'playground', pid: p.id, x, z, y: height(x, z), yaw: yawOut, hw: 2.35, hd: 2.1, y0: 0, y1: 3.6, col: true });
      for (const dx of [-6.5, 6.5]) { const bz = zIn(2.4); put({ kind: 'bench', pid: p.id, x: x + dx, z: bz, y: height(x + dx, bz), yaw: yawOut, hw: 0.8, hd: 0.45, y0: 0, y1: 1.15, col: true }); }
      loop(p.id, xa, xb, zf, zb, [[(xb - xa) / 2 - 1.0, (xb - xa) / 2 + 1.0]]);
      continue;
    }
    const f = houseFrame(p), L = (x, z) => f.localToWorld(_l.set(x, 0, z)).clone();
    const yaw = f.rotation.y, c = f.position;
    put({ kind: 'house', pid: p.id, num: p.num, x: c.x, z: c.z, y: p.y, yaw, hw: HX, hd: HZ, y0: 0, y1: 8 });
    { const q = L((STEPS.x0 + STEPS.x1) / 2, (STEPS.z0 + STEPS.z1) / 2); put({ kind: 'steps', pid: p.id, x: q.x, z: q.z, y: p.y, yaw, hw: (STEPS.x1 - STEPS.x0) / 2, hd: (STEPS.z1 - STEPS.z0) / 2, y0: 0, y1: G }); }
    { const q = L((FOOT.x0 + FOOT.x1) / 2, (FOOT.z0 + FOOT.z1) / 2); put({ kind: 'eaves', pid: p.id, x: q.x, z: q.z, y: p.y, yaw, hw: (FOOT.x1 - FOOT.x0) / 2, hd: (FOOT.z1 - FOOT.z0) / 2, y0: 4.6, y1: 8 }); }
    // the way in: the steps, the landing in front of them, the path to the gate (no props there)
    { const q = L(HX + 1.2, DOOR.z); put({ kind: 'doorway', pid: p.id, x: q.x, z: q.z, y: p.y, yaw, hw: 1.6, hd: 1.6, y0: 0, y1: 2.5, keepOut: true }); }
    { const q = L(HX + 0.04, PLAQUE.z); put({ kind: 'plaque', pid: p.id, num: p.num, x: q.x, z: q.z, y: p.y + PLAQUE.y, yaw: yaw, hw: PLAQUE.w / 2, hd: 0.01 }); }
    const door = L(HX + 1.6, DOOR.z), dx = door.x;
    // the parking space and its drive (flat; edge to edge, never on top of each other)
    // (chaletroad.js planChaletDrives graded both: p.drv; the drive meets the road's plowed edge, edge to edge)
    // (Oct 29: the bays set back beside the house, a 3.2 m lane to them; chaletroad.js DRIVE_W, BAY_SET)
    const bay = p.bay, bw = bay.w, dw = DRIVE_W, bz0 = p.drv?.zb ?? bay.z - sd * bay.d / 2, bz1 = p.drv?.zc ?? bay.z + sd * bay.d / 2, road = p.drv?.za ?? p.legZ + sd * 3.4;
    put({ kind: 'bay', pid: p.id, plot: p, x: bay.x, z: (bz0 + bz1) / 2, yaw: 0, hw: bw / 2, hd: bay.d / 2, flat: true, x0: bay.x - bw / 2, x1: bay.x + bw / 2, za: bz0, zb: bz1, out: sd });
    put({ kind: 'drive', pid: p.id, plot: p, x: bay.x, z: (road + bz0) / 2, yaw: 0, hw: dw / 2, hd: Math.abs(bz0 - road) / 2, flat: true, x0: bay.x - dw / 2, x1: bay.x + dw / 2, za: road, zb: bz0 });
    // ONE fence round the plot: gaps for the drive (its snow berm too: buildLanes, 0.6 m) and the gate
    const gx0 = bay.x - dw / 2 - 0.75 - xa, gx1 = bay.x + dw / 2 + 0.75 - xa;
    loop(p.id, xa, xb, zf, zb, [[gx0, gx1], [dx - 0.65 - xa, dx + 0.65 - xa]]);
    const toHouse = Math.sign(c.x - bay.x) || 1, awayBay = Math.sign(dx - bay.x) || 1;
    // the "P PRIVAT" sign: inside the fence beside the drive's gap (clear of its berm), on the house side, facing the road
    { const sx = bay.x + toHouse * (dw / 2 + 1.05), sz = zIn(0.55); put({ kind: 'sign', pid: p.id, x: sx, z: sz, y: height(sx, sz), yaw: yawOut, hw: 0.25, hd: 0.06, y0: 0, y1: 1.95, col: true, r: 0.12 }); }
    // the mailbox at the gate (its number on the front), on the gate's side away from the drive
    { const mx = dx + awayBay * 1.05, mz = zIn(0.6); put({ kind: 'mailbox', pid: p.id, num: p.num, x: mx, z: mz, y: height(mx, mz), yaw: yawOut, hw: 0.2, hd: 0.18, y0: 0, y1: 1.3, col: true, r: 0.15 }); }
    // stepping stones from the gate to the steps (flush with the snow)
    const dSteps = Math.abs(L(STEPS.x1, DOOR.z).z - p.front);
    for (let d = 0.7; d < dSteps - 0.35; d += 0.62) { const z = zIn(d), x = dx + (hash(p.id * 3 + d * 7) - 0.5) * 0.12; put({ kind: 'stone', pid: p.id, x, z, y: height(x, z), yaw: 0, spin: hash(p.id + d) * 6, hw: 0.29, hd: 0.29, flat: true, r: 0.29 }); }
    // the garden strip beside the house: a bench facing the view, a sledge, small spruces, a shed or a snowman
    const [g0, g1] = p.garden, gx = (Math.max(g0, xa + 0.2) + Math.min(g1, xb - 0.2)) / 2;
    if (p.bench !== false) { const z = zIn(2.3); put({ kind: 'bench', pid: p.id, x: gx, z, y: height(gx, z), yaw: yawOut, hw: 0.8, hd: 0.45, y0: 0, y1: 1.15, col: true }); }
    if (hash(p.id * 17) < 0.55) { const x = gx + 0.7, z = zIn(3.6); put({ kind: 'sledge', pid: p.id, x, z, y: height(x, z), yaw: yawOut + Math.PI / 2 + 0.3, hw: 0.5, hd: 0.25, y0: 0, y1: 0.35 }); }
    const tree = (x, d, h, kind = 'spruce') => { const z = zIn(d); put({ kind, pid: p.id, x, z, y: height(x, z), yaw: hash(p.id * 5 + d) * 6.28, h, hw: h * 0.2, hd: h * 0.2, y0: 0, y1: h, col: kind === 'spruce', r: h * 0.16, v: hash(p.id * 11 + d) < 0.5 ? 0 : 1 }); };
    tree(gx - 0.75, 5.2, 2.6 + hash(p.id) * 0.8); tree(gx + 0.85, 7.0, 2.2 + hash(p.id + 1) * 0.6);
    if (p.shed) { const z = zIn(depth - 0.25 - 1.75); put({ kind: 'shed', pid: p.id, x: gx, z, y: height(gx, z), yaw: yawOut, hw: 1.48, hd: 1.6, y0: 0, y1: 2.2, col: true }); }
    else {
      tree(gx, 10.2, 3.0 + hash(p.id + 2) * 0.7);
      if (hash(p.id * 7) < 0.6) { const z = zIn(8.4), x = gx - 0.6; put({ kind: 'snowman', pid: p.id, x, z, y: height(x, z), yaw: yawOut + 0.4, hw: 0.35, hd: 0.35, y0: 0, y1: 1.5, col: true, r: 0.4 }); }
    }
    // (no dwarf spruces along the front of the house any more: decimated to a few hundred triangles, at night they
    // read as black armchairs against the wall (Oct 29, the user))
  }
  return out;
}

// the house-number atlas (one texture for every plaque, mailbox plate and parking sign): 8 x 4 cells of 128 x 96
// (the numbers 1-32, blue enamel, white digits and border), the "P PRIVAT" sign below them (384 x 512)
const ATLAS = { w: 1024, h: 1024, cw: 128, ch: 96, cols: 8, sign: { x: 0, y: 400, w: 384, h: 512 } };
function atlasCell(n) { // uv rect (three: v up) of number n
  const i = (n - 1) % 32, cx = (i % ATLAS.cols) * ATLAS.cw, cy = Math.floor(i / ATLAS.cols) * ATLAS.ch;
  return [cx / ATLAS.w, 1 - (cy + ATLAS.ch) / ATLAS.h, (cx + ATLAS.cw) / ATLAS.w, 1 - cy / ATLAS.h];
}
const SIGN_UV = [ATLAS.sign.x / ATLAS.w, 1 - (ATLAS.sign.y + ATLAS.sign.h) / ATLAS.h, (ATLAS.sign.x + ATLAS.sign.w) / ATLAS.w, 1 - ATLAS.sign.y / ATLAS.h];

// The snow on the drives and parking bays (as on the plowed roads, bus.js: the same kind of shader noise, in the
// drape's own material, so no extra draw call): packed snow with wheel tracks up the middle of each 2.5 m bay
// (worn to slush and tarmac in places), ragged snow along the edges, big patches of fresh snow and bare tarmac in
// world space; the painted lines and PRIVAT show faintly through it (and clearly in the tracks).
// uv (drape): u across the space (0..1, its two bays: lines at 0.04 / 0.5 / 0.96), world z along it.
const DRIVE_SNOW_GLSL = `
varying vec3 vSnW;
varying vec2 vSnUv;
float snH(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float snN(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(snH(i), snH(i + vec2(1.0, 0.0)), f.x), mix(snH(i + vec2(0.0, 1.0)), snH(i + vec2(1.0, 1.0)), f.x), f.y); }
float snF(vec2 p) { return snN(p) * 0.5 + snN(p * 2.03 + 7.1) * 0.25 + snN(p * 4.01 + 3.3) * 0.125 + snN(p * 8.1 + 1.7) * 0.0625; }
float snWet = 0.0;
`;
const DRIVE_SNOW_FRAG = `
  {
    vec2 Wp = vSnW.xz;
    float sz = vSnW.z;
    #ifdef DRIVE_BAY
    float a = (vSnUv.x - 0.5) * 5.4, bt = 0.0, hw = 2.7; // (the bays: uv 0..1 across the 5.4 m)
    #else
    float a = vSnUv.x, bt = vSnUv.y, hw = 1.6;          // (the lane: metres across; the berm: bt > 0)
    #endif
    float wob = (snN(vec2(sz * 0.35, 3.7)) - 0.5) * 0.19;
    float wid = 0.16 + 0.08 * snN(vec2(sz * 0.5, 1.3)); // (m: a tyre's track)
    float tr = 0.0, aa = abs(a);
    #ifdef DRIVE_BAY
    tr = max(tr, 1.0 - smoothstep(wid * 0.5, wid * 1.6, abs(aa - 0.45 - wob)));
    tr = max(tr, 1.0 - smoothstep(wid * 0.5, wid * 1.6, abs(aa - 2.05 + wob)));
    #else
    tr = max(tr, 1.0 - smoothstep(wid * 0.5, wid * 1.6, abs(aa - 0.8 - wob)));
    #endif
    float fine = snF(Wp * 1.1), P = snF(Wp * 0.09 + 4.0);
    float clearT = (0.45 + 0.55 * smoothstep(0.3, 0.7, snN(vec2(sz * 0.12, Wp.x * 0.05 + 5.5)))) * (0.6 + 0.4 * fine);
    float eN = snN(vec2(sz * 0.6, 2.2)) * 0.2 + (fine - 0.5) * 0.15;
    float edge = smoothstep(hw - 0.45 - eN, hw - 0.05, aa) + step(0.001, bt);
    float snow = clamp(1.0 - tr * clearT, 0.0, 1.0) * smoothstep(0.12, 0.45, P + 0.3 * fine);
    float bare = smoothstep(0.66, 0.82, P);
    snow = max(snow * (1.0 - bare * 0.85), clamp(edge, 0.0, 1.0));
    float slush = (1.0 - snow) * smoothstep(0.3, 0.65, snF(Wp * 0.25 + 11.0)) * (1.0 - bare);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.30, 0.29, 0.28) * (0.85 + 0.3 * fine), slush * 0.7);
    // (at most ~80 % cover away from the edges: the paint underneath still reads, faintly)
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.80, 0.84, 0.89) * (0.88 + 0.16 * fine), max(clamp(snow * (0.62 + 0.2 * fine) + clamp(edge, 0.0, 1.0) * 0.18, 0.0, 1.0), step(0.001, bt)));
    snWet = slush;
  }
`;
function drivewaySnow(mat, key) {
  if (key === 'bay') mat.defines = { ...(mat.defines || {}), DRIVE_BAY: '' };
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSnW;\nvarying vec2 vSnUv;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSnW = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvSnUv = uv;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${DRIVE_SNOW_GLSL}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${DRIVE_SNOW_FRAG}`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor *= 1.0 - 0.45 * snWet;');
  };
  mat.customProgramCacheKey = () => `chalet-drive-snow-${key}`;
  return mat;
}

export class Chalets {
  constructor(o) {
    // o: scene, camera, renderer, colliders, cameraBlockers, hud, audio, save, writeSave, spend, transition, player, getPost, getHour
    Object.assign(this, o);
    this.V = busRoads.chalets;
    this.inside = false; this.current = null; this.target = null; this.viewing = null;
    this.houses = []; this.hiAt = -1;
    if (!this.V) return;
    this.plan();
    this.migrateSave();
    setChaletInterior(null, this); // (the room itself: built the first time you go in)
    this.ready = this.build().catch((e) => console.warn('chalet village', e));
  }

  // save.chalet from before: furniture from before the Oct 28 rescale moved onto the new floors; a chalet from the
  // 54-plot village (Oct 29: 18 now) moved onto one of the 18, renamed "Chalet N"
  migrateSave() {
    const c = this.save?.chalet;
    if (!c) return;
    let dirty = false;
    if (c.furniture?.length && !(c.plan >= 2)) {
      for (const r of c.furniture) {
        if (Number.isFinite(r.y)) r.y = r.y < 3.2 ? Math.max(G, r.y - 0.25) : r.y - 0.35;
        if (Number.isFinite(r.x)) r.x = Math.max(-IX + 0.25, Math.min(IX - 0.25, r.x));
        if (Number.isFinite(r.z)) r.z = Math.max(-IZ + 0.25, Math.min(IZ - 0.25, r.z));
      }
      dirty = true;
    }
    if (c.plan !== 2) { c.plan = 2; dirty = true; }
    if (c.id != null && c.layout !== SAVE_LAYOUT) {
      const h = this.houses.find((x) => x.id === c.id) || this.houses[0]; // (an id the new village doesn't have: Chalet 1)
      if (h) { c.id = h.id; c.name = h.name; }
      c.layout = SAVE_LAYOUT; dirty = true;
    }
    const h = this.rented();
    if (h && c.name !== h.name) { c.name = h.name; dirty = true; }
    if (dirty) this.writeSave?.();
  }

  plan() {
    for (const p of this.V.plots) {
      if (p.playground) continue;
      const frame = houseFrame(p);
      const door = frame.localToWorld(new THREE.Vector3(HX + 0.9, 0, DOOR.z)); // (on the steps)
      const out = new THREE.Vector3(1, 0, 0).applyQuaternion(frame.quaternion);
      this.houses.push({ id: p.id, num: p.num, name: p.name || `Chalet ${p.num}`, plot: p, frame, door, out, yaw: frame.rotation.y });
    }
    this.houses.sort((a, b) => a.num - b.num);
    this.items = villagePlacements(this.V);
    this.benchSpots = this.items.filter((i) => i.kind === 'bench').map((b) => ({ x: b.x, y: b.y, z: b.z, yaw: b.yaw }));
    // the street lamps (Legacy Village's lamp post) along the Chaletweg, at the junction / bus stop and round the
    // car park: their light pools from now on (world/pistelights.js: no THREE lights), the posts in build()
    this.lamps = chaletLampSpots(this.V, this.items, this.colliders || []);
    for (const l of this.lamps) { l.y = world.height(l.x, l.z) - 0.05; this.colliders?.push({ x: l.x, z: l.z, r: 0.22 }); }
    addStreetLamps(this.lamps.map((l) => ({ x: l.x, z: l.z, y: l.y + LAMP_LIGHT_Y })));
    const first = this.houses[0];
    const r = this.V.road, road = [];
    for (let i = 0; i < r.n; i += 3) road.push([r.X[i], r.Z[i]]);
    layout.chaletVillage = {
      x: first ? first.door.x : this.V.place.x, z: first ? first.door.z : this.V.place.z, label: 'Chalet village', center: { x: this.V.place.x, z: this.V.place.z },
      houses: this.houses.map((h) => ({ id: h.id, num: h.num, name: h.name, x: h.frame.position.x, z: h.frame.position.z, yaw: h.yaw, w: 2 * HX, d: 2 * HZ })),
      road, playground: this.V.plots.filter((p) => p.playground).map((p) => ({ x: (p.x0 + p.x1) / 2, z: (p.z0 + p.z1) / 2 })),
      rented: () => this.save.chalet?.id ?? null,
      ownedName: () => this.rented()?.name || null,
    };
  }

  // ------------------------------------------------------------------ the houses, the gardens, the bays
  async build() {
    const names = ['chalet_lo', 'garden_shed', 'garden_bench', 'playground', 'pine_tree', 'pine_tree2', 'garden/snowman', 'garden/sledge'];
    const [lo, shed, bench, play, pine1, pine2, snowman, sledge] = await Promise.all(names.map((n) => loadGLB(n).catch(() => null)));
    const g = new THREE.Group(); g.name = 'chalet-village';
    this.scene.add(g); this.group = g;
    // the houses: the low-poly Meshy chalet, instanced (the full one replaces it on the chalet you're nearest)
    if (lo) {
      this.loModel = this.modelGroup(lo);
      this.inst = this.instance(this.loModel, this.houses.map((h) => h.frame.matrixWorld), g, true);
    }
    // the houses' colliders: the body, the front steps (a top you step onto); an invisible camera blocker
    const lbox = (h, x0, x1, z0, z1, extra = {}) => {
      const c = h.frame.localToWorld(new THREE.Vector3((x0 + x1) / 2, 0, (z0 + z1) / 2));
      this.colliders.push({ x: c.x, z: c.z, hw: (x1 - x0) / 2, hd: (z1 - z0) / 2, rot: -h.yaw, ...extra });
    };
    const blkGeo = new THREE.BoxGeometry(2 * HX, 7.5, 2 * HZ), blkMat = new THREE.MeshBasicMaterial();
    for (const h of this.houses) {
      lbox(h, -HX - 0.05, HX + 0.05, -HZ - 0.05, HZ + 0.05);
      lbox(h, STEPS.x0, STEPS.x1, STEPS.z0, STEPS.z1, { top: h.frame.position.y + G });
      const c = h.frame.position;
      const blk = new THREE.Mesh(blkGeo, blkMat);
      blk.visible = false; blk.position.set(c.x, c.y + 3.75, c.z); blk.rotation.y = h.yaw; g.add(blk); blk.updateMatrixWorld(true);
      blk.userData.cameraBlocker = true;
      this.cameraBlockers?.push(blk);
    }
    for (const i of this.items) {
      if (!i.col) continue;
      if (i.kind === 'fence') continue; // (below: one thin box per stretch)
      if (i.r != null && (i.kind === 'spruce' || i.kind === 'snowman' || i.kind === 'sign' || i.kind === 'mailbox')) this.colliders.push({ x: i.x, z: i.z, r: i.r });
      else if (i.kind === 'bench') this.colliders.push({ x: i.x, z: i.z, hw: i.hw, hd: 0.3, rot: -i.yaw, top: i.y + 0.47 });
      else this.colliders.push({ x: i.x, z: i.z, hw: i.hw, hd: i.hd, rot: -(i.yaw || 0) });
    }
    const by = (k) => this.items.filter((i) => i.kind === k);
    for (const f of by('fence')) this.colliders.push({ x: f.x, z: f.z, hw: f.hw, hd: 0.06, rot: -f.yaw });
    // the props, instanced per kind, no shadows (small)
    const M = (o, s = 1) => _m.compose(_p.set(o.x, o.y, o.z), _q.setFromAxisAngle(UP, o.yaw || 0), _s.set(s, s, s)).clone();
    if (shed) this.instance(this.fit(shed, { size: 2.2, axis: 'y' }), by('shed').map((o) => M(o)), g);
    if (bench) this.instance(this.fit(bench, { size: 1.6, axis: 'x' }), by('bench').map((o) => M(o)), g);
    if (play) this.instance(this.fit(play, { size: 3.6, axis: 'y' }), by('playground').map((o) => M(o)), g);
    if (snowman) this.instance(this.fit(snowman, { size: 1.5, axis: 'y' }), by('snowman').map((o) => M(o)), g);
    if (sledge) this.instance(this.fit(sledge, { size: 1.0, axis: 'xz' }), by('sledge').map((o) => M(o)), g);
    // the garden's spruces and dwarf spruces: the game's own pine models, decimated (a garden tree needs no 20k triangles)
    const pines = [pine1, pine2].map((p) => (p ? this.pine(p) : null));
    for (const v of [0, 1]) {
      const base = pines[v] || pines[1 - v];
      if (!base) continue;
      const list = this.items.filter((i) => (i.kind === 'spruce' || i.kind === 'shrub') && (pines[v] ? i.v === v : i.v !== v));
      this.instance(base, list.map((t) => M(t, t.h)), g);
    }
    // the street lamps: Legacy Village's Meshy lamp post, its lantern glowing warm at night (one instanced mesh)
    const lampGl = await loadGLB('lamp_post').catch(() => null);
    if (lampGl && this.lamps.length) {
      const lamp = this.fit(lampGl, { size: LAMP_H, axis: 'y' });
      addNightGlow(lamp, 6);
      this.instance(lamp, this.lamps.map((l) => M(l)), g, true);
    }
    this.buildWindows(g);
    this.buildFences(g, by('fence'));
    this.buildSolids(g);
    this.buildBays(g, by('bay'), by('drive'));
    this.buildPlates(g);
    g.updateMatrixWorld(true);
    this.stats('built');
  }
  // the chalet model in the house frame (its body centred, its ground at y 0)
  modelGroup(gltf) {
    const m = gltf.scene.clone(true);
    m.scale.setScalar(S); m.position.set(-MODEL.x * S, -MODEL.y * S, -MODEL.z * S);
    const g = new THREE.Group(); g.add(m); g.updateMatrixWorld(true);
    g.userData.glb = gltf.modelName || 'chalet';
    return g;
  }
  fit(gltf, opts) {
    const g = fitModel(gltf, opts);
    g.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(g); g.position.y -= b.min.y;
    const w = new THREE.Group(); w.add(g); w.updateMatrixWorld(true);
    return w;
  }
  // a pine 1 m tall (instances scale it to their height), the forest's look: no baked glow; decimated
  pine(gltf) {
    const w = this.fit(gltf, { size: 1, axis: 'y' });
    w.traverse((o) => {
      if (!o.isMesh) return;
      const m = o.material.clone(); if (m.emissive) m.emissive.setRGB(0, 0, 0); m.emissiveMap = null; m.metalness = 0; o.material = m;
      o.geometry.computeBoundingBox();
      const bb = o.geometry.boundingBox, h = Math.max(bb.max.y - bb.min.y, bb.max.x - bb.min.x);
      try { o.geometry = clusterDecimate(o.geometry, h * 0.09); } catch (e) { /* (keep the full one) */ }
    });
    return w;
  }
  instance(base, mats, parent, shadows = false) {
    const out = [];
    if (!mats.length) return out;
    base.traverse((o) => {
      if (!o.isMesh) return;
      const im = new THREE.InstancedMesh(o.geometry, o.material, mats.length);
      const local = o.matrixWorld.clone();
      mats.forEach((Mx, i) => im.setMatrixAt(i, _m.multiplyMatrices(Mx, local)));
      im.userData.local = local; im.userData.mats = mats.map((Mx) => Mx.clone());
      im.castShadow = shadows; im.receiveShadow = true;
      im.computeBoundingSphere();
      parent.add(im); out.push(im);
    });
    return out;
  }

  // the picket fences: every stretch of every plot in two meshes (the pickets and rails: a strip textured with them,
  // alpha-tested, seen from both sides; the posts: in buildSolids)
  buildFences(g, list) {
    if (!list.length) return;
    const pos = [], uv = [], idx = [];
    this.posts = [];
    for (const f of list) {
      const n = Math.max(1, Math.round(f.len / POST_STEP)), b = pos.length / 3;
      for (let k = 0; k <= n; k++) {
        const t = k / n, x = f.ax + (f.bx - f.ax) * t, z = f.az + (f.bz - f.az) * t, y = world.height(x, z) - 0.03, u = (f.len * t) / PICKET;
        pos.push(x, y, z, x, y + FENCE_H, z); uv.push(u, 0, u, 1);
        this.posts.push([x, y, z, f.yaw]);
        if (k < n) { const a = b + k * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx); geo.computeVertexNormals(); // (a vertical strip: its normals sideways)
    const t = this.picketTexture();
    const mat = new THREE.MeshStandardMaterial({ map: t, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.85 });
    const m = new THREE.Mesh(geo, mat); m.name = 'chalet-fences'; m.receiveShadow = true; m.castShadow = false;
    g.add(m);
  }
  picketTexture() {
    const c = document.createElement('canvas'); c.width = 64; c.height = 128;
    const x = c.getContext('2d');
    x.clearRect(0, 0, 64, 128);
    // (canvas y down: the top of the fence at the top) a pointed picket in the middle of each 16 cm, two rails
    const wood = '#d9c4a0', dark = '#a88b62';
    x.fillStyle = wood;
    x.beginPath(); x.moveTo(14, 128); x.lineTo(14, 18); x.lineTo(32, 2); x.lineTo(50, 18); x.lineTo(50, 128); x.closePath(); x.fill();
    x.fillStyle = dark; x.fillRect(14, 18, 3, 110); x.fillRect(47, 18, 3, 110);
    x.fillStyle = '#c9b38c'; x.fillRect(0, 34, 64, 12); x.fillRect(0, 92, 64, 12);
    x.fillStyle = 'rgba(80,60,40,0.35)'; x.fillRect(0, 45, 64, 2); x.fillRect(0, 103, 64, 2);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = THREE.RepeatWrapping; t.anisotropy = 8;
    return t;
  }
  // everything small and solid in ONE vertex-coloured mesh: the fence posts, the stepping stones, the mailboxes and
  // their posts, the signs' posts and plates (their faces: the atlas mesh)
  buildSolids(g) {
    const parts = [];
    const add = (geo, x, y, z, yaw, color, sx = 1, sy = 1, sz = 1) => {
      geo = geo.index ? geo.toNonIndexed() : geo;
      geo.deleteAttribute('uv');
      geo.applyMatrix4(_m.compose(_p.set(x, y, z), _q.setFromAxisAngle(UP, yaw), _s.set(sx, sy, sz)));
      const col = new THREE.Color(color), n = geo.attributes.position.count, a = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { a[i * 3] = col.r; a[i * 3 + 1] = col.g; a[i * 3 + 2] = col.b; }
      geo.setAttribute('color', new THREE.BufferAttribute(a, 3));
      parts.push(geo);
    };
    const post = new THREE.BoxGeometry(0.08, FENCE_H + 0.1, 0.08);
    const seen = new Set();
    for (const [x, y, z, yaw] of this.posts || []) {
      const k = `${Math.round(x * 20)},${Math.round(z * 20)}`;
      if (seen.has(k)) continue; seen.add(k); // (the corners: one post where two stretches meet)
      add(post.clone(), x, y + (FENCE_H + 0.1) / 2, z, yaw, 0xb89c74);
    }
    const stone = new THREE.CylinderGeometry(0.27, 0.29, 0.08, 9);
    this.items.filter((i) => i.kind === 'stone').forEach((s, i) => add(stone.clone(), s.x, s.y - 0.01, s.z, s.spin, 0x8f9296, 1, 1, 0.8 + 0.2 * hash(i)));
    const mpost = new THREE.BoxGeometry(0.09, 1.0, 0.09), mbox = new THREE.BoxGeometry(0.34, 0.26, 0.3), mroof = new THREE.BoxGeometry(0.38, 0.03, 0.34);
    for (const b of this.items.filter((i) => i.kind === 'mailbox')) {
      add(mpost.clone(), b.x, b.y + 0.5, b.z, b.yaw, 0x6b4a2b);
      add(mbox.clone(), b.x, b.y + 1.13, b.z, b.yaw, 0x2d5e3a);
      add(mroof.clone(), b.x, b.y + 1.275, b.z, b.yaw, 0x22472c);
    }
    const spost = new THREE.CylinderGeometry(0.03, 0.03, 1.95, 8), splate = new THREE.BoxGeometry(0.46, 0.62, 0.02);
    for (const s of this.items.filter((i) => i.kind === 'sign')) {
      add(spost.clone(), s.x, s.y + 0.975, s.z, s.yaw, 0x9aa0a6);
      const o = _l.set(0, 0, 0.035).applyAxisAngle(UP, s.yaw);
      add(splate.clone(), s.x + o.x, s.y + 1.58, s.z + o.z, s.yaw, 0xd8d8d4);
    }
    if (!parts.length) return;
    const geo = mergeGeometries(parts);
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }));
    m.name = 'chalet-solids'; m.receiveShadow = true; m.castShadow = false;
    g.add(m);
  }
  // each plot's parking (two 2.5 x 5 m bays, lines and PRIVAT painted in each) and its drive to the road: draped on
  // the ground, 4 cm over it; the bay and the drive meet edge to edge (never on top of each other)
  buildBays(g, bays, drives) {
    const drape = (list, textured) => {
      const pos = [], uv = [], idx = [];
      for (const r of list) {
        const x0 = r.x0, x1 = r.x1, za = r.za, zb = r.zb, nx = Math.max(1, Math.ceil((x1 - x0) / 0.5)), nz = Math.max(1, Math.ceil(Math.abs(zb - za) / 0.5)), b = pos.length / 3;
        for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) {
          const x = x0 + ((x1 - x0) * i) / nx, z = za + ((zb - za) * j) / nz;
          // (on the graded drive / bay: its own surface, the one you walk and drive on; 4 cm over the ground)
          pos.push(x, (r.plot ? driveHeight(r.plot, x, z) : null) ?? world.height(x, z) + 0.04, z);
          // uv: v from the bay's road end (0) to its back (1); u left to right as you drive in (facing +z your
          // right is -x, facing -z it's +x), so the painting reads upright and unmirrored from the driver's seat
          uv.push(r.out > 0 ? 1 - i / nx : i / nx, j / nz);
        }
        const flip = (zb - za) < 0;
        for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) { const a = b + j * (nx + 1) + i; if (flip) idx.push(a, a + 1, a + nx + 1, a + 1, a + nx + 2, a + nx + 1); else idx.push(a, a + nx + 1, a + 1, a + 1, a + nx + 1, a + nx + 2); }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      geo.setIndex(idx); geo.computeVertexNormals();
      const mat = drivewaySnow(new THREE.MeshStandardMaterial(textured ? { map: this.bayTexture(), roughness: 0.9 } : { color: 0x8d8a84, roughness: 0.95 }), textured ? 'bay' : 'drive');
      const m = new THREE.Mesh(geo, mat); m.receiveShadow = true; m.name = textured ? 'chalet-bays' : 'chalet-drives'; g.add(m);
    };
    if (bays.length) drape(bays, true);
    if (drives.length) this.buildLanes(g, drives);
  }
  // the drives (one mesh for the village): each plot's lane from the road to its bays, and a soft snow berm (BERM m
  // wide, rounded at every corner) round the lane and the bays, so they blend into the snowy garden instead of
  // ending in a hard-cut edge. One grid per plot over lane + bays + berm, its lines on the bays' own edges and
  // subdivisions (the bays: their own textured mesh above, watertight with this one); quads on the bays left out.
  // uv: x = metres across from the lane's centre line, y = how far into the berm (0 on the lane, 1 at its foot).
  buildLanes(g, drives) {
    const BERM = 0.6, pos = [], uv = [], idx = [];
    const range = (a, b, n) => Array.from({ length: n + 1 }, (_, k) => a + ((b - a) * k) / n);
    const uniq = (list) => list.sort((a, b) => a - b).filter((v, i, l) => i === 0 || v - l[i - 1] > 0.04);
    for (const r of drives) {
      const p = r.plot, d = p?.drv;
      if (!d) continue;
      const sd = d.sd, bw = d.bw2 * 2, bdep = d.vb1 - d.vb0;
      const nxB = Math.max(1, Math.ceil(bw / 0.5)), nzB = Math.max(1, Math.ceil(bdep / 0.5)); // (as the bays' drape)
      const xs = uniq([...range(d.bx0, d.bx1, nxB), d.cx - d.dw2, d.cx + d.dw2, d.bx0 - BERM * 0.5, d.bx0 - BERM, d.bx1 + BERM * 0.5, d.bx1 + BERM]);
      const vs = uniq([...range(d.v0, d.vb0, Math.max(1, Math.ceil((d.vb0 - d.v0) / 0.5))), ...range(d.vb0, d.vb1, nzB), d.vb1 + BERM * 0.5, d.vb1 + BERM]);
      const nx = xs.length, b = pos.length / 3, T = [];
      for (const v of vs) for (const x of xs) {
        const z = d.legZ + sd * v, t = driveDistance(d, x, v) / BERM;
        let y;
        if (t <= 1e-6) y = driveHeight(p, x, z) ?? world.height(x, z) + 0.04;
        else {
          const base = Math.max(world.height(x, z), world.meshHeight(x, z) - 0.03) + 0.04;
          y = t >= 1 ? base - 0.08 : base + 0.13 * Math.sin(Math.PI * t) - 0.04 * t; // (up and over, its foot in the snow)
        }
        pos.push(x, y, z); uv.push(x - d.cx, Math.min(1, t)); T.push(t);
      }
      const onBay = (k) => { const x = xs[k % nx], v = vs[Math.floor(k / nx)]; return T[k] <= 1e-6 && v >= d.vb0 - 1e-6 && Math.abs(x - d.cx) <= d.bw2 + 1e-6; };
      for (let j = 0; j < vs.length - 1; j++) for (let i = 0; i < nx - 1; i++) {
        const q = [j * nx + i, j * nx + i + 1, (j + 1) * nx + i, (j + 1) * nx + i + 1];
        if (q.every((k) => T[k] >= 1)) continue; // (out past the berm)
        if (q.every(onBay)) continue;            // (the bays' own mesh)
        const [a0, a1, a2, a3] = q.map((k) => b + k);
        // (facing up: v runs along +z for sd > 0, along -z for sd < 0)
        if (sd > 0) idx.push(a0, a2, a1, a1, a2, a3); else idx.push(a0, a1, a2, a1, a3, a2);
      }
    }
    if (!idx.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx); geo.computeVertexNormals();
    const mat = drivewaySnow(new THREE.MeshStandardMaterial({ color: 0x8d8a84, roughness: 0.95 }), 'drive');
    const m = new THREE.Mesh(geo, mat); m.receiveShadow = true; m.name = 'chalet-drives'; g.add(m);
  }
  /** The bay's painting (canvas: x = u, left to right as you drive in; y down = from the back (v 1) to the road (v 0)). */
  static bayLayout() {
    const W = 512, lines = [0.04, 0.5, 0.96]; // (the lines: 2.5 m bays inside the 5.4 m space)
    const bays = [[lines[0], lines[1]], [lines[1], lines[2]]].map(([a, b]) => ({ x0: a * W + 6, x1: b * W - 6 }));
    // PRIVAT near the entrance of each bay, upright for the driver (its foot toward the road: the canvas's bottom)
    const text = bays.map((b) => ({ cx: (b.x0 + b.x1) / 2, maxW: (b.x1 - b.x0) * 0.78, base: W * 0.86 }));
    return { W, lines, bays, text };
  }
  bayTexture() {
    const L = Chalets.bayLayout(), W = L.W;
    const c = document.createElement('canvas'); c.width = W; c.height = W;
    const x = c.getContext('2d');
    x.fillStyle = '#7f7d79'; x.fillRect(0, 0, W, W);
    for (let i = 0; i < 6000; i++) { const v = 100 + Math.random() * 50; x.fillStyle = `rgba(${v},${v},${v - 4},0.35)`; x.fillRect(Math.random() * W, Math.random() * W, 2, 2); }
    x.fillStyle = 'rgba(240,240,236,0.92)';
    for (const u of L.lines) x.fillRect(u * W - 6, W * 0.04, 12, W * 0.96); // (the lines, from the back to the entrance)
    x.fillRect(L.lines[0] * W, W * 0.04, (L.lines[2] - L.lines[0]) * W, 12); // (the back line)
    x.textAlign = 'center'; x.textBaseline = 'alphabetic';
    for (const t of L.text) {
      let size = 64;
      x.font = `bold ${size}px Arial`;
      const w = x.measureText('PRIVAT').width;
      if (w > t.maxW) { size = Math.floor((size * t.maxW) / w); x.font = `bold ${size}px Arial`; }
      x.fillText('PRIVAT', t.cx, t.base);
    }
    const tx = new THREE.CanvasTexture(c); tx.colorSpace = THREE.SRGBColorSpace; tx.anisotropy = 8;
    return tx;
  }
  // the atlas: the house numbers (blue enamel, white digits and border) and the "P PRIVAT" sign
  atlasTexture() {
    const c = document.createElement('canvas'); c.width = ATLAS.w; c.height = ATLAS.h;
    const x = c.getContext('2d');
    x.textAlign = 'center'; x.textBaseline = 'middle';
    for (let n = 1; n <= 32; n++) {
      const i = n - 1, cx = (i % ATLAS.cols) * ATLAS.cw, cy = Math.floor(i / ATLAS.cols) * ATLAS.ch, w = ATLAS.cw, h = ATLAS.ch;
      x.fillStyle = '#1f4fa3'; x.fillRect(cx, cy, w, h);
      x.strokeStyle = '#ffffff'; x.lineWidth = 6; x.strokeRect(cx + 9, cy + 9, w - 18, h - 18);
      x.fillStyle = '#ffffff'; x.font = `bold ${n > 9 ? 58 : 66}px Arial`; x.fillText(String(n), cx + w / 2, cy + h / 2 + 3);
    }
    const s = ATLAS.sign;
    x.fillStyle = '#f6f6f2'; x.fillRect(s.x, s.y, s.w, s.h);
    x.strokeStyle = '#1d3f8f'; x.lineWidth = 12; x.strokeRect(s.x + 8, s.y + 8, s.w - 16, s.h - 16);
    x.fillStyle = '#1d4fb8'; x.fillRect(s.x + 52, s.y + 40, s.w - 104, s.w - 104);
    x.fillStyle = '#ffffff'; x.font = 'bold 230px Arial'; x.fillText('P', s.x + s.w / 2, s.y + 40 + (s.w - 104) / 2 + 10);
    x.fillStyle = '#b3171d'; x.font = 'bold 84px Arial';
    const pw = x.measureText('PRIVAT').width; if (pw > s.w - 40) x.font = `bold ${Math.floor((84 * (s.w - 40)) / pw)}px Arial`;
    x.fillText('PRIVAT', s.x + s.w / 2, s.y + s.h - 70);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
    return t;
  }
  // every plaque (by the front door), mailbox number plate and sign face: quads on one atlas, one mesh
  buildPlates(g) {
    const pos = [], uv = [], nor = [];
    const quad = (cx, cy, cz, yaw, w, h, r) => { // (facing local +z turned by yaw)
      const ux = Math.cos(yaw), uz = -Math.sin(yaw), nx = Math.sin(yaw), nz = Math.cos(yaw);
      const P = (a, b) => [cx + ux * a, cy + b, cz + uz * a];
      const [u0, v0, u1, v1] = r;
      const A = P(-w / 2, -h / 2), B = P(w / 2, -h / 2), C = P(w / 2, h / 2), D = P(-w / 2, h / 2);
      pos.push(...A, ...B, ...C, ...A, ...C, ...D);
      uv.push(u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1);
      for (let k = 0; k < 6; k++) nor.push(nx, 0, nz);
    };
    for (const p of this.items) {
      if (p.kind === 'plaque' && p.num) {
        // (yaw: the house frame's; its +x (the front) is local +z turned by yaw + PI/2)
        quad(p.x, p.y, p.z, p.yaw + Math.PI / 2, PLAQUE.w, PLAQUE.h, atlasCell(p.num));
      } else if (p.kind === 'mailbox' && p.num) {
        const o = _l.set(0, 0, 0.152).applyAxisAngle(UP, p.yaw);
        quad(p.x + o.x, p.y + 1.12, p.z + o.z, p.yaw, 0.2, 0.15, atlasCell(p.num));
      } else if (p.kind === 'sign') {
        const o = _l.set(0, 0, 0.047).applyAxisAngle(UP, p.yaw);
        quad(p.x + o.x, p.y + 1.58, p.z + o.z, p.yaw, 0.44, 0.6, SIGN_UV);
      }
    }
    if (!pos.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: this.atlasTexture(), roughness: 0.35, metalness: 0.05, polygonOffset: true, polygonOffsetFactor: -2 }));
    m.name = 'chalet-plates'; m.receiveShadow = true; m.castShadow = false;
    g.add(m);
  }

  /** The village's draw calls and triangles (console; the Node checks print it too). */
  // the windows lit warm at night: a soft glowing pane over every window of every chalet (some rooms dark), one
  // instanced additive mesh, drawn only after dusk
  buildWindows(g) {
    const N = 32, data = new Uint8Array(N * N * 4);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const u = (i + 0.5) / N, v = (j + 0.5) / N, e = Math.min(u, 1 - u, v, 1 - v);
      const bars = Math.abs(u - 0.5) < 0.03 || Math.abs(v - 0.55) < 0.03 ? 0.45 : 1; // (the glazing bars)
      const a = Math.min(1, e / 0.12) * (0.75 + 0.25 * v) * bars * 255;
      data.set([a, a, a, 255], (j * N + i) * 4);
    }
    const tex = new THREE.DataTexture(data, N, N); tex.needsUpdate = true; tex.colorSpace = THREE.SRGBColorSpace;
    const panes = [];
    for (const h of this.houses) MODEL_WINDOWS.forEach(([n, x, y, z, w, hh], k) => {
      const lit = hash(h.id * 31 + k * 7 + 3);
      if (lit > 0.7) return; // (nobody in that room)
      const ry = n === 'x' ? Math.PI / 2 : n === '-x' ? -Math.PI / 2 : n === 'z' ? 0 : Math.PI, o = 0.03;
      const local = _m.compose(_p.set(x + (n === 'x' ? o : n === '-x' ? -o : 0), y, z + (n === 'z' ? o : n === '-z' ? -o : 0)), _q.setFromAxisAngle(UP, ry), _s.set(w, hh, 1));
      panes.push({ m: new THREE.Matrix4().multiplyMatrices(h.frame.matrixWorld, local), k: 0.55 + 0.45 * hash(h.id * 13 + k) });
    });
    if (!panes.length) return;
    const mat = new THREE.MeshBasicMaterial({ map: tex, color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    const im = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, panes.length);
    const c = new THREE.Color();
    panes.forEach((p, i) => { im.setMatrixAt(i, p.m); im.setColorAt(i, c.setRGB(1.6 * p.k, 0.95 * p.k, 0.42 * p.k)); });
    im.computeBoundingSphere();
    im.name = 'chalet-windows'; im.visible = false; im.renderOrder = 3;
    g.add(im);
    this.windows = im;
  }

  // the marker over your own chalet: a gold house badge with its name, bobbing over the roof, readable from far
  // and near (through trees and houses), gone only at its door, inside, or when you own none. One sprite, no light.
  markerTexture(name) {
    const W = 512, H = 320, cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const x = cv.getContext('2d'), cx = W / 2;
    x.shadowColor = 'rgba(0,0,0,0.55)'; x.shadowBlur = 14;
    // the badge: a gold disc, a white house on it
    const gr = x.createLinearGradient(0, 18, 0, 200);
    gr.addColorStop(0, '#ffe58a'); gr.addColorStop(1, '#d99a1c');
    x.fillStyle = gr; x.beginPath(); x.arc(cx, 112, 92, 0, Math.PI * 2); x.fill();
    x.shadowBlur = 0; x.lineWidth = 7; x.strokeStyle = '#fff6d0'; x.stroke();
    x.fillStyle = '#ffffff'; x.beginPath();
    x.moveTo(cx, 52); x.lineTo(cx + 58, 104); x.lineTo(cx + 42, 104); x.lineTo(cx + 42, 160); x.lineTo(cx + 12, 160); x.lineTo(cx + 12, 126);
    x.lineTo(cx - 12, 126); x.lineTo(cx - 12, 160); x.lineTo(cx - 42, 160); x.lineTo(cx - 42, 104); x.lineTo(cx - 58, 104); x.closePath(); x.fill();
    // the name under it
    x.font = 'bold 58px Arial, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.shadowColor = 'rgba(0,0,0,0.7)'; x.shadowBlur = 10; x.lineWidth = 9; x.strokeStyle = 'rgba(40,24,0,0.85)';
    x.strokeText(name, cx, 266); x.fillStyle = '#ffd95a'; x.fillText(name, cx, 266);
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    return t;
  }
  updateMarker(dt) {
    const h = this.inside ? null : this.rented();
    if (!h || typeof document === 'undefined') { if (this.marker) this.marker.visible = false; return; }
    if (!this.marker) {
      // (depthTest off: seen through the trees and the other houses; drawn last, unfogged, not tone-mapped)
      const mat = new THREE.SpriteMaterial({ transparent: true, depthTest: false, depthWrite: false, fog: false, toneMapped: false });
      this.marker = new THREE.Sprite(mat);
      this.marker.name = 'chalet-marker'; this.marker.renderOrder = 999; this.marker.center.set(0.5, 0);
      this.marker.frustumCulled = false;
      this.scene.add(this.marker);
    }
    const S0 = this.marker, mat = S0.material;
    if (S0.userData.name !== h.name) { mat.map?.dispose(); mat.map = this.markerTexture(h.name); mat.needsUpdate = true; S0.userData.name = h.name; }
    this.markT = (this.markT || 0) + dt;
    const f = h.frame.position, p = this.player?.pos, cam = this.camera?.position || p;
    // hidden only at the door (within ~4 m: the prompt takes over), faded in over the next 2 m
    const dd = p ? Math.hypot(p.x - h.door.x, p.z - h.door.z) : 1e9;
    // (Oct 29, the user: "only show where your chalet is when you're close by, in the chalet village or on the road
    // beside it"): faded out between 300 and 350 m from it
    const a = Math.min(1, Math.max(0, (dd - 4) / 2)) * Math.min(1, Math.max(0, (NEAR_HOME + 50 - dd) / 50));
    S0.visible = a > 0.01;
    if (!S0.visible) return;
    mat.opacity = a;
    // a minimum on-screen size: ~5.5% of the distance tall (the same size on screen from far and near), never under
    // 2.2 m; a little lower over the roof when you're close (still in view from the street)
    const dc = cam ? Math.hypot(cam.x - f.x, cam.y - f.y - MARK_Y, cam.z - f.z) : 100;
    const k = Math.min(60, Math.max(2.2, dc * 0.055));
    const y = MARK_Y - 2 * Math.max(0, 1 - dc / 60);
    S0.scale.set(k * 1.6, k, 1);
    S0.position.set(f.x, f.y + y + Math.sin(this.markT * 1.7) * 0.12 * k, f.z);
  }
  /** Where your own chalet's front door is (main.js: the "Go home" waypoint), or null. */
  homeWaypoint() {
    const h = this.rented();
    return h ? { x: h.door.x, z: h.door.z, label: `Your chalet · ${h.name}` } : null;
  }

  stats(label = '') {
    let calls = 0, tris = 0;
    this.group?.traverseVisible((o) => {
      if (!o.isMesh) return;
      const n = o.isInstancedMesh ? o.count : 1, gm = o.geometry;
      calls++; tris += ((gm.index ? gm.index.count : gm.attributes.position.count) / 3) * n;
    });
    const s = { calls, tris: Math.round(tris) };
    if (label) console.info(`chalet village (${label}): ${s.calls} draw calls, ${s.tris.toLocaleString('en-US')} triangles`);
    return s;
  }

  setInstance(i, hidden) {
    if (!this.inst || i < 0) return;
    for (const im of this.inst) { im.setMatrixAt(i, hidden ? ZERO : _m.multiplyMatrices(im.userData.mats[i], im.userData.local)); im.instanceMatrix.needsUpdate = true; }
  }

  // ------------------------------------------------------------------ buying (one chalet each, yours for good)
  rented() { const id = this.save?.chalet?.id; return id == null ? null : this.houses.find((h) => h.id === id) || null; }
  insideOwn() { return this.inside && !!this.current && this.current.id === this.save.chalet?.id; }
  hour() { return this.getHour?.() ?? 12; }
  canEnter(h) { return !!h && (this.rented() === h || this.viewing === h); }
  interaction(p) {
    if (!this.V || this.inside || this.busy) return null;
    for (const h of this.houses) {
      if (Math.abs(p.x - h.door.x) > 3 || Math.abs(p.z - h.door.z) > 3 || Math.hypot(p.x - h.door.x, p.z - h.door.z) > 2.3) continue;
      const mine = this.rented();
      // multiplayer (net/session.js sets this.mp = { ownerOf(id) -> name | null, visit(h, owner) }): somebody
      // else's chalet is not for sale; E asks the owner to let you in
      const owner = this.mp?.ownerOf(h.id);
      if (owner && mine !== h && !this.canEnter(h)) return { label: `${h.name} · ${owner}'s chalet · ask to visit`, act: () => this.mp.visit(h, owner) };
      if (this.canEnter(h)) return { label: `Go in · ${h.name}${mine === h ? ' (your chalet)' : ''}`, act: () => this.enter(h) };
      if (mine) return { label: `${h.name} · you already own ${mine.name}`, act: () => this.hud?.flash(`You already own ${mine.name}: one chalet each`, 'bad', 2400) };
      return (h._buy ||= { label: `${h.name} for sale · $${CHALET_PRICE.toLocaleString('en-US')}`, act: () => this.offer(h) });
    }
    return null;
  }
  offer(h) {
    const say = `A two-storey chalet on the Chaletweg: entrance hall, open living room and kitchen, two bathrooms and three bedrooms under the roof, a garden and its own parking. It comes empty: furnish it as you like. Yours for good.`;
    this.hud.dialog(h.name, say, [
      { label: 'Buy this chalet', sub: 'Yours for good', price: `$${CHALET_PRICE.toLocaleString('en-US')}`, act: () => this.buy(h) },
      { label: 'Have a look inside', sub: 'It is open for viewing', act: () => { this.viewing = h; this.enter(h); } },
      { label: 'Not now' },
    ], { kicker: `Chalet village · $${CHALET_PRICE.toLocaleString('en-US')}` });
  }
  buy(h) {
    if (this.rented()) return;
    if (this.mp) return this.mp.buy(h); // multiplayer: the server sells it (one owner per chalet, every world)
    if (!this.spend(CHALET_PRICE)) return;
    const old = this.save.chalet;
    this.save.chalet = { id: h.id, name: h.name, owned: true, rented: true, since: this.save.day ?? 1, furniture: old?.furniture || [], plan: 2, layout: SAVE_LAYOUT };
    this.writeSave();
    this.hud.flash(`${h.name} is yours · E at its front door to go in`, 'good', 3400);
  }

  // ------------------------------------------------------------------ in and out (a short fade each way)
  ensureRoom() { // (this.room: the interior, built the first time you go in; its own scene, never in the world)
    if (!this.room) { this.room = new ChaletRoom({ renderer: this.renderer }); setChaletInterior(this.room, this); }
    return this.room;
  }
  // the room built and its shaders compiled ahead, in idle time, while you walk up to a chalet you may go into (so
  // the fade in never waits on a synchronous build or a first-frame shader compile: that froze the game, and on an
  // 8 GB Mac the GPU process then lost the WebGL context: the black screen)
  prewarm() {
    if (this.room?.warmed || this.prewarming) return;
    this.prewarming = true;
    const go = () => { try { this.ensureRoom().warm(() => this.getPost?.()?.target); } catch (e) { console.warn('chalet prewarm', e); } };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(go, { timeout: 1500 }); else setTimeout(go, 0);
  }
  watchContext() {
    const cv = this.renderer?.domElement;
    if (!cv?.addEventListener || this.ctxWatched) return;
    this.ctxWatched = true;
    cv.addEventListener('webglcontextlost', (e) => { e.preventDefault(); console.warn('WebGL context lost', this.inside ? '(inside a chalet)' : ''); this.room?.releasePortal(); });
    cv.addEventListener('webglcontextrestored', () => { console.warn('WebGL context restored'); if (this.inside) this.leave(true); });
  }
  enter(h) {
    if (this.inside || this.busy || this.transition?.active) return;
    this.busy = true;
    this.player.frozen = true;
    this.audio?.play?.('click');
    this.transition.fade(async () => {
      let r;
      try { r = this.ensureRoom(); await r.warm(() => this.getPost?.()?.target); } catch (e) { // (nothing to show: stay outside)
        console.warn('chalet interior', e); this.busy = false; this.player.frozen = false; return;
      }
      this.current = h; this.inside = true; this.busy = false;
      this.showHi(this.houses.indexOf(h)); // (so the windows' view hides this very house)
      r.setWorld({ scene: this.scene, frame: h.frame, hide: () => [this.player.rig?.root, this.player.rig?.gear, this.hi, this.hiShadow] });
      r.enter();
      this.getPost().setView(r.scene, r.camera);
      const ch = document.getElementById('crosshair'); if (ch) ch.hidden = false;
    });
  }
  leave(now = false) {
    if (!this.inside || (this.busy && !now)) return;
    const h = this.current;
    const out = () => {
      this.busy = false;
      if (!this.inside) return;
      this.inside = false; this.room?.leave();
      this.current = null;
      if (this.viewing === h && this.rented() !== h) this.viewing = null;
      this.getPost().setView(this.scene, this.camera);
      const ch = document.getElementById('crosshair'); if (ch) ch.hidden = true;
      this.player.frozen = false;
      if (now || !h) return;
      // out in front of the steps, facing away from the door
      const w = h.frame.localToWorld(_l.set(STEPS.x1 + 0.7, 0, DOOR.z)), f = h.out, heading = Math.atan2(f.x, f.z);
      this.player.teleport(w.x, w.z, heading, h.frame.position.y);
      this.player.camYaw = heading + Math.PI;
      this.player.camPitch = -0.12;
    };
    if (now) { out(); return; }
    this.busy = true;
    this.audio?.play?.('click');
    this.transition.fade(out);
  }
  /** Inside, per frame (main.js): walking, the doors; E at the front door: out. Returns the prompt target. */
  frame(dt, input, sensitivity) {
    const r = this.room;
    if (!r) return null;
    this.target = this.busy ? null : r.update(dt, input, sensitivity);
    if (this.target && input?.hit?.('KeyE')) {
      if (this.target.kind === 'exit') this.leave();
      else { this.audio?.play?.('click'); r.use(this.target); }
    }
    r.tick(dt, _l.set(r.pos.x, r.eyeY, r.pos.z), this.hour());
    return this.target;
  }
  roomName() { return this.inside ? `${this.current?.name || 'Chalet'} · ${this.room?.roomName() || ''}` : ''; }

  /** Per frame (main.js): the full-detail model on the chalet you're nearest; nothing while you're away. */
  update(dt = 0.016) {
    if (!this.V) return;
    this.watchContext();
    this.updateMarker(dt);
    if (this.windows) { // (the windows: lit from dusk)
      const n = nightUniform.value;
      this.windows.visible = n > 0.05;
      this.windows.material.opacity = Math.min(1, n * 1.3);
    }
    if (!this.inst) return;
    if (this.inside) return; // (the house stays as it was when you went in)
    const p = this.player?.pos;
    if (!p) return;
    const b = this.V.bounds;
    if (p.x < b.minx - HI_R || p.x > b.maxx + HI_R || p.z < b.minz - HI_R || p.z > b.maxz + HI_R) { if (this.hiAt >= 0) this.showHi(-1); return; }
    let best = -1, bd = HI_R;
    for (let i = 0; i < this.houses.length; i++) { const f = this.houses[i].frame.position, d = Math.hypot(p.x - f.x, p.z - f.z); if (d < bd) { bd = d; best = i; } }
    if (best >= 0 && bd < 35) this.prewarm(); // (near a door you might go in at: the interior readied in the background)
    if (best === this.hiAt) return;
    if (best >= 0 && !this.hiModel) { // (the full model: loaded the first time you come near; the low one shows meanwhile)
      this.hiLoading ||= loadGLB('chalet').then((gl) => { if (gl) this.makeHi(gl); }).catch(() => null);
      return;
    }
    this.showHi(best);
  }
  // the full model, as it comes (its own materials and textures: nothing tinted or cut); it casts no shadow of its
  // own (538k triangles): a stand-in of the low model's shape does, invisible in the picture
  makeHi(gl) {
    this.hiModel = this.modelGroup(gl);
    this.hi = this.hiModel; this.hi.name = 'chalet-hi'; this.hi.visible = false;
    this.hi.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = true; } });
    this.group.add(this.hi);
    if (this.loModel) {
      this.hiShadow = this.loModel.clone(true); this.hiShadow.name = 'chalet-hi-shadow'; this.hiShadow.visible = false;
      const ghost = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
      this.hiShadow.traverse((o) => { if (o.isMesh) { o.material = ghost; o.castShadow = true; o.receiveShadow = false; } });
      this.group.add(this.hiShadow);
    }
  }
  /** The full model on house i (-1: none); the low one back on the house it leaves, off the one it takes. */
  showHi(i) {
    if (i === this.hiAt) return;
    if (i >= 0 && !this.hi) return;
    if (this.hiAt >= 0) this.setInstance(this.hiAt, false);
    this.hiAt = i;
    for (const o of [this.hi, this.hiShadow]) {
      if (!o) continue;
      o.visible = i >= 0;
      if (i < 0) continue;
      const h = this.houses[i];
      o.position.copy(h.frame.position); o.quaternion.copy(h.frame.quaternion); o.updateMatrixWorld(true);
    }
    if (i >= 0) this.setInstance(i, true);
  }
}
