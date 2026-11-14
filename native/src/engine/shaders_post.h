// The post chain (engine/post.js, ported, plus what it lacks): HDR bloom from a mip chain (13-tap downsample with
// a soft threshold and a firefly-safe first level, tent upsample), horizon-based ambient occlusion (post.js GTAO,
// the same slices / steps / falloff) and screen-space sun shafts at reduced resolution with a depth-aware blur and
// upsample, the final pass (PBR Neutral or ACES filmic, the broadcast grade, vignette, speed streaks, the landing
// flash / crash tint, dither) and FXAA 3.11 with a contrast-adaptive sharpen after it.
#pragma once

namespace sl::shaders {

// ---- bloom
inline const char* kBloomDownFS = R"GLSL(
in vec2 vNdc;
out vec4 oColor;
uniform sampler2D uSrc;
uniform vec2 uTexel;       // source texel
uniform float uFirst;      // 1: the first level (threshold, Karis average)
uniform float uThreshold;
vec3 safe(vec3 c) { return (any(isnan(c)) || any(isinf(c))) ? vec3(0.0) : min(c, vec3(64.0)); }
vec3 tap(vec2 uv) { return safe(texture(uSrc, uv).rgb); }
float karis(vec3 c) { return 1.0 / (1.0 + max(c.r, max(c.g, c.b))); }
void main() {
  vec2 uv = vNdc * 0.5 + 0.5, t = uTexel;
  vec3 a = tap(uv + t * vec2(-2, 2)), b = tap(uv + t * vec2(0, 2)), c = tap(uv + t * vec2(2, 2));
  vec3 d = tap(uv + t * vec2(-2, 0)), e = tap(uv), f = tap(uv + t * vec2(2, 0));
  vec3 g = tap(uv + t * vec2(-2, -2)), h = tap(uv + t * vec2(0, -2)), i = tap(uv + t * vec2(2, -2));
  vec3 j = tap(uv + t * vec2(-1, 1)), k = tap(uv + t * vec2(1, 1)), l = tap(uv + t * vec2(-1, -1)), m = tap(uv + t * vec2(1, -1));
  vec3 col;
  if (uFirst > 0.5) {
    vec3 g0 = (a + b + d + e) * 0.25, g1 = (b + c + e + f) * 0.25, g2 = (d + e + g + h) * 0.25, g3 = (e + f + h + i) * 0.25, g4 = (j + k + l + m) * 0.25;
    float w0 = karis(g0), w1 = karis(g1), w2 = karis(g2), w3 = karis(g3), w4 = karis(g4);
    col = (g0 * w0 * 0.125 + g1 * w1 * 0.125 + g2 * w2 * 0.125 + g3 * w3 * 0.125 + g4 * w4 * 0.5) /
          (w0 * 0.125 + w1 * 0.125 + w2 * 0.125 + w3 * 0.125 + w4 * 0.5);
    float br = max(col.r, max(col.g, col.b));
    float knee = uThreshold * 0.5;
    float soft = clamp(br - uThreshold + knee, 0.0, 2.0 * knee);
    soft = soft * soft / (4.0 * knee + 1e-4);
    col *= max(soft, br - uThreshold) / max(br, 1e-4);
  } else {
    col = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  }
  oColor = vec4(col, 1.0);
}
)GLSL";
inline const char* kBloomUpFS = R"GLSL(
in vec2 vNdc;
out vec4 oColor;
uniform sampler2D uSrc;    // the smaller level (added onto the bound one with additive blending)
uniform vec2 uTexel;
uniform float uRadius;
void main() {
  vec2 uv = vNdc * 0.5 + 0.5, t = uTexel * uRadius;
  vec3 s = texture(uSrc, uv).rgb * 4.0;
  s += (texture(uSrc, uv + vec2(-t.x, 0)).rgb + texture(uSrc, uv + vec2(t.x, 0)).rgb + texture(uSrc, uv + vec2(0, -t.y)).rgb + texture(uSrc, uv + vec2(0, t.y)).rgb) * 2.0;
  s += texture(uSrc, uv + vec2(-t.x, -t.y)).rgb + texture(uSrc, uv + vec2(t.x, -t.y)).rgb + texture(uSrc, uv + vec2(-t.x, t.y)).rgb + texture(uSrc, uv + vec2(t.x, t.y)).rgb;
  oColor = vec4(s / 16.0, 1.0);
}
)GLSL";

