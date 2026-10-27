// Ski tracks, boot prints and landing marks pressed into the snow + powder spray particles.
import * as THREE from 'three';
import { world } from '../world/world.js';

const STEP = 2; // terrain mesh grid near the player (matches 128m LOD nodes)

// Height of the rendered terrain mesh (triangle interpolation), so marks hug the visible surface.
// Also leaves the triangle's slope in _ms (gx, gz) for the marks' normals.
const _ms = { gx: 0, gz: 0 };
export function meshHeight(x, z) {
  const gx = Math.floor(x / STEP), gz = Math.floor(z / STEP);
  const u = x / STEP - gx, v = z / STEP - gz;
  const a = world.height(gx * STEP, gz * STEP);
  const b = world.height((gx + 1) * STEP, gz * STEP);
  const c = world.height(gx * STEP, (gz + 1) * STEP);
  if (u + v < 1) {
    _ms.gx = (b - a) / STEP; _ms.gz = (c - a) / STEP;
    return a + (b - a) * u + (c - a) * v;
  }
  const d = world.height((gx + 1) * STEP, (gz + 1) * STEP);
  _ms.gx = (d - c) / STEP; _ms.gz = (d - b) / STEP;
  return d + (c - d) * (1 - u) + (b - d) * (1 - v);
}

// ---------------------------------------------------------------------------------------------------
// Snow marks: one dynamic mesh, a ring buffer of quads (ski-track segments, boot prints, landing slaps,
// crash splats). Every quad carries a small height field (groove cross-section, boot sole...) that the
// shader lights like real relief: walls facing the sun brighten, walls facing away fall into blue sky
// light, the floor is occluded and compacted, the walls cast short shadows into the groove, the pushed-up
// lip catches the light. Instead of painting a colour over the terrain the marks MULTIPLY the snow that is
// already there (modulate 2x): the terrain's own colour, sparkle, tree shadows and fog stay, only the
// relief's light changes, so a mark always matches the snow it sits in. Thin grooves are band-limited
// (analytic coverage per pixel), so tracks stay continuous lines at any distance and on low render scales.
// ---------------------------------------------------------------------------------------------------
const TRACK_Q = 1.5; // quad half width / groove half width (the rest is the lip)
const K_TRACK = 0, K_BOOT = 1, K_SKIBOOT = 2, K_SLAP = 3, K_SPLAT = 4;

const VERT = /* glsl */`
attribute vec4 aFrame; // terrain normal xz, across (left) direction xz
attribute vec4 aInfo;  // birth time, kind, skid | run | amount, edge tilt | foot side
attribute vec3 aSize;  // half width across (m), half length along (m, prints), depth (m)
uniform float uNow;
uniform float uFade;
varying vec2 vUv;
varying vec4 vInfo;
varying vec3 vSize;
varying vec3 vNf;
varying vec3 vSide;
varying vec3 vWorld;
varying float vAge;
#include <common>
#include <shadowmap_pars_vertex>
void main() {
  vec3 objectNormal = vec3(aFrame.x, sqrt(max(0.0, 1.0 - aFrame.x * aFrame.x - aFrame.y * aFrame.y)), aFrame.y);
  #include <defaultnormal_vertex>
  vec3 transformed = position;
  vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
  // pull toward the camera along the view ray (screen position unchanged): never fights the terrain
  float dist = length(mvPosition.xyz);
  mvPosition.xyz *= 1.0 - min(0.25, 0.003 + 0.0008 * dist) / max(dist, 0.05);
  gl_Position = projectionMatrix * mvPosition;
  #include <worldpos_vertex>
  #include <shadowmap_vertex>
  vUv = uv;
  vInfo = aInfo;
  vSize = aSize;
  vNf = objectNormal;
  vSide = vec3(aFrame.z, 0.0, aFrame.w);
  vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
  // boot prints (kinds 1, 2) fill in faster than ski tracks: about a minute in clear weather, ~15 s in snow
  vAge = (uNow - aInfo.x) * uFade * (aInfo.y > 0.5 && aInfo.y < 2.5 ? 2.5 : 1.0);
}`;

