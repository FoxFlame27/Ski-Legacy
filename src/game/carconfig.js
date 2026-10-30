// CAR CONFIGURATOR data and looks (the AUTOHAUS showroom's designer, ui/carrental.js): paint colours in four finishes
// (solid gloss, metallic, pearl, matte), interior trims (leathers, sport fabrics with a coloured check / stitching),
// rim colours and the number plate (Swiss style: canton letters, your own text, the shields; a canvas texture on a
// plate of its own, laid over each car's front and rear plate). dressCar() turns a car instance (cars.js
// carInstance, wheels: true) into exactly that car: the showroom's live preview, the car you bought, in your bay, and the
// car you drive (drive.js: e.dress), outside and in the cockpit (the *_full models too).
import * as THREE from 'three';
import { isPaint, isPlateMat } from './cars.js';

// paint: hex (sRGB), finish -> how the clear coat and flakes read (roughness, metalness), extra cost
export const FINISH = {
  solid: { label: 'Solid', rough: 0.3, metal: 0.25, clear: 1, cost: 0 },
  metallic: { label: 'Metallic', rough: 0.24, metal: 0.72, clear: 1, cost: 1500 },
  pearl: { label: 'Pearl', rough: 0.18, metal: 0.5, clear: 1, cost: 2500 },
  matte: { label: 'Matte', rough: 0.66, metal: 0.12, clear: 0, cost: 3500 },
};
export const PAINTS = [
  { id: 'white', label: 'Alpine White', hex: 0xf2f2f0, finish: 'solid' }, { id: 'black', label: 'Night Black', hex: 0x15171a, finish: 'solid' },
  { id: 'red', label: 'Tornado Red', hex: 0xa8161c, finish: 'solid' }, { id: 'yellow', label: 'Racing Yellow', hex: 0xe2b81c, finish: 'solid' },
  { id: 'orange', label: 'Arizona Orange', hex: 0xd0611c, finish: 'solid' }, { id: 'kingfisher', label: 'Kingfisher Blue', hex: 0x1f68ad, finish: 'solid' },
  { id: 'lime', label: 'Lime Green', hex: 0x78ad2a, finish: 'solid' },
  { id: 'silver', label: 'Glacier Silver', hex: 0xb2b7bd, finish: 'metallic' }, { id: 'graphite', label: 'Graphite Grey', hex: 0x464a50, finish: 'metallic' },
  { id: 'blue', label: 'Midnight Blue', hex: 0x1d2b50, finish: 'metallic' }, { id: 'green', label: 'Forest Green', hex: 0x2a4636, finish: 'metallic' },
  { id: 'burgundy', label: 'Burgundy', hex: 0x5e1622, finish: 'metallic' }, { id: 'bronze', label: 'Bronze', hex: 0x8a5a2e, finish: 'metallic' },
  { id: 'ice', label: 'Ice Blue', hex: 0x8fb1c8, finish: 'metallic' },
  { id: 'pearlwhite', label: 'Pearl White', hex: 0xefebe2, finish: 'pearl' }, { id: 'violet', label: 'Velvet Violet', hex: 0x4a2a5e, finish: 'pearl' },
  { id: 'mblack', label: 'Matte Black', hex: 0x1c1d1f, finish: 'matte' }, { id: 'mgrey', label: 'Matte Nardo Grey', hex: 0x6a6d70, finish: 'matte' },
  { id: 'army', label: 'Matte Army Green', hex: 0x4a5238, finish: 'matte' }, { id: 'sand', label: 'Matte Desert Sand', hex: 0xb49a72, finish: 'matte' },
];
// interiors: the trim colour the seats (and door cards) are recoloured to (their texture's shading kept), the
// pattern (1: sport fabric, a fine check of coloured threads: the "stitching"), its accent, cost
export const INTERIORS = [
  { id: 'orig', label: 'Factory trim', sub: 'As it left the factory', hex: 0x000000, amt: 0, cost: 0 },
  { id: 'black', label: 'Black leather', sub: 'Nappa, black', hex: 0x1a1a1c, amt: 1, cost: 0 },
  { id: 'tan', label: 'Cognac leather', sub: 'Tan nappa, a warm brown', hex: 0x9a5a2c, amt: 1, cost: 2000 },
  { id: 'oxblood', label: 'Oxblood leather', sub: 'Deep red nappa', hex: 0x6e1a1e, amt: 1, cost: 2500 },
  { id: 'ivory', label: 'Ivory leather', sub: 'Pale cream nappa', hex: 0xd8cdb6, amt: 1, cost: 2500 },
  { id: 'sportred', label: 'Sport fabric · red check', sub: 'Charcoal cloth, red stitching', hex: 0x2c2d31, amt: 1, pattern: 1, accent: 0xc0161c, cost: 1500 },
  { id: 'sportblue', label: 'Sport fabric · blue check', sub: 'Charcoal cloth, blue stitching', hex: 0x2c2d31, amt: 1, pattern: 1, accent: 0x1f6fd0, cost: 1500 },
  { id: 'alcantara', label: 'Alcantara · yellow stitch', sub: 'Grey suede, yellow stitching', hex: 0x55575b, amt: 1, pattern: 2, accent: 0xe8c21a, cost: 2000 },
];
// rims: a tint over the wheel's metal (tyres stay black)
export const RIMS = [
  { id: 'orig', label: 'Factory alloys', hex: 0xffffff, cost: 0 }, { id: 'black', label: 'Gloss black', hex: 0x1b1c1e, cost: 1000 },
  { id: 'gunmetal', label: 'Gunmetal', hex: 0x5a5e64, cost: 1000 }, { id: 'bronze', label: 'Bronze', hex: 0x9a6a36, cost: 1500 },
  { id: 'gold', label: 'Gold', hex: 0xd0a650, cost: 1500 }, { id: 'red', label: 'Red', hex: 0xa01a1e, cost: 1500 },
];
export const PLATE_COST = 1000; // your own text on the plates (AUTOHAUS prices, Oct 29: every extra x10, the cars are bought now)
const CANTONS = ['VS', 'GR', 'BE', 'UR', 'OW', 'TI', 'ZH', 'LU'];

