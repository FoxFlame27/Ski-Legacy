// The railway station buildings, procedural (Nov 1 2026, the user: "why are so many models so blurry and weird from the
// outside, not very realistic — fix ALL those, like the train station": the Meshy station models had one baked
// 2048 texture over the whole building, mushy geometry and baked light). Built here like a Rhaetian / Zillertal /
// Jungfrau line station: a dressed-stone plinth and ground floor, a timber upper storey of vertical boards and cover
// battens, a deep pitched roof on purlins and brackets under a thick, rounded snow cover, framed windows (frames,
// mullions, transoms, sills, shutters) with reflective glass (scene.environment) that glows warm after dusk,
// doors, wall lanterns, benches, balconies, a station clock; and the platform canopy (steel columns, glulam
// cantilevers, a boarded soffit, pendant lamps, a hanging double-faced clock).
// (Nov 1 2026, the user: "make it so you can go inside, and there's a nice interior AND a good outside": the walls
// are hollow, with real openings; the doors stand open (sliding glass parked aside, a timber leaf swung in); the
// windows you can see the rooms through are clear glass; floors are walkable surfaces at the doors' level, the
// walls, counters and benches colliders (stationPlan / registerStation). The rooms are lit by warm ceiling panels
// (emissive) and a little self-light on their surfaces that grows after dusk: no real lights, no per-frame work.)
//   valley:  the big station (Legacy Village): two storeys over a waiting hall (granite tiles, timber wainscot,
//            ticket counter with its clerk's screen, departures board, clock, posters, benches, a ski rack, a
//            vending machine), the station office's rear wing, balconies on the gables, doors to the platform and
//            both gables
//   halt:    the small halt (Wolkensee, Adlerwald, the Legacy Express race stations): one storey, a deep front eave,
//            a heated waiting room (stove, bench, timetable)
//   glacier: the high-alpine terminal on the glacier (Wolkenplatt): granite ground floor, board-marked concrete,
//            a two-storey glass front onto a double-height hall (benches, departures screens, a kiosk, the lifts
//            down to the rock hall in the tower with the weather mast)
// Local frame of every building: x along the track (along the front), y up from its base, z away from the track
// (back); the front line (the old models' bounding box front) at z = 0. Textures are small canvases drawn once
// (tiling, mipmapped, anisotropic, with normal maps from height), the uv in metres; geometry merged per material
// and shared by every station (userData.shared: never disposed); all lights tied to the village's nightUniform
// (no per-frame work).
import * as THREE from 'three';
import { mergeGeometries, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../core/noise.js';
import { nightUniform } from './village.js';
import { gpuCaps } from '../engine/quality.js';
import { world } from './world.js';

// the footprints the old models had (fitted: width along the track, height, depth): station layouts keep these
export const STATION_SIZE = {
  valley: { x: 22, y: 9.41, z: 22.12 },
  halt: { x: 8.6, y: 7.73, z: 7.5 },
  glacier: { x: 19.4, y: 14, z: 15.0 },
};
// the floor's height over the building's base (the doors' level: the apron in front of them is at it too)
const FLOOR = { valley: 0.08, halt: 0.1, glacier: 0.28 };

// ------------------------------------------------------------------ textures (drawn once)
const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
function tileTex(c, metres, srgb = true) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1 / metres, 1 / metres);
  t.anisotropy = Math.max(1, Math.min(16, gpuCaps.maxAniso || 8));
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = true;
  return t;
}
// a tangent-space normal map from a grey height canvas (wrapping; canvas rows run down, v up)
function heightToNormal(hc, strength) {
  const w = hc.width, h = hc.height, src = hc.getContext('2d').getImageData(0, 0, w, h).data;
  const out = canvas(w, h), g = out.getContext('2d'), img = g.createImageData(w, h), d = img.data;
  const k = strength / 255;
  for (let y = 0; y < h; y++) {
    const yu = ((y + h - 1) % h) * w, yd = ((y + 1) % h) * w, yr = y * w;
    for (let x = 0; x < w; x++) {
      const xl = (x + w - 1) % w, xr = (x + 1) % w;
      const nx = -(src[(yr + xr) * 4] - src[(yr + xl) * 4]) * k, ny = (src[(yd + x) * 4] - src[(yu + x) * 4]) * k;
      const l = 1 / Math.hypot(nx, ny, 1), i = (yr + x) * 4;
      d[i] = (nx * l * 0.5 + 0.5) * 255; d[i + 1] = (ny * l * 0.5 + 0.5) * 255; d[i + 2] = (l * 0.5 + 0.5) * 255; d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return out;
}
// draw fn at (x, y) and wherever it wraps over the tile's edges
function wrapped(w, h, x, y, ew, eh, fn) {
  for (const ox of [-w, 0, w]) for (const oy of [-h, 0, h]) if (x + ox < w && x + ox + ew > 0 && y + oy < h && y + oy + eh > 0) fn(x + ox, y + oy);
}
const rgb = (r, g, b, a = 1) => `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${a})`;

// timber: vertical larch boards with cover battens, weathered from brown to silver here and there (2.4 m tile)
function timberTextures() {
  const S = 1024, M = 2.4, rnd = mulberry32(5513);
  const cc = canvas(S, S), hc = canvas(S, S), c = cc.getContext('2d'), hg = hc.getContext('2d');
  hg.fillStyle = '#909090'; hg.fillRect(0, 0, S, S);
  const n = 10, ws = Array.from({ length: n }, () => 0.85 + rnd() * 0.3), sum = ws.reduce((a, b) => a + b, 0);
  let x = 0;
  const joints = [];
  for (let i = 0; i < n; i++) {
    const bw = Math.round((ws[i] / sum) * S), x0 = x; x += bw;
    joints.push(x0);
    const tone = 0.8 + rnd() * 0.32, grey = rnd() < 0.3 ? 0.25 + rnd() * 0.45 : rnd() * 0.18;
    const base = [(122 + (118 - 122) * grey) * tone, (80 + (110 - 80) * grey) * tone, (50 + (98 - 50) * grey) * tone];
    c.fillStyle = rgb(...base); c.fillRect(x0, 0, bw, S);
    // grain: long wavy streaks (their waves wrap with the tile)
    for (let k = 0; k < 46; k++) {
      const gx = x0 + 3 + rnd() * (bw - 6), amp = rnd() * 3.2, f = (Math.PI * 2 * (1 + Math.floor(rnd() * 3))) / S, ph = rnd() * 6.28;
      const dark = rnd() < 0.72;
      c.strokeStyle = dark ? rgb(48, 30, 18, 0.06 + rnd() * 0.14) : rgb(220, 196, 160, 0.04 + rnd() * 0.08);
      c.lineWidth = 0.6 + rnd() * 1.8;
      c.beginPath();
      for (let y = 0; y <= S; y += 16) { const px = Math.min(x0 + bw - 1, Math.max(x0 + 1, gx + Math.sin(y * f + ph) * amp)); if (y) c.lineTo(px, y); else c.moveTo(px, y); }
      c.stroke();
      if (dark && k % 3 === 0) { hg.strokeStyle = 'rgba(40,40,40,0.25)'; hg.lineWidth = 1; hg.beginPath(); hg.moveTo(gx, 0); hg.lineTo(gx, S); hg.stroke(); }
    }
    // knots
    const nk = Math.floor(rnd() * 2.4);
    for (let k = 0; k < nk; k++) {
      const kx = x0 + bw * (0.3 + rnd() * 0.4), ky = rnd() * S, rx = 4 + rnd() * 5, ry = 7 + rnd() * 8;
      wrapped(S, S, kx - 20, ky - 20, 40, 40, (ox, oy) => {
        const px = ox + 20, py = oy + 20;
        c.fillStyle = rgb(70, 42, 24, 0.85); c.beginPath(); c.ellipse(px, py, rx, ry, 0, 0, 7); c.fill();
        c.strokeStyle = rgb(52, 32, 18, 0.5); c.lineWidth = 2; c.beginPath(); c.ellipse(px, py, rx * 1.8, ry * 1.6, 0, 0, 7); c.stroke();
        hg.fillStyle = 'rgba(60,60,60,0.6)'; hg.beginPath(); hg.ellipse(px, py, rx, ry, 0, 0, 7); hg.fill();
      });
    }
    // a little weathering at random heights (darker water marks)
    for (let k = 0; k < 3; k++) { const y = rnd() * S, hh = 40 + rnd() * 160; c.fillStyle = rgb(30, 22, 16, 0.05 + rnd() * 0.06); c.fillRect(x0, y, bw, hh); if (y + hh > S) c.fillRect(x0, y - S, bw, hh); }
  }
  // cover battens over the joints (6 cm), raised, with their shadows on the boards and a nail every 60 cm
  const bw = 26;
  for (const jx of joints) {
    const x0 = jx - bw / 2, tone = 0.78 + rnd() * 0.2;
    wrapped(S, S, x0 - 6, 0, bw + 12, S, (ox) => {
      const bx = ox + 6;
      c.fillStyle = 'rgba(15,9,5,0.45)'; c.fillRect(bx - 4, 0, 4, S); c.fillStyle = 'rgba(15,9,5,0.3)'; c.fillRect(bx + bw, 0, 5, S);
      const gr = c.createLinearGradient(bx, 0, bx + bw, 0);
      gr.addColorStop(0, rgb(150 * tone, 110 * tone, 76 * tone)); gr.addColorStop(0.5, rgb(116 * tone, 80 * tone, 52 * tone)); gr.addColorStop(1, rgb(84 * tone, 56 * tone, 36 * tone));
      c.fillStyle = gr; c.fillRect(bx, 0, bw, S);
      for (let k = 0; k < 14; k++) { c.strokeStyle = rgb(50, 32, 20, 0.08 + rnd() * 0.1); c.lineWidth = 0.8; const gx = bx + 2 + rnd() * (bw - 4); c.beginPath(); c.moveTo(gx, 0); c.lineTo(gx, S); c.stroke(); }
      hg.fillStyle = '#404040'; hg.fillRect(bx - 3, 0, 3, S); hg.fillRect(bx + bw, 0, 3, S);
      hg.fillStyle = '#c8c8c8'; hg.fillRect(bx, 0, bw, S); hg.fillStyle = '#f0f0f0'; hg.fillRect(bx + 4, 0, bw - 8, S);
      for (let y = 30; y < S; y += S / 4) { c.fillStyle = 'rgba(30,30,32,0.8)'; c.fillRect(bx + bw / 2 - 2, y, 4, 4); hg.fillStyle = '#d8d8d8'; hg.fillRect(bx + bw / 2 - 2, y, 4, 4); }
    });
  }
  return { map: tileTex(cc, M), normalMap: tileTex(heightToNormal(hc, 5), M, false) };
}

// stone: rock-faced granite ashlar in courses with recessed mortar joints (3 m tile)
function stoneTextures() {
  const S = 1024, M = 3, px = S / M, rnd = mulberry32(8821), mort = 7;
  const cc = canvas(S, S), hc = canvas(S, S), c = cc.getContext('2d'), hg = hc.getContext('2d');
  c.fillStyle = '#9b978f'; c.fillRect(0, 0, S, S);
  hg.fillStyle = '#1e1e1e'; hg.fillRect(0, 0, S, S);
  for (let i = 0; i < 9000; i++) { c.fillStyle = rnd() < 0.5 ? 'rgba(60,58,54,0.35)' : 'rgba(210,206,198,0.35)'; c.fillRect(rnd() * S, rnd() * S, 1.5, 1.5); }
  const courses = [];
  for (let y = 0; y < S;) {
    let hh = Math.round([0.3, 0.36, 0.42, 0.48][Math.floor(rnd() * 4)] * px);
    if (S - y - hh < 0.26 * px) hh = S - y;
    courses.push([y, hh]); y += hh;
  }
  for (const [y0, hh] of courses) {
    let x = rnd() * px;
    const xEnd = x + S;
    while (x < xEnd - 1) {
      let bw = Math.round((0.42 + rnd() * 0.75) * px);
      if (xEnd - x - bw < 0.3 * px) bw = Math.round(xEnd - x);
      const v = 0.86 + rnd() * 0.26, warm = rnd() * 14;
      const col = [148 * v + warm, 144 * v + warm * 0.6, 136 * v];
      const bx = x % S;
      wrapped(S, S, bx, y0, bw, hh, (ox, oy) => {
        const X = ox + mort / 2, Y = oy + mort / 2, W = bw - mort, H = hh - mort;
        c.save(); c.beginPath(); c.rect(X, Y, W, H); c.clip();
        c.fillStyle = rgb(...col); c.fillRect(X, Y, W, H);
        // the rock face: soft light and dark patches, speckles of mica and feldspar
        for (let k = 0; k < 7; k++) {
          const r = 12 + rnd() * 40, cx = X + rnd() * W, cy = Y + rnd() * H, gr = c.createRadialGradient(cx, cy, 0, cx, cy, r);
          gr.addColorStop(0, rnd() < 0.5 ? 'rgba(255,252,244,0.16)' : 'rgba(40,38,34,0.16)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
          c.fillStyle = gr; c.fillRect(cx - r, cy - r, r * 2, r * 2);
        }
        const nd = (W * H) / 26;
        for (let k = 0; k < nd; k++) { const t = rnd(); c.fillStyle = t < 0.45 ? 'rgba(52,50,48,0.5)' : t < 0.8 ? 'rgba(232,228,220,0.45)' : 'rgba(170,140,120,0.4)'; c.fillRect(X + rnd() * W, Y + rnd() * H, 1 + rnd() * 1.5, 1 + rnd() * 1.5); }
        c.strokeStyle = 'rgba(30,28,26,0.35)'; c.lineWidth = 3; c.strokeRect(X + 1.5, Y + 1.5, W - 3, H - 3);
        c.fillStyle = 'rgba(255,255,255,0.12)'; c.fillRect(X, Y, W, 2);
        c.restore();
        // height: a pillowed block (stepped bevel) with bumps
        hg.fillStyle = '#787878'; hg.fillRect(X, Y, W, H);
        hg.fillStyle = '#a0a0a0'; hg.fillRect(X + 3, Y + 3, W - 6, H - 6);
        hg.fillStyle = '#b8b8b8'; hg.fillRect(X + 7, Y + 7, W - 14, H - 14);
        hg.fillStyle = '#c4c4c4'; hg.fillRect(X + 12, Y + 12, W - 24, H - 24);
        hg.save(); hg.beginPath(); hg.rect(X + 3, Y + 3, W - 6, H - 6); hg.clip();
        for (let k = 0; k < 10; k++) {
          const r = 8 + rnd() * 26, cx = X + rnd() * W, cy = Y + rnd() * H, gr = hg.createRadialGradient(cx, cy, 0, cx, cy, r);
          gr.addColorStop(0, rnd() < 0.5 ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.22)'); gr.addColorStop(1, 'rgba(128,128,128,0)');
          hg.fillStyle = gr; hg.fillRect(cx - r, cy - r, r * 2, r * 2);
        }
        hg.restore();
      });
      x += bw;
    }
  }
  return { map: tileTex(cc, M), normalMap: tileTex(heightToNormal(hc, 4), M, false) };
}

// concrete: board-marked (15 cm boards), tie holes on a 50 cm grid, faint streaks (4 m tile)
function concreteTextures() {
  const S = 1024, M = 4, rnd = mulberry32(4471), n = 26, bh = S / n;
  const cc = canvas(S, S), hc = canvas(S, S), c = cc.getContext('2d'), hg = hc.getContext('2d');
  c.fillStyle = '#b8b5ae'; c.fillRect(0, 0, S, S); hg.fillStyle = '#808080'; hg.fillRect(0, 0, S, S);
  for (let i = 0; i < n; i++) {
    const y = i * bh, v = 0.95 + rnd() * 0.08;
    c.fillStyle = rgb(184 * v, 181 * v, 174 * v); c.fillRect(0, y, S, bh);
    for (let k = 0; k < 18; k++) { c.fillStyle = rgb(90, 86, 80, 0.03 + rnd() * 0.04); const gy = y + rnd() * bh; c.fillRect(0, gy, S, 1 + rnd()); }
    c.fillStyle = 'rgba(70,68,64,0.35)'; c.fillRect(0, y, S, 1.5);
    hg.fillStyle = rgb(128 + (rnd() - 0.5) * 18, 128, 128); hg.fillRect(0, y, S, bh);
    hg.fillStyle = '#585858'; hg.fillRect(0, y, S, 2);
  }
  for (let k = 0; k < 40; k++) { const x = rnd() * S, y = rnd() * S, l = 60 + rnd() * 260, w = 2 + rnd() * 9; c.fillStyle = rgb(70, 66, 60, 0.03 + rnd() * 0.04); wrapped(S, S, x, y, w, l, (ox, oy) => c.fillRect(ox, oy, w, l)); }
  for (let i = 0; i < 9000; i++) { c.fillStyle = rnd() < 0.6 ? 'rgba(80,78,74,0.45)' : 'rgba(225,222,215,0.4)'; c.fillRect(rnd() * S, rnd() * S, 1.2, 1.2); }
  for (let gx = 64; gx < S; gx += 128) for (let gy = 64; gy < S; gy += 128) {
    c.fillStyle = 'rgba(150,147,140,1)'; c.beginPath(); c.arc(gx, gy, 9, 0, 7); c.fill();
    c.fillStyle = 'rgba(60,58,55,0.9)'; c.beginPath(); c.arc(gx, gy, 5, 0, 7); c.fill();
    hg.fillStyle = '#303030'; hg.beginPath(); hg.arc(gx, gy, 6, 0, 7); hg.fill();
  }
  return { map: tileTex(cc, M), normalMap: tileTex(heightToNormal(hc, 2.5), M, false) };
}

// snow: soft drifts (3 m tile)
function snowTextures() {
  const S = 512, M = 3, rnd = mulberry32(1201);
  const cc = canvas(S, S), hc = canvas(S, S), c = cc.getContext('2d'), hg = hc.getContext('2d');
  c.fillStyle = '#f6f8fb'; c.fillRect(0, 0, S, S); hg.fillStyle = '#808080'; hg.fillRect(0, 0, S, S);
  for (let k = 0; k < 140; k++) {
    const r = 10 + rnd() * 60, x = rnd() * S, y = rnd() * S, dark = rnd() < 0.5;
    wrapped(S, S, x - r, y - r, 2 * r, 2 * r, (ox, oy) => {
      const cx = ox + r, cy = oy + r;
      let gr = c.createRadialGradient(cx, cy, 0, cx, cy, r); gr.addColorStop(0, dark ? 'rgba(196,208,224,0.10)' : 'rgba(255,255,255,0.3)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = gr; c.fillRect(cx - r, cy - r, 2 * r, 2 * r);
      gr = hg.createRadialGradient(cx, cy, 0, cx, cy, r); gr.addColorStop(0, dark ? 'rgba(0,0,0,0.25)' : 'rgba(255,255,255,0.25)'); gr.addColorStop(1, 'rgba(128,128,128,0)');
      hg.fillStyle = gr; hg.fillRect(cx - r, cy - r, 2 * r, 2 * r);
    });
  }
  for (let i = 0; i < 3000; i++) { hg.fillStyle = rnd() < 0.5 ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.3)'; hg.fillRect(rnd() * S, rnd() * S, 1, 1); }
  return { map: tileTex(cc, M), normalMap: tileTex(heightToNormal(hc, 1.2), M, false) };
}

// the station clock's face: white, black bars, hands at ten past ten, the red seconds hand with its disc
function clockTexture() {
  const S = 512, cc = canvas(S, S), g = cc.getContext('2d'), R = S / 2;
  g.fillStyle = '#20232a'; g.fillRect(0, 0, S, S);
  g.fillStyle = '#fbfbf8'; g.beginPath(); g.arc(R, R, R - 4, 0, 7); g.fill();
  g.save(); g.translate(R, R);
  for (let i = 0; i < 60; i++) {
    const big = i % 5 === 0; g.fillStyle = '#111';
    g.save(); g.rotate((i / 60) * Math.PI * 2);
    if (big) g.fillRect(-11, -(R - 18), 22, 74); else g.fillRect(-4, -(R - 18), 8, 22);
    g.restore();
  }
  const hand = (ang, w0, w1, l0, l1, col) => { g.save(); g.rotate(ang); g.fillStyle = col; g.beginPath(); g.moveTo(-w0 / 2, l0); g.lineTo(w0 / 2, l0); g.lineTo(w1 / 2, -l1); g.lineTo(-w1 / 2, -l1); g.closePath(); g.fill(); g.restore(); };
  hand(((10 + 10 / 60) / 12) * Math.PI * 2, 30, 24, 50, 140, '#111');
  hand((10 / 60) * Math.PI * 2, 24, 18, 50, 212, '#111');
  g.save(); g.rotate((38 / 60) * Math.PI * 2); g.fillStyle = '#c4161c'; g.fillRect(-4, -150, 8, 220); g.beginPath(); g.arc(0, -150, 24, 0, 7); g.fill(); g.restore();
  g.fillStyle = '#111'; g.beginPath(); g.arc(0, 0, 10, 0, 7); g.fill();
  g.restore();
  const t = new THREE.CanvasTexture(cc);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = Math.max(1, Math.min(16, gpuCaps.maxAniso || 8));
  return t;
}

// interior floor: polished granite tiles (40 cm) in two tones, laid as a checker (2.4 m tile)
function tileTextures() {
  const S = 1024, M = 2.4, n = 6, ts = S / n, rnd = mulberry32(7123);
  const cc = canvas(S, S), hc = canvas(S, S), c = cc.getContext('2d'), hg = hc.getContext('2d');
  c.fillStyle = '#6d6a66'; c.fillRect(0, 0, S, S); hg.fillStyle = '#404040'; hg.fillRect(0, 0, S, S);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const dark = (i + j) % 2 === 1, v = 0.94 + rnd() * 0.1, x = i * ts + 2, y = j * ts + 2, w = ts - 4;
    c.fillStyle = dark ? rgb(92 * v, 94 * v, 98 * v) : rgb(214 * v, 208 * v, 196 * v); c.fillRect(x, y, w, w);
    for (let k = 0; k < 900; k++) { c.fillStyle = dark ? (rnd() < 0.5 ? 'rgba(30,30,34,0.5)' : 'rgba(170,170,176,0.35)') : (rnd() < 0.5 ? 'rgba(120,112,100,0.4)' : 'rgba(255,255,250,0.4)'); c.fillRect(x + rnd() * w, y + rnd() * w, 1.5, 1.5); }
    const gr = c.createLinearGradient(x, y, x + w, y + w); gr.addColorStop(0, 'rgba(255,255,255,0.06)'); gr.addColorStop(1, 'rgba(0,0,0,0.05)'); c.fillStyle = gr; c.fillRect(x, y, w, w);
    hg.fillStyle = '#c0c0c0'; hg.fillRect(x, y, w, w);
  }
  return { map: tileTex(cc, M), normalMap: tileTex(heightToNormal(hc, 3), M, false) };
}
// the posters and signs, one atlas (u 0-1/3: the yellow departures poster, 1/3-2/3: the resort's travel poster,
// 2/3-1: three signs, top to bottom: TICKETS, KIOSK, TO THE TRAINS)
export const ATLAS = { timetable: [0, 0, 1 / 3, 1], travel: [1 / 3, 0, 2 / 3, 1], tickets: [2 / 3, 2 / 3, 1, 1], kiosk: [2 / 3, 1 / 3, 1, 2 / 3], trains: [2 / 3, 0, 1, 1 / 3] };
function atlasTexture() {
  const W = 1536, H = 512, cc = canvas(W, H), g = cc.getContext('2d'), rnd = mulberry32(3301), F = '"Barlow Condensed", "Arial Narrow", Arial, sans-serif';
  // the yellow Abfahrt poster: hours down the side, minutes and destinations in rows
  g.fillStyle = '#f7d417'; g.fillRect(0, 0, 512, H);
  g.fillStyle = '#111'; g.font = `700 46px ${F}`; g.fillText('Abfahrt', 24, 58); g.font = `500 22px ${F}`; g.fillText('Départ · Partenza · Departure', 24, 88);
  g.fillRect(20, 100, 472, 4);
  for (let r = 0; r < 14; r++) {
    const y = 132 + r * 26.5;
    g.font = `700 21px ${F}`; g.fillText(String(7 + r).padStart(2, '0'), 24, y);
    g.font = `400 18px ${F}`;
    for (let k = 0; k < 4; k++) { const mm = String((k * 15 + 4 + Math.floor(rnd() * 3)) % 60).padStart(2, '0'); g.fillText(`${mm}  ${k % 2 ? 'Wolkenplatt' : 'Legacy Village'}`, 70 + k * 106, y); }
    g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(20, y + 7, 472, 1); g.fillStyle = '#111';
  }
  // the travel poster: a deep blue sky, the white peak, the line's name
  const sky = g.createLinearGradient(0, 0, 0, H); sky.addColorStop(0, '#173e7a'); sky.addColorStop(0.6, '#6fa3d8'); sky.addColorStop(1, '#e8f0f8');
  g.fillStyle = sky; g.fillRect(512, 0, 512, H);
  g.fillStyle = '#f4f7fb'; g.beginPath(); g.moveTo(512, 420); g.lineTo(700, 170); g.lineTo(760, 215); g.lineTo(840, 120); g.lineTo(1024, 380); g.lineTo(1024, H); g.lineTo(512, H); g.fill();
  g.fillStyle = '#8fa9c4'; g.beginPath(); g.moveTo(840, 120); g.lineTo(1024, 380); g.lineTo(1024, 420); g.lineTo(880, 260); g.fill();
  g.fillStyle = '#2c5a35'; for (let k = 0; k < 9; k++) { const x = 530 + k * 56; g.beginPath(); g.moveTo(x, 470); g.lineTo(x + 22, 380 - (k % 3) * 18); g.lineTo(x + 44, 470); g.fill(); }
  g.fillStyle = '#a5141c'; g.fillRect(512, H - 70, 512, 70);
  g.fillStyle = '#fff'; g.font = `italic 700 54px ${F}`; g.textAlign = 'center'; g.fillText('WOLKENSPITZE', 768, 70); g.font = `600 30px ${F}`; g.fillText('WOLKENSPITZBAHN', 768, H - 24);
  // the signs
  const sign = (y0, bg, fg, txt) => { g.fillStyle = bg; g.fillRect(1024, y0, 512, H / 3); g.fillStyle = fg; g.font = `700 74px ${F}`; g.fillText(txt, 1280, y0 + H / 6 + 26); };
  sign(0, '#a5141c', '#fff', 'BILLETTE · TICKETS'); sign(H / 3, '#1f3f6e', '#fff', 'KIOSK · CAFÉ'); sign((2 * H) / 3, '#20242a', '#fff', '↓ ZU DEN ZÜGEN · TRAINS');
  const t = new THREE.CanvasTexture(cc); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = Math.max(1, Math.min(16, gpuCaps.maxAniso || 8));
  return t;
}
// a departures board / screen: dark blue, a header, rows of destination, note and interval (amber, like the boards)
const BOARD_TEX = new Map();
function boardTexture(title, rows) {
  const key = title + '|' + JSON.stringify(rows);
  if (BOARD_TEX.has(key)) return BOARD_TEX.get(key);
  if (typeof document === 'undefined') return null;
  const W = 1024, H = 256, cc = canvas(W, H), g = cc.getContext('2d'), F = '"Barlow Condensed", "Arial Narrow", Arial, sans-serif';
  g.fillStyle = '#0d1a33'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#f4f2ed'; g.font = `700 40px ${F}`; g.textBaseline = 'middle'; g.fillText(title, 22, 30);
  g.fillStyle = '#2f4a78'; g.fillRect(16, 54, W - 32, 2);
  rows.slice(0, 4).forEach(([a, b, c], i) => {
    const y = 84 + i * 44;
    g.fillStyle = '#ffb12e'; g.font = `600 34px ${F}`; g.textAlign = 'left'; g.fillText(a, 26, y);
    g.fillStyle = '#c9d3e4'; g.font = `400 26px ${F}`; g.fillText(b || '', 420, y);
    g.fillStyle = '#ffb12e'; g.font = `600 32px ${F}`; g.textAlign = 'right'; g.fillText(c || '', W - 26, y); g.textAlign = 'left';
  });
  const t = new THREE.CanvasTexture(cc); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = Math.max(1, Math.min(16, gpuCaps.maxAniso || 8));
  const m = new THREE.MeshStandardMaterial({ map: t, color: 0xffffff, roughness: 0.4, emissiveMap: t, emissive: 0xffffff, emissiveIntensity: 0.85 });
  m.userData.shared = true;
  BOARD_TEX.set(key, m);
  return m;
}

// ------------------------------------------------------------------ materials (shared by every station)
function nightScaled(m, day, night, key) {
  m.onBeforeCompile = (s) => {
    s.uniforms.uNight = nightUniform;
    s.fragmentShader = s.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uNight;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n  totalEmissiveRadiance *= ${day.toFixed(3)} + ${(night - day).toFixed(3)} * uNight;`);
  };
  m.customProgramCacheKey = () => key;
  return m;
}
// the rooms' own light: a warm self-light in proportion to each surface's colour, a little by day (the light that
// comes in), more after dusk (the ceiling panels)
function roomLit(m, day, night, key) {
  m.onBeforeCompile = (s) => {
    s.uniforms.uNight = nightUniform;
    s.fragmentShader = s.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uNight;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n  totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.9, 0.78) * (${day.toFixed(3)} + ${(night - day).toFixed(3)} * uNight);`);
  };
  m.customProgramCacheKey = () => key;
  return m;
}
let MATS = null;
export function stationMaterials() {
  if (MATS) return MATS;
  const hasDoc = typeof document !== 'undefined';
  const T = hasDoc ? { timber: timberTextures(), stone: stoneTextures(), concrete: concreteTextures(), snow: snowTextures(), clock: clockTexture(), tile: tileTextures(), atlas: atlasTexture() } : {};
  const std = (o, tx) => new THREE.MeshStandardMaterial({ vertexColors: true, ...o, ...(tx ? { map: tx.map, normalMap: tx.normalMap } : {}) });
  MATS = {
    stone: std({ roughness: 0.92, metalness: 0, normalScale: new THREE.Vector2(1, 1) }, T.stone),
    timber: std({ roughness: 0.8, metalness: 0, normalScale: new THREE.Vector2(0.9, 0.9) }, T.timber),
    concrete: std({ roughness: 0.9, metalness: 0 }, T.concrete),
    snow: std({ roughness: 0.62, metalness: 0, normalScale: new THREE.Vector2(0.6, 0.6) }, T.snow),
    paint: std({ roughness: 0.5, metalness: 0 }),
    metal: std({ roughness: 0.42, metalness: 0.65 }),
    // glass you see the rooms through: clear with a slight tint, reflecting the sky (scene.environment)
    glass: new THREE.MeshPhysicalMaterial({ color: 0x9fb4bc, roughness: 0.03, metalness: 0, ior: 1.5, specularIntensity: 1, envMapIntensity: 1.6, transmission: 0, transparent: true, opacity: 0.28, depthWrite: false }),
    // glass of rooms you cannot enter: dark, smooth, reflecting the sky; the rooms behind glow warm after dusk
    glassLit: nightScaled(new THREE.MeshPhysicalMaterial({ color: 0x0b1216, roughness: 0.04, metalness: 0.05, ior: 1.5, specularIntensity: 1, envMapIntensity: 1.7, transmission: 0, emissive: 0xffc583, emissiveIntensity: 1 }), 0, 0.85, 'stn-glass-lit'),
    glassDark: new THREE.MeshPhysicalMaterial({ color: 0x0a1014, roughness: 0.05, metalness: 0.05, ior: 1.5, specularIntensity: 1, envMapIntensity: 1.7, transmission: 0 }),
    lamp: nightScaled(new THREE.MeshStandardMaterial({ color: 0xfff1d8, emissive: 0xffd49a, emissiveIntensity: 1, roughness: 0.4 }), 0.12, 2.8, 'stn-lamp'),
    // the rooms: tiles, panelling, plaster and furniture, self-lit (roomLit); the posters and signs
    iFloor: roomLit(std({ roughness: 0.3, metalness: 0, normalScale: new THREE.Vector2(0.5, 0.5) }, T.tile), 0.16, 0.55, 'stn-i-floor'),
    iTimber: roomLit(std({ roughness: 0.6, metalness: 0, normalScale: new THREE.Vector2(0.5, 0.5) }, T.timber), 0.2, 0.62, 'stn-i-timber'),
    iPlaster: roomLit(std({ roughness: 0.85, metalness: 0 }), 0.16, 0.5, 'stn-i-plaster'),
    iPaint: roomLit(std({ roughness: 0.45, metalness: 0 }), 0.16, 0.5, 'stn-i-paint'),
    iMetal: roomLit(std({ roughness: 0.35, metalness: 0.6 }), 0.1, 0.35, 'stn-i-metal'),
    iPoster: roomLit(new THREE.MeshStandardMaterial({ map: T.atlas || null, color: 0xffffff, roughness: 0.55 }), 0.2, 0.6, 'stn-i-poster'),
    clock: nightScaled(new THREE.MeshStandardMaterial({ map: T.clock || null, color: 0xffffff, roughness: 0.35, emissiveMap: T.clock || null, emissive: 0xffffff, emissiveIntensity: 1 }), 0, 0.45, 'stn-clock'),
  };
  for (const m of Object.values(MATS)) m.userData.shared = true;
  return MATS;
}

// ------------------------------------------------------------------ geometry kit
// Parts are collected per material key with a transform stack; every part's uv is a box projection in the building's
// metres (the textures' repeat sets their scale), a vertex colour tints it (paint colours, darker trims).
const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _c = new THREE.Color();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _d = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
function boxUV(g) {
  const p = g.attributes.position, n = p.count, uv = new Float32Array(n * 2);
  for (let i = 0; i + 2 < n; i += 3) {
    _a.fromBufferAttribute(p, i); _b.fromBufferAttribute(p, i + 1).sub(_a); _d.fromBufferAttribute(p, i + 2).sub(_a); _b.cross(_d);
    const ax = Math.abs(_b.x), ay = Math.abs(_b.y), az = Math.abs(_b.z);
    for (let k = i; k < i + 3; k++) {
      const x = p.getX(k), y = p.getY(k), z = p.getZ(k);
      let u, v;
      if (ay >= ax && ay >= az) { u = x; v = _b.y > 0 ? -z : z; } else if (ax >= az) { u = _b.x > 0 ? -z : z; v = y; } else { u = _b.z > 0 ? x : -x; v = y; }
      uv[k * 2] = u; uv[k * 2 + 1] = v;
    }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}
class Kit {
  constructor() { this.parts = new Map(); this.M = new THREE.Matrix4(); this.stack = []; }
  push(pos = [0, 0, 0], rotY = 0) {
    this.stack.push(this.M.clone());
    this.M.multiply(_m.compose(_p.set(pos[0], pos[1], pos[2]), _q.setFromAxisAngle(_up, rotY), _s.set(1, 1, 1)));
    return this;
  }
  pop() { this.M.copy(this.stack.pop()); return this; }
  // geo: any BufferGeometry; p position, r euler [x, y, z] (or q a quaternion), c colour, uv 'box' | 'keep'
  add(key, geo, { p = [0, 0, 0], r = null, q = null, c = 0xffffff, uv = 'box' } = {}) {
    let g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    if (q) _q.copy(q); else _q.setFromEuler(_e.set(r?.[0] || 0, r?.[1] || 0, r?.[2] || 0));
    g.applyMatrix4(_m2.multiplyMatrices(this.M, _m.compose(_p.set(p[0], p[1], p[2]), _q, _s.set(1, 1, 1))));
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && (k !== 'uv' || uv === 'box')) g.deleteAttribute(k);
    if (uv === 'box' || !g.attributes.uv) boxUV(g);
    _c.set(c);
    const n = g.attributes.position.count, col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { col[i * 3] = _c.r; col[i * 3 + 1] = _c.g; col[i * 3 + 2] = _c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    if (!this.parts.has(key)) this.parts.set(key, []);
    this.parts.get(key).push(g);
  }
  box(key, cx, cy, cz, sx, sy, sz, c = 0xffffff, r = null) { this.add(key, new THREE.BoxGeometry(sx, sy, sz), { p: [cx, cy, cz], r, c }); }
  // a square beam of thickness th from a to b
  bar(key, a, b, th, c = 0xffffff) {
    _a.set(a[0], a[1], a[2]); _b.set(b[0], b[1], b[2]);
    const len = _a.distanceTo(_b), q = new THREE.Quaternion().setFromUnitVectors(_up, _d.subVectors(_b, _a).normalize());
    this.add(key, new THREE.BoxGeometry(th, len, th), { p: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], q, c });
  }
  cyl(key, x, y, z, r0, r1, h, seg, c = 0xffffff, r = null) { this.add(key, new THREE.CylinderGeometry(r0, r1, h, seg), { p: [x, y, z], r, c }); }
  build() {
    const out = [];
    for (const [key, list] of this.parts) {
      const g = mergeGeometries(list, false);
      for (const x of list) x.dispose();
      if (!g) continue;
      g.computeBoundingBox(); g.computeBoundingSphere();
      g.userData.shared = true; // (one per kind of building, for every station: never disposed with an express station)
      out.push([key, g]);
    }
    return out;
  }
}

// a wall's own frame: origin at the face's middle on the ground, local +z out of the wall, local x along it (to the
// right seen from outside); B: the storey's plan box { x0, x1, z0, z1 }
function onWall(K, face, B) {
  const cx = (B.x0 + B.x1) / 2, cz = (B.z0 + B.z1) / 2;
  if (face === 'front') K.push([cx, 0, B.z0], Math.PI);
  else if (face === 'back') K.push([cx, 0, B.z1], 0);
  else if (face === 'left') K.push([B.x0, 0, cz], -Math.PI / 2);
  else K.push([B.x1, 0, cz], Math.PI / 2);
}

// ------------------------------------------------------------------ colours (sRGB)
const C = {
  stone: 0xdcd7cd, plinth: 0xa8a39a, dressed: 0xffffff, mortarCap: 0xc9c4b8,
  timber: 0xffffff, trim: 0x8a7462, soffit: 0xc4ae96, door: 0xa07e62,
  frame: 0xf1eee6, frameDark: 0x2b2f34, shutterGreen: 0x2f4c3a, shutterRed: 0x7c2a22,
  metal: 0x3a403d, galv: 0x9a9ea2, black: 0x1d2023, concrete: 0xffffff, fascia: 0x4f5459,
};

// ------------------------------------------------------------------ components (in a wall frame)
// a window: frame, glass, mullion + transom, sill (with snow), optional stone surround, shutters, a timber lintel
function windowAt(K, x, y0, w, h, { lit = true, see = false, frame = C.frame, frameKey = 'paint', surround = false, shutters = null, cross = true, sill = 'stone', deep = 0 } = {}) {
  const f = 0.075, d = 0.11, z = deep;
  if (surround) {
    K.box('stone', x, y0 + h + 0.13, z + 0.05, w + 0.44, 0.26, 0.12, C.dressed); // lintel
    for (const s of [-1, 1]) K.box('stone', x + s * (w / 2 + 0.1), y0 + h / 2, z + 0.04, 0.2, h + 0.02, 0.1, C.dressed);
  }
  K.box(frameKey, x, y0 + h - f / 2, z + d / 2, w, f, d, frame);
  K.box(frameKey, x, y0 + f / 2, z + d / 2, w, f, d, frame);
  for (const s of [-1, 1]) K.box(frameKey, x + s * (w / 2 - f / 2), y0 + h / 2, z + d / 2, f, h - 2 * f, d, frame);
  K.box(see ? 'glass' : lit ? 'glassLit' : 'glassDark', x, y0 + h / 2, z + 0.03, w - 2 * f + 0.01, h - 2 * f + 0.01, 0.02);
  if (cross) {
    K.box(frameKey, x, y0 + h / 2, z + 0.06, 0.05, h - 2 * f, 0.05, frame);
    K.box(frameKey, x, y0 + (h - 2 * f) * 0.66 + f, z + 0.06, w - 2 * f, 0.05, 0.05, frame);
  }
  // the sill: stone (or sheet metal) proud of the wall, snow lying on it
  const sw = w + (surround ? 0.44 : 0.16);
  K.box(sill === 'stone' ? 'stone' : 'metal', x, y0 - 0.04, z + 0.1, sw, 0.08, 0.22, sill === 'stone' ? C.dressed : C.galv);
  K.box('snow', x, y0 + 0.02, z + 0.1, sw - 0.06, 0.05, 0.18);
  if (shutters) for (const s of [-1, 1]) {
    const lw = w / 2 + 0.02, cx = x + s * (w / 2 + lw / 2 + (surround ? 0.22 : 0.05));
    K.box('paint', cx, y0 + h / 2, z + 0.03, lw, h + 0.04, 0.04, shutters);
    for (let k = 0; k < 7; k++) K.box('paint', cx, y0 + 0.12 + ((h - 0.2) * k) / 6, z + 0.06, lw - 0.06, 0.035, 0.02, shutters); // louvres
    K.box('metal', cx - s * (lw / 2 - 0.04), y0 + h * 0.2, z + 0.06, 0.03, 0.04, 0.03, C.black);
  }
}
// a door: frame, timber leaves with raised panels and glazed tops (double: two leaves), handles, a stone surround
// open: 'slide' (the leaves parked aside behind the wall, t thick), 'none' (no leaves: swung in, drawn by the caller)
function doorAt(K, x, w, h, { double = true, surround = false, lit = true, leaf = C.door, frame = C.frameDark, open = false, t = 0.3 } = {}) {
  if (surround) {
    K.box('stone', x, h + 0.16, 0.06, w + 0.6, 0.32, 0.14, C.dressed);
    for (const s of [-1, 1]) K.box('stone', x + s * (w / 2 + 0.14), h / 2, 0.05, 0.28, h, 0.12, C.dressed);
  }
  K.box('paint', x, h - 0.05, 0.06, w, 0.1, 0.12, frame);
  for (const s of [-1, 1]) K.box('paint', x + s * (w / 2 - 0.05), (h - 0.1) / 2, 0.06, 0.1, h - 0.1, 0.12, frame);
  const leaves = double ? [-1, 1] : [0], lw = (w - 0.2) / leaves.length, lh = h - 0.12;
  for (const s of leaves) {
    if (open === 'none') break;
    if (open === 'slide') { // (a glazed leaf parked against the wall inside, beside the opening)
      const cx = x + (s || 1) * (w / 2 + lw / 2 - 0.05), z = -t - 0.05;
      for (const e of [-1, 1]) { K.box('metal', cx + e * (lw / 2 - 0.03), lh / 2, z, 0.06, lh, 0.05, C.frameDark); K.box('metal', cx, lh / 2 + e * (lh / 2 - 0.04), z, lw, 0.08, 0.05, C.frameDark); }
      K.box('glass', cx, lh / 2, z, lw - 0.1, lh - 0.14, 0.012);
      continue;
    }
    const cx = double ? x + (s * lw) / 2 : x;
    K.box('timber', cx, lh / 2, 0.035, lw - 0.01, lh, 0.05, leaf);
    K.box('timber', cx, lh * 0.24, 0.07, lw - 0.24, lh * 0.32, 0.03, leaf); // raised panel
    K.box(lit ? 'glass' : 'glassDark', cx, lh * 0.7, 0.065, lw - 0.24, lh * 0.42, 0.02);
    K.box('timber', cx, lh * 0.7, 0.075, 0.05, lh * 0.42, 0.03, leaf); // glazing bar
    K.box('metal', cx - (double ? s : 1) * (lw / 2 - 0.1), lh * 0.47, 0.1, 0.03, 0.18, 0.04, C.galv); // handle
  }
  K.box('stone', x, 0.02, 0.2, w + 0.3, 0.04, 0.4, C.dressed); // threshold
}
// a wall lantern: bracket arm, a glowing lantern body under a cap
function lanternAt(K, x, y) {
  K.box('metal', x, y + 0.36, 0.2, 0.04, 0.04, 0.4, C.black);
  K.box('metal', x, y + 0.36, 0.02, 0.12, 0.2, 0.04, C.black);
  K.box('lamp', x, y + 0.12, 0.38, 0.17, 0.26, 0.17);
  K.box('metal', x, y + 0.27, 0.38, 0.24, 0.05, 0.24, C.black);
  K.box('metal', x, y - 0.02, 0.38, 0.2, 0.04, 0.2, C.black);
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) K.box('metal', x + sx * 0.09, y + 0.12, 0.38 + sz * 0.09, 0.02, 0.28, 0.02, C.black);
}
// a bench against the wall (wall frame): slats on two steel frames, its backrest the wall's own boards
function wallBench(K, x, w) {
  for (let i = 0; i < 3; i++) K.box('timber', x, 0.45, 0.1 + i * 0.13, w, 0.045, 0.11, C.door);
  for (const s of [-1, 1]) { K.box('metal', x + s * (w / 2 - 0.15), 0.22, 0.25, 0.05, 0.44, 0.05, C.black); K.box('metal', x + s * (w / 2 - 0.15), 0.42, 0.18, 0.05, 0.04, 0.36, C.black); }
  for (let i = 0; i < 2; i++) K.box('timber', x, 0.68 + i * 0.16, 0.035, w, 0.11, 0.03, C.door);
}
// a double-faced station clock hanging on a bracket (local: faces toward +-x), centre at (x, y, z)
function clockAt(K, x, y, z, r = 0.38, faceAxis = 'x') {
  const rot = faceAxis === 'x' ? [0, 0, Math.PI / 2] : [Math.PI / 2, 0, 0];
  K.cyl('metal', x, y, z, r + 0.05, r + 0.05, 0.14, 24, C.black, rot);
  for (const s of [-1, 1]) {
    const g = new THREE.CircleGeometry(r, 32);
    const p = faceAxis === 'x' ? [x + s * 0.072, y, z] : [x, y, z + s * 0.072];
    const ry = faceAxis === 'x' ? s * Math.PI / 2 : (s > 0 ? 0 : Math.PI);
    K.add('clock', g, { p, r: [0, ry, 0], uv: 'keep' });
  }
}
// the snow on a roof: the roof's top line in profile (z, y), front to back, extruded along x from x0 to x1, T thick,
// a rounded cornice over each eave and rounded ends (creased normals: soft, not faceted)
function snowCap(K, pts, x0, x1, T) {
  const s = new THREE.Shape(), n = pts.length, sink = 0.06;
  const seg = (i) => Math.atan2(pts[i + 1][1] - pts[i][1], pts[i + 1][0] - pts[i][0]);
  const tv = (i) => { const a = i === 0 ? seg(0) : i === n - 1 ? seg(n - 2) : (seg(i - 1) + seg(i)) / 2; return T / Math.max(0.5, Math.cos(a)); };
  const [zf, yf] = pts[0], [zb, yb] = pts[n - 1];
  s.moveTo(zf + 0.02, yf - sink);
  s.quadraticCurveTo(zf - 0.2, yf + tv(0) * 0.35, zf + 0.12, yf + tv(0));
  for (let i = 1; i < n - 1; i++) {
    const [z, y] = pts[i], t = tv(i);
    const k0 = 0.6 / Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]), k1 = 0.6 / Math.hypot(pts[i + 1][0] - z, pts[i + 1][1] - y);
    const ta = tv(i - 1), tb = tv(i + 1);
    s.lineTo(z + (pts[i - 1][0] - z) * k0, y + (pts[i - 1][1] - y) * k0 + (t + (ta - t) * k0));
    s.quadraticCurveTo(z, y + t + 0.05, z + (pts[i + 1][0] - z) * k1, y + (pts[i + 1][1] - y) * k1 + (t + (tb - t) * k1));
  }
  s.lineTo(zb - 0.12, yb + tv(n - 1));
  s.quadraticCurveTo(zb + 0.2, yb + tv(n - 1) * 0.35, zb - 0.02, yb - sink);
  for (let i = n - 2; i >= 1; i--) s.lineTo(pts[i][0], pts[i][1] - sink);
  const bt = 0.16, depth = Math.max(0.1, x1 - x0 - 2 * bt);
  let g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: true, bevelThickness: bt, bevelSize: 0.08, bevelSegments: 3, curveSegments: 6, steps: 1 });
  g.deleteAttribute('normal'); g.deleteAttribute('uv');
  g = toCreasedNormals(g, 0.75);
  // shape x -> z, shape y -> y, extrusion -> -x (rotated -90 about y), its far end at x1
  K.add('snow', g, { p: [x1 - bt, 0, 0], r: [0, -Math.PI / 2, 0] });
}
// a gable roof, its ridge along local x, over walls L long (x) and D deep (z) centred on the origin, the walls' top
// at eaveY; slabs (the boarded soffit underneath), fascias, barge boards, gutters, rafter tails, the purlins' ends
// and their brackets under the gable overhangs, the snow on top. Returns its ridge's top (snow included).
function gableRoof(K, { L, D, eaveY, pitch, ovS, ovG, t = 0.28, snowT = 0.42, fasciaKey = 'timber', fascia = C.trim, soffit = C.soffit, slabKey = 'timber', rafters = true, purlins = true, gutter = true }) {
  const tp = Math.tan(pitch), cp = Math.cos(pitch), sp = Math.sin(pitch), hs = D / 2 + ovS, Lx = L / 2 + ovG, tv = t / cp;
  const yBot = (z) => eaveY + (D / 2 - Math.abs(z)) * tp;
  for (const s of [-1, 1]) {
    const zE = s * hs, yE = yBot(zE), yR = yBot(0), len = hs / cp + 0.06;
    const cz = zE / 2 + s * sp * (t / 2), cy = (yE + yR) / 2 + cp * (t / 2);
    K.box(slabKey, 0, cy, cz, 2 * Lx, t, len, soffit, [s * pitch, 0, 0]);
    K.box(fasciaKey, 0, yE + tv / 2 - 0.03, zE + s * 0.03, 2 * Lx + 0.08, tv + 0.1, 0.06, fascia);
    if (gutter) K.cyl('metal', 0, yE - 0.04, zE + s * 0.13, 0.075, 0.075, 2 * Lx, 10, C.galv, [0, 0, Math.PI / 2]);
    for (const g of [-1, 1]) K.box(fasciaKey, g * (Lx + 0.03), cy + 0.03, cz, 0.06, t + 0.14, len, fascia, [s * pitch, 0, 0]);
    if (rafters) for (let x = -Lx + 0.45; x <= Lx - 0.44; x += 0.86) {
      const zm = s * (D / 2 + ovS / 2 - 0.05), ym = yBot(zm) - 0.075;
      K.box('timber', x, ym, zm, 0.11, 0.15, ovS / cp - 0.1, fascia, [s * pitch, 0, 0]);
    }
  }
  if (purlins) {
    for (const z of [0, -D / 4, D / 4, -D / 2 + 0.12, D / 2 - 0.12]) {
      const yb = yBot(z) - 0.13;
      for (const g of [-1, 1]) {
        K.box('timber', g * (L / 2 + ovG / 2 - 0.04), yb, z, ovG + 0.08, 0.26, 0.2, fascia);
        if (Math.abs(z) < D / 2 - 0.5) K.bar('timber', [g * L / 2, yb - 0.13 - ovG * 0.95, z], [g * (L / 2 + ovG * 0.82), yb - 0.1, z], 0.13, fascia); // the bracket (Bug)
      }
    }
  }
  const yTop = (z) => yBot(z) + tv;
  snowCap(K, [[-hs, yTop(-hs)], [0, yTop(0)], [hs, yTop(hs)]], -Lx - 0.05, Lx + 0.05, snowT);
  return { ridge: yTop(0) + snowT, yBot };
}
// the triangle of a gable between the walls' top and the roof (wall frame of a gable face), w wide, rise high
function gableTri(K, key, w, y0, rise, color = 0xffffff, thick = 0.3, x = 0) {
  const s = new THREE.Shape();
  s.moveTo(x - w / 2, y0); s.lineTo(x + w / 2, y0); s.lineTo(x, y0 + rise); s.closePath();
  K.add(key, new THREE.ExtrudeGeometry(s, { depth: thick, bevelEnabled: false }), { p: [0, 0, -thick], c: color });
}
// quoins: dressed corner stones, alternately long and short on either face, a little proud of the walls
function quoins(K, B, y0, y1, step = 0.42) {
  let alt = 0;
  for (let y = y0; y + step <= y1 + 0.01; y += step, alt ^= 1) {
    for (const [X, dx] of [[B.x0, 1], [B.x1, -1]]) for (const [Z, dz] of [[B.z0, 1], [B.z1, -1]]) {
      const a = alt ? 0.72 : 0.42, b = alt ? 0.42 : 0.72;
      K.box('stone', X + dx * (a - 0.04) / 2 - dx * 0.04, y + step / 2, Z + dz * (b - 0.04) / 2 - dz * 0.04, a + 0.04, step - 0.025, b + 0.04, C.dressed);
    }
  }
}
// corner boards on a timber storey
function cornerBoards(K, B, y0, y1) {
  for (const X of [B.x0, B.x1]) for (const Z of [B.z0, B.z1]) K.box('timber', X, (y0 + y1) / 2, Z, 0.17, y1 - y0, 0.17, C.trim);
}
const span = (B) => ({ w: B.x1 - B.x0, d: B.z1 - B.z0, cx: (B.x0 + B.x1) / 2, cz: (B.z0 + B.z1) / 2 });


