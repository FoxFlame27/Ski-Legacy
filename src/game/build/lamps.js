// Lamps you buy really light the chalet. WebGL forward lighting pays per light in every shader and recompiles
// materials when the light count changes, so the lit lamps don't get lights of their own: they join the chalet
// room's built-in lamps as sources for its one fixed pool of point lights (chaletroom.js setFurnitureLamps), which
// goes to whichever lamps are nearest you; the rest keep only their bulb glow.
import * as THREE from 'three';
import { lampPoint } from './placement.js';
import { setFurnitureLamps } from '../chaletroom.js';

export const POOL = 6;
const COLOR = 0xffc887;

export class LampPool {
  // (Oct 29: no lights of its own any more: the lit lamps go to the chalet room's shared pool, setFurnitureLamps;
  // a second pool in the world scene cost every material outside six more lights)
  constructor(root) { this.root = root; this.lights = []; this.timer = 0; }

  /** lamps: placed entries [{ item, rec, obj }] (rec.on !== false = lit); player: root-space position (unused). */
  update(dt, lamps) {
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 0.25;
    setFurnitureLamps(lamps.filter((e) => e.item.light != null && e.rec.on !== false).map((e) => {
      const p = lampPoint(e.item, e.obj.userData.dims, e.rec);
      return { x: p.x, y: p.y, z: p.z, power: (e.item.lux ?? 6) / 7.5 };
    }));
  }

  dispose() { setFurnitureLamps([]); }
}