// ---- linear depth helpers (the resolved scene depth)
inline const char* kDepthCommon = R"GLSL(
uniform sampler2D uDepth;
uniform vec2 uNearFar;
uniform vec2 uInvProj;   // 1 / proj[0][0], 1 / proj[1][1]
float viewZ(vec2 uv) {
  float d = texture(uDepth, uv).x;
  float n = uNearFar.x, f = uNearFar.y;
  return 2.0 * n * f / (f + n - (d * 2.0 - 1.0) * (f - n));
}
vec3 viewPos(vec2 uv, float z) { return vec3((uv * 2.0 - 1.0) * uInvProj * z, -z); }
float bayer2(vec2 a) { a = floor(a); return fract(dot(a, vec2(0.5, a.y * 0.75))); }
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
)GLSL";

// post.js AO_FRAG (GTAO) + sun shafts -> (ao, shafts, viewZ)
inline const char* kAoFS = R"GLSL(
in vec2 vNdc;
out vec4 oColor;
uniform vec2 uFullTexel;
uniform float uRadius, uIntensity, uProjScale;
uniform vec2 uSunUV; uniform float uShafts;
uniform float uMaxPx, uDirs, uSteps;
float gtao(vec3 P, vec3 N, vec2 uv0, float z) {
  const float HALF_PI = 1.5707963;
  vec3 V = normalize(-P);
  float R = uRadius * (1.0 + z * 0.01);
  float ssR = min(R * uProjScale / z, uMaxPx);
  if (ssR < 1.5) return 1.0;
  float b = bayer4(gl_FragCoord.xy), jit = fract(b * 4.0) + 0.125;
  float fallFrom = R * 0.385, fallInv = 1.0 / (R * 0.615);
  float vis = 0.0;
  for (int d = 0; d < 4; d++) {
    if (float(d) >= uDirs) break;
    float phi = (float(d) + b) * 3.14159265 / uDirs;
    vec3 dir = vec3(cos(phi), sin(phi), 0.0);
    vec3 ortho = dir - dot(dir, V) * V;
    vec3 axis = normalize(cross(ortho, V));
    vec3 pN = N - axis * dot(N, axis);
    float pLen = length(pN);
    if (pLen < 1e-4) { vis += 1.0; continue; }
    float cosN = clamp(dot(pN, V) / pLen, -1.0, 1.0);
    float n = sign(dot(ortho, pN)) * acos(cosN);
    // (each side's horizon starts at its own end of the normal's hemisphere: post.js had the two swapped, which shaded
    // every flat surface seen at a grazing angle, the whole foreground of snow, as if half occluded)
    float low1 = cos(n + HALF_PI), low0 = cos(n - HALF_PI);
    float h0c = low0, h1c = low1;
    for (int s = 0; s < 12; s++) {
      if (float(s) >= uSteps) break;
      float t = (float(s) + jit) / uSteps;
      vec2 off = dir.xy * max(1.0, t * t * ssR) * uFullTexel;
      // (samples off the screen are pulled back onto its edge: a clamped depth read at an unclamped position put
      // phantom geometry above the ground and darkened the whole foreground)
      vec2 u1 = clamp(uv0 + off, uFullTexel * 0.5, 1.0 - uFullTexel * 0.5), u0 = clamp(uv0 - off, uFullTexel * 0.5, 1.0 - uFullTexel * 0.5);
      vec3 S1 = viewPos(u1, viewZ(u1)) - P;
      vec3 S0 = viewPos(u0, viewZ(u0)) - P;
      float l1 = length(S1), l0 = length(S0);
      float c1 = dot(S1, V) / max(l1, 1e-5) - 0.03, c0 = dot(S0, V) / max(l0, 1e-5) - 0.03;
      h1c = max(h1c, mix(low1, c1, clamp(1.0 - (l1 - fallFrom) * fallInv, 0.0, 1.0)));
      h0c = max(h0c, mix(low0, c0, clamp(1.0 - (l0 - fallFrom) * fallInv, 0.0, 1.0)));
    }
    float h0 = n + max(-acos(clamp(h0c, -1.0, 1.0)) - n, -HALF_PI);
    float h1 = n + min(acos(clamp(h1c, -1.0, 1.0)) - n, HALF_PI);
    float sn = sin(n);
    vis += pLen * 0.25 * ((cosN + 2.0 * h0 * sn - cos(2.0 * h0 - n)) + (cosN + 2.0 * h1 * sn - cos(2.0 * h1 - n)));
  }
  float ao = pow(clamp(vis / uDirs, 0.0, 1.0), uIntensity);
  return mix(ao, 1.0, smoothstep(90.0, 300.0, z));
}
void main() {
  vec2 vUv = vNdc * 0.5 + 0.5;
  vec2 uv0 = (floor(vUv / uFullTexel) + 0.5) * uFullTexel;
  float z = viewZ(uv0);
  if (z > 1500.0) oColor = vec4(1.0, 0.0, z, 1.0);
  else {
    vec3 P = viewPos(uv0, z);
    vec2 dx = vec2(uFullTexel.x, 0.0), dy = vec2(0.0, uFullTexel.y);
    vec3 Pr = viewPos(uv0 + dx, viewZ(uv0 + dx)), Pl = viewPos(uv0 - dx, viewZ(uv0 - dx));
    vec3 Pu = viewPos(uv0 + dy, viewZ(uv0 + dy)), Pd = viewPos(uv0 - dy, viewZ(uv0 - dy));
    vec3 ex = abs(Pr.z - P.z) < abs(P.z - Pl.z) ? Pr - P : P - Pl;
    vec3 ey = abs(Pu.z - P.z) < abs(P.z - Pd.z) ? Pu - P : P - Pd;
    vec3 cn = cross(ex, ey);
    vec3 N = dot(cn, cn) > 1e-14 ? normalize(cn) : vec3(0.0, 0.0, 1.0);
    oColor = vec4(uDirs > 0.0 ? gtao(P, N, uv0, z) : 1.0, 0.0, z, 1.0);
  }
  if (uShafts > 0.0) {
    vec2 d = uSunUV - vUv;
    float len = length(d * vec2(uFullTexel.y / uFullTexel.x, 1.0));
    vec2 st = d * min(1.0, 0.45 / max(len, 1e-4)) / 24.0;
    vec2 p = vUv + st * bayer4(gl_FragCoord.xy + 2.0);
    float s = 0.0, w = 1.0;
    for (int i = 0; i < 24; i++) {
      s += (texture(uDepth, p).x > 0.99999 ? 1.0 : 0.0) * w;
      w *= 0.955;
      p += st;
    }
    oColor.g = s / 14.0 * (1.0 - smoothstep(0.0, 0.75, len));
  }
}
)GLSL";
inline const char* kAoBlurFS = R"GLSL(
in vec2 vNdc;
out vec4 oColor;
uniform sampler2D uAO; uniform vec2 uTexel;
void main() {
  vec2 vUv = vNdc * 0.5 + 0.5;
  vec4 c = texture(uAO, vUv);
  float z = c.b, ao = 0.0, w = 0.0, sh = 0.0;
  for (int j = -2; j < 2; j++) for (int i = -2; i < 2; i++) {
    vec4 t = texture(uAO, vUv + (vec2(float(i), float(j)) + 0.5) * uTexel);
    float k = exp(-abs(t.b - z) / (z * 0.04 + 0.05));
    ao += t.r * k; w += k; sh += t.g;
  }
  oColor = vec4(ao / max(w, 1e-4), sh / 16.0, z, 1.0);
}
)GLSL";

