// GLSL 410 sources of the renderer (OpenGL backend). An NVN / Vulkan backend compiles the same programs offline
// (glslc / the NVN shader compiler) from these sources with its own header.
//
// Split by topic: this file has the shared frame block, the lighting model (three.js MeshStandardMaterial's
// physically based BRDF, so the look matches the web game: sun + hemisphere + image-based sky light, cascaded
// shadows, local lights, height fog / aerial perspective) and the mesh programs; the terrain is in
// shaders_terrain.h, the sky / environment / clouds in shaders_sky.h, the post chain in shaders_post.h, the
// snow trails, particles, impostors and the procedural texture bakes in shaders_fx.h.
//
// Variants (defines): SL_LOW (the switch preset: one shadow cascade, single-tap PCF, no far normal maps, no glints),
// SL_FX 0..4 (the web game's quality.fx realism tier), SL_CASCADES 1..4, SKINNED / INSTANCED / INSTMAT.
#pragma once

namespace sl::shaders {

// Shared by every program: the frame uniform block (std140; must match Renderer's FrameBlock) and the lights.
inline const char* kCommon = R"GLSL(
layout(std140) uniform Frame {
  mat4 uViewProj;       // camera-relative (the camera sits at the origin; world = rel + uCamPos)
  mat4 uView;           // rotation only
  mat4 uProj;
  mat4 uShadowMat[4];   // camera-relative world -> cascade uv (atlas) / depth
  vec4 uCascadeEnd;     // view distance where each cascade ends
  vec4 uCascadeTexel;   // world size of a shadow texel per cascade
  vec4 uCascadeRect[4]; // atlas rect of each cascade (x, y, w, h in uv)
  vec4 uCamPos;         // xyz world position of the camera, w time (s)
  vec4 uCamFwd;         // xyz camera forward, w tan(fovY / 2)
  vec4 uSunDir;         // xyz toward the key light (sun or moon), w shadows on (0/1)
  vec4 uSunColor;       // rgb * intensity (after weather), w 1 = sun, 0 = moon
  vec4 uHemiSky;        // three HemisphereLight sky colour * intensity, w env (IBL) intensity
  vec4 uHemiGround;     // ... ground colour, w sun visibility (cloud / haze)
  vec4 uFogColor;       // rgb, w valley haze scale
  vec4 uFogParams;      // x density at sea level, y height falloff (1/m), z shadow atlas texel, w exposure
  vec4 uSkyZenith;      // w dusk
  vec4 uSkyMid;         // w horizon haze sharpness (16 clear .. 4.5 overcast)
  vec4 uSkyHorizon;     // w cirrus amount
  vec4 uSkyGlow;        // w overcast
  vec4 uSkyHalo;        // w twilight
  vec4 uSkyHaloBroad;   // w rayleigh strength
  vec4 uSkyDisc;        // HDR sun disc colour, w sun size
  vec4 uSkyBelt;        // Belt of Venus colour, w star visibility
  vec4 uMoonGlow;       // w moon disc visibility
  vec4 uSkyWisp;        // cirrus colour, w cloud layer cover (0..1)
  vec4 uMoonDir;        // xyz, w night factor (stars)
  vec4 uTrueSun;        // xyz the sun's direction (even at night), w day factor
  vec4 uSH[9];          // irradiance of the environment (L2 spherical harmonics, rgb)
  vec4 uMisc;           // x night (lamps / windows), y fresh snow cover, z quality fx tier, w icy pistes
  vec4 uMisc2;          // x sparkle, y wind phase, z snowfall, w trail map on
  vec4 uTrail;          // xy trail map origin (world xz, toroidal), z 1 / size (m), w texel (m)
  vec4 uRes;            // xy render size, zw 1 / size
  vec4 uEnvGround;      // env: ground colour (sunlit snow bounce), w mist
  vec4 uCloud;          // x layer bottom (world y), y top, z wind x, w wind z
};
#ifndef SL_MAX_LIGHTS
#define SL_MAX_LIGHTS 16
#endif
#ifndef SL_FX
#define SL_FX 2
#endif
#ifndef SL_CASCADES
#define SL_CASCADES 1
#endif
#ifndef SL_CROWN0
#define SL_CROWN0 85.0
#define SL_CROWN1 115.0
#endif
// point and spot lights (lamps, headlights): per light three vec4s: position (camera-relative) + range,
// colour x intensity + cos of the outer cone (< -1.5: a point light), direction + cos of the inner cone
layout(std140) uniform Lights {
  vec4 uLightCount;
  vec4 uLight[48];
};
const float PI = 3.14159265;
const float RECIPROCAL_PI = 0.31830989;
float saturate(float x) { return clamp(x, 0.0, 1.0); }
vec3 saturate(vec3 x) { return clamp(x, 0.0, 1.0); }
float pow2(float x) { return x * x; }
// integer hash, exact for any cell index (terrain.js tHash)
float tHash(ivec2 c) {
  uvec2 q = uvec2(c + ivec2(16777216)) * uvec2(1597334673u, 3812015801u);
  uint n = (q.x ^ q.y) * 1597334673u;
  return float(n >> 8u) * (1.0 / 16777216.0);
}
// interleaved gradient noise (per-pixel dither / rotation)
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
)GLSL";