// a wall with openings, in a wall frame: x0..x1 along it, y0..y1, its outer face at z = zOut, t thick inward; each
// hole { x, w, y0, y1 } cut through it (pieces between the openings: the reveals come with them)
function holedWall(K, key, color, x0, x1, y0, y1, t, holes, zOut = 0) {
  const xs = new Set([x0, x1]);
  for (const h of holes) for (const e of [h.x - h.w / 2, h.x + h.w / 2]) if (e > x0 && e < x1) xs.add(e);
  const arr = [...xs].sort((a, b) => a - b);
  for (let i = 0; i < arr.length - 1; i++) {
    const a = arr[i], b = arr[i + 1], m = (a + b) / 2;
    if (b - a < 0.005) continue;
    const cov = holes.filter((h) => Math.abs(m - h.x) < h.w / 2 && h.y1 > y0 && h.y0 < y1).sort((p, q) => p.y0 - q.y0);
    let cur = y0;
    for (const h of cov) {
      const top = Math.max(y0, Math.min(y1, h.y0));
      if (top - cur > 0.005) K.box(key, m, (cur + top) / 2, zOut - t / 2, b - a, top - cur, t, color);
      cur = Math.max(cur, Math.min(y1, h.y1));
    }
    if (y1 - cur > 0.005) K.box(key, m, (cur + y1) / 2, zOut - t / 2, b - a, y1 - cur, t, color);
  }
}
const hole = (x, w, y0, y1) => ({ x, w, y0, y1 });
// a poster / sign from the atlas, w x h, facing local +z (ry turns it)
function atlasPlane(K, region, x, y, z, w, h, ry = 0) {
  const g = new THREE.PlaneGeometry(w, h), uv = g.attributes.uv, [u0, v0, u1, v1] = ATLAS[region];
  for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
  K.add('iPoster', g, { p: [x, y, z], r: [0, ry, 0], uv: 'keep' });
}
// a waiting-room bench: four slats on steel legs and a backrest; facing: where a sitter looks (+1 +z, -1 -z)
function hallBench(K, x, z, len, facing, y0, back = true) {
  for (let i = 0; i < 4; i++) K.box('iTimber', x, y0 + 0.45, z + facing * (-0.15 + i * 0.1), len, 0.04, 0.085, C.door);
  for (const e of len > 2 ? [-1, 0, 1] : [-1, 1]) K.box('iMetal', x + e * (len / 2 - 0.2), y0 + 0.22, z, 0.05, 0.44, 0.4, C.black);
  if (back) {
    for (let i = 0; i < 2; i++) K.box('iTimber', x, y0 + 0.62 + i * 0.15, z - facing * 0.22, len, 0.11, 0.03, C.door);
    for (const e of [-1, 1]) K.box('iMetal', x + e * (len / 2 - 0.2), y0 + 0.68, z - facing * 0.22, 0.04, 0.5, 0.04, C.black);
  }
}
// a wall clock facing local +z
function wallClock(K, x, y, z, r) {
  K.cyl('iMetal', x, y, z - 0.02, r + 0.04, r + 0.04, 0.05, 28, C.black, [Math.PI / 2, 0, 0]);
  K.add('clock', new THREE.CircleGeometry(r, 32), { p: [x, y, z + 0.01], uv: 'keep' });
}
// a room's lining on a wall (wall frame, its inner face at z = -t): wainscot to `dado`, plaster above to `ceil`
function lining(K, x0, x1, floor, ceil, t, holes, dado = 1.15, plaster = 0xf3ece0) {
  if (dado > floor) holedWall(K, 'iTimber', C.door, x0, x1, floor, dado, 0.02, holes, -t);
  if (ceil > dado) holedWall(K, 'iPlaster', plaster, x0, x1, Math.max(floor, dado), ceil, 0.02, holes, -t);
  if (dado > floor) holedWall(K, 'iTimber', C.trim, x0, x1, dado - 0.025, dado + 0.025, 0.03, holes, -t - 0.02); // the dado rail
}

