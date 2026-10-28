// Car models (the user's own, in MODEL_LIST) turned into game-ready templates, shared by every car of that model:
// the many meshes merged into one per material (a few dozen draw calls instead of hundreds), transmission glass
// replaced by plain tinted glass (transmission costs a whole extra render pass), lights off, front toward +z, and a
// decimated far LOD (one mesh, vertex-coloured, a few thousand triangles; built once meshoptimizer has loaded).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshoptSimplifier } from 'meshoptimizer';
import { fitModel, dequantize } from '../core/assets.js';

/** Car models: [model name, real length (m)]. Add a car here (and to MODEL_LIST) and it parks / drives too. */
export const CAR_MODELS = [['car_bmw_x3', 4.7], ['car_audi_rs6', 5.0], ['car_vw_golf_gti', 4.3], ['car_tesla_m3', 4.7], ['car_dacia_duster', 4.34], ['car_mercedes_sls', 4.64], ['car_porsche_taycan', 4.96]];
// rare in the traffic and the car parks (the supercars: one in a while, not one in seven)
export const CAR_RARE = new Set(['car_mercedes_sls', 'car_porsche_taycan']);

const cache = new Map();

/** @returns {{ parts: {geometry, material}[], size: THREE.Vector3, lod: {geometry, material}|null }} */
// real sizes (m): length, width, height (the models are fitted by length, the rest is checked and logged)
export const REAL = {
  car_bmw_x3: [4.71, 1.89, 1.68], car_audi_rs6: [4.99, 1.95, 1.46], car_vw_golf_gti: [4.29, 1.79, 1.46],
  car_tesla_m3: [4.69, 1.85, 1.44], car_dacia_duster: [4.34, 1.80, 1.69],
  car_mercedes_sls: [4.64, 1.94, 1.26], car_porsche_taycan: [4.96, 1.97, 1.38],
};
const JUNK = /plane|ground|shadow|floor|backdrop|base_?plate|studio/i;
const REAR = /tail|rear|back_?light|red_?gla|red_?light|glow_red|reflector/i, FRONT = /head|front_?light|front/i;
// Which way each model's nose points as it comes in, checked by eye (tools/carlab.html?mode=raw: grille and headlights
// at the +z arrow, the Dacia's at +x): the turn about y that brings the nose to +z. The simplified, full-detail, parked,
// traffic and far-LOD versions all come from this. A car not listed here falls back to a guess (lights, longest side).
export const FACING = {
  car_bmw_x3: 0, car_audi_rs6: 0, car_audi_rs6_full: 0, car_vw_golf_gti: 0, car_vw_golf_gti_full: 0,
  car_tesla_m3: 0, car_tesla_m3_full: 0, car_dacia_duster: -Math.PI / 2, car_mercedes_sls: 0, car_porsche_taycan: 0,
};
// parts of a model left out altogether: the SLS's broken-glass overlay (a second skin over every window and lamp
// lens) and its motion-blurred rim discs (invisible at rest, drawn over the real rims)
const HIDE = { car_mercedes_sls: /DAMAGE_GLASS|Rim_Blurred/i };

