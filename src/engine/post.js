// Post chain: HDR scene render (MSAA per preset) -> [bloom] -> [half-res ambient occlusion + sun shafts] ->
// one final pass: tone map, sRGB, grade, vignette, speed streaks. The graphics preset (engine/quality.js) decides
// which steps run; every step stays crisp (no blur on the image, no grain).
import * as THREE from 'three';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { quality, screenDPR } from './quality.js';

const QUAD_VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// Bloom without its last step: the final pass adds the bloom texture itself (no extra full-res blend).
class BloomTexture extends UnrealBloomPass {
  constructor(...a) {
    super(...a);
    // NaN / Inf scrub + firefly clamp, so a single bad pixel can't smear across the screen
    const m = this.materialHighPassFilter;
    m.fragmentShader = m.fragmentShader.replace('vec4 texel = texture2D( tDiffuse, vUv );',
      'vec4 texel = texture2D( tDiffuse, vUv ); if (any(isnan(texel)) || any(isinf(texel))) texel = vec4(0.0); texel.rgb = min(texel.rgb, vec3(64.0));');
    m.needsUpdate = true;
  }
  renderTexture(renderer, input) {
    const oldAutoClear = renderer.autoClear;
    renderer.getClearColor(this._oldClearColor);
    this.oldClearAlpha = renderer.getClearAlpha();
    renderer.autoClear = false;
    renderer.setClearColor(this.clearColor, 0);
    this.highPassUniforms.tDiffuse.value = input;
    this.highPassUniforms.luminosityThreshold.value = this.threshold;
    this.fsQuad.material = this.materialHighPassFilter;
    renderer.setRenderTarget(this.renderTargetBright);
    renderer.clear();
    this.fsQuad.render(renderer);
    let src = this.renderTargetBright;
    for (let i = 0; i < this.nMips; i++) {
      const m = this.separableBlurMaterials[i];
      this.fsQuad.material = m;
      m.uniforms.colorTexture.value = src.texture;
      m.uniforms.direction.value = UnrealBloomPass.BlurDirectionX;
      renderer.setRenderTarget(this.renderTargetsHorizontal[i]);
      renderer.clear();
      this.fsQuad.render(renderer);
      m.uniforms.colorTexture.value = this.renderTargetsHorizontal[i].texture;
      m.uniforms.direction.value = UnrealBloomPass.BlurDirectionY;
      renderer.setRenderTarget(this.renderTargetsVertical[i]);
      renderer.clear();
      this.fsQuad.render(renderer);
      src = this.renderTargetsVertical[i];
    }
    const c = this.compositeMaterial;
    this.fsQuad.material = c;
    c.uniforms.bloomStrength.value = this.strength;
    c.uniforms.bloomRadius.value = this.radius;
    c.uniforms.bloomTintColors.value = this.bloomTintColors;
    renderer.setRenderTarget(this.renderTargetsHorizontal[0]);
    renderer.clear();
    this.fsQuad.render(renderer);
    renderer.setClearColor(this._oldClearColor, this.oldClearAlpha);
    renderer.autoClear = oldAutoClear;
    return this.renderTargetsHorizontal[0].texture;
  }
}

// shared: view-space position from the scene depth
const DEPTH_GLSL = `
  uniform sampler2D tDepth;
  uniform vec2 uNearFar;
  uniform vec2 uInvProj; // 1 / projection[0][0], 1 / projection[1][1]
  float viewZ(vec2 uv) {
    float d = texture2D(tDepth, uv).x;
    float n = uNearFar.x, f = uNearFar.y;
    return 2.0 * n * f / (f + n - (d * 2.0 - 1.0) * (f - n));
  }
  vec3 viewPos(vec2 uv, float z) { return vec3((uv * 2.0 - 1.0) * uInvProj * z, -z); }`;