// ------------------------------------------------------------------ plans: colliders and floors (no geometry)
// Local rects { cx, cz, hx, hz, top? } (top: over the base; stepped onto / jumped), the walkable floors { x0, x1, z0,
// z1 } at FLOOR[kind], and `outer`: the closed footprint, should the building not be walk-in where it stands.
const R = (x0, x1, z0, z1, top) => ({ cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, hx: (x1 - x0) / 2, hz: (z1 - z0) / 2, ...(top !== undefined ? { top } : {}) });
const F_ = (x0, x1, z0, z1) => ({ x0, x1, z0, z1 });
export function stationPlan(kind, { apron = -1.2 } = {}) {
  const f = FLOOR[kind];
  if (kind === 'valley') return {
    floorY: f,
    floors: [F_(-9.1, 9.1, 1.8, 12.2), F_(-1.05, 1.05, 1.4, 1.85), F_(-9.75, 9.75, apron, 1.5), F_(-10.2, -9.05, 6.3, 7.7), F_(9.05, 10.2, 6.3, 7.7)],
    colliders: [
      R(-9.4, -1.05, 1.5, 1.8), R(1.05, 9.4, 1.5, 1.8), R(-9.4, 9.4, 12.2, 12.5), // the front (the door) and the back
      R(-9.4, -9.1, 1.8, 6.5), R(-9.4, -9.1, 7.5, 12.2), R(9.1, 9.4, 1.8, 6.5), R(9.1, 9.4, 7.5, 12.2), // the gables (their doors)
      R(-5.25, 5.25, 12.5, 20.65), // the office wing
      R(-2.75, 2.75, 10.85, 12.2), // the ticket counter and the office behind its screen
      R(-6.55, -3.45, 6.4, 7.6, f + 0.95), R(3.45, 6.55, 6.4, 7.6, f + 0.95), // the benches back to back
      R(4.55, 7.45, 11.6, 12.2, f + 0.95), // the bench by the back wall
      R(-8.75, -3.25, 11.65, 12.2), // the ski rack
      R(7.95, 9.1, 1.8, 2.75), // the vending machine
      R(-6.15, -4.65, 1.02, 1.5, 0.55), R(4.65, 6.15, 1.02, 1.5, 0.55), // the benches outside, under the canopy
    ],
    outer: [R(-9.45, 9.45, 1.45, 12.55), R(-5.25, 5.25, 12.5, 20.65)],
  };
  if (kind === 'halt') return {
    floorY: f,
    floors: [F_(-2.98, 2.98, 1.72, 6.08), F_(-2.1, -1.1, 1.4, 1.75), F_(-3.45, 3.45, apron, 1.5)],
    colliders: [
      R(-3.2, -2.1, 1.5, 1.72), R(-1.1, 3.2, 1.5, 1.72), R(-3.2, 3.2, 6.08, 6.3), R(-3.2, -2.98, 1.72, 6.08), R(2.98, 3.2, 1.72, 6.08),
      R(-2.1, -1.98, 1.72, 2.7), // the door, swung in
      R(-1.35, 2.8, 5.6, 6.08, f + 0.95), // the bench
      R(-2.55, -1.75, 5.15, 5.85), // the stove
      R(-0.85, 2.85, 1.02, 1.5, 0.55), // the bench outside
    ],
    outer: [R(-3.25, 3.25, 1.45, 6.35)],
  };
  // glacier
  return {
    floorY: f,
    floors: [F_(-8.7, 8.7, 1.2, 13.1), F_(-5.4, 5.4, 1.1, 1.3), F_(-1.35, 1.35, -0.3, 1.2)],
    colliders: [
      R(-5.4, -1.35, 1.0, 1.36), R(1.35, 5.4, 1.0, 1.36), // the glass front either side of the doors (their leaves slid behind it)
      R(-9, -5.4, 0.4, 1.2), R(5.4, 9, 0.4, 1.2), // its side blocks
      R(-9, -8.7, 1.2, 13.4), R(8.7, 9, 1.2, 13.4), R(-9, 9, 13.1, 13.4), // the side walls, the back
      R(3.4, 9, 9.0, 15.05), // the tower (the lifts)
      R(-8.7, -5.1, 10.5, 11.3), R(-8.7, -5.1, 12.5, 13.1), // the kiosk's counter, its shelves
      R(-6.1, -2.9, 5.6, 6.4, f + 0.95), R(-6.1, -2.9, 8.6, 9.4, f + 0.95), R(-0.8, 2.4, 5.6, 6.4, f + 0.95), // benches
      R(2.0, 2.6, 2.7, 3.3), // the screen's stand
    ],
    outer: [R(-9.05, 9.05, 0.35, 13.45), R(3.4, 9.05, 9.0, 15.05)],
  };
}

