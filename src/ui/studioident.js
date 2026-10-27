// Boot-intro scene 2: the Icecold Studio ident. The ICECOLD logotype -- custom letters cut on the 60-degree
// lattice of an ice crystal -- freezes into existence: frost feathers grow along every stroke, left to right,
// then the letters flash-freeze solid on the hit and STUDIO tracks in underneath. The sound (Audio.iceHit) is
// scheduled on the audio clock when the first frame goes up, so the crack lands on the frame.
// All vector, drawn on one canvas at devicePixelRatio by `identEngine`, which runs in a worker on an
// OffscreenCanvas (smooth while the game boots on the main thread; main-thread fallback otherwise) and lays
// itself out again on every resize (the app window goes fullscreen while the intro plays).
import interUrl from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2';

export const STUDIO_MS = 2350;      // first frame -> exit fade
export const STUDIO_LEAVE_MS = 550; // exit fade (.scene-studio transition)
export const STUDIO_HIT_S = 0.95;   // the freeze hit, seconds after the first frame
// look variants: ?studio=b in the URL picks the runner-up
export const STUDIO_VARIANTS = { a: { flat: 0.2 }, b: { flat: 0 } }; // b: sharp crystal points
const variant = () => { try { const v = new URLSearchParams(location.search).get('studio'); return STUDIO_VARIANTS[v] ? v : 'a'; } catch { return 'a'; } };

