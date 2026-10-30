// The interiors' soft room reflections (Oct 30 2026, the user: "why does loading actually take so long"): the ski shop,
// the Autohaus showroom, the police station, the medical centre and the chalets each rendered three.js's
// RoomEnvironment into a cube map and blurred it (PMREM) while the game loaded, five times over for two different
// results (blur 0.03 and 0.04). The result only depends on the blur, so it is made once per blur and shared: the same
// pixels, three captures and blur passes fewer on the GPU at boot. Never disposed (the scenes keep it for good).
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const made = new Map();
/** The PMREM-filtered RoomEnvironment for scene.environment, one per (renderer, sigma). */
export function roomEnvironment(renderer, sigma) {
  let per = made.get(renderer);
  if (!per) made.set(renderer, (per = new Map()));
  if (!per.has(sigma)) {
    const pmrem = new THREE.PMREMGenerator(renderer), room = new RoomEnvironment();
    try { per.set(sigma, pmrem.fromScene(room, sigma).texture); } finally { pmrem.dispose(); room.dispose(); }
  }
  return per.get(sigma);
}
