// Screen-space sun glare ("the sun with shaders" from the logo): a large blinding HDR core, a wide cyan-white
// glow that lifts the sky around the sun, a starburst of broad tapering rays with fine streaks between them,
// a faint cyan fringe and a few subtle lens ghosts on the sun -> screen centre axis (tuned side by side with
// the logo art). Drawn after everything (additive, no depth test) and only while the sun is really visible:
//  - terrain: CPU ray-march of world.height from the camera toward the sun (smooth partial occlusion),
//  - anything else that writes depth (trees, buildings, far peaks, the skier): GPU occlusion-query probes,
//  - below the horizon, at night, through cloud / snowfall / mist (env.sunVisible).
// One draw call for the glare (all quads in one geometry) + three tiny depth-only probe draws.
import * as THREE from 'three';
import { world } from './world.js';

const MARCH_STEPS = 48;
const MARCH_DIST = 8000; // m
const MAIN_SIZE = 0.9; // half-size of the glare quad, in half-screen-heights (room for the wide glow)
const FADE_TIME = 0.15; // s, visibility smoothing
const PROBE_OFFSETS = [[0, 0], [-0.0055, 0.0035], [0.0055, -0.0035]]; // half-screen-heights around the sun

// Starburst like the logo's sun: 32 spikes sorted by angle (a pixel evaluates its 5 angular neighbours):
// 8 long, broad primaries, 8 short broad secondaries and 16 fine streaks between them, jittered
// (deterministic). Each spike is a wedge: broad where it leaves the core, tapering to a thin tip.
const NRAYS = 32, RAY0 = 0.3, SPACING = (Math.PI * 2) / NRAYS;
const RAY_TIERS = [ // decay length, base width (half-screen-heights), intensity: [min, max]
  { len: [0.12, 0.2], wid: [0.016, 0.024], i: [1.4, 2.0] }, // primary
  { len: [0.06, 0.1], wid: [0.013, 0.018], i: [1.0, 1.3] }, // secondary
  { len: [0.08, 0.18], wid: [0.0045, 0.0065], i: [0.35, 0.55] }, // fine streak
];
const TIER_OF = [0, 2, 1, 2];
function makeRays() {
  const rays = [], inten = [];
  let seed = 11;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const at = (r) => r[0] + rnd() * (r[1] - r[0]);
  for (let i = 0; i < NRAYS; i++) {
    const T = RAY_TIERS[TIER_OF[i % 4]];
    const a = RAY0 + i * SPACING + (rnd() - 0.5) * SPACING * 0.5;
    const len = at(T.len), wid = at(T.wid);
    rays.push(new THREE.Vector4(Math.cos(a), Math.sin(a), len, wid));
    inten.push(at(T.i));
  }
  return { rays, inten };
}

// Lens ghosts: [axis position (1 = sun, 0 = centre, <0 = opposite side), radius, shape (0 disc, 1 hexagon), tint]
const GHOSTS = [
  [0.42, 0.022, 1, [0.35, 0.85, 1.0]],
  [-0.28, 0.05, 0, [0.55, 0.45, 1.0]],
  [-0.62, 0.032, 1, [1.0, 0.72, 0.38]],
  [-1.05, 0.085, 0, [0.4, 1.0, 0.85]],
];

const VERT = `
  attribute vec2 aCorner;
  attribute vec4 aInfo;    // x: 0 main glare / 1 ghost, y: axis position, z: radius, w: shape
  attribute vec3 aTint;
  uniform vec3 uSunDir;
  uniform float uOn;
  varying vec2 vP;
  varying vec4 vInfo;
  varying vec3 vTint;
  void main(){
    // the sun as a direction at infinity, in clip space
    vec4 sc = projectionMatrix * vec4(mat3(viewMatrix) * uSunDir, 0.0);
    vec2 sun = sc.xy / max(sc.w, 1e-4);
    float aspect = projectionMatrix[1][1] / projectionMatrix[0][0];
    bool ghost = aInfo.x > 0.5;
    vec2 c = ghost ? sun * aInfo.y : sun;
    vec2 off = aCorner * (ghost ? aInfo.z : ${MAIN_SIZE.toFixed(3)});
    vP = off;
    vInfo = aInfo;
    vTint = aTint;
    gl_Position = vec4(c.x + off.x / aspect, c.y + off.y, 0.0, 1.0);
    if (sc.w <= 0.0 || uOn < 0.5) gl_Position = vec4(0.0, 0.0, 2.0, 1.0); // hidden / behind the camera: clipped away
  }`;

