// Outfits: recolour the Meshy skiers' baked albedo per garment zone (jacket + accent, trousers +
// accent, helmet, goggle lens) inside the character's own material, keeping every fold, seam and
// baked shadow of the original texture. Zones are found automatically once per character model:
// the albedo is clustered into colours (OKLab), each cluster gets a role per body region (from the
// skinned bind pose: bones + height bands), and a per-vertex attribute marks where each garment may
// be. The fragment shader re-classifies every texel against the clusters (so logos, zips, skin and
// straps keep their colours) and remaps the garment colours in OKLab, lightness ratio preserved.
import * as THREE from 'three';

// ---------------------------------------------------------------- colour math (OKLab)

const srgbToLin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const linToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const SRGB_LUT = new Float32Array(256).map((_, i) => srgbToLin(i / 255));

/** Linear sRGB -> OKLab (writes [L, a, b] into out). */
export function linToLab(r, g, b, out = [0, 0, 0]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  out[0] = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  out[1] = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  out[2] = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return out;
}

/** OKLab -> linear sRGB (unclamped). */
export function labToLin(L, a, b, out = [0, 0, 0]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  out[0] = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  out[1] = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  out[2] = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return out;
}

/** '#rrggbb' / 0xrrggbb -> OKLab. */
export function hexToLab(hex) {
  const v = typeof hex === 'string' ? parseInt(hex.replace('#', ''), 16) : hex;
  return linToLab(SRGB_LUT[(v >> 16) & 255], SRGB_LUT[(v >> 8) & 255], SRGB_LUT[v & 255]);
}

export function labToHex(L, a, b) {
  const c = labToLin(L, a, b).map((x) => Math.round(Math.min(1, Math.max(0, linToSrgb(Math.max(0, x)))) * 255));
  return '#' + c.map((x) => x.toString(16).padStart(2, '0')).join('');
}

// Clustering space: lightness counts less than hue/chroma (folds and baked shadows change lightness
// far more than they change the dye), so a garment stays one cluster from its highlights to its folds.
export const WL = 0.42;
const toQ = (lab, out) => { out[0] = lab[0] * WL; out[1] = lab[1]; out[2] = lab[2]; return out; };

// ---------------------------------------------------------------- body parts

const G_HEAD = 0, G_NECK = 1, G_TORSO = 2, G_ARM = 3, G_HAND = 4, G_HIPS = 5, G_LEG = 6, G_FOOT = 7, NG = 8;
function boneGroup(name) {
  const n = name.toLowerCase();
  if (/hand|thumb|index|middle|ring|pinky|finger/.test(n)) return G_HAND;
  if (/foot|toe/.test(n)) return G_FOOT;
  if (/head/.test(n)) return G_HEAD;
  if (/neck/.test(n)) return G_NECK;
  if (/forearm|arm/.test(n)) return G_ARM;
  if (/upleg|leg|thigh|knee|calf|shin/.test(n)) return G_LEG;
  if (/hips|pelvis/.test(n)) return G_HIPS;
  return G_TORSO; // spine, chest, shoulders / clavicles
}

// ---------------------------------------------------------------- zone analysis

const ROLE_NONE = 0, ROLE_PRIMARY = 1, ROLE_ACCENT = 2;
export const MAX_CLUSTERS = 12;

const setMinus = (a, b) => new Set([...a].filter((x) => !b.has(x)));

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/** Bilinear albedo lookup -> linear RGB. pixels: { data (RGBA bytes), width, height }; uv not flipped (glTF). */
function sampleLin(px, u, v, out) {
  const W = px.width, H = px.height, d = px.data;
  const x = Math.min(W - 1.001, Math.max(0, (u - Math.floor(u)) * W - 0.5)), y = Math.min(H - 1.001, Math.max(0, (v - Math.floor(v)) * H - 0.5));
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
  const i00 = (y0 * W + x0) * 4, i10 = i00 + 4, i01 = i00 + W * 4, i11 = i01 + 4;
  for (let c = 0; c < 3; c++) {
    const a = SRGB_LUT[d[i00 + c]] * (1 - fx) + SRGB_LUT[d[i10 + c]] * fx;
    const b = SRGB_LUT[d[i01 + c]] * (1 - fx) + SRGB_LUT[d[i11 + c]] * fx;
    out[c] = a * (1 - fy) + b * fy;
  }
  return out;
}

function kmeans(Q, n, K, iters = 12, seed = 12345) {
  // k-means++ seeding (deterministic per seed), then Lloyd iterations; returns the inertia too
  const r = rng(seed);
  const C = new Float32Array(K * 3);
  const d2 = new Float32Array(n).fill(Infinity);
  let pick = Math.floor(r() * n);
  for (let k = 0; k < K; k++) {
    C[k * 3] = Q[pick * 3]; C[k * 3 + 1] = Q[pick * 3 + 1]; C[k * 3 + 2] = Q[pick * 3 + 2];
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const dx = Q[i * 3] - C[k * 3], dy = Q[i * 3 + 1] - C[k * 3 + 1], dz = Q[i * 3 + 2] - C[k * 3 + 2];
      d2[i] = Math.min(d2[i], dx * dx + dy * dy + dz * dz);
      sum += d2[i];
    }
    let t = r() * sum;
    pick = n - 1;
    for (let i = 0; i < n; i++) { t -= d2[i]; if (t <= 0) { pick = i; break; } }
  }
  const S = new Float64Array(K * 4);
  let inertia = 0;
  for (let it = 0; it <= iters; it++) {
    S.fill(0);
    inertia = 0;
    for (let i = 0; i < n; i++) {
      let best = 0, bd = Infinity;
      for (let k = 0; k < K; k++) {
        const dx = Q[i * 3] - C[k * 3], dy = Q[i * 3 + 1] - C[k * 3 + 1], dz = Q[i * 3 + 2] - C[k * 3 + 2];
        const dd = dx * dx + dy * dy + dz * dz;
        if (dd < bd) { bd = dd; best = k; }
      }
      inertia += bd;
      S[best * 4] += Q[i * 3]; S[best * 4 + 1] += Q[i * 3 + 1]; S[best * 4 + 2] += Q[i * 3 + 2]; S[best * 4 + 3]++;
    }
    if (it === iters) break;
    for (let k = 0; k < K; k++) {
      if (!S[k * 4 + 3]) continue;
      C[k * 3] = S[k * 4] / S[k * 4 + 3]; C[k * 3 + 1] = S[k * 4 + 1] / S[k * 4 + 3]; C[k * 3 + 2] = S[k * 4 + 2] / S[k * 4 + 3];
    }
  }
  return { C, inertia };
}

function nearest(C, K, q) {
  let best = 0, bd = Infinity;
  for (let k = 0; k < K; k++) {
    const dx = q[0] - C[k * 3], dy = q[1] - C[k * 3 + 1], dz = q[2] - C[k * 3 + 2];
    const dd = dx * dx + dy * dy + dz * dz;
    if (dd < bd) { bd = dd; best = k; }
  }
  return best;
}

/**
 * Bind-pose positions / normals (body space) and per-vertex bone-group weights of a skinned mesh.
 * `B[j]` maps bone j's skinning into body space at the rest pose (bone.matrixWorld * boneInverse *
 * bindMatrix, relative to the rig root).
 */
export function bindData(mesh, B) {
  const g = mesh.geometry, pos = g.attributes.position, nor = g.attributes.normal;
  const si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
  const N = pos.count;
  const P = new Float32Array(N * 3), NB = new Float32Array(N * 3), GW = new Float32Array(N * NG);
  const groups = mesh.skeleton.bones.map((b) => boneGroup(b.name));
  const v = new THREE.Vector3(), t = new THREE.Vector3(), o = new THREE.Vector3(), n = new THREE.Vector3(), on = new THREE.Vector3();
  const nm = B.map((m) => new THREE.Matrix3().setFromMatrix4(m));
  for (let i = 0; i < N; i++) {
    v.fromBufferAttribute(pos, i); o.set(0, 0, 0); on.set(0, 0, 0);
    if (nor) n.fromBufferAttribute(nor, i);
    for (let k = 0; k < 4; k++) {
      const w = sw.getComponent(i, k);
      if (!w) continue;
      const j = si.getComponent(i, k);
      o.addScaledVector(t.copy(v).applyMatrix4(B[j]), w);
      if (nor) on.addScaledVector(t.copy(n).applyMatrix3(nm[j]), w);
      GW[i * NG + groups[j]] += w;
    }
    on.normalize();
    P[i * 3] = o.x; P[i * 3 + 1] = o.y; P[i * 3 + 2] = o.z;
    NB[i * 3] = on.x; NB[i * 3 + 1] = on.y; NB[i * 3 + 2] = on.z;
  }
  return { P, NB, GW, N };
}

