// The helicopter you fly: the Meshy airframe (models.heli_body) with its static rotor head cut away,
// our own spinning main and tail rotors (blades fade into a translucent blur disc as they spool up),
// nav lights / beacons / strobes, the side ski basket and a landing light that pools on the snow at night.
// No THREE lights: lamps are additive points, the landing light a lit decal on the terrain.
// A procedural airframe stands in when the model is missing.
//
// Frames: the airframe is authored in a reference frame where the fuselage is REF_LEN units long, nose
// toward +z, left side +x, skid bottoms at y = 0. It is drawn at K metres per unit, so the real helicopter
// is ~9.8 m long with a ~10.2 m rotor. `root` sits at the centre of mass (the flight model's position).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { glowPoints, glowScale } from './fx.js';

export const REF_LEN = 10.5;
export const K = 9.8 / REF_LEN;
const CG = new THREE.Vector3(0, 1.75, 1.3);          // centre of mass (below the mast)
const HUB = new THREE.Vector3(0, 4.02, 1.3);         // main rotor hub
const TAIL_HUB = new THREE.Vector3(0.41, 2.25, -4.92); // tail rotor hub (left side of the fin)
const R_MAIN = 5.1 / K, R_TAIL = 0.86 / K;
const LAMP_TILT = 0.62; // landing light: this far below the nose (rad)

// reference frame -> metres around the centre of mass
const toLocal = (x, y, z) => new THREE.Vector3((x - CG.x) * K, (y - CG.y) * K, (z - CG.z) * K);

/** Fixed points on the helicopter, in metres around the centre of mass (root-local). */
export const ANCHORS = {
  seat: toLocal(-0.5, 1.34, 2.5),       // pilot's seat surface (front right)
  door: toLocal(-1.5, 0, 2.25),         // where you jump out (right side, at skid level)
  basket: toLocal(1.66, 0.8, 1.38),     // centre of the ski basket (left side)
  lamp: toLocal(0, 0.8, 4.35),          // landing light under the nose
  hub: toLocal(HUB.x, HUB.y, HUB.z),
  cgH: CG.y * K,
};
/** Airframe numbers for the flight model (metres). */
export const FRAME = {
  cgH: CG.y * K, skidL: 4.07 * K, skidW: 2.94 * K, skidZ: (1.735 - CG.z) * K,
  hull: { nose: [(4.4 - CG.z) * K, 0.76 * K], tail: [(-5.25 - CG.z) * K, 1.29 * K], stab: [(-3.2 - CG.z) * K, 1.8 * K, 1.76 * K], rotor: [5.1, 3.35] },
  rotorR: 5.1,
};
// lights (reference frame, see toLocal): [x, y, z, r, g, b, size in m, kind]
const LIGHTS = [
  [1.84, 2.02, -3.25, 1, 0.08, 0.04, 0.55, 'nav'],   // port (left): red
  [-1.84, 2.02, -3.25, 0.06, 1, 0.25, 0.55, 'nav'],  // starboard (right): green
  [0, 2.18, -5.32, 1, 0.92, 0.82, 0.3, 'nav'],       // tail: white
  [0, 3.86, -5.02, 1, 0.06, 0.03, 0.6, 'beacon'],    // anti-collision beacon on the fin
  [0, 0.64, 1.9, 1, 0.06, 0.03, 0.55, 'beacon2'],    // ...and under the belly
  [1.86, 2.04, -3.32, 1, 1, 1, 0.75, 'strobe'],      // white strobes at the stabilizer tips
  [-1.86, 2.04, -3.32, 1, 1, 1, 0.75, 'strobe'],
  [0, 0.8, 4.35, 1, 0.93, 0.8, 0.7, 'lamp'],         // landing light lens
].map(([x, y, z, r, g, b, s, kind]) => ({ p: toLocal(x, y, z), c: new THREE.Color(r, g, b), s, kind }));

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const FWD = new THREE.Vector3(0, 0, 1); // (the beam mesh opens along +z: beamMesh)

