// The junctions' mouths drawn (junctions.js plans them): where a road joins another, one continuous asphalt surface
// laid over both roads' plowed edges (no snow band or edge line across the mouth: the main road's edge line breaks
// there), its corners rounded, its outer edge ragged snow fading into the bank as the roads' own edges do; and the
// paint of an Alpine side road: a dashed give-way line across the lane coming in, 1 m back from the main road's edge,
// a short solid centre line behind it (the main road's dashed centre line carries straight on, as in Switzerland and
// Austria). The surface: a 0.5 m grid lined up with the drawn terrain's 2 m triangles (each cell split along their
// diagonal), every point on the drawn terrain + 4.5 cm: it lies exactly on the terrain, no snow pokes through; drawn
// a hair nearer than the roads (decal 0.0018 against their 0.0015), the paint nearer still (as the car parks' bays).
import * as THREE from 'three';
import { world } from '../../world/world.js';
import { groundPatch, frameRect, groundDecal } from '../../world/groundpatch.js';
import { busRoads, ROAD_HALF } from './roads.js';
import { mouthField, polyAt } from './junctions.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const hash = (i, j) => { const v = Math.sin(i * 127.1 + j * 311.7) * 43758.5453; return v - Math.floor(v); };
const vnoise = (x, z) => {
  const i = Math.floor(x), j = Math.floor(z), fx = x - i, fz = z - j, u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  return (hash(i, j) * (1 - u) + hash(i + 1, j) * u) * (1 - v) + (hash(i, j + 1) * (1 - u) + hash(i + 1, j + 1) * u) * v;
};
const STEP = 0.5, SUB = 4; // (the grid: 4 cells per 2 m terrain cell)

/** Build every mouth's surface and paint into group (surf: bus.js junctionMaterial). */
export function buildJunctionMouths(group, surf) {
  const mouths = busRoads.mouths || [];
  if (!mouths.length) return;
  const MH = (x, z) => (world.meshHeight ? world.meshHeight(x, z) : world.height(x, z));
  const pos = [], col = [], uv = [], idx = [];
  const lp = [], li = [];
  for (const m of mouths) {
    try { surface(m, MH, pos, col, uv, idx); paint(m, MH, lp, li); } catch (e) { console.warn('junction mouth', e); }
  }
  if (idx.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, surf);
    mesh.name = 'junction-mouths';
    mesh.receiveShadow = true;
    mesh.renderOrder = 1;
    mesh.userData.noCollide = true;
    group.add(mesh);
  }
  if (li.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
    g.setIndex(li);
    g.computeVertexNormals();
    const mat = groundDecal(new THREE.MeshStandardMaterial({ color: 0xe9ebe8, roughness: 0.9, metalness: 0, envMapIntensity: 0.15, transparent: true, opacity: 0.88, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6 }), 0.0021);
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = 'junction-paint';
    mesh.receiveShadow = true;
    mesh.renderOrder = 2;
    mesh.userData.noCollide = true;
    group.add(mesh);
  }
  busRoads.mouthStats = { mouths: mouths.length, tris: idx.length / 3, paintTris: li.length / 3 };
}

// the surface's opacity at (x, z): the joined asphalt (its edge ragged snow, ~1 m as the roads' plowed edges), fading
// into the main road's lane 1.6-2.4 m in from its edge, out along it where the rounded corners end, and up the side road
// a little past them (each road's own surface, edge and markings carry on from there)
function alphaAt(m, x, z) {
  const f = mouthField(m, x, z);
  if (!f) return 0;
  const jit = 0.5 * (vnoise(x * 0.8 + 3.1, z * 0.8) - 0.5) + 0.25 * (vnoise(x * 2.6, z * 2.6 + 7.7) - 0.5);
  let a = smoothstep(0.25, 1.25, -f.sd + jit);
  if (a <= 0) return 0;
  a *= smoothstep(-2.4, -1.6, f.A);
  a *= smoothstep(m.aMax + 0.2, m.aMax - 1.6, f.a) * smoothstep(m.aMin - 0.2, m.aMin + 1.6, f.a);
  a *= 1 - smoothstep(m.cMax - 0.5, m.cMax + 1.5, f.c);
  return a;
}

function surface(m, MH, pos, col, uv, idx) {
  const i0 = Math.floor((m.x - m.rb) / 2) * SUB, i1 = Math.ceil((m.x + m.rb) / 2) * SUB;
  const j0 = Math.floor((m.z - m.rb) / 2) * SUB, j1 = Math.ceil((m.z + m.rb) / 2) * SUB;
  const nx = i1 - i0 + 1, nz = j1 - j0 + 1, A = new Float32Array(nx * nz), id = new Int32Array(nx * nz).fill(-1);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) A[j * nx + i] = alphaAt(m, (i0 + i) * STEP, (j0 + j) * STEP);
  const vert = (i, j) => {
    const k = j * nx + i;
    if (id[k] < 0) {
      const x = (i0 + i) * STEP, z = (j0 + j) * STEP;
      id[k] = pos.length / 3;
      pos.push(x, MH(x, z) + 0.045, z);
      col.push(1, 1, 1, A[k]);
      uv.push(x / 6.8, z / 13.5); // (the road texture's own scale)
    }
    return id[k];
  };
  const on = (...ks) => ks.some((k) => A[k] > 0.004);
  for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const k00 = j * nx + i, k10 = k00 + 1, k01 = k00 + nx, k11 = k01 + 1;
    // (split as the terrain's cells: the diagonal from (x1, z0) to (x0, z1); both triangles face up)
    if (on(k00, k01, k10)) idx.push(vert(i, j), vert(i, j + 1), vert(i + 1, j));
    if (on(k11, k10, k01)) idx.push(vert(i + 1, j + 1), vert(i + 1, j), vert(i, j + 1));
  }
}

// the side road's paint: the give-way line (0.5 m dashes, 0.3 m gaps, 0.3 m deep) across the lane coming in (on the
// side road's right looking away from the main road), and a solid centre line from behind it up to where the rounded
// corners end (the side road's own dashed centre line carries on from there)
function paint(m, MH, lp, li) {
  const H = ROAD_HALF;
  const quad = (cx, cz, ux, uz, u0, u1, v0, v1) => {
    const { pos, idx } = groundPatch(frameRect(cx, cz, ux, uz, -uz, ux, u0, u1, v0, v1), { lift: 0.06, height: MH });
    const base = lp.length / 3;
    for (const q of pos) lp.push(q);
    for (const q of idx) li.push(base + q);
  };
  // the give-way line: u across the road (toward the right of the car coming in), v along it (away from the main road)
  const [cx, cz, dx, dz] = polyAt(m.side, m.cLine);
  const rx = dz, rz = -dx; // (the side road's right, looking away from the main road: the lane coming in)
  for (let u = 0.2; u + 0.5 <= H - 0.4; u += 0.8) quad(cx, cz, rx, rz, u, u + 0.5, -0.15, 0.15);
  // the centre line behind it: solid, 0.12 m, in 1 m pieces (the side road may bend)
  const c1 = Math.max(m.cLine + 3, m.cMax + 0.5);
  for (let c = m.cLine + 0.45; c < c1 - 0.01; c += 1) {
    const ce = Math.min(c + 1, c1), [ax, az] = polyAt(m.side, c), [bx, bz] = polyAt(m.side, ce);
    const l = Math.hypot(bx - ax, bz - az) || 1;
    quad(ax, az, (bx - ax) / l, (bz - az) / l, 0, l, -0.06, 0.06);
  }
}
