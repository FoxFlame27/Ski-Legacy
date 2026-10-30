// Per-course identity: every World Racing course reads as its own place at a glance, on its unchanged
// layout (no gameplay, gate, pacing or bot changes here).
//   atmosphere  time of day, weather, fog tint / density, fresh snow vs bare rock: applied while the course
//               is loaded (game/modes.js: applyCourseAtmosphere on load, restoreCourseAtmosphere on unload),
//               free ride's environment comes back exactly as it was
//   colours     START / CHECKPOINT arches, FINISH portal, safety nets, flags (props.js, barriers.js)
//   terrain     region ruggedness (jagged vs rolling) and forest density (courses.js -> region.js)
//   scenery     a little themed dressing from the Meshy models already loaded, plus instanced ice seracs,
//               crevasses and rock outcrops (buildCourseScenery, props.js). Sparse on purpose: distinct, not busy.
import * as THREE from 'three';
import { fitModel, makeLOD } from '../../core/assets.js';
import { mulberry32 } from '../../core/noise.js';
import { boulderKit, withGround, BOULDER_VARIANTS } from '../../world/boulders.js';
import { canvasTexture, footprintMin, footprintMax, meshGround, FONT } from './kit.js';

// flags: [background, foreground, text] x 4
export const LOOKS = {
  alpine: {
    // the classic World Cup downhill: bluebird late morning, crisp air, red and white everywhere
    atmo: { hour: 11.3, weather: 'clear', snow: 0, cloud: 0, mist: 0.05, fogDensity: 0.75, snowCover: 0.2 },
    colors: {
      arch: '#d9221c', band: '#ffffff', portal: '#d9221c', portalBand: '#ffffff', net: '#d9221c',
      flags: [['#d9221c', '#ffffff', 'SKI LEGACY'], ['#ffffff', '#d9221c', 'WORLD CUP'], ['#d9221c', '#ffffff', 'DOWNHILL'], ['#ffffff', '#d9221c', 'LEGACY']],
    },
    terrain: { rugged: 1.15 },
    crowdAlong: 320, // fans behind the nets down the finish slope
  },
  icecanyon: {
    // dawn in the ice: low sun, cold cyan haze, fog banks, blue nets and arches
    atmo: { hour: 7.25, weather: 'mist', snow: 0.05, cloud: 0.28, mist: 0.42, fog: '#86cdf2', fogK: 0.5, fogDensity: 1.0, snowCover: 0.45, zenith: 0.9 },
    colors: {
      arch: '#14a3e3', band: '#ffffff', portal: '#0f78c4', portalBand: '#bdefff', net: '#1d6fe0',
      flags: [['#14a3e3', '#ffffff', 'ICE CANYON'], ['#ffffff', '#0f6fb8', 'SKI LEGACY'], ['#0b2f5c', '#8fe3ff', 'GLACIER'], ['#bdefff', '#0b2f5c', 'ICE CANYON']],
    },
    terrain: { rugged: 1.35, forestK: 0.7 },
    scenery: 'ice',
  },
  bigair: {
    // park day: bright afternoon sun, black and neon, a truss stage at the finish
    atmo: { hour: 14.2, weather: 'clear', snow: 0, cloud: 0.05, mist: 0.08, fog: '#ffe2bf', fogK: 0.18, fogDensity: 0.85, snowCover: 0.35 },
    colors: {
      arch: '#17171d', band: '#b6ff2e', portal: '#17171d', portalBand: '#e8288f', net: '#e8288f',
      flags: [['#17171d', '#b6ff2e', 'BIG AIR'], ['#e8288f', '#ffffff', 'SKI LEGACY'], ['#b6ff2e', '#17171d', 'PARK LINE'], ['#7b2fbf', '#ffffff', 'BIG AIR']],
    },
    terrain: { rugged: 0.8 },
    scenery: 'park',
  },
  meadow: {
    // sunny family morning: warm soft haze, rolling snowy meadows, chalets, yellow and green
    atmo: { hour: 10.2, weather: 'clear', snow: 0, cloud: 0.04, mist: 0.12, fog: '#f7e6c2', fogK: 0.38, fogDensity: 1.15, snowCover: 0.8 },
    colors: {
      arch: '#ffbd1a', band: '#2c9b5a', portal: '#ff9d1a', portalBand: '#2c9b5a', net: '#3fae49',
      flags: [['#ffbd1a', '#1d5f2e', 'SUNNY MEADOW'], ['#ffffff', '#2c9b5a', 'SKI LEGACY'], ['#2c9b5a', '#ffffff', 'MEADOW'], ['#ff8a1c', '#ffffff', 'SKI LEGACY']],
    },
    terrain: { rugged: 0.4, peaksK: 0.8, forestK: 0.7 },
    scenery: 'meadow',
  },
  floodlight: {
    // night race: a clear starry night under the floods, purple and magenta, fans along the run
    // (no snowfall: flakes read as dark specks against the floodlit snow)
    atmo: { hour: 21.5, weather: 'clear', snow: 0, cloud: 0.08, mist: 0.08, fog: '#3a2d72', fogK: 0.35, fogDensity: 1.0, snowCover: 0.5 },
    colors: {
      arch: '#6b2fd6', band: '#ff2e9a', portal: '#5a22c0', portalBand: '#ff2e9a', net: '#d9221c',
      flags: [['#6b2fd6', '#ffffff', 'NIGHT RACE'], ['#ffffff', '#6b2fd6', 'SKI LEGACY'], ['#ff2e9a', '#ffffff', 'FLOODLIGHT'], ['#15122b', '#ffd21f', 'SKI LEGACY']],
    },
    terrain: { rugged: 0.9 },
    crowdAlong: 520,
    scenery: 'night',
  },
  forestgs: {
    // grey snowy afternoon in dark pines: green-grey haze, light snow, timber and logs, green and amber
    atmo: { hour: 15.3, weather: 'light', snow: 0.42, cloud: 0.7, mist: 0.32, fog: '#8aa092', fogK: 0.55, fogDensity: 1.3, snowCover: 0.85 },
    colors: {
      arch: '#1f5a36', band: '#ffcf3a', portal: '#1d4a2e', portalBand: '#ffcf3a', net: '#d9221c', // (amber nets read olive at a distance)
      flags: [['#1f5a36', '#ffcf3a', 'BLACK FOREST'], ['#ffcf3a', '#14261a', 'GIANT SLALOM'], ['#14261a', '#ffffff', 'SKI LEGACY'], ['#ffffff', '#1f5a36', 'SKI LEGACY']],
    },
    terrain: { rugged: 0.85, forestK: 1.45, forestFar: 1.5 },
    scenery: 'forest',
  },
  glaciersg: {
    // high noon on the ice: thin crisp air, deep cobalt sky, blinding white, no trees, orange nets
    atmo: { hour: 12.4, weather: 'clear', snow: 0, cloud: 0, mist: 0.04, fog: '#e4f3ff', fogK: 0.25, fogDensity: 0.5, snowCover: 1, zenith: 0.72 },
    colors: {
      arch: '#1546c8', band: '#ffffff', portal: '#1546c8', portalBand: '#ff6a13', net: '#ff6a13',
      flags: [['#ffffff', '#1546c8', 'GLACIER'], ['#1546c8', '#ffffff', 'SUPER-G'], ['#ff6a13', '#ffffff', 'SKI LEGACY'], ['#cfefff', '#0b2f5c', 'SKI LEGACY']],
    },
    terrain: { rugged: 1.2, forestK: 0, forestFar: 0 },
    scenery: 'glacier',
  },
  eaglepeak: {
    // big mountain, golden late afternoon: long shadows, amber haze, bare rock, black and gold
    atmo: { hour: 16.75, weather: 'clear', snow: 0.06, cloud: 0.08, mist: 0.2, fog: '#ffc98f', fogK: 0.28, fogDensity: 0.9, snowCover: 0 },
    colors: {
      arch: '#141414', band: '#f2b134', portal: '#141414', portalBand: '#f2b134', net: '#c0191b',
      flags: [['#141414', '#f2b134', 'EAGLE PEAK'], ['#f2b134', '#141414', 'DOWNHILL'], ['#8c1a12', '#ffffff', 'SKI LEGACY'], ['#ffffff', '#141414', 'EAGLE PEAK']],
    },
    terrain: { rugged: 1.6, peaksK: 1.25 },
    scenery: 'rock',
  },
  // the three Expert courses (extremecourses.js)
  devilsridge: {
    // a raw big-mountain morning: hard light, a cold wind haze over bare rock, black and blood red
    atmo: { hour: 9.4, weather: 'clear', snow: 0.04, cloud: 0.18, mist: 0.16, fog: '#c9d3e6', fogK: 0.3, fogDensity: 0.85, snowCover: 0.15 },
    colors: {
      arch: '#141414', band: '#d9221c', portal: '#141414', portalBand: '#d9221c', net: '#c0191b',
      flags: [['#141414', '#d9221c', "DEVIL'S RIDGE"], ['#d9221c', '#141414', 'EXTREME'], ['#141414', '#ffffff', 'SKI LEGACY'], ['#ffffff', '#141414', 'EXPERT ONLY']],
    },
    terrain: { rugged: 1.7, peaksK: 1.3 },
    scenery: 'rock',
  },
  wolfgorge: {
    // a dark snowy afternoon in the gorge: steel-grey haze, light snow, deep pines, black and ice blue
    atmo: { hour: 15.6, weather: 'light', snow: 0.35, cloud: 0.75, mist: 0.3, fog: '#8a98a6', fogK: 0.5, fogDensity: 1.2, snowCover: 0.8 },
    colors: {
      arch: '#141414', band: '#7fd3ff', portal: '#141414', portalBand: '#7fd3ff', net: '#d9221c',
      flags: [['#141414', '#7fd3ff', 'WOLF GORGE'], ['#7fd3ff', '#141414', 'SLALOM'], ['#141414', '#ffffff', 'SKI LEGACY'], ['#ffffff', '#141414', 'EXPERT ONLY']],
    },
    terrain: { rugged: 1.3, forestK: 1.3, forestFar: 1.3 },
    scenery: 'forest',
  },
  skyfang: {
    // high on the ice at noon: thin cobalt sky, glare, no trees up top, black and gold
    atmo: { hour: 12.8, weather: 'clear', snow: 0, cloud: 0.02, mist: 0.05, fog: '#e4f3ff', fogK: 0.25, fogDensity: 0.55, snowCover: 1, zenith: 0.72 },
    colors: {
      arch: '#141414', band: '#f2b134', portal: '#141414', portalBand: '#f2b134', net: '#ff6a13',
      flags: [['#141414', '#f2b134', 'SKY FANG'], ['#f2b134', '#141414', 'DOWNHILL'], ['#141414', '#ffffff', 'SKI LEGACY'], ['#cfefff', '#0b2f5c', 'EXPERT ONLY']],
    },
    terrain: { rugged: 1.4, forestK: 0.5 },
    scenery: 'glacier',
  },
};