// ------------------------------------------------------------------ the Meshy airframe
// Cuts the model's static rotor head (and loose strands beside it) and its tail rotor stub: our own
// rotors spin there. Works on meshopt-quantized positions (read through the node's matrix).
function meshyBody(gltf) {
  if (!gltf) return null;
  let mesh = null;
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => { if (o.isMesh && !mesh) mesh = o; });
  const g = mesh?.geometry;
  if (!g?.index || !g.attributes.position) return null;
  const P = g.attributes.position, M = mesh.matrixWorld, n = P.count;
  const box = new THREE.Box3();
  for (let i = 0; i < n; i++) box.expandByPoint(_v.fromBufferAttribute(P, i).applyMatrix4(M));
  const s = REF_LEN / (box.max.x - box.min.x), cx = (box.max.x + box.min.x) / 2, cz = (box.max.z + box.min.z) / 2;
  // model: nose -x, up +y  ->  reference: nose +z, left +x, skids at 0
  const toRef = new THREE.Matrix4().set(0, 0, s, -cz * s, 0, s, 0, -box.min.y * s, -s, 0, 0, cx * s, 0, 0, 0, 1).multiply(M);
  const R = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { _v.fromBufferAttribute(P, i).applyMatrix4(toRef); R[i * 3] = _v.x; R[i * 3 + 1] = _v.y; R[i * 3 + 2] = _v.z; }
  const I = g.index.array, keep = [];
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const ax = R[a], ay = R[a + 1], az = R[a + 2], bx = R[b], by = R[b + 1], bz = R[b + 2], qx = R[c], qy = R[c + 1], qz = R[c + 2];
    const mx = (ax + bx + qx) / 3, mz = (az + bz + qz) / 3, ymax = Math.max(ay, by, qy), ymin = Math.min(ay, by, qy);
    // rotor head, swashplate and pitch links above the engine cowling
    if (ymax > 3.47 && Math.abs(mz - 1.3) < 0.75 && Math.abs(mx) < 0.62) continue;
    // a loose strand hanging off the head on the right side
    if (Math.max(ax, bx, qx) < -0.47 && ymin > 2.98 && mz > 0.2 && mz < 2) continue;
    const off = (x, y, z) => x < -0.475 + (y - 2.95) * 0.167 && y > 2.98 && z > 1 && z < 1.6;
    if (off(ax, ay, az) && off(bx, by, bz) && off(qx, qy, qz)) continue;
    // tail rotor stub
    const tr = (x, y, z) => x > 0.2 && z < -4.55 && y > 1.9 && y < 2.6;
    if (tr(ax, ay, az) && tr(bx, by, bz) && tr(qx, qy, qz)) continue;
    keep.push(I[t], I[t + 1], I[t + 2]);
  }
  const geo = new THREE.BufferGeometry();
  for (const k in g.attributes) geo.setAttribute(k, g.attributes[k]); // shared with the model, not copied
  geo.setIndex(keep);
  geo.computeBoundingSphere();
  const mat = mesh.material.clone();
  // the model's emissive map is black: don't spend GPU memory on it
  mat.emissiveMap = null; mat.emissive.setRGB(0, 0, 0);
  const body = new THREE.Mesh(geo, mat);
  body.matrixAutoUpdate = false;
  body.matrix.copy(toRef);
  body.castShadow = true; body.receiveShadow = true;
  return body;
}

