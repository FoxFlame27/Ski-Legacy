// atmosphere.js's cloud scenery on the GPU: the noise and impostor-atlas bakes (once at load), the cumulus cards
// (camera-facing, six-way relit, soft where they meet the ground, in the scene's height fog) and the overcast deck
// (four noise planes). Line by line from atmosphere.js (BAKE_FS, NOISE_FS, makeImpostors, makeClouds); camera-relative.
#pragma once

namespace sl::shaders {

// NOISE_FS: a tileable 2-channel fbm (256 x 256) for the overcast deck
inline const char* kCloudNoiseFS = R"GLSL(
out vec4 oColor;
uniform vec2 uNoiseRes;
float h2(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vn(vec2 p, float per, float seed){
  vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  float a = h2(mod(i, per) + seed), b = h2(mod(i + vec2(1,0), per) + seed);
  float c = h2(mod(i + vec2(0,1), per) + seed), d = h2(mod(i + vec2(1,1), per) + seed);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 uv, float seed){
  float s = 0.0, a = 0.5, per = 8.0;
  for (int i = 0; i < 6; i++){ s += a * vn(uv * per, per, seed + float(i) * 17.0); per *= 2.0; a *= 0.5; }
  return s / 0.984;
}
void main(){
  vec2 uv = gl_FragCoord.xy / uNoiseRes;
  oColor = vec4(fbm(uv, 3.0), fbm(uv, 71.0), 0.0, 1.0);
}
)GLSL";

// BAKE_FS: one atlas cell. Volume x in [-1, 1], y in [0, 1] (flat base at 0), z in [-0.5, 0.5] (viewer at +z); a union
// of spheres grown like a cauliflower + billowy erosion. Every texel marches the view ray and, at each sample, the
// light rays toward +-X, +-Y, +-Z (six-way lighting). (The JS writes both targets at once; here uOut picks one:
// 0 = light from +X, -X, +Y, -Y; 1 = +Z, -Z, alpha, front depth.)
inline const char* kCloudBakeFS = R"GLSL(
out vec4 oColor;
uniform mat4 uSph[12];   // 48 spheres, four per matrix (xyz, r)
uniform int uCount; uniform int uKind; uniform float uFlat; uniform float uSeed; uniform int uOut;
uniform vec2 uOrigin; uniform vec2 uSize; uniform vec2 uMargin; uniform vec3 uBox; // x min, x max, y max
const float SIG = 34.0;
vec3 hash33(vec3 p3){
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx) * 2.0 - 1.0;
}
float gnoise(vec3 p){
  vec3 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(dot(hash33(i), f), dot(hash33(i + vec3(1,0,0)), f - vec3(1,0,0)), u.x),
                 mix(dot(hash33(i + vec3(0,1,0)), f - vec3(0,1,0)), dot(hash33(i + vec3(1,1,0)), f - vec3(1,1,0)), u.x), u.y),
             mix(mix(dot(hash33(i + vec3(0,0,1)), f - vec3(0,0,1)), dot(hash33(i + vec3(1,0,1)), f - vec3(1,0,1)), u.x),
                 mix(dot(hash33(i + vec3(0,1,1)), f - vec3(0,1,1)), dot(hash33(i + vec3(1,1,1)), f - vec3(1,1,1)), u.x), u.y), u.z);
}
float billow(vec3 p, int oct){
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++){ if (i >= oct) break; s += a * abs(gnoise(p)); a *= 0.5; p = p * 2.03 + vec3(3.1, 0.0, 1.7); }
  return s;
}
float density(vec3 p, int oct){
  float d;
  if (uKind == 2){ // wisp: one long soft ellipsoid shredded by streaky noise
    float env = 1.0 - length((p - vec3(0.0, 0.36, 0.0)) / vec3(0.86, 0.2, 0.36));
    if (env < -0.9) return 0.0;
    float n = billow(vec3(p.x * 1.3 + 7.0, p.y * 11.0, p.z * 3.5) + uSeed, oct);
    d = (env * 0.9 + (n - 0.24) * 1.4) * 0.2;
  } else {
    float e = -1.0;
    for (int i = 0; i < 48; i++){
      if (i >= uCount) break;
      vec4 s = uSph[i / 4][i % 4];
      vec3 q = p - s.xyz; q.y /= uFlat;
      e = max(e, 1.0 - length(q) / s.w);
    }
    if (e < -0.6) return 0.0;
    d = e - 0.3 + billow(p * 5.5 + uSeed, oct) * 0.9;
  }
  d *= clamp(p.y / 0.07, 0.0, 1.0);
  d *= clamp(min(min(1.0 - (abs(p.x) - 0.9) / 0.08, 1.0 - (p.y - 0.9) / 0.08), 1.0 - (abs(p.z) - 0.42) / 0.07), 0.0, 1.0);
  return clamp(d / 0.12, 0.0, 1.0);
}
float lightT(vec3 p, vec3 dir){
  float od = 0.0, t = 0.0, st = 0.04;
  for (int m = 0; m < 5; m++){ t += st; od += density(p + dir * t, 1) * st; st *= 1.65; }
  return max(exp(-SIG * od), 0.16 * exp(-SIG * 0.15 * od)); // + cheap multiple scattering
}
void main(){
  vec2 q = ((gl_FragCoord.xy - uOrigin) / uSize - uMargin) / (1.0 - 2.0 * uMargin);
  oColor = vec4(0.0);
  float px = q.x * 2.0 - 1.0;
  if (q.x <= 0.0 || q.x >= 1.0 || q.y <= 0.0 || q.y >= 1.0 || px < uBox.x || px > uBox.y || q.y > uBox.z) return;
  const int STEPS = 36;
  const float DZ = 1.0 / float(STEPS);
  float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float T = 1.0, depth = 1.0;
  vec3 sp = vec3(0.0), sn = vec3(0.0), lp = vec3(1.0), ln = vec3(1.0);
  bool relight = true;
  for (int s = 0; s < STEPS; s++){
    float z = 0.5 - (float(s) + jit) * DZ;
    vec3 p = vec3(px, q.y, z);
    float d = density(p, 4);
    if (d <= 0.0) continue;
    float a = 1.0 - exp(-SIG * d * DZ);
    if (relight){
      lp = vec3(lightT(p, vec3(1,0,0)), lightT(p, vec3(0,1,0)), lightT(p, vec3(0,0,1)));
      ln = vec3(lightT(p, vec3(-1,0,0)), lightT(p, vec3(0,-1,0)), lightT(p, vec3(0,0,-1)));
    }
    relight = !relight;
    sp += T * a * lp; sn += T * a * ln;
    if (T > 0.5 && T * (1.0 - a) <= 0.5) depth = 0.5 - z;
    T *= 1.0 - a;
    if (T < 0.008) break;
  }
  float alpha = 1.0 - T;
  oColor = uOut == 0 ? sqrt(vec4(sp.x, sn.x, sp.y, sn.y)) : sqrt(vec4(sp.z, sn.z, alpha, depth * alpha));
}
)GLSL";

