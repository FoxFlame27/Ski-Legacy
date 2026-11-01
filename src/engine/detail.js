// Prop detail for the graphics preset, applied to the hand-placed world (village, lifts, decor, resort dressing,
// race courses) from the outside, so those modules stay untouched:
//  - THREE.LOD switch distances scale with quality.props.lod (fewer full-detail Meshy models around you; makeLOD's
//    own LODs do that themselves, every frame, wherever they are built: core/assets.js)
//  - meshes too small on screen to matter are skipped (bounding radius / distance < quality.props.cull)
//  - props further than quality.props.shadowDist stop casting shadows
// Skipping uses an empty layer mask (not .visible, which the modules themselves switch). Time-sliced.
import * as THREE from 'three';
import { quality, onQualityChange, gpuCaps } from './quality.js';

const _c = new THREE.Vector3(), _s = new THREE.Vector3();
const SLICE = 300, WALK_SLICE = 700;
const MAPS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'bumpMap', 'alphaMap', 'specularMap']; // meshes checked per frame (a full pass every ~0.5 s over ~9k meshes)

export class PropDetail {
  constructor() {
    this.items = [];
    this.lods = [];
    this.next = 0;
    this.walk = []; // the time-sliced scene walk of the light / anisotropy sweeps (sweepStep)
    onQualityChange(() => { this.applyLOD(); this.lightT = 0; this.walk.length = 0; });
  }

  add(root) {
    this.lods = this.lods.filter((l) => l.root.parent); // (courses that were left)
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      if (o.isLOD) {
        if (o.userData.lodSelf) return; // (assets.js makeLOD: scales its own distances by the preset and the screen)
        if (!o.userData.lodBase) {
          o.userData.lodBase = o.levels.map((l) => l.distance);
          this.lods.push({ lod: o, root });
        }
        return;
      }
      if (!o.isMesh || o.isInstancedMesh || o.isSkinnedMesh || !o.geometry || o.userData.propDetail) return;
      const g = o.geometry;
      if (!g.attributes.position) return;
      const tris = (g.index ? g.index.count : g.attributes.position.count) / 3;
      if (tris < 1500 && !o.castShadow) return; // small, shadowless meshes cost next to nothing
      if (!g.boundingSphere) g.computeBoundingSphere();
      o.userData.propDetail = true;
      this.items.push({ o, root, cast: o.castShadow, mask: o.layers.mask, hidden: false });
    });
    this.applyLOD();
  }

  applyLOD() {
    const k = quality.props.lod;
    for (const { lod } of this.lods) lod.levels.forEach((l, i) => { l.distance = lod.userData.lodBase[i] * k; });
  }

  // Point lights on the lighter presets (quality.pointLights === false): every point light in the outdoor scene costs
  // each lit pixel a loop pass even at intensity 0 (they stay in the shaders so switching them never recompiles).
  // Their layer mask is cleared instead (a fixed light count: no recompiles either); the lamps' glowing bulbs stay.
  // Checked every few seconds (lights made later: the tow truck's beacon, the car's dome light).
  sweepLights(scene) {
    const off = quality.pointLights === false;
    scene.traverse((o) => { if (o.isPointLight) this.lightOne(o, off); });
  }

  lightOne(o, off) {
    if (off && o.userData.lightMask === undefined) { o.userData.lightMask = o.layers.mask; o.layers.mask = 0; }
    else if (!off && o.userData.lightMask !== undefined) { o.layers.mask = o.userData.lightMask; delete o.userData.lightMask; }
  }

  // Anisotropic filtering on Ultra / Super Ultra (quality.maxAniso): every material map in the world at the GPU's
  // maximum (signs, decals, canvas textures made at 4x / 8x stay crisp at grazing angles); the authored value comes
  // back on a lighter preset. A changed value needs a re-upload (needsUpdate), once per texture and switch.
  sweepAniso(scene) {
    const want = quality.maxAniso ? gpuCaps.maxAniso || 16 : 0;
    if (!want && !this.anisoSet) return; // (the lighter presets: nothing to do, no traversal)
    this.anisoSet = !!want;
    scene.traverse((o) => { if (o.isMesh && o.material) this.anisoOne(o, want); });
  }

  anisoOne(o, want) {
    const mats = o.material;
    for (let i = 0, n = Array.isArray(mats) ? mats.length : 1; i < n; i++) {
      const m = Array.isArray(mats) ? mats[i] : mats;
      for (const k of MAPS) {
        const t = m[k], img = t?.image;
        if (!t || t.isRenderTargetTexture || t.isVideoTexture || !img || !(img.width > 0 || img.data)) continue;
        const ud = t.userData;
        if (want) {
          if (t.anisotropy >= want) continue;
          if (ud.anisoBase === undefined) ud.anisoBase = t.anisotropy;
          t.anisotropy = want; t.needsUpdate = true;
        } else if (ud.anisoBase !== undefined) {
          t.anisotropy = ud.anisoBase; delete ud.anisoBase; t.needsUpdate = true;
        }
      }
    }
  }

  // The two sweeps above, time-sliced (performance pass, Nov 1 2026: a whole scene.traverse of ~14k objects every 240
  // frames was a hitch every ~4 s): one walk every 240 frames, WALK_SLICE objects a frame, no allocation.
  sweepStep(scene) {
    if (!this.walk.length) {
      if ((this.lightT = (this.lightT || 0) - 1) > 0) return;
      this.lightT = 240;
      this.walkOff = quality.pointLights === false;
      this.walkAniso = quality.maxAniso ? gpuCaps.maxAniso || 16 : 0;
      this.walkAnisoDo = !!this.walkAniso || !!this.anisoSet; // (the lighter presets: nothing to restore, lights only)
      this.walk.push(scene);
    }
    const walk = this.walk, off = this.walkOff, want = this.walkAniso, doAniso = this.walkAnisoDo;
    for (let n = 0; n < WALK_SLICE && walk.length; n++) {
      const o = walk.pop(), ch = o.children;
      for (let i = 0; i < ch.length; i++) walk.push(ch[i]);
      if (o.isPointLight) this.lightOne(o, off);
      else if (doAniso && o.isMesh && o.material) this.anisoOne(o, want);
    }
    if (!walk.length) this.anisoSet = !!want;
  }

  update(camera, scene = null) {
    if (scene) this.sweepStep(scene);
    const items = this.items, n = items.length;
    if (!n) return;
    const cam = camera.position, { cull, shadowDist } = quality.props;
    for (let k = 0; k < Math.min(SLICE, n); k++) {
      if (this.next >= items.length) this.next = 0;
      const it = items[this.next], o = it.o;
      if (!it.root.parent) { // its course / group left the scene
        o.layers.mask = it.mask; o.castShadow = it.cast; o.userData.propDetail = false;
        items[this.next] = items[items.length - 1];
        items.pop();
        if (!items.length) break;
        continue;
      }
      this.next++;
      const bs = o.geometry.boundingSphere;
      _c.copy(bs.center).applyMatrix4(o.matrixWorld);
      _s.setFromMatrixScale(o.matrixWorld);
      const r = bs.radius * Math.max(_s.x, _s.y, _s.z);
      const d = Math.max(1, _c.distanceTo(cam) - r);
      const hide = cull > 0 && r / d < cull;
      if (hide !== it.hidden) { it.hidden = hide; o.layers.mask = hide ? 0 : it.mask; }
      o.castShadow = it.cast && d < shadowDist;
    }
  }
}
