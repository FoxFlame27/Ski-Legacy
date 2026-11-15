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
layout(location = 3) in vec4 aMisc;   // x rotation, y softness, z kind (0 powder puff, 1 a clump of snow), w seed
out vec2 vUV;
out vec4 vCol;
out vec3 vRel;
out vec3 vCenter;
out vec4 vMisc;
void main() {
  float c = cos(aMisc.x), s = sin(aMisc.x);
  vec2 k = mat2(c, s, -s, c) * aCorner;
  vec3 right = vec3(uView[0][0], uView[1][0], uView[2][0]), up = vec3(uView[0][1], uView[1][1], uView[2][1]);
  if (aMisc.z > 2.5) k.y *= aMisc.w;   // (a lamp's halo: seed = its height / width)
  vec3 p = aPos.xyz + (right * k.x + up * k.y) * aPos.w;
  vUV = aCorner;
  vCol = aCol;
  vRel = p;
  vCenter = aPos.xyz;
  vMisc = vec4(aMisc.y, aMisc.z, aMisc.w, aPos.w);
  gl_Position = uViewProj * vec4(p, 1.0);
}
)GLSL";
// Powder puffs: every particle is a little cloud — a sphere of snow dust whose edge is eaten by drifting noise (no
// disc outlines; overlapping puffs read as one billowing plume), shaded as a volume: the sun wraps round it, its
// far side falls into sky-blue shade, back-lit it glows at the rim (forward scattering), the scene's shadows and
// the lamps light it, it fades into whatever it touches (soft against the depth) and before the lens.
inline const char* kParticleFS = R"GLSL(
in vec2 vUV;
in vec4 vCol;
in vec3 vRel;
in vec3 vCenter;
in vec4 vMisc;     // x softness, y kind, z seed, w size
out vec4 oColor;
uniform sampler2D uDepth;
uniform vec2 uNearFar;
void main() {
  float r = length(vUV);
  if (r > 1.0) discard;
  float a;
  float hgt = sqrt(max(1.0 - r * r, 0.0));
  if (vMisc.y > 2.5) {
    // a lamp's glow (carlights.js's halo sprites): a hot core and a soft halo, added to the image; it sinks into the
    // bodywork it touches and never shows as a quad
    vec2 suv0 = gl_FragCoord.xy * uRes.zw;
    float d0 = texture(uDepth, suv0).x;
    float nn = uNearFar.x, ff = uNearFar.y;
    float sz0 = 2.0 * nn * ff / (ff + nn - (d0 * 2.0 - 1.0) * (ff - nn));
    float pz0 = dot(vRel, uCamFwd.xyz);
    float k = saturate((sz0 - pz0) / max(vMisc.x, 0.02) + 0.35) * vCol.a;
    // (carlights.js haloTexture: a bright core falling off fast, then a long soft skirt)
    float glow = r < 0.1 ? mix(1.0, 0.7, r / 0.1) : r < 0.28 ? mix(0.7, 0.28, (r - 0.1) / 0.18) : r < 0.55 ? mix(0.28, 0.08, (r - 0.28) / 0.27) : mix(0.08, 0.0, (r - 0.55) / 0.45);
    oColor = vec4(vCol.rgb * glow * k, 0.0);
    return;
  }
  if (vMisc.y > 0.5 && vMisc.y < 1.5) {
    a = 1.0 - smoothstep(0.55, 1.0, r);          // a clump: a small soft-edged body
  } else {
    vec2 q = vUV * (0.11 + 0.05 * fract(vMisc.z * 7.31)) + vec2(vMisc.z * 3.7, vMisc.z * 9.1) + uCamPos.w * vec2(0.013, 0.009);
    float n = texture(uSkyNoise, q).r * 0.6 + texture(uSkyNoise, q * 2.9 + 0.31).g * 0.4;
    float body = 1.0 - smoothstep(0.0, 1.0, r);
    a = smoothstep(0.0, 0.5, body * 1.5 - (0.62 - n) * 1.25) * smoothstep(0.0, 0.55, body);
    if (vMisc.y > 1.5) a *= body;   // (the guns' fine mist: no outline at all)
  }
  a *= vCol.a;
  // soft against the scene depth, and no hard slab in front of the lens
  vec2 suv = gl_FragCoord.xy * uRes.zw;
  float d = texture(uDepth, suv).x;
  float n0 = uNearFar.x, f0 = uNearFar.y;
  float sz = 2.0 * n0 * f0 / (f0 + n0 - (d * 2.0 - 1.0) * (f0 - n0));
  float pz = dot(vRel, uCamFwd.xyz);
  a *= saturate((sz - pz) / max(vMisc.x, 0.02));
  a *= saturate((pz - 0.25) / max(0.5, vMisc.w * 0.8));
  if (a < 0.003) discard;
  // the puff as a small volume: a normal bulging toward the eye
  vec3 right = vec3(uView[0][0], uView[1][0], uView[2][0]), up = vec3(uView[0][1], uView[1][1], uView[2][1]);
  vec3 toEye = normalize(-vCenter);
  vec3 N = normalize(right * vUV.x + up * vUV.y + toEye * (hgt + 0.25));
  vec3 v = normalize(-vRel);
  float ndl = dot(N, uSunDir.xyz);
  float wrap = saturate((ndl + 0.75) / 1.75);
  float back = pow(saturate(dot(-v, uSunDir.xyz)), 5.0);
  float sh = 0.45 + 0.55 * shadowAt(vCenter, vec3(0.0, 1.0, 0.0));
  vec3 sun = uSunColor.rgb * sh * (0.1 + 0.2 * wrap + 0.75 * back * (0.45 + 0.55 * r));
  vec3 amb = (envIrradiance(N) * 1.1 + hemiIrradiance(N)) * RECIPROCAL_PI * (0.8 + 0.2 * hgt);
  vec3 col = vCol.rgb * (sun + amb) + localLights(vCol.rgb, mix(N, v, 0.5), vRel) * 1.6;
  if (vMisc.y > 1.5) col += vCol.rgb * (0.02 + 0.05 * uMisc.x);   // (a snow gun's plume: pale in its own floodlight / the moonlight, snowmaking.js)
  col = applyFog(col, vRel);
  oColor = vec4(col * a, a);
}
)GLSL";