/**
 * Find the garment zones of one character model.
 * @param {THREE.SkinnedMesh} mesh
 * @param {{data: Uint8ClampedArray|Uint8Array, width: number, height: number}} px  albedo (RGBA, glTF uv orientation)
 * @param {THREE.Matrix4[]} B  rest-pose skinning matrices in body space (see bindData)
 * @param {Record<string, THREE.Vector3>} joints  rest-pose joint positions in body space (Hips, Head, neck, ...)
 */
export function analyzeZones(mesh, px, B, joints, { samples = 60000, K = 10, debug = false } = {}) {
  const g = mesh.geometry, uv = g.attributes.uv, index = g.index;
  const { P, NB, GW, N } = bindData(mesh, B);
  const tri = index ? index.array : Uint32Array.from({ length: N }, (_, i) => i);
  const T = tri.length / 3;
  // ---- landmarks
  let yTop = -Infinity;
  for (let i = 0; i < N; i++) yTop = Math.max(yTop, P[i * 3 + 1]);
  const yHips = joints.Hips?.y ?? yTop * 0.54;
  const yHead = joints.Head?.y ?? yTop * 0.85;
  const zHead = joints.Head?.z ?? 0;

  // ---- area-weighted surface samples
  const area = new Float32Array(T);
  let total = 0;
  for (let t = 0; t < T; t++) {
    const a = tri[t * 3] * 3, b = tri[t * 3 + 1] * 3, c = tri[t * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    area[t] = 0.5 * Math.hypot(cx, cy, cz);
    total += area[t];
  }
  const r = rng(777);
  const per = samples / total;
  const perTri = new Uint8Array(T);
  let S = 0;
  for (let t = 0; t < T; t++) {
    const head = P[tri[t * 3] * 3 + 1] > yHead - 0.06 ? 3 : 1; // denser on the head: helmet, goggles, face
    S += perTri[t] = Math.min(255, Math.floor(area[t] * per * head + r()));
  }
  // per sample: clustering coordinates, OKLab, bind position, and the bone-group weights the regions use
  const Qs = new Float32Array(S * 3), SL = new Float32Array(S * 3), SP = new Float32Array(S * 3), SG = new Float32Array(S * NG);
  const lin = [0, 0, 0], lab = [0, 0, 0], q = [0, 0, 0];
  for (let t = 0, i = 0; t < T; t++) {
    const ia = tri[t * 3], ib = tri[t * 3 + 1], ic = tri[t * 3 + 2];
    const ua = uv.getX(ia), ub = uv.getX(ib), uc = uv.getX(ic), va = uv.getY(ia), vb = uv.getY(ib), vc = uv.getY(ic);
    for (let n = perTri[t]; n > 0; n--, i++) {
      let s1 = r(), s2 = r();
      if (s1 + s2 > 1) { s1 = 1 - s1; s2 = 1 - s2; }
      const w0 = 1 - s1 - s2;
      sampleLin(px, ua * w0 + ub * s1 + uc * s2, va * w0 + vb * s1 + vc * s2, lin);
      linToLab(lin[0], lin[1], lin[2], lab);
      Qs[i * 3] = lab[0] * WL; Qs[i * 3 + 1] = lab[1]; Qs[i * 3 + 2] = lab[2];
      SL[i * 3] = lab[0]; SL[i * 3 + 1] = lab[1]; SL[i * 3 + 2] = lab[2];
      for (let k = 0; k < 3; k++) SP[i * 3 + k] = P[ia * 3 + k] * w0 + P[ib * 3 + k] * s1 + P[ic * 3 + k] * s2;
      for (let k = 0; k < NG; k++) SG[i * NG + k] = GW[ia * NG + k] * w0 + GW[ib * NG + k] * s1 + GW[ic * NG + k] * s2;
    }
  }
  // cluster a subsample, then label every sample with its nearest centre
  const stride = Math.max(1, Math.floor(S / 16000));
  const sub = new Float32Array(Math.ceil(S / stride) * 3);
  let ns = 0;
  for (let i = 0; i < S; i += stride, ns++) { sub[ns * 3] = Qs[i * 3]; sub[ns * 3 + 1] = Qs[i * 3 + 1]; sub[ns * 3 + 2] = Qs[i * 3 + 2]; }
  let C = null, bestI = Infinity;
  for (const seed of [12345, 777, 4242]) { // a few restarts: the lowest-inertia clustering is the stable one
    const km = kmeans(sub, ns, K, 10, seed);
    if (km.inertia < bestI) { bestI = km.inertia; C = km.C; }
  }
  const cl = new Int16Array(S);
  for (let i = 0; i < S; i++) { q[0] = Qs[i * 3]; q[1] = Qs[i * 3 + 1]; q[2] = Qs[i * 3 + 2]; cl[i] = nearest(C, K, q); }

  // ---- per-cluster stats per region
  const yKnee = Math.max(joints.LeftLeg?.y ?? yHips * 0.55, joints.RightLeg?.y ?? 0);
  const part = new Int8Array(S); // 0 other, 1 jacket body, 2 trousers body, 3 head, 4 hand, 5 foot, 6 crown
  for (let i = 0; i < S; i++) {
    const y = SP[i * 3 + 1];
    const gw = (k) => SG[i * NG + k];
    if (gw(G_HAND) > 0.5) part[i] = 4;
    else if (gw(G_FOOT) > 0.5) part[i] = 5;
    else if (y > yTop - 0.07) part[i] = 6;
    else if (y > yHead + 0.02) part[i] = 3;
    else if (gw(G_ARM) > 0.5 || (y > yHips + 0.06 && y < yHead - 0.04)) part[i] = 1;
    else if (gw(G_LEG) > 0.5 && y < yHips - 0.08) part[i] = 2;
  }
  const NP = 7;
  const frac = Array.from({ length: NP }, () => new Float32Array(K));
  const cnt = new Float32Array(NP);
  const mean = Array.from({ length: K }, () => [0, 0, 0, 0]);
  for (let i = 0; i < S; i++) {
    frac[part[i]][cl[i]]++; cnt[part[i]]++;
    const m = mean[cl[i]]; m[0] += SL[i * 3]; m[1] += SL[i * 3 + 1]; m[2] += SL[i * 3 + 2]; m[3]++;
  }
  for (let p = 0; p < NP; p++) for (let k = 0; k < K; k++) frac[p][k] /= Math.max(1, cnt[p]);
  for (const m of mean) if (m[3]) { m[0] /= m[3]; m[1] /= m[3]; m[2] /= m[3]; }
  const chroma = (k) => Math.hypot(mean[k][1], mean[k][2]);
  const dist = (a, b) => Math.hypot(C[a * 3] - C[b * 3], C[a * 3 + 1] - C[b * 3 + 1], C[a * 3 + 2] - C[b * 3 + 2]);
  // skin: warm, mid-light, moderately saturated, and mostly found on the head
  const skin = new Set();
  for (let k = 0; k < K; k++) {
    const [L, a, b] = mean[k], h = Math.atan2(b, a) * 180 / Math.PI, c = chroma(k);
    const onHead = frac[3][k] + frac[6][k] * 0.5, onBody = frac[1][k] + frac[2][k];
    if (L > 0.5 && L < 0.9 && c > 0.035 && c < 0.12 && h > 18 && h < 80 && onHead > onBody * 2) skin.add(k);
  }
  const neutral = (k) => chroma(k) < 0.03;
  const darkNeutral = (k) => mean[k][0] < 0.33 && chroma(k) < 0.02;
  const hueGap = (a, b) => { const d = Math.abs(Math.atan2(mean[a][2], mean[a][1]) - Math.atan2(mean[b][2], mean[b][1])); return Math.min(d, Math.PI * 2 - d); };
  // Shading variants of one dye. Baked shadows scale lightness and chroma together, so a dyed colour
  // keeps its hue and its chroma/lightness ratio; a neutral keeps its lightness within ~25%. Families
  // grow from a seed and every member must stay that close to the seed itself (no chaining from a
  // dark green through dark grey into black straps, or from black through greys into white).
  const MERGE = 0.06;
  const cl2 = (k) => chroma(k) / Math.max(mean[k][0], 0.05);
  const shadeOf = (k, seed, loose = 1) => {
    if (neutral(k) || neutral(seed)) return neutral(k) && neutral(seed) && Math.min(mean[k][0], mean[seed][0]) >= Math.max(mean[k][0], mean[seed][0]) * 0.7 / loose;
    const ratio = cl2(k) / cl2(seed);
    return hueGap(k, seed) < 0.35 * loose && ratio > 0.65 / loose && ratio < 1.55 * loose;
  };
  const grow = (seed, pool, taken, f, r = MERGE) => {
    const set = new Set([seed]);
    let added = true;
    while (added) {
      added = false;
      for (const k of pool) {
        if (set.has(k) || taken.has(k) || f[k] < 0.01) continue;
        let ok = shadeOf(k, seed);
        if (!ok && shadeOf(k, seed, 1.3)) for (const m of set) if (dist(k, m) < r) { ok = true; break; } // close to a member, near the seed
        if (ok) { set.add(k); added = true; }
      }
    }
    return set;
  };

  // garment roles in one body region: the dominant colour (+ its shading variants) and an accent
  function base(p) {
    const f = frac[p];
    const order = [...Array(K).keys()].filter((k) => !skin.has(k)).sort((a, b) => f[b] - f[a]);
    const primary = order[0];
    if (primary === undefined || f[primary] < 0.12) return new Set();
    return grow(primary, order, new Set(), f);
  }
  function accent(p, P1, other) {
    const f = frac[p];
    const order = [...Array(K).keys()].filter((k) => !skin.has(k)).sort((a, b) => f[b] - f[a]);
    const primary = [...P1][0];
    if (primary === undefined) return new Set();
    // black straps, pouches and harnesses are hardware, not a design accent (unless the base is light)
    const hardware = chroma(primary) > 0.05 || mean[primary][0] < 0.4;
    const pureBlack = (k) => mean[k][0] < 0.27 && chroma(k) < 0.012;
    const cand = order.filter((k) => !P1.has(k) && !other.has(k) && !(pureBlack(k) && hardware)
      && !(p === 2 && frac[5][k] >= 0.25 && f[k] < 0.2) // the boots' own colour showing on the shafts
      && !(chroma(k) >= 0.05 && !neutral(primary) && hueGap(k, primary) < 0.45) // a darker shade of the base, not an accent
      && (f[k] >= 0.06 || (f[k] >= 0.015 && chroma(k) >= 0.08)));
    if (!cand.length) return new Set();
    const P2 = grow(cand[0], order, new Set([...P1, ...other]), f);
    // two neutral panels (black + white suits): the greys in between go to the closer side
    if (neutral(primary) && neutral(cand[0])) {
      for (const k of order) {
        if (P1.has(k) || P2.has(k) || f[k] < 0.01 || !neutral(k)) continue;
        const L = mean[k][0], L1 = mean[primary][0], L2 = mean[cand[0]][0];
        if ((L - L1) * (L - L2) <= 0) (Math.abs(L - L1) <= Math.abs(L - L2) ? P1 : P2).add(k);
      }
    }
    return P2;
  }
  const J1 = base(1), T1 = base(2);
  // a jacket hem hanging over the thighs is not a trousers accent, nor the trousers' waist a jacket one
  // (unless both garments are one suit)
  const J2 = accent(1, J1, setMinus(T1, J1)), T2 = accent(2, T1, setMinus(J1, T1));
  const jacket = { primary: [...J1], accent: [...J2] };
  const trousers = { primary: [...T1], accent: [...T2] };
  // helmet: whatever covers the crown (pattern colours included, straps / vents / frames excluded)
  // helmet: the crown's colour and its darker / lighter folds anywhere on the head
  const H0 = base(6);
  const garmentOnly = new Set([...J1, ...T1].filter((k) => frac[6][k] < 0.05)); // a hood is the jacket's, not the helmet's
  const helmet = { primary: H0.size ? [...grow([...H0][0], [...Array(K).keys()].filter((k) => !skin.has(k) && !garmentOnly.has(k) && frac[3][k] + frac[6][k] >= 0.03), new Set(), frac[3].map((v, k) => v + frac[6][k]), 0.08)] : [], accent: [] };
  if (helmet.primary.length) {
    for (let k = 0; k < K; k++) {
      if (helmet.primary.includes(k) || skin.has(k) || darkNeutral(k) || garmentOnly.has(k)) continue;
      if (frac[6][k] >= 0.08) helmet.primary.push(k);
    }
  }
  // goggle lens, found in a front view of the head (front-most surface per 6 mm cell, as a viewer
  // sees it): the colour family filling the widest share of one 8 cm band above the face and below the
  // crown (not skin, the helmet or a near-black frame / strap / visor); the lens box is that band
  let zFront = -Infinity;
  for (let i = 0; i < S; i++) if (SP[i * 3 + 1] > yHead + 0.03 && part[i] !== 4) zFront = Math.max(zFront, SP[i * 3 + 2]);
  const FC = 0.006, GX = 40, gy0 = yHead - 0.04, GY = Math.ceil((yTop - gy0) / FC) + 1, hScale = yTop / 1.78;
  const fz = new Float32Array(GX * GY).fill(-Infinity), fk = new Int16Array(GX * GY).fill(-1);
  for (let i = 0; i < S; i++) {
    const x = SP[i * 3], y = SP[i * 3 + 1], zz = SP[i * 3 + 2];
    if (y < gy0 || Math.abs(x) >= 0.12 || part[i] === 4 || zz < zFront - 0.09) continue;
    const c = Math.floor((x + 0.12) / FC) + Math.floor((y - gy0) / FC) * GX;
    if (zz > fz[c]) { fz[c] = zz; fk[c] = cl[i]; }
  }
  const fc = new Float32Array(K), skinYs = [];
  let fn = 0;
  for (let c = 0; c < GX * GY; c++) {
    if (fk[c] < 0) continue;
    fc[fk[c]]++; fn++;
    if (skin.has(fk[c])) skinYs.push(gy0 + Math.floor(c / GX) * FC);
  }
  for (let k = 0; k < K; k++) fc[k] /= Math.max(1, fn);
  skinYs.sort((p1, p2) => p1 - p2);
  const skinMid = skinYs.length > 10 ? skinYs[skinYs.length >> 1] : -Infinity;
  // 1) a colour family of its own (not skin, the helmet or a near-black frame / strap / visor) marks
  //    the band; 2) helmet colours that fill much of that band are lens too (an orange lens under an
  //    orange helmet), the box keeps them apart from the helmet itself
  const hSet = new Set(helmet.primary);
  // (a rose lens can look like skin: skin colours may belong to a lens, but its own non-skin colours
  // must still mark the band, which a bare face with eyes and brows never does)
  const lensPool = [...Array(K).keys()].filter((k) => !hSet.has(k) && mean[k][0] > 0.25 && mean[k][0] < 0.97 && !darkNeutral(k) && fc[k] > 0.005);
  const rowAll = new Float32Array(GY);
  for (let c = 0; c < GX * GY; c++) if (fk[c] >= 0) rowAll[Math.floor(c / GX)]++;
  let lens = [], lensBox = null, best = 0, lensY = 0, lensRows = null;
  const seen = new Set();
  for (const k of lensPool) {
    const fam = [...grow(k, lensPool, new Set(), fc, 0.12)].sort((p1, p2) => p1 - p2); // mirror lenses shade across hues
    if (seen.has(fam.join())) continue;
    seen.add(fam.join());
    const inFam = new Uint8Array(K);
    for (const m of fam) inFam[m] = 1;
    const rowF = new Float32Array(GY);
    for (let c = 0; c < GX * GY; c++) if (fk[c] >= 0 && inFam[fk[c]]) rowF[Math.floor(c / GX)]++;
    const share = (r) => (rowAll[r] > 3 ? rowF[r] / rowAll[r] : 0);
    // the densest 4.5-7.5 cm window of rows, grown over neighbouring rows the family still covers
    for (const hw of [8, 10, 12]) {
      for (let r0 = 0; r0 + hw <= GY; r0++) {
        const yc = gy0 + (r0 + hw / 2) * FC;
        // goggles sit at eye level: 12-19 cm under the crown of a helmeted 1.78 m skier, above the face
        if (yc < yTop - 0.19 * hScale || yc > yTop - 0.12 * hScale) continue;
        let nF = 0, nS = 0, nA = 0, zs = 0, xMin = 1, xMax = -1;
        for (let r = r0; r < r0 + hw; r++) for (let cx = 0; cx < GX; cx++) {
          const kk = fk[r * GX + cx];
          if (kk < 0) continue;
          nA++;
          if (!inFam[kk]) continue;
          nF++; zs += fz[r * GX + cx];
          if (skin.has(kk)) nS++;
          const x = -0.12 + (cx + 0.5) * FC; xMin = Math.min(xMin, x); xMax = Math.max(xMax, x);
        }
        // wide, filling the band (with the helmet's colours when the lens shares them), out in front
        if (nF - nS < 20 || nF - nS < nA * 0.12 || xMax - xMin < 0.07 || zs / nF < zFront - 0.07) continue; // wide, out in front
        const score = (nF / nA) * (0.6 + Math.min(1, fam.reduce((acc, m) => Math.max(acc, chroma(m)), 0) * 6));
        if (score > best * 1.001) {
          best = score; lens = fam;
          let lo = r0, hi = r0 + hw - 1;
          while (hi - lo + 1 < 17) {
            const up = hi + 1 < GY && share(hi + 1) >= 0.15, dn = lo > 0 && share(lo - 1) >= 0.15;
            if (!up && !dn) break;
            if (up) hi++;
            if (dn && hi - lo + 1 < 17) lo--;
          }
          lensRows = { lo, hi }; lensY = gy0 + (lo + hi + 1) * FC / 2;
        }
      }
    }
  }
  if (lens.length) {
    // the lens is every lens-like colour of that band (mirror coatings split into several clusters), plus
    // helmet colours that fill much of it; together they must fill the band (a face with eyebrows doesn't)
    const inBand = new Float32Array(K);
    let nb = 0;
    for (let r = lensRows.lo; r <= lensRows.hi; r++) for (let cx = 0; cx < GX; cx++) { const kk = fk[r * GX + cx]; if (kk >= 0) { inBand[kk]++; nb++; } }
    lens = lens.filter((k) => !skin.has(k) || inBand[k] >= nb * 0.25); // skin only when it is the lens
    const seed = lens.find((k) => !skin.has(k)) ?? lens[0];
    for (const k of lensPool) if (!lens.includes(k) && !skin.has(k) && inBand[k] >= nb * 0.05 && (chroma(k) >= 0.04 || shadeOf(k, seed, 1.5))) lens.push(k); // not a white / grey frame
    for (const k of hSet) if (!lens.includes(k) && inBand[k] >= nb * 0.25) lens.push(k);
    if (lens.reduce((acc, k) => acc + inBand[k], 0) < nb * 0.28 || lens.reduce((acc, k) => acc + (skin.has(k) ? 0 : inBand[k]), 0) < nb * 0.15) lens = [];
  }
  if (lens.length) {
    let x1 = 0, z0 = Infinity;
    for (let r = lensRows.lo; r <= lensRows.hi; r++) for (let cx = 0; cx < GX; cx++) {
      const c = r * GX + cx;
      if (!lens.includes(fk[c])) continue;
      x1 = Math.max(x1, Math.abs(-0.12 + (cx + 0.5) * FC));
      z0 = Math.min(z0, fz[c]);
    }
    lensBox = { x0: -Math.min(0.115, x1 + 0.01), x1: Math.min(0.115, x1 + 0.01), y0: gy0 + lensRows.lo * FC - 0.004, y1: gy0 + (lensRows.hi + 1) * FC + 0.004, z0: z0 - 0.025 };
  }
  const rim = lensY;
  // J/T split for colours both garments share: the top of the band where the trousers' own dye
  // outweighs the jacket's (one-piece suits: the belt line just above the hips joint)
  const jSet = new Set([...jacket.primary, ...jacket.accent]), tSet = new Set([...trousers.primary, ...trousers.accent]);
  const j1 = new Set(jacket.primary), tSeed = trousers.primary[0];
  const bins = new Float32Array(24 * 2); // [jacket base, trousers seed] per 2 cm from yHips - 0.25
  for (let i = 0; i < S; i++) {
    const y = SP[i * 3 + 1], b2 = Math.floor((y - (yHips - 0.25)) / 0.02);
    if (b2 < 0 || b2 >= 24 || part[i] === 4 || SG[i * NG + G_ARM] > 0.5) continue;
    const k = cl[i];
    if (k === tSeed && !j1.has(k)) bins[b2 * 2 + 1]++;
    else if (j1.has(k) && k !== tSeed) bins[b2 * 2]++;
  }
  let yWaist = yHips + 0.04;
  for (let b2 = 23; b2 >= 0; b2--) {
    const nJ = bins[b2 * 2], nT = bins[b2 * 2 + 1];
    if (nT > 20 && nT > nJ) { yWaist = yHips - 0.25 + (b2 + 1) * 0.02; break; }
  }
  yWaist = Math.min(yHips + 0.1, Math.max(yHips - 0.2, yWaist));
  // tall boots: lower-leg surface whose surroundings show boot-only colours belongs to the boots
  const bootOnly = new Set([...Array(K).keys()].filter((k) => frac[5][k] >= 0.08 && !tSet.has(k) && !skin.has(k)));
  const CELL = 0.035, grid = new Map();
  const cellKey = (x, y, z) => (Math.floor(x / CELL) + 512) + (Math.floor(y / CELL) + 512) * 1024 + (Math.floor(z / CELL) + 512) * 1048576;
  for (let i = 0; i < S; i++) {
    if (SP[i * 3 + 1] > yKnee + 0.05) continue;
    const key = cellKey(SP[i * 3], SP[i * 3 + 1], SP[i * 3 + 2]);
    let c = grid.get(key);
    if (!c) grid.set(key, (c = [0, 0]));
    c[0]++;
    if (bootOnly.has(cl[i])) c[1]++;
  }
  const bootish = (x, y, z) => {
    if (!bootOnly.size || y > yKnee) return false;
    let n = 0, b2 = 0;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const c = grid.get(cellKey(x + dx * CELL, y + dy * CELL, z + dz * CELL));
      if (c) { n += c[0]; b2 += c[1]; }
    }
    return n > 6 && b2 / n >= 0.2;
  };
  const yNeck = yHead;

  // cluster spread (for the shader's "this colour belongs to no cluster" fade)
  const rad = new Float32Array(K), rc = new Float32Array(K);
  for (let i = 0; i < S; i++) {
    const k = cl[i];
    rad[k] += (Qs[i * 3] - C[k * 3]) ** 2 + (Qs[i * 3 + 1] - C[k * 3 + 1]) ** 2 + (Qs[i * 3 + 2] - C[k * 3 + 2]) ** 2; rc[k]++;
  }
  for (let k = 0; k < K; k++) rad[k] = Math.sqrt(rad[k] / Math.max(1, rc[k]));

  const zones = {
    K, C, rad, mean, yWaist, yNeck, lensBox,
    roles: { J1: jacket.primary, J2: jacket.accent, T1: trousers.primary, T2: trousers.accent, H: helmet.primary, L: lens },
    // light specks and baked glints on a garment (a few % of white on a blue jacket) take its base colour
    // where only that garment can be, so a black jacket doesn't keep white flecks
    specks: { J: [], T: [] },
    has: { jacket: jacket.primary.length > 0, jacketAccent: jacket.accent.length > 0, trousers: trousers.primary.length > 0,
      trousersAccent: trousers.accent.length > 0, helmet: helmet.primary.length > 0, lens: lens.length > 0 },
  };
  // reference colour of every zone (area-weighted mean of its clusters) -> lightness ratio + chroma detail
  zones.ref = {};
  for (const [z, ks] of Object.entries(zones.roles)) {
    let w = 0, L = 0, A = 0, Bq = 0, Cc = 0;
    for (const k of ks) { w += rc[k]; L += mean[k][0] * rc[k]; A += mean[k][1] * rc[k]; Bq += mean[k][2] * rc[k]; Cc += chroma(k) * rc[k]; }
    zones.ref[z] = w ? [L / w, A / w, Bq / w, Cc / w] : [0.5, 0, 0, 0];
  }
  for (const [p, key, own] of [[1, 'J', [...jacket.primary, ...jacket.accent]], [2, 'T', [...trousers.primary, ...trousers.accent]]]) {
    if (!own.length) continue;
    for (let k = 0; k < K; k++) {
      if (own.includes(k) || skin.has(k) || lens.includes(k)) continue;
      if (neutral(k) && mean[k][0] >= 0.72 && frac[p][k] > 0 && frac[p][k] < 0.015) zones.specks[key].push(k);
    }
  }
  // anti-aliased edges between two garment colours (blue/yellow -> olive) form their own little cluster:
  // drop it so those texels blend between the two new colours instead of keeping an old-colour outline
  const garments = [[...jacket.primary, ...jacket.accent], [...trousers.primary, ...trousers.accent]];
  const roleOf = new Set(Object.values(zones.roles).flat());
  zones.blend = [];
  for (let k = 0; k < K; k++) {
    if (roleOf.has(k) || skin.has(k) || zones.specks.J.includes(k) || zones.specks.T.includes(k) || Math.max(frac[3][k], frac[4][k], frac[5][k], frac[6][k], fc[k]) > 0.08) continue; // a real colour elsewhere
    for (const [p, ks] of [[1, garments[0]], [2, garments[1]]]) {
      if (frac[p][k] > 0.05) continue;
      let hit = false;
      for (const a of ks) for (const b of ks) {
        if (a >= b) continue;
        const ab = dist(a, b);
        if (ab < 0.08) continue;
        const t = ((C[k * 3] - C[a * 3]) * (C[b * 3] - C[a * 3]) + (C[k * 3 + 1] - C[a * 3 + 1]) * (C[b * 3 + 1] - C[a * 3 + 1]) + (C[k * 3 + 2] - C[a * 3 + 2]) * (C[b * 3 + 2] - C[a * 3 + 2])) / (ab * ab);
        const dx = C[k * 3] - C[a * 3] - t * (C[b * 3] - C[a * 3]), dy = C[k * 3 + 1] - C[a * 3 + 1] - t * (C[b * 3 + 1] - C[a * 3 + 1]), dz = C[k * 3 + 2] - C[a * 3 + 2] - t * (C[b * 3 + 2] - C[a * 3 + 2]);
        if (t > 0.15 && t < 0.85 && Math.hypot(dx, dy, dz) < 0.3 * ab) hit = true;
      }
      if (hit && !zones.blend.includes(k)) zones.blend.push(k);
    }
  }
  // the face (eyes, brows, lips) is never a garment, whatever colour it shares with one
  const face = { x: 0.085, y0: yHead + 0.01, y1: lensBox ? lensBox.y1 : yTop - 0.07, z0: zFront - 0.08 };
  const crownJ = new Set([...jSet].filter((k) => frac[6][k] > 0.05)); // jacket colours that also cover the crown: never on the head
  zones.attr = vertexZones(mesh, px, P, GW, N, zones, { yNeck, yWaist, yKnee, yTop, face, bootish, crownJ, gloveC: new Set([...Array(K).keys()].filter((k) => frac[4][k] >= 0.12)), bootC: new Set([...Array(K).keys()].filter((k) => frac[5][k] >= 0.12)) });

  if (debug) {
    for (let k = 0; k < K; k++) {
      const m = mean[k];
      const roles = Object.entries(zones.roles).filter(([, ks]) => ks.includes(k)).map(([z]) => z).concat(skin.has(k) ? ['skin'] : [], zones.blend.includes(k) ? ['blend'] : []).join(',');
      console.log(`  c${k} ${labToHex(m[0], m[1], m[2])} L${m[0].toFixed(2)} C${chroma(k).toFixed(3)} h${(Math.atan2(m[2], m[1]) * 180 / Math.PI).toFixed(0).padStart(4)} r${rad[k].toFixed(3)}`
        + ` | J ${(frac[1][k] * 100).toFixed(1).padStart(4)} T ${(frac[2][k] * 100).toFixed(1).padStart(4)} head ${(frac[3][k] * 100).toFixed(1).padStart(4)} crown ${(frac[6][k] * 100).toFixed(1).padStart(4)}`
        + ` hand ${(frac[4][k] * 100).toFixed(1).padStart(4)} foot ${(frac[5][k] * 100).toFixed(1).padStart(4)} eyes ${(fc[k] * 100).toFixed(1).padStart(4)}  ${roles}`);
    }
    console.log(`  boots ${[...bootOnly].join(',')} yHips ${yHips.toFixed(3)} yWaist ${yWaist.toFixed(3)} yHead ${yHead.toFixed(3)} rim ${rim.toFixed(3)} yTop ${yTop.toFixed(3)} lensBox`, lensBox && Object.fromEntries(Object.entries(lensBox).map(([k, v]) => [k, +v.toFixed(3)])));
  }
  zones.debug = { P, NB, GW, N, samples: { S, SQ: Qs, SL, SP, SG, cl, part }, info: { yHips, yHead, yTop, yKnee, rim, skin: [...skin], frac, front: { fk, GX, GY, gy0, FC, skinMid, lensPool, fc } } };
  return zones;
}