// ------------------------------------------------------------------ the valley station
function buildValley(K, { plinth, apron, board }) {
  const B = { x0: -9.4, x1: 9.4, z0: 1.5, z1: 12.5 }, S = span(B), t = 0.3, F = FLOOR.valley, h1 = 3.7, h2b = 3.86, eave = 6.75, CEIL = 3.45;
  const G = { x0: -9.4, x1: 9.4, z0: 1.5 + t, z1: 12.5 - t }; // (the gables' walls run between the front and the back)
  // the plinth (down into the ground wherever it falls away) to the floor's level, the paved apron from the platform to
  // the doors, steps at the gable doors
  K.box('stone', 0, (F - 0.02 - plinth) / 2, S.cz, S.w + 0.16, F - 0.02 + plinth, S.d + 0.16, C.plinth);
  K.box('stone', 0, (F - plinth) / 2, (apron + B.z0) / 2, S.w + 0.7, F + plinth, B.z0 - apron, C.plinth);
  for (const sx of [-1, 1]) K.box('stone', sx * 9.8, (F - plinth) / 2, 7.0, 0.8, F + plinth, 1.4, C.plinth);
  // the openings
  const front = [hole(0, 2.1, 0, 2.75), hole(-7, 1.28, 1.0, 2.75), hole(7, 1.28, 1.0, 2.75), hole(3.6, 1.28, 1.0, 2.75), hole(-3.6, 1.68, 0.95, 2.75)];
  const back = [hole(-7.4, 1.18, 1.0, 2.6), hole(7.4, 1.18, 1.0, 2.6)];
  const gable = [hole(-2.7, 1.18, 1.0, 2.7), hole(2.7, 1.18, 1.0, 2.7), hole(0, 1.0, 0, 2.2)];
  // the stone ground floor: hollow walls round the waiting hall, a socle course outside, the quoins
  for (const [face, holes, Bx] of [['front', front, B], ['back', back, B], ['left', gable, G], ['right', gable, G]]) {
    const half = face === 'front' || face === 'back' ? S.w / 2 : (G.z1 - G.z0) / 2;
    onWall(K, face, Bx);
    holedWall(K, 'stone', C.stone, -half, half, 0, h1, t, holes);
    const ext = face === 'front' || face === 'back' ? 0.08 : t + 0.08;
    holedWall(K, 'stone', C.plinth, -half - ext, half + ext, 0, 0.55, 0.08, holes.filter((h) => h.y0 < 0.55), 0.08);
    lining(K, -half + (face === 'front' || face === 'back' ? t : 0), half - (face === 'front' || face === 'back' ? t : 0), F, CEIL, t, holes);
    K.pop();
  }
  quoins(K, B, 0.62, h1);
  K.box('timber', 0, (h1 + h2b) / 2, S.cz, S.w + 0.16, h2b - h1, S.d + 0.16, C.trim); // the belt between the storeys
  K.box('timber', 0, (h2b + eave) / 2, S.cz, S.w, eave - h2b, S.d, C.timber);
  cornerBoards(K, B, h2b, eave);
  // the front, to the track: the waiting hall's open doors, the ticket window, windows; above them the name board
  onWall(K, 'front', B);
  doorAt(K, 0, 2.1, 2.75, { surround: true, open: 'slide', t });
  lanternAt(K, -1.7, 2.3); lanternAt(K, 1.7, 2.3);
  for (const x of [-7.0, 7.0, 3.6]) windowAt(K, x, 1.0, 1.3, 1.75, { surround: true, see: true });
  windowAt(K, -3.6, 0.95, 1.7, 1.8, { surround: true, see: true }); // the ticket window, its counter
  K.box('stone', -3.6, 1.0, 0.24, 1.9, 0.08, 0.42, C.dressed);
  K.box('metal', -3.6, 3.12, 0.45, 2.2, 0.06, 0.9, C.metal); K.box('snow', -3.6, 3.18, 0.45, 2.1, 0.06, 0.82); // its little canopy
  for (const x of [-5.4, 5.4]) wallBench(K, x, 1.4);
  for (const x of [-7.6, -5.0, 5.0, 7.6]) windowAt(K, x, 4.55, 1.1, 1.35, { shutters: C.shutterGreen, sill: 'metal', lit: x !== 5.0 });
  K.pop();
  onWall(K, 'back', B);
  for (const x of [-7.4, 7.4]) windowAt(K, x, 1.0, 1.2, 1.6, { surround: true, see: true });
  for (const x of [-7.6, 7.6]) windowAt(K, x, 4.55, 1.1, 1.35, { shutters: C.shutterGreen, sill: 'metal', lit: x > 0 });
  K.pop();
  // the gables: windows below, the open doors, a balcony on the upper floor with its door, the gable triangle
  for (const face of ['left', 'right']) {
    onWall(K, face, G);
    for (const x of [-2.7, 2.7]) windowAt(K, x, 1.0, 1.2, 1.7, { surround: true, see: true });
    doorAt(K, 0, 1.0, 2.2, { double: false, leaf: C.door, frame: C.frame, open: 'slide', t });
    // inside: a poster either side of the door
    atlasPlane(K, 'timetable', 1.25, 1.85, -t - 0.035, 0.62, 0.93, Math.PI);
    atlasPlane(K, 'travel', -1.25, 1.85, -t - 0.035, 0.62, 0.93, Math.PI);
    K.push([0, h2b + 0.1, 0]);
    windowAt(K, -2.0, 0.6, 0.9, 1.3, { shutters: C.shutterGreen, sill: 'metal' });
    windowAt(K, 2.0, 0.6, 0.9, 1.3, { shutters: C.shutterGreen, sill: 'metal', lit: false });
    K.pop();
    K.push([0, h2b + 0.02, 0]); doorAt(K, 0, 1.0, 2.15, { double: false, leaf: C.door, frame: C.frame }); K.pop();
    const bw = 6.6, bd = 1.3, fy = h2b;
    K.box('timber', 0, fy - 0.07, bd / 2, bw, 0.14, bd, C.trim);
    for (const x of [-2.9, -1.0, 1.0, 2.9]) K.bar('timber', [x, fy - 0.75, 0.05], [x, fy - 0.16, bd - 0.15], 0.12, C.trim);
    for (const x of [-3.2, 3.2]) K.box('timber', x, fy + 0.52, bd - 0.05, 0.1, 1.04, 0.1, C.trim);
    K.box('timber', 0, fy + 1.04, bd - 0.05, bw, 0.08, 0.16, C.trim);
    K.box('timber', 0, fy + 0.1, bd - 0.05, bw, 0.08, 0.1, C.trim);
    for (let x = -bw / 2 + 0.12; x <= bw / 2 - 0.1; x += 0.2) K.box('timber', x, fy + 0.57, bd - 0.05, 0.14, 0.86, 0.03, C.timber);
    for (const sx of [-1, 1]) {
      K.box('timber', sx * (bw / 2 - 0.05), fy + 1.04, bd / 2, 0.16, 0.08, bd, C.trim);
      for (let z = 0.15; z < bd - 0.1; z += 0.2) K.box('timber', sx * (bw / 2 - 0.05), fy + 0.57, z, 0.03, 0.86, 0.14, C.timber);
    }
    K.box('snow', 0, fy + 0.04, bd / 2 - 0.05, bw - 0.3, 0.08, bd - 0.2);
    K.box('snow', 0, fy + 1.1, bd - 0.05, bw, 0.05, 0.15);
    K.pop();
    onWall(K, face, B);
    gableTri(K, 'timber', S.d, eave, (S.d / 2) * Math.tan(0.436), C.timber);
    for (const x of [-1.4, 1.4]) windowAt(K, x, eave + 0.45, 0.7, 0.85, { lit: false, sill: 'metal' }); // (clear of the ridge purlin's bracket)
    K.pop();
  }
  K.push([0, 0, S.cz]);
  gableRoof(K, { L: S.w, D: S.d, eaveY: eave, pitch: 0.436, ovS: 1.4, ovG: 1.35, t: 0.3, snowT: 0.44 });
  K.pop();
  // the chimney on the back slope
  K.box('stone', 4.4, 8.6, 9.6, 0.75, 3.0, 0.75, C.stone);
  K.box('stone', 4.4, 10.12, 9.6, 0.95, 0.08, 0.95, C.dressed);
  for (const [dx, dz] of [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]]) K.box('stone', 4.4 + dx, 10.26, 9.6 + dz, 0.1, 0.22, 0.1, C.dressed);
  K.box('stone', 4.4, 10.42, 9.6, 0.95, 0.08, 0.95, C.dressed);
  K.box('snow', 4.4, 10.51, 9.6, 0.9, 0.1, 0.9);
  // ---- the waiting hall: granite tiles, a plastered ceiling on timber beams with warm light panels
  K.box('iFloor', 0, F - 0.015, S.cz, 18.2, 0.03, 10.4, 0xffffff);
  K.box('iPlaster', 0, CEIL + 0.04, S.cz, 18.2, 0.08, 10.4, 0xf6efe4);
  for (let x = -7.05; x <= 7.06; x += 2.35) K.box('iTimber', x, CEIL - 0.11, S.cz, 0.2, 0.22, 10.4, C.trim);
  for (const x of [-8.2, -5.85, -3.5, -1.15, 1.15, 3.5, 5.85, 8.2]) for (const z of [4.4, 9.6]) K.box('lamp', x, CEIL - 0.015, z, 1.3, 0.03, 0.42);
  // the ticket counter: timber with a stone top, the clerk's screen, the header with the sign and the departures board
  K.box('iTimber', 0, F + 0.53, 11.2, 5.2, 1.06, 0.6, C.door);
  for (let x = -2.2; x <= 2.21; x += 1.1) K.box('iTimber', x, F + 0.55, 10.89, 0.9, 0.8, 0.03, C.trim); // its panels
  K.box('stone', 0, F + 1.085, 11.15, 5.3, 0.05, 0.72, C.dressed);
  K.box('glass', 0, F + 1.75, 11.25, 5.2, 1.25, 0.02);
  for (let x = -2.6; x <= 2.61; x += 1.3) K.box('iMetal', x, F + 1.75, 11.25, 0.05, 1.25, 0.05, C.galv);
  K.box('iMetal', 0, F + 1.12, 11.25, 5.2, 0.04, 0.06, C.galv);
  K.box('iPlaster', 0, (F + 2.38 + CEIL) / 2, 11.0, 5.4, CEIL - F - 2.38, 0.2, 0xf3ece0);
  for (const sx of [-1, 1]) K.box('iPlaster', sx * 2.65, (F + CEIL) / 2, 11.55, 0.1, CEIL - F, 1.3, 0xf3ece0);
  atlasPlane(K, 'tickets', -1.75, F + 2.9, 10.89, 1.5, 0.5, Math.PI);
  // behind the screen: the office's shelves of tickets and files, a ticket printer
  K.box('iTimber', 0, F + 1.4, 12.05, 4.8, 2.0, 0.25, C.trim);
  for (let k = 0; k < 14; k++) K.box('iPaint', -2.1 + k * 0.32, F + 1.85, 11.95, 0.12, 0.3, 0.2, [0xa5141c, 0x1f3f6e, 0xe8e2d4, 0x2f4c3a][k % 4]);
  K.box('iPaint', -1.2, F + 1.2, 11.55, 0.45, 0.25, 0.4, 0x2b2f34);
  // the clock over the front door, the benches, the ski rack, the vending machine
  wallClock(K, 0, 3.08, 1.5 + t + 0.02, 0.27);
  for (const sx of [-1, 1]) { hallBench(K, sx * 5.0, 6.75, 3.0, -1, F); hallBench(K, sx * 5.0, 7.25, 3.0, 1, F); }
  hallBench(K, 6.0, 11.95, 2.8, -1, F, false);
  K.box('iMetal', -6.0, F + 0.45, 11.98, 5.4, 0.05, 0.06, C.black);
  K.box('iMetal', -6.0, F + 1.4, 11.98, 5.4, 0.05, 0.06, C.black);
  for (const x of [-8.6, -3.4]) K.box('iMetal', x, F + 0.75, 11.98, 0.06, 1.5, 0.3, C.black);
  const skiCol = [0xd0202a, 0x1b6fd1, 0xf2c200, 0x111316, 0x2fae5a, 0xe86a1a];
  for (let k = 0; k < 9; k++) for (const d of [-0.06, 0.06]) {
    const x = -8.2 + k * 0.55 + d, y = F + 0.9;
    K.add('iPaint', new THREE.BoxGeometry(0.075, 1.7, 0.02), { p: [x, y, 11.86], r: [0.12, 0, 0], c: skiCol[k % skiCol.length] });
  }
  K.box('iPaint', 8.5, F + 0.95, 2.18, 0.9, 1.9, 0.72, 0xb3202a);
  K.box('lamp', 8.35, F + 1.3, 2.55, 0.55, 0.9, 0.02);
  K.box('glassDark', 8.75, F + 1.15, 2.55, 0.18, 0.5, 0.02);
  K.box('iPaint', 8.5, F + 0.35, 2.55, 0.7, 0.18, 0.04, 0x1d2023);
  // ---- the station office's rear wing (closed): stone base, timber walls, its own gable roof
  const W = { x0: -5.2, x1: 5.2, z0: 12.5, z1: 20.6 }, WS = span(W), we = 3.3;
  K.box('stone', 0, (0.9 - plinth) / 2, WS.cz + 0.04, WS.w + 0.16, 0.9 + plinth, WS.d + 0.08, C.plinth);
  K.box('stone', 0, 0.93, WS.cz + 0.04, WS.w + 0.22, 0.06, WS.d + 0.12, C.mortarCap);
  K.box('timber', 0, (0.96 + we) / 2, WS.cz, WS.w, we - 0.96, WS.d, C.timber);
  for (const X of [W.x0, W.x1]) K.box('timber', X, (0.96 + we) / 2, W.z1, 0.17, we - 0.96, 0.17, C.trim);
  for (const face of ['left', 'right']) {
    onWall(K, face, W);
    for (const x of [-2.0, 2.0]) windowAt(K, x, 1.25, 1.4, 1.35, { sill: 'metal', lit: (x > 0) === (face === 'left') });
    K.pop();
  }
  onWall(K, 'back', W);
  K.box('metal', 0, 2.85, 0.1, 5.2, 0.08, 0.08, C.black);
  for (const s of [-1, 1]) {
    K.box('timber', s * 0.68, 1.4, 0.07, 1.34, 2.6, 0.06, C.door);
    K.bar('timber', [s * 0.68 - 0.55, 0.3, 0.11], [s * 0.68 + 0.55, 2.5, 0.11], 0.12, C.door);
    for (const y of [0.3, 1.4, 2.5]) K.box('timber', s * 0.68, y, 0.11, 1.3, 0.12, 0.04, C.door);
  }
  gableTri(K, 'timber', WS.w, we, (WS.w / 2) * Math.tan(0.35), C.timber);
  windowAt(K, 0, we + 0.35, 0.7, 0.6, { lit: false, sill: 'metal', cross: false });
  lanternAt(K, 2.0, 2.4);
  K.pop();
  K.push([0, 0, WS.cz], Math.PI / 2);
  gableRoof(K, { L: WS.d, D: WS.w, eaveY: we, pitch: 0.35, ovS: 0.8, ovG: 0.9, t: 0.26, snowT: 0.4, purlins: false });
  K.pop();
  return { board: { x: 0, y: 5.3, z: B.z0, w: 6.4 }, departures: { x: 0.7, y: F + 2.9, z: 10.88, w: 3.0, ry: Math.PI } };
}