// Lamps per model, checked against each model's meshes (where every part sits on the car, its name and material) and
// the real cars: (label, zone) -> 'head' | 'drl' | 'tail' | 'third' | 'rev' | 'ind' | 'lensF' | 'lensR' | null (no
// lamp: housings, chrome, reflectors, the plate, windows). test: the parts that can be lamps at all.
//  - BMW X3 (G01): twin LED projectors (Front_lights_Spec), the DRL rings round them, indicators in the mirrors; the
//    red light guides and lamp graphics behind dark glass at the back; the third brake light on the roof spoiler
//    (red_glass up there; the red glass low in the bumper is a reflector).
//  - Audi RS6 Avant (C8): every lamp is one textured material (the texture draws the LED signature): front -> head,
//    back -> tail, the strip on the roof spoiler -> third, the mirror caps -> indicators, the bumper's -> reflectors.
//  - Golf GTI (Mk8): projector glow, the DRL strips and the light bar across the grille, red LED glows, the third
//    brake light at the top of the hatch (Trunk_Red_Glass), clear strips in the hatch lamps -> reversing.
//  - Tesla Model 3: the white inner lamps (head at the front; reversing at the back), red lamps, amber corner lights;
//    no third brake light of its own: one is added at the top of the rear window (THIRD_AT).
//  - Dacia Duster: textured head / tail lamps ('Foglight' is the windows' material: never a lamp); the third brake
//    light is added above the rear window.
const LAMP_RULES = {
  car_bmw_x3: {
    test: /Front_lights_Spec|Mirrors_color_BMW:?light|Glass_front_lights|Back_lights_emissive|Baked_Back_lights|red_glass|Glass_backlights_glass_light/i,
    kind: (l, p) => /chrome|Light_Black|blue_light/i.test(l) ? null
      : /Front_lights_Spec/i.test(l) ? (p.front ? 'head' : null)
      : /Mirrors_color_BMW:?light/i.test(l) ? (p.front ? 'drl' : null)
      : /Glass_front_lights/i.test(l) ? (p.mirror ? 'ind' : p.front ? 'lensF' : null)
      : /Back_lights_emissive|Baked_Back_lights/i.test(l) ? (p.rear && !p.low ? 'tail' : null)
      : /red_glass/i.test(l) ? (p.third ? 'third' : null)
      : /Glass_backlights_glass_light/i.test(l) ? (p.rear && !p.low ? 'lensR' : null)
      : null,
    // The cover glass over the tail lamps is the same material as the headlamps' ('glass_light': a clear glass, which
    // matFor makes a pale see-through grey): over the red light guides it washed them out to a pinkish white, by day
    // and lit. The G01's tail lamps are deep red, smoked lenses: that glass at the back, red and dark.
    // (glow: its own share of the light, less than a clear lens: lit from behind, it filters rather than shines; the
    // light guides behind it stay a clean red under braking instead of stacking up toward orange)
    lens: { lensR: { color: 0x3c0306, opacity: 0.64, roughness: 0.04, metalness: 0.1, glow: 0.4 } },
    // (and the red light guides themselves, a faint see-through film boosted by its opacity, a little less: braking at
    // night they summed past what the tone map keeps red, to salmon. glow: kind -> share, for the LED cores)
    glow: { tail: 0.6 },
  },
  car_audi_rs6: {
    test: /LightA_Material|red_glass/i,
    kind: (l, p) => /red_glass/i.test(l) ? (p.third ? 'third' : p.rear && !p.low ? 'lensR' : null)
      : p.mirror ? 'ind' : p.front ? 'head' : p.third ? 'third' : p.rear && !p.low ? 'tail' : null,
  },
  car_vw_golf_gti: {
    test: /Glow_|Trunk_Red_Glass|Glass_Red|Glass_Clear|Clear_Glass/i,
    kind: (l, p) => /^G?:?Int_/.test(l) ? null // (the cabin)
      : /Trunk_Red_Glass/i.test(l) ? (p.rear ? 'third' : null)
      : /Glow_Main_Cold/i.test(l) ? (p.front ? 'head' : null)
      : /Glow_DRL/i.test(l) ? (p.front ? 'drl' : null)
      : /Glow_Red/i.test(l) ? (p.rear ? 'tail' : null)
      : /Glass_Red/i.test(l) ? (p.rear ? 'lensR' : null)
      : /Trunk_Lid_Glass_Clear/i.test(l) ? (p.rear ? 'rev' : null)
      : /Taillight_Glass_Clear/i.test(l) ? (p.rear ? 'lensR' : null)
      : /Lights_Glass_Clear/i.test(l) ? (p.front ? 'lensF' : null)
      : /Door_F[LR]_Clear_Glass/i.test(l) ? (p.mirror ? 'ind' : null)
      : null,
  },
  car_tesla_m3: {
    test: /innerLights|RedLight|OrangeLights|glassDark/i,
    kind: (l, p) => /innerLightMetals|LicensePlate/i.test(l) ? null
      : /OrangeLights/i.test(l) ? 'ind'
      : /innerLights/i.test(l) ? (p.front ? (p.low ? null : 'head') : p.rear && !p.low ? 'rev' : null)
      : /RedLight/i.test(l) ? (p.rear && !p.low ? 'tail' : null)
      : /glassDark/i.test(l) ? (p.rear && !p.low && !p.hi && Math.abs(p.x) > 0.3 ? 'lensR' : null)
      : null,
  },
  // Mercedes SLS AMG (C197): textured lamps (Lights_Front: the headlamp units and the indicators in the mirrors;
  // Lights_Rear: the tail lamps, the third brake light at the roof's end, the low centre lamp (fog: never lit here)),
  // the LED strip in the headlamps (EXT_Microluci: the DRL), their clear cover glass (Glass_Clear: front / back)
  car_mercedes_sls: {
    test: /Lights_Front|Lights_Rear|Microluci|Glass_Clear/i,
    kind: (l, p) => /Microluci/i.test(l) ? (p.front ? 'drl' : null)
      : /Lights_Front/i.test(l) ? (p.mirror ? 'ind' : p.front ? 'head' : null)
      : /Lights_Rear/i.test(l) ? (p.third ? 'third' : p.rear && !p.low ? 'tail' : null)
      : /Glass_Clear/i.test(l) ? (p.front ? 'lensF' : p.rear && !p.low ? 'lensR' : null)
      : null,
    lens: { lensF: { color: 0xc9d0d8, opacity: 0.22, roughness: 0.04, metalness: 0.1, glow: 0.5 }, lensR: { color: 0x3c0306, opacity: 0.4, roughness: 0.04, metalness: 0.1, glow: 0.4 } },
  },
  // Porsche Taycan Turbo S: every lamp in one textured atlas (the four-point headlamps, the light bar across the
  // back, the third brake light at the top of the rear window); the windows' material is also the lamps' cover glass
  // (front low: the headlamp lenses; back, below the rear window: the light bar's smoked glass)
  car_porsche_taycan: {
    test: /taycan_turbo_s_lights|car_windows/i,
    kind: (l, p) => /car_windows/i.test(l) ? (p.front && p.y < 0.85 ? 'lensF' : p.rear && !p.low && !p.hi ? 'lensR' : null)
      : p.third ? 'third' : p.front ? (p.low ? null : 'head') : p.rear && !p.low ? 'tail' : null,
    lens: { lensF: { color: 0xc9d0d8, opacity: 0.22, roughness: 0.04, metalness: 0.1, glow: 0.5 }, lensR: { color: 0x3c0306, opacity: 0.45, roughness: 0.04, metalness: 0.1, glow: 0.4 } },
  },
  car_dacia_duster: {
    test: /Headlight|Taillight/i,
    kind: (l, p) => /Headlight/i.test(l) ? (p.front ? 'head' : null) : /Taillight/i.test(l) ? (p.rear && !p.low ? 'tail' : null) : null,
  },
};
// Materials drawn as cut-outs (opaque, depth-written, alpha-tested) instead of blended. The RS6's whole cabin is one
// textured material marked alpha BLEND (for its decals: stitching, button labels), so it came in transparent with no
// depth writes: the steering wheel's airbag and spokes were drawn over by whatever lay behind them (the column, the
// instrument cluster) and looked see-through. Its texture's alpha: solid panels (the airbag, spokes, dash) with soft
// grey seams, and cut-out decals (stitching, button symbols): cut at 0.3, so the seams stay solid (no slits).
const CUTOUT = { car_audi_rs6: /InteriorA_Material/i };
// The four rings on the steering wheel's airbag (RS6): the model's own badge there is a dark decal on the black hub,
// lost in it, where the real car's are chrome. Four thin chrome tori laid exactly on that decal, from its UV layout
// (the badge texture draws the rings stacked down its right-hand column): u, v of each ring's centre, the ring's radius
// and the tube's (texture units). They are part of the steering wheel, so they turn with it.
const HUB_RINGS = { car_audi_rs6: { mat: /BadgeA_Material/i, u: 0.809, v: [0.18, 0.391, 0.602, 0.813], r: 0.152, tube: 0.021 } };
// no high-mounted brake light in the model: where to add one (the rear window's glass)
const THIRD_AT = { car_tesla_m3: { glass: /glassDark/i, at: 'window' }, car_dacia_duster: { glass: /Foglight/i, at: 'spoiler' } };
// The body paint: the material the paint colour tints (cars with no material of their own called *paint*: the Dacia's
// body is UV_body, its paint baked orange into the shared atlas: neutralised to a light grey in a copy of its own,
// neutralPaint, so any colour multiplies cleanly; the Dacia's own orange is then its material's colour)
const PAINT_MAT = { car_dacia_duster: /^UV_body/, car_porsche_taycan: /ext_carmine_red/i };
export const isPaint = (model, m) => !m.transparent && (PAINT_MAT[model] || /paint/i).test(m.name || '');
// (the colour baked in, and the texel value its clean paint has: the Dacia's orange, the Taycan's Carmine Red)
const NEUTRAL = { car_dacia_duster: 0xef8e2c, car_porsche_taycan: 0xa8181f };
const NEUTRAL_HUE = { car_porsche_taycan: 'red' };
function neutralPaint(m, hex, hue = 'orange') {
  const img = m.map?.image;
  if (!img?.width) return m;
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height), a = d.data;
  for (let i = 0; i < a.length; i += 4) {
    const r = a[i], gg = a[i + 1], b = a[i + 2];
    // how orange this texel is (saturated, red over green over blue): the paint; its shade kept as a grey
    // (red: how much red stands over both green and blue)
    const k = hue === 'red' ? Math.min(1, Math.max(0, ((r - Math.max(gg, b)) / Math.max(1, r) - 0.45) * 4)) * Math.min(1, Math.max(0, (r - 50) / 40))
      : Math.min(1, Math.max(0, ((r - b) / Math.max(1, r) - 0.45) * 4)) * (r > gg && gg > b ? 1 : 0) * Math.min(1, Math.max(0, (r - 60) / 50));
    if (k <= 0) continue;
    const v = Math.min(255, (r / (hue === 'red' ? 155 : 220)) * 236);
    a[i] = r + (v - r) * k; a[i + 1] = gg + (v - gg) * k; a[i + 2] = b + (v - b) * k;
  }
  g.putImageData(d, 0, 0);
  const out = m.clone(), t = m.map.clone();
  t.image = c; t.needsUpdate = true;
  out.map = t; out.color = new THREE.Color(hex);
  return out;
}
// A soft cabin atlas made crisper (the Dacia's: its whole interior in one heavily compressed 1024 texture, ~3 mm a
// texel, magnified ~5x from the driver's seat): upscaled 2x (smooth), then an unsharp mask, in place (every material
// sharing it sees it); off the main frame (an idle callback), once.
const CRISP = { car_dacia_duster: /^UV_int$/ };
function crispMap(tex) {
  const img = tex?.image;
  if (!img?.width || tex.userData.crisp) return;
  tex.userData.crisp = true;
  const run = () => {
    try {
      const W = Math.min(2048, img.width * 2), H = Math.min(2048, img.height * 2), c = document.createElement('canvas'); c.width = W; c.height = H;
      const g = c.getContext('2d', { willReadFrequently: true }); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, W, H);
      const d = g.getImageData(0, 0, W, H), a = d.data, src = new Uint8ClampedArray(a), row = W * 4, K = 0.9;
      for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
        const i = y * row + x * 4;
        for (let ch = 0; ch < 3; ch++) {
          const j = i + ch, blur = (src[j - 4] + src[j + 4] + src[j - row] + src[j + row]) * 0.25;
          a[j] = src[j] + (src[j] - blur) * K;
        }
      }
      g.putImageData(d, 0, 0);
      tex.image = c; tex.needsUpdate = true;
    } catch (e) { console.warn('crisp cabin', e); }
  };
  (globalThis.requestIdleCallback || ((f) => setTimeout(f, 200)))(run);
}
// any other car: by name and place
const LAMP = /light|lamp|drl|glow|lens|red_?glas/i, NOT_LAMP = /black|chrome|metal|interior|plate|licen|mirror|disk|disc|rotor|calliper|caliper|seat|stitch|rail|blue|dash|screen|display|int_|cabin|roof|ceiling|reading|reflector|fog|housing|window/i;
const AMBER = /orange|amber|indicator|turn_?sig|blinker/i;
function genericLamp(l, p) {
  if (AMBER.test(l)) return p.front || p.rear || p.mirror ? 'ind' : null;
  if (!LAMP.test(l) || NOT_LAMP.test(l) || p.mirror) return null;
  if (p.front) return /red|tail|brake|stop|rear|back/i.test(l) ? null : /drl|daytime/i.test(l) ? 'drl' : 'head';
  if (p.rear) return p.third ? 'third' : p.low ? null : /revers|backup/i.test(l) ? 'rev' : 'tail';
  return null;
}
const _lv = new THREE.Vector3();