const FRAG = `
  #define NR ${NRAYS}
  uniform vec4 uRays[NR];  // xy: direction, z: decay length, w: width
  uniform float uRayI[NR];
  uniform vec3 uCore;      // sun colour x visibility (white by day, gold at golden hour)
  uniform vec3 uHaloTint;  // cyan-white by day
  uniform float uRot;      // starburst rotation (slow, with camera yaw / roll)
  uniform float uTime;
  uniform float uGhost;    // ghost strength (fades when the sun leaves the screen)
  varying vec2 vP;
  varying vec4 vInfo;
  varying vec3 vTint;
  void main(){
    vec2 p = vP;
    float r = length(p);
    vec3 col;
    if (vInfo.x < 0.5) {
      // blinding core: a white disc with a soft edge and a tight glow (HDR, blooms), an inner glow whose
      // blue/green spread wider (faint cyan fringe), a cyan-white halo and a wide glow lifting the sky around
      float core = (1.0 - smoothstep(0.016, 0.034, r)) * 34.0 + exp(-r * r / (0.055 * 0.055)) * 8.0;
      vec3 inner = exp(-r / (vec3(0.82, 0.95, 1.12) * 0.07)) * 2.4;
      vec3 halo = exp(-r / (vec3(0.86, 1.0, 1.18) * 0.24));
      float wide = exp(-r / 0.45) * 0.3;
      // starburst: only the 5 spikes nearest in angle can reach this pixel
      float s = 0.0;
      if (r > 0.002) {
        float cr = cos(uRot), sr = sin(uRot);
        vec2 q = vec2(cr * p.x + sr * p.y, -sr * p.x + cr * p.y);
        float k = floor((atan(q.y, q.x) - ${RAY0.toFixed(4)}) / ${SPACING.toFixed(6)} + 0.5);
        for (int j = -2; j <= 2; j++) {
          int idx = int(mod(k + float(j) + float(NR), float(NR)));
          vec4 R = uRays[idx];
          float along = dot(q, R.xy);
          float perp = q.x * R.y - q.y * R.x;
          float w = R.w * (0.15 + 0.85 * exp(-along / (0.6 * R.z))); // wedge: broad at the core, thin tip
          float x2 = perp * perp / (w * w);
          float flicker = 0.92 + 0.08 * sin(uTime * 0.7 + float(idx) * 1.9);
          s += uRayI[idx] * flicker * (exp(-x2) + exp(-x2 * 0.25) * 0.4) * exp(-max(along, 0.0) / R.z) * step(0.0, along);
        }
        s *= smoothstep(0.004, 0.025, r); // rays grow out of the core, not on top of it
      }
      col = uCore * (core + s * 2.2) + uHaloTint * (inner + halo + wide) * dot(uCore, vec3(0.333));
      col *= 1.0 - smoothstep(${(MAIN_SIZE * 0.6).toFixed(3)}, ${MAIN_SIZE.toFixed(3)}, r); // fade well inside the quad
      // a touch of dither: the wide soft glow must not band after the 8-bit output
      col *= 1.0 + (fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) - 0.5) * 0.03;
    } else {
      // lens ghost: soft disc or hexagon with a slightly brighter rim
      float R = vInfo.z;
      float d = r;
      if (vInfo.w > 0.5) {
        vec2 a = abs(p);
        d = max(a.x * 0.866 + a.y * 0.5, a.y);
      }
      float body = 1.0 - smoothstep(R * 0.82, R, d);
      float rim = smoothstep(R * 0.55, R * 0.95, d) * body;
      col = vTint * (body * 0.6 + rim * 0.8) * 0.055 * uGhost * dot(uCore, vec3(0.333));
    }
    gl_FragColor = vec4(col, 1.0);
  }`;

