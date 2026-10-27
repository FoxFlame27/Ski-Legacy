// Floodlit night course (course.def.night): galvanised floodlight masts along both sides of the piste,
// alternating, just behind the B-nets in the cleared strip (nothing for a racer to hit), each with four
// lamps on a crossarm aimed across the run. While the session runs it is night: the snow is lit per pixel
// by the masts nearest the camera through the terrain's floodlight uniforms (the same warm pools as the
// resort's lit pistes, world/terrain.js + world/pistelights.js), written in scene.onBeforeRender so the
// resort lights (none out here) never override them, and the lamp glass and glow sprites shine.
//
//   buildFloodlightMasts(course)          -> THREE.Group (props.js, night courses); course.floodlights = masts
//   const fl = new CourseFloodlights(scene, course); fl.update(dt, env); fl.dispose();   (race session)
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { terrainUniforms, PL_MAX } from '../../world/terrain.js';
import { setLitObjects } from '../../world/pistelights.js';
import { quality } from '../../engine/quality.js';
import { world } from '../../world/world.js';
import { meshGround } from '../parkour/kit.js';
import { BARRIER } from '../parkour/track.js';

const MAST_H = 11;          // m: lamp crossarm height
const SPACING = 46;         // m between masts along the course (alternating sides)
const BEHIND = 3.0;         // m past the piste edge (the B-net stands at 0.6, the cleared strip reaches 4.5+)
const INTENSITY = 2600;     // per mast (terrain shader units, like the resort's masts)
const SEL_R = 600;          // m: masts considered for the per-pixel pools
const NIGHT_HOUR = 21.5;
const GALV = new THREE.Color('#a4aaae'), DARK = new THREE.Color('#24272b'), GLASS = new THREE.Color('#fff4dc');
const SKIP = new Set([BARRIER.tunnel, BARRIER.railing, BARRIER.none]);

function tinted(geo, color) {
  const n = geo.attributes.position.count, c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) c.set([color.r, color.g, color.b], i * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return geo.index ? geo.toNonIndexed() : geo;
}

/** Mast spots along a course: [{ x, z, y, yaw, lx, ly, lz, ax, ay, az }] (light centre + aim). */
export function planMasts(course) {
  const T = course.track, out = [];
  let side = 1, k = 0;
  for (let s = 6; s < Math.min(T.length - 10, course.finishS + 120); s += SPACING, k++) {
    // both sides at the start and in the finish arena, alternating along the run
    const sides = s < 30 || s > course.finishS - 40 ? [1, -1] : [side];
    side = -side;
    for (const sd of sides) {
      const code = T.codeAt(T.BAR[sd > 0 ? 1 : 0], s);
      if (SKIP.has(code)) continue;
      if (T.codeAt(T.AN[sd > 0 ? 1 : 0], s)) continue; // an A-net stands there
      const w = T.sAt(T.W, s);
      const p = T.pointAt(s, sd * (w + BEHIND));
      const y = meshGround(p.x, p.z);
      const aim = T.pointAt(s + 6, -sd * w * 0.45);
      const yaw = Math.atan2(aim.x - p.x, aim.z - p.z);
      const lx = p.x + Math.sin(yaw) * 0.35, lz = p.z + Math.cos(yaw) * 0.35, ly = y + MAST_H - 0.1;
      const ax = aim.x - lx, ay = aim.y - ly, az = aim.z - lz, al = Math.hypot(ax, ay, az);
      out.push({ x: p.x, z: p.z, y, yaw, lx, ly, lz, ax: ax / al, ay: ay / al, az: az / al });
    }
  }
  return out;
}

/** The masts as meshes (one merged body + emissive lamp glass), for the course group. */
export function buildFloodlightMasts(course) {
  const masts = (course.floodlights = planMasts(course));
  const g = new THREE.Group();
  g.name = 'course-floodlights';
  if (!masts.length) return g;
  const body = [], glass = [];
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1);
  for (const m of masts) {
    const base = new THREE.Matrix4().compose(new THREE.Vector3(m.x, m.y, m.z), q.setFromAxisAngle(up, m.yaw), one);
    const add = (geo, mat, list, color) => { geo.applyMatrix4(mat); list.push(tinted(geo, color)); };
    add(new THREE.CylinderGeometry(0.08, 0.13, MAST_H + 0.6, 10).translate(0, (MAST_H + 0.6) / 2 - 0.6, 0), base, body, GALV);
    add(new THREE.BoxGeometry(0.34, 1.1, 0.26).translate(0, 0.9, -0.17), base, body, GALV); // cable cabinet
    add(new THREE.BoxGeometry(2.3, 0.09, 0.09).translate(0, MAST_H + 0.2, 0.1), base, body, GALV); // crossarm
    // four lamps, tipped down toward the far side of the run, fanned a little along it
    const pitch = Math.atan2(-m.ay, Math.hypot(m.ax, m.az));
    for (const [x, fan] of [[-0.86, -0.32], [-0.29, -0.1], [0.29, 0.1], [0.86, 0.32]]) {
      const lm = base.clone().multiply(m4.compose(new THREE.Vector3(x, MAST_H, 0.28), new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, fan, 0, 'YXZ')), one));
      add(new THREE.BoxGeometry(0.52, 0.38, 0.14), lm, body, DARK);
      add(new THREE.PlaneGeometry(0.44, 0.3).translate(0, 0, 0.072), lm, glass, GLASS);
    }
  }
  const bodyMesh = new THREE.Mesh(mergeGeometries(body), new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.55, roughness: 0.42 }));
  bodyMesh.castShadow = true; bodyMesh.receiveShadow = true;
  const glassMat = new THREE.MeshStandardMaterial({ vertexColors: true, emissive: 0xffe2b8, emissiveIntensity: 0, roughness: 0.3 });
  const glassMesh = new THREE.Mesh(mergeGeometries(glass), glassMat);
  glassMesh.name = 'floodlight-glass';
  // glow: one soft additive sprite per mast (the lamps' halo, seen from afar)
  const pts = new Float32Array(masts.length * 3);
  masts.forEach((m, i) => { pts[i * 3] = m.lx; pts[i * 3 + 1] = m.ly + 0.15; pts[i * 3 + 2] = m.lz; });
  const pg = new THREE.BufferGeometry();
  pg.setAttribute('position', new THREE.BufferAttribute(pts, 3));
  const glow = new THREE.Points(pg, new THREE.PointsMaterial({ map: glowTexture(), color: 0xffe0b0, size: 7, sizeAttenuation: true, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: true }));
  glow.name = 'floodlight-glow';
  glow.frustumCulled = false;
  g.add(bodyMesh, glassMesh, glow);
  g.userData.lamps = { glassMat, glow };
  return g;
}

