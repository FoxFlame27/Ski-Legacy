// Car models (the user's own, in MODEL_LIST) turned into game-ready templates, shared by every car of that model:
// the many meshes merged into one per material (a few dozen draw calls instead of hundreds), transmission glass
// replaced by plain tinted glass (transmission costs a whole extra render pass), lights off, front toward +z, and a
// decimated far LOD (one mesh, vertex-coloured, a few thousand triangles; built once meshoptimizer has loaded).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshoptSimplifier } from 'meshoptimizer';
import { fitModel, dequantize } from '../core/assets.js';

/** Car models: [model name, real length (m)]. Add a car here (and to MODEL_LIST) and it parks / drives too. */
export const CAR_MODELS = [['car_bmw_x3', 4.7], ['car_audi_rs6', 5.0], ['car_vw_golf_gti', 4.3], ['car_tesla_m3', 4.7]];

const cache = new Map();

/** @returns {{ parts: {geometry, material}[], size: THREE.Vector3, lod: {geometry, material}|null }} */
// real sizes (m): length, width, height (the models are fitted by length, the rest is checked and logged)
export const REAL = {
  car_bmw_x3: [4.71, 1.89, 1.68], car_audi_rs6: [4.99, 1.95, 1.46], car_vw_golf_gti: [4.29, 1.79, 1.46],
  car_tesla_m3: [4.69, 1.85, 1.44], car_dacia_duster: [4.34, 1.80, 1.69],
};
const JUNK = /plane|ground|shadow|floor|backdrop|base_?plate|studio/i;
const REAR = /tail|rear|back_?light|red_?gla|red_?light|glow_red|reflector/i, FRONT = /head|front_?light|front/i;
// Which way each model's nose points as it comes in, checked by eye (tools/carlab.html?mode=raw: grille and headlights
// at the +z arrow, the Dacia's at +x): the turn about y that brings the nose to +z. The simplified, full-detail, parked,
// traffic and far-LOD versions all come from this. A car not listed here falls back to a guess (lights, longest side).
export const FACING = {
  car_bmw_x3: 0, car_audi_rs6: 0, car_audi_rs6_full: 0, car_vw_golf_gti: 0, car_vw_golf_gti_full: 0,
  car_tesla_m3: 0, car_tesla_m3_full: 0, car_dacia_duster: -Math.PI / 2,
};

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
  car_dacia_duster: {
    test: /Headlight|Taillight/i,
    kind: (l, p) => /Headlight/i.test(l) ? (p.front ? 'head' : null) : /Taillight/i.test(l) ? (p.rear && !p.low ? 'tail' : null) : null,
  },
};
// Materials drawn as cut-outs (opaque, depth-written, alpha-tested) instead of blended. The RS6's whole cabin is one
// textured material marked alpha BLEND (for its decals: stitching, button labels), so it came in transparent with no
// depth writes: the steering wheel's airbag and spokes were drawn over by whatever lay behind them (the column, the
// instrument cluster) and looked see-through. Its texture's alpha is either solid or a cut-out, so a cut-out is exact.
const CUTOUT = { car_audi_rs6: /InteriorA_Material/i };
// The four rings on the steering wheel's airbag (RS6): the model's own badge there is a dark decal on the black hub,
// lost in it, where the real car's are chrome. Four thin chrome tori laid exactly on that decal, from its UV layout
// (the badge texture draws the rings stacked down its right-hand column): u, v of each ring's centre, the ring's radius
// and the tube's (texture units). They are part of the steering wheel, so they turn with it.
const HUB_RINGS = { car_audi_rs6: { mat: /BadgeA_Material/i, u: 0.809, v: [0.18, 0.391, 0.602, 0.813], r: 0.152, tube: 0.021 } };
// no high-mounted brake light in the model: where to add one (the rear window's glass)
const THIRD_AT = { car_tesla_m3: { glass: /glassDark/i, at: 'window' }, car_dacia_duster: { glass: /Foglight/i, at: 'spoiler' } };
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
  m.traverse((o) => { if (o.isMesh && JUNK.test(`${o.name} ${[].concat(o.material).map((x) => x?.name).join(' ')}`)) junk.push(o); });
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
    if (!glass && m.transparent && CUTOUT[model]?.test(m.name || '')) {
      // (a cut-out: solid where its texture is, holes where it isn't; casts no shadow, as before)
      if (out === m) out = m.clone();
      out.transparent = false; out.depthWrite = true; out.alphaTest = 0.5; out.userData.cutout = true;
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
  const t = { parts, size: box.getSize(new THREE.Vector3()), lod: null, wheels: null, body: null, lamps: { parts: lampParts, halo, halfL } };
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
  for (const { g } of pieces) if (STEER.test(g.userData.label || '')) { g.computeBoundingBox(); sbox.union(g.boundingBox); }
  let steerC = sbox.isEmpty() ? null : sbox.getCenter(new THREE.Vector3());
  let steerTri = null, steerAxis = null, steerTilt = 0.38, steerR = 0.185; // (unnamed: piece -> Set of its triangles that are the wheel)
  if (steerC) { const sz = sbox.getSize(new THREE.Vector3()); steerR = clamp(sz.x / 2, 0.16, 0.21); }
  if (!steerC && STEER_AT[name]) {
    try { const h = new THREE.Vector3(...STEER_AT[name]); h.exact = /tesla/.test(name); const f = findSteering(pieces, h); if (f) { steerC = f.c; steerTri = f.tri; steerAxis = f.axis; steerTilt = f.tilt; steerR = f.rimR; } } catch (e) { console.warn('steering wheel', name, e); }
  }
  const steerGroups = new Map();
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
    const lists = new Map(), st = steerTri?.get(g), sw = st ? [] : null;
    for (let i = 0; i < I.length; i += 3) {
      if (st && st.has(i)) { sw.push(I[i], I[i + 1], I[i + 2]); continue; }
      a.fromBufferAttribute(P, I[i]); b2.fromBufferAttribute(P, I[i + 1]); c2.fromBufferAttribute(P, I[i + 2]);
      const wa = inWheel(a);
      const w = wa && wa === inWheel(b2) && wa === inWheel(c2) && (named || a.y < wa.c.y + wa.r) ? wa : null;
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
};
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

// the far LOD: every part in one vertex-coloured mesh, decimated to a few thousand triangles
async function buildLod(t) {
  await MeshoptSimplifier.ready;
  const pos = [], nor = [], col = [], idx = [];
  let base = 0;
  for (const p of t.parts) {
    if (p.material.transparent && p.material.opacity < 0.6) continue; // (glass: the dark body shows through anyway)
    const g = p.geometry, P = g.attributes.position, N = g.attributes.normal, I = g.index.array;
    const c = p.material.color || new THREE.Color(0x777777);
    for (let i = 0; i < P.count; i++) { pos.push(P.getX(i), P.getY(i), P.getZ(i)); nor.push(N.getX(i), N.getY(i), N.getZ(i)); col.push(c.r, c.g, c.b); }
    for (let i = 0; i < I.length; i++) idx.push(I[i] + base);
    base += P.count;
  }
  if (!idx.length) return;
  const positions = new Float32Array(pos), indices = new Uint32Array(idx);
  const target = Math.min(indices.length, 6000 * 3);
  const [simple] = MeshoptSimplifier.simplify(indices, positions, 3, target - (target % 3), 0.05, []);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
  g.setIndex(new THREE.BufferAttribute(simple, 1));
  g.computeBoundingSphere();
  t.lod = { geometry: g, material: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.2 }) };
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
    if (paint !== null && /paint/i.test(mat.name || '') && !mat.transparent) { tinted ||= mat.clone(); tinted.color = new THREE.Color(paint); mat = tinted; }
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
  return { group, full, far: null, wheels: wl, steering, glass, lamps };
}