// ------------------------------------------------------------------ the halt
function buildHalt(K, { plinth, apron }) {
  const B = { x0: -3.2, x1: 3.2, z0: 1.5, z1: 6.3 }, S = span(B), t = 0.22, F = FLOOR.halt, base = 0.62, eave = 3.0, pitch = 0.66, CEIL = 2.7;
  const G = { x0: -3.2, x1: 3.2, z0: 1.5 + t, z1: 6.3 - t };
  K.box('stone', 0, (F - 0.02 - plinth) / 2, S.cz, S.w + 0.16, F - 0.02 + plinth, S.d + 0.16, C.plinth);
  K.box('stone', 0, (F - plinth) / 2, (apron + B.z0) / 2, S.w + 0.7, F + plinth, B.z0 - apron, C.plinth);
  const front = [hole(1.6, 1.0, 0, 2.05), hole(-1.2, 1.28, 1.0, 2.15)], back = [hole(0, 1.08, 1.0, 2.1)], gable = [hole(0, 0.88, 1.15, 2.15)];
  for (const [face, holes, Bx] of [['front', front, B], ['back', back, B], ['left', gable, G], ['right', gable, G]]) {
    const ends = face === 'front' || face === 'back', half = ends ? S.w / 2 : (G.z1 - G.z0) / 2;
    onWall(K, face, Bx);
    holedWall(K, 'stone', C.plinth, -half - (ends ? 0.08 : 0.08 + t), half + (ends ? 0.08 : 0.08 + t), 0, base, t + 0.08, holes, 0.08);
    holedWall(K, 'stone', C.mortarCap, -half - (ends ? 0.12 : 0.08 + t), half + (ends ? 0.12 : 0.08 + t), base, base + 0.06, 0.16, holes, 0.12);
    holedWall(K, 'timber', C.timber, -half, half, base, eave, t, holes);
    lining(K, -half + (ends ? t : 0), half - (ends ? t : 0), F, CEIL, t, holes, CEIL, 0xffffff);
    K.pop();
  }
  cornerBoards(K, B, base, eave);
  onWall(K, 'front', B);
  doorAt(K, 1.6, 1.0, 2.05, { double: false, open: 'none', t });
  windowAt(K, -1.2, 1.0, 1.3, 1.15, { shutters: C.shutterRed, sill: 'metal', see: true });
  wallBench(K, -1.0, 3.6);
  lanternAt(K, 2.5, 1.75);
  K.box('metal', -2.88, 2.62, 0.3, 0.05, 0.05, 0.6, C.black);
  clockAt(K, -2.88, 2.3, 0.52, 0.24, 'x');
  K.pop();
  onWall(K, 'back', B); windowAt(K, 0, 1.0, 1.1, 1.1, { shutters: C.shutterRed, sill: 'metal', see: true }); K.pop();
  for (const face of ['left', 'right']) {
    onWall(K, face, G);
    windowAt(K, 0, 1.15, 0.9, 1.0, { shutters: C.shutterRed, sill: 'metal', see: true });
    K.pop();
    onWall(K, face, B);
    gableTri(K, 'timber', S.d, eave, (S.d / 2) * Math.tan(pitch), C.timber);
    for (let k = 0; k < 4; k++) K.box('paint', 0, eave + 0.25 + k * 0.1, 0.03, 0.5, 0.05, 0.05, C.trim); // a vent (under the ridge bracket)
    K.pop();
  }
  const ovS = 1.4;
  K.push([0, 0, S.cz]);
  const Rf = gableRoof(K, { L: S.w, D: S.d, eaveY: eave, pitch, ovS, ovG: 1.0, t: 0.24, snowT: 0.42 });
  K.pop();
  const zp = B.z0 - 0.95, yp = Rf.yBot(zp - S.cz) - 0.12;
  K.box('timber', 0, yp, zp, S.w + 2.0, 0.24, 0.18, C.trim);
  for (const x of [-3.05, -0.6, 3.05]) K.bar('timber', [x, 1.3, B.z0 + 0.02], [x, yp - 0.1, zp + 0.05], 0.13, C.trim);
  K.cyl('metal', -2.15, 4.9, 5.5, 0.09, 0.09, 2.6, 12, C.black);
  K.cyl('metal', -2.15, 6.28, 5.5, 0.0, 0.2, 0.18, 12, C.black);
  // ---- the waiting room: a board floor, panelled walls and ceiling, the stove, the bench, the timetable
  K.box('iTimber', 0, F - 0.015, S.cz, 5.96, 0.03, 4.36, 0xd8c4ae);
  K.box('iTimber', 0, CEIL + 0.03, S.cz, 5.96, 0.06, 4.36, 0xe6d6c2);
  K.box('lamp', 0.4, CEIL - 0.015, S.cz, 1.0, 0.03, 0.36);
  K.box('timber', -2.05, 1.03, 2.2, 0.05, 1.93, 0.92, C.door); // the door, swung in against the wall
  K.box('glass', -2.02, 1.45, 2.2, 0.01, 0.7, 0.6);
  hallBench(K, 0.72, 5.86, 4.1, -1, F);
  K.box('iMetal', -2.15, F + 0.38, 5.5, 0.55, 0.76, 0.55, 0x1f2124); // the stove
  K.box('lamp', -2.15, F + 0.42, 5.22, 0.26, 0.16, 0.01);
  K.cyl('iMetal', -2.15, (F + 0.76 + CEIL) / 2, 5.5, 0.08, 0.08, CEIL - F - 0.76, 10, 0x1f2124);
  onWall(K, 'front', B);
  atlasPlane(K, 'timetable', 0.4, 1.65, -t - 0.035, 0.56, 0.84, Math.PI);
  K.pop();
  onWall(K, 'right', G);
  atlasPlane(K, 'travel', 1.35, 1.65, -t - 0.035, 0.56, 0.84, Math.PI);
  K.pop();
  return { board: { x: 0, y: 2.6, z: B.z0, w: 3.2 } };
}