// Self-contained (it is stringified into the worker): no references to anything outside this function.
function identEngine() {
  const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
  const outCubic = (u) => 1 - (1 - u) ** 3;
  const outExpo = (u) => (u >= 1 ? 1 : 1 - 2 ** (-10 * u));
  const now = () => performance.now() / 1000;
  const frame = (cb) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : setTimeout(() => cb(performance.now()), 16));
  const unframe = (id) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : clearTimeout(id));

  // ------------------------------------------------------------------ the logotype (units: cap height = 1)
  // opts.flat: a short vertical flat on the hexagon points (0 = sharp crystal points)
  let OPT = { flat: 0.2 };
  const V = 0.235, HB = 0.19, DG = 0.222; // stem, bar and diagonal weights
  const HM = 0.18;                        // E's middle arm
  const SIN60 = Math.sin(Math.PI / 3);
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  // inner contour of a convex polygon, each edge moved inward by its own stroke weight
  function inset(P, th) {
    const n = P.length;
    let cx = 0, cy = 0;
    for (const p of P) { cx += p[0] / n; cy += p[1] / n; }
    const ln = P.map((p, i) => {
      const q = P[(i + 1) % n], l = Math.hypot(q[0] - p[0], q[1] - p[1]);
      const dx = (q[0] - p[0]) / l, dy = (q[1] - p[1]) / l;
      let nx = -dy, ny = dx;
      if ((cx - (p[0] + q[0]) / 2) * nx + (cy - (p[1] + q[1]) / 2) * ny < 0) { nx = -nx; ny = -ny; }
      return { x: p[0] + nx * th[i], y: p[1] + ny * th[i], dx, dy };
    });
    return P.map((_, i) => {
      const a = ln[(i - 1 + n) % n], b = ln[i];
      const t = ((b.x - a.x) * b.dy - (b.y - a.y) * b.dx) / (a.dx * b.dy - a.dy * b.dx);
      return [a.x + a.dx * t, a.y + a.dy * t];
    });
  }
  // flat-top hexagon of width W (60-degree sides), points optionally blunted by a flat of height f:
  // 0 top-left, 1 top-right, 2-3 right point, 4 bottom-right, 5 bottom-left, 6-7 left point
  function hexagon(W) {
    const f = Math.max(1e-4, OPT.flat), r = (0.5 - f / 2) / Math.sqrt(3), y0 = 0.5 - f / 2, y1 = 0.5 + f / 2;
    const o = [[r, 0], [W - r, 0], [W, y0], [W, y1], [W - r, 1], [r, 1], [0, y1], [0, y0]];
    const pt = OPT.flat > 0.01 ? V : DG / SIN60; // a sharp point: both diagonals meet
    const i = inset(o, [HB, DG, pt, DG, HB, DG, pt, DG]);
    return { o, i, m: o.map((p, k) => mid(p, i[k])), r };
  }
  // each glyph: advance w, polygons (even-odd), skel = stroke centrelines the frost grows along (d0: delay in
  // units of growth distance, i.e. it starts when the parent stroke's front gets there)
  const G = {
    I: () => ({ w: V, polys: [[[0, 0], [V, 0], [V, 1], [0, 1]]], skel: [{ pts: [[V / 2, 1], [V / 2, 0]] }] }),
    C: (Wv = 1.0, Wc = 0.84) => {
      const { o, i, m } = hexagon(Wv);
      const poly = [[Wc, 0], o[0], o[7], o[6], o[5], [Wc, 1], [Wc, 1 - HB], i[5], i[6], i[7], i[0], [Wc, HB]];
      const mL = mid(m[6], m[7]);
      return { w: Wc, polys: [poly], skel: [{ pts: [mL, m[7], m[0], [Wc, HB / 2]] }, { pts: [mL, m[6], m[5], [Wc, 1 - HB / 2]] }] };
    },
    E: (We = 0.74, Wm = 0.68) => ({
      w: We,
      polys: [[[0, 0], [We, 0], [We, HB], [V, HB], [V, 0.5 - HM / 2], [Wm, 0.5 - HM / 2], [Wm, 0.5 + HM / 2], [V, 0.5 + HM / 2], [V, 1 - HB], [We, 1 - HB], [We, 1], [0, 1]]],
      skel: [{ pts: [[V / 2, 1], [V / 2, 0]] }, { d0: HB / 2, pts: [[V / 2, 1 - HB / 2], [We, 1 - HB / 2]] }, { d0: 0.5, pts: [[V / 2, 0.5], [Wm, 0.5]] }, { d0: 1 - HB / 2, pts: [[V / 2, HB / 2], [We, HB / 2]] }],
    }),
    O: (W = 1.04) => {
      const { o, i, m } = hexagon(W), mL = mid(m[6], m[7]), mR = mid(m[2], m[3]);
      return { w: W, polys: [o, i], skel: [{ pts: [mL, m[7], m[0], m[1], m[2], mR] }, { pts: [mL, m[6], m[5], m[4], m[3], mR] }] };
    },
    L: (W = 0.68) => ({ w: W, polys: [[[0, 0], [V, 0], [V, 1 - HB], [W, 1 - HB], [W, 1], [0, 1]]], skel: [{ pts: [[V / 2, 1 - HB / 2], [V / 2, 0]] }, { pts: [[V / 2, 1 - HB / 2], [W, 1 - HB / 2]] }] }),
    D: (W = 0.96) => {
      const { o: hx, r } = hexagon(2 * W); // the right half of a hexagon on a stem
      const o = [[0, 0], [W - r, 0], [W, hx[2][1]], [W, hx[3][1]], [W - r, 1], [0, 1]];
      const pt = OPT.flat > 0.01 ? V : DG / SIN60;
      const i = inset(o, [HB, DG, pt, DG, HB, V]), m = o.map((p, k) => mid(p, i[k])), mR = mid(m[2], m[3]);
      return { w: W, polys: [o, i], skel: [{ pts: [[V / 2, 0.5], m[0], m[1], m[2], mR] }, { pts: [[V / 2, 0.5], m[5], m[4], m[3], mR] }] };
    },
  };
  // optical spacing after each letter: the crystal points need room, or I + C reads as K
  const GAPS = { sharp: [0.14, 0.085, 0.09, 0.05, 0.1, 0.075], flat: [0.105, 0.085, 0.07, 0.045, 0.085, 0.075] };
  let glyphs = [], WORD_W = 0;
  function buildWord() {
    const gaps = OPT.flat > 0.01 ? GAPS.flat : GAPS.sharp;
    glyphs = []; WORD_W = 0;
    [...'ICECOLD'].forEach((ch, k) => { const g = G[ch](); g.x = WORD_W; glyphs.push(g); WORD_W += g.w + (gaps[k] || 0); });
  }
  buildWord();

  function inside(polys, x, y) {
    let c = false;
    for (const P of polys) for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
      const a = P[i], b = P[j];
      if ((a[1] > y) !== (b[1] > y) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
    }
    return c;
  }
  // how far a ray from (x, y) runs before it leaves the letter
  function reach(polys, x, y, dx, dy, max) {
    let d = 0;
    while (d < max && inside(polys, x + dx * (d + 0.005), y + dy * (d + 0.005))) d += 0.005;
    return d;
  }

  // ------------------------------------------------------------------ timeline (s)
  let HIT = 0.95;
  const GROW0 = 0.06, STAGGER = 0.045, SPEED = 3.3, SIDE_SPEED = 1.8;

  // frost feathers: a main stem along every stroke, side branches at 60 degrees reaching for the edges,
  // barbules on those parallel to the stem (how frost ferns grow on a window). Segment: x1,y1,x2,y2,t0,t1.
  function growFrost() {
    let seed = 20261026;
    const rnd = (a = 0, b = 1) => a + (b - a) * ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const segs = [[], [], []];
    glyphs.forEach((g, li) => {
      const tL = GROW0 + li * STAGGER;
      for (const sk of g.skel) {
        let d = sk.d0 || 0;
        for (let k = 0; k + 1 < sk.pts.length; k++) {
          const a = sk.pts[k], b = sk.pts[k + 1], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
          const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len, dir = Math.atan2(uy, ux);
          segs[0].push([g.x + a[0], a[1], g.x + b[0], b[1], tL + d / SPEED, tL + (d + len) / SPEED]);
          for (let s = rnd(0.004, 0.02); s < len; s += rnd(0.02, 0.042)) {
            const px = a[0] + ux * s, py = a[1] + uy * s, tb = tL + (d + s) / SPEED + 0.01;
            for (const side of [-1, 1]) {
              if (rnd() < 0.12) continue;
              const ang = dir + side * (Math.PI / 3 + rnd(-0.09, 0.09)), dx = Math.cos(ang), dy = Math.sin(ang);
              const room = reach(g.polys, px, py, dx, dy, 0.2);
              if (room < 0.025) continue;
              const L = room * rnd(0.72, 0.98), te = tb + L / SIDE_SPEED;
              segs[1].push([g.x + px, py, g.x + px + dx * L, py + dy * L, tb, te]);
              for (let b = rnd() < 0.5 ? 2 : 1; b > 0; b--) {
                const f = rnd(0.25, 0.75), qx = px + dx * L * f, qy = py + dy * L * f, tq = tb + (L * f) / SIDE_SPEED + 0.008;
                const a2 = ang - side * (Math.PI / 3) * (rnd() < 0.8 ? 1 : -1), ex = Math.cos(a2), ey = Math.sin(a2);
                const r2 = reach(g.polys, qx, qy, ex, ey, 0.09);
                if (r2 > 0.012) { const L2 = r2 * rnd(0.5, 0.95); segs[2].push([g.x + qx, qy, g.x + qx + ex * L2, qy + ey * L2, tq, tq + L2 / SIDE_SPEED]); }
              }
            }
          }
          d += len;
        }
      }
    });
    return segs;
  }
  let frost = growFrost();

  // ------------------------------------------------------------------ drawing
  const BG = [5, 8, 13], BG_HIT = [13, 19, 26];
  const INK = '#f2f7fb', SUB = '#9fb3c4';
  const FROST = ['rgba(236,248,255,1)', 'rgba(200,232,255,0.7)', 'rgba(180,220,248,0.5)'];
  const EDGE = 'rgba(150,205,240,0.55)'; // the letters' edges, frozen first
  const ETCH = 'rgb(124,164,196)'; // the frost left on the face of the frozen letters, fading
  const LW = [0.01, 0.0052, 0.0042];
  const FONT = "'IcecoldInter', 'Inter Variable', 'Helvetica Neue', Arial, sans-serif";
  const LABEL = 'STUDIO';

  let cv, ctx, vw = 1, vh = 1, dpr = 1, lay = null, wordPath = null, letterPaths = null, fontReady = false;
  let t0 = -1, fixedT = null, raf = 0, stopped = true;
  let dims = null;
  let frames = 0, maxGap = 0, lastFrame = 0;

  function size(w, h, d) {
    vw = w; vh = h; dpr = d;
    cv.width = Math.max(1, Math.round(w * d)); cv.height = Math.max(1, Math.round(h * d));
    // wordmark: as tall as 16% of the screen, at most 70% of its width; STUDIO under it
    const H = Math.max(18, Math.min(vh * 0.16, (vw * 0.7) / WORD_W));
    const capS = 0.155 * H, gap = 0.37 * H, total = H + gap + capS;
    const cx = vw / 2, cy = vh / 2 - vh * 0.012;
    lay = { H, cx, cy, ox: cx - (WORD_W * H) / 2, oy: cy - total / 2, sub: cy - total / 2 + H + gap + capS, fs: capS / 0.727 };
  }

  function buildPaths() {
    wordPath = new Path2D();
    letterPaths = glyphs.map((g) => {
      const p = new Path2D();
      g.per = 0;
      for (const P of g.polys) {
        g.per = Math.max(g.per, P.reduce((a, q, k) => a + Math.hypot(P[(k + 1) % P.length][0] - q[0], P[(k + 1) % P.length][1] - q[1]), 0));
        p.moveTo(g.x + P[0][0], P[0][1]);
        for (let i = 1; i < P.length; i++) p.lineTo(g.x + P[i][0], P[i][1]);
        p.closePath();
      }
      wordPath.addPath(p);
      return p;
    });
  }

  function drawFrost(c, t, k, px, etch) {
    c.lineCap = 'round';
    for (let n = 0; n < 3; n++) {
      c.beginPath();
      for (const s of frost[n]) {
        if (t <= s[4]) continue;
        const p = t >= s[5] ? 1 : (t - s[4]) / (s[5] - s[4]);
        c.moveTo(s[0], s[1]);
        c.lineTo(s[0] + (s[2] - s[0]) * p, s[1] + (s[3] - s[1]) * p);
      }
      c.lineWidth = Math.max(LW[n], px);
      c.strokeStyle = etch ? ETCH : FROST[n];
      c.globalAlpha = k * (etch ? [0.9, 0.75, 0.6][n] : 1);
      c.stroke();
    }
    // the growing tips: bright points racing along the strokes
    if (!etch && k > 0) {
      c.fillStyle = '#ffffff'; c.globalAlpha = k;
      const r = Math.max(0.011, px * 1.3);
      c.beginPath();
      for (const s of frost[0]) {
        if (t <= s[4] || t >= s[5]) continue;
        const p = (t - s[4]) / (s[5] - s[4]), x = s[0] + (s[2] - s[0]) * p, y = s[1] + (s[3] - s[1]) * p;
        c.moveTo(x + r, y); c.arc(x, y, r, 0, 6.2832);
      }
      c.fill();
    }
  }

  function draw(t) {
    const c = ctx, L = lay, since = t - HIT, hit = since >= 0;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1;
    // a pulse of cold light on the hit
    const fl = hit ? Math.exp(-since / 0.2) : 0;
    c.fillStyle = `rgb(${BG.map((v, i) => Math.round(v + (BG_HIT[i] - v) * fl)).join(',')})`;
    c.fillRect(0, 0, cv.width, cv.height);
    // camera: a slow push, a punch on the hit, a short jolt
    let sc = 1 + 0.024 * Math.min(t, 3.4) / 3;
    let jx = 0, jy = 0;
    if (hit) {
      sc += 0.013 * Math.exp(-since / 0.11) * Math.min(1, since / 0.012);
      const j = 2.4 * Math.exp(-since / 0.065);
      jx = j * Math.sin(since * 6.2832 * 23); jy = j * Math.cos(since * 6.2832 * 17);
    }
    const k = dpr * sc * L.H;
    c.setTransform(k, 0, 0, k, dpr * (L.cx + sc * (L.ox - L.cx) + jx), dpr * (L.cy + sc * (L.oy - L.cy) + jy));
    const px = 1 / k; // one device pixel in letter units
    if (!hit) {
      // each letter's edges freeze first: a hairline traced around it as its frost spreads
      c.strokeStyle = EDGE; c.lineWidth = Math.max(0.006, px); c.lineJoin = 'miter';
      glyphs.forEach((g, i) => {
        const u = clamp((t - GROW0 - i * STAGGER) / 0.42);
        if (u <= 0) return;
        c.globalAlpha = Math.min(1, u * 3);
        c.setLineDash(u < 1 ? [g.per * outCubic(u), g.per] : []);
        c.stroke(letterPaths[i]);
      });
      c.setLineDash([]);
      drawFrost(c, t, 1, px, false);
    } else {
      c.globalAlpha = 1; c.fillStyle = INK; c.fill(wordPath, 'evenodd');
      const e = 1 - clamp(since / 0.55);
      if (e > 0) drawFrost(c, t, e * e * 0.55, px, true);
    }
    // STUDIO tracks in under the wordmark
    const u = clamp((t - HIT - 0.14) / 0.75);
    if (u > 0) {
      const e = outExpo(u), fs = L.fs, sp = fs * (0.36 + 0.5 * (1 - e));
      c.setTransform(dpr * sc, 0, 0, dpr * sc, dpr * (L.cx * (1 - sc) + jx), dpr * (L.cy * (1 - sc) + jy));
      c.font = `600 ${fs.toFixed(2)}px ${FONT}`;
      c.textBaseline = 'alphabetic'; c.textAlign = 'left';
      const ws = [...LABEL].map((ch) => c.measureText(ch).width);
      const total = ws.reduce((a, b) => a + b, 0) + sp * (LABEL.length - 1);
      let x = L.cx - total / 2;
      c.fillStyle = SUB; c.globalAlpha = outCubic(clamp(u * 1.6));
      [...LABEL].forEach((ch, i) => { c.fillText(ch, x, L.sub); x += ws[i] + sp; });
    }
    c.globalAlpha = 1;
  }

  const curT = () => (fixedT != null ? fixedT : t0 >= 0 ? now() - t0 : 0);
  function tick() {
    if (stopped) return;
    const n = now();
    if (lastFrame) maxGap = Math.max(maxGap, n - lastFrame);
    lastFrame = n; frames++;
    draw(curT());
    raf = frame(tick);
  }

  async function loadFont(url) {
    try {
      const set = typeof document !== 'undefined' ? document.fonts : self.fonts;
      if (!set || !url || typeof FontFace === 'undefined') return false;
      const r = await fetch(url);
      if (!r.ok) return false;
      const face = new FontFace('IcecoldInter', await r.arrayBuffer(), { weight: '100 900' });
      await face.load();
      set.add(face);
      return true;
    } catch { return false; }
  }

  return {
    width: WORD_W,
    // the wordmark as SVG path data (static fallback)
    svgPath() {
      return glyphs.map((g) => g.polys.map((P) => 'M' + P.map((p) => `${(g.x + p[0]).toFixed(4)} ${p[1].toFixed(4)}`).join('L') + 'Z').join('')).join('');
    },
    async msg(m, send) {
      if (m.type === 'init') {
        try {
          cv = m.canvas; ctx = cv.getContext('2d', { alpha: false });
          if (m.hit) HIT = m.hit;
          if (m.opts) { OPT = { ...OPT, ...m.opts }; buildWord(); frost = growFrost(); }
          buildPaths();
          fontReady = await loadFont(m.fontUrl);
          const d = dims || m;
          size(d.w, d.h, d.dpr);
          draw(curT());
          send({ type: 'ready', font: fontReady });
        } catch (e) { send({ type: 'error', message: String(e?.message || e) }); }
      } else if (m.type === 'go') {
        t0 = now(); stopped = false; raf = frame(tick);
      } else if (m.type === 'seek') {
        fixedT = m.t;
        if (lay) { draw(m.t); send({ type: 'drawn', t: m.t }); }
      } else if (m.type === 'resize') {
        dims = m;
        if (!lay) return; // applied at init
        size(m.w, m.h, m.dpr);
        draw(curT());
      } else if (m.type === 'stats') {
        send({ type: 'stats', frames, maxGap, t: curT() });
      } else if (m.type === 'stop') {
        stopped = true; unframe(raf);
      }
    },
  };
}

