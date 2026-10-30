// Sky, sun/moon, stars, lighting, IBL environment, fog — all driven by time of day + weather.
// The clear-day look is tuned to the Ski Legacy logo: deep cobalt zenith, clean cerulean mid-sky, a pale
// cyan-white haze band on the horizon, an HDR sun (blooms; the starburst itself is world/sunglare.js),
// cool blue aerial perspective and blue ambient so shadowed snow reads blue against a strong warm sun.
import * as THREE from 'three';
import { smoothstep, lerp } from '../core/noise.js';

const DAY_SECONDS = 16 * 60; // real seconds for a full 24h day (1 game hour = 40s)

// Weather types the sky drifts between automatically. snow = snowfall, cloud = overcast, mist = fog banks.
// (Oct 30 2026, the user approved five more, "but don't go over the top with weather": all subtle and rare, and
// "no closing ski pistes": weather never closes a piste or a lift. Their extras, each 0..1 and eased in update():
// wind = gusts (sideways snow, a barely felt push on the skis, louder wind), clear = föhn's far views (less haze),
// wet = sleet below the rain line near the village, frost = freezing fog's rime tint on the trees, sea = the sea of
// clouds (the overcast deck low in the valley, sunny above it; atmosphere.js).)
export const WEATHER = {
  clear:    { label: 'Clear',         snow: 0,    cloud: 0,    mist: 0.1 },
  flurries: { label: 'Snow flurries', snow: 0.34, cloud: 0.3,  mist: 0.15 }, // sun and snow at once
  cloudy:   { label: 'Cloudy',        snow: 0,    cloud: 0.7,  mist: 0.25 },
  light:    { label: 'Light snow',    snow: 0.55, cloud: 0.75, mist: 0.3 },
  heavy:    { label: 'Heavy snow',    snow: 1,    cloud: 1,    mist: 0.45 },
  mist:     { label: 'Misty',         snow: 0,    cloud: 0.45, mist: 1 },
  // ("strong wind, snow blowing sideways and fast", short and "you can still see far enough to ski": no whiteout)
  blizzard: { label: 'Blizzard',      snow: 0.9,  cloud: 1,    mist: 0.5,  wind: 1 },
  // ("warm, very windy, crystal clear, far views"; the snow a touch heavier and slower)
  foehn:    { label: 'Föhn',          snow: 0,    cloud: 0.06, mist: 0,    wind: 0.6, clear: 1 },
  // ("rain/sleet below a height near the village ... turning to wet snow higher up")
  sleet:    { label: 'Wet snow',      snow: 0.45, cloud: 0.85, mist: 0.35, wet: 1 },
  // ("thick low fog, white frost look on trees")
  fog:      { label: 'Freezing fog / Raureif', snow: 0, cloud: 0.4, mist: 1, frost: 1 },
  // ("a cloud layer filling the valley below a height, sunny above it")
  inversion: { label: 'Sea of clouds', snow: 0,   cloud: 0,    mist: 0.12, sea: 1 },
};
// which weather tends to follow which (a loose real-world progression). Snow comes round regularly: some snow
// is falling ~40 % of the time and nearly every half hour of play sees it (it used to take three lucky draws in
// a row, so it hardly ever snowed), while the clear cobalt-sky weather of the logo stays the most common state
// (~1/3 of the time). (Oct 30 2026, the new ones kept rare: "blizzard only after heavy, föhn and inversion after
// clear"; clear: 1 in 20 each, heavy: 1 in 4 blizzard, none holds on by itself. Mirrored by the server's
// WEATHER_NEXT, server/lib/server.js: keep the two in step.)
export const NEXT = {
  clear: ['clear', 'clear', 'clear', 'clear', 'clear', 'clear', 'clear', 'clear', 'flurries', 'flurries', 'flurries', 'flurries', 'cloudy', 'cloudy', 'cloudy', 'mist', 'mist', 'mist', 'foehn', 'inversion'],
  flurries: ['clear', 'clear', 'light', 'flurries', 'cloudy'],
  cloudy: ['light', 'clear', 'flurries', 'heavy', 'clear', 'cloudy', 'light', 'clear', 'flurries', 'sleet'],
  light: ['heavy', 'cloudy', 'flurries', 'light', 'cloudy', 'heavy', 'cloudy', 'flurries', 'light', 'sleet'],
  heavy: ['light', 'cloudy', 'light', 'blizzard'],
  mist: ['clear', 'flurries', 'cloudy', 'clear', 'flurries', 'cloudy', 'clear', 'flurries', 'cloudy', 'fog'],
  blizzard: ['heavy', 'light'],
  foehn: ['clear', 'clear', 'cloudy'],
  sleet: ['light', 'cloudy', 'cloudy'],
  fog: ['mist', 'cloudy', 'clear'],
  inversion: ['clear', 'clear', 'mist'],
};
export const pickWeather = (w) => { const o = NEXT[w] || NEXT.clear; return o[Math.floor(Math.random() * o.length)]; };
/** How long a weather holds (s): 80-180, a blizzard only 60-120 ("a few minutes at most"). Server: weatherHoldMs. */
export const weatherHold = (w) => (w === 'blizzard' ? 60 + Math.random() * 60 : 80 + Math.random() * 100);
// (Oct 30 2026: weather side effects, read by the systems that are not handed the Environment: player.js (wind
// push, glide), drive.js (icy roads), audio.js (wind). Written by Environment.update every frame.)
export const weatherFx = {
  gustX: 0, gustZ: 0, // m/s^2 sideways push on the skis (blizzard, föhn gusts; barely noticeable)
  glide: 1,           // ski glide friction multiplier (föhn: heavier snow, ~6 % more)
  icy: 0,             // 0..1 icy roads, for a few minutes after heavy snow / blizzard / sleet / freezing fog
  plough: 0,          // 0..1 the snow ploughs go out more after heavy snow or a blizzard (snowcats.js)
  wind: 0,            // 0..1 storm wind (audio)
};
// (wet snow / freezing fog / heavy snow / blizzard leave the roads icy; ploughs after heavy snow / blizzard)
const ICY_WX = new Set(['heavy', 'blizzard', 'sleet', 'fog']), PLOUGH_WX = new Set(['heavy', 'blizzard']);