/** A plate in the game's style: two canton letters and up to six digits ("VS 123456"). */
export function randomPlate(rnd = Math.random) { return `${CANTONS[Math.floor(rnd() * CANTONS.length)]} ${Math.floor(1000 + rnd() * 899000)}`; }
/** What you may type on a plate: 1-8 letters / digits (spaces and hyphens between). */
export const cleanPlate = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9 \-]/g, '').replace(/\s+/g, ' ').replace(/^[ -]+/, '').slice(0, 8);
export const plateOk = (s) => /[A-Z0-9]/.test(s) && cleanPlate(s).replace(/[ -]/g, '').length >= 1 && s.length <= 8;

export const paintOf = (id) => PAINTS.find((p) => p.id === id) || PAINTS[0];
export const interiorOf = (id) => INTERIORS.find((p) => p.id === id) || INTERIORS[0];
export const rimOf = (id) => RIMS.find((p) => p.id === id) || RIMS[0];
/** A config made whole (old saves: { id, paint } only). */
export function normConfig(c = {}) {
  return { id: c.id, paint: paintOf(c.paint).id, interior: interiorOf(c.interior).id, rims: rimOf(c.rims).id, plate: cleanPlate(c.plate) || randomPlate(), custom: !!c.custom, ...(Number.isFinite(c.price) ? { price: c.price } : {}) }; // (price: what you paid, an owned car's)
}
/** Extra cost of a config over the car's list price (finish, trim, rims, a custom plate). */
export function extrasCost(c) { return FINISH[paintOf(c.paint).finish].cost + interiorOf(c.interior).cost + rimOf(c.rims).cost + (c.custom ? PLATE_COST : 0); }