// ---- the final pass (post.js FINAL_FRAG)
inline const char* kFinalFS = R"GLSL(
in vec2 vNdc;
out vec4 oColor;
uniform sampler2D uHdr;
uniform sampler2D uBloom;
uniform sampler2D uAO;
uniform float uExposure;
uniform int uToneMap;     // 0 ACES filmic, 1 PBR Neutral (+ the gentle filmic contrast of post.js)
uniform vec4 uPost;       // x bloom strength, y vignette, z speed streaks (0..1), w flash
uniform vec4 uPost2;      // x hit, y time, z AO strength (0: off), w shafts strength
uniform vec4 uPost3;      // x grade (1 / 2), y aspect, z dither, w 1: output luma in alpha (FXAA follows)
uniform vec3 uSunCol;
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
vec3 pbrNeutral(vec3 color) {
  float x = min(color.r, min(color.g, color.b));
  color -= x < 0.08 ? x - 6.25 * x * x : 0.04;
  float peak = max(color.r, max(color.g, color.b));
  if (peak < 0.76) return color;
  float d = 0.24, newPeak = 1.0 - d * d / (peak + d - 0.76);
  color *= newPeak / peak;
  return mix(color, vec3(newPeak), 1.0 - 1.0 / (0.15 * (peak - newPeak) + 1.0));
}
vec3 neutral(vec3 c) {
  c = max(c * (uExposure * 1.365), 0.0);
  c = 0.18 * pow(c / 0.18, vec3(1.08));
  return pbrNeutral(c);
}
vec3 toSRGB(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
float hash1(float n) { return fract(sin(n * 91.3458) * 47453.5453); }
void main() {
  vec2 uv = vNdc * 0.5 + 0.5;
  vec3 c = texture(uHdr, uv).rgb;
  if (any(isnan(c)) || any(isinf(c))) c = vec3(0.0);
  c = min(c, vec3(64.0));
  if (uPost.z > 0.001) {
    vec2 dir = uv - 0.5;
    float r = length(dir);
    float k = uPost.z * smoothstep(0.18, 0.7, r) * 0.035;
    vec3 acc = c;
    for (int i = 1; i <= 4; i++) { vec3 q = texture(uHdr, uv - dir * k * float(i)).rgb; if (!(any(isnan(q)) || any(isinf(q)))) acc += min(q, vec3(64.0)); }
    c = acc / 5.0;
  }
  if (uPost2.z > 0.0 || uPost2.w > 0.0) {
    vec4 a = texture(uAO, uv);
    c *= mix(1.0, a.r, uPost2.z);
    c += uSunCol * a.g * uPost2.w;
  }
  if (uPost.x > 0.0) c += texture(uBloom, uv).rgb * uPost.x;
  c = uToneMap == 1 ? neutral(c) : aces(c);
  c = toSRGB(clamp(c, 0.0, 1.0));
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  if (uPost3.x > 1.5) {
    c = mix(c, c * c * (3.0 - 2.0 * c), 0.22);
    float sat = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
    l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = mix(vec3(l), c, uToneMap == 1 ? 1.07 + 0.13 * (1.0 - sat) : 1.1 + 0.22 * (1.0 - sat));
    c += vec3(-0.008, -0.002, 0.012) * (1.0 - l) * (1.0 - l) + vec3(0.012, 0.006, -0.01) * l * l;
    c = clamp(c, 0.0, 1.0);
  } else c = mix(vec3(l), c, 1.06);
  vec2 d = (uv - 0.5) * vec2(uPost3.y, 1.0);
  float r = length(d);
  c *= 1.0 - (uPost.y + uPost.z * 0.05) * smoothstep(0.45, 0.9, r);
  if (uPost.z > 0.001) {
    float a = atan(d.y, d.x) / 6.2831853 + 0.5;
    float lanes = 150.0;
    float lane = floor(a * lanes);
    float h1 = hash1(lane), h2 = hash1(lane + 17.0), h3 = hash1(lane + 41.0);
    float across = abs(fract(a * lanes) - 0.5) * 2.0;
    float aa = min(fwidth(a * lanes), 0.25) * 2.0;
    float line = 1.0 - smoothstep(0.12 + h3 * 0.1 - aa, 0.12 + h3 * 0.1 + aa, across);
    float seg = fract(r * (1.6 + h2 * 1.4) - uPost2.y * (1.1 + h1 * 1.5) - h1 * 9.0);
    float dash = smoothstep(0.0, 0.06, seg) * (1.0 - smoothstep(0.18, 0.42, seg));
    float edge = smoothstep(0.28, 0.85, r);
    float on = step(0.62, h2);
    c += vec3(0.93, 0.96, 1.0) * line * dash * edge * on * uPost.z * 0.16;
  }
  c = mix(c, vec3(0.9, 0.92, 1.0), clamp(uPost.w, 0.0, 1.0) * 0.5);
  float vr = length(vNdc * vec2(0.9, 1.0));
  c = mix(c, vec3(0.55, 0.02, 0.02), clamp(uPost2.x, 0.0, 1.0) * smoothstep(0.5, 1.4, vr) * 0.7);
  if (uPost3.z > 0.0) {
    vec2 fc = gl_FragCoord.xy;
    float dn = fract(sin(dot(fc, vec2(12.9898, 78.233))) * 43758.5453) + fract(sin(dot(fc, vec2(39.3468, 11.135))) * 24634.6345) - 1.0;
    c = clamp(c + dn / 255.0, 0.0, 1.0);
  }
  oColor = vec4(c, uPost3.w > 0.5 ? dot(c, vec3(0.299, 0.587, 0.114)) : 1.0);
}
)GLSL";