// the toroidal terrain map round the camera (128 x 300 m): the clouds fade out where they meet the ground
inline const char* kCloudTerrain = R"GLSL(
uniform sampler2D uCloudTerrain;
float terrainH(vec2 xz){ return texture(uCloudTerrain, (xz / 300.0 + 0.5) / 128.0).r; }
uniform vec3 uCSun, uCSky, uCGnd;   // the clouds' light: key light, sky ambient, ground bounce (updateCloudLight)
)GLSL";

// the cumulus cards: one instanced draw, far to near
inline const char* kCloudCardVS = R"GLSL(
layout(location = 0) in vec2 aQuad;   // x -0.5..0.5, y 0..1 (anchored at the cloud base)
layout(location = 1) in vec4 iA;      // base centre (camera-relative), mirror (+1 / -1)
layout(location = 2) in vec4 iB;      // width, height, atlas cell, opacity
layout(location = 3) in vec4 iC;      // terrain-contact softness (m), storm darkening, quad trim (top of the cloud), ring
uniform vec2 uMargin;
out vec2 vUv; out vec3 vL; out vec3 vRel; out float vOpacity; out vec2 vStorm;
void main(){
  vec3 toCam = -iA.xyz;
  vec2 h = normalize(toCam.xz + vec2(1e-3, 0.0));
  vec3 right = vec3(h.y, 0.0, -h.x), fwd = vec3(h.x, 0.0, h.y);
  vec3 wp = iA.xyz + right * (aQuad.x * iB.x) + vec3(0.0, aQuad.y * iB.y * iC.z, 0.0);
  vec2 uv = vec2(aQuad.x + 0.5, aQuad.y);
  vec2 cell = vec2(mod(iB.z, 2.0), floor(iB.z / 2.0));
  vec2 q = vec2(iA.w > 0.0 ? uv.x : 1.0 - uv.x, uv.y * iC.z);
  vUv = (cell + uMargin + q * (1.0 - 2.0 * uMargin)) * vec2(0.5, 0.25);
  // the key light in card space (x right, y up, z toward the camera); mirrored cards swap left / right
  vec3 sd = uSunDir.xyz;
  vL = vec3(dot(sd, right) * iA.w, sd.y, dot(sd, fwd));
  // a vertical card seen from far above / below degenerates: fade it out
  float elev = abs(toCam.y - iB.y * 0.4) / max(length(toCam), 1.0);
  vOpacity = iB.w * (1.0 - smoothstep(0.42, 0.7, elev));
  vStorm = iC.xy;
  vRel = wp;
  gl_Position = uViewProj * vec4(wp, 1.0);
}
)GLSL";

