// Builds the 2.5D layers for the boot-intro clip (src/ui/introclip.js) from the logo art
// assets-src/branding/ski-legacy-logo-v2.png (circle photo of a jumping skier + SKI / LEGACY wordmark on blue).
//
//   node tools/build-intro-clip.mjs [debugDir]
//
// Output (public/intro/clip/):
//   bg.webp        the photo inside the circle with the skier and the wordmark removed (push-pull inpaint +
//                  matched film grain), outpainted to the full square so the camera can start tight; 2x
//   skier.webp     the skier + skis + poles, un-composited against the clean sky (soft motion-blur edges,
//                  no sky fringe); 2x
//   ski.webp       the big distressed SKI wordmark; 2x, alpha edges re-sharpened after the upscale
//   legacy.webp    the spaced L E G A C Y letters + the thin rule under them; 2x
//   backdrop.webp  the deep-blue background without the circle (small: it is a smooth gradient)
//   clip.json      layout in source-pixel coordinates (circle, layer rects, LEGACY letter columns, rule)
//
// Un-compositing: for every layer pixel we solve I = a*F + (1-a)*B for the smallest alpha a that explains the
// observed colour I over the inpainted background B with a near-black (skier) or near-white (lettering)
// foreground F, so the layers carry their real soft edges and re-composite to the original logo exactly.
import sharp from 'sharp';
import fs from 'node:fs';

const SRC = 'assets-src/branding/ski-legacy-logo-v2.png';
const OUT = 'public/intro/clip';
const DBG = process.argv[2] || null;
const UP = 2; // export scale for the detailed layers
fs.mkdirSync(OUT, { recursive: true });
if (DBG) fs.mkdirSync(DBG, { recursive: true });

const { data: src8, info } = await sharp(SRC).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const W = info.width, H = info.height, N = W * H;
const I = new Float32Array(N * 3);
for (let i = 0; i < N * 3; i++) I[i] = src8[i];
const lum = (a, i) => 0.2126 * a[i * 3] + 0.7152 * a[i * 3 + 1] + 0.0722 * a[i * 3 + 2];
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };

// ------------------------------------------------------------------ helpers
/** Separable gaussian blur of a planar/interleaved float image with `ch` channels. */
function blur(img, w, h, ch, sigma) {
  const r = Math.max(1, Math.ceil(sigma * 3)), k = new Float32Array(r * 2 + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) s += (k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)));
  for (let i = 0; i < k.length; i++) k[i] /= s;
  const tmp = new Float32Array(img.length), out = new Float32Array(img.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < ch; c++) {
    let a = 0;
    for (let i = -r; i <= r; i++) a += k[i + r] * img[(y * w + clamp(x + i, 0, w - 1)) * ch + c];
    tmp[(y * w + x) * ch + c] = a;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < ch; c++) {
    let a = 0;
    for (let i = -r; i <= r; i++) a += k[i + r] * tmp[(clamp(y + i, 0, h - 1) * w + x) * ch + c];
    out[(y * w + x) * ch + c] = a;
  }
  return out;
}

/** Exact euclidean distance (px) from every pixel to the nearest set pixel of `mask` (Felzenszwalb). */
function distanceTo(mask, w, h) {
  const INF = 1e12, f = new Float64Array(Math.max(w, h)), d = new Float64Array(Math.max(w, h));
  const v = new Int32Array(Math.max(w, h)), z = new Float64Array(Math.max(w, h) + 1);
  const g = new Float64Array(w * h);
  const edt1 = (n) => {
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s;
      for (;;) { s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); if (s <= z[k]) k--; else break; }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]; }
  };
  for (let x = 0; x < w; x++) { for (let y = 0; y < h; y++) f[y] = mask[y * w + x] ? 0 : INF; edt1(h); for (let y = 0; y < h; y++) g[y * w + x] = d[y]; }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) { for (let x = 0; x < w; x++) f[x] = g[y * w + x]; edt1(w); for (let x = 0; x < w; x++) out[y * w + x] = Math.sqrt(d[x]); }
  return out;
}
const dilate = (mask, r) => { const d = distanceTo(mask, W, H); const o = new Uint8Array(N); for (let i = 0; i < N; i++) o[i] = d[i] <= r ? 1 : 0; return o; };
const erode = (mask, r) => { const inv = new Uint8Array(N); for (let i = 0; i < N; i++) inv[i] = mask[i] ? 0 : 1; const d = distanceTo(inv, W, H); const o = new Uint8Array(N); for (let i = 0; i < N; i++) o[i] = d[i] > r ? 1 : 0; return o; };

/** 8-connected components of `mask` -> { label Int32Array, comps: [{ id, area, x0, y0, x1, y1 }] }. */
function components(mask) {
  const label = new Int32Array(N), comps = [], stack = [];
  for (let s = 0; s < N; s++) {
    if (!mask[s] || label[s]) continue;
    const c = { id: comps.length + 1, area: 0, x0: W, y0: H, x1: 0, y1: 0 };
    label[s] = c.id; stack.push(s);
    while (stack.length) {
      const p = stack.pop(), x = p % W, y = (p / W) | 0;
      c.area++; c.x0 = Math.min(c.x0, x); c.x1 = Math.max(c.x1, x); c.y0 = Math.min(c.y0, y); c.y1 = Math.max(c.y1, y);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const q = ny * W + nx;
        if (mask[q] && !label[q]) { label[q] = c.id; stack.push(q); }
      }
    }
    comps.push(c);
  }
  return { label, comps };
}