/**
 * Per-vertex garment eligibility (where each garment MAY be; the shader decides by colour):
 * ofZone = (jacket, trousers, helmet, -) as normalized bytes, ofPos = bind-pose position (body space)
 * for the shader's waist / neck splits and the lens box.
 */
function vertexZones(mesh, px, P, GW, N, zones, { yNeck, yWaist, yKnee, yTop, face, bootish, crownJ, gloveC, bootC }) {
  const uv = mesh.geometry.attributes.uv;
  const { K, C, roles } = zones;
  const Jc = new Set([...roles.J1, ...roles.J2]), Tc = new Set([...roles.T1, ...roles.T2]), Hc = new Set(roles.H), J2c = new Set(roles.J2);
  const zone = new Uint8Array(N * 4), pos = new Float32Array(N * 3);
  const lin = [0, 0, 0], lab = [0, 0, 0], q = [0, 0, 0];
  for (let i = 0; i < N; i++) {
    sampleLin(px, uv.getX(i), uv.getY(i), lin);
    const k = nearest(C, K, toQ(linToLab(lin[0], lin[1], lin[2], lab), q));
    const y = P[i * 3 + 1];
    const hand = GW[i * NG + G_HAND] > 0.5, foot = GW[i * NG + G_FOOT] > 0.5, arm = GW[i * NG + G_ARM] > 0.5;
    let eJ = 0, eT = 0, eH = 0;
    const onFace = Math.abs(P[i * 3]) < face.x && y > face.y0 && y < face.y1 && P[i * 3 + 2] > face.z0;
    if (onFace) { /* never recoloured (the lens is the shader's lens box) */ }
    else if (y > yNeck - 0.1 && J2c.has(k) && !Hc.has(k)) { /* accent colours round the neck are gaiters, masks and linings: keep them */ }
    else if (hand) { if (Jc.has(k) && !gloveC.has(k)) eJ = 1; } // sleeve cuffs, never the gloves
    else if (foot) { if (Tc.has(k) && !bootC.has(k)) eT = 1; } // trouser hems over the boots
    else if (y > yNeck - 0.02) { eH = 1; if (Jc.has(k) && !crownJ.has(k) && y < yTop - 0.06) eJ = 1; } // head: helmet, plus hoods / collars
    else {
      if (arm || y > yWaist) { eJ = 1; if (!arm && y < yWaist + 0.06 && Tc.has(k) && !Jc.has(k)) eT = 1; } // waistbands
      else {
        eT = bootish(P[i * 3], y, P[i * 3 + 2]) ? 0 : 1; // tall boots keep their colour
        if (y > yKnee && Jc.has(k) && !Tc.has(k)) eJ = 1; // long jackets over the thighs
      }
      if (y > yNeck - 0.15 && Hc.has(k)) eH = 1; // helmet flaps / chin straps below the neck line
    }
    zone[i * 4] = eJ * 255; zone[i * 4 + 1] = eT * 255; zone[i * 4 + 2] = eH * 255;
    pos[i * 3] = P[i * 3]; pos[i * 3 + 1] = y; pos[i * 3 + 2] = P[i * 3 + 2];
  }
  return { zone, pos };
}

