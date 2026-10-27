// Helmet lamp for night skiing: a small LED lamp clipped to the front of the helmet, just above the goggles (the
// spot is measured on each character's own head mesh), that turns with the head (in first person it follows the
// view) and lights the snow some metres ahead.
//  - one THREE.SpotLight (it is always in the scene, so switching it never recompiles a shader) with a beam
//    pattern texture: a hot centre, a wide dim spill with a faint reflector ring, a slightly warmer rim,
//    physical 1/d^2 falloff (snow close by brighter than far away);
//  - shadows (skiers, trees, your own hands) on the High and Ultra presets only;
//  - the beam itself: light scattered in the air, an additive cone whose depth is integrated per pixel (a few
//    samples through the cone, soft profile, 1/d^2, drifting noise, soft where it meets the snow): faint in clear
//    air, a real shaft of light in falling snow or mist;
//  - snowflakes lit inside the beam (points on a world-anchored lattice round the lamp, more as it snows harder);
//  - the lamp body (housing, bezel, lens) on the helmet in third person, the lens glowing (blooms) when it faces
//    you, and its battery pack on the back of the helmet with a small red rear light.
import * as THREE from 'three';
import { quality, onQualityChange } from '../engine/quality.js';

const ANGLE = 0.7;            // spot cone half-angle (rad): the dim spill; the hot centre is ~a third of it
const RANGE = 42;             // m (soft cut-off)
const INTENSITY = 250;        // candela-ish (three.js physical units, falls off as 1/d^2)
const PITCH = 0.06;           // rad below where the head looks (third person)
const PITCH_FP = 0.1;         // rad below the view (first person)
// third person: the beam's angle to the snow under the skier stays within these (rad below the slope): it follows
// the head, but never lights only the ski tips or shoots over the snow
const SLOPE_MIN = 0.07, SLOPE_MAX = 0.24;
const BEAM_LEN = 14;          // m of visible beam
const HAZE_TAN = Math.tan(0.5); // the visible haze cone: the core and the inner spill (the outer spill is too dim)
const COLOR = new THREE.Color(1.0, 0.97, 0.92); // LED white, a touch warmer than daylight
// where the lamp sits on the helmet, from the head bone (base of the skull): up, forward (m) (used only when the
// helmet can't be measured on the character's mesh)
const MOUNT = { up: 0.19, fwd: 0.05 };
const REAR = { up: 0.15, fwd: -0.105 }; // the battery pack on the back of the helmet

// radial beam profile, s = tan(off-axis angle) / tan(ANGLE): 1 at the centre, 0 at the cone's edge
const PROFILE_GLSL = `
  float hlProfile(float s) {
    float r = clamp(1.0 - s * s, 0.0, 1.0);
    return 0.6 * exp(-s * s * 9.0) + 0.4 * r * r;
  }`;
function profile(s) {
  const r = Math.max(0, 1 - s * s);
  return 0.6 * Math.exp(-s * s * 9) + 0.4 * r * r;
}

