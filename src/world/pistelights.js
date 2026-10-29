// Night skiing: floodlight masts along the pistes, the ski lanes, Legacy Park and the groomed paths between the
// village, the gondolas and the chairlifts. A mast is a galvanised 10 m pole with its cable cabinet (the Meshy
// floodlight mast's pole, or one built here when it is missing) carrying a Meshy floodlight bank (five LED floods in
// a frame, or four COB floods in a row; one kind per run) tipped on its mount to face the run, so the pool on the
// snow is where the lamps point (without the Meshy banks: a built crossarm of four floodlights). At dusk the lamps
// come on one by one: the glass glows and blooms, soft haze cones hang under the heads (thicker in falling snow) and the snow
// is really lit: the terrain shades the pools of the masts nearest the camera per pixel (terrain.js, uniforms
// filled here) and a baked pool map beyond them, so the lit runs glow all the way down the mountain. Characters,
// trees and props near the masts are lit by the nearest few through every lit material's shader.
// No THREE lights are added (a new light recompiles every shader).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { terrainUniforms, PL_MAX, PL_RANGE, PL_BEAM_GLSL } from './terrain.js';
import { PISTE_WIDTH, cannonSpots } from './layout.js';
import { quality, onQualityChange } from '../engine/quality.js';

const MAST_H = 10;            // pole height (m)
const ARM_Y = MAST_H + 0.3;   // the crossarm carrying the floodlights
const SPACING = 62;           // m between masts along a run (they alternate sides), +-JITTER
const JITTER = 7;
const EDGE_OFF = 4.5;         // m beyond the groomed edge
const AIM_FRAC = 0.5;         // aim point: this share of the half-width past the centre line
const MIN_GAP = 30;           // m between any two masts
const VILLAGE_CORE = 125;     // the plaza has its own lamps
// graphics preset (quality.lights): full-detail masts (with shadows) within nearLod (160 m on High), the same Meshy
// masts decimated to farLod (2200 m; beyond only their glow at night), haze cones within beamR (340 m), the nearest `lit` masts
// light the snow per pixel and the nearest `obj` of them characters, trees and props
const SEL_R = 650;            // masts considered for the per-pixel lights
const INTENSITY = 2500;       // per mast (three.js units, ~candela)
const OBJ_N = 8;              // masts that light characters, trees and props
const COLOR = [1.0, 0.83, 0.64]; // warm white (reads warm against the blue moonlit snow)
const GALV = '#a4aaae', DARK = '#24272b', STEEL = '#666c72';

// four floodlights on the crossarm, fanned along the run (local frame: +Z faces the run, X runs along it)
const LAMPS = [-0.93, -0.31, 0.31, 0.93].map((x, k) => {
  const m = new THREE.Matrix4().compose(new THREE.Vector3(x, ARM_Y - 0.04, 0.25),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0.6, [-0.42, -0.14, 0.14, 0.42][k], 0, 'YXZ')), new THREE.Vector3(1, 1, 1));
  return { x, m, dir: new THREE.Vector3(0, 0, 1).transformDirection(m), pos: new THREE.Vector3(0, 0, 0.07).applyMatrix4(m) };
});
const LIGHT_C = new THREE.Vector3(0, ARM_Y - 0.12, 0.3); // where the pools are lit from (the lamps' middle)

// ------------------------------------------------------------------ lit materials
// The masts nearest the camera light every lit material too (characters, trees, props, buildings): a small loop
// over shared uniforms is added to three's light chunks. The values are typed arrays, which three's per-material
// uniform copies keep sharing, so one write per frame reaches every material. Installed when this module loads,
// before any material compiles.
const objUniforms = {
  uPLoPos: { value: terrainUniforms.uPLPos.value.subarray(0, OBJ_N * 4) },
  uPLoAim: { value: terrainUniforms.uPLAim.value.subarray(0, OBJ_N * 4) },
  uPLoParams: { value: new Float32Array(4) }, // on, count
  uPLoBound: { value: new Float32Array(4) },  // sphere holding every lit point of those masts (cheap early-out)
  uPLoShape: { value: terrainUniforms.uPLShape.value },
  uPLoColor: { value: terrainUniforms.uPLColor.value },
};
(function installLitMaterials() {
  const C = THREE.ShaderChunk;
  if (C.lights_pars_begin.includes('uPLoPos')) return;
  C.lights_pars_begin += `
#ifndef PL_SKIP_OBJECTS
uniform vec4 uPLoPos[ ${OBJ_N} ];
uniform vec4 uPLoAim[ ${OBJ_N} ];
uniform vec4 uPLoParams;
uniform vec4 uPLoBound;
uniform vec4 uPLoShape;
uniform vec3 uPLoColor;
${PL_BEAM_GLSL}
#endif
`;
  C.lights_fragment_end = `
#if defined( RE_Direct ) && ! defined( PL_SKIP_OBJECTS )
	mat3 plR = mat3( viewMatrix );
	vec3 plW = uPLoParams.x > 0.0 ? ( geometryPosition - viewMatrix[ 3 ].xyz ) * plR : vec3( 1e9 );
	if ( distance( plW, uPLoBound.xyz ) < uPLoBound.w ) {
		// floodlit by the nearest masts (world/pistelights.js)
		IncidentLight plLight;
		plLight.visible = true;
		for ( int i = 0; i < ${OBJ_N}; i ++ ) {
			if ( float( i ) >= uPLoParams.y ) break;
			vec4 lp = uPLoPos[ i ];
			vec3 l = plW - lp.xyz;
			float d2 = dot( l, l );
			if ( d2 > ${(PL_RANGE * PL_RANGE).toFixed(1)} ) continue;
			vec3 ld = l * inversesqrt( d2 );
			vec4 la = uPLoAim[ i ];
			float win = clamp( 1.0 - d2 * d2 * ( la.w > 0.0 ? la.w : ${(1 / PL_RANGE ** 4).toExponential(4)} ), 0.0, 1.0 );
			float e = lp.w * ( plBeam( ld, la.xyz, uPLoShape ) + uPLoShape.w ) * win * win / max( d2, 16.0 );
			plLight.color = uPLoColor * min( e, 40.0 );
			plLight.direction = plR * ( - ld );
			RE_Direct( plLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
		}
	}
#endif
` + C.lights_fragment_end;
  for (const id of ['standard', 'physical', 'lambert', 'phong', 'toon']) if (THREE.ShaderLib[id]) Object.assign(THREE.ShaderLib[id].uniforms, objUniforms);
})();

/** Characters, trees and props lit by the first floodlights already in terrainUniforms.uPLPos (nearest first):
 *  the on / count switch and the bounding sphere every lit material tests first. The resort's masts call it each
 *  frame, and so do the race courses' own floodlights (modes/race/floodlights.js), which fill the same arrays. */
export function setLitObjects(count, max = OBJ_N) {
  const Po = objUniforms.uPLoParams.value, pos = terrainUniforms.uPLPos.value, aim = terrainUniforms.uPLAim.value, B = objUniforms.uPLoBound.value;
  const no = Math.max(0, Math.min(count, OBJ_N, max));
  Po[0] = no ? 1 : 0; Po[1] = no;
  let bx = 0, by = 0, bz = 0, br = 0;
  for (let k = 0; k < no; k++) { bx += pos[k * 4] / no; by += pos[k * 4 + 1] / no; bz += pos[k * 4 + 2] / no; }
  // (each light's own reach: aim.w = 1 / range^4, 0 for a floodlight's PL_RANGE)
  for (let k = 0; k < no; k++) br = Math.max(br, Math.hypot(pos[k * 4] - bx, pos[k * 4 + 1] - by, pos[k * 4 + 2] - bz) + (aim[k * 4 + 3] > 0 ? aim[k * 4 + 3] ** -0.25 : PL_RANGE));
  B[0] = bx; B[1] = by; B[2] = bz; B[3] = br;
}

// ------------------------------------------------------------------ street lamps
// Lamp posts (Legacy Village's plaza, the chalet village's Chaletweg) light the ground the same cheap way as the
// masts: each one is a small "mast" in the same per-pixel list and pool map, hanging over its foot (aimed straight
// down), with a short reach (aim.w = 1 / range^4 in the shaders) and a lower intensity. They come on with the
// floodlights at dusk. No THREE lights. addStreetLamps([{ x, z, y (the lamp's light centre), I?, R? }]) before or
// after the PisteLights are built (village.js, chalets.js).
export const LAMP = { I: 70, R: 15 }; // (under a lamp ~2.5x a floodlit piste, ~0.5x 8 m off: a warm pool, not a hot spot)
const streetLamps = [];
let pisteLightsLive = null;
export function addStreetLamps(list) {
  const lamps = list.map((l, k) => ({
    x: l.x, z: l.z, lx: l.x, ly: l.y, lz: l.z, ax: 0, ay: -1, az: 0, I: l.I ?? LAMP.I, R: l.R ?? LAMP.R,
    ir4: 1 / (l.R ?? LAMP.R) ** 4, th: hash01(Math.round(l.x * 7.3 + l.z * 3.1) + k, 11), on: 0, lamp: true,
  }));
  streetLamps.push(...lamps);
  pisteLightsLive?.addLamps(lamps);
  return lamps;
}