// Half-res SAO-style ambient occlusion (R) and screen-space sun shafts (G), linear depth in B.
// Sample rotations follow a 4 x 4 pattern that the next pass averages out exactly.
const AO_FRAG = `
  ${DEPTH_GLSL}
  uniform vec2 uFullTexel;
  uniform float uRadius, uIntensity, uProjScale, uSamples;
  uniform vec2 uSunUV; uniform float uShafts;
  varying vec2 vUv;
  float bayer2(vec2 a) { a = floor(a); return fract(dot(a, vec2(0.5, a.y * 0.75))); }
  float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
  void main() {
    // (a half-res pixel centre is a corner of the full-res depth texels: step onto one texel's centre, so the
    // neighbours below are exactly one texel away instead of rounding either way)
    vec2 uv0 = vUv - 0.5 * uFullTexel;
    float z = viewZ(uv0);
    if (z > 1500.0) { gl_FragColor = vec4(1.0, 0.0, z, 1.0); }
    else {
      vec3 P = viewPos(uv0, z);
      // normal from the depth neighbours (the nearer side of each pair: no smearing over silhouettes)
      vec2 dx = vec2(uFullTexel.x, 0.0), dy = vec2(0.0, uFullTexel.y);
      vec3 Pr = viewPos(uv0 + dx, viewZ(uv0 + dx)), Pl = viewPos(uv0 - dx, viewZ(uv0 - dx));
      vec3 Pu = viewPos(uv0 + dy, viewZ(uv0 + dy)), Pd = viewPos(uv0 - dy, viewZ(uv0 - dy));
      vec3 ex = abs(Pr.z - P.z) < abs(P.z - Pl.z) ? Pr - P : P - Pl;
      vec3 ey = abs(Pu.z - P.z) < abs(P.z - Pd.z) ? Pu - P : P - Pd;
      vec3 cn = cross(ex, ey);
      vec3 N = dot(cn, cn) > 1e-14 ? normalize(cn) : vec3(0.0, 0.0, 1.0);
      float R = uRadius * (1.0 + z * 0.012);          // a little wider far away (contact shading on buildings)
      float ssR = min(R * uProjScale / z, 90.0);      // pixels
      float rot = bayer4(gl_FragCoord.xy) * 6.2831853;
      float R2 = R * R, sum = 0.0;
      for (int i = 0; i < 16; i++) {
        if (float(i) >= uSamples) break;
        float a = (float(i) + 0.5) / uSamples;
        float ang = a * 6.2831853 * 2.618 + rot;
        vec2 off = vec2(cos(ang), sin(ang)) * ssR * (0.15 + 0.85 * a) * uFullTexel;
        vec2 uv = uv0 + off;
        vec3 Q = viewPos(uv, viewZ(uv));
        vec3 v = Q - P;
        float vv = dot(v, v), vn = dot(v, N);
        float f = max(R2 - vv, 0.0);
        sum += f * f * f * max((vn - 0.01 - 0.0015 * z) / (0.01 + vv), 0.0); // (depth-scaled bias: no self-shadowing)
      }
      float ao = max(0.0, 1.0 - sum * uIntensity * 5.0 / (R2 * R2 * R2 * uSamples));
      ao = mix(ao, 1.0, smoothstep(70.0, 220.0, z)); // contact shading only: the far landscape stays crisp
      gl_FragColor = vec4(ao, 0.0, z, 1.0);
    }
    // sun shafts: how much open sky lies between this pixel and the sun (16 taps, jittered by the same pattern)
    if (uShafts > 0.0) {
      vec2 d = uSunUV - vUv;
      float len = length(d * vec2(uFullTexel.y / uFullTexel.x, 1.0));
      vec2 st = d * min(1.0, 0.45 / max(len, 1e-4)) / 16.0;
      vec2 p = vUv + st * bayer4(gl_FragCoord.xy + 2.0);
      float s = 0.0, w = 1.0;
      for (int i = 0; i < 16; i++) {
        s += (texture2D(tDepth, p).x > 0.99999 ? 1.0 : 0.0) * w;
        w *= 0.94;
        p += st;
      }
      gl_FragColor.g = s / 10.6 * (1.0 - smoothstep(0.0, 0.75, len));
    }
  }`;

// 4 x 4 depth-aware average of the AO (removes the rotation pattern, keeps silhouettes); shafts plain.
const AO_BLUR_FRAG = `
  uniform sampler2D tAO; uniform vec2 uTexel;
  varying vec2 vUv;
  void main() {
    vec4 c = texture2D(tAO, vUv);
    float z = c.b, ao = 0.0, w = 0.0, sh = 0.0;
    for (int j = -2; j < 2; j++) for (int i = -2; i < 2; i++) {
      vec4 t = texture2D(tAO, vUv + vec2(float(i), float(j)) * uTexel);
      float k = exp(-abs(t.b - z) / (z * 0.04 + 0.05));
      ao += t.r * k; w += k; sh += t.g;
    }
    gl_FragColor = vec4(ao / max(w, 1e-4), sh / 16.0, z, 1.0);
  }`;