/** Plays the Icecold Studio ident inside `host` (an .intro-scene element). */
export class StudioIdent {
  constructor(host, audio) {
    this.host = host;
    this.audio = audio;
    this.worker = null;
    this.engine = null;
    this.ro = null;
    this.sound = null;
    this.onMessage = null; // test hook
  }

  send(m) {
    if (this.worker) this.worker.postMessage(m);
    else this.engine?.msg(m, this.recv);
  }

  /**
   * Loads and starts the ident; resolves true once the first frame is up (the sound is scheduled then),
   * false if it can't play (call fallback()). `still`: draw frames on demand only (seek) - for tests.
   */
  start({ timeoutMs = 2500, still = false, opts = STUDIO_VARIANTS[variant()] } = {}) {
    const canvas = document.createElement('canvas');
    canvas.className = 'studio-canvas';
    this.host.appendChild(canvas);
    const dims = () => ({ w: Math.max(1, this.host.clientWidth || innerWidth), h: Math.max(1, this.host.clientHeight || innerHeight), dpr: Math.min(2, devicePixelRatio || 1) });
    const init = { type: 'init', fontUrl: new URL(interUrl, document.baseURI).href, hit: STUDIO_HIT_S, opts, ...dims() };
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => { if (!done) { done = true; clearTimeout(timer); resolve(ok); } };
      this.abort = () => finish(false); // skipped while still loading
      const timer = setTimeout(() => finish(false), timeoutMs);
      this.recv = (m) => {
        if (m.type === 'ready') {
          if (done) return; // too late: the fallback is up
          if (!still) {
            this.sound = this.audio?.iceHit?.(STUDIO_HIT_S) || null;
            this.send({ type: 'go' });
          }
          finish(true);
        } else if (m.type === 'error') { console.warn('[studio ident]', m.message); finish(false); }
        this.onMessage?.(m);
      };
      try {
        if (typeof OffscreenCanvas === 'undefined' || !canvas.transferControlToOffscreen || typeof Worker === 'undefined') throw new Error('no offscreen');
        const src = `const engine = (${identEngine.toString()})();\nself.onmessage = (e) => engine.msg(e.data, (m) => self.postMessage(m));`;
        const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
        this.worker = new Worker(url);
        URL.revokeObjectURL(url);
        this.worker.onmessage = (e) => this.recv(e.data);
        this.worker.onerror = (e) => { console.warn('[studio ident] worker', e.message); finish(false); };
        const off = canvas.transferControlToOffscreen();
        this.worker.postMessage({ ...init, canvas: off }, [off]);
      } catch {
        // main-thread fallback (same engine)
        this.worker = null;
        this.engine = identEngine();
        this.engine.msg({ ...init, canvas }, this.recv);
      }
      this.ro = new ResizeObserver(() => this.send({ type: 'resize', ...dims() }));
      this.ro.observe(this.host);
    });
  }

  /** Static lockup (vector) when the canvas can't play: fades in with the hit sound. */
  fallback() {
    this.stopEngine();
    this.host.querySelector('.studio-canvas')?.remove();
    const e = identEngine();
    const el = document.createElement('div');
    el.className = 'studio-static';
    el.innerHTML = `<svg viewBox="-0.02 -0.02 ${(e.width + 0.04).toFixed(3)} 1.04" preserveAspectRatio="xMidYMid meet"><path fill-rule="evenodd" d="${e.svgPath()}"/></svg><div class="studio-static-sub">STUDIO</div>`;
    this.host.appendChild(el);
    if (!this.sound) this.sound = this.audio?.iceHit?.(0.3) || null;
  }

  stopEngine() {
    this.ro?.disconnect(); this.ro = null;
    if (this.worker) { this.worker.postMessage({ type: 'stop' }); this.worker.terminate(); this.worker = null; }
    this.engine?.msg({ type: 'stop' }, () => {});
    this.engine = null;
  }

  /** Ends the ident (skip / scene over); the sound's tail fades rather than cutting off. */
  stop(fade = 0.35) {
    this.abort?.();
    this.stopEngine();
    this.sound?.stop(fade);
    this.sound = null;
  }
}