/** The look of a course (by id or course object); {} when it has none. */
export function lookOf(c) {
  const id = typeof c === 'string' ? c : c?.id || c?.def?.id;
  return LOOKS[id] || {};
}

// ------------------------------------------------------------------ atmosphere
let active = null; // { env, prev, id }
const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

/** Course atmosphere while the course is loaded: hour (time stands still), weather, fog. */
export function applyCourseAtmosphere(id) {
  restoreCourseAtmosphere();
  try {
    const A = LOOKS[id]?.atmo, env = globalThis.__game?.env;
    if (!A || !env || typeof env.update !== 'function') return;
    const own = Object.prototype.hasOwnProperty.call(env, 'update');
    const prev = {
      hour: env.hour, timeScale: env.timeScale, weather: env.weather, weatherTimer: env.weatherTimer,
      snow: env.snow, cloud: env.cloud, mist: env.mist, snowCover: env.snowCover, own, update: env.update,
    };
    env.hour = A.hour;
    env.timeScale = 0; // the course's hour holds for the whole visit
    env.setWeather?.(A.weather);
    env.weatherTimer = 1e9; // no weather change mid-race
    env.snow = A.snow; env.cloud = A.cloud; env.mist = A.mist;
    if (A.snowCover != null) env.snowCover = A.snowCover;
    env.envTimer = 0; // recapture the sky light now
    const fogC = A.fog ? new THREE.Color(A.fog) : null, tmp = new THREE.Color();
    const base = prev.update;
    env.update = function (dt, camera, focus) {
      // hold the course weather (the preset lerp in update() would drift the custom amounts)
      this.snow = A.snow; this.cloud = A.cloud; this.mist = A.mist;
      if (A.snowCover != null) this.snowCover = A.snowCover;
      base.call(this, dt, camera, focus);
      try {
        const fog = this.scene?.fog;
        if (fogC && this.fogColor) {
          // the course's haze hue at the current fog brightness (works by day and by night)
          const l = lum(this.fogColor), lc = lum(fogC) || 1;
          tmp.copy(fogC).multiplyScalar(l / lc);
          this.fogColor.lerp(tmp, A.fogK ?? 0.3);
          fog?.color.copy(this.fogColor);
          this.skyUniforms?.uGround.value.copy(this.fogColor);
          this.skyUniforms?.uHorizon.value.lerp(tmp, (A.fogK ?? 0.3) * 0.5);
        }
        if (fog && A.fogDensity) fog.near *= A.fogDensity;
        if (A.zenith && this.skyUniforms) {
          this.skyUniforms.uZenith.value.multiplyScalar(A.zenith);
          this.skyUniforms.uMid.value.multiplyScalar(0.5 + A.zenith * 0.5);
        }
      } catch (e) { /* never break the frame for a tint */ }
    };
    active = { env, prev, id };
  } catch (e) {
    console.warn('Course look: atmosphere failed', e);
  }
}