const FINAL_FRAG = `
  uniform sampler2D tDiffuse; uniform sampler2D tBloom; uniform sampler2D tAO;
  uniform float uBloom, uAO, uShaftK; uniform vec3 uSunCol;
  uniform float uSpeed, uTime, uAspect, uVignette, uDamage, uGrade;
  uniform vec2 uTexel; uniform float uSharp;
  ${DEPTH_GLSL}
  #include <tonemapping_pars_fragment>
  varying vec2 vUv;
  float hash(float n) { return fract(sin(n * 91.3458) * 47453.5453); }
  // HDR -> display values (for the sharpening below)
  vec3 toDisplay(vec3 c) { return sRGBTransferOETF(vec4(ACESFilmicToneMapping(min(c, vec3(64.0))), 1.0)).rgb; }
  void main(){
    vec3 col = texture2D(tDiffuse, vUv).rgb;
    if (any(isnan(col)) || any(isinf(col))) col = vec3(0.0);
    col = min(col, vec3(64.0));
    vec3 raw = col;
    #ifdef USE_AO
      // contact shading: the half-res AO, upsampled with depth weights so it never bleeds over silhouettes
      {
        float z = viewZ(vUv);
        vec2 ts = vec2(textureSize(tAO, 0));
        vec2 p = vUv * ts - 0.5, f = fract(p), b = (floor(p) + 0.5) / ts;
        vec4 a00 = texture2D(tAO, b), a10 = texture2D(tAO, b + vec2(1.0, 0.0) / ts);
        vec4 a01 = texture2D(tAO, b + vec2(0.0, 1.0) / ts), a11 = texture2D(tAO, b + 1.0 / ts);
        vec4 w = vec4((1.0 - f.x) * (1.0 - f.y), f.x * (1.0 - f.y), (1.0 - f.x) * f.y, f.x * f.y);
        float s = z * 0.03 + 0.05;
        w *= exp(-abs(vec4(a00.b, a10.b, a01.b, a11.b) - z) / s) + 1e-4;
        float ao = dot(w, vec4(a00.r, a10.r, a01.r, a11.r)) / dot(w, vec4(1.0));
        col *= mix(1.0, ao, uAO);
        col += uSunCol * (dot(w, vec4(a00.g, a10.g, a01.g, a11.g)) / dot(w, vec4(1.0))) * uShaftK;
      }
    #endif
    #ifdef USE_BLOOM
      col += texture2D(tBloom, vUv).rgb * uBloom;
    #endif
    // tone map + sRGB (as three's OutputPass; sRGBTransferOETF comes with three's shader prefix)
    col = ACESFilmicToneMapping(col);
    col = sRGBTransferOETF(vec4(col, 1.0)).rgb;
    // Upscale sharpening: when the scene is rendered below the screen's resolution (the Performance /
    // Balanced presets, dynamic resolution) the browser's bilinear stretch softens every edge. An unsharp mask
    // puts the edge contrast back: two bilinear taps half a texel off the centre on opposite diagonals give a
    // small low-pass (two extra fetches: this pass runs on every pixel); the difference is taken in display
    // values and limited, so strong edges never ring or halo. It is taken from the plain image and added to the
    // composed colour (AO / bloom are left as they are).
    if (uSharp > 0.0) {
      vec3 lo = 0.5 * (texture2D(tDiffuse, vUv + 0.5 * uTexel).rgb + texture2D(tDiffuse, vUv - 0.5 * uTexel).rgb);
      if (any(isnan(lo)) || any(isinf(lo))) lo = raw;
      vec3 dd = (toDisplay(raw) - toDisplay(lo)) * (2.4 * uSharp);
      col = clamp(col + clamp(dd, -0.04, 0.04), 0.0, 1.0); // (a tight limit: no bright rims round dark edges)
    }
    float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
    #if GRADE >= 2
      // sports-broadcast grade: a firm S-curve, vibrant (not oversaturated) colour, clean white snow, a touch of
      // cool in the shadows and warmth in the highlights
      col = mix(col, col * col * (3.0 - 2.0 * col), 0.22);
      float sat = max(col.r, max(col.g, col.b)) - min(col.r, min(col.g, col.b));
      l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(l), col, 1.1 + 0.22 * (1.0 - sat));
      col += vec3(-0.008, -0.002, 0.012) * (1.0 - l) * (1.0 - l) + vec3(0.012, 0.006, -0.01) * l * l;
      col = clamp(col, 0.0, 1.0);
    #else
      col = mix(vec3(l), col, 1.06);
    #endif
    vec2 d = (vUv - 0.5) * vec2(uAspect, 1.0);
    float r = length(d);
    col *= 1.0 - (uVignette + uSpeed * 0.05) * smoothstep(0.45, 0.9, r);
    // speed streaks: thin airborne-snow lines rushing past the edges of the frame at high speed
    if (uSpeed > 0.001) {
      float a = atan(d.y, d.x) / 6.2831853 + 0.5;
      float lanes = 150.0;
      float lane = floor(a * lanes);
      float h1 = hash(lane), h2 = hash(lane + 17.0), h3 = hash(lane + 41.0);
      float across = abs(fract(a * lanes) - 0.5) * 2.0;                 // 0 at the lane center
      float aa = min(fwidth(a * lanes), 0.25) * 2.0;                     // clamped: no seam where atan wraps
      float line = 1.0 - smoothstep(0.12 + h3 * 0.1 - aa, 0.12 + h3 * 0.1 + aa, across);
      float seg = fract(r * (1.6 + h2 * 1.4) - uTime * (1.1 + h1 * 1.5) - h1 * 9.0);
      float dash = smoothstep(0.0, 0.06, seg) * (1.0 - smoothstep(0.18, 0.42, seg));
      float edge = smoothstep(0.28, 0.85, r);
      float on = step(0.62, h2);                                           // a sparse set of lanes
      col += vec3(0.93, 0.96, 1.0) * line * dash * edge * on * uSpeed * 0.16;
    }
    col = mix(col, vec3(0.9, 0.92, 1.0), uDamage * 0.5);
    gl_FragColor = vec4(col, 1.0);
  }`;