// beam pattern projected by the spot light (UV 0..1 spans the cone's square: the cone is the inscribed circle)
function cookieTexture() {
  const N = 128, data = new Uint8Array(N * N * 4);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = ((i + 0.5) / N) * 2 - 1, y = ((j + 0.5) / N) * 2 - 1, s = Math.hypot(x, y), a = Math.atan2(y, x);
      let v = profile(s);
      v += 0.07 * Math.exp(-(((s - 0.34) / 0.045) ** 2)); // reflector ring
      v *= 1 + 0.035 * Math.sin(a * 5 + 1.3) * Math.sin(a * 3 - 0.4) * Math.min(1, s * 3); // not a perfect disc
      v *= 1 - Math.min(1, Math.max(0, (s - 0.94) / 0.06)); // exactly 0 at the rim
      const warm = Math.min(1, Math.max(0, (s - 0.3) / 0.6)); // the spill a little warmer (LED phosphor)
      const k = (i + j * N) * 4;
      data[k] = Math.round(Math.min(1, v) * 255);
      data[k + 1] = Math.round(Math.min(1, v * (1 - 0.05 * warm)) * 255);
      data[k + 2] = Math.round(Math.min(1, v * (1 - 0.14 * warm)) * 255);
      data[k + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

const NOISE_GLSL = `
  float hlHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float hlNoise(vec3 x) {
    vec3 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hlHash(i), hlHash(i + vec3(1, 0, 0)), f.x), mix(hlHash(i + vec3(0, 1, 0)), hlHash(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(hlHash(i + vec3(0, 0, 1)), hlHash(i + vec3(1, 0, 1)), f.x), mix(hlHash(i + vec3(0, 1, 1)), hlHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
  }`;

// light scattered in the air of the beam: per pixel, the ray's stretch inside the cone (analytic) above the snow
// (a plane under the skier), integrated in a few samples bunched toward the near end (no jitter: smooth, no grain)
// (inside: the variant drawn when the camera is inside the beam, its back faces without depth test)
function beamMaterial(u, inside) {
  return new THREE.ShaderMaterial({
    uniforms: u,
    vertexShader: `
      uniform float uActive;
      varying vec3 vW;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
        if (uActive < 0.5) gl_Position = vec4(0.0, 0.0, 2.0, 1.0); // (the other variant draws this frame)
      }`,
    fragmentShader: `
      uniform vec3 uApex, uAxis, uColor, uDrift;
      uniform float uTan, uLen, uI, uTime, uNoise, uNoise2, uG, uGain;
      uniform vec4 uGround;
      uniform int uSteps;
      varying vec3 vW;
      ${PROFILE_GLSL}
      ${NOISE_GLSL}
      void main() {
        vec3 ro = cameraPosition, rd = normalize(vW - ro);
        float c2 = 1.0 / (1.0 + uTan * uTan);
        vec3 co = ro - uApex;
        float dv = dot(rd, uAxis), cv = dot(co, uAxis);
        float a = dv * dv - c2, b = dv * cv - dot(rd, co) * c2, c = cv * cv - dot(co, co) * c2;
        float disc = b * b - a * c;
        if (disc <= 0.0 || abs(a) < 1e-5) discard;
        float sq = sqrt(disc), r0 = (-b - sq) / a, r1 = (-b + sq) / a;
        float t0 = min(r0, r1), t1 = max(r0, r1);
        float tA, tB;
        if (a < 0.0) {
          // the ray crosses the cone's side twice: inside between the hits (forward half only)
          if (cv + dv * 0.5 * (t0 + t1) < 0.0) discard;
          tA = t0; tB = t1;
        } else if (dv > 0.0) { tA = t1; tB = 1e4; } // looking along the beam: inside from the far hit on
        else { tA = -1e4; tB = t0; }
        // along the axis: from the lamp to the end of the beam
        if (abs(dv) > 1e-4) {
          float za = -cv / dv, zb = (uLen - cv) / dv;
          tA = max(tA, min(za, zb)); tB = min(tB, max(za, zb));
        }
        // in front of the camera, above the snow
        tA = max(tA, 0.05);
        float h0 = dot(uGround.xyz, ro) + uGround.w, hn = dot(uGround.xyz, rd);
        if (hn < 0.0) tB = min(tB, -h0 / hn); else if (h0 < 0.0) tA = max(tA, -h0 / hn);
        if (tB <= tA) discard;
        float span = tB - tA, fn = float(uSteps), sum = 0.0;
        for (int i = 0; i < 8; i++) {
          if (i >= uSteps) break;
          float u0 = float(i) / fn, u1 = float(i + 1) / fn, um = (float(i) + 0.5) / fn;
          vec3 p = ro + rd * (tA + span * um * um);
          vec3 q = p - uApex;
          float z = max(dot(q, uAxis), 1e-3);
          float s = length(q - uAxis * z) / (z * uTan);
          float h = dot(uGround.xyz, p) + uGround.w;
          float d = hlProfile(s) / (z * z + 3.0) * smoothstep(0.05, 0.9, z) * smoothstep(0.0, 0.5, h)
                    * (1.0 - smoothstep(uLen * 0.4, uLen, z));
          // drifting snow / mist: billows that move with the wind, finer grain where it snows (clear air: smooth)
          if (uNoise > 0.01) {
            float n = hlNoise(p * 1.3 + uDrift * uTime);
            if (uNoise2 > 0.0) n = mix(n, hlNoise(p * 3.7 - uDrift * (uTime * 1.7)), uNoise2);
            d *= mix(1.0, n * 2.0, uNoise);
          }
          // scattering toward the eye (Henyey-Greenstein, mostly forward: looking into the beam is brightest;
          // half isotropic so the shaft still reads from behind the skier)
          float ct = -dot(rd, normalize(q));
          float k = 1.0 + uG * uG - 2.0 * uG * ct;
          float hg = (1.0 - uG * uG) / (k * sqrt(k));
          sum += d * (0.55 + 0.45 * hg) * span * (u1 * u1 - u0 * u0);
        }
        gl_FragColor = vec4(uColor * (uI * uGain * sum), 1.0);
      }`,
    transparent: true, depthWrite: false, depthTest: !inside, blending: THREE.AdditiveBlending,
    side: inside ? THREE.BackSide : THREE.FrontSide, fog: false,
  });
}

// snowflakes caught in the beam: points on a world-anchored lattice that wraps round a box at the lamp
function flakeMaterial(u) {
  return new THREE.ShaderMaterial({
    uniforms: u,
    vertexShader: `
      attribute vec4 aSeed;
      uniform vec3 uApex, uAxis, uBoxMin, uBoxSize, uFall;
      uniform vec4 uGround;
      uniform float uTan, uTime, uI, uPx, uMinPx, uLen;
      varying float vB; varying float vSoft;
      ${PROFILE_GLSL}
      void main() {
        // falling and drifting, a little wobble each, wrapped round the box (world-anchored)
        vec3 p = aSeed.xyz * uBoxSize + uFall * uTime * (0.7 + 0.6 * aSeed.w);
        p += vec3(sin(uTime * 1.3 + aSeed.w * 40.0), 0.0, cos(uTime * 1.1 + aSeed.w * 23.0)) * 0.25;
        p = uBoxMin + mod(p - uBoxMin, uBoxSize);
        vec3 q = p - uApex;
        float z = dot(q, uAxis);
        float s = z > 0.05 ? length(q - uAxis * z) / (z * uTan) : 2.0;
        float h = dot(uGround.xyz, p) + uGround.w;
        vec4 mv = viewMatrix * vec4(p, 1.0);
        float dist = -mv.z;
        float fwd = dot(normalize(p - cameraPosition), uAxis);
        vB = s < 1.0 && z < uLen ? uI * hlProfile(s) / (z * z + 0.5) * smoothstep(0.0, 0.25, h) * (0.5 + 0.9 * max(fwd, 0.0))
                                  * (0.6 + 0.8 * fract(aSeed.w * 7.31)) : 0.0;
        // ~1 cm flakes: sub-pixel far away (kept ~2 screen px, dimmer), big and soft very close
        float px = 0.012 / max(dist, 0.05) / uPx;
        float size = clamp(px, uMinPx, uMinPx * 7.0);
        vB *= min(1.0, px / uMinPx) * min(1.0, 1.5 * uMinPx / max(size, 1.0));
        vSoft = smoothstep(2.0 * uMinPx, 7.0 * uMinPx, size);
        gl_PointSize = size;
        gl_Position = projectionMatrix * mv;
        if (vB < 0.003 || dist < 0.12) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 uColor;
      varying float vB; varying float vSoft;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float r2 = dot(c, c) * 4.0;
        if (r2 > 1.0) discard;
        float f = mix(exp(-r2 * 3.0), (1.0 - r2) * 0.5, vSoft);
        gl_FragColor = vec4(uColor * vB * f, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
  });
}

// the lens glow: a camera-facing quad, bright when the lamp looks at you
function glowMaterial(u, minSize = 0.16, gain = 1) {
  return new THREE.ShaderMaterial({
    uniforms: u,
    vertexShader: `
      uniform vec3 uLens, uAxis;
      uniform float uOn, uPx;
      varying vec2 vUv; varying float vI;
      void main() {
        vUv = position.xy * 2.0;
        vec4 mv = viewMatrix * vec4(uLens, 1.0);
        float dist = max(-mv.z, 0.05);
        float face = max(dot(normalize(cameraPosition - uLens), uAxis), 0.0);
        float size = max(${minSize.toFixed(3)}, dist * uPx * 6.0);
        vI = ${gain.toFixed(3)} * uOn * (0.06 + 0.94 * pow(face, 3.0)) * min(1.0, ${(minSize * minSize * 4).toFixed(5)} / (size * size) + 0.25);
        mv.xyz += normalize(-mv.xyz) * 0.03;
        mv.xy += position.xy * size * 2.0;
        gl_Position = projectionMatrix * mv;
        if (vI < 0.002) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 uColor;
      varying vec2 vUv; varying float vI;
      void main() {
        float r2 = dot(vUv, vUv);
        if (r2 > 1.0) discard;
        float g = exp(-r2 * 30.0) * 6.0 + exp(-r2 * 6.0) * 0.5 * (1.0 - r2);
        gl_FragColor = vec4(uColor * vI * g, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
  });
}

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
const _f = new THREE.Vector3(), _u = new THREE.Vector3(), _r = new THREE.Vector3(), _d = new THREE.Vector3(), _v = new THREE.Vector3(), _w = new THREE.Vector3(), _c = new THREE.Vector3();
const Z = new THREE.Vector3(0, 0, 1), Y = new THREE.Vector3(0, 1, 0);
const ek = (dt, rate) => 1 - Math.exp(-dt * rate);
const FLAKES_MAX = 1600;

export class Headlamp {
  /** @param {THREE.Scene} scene @param {{ world?: object }} o  world.height(x, z) for the snow under the beam */
  constructor(scene, { world } = {}) {
    this.scene = scene;
    this.world = world;
    this.on = 0;          // eased 0..1
    this.dir = new THREE.Vector3(0, -0.2, 1).normalize();
    this.pos = new THREE.Vector3();
    this.calib = new WeakMap(); // rig -> head-bone axes (forward, up in the bone's frame)

    const L = (this.light = new THREE.SpotLight(COLOR, 0, RANGE, ANGLE, 0.4, 2));
    L.map = cookieTexture();
    L.shadow.camera.near = 0.25;
    L.shadow.bias = -0.0006;
    L.shadow.normalBias = 0.04;
    L.shadow.autoUpdate = false;
    L.name = 'headlamp';
    L.userData.headlamp = this; // (dev tests reach the module through the scene)
    scene.add(L, L.target);

    const g = (this.group = new THREE.Group());
    g.name = 'headlamp-fx';
    scene.add(g);

    // lamp body: a rounded housing with a metal bezel and a lens, ~7 x 4 cm (lamp frame: +Z forward, +Y up)
    const body = new THREE.Group();
    const dark = new THREE.MeshStandardMaterial({ color: 0x17191c, roughness: 0.45, metalness: 0.1 });
    const metal = new THREE.MeshStandardMaterial({ color: 0x9aa1a8, roughness: 0.3, metalness: 0.9 });
    this.lensMat = new THREE.MeshBasicMaterial({ color: 0x222222 });
    const housing = new THREE.Mesh(new THREE.CylinderGeometry(0.021, 0.021, 0.07, 16, 1).rotateZ(Math.PI / 2).scale(1, 1, 1.15), dark);
    housing.position.set(0, 0, -0.012);
    const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.019, 0.017, 0.032, 20).rotateX(Math.PI / 2), dark);
    pod.position.set(0, 0.002, 0.012);
    const bezel = new THREE.Mesh(new THREE.TorusGeometry(0.0165, 0.0032, 8, 24), metal);
    bezel.position.set(0, 0.002, 0.028);
    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.0155, 24), this.lensMat);
    lens.position.set(0, 0.002, 0.0285);
    const clip = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.012, 0.026), dark);
    clip.position.set(0, -0.019, -0.012);
    body.add(housing, pod, bezel, lens, clip);
    body.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
    this.body = body;
    g.add(body);
    // battery pack on the back of the helmet with a small red rear light (what you see of the lamp from behind)
    const rear = new THREE.Group();
    const pack = new THREE.Mesh(new THREE.BoxGeometry(0.058, 0.034, 0.022), dark);
    this.redMat = new THREE.MeshBasicMaterial({ color: 0x330000 });
    const red = new THREE.Mesh(new THREE.CircleGeometry(0.0055, 12), this.redMat);
    red.position.set(0.016, 0.003, 0.0115);
    rear.add(pack, red);
    rear.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
    this.rear = rear;
    g.add(rear);

    const U = (this.u = {
      uApex: { value: new THREE.Vector3() }, uAxis: { value: new THREE.Vector3(0, 0, 1) },
      uTan: { value: HAZE_TAN }, uLen: { value: BEAM_LEN }, uI: { value: 0 }, uTime: { value: 0 },
      uNoise: { value: 0.5 }, uNoise2: { value: 0.35 }, uG: { value: 0.25 }, uGround: { value: new THREE.Vector4(0, 1, 0, 0) },
      uColor: { value: COLOR.clone() }, uDrift: { value: new THREE.Vector3(0.1, 0.6, 0.05) }, uSteps: { value: 6 },
    });
    // beam proxy: a closed cone a little wider than the beam, apex at the lamp, along +Z
    const cone = new THREE.ConeGeometry(1, 1, 36, 1, false).translate(0, -0.5, 0).rotateX(-Math.PI / 2);
    // Two variants share the uniforms: seen from outside (front faces, depth tested) and from inside the beam (a
    // camera looking back at the lamp: back faces, no depth test). Each checks the camera actually drawing it and
    // the one that doesn't apply draws nothing (no material switch, so no shader recompile).
    const isInside = (cam) => {
      _c.copy(cam.position).sub(U.uApex.value);
      const z = _c.dot(U.uAxis.value);
      return z > -0.05 && z < BEAM_LEN && _c.addScaledVector(U.uAxis.value, -z).length() < Math.max(0.05, z * HAZE_TAN * 1.08);
    };
    this.beams = [false, true].map((inside) => {
      // (from inside, toned down: a lamp shining at you is mostly glare round the lamp itself)
      const mat = beamMaterial({ ...U, uActive: { value: 1 }, uGain: { value: inside ? 0.5 : 1 } }, inside);
      const mesh = new THREE.Mesh(cone, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 6;
      mesh.onBeforeRender = (renderer, scene, cam) => { mat.uniforms.uActive.value = isInside(cam) === inside ? 1 : 0; };
      g.add(mesh);
      return mesh;
    });

    // flakes in the beam
    const seeds = new Float32Array(FLAKES_MAX * 4);
    for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(FLAKES_MAX * 3), 3));
    fg.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
    this.fu = {
      uApex: { value: new THREE.Vector3() }, uAxis: U.uAxis, uTan: { value: Math.tan(ANGLE) }, uLen: U.uLen, uTime: U.uTime, uGround: U.uGround, uColor: U.uColor,
      uBoxMin: { value: new THREE.Vector3() }, uBoxSize: { value: new THREE.Vector3(12, 8, 12) },
      uFall: { value: new THREE.Vector3(0.3, -1.1, 0.15) }, uI: { value: 0 }, uPx: { value: 0.0015 }, uMinPx: { value: 2 },
    };
    this.flakes = new THREE.Points(fg, flakeMaterial(this.fu));
    this.flakes.frustumCulled = false;
    this.flakes.renderOrder = 7;
    // pixel sizes from the target actually drawn to (the render scale differs per preset and screen)
    const pxSize = (renderer, cam) => {
      if (!cam.isPerspectiveCamera) return;
      const rt = renderer.getRenderTarget(), h = rt ? rt.height : renderer.getContext().drawingBufferHeight;
      this.fu.uPx.value = (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) / Math.max(1, h);
      this.fu.uMinPx.value = 2 * Math.max(0.5, h / Math.max(1, typeof innerHeight === 'number' ? innerHeight : h));
    };
    this.flakes.onBeforeRender = (renderer, scene, cam) => pxSize(renderer, cam);
    g.add(this.flakes);

    // lens glow
    this.gu = { uLens: { value: new THREE.Vector3() }, uAxis: U.uAxis, uOn: { value: 0 }, uPx: this.fu.uPx, uColor: { value: new THREE.Color(1, 0.96, 0.9) } };
    this.glow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), glowMaterial(this.gu));
    this.glow.onBeforeRender = (renderer, scene, cam) => pxSize(renderer, cam);
    this.glow.frustumCulled = false;
    this.glow.renderOrder = 8;
    g.add(this.glow);
    this.ru = { uLens: { value: new THREE.Vector3() }, uAxis: { value: new THREE.Vector3() }, uOn: { value: 0 }, uPx: this.fu.uPx, uColor: { value: new THREE.Color(1, 0.06, 0.03) } };
    this.redGlow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), glowMaterial(this.ru, 0.05, 0.35));
    this.redGlow.frustumCulled = false;
    this.redGlow.renderOrder = 8;
    g.add(this.redGlow);

    this.applyQuality();
    onQualityChange(() => this.applyQuality());
  }

  applyQuality() {
    const hi = quality.name === 'high' || quality.name === 'ultra';
    const L = this.light;
    if (L.castShadow !== hi) { L.castShadow = hi; L.shadow.needsUpdate = true; } // (a shadow change recompiles: preset changes only)
    const ms = quality.name === 'ultra' ? 1024 : 512;
    if (L.shadow.mapSize.x !== ms) { L.shadow.mapSize.set(ms, ms); L.shadow.map?.dispose(); L.shadow.map = null; }
    this.u.uSteps.value = quality.name === 'performance' ? 3 : hi ? 6 : 4;
    this.u.uNoise2.value = quality.name === 'performance' ? 0 : 0.35;
    this.flakeMax = quality.name === 'performance' ? 800 : hi ? FLAKES_MAX : 1100;
  }

  // the head bone's forward and up in its own frame, from the bind pose (the model faces +Z, up +Y)
  // and where the lamp and the battery pack sit on this character's helmet (in the bone's frame), measured on
  // the skinned mesh in its bind pose: the helmet's front just under its crown, and its back
  axes(rig) {
    let c = this.calib.get(rig);
    if (c) return c;
    const head = rig.b?.head;
    c = { f: new THREE.Vector3(0, 0, 1), u: new THREE.Vector3(0, 1, 0), mount: null, rear: null };
    const mesh = rig.skinned, sk = mesh?.skeleton, i = sk ? sk.bones.indexOf(head) : -1;
    if (i >= 0) {
      // bind pose: the bone's world matrix when the model was bound (the model upright, facing +Z)
      _m.copy(sk.boneInverses[i]).invert().decompose(_p, _q, _s);
      const unit = 1 / (_s.x || 1); // bone units per metre
      _q.invert();
      c.f.copy(Z).applyQuaternion(_q).normalize();
      c.u.copy(Y).applyQuaternion(_q).normalize();
      const r = new THREE.Vector3().crossVectors(c.u, c.f).normalize();
      // the head's own vertices in the bone's frame (skinned to the head bone or the end bones under it)
      const own = new Set();
      head.traverse((o) => { const k = sk.bones.indexOf(o); if (k >= 0) own.add(k); });
      const g = mesh.geometry, P = g.attributes.position, SI = g.attributes.skinIndex, SW = g.attributes.skinWeight;
      const toBone = new THREE.Matrix4().copy(sk.boneInverses[i]).multiply(mesh.bindMatrix), v = new THREE.Vector3();
      const pts = [];
      let top = -Infinity;
      if (P && SI && SW) {
        for (let k = 0; k < P.count; k++) {
          let w = 0;
          for (let j = 0; j < 4; j++) if (own.has(SI.getComponent(k, j))) w += SW.getComponent(k, j);
          if (w < 0.6) continue;
          v.fromBufferAttribute(P, k).applyMatrix4(toBone);
          const up = v.dot(c.u);
          pts.push(v.dot(c.f), up, v.dot(r));
          if (up > top) top = up;
        }
      }
      if (pts.length > 60) {
        // forehead band (5.5-8.5 cm under the crown, near the middle): the front-most point; a lower band: the back
        let front = -Infinity, back = Infinity, side = 0, ns = 0;
        for (let k = 0; k < pts.length; k += 3) {
          const fw = pts[k], up = pts[k + 1], sd = pts[k + 2];
          if (Math.abs(sd) > 0.035 * unit) continue;
          if (up < top - 0.085 * unit || up > top - 0.055 * unit) {
            if (up > top - 0.12 * unit && up < top - 0.07 * unit) back = Math.min(back, fw);
            continue;
          }
          if (fw > front) front = fw;
          side += sd; ns++;
        }
        side = ns ? side / ns : 0;
        if (Number.isFinite(front)) c.mount = new THREE.Vector3().addScaledVector(c.f, front + 0.024 * unit).addScaledVector(c.u, top - 0.07 * unit).addScaledVector(r, side);
        if (Number.isFinite(back)) c.rear = new THREE.Vector3().addScaledVector(c.f, back - 0.012 * unit).addScaledVector(c.u, top - 0.095 * unit).addScaledVector(r, side);
        c.top = top / unit;
      }
    }
    this.calib.set(rig, c);
    return c;
  }

  /**
   * @param {number} dt
   * @param {{ on: boolean, rig: object, camera: THREE.Camera, firstPerson: boolean, env: object, pos?: THREE.Vector3 }} o
   */
  update(dt, { on, rig, camera, firstPerson, env, pos }) {
    const target = on ? 1 : 0;
    this.on += (target - this.on) * ek(dt, 9);
    if (Math.abs(target - this.on) < 0.003) this.on = target;
    const night = env?.nightFactor ?? 1;
    const head = rig?.b?.head;
    const showBody = !!head && !firstPerson && rig.root?.visible !== false && (night > 0.35 || this.on > 0.01);
    this.body.visible = showBody;
    this.rear.visible = showBody;

    // the lamp's place and aim
    if (head) {
      head.matrixWorld.decompose(_p, _q, _s);
      const c = this.axes(rig);
      _f.copy(c.f).applyQuaternion(_q);
      _u.copy(c.u).applyQuaternion(_q);
      if (c.mount) this.pos.copy(c.mount).applyMatrix4(head.matrixWorld);
      else this.pos.copy(_p).addScaledVector(_u, MOUNT.up).addScaledVector(_f, MOUNT.fwd);
      // lamp body: lamp frame (+Z along the head's forward, tipped down with the beam)
      _r.crossVectors(_u, _f).normalize();
      _d.copy(_f).multiplyScalar(Math.cos(PITCH * 0.6)).addScaledVector(_u, -Math.sin(PITCH * 0.6));
      _m.lookAt(_v.set(0, 0, 0), _w.copy(_d).negate(), _u);
      this.body.quaternion.setFromRotationMatrix(_m);
      this.body.position.copy(this.pos);
      // the pack: on the back of the helmet, facing back
      if (c.rear) this.rear.position.copy(c.rear).applyMatrix4(head.matrixWorld);
      else this.rear.position.copy(_p).addScaledVector(_u, REAR.up).addScaledVector(_f, REAR.fwd);
      _m.lookAt(_v.set(0, 0, 0), _f, _u);
      this.rear.quaternion.setFromRotationMatrix(_m);
      this.ru.uAxis.value.copy(_f).negate();
      _d.copy(_f).multiplyScalar(Math.cos(PITCH)).addScaledVector(_u, -Math.sin(PITCH)).normalize();
      this.limitToSlope(_d, pos ?? this.pos);
    } else if (camera) {
      camera.getWorldDirection(_d);
      this.pos.copy(camera.position);
    }
    if (firstPerson && camera) {
      // first person: from just above the eyes, along the view, tipped down a little
      camera.getWorldDirection(_f);
      _u.copy(camera.up).applyQuaternion(camera.quaternion);
      _r.crossVectors(_f, Y);
      if (_r.lengthSq() < 1e-6) _r.set(1, 0, 0);
      _r.normalize();
      _u.crossVectors(_r, _f).normalize();
      this.pos.copy(camera.position).addScaledVector(_u, 0.07).addScaledVector(_f, 0.06);
      _d.copy(_f).multiplyScalar(Math.cos(PITCH_FP)).addScaledVector(_u, -Math.sin(PITCH_FP)).normalize();
    }
    // steady the aim a little (the head bobs with every turn)
    this.dir.lerp(_d, this.snap ? 1 : ek(dt, 22)).normalize();
    this.snap = false;

    const L = this.light, I = INTENSITY * this.on;
    L.intensity = I;
    L.position.copy(this.pos);
    L.target.position.copy(this.pos).addScaledVector(this.dir, 10);
    L.target.updateMatrixWorld();
    if (L.castShadow) L.shadow.autoUpdate = this.on > 0.01;

    // beam and flakes
    const live = this.on > 0.01 && !!camera;
    const snow = Math.min(1, env?.snow ?? 0), mist = Math.min(1, env?.mist ?? 0);
    const haze = 0.45 + 0.95 * snow + 0.7 * Math.max(0, mist - 0.12); // (a faint shaft in clear air too)
    const U = this.u;
    U.uTime.value += dt;
    // (first person: the visible beam starts a little ahead, clear of the camera's near plane)
    U.uApex.value.copy(this.pos).addScaledVector(this.dir, firstPerson ? 0.3 : 0);
    U.uAxis.value.copy(this.dir);
    this.fu.uApex.value.copy(this.pos);
    U.uI.value = I * 0.0042 * haze;
    U.uNoise.value = Math.min(0.85, 0.85 * snow + 0.5 * Math.max(0, mist - 0.12));
    // the snow under the beam: a plane through the ground below the lamp, tilted with the slope
    if (this.world?.height) {
      const w = this.world, x = pos?.x ?? this.pos.x, z = pos?.z ?? this.pos.z;
      const h = w.height(x, z), gx = (w.height(x + 1.5, z) - w.height(x - 1.5, z)) / 3, gz = (w.height(x, z + 1.5) - w.height(x, z - 1.5)) / 3;
      const n = _v.set(-gx, 1, -gz).normalize();
      U.uGround.value.set(n.x, n.y, n.z, -(n.x * x + n.y * h + n.z * z));
    } else U.uGround.value.set(0, 1, 0, -(this.pos.y - 1.7));
    // proxy cone a little wider than the beam
    const R = BEAM_LEN * HAZE_TAN * 1.08, beamOn = live && U.uI.value > 0.002;
    for (const b of this.beams) {
      b.position.copy(U.uApex.value);
      b.quaternion.setFromUnitVectors(Z, this.dir);
      b.scale.set(R, R, BEAM_LEN);
      b.visible = beamOn;
    }

    // flakes: box round the near part of the beam, as many as the snowfall gives (a few motes in clear air)
    const n = Math.round(this.flakeMax * Math.min(1, 0.04 + snow * 1.1));
    this.flakes.geometry.setDrawRange(0, n);
    this.flakes.visible = live && n > 0;
    const F = this.fu, bs = F.uBoxSize.value;
    F.uBoxMin.value.copy(this.pos).addScaledVector(this.dir, 6).sub(_v.copy(bs).multiplyScalar(0.5));
    F.uI.value = I * 0.9 * (0.4 + 0.6 * snow);
    F.uFall.value.set(0.35 + 0.8 * snow, -(0.7 + 0.6 * snow), 0.2);

    // lens: HDR white when on (blooms), dark glass when off
    this.lensMat.color.setRGB(0.05 + 9 * this.on, 0.05 + 8.7 * this.on, 0.05 + 8.2 * this.on);
    this.glow.visible = showBody && this.on > 0.01;
    this.gu.uOn.value = this.on;
    this.body.updateMatrixWorld();
    this.gu.uLens.value.set(0, 0.002, 0.034).applyMatrix4(this.body.matrixWorld);
    // rear light: steady red, glowing a little when seen from behind
    this.redMat.color.setRGB(0.2 + 3.5 * this.on, 0.01 + 0.08 * this.on, 0.01 + 0.04 * this.on);
    this.redGlow.visible = showBody && this.on > 0.01;
    this.ru.uOn.value = this.on;
    this.rear.updateMatrixWorld();
    this.ru.uLens.value.set(0.016, 0.003, 0.014).applyMatrix4(this.rear.matrixWorld);
  }

  // keep the beam's angle below the snow surface (plane under the skier) within SLOPE_MIN..SLOPE_MAX
  limitToSlope(d, at) {
    const w = this.world;
    if (!w?.height) return;
    const x = at.x, z = at.z;
    const gx = (w.height(x + 1.5, z) - w.height(x - 1.5, z)) / 3, gz = (w.height(x, z + 1.5) - w.height(x, z - 1.5)) / 3;
    const n = _w.set(-gx, 1, -gz).normalize();
    const e = Math.asin(Math.max(-1, Math.min(1, d.dot(n)))); // < 0: toward the snow
    const want = -Math.min(SLOPE_MAX, Math.max(SLOPE_MIN, -e));
    if (Math.abs(want - e) < 1e-4) return;
    // turn d within the plane of d and n
    const h = _v.copy(d).addScaledVector(n, -Math.sin(e));
    if (h.lengthSq() < 1e-8) return;
    h.normalize();
    d.copy(h).multiplyScalar(Math.cos(want)).addScaledVector(n, Math.sin(want)).normalize();
  }

  dispose() {
    this.scene.remove(this.light, this.light.target, this.group);
    this.group.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
    this.light.map?.dispose();
    this.light.dispose();
  }
}
