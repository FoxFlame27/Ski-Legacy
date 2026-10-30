// Hidden subtrees skip the per-frame world-matrix pass (performance pass, Oct 30). three.js recomputes the world
// matrix of every object in the scene every frame (13-14k objects in Legacy Village), visible or not, although most
// of them sit in hidden groups at any moment: far car parks and parked cars, traffic cars that are "gone", far lift
// lines, crowds out of range, sleeping station people, the LOD levels not shown... Only during the renderer's own
// scene pass (Scene.updateMatrixWorld), a hidden group (not a mesh: invisible camera blockers keep theirs) returns at
// once and flags itself; the frame it shows again it (and everything under it) is recomputed as usual, before
// anything is drawn. Explicit updateMatrixWorld calls (building, measuring, attaching) and getWorldPosition /
// updateWorldMatrix are untouched. A LOD's levels always update (the LOD flips them while drawing, after this pass).
import * as THREE from 'three';

let installed = false;
export function installLazyHiddenMatrices() {
  if (installed) return;
  installed = true;
  const base = THREE.Object3D.prototype.updateMatrixWorld;
  let auto = false;
  THREE.Object3D.prototype.updateMatrixWorld = function (force) {
    if (auto && !this.visible && !this.isMesh && !this.parent?.isLOD) { this.matrixWorldNeedsUpdate = true; return; }
    return base.call(this, force);
  };
  THREE.Scene.prototype.updateMatrixWorld = function (force) {
    if (auto) return base.call(this, force); // (a scene inside a scene: already in the pass)
    auto = true;
    try { return base.call(this, force); } finally { auto = false; }
  };
}
