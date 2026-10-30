// World heightfield: an infinite alpine landscape with a valley village at the origin,
// a big main ski mountain to the north (-Z), three more resort peaks around the village (MASSIFS),
// and endless ridged mountain ranges beyond.
// Features (flat pads for buildings/stations, groomed piste corridors) are layered on top.
import { Simplex, smoothstep, lerp, clamp } from '../core/noise.js';
import { wolkenspitzeHeight } from './wolkenspitze.js';
import { legacyPeakHeight } from './legacypeak.js';

export const SEED = 7331;
const N = new Simplex(SEED);
const N2 = new Simplex(SEED + 101);

export const MAIN_SUMMIT = { x: 0, z: -2350 };
export const VILLAGE_R = 230;
// Legacy Valley: winding center line (the floor is 450 m either side of it) and the endless descent
export const valleyCenter = (z) => (280 * Math.sin(z / 2600) + 120 * Math.sin(z / 900)) * smoothstep(0, 1500, z);
function descent(z) {
  const t = z - 200;
  return t > 0 ? -0.17 * t * smoothstep(0, 450, t) : 0;
}
// the gondola top station area stays a smooth, skiable shoulder
const CROWN_CLEAR = { x: 10, z: -2120 };

// Resort peaks around Legacy Village. Each is its own alpine massif built around its gondola:
// a broad dome whose shoulder carries the top station, a long smooth ski face falling toward the
// gondola base, a rocky summit horn (crown + cliff bands) rising behind the station, and flanks
// that merge into the surrounding ranges as ridges.
//   base / top    foot of the ski face + the gondola's top station (the face runs from top toward base); the
//                 gondola starts at the base, or, for the two village gondolas, by the plaza (layout.js PEAKS)
//   h             dome height above its surroundings (m); the top station sits near its crest
//   rFace / rBack / rLeft / rRight   dome radii down the face, behind the crest and to either side
//                 (left/right as seen looking down the face)
//   horn          summit pyramid { back: distance behind the dome crest, h, r }
//   crown         height of the crown's ridges      bowl  half-width of the crown-free ski bowl
//   apron         distance over which the face's foot settles into the village plateau
//   foot          grade of the ramp on which the massif comes down onto the Legacy Valley floor
export const MASSIFS = [
  { id: 'adlerhorn', name: 'Adlerhorn', base: { x: 223.6, z: -17.0 }, top: { x: 2290, z: -560 },
    h: 760, rFace: 1700, rBack: 760, rLeft: 820, rRight: 760, horn: { back: 380, h: 500, r: 440 }, crown: 300, bowl: 430, apron: 900, foot: 0.42 },
  { id: 'silberhorn', name: 'Silberhorn', base: { x: -221.0, z: 64.6 }, top: { x: -2300, z: -215 },
    h: 820, rFace: 1600, rBack: 740, rLeft: 760, rRight: 820, horn: { back: 360, h: 440, r: 420 }, crown: 300, bowl: 420, apron: 900, foot: 0.42 },
  { id: 'sonnenkopf', name: 'Sonnenkopf', base: { x: 505, z: 1545 }, top: { x: 2330, z: 2290 },
    h: 760, rFace: 1700, rBack: 740, rLeft: 820, rRight: 1000, horn: { back: 340, h: 420, r: 400 }, crown: 270, bowl: 400, apron: 0, foot: 0.44 },
];
const Q_CUT = 4.6; // a massif's influence ends where its dome has fallen to 1% (exactly zero beyond)
for (const m of MASSIFS) {
  const dx = m.base.x - m.top.x, dz = m.base.z - m.top.z, l = Math.hypot(dx, dz);
  m.fx = dx / l; m.fz = dz / l; // face direction (downhill, toward the base)
  m.faceLen = l;
  // the station sits ~0.33 dome radii below the crest (90% of the dome height)
  const crest = 0.3246 * m.rFace;
  m.x = m.top.x - m.fx * crest; m.z = m.top.z - m.fz * crest;                            // dome centre
  m.hx = m.x - m.fx * m.horn.back; m.hz = m.z - m.fz * m.horn.back;                       // summit horn
  m.kFace = 1 / (m.rFace * m.rFace); m.kBack = 1 / (m.rBack * m.rBack); m.kLeft = 1 / (m.rLeft * m.rLeft); m.kRight = 1 / (m.rRight * m.rRight);
  m.kHorn = 1 / (m.horn.r * m.horn.r);
  m.seed = (m.top.x * 0.013 + m.top.z * 0.007) % 97; // per-peak noise offset
  m.stationSlope = 2 * m.h * crest * m.kFace * 0.9; // natural face grade at the station (for the shoulder)
}