// ---------------------------------------------------------------- shader

const OF_PARS = /* glsl */`
uniform vec4 uOfC[${MAX_CLUSTERS}];
uniform vec4 uOfRole[${MAX_CLUSTERS}];
uniform vec4 uOfRef[6];
uniform vec4 uOfTgt[6];
uniform vec4 uOfSplit;
uniform vec3 uOfLens0;
uniform vec3 uOfLens1;
uniform vec4 uOfPbr;
uniform vec2 uOfPbrOn;
varying vec4 vOfZone;
varying vec3 vOfPos;
vec3 ofLab(vec3 c) {
  vec3 lms = mat3(0.4122214708, 0.2119034982, 0.0883024619, 0.5363325363, 0.6806995451, 0.2817188376, 0.0514459929, 0.1073969566, 0.6299787005) * c;
  lms = pow(max(lms, vec3(0.0)), vec3(1.0 / 3.0));
  return mat3(0.2104542553, 1.9779984951, 0.0259040371, 0.793617785, -2.428592205, 0.7827717662, -0.0040720468, 0.4505937099, -0.808675766) * lms;
}
vec3 ofLin(vec3 lab) {
  vec3 lms = mat3(1.0, 1.0, 1.0, 0.3963377774, -0.1055613458, -0.0894841775, 0.2158037573, -0.0638541728, -1.291485548) * lab;
  lms = lms * lms * lms;
  return mat3(4.0767416621, -1.2684380046, -0.0041960863, -3.3077115913, 2.6097574011, -0.7034186147, 0.2309699292, -0.3413193965, 1.707614701) * lms;
}
// one garment texel in the new colour: the lightness ratio to the garment's own colour keeps every fold
// and baked shadow (contrast eased when a dark dye turns light); chroma follows the new lightness
vec3 ofRecolor(vec3 lab, vec4 ref, vec3 tgt) {
  float r = max(lab.x, 0.0) / max(ref.x, 0.02);
  float g = tgt.x > ref.x ? clamp(pow(ref.x / max(tgt.x, 0.02), 0.75), 0.3, 1.0) : 0.85;
  float L = clamp(tgt.x * pow(r, g), 0.0, 1.0);
  float detail = mix(1.0, clamp((length(lab.yz) / max(lab.x, 0.05)) / max(ref.w / max(ref.x, 0.05), 1e-3), 0.6, 1.4), smoothstep(0.03, 0.06, ref.w));
  float k = clamp(L / max(tgt.x, 0.02), 0.0, 1.25) * detail;
  return vec3(L, tgt.yz * k);
}
`;