// ------------------------------------------------------------------ the glacier terminal
function buildGlacier(K, { plinth, board }) {
  const core = { x0: -9, x1: 9, z0: 1.2, z1: 13.4 }, CS = span(core), h1 = 4.2, eave = 8.4, t = 0.3, F = FLOOR.glacier, CEIL = 8.0;
  const SW = { x0: -9, x1: 9, z0: 1.2, z1: 13.1 }; // (the side walls: from the side blocks to the back wall)
  K.box('stone', 0, (F - 0.03 - plinth) / 2, 6.9, 18.2, F - 0.03 + plinth, 13.2, C.plinth);
  K.box('stone', 0, (F - plinth) / 2, 0.45, 2.7, F + plinth, 1.5, C.plinth); // the step from the terrace
  // the side blocks of the front, the band over the glass
  for (const s of [-1, 1]) {
    K.box('stone', s * 7.2, h1 / 2, 0.8, 3.6, h1, 0.8, C.stone);
    K.box('concrete', s * 7.2, (h1 + eave) / 2, 0.8, 3.6, eave - h1, 0.8, C.concrete);
    K.box('concrete', s * 7.2, h1 + 0.1, 0.8, 3.7, 0.24, 0.9, 0xd8d6d0);
  }
  K.box('concrete', 0, 7.9, 0.8, 10.8, 1.0, 0.8, C.concrete);
  // hollow walls: granite below, board-marked concrete above, the windows through both storeys (the hall is double height)
  const sideAt = (a, b) => [hole(a, 1.08, 1.4, 2.7), hole(b, 1.08, 1.4, 2.7), hole(a, 2.38, 5.3, 6.9), hole(b, 2.38, 5.3, 6.9)];
  const side = sideAt(-3.45, 1.15), sideR = sideAt(3.45, 0.65); // (the right one's clear of the lift core at the back)
  const back = [hole(-6.5, 2.38, 5.3, 6.9), hole(-2.5, 2.38, 5.3, 6.9), hole(-4.5, 1.08, 1.4, 2.7)];
  for (const [face, holes, Bx] of [['back', back, core], ['left', side, SW], ['right', sideR, SW]]) {
    const half = face === 'back' ? 9 : (SW.z1 - SW.z0) / 2;
    onWall(K, face, Bx);
    holedWall(K, 'stone', C.stone, -half, half, 0, h1, t, holes);
    holedWall(K, 'concrete', C.concrete, -half, half, h1, eave, t, holes);
    K.box('concrete', 0, h1 + 0.1, 0.03, 2 * half + 0.06, 0.24, 0.1, 0xd8d6d0); // the floor's edge
    lining(K, -half + (face === 'back' ? t : 0), half - (face === 'back' ? t : 0), F, CEIL, t, holes, face === 'back' ? 3.0 : F, 0xf2f2ef);
    for (const h of holes) windowAt(K, h.x, h.y0, h.w + 0.02, h.y1 - h.y0, { frame: C.frameDark, frameKey: 'metal', sill: 'metal', cross: h.w > 2, see: true });
    K.pop();
  }
  // the two-storey glass front: fixed panes either side of the doorway and over it, mullions, transoms, the doors
  // slid open behind the panes
  K.push([0, 0, core.z0], Math.PI);
  K.box('glass', -3.375, 3.82, 0.05, 4.05, 7.15, 0.03); K.box('glass', 3.375, 3.82, 0.05, 4.05, 7.15, 0.03);
  K.box('glass', 0, 5.07, 0.05, 2.7, 4.65, 0.03);
  for (let k = 0; k <= 8; k++) { const x = -5.4 + k * 1.35; if (Math.abs(x) < 1) K.box('metal', x, 5.07, 0.1, 0.09, 4.65, 0.16, C.frameDark); else K.box('metal', x, 3.82, 0.1, 0.09, 7.15, 0.16, C.frameDark); }
  for (const y of [0.25, 2.75, 5.05, 7.38]) { if (y < 1) { for (const s of [-1, 1]) K.box('metal', s * 3.375, y, 0.1, 4.05, 0.09, 0.16, C.frameDark); } else K.box('metal', 0, y, 0.1, 10.8, 0.09, 0.16, C.frameDark); }
  for (const s of [-1, 1]) {
    const cx = s * 2.0, z = -0.1;
    for (const e of [-1, 1]) K.box('metal', cx + e * 0.62, 1.5, z, 0.06, 2.45, 0.05, C.frameDark);
    K.box('metal', cx, 2.7, z, 1.3, 0.08, 0.05, C.frameDark);
    K.box('glass', cx, 1.5, z, 1.2, 2.4, 0.012);
  }
  K.pop();
  K.box('metal', 0, 3.02, 0.25, 3.4, 0.14, 1.9, C.fascia);
  K.box('snow', 0, 3.14, 0.25, 3.3, 0.1, 1.8);
  for (const x of [-0.9, 0.9]) K.box('lamp', x, 2.94, 0.0, 0.3, 0.02, 0.3);
  for (const x of [-1.6, 1.6]) K.bar('metal', [x, 2.98, -0.6], [x, 5.0, 1.2], 0.05, C.frameDark);
  K.push([0, 0, 0.4], Math.PI);
  K.cyl('metal', 0, 7.9, 0.03, 0.48, 0.48, 0.06, 32, C.black, [Math.PI / 2, 0, 0]);
  K.add('clock', new THREE.CircleGeometry(0.42, 32), { p: [0, 7.9, 0.065], uv: 'keep' });
  K.pop();
  for (const s of [-1, 1]) {
    K.push([s * 7.2, 0, 0.4], Math.PI);
    windowAt(K, 0, 1.3, 1.6, 1.6, { frame: C.frameDark, frameKey: 'metal', sill: 'metal' });
    windowAt(K, 0, 5.3, 2.2, 1.8, { frame: C.frameDark, frameKey: 'metal', sill: 'metal', lit: s > 0 });
    K.pop();
  }
  for (const face of ['left', 'right']) {
    onWall(K, face, core);
    gableTri(K, 'concrete', CS.d + 0.8, eave, ((CS.d + 0.8) / 2) * Math.tan(0.175), C.concrete, 0.3, face === 'left' ? -0.4 : 0.4); // (the roof's middle: z 6.9)
    K.pop();
  }
  K.push([0, 0, 6.9]);
  gableRoof(K, { L: 18, D: 13, eaveY: eave, pitch: 0.175, ovS: 1.0, ovG: 0.7, t: 0.45, snowT: 0.55, fasciaKey: 'metal', fascia: C.fascia, soffit: 0xb5b2ab, slabKey: 'concrete', rafters: false, purlins: false });
  K.pop();
  // the tower over the lift shaft from the rock hall
  const T = { x0: 3.4, x1: 9, z0: 9, z1: 15 }, TS = span(T), th = 13.5;
  K.box('stone', TS.cx, (h1 - plinth) / 2, 14.25, TS.w + 0.1, h1 + plinth, 1.6, C.stone);
  K.box('concrete', TS.cx, (h1 + th) / 2, TS.cz, TS.w, th - h1, TS.d, C.concrete);
  K.box('concrete', 6.05, h1 / 2, 11.05, 5.3, h1, 4.1, C.concrete); // (its foot in the hall: the lift core)
  for (const [x, z, w, d] of [[TS.cx, T.z0 + 0.12, TS.w + 0.1, 0.25], [TS.cx, T.z1 - 0.12, TS.w + 0.1, 0.25], [T.x0 + 0.12, TS.cz, 0.25, TS.d], [T.x1 - 0.12, TS.cz, 0.25, TS.d]]) {
    K.box('concrete', x, th + 0.25, z, w, 0.5, d, 0xd8d6d0);
    K.box('snow', x, th + 0.55, z, w + 0.02, 0.1, d + 0.04);
  }
  K.box('snow', TS.cx, th + 0.2, TS.cz, TS.w - 0.4, 0.4, TS.d - 0.4);
  for (const face of ['right', 'back', 'left']) {
    onWall(K, face, T);
    for (const x of face === 'left' ? [-1.6] : [-1.2, 1.2]) windowAt(K, x, 10.6, 0.5, 2.2, { frame: C.frameDark, frameKey: 'metal', sill: 'metal', cross: false, lit: face !== 'back' });
    K.pop();
  }
  const mx = 7.8, mz = 13.8, my = th + 0.3, mh = 4.8;
  for (const [dx, dz] of [[-0.25, -0.25], [0.25, -0.25], [0.25, 0.25], [-0.25, 0.25]]) K.bar('metal', [mx + dx, my, mz + dz], [mx + dx * 0.35, my + mh, mz + dz * 0.35], 0.05, C.galv);
  for (let k = 1; k < 6; k++) { const f = 1 - 0.65 * (k / 6); K.box('metal', mx, my + (k * mh) / 6, mz, 0.5 * f + 0.05, 0.035, 0.5 * f + 0.05, C.galv); }
  K.cyl('metal', mx, my + mh + 0.35, mz, 0.025, 0.025, 0.7, 6, C.black);
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2;
    K.bar('metal', [mx, my + mh + 0.62, mz], [mx + Math.cos(a) * 0.3, my + mh + 0.62, mz + Math.sin(a) * 0.3], 0.02, C.black);
    K.add('metal', new THREE.SphereGeometry(0.06, 8, 6), { p: [mx + Math.cos(a) * 0.3, my + mh + 0.62, mz + Math.sin(a) * 0.3], c: C.galv });
  }
  K.box('metal', mx, my + mh + 0.12, mz + 0.35, 0.04, 0.12, 0.6, C.black);
  // ---- the hall: polished stone, white walls (a timber wall at the back), light strips, benches, the kiosk, the lifts
  K.box('iFloor', 0, F - 0.015, 7.15, 17.4, 0.03, 11.9, 0xc8c8cc);
  K.box('iFloor', 0, F - 0.015, 0.45, 2.7, 0.03, 1.5, 0xc8c8cc);
  K.box('iPlaster', 0, CEIL + 0.05, 7.15, 17.4, 0.1, 11.9, 0xf4f4f2);
  for (let z = 2.4; z < 12.6; z += 2.1) K.box('lamp', -1.7, CEIL - 0.02, z, 13.6, 0.04, 0.12);
  for (const [x, z] of [[-4.5, 6.0], [-4.5, 9.0], [0.8, 6.0]]) hallBench(K, x, z, 3.2, -1, F, false);
  // the lifts' doors in the core, the sign and the departures screen over them
  for (const x of [4.75, 7.35]) {
    K.box('iMetal', x, F + 1.1, 8.98, 1.15, 2.2, 0.04, 0xc9ccd0);
    K.box('iMetal', x, F + 1.1, 8.97, 0.02, 2.2, 0.03, 0x50555a);
    K.box('iPaint', x, F + 2.3, 8.98, 1.35, 0.2, 0.05, 0x2b2f34);
  }
  atlasPlane(K, 'trains', 6.05, F + 2.85, 8.94, 2.4, 0.6, Math.PI);
  // the kiosk: a counter, shelves of goods behind it, its lit sign
  K.box('iTimber', -6.9, F + 0.55, 10.9, 3.6, 1.1, 0.8, C.door);
  K.box('iMetal', -6.9, F + 1.12, 10.9, 3.7, 0.04, 0.9, 0x2b2f34);
  K.box('iTimber', -6.9, F + 1.1, 12.8, 3.6, 2.2, 0.6, C.trim);
  for (let r = 0; r < 4; r++) for (let k = 0; k < 10; k++) K.box('iPaint', -8.5 + k * 0.35, F + 0.45 + r * 0.5, 12.45, 0.24, 0.3, 0.16, [0xd0202a, 0xf2c200, 0x1b6fd1, 0xffffff, 0x2fae5a][(k + r) % 5]);
  atlasPlane(K, 'kiosk', -6.9, F + 2.75, 12.76, 2.4, 0.6, Math.PI);
  K.box('lamp', -6.9, F + 2.35, 11.4, 3.4, 0.03, 0.3);
  // a screen on its stand by the entrance
  K.box('iMetal', 2.3, F + 0.6, 3.0, 0.12, 1.2, 0.12, 0x2b2f34);
  K.box('iMetal', 2.3, F + 0.02, 3.0, 0.6, 0.04, 0.6, 0x2b2f34);
  K.box('iMetal', 2.3, F + 1.75, 3.0, 1.7, 1.0, 0.08, 0x1d2023);
  return {
    board: { x: TS.cx, y: 11.9, z: T.z0, w: 4.0 },
    departures: { x: 6.05, y: F + 3.7, z: 8.95, w: 3.2, ry: Math.PI },
    screen: { x: 2.3, y: F + 1.75, z: 2.955, w: 1.6, ry: Math.PI },
  };
}