const _v = new THREE.Vector3(), _size = new THREE.Vector2();

export class Post {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.worldScene = scene;
    const size = renderer.getDrawingBufferSize(_size);
    this.useAO = quality.ao > 0;
    this.target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: quality.msaa });
    if (this.useAO) this.target.depthTexture = new THREE.DepthTexture(size.x, size.y);

    // HDR bloom: only genuinely bright things (sun glints, lamps, lit windows) glow, not the snow itself
    this.bloom = new BloomTexture(new THREE.Vector2(size.x / 2, size.y / 2), 0.12, 0.35, 3.0);
    this.bloom.enabled = quality.bloom;

    const nearFar = { value: new THREE.Vector2(camera.near, camera.far) }, invProj = { value: new THREE.Vector2(1, 1) };
    const depth = { value: this.target.depthTexture || null };
    if (this.useAO) {
      const rt = () => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
      this.aoRaw = rt();
      this.aoTex = rt();
      this.aoQuad = new FullScreenQuad(new THREE.ShaderMaterial({
        uniforms: {
          tDepth: depth, uNearFar: nearFar, uInvProj: invProj, uFullTexel: { value: new THREE.Vector2() },
          uRadius: { value: 1.1 }, uIntensity: { value: 0.9 }, uProjScale: { value: 500 }, uSamples: { value: quality.ao > 1 ? 12 : 8 },
          uSunUV: { value: new THREE.Vector2() }, uShafts: { value: 0 },
        },
        vertexShader: QUAD_VERT, fragmentShader: AO_FRAG, depthTest: false, depthWrite: false,
      }));
      this.aoBlurQuad = new FullScreenQuad(new THREE.ShaderMaterial({
        uniforms: { tAO: { value: this.aoRaw.texture }, uTexel: { value: new THREE.Vector2() } },
        vertexShader: QUAD_VERT, fragmentShader: AO_BLUR_FRAG, depthTest: false, depthWrite: false,
      }));
    }

    const defines = { GRADE: quality.grade >= 2 ? 2 : 1 };
    if (this.useAO) defines.USE_AO = '';
    if (quality.bloom) defines.USE_BLOOM = '';
    this.final = new FullScreenQuad(new THREE.ShaderMaterial({
      defines,
      uniforms: {
        tDiffuse: { value: this.target.texture }, tBloom: { value: null }, tAO: { value: this.aoTex?.texture || null },
        tDepth: depth, uNearFar: nearFar, uInvProj: invProj,
        uBloom: { value: 1 }, uAO: { value: 0.75 }, uShaftK: { value: 0 }, uSunCol: { value: new THREE.Color() },
        toneMappingExposure: { value: renderer.toneMappingExposure },
        uTime: { value: 0 }, uSpeed: { value: 0 }, uVignette: { value: 0.18 }, uDamage: { value: 0 }, uAspect: { value: 16 / 9 },
        uTexel: { value: new THREE.Vector2(1, 1) }, uSharp: { value: 0 },
      },
      vertexShader: QUAD_VERT, fragmentShader: FINAL_FRAG, depthTest: false, depthWrite: false,
      toneMapped: false, // tone mapped by hand above (three would add its own copy of the functions)
    }));
    this.grade = this.final.material; // (kept for tests: grade.uniforms)
    this.speedFx = 0;
    this.sun = { dir: new THREE.Vector3(0, 1, 0), color: new THREE.Color(), vis: 0 };
    this.setSize(renderer.domElement.clientWidth || innerWidth, renderer.domElement.clientHeight || innerHeight);
  }

  setSize(w, h) {
    const size = this.renderer.getDrawingBufferSize(_size);
    this.target.setSize(size.x, size.y);
    this.bloom.setSize(size.x, size.y);
    if (this.useAO) {
      const hw = Math.max(1, Math.round(size.x / 2)), hh = Math.max(1, Math.round(size.y / 2));
      this.aoRaw.setSize(hw, hh);
      this.aoTex.setSize(hw, hh);
      this.aoQuad.material.uniforms.uFullTexel.value.set(1 / size.x, 1 / size.y);
      this.aoBlurQuad.material.uniforms.uTexel.value.set(1 / hw, 1 / hh);
    }
    const u = this.final.material.uniforms;
    u.uAspect.value = w / Math.max(1, h);
    u.uTexel.value.set(1 / Math.max(1, size.x), 1 / Math.max(1, size.y));
    // sharpening strength from the upscale factor (screen pixels per rendered pixel): none at native
    // resolution, gentle at the 75 % floor of dynamic resolution (0.3: at 0.67 it drew bright halos round dark
    // edges), stronger only for bigger upscales
    const up = screenDPR() / Math.max(0.1, this.renderer.getPixelRatio());
    u.uSharp.value = up > 1.02 ? THREE.MathUtils.clamp((up - 1) * 0.9, 0, 0.85) : 0;
  }

  // render a different scene/camera (e.g. a building interior)
  setView(scene, camera) { this.scene = scene; this.camera = camera; }

  // the sun for the shafts (direction, HDR colour, 0..1 how much of it is in clear view)
  setSun(dir, color, vis) { this.sun.dir.copy(dir); this.sun.color.copy(color); this.sun.vis = vis; }

  // speed: skier speed (m/s, 0 when not skiing); damage: crash flash 0..1
  render(dt, speed, damage) {
    const r = this.renderer, cam = this.camera, u = this.final.material.uniforms;
    u.uDamage.value = damage;
    // streaks fade in from ~75 km/h, full by ~140 km/h; eased so bumps in speed don't flicker them
    const target = this.scene === this.worldScene ? THREE.MathUtils.smoothstep(speed || 0, 21, 39) : 0;
    this.speedFx += (target - this.speedFx) * (1 - Math.exp(-dt * 3));
    u.uSpeed.value = this.speedFx;
    u.uTime.value = (u.uTime.value + dt) % 1000;
    u.toneMappingExposure.value = r.toneMappingExposure;

    r.setRenderTarget(this.target);
    r.render(this.scene, cam);

    if (this.bloom.enabled) u.tBloom.value = this.bloom.renderTexture(r, this.target.texture);
    u.uBloom.value = this.bloom.enabled ? 1 : 0;
    if (this.useAO) {
      const a = this.aoQuad.material.uniforms, P = cam.projectionMatrix.elements;
      u.uNearFar.value.set(cam.near, cam.far);
      u.uInvProj.value.set(1 / P[0], 1 / P[5]);
      a.uProjScale.value = P[5] * this.target.height * 0.5;
      // sun shafts (ultra): only while the sun is up, in view and not behind the peaks or cloud
      let shafts = 0;
      if (quality.shafts && this.scene === this.worldScene && this.sun.vis > 0.01) {
        _v.copy(this.sun.dir).transformDirection(cam.matrixWorldInverse);
        if (_v.z < -0.05) {
          _v.applyMatrix4(cam.projectionMatrix);
          a.uSunUV.value.set(_v.x * 0.5 + 0.5, _v.y * 0.5 + 0.5);
          shafts = this.sun.vis * (1 - THREE.MathUtils.smoothstep(Math.max(Math.abs(_v.x), Math.abs(_v.y)), 0.9, 1.6));
        }
      }
      a.uShafts.value = shafts;
      u.uShaftK.value = shafts * 0.07;
      u.uSunCol.value.copy(this.sun.color);
      r.setRenderTarget(this.aoRaw);
      this.aoQuad.render(r);
      r.setRenderTarget(this.aoTex);
      this.aoBlurQuad.render(r);
    }
    r.setRenderTarget(null);
    this.final.render(r);
  }

  dispose() {
    this.target.depthTexture?.dispose();
    this.target.dispose();
    this.bloom.dispose();
    for (const t of [this.aoRaw, this.aoTex]) t?.dispose();
    for (const q of [this.aoQuad, this.aoBlurQuad, this.final]) { if (q) { q.material.dispose(); q.dispose(); } }
  }
}