inline const char* kCloudCardFS = R"GLSL(
in vec2 vUv; in vec3 vL; in vec3 vRel; in float vOpacity; in vec2 vStorm;
out vec4 oColor;
uniform sampler2D uAtlasA, uAtlasB;
void main(){
  // the mip level clamped so tiny far cards never blend in a neighbouring atlas cell
  vec2 tx = vUv * 1024.0;
  float lod = min(0.5 * log2(max(dot(dFdx(tx), dFdx(tx)), dot(dFdy(tx), dFdy(tx)))), 3.5);
  vec4 A = textureLod(uAtlasA, vUv, lod), B = textureLod(uAtlasB, vUv, lod);
  A *= A; B *= B;                                   // stored as sqrt for 8-bit precision
  float alpha = B.b;
  if (alpha * vOpacity < 0.004) discard;
  // six-way relighting: the light-from-axis maps blended by the squared light direction
  vec3 w = vL * vL;
  float sun = w.x * (vL.x > 0.0 ? A.r : A.g) + w.y * (vL.y > 0.0 ? A.b : A.a) + w.z * (vL.z > 0.0 ? B.r : B.g);
  vec3 vd = normalize(vRel);
  float fwdScatter = max(dot(vd, uSunDir.xyz), 0.0);
  sun *= 1.0 + 2.6 * pow(fwdScatter, 8.0) + 0.5 * pow(fwdScatter, 2.0); // silver lining toward the sun
  float sky = 0.55 * A.b + 0.1125 * (A.r + A.g + B.r + B.g);          // sky-dome visibility
  vec3 col = uCSun * sun * (1.0 - vStorm.y * 0.75) + uCSky * sky * (1.0 - vStorm.y * 0.35) + uCGnd * A.a;
  // soft contact: thinner toward the ground, so cards never cut hard lines into slopes
  vec3 wp = vRel + uCamPos.xyz;
  float contact = smoothstep(0.0, vStorm.x, wp.y - terrainH(wp.xz));
  // nearly fogged out: fade away rather than leave a flat fog-coloured silhouette on the sky
  float fx = vRel.y * uFogParams.y, fk = abs(fx) > 1e-4 ? (1.0 - exp(-fx)) / fx : 1.0;
  float fade = 1.0 - smoothstep(0.62, 0.93, 1.0 - exp(-uFogParams.x * exp(-max(uCamPos.y, 0.0) * uFogParams.y) * length(vRel) * fk));
  float a = alpha * vOpacity * contact * fade;
  vec3 c = applyFog(col / max(alpha, 1e-3), vRel);
  oColor = vec4(c * a, a) * (1.0 + (ign(gl_FragCoord.xy) - 0.5) * 0.02);
}
)GLSL";

// the overcast deck: a 30 km plane over the camera per layer (camera-relative)
inline const char* kCloudDeckVS = R"GLSL(
layout(location = 0) in vec2 aQuad;   // x -0.5..0.5, y 0..1 (the cards' quad)
uniform float uDeckY;                 // the layer's height above the camera
out vec3 vRel;
void main(){
  vRel = vec3(aQuad.x * 30000.0, uDeckY, (aQuad.y - 0.5) * 30000.0);
  gl_Position = uViewProj * vec4(vRel, 1.0);
}
)GLSL";

inline const char* kCloudDeckFS = R"GLSL(
in vec3 vRel;
out vec4 oColor;
uniform sampler2D uCloudNoise;
uniform vec4 uDeck;   // x cover, y layer (0..3), z deckAbove, w -
uniform vec2 uDeckOff; // camera xz - the wind drift (the noise's frame)
void main(){
  vec3 wp = vRel + uCamPos.xyz;
  vec2 p = (vRel.xz + uDeckOff) * 0.000135;
  float n = texture(uCloudNoise, p).r * 0.72 + texture(uCloudNoise, p * 3.1 + 0.43).g * 0.28;
  float layer = uDeck.y, cover = uDeck.x;
  float thick = 1.0 - abs(layer - 1.5) / 2.2;
  // seen at a grazing angle the noise compresses into hard rims: the edge widens with the angle
  float graze = 1.0 - abs(normalize(vRel).y);
  float a = smoothstep(1.0 - cover, 1.0 - cover + 0.22 + 0.4 * graze * graze, n * (0.78 + 0.22 * thick));
  float d = length(vRel.xz);
  a *= 1.0 - smoothstep(9000.0, 14000.0, d);
  a *= smoothstep(4.0, 60.0, abs(vRel.y));                // no pop flying through a layer
  a *= smoothstep(0.0, 90.0, wp.y - terrainH(wp.xz));     // hugging the slopes softly
  a *= 0.46 * uDeck.z;
  if (a < 0.004) discard;
  float top = layer / 3.0;
  // lit tops, blue-grey bellies (darker where the layer is thick)
  vec3 col = uCSky * (0.42 + 0.3 * top) + uCGnd * (1.0 - top) * 0.6
           + uCSun * (0.18 + 0.62 * top) * smoothstep(-0.05, 0.4, uSunDir.y) * (1.0 - 0.5 * smoothstep(0.5, 0.9, n) * (1.0 - top));
  col = applyFog(col, vRel);
  oColor = vec4(col * a, a);
}
)GLSL";

} // namespace sl::shaders
