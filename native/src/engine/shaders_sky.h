// The sky (sky.js SKY_FRAG: the logo's cobalt-to-haze gradient, the warm glow toward the sun, Rayleigh shading,
// the twilight arch and Belt of Venus, the Mie halo, cirrus wisps, the overcast deck's texture, the HDR sun disc
// with limb darkening; stars and the moon) and the environment the IBL is taken from (sky.js ENV_FRAG). (The clouds
// are atmosphere.js's impostors and overcast deck: shaders_clouds.h.)
#pragma once

namespace sl::shaders {

inline const char* kSkyCommon = R"GLSL(
// (uSkyNoise: R, G independent fbm, B ridged (sky.js makeSkyNoise), declared with the lighting)
float skyHash(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float starHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }

vec3 skyColor(vec3 d, bool withSun) {
  float e = d.y, h = max(e, 0.0);
  vec3 sunD = uTrueSun.xyz;
  float ang = length(d - sunD);
  vec2 dh = d.xz * inversesqrt(max(dot(d.xz, d.xz), 1e-8));
  vec2 sh = sunD.xz * inversesqrt(max(dot(sunD.xz, sunD.xz), 1e-8));
  float az = dot(dh, sh) * 0.5 + 0.5;
  vec3 col = mix(uSkyZenith.rgb, uSkyMid.rgb, exp(-h * 2.5));
  vec3 hz = mix(uSkyHorizon.rgb, uSkyGlow.rgb, az * az * az);
  col = mix(col, hz, exp(-h * uSkyMid.w));
  col += uSkyGlow.rgb * (uSkyZenith.w * 0.35) * (az * az * az * az) * exp(-h * 7.0);
#if SL_FX >= 2
  {
    float cs = dot(d, sunD);
    col *= mix(1.0, 0.87 + 0.2 * cs * cs, uSkyHaloBroad.w * smoothstep(0.0, 0.3, h));
    float anti = 1.0 - az; anti *= anti;
    float tw = uSkyHalo.w * anti;
    if (tw > 0.001) {
      col = mix(col, col * vec3(0.6, 0.66, 0.86), tw * smoothstep(0.075, 0.0, e) * smoothstep(-0.08, 0.0, e));
      float bz = (e - 0.1) / 0.055;
      col += uSkyBelt.rgb * tw * exp(-bz * bz);
    }
  }
#endif
  col += uSkyHalo.rgb * (exp(-ang * 40.0) + exp(-ang * 12.0) * 0.45 + exp(-ang * 3.5) * 0.12);
  col += uSkyHaloBroad.rgb * exp(-ang * 3.0);
  float mang = length(d - uMoonDir.xyz);
  col += uMoonGlow.rgb * (exp(-mang * 30.0) * 0.5 + exp(-mang * 5.0) * 0.12);
  float uCirrus = uSkyHorizon.w;
  if (uCirrus > 0.001 && e > 0.02) {
    vec2 p = d.xz / (e + 0.22);
    p = vec2(p.x * 0.8 + p.y * 0.6, p.y * 0.8 - p.x * 0.6) + vec2(uCamPos.w * 0.004, uCamPos.w * 0.0012);
    float cover = smoothstep(0.42, 0.68, texture(uSkyNoise, p * 0.11 + 0.37).g);
    float n1 = texture(uSkyNoise, p * vec2(0.22, 0.9)).r;
    float n2 = texture(uSkyNoise, p * vec2(0.6, 2.6) + vec2(n1 * 0.4, 0.0)).b;
    float w = smoothstep(0.56, 0.84, n1 * 0.55 + n2 * 0.45) * cover;
    w *= smoothstep(0.02, 0.25, e) * uCirrus;
    vec3 wc = uSkyWisp.rgb * (0.8 + 1.4 * exp(-ang * 4.0));
    col = mix(col, wc, w * 0.38);
  }
  float uOvercast = uSkyGlow.w;
  if (uOvercast > 0.001) {
    vec2 q = d.xz / (h + 0.25) * 0.06 + vec2(uCamPos.w * 0.0009, 0.0);
    float m = texture(uSkyNoise, q).r * 0.65 + texture(uSkyNoise, q * 2.7 + 3.1).g * 0.35;
    col *= 1.0 + (m - 0.5) * 0.32 * uOvercast * smoothstep(0.0, 0.25, h);
  }
  col = mix(col, uFogColor.rgb, smoothstep(0.0, -0.07, e));
  if (withSun) {
    // (native) the sky seen through the same air as the mountains (fog.js's exponential atmosphere along the ray):
    // in mist and snowfall the lower sky whites out with the far slopes instead of staying blue behind them
    float path = min(1.0 / (uFogParams.y * max(e, 0.004)), 26000.0);
    float fs = 1.0 - exp(-uFogParams.x * exp(-max(uCamPos.y, 0.0) * uFogParams.y) * path * 0.55);
    col = mix(col, uFogColor.rgb, fs);
  }
  if (withSun) {
    float R = 0.0085 * uSkyDisc.w;
    float aa = max(fwidth(ang), 1e-5) * 1.5;
    float disc = 1.0 - smoothstep(R - aa, R + aa, ang);
    float limb = sqrt(max(1.0 - (ang * ang) / (R * R), 0.0));
    col += uSkyDisc.rgb * disc * (0.55 + 0.45 * limb);
    // stars (sky.js makeStars) and the moon (makeMoon), both behind the sky's own glow
    float night = uSkyBelt.w;
    if (night > 0.001 && d.y > -0.05) {
      vec3 c = floor(d * 420.0);
      float s = starHash(c);
      float star = smoothstep(0.9965, 1.0, s);
      vec3 f = fract(d * 420.0) - 0.5;
      star *= smoothstep(0.5, 0.0, length(f)) * (0.7 + 0.3 * sin(uCamPos.w * 1.7 + s * 80.0));
      star *= 1.0 + step(0.9993, s) * 2.5;
      vec3 sc = vec3(star) * mix(vec3(0.75, 0.83, 1.0), vec3(1.0, 0.9, 0.75), starHash(c + 3.0));
      vec3 n = vec3(0.2858, 0.5240, 0.8022), t1 = vec3(0.9418, 0.0, -0.3356), t2 = cross(n, t1);
      float across = dot(d, n);
      vec2 uv = vec2(atan(dot(d, t2), dot(d, t1)) * 0.63662, across * 2.2);
      float cl = texture(uSkyNoise, uv).r * 0.6 + texture(uSkyNoise, uv * 3.0 + 0.37).g * 0.4;
      float lanes = smoothstep(0.38, 0.62, texture(uSkyNoise, uv * vec2(2.0, 5.0) + 0.71).b);
      float band = exp(-across * across * 16.0);
      sc += vec3(0.16, 0.2, 0.32) * band * (0.25 + smoothstep(0.42, 0.75, cl) * (0.4 + 0.6 * lanes)) * 0.05;
      col += sc * 2.2 * night * smoothstep(-0.02, 0.2, d.y);
    }
    if (uMoonGlow.w > 0.001) {
      vec3 md = uMoonDir.xyz;
      vec3 mx = normalize(cross(vec3(0.0, 1.0, 0.0), md)), my = cross(md, mx);
      vec2 p = vec2(dot(d, mx), dot(d, my)) / 0.0156;
      float r = length(p);
      if (dot(d, md) > 0.0 && r < 3.0) {
        float aa2 = fwidth(r) * 1.5;
        float discM = 1.0 - smoothstep(1.0 - aa2, 1.0 + aa2, r);
        float limbM = sqrt(max(1.0 - r * r, 0.0));
        float mare = exp(-dot(p - vec2(-0.28, 0.32), p - vec2(-0.28, 0.32)) / 0.1156) + exp(-dot(p - vec2(0.18, 0.42), p - vec2(0.18, 0.42)) / 0.0676)
                   + exp(-dot(p - vec2(0.32, 0.05), p - vec2(0.32, 0.05)) / 0.0576) + exp(-dot(p - vec2(-0.45, -0.12), p - vec2(-0.45, -0.12)) / 0.09) * 0.8;
        vec3 mc = vec3(0.96, 0.97, 1.0) * (1.0 - 0.32 * clamp(mare, 0.0, 1.0)) * (0.62 + 0.38 * limbM) * 3.4;
        col = mix(col, mc, discM * uMoonGlow.w);
      }
    }
  }
  return col;
}

)GLSL";

