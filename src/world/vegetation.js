// Forests + rocks: full Meshy meshes near the player, camera-facing impostors in the distance.
// Everything shares the logo's look: dark navy / blue-green pines with a dusting of fresh snow and slate-blue
// boulders. The impostors are baked with the very same tint code as the 3D trees and lit with baked normals, so
// near and far trees match in colour and brightness.
import * as THREE from 'three';
import { world } from './world.js';
import { hash2 } from '../core/noise.js';
import { bakeGeometry, fitModel, clusterDecimate } from '../core/assets.js';
import { terrainUniforms } from './terrain.js';
import { quality, onQualityChange } from '../engine/quality.js';
import { boulderKit, withGround, BOULDER_VARIANTS } from './boulders.js';


const CELL = 64;
const SPACING = 6.5;
// reach of each level (graphics preset, quality.veg): full Meshy trees within closeR, decimated trees to nearR,
// impostors to farR (High: 35 / 160 / 1500 m)
const FAR_R = 1500; // the most any preset generates (cells, impostor buffers)
const MAX_NEAR = 6000;
const MAX_FAR = 60000;
const MAX_ROCKS = 1500;
const ROCK_CLOSE_R = 45, MAX_CLOSE_ROCKS = 96; // boulders this close use the detailed mesh
const VILLAGE_CLEAR = 160; // no boulders around Legacy Village (centred on the origin): its paths, gardens and plaza
const BIG_ROCK = 2.6; // boulders from this size up stand tall (player.js collides with them); smaller ones only poke through the snow
const _q = new THREE.Quaternion(), _qy = new THREE.Quaternion(), _up = new THREE.Vector3(0, 1, 0), _n = new THREE.Vector3();
const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _id = new THREE.Quaternion();
const IMP_W = 256, IMP_H = 512; // impostor bake size

// Mean needle brightness (linear) of each pine texture: both models are normalised to the same tint with it.
// Measured from the texture at load; these are the values of the current models, used if that fails.
const NEEDLE_LUM = { pine_tree: 0.077, pine_tree2: 0.23 };

// Shared by the 3D trees and the impostors:
//  - snow on the branches (the model's own clumps + fresh dusting) shows fully up close, and fades toward the
//    distance so forests read as the logo's dark navy silhouettes instead of frosty grey
//  - the crown's self-shadowing: near the camera the sun's shadow map darkens the needles inside the crown; beyond
//    its range (~110 m) and on the impostors the same average amount is applied by hand, and the lower crown sees
//    less sky, so near and far trees keep one brightness
const PINE_SHARED_GLSL = /* glsl */`
  uniform float uSnowAmt; // 1 in fair weather, more while it snows
  const vec3 PINE_SNOW = vec3(0.78, 0.83, 0.9);
  const float PINE_DUST = 0.35;
  const float PINE_CROWN_SHADOW = 0.42;
  float pineSkyOcclusion(float h) { return mix(0.62, 1.0, clamp(h, 0.0, 1.0)); }
  float pineSnowShown(float mask, float dist) { return clamp(mask * uSnowAmt * (1.0 - 0.75 * smoothstep(40.0, 450.0, dist)), 0.0, 1.0); }`;