// ------------------------------------------------------------------ small helpers
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
const hash01 = (a, b) => { let h = Math.imul(a ^ Math.imul(b + 0x9e3779b9, 0x85ebca6b), 0xc2b2ae35); h ^= h >>> 15; return (h >>> 0) / 4294967296; };
function arcLengths(pts) {
  const acc = [0];
  for (let i = 1; i < pts.length; i++) acc.push(acc[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return acc;
}
// point + unit direction at arc length s
function sampleAt(pts, acc, s) {
  let i = 1;
  while (i < acc.length - 1 && acc[i] < s) i++;
  const [ax, az] = pts[i - 1], [bx, bz] = pts[i];
  const l = acc[i] - acc[i - 1] || 1, t = Math.min(1, Math.max(0, (s - acc[i - 1]) / l));
  // direction smoothed over a few segments (routed polylines zig-zag a little)
  const j0 = Math.max(0, i - 3), j1 = Math.min(pts.length - 1, i + 2);
  let dx = pts[j1][0] - pts[j0][0], dz = pts[j1][1] - pts[j0][1];
  const dl = Math.hypot(dx, dz) || 1;
  dx /= dl; dz /= dl;
  return { x: ax + (bx - ax) * t, z: az + (bz - az) * t, dx, dz };
}
function segDist(x, z, ax, az, bx, bz) {
  const ex = bx - ax, ez = bz - az, l2 = ex * ex + ez * ez || 1;
  const t = Math.min(1, Math.max(0, ((x - ax) * ex + (z - az) * ez) / l2));
  const dx = ax + ex * t - x, dz = az + ez * t - z;
  return Math.sqrt(dx * dx + dz * dz);
}
// spatial hash of items by bounding box
class Grid {
  constructor(cell) { this.cell = cell; this.map = new Map(); }
  add(minx, minz, maxx, maxz, item) {
    const c = this.cell;
    for (let i = Math.floor(minx / c); i <= Math.floor(maxx / c); i++) {
      for (let j = Math.floor(minz / c); j <= Math.floor(maxz / c); j++) {
        const k = i * 100003 + j;
        let a = this.map.get(k);
        if (!a) this.map.set(k, (a = []));
        a.push(item);
      }
    }
  }
  at(x, z) { return this.map.get(Math.floor(x / this.cell) * 100003 + Math.floor(z / this.cell)); }
}

// JS twin of plBeam (terrain.js) for the baked pool map
function beamJS(lx, ly, lz, ax, ay, az, sh) {
  const ca = lx * ax + ly * ay + lz * az;
  if (ca <= 0) return 0;
  const tl = 1 / Math.sqrt(Math.max(ax * ax + az * az, 1e-6)), tx = -az * tl, tz = ax * tl;
  const ux = -tz * ay, uy = tz * ax - tx * az, uz = tx * ay; // t x a
  const ic = 1 / ca, x = (lx * tx + lz * tz) * ic, v = (lx * ux + ly * uy + lz * uz) * ic;
  return Math.exp(-x * x * sh[0] - v * v * (v > 0 ? sh[1] : sh[2]));
}

// ------------------------------------------------------------------ where the masts go
// Every lit run: the named pistes and ski lanes, Legacy Park, the resort's own races that follow no piste and the
// groomed paths between the village, the gondolas and the chairlifts.
function collectRuns(layout, world) {
  const runs = [], seen = new Set();
  const add = (pts, w, name) => {
    if (!Array.isArray(pts) || pts.length < 2 || seen.has(pts) || !(w > 0)) return;
    seen.add(pts);
    runs.push({ pts, w, name: String(name || 'run') });
  };
  for (const p of layout.pistes || []) add(p.pts, PISTE_WIDTH[p.diff] ?? 18, p.name);
  for (const l of layout.lanes || []) add(l.pts || l.path || l.line, l.w ?? l.halfWidth ?? l.width ?? PISTE_WIDTH[l.diff] ?? 12, l.name || 'lane');
  if (layout.park?.line) add(layout.park.line, layout.park.halfWidth ?? 17, layout.park.name || 'Legacy Park');
  for (const r of layout.races || []) if (r.main && !r.procedural && !r.peak && r.path) add(r.path, r.halfWidth ?? 14, r.name);
  // groomed paths: piste corridors of their own (no piste behind them), chained end to end
  const segs = new Set();
  for (const arr of world.corridorGrid?.values() || []) for (const s of arr) if (s.kind === 'piste' && !s.meta && Math.hypot(s.bx - s.ax, s.bz - s.az) > 15) segs.add(s);
  const key = (x, z) => `${Math.round(x * 2)},${Math.round(z * 2)}`;
  const byStart = new Map(), ends = new Set();
  for (const s of segs) { byStart.set(key(s.ax, s.az), s); ends.add(key(s.bx, s.bz)); }
  const used = new Set();
  for (const s of segs) {
    if (used.has(s) || ends.has(key(s.ax, s.az))) continue; // chains start where no other segment ends
    const pts = [[s.ax, s.az]];
    let c = s, w = 0;
    while (c && !used.has(c)) { used.add(c); pts.push([c.bx, c.bz]); w = Math.max(w, c.w); c = byStart.get(key(c.bx, c.bz)); }
    add(pts, w, 'path');
  }
  for (const s of segs) if (!used.has(s)) add([[s.ax, s.az], [s.bx, s.bz]], s.w, 'path'); // loops / leftovers
  return runs;
}

// Masts every ~62 m along each run, alternating sides, a few metres outside the groomed edge (past any other run
// or wider race course there), clear of safety nets, markers, lift lines, stations, pads, cannons, props and the
// village plaza, on sound ground beside the run (not down a drop), never closer than MIN_GAP to another mast.
function planMasts(layout, world, colliders) {
  const corr = (x, z, out) => {
    out.g = 1e9; out.l = 1e9;
    const arr = world.corridorGrid?.get(Math.floor(x / 64) + ',' + Math.floor(z / 64));
    if (!arr) return out;
    for (let i = 0; i < arr.length; i++) {
      const s = arr[i], d = segDist(x, z, s.ax, s.az, s.bx, s.bz) - s.w;
      if (s.kind === 'lift') { if (d < out.l) out.l = d; } else if (d < out.g) out.g = d;
    }
    return out;
  };
  const cd = { g: 0, l: 0 };
  // safety nets
  const nets = new Grid(32);
  for (const n of layout.nets || []) {
    const L = n.line || [];
    for (let i = 1; i < L.length; i++) {
      const a = L[i - 1], b = L[i];
      nets.add(Math.min(a[0], b[0]) - 4, Math.min(a[1], b[1]) - 4, Math.max(a[0], b[0]) + 4, Math.max(a[1], b[1]) + 4, [a[0], a[1], b[0], b[1]]);
    }
  }
  const nearNet = (x, z, r) => (nets.at(x, z) || []).some((s) => segDist(x, z, s[0], s[1], s[2], s[3]) < r);
  // props with colliders (signs, huts, arches, stands, towers, buildings...)
  const props = new Grid(32);
  for (const c of colliders || []) {
    const reach = (c.r ?? Math.max(c.hw || 0, c.hd || 0)) + 3;
    props.add(c.x - reach, c.z - reach, c.x + reach, c.z + reach, c);
  }
  const propClear = (x, z, m) => {
    for (const c of props.at(x, z) || []) {
      if (c.r !== undefined) { if ((x - c.x) ** 2 + (z - c.z) ** 2 < (c.r + m) ** 2) return false; continue; }
      const cs = Math.cos(-c.rot || 0), sn = Math.sin(-c.rot || 0);
      const lx = (x - c.x) * cs - (z - c.z) * sn, lz = (x - c.x) * sn + (z - c.z) * cs;
      if (Math.hypot(Math.max(Math.abs(lx) - c.hw, 0), Math.max(Math.abs(lz) - c.hd, 0)) < m) return false;
    }
    return true;
  };
  // stations, huts, patrol huts, bus stops, race starts, World Cup finish areas
  const keep = [];
  for (const l of layout.lifts || []) {
    const g = l.type === 'gondola';
    keep.push([l.bottom.x, l.bottom.z, g ? 50 : 26], [l.top.x, l.top.z, g ? 52 : 26]);
    if (l.mid) keep.push([l.mid.x, l.mid.z, 38]);
  }
  for (const h of layout.huts || []) keep.push([h.x, h.z, 34]);
  for (const p of layout.peaks || []) if (p.patrol) keep.push([p.patrol.x, p.patrol.z, 14]);
  for (const b of layout.busStops || []) keep.push([b.x, b.z, 14]);
  for (const r of layout.races || []) {
    if (r.start) keep.push([r.start.x, r.start.z, 24]);
    if (r.arena && r.finish) keep.push([r.finish.x, r.finish.z, (r.halfWidth || 18) + 16]);
    if (r.arenaPlan?.stand) keep.push([r.arenaPlan.stand.x, r.arenaPlan.stand.z, 26]);
  }
  // snow cannons stand beside the pistes on either side (village.js alternates them)
  const cannons = [];
  try { for (const p of cannonSpots()) cannons.push(p); } catch { /* layout without cannons */ }
  for (const piste of layout.pistes || []) {
    for (let i = 20; i < piste.pts.length - 10; i += 28) {
      const [ax, az] = piste.pts[i], [bx, bz] = piste.pts[i + 1], l = Math.hypot(bx - ax, bz - az) || 1, w = (PISTE_WIDTH[piste.diff] ?? 18) + 3;
      cannons.push([ax + ((bz - az) / l) * w, az - ((bx - ax) / l) * w]);
    }
  }
  const mastGrid = new Grid(64), masts = [];
  const mastNear = (x, z) => (mastGrid.at(x, z) || []).some((m) => (m.x - x) ** 2 + (m.z - z) ** 2 < MIN_GAP * MIN_GAP);
  const ok = (x, z, ex, ez) => {
    if (x * x + z * z < VILLAGE_CORE * VILLAGE_CORE) return false;
    if (world.regionAt?.(x, z, 30)) return false;
    corr(x, z, cd);
    if (cd.g < 2.5 || cd.l < 1.5) return false;
    if (nearNet(x, z, 3)) return false;
    if (world.padInfluence(x, z) > 0.02) return false;
    for (const [kx, kz, r] of keep) if (Math.abs(kx - x) < r && Math.abs(kz - z) < r && (kx - x) ** 2 + (kz - z) ** 2 < r * r) return false;
    for (const [kx, kz] of cannons) if (Math.abs(kx - x) < 6 && Math.abs(kz - z) < 6) return false;
    if (!propClear(x, z, 2.5)) return false;
    if (mastNear(x, z)) return false;
    // sound ground beside the run: not down a drop below its edge, not on a steep bank
    const h = world.height(x, z);
    if (h < world.height(ex, ez) - 2.5) return false;
    const gx = (world.height(x + 2, z) - world.height(x - 2, z)) / 4, gz = (world.height(x, z + 2) - world.height(x, z - 2)) / 4;
    return Math.hypot(gx, gz) < 0.85;
  };
  const tryAt = (run, acc, s, side, salt) => {
    if (s < 0 || s > acc[acc.length - 1]) return null;
    const q = sampleAt(run.pts, acc, s);
    const nx = -q.dz * side, nz = q.dx * side; // outward, toward the mast's side
    // the groomed edge on this side (another run or a wider race course may continue past this run's own edge)
    let edge = -1;
    for (let t = Math.max(0, run.w - 3); t <= run.w + 40; t += 1.5) {
      if (corr(q.x + nx * t, q.z + nz * t, cd).g >= 0) { edge = t; break; }
    }
    if (edge < 0) return null;
    for (let lo = edge - 1.5, k = 0; k < 3; k++) { // refine to ~0.2 m
      const mid = (lo + edge) / 2;
      if (corr(q.x + nx * mid, q.z + nz * mid, cd).g >= 0) edge = mid; else lo = mid;
    }
    const ex = q.x + nx * edge, ez = q.z + nz * edge;
    // where a run traverses a slope its masts stand on the uphill side (lamps below the far edge can't light it)
    if (world.height(ex, ez) < world.height(q.x - nx * run.w, q.z - nz * run.w) - 3.5) return null;
    for (const extra of [0, 2, 4.5]) {
      const off = edge + EDGE_OFF + extra + hash01(salt, 7) * 1.5;
      const x = q.x + nx * off, z = q.z + nz * off;
      if (!ok(x, z, ex, ez)) continue;
      // aim a little past the centre line, at the snow
      const tx = q.x - nx * run.w * AIM_FRAC, tz = q.z - nz * run.w * AIM_FRAC;
      return { x, z, tx, tz, side };
    }
    return null;
  };
  for (const run of collectRuns(layout, world)) {
    const acc = arcLengths(run.pts), L = acc[acc.length - 1];
    if (L < 45) continue;
    const h0 = hashStr(run.name + run.pts.length);
    let side = h0 & 1 ? 1 : -1, s = Math.min(35, L * 0.3) + (h0 % 13), k = 0;
    const end = L - Math.min(28, L * 0.2);
    while (s <= end) {
      const salt = h0 + k * 977;
      const m = tryAt(run, acc, s, side, salt) || tryAt(run, acc, s, -side, salt) ||
        tryAt(run, acc, s + 10, side, salt) || tryAt(run, acc, s - 10, side, salt) || tryAt(run, acc, s + 10, -side, salt);
      if (m) {
        m.th = hash01(salt, 3);
        m.run = h0; // (a run's masts all carry the same kind of lamp head)
        masts.push(m);
        mastGrid.add(m.x - MIN_GAP, m.z - MIN_GAP, m.x + MIN_GAP, m.z + MIN_GAP, m);
        side = -m.side;
      } else side = -side;
      k++;
      s += SPACING + (hash01(salt, 5) - 0.5) * 2 * JITTER;
    }
  }
  // pose: planted on the snow (sunk so no foot shows on a slope), lamps facing the aim point
  for (const m of masts) {
    m.y = Math.min(world.height(m.x, m.z), world.height(m.x + 0.35, m.z), world.height(m.x - 0.35, m.z), world.height(m.x, m.z + 0.35), world.height(m.x, m.z - 0.35)) - 0.25;
    m.yaw = Math.atan2(m.tx - m.x, m.tz - m.z);
    const s = Math.sin(m.yaw), c = Math.cos(m.yaw);
    m.lx = m.x + LIGHT_C.x * c + LIGHT_C.z * s; m.ly = m.y + LIGHT_C.y; m.lz = m.z - LIGHT_C.x * s + LIGHT_C.z * c;
    // aim at the snow at least ~14 deg below the horizon: pull the aim point in toward the mast if the far side
    // of the run rises
    let ax = 0, ay = -1, az = 0;
    for (let f = 1; f >= 0.2; f -= 0.1) {
      const tx = m.x + (m.tx - m.x) * f, tz = m.z + (m.tz - m.z) * f;
      ax = tx - m.lx; ay = world.height(tx, tz) - m.ly; az = tz - m.lz;
      if (ay < -0.25 * Math.hypot(ax, az)) break;
    }
    if (ay > -0.25 * Math.hypot(ax, az)) ay = -0.25 * Math.hypot(ax, az);
    m.gx = m.lx + ax; m.gy = m.ly + ay; m.gz = m.lz + az; // the aim point (a Meshy head is tipped to face it)
    const al = Math.hypot(ax, ay, az) || 1;
    m.ax = ax / al; m.ay = ay / al; m.az = az / al;
    m.on = 0;
  }
  return masts;
}

// ------------------------------------------------------------------ geometry
const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3(1, 1, 1);
const M = (x, y, z, rx = 0, ry = 0, rz = 0) => new THREE.Matrix4().compose(_p.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz, 'YXZ')), _s.set(1, 1, 1));
// a primitive baked into the mast frame with a flat vertex colour (position / normal / color only, indexed)
function part(geo, matrix, color) {
  geo.deleteAttribute('uv');
  geo.applyMatrix4(matrix);
  const n = geo.attributes.position.count, c = new Float32Array(n * 3), col = new THREE.Color(color);
  for (let i = 0; i < n; i++) { c[i * 3] = col.r; c[i * 3 + 1] = col.g; c[i * 3 + 2] = col.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return geo;
}
// a square bar between two points
function bar(a, b, w, color) {
  const d = new THREE.Vector3().subVectors(b, a), len = d.length();
  const m = new THREE.Matrix4().compose(new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5),
    new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()), new THREE.Vector3(1, 1, 1));
  return part(new THREE.BoxGeometry(w, len, w), m, color);
}