// The added third brake light: a slim strip at the top of the rear window, just under the glass (a fastback: where
// the window starts to fall away from the roof), or just above it on the tailgate spoiler (a hatch / SUV)
function synthThird(groups, lampGroups, anchors, spec, halfL, carH) {
  const v = new THREE.Vector3(), glass = [];
  for (const geos of groups.values()) for (const g of geos) {
    if (!spec.glass.test(g.userData.label || '')) continue;
    const P = g.attributes.position;
    for (let i = 0; i < P.count; i++) { v.fromBufferAttribute(P, i); if (Math.abs(v.x) < 0.45 && v.z < -halfL * 0.15 && v.y > carH * 0.55) glass.push(v.y, v.z); }
  }
  if (glass.length < 12) return;
  let y = 0, z = 0, tilt = 0, w = 0.4, h = 0.022;
  if (spec.at === 'window') {
    // the roof line over the centre (highest glass per 4 cm), from the roof back: the first place it falls away
    const bins = new Map();
    for (let i = 0; i < glass.length; i += 2) { const k = Math.floor(glass[i + 1] / 0.04); bins.set(k, Math.max(bins.get(k) ?? -1, glass[i])); }
    const ks = [...bins.keys()].sort((a, b) => b - a);
    let found = false;
    for (let j = 0; j + 5 < ks.length; j++) {
      const k0 = ks[j], k1 = ks[j + 5], drop = (bins.get(k0) - bins.get(k1)) / ((k0 - k1) * 0.04);
      if (drop > 0.16) { z = (k0 + 0.5) * 0.04 - 0.06; y = bins.get(k0) - 0.004 - 0.06 * drop; tilt = Math.atan(drop); found = true; break; }
    }
    if (!found) return;
    y -= 0.009; // (just under the glass)
  } else {
    // the top edge of the rear window, and the body above it (the spoiler): the strip on its rear face
    let yTop = -1;
    for (let i = 0; i < glass.length; i += 2) if (glass[i + 1] < -halfL * 0.6 && glass[i] > yTop) yTop = glass[i];
    if (yTop < 0) return;
    let zTop = Infinity;
    for (let i = 0; i < glass.length; i += 2) if (glass[i] > yTop - 0.03 && glass[i + 1] < zTop) zTop = glass[i + 1];
    let zBody = Infinity;
    for (const geos of groups.values()) for (const g of geos) {
      const P = g.attributes.position;
      for (let i = 0; i < P.count; i++) { v.fromBufferAttribute(P, i); if (Math.abs(v.x) < 0.2 && v.y > yTop + 0.01 && v.y < yTop + 0.12 && v.z < zBody && v.z > -halfL * 1.05) zBody = v.z; }
    }
    y = yTop + 0.035; z = Math.min(zTop, Number.isFinite(zBody) ? zBody : zTop) - 0.008; tilt = Math.PI / 2; w = 0.36; h = 0.026;
  }
  const geo = new THREE.BoxGeometry(w, 0.009, h); // (lying in the glass; turned upright for the spoiler)
  geo.rotateX(spec.at === 'window' ? -tilt : tilt); // (the window falls away toward the back)
  geo.translate(0, y, z);
  const mat = new THREE.MeshStandardMaterial({ name: 'third_brake_light', color: 0x2a0404, roughness: 0.3, metalness: 0.1 });
  lampGroups.set('third', new Map([[mat, [geo]]]));
  geo.computeBoundingBox();
  anchors.set('third', [{ min: geo.boundingBox.min.clone(), max: geo.boundingBox.max.clone() }, null]);
}

// The model laid out with its length along z and its nose toward +z, any stray ground / shadow planes left out,
// scaled to the real length, wheels on y = 0, centred.
export function fitCar(gltf, length, name) {
  const m = gltf.scene.clone(true);
  const junk = [];
  const hide = HIDE[(name || '').replace(/_full$/, '')];
  m.traverse((o) => { if (!o.isMesh) return; const lbl = `${o.name} ${[].concat(o.material).map((x) => x?.name).join(' ')}`; if (JUNK.test(lbl) || hide?.test(lbl)) junk.push(o); });
  for (const o of junk) o.parent?.remove(o);
  m.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(m), size = box.getSize(new THREE.Vector3()), mid = box.getCenter(new THREE.Vector3());
  const v = new THREE.Vector3();
  let alongX = size.x > size.z * 1.12;
  if (name in FACING) { m.rotation.y = FACING[name]; alongX = Math.abs(Math.sin(FACING[name])) > 0.5; }
  else {
    // a new car: which end is the front, by the mean position of its rear lights (red / tail / reflectors) or headlights
    let rearSum = 0, rearN = 0, frontSum = 0, frontN = 0;
    m.traverse((o) => {
      if (!o.isMesh) return;
      const label = `${o.name} ${[].concat(o.material).map((x) => x?.name).join(' ')}`;
      const rear = REAR.test(label) && !/disk|disc/i.test(label), front = !rear && FRONT.test(label);
      if (!rear && !front) return;
      const b = new THREE.Box3().setFromObject(o).getCenter(v);
      const c = alongX ? b.x - mid.x : b.z - mid.z;
      if (rear) { rearSum += c; rearN++; } else { frontSum += c; frontN++; }
    });
    let frontSign = 1;
    if (rearN) frontSign = rearSum / rearN > 0 ? -1 : 1;
    else if (frontN) frontSign = frontSum / frontN >= 0 ? 1 : -1;
    // turn so the nose is toward +z: from +x -> -pi/2, from -x -> +pi/2, from -z -> pi
    m.rotation.y = alongX ? (frontSign > 0 ? -Math.PI / 2 : Math.PI / 2) : (frontSign > 0 ? 0 : Math.PI);
    console.warn(`car ${name}: not in FACING, nose guessed (check it in tools/carlab.html)`);
  }
  m.updateMatrixWorld(true);
  box.setFromObject(m);
  const s = length / box.getSize(v).z;
  m.scale.multiplyScalar(s);
  m.updateMatrixWorld(true);
  box.setFromObject(m);
  const c = box.getCenter(new THREE.Vector3());
  m.position.sub(new THREE.Vector3(c.x, box.min.y, c.z));
  const g = new THREE.Group();
  g.add(m);
  g.updateMatrixWorld(true);
  const fin = new THREE.Box3().setFromObject(g).getSize(new THREE.Vector3());
  const real = REAL[name];
  console.info(`car ${name || '?'}: ${fin.z.toFixed(2)} x ${fin.x.toFixed(2)} x ${fin.y.toFixed(2)} m (L x W x H)` + (real ? `, real ${real.join(' x ')}` : '') + (alongX ? ' (turned: modelled along x)' : '') + (junk.length ? `, ${junk.length} stray plane(s) left out` : ''));
  return g;
}

