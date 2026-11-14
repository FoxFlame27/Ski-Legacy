// The terrain: a line-by-line port of terrain.js createTerrainMaterial (its onBeforeCompile chunks: wind-sculpted
// snow relief picked by the pixel footprint, sastrugi, grain at several scales, groomer corduroy and lanes, scraped
// ice, km-scale variation, triplanar rock with strata / cracks / buttresses and snow held on its relief, couloirs,
// cliff-band ledges, far forests, the sky-blue shade, subsurface terminator, forward-scattering sheen and the ice
// glints, all gated by the same TERRAIN_DETAIL / TERRAIN_FX tiers), plus what the native renderer adds on top:
//  - high-resolution tiling snow and rock maps baked at start-up (2048 px, mip-mapped, maximum anisotropy): crisp
//    snow crystals and grain right under the skis, a rock surface with real height
//  - height-blended snow / rock edges (snow fills the rock's hollows first) and triplanar rock maps on cliffs
//  - the snow trail map (world/snowtrails): ski grooves, boot prints, snowmobile and tyre tracks pressed into the
//    snow (normals, parallax, compressed blue-grey snow in the grooves, their own shadow in low sun)
#pragma once

namespace sl::shaders {

inline const char* kTerrainVS = R"GLSL(
layout(location = 0) in vec3 aPos;      // local to the node
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec4 aData;     // forest, groomed, piste dir xz (length 4 + lateral / 50)
layout(location = 3) in float aMacro;   // large-scale slope without the cliff bands (terrain.js aMacro)
uniform vec3 uOrigin;                   // node origin relative to the camera
out vec3 vRel;
out vec3 vNormal;
out vec4 vData;
out float vMacro;
void main() {
  vec3 rel = aPos + uOrigin;
  vRel = rel;
  vNormal = aNormal;
  vData = aData;
  vMacro = aMacro;
  gl_Position = uViewProj * vec4(rel, 1.0);
}
)GLSL";

inline const char* kTerrainFS = R"GLSL(
in vec3 vRel;
in vec3 vNormal;
in vec4 vData;
in float vMacro;
out vec4 oColor;
uniform sampler2D uNoise;     // R fbm, GB its gradient, A a second fbm (terrain.js makeNoiseTexture), 8 units / tile
uniform sampler2D uSnowTex;   // baked snow detail: RG normal slope, B height, A crystal / grain mask (1.6 m tile)
uniform sampler2D uRockTex;   // baked rock: RG normal slope, B height, A albedo variation (4 m tile)
uniform sampler2D uTrailMap;  // world/snowtrails: R groove depth, G berm, B packed snow, A freshness
#ifndef TERRAIN_DETAIL
#define TERRAIN_DETAIL 1
#endif
#define TERRAIN_FX SL_FX
vec3 vWPos;
vec4 nTex(vec2 p) { return texture(uNoise, p * 0.125); }
vec4 nTexL(vec2 p, float lod) { return textureLod(uNoise, p * 0.125, lod); }
vec4 nTexG(vec2 p, vec2 gx, vec2 gy) { return textureGrad(uNoise, p * 0.125, gx * 0.125, gy * 0.125); }
vec3 tDx, tDy;
float fbm3(vec2 p) { return nTex(p).r; }
float fbmB(vec2 p) { return nTex(p).a; }
vec2 ngrad(vec2 p) { return (nTex(p).gb - 0.5) * 6.0; }
vec3 triW(vec3 n) { vec3 w = pow(abs(n), vec3(4.0)); return w / (w.x + w.y + w.z); }
float triFbm(vec3 p, vec3 w, float s) { return fbm3(p.zy * s) * w.x + fbm3(p.xz * s) * w.y + fbm3(p.xy * s) * w.z; }
float triFbmB(vec3 p, vec3 w, float s) { return fbmB(p.zy * s) * w.x + fbmB(p.xz * s) * w.y + fbmB(p.xy * s) * w.z; }
vec4 triTex(vec3 p, vec3 w, float s) { return nTex(p.zy * s) * w.x + nTex(p.xz * s) * w.y + nTex(p.xy * s) * w.z; }
vec3 triGrad(vec3 p, vec3 w, float s) {
  vec2 gx = ngrad(p.zy * s), gy = ngrad(p.xz * s), gz = ngrad(p.xy * s);
  return vec3(0.0, -gx.y, -gx.x) * w.x + vec3(-gy.x, 0.0, -gy.y) * w.y + vec3(-gz.x, -gz.y, 0.0) * w.z;
}
vec2 ngradL(vec2 p, float lod) { return (textureLod(uNoise, p * 0.125, lod).gb - 0.5) * 6.0; }
vec3 triGradL(vec3 p, vec3 w, float s, float lod) {
  vec2 gx = ngradL(p.zy * s, lod), gy = ngradL(p.xz * s, lod), gz = ngradL(p.xy * s, lod);
  return vec3(0.0, -gx.y, -gx.x) * w.x + vec3(-gy.x, 0.0, -gy.y) * w.y + vec3(-gz.x, -gz.y, 0.0) * w.z;
}
float glint(vec2 p, float px, vec3 n, vec3 H) {
  if (px > 0.7) return 0.0;
  ivec2 c = ivec2(floor(p));
  float h1 = tHash(c), h2 = tHash(c + ivec2(7, 113)), h3 = tHash(c + ivec2(151, 29)), h4 = tHash(c + ivec2(37, 211));
  vec3 facet = normalize(n + vec3(h1 - 0.5, 0.0, h2 - 0.5) * 1.0);
  float align = pow(max(dot(facet, H), 0.0), 700.0);
  float r = max(0.1, 0.75 * px);
  float pt = 1.0 - smoothstep(r * 0.4, r, length(fract(p) - 0.2 - 0.6 * vec2(h3, h4)));
  return align * pt * (0.12 + 2.4 * h3 * h3 * h4) * (1.0 - smoothstep(0.35, 0.7, px));
}
// ---- the snow trail map (toroidal, uTrail.xy its centre; heights in metres: berms up, grooves down)
float trailFade(vec2 xz) {
  vec2 d = abs(xz - uTrail.xy) * uTrail.z * 2.0;
  return 1.0 - smoothstep(0.82, 0.97, max(d.x, d.y));
}
vec4 trailTex(vec2 xz) { return texture(uTrailMap, xz * uTrail.z); }
float trailH(vec4 t) { return t.g * 0.05 - t.r * 0.12; }
float trailHAt(vec2 xz) { return trailH(textureLod(uTrailMap, xz * uTrail.z, 0.0)); }

