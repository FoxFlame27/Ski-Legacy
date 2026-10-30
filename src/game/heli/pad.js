// The helipad in Legacy Village: a concrete deck with the landing H, green edge lights that glow at
// night, a windsock (it fills with the rotor wash too) and the red heli-ski hut with its sign.
// The spot is picked when the game loads: open, level ground off the pistes, lifts and buildings.
import * as THREE from 'three';
import { world } from '../../world/world.js';
import { fitModel } from '../../core/assets.js';
import { nightUniform } from '../../world/village.js';
import { glowPoints, glowScale } from './fx.js';
import { meshyPole } from '../../world/pistelights.js';
import { floodBank, floodMaterial, floodCenter } from '../../world/meshylights.js';
import { busRoads } from '../bus/roads.js'; // (the site picked with the roads: bus/roads.js planHeliRoad, its Rettungsweg)

export const PAD_R = 10;
// preferred spots (open snow 130-200 m from the plaza), first that is clear wins
const SPOTS = [[70, 160], [52, 162], [84, 146], [-62, 142], [92, -128], [128, -72], [12, 214], [-118, 98]];
const LIGHTS = 16;

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/**
 * Pick the helipad site: flat, no runs or lift lines across it, clear of lift stations, race starts,
 * bus stops, other pads and every collider (buildings, props, nets).
 */
export function chooseSite(layout, colliders) {
  // (picked while the roads were planned, with these same tests, so its road to the medical centre could be carved in)
  if (busRoads.helipad) return { x: busRoads.helipad.x, z: busRoads.helipad.z, score: 0 };
  const corr = { d: 1e9, kind: null, dx: 0, dz: 1, groomed: false };
  let best = null;
  for (const [x, z] of SPOTS) {
    let hmin = 1e9, hmax = -1e9, cd = 1e9;
    for (let a = 0; a < 12; a++) for (const r of [0, 6, 12, 20]) {
      const px = x + Math.cos((a / 12) * Math.PI * 2) * r, pz = z + Math.sin((a / 12) * Math.PI * 2) * r;
      if (r <= 12) { const h = world.height(px, pz); hmin = Math.min(hmin, h); hmax = Math.max(hmax, h); }
      cd = Math.min(cd, world.corridorAt(px, pz, corr).d);
    }
    let near = 1e9;
    for (const c of colliders) near = Math.min(near, Math.hypot(c.x - x, c.z - z) - (c.r ?? Math.max(c.hw, c.hd)));
    for (const l of layout.lifts) for (const p of [l.bottom, l.top, l.mid]) if (p) near = Math.min(near, Math.hypot(p.x - x, p.z - z) - 40);
    for (const r of layout.races) near = Math.min(near, Math.hypot(r.start.x - x, r.start.z - z) - 20, Math.hypot(r.finish.x - x, r.finish.z - z) - 20);
    for (const s of layout.busStops || []) near = Math.min(near, Math.hypot(s.x - x, s.z - z) - 10);
    const pad = world.padInfluence(x, z);
    const score = (hmax - hmin) * 10 + Math.max(0, 8 - cd) * 4 + Math.max(0, 24 - near) * 3 + pad * 50;
    if (!best || score < best.score) best = { x, z, score };
    if (hmax - hmin < 0.8 && cd > 8 && near > 24 && pad === 0) { best = { x, z, score }; break; }
  }
  return best;
}