const FRAG = /* glsl */`
uniform vec3 uLightDir;
uniform vec3 uSunCol;
uniform vec3 uSky;
uniform vec3 uGround;
uniform float uStrength;
#ifdef USE_FOG
  uniform float fogNear;
  uniform float fogFar;
#endif
varying vec2 vUv;
varying vec4 vInfo;
varying vec3 vSize;
varying vec3 vNf;
varying vec3 vSide;
varying vec3 vWorld;
varying float vAge;
#include <common>
#include <packing>
#include <bsdfs>
#include <lights_pars_begin>
#include <shadowmap_pars_fragment>
#include <shadowmask_pars_fragment>

float tHash1(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float tHash2(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float tNoise1(float x) { float i = floor(x); float f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(tHash1(i), tHash1(i + 1.0), f); }
float tNoise2(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(tHash2(i), tHash2(i + vec2(1.0, 0.0)), f.x), mix(tHash2(i + vec2(0.0, 1.0)), tHash2(i + vec2(1.0, 1.0)), f.x), f.y);
}
float tSmin(float a, float b, float k) { float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0); return mix(b, a, h) - k * h * (1.0 - h); }
float tBox(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }

// the mark being shaded
float gKind, gD, gG, gTilt, gBite, gSkid, gRun, gSide, gDetail, gDetailL, gHW, gHL, gSeed;

// Ski track cross-section (metres): p.x across from the centre line (+ = left), p.y along the track.
// Flat ski: a ski-wide flat imprint; edged ski (carve): a narrow trench, deepest under the biting edge;
// skid: a wide, shallow, scraped band with fine scratches along the slide. A lip of pushed-up snow beside it.
float trackH(vec2 p) {
  // the groove's edges wander a little (chatter, uneven snow): a track, not a ruled rail
  float wob = 1.0 + (tNoise1(p.y * 1.9 + gSeed) - 0.5) * (0.1 + 0.3 * gSkid);
  float u = (p.x + (tNoise1(p.y * 0.9 + gSeed * 1.7) - 0.5) * gG * 0.12) / (gG * wob);
  float au = abs(u);
  // walls: steep for a ski running on its base or edge; a skid has one crisp scraped edge (the biting side)
  // and one feathered edge of loose snow
  float bite = gSkid * step(0.0, u * gBite) * min(1.0, abs(gBite) * 3.0);
  float wall = mix(mix(0.22, 0.5, gSkid), 0.2, bite);
  float inG = 1.0 - smoothstep(1.0 - wall, 1.0, au);
  float bottom = (1.0 + gTilt * clamp(u, -1.0, 1.0)) / (1.0 + abs(gTilt));
  float h = -gD * inG * bottom;
  // scrape lines: a few millimetres on firm snow, none in deep snow (a skid there is a smooth trough)
  float scr = min(gD, 0.005) * (1.0 - smoothstep(0.02, 0.05, gD));
  h -= scr * gSkid * inG * (tNoise1(p.x * 85.0 + tNoise1(p.y * 0.7 + gSeed) * 6.0) - 0.5) * gDetail;
  h -= gD * 0.1 * inG * (tNoise1(p.y * 2.3 + gSeed) - 0.5);
  // lip of pushed-up snow: higher on the digging side of a carve, lumpy loose snow on a skid's soft side
  float lip = smoothstep(0.86, 1.04, au) * (1.0 - smoothstep(1.04, TRACK_Q, au));
  float lump = 0.7 + 0.6 * tNoise1(p.y * 5.0 + sign(u) * 7.0 + gSeed) + gSkid * (tNoise2(vec2(p.y * 9.0, u * 3.0) + gSeed) - 0.5) * 1.2 * gDetailL;
  h += gD * (0.3 + 0.45 * gSkid * (1.0 - bite)) * lip * (1.0 + 0.8 * gTilt * sign(u)) * lump;
  return h;
}

// Prints (metres, x across + = left, y forward): signed distance to the outline
float printSd(vec2 p) {
  if (gKind < 1.5) {
    // winter boot: round heel, a waist under the arch, the wide ball of the foot, round toe
    float heel = length((p - vec2(0.0, -0.088)) * vec2(1.0, 0.85)) - 0.041;
    float fore = (length((p - vec2(-gSide * 0.005, 0.042)) / vec2(0.052, 0.098)) - 1.0) * 0.05;
    return tSmin(heel, fore, 0.035);
  }
  if (gKind < 2.5) {
    // ski boot: long hard shell sole, squarer toe and heel
    float w = 0.041 + 0.007 * smoothstep(-0.12, 0.08, p.y);
    return tBox(p - vec2(0.0, 0.004), vec2(w, 0.152), 0.024);
  }
  if (gKind < 3.5) return tBox(p, vec2(0.046, 0.8), 0.045); // landing: the whole ski slapped into the snow
  vec2 r = vec2(gHW, gHL) * 0.62;
  return (length(p / r) - 1.0) * min(r.x, r.y) + (tNoise2(p * 7.0 + gSeed) - 0.5) * 0.09;
}

float printH(vec2 p) {
  float sd = printSd(p);
  float wall = gKind > 3.5 ? 0.07 : (gKind > 2.5 ? 0.025 : 0.009);
  float inside = 1.0 - smoothstep(-wall, 0.0, sd);
  float core = 1.0 - smoothstep(-wall - 0.008, -wall, sd);
  float t = clamp(p.y / max(gHL * 0.78, 0.01), -1.0, 1.0);
  float depthK;
  if (gKind < 2.5) depthK = 1.0 + mix(-0.22, 0.45, gRun) * t;            // heel strike walking, toe push running
  else if (gKind < 3.5) depthK = 1.05 - 0.5 * t - 0.45 * smoothstep(0.5, 0.95, t); // tail lands first, tip rises
  else depthK = 0.75 + 0.5 * tNoise2(p * 4.0 + gSeed);
  float h = -gD * inside * depthK;
  if (gKind < 1.5) {
    // hiking sole: chevron lugs, heel block
    float lug = step(0.5, fract(p.y * 40.0 + abs(p.x + gSide * 0.004) * 24.0));
    h -= gD * 0.2 * (lug - 0.5) * core * gDetail;
  } else if (gKind < 2.5) {
    // ski boot: rubber pads with cross ribs at toe and heel, smooth shell under the arch
    float pad = smoothstep(0.03, 0.045, abs(p.y + 0.012));
    float rib = step(0.5, fract(p.y * 34.0));
    h -= gD * (0.12 * pad + 0.14 * pad * (rib - 0.5) * gDetail) * core;
    h += gD * 0.15 * (1.0 - pad) * core;
  }
  // rim: snow squeezed up around the print, crumbly
  float rr = gKind > 3.5 ? 0.09 : (gKind > 2.5 ? 0.04 : 0.016);
  float rim = smoothstep(0.0, rr * 0.35, sd) * exp(-(sd * sd) / (rr * rr));
  float crumb = mix(1.0, 0.45 + 1.1 * tNoise2(p * (gKind > 2.5 ? 30.0 : 75.0) + gSeed), gDetail);
  // running: the toe digs in and pushes up a ridge of loose snow at the front of the print
  float kick = gKind < 2.5 ? 1.0 + 1.3 * gRun * smoothstep(0.2, 0.9, t) : 1.0;
  h += gD * (gKind > 2.5 ? 0.45 : 0.38) * rim * crumb * kick;
  return h;
}

float relief(vec2 p) { return gKind < 0.5 ? trackH(p) : printH(p); }

float fogAmount(vec3 wp) {
  #ifdef USE_FOG
    vec3 rd = wp - cameraPosition;
    float dist = length(rd);
    float x = rd.y * fogFar;
    float k = abs(x) > 1e-4 ? (1.0 - exp(-x)) / x : 1.0;
    float amount = fogNear * exp(-max(cameraPosition.y, 0.0) * fogFar) * dist * k;
    float xv = rd.y * (1.0 / 380.0);
    float kv = abs(xv) > 1e-4 ? (1.0 - exp(-xv)) / xv : 1.0;
    amount += fogNear * 0.3 * dist * min(kv, 7.0);
    return clamp(1.0 - exp(-amount), 0.0, 1.0);
  #else
    return 0.0;
  #endif
}

void main() {
  float fade = clamp(1.0 - vAge, 0.0, 1.0);
  fade = fade * fade * (3.0 - 2.0 * fade);
  if (fade < 0.004) discard;
  gKind = vInfo.y;
  bool track = gKind < 0.5;
  vec3 Nf = normalize(vNf);
  vec3 A = normalize(vSide - Nf * dot(vSide, Nf));
  vec3 Fw = cross(A, Nf);
  gD = vSize.z * mix(0.4, 1.0, fade); // old marks soften (sun, wind, settling)
  gSeed = fract(vInfo.x * 0.731) * 40.0;
  vec2 p;
  float px;
  if (track) {
    p = vec2(vUv.x * vSize.x, vUv.y);
    gG = vSize.x / TRACK_Q;
    gSkid = vInfo.z;
    gBite = clamp(vInfo.w * 1.35, -0.85, 0.85);
    gTilt = gBite * (1.0 - gSkid);
    px = max(fwidth(p.x), 1e-5);
  } else {
    gHW = vSize.x; gHL = vSize.y; gRun = vInfo.z; gSide = vInfo.w;
    p = vec2(vUv.x * gHW, vUv.y * gHL);
    px = max(max(fwidth(p.x), fwidth(p.y)), 1e-5);
  }
  gDetail = 1.0 - smoothstep(0.0025, 0.007, px);  // millimetre detail (scratches, tread)
  gDetailL = 1.0 - smoothstep(0.012, 0.035, px);   // centimetre detail (lumps, streaks)
  // relief and its slope, box-filtered over the pixel
  float e = max(px * 0.6, 0.0015);
  float h0 = relief(p);
  float hx = (relief(p + vec2(e, 0.0)) - relief(p - vec2(e, 0.0))) / (2.0 * e);
  float hy = (relief(p + vec2(0.0, e)) - relief(p - vec2(0.0, e))) / (2.0 * e);
  vec3 L = normalize(uLightDir);
  float lz = dot(L, Nf);
  // short shadows cast by the walls into the groove / print (3 steps up the light ray)
  float wallSh = 0.0;
  if (lz > 0.03) {
    vec2 ld = vec2(dot(L, A), dot(L, Fw)) / lz;
    float ll = length(ld);
    if (ll > 4.0) ld *= 4.0 / ll;
    for (int k = 1; k <= 3; k++) {
      float rise = gD * 0.5 * float(k);
      wallSh = max(wallSh, smoothstep(0.0, gD * 0.2 + 1e-4, relief(p + ld * rise) - (h0 + rise)));
    }
  }
  float sh = getShadowMask();
  vec3 Ng = normalize(Nf - A * hx - Fw * hy);
  float dN = clamp(-h0 / max(gD, 1e-4), 0.0, 1.3);
  // sky the relief still sees: tilted walls see the snow beside them, the floor of a deep narrow groove sees
  // its walls (a shallow wide imprint sees nearly all the sky). What they see instead is snow lit like the
  // surface around (bounce), so shade inside the snow is a soft blue, never black.
  float aoK = 0.5 * clamp(gD / ((track ? gG : 0.045) * 0.6), 0.0, 1.0);
  float skyF = (0.5 + 0.5 * clamp(dot(Ng, Nf), 0.0, 1.0)) * (1.0 - aoK * min(dN, 1.0));
  vec3 V = normalize(cameraPosition - vWorld);
  float steep = clamp(length(vec2(hx, hy)) * 0.7, 0.0, 1.0);
  float spec = pow(max(dot(Ng, normalize(L + V)), 0.0), 36.0) * 0.6 * steep;
  vec3 E0 = mix(uGround, uSky, 0.5 + 0.5 * Nf.y) + uSunCol * max(lz, 0.0) * sh;
  vec3 E1 = mix(uGround, uSky, 0.5 + 0.5 * Ng.y) * skyF + E0 * (0.4 * (1.0 - skyF))
          + uSunCol * (max(dot(Ng, L), 0.0) + spec) * sh * (1.0 - wallSh)
          + E0 * (0.08 * wallSh); // the sunlit wall opposite lights the shadow it casts
  // pressed snow: denser, smoother, less sparkle, a touch blue-grey (skids: scraped, a little greyer).
  // Sunlit snow sits on the shoulder of the filmic tone curve, where a physically small change in brightness
  // all but vanishes on screen: the brighter the light, the harder the tint, so the groove reads as it would
  // to the eye (in flat light and at night it stays gentle).
  vec3 pressed = track ? mix(vec3(0.8, 0.87, 0.97), vec3(0.79, 0.845, 0.94), gSkid) : vec3(0.82, 0.88, 0.975);
  float hk = smoothstep(0.6, 2.4, dot(E0, vec3(0.2126, 0.7152, 0.0722)));
  pressed = mix(pressed, pow(pressed, vec3(1.5)) * vec3(0.95, 0.97, 1.0), hk);
  vec3 alb = mix(vec3(1.0), pressed, clamp(dN * 1.4, 0.0, 1.0));
  // a skid scrapes the surface in streaks along the slide: smoother and rougher bands
  if (track && gSkid > 0.0) alb *= mix(1.0, 0.86 + 0.28 * tNoise1(p.x * 11.0 + tNoise1(p.y * 0.3 + gSeed) * 4.0), gSkid * gDetailL * clamp(dN * 2.0, 0.0, 1.0));
  vec3 ratio = alb * E1 / max(E0, vec3(1e-4));
  if (track) {
    // far away the groove is thinner than a pixel: its average shade times the share of the pixel it covers
    float far = smoothstep(0.1, 0.45, px / gG);
    if (far > 0.0) {
      float cov = clamp((min(p.x + px * 0.5, gG) - max(p.x - px * 0.5, -gG)) / px, 0.0, 1.0);
      vec3 Nb = normalize(Nf + A * (gD * gTilt / (gG * (1.0 + abs(gTilt)))));
      vec3 Eb = mix(uGround, uSky, 0.5 + 0.5 * Nb.y) * 0.8 + E0 * 0.08 + uSunCol * max(dot(Nb, L), 0.0) * sh * 0.92;
      vec3 rb = pressed * Eb / max(E0, vec3(1e-4));
      ratio = mix(ratio, mix(vec3(1.0), rb, cov), far);
    }
  }
  ratio = mix(vec3(1.0), ratio, fade * uStrength * (1.0 - fogAmount(vWorld)));
  if (all(lessThan(abs(ratio - 1.0), vec3(0.004)))) discard;
  gl_FragColor = vec4(clamp(ratio * 0.5, 0.0, 0.85), 1.0); // modulate 2x: 0.5 leaves the snow as it is
}`;