// depth-only probe at the far plane, offset around the sun; drawn last among opaques
const PROBE_VERT = `
  uniform vec3 uSunDir;
  uniform vec2 uOffset;
  uniform float uOn;
  void main(){
    vec4 sc = projectionMatrix * vec4(mat3(viewMatrix) * uSunDir, 0.0);
    vec2 sun = sc.xy / max(sc.w, 1e-4);
    float aspect = projectionMatrix[1][1] / projectionMatrix[0][0];
    vec2 off = uOffset + position.xy * 0.0035;
    gl_Position = vec4(sun.x + off.x / aspect, sun.y + off.y, 0.9999999, 1.0);
    if (sc.w <= 0.0 || uOn < 0.5) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
  }`;

export class SunGlare {
  constructor(scene, { renderer, camera, env }) {
    this.scene = scene;
    this.camera = camera;
    this.env = env;
    this.strength = 1; // tunable: overall glare brightness
    this.vis = 0; // smoothed visibility 0..1
    this.terrainVis = 1;
    this.probeVis = 1;

    // ---- glare quads: main + ghosts, one geometry, one draw call
    const quads = 1 + GHOSTS.length;
    const corner = new Float32Array(quads * 8), info = new Float32Array(quads * 16), tint = new Float32Array(quads * 12);
    const pos = new Float32Array(quads * 12), index = [];
    for (let q = 0; q < quads; q++) {
      const g = q === 0 ? null : GHOSTS[q - 1];
      const cs = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
      for (let v = 0; v < 4; v++) {
        const k = q * 4 + v;
        corner[k * 2] = cs[v][0]; corner[k * 2 + 1] = cs[v][1];
        info.set(g ? [1, g[0], g[1], g[2]] : [0, 1, MAIN_SIZE, 0], k * 4);
        tint.set(g ? g[3] : [1, 1, 1], k * 3);
      }
      index.push(q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); // unused (placed in the shader)
    geo.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
    geo.setAttribute('aInfo', new THREE.BufferAttribute(info, 4));
    geo.setAttribute('aTint', new THREE.BufferAttribute(tint, 3));
    geo.setIndex(index);
    const { rays, inten } = makeRays();
    this.uniforms = {
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uRays: { value: rays },
      uRayI: { value: inten },
      uCore: { value: new THREE.Color() },
      uHaloTint: { value: new THREE.Color() },
      uRot: { value: 0 },
      uTime: { value: 0 },
      uGhost: { value: 0 },
      uOn: { value: 0 },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, fog: false, toneMapped: false,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 100000;
    scene.add(this.mesh); // always submitted (so it compiles while loading); collapsed by uOn when hidden
    this.active = false;

    // ---- GPU occlusion probes (WebGL2 queries), for occluders the terrain march can't see
    this.gl = renderer?.getContext?.() || null;
    const canQuery = !!(this.gl && typeof this.gl.createQuery === 'function' && typeof WebGL2RenderingContext !== 'undefined' && this.gl instanceof WebGL2RenderingContext);
    this.probes = [];
    if (canQuery) {
      const gl = this.gl;
      const pgeo = new THREE.PlaneGeometry(2, 2);
      for (const off of PROBE_OFFSETS) {
        const mat = new THREE.ShaderMaterial({
          uniforms: { uSunDir: this.uniforms.uSunDir, uOffset: { value: new THREE.Vector2(off[0], off[1]) }, uOn: { value: 0 } },
          vertexShader: PROBE_VERT, fragmentShader: 'void main(){ gl_FragColor = vec4(0.0); }',
          colorWrite: false, depthWrite: false, depthTest: true, fog: false,
        });
        const m = new THREE.Mesh(pgeo, mat);
        m.frustumCulled = false;
        m.renderOrder = 100000; // after every opaque object (it is opaque itself)
        const probe = { mesh: m, on: mat.uniforms.uOn, query: gl.createQuery(), pending: false, issued: false, visible: true };
        m.onBeforeRender = (r, s, cam) => {
          if (!probe.on.value || probe.pending || cam !== this.camera) return;
          gl.beginQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE, probe.query);
          probe.issued = true;
        };
        m.onAfterRender = () => {
          if (!probe.issued) return;
          gl.endQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE);
          probe.issued = false;
          probe.pending = true;
        };
        scene.add(m);
        this.probes.push(probe);
      }
    }

    this._warm = new THREE.Color(1.1, 0.72, 0.42);
    this._yaw = null; // last camera yaw (the starburst spin integrates wrapped yaw changes: no jump at +-PI)
    this._marchPos = new THREE.Vector3(1e9, 0, 0); // where / when the terrain was last marched
    this._marchSun = new THREE.Vector3();
    this._marchAge = 1e9;
    this._spin = 0;
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._up = new THREE.Vector3();
  }

