// Sponsor banners for every safety net (race courses and the resort's piste nets). One shared canvas
// atlas: 2 columns x 16 rows of 1024x128 banners. Brand logos are PNGs in public/sponsors/ (rasterised
// from assets-src/sponsors by tools/build-sponsor-logos.mjs) drawn on the brand's colours, repeated
// along the banner like broadcast ad boards; beatandraise.com and iceyclient get drawn marks; the
// game's own house banners use the race font.
import * as THREE from 'three';

const BLUE = '#1546c8', RED = '#e2231a';
const RACE = '"Barlow Condensed", "Arial Narrow", "Helvetica Neue", Arial, sans-serif';
const SANS = '"Avenir Next", "Helvetica Neue", Arial, sans-serif';

// logo: public/sponsors/<logo>.png; tint: recolour the logo; n: logos along the banner;
// h: logo height in px (of 128); weight: how often it is picked
export const BANNERS = [
  { id: 'beatandraise', bg: '#0c1730', draw: drawBeatAndRaise, weight: 4 },
  { id: 'iceyclient', bg: '#05080f', draw: drawIceyClient, weight: 4 },
  { id: 'nike', logo: 'nike', bg: '#111111', tint: '#ffffff', n: 3, h: 70, weight: 2 },
  { id: 'adidas', logo: 'adidas', bg: '#ffffff', n: 3, h: 92, weight: 2 },
  { id: 'puma', logo: 'puma', bg: '#111111', tint: '#ffffff', n: 2, h: 74, weight: 2 },
  { id: 'redbull', logo: 'redbull', bg: '#0f1e4a', n: 2, h: 74, weight: 1.5 },
  { id: 'rolex', logo: 'rolex', bg: '#006039', tint: '#d6b25e', n: 2, h: 70, weight: 1.2 },
  { id: 'audi', logo: 'audi', bg: '#0b0b0b', tint: '#ffffff', n: 2, h: 76, weight: 1 },
  { id: 'oakley', logo: 'oakley', bg: '#111111', tint: '#ffffff', n: 2, h: 84, weight: 1 },
  { id: 'salomon', logo: 'salomon', bg: '#ffffff', n: 2, h: 56, weight: 1.2 },
  { id: 'rossignol', logo: 'rossignol', bg: '#ffffff', n: 2, h: 96, weight: 1.2 },
  { id: 'fischer', logo: 'fischer', bg: '#111111', n: 4, h: 100, weight: 1 },
  { id: 'tnf', logo: 'tnf', bg: '#d81e05', tint: '#ffffff', n: 3, h: 92, weight: 1 },
  { id: 'gopro', logo: 'gopro', bg: '#000000', n: 2, h: 92, weight: 1 },
  { id: 'cocacola', logo: 'cocacola', bg: '#e41e2b', tint: '#ffffff', n: 2, h: 96, weight: 1.2 },
  { id: 'milka', logo: 'milka', bg: '#7b5ea7', n: 3, h: 104, weight: 1 },
  { id: 'swatch', logo: 'swatch', bg: '#ffffff', n: 2, h: 66, weight: 1 },
  { id: 'samsung', logo: 'samsung', bg: '#ffffff', n: 2, h: 84, weight: 1 },
  { id: 'toyota', logo: 'toyota', bg: '#ffffff', n: 2, h: 64, weight: 1 },
  { id: 'visa', logo: 'visa', bg: '#ffffff', n: 3, h: 70, stripe: '#f7b600', weight: 1 },
  { id: 'bmw', logo: 'bmw', bg: '#e9edf2', n: 5, h: 100, weight: 1 },
  // house banners (race font)
  { id: 'skilegacy', text: 'SKI LEGACY', bg: '#ffffff', fg: BLUE, st: BLUE, st2: RED, house: true, weight: 1.5 },
  { id: 'worldracing', text: 'WORLD RACING', bg: BLUE, fg: '#ffffff', st: '#ffffff', st2: RED, house: true, weight: 1 },
  { id: 'alpine', text: 'LEGACY WORLD DOWNHILL', bg: '#ffffff', fg: BLUE, st: BLUE, st2: RED, house: 'alpine' },
  { id: 'icecanyon', text: 'ICE CANYON', bg: '#ffffff', fg: BLUE, st: BLUE, st2: RED, house: 'icecanyon' },
  { id: 'bigair', text: 'BIG AIR LINE', bg: RED, fg: '#ffffff', st: '#ffffff', st2: BLUE, house: 'bigair' },
  { id: 'meadow', text: 'SUNNY MEADOW', bg: '#ffffff', fg: BLUE, st: BLUE, st2: RED, house: 'meadow' },
  { id: 'floodlight', text: 'FLOODLIGHT SLALOM', bg: BLUE, fg: '#ffffff', st: '#ffffff', st2: RED, house: 'floodlight' },
  { id: 'forestgs', text: 'BLACK FOREST GS', bg: '#ffffff', fg: BLUE, st: BLUE, st2: RED, house: 'forestgs' },
  { id: 'glaciersg', text: 'GLACIER SUPER-G', bg: '#ffffff', fg: BLUE, st: BLUE, st2: RED, house: 'glaciersg' },
  { id: 'eaglepeak', text: 'EAGLE PEAK DOWNHILL', bg: RED, fg: '#ffffff', st: '#ffffff', st2: BLUE, house: 'eaglepeak' },
  { id: 'village', text: 'LEGACY VILLAGE', bg: BLUE, fg: '#ffffff', st: '#ffffff', st2: RED, house: 'resort' },
];