export function carTemplate(gltf, length, name = '') {
  if (cache.has(gltf)) return cache.get(gltf);
  const src = fitCar(gltf, length, name); // (length along z, nose toward +z, real size)
  const model = name.replace(/_full$/, ''); // (the full-detail model: the same rules as the simplified one)
  src.updateMatrixWorld(true);
  const swap = new Map();
  const matFor = (m) => {
    if (swap.has(m)) return swap.get(m);
    let out = m;
    const name = (m.name || '').toLowerCase();
    // only real glass turns see-through (window surrounds, trim, tyres and rims stay opaque)
    const glass = m.transmission > 0 || (/glass|glas$|window|windscreen/.test(name) && !/surr|frame|seal|rubber|trim/.test(name));
    if (glass) {
      const red = /red/.test(name), clear = /front_light|light/.test(name) && !red;
      out = new THREE.MeshStandardMaterial({ color: red ? 0x7a0c0c : clear ? 0xc9d0d8 : 0x161d24, transparent: true, opacity: red ? 0.7 : clear ? 0.45 : 0.42, roughness: 0.06, metalness: 0.15, depthWrite: false });
    } else if (m.emissive) {
      out = m.clone();
      // (lights off; what made it glow is kept: the lamps light up with the model's own LED / DRL graphics)
      const lit = m.emissiveMap || m.emissive.getHex() !== 0;
      if (lit) out.userData.emOrig = { color: m.emissive.clone(), map: m.emissiveMap || null };
      out.emissive.set(0x000000); out.emissiveIntensity = 0; out.emissiveMap = null;
    }
    if (glass && m.emissive && (m.emissiveMap || m.emissive.getHex() !== 0)) out.userData.emOrig = { color: m.emissive.clone(), map: m.emissiveMap || null };
    if (!glass && NEUTRAL[model] !== undefined && isPaint(model, m)) out = neutralPaint(m, NEUTRAL[model], NEUTRAL_HUE[model]);
    if (CRISP[model]?.test(m.name || '')) crispMap(m.map);
    // every texture filtered at the widest angle the GPU has (three clamps it): the dash, seats and door cards seen
    // at a slant from the driver's seat stay sharp instead of melting into the mip below
    for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap']) if (m[k] && m[k].anisotropy < 16) { m[k].anisotropy = 16; m[k].needsUpdate = true; }
    if (!glass && m.transparent && CUTOUT[model]?.test(m.name || '')) {
      // (a cut-out: solid where its texture is, holes where it isn't; casts no shadow, as before)
      if (out === m) out = m.clone();
      out.transparent = false; out.depthWrite = true; out.alphaTest = 0.3; out.userData.cutout = true;
    }
    swap.set(m, out);
    return out;
  };
  const groups = new Map();
  // the lamps: the car's own light meshes, triangle by triangle into their groups (LAMP_RULES per model, checked
  // against where each part sits on the real car; a generic rule by name and place for any other car): head (low
  // beams), drl, tail (running + brake), third (the high-mounted brake light), rev (reversing), ind (amber
  // indicators), lensF / lensR (cover glass that only catches the light). Housings, reflectors, the number plate and
  // the windows never glow. carlights.js lampsOn lights them.
  const fitBox = new THREE.Box3().setFromObject(src), halfL = (fitBox.max.z - fitBox.min.z) / 2, carH = fitBox.max.y - fitBox.min.y, halfW = (fitBox.max.x - fitBox.min.x) / 2;
  const lampGroups = new Map(); // kind -> Map(material -> geometries)
  const anchors = new Map(); // kind -> [{ min, max }] per side (x < 0, x >= 0): where the halos go
  const rule = LAMP_RULES[model];
  // a lamp's own glass where the model shares one with other lamps (rule.lens: kind -> look), once per material
  const lensMats = new Map();
  const lensFor = (mat, kind) => {
    const look = rule?.lens?.[kind];
    if (!look || !mat.transparent) return mat;
    const k = mat.uuid + kind;
    if (!lensMats.has(k)) { const m = mat.clone(); m.name = `${mat.name || 'lens'}_${kind}`; m.color.set(look.color); m.opacity = look.opacity; m.roughness = look.roughness ?? m.roughness; m.metalness = look.metalness ?? m.metalness; m.userData.glow = look.glow ?? 1; lensMats.set(k, m); }
    return lensMats.get(k);
  };
  const zone = (x, y, z) => {
    const front = z > halfL * 0.45, rear = z < -halfL * 0.45;
    return { x, y, z, front, rear, low: y < carH * 0.42, hi: y > carH * 0.72, third: rear && Math.abs(x) < 0.42 && y > carH * 0.7, mirror: !front && !rear && Math.abs(z) < halfL * 0.42 && Math.abs(x) > halfW - 0.3 && y > carH * 0.5 };
  };
  const lampSplit = (mat, g, label) => {
    if (rule ? !rule.test.test(label) : !((LAMP.test(label) && !NOT_LAMP.test(label)) || AMBER.test(label))) return false;
    const P = g.attributes.position, I = g.index.array, keep = [], by = new Map();
    for (let i = 0; i < I.length; i += 3) {
      const x = (P.getX(I[i]) + P.getX(I[i + 1]) + P.getX(I[i + 2])) / 3, y = (P.getY(I[i]) + P.getY(I[i + 1]) + P.getY(I[i + 2])) / 3;
      const z = (P.getZ(I[i]) + P.getZ(I[i + 1]) + P.getZ(I[i + 2])) / 3;
      const p = zone(x, y, z);
      const kind = rule ? rule.kind(label, p) : genericLamp(label, p);
      if (!kind) { keep.push(I[i], I[i + 1], I[i + 2]); continue; }
      if (!by.has(kind)) by.set(kind, []);
      by.get(kind).push(I[i], I[i + 1], I[i + 2]);
      if (!anchors.has(kind)) anchors.set(kind, [null, null]);
      const side = anchors.get(kind), s = x < 0 ? 0 : 1;
      side[s] ||= { min: new THREE.Vector3(Infinity, Infinity, Infinity), max: new THREE.Vector3(-Infinity, -Infinity, -Infinity) };
      for (let k = 0; k < 3; k++) { const j = I[i + k]; _lv.set(P.getX(j), P.getY(j), P.getZ(j)); side[s].min.min(_lv); side[s].max.max(_lv); }
    }
    if (!by.size) return false;
    for (const [kind, tri] of by) {
      if (!lampGroups.has(kind)) lampGroups.set(kind, new Map());
      const map = lampGroups.get(kind), lm = lensFor(mat, kind);
      if (!map.has(lm)) map.set(lm, []);
      const sub = compact(g, tri, null);
      sub.userData.label = label;
      map.get(lm).push(sub);
    }
    if (keep.length) { const sub = compact(g, keep, null); sub.userData.label = label; if (!groups.has(mat)) groups.set(mat, []); groups.get(mat).push(sub); }
    return true;
  };
  src.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const geo = dequantize(o.geometry);
    geo.applyMatrix4(o.matrixWorld);
    for (const k of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv'].includes(k)) geo.deleteAttribute(k);
    if (!geo.attributes.normal) geo.computeVertexNormals();
    if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
    if (!geo.index) geo.setIndex([...Array(geo.attributes.position.count).keys()]);
    fixNormals(geo); // (decimated meshes still carrying their high-res normals: re-shaded smooth, with crisp creases)
    const label = `${o.name} ${mats.map((m) => m.name).join(' ')}`;
    const add = (mat, g) => { const lbl = label + ' ' + (mat.name || ''); if (lampSplit(mat, g, lbl)) return; if (!groups.has(mat)) groups.set(mat, []); groups.get(mat).push(g); g.userData.label = lbl; };
    if (mats.length === 1 || !o.geometry.groups?.length) add(matFor(mats[0]), geo);
    else {
      const idx = geo.index.array;
      for (const gr of o.geometry.groups) {
        const sub = geo.clone();
        sub.setIndex(Array.from(idx.subarray(gr.start, gr.start + gr.count)));
        sub.clearGroups();
        add(matFor(mats[gr.materialIndex] || mats[0]), sub);
      }
    }
  });
  const parts = [];
  for (const [material, geos] of groups) {
    const geometry = mergeGeometries(geos, false);
    if (geometry) { geometry.computeBoundingSphere(); parts.push({ geometry, material }); }
  }
  const box = new THREE.Box3();
  for (const p of parts) { p.geometry.computeBoundingBox(); box.union(p.geometry.boundingBox); }
  // a model with no high-mounted brake light of its own (Tesla: at the top of the rear window; Dacia: above it, on
  // the tailgate spoiler): a slim strip of its own, found from the rear window's glass
  try { if (THIRD_AT[model] && !lampGroups.has('third')) synthThird(groups, lampGroups, anchors, THIRD_AT[model], halfL, carH); } catch (e) { console.warn('third brake light', name, e); }
  const lampParts = [];
  // (core: the light emitters themselves, by name: the brightest tier)
  // (glow: a share of the usual light, LAMP_RULES lens / glow)
  for (const [kind, map] of lampGroups) for (const [material, geos] of map) {
    const geometry = mergeGeometries(geos, false);
    if (!geometry) continue;
    geometry.computeBoundingSphere();
    const core = kind === 'drl' || geos.some((g) => /glow|emiss|drl|signature/i.test(g.userData.label || ''));
    lampParts.push({ kind, geometry, material, core, glow: (material.userData.glow ?? 1) * (core ? rule?.glow?.[kind] ?? 1 : 1) });
  }
  const halo = {};
  for (const [kind, sides] of anchors) halo[kind] = sides.filter(Boolean).map((b) => ({ c: b.min.clone().add(b.max).multiplyScalar(0.5), size: b.max.clone().sub(b.min) }));
  const t = { name, parts, size: box.getSize(new THREE.Vector3()), lod: null, wheels: null, body: null, lamps: { parts: lampParts, halo, halfL } };
  // the four wheels as their own pieces (for the cars that drive: they spin and the front ones steer)
  try { splitWheels(t, groups, name); } catch (e) { console.warn('car wheels', e); t.wheels = null; }
  cache.set(gltf, t);
  buildLod(t).catch(() => {});
  return t;
}

