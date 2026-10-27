// Boot-intro opening clip: the skier from the Ski Legacy logo takes off and rises into his logo pose, then the
// camera whips back to reveal the whole badge on blue and SKI slams in, LEGACY + rule sweep in under it.
// 2.5D from the logo art itself: the layers (clean sky plate, skier, wordmark) are cut by
// tools/build-intro-clip.mjs into public/intro/clip/. Everything is drawn on one canvas at devicePixelRatio
// by `clipEngine`, which runs in a worker on an OffscreenCanvas (smooth while the game boots on the main
// thread) and falls back to the main thread when workers / OffscreenCanvas are unavailable.
import './introclip.css';

const FILES = { bg: 'bg.webp', backdrop: 'backdrop.webp', skier: 'skier.webp', ski: 'ski.webp', legacy: 'legacy.webp' };
export const CLIP_MS = 4250; // until the hold ends (the scene then fades out)

// Self-contained (it is stringified into the worker): no references to anything outside this function.
function clipEngine() {
  const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
  const outCubic = (u) => 1 - (1 - u) ** 3;
  const inOutCubic = (u) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);
  const mkCanvas = (w, h) => new OffscreenCanvas(Math.max(1, Math.ceil(w)), Math.max(1, Math.ceil(h)));

  // timeline (seconds)
  const RISE = 1.45, ZOOM0 = 1.0, ZOOM1 = 1.95, SLAM0 = 1.8, IMPACT = 2.0, LEG0 = 2.22, RULE0 = 2.45, SWEEP0 = 2.32, END = 4.25;
  // skier take-off: offset from the logo pose (world px), tilt (rad), extra scale
  const D0X = -210, D0Y = 280, ROT0 = -0.3, SC0 = 0.1;
  const ZA0 = 2.25, ZA1 = 2.0; // opening zoom (x the final framing)

  let cv, ctx, L, img, vw = 1, vh = 1, dpr = 1, sF = 1, rBig = 900, t0 = -1, raf = 0, stopped = false, post = () => {};
  let dims = null; // latest viewport size (the window can resize while the clip loads: the app goes fullscreen)
  let acc, actx, glow, puff, vig, sweepC, sweepX;
  let cueI = 0;
  const cues = [[0.02, 'whoosh'], [IMPACT, 'slam'], [IMPACT + 0.3, 'announce'], [LEG0 + 0.04, 'tick']];
  let seed = 11;
  const rnd = (a = 0, b = 1) => a + (b - a) * ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const burst = [], puffs = [], streaks = [], dust = [], flakes = [];
  const now = () => performance.now() / 1000;
  const frame = (cb) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : setTimeout(() => cb(performance.now()), 16));
  const unframe = (id) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : clearTimeout(id));

  function size(w, h, d) {
    vw = w; vh = h; dpr = d;
    cv.width = Math.round(w * d); cv.height = Math.round(h * d);
    acc = mkCanvas(cv.width, cv.height); actx = acc.getContext('2d');
    sF = Math.min(vh * 0.385, vw * 0.3) / L.circle.r;
    // mask radius during the opening: past the farthest corner the opening shot can see
    const s = state(ZOOM0);
    rBig = 1.12 * Math.hypot(vw / 2 / s.bz + Math.abs(s.bx - L.circle.cx), vh / 2 / s.bz + Math.abs(s.by - L.circle.cy));
  }

  // camera + skier pose at time t (world = logo source pixels)
  function state(t) {
    const C = L.circle, P = L.skier;
    const u = clamp(t / RISE);
    const ex = 1 - (1 - u) ** 2, ey = 1 - (1 - u) ** 3, er = outCubic(u);
    const dx = D0X * (1 - ex), dy = D0Y * (1 - ey);
    const hold = 1 + 0.025 * sstep(IMPACT, END + 0.6, t);
    const zF = sF * hold, zA = sF * lerp(ZA0, ZA1, u);
    const ax = P.px + dx * 0.6 + 20, ay = P.py + dy * 0.62 - 25 * (1 - u);
    const p = inOutCubic(clamp((t - ZOOM0) / (ZOOM1 - ZOOM0)) ** 0.85);
    const z = Math.exp(lerp(Math.log(zA), Math.log(zF), p));
    const cx = lerp(ax, C.cx, p), cy = lerp(ay, C.cy, p);
    return {
      u, p, z, cx, cy, dx, dy, rot: ROT0 * (1 - er), sc: 1 + SC0 * (1 - er),
      bz: zF * (z / zF) ** 0.9, bx: C.cx + (cx - C.cx) * 0.6, by: C.cy + (cy - C.cy) * 0.6,
      rm: lerp(rBig, C.r, sstep(0, 0.9, p)),
    };
  }
  function shake(t) {
    let x = 0, y = 0;
    const a = 2.4 * (1 - sstep(0.9, 1.9, t));
    x += a * (Math.sin(6.28 * 1.7 * t + 1) + 0.6 * Math.sin(6.28 * 3.1 * t + 2));
    y += a * (Math.sin(6.28 * 1.3 * t + 4) + 0.6 * Math.sin(6.28 * 2.7 * t + 5));
    const j = 7 * Math.exp(-t / 0.1);
    x += j * Math.sin(6.28 * 17 * t); y += j * Math.cos(6.28 * 13 * t);
    if (t >= IMPACT) { const k = 11 * Math.exp(-(t - IMPACT) / 0.11); x += k * Math.sin(6.28 * 24 * (t - IMPACT)); y += k * Math.cos(6.28 * 19 * (t - IMPACT)); }
    return [x, y];
  }
  const setPlane = (c, cx, cy, z, sh) => c.setTransform(z * dpr, 0, 0, z * dpr, dpr * (vw / 2 - cx * z + sh[0]), dpr * (vh / 2 - cy * z + sh[1]));
  const toScreen = (x, y, cx, cy, z, sh) => [vw / 2 + (x - cx) * z + sh[0], vh / 2 + (y - cy) * z + sh[1]];

  function drawSkier(c, s, sh) {
    const P = L.skier, k = L.scale;
    setPlane(c, s.cx, s.cy, s.z, sh);
    c.translate(P.px + s.dx, P.py + s.dy); c.rotate(s.rot); c.scale(s.sc, s.sc); c.translate(-P.px, -P.py);
    c.drawImage(img.skier, 0, 0, P.w * k, P.h * k, P.x, P.y, P.w, P.h);
  }
  function drawPlate(c, s, sh) {
    const S = L.size, E = 4000, i = img.bg, iw = i.width, ih = i.height;
    setPlane(c, s.bx, s.by, s.bz, sh);
    c.drawImage(i, 0, 0, iw, ih, 0, 0, S, S);
    if (s.rm > 560) { // clamp-to-edge margin so the shrinking mask never shows past the plate
      c.drawImage(i, 0, 0, 1, ih, -E, 0, E, S); c.drawImage(i, iw - 1, 0, 1, ih, S, 0, E, S);
      c.drawImage(i, 0, 0, iw, 1, 0, -E, S, E); c.drawImage(i, 0, ih - 1, iw, 1, 0, S, S, E);
      c.drawImage(i, 0, 0, 1, 1, -E, -E, E, E); c.drawImage(i, iw - 1, 0, 1, 1, S, -E, E, E);
      c.drawImage(i, 0, ih - 1, 1, 1, -E, S, E, E); c.drawImage(i, iw - 1, ih - 1, 1, 1, S, S, E, E);
    }
  }

  // one exposure of the badge (plate + skier, clipped to the disc) at time t, over what is already drawn
  function drawScene(t, alpha, sh, blurSkier) {
    const s = state(t), C = L.circle;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const [ox, oy] = toScreen(C.cx, C.cy, s.bx, s.by, s.bz, sh);
    ctx.beginPath(); ctx.arc(ox, oy, s.rm * s.bz, 0, Math.PI * 2); ctx.clip();
    ctx.globalAlpha = alpha;
    drawPlate(ctx, s, sh);
    if (blurSkier) {
      // motion blur: average N exposures over the shutter (premultiplied sum, then one composite)
      const N = 6, SH = 0.04;
      actx.setTransform(1, 0, 0, 1, 0, 0); actx.clearRect(0, 0, acc.width, acc.height);
      actx.globalCompositeOperation = 'lighter'; actx.globalAlpha = 1 / N;
      for (let j = 0; j < N; j++) drawSkier(actx, state(t - (SH * j) / (N - 1)), sh);
      actx.globalCompositeOperation = 'source-over'; actx.globalAlpha = 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(acc, 0, 0);
    } else drawSkier(ctx, s, sh);
    ctx.restore();
  }

  function initFx() {
    // soft round sprite
    puff = mkCanvas(64, 64);
    { const g = puff.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.45, 'rgba(255,255,255,0.45)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.fillRect(0, 0, 64, 64); }
    vig = mkCanvas(256, 256);
    { const g = vig.getContext('2d'), gr = g.createRadialGradient(128, 128, 60, 128, 128, 182);
      gr.addColorStop(0, 'rgba(0,6,18,0)'); gr.addColorStop(1, 'rgba(0,6,18,1)'); g.fillStyle = gr; g.fillRect(0, 0, 256, 256); }
    // pre-blurred SKI (two-step downscale) for the light sweep glow
    const S = L.ski, k = L.scale, a = mkCanvas(S.w / 3, S.h / 3);
    a.getContext('2d').drawImage(img.ski, 0, 0, S.w * k, S.h * k, 0, 0, a.width, a.height);
    glow = mkCanvas(S.w / 9, S.h / 9);
    glow.getContext('2d').drawImage(a, 0, 0, glow.width, glow.height);
    sweepC = mkCanvas(S.w / 2, S.h / 2); sweepX = sweepC.getContext('2d');

    // take-off snow burst from under the skis (world coords at the take-off pose)
    const P = L.skier, s0 = { dx: D0X, dy: D0Y, rot: ROT0, sc: 1 + SC0 };
    const pose = (x, y) => {
      const lx = (x - P.px) * s0.sc, ly = (y - P.py) * s0.sc, c = Math.cos(s0.rot), sn = Math.sin(s0.rot);
      return [P.px + s0.dx + lx * c - ly * sn, P.py + s0.dy + lx * sn + ly * c];
    };
    for (let i = 0; i < 240; i++) {
      const f = rnd(), [x, y] = pose(lerp(450, 700, f) + rnd(-10, 10), lerp(352, 465, f) + rnd(0, 26));
      burst.push({ x, y, vx: rnd(-260, 120), vy: rnd(-260, 120), r: rnd(0.8, 3.4), t0: rnd(0, 0.1), life: rnd(0.45, 1.05), w: rnd(0.55, 1) });
    }
    for (let i = 0; i < 9; i++) {
      const f = i / 8, [x, y] = pose(lerp(440, 720, f), lerp(380, 490, f) + 10);
      puffs.push({ x, y, vx: rnd(-70, 10), vy: rnd(-10, 60), r0: rnd(16, 30), r1: rnd(80, 150), life: rnd(0.7, 1.1), a: rnd(0.35, 0.6) });
    }
    for (let i = 0; i < 46; i++) streaks.push({ t0: rnd(0, 1.2), life: rnd(0.18, 0.34), x: rnd(-0.1, 1.1), y: rnd(-0.1, 1.1), len: rnd(70, 240), w: rnd(0.7, 2), a: rnd(0.1, 0.26), sp: rnd(1500, 2600) });
    for (let i = 0; i < 26; i++) flakes.push({ x: rnd(300, 1000), y: rnd(150, 900), r: rnd(2, 7), a: rnd(0.18, 0.45), vx: rnd(-40, 20), vy: rnd(10, 60) });
    // impact dust off the bottom of the letters
    for (let i = 0; i < 150; i++) {
      const x = rnd(185, 1000);
      dust.push({ x, y: rnd(735, 748), vx: (x - 600) * rnd(0.2, 0.8) + rnd(-90, 90), vy: rnd(-90, 110), r: rnd(0.8, 2.6), life: rnd(0.55, 1.15) });
    }
  }

  function drawFx(t, s, sh) {
    const z = s.z;
    // take-off powder (skier plane)
    if (t < 1.4) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      for (const q of puffs) {
        const a = t / q.life; if (a >= 1) continue;
        const r = lerp(q.r0, q.r1, outCubic(a)) * z, [x, y] = toScreen(q.x + q.vx * t, q.y + q.vy * t, s.cx, s.cy, z, sh);
        ctx.globalAlpha = q.a * (1 - a) * (1 - a) * sstep(0, 0.06, t);
        ctx.drawImage(puff, x - r, y - r, r * 2, r * 2);
      }
      ctx.strokeStyle = '#fff'; ctx.lineCap = 'round';
      for (const q of burst) {
        const tau = t - q.t0; if (tau < 0 || tau > q.life) continue;
        const pos = (tt) => { const e = (1 - Math.exp(-1.6 * tt)) / 1.6; return [q.x + q.vx * e, q.y + q.vy * e + 260 * tt * tt]; };
        const [x1, y1] = pos(tau), [x0, y0] = pos(Math.max(0, tau - 0.035));
        const [a1, b1] = toScreen(x1, y1, s.cx, s.cy, z, sh), [a0, b0] = toScreen(x0, y0, s.cx, s.cy, z, sh);
        ctx.globalAlpha = 0.85 * q.w * (1 - tau / q.life);
        ctx.lineWidth = Math.max(0.6, q.r * z * 0.7);
        ctx.beginPath(); ctx.moveTo(a0, b0); ctx.lineTo(a1 + 0.01, b1); ctx.stroke();
      }
    }
    // speed streaks (screen space, the world rushing past down-left)
    if (t < 1.55) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalCompositeOperation = 'lighter'; ctx.strokeStyle = '#eaf4ff'; ctx.lineCap = 'round';
      const dirx = -0.36, diry = 0.93, fade = 1 - sstep(0.7, 1.5, t);
      for (const q of streaks) {
        const tau = t - q.t0; if (tau < 0 || tau > q.life) continue;
        const k = tau / q.life, x = q.x * vw + dirx * q.sp * tau, y = q.y * vh + diry * q.sp * tau;
        ctx.globalAlpha = q.a * Math.sin(Math.PI * k) * fade; ctx.lineWidth = q.w;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - dirx * q.len, y - diry * q.len); ctx.stroke();
      }
      ctx.globalCompositeOperation = 'source-over';
    }
    // foreground flakes (nearer than the skier: more parallax), gone by the reveal
    if (t < 2.1) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const fa = sstep(0, 0.3, t) * (1 - sstep(1.3, 2.0, t)), zf = z * 1.6;
      for (const q of flakes) {
        const [x, y] = toScreen(q.x + q.vx * t, q.y + q.vy * t, s.cx + (s.cx - L.circle.cx) * 0.6, s.cy + (s.cy - L.circle.cy) * 0.6, zf, sh);
        const r = q.r * zf * 0.6;
        ctx.globalAlpha = q.a * fa; ctx.drawImage(puff, x - r, y - r, r * 2, r * 2);
      }
    }
    // the sun behind the slope: warm bloom + anamorphic streak, strongest in the opening
    {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalCompositeOperation = 'lighter';
      const [x, y] = toScreen(L.sun[0], L.sun[1], s.bx, s.by, s.bz, sh), a = lerp(0.42, 0.07, s.p) * sstep(0, 0.3, t) * (1 + 0.08 * Math.sin(t * 5));
      const r = 260 * s.bz;
      ctx.globalAlpha = a; ctx.drawImage(puff, x - r, y - r, r * 2, r * 2);
      ctx.globalAlpha = a * 0.55; ctx.drawImage(puff, x - r * 5, y - r * 0.05, r * 10, r * 0.1);
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  function drawText(t, s, sh) {
    const z = s.z, k = L.scale;
    // SKI: slams in from close to the lens (accelerating), ghosted while it flies
    if (t >= SLAM0) {
      const S = L.ski, cx = S.x + S.w / 2, cy = S.y + S.h / 2;
      const kk = clamp((t - SLAM0) / (IMPACT - SLAM0));
      const scaleAt = (q) => 1 + 1.6 * (1 - q * q);
      let sc = scaleAt(kk);
      if (t >= IMPACT) sc = 1 - 0.035 * Math.sin(Math.PI * clamp((t - IMPACT) / 0.2));
      const ghosts = t < IMPACT ? 4 : 0;
      for (let g = ghosts; g >= 0; g--) {
        const q = clamp(kk - g * 0.05), gs = g ? scaleAt(q) : sc;
        setPlane(ctx, s.cx, s.cy, z, sh);
        ctx.translate(cx, cy); ctx.scale(gs, gs); ctx.translate(-cx, -cy);
        ctx.globalAlpha = sstep(0, 0.35, g ? q : kk) * (g ? 0.22 / g : 1);
        ctx.drawImage(img.ski, 0, 0, S.w * k, S.h * k, S.x, S.y, S.w, S.h);
      }
      // light sweep: a slanted band of glow running across the letters
      const ts = (t - SWEEP0) / 0.75;
      if (ts > 0 && ts < 1) {
        const w = sweepC.width, h = sweepC.height;
        sweepX.globalCompositeOperation = 'source-over'; sweepX.clearRect(0, 0, w, h);
        sweepX.drawImage(glow, 0, 0, w, h);
        sweepX.globalCompositeOperation = 'destination-in';
        const bx = lerp(-0.25, 1.25, inOutCubic(ts)) * w, gr = sweepX.createLinearGradient(bx - 0.12 * w, 0, bx + 0.12 * w, h * 0.35);
        gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.5, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
        sweepX.fillStyle = gr; sweepX.fillRect(0, 0, w, h);
        setPlane(ctx, s.cx, s.cy, z, sh);
        ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.9 * Math.sin(Math.PI * ts);
        ctx.drawImage(sweepC, S.x - S.w * 0.04, S.y - S.h * 0.06, S.w * 1.08, S.h * 1.12);
        ctx.globalCompositeOperation = 'source-over';
      }
    }
    // LEGACY: letters track in from the right, staggered; then the rule draws out from the centre
    if (t >= LEG0) {
      const G = L.legacy, top = G.y, bottom = G.rule.y - 8;
      setPlane(ctx, s.cx, s.cy, z, sh);
      G.letters.forEach(([x0, x1], i) => {
        const q = clamp((t - LEG0 - i * 0.055) / 0.45); if (q <= 0) return;
        const e = outCubic(q), dx = (1 - e) * (34 + (i - 2.5) * 16), sx = x0 - 4, sw = x1 - x0 + 9;
        for (let g = 1; g >= 0; g--) {
          const off = g * (1 - e) * 22;
          ctx.globalAlpha = sstep(0, 0.5, q) * (g ? 0.3 : 1);
          ctx.drawImage(img.legacy, (sx - G.x) * k, (top - G.y) * k, sw * k, (bottom - top) * k, sx + dx + off, top, sw, bottom - top);
        }
      });
      const q = clamp((t - RULE0) / 0.55);
      if (q > 0) {
        const R = G.rule, e = outCubic(q), cxr = R.x + R.w / 2, half = (R.w / 2 + 4) * e;
        ctx.globalAlpha = sstep(0, 0.3, q);
        ctx.drawImage(img.legacy, (cxr - half - G.x) * k, (R.y - 4 - G.y) * k, half * 2 * k, (R.h + 8) * k, cxr - half, R.y - 4, half * 2, R.h + 8);
      }
    }
    ctx.globalAlpha = 1;
    // impact: flash, bloom, shock ring, dust
    if (t >= IMPACT && t < IMPACT + 1.3) {
      const a = t - IMPACT, S = L.ski;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.5 * Math.exp(-a / 0.07); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, vw, vh);
      const [x, y] = toScreen(S.x + S.w / 2, S.y + S.h / 2, s.cx, s.cy, z, sh), r = S.w * z * 0.9;
      ctx.globalAlpha = 0.8 * Math.exp(-a / 0.22); ctx.drawImage(puff, x - r, y - r * 0.55, r * 2, r * 1.1);
      ctx.globalCompositeOperation = 'source-over';
      const rr = lerp(0.35, 1.25, outCubic(clamp(a / 0.5))) * S.w * z * 0.5;
      ctx.globalAlpha = 0.32 * (1 - clamp(a / 0.5)); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.ellipse(x, y, rr, rr * 0.42, -0.08, 0, Math.PI * 2); ctx.stroke();
      for (const q of dust) {
        if (a > q.life) continue;
        const e = (1 - Math.exp(-2.6 * a)) / 2.6, [dx, dy] = toScreen(q.x + q.vx * e, q.y + q.vy * e + 40 * a * a, s.cx, s.cy, z, sh);
        const r2 = q.r * z * 1.4;
        ctx.globalAlpha = 0.75 * (1 - a / q.life); ctx.drawImage(puff, dx - r2, dy - r2, r2 * 2, r2 * 2);
      }
      ctx.globalAlpha = 1;
    }
  }

  function render(t) {
    const s = state(t), sh = shake(t), C = L.circle;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#04122b'; ctx.fillRect(0, 0, cv.width, cv.height);
    // backdrop (cover, slower zoom, little shake)
    if (s.rm < rBig * 0.999) {
      const bd = img.backdrop, cover = Math.max(vw, vh) / L.size * (1 + 0.12 * (1 - s.p)) * (1 + 0.012 * sstep(IMPACT, END + 0.6, t));
      ctx.setTransform(cover * dpr, 0, 0, cover * dpr, dpr * (vw / 2 - C.cx * cover + sh[0] * 0.3), dpr * (vh / 2 - C.cy * cover + sh[1] * 0.3));
      ctx.drawImage(bd, 0, 0, bd.width, bd.height, 0, 0, L.size, L.size);
      // the disc's soft contact shadow (measured off the logo: ~14% darker for 15 px, gone by 50 px)
      const [ox, oy] = toScreen(C.cx, C.cy, s.bx, s.by, s.bz, sh), r0 = s.rm * s.bz, r1 = (s.rm + 52) * s.bz;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const gr = ctx.createRadialGradient(ox, oy, r0, ox, oy, r1);
      gr.addColorStop(0, 'rgba(0,0,0,0.15)'); gr.addColorStop(0.3, 'rgba(0,0,0,0.14)'); gr.addColorStop(0.58, 'rgba(0,0,0,0.075)'); gr.addColorStop(0.77, 'rgba(0,0,0,0.035)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalAlpha = sstep(0.55, 1, s.p); ctx.fillStyle = gr; ctx.fillRect(ox - r1, oy - r1, r1 * 2, r1 * 2);
      ctx.globalAlpha = 1;
    }
    // the badge: zoom-blurred while the camera whips back (running average of exposures)
    const s1 = state(t - 1 / 60), zv = Math.abs(Math.log(s.bz / s1.bz)) * 60, pv = Math.hypot(s.bx - s1.bx, s.by - s1.by) * s.bz;
    const K = Math.max(1, Math.min(6, Math.ceil(zv * 2.2 + pv / 10)));
    if (K === 1) drawScene(t, 1, sh, t < RISE + 0.05);
    else for (let k = 0; k < K; k++) drawScene(t - (0.03 * (K - 1 - k)) / (K - 1), 1 / (k + 1), sh, false);
    drawFx(t, s, sh);
    // cinematic vignette in the opening
    const va = 0.62 * (1 - sstep(0.2, 0.95, s.p));
    if (va > 0.002) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = va; ctx.drawImage(vig, -cv.width * 0.12, -cv.height * 0.12, cv.width * 1.24, cv.height * 1.24); ctx.globalAlpha = 1; }
    drawText(t, s, sh);
    // fade up from black
    const fa = 1 - sstep(0, 0.22, t);
    if (fa > 0) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = fa; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cv.width, cv.height); ctx.globalAlpha = 1; }
  }

  function tick() {
    if (stopped) return;
    const t = now() - t0;
    while (cueI < cues.length && t >= cues[cueI][0]) post({ type: 'cue', name: cues[cueI++][1] });
    render(Math.min(t, END + 1));
    raf = frame(tick);
  }

  async function load(base) {
    const out = {};
    await Promise.all(Object.entries(base.files).map(async ([k, url]) => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${url}: ${r.status}`);
      out[k] = await createImageBitmap(await r.blob());
    }));
    return out;
  }

  return {
    async msg(m, send) {
      if (m.type === 'init') {
        post = send;
        try {
          cv = m.canvas; ctx = cv.getContext('2d', { alpha: false });
          const r = await fetch(m.layoutUrl); if (!r.ok) throw new Error('layout ' + r.status);
          L = await r.json();
          img = await load(m);
          ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
          const d = dims || m;
          size(d.w, d.h, d.dpr);
          initFx();
          t0 = now() + (m.offset || 0);
          render(Math.max(0, now() - t0));
          send({ type: 'started' });
          raf = frame(tick);
        } catch (e) { send({ type: 'error', message: String(e?.message || e) }); }
      } else if (m.type === 'resize') {
        dims = m;
        if (!L || !img) return; // applied once the clip has loaded
        size(m.w, m.h, m.dpr);
        if (ctx) { ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; }
      } else if (m.type === 'stop') {
        stopped = true; unframe(raf);
      }
    },
  };
}

/** Plays the opening clip inside `host` (an .intro-scene element). */
export class IntroClip {
  constructor(host, audio) {
    this.host = host;
    this.audio = audio;
    this.worker = null;
    this.engine = null;
    this.ro = null;
  }

  /** Starts loading + playing; resolves true once the first frame is up, false if the clip can't play. */
  start(timeoutMs = 3500) {
    const canvas = document.createElement('canvas');
    canvas.className = 'clip-canvas';
    this.host.appendChild(canvas);
    const base = new URL('intro/clip/', document.baseURI).href;
    const files = Object.fromEntries(Object.entries(FILES).map(([k, f]) => [k, base + f]));
    const dims = () => ({ w: Math.max(1, this.host.clientWidth || innerWidth), h: Math.max(1, this.host.clientHeight || innerHeight), dpr: Math.min(2, devicePixelRatio || 1) });
    const init = { type: 'init', files, layoutUrl: base + 'clip.json', ...dims() };
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => { if (!done) { done = true; clearTimeout(timer); resolve(ok); } };
      this.abort = () => finish(false); // skipped while still loading
      const timer = setTimeout(() => finish(false), timeoutMs);
      const onMsg = (m) => {
        if (m.type === 'started') finish(true);
        else if (m.type === 'error') { console.warn('[intro clip]', m.message); finish(false); }
        else if (m.type === 'cue') this.cue(m.name);
      };
      const send = (m) => (this.worker ? this.worker.postMessage(m) : this.engine?.msg(m, onMsg));
      try {
        if (typeof OffscreenCanvas === 'undefined' || !canvas.transferControlToOffscreen || typeof Worker === 'undefined') throw new Error('no offscreen');
        const src = `const engine = (${clipEngine.toString()})();\nself.onmessage = (e) => engine.msg(e.data, (m) => self.postMessage(m));`;
        const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
        this.worker = new Worker(url);
        URL.revokeObjectURL(url);
        this.worker.onmessage = (e) => onMsg(e.data);
        this.worker.onerror = (e) => { console.warn('[intro clip] worker', e.message); finish(false); };
        const off = canvas.transferControlToOffscreen();
        this.worker.postMessage({ ...init, canvas: off }, [off]);
      } catch {
        // main-thread fallback (same engine)
        this.worker = null;
        if (typeof OffscreenCanvas === 'undefined') { finish(false); return; }
        this.engine = clipEngine();
        this.engine.msg({ ...init, canvas }, onMsg);
      }
      this.ro = new ResizeObserver(() => send({ type: 'resize', ...dims() }));
      this.ro.observe(this.host);
    });
  }

  cue(name) {
    const a = this.audio;
    if (!a) return;
    if (name === 'announce') a.announce?.('ski_legacy');
    else a.play?.(name);
  }

  stop() {
    this.abort?.();
    this.ro?.disconnect();
    if (this.worker) { this.worker.postMessage({ type: 'stop' }); this.worker.terminate(); this.worker = null; }
    this.engine?.msg({ type: 'stop' }, () => {});
    this.engine = null;
  }
}