// ---------------------------------------------------------------------------------------------------
// Time-of-day palette. Keyframes by sun height (sin of the sun's elevation): night, blue hour, civil dusk,
// sunset, low golden sun, golden hour, full day. Colours are linear HDR, solved through the game's output
// (ACES filmic, exposure 0.72, sRGB) so they display as the sRGB values in the comments. The day column
// is fitted to the logo: zenith #0b3b8d, 30° #0d55b0, 11° #2a86dc, 6° #5aa8ec, horizon #cfe9fb.
// (With the low winter sun path the full day palette holds from ~9:40 to ~14:20, golden ~7:25 / ~16:35.)
const KEYS = [-0.35, -0.16, -0.05, 0.02, 0.10, 0.24, 0.45];
const C = (r, g, b) => new THREE.Color(r, g, b);
const PAL = {
  // sky gradient: col = mix(mix(zenith, mid, exp(-h*2.5)), horizon, exp(-h*16)), h = sin(elevation)
  zenith: [C(0.0140, 0.0260, 0.0750), C(0.0125, 0.0226, 0.0634), C(0.0175, 0.0309, 0.1006), C(0.0225, 0.0430, 0.1477),
    C(0.0273, 0.0529, 0.1691), C(0.0313, 0.0587, 0.1947), C(0.0313, 0.0583, 0.2011)], // night #061334 ... day #0c3c8c
  mid: [C(0.0200, 0.0380, 0.1000), C(0.0311, 0.0493, 0.1741), C(0.0533, 0.0927, 0.3012), C(0.0681, 0.1781, 0.5578),
    C(0.0386, 0.2363, 0.8628), C(0.0131, 0.2700, 1.1346), C(0.0417, 0.3990, 1.4235)], // 10 deg: ... day #4a9ce4
  horizon: [C(0.0300, 0.0520, 0.1250), C(0.0592, 0.0795, 0.2081), C(0.1917, 0.1697, 0.3356), C(0.5128, 0.3552, 0.5701),
    C(0.5074, 0.7318, 1.5213), C(0.5204, 1.1992, 2.9277), C(0.3156, 1.5195, 5.2906)], // sunset belt #b39ab9, day #c9e6fb
  // horizon toward the sun (warm at golden hour / sunset): dusk #dc764c, sunset #ffa058, golden #f3eedb, day #d8eefc
  glow: [C(0.0300, 0.0520, 0.1250), C(0.0858, 0.0915, 0.2319), C(0.8592, 0.2017, 0.0988), C(1.8594, 0.3212, 0.0924),
    C(3.1807, 0.8578, 0.2631), C(2.8088, 2.1991, 0.9815), C(0.4458, 2.1394, 6.6786)],
  // aureole around the sun (Mie forward scattering, additive): cyan-white by day, gold at sunset
  halo: [C(0, 0, 0), C(0, 0, 0), C(0.5000, 0.1200, 0.0300), C(3.0000, 1.0000, 0.2500),
    C(2.6000, 1.6000, 0.7000), C(1.2000, 1.6000, 2.4000), C(0.1500, 1.3000, 5.2000)],
  // distant-terrain haze (blue aerial perspective), also the sky below the horizon
  fog: [C(0.0240, 0.0400, 0.0980), C(0.0402, 0.0541, 0.1289), C(0.1188, 0.1224, 0.2646), C(0.2309, 0.2254, 0.4413),
    C(0.2708, 0.3673, 0.8300), C(0.2162, 0.4526, 1.2098), C(0.1633, 0.4992, 1.6117)], // day #7fb2ea
  // sunlight colour (DirectionalLight) and intensity: strong and slightly warm by day
  sun: [C(1, 0.4, 0.2), C(1, 0.4, 0.2), C(1, 0.42, 0.2), C(1.0, 0.48, 0.24),
    C(1.0, 0.68, 0.42), C(1.0, 0.84, 0.64), C(1.0, 0.93, 0.82)], // (day: a touch warmer against the blue shade)
  sunI: [0, 0, 0, 1.4, 4.0, 5.4, 6.0],
  // sun disc colour (normalised; HDR scale applied in update)
  disc: [C(1, 0.3, 0.1), C(1, 0.3, 0.1), C(1, 0.32, 0.1), C(1.0, 0.42, 0.14),
    C(1.0, 0.7, 0.42), C(1.0, 0.9, 0.76), C(1.0, 0.97, 0.93)],
  // ambient: hemisphere sky colour (normalised, also read by the cloud shader) and IBL strength
  amb: [C(0.10, 0.14, 0.28), C(0.18, 0.22, 0.45), C(0.42, 0.36, 0.62), C(0.52, 0.48, 0.78),
    C(0.46, 0.56, 0.92), C(0.40, 0.58, 1.0), C(0.38, 0.58, 1.0)],
  envI: [0.6, 0.8, 0.9, 0.95, 1.0, 1.0, 1.0],
};
// overcast deck (multiplied by the light level of the hour)
const OVER_TOP = C(0.330, 0.400, 0.505), OVER_HOR = C(0.700, 0.820, 0.990), OVER_FOG = C(0.520, 0.640, 0.820);
const WARM_TINT = C(1.25, 0.95, 0.78); // overcast at dawn/dusk
const MIST_FOG = C(0.62, 0.78, 1.02); // bright blue-white of dense valley mist / whiteout

