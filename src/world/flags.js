// Flag masts in the resort's house style (SKI LEGACY blue / white / red, italic condensed lettering like the
// arena banners): a row of three in the village plaza (the main entrance, by the Legacy Gondola) and one each
// side of every World Cup finish; nothing else (decluttered Oct 27: "hardly any flags"). All cloths are one InstancedMesh that streams out downwind and ripples in
// the vertex shader (stronger in a snowstorm); the masts are one merged mesh. Every mast stands on level
// snow clear of the runs, nets, lift lines and colliders; masts are colliders themselves (this.colliders).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { world } from './world.js';
import { layout } from './layout.js';
import { SIGN_FONT } from './resortdressing.js';
import { qualityLevel, getRunIndex, hitsCollider } from './crowds.js';

const MAST_H = 9;
const BASE_PAIRS = false; // flags at the gondola bases out of the village (off: hardly any flags)
const CLOTH_W = 2.6, CLOTH_H = 1.55;
// the wind blows the snow toward +x (atmosphere.js drifts it (1.5..4, 0.6) m/s): the flags agree
const WIND = new THREE.Vector2(2.6, 0.7).normalize();

const DESIGNS = [
  { bg: '#1546c8', fg: '#ffffff', text: 'SKI LEGACY', bar: '#e2231a' },
  { bg: '#ffffff', fg: '#1546c8', text: 'SKI LEGACY', bar: '#1546c8' },
  { bg: '#d9221c', fg: '#ffffff', text: 'LEGACY', bar: '#ffffff' },
  { bg: '#1d2533', fg: '#ffffff', text: 'WORLD CUP', bar: '#e2231a' },
];

function flagAtlas() {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 512;
  const paint = () => {
    const g = c.getContext('2d');
    DESIGNS.forEach((d, i) => {
      const x = (i % 2) * 512, y = Math.floor(i / 2) * 256, w = 512, h = 256;
      g.fillStyle = d.bg; g.fillRect(x, y, w, h);
      // hoist band + a stripe along the bottom (house style)
      g.fillStyle = d.bar; g.fillRect(x, y + h * 0.8, w, h * 0.07);
      g.fillStyle = d.fg; g.fillRect(x, y + h * 0.87, w, h * 0.13);
      g.fillStyle = d.fg; g.textAlign = 'center'; g.textBaseline = 'middle';
      let size = 104;
      g.font = `italic 700 ${size}px ${SIGN_FONT}`;
      while (g.measureText(d.text).width > w * 0.8 && size > 24) { size -= 4; g.font = `italic 700 ${size}px ${SIGN_FONT}`; }
      g.fillText(d.text, x + w / 2 + 10, y + h * 0.42);
    });
  };
  paint();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  const probe = `italic 700 40px ${SIGN_FONT}`;
  if (document.fonts && !document.fonts.check(probe)) document.fonts.load(probe).then(() => { paint(); t.needsUpdate = true; }).catch(() => {});
  return t;
}

// a mast spot: level snow, clear of runs / nets / lift lines / colliders (and of masts already placed)
function clear(x, z, colliders, placed, idx) {
  if (idx.clearance(x, z) < 2.5 || idx.netDist(x, z) < 2 || idx.liftDist(x, z) < 2) return false;
  if (hitsCollider(colliders, x, z, 1.4)) return false;
  for (const p of placed) if (Math.hypot(p.x - x, p.z - z) < 2.4) return false;
  const y = world.height(x, z);
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2;
    if (Math.abs(world.height(x + Math.cos(a) * 1.2, z + Math.sin(a) * 1.2) - y) > 0.45) return false;
  }
  return true;
}