inline const char* kLighting = R"GLSL(
uniform sampler2DShadow uShadowMap;   // the cascades in one atlas (hardware PCF)
uniform sampler2D uEnvMap;            // the sky's radiance, equirectangular, mip-mapped by roughness
uniform sampler2D uSkyNoise;          // sky.js makeSkyNoise (cloud coverage: the cloud shadows on the ground)

// ---- shadows: cascaded, texel-snapped, filtered (bilinear PCF over a disc that keeps its width in metres)
float shadowTap(vec3 p) { return texture(uShadowMap, p); }
float shadowCascade(int c, vec3 rel, vec3 n, float rot) {
  float tx = uCascadeTexel[c];
  vec3 off = n * tx * 1.6 + uSunDir.xyz * tx * 0.6;   // normal + light offset bias, scaled by the texel
  vec4 s = uShadowMat[c] * vec4(rel + off, 1.0);
  vec3 p = s.xyz / s.w;
  vec4 r = uCascadeRect[c];
  vec2 lo = r.xy + uFogParams.z * 2.0, hi = r.xy + r.zw - uFogParams.z * 2.0;
  if (p.z >= 1.0 || p.x < r.x || p.y < r.y || p.x > r.x + r.z || p.y > r.y + r.w) return 1.0;
#ifdef SL_LOW
  return shadowTap(vec3(clamp(p.xy, lo, hi), p.z));
#else
  // 12 taps on a rotated Poisson disc of ~1.5 texels (hardware 2x2 PCF each): soft, no blocks, no banding
  const vec2 D[12] = vec2[](vec2(-0.326, -0.406), vec2(-0.840, -0.074), vec2(-0.696, 0.457), vec2(-0.203, 0.621),
                            vec2(0.962, -0.195), vec2(0.473, -0.480), vec2(0.519, 0.767), vec2(0.185, -0.893),
                            vec2(0.507, 0.064), vec2(0.896, 0.412), vec2(-0.322, -0.933), vec2(-0.792, -0.598));
  float cs = cos(rot), sn = sin(rot);
  mat2 R = mat2(cs, sn, -sn, cs);
#if SL_FX >= 3
  float rad = uFogParams.z * 2.2;
  const int N = 12;
#else
  float rad = uFogParams.z * 1.7;
  const int N = 8;
#endif
  float sum = 0.0;
  for (int i = 0; i < N; i++) sum += shadowTap(vec3(clamp(p.xy + R * D[i] * rad, lo, hi), p.z));
  return sum / float(N);
#endif
}
// moving cloud shadows from the cloud layer (the same coverage the sky draws)
float cloudShadow(vec3 wp) {
  float cover = uSkyWisp.w;
  if (cover < 0.01) return 1.0;
  vec3 l = normalize(uTrueSun.xyz + vec3(0.0, 0.05, 0.0));
  float t = (uCloud.x + 300.0 - wp.y) / max(l.y, 0.05);
  vec2 q = (wp.xz + l.xz * t) + uCloud.zw * uCamPos.w;
  float d = texture(uSkyNoise, q * 0.00009).r * 0.65 + texture(uSkyNoise, q * 0.00031 + 0.3).g * 0.35;
  float c = smoothstep(1.0 - cover - 0.12, 1.0 - cover + 0.2, d);
  return 1.0 - c * 0.72 * uTrueSun.w;
}
float shadowAt(vec3 rel, vec3 n) {
  float cs = 1.0;
#if SL_FX >= 2 && !defined(SL_LOW)
  cs = cloudShadow(rel + uCamPos.xyz);
#endif
  if (uSunDir.w < 0.5) return cs;
  float z = dot(rel, uCamFwd.xyz);
  float rot = ign(gl_FragCoord.xy) * 6.2831853;
  // the cascade this pixel falls in (one filtered lookup; a second one only in the blend band into the next)
  int c = 0;
  for (int i = 0; i < SL_CASCADES - 1; i++) if (z >= uCascadeEnd[i]) c = i + 1;
  float e = uCascadeEnd[c];
  if (z >= e) return cs;
  // dithered hand-over into the next cascade over the last 12 % (one lookup per pixel: smaller shaders, no seams)
  float b = (z - e * 0.88) / (e * 0.12);
  if (b > fract(rot * 0.618 + 0.31)) { c++; if (c >= SL_CASCADES) return cs; }
  return shadowCascade(c, rel, n, rot) * cs;
}

// ---- environment (image-based sky light), as three's PMREM IBL: irradiance from spherical harmonics, radiance
// from the mip-mapped equirectangular sky
vec3 envIrradiance(vec3 n) {
  vec3 r = uSH[0].rgb * 0.886227
    + uSH[1].rgb * (1.023328 * n.y) + uSH[2].rgb * (1.023328 * n.z) + uSH[3].rgb * (1.023328 * n.x)
    + uSH[4].rgb * (0.858086 * n.x * n.y) + uSH[5].rgb * (0.858086 * n.y * n.z)
    + uSH[6].rgb * (0.247708 * (3.0 * n.z * n.z - 1.0)) + uSH[7].rgb * (0.858086 * n.x * n.z)
    + uSH[8].rgb * (0.429043 * (n.x * n.x - n.y * n.y));
  return max(r, vec3(0.0)) * uHemiSky.w;   // irradiance (W / m^2 style: x albedo / pi = outgoing)
}
vec2 equirect(vec3 d) { return vec2(atan(d.x, -d.z) * (0.5 * RECIPROCAL_PI) + 0.5, acos(clamp(d.y, -1.0, 1.0)) * RECIPROCAL_PI); }
vec3 envRadiance(vec3 r, float rough) {
  float lod = sqrt(rough) * 6.5;
  return textureLod(uEnvMap, equirect(r), lod).rgb * uHemiSky.w;
}
vec3 hemiIrradiance(vec3 n) { return mix(uHemiGround.rgb, uHemiSky.rgb, n.y * 0.5 + 0.5); }

