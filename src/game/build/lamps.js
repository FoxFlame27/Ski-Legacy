// Lamps you buy really light the chalet. WebGL forward lighting pays per light in every shader and recompiles
// materials when the light count changes, so a FIXED pool of POOL warm PointLights lives in the interior root
// from the moment you first enter; each update they go to the lit lamps nearest you (the rest keep only their
// bulb glow), unused ones sit at intensity 0. The room's own ceiling lamps (9 in chaletroom.js) stay as they are:
// 9 + POOL = 15 point lights inside, the most any interior uses.
import * as THREE from 'three';
import { lampPoint } from './placement.js';

export const POOL = 6;
const COLOR = 0xffc887;

export class LampPool {
  constructor(root) {
    this.root = root;
    this.lights = [];
    for (let i = 0; i < POOL; i++) {
      const L = new THREE.PointLight(COLOR, 0, 6, 2);
      L.castShadow = false;
      L.name = 'furniture-lamp';
      root.add(L);
      this.lights.push(L);
    }
    this.timer = 0;
  }

  /** lamps: placed entries [{ item, rec, obj }] (rec.on !== false = lit); player: root-space position. */
  update(dt, lamps, player) {
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 0.25; // (no need to re-sort every frame)
    const lit = lamps.filter((e) => e.item.light != null && e.rec.on !== false).map((e) => {
      const p = lampPoint(e.item, e.obj.userData.dims, e.rec);
      return { e, p, d: player ? (p.x - player.x) ** 2 + (p.y - player.y) ** 2 + (p.z - player.z) ** 2 : 0 };
    }).sort((a, b) => a.d - b.d);
    this.lights.forEach((L, i) => {
      const l = lit[i];
      if (!l) { L.intensity = 0; return; }
      L.position.set(l.p.x, l.p.y, l.p.z);
      L.intensity = l.e.item.lux ?? 6;
      L.distance = l.e.item.place === 'ceiling' || (l.e.item.lux ?? 6) >= 10 ? 7 : 4.5;
    });
  }

  dispose() { for (const L of this.lights) L.parent?.remove(L); this.lights = []; }
}
