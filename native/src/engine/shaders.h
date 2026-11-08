// GLSL 410 sources of the renderer (OpenGL backend). An NVN / Vulkan backend compiles the same programs offline
// (glslc / the NVN shader compiler) from these sources with its own header.
#pragma once

namespace sl::shaders {

// Shared by every lit program: the frame uniform block, sun + sky lighting, shadows, height fog.
inline const char* kCommon = R"GLSL(
layout(std140) uniform Frame {
  mat4 uViewProj;       // camera-relative (the camera sits at the origin; world = rel + uCamPos)
  mat4 uShadowMat;      // camera-relative world -> shadow map uv / depth
  vec4 uCamPos;         // xyz world position of the camera, w time (s)
  vec4 uSunDir;         // xyz toward the sun, w shadow on (0/1)
  vec4 uSunColor;       // rgb * intensity
  vec4 uSkyColor;       // hemisphere sky
  vec4 uGroundColor;    // hemisphere ground (snow bounce)
  vec4 uFogColor;       // rgb, w unused
  vec4 uFogParams;      // x density at sea level, y height falloff (1/m), z shadow texel size, w exposure
  vec4 uSkyZenith, uSkyMid, uSkyHorizon, uSkyGlow;
};
)GLSL";

inline const char* kLighting = R"GLSL(
uniform sampler2DShadow uShadowMap;
const float PI = 3.14159265;

float shadowAt(vec3 rel, vec3 n) {
  if (uSunDir.w < 0.5) return 1.0;
  vec4 s = uShadowMat * vec4(rel + n * 0.08, 1.0);
  vec3 p = s.xyz / s.w;
  if (p.x <= 0.0 || p.x >= 1.0 || p.y <= 0.0 || p.y >= 1.0 || p.z >= 1.0) return 1.0;
  float t = uFogParams.z, sum = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) sum += texture(uShadowMap, vec3(p.xy + vec2(x, y) * t, p.z));
  float sh = sum / 9.0;
  // fade out toward the map's border
  vec2 e = min(p.xy, 1.0 - p.xy);
  return mix(1.0, sh, smoothstep(0.0, 0.06, min(e.x, e.y)));
}

// GGX specular + Lambert diffuse for the sun, a hemisphere for the sky (and a cheap sky reflection).
vec3 shade(vec3 albedo, float metallic, float rough, vec3 n, vec3 v, float shadow, float ao) {
  vec3 l = uSunDir.xyz;
  vec3 h = normalize(l + v);
  float nl = max(dot(n, l), 0.0), nv = max(dot(n, v), 1e-3), nh = max(dot(n, h), 0.0), vh = max(dot(v, h), 0.0);
  vec3 f0 = mix(vec3(0.04), albedo, metallic);
  float a = max(rough * rough, 0.002), a2 = a * a;
  float dd = nh * nh * (a2 - 1.0) + 1.0;
  float D = a2 / (PI * dd * dd);
  float k = (rough + 1.0) * (rough + 1.0) / 8.0;
  float G = (nl / (nl * (1.0 - k) + k)) * (nv / (nv * (1.0 - k) + k));
  vec3 F = f0 + (1.0 - f0) * pow(1.0 - vh, 5.0);
  vec3 spec = D * G * F / max(4.0 * nl * nv, 1e-3);
  vec3 diff = (1.0 - F) * (1.0 - metallic) * albedo / PI;
  vec3 direct = (diff + spec) * uSunColor.rgb * nl * shadow;
  vec3 hemi = mix(uGroundColor.rgb, uSkyColor.rgb, n.y * 0.5 + 0.5);
  vec3 amb = hemi * albedo * (1.0 - metallic) * ao;
  vec3 r = reflect(-v, n);
  vec3 env = mix(uGroundColor.rgb, uSkyColor.rgb, smoothstep(-0.2, 0.4, r.y));
  vec3 fenv = f0 + (max(vec3(1.0 - rough), f0) - f0) * pow(1.0 - nv, 5.0);
  amb += env * fenv * (1.0 - rough * 0.7) * ao * 0.6;
  return direct + amb;
}

// fog.js: exponential height fog integrated along the view ray + valley haze + aerial perspective
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
#endif
#ifdef INSTANCED
layout(location = 5) in vec4 aInst0;   // xyz world position, w uniform scale
layout(location = 6) in vec4 aInst1;   // x yaw, yzw unused
#endif
uniform mat4 uModel;                   // camera-relative (or the per-model fit transform when instanced)
out vec3 vRel;
out vec3 vNormal;
out vec2 vUV;
void main() {
  vec4 p = vec4(aPos, 1.0);
  vec3 n = aNormal;
#ifdef SKINNED
  mat4 sk = aWeights.x * uJoints[int(aJoints.x)] + aWeights.y * uJoints[int(aJoints.y)]
          + aWeights.z * uJoints[int(aJoints.z)] + aWeights.w * uJoints[int(aJoints.w)];
  p = sk * p;
  n = mat3(sk) * n;
#endif
  p = uModel * p;
  n = mat3(uModel) * n;
#ifdef INSTANCED
  float c = cos(aInst1.x), s = sin(aInst1.x);
  p.xyz = vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z) * aInst0.w + (aInst0.xyz - uCamPos.xyz);
  n = vec3(c * n.x + s * n.z, n.y, -s * n.x + c * n.z);
