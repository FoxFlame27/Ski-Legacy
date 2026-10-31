// The road tunnels' meshes and runtime (Oct 31 2026, the user: "add tunnels for the cars, so like roads going through
// tunnels, but don't add any new roads"; the planning and the terrain: tunnels.js). Per tunnel, built near the camera
// (time-sliced, a few ms a frame; dropped far away) as a handful of merged meshes:
//  - the tube: a 2-lane road tunnel's profile (kerbs, white-coated walls, a flat concrete arch, 5.9 m clear over the
//    lanes), lit inside like the secrets' tunnels (secrets/tunnel.js interiorMaterial: aLight = (lamp, daylight): the
//    daylight only reaches in from the portals, the ceiling lights do the rest) and drawn only near
//  - the ceiling lights: two rows of emissive luminaires (no THREE lights), a multiply decal darkening the road inside
//    and an additive one laying the lights' pools on it
//  - the portals: concrete headwalls at the foot of each cutting's end slope (tunnels.js tunnelEnd) with the tube's
//    opening, a snow cap, the tunnel's name board ("Kalkwand-Tunnel  560 m")
//  - the lid (secrets/lid.js) over the trench, shown with the terrain's finest LOD; the mountain over the tube is a
//    surface (tunnels.js), so from above you ride on it
//  - solid walls: line colliders for the cars (busRoads.rails, as the guardrails, but never broken through: no `seg`),
//    box colliders for people on foot or skis (only under the crown: from the mountain above you pass over them), the
//    headwalls' wings solid boxes (a crash, head on); camera blockers inside
//  - lateUpdate: inside, the daylight fades out and the snowfall stops (as the railway's tunnels)
import * as THREE from 'three';
import { world } from '../../world/world.js';
import { busRoads } from './roads.js';
import { TUBE, HP } from './tunnels.js';
import { interiorMaterial } from '../../world/secrets/tunnel.js';
import { buildLidSteps, updateLidVisibility, lidMaterial } from '../../world/secrets/lid.js';
import { slice, late, sharedMaterial } from '../../world/secrets/slice.js';
import { canvasTexture } from '../../modes/parkour/kit.js';
import { mulberry32, smoothstep, clamp } from '../../core/noise.js';
import { quality } from '../../engine/quality.js';

const BUILD_R = 1150, DROP_R = 1450; // m from the tube (the finest terrain LOD shows the trench up to ~1 km out)
const SHOW_R = 320;                  // the interior (tube, lights, decals) drawn within this of the tube
// ... and only while the terrain round it is surely at its finest LOD (128 m nodes, each split from its 256 m parent
// within 256 x lodK of the camera: 294 m on the lowest preset), where the trench is carved and the lid drawn. (Oct 31
// 2026, the user: "this black pointy thing is wrong": a coarser LOD can't step from the cutting up to the mountain at
// a portal and leans into the tube's mouth; past this the plug in the headwall's face hides it)
const showR = () => Math.min(SHOW_R, 256 * (quality.terrain?.lodK ?? 2.5) - 30);
const KERB = 3.45;                   // the kerb's face (the road's plowed half width 3.4 + 5 cm)
const LAMP_EVERY = 4.5, LAMP_V = 1.5; // luminaires every 4.5 m, two rows 1.5 m off the centre line
const LAMP = [1.0, 0.93, 0.8];       // warm white LED
const F = {}, G = {}, Q = {};