// ------------------------------------------------------------------ procedural airframe (no model)
function liveryTexture() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const g = c.getContext('2d');
  // sphere / lathe UVs: v runs bottom (0) -> top (1)
  g.fillStyle = '#f2f3f5'; g.fillRect(0, 0, 512, 256);
  g.fillStyle = '#d7261e'; g.fillRect(0, 0, 512, 118);
  g.fillStyle = '#1546c8'; g.fillRect(0, 124, 512, 16);
  g.fillStyle = '#ffffff'; g.fillRect(0, 118, 512, 6);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function proceduralBody() {
  const grp = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ map: liveryTexture(), roughness: 0.35, metalness: 0.15 });
  const red = new THREE.MeshStandardMaterial({ color: 0xc8231b, roughness: 0.38, metalness: 0.15 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x141c26, roughness: 0.05, metalness: 0.85 });
  const metal = new THREE.MeshStandardMaterial({ color: 0xc9ced4, roughness: 0.35, metalness: 0.7 });
  const add = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; grp.add(m); return m; };
  // cabin pod (livery: red top, blue stripe, white belly) and its glass: the front and sides of the same
  // shape, a touch larger (sphere phi = PI/2 faces +z, the nose)
  const pod = (r, ...a) => new THREE.SphereGeometry(r, 40, 24, ...a).scale(1.05, 1.12, 2.35);
  add(pod(1), paint, 0, 1.85, 2.0);
  add(pod(1.012, Math.PI / 2 - 1.15, 2.3, 0.42, 0.95), glass, 0, 1.85, 2.0);
  // engine cowling, tail boom (thick at the cabin), stabilizer, fin
  add(new THREE.BoxGeometry(0.86, 0.62, 1.8), red, 0, 3.05, 1.05);
  const boom = add(new THREE.CylinderGeometry(0.4, 0.17, 5.2, 18), red, 0, 2.05, -2.5);
  boom.rotation.x = Math.PI / 2 + 0.035;
  add(new THREE.BoxGeometry(3.6, 0.07, 0.55), red, 0, 1.98, -3.25);
  const fin = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(0.75, 0), new THREE.Vector2(1.05, 2.45), new THREE.Vector2(0.55, 2.45)]);
  const finM = add(new THREE.ExtrudeGeometry(fin, { depth: 0.08, bevelEnabled: false }), red, -0.04, 1.3, -4.45);
  finM.rotation.y = -Math.PI / 2;
  // skids and cross tubes
  for (const sx of [-1, 1]) {
    const skid = add(new THREE.CylinderGeometry(0.055, 0.055, 4.1, 10), metal, sx * 1.47, 0.06, 1.73);
    skid.rotation.x = Math.PI / 2;
    const tip = add(new THREE.CylinderGeometry(0.055, 0.055, 0.5, 10), metal, sx * 1.47, 0.17, 3.93);
    tip.rotation.x = Math.PI / 2 - 0.75;
    for (const z of [0.4, 2.9]) {
      const leg = add(new THREE.CylinderGeometry(0.05, 0.05, 1.05, 10), metal, sx * 1.15, 0.47, z);
      leg.rotation.z = sx * 0.62;
    }
  }
  for (const z of [0.4, 2.9]) { const ct = add(new THREE.CylinderGeometry(0.05, 0.05, 1.75, 10), metal, 0, 0.88, z); ct.rotation.z = Math.PI / 2; }
  return grp;
}

// ------------------------------------------------------------------ rotors
// Blur disc: translucent dark grey, densest toward the tips, with `blades` soft smears trailing each blade.
function blurTexture(blades, size = 512) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size), D = img.data, h = size / 2;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = (x + 0.5 - h) / h, dy = (y + 0.5 - h) / h, r = Math.hypot(dx, dy);
    const k = (y * size + x) * 4;
    D[k] = D[k + 1] = D[k + 2] = 255;
    if (r > 1) { D[k + 3] = 0; continue; }
    // phase after each blade in the direction they travel (canvas angle increases with the clockwise
    // spin seen from above): the smear trails behind the blade, the leading edge stays crisp
    let ph = ((Math.atan2(dy, dx) / (Math.PI * 2)) * blades) % 1;
    if (ph < 0) ph += 1;
    const smear = Math.exp(-(1 - ph) * 4.2) + 0.35 * Math.exp(-ph * 30);
    const radial = smooth(0.06, 0.22, r) * (0.45 + 0.55 * smooth(0.25, 0.92, r)) * (1 - smooth(0.975, 1, r));
    const tip = Math.exp(-(((r - 0.955) / 0.022) ** 2)) * 0.5;
    D[k + 3] = Math.round(255 * Math.min(1, radial * (0.26 + 0.74 * smear) + tip));
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