// ---------------------------------------------------------------- the plate texture (cached per text)
const plateTex = new Map();
export function plateTexture(text) {
  if (plateTex.has(text)) return plateTex.get(text);
  const W = 1024, H = 220, c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  // white reflective plate, a thin black rim
  g.fillStyle = '#f7f7f4'; g.beginPath(); g.roundRect(4, 4, W - 8, H - 8, 22); g.fill();
  g.lineWidth = 7; g.strokeStyle = '#111'; g.beginPath(); g.roundRect(14, 14, W - 28, H - 28, 16); g.stroke();
  // the shields: the Swiss cross (left), the canton's (right; red / white halves)
  const shield = (x, fillA, fillB, cross) => {
    g.save(); g.translate(x, H / 2); g.beginPath(); g.moveTo(-34, -46); g.lineTo(34, -46); g.lineTo(34, 8); g.quadraticCurveTo(34, 40, 0, 52); g.quadraticCurveTo(-34, 40, -34, 8); g.closePath();
    g.fillStyle = fillA; g.fill(); if (fillB) { g.save(); g.clip(); g.fillStyle = fillB; g.fillRect(0, -50, 40, 110); g.restore(); }
    g.lineWidth = 3; g.strokeStyle = '#222'; g.stroke();
    if (cross) { g.fillStyle = '#fff'; g.fillRect(-7, -26, 14, 48); g.fillRect(-22, -9, 44, 14); }
    g.restore();
  };
  shield(70, '#d52b1e', null, true);
  shield(W - 70, '#d52b1e', '#f4f4f4', false);
  // the text: black, condensed, as wide as it fits
  g.fillStyle = '#121212'; g.textAlign = 'center'; g.textBaseline = 'middle';
  let size = 170;
  g.font = `700 ${size}px "Barlow Condensed", "Arial Narrow", Arial, sans-serif`;
  const room = W - 260, w = g.measureText(text).width;
  if (w > room) { size = Math.floor(size * room / w); g.font = `700 ${size}px "Barlow Condensed", "Arial Narrow", Arial, sans-serif`; }
  if ('letterSpacing' in g) g.letterSpacing = '6px';
  g.fillText(text, W / 2, H / 2 + 8);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 16;
  plateTex.set(text, t);
  if (plateTex.size > 40) { const k = plateTex.keys().next().value; if (k !== text) { plateTex.get(k).dispose(); plateTex.delete(k); } }
  return t;
}