const OF_MAIN = /* glsl */`
vec3 ofOld = diffuseColor.rgb;
float ofSum = 0.0, ofMH = 0.0, ofML = 0.0, ofDark = 0.0;
{
  vec3 lab = ofLab(max(diffuseColor.rgb, vec3(0.0)));
  vec3 q = vec3(lab.x * ${WL.toFixed(3)}, lab.yz);
  float d2[${MAX_CLUSTERS}];
  float dmin = 1e9, rNear = 0.05;
  for (int k = 0; k < ${MAX_CLUSTERS}; k++) {
    vec3 dv = q - uOfC[k].xyz;
    d2[k] = uOfC[k].w > 0.0 ? dot(dv, dv) : 1e9;
    if (d2[k] < dmin) { dmin = d2[k]; rNear = uOfC[k].w; }
  }
  // soft nearest-colour assignment; roles: x jacket (1 base, 2 accent), y trousers, z helmet, w lens
  vec4 pG = vec4(0.0);
  vec2 pHL = vec2(0.0), pS = vec2(0.0);
  float ps = 0.0;
  for (int k = 0; k < ${MAX_CLUSTERS}; k++) {
    float w = exp(-(d2[k] - dmin) * 1600.0);
    vec4 r = uOfRole[k];
    ps += w;
    pG += w * vec4(step(0.5, r.x) * step(r.x, 1.5), step(1.5, r.x) * step(r.x, 2.5), step(0.5, r.y) * step(r.y, 1.5), step(1.5, r.y) * step(r.y, 2.5));
    pHL += w * step(vec2(0.5), r.zw);
    pS += w * step(vec2(2.5), r.xy);
  }
  pG /= ps; pHL /= ps; pS /= ps;
  // colours far from every cluster (rare logos) keep their own colour
  float keep = 1.0 - smoothstep(2.5 * rNear + 0.1, 3.5 * rNear + 0.18, sqrt(dmin));
  vec4 e = smoothstep(vec4(0.0), vec4(0.3), vOfZone);
  vec3 bp = vOfPos;
  float inLens = uOfSplit.z * step(uOfLens0.x, bp.x) * step(bp.x, uOfLens1.x) * step(uOfLens0.y, bp.y) * step(bp.y, uOfLens1.y) * step(uOfLens0.z, bp.z);
  // specks join the base colour only where the other garment can't be
  pG.x += pS.x * (1.0 - e.y); pG.z += pS.y * (1.0 - e.x);
  float cJ = e.x * (pG.x + pG.y), cT = e.y * (pG.z + pG.w), cH = e.z * pHL.x, cL = inLens * pHL.y;
  // a colour two garments share (one-piece suits, white helmet + white panels): the bind pose decides
  float up = smoothstep(uOfSplit.x - 0.004, uOfSplit.x + 0.004, bp.y);
  float hd = smoothstep(uOfSplit.y - 0.004, uOfSplit.y + 0.004, bp.y);
  float o = min(cJ, cT); cJ -= o * (1.0 - up); cT -= o * up;
  o = min(cJ, cL); cJ -= o * inLens; cL -= o * (1.0 - inLens);
  o = min(cH, cL); cH -= o * inLens; cL -= o * (1.0 - inLens);
  o = min(cJ, cH); cJ -= o * hd; cH -= o * (1.0 - hd);
  float mJ1 = cJ * pG.x / max(pG.x + pG.y, 1e-4), mT1 = cT * pG.z / max(pG.z + pG.w, 1e-4);
  float m0 = mJ1 * uOfTgt[0].w, m1 = (cJ - mJ1) * uOfTgt[1].w, m2 = mT1 * uOfTgt[2].w;
  float m3 = (cT - mT1) * uOfTgt[3].w, m4 = cH * uOfTgt[4].w, m5 = cL * uOfTgt[5].w;
  float raw = m0 + m1 + m2 + m3 + m4 + m5;
  float sc = keep / max(1.0, raw);
  m0 *= sc; m1 *= sc; m2 *= sc; m3 *= sc; m4 *= sc; m5 *= sc;
  ofSum = raw * sc;
  vec3 acc = lab * (1.0 - ofSum);
  if (m0 > 0.0) acc += m0 * ofRecolor(lab, uOfRef[0], uOfTgt[0].xyz);
  if (m1 > 0.0) acc += m1 * ofRecolor(lab, uOfRef[1], uOfTgt[1].xyz);
  if (m2 > 0.0) acc += m2 * ofRecolor(lab, uOfRef[2], uOfTgt[2].xyz);
  if (m3 > 0.0) acc += m3 * ofRecolor(lab, uOfRef[3], uOfTgt[3].xyz);
  if (m4 > 0.0) acc += m4 * ofRecolor(lab, uOfRef[4], uOfTgt[4].xyz);
  if (m5 > 0.0) acc += m5 * ofRecolor(lab, uOfRef[5], uOfTgt[5].xyz);
  if (ofSum > 0.0) diffuseColor.rgb = max(ofLin(acc), vec3(0.0));
  ofMH = m4; ofML = m5;
  // fabric dyed much darker than it was shows its baked sheen as plastic: keep it rough
  ofDark = m0 * clamp((uOfRef[0].x - uOfTgt[0].x) * 2.5, 0.0, 1.0) + m1 * clamp((uOfRef[1].x - uOfTgt[1].x) * 2.5, 0.0, 1.0)
    + m2 * clamp((uOfRef[2].x - uOfTgt[2].x) * 2.5, 0.0, 1.0) + m3 * clamp((uOfRef[3].x - uOfTgt[3].x) * 2.5, 0.0, 1.0);
}
`;