/** Free ride's environment back exactly as it was when the course was loaded. */
export function restoreCourseAtmosphere() {
  if (!active) return;
  const { env, prev } = active;
  active = null;
  try {
    if (prev.own) env.update = prev.update; else delete env.update;
    env.hour = prev.hour;
    env.timeScale = prev.timeScale;
    env.setWeather?.(prev.weather);
    env.weatherTimer = prev.weatherTimer;
    env.snow = prev.snow; env.cloud = prev.cloud; env.mist = prev.mist;
    env.snowCover = prev.snowCover;
    env.envTimer = 0;
  } catch (e) {
    console.warn('Course look: restore failed', e);
  }
}

/** The free-ride hour while a course holds its own (for the save file), else null. */
export function freeRideHour() { return active ? active.prev.hour : null; }

// ------------------------------------------------------------------ scenery
// Model clones share geometry/materials with the loaded GLTF: never dispose those with the course.
function share(obj) {
  obj.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true; o.receiveShadow = true;
      o.userData.keepGeometry = true;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (m) m.userData.shared = true;
    }
  });
  return obj;
}

// A level spot `extra` m past the barrier zone on side sd (+1 right, -1 left) at s, clear of every part of
// the course (switchbacks) and of the arena pads; null if there is none.
function spotBeside(course, s, sd, extra, hw, hd, maxDrop = 0.9) {
  const T = course.track;
  if (s < -30 || s > T.length + 30) return null;
  const sc = Math.max(0, Math.min(T.length, s));
  const w = T.sAt(T.W, sc), clr = T.sAt(T.CLR[sd > 0 ? 1 : 0], sc);
  const lat = sd * (w + clr + extra);
  const p = T.pointAt(sc, lat);
  if (s < 0) { p.x -= Math.sin(p.heading) * -s; p.z -= Math.cos(p.heading) * -s; }
  return checkSpot(course, p.x, p.z, p.heading, hw, hd, maxDrop);
}
function checkSpot(course, x, z, heading, hw, hd, maxDrop = 0.9) {
  const T = course.track;
  const q = T.locate(x, z, -1);
  if (!q.far) {
    const sd = q.v >= 0 ? 1 : 0;
    const w = T.sAt(T.W, q.s), clr = T.sAt(T.CLR[sd], q.s);
    if (Math.abs(q.v) < w + clr + Math.max(hw, hd) * 0.7) return null;
  }
  for (const f of course.flats || []) {
    // clear of the arena pads (grandstands, timing board, patrol hut)
    const r = Math.max(f.hw, f.hd) + Math.max(hw, hd) + 3;
    if (Math.abs(x - f.x) < r && Math.abs(z - f.z) < r) return null;
  }
  const lo = footprintMin(x, z, heading, hw, hd, 2), hi = footprintMax(x, z, heading, hw, hd, 2);
  if (hi - lo > maxDrop) return null;
  return { x, z, y: lo, heading };
}