#endif
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
out vec4 oColor;
uniform sampler2D uBase;
uniform sampler2D uMR;
uniform sampler2D uNormalMap;
uniform vec4 uBaseColor;
uniform vec4 uMat;        // metallic, roughness, normal scale, alpha cutoff (<0: opaque)
uniform vec4 uFlags;      // has base tex, has mr tex, has normal tex, double sided
uniform vec3 uEmissive;
void main() {
  vec4 base = uBaseColor;
  if (uFlags.x > 0.5) base *= texture(uBase, vUV);
  if (uMat.w >= 0.0 && base.a < uMat.w) discard;
  float metallic = uMat.x, rough = uMat.y;
  if (uFlags.y > 0.5) { vec4 mr = texture(uMR, vUV); rough *= mr.g; metallic *= mr.b; }
  vec3 n = normalize(vNormal);
  vec3 v = normalize(-vRel);
  if (uFlags.w > 0.5 && dot(n, v) < 0.0) n = -n;
  if (uFlags.z > 0.5) {
    vec3 tn = texture(uNormalMap, vUV).xyz * 2.0 - 1.0;
    tn.xy *= uMat.z;
    n = perturbNormal(n, vRel, vUV, normalize(tn));
  }
  float sh = shadowAt(vRel, normalize(vNormal));
  vec3 col = shade(base.rgb, metallic, clamp(rough, 0.04, 1.0), n, v, sh, 1.0) + uEmissive;
  oColor = vec4(applyFog(col, vRel), 1.0);
}
)GLSL";

// ---------------------------------------------------------------- terrain
inline const char* kTerrainVS = R"GLSL(
layout(location = 0) in vec3 aPos;      // local to the node
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec4 aData;     // forest, groomed, piste dir xz (length 4 + lateral / 50)
uniform vec3 uOrigin;                   // node origin relative to the camera
out vec3 vRel;
out vec3 vNormal;
out vec4 vData;
void main() {
  vec3 rel = aPos + uOrigin;
  vRel = rel;
  vNormal = aNormal;
  vData = aData;
  gl_Position = uViewProj * vec4(rel, 1.0);
}
)GLSL";

inline const char* kTerrainFS = R"GLSL(
in vec3 vRel;
in vec3 vNormal;
in vec4 vData;
out vec4 oColor;
uniform sampler2D uNoise;   // R fbm, GB its gradient, A a second fbm (terrain.js makeNoiseTexture), 8 units / tile
vec4 nTex(vec2 p) { return texture(uNoise, p * 0.125); }
void main() {
  vec3 wp = vRel + uCamPos.xyz;
  vec3 n = normalize(vNormal);
  float dist = length(vRel);
  float groomed = vData.y;
  // snow surface: soft wind-packed variation and drifts (two noise scales), faded with distance
  vec4 a = nTex(wp.xz * 0.06);
  vec4 b = nTex(wp.xz * 0.45 + 3.7);
  float near = 1.0 - smoothstep(60.0, 400.0, dist);
  vec2 g = (a.gb - 0.5) * 0.35 + (b.gb - 0.5) * 0.18 * near;
  g *= 1.0 - groomed * 0.7;
  // groomer corduroy along the run
  if (groomed > 0.01 && dist < 120.0) {
    vec2 dir = vData.zw;
    float m = length(dir);
    if (m > 0.1) {
      dir /= m;
      float lat = dot(wp.xz, vec2(-dir.y, dir.x));
      float cord = sin(lat * 6.2831 / 0.42);
      float fw = fwidth(lat) / 0.42;   // ridges per pixel: fade before they alias into moire
      g += vec2(-dir.y, dir.x) * cord * 0.035 * groomed * (1.0 - smoothstep(0.15, 0.45, fw)) * (1.0 - smoothstep(20.0, 80.0, dist));
    }
  }
  vec3 sn = normalize(n + vec3(g.x, 0.0, g.y) * (1.0 - smoothstep(0.6, 0.9, 1.0 - n.y)));
  // rock on steep faces (slate-blue, strata), snow settles on its relief
  float steep = 1.0 - n.y;
  float rockK = smoothstep(0.40, 0.58, steep + (a.r - 0.5) * 0.22 + (b.a - 0.5) * 0.08) * (1.0 - groomed);
  float strata = nTex(vec2(wp.x * 0.02, wp.y * 0.35) + wp.z * 0.013).r;
  vec3 rock = mix(vec3(0.050, 0.058, 0.075), vec3(0.11, 0.115, 0.13), strata) * (0.85 + 0.3 * b.r);
  vec3 snow = vec3(0.86, 0.89, 0.94) * (0.94 + 0.08 * a.a) + groomed * vec3(0.03);
  // distant forest the trees no longer cover
  float forest = vData.x * smoothstep(700.0, 1100.0, dist);
  vec3 alb = mix(snow, rock, rockK);
  alb = mix(alb, vec3(0.045, 0.06, 0.05), forest * 0.75);
  vec3 nn = normalize(mix(sn, n, rockK));
  float sh = shadowAt(vRel, n);
  vec3 v = normalize(-vRel);
  vec3 col = shade(alb, 0.0, mix(0.62, 0.85, rockK), nn, v, sh, 1.0);
  // sun glints on the snow
  float glint = pow(max(dot(reflect(-v, nn), uSunDir.xyz), 0.0), 400.0) * (1.0 - rockK) * near * step(0.92, b.a);
  col += uSunColor.rgb * glint * 0.4 * sh;
  oColor = vec4(applyFog(col, vRel), 1.0);
}
)GLSL";