// ---- three.js physical BRDF
float D_GGX(float alpha, float nh) { float a2 = alpha * alpha; float d = nh * nh * (a2 - 1.0) + 1.0; return RECIPROCAL_PI * a2 / (d * d); }
float V_SmithCorrelated(float alpha, float nl, float nv) {
  float a2 = alpha * alpha;
  float gv = nl * sqrt(a2 + (1.0 - a2) * nv * nv), gl = nv * sqrt(a2 + (1.0 - a2) * nl * nl);
  return 0.5 / max(gv + gl, 1e-6);
}
vec3 F_Schlick(vec3 f0, float vh) { float f = exp2((-5.55473 * vh - 6.98316) * vh); return f0 * (1.0 - f) + f; }
vec3 BRDF_GGX(vec3 l, vec3 v, vec3 n, vec3 f0, float rough) {
  float alpha = rough * rough;
  vec3 h = normalize(l + v);
  float nl = saturate(dot(n, l)), nv = saturate(dot(n, v)), nh = saturate(dot(n, h)), vh = saturate(dot(v, h));
  return F_Schlick(f0, vh) * (V_SmithCorrelated(alpha, nl, nv) * D_GGX(alpha, nh));
}
vec2 DFGApprox(float nv, float rough) {
  const vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022), c1 = vec4(1.0, 0.0425, 1.04, -0.04);
  vec4 r = rough * c0 + c1;
  float a004 = min(r.x * r.x, exp2(-9.28 * nv)) * r.x + r.y;
  return vec2(-1.04, 1.04) * a004 + r.zw;
}

struct Lit { vec3 dDiff, dSpec, iDiff, iSpec; vec3 sunE; float ndl; };
// The sun / moon (shadowed), the hemisphere light and the sky's IBL for a surface: the terms kept apart so the
// terrain can shape them as terrain.js does. sunE = the key light's colour after its shadow (three's directLight).
Lit lightSurface(vec3 albedo, float metal, float rough, vec3 n, vec3 v, float shadow, vec3 geoN) {
  Lit o;
  rough = clamp(rough, 0.03, 1.0);
  vec3 diffC = albedo * (1.0 - metal);
  vec3 f0 = mix(vec3(0.04), albedo, metal);
  vec3 l = uSunDir.xyz;
  o.ndl = saturate(dot(n, l));
  o.sunE = uSunColor.rgb * shadow;
  vec3 irr = o.sunE * o.ndl;
  o.dDiff = irr * diffC * RECIPROCAL_PI;
  o.dSpec = irr * BRDF_GGX(l, v, n, f0, rough);
  // indirect: hemisphere (three RE_IndirectDiffuse) + IBL with multiple scattering (RE_IndirectSpecular_Physical)
  float nv = saturate(dot(n, v));
  vec3 iblIrr = envIrradiance(n);
  vec3 rad = envRadiance(reflect(-v, n), rough);
  // horizon occlusion: a reflection under the geometric surface sees the ground, not the sky
  vec3 rv = reflect(-v, n);
  rad *= saturate(1.0 + 1.3 * dot(rv, geoN));
  vec2 fab = DFGApprox(nv, rough);
  vec3 FssEss = f0 * fab.x + fab.y;
  float Ess = fab.x + fab.y, Ems = 1.0 - Ess;
  vec3 Favg = f0 + (1.0 - f0) * 0.047619;
  vec3 Fms = FssEss * Favg / (1.0 - Ems * Favg);
  vec3 cosW = iblIrr * RECIPROCAL_PI;
  vec3 total = FssEss + Fms * Ems;
  o.iSpec = rad * FssEss + Fms * Ems * cosW;
  o.iDiff = diffC * (1.0 - max(total.r, max(total.g, total.b))) * cosW + hemiIrradiance(n) * diffC * RECIPROCAL_PI;
  return o;
}
vec3 sumLit(Lit o, float ao) { return o.dDiff + o.dSpec + (o.iDiff + o.iSpec) * ao; }

// lamps' and headlights' light pools: diffuse + a GGX highlight, smooth range falloff (inverse square, windowed)
vec3 localLights(vec3 albedo, vec3 n, vec3 rel, vec3 v, float rough, vec3 f0) {
  vec3 sum = vec3(0.0);
  int cnt = int(uLightCount.x);
  for (int i = 0; i < SL_MAX_LIGHTS; i++) {
    if (i >= cnt) break;
    vec4 a = uLight[i * 3], b = uLight[i * 3 + 1], c = uLight[i * 3 + 2];
    vec3 d = a.xyz - rel;
    float dist = length(d);
    if (dist > a.w) continue;
    vec3 l = d / max(dist, 1e-3);
    float win = clamp(1.0 - pow(dist / a.w, 4.0), 0.0, 1.0);
    float att = win * win / (dist * dist + 1.0);
    float spot = b.w < -1.5 ? 1.0 : smoothstep(b.w, c.w, dot(-l, c.xyz));
    float nl = max(dot(n, l), 0.0);
    vec3 e = b.rgb * (att * spot * nl);
#ifdef SL_LOW
    sum += e * albedo * RECIPROCAL_PI;
#else
    sum += e * (albedo * RECIPROCAL_PI + BRDF_GGX(l, v, n, f0, max(rough, 0.15)));
#endif
  }
  return sum;
}
vec3 localLights(vec3 albedo, vec3 n, vec3 rel) { return localLights(albedo, n, rel, normalize(-rel), 1.0, vec3(0.04)); }