function putModel(group, models, name, spot, { size, axis = 'y', yaw = 0, lod = false, sink = 0.08 } = {}) {
  if (!models[name] || !spot) return null;
  const m = share(lod ? makeLOD(models[name], { size, axis }, 160, 0.015) : fitModel(models[name], { size, axis }));
  m.position.set(spot.x, spot.y - sink, spot.z);
  m.rotation.y = spot.heading + yaw;
  m.name = 'scenery-' + name;
  group.add(m);
  return m;
}

/** Themed dressing for a course (props.js). Every piece is optional; failures are logged, never thrown. */
export function buildCourseScenery(course, models, group) {
  const kind = lookOf(course).scenery;
  if (!kind) return;
  const g = new THREE.Group();
  g.name = 'course-scenery';
  const rnd = mulberry32((course.def?.seed || 1) * 13 + 5);
  try {
    if (kind === 'meadow') meadowScenery(course, models, g, rnd);
    else if (kind === 'forest') forestScenery(course, models, g, rnd);
    else if (kind === 'glacier') iceScenery(course, g, rnd, { seracs: 26, crevasses: 16, tags: ['dropIn', 'sweep', 'rollers', 'sg'] });
    else if (kind === 'ice') iceScenery(course, g, rnd, { seracs: 14, crevasses: 6, tags: ['dropIn', 'glacier'] });
    else if (kind === 'rock') rockScenery(course, g, rnd);
    else if (kind === 'park') parkScenery(course, models, g, rnd);
    else if (kind === 'night') nightScenery(course, models, g, rnd);
  } catch (e) {
    console.warn('Course look: scenery failed for', course.id, e);
  }
  group.add(g);
}

