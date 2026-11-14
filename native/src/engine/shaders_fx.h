// Effects programs: the snow trail stamps (world/snowtrails), soft lit particles (snow spray), the far forest's
// impostors, and the procedural texture bakes run once at start-up (the 2048 px snow and rock detail maps).
#pragma once

namespace sl::shaders {

// ---- trail stamps: instanced quads into the trail map (uv space of the toroidal map, [0,1] + wrap copies)
inline const char* kStampVS = R"GLSL(
layout(location = 0) in vec2 aCorner;     // -1..1
layout(location = 1) in vec4 aA;          // xy centre (map uv), zw half extent along / across (uv)
layout(location = 2) in vec4 aB;          // xy direction (unit, along), z kind, w strength
layout(location = 3) in vec4 aC;          // x along offset (m, tread phase), y metres per uv, z extra, w seed
out vec2 vLocal;                          // -1..1 across (x), along (y)
flat out vec4 vB;
flat out vec4 vC;
flat out vec2 vHalfM;                     // half extents in metres (along, across)
void main() {
  vec2 dir = aB.xy, side = vec2(-dir.y, dir.x);
  vec2 p = aA.xy + dir * aCorner.y * aA.z + side * aCorner.x * aA.w;
  vLocal = aCorner;
  vB = aB; vC = aC;
  vHalfM = aA.zw * aC.y;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
)GLSL";
inline const char* kStampFS = R"GLSL(
in vec2 vLocal;
flat in vec4 vB;
flat in vec4 vC;
flat in vec2 vHalfM;
out vec4 oColor;   // R groove depth, G berm, B packed, A freshness (max-blended)
float h1(float n) { return fract(sin(n * 127.1) * 43758.5453); }
void main() {
  int kind = int(vB.z + 0.5);
  float s = vB.w;
  float x = vLocal.x, y = vLocal.y;
  float am = y * vHalfM.x + vC.x;       // metres along (continuous along a track)
  float xm = x * vHalfM.y;              // metres across from the centre line
  vec4 o = vec4(0.0);
  if (kind == 0) {
    // ski groove: a rounded trough ~ the ski's width (the quad is 2x wider: the berm the edge throws up beside it)
    float w = vC.z;                      // half width of the ski (m)
    float u = abs(xm) / w;
    float trough = 1.0 - smoothstep(0.55, 1.0, u);
    float edgeCut = smoothstep(0.75, 1.0, u) * (1.0 - smoothstep(1.0, 1.15, u)) * 0.4;   // crisp edge wall
    float berm = smoothstep(1.0, 1.25, u) * (1.0 - smoothstep(1.35, 2.0, u));
    float endFade = 1.0 - smoothstep(0.85, 1.0, abs(y));
    o.r = (trough * 0.8 + edgeCut) * s;
    o.g = berm * s * 0.55 * (0.7 + 0.3 * h1(floor(am * 7.0) + vC.w));
    o.b = trough * s;
    o.a = max(trough, berm) * s;
    o *= endFade;
  } else if (kind == 1) {
    // boot print: sole + heel, tread lugs across, a lip of snow round it
    vec2 q = vec2(xm, y * vHalfM.x);   // metres: across, along (toe at +y)
    float L = vHalfM.x;
    float t = q.y / L;                 // -1 heel .. 1 toe
    float wid = mix(0.045, 0.058, smoothstep(-0.6, 0.5, t)) * (1.0 - smoothstep(0.75, 1.0, t) * 0.55);
    float waist = 1.0 - 0.18 * exp(-pow((t + 0.25) * 4.0, 2.0));
    float dx = abs(q.x) / (wid * waist);
    float inside = (1.0 - smoothstep(0.85, 1.0, dx)) * (1.0 - smoothstep(0.9, 1.0, abs(t)));
    float lugs = 0.75 + 0.25 * step(0.5, fract(q.y * 38.0 + step(0.0, q.x) * 0.5));
    float lip = (1.0 - smoothstep(1.0, 1.45, max(dx, abs(t) * 0.96))) * (1.0 - inside);
    o.r = inside * lugs * s;
    o.g = lip * s * 0.5;
    o.b = inside * s;
    o.a = max(inside, lip) * s;
  } else if (kind == 2) {
    // snowmobile track: a wide band with cleats across, packed hard
    float u = abs(x);
    float band = 1.0 - smoothstep(0.8, 1.0, u);
    float cleat = 0.7 + 0.3 * smoothstep(0.35, 0.55, abs(fract(am * 1.4) - 0.5) * 2.0);
    float berm = smoothstep(0.95, 1.15, u) * (1.0 - smoothstep(1.2, 1.6, u));
    float endFade = 1.0 - smoothstep(0.85, 1.0, abs(y));
    o.r = band * cleat * s * 0.7;
    o.g = berm * s * 0.6;
    o.b = band * s;
    o.a = max(band, berm) * s;
    o *= endFade;
  } else if (kind == 3) {
    // tyre: a band with block tread (offset rows), shallow
    float u = abs(x);
    float band = 1.0 - smoothstep(0.82, 1.0, u);
    vec2 tq = vec2(xm * 14.0, am * 9.0);
    tq.x += step(0.5, fract(tq.y * 0.5)) * 0.5;
    float block = step(0.25, fract(tq.x)) * step(0.3, fract(tq.y));
    float berm = smoothstep(0.98, 1.15, u) * (1.0 - smoothstep(1.2, 1.7, u));
    float endFade = 1.0 - smoothstep(0.85, 1.0, abs(y));
    o.r = band * (0.45 + 0.55 * block) * s * 0.5;
    o.g = berm * s * 0.35;
    o.b = band * s;
    o.a = max(band, berm) * s;
    o *= endFade;
  } else if (kind == 4) {
    // a pile of thrown snow (hockey stop, the spray landing): a soft mound
    float r = length(vLocal);
    float m = 1.0 - smoothstep(0.2, 1.0, r);
    float lumps = 0.7 + 0.3 * h1(floor(xm * 18.0) * 17.0 + floor(am * 18.0) + vC.w);
    o.g = m * m * s * lumps;
    o.a = m * s;
  } else {
    o = vec4(0.0);   // (kind 5: a clear, drawn with blending off)
  }
  oColor = o;
}
)GLSL";
inline const char* kTrailFadeFS = R"GLSL(
in vec2 vNdc;
out vec4 oColor;
uniform vec4 uFade;   // multiplied in (Blend::Multiply)
void main() { oColor = uFade; }
)GLSL";