// Wheels: their centres from the meshes named like wheels / tyres / rims / brakes (else from the car's shape: the
// four lowest corners), then every triangle inside a wheel's cylinder goes to that wheel (centred on its axle), the
// rest stays the body. t.wheels = [{ c: centre, front, r, parts }], t.body = parts without the wheels.
const WHEEL = /wheel|tire|tyre|(?<!t)rim|break|brake|disk|disc|hub/i, NOT_WHEEL = /steer|int_sw|interior|int_|seat|trim/i;
function splitWheels(t, groups, name = '') {
  const S = t.size, L = S.z, W = S.x;
  const pieces = [];
  for (const [mat, geos] of groups) for (const g of geos) pieces.push({ mat, g });
  // centres: named wheel vertices per quadrant (x sign, z sign)
  const q = [0, 1, 2, 3].map(() => ({ min: new THREE.Vector3(Infinity, Infinity, Infinity), max: new THREE.Vector3(-Infinity, -Infinity, -Infinity), n: 0 }));
  const quad = (x, z) => (x < 0 ? 0 : 1) + (z < 0 ? 0 : 2);
  const v = new THREE.Vector3();
  for (const { g } of pieces) {
    const lab = g.userData.label || '';
    if (!WHEEL.test(lab) || NOT_WHEEL.test(lab)) continue;
    const P = g.attributes.position;
    for (let i = 0; i < P.count; i++) { v.fromBufferAttribute(P, i); if (v.y > L * 0.2 || Math.abs(v.x) < W / 2 - 0.55) continue; const b = q[quad(v.x, v.z)]; b.min.min(v); b.max.max(v); b.n++; }
  }
  // a wheel from the tyre's contact with the ground (no names needed): the lowest geometry at that corner, and how
  // long the patch of it within 12 cm of the bottom is (a circle's chord) gives the radius
  const fromGround = (k) => {
    const sx = k & 1 ? 1 : -1, sz = k & 2 ? 1 : -1;
    let y0 = Infinity;
    const inZone = (p) => Math.sign(p.x) === sx && Math.abs(p.x) > W / 2 - 0.5 && Math.sign(p.z) === sz && Math.abs(p.z) > L * 0.12 && Math.abs(p.z) < L * 0.5;
    for (const { g } of pieces) { const P = g.attributes.position; for (let i = 0; i < P.count; i++) { v.fromBufferAttribute(P, i); if (v.y < y0 && inZone(v)) y0 = v.y; } }
    if (!Number.isFinite(y0)) return null;
    const h = 0.12, bb = new THREE.Box3();
    for (const { g } of pieces) { const P = g.attributes.position; for (let i = 0; i < P.count; i++) { v.fromBufferAttribute(P, i); if (v.y < y0 + h && inZone(v)) bb.expandByPoint(v); } }
    if (bb.isEmpty()) return null;
    const e = (bb.max.z - bb.min.z) / 2, r = clamp((e * e + h * h) / (2 * h), 0.26, 0.46);
    return { c: new THREE.Vector3((bb.min.x + bb.max.x) / 2 - sx * 0.04, y0 + r, (bb.min.z + bb.max.z) / 2), r, hw: 0.17 };
  };
  const est = (k) => ({ x: (k & 1 ? 1 : -1) * (W / 2 - 0.29), z: k & 2 ? L / 2 - 0.19 * L : -(L / 2 - 0.21 * L) });
  const plausible = (c, r) => r > 0.25 && r < 0.47 && Math.abs(c.y - r) < 0.08 && Math.abs(c.x) > W / 2 - 0.55;
  const wheels = q.map((b, k) => {
    let c = null, r = 0, hw = 0, named = false;
    if (b.n > 30 && b.max.y - b.min.y > 0.3) {
      named = true;
      c = b.min.clone().add(b.max).multiplyScalar(0.5); r = Math.max(b.max.y - b.min.y, b.max.z - b.min.z) / 2; hw = Math.min(0.24, (b.max.x - b.min.x) / 2);
      if (!plausible(c, r)) { c = null; named = false; } // (something else named like a wheel: trims, the steering wheel...)
    }
    if (!c) { const f = fromGround(k); if (f && plausible(f.c, f.r)) ({ c, r, hw } = f); }
    if (!c) { const e = est(k); r = clamp(0.33 * (L / 4.6), 0.3, 0.38); c = new THREE.Vector3(e.x, r, e.z); hw = 0.14; }
    // found from the ground / guessed: the tyre's true outer radius, the furthest geometry round the hub in the lower
    // half (no body down there)
    if (!named) try {
      let rr = 0;
      const bottom = c.y - r;
      for (const { g } of pieces) {
        const P = g.attributes.position;
        for (let i = 0; i < P.count; i++) {
          v.fromBufferAttribute(P, i);
          if (v.y > c.y - 0.03 || Math.abs(v.x - c.x) > hw + 0.04 || Math.abs(v.z - c.z) > r * 1.3) continue;
          const dd = Math.hypot(v.y - c.y, v.z - c.z);
          if (dd < r * 1.3 && dd > rr) rr = dd;
        }
      }
      if (rr > r && rr < r * 1.25) { r = rr; c.y = Math.max(c.y, bottom + r); }
    } catch { /* (as found) */ }
    return { c, r, hw, front: !!(k & 2), groups: new Map() };
  });
  // the steering wheel: its own piece, centred on its hub (it turns with the steering when you drive). Named in some
  // models (Golf: Int_SW_*); in the rest, the separate bits of geometry lying in the wheel's disc (findSteering)
  const STEER = /steer|lenk|volant|int_sw/i;
  const sbox = new THREE.Box3();
  const byShape = STEER_BY_SHAPE.has(name.replace(/_full$/, '')); // (named, but only part of the wheel: found by its shape)
  if (!byShape) for (const { g } of pieces) if (STEER.test(g.userData.label || '')) { g.computeBoundingBox(); sbox.union(g.boundingBox); }
  let steerC = sbox.isEmpty() ? null : sbox.getCenter(new THREE.Vector3());
  let steerTri = null, steerAxis = null, steerTilt = 0.38, steerR = 0.185; // (unnamed: piece -> Set of its triangles that are the wheel)
  if (steerC) { const sz = sbox.getSize(new THREE.Vector3()); steerR = clamp(sz.x / 2, 0.16, 0.21); }
  if (!steerC && STEER_AT[name]) {
    try { const h = new THREE.Vector3(...STEER_AT[name]); h.exact = /tesla/.test(name); const f = findSteering(pieces, h); if (f) { steerC = f.c; steerTri = f.tri; steerAxis = f.axis; steerTilt = f.tilt; steerR = f.rimR; } } catch (e) { console.warn('steering wheel', name, e); }
  }
  const steerGroups = new Map();
  const keepPaint = KEEP_PAINT.has(name.replace(/_full$/, ''));
  // split every triangle: inside a wheel's cylinder (around its axle, x) -> that wheel, else the body
  const body = new Map();
  const a = new THREE.Vector3(), b2 = new THREE.Vector3(), c2 = new THREE.Vector3();
  const inWheel = (p) => {
    for (const w of wheels) if (Math.abs(p.x - w.c.x) < w.hw + 0.05 && Math.hypot(p.y - w.c.y, p.z - w.c.z) < w.r + 0.02) return w;
    return null;
  };
  for (const { mat, g } of pieces) {
    if (steerC && !steerTri && STEER.test(g.userData.label || '')) {
      const all = Array.from(g.index.array);
      if (!steerGroups.has(mat)) steerGroups.set(mat, []);
      steerGroups.get(mat).push(compact(g, all, steerC));
      continue;
    }
    const P = g.attributes.position, I = g.index.array, named = WHEEL.test(g.userData.label || '');
    const bodyOnly = keepPaint && isPaint(name.replace(/_full$/, ''), mat); // (the wheel arches' paint stays on the body)
    const lists = new Map(), st = steerTri?.get(g), sw = st ? [] : null;
    for (let i = 0; i < I.length; i += 3) {
      if (st && st.has(i)) { sw.push(I[i], I[i + 1], I[i + 2]); continue; }
      a.fromBufferAttribute(P, I[i]); b2.fromBufferAttribute(P, I[i + 1]); c2.fromBufferAttribute(P, I[i + 2]);
      const wa = inWheel(a);
      const w = wa && wa === inWheel(b2) && wa === inWheel(c2) && (named || (a.y < wa.c.y + wa.r && !bodyOnly)) ? wa : null;
      const key = w || body;
      if (!lists.has(key)) lists.set(key, []);
      lists.get(key).push(I[i], I[i + 1], I[i + 2]);
    }
    if (sw?.length) { if (!steerGroups.has(mat)) steerGroups.set(mat, []); steerGroups.get(mat).push(compact(g, sw, steerC)); }
    for (const [key, tri] of lists) {
      const sub = compact(g, tri, key === body ? null : key.c);
      const map = key === body ? body : key.groups;
      if (!map.has(mat)) map.set(mat, []);
      map.get(mat).push(sub);
    }
  }
  const merge = (map) => { const out = []; for (const [material, geos] of map) { const geometry = mergeGeometries(geos, false); if (geometry) { geometry.computeBoundingSphere(); out.push({ geometry, material }); } } return out; };
  t.body = merge(body);
  t.wheels = wheels.map((w) => ({ c: w.c, r: w.r, front: w.front, parts: merge(w.groups) })).filter((w) => w.parts.length);
  t.steering = steerC ? { c: steerC, parts: merge(steerGroups), axis: steerAxis || new THREE.Vector3(0, -Math.sin(steerTilt), Math.cos(steerTilt)), tilt: steerTilt, rimR: steerR } : null;
  const rings = HUB_RINGS[name.replace(/_full$/, '')];
  if (t.steering && rings) try { const p = hubRings(t.steering, rings); if (p) t.steering.parts.push(p); else console.warn('steering wheel rings: no badge', name); } catch (e) { console.warn('steering wheel rings', name, e); }
  if (t.wheels.length !== 4) {
    // no wheels found: the steering wheel (if any) goes back into the body
    if (t.steering) for (const p of t.steering.parts) { const g = p.geometry.clone(); g.translate(steerC.x, steerC.y, steerC.z); t.body.push({ geometry: g, material: p.material }); }
    t.wheels = null; t.steering = null; if (!t.body.length) t.body = null;
  }
}
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// Steering wheels with no name: where the wheel is (fitted frame, m), found from the driver's seat with a fan of rays
// (tools/carlab.html?mode=cockpit&detect=1) and checked by eye in the cockpit view.
const STEER_AT = {
  car_bmw_x3: [0.372, 1.07, 0.33], car_audi_rs6_full: [0.42, 0.95, 0.49], car_tesla_m3_full: [0.47, 0.81, 0.61], car_dacia_duster: [0.37, 1.02, 0.54],
  car_audi_rs6: [0.42, 0.95, 0.49], car_tesla_m3: [0.47, 0.81, 0.61], // (the simplified ones: the same frame as their full models)
  car_mercedes_sls: [0.43, 0.77, -0.11], car_porsche_taycan: [0.37, 0.88, 0.45],
};
// models whose steering wheel is named only in part (the SLS: INT_Skin_volante is the rim's leather; the spokes, hub
// and badge are other materials): found by its shape from STEER_AT instead, all of it
const STEER_BY_SHAPE = new Set(['car_mercedes_sls']);
// models whose wheel arches (paint) lie inside the tyres' cylinders: the paint never turns with a wheel
const KEEP_PAINT = new Set(['car_mercedes_sls', 'car_porsche_taycan']);
const COLUMN = new THREE.Vector3(0, -Math.sin(0.38), Math.cos(0.38)); // (the steering column: forward and down)
// Every separate bit of geometry (connected triangles) near the hint that lies wholly in the wheel's disc (round the
// column, a few cm thick): the rim, spokes, hub, buttons. Twice: the second time round the centre the first one found.
// -> { c: the hub, tri: Map(piece geometry -> Set of triangle offsets) } or null
function findSteering(pieces, hint) {
  const near = [];
  const v = new THREE.Vector3();
  for (const { g } of pieces) {
    const P = g.attributes.position, I = g.index.array;
    let tris = null;
    for (let i = 0; i < I.length; i += 3) {
      let close = false;
      for (let k = 0; k < 3 && !close; k++) { v.fromBufferAttribute(P, I[i + k]); close = v.distanceToSquared(hint) < 0.45 * 0.45; }
      if (close) (tris ||= []).push(i);
    }
    if (!tris) continue;
    // connected bits (vertices welded by position, so UV seams don't split a part)
    const id = new Map(), parent = [];
    const vid = (j) => { v.fromBufferAttribute(P, j); const k = `${Math.round(v.x * 4000)},${Math.round(v.y * 4000)},${Math.round(v.z * 4000)}`; let n = id.get(k); if (n === undefined) { n = parent.length; parent.push(n); id.set(k, n); } return n; };
    const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
    const tv = tris.map((i) => [vid(I[i]), vid(I[i + 1]), vid(I[i + 2])]);
    for (const [a, b, c] of tv) { const ra = find(a), rb = find(b), rc = find(c); parent[rb] = ra; parent[find(rc)] = ra; }
    const comps = new Map();
    tris.forEach((i, n) => { const r = find(tv[n][0]); if (!comps.has(r)) comps.set(r, []); comps.get(r).push(i); });
    for (const list of comps.values()) near.push({ g, list });
  }
  const pick = (c, rad, back, front) => {
    const out = [], box = new THREE.Box3(), d = new THREE.Vector3();
    for (const cp of near) {
      const P = cp.g.attributes.position, I = cp.g.index.array, b = new THREE.Box3();
      let ok = true;
      for (const i of cp.list) {
        for (let k = 0; k < 3; k++) {
          v.fromBufferAttribute(P, I[i + k]); b.expandByPoint(v);
          d.copy(v).sub(c);
          const along = d.dot(COLUMN), radial = d.addScaledVector(COLUMN, -along).length();
          if (radial > rad || along < -back || along > front) { ok = false; break; }
        }
        if (!ok) break;
      }
      if (ok) { out.push(cp); box.union(b); }
    }
    return { out, box };
  };
  // 1. the rim: the separate bits wholly in a disc round the hint (twice: round what the first pass found)
  let { out, box } = pick(hint, 0.25, 0.13, 0.1);
  let c = hint.clone(), rimR = 0.185, rimFound = false;
  if (out.length) {
    const c1 = box.getCenter(new THREE.Vector3());
    ({ out, box } = pick(c1, 0.215, 0.09, 0.08));
    const sz = box.getSize(new THREE.Vector3());
    if (out.length && sz.x > 0.3 && sz.x < 0.46 && sz.y > 0.22) { c = box.getCenter(new THREE.Vector3()); rimR = sz.x / 2; rimFound = true; }
  }
  // 2. the column's tilt: the wheel is a disc, thinnest along the column (fitted on the geometry round the centre)
  const pts = [];
  for (const cp of near) {
    const P = cp.g.attributes.position, I = cp.g.index.array;
    for (const i of cp.list) for (let k = 0; k < 3; k++) {
      v.fromBufferAttribute(P, I[i + k]);
      const dx = v.x - c.x, dy = v.y - c.y, dz = v.z - c.z;
      if (Math.abs(dx) < rimR + 0.02 && Math.hypot(dx, dy, dz) < rimR + 0.03) pts.push(dy, dz);
    }
  }
  let tilt = 0.38;
  if (pts.length > 60) {
    let best = Infinity;
    for (let th = 0.25; th <= 0.55; th += 0.01) { // (real steering columns: 15-30 degrees)
      const ay = -Math.sin(th), az = Math.cos(th);
      let m = 0, m2 = 0, n = 0;
      for (let i = 0; i < pts.length; i += 2) { const a = pts[i] * ay + pts[i + 1] * az; m += a; m2 += a * a; n++; }
      const varA = m2 / n - (m / n) ** 2;
      if (varA < best) { best = varA; tilt = th; }
    }
  }
  const A = new THREE.Vector3(0, -Math.sin(tilt), Math.cos(tilt));
  // 3. the whole wheel: every triangle in that disc, from the airbag cap on your side to just behind the rim (the
  // spokes, hub, badge, buttons); the column and the dash behind stay put. With no rim found, centred again on what
  // it took (a hint a few cm out still finds the wheel)
  const d = new THREE.Vector3();
  const grab = (cc) => {
    const tri = new Map(), bb = new THREE.Box3();
    let nTri = 0;
    for (const cp of near) {
      const P = cp.g.attributes.position, I = cp.g.index.array;
      for (const i of cp.list) {
        let ok = true;
        for (let k = 0; k < 3 && ok; k++) {
          v.fromBufferAttribute(P, I[i + k]);
          d.copy(v).sub(cc);
          const along = d.dot(A), radial = d.addScaledVector(A, -along).length();
          ok = radial <= rimR + 0.02 && along > -0.15 && along < 0.05;
        }
        if (!ok) continue;
        if (!tri.has(cp.g)) tri.set(cp.g, new Set());
        tri.get(cp.g).add(i); nTri++;
        for (let k = 0; k < 3; k++) bb.expandByPoint(v.fromBufferAttribute(P, I[i + k]));
      }
    }
    return { tri, nTri, bb };
  };
  if (!rimFound && !hint.exact) {
    // no rim on its own: search round the hint for where most geometry lies on a rim-sized ring in the wheel's plane
    const U = new THREE.Vector3(0, Math.cos(tilt), Math.sin(tilt)), verts = [];
    for (const cp of near) { const P = cp.g.attributes.position, I = cp.g.index.array; for (const i of cp.list) { v.fromBufferAttribute(P, I[i]); if (v.distanceToSquared(hint) < 0.42 * 0.42) verts.push(v.x, v.y, v.z); } }
    let best = -1, bc = c.clone();
    const cand = new THREE.Vector3();
    for (let dx = -0.15; dx <= 0.151; dx += 0.03) for (let du = -0.12; du <= 0.121; du += 0.03) for (let da = -0.16; da <= 0.161; da += 0.02) {
      cand.copy(hint).add(new THREE.Vector3(dx, 0, 0)).addScaledVector(U, du).addScaledVector(A, da);
      let score = 0;
      for (let i = 0; i < verts.length; i += 3) {
        const ex = verts[i] - cand.x, ey = verts[i + 1] - cand.y, ez = verts[i + 2] - cand.z;
        const al = ey * A.y + ez * A.z;
        if (al > 0.03 || al < -0.03) continue;
        const ry = ey - A.y * al, rz = ez - A.z * al, rad = Math.sqrt(ex * ex + ry * ry + rz * rz);
        if (rad > 0.15 && rad < 0.205) score++;
      }
      if (score > best) { best = score; bc.copy(cand); }
    }
    c.copy(bc); rimR = 0.19;
  }
  let { tri, nTri, bb } = grab(c);
  if (!rimFound && false) for (let it = 0; it < 2 && nTri > 20; it++) {
    const s2 = bb.getSize(new THREE.Vector3()), c2 = bb.getCenter(new THREE.Vector3());
    c.set(c2.x, c2.y, c2.z); rimR = clamp(Math.max(s2.x, s2.y) / 2, 0.16, 0.21);
    ({ tri, nTri, bb } = grab(c));
  }
  if (nTri < 40) { console.warn('steering wheel: nothing in the disc'); return null; }
  return { c, tri, axis: A, tilt, rimR };
}
// The four rings on the hub (HUB_RINGS): each ring's centre found on the badge decal by its UV (the triangle holding
// it, barycentric), its plane and size from that triangle's UV -> position map; a flattened chrome torus there, a hair
// proud of the decal (toward the driver). -> { geometry, material } in the steering wheel's frame, or null.
let ringsMat = null;
function hubRings(S, spec) {
  const out = [];
  const pa = new THREE.Vector3(), pb = new THREE.Vector3(), pc = new THREE.Vector3(), du = new THREE.Vector3(), dv = new THREE.Vector3();
  for (const v0 of spec.v) {
    const u0 = spec.u;
    let hit = null;
    for (const part of S.parts) {
      if (!spec.mat.test(part.material.name || '')) continue;
      const g = part.geometry, P = g.attributes.position, U = g.attributes.uv, I = g.index.array;
      for (let i = 0; i < I.length && !hit; i += 3) {
        const a = I[i], b = I[i + 1], c = I[i + 2];
        const ua = U.getX(a), va = U.getY(a), ub = U.getX(b) - ua, vb = U.getY(b) - va, uc = U.getX(c) - ua, vc = U.getY(c) - va;
        const det = ub * vc - uc * vb;
        if (Math.abs(det) < 1e-9) continue;
        // (u0, v0) = a + s (b - a) + r (c - a), in UV
        const s = ((u0 - ua) * vc - uc * (v0 - va)) / det, r = (ub * (v0 - va) - (u0 - ua) * vb) / det;
        if (s < -1e-4 || r < -1e-4 || s + r > 1 + 1e-4) continue;
        pa.fromBufferAttribute(P, a); pb.fromBufferAttribute(P, b).sub(pa); pc.fromBufferAttribute(P, c).sub(pa);
        // the position's derivatives along u and v (the inverse of the UV map)
        du.copy(pb).multiplyScalar(vc / det).addScaledVector(pc, -vb / det);
        dv.copy(pc).multiplyScalar(ub / det).addScaledVector(pb, -uc / det);
        hit = { at: pa.clone().addScaledVector(pb, s).addScaledVector(pc, r), du: du.clone(), dv: dv.clone() };
      }
    }
    if (!hit) return null;
    const n = new THREE.Vector3().crossVectors(hit.dv, hit.du).normalize();
    if (n.dot(S.axis) > 0) n.negate(); // (toward the driver: the column's axis points away)
    const ex = hit.dv.clone().addScaledVector(n, -hit.dv.dot(n)).normalize(), ey = new THREE.Vector3().crossVectors(n, ex);
    const k = (hit.du.length() + hit.dv.length()) / 2, R = spec.r * k, tube = spec.tube * k;
    const geo = new THREE.TorusGeometry(R, tube, 8, 48);
    geo.scale(1, 1, 0.6); // (a badge: a little flatter than round)
    geo.applyMatrix4(new THREE.Matrix4().makeBasis(ex, ey, n).setPosition(hit.at.clone().addScaledVector(n, tube * 0.75)));
    out.push(geo);
  }
  ringsMat ||= new THREE.MeshStandardMaterial({ name: 'hub_rings_chrome', color: 0xe4e7eb, metalness: 1, roughness: 0.2 });
  const geometry = mergeGeometries(out, false);
  geometry.computeBoundingSphere();
  return { geometry, material: ringsMat };
}