// ---------------------------------------------------------------- where the plates go (per template, once)
// Each model's plate spot, measured from its own geometry (fitted frame: m, wheels on y = 0, nose toward +z), front
// and rear: y = the plate's centre height, tilt = how far its face leans back (deg; the face looks that much up), and
// where the face has nothing behind it to find, its z. The models' own plates are gone from the templates (cars.js
// PLATE_PIECES / isPlateMat): ours goes where they were, centred in the recess / holder they sat in (its outline
// measured from rays straight in: the lips and walls round it), or where the real car carries it. The depth is found
// by rays over the plate's whole face: flush on the frontmost point (nothing pokes through), 2 mm proud.
//  BMW X3     front: the holder in the bumper (0.48-0.60; its own plate was there: Nomera). rear: the recess in the
//             tailgate under the roundel (0.86-1.05, leaning back 15 deg; its own plate: Plane006, dropped as junk)
//  Audi RS6   front: the bar of bumper under the grille (0.43-0.53, 8 deg). rear: the tailgate's recess (0.71-0.89, 14 deg;
//             its own US plate was in it)
//  Golf GTI   front: on the holder standing proud of the bumper (its rim: 0.434-0.55, z 2.15; a dealer plate in it;
//             the recess behind it is too small for a plate). rear: the recess under the plate lamps
//             (0.375-0.573; a dealer plate in a frame there)
//  Tesla M3   no recesses (US plates on holders): front on the bumper over the lower grille (its edge at 0.385; the
//             face looks 7 deg down), rear where the US plate was on the bumper (8 deg up)
//  SLS AMG    front: the holder under the grille (0.22-0.33). rear: the recess in the bumper (0.375-0.505; its own plate)
//  Taycan     front: the bumper's face over the lower grille (6 deg down, the nose's crease above). rear: the recess low in the bumper (0.34-0.48; a
//             US bracket over it)
//  Huracán    front: the bar across the centre intake (0.29-0.31). rear: the recess between the exhausts (0.495-0.67,
//             4 deg; its own US plate)
//  GR Yaris   front: the bar across the lower grille (0.445-0.50, a lip on top: ours stands on the lip). rear: the
//             tailgate's recess (0.675-0.915, 18 deg;
//             its own US plate on a pad)
//  e-tron GT  (a concept) front: the band under the grille (0.37-0.53). rear: the bumper's panel between its lips
//             (0.61-0.79, 15 deg; a blank plate there)
//  GLS        front: on its bracket over the lower intake (the model's own plate face: 0.509-0.618, z 2.60). rear: high
//             on the tailgate as on the real X167: the flat panel between the tail lights (0.93-1.195, leaning back
//             14 deg; the dark strip under the star above it), level with the lamps' lower half
const PLATE_SPOT = {
  car_bmw_x3: { f: [0.534, 0], r: [0.965, 15] },
  car_audi_rs6: { f: [0.48, 8], r: [0.80, 14] },
  car_tesla_m3: { f: [0.48, -7], r: [0.815, 8] }, // (Oct 29, the user: both up a bit)
  car_vw_golf_gti: { f: [0.492, 0, 2.15], r: [0.475, 4] },
  car_mercedes_sls: { f: [0.275, 0], r: [0.44, 0] },
  car_porsche_taycan: { f: [0.43, -6], r: [0.41, 0] },
  car_lamborghini_huracan: { f: null, r: [0.583, 4] }, // (no front plate: Oct 29, the user)
  car_toyota_gr_yaris: { f: [0.473, 0], r: [0.835, 18] }, // (rear up in its recess: Oct 29, the user)
  car_audi_etron_gt: { f: [0.45, 0], r: [0.70, 15] },
  car1: { f: [0.47, 0], r: [0.687, 14] }, // (the police car: where its German plates were, cars.js PLATE_PIECES; Oct 30, the user: Swiss plates on it)
  car_mercedes_gls: { f: [0.5635, 0, 2.6], r: [1.11, 14] }, // (rear: on the tailgate between the lights, under the star; Oct 29, the user: "way higher like real gls models")
};
export const PLATE_W = 0.52, PLATE_H = 0.11; // EU plate, 520 x 110 mm (the models are at their real size)
const plateModel = (t) => (t.name || '').replace(/_full$/, '');
export function plateSpots(t) {
  if (t.plates !== undefined) return t.plates;
  t.plates = [];
  try {
    const spec = PLATE_SPOT[plateModel(t)] || { f: [0.45, 0], r: [0.7, 0] };
    // (the alpha-cut grilles too: the Huracán's rear plate goes on the mesh grille between the exhausts)
    const parts = [...(t.body || t.parts || []), ...(t.lamps?.parts || [])].filter((p) => !p.material.transparent || p.material.opacity >= 0.9);
    const meshes = parts.map((p) => new THREE.Mesh(p.geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })));
    const L = t.size.z / 2, rc = new THREE.Raycaster(), o = new THREE.Vector3();
    for (const k of [0, 1]) {
      const sp = k ? spec.r : spec.f;
      if (!sp) continue; // (no plate there)
      const s = k ? -1 : 1, [y, tilt, zFace] = sp, a = tilt * Math.PI / 180;
      const n = new THREE.Vector3(0, Math.sin(a), s * Math.cos(a));
      // (seen from outside it reads left to right: at the back the plate's x is the car's -x)
      const x = new THREE.Vector3(s, 0, 0), up = new THREE.Vector3().crossVectors(n, x);
      if (zFace !== undefined) { // (given: on its holder, 2 mm proud)
        const at = new THREE.Vector3(0, y, zFace).addScaledVector(n, 0.002);
        t.plates.push({ m: new THREE.Matrix4().makeBasis(x, up, n).setPosition(at), front: !k, at, n, gap: 0, sunk: 0 });
        continue;
      }
      // the surface at the plate's centre (straight in), then 1 m out along the plate's facing from there
      rc.set(o.set(0, y, s * (L + 1)), new THREE.Vector3(0, 0, -s)); rc.far = 2.5;
      const h0 = rc.intersectObjects(meshes, false)[0];
      if (!h0) continue;
      const A = h0.point.clone().addScaledVector(n, 1);
      const ds = []; let centre = null;
      for (const u of [-0.24, -0.16, -0.08, 0, 0.08, 0.16, 0.24]) for (const v of [-0.045, 0, 0.045]) {
        o.copy(A).addScaledVector(x, u).addScaledVector(up, v);
        rc.set(o, n.clone().negate()); rc.far = 2.5;
        const h = rc.intersectObjects(meshes, false)[0];
        if (!h) continue;
        ds.push(h.distance);
        if (!u && !v) centre = h.distance;
      }
      if (centre === null) continue;
      // the frontmost point of the face, leaving out a lone lip / catch at the very edge (more than 2 cm proud of
      // the median: the recess's rim, a tailgate handle; the plate's edge goes under it, the rest stays flush)
      ds.sort((p, q) => p - q);
      const med = ds[ds.length >> 1], near = ds.find((d) => d >= med - 0.02), far = ds[ds.length - 1];
      const at = A.clone().addScaledVector(n, -near + 0.002); // flush on the frontmost point, 2 mm proud
      // and nothing of the car inside its outline in front of it (a lip across the holder the rays passed between):
      // out to 2 mm in front of the most proud vertex there
      let w = -Infinity;
      for (const p of parts) {
        const P = p.geometry.attributes.position;
        for (let i = 0; i < P.count; i++) {
          o.fromBufferAttribute(P, i).sub(at);
          const d = o.dot(n);
          if (d > w && d < 0.06 && Math.abs(o.dot(x)) < PLATE_W / 2 && Math.abs(o.dot(up)) < PLATE_H / 2) w = d;
        }
      }
      if (w > -0.002) at.addScaledVector(n, w + 0.002);
      const m = new THREE.Matrix4().makeBasis(x, up, n).setPosition(at);
      t.plates.push({ m, front: !k, at, n, gap: far - near, sunk: centre - near });
    }
    for (const me of meshes) me.material.dispose();
  } catch (e) { console.warn('plates', t.name, e); }
  return t.plates;
}
const plateGeo = new THREE.PlaneGeometry(PLATE_W, PLATE_H);