  // Terrain occlusion: march the sun's azimuth from the camera, track the highest terrain elevation angle
  // and compare it with the sun's: returns 0..1 with a soft edge about the size of the sun disc.
  terrainVisibility(cam, sunDir) {
    // inside a race course's tunnel (the march would see the trench the tube sits in as open sky)
    if (world.regionAt(cam.x, cam.z)?.insideTunnel?.(cam.x, cam.y, cam.z)) return 0;
    const hx = sunDir.x, hz = sunDir.z, hl = Math.hypot(hx, hz);
    if (hl < 1e-4) return 1; // sun straight overhead
    const dx = hx / hl, dz = hz / hl;
    const sunSlope = sunDir.y / hl;
    let maxSlope = -1e9;
    const k = Math.pow(MARCH_DIST / 2, 1 / (MARCH_STEPS - 1));
    let s = 2;
    for (let i = 0; i < MARCH_STEPS; i++, s *= k) {
      const slope = (world.height(cam.x + dx * s, cam.z + dz * s) - cam.y) / s;
      if (slope > maxSlope) {
        maxSlope = slope;
        if (Math.atan(maxSlope) - Math.atan(sunSlope) > 0.02) return 0; // clearly hidden: stop early
      }
    }
    const margin = Math.atan(sunSlope) - Math.atan(maxSlope); // radians the sun clears the skyline by
    const t = Math.min(1, Math.max(0, (margin + 0.006) / 0.016));
    return t * t * (3 - 2 * t);
  }