// a new geometry with just these triangles (vertices compacted), moved so `origin` is at 0 (a wheel's axle)
function compact(g, tri, origin) {
  const map = new Map(), P = g.attributes.position, N = g.attributes.normal, U = g.attributes.uv;
  const pos = [], nor = [], uv = [], idx = [];
  for (const i of tri) {
    let j = map.get(i);
    if (j === undefined) {
      j = map.size; map.set(i, j);
      pos.push(P.getX(i) - (origin ? origin.x : 0), P.getY(i) - (origin ? origin.y : 0), P.getZ(i) - (origin ? origin.z : 0));
      nor.push(N.getX(i), N.getY(i), N.getZ(i)); uv.push(U.getX(i), U.getY(i));
    }
    idx.push(j);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  out.setIndex(idx);
  return out;
}

// Smooth normals from the faces themselves, with a crease: each corner takes the area-weighted normals of the faces
// round its point (every vertex there, split or not) that bend less than `cos` from its own face (orientation from
// `nrm`, the old normals, where given: double-sided parts with flipped winding stay lit on the right side); a vertex
// whose corners disagree is split. Indexed out (the merging, wheel and lamp splits need it); `carry`: per-vertex
// arrays copied along ({ a, n }). -> { pos, nor, idx, carry }
const CREASE = Math.cos(THREE.MathUtils.degToRad(45));
function creased(pos, idx, nrm, carry = [], cos = CREASE, weld = 1e4) {
  const nv = pos.length / 3, nt = (idx.length / 3) | 0, pid = new Int32Array(nv), at = new Map();
  let np = 0;
  for (let v = 0; v < nv; v++) {
    const k = ((Math.round(pos[3 * v] * weld) + 65536) * 131072 + Math.round(pos[3 * v + 1] * weld) + 65536) * 131072 + Math.round(pos[3 * v + 2] * weld) + 65536;
    let p = at.get(k); if (p === undefined) { p = np++; at.set(k, p); } pid[v] = p;
  }
  const fn = new Float32Array(nt * 3), fu = new Float32Array(nt * 3), start = new Int32Array(np + 1), list = new Int32Array(nt * 3);
  for (let f = 0; f < nt; f++) {
    const a = 3 * idx[3 * f], b = 3 * idx[3 * f + 1], c = 3 * idx[3 * f + 2];
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2], vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    let x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
    if (nrm) { // (facing the way its old normals say, where they clearly disagree with the winding)
      let d = 0; for (let k = 0; k < 3; k++) { const j = 3 * idx[3 * f + k]; d += x * nrm[j] + y * nrm[j + 1] + z * nrm[j + 2]; }
      if (d < -0.3 * Math.hypot(x, y, z) * 3) { x = -x; y = -y; z = -z; }
    }
    const l = Math.hypot(x, y, z) || 1;
    fn[3 * f] = x; fn[3 * f + 1] = y; fn[3 * f + 2] = z; fu[3 * f] = x / l; fu[3 * f + 1] = y / l; fu[3 * f + 2] = z / l;
    for (let k = 0; k < 3; k++) start[pid[idx[3 * f + k]] + 1]++;
  }
  for (let p = 0; p < np; p++) start[p + 1] += start[p];
  const fill = start.slice(0, np);
  for (let f = 0; f < nt; f++) for (let k = 0; k < 3; k++) list[fill[pid[idx[3 * f + k]]]++] = f;
  const out = new Map(), P = [], N = [], I = [], C = carry.map(() => []);
  for (let f = 0; f < nt; f++) for (let k = 0; k < 3; k++) {
    const v = idx[3 * f + k], p = pid[v];
    let x = 0, y = 0, z = 0;
    for (let i = start[p]; i < start[p + 1]; i++) { const g = list[i]; if (fu[3 * f] * fu[3 * g] + fu[3 * f + 1] * fu[3 * g + 1] + fu[3 * f + 2] * fu[3 * g + 2] >= cos) { x += fn[3 * g]; y += fn[3 * g + 1]; z += fn[3 * g + 2]; } }
    let l = Math.hypot(x, y, z);
    if (!l) { if (nrm) { x = nrm[3 * v]; y = nrm[3 * v + 1]; z = nrm[3 * v + 2]; } else y = 1; l = Math.hypot(x, y, z) || 1; } // (a sliver: its old normal)
    x /= l; y /= l; z /= l;
    const key = v * 16777216 + (Math.round(x * 127) + 127) * 65536 + (Math.round(y * 127) + 127) * 256 + Math.round(z * 127) + 127;
    let j = out.get(key);
    if (j === undefined) {
      j = P.length / 3; out.set(key, j);
      P.push(pos[3 * v], pos[3 * v + 1], pos[3 * v + 2]); N.push(x, y, z);
      for (const [c, { a, n }] of carry.entries()) for (let q = 0; q < n; q++) C[c].push(a[n * v + q]);
    }
    I.push(j);
  }
  return { pos: new Float32Array(P), nor: new Float32Array(N), idx: I, carry: C };
}

