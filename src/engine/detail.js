// Prop detail for the graphics preset, applied to the hand-placed world (village, lifts, decor, resort dressing,
// race courses) from the outside, so those modules stay untouched:
//  - THREE.LOD switch distances scale with quality.props.lod (fewer full-detail Meshy models around you)
//  - meshes too small on screen to matter are skipped (bounding radius / distance < quality.props.cull)
//  - props further than quality.props.shadowDist stop casting shadows
// Skipping uses an empty layer mask (not .visible, which the modules themselves switch). Time-sliced.
import * as THREE from 'three';
import { quality, onQualityChange } from './quality.js';

const _c = new THREE.Vector3(), _s = new THREE.Vector3();
const SLICE = 600; // meshes checked per frame

export class PropDetail {
  constructor() {
    this.items = [];
    this.lods = [];
    this.next = 0;
    onQualityChange(() => this.applyLOD());
  }

  add(root) {
    this.lods = this.lods.filter((l) => l.root.parent); // (courses that were left)
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      if (o.isLOD) {
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

  update(camera) {
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