const _c = new THREE.Color();

export class Trails {
  constructor(scene) {
    this.scene = scene;
    this.max = 14000; // quads
    const V = this.max * 4;
    this.pos = new Float32Array(V * 3);
    this.uv = new Float32Array(V * 2);
    this.frame = new Float32Array(V * 4);
    this.info = new Float32Array(V * 4);
    this.size = new Float32Array(V * 3);
    for (let i = 0; i < V; i++) this.info[i * 4] = -1e6;
    const idx = new Uint32Array(this.max * 6);
    for (let i = 0; i < this.max; i++) {
      const o = i * 4;
      idx.set([o, o + 2, o + 1, o + 1, o + 2, o + 3], i * 6);
    }
    const geo = new THREE.BufferGeometry();
    this.attrs = [
      ['position', new THREE.BufferAttribute(this.pos, 3)],
      ['uv', new THREE.BufferAttribute(this.uv, 2)],
      ['aFrame', new THREE.BufferAttribute(this.frame, 4)],
      ['aInfo', new THREE.BufferAttribute(this.info, 4)],
      ['aSize', new THREE.BufferAttribute(this.size, 3)],
    ].map(([k, a]) => { a.setUsage(THREE.DynamicDrawUsage); geo.setAttribute(k, a); return a; });
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.setDrawRange(0, 0);
    this.geo = geo;
    const mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.lights, THREE.UniformsLib.fog, {
        uNow: { value: 0 }, uFade: { value: 1 / 180 }, uStrength: { value: 1 },
        uLightDir: { value: new THREE.Vector3(0.4, 0.7, 0.3).normalize() },
        uSunCol: { value: new THREE.Color(0.95, 0.9, 0.8) },
        uSky: { value: new THREE.Color(0.25, 0.42, 0.75) },
        uGround: { value: new THREE.Color(0.2, 0.22, 0.25) },
      }]),
      vertexShader: VERT, fragmentShader: FRAG,
      defines: { TRACK_Q: TRACK_Q.toFixed(2) },
      lights: true, fog: true, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -1.5, polygonOffsetUnits: -2,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.DstColorFactor, blendDst: THREE.SrcColorFactor,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    });
    this.material = mat;
    this.uniforms = mat.uniforms;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = 1;
    // not a prop: engine/detail.js would cull it by its (empty at boot) bounding sphere on every preset but Ultra
    this.mesh.userData.propDetail = true;
    scene.add(this.mesh);
    this.head = 0;
    this.count = 0;
    this.time = 0;
    this.emitters = new Map();
    this.feet = new Map();
    this.soft = new Map();
    this.rigFeetT = -1e9;
    this.ranges = []; // dirty quad ranges [start, count] (flat pairs)
    this._corr = { d: 1e9, kind: null, dx: 0, dz: 1, groomed: false };
  }

  // ---------------------------------------------------------------- ring buffer
  alloc() {
    const i = this.head;
    this.head = (this.head + 1) % this.max;
    this.count = Math.min(this.max, this.count + 1);
    const r = this.ranges, n = r.length;
    if (n && r[n - 2] + r[n - 1] === i) r[n - 1]++;
    else r.push(i, 1);
    return i;
  }

  // one vertex: world position, terrain normal (xz), across direction (xz), uv, info, size
  vtx(v, x, y, z, nx, nz, sx, sz, u, w, birth, kind, a, b, hw, hl, d) {
    this.pos[v * 3] = x; this.pos[v * 3 + 1] = y; this.pos[v * 3 + 2] = z;
    this.frame[v * 4] = nx; this.frame[v * 4 + 1] = nz; this.frame[v * 4 + 2] = sx; this.frame[v * 4 + 3] = sz;
    this.uv[v * 2] = u; this.uv[v * 2 + 1] = w;
    this.info[v * 4] = birth; this.info[v * 4 + 1] = kind; this.info[v * 4 + 2] = a; this.info[v * 4 + 3] = b;
    this.size[v * 3] = hw; this.size[v * 3 + 1] = hl; this.size[v * 3 + 2] = d;
  }

  // ground height + slope under a mark corner: the rendered terrain, or a deck / kicker the skier is on
  ground(x, z, yHint) {
    const h = meshHeight(x, z);
    if (yHint > h + 0.2) {
      const g = world.groundHeight(x, z, yHint + 0.3);
      if (g > h + 0.05) { _ms.gx = 0; _ms.gz = 0; return g; }
    }
    return h;
  }

  // 0 on groomed pistes / pads (firm), 1 in untracked snow off-piste (deep marks); cached per emitter
  softAt(key, x, z) {
    let s = this.soft.get(key);
    if (!s) { s = { x: 1e9, z: 1e9, v: 0 }; this.soft.set(key, s); }
    if (Math.abs(x - s.x) + Math.abs(z - s.z) > 4) {
      s.x = x; s.z = z;
      const c = world.corridorAt(x, z, this._corr);
      let soft = c.groomed ? smooth(c.d, 1, 9) : 1;
      soft *= 1 - Math.min(1, world.padInfluence(x, z) * 1.5);
      s.v = soft;
    }
    return s.v;
  }

  // ---------------------------------------------------------------- ski tracks
  // Continuous strips per emitter (one per ski, or one per skier while skidding). A point is committed when
  // the strip has run 0.7 m (0.25 m skidding), turned 4 degrees, or its width / edge / skid changed: long
  // straight segments, dense ones through turns, never a gap (each segment starts on the last one's end).
  track(id, x, z, yHint, dx, dz, G, D, tilt, skid) {
    let m = this.emitters.get(id);
    if (!m) { m = { has: false, t: 0, a: newEdge(), b: newEdge(), p: newEdge(), pend: false }; this.emitters.set(id, m); }
    const sx = dz, sz = -dx; // left of the strip
    const W = G * TRACK_Q;
    if (m.has && (this.time - m.t > 0.5 || Math.hypot(x - m.a.x, z - m.a.z) > 6)) m.has = false; // stale / teleported
    m.t = this.time;
    if (!m.has) {
      // a skid band fades in from the skis' own width (no square-cut block where a skid begins)
      this.edge(m.a, x, z, yHint, dx, dz, sx, sz, skid > 0.3 ? Math.min(W, 0.09) : W, D, tilt, skid, 0);
      m.has = true; m.pend = false;
      return;
    }
    const a = m.a;
    const d = Math.hypot(x - a.x, z - a.z);
    if (d < 0.04) return;
    const cos = a.dx * dx + a.dz * dz;
    const maxLen = skid > 0.3 ? 0.25 : 0.7;
    if (d >= maxLen || cos < 0.9976 || Math.abs(W - a.W) > 0.25 * a.W + 0.01 || Math.abs(tilt - a.e) > 0.25 || Math.abs(skid - a.s) > 0.2) {
      this.edge(m.b, x, z, yHint, dx, dz, sx, sz, W, D, tilt, skid, a.v + d);
      this.trackQuad(a, m.b);
      m.a = m.b; m.b = a;
      m.pend = false;
    } else {
      // remember where the ski is, so the strip can be finished right there when it ends
      setPend(m.p, x, z, yHint, dx, dz, sx, sz, W, D, tilt, skid, a.v + d);
      m.pend = true;
    }
  }

  // the strip ends (air, stopped, skis off): close it at the last position seen
  end(id) {
    const m = this.emitters.get(id);
    if (!m || !m.has) return;
    if (m.pend && this.time - m.t < 0.5) {
      const p = m.p;
      // ...and narrows back to the skis where it ends
      this.edge(m.b, p.x, p.z, p.y, p.dx, p.dz, p.sx, p.sz, p.s > 0.3 ? Math.min(p.W, 0.09) : p.W, p.D, p.e, p.s, p.v);
      this.trackQuad(m.a, m.b);
    }
    m.has = false; m.pend = false;
  }

  edge(o, x, z, yHint, dx, dz, sx, sz, W, D, tilt, skid, v) {
    setPend(o, x, z, yHint, dx, dz, sx, sz, W, D, tilt, skid, v);
    const lx = x + sx * W, lz = z + sz * W, rx = x - sx * W, rz = z - sz * W;
    o.ly = this.ground(lx, lz, yHint); o.lnx = _ms.gx; o.lnz = _ms.gz;
    o.ry = this.ground(rx, rz, yHint); o.rnx = _ms.gx; o.rnz = _ms.gz;
  }

  // One segment between two committed edges. A wide strip (skid band) is split across into columns no wider
  // than ~0.45 m, each corner on the rendered terrain, so a band wider than the terrain's 2 m triangles never
  // cuts under a fold of the snow (its sunken parts would vanish behind straight crease lines and flicker as
  // the camera moves). Columns share their corners exactly: no seams.
  trackQuad(a, b) {
    const t = this.time, len = Math.hypot(b.x - a.x, b.z - a.z), wMax = Math.max(a.W, b.W);
    const cols = wMax > 0.2 ? 6 : 1;
    const lift = 0.004 + 0.012 * Math.max(len, (2 * wMax) / cols);
    for (let c = 0; c < cols; c++) {
      const i = this.alloc(), o = i * 4;
      for (let k = 0; k < 4; k++) {
        const e = k < 2 ? a : b, u = 1 - (2 * (c + (k & 1))) / cols; // +1 left edge .. -1 right edge
        const x = e.x + e.sx * e.W * u, z = e.z + e.sz * e.W * u;
        let y, gx, gz;
        if (u === 1) { y = e.ly; gx = e.lnx; gz = e.lnz; }
        else if (u === -1) { y = e.ry; gx = e.rnx; gz = e.rnz; }
        else { y = this.ground(x, z, e.y); gx = _ms.gx; gz = _ms.gz; }
        const il = 1 / Math.sqrt(1 + gx * gx + gz * gz);
        this.vtx(o + k, x, y + lift, z, -gx * il, -gz * il, e.sx, e.sz, u, e.v, t, K_TRACK, e.s, e.e, e.W, 0, e.D);
      }
    }
  }

  // ---------------------------------------------------------------- prints
  // A stamped mark centred at (x, z) facing `heading`: kind K_BOOT / K_SKIBOOT / K_SLAP / K_SPLAT,
  // hw / hl half size of the quad (m), depth (m), a = run / amount, side = +1 left foot, -1 right
  stamp(kind, x, z, yHint, heading, hw, hl, depth, a = 0, side = 0) {
    const fx = Math.sin(heading), fz = Math.cos(heading), sx = fz, sz = -fx, t = this.time;
    // big marks (landing slaps, crash splats) in tiles that follow the terrain, like the skid bands
    const nu = Math.max(1, Math.ceil((2 * hw) / 0.45)), nv = Math.max(1, Math.ceil((2 * hl) / 0.45));
    const lift = 0.004 + 0.012 * Math.max((2 * hw) / nu, (2 * hl) / nv);
    for (let r = 0; r < nv; r++) for (let c = 0; c < nu; c++) {
      const i = this.alloc(), o = i * 4;
      for (let k = 0; k < 4; k++) {
        const u = 1 - (2 * (c + (k & 1))) / nu, w = -1 + (2 * (r + (k < 2 ? 0 : 1))) / nv;
        const px = x + sx * hw * u + fx * hl * w, pz = z + sz * hw * u + fz * hl * w;
        const y = this.ground(px, pz, yHint);
        const il = 1 / Math.sqrt(1 + _ms.gx * _ms.gx + _ms.gz * _ms.gz);
        this.vtx(o + k, px, y + lift, pz, -_ms.gx * il, -_ms.gz * il, sx, sz, u, w, t, kind, a, side, hw, hl, depth);
      }
    }
  }

  // Boot print (old API, the player's step event): (x, z) body position, side +1 = right foot.
  // Skipped while the rig's real feet are being tracked (feetFX), which places prints under the feet.
  footprint(x, z, heading, side) {
    if (this.time - this.rigFeetT < 0.6) return;
    const rx = -Math.cos(heading), rz = Math.sin(heading); // right
    const cx = x + rx * side * 0.1, cz = z + rz * side * 0.1;
    const soft = this.softAt('fp', cx, cz);
    this.stamp(K_BOOT, cx, cz, -1e9, heading - side * 0.07, 0.085, 0.19, 0.014 + soft * 0.045, 0, -side);
  }

  update(dt, snow, env) {
    this.time += dt;
    const u = this.uniforms;
    u.uNow.value = this.time;
    // fresh snowfall fills marks in faster
    u.uFade.value = 1 / (180 - (snow || 0) * 140); // tracks fill in after ~3 min (~40 s in heavy snow)
    this.light(env);
    const r = this.ranges;
    if (r.length) {
      for (const a of this.attrs) {
        a.clearUpdateRanges();
        const n = a.itemSize * 4;
        for (let k = 0; k < r.length; k += 2) a.addUpdateRange(r[k] * n, r[k + 1] * n);
        a.needsUpdate = true;
      }
      r.length = 0;
      this.geo.setDrawRange(0, this.count * 6);
    }
  }

  // key light + sky light the snow gets (to light the relief the same way the terrain is lit)
  light(env) {
    const u = this.uniforms;
    if (env?.sun && env.lightDir) {
      u.uLightDir.value.copy(env.lightDir).normalize();
      u.uSunCol.value.copy(env.sun.color).multiplyScalar(env.sun.intensity / Math.PI);
      const ei = this.scene.environmentIntensity ?? 1, eu = env.envUniforms;
      if (eu?.uEnvZenith) {
        u.uSky.value.copy(eu.uEnvZenith.value).multiplyScalar(0.8).add(_c.copy(eu.uEnvHorizon.value).multiplyScalar(0.2)).multiplyScalar(ei);
        u.uGround.value.copy(eu.uEnvGround.value).multiplyScalar(ei);
      }
      if (env.hemi) {
        u.uSky.value.add(_c.copy(env.hemi.color).multiplyScalar(env.hemi.intensity / Math.PI));
        u.uGround.value.add(_c.copy(env.hemi.groundColor).multiplyScalar(env.hemi.intensity / Math.PI));
      }
      return;
    }
    // no environment handed in: the scene's shadow-casting sun, a fixed blue sky
    if (this._sun === undefined) {
      this._sun = null;
      this.scene.traverse((o) => { if (!this._sun && o.isDirectionalLight && o.castShadow) this._sun = o; });
    }
    const s = this._sun;
    if (s) {
      u.uLightDir.value.copy(s.position).sub(s.target.position).normalize();
      u.uSunCol.value.copy(s.color).multiplyScalar(s.intensity / Math.PI);
      u.uSky.value.setRGB(0.24, 0.42, 0.75).multiplyScalar(Math.max(0.05, s.intensity / 3));
      u.uGround.value.copy(u.uSky.value).multiplyScalar(0.6);
    }
  }

  // Old per-ski API (still used to end a racer's strips): emit(id, p, dir, halfWidth, active, skid)
  emit(id, p, dir, width, active, skid = 0) {
    if (!active || !p) { this.end(id); return; }
    this.track(id, p.x, p.z, p.y ?? -1e9, dir.x, dir.z, Math.max(0.02, width), 0.012, 0, Math.min(1, skid));
  }
}