// fog.js: exponential height fog integrated along the view ray + valley haze + aerial perspective; (High and up)
// sunlit haze: the air toward the sun glows (Mie forward scattering)
vec3 applyFog(vec3 col, vec3 rel) {
  float dist = length(rel);
  float camY = max(uCamPos.y, 0.0);
  float x = rel.y * uFogParams.y;
  float k = abs(x) > 1e-4 ? (1.0 - exp(-x)) / x : 1.0;
  float amount = uFogParams.x * exp(-camY * uFogParams.y) * dist * k;
  float xv = rel.y * (1.0 / 380.0);
  float kv = abs(xv) > 1e-4 ? (1.0 - exp(-xv)) / xv : 1.0;
  amount += uFogParams.x * 0.3 * dist * min(kv, 7.0);
  float f = clamp(1.0 - exp(-amount), 0.0, 1.0);
  float farK = smoothstep(6000.0, 14000.0, dist);
  if (farK > 0.0) {
    float hb = 1.0 - exp(-uFogParams.x * exp(-camY * uFogParams.y) * (7000.0 + dist * 1.05) * k * 0.4);
    f = mix(f, hb, farK);
  }
  vec3 fc = uFogColor.rgb;
  // (native) aerial perspective: the haze near by is a light blue-grey (the fog colour arrives at 40 % saturation),
  // over the far ranges (several km of air) it turns a deeper atmospheric blue, as in a clear-day alpine panorama
  fc = max(mix(vec3(dot(fc, vec3(0.2126, 0.7152, 0.0722))), fc, 1.0 + 0.55 * smoothstep(2500.0, 9000.0, dist)), 0.0);
#if SL_FX >= 2 && !defined(SL_LOW)
  vec3 vd = rel / max(dist, 1e-3);
  float mie = pow(saturate(dot(vd, uTrueSun.xyz)), 8.0);
  vec3 glow = mix(vec3(dot(uSkyGlow.rgb, vec3(0.2126, 0.7152, 0.0722))), uSkyGlow.rgb, 0.5);   // (as the haze: half saturation)
  fc += glow * (mie * 0.12 * uTrueSun.w * uHemiGround.w);
#endif
  vec3 hue = mix(vec3(1.0), fc / max(max(fc.r, max(fc.g, fc.b)), 1e-4), 0.6);
  return mix(col * mix(vec3(1.0), hue, f * 0.45), fc, f);
}

// normal from a tangent-space map without stored tangents (screen-space derivatives: Schueler 2006)
vec3 perturbNormal(vec3 n, vec3 p, vec2 uv, vec3 mapN) {
  vec3 dp1 = dFdx(p), dp2 = dFdy(p);
  vec2 du1 = dFdx(uv), du2 = dFdy(uv);
  vec3 dp2perp = cross(dp2, n), dp1perp = cross(n, dp1);
  vec3 T = dp2perp * du1.x + dp1perp * du2.x;
  vec3 B = dp2perp * du1.y + dp1perp * du2.y;
  float invmax = inversesqrt(max(dot(T, T), dot(B, B)) + 1e-20);
  return normalize(mat3(T * invmax, B * invmax, n) * mapN);
}
)GLSL";