function samplePalette(arr, i, t, out) { return out.copy(arr[i]).lerp(arr[i + 1], t); }
const sampleNum = (arr, i, t) => arr[i] + (arr[i + 1] - arr[i]) * t;

// Tileable value-noise fbm (R, G: independent fbm, B: ridged) for cirrus wisps and overcast texture.
function makeSkyNoise() {
  const S = 128, data = new Uint8Array(S * S * 4);
  const lattice = (seed, n) => {
    const g = new Float32Array(n * n);
    let x = seed * 7919 + 104729;
    for (let i = 0; i < g.length; i++) { x = (x * 48271) % 2147483647; g[i] = (x % 100000) / 100000; }
    return g;
  };
  const sample = (g, n, x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    const at = (i, j) => g[(((j % n) + n) % n) * n + (((i % n) + n) % n)];
    const a = at(xi, yi), b = at(xi + 1, yi), c = at(xi, yi + 1), d = at(xi + 1, yi + 1);
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
  };
  const U = 4, OCT = 5;
  const layers = [1, 40, 80].map((seed) => Array.from({ length: OCT }, (_, o) => lattice(seed + o, U << o)));
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
    const x = (i / S) * U, y = (j / S) * U, o4 = (j * S + i) * 4;
    for (let ch = 0; ch < 3; ch++) {
      let s = 0, amp = 0.5, norm = 0;
      for (let o = 0; o < OCT; o++) {
        let v = sample(layers[ch][o], U << o, x * (1 << o), y * (1 << o));
        if (ch === 2) v = 1 - Math.abs(v * 2 - 1); // ridged: thin bright filaments
        s += amp * v; norm += amp; amp *= 0.5;
      }
      data[o4 + ch] = Math.round((s / norm) * 255);
    }
    data[o4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

const SKY_VERT = `varying vec3 vDir;
  void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position.z = gl_Position.w; }`;

// The visible sky. Linear HDR out (tone mapped later by the post chain).
const SKY_FRAG = `
  uniform vec3 uSunDir, uMoonDir, uZenith, uMid, uHorizon, uGlow, uHalo, uHaloBroad, uSunColor, uGround, uMoonGlow, uWisp;
  uniform float uDusk, uSunSize, uTime, uCirrus, uOvercast, uHazeK;
  uniform sampler2D uNoise;
  varying vec3 vDir;
  float skyHash(vec2 p){ vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
  void main(){
    vec3 d = normalize(vDir);
    float e = d.y, h = max(e, 0.0);
    // angular distance to the sun (chord length: precise near the disc, ~radians for small angles)
    float ang = length(d - uSunDir);
    // 0 = looking away from the sun's azimuth, 1 = toward it
    vec2 dh = d.xz * inversesqrt(max(dot(d.xz, d.xz), 1e-8));
    vec2 sh = uSunDir.xz * inversesqrt(max(dot(uSunDir.xz, uSunDir.xz), 1e-8));
    float az = dot(dh, sh) * 0.5 + 0.5;

    // deep cobalt zenith -> cerulean -> pale haze band on the horizon (warmer toward the sun at dusk)
    vec3 col = mix(uZenith, uMid, exp(-h * 2.5));
    vec3 hz = mix(uHorizon, uGlow, az * az * az);
    col = mix(col, hz, exp(-h * uHazeK));
    // the sunset glow climbs higher on the sun's side
    col += uGlow * (uDusk * 0.35) * (az * az * az * az) * exp(-h * 7.0);

    // aureole: cyan-white glow around the sun (tight + wide lobes), broad bright patch through overcast
    col += uHalo * (exp(-ang * 40.0) + exp(-ang * 12.0) * 0.45 + exp(-ang * 3.5) * 0.12);
    col += uHaloBroad * exp(-ang * 3.0);
    // moon halo at night
    float mang = length(d - uMoonDir);
    col += uMoonGlow * (exp(-mang * 30.0) * 0.5 + exp(-mang * 5.0) * 0.12);

    // a few high cirrus wisps drifting slowly (fair weather only), in patches, faded out toward the horizon
    if (uCirrus > 0.001 && e > 0.02) {
      vec2 p = d.xz / (e + 0.22);
      p = vec2(p.x * 0.8 + p.y * 0.6, p.y * 0.8 - p.x * 0.6) + vec2(uTime * 0.004, uTime * 0.0012);
      float cover = smoothstep(0.42, 0.68, texture2D(uNoise, p * 0.11 + 0.37).g);
      float n1 = texture2D(uNoise, p * vec2(0.22, 0.9)).r;
      float n2 = texture2D(uNoise, p * vec2(0.6, 2.6) + vec2(n1 * 0.4, 0.0)).b;
      float w = smoothstep(0.56, 0.84, n1 * 0.55 + n2 * 0.45) * cover;
      w *= smoothstep(0.02, 0.25, e) * uCirrus;
      vec3 wc = uWisp * (0.8 + 1.4 * exp(-ang * 4.0));
      col = mix(col, wc, w * 0.38);
    }
    // overcast: soft large cloud masses in the grey deck
    if (uOvercast > 0.001) {
      vec2 q = d.xz / (h + 0.25) * 0.06 + vec2(uTime * 0.0009, 0.0);
      float m = texture2D(uNoise, q).r * 0.65 + texture2D(uNoise, q * 2.7 + 3.1).g * 0.35;
      col *= 1.0 + (m - 0.5) * 0.32 * uOvercast * smoothstep(0.0, 0.25, h);
    }

    // below the horizon: blend into the distant-terrain haze (matches the fog colour)
    col = mix(col, uGround, smoothstep(0.0, -0.07, e));

    // HDR sun disc with limb darkening (blooms through the post chain)
    float R = 0.0085 * uSunSize;
    float aa = max(fwidth(ang), 1e-5) * 1.5;
    float disc = 1.0 - smoothstep(R - aa, R + aa, ang);
    float limb = sqrt(max(1.0 - (ang * ang) / (R * R), 0.0));
    col += uSunColor * disc * (0.55 + 0.45 * limb);

    // tiny dither so the smooth gradients never band after 8-bit output
    col *= 1.0 + (skyHash(gl_FragCoord.xy) - 0.5) * 0.016;
    gl_FragColor = vec4(col, 1.0);
  }`;

// The sky the IBL is captured from: a softer, less saturated version (no disc or wisps, snow bounce below),
// so ambient light is clearly blue in the shade without over-saturating.
const ENV_FRAG = `
  uniform vec3 uSunDir, uEnvZenith, uEnvHorizon, uEnvGround, uEnvSun;
  varying vec3 vDir;
  void main(){
    vec3 d = normalize(vDir);
    float e = d.y;
    vec3 col = mix(uEnvHorizon, uEnvZenith, smoothstep(0.0, 0.65, e));
    col = mix(col, uEnvGround, smoothstep(0.03, -0.2, e));
    float c = max(dot(d, uSunDir), 0.0);
    col += uEnvSun * (c * c * c * 0.35 + pow(c, 24.0) * 0.8);
    gl_FragColor = vec4(col, 1.0);
  }`;

export class Environment {
  constructor(renderer, scene) {
    this.renderer = renderer;
    this.scene = scene;
    this.hour = 9.5;
    this.timeScale = 1;
    this.snow = 0; // 0..1 snowfall intensity (weather)
    this.weatherTarget = 0;
    this.weather = 'clear';
    this.cloud = 0; // overcast amount
    this.mist = 0.1; // fog banks / valley mist
    this.weatherTimer = 75; // a clear spell first, then the weather starts changing
    // (Oct 30 2026, the user: a forecast line "Later: Blizzard"; single player draws it ahead, multiplayer gets it
    // from the server's clock (net/session.js sets upcoming / upcomingIn))
    this.upcoming = pickWeather('clear');
    this.upcomingIn = null; // s until it comes (multiplayer); single player: weatherTimer
    this.wind = 0; this.clearAir = 0; this.wet = 0; this.frost = 0; this.sea = 0; // eased extras (WEATHER)
    this.inversionY = null; // the sea of clouds' deck height (atmosphere.js writes it)
    this.icy = 0; this.plough = 0;
    // avalanche danger (Oct 30 2026, the user: "1-2 when clear, 3 after snow, 4 after a blizzard"): s since snow fell
    // / since a blizzard (a quiet spell first: level 2 for a while, then 1)
    this.sinceSnow = 700; this.sinceBlizzard = 1e9;
    this.snowCover = 0; // 0..1 fresh snow that has built up (rises while it snows, melts away slowly after)
    this.sunDir = new THREE.Vector3();
    this.moonDir = new THREE.Vector3();
    this.lightDir = new THREE.Vector3();
    this.dayFactor = 1;
    this.nightFactor = 0;
    this.overcast = 0; // max(snow, cloud): how grey the sky is
    // 0..1 how much clear sun there is (elevation, weather). Reset in update(); modules that hide the sun
    // (e.g. the Backdrop peaks) multiply their occlusion in afterwards; SunGlare reads it last.
    this.sunVisible = 1;
    this.sunGlowColor = new THREE.Color(1, 1, 1); // colour of the visible sun (warm at golden hour)
    this.cirrusAmount = 1; // tunable: strength of the high cirrus wisps (0 = none)

    // --- sky dome (custom: logo blues, see SKY_FRAG) ---
    this.noiseTex = makeSkyNoise();
    this.skyUniforms = {
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
      uZenith: { value: new THREE.Color() },
      uMid: { value: new THREE.Color() },
      uHorizon: { value: new THREE.Color() },
      uGlow: { value: new THREE.Color() },
      uHalo: { value: new THREE.Color() },
      uHaloBroad: { value: new THREE.Color() },
      uSunColor: { value: new THREE.Color() },
      uGround: { value: new THREE.Color() },
      uMoonGlow: { value: new THREE.Color() },
      uWisp: { value: new THREE.Color() },
      uDusk: { value: 0 },
      uSunSize: { value: 1 },
      uTime: { value: 0 },
      uCirrus: { value: 0 },
      uOvercast: { value: 0 },
      uHazeK: { value: 16 }, // horizon haze band sharpness (broad and soft when overcast)
      uNoise: { value: this.noiseTex },
    };
    this.sky = this.makeSky(30000);
    scene.add(this.sky);

    // --- stars + moon ---
    this.stars = this.makeStars();
    scene.add(this.stars);
    this.moon = this.makeMoon();
    scene.add(this.moon);

    // --- lights ---
    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    const sc = this.sun.shadow.camera;
    sc.left = -110; sc.right = 110; sc.top = 110; sc.bottom = -110; sc.near = 1; sc.far = 1400;
    this.sun.shadow.bias = -0.00025;
    this.sun.shadow.normalBias = 0.04;
    this.shadowExtent = 110;
    scene.add(this.sun, this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xbfd6ff, 0xf2f4ff, 0.25);
    scene.add(this.hemi);

    // --- fog (height fog, see engine/fog.js) ---
    scene.fog = new THREE.Fog(0xcfe0f5, 0.00009, 0.00045);

    // --- IBL ---
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envScene = new THREE.Scene();
    this.envUniforms = {
      uSunDir: this.skyUniforms.uSunDir,
      uEnvZenith: { value: new THREE.Color() },
      uEnvHorizon: { value: new THREE.Color() },
      uEnvGround: { value: new THREE.Color() },
      uEnvSun: { value: new THREE.Color() },
    };
    this.envSky = new THREE.Mesh(new THREE.SphereGeometry(1000, 32, 16), new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false, uniforms: this.envUniforms, vertexShader: SKY_VERT, fragmentShader: ENV_FRAG,
    }));
    this.envScene.add(this.envSky);
    this.envStars = this.stars.clone();
    this.envStars.scale.setScalar(0.03);
    this.envScene.add(this.envStars);
    // the sky is captured into a cube map that the PMREM filters into one reused target (allocating a new
    // target per refresh stalled a frame for ~170 ms every 2.5 s)
    this.envCube = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType, generateMipmaps: false });
    this.envCubeCam = new THREE.CubeCamera(0.1, 5000, this.envCube);
    this.envRT = null;
    this.envTimer = 0;
    this.envKey = -99; // sun height / weather the IBL was last captured at
    this.scene.environmentIntensity = 1;

    this.fogScale = 1; // graphics preset: thicker haze hides a shorter view distance
    this.fogColor = new THREE.Color();
    this.tmpC = new THREE.Color();
    this.tmpA = new THREE.Color();
    this.tmpB = new THREE.Color();
  }

  // Analytic sky dome. Drawn after the opaque world (renderOrder) with depth test, at the far plane:
  // the shader only runs on pixels where sky is actually visible.
  makeSky(radius) {
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: this.skyUniforms, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
    });
    const m = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 24), mat);
    m.frustumCulled = false;
    m.renderOrder = 50;
    return m;
  }

  // Stars (twinkling points in direction-space cells) and a faint, smooth milky way with dust lanes.
  makeStars() {
    const geo = new THREE.SphereGeometry(25000, 48, 24);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      transparent: true,
      blending: THREE.AdditiveBlending, // added onto the night sky (normal blending painted the sky black)
      fog: false,
      uniforms: { uNight: { value: 0 }, uTime: { value: 0 }, uNoise: { value: this.noiseTex } },
      // by day the dome collapses in the vertex shader (no fragments, but the program stays compiled)
      vertexShader: `uniform float uNight; varying vec3 vDir;
        void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position.z = gl_Position.w;
          if (uNight < 0.001) gl_Position = vec4(0.0, 0.0, 2.0, 1.0); }`,
      fragmentShader: `
        uniform float uNight; uniform float uTime; uniform sampler2D uNoise; varying vec3 vDir;
        float h(vec3 p){ p = fract(p*0.3183099+.1); p*=17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
        void main(){
          vec3 d = normalize(vDir);
          if (d.y < -0.05) discard;
          vec3 c = floor(d * 420.0);
          float s = h(c);
          float star = smoothstep(0.9965, 1.0, s);
          vec3 f = fract(d*420.0) - 0.5;
          star *= smoothstep(0.5, 0.0, length(f)) * (0.7 + 0.3*sin(uTime*1.7 + s*80.0));
          star *= 1.0 + step(0.9993, s) * 2.5; // a few brighter ones
          vec3 col = vec3(star) * mix(vec3(0.75,0.83,1.0), vec3(1.0,0.9,0.75), h(c+3.0));
          // milky way: coordinates along / across a tilted great circle (4 noise tiles around: no seam)
          vec3 n = vec3(0.2858, 0.5240, 0.8022);
          vec3 t1 = vec3(0.9418, 0.0, -0.3356);
          vec3 t2 = cross(n, t1);
          float across = dot(d, n);
          vec2 uv = vec2(atan(dot(d, t2), dot(d, t1)) * 0.63662, across * 2.2);
          float cloud = texture2D(uNoise, uv).r * 0.6 + texture2D(uNoise, uv * 3.0 + 0.37).g * 0.4;
          float lanes = smoothstep(0.38, 0.62, texture2D(uNoise, uv * vec2(2.0, 5.0) + 0.71).b);
          float band = exp(-across * across * 16.0);
          col += vec3(0.16, 0.2, 0.32) * band * (0.25 + smoothstep(0.42, 0.75, cloud) * (0.4 + 0.6 * lanes)) * 0.05;
          float a = uNight * smoothstep(-0.02, 0.2, d.y);
          gl_FragColor = vec4(col * 2.2, a);
        }`,
    });
    const m = new THREE.Mesh(geo, mat);
    m.frustumCulled = false;
    m.renderOrder = -9;
    return m;
  }

  // Full moon: limb-darkened disc with soft maria and a faint halo.
  makeMoon() {
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, fog: false,
      uniforms: { uNight: { value: 0 } },
      vertexShader: `uniform float uNight; varying vec2 vUv;
        void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position.z = gl_Position.w*0.9999;
          if (uNight < 0.001) gl_Position = vec4(0.0, 0.0, 2.0, 1.0); }`,
      fragmentShader: `uniform float uNight; varying vec2 vUv;
        float blob(vec2 p, vec2 c, float r){ return exp(-dot(p - c, p - c) / (r * r)); }
        void main(){
          vec2 p = (vUv*2.0-1.0) * 1.6; float r = length(p);
          float aa = fwidth(r) * 1.5;
          float disc = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, r);
          float limb = sqrt(max(1.0 - r * r, 0.0));
          // maria: soft darker seas roughly where the real ones are
          float mare = blob(p, vec2(-0.28, 0.32), 0.34) + blob(p, vec2(0.18, 0.42), 0.26) + blob(p, vec2(0.32, 0.05), 0.24)
                     + blob(p, vec2(-0.45, -0.12), 0.3) * 0.8 + blob(p, vec2(0.05, -0.38), 0.18) * 0.6;
          float alb = 1.0 - 0.32 * clamp(mare, 0.0, 1.0);
          vec3 col = vec3(0.96, 0.97, 1.0) * alb * (0.62 + 0.38 * limb) * disc * 3.4;
          float glow = exp(-max(r - 1.0, 0.0) * 3.2) * (1.0 - disc) * 0.22;
          col += vec3(0.45, 0.55, 0.8) * glow;
          gl_FragColor = vec4(col, (disc + glow) * uNight);
        }`,
    });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1000, 1000), mat);
    m.frustumCulled = false;
    m.renderOrder = -8;
    return m;
  }

  // graphics preset: shadow map size, the area it covers around the player, PCF or soft PCF (main.js)
  setShadowQuality({ size, extent }) {
    const sh = this.sun.shadow;
    this.sun.castShadow = size > 0; // (Super Performance: no shadow pass at all)
    if (!size) { sh.map?.dispose(); sh.map = null; this.shadowExtent = extent; return; }
    if (sh.mapSize.x !== size) {
      sh.mapSize.set(size, size);
      sh.map?.dispose();
      sh.map = null;
    }
    this.shadowExtent = extent;
    this.setShadowFrustum(extent);
  }

  setShadowFrustum(ext) {
    const sc = this.sun.shadow.camera;
    sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext;
    sc.updateProjectionMatrix();
    this.shadowExtentNow = ext;
  }

  setWeather(name) {
    if (!WEATHER[name] || name === this.weather) return;
    this.weather = name;
    this.upcoming = pickWeather(name); // (the forecast moves on with it; multiplayer: the server's replaces it)
  }
  get weatherLabel() { return WEATHER[this.weather].label; }
  /** The small HUD forecast ("Later: Blizzard"), or '' (nothing changing, or the weather held, e.g. a race). */
  get forecastLabel() {
    const w = this.upcoming, left = this.weatherTimer < 1e8 ? this.weatherTimer : this.upcomingIn; // (1e9: held by the server / a race)
    if (!w || w === this.weather || !WEATHER[w] || !(left < 600)) return '';
    return `Later: ${WEATHER[w].label}`;
  }
  /** Avalanche danger level 1-4 (European scale), following the weather (never closes anything). */
  get avalancheLevel() {
    if (this.weather === 'blizzard' || this.sinceBlizzard < 480) return 4;
    if (this.snow > 0.3 || this.sinceSnow < 540) return 3;
    if (this.snow > 0.1 || this.sinceSnow < 1500) return 2;
    return 1;
  }

  get timeString() {
    const h = Math.floor(this.hour), m = Math.floor((this.hour - h) * 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  update(dt, camera, focus) {
    this.hour = (this.hour + (dt * this.timeScale * 24) / DAY_SECONDS) % 24;

    // weather state machine: every 1.5-3.5 minutes the weather moves on (clear, cloudy, snow, mist...)
    this.weatherTimer -= dt;
    if (this.weatherTimer <= 0) {
      const nx = NEXT[this.weather]?.includes(this.upcoming) ? this.upcoming : pickWeather(this.weather); // (the forecast comes true)
      this.setWeather(nx);
      this.weatherTimer = weatherHold(nx);
    }
    const W = WEATHER[this.weather], k = Math.min(1, dt * 0.06); // ~20 s transitions
    this.weatherTarget = W.snow;
    this.snow += (W.snow - this.snow) * k;
    this.cloud += (W.cloud - this.cloud) * k;
    this.mist += (W.mist - this.mist) * k;
    this.wind += ((W.wind || 0) - this.wind) * k;
    this.clearAir += ((W.clear || 0) - this.clearAir) * k;
    this.wet += ((W.wet || 0) - this.wet) * k;
    this.frost += ((W.frost || 0) - this.frost) * k * 0.5; // (rime grows slowly)
    this.sea += ((W.sea || 0) - this.sea) * k;
    // after-effects: icy roads for a few minutes (~4 min to thaw), the ploughs out after heavy snow (~5 min)
    if (ICY_WX.has(this.weather)) this.icy = Math.min(1, this.icy + dt / 40); else this.icy = Math.max(0, this.icy - dt / 240);
    if (PLOUGH_WX.has(this.weather)) this.plough = Math.min(1, this.plough + dt / 20); else this.plough = Math.max(0, this.plough - dt / 300);
    if (this.snow > 0.3) this.sinceSnow = 0; else this.sinceSnow += dt;
    if (this.weather === 'blizzard') this.sinceBlizzard = 0; else this.sinceBlizzard += dt;
    // gusts: a slow swell from the west-north-west with lulls (wind 1: ~0.3 m/s^2 at the peak of a gust)
    const gt = (this.gustT = (this.gustT || 0) + dt);
    const gust = this.wind * Math.max(0, 0.55 + 0.45 * Math.sin(gt * 0.9) * Math.sin(gt * 0.37 + 1.3)) * 0.3;
    const wfx = weatherFx;
    wfx.gustX = gust * 0.93; wfx.gustZ = gust * 0.37;
    wfx.glide = 1 + this.clearAir * 0.06; wfx.icy = this.icy; wfx.plough = this.plough; wfx.wind = this.wind;
    // fresh snow builds up over ~1.5 minutes of snowfall and settles / melts away over ~8 minutes
    if (this.snowCover < this.snow) this.snowCover += (this.snow - this.snowCover) * Math.min(1, dt / 90);
    else this.snowCover = Math.max(this.snow, this.snowCover - dt / 480);

    // sun path: rises in the east, highest in the south (+Z), sets in the west. A low winter sun (32 deg at
    // noon, sunrise ~5:30 / sunset ~18:30), like the low backlit sun of the logo art: raking light that brings
    // out the relief of the snow, long blue shadows, sunlit vs shaded faces, and the sun with its starburst in
    // the skier's view for much of the day (a 40 deg noon sun lit the snow flat and the day looked generic)
    const t = ((this.hour - 12) / 12) * Math.PI;
    const elev = THREE.MathUtils.degToRad(28 * Math.cos(t) + 4);
    const az = t;
    this.sunDir.set(Math.sin(az) * Math.cos(elev), Math.sin(elev), Math.cos(az) * Math.cos(elev)).normalize();
    const mt = t + Math.PI;
    const melev = THREE.MathUtils.degToRad(42 * Math.cos(mt) + 8);
    this.moonDir.set(Math.sin(mt) * Math.cos(melev) * 0.8, Math.sin(melev), Math.cos(mt) * Math.cos(melev) * 0.8 - 0.3).normalize();

    const sunH = this.sunDir.y;
    this.dayFactor = smoothstep(-0.08, 0.12, sunH);
    this.nightFactor = 1 - smoothstep(-0.18, 0.02, sunH);
    // sea of clouds: below the deck it is a grey, misty day; above it the sun shines (atmosphere.js sets inversionY)
    const under = this.inversionY == null ? 0 : this.sea * (1 - smoothstep(this.inversionY - 10, this.inversionY + 60, camera.position.y));
    this.underDeck = under;
    const overcast = Math.max(this.snow, this.cloud * 0.85, under * 0.8);
    this.overcast = overcast;
    const clearSky = 1 - overcast;

    // ---- palette for this sun height
    let i = 0;
    while (i < KEYS.length - 2 && sunH > KEYS[i + 1]) i++;
    const f = smoothstep(KEYS[i], KEYS[i + 1], sunH);
    const su = this.skyUniforms;
    su.uSunDir.value.copy(this.sunDir);
    su.uMoonDir.value.copy(this.moonDir);
    // overcast deck: grey, lit by the hour (dim at dawn/dusk with a warm cast, dark at night)
    const lightLevel = lerp(0.035, 1, smoothstep(-0.2, 0.3, sunH));
    const warmO = smoothstep(-0.12, 0.02, sunH) * (1 - smoothstep(0.05, 0.3, sunH));
    const greyTint = this.tmpA.setRGB(1, 1, 1).lerp(WARM_TINT, warmO * 0.6).multiplyScalar(lightLevel * lerp(1, 0.82, this.snow));
    const oc = overcast * 0.94;
    samplePalette(PAL.zenith, i, f, su.uZenith.value).lerp(this.tmpB.copy(OVER_TOP).multiply(greyTint), oc);
    samplePalette(PAL.mid, i, f, su.uMid.value).lerp(this.tmpB.copy(OVER_TOP).lerp(OVER_HOR, 0.5).multiply(greyTint), oc);
    samplePalette(PAL.horizon, i, f, su.uHorizon.value).lerp(this.tmpB.copy(OVER_HOR).multiply(greyTint), oc);
    samplePalette(PAL.glow, i, f, su.uGlow.value).lerp(this.tmpB.copy(OVER_HOR).multiply(greyTint), oc);
    samplePalette(PAL.halo, i, f, su.uHalo.value).multiplyScalar(clearSky * clearSky);
    su.uHaloBroad.value.copy(OVER_HOR).multiply(greyTint).multiplyScalar(0.45 * overcast * smoothstep(-0.02, 0.1, sunH));
    const dusk = smoothstep(-0.12, 0.0, sunH) * (1 - smoothstep(0.04, 0.25, sunH));
    su.uDusk.value = dusk * clearSky;
    // sun disc: HDR (blooms), hidden below the horizon and behind cloud
    const discVis = smoothstep(-0.03, 0.02, sunH) * Math.pow(clearSky, 3);
    samplePalette(PAL.disc, i, f, su.uSunColor.value).multiplyScalar(lerp(30, 70, smoothstep(0.0, 0.3, sunH)) * discVis);
    this.sunVisible = smoothstep(-0.02, 0.03, sunH) * Math.pow(clearSky, 1.5) * (1 - Math.min(1, this.mist + this.frost * 0.3) * 0.6);
    samplePalette(PAL.disc, i, f, this.sunGlowColor);
    // cirrus wisps: a fair-weather feature, lit white by day and pink/gold at sunset
    su.uCirrus.value = clearSky * clearSky * (1 - this.nightFactor) * 0.9 * this.cirrusAmount;
    su.uWisp.value.copy(su.uHorizon.value).lerp(su.uGlow.value, 0.35).multiplyScalar(0.55).addScalar(0.35 * this.dayFactor);
    su.uOvercast.value = overcast;
    su.uHazeK.value = lerp(16, 4.5, overcast);
    su.uMoonGlow.value.setRGB(0.05, 0.075, 0.13).multiplyScalar(this.nightFactor * (1 - overcast * 0.85) * smoothstep(-0.1, 0.15, this.moonDir.y));
    su.uTime.value += dt;

    // ---- fog: blue aerial perspective; whiter in snow / mist, dark navy at night
    samplePalette(PAL.fog, i, f, this.fogColor).lerp(this.tmpB.copy(OVER_FOG).multiply(greyTint), oc);
    const whiteout = Math.min(1, this.mist * 0.55 + this.snow * 0.5) * lightLevel;
    this.fogColor.lerp(this.tmpB.copy(MIST_FOG).multiply(greyTint), whiteout * 0.6);
    su.uGround.value.copy(this.fogColor);
    this.scene.fog.color.copy(this.fogColor);
    // (Oct 30 2026: a blizzard a little thicker than heavy snow, never a whiteout; freezing fog thick and low; föhn
    // air crystal clear, far views; under the sea of clouds a grey haze)
    this.scene.fog.near = (lerp(0.000034, 0.0013, this.snow * this.snow) + this.mist * this.mist * 0.0016 + this.nightFactor * 0.00003
      + this.wind * this.snow * 0.00025 + this.frost * 0.0006 + under * 0.0005) * this.fogScale * (1 - this.clearAir * 0.45);
    this.scene.fog.far = lerp(0.00045, 0.00025, overcast);

    // ---- key light: sun by day, moon by night
    const useMoon = sunH < -0.04;
    this.lightDir.copy(useMoon ? this.moonDir : this.sunDir);
    if (useMoon) {
      this.sun.color.setRGB(0.5, 0.64, 1.0); // cold blue moonlight: a deep navy night, snow still readable
      this.sun.intensity = 0.6 * (1 - overcast * 0.7) * smoothstep(0.0, 0.2, this.moonDir.y);
    } else {
      samplePalette(PAL.sun, i, f, this.sun.color);
      this.sun.intensity = sampleNum(PAL.sunI, i, f) * smoothstep(-0.03, 0.05, sunH) * lerp(1, 0.17, overcast);
    }

    // ---- ambient: blue sky light (hemisphere + IBL), lower than the sun so shade reads blue
    samplePalette(PAL.amb, i, f, this.hemi.color).lerp(this.tmpB.setRGB(0.62, 0.68, 0.78).multiplyScalar(lerp(0.15, 1, this.dayFactor)), overcast * 0.7);
    this.hemi.groundColor.copy(this.hemi.color).lerp(this.tmpB.setRGB(0.75, 0.78, 0.85), 0.5).multiplyScalar(0.6);
    this.hemi.intensity = lerp(0.04, 0.12, this.dayFactor) * lerp(1, 2.6, overcast);
    this.scene.environmentIntensity = sampleNum(PAL.envI, i, f) * lerp(1, 1.12, overcast);
    // IBL sky: the cerulean of the visible palette, a little desaturated and brighter overhead, a dim
    // horizon and sunlit-snow bounce below (fitted so shaded snow reads #87b5e8 at noon, sunlit #e7ebf2)
    const eu = this.envUniforms;
    eu.uEnvZenith.value.copy(su.uZenith.value).lerp(su.uMid.value, 0.8);
    desaturate(eu.uEnvZenith.value, 0.7).multiplyScalar(1.8);
    eu.uEnvHorizon.value.copy(su.uHorizon.value).lerp(su.uMid.value, 0.3);
    desaturate(eu.uEnvHorizon.value, 0.7).multiplyScalar(0.35);
    const bounce = this.sun.intensity * Math.max(this.lightDir.y, 0) * 0.85 / Math.PI;
    eu.uEnvGround.value.copy(this.sun.color).multiplyScalar(bounce * 0.3).add(this.tmpB.copy(eu.uEnvZenith.value).multiplyScalar(0.25));
    eu.uEnvSun.value.copy(this.sun.color).multiplyScalar(useMoon ? 0 : this.sun.intensity * 0.05);

    // ---- stars, moon, dome follow the camera
    this.stars.material.uniforms.uNight.value = this.nightFactor * (1 - overcast);
    this.stars.material.uniforms.uTime.value += dt;
    this.stars.position.copy(camera.position);
    this.sky.position.copy(camera.position);
    this.moon.position.copy(camera.position).addScaledVector(this.moonDir, 20000);
    this.moon.lookAt(camera.position);
    this.moon.material.uniforms.uNight.value = this.nightFactor * (1 - overcast * 0.9);

    // Shadows: under the moon they only matter close to the player, so the frustum tightens to half its size by
    // night (twice as fine shadow texels: they showed as big square blocks); every preset filters them with the
    // bilinear soft PCF (engine/quality.js), so texel edges never read as blocks.
    const ext = Math.round(this.shadowExtent * lerp(1, 0.5, this.nightFactor));
    if (ext !== this.shadowExtentNow) this.setShadowFrustum(ext);
    // shadow frustum follows the player, snapped to texels to avoid shimmering
    const texel = (ext * 2) / this.sun.shadow.mapSize.x;
    const fx = Math.round(focus.x / texel) * texel, fz = Math.round(focus.z / texel) * texel;
    this.sun.target.position.set(fx, focus.y, fz);
    this.sun.position.copy(this.sun.target.position).addScaledVector(this.lightDir, 600);
    this.sun.target.updateMatrixWorld();

    // refresh IBL from the sky periodically (immediately after a jump in time of day or weather)
    this.envTimer -= dt;
    const key = sunH * 4 + overcast + this.mist * 0.5;
    if (Math.abs(key - this.envKey) > 0.12) this.envTimer = 0;
    if (this.envTimer <= 0) {
      this.envTimer = 2.5;
      this.envKey = key;
      this.envStars.material.uniforms.uNight.value = this.stars.material.uniforms.uNight.value;
      this.envCubeCam.update(this.renderer, this.envScene);
      this.envRT = this.pmrem.fromCubemap(this.envCube.texture, this.envRT);
      this.scene.environment = this.envRT.texture;
    }
  }
}

// Pull a colour toward its own luminance (s = amount of saturation kept).
function desaturate(c, s) {
  const l = c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
  c.r = l + (c.r - l) * s; c.g = l + (c.g - l) * s; c.b = l + (c.b - l) * s;
  return c;
}