// --- Sunny Meadow: chalets above the finish, a sun terrace, snowmen
function meadowScenery(course, models, g, rnd) {
  const T = course.track, fs = course.finishS;
  // a hotel chalet and two huts on the open meadow beside the lower course
  putModel(g, models, 'hotel_chalet', spotBeside(course, fs + 45, 1, 26, 9, 7, 1.6), { size: 16, axis: 'x', yaw: Math.PI / 2, lod: true, sink: 0.2 });
  const hutA = spotBeside(course, fs - 170, -1, 22, 5, 4, 1.2) || spotBeside(course, fs - 230, -1, 26, 5, 4, 1.2);
  putModel(g, models, 'mountain_hut', hutA, { size: 9, axis: 'x', yaw: -Math.PI / 2, lod: true, sink: 0.15 });
  const mid = course.section('sweep#2');
  if (mid) putModel(g, models, 'mountain_hut', spotBeside(course, mid.s0 + mid.len * 0.5, 1, 30, 5, 4, 1.2), { size: 8.5, axis: 'x', yaw: Math.PI / 2, lod: true, sink: 0.15 });
  // sun terrace by the hut: deck chairs and picnic tables in a row facing the slope
  if (hutA) {
    const fx = Math.sin(hutA.heading), fz = Math.cos(hutA.heading);
    for (let k = 0; k < 3; k++) {
      const x = hutA.x + fx * (k * 2.2 - 6), z = hutA.z + fz * (k * 2.2 - 6);
      const sp = checkSpot(course, x - Math.cos(hutA.heading) * 6.5, z + Math.sin(hutA.heading) * 6.5, hutA.heading, 0.6, 1, 0.6);
      putModel(g, models, 'deck_chair', sp, { size: 1.6, axis: 'xz', yaw: Math.PI / 2 + (rnd() - 0.5) * 0.4, sink: 0.05 });
    }
    const pt = checkSpot(course, hutA.x - fx * 7 - Math.cos(hutA.heading) * 6, hutA.z - fz * 7 + Math.sin(hutA.heading) * 6, hutA.heading, 1.2, 1, 0.6);
    putModel(g, models, 'picnic_table', pt, { size: 2.2, axis: 'xz', yaw: 0.3, sink: 0.05 });
  }
  // snowmen: one by the start, one by the finish
  putModel(g, models, 'snowman', spotBeside(course, 26, -1, 2, 0.7, 0.7, 0.6), { size: 1.9, yaw: -Math.PI / 2 });
  putModel(g, models, 'snowman', spotBeside(course, fs - 60, 1, 2.5, 0.7, 0.7, 0.6), { size: 1.8, yaw: Math.PI / 2 });
  void T;
}

// --- Black Forest: a timber lodge at the start, log piles at the forest edge, a fire pit at the finish
function forestScenery(course, models, g, rnd) {
  const fs = course.finishS;
  const lodge = spotBeside(course, 6, -1, 5, 4.5, 4, 1.2) || spotBeside(course, 14, 1, 5, 4.5, 4, 1.2);
  putModel(g, models, 'mountain_hut', lodge, { size: 8.5, axis: 'x', yaw: -Math.PI / 2, lod: true, sink: 0.15 });
  for (const [s, sd] of [[2, 1], [18, -1]]) putModel(g, models, 'firewood_pile', spotBeside(course, s, sd, 1.5, 1.3, 0.8, 0.6), { size: 2.4, axis: 'xz', yaw: Math.PI / 2 });
  // log piles where the forestry track meets the piste, every few hundred metres
  for (const sec of course.sectionsTagged('gs')) {
    const s = sec.s0 + sec.len * (0.35 + rnd() * 0.3), sd = rnd() < 0.5 ? -1 : 1;
    putModel(g, models, 'firewood_pile', spotBeside(course, s, sd, 1.2, 1.4, 0.8, 0.7), { size: 2.8, axis: 'xz', yaw: Math.PI / 2 + (rnd() - 0.5) * 0.3 });
  }
  // fire pit with benches past the finish
  const pit = spotBeside(course, fs + 40, 1, 10, 1.2, 1.2, 0.6);
  putModel(g, models, 'fire_pit', pit, { size: 1.6, axis: 'xz' });
  if (pit) {
    for (const a of [0, Math.PI * 0.66, Math.PI * 1.33]) {
      const sp = checkSpot(course, pit.x + Math.sin(a) * 2.6, pit.z + Math.cos(a) * 2.6, a, 0.9, 0.4, 0.6);
      if (sp) { sp.heading = a + Math.PI; putModel(g, models, 'wooden_bench', sp, { size: 1.8, axis: 'xz', sink: 0.04 }); }
    }
  }
  putModel(g, models, 'wooden_barrel', spotBeside(course, fs + 12, -1, 3, 0.5, 0.5, 0.6), { size: 1.1 });
}