// ---------------------------------------------------------------- PBR meshes (static / skinned / instanced)
inline const char* kMeshVS = R"GLSL(
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUV;
#ifdef SKINNED
layout(location = 3) in vec4 aJoints;
layout(location = 4) in vec4 aWeights;
uniform mat4 uJoints[64];
layout(location = 8) in float aFanMask;   // (fans.js crowd people) the jacket recolour mask
#endif
#ifdef INSTANCED
layout(location = 5) in vec4 aInst0;   // xyz world position, w uniform scale
layout(location = 6) in vec4 aInst1;   // x yaw, y roll (about the local z axis), zw unused
#endif
#ifdef INSTMAT
layout(location = 9) in vec4 aRow0;    // rows of a 3x4 world matrix (translation relative to uInstOrigin)
layout(location = 10) in vec4 aRow1;
layout(location = 11) in vec4 aRow2;
layout(location = 12) in vec4 aTint;   // per instance: paint colour / livery (a = 0: the model's own)
uniform vec3 uInstOrigin;              // the batch's origin relative to the camera
#endif
layout(location = 7) in vec3 aColor;
uniform mat4 uModel;                   // camera-relative (or the per-model fit transform when instanced)
uniform vec4 uFlags3;                  // x paint mode, y shading kind (1 pine), z model height (pine sway), w -
out vec3 vRel;
out vec3 vNormal;
out vec2 vUV;
out vec3 vColor;
out float vFanMask;
out vec4 vTint;
out vec3 vObj;                         // model-space position (detail layer, pine crown), w-less
out vec3 vObjN;
out float vScale;                      // world metres per model unit (detail layer)
out vec3 vOX, vOY, vOZ;                // model axes in world space (detail layer)
out float vRkHG;                       // (rocks, shading 4) height over the terrain plane under the instance
void main() {
  vec4 p = vec4(aPos, 1.0);
  vTint = vec4(0.0);
  vRkHG = 10.0;
  vec3 n = aNormal;
  vColor = aColor;
  vFanMask = 0.0;
  vObj = aPos;
  vObjN = aNormal;
#ifdef SKINNED
  mat4 sk = aWeights.x * uJoints[int(aJoints.x)] + aWeights.y * uJoints[int(aJoints.y)]
          + aWeights.z * uJoints[int(aJoints.z)] + aWeights.w * uJoints[int(aJoints.w)];
  p = sk * p;
  n = mat3(sk) * n;
  vFanMask = aFanMask;
#endif
  p = uModel * p;
  n = mat3(uModel) * n;
  vScale = length(uModel[0].xyz);
  mat3 OW = mat3(uModel);
#ifdef INSTANCED
  // vegetation.js pineMaterial: gentle wind sway (+ branch flutter on High and up), stronger toward the top
  if (uFlags3.y > 0.5 && uFlags3.y < 1.5) {
    float hy = max(p.y, 0.0) / max(uFlags3.z, 1.0);
    float sway = hy * hy * 0.012 * uFlags3.z;
    float ph = uMisc2.y;
    p.x += sin(ph * 1.3 + aInst0.x * 0.1 + aInst0.z * 0.07) * sway * aInst0.w;
    p.z += cos(ph * 1.1 + aInst0.z * 0.1) * sway * 0.6 * aInst0.w;
#if SL_FX >= 2
    float rr = length(aPos.xz) * hy;
    p.x += sin(ph * 3.7 + dot(aPos, vec3(11.0, 7.0, 5.0)) * 9.0 + aInst0.x) * rr * 0.02;
    p.z += cos(ph * 3.1 + dot(aPos, vec3(5.0, 9.0, 13.0)) * 9.0 + aInst0.z) * rr * 0.02;
#endif
    vObj = p.xyz / max(uFlags3.z, 1e-3);
  }
  if (aInst1.y != 0.0) {
    float cr = cos(aInst1.y), sr = sin(aInst1.y);
    p.xy = vec2(cr * p.x - sr * p.y, sr * p.x + cr * p.y);
    n.xy = vec2(cr * n.x - sr * n.y, sr * n.x + cr * n.y);
  }
  float c = cos(aInst1.x), s = sin(aInst1.x);
  p.xyz = vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z) * aInst0.w + (aInst0.xyz - uCamPos.xyz);
  n = vec3(c * n.x + s * n.z, n.y, -s * n.x + c * n.z);
  vScale *= aInst0.w;
  OW = mat3(vec3(c, 0.0, -s), vec3(0.0, 1.0, 0.0), vec3(s, 0.0, c)) * OW;
#endif
#ifdef INSTMAT
  mat3 R = mat3(aRow0.x, aRow1.x, aRow2.x, aRow0.y, aRow1.y, aRow2.y, aRow0.z, aRow1.z, aRow2.z);
  p.xyz = R * p.xyz + vec3(aRow0.w, aRow1.w, aRow2.w) + uInstOrigin;
  n = R * n;
  vTint = aTint;
  if (uFlags3.y > 3.5 && uFlags3.y < 4.5) {   // (rocks: aTint = the terrain plane's gradient x, z and height over the origin)
    vec3 rkT = vec3(aRow0.w, aRow1.w, aRow2.w) + uInstOrigin;
    vRkHG = p.y - (rkT.y + aTint.z + aTint.x * (p.x - rkT.x) + aTint.y * (p.z - rkT.z));
  }
  vScale *= length(vec3(aRow0.x, aRow1.x, aRow2.x));
  OW = R * OW;
#endif
  vOX = OW[0]; vOY = OW[1]; vOZ = OW[2];
  vRel = p.xyz;
  vNormal = n;
  vUV = aUV;
  gl_Position = uViewProj * vec4(p.xyz, 1.0);
}
)GLSL";

inline const char* kMeshFS = R"GLSL(
in vec3 vRel;
in vec3 vNormal;
in vec2 vUV;
in vec3 vColor;
in float vFanMask;
in vec4 vTint;
in vec3 vObj;
in vec3 vObjN;
in float vScale;
in vec3 vOX, vOY, vOZ;
in float vRkHG;
out vec4 oColor;
uniform sampler2D uBase;
uniform sampler2D uMR;
uniform sampler2D uNormalMap;
uniform sampler2D uEmissiveMap;
uniform sampler2D uNoise;      // terrain.js noise (pine snow dusting)
uniform sampler2D uDetail;     // meshylook.js detail layer: RG slope, B roughness variation
uniform vec4 uBaseColor;
uniform vec4 uMat;        // metallic, roughness, normal scale, alpha cutoff (<0: opaque)
uniform vec4 uFlags;      // has base tex, has mr tex, has normal tex, double sided
uniform vec4 uFlags2;     // vertex colour, has emissive map, night glow strength, vertex colour stored as sqrt
uniform vec3 uEmissive;   // already scaled for the time of day
uniform vec4 uFlags3;     // x paint mode (1 car paint, 2 livery), y shading (0 standard, 1 pine, 2 meshy detail, 3 glass, 4 rock), z model height, w lum norm (pine)
uniform vec4 uFlags4;     // x clearcoat, y detail strength, z detail fade distance, w sheen (fabric)
uniform vec4 uFanBase;   // (fans.js) the crowd people's jacket recolour key: I, Q, luma, cos threshold (z = 0: none)
uniform vec4 uFanCol;    // rgb the person's jacket colour (r < 0: the model's own), a the screen-door fade (1 solid)