inline const char* kSkyFS = R"GLSL(
in vec2 vNdc;
out vec4 oColor;
uniform mat4 uInvViewProj;
void main() {
  vec4 w = uInvViewProj * vec4(vNdc, 1.0, 1.0);
  vec3 d = normalize(w.xyz / w.w);
  vec3 col = skyColor(d, true);
  col *= 1.0 + (skyHash(gl_FragCoord.xy) - 0.5) * 0.016;
  oColor = vec4(col, 1.0);
}
)GLSL";

// the IBL source (sky.js ENV_FRAG), rendered into an equirectangular map whose mips stand in for the roughness
inline const char* kEnvFS = R"GLSL(
in vec2 vNdc;
out vec4 oColor;
uniform vec3 uEnvZenith, uEnvHorizon, uEnvSun, uEnvGlow;
void main() {
  vec2 uv = vNdc * 0.5 + 0.5;
  float phi = (uv.x - 0.5) * 2.0 * PI, th = uv.y * PI;
  // (equirect(): u from atan(x, -z), v from acos(y) top to bottom)
  vec3 d = vec3(sin(th) * sin(phi), cos(th), -sin(th) * cos(phi));
  float e = d.y;
  vec3 col = mix(uEnvHorizon, uEnvZenith, smoothstep(0.0, 0.65, e));
  vec3 sunD = uTrueSun.xyz;
  vec2 dh = d.xz * inversesqrt(max(dot(d.xz, d.xz), 1e-8));
  vec2 sh = sunD.xz * inversesqrt(max(dot(sunD.xz, sunD.xz), 1e-8));
  float az = dot(dh, sh) * 0.5 + 0.5;
  col += uEnvGlow * (az * az * az) * exp(-max(e, 0.0) * 6.0);
  col = mix(col, uEnvGround.rgb, smoothstep(0.03, -0.2, e));
  float c = max(dot(d, sunD), 0.0);
  col += uEnvSun * (c * c * c * 0.35 + pow(c, 24.0) * 0.8);
  oColor = vec4(col, 1.0);
}
)GLSL";

} // namespace sl::shaders
