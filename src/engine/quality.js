// Graphics presets: one table drives what every system may cost (render scale, MSAA, shadows, post passes,
// terrain LOD, forest reach, clouds, snowfall, floodlights, ambient skiers, prop detail). Systems read the live
// `quality` object when they build or update, so a level can also be switched while playing (auto-drop).
// Every preset starts at the screen's native resolution (Retina included): only while the frame rate can't be held
// does dynamic resolution step down, and never below 75 % of native (1.5x on Retina, 1x on a plain screen), so the
// image stays crisp on every level. The levels differ in what a frame costs besides resolution:
//  - performance: ~60 fps on an M1 MacBook Air (1440 x 900): no MSAA, no bloom / AO, small shadows, shorter reach
//  - balanced:    2x MSAA, bloom, medium shadows
//  - high / ultra: 4x MSAA, the full cinematic look (ambient occlusion, broadcast grade, snow sparkle)
//  - super (SUPER PERFORMANCE, Oct 30, the user: "add a super performance mode that is supeeerrr!!!! optimized"): for
//    8 GB MacBook Airs and old Intel Macs. ~0.6x render scale, no MSAA / shadows / bloom / AO (only the one cheap
//    final pass: tone map + a light grade), no live window views, a short draw distance behind thicker haze,
//    the lowest terrain detail, thin forests, few skiers / walkers / fans, a little snowfall, small textures.
//    Physics and gameplay are untouched (the same for everyone).
// Extra fields: portals (false: no live window views), texCap (largest model colour map side, applied while loading;
// normal / roughness maps get half; absent = as authored), aniso (anisotropic filtering, absent = 16x), traffic
// (share of the road traffic kept, absent = all), carLod (x the distance cars switch to their one-piece LOD), pointLights (false: none in the world).
// Nov 1 2026 graphics pass (the user: "make the graphics amazing on Ultra, super good on High, good on Balanced"; then
// "up them even more with a SUPER ULTRA", Performance / Super Performance stay exactly as they were):
//  - fx: one number per tier for shaders to gate on (super / performance 0, balanced 1, high 2, ultra 3, superultra 4)
//  - ss / ssMP: supersampling on plain (DPR < 1.75) screens: render at up to ss x the screen's pixels, capped at ssMP
//    megapixels so a 4K monitor isn't rendered at 8K (Retina screens keep their native 2x: never below it)
//  - dynPanic: dynamic resolution never goes below the screen's native resolution (dynMin 1) unless a whole second
//    runs under 30 fps; then down to dynPanic x DPR, and back up as soon as it can
//  - smaa: SMAA after the final pass (the last shimmer MSAA leaves on thin lines, alpha-tested needles, specular)
//  - gtao: horizon-based ambient occlusion (GTAO) instead of the SAO estimate; aoRes = its resolution against the
//    screen's native pixels (1 full, 0.5 half); aoDirs / aoSteps = slices x samples per side
//  - tone: 'neutral' = Khronos PBR Neutral tone mapping (snow stays white with its highlight detail, no ACES hue
//    skew) with a gentle filmic contrast; absent = ACES as before. maxAniso: every texture at the GPU's maximum.

export const QUALITY_ORDER = ['super', 'performance', 'balanced', 'high', 'ultra', 'superultra'];
export const QUALITY_LABELS = { super: 'Super Performance', performance: 'Performance', balanced: 'Balanced', high: 'High', ultra: 'Ultra', superultra: 'Super Ultra' };
const LEGACY = { low: 'performance', medium: 'balanced' }; // saves from before the presets