// --- Big Air: a truss gantry with a big LED banner beside the finish (park stage)
function parkScenery(course, models, g) {
  const T = course.track, fs = course.finishS;
  if (!models.truss_pylon) return;
  const stage = spotBeside(course, fs - 6, 1, 14, 8, 2.5, 1.4) || spotBeside(course, fs + 30, 1, 16, 8, 2.5, 1.4);
  if (!stage) return;
  const tx = Math.sin(stage.heading), tz = Math.cos(stage.heading);
  const H = 9, half = 7;
  for (const sd of [-1, 1]) {
    const x = stage.x + tx * sd * half, z = stage.z + tz * sd * half;
    putModel(g, models, 'truss_pylon', { x, z, y: meshGround(x, z), heading: stage.heading }, { size: H, axis: 'y', sink: 0.3 });
  }
  const tex = canvasTexture(2048, 512, (c, W, Hh) => {
    const gr = c.createLinearGradient(0, 0, W, 0);
    gr.addColorStop(0, '#7b2fbf'); gr.addColorStop(0.5, '#e8288f'); gr.addColorStop(1, '#ff8a1c');
    c.fillStyle = '#0d0d12'; c.fillRect(0, 0, W, Hh);
    c.fillStyle = gr; c.fillRect(0, Hh - 40, W, 40); c.fillRect(0, 0, W, 18);
    c.fillStyle = '#b6ff2e'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = `italic 700 250px ${FONT}`; c.fillText('BIG AIR LINE', W / 2, Hh / 2 - 10);
    c.fillStyle = '#ffffff'; c.font = `italic 700 64px ${FONT}`; c.fillText('SKI LEGACY  ·  PARK SESSION', W / 2, Hh - 92);
  });
  const mat = new THREE.MeshStandardMaterial({ map: tex, color: tex ? 0xffffff : 0x17171d, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.55, roughness: 0.5, side: THREE.DoubleSide });
  const bw = half * 2 - 0.6, bh = bw / 4;
  const pl = new THREE.Mesh(new THREE.PlaneGeometry(bw, bh), mat);
  pl.position.set(stage.x, Math.max(meshGround(stage.x + tx * half, stage.z + tz * half), meshGround(stage.x - tx * half, stage.z - tz * half)) + H - bh / 2 - 0.5, stage.z);
  pl.rotation.y = stage.heading + Math.PI / 2; // faces the piste (the stage stands on its right)
  pl.castShadow = true;
  g.add(pl);
  void T;
}

// --- Floodlight: food stalls behind the finish crowd (the fans line the run: props.js crowdAlong)
function nightScenery(course, models, g) {
  const fs = course.finishS;
  putModel(g, models, 'market_stall', spotBeside(course, fs + 16, 1, 9, 2.2, 1.6, 0.8), { size: 4, axis: 'xz', yaw: Math.PI / 2 });
  putModel(g, models, 'market_stall', spotBeside(course, fs + 26, 1, 9, 2.2, 1.6, 0.8), { size: 4, axis: 'xz', yaw: Math.PI / 2 });
}

// --- Eagle Peak: a perch of big boulders around the start ("the eagle's nest") and rock outcrops on the open faces
function rockScenery(course, g, rnd) {
  const T = course.track, rocks = [];
  const kit = boulderKit();
  const addRock = (x, z, s) => {
    const v = Math.min(BOULDER_VARIANTS - 1, Math.floor(rnd() * BOULDER_VARIANTS));
    let lo = Infinity;
    for (const [u, w] of [[0, 0], [0.45, 0], [-0.45, 0], [0, 0.45], [0, -0.45]]) lo = Math.min(lo, meshGround(x + u * s, z + w * s));
    const sy = 0.75 + rnd() * 0.5, height = kit.height[v] * s * sy;
    const gx = meshGround(x + 0.5, z) - meshGround(x - 0.5, z), gz = meshGround(x, z + 0.5) - meshGround(x, z - 0.5);
    const r = { x, y: lo - height * 0.22, z, s, v, sx: 0.9 + rnd() * 0.4, sy, ry: rnd() * 6.28, rx: (rnd() - 0.5) * 0.2, rz: (rnd() - 0.5) * 0.2, gx, gz, gh: meshGround(x, z) };
    rocks.push(r);
    // solid (Oct 30, the user: "at some races you can walk through the stones there, make them collide"): registered
    // with the course's other props outside the nets (course.solids, freeworld.js syncMasts: the shared colliders
    // the player, the snowmobile and the cars use); a circle as wide as the boulder, top = its real top
    course.solids?.push({ x, z, r: 0.45 * s * (1 + r.sx) / 2, top: r.y + height, rock: true });
  };
  // the nest: boulders on both sides of the start platform and behind the start house
  for (let k = 0; k < 14; k++) {
    const s = -16 + k * 4.2 + rnd() * 2, sd = k % 2 ? 1 : -1;
    const sp = spotBeside(course, s, sd, 1.5 + rnd() * 6, 1, 1, 50);
    if (sp) addRock(sp.x, sp.z, 2.2 + rnd() * 2.8);
  }
  // (behind the start house: on the line's extension, so no track-clearance test, just off the flags)
  for (let k = 0; k < 5; k++) {
    const p = T.pointAt(0, (k - 2) * 6 + (rnd() - 0.5) * 2), back = 17 + rnd() * 6;
    addRock(p.x - Math.sin(p.heading) * back, p.z - Math.cos(p.heading) * back, 3 + rnd() * 3);
  }
  // outcrops: clusters of big rocks on the open faces up high, well off the piste
  for (const tag of ['startHang', 'sturns', 'face', 'sturns#3', 'shoulder']) {
    const sec = course.section(tag);
    if (!sec) continue;
    const s = sec.s0 + sec.len * (0.3 + rnd() * 0.4), sd = rnd() < 0.5 ? -1 : 1;
    const c = spotBeside(course, s, sd, 18 + rnd() * 30, 3, 3, 50);
    if (!c) continue;
    for (let k = 0; k < 4; k++) {
      const x = c.x + (rnd() - 0.5) * 12, z = c.z + (rnd() - 0.5) * 12;
      if (checkSpot(course, x, z, 0, 2, 2, 50)) addRock(x, z, 3 + rnd() * 5);
    }
  }
  if (!rocks.length) return;
  const dummy = new THREE.Object3D();
  for (let v = 0; v < BOULDER_VARIANTS; v++) {
    const list = rocks.filter((r) => r.v === v);
    if (!list.length) continue;
    const im = new THREE.InstancedMesh(withGround(kit.hi[v], list.length), kit.material, list.length);
    const ground = im.geometry.attributes.aGround;
    list.forEach((r, k) => {
      dummy.position.set(r.x, r.y, r.z);
      dummy.rotation.set(r.rx, r.ry, r.rz);
      dummy.scale.set(r.s * r.sx, r.s * r.sy, r.s);
      dummy.updateMatrix();
      im.setMatrixAt(k, dummy.matrix);
      ground.setXYZ(k, r.gx, r.gz, r.gh);
    });
    im.castShadow = true; im.receiveShadow = true;
    im.computeBoundingSphere();
    im.name = 'scenery-rocks';
    g.add(im);
  }
}

