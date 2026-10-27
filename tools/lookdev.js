// Look-dev sandbox (dev only): the real terrain, sky, sun, clouds, trees, backdrop peaks and post chain,
// without the player, village or UI. Used to tune the game's look against the Ski Legacy logo art.
//   /tools/lookdev.html?view=village&hour=10.5&weather=clear
// window.__look = { ready, setView(name), setHour(h), setWeather(name), views, env, scene, camera }
// setView('perf') (or 'perf=<view>') times the frame with each new look module switched off in turn and reports
// the results with console.error (the only console type tools/lookdev-shots.mjs relays).
import * as THREE from 'three';
import { installHeightFog } from '../src/engine/fog.js';
import { Post } from '../src/engine/post.js';
import { world, valleyCenter } from '../src/world/world.js';
import { initLayout } from '../src/world/layout.js';
import { Terrain, terrainUniforms } from '../src/world/terrain.js';
import { Environment } from '../src/world/sky.js';
import { Vegetation } from '../src/world/vegetation.js';
import { Atmosphere } from '../src/world/atmosphere.js';
import { loadAll } from '../src/core/assets.js';

const q = new URLSearchParams(location.search);
installHeightFog();

const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.72;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(+(q.get('fov') || 60), innerWidth / innerHeight, 0.1, 32000);
const env = new Environment(renderer, scene);
env.hour = +(q.get('hour') || 10.5);
env.timeScale = 0;
env.weatherTimer = 1e9; // no automatic weather changes
const forceWeather = (name) => {
  env.setWeather(name);
  const W = { clear: [0, 0, 0.1], cloudy: [0, 0.7, 0.25], light: [0.5, 0.75, 0.3], heavy: [1, 1, 0.45], mist: [0, 0.45, 1] }[name];
  if (W) [env.snow, env.cloud, env.mist] = W; // jump straight to the target (no 20 s blend)
};
forceWeather(q.get('weather') || 'clear');

const g = (x, z) => world.height(x, z);
// Named viewpoints. look = world target, or { sun: yawOffset, pitch } to frame the sun (upper right).
const VIEWS = {
  village: { pos: () => [4, g(4, 40) + 1.7, 40], look: () => [0, 650, -2350] },
  lobby: { pos: () => [10, g(10, 14) + 1.4, 14], look: () => [0, 420, -2350] },
  piste: { pos: () => [140, g(140, -1250) + 2.2, -1250], look: () => [40, g(40, -200) + 40, -200] },
  summit: { pos: () => [30, g(30, -2280) + 4, -2280], look: () => [300, 300, 2500] },
  sun: { pos: () => [-300, g(-300, -650) + 2.5, -650], look: { sun: 0.42, pitch: 0.16 } },
  valley: { pos: () => { const z = 2600; return [valleyCenter(z), g(valleyCenter(z), z) + 16, z]; }, look: () => { const z = 5200; return [valleyCenter(z), g(valleyCenter(z), z) + 60, z]; } },
  aerial: { pos: () => [-520, g(-520, -520) + 420, -520], look: () => [0, 900, -2400] },
  hero: { pos: () => [-180, g(-180, -1500) + 1.8, -1500], look: { sun: -0.55, pitch: 0.1 } },
  // the distant ranges (world/backdrop.js): mid-mountain and village looking south down the Legacy Valley
  vista: { pos: () => [140, g(140, -1250) + 2.2, -1250], look: () => [35, g(140, -1250) + 20, -255] },
  downvalley: { pos: () => [4, g(4, 40) + 1.7, 40], look: () => [4, g(4, 40) + 54, 1040] },
  // composed like the Ski Legacy logo art: on the main mountain's east flank (the slope falls away to the right),
  // the Horn (world/backdrop.js) centre-right behind over a sea of clouds, the morning sun upper right (~9:30)
  logo: { pos: () => [-260, g(-260, -1450) + 1.8, -1450], look: { az: 192, pitch: 11 } },
};

