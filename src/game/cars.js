// Car models (the user's own, in MODEL_LIST) turned into game-ready templates, shared by every car of that model:
// the many meshes merged into one per material (a few dozen draw calls instead of hundreds), transmission glass
// replaced by plain tinted glass (transmission costs a whole extra render pass), lights off, front toward +z, and a
// decimated far LOD (one mesh, vertex-coloured, a few thousand triangles; built once meshoptimizer has loaded).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshoptSimplifier } from 'meshoptimizer';
import { fitModel, dequantize } from '../core/assets.js';

/** Car models: [model name, real length (m)]. Add a car here (and to MODEL_LIST) and it parks / drives too. */
export const CAR_MODELS = [['car_bmw_x3', 4.7], ['car_audi_rs6', 5.0], ['car_vw_golf_gti', 4.3], ['car_tesla_m3', 4.7], ['car_mercedes_sls', 4.64], ['car_porsche_taycan', 4.96], ['car_lamborghini_huracan', 4.52], ['car_toyota_gr_yaris', 3.99], ['car_audi_etron_gt', 4.96], ['car_mercedes_gls', 5.2]];
// rare in the traffic and the car parks (the supercars: one in a while, not one in seven)
export const CAR_RARE = new Set(['car_mercedes_sls', 'car_porsche_taycan', 'car_lamborghini_huracan', 'car_toyota_gr_yaris']);
// spawn chances in the traffic and the car parks, per car spawned (Oct 29, the user's exact rates): the Huracán 1 in
// 240, the SLS 1 in 225, the GR Yaris 1 in 80, the GLS 1 in 50, the Taycan 1 in 40, the RS6 and the e-tron GT 1 in 25
// each, the X3 15 %; the Golf GTI and the Model 3 share the rest evenly (35.2 % each). pickCar() draws by these
// (normalised over the models given, so it still works with one missing)
const W_FIXED = {
  car_lamborghini_huracan: 1 / 240, car_mercedes_sls: 1 / 225, car_toyota_gr_yaris: 1 / 80, car_mercedes_gls: 1 / 50,
  car_porsche_taycan: 1 / 40, car_audi_rs6: 1 / 25, car_audi_etron_gt: 1 / 25, car_bmw_x3: 0.15,
};
const W_REST = (1 - Object.values(W_FIXED).reduce((a, b) => a + b, 0)) / 2;
export const CAR_WEIGHT = { ...W_FIXED, car_vw_golf_gti: W_REST, car_tesla_m3: W_REST };
/** A model drawn from `names` by CAR_WEIGHT; u in [0, 1) (a seeded random, or Math.random()). */
export function pickCar(names, u = Math.random()) {
  let sum = 0;
  for (const n of names) sum += CAR_WEIGHT[n] ?? W_REST;
  let a = u * sum;
  for (const n of names) { a -= CAR_WEIGHT[n] ?? W_REST; if (a < 0) return n; }
  return names[names.length - 1];
}

const cache = new Map();