export const PRESETS = {
  super: {
    scale: 0.6, prCap: 1.25, dynMin: 0.5, dynFloor: 0.5, fpsDrop: 52, fpsRaise: 58,
    msaa: 0, composer: false, bloom: false, ao: 0, shafts: false, grade: 1, portals: false,
    shadow: { size: 0, extent: 40, soft: true, terrainCast: 0, propDist: 0 }, // (soft as the others: no shadow-type recompile)
    terrain: { lodK: 1.15, detail: 0 },
    veg: { closeR: 12, nearR: 50, farR: 420, maxFar: 6000, rockR: 80, nearShadow: false },
    clouds: 60, flakes: 2500, crystals: 0,
    lights: { lit: 3, obj: 2, nearLod: 55, farLod: 600, beamR: 0 },
    npcs: { skiers: 3, walkers: 1, animNear: 25 },
    props: { cull: 0.022, shadowDist: 0, lod: 0.5 },
    fog: 1.9,
    powder: 0.25,
    texCap: 512, aniso: 2, traffic: 0.5, carLod: 0.3, pointLights: false,
    fx: 0,
  },
  performance: {
    // render scale x devicePixelRatio (capped), dynamic resolution may drop to dynMin x DPR (never below dynFloor)
    // (it was 0.75 x DPR, dropping to 0.5 x DPR: half resolution on Retina, visibly blurry)
    scale: 1, prCap: 2, dynMin: 0.75, dynFloor: 1, fpsDrop: 50, fpsRaise: 57,
    msaa: 0, composer: false, bloom: false, ao: 0, shafts: false, grade: 2, // (the grade is a few ALU ops in the final pass)
    // (soft = three's bilinear PCF: 16 taps, as many as the plain PCF's 17, but no blocky texel edges)
    shadow: { size: 1024, extent: 55, soft: true, terrainCast: 128, propDist: 70, every: 2 }, // (every: redrawn every other frame while the view stays put, engine/post.js)
    terrain: { lodK: 1.6, detail: 0 },
    veg: { closeR: 22, nearR: 85, farR: 800, maxFar: 22000, rockR: 150, nearShadow: false },
    clouds: 150, flakes: 18000, crystals: 160, // (snowfall stays clearly visible: tiny points, cheap)
    lights: { lit: 5, obj: 3, nearLod: 90, farLod: 1200, beamR: 0 },
    npcs: { skiers: 7, walkers: 3, animNear: 45 },
    // big props: skipped when radius / distance < cull, shadows within shadowDist, LOD distances x lod
    // (the decimated LODs read as melted on a Retina screen when close: full detail out to ~140 m even here)
    props: { cull: 0.011, shadowDist: 70, lod: 0.8 }, // (Oct 30: 112 m; every model also has a far copy from 3x that, assets.js makeLOD)
    fog: 1.25, // hides the shorter forest / terrain reach
    powder: 0.5,
    pointLights: false, // (no point lights in the world: engine/detail.js sweepLights; the bulbs still glow)
    carLod: 0.55, // (parked / passing cars: the full model (dozens of parts) out to 38 m, the one-piece LOD beyond)
    texCap: 1024, aniso: 4, // (model maps: 1024 px colour, 512 px normal / roughness: a quarter of the memory)
    fx: 0,
  },
  balanced: {
    // (Nov 1: SMAA, a little more reach and detail; still 2x MSAA, no AO: smooth on a normal laptop)
    scale: 1, prCap: 2, dynMin: 0.75, dynFloor: 1, fpsDrop: 45, fpsRaise: 56,
    msaa: 2, composer: true, bloom: true, ao: 0, shafts: false, grade: 2, smaa: true,
    shadow: { size: 2048, extent: 90, soft: true, terrainCast: 256, propDist: 120 },
    terrain: { lodK: 2.2, detail: 1 },
    veg: { closeR: 32, nearR: 135, farR: 1300, maxFar: 45000, rockR: 230, nearShadow: true },
    clouds: 300, flakes: 16000, crystals: 320,
    lights: { lit: 10, obj: 6, nearLod: 140, farLod: 2000, beamR: 260 },
    npcs: { skiers: 10, walkers: 4, animNear: 90 },
    props: { cull: 0.005, shadowDist: 130, lod: 1.35 },
    fog: 1.06,
    powder: 0.85,
    texCap: 2048, aniso: 8, carLod: 0.9,
    fx: 1,
  },
  high: {
    // (Nov 1: 1.25x supersampling on a plain screen, never below native resolution, 4x MSAA + SMAA, half-res GTAO,
    // sun shafts, a larger shadow area, farther forests / terrain detail / props)
    scale: 1, prCap: 2, dynMin: 1, dynFloor: 1, dynPanic: 0.75, fpsDrop: 38, fpsRaise: 52, ss: 1.25, ssMP: 3.6,
    msaa: 4, composer: true, bloom: true, ao: 1, shafts: true, grade: 2, smaa: true,
    gtao: true, aoRes: 0.5, aoDirs: 2, aoSteps: 6,
    shadow: { size: 4096, extent: 120, soft: true, terrainCast: 1024, propDist: 230 },
    terrain: { lodK: 2.9, detail: 2 },
    veg: { closeR: 40, nearR: 185, farR: 1850, maxFar: 60000, rockR: 300, nearShadow: true },
    clouds: 420, flakes: 26000, crystals: 520,
    lights: { lit: 16, obj: 8, nearLod: 190, farLod: 2600, beamR: 380 },
    npcs: { skiers: 14, walkers: 7, animNear: 140 },
    props: { cull: 0.0015, shadowDist: 290, lod: 2 },
    fog: 1,
    powder: 1.1,
    fx: 2,
  },
  ultra: {
    // (Nov 1: 1.5x supersampling on a plain screen (6 MP at most), 8x MSAA where the GPU has it + SMAA, full-res
    // GTAO, PBR Neutral tone mapping, every texture at maximum anisotropy, 6144 px shadows over a wider area)
    scale: 1, prCap: 3, dynMin: 1, dynFloor: 1, dynPanic: 0.8, fpsDrop: 36, fpsRaise: 50, ss: 1.5, ssMP: 6,
    msaa: 8, composer: true, bloom: true, ao: 2, shafts: true, grade: 2, smaa: true,
    gtao: true, aoRes: 1, aoDirs: 3, aoSteps: 8, tone: 'neutral', maxAniso: true,
    shadow: { size: 6144, extent: 145, soft: true, terrainCast: 1024, propDist: 320 },
    terrain: { lodK: 3.3, detail: 2 },
    veg: { closeR: 48, nearR: 220, farR: 2300, maxFar: 60000, rockR: 340, nearShadow: true },
    clouds: 420, flakes: 26000, crystals: 520,
    lights: { lit: 16, obj: 8, nearLod: 240, farLod: 3000, beamR: 420 },
    npcs: { skiers: 17, walkers: 8, animNear: 180 },
    props: { cull: 0, shadowDist: 380, lod: 2.5 },
    fog: 1,
    powder: 1.35,
    fx: 3,
  },
  superultra: {
    // SUPER ULTRA (Nov 1, the user: "up them even more with a SUPER ULTRA"): for big desktop GPUs. 2x supersampling
    // on a plain screen (9 MP at most), 8x MSAA + SMAA, full-res GTAO with more slices, 8192 px shadows, the
    // longest reach of everything. Never picked automatically.
    scale: 1, prCap: 3, dynMin: 1, dynFloor: 1, dynPanic: 0.85, fpsDrop: 30, fpsRaise: 48, ss: 2, ssMP: 9,
    msaa: 8, composer: true, bloom: true, ao: 2, shafts: true, grade: 2, smaa: true,
    gtao: true, aoRes: 1, aoDirs: 4, aoSteps: 10, tone: 'neutral', maxAniso: true,
    shadow: { size: 8192, extent: 170, soft: true, terrainCast: 2048, propDist: 420 },
    terrain: { lodK: 3.8, detail: 2 },
    veg: { closeR: 56, nearR: 260, farR: 2900, maxFar: 60000, rockR: 400, nearShadow: true },
    clouds: 420, flakes: 26000, crystals: 520,
    lights: { lit: 16, obj: 8, nearLod: 300, farLod: 3600, beamR: 480 },
    npcs: { skiers: 20, walkers: 9, animNear: 220 },
    props: { cull: 0, shadowDist: 480, lod: 3.2 },
    fog: 1,
    powder: 1.5,
    fx: 4,
  },
};