// concrete deck: the landing H, the touchdown circle, a red brand ring, wind-blown snow at the rim
function padTexture(yaw) {
  const S = 1024, h = S / 2, c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // concrete: blotchy noise painted small and scaled up (smooth), then a fine grain on top
  const n = document.createElement('canvas');
  n.width = n.height = 128;
  const ng = n.getContext('2d'), nd = ng.createImageData(128, 128);
  for (let i = 0; i < 128 * 128; i++) {
    const v = 102 + rnd() * 20;
    nd.data[i * 4] = v; nd.data[i * 4 + 1] = v + 5; nd.data[i * 4 + 2] = v + 11; nd.data[i * 4 + 3] = 255;
  }
  ng.putImageData(nd, 0, 0);
  g.imageSmoothingEnabled = true;
  g.drawImage(n, 0, 0, S, S);
  for (let i = 0; i < 2600; i++) {
    const v = 90 + rnd() * 50;
    g.fillStyle = `rgba(${v},${v + 4},${v + 9},0.22)`;
    g.fillRect(rnd() * S, rnd() * S, 2 + rnd() * 3, 2 + rnd() * 3);
  }
  // expansion joints
  g.strokeStyle = 'rgba(40,44,50,0.35)'; g.lineWidth = 3;
  for (let k = 1; k < 4; k++) { g.beginPath(); g.moveTo((k * S) / 4, 0); g.lineTo((k * S) / 4, S); g.stroke(); g.beginPath(); g.moveTo(0, (k * S) / 4); g.lineTo(S, (k * S) / 4); g.stroke(); }
  g.save();
  g.translate(h, h);
  // the cap maps canvas x to world +z and canvas y to world -x: turn the H along the parked heading
  g.rotate(-yaw - Math.PI / 2);
  const ring = (r, w, col, dash) => { g.strokeStyle = col; g.lineWidth = w; g.setLineDash(dash || []); g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.stroke(); g.setLineDash([]); };
  ring(h * 0.955, 10, '#f4f6f8', [42, 26]);
  ring(h * 0.88, 7, '#e83a2e');
  ring(h * 0.66, 26, '#f4f6f8');
  // the H (its long strokes along the parking heading)
  g.fillStyle = '#f4f6f8';
  const hw = h * 0.27, hh = h * 0.42, st = h * 0.085;
  g.fillRect(-hw, -hh, st, hh * 2); g.fillRect(hw - st, -hh, st, hh * 2); g.fillRect(-hw, -st / 2, hw * 2, st);
  g.restore();
  // snow blown onto the rim: fine grains thickening toward the edge, a few soft drifts along it
  // (only the ring of pixels near the rim is visited)
  const snow = g.getImageData(0, 0, S, S), Q = snow.data;
  const rim = (x, y) => {
    const r = Math.hypot(x + 0.5 - h, y + 0.5 - h) / h;
    if (r < 0.8) return;
    const a = Math.atan2(y - h, x - h);
    const drift = 0.5 + 0.5 * Math.sin(a * 7 + Math.sin(a * 3) * 2) * Math.sin(a * 13 + 1);
    const cover = Math.min(1, Math.max(0, (r - 0.83) / 0.17) * (0.55 + 0.6 * drift) + (rnd() - 0.5) * 0.35);
    if (cover <= 0) return;
    const k = (y * S + x) * 4, w = cover * cover * (0.75 + 0.25 * rnd());
    Q[k] += (240 - Q[k]) * w; Q[k + 1] += (245 - Q[k + 1]) * w; Q[k + 2] += (252 - Q[k + 2]) * w;
  };
  for (let y = 0; y < S; y++) {
    // skip the middle of each row (inside r = 0.8)
    const dy = (y + 0.5 - h) / h, inner = 0.64 - dy * dy;
    const xi = inner > 0 ? Math.sqrt(inner) * h : 0;
    const x0 = Math.max(0, Math.floor(h - xi) - 1), x1 = Math.min(S, Math.ceil(h + xi) + 1);
    for (let x = 0; x < S; x++) {
      if (x === x0 && x1 > x0 + 2) x = x1;
      if (x < S) rim(x, y);
    }
  }
  g.putImageData(snow, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 16;
  return t;
}

// the hut sign: white board, red accent bar, blue italic condensed lettering (the game's UI style)
function signCanvas(c, price) {
  const g = c.getContext('2d'), W = c.width, H = c.height;
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#ff4d3d'; g.fillRect(W * 0.045, H * 0.2, W * 0.018, H * 0.6);
  g.fillStyle = '#1546c8';
  g.font = `italic 700 ${Math.round(H * 0.56)}px "Barlow Condensed", "Arial Narrow", Arial, sans-serif`;
  g.textBaseline = 'alphabetic';
  g.fillText('HELI-SKI', W * 0.1, H * 0.6);
  g.fillStyle = '#4f72d4';
  g.font = `600 ${Math.round(H * 0.15)}px "Inter Variable", Arial, sans-serif`;
  g.fillText(`FLIGHTS TO THE FAR PEAKS  ·  $${price}`, W * 0.105, H * 0.84);
}

function makeSign(w, h, price) {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = Math.round((1024 * h) / w);
  signCanvas(c, price);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 16;
  // the house font may still be loading: repaint once it is there
  document.fonts?.load?.(`italic 700 64px "Barlow Condensed"`).then(() => { signCanvas(c, price); tex.needsUpdate = true; }).catch(() => {});
  const face = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0 });
  const grp = new THREE.Group();
  const back = new THREE.Mesh(new THREE.BoxGeometry(w + 0.08, h + 0.08, 0.06), new THREE.MeshStandardMaterial({ color: 0xe9ecf0, roughness: 0.5, metalness: 0.2 }));
  const front = new THREE.Mesh(new THREE.PlaneGeometry(w, h), face);
  front.position.z = 0.032;
  grp.add(back, front);
  grp.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  grp.userData.face = face;
  return grp;
}