/** @returns {{ parts: {geometry, material}[], size: THREE.Vector3, lod: {geometry, material}|null }} */
// real sizes (m): length, width, height (the models are fitted by length, the rest is checked and logged)
export const REAL = {
  car_bmw_x3: [4.71, 1.89, 1.68], car_audi_rs6: [4.99, 1.95, 1.46], car_vw_golf_gti: [4.29, 1.79, 1.46],
  car_tesla_m3: [4.69, 1.85, 1.44],
  car_mercedes_sls: [4.64, 1.94, 1.26], car_porsche_taycan: [4.96, 1.97, 1.38],
  car_lamborghini_huracan: [4.52, 1.93, 1.17], car_toyota_gr_yaris: [3.99, 1.81, 1.46],
  car_audi_etron_gt: [4.96, 1.96, 1.38], car_mercedes_gls: [5.21, 1.96, 1.82],
  car1: [5.0, 1.94, 1.62], // (the police patrol car: an estate with a roof bar, game/police.js)
};
const PRECISE = new Set(['car_lamborghini_huracan', 'car_toyota_gr_yaris', 'car_audi_etron_gt', 'car_mercedes_gls', 'car1']);
const JUNK = /plane|ground|shadow|floor|backdrop|base_?plate|studio/i;
const REAR = /tail|rear|back_?light|red_?gla|red_?light|glow_red|reflector/i, FRONT = /head|front_?light|front/i;
// Which way each model's nose points as it comes in, checked by eye (tools/carlab.html?mode=raw: grille and headlights
// at the +z arrow, the Dacia's at +x): the turn about y that brings the nose to +z. The simplified, full-detail, parked,
// traffic and far-LOD versions all come from this. A car not listed here falls back to a guess (lights, longest side).
export const FACING = {
  car_bmw_x3: 0, car_audi_rs6: 0, car_audi_rs6_full: 0, car_vw_golf_gti: 0, car_vw_golf_gti_full: 0,
  car_tesla_m3: 0, car_tesla_m3_full: 0, car_mercedes_sls: 0, car_porsche_taycan: 0,
  car_lamborghini_huracan: 0, car_toyota_gr_yaris: 0, car_audi_etron_gt: 0, car_mercedes_gls: 0,
  car1: 0, // (the police car: its headlamps at +z, an estate's long roof toward -z)
};
// parts of a model left out altogether: the SLS's broken-glass overlay (a second skin over every window and lamp
// lens), its motion-blurred rim discs (invisible at rest, drawn over the real rims) and INT_vetro: a second, inner
// skin on every window (a white haze texture at ~10 % alpha, rough 1: the "super dirty" windows; Glass_Windows is the
// glass itself, made the same plain tinted glass as every other car's)
// The GR Yaris (a TNR kit, like the RS6 and the Huracán): WindowInside, a second, inner skin on every window (the
// same tinted glass twice: dark, "dirty" windows) and LightEmissive, a fully transparent copy of every lamp (alpha 0:
// 10k triangles drawn blended for nothing). The Huracán's glass is a single layer (Window_Material1).
const HIDE = { car_mercedes_sls: /DAMAGE_GLASS|Rim_Blurred|INT_vetro\./i, car_toyota_gr_yaris: /WindowInside_Material|LightEmissive/i };
// Materials that came over as gltf-transform palette materials ("PaletteMaterial00N": their own names lost; the
// original names are still in the node names): renamed back, so the paint, glass, lamp and plate rules find them.
const RENAME = {
  car_lamborghini_huracan: { PaletteMaterial001: 'CalliperGloss_Material1', PaletteMaterial002: 'Base_Material1', PaletteMaterial003: 'PaintTNR_Material1',
    PaletteMaterial004: 'Window_Material1', PaletteMaterial005: 'red_glass', PaletteMaterial006: 'glass_light', PaletteMaterial007: 'glass_surr' },
  car_toyota_gr_yaris: { PaletteMaterial001: 'Base_Material1', PaletteMaterial002: 'LightEmissiveA_Material1', PaletteMaterial003: 'Paint_Material1',
    PaletteMaterial004: 'WindowInside_Material1', PaletteMaterial005: 'glass_light', PaletteMaterial006: 'Window_Material1', PaletteMaterial007: 'red_glass3' },
  // the GLS (a BeamNG mod: its materials palette-merged and its meshes joined, so a material's name is the only clue
  // left, from where its triangles sit on the car): the body paint (four: hood / wings, doors and sills, bumpers,
  // tailgate), the windows (the front door glass, the dark privacy glass at the back and the sunroof), the glass of
  // the windscreen and the tail lamps (one palette: clear and red), the headlamps' LED signature, the trims, the
  // cabin, the dash
  car_mercedes_gls: { PaletteMaterial001: 'gls_trim', PaletteMaterial002: 'gls_glass_dark', PaletteMaterial003: 'gls_glass_red',
    PaletteMaterial004: 'gls_trim_wheel', PaletteMaterial005: 'gls_interior', PaletteMaterial006: 'gls_dash_wood', PaletteMaterial007: 'gls_paint_tailgate',
    PaletteMaterial008: 'gls_dash', PaletteMaterial009: 'gls_glass', PaletteMaterial010: 'gls_engine', PaletteMaterial011: 'gls_paint_front',
    PaletteMaterial012: 'gls_paint_side', PaletteMaterial013: 'gls_glass_privacy', PaletteMaterial014: 'gls_paint_wing', PaletteMaterial015: 'gls_glass_door',
    PaletteMaterial016: 'gls_headlight_lsig' },
};
// per-model material fixes (the Sketchfab SLS came over from a spec / gloss set-up: its black trim plastic, tail
// lamps and cabin plastics fully or half metallic, its leather and plastics at roughness 0.2 with a full-strength
// specular, a metallic carpet, a light grey headliner: a car of mirrors, far brighter than the rest. Brought in line
// with the other cars' interiors (metalness <= ~0.6, roughness 0.5-0.95, a weak specular). regex -> props
// (color: a multiplier on the material's colour; spec: specularIntensity on a physical material)
const MAT_FIX = {
  car_mercedes_sls: [
    [/^Plastic\./, { metalness: 0.15, roughness: 0.5 }],
    [/^Details\./, { metalness: 0.5, roughness: 0.4 }],
    [/^Lights_Rear\./, { metalness: 0.15, roughness: 0.25 }],
    [/^INT_Skin\./, { metalness: 0, roughness: 0.62, spec: 0.3 }],
    [/^INT_Skin_volante/, { metalness: 0, roughness: 0.55, spec: 0.3 }],
    [/^INT_Cuciture/, { roughness: 0.65, spec: 0.3 }],
    [/^INT_Plastica_Grigia/, { metalness: 0.1, roughness: 0.62, spec: 0.3 }],
    [/^INT_carpet/, { metalness: 0, roughness: 0.95, spec: 0.1, color: 0.6 }],
    [/^INT_Alcantara/, { metalness: 0, roughness: 0.95, spec: 0.1, color: 0.5 }],
    [/^INT_(Plastica_Bianca|Plastica_rossa|Carpaint|Decals_Alu|Pedali)/, { spec: 0.35 }],
    [/^INT_Vetro_Display/, { roughness: 0.05, opacity: 0.12, spec: 0.5 }],
  ],
  // the TNR kits (Huracán, GR Yaris): the cabin atlas half to fully metallic (0.5-0.75) and glossy, the Huracán's
  // TexturedA trims (in the cabin) a mirror (metalness 1, roughness 0.16): toned to the other cars' interiors
  car_lamborghini_huracan: [
    [/InteriorA_Material/, { metalness: 0.25, roughness: 0.62, spec: 0.3 }],
    [/InteriorTillingA/, { metalness: 0.2, roughness: 0.7, spec: 0.3 }],
    [/^Interior_C[12]$/, { metalness: 0.05, roughness: 0.75, spec: 0.3 }],
    [/TexturedA_Material/, { metalness: 0.45, roughness: 0.42, spec: 0.4 }],
  ],
  car_toyota_gr_yaris: [
    [/InteriorA_Material/, { metalness: 0.25, roughness: 0.62, spec: 0.3 }],
    [/^color_int$/, { metalness: 0.05, roughness: 0.7, spec: 0.3 }],
    [/Textured[23]?A_Material/, { metalness: 0.3, roughness: 0.7, spec: 0.4 }],
  ],
  // the e-tron GT's cabin: every material 0.25-0.8 metallic (the dash and console a dark mirror, mat09 metalness
  // 0.8 at roughness 0), its exterior trims (ext / misc / lights housings) glossy chrome-ish: brought down
  car_audi_etron_gt: [
    [/^INTVehicle_Interior_mm_mat09$/, { metalness: 0.1, roughness: 0.45, spec: 0.4 }],
    [/^INTVehicle_Interior_mm_(int1|mat01|mat05|mat13|sw1|mat11)$/, { metalness: 0.1, roughness: 0.65, spec: 0.3 }],
    [/^INTVehicle_Interior_mm_(mat15|mat07|mat03)$|^cross$/, { metalness: 0.4, roughness: 0.4, spec: 0.4 }],
    [/^gtVehicle_Exterior_mm_(ext1|cab1|chassis1)$/, { metalness: 0.2, roughness: 0.45 }],
    [/^gtVehicle_Exterior_mm_tyre/, { metalness: 0, roughness: 0.85 }],
  ],
  // the GLS's palettes: metalness and roughness per texel, most of the trims and the whole cabin at metalness ~1 (a
  // car of mirrors): the factor scales the palette's own (chrome stays the brightest, the leather and plastics dull)
  car_mercedes_gls: [
    [/^gls_(interior|dash|dash_wood)$/, { metalness: 0.15, roughness: 1, spec: 0.3, flat: 0.62 }],
    [/^gls_(trim|trim_wheel|engine)$/, { metalness: 0.55, roughness: 1 }],
  ],
};
function fixMat(model, m) {
  const list = MAT_FIX[model];
  const hit = list && list.find(([re]) => re.test(m.name || ''));
  if (!hit) return m;
  const out = m.clone(), f = hit[1];
  if (f.metalness !== undefined) out.metalness = f.metalness;
  if (f.roughness !== undefined) out.roughness = f.roughness;
  if (f.color !== undefined) out.color.multiplyScalar(f.color);
  if (f.opacity !== undefined) out.opacity = f.opacity;
  // (flat: a palette whose roughness texels are 0 (mirror-smooth) everywhere: the texture's roughness dropped for one)
  if (f.flat !== undefined) { out.roughnessMap = null; out.roughness = f.flat; }
  if (f.spec !== undefined && out.isMeshPhysicalMaterial) out.specularIntensity = Math.min(out.specularIntensity ?? 1, f.spec);
  return out;
}