// ---- soft, lit particles (snow spray, powder clouds): camera-facing quads, premultiplied alpha
inline const char* kParticleVS = R"GLSL(
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aPos;    // xyz camera-relative, w size (m)
layout(location = 2) in vec4 aCol;    // rgb albedo, a opacity
layout(location = 3) in vec4 aMisc;   // x rotation, y softness, zw unused
out vec2 vUV;
out vec4 vCol;
out vec3 vRel;
out float vSoft;
void main() {
  float c = cos(aMisc.x), s = sin(aMisc.x);
  vec2 k = mat2(c, s, -s, c) * aCorner;
  vec3 right = vec3(uView[0][0], uView[1][0], uView[2][0]), up = vec3(uView[0][1], uView[1][1], uView[2][1]);
  vec3 p = aPos.xyz + (right * k.x + up * k.y) * aPos.w;
  vUV = aCorner;
  vCol = aCol;
  vRel = p;
  vSoft = aMisc.y;
  gl_Position = uViewProj * vec4(p, 1.0);
}
)GLSL";
inline const char* kParticleFS = R"GLSL(
in vec2 vUV;
in vec4 vCol;
in vec3 vRel;
in float vSoft;
out vec4 oColor;
uniform sampler2D uDepth;
uniform vec2 uNearFar;
void main() {
  float r = length(vUV);
  if (r > 1.0) discard;
  float a = (1.0 - smoothstep(0.25, 1.0, r));
  a *= a * vCol.a;
  // soft against the scene depth
  vec2 suv = gl_FragCoord.xy * uRes.zw;
  float d = texture(uDepth, suv).x;
  float n = uNearFar.x, f = uNearFar.y;
  float sz = 2.0 * n * f / (f + n - (d * 2.0 - 1.0) * (f - n));
  float pz = dot(vRel, uCamFwd.xyz);
  a *= saturate((sz - pz) / max(vSoft, 0.02));
  a *= saturate((pz - 0.3) / 0.6);
  if (a < 0.003) discard;
  // lit like snow dust: the sun (forward scattering, it glows backlit), the sky light; no shadow lookups
  vec3 v = normalize(-vRel);
  float back = pow(saturate(dot(-v, uSunDir.xyz)), 6.0);
  vec3 sun = uSunColor.rgb * (0.22 + 0.9 * back) * (0.6 + 0.4 * shadowAt(vRel, vec3(0.0, 1.0, 0.0)));
  vec3 amb = envIrradiance(vec3(0.0, 1.0, 0.0)) * RECIPROCAL_PI * 1.15 + hemiIrradiance(vec3(0.0, 1.0, 0.0)) * RECIPROCAL_PI;
  vec3 col = vCol.rgb * (sun + amb) + localLights(vCol.rgb, v, vRel);
  col = applyFog(col, vRel);
  oColor = vec4(col * a, a);
}
)GLSL";