/** Fill the enclosed holes of `mask` inside the box (anything the outside flood can't reach). */
function fillHoles(mask, box) {
  const { x0, y0, x1, y1 } = box, seen = new Uint8Array(N), stack = [];
  const push = (x, y) => { const q = y * W + x; if (!mask[q] && !seen[q]) { seen[q] = 1; stack.push(q); } };
  for (let x = x0; x <= x1; x++) { push(x, y0); push(x, y1); }
  for (let y = y0; y <= y1; y++) { push(x0, y); push(x1, y); }
  while (stack.length) {
    const p = stack.pop(), x = p % W, y = (p / W) | 0;
    if (x > x0) push(x - 1, y); if (x < x1) push(x + 1, y); if (y > y0) push(x, y - 1); if (y < y1) push(x, y + 1);
  }
  const o = mask.slice();
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const q = y * W + x; if (!seen[q]) o[q] = 1; }
  return o;
}

/** Push-pull scattered-data fill (Gortler et al.): fills pixels with weight 0 from their known surroundings. */
function pushPull(img, w, h, wt) {
  const levels = [{ w, h, c: new Float32Array(w * h * 3), a: new Float32Array(w * h) }];
  for (let i = 0; i < w * h; i++) { const a = wt[i]; levels[0].a[i] = a; for (let c = 0; c < 3; c++) levels[0].c[i * 3 + c] = img[i * 3 + c] * a; }
  while (levels.at(-1).w > 1 || levels.at(-1).h > 1) {
    const L = levels.at(-1), nw = Math.max(1, Math.ceil(L.w / 2)), nh = Math.max(1, Math.ceil(L.h / 2));
    const c = new Float32Array(nw * nh * 3), a = new Float32Array(nw * nh);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      let sa = 0, s0 = 0, s1 = 0, s2 = 0;
      // 4x4 tent footprint (smoother than a 2x2 box: no blocky coarse levels)
      for (let dy = -1; dy <= 2; dy++) for (let dx = -1; dx <= 2; dx++) {
        const sx = clamp(x * 2 + dx, 0, L.w - 1), sy = clamp(y * 2 + dy, 0, L.h - 1);
        const k = (dx === -1 || dx === 2 ? 1 : 3) * (dy === -1 || dy === 2 ? 1 : 3);
        const q = sy * L.w + sx;
        sa += k * L.a[q]; s0 += k * L.c[q * 3]; s1 += k * L.c[q * 3 + 1]; s2 += k * L.c[q * 3 + 2];
      }
      sa /= 16; s0 /= 16; s1 /= 16; s2 /= 16;
      const q = y * nw + x;
      if (sa > 1) { s0 /= sa; s1 /= sa; s2 /= sa; sa = 1; }
      a[q] = sa; c[q * 3] = s0; c[q * 3 + 1] = s1; c[q * 3 + 2] = s2;
    }
    levels.push({ w: nw, h: nh, c, a });
  }
  // pull: un-premultiply the coarsest level, then blend each finer level over its upsampled parent
  let up = null;
  for (let li = levels.length - 1; li >= 0; li--) {
    const L = levels[li], col = new Float32Array(L.w * L.h * 3);
    for (let y = 0; y < L.h; y++) for (let x = 0; x < L.w; x++) {
      const q = y * L.w + x, a = Math.min(1, L.a[q]);
      let p0 = 0, p1 = 0, p2 = 0;
      if (up) { // bilinear sample of the parent level
        const P = levels[li + 1], fx = clamp((x + 0.5) / 2 - 0.5, 0, P.w - 1), fy = clamp((y + 0.5) / 2 - 0.5, 0, P.h - 1);
        const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(P.w - 1, x0 + 1), y1 = Math.min(P.h - 1, y0 + 1), tx = fx - x0, ty = fy - y0;
        for (let c = 0; c < 3; c++) {
          const v = (up[(y0 * P.w + x0) * 3 + c] * (1 - tx) + up[(y0 * P.w + x1) * 3 + c] * tx) * (1 - ty)
            + (up[(y1 * P.w + x0) * 3 + c] * (1 - tx) + up[(y1 * P.w + x1) * 3 + c] * tx) * ty;
          if (c === 0) p0 = v; else if (c === 1) p1 = v; else p2 = v;
        }
      }
      // c is premultiplied by a (a <= 1): known colour where a = 1, the parent fills the rest
      col[q * 3] = L.c[q * 3] + (1 - a) * p0; col[q * 3 + 1] = L.c[q * 3 + 1] + (1 - a) * p1; col[q * 3 + 2] = L.c[q * 3 + 2] + (1 - a) * p2;
    }
    up = col;
  }
  return up;
}