function newEdge() {
  return { x: 0, z: 0, y: 0, dx: 0, dz: 1, sx: 1, sz: 0, W: 0, D: 0, e: 0, s: 0, v: 0, ly: 0, ry: 0, lnx: 0, lnz: 0, rnx: 0, rnz: 0 };
}
function setPend(o, x, z, y, dx, dz, sx, sz, W, D, e, s, v) {
  o.x = x; o.z = z; o.y = y; o.dx = dx; o.dz = dz; o.sx = sx; o.sz = sz; o.W = W; o.D = D; o.e = e; o.s = s; o.v = v;
}
function smooth(x, a, b) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }

// Snow particles: soft points lit by the scene light. Per particle: opacity (1 = the classic soft puff),
// growth (m/s) and gravity (m/s^2), so the same pool serves fine grains that fall fast (ski spray) and floaty
// puffs (snow cannons, landings).
export class Spray {
  constructor(scene) {
    this.max = 5000;
    this.p = new Float32Array(this.max * 3);
    this.v = new Float32Array(this.max * 3);
    this.life = new Float32Array(this.max);
    this.maxLife = new Float32Array(this.max).fill(1);
    this.size = new Float32Array(this.max);
    this.alpha = new Float32Array(this.max).fill(1);
    this.grow = new Float32Array(this.max).fill(0.5);
    this.grav = new Float32Array(this.max).fill(4.5);
    this.drag = new Float32Array(this.max).fill(2.2);
    this.alive = 0;
    this.next = 0;
    this.alphaDirty = false;
    const geo = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.p, 3).setUsage(THREE.DynamicDrawUsage);
    this.aLife = new THREE.BufferAttribute(new Float32Array(this.max), 1).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    this.aAlpha = new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.aPos);
    geo.setAttribute('aLife', this.aLife);
    geo.setAttribute('aSize', this.aSize);
    geo.setAttribute('aAlpha', this.aAlpha);
    this.uniforms = { uLight: { value: new THREE.Color(1, 1, 1) }, uScale: { value: 600 } };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, transparent: true, depthWrite: false,
      vertexShader: `attribute float aLife; attribute float aSize; attribute float aAlpha; uniform float uScale; varying float vLife;
        void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * mv;
          vLife = aLife * aAlpha * smoothstep(0.6, 2.5, -mv.z); // don't veil the lens in first person
          gl_PointSize = aLife > 0.0 ? aSize * uScale / -mv.z : 0.0; }`,
      fragmentShader: `uniform vec3 uLight; varying float vLife;
        void main(){ vec2 c = gl_PointCoord - 0.5; float r = length(c);
          float a = smoothstep(0.5, 0.0, r) * clamp(vLife, 0.0, 1.0) * 0.55;
          if (a < 0.01) discard;
          gl_FragColor = vec4(uLight * (0.9 + 0.1 * (0.5 - r)), a); }`,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;
    scene.add(this.points);
  }

  // count particles around pos (jitter m) with velocity vel +- spread; size (m), life (s);
  // alpha / grow / grav / drag: opacity scale, size growth (m/s), gravity (m/s^2), air drag (1/s) - the defaults
  // are the soft puff
  emit(pos, vel, count, spread = 1, size = 0.25, life = 1, alpha = 1, grow = 0.5, grav = 4.5, jitter = 0.3, drag = 2.2) {
    for (let k = 0; k < count; k++) {
      const i = this.next;
      this.next = (this.next + 1) % this.max;
      this.p[i * 3] = pos.x + (Math.random() - 0.5) * jitter;
      this.p[i * 3 + 1] = pos.y + Math.random() * 0.1;
      this.p[i * 3 + 2] = pos.z + (Math.random() - 0.5) * jitter;
      this.v[i * 3] = vel.x + (Math.random() - 0.5) * spread * 2;
      this.v[i * 3 + 1] = vel.y + Math.random() * spread * 1.5;
      this.v[i * 3 + 2] = vel.z + (Math.random() - 0.5) * spread * 2;
      this.maxLife[i] = life * (0.6 + Math.random() * 0.8);
      this.life[i] = this.maxLife[i];
      this.size[i] = size * (0.6 + Math.random() * 0.8);
      this.alpha[i] = alpha; this.grow[i] = grow; this.grav[i] = grav; this.drag[i] = drag;
    }
    if (count > 0) this.alphaDirty = true;
  }

  update(dt, light) {
    this.uniforms.uLight.value.copy(light);
    const L = this.aLife.array;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) { L[i] = 0; continue; }
      this.life[i] -= dt;
      const drag = 1 / (1 + dt * this.drag[i]);
      this.v[i * 3] *= drag; this.v[i * 3 + 2] *= drag;
      this.v[i * 3 + 1] = this.v[i * 3 + 1] * drag - this.grav[i] * dt;
      this.p[i * 3] += this.v[i * 3] * dt;
      this.p[i * 3 + 1] += this.v[i * 3 + 1] * dt;
      this.p[i * 3 + 2] += this.v[i * 3 + 2] * dt;
      this.size[i] += dt * this.grow[i];
      L[i] = this.life[i] / this.maxLife[i];
    }
    this.aPos.needsUpdate = true; this.aLife.needsUpdate = true; this.aSize.needsUpdate = true;
    if (this.alphaDirty) { this.aAlpha.needsUpdate = true; this.alphaDirty = false; }
  }
}