void main() {
  vWPos = vRel + uCamPos.xyz;
  float uSnowCover = uMisc.y, uIcy = uMisc.w, uSparkle = uMisc2.x;
  vec3 v = normalize(-vRel);
  float tRock, tGroomed, tDist, tFw; vec3 tTriW, tRockN;
  vec2 tRelG; float tRelV, tRelK, tRelA;
  float tIce = 0.0, tCav = 1.0;
  vec3 alb;
  // trail map (sampled outside every branch: derivatives)
  float trOn = 0.0; vec4 trT = vec4(0.0); vec2 trG = vec2(0.0); float trHc = 0.0;
  // ================= color_fragment
  {
    tDist = length(vRel);
    tDx = dFdx(vWPos); tDy = dFdy(vWPos);
    tFw = length(abs(tDx) + abs(tDy));
    vec3 wn = normalize(vNormal);
    float slope = 1.0 - clamp(wn.y, 0.0, 1.0);
    float n1 = fbm3(vWPos.xz * 0.045);
    float n2 = fbmB(vWPos.xz * 0.006 + 7.0);
    tTriW = triW(wn);
    if (slope > 0.4) {
      float sx = nTexG(vWPos.zy * 0.045, tDx.zy * 0.045, tDy.zy * 0.045).r, sz = nTexG(vWPos.xy * 0.045, tDx.xy * 0.045, tDy.xy * 0.045).r;
      n1 = mix(n1, n1 * tTriW.y + sx * tTriW.x + sz * tTriW.z, smoothstep(0.4, 0.55, slope));
    }
    vec2 sw = abs(wn.xz) + 1e-3;
    sw /= sw.x + sw.y;
    float farK = smoothstep(400.0, 6000.0, tDist);
    float cliff = smoothstep(0.24, 0.38, vMacro);
    float rockT = 0.28 - farK * 0.1 + (n2 - 0.5) * 0.16 + uSnowCover * 0.05 - cliff * 0.07;
    float edgeW = 0.05 + 0.12 * smoothstep(800.0, 4000.0, tDist);
    float slopeR = max(slope, vMacro * smoothstep(900.0, 2200.0, tDist));
    float bench = smoothstep(0.05, 0.14, vMacro - slope) * smoothstep(0.08, 0.14, vMacro);
    float streak = 0.0, edgeN = 0.5;
    if (slopeR + 0.085 > rockT || bench > 0.001) {
      const vec2 kS = vec2(0.028, 0.0075);
      streak = nTexG(vWPos.zy * kS, tDx.zy * kS, tDy.zy * kS).r * sw.x + nTexG(vWPos.xy * kS + vec2(3.7, 1.3), tDx.xy * kS, tDy.xy * kS).r * sw.y;
      edgeN = nTexG(vWPos.xz * 0.23, tDx.xz * 0.23, tDy.xz * 0.23).r;
      if (slope > 0.4) {
        float ex = nTexG(vWPos.zy * 0.23, tDx.zy * 0.23, tDy.zy * 0.23).r, ez = nTexG(vWPos.xy * 0.23, tDx.xy * 0.23, tDy.xy * 0.23).r;
        edgeN = mix(edgeN, edgeN * tTriW.y + ex * tTriW.x + ez * tTriW.z, smoothstep(0.4, 0.55, slope));
      }
    }
    streak = mix(0.45, streak, 1.0 - smoothstep(0.45, 0.6, slope) * step(0.001, streak));
    rockT += smoothstep(0.62, 0.78, streak) * 0.1;
    // (native) height blend: near rock the baked rock height shifts the edge, so snow fills its hollows first
    float rockHgt = 0.5;
#if TERRAIN_DETAIL >= 2
    if (tDist < 160.0 && slopeR + 0.12 > rockT) {
      vec3 P = vWPos * 0.25;
      rockHgt = texture(uRockTex, P.zy).b * tTriW.x + texture(uRockTex, P.xz).b * tTriW.y + texture(uRockTex, P.xy).b * tTriW.z;
      rockHgt = mix(rockHgt, 0.5, smoothstep(90.0, 160.0, tDist));
    }
#endif
    tRock = smoothstep(rockT, rockT + edgeW, slopeR + (n1 - 0.5) * 0.1 + (edgeN - 0.5) * 0.06 + (rockHgt - 0.5) * 0.09);
    float dash = 1.0;
    if (bench > 0.001) dash = smoothstep(0.5, 0.6, nTexL(vec2(vWPos.x + vWPos.y * 0.7, vWPos.z - vWPos.y * 0.4) * 0.045, max(log2(32.0 * 0.045 * max(tFw, 1e-3)), 0.0)).a);
    tRock = max(tRock, bench * (1.0 - dash) * 0.92 * (1.0 - smoothstep(0.64, 0.8, streak)) * (1.0 - uSnowCover * 0.5));
    tRock *= 1.0 - smoothstep(0.6, 0.72, streak) * cliff * 0.85;
    tGroomed = vData.y;
    tRock *= 1.0 - tGroomed;
    tRelG = vec2(0.0); tRelV = 0.5; tRelK = 0.0; tRelA = 0.5;
    float flatK = 1.0 - smoothstep(0.45, 0.62, slope);
    if (tRock < 0.98 && flatK > 0.0) {
      float lvl = clamp(log2(max(tFw, 1e-3) * 12.0), -1.0, 10.0);
      float l0 = floor(lvl), lf = lvl - l0;
      float e0 = exp2(-l0), f0 = 0.5 * e0;
      vec2 q = (mat2(0.8, 0.6, -0.6, 0.8) * vWPos.xz) * vec2(1.0, 1.8);
      mat2 R = mat2(0.8, 0.6, -0.6, 0.8);
      vec2 qx = (R * tDx.xz) * vec2(1.0, 1.8), qy = (R * tDy.xz) * vec2(1.0, 1.8);
      vec2 o0 = fract(vec2(0.618, 0.382) * l0) * 8.0, o1 = fract(vec2(0.618, 0.382) * (l0 + 1.0)) * 8.0;
      lf = smoothstep(0.35, 0.65, lf);
      vec4 r0 = vec4(0.5), r1 = vec4(0.5);
      if (lf < 0.999) r0 = nTexG(q * f0 + o0, qx * f0, qy * f0);
      if (lf > 0.001) r1 = nTexG(q * (f0 * 0.5) + o1, qx * (f0 * 0.5), qy * (f0 * 0.5));
      vec2 g0 = (r0.gb - 0.5) * 6.0 * f0, g1 = (r1.gb - 0.5) * 3.0 * f0;
      float w0 = max(abs(dot(g0, qx)) + abs(dot(g0, qy)), 0.012), w1 = max(abs(dot(g1, qx)) + abs(dot(g1, qy)), 0.012);
      float k0 = 0.4 - clamp((r0.r - 0.5) / w0, -1.0, 1.0);
      float k1 = 0.4 - clamp((r1.r - 0.5) / w1, -1.0, 1.0);
      float a0 = exp2(-0.3 * (l0 + 1.0)), a1 = a0 * 0.812;
      vec2 gr = ((r0.gb - 0.5) * (k0 * a0 * (1.0 - lf)) + (r1.gb - 0.5) * (k1 * a1 * lf)) * 6.0 * vec2(1.0, 1.8);
      tRelG = gr * mat2(0.8, 0.6, -0.6, 0.8);
      float h0 = 0.4 * r0.r + 0.5 * (1.0 - abs(2.0 * r0.r - 1.0)), h1 = 0.4 * r1.r + 0.5 * (1.0 - abs(2.0 * r1.r - 1.0));
      tRelV = mix(h0, h1, lf) * 1.1;
      tRelK = mix(a0, a1, lf);
      tRelA = mix(r0.a, r1.a, lf);
      tRelG *= flatK; tRelK *= flatK; tRelV = mix(0.5, tRelV, flatK); tRelA = mix(0.5, tRelA, flatK);
    }
    // (native) a near-neutral snow albedo: the wind relief's hollows only a touch cooler (terrain.js tinted the snow
    // itself blue on top of the blue sky light)
    vec3 snow = vec3(0.86, 0.875, 0.895) * (0.955 + 0.045 * n1);
    vec3 relA = mix(vec3(0.9, 0.935, 0.98), vec3(1.03), smoothstep(0.2, 0.8, tRelV));
    snow *= mix(vec3(1.0), relA, (0.45 + 0.55 * tRelK) * (1.0 - uSnowCover * 0.6));
    snow *= 0.955 + 0.09 * smoothstep(0.25, 0.75, tRelA);
    snow = mix(snow, vec3(0.855, 0.88, 0.91), smoothstep(0.55, 0.8, n2) * 0.35);
    snow = mix(snow, vec3(0.86, 0.88, 0.905), tGroomed * 0.45);
    {
      float gpm = length(vData.zw);
      float lane = (gpm - 4.0) * 50.0 / 5.5;
      float lfw = fwidth(lane);
      float gOn = step(1.5, gpm) * tGroomed * (1.0 - smoothstep(0.25, 0.6, lfw)) * (1.0 - smoothstep(180.0, 520.0, tDist));
      float li = floor(lane), lf = fract(lane);
      float lh = fract(sin(li * 12.9898 + 4.1) * 43758.5453);
      float seam = 1.0 - smoothstep(0.0, 0.035 + lfw * 1.5, min(lf, 1.0 - lf));
      snow *= 1.0 + ((lh - 0.5) * 0.055 - seam * 0.035) * gOn;
    }
    alb = snow;
    tRockN = vec3(0.0);
    if (tRock > 0.002) {
      float buttress = 1.0 - smoothstep(1500.0, 5000.0, tDist), facets = 1.0 - smoothstep(200.0, 1500.0, tDist);
      if (buttress > 0.0) tRockN = triGrad(vWPos, tTriW, 0.028) * 0.4 * buttress;
      if (facets > 0.0) tRockN += triGrad(vWPos, tTriW, 0.12) * 0.6 * facets;
      vec4 faceN = triTex(vWPos, tTriW, 0.03);
      float faces = faceN.r;
      float grain = 0.5;
      if (tDist < 900.0) grain = mix(triFbmB(vWPos, tTriW, 0.22), 0.5, smoothstep(500.0, 900.0, tDist));
      float sy = vWPos.y * 0.085 + (fbm3(vWPos.xz * 0.0035) - 0.5) * 10.0 + (faces - 0.5) * 1.6;
      float strata = fbmB(vec2(sy * 0.5, 0.37));
      float closeR = 1.0 - smoothstep(25.0, 90.0, tDist);
      float cracks = 0.0;
#if TERRAIN_DETAIL >= 1
      if (closeR > 0.0) cracks = (1.0 - smoothstep(0.0, 0.035 + tFw * 0.25, abs(triFbm(vWPos, tTriW, 0.55) - 0.5))) * closeR;
#endif
      // (native) alpine gneiss / limestone instead of terrain.js's slate blue (navy in the shade): mid greys a
      // little lighter than before (weathered faces ~0.1 albedo), some strata and faces iron-stained warm, the
      // water streaks down the walls darker and cooler, the crevices darker still
      vec3 rock = mix(vec3(0.026, 0.026, 0.028), vec3(0.104, 0.1, 0.096), smoothstep(0.34, 0.66, faces * 0.65 + strata * 0.35));
      rock *= mix(vec3(1.0), vec3(1.2, 1.02, 0.8), saturate(smoothstep(0.56, 0.82, strata) * 0.75 + smoothstep(0.62, 0.86, faceN.a) * 0.45));
      rock *= (0.66 + 0.68 * grain) * (0.68 + 0.64 * smoothstep(0.32, 0.68, strata));
      tCav = smoothstep(0.25, 0.75, grain * 0.6 + faces * 0.4);
      rock *= 1.0 - cracks * 0.6;
      rock *= mix(vec3(1.0), vec3(0.7, 0.72, 0.76), 1.0 - smoothstep(0.2, 0.36, streak));
#if TERRAIN_DETAIL >= 2
      // (native) the baked rock map up close: lichen / mineral variation and darker hollows
      if (tDist < 90.0) {
        vec3 P = vWPos * 0.25;
        float av = texture(uRockTex, P.zy).a * tTriW.x + texture(uRockTex, P.xz).a * tTriW.y + texture(uRockTex, P.xy).a * tTriW.z;
        float k = 1.0 - smoothstep(40.0, 90.0, tDist);
        rock *= mix(1.0, (0.72 + 0.56 * av) * (0.8 + 0.4 * rockHgt), k);
        tCav = mix(tCav, tCav * (0.6 + 0.6 * rockHgt), k);
      }
#endif
      float upR = normalize(wn + tRockN).y;
      float onRelief = smoothstep(0.6, 0.78, upR + (grain - 0.5) * 0.12) * (1.0 - smoothstep(0.8, 0.97, slope));
      float patches = smoothstep(0.52, 0.72, faceN.a) * (1.0 - smoothstep(0.42, 0.78, slope)) * (1.0 - cliff * 0.6);
      float steepF = smoothstep(0.42, 0.7, slope) * (1.0 - smoothstep(220.0, 420.0, tDist));
      if (steepF > 0.0) {
        float wx = smoothstep(0.32, 0.68, tTriW.x / max(tTriW.x + tTriW.z, 1e-3));
        vec2 pz = vec2(vWPos.x, vWPos.y), px = vec2(vWPos.z, vWPos.y);
        const vec2 kL = vec2(0.09, 0.5);
        vec4 lz = vec4(0.0), lx = vec4(0.0);
        if (wx < 0.999) lz = nTexG(pz * kL + 5.3, tDx.xy * kL, tDy.xy * kL);
        if (wx > 0.001) lx = nTexG(px * kL + 5.3, tDx.zy * kL, tDy.zy * kL);
        float ledge = mix(lz.r, lx.r, wx), flecks = mix(lz.a, lx.a, wx);
        float fresh = uSnowCover * 0.08;
        float wl = tFw * 0.3 + 0.008, wf = tFw * 0.36 + 0.008;
        float stuck = max(smoothstep(0.63 - fresh - wl, 0.63 - fresh + wl, ledge), smoothstep(0.73 - fresh - wf, 0.73 - fresh + wf, flecks) * 0.75) * smoothstep(0.3, 0.6, grain + 0.1);
        patches = max(patches, stuck * steepF);
      }
      alb = mix(snow, rock, tRock * (1.0 - max(patches, onRelief) * 0.88));
    }
    float farF = smoothstep(1300.0, 3800.0, tDist) * tRock;
    if (farF > 0.001) {
      float lod = log2(max(tFw * 0.008 * 32.0, 1e-3));
      vec3 farN = triGradL(vWPos, tTriW, 0.008, lod) * 0.6 + triGradL(vWPos + 41.0, tTriW, 0.021, lod + 1.4) * 0.25;
      tRockN += farN * farF;
      float upF = normalize(wn + farN).y;
      float farSnow = smoothstep(0.5, 0.68, upF) * (1.0 - smoothstep(0.62, 0.9, slope));
      alb = mix(alb, snow, farF * farSnow);
    }
    // distant forests: dark conifer green tint fading in where the real trees become impostors
    float forestFar = vData.x * smoothstep(160.0, 420.0, tDist);
    if (forestFar > 0.001) {
      vec3 forestCol = mix(vec3(0.019, 0.032, 0.028), vec3(0.54, 0.57, 0.61), smoothstep(0.4, 0.9, nTexL(vWPos.xz * 0.12, max(log2(32.0 * 0.12 * max(tFw, 1e-3)), 0.0)).r));
      alb = mix(alb, forestCol, forestFar * 0.85);
    }
#if TERRAIN_FX >= 1
    {
      const vec2 kM = vec2(0.0011);
      float mac = nTexG(vWPos.xz * kM + vec2(2.3, 5.1), tDx.xz * kM, tDy.xz * kM).a;
      alb *= mix(1.0, 0.95 + 0.085 * smoothstep(0.25, 0.75, mac), (1.0 - tRock) * (1.0 - uSnowCover * 0.7));
      if (tGroomed > 0.01 && tDist < 900.0) {
        vec2 pdI = normalize(vData.zw + 1e-4), acI = vec2(-pdI.y, pdI.x);
        const vec2 kI = vec2(0.018, 0.07);
        vec2 iq = vec2(dot(vWPos.xz, pdI), dot(vWPos.xz, acI)) * kI;
        vec2 iqx = vec2(dot(tDx.xz, pdI), dot(tDx.xz, acI)) * kI, iqy = vec2(dot(tDy.xz, pdI), dot(tDy.xz, acI)) * kI;
        vec4 ic = nTexG(iq + 11.7, iqx, iqy);
        float pitch = smoothstep(0.06, 0.24, slope);
        float th = 0.66 - uIcy * 0.12;
        tIce = smoothstep(th, th + 0.1, ic.r * 0.75 + ic.a * 0.25) * tGroomed * (0.3 + 0.7 * pitch) * (1.0 - uSnowCover)
          * (1.0 - smoothstep(500.0, 900.0, tDist));
        alb = mix(alb, vec3(0.6, 0.67, 0.76), tIce * 0.42);
      }
    }
#endif
    // ---- (native) the snow trail map: grooves and prints darken to compressed blue-grey, berms catch the light
    if (uMisc2.w > 0.5) {
      trOn = trailFade(vWPos.xz) * (1.0 - smoothstep(70.0, 110.0, tDist)) * (1.0 - tRock);
      if (trOn > 0.001) {
#if SL_FX >= 3
        // parallax: march the view ray down into the grooves (a few steps close by, one offset further out)
        vec2 pxz = vWPos.xz;
        if (tDist < 25.0) {
          vec3 vv = -v;
          float dy = max(-vv.y, 0.25);
          float dPrev = 0.0, tPrev = 0.0;   // d = ray height - surface height (> 0: still above)
          for (int i = 1; i <= 6; i++) {
            float t = float(i) / 6.0 * 0.12 / dy;
            vec2 q = vWPos.xz + vv.xz * t;
            float d = -t * dy - trailHAt(q);
            if (d > 0.0) { pxz = q; } else {
              float a = dPrev / max(dPrev - d, 1e-5);
              pxz = mix(vWPos.xz + vv.xz * tPrev, q, saturate(a));
              break;
            }
            dPrev = d; tPrev = t;
          }
        }
        trT = trailTex(pxz);
#else
        vec2 pxz = vWPos.xz;
        trT = trailTex(pxz);
#endif
        trHc = trailH(trT);
        float e = uTrail.w;
        trG = vec2(trailHAt(pxz + vec2(e, 0.0)) - trailHAt(pxz - vec2(e, 0.0)), trailHAt(pxz + vec2(0.0, e)) - trailHAt(pxz - vec2(0.0, e))) / (2.0 * e);
        float groove = saturate(trT.r * 3.0) * trOn, berm = saturate(trT.g * 2.0) * trOn, packedS = saturate(trT.b) * trOn;
        alb *= mix(vec3(1.0), vec3(0.84, 0.88, 0.93), groove * (0.55 + 0.45 * trT.a));
        alb *= 1.0 - packedS * 0.05;
        alb = mix(alb, vec3(0.93, 0.95, 0.98), berm * 0.4);
        tCav *= 1.0 - groove * 0.4;
      }
    }
  }
  // ================= roughnessmap_fragment
  float rough = mix(0.58, 0.92, tRock);
  rough = mix(rough, 0.72, tGroomed);
#if TERRAIN_FX >= 1
  rough = mix(rough, 0.17, tIce);
#endif
  rough = mix(rough, 0.5, saturate(trT.b) * trOn);
  // ================= normal_fragment_maps
  vec3 pn;
  {
    vec3 wn = normalize(vNormal);
    float fade = 1.0 - smoothstep(30.0, 140.0, tDist);
    float fadeMid = 1.0 - smoothstep(60.0, 320.0, tDist);
    float onSnow = 1.0 - tRock;
    vec2 g = tRelG * 0.42 * onSnow * (1.0 - 0.72 * tGroomed) * (1.0 - 0.35 * uSnowCover);
#if TERRAIN_DETAIL >= 1
    if (fadeMid * onSnow > 0.0) {
      vec2 sq = ngrad((mat2(0.8, 0.6, -0.6, 0.8) * vWPos.xz) * vec2(0.04, 0.22)) * vec2(0.04, 0.22);
      g += (sq * mat2(0.8, 0.6, -0.6, 0.8)) * 0.4 * fadeMid * onSnow * (1.0 - tGroomed);
    }
    if (fade * onSnow > 0.0) g += ngrad(vWPos.xz * 3.5) * 0.04 * fade * onSnow;
#endif
#if TERRAIN_DETAIL >= 2
    {
      vec2 mp = vWPos.xz * 11.0;
      float mfw = length(fwidth(mp));
      float micro = (1.0 - smoothstep(6.0, 26.0, tDist)) * (1.0 - smoothstep(0.35, 0.8, mfw)) * onSnow;
      if (micro > 0.0) g += (ngrad(mp) * 0.6 + ngrad(mp * 2.7 + 3.1) * 0.4) * 0.03 * micro * (1.0 - 0.6 * tGroomed);
    }
    // (native) the baked high-resolution snow map: crystals and grain at two rotated scales, crisp right under the
    // skis and gone before it could shimmer (its mips + anisotropy band-limit it)
    {
      float near = (1.0 - smoothstep(12.0, 45.0, tDist)) * onSnow;
      if (near > 0.0) {
        vec2 sa = vWPos.xz * (1.0 / 1.6), sb = (mat2(0.6, -0.8, 0.8, 0.6) * vWPos.xz) * (1.0 / 0.55) + 0.37;
        vec4 ta = texture(uSnowTex, sa), tb = texture(uSnowTex, sb);
        vec2 sg = (ta.rg - 0.5) * 0.9 + ((tb.rg - 0.5) * 0.7) * mat2(0.6, -0.8, 0.8, 0.6);
        g += sg * 0.11 * near * (1.0 - 0.55 * tGroomed) * (1.0 - 0.7 * tIce);
      }
    }
#endif
    vec2 pd = normalize(vData.zw + 1e-4);
    float across = dot(vWPos.xz, vec2(-pd.y, pd.x));
    float cord = cos(across * 6.2831 / 0.12);
    float fw = fwidth(across) / 0.12;
    float cordFade = (1.0 - smoothstep(0.12, 0.3, fw)) * (1.0 - smoothstep(3.0, 14.0, tDist)) * tGroomed;
    g += vec2(-pd.y, pd.x) * cord * 0.09 * cordFade;
#if TERRAIN_FX >= 1
    if (fade * onSnow > 0.0) {
      vec2 gq = mat2(0.6, -0.8, 0.8, 0.6) * vWPos.xz;
      vec2 gg = ngrad(gq * 1.37 + 5.3) * 0.032;
#if TERRAIN_FX >= 3
      gg += ngrad(gq * 7.9 + 1.1) * 0.016 * (1.0 - smoothstep(10.0, 40.0, tDist));
#endif
      g += gg * fade * onSnow * (1.0 - 0.5 * tGroomed);
    }
    g *= 1.0 - 0.8 * tIce;
#endif
    // the trails: their slopes (and the snow inside them is smoother: the grain and corduroy are pressed flat)
    if (trOn > 0.001) {
      float flatT = saturate(trT.b * 1.5) * trOn;
      g *= 1.0 - flatT * 0.7;
      g += trG * trOn * 1.4;
    }
    vec3 rockN = tRockN;
#if TERRAIN_DETAIL >= 1
    if (tRock > 0.002 && tDist < 120.0) rockN += triGrad(vWPos, tTriW, 0.6) * 0.3 * (1.0 - smoothstep(30.0, 120.0, tDist));
#endif
#if TERRAIN_DETAIL >= 2
    if (tRock > 0.002 && tDist < 60.0) {
      vec3 P = vWPos * 0.25;
      vec2 a = texture(uRockTex, P.zy).rg - 0.5, b = texture(uRockTex, P.xz).rg - 0.5, c = texture(uRockTex, P.xy).rg - 0.5;
      vec3 rg = vec3(0.0, a.y, a.x) * tTriW.x + vec3(b.x, 0.0, b.y) * tTriW.y + vec3(c.x, c.y, 0.0) * tTriW.z;
      rockN += rg * 1.1 * (1.0 - smoothstep(25.0, 60.0, tDist));
    }
#endif
    pn = normalize(wn + vec3(-g.x, 0.0, -g.y) + rockN * tRock);
  }
  // ================= lighting (three's physical model) + terrain.js lights_fragment_end
  vec3 wn = normalize(vNormal);
  float sh = shadowAt(vRel, wn);
#if SL_FX >= 4
  // (native) the grooves shade themselves in low sun: a short march over the trail heights toward the light
  if (trOn > 0.01 && tDist < 30.0 && uSunDir.y < 0.6) {
    vec3 l = uSunDir.xyz;
    float occ = 0.0;
    for (int i = 1; i <= 4; i++) {
      float t = float(i) * 0.05;
      float h = trailHAt(vWPos.xz + l.xz * t / max(length(l.xz), 1e-3));
      occ = max(occ, saturate((h - (trHc + l.y / max(length(l.xz), 1e-3) * t)) * 40.0));
    }
    sh *= 1.0 - occ * 0.8 * trOn;
  }
#endif
  Lit L = lightSurface(alb, 0.0, rough, pn, v, sh, wn);
  float sunK = smoothstep(0.4, 2.8, dot(uSunColor.rgb / max(uHemiGround.w, 0.05), vec3(0.3333)) * uHemiGround.w);
  // (native) terrain.js's "cold sky-blue shade" tinted the (already blue) sky light again: (0.66, 0.8, 0.98) in the
  // sun. The same density, near neutral: the sky light itself gives the shade its cool
  L.iDiff *= mix(vec3(0.95, 0.96, 0.98), vec3(0.76, 0.785, 0.81), sunK);
  float tTilt = pn.y - wn.y;
  L.iDiff *= mix(1.0, (0.5 + 0.65 * tCav) * clamp(0.72 + 0.4 * pn.y + 1.4 * tTilt, 0.32, 1.3), tRock);
  L.iDiff *= mix(1.0, mix(0.7, 1.06, smoothstep(0.15, 0.85, tRelV)), (1.0 - tRock) * (0.35 + 0.65 * tRelK));
  float tSnowK = 1.0 - tRock;
  {
    float tNdl = saturate(dot(pn, uSunDir.xyz));
#if TERRAIN_FX >= 2
    vec3 tCool = mix(vec3(0.86, 0.93, 1.03), vec3(1.0), smoothstep(0.1, 1.0, tNdl));
#else
    vec3 tCool = mix(vec3(0.82, 0.91, 1.04), vec3(1.0), smoothstep(0.15, 1.0, tNdl));
#endif
    L.dDiff *= mix(vec3(1.0), tCool, sunK * tSnowK);
  }
  float tSpecK = tSnowK;
#if TERRAIN_FX >= 1
  tSpecK *= 1.0 - tIce;
#endif
  L.dSpec *= 1.0 - 0.65 * tSpecK;
  L.iSpec *= 1.0 - 0.45 * tSpecK;
  vec3 sunE = L.sunE;
#if TERRAIN_FX >= 1
  {
    float ndlS = dot(pn, uSunDir.xyz);
    float wrapE = saturate((ndlS + 0.4) / 1.4) - saturate(ndlS);
    L.dDiff += sunE * wrapE * vec3(0.66, 0.82, 1.0) * 0.5 * alb * RECIPROCAL_PI * tSnowK;
#if TERRAIN_FX >= 2
    float tBack = saturate(dot(-v, uSunDir.xyz));
    float tGrz = 1.0 - saturate(dot(pn, v));
    L.dSpec += sunE * (pow(tBack, 8.0) * tGrz * tGrz * saturate(ndlS + 0.2) * 0.05 * tSnowK * (1.0 - tIce) * (1.0 - 0.5 * uSnowCover));
#endif
  }
#endif
  // the trails: compressed snow scatters more light inside (bluer), the grooves see less of the sky
  if (trOn > 0.001) {
    float groove = saturate(trT.r * 3.0) * trOn;
    L.iDiff *= 1.0 - groove * 0.3;
    L.dDiff *= mix(vec3(1.0), vec3(0.9, 0.95, 1.0), groove);
  }
  // glints: sparse sun-facing ice facets, a few bright enough to bloom
#ifndef SL_LOW
  {
    vec2 gp1 = vWPos.xz * 16.0, gp2 = vWPos.xz * 4.5 + 0.5;
    float px1 = max(fwidth(gp1.x), fwidth(gp1.y)), px2 = max(fwidth(gp2.x), fwidth(gp2.y));
#if TERRAIN_DETAIL >= 2
    vec2 gp3 = vWPos.xz * 34.0 + 0.25;
    float px3 = max(fwidth(gp3.x), fwidth(gp3.y));
#endif
#if TERRAIN_FX >= 3
    vec2 gp4 = vWPos.xz * 1.6 + 0.75;
    float px4 = max(fwidth(gp4.x), fwidth(gp4.y));
#if TERRAIN_FX >= 4
    float sFade = (1.0 - tRock) * uSparkle * (1.0 - smoothstep(170.0, 260.0, tDist));
#else
    float sFade = (1.0 - tRock) * uSparkle * (1.0 - smoothstep(120.0, 200.0, tDist));
#endif
#else
    float sFade = (1.0 - tRock) * uSparkle * (1.0 - smoothstep(70.0, 120.0, tDist));
#endif
    sFade *= 1.0 - saturate(trT.b * 1.5) * trOn * 0.8;   // (packed snow in the tracks: few crystals left)
    if (sFade > 0.0 && uSunColor.w > 0.5) {
      vec3 gn = wn;
      vec3 H = normalize(uSunDir.xyz + v);
#if TERRAIN_DETAIL >= 1
      float spark = glint(gp1, px1, gn, H) + glint(gp2, px2, gn, H) * 0.8;
#else
      float spark = glint(gp2, px2, gn, H) * 1.3;
#endif
#if TERRAIN_DETAIL >= 2
      float graze = 1.0 - clamp(dot(gn, v), 0.0, 1.0);
      if (tDist < 28.0 && graze > 0.35) {
        vec3 gt = normalize(gn + vec3(tHash(ivec2(floor(gp3)) + ivec2(91, 7)) - 0.5, 0.0, tHash(ivec2(floor(gp3)) + ivec2(13, 57)) - 0.5) * 1.6);
        spark += glint(gp3, px3, gt, H) * 0.9 * smoothstep(0.35, 0.85, graze) * (1.0 - smoothstep(16.0, 28.0, tDist));
      }
#endif
#if TERRAIN_FX >= 3
      spark += glint(gp4, px4, gn, H) * 0.75 * smoothstep(45.0, 95.0, tDist);
#endif
      vec3 sunLit = L.dDiff / max(alb, vec3(0.05));
#if TERRAIN_FX >= 2
      vec3 gTint = 0.72 + 0.28 * cos(6.2832 * (tHash(ivec2(floor(gp1)) + ivec2(3, 71)) + vec3(0.0, 0.33, 0.67)));
      gTint = mix(vec3(1.0), gTint, 0.6 * (1.0 - smoothstep(4.0, 15.0, tDist)));
      L.dSpec += spark * sFade * 10.0 * sunLit * gTint;
#else
      L.dSpec += spark * sFade * 10.0 * sunLit;
#endif
    }
  }
#endif
  vec3 col = sumLit(L, 1.0) + localLights(alb, pn, vRel, v, rough, vec3(0.04));
  oColor = vec4(applyFog(col, vRel), 1.0);
}
)GLSL";

} // namespace sl::shaders