/** Jacobi relaxation of the Laplace equation on the unknown pixels (smooths push-pull seams). */
function relax(img, w, h, unknown, iters) {
  let a = img.slice(), b = img.slice();
  const idx = [];
  for (let i = 0; i < w * h; i++) if (unknown[i]) { const x = i % w, y = (i / w) | 0; if (x > 0 && y > 0 && x < w - 1 && y < h - 1) idx.push(i); }
  for (let it = 0; it < iters; it++) {
    for (const i of idx) for (let c = 0; c < 3; c++) b[i * 3 + c] = 0.25 * (a[(i - 1) * 3 + c] + a[(i + 1) * 3 + c] + a[(i - w) * 3 + c] + a[(i + w) * 3 + c]);
    [a, b] = [b, a];
  }
  return a;
}

// deterministic noise
let seed = 1234567;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const gauss = () => { let u = 0; while (u === 0) u = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand()); };

const toU8 = (f) => { const o = new Uint8Array(f.length); for (let i = 0; i < f.length; i++) o[i] = clamp(Math.round(f[i]), 0, 255); return o; };
const dbg = async (name, f, w = W, h = H, ch = 3, crop = null) => {
  if (!DBG) return;
  let s = sharp(Buffer.from(toU8(f).buffer), { raw: { width: w, height: h, channels: ch } });
  if (crop) s = s.extract(crop);
  await s.png().toFile(`${DBG}/${name}.png`);
};
const dbgMask = (name, m, crop) => dbg(name, Float32Array.from(m, (v) => v * 255), W, H, 1, crop);