const ZONE_KEYS = ['J1', 'J2', 'T1', 'T2', 'H', 'L'];

function outfitMaterial(base, zones) {
  const mat = base.clone();
  const v4 = (n) => Array.from({ length: n }, () => new THREE.Vector4());
  const U = {
    uOfC: { value: v4(MAX_CLUSTERS) }, uOfRole: { value: v4(MAX_CLUSTERS) }, uOfRef: { value: v4(6) }, uOfTgt: { value: v4(6) },
    uOfSplit: { value: new THREE.Vector4() }, uOfLens0: { value: new THREE.Vector3() }, uOfLens1: { value: new THREE.Vector3() },
    uOfPbr: { value: new THREE.Vector4(0.5, 0, 0.1, 0) }, uOfPbrOn: { value: new THREE.Vector2() },
  };
  for (let k = 0; k < zones.K && k < MAX_CLUSTERS; k++) {
    U.uOfC.value[k].set(zones.C[k * 3], zones.C[k * 3 + 1], zones.C[k * 3 + 2], zones.blend.includes(k) ? 0 : Math.max(0.004, zones.rad[k]));
    const r = U.uOfRole.value[k];
    r.set(zones.roles.J1.includes(k) ? 1 : zones.roles.J2.includes(k) ? 2 : zones.specks.J.includes(k) ? 3 : 0,
      zones.roles.T1.includes(k) ? 1 : zones.roles.T2.includes(k) ? 2 : zones.specks.T.includes(k) ? 3 : 0,
      zones.roles.H.includes(k) ? 1 : 0, zones.roles.L.includes(k) ? 1 : 0);
  }
  ZONE_KEYS.forEach((z, i) => U.uOfRef.value[i].fromArray(zones.ref[z]));
  const lb = zones.lensBox;
  U.uOfSplit.value.set(zones.yWaist, zones.yNeck, lb ? 1 : 0, 0);
  if (lb) { U.uOfLens0.value.set(lb.x0, lb.y0, lb.z0); U.uOfLens1.value.set(lb.x1, lb.y1, 9); }
  mat.userData.outfit = U;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, mat.userData.outfit);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 ofZone;\nattribute vec3 ofPos;\nvarying vec4 vOfZone;\nvarying vec3 vOfPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvOfZone = ofZone;\nvOfPos = ofPos;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + OF_PARS)
      .replace('#include <map_fragment>', '#include <map_fragment>\n' + OF_MAIN)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