// ---------------------------------------------------------------------------------------------------
// Drives tracks, prints and spray from any skier (player or NPC).
// ---------------------------------------------------------------------------------------------------
const _p = new THREE.Vector3(), _d = new THREE.Vector3(), _vel = new THREE.Vector3(), _q = new THREE.Vector3(), _t = new THREE.Vector3();
const _up = new THREE.Vector3(), _f = new THREE.Vector3();
const SKI_HALF = 0.84; // half the ski length (m)
const SK = [0, 1].map(() => ({ ok: false, x: 0, y: 0, z: 0, dx: 0, dz: 1, ax: 0, az: 1, G: 0, D: 0, e: 0, s: 0, k: 0 }));
const merged = new Map(); // skier id -> skidding as one band

export function skierFX(trails, spray, id, rig, info, dt) {
  // info: { grounded, speed, vel, sideslip, plow, lean }
  const active = info.grounded && info.speed > 0.6 && rig.skiPos;
  const vh = Math.hypot(info.vel.x, info.vel.z) || 1;
  const skid = Math.min(1, info.sideslip * 2.5 + info.plow * 0.6);
  let soft = 0;
  if (active) {
    const s0 = rig.skis[0];
    soft = s0 ? trails.softAt(id, s0.position.x, s0.position.z) : 0;
  }
  const sp = Math.min(1, info.speed / 14);
  for (let i = 0; i < 2; i++) {
    const ski = rig.skis[i], S = SK[i];
    S.ok = false;
    if (!active || !ski || !ski.visible) continue;
    _d.set(0, 0, 1).applyQuaternion(ski.quaternion); _d.y = 0; _d.normalize();
    const ax = _d.x, az = _d.z; // the ski itself (the strip may lean toward the travel direction)
    _up.set(0, 1, 0).applyQuaternion(ski.quaternion);
    _p.copy(ski.position);
    // skis turned across the travel direction (hockey stops, skid turns) smear a band as wide as the
    // ski's projection across the path: lay the strip along the travel direction instead of the ski
    let k = 0, across = 0;
    if (vh > 0.5) {
      _t.set(info.vel.x / vh, 0, info.vel.z / vh);
      across = Math.abs(_d.x * _t.z - _d.z * _t.x); // sin of the angle between ski and path
      k = smooth(across, 0.18, 0.45);
      if (k > 0) {
        if (_d.dot(_t) < 0) _d.negate(); // keep the strip's sides consistent
        _d.lerp(_t, k).normalize();
      }
    }
    // edge tilt across the strip: the ski's up vector leaning to one side = that edge bites (+ = left)
    meshHeight(_p.x, _p.z);
    const nl = 1 / Math.sqrt(1 + _ms.gx * _ms.gx + _ms.gz * _ms.gz), nx = -_ms.gx * nl, ny = nl, nz = -_ms.gz * nl;
    const lx = _d.z, lz = -_d.x, ln = lx * nx + lz * nz; // strip-left, projected into the snow plane
    _f.set(lx - nx * ln, -ny * ln, lz - nz * ln).normalize();
    const tilt = Math.max(-1, Math.min(1, _up.dot(_f)));
    const at = Math.abs(tilt);
    // groove: ski-wide and shallow running flat, a narrow deeper trench on edge; wide and shallow skidding
    let G = 0.04 * (1 - 0.45 * at) + 0.005;
    let D = 0.007 + 0.02 * at * (0.45 + 0.55 * sp);
    const sk = Math.max(k, skid * 0.6);
    G = G + (Math.max(G, k * across * SKI_HALF * 0.95 + 0.03) - G) * k;
    D = D + (0.006 - D) * sk;
    // untracked snow off the pistes: the skis sink in, wider, deeper troughs with big walls
    if (soft > 0) { G = Math.min(0.9, G * (1 + 0.8 * soft)); D += (0.11 - 0.04 * sp - D) * soft; }
    S.ok = true; S.x = _p.x; S.y = _p.y; S.z = _p.z; S.dx = _d.x; S.dz = _d.z; S.ax = ax; S.az = az; S.G = G; S.D = D; S.e = tilt; S.s = Math.max(sk, skid * 0.5); S.k = k;
  }
  // skidding skis sweep (nearly) the same band: one strip for the pair, so the bands don't stack
  let both = SK[0].ok && SK[1].ok, one = false;
  if (both) {
    const a = SK[0], b = SK[1];
    const sx = (a.dz + b.dz) * 0.5, sz = -(a.dx + b.dx) * 0.5, sl = Math.hypot(sx, sz) || 1;
    const sep = Math.abs(((b.x - a.x) * sx + (b.z - a.z) * sz) / sl);
    const was = merged.get(id) || false;
    one = (a.G + b.G) > sep * (was ? 0.85 : 1.1) && Math.min(a.k, b.k) > 0.2;
    if (one !== was) { merged.set(id, one); trails.end(id); trails.end(id + 1); }
    if (one) {
      const mx = (a.x + b.x) * 0.5, mz = (a.z + b.z) * 0.5;
      let dx = a.dx + b.dx, dz = a.dz + b.dz; const dl = Math.hypot(dx, dz) || 1; dx /= dl; dz /= dl;
      const G = Math.max(a.G, b.G) + sep * 0.5;
      trails.track(id, mx, mz, Math.min(a.y, b.y), dx, dz, G, Math.max(a.D, b.D), (a.e + b.e) * 0.5, Math.max(a.s, b.s));
      trails.end(id + 1);
    }
  }
  if (!one) for (let i = 0; i < 2; i++) {
    const S = SK[i];
    if (S.ok) trails.track(id + i, S.x, S.z, S.y, S.dx, S.dz, S.G, S.D, S.e, S.s);
    else trails.end(id + i);
  }
  // spray: fine grains of snow that fall back fast, never a cloud over the skier
  if (active && spray) for (let i = 0; i < 2; i++) {
    const S = SK[i];
    if (!S.ok) continue;
    _p.set(S.x, S.y, S.z); _d.set(S.dx, 0, S.dz);
    // skis across the slide (hockey stop): the fan below takes over; this tail spray would sit between the
    // chase camera and the skier
    const across = 1 - S.k;
    const amount = (info.speed * (skid * 1.4 * across + Math.abs(info.lean) * 0.18) + (info.plow > 0.5 ? info.speed * 0.6 : 0)) * dt * (1 + soft * 0.8) * (0.25 + 0.75 * across);
    const n = Math.floor(amount * 7 + Math.random());
    if (n > 0) {
      const tail = _q.set(S.x - S.ax * 0.6, S.y, S.z - S.az * 0.6); // the ski's own tail
      _vel.copy(info.vel).multiplyScalar(0.3);
      // carving throws the snow to the outside of the turn (lean > 0 = turning right -> out to the left)
      _vel.x += _d.z * info.lean * 2.2; _vel.z += -_d.x * info.lean * 2.2;
      _vel.y += 0.9 + skid * 1.1;
      spray.emit(tail, _vel, Math.min(n, 10), 0.45 + skid * 0.4, 0.09 + skid * 0.04, 0.75, 0.8, 0.12, 8.5, 0.15);
      // deep snow: a whisper of powder dust behind the tails
      if (soft > 0.2 && Math.random() < soft * dt * 8) spray.emit(tail, _vel, 1, 0.5, 0.32, 0.9, 0.16, 0.45, 1.5, 0.2);
    }
    // hard skids (hockey stops, reverts): the downhill edge pushes the snow ahead - a low fan of grains thrown
    // with the slide and spread along the ski, landing a few metres ahead (the skier stays in clear view)
    if (skid > 0.45 && info.speed > 6) {
      const m = Math.min(20, Math.floor((skid - 0.45) * info.speed * dt * 36 + Math.random()));
      const tx = info.vel.x / vh, tz = info.vel.z / vh;
      for (let k = 0; k < m; k++) {
        const along = (Math.random() - 0.5) * 1.3, fwd = info.speed * (1.05 + 0.35 * Math.random()), fan = (Math.random() - 0.5) * 3.2;
        _q.set(S.x + tx * 0.3 + S.ax * along, S.y + 0.04, S.z + tz * 0.3 + S.az * along);
        _vel.set(tx * fwd + S.ax * fan, 1.1 + Math.random() * 1.9, tz * fwd + S.az * fan);
        spray.emit(_q, _vel, 1, 0.3, 0.11, 0.7, 0.85, 0.14, 7, 0.08, 0.6);
      }
      // a faint veil of fine powder at the root of the fan (ahead of the skis, below the knees)
      if (m > 0 && Math.random() < dt * 9) {
        _q.set(S.x + tx * 0.7, S.y + 0.1, S.z + tz * 0.7);
        _vel.set(tx * info.speed * 1.05, 0.6, tz * info.speed * 1.05);
        spray.emit(_q, _vel, 1, 0.35, 0.38, 0.8, 0.2, 0.35, 1.5, 0.3, 0.8);
      }
    }
  }
  // on foot: prints under the rig's real feet
  if (!info.grounded && (rig.mode === 'move' || rig.mode === 'foot')) feetFX(trails, id, rig, info, dt);
  else trails.feet.delete(id);
  if (rig.fx?.length) {
    for (const e of rig.fx) {
      if (spray) burst(spray, e, info.vel);
      marks(trails, id, rig, e);
    }
    rig.fx.length = 0;
  }
}