const CELL = 64; // corridor spatial grid

// noise octaves a band-limited sample can represent (spacing > 0: a coarse LOD mesh drops finer octaves)
const oct = (lambda, full, spacing) => spacing > 0 ? Math.min(full, Math.max(0, Math.log2(lambda / (4 * spacing)) + 1)) : full;

class World {
  constructor() {
    this.pads = [];
    this.padGrid = new Map(); // 256m cells -> pads
    this.corridorGrid = new Map(); // 64m cells -> segments
    this.featureProviders = [];
    this.regions = [];
    this.surfaceGrid = new Map(); // 64m cells -> surfaces
    this.cuts = []; // local terrain shaping (see addCut)
    this.cutBox = { minx: 0, minz: 0, maxx: -1, maxz: -1 };
    this.meshCache = new Map(); // meshHeight: 2 m grid vertex -> height
    this.meshCacheOld = new Map();
  }

  // ---------------- regions: purpose-built maps (e.g. the World Racing courses) ----------------
  // A region owns the terrain inside its bounds:
  //   { id, bounds: { minx, minz, maxx, maxz }, height(x, z, spacing, world) -> number,
  //     forest?(x, z, h, slope) -> 0..1 }
  // region.height should blend back to world.baseHeight near its own edges.
  addRegion(region) { this.regions.push(region); this.clearMeshCache(); return region; }
  regionAt(x, z, margin = 0) {
    for (let i = 0; i < this.regions.length; i++) {
      const b = this.regions[i].bounds;
      if (x >= b.minx - margin && x <= b.maxx + margin && z >= b.minz - margin && z <= b.maxz + margin) return this.regions[i];
    }
    return null;
  }

  // ---------------- walkable surfaces above the terrain (kickers, bridge decks...) ----------------
  // surface = { bounds: { minx, minz, maxx, maxz }, height(x, z) -> number | null, over?(x, z) -> number }
  // height returns the absolute surface height at (x, z), or null when (x, z) is not over it. over (optional): a
  // height above which you are always on top of it, however far below its surface you are (a tunnel's mountain:
  // anyone over the tube's crown is on the mountain, never dropped into the trench under it).
  addSurface(surf) {
    const b = surf.bounds;
    for (let cx = Math.floor(b.minx / CELL); cx <= Math.floor(b.maxx / CELL); cx++) {
      for (let cz = Math.floor(b.minz / CELL); cz <= Math.floor(b.maxz / CELL); cz++) {
        const key = cx + ',' + cz;
        let arr = this.surfaceGrid.get(key);
        if (!arr) this.surfaceGrid.set(key, (arr = []));
        arr.push(surf);
      }
    }
    return surf;
  }
  // A walkable structure along a line (a railway's track bed, its viaducts' decks): `height(x, z)` for the whole line,
  // registered as one surface per `chunk` m of it (bounds: that stretch's points +- `margin`), so the 64 m surface grid
  // only asks it near the line. at(s, out) -> { x, z } on the centre line.
  addLineSurface(at, length, height, { chunk = 200, margin = 14, step = 10 } = {}) {
    const p = {}, out = [];
    for (let s0 = 0; s0 < length; s0 += chunk) {
      let minx = Infinity, minz = Infinity, maxx = -Infinity, maxz = -Infinity;
      for (let s = s0; s <= Math.min(length, s0 + chunk) + 1e-6; s += step) {
        at(Math.min(s, length), p);
        minx = Math.min(minx, p.x); maxx = Math.max(maxx, p.x); minz = Math.min(minz, p.z); maxz = Math.max(maxz, p.z);
      }
      out.push(this.addSurface({ bounds: { minx: minx - margin, minz: minz - margin, maxx: maxx + margin, maxz: maxz + margin }, height }));
    }
    return out;
  }
  removeSurface(surf) {
    for (const arr of this.surfaceGrid.values()) {
      const i = arr.indexOf(surf);
      if (i >= 0) arr.splice(i, 1);
    }
  }