// ------------------------------------------------------------------ materials (shared, made once)
let CONCRETE = null;
function concreteTexture() {
  if (CONCRETE !== null) return CONCRETE;
  CONCRETE = canvasTexture(256, 256, (g) => {
    const rnd = mulberry32(3107);
    g.fillStyle = '#bdbab3'; g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 2600; i++) { const s = 0.6 + rnd() * 1.8; g.fillStyle = rnd() < 0.5 ? 'rgba(60,58,54,0.16)' : 'rgba(255,255,250,0.14)'; g.fillRect(rnd() * 256, rnd() * 256, s, s); }
    for (let i = 0; i < 26; i++) { // (water stains, soft)
      const x = rnd() * 256, y = rnd() * 256, r = 10 + rnd() * 34, gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, 'rgba(70,66,60,0.10)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(x - r, y - r, 2 * r, 2 * r);
    }
    g.fillStyle = 'rgba(40,40,40,0.35)'; g.fillRect(0, 0, 256, 2); // (a formwork joint every tile: 3 m)
  }, { wrap: true, anisotropy: 4 });
  return CONCRETE;
}
const MAT = {
  tube: () => sharedMaterial('road-tunnel-tube', () => Object.assign(interiorMaterial({ map: concreteTexture(), vertexColors: true, roughness: 0.82, metalness: 0, envMapIntensity: 0.4 }, { lamp: LAMP, key: 'roadtunnel' }), { side: THREE.DoubleSide })),
  lamp: () => sharedMaterial('road-tunnel-lamp', () => new THREE.MeshStandardMaterial({ color: 0x202224, emissive: new THREE.Color(1.0, 0.95, 0.84), emissiveIntensity: 2.6, roughness: 0.4, side: THREE.DoubleSide })),
  concrete: () => sharedMaterial('road-tunnel-concrete', () => new THREE.MeshStandardMaterial({ map: concreteTexture(), color: 0xd2cfc8, roughness: 0.9, metalness: 0 })),
  snow: () => sharedMaterial('road-tunnel-snow', () => new THREE.MeshStandardMaterial({ color: 0xf3f6fa, roughness: 0.75, metalness: 0, side: THREE.DoubleSide })),
  plug: () => sharedMaterial('road-tunnel-plug', () => new THREE.MeshBasicMaterial({ color: 0x07080a, side: THREE.DoubleSide })),
  dark: () => sharedMaterial('road-tunnel-decal-mul', () => new THREE.MeshBasicMaterial({ vertexColors: true, blending: THREE.MultiplyBlending, transparent: true, depthWrite: false, toneMapped: false, fog: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6 })),
  pools: () => sharedMaterial('road-tunnel-decal-add', () => new THREE.MeshBasicMaterial({ vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false, fog: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6 })),
  blocker: () => sharedMaterial('camera-blocker', () => new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })),
};
export function roadTunnelMaterials() { for (const k in MAT) MAT[k](); lidMaterial(); }

// the name board: "Kalkwand-Tunnel" and its length, black on white with a grey rim (Austrian style)
function signTexture(name, len) {
  return canvasTexture(1024, 208, (g, w, h) => {
    g.fillStyle = '#f4f4f0'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#2b2d31'; g.lineWidth = 10; g.strokeRect(9, 9, w - 18, h - 18);
    g.fillStyle = '#16181b'; g.textBaseline = 'middle';
    g.font = '700 104px "Barlow Condensed", "Arial Narrow", Arial, sans-serif'; g.textAlign = 'left';
    g.fillText(name, 46, h / 2 + 4, w - 300);
    g.font = '600 72px "Barlow Condensed", "Arial Narrow", Arial, sans-serif'; g.textAlign = 'right';
    g.fillText(`${Math.round(len)} m`, w - 46, h / 2 + 4);
  }, { anisotropy: 8 });
}

// the tube's inner profile (v across, + = the path's right; h over the road): kerb face, kerb top, the wall to the
// springline, a flat elliptical arch to the crown, and back down the other side
function profile() {
  const { Wi, Hs, Hc, kerb } = TUBE, P = [[-KERB, -0.06], [-KERB, kerb], [-Wi, kerb], [-Wi, 1.4], [-Wi, 3.0], [-Wi, Hs]];
  const N = 12;
  for (let k = 1; k < N; k++) { const a = (Math.PI * k) / N; P.push([-Wi * Math.cos(a), Hs + (Hc - Hs) * Math.sin(a)]); }
  P.push([Wi, Hs], [Wi, 3.0], [Wi, 1.4], [Wi, kerb], [KERB, kerb], [KERB, -0.06]);
  return P;
}
const archH = (v) => { const { Wi, Hs, Hc } = TUBE; const q = clamp(v / Wi, -1, 1); return Hs + (Hc - Hs) * Math.sqrt(1 - q * q); };