export const quality = { name: 'high', ...PRESETS.high };
const listeners = [];

export function normalizeQuality(name) {
  const q = LEGACY[name] || name;
  return PRESETS[q] ? q : null;
}

export function setQuality(name) {
  const q = normalizeQuality(name) || 'high';
  for (const k of Object.keys(quality)) if (!(k in PRESETS[q])) delete quality[k]; // (super's extra flags don't stick)
  Object.assign(quality, PRESETS[q], { name: q });
  for (const fn of listeners) fn(quality);
  return q;
}

export function onQualityChange(fn) { listeners.push(fn); }

// What the GPU allows (main.js fills it once the renderer exists): MSAA samples, anisotropy, texture size.
export const gpuCaps = { maxSamples: 4, maxAniso: 16, maxTexture: 4096 };
export function readGpuCaps(renderer) {
  const c = renderer.capabilities;
  gpuCaps.maxSamples = c.maxSamples || 4;
  gpuCaps.maxAniso = c.getMaxAnisotropy?.() || 16;
  gpuCaps.maxTexture = c.maxTextureSize || 4096;
}

// The preset's pixel ratio for a w x h (CSS px) window: the screen's own resolution (capped by prCap), on a plain
// screen supersampled toward ss x within the ssMP budget (in 1/8 steps). Without ss: exactly as before.
export function presetPixelRatio(dpr, w, h) {
  const native = Math.min(dpr * quality.scale, quality.prCap);
  if (!quality.ss || dpr >= 1.75) return native;
  const budget = Math.sqrt((quality.ssMP || 8) * 1e6 / Math.max(1, w * h));
  return Math.max(native, Math.floor(Math.min(dpr * quality.ss, budget, 3) * 8) / 8);
}