// ---- snowfall (atmosphere.js makeSnow, on the GPU): flakes in a 46 m box that wraps round the camera, each with
// its own fall speed, flutter and tumble; drawn as quads with a size in metres (so the layers part with parallax),
// never under ~1.6 px (smaller ones keep the size and thin out instead: no sparkling noise in the distance), faded
// before the lens and toward the far side of the box, sheared a little along their motion (a blizzard's streaks,
// sleet's falling lines), lit by the sun, the sky and the lamps round them.
inline const char* kSnowVS = R"GLSL(
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aSeed;   // xyz position in the unit box, w rank 0..1
uniform vec4 uSnowOff;    // xyz the air's drift (m, accumulated), w time (s)
uniform vec4 uSnowP;      // x snowfall 0..1, y rain 0..1, z box size (m), w -
uniform vec4 uSnowVel;    // xyz the air's velocity (m/s), w shutter (s)
out vec2 vC;
out vec4 vP;              // x alpha, y rotation, z lens blur, w small (soft dot)
out vec3 vCol;
out float vRain;
void main() {
  float B = uSnowP.z, t = uSnowOff.w;
  float seed = fract(aSeed.w * 97.13);
  float fall = 0.7 + seed * 0.7;                         // heavier flakes fall faster
  vec3 drift = vec3(uSnowOff.x, -fall * uSnowOff.y, uSnowOff.z);
  vec2 fl = vec2(sin(t * (0.6 + seed) + aSeed.y * 40.0), cos(t * (0.5 + seed * 0.7) + aSeed.x * 40.0));
  drift.xz += fl * 0.8;                                  // flutter
  vec3 cell = aSeed.xyz * B;
  float crystal = step(0.5, uSnowP.w), rank = aSeed.w * max(uSnowP.w, 1.0);
  float rot = t * (seed - 0.5) * 3.0 + seed * 40.0;
  if (crystal > 0.5) {
    // atmosphere.js updateCrystals: the flakes closest to the camera, wet clumps tumbling in a 7 m box
    // (fall 0.7 .. 1.3, a slow sway of 0.35 m, 3.5 .. 8 cm across)
    float ph = fract(aSeed.w * 517.3) * 6.28;
    fall = 0.7 + fract(aSeed.w * 211.7) * 0.6;
    drift = vec3(uSnowOff.x + sin(t * 0.9 + ph) * 0.35, -fall * uSnowOff.y, uSnowOff.z + cos(t * 0.7 + ph) * 0.35);
    rot = t * (fract(aSeed.w * 97.13) - 0.5) * 3.0 + ph;
  }
  vec3 wp = mod(cell + drift - uCamPos.xyz + B * 0.5, B) - B * 0.5;   // camera-relative
  float d = max(dot(wp, uCamFwd.xyz), 0.0);                            // (-mv.z)
  float pxPerM = uRes.y * 0.5 / (uCamFwd.w * max(d, 0.02));
  float size, alpha, px;
  if (crystal > 0.5) {
    size = 0.035 + fract(aSeed.w * 431.9) * 0.045;        // metres, as modelled
    px = size * pxPerM;
    alpha = step(rank + 1e-4, uSnowP.x) * step(uSnowP.y, 0.5) * 0.9 * smoothstep(0.1, 0.3, d);
  } else {
    // flake diameter (big wet flakes; heavy snow falls in bigger, wetter ones; a rain streak is longer), drawn as the
    // web game's points: gl_PointSize = clamp(size * projectionMatrix[1][1] * 1500 / d, 2, 96) px
    size = (0.026 + seed * 0.034) * (0.8 + 0.45 * uSnowP.x) * (1.0 + 0.7 * uSnowP.y);
    // (the web game's 1500 / d made the near flakes up to 96 px: the user found them huge. Here a flake keeps its real
    // projected size, a little enlarged so it reads, capped by the screen's height)
    float kRes = uRes.y / 1080.0;
    px = clamp(size * pxPerM * 1.5, 1.5 * kRes, 26.0 * kRes);
    size = px / pxPerM;
    // strictly rank < snow: nothing at all falls when it does not snow
    alpha = step(rank + 1e-4, uSnowP.x) * smoothstep(0.12, 0.5, d) * (1.0 - smoothstep(18.0, 23.0, d));
  }
  float cr = cos(rot), sr = sin(rot);
  vec2 k = mat2(cr, sr, -sr, cr) * aCorner;
  // (a crystal is a flattened clump, y x 0.55, tumbling in 3D: seen flat or edge-on in turn)
  if (crystal > 0.5) k.y *= 0.55 + 0.45 * abs(cos(t * (1.3 + seed * 2.2) + seed * 17.0));
  vec3 right = vec3(uView[0][0], uView[1][0], uView[2][0]), up = vec3(uView[0][1], uView[1][1], uView[2][1]);
  vec3 p = wp + (right * k.x + up * k.y) * (size * 0.5);
  vC = aCorner;
  vRain = uSnowP.y;
  vP = vec4(alpha, rot, crystal > 0.5 ? 0.0 : 1.0 - smoothstep(0.25, 1.6, d), crystal > 0.5 ? 0.5 : 1.0 - smoothstep(5.0, 12.0, px));   // (a crystal: a soft-edged clump)
  // light: the sun through the flake (brighter against the sun), the sky, and the lamps near it
  vec3 v = normalize(-wp);
  float back = pow(max(dot(-v, uSunDir.xyz), 0.0), 4.0);
  // (the sky's irradiance from above: the SH of the lighting chunk for n = +y, and the hemisphere light's sky colour)
  vec3 skyE = max(uSH[0].rgb * 0.886227 + uSH[1].rgb * 1.023328 - uSH[6].rgb * 0.247708 - uSH[8].rgb * 0.429043, vec3(0.0)) * uHemiSky.w;
  // atmosphere.js: col = uAmbient * 1.25 + uLight * 0.55, uLight = the sun's colour x intensity / 3.4, uAmbient = the
  // hemisphere light's colour x lerp(0.12, 0.9, day): the same white for every flake, whatever is behind it
  vec3 hemiC = uHemiSky.rgb / max(max(uHemiSky.r, uHemiSky.g), max(uHemiSky.b, 1e-4));
  vec3 col = hemiC * (mix(0.12, 0.9, uTrueSun.w) * 1.25) + uSunColor.rgb * (uSunColor.w * 0.55 / 3.4) + skyE * 0.0 * back;
  int cnt = int(uLightCount.x);
  for (int i = 0; i < SL_MAX_LIGHTS; i++) {
    if (i >= cnt) break;
    vec4 la = uLight[i * 3], lb = uLight[i * 3 + 1], lc = uLight[i * 3 + 2];
    vec3 dl = la.xyz - wp;
    float ld = length(dl);
    if (ld > la.w) continue;
    float win = clamp(1.0 - pow(ld / la.w, 4.0), 0.0, 1.0);
    float spot = lb.w < -1.5 ? 1.0 : smoothstep(lb.w, lc.w, dot(-dl / max(ld, 1e-3), lc.xyz));
    col += lb.rgb * (win * win / (ld * ld + 1.0) * spot * 0.22);
  }
  // (against a bright overcast sky a flake is a grey speck, not a light: its own shade grows with the snowfall)
  // (by day a flake is the brightest thing in the grey air: at least half again as bright as the haze behind it, so
  // the snowfall reads against the sky, the far slopes and the trees; against sunlit snow its soft blue-grey edge does)
  // (the web game writes this colour straight to the canvas, past its tone mapping: there it is white by day. Here the
  // flakes go through the exposure and the tone map with the scene: lifted so they come out the same white)
  vCol = col * (crystal > 0.5 ? 1.7 : 3.0);   // (a crystal is a lit white clump, shaded: not blown out)
  gl_Position = uViewProj * vec4(p, 1.0);
}
)GLSL";
inline const char* kSnowFS = R"GLSL(
in vec2 vC;
in vec4 vP;
in vec3 vCol;
in float vRain;
out vec4 oColor;
void main() {
  vec2 c = vC * 0.5;
  float lc = length(c);
  if (lc > 0.5) discard;
  if (vRain > 0.5) {   // sleet: a thin, faint falling streak
    float st = (1.0 - smoothstep(0.015, 0.06, abs(c.x))) * (1.0 - smoothstep(0.2, 0.5, abs(c.y))) * vP.x;
    if (st < 0.02) discard;
    oColor = vec4(vCol * 0.9 * st * 0.5, st * 0.5);
    return;
  }
  // an irregular soft speck (a clump of crystals, never a star: up close that reads as an icon), its outline
  // wobbling with its own spin; a soft disc when it is only a few pixels; an out-of-focus disc before the lens
  float ang = atan(c.y, c.x);
  float rr = lc * (1.0 + 0.16 * sin(ang * 3.0 + vP.y) + 0.09 * sin(ang * 5.0 - vP.y * 1.7));
  float shape = 1.0 - smoothstep(0.24, 0.5, rr);
  float disc = 1.0 - smoothstep(0.0, 0.5, lc);                // soft bokeh disc for very close flakes
  float a = mix(mix(shape, disc, vP.w), disc * 0.55, vP.z) * vP.x;
  if (a < 0.02) discard;
  // lit on its face, shaded toward its rim: white against dark trees, and its greyer rim still shows against
  // bright snow and an overcast sky
  // (two tones: a light core that shows against trees and the grey air, and a darker blue-grey rim that shows
  // against sunlit snow and a bright sky: by day the snowfall reads everywhere without glowing)
  float rim = smoothstep(0.12, 0.48, lc) * (1.0 - vP.z);
  vec3 col = vCol * mix(1.08, 0.6, rim);
  a *= 0.95;
  oColor = vec4(col * a, a);
}
)GLSL";