// The pine look, shared by the 3D trees and the impostor bake.
const PINE_GLSL = /* glsl */`
  uniform float uLumNorm; // 1 / mean needle luminance of this model's texture
  uniform sampler2D uNoise;
  ${PINE_SHARED_GLSL}
  // dark navy / blue-green needles; the texture's own detail survives as relative brightness
  vec3 pineNeedle(vec3 tex) {
    float k = clamp(dot(tex, vec3(0.2126, 0.7152, 0.0722)) * uLumNorm, 0.15, 2.2);
    return mix(vec3(0.011, 0.027, 0.040), vec3(0.028, 0.060, 0.072), smoothstep(0.5, 1.8, k)) * (0.6 + 0.4 * k);
  }
  // the texture's own snow clumps: bright and unsaturated, unlike the light needle tips
  float pineTexSnow(vec3 tex) {
    float hi = max(max(tex.r, tex.g), tex.b);
    return smoothstep(0.6, 0.82, min(min(tex.r, tex.g), tex.b) / max(hi, 1e-4)) * smoothstep(0.12, 0.3, hi);
  }
  // all the snow on a branch: its clumps plus fresh dusting where needles face the sky (op = tree-space position)
  float pineSnowMask(vec3 tex, vec3 wn, vec3 op) {
    float n = texture2D(uNoise, op.xz * 2.6 + vec2(op.y * 1.9, -op.y * 1.4)).r;
    return max(pineTexSnow(tex), smoothstep(0.45, 0.85, wn.y) * smoothstep(0.5, 0.66, n) * PINE_DUST);
  }
`;

// Impostor bake: albedo pass (needle colour) and normal pass (xy normal + snow mask), both from the side.
const BAKE_VERT = /* glsl */`
  varying vec2 vUv;
  varying vec3 vN;
  varying vec3 vObj;
  void main() {
    vUv = uv;
    vN = normalize(transpose(inverse(mat3(modelMatrix))) * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vObj = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }`;
const BAKE_ALBEDO = /* glsl */`
  uniform sampler2D map;
  ${PINE_GLSL}
  varying vec2 vUv;
  void main() { gl_FragColor = vec4(pineNeedle(texture2D(map, vUv).rgb), 1.0); }`;
const BAKE_NORMAL = /* glsl */`
  uniform sampler2D map;
  ${PINE_GLSL}
  varying vec2 vUv;
  varying vec3 vN;
  varying vec3 vObj;
  void main() {
    vec3 n = normalize(vN) * (gl_FrontFacing ? 1.0 : -1.0);
    gl_FragColor = vec4(n.xy * 0.5 + 0.5, pineSnowMask(texture2D(map, vUv).rgb, n, vObj), 1.0);
  }`;

// Mean linear luminance of a pine texture's needles (snow-white texels left out).
function needleLum(tex, fallback) {
  try {
    const img = tex?.image;
    if (!img?.width || typeof document === 'undefined') return fallback;
    const S = 256, c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, S, S);
    const d = g.getImageData(0, 0, S, S).data;
    const lin = (v) => (v <= 10 ? v / 3294.6 : Math.pow((v / 255 + 0.055) / 1.055, 2.4));
    let sum = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = lin(d[i]), gg = lin(d[i + 1]), b = lin(d[i + 2]), hi = Math.max(r, gg, b);
      if (hi > 0.2 && Math.min(r, gg, b) > hi * 0.7) continue; // snow clump
      sum += 0.2126 * r + 0.7152 * gg + 0.0722 * b;
      n++;
    }
    return n > 1000 ? sum / n : fallback;
  } catch {
    return fallback;
  }
}