const COLS = 2, ROWS = 16, CW = 1024, CH = 128;

// ---- drawn marks for the sponsors without a public logo file
function drawBeatAndRaise(g, x, y) {
  const cy = y + CH / 2;
  g.font = `800 62px ${SANS}`;
  const tw = g.measureText('beatandraise').width, dw = g.measureText('.com').width;
  const icon = 72, gap = 22, w = icon + gap + tw + dw, x0 = x + (CW - w) / 2;
  // mark: three rising bars with an arrow breaking out above them
  g.fillStyle = '#2fd27a';
  [[0, 0.38], [1, 0.6], [2, 0.84]].forEach(([k, f]) => g.fillRect(x0 + k * 24, cy + 30 - 60 * f, 16, 60 * f));
  g.strokeStyle = '#ffffff'; g.lineWidth = 7; g.lineCap = 'round'; g.lineJoin = 'round';
  g.beginPath(); g.moveTo(x0 - 4, cy + 14); g.lineTo(x0 + 30, cy - 6); g.lineTo(x0 + 46, cy + 4); g.lineTo(x0 + icon, cy - 28); g.stroke();
  g.beginPath(); g.moveTo(x0 + icon - 22, cy - 30); g.lineTo(x0 + icon + 2, cy - 30); g.lineTo(x0 + icon + 2, cy - 6); g.stroke();
  g.textBaseline = 'middle'; g.textAlign = 'left';
  g.fillStyle = '#ffffff'; g.fillText('beatandraise', x0 + icon + gap, cy + 3);
  g.fillStyle = '#2fd27a'; g.fillText('.com', x0 + icon + gap + tw, cy + 3);
}

function drawIceyClient(g, x, y) {
  for (let k = 0; k < 2; k++) {
    const cx = x + CW * (k + 0.5) / 2, cy = y + CH / 2;
    g.font = `800 60px ${SANS}`;
    const w1 = g.measureText('icey').width, w2 = g.measureText('client').width;
    const icon = 60, gap = 16, w = icon + gap + w1 + w2, x0 = cx - w / 2;
    // mark: an ice crystal
    const ix = x0 + icon / 2;
    g.strokeStyle = '#7fe3ff'; g.lineWidth = 6; g.lineCap = 'round';
    for (let a = 0; a < 6; a++) {
      const ang = (a * Math.PI) / 3, dx = Math.sin(ang), dy = -Math.cos(ang);
      g.beginPath(); g.moveTo(ix, cy); g.lineTo(ix + dx * 28, cy + dy * 28); g.stroke();
      const bx = ix + dx * 17, by = cy + dy * 17;
      for (const s of [-1, 1]) {
        const a2 = ang + s * 0.75;
        g.beginPath(); g.moveTo(bx, by); g.lineTo(bx + Math.sin(a2) * 10, by - Math.cos(a2) * 10); g.stroke();
      }
    }
    g.textBaseline = 'middle'; g.textAlign = 'left';
    g.fillStyle = '#ffffff'; g.fillText('icey', x0 + icon + gap, cy + 2);
    g.fillStyle = '#7fe3ff'; g.fillText('client', x0 + icon + gap + w1, cy + 2);
  }
}