// ---- valley mist (native; atmosphere.js makeMist / placeMist are camera-facing cards in the valleys): a ray-marched
// layer of mist that hugs the ground, thicker in the floors that lie below their surroundings (the ground map's fine
// level against its ~1 km mean), broken into slowly drifting banks; lit by the sun with a forward-scattering lobe
// (the air glows toward the sun), shadowed by the terrain / trees / clouds near the camera (shafts through the
// mist), and by the sky. Drawn at half resolution after the resolve, upsampled depth-aware (kMistUpFS).
inline const char* kMistFS = R"GLSL(
in vec2 vNdc;
out vec4 oColor;
uniform mat4 uInvViewProj;
uniform sampler2D uDepth;
uniform sampler2D uGround;   // R: ground height (m; its higher mips: the regional mean), G: the valley floor's level round about
uniform vec2 uNearFar;
uniform vec4 uGroundMap;     // xy the map's centre (world xz), z 1 / span, w texels across
uniform vec4 uMist;          // x amount 0..1, y layer scale height (m), zw drift (noise uv)
uniform vec4 uMist2;         // x fair weather 0..1 (the village and the air round the camera stay clear), y steps, z extinction (1/m), w the mist sea's depth over the valley floors (m)
float groundAt(vec2 xz, float lod) { return textureLod(uGround, (xz - uGroundMap.xy) * uGroundMap.z + 0.5, lod).r; }
float mistDensity(vec3 p, float camD) {
  vec2 uv = (p.xz - uGroundMap.xy) * uGroundMap.z;
  float edge = 1.0 - smoothstep(0.4, 0.49, max(abs(uv.x), abs(uv.y)));
  if (edge <= 0.0) return 0.0;
  vec2 gf = textureLod(uGround, uv + 0.5, 0.0).rg;
  float hag = p.y - gf.x, hv = p.y - gf.y;
  float H = uMist.y;
  if (hag > H * 5.0 && hv > uMist2.w + 120.0) return 0.0;
  float G = textureLod(uGround, uv + 0.5, 3.6).r;
  float valley = smoothstep(-12.0, 70.0, G - gf.x);
  H *= 0.5 + valley;
  vec2 q = p.xz * 0.0011 + uMist.zw + vec2(p.y * 0.0021, -p.y * 0.0013);
  float n = textureLod(uSkyNoise, q, 0.0).r * 0.62 + textureLod(uSkyNoise, q * 3.3 + 0.37, 0.0).g * 0.38;
  // fair weather: wisps that hug the floors lying below their surroundings
  float covF = mix(0.66, 0.34, uMist.x);
  float wisps = smoothstep(covF, covF + 0.22, n * (0.6 + 0.62 * valley)) * exp(-max(hag, 0.0) / H);
  // misty weather: a sea of mist that fills the valleys to its ceiling (billowing, thinner toward the top, denser
  // banks drifting through it); above it the air is clear and the peaks stand out
  float top = uMist2.w + (n - 0.5) * 170.0;
  float sea = (1.0 - smoothstep(-90.0, 20.0, hv - top)) * (0.45 + 0.55 * smoothstep(0.3, 0.62, n)) * (0.55 + 0.45 * exp(-max(hag, 0.0) / 120.0));
  float bank = mix(sea, wisps, uMist2.x);
  // fair weather: wisps in the valleys round about, the village and the air you stand in stay clear
  float clearK = mix(1.0, smoothstep(380.0, 950.0, length(p.xz - vec2(0.0, -6.0))) * smoothstep(50.0, 320.0, camD), uMist2.x);
  return bank * edge * clearK * (1.0 - smoothstep(4200.0, 6500.0, camD));
}
void main() {
  if (uMist.x < 0.01 || uGroundMap.w < 1.0) { oColor = vec4(0.0); return; }
  vec2 uv = vNdc * 0.5 + 0.5;
  vec4 w = uInvViewProj * vec4(vNdc, 1.0, 1.0);
  vec3 rd = normalize(w.xyz / w.w);
  float z = texture(uDepth, uv).x;
  float tMax = 6500.0;
  if (z < 0.99999) {
    float n = uNearFar.x, f = uNearFar.y;
    float vz = 2.0 * n * f / (f + n - (z * 2.0 - 1.0) * (f - n));
    tMax = min(tMax, vz / max(dot(rd, uCamFwd.xyz), 1e-3));
  }
  int N = int(uMist2.y);
  float jit = ign(gl_FragCoord.xy);
  vec3 sunL = uSunDir.xyz;
  float cs = dot(rd, sunL);
  // forward scattering: a broad lobe and a tight one round the sun
  float fwd = 0.5 * pow(max(cs, 0.0), 4.0) + 1.6 * pow(max(cs, 0.0), 24.0);
  vec3 sunC = uSunColor.rgb * (0.115 + 0.3 * fwd);
  vec3 amb = envIrradiance(vec3(0.0, 1.0, 0.0)) * RECIPROCAL_PI * 0.8 + hemiIrradiance(vec3(0.0, 1.0, 0.0)) * RECIPROCAL_PI;
  amb = max(amb, uFogColor.rgb * 0.5);   // (never darker than the air's own haze: no black mist at night)
  float T = 1.0;
  vec3 L = vec3(0.0);
  float tPrev = 0.0;
  for (int i = 0; i < N; i++) {
    float t1 = tMax * pow(float(i + 1) / float(N), 1.8);
    float tt = mix(tPrev, t1, jit), dt = t1 - tPrev;
    tPrev = t1;
    vec3 rel = rd * tt;
    float d = mistDensity(rel + uCamPos.xyz, tt) * uMist.x;
    if (d > 0.0015) {
      float vis = 1.0;
#if SL_FX >= 2
      vis = shadowAt(rel, vec3(0.0, 1.0, 0.0));
#endif
      // the layer shades itself: deep in a bank less sun arrives than on its top
      vec2 gf = textureLod(uGround, (rel.xz + uCamPos.xz - uGroundMap.xy) * uGroundMap.z + 0.5, 0.0).rg;
      float depthIn = mix(saturate((gf.y + uMist2.w - rel.y - uCamPos.y) / 160.0), 1.0 - saturate((rel.y + uCamPos.y - gf.x) / (uMist.y * 1.5)), uMist2.x);
      float self = mix(1.0, 0.5, depthIn);
      vec3 S = sunC * vis * self + amb * (0.55 + 0.45 * self);
      float a = exp(-d * uMist2.z * dt);
      L += T * S * (1.0 - a);
      T *= a;
      if (T < 0.015) break;
    }
  }
  oColor = vec4(L, 1.0 - T);
}
)GLSL";
// a depth-aware 5 x 5 tent blur of the half-resolution mist (the march's per-pixel jitter averaged out)
inline const char* kMistBlurFS = R"GLSL(
in vec2 vNdc;
out vec4 oColor;
uniform sampler2D uSrc;
uniform sampler2D uDepth;
uniform vec2 uNearFar;
float lin(float z) { float n = uNearFar.x, f = uNearFar.y; return 2.0 * n * f / (f + n - (z * 2.0 - 1.0) * (f - n)); }
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy), hs = textureSize(uSrc, 0);
  float z = lin(texture(uDepth, (vec2(c) + 0.5) / vec2(hs)).x);
  vec4 acc = vec4(0.0);
  float ws = 0.0;
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
    ivec2 q = clamp(c + ivec2(i, j), ivec2(0), hs - 1);
    float zc = lin(texture(uDepth, (vec2(q) + 0.5) / vec2(hs)).x);
    float wgt = (3.0 - abs(float(i))) * (3.0 - abs(float(j))) / (0.02 + abs(zc - z) / max(min(zc, z), 0.5));
    acc += texelFetch(uSrc, q, 0) * wgt;
    ws += wgt;
  }
  oColor = acc / ws;
}
)GLSL";
// the mist's upsample to the full resolution: the four half-resolution texels weighted by how close their depth is
// to this pixel's (no halo of mist round a skier or a tree in front of a far bank)
inline const char* kMistUpFS = R"GLSL(
in vec2 vNdc;
out vec4 oColor;
uniform sampler2D uSrc;
uniform sampler2D uDepth;
uniform vec2 uNearFar;
float lin(float z) { float n = uNearFar.x, f = uNearFar.y; return 2.0 * n * f / (f + n - (z * 2.0 - 1.0) * (f - n)); }
void main() {
  vec2 uv = vNdc * 0.5 + 0.5;
  float z = lin(texture(uDepth, uv).x);
  ivec2 hs = textureSize(uSrc, 0);
  vec2 hp = uv * vec2(hs) - 0.5;
  ivec2 b = ivec2(floor(hp));
  vec2 f = hp - vec2(b);
  vec4 acc = vec4(0.0);
  float ws = 0.0;
  for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++) {
    ivec2 c = clamp(b + ivec2(i, j), ivec2(0), hs - 1);
    float zc = lin(texture(uDepth, (vec2(c) + 0.5) / vec2(hs)).x);
    float wgt = (i == 0 ? 1.0 - f.x : f.x) * (j == 0 ? 1.0 - f.y : f.y) + 1e-3;
    wgt /= 0.02 + abs(zc - z) / max(min(zc, z), 0.5);
    acc += texelFetch(uSrc, c, 0) * wgt;
    ws += wgt;
  }
  vec4 m = acc / ws;
  if (m.a < 0.002) discard;
  // a little dither against banding in the smooth gradients
  m.rgb *= 1.0 + (ign(gl_FragCoord.xy) - 0.5) * 0.02;
  oColor = m;
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
  float H = aInst0.w, W = H * (aInst1.y > 0.5 ? 0.24 : 0.28);   // (as wide as the 3D firs they take over from)
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
  vec3 alb = mix(vec3(0.012, 0.024, 0.019), vec3(0.030, 0.055, 0.044), jag) * (0.8 + 0.4 * ty);
  // (as much snow on the tiers as the 3D firs carry at the hand-over distance: they read half white from afar)
  float snow = smoothstep(0.48, 0.88, ty) * smoothstep(0.34, 0.66, jag + uMisc.y * 0.3) * 0.85;
  alb = mix(alb, vec3(0.83, 0.85, 0.88), snow);
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