export class Vegetation {
  constructor(scene, renderer, models) {
    this.scene = scene;
    this.cells = new Map();
    this.pendingCells = [];
    this.lastRebuild = new THREE.Vector2(1e9, 1e9);
    this.windUniform = { value: 0 };
    this.snowUniform = { value: 1 };
    this.farRUniform = { value: quality.veg.farR }; // impostors dissolve toward this distance

    const treeNames = ['pine_tree', 'pine_tree2'].filter((n) => models[n]);
    this.types = treeNames.map((n) => bakeGeometry(models[n], { size: 1, axis: 'y' }));
    const lumNorm = this.types.map((t, i) => 1 / needleLum(t.material.map, NEEDLE_LUM[treeNames[i]] ?? 0.1));
    const makeInst = (geo, mat, max, shadow) => {
      const m = new THREE.InstancedMesh(geo, mat, max);
      m.count = 0;
      m.castShadow = shadow;
      m.receiveShadow = true;
      m.frustumCulled = false;
      scene.add(m);
      return m;
    };
    const pineMats = this.types.map((t, i) => this.pineMaterial(t.material, lumNorm[i]));
    this.closeMeshes = this.types.map((t, i) => makeInst(t.geometry, pineMats[i], 2500, true));
    this.nearMeshes = this.types.map((t, i) => makeInst(clusterDecimate(t.geometry, 0.09), pineMats[i], MAX_NEAR, true));

    // boulders: procedural granite (boulders.js), a few shape variants at two detail levels; every instance
    // also carries the snow line under it (aGround) so snow banks against its foot
    this.rockKit = boulderKit();
    const makeRocks = (geo, max) => {
      const m = new THREE.InstancedMesh(withGround(geo, max), this.rockKit.material, max);
      m.count = 0;
      m.visible = false;
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      scene.add(m);
      return m;
    };
    this.rockFar = this.rockKit.lo.map((g) => makeRocks(g, MAX_ROCKS));
    this.rockNear = this.rockKit.hi.map((g) => makeRocks(g, MAX_CLOSE_ROCKS));

    this.impostors = treeNames.map((n, i) => this.renderImpostor(renderer, models[n], lumNorm[i]));
    this.farMeshes = this.impostors.map((imp) => this.makeImpostorMesh(imp));
    this.dummy = new THREE.Object3D();
    const applyQuality = (q) => {
      this.farRUniform.value = q.veg.farR;
      for (const m of this.nearMeshes) m.castShadow = q.veg.nearShadow;
      this.lastRebuild.set(1e9, 1e9);
    };
    applyQuality(quality);
    onQualityChange(applyQuality);
  }