// ------------------------------------------------------------------ 1. the circle
// march rays out from the rough centre and take the strongest luminance step; least-squares circle fit
const L0 = new Float32Array(N);
for (let i = 0; i < N; i++) L0[i] = lum(I, i);
const edge = [];
for (let deg = 0; deg < 360; deg += 1.5) {
  const a = (deg * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
  let best = 0, br = 0;
  for (let r = 450; r < 530; r += 0.5) {
    const s = (rr) => { const x = Math.round(619 + ca * rr), y = Math.round(625 + sa * rr); return L0[y * W + x]; };
    const g = Math.abs(s(r - 1.5) - s(r + 1.5));
    if (g > best) { best = g; br = r; }
  }
  if (best > 18) edge.push([619 + ca * br, 625 + sa * br]);
}
// Kasa fit: x^2 + y^2 + D x + E y + F = 0
{
  let sxx = 0, sxy = 0, syy = 0, sx = 0, sy = 0, sxz = 0, syz = 0, sz = 0;
  for (const [x, y] of edge) { const z = x * x + y * y; sxx += x * x; sxy += x * y; syy += y * y; sx += x; sy += y; sxz += x * z; syz += y * z; sz += z; }
  const n = edge.length;
  // solve [sxx sxy sx; sxy syy sy; sx sy n] [D E F] = -[sxz syz sz]
  const A = [[sxx, sxy, sx, -sxz], [sxy, syy, sy, -syz], [sx, sy, n, -sz]];
  for (let i = 0; i < 3; i++) { for (let j = i + 1; j < 3; j++) { const f = A[j][i] / A[i][i]; for (let k = i; k < 4; k++) A[j][k] -= f * A[i][k]; } }
  const sol = [0, 0, 0];
  for (let i = 2; i >= 0; i--) { let v = A[i][3]; for (let k = i + 1; k < 3; k++) v -= A[i][k] * sol[k]; sol[i] = v / A[i][i]; }
  var CX = -sol[0] / 2, CY = -sol[1] / 2, R = Math.sqrt(CX * CX + CY * CY - sol[2]);
}
console.log(`circle: centre (${CX.toFixed(1)}, ${CY.toFixed(1)}) r ${R.toFixed(1)} from ${edge.length} edge samples`);
const rAt = (i) => Math.hypot((i % W) + 0.5 - CX, ((i / W) | 0) + 0.5 - CY);
// the printed disc is not perfectly round (rim radius 483..495 px): measure the rim per degree (median
// over a 9 degree window) so "inside the photo" follows the real edge
const RIM = (() => {
  const raw = new Float32Array(360);
  for (let deg = 0; deg < 360; deg++) {
    const a = (deg * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
    let best = 0, br = R;
    for (let r = R - 14; r < R + 14; r += 0.25) {
      const s = (rr) => L0[Math.round(CY + sa * rr) * W + Math.round(CX + ca * rr)];
      const g = Math.abs(s(r - 1.5) - s(r + 1.5));
      if (g > best) { best = g; br = r; }
    }
    raw[deg] = br;
  }
  const out = new Float32Array(360);
  for (let d = 0; d < 360; d++) { const w = []; for (let k = -4; k <= 4; k++) w.push(raw[(d + k + 360) % 360]); w.sort((a, b) => a - b); out[d] = w[4]; }
  return out;
})();
const rimAt = (i) => { let d = (Math.atan2(((i / W) | 0) + 0.5 - CY, (i % W) + 0.5 - CX) * 180) / Math.PI; if (d < 0) d += 360; const d0 = Math.floor(d) % 360, t = d - Math.floor(d); return RIM[d0] * (1 - t) + RIM[(d0 + 1) % 360] * t; };
console.log('rim radius range', Math.min(...RIM).toFixed(1), Math.max(...RIM).toFixed(1));

// ------------------------------------------------------------------ 2. masks
// 2a. the wordmark. SKI: near-white blobs (min channel high) inside its band, big components only (the
// distressed scratches in the photo are white too, but thin and small). LEGACY + rule: thin bright strokes
// clearly brighter than their local background.
const MN = new Float32Array(N);
for (let i = 0; i < N; i++) MN[i] = Math.min(I[i * 3], I[i * 3 + 1], I[i * 3 + 2]);
const SKI_BOX = { x0: 165, y0: 530, x1: 1060, y1: 822 };
const LEG_BOX = { x0: 330, y0: 782, x1: 900, y1: 832 };
const RULE_BOX = { x0: 525, y0: 852, x1: 725, y1: 874 };
const inBox = (i, b) => { const x = i % W, y = (i / W) | 0; return x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1; };

let skiMask = new Uint8Array(N);
for (let i = 0; i < N; i++) if (inBox(i, SKI_BOX) && MN[i] > 224) skiMask[i] = 1;
{
  const { label, comps } = components(skiMask);
  const keep = new Set(comps.filter((c) => c.area > 1500).map((c) => c.id));
  for (let i = 0; i < N; i++) skiMask[i] = keep.has(label[i]) ? 1 : 0;
  console.log('SKI components kept', [...keep].length, comps.filter((c) => c.area > 1500).map((c) => `${c.area}@${c.x0},${c.y0}-${c.x1},${c.y1}`).join(' '));
}
skiMask = fillHoles(skiMask, SKI_BOX); // the distress specks inside the letters
// close tiny notches along the edges (speck clusters that touch the outline)
skiMask = erode(dilate(skiMask, 2), 2);

// The lower-left tip of the S runs into the bright sun glow, where white-on-cream keying is unreliable.
// Its edges are straight (measured: bottom edge y = 743.6 for x <= 380; the slanted edge runs from
// (268, 688.5) to (179, 742.5)), so the tip is rebuilt from that geometry with analytic anti-aliasing.
const TIP = { x1: 330, y0: 684, y1: 760, bottom: 743.6, d0: [268, 688.5], d1: [179, 742.5] };
const tipCover = new Float32Array(N); // geometric alpha of the S tip (0 outside the tip zone)
const inTip = (i) => { const x = i % W, y = (i / W) | 0; return x < TIP.x1 && y >= TIP.y0 && y <= TIP.y1; };
{
  const [ax, ay] = TIP.d0, [bx, by] = TIP.d1, len = Math.hypot(bx - ax, by - ay);
  const nx = (by - ay) / len, ny = -(bx - ax) / len; // normal of the slanted edge
  for (let i = 0; i < N; i++) {
    if (!inTip(i)) continue;
    const px = (i % W) + 0.5, py = ((i / W) | 0) + 0.5;
    const dBottom = TIP.bottom - py;                       // > 0 above the bottom edge
    let dSlant = (px - ax) * nx + (py - ay) * ny;          // sign: inside = towards the stroke
    if (((300 - ax) * nx + (740 - ay) * ny) < 0) dSlant = -dSlant;
    const cov = clamp(0.5 + dBottom, 0, 1) * clamp(0.5 + dSlant, 0, 1);
    tipCover[i] = py > 690 ? cov : (skiMask[i] && px > 238 ? 1 : 0);
    skiMask[i] = tipCover[i] > 0.02 ? 1 : 0;
  }
  // left of the S's middle-bar end (x 238) only the tip is lettering: the rest is sun glow
  for (let i = 0; i < N; i++) if (skiMask[i] && !inTip(i) && (i % W) < 238) skiMask[i] = 0;
  for (let i = 0; i < N; i++) if (skiMask[i] && (i % W) < TIP.x1 && ((i / W) | 0) > TIP.y1) skiMask[i] = 0;
}

// local background level for the thin strokes: blur of the image with the bright strokes ignored
const LBG = (() => {
  const wt = new Float32Array(N).fill(1);
  for (let i = 0; i < N; i++) if (MN[i] > 150 && (inBox(i, LEG_BOX) || inBox(i, RULE_BOX))) wt[i] = 0;
  return blur(pushPull(I, W, H, wt), W, H, 3, 3);
})();
let legMask = new Uint8Array(N), ruleMask = new Uint8Array(N);
for (let i = 0; i < N; i++) {
  const d = lum(I, i) - lum(LBG, i);
  if (inBox(i, LEG_BOX) && !skiMask[i] && d > 40) legMask[i] = 1;
  if (inBox(i, RULE_BOX) && d > 28) ruleMask[i] = 1;
}
{
  const f = (m, min) => { const { label, comps } = components(m); const keep = new Set(comps.filter((c) => c.area >= min).map((c) => c.id)); for (let i = 0; i < N; i++) m[i] = keep.has(label[i]) ? 1 : 0; return comps.filter((c) => c.area >= min); };
  const lc = f(legMask, 25);
  const rc = f(ruleMask, 40);
  console.log('LEGACY components', lc.map((c) => `${c.area}@${c.x0}-${c.x1}`).join(' '), '| rule', rc.map((c) => `${c.area}@${c.x0}-${c.x1},${c.y0}-${c.y1}`).join(' '));
}

// 2b. the skier: clearly darker than a smooth estimate of the sky around him
const SK_BOX = { x0: 412, y0: 178, x1: 920, y1: 534 };
const sky0 = (() => {
  const wt = new Float32Array(N).fill(1);
  for (let i = 0; i < N; i++) if (inBox(i, SK_BOX) && L0[i] < 62) wt[i] = 0;
  const rough = new Uint8Array(N); for (let i = 0; i < N; i++) rough[i] = wt[i] ? 0 : 1;
  const grow = dilate(rough, 10);
  for (let i = 0; i < N; i++) if (grow[i]) wt[i] = 0;
  return blur(pushPull(I, W, H, wt), W, H, 3, 6);
})();
let skMask = new Uint8Array(N);
for (let i = 0; i < N; i++) if (inBox(i, SK_BOX) && rAt(i) < R - 3 && lum(sky0, i) - L0[i] > 7) skMask[i] = 1;
{
  const { label, comps } = components(skMask);
  const big = comps.filter((c) => c.area > 300);
  const keep = new Set(big.map((c) => c.id));
  for (let i = 0; i < N; i++) skMask[i] = keep.has(label[i]) ? 1 : 0;
  console.log('skier components', big.map((c) => `${c.area}@${c.x0},${c.y0}-${c.x1},${c.y1}`).join(' '));
}
// + whatever right next to him differs in colour from the sky: his sunlit face, the snow spray at his boots
{
  const near = dilate(skMask, 10);
  for (let i = 0; i < N; i++) {
    if (skMask[i] || !near[i] || rAt(i) >= R - 3) continue;
    const d = Math.hypot(I[i * 3] - sky0[i * 3], I[i * 3 + 1] - sky0[i * 3 + 1], I[i * 3 + 2] - sky0[i * 3 + 2]);
    if (d > 20) skMask[i] = 1;
  }
}
skMask = fillHoles(skMask, SK_BOX);

await dbgMask('mask-ski', skiMask, { left: 150, top: 520, width: 940, height: 370 });
await dbgMask('mask-leg', Uint8Array.from(legMask, (v, i) => v | ruleMask[i]), { left: 150, top: 520, width: 940, height: 370 });
await dbgMask('mask-skier', skMask, { left: 400, top: 170, width: 530, height: 380 });
await dbgMask('mask-ski2', skiMask, { left: 150, top: 520, width: 940, height: 370 });

// ------------------------------------------------------------------ 3. clean plate (inpaint)
const textAll = new Uint8Array(N);
for (let i = 0; i < N; i++) textAll[i] = skiMask[i] | legMask[i] | ruleMask[i];
const holeText = dilate(textAll, 4);
const holeSkier = dilate(skMask, 6);
const known = new Float32Array(N), holeIn = new Uint8Array(N), outside = new Uint8Array(N);
for (let i = 0; i < N; i++) {
  outside[i] = rAt(i) >= rimAt(i) - 3 ? 1 : 0;
  holeIn[i] = !outside[i] && (holeText[i] || holeSkier[i]) ? 1 : 0;
  known[i] = outside[i] || holeIn[i] ? 0 : 1;
}
let B = pushPull(I, W, H, known);
B = relax(B, W, H, holeIn, 400); // harmonic fill inside the holes (the push-pull result is its start)
// the outpainted ring beyond the circle: soften the radial smears of the rim scratches
{
  const soft = blur(B, W, H, 3, 5);
  for (let i = 0; i < N; i++) {
    if (!outside[i]) continue;
    const t = smooth(rimAt(i) - 3, rimAt(i) + 30, rAt(i));
    for (let c = 0; c < 3; c++) B[i * 3 + c] = B[i * 3 + c] * (1 - t) + soft[i * 3 + c] * t;
  }
}

// texture for everything that was filled: the fine detail (grain, mist streaks, print scratches) of the
// nearest fully-known patch is copied block by block onto the smooth fill, so no flat "hole" shows.
// Beyond the rim (the outpainted margin the tight opening shot sees) the same, from inside the circle.
const G = (() => { const b = blur(I, W, H, 3, 2); const g = new Float32Array(N * 3); for (let i = 0; i < N * 3; i++) g[i] = clamp(I[i] - b[i], -30, 30); return g; })();
const okDonor = new Uint8Array(N);
for (let i = 0; i < N; i++) okDonor[i] = known[i] && rAt(i) < rimAt(i) - 6 ? 1 : 0;
// local texture energy: what the donor patch has vs what the surroundings of the hole have
const E = (() => { const v = new Float32Array(N); for (let i = 0; i < N; i++) v[i] = Math.min(12, (Math.abs(G[i * 3]) + Math.abs(G[i * 3 + 1]) + Math.abs(G[i * 3 + 2])) / 3); return blur(v, W, H, 1, 8); })();
const Etarget = (() => {
  const v = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) v[i * 3] = v[i * 3 + 1] = v[i * 3 + 2] = E[i];
  const f = pushPull(v, W, H, Float32Array.from(known, (k, i) => (k && !holeIn[i] ? 1 : 0)));
  return Float32Array.from({ length: N }, (_, i) => f[i * 3]);
})();
const texGain = new Float32Array(N).fill(1);
const plate = B.slice();
for (let i = 0; i < N; i++) if (known[i]) for (let c = 0; c < 3; c++) plate[i * 3 + c] = I[i * 3 + c];
{
  // overlapping 32 px tiles at a 16 px stride, each from its own random donor offset, blended with
  // sine windows (the squared windows sum to 1, so the copied grain keeps its strength and seams vanish)
  const T = 32, S2 = 16, win = Float32Array.from({ length: T }, (_, t) => Math.sin((Math.PI * (t + 0.5)) / T));
  const cands = [];
  for (let dy = -480; dy <= 480; dy += 4) for (let dx = -480; dx <= 480; dx += 4) { const l = Math.hypot(dx, dy); if (l >= 30 && l <= 480) cands.push([dx, dy, l]); }
  const bySize = cands.slice().sort((a, b) => a[2] - b[2]);
  const tex = new Float32Array(N * 3);
  let misses = 0;
  for (let by = -S2; by < H; by += S2) for (let bx = -S2; bx < W; bx += S2) {
    const px = [];
    for (let y = Math.max(0, by); y < Math.min(H, by + T); y++) for (let x = Math.max(0, bx); x < Math.min(W, bx + T); x++) if (holeIn[y * W + x] || outside[y * W + x]) px.push(y * W + x);
    if (!px.length) continue;
    const valid = ([dx, dy]) => px.every((p) => { const x = (p % W) + dx, y = ((p / W) | 0) + dy; return x >= 0 && y >= 0 && x < W && y < H && okDonor[y * W + x]; });
    let off = null;
    for (let t = 0; t < 300 && !off; t++) { const c = cands[Math.floor(rand() * cands.length)]; if (valid(c)) off = c; }
    if (!off) off = bySize.find(valid);
    if (!off) { misses++; continue; }
      for (const p of px) {
      const x = p % W, y = (p / W) | 0, q = p + off[1] * W + off[0];
      const wgt = win[x - bx] * win[y - by] * clamp(Etarget[p] / Math.max(0.2, E[q]), 0.25, 1.15);
      for (let c = 0; c < 3; c++) tex[p * 3 + c] += wgt * G[q * 3 + c];
    }
  }
  for (let i = 0; i < N; i++) if (holeIn[i] || outside[i]) for (let c = 0; c < 3; c++) plate[i * 3 + c] = B[i * 3 + c] + tex[i * 3 + c] * texGain[i];
  if (misses) console.log('texture tiles without a donor', misses);
}
await dbg('plate', plate);
await dbg('plate-text', plate, W, H, 3, { left: 150, top: 520, width: 940, height: 370 });
await dbg('plate-skier', plate, W, H, 3, { left: 400, top: 170, width: 530, height: 380 });

// ------------------------------------------------------------------ 4. un-composite the layers
/** Smallest alpha explaining I over B with a dark (fk) or bright (fw) foreground; returns [a, r, g, b]. */
function uncomp(i, fk, fw) {
  const d0 = I[i * 3] - B[i * 3], d1 = I[i * 3 + 1] - B[i * 3 + 1], d2 = I[i * 3 + 2] - B[i * 3 + 2];
  const k0 = fk[0] - B[i * 3], k1 = fk[1] - B[i * 3 + 1], k2 = fk[2] - B[i * 3 + 2];
  const w0 = fw[0] - B[i * 3], w1 = fw[1] - B[i * 3 + 1], w2 = fw[2] - B[i * 3 + 2];
  const ak = (d0 * k0 + d1 * k1 + d2 * k2) / Math.max(1, k0 * k0 + k1 * k1 + k2 * k2);
  const aw = (d0 * w0 + d1 * w1 + d2 * w2) / Math.max(1, w0 * w0 + w1 * w1 + w2 * w2);
  const a = clamp(Math.max(ak, aw), 0, 1);
  if (a < 0.015) return [0, (ak > aw ? fk : fw)[0], (ak > aw ? fk : fw)[1], (ak > aw ? fk : fw)[2]];
  return [a, clamp(B[i * 3] + d0 / a, 0, 255), clamp(B[i * 3 + 1] + d1 / a, 0, 255), clamp(B[i * 3 + 2] + d2 / a, 0, 255)];
}

/** RGBA float layer over the given box; fn(i) -> [a, r, g, b]. */
function layer(box, fn) {
  const w = box.x1 - box.x0 + 1, h = box.y1 - box.y0 + 1, out = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (box.y0 + y) * W + box.x0 + x, [a, r, g, b] = fn(i), o = (y * w + x) * 4;
    out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a * 255;
  }
  return { w, h, px: out, box };
}
const bboxOf = (m, pad) => {
  let x0 = W, y0 = H, x1 = 0, y1 = 0;
  for (let i = 0; i < N; i++) if (m[i]) { const x = i % W, y = (i / W) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return { x0: Math.max(0, x0 - pad), y0: Math.max(0, y0 - pad), x1: Math.min(W - 1, x1 + pad), y1: Math.min(H - 1, y1 + pad) };
};

// skier: near-black silhouette (+ the white snow spray caught between his skis)
const skEdge = distanceTo(Uint8Array.from(holeSkier, (v) => (v ? 0 : 1)), W, H); // depth inside the region
const skierL = layer(bboxOf(holeSkier, 2), (i) => {
  if (!holeSkier[i]) return [0, 0, 0, 0];
  const [a, r, g, b] = uncomp(i, [3, 3, 7], [236, 238, 242]);
  const f = a * smooth(0.025, 0.09, a) * smooth(0.5, 2.5, skEdge[i]);
  return [f, r, g, b];
});

// lettering: white with its thin dark sharpening ring; the S tip from its geometry
const txEdge = distanceTo(Uint8Array.from(holeText, (v) => (v ? 0 : 1)), W, H);
const skiCore = erode(skiMask, 1);
const textFn = (i) => {
  if (!holeText[i]) return [0, 0, 0, 0];
  if (inTip(i) && ((i / W) | 0) > 690) {
    const a = tipCover[i];
    if (a <= 0) return [0, 251, 249, 247];
    // colour: the observed pixel un-mixed from the clean plate at the analytic coverage
    return [a, ...[0, 1, 2].map((c) => clamp((I[i * 3 + c] - (1 - a) * B[i * 3 + c]) / a, 0, 255))];
  }
  let [a, r, g, b] = uncomp(i, [12, 26, 52], [251, 249, 247]);
  const core = skiCore[i] ? smooth(226, 240, MN[i]) : 0;
  if (core > a) { a = core; [r, g, b] = [0, 1, 2].map((c) => clamp((I[i * 3 + c] - (1 - a) * B[i * 3 + c]) / a, 0, 255)); }
  const f = a * smooth(0.03, 0.1, a) * smooth(0.3, 1.5, txEdge[i]);
  return [f, r, g, b];
};
const skiBox = bboxOf(Uint8Array.from(holeText, (v, i) => v && ((i / W) | 0) <= SKI_BOX.y1 + 3 && inBox(i, { ...SKI_BOX, x0: 160, y1: SKI_BOX.y1 + 3 }) && !legMask[i] ? 1 : 0), 2);
const legBox = bboxOf(dilate(Uint8Array.from(legMask, (v, i) => v | ruleMask[i]), 3), 2);
// keep the I's tail (it dips into the LEGACY band) out of the LEGACY layer
const skiOnly = dilate(skiMask, 3), legOnly = dilate(Uint8Array.from(legMask, (v, i) => v | ruleMask[i]), 3);
const skiL = layer(skiBox, (i) => (skiOnly[i] ? textFn(i) : [0, 0, 0, 0]));
const legL = layer(legBox, (i) => (legOnly[i] && !skiOnly[i] ? textFn(i) : [0, 0, 0, 0]));
console.log('layers: skier', skierL.box, 'ski', skiBox, 'legacy', legBox);

// re-composite check: plate + skier + text should give back the logo
{
  const comp = plate.slice();
  for (const L of [skierL, skiL, legL]) {
    for (let y = 0; y < L.h; y++) for (let x = 0; x < L.w; x++) {
      const o = (y * L.w + x) * 4, a = L.px[o + 3] / 255; if (!a) continue;
      const i = (L.box.y0 + y) * W + L.box.x0 + x;
      for (let c = 0; c < 3; c++) comp[i * 3 + c] = L.px[o + c] * a + comp[i * 3 + c] * (1 - a);
    }
  }
  let err = 0, n = 0;
  for (let i = 0; i < N; i++) if (rAt(i) < R - 3) { for (let c = 0; c < 3; c++) { err += Math.abs(comp[i * 3 + c] - I[i * 3 + c]); n++; } }
  console.log('re-composite mean abs error', (err / n).toFixed(3));
  await dbg('recomposite', comp);
}
// layer previews over a checker so halos show
const preview = async (name, L) => {
  if (!DBG) return;
  const out = new Float32Array(L.w * L.h * 3);
  for (let y = 0; y < L.h; y++) for (let x = 0; x < L.w; x++) {
    const o = (y * L.w + x) * 4, a = L.px[o + 3] / 255, bgc = ((x >> 4) + (y >> 4)) & 1 ? 200 : 120;
    for (let c = 0; c < 3; c++) out[(y * L.w + x) * 3 + c] = L.px[o + c] * a + (c === 2 ? 60 : bgc) * (1 - a);
  }
  await dbg(name, out, L.w, L.h, 3);
};
await preview('layer-skier', skierL);
await preview('layer-ski', skiL);
await preview('layer-legacy', legL);

// ------------------------------------------------------------------ 5. the blue backdrop without the disc
// (its soft contact shadow is drawn at runtime, so the disc can scale independently of the backdrop)
const rimProfile = [];
const backdrop = (() => {
  const wt = new Float32Array(N);
  for (let i = 0; i < N; i++) wt[i] = rAt(i) > rimAt(i) + 48 ? 1 : 0;
  const f = blur(pushPull(I, W, H, wt), W, H, 3, 10);
  for (let i = 0; i < N; i++) if (wt[i]) for (let c = 0; c < 3; c++) f[i * 3 + c] = I[i * 3 + c];
  // how much darker than the clean backdrop the ring right outside the disc is (for the runtime shadow)
  for (const d of [1, 3, 6, 10, 15, 20, 30, 40]) {
    let s = 0, n = 0;
    for (let i = 0; i < N; i += 3) { const dr = rAt(i) - rimAt(i); if (Math.abs(dr - d) < 1) { s += lum(I, i) / Math.max(1, lum(f, i)); n++; } }
    rimProfile.push([d, +(s / n).toFixed(3)]);
  }
  return blur(f, W, H, 3, 2);
})();
console.log('backdrop ring brightness vs clean (dr: ratio)', rimProfile.map((p) => p.join(':')).join(' '));

// ------------------------------------------------------------------ 6. export
const u8 = (f) => Buffer.from(toU8(f).buffer);
const files = {};
async function writeRGB(name, f, w, h, outW, q) {
  const buf = await sharp(u8(f), { raw: { width: w, height: h, channels: 3 } })
    .resize(outW, null, { kernel: 'lanczos3' }).webp({ quality: q, effort: 6, smartSubsample: true }).toBuffer();
  fs.writeFileSync(`${OUT}/${name}`, buf); files[name] = buf.length;
}
/** RGBA layer -> UP x webp; `sharpen` steepens the alpha ramp of the bright (lettering) pixels after the upscale. */
async function writeLayer(name, L, sharpen = 0) {
  const { data, info: oi } = await sharp(u8(L.px), { raw: { width: L.w, height: L.h, channels: 4 } })
    .resize(L.w * UP, L.h * UP, { kernel: 'lanczos3' }).raw().toBuffer({ resolveWithObject: true });
  if (sharpen) {
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3] / 255, l = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      if (l < 150) continue;
      data[i + 3] = Math.round(clamp((a - 0.5) * sharpen + 0.5, 0, 1) * 255);
    }
  }
  const buf = await sharp(data, { raw: { width: oi.width, height: oi.height, channels: 4 } })
    .webp({ quality: 90, alphaQuality: 100, effort: 6 }).toBuffer();
  fs.writeFileSync(`${OUT}/${name}`, buf); files[name] = buf.length;
}
await writeRGB('bg.webp', plate, W, H, W * UP, 80);
await writeRGB('backdrop.webp', backdrop, W, H, 512, 92);
await writeLayer('skier.webp', skierL);
await writeLayer('ski.webp', skiL, 1.7);
await writeLayer('legacy.webp', legL, 1.4);