// ---------------------------------------------------------------- interiors (a recolour inside the material)
// The trim's colour from the texture's own light and shade (lum), only where the seats are for a model whose cabin is
// one atlas (zone: behind the dash, between the floor and the window line), a fine leather grain / cloth weave at
// close range (the cabin reads crisp even where its texture is soft), fading with distance (no shimmer).
const CABIN = {
  car_vw_golf_gti: { mat: /leather|perfor|fabric|seatB/i }, car_tesla_m3: { mat: /BlackSuade|interiorGray|LightGrayInterior/i },
  car_bmw_x3: { mat: /FrontSeat|BackSeat/i }, car_audi_rs6: { mat: /InteriorA_Material|InteriorTillingA/i, zone: true },
  car_mercedes_sls: { mat: /^INT_Skin\.\d/i, zone: true }, car_porsche_taycan: { mat: /taycan_turbo_s_cab/i, zone: true },
  car_lamborghini_huracan: { mat: /InteriorA_Material|InteriorTillingA/i, zone: true }, car_toyota_gr_yaris: { mat: /InteriorA_Material/i, zone: true },
  car_audi_etron_gt: { mat: /^INTVehicle_Interior_mm_(mat05|mat01)$/, zone: true }, car_mercedes_gls: { mat: /^gls_interior$/, zone: true },
};
function cabinMat(src, look, t, spec) {
  const m = src.clone();
  const sz = t.steering?.c?.z ?? t.size.z * 0.1;
  const U = {
    uTint: { value: new THREE.Color(look.hex) }, uAccent: { value: new THREE.Color(look.accent || 0) }, uAmt: { value: look.amt || 0 },
    uPat: { value: look.pattern || 0 }, uGrain: { value: spec.grain ? 0.16 : 0.08 },
    uZone: { value: new THREE.Vector4(sz - 0.32, 0.22, Math.min(1.25, t.size.y - 0.3), spec.zone ? 1 : 0) },
  };
  m.userData.cabin = U;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vCab;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvCab = position;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
varying vec3 vCab; uniform vec3 uTint, uAccent; uniform float uAmt, uPat, uGrain; uniform vec4 uZone;
float cabH(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float cabN(vec3 x) { vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(cabH(i), cabH(i + vec3(1, 0, 0)), f.x), mix(cabH(i + vec3(0, 1, 0)), cabH(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(cabH(i + vec3(0, 0, 1)), cabH(i + vec3(1, 0, 1)), f.x), mix(cabH(i + vec3(0, 1, 1)), cabH(i + vec3(1, 1, 1)), f.x), f.y), f.z); }`)
      .replace('#include <map_fragment>', `#include <map_fragment>
{
  float zone = uZone.w < 0.5 ? 1.0 : (1.0 - smoothstep(uZone.x - 0.05, uZone.x + 0.05, vCab.z)) * smoothstep(uZone.y - 0.05, uZone.y + 0.05, vCab.y) * (1.0 - smoothstep(uZone.z - 0.06, uZone.z + 0.06, vCab.y));
  float lum = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  vec3 col = uTint * (0.45 + 1.7 * lum);
  float fw = length(fwidth(vCab));
  if (uPat > 0.5) {
    // the check: thin coloured threads every 6 cm (two close ones), across the seat's face (x, and up / along it)
    vec2 q = vec2(vCab.x, vCab.y + vCab.z) * 16.0, g = abs(fract(q) - 0.5), g2 = abs(fract(q * 2.0 + 0.25) - 0.5);
    float aa = fw * 16.0 + 0.02, line = 1.0 - smoothstep(0.02, 0.02 + aa, min(g.x, g.y));
    float thin = (1.0 - smoothstep(0.015, 0.015 + aa * 2.0, min(g2.x, g2.y))) * 0.35;
    col = mix(col, uAccent * (0.55 + 1.2 * lum), clamp(uPat > 1.5 ? thin * 2.2 : line * 0.9 + thin, 0.0, 1.0));
  }
  diffuseColor.rgb = mix(diffuseColor.rgb, col, uAmt * zone);
  // the grain (leather / weave), only close up: two octaves of fine noise
  float gr = cabN(vCab * 700.0) * 0.6 + cabN(vCab * 1900.0) * 0.4;
  diffuseColor.rgb *= 1.0 + (gr - 0.5) * uGrain * (1.0 - smoothstep(0.0012, 0.004, fw));
}`);
  };
  m.customProgramCacheKey = () => 'cabin-v1';
  return m;
}

// ---------------------------------------------------------------- dress an instance
const _tint = new THREE.Color();
/** Paint, interior, rims and plates on a car instance (cars.js carInstance) of template t. cfg: normConfig(). */
export function dressCar(inst, t, cfg) {
  if (!inst || !t || !cfg) return inst;
  const model = (t.name || '').replace(/_full$/, ''), paint = paintOf(cfg.paint), fin = FINISH[paint.finish], look = interiorOf(cfg.interior), rim = rimOf(cfg.rims);
  const spec = CABIN[model];
  const swaps = new Map();
  const swap = (m, make) => { if (!swaps.has(m)) swaps.set(m, make(m)); return swaps.get(m); };
  for (const o of inst.full.children) {
    if (!o.isMesh || inst.lamps?.list?.some((l) => l.m === o.material)) continue;
    const src = o.userData.srcMat ||= o.material;
    // the body paint: colour and finish (textures keep their detail)
    if (isPaint(model, src)) {
      o.material = swap(src, (m) => {
        const p = m.clone(); p.color = new THREE.Color(paint.hex);
        p.roughness = fin.rough; p.metalness = fin.metal;
        if (p.isMeshPhysicalMaterial) { p.clearcoat = fin.clear; p.clearcoatRoughness = 0.06; }
        if (paint.finish === 'pearl' && p.isMeshPhysicalMaterial) { p.iridescence = 0.25; }
        return p;
      });
    } else if (spec?.mat.test(src.name || '') && (look.amt > 0 || spec.grain)) o.material = swap(src, (m) => cabinMat(m, look, t, spec));
    else o.material = src;
  }
  // the rims: their metal tinted (the tyres' black stays black: a multiply)
  for (const w of inst.wheels || []) w.roll.traverse((o) => {
    if (!o.isMesh) return;
    const src = o.userData.srcMat ||= o.material;
    if (rim.id === 'orig' || /tire|tyre|rubber|disk|disc|rotor|brake|break|calip|callip/i.test(src.name || '')) { o.material = src; return; }
    o.material = swap(src, (m) => { const r = m.clone(); r.color = (m.color ? m.color.clone() : new THREE.Color(1, 1, 1)).multiply(_tint.set(rim.hex)); if (rim.id === 'black') r.roughness = Math.min(r.roughness ?? 0.3, 0.3); return r; });
  });
  // the plates (front and back), your text
  setPlates(inst, t, cfg.plate || 'VS 1967');
  inst.cfg = cfg;
  return inst;
}

/** Number plates (front and back) on any car instance: the rental's own, a random one for the traffic and the
 *  parked cars (Oct 28, the user: "make bots have random number plates"). */
/** A model's own plate part (its texture, another size, the old spot), by material or name; not its plate lights. */
// (the models' own plates are left out of the templates already, cars.js; this only catches a stray one)
export const OWN_PLATE = /plate|licen|nomera|kennz/i;
export function isOwnPlate(t, o) {
  const mats = Array.isArray(o.material) ? o.material : [o.material];
  return o.name !== 'number-plate' && mats.some((m) => isPlateMat(m));
}
export function setPlates(inst, t, text = inst.plateText || randomPlate()) {
  inst.plateText = text;
  if (!inst.plates) {
    // the model's own plate (its texture, another size) hidden: ours takes its place
    // (Oct 28, the user: "some cars have double number plates, one on an old position": every model's own plate
    // part goes, wherever it sits in the instance and whatever material list it has)
    inst.full.traverse((o) => { if (o.isMesh && isOwnPlate(t, o)) o.visible = false; });
    inst.plates = []; for (const s of plateSpots(t)) { const m = new THREE.Mesh(plateGeo, new THREE.MeshStandardMaterial({ roughness: 0.42, metalness: 0.05, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })); m.name = 'number-plate'; m.matrixAutoUpdate = false; m.matrix.copy(s.m); m.castShadow = false; m.receiveShadow = true; inst.full.add(m); inst.plates.push(m); } }
  const tex = plateTexture(text);
  for (const p of inst.plates) if (p.material.map !== tex) { p.material.map = tex; p.material.needsUpdate = true; }
  return inst;
}