// --- Glacier / Ice Canyon: seracs (instanced ice towers) and crevasses (dark blue gashes on the snow)
let seracKit = null;
function seracGeometries() {
  if (seracKit) return seracKit;
  const deep = new THREE.Color('#2a6fae'), light = new THREE.Color('#bfe6fb'), snow = new THREE.Color('#f3f8ff');
  const geos = [];
  for (let v = 0; v < 4; v++) {
    const rnd = mulberry32(901 + v * 37);
    const src = new THREE.IcosahedronGeometry(1, 1);
    const P = src.attributes.position;
    const disp = new Map();
    const tilt = (rnd() - 0.5) * 0.5, tall = 1.5 + rnd() * 0.9, thin = 0.72 + rnd() * 0.1;
    for (let i = 0; i < P.count; i++) {
      const x = P.getX(i), y = P.getY(i), z = P.getZ(i);
      const key = `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;
      let d = disp.get(key);
      if (d === undefined) { d = 0.72 + rnd() * 0.56; disp.set(key, d); }
      const yy = Math.max(y, -0.35);
      // a leaning, blocky ice tower: tall, with a sheared top
      P.setXYZ(i, x * d + yy * tilt, (yy + 0.35) * d * tall, z * d * thin);
    }
    const geo = src.index ? src.toNonIndexed() : src;
    geo.computeVertexNormals();
    const N = geo.attributes.normal, Q = geo.attributes.position;
    const C = new Float32Array(Q.count * 3), c = new THREE.Color();
    let top = 0;
    for (let i = 0; i < Q.count; i++) top = Math.max(top, Q.getY(i));
    for (let i = 0; i < Q.count; i += 3) {
      // per facet: snow on the up-facing facets, blue ice on the walls (deeper low down)
      const ny = (N.getY(i) + N.getY(i + 1) + N.getY(i + 2)) / 3;
      const h = (Q.getY(i) + Q.getY(i + 1) + Q.getY(i + 2)) / 3 / (top || 1);
      if (ny > 0.62) c.copy(snow); else c.copy(deep).lerp(light, Math.min(1, 0.25 + h * 0.8));
      for (let k = 0; k < 3; k++) C.set([c.r, c.g, c.b], (i + k) * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(C, 3));
    geo.computeBoundingSphere();
    geos.push(geo);
  }
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.18, metalness: 0, envMapIntensity: 1.3, flatShading: true });
  mat.onBeforeCompile = (s) => {
    s.fragmentShader = s.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      {
        float fres = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), 3.0);
        totalEmissiveRadiance += vColor.rgb * vec3(0.5, 0.78, 1.0) * (0.05 + 0.35 * fres);
      }`);
  };
  mat.customProgramCacheKey = () => 'course-serac';
  mat.userData.shared = true;
  for (const g of geos) g.userData = { shared: true };
  seracKit = { geos, mat };
  return seracKit;
}