// ---- FXAA 3.11 (quality preset 12) on the tone-mapped image (luma in alpha), then a contrast-adaptive sharpen
// (AMD CAS-style: strength limited by the local contrast, so edges never ring)
inline const char* kFxaaFS = R"GLSL(
in vec2 vNdc;
out vec4 oColor;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uSharpen;
uniform float uAA;
float lumaAt(vec2 uv) { return texture(uSrc, uv).a; }
vec3 fxaa(vec2 uv) {
  vec4 rgbyM = texture(uSrc, uv);
  float lumaM = rgbyM.a;
  float lumaS = textureOffset(uSrc, uv, ivec2(0, -1)).a, lumaE = textureOffset(uSrc, uv, ivec2(1, 0)).a;
  float lumaN = textureOffset(uSrc, uv, ivec2(0, 1)).a, lumaW = textureOffset(uSrc, uv, ivec2(-1, 0)).a;
  float maxSM = max(lumaS, lumaM), minSM = min(lumaS, lumaM);
  float maxESM = max(lumaE, maxSM), minESM = min(lumaE, minSM);
  float maxWN = max(lumaN, lumaW), minWN = min(lumaN, lumaW);
  float rangeMax = max(maxWN, maxESM), rangeMin = min(minWN, minESM);
  float range = rangeMax - rangeMin;
  if (range < max(0.0312, rangeMax * 0.125)) return rgbyM.rgb;
  float lumaNW = textureOffset(uSrc, uv, ivec2(-1, 1)).a, lumaSE = textureOffset(uSrc, uv, ivec2(1, -1)).a;
  float lumaNE = textureOffset(uSrc, uv, ivec2(1, 1)).a, lumaSW = textureOffset(uSrc, uv, ivec2(-1, -1)).a;
  float lumaNS = lumaN + lumaS, lumaWE = lumaW + lumaE;
  float subpixRcpRange = 1.0 / range;
  float subpixNSWE = lumaNS + lumaWE;
  float edgeHorz1 = (-2.0 * lumaM) + lumaNS, edgeVert1 = (-2.0 * lumaM) + lumaWE;
  float lumaNESE = lumaNE + lumaSE, lumaNWNE = lumaNW + lumaNE;
  float edgeHorz2 = (-2.0 * lumaE) + lumaNESE, edgeVert2 = (-2.0 * lumaN) + lumaNWNE;
  float lumaNWSW = lumaNW + lumaSW, lumaSWSE = lumaSW + lumaSE;
  float edgeHorz4 = (abs(edgeHorz1) * 2.0) + abs(edgeHorz2), edgeVert4 = (abs(edgeVert1) * 2.0) + abs(edgeVert2);
  float edgeHorz3 = (-2.0 * lumaW) + lumaNWSW, edgeVert3 = (-2.0 * lumaS) + lumaSWSE;
  float edgeHorz = abs(edgeHorz3) + edgeHorz4, edgeVert = abs(edgeVert3) + edgeVert4;
  float subpixNWSWNESE = lumaNWSW + lumaNESE;
  float lengthSign = uTexel.x;
  bool horzSpan = edgeHorz >= edgeVert;
  float subpixA = subpixNSWE * 2.0 + subpixNWSWNESE;
  if (!horzSpan) { lumaN = lumaW; lumaS = lumaE; } else lengthSign = uTexel.y;
  float subpixB = (subpixA * (1.0 / 12.0)) - lumaM;
  float gradientN = lumaN - lumaM, gradientS = lumaS - lumaM;
  float lumaNN = lumaN + lumaM, lumaSS = lumaS + lumaM;
  bool pairN = abs(gradientN) >= abs(gradientS);
  float gradient = max(abs(gradientN), abs(gradientS));
  if (pairN) lengthSign = -lengthSign;
  float subpixC = clamp(abs(subpixB) * subpixRcpRange, 0.0, 1.0);
  vec2 posB = uv;
  vec2 offNP = horzSpan ? vec2(uTexel.x, 0.0) : vec2(0.0, uTexel.y);
  if (!horzSpan) posB.x += lengthSign * 0.5; else posB.y += lengthSign * 0.5;
  vec2 posN = posB - offNP, posP = posB + offNP;
  float subpixD = ((-2.0) * subpixC) + 3.0;
  float lumaEndN = lumaAt(posN), lumaEndP = lumaAt(posP);
  float subpixE = subpixC * subpixC;
  if (!pairN) lumaNN = lumaSS;
  float gradientScaled = gradient * 0.25;
  float lumaMM = lumaM - lumaNN * 0.5;
  float subpixF = subpixD * subpixE;
  bool lumaMLTZero = lumaMM < 0.0;
  lumaEndN -= lumaNN * 0.5; lumaEndP -= lumaNN * 0.5;
  bool doneN = abs(lumaEndN) >= gradientScaled, doneP = abs(lumaEndP) >= gradientScaled;
  const float QS[8] = float[](1.5, 2.0, 2.0, 2.0, 2.0, 4.0, 8.0, 8.0);
  for (int i = 0; i < 8; i++) {
    if (doneN && doneP) break;
    if (!doneN) { posN -= offNP * QS[i]; lumaEndN = lumaAt(posN) - lumaNN * 0.5; doneN = abs(lumaEndN) >= gradientScaled; }
    if (!doneP) { posP += offNP * QS[i]; lumaEndP = lumaAt(posP) - lumaNN * 0.5; doneP = abs(lumaEndP) >= gradientScaled; }
  }
  float dstN = horzSpan ? uv.x - posN.x : uv.y - posN.y;
  float dstP = horzSpan ? posP.x - uv.x : posP.y - uv.y;
  bool goodSpanN = (lumaEndN < 0.0) != lumaMLTZero, goodSpanP = (lumaEndP < 0.0) != lumaMLTZero;
  float spanLength = dstP + dstN;
  bool directionN = dstN < dstP;
  float dst = min(dstN, dstP);
  bool goodSpan = directionN ? goodSpanN : goodSpanP;
  float subpixG = subpixF * subpixF;
  float pixelOffset = (dst * (-1.0 / spanLength)) + 0.5;
  float subpixH = subpixG * 0.75;
  float pixelOffsetGood = goodSpan ? pixelOffset : 0.0;
  float pixelOffsetSubpix = max(pixelOffsetGood, subpixH);
  vec2 p = uv;
  if (!horzSpan) p.x += pixelOffsetSubpix * lengthSign; else p.y += pixelOffsetSubpix * lengthSign;
  return texture(uSrc, p).rgb;
}
void main() {
  vec2 uv = vNdc * 0.5 + 0.5;
  vec3 c = uAA > 0.5 ? fxaa(uv) : texture(uSrc, uv).rgb;
  if (uSharpen > 0.0) {
    vec3 a = textureOffset(uSrc, uv, ivec2(0, 1)).rgb, b = textureOffset(uSrc, uv, ivec2(-1, 0)).rgb;
    vec3 d = textureOffset(uSrc, uv, ivec2(1, 0)).rgb, e = textureOffset(uSrc, uv, ivec2(0, -1)).rgb;
    vec3 mn = min(min(min(a, b), min(d, e)), c), mx = max(max(max(a, b), max(d, e)), c);
    vec3 amp = sqrt(clamp(min(mn, 1.0 - mx) / max(mx, 1e-4), 0.0, 1.0));
    vec3 w = -amp * mix(0.125, 0.2, uSharpen) * uSharpen;
    c = clamp((c + (a + b + d + e) * w) / (1.0 + 4.0 * w), 0.0, 1.0);
  }
  oColor = vec4(c, 1.0);
}
)GLSL";

inline const char* kCopyFS = R"GLSL(
in vec2 vNdc;
out vec4 oColor;
uniform sampler2D uSrc;
void main() { oColor = texture(uSrc, vNdc * 0.5 + 0.5); }
)GLSL";

} // namespace sl::shaders
