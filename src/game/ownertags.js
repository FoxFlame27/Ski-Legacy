// Your name over what you own (Oct 29, the user: "make sure everything you own has your name above if you are not in
// it and it shows it on the map"), single player too: your rented car (also when it is impounded), your chalet and
// the helicopter you rented while it waits for you out on the mountain. The tag is the multiplayer one
// (net/remote.js makeTag), in gold, with your multiplayer name if you have one, else "You". Hidden while you are in
// it and beyond TAG_FAR. mapMarkers() gives the trail map (ui/trailmap.js) "Your car", "Impounded car", "Your
// chalet" and "Your helicopter".
// Multiplayer: every chalet placed in the world carries "<owner>'s chalet" (yours in gold, the others' in the players'
// blue), from MP.chalets (the plots held by owners who are online: an offline owner's chalet is not there).
// Hosted by carrental.js (its update runs every frame); it reads the chalets and the helicopter off window.__game.
import * as THREE from 'three';
import { makeTag } from '../net/remote.js';
import { MP } from '../net/mode.js';
import { world } from '../world/world.js';

const TAG_FAR = 320;   // m: tags hidden beyond
const GOLD = '#9a6a00';
const BLUE = '#1f5fd1';

/** Your name for tags: the multiplayer name (in a session, else the one you registered), or "You". */
export function ownerName() {
  if (MP.name) return MP.name;
  try {
    const a = JSON.parse(localStorage.getItem('ski-legacy-mp-accounts') || '{}');
    for (const k of Object.keys(a)) if (a[k]?.name) return a[k].name;
  } catch { /* (no storage) */ }
  return 'You';
}

export class OwnerTags {
  constructor({ scene, camera, rental }) {
    Object.assign(this, { scene, camera, rental });
    this.name = null;
    this.tags = {}; // car | chalet | heli -> Sprite
    this.t = 0;
  }

  // what you own right now, where (world { x, y, z } of the tag), and whether you are in it
  owned() {
    const out = [], G = typeof window !== 'undefined' ? window.__game : null;
    const st = this.rental?.impound?.status?.();
    const e = this.rental?.current;
    // (Oct 30, the user: "above your car say your car": the tag over your own cars reads "Your car", not your name)
    if (st) out.push({ key: 'car', x: st.x, y: st.y + 2.2, z: st.z, label: st.impounded ? 'Your car · tow yard' : 'Your car', impounded: st.impounded, text: st.impounded ? 'Your car · tow yard' : 'Your car' });
    else if (e?.car && !e.driving) out.push({ key: 'car', x: e.car.position.x, y: e.car.position.y + 2.2, z: e.car.position.z, label: 'Your car', text: 'Your car' });
    for (const k of this.rental?.kept || []) { // (your other cars parked in the world)
      if (!k?.car || k.driving || !k.car.parent) continue;
      const kp = k.car.position;
      out.push({ key: `kept:${k.cfg?.plate || k.car.id}`, x: kp.x, y: kp.y + 2.2, z: kp.z, label: 'Your car', text: 'Your car' });
    }
    const ch = G?.chalets, h = ch?.rented?.();
    if (h?.frame && !ch.inside) { const p = h.frame.position; out.push({ key: 'chalet', x: p.x, y: p.y + 10.5, z: p.z, label: 'Your chalet', text: MP.active ? `${this.name}'s chalet` : null }); }
    if (MP.active && MP.chalets && ch?.houses && !ch.inside) for (const id in MP.chalets) { // (the other players' chalets)
      const owner = MP.chalets[id];
      if (!owner || owner === MP.name) continue;
      const oh = ch.houses.find((x) => x.id === +id);
      if (!oh?.frame) continue;
      const p = oh.frame.position;
      out.push({ key: `chalet:${id}`, x: p.x, y: p.y + 10.5, z: p.z, label: `${owner}'s chalet`, text: `${owner}'s chalet`, color: BLUE, other: true });
    }
    const heli = G?.heli;
    if (heli && heli.state === 'parked' && heli.away && heli.flight?.pos) { const p = heli.flight.pos; out.push({ key: 'heli', x: p.x, y: world.height(p.x, p.z) + 4.6, z: p.z, label: 'Your helicopter' }); }
    return out;
  }

  /** Per frame (carrental.js update). */
  update(dt) {
    this.t -= dt;
    if (this.t > 0 && this.list) { this.scale(); return; }
    this.t = 0.25;
    const name = ownerName();
    if (name !== this.name) { // (a new name: new tags)
      this.name = name;
      for (const s of Object.values(this.tags)) { s.removeFromParent(); s.material.map?.dispose(); s.material.dispose(); }
      this.tags = {};
    }
    this.list = this.owned();
    const seen = new Set();
    for (const o of this.list) {
      let s = this.tags[o.key];
      const text = o.text || (o.impounded ? `${name} · tow yard` : name);
      if (!s) { s = this.tags[o.key] = makeTag(text, o.color || GOLD); s.userData.impounded = !!o.impounded; s.userData.text = text; this.scene.add(s); }
      if (s.userData.impounded !== !!o.impounded || s.userData.text !== text) { s.removeFromParent(); s.material.map?.dispose(); s.material.dispose(); delete this.tags[o.key]; continue; } // (rebuilt next time)
      s.position.set(o.x, o.y, o.z);
      seen.add(o.key);
    }
    for (const [k, s] of Object.entries(this.tags)) s.userData.on = seen.has(k);
    this.scale();
  }
  // a little smaller far away, hidden past TAG_FAR (as the players' tags)
  scale() {
    const c = this.camera?.position;
    if (!c) return;
    for (const s of Object.values(this.tags)) {
      const d = s.position.distanceTo(c), on = !!s.userData.on && d < TAG_FAR;
      s.visible = on;
      if (on) { const k = s.userData.base * Math.max(0.55, Math.min(1, 1.15 - d / 260)); s.scale.set(k * (512 / 96), k, 1); }
    }
  }

  /** For the trail map: [{ x, z, label, kind: 'car' | 'impound' | 'chalet' | 'heli' }]. */
  mapMarkers() {
    try { return this.owned().filter((o) => !o.other).map((o) => ({ x: o.x, z: o.z, label: o.label, kind: o.impounded ? 'impound' : o.key })); } catch { return []; }
  }
}