// floodlight head: pole-top flange, spigot, crossarm with struts, four lamps on yokes (housing, bezel, fins)
// (poleR(y): the pole's radius at height y, so the junction box and the conduit sit on its surface)
function headParts(detail, poleR = (y) => 0.13 - 0.0045 * y) {
  const P = [];
  P.push(part(new THREE.CylinderGeometry(0.17, 0.17, 0.05, detail ? 16 : 6), M(0, MAST_H + 0.025, 0), GALV));
  P.push(part(new THREE.CylinderGeometry(0.065, 0.075, 0.28, detail ? 10 : 5), M(0, MAST_H + 0.16, 0), GALV));
  P.push(part(new THREE.BoxGeometry(2.36, 0.09, 0.09), M(0, ARM_Y, 0), GALV));
  if (detail) {
    for (const sx of [-1, 1]) P.push(bar(new THREE.Vector3(sx * 0.05, MAST_H - 0.32, 0), new THREE.Vector3(sx * 0.78, ARM_Y - 0.04, 0), 0.045, GALV));
    for (const sx of [-1.18, 1.18]) P.push(part(new THREE.BoxGeometry(0.012, 0.1, 0.1), M(sx, ARM_Y, 0), STEEL)); // end caps
  }
  for (const L of LAMPS) {
    // stub from the arm, then a yoke turned with the lamp (its tilt pivots inside it)
    P.push(part(new THREE.BoxGeometry(0.06, 0.06, 0.2), M(L.x, ARM_Y, 0.12), GALV));
    const yawM = M(L.x, ARM_Y - 0.04, 0.25, 0, Math.atan2(L.dir.x, L.dir.z));
    if (detail) {
      P.push(part(new THREE.BoxGeometry(0.6, 0.03, 0.05), yawM.clone().multiply(M(0, 0.07, -0.02)), STEEL));
      for (const sx of [-0.29, 0.29]) P.push(part(new THREE.BoxGeometry(0.025, 0.2, 0.05), yawM.clone().multiply(M(sx, -0.03, -0.02)), STEEL));
    }
    // housing (dark), a lighter bezel round the glass, cooling fins on the back
    P.push(part(new THREE.BoxGeometry(0.54, 0.38, 0.11), L.m.clone(), DARK));
    if (detail) {
      P.push(part(new THREE.BoxGeometry(0.54, 0.38, 0.012), L.m.clone().multiply(M(0, 0, 0.058)), '#3a3e43'));
      for (let f = -2; f <= 2; f++) P.push(part(new THREE.BoxGeometry(0.018, 0.32, 0.05), L.m.clone().multiply(M(f * 0.1, 0, -0.08)), DARK));
    }
  }
  if (detail) {
    // junction box and a cable conduit on the pole's back
    P.push(part(new THREE.BoxGeometry(0.24, 0.34, 0.12), M(0, 2.1, -poleR(2.1) - 0.055), '#7c8186'));
    P.push(bar(new THREE.Vector3(0, 2.27, -poleR(2.3) - 0.016), new THREE.Vector3(0, MAST_H - 0.05, -poleR(MAST_H - 0.3) - 0.016), 0.026, STEEL));
  }
  return P;
}
// galvanised pole in two tapered sections with a slip-joint collar, sunk into the snow
function poleParts(detail) {
  const seg = detail ? 14 : 6, P = [];
  P.push(part(new THREE.CylinderGeometry(0.105, 0.13, 5.6, seg, 1, !detail), M(0, -0.6 + 2.8, 0), GALV));
  P.push(part(new THREE.CylinderGeometry(0.085, 0.105, 5.0, seg, 1, !detail), M(0, MAST_H - 2.5, 0), GALV));
  if (detail) P.push(part(new THREE.CylinderGeometry(0.122, 0.122, 0.16, seg), M(0, 5.0, 0), GALV));
  return P;
}
// the lamps' glass (uv for the LED array drawn in the glass shader)
function glassGeometry() {
  return mergeGeometries(LAMPS.map((L) => new THREE.PlaneGeometry(0.47, 0.31).applyMatrix4(L.m.clone().multiply(M(0, 0, 0.072)))));
}
// The Meshy mast's pole, without its foot plate (buried in the snow) and its own lamp head (ours aims at the
// run): cut at the collar under the head, centred on the pole axis and scaled to MAST_H.
export function meshyPole(gltf) {
  let mesh = null;
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => { if (o.isMesh && !mesh) mesh = o; });
  if (!mesh) return null;
  const src = mesh.geometry, geo = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv']) {
    const a = src.attributes[name];
    if (!a) continue;
    const arr = new Float32Array(a.count * a.itemSize);
    for (let i = 0; i < a.count; i++) for (let k = 0; k < a.itemSize; k++) arr[i * a.itemSize + k] = a.getComponent(i, k);
    geo.setAttribute(name, new THREE.BufferAttribute(arr, a.itemSize));
  }
  if (!geo.attributes.normal || !geo.attributes.uv) return null;
  geo.setIndex(src.index ? Array.from(src.index.array) : null);
  geo.applyMatrix4(mesh.matrixWorld);
  const pos = geo.attributes.position, n = pos.count;
  geo.computeBoundingBox();
  const bb = geo.boundingBox, H = bb.max.y - bb.min.y;
  // radial extent per height slice: the pole is the long thin middle; the foot plate and the head are wide
  const B = 80, rmax = new Float32Array(B), cx = new Float64Array(B), cz = new Float64Array(B), cnt = new Uint32Array(B);
  const bin = (y) => Math.min(B - 1, Math.max(0, Math.floor(((y - bb.min.y) / H) * B)));
  for (let i = 0; i < n; i++) { const b = bin(pos.getY(i)); cx[b] += pos.getX(i); cz[b] += pos.getZ(i); cnt[b]++; }
  for (let b = 0; b < B; b++) if (cnt[b]) { cx[b] /= cnt[b]; cz[b] /= cnt[b]; }
  for (let i = 0; i < n; i++) { const b = bin(pos.getY(i)); rmax[b] = Math.max(rmax[b], Math.hypot(pos.getX(i) - cx[b], pos.getZ(i) - cz[b])); }
  const mid = Array.from(rmax.slice(Math.floor(B * 0.3), Math.floor(B * 0.7))).filter((r) => r > 0).sort((a, b) => a - b);
  const rPole = mid[Math.floor(mid.length / 2)] || H * 0.02;
  let lo = 0, hi = B - 1;
  while (lo < B / 2 && !(rmax[lo] > 0 && rmax[lo] < rPole * 1.8)) lo++;   // first slice above the foot plate
  while (hi > B / 2 && !(rmax[hi] > 0 && rmax[hi] < rPole * 1.8)) hi--;   // last slice below the head
  const y0 = bb.min.y + ((lo + 1) / B) * H, y1 = bb.min.y + ((hi - 1) / B) * H; // (clear of the collar's ragged edge)
  if (!(y1 - y0 > H * 0.5)) return null;
  // keep the triangles between the cuts (and only the vertices they use)
  const idx = geo.index ? geo.index.array : Array.from({ length: n }, (_, i) => i), keepIdx = [], remap = new Int32Array(n).fill(-1), used = [];
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    const ya = pos.getY(a), yb = pos.getY(b), yc = pos.getY(c);
    if (Math.min(ya, yb, yc) < y0 || Math.max(ya, yb, yc) > y1) continue;
    for (const v of [a, b, c]) { if (remap[v] < 0) { remap[v] = used.length; used.push(v); } keepIdx.push(remap[v]); }
  }
  for (const name of ['position', 'normal', 'uv']) {
    const a = geo.attributes[name], sz = a.itemSize, arr = new Float32Array(used.length * sz);
    used.forEach((v, i) => { for (let q = 0; q < sz; q++) arr[i * sz + q] = a.array[v * sz + q]; });
    geo.setAttribute(name, new THREE.BufferAttribute(arr, sz));
  }
  geo.setIndex(keepIdx);
  // pole axis at the origin, its top at MAST_H, its bottom 0.6 m under the snow
  let ax = 0, az = 0, na = 0;
  for (let b = hi - 6; b <= hi - 1; b++) if (cnt[b]) { ax += cx[b]; az += cz[b]; na++; }
  ax /= na || 1; az /= na || 1;
  const k = (MAST_H + 0.6) / (y1 - y0), thin = Math.min(1, 0.125 / (rPole * k)); // a slim ~25 cm pole
  geo.translate(-ax, -y0, -az);
  geo.scale(k * thin, k, k * thin);
  geo.translate(0, -0.6, 0);
  geo.computeBoundingSphere();
  const mat = mesh.material.clone();
  mat.envMapIntensity = 1;
  // radius profile of the finished pole (for the parts mounted on it)
  const prof = new Float32Array(12);
  const p2 = geo.attributes.position;
  for (let i = 0; i < p2.count; i++) {
    const b = Math.min(11, Math.max(0, Math.floor((p2.getY(i) / MAST_H) * 12)));
    prof[b] = Math.max(prof[b], Math.hypot(p2.getX(i), p2.getZ(i)));
  }
  const poleR = (y) => prof[Math.min(11, Math.max(0, Math.floor((y / MAST_H) * 12)))] || rPole * k * thin;
  return { geometry: geo, material: mat, radius: rPole * k * thin, tris: keepIdx.length / 3, poleR };
}