let view = q.get('view') || 'village';
const camPos = new THREE.Vector3();
// "at=x,z,height,yawDeg,pitchDeg": any spot in the world (height above the snow; yaw 0 = looking toward +Z)
function customView(name) {
  const [x, z, h = 2, yaw = 0, pitch = -8] = name.slice(3).split(',').map(Number);
  const yr = THREE.MathUtils.degToRad(yaw), pr = THREE.MathUtils.degToRad(pitch);
  return { pos: () => [x, g(x, z) + h, z], look: () => [x + Math.sin(yr) * 100, g(x, z) + h + Math.tan(pr) * 100, z + Math.cos(yr) * 100] };
}
function placeCamera() {
  const v = view.startsWith('at=') ? customView(view) : VIEWS[view] || VIEWS.village;
  camPos.fromArray(v.pos());
  camera.position.copy(camPos);
  if (typeof v.look === 'function') camera.lookAt(new THREE.Vector3().fromArray(v.look()));
  else if (v.look.az !== undefined) {
    // fixed heading: az = degrees from -Z toward +X (the backdrop's convention), pitch in degrees
    const a = THREE.MathUtils.degToRad(v.look.az), p = THREE.MathUtils.degToRad(v.look.pitch);
    camera.lookAt(camPos.x + Math.sin(a) * 100, camPos.y + Math.tan(p) * 100, camPos.z - Math.cos(a) * 100);
  } else {
    const s = env.sunDir, yaw = Math.atan2(s.x, s.z) + v.look.sun;
    camera.lookAt(camPos.x + Math.sin(yaw) * 100, camPos.y + Math.tan(v.look.pitch) * 100, camPos.z + Math.cos(yaw) * 100);
  }
}

let terrain, vegetation, atmosphere, post, backdrop = null, glare = null;
const look = window.__look = {
  ready: false, views: Object.keys(VIEWS), env, scene, camera, renderer,
  async setView(name) {
    // 'diag=<view>@x,y;x,y' samples those frame points (0..1, y down) instead of the default ones
    const [base, pts] = name.split('@');
    if (pts) diagPts = pts.split(';').map((q) => q.split(',').map(Number));
    name = base;
    const perfView = name.startsWith('perf') || name.startsWith('diag') ? name.split('=')[1] || 'logo' : null;
    view = perfView || name; placeCamera(); look.ready = false; await stream();
    if (perfView) await (name.startsWith('diag') ? diagReport() : perfReport());
    look.ready = true;
  },
  setHour(h) { env.hour = h; env.update(0, camera, camPos); placeCamera(); },
  setWeather: forceWeather,
};

async function stream() {
  let guard = 0;
  while (terrain.update(camPos.x, camPos.z, 40) > 0 && guard++ < 400) await new Promise((r) => setTimeout(r, 0));
  guard = 0;
  while (vegetation.update(camPos.x, camPos.z, 0, 40) > 0 && guard++ < 200) await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 4; i++) await new Promise((r) => requestAnimationFrame(r));
}

async function boot() {
  try { initLayout(); } catch (e) { console.warn('layout', e); }
  terrain = new Terrain(scene);
  const models = await loadAll(['pine_tree', 'pine_tree2', 'rock', 'crystal', 'safety_net', 'patrol_hut', 'wooden_fence', 'wooden_bench', 'mountain_hut', 'lift_tower']);
  vegetation = new Vegetation(scene, renderer, models);
  atmosphere = new Atmosphere(scene, { renderer, crystal: models.crystal });
  // new look modules are optional (they may not exist yet)
  const optional = (path) => import(/* @vite-ignore */ path).catch((e) => { console.info('optional module missing', path, e.message); return null; });
  const bd = await optional('/src/world/backdrop.js'), sg = await optional('/src/world/sunglare.js');
  if (bd?.Backdrop) backdrop = new bd.Backdrop(scene, { renderer, env });
  if (sg?.SunGlare) glare = new sg.SunGlare(scene, { renderer, camera, env });
  // resort dressing (safety nets, piste signs/markers) + terrain park, if built
  const rd = await optional('/src/world/resortdressing.js'), pk = await optional('/src/world/park.js');
  try { const grp = rd?.buildResortDressing?.(scene, models); if (grp && !grp.parent) scene.add(grp); } catch (e) { console.warn('resort dressing', e); }
  try { const grp = pk?.buildPark?.(scene, models); if (grp && !grp.parent) scene.add(grp); } catch (e) { console.warn('park', e); }
  post = new Post(renderer, scene, camera, 'ultra');
  env.update(0.016, camera, camPos);
  placeCamera();
  await stream();
  renderer.compile(scene, camera);
  look.ready = true;
  requestAnimationFrame(loop);
}