  // Height a skier stands on: the terrain, or the highest surface that is not far above `yHint`
  // (so you ride onto a ramp or bridge from its own level, but fall past a bridge from below it).
  // The terrain's surface as the near terrain mesh draws it: its 2 m grid of exact heights (terrain.js buildNode on a
  // 128 m node: spacing 2, sampled at spacing 0), triangulated the same way (diagonal from (i+1, j) to (i, j+1)). Between
  // the vertices the mesh is flat, the analytic height is not: in a hollow, at the foot of a cutting's wall or a
  // portal's rock cut the drawn snow lies above world.height (up to tens of cm in the fine noise, metres at a wall),
  // and feet set on world.height sank into it (Oct 28, the user: "you sink through the floor at some places").
  // Vertex heights are cached (cleared whenever the terrain's features change).
  meshHeight(x, z) {
    const fx = x * 0.5, fz = z * 0.5, i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
    const V = (a, b) => this.meshVertex(a, b);
    const hb = V(i + 1, j), hc = V(i, j + 1);
    if (tx + tz <= 1) { const ha = V(i, j); return ha + (hb - ha) * tx + (hc - ha) * tz; }
    const hd = V(i + 1, j + 1);
    return hd + (hc - hd) * (1 - tx) + (hb - hd) * (1 - tz);
  }

  // one vertex of that 2 m grid, world.height(2a, 2b), cached (world/groundpatch.js lays paving on the same vertices)
  // (two generations of 80 k: when the newer fills up it becomes the older one, so a road being built never loses the
  // vertices it just read, as it did when the whole cache was dropped at once)
  meshVertex(a, b) {
    const k = (a + 1048576) * 2097152 + (b + 1048576);
    let h = this.meshCache.get(k);
    if (h === undefined) {
      h = this.meshCacheOld.get(k);
      if (h === undefined) h = this.height(a * 2, b * 2);
      if (this.meshCache.size >= 80000) { this.meshCacheOld = this.meshCache; this.meshCache = new Map(); }
      this.meshCache.set(k, h);
    }
    return h;
  }
  clearMeshCache() { this.meshCache.clear(); this.meshCacheOld.clear(); }

  groundHeight(x, z, yHint = Infinity) {
    let h = this.meshHeight(x, z);
    // on a road: the road's own smooth surface (drawn from the exact height), not the 2 m terrain triangles, which
    // go lumpy at its edges where the cuttings and embankments start (Oct 28, the user: "at some places of the
    // road you bounce up and down, next to the guard rails"); roads.js sets roadSurface once the roads are planned
    if (this.roadSurface) { const r = this.roadSurface(x, z, h); if (r !== null) h = r; }
    const arr = this.surfaceGrid.get(Math.floor(x / CELL) + ',' + Math.floor(z / CELL));
    if (arr) {
      for (let i = 0; i < arr.length; i++) {
        const sf = arr[i], hs = sf.height(x, z);
        if (hs !== null && hs > h && (hs <= yHint + 0.6 || (sf.over && yHint > sf.over(x, z)))) h = hs;
      }
    }
    return h;
  }
  groundNormal(x, z, yHint, out) {
    const e = 0.35;
    const hx = this.groundHeight(x + e, z, yHint) - this.groundHeight(x - e, z, yHint);
    const hz = this.groundHeight(x, z + e, yHint) - this.groundHeight(x, z - e, yHint);
    out.set(-hx, 2 * e, -hz).normalize();
    return out;
  }

  // ---------------- crag mask: no rock bands on the resort's pistes and race courses ----------------
  // mask = { x0, z0, cell, nx, nz, d: Float32Array(nx * nz) }: distance (m) from each grid node to the
  // nearest groomed run's edge (capped). The layout sets it once, after laying out its runs and before
  // any terrain is built; bands fade in from 40 m to 55 m beyond a run's edge.
  setCragMask(mask) { this.cragMask = mask; }
  cragAllow(x, z) {
    const m = this.cragMask;
    const fx = (x - m.x0) / m.cell, fz = (z - m.z0) / m.cell;
    if (fx < 0 || fz < 0 || fx >= m.nx - 1 || fz >= m.nz - 1) return 1;
    const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j, k = j * m.nx + i, D = m.d;
    const dd = (D[k] + (D[k + 1] - D[k]) * tx) * (1 - tz) + (D[k + m.nx] + (D[k + m.nx + 1] - D[k + m.nx]) * tx) * tz;
    return smoothstep(40, 55, dd);
  }