// ------------------------------------------------------------------ public
const CACHE = new Map();
const NO_SHADOW = new Set(['glass', 'glassDark', 'glassLit', 'lamp', 'clock', 'iFloor', 'iPoster', 'iPlaster', 'iTimber', 'iPaint', 'iMetal']);
function meshesFrom(parts, M) {
  const grp = new THREE.Group();
  for (const [key, g] of parts) {
    const m = new THREE.Mesh(g, M[key]);
    m.castShadow = !NO_SHADOW.has(key); m.receiveShadow = true;
    if (key === 'glass') m.renderOrder = 1; // (the clear panes after the rooms behind them)
    grp.add(m);
  }
  return grp;
}
/**
 * A station building (kind 'valley' | 'halt' | 'glacier'), its local frame as above (front line z = 0, base y = 0).
 * plinth: how far its stone plinth reaches down into the ground; apron: where the paving in front of its doors begins
 * (local z, toward the platform's back edge); departures: { title, rows: [[destination, note, interval]] } for the
 * departures board / screens inside. userData: kind, size, board { x, y, z, w } (where the name board hangs on its
 * front: the centre on the wall's face, its width; it faces -z), plan (stationPlan: colliders and floors).
 * Its meshes are left out of world/solidify.js (userData.noSolid / noCollide): registerStation sets its colliders.
 */