export class Flags {
  /**
   * @param {THREE.Scene} scene
   * @param {object} o
   * @param {Array} [o.colliders]  everything already standing (the masts keep clear of it)
   * @param {object} [o.village]   Village (its shop door / ticket counter: the plaza row keeps off their paths)
   * @param {string} [o.quality]
   */
  constructor(scene, { colliders = [], village = null, quality } = {}) {
    this.level = qualityLevel(quality);
    this.colliders = [];
    this.group = new THREE.Group();
    this.group.name = 'flags';
    scene.add(this.group);
    this.time = { value: 0 };
    this.wind = { value: 0.5 };
    const idx = getRunIndex();
    const masts = []; // { x, z, d }
    const tryRow = (cands, n, gap, designs) => {
      // first candidate centre where a whole row of n masts (spaced `gap` along `row`) fits
      for (const c of cands) {
        const row = [];
        for (let k = 0; k < n; k++) {
          const o = (k - (n - 1) / 2) * gap, x = c.x + c.rx * o, z = c.z + c.rz * o;
          if (!clear(x, z, colliders, masts.concat(row), idx)) break;
          row.push({ x, z, d: designs[k % designs.length] });
        }
        if (row.length === n) { masts.push(...row); return true; }
      }
      return false;
    };
    // 1. the village plaza: a row of three facing the plaza, between the Christmas tree ring and the lamps,
    //    on the gondola side, off the paths to the shop / ticket booth / gondola
    {
      const paths = [[0, -54], [-40, -18], [15, -50]];
      if (village?.shopDoor) paths[1] = [village.shopDoor.x, village.shopDoor.z];
      if (village?.booth?.counter) paths[2] = [village.booth.counter.x, village.booth.counter.z];
      const cands = [];
      // off to the west of the tree, so the row reads beside it from the plaza (not hidden behind it)
      const angles = [-0.7, -0.6, -0.8, -0.9, -0.5, 0.7, 0.6, 0.8, 0.5, -0.36, 0.36, 0];
      for (const a of angles) for (const r of [25, 23, 27]) {
        const x = Math.sin(a) * r, z = -6 - Math.cos(a) * r; // a = 0: due north of the tree (toward the gondola), - = west
        // keep off the paths (spokes from the tree ring)
        let off = Infinity;
        for (const [px, pz] of paths) off = Math.min(off, segDist(x, z, 0, -4, px, pz));
        if (off < 6) continue;
        cands.push({ x, z, rx: Math.cos(a), rz: Math.sin(a) }); // the row runs across the radius
      }
      tryRow(cands, 3, 3.2, [0, 1, 2]);
    }
    // 2. (no longer: a pair beside each gondola base station outside the village)
    if (BASE_PAIRS) {
      for (const l of layout.lifts) {
        if (l.type !== 'gondola' || Math.hypot(l.bottom.x, l.bottom.z + 6) < 260) continue;
        const dx = l.dir[0], dz = l.dir[1], sx = -dz, sz = dx;
        const cands = [];
        for (const back of [12, 16, 20, 8]) for (const side of [1, -1]) for (const off of [12, 15, 18]) {
          cands.push({ x: l.bottom.x - dx * back + sx * side * off, z: l.bottom.z - dz * back + sz * side * off, rx: dx, rz: dz });
        }
        tryRow(cands, 2, 3.2, [1, 0]);
      }
    }
    // 3. one each side of every World Cup finish, behind the spectators near the line
    {
      for (const r of layout.races) {
        if (!r.arena) continue;
        const n = r.path.length, [fx, fz] = r.path[n - 1], [px, pz] = r.path[Math.max(0, n - 4)];
        const fl = Math.hypot(fx - px, fz - pz) || 1, dx = (fx - px) / fl, dz = (fz - pz) / fl;
        for (const side of [1, -1]) {
          const cands = [];
          for (const back of [14, 18, 10, 24, 30]) for (const lat of [5.8, 6.6, 7.6]) {
            const off = r.halfWidth + lat;
            cands.push({ x: fx - dx * back - dz * side * off, z: fz - dz * back + dx * side * off, rx: dx, rz: dz });
          }
          tryRow(cands, 1, 7, side > 0 ? [3] : [0]);
        }
      }
    }
    this.masts = masts;
    if (masts.length) this.build(masts);
  }