// ------------------------------------------------------------------ one tunnel's meshes (a generator: time-sliced)
function* buildTunnel(t) {
  const { path, floor, pF0, pF1 } = t, { Wi, Hc } = TUBE;
  const group = new THREE.Group();
  group.name = `road-tunnel-${t.name}`;
  const interior = new THREE.Group();
  interior.name = 'road-tunnel-interior';
  group.add(interior);
  const ps0 = pF0 - 3, ps1 = pF1 + 3; // (the tube runs through the headwalls: from their front faces)
  const daylight = (ps) => Math.max(1 - smoothstep(ps0, ps0 + 26, ps), smoothstep(ps1 - 26, ps1, ps));
  // the lights' pools along the tube (strongest under each luminaire), brighter in the first 40 m from each portal
  // (the entrance lighting your eyes adapt to)
  const pool = (ps) => 0.72 + 0.28 * Math.cos((2 * Math.PI * (ps - ps0)) / LAMP_EVERY);
  const entry = (ps) => 1 + 0.35 * Math.max(1 - smoothstep(ps0, ps0 + 45, ps), smoothstep(ps1 - 45, ps1, ps));
  const lampAt = (ps, h) => Math.min(1.25, (0.5 + 0.5 * smoothstep(0, Hc, h)) * pool(ps) * entry(ps));

  // --- the tube
  const prof = profile(), W = prof.length;
  const arc = [0];
  for (let k = 1; k < W; k++) arc.push(arc[k - 1] + Math.hypot(prof[k][0] - prof[k - 1][0], prof[k][1] - prof[k - 1][1]));
  const nrm = prof.map((p, k) => { // (inward: toward the middle of the tube)
    const a = prof[Math.max(0, k - 1)], b = prof[Math.min(W - 1, k + 1)];
    let nv = -(b[1] - a[1]), nh = b[0] - a[0];
    const l = Math.hypot(nv, nh) || 1; nv /= l; nh /= l;
    if (nv * (0 - p[0]) + nh * (2.6 - p[1]) < 0) { nv = -nv; nh = -nh; }
    return [nv, nh];
  });
  const shade = (v, h) => { // vertex colour: kerb, the white-coated wall (a little grime low down), the grey arch
    if (h < TUBE.kerb + 0.01 && Math.abs(v) < Wi - 0.01) return Math.abs(v) <= KERB + 0.01 && h < TUBE.kerb - 0.01 ? 0.95 : 0.62;
    if (h < 3.4) return 0.78 + 0.18 * smoothstep(0.3, 1.4, h);
    return 0.66 - 0.08 * smoothstep(TUBE.Hs, Hc, h);
  };
  const NR = Math.max(2, Math.ceil((ps1 - ps0) / 1.5));
  const pos = new Float32Array((NR + 1) * W * 3), nor = new Float32Array((NR + 1) * W * 3), col = new Float32Array((NR + 1) * W * 3);
  const uv = new Float32Array((NR + 1) * W * 2), lig = new Float32Array((NR + 1) * W * 2);
  for (let j = 0; j <= NR; j++) {
    const ps = ps0 + ((ps1 - ps0) * j) / NR;
    path.at(ps, F);
    const y = floor(ps), day = daylight(ps);
    for (let k = 0; k < W; k++) {
      const [v, h] = prof[k], [nv, nh] = nrm[k], q = j * W + k;
      pos[q * 3] = F.x + F.rx * v; pos[q * 3 + 1] = y + h; pos[q * 3 + 2] = F.z + F.rz * v;
      nor[q * 3] = F.rx * nv; nor[q * 3 + 1] = nh; nor[q * 3 + 2] = F.rz * nv;
      const c = shade(v, h);
      col[q * 3] = c; col[q * 3 + 1] = c; col[q * 3 + 2] = c * 0.98;
      uv[q * 2] = arc[k] / 3; uv[q * 2 + 1] = ps / 3;
      lig[q * 2] = lampAt(ps, h); lig[q * 2 + 1] = day;
    }
    if ((j & 15) === 15 && late()) yield;
  }
  const idx = [];
  for (let j = 0; j < NR; j++) for (let k = 0; k < W - 1; k++) { const a = j * W + k, b = a + 1, c = a + W, d = c + 1; idx.push(a, b, c, b, d, c); }
  const tg = new THREE.BufferGeometry();
  tg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  tg.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  tg.setAttribute('color', new THREE.BufferAttribute(col, 3));
  tg.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  tg.setAttribute('aLight', new THREE.BufferAttribute(lig, 2));
  tg.setIndex(idx);
  tg.computeBoundingSphere();
  const tube = new THREE.Mesh(tg, MAT.tube());
  tube.name = 'road-tunnel-tube';
  tube.receiveShadow = true;
  interior.add(tube);
  yield;

  // --- the ceiling lights (boxes 1.6 x 0.28 m, two rows), one draw
  {
    const lp = [], li = [];
    const box = (cx, cy, cz, ax, az, L, wd, th) => { // (a box along (ax, az), across the other way)
      const bx = -az, bz = ax, b = lp.length / 3;
      for (const [u, w, hh] of [[-1, -1, 0], [1, -1, 0], [1, 1, 0], [-1, 1, 0], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]) {
        lp.push(cx + ax * u * L / 2 + bx * w * wd / 2, cy - hh * th, cz + az * u * L / 2 + bz * w * wd / 2);
      }
      for (const f of [[0, 1, 2, 0, 2, 3], [4, 6, 5, 4, 7, 6], [0, 4, 5, 0, 5, 1], [1, 5, 6, 1, 6, 2], [2, 6, 7, 2, 7, 3], [3, 7, 4, 3, 4, 0]]) for (const q of f) li.push(b + q);
    };
    for (let ps = ps0 + 2; ps < ps1 - 1; ps += LAMP_EVERY) {
      path.at(ps, F);
      const y = floor(ps);
      for (const sd of [-1, 1]) {
        const v = sd * LAMP_V;
        box(F.x + F.rx * v, y + archH(v) - 0.05, F.z + F.rz * v, F.tx, F.tz, 1.6, 0.28, 0.08);
      }
      if (late()) yield;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
    g.setIndex(li);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, MAT.lamp());
    m.name = 'road-tunnel-lights';
    interior.add(m);
  }

  // --- the road inside: darker (multiply) toward the middle, the lights' pools laid on it (additive)
  let darkDecal = null;
  {
    const NA = 5, rows = NR + 1, dp = new Float32Array(rows * NA * 3), cm = new Float32Array(rows * NA * 3), ca = new Float32Array(rows * NA * 3);
    for (let j = 0; j < rows; j++) {
      const ps = ps0 + ((ps1 - ps0) * j) / NR;
      path.at(ps, F);
      const y = floor(ps) + 0.06, day = daylight(ps), m = 1 - (1 - day) * 0.84, a = (1 - day) * 0.11 * pool(ps) * entry(ps);
      for (let q = 0; q < NA; q++) {
        const v = -KERB + (2 * KERB * q) / (NA - 1), o = (j * NA + q) * 3;
        dp[o] = F.x + F.rx * v; dp[o + 1] = y; dp[o + 2] = F.z + F.rz * v;
        cm[o] = cm[o + 1] = cm[o + 2] = m;
        const e = a * (1 - 0.35 * Math.abs(v) / KERB);
        ca[o] = e * LAMP[0]; ca[o + 1] = e * LAMP[1]; ca[o + 2] = e * LAMP[2];
      }
    }
    const di = [];
    for (let j = 0; j < NR; j++) for (let q = 0; q < NA - 1; q++) { const a = j * NA + q, b = (j + 1) * NA + q; di.push(a, b, a + 1, a + 1, b, b + 1); }
    for (const [colors, mat, order] of [[cm, MAT.dark(), 2], [ca, MAT.pools(), 3]]) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(dp, 3));
      g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      g.setIndex(di);
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, mat);
      m.renderOrder = order;
      m.name = 'road-tunnel-floor';
      interior.add(m);
      if (order === 2) darkDecal = m;
    }
  }
  yield;

  // --- the portals: a concrete headwall at each cutting's end slope, the tube's opening through it, a snow cap and
  // the name board; their wings reach out until the cutting's batter rises over their top (or the ground falls away)
  const colliders = [], portalGeos = [], snowGeos = [], signs = [];
  const top = HP + 0.8, depth = 3.6;
  for (const end of [0, 1]) {
    const dir = end ? -1 : 1, pf = end ? pF1 : pF0, front = pf - dir * 3; // (front face 3 m out from the portal plane)
    // the wings: out from the opening until the cutting's ground stands over the headwall's top (+1.2 m into it)
    const wing = [0, 0];
    for (const [k, side] of [[0, -1], [1, 1]]) {
      let w = 26;
      for (let u = Wi + 1; u < 40; u += 0.5) {
        path.point(front, side * dir * u, G);
        const gy = world.height(G.x, G.z) - floor(front);
        if (gy >= top - 0.3) { w = u + 1.2; break; }
        if (gy < -2.5) { w = u; break; }
      }
      wing[k] = w;
    }
    // the face's outline in portal space (x across: + to the right looking in, y up from the road), the opening cut
    // out of its bottom edge: the tube's profile 2 cm wider
    const sh = new THREE.Shape();
    sh.moveTo(-wing[0], -1.2); sh.lineTo(-Wi - 0.02, -1.2); sh.lineTo(-Wi - 0.02, TUBE.Hs);
    for (let k = 1; k < 16; k++) { const a = (Math.PI * k) / 16, v = -(Wi + 0.02) * Math.cos(a); sh.lineTo(v, archH(v * Wi / (Wi + 0.02)) + 0.02); }
    sh.lineTo(Wi + 0.02, TUBE.Hs); sh.lineTo(Wi + 0.02, -1.2); sh.lineTo(wing[1], -1.2); sh.lineTo(wing[1], top); sh.lineTo(-wing[0], top);
    const geo = new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: false, curveSegments: 1 }); // (non-indexed)
    // portal space -> world: z (0 = the front face .. depth) along the tube inward, x across, y over the road there
    // (sheared with the road's grade, bent with its curve; (right, up, inward) is a left-handed frame: the winding is
    // flipped back below)
    const pa = geo.attributes.position, uva = geo.attributes.uv;
    for (let i = 0; i < pa.count; i++) {
      const x = pa.getX(i), yy = pa.getY(i), zz = pa.getZ(i), ps = front + dir * zz;
      path.at(ps, F);
      let y = floor(ps) + yy;
      const wx = F.x + F.rx * x * dir, wz = F.z + F.rz * x * dir;
      if (yy < -1) y = Math.min(y, world.height(wx, wz) - 0.6); // (the foot: into the ground where it falls away)
      pa.setXYZ(i, wx, y, wz);
      uva.setXY(i, uva.getX(i) / 3, uva.getY(i) / 3);
    }
    for (let i = 0; i < pa.count; i += 3) { // (swap each triangle's last two corners)
      for (const at of [pa, uva]) { const n = at.itemSize, t0 = []; for (let c = 0; c < n; c++) t0.push(at.array[(i + 1) * n + c]); for (let c = 0; c < n; c++) { at.array[(i + 1) * n + c] = at.array[(i + 2) * n + c]; at.array[(i + 2) * n + c] = t0[c]; } }
    }
    geo.deleteAttribute('normal');
    geo.computeVertexNormals();
    portalGeos.push(geo);
    // snow on top: a slab over the headwall's top, 25 cm
    {
      const sp = [], si = [];
      const N = 12;
      for (let k = 0; k <= N; k++) {
        const x = -wing[0] - 0.1 + ((wing[0] + wing[1] + 0.2) * k) / N;
        for (const zz of [-0.12, depth + 0.1]) {
          const ps = front + dir * zz;
          path.at(ps, F);
          const y = floor(ps) + top, wx = F.x + F.rx * x * dir, wz = F.z + F.rz * x * dir;
          const lump = 0.18 + 0.1 * Math.sin(x * 1.3 + end) * Math.sin(zz * 2.1 + x);
          sp.push(wx, y - 0.02, wz, wx, y + lump, wz);
        }
      }
      for (let k = 0; k < N; k++) {
        const a = k * 4; // (verts: [near bottom, near top, far bottom, far top] per column)
        si.push(a + 1, a + 5, a + 3, a + 3, a + 5, a + 7); // top
        si.push(a, a + 4, a + 1, a + 1, a + 4, a + 5); // near side
        si.push(a + 2, a + 3, a + 6, a + 3, a + 7, a + 6); // far side
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
      g.setIndex(si);
      snowGeos.push(g.toNonIndexed());
    }
    // the name board over the opening, on the face
    {
      path.at(front, F);
      const ox = -F.tx * dir, oz = -F.tz * dir; // (out of the face)
      const mat = new THREE.MeshStandardMaterial({ map: signTexture(t.name, t.length), color: 0xffffff, roughness: 0.55, metalness: 0, emissive: new THREE.Color(0.08, 0.08, 0.08) });
      mat.userData.own = true;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(6.4, 1.3), mat);
      m.position.set(F.x + ox * 0.03, floor(front) + Hc + 1.5, F.z + oz * 0.03);
      m.rotation.y = Math.atan2(ox, oz);
      m.name = 'road-tunnel-sign';
      signs.push(m);
    }
    // the wings: solid (a crash, head on), walkable on top
    for (const [k, side] of [[0, -1], [1, 1]]) {
      const u0 = Wi + 0.15, u1 = wing[k], um = (u0 + u1) / 2, mid = front + dir * depth / 2;
      if (u1 - u0 < 0.3) continue;
      path.point(mid, side * dir * um, G);
      path.at(mid, F);
      colliders.push({ x: G.x, z: G.z, hw: (u1 - u0) / 2, hd: depth / 2, rot: Math.atan2(F.rz, F.rx), top: floor(mid) + top, roadTunnel: true });
    }
    yield;
  }
  const merge = (geos) => {
    let n = 0;
    for (const g of geos) n += g.attributes.position.count;
    const p = new Float32Array(n * 3), u = new Float32Array(n * 2), nn = new Float32Array(n * 3);
    let o = 0;
    for (const g of geos) {
      g.computeVertexNormals();
      p.set(g.attributes.position.array, o * 3); nn.set(g.attributes.normal.array, o * 3);
      if (g.attributes.uv) u.set(g.attributes.uv.array, o * 2);
      o += g.attributes.position.count;
      g.dispose();
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(p, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nn, 3));
    out.setAttribute('uv', new THREE.BufferAttribute(u, 2));
    out.computeBoundingSphere();
    return out;
  };
  const portals = new THREE.Mesh(merge(portalGeos), MAT.concrete());
  portals.name = 'road-tunnel-portals'; portals.castShadow = true; portals.receiveShadow = true;
  group.add(portals);
  const snow = new THREE.Mesh(merge(snowGeos), MAT.snow());
  snow.name = 'road-tunnel-snow'; snow.receiveShadow = true;
  group.add(snow);
  for (const s of signs) group.add(s);
  // (far off, while the interior is not drawn: a dark plug filling each opening, never a view into the trench.
  // Oct 31 2026, the user: "this black pointy thing is wrong": the plug now stands 5 cm inside the headwall's front
  // face, not 10 m in, and is the whole opening (the headwall's 2 cm wider arch, 6 cm more all round, its rim inside
  // the concrete): a far terrain LOD (a 4 m grid and coarser: no lid, the trench not carved) can't step from the
  // cutting's floor up to the mountain at the portal plane, its triangles there lean 1-2 m into the tube's mouth, and
  // from the plug at 10 m in they stood in front of it; the bare trench of the finest LOD showed there too, the tube
  // being hidden that far off. Behind the face both are hidden now.)
  const plugs = [];
  {
    const ps = new THREE.Shape(), N = 16, w = Wi + 0.08;
    ps.moveTo(-w, -0.3); ps.lineTo(-w, TUBE.Hs);
    for (let k = 1; k < N; k++) { const a = (Math.PI * k) / N, v = -w * Math.cos(a); ps.lineTo(v, archH(v * Wi / w) + 0.08); }
    ps.lineTo(w, TUBE.Hs); ps.lineTo(w, -0.3);
    for (const [s, dir] of [[pF0 - 3 + 0.05, 1], [pF1 + 3 - 0.05, -1]]) {
      const m = new THREE.Mesh(new THREE.ShapeGeometry(ps), MAT.plug());
      path.at(s, F);
      m.position.set(F.x, floor(s), F.z);
      m.rotation.y = Math.atan2(F.tx * dir, F.tz * dir);
      m.name = 'road-tunnel-plug';
      group.add(m); plugs.push(m);
    }
  }
  yield;

  // --- people's walls (under the crown only), every ~6 m both sides
  for (let ps = ps0; ps < ps1 - 0.5; ps += 6) {
    const pb = Math.min(ps1, ps + 6);
    path.at(ps, F); const ax = F.x, az = F.z, ya = floor(ps); path.at(pb, G);
    for (const sd of [-1, 1]) {
      const o = sd * (Wi + 0.25);
      const x0 = ax + F.rx * o, z0 = az + F.rz * o, x1 = G.x + G.rx * o, z1 = G.z + G.rz * o;
      colliders.push({ x: (x0 + x1) / 2, z: (z0 + z1) / 2, hw: Math.hypot(x1 - x0, z1 - z0) / 2 + 0.2, hd: 0.25, rot: Math.atan2(z1 - z0, x1 - x0), soft: true, rail: true, top: ya + Hc, roadTunnel: true });
    }
  }
  // --- camera blockers: a low-poly inner tube per ~100 m (each culled by its own bounds)
  const blockers = [];
  const BW = [[-Wi + 0.3, -0.2], [-Wi + 0.3, TUBE.Hs], [-Wi * 0.55, Hc - 0.2], [0, Hc - 0.15], [Wi * 0.55, Hc - 0.2], [Wi - 0.3, TUBE.Hs], [Wi - 0.3, -0.2]];
  for (let a = ps0; a < ps1 - 0.5; a += 100) {
    const b = Math.min(ps1, a + 100), BN = Math.max(1, Math.ceil((b - a) / 5)), bp = [], bi = [];
    for (let j = 0; j <= BN; j++) {
      const ps = a + ((b - a) * j) / BN;
      path.at(ps, F);
      const y = floor(ps);
      for (const [v, h] of BW) bp.push(F.x + F.rx * v, y + h, F.z + F.rz * v);
    }
    for (let j = 0; j < BN; j++) for (let k = 0; k < BW.length - 1; k++) { const p0 = j * BW.length + k, p1 = p0 + 1, p2 = p0 + BW.length, p3 = p2 + 1; bi.push(p0, p2, p1, p1, p2, p3); }
    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.Float32BufferAttribute(bp, 3));
    bg.setIndex(bi);
    bg.computeBoundingSphere();
    const bl = new THREE.Mesh(bg, MAT.blocker());
    bl.visible = false;
    bl.name = 'road-tunnel-camera-blocker';
    bl.updateMatrixWorld(true);
    blockers.push(bl);
  }
  yield;

  // --- the lid over the trench, per ~100 m (each section between its two planes: a long curving tunnel never lies
  // behind its own portal's plane)
  const lids = [];
  // (Oct 31 2026, the user: "this black pointy thing is wrong": the lid's corners just in front of each portal plane
  // are lifted onto the headwall's top and the lid kept over the crown all along (tunnels.js lidLift / lidCut), so no
  // lid triangle slopes down into the tube at a portal; near() reaches those corners, 4 m in front of the planes)
  const near = (x, z) => { path.project(x, z, Q); return Q.dist !== Infinity && Q.s > pF0 - 4 && Q.s < pF1 + 4 && Q.dist < t.slotHalf + 4; };
  const cutAt = t.lidCut, lift = t.lidLift;
  const plane = (s, d) => { const p = path.point(s, 0, {}); return { x: p.x, z: p.z, nx: p.tx * d, nz: p.tz * d }; };
  const pad = t.slotHalf + 8;
  for (let a = pF0; a < pF1 - 0.5; a += 100) {
    const b = Math.min(pF1, a + 100);
    let minx = Infinity, minz = Infinity, maxx = -Infinity, maxz = -Infinity;
    for (let s = a; s <= b + 1e-6; s += 5) { path.at(Math.min(s, b), F); minx = Math.min(minx, F.x); maxx = Math.max(maxx, F.x); minz = Math.min(minz, F.z); maxz = Math.max(maxz, F.z); }
    const lid = yield* buildLidSteps({ bounds: { minx: minx - pad, minz: minz - pad, maxx: maxx + pad, maxz: maxz + pad }, near, keep: [[plane(a, 1), plane(b, -1)]], cutAt, lift });
    for (const c of lid.chunks) { c.mesh.name = 'road-tunnel-lid'; group.add(c.mesh); }
    lids.push(lid);
  }
  return { group, interior, colliders, blockers, lids, darkDecal, signs, plugs };
}