// Walking / running: a print each time a foot comes down, under the foot, pointing where the body faces (toes
// a little out). A foot that has clearly lifted is armed; the first frame it is back at its standing height is
// the touchdown (robust at any frame rate: no velocity test). Ski boots while the skis ride on the back.
function feetFX(trails, id, rig, info, dt) {
  const b = rig.b;
  if (!b?.lFoot || !b?.rFoot || dt <= 0) return;
  let st = trails.feet.get(id);
  if (!st) {
    st = [0, 1].map(() => ({ floor: 1, armed: false, init: false, px: 1e9, pz: 1e9 }));
    trails.feet.set(id, st);
  }
  trails.rigFeetT = trails.time;
  const speed = Math.hypot(info.vel.x, info.vel.z);
  const heading = rig.root?.rotation?.y ?? Math.atan2(info.vel.x, info.vel.z);
  const fx = Math.sin(heading), fz = Math.cos(heading);
  const run = smooth(speed, 2.2, 3.6);
  for (let i = 0; i < 2; i++) {
    const f = st[i];
    (i === 0 ? b.lFoot : b.rFoot).getWorldPosition(_f);
    const g = world.groundHeight(_f.x, _f.z, _f.y + 0.3);
    const hgt = _f.y - g;
    if (!f.init) { f.init = true; f.floor = hgt; continue; }
    // the ankle's height over the snow with the foot down: the lowest seen, creeping up slowly (slopes, rigs)
    f.floor = Math.min(hgt, f.floor + dt * 0.04);
    if (hgt > f.floor + 0.06) f.armed = true;
    else if (f.armed && hgt < f.floor + 0.03) {
      f.armed = false;
      if (speed > 0.25) {
        const side = i === 0 ? 1 : -1;
        // under the middle of the sole (ahead of the ankle), at least a natural half step width off the body line
        const r = rig.root.position, lat = (_f.x - r.x) * fz - (_f.z - r.z) * fx;
        const push = side * Math.max(0, 0.075 - side * lat);
        const cx = _f.x + fx * 0.055 + fz * push, cz = _f.z + fz * 0.055 - fx * push;
        // the same foot settling (first steps out of a standstill, shuffles): one print per footfall
        const o = st[1 - i];
        if (Math.hypot(cx - f.px, cz - f.pz) < 0.4 || Math.hypot(cx - o.px, cz - o.pz) < 0.16) continue;
        f.px = cx; f.pz = cz;
        const soft = trails.softAt(id + 'f', cx, cz);
        const ski = !!rig.carry;
        trails.stamp(ski ? K_SKIBOOT : K_BOOT, cx, cz, g, heading + side * 0.07, ski ? 0.08 : 0.085, ski ? 0.205 : 0.19,
          (ski ? 0.017 : 0.014) + run * 0.006 + soft * 0.045, run, side);
      }
    }
  }
}