  // ---------------- base terrain (no features) ----------------
  // spacing > 0 = sample band-limited for a coarse LOD mesh (drops octaves it can't represent)
  baseHeight(x, z, spacing = 0) {
    const d = Math.sqrt(x * x + z * z);
    // Resort zone (main mountain face) keeps the big ridges calmer so it's skiable.
    const zx = x / 900, zz = (z + 1250) / 1650;
    const inZone = 1 - smoothstep(0.65, 1.25, Math.sqrt(zx * zx + zz * zz));
    const range = smoothstep(240, 1150, d); // real peaks rise close around the valley

    // Domain warp for natural, non-grid ridges
    const wx = x + N2.fbm(x * 0.0004, z * 0.0004, 3) * 600;
    const wz = z + N2.fbm(x * 0.0004 + 31.7, z * 0.0004 - 12.3, 3) * 600;
    const rid = N.ridged(wx * 0.00019 + 11.3, wz * 0.00019 - 7.1, Math.max(1, oct(5200, 6, spacing)), 2.0, 0.34, 6);
    const big = N.fbm(wx * 0.00021 - 3.3, wz * 0.00021 + 5.2, 3) * 0.5 + 0.5;
    // The Legacy Valley: south of the village an endless valley keeps descending, so there is always
    // a way further down. Inside it the big ranges are calmed to rolling slopes.
    // valley = 1 on the valley floor; vMouth = 1 south of the village, where the valley has begun
    const vcDist = Math.abs(x - valleyCenter(z)), vMouth = smoothstep(-150, 240, z);
    const valley = (1 - smoothstep(450, 1100, vcDist)) * smoothstep(40, 240, z);

    // Main ski mountain footprint (also keeps the resort peaks off its pistes)
    const mx = (x - MAIN_SUMMIT.x) * 1.15, mz = z - MAIN_SUMMIT.z;
    const md2 = mx * mx + mz * mz;
    const mainG = Math.exp(-md2 / (1500 * 1500));
    const protect = 1 - smoothstep(0.12, 0.3, mainG); // resort peaks stay off the main mountain

    // Resort peaks: only points inside a massif's footprint pay for it (cheap elliptical reject)
    let pk = null, pkH = 0, pkFade = 0, pkCalm = 0, pkBowl = 0, pkCrown = 0, pkBand = 0;
    for (let i = 0; i < MASSIFS.length; i++) {
      const m = MASSIFS[i];
      const dx = x - m.x, dz = z - m.z;
      const a = dx * m.fx + dz * m.fz, b = dz * m.fx - dx * m.fz;
      let q = a * a * (a > 0 ? m.kFace : m.kBack) + b * b * (b > 0 ? m.kRight : m.kLeft);
      if (q * (a > 0 ? 0.85 : 0.7) >= Q_CUT) continue; // (the outline noise below scales q by 0.85..1.15 / 0.7..1.3)
      // irregular outline: spurs and gullies on the flanks (the ski face stays smoother)
      q *= 1 + 0.3 * N.noise(x * 0.0011 + m.seed, z * 0.0011 - m.seed) * (a > 0 ? 0.5 : 1);
      if (q >= Q_CUT) continue;
      let fade = (1 - smoothstep(Q_CUT * 0.4, Q_CUT, q)) * protect;
      if (m.apron) fade *= smoothstep(VILLAGE_R * 0.6, VILLAGE_R * 0.6 + m.apron, d); // the foot settles into the village
      const hx = x - m.hx, hz = z - m.hz, hq = (hx * hx + hz * hz) * m.kHorn;
      let g = (m.h * Math.exp(-q) + (hq < 12 ? m.horn.h * Math.exp(-hq) : 0)) * fade; // (horn < 1 cm beyond 3.5 radii)
      // toward the Legacy Valley the massif comes down a steady ramp onto the valley floor (a smooth min,
      // exactly zero on the floor itself, so the endless descent is untouched)
      const ramp = Math.max(0, vcDist - 450) * m.foot + (1 - vMouth) * 4000;
      if (g > ramp - 50) { const k = Math.max(0, 50 - Math.abs(g - ramp)); g = Math.max(0, Math.min(g, ramp) - k * k / 200); }
      if (g > pkH) { pk = m; pkH = g; pkFade = fade; }
    }
    if (pk) {
      const rel = pkH / pk.h;
      pkFade *= smoothstep(0, 80, pkH); // every effect fades out with the massif itself
      // frame of the ski face: u downhill from the top station, v across it
      const tx = x - pk.top.x, tz = z - pk.top.z;
      const u = tx * pk.fx + tz * pk.fz, v = Math.abs(tz * pk.fx - tx * pk.fz);
      // the ski bowl below the top station stays smooth snow; it widens downhill
      const spread = v - u * 0.2;
      if (u > -350 && u < pk.faceLen + 250 && spread < pk.bowl + 500) {
        const end = 1 - smoothstep(pk.faceLen - 250, pk.faceLen + 250, u); // the face ends at the base
        pkBowl = smoothstep(-160, 40, u) * (1 - smoothstep(pk.bowl, pk.bowl + 260, spread)) * end * pkFade;
        // the face sector, where the surrounding ranges get calmed (they still frame its sides as ridges)
        pkCalm = smoothstep(-350, 0, u) * (1 - smoothstep(pk.bowl + 100, pk.bowl + 500, spread)) * end * pkFade * (1 - (1 - smoothstep(450, 1300, vcDist)) * vMouth);
      }
      if (rel > 0.28 && pkBowl < 1) {
        const clear = smoothstep(140, 320, Math.sqrt(tx * tx + tz * tz)); // the station area stays clear
        pkCrown = smoothstep(0.42, 0.8, rel) * (1 - pkBowl) * clear;
        // layered rock bands on the upper flanks around the bowl
        pkBand = smoothstep(0.28, 0.6, rel) * (1 - pkBowl) * clear;
      }
      // shoulder: the face just below the top station is filled into a flat terrace, spread out downhill
      if (u > -120 && u < 1000 && v < 260) pkH += pk.stationSlope * 130 * smoothstep(-120, 70, u) * (1 - smoothstep(70, 1000, u)) * (1 - smoothstep(110, 260, v)) * pkFade;
    }
    let mountains = (Math.pow(rid, 1.7) * 1150 + big * 650) * range * (1 - 0.82 * inZone) * (1 - 0.985 * valley);
    if (pkCalm > 0) mountains *= 1 - 0.88 * pkCalm;

    // Main ski mountain: broad massif with a gentle shoulder toward the village
    let mainM = 1000 * mainG + 160 * Math.exp(-md2 / (420 * 420));
    mainM *= 1 - smoothstep(0, 450, z); // its foot ends at the village; the valley falls away to the south
    // rocky crown: sharp ridges and summits on the upper massif (like a real alpine peak), leaving a
    // skiable shoulder around the gondola top station
    const cx = x - CROWN_CLEAR.x, cz = z - CROWN_CLEAR.z;
    const crownMask = smoothstep(0.42, 0.85, mainM / 1160) * smoothstep(170, 420, Math.sqrt(cx * cx + cz * cz));
    if (crownMask > 0 || pkCrown > 0.002) {
      const cr = Math.pow(N2.ridged(x * 0.0011 + 5.3, z * 0.0011 - 3.7, Math.max(1, oct(900, 5, spacing)), 2.0, 0.45, 5), 1.5);
      mainM += cr * 430 * crownMask;
      pkH += cr * (pk ? pk.crown : 0) * pkCrown;
    }

    // Smooth max so the massif melts into the surrounding range
    const k = 220;
    const hmax = Math.max(mountains, mainM);
    // (the smooth-max bump is dropped toward the valley so its mouth falls away instead of forming a rim)
    let hblend = hmax + Math.max(0, k - Math.abs(mountains - mainM)) ** 2 * 0.25 / k * (1 - smoothstep(0, 400, z));
    if (pkH > 0) {
      const kp = 160 * pkFade, dd = Math.abs(hblend - pkH);
      hblend = Math.max(hblend, pkH) + (kp > dd ? (kp - dd) * (kp - dd) * 0.25 / kp : 0);
    }

    let h = hblend;
    // Rock bands: only a few broken, irregular bands of cliff and snow ledge, high on the summit crowns and
    // the highest crags -- never a regular staircase over a whole face (the faces themselves stay natural
    // steep rock and snow; the terrain shader draws the strata). They come in patches, vary in thickness and
    // strength along their length, and none come near the resort's pistes and race courses (crag mask).
    // Coarse LOD meshes can't represent the bands, so they fade out there to keep LODs consistent.
    if (spacing < 40) {
      let crag = Math.max(crownMask * crownMask, pkCrown * pkCrown * 0.85, pkBand * 0.2);
      if (hblend > 800 && rid > 0.5) crag = Math.max(crag, smoothstep(800, 1250, hblend) * smoothstep(0.5, 0.85, rid) * (1 - valley) * (1 - pkBowl));
      if (crag > 0.01) {
        // patches (~1 km apart) and broken stretches within them
        crag *= smoothstep(0.18, 0.55, N2.noise(x * 0.0019 + 7.7, z * 0.0019 - 3.1)) * 0.6 * (1 - smoothstep(12, 40, spacing));
        if (crag > 0.01 && this.cragMask) crag *= this.cragAllow(x, z);
        if (crag > 0.01) {
          crag *= 0.55 + 0.45 * smoothstep(-0.35, 0.35, N.noise(x * 0.0061 - 2.9, z * 0.0061 + 8.3));
          const wob = N2.noise(x * 0.004, z * 0.004) * 16 + N2.noise(x * 0.017, z * 0.017) * 5;
          const band = 21 + N.noise(x * 0.0007, z * 0.0007) * 9;
          const tt = (hblend + wob) / band, i = Math.floor(tt), f = tt - i;
          // the riser takes most of each band (rock steps, not vertical walls), the ledge the rest
          const terr = (i + smoothstep(0.38, 0.96, f)) * band - wob;
          h = lerp(hblend, terr, crag);
        }
      }
    }
    // Medium undulations (rolls, bowls) and fine snow surface variation (gentler rolls on the peaks' ski bowls)
    h += N.fbm(x * 0.0035 + 2.1, z * 0.0035 - 9.4, oct(285, 4, spacing), 2, 0.5, 4) * (6 + 12 * range) * (1 - 0.88 * valley) * (1 - 0.5 * pkBowl);
    // the whole world south of the village tilts downhill (~9 degrees), forever
    h += descent(z);
    if (spacing < 10) h += (N2.noise(x * 0.025, z * 0.025) * 0.9 + N2.noise(x * 0.09, z * 0.09) * 0.18) * (1 - 0.6 * valley);

    // the Wolkenspitze, the big glacier mountain north-east of the village (wolkenspitze.js)
    h = wolkenspitzeHeight(x, z, h, spacing);

    // Gentle shoulder around the gondola top station (where real resorts put their summit station)
    const sd = Math.sqrt(cx * cx + cz * cz);
    if (sd < 260 && !this._shoulderLock) {
      if (this._shoulderH === undefined) {
        this._shoulderLock = true;
        this._shoulderH = this.baseHeight(CROWN_CLEAR.x, CROWN_CLEAR.z);
        this._shoulderLock = false;
      }
      const k2 = 1 - smoothstep(120, 260, sd);
      h = lerp(h, this._shoulderH + (h - this._shoulderH) * 0.3, k2);
    }
    // Valley floor: the village sits on a flat plateau
    const vf = smoothstep(VILLAGE_R * 0.7, VILLAGE_R * 3.4, d); // gentle rise out of the valley, no cliff ring
    h = lerp(N2.noise(x * 0.01, z * 0.01) * 0.6, h, vf);
    // Legacy Peak, the 4,000 m mountain behind the main mountain (legacypeak.js; _noPeak: the ground without it, for
    // the Legacy Express's profile, which runs straight through under it)
    if (!this._noPeak) h = legacyPeakHeight(x, z, h, spacing);
    return h;
  }