// ------------------------------------------------------------------ the runtime
export class RoadTunnels {
  /** scene, terrain (its finest LOD shows the lids), colliders (people's walls while built), cameraBlockers */
  constructor({ scene, terrain = null, colliders = [], cameraBlockers = null }) {
    Object.assign(this, { scene, terrain, colliders, cameraBlockers });
    this.tunnels = busRoads.tunnels || [];
    this.built = new Map(); // tunnel -> built parts
    this.job = null;
    this.dark = 0;
    this.blockersOn = new Set();
    this.inside = null; // the tunnel the camera is in (lateUpdate)
    // coarse samples of each tube for distances (every ~20 m)
    for (const t of this.tunnels) {
      t.samples = [];
      for (let s = t.pF0; s <= t.pF1 + 1e-6; s += 20) { t.path.at(Math.min(s, t.pF1), F); t.samples.push([F.x, F.z]); }
    }
    // the cars' walls (busRoads.rails: as the guardrails, slid along; no `seg`, so never broken through), for good:
    // traffic, police and your car all ride by the same lines; the headwalls' faces beside the openings too
    if (busRoads.rails && busRoads.railGrid) {
      const add = (ax, az, bx, bz) => {
        const k = busRoads.rails.push({ ax, az, bx, bz, roadTunnel: true }) - 1, C = 16;
        for (let gx = Math.floor(Math.min(ax, bx) / C); gx <= Math.floor(Math.max(ax, bx) / C); gx++) for (let gz = Math.floor(Math.min(az, bz) / C); gz <= Math.floor(Math.max(az, bz) / C); gz++) {
          const key = gx * 100003 + gz;
          if (!busRoads.railGrid.has(key)) busRoads.railGrid.set(key, []);
          busRoads.railGrid.get(key).push(k);
        }
      };
      for (const t of this.tunnels) {
        const { path } = t, o = TUBE.Wi - 0.08, ps0 = t.pF0 - 3, ps1 = t.pF1 + 3;
        for (const sd of [-1, 1]) {
          let px = null, pz = null;
          for (let ps = ps0; ; ps = Math.min(ps1, ps + 6)) {
            path.point(ps, sd * o, G);
            if (px !== null) add(px, pz, G.x, G.z);
            px = G.x; pz = G.z;
            if (ps >= ps1) break;
          }
          for (const front of [ps0, ps1]) { // (the face beside the opening, 6 m out)
            path.point(front, sd * o, G); const ax = G.x, az = G.z;
            path.point(front, sd * (o + 6), G); add(ax, az, G.x, G.z);
          }
        }
      }
    }
    // shader warm-up (one tiny mesh per material, caught by the boot's compile, removed after a few frames)
    if (scene && this.tunnels.length) {
      roadTunnelMaterials();
      const geo = new THREE.BoxGeometry(0.2, 0.2, 0.2), n = geo.attributes.position.count;
      geo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(n * 3).fill(1), 3));
      geo.setAttribute('aLight', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
      geo.setAttribute('aData', new THREE.Float32BufferAttribute(new Float32Array(n * 4), 4));
      geo.setAttribute('aMacro', new THREE.Float32BufferAttribute(new Float32Array(n), 1));
      this.warm = new THREE.Group();
      for (const k in MAT) { const q = new THREE.Mesh(geo, MAT[k]()); q.frustumCulled = false; this.warm.add(q); }
      const q = new THREE.Mesh(geo, lidMaterial()); q.frustumCulled = false; this.warm.add(q);
      this.warm.position.set(0, -6000, 0);
      scene.add(this.warm);
      this.warmFrames = 0;
    }
  }

  // distance from (x, z) to tunnel t's tube (coarse, ~20 m samples)
  dist(t, x, z) {
    let d = Infinity;
    for (const [px, pz] of t.samples) d = Math.min(d, (px - x) ** 2 + (pz - z) ** 2);
    return Math.sqrt(d);
  }

  update(dt, camera) {
    if (!this.tunnels.length || !camera) return;
    if (this.warm && ++this.warmFrames > 3) { this.scene.remove(this.warm); this.warm.children[0]?.geometry.dispose(); this.warm = null; }
    const c = camera.position;
    let want = null, wantD = Infinity;
    for (const t of this.tunnels) {
      const d = this.dist(t, c.x, c.z), b = this.built.get(t);
      t.camD = d;
      if (!b && d < BUILD_R && d < wantD) { want = t; wantD = d; }
      else if (b && d > DROP_R) this.drop(t);
      if (this.job?.t === t && d > DROP_R) this.job = null;
    }
    if (!this.job && want) this.job = { t: want, it: buildTunnel(want) };
    if (this.job) this.step(3);
    const R = showR();
    for (const [t, b] of this.built) {
      for (const lid of b.lids) updateLidVisibility(lid, this.terrain);
      b.interior.visible = t.camD < R;
      for (const p of b.plugs) p.visible = !b.interior.visible;
      // camera blockers only near the tube
      const on = t.camD < 120;
      for (const bl of b.blockers) {
        const has = this.blockersOn.has(bl);
        if (on && !has && this.cameraBlockers) { this.cameraBlockers.push(bl); this.blockersOn.add(bl); }
        else if (!on && has) this.unblock(bl);
      }
    }
  }
  step(budget) {
    slice.until = performance.now() + budget;
    try {
      while (this.job && performance.now() < slice.until) {
        const r = this.job.it.next();
        if (r.done) { this.finish(this.job.t, r.value); this.job = null; }
      }
    } catch (e) { console.warn('road tunnel build', e); this.job = null; } finally { slice.until = Infinity; }
  }
  /** build every tunnel near (x, z) at once (behind a loading card or a fade: teleports) */
  buildNear(x, z, r = BUILD_R) {
    for (const t of this.tunnels) {
      if (this.built.has(t) || this.dist(t, x, z) > r) continue;
      if (this.job?.t !== t) this.job = { t, it: buildTunnel(t) };
      this.step(Infinity);
    }
  }
  finish(t, b) {
    this.scene.add(b.group);
    b.group.updateMatrixWorld(true);
    this.colliders.push(...b.colliders);
    this.built.set(t, b);
  }
  unblock(bl) {
    const i = this.cameraBlockers?.indexOf(bl) ?? -1;
    if (i >= 0) this.cameraBlockers.splice(i, 1);
    this.blockersOn.delete(bl);
  }
  drop(t) {
    const b = this.built.get(t);
    if (!b) return;
    this.scene.remove(b.group);
    for (const c of b.colliders) { const i = this.colliders.indexOf(c); if (i >= 0) this.colliders.splice(i, 1); }
    for (const bl of b.blockers) { this.unblock(bl); bl.geometry.dispose(); }
    b.group.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry?.dispose();
      if (o.material?.userData?.own) { o.material.map?.dispose(); o.material.dispose(); }
    });
    this.built.delete(t);
  }

  /** After the environment update, before rendering: inside a tunnel the daylight fades out and the snowfall stops. */
  lateUpdate(camera, env, atmosphere, dt = 0.016) {
    if (!this.tunnels.length || !camera) return;
    const c = camera.position;
    let deep = 0, inside = null;
    for (const t of this.tunnels) {
      if (!(t.camD < 80)) continue;
      const d = t.depth(c.x, c.y, c.z);
      if (d > 0) { inside = t; deep = Math.max(deep, smoothstep(6, 45, d)); }
    }
    this.inside = inside;
    this.dark += (deep - this.dark) * (1 - Math.exp(-dt * 3));
    if (env && this.dark > 0.003) {
      const k = 1 - this.dark * 0.92;
      if (env.sun) env.sun.intensity *= k;
      if (env.hemi) env.hemi.intensity *= k;
      if (this.scene?.environmentIntensity !== undefined) this.scene.environmentIntensity *= 1 - this.dark * 0.85;
    }
    if (this.dark > 0.3) { // (no snowfall in a tunnel: atmosphere.update shows both again every frame)
      if (atmosphere?.snow) atmosphere.snow.visible = false;
      if (atmosphere?.crystalMesh) atmosphere.crystalMesh.visible = false;
    }
    // (deep inside, the sun is already dimmed for everything: the road's multiply decal would only darken it twice)
    for (const b of this.built.values()) if (b.darkDecal) b.darkDecal.visible = this.dark < 0.5;
  }
}
