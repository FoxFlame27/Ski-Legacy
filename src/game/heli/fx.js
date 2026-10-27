// Small shared effects for the heli: additive glow points (lamps without THREE lights), the rotor
// downwash blowing powder off the snow, and the red smoke flares that mark the heli drop zones.
import * as THREE from 'three';

const _v = new THREE.Vector3(), _sv = { x: 0, y: 0, z: 0 };

/**
 * Lamps as additive glow points: a hot core with a soft halo, never smaller than `minPx` on screen.
 * colors are written per frame (black = off); sizes are in metres.
 * @param {THREE.Vector3[]} positions  (local to whatever the points are added to)
 * @param {number[]} sizes
 */
export function glowPoints(positions, sizes, minPx = 3) {
  const n = positions.length;
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(n * 3);
  positions.forEach((p, i) => pos.set([p.x, p.y, p.z], i * 3));
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('size', new THREE.BufferAttribute(Float32Array.from(sizes), 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uScale: { value: 800 }, uMinPx: { value: minPx } },
    vertexShader: `attribute vec3 color; attribute float size; uniform float uScale; uniform float uMinPx; varying vec3 vColor;
      void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv; vColor = color;
        float on = max(max(color.r, color.g), color.b);
        gl_PointSize = on > 0.002 ? clamp(size * uScale / -mv.z, uMinPx, 220.0) : 0.0; }`,
    fragmentShader: `varying vec3 vColor;
      void main(){ float r = length(gl_PointCoord - 0.5) * 2.0;
        float a = (1.0 - smoothstep(0.0, 0.32, r)) * 1.6 + exp(-r * r * 5.0) * 0.55;
        a *= 1.0 - smoothstep(0.82, 1.0, r);
        if (a < 0.004) discard;
        gl_FragColor = vec4(vColor * a, 1.0); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.renderOrder = 8;
  pts.userData.color = geo.attributes.color;
  return pts;
}

/** Keep glow points the same apparent size whatever the screen and field of view. */
export function glowScale(points, camera) {
  points.material.uniforms.uScale.value = (innerHeight * Math.min(2, devicePixelRatio)) / (2 * Math.tan((camera.fov * Math.PI) / 360));
}

// ------------------------------------------------------------------ billboard puffs
// Soft round puffs on instanced camera-facing quads (no point-size limit up close), lit by the scene
// light, darker toward their base so a white cloud still reads against white snow.
class Puffs {
  constructor(scene, { max, lit, shade, opacity, order = 5, rise = 0.8 }) {
    this.max = max; this.rise = rise;
    this.uniforms = { uLight: { value: new THREE.Color(1, 1, 1) }, uLit: { value: new THREE.Color(lit) }, uShade: { value: new THREE.Color(shade) }, uOpacity: { value: opacity } };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: `attribute vec4 aPuff; varying vec2 vUv; varying float vA; varying float vSeed;
        void main(){ vUv = uv; vSeed = aPuff.z;
          vec4 mv = modelViewMatrix * vec4(instanceMatrix[3].xyz, 1.0);
          float c = cos(aPuff.y), si = sin(aPuff.y);
          mv.xy += vec2(position.x * c - position.y * si, position.x * si + position.y * c) * aPuff.x;
          vA = aPuff.w * smoothstep(2.0, 10.0, -mv.z); // never a white wall right in front of the lens
          gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform vec3 uLight; uniform vec3 uLit; uniform vec3 uShade; uniform float uOpacity; varying vec2 vUv; varying float vA; varying float vSeed;
        void main(){ vec2 c = vUv - 0.5; float r = length(c) * 2.0;
          float n = sin((vUv.x + vSeed) * 12.0) * sin((vUv.y - vSeed * 1.7) * 10.0) * 0.14 + sin((vUv.x - vSeed) * 27.0 + vUv.y * 19.0) * 0.05;
          float a = (1.0 - smoothstep(0.2, 1.0, r + n)) * vA * uOpacity;
          if (a < 0.008) discard;
          gl_FragColor = vec4(mix(uShade, uLit, smoothstep(-0.45, 0.35, c.y + n)) * uLight, a); }`,
      transparent: true, depthWrite: false,
    });
    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, max);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = order;
    this.attr = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.mesh.geometry.setAttribute('aPuff', this.attr);
    this.p = new Float32Array(max * 3); this.v = new Float32Array(max * 3);
    this.age = new Float32Array(max).fill(1e9); this.life = new Float32Array(max).fill(1);
    this.s0 = new Float32Array(max); this.s1 = new Float32Array(max);
    this.next = 0;
    this.m = new THREE.Matrix4();
    this.mesh.visible = false;
    this.alive = 0;
    scene.add(this.mesh);
  }

  spawn(x, y, z, vx, vy, vz, s0, s1, life) {
    const i = this.next; this.next = (i + 1) % this.max;
    this.p[i * 3] = x; this.p[i * 3 + 1] = y; this.p[i * 3 + 2] = z;
    this.v[i * 3] = vx; this.v[i * 3 + 1] = vy; this.v[i * 3 + 2] = vz;
    this.s0[i] = s0; this.s1[i] = s1; this.age[i] = 0; this.life[i] = life;
  }

  // drag: horizontal slow-down (1/s); wind: { x, z } m/s the puffs drift with as they age
  update(dt, light, drag, wind) {
    if (light) this.uniforms.uLight.value.copy(light);
    let alive = 0;
    const A = this.attr.array, m = this.m, P = this.p, V = this.v, kd = Math.exp(-dt * drag);
    for (let i = 0; i < this.max; i++) {
      const life = this.life[i], age = (this.age[i] += dt);
      if (age > life) { A[i * 4 + 3] = 0; continue; }
      alive++;
      const f = age / life;
      V[i * 3] = V[i * 3] * kd + (wind ? wind.x * (1 - kd) * f : 0);
      V[i * 3 + 2] = V[i * 3 + 2] * kd + (wind ? wind.z * (1 - kd) * f : 0);
      V[i * 3 + 1] *= Math.exp(-dt * this.rise);
      P[i * 3] += V[i * 3] * dt; P[i * 3 + 1] += V[i * 3 + 1] * dt; P[i * 3 + 2] += V[i * 3 + 2] * dt;
      A[i * 4] = this.s0[i] + (this.s1[i] - this.s0[i]) * (1 - (1 - f) * (1 - f));
      A[i * 4 + 1] = i * 1.7 + age * 0.25;
      A[i * 4 + 2] = (i * 0.37) % 1;
      A[i * 4 + 3] = Math.min(1, age * 5) * (1 - f) * (1 - f);
      m.makeTranslation(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
      this.mesh.setMatrixAt(i, m);
    }
    this.alive = alive;
    this.mesh.visible = alive > 0;
    if (alive) { this.mesh.instanceMatrix.needsUpdate = true; this.attr.needsUpdate = true; }
  }
}

/**
 * Rotor downwash: a cloud of powder blown out from under the rotor when it is close to the snow, plus
 * fine snow grains through the shared spray.
 */
export class Downwash {
  constructor(scene) {
    this.puffs = new Puffs(scene, { max: 300, lit: 0xffffff, shade: 0xc9d4e6, opacity: 0.62, order: 4, rise: 0.6 });
    this.acc = 0; this.accS = 0;
  }

  /**
   * @param {THREE.Vector3} hub  the point on the snow under the rotor hub
   * @param {number} k           strength 0..1 (rotor speed x how close the rotor is to the snow)
   * @param {THREE.Vector3} vel  the helicopter's velocity (the cloud is left behind)
   * @param {number} radius      rotor radius (m)
   * @param {number} [pad]       0..1 over the cleared helipad (only a dusting)
   * @param {object} [spray]     src/fx/snowfx.js Spray for the fine grains
   */
  update(dt, hub, k, vel, radius, light, pad = 0, spray = null) {
    if (k > 0.02) {
      const amount = k * (1 - 0.8 * pad);
      this.acc += dt * 105 * amount;
      while (this.acc >= 1) {
        this.acc -= 1;
        const a = Math.random() * Math.PI * 2, r = radius * (0.2 + Math.random() * 0.75), out = (6 + Math.random() * 9) * (0.45 + 0.55 * k);
        const s0 = 1.8 + Math.random() * 2.2;
        this.puffs.spawn(hub.x + Math.cos(a) * r, hub.y + 0.5 + Math.random() * 0.9, hub.z + Math.sin(a) * r,
          Math.cos(a) * out + vel.x * 0.3, 0.8 + Math.random() * 3.2 * k, Math.sin(a) * out + vel.z * 0.3,
          s0, s0 * (2.8 + Math.random() * 1.8), 1.8 + Math.random() * 1.8);
      }
      if (spray) {
        this.accS += dt * 120 * amount;
        const n = Math.floor(this.accS);
        this.accS -= n;
        for (let i = 0; i < n; i++) {
          const a = Math.random() * Math.PI * 2, r = radius * (0.4 + Math.random() * 0.7);
          _v.set(hub.x + Math.cos(a) * r, hub.y + 0.1, hub.z + Math.sin(a) * r);
          const out = 6 + k * 8 * Math.random();
          _sv.x = Math.cos(a) * out + vel.x * 0.4; _sv.y = 1 + Math.random() * 2 * k; _sv.z = Math.sin(a) * out + vel.z * 0.4;
          spray.emit(_v, _sv, 1, 1.2, 0.18 + Math.random() * 0.22, 0.8 + Math.random() * 0.7);
        }
      }
    }
    this.puffs.update(dt, light, 1.1, null);
  }
}

// ------------------------------------------------------------------ drop-zone smoke flares
// Red smoke rising from a flare in the snow and drifting downwind: a beacon you can spot from far away.
export class SmokeFlare {
  constructor(scene) {
    this.puffs = new Puffs(scene, { max: 80, lit: 0xf26a4b, shade: 0xb4402e, opacity: 0.42, order: 5, rise: 0.1 });
    this.acc = 0; this.t = 0;
    // the burning flare itself: a flickering red-orange glow on the snow
    this.glow = glowPoints([new THREE.Vector3(0, 0.25, 0)], [2.2], 3);
    this.glow.visible = false;
    scene.add(this.glow);
  }

  /** at: { x, y, z } flare position (or null to let the smoke die out), wind: { x, z } m/s */
  update(dt, at, wind, light, camera) {
    this.t += dt;
    this.glow.visible = !!at;
    if (at) {
      this.glow.position.set(at.x, at.y, at.z);
      const k = 5 + Math.sin(this.t * 23) * 1.2 + Math.sin(this.t * 37 + 1) * 0.8, c = this.glow.userData.color.array;
      c[0] = k; c[1] = k * 0.32; c[2] = k * 0.12;
      this.glow.userData.color.needsUpdate = true;
      if (camera) glowScale(this.glow, camera);
    }
    if (at) {
      // a thin column at the flare, spreading into a wide, faint plume downwind (seen from far away)
      this.acc += dt * 6.5;
      while (this.acc >= 1) {
        this.acc -= 1;
        this.puffs.spawn(at.x + (Math.random() - 0.5) * 0.4, at.y + 0.3, at.z + (Math.random() - 0.5) * 0.4, 0, 2.8, 0, 0.8 + Math.random() * 0.4, 10 + Math.random() * 5, 9 + Math.random() * 4);
      }
    }
    this.puffs.update(dt, light, 0.25, wind);
  }
}