// skier: alpha centroid (rotation pivot) + where the ski tails are (snow burst origin)
let sa = 0, sx = 0, sy = 0;
for (let y = 0; y < skierL.h; y++) for (let x = 0; x < skierL.w; x++) { const a = skierL.px[(y * skierL.w + x) * 4 + 3] / 255; sa += a; sx += a * x; sy += a * y; }
// LEGACY letters: column ranges of the 6 letters (components grouped by gaps), and the rule
const cols = [];
{
  const { comps } = components(legMask);
  comps.sort((a, b) => a.x0 - b.x0);
  for (const c of comps) { const last = cols.at(-1); if (last && c.x0 - last[1] < 12) last[1] = Math.max(last[1], c.x1); else cols.push([c.x0, c.x1]); }
}
const ruleBox = bboxOf(ruleMask, 0);
// the sun: brightest spot of the plate inside the disc
let sun = [0, 0], best = -1;
{
  const bl = blur(plate, W, H, 3, 12);
  for (let i = 0; i < N; i += 2) if (rAt(i) < rimAt(i) - 30) { const l = lum(bl, i); if (l > best) { best = l; sun = [i % W, (i / W) | 0]; } }
}
const rect = (b) => ({ x: b.x0, y: b.y0, w: b.x1 - b.x0 + 1, h: b.y1 - b.y0 + 1 });
const layout = {
  source: SRC, size: W, scale: UP,
  circle: { cx: +CX.toFixed(2), cy: +CY.toFixed(2), r: +(RIM.reduce((a, b) => a + b, 0) / 360).toFixed(2) },
  shadow: rimProfile,
  skier: { ...rect(skierL.box), px: +(skierL.box.x0 + sx / sa).toFixed(1), py: +(skierL.box.y0 + sy / sa).toFixed(1) },
  ski: rect(skiL.box),
  legacy: { ...rect(legL.box), letters: cols, rule: rect(ruleBox) },
  sun,
  files,
};
fs.writeFileSync(`${OUT}/clip.json`, JSON.stringify(layout, null, 1));
console.log(JSON.stringify(layout));
console.log('total KB', (Object.values(files).reduce((a, b) => a + b, 0) / 1024).toFixed(0));