// A mesh whose normals stray far from its faces (> 45 deg at one corner in 20: models decimated with their high-res
// normals kept, which shade them in dark blotches and lumps) gets creased smooth normals of its own instead.
function fixNormals(geo) {
  const P = geo.attributes.position.array, N = geo.attributes.normal.array, I = geo.index.array;
  if (I.length < 60) return;
  let off = 0;
  for (let i = 0; i < I.length; i += 3) {
    const a = 3 * I[i], b = 3 * I[i + 1], c = 3 * I[i + 2];
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx, l = Math.hypot(x, y, z);
    if (!l) continue;
    for (const j of [a, b, c]) if (Math.abs(x * N[j] + y * N[j + 1] + z * N[j + 2]) < 0.7 * l * Math.hypot(N[j], N[j + 1], N[j + 2])) off++;
  }
  if (off < I.length * 0.05) return;
  const r = creased(P, I, N, [{ a: geo.attributes.uv.array, n: 2 }]);
  geo.setAttribute('position', new THREE.BufferAttribute(r.pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(r.nor, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(r.carry[0]), 2));
  geo.setIndex(r.idx);
}

// a texture's mean colour (linear; alpha-weighted), for the far LOD's vertex colours: a tyre is white x its dark map
const meanCache = new WeakMap();
function meanColour(tex) {
  if (!tex?.image || typeof document === 'undefined') return null;
  if (meanCache.has(tex)) return meanCache.get(tex);
  let out = null;
  try {
    const c = document.createElement('canvas'); c.width = c.height = 16;
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(tex.image, 0, 0, 16, 16);
    const d = g.getImageData(0, 0, 16, 16).data;
    let r = 0, gg = 0, b = 0, w = 0;
    for (let i = 0; i < d.length; i += 4) { const a = d[i + 3]; r += d[i] * a; gg += d[i + 1] * a; b += d[i + 2] * a; w += a; }
    if (w) out = new THREE.Color().setRGB(r / w / 255, gg / w / 255, b / w / 255, THREE.SRGBColorSpace);
  } catch { /* (an image the canvas can't read: the plain colour) */ }
  meanCache.set(tex, out);
  return out;
}

// The far LOD: every part, lamps and glass too (the windows as dark solid panes: no see-through shell), welded into
// one surface (separate panels and seams no longer tear open when edges collapse), decimated to ~12k triangles,
// creased smooth normals; vertex-coloured by each material's colour x its texture's mean; the body paint its own
// group, so each car keeps its own colour out there (farMesh).
async function buildLod(t) {
  await MeshoptSimplifier.ready;
  const model = (t.name || '').replace(/_full$/, '');
  const pos = [], col = [], pnt = [], idx = [];
  let base = 0;
  for (const p of [...t.parts, ...(t.lamps?.parts || [])]) {
    if (/plate|licen|nomera|kennz/i.test(p.material.name || '') && !/light|lamp|glow/i.test(p.material.name || '')) continue; // (the model's own plate: not on the far car)
    const g = p.geometry, P = g.attributes.position, I = g.index.array;
    const c = (p.material.color || new THREE.Color(0x777777)).clone(), m = meanColour(p.material.map);
    if (m) c.multiply(m);
    const paint = isPaint(model, p.material) ? 1 : 0;
    for (let i = 0; i < P.count; i++) { pos.push(P.getX(i), P.getY(i), P.getZ(i)); col.push(c.r, c.g, c.b); pnt.push(paint); }
    for (let i = 0; i < I.length; i++) idx.push(I[i] + base);
    base += P.count;
  }
  if (!idx.length) return;
  // welded (1 mm): one point per spot, its colour the area-weighted mean of the faces round it, paint by majority
  const nv = pos.length / 3, pid = new Int32Array(nv), at = new Map(), wpos = [], wsum = [];
  for (let v = 0; v < nv; v++) {
    const k = ((Math.round(pos[3 * v] * 1e3) + 65536) * 131072 + Math.round(pos[3 * v + 1] * 1e3) + 65536) * 131072 + Math.round(pos[3 * v + 2] * 1e3) + 65536;
    let q = at.get(k); if (q === undefined) { q = wpos.length / 3; at.set(k, q); wpos.push(pos[3 * v], pos[3 * v + 1], pos[3 * v + 2]); wsum.push(0, 0, 0, 0, 0); } pid[v] = q;
  }
  const widx = [];
  for (let i = 0; i < idx.length; i += 3) {
    const a = pid[idx[i]], b = pid[idx[i + 1]], c = pid[idx[i + 2]];
    if (a === b || b === c || a === c) continue;
    widx.push(a, b, c);
    const ux = wpos[3 * b] - wpos[3 * a], uy = wpos[3 * b + 1] - wpos[3 * a + 1], uz = wpos[3 * b + 2] - wpos[3 * a + 2], vx = wpos[3 * c] - wpos[3 * a], vy = wpos[3 * c + 1] - wpos[3 * a + 1], vz = wpos[3 * c + 2] - wpos[3 * a + 2];
    const ar = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) + 1e-9;
    for (let k = 0; k < 3; k++) { const v = idx[i + k], s = 5 * pid[v]; wsum[s] += col[3 * v] * ar; wsum[s + 1] += col[3 * v + 1] * ar; wsum[s + 2] += col[3 * v + 2] * ar; wsum[s + 3] += ar; wsum[s + 4] += pnt[v] * ar; }
  }
  const W = wpos.length / 3, wcol = new Float32Array(W * 3), wpnt = new Float32Array(W);
  for (let q = 0; q < W; q++) { const s = 5 * q, a = wsum[s + 3] || 1; wcol[3 * q] = wsum[s] / a; wcol[3 * q + 1] = wsum[s + 1] / a; wcol[3 * q + 2] = wsum[s + 2] / a; wpnt[q] = wsum[s + 4] / a > 0.5 ? 1 : 0; }
  const positions = new Float32Array(wpos), indices = new Uint32Array(widx);
  MeshoptSimplifier.useExperimentalFeatures = true; // (Prune: the tiny loose bits go first)
  let simple = indices;
  for (const err of [0.008, 0.016, 0.03]) { // (as close as ~12k triangles allow; a coarser bound only if they don't)
    [simple] = MeshoptSimplifier.simplify(indices, positions, 3, Math.min(indices.length, 12000 * 3), err, ['Prune']);
    if (simple.length <= 16000 * 3) break;
  }
  const r = creased(positions, simple, null, [{ a: wcol, n: 3 }, { a: wpnt, n: 1 }], CREASE, 1e3);
  // the paint's triangles first (group 0: the car's own paint), the rest after (group 1: vertex colours)
  const pf = r.carry[1], tri = [[], []];
  for (let i = 0; i < r.idx.length; i += 3) tri[pf[r.idx[i]] + pf[r.idx[i + 1]] + pf[r.idx[i + 2]] >= 2 ? 0 : 1].push(r.idx[i], r.idx[i + 1], r.idx[i + 2]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(r.pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(r.nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(r.carry[0]), 3));
  g.setIndex(tri[0].concat(tri[1]));
  g.addGroup(0, tri[0].length, 0); g.addGroup(tri[0].length, tri[1].length, 1);
  g.computeBoundingSphere();
  const pm = t.parts.find((p) => isPaint(model, p.material))?.material;
  const paint = new THREE.MeshStandardMaterial({ color: pm?.color?.clone().multiply(meanColour(pm.map) || new THREE.Color(1, 1, 1)) || 0x888888, roughness: 0.32, metalness: 0.35 });
  t.lod = { geometry: g, material: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.15 }), paint, tints: new Map() };
}