  // ---------------- features ----------------
  addPad(pad) {
    // pad: { x, z, r (flat radius), blend (falloff), h (optional fixed height) }
    // use the already-shaped height so a pad inside another pad's influence agrees with it
    if (pad.h === undefined) pad.h = this.height(pad.x, pad.z);
    pad.blend ??= pad.r;
    // on a slope, widen the blend so the cut/fill embankment stays a gentle snow slope (no rock walls)
    let maxDiff = 0;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2, rr = pad.r + pad.blend;
      maxDiff = Math.max(maxDiff, Math.abs(this.height(pad.x + Math.cos(a) * rr, pad.z + Math.sin(a) * rr) - pad.h));
    }
    pad.blend = Math.min(60, Math.max(pad.blend, maxDiff * 3.2));
    this.pads.push(pad);
    this.clearMeshCache();
    const R = pad.r + pad.blend;
    for (let cx = Math.floor((pad.x - R) / 256); cx <= Math.floor((pad.x + R) / 256); cx++) {
      for (let cz = Math.floor((pad.z - R) / 256); cz <= Math.floor((pad.z + R) / 256); cz++) {
        const key = cx + ',' + cz;
        let arr = this.padGrid.get(key);
        if (!arr) this.padGrid.set(key, (arr = []));
        arr.push(pad);
      }
    }
    return pad;
  }

  // points: [[x,z], ...], width: half-width in meters, kind: 'piste' | 'race' | 'lift'
  addCorridor(points, width, kind, meta = null) {
    for (let i = 0; i < points.length - 1; i++) {
      const [ax, az] = points[i], [bx, bz] = points[i + 1];
      const seg = { ax, az, bx, bz, w: width, kind, meta };
      const minx = Math.min(ax, bx) - width - 40, maxx = Math.max(ax, bx) + width + 40;
      const minz = Math.min(az, bz) - width - 40, maxz = Math.max(az, bz) + width + 40;
      for (let cx = Math.floor(minx / CELL); cx <= Math.floor(maxx / CELL); cx++) {
        for (let cz = Math.floor(minz / CELL); cz <= Math.floor(maxz / CELL); cz++) {
          const key = cx + ',' + cz;
          let arr = this.corridorGrid.get(key);
          if (!arr) this.corridorGrid.set(key, (arr = []));
          arr.push(seg);
        }
      }
    }
  }

  // Returns signed info about the nearest corridor: { d: distance minus half-width, kind, dx, dz }
  corridorAt(x, z, out = { d: 1e9, kind: null, dx: 0, dz: 1, groomed: false }) {
    out.d = 1e9; out.kind = null; out.groomed = false;
    const arr = this.corridorGrid.get(Math.floor(x / CELL) + ',' + Math.floor(z / CELL));
    if (!arr) return out;
    for (let i = 0; i < arr.length; i++) {
      const s = arr[i];
      const ex = s.bx - s.ax, ez = s.bz - s.az;
      const l2 = ex * ex + ez * ez || 1;
      const t = clamp(((x - s.ax) * ex + (z - s.az) * ez) / l2, 0, 1);
      const px = s.ax + ex * t - x, pz = s.az + ez * t - z;
      const d = Math.sqrt(px * px + pz * pz) - s.w;
      if (d < out.d) {
        out.d = d; out.kind = s.kind;
        const il = 1 / Math.sqrt(l2);
        out.dx = ex * il; out.dz = ez * il;
        out.groomed = s.kind !== 'lift';
      }
    }
    return out;
  }

  // 0..1: how much a point is inside a flattened pad (stations, huts, race starts)
  padInfluence(x, z) {
    const pads = this.padGrid.get(Math.floor(x / 256) + ',' + Math.floor(z / 256));
    if (!pads) return 0;
    let m = 0;
    for (const p of pads) {
      const d = Math.hypot(x - p.x, z - p.z);
      if (d < p.r + p.blend) m = Math.max(m, 1 - smoothstep(p.r, p.r + p.blend, d));
    }
    return m;
  }

  ensureFeatures(minx, minz, maxx, maxz) {
    for (const p of this.featureProviders) p(minx, minz, maxx, maxz);
  }

  // ---------------- cuts: local terrain shaping (tunnel trenches, couloirs, shaped trails) ----------------
  // A cut reshapes the terrain inside its bounds, after the regions and pads (builders: world/secrets.js):
  //   cut = { bounds: { minx, minz, maxx, maxz }, apply(x, z, h, spacing) -> h, forest?(x, z, f) -> f, covered? }
  // apply gets the height so far (earlier cuts included) and returns the new one; forest may change the forest
  // density there. A `covered` cut lies under a lid mesh (a tunnel's trench): coarse LOD meshes (spacing > 3)
  // and outsideHeight skip it, so from afar and on the lid the mountain looks intact. Physics, trees and the
  // fine terrain mesh (2 m) see every cut. Register cuts before the terrain near them is built.
  addCut(cut) {
    this.cuts.push(cut);
    this.clearMeshCache();
    const B = this.cutBox, b = cut.bounds, first = this.cuts.length === 1;
    B.minx = first ? b.minx : Math.min(B.minx, b.minx); B.minz = first ? b.minz : Math.min(B.minz, b.minz);
    B.maxx = first ? b.maxx : Math.max(B.maxx, b.maxx); B.maxz = first ? b.maxz : Math.max(B.maxz, b.maxz);
    return cut;
  }
  removeCut(cut) {
    const i = this.cuts.indexOf(cut);
    if (i >= 0) this.cuts.splice(i, 1);
    this.clearMeshCache();
  }
  applyCuts(x, z, h, spacing) {
    const B = this.cutBox;
    if (x < B.minx || x > B.maxx || z < B.minz || z > B.maxz) return h;
    const skipCovered = this._outside || spacing > 3;
    for (let i = 0; i < this.cuts.length; i++) {
      const c = this.cuts[i], b = c.bounds;
      if (x < b.minx || x > b.maxx || z < b.minz || z > b.maxz || (c.covered && skipCovered)) continue;
      h = c.apply(x, z, h, spacing);
    }
    return h;
  }
  // the terrain as seen from outside: every cut except the covered ones (a tunnel's lid follows this)
  outsideHeight(x, z, spacing = 0) {
    this._outside = true;
    try { return this.height(x, z, spacing); } finally { this._outside = false; }
  }

  // ---------------- final height ----------------
  height(x, z, spacing = 0) {
    const region = this.regions.length ? this.regionAt(x, z) : null;
    let h = region ? region.height(x, z, spacing, this) : this.baseHeight(x, z, spacing);
    const pads = this.padGrid.get(Math.floor(x / 256) + ',' + Math.floor(z / 256));
    if (pads) {
      for (let i = 0; i < pads.length; i++) {
        const p = pads[i];
        const d = Math.hypot(x - p.x, z - p.z);
        if (d < p.r + p.blend) h = lerp(p.h, h, smoothstep(p.r, p.r + p.blend, d));
      }
    }
    return this.cuts.length ? this.applyCuts(x, z, h, spacing) : h;
  }

  normal(x, z, out) {
    const e = 0.75;
    const hx = this.height(x + e, z) - this.height(x - e, z);
    const hz = this.height(x, z + e) - this.height(x, z - e);
    out.set(-hx, 2 * e, -hz).normalize();
    return out;
  }

  gradient(x, z, base = false, e = 2) {
    const f = base ? this.baseHeight.bind(this) : this.height.bind(this);
    return [(f(x + e, z) - f(x - e, z)) / (2 * e), (f(x, z + e) - f(x, z - e)) / (2 * e)];
  }

  // Forest density 0..1 (used by vegetation and distant terrain tint)
  forest(x, z, h, slope) {
    const region = this.regions.length ? this.regionAt(x, z) : null;
    let f;
    if (region?.forest) f = region.forest(x, z, h, slope);
    else {
      const n = N2.fbm(x * 0.0022 + 40, z * 0.0022 - 17, 3) * 0.5 + 0.5;
      const tl = 520 + N.noise(x * 0.001, z * 0.001) * 90; // treeline (relative altitude)
      const alt = 1 - smoothstep(tl - 120, tl, h);
      const steep = 1 - smoothstep(0.7, 1.1, slope);
      const nearVillage = smoothstep(VILLAGE_R * 0.9, VILLAGE_R * 1.6, Math.hypot(x, z));
      f = clamp((n - 0.38) * 2.6, 0, 1) * alt * steep * nearVillage;
    }
    // the cuts thin the forest inside a course's region too (the railways' formations run through the regions round
    // the courses: before, trees stood on the Legacy Express's tracks there)
    if (this.cuts.length && x >= this.cutBox.minx && x <= this.cutBox.maxx && z >= this.cutBox.minz && z <= this.cutBox.maxz) {
      for (const c of this.cuts) { const b = c.bounds; if (c.forest && x >= b.minx && x <= b.maxx && z >= b.minz && z <= b.maxz) f = c.forest(x, z, f); }
    }
    return f;
  }
}

export const world = new World();
