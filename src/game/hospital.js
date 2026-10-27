// The small medical centre at the village edge (its site is planned with the roads in game/bus/roads.js: clear
// ground off the ski areas, a short way from a road, flattened). The ambulance drives you there after a heli rescue
// and you come round outside its entrance (game/heli/rescue.js).
import * as THREE from 'three';
import { fitModel } from '../core/assets.js';
import { busRoads } from './bus/roads.js';

// the Meshy building's entrance side, as a turn from its +z (checked against the model)
export const FRONT_TURN = 0;

export class Hospital {
  constructor({ scene, models, colliders }) {
    this.group = null;
    const H = busRoads.hospital;
    if (!H || !models.medical_centre) return;
    const m = fitModel(models.medical_centre, { size: 2 * Math.max(H.hw, H.hd) * 0.92, axis: 'xz' });
    m.rotation.y = H.facing + FRONT_TURN;
    m.position.set(H.x, H.y - 0.08, H.z);
    m.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    this.group = m;
    scene.add(m);
    const s = m.userData.size || new THREE.Vector3(H.hw * 2, 10, H.hd * 2);
    // solid: an oriented box a little inside the walls (you walk up to the door)
    colliders.push({ x: H.x, z: H.z, hw: s.x * 0.42, hd: s.z * 0.42, rot: -(H.facing + FRONT_TURN) });
  }
}