/** The far LOD mesh for a car instance (its own paint colour), or null while the LOD is still being built. */
export function farMesh(t, inst = null) {
  if (!t.lod) return null;
  const c = inst?.paint ?? null;
  if (c !== null && !t.lod.tints.has(c)) { const m = t.lod.paint.clone(); m.color = new THREE.Color(c); t.lod.tints.set(c, m); }
  return new THREE.Mesh(t.lod.geometry, [c === null ? t.lod.paint : t.lod.tints.get(c), t.lod.material]);
}

/** The driver's eye in the car's frame (left-hand drive: the left front seat, +x), behind the steering wheel. */
export function driverEye(t) {
  const S = t.size;
  if (t.steering) { const c = t.steering.c; return new THREE.Vector3(c.x, Math.min(S.y - 0.24, c.y + 0.27), c.z - 0.6); }
  return new THREE.Vector3(Math.min(0.4, S.x * 0.2), Math.min(1.36, S.y - 0.32), -S.z * 0.04);
}

/** A car from its template: { group, full (detailed), far (LOD, may arrive later) }. */
export function carInstance(t, { paint = null, wheels = false } = {}) {
  const group = new THREE.Group(), full = new THREE.Group();
  let tinted = null;
  const glass = [];
  const spin = wheels && t.wheels && t.body;
  for (const p of spin ? t.body : t.parts) {
    let mat = p.material;
    // a different paint colour for this one (the body paint material, tinted; textures keep their detail)
    if (paint !== null && isPaint((t.name || '').replace(/_full$/, ''), mat)) { tinted ||= mat.clone(); tinted.color = new THREE.Color(paint); mat = tinted; }
    const m = new THREE.Mesh(p.geometry, mat);
    m.castShadow = !p.material.transparent && !p.material.userData.cutout; m.receiveShadow = true;
    if (p.material.transparent && p.material.opacity < 0.6) glass.push(m); // (the windows: drive.js clears them from inside)
    full.add(m);
  }
  // the wheels: each pivots on its axle (spin about x), the front ones in a steering pivot (about y)
  const wl = [];
  if (spin) {
    for (const w of t.wheels) {
      const steer = new THREE.Group(); steer.position.copy(w.c);
      const roll = new THREE.Group(); steer.add(roll);
      for (const p of w.parts) { const m = new THREE.Mesh(p.geometry, p.material); m.castShadow = true; roll.add(m); }
      full.add(steer);
      wl.push({ steer, roll, front: w.front, r: w.r });
    }
  }
  // the steering wheel on its column (turned about the column's axis, which leans forward and down)
  let steering = null;
  if (spin && t.steering?.parts.length) {
    const hub = new THREE.Group(); hub.position.copy(t.steering.c);
    const col = new THREE.Group(); hub.add(col);
    for (const p of t.steering.parts) col.add(new THREE.Mesh(p.geometry, p.material));
    full.add(hub);
    steering = { col, axis: t.steering.axis ? t.steering.axis.clone() : new THREE.Vector3(0, -Math.sin(0.38), Math.cos(0.38)) };
  }
  // the lamps: their own materials per car (carlights.js lampsOn), in tiers for depth: the LED / DRL cores (what
  // glowed in the model itself, or named so) brightest, the textured lamp graphics next (their own texture glowing:
  // the real car's light signature), plain lenses only catching the light. Halos: carlights.js, made on first use.
  const lamps = { list: [], kinds: new Set(), halo: t.lamps?.halo || {}, halfL: t.lamps?.halfL || t.size.z / 2, full, key: '' };
  for (const p of t.lamps?.parts || []) {
    const src = p.material;
    let m = src.clone();
    if (!m.emissive) m = new THREE.MeshStandardMaterial({ color: m.color || 0xffffff, map: m.map || null, transparent: m.transparent, opacity: m.opacity ?? 1, depthWrite: m.depthWrite });
    const orig = src.userData?.emOrig, nm = src.name || '';
    const core = p.core || !!orig || /drl|led|glow|emiss|signature/i.test(nm);
    m.emissive.set(0x000000); m.emissiveIntensity = 0;
    m.emissiveMap = orig?.map || m.map || null; // (fixed now: switching on never recompiles)
    const tier = core ? 'core' : m.emissiveMap ? 'tex' : 'plain';
    const mesh = new THREE.Mesh(p.geometry, m);
    mesh.castShadow = false; mesh.receiveShadow = !m.transparent;
    full.add(mesh);
    // (see-through lamp glass shows only its opacity's share of the glow: made up for)
    // (and some lamps take less: p.glow, from LAMP_RULES lens / glow)
    lamps.list.push({ m, kind: p.kind, tier, boost: (m.transparent ? 1 / Math.max(0.12, m.opacity ?? 1) : 1) * (p.glow ?? 1) });
    lamps.kinds.add(p.kind);
  }
  group.add(full);
  return { group, full, far: null, wheels: wl, steering, glass, lamps, paint };
}