// The Meshy floodlight banks (lamps facing +Z, a mounting tube under the middle of the frame). Lamps and the
// tube are given as shares of the model's bounding box (measured on the models): x, y centre and half size of
// each lamp's glass, the tube's x / z; `cut`: the tube is cut off below this share of the height (the pole
// carries the bank from there).
export const HEADS = {
  // six LED floods in a galvanised frame (the bottom middle one turned away: five face the run)
  floodlight_head_b: {
    width: 1.75, tube: [0.515, 0.424], cut: 0,
    lamps: [[0.2, 0.755, 0.13, 0.115], [0.5, 0.755, 0.13, 0.115], [0.8, 0.755, 0.13, 0.115], [0.2, 0.37, 0.13, 0.115], [0.8, 0.37, 0.13, 0.115]],
  },
  // four COB floods in a row on a black frame, braced to the tube
  floodlight_head_c: {
    width: 1.85, tube: [0.5, 0.39], cut: 0.4,
    lamps: [[0.141, 0.77, 0.105, 0.14], [0.378, 0.77, 0.105, 0.14], [0.619, 0.77, 0.105, 0.14], [0.855, 0.77, 0.105, 0.14]],
  },
};
const HEAD_LAMPS_MAX = 6;
// The bank in the mast frame: centred on its tube, the tube's foot (or the cut) at the origin, `width` m wide.
// Returns the geometry (position / normal / uv in metres), its material, the lamps' glass rectangles (x, y,
// half w, half h) and the front of the glass (z).
export function meshyHead(gltf, spec) {
  let mesh = null;
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => { if (o.isMesh && !mesh) mesh = o; });
  if (!mesh) return null;
  const src = mesh.geometry, geo = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv']) {
    const a = src.attributes[name];
    if (!a) return null;
    const arr = new Float32Array(a.count * a.itemSize);
    for (let i = 0; i < a.count; i++) for (let k = 0; k < a.itemSize; k++) arr[i * a.itemSize + k] = a.getComponent(i, k);
    geo.setAttribute(name, new THREE.BufferAttribute(arr, a.itemSize));
  }
  let index = src.index ? Array.from(src.index.array) : Array.from({ length: src.attributes.position.count }, (_, i) => i);
  geo.applyMatrix4(mesh.matrixWorld);
  geo.computeBoundingBox();
  const bb = geo.boundingBox.clone(), sx = bb.max.x - bb.min.x, sy = bb.max.y - bb.min.y, sz = bb.max.z - bb.min.z;
  const yCut = bb.min.y + (spec.cut || 0) * sy;
  if (spec.cut) {
    // drop the tube below the cut (the pole takes over there)
    const pos = geo.attributes.position, keep = [];
    for (let t = 0; t < index.length; t += 3) {
      if (Math.min(pos.getY(index[t]), pos.getY(index[t + 1]), pos.getY(index[t + 2])) >= yCut - 1e-4) keep.push(index[t], index[t + 1], index[t + 2]);
    }
    // keep only the vertices still used
    const remap = new Int32Array(pos.count).fill(-1), used = [];
    index = keep.map((v) => { if (remap[v] < 0) { remap[v] = used.length; used.push(v); } return remap[v]; });
    for (const name of ['position', 'normal', 'uv']) {
      const a = geo.attributes[name], n = a.itemSize, arr = new Float32Array(used.length * n);
      used.forEach((v, i) => { for (let q = 0; q < n; q++) arr[i * n + q] = a.array[v * n + q]; });
      geo.setAttribute(name, new THREE.BufferAttribute(arr, n));
    }
  }
  geo.setIndex(index);
  const k = spec.width / sx;
  geo.translate(-(bb.min.x + spec.tube[0] * sx), -yCut, -(bb.min.z + spec.tube[1] * sz));
  geo.scale(k, k, k);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  const W = sx * k, H = sy * k, x0 = -spec.tube[0] * W, y0 = -(spec.cut || 0) * H;
  const rects = spec.lamps.map(([fx, fy, hx, hy]) => [x0 + fx * W, y0 + fy * H, hx * W, hy * H]);
  const material = mesh.material.clone();
  material.envMapIntensity = 1;
  return { geometry: geo, material, rects, front: geo.boundingBox.max.z, box: geo.boundingBox.clone(), size: [W, H, sz * k],
    tris: (geo.index ? geo.index.count : geo.attributes.position.count) / 3 };
}
// the bank's material: the model's own, plus at night the glass of each lamp (head-local rectangles on the front)
// glowing as an LED array (the texture's bright chips brightest), per mast as it comes on (aOn)
function headMaterial(head, shared) {
  const mat = head.material;
  mat.emissive = new THREE.Color(1, 1, 1);
  mat.emissiveIntensity = 1;
  const rects = new Float32Array(HEAD_LAMPS_MAX * 4);
  head.rects.forEach((r, k) => rects.set(r, k * 4));
  const n = head.rects.length;
  mat.onBeforeCompile = (s) => {
    s.uniforms.uHeadOn = shared.on;
    s.uniforms.uLampRect = { value: rects };
    s.uniforms.uFront = { value: head.front };
    s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nattribute float aOn;\nvarying float vOn;\nvarying vec3 vHP;\nvarying vec3 vHN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvOn = aOn;\nvHP = position;\nvHN = normal;');
    s.fragmentShader = s.fragmentShader.replace('#include <common>', `#include <common>
uniform float uHeadOn; uniform vec4 uLampRect[ ${HEAD_LAMPS_MAX} ]; uniform float uFront;
varying float vOn; varying vec3 vHP; varying vec3 vHN;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          float glass = 0.0;
          for (int i = 0; i < ${n}; i++) {
            vec4 r = uLampRect[i];
            vec2 d = abs(vHP.xy - r.xy) - r.zw;
            glass = max(glass, 1.0 - smoothstep(-0.03, 0.01, max(d.x, d.y)));
          }
          glass *= smoothstep(0.55, 0.85, normalize(vHN).z) * smoothstep(uFront - 0.2, uFront - 0.09, vHP.z);
          float lum = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
          float led = smoothstep(0.35, 0.9, lum);
          totalEmissiveRadiance = vec3(1.0, 0.86, 0.68) * (vOn * uHeadOn) * (glass * (2.5 + 18.0 * led) + totalEmissiveRadiance * 8.0);
        }`);
  };
  mat.customProgramCacheKey = () => `pl-head-${n}`;
  return mat;
}
// A low copy of a Meshy part for distance: its texture's colour baked into the vertices (read once through a small
// canvas), so with no UVs to keep the mesh clusters right down (cells `cell` m across, `ys` times taller: a pole
// keeps its round section with few rings). Position / normal / color, for a vertex-colour material.
const samplers = new WeakMap();
function texSampler(tex) {
  const img = tex?.image;
  if (!img || typeof document === 'undefined') return null;
  if (samplers.has(img)) return samplers.get(img);
  let f = null;
  try {
    const S = 128, c = document.createElement('canvas');
    c.width = S; c.height = S;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, S, S); // (downsampled: each texel is the mean of its patch)
    const d = g.getImageData(0, 0, S, S).data, lin = new Float32Array(256);
    for (let i = 0; i < 256; i++) lin[i] = Math.pow(i / 255, 2.2);
    f = (u, v, out) => {
      const x = ((Math.floor(u * S) % S) + S) % S, y = ((Math.floor(v * S) % S) + S) % S, o = (y * S + x) * 4;
      out[0] = lin[d[o]]; out[1] = lin[d[o + 1]]; out[2] = lin[d[o + 2]];
      return out;
    };
  } catch { f = null; }
  samplers.set(img, f);
  return f;
}
export function bakedLow(geo, map, cell, ys = 1) {
  const pos = geo.attributes.position, nor = geo.attributes.normal, uv = geo.attributes.uv, n = pos.count;
  const sample = uv ? texSampler(map) : null, col = [0.62, 0.64, 0.66];
  const ids = new Map(), R = [], remap = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const key = ((Math.floor(x / cell) + 1024) * 2048 + Math.floor(y / (cell * ys)) + 1024) * 2048 + Math.floor(z / cell) + 1024; // (exact for |cells| < 1024)
    let id = ids.get(key);
    if (id === undefined) { id = R.length / 10; ids.set(key, id); R.push(0, 0, 0, 0, 0, 0, 0, 0, 0, 0); }
    const o = id * 10;
    R[o] += x; R[o + 1] += y; R[o + 2] += z;
    if (nor) { R[o + 3] += nor.getX(i); R[o + 4] += nor.getY(i); R[o + 5] += nor.getZ(i); }
    if (sample) sample(uv.getX(i), uv.getY(i), col);
    R[o + 6] += col[0]; R[o + 7] += col[1]; R[o + 8] += col[2]; R[o + 9]++;
    remap[i] = id;
  }
  const index = geo.index ? geo.index.array : Array.from({ length: n }, (_, i) => i), tris = [], seen = new Set();
  for (let t = 0; t < index.length; t += 3) {
    const a = remap[index[t]], b = remap[index[t + 1]], c = remap[index[t + 2]];
    if (a === b || b === c || a === c) continue;
    const k = a < b ? (b < c ? `${a},${b},${c}` : a < c ? `${a},${c},${b}` : `${c},${a},${b}`) : (a < c ? `${b},${a},${c}` : b < c ? `${b},${c},${a}` : `${c},${b},${a}`);
    if (seen.has(k)) continue;
    seen.add(k);
    tris.push(a, b, c);
  }
  const m = R.length / 10, P = new Float32Array(m * 3), N = new Float32Array(m * 3), C = new Float32Array(m * 3);
  for (let i = 0; i < m; i++) {
    const o = i * 10, w = R[o + 9];
    P[i * 3] = R[o] / w; P[i * 3 + 1] = R[o + 1] / w; P[i * 3 + 2] = R[o + 2] / w;
    const l = Math.hypot(R[o + 3], R[o + 4], R[o + 5]);
    if (l > 1e-4) { N[i * 3] = R[o + 3] / l; N[i * 3 + 1] = R[o + 4] / l; N[i * 3 + 2] = R[o + 5] / l; } else N[i * 3 + 1] = 1;
    C[i * 3] = R[o + 6] / w; C[i * 3 + 1] = R[o + 7] / w; C[i * 3 + 2] = R[o + 8] / w;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(P, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  out.setAttribute('color', new THREE.BufferAttribute(C, 3));
  out.setIndex(tris);
  // clustering pulls the outer surface in by up to half a cell: stretch it back to the part's own extent (a pole
  // still meets its bank, a bank keeps its size)
  if (!geo.boundingBox) geo.computeBoundingBox();
  out.computeBoundingBox();
  const o = geo.boundingBox, d = out.boundingBox;
  for (let i = 0; i < m; i++) {
    for (let a = 0; a < 3; a++) {
      const lo = d.min.getComponent(a), span = d.max.getComponent(a) - lo;
      if (span > 1e-5) P[i * 3 + a] = o.min.getComponent(a) + ((P[i * 3 + a] - lo) / span) * (o.max.getComponent(a) - o.min.getComponent(a));
    }
  }
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}
// pole details for a Meshy head: a cable conduit up the back of the pole, a junction box near its foot (when the
// pole model has none of its own)
function poleDetailParts(poleR = (y) => 0.13 - 0.0045 * y) {
  return [
    part(new THREE.BoxGeometry(0.24, 0.34, 0.12), M(0, 2.1, -poleR(2.1) - 0.055), '#7c8186'),
    bar(new THREE.Vector3(0, 2.27, -poleR(2.3) - 0.016), new THREE.Vector3(0, MAST_H - 0.05, -poleR(MAST_H - 0.3) - 0.016), 0.026, STEEL),
  ];
}

// ------------------------------------------------------------------ the far-field pool map
// Irradiance of every mast's pool baked into a single-channel texture over the lit area (sqrt-encoded, ~5 m
// texels), on the snow's real slope (heights from a cached 16 m grid). Baked a few masts per frame.
const MAP_EMAX = 12;
class PoolMap {
  constructor(masts, world, shape) {
    this.world = world;
    this.shape = shape;
    this.queue = masts.slice();
    this.done = !masts.length;
    this.texture = null;
    if (this.done) return;
    let minx = Infinity, minz = Infinity, maxx = -Infinity, maxz = -Infinity;
    const R = PL_RANGE * 0.86;
    for (const m of masts) { const r = (m.R ? m.R * 0.86 : R) + 8; minx = Math.min(minx, m.x - r); maxx = Math.max(maxx, m.x + r); minz = Math.min(minz, m.z - r); maxz = Math.max(maxz, m.z + r); }
    this.texel = Math.max(4, Math.max(maxx - minx, maxz - minz) / 1024);
    this.W = Math.ceil((maxx - minx) / this.texel / 4) * 4;
    this.H = Math.ceil((maxz - minz) / this.texel / 4) * 4;
    this.x0 = minx; this.z0 = minz;
    this.E = new Float32Array(this.W * this.H);
    this.hc = new Map();
    this.R = R;
  }
  // terrain height on a cached 16 m grid (bilinear) and its slope
  ground(x, z, out) {
    const G = 16, fx = x / G, fz = z / G, i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
    const h = (a, b) => {
      const k = a * 1048576 + b;
      let v = this.hc.get(k);
      if (v === undefined) { v = this.world.height(a * G, b * G); this.hc.set(k, v); }
      return v;
    };
    const h00 = h(i, j), h10 = h(i + 1, j), h01 = h(i, j + 1), h11 = h(i + 1, j + 1);
    out.y = (h00 + (h10 - h00) * tx) * (1 - tz) + (h01 + (h11 - h01) * tx) * tz;
    const gx = ((h10 - h00) * (1 - tz) + (h11 - h01) * tz) / G, gz = ((h01 - h00) * (1 - tx) + (h11 - h10) * tx) / G;
    const il = 1 / Math.sqrt(gx * gx + 1 + gz * gz);
    out.nx = -gx * il; out.ny = il; out.nz = -gz * il;
    return out;
  }
  step(budgetMs) {
    if (this.done) return true;
    const t0 = performance.now(), g = { y: 0, nx: 0, ny: 1, nz: 0 }, sh = this.shape;
    while (this.queue.length && performance.now() - t0 < budgetMs) {
      const m = this.queue.pop();
      // (a street lamp: its own intensity and shorter reach)
      const R = m.R ? m.R * 0.86 : this.R, R4 = (m.R || PL_RANGE) ** 4, I = m.I || INTENSITY;
      const i0 = Math.max(0, Math.floor((m.x - R - this.x0) / this.texel)), i1 = Math.min(this.W - 1, Math.ceil((m.x + R - this.x0) / this.texel));
      const j0 = Math.max(0, Math.floor((m.z - R - this.z0) / this.texel)), j1 = Math.min(this.H - 1, Math.ceil((m.z + R - this.z0) / this.texel));
      for (let j = j0; j <= j1; j++) {
        const z = this.z0 + (j + 0.5) * this.texel;
        for (let i = i0; i <= i1; i++) {
          const x = this.x0 + (i + 0.5) * this.texel;
          if ((x - m.x) ** 2 + (z - m.z) ** 2 > R * R) continue;
          this.ground(x, z, g);
          let lx = x - m.lx, ly = g.y - m.ly, lz = z - m.lz;
          const d2 = lx * lx + ly * ly + lz * lz, il = 1 / Math.sqrt(d2);
          lx *= il; ly *= il; lz *= il;
          const ndl = -(lx * g.nx + ly * g.ny + lz * g.nz);
          if (ndl <= 0) continue;
          let win = Math.min(1, Math.max(0, 1 - (d2 * d2) / R4)); win *= win;
          this.E[j * this.W + i] += I * (beamJS(lx, ly, lz, m.ax, m.ay, m.az, sh) + sh[3]) * win / Math.max(d2, 16) * ndl;
        }
      }
    }
    if (this.queue.length) return false;
    const data = new Uint8Array(this.W * this.H);
    for (let k = 0; k < data.length; k++) data[k] = Math.round(Math.sqrt(Math.min(1, this.E[k] / MAP_EMAX)) * 255);
    const tex = new THREE.DataTexture(data, this.W, this.H, THREE.RedFormat, THREE.UnsignedByteType);
    tex.unpackAlignment = 1;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    this.texture = tex;
    this.E = null; this.hc = null;
    this.done = true;
    return true;
  }
}

// ------------------------------------------------------------------ shaders for the glow and the haze
// height fog as in engine/fog.js, as transmittance (the glow and haze fade out instead of turning fog-coloured)
const FOG_GLSL = `
  uniform vec2 uFog;
  float plFogT(vec3 wp) {
    vec3 rd = wp - cameraPosition;
    float dist = length(rd);
    float x = rd.y * uFog.y;
    float k = abs(x) > 1e-4 ? (1.0 - exp(-x)) / x : 1.0;
    float amount = uFog.x * exp(-max(cameraPosition.y, 0.0) * uFog.y) * dist * k;
    float xv = rd.y * (1.0 / 380.0);
    float kv = abs(xv) > 1e-4 ? (1.0 - exp(-xv)) / xv : 1.0;
    amount += uFog.x * 0.3 * dist * min(kv, 7.0);
    return exp(-amount);
  }`;

// a soft glow on every lamp: bright when the lamp faces you, kept a few pixels wide far away (distant masts stay
// visible as warm points of light), bloomed by the post chain
function glowMaterial(shared, lampSize = 0.95) {
  return new THREE.ShaderMaterial({
    uniforms: { uOn: shared.on, uPx: shared.px, uFog: shared.fog, uWet: shared.wet, uColor: { value: new THREE.Color(1.0, 0.82, 0.6) } },
    vertexShader: `
      attribute vec3 iPos; attribute vec3 iDir; attribute float iOn;
      uniform float uOn, uPx, uWet;
      varying vec2 vUv; varying float vI; varying float vHalo;
      ${FOG_GLSL}
      void main() {
        vUv = position.xy * 2.0;
        float lit = iOn * uOn;
        vec4 mv = viewMatrix * vec4(iPos, 1.0);
        float dist = max(-mv.z, 0.1);
        float k = smoothstep(-0.3, 0.8, dot(normalize(cameraPosition - iPos), iDir));
        float size = ${lampSize.toFixed(3)} * (0.6 + 0.4 * k) * (1.0 + 0.9 * uWet); // falling snow / mist spread the glow
        vHalo = 1.1 + 2.2 * uWet;
        float s = max(size, dist * uPx * 2.4);
        vI = lit * mix(0.05, 1.0, k) * max(size * size / (s * s), 0.07) * plFogT(iPos);
        mv.xyz += normalize(-mv.xyz) * 0.4; // in front of the housing
        mv.xy += position.xy * s * 2.0;
        gl_Position = projectionMatrix * mv;
        if (vI < 0.002) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 uColor; uniform float uWet;
      varying vec2 vUv; varying float vI; varying float vHalo;
      void main() {
        float r2 = dot(vUv, vUv);
        if (r2 > 1.0) discard;
        float core = exp(-r2 * 26.0 * (1.0 + 0.9 * uWet)), halo = exp(-r2 * 4.0) * (1.0 - r2);
        gl_FragColor = vec4(uColor * vI * (core * 16.0 + halo * vHalo), 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
  });
}

// haze: light scattered by falling snow and mist under each lamp, an additive cone: thick where you look through
// its middle, soft at its edges, fading along its length well before the snow, and brighter when you look up
// the beam toward the lamp (forward scattering). Almost invisible in clear air.
function hazeMaterial(shared) {
  return new THREE.ShaderMaterial({
    uniforms: { uHaze: shared.haze, uFog: shared.fog, uColor: { value: new THREE.Color(1.0, 0.78, 0.52) } },
    vertexShader: `
      attribute float aOn;
      varying float vAlong; varying vec3 vW; varying vec3 vN; varying float vT; varying vec3 vAxis; varying vec3 vApex;
      ${FOG_GLSL}
      void main() {
        vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vAxis = normalize(mat3(modelMatrix) * instanceMatrix[2].xyz);
        vApex = (modelMatrix * instanceMatrix[3]).xyz;
        vec3 sc = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
        vN = mat3(modelMatrix) * mat3(instanceMatrix) * (normal / (sc * sc));
        vW = w.xyz;
        vAlong = position.z;
        vT = aOn * plFogT(w.xyz);
        gl_Position = projectionMatrix * viewMatrix * w;
        if (vT < 0.002) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
      }`,
    fragmentShader: `
      uniform float uHaze; uniform vec3 uColor;
      varying float vAlong; varying vec3 vW; varying vec3 vN; varying float vT; varying vec3 vAxis; varying vec3 vApex;
      void main() {
        vec3 V = normalize(cameraPosition - vW);
        float f = abs(dot(normalize(vN), V));
        float fade = 1.0 - vAlong;
        float a = f * f * f * smoothstep(0.0, 0.12, vAlong) * fade * fade * fade / (0.25 + vAlong * 3.0);
        // forward scattering: looking back up the beam toward the lamp
        float phase = mix(0.3, 1.6, smoothstep(-0.3, 0.95, dot(normalize(cameraPosition - vApex), vAxis)));
        gl_FragColor = vec4(uColor * a * phase * uHaze * vT, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
  });
}

// ------------------------------------------------------------------ the module
export class PisteLights {
  /**
   * @param {THREE.Scene} scene
   * @param {{ models?: object, layout: object, world: object, env?: object, colliders?: Array }} o
   *   colliders: the game's collider list (read to keep masts off props; push `this.colliders` into it)
   */
  constructor(scene, { models = {}, layout, world, colliders = [] } = {}) {
    this.scene = scene;
    this.world = world;
    this.group = new THREE.Group();
    this.group.name = 'piste-lights';
    scene.add(this.group);
    const t0 = performance.now();
    this.masts = planMasts(layout, world, colliders);
    const masts = this.masts, N = masts.length;
    for (const m of masts) { m.I = INTENSITY; m.R = 0; m.ir4 = 0; }
    this.lights = masts.slice(); // the masts, then the street lamps (addStreetLamps)
    this.colliders = masts.map((m) => ({ x: m.x, z: m.z, r: 0.3 }));
    // a small tree-free clearing round each mast (like the strips beside the safety nets)
    for (const m of masts) world.addCorridor?.([[m.x - 0.05, m.z], [m.x + 0.05, m.z]], 1.4, 'lift');
    this.on = 0;
    this.nearR = 0;
    this.lastBucket = new THREE.Vector3(1e9, 0, 1e9);
    this.shared = { on: { value: 0 }, px: { value: 0.0015 }, fog: { value: new THREE.Vector2() }, haze: { value: 0 }, wet: { value: 0 } };
    this.enabled = true; // false: lamps off whatever the hour

    // instance transforms (one per mast) and lamp frames
    this.mat = new Float32Array(N * 16);
    const mm = new THREE.Matrix4();
    masts.forEach((m, i) => { mm.compose(_p.set(m.x, m.y, m.z), _q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), m.yaw), _s.set(1, 1, 1)); mm.toArray(this.mat, i * 16); });

    // the lamp heads: Meshy floodlight banks on the pole tops (one kind per run), each tipped on its mount to face
    // its mast's aim point (so the pool on the snow is exactly where the lamps point), else the built crossarm
    // with four lamps
    const heads = Object.keys(HEADS).filter((n) => models[n]).map((n) => ({ name: n, head: meshyHead(models[n], HEADS[n]) })).filter((h) => h.head);
    this.heads = heads.length ? heads : null;
    const G = (this.G = heads.length ? Math.max(...heads.map((h) => h.head.rects.length)) : LAMPS.length); // lamp slots per mast
    this.lampPos = new Float32Array(N * G * 3); this.lampDir = new Float32Array(N * G * 3);
    this.lampLive = new Uint8Array(N * G);
    const v = new THREE.Vector3(), dir = new THREE.Vector3();
    if (heads.length) {
      this.headMat = new Float32Array(N * 16);
      const hm = new THREE.Matrix4(), t = new THREE.Matrix4(), mount = MAST_H - 0.04;
      const pose = (pitch) => hm.copy(mm).multiply(t.makeTranslation(0, mount, 0)).multiply(t.makeRotationX(pitch));
      masts.forEach((m, i) => {
        m.hv = (m.run >>> 3) % heads.length;
        const head = heads[m.hv].head, R = head.rects;
        const c = new THREE.Vector3(R.reduce((a, r) => a + r[0], 0) / R.length, R.reduce((a, r) => a + r[1], 0) / R.length, head.front);
        mm.fromArray(this.mat, i * 16);
        let pitch = Math.asin(Math.min(1, Math.max(-1, -m.ay)));
        for (let it = 0; it < 3; it++) { // (the light comes from the tipped bank: aim again from there)
          v.copy(c).applyMatrix4(pose(pitch));
          dir.set(m.gx - v.x, m.gy - v.y, m.gz - v.z).normalize();
          pitch = Math.asin(Math.min(1, Math.max(-1, -dir.y)));
        }
        pose(pitch).toArray(this.headMat, i * 16);
        v.copy(c).applyMatrix4(hm);
        m.lx = v.x; m.ly = v.y; m.lz = v.z;
        dir.set(0, 0, 1).transformDirection(hm);
        m.ax = dir.x; m.ay = dir.y; m.az = dir.z;
        for (let k = 0; k < G; k++) {
          const r = R[Math.min(k, R.length - 1)];
          v.set(r[0], r[1], head.front + 0.03).applyMatrix4(hm).toArray(this.lampPos, (i * G + k) * 3);
          dir.toArray(this.lampDir, (i * G + k) * 3);
          this.lampLive[i * G + k] = k < R.length ? 1 : 0;
        }
      });
    } else {
      masts.forEach((m, i) => {
        mm.fromArray(this.mat, i * 16);
        LAMPS.forEach((L, k) => {
          v.copy(L.pos).applyMatrix4(mm).toArray(this.lampPos, (i * G + k) * 3);
          v.copy(L.dir).transformDirection(mm).toArray(this.lampDir, (i * G + k) * 3);
          this.lampLive[i * G + k] = 1;
        });
      });
    }

    // bodies: near = Meshy pole (or a detailed built one) + the head; far = the same, decimated
    const bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.55, roughness: 0.42 });
    this.materials = [bodyMat];
    const poleName = ['floodlight_mast', 'piste_light'].find((n) => models[n]);
    const pole = poleName ? meshyPole(models[poleName]) : null;
    const nearParts = heads.length ? [...(pole ? [] : poleParts(true)), ...(poleName === 'floodlight_mast' ? [] : poleDetailParts(pole?.poleR))]
      : [...headParts(true, pole?.poleR), ...(pole ? [] : poleParts(true))];
    this.nearMeshes = [];
    const inst = (geo, mat, count, shadow) => {
      const m = new THREE.InstancedMesh(geo, mat, Math.max(1, count));
      m.count = 0;
      m.castShadow = shadow; m.receiveShadow = shadow;
      m.name = 'piste-light-masts';
      this.group.add(m);
      return m;
    };
    if (pole) { this.nearMeshes.push(inst(pole.geometry, pole.material, N, true)); this.materials.push(pole.material); }
    if (nearParts.length) this.nearMeshes.push(inst(mergeGeometries(nearParts), bodyMat, N, true));
    // far: the same Meshy pole, its texture baked into a few hundred coloured triangles (so a mast looks alike at
    // every distance), else the simple built mast
    const farParts = pole ? null : heads.length ? poleParts(false)
      : [...poleParts(false), part(new THREE.BoxGeometry(2.36, 0.09, 0.09), M(0, ARM_Y, 0), GALV), ...LAMPS.map((L) => part(new THREE.BoxGeometry(0.54, 0.38, 0.11), L.m.clone(), DARK))];
    // (the baked copies' material: duller than bodyMat so the snow on a bank stays white, the same program)
    const farMat = pole || heads.length ? new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.1, roughness: 0.75 }) : bodyMat;
    if (farMat !== bodyMat) this.materials.push(farMat);
    let farPole = null;
    if (pole) {
      // (the bank's thin tube under its frame is lost in its far copy: the far pole runs on up into the frame)
      farPole = bakedLow(pole.geometry, pole.material.map, 0.08, 16);
      const fp = farPole.attributes.position.array, k = (MAST_H + 0.45 + 0.6) / (MAST_H + 0.6);
      for (let i = 1; i < fp.length; i += 3) fp[i] = (fp[i] + 0.6) * k - 0.6;
      farPole.computeBoundingBox(); farPole.computeBoundingSphere();
    }
    this.farMesh = inst(farPole || mergeGeometries(farParts), pole ? farMat : bodyMat, N, false);
    this.farMesh.frustumCulled = false;
    this.poleInfo = pole ? { meshy: poleName, radius: +pole.radius.toFixed(3), tris: pole.tris } : { meshy: false };
    for (const h of heads) {
      // the bank, its LED glass lit at night (per mast as they come on); far away the same bank baked into a few
      // hundred coloured triangles (lit at night by its glow sprites, like every far lamp)
      const head = h.head, n = masts.filter((m) => heads[m.hv] === h).length;
      const farGeo = bakedLow(head.geometry, head.material.map, 0.26); // (~400-700 triangles: a bank is ~10 px wide at 160 m)
      h.on = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, n)), 1);
      head.geometry.setAttribute('aOn', h.on);
      const hmat = headMaterial(head, this.shared);
      this.materials.push(hmat);
      h.near = inst(head.geometry, hmat, n, true);
      h.far = inst(farGeo, farMat, n, false);
      h.far.frustumCulled = false;
      h.nearIdx = new Int32Array(Math.max(1, n));
      h.farTris = farGeo.index.count / 3;
    }
    this.headInfo = heads.map((h) => ({ model: h.name, tris: h.head.tris, farTris: h.farTris, lamps: h.head.rects.length, size: h.head.size.map((s) => +s.toFixed(2)), masts: masts.filter((m) => heads[m.hv] === h).length }));
    if (pole) this.poleInfo.farTris = this.farMesh.geometry.index.count / 3;

    // built head: lamp glass, dark glossy by day, an HDR LED array at night (blooms)
    this.glass = null;
    this.glassIdx = new Int32Array(N);
    if (!heads.length) this.buildGlass(inst, N);

    // glow sprites: one per lamp, all masts
    const quad = new THREE.PlaneGeometry(1, 1);
    const gg = new THREE.InstancedBufferGeometry();
    gg.index = quad.index; gg.setAttribute('position', quad.attributes.position);
    const iPos = this.lampPos, iDir = this.lampDir;
    this.glowOn = new THREE.InstancedBufferAttribute(new Float32Array(N * G), 1);
    gg.setAttribute('iPos', new THREE.InstancedBufferAttribute(iPos, 3));
    gg.setAttribute('iDir', new THREE.InstancedBufferAttribute(iDir, 3));
    gg.setAttribute('iOn', this.glowOn);
    gg.instanceCount = N * G;
    const glowMat = glowMaterial(this.shared, heads.length ? 0.34 : 0.95); // (a bank's glass glows itself up close)
    this.materials.push(glowMat);
    this.glow = new THREE.Mesh(gg, glowMat);
    this.glow.frustumCulled = false;
    this.glow.renderOrder = 5;
    this.glow.visible = N > 0;
    this.group.add(this.glow);

    // haze cones under the lamps of the masts nearby
    const cone = new THREE.ConeGeometry(1, 1, 18, 1, true).translate(0, -0.5, 0).rotateX(-Math.PI / 2);
    cone.deleteAttribute('uv');
    this.hazeOn = new THREE.InstancedBufferAttribute(new Float32Array(N * G), 1);
    cone.setAttribute('aOn', this.hazeOn);
    const hazeMat = hazeMaterial(this.shared);
    this.materials.push(hazeMat);
    this.haze = new THREE.InstancedMesh(cone, hazeMat, Math.max(1, N * G));
    this.haze.count = 0;
    this.haze.frustumCulled = false;
    this.haze.renderOrder = 4;
    this.group.add(this.haze);
    this.hazeIdx = new Int32Array(N * G);
    this.finish(masts, world, t0);
  }

  // lamp glass of the built head (the Meshy bank's glass is in its own material)
  buildGlass(inst, N) {
    const glassGeo = glassGeometry();
    this.glassOn = new THREE.InstancedBufferAttribute(new Float32Array(N), 1);
    glassGeo.setAttribute('aOn', this.glassOn);
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x15181c, roughness: 0.16, metalness: 0.2, emissive: 0xffe4c4, emissiveIntensity: 26,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }); // (stays in front of its housing far away)
    glassMat.onBeforeCompile = (s) => {
      s.uniforms.uGlassOn = this.shared.on;
      s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nattribute float aOn;\nvarying float vOn;\nvarying vec2 vGUv;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvOn = aOn;\nvGUv = uv;');
      s.fragmentShader = s.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uGlassOn;\nvarying float vOn;\nvarying vec2 vGUv;')
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          {
            // rows of LED emitters in a softly lit reflector, brightest in the middle of the glass
            vec2 f = fract(vGUv * vec2(8.0, 5.0)) - 0.5;
            float led = exp(-dot(f, f) * 28.0);
            vec2 c = vGUv - 0.5;
            float body = 1.0 - smoothstep(0.25, 0.5, max(abs(c.x), abs(c.y)));
            totalEmissiveRadiance *= vOn * uGlassOn * (0.3 + 1.4 * led) * (0.45 + 0.55 * body);
          }`);
    };
    this.materials.push(glassMat);
    this.glass = inst(glassGeo, glassMat, N, false);
    this.glass.frustumCulled = false;
  }

  finish(masts, world, t0) {
    // near-light selection (the masts and the street lamps)
    this.grid = new Grid(128);
    masts.forEach((m, i) => this.grid.add(m.x, m.z, m.x, m.z, i));
    for (const l of streetLamps) { this.grid.add(l.x, l.z, l.x, l.z, this.lights.length); this.lights.push(l); }
    this.selI = new Int32Array(PL_MAX + 1);
    this.selD = new Float64Array(PL_MAX + 1);

    // far-field pool map (baked over the next frames) and the shared light uniforms
    const U = terrainUniforms;
    U.uPLColor.value.set(COLOR);
    this.poolMap = new PoolMap(this.lights, world, U.uPLShape.value);
    this.planMs = Math.round(performance.now() - t0);
    this.setOn(0);
    pisteLightsLive = this;
    onQualityChange(() => this.lastBucket.set(1e9, 0, 1e9));
  }

  /** More street lamps (addStreetLamps): into the near-light grid, and the pool map baked again with them. */
  addLamps(lamps) {
    if (!lamps.length) return;
    for (const l of lamps) { this.grid.add(l.x, l.z, l.x, l.z, this.lights.length); this.lights.push(l); }
    this.poolMap.texture?.dispose();
    this.poolMap = new PoolMap(this.lights, this.world, terrainUniforms.uPLShape.value);
    terrainUniforms.uPLMapK.value = 0;
    this.setOn(this.on);
  }

  // switch-on state: masts come on one by one through the dusk (each has its own threshold)
  setOn(on) {
    this.on = on;
    const masts = this.masts;
    let sum = 0;
    for (let i = 0; i < masts.length; i++) {
      const m = masts[i];
      m.on = Math.min(1, Math.max(0, (on - m.th * 0.7) / 0.3));
      sum += m.on;
      for (let k = 0; k < this.G; k++) this.glowOn.array[i * this.G + k] = this.lampLive[i * this.G + k] ? m.on : 0;
    }
    this.glowOn.needsUpdate = true;
    const L = this.lights;
    for (let i = masts.length; i < L.length; i++) { const l = L[i]; l.on = Math.min(1, Math.max(0, (on - l.th * 0.7) / 0.3)); sum += l.on; }
    this.meanOn = L.length ? sum / L.length : 0;
    this.writeOnAttributes();
  }
  writeOnAttributes() {
    if (this.glass) {
      for (let k = 0; k < this.glass.count; k++) this.glassOn.array[k] = this.masts[this.glassIdx[k]].on;
      this.glassOn.needsUpdate = true;
    }
    for (const h of this.heads || []) {
      for (let k = 0; k < h.near.count; k++) h.on.array[k] = this.masts[h.nearIdx[k]].on;
      h.on.needsUpdate = true;
    }
    for (let k = 0; k < this.haze.count; k++) this.hazeOn.array[k] = this.masts[Math.floor(this.hazeIdx[k] / this.G)].on;
    this.hazeOn.needsUpdate = true;
  }

  // LOD buckets and haze cones around the camera (rebuilt after moving ~25 m)
  rebucket(cam) {
    const masts = this.masts, near = this.nearMeshes, far = this.farMesh, heads = this.heads, G = this.G;
    let nn = 0, nf = 0, ng = 0, nh = 0;
    const hm = _hm, v = _v, q = _q2, sc = HAZE_SCALE, Z = AXIS_Z, { nearLod, farLod, beamR } = quality.lights;
    if (heads) for (const h of heads) { h.nn = 0; h.nf = 0; }
    for (let i = 0; i < masts.length; i++) {
      const m = masts[i], d = Math.hypot(m.lx - cam.x, m.ly - cam.y, m.lz - cam.z);
      const T = this.mat.subarray(i * 16, i * 16 + 16), h = heads?.[m.hv];
      if (d < nearLod) {
        for (const n of near) n.instanceMatrix.array.set(T, nn * 16);
        nn++;
        if (h) { h.near.instanceMatrix.array.set(this.headMat.subarray(i * 16, i * 16 + 16), h.nn * 16); h.nearIdx[h.nn++] = i; }
      } else if (d < farLod) {
        far.instanceMatrix.array.set(T, nf * 16);
        nf++;
        if (h) h.far.instanceMatrix.array.set(this.headMat.subarray(i * 16, i * 16 + 16), h.nf++ * 16);
      } else continue;
      if (this.glass) { this.glass.instanceMatrix.array.set(T, ng * 16); this.glassIdx[ng++] = i; }
      if (d < beamR) {
        for (let k = 0; k < G; k++) {
          if (!this.lampLive[i * G + k]) continue;
          v.fromArray(this.lampDir, (i * G + k) * 3);
          q.setFromUnitVectors(Z, v);
          hm.compose(v.fromArray(this.lampPos, (i * G + k) * 3), q, sc);
          hm.toArray(this.haze.instanceMatrix.array, nh * 16);
          this.hazeIdx[nh++] = i * G + k;
        }
      }
    }
    for (const n of near) { n.count = nn; n.instanceMatrix.needsUpdate = true; n.computeBoundingSphere(); }
    far.count = nf; far.instanceMatrix.needsUpdate = true;
    if (heads) {
      for (const h of heads) {
        h.near.count = h.nn; h.near.instanceMatrix.needsUpdate = true; h.near.computeBoundingSphere();
        h.far.count = h.nf; h.far.instanceMatrix.needsUpdate = true;
      }
    }
    if (this.glass) { this.glass.count = ng; this.glass.instanceMatrix.needsUpdate = true; }
    this.haze.count = nh; this.haze.instanceMatrix.needsUpdate = true;
    this.writeOnAttributes();
  }

  update(dt, camera, env) {
    const cam = camera.position, U = terrainUniforms;
    if (!this.poolMap.done && this.poolMap.step(2.5)) {
      U.uPLMap.value = this.poolMap.texture;
      const p = this.poolMap;
      U.uPLMapRect.value.set([p.x0, p.z0, 1 / (p.W * p.texel), 1 / (p.H * p.texel)]);
    }
    if (Math.hypot(cam.x - this.lastBucket.x, cam.y - this.lastBucket.y, cam.z - this.lastBucket.z) > 25) {
      this.lastBucket.copy(cam);
      this.rebucket(cam);
    }
    // on at dusk (night 0.3 -> 0.6), eased, masts staggered
    const target = this.enabled ? smooth(0.3, 0.6, env?.nightFactor ?? 0) : 0;
    let on = this.on + (target - this.on) * Math.min(1, dt * 0.8);
    if (Math.abs(target - on) < 0.01) on = target;
    if (on !== this.on) this.setOn(on);
    const live = this.on > 0.001 && this.lights.length > 0;
    this.shared.on.value = this.on > 0.001 ? 1 : 0;
    this.group.visible = this.masts.length > 0;
    this.glow.visible = live;
    this.haze.visible = live && this.shared.haze.value > 0.02; // (no haze drawn in clear air)
    const P = U.uPLParams.value, Po = objUniforms.uPLoParams.value;
    if (!live) { P[0] = 0; Po[0] = 0; U.uPLMapK.value = 0; return; }

    // the lights nearest the camera light the snow per pixel (sorted by how near their reach comes, distance -
    // range, nearest first: the first OBJ_N also light characters / trees / props); pixels nearer than the first
    // MAST left out reaches are exact, beyond that the baked pool map takes over (a street lamp left out is only
    // missing inside that radius: a small pool far off, and it keeps the masts' exact radius wide)
    const selI = this.selI, selD = this.selD, c = this.grid.cell, R = SEL_R, LIT = Math.min(PL_MAX, quality.lights.lit), lights = this.lights;
    let n = 0, cutM = R - PL_RANGE;
    for (let gi = Math.floor((cam.x - R) / c); gi <= Math.floor((cam.x + R) / c); gi++) {
      for (let gj = Math.floor((cam.z - R) / c); gj <= Math.floor((cam.z + R) / c); gj++) {
        const cell = this.grid.map.get(gi * 100003 + gj);
        if (!cell) continue;
        for (let t = 0; t < cell.length; t++) {
          const m = lights[cell[t]];
          if (m.on <= 0) continue;
          const dd = (m.lx - cam.x) ** 2 + (m.ly - cam.y) ** 2 + (m.lz - cam.z) ** 2;
          if (dd > R * R) continue;
          const d2 = Math.sqrt(dd) - (m.R || PL_RANGE); // (the key: how near its light comes)
          // insertion into the sorted top list (PL_MAX + 1 kept: the first one left out sets the exact radius)
          if (n > LIT && d2 >= selD[LIT]) { if (!m.lamp && d2 < cutM) cutM = d2; continue; }
          if (n > LIT && !lights[selI[LIT]].lamp && selD[LIT] < cutM) cutM = selD[LIT]; // (falls off the list)
          let k = Math.min(n, LIT);
          while (k > 0 && selD[k - 1] > d2) { selD[k] = selD[k - 1]; selI[k] = selI[k - 1]; k--; }
          selD[k] = d2; selI[k] = cell[t];
          if (n <= LIT) n++;
        }
      }
    }
    const count = Math.min(n, LIT), pos = U.uPLPos.value, aim = U.uPLAim.value;
    for (let k = 0; k < count; k++) {
      const m = lights[selI[k]];
      pos[k * 4] = m.lx; pos[k * 4 + 1] = m.ly; pos[k * 4 + 2] = m.lz; pos[k * 4 + 3] = m.I * m.on;
      aim[k * 4] = m.ax; aim[k * 4 + 1] = m.ay; aim[k * 4 + 2] = m.az; aim[k * 4 + 3] = m.ir4;
    }
    if (n > LIT && !lights[selI[LIT]].lamp && selD[LIT] < cutM) cutM = selD[LIT];
    const cut = Math.max(0, cutM);
    this.nearR = cut < this.nearR ? cut : this.nearR + (cut - this.nearR) * Math.min(1, dt * 0.7);
    P[0] = 1; P[1] = count; P[2] = this.nearR; P[3] = 45;
    setLitObjects(count, quality.lights.obj); // (the first OBJ_N also light characters, trees and props)
    U.uPLMapK.value = this.poolMap.done ? MAP_EMAX * this.meanOn : 0;

    // glow size floor (world size of a pixel at 1 m), fog and haze for the sprites and cones
    if (camera.isPerspectiveCamera) this.shared.px.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / Math.max(1, innerHeightSafe());
    const fog = this.scene.fog;
    if (fog) this.shared.fog.value.set(fog.near, fog.far);
    const wet = Math.min(1, (env?.snow ?? 0) + Math.max(0, (env?.mist ?? 0) - 0.1) * 0.5);
    this.shared.wet.value = wet;
    this.shared.haze.value = (0.012 + 0.32 * wet) * this.on;
  }

  // 0..1: how floodlit the snow is at (x, z) right now (0 by day, between pools ~0.3, under a mast 1),
  // e.g. to leave the headlamp off on a lit piste
  litAt(x, z) {
    const p = this.poolMap, data = p.texture?.image.data;
    if (!data || this.on <= 0) return 0;
    const fx = (x - p.x0) / p.texel - 0.5, fz = (z - p.z0) / p.texel - 0.5, i = Math.floor(fx), j = Math.floor(fz);
    if (i < 0 || j < 0 || i >= p.W - 1 || j >= p.H - 1) return 0;
    const tx = fx - i, tz = fz - j, at = (a, b) => data[b * p.W + a] / 255;
    const v = (at(i, j) * (1 - tx) + at(i + 1, j) * tx) * (1 - tz) + (at(i, j + 1) * (1 - tx) + at(i + 1, j + 1) * tx) * tz;
    return Math.min(1, (v * v * MAP_EMAX) / 2.5) * this.meanOn;
  }

  dispose() {
    const U = terrainUniforms;
    U.uPLParams.value[0] = 0; objUniforms.uPLoParams.value[0] = 0; U.uPLMapK.value = 0;
    if (pisteLightsLive === this) pisteLightsLive = null;
    this.scene.remove(this.group);
    this.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    for (const m of this.materials) m.dispose();
    this.poolMap.texture?.dispose();
  }
}

const innerHeightSafe = () => (typeof innerHeight === 'number' ? innerHeight : 900);
const _hm = new THREE.Matrix4(), _v = new THREE.Vector3(), _q2 = new THREE.Quaternion();
const HAZE_SCALE = new THREE.Vector3(6, 6, 11), AXIS_Z = new THREE.Vector3(0, 0, 1);