let glowTex = null;
function glowTexture() {
  if (glowTex || typeof document === 'undefined') return glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d'), gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.18, 'rgba(255,240,215,0.8)'); gr.addColorStop(0.5, 'rgba(255,210,160,0.16)'); gr.addColorStop(1, 'rgba(255,200,150,0)');
  x.fillStyle = gr; x.fillRect(0, 0, 64, 64);
  glowTex = new THREE.CanvasTexture(c);
  return glowTex;
}

/**
 * Night for a floodlit course while a session runs: sets the hour to NIGHT_HOUR (restored on dispose), turns
 * the lamps on and lights the snow under the masts nearest the camera every frame.
 */
export class CourseFloodlights {
  constructor(scene, course, group) {
    this.scene = scene;
    this.masts = course.floodlights || [];
    this.lamps = group?.getObjectByName?.('course-floodlights')?.userData.lamps || null;
    this.on = 0;
    this.env = globalThis.__game?.env || null;
    this.prevHour = this.env ? this.env.hour : null;
    if (this.env) this.env.hour = NIGHT_HOUR;
    this.cam = new THREE.Vector3();
    this.selD = new Float64Array(PL_MAX + 1); this.selI = new Int32Array(PL_MAX + 1);
    this.hadOwn = Object.prototype.hasOwnProperty.call(scene, 'onBeforeRender');
    this.prevHook = scene.onBeforeRender;
    const self = this;
    scene.onBeforeRender = function (renderer, sc, camera, rt) {
      self.prevHook?.call(this, renderer, sc, camera, rt);
      if (camera?.isCamera) self.write(camera.position);
    };
  }

  /** Per frame: the lamps fade on at dusk (and stay on: it is night for the whole race). */
  update(dt) {
    const target = this.env ? Math.max(0.25, Math.min(1, (this.env.nightFactor - 0.25) / 0.35)) : 1;
    this.on += (target - this.on) * Math.min(1, dt * 1.5);
    if (this.lamps) {
      this.lamps.glassMat.emissiveIntensity = 3.2 * this.on;
      this.lamps.glow.material.opacity = 0.85 * this.on;
    }
  }

  // the masts nearest the camera into the terrain's per-pixel floodlight uniforms (after the resort's own
  // lights have written theirs this frame: there are none within reach out here)
  write(cam) {
    const U = terrainUniforms, M = this.masts, selD = this.selD, selI = this.selI;
    let n = 0;
    for (let i = 0; i < M.length; i++) {
      const m = M[i], d2 = (m.lx - cam.x) ** 2 + (m.ly - cam.y) ** 2 + (m.lz - cam.z) ** 2;
      if (d2 > SEL_R * SEL_R) continue;
      if (n >= PL_MAX && d2 >= selD[PL_MAX - 1]) continue;
      let k = Math.min(n, PL_MAX - 1);
      while (k > 0 && selD[k - 1] > d2) { selD[k] = selD[k - 1]; selI[k] = selI[k - 1]; k--; }
      selD[k] = d2; selI[k] = i;
      if (n < PL_MAX) n++;
    }
    const pos = U.uPLPos.value, aim = U.uPLAim.value, P = U.uPLParams.value;
    for (let k = 0; k < n; k++) {
      const m = M[selI[k]];
      pos[k * 4] = m.lx; pos[k * 4 + 1] = m.ly; pos[k * 4 + 2] = m.lz; pos[k * 4 + 3] = INTENSITY * this.on;
      aim[k * 4] = m.ax; aim[k * 4 + 1] = m.ay; aim[k * 4 + 2] = m.az; aim[k * 4 + 3] = 0;
    }
    P[0] = n && this.on > 0.01 ? 1 : 0; P[1] = n; P[2] = 1e4; P[3] = 45;
    U.uPLMapK.value = 0;
    U.uPLColor.value.set([1, 0.83, 0.64]);
    setLitObjects(this.on > 0.01 ? n : 0, quality.lights.obj); // the racers are lit by the floods too, not only the snow
  }

  dispose() {
    if (this.hadOwn) this.scene.onBeforeRender = this.prevHook;
    else delete this.scene.onBeforeRender; // back to three's own (empty) hook
    terrainUniforms.uPLParams.value[0] = 0;
    setLitObjects(0);
    if (this.env && this.prevHour !== null) this.env.hour = this.prevHour;
  }
}