function iceScenery(course, g, rnd, { seracs = 20, crevasses = 10, tags = null } = {}) {
  const T = course.track;
  // open sections to dress (glacier fields), spread along them
  const secs = T.sections.filter((s) => (tags ? tags.includes(s.tag) : true) && s.s0 > 60 && s.s1 < course.finishS - 120);
  if (!secs.length) return;
  const pick = () => {
    const sec = secs[Math.floor(rnd() * secs.length)];
    return sec.s0 + rnd() * sec.len;
  };
  // seracs, in small groups
  const kit = seracGeometries();
  const inst = kit.geos.map(() => []);
  let tries = 0;
  for (let n = 0; n < seracs && tries < seracs * 6; tries++) {
    const s = pick(), sd = rnd() < 0.5 ? -1 : 1;
    const c = spotBeside(course, s, sd, 14 + rnd() * 70, 3, 3, 60);
    if (!c) continue;
    const m = 1 + Math.floor(rnd() * 3);
    for (let k = 0; k < m && n < seracs; k++) {
      const x = c.x + (rnd() - 0.5) * 14, z = c.z + (rnd() - 0.5) * 14;
      if (!checkSpot(course, x, z, 0, 3, 3, 60)) continue;
      const y = Math.min(meshGround(x, z), meshGround(x + 2, z), meshGround(x - 2, z), meshGround(x, z + 2), meshGround(x, z - 2));
      const sc = 3 + rnd() * 4.5;
      inst[Math.floor(rnd() * kit.geos.length)].push({ x, y: y - sc * 0.25, z, sc, ry: rnd() * 6.28 });
      n++;
    }
  }
  const d = new THREE.Object3D();
  inst.forEach((list, v) => {
    if (!list.length) return;
    const im = new THREE.InstancedMesh(kit.geos[v], kit.mat, list.length);
    list.forEach((r, k) => {
      d.position.set(r.x, r.y, r.z);
      d.rotation.set(0, r.ry, 0);
      d.scale.set(r.sc * (0.9 + rnd() * 0.3), r.sc, r.sc * (0.8 + rnd() * 0.3));
      d.updateMatrix();
      im.setMatrixAt(k, d.matrix);
    });
    im.castShadow = true; im.receiveShadow = true;
    im.computeBoundingSphere();
    im.userData.keepGeometry = true;
    im.name = 'scenery-seracs';
    g.add(im);
  });
  // crevasses: lens-shaped dark blue gashes across the fall line, draped on the snow
  const P = [], C = [], I = [];
  const deep = new THREE.Color('#0b2442'), mid = new THREE.Color('#2f6fa8'), lip = new THREE.Color('#dbeaf7');
  tries = 0;
  for (let n = 0; n < crevasses && tries < crevasses * 6; tries++) {
    const s = pick(), sd = rnd() < 0.5 ? -1 : 1;
    const c = spotBeside(course, s, sd, 12 + rnd() * 60, 4, 4, 60);
    if (!c) continue;
    // across the fall line ~ along the track's right vector, a little skewed
    const a = c.heading + Math.PI / 2 + (rnd() - 0.5) * 0.5;
    const ax = Math.sin(a), az = Math.cos(a), nx = -az, nz = ax;
    const L = 18 + rnd() * 34, W = 0.9 + rnd() * 1.4, segs = Math.max(8, Math.round(L / 2));
    // the whole gash must stay clear of the course
    if (!checkSpot(course, c.x + ax * L / 2, c.z + az * L / 2, 0, 1, 1, 60) || !checkSpot(course, c.x - ax * L / 2, c.z - az * L / 2, 0, 1, 1, 60)) continue;
    const base = P.length / 3;
    const ph = rnd() * 6.28;
    for (let k = 0; k <= segs; k++) {
      const t = k / segs, along = (t - 0.5) * L;
      const wid = W * Math.pow(Math.sin(Math.PI * t), 0.7) + 0.05;
      const wob = Math.sin(t * 6.28 * 1.3 + ph) * 0.6;
      const cx = c.x + ax * along + nx * wob, cz = c.z + az * along + nz * wob;
      for (const [o, col] of [[-1.9, lip], [-0.6, mid], [0, deep], [0.6, mid], [1.9, lip]]) {
        const x = cx + nx * o * wid, z = cz + nz * o * wid;
        P.push(x, meshGround(x, z) + 0.06, z);
        C.push(col.r, col.g, col.b, o === -1.9 || o === 1.9 ? 0 : o === 0 ? 0.95 : 0.8);
      }
    }
    for (let k = 0; k < segs; k++) for (let j = 0; j < 4; j++) {
      const i0 = base + k * 5 + j, i1 = i0 + 5;
      I.push(i0, i1, i0 + 1, i0 + 1, i1, i1 + 1);
    }
    n++;
  }
  if (I.length) {
    // face every triangle up (the decal is seen from above)
    for (let k = 0; k < I.length; k += 3) {
      const a3 = I[k] * 3, b3 = I[k + 1] * 3, c3 = I[k + 2] * 3;
      if ((P[b3 + 2] - P[a3 + 2]) * (P[c3] - P[a3]) - (P[b3] - P[a3]) * (P[c3 + 2] - P[a3 + 2]) < 0) { const t = I[k + 1]; I[k + 1] = I[k + 2]; I[k + 2] = t; }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(C, 4));
    geo.setIndex(I);
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      vertexColors: true, transparent: true, depthWrite: false, roughness: 0.4,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }));
    m.receiveShadow = true;
    m.renderOrder = 1;
    m.name = 'scenery-crevasses';
    g.add(m);
  }
}