// ---- performance: the frame interval (and the WebGL2 timer query when the browser exposes it; on ANGLE/Metal its
// absolute values are unreliable) with each new look module, and some big existing systems, switched off in turn
const gl = renderer.getContext();
const tq = gl.getExtension('EXT_disjoint_timer_query_webgl2');
const perfOff = new Set();
let timing = null; // { gpu: [], frame: [], upd: [], sub: [], pending: [] } while measuring
let stockMat = null; // the terrain with a stock PBR material: what the custom snow/rock shading costs
const median = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[b.length >> 1] : NaN; };
const nextFrame = () => new Promise((r) => requestAnimationFrame(r));
async function measure(off, frames = 40) {
  perfOff.clear(); for (const o of off) perfOff.add(o);
  for (let i = 0; i < 12; i++) await nextFrame(); // settle
  timing = { gpu: [], frame: [], upd: [], sub: [], pending: [] };
  for (let i = 0; i < frames; i++) await nextFrame();
  for (let i = 0; i < 10 && timing.pending.length; i++) { await nextFrame(); pollTiming(); }
  const res = { gpu: median(timing.gpu), frame: median(timing.frame), upd: median(timing.upd), sub: median(timing.sub) };
  timing = null; perfOff.clear();
  await nextFrame(); // restore everything
  return res;
}
function pollTiming() {
  while (timing.pending.length) {
    const qq = timing.pending[0];
    if (!gl.getQueryParameter(qq, gl.QUERY_RESULT_AVAILABLE)) break;
    if (!gl.getParameter(tq.GPU_DISJOINT_EXT)) timing.gpu.push(gl.getQueryParameter(qq, gl.QUERY_RESULT) / 1e6);
    gl.deleteQuery(qq); timing.pending.shift();
  }
}
async function perfReport() {
  const cases = [['warm-up', []], ['all', []], ['-backdrop', ['backdrop']], ['-glare', ['glare']], ['-cloud cards', ['clouds']],
    ['-all new', ['backdrop', 'glare', 'clouds']], ['-trees', ['trees']], ['-terrain', ['terrain']], ['terrain stock PBR shader', ['stock']],
    ['-shadow render', ['shadows']], ['all again', []]];
  const info = renderer.info.render;
  for (const [label, off] of cases) {
    const r = await measure(off);
    if (label === 'warm-up') continue;
    console.error(`PERF ${view} ${label}: frame ${r.frame.toFixed(1)} ms (${(1000 / r.frame).toFixed(0)} fps), js update ${r.upd.toFixed(2)} ms, render submit ${r.sub.toFixed(2)} ms, gpu query ${r.gpu.toFixed(1)} ms, draws ${info.calls}, tris ${(info.triangles / 1000).toFixed(0)}k`);
  }
}
// black-frame hunt: mean colour of a few pixels of the finished frame with each system switched off in turn
let diagRead = null, diagPts = [[0.5, 0.15], [0.5, 0.5], [0.2, 0.8], [0.8, 0.7]];
async function diagReport() {
  const cases = [['all', []], ['-backdrop', ['backdrop']], ['-glare', ['glare']], ['-cloud cards', ['clouds']], ['-trees', ['trees']],
    ['-terrain', ['terrain']], ['terrain stock PBR shader', ['stock']], ['-sky dome', ['sky']], ['-stars+moon', ['stars']], ['-atmosphere', ['atmo']]];
  for (const [label, off] of cases) {
    perfOff.clear(); for (const o of off) perfOff.add(o);
    for (let i = 0; i < 8; i++) await nextFrame();
    diagRead = [];
    await nextFrame(); await nextFrame();
    const px = diagRead; diagRead = null;
    console.error(`DIAG ${view} ${label}: ${px.join(' ')}`);
  }
  perfOff.clear(); await nextFrame();
}

