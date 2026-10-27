// Snowmaking: at dusk and at night the fan guns along the pistes blow a plume of fine snow over the run.
// GPU-animated points, one draw call per running gun (the guns nearest you): every particle leaves the fan
// inside a narrow cone, flies out on a jet that drag slows quickly, sinks, drifts with the breeze and spreads
// into a soft cloud that fades out downwind. No per-frame CPU work beyond picking which guns run.
import * as THREE from 'three';

const N = 720;          // particles per plume
const MAX_GUNS = 5;     // plumes running at once
const RANGE = 330;      // m: guns further away rest
const LIFE = 3.6;       // s a particle lives

const VERT = /* glsl */`
  uniform float uTime;
  uniform float uScale;
  uniform float uBright;
  uniform vec3 uPos;
  uniform vec3 uDir;
  uniform vec3 uWind;
  attribute vec4 aSeed;
  varying float vAlpha;
  void main() {
    float age = fract(uTime / ${LIFE.toFixed(2)} + aSeed.x);
    float t = age * ${LIFE.toFixed(2)};
    // a random direction inside the fan's cone
    vec3 side = normalize(cross(uDir, vec3(0.0, 1.0, 0.0)));
    vec3 up = normalize(cross(side, uDir));
    float a = aSeed.y * 6.2831, r = sqrt(aSeed.z) * 0.2;
    vec3 v0 = normalize(uDir + side * cos(a) * r + up * sin(a) * r) * (13.0 + aSeed.w * 7.0);
    // the jet slows under drag (x = v0 (1 - e^-kt) / k); the fine snow then sinks, drifts downwind and
    // diffuses (every particle wanders off its own way), so the cloud spreads instead of bunching up
    const float k = 1.05;
    vec3 wander = vec3(fract(aSeed.y * 13.7) - 0.5, fract(aSeed.z * 7.31) - 0.62, fract(aSeed.w * 11.1) - 0.5);
    vec3 p = uPos + v0 * (1.0 - exp(-k * t)) / k + vec3(0.0, -0.45, 0.0) * t * t + uWind * (t * t * 0.5) + wander * (t * 2.4);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    float px = mix(0.55, 4.2, smoothstep(0.0, 1.0, age)) * uScale / max(0.5, -mv.z);
    gl_PointSize = min(72.0, px);
    float far = 1.0 - smoothstep(180.0, ${RANGE.toFixed(1)}, -mv.z);
    // (sprites capped in size near the camera keep their density, but no lone giant discs)
    vAlpha = smoothstep(0.0, 0.05, age) * (1.0 - smoothstep(0.3, 1.0, age)) * uBright * far * min(1.0, 72.0 / px);
  }`;
const FRAG = /* glsl */`
  uniform vec3 uColor;
  varying float vAlpha;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float a = (1.0 - smoothstep(0.0, 0.25, dot(c, c))) * vAlpha * 0.16;
    if (a < 0.003) discard;
    gl_FragColor = vec4(uColor, a);
  }`;

export class Snowmaking {
  /**
   * @param {THREE.Scene|THREE.Group} parent
   * @param {Array<{pos: THREE.Vector3, dir: THREE.Vector3}>} guns  nozzle position + blowing direction
   */
  constructor(parent, guns) {
    this.guns = guns;
    const geo = new THREE.BufferGeometry();
    const seed = new Float32Array(N * 4);
    for (let i = 0; i < N * 4; i++) seed[i] = Math.random();
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3)); // (positions come from the shader)
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.time = { value: 0 };
    this.scale = { value: 600 };
    this.color = { value: new THREE.Color() };
    this.wind = { value: new THREE.Vector3(0.9, 0, 0.5) };
    this.slots = [];
    for (let i = 0; i < MAX_GUNS; i++) {
      const mat = new THREE.ShaderMaterial({
        uniforms: { uTime: this.time, uScale: this.scale, uColor: this.color, uWind: this.wind, uBright: { value: 0 }, uPos: { value: new THREE.Vector3() }, uDir: { value: new THREE.Vector3(1, 0, 0) } },
        vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false,
      });
      const pts = new THREE.Points(geo, mat);
      pts.frustumCulled = false;
      pts.visible = false;
      pts.renderOrder = 2;
      // point size in pixels per metre at 1 m: the viewport height over the field of view
      pts.onBeforeRender = (renderer, scene, camera) => {
        const h = renderer.getRenderTarget()?.height || renderer.domElement.height;
        this.scale.value = h / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov || 60) / 2));
      };
      parent.add(pts);
      this.slots.push({ pts, gun: null });
    }
  }

  /** dt: s; viewer: player position; on: 0..1 how dark it is (the guns run from dusk) */
  update(dt, viewer, on) {
    this.time.value = (this.time.value + dt) % (LIFE * 250); // (wraps on a whole number of lives: no pop)
    const run = THREE.MathUtils.smoothstep(on, 0.45, 0.75);
    // mist in the floodlights / moonlight: pale blue-white, a little dimmer the darker it gets
    this.color.value.setRGB(0.62, 0.68, 0.78).multiplyScalar(1.15 - on * 0.45);
    const near = run > 0.01 ? this.guns
      .map((g) => ({ g, d: g.pos.distanceToSquared(viewer) }))
      .filter((q) => q.d < RANGE * RANGE)
      .sort((a, b) => a.d - b.d)
      .slice(0, MAX_GUNS) : [];
    this.slots.forEach((s, i) => {
      const q = near[i];
      s.pts.visible = !!q;
      if (!q) return;
      const u = s.pts.material.uniforms;
      u.uDir.value.copy(q.g.dir).normalize();
      u.uPos.value.copy(q.g.pos).addScaledVector(u.uDir.value, 0.7);
      u.uBright.value = run;
    });
  }
}
