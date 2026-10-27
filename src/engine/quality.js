// Graphics presets: one table drives what every system may cost (render scale, MSAA, shadows, post passes,
// terrain LOD, forest reach, clouds, snowfall, floodlights, ambient skiers, prop detail). Systems read the live
// `quality` object when they build or update, so a level can also be switched while playing (auto-drop).
// Every preset starts at the screen's native resolution (Retina included): only while the frame rate can't be held
// does dynamic resolution step down, and never below 75 % of native (1.5x on Retina, 1x on a plain screen), so the
// image stays crisp on every level. The levels differ in what a frame costs besides resolution:
//  - performance: ~60 fps on an M1 MacBook Air (1440 x 900): no MSAA, no bloom / AO, small shadows, shorter reach
//  - balanced:    2x MSAA, bloom, medium shadows
//  - high / ultra: 4x MSAA, the full cinematic look (ambient occlusion, broadcast grade, snow sparkle)

export const QUALITY_ORDER = ['performance', 'balanced', 'high', 'ultra'];
export const QUALITY_LABELS = { performance: 'Performance', balanced: 'Balanced', high: 'High', ultra: 'Ultra' };
const LEGACY = { low: 'performance', medium: 'balanced' }; // saves from before the presets

export const PRESETS = {
  performance: {
    // render scale x devicePixelRatio (capped), dynamic resolution may drop to dynMin x DPR (never below dynFloor)
    // (it was 0.75 x DPR, dropping to 0.5 x DPR: half resolution on Retina, visibly blurry)
    scale: 1, prCap: 2, dynMin: 0.75, dynFloor: 1, fpsDrop: 50, fpsRaise: 57,
    msaa: 0, composer: false, bloom: false, ao: 0, shafts: false, grade: 2, // (the grade is a few ALU ops in the final pass)
    // (soft = three's bilinear PCF: 16 taps, as many as the plain PCF's 17, but no blocky texel edges)
    shadow: { size: 1024, extent: 55, soft: true, terrainCast: 128, propDist: 70 },
    terrain: { lodK: 1.6, detail: 0 },
    veg: { closeR: 22, nearR: 85, farR: 800, maxFar: 22000, rockR: 150, nearShadow: false },
    clouds: 150, flakes: 18000, crystals: 160, // (snowfall stays clearly visible: tiny points, cheap)
    lights: { lit: 5, obj: 3, nearLod: 90, farLod: 1200, beamR: 0 },
    npcs: { skiers: 7, walkers: 3, animNear: 45 },
    // big props: skipped when radius / distance < cull, shadows within shadowDist, LOD distances x lod
    // (the decimated LODs read as melted on a Retina screen when close: full detail out to ~140 m even here)
    props: { cull: 0.011, shadowDist: 70, lod: 1 },
    fog: 1.25, // hides the shorter forest / terrain reach
    powder: 0.5,
  },
  balanced: {
    scale: 1, prCap: 2, dynMin: 0.75, dynFloor: 1, fpsDrop: 45, fpsRaise: 56,
    msaa: 2, composer: true, bloom: true, ao: 0, shafts: false, grade: 2,
    shadow: { size: 2048, extent: 85, soft: true, terrainCast: 256, propDist: 110 },
    terrain: { lodK: 2.0, detail: 1 },
    veg: { closeR: 30, nearR: 125, farR: 1150, maxFar: 40000, rockR: 220, nearShadow: true },
    clouds: 280, flakes: 15000, crystals: 280,
    lights: { lit: 10, obj: 6, nearLod: 130, farLod: 1800, beamR: 240 },
    npcs: { skiers: 9, walkers: 4, animNear: 80 },
    props: { cull: 0.006, shadowDist: 120, lod: 1.2 },
    fog: 1.08,
    powder: 0.8,
  },
  high: {
    scale: 1, prCap: 2, dynMin: 0.75, dynFloor: 1, fpsDrop: 38, fpsRaise: 55,
    msaa: 4, composer: true, bloom: true, ao: 1, shafts: false, grade: 2,
    shadow: { size: 4096, extent: 110, soft: true, terrainCast: 1024, propDist: 200 },
    terrain: { lodK: 2.5, detail: 2 },
    veg: { closeR: 35, nearR: 160, farR: 1500, maxFar: 60000, rockR: 260, nearShadow: true },
    clouds: 420, flakes: 26000, crystals: 520,
    lights: { lit: 16, obj: 8, nearLod: 160, farLod: 2200, beamR: 340 },
    npcs: { skiers: 12, walkers: 6, animNear: 120 },
    props: { cull: 0.0025, shadowDist: 240, lod: 1.5 },
    fog: 1,
    powder: 1,
  },
  ultra: {
    scale: 1, prCap: 3, dynMin: 0.85, dynFloor: 1.25, fpsDrop: 36, fpsRaise: 55,
    msaa: 4, composer: true, bloom: true, ao: 2, shafts: true, grade: 2,
    shadow: { size: 4096, extent: 130, soft: true, terrainCast: 1024, propDist: 260 },
    terrain: { lodK: 2.8, detail: 2 },
    veg: { closeR: 42, nearR: 190, farR: 1500, maxFar: 60000, rockR: 260, nearShadow: true },
    clouds: 420, flakes: 26000, crystals: 520,
    lights: { lit: 16, obj: 8, nearLod: 200, farLod: 2200, beamR: 340 },
    npcs: { skiers: 14, walkers: 6, animNear: 160 },
    props: { cull: 0, shadowDist: 300, lod: 1.8 },
    fog: 1,
    powder: 1.2,
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
  Object.assign(quality, PRESETS[q], { name: q });
  for (const fn of listeners) fn(quality);
  return q;
}

export function onQualityChange(fn) { listeners.push(fn); }

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
  if (mem <= 4 || cores <= 4) q = 'performance';
  else if (apple) {
    const gen = Number(apple[1]), tier = apple[2];
    if (tier) q = gen >= 3 || /Max|Ultra/i.test(tier) ? 'high' : 'balanced';
    else q = gen <= 2 ? 'performance' : 'balanced';
  } else if (/Intel|Mali|Adreno|PowerVR|SwiftShader|llvmpipe|Microsoft Basic/i.test(gpu)) q = 'performance';
  else if (/NVIDIA|GeForce|RTX|Radeon RX|Radeon Pro/i.test(gpu)) q = 'high';
  else q = 'balanced';
  return { quality: q, gpu, mem, cores };
}