// ---- far forest impostors (vegetation.js's billboard forests): cylindrical billboards of a procedural conifer
// in the pines' own colours, snow on the tiers facing the sky, lit by the sun / sky / shadows; they dissolve in
// where the 3D trees end
inline const char* kImpostorVS = R"GLSL(
layout(location = 0) in vec2 aCorner;   // x -1..1, y 0..1
layout(location = 1) in vec4 aInst0;    // xyz world, w height (m)
layout(location = 2) in vec4 aInst1;    // x seed, y type, z fade-in start (m), w fade length
out vec2 vUV;
out vec3 vRel;
flat out vec4 vI;
out float vFade;
void main() {
  vec3 base = aInst0.xyz - uCamPos.xyz;
  vec3 toCam = -base; toCam.y = 0.0;
  float tl = length(toCam);
  vec3 side = tl > 1e-3 ? vec3(toCam.z, 0.0, -toCam.x) / tl : vec3(1.0, 0.0, 0.0);
  float H = aInst0.w, W = H * (aInst1.y > 0.5 ? 0.19 : 0.22);
  vec3 p = base + side * aCorner.x * W + vec3(0.0, aCorner.y * H, 0.0);
  vUV = aCorner;
  vRel = p;
  vI = vec4(aInst1.x, aInst1.y, H, W);
  float d = length(base);
  vFade = saturate((d - aInst1.z) / max(aInst1.w, 1.0));
  gl_Position = uViewProj * vec4(p, 1.0);
}
)GLSL";
inline const char* kImpostorFS = R"GLSL(
in vec2 vUV;
in vec3 vRel;
flat in vec4 vI;
in float vFade;
out vec4 oColor;
uniform sampler2D uNoise;
void main() {
  float y = vUV.y, x = vUV.x;
  float seed = vI.x;
  // tiers of drooping branches: the radius saws down to the next tier's base
  float tiers = 9.0 + floor(seed * 4.0);
  float ty = fract(y * tiers + seed * 3.1);
  float cone = (1.0 - y) * 0.92 + 0.04;
  float jag = texture(uNoise, vec2(x * 0.7 + seed * 7.0, y * 3.0 + seed)).r;
  float r = cone * (0.78 + 0.22 * ty) * (0.85 + 0.3 * jag);
  float trunk = step(y, 0.08) * step(abs(x), 0.06);
  float a = max(step(abs(x), r) * step(0.05, y), trunk);
  // edge softness (stable under minification)
  float e = (r - abs(x)) / max(fwidth(x) * 1.2, 1e-4);
  a = max(saturate(e) * step(0.05, y), trunk);
  // dither in over the hand-over band (no pop against the 3D trees)
  float dith = ign(gl_FragCoord.xy + seed * 97.0);
  if (a < 0.5 || vFade < dith) discard;
  // a cylinder-ish normal: across the billboard, and up on the top of each tier
  vec3 toCam = normalize(vec3(-vRel.x, 0.0, -vRel.z));
  vec3 side = vec3(toCam.z, 0.0, -toCam.x);
  float nx = clamp(x / max(r, 1e-3), -1.0, 1.0);
  float up = smoothstep(0.55, 1.0, ty) * 0.8;
  vec3 n = normalize(side * nx + toCam * sqrt(max(1.0 - nx * nx, 0.0)) + vec3(0.0, up, 0.0));
  // pine colours (vegetation.js pineNeedle range), snow on the tiers' tops
  vec3 alb = mix(vec3(0.011, 0.027, 0.040), vec3(0.028, 0.060, 0.072), jag) * (0.8 + 0.4 * ty);
  float snow = smoothstep(0.6, 0.95, ty) * smoothstep(0.45, 0.75, jag + uMisc.y * 0.3) * 0.85;
  alb = mix(alb, vec3(0.82, 0.86, 0.92), snow);
  if (trunk > 0.5 && abs(x) < r * 0.3) alb = vec3(0.03, 0.025, 0.02);
  float sh = shadowAt(vRel, n);
  Lit L = lightSurface(alb, 0.0, 0.85, n, normalize(-vRel), sh, n);
  L.iDiff *= mix(0.55, 1.0, y);   // the crown's own shade low down
  vec3 col = sumLit(L, 1.0);
  oColor = vec4(applyFog(col, vRel), 1.0);
}
)GLSL";