function proceduralHut() {
  const g = new THREE.Group();
  const red = new THREE.MeshStandardMaterial({ color: 0xb3241d, roughness: 0.75 });
  const snow = new THREE.MeshStandardMaterial({ color: 0xf2f6fb, roughness: 0.9 });
  const walls = new THREE.Mesh(new THREE.BoxGeometry(4.2, 2.6, 3.2), red);
  walls.position.y = 1.3;
  const roof = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 2.6, 1.2, 4, 1), snow);
  roof.rotation.y = Math.PI / 4; roof.scale.set(1.15, 1, 0.9); roof.position.y = 3.2;
  g.add(walls, roof);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  g.userData.size = new THREE.Vector3(4.2, 3.8, 3.2);
  return g;
}

function stripeTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  for (let i = 0; i < 5; i++) { g.fillStyle = i % 2 ? '#f5f5f2' : '#ff5a1f'; g.fillRect((i * 256) / 5, 0, 256 / 5 + 1, 64); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Helipad {
  /**
   * @param {object} o
   * @param {THREE.Scene} o.scene
   * @param {object} o.models     loaded GLTFs (patrol_hut optional)
   * @param {Array} o.colliders   shared collider list
   * @param {{x: number, z: number}} o.site
   * @param {number} [o.price]    flight price on the sign
   */
  constructor({ scene, models, colliders, site, price = 1500 }) {
    this.group = new THREE.Group();
    this.group.name = 'helipad';
    const { x, z } = site;
    this.x = x; this.z = z;
    // the village lies that way; the hut stands between it and the pad
    const tv = new THREE.Vector2(-x, -z).normalize();
    this.toVillage = tv;
    // parked heading: broadside to the village, the pilot's (right) door toward the hut
    this.yaw = Math.atan2(tv.y, -tv.x);

    // ---- deck: level slab on the highest snow under it, flush walkable surface
    let hmax = -1e9;
    for (let a = 0; a < 24; a++) for (const r of [0, PAD_R * 0.5, PAD_R]) hmax = Math.max(hmax, world.height(x + Math.cos((a / 24) * 6.283) * r, z + Math.sin((a / 24) * 6.283) * r));
    this.y = hmax + 0.14;
    const top = new THREE.MeshStandardMaterial({ map: padTexture(this.yaw), roughness: 0.82, metalness: 0 });
    const side = new THREE.MeshStandardMaterial({ color: 0x8b9097, roughness: 0.9 });
    const deck = new THREE.Mesh(new THREE.CylinderGeometry(PAD_R, PAD_R + 0.25, 0.9, 72, 1), [side, top, side]);
    deck.position.set(x, this.y - 0.45, z);
    deck.receiveShadow = true;
    this.group.add(deck);
    const deckY = this.y, R2 = (PAD_R + 0.1) ** 2;
    this.surface = world.addSurface({
      bounds: { minx: x - PAD_R - 1, minz: z - PAD_R - 1, maxx: x + PAD_R + 1, maxz: z + PAD_R + 1 },
      height: (px, pz) => ((px - x) ** 2 + (pz - z) ** 2 < R2 ? deckY : null),
    });

    // ---- edge lights: little domes on the rim, green halos at night
    const base = new THREE.CylinderGeometry(0.07, 0.09, 0.1, 10).translate(0, 0.05, 0);
    const dome = new THREE.SphereGeometry(0.075, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 0.1, 0);
    this.domeMat = new THREE.MeshStandardMaterial({ color: 0x9fe8b4, roughness: 0.2, emissive: 0x38ff74, emissiveIntensity: 0 });
    const bases = new THREE.InstancedMesh(base, new THREE.MeshStandardMaterial({ color: 0x2e3238, roughness: 0.5, metalness: 0.6 }), LIGHTS);
    const domes = new THREE.InstancedMesh(dome, this.domeMat, LIGHTS);
    const m = new THREE.Matrix4(), lampPos = [];
    for (let i = 0; i < LIGHTS; i++) {
      const a = (i / LIGHTS) * Math.PI * 2, lx = x + Math.cos(a) * (PAD_R - 0.35), lz = z + Math.sin(a) * (PAD_R - 0.35);
      m.makeTranslation(lx, this.y, lz);
      bases.setMatrixAt(i, m); domes.setMatrixAt(i, m);
      lampPos.push(new THREE.Vector3(lx, this.y + 0.16, lz));
    }
    this.group.add(bases, domes);
    this.halos = glowPoints(lampPos, lampPos.map(() => 0.5), 2);
    this.group.add(this.halos);

    // ---- the heli-ski hut with its sign: beside the pad (not in the way of the view from the village),
    // its door and sign turned toward the way you walk in from the village
    const px = -tv.y, pz = tv.x; // across
    const hx = x + px * (PAD_R + 7.5) + tv.x * 3, hz = z + pz * (PAD_R + 7.5) + tv.y * 3;
    const fdx = tv.x * 1.0 - px * 0.55, fdz = tv.y * 1.0 - pz * 0.55;
    const hutYaw = Math.atan2(fdx, fdz);
    let hut;
    hut = models?.patrol_hut ? fitModel(models.patrol_hut, { size: 4.4, axis: 'x' }) : proceduralHut();
    hut.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    let gmin = 1e9;
    for (const [dx, dz] of [[-2, -1.6], [2, -1.6], [-2, 1.6], [2, 1.6], [0, 0]]) gmin = Math.min(gmin, world.height(hx + dx, hz + dz));
    hut.position.set(hx, gmin - 0.12, hz);
    hut.rotation.y = hutYaw;
    this.group.add(hut);
    const hs = hut.userData.size || new THREE.Vector3(4.4, 3.6, 3.4);
    colliders.push({ x: hx, z: hz, hw: hs.x * 0.42, hd: hs.z * 0.42, rot: -hutYaw });
    const front = new THREE.Vector3(Math.sin(hutYaw), 0, Math.cos(hutYaw));
    // mount the sign flush on the front, above the door
    hut.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(hut), ctr = box.getCenter(new THREE.Vector3());
    const sy = box.min.y + (box.max.y - box.min.y) * 0.66;
    const hit = new THREE.Raycaster(ctr.clone().setY(sy).addScaledVector(front, 30), front.clone().negate(), 0, 60).intersectObject(hut, true)[0];
    const sp = hit ? hit.point : ctr.clone().setY(sy).addScaledVector(front, hs.z / 2);
    this.sign = makeSign(2.3, 0.62, price);
    this.sign.position.copy(sp).addScaledVector(front, 0.07);
    this.sign.rotation.y = hutYaw;
    this.group.add(this.sign);
    this.hut = { x: hx, z: hz, front, door: new THREE.Vector3(hx, 0, hz).addScaledVector(front, hs.z * 0.5 + 1.2) };

    // ---- floodlight mast between the hut and the deck: lights the pad at night (an additive pool). The piste
    // masts' Meshy pole (7.5 m) with a COB floodlight bank tipped to face the middle of the deck; the pool is lit
    // from its glass (without the models a built mast)
    const mx = x + px * (PAD_R + 2.6) - tv.x * 2, mz = z + pz * (PAD_R + 2.6) - tv.y * 2, my = world.height(mx, mz);
    const mastPole = models?.floodlight_mast ? meshyPole(models.floodlight_mast) : null;
    const bank = mastPole ? floodBank(models, 'floodlight_head_c', 1.15) : null;
    let lampAt, toPad;
    this.floodOn = { value: 0 };
    if (mastPole && bank) {
      const H = 7.5, k = (H + 0.6) / 10.6, yaw = Math.atan2(x - mx, z - mz), foot = my - 0.12;
      const pg = mastPole.geometry.clone().translate(0, 0.6, 0).scale(1, k, 1).translate(0, -0.6, 0); // (0.6 m in the snow)
      const mast = new THREE.Mesh(pg, mastPole.material);
      mast.position.set(mx, foot, mz);
      mast.rotation.y = yaw;
      mast.castShadow = true; mast.receiveShadow = true;
      // the bank on the pole top, tipped so its glass faces the middle of the deck
      const c = floodCenter(bank), base = new THREE.Vector3(mx, foot + H - 0.04, mz), target = new THREE.Vector3(x, this.y, z);
      const e = new THREE.Euler(0.5, yaw, 0, 'YXZ'), hm = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), v = new THREE.Vector3();
      for (let it = 0; it < 4; it++) {
        hm.compose(base, q.setFromEuler(e), one);
        v.copy(c).applyMatrix4(hm);
        e.x = Math.asin(Math.min(1, Math.max(-1, -target.clone().sub(v).normalize().y)));
      }
      hm.compose(base, q.setFromEuler(e), one);
      const head = new THREE.Mesh(bank.geometry, floodMaterial(bank, { on: this.floodOn }));
      head.position.copy(base);
      head.quaternion.copy(q);
      head.castShadow = true; head.receiveShadow = true;
      lampAt = c.clone().applyMatrix4(hm);
      toPad = new THREE.Vector3(0, 0, 1).transformDirection(hm);
      this.group.add(mast, head);
    } else {
      const mastMat = new THREE.MeshStandardMaterial({ color: 0x4a5058, roughness: 0.45, metalness: 0.75 });
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, 7, 10).translate(0, 3.5, 0), mastMat);
      mast.position.set(mx, my - 0.05, mz);
      mast.castShadow = true;
      lampAt = new THREE.Vector3(mx, my + 7.05, mz);
      toPad = new THREE.Vector3(x - mx, this.y - lampAt.y, z - mz).normalize();
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.32, 0.22), mastMat);
      head.position.copy(lampAt);
      head.lookAt(lampAt.clone().add(toPad));
      this.group.add(mast, head);
    }
    colliders.push({ x: mx, z: mz, r: 0.3 });
    this.floodLens = glowPoints([lampAt.clone().addScaledVector(toPad, bank ? 0.08 : 0.14)], [bank ? 0.6 : 0.9], 2);
    this.group.add(this.floodLens);
    this.flood = { lamp: { value: lampAt }, dir: { value: toPad }, color: { value: new THREE.Color(0, 0, 0) }, cos: { value: new THREE.Vector2(Math.cos(0.62), Math.cos(0.3)) } };
    const pool = new THREE.Mesh(new THREE.CircleGeometry(PAD_R + 0.3, 72).rotateX(-Math.PI / 2), new THREE.ShaderMaterial({
      uniforms: { uLamp: this.flood.lamp, uDir: this.flood.dir, uColor: this.flood.color, uCos: this.flood.cos },
      vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `uniform vec3 uLamp; uniform vec3 uDir; uniform vec3 uColor; uniform vec2 uCos; varying vec3 vW;
        void main(){ vec3 L = uLamp - vW; float d = length(L); L /= d;
          float spot = smoothstep(uCos.x, uCos.y, dot(-L, uDir));
          gl_FragColor = vec4(uColor * spot * L.y / (1.0 + d * d * 0.004), 1.0); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    }));
    pool.position.set(x, this.y + 0.02, z);
    pool.renderOrder = 2;
    this.floodPool = pool;
    this.group.add(pool);

    // ---- windsock on the far side of the pad
    const wsx = x - px * (PAD_R + 4) - tv.x * 7, wsz = z - pz * (PAD_R + 4) - tv.y * 7;
    const wy = world.height(wsx, wsz);
    const metal = new THREE.MeshStandardMaterial({ color: 0xe9ecef, roughness: 0.5, metalness: 0.2 }); // painted white
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.07, 5.2, 12).translate(0, 2.6, 0), metal);
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.32, 0.18, 16).translate(0, 0.09, 0), side);
    pole.position.set(wsx, wy - 0.05, wsz); foot.position.copy(pole.position);
    pole.castShadow = true;
    this.group.add(pole, foot);
    colliders.push({ x: wsx, z: wsz, r: 0.35 });
    this.sockPivot = new THREE.Group();
    this.sockPivot.position.set(wsx, wy + 5.1, wsz);
    const ringG = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.018, 8, 24).rotateY(Math.PI / 2), metal);
    const sock = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.12, 2.5, 18, 6, true).rotateZ(Math.PI / 2).translate(1.25, 0, 0),
      new THREE.MeshStandardMaterial({ map: stripeTexture(), roughness: 0.85, side: THREE.DoubleSide }));
    // the stripes run around the cone: remap its u to the length
    const uv = sock.geometry.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, 1 - uv.getY(i), uv.getX(i));
    sock.castShadow = true;
    this.sockSwing = new THREE.Group();
    this.sockSwing.add(ringG, sock);
    this.sockPivot.add(this.sockSwing);
    this.group.add(this.sockPivot);
    this.sockYaw = 0; this.sockDroop = 1.2; this.wind = { x: 2.5, z: 1 };

    scene.add(this.group);
    this.t = 0;
  }

  /** E zone: on the pad or at the hut's door. */
  near(pos) {
    return Math.hypot(pos.x - this.x, pos.z - this.z) < PAD_R + 1.5 || Math.hypot(pos.x - this.hut.door.x, pos.z - this.hut.door.z) < 3.2;
  }

  /**
   * Per frame: edge lights by night, the windsock in the breeze and the rotor wash.
   * @param {object} s { camera, washFrom: Vector3 (rotor hub) | null, wash: 0..1 }
   */
  update(dt, s) {
    this.t += dt;
    const night = nightUniform.value;
    this.domeMat.emissiveIntensity = 0.15 + night * 4;
    this.sign.userData.face.emissiveIntensity = night * 0.3;
    const col = this.halos.userData.color.array;
    for (let i = 0; i < LIGHTS; i++) { col[i * 3] = 0.12 * night * 3; col[i * 3 + 1] = 1 * night * 3; col[i * 3 + 2] = 0.3 * night * 3; }
    this.halos.userData.color.needsUpdate = true;
    // the floodlight comes on at dusk
    this.flood.color.value.setRGB(1, 0.86, 0.66).multiplyScalar(night * 1.6);
    this.floodOn.value = night; // (the Meshy bank's glass)
    this.floodPool.visible = night > 0.02;
    const fl = this.floodLens.userData.color.array;
    fl[0] = 6 * night; fl[1] = 5.2 * night; fl[2] = 4 * night;
    this.floodLens.userData.color.needsUpdate = true;
    if (s.camera) { glowScale(this.halos, s.camera); glowScale(this.floodLens, s.camera); }
    // windsock: a light valley breeze that comes and goes, plus the rotor wash when the heli is close
    const t = this.t;
    let wx = 2.2 + Math.sin(t * 0.07) * 1.5 + Math.sin(t * 0.53) * 0.8, wz = 1.2 + Math.sin(t * 0.05 + 2) * 1.6;
    if (s.washFrom && s.wash > 0) {
      const dx = this.sockPivot.position.x - s.washFrom.x, dz = this.sockPivot.position.z - s.washFrom.z, d = Math.hypot(dx, dz) || 1;
      const k = s.wash * 16 * (1 - smooth(10, 60, d));
      wx += (dx / d) * k; wz += (dz / d) * k;
    }
    this.wind.x = wx; this.wind.z = wz;
    const w = Math.hypot(wx, wz);
    const yaw = Math.atan2(-wz, wx); // the sock streams downwind (its cone lies along +x)
    const gust = Math.sin(t * 7.3) * 0.06 + Math.sin(t * 11.1 + 1) * 0.04;
    this.sockYaw += Math.atan2(Math.sin(yaw - this.sockYaw), Math.cos(yaw - this.sockYaw)) * (1 - Math.exp(-dt * 1.5));
    const droop = 1.35 * (1 - smooth(0.5, 9, w));
    this.sockDroop += (droop - this.sockDroop) * (1 - Math.exp(-dt * 2));
    this.sockPivot.rotation.set(0, this.sockYaw + gust * smooth(1, 6, w), 0);
    this.sockSwing.rotation.set(0, 0, -this.sockDroop + gust * 0.5);
  }
}