// a blade along +x from its root: tapered box, white tip band (vertex colours)
function bladeGeometry(len, chord, tipChord, thick, tipBand) {
  const geo = new THREE.BoxGeometry(len, thick, chord, 12, 1, 1);
  geo.translate(len / 2, 0, 0);
  const p = geo.attributes.position, col = [];
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), f = x / len;
    p.setZ(i, p.getZ(i) * (1 - (1 - tipChord / chord) * f) + (p.getZ(i) > 0 ? -0.004 : 0));
    // dark composite blade, white tip band
    col.push(...(x > len - tipBand ? [0.86, 0.86, 0.84] : [0.035, 0.038, 0.045]));
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  return geo;
}

function mainRotor() {
  const metal = new THREE.MeshStandardMaterial({ color: 0x41464d, roughness: 0.38, metalness: 0.8 });
  const bladeMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.42, metalness: 0.25, vertexColors: true, transparent: true });
  // static: mast fairing, mast, lower swashplate
  const mast = mergeGeometries([
    new THREE.CylinderGeometry(0.2, 0.33, 0.24, 20).translate(0, 3.45, 0),
    new THREE.CylinderGeometry(0.11, 0.13, 0.72, 16).translate(0, 3.7, 0),
    new THREE.CylinderGeometry(0.31, 0.31, 0.06, 24).translate(0, 3.58, 0),
  ]);
  const mastMesh = new THREE.Mesh(mast, metal);
  mastMesh.position.set(HUB.x, 0, HUB.z);
  mastMesh.castShadow = true;
  // spinning: hub, cap, grips, upper swashplate, pitch links (one mesh) + four blades
  const parts = [
    new THREE.CylinderGeometry(0.27, 0.29, 0.2, 24),
    new THREE.SphereGeometry(0.22, 18, 8, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.55, 1).translate(0, 0.1, 0),
    new THREE.CylinderGeometry(0.3, 0.3, 0.05, 24).translate(0, -0.38, 0),
  ];
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2;
    parts.push(new THREE.BoxGeometry(0.44, 0.12, 0.17).translate(0.34, 0, 0).rotateY(a));
    parts.push(new THREE.CylinderGeometry(0.016, 0.016, 0.36, 6).translate(0.24, -0.2, 0.09).rotateY(a));
  }
  const hub = new THREE.Mesh(mergeGeometries(parts), metal);
  hub.castShadow = true;
  const spin = new THREE.Group();
  spin.position.copy(HUB);
  spin.add(hub);
  const bgeo = bladeGeometry(R_MAIN - 0.42, 0.38, 0.3, 0.06, 0.24).rotateX(0.07); // a little blade pitch
  const blades = [];
  for (let i = 0; i < 4; i++) {
    const pivot = new THREE.Group();
    pivot.rotation.y = (i * Math.PI) / 2;
    const droop = new THREE.Group();
    droop.position.x = 0.42;
    const m = new THREE.Mesh(bgeo, bladeMat);
    m.castShadow = true;
    m.renderOrder = 1;
    droop.add(m);
    pivot.add(droop);
    spin.add(pivot);
    blades.push(droop);
  }
  const discMat = new THREE.MeshBasicMaterial({ map: blurTexture(4, 384), color: 0x1d2025, transparent: true, depthWrite: false, side: THREE.DoubleSide, opacity: 0 });
  const disc = new THREE.Mesh(new THREE.CircleGeometry(R_MAIN + 0.05, 72).rotateX(-Math.PI / 2), discMat);
  disc.position.set(HUB.x, HUB.y + 0.02, HUB.z);
  disc.renderOrder = 2;
  disc.visible = false;
  return { mastMesh, spin, blades, bladeMat, disc, discMat };
}