// ---- sun glare (sunglare.js): a blinding HDR core, cyan-white halo and wide glow, a starburst of 32 tapering
// spikes; added into the HDR image (so it blooms) only as far as the sun is really in clear view (the scene depth
// round the sun, sampled in the vertex shader)
inline const char* kGlareVS = R"GLSL(
layout(location = 0) in vec2 aCorner;
uniform sampler2D uDepth;
uniform float uSize;        // half size in half-screen-heights
out vec2 vP;
flat out float vVis;
void main() {
  vec4 sc = uViewProj * vec4(uTrueSun.xyz, 0.0);
  vec2 sun = sc.xy / max(sc.w, 1e-4);
  float aspect = uProj[1][1] / uProj[0][0];
  vec2 off = aCorner * uSize;
  vP = off;
  float v = 0.0;
  vec2 suv = sun * 0.5 + 0.5;
  for (int y = -2; y <= 2; y++) for (int x = -2; x <= 2; x++) {
    vec2 q = suv + vec2(float(x) / aspect, float(y)) * 0.0045;
    v += (q.x > 0.0 && q.x < 1.0 && q.y > 0.0 && q.y < 1.0 && textureLod(uDepth, q, 0.0).x > 0.99999) ? 1.0 : 0.0;
  }
  vVis = v / 25.0;
  gl_Position = vec4(sun.x + off.x / aspect, sun.y + off.y, 0.0, 1.0);
  if (sc.w <= 0.0 || vVis <= 0.0) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
}
)GLSL";
inline const char* kGlareFS = R"GLSL(
in vec2 vP;
flat in float vVis;
out vec4 oColor;
uniform vec4 uRays[32];
uniform float uRayI[32];
uniform vec3 uCore;
uniform vec3 uHaloTint;
uniform float uRot;
uniform float uSize;
void main() {
  vec2 p = vP;
  float r = length(p);
  float core = (1.0 - smoothstep(0.016, 0.034, r)) * 34.0 + exp(-r * r / (0.055 * 0.055)) * 8.0;
  vec3 inner = exp(-r / (vec3(0.82, 0.95, 1.12) * 0.07)) * 2.4;
  vec3 halo = exp(-r / (vec3(0.86, 1.0, 1.18) * 0.24));
  float wide = exp(-r / 0.45) * 0.3;
  float s = 0.0;
  if (r > 0.002) {
    float cr = cos(uRot), sr = sin(uRot);
    vec2 q = vec2(cr * p.x + sr * p.y, -sr * p.x + cr * p.y);
    const float SP = 6.2831853 / 32.0;
    float k = floor((atan(q.y, q.x) - 0.3) / SP + 0.5);
    for (int j = -2; j <= 2; j++) {
      int idx = int(mod(k + float(j) + 32.0, 32.0));
      vec4 R = uRays[idx];
      float along = dot(q, R.xy);
      float perp = q.x * R.y - q.y * R.x;
      float w = R.w * (0.15 + 0.85 * exp(-along / (0.6 * R.z)));
      float x2 = perp * perp / (w * w);
      float flicker = 0.92 + 0.08 * sin(uCamPos.w * 0.7 + float(idx) * 1.9);
      s += uRayI[idx] * flicker * (exp(-x2) + exp(-x2 * 0.25) * 0.4) * exp(-max(along, 0.0) / R.z) * step(0.0, along);
    }
    s *= smoothstep(0.004, 0.025, r);
  }
  vec3 col = uCore * (core + s * 2.2) + uHaloTint * (inner + halo + wide) * dot(uCore, vec3(0.333));
  col *= 1.0 - smoothstep(uSize * 0.6, uSize, r);
  col *= 1.0 + (ign(gl_FragCoord.xy) - 0.5) * 0.03;
  oColor = vec4(col * vVis, 0.0);
}
)GLSL";