  // The 3D pine material: logo tint, fresh snow on needles facing the sky, gentle wind sway.
  pineMaterial(src, lumNorm) {
    const mat = src.clone();
    // Meshy baked a glow map into the snow clumps (they lit up at night): snow is plain lit albedo now
    mat.emissive.setRGB(0, 0, 0);
    mat.emissiveMap = null;
    mat.metalness = 0;
    const wind = this.windUniform, snow = this.snowUniform, uLumNorm = { value: lumNorm };
    mat.onBeforeCompile = (s) => {
      s.uniforms.uWind = wind;
      s.uniforms.uLumNorm = uLumNorm;
      s.uniforms.uSnowAmt = snow;
      s.uniforms.uNoise = terrainUniforms.uNoise;
      s.vertexShader = s.vertexShader
        .replace('#include <common>', `#include <common>
          uniform float uWind;
          varying vec3 vPineObj;
          varying vec3 vPineW;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vPineObj = position;
          float sway = position.y * position.y * 0.012;
          vec3 ip = vec3(instanceMatrix[3]);
          transformed.x += sin(uWind * 1.3 + ip.x * 0.1 + ip.z * 0.07) * sway;
          transformed.z += cos(uWind * 1.1 + ip.z * 0.1) * sway * 0.6;
          vPineW = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;`);
      s.fragmentShader = s.fragmentShader
        .replace('#include <common>', `#include <common>
          ${PINE_GLSL}
          varying vec3 vPineObj;
          varying vec3 vPineW;`)
        .replace('#include <map_fragment>', `#include <map_fragment>
          vec3 pineTex = diffuseColor.rgb;
          diffuseColor.rgb = pineNeedle(pineTex);`)
        .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
          {
            float m = pineSnowMask(pineTex, inverseTransformDirection(normal, viewMatrix), vPineObj);
            float snowA = pineSnowShown(m, distance(vPineW, cameraPosition));
            diffuseColor.rgb = mix(diffuseColor.rgb, PINE_SNOW, snowA);
            roughnessFactor = mix(max(roughnessFactor, 0.82), 0.7, snowA);
          }`)
        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
          {
            float crown = mix(1.0, PINE_CROWN_SHADOW, smoothstep(85.0, 115.0, distance(vPineW, cameraPosition)));
            reflectedLight.directDiffuse *= crown;
            reflectedLight.directSpecular *= crown;
            reflectedLight.indirectDiffuse *= pineSkyOcclusion(vPineObj.y);
          }`);
    };
    return mat;
  }

  // Bakes a tree seen from the side into two small mipmapped textures: its needle colour (same tint code as the
  // 3D trees) and its normals + snow mask. Both come out coverage-weighted (the MSAA resolve and the mips
  // average against a transparent black background), which the impostor shader divides back out.
  renderImpostor(renderer, gltf, lumNorm) {
    const opts = { samples: 4, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter };
    const albedo = new THREE.WebGLRenderTarget(IMP_W, IMP_H, { ...opts, colorSpace: THREE.SRGBColorSpace });
    const normal = new THREE.WebGLRenderTarget(IMP_W, IMP_H, opts);
    const scene = new THREE.Scene();
    const tree = fitModel(gltf, { size: 1, axis: 'y' });
    scene.add(tree);
    const uniforms = { uLumNorm: { value: lumNorm }, uSnowAmt: this.snowUniform, uNoise: terrainUniforms.uNoise };
    const passes = [[albedo, BAKE_ALBEDO], [normal, BAKE_NORMAL]].map(([rt, fragmentShader]) => {
      const mats = [];
      tree.traverse((o) => {
        if (!o.isMesh) return;
        mats.push([o, new THREE.ShaderMaterial({
          uniforms: { ...uniforms, map: { value: o.material.map } },
          vertexShader: BAKE_VERT, fragmentShader, side: THREE.DoubleSide,
        })]);
      });
      return [rt, mats];
    });
    const size = tree.userData.size;
    const halfW = Math.max(size.x, size.z) / 2 * 1.05;
    const cam = new THREE.OrthographicCamera(-halfW, halfW, 1.0, 0, -10, 10);
    cam.position.set(0, 0, 2);
    const prevTarget = renderer.getRenderTarget();
    const prevColor = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    for (const [rt, mats] of passes) {
      for (const [o, m] of mats) o.material = m;
      renderer.setRenderTarget(rt);
      renderer.clear();
      renderer.render(scene, cam);
    }
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevColor, prevAlpha);
    for (const [, mats] of passes) for (const [, m] of mats) m.dispose();
    return { albedo: albedo.texture, normal: normal.texture, aspect: halfW * 2 };
  }

  makeImpostorMesh(imp) {
    const plane = new THREE.PlaneGeometry(imp.aspect, 1);
    plane.translate(0, 0.5, 0);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = plane.index;
    geo.attributes.position = plane.attributes.position;
    geo.attributes.uv = plane.attributes.uv;
    geo.attributes.normal = plane.attributes.normal;
    const data = new Float32Array(MAX_FAR * 4);
    const attr = new THREE.InstancedBufferAttribute(data, 4);
    attr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aOffset', attr);
    geo.instanceCount = 0;
    // alpha to coverage (the main render target is MSAA): soft, non-shimmering edges on the mipmapped bake
    const mat = new THREE.MeshStandardMaterial({ map: imp.albedo, roughness: 0.88, metalness: 0, side: THREE.DoubleSide, alphaTest: 0.4, alphaToCoverage: true });
    const nTex = { value: imp.normal }, snow = this.snowUniform, farR = this.farRUniform;
    mat.onBeforeCompile = (s) => {
      s.uniforms.uImpN = nTex;
      s.uniforms.uSnowAmt = snow;
      s.uniforms.uFarR = farR;
      s.vertexShader = s.vertexShader
        .replace('#include <common>', `#include <common>
          attribute vec4 aOffset;
          uniform float uFarR;
          varying vec3 vImpR;
          varying vec3 vImpF;
          varying float vImpFade;
          varying float vImpDist;`)
        .replace('#include <beginnormal_vertex>', `
          vec3 toCam = cameraPosition - aOffset.xyz; toCam.y = 0.0;
          float camD = length(toCam);
          toCam /= max(camD, 1e-3);
          vec3 objectNormal = toCam;`)
        .replace('#include <begin_vertex>', `
          vec3 right = vec3(toCam.z, 0.0, -toCam.x);
          vec3 transformed = aOffset.xyz + right * position.x * aOffset.w + vec3(0.0, position.y * aOffset.w, 0.0);
          vImpR = right;
          vImpF = toCam;
          vImpDist = distance(transformed, cameraPosition);
          vImpFade = 1.0 - smoothstep(uFarR * 0.86, uFarR, camD); // dissolve at the far edge of the forest`);
      s.fragmentShader = s.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform sampler2D uImpN;
          varying vec3 vImpR;
          varying vec3 vImpF;
          varying float vImpFade;
          varying float vImpDist;
          ${PINE_SHARED_GLSL}`)
        .replace('#include <map_fragment>', `
          // un-weight the coverage-weighted bake so edges and small mips keep the true colour
          vec4 impA = texture2D(map, vMapUv);
          vec4 impN = texture2D(uImpN, vMapUv);
          float impCov = max(impA.a, 1e-3);
          vec2 impXY = impN.rg / impCov * 2.0 - 1.0;
          vec3 impNb = vec3(impXY, sqrt(max(0.0, 1.0 - dot(impXY, impXY))));
          float impSnow = pineSnowShown(impN.b / impCov, vImpDist);
          diffuseColor.rgb = mix(impA.rgb / impCov, PINE_SNOW, impSnow);
          // thin distant crowns would erode away in the small mips: boost coverage with the mip level
          vec2 impTs = vec2(textureSize(map, 0));
          float impMip = max(0.0, log2(max(length(dFdx(vMapUv * impTs)), length(dFdy(vMapUv * impTs)))));
          diffuseColor.a = impA.a * (1.0 + 0.22 * impMip) * vImpFade;
          // baked normal (x = right, y = up, z = toward the viewer) to world space
          vec3 impWN = normalize(vImpR * impNb.x + vec3(0.0, impNb.y, 0.0) + vImpF * impNb.z);`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          roughnessFactor = mix(roughnessFactor, 0.7, impSnow);`)
        .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
          normal = normalize((viewMatrix * vec4(impWN, 0.0)).xyz);`)
        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
          reflectedLight.directDiffuse *= PINE_CROWN_SHADOW;
          reflectedLight.directSpecular *= PINE_CROWN_SHADOW;
          reflectedLight.indirectDiffuse *= pineSkyOcclusion(vMapUv.y);`);
    };
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    return mesh;
  }

  genCell(cx, cz) {
    const trees = [], rocks = [];
    const x0 = cx * CELL, z0 = cz * CELL;
    const c = { d: 1e9 };
    const gx0 = Math.floor(x0 / SPACING), gx1 = Math.floor((x0 + CELL) / SPACING);
    const gz0 = Math.floor(z0 / SPACING), gz1 = Math.floor((z0 + CELL) / SPACING);
    for (let gz = gz0; gz < gz1; gz++) for (let gx = gx0; gx < gx1; gx++) {
      const r1 = hash2(gx, gz, 1), r2 = hash2(gx, gz, 2), r3 = hash2(gx, gz, 3);
      const x = (gx + r1) * SPACING, z = (gz + r2) * SPACING;
      const h = world.height(x, z);
      const hx = world.height(x + 1, z) - h, hz = world.height(x, z + 1) - h;
      const slope = Math.hypot(hx, hz);
      const f = world.forest(x, z, h, slope);
      const rr = hash2(gx, gz, 5);
      if (r3 < f * 0.85) {
        world.corridorAt(x, z, c);
        if (c.d < 3 + r1 * 4) continue;
        if (this.nearPad(x, z)) continue;
        const s = 7 + r1 * 9 + f * 5;
        trees.push({ x, y: h - 0.3, z, s, rot: r2 * 6.283, type: rr < 0.6 ? 0 : 1, r: s * 0.03 + 0.25, trunk: 0.15 + s * 0.012 }); // trunk: what a skier hits
      } else if (rr < (slope > 0.45 ? 0.05 : 0.006) && this.rockKit) {
        // big boulders keep further off the runs, clear of the nets and border poles at their edges
        world.corridorAt(x, z, c);
        if (c.d < 2.6 + (1 + r1 * 3.5) * 0.7 || this.nearPad(x, z) || x * x + z * z < VILLAGE_CLEAR * VILLAGE_CLEAR) continue;
        rocks.push(this.placeRock(x, z, h, hx, hz, r1, r2, hash2(gx, gz, 7), hash2(gx, gz, 8)));
      } else if (rr < 0.16 && slope > 0.12 && slope < 0.8 && this.rockKit) {
        // scree: below a rock wall, stones that broke off lie in loose clusters at its foot
        const ux = hx / slope, uz = hz / slope, ax = x + ux * 15, az = z + uz * 15;
        const cliff = Math.hypot(world.height(ax + 2, az) - world.height(ax - 2, az), world.height(ax, az + 2) - world.height(ax, az - 2)) / 4;
        if (cliff < 1.0) continue;
        world.corridorAt(x, z, c);
        if (c.d < 8 || this.nearPad(x, z) || x * x + z * z < VILLAGE_CLEAR * VILLAGE_CLEAR) continue;
        const n = 2 + Math.floor(hash2(gx, gz, 9) * 3);
        for (let k = 0; k < n; k++) {
          const ox = x + (hash2(gx, gz, 20 + k) - 0.5) * 7, oz = z + (hash2(gx, gz, 30 + k) - 0.5) * 7;
          const oh = world.height(ox, oz), ohx = world.height(ox + 1, oz) - oh, ohz = world.height(ox, oz + 1) - oh;
          const big = hash2(gx, gz, 40 + k) < 0.12; // now and then a block too big to ski over
          const sz = big ? 2.7 + hash2(gx, gz, 50 + k) * 1.4 : 0.7 + hash2(gx, gz, 50 + k) * 1.4;
          rocks.push(this.placeRock(ox, oz, oh, ohx, ohz, (sz - 1) / 3.5, hash2(gx, gz, 60 + k), hash2(gx, gz, 70 + k), hash2(gx, gz, 80 + k), sz));
        }
      }
    }
    return { trees, rocks };
  }

  // One boulder: a shape variant, settled into the hillside (its base follows most of the slope), turned
  // at random. Small stones sit deep and only poke through the snow (they are skied over); big boulders
  // (BIG_ROCK and up, which stop the player) stand tall. The instance matrix is baked here; `g` is the
  // snow line under it for the shader. `y` is set so player.js's obstacle top (y + 0.75 s) is the real top.
  placeRock(x, z, h, hx, hz, r1, r2, r3, r4, size) {
    const kit = this.rockKit;
    const s = size ?? 1 + r1 * 3.5, v = Math.min(BOULDER_VARIANTS - 1, Math.floor(r3 * BOULDER_VARIANTS));
    const big = s >= BIG_ROCK;
    _n.set(-hx, 1, -hz).normalize();
    _q.setFromUnitVectors(_up, _n);
    _q.slerp(_id, 0.35);
    _qy.setFromAxisAngle(_up, r2 * Math.PI * 2);
    _q.multiply(_qy);
    const sy = s * (big ? 0.95 + r4 * 0.25 : 0.8 + r4 * 0.3), sz = s * (0.88 + r1 * 0.24);
    const H = kit.height[v] * sy;
    // share of the height under the snow: the stones you ski over show at most ~35 cm (no legs through rock)
    const sink = big ? 0.16 + r4 * 0.1 : Math.max(0.42 + r4 * 0.16, 1 - 0.35 / H);
    const base = h - sink * H;
    _p.set(x, base, z);
    _s.set(s, sy, sz);
    _m.compose(_p, _q, _s);
    const top = base + H * _n.y;
    return { x, y: top - 0.75 * s, z, s, r: s * 0.45, v, m: Float32Array.from(_m.elements), g: [hx, hz, h] };
  }

  nearPad(x, z) {
    const pads = world.padGrid.get(Math.floor(x / 256) + ',' + Math.floor(z / 256));
    if (!pads) return false;
    for (const p of pads) if (Math.hypot(x - p.x, z - p.z) < p.r + p.blend * 0.6) return true;
    return false;
  }

  getCell(cx, cz, create) {
    const key = cx + ',' + cz;
    let cell = this.cells.get(key);
    if (!cell && create) {
      world.ensureFeatures(cx * CELL, cz * CELL, (cx + 1) * CELL, (cz + 1) * CELL);
      cell = this.genCell(cx, cz);
      this.cells.set(key, cell);
    }
    return cell;
  }

  // Generate cells around the player within a time budget. Returns number still missing.
  update(px, pz, dt, budgetMs = 4) {
    this.windUniform.value += dt;
    // fresh snow settles on the branches while it snows (shared by the 3D trees and the impostors)
    this.snowUniform.value = 1 + 0.8 * terrainUniforms.uSnowCover.value;
    const t0 = performance.now(), farR = quality.veg.farR;
    const R = Math.ceil(farR / CELL);
    const pcx = Math.floor(px / CELL), pcz = Math.floor(pz / CELL);
    let missing = 0, generated = 0;
    // spiral-ish: near cells first
    for (let ring = 0; ring <= R; ring++) {
      for (let i = -ring; i <= ring; i++) for (let j = -ring; j <= ring; j++) {
        if (Math.max(Math.abs(i), Math.abs(j)) !== ring) continue;
        if ((i * i + j * j) * CELL * CELL > farR * farR) continue;
        const key = (pcx + i) + ',' + (pcz + j);
        if (this.cells.has(key)) continue;
        if (performance.now() - t0 > budgetMs && generated > 0) { missing++; continue; }
        this.getCell(pcx + i, pcz + j, true);
        generated++;
      }
    }
    if (generated || Math.hypot(px - this.lastRebuild.x, pz - this.lastRebuild.y) > 14) {
      this.lastRebuild.set(px, pz);
      this.rebuild(px, pz);
    }
    // evict very far cells
    if (this.cells.size > 4000) {
      for (const key of this.cells.keys()) {
        const [cx, cz] = key.split(',').map(Number);
        if (Math.hypot(cx - pcx, cz - pcz) * CELL > FAR_R * 1.6) this.cells.delete(key);
      }
    }
    return missing;
  }

  rebuild(px, pz) {
    const nearCounts = this.types.map(() => 0);
    const closeCounts = this.types.map(() => 0);
    const farCounts = this.types.map(() => 0);
    const farArrays = this.farMeshes.map((m) => m.geometry.attributes.aOffset.array);
    const rockFar = new Array(BOULDER_VARIANTS).fill(0), rockClose = new Array(BOULDER_VARIANTS).fill(0);
    let rockTotal = 0;
    const d = this.dummy, { closeR, nearR, farR, maxFar, rockR } = quality.veg;
    const R = Math.ceil(farR / CELL);
    const pcx = Math.floor(px / CELL), pcz = Math.floor(pz / CELL);
    for (let i = -R; i <= R; i++) for (let j = -R; j <= R; j++) {
      const cell = this.cells.get((pcx + i) + ',' + (pcz + j));
      if (!cell) continue;
      const cd = Math.hypot(i, j) * CELL;
      if (cd > farR + CELL) continue;
      for (const t of cell.trees) {
        const dx = t.x - px, dz = t.z - pz, d2 = dx * dx + dz * dz;
        const type = t.type < this.types.length ? t.type : 0;
        if (d2 < nearR * nearR) {
          const close = d2 < closeR * closeR && closeCounts[type] < 2500;
          if (!close && nearCounts[type] >= MAX_NEAR) continue;
          d.position.set(t.x, t.y, t.z);
          d.rotation.set(0, t.rot, 0);
          d.scale.setScalar(t.s);
          d.updateMatrix();
          if (close) this.closeMeshes[type].setMatrixAt(closeCounts[type]++, d.matrix);
          else this.nearMeshes[type].setMatrixAt(nearCounts[type]++, d.matrix);
        } else if (d2 < farR * farR) {
          const k = farCounts[type]++;
          if (k >= maxFar) continue;
          const a = farArrays[type];
          a[k * 4] = t.x; a[k * 4 + 1] = t.y; a[k * 4 + 2] = t.z; a[k * 4 + 3] = t.s;
        }
      }
      if (this.rockKit && cd < rockR) {
        for (const r of cell.rocks) {
          if (rockTotal >= MAX_ROCKS) break;
          const near = rockClose[r.v] < MAX_CLOSE_ROCKS && Math.hypot(r.x - px, r.z - pz) < ROCK_CLOSE_R;
          const mesh = near ? this.rockNear[r.v] : this.rockFar[r.v];
          const k = near ? rockClose[r.v]++ : rockFar[r.v]++;
          mesh.instanceMatrix.array.set(r.m, k * 16);
          mesh.geometry.attributes.aGround.array.set(r.g, k * 3);
          rockTotal++;
        }
      }
    }
    // (only the instances in use are uploaded)
    const upload = (m, n) => { m.count = n; const a = m.instanceMatrix; a.clearUpdateRanges(); a.addUpdateRange(0, n * 16); a.needsUpdate = true; };
    this.nearMeshes.forEach((m, i) => upload(m, nearCounts[i]));
    this.closeMeshes.forEach((m, i) => upload(m, closeCounts[i]));
    this.farMeshes.forEach((m, i) => {
      const n = Math.min(maxFar, farCounts[i]), a = m.geometry.attributes.aOffset;
      m.geometry.instanceCount = n;
      a.clearUpdateRanges();
      a.addUpdateRange(0, n * 4); // upload only the impostors in use
      a.needsUpdate = true;
    });
    if (this.rockKit) {
      const uploadRocks = (meshes, counts) => meshes.forEach((m, v) => {
        upload(m, counts[v]);
        m.visible = counts[v] > 0;
        const g = m.geometry.attributes.aGround;
        g.clearUpdateRanges(); g.addUpdateRange(0, counts[v] * 3); g.needsUpdate = true;
      });
      uploadRocks(this.rockFar, rockFar);
      uploadRocks(this.rockNear, rockClose);
    }
  }

  // Returns the first obstacle hit within radius r of (x,z), or null.
  /** The tree or rock at (x, z) within r, or null. Rocks smaller than `minRock` (size) are skied over.
   *  `trunkOnly`: trees count only by their trunk, so a skier brushes through the branches. */
  collide(x, z, r, minRock = 0, trunkOnly = false) {
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const cell = this.cells.get((cx + i) + ',' + (cz + j));
      if (!cell) continue;
      for (const t of cell.trees) {
        const dx = x - t.x, dz = z - t.z, tr = trunkOnly ? t.trunk ?? t.r : t.r;
        if (dx * dx + dz * dz < (r + tr) ** 2) return t;
      }
      for (const t of cell.rocks) {
        if (t.s < minRock) continue;
        const dx = x - t.x, dz = z - t.z;
        if (dx * dx + dz * dz < (r + t.r) ** 2) return t;
      }
    }
    return null;
  }
}