// Lamps per model, checked against each model's meshes (where every part sits on the car, its name and material) and
// the real cars: (label, zone) -> 'head' (low beam) | 'high' (high beam: only the low beams' spill) | 'drl' | 'tail'
// (running + brake) | 'brake' (a lamp's own brake graphic: braking only) | 'third' | 'rev' | 'ind' | 'lensF' | 'lensR'
// | null (no lamp: housings, chrome, reflectors, the plate, windows); a kind + '*' glows evenly instead of through its
// texture (a projector's lens, an LED whose texture is the dark unlit part). test: the parts that can be lamps at all.
// tex: the zone also has the triangle's texel colour (p.c, p.lum, p.tone: 'dark' | 'grey' | 'white' | 'red' | 'amber'
// | 'blue' | 'other'), so the glow follows the lamp graphics the texture draws, not the whole housing. The newer
// models' lamps, found per triangle from where it sits and its texel colour (each checked in front / rear views of
// the model coloured by kind):
//  - SLS: the projector; the LED dots on the two strips over it (upper: indicator, lower: DRL; EXT_Microluci the same
//    split); the mirrors' repeaters; at the back the red frame (tail), the red bar across the middle (brake), the
//    clear bands over / under it (indicator / reversing), the third brake light at the roof's end.
//  - Taycan: the four LED points (DRL) round the projector (low beam), the side markers; the light bar (tail), its
//    bright red graphics (brake), the 3D fins in the lamps (outer ends: indicators, inner: reversing), the third light.
//  - Huracán: the Y light guides (DRL), the inner projector (low) and the outer (high), the bumper's side markers;
//    the Y at the back (tail), the fins over it (brake), the round lamp at each outer end (indicator), the centre
//    lamp over the plate (reversing), the strip on the engine cover (third).
//  - GR Yaris: the L of light guide (DRL) round the reflector bowl (low beam), the mirrors' repeaters; the C light
//    guide (tail), the inner squares (brake over indicator), the diffuser's centre lamp (reversing), the spoiler's strip.
//  - e-tron GT: the digital DRL bars, the matrix block (low) and the laser's blue X (high), the mirrors' repeaters;
//    the tail lamps and light bar (TL), the brake segments (Emiss), the third light.
//  - GLS: see its rule (palette-merged: by position and colour).
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
    // (the two small lamps over the number plate at the back: plate lamps, white, never a red tail light)
    kind: (l, p) => /red_glass/i.test(l) ? (p.third ? 'third' : p.rear && !p.low ? 'lensR' : null)
      : p.mirror ? 'ind' : p.front ? 'head' : p.third ? 'third' : p.rear && !p.low && Math.abs(p.x) > 0.25 ? 'tail' : null,
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
    test: /Lights_Front|Lights_Rear|Microluci|Glass_Clear/i, tex: true,
    kind: (l, p) => {
      if (/Glass_Clear/i.test(l)) return p.front ? 'lensF' : p.rear && !p.low ? 'lensR' : null;
      const ax = Math.abs(p.x);
      if (/Microluci/i.test(l)) return p.front ? (p.y > 0.706 ? 'ind' : 'drl') : null;
      if (/Lights_Front/i.test(l)) {
        if (p.mirror) return 'ind*';
        if (!p.front) return null;
        if (Math.hypot(ax - 0.755, p.y - 0.629) < 0.036 && p.z > 1.86) return 'head*'; // the projector
        // the LED dots on the two strips over it (upper: indicator, lower: DRL); the strips' housings stay dark
        return p.lum > 90 && p.y > 0.68 && p.y < 0.735 ? (p.y > 0.708 ? 'ind*' : 'drl*') : null;
      }
      if (p.third) return 'third*';
      if (!p.rear || p.low) return null; // (the centre lamp in the diffuser: the rear fog lamp, never lit here)
      // the red light bar across the middle: the brake light; the red frame round the lamp: the tail light
      if (p.tone === 'red') return p.y > 0.697 && p.y < 0.728 && ax > 0.56 && ax < 0.86 ? 'brake' : 'tail';
      return p.lum > 40 ? (p.y > 0.713 ? 'ind*' : 'rev*') : null; // the clear bands over and under the red light bar
    },
    lens: { lensF: { color: 0xc9d0d8, opacity: 0.22, roughness: 0.04, metalness: 0.1, glow: 0.5 }, lensR: { color: 0x3c0306, opacity: 0.4, roughness: 0.04, metalness: 0.1, glow: 0.4 } },
  },
  // Porsche Taycan Turbo S: every lamp in one textured atlas (the four-point headlamps, the light bar across the
  // back, the third brake light at the top of the rear window); the windows' material is also the lamps' cover glass
  // (front low: the headlamp lenses; back, below the rear window: the light bar's smoked glass)
  car_porsche_taycan: {
    test: /taycan_turbo_s_lights|car_windows/i, tex: true,
    kind: (l, p) => {
      if (/car_windows/i.test(l)) return p.front && p.y < 0.85 ? 'lensF' : p.rear && !p.low && !p.hi ? 'lensR' : null;
      const ax = Math.abs(p.x);
      if (p.front) {
        if (ax > 0.93 && p.z < 1.85) return 'ind*'; // the side markers at the wings' corners
        if (Math.hypot(ax - 0.742, p.y - 0.689) < 0.05 && p.z > 1.9) return 'head*'; // the projector between the points
        return p.tone === 'white' && p.lum > 150 ? 'drl' : null; // the four LED points
      }
      if (p.third) return p.tone === 'red' ? 'third' : null;
      if (!p.rear || p.low) return null;
      if (p.tone === 'red') return p.lum > 70 ? 'brake' : 'tail';
      // the 3D fins in the light bar's lamps: their outer ends the indicators, the inner part the reversing lights
      return (p.tone === 'grey' || p.tone === 'white') && p.lum > 50 && ax > 0.42 && p.y < 0.875 ? (ax > 0.72 ? 'ind*' : 'rev*') : null;
    },
    lens: { lensF: { color: 0xc9d0d8, opacity: 0.22, roughness: 0.04, metalness: 0.1, glow: 0.5 }, lensR: { color: 0x3c0306, opacity: 0.45, roughness: 0.04, metalness: 0.1, glow: 0.4 } },
  },
  // Lamborghini Huracán EVO and Toyota GR Yaris (TNR kits, like the RS6): every lamp one textured material (LightA:
  // the texture draws the LED signature), its clear cover glass (glass_light: headlamp lenses, the tail lamps' cover),
  // the red glass over the tail lamps (red_glass)
  car_lamborghini_huracan: {
    test: /LightA_Material|red_glass|glass_light/i, tex: true,
    kind: (l, p) => {
      if (/red_glass/i.test(l)) return p.third ? 'third' : p.rear ? 'lensR' : null;
      const ax = Math.abs(p.x);
      // (the centre lamp over the plate: the reversing light, its clear glass lit)
      if (/glass_light/i.test(l)) return p.front ? 'lensF' : p.rear && ax < 0.2 && p.y < 0.75 ? 'rev' : p.rear ? 'lensR' : null;
      if (p.front) {
        if (ax > 0.9) return 'ind*'; // the side markers in the bumper's corners
        if (Math.hypot(ax - 0.577, p.y - 0.561) < 0.042) return 'head*'; // the inner projector: the low beam
        if (Math.hypot(ax - 0.707, p.y - 0.598) < 0.042) return 'high*'; // the outer one: the high beam
        return p.lum > 120 ? 'drl' : null; // the Y light guides
      }
      if (!p.rear) return null;
      if (p.third) return p.lum > 100 ? 'third' : null;
      if (ax < 0.2 && p.y < 0.72) return p.z < -2.17 ? 'rev*' : null; // the centre lamp over the plate
      if (ax > 0.86) return null; // (the reflectors in the bumper's corners)
      if (Math.hypot(ax - 0.787, p.y - 0.773) < 0.052 && p.lum < 100) return 'ind*'; // the round lamp at each outer end
      return p.lum > 100 ? (p.y > 0.815 ? 'brake' : 'tail') : null; // the fins over it: brake; the Y light guide: tail
    },
    lens: { lensF: { color: 0xc9d0d8, opacity: 0.22, roughness: 0.04, metalness: 0.1, glow: 0.5 }, lensR: { color: 0x3c0306, opacity: 0.45, roughness: 0.04, metalness: 0.1, glow: 0.4 } },
  },
  car_toyota_gr_yaris: {
    test: /LightA_Material|red_glass|glass_light/i, tex: true,
    kind: (l, p) => {
      const ax = Math.abs(p.x);
      // (the Toyota emblems' clear covers, front on the grille and back on the tailgate, and the gloss strip behind the
      // rear one are glass_light too: never a lamp, they lit up as lens glass with the head / tail lights)
      if (/red_glass|glass_light/i.test(l) && ax < 0.3 && !p.hi && !p.low) return null;
      if (/red_glass/i.test(l)) return p.third ? 'third' : p.rear && !p.low ? 'lensR' : null;
      if (/glass_light/i.test(l)) return p.front ? 'lensF' : p.rear && !p.low ? 'lensR' : null;
      if (p.mirror) return 'ind*'; // the repeaters in the mirrors
      // the headlamps (a plain reflector texture): the L of light guide along the lower edge and up the outer side the
      // DRL, the reflector bowl inside the low beam (low: the fog lamps, never lit here)
      if (p.front) return p.low || p.lum < 60 ? null : ax > 0.712 || p.y < 0.695 ? 'drl' : 'head';
      if (!p.rear) return null;
      if (p.third) return p.lum > 100 ? 'third' : null; // the strip under the roof spoiler
      if (p.low) return ax < 0.2 ? 'rev*' : null; // the reversing light in the middle of the diffuser (the corners: reflectors)
      if (ax < 0.3) return null; // (the plate lamps)
      if (ax > 0.53 && ax < 0.62 && p.y > 0.954 && p.y < 0.99) return 'brake*'; // the inner squares: brake over indicator
      if (ax > 0.53 && ax < 0.62 && p.y > 0.922 && p.y <= 0.954) return 'ind*';
      return p.lum > 120 ? 'tail' : null; // the C-shaped light guide
    },
    lens: { lensF: { color: 0xc9d0d8, opacity: 0.22, roughness: 0.04, metalness: 0.1, glow: 0.5 }, lensR: { color: 0x3c0306, opacity: 0.45, roughness: 0.04, metalness: 0.1, glow: 0.4 } },
  },
  // Audi e-tron GT (concept): the lamp units (mm_lights: the matrix headlamps, the tail lamps and the light bar,
  // the mirrors' indicators, the third brake light; the grille's lit frame and the diffuser's lamp never lit), their
  // light guides (TL: the DRL strip in the headlamps, the tail lamps' and the light bar's), the brake lamps (Emiss),
  // the cover glass (Glass_light: front / back)
  car_audi_etron_gt: {
    test: /mm_lights|Glass_light/i, tex: true,
    kind: (l, p) => {
      if (/Glass_light/i.test(l)) return p.front ? 'lensF' : p.rear && !p.low ? 'lensR' : null;
      const ax = Math.abs(p.x);
      if (/\bEmiss\b/.test(l)) return p.third ? 'third' : p.rear && !p.low ? 'brake' : null; // the brake lamps' own segments
      if (/_TL_/.test(l)) return p.front ? 'drl' : p.rear && !p.low ? 'tail' : null; // the digital DRL bars; the tail lamps and light bar
      // the lamp units: the repeaters in the mirrors; in the headlamps the laser module (the blue X: high beam) and the
      // matrix module (the dark block under the DRL bars: low beam); the housings, the grille's frame and the lit
      // e-tron letters on the diffuser stay dark
      if (p.mirror) return 'ind*';
      if (!p.front || ax < 0.45 || p.low) return null;
      if (p.tone === 'blue') return 'high*';
      return p.lum < 45 && ax > 0.56 && ax < 0.76 && p.y > 0.625 && p.y < 0.715 ? 'head*' : null;
    },
    lens: { lensF: { color: 0xc9d0d8, opacity: 0.22, roughness: 0.04, metalness: 0.1, glow: 0.5 }, lensR: { color: 0x3c0306, opacity: 0.45, roughness: 0.04, metalness: 0.1, glow: 0.4 } },
  },
  // Mercedes-Benz GLS (X167; a BeamNG mod, its materials palette-merged and nameless: the lamps found by where they
  // sit and their palette colour): the headlamps' eyebrow (gls_headlight_lsig, the only lamp material of its own) the
  // DRL; inside the lamp (gls_trim) the two MULTIBEAM modules (low beam), the round reflector at the outer end (high
  // beam), the white strip under the modules (the indicator); the mirrors' strip (indicators). At the back (gls_trim
  // under the red glass) the red light guides round each lamp (tail), the inner lamp's face (lit red braking), the
  // three blocks in the outer lamp (indicator) and the clear strip under them (reversing); the red glass over them only
  // catches the light. The third brake light: added on the tailgate spoiler above the rear window (THIRD_AT)
  car_mercedes_gls: {
    test: /gls_headlight_lsig|gls_glass(_red|_dark)?\b|gls_trim$/i, tex: true,
    kind: (l, p) => {
      const ax = Math.abs(p.x);
      if (/lsig/i.test(l)) return p.front ? 'drl' : null;
      if (/gls_glass(_red)?\b/.test(l)) return p.rear && ax > 0.36 && p.y > 1.05 && p.y < 1.24 && p.z < -2.15 ? 'lensR' : null;
      if (/gls_glass_dark\b/.test(l)) return p.front && p.z > 1.9 && ax > 0.3 ? 'lensF' : null;
      // gls_trim: everything else on the car; only the parts in the lamps
      if (p.mirror) return p.tone === 'white' && p.lum > 225 && p.y > 1.25 && p.y < 1.31 && ax > 0.9 ? 'ind*' : null;
      if (p.front && p.z > 2.18 && ax > 0.54 && ax < 0.88 && p.y > 0.85 && p.y < 1.05) {
        if (Math.hypot(ax - 0.79, p.y - 0.945) < 0.042) return 'high*';
        if (ax > 0.6 && ax < 0.715 && p.y > 0.905 && p.y < 0.975) return 'head*';
        return ax < 0.72 && p.y > 0.862 && p.y <= 0.905 && p.lum > 190 ? 'ind*' : null;
      }
      if (p.rear && p.z < -2.18 && ax > 0.37 && ax < 0.9 && p.y > 1.06 && p.y < 1.23) {
        if (p.tone === 'red') return 'tail';
        if (ax > 0.73) return p.y > 1.12 && p.y < 1.18 && p.lum > 225 ? 'ind*' : p.y > 1.08 && p.y < 1.112 && p.lum > 150 ? 'rev*' : null;
        return ax > 0.47 && ax < 0.68 && p.y > 1.125 && p.y < 1.18 && p.lum > 225 ? 'brake*' : null;
      }
      return null;
    },
    lens: { lensF: { color: 0xc9d0d8, opacity: 0.22, roughness: 0.04, metalness: 0.1, glow: 0.5 }, lensR: { color: 0x3c0306, opacity: 0.55, roughness: 0.04, metalness: 0.1, glow: 0.4 } },
  },
};
// Materials drawn as cut-outs (opaque, depth-written, alpha-tested) instead of blended. The RS6's whole cabin is one
// textured material marked alpha BLEND (for its decals: stitching, button labels), so it came in transparent with no
// depth writes: the steering wheel's airbag and spokes were drawn over by whatever lay behind them (the column, the
// instrument cluster) and looked see-through. Its texture's alpha: solid panels (the airbag, spokes, dash) with soft
// grey seams, and cut-out decals (stitching, button symbols): cut at 0.3, so the seams stay solid (no slits).
const CUTOUT = { car_audi_rs6: /InteriorA_Material/i, car_lamborghini_huracan: /InteriorA_Material/i, car_toyota_gr_yaris: /InteriorA_Material/i };
// The four rings on the steering wheel's airbag (RS6): the model's own badge there is a dark decal on the black hub,
// lost in it, where the real car's are chrome. Four thin chrome tori laid exactly on that decal, from its UV layout
// (the badge texture draws the rings stacked down its right-hand column): u, v of each ring's centre, the ring's radius
// and the tube's (texture units). They are part of the steering wheel, so they turn with it.
const HUB_RINGS = { car_audi_rs6: { mat: /BadgeA_Material/i, u: 0.809, v: [0.18, 0.391, 0.602, 0.813], r: 0.152, tube: 0.021 } };
// no high-mounted brake light in the model: where to add one (the rear window's glass)
const THIRD_AT = { car_tesla_m3: { glass: /glassDark/i, at: 'window' }, car_mercedes_gls: { glass: /gls_glass_privacy/i, at: 'spoiler' } };
// The models' own number plates (their texture, another size, the old spot) are left out of the template altogether
// (the full-detail car, the far LOD and the cockpit model all come from it): ours (carconfig.js setPlates) takes their
// place. Every material named like a plate (not the plate lamps), and per model the plate pieces of shared materials,
// found by where they sit and their size: whole connected pieces lying inside a box (fitted frame: x0, x1, y0, y1, z0, z1)
//  - Tesla: the US plates' white blanks and their black holders (the text and stripes are LicensePlate*)
//  - Golf: the dealer plates ("Golf", baked into the atlas): at the back with its frame; at the front its face only
//    (its holder stands proud of a recess too small for a plate: ours goes on the holder)
//  - Taycan: the US plate's bracket over the rear recess; e-tron GT: the blank plate on the rear bumper
//  - GR Yaris: the raised pad the US plate sat on in the tailgate's recess
//  - GLS: the front plate (in the dash-wood palette: a 52 x 11 cm face on a bracket over the lower intake): its face
//    only (face: the triangles facing out of that end), the bracket stays as ours's holder
// (the X3's rear plate is Plane006, which fitCar drops with the stray planes)
const PLATE_NAME = /plate|licen|nomera|kennz/i, PLATE_LAMP = /light|lamp|glow/i;
const PLATE_PIECES = {
  car_tesla_m3: [[/^(White|BlackWash)$/, [-0.17, 0.17, 0.32, 0.5, 2.28, 2.42]], [/^(White|BlackWash)$/, [-0.17, 0.17, 0.67, 0.85, -2.38, -2.26]]],
  car_vw_golf_gti: [[/^Atlas$/, [-0.28, 0.28, 0.42, 0.565, 2.125, 2.2], 'face'], [/^Atlas$/, [-0.28, 0.28, 0.42, 0.565, -2.2, -2.08]]],
  car_porsche_taycan: [[/turbo_s_misc/, [-0.17, 0.17, 0.35, 0.47, -2.47, -2.38]]],
  car_audi_etron_gt: [[/^gtVehicle_Exterior_mm_misc1$/, [-0.26, 0.26, 0.64, 0.76, -2.41, -2.33]]],
  car_toyota_gr_yaris: [[/Coloured_Material/, [-0.17, 0.17, 0.73, 0.9, -1.885, -1.8]]],
  car_mercedes_gls: [[/^gls_dash_wood$/, [-0.28, 0.28, 0.5, 0.625, 2.59, 2.62], 'face']],
  // the police car1: its German plates ("GO 380E", in the body atlas 'material'): at the front the plate's face and its
  // backing (two loose pieces on the bumper, 0.405-0.536), at the back the plate in the tailgate's recess (0.634-0.739)
  car1: [[/^material$/, [-0.3, 0.34, 0.385, 0.56, 2.45, 2.54]], [/^material$/, [-0.3, 0.34, 0.61, 0.765, -2.44, -2.34]]],
};
export const isPlateMat = (m) => PLATE_NAME.test(m?.name || '') && !PLATE_LAMP.test(m?.name || '');
// g without the connected pieces (welded at 1 mm) that lie wholly inside box (face: just the triangles in it that
// face out of the car's end); g itself when there are none
function dropPieces(g, box, face) {
  const P = g.attributes.position, I = g.index.array, n = P.count, key = new Map(), canon = new Int32Array(n);
  if (face) {
    const keep = [], a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), s = Math.sign(box[4] + box[5]);
    for (let i = 0; i < I.length; i += 3) {
      a.fromBufferAttribute(P, I[i]); b.fromBufferAttribute(P, I[i + 1]); c.fromBufferAttribute(P, I[i + 2]);
      const x = (a.x + b.x + c.x) / 3, y = (a.y + b.y + c.y) / 3, z = (a.z + b.z + c.z) / 3;
      const nz = b.sub(a).cross(c.sub(a)).normalize().z * s;
      if (!(Math.abs(nz) > 0.9 && x >= box[0] && x <= box[1] && y >= box[2] && y <= box[3] && z >= box[4] && z <= box[5])) keep.push(I[i], I[i + 1], I[i + 2]);
    }
    if (keep.length === I.length) return g;
    if (!keep.length) return null;
    const sub = compact(g, keep, null); sub.userData.label = g.userData.label; return sub;
  }
  for (let i = 0; i < n; i++) { const k = `${Math.round(P.getX(i) * 1000)},${Math.round(P.getY(i) * 1000)},${Math.round(P.getZ(i) * 1000)}`; if (!key.has(k)) key.set(k, i); canon[i] = key.get(k); }
  const par = new Int32Array(n).map((_, i) => i), find = (a) => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
  for (let i = 0; i < I.length; i += 3) { const a = find(canon[I[i]]), b = find(canon[I[i + 1]]), c = find(canon[I[i + 2]]); par[b] = a; par[find(c)] = a; }
  const out = new Map(); // root -> inside so far
  for (let i = 0; i < n; i++) {
    const r = find(canon[i]), x = P.getX(i), y = P.getY(i), z = P.getZ(i);
    const inside = x >= box[0] && x <= box[1] && y >= box[2] && y <= box[3] && z >= box[4] && z <= box[5];
    out.set(r, (out.get(r) ?? true) && inside);
  }
  const keep = [];
  for (let i = 0; i < I.length; i += 3) if (!out.get(find(canon[I[i]]))) keep.push(I[i], I[i + 1], I[i + 2]);
  if (keep.length === I.length) return g;
  if (!keep.length) return null;
  const sub = compact(g, keep, null); sub.userData.label = g.userData.label; return sub;
}
function dropPlates(groups, model) {
  const pieces = PLATE_PIECES[model] || [];
  for (const [mat, geos] of groups) {
    if (isPlateMat(mat)) { groups.delete(mat); continue; }
    const boxes = pieces.filter(([re]) => re.test(mat.name || ''));
    if (!boxes.length) continue;
    const out = [];
    for (let g of geos) { for (const [, b, face] of boxes) if (g) g = dropPieces(g, b, face); if (g) out.push(g); }
    if (out.length) groups.set(mat, out); else groups.delete(mat);
  }
}
// The badges that are chrome on the real car but came in dark (the GLS's three-pointed stars: on the tailgate in the
// dash palette, black; in the grille the star in the trim palette's black and its ring in the dash-wood grey; on the
// steering wheel's hub, the hub's own gloss black): split off into a chrome of their own. Per model: the material
// (name, or glass: the see-through ones), box (fitted frame: x0, x1, y0, y1, z0, z1), optionally the least width (x)
// and triangle count of a piece, and the look (chrome unless said): the connected pieces (by index) lying wholly in
// the box take it (disc: [x, y, r, rMax] instead: the triangles facing out of the car's end with their centres in
// the box and within r of x, y, their corners within rMax). Never lamps: split after the lamps, and never lit
// (Oct 29, the user: "make the mercedes star on the boot, steering wheel and front on the nose of the car silver")
//  - tailgate: its star and ring (gls_dash), over the plate; the paint round them stays
//  - grille: the star (gls_trim) and its ring (gls_dash_wood: the only piece there 20 cm across). The star sits
//    under a smooth cover (the radar's, as on the real car), on a disc: as the real car's, the cover clear (it was
//    the dark tinted glass, which greyed the star) and the disc gloss black (it was a light grey: the silver star
//    on it hardly showed)
//  - steering wheel (before the wheel is split off: it turns with it): the ring and star on the hub (gls_trim, pieces
//    of 12 triangles and up; the hub's face inside the ring is loose triangles of its own: it stays black)
const BADGES = {
  car_mercedes_gls: [
    { mat: /^gls_dash$/, box: [-0.06, 0.06, 1.235, 1.335, -2.56, -2.44] },
    { mat: /^gls_trim$/, box: [-0.095, 0.095, 0.785, 0.955, 2.54, 2.6] },
    { mat: /^gls_dash_wood$/, box: [-0.125, 0.13, 0.73, 0.98, 2.44, 2.58], w: 0.2 },
    { mat: /^gls_dash_wood$/, box: [-0.1, 0.1, 0.76, 0.98, 2.545, 2.566], disc: [0.003, 0.849, 0.0965, 0.11], look: 'black' },
    { glass: true, box: [-0.1, 0.11, 0.75, 0.95, 2.54, 2.58], look: 'clear' },
    { mat: /^gls_trim$/, box: [0.355, 0.43, 1.156, 1.226, 0.525, 0.57], k: 12 },
  ],
};
const badgeMats = {};
const BADGE_LOOK = {
  chrome: () => new THREE.MeshStandardMaterial({ name: 'badge_chrome', color: 0xdfe2e6, metalness: 1, roughness: 0.2 }),
  black: () => new THREE.MeshStandardMaterial({ name: 'badge_black', color: 0x060708, metalness: 0, roughness: 0.15 }),
  clear: () => new THREE.MeshStandardMaterial({ name: 'badge_cover', color: 0xdde3ea, transparent: true, opacity: 0.12, roughness: 0.03, metalness: 0.1, depthWrite: false }),
};
function splitBadges(groups, model) {
  const spec = BADGES[model];
  if (!spec) return;
  const out = new Map(); // look -> geometries
  for (const [mat, geos] of [...groups]) {
    const boxes = spec.filter((s) => (s.glass ? mat.transparent : !mat.transparent && s.mat.test(mat.name || '')));
    if (!boxes.length) continue;
    const rest = [];
    for (const g of geos) {
      const P = g.attributes.position, I = g.index.array, n = P.count;
      const par = new Int32Array(n).map((_, i) => i), find = (a) => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
      for (let i = 0; i < I.length; i += 3) { const a = find(I[i]); par[find(I[i + 1])] = a; par[find(I[i + 2])] = a; }
      const box = new Map(), tris = new Map(); // root -> its bounds; root -> its triangle count
      for (let i = 0; i < n; i++) {
        const r = find(i), x = P.getX(i), y = P.getY(i), z = P.getZ(i);
        let b = box.get(r); if (!b) box.set(r, (b = [x, x, y, y, z, z]));
        b[0] = Math.min(b[0], x); b[1] = Math.max(b[1], x); b[2] = Math.min(b[2], y); b[3] = Math.max(b[3], y); b[4] = Math.min(b[4], z); b[5] = Math.max(b[5], z);
      }
      for (let i = 0; i < I.length; i += 3) { const r = find(I[i]); tris.set(r, (tris.get(r) || 0) + 1); }
      const lookOf = new Map();
      for (const [r, b] of box) {
        const s = boxes.find(({ box: B, w = 0, k = 0, disc }) => !disc && b[0] >= B[0] && b[1] <= B[1] && b[2] >= B[2] && b[3] <= B[3] && b[4] >= B[4] && b[5] <= B[5] && b[1] - b[0] >= w && tris.get(r) >= k);
        if (s) lookOf.set(r, s.look || 'chrome');
      }
      const discs = boxes.filter((s) => s.disc), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), e = new THREE.Vector3(), f = new THREE.Vector3();
      const triLook = (i) => {
        a.fromBufferAttribute(P, I[i]); b.fromBufferAttribute(P, I[i + 1]); c.fromBufferAttribute(P, I[i + 2]);
        const x = (a.x + b.x + c.x) / 3, y = (a.y + b.y + c.y) / 3, z = (a.z + b.z + c.z) / 3;
        const r = (D) => Math.max(Math.hypot(a.x - D[0], a.y - D[1]), Math.hypot(b.x - D[0], b.y - D[1]), Math.hypot(c.x - D[0], c.y - D[1]));
        const s = discs.find(({ box: B, disc: D }) => x >= B[0] && x <= B[1] && y >= B[2] && y <= B[3] && z >= B[4] && z <= B[5] && Math.hypot(x - D[0], y - D[1]) < D[2] && r(D) < D[3] && e.copy(b).sub(a).cross(f.copy(c).sub(a)).normalize().z * Math.sign(B[4] + B[5]) > 0.2);
        return s ? s.look || 'chrome' : null;
      };
      if (!lookOf.size && !discs.length) { rest.push(g); continue; }
      const keep = [], by = new Map();
      for (let i = 0; i < I.length; i += 3) {
        const look = lookOf.get(find(I[i])) || (discs.length ? triLook(i) : null);
        if (!look) { keep.push(I[i], I[i + 1], I[i + 2]); continue; }
        if (!by.has(look)) by.set(look, []);
        by.get(look).push(I[i], I[i + 1], I[i + 2]);
      }
      if (!by.size) { rest.push(g); continue; }
      for (const [look, tri] of by) {
        const sub = compact(g, tri, null); sub.userData.label = `${g.userData.label || ''} badge`;
        // (the black disc: a flat face, its normals straight out (its facets lean every way: glossy, they caught the
        // sky in streaks))
        if (look === 'black') { const N = sub.attributes.normal, sz = Math.sign(sub.attributes.position.getZ(0)); for (let i = 0; i < N.count; i++) N.setXYZ(i, 0, 0, sz); }
        if (!out.has(look)) out.set(look, []); out.get(look).push(sub);
      }
      if (keep.length) { const sub = compact(g, keep, null); sub.userData.label = g.userData.label; rest.push(sub); }
    }
    if (rest.length) groups.set(mat, rest); else groups.delete(mat);
  }
  for (const [look, geos] of out) groups.set((badgeMats[look] ||= BADGE_LOOK[look]()), geos);
}
// The body paint: the material the paint colour tints (cars with no material of their own called *paint*: the Dacia's
// body is UV_body, its paint baked orange into the shared atlas: neutralised to a light grey in a copy of its own,
// neutralPaint, so any colour multiplies cleanly; the Dacia's own orange is then its material's colour)
const PAINT_MAT = { car_porsche_taycan: /ext_carmine_red/i, car_lamborghini_huracan: /^PaintTNR_Material/, car_toyota_gr_yaris: /^Paint_Material/, car_audi_etron_gt: /^CarPaint$/, car_mercedes_gls: /^gls_paint/ };
export const isPaint = (model, m) => !m.transparent && (PAINT_MAT[model] || /paint/i).test(m.name || '');
// (the colour baked in, and the texel value its clean paint has: the Taycan's Carmine Red, the Huracán's orange)
// (the Huracán's Arancio Borealis and the Yaris's white: one palette texel each; 'flat': every texel to the grey)
const NEUTRAL = { car_porsche_taycan: 0xa8181f, car_lamborghini_huracan: 0xf14b03, car_toyota_gr_yaris: 0xe4e4e4 };
const NEUTRAL_HUE = { car_porsche_taycan: 'red', car_toyota_gr_yaris: 'flat' };
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
    const k = hue === 'flat' ? 1 : hue === 'red' ? Math.min(1, Math.max(0, ((r - Math.max(gg, b)) / Math.max(1, r) - 0.45) * 4)) * Math.min(1, Math.max(0, (r - 50) / 40))
      : Math.min(1, Math.max(0, ((r - b) / Math.max(1, r) - 0.45) * 4)) * (r > gg && gg > b ? 1 : 0) * Math.min(1, Math.max(0, (r - 60) / 50));
    if (k <= 0) continue;
    const v = hue === 'flat' ? 236 : Math.min(255, (r / (hue === 'red' ? 155 : 220)) * 236);
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
const CRISP = {};
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
// A lamp atlas's texels for the colour-aware lamp rules (rule.tex: which triangles show a red LED, an amber indicator, a
// white light guide or just the dark housing): read once while the template is built (a canvas, at most 2048 px; the
// Node checks hand them in decoded, image.px), then dropped
function texels(tex) {
  const img = tex?.image;
  if (!img) return null;
  if (img.px) return img.px;
  if (typeof document === 'undefined' || !img.width) return null;
  try {
    const k = Math.min(1, 2048 / Math.max(img.width, img.height)), w = Math.max(1, Math.round(img.width * k)), h = Math.max(1, Math.round(img.height * k));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0, w, h);
    return { w, h, d: g.getImageData(0, 0, w, h).data };
  } catch { return null; }
}
// a triangle's texel colour (0..255): the mean of its middle and three points toward its corners (the texture's own
// transform, KHR_texture_transform, applied)
const _tc = [0, 0, 0];
function triColour(px, tex, U, a, b, c) {
  const ua = U.getX(a), va = U.getY(a), ub = U.getX(b), vb = U.getY(b), uc = U.getX(c), vc = U.getY(c);
  const um = (ua + ub + uc) / 3, vm = (va + vb + vc) / 3;
  _tc[0] = _tc[1] = _tc[2] = 0;
  for (const [u0, v0] of [[um, vm], [ua, va], [ub, vb], [uc, vc]]) {
    let u = (um + (u0 - um) * 0.6) * tex.repeat.x + tex.offset.x, v = (vm + (v0 - vm) * 0.6) * tex.repeat.y + tex.offset.y;
    u -= Math.floor(u); v -= Math.floor(v);
    const i = (Math.min(px.h - 1, Math.floor(v * px.h)) * px.w + Math.min(px.w - 1, Math.floor(u * px.w))) * 4;
    _tc[0] += px.d[i] / 4; _tc[1] += px.d[i + 1] / 4; _tc[2] += px.d[i + 2] / 4;
  }
  return _tc;
}
// what a texel colour is: 'dark' (housing, black trim), 'white' / 'grey' (clear LEDs, reflectors, chrome), 'red',
// 'amber', 'blue', or 'other'
function tone(c) {
  const [r, g, b] = c, mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (mx < 45) return 'dark';
  if ((mx - mn) / mx < 0.22) return 0.3 * r + 0.59 * g + 0.11 * b > 150 ? 'white' : 'grey';
  if (r === mx && g < r * 0.42 && b < r * 0.5) return 'red';
  if (r === mx && g < r * 0.9 && b < g * 0.7) return 'amber';
  return b === mx ? 'blue' : 'other';
}

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
  const hide = HIDE[(name || '').replace(/_full$/, '')], ren = RENAME[(name || '').replace(/_full$/, '')];
  if (ren) m.traverse((o) => { if (o.isMesh) for (const x of [].concat(o.material)) if (x && ren[x.name]) x.name = ren[x.name]; });
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
  // (precise: every vertex. The newer models' nodes carry turns that are not right angles: their loose box (each
  // mesh's own box, turned) reached 0.18 m below the e-tron GT's tyres and the car floated over the ground)
  const exact = PRECISE.has((name || '').replace(/_full$/, ''));
  box.setFromObject(m, exact);
  const s = length / box.getSize(v).z;
  m.scale.multiplyScalar(s);
  m.updateMatrixWorld(true);
  box.setFromObject(m, exact);
  const c = box.getCenter(new THREE.Vector3());
  m.position.sub(new THREE.Vector3(c.x, box.min.y, c.z));
  const g = new THREE.Group();
  g.add(m);
  g.updateMatrixWorld(true);
  const fin = new THREE.Box3().setFromObject(g, exact).getSize(new THREE.Vector3());
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
    if (!glass && MAT_FIX[model]) { const f = fixMat(model, out); if (f !== out) { f.userData = { ...out.userData }; out = f; } }
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
  // (a flat lamp, kind + '*': it glows evenly, not through its texture: a projector's lens, a light guide whose
  // texture is the dark unlit part)
  const flatMats = new Map();
  const flatFor = (mat) => { if (!flatMats.has(mat)) { const ud = mat.userData; mat.userData = {}; const m = mat.clone(); mat.userData = ud; m.name = `${mat.name}_flat`; m.userData = { ...ud, flat: true }; flatMats.set(mat, m); } return flatMats.get(mat); };
  const pxCache = new Map();
  const lampSplit = (mat, g, label) => {
    if (rule ? !rule.test.test(label) : !((LAMP.test(label) && !NOT_LAMP.test(label)) || AMBER.test(label))) return false;
    const P = g.attributes.position, U = g.attributes.uv, I = g.index.array, keep = [], by = new Map();
    // (rule.tex: the triangle's texel colour too: p.c, p.tone)
    if (rule?.tex && mat.map && !pxCache.has(mat.map)) pxCache.set(mat.map, texels(mat.map));
    const px = rule?.tex && mat.map ? pxCache.get(mat.map) : null;
    for (let i = 0; i < I.length; i += 3) {
      const x = (P.getX(I[i]) + P.getX(I[i + 1]) + P.getX(I[i + 2])) / 3, y = (P.getY(I[i]) + P.getY(I[i + 1]) + P.getY(I[i + 2])) / 3;
      const z = (P.getZ(I[i]) + P.getZ(I[i + 1]) + P.getZ(I[i + 2])) / 3;
      const p = zone(x, y, z);
      if (rule?.tex) { const c = px && U ? triColour(px, mat.map, U, I[i], I[i + 1], I[i + 2]) : (mat.color ? [mat.color.r * 255, mat.color.g * 255, mat.color.b * 255] : [128, 128, 128]); p.c = c; p.tone = tone(c); p.lum = 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]; }
      let kind = rule ? rule.kind(label, p) : genericLamp(label, p), flat = false;
      if (kind && kind.endsWith('*')) { kind = kind.slice(0, -1); flat = true; }
      if (!kind) { keep.push(I[i], I[i + 1], I[i + 2]); continue; }
      kind = flat ? kind + '*' : kind;
      if (!by.has(kind)) by.set(kind, []);
      by.get(kind).push(I[i], I[i + 1], I[i + 2]);
      if (flat) kind = kind.slice(0, -1);
      if (!anchors.has(kind)) anchors.set(kind, [null, null]);
      const side = anchors.get(kind), s = x < 0 ? 0 : 1;
      side[s] ||= { min: new THREE.Vector3(Infinity, Infinity, Infinity), max: new THREE.Vector3(-Infinity, -Infinity, -Infinity) };
      for (let k = 0; k < 3; k++) { const j = I[i + k]; _lv.set(P.getX(j), P.getY(j), P.getZ(j)); side[s].min.min(_lv); side[s].max.max(_lv); }
    }
    if (!by.size) return false;
    for (const [key, tri] of by) {
      const flat = key.endsWith('*'), kind = flat ? key.slice(0, -1) : key;
      if (!lampGroups.has(kind)) lampGroups.set(kind, new Map());
      const map = lampGroups.get(kind), lm = flat ? flatFor(lensFor(mat, kind)) : lensFor(mat, kind);
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
    const hadNormals = !!geo.attributes.normal;
    if (!geo.attributes.normal) geo.computeVertexNormals();
    if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
    if (!geo.index) geo.setIndex([...Array(geo.attributes.position.count).keys()]);
    if (hadNormals) orientWinding(geo, o.matrixWorld.determinant() < 0);
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
  dropPlates(groups, model);
  try { splitBadges(groups, model); } catch (e) { console.warn('badges', name, e); }
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
    const core = kind === 'drl' || !!material.userData.flat || geos.some((g) => /glow|emiss|drl|signature/i.test(g.userData.label || ''));
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
    const bodyOnly = (keepPaint && isPaint(name.replace(/_full$/, ''), mat)) || !!WHEEL_BODY[name.replace(/_full$/, '')]?.test(mat.name || ''); // (the wheel arches' paint stays on the body)
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
  car_bmw_x3: [0.372, 1.07, 0.33], car_audi_rs6_full: [0.42, 0.95, 0.49], car_tesla_m3_full: [0.47, 0.81, 0.61],
  car_audi_rs6: [0.42, 0.95, 0.49], car_tesla_m3: [0.47, 0.81, 0.61], // (the simplified ones: the same frame as their full models)
  car_mercedes_sls: [0.43, 0.77, -0.11], car_porsche_taycan: [0.37, 0.88, 0.45],
  car_audi_etron_gt: [0.366, 1.06, 0.38], car_mercedes_gls: [0.42, 1.0, 0.75],
  car_lamborghini_huracan: [0.36, 0.62, 0.45], car_toyota_gr_yaris: [0.33, 0.86, 0.3],
};
// models whose steering wheel is named only in part (the SLS: INT_Skin_volante is the rim's leather; the spokes, hub
// and badge are other materials): found by its shape from STEER_AT instead, all of it
// (the e-tron GT: its STEERING_WHEEL nodes carry a slab of the dash and console too: by its shape, like the SLS)
const STEER_BY_SHAPE = new Set(['car_mercedes_sls', 'car_audi_etron_gt']);
// models whose wheel arches (paint) lie inside the tyres' cylinders: the paint never turns with a wheel
const KEEP_PAINT = new Set(['car_mercedes_sls', 'car_porsche_taycan', 'car_lamborghini_huracan', 'car_toyota_gr_yaris', 'car_audi_etron_gt', 'car_mercedes_gls']);
// and other materials that never turn with a wheel (unless named as one): arch liners, sill trims, the cabin's
// trims beside the rear wheel arches (the GLS's third row) that lie inside a tyre's cylinder
const WHEEL_BODY = { car_audi_etron_gt: /^gtVehicle_Exterior_mm_(ext1|chassis1)$/, car_mercedes_gls: /^gls_(dash|dash_wood|engine|trim_wheel)$/, car_toyota_gr_yaris: /Coloured_Material/, car_lamborghini_huracan: /Coloured_Material/ };
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
// Baking a mirrored node (a negative scale: the Taycan's front fascia / bumper / grille mesh and its wheels are
// mirrored in x) into world space turns its triangles' winding inside out: drawn single-sided, its outside faces were
// culled and the car's nose showed through to the inside (the front looked cut off from the body). Each triangle is
// wound to agree with the model's own (correctly transformed) vertex normals; a mirrored mesh is flipped first, so a
// triangle with no clear normal keeps the mirror-corrected winding.
function orientWinding(geo, mirrored) {
  const P = geo.attributes.position.array, N = geo.attributes.normal.array, I = geo.index.array.slice();
  let flips = 0;
  for (let i = 0; i < I.length; i += 3) {
    if (mirrored) { const t = I[i + 1]; I[i + 1] = I[i + 2]; I[i + 2] = t; }
    const a = 3 * I[i], b = 3 * I[i + 1], c = 3 * I[i + 2];
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
    const d = x * (N[a] + N[b] + N[c]) + y * (N[a + 1] + N[b + 1] + N[c + 1]) + z * (N[a + 2] + N[b + 2] + N[c + 2]);
    if (d < 0) { const t = I[i + 1]; I[i + 1] = I[i + 2]; I[i + 2] = t; flips++; }
  }
  if (mirrored || flips) geo.setIndex(new THREE.BufferAttribute(I, 1));
}

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
    m.emissiveMap = src.userData?.flat ? null : orig?.map || m.map || null; // (fixed now: switching on never recompiles)
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