// ---- procedural texture bakes (periodic gradient noise; run once into mip-mapped render targets)
inline const char* kBakeCommon = R"GLSL(
in vec2 vNdc;
out vec4 oColor;
uniform float uSize;   // texels
vec2 hash22(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.xx + q.yz) * q.zy) * 2.0 - 1.0;
}
// gradient noise with period P (integer lattice wraps): tiles seamlessly
float pnoise(vec2 p, float P) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 a = mod(i, P), b = mod(i + vec2(1, 0), P), c = mod(i + vec2(0, 1), P), d = mod(i + vec2(1, 1), P);
  float va = dot(hash22(a), f), vb = dot(hash22(b), f - vec2(1, 0)), vc = dot(hash22(c), f - vec2(0, 1)), vd = dot(hash22(d), f - vec2(1, 1));
  return mix(mix(va, vb, u.x), mix(vc, vd, u.x), u.y) * 1.4;
}
// periodic cellular noise: (F1, F2) distances
vec2 pcell(vec2 p, float P) {
  vec2 i = floor(p), f = fract(p);
  float d1 = 9.0, d2 = 9.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(x, y);
    vec2 o = hash22(mod(i + g, P)) * 0.5 + 0.5;
    float d = length(g + o - f);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
  }
  return vec2(d1, d2);
}
)GLSL";
// snow: RG slope (0.5 flat), B height, A crystal / grain mask. One tile = 1.6 m of snow (the shader's scale).
inline const char* kBakeSnowFS = R"GLSL(
float snowH(vec2 uv) {
  // wind-packed undulation, sintered grains (rounded cells), pits and a fine crust
  float h = 0.0;
  h += pnoise(uv * 4.0, 4.0) * 0.30 + pnoise(uv * 9.0 + 3.1, 9.0) * 0.18;
  vec2 c = pcell(uv * 48.0, 48.0);
  h += (1.0 - smoothstep(0.0, 0.9, c.x)) * 0.16;          // grains
  vec2 c2 = pcell(uv * 130.0 + 0.5, 130.0);
  h += (1.0 - smoothstep(0.0, 0.8, c2.x)) * 0.07;         // fine grains
  h -= smoothstep(0.62, 0.95, pnoise(uv * 22.0 + 7.7, 22.0) * 0.5 + 0.5) * 0.12;  // little pits
  h += pnoise(uv * 64.0 + 1.3, 64.0) * 0.05 + pnoise(uv * 180.0, 180.0) * 0.025;
  return h;
}
void main() {
  vec2 uv = (gl_FragCoord.xy) / uSize;
  float e = 1.0 / uSize;
  float h = snowH(uv);
  float hx = snowH(uv + vec2(e, 0.0)) - snowH(uv - vec2(e, 0.0));
  float hy = snowH(uv + vec2(0.0, e)) - snowH(uv - vec2(0.0, e));
  vec2 g = vec2(hx, hy) / (2.0 * e) * 0.0016;   // slope per metre-ish (1.6 m tile, height in ~cm)
  vec2 cr = pcell(uv * 260.0 + 0.25, 260.0);
  float crystal = (1.0 - smoothstep(0.0, 0.25, cr.x)) * step(0.55, hash22(floor(uv * 260.0)).x * 0.5 + 0.5);
  oColor = vec4(clamp(0.5 + g * 0.5, 0.0, 1.0), clamp(h * 0.9 + 0.5, 0.0, 1.0), crystal);
}
)GLSL";
// rock: RG slope, B height, A albedo variation (lichen, mineral bands). One tile = 4 m.
inline const char* kBakeRockFS = R"GLSL(
float rockH(vec2 uv) {
  float h = 0.0, a = 0.5, f = 3.0;
  for (int i = 0; i < 6; i++) {
    float n = 1.0 - abs(pnoise(uv * f + float(i) * 1.7, f));
    h += n * n * a;
    a *= 0.5; f *= 2.0;
  }
  vec2 c = pcell(uv * 7.0, 7.0);
  h -= (1.0 - smoothstep(0.0, 0.08, c.y - c.x)) * 0.35;   // cracks between the blocks
  vec2 c2 = pcell(uv * 19.0 + 0.3, 19.0);
  h -= (1.0 - smoothstep(0.0, 0.05, c2.y - c2.x)) * 0.12;
  h += c.x * 0.15;
  return h;
}
void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  float e = 1.0 / uSize;
  float h = rockH(uv);
  float hx = rockH(uv + vec2(e, 0.0)) - rockH(uv - vec2(e, 0.0));
  float hy = rockH(uv + vec2(0.0, e)) - rockH(uv - vec2(0.0, e));
  vec2 g = vec2(hx, hy) / (2.0 * e) * 0.012;
  float lich = smoothstep(0.35, 0.7, pnoise(uv * 11.0 + 4.0, 11.0) * 0.5 + 0.5) * smoothstep(0.3, 0.6, pnoise(uv * 37.0, 37.0) * 0.5 + 0.5);
  float var = 0.5 + pnoise(uv * 5.0 + 9.0, 5.0) * 0.3 + lich * 0.35 - (1.0 - smoothstep(0.0, 0.08, pcell(uv * 7.0, 7.0).y - pcell(uv * 7.0, 7.0).x)) * 0.25;
  oColor = vec4(clamp(0.5 + g * 0.5, 0.0, 1.0), clamp(h * 0.6 + 0.2, 0.0, 1.0), clamp(var, 0.0, 1.0));
}
)GLSL";

} // namespace sl::shaders