// ---- logo images (loaded once; the atlas is redrawn when they arrive)
const logos = new Map();
function loadLogos(onAll) {
  const ids = [...new Set(BANNERS.filter((b) => b.logo).map((b) => b.logo))];
  let left = ids.length;
  for (const id of ids) {
    const img = new Image();
    const done = () => { if (--left === 0) onAll(); };
    img.onload = () => { logos.set(id, img); done(); };
    img.onerror = done;
    img.src = `sponsors/${id}.png`;
  }
}

const tintCache = new Map();
function tinted(img, color) {
  const k = img.src + color;
  if (tintCache.has(k)) return tintCache.get(k);
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = color; g.fillRect(0, 0, c.width, c.height);
  tintCache.set(k, c);
  return c;
}

function drawBanner(g, x, y, b) {
  g.save();
  g.beginPath(); g.rect(x, y, CW, CH); g.clip();
  g.fillStyle = b.bg; g.fillRect(x, y, CW, CH);
  if (b.st) { g.fillStyle = b.st; g.fillRect(x, y, CW, 7); g.fillRect(x, y + CH - 7, CW, 7); }
  if (b.st2) { g.fillStyle = b.st2; g.fillRect(x, y + 7, CW, 3); g.fillRect(x, y + CH - 10, CW, 3); }
  if (b.stripe) { g.fillStyle = b.stripe; g.fillRect(x, y + CH - 12, CW, 12); }
  if (b.draw) b.draw(g, x, y);
  else if (b.logo) {
    const img = logos.get(b.logo);
    if (img) {
      const src = b.tint ? tinted(img, b.tint) : img;
      const n = b.n || 2, slot = CW / n;
      let h = b.h || 80, w = (img.naturalWidth / img.naturalHeight) * h;
      if (w > slot * 0.8) { w = slot * 0.8; h = (w * img.naturalHeight) / img.naturalWidth; }
      for (let k = 0; k < n; k++) g.drawImage(src, x + slot * (k + 0.5) - w / 2, y + (CH - (b.stripe ? 12 : 0) - h) / 2, w, h);
    }
  } else if (b.text) {
    let s = 86;
    g.font = `italic 700 ${s}px ${RACE}`;
    while (g.measureText(b.text).width > CW * 0.86 && s > 24) { s -= 4; g.font = `italic 700 ${s}px ${RACE}`; }
    g.fillStyle = b.fg; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(b.text, x + CW / 2, y + CH / 2 + 3);
  }
  g.restore();
}

let atlas = null;
/** The shared banner texture (null without a DOM). */
export function sponsorAtlas() {
  if (atlas) return atlas;
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = CW * COLS; c.height = CH * ROWS;
  const g = c.getContext('2d');
  const draw = () => { BANNERS.forEach((b, i) => drawBanner(g, (i % COLS) * CW, Math.floor(i / COLS) * CH, b)); if (atlas) atlas.needsUpdate = true; };
  draw();
  atlas = new THREE.CanvasTexture(c);
  atlas.colorSpace = THREE.SRGBColorSpace;
  atlas.anisotropy = 8;
  loadLogos(draw);
  // the race font may still be loading: redraw once it's ready
  try { document.fonts?.load(`italic 700 40px ${RACE}`).then(draw).catch(() => {}); } catch { /* no font API */ }
  return atlas;
}

/** UV rectangle of banner `i` (inset a little so mipmaps don't bleed between neighbours). */
export function bannerUV(i) {
  const col = i % COLS, row = Math.floor(i / COLS);
  const u0 = col / COLS + 0.002, u1 = (col + 1) / COLS - 0.002;
  const v1 = 1 - row / ROWS - 0.003, v0 = 1 - (row + 1) / ROWS + 0.003;
  return { u0, u1, v0, v1 };
}

/** A weighted random banner for a course id ('alpine' ...) or 'resort': sponsors, the game's own
 *  banners and the venue's own banner. */
export function pickBanner(venue, rnd) {
  let total = 0;
  const w = BANNERS.map((b) => {
    const v = b.house && b.house !== true ? (b.house === venue ? 2.5 : 0) : b.weight ?? 1;
    total += v;
    return v;
  });
  let r = rnd() * total;
  for (let i = 0; i < w.length; i++) { r -= w[i]; if (r <= 0) return i; }
  return 0;
}