function tailRotor() {
  const metal = new THREE.MeshStandardMaterial({ color: 0x3c4148, roughness: 0.4, metalness: 0.75 });
  const bladeMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45, metalness: 0.25, vertexColors: true, transparent: true });
  const spin = new THREE.Group();
  spin.position.copy(TAIL_HUB);
  // the disc lies in the y-z plane, spinning about +x
  const hub = new THREE.Mesh(mergeGeometries([
    new THREE.CylinderGeometry(0.1, 0.12, 0.16, 14).rotateZ(Math.PI / 2),
    new THREE.SphereGeometry(0.08, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2).rotateZ(-Math.PI / 2).translate(0.08, 0, 0),
  ]), metal);
  hub.castShadow = true;
  spin.add(hub);
  const bgeo = bladeGeometry(R_TAIL - 0.1, 0.19, 0.15, 0.035, 0.12).rotateZ(Math.PI / 2).rotateY(0.2); // blade along +y, pitched
  const blades = new THREE.Group();
  for (let i = 0; i < 2; i++) {
    const m = new THREE.Mesh(bgeo, bladeMat);
    m.position.y = 0.08;
    const p = new THREE.Group();
    p.rotation.x = i * Math.PI;
    p.add(m);
    blades.add(p);
  }
  blades.position.x = 0.06;
  spin.add(blades);
  const discMat = new THREE.MeshBasicMaterial({ map: blurTexture(2, 128), color: 0x1d2025, transparent: true, depthWrite: false, side: THREE.DoubleSide, opacity: 0 });
  const disc = new THREE.Mesh(new THREE.CircleGeometry(R_TAIL + 0.03, 40).rotateY(Math.PI / 2), discMat);
  disc.position.set(TAIL_HUB.x + 0.06, TAIL_HUB.y, TAIL_HUB.z);
  disc.renderOrder = 2;
  disc.visible = false;
  return { spin, bladeMat, disc, discMat };
}