// Marks left by one-shot events: both skis slapped into the snow on a landing, a body splat on a crash.
function marks(trails, id, rig, e) {
  const a = Math.max(0.05, Math.min(1, e.amount ?? 0.5));
  if (e.type === 'land' && a > 0.15) {
    const soft = trails.softAt(id, e.x, e.z);
    for (const ski of rig.skis) {
      if (!ski?.visible) continue;
      _d.set(0, 0, 1).applyQuaternion(ski.quaternion);
      trails.stamp(K_SLAP, ski.position.x, ski.position.z, ski.position.y, Math.atan2(_d.x, _d.z), 0.11, 0.9,
        0.008 + 0.022 * a + soft * 0.08, a, 0);
    }
  } else if ((e.type === 'crash' || e.type === 'impact') && a > 0.2) {
    const soft = trails.softAt(id, e.x, e.z);
    const s = 0.45 + 0.4 * a;
    trails.stamp(K_SPLAT, e.x, e.z, e.y, Math.random() * Math.PI * 2, s * 0.8, s, 0.03 + 0.04 * a + soft * 0.12, a, 0);
  }
}

// One-shot snow bursts queued by the rig / player: landings, crashes, tumble impacts, body slides,
// pole plants. A ring of particles thrown outward from the contact, scaled by `amount` (0..1).
function burst(spray, e, vel) {
  const a = Math.max(0.05, Math.min(1, e.amount ?? 0.5));
  _p.set(e.x, e.y + 0.05, e.z);
  const carry = 0.25;
  switch (e.type) {
    case 'land': {
      ring(spray, _p, vel, carry, 8, Math.round(4 + a * 9), 1.5 + a * 3, 1 + a * 2.2, 0.28 + a * 0.2, 1.1);
      break;
    }
    case 'crash': {
      ring(spray, _p, vel, 0.45, 10, Math.round(8 + a * 12), 2 + a * 3, 2 + a * 2.5, 0.38 + a * 0.2, 1.5);
      break;
    }
    case 'impact': {
      ring(spray, _p, vel, 0.3, 7, Math.round(3 + a * 8), 1.5 + a * 2.5, 1.2 + a * 2, 0.3 + a * 0.18, 1.2);
      break;
    }
    case 'slide': {
      _vel.set(e.vx ?? vel.x, 0, e.vz ?? vel.z).multiplyScalar(0.45);
      _vel.y = 1 + a * 1.5;
      spray.emit(_p, _vel, Math.round(5 + a * 10), 1 + a, 0.3 + a * 0.15, 1);
      break;
    }
    case 'pole': {
      _vel.set(vel.x * 0.1, 0.6 + a * 0.4, vel.z * 0.1);
      spray.emit(_p, _vel, Math.round(3 + a * 4), 0.35, 0.1 + a * 0.06, 0.6);
      break;
    }
  }
}
function ring(spray, pos, vel, carry, dirs, per, out, up, size, life) {
  for (let k = 0; k < dirs; k++) {
    const ang = (k / dirs) * Math.PI * 2 + Math.random() * 0.6;
    _vel.set(Math.cos(ang) * out + vel.x * carry, up, Math.sin(ang) * out + vel.z * carry);
    spray.emit(pos, _vel, per, out * 0.25, size, life);
  }
}