export function lowerQuality(name) {
  const i = QUALITY_ORDER.indexOf(normalizeQuality(name));
  return i > 0 ? QUALITY_ORDER[i - 1] : null;
}

// devicePixelRatio (dev override for tests: localStorage 'ski-legacy-dpr' = 2 emulates a Retina screen)
export function screenDPR() {
  let o = 0;
  try { o = Number(localStorage.getItem('ski-legacy-dpr')) || 0; } catch { /* storage unavailable */ }
  return o || globalThis.devicePixelRatio || 1;
}

// First-launch guess from the GPU name and memory: entry Apple silicon / integrated graphics -> Performance,
// mid-range -> Balanced, Pro / Max chips and discrete GPUs -> High. The first seconds of play correct it.
export function detectQuality(renderer) {
  let gpu = '';
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    gpu = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  } catch { /* no GPU name */ }
  const mem = navigator.deviceMemory || 8, cores = navigator.hardwareConcurrency || 8;
  const apple = gpu.match(/Apple M(\d+)\s*(Pro|Max|Ultra)?/i);
  let q;
  // (Oct 30: still "very slow on some machines": the base M1 / M2 with 8 GB and older Intel graphics start on the
  // lighter presets; Super Performance for software renderers, 4 GB machines and old Intel HD graphics)
  const soft = /SwiftShader|llvmpipe|softpipe|Microsoft Basic/i.test(gpu);
  const oldIntel = /Intel/i.test(gpu) && !/Iris\s*(Pro|Plus|Xe)|Arc/i.test(gpu);
  if (soft || mem <= 4 || cores <= 2) q = 'super';
  else if (cores <= 4) q = oldIntel ? 'super' : 'performance';
  else if (apple) {
    const gen = Number(apple[1]), tier = apple[2];
    if (tier) q = gen >= 3 || /Max|Ultra/i.test(tier) ? 'high' : 'balanced';
    else q = gen <= 2 ? 'performance' : 'balanced';
  } else if (oldIntel) q = 'super';
  else if (/Intel|Mali|Adreno|PowerVR/i.test(gpu)) q = 'performance';
  else if (/NVIDIA|GeForce|RTX|Radeon RX|Radeon Pro/i.test(gpu)) q = 'high';
  else q = 'balanced';
  return { quality: q, gpu, mem, cores };
}