// ------------------------------------------------------------------ landing light
// The lit pool on the snow: a terrain-hugging grid shaded like a spot light (cone, falloff, slope).
const POOL_N = 17;
function poolMesh() {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(POOL_N * POOL_N * 3), nor = new Float32Array(POOL_N * POOL_N * 3), idx = [];
  for (let j = 0; j < POOL_N - 1; j++) for (let i = 0; i < POOL_N - 1; i++) {
    const a = j * POOL_N + i, b = a + 1, c = a + POOL_N, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setIndex(idx);
  const uniforms = {
    uLamp: { value: new THREE.Vector3() }, uDir: { value: new THREE.Vector3(0, -1, 0) },
    uColor: { value: new THREE.Color(0, 0, 0) }, uCos: { value: new THREE.Vector2(Math.cos(0.36), Math.cos(0.08)) },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `varying vec3 vW; varying vec3 vN;
      void main(){ vW = position; vN = normal; gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform vec3 uLamp; uniform vec3 uDir; uniform vec3 uColor; uniform vec2 uCos; varying vec3 vW; varying vec3 vN;
      void main(){ vec3 L = uLamp - vW; float d = length(L); L /= d;
        float spot = smoothstep(uCos.x, uCos.y, dot(-L, uDir));
        float ndl = max(dot(normalize(vN), L), 0.0);
        vec3 c = uColor * spot * spot * ndl / (1.0 + d * d * 0.0011);
        gl_FragColor = vec4(c, 1.0); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8,
  });
  const m = new THREE.Mesh(geo, mat);
  m.frustumCulled = false;
  m.renderOrder = 3;
  m.visible = false;
  return { mesh: m, uniforms, center: new THREE.Vector3(1e9, 0, 0), size: 0 };
}

// the faint beam in the air (shows in falling snow and at night)
function beamMesh() {
  const geo = new THREE.CylinderGeometry(0.12, 1, 1, 24, 1, true).translate(0, -0.5, 0).rotateX(-Math.PI / 2); // apex at 0, opens along +z
  const mat = new THREE.ShaderMaterial({
    uniforms: { uI: { value: 0 }, uLen: { value: 40 } },
    vertexShader: `varying float vAlong; varying vec3 vN; varying vec3 vV;
      void main(){ vAlong = position.z; vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform float uI; varying float vAlong; varying vec3 vN; varying vec3 vV;
      void main(){ float edge = pow(abs(dot(vN, vV)), 1.6);
        float a = uI * edge * (1.0 - smoothstep(0.15, 1.0, vAlong)) * smoothstep(0.0, 0.04, vAlong);
        gl_FragColor = vec4(vec3(1.0, 0.94, 0.82) * a, 1.0); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const m = new THREE.Mesh(geo, mat);
  m.frustumCulled = false;
  m.renderOrder = 7;
  m.visible = false;
  return m;
}

// ------------------------------------------------------------------ ski basket
function basketFrame() {
  const L = 1.95, W = 0.36, H = 0.24, t = 0.028;
  const parts = [];
  for (const sx of [-1, 1]) for (const sy of [0, 1]) parts.push(new THREE.BoxGeometry(t, t, L).translate((sx * W) / 2, sy * H, 0));
  for (const z of [-L / 2, 0, L / 2]) {
    parts.push(new THREE.BoxGeometry(W + t, t, t).translate(0, 0, z));
    for (const sx of [-1, 1]) parts.push(new THREE.BoxGeometry(t, H, t).translate((sx * W) / 2, H / 2, z));
  }
  // mesh floor slats + two mounting struts down to the skid cross tubes
  for (let i = -3; i <= 3; i++) parts.push(new THREE.BoxGeometry(0.012, 0.012, L).translate((i * W) / 8, 0.004, 0));
  for (const z of [-L * 0.32, L * 0.32]) parts.push(new THREE.BoxGeometry(0.035, 0.42, 0.035).translate(-W * 0.25, -0.2, z));
  const m = new THREE.Mesh(mergeGeometries(parts), new THREE.MeshStandardMaterial({ color: 0x2b2f35, roughness: 0.45, metalness: 0.7 }));
  m.castShadow = true;
  return m;
}

// ------------------------------------------------------------------
export class HeliModel {
  /** @param {object} models  loaded GLTFs (heli_body optional) */
  constructor(models) {
    this.root = new THREE.Group();
    this.root.name = 'helicopter';
    this.airframe = new THREE.Group();
    this.airframe.scale.setScalar(K);
    this.airframe.position.copy(CG).multiplyScalar(-K);
    this.root.add(this.airframe);
    const body = meshyBody(models?.heli_body);
    this.meshy = !!body;
    this.airframe.add(body || proceduralBody());

    this.main = mainRotor();
    this.airframe.add(this.main.mastMesh, this.main.spin, this.main.disc);
    this.tail = tailRotor();
    this.airframe.add(this.tail.spin, this.tail.disc);
    this.angle = 0; this.tailAngle = 0;
    this.droop = -1;

    this.lights = glowPoints(LIGHTS.map((l) => l.p), LIGHTS.map((l) => l.s));
    this.root.add(this.lights);
    this.lightCol = this.lights.userData.color;

    this.basket = new THREE.Group();
    this.basket.position.copy(ANCHORS.basket).add(_v.set(0, -0.1, 0));
    this.basket.add(basketFrame());
    this.root.add(this.basket);
    this.rack = new THREE.Group(); // the skis + poles riding in the basket
    this.basket.add(this.rack);

    this.beam = beamMesh();
    this.beam.position.copy(ANCHORS.lamp);
    this.beam.rotation.x = LAMP_TILT; // forward and down
    this.root.add(this.beam);
    this.pool = poolMesh();
    this.lampOn = 0;
    // where the landing light is this frame (updateLamp: world): the lens, the way it shines, the snow it meets (len m
    // along it, hit: it does) and how bright (lit 0..1, night only); the police helicopter's SpotLight follows these
    this.lampAt = new THREE.Vector3(); this.lampDir = new THREE.Vector3(0, -1, 0); this.lampHit = new THREE.Vector3();
    this.lampLen = 0; this.lampHitOk = false; this.lit = 0;
  }

  addTo(scene) { scene.add(this.root, this.pool.mesh); }

  /** Put your own skis and poles in the basket (clones share geometry with the rig). */
  loadRack(rig) {
    this.clearRack();
    const ski = rig?.skis?.[0], pole = rig?.poles?.[0];
    if (ski) for (const sx of [-1, 1]) {
      const s = ski.clone();
      s.visible = true;
      s.position.set(sx * 0.075, 0.018, 0);
      s.rotation.set(0, 0, sx * 0.05);
      this.rack.add(s);
    }
    if (pole) for (const sx of [-1, 1]) {
      const p = pole.clone();
      p.visible = true;
      p.position.set(sx * 0.06, 0.08, -0.62);
      p.rotation.set(-Math.PI / 2, 0, 0);
      this.rack.add(p);
    }
  }
  clearRack() { for (let i = this.rack.children.length - 1; i >= 0; i--) this.rack.remove(this.rack.children[i]); }

  /**
   * Per frame.
   * @param {number} dt
   * @param {{rpm: number, night: number, time: number, lamp: boolean, camera: THREE.Camera, ground: (x, z) => number,
   *   snow?: number, aim?: THREE.Vector3}} s  aim: the light swung onto this world point (the police searchlight) instead
   *   of fixed LAMP_TILT under the nose
   */
  update(dt, s) {
    const rpm = s.rpm;
    // ---- rotors: spin, droop at rest / cone up a little at speed, blades fade into the blur disc
    this.angle = (this.angle - rpm * 26 * dt) % (Math.PI * 2); // clockwise seen from above
    this.tailAngle = (this.tailAngle + rpm * 120 * dt) % (Math.PI * 2);
    this.main.spin.rotation.y = this.angle;
    this.main.disc.rotation.y = this.angle;
    this.tail.spin.rotation.x = this.tailAngle;
    this.tail.disc.rotation.x = this.tailAngle;
    const droop = -0.045 + 0.07 * smooth(0.2, 1, rpm);
    if (Math.abs(droop - this.droop) > 1e-4) { this.droop = droop; for (const b of this.main.blades) b.rotation.z = droop; }
    const blur = smooth(0.28, 0.9, rpm);
    this.main.bladeMat.opacity = 1 - 0.72 * blur;
    // a spinning rotor casts no crisp blade shadows (they would flicker as a frozen cross)
    const sh = rpm < 0.45;
    if (sh !== this.bladeShadow) { this.bladeShadow = sh; for (const b of this.main.blades) b.children[0].castShadow = sh; }
    this.main.discMat.opacity = 0.78 * blur;
    this.main.disc.visible = blur > 0.01;
    this.tail.bladeMat.opacity = 1 - smooth(0.2, 0.6, rpm);
    this.tail.discMat.opacity = 0.7 * smooth(0.15, 0.55, rpm);
    this.tail.disc.visible = rpm > 0.12;
    this.tail.spin.children[1].visible = this.tail.bladeMat.opacity > 0.02;

    // ---- lamps: nav lights steady, beacons pulse, strobes double-flash, landing light lens
    const on = rpm > 0.05 ? 1 : 0, night = s.night, t = s.time;
    const day = 0.4 + 0.6 * night;
    const col = this.lightCol.array;
    const beat = (period, width, phase = 0) => { const x = ((t + phase) % period) / period; return x < width ? 1 : 0; };
    for (let i = 0; i < LIGHTS.length; i++) {
      const L = LIGHTS[i];
      let k = 0;
      if (L.kind === 'nav') k = on * 3.2 * day;
      else if (L.kind === 'beacon' || L.kind === 'beacon2') k = on * 5 * day * Math.max(beat(1.1, 0.13, L.kind === 'beacon2' ? 0.55 : 0), 0.05);
      else if (L.kind === 'strobe') k = on * 12 * day * Math.max(beat(1.6, 0.04), beat(1.6, 0.04, -0.12));
      else if (L.kind === 'lamp') k = s.lamp ? 9 : 0;
      col[i * 3] = L.c.r * k; col[i * 3 + 1] = L.c.g * k; col[i * 3 + 2] = L.c.b * k;
    }
    this.lightCol.needsUpdate = true;
    if (s.camera) glowScale(this.lights, s.camera);

    // ---- landing light: beam + lit pool where it meets the snow (night only)
    this.lampOn += ((s.lamp ? 1 : 0) - this.lampOn) * (1 - Math.exp(-dt * 6));
    // (Oct 30, the user, of the police searchlight: "make it also at day": aimed (the police), it shines by day too)
    const lit = (this.lit = this.lampOn * (s.aim ? Math.max(night, 0.6) : night));
    this.beam.visible = this.pool.mesh.visible = lit > 0.02;
    if (lit > 0.02) this.updateLamp(lit, s.ground, s.snow || 0, s.aim || null);
  }

  updateLamp(lit, ground, snow, aim = null) {
    // (Oct 30 2026, the user: "the helicopter from the police, the light that shines on you is very off. It should be
    // like the other helicopter light": the police helicopter now shines this same landing light, swung onto you (aim).
    // Its root's world matrix brought up to this frame's pose first: localToWorld otherwise used the last render's, the
    // beam a frame behind the helicopter that moved since)
    this.root.updateWorldMatrix(true, false);
    const lamp = this.lampAt.copy(ANCHORS.lamp);
    this.root.localToWorld(lamp);
    const q = this.root.getWorldQuaternion(_q);
    const dir = this.lampDir;
    let far = 160;
    if (aim) {
      // (aimed: the lens's way to the point, the beam mesh turned onto it in the root's frame; marched a little past it)
      dir.subVectors(aim, lamp);
      const l = dir.length();
      if (l > 0.01) { dir.multiplyScalar(1 / l); far = Math.max(160, l * 1.2); } else dir.set(0, -1, 0);
      this.beam.quaternion.copy(q).invert().multiply(_q2.setFromUnitVectors(FWD, dir));
    } else {
      dir.set(0, -Math.sin(LAMP_TILT), Math.cos(LAMP_TILT)).applyQuaternion(q);
      this.beam.rotation.set(LAMP_TILT, 0, 0);
    }
    // march along the beam to the snow
    let d = 0, hit = false;
    for (let s = 2; s <= far; s += s < 30 ? 2 : 5) {
      const x = lamp.x + dir.x * s, y = lamp.y + dir.y * s, z = lamp.z + dir.z * s;
      if (y <= ground(x, z)) { d = s; hit = true; break; }
    }
    const len = hit ? d : far;
    this.lampLen = len; this.lampHitOk = hit; this.lampHit.copy(lamp).addScaledVector(dir, len);
    this.beam.scale.set(len * Math.tan(0.3), len * Math.tan(0.3), len);
    this.beam.material.uniforms.uI.value = lit * (0.05 + 0.1 * snow) * Math.min(1, 25 / len);
    const P = this.pool;
    P.uniforms.uLamp.value.copy(lamp);
    P.uniforms.uDir.value.copy(dir);
    P.uniforms.uColor.value.setRGB(1, 0.93, 0.8).multiplyScalar(lit * 1.25);
    if (!hit) { P.mesh.visible = false; return; }
    const cx = lamp.x + dir.x * d, cz = lamp.z + dir.z * d;
    const size = Math.min(70, Math.max(8, d * 0.75));
    if (Math.hypot(cx - P.center.x, cz - P.center.z) < size * 0.08 && Math.abs(size - P.size) < size * 0.1) return;
    P.center.set(cx, 0, cz); P.size = size;
    // re-drape the grid on the terrain (only after it has moved a bit)
    const pos = P.mesh.geometry.attributes.position, nor = P.mesh.geometry.attributes.normal;
    const h = size, step = (2 * h) / (POOL_N - 1);
    for (let j = 0; j < POOL_N; j++) for (let i = 0; i < POOL_N; i++) {
      const x = cx - h + i * step, z = cz - h + j * step, k = j * POOL_N + i;
      pos.setXYZ(k, x, ground(x, z) + 0.25, z);
    }
    for (let j = 0; j < POOL_N; j++) for (let i = 0; i < POOL_N; i++) {
      const k = j * POOL_N + i;
      const xl = pos.getY(j * POOL_N + Math.max(0, i - 1)), xr = pos.getY(j * POOL_N + Math.min(POOL_N - 1, i + 1));
      const zl = pos.getY(Math.max(0, j - 1) * POOL_N + i), zr = pos.getY(Math.min(POOL_N - 1, j + 1) * POOL_N + i);
      const sx = (i > 0 && i < POOL_N - 1 ? 2 : 1) * step, sz = (j > 0 && j < POOL_N - 1 ? 2 : 1) * step;
      const nx = -(xr - xl) / sx, nz = -(zr - zl) / sz, l = Math.hypot(nx, 1, nz);
      nor.setXYZ(k, nx / l, 1 / l, nz / l);
    }
    pos.needsUpdate = true; nor.needsUpdate = true;
  }

  /** World position of an anchor (root-local metres). */
  world(anchor, out) { return this.root.localToWorld(out.copy(anchor)); }
}