export function stationBuilding(kind, { plinth = 5, apron = -1.2, departures = null } = {}) {
  const M = stationMaterials(), key = `${kind}:${plinth}:${apron}`;
  if (!CACHE.has(key)) {
    const K = new Kit(), o = { plinth, apron };
    const info = kind === 'valley' ? buildValley(K, o) : kind === 'halt' ? buildHalt(K, o) : buildGlacier(K, o);
    CACHE.set(key, { parts: K.build(), info });
  }
  const { parts, info } = CACHE.get(key);
  const grp = meshesFrom(parts, M);
  if (departures) {
    const mat = boardTexture(departures.title, departures.rows);
    for (const a of [info.departures, info.screen]) {
      if (!a || !mat) continue;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(a.w, a.w / 4), mat);
      m.position.set(a.x, a.y, a.z); m.rotation.y = a.ry;
      grp.add(m);
    }
  }
  grp.name = `station-${kind}`;
  grp.userData = { kind, size: STATION_SIZE[kind], board: info.board, plan: stationPlan(kind, { apron }), noSolid: true, noCollide: true };
  return grp;
}

/**
 * Register a station building's colliders and walkable floors where it stands: origin (its base's world position),
 * az (unit vector of its local z, away from the track; its x = (az.z, -az.x)), zOff (its local z offset from the origin).
 * The floors only if the ground inside lies under them (the terrain never shows through, you never walk into the
 * hillside); otherwise its closed footprint. Returns true when it is walk-in.
 */
export function registerStation(plan, origin, az, colliders, { zOff = 0 } = {}) {
  const axx = az.z, axz = -az.x, rot = -Math.atan2(az.x, az.z);
  const W = (lx, lz) => ({ x: origin.x + axx * lx + az.x * (lz + zOff), z: origin.z + axz * lx + az.z * (lz + zOff) });
  const fy = origin.y + plan.floorY;
  let ok = true;
  for (const f of plan.floors.slice(0, 1)) {
    for (let lx = f.x0 + 0.3; lx <= f.x1 - 0.3 && ok; lx += 1.5) for (let lz = f.z0 + 0.3; lz <= f.z1 - 0.3 && ok; lz += 1.5) {
      const p = W(lx, lz);
      if (world.meshHeight(p.x, p.z) > fy - 0.04) ok = false;
    }
  }
  const push = (r) => { const c = W(r.cx, r.cz); colliders.push({ x: c.x, z: c.z, hw: r.hx, hd: r.hz, rot, ...(r.top !== undefined ? { top: origin.y + r.top } : {}) }); };
  if (!ok) { for (const r of plan.outer) push(r); console.info('station building closed (the ground inside is over its floor)'); return false; }
  for (const r of plan.colliders) push(r);
  let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
  for (const f of plan.floors) for (const [lx, lz] of [[f.x0, f.z0], [f.x1, f.z0], [f.x0, f.z1], [f.x1, f.z1]]) { const p = W(lx, lz); minx = Math.min(minx, p.x); maxx = Math.max(maxx, p.x); minz = Math.min(minz, p.z); maxz = Math.max(maxz, p.z); }
  world.addSurface({
    bounds: { minx, maxx, minz, maxz },
    height(x, z) {
      const dx = x - origin.x, dz = z - origin.z, lx = dx * axx + dz * axz, lz = dx * az.x + dz * az.z - zOff;
      for (const f of plan.floors) if (lx >= f.x0 && lx <= f.x1 && lz >= f.z0 && lz <= f.z1) return fy;
      return null;
    },
  });
  return true;
}

/**
 * The platform canopy: steel columns every 6 m (x = -len/2 .. len/2, z = width - 0.3), glulam cantilevers with knee
 * braces to the front edge, purlins, a boarded soffit under a snow-covered roof sloping back to its gutter, pendant
 * lamps, the hanging station clock. Local frame: x along the track, z away from it, the front edge at z = 0, y up from
 * the columns' feet.
 */
export function stationCanopy(len, width) {
  const M = stationMaterials(), key = `canopy:${len}:${width}`;
  if (!CACHE.has(key)) {
    const K = new Kit();
    const zp = width - 0.3, z1 = width + 0.4, yF = 3.62, yB = 3.36, sl = Math.atan2(yF - yB, z1);
    const yAt = (z) => yF + ((yB - yF) * z) / z1, t = 0.14, X = len / 2 + 0.35;
    const posts = [];
    for (let x = -len / 2; x <= len / 2 + 0.01; x += 6) posts.push(x);
    for (const x of posts) {
      const top = yAt(zp) - 0.32;
      K.box('metal', x, (top - 0.7) / 2, zp, 0.2, top + 0.7, 0.2, C.metal); // (down into the ground wherever it is lower)
      K.box('metal', x, top - 0.04, zp, 0.3, 0.08, 0.3, C.metal);
      const zm = (zp + 0.3) / 2, bl = Math.hypot(zp + 0.3, yAt(0) - yAt(zp + 0.3));
      K.box('timber', x, yAt(zm) - 0.16, zm, 0.16, 0.32, bl, C.trim, [sl, 0, 0]);
      K.bar('timber', [x, top - 1.25, zp - 0.08], [x, yAt(zp - 1.5) - 0.3, zp - 1.5], 0.12, C.trim);
    }
    for (const z of [0.3, width * 0.5, zp]) K.box('timber', 0, yAt(z) - 0.08, z, 2 * X - 0.1, 0.16, 0.13, C.trim);
    K.box('timber', 0, (yF + yB) / 2 + t / 2, z1 / 2, 2 * X, t, Math.hypot(z1, yF - yB), C.soffit, [sl, 0, 0]);
    K.box('timber', 0, yF + 0.04, -0.03, 2 * X + 0.06, 0.3, 0.06, C.trim);
    for (const sx of [-1, 1]) K.box('timber', sx * (X + 0.03), (yF + yB) / 2 + 0.06, z1 / 2, 0.06, 0.28, z1 + 0.05, C.trim, [sl, 0, 0]);
    K.cyl('metal', 0, yB - 0.02, z1 + 0.1, 0.075, 0.075, 2 * X, 10, C.galv, [0, 0, Math.PI / 2]);
    for (const x of [posts[0], posts[posts.length - 1]]) K.cyl('metal', x + 0.18, (yB - 0.75) / 2, z1 + 0.1, 0.05, 0.05, yB + 0.65, 8, C.galv);
    snowCap(K, [[0, yF + t / Math.cos(sl)], [z1, yB + t / Math.cos(sl)]], -X - 0.05, X + 0.05, 0.32);
    const lz = width * 0.62;
    for (let x = -len / 2 + 3; x < len / 2; x += 6) {
      const y = yAt(lz);
      K.cyl('metal', x, y - 0.2, lz, 0.012, 0.012, 0.4, 6, C.black);
      K.cyl('metal', x, y - 0.46, lz, 0.07, 0.24, 0.16, 16, C.metal);
      K.cyl('lamp', x, y - 0.55, lz, 0.2, 0.2, 0.02, 16);
    }
    const cz = width * 0.3, cy = yAt(cz);
    K.box('metal', 0, cy - 0.25, cz, 0.05, 0.5, 0.05, C.black);
    clockAt(K, 0, cy - 0.95, cz, 0.38, 'x');
    CACHE.set(key, { parts: K.build() });
  }
  const grp = meshesFrom(CACHE.get(key).parts, M);
  grp.name = 'station-canopy';
  return grp;
}
