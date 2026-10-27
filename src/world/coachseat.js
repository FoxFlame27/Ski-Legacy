// The coach seat of the post bus (game/bus/bus.js) and the Wolkenspitzbahn's railcars (train.js): a rounded
// slate-blue fabric cushion and back, a grey shell behind the back, a cream headrest cover and a grab handle on
// the shell's top. Any number of seats as five instanced meshes (one per part).
// A seat is placed by its cushion's centre on the floor: { x, y (floor), z, yaw (0 = facing +z) }; the cushion's
// top is COACH_SEAT.surface over the floor.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

export const COACH_SEAT = { width: 0.44, depth: 0.44, surface: 0.505 };

let GEO = null;
function geometries() {
  if (GEO) return GEO;
  const handle = new THREE.CylinderGeometry(0.012, 0.012, 0.28, 6);
  handle.rotateZ(Math.PI / 2);
  GEO = {
    cushion: new RoundedBoxGeometry(0.44, 0.11, 0.44, 2, 0.04),
    back: new RoundedBoxGeometry(0.44, 0.6, 0.09, 2, 0.04),
    shell: new RoundedBoxGeometry(0.45, 0.62, 0.05, 2, 0.02),
    head: new RoundedBoxGeometry(0.4, 0.16, 0.1, 2, 0.04),
    handle,
  };
  return GEO;
}
// each part in the seat's frame: [height over the floor, offset along the seat's facing, backward tilt]
const PARTS = [['cushion', 'fabric', 0.45, 0, 0], ['back', 'fabric', 0.8, -0.25, -0.12], ['shell', 'shell', 0.8, -0.31, -0.12],
  ['head', 'head', 1.06, -0.29, -0.12], ['handle', 'metal', 1.16, -0.36, 0]];

/** The seat's own materials (the bus's): fabric, shell, head (cover), metal (handle). */
export function coachSeatMaterials() {
  const M = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0, ...o });
  return { fabric: M(0x2e3a52, { roughness: 0.95 }), shell: M(0x5d636b, { roughness: 0.55 }), head: M(0xd9d4c7, { roughness: 0.9 }), metal: M(0xc9ccd1, { roughness: 0.3, metalness: 0.7 }) };
}

/** Instanced seats at `places` ([{ x, y, z, yaw }]): returns the five InstancedMeshes (add them to a group). */
export function coachSeats(places, mats = coachSeatMaterials()) {
  const G = geometries(), n = places.length, out = [];
  const seat = new THREE.Matrix4(), part = new THREE.Matrix4(), m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
  for (const [name, matKey, y, dz, tilt] of PARTS) {
    const im = new THREE.InstancedMesh(G[name], mats[matKey], n);
    im.name = `coach-seat-${name}`;
    part.compose(p.set(0, y, dz), q.setFromEuler(e.set(tilt, 0, 0)), one);
    places.forEach((s, i) => {
      seat.compose(p.set(s.x, s.y, s.z), q.setFromEuler(e.set(0, s.yaw || 0, 0)), one);
      im.setMatrixAt(i, m4.multiplyMatrices(seat, part));
    });
    im.instanceMatrix.needsUpdate = true;
    im.computeBoundingSphere();
    out.push(im);
  }
  return out;
}