// ---------------------------------------------------------------- shadow depth (terrain, meshes, instanced, skinned)
inline const char* kDepthFS = R"GLSL(
out vec4 oColor;
void main() { oColor = vec4(1.0); }
)GLSL";

// ---------------------------------------------------------------- sky (fullscreen triangle at the far plane)
inline const char* kSkyVS = R"GLSL(
out vec2 vNdc;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2) * 2.0 - 1.0;
  vNdc = p;
  gl_Position = vec4(p, 1.0, 1.0);
}
)GLSL";
inline const char* kSkyFS = R"GLSL(
in vec2 vNdc;
out vec4 oColor;
uniform mat4 uInvViewProj;
void main() {
  vec4 w = uInvViewProj * vec4(vNdc, 1.0, 1.0);
  vec3 d = normalize(w.xyz / w.w);
  float h = max(d.y, 0.0);
  // sky.js: col = mix(mix(zenith, mid, exp(-h * 2.5)), horizon, exp(-h * 16))
  vec3 col = mix(mix(uSkyZenith.rgb, uSkyMid.rgb, exp(-h * 2.5)), uSkyHorizon.rgb, exp(-h * 16.0));
  float sd = max(dot(d, uSunDir.xyz), 0.0);
  col = mix(col, uSkyGlow.rgb, exp(-h * 10.0) * pow(sd, 6.0) * 0.6);
  col += uSkyGlow.rgb * 0.12 * pow(sd, 32.0);                      // aureole
  col += uSunColor.rgb * 40.0 * smoothstep(0.99985, 0.99995, sd);  // HDR disc
  if (d.y < 0.0) col = mix(col, uFogColor.rgb, smoothstep(0.0, -0.08, d.y));
  oColor = vec4(col, 1.0);
}
)GLSL";

// ---------------------------------------------------------------- tone mapping (ACES filmic as three.js, or Khronos PBR Neutral)
inline const char* kPostVS = kSkyVS;
inline const char* kPostFS = R"GLSL(
in vec2 vNdc;
out vec4 oColor;
uniform sampler2D uHdr;
uniform float uExposure;
uniform int uToneMap;   // 0 ACES filmic, 1 Neutral
vec3 RRTAndODTFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 aces(vec3 c) {
  const mat3 IN = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
  const mat3 OUT = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
  c *= uExposure / 0.6;
  return clamp(OUT * RRTAndODTFit(IN * c), 0.0, 1.0);
}
vec3 neutral(vec3 c) {
  c *= uExposure;
  const float startC = 0.8 - 0.04, desat = 0.15;
  float x = min(c.r, min(c.g, c.b));
  float off = x < 0.08 ? x - 6.25 * x * x : 0.04;
  c -= off;
  float peak = max(c.r, max(c.g, c.b));
  if (peak < startC) return c;
  float d = 1.0 - startC;
  float np = 1.0 - d * d / (peak + d - startC);
  c *= np / peak;
  float g = 1.0 - 1.0 / (desat * (peak - np) + 1.0);
  return mix(c, vec3(np), g);
}
vec3 toSRGB(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
void main() {
  vec3 c = texture(uHdr, vNdc * 0.5 + 0.5).rgb;
  c = uToneMap == 1 ? neutral(c) : aces(c);
  oColor = vec4(toSRGB(clamp(c, 0.0, 1.0)), 1.0);
}
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

} // namespace sl::shaders