// switch systems off for a measurement (and back on afterwards)
function applyPerfToggles() {
  const off = (k) => perfOff.has(k);
  if (backdrop) backdrop.group.visible = !off('backdrop');
  if (glare) glare.mesh.visible = !off('glare');
  if (off('clouds') && atmosphere.cards) atmosphere.cards.visible = false;
  for (const m of [...vegetation.closeMeshes, ...vegetation.nearMeshes, ...vegetation.farMeshes]) m.visible = !off('trees');
  terrain.group.visible = !off('terrain');
  env.sky.visible = !off('sky');
  env.stars.visible = env.moon.visible = !off('stars');
  for (const o of [atmosphere.snow, atmosphere.mist, atmosphere.clouds, atmosphere.cards]) if (o && off('atmo')) o.visible = false;
  renderer.shadowMap.autoUpdate = !off('shadows');
  if (off('stock')) stockMat ??= new THREE.MeshStandardMaterial({ color: 0xdde6f2, roughness: 0.7 });
  for (const c of terrain.group.children) c.material = off('stock') ? stockMat : terrain.material;
}

const clock = new THREE.Clock();
let lastT = performance.now(), toggled = false;
renderer.info.autoReset = false; // counted per frame across all post passes (reset in loop)
function loop() {
  requestAnimationFrame(loop);
  renderer.info.reset();
  const t0 = performance.now();
  const dt = Math.min(0.05, clock.getDelta());
  placeCamera();
  env.update(dt, camera, camPos);
  terrain.update(camPos.x, camPos.z, 5);
  vegetation.update(camPos.x, camPos.z, dt, 3);
  atmosphere.update(dt, camera, env);
  // same order as main.js: the whiteout first, then the backdrop (multiplies its peak occlusion into
  // env.sunVisible), then the glare (reads both)
  scene.fog.near += atmosphere.cloudInside * 0.012;
  terrainUniforms.uSnowCover.value = env.snow;
  terrainUniforms.uSparkle.value = env.dayFactor * (1 - env.snow * 0.7) + env.nightFactor * 0.25;
  backdrop?.update(dt, camera, env);
  glare?.update(dt, camera, env);
  if (perfOff.size || toggled) { applyPerfToggles(); toggled = perfOff.size > 0; }
  const t1 = performance.now();
  if (timing && tq) {
    const qq = gl.createQuery();
    gl.beginQuery(tq.TIME_ELAPSED_EXT, qq);
    post.render(dt, 0, 0);
    gl.endQuery(tq.TIME_ELAPSED_EXT);
    timing.pending.push(qq);
    pollTiming();
  } else post.render(dt, 0, 0);
  if (diagRead) { // read back right after rendering (the drawing buffer is still valid in this task)
    const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight, p = new Uint8Array(4);
    for (const [fx, fy] of diagPts) {
      gl.readPixels(Math.floor(W * fx), Math.floor(H * (1 - fy)), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p);
      diagRead.push(`(${fx},${fy})=${p[0]},${p[1]},${p[2]}`);
    }
  }
  const now = performance.now();
  if (timing) { timing.frame.push(now - lastT); timing.upd.push(t1 - t0); timing.sub.push(now - t1); }
  lastT = now;
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight); post?.setSize(innerWidth, innerHeight);
});
boot().catch((e) => { console.error(e); document.title = 'ERR ' + e.message; });