// ---- boulders.js rockMaterial: the Meshy rocks' snow (the same value noise as the web game's ROCK_COMMON)
const vec3 ROCK_SNOW = vec3(0.86, 0.875, 0.895);   // (the terrain's snow albedo)
float rkHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float rkNoise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(rkHash(i), rkHash(i + vec3(1.0, 0.0, 0.0)), f.x), mix(rkHash(i + vec3(0.0, 1.0, 0.0)), rkHash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
             mix(mix(rkHash(i + vec3(0.0, 0.0, 1.0)), rkHash(i + vec3(1.0, 0.0, 1.0)), f.x), mix(rkHash(i + vec3(0.0, 1.0, 1.0)), rkHash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
}
float rkN(vec3 p) { return rkNoise(mat3(0.80, 0.36, -0.48, -0.60, 0.48, -0.64, 0.0, 0.80, 0.60) * p); }

// ---- vegetation.js pine shading
// (native) spruce / fir green-black needles (vegetation.js's logo navy read as blue trees once lit) and near-white snow
const vec3 PINE_SNOW = vec3(0.82, 0.845, 0.875);
vec3 pineNeedle(vec3 tex) {
  float k = clamp(dot(tex, vec3(0.2126, 0.7152, 0.0722)) * uFlags3.w, 0.15, 2.2);
  return mix(vec3(0.012, 0.024, 0.019), vec3(0.030, 0.055, 0.044), smoothstep(0.5, 1.8, k)) * (0.6 + 0.4 * k);
}
float pineTexSnow(vec3 tex) {
  float hi = max(max(tex.r, tex.g), tex.b);
  return smoothstep(0.6, 0.82, min(min(tex.r, tex.g), tex.b) / max(hi, 1e-4)) * smoothstep(0.12, 0.3, hi);
}
float pineSnowMask(vec3 tex, vec3 wn, vec3 op) {
  float n = texture(uNoise, op.xz * 2.6 + vec2(op.y * 1.9, -op.y * 1.4)).r;
  return max(pineTexSnow(tex), smoothstep(0.45, 0.85, wn.y) * smoothstep(0.5, 0.66, n) * 0.35);
}

void main() {
  if (uFanBase.w < -0.5) {   // fans.js blobMaterial: the soft contact shade under a crowd person (multiplied onto the snow)
    float r = min(1.0, length(vUV * 2.0 - 1.0));
    float a = pow(1.0 - r * r, 2.2) * (0.45 + 0.55 * (1.0 - smoothstep(0.0, 0.4, r)));   // dark core under the boots
    a *= uFanCol.x * (1.0 - smoothstep(45.0, 90.0, 1.0 / gl_FragCoord.w));
    oColor = vec4(mix(vec3(1.0), uFanBase.xyz, a), 1.0);
    return;
  }
  vec4 base = uBaseColor;
  if (vTint.a > 0.0 && uFlags3.x > 0.5 && uFlags3.x < 1.5) base.rgb = vTint.rgb;
  vec3 texel = vec3(1.0);
  if (uFlags.x > 0.5) { vec4 t = texture(uBase, vUV); texel = t.rgb; base *= t; }
  if (vTint.a > 0.0 && uFlags3.x > 1.5) {
    float red = smoothstep(0.04, 0.2, base.r - max(base.g, base.b) * 1.1);
    base.rgb = mix(base.rgb, vTint.rgb * (0.35 + 2.4 * dot(base.rgb, vec3(0.5, 0.35, 0.15))), red * vTint.a);
  }
  if (uFlags2.x > 0.5) base.rgb *= uFlags2.w > 0.5 ? vColor * vColor : vColor;
  if (uFanCol.a < 1.0) {   // fans.js: the screen-door cross-fade (LOD switches, people coming on / off stage)
    float dth = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    if (uFanCol.a < -1.5) { if (dth < -uFanCol.a - 2.0) discard; } else if (dth >= uFanCol.a) discard;
  }
  if (uFanCol.r >= 0.0 && uFanBase.z > 0.0) {
    // fans.js jacket recolour: texels near the jacket's own hue take the person's colour, folds / shading kept
    vec3 c = base.rgb;
    float Y = dot(c, vec3(0.299, 0.587, 0.114));
    vec2 iq = vec2(dot(c, vec3(0.596, -0.274, -0.322)), dot(c, vec3(0.211, -0.523, 0.312)));
    float bc = length(uFanBase.xy), ch = length(iq);
    float cs = dot(iq, uFanBase.xy) / max(ch * bc, 1e-6);
    float sat = (ch / max(Y, 0.004)) / (bc / uFanBase.z);
    float k = vFanMask * smoothstep(uFanBase.w - 0.2, uFanBase.w - 0.04, cs) * smoothstep(0.28, 0.5, sat) * smoothstep(0.004, 0.012, ch);
    base.rgb = mix(c, uFanCol.rgb * clamp(Y / uFanBase.z, 0.0, 2.2), k);
  }
  if (uMat.w >= 0.0) {
    // alpha test with a sharpened, mip-stable edge (alpha to coverage under MSAA smooths it)
    float a = (base.a - uMat.w) / max(fwidth(base.a), 1e-4) + 0.5;
#ifdef SL_A2C
    if (a < 0.02) discard;
    base.a = clamp(a, 0.0, 1.0);
#else
    if (a < 0.5) discard;
    base.a = 1.0;
#endif
  }
  float metallic = uMat.x, rough = uMat.y;
  if (uFlags.y > 0.5) { vec4 mr = texture(uMR, vUV); rough *= mr.g; metallic *= mr.b; }
  vec3 gn = normalize(vNormal);
  vec3 v = normalize(-vRel);
  float dist = length(vRel);
  if (uFlags.w > 0.5 && dot(gn, v) < 0.0) gn = -gn;
  vec3 n = gn;
  int kind = int(uFlags3.y + 0.5);
#ifdef SL_LOW
  if (uFlags.z > 0.5 && dist < 30.0) {   // (simplified shaders: no normal maps past 30 m)
#else
  if (uFlags.z > 0.5) {
#endif
    vec3 tn = texture(uNormalMap, vUV).xyz * 2.0 - 1.0;
    tn.xy *= uMat.z;
    n = perturbNormal(n, vRel, vUV, normalize(tn));
  }
  float snowA = 0.0;
  if (kind == 1) {
    // pine: dark green needles, snow on needles facing the sky
    vec3 pineTex = base.rgb;
    base.rgb = pineNeedle(pineTex);
    snowA = clamp(pineSnowMask(pineTex, n, vObj) * (1.0 + uMisc.y) * (1.0 - 0.75 * smoothstep(40.0, 450.0, dist)), 0.0, 1.0);
    base.rgb = mix(base.rgb, PINE_SNOW, snowA);
    rough = mix(max(rough, 0.82), 0.7, snowA);
    metallic = 0.0;
  }
  if (kind == 4) {
    // rocks: a settled cap on the faces open to the sky (its edge broken by the relief and noise), a dusting on the
    // ledges, a drift banked against the foot, damp darker rock just above it; more while it snows (uMisc.y)
    vec3 wp = vRel + uCamPos.xyz;
    float sn = rkN(wp * 0.9 + 9.0) * 0.6 + rkN(wp * 3.1) * 0.4;
    float cap = smoothstep(0.68 - uMisc.y * 0.2, 0.86 - uMisc.y * 0.2, gn.y + (sn - 0.5) * 0.35 + (n.y - gn.y) * 0.6);
    float dust = smoothstep(0.86 - uMisc.y * 0.3, 0.95 - uMisc.y * 0.3, n.y + (sn - 0.5) * 0.2) * 0.85;
    float driftH = 0.05 + 0.25 * rkN(vec3(wp.x, 0.0, wp.z) * 0.9 + 3.0) * rkN(vec3(wp.x, 0.0, wp.z) * 0.35 + 8.0) * 2.0;
    float drift = 1.0 - smoothstep(driftH - 0.03, driftH + 0.03, vRkHG + (sn - 0.5) * 0.12);
    snowA = clamp(max(max(cap, dust), drift), 0.0, 1.0);
    base.rgb *= mix(0.7, 1.0, smoothstep(0.0, 0.4, vRkHG));
    base.rgb = mix(base.rgb, ROCK_SNOW, snowA);
    rough = mix(rough, 0.75, snowA);
    metallic = 0.0;
    n = normalize(mix(mix(n, gn, snowA * 0.8), vec3(0.0, 1.0, 0.0), drift * 0.5));
  }
#ifndef SL_LOW
  if (kind == 2 && uFlags4.y > 0.0) {
    // meshylook.js detail layer: triplanar grain at half a metre per repeat in the model's own space
    float dF = uFlags4.y * (1.0 - smoothstep(uFlags4.z * 0.3, uFlags4.z, dist));
    if (dF > 0.001) {
      vec3 P = vObj * (vScale / 0.5);
      vec3 dW = abs(normalize(vObjN)); dW *= dW; dW *= dW; dW /= dot(dW, vec3(1.0));
      vec4 dA = texture(uDetail, P.yz), dB = texture(uDetail, P.zx), dC = texture(uDetail, P.xy);
      vec2 gA = dA.rg * 2.0 - 1.0, gB = dB.rg * 2.0 - 1.0, gC = dC.rg * 2.0 - 1.0;
      vec3 dO = dW.x * vec3(0.0, gA.x, gA.y) + dW.y * vec3(gB.y, 0.0, gB.x) + dW.z * vec3(gC.x, gC.y, 0.0);
      vec3 dV = normalize(vOX) * dO.x + normalize(vOY) * dO.y + normalize(vOZ) * dO.z;
      dV -= n * dot(dV, n);
      n = normalize(n + dV * dF);
      rough += (dW.x * dA.b + dW.y * dB.b + dW.z * dC.b - 0.5) * dF * 0.25;
    }
    metallic = smoothstep(0.2, 0.8, metallic);
    rough *= 0.92;
  }
#endif
  float sh = shadowAt(vRel, gn);
  vec3 em = uEmissive;
  if (uFlags2.y > 0.5) em *= texture(uEmissiveMap, vUV).rgb;
  // village.js addNightGlow: lit windows / lanterns (warm bright texels) glow at night
  if (uFlags2.z > 0.0) {
    float warm = smoothstep(0.35, 0.8, texel.r - texel.b * 0.8) * smoothstep(0.25, 0.6, texel.r);
    em += vec3(1.0, 0.62, 0.28) * warm * uMisc.x * uFlags2.z;
  }
  rough = clamp(rough, 0.04, 1.0);
  Lit L = lightSurface(base.rgb, metallic, rough, n, v, sh, gn);
  if (kind == 1) {
    // crown self-shadow, the sky hardly reaching into the crown, translucent needles against the sun
    float hy = clamp(vObj.y, 0.0, 1.0);
    // the crown's averaged self-shadow takes over where the trees stop casting into the shadow map
    float crown = mix(1.0, 0.42, smoothstep(SL_CROWN0, SL_CROWN1, dist));
    L.dDiff *= crown; L.dSpec *= crown;
    L.iDiff *= mix(0.62, 1.0, hy);
#if SL_FX >= 2
    float pNear = 1.0 - smoothstep(60.0, 110.0, dist);
    float cr = 0.3 * (1.0 - hy) + 0.03;
    float inner = smoothstep(0.15, 0.9, length(vObj.xz) / cr);
    L.iDiff *= mix(1.0, 0.55 + 0.45 * inner, pNear);
    float pBack = saturate(dot(-v, uSunDir.xyz));
    float pAlb = max(base.r, max(base.g, base.b));
    float pTr = pow(pBack, 5.0) * (0.3 + 0.7 * inner) * pNear * (1.0 - smoothstep(0.12, 0.4, pAlb));
#if SL_FX >= 3
    pTr *= 1.25;
#endif
    L.dDiff += L.sunE * base.rgb * vec3(0.9, 1.25, 0.65) * pTr * 0.45;
#endif
  }
  vec3 col = sumLit(L, 1.0);
#ifndef SL_LOW
  if (uFlags4.x > 0.0) {
    // car paint: a clear coat over the base (three's clearcoat: its own GGX lobe and sky reflection, Fresnel
    // taken off the layer below), metallic flake sparkle
    float nv = saturate(dot(gn, v));
    float Fc = 0.04 + 0.96 * pow(1.0 - nv, 5.0);
    vec3 ccSpec = uSunColor.rgb * sh * saturate(dot(gn, uSunDir.xyz)) * BRDF_GGX(uSunDir.xyz, v, gn, vec3(0.04), 0.06);
    vec3 ccEnv = envRadiance(reflect(-v, gn), 0.04) * saturate(1.0 + 1.5 * dot(reflect(-v, gn), gn));
    col = col * (1.0 - Fc * uFlags4.x) + (ccSpec + ccEnv * Fc) * uFlags4.x;
    float fl = tHash(ivec2(floor(vObj.xz * 900.0))) ;
    col += L.sunE * pow(saturate(dot(reflect(-uSunDir.xyz, n), v)), 60.0) * step(0.93, fl) * 0.6 * metallic * (1.0 - smoothstep(4.0, 15.0, dist));
  }
#endif
  if (kind == 3) {
    // glass: the sky's reflection with Fresnel, the panes' own tint kept
    float nv = saturate(dot(n, v));
    float F = 0.04 + 0.96 * pow(1.0 - nv, 5.0);
    vec3 r = reflect(-v, n);
    col += envRadiance(r, 0.03) * F * saturate(1.0 + 1.5 * dot(r, gn)) * 1.2;
    base.a = mix(base.a, 1.0, F);
  }
  col += em + localLights(base.rgb * (1.0 - metallic), n, vRel, v, rough, mix(vec3(0.04), base.rgb, metallic));
  oColor = vec4(applyFog(col, vRel), base.a);
}
)GLSL";

// ---------------------------------------------------------------- shadow depth (terrain, meshes, instanced, skinned)
inline const char* kDepthFS = R"GLSL(
in vec2 vUV;
uniform sampler2D uBase;
uniform vec4 uMat;
uniform vec4 uFlags;
uniform vec4 uBaseColor;
out vec4 oColor;
void main() {
  // alpha-tested foliage casts its real shape (pines, fences)
  if (uMat.w >= 0.0 && uFlags.x > 0.5 && texture(uBase, vUV).a * uBaseColor.a < uMat.w) discard;
  oColor = vec4(1.0);
}
)GLSL";
inline const char* kDepthTerrainFS = R"GLSL(
out vec4 oColor;
void main() { oColor = vec4(1.0); }
)GLSL";

// ---------------------------------------------------------------- HUD text / quads (pixel coordinates)
inline const char* kHudVS = R"GLSL(
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec4 aColor;
uniform vec2 uScreen;
out vec4 vColor;
void main() {
  vColor = aColor;
  gl_Position = vec4(aPos / uScreen * vec2(2.0, -2.0) + vec2(-1.0, 1.0), 0.0, 1.0);
}
)GLSL";
inline const char* kHudFS = R"GLSL(
in vec4 vColor;
out vec4 oColor;
void main() { oColor = vColor; }
)GLSL";

// full-screen triangle (post passes, sky)
inline const char* kFullscreenVS = R"GLSL(
out vec2 vNdc;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2) * 2.0 - 1.0;
  vNdc = p;
  gl_Position = vec4(p, 1.0, 1.0);
}
)GLSL";

} // namespace sl::shaders

#include "engine/shaders_terrain.h"
#include "engine/shaders_sky.h"
#include "engine/shaders_post.h"
#include "engine/shaders_fx.h"