  build(masts) {
    const n = masts.length;
    // masts: white poles, a finial and a base collar, merged into one mesh
    const parts = [];
    const pole = new THREE.CylinderGeometry(0.05, 0.075, MAST_H + 0.4, 10);
    const ball = new THREE.SphereGeometry(0.1, 10, 6);
    const collar = new THREE.CylinderGeometry(0.16, 0.2, 0.35, 10);
    const yaw = Math.atan2(-WIND.y, WIND.x);
    for (const m of masts) {
      const y = world.height(m.x, m.z);
      m.y = y;
      parts.push(pole.clone().translate(m.x, y + MAST_H / 2 - 0.2, m.z));
      parts.push(ball.clone().translate(m.x, y + MAST_H + 0.08, m.z));
      parts.push(collar.clone().translate(m.x, y + 0.1, m.z));
      this.colliders.push({ x: m.x, z: m.z, r: 0.2 });
    }
    const mastMesh = new THREE.Mesh(mergeGeometries(parts), new THREE.MeshStandardMaterial({ color: 0xeef1f5, roughness: 0.35, metalness: 0.55 }));
    for (const p of parts) p.dispose();
    pole.dispose(); ball.dispose(); collar.dispose();
    mastMesh.castShadow = true; mastMesh.receiveShadow = true;
    mastMesh.matrixAutoUpdate = false;
    this.group.add(mastMesh);

    // cloths: hoisted at x = 0, streaming out along +x (turned downwind)
    const seg = this.level >= 2 ? 14 : 8;
    const cloth = new THREE.PlaneGeometry(CLOTH_W, CLOTH_H, seg, 4);
    cloth.translate(CLOTH_W / 2 + 0.06, -CLOTH_H / 2, 0);
    const aFlag = new Float32Array(n * 2);
    const mesh = new THREE.InstancedMesh(cloth, this.material(), n);
    const d = new THREE.Object3D();
    masts.forEach((m, i) => {
      d.position.set(m.x, m.y + MAST_H - 0.25, m.z);
      d.rotation.set(0, yaw + Math.sin(m.x * 3.1 + m.z) * 0.06, 0);
      d.updateMatrix();
      mesh.setMatrixAt(i, d.matrix);
      aFlag[i * 2] = m.d; aFlag[i * 2 + 1] = (Math.sin(m.x * 12.9 + m.z * 78.2) * 0.5 + 0.5) * 6.28;
    });
    cloth.setAttribute('aFlag', new THREE.InstancedBufferAttribute(aFlag, 2));
    mesh.castShadow = this.level >= 2; mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    mesh.name = 'flag-cloths';
    this.group.add(mesh);
    this.cloths = mesh;
  }

  material() {
    const tex = flagAtlas();
    const mat = new THREE.MeshStandardMaterial({ map: tex, color: tex ? 0xffffff : 0x1546c8, roughness: 0.78, side: THREE.DoubleSide });
    const { time, wind } = this;
    const wave = /* glsl */`
      float fx = clamp(position.x / ${CLOTH_W.toFixed(2)}, 0.0, 1.0);
      float ph = aFlag.y;
      float k1 = position.x * 2.3 - uTime * (4.2 + uWind * 2.5) + ph;
      float k2 = position.x * 4.1 - uTime * (6.3 + uWind * 3.0) + ph * 1.7 + position.y * 0.8;
      float amp = (0.16 + uWind * 0.16) * (0.15 + 0.85 * fx);
      float wz = (sin(k1) * 0.62 + sin(k2) * 0.3) * amp;
      float dwz = (cos(k1) * 2.3 * 0.62 + cos(k2) * 4.1 * 0.3) * amp;
    `;
    mat.onBeforeCompile = (s) => {
      s.uniforms.uTime = time;
      s.uniforms.uWind = wind;
      s.vertexShader = s.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uWind;\nattribute vec2 aFlag;')
        .replace('#include <uv_vertex>', `#include <uv_vertex>
          #ifdef USE_MAP
            vMapUv = vec2(mod(aFlag.x, 2.0) * 0.5, (1.0 - floor(aFlag.x / 2.0)) * 0.5) + vMapUv * 0.5;
          #endif`)
        .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
          {
            ${wave}
            objectNormal = normalize(vec3(-dwz, 0.0, 1.0));
          }`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          {
            ${wave}
            transformed.z += wz;
            transformed.x -= abs(wz) * 0.25 * fx;                     // the ripples take up a little length
            transformed.y -= fx * fx * (0.22 - uWind * 0.16);          // a light breeze lets the fly droop
          }`);
    };
    mat.customProgramCacheKey = () => 'resort-flag-v1';
    return mat;
  }

  /** @param {number} dt  @param {object} [env] (env.snow: storms blow harder) */
  update(dt, env) {
    if (!this.cloths) return;
    this.time.value = (this.time.value + dt) % 3600;
    const target = 0.35 + (env?.snow ?? 0) * 0.6;
    this.wind.value += (target - this.wind.value) * Math.min(1, dt * 0.3);
  }
}

function segDist(px, pz, ax, az, bx, bz) {
  const ex = bx - ax, ez = bz - az, l2 = ex * ex + ez * ez || 1;
  let t = ((px - ax) * ex + (pz - az) * ez) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(ax + ex * t - px, az + ez * t - pz);
}
