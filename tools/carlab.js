// Dev-only car lab: contact sheets of the car models (no game boot).
//   ?mode=raw     each model as it comes in (no turn), seen from above with +x (red) and +z (blue) arrows
//   ?mode=fit     each car template as the game uses it (should all show their nose: camera ahead of +z)
//   ?mode=cockpit the driver's view of each drivable car (the model you get when driving), wheel turned a bit
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { loadGLB } from '../src/core/assets.js';
import { carTemplate, carInstance, driverEye, fitCar } from '../src/game/cars.js';
import { lampsOn } from '../src/game/carlights.js';

const q = new URLSearchParams(location.search);
const mode = q.get('mode') || 'raw';
const LEN = { car_bmw_x3: 4.7, car_audi_rs6: 5.0, car_vw_golf_gti: 4.3, car_tesla_m3: 4.7, car_mercedes_sls: 4.64, car_porsche_taycan: 4.96, car_lamborghini_huracan: 4.52, car_toyota_gr_yaris: 3.99, car_audi_etron_gt: 4.96, car_mercedes_gls: 5.2 };
const ALL = ['car_bmw_x3', 'car_audi_rs6', 'car_vw_golf_gti', 'car_tesla_m3', 'car_mercedes_sls', 'car_porsche_taycan', 'car_lamborghini_huracan', 'car_toyota_gr_yaris', 'car_audi_etron_gt', 'car_mercedes_gls', 'car_audi_rs6_full', 'car_vw_golf_gti_full', 'car_tesla_m3_full'];
const DRIVE = ['car_bmw_x3', 'car_audi_rs6_full', 'car_vw_golf_gti_full', 'car_tesla_m3_full', 'car_mercedes_sls', 'car_porsche_taycan', 'car_lamborghini_huracan', 'car_toyota_gr_yaris', 'car_audi_etron_gt', 'car_mercedes_gls'];
const names = (q.get('cars') || '').split(',').filter(Boolean);
const list = names.length ? names : mode === 'cockpit' ? DRIVE : ALL;
const COLS = +(q.get('cols') || (mode === 'cockpit' ? 3 : 4)), CW = +(q.get('w') || 480), CH = +(q.get('h') || 300);
const ROWS = Math.ceil(list.length / COLS);
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(CW * COLS, CH * ROWS);
renderer.domElement.id = 'c';
renderer.setScissorTest(true);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9cc3e8);
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.add(new THREE.HemisphereLight(0xdfeeff, 0x8899aa, 0.9));
const sun = new THREE.DirectionalLight(0xfff4e8, 2.4); sun.position.set(30, 60, 40); scene.add(sun);
if (q.get('night')) { scene.background = new THREE.Color(0x0b1224); sun.intensity = 0.15; scene.environmentIntensity = 0.08; }
const ground = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000), new THREE.MeshStandardMaterial({ color: 0xe9eef5, roughness: 0.9 }));
ground.rotation.x = -Math.PI / 2; ground.position.y = -0.01; scene.add(ground);
const cam = new THREE.PerspectiveCamera(32, CW / CH, 0.03, 500);
const base = (lenName) => LEN[lenName.replace(/_full$/, '')] || 4.6;
const info = [];
const cells = [];
for (const [i, n] of list.entries()) {
  const gltf = await loadGLB(n);
  const at = new THREE.Vector3(i * 30, 0, 0);
  if (!gltf) { info.push(`${n}: missing`); cells.push(null); continue; }
  let obj, eye = null, steer = null;
  if (mode === 'mats') {
    const t = carTemplate(gltf, base(n), n);
    info.push(`${n}: L ${t.size.z.toFixed(2)} H ${t.size.y.toFixed(2)}`);
    const src = fitCar(gltf, base(n), n); src.updateMatrixWorld(true);
    const rows = new Map();
    src.traverse((o) => {
      if (!o.isMesh) return;
      const bb = new THREE.Box3().setFromObject(o), c = bb.getCenter(new THREE.Vector3()), sz = bb.getSize(new THREE.Vector3());
      const mats = [].concat(o.material).map((m) => (m?.name || '?') + (m?.emissive && m.emissive.getHex() ? '*E' : '') + (m?.transparent || m?.transmission > 0 ? '*T' : '')).join('|');
      const key = mats;
      const r = rows.get(key) || { n: 0, meshes: [], z0: Infinity, z1: -Infinity, y0: Infinity, y1: -Infinity };
      r.n++; if (r.meshes.length < 3) r.meshes.push(o.name.slice(0, 40)); r.z0 = Math.min(r.z0, bb.min.z); r.z1 = Math.max(r.z1, bb.max.z); r.y0 = Math.min(r.y0, bb.min.y); r.y1 = Math.max(r.y1, bb.max.y);
      rows.set(key, r);
    });
    for (const [k, r] of rows) info.push(`   [${k.slice(0, 70)}] x${r.n} z ${r.z0.toFixed(2)}..${r.z1.toFixed(2)} y ${r.y0.toFixed(2)}..${r.y1.toFixed(2)} :: ${r.meshes.join(', ')}`);
    cells.push(null);
    continue;
  }
  if (mode === 'grip') {
    // the driving hands on the BMW's wheel: ?hand=driving_hand_c&rx&ry&rz (degrees: the model into the fist frame
    // X back of hand, Y grip axis toward the thumb, Z knuckles), &s (model size: its longest side, m), &ox&oy&oz
    // (the grip hole in the model, as a share of its size), &turn (wheel, radians)
    const carG = await loadGLB('car_bmw_x3'), hg = await loadGLB(q.get('hand') || 'driving_hand_c');
    const t = carTemplate(carG, 4.7, 'car_bmw_x3'), inst = carInstance(t, { wheels: true });
    scene.add(inst.group);
    const S = t.steering, tilt = S.tilt ?? 0.38, ca = Math.cos(tilt), sa = Math.sin(tilt), rr = S.rimR * 0.98;
    const A = new THREE.Vector3(0, -sa, ca), U = new THREE.Vector3(0, ca, sa), X = new THREE.Vector3(1, 0, 0);
    const g0 = hg.scene.clone(true); g0.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(g0), cc = bb.getCenter(new THREE.Vector3());
    // the model's grip axis (toward the thumb) and forearm (fist -> sleeve) -> the fist frame (X back of the hand,
    // Y grip axis, Z knuckles; the forearm along -Z)
    const Gm = new THREE.Vector3(+(q.get('gx') ?? 1), +(q.get('gy') ?? 0), +(q.get('gz') ?? 0)).normalize();
    const Fm = new THREE.Vector3(+(q.get('fx') ?? 0.65), +(q.get('fy') ?? 0.42), +(q.get('fz') ?? -0.63)).normalize();
    const zm = Fm.clone().addScaledVector(Gm, -Fm.dot(Gm)).normalize().negate(), xm = new THREE.Vector3().crossVectors(Gm, zm);
    const toFist = new THREE.Matrix4().makeBasis(xm, Gm, zm).transpose();
    // the length along the forearm -> the scale (fingertips to the sleeve's end ~ &s m)
    let lo = Infinity, hi = -Infinity;
    g0.traverse((o) => { if (!o.isMesh) return; const P = o.geometry.attributes.position, v = new THREE.Vector3(); for (let i = 0; i < P.count; i += 7) { v.fromBufferAttribute(P, i).applyMatrix4(o.matrixWorld); const d = v.dot(Fm); if (d < lo) lo = d; if (d > hi) hi = d; } });
    const k = (+(q.get('s') ?? 0.46)) / (hi - lo);
    // the grip hole: from the fist end along the forearm by &gf of the length, plus &ox,oy,oz (model units)
    const hole = cc.clone().addScaledVector(Fm, (lo + (hi - lo) * (+(q.get('gf') ?? 0.16))) - cc.dot(Fm)).add(new THREE.Vector3(+(q.get('ox') ?? 0), +(q.get('oy') ?? 0), +(q.get('oz') ?? 0)));
    const fix = new THREE.Euler(0, 0, 0);
    const roll = THREE.MathUtils.degToRad(+(q.get('roll') ?? 0));
    for (const [i, phi] of [[0, 1.15], [1, -1.15]]) {
      const hand = new THREE.Group(); hand.matrixAutoUpdate = false;
      const inner = new THREE.Group(); inner.matrixAutoUpdate = false;
      inner.matrix.copy(new THREE.Matrix4().makeScale(k, k, k).multiply(toFist).multiply(new THREE.Matrix4().makeTranslation(-hole.x, -hole.y, -hole.z)));
      const m = g0.clone(true); inner.add(m); hand.add(inner); void fix;
      const radial = X.clone().multiplyScalar(Math.sin(phi)).addScaledVector(U, Math.cos(phi));
      const T = X.clone().multiplyScalar(Math.cos(phi)).addScaledVector(U, -Math.sin(phi));
      const Y = i === 0 ? T.clone().negate() : T.clone();
      const back = radial.clone().addScaledVector(A, -0.75).applyAxisAngle(Y, i === 0 ? roll : -roll);
      back.addScaledVector(Y, -back.dot(Y)).normalize();
      const Z = i === 0 ? new THREE.Vector3().crossVectors(back, Y) : new THREE.Vector3().crossVectors(Y, back);
      hand.matrix.makeBasis(back, Y, Z).setPosition(radial.clone().multiplyScalar(rr));
      inst.steering.col.add(hand);
    }
    inst.steering.col.quaternion.setFromAxisAngle(inst.steering.axis, +(q.get('turn') ?? 0));
    const eye = driverEye(t);
    cells.push({ n: 'grip', at: new THREE.Vector3(), eye });
    cells.push({ n: 'grip side', at: new THREE.Vector3(), eye: eye.clone().add(new THREE.Vector3(0.55, -0.15, 0.25)), side: true });
    list.length = 1;
    break;
  }
  if (mode === 'model') {
    // one model as it comes in, centred, with axes (x red, y green, z blue), seen along +x, +y, +z and a 3/4 view
    const g0 = gltf.scene.clone(true); g0.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(g0), sz = bb.getSize(new THREE.Vector3()), cc = bb.getCenter(new THREE.Vector3());
    const k = 1 / Math.max(sz.x, sz.y, sz.z);
    const holder = new THREE.Group(); g0.position.sub(cc); holder.add(g0); holder.scale.setScalar(k); scene.add(holder);
    const axes = new THREE.AxesHelper(0.7); axes.material.depthTest = false; axes.renderOrder = 9; scene.add(axes);
    info.push(`${n}: size ${sz.toArray().map((v) => v.toFixed(3))} centre ${cc.toArray().map((v) => v.toFixed(3))}`);
    for (const view of ['x', 'y', 'z', 'q']) cells.push({ n: `${n} ${view}`, at: new THREE.Vector3(), view });
    ground.visible = false;
    break;
  }
  if (mode === 'lamps') {
    // two copies: running lights (left), braking (right); seen from behind (or the front with ?front=1), at night
    const t = carTemplate(gltf, base(n), n);
    for (const [k, brake] of [[0, 0], [1, 1]]) {
      const inst = carInstance(t, { wheels: true });
      const o = inst.group; o.position.set(at.x + k * 6, 0, 0); scene.add(o);
      for (let f = 0; f < 3; f++) lampsOn(inst, q.get('front') ? 1 : 0, 1, brake, { reverse: !!q.get('rev') && k === 1 });
    }
    info.push(`${n}: head ${t.lamps.head.length} tail ${t.lamps.tail.length} third ${t.lamps.third?.length || 0}`);
    cells.push({ n, at, eye: null, lamps: true });
    continue;
  }
  if (mode === 'wheels') {
    const t = carTemplate(gltf, base(n), n);
    const inst = carInstance(t, { wheels: true });
    const red = new THREE.MeshStandardMaterial({ color: 0xff2020, emissive: 0x801010, roughness: 0.6 });
    for (const w of inst.wheels) { w.roll.rotation.x = 0.8; if (w.front) w.steer.rotation.y = 0.4; w.roll.traverse((o) => { if (o.isMesh && q.get('tint')) o.material = red; }); }
    obj = inst.group; obj.position.copy(at);
    const fw = (t.wheels || []).find((w) => w.front && w.c.x > 0) || (t.wheels || [])[0];
    info.push(`${n}: wheels ${(t.wheels || []).map((w) => `c(${w.c.x.toFixed(2)},${w.c.y.toFixed(2)},${w.c.z.toFixed(2)}) r${w.r.toFixed(2)} tris${w.parts.reduce((k, p) => k + p.geometry.index.count / 3, 0)}`).join(' ')}`);
    scene.add(obj);
    cells.push({ n, at, eye: null, wheel: fw ? fw.c.clone().add(at) : at.clone().add(new THREE.Vector3(0.8, 0.35, 1.4)) });
    continue;
  }
  if (mode === 'raw') {
    obj = gltf.scene.clone(true);
    obj.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(obj), s = b.getSize(new THREE.Vector3()), c = b.getCenter(new THREE.Vector3());
    const k = 4.6 / Math.max(s.x, s.z);
    const g = new THREE.Group(); obj.position.sub(c).multiplyScalar(1); g.add(obj); g.scale.setScalar(k); g.position.set(at.x, (s.y / 2) * k, 0);
    obj = g;
    info.push(`${n}: raw ${s.x.toFixed(3)} x ${s.y.toFixed(3)} x ${s.z.toFixed(3)} (x y z)`);
  } else {
    const t = carTemplate(gltf, base(n), n);
    const inst = carInstance(t, { wheels: true });
    obj = inst.group; obj.position.copy(at);
    if (q.get('lod')) { // (&lod=1: the far LOD instead, as parking / traffic show it out past their LOD distance)
      for (let k = 0; k < 600 && !t.lod; k++) await new Promise((r) => setTimeout(r, 50));
      if (t.lod) { inst.full.visible = false; obj.add(new THREE.Mesh(t.lod.geometry, t.lod.material)); info.push(`   lod tris ${t.lod.geometry.index.count / 3}`); }
    }
    if (inst.steering) {
      inst.steering.col.quaternion.setFromAxisAngle(inst.steering.axis, +(q.get('turn') ?? 0.9)); steer = t.steering.c;
      if (q.get('tint')) { const red = new THREE.MeshStandardMaterial({ color: 0xff3030, emissive: 0x601010 }); inst.steering.col.traverse((o) => { if (o.isMesh) o.material = red; }); }
      const sb = new THREE.Box3(); for (const p of t.steering.parts) { p.geometry.computeBoundingBox(); sb.union(p.geometry.boundingBox); }
      info.push(`   steering parts ${t.steering.parts.length} tris ${t.steering.parts.reduce((k, p) => k + p.geometry.index.count / 3, 0)} size ${sb.getSize(new THREE.Vector3()).toArray().map((v) => v.toFixed(2))}`);
    }
    for (const w of inst.wheels) if (w.front) w.steer.rotation.y = 0.35;
    eye = driverEye(t);
    info.push(`${n}: ${t.size.z.toFixed(2)} x ${t.size.x.toFixed(2)} x ${t.size.y.toFixed(2)} wheels ${inst.wheels.length} steering ${t.steering ? t.steering.c.toArray().map((v) => v.toFixed(2)).join(',') + ' (' + (t.steering.how || '') + ')' : 'NONE'} eye ${eye.toArray().map((v) => v.toFixed(2)).join(',')}`);
    if (mode === 'cockpit' && (!t.steering || q.get('detect'))) {
      // the steering wheel from the driver's seat: a fan of rays forward and down, the nearest surfaces
      const f = fitCar(gltf, base(n), n); f.updateMatrixWorld(true);
      const meshes = []; f.traverse((o) => { if (o.isMesh) meshes.push(o); });
      const rc = new THREE.Raycaster(); rc.near = 0.05; rc.far = 1.2;
      const e0 = driverEye(t), hits = [];
      for (let p = -0.1; p >= -0.75; p -= 0.03) for (let yw = -0.32; yw <= 0.32; yw += 0.04) {
        rc.set(e0, new THREE.Vector3(Math.sin(yw) * Math.cos(p), Math.sin(p), Math.cos(yw) * Math.cos(p)));
        const h = rc.intersectObjects(meshes, false).find((x) => { const m = x.object.material; return !(m.transparent || m.transmission > 0 || /glass|glas$|window/i.test(m.name || '')); });
        if (h) hits.push({ d: h.distance, p: h.point.clone(), name: h.object.name + ' [' + (h.object.material.name || '') + ']' });
      }
      hits.sort((a, b) => a.d - b.d);
      const dmin = hits[0]?.d ?? 0, near = hits.filter((h) => h.d < dmin + 0.14);
      const bb = new THREE.Box3(); for (const h of near) bb.expandByPoint(h.p);
      const names = {}; for (const h of near) names[h.name] = (names[h.name] || 0) + 1;
      info.push(`   detect: ${hits.length} hits, dmin ${dmin.toFixed(2)}, near ${near.length}: c ${bb.getCenter(new THREE.Vector3()).toArray().map((v) => v.toFixed(3))} s ${bb.getSize(new THREE.Vector3()).toArray().map((v) => v.toFixed(3))}`);
      for (const [k, v] of Object.entries(names).sort((a, b) => b[1] - a[1]).slice(0, 6)) info.push(`      ${v} x ${k.slice(0, 140)}`);
    }
    if (mode === 'fit' && q.get('cand')) {
      const f = fitCar(gltf, base(n), n); f.updateMatrixWorld(true);
      f.traverse((o) => {
        if (!o.isMesh) return;
        const bb = new THREE.Box3().setFromObject(o), c = bb.getCenter(new THREE.Vector3()), s = bb.getSize(new THREE.Vector3());
        if (c.x > 0.05 && c.x < 0.8 && c.y > 0.5 && c.y < 1.35 && c.z > -0.8 && c.z < 1.8 && Math.max(s.x, s.y, s.z) < 0.7 && Math.max(s.x, s.y, s.z) > 0.12)
          info.push(`   cand ${o.name} [${[].concat(o.material).map((m) => m?.name).join(',')}] c ${c.toArray().map((v) => v.toFixed(2))} s ${s.toArray().map((v) => v.toFixed(2))} tris ${(o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3}`);
      });
    }
  }
  scene.add(obj);
  if (mode !== 'cockpit') {
    const ax = (dir, col) => { const a = new THREE.ArrowHelper(dir, new THREE.Vector3(at.x, 0.05, 0), 3.6, col, 0.6, 0.35); scene.add(a); };
    ax(new THREE.Vector3(0, 0, 1), 0x1040ff); ax(new THREE.Vector3(1, 0, 0), 0xff2020);
  }
  if (steer && mode === 'cockpit') { const m = new THREE.Mesh(new THREE.SphereGeometry(0.012), new THREE.MeshBasicMaterial({ color: 0xff0000 })); m.position.copy(steer).add(at); scene.add(m); }
  cells.push({ n, at, eye });
}
for (const [i, c] of cells.entries()) {
  if (!c) continue;
  const x = (i % COLS) * CW, y = (ROWS - 1 - Math.floor(i / COLS)) * CH;
  if (mode === 'raw') { cam.fov = 32; cam.position.set(c.at.x + 6.5, 9.5, 8.5); cam.lookAt(c.at.x, 0.4, 0); }
  else if (mode === 'fit') { cam.fov = 32; cam.position.set(c.at.x + 7.5, 3.2, 9.5); cam.lookAt(c.at.x, 0.7, 0); }
  else if (mode === 'grip') { cam.fov = 72; cam.up.set(0, 1, 0); cam.position.copy(c.eye); if (c.side) cam.lookAt(0.3, 0.98, 0.32); else cam.lookAt(c.eye.x, c.eye.y - 0.17, c.eye.z + 1); }
  else if (mode === 'model') { cam.fov = 30; const v = c.view; cam.up.set(0, 1, 0); if (v === 'y') cam.up.set(0, 0, -1); cam.position.set(v === 'x' ? 3 : v === 'q' ? 1.9 : 0, v === 'y' ? 3 : v === 'q' ? 1.6 : 0, v === 'z' ? 3 : v === 'q' ? 1.9 : 0); cam.lookAt(0, 0, 0); }
  else if (mode === 'lamps') { cam.fov = 40; const sgn = q.get('front') ? 1 : -1; cam.position.set(c.at.x + 3, 1.6, sgn * 10.5); cam.lookAt(c.at.x + 3, 0.8, 0); }
  else if (mode === 'wheels') { cam.fov = 40; cam.position.set(c.wheel.x + 2.6, c.wheel.y + 0.5, c.wheel.z + 0.6); cam.lookAt(c.wheel); }
  else { cam.fov = 72; cam.position.copy(c.eye).add(c.at); cam.lookAt(cam.position.x, cam.position.y - 0.12, cam.position.z + 1); }
  cam.updateProjectionMatrix();
  renderer.setViewport(x, y, CW, CH); renderer.setScissor(x, y, CW, CH);
  renderer.render(scene, cam);
  const l = document.createElement('div'); l.className = 'l'; l.textContent = c.n; l.style.left = `${(i % COLS) * CW + 4}px`; l.style.top = `${Math.floor(i / COLS) * CH + 4}px`; document.body.appendChild(l);
}
window.__metrics = info;
console.log(info.join('\n'));
window.__done = true;