  update(dt, camera, env) {
    this.camera = camera;
    const u = this.uniforms;
    u.uSunDir.value.copy(env.sunDir);
    u.uTime.value += dt;

    // how much clear sun there is (elevation, night, cloud / snow / mist) — from the sky
    const sky = env.sunVisible ?? Math.max(0, 1 - Math.max(env.snow, env.cloud)) * (env.dayFactor ?? 1);
    const nightCut = 1 - (env.nightFactor ?? 0);
    let target = sky * nightCut * (env.sunDir.y > -0.02 ? 1 : 0);
    // inside a cloud (whiteout fog added on top of the weather's) the sun is swallowed
    const fogDensity = this.scene.fog?.near ?? 0;
    target *= Math.exp(-Math.max(0, fogDensity - 0.002) * 1500);

    // sun position on screen (from the camera's current orientation)
    camera.getWorldQuaternion(this._q).invert();
    const v = this._v.copy(env.sunDir).applyQuaternion(this._q);
    const P = camera.projectionMatrix.elements;
    let onScreen = false, ndcX = 0, ndcY = 0;
    if (v.z < -1e-3) {
      ndcX = (P[0] * v.x + P[8] * v.z) / -v.z;
      ndcY = (P[5] * v.y + P[9] * v.z) / -v.z;
      const aspect = P[5] / P[0];
      // never draw once the sun is further off-screen than the glare reaches
      onScreen = Math.abs(ndcX) < 1 + (MAIN_SIZE * 0.75) / aspect && Math.abs(ndcY) < 1 + MAIN_SIZE * 0.75;
    }
    if (!onScreen) target = 0;

    // terrain occlusion (CPU, ~0.3 ms per march in the ski area): re-marched only when the camera moved
    // > 4 m or the sun ~0.1 deg since the last march, or every 0.5 s (the 0.15 s fade hides the steps)
    this._marchAge += dt;
    if (target > 0.001 && (this._marchPos.distanceToSquared(camera.position) > 16 || this._marchSun.distanceToSquared(env.sunDir) > 3e-6 || this._marchAge > 0.5)) {
      this.terrainVis = this.terrainVisibility(camera.position, env.sunDir);
      this._marchPos.copy(camera.position);
      this._marchSun.copy(env.sunDir);
      this._marchAge = 0;
    }
    target *= this.terrainVis;

    // GPU probes: collect finished queries, then (re)issue while the sun is inside the frame
    const inside = onScreen && Math.abs(ndcX) < 0.97 && Math.abs(ndcY) < 0.97;
    if (this.probes.length) {
      const gl = this.gl;
      let n = 0, seen = 0;
      for (const p of this.probes) {
        if (p.pending && gl.getQueryParameter(p.query, gl.QUERY_RESULT_AVAILABLE)) {
          p.visible = gl.getQueryParameter(p.query, gl.QUERY_RESULT) > 0;
          p.pending = false;
        }
        p.on.value = inside && target > 0.001 ? 1 : 0;
        if (!p.on.value && !p.pending) p.visible = true; // stale result: assume visible until re-measured
        if (inside) { n++; if (p.visible) seen++; }
      }
      this.probeVis = inside && n ? seen / n : 1;
      target *= this.probeVis;
    }

    // starburst turns slowly with the camera's yaw (continuous, still when looking straight up) and roll
    camera.getWorldDirection(this._fwd);
    this._up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    const yaw = Math.atan2(this._fwd.x, this._fwd.z), level = Math.hypot(this._fwd.x, this._fwd.z);
    if (this._yaw !== null) {
      let dy = yaw - this._yaw;
      dy -= Math.round(dy / (Math.PI * 2)) * Math.PI * 2;
      this._spin = (this._spin + dy * 0.22 * level) % (Math.PI * 2);
    }
    this._yaw = yaw;
    const right = this._v.crossVectors(this._fwd, this._up); // camera right
    u.uRot.value = this._spin - Math.atan2(right.y, this._up.y);

    // smooth (~0.15 s) so occlusion edges and weather fade instead of popping
    const tau = target > this.vis ? FADE_TIME : FADE_TIME * 0.5; // hide a little faster than reveal
    this.vis += (target - this.vis) * (1 - Math.exp(-dt / tau));
    if (dt === 0) this.vis = target; // paused / look-dev jumps: settle immediately
    const vis = this.vis;
    this.active = vis > 0.003 && onScreen;
    u.uOn.value = this.active ? 1 : 0;
    if (!this.active) return;

    // colour: sun colour (white by day, gold toward sunset), smaller and dimmer when the sun is low
    const sunH = env.sunDir.y;
    const low = Math.min(1, Math.max(0, (sunH + 0.02) / 0.22));
    const glowCol = env.sunGlowColor || { r: 1, g: 0.97, b: 0.93 };
    u.uCore.value.setRGB(glowCol.r, glowCol.g, glowCol.b).multiplyScalar(vis * (0.45 + 0.55 * low) * this.strength);
    // halo tint: the logo's cyan-white by day, warm at golden hour
    u.uHaloTint.value.setRGB(0.42, 0.78, 1.25).lerp(this._warm, 1 - low);

    // ghosts fade as the sun nears the frame edge (and vanish off-screen)
    const edge = Math.max(Math.abs(ndcX), Math.abs(ndcY));
    u.uGhost.value = 1 - Math.min(1, Math.max(0, (edge - 0.75) / 0.25));
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
    for (const p of this.probes) {
      this.scene.remove(p.mesh);
      p.mesh.material.dispose();
      if (this.gl) this.gl.deleteQuery(p.query);
    }
    if (this.probes[0]) this.probes[0].mesh.geometry.dispose();
    this.probes = [];
  }
}