roughnessFactor = mix(roughnessFactor, max(roughnessFactor, 0.72), ofDark);
roughnessFactor = mix(roughnessFactor, uOfPbr.x, ofMH * uOfPbrOn.x);
metalnessFactor = mix(metalnessFactor, uOfPbr.y, ofMH * uOfPbrOn.x);
roughnessFactor = mix(roughnessFactor, uOfPbr.z, ofML * uOfPbrOn.y);
metalnessFactor = mix(metalnessFactor, uOfPbr.w, ofML * uOfPbrOn.y);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
totalEmissiveRadiance *= mix(vec3(1.0), clamp(diffuseColor.rgb / max(ofOld, vec3(0.02)), 0.0, 1.5), ofSum);`);
  };
  mat.customProgramCacheKey = () => 'ski-outfit-v1'; // every outfitted skier shares one program
  return mat;
}

// ---------------------------------------------------------------- catalogue
// Jackets and trousers are a base colour + an accent (two-tone schemes recolour each skier's own accent
// panels), helmets a colour + finish, goggle lenses a tint + mirror coating. Kits dress all four slots;
// once a kit is bought its pieces can also be worn on their own.

export const OUTFIT_SLOTS = ['jacket', 'trousers', 'helmet', 'lens'];

export const OUTFIT_ITEMS = [
  { id: 'j_glacier', slot: 'jacket', name: 'Glacier Blue', price: 160, base: '#1f6fd1', accent: '#f2f5f8' },
  { id: 'j_racing', slot: 'jacket', name: 'Racing Red', price: 160, base: '#d0202e', accent: '#f2f5f8' },
  { id: 'j_forest', slot: 'jacket', name: 'Forest Green', price: 140, base: '#2f6b3d', accent: '#e3b23c' },
  { id: 'j_teal', slot: 'jacket', name: 'Lagoon Teal', price: 200, base: '#0f9aa0', accent: '#f2f5f8' },
  { id: 'j_sunset', slot: 'jacket', name: 'Sunset Orange', price: 180, base: '#ff6a1a', accent: '#1d2a44' },
  { id: 'j_arctic', slot: 'jacket', name: 'Arctic White', price: 220, base: '#f1f4f7', accent: '#23303f' },
  { id: 'j_midnight', slot: 'jacket', name: 'Midnight Black', price: 220, base: '#1b1d22', accent: '#d42a35' },
  { id: 'j_rose', slot: 'jacket', name: 'Powder Pink', price: 240, base: '#f06ea8', accent: '#ffffff' },
  { id: 'j_volt', slot: 'jacket', name: 'Volt Yellow', price: 260, base: '#ecd51a', accent: '#1b1d22' },
  { id: 'j_violet', slot: 'jacket', name: 'Ultra Violet', price: 260, base: '#6b2fd0', accent: '#34e0d6' },
  { id: 'j_retro', slot: 'jacket', name: 'Retro Navy', price: 340, base: '#1c2b4f', accent: '#ff7a1a' },
  { id: 'j_mint', slot: 'jacket', name: 'Mint Charcoal', price: 340, base: '#7fdcbf', accent: '#2a2f36' },
  { id: 't_black', slot: 'trousers', name: 'Black', price: 90, base: '#1b1c1f', accent: '#3a3d44' },
  { id: 't_charcoal', slot: 'trousers', name: 'Charcoal', price: 90, base: '#3a3f47', accent: '#1b1c1f' },
  { id: 't_navy', slot: 'trousers', name: 'Navy', price: 110, base: '#1d2a4a', accent: '#c9ced6' },
  { id: 't_olive', slot: 'trousers', name: 'Olive', price: 120, base: '#4f5a35', accent: '#2a2f1f' },
  { id: 't_sand', slot: 'trousers', name: 'Sand', price: 120, base: '#b9986c', accent: '#5a4632' },
  { id: 't_snow', slot: 'trousers', name: 'Snow White', price: 130, base: '#eef1f4', accent: '#c4cad3' },
  { id: 't_red', slot: 'trousers', name: 'Race Red', price: 150, base: '#c81e2c', accent: '#1b1c1f' },
  { id: 't_sky', slot: 'trousers', name: 'Sky Blue', price: 160, base: '#5aa8e6', accent: '#ffffff' },
  { id: 'h_matteblack', slot: 'helmet', name: 'Matte Black', price: 80, color: '#1c1d20', finish: 'matte' },
  { id: 'h_white', slot: 'helmet', name: 'Gloss White', price: 100, color: '#f4f5f7', finish: 'gloss' },
  { id: 'h_olive', slot: 'helmet', name: 'Matte Olive', price: 110, color: '#4d5a33', finish: 'matte' },
  { id: 'h_navy', slot: 'helmet', name: 'Matte Navy', price: 120, color: '#1f2d55', finish: 'matte' },
  { id: 'h_red', slot: 'helmet', name: 'Gloss Red', price: 140, color: '#d0202e', finish: 'gloss' },
  { id: 'h_neon', slot: 'helmet', name: 'Neon Yellow', price: 160, color: '#e8f01c', finish: 'gloss' },
  { id: 'h_silver', slot: 'helmet', name: 'Chrome Silver', price: 280, color: '#c9ccd2', finish: 'chrome' },
  { id: 'h_gold', slot: 'helmet', name: 'Gold Chrome', price: 450, color: '#d9a93a', finish: 'chrome' },
  { id: 'l_clear', slot: 'lens', name: 'Clear', price: 60, tint: '#dfe8ee', mirror: 0 },
  { id: 'l_smoke', slot: 'lens', name: 'Smoke', price: 70, tint: '#3a3d44', mirror: 0.35 },
  { id: 'l_rose', slot: 'lens', name: 'Rose', price: 110, tint: '#ff7aa8', mirror: 0.5 },
  { id: 'l_ice', slot: 'lens', name: 'Ice Blue Mirror', price: 150, tint: '#45b0ff', mirror: 1 },
  { id: 'l_fire', slot: 'lens', name: 'Fire Red Mirror', price: 150, tint: '#ff3b1f', mirror: 1 },
  { id: 'l_emerald', slot: 'lens', name: 'Emerald Mirror', price: 170, tint: '#21c26b', mirror: 1 },
  { id: 'l_violet', slot: 'lens', name: 'Violet Mirror', price: 170, tint: '#8a5cff', mirror: 1 },
  { id: 'l_gold', slot: 'lens', name: 'Gold Mirror', price: 220, tint: '#ffb02a', mirror: 1 },
];

// (the forest, park, downhill and monochrome kits are the looks of the four skiers you meet on the mountain)
export const OUTFIT_KITS = [
  { id: 'kit_alpine', name: 'Alpine Classic', price: 1200, desc: 'Swiss red and white, like the old ski school',
    jacket: { base: '#d0202e', accent: '#ffffff' }, trousers: { base: '#1b1c1f', accent: '#d0202e' }, helmet: { color: '#d0202e', finish: 'gloss' }, lens: { tint: '#3a3d44', mirror: 0.35 } },
  { id: 'kit_forest', name: 'Freeride Forest', price: 1400, desc: 'Backcountry green and black, burnt-orange helmet',
    jacket: { base: '#2f5a3e', accent: '#1b1d22' }, trousers: { base: '#2c3036', accent: '#1b1d22' }, helmet: { color: '#c9501f', finish: 'matte' }, lens: { tint: '#ff6a2a', mirror: 1 } },
  { id: 'kit_park', name: 'Park Purple', price: 1500, desc: 'Deep purple with teal flashes',
    jacket: { base: '#4a23a6', accent: '#2cc6c8' }, trousers: { base: '#1b1d26', accent: '#2cc6c8' }, helmet: { color: '#7a1f96', finish: 'matte' }, lens: { tint: '#2fd6d0', mirror: 1 } },
  { id: 'kit_downhill', name: 'Downhill Orange', price: 1600, desc: 'Race-suit orange and navy, rose mirror',
    jacket: { base: '#f2541e', accent: '#1f2643' }, trousers: { base: '#f2541e', accent: '#1f2643' }, helmet: { color: '#1f2a4d', finish: 'gloss' }, lens: { tint: '#ff4f9a', mirror: 1 } },
  { id: 'kit_glacier', name: 'Glacier White', price: 1800, desc: 'Ice white with frost-blue panels',
    jacket: { base: '#f3f6f9', accent: '#7fc8f0' }, trousers: { base: '#f3f6f9', accent: '#7fc8f0' }, helmet: { color: '#f4f6f8', finish: 'gloss' }, lens: { tint: '#45b0ff', mirror: 1 } },
  { id: 'kit_mono', name: 'Monochrome', price: 2000, desc: 'Black and white slalom panels, gloss white helmet',
    jacket: { base: '#1c1d21', accent: '#f2f3f5' }, trousers: { base: '#1c1d21', accent: '#f2f3f5' }, helmet: { color: '#f4f5f7', finish: 'gloss' }, lens: { tint: '#2a2d33', mirror: 0.4 } },
  { id: 'kit_night', name: 'Night Racer', price: 2600, desc: 'Stealth black with race-red flashes',
    jacket: { base: '#121317', accent: '#e0182c' }, trousers: { base: '#121317', accent: '#e0182c' }, helmet: { color: '#141518', finish: 'matte' }, lens: { tint: '#ff3b1f', mirror: 1 } },
  { id: 'kit_gold', name: 'Legacy Gold', price: 4000, desc: 'The champion\'s kit: gold chrome and a gold mirror',
    jacket: { base: '#dcab35', accent: '#111214' }, trousers: { base: '#111214', accent: '#dcab35' }, helmet: { color: '#e0b246', finish: 'chrome' }, lens: { tint: '#ffb02a', mirror: 1 } },
];

const ITEM_BY_ID = new Map(OUTFIT_ITEMS.map((it) => [it.id, it]));
const KIT_BY_ID = new Map(OUTFIT_KITS.map((k) => [k.id, k]));
const SLOT_NAMES = { jacket: 'Jacket', trousers: 'Trousers', helmet: 'Helmet', lens: 'Lens' };

/** An item by id: catalogue items, kits, and kit pieces ('kit_gold.jacket'). */
export function outfitItem(id) {
  if (!id) return null;
  if (ITEM_BY_ID.has(id)) return ITEM_BY_ID.get(id);
  if (KIT_BY_ID.has(id)) return { ...KIT_BY_ID.get(id), slot: 'kit' };
  const [kitId, slot] = String(id).split('.');
  const kit = KIT_BY_ID.get(kitId);
  if (!kit || !kit[slot]) return null;
  return { id, slot, kit: kitId, name: `${kit.name} ${SLOT_NAMES[slot]}`, price: kit.price, ...kit[slot] };
}

/** save.outfits, created / repaired in place: { owned: [ids], equipped: { [charId]: { jacket, trousers, helmet, lens } } }
 * (one equipped set each for the man and the woman, characters.js; owned items fit both). */
export function ensureOutfits(save) {
  const o = save.outfits && typeof save.outfits === 'object' ? save.outfits : {};
  if (!Array.isArray(o.owned)) o.owned = [];
  o.owned = o.owned.filter((id, i, a) => typeof id === 'string' && outfitItem(id) && a.indexOf(id) === i);
  if (!o.equipped || typeof o.equipped !== 'object') o.equipped = {};
  for (const [c, e] of Object.entries(o.equipped)) {
    if (!e || typeof e !== 'object') { delete o.equipped[c]; continue; }
    for (const slot of OUTFIT_SLOTS) if (e[slot] != null && outfitItem(e[slot])?.slot !== slot) e[slot] = null;
  }
  save.outfits = o;
  return o;
}

export function ownsOutfit(save, id) {
  const it = outfitItem(id);
  if (!it) return false;
  const owned = ensureOutfits(save).owned;
  return owned.includes(it.kit || id);
}

/** The item ids a character wears (null = the skier's own original piece). */
export function getEquipped(save, charId) {
  const e = ensureOutfits(save).equipped[charId] || {};
  const out = {};
  for (const slot of OUTFIT_SLOTS) out[slot] = e[slot] && ownsOutfit(save, e[slot]) ? e[slot] : null;
  return out;
}

export function setEquipped(save, charId, slot, id) {
  const o = ensureOutfits(save);
  const e = (o.equipped[charId] ||= { jacket: null, trousers: null, helmet: null, lens: null });
  if (slot === 'kit') { for (const s of OUTFIT_SLOTS) e[s] = `${id}.${s}`; return e; }
  e[slot] = id || null;
  return e;
}

/** Colours for every slot of an equipped set (null slots keep the original). */
export function outfitLook(equipped) {
  const look = {};
  let any = false;
  for (const slot of OUTFIT_SLOTS) {
    const it = outfitItem(equipped?.[slot]);
    look[slot] = it && it.slot === slot ? it : null;
    any ||= !!look[slot];
  }
  return any ? look : null;
}

// ---------------------------------------------------------------- applying an outfit to a rig

const FINISH = { matte: [0.82, 0], satin: [0.5, 0], gloss: [0.2, 0], chrome: [0.16, 0.85] };
const ZONES = new WeakMap(); // geometry -> zones (null = this model cannot be recoloured)
const RIGS = new WeakMap(); // rig -> { mesh, base, mat }

function skinnedOf(rig) {
  if (rig?.skinned?.isSkinnedMesh) return rig.skinned;
  let m = null;
  (rig?.body || rig?.root || rig)?.traverse?.((o) => { if (!m && o.isSkinnedMesh) m = o; });
  return m;
}

/**
 * Albedo pixels (the GLB textures are ImageBitmaps): drawn 1:1 into a canvas and box-filtered down to
 * `size` here, so the analysis sees exactly the same pixels on every machine (no browser resampler).
 */
function readPixels(img, size = 512) {
  if (!img || !(img.width > 0) || typeof document === 'undefined') return null;
  const W = img.width, H = img.height;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true });
  if (!g) return null;
  g.drawImage(img, 0, 0);
  const src = g.getImageData(0, 0, W, H).data;
  c.width = c.height = 1; // release the full-size canvas right away
  const fx = W / size, fy = H / size, out = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    const y0 = Math.floor(y * fy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor(x * fx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx));
      let r = 0, gg = 0, b = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const k = (yy * W + xx) * 4; r += src[k]; gg += src[k + 1]; b += src[k + 2]; }
      const n = (y1 - y0) * (x1 - x0), o = (y * size + x) * 4;
      out[o] = Math.round(r / n); out[o + 1] = Math.round(gg / n); out[o + 2] = Math.round(b / n); out[o + 3] = 255;
    }
  }
  return { data: out, width: size, height: size };
}

/** Rest-pose skinning matrices + joint positions relative to the rig root (the pose is restored after). */
function restPose(rig, mesh) {
  const bones = mesh.skeleton.bones;
  const saved = bones.map((b) => [b.position.clone(), b.quaternion.clone(), b.scale.clone()]);
  rig.resetPose?.();
  const root = rig.root || mesh;
  root.updateMatrixWorld(true);
  const inv = root.matrixWorld.clone().invert();
  const B = bones.map((b, i) => new THREE.Matrix4().multiplyMatrices(inv, b.matrixWorld).multiply(mesh.skeleton.boneInverses[i]).multiply(mesh.bindMatrix));
  const joints = {};
  for (const b of bones) joints[b.name] = new THREE.Vector3().setFromMatrixPosition(b.matrixWorld).applyMatrix4(inv);
  bones.forEach((b, i) => { b.position.copy(saved[i][0]); b.quaternion.copy(saved[i][1]); b.scale.copy(saved[i][2]); });
  root.updateMatrixWorld(true);
  return { B, joints };
}

function zonesFor(rig, mesh, base) {
  const geo = mesh.geometry;
  if (ZONES.has(geo)) return ZONES.get(geo);
  let zones = null;
  try {
    const px = geo.attributes.uv && geo.attributes.skinIndex ? readPixels(base?.map?.image) : null;
    if (px) {
      const { B, joints } = restPose(rig, mesh);
      zones = analyzeZones(mesh, px, B, joints);
      geo.setAttribute('ofZone', new THREE.BufferAttribute(zones.attr.zone, 4, true));
      geo.setAttribute('ofPos', new THREE.BufferAttribute(zones.attr.pos, 3));
      delete zones.attr;
      delete zones.debug;
    }
  } catch (e) {
    console.warn('Outfit zones unavailable', e);
    zones = null;
  }
  ZONES.set(geo, zones);
  return zones;
}

function setLook(U, look) {
  const T = U.uOfTgt.value;
  const put = (i, hex) => { if (hex) { const l = hexToLab(hex); T[i].set(l[0], l[1], l[2], 1); } else T[i].set(0, 0, 0, 0); };
  put(0, look.jacket?.base); put(1, look.jacket ? look.jacket.accent || look.jacket.base : null);
  put(2, look.trousers?.base); put(3, look.trousers ? look.trousers.accent || look.trousers.base : null);
  put(4, look.helmet?.color); put(5, look.lens?.tint);
  const fin = FINISH[look.helmet?.finish] || FINISH.gloss;
  const m = Math.min(1, Math.max(0, look.lens?.mirror ?? 1));
  U.uOfPbr.value.set(fin[0], fin[1], 0.05 + 0.03 * m, 0.88 * m);
  U.uOfPbrOn.value.set(look.helmet ? 1 : 0, look.lens ? 1 : 0);
}

/**
 * Dress a skier rig. `outfit`: the equipped ids ({ jacket, trousers, helmet, lens }, see getEquipped),
 * a look ({ jacket: { base, accent }, trousers: {...}, helmet: { color, finish }, lens: { tint, mirror } }),
 * or null for the skier's original clothes. Only this rig changes (its material is cloned once).
 * Returns false when the model can't be recoloured (it then simply keeps its own look).
 */
export function applyOutfit(rig, charId, outfit) {
  try {
    const mesh = skinnedOf(rig);
    if (!mesh) return false;
    let st = RIGS.get(rig);
    if (!st || st.mesh !== mesh) { st = { mesh, base: mesh.material, mat: null }; RIGS.set(rig, st); }
    const look = outfit && OUTFIT_SLOTS.some((s) => typeof outfit[s] === 'string') ? outfitLook(outfit) : outfit;
    if (!look || !OUTFIT_SLOTS.some((s) => look[s])) { mesh.material = st.base; return true; }
    const zones = zonesFor(rig, mesh, st.base);
    if (!zones) { mesh.material = st.base; return false; }
    if (!st.mat) st.mat = outfitMaterial(st.base, zones);
    setLook(st.mat.userData.outfit, look);
    mesh.material = st.mat;
    return true;
  } catch (e) {
    console.warn('applyOutfit failed', e);
    return false;
  }
}

/** Which garment zones a rig's model has (runs the one-off analysis): { jacket, jacketAccent, trousers, trousersAccent, helmet, lens }. */
export function outfitZones(rig) {
  const mesh = skinnedOf(rig);
  if (!mesh) return null;
  const st = RIGS.get(rig);
  return zonesFor(rig, mesh, st?.base || mesh.material)?.has || null;
}
