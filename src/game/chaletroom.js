// Inside a chalet of the Almdorf chalet village (its own scene, like the ski shop and the car rental: main.js renders
// it through post.setView while you are in). Every chalet is the same house (game/chaletplan.js: the plan), so one
// interior serves them all; entering one carries the view to that chalet (its windows show the real world from
// where it stands: a live portal render of the game's scene, as the ski shop's windows). No furniture: the rooms,
// windows, doorways, the stair and the two bathrooms (their fixed sanitary ware only). Walking: WASD + mouse, the
// stair between the floors, E at the front door to leave.
//
// ---------------------------------------------------------------------------------------------------------------
// INTERIOR API (for the build mode, src/game/build/*: chaletadapter.js finds `chaletInteriorAPI` here)
//   chaletInteriorAPI is a live object (getters onto the one interior):
//     active / isActive()  true while you are inside YOUR rented chalet (inside any chalet: `inside`)
//     chalet               the chalet you are in: { id, name, plot } (null outside)
//     scene                the interior scene; root: the Group furniture goes in (coordinates = the house frame below)
//     camera               the interior camera; player: { pos (feet, root space), yaw, pitch, level, eye }
//     storeys              [{ level: 'ground'|'up', floorY, ceilingY, rects: [{ x0, z0, x1, z1, room }] }]
//                          (rects: the walkable floor of each room; ceilingY: the lowest full-height ceiling; the
//                          real one upstairs slopes: ceilingAt(x, z, level))
//     walls                [{ ax, az, bx, bz, t, y0, y1, storey (0|1), exterior }] solid wall segments (door gaps
//                          left out; exterior walls: the line is their inner face, t their thickness outward)
//     ceilingAt(x, z, level)
//     addObject(obj, col) -> handle   obj (already positioned in root space) is added to root; col (optional) =
//                          { x, z, hw, hd, rot, y0, y1 } an oriented box (rot = the object's yaw) or { x, z, r }:
//                          you walk against it on the storey its y0 falls on
//     removeObject(handle)
//     onFrame(cb) -> unsubscribe   cb(dt, input) every frame while inside (after walking, before the portal render)
//   House frame: metres, +x the front (the entrance), z along the house, y up from the ground outside (the ground
//   floor at y 0.35, the upper floor at 3.3). save.chalet.furniture = [{ id, x, y, z, rot }] is in this frame;
//   the build mode writes and loads it (this module does not touch it).
// ---------------------------------------------------------------------------------------------------------------
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  HX, HZ, T, IX, IZ, G, GC, FL, COLLAR, DORMER, IT, STAIR, HOLE, DOOR, ROOMS, EXTERIOR, INTERIOR, RAILS,
  ceilingUp, ceilingAt, stairY, exteriorLine,
} from './chaletplan.js';

const EYE = 1.62, R0 = 0.28;
const _v = new THREE.Vector3(), _m = new THREE.Matrix4(), _s = new THREE.Vector3(), _size = new THREE.Vector2(), _frustum = new THREE.Frustum(), _box = new THREE.Box3();
const rng = (seed) => { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); };

const PORTAL_VERT = `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const PORTAL_FRAG = `
  uniform sampler2D tView;
  uniform float uHas;
  uniform vec4 uVP;
  varying vec2 vUv;
  void main() {
    vec2 suv = (gl_FragCoord.xy - uVP.xy) / uVP.zw;
    vec3 view = texture2D(tView, suv).rgb;
    vec3 sky = mix(vec3(1.5, 1.6, 1.75), vec3(0.3, 0.5, 0.95), smoothstep(0.3, 1.0, vUv.y));
    gl_FragColor = vec4(mix(sky, view, uHas) * vec3(0.95, 0.97, 0.98), 1.0);
  }`;

// ------------------------------------------------------------------ textures (canvas, metres: 1 uv = 1 m)
function tex(w, h, draw, rep = 1) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rep, rep);
  return t;
}
const plasterTex = () => tex(256, 256, (g, w, h) => {
  const r = rng(5); g.fillStyle = '#f3efe6'; g.fillRect(0, 0, w, h);
  for (let i = 0; i < 2600; i++) { const v = 228 + r() * 22; g.fillStyle = `rgba(${v},${v - 3},${v - 9},0.35)`; g.fillRect(r() * w, r() * h, 2 + r() * 3, 2 + r() * 3); }
}, 0.5);
// boards: `n` per metre-ish, horizontal (walls) or along (floors); 2 m per texture
const boardsTex = (base, n, seed, vertical = false) => tex(512, 512, (g, w, h) => {
  const r = rng(seed), bw = h / n;
  for (let i = 0; i < n; i++) {
    const k = (r() - 0.5) * 26, [R, Gc, B] = base;
    g.fillStyle = `rgb(${R + k},${Gc + k * 0.8},${B + k * 0.6})`;
    if (vertical) g.fillRect(i * bw, 0, bw, h); else g.fillRect(0, i * bw, w, bw);
    for (let j = 0; j < 40; j++) { // grain
      g.strokeStyle = `rgba(${R - 40},${Gc - 40},${B - 30},${0.06 + r() * 0.08})`; g.lineWidth = 1;
      const o = i * bw + r() * bw; g.beginPath();
      if (vertical) { g.moveTo(o, 0); g.bezierCurveTo(o + (r() - 0.5) * 8, h / 3, o + (r() - 0.5) * 8, (2 * h) / 3, o, h); } else { g.moveTo(0, o); g.bezierCurveTo(w / 3, o + (r() - 0.5) * 8, (2 * w) / 3, o + (r() - 0.5) * 8, w, o); }
      g.stroke();
    }
    if (r() < 0.5) { g.fillStyle = `rgba(${R - 60},${Gc - 60},${B - 50},0.5)`; const kx = r() * w, ky = i * bw + bw * (0.3 + r() * 0.4); g.beginPath(); if (vertical) g.ellipse(ky, kx, 3, 5, 0, 0, 7); else g.ellipse(kx, ky, 5, 3, 0, 0, 7); g.fill(); }
    g.fillStyle = 'rgba(40,24,12,0.55)'; if (vertical) g.fillRect(i * bw, 0, 2, h); else g.fillRect(0, i * bw, w, 2);
    if (!vertical) { const x = r() * w; g.fillRect(x, i * bw, 2, bw); } // (a butt joint)
  }
}, 0.5);
const tileTex = (col, grout, n) => tex(256, 256, (g, w, h) => {
  const r = rng(9), s = w / n; g.fillStyle = grout; g.fillRect(0, 0, w, h);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { const k = (r() - 0.5) * 8; const c = new THREE.Color(col).offsetHSL(0, 0, k / 255); g.fillStyle = `#${c.getHexString()}`; g.fillRect(i * s + 2, j * s + 2, s - 4, s - 4); }
}, 1);

export class ChaletRoom {
  constructor({ renderer }) {
    this.renderer = renderer;
    this.active = false;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xcfdceb);
    this.camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 30000);
    addEventListener('resize', () => { this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix(); });
    const pmrem = new THREE.PMREMGenerator(renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.scene.environmentIntensity = 0.35;
    this.pos = new THREE.Vector3(); this.prev = new THREE.Vector3(); this.vel = new THREE.Vector3();
    this.level = 'ground'; this.yaw = -Math.PI / 2; this.pitch = -0.05; this.eyeY = G + EYE;
    this.solid = { ground: [], up: [] };   // wall segments [ax, az, bx, bz, halfThickness]
    this.round = { ground: [], up: [] };   // fixtures { x, z, r }
    this.placed = new Set();               // build mode objects { obj, col, level }
    this.hooks = new Set();
    this.aimables = [];
    this.wallList = [];                    // the API's walls
    this.root = new THREE.Group(); this.root.name = 'chalet-furniture';
    this.mats();
    this.buildPortal();
    this.buildFloors();
    this.buildWalls();
    this.buildStair();
    this.buildBathrooms();
    this.buildLights();
    this.scene.add(this.root);
    this.portalMeshes = [];
    this.scene.traverse((o) => { if (o.isMesh && o.material === this.portalMat) { this.portalMeshes.push(o); o.onBeforeRender = this.vp; } });
  }

  mats() {
    const M = (o) => new THREE.MeshStandardMaterial(o);
    this.M = {
      plaster: M({ map: plasterTex(), roughness: 0.92 }),
      timber: M({ map: boardsTex([176, 118, 70], 8, 3), roughness: 0.78 }),
      ceiling: M({ map: boardsTex([186, 130, 82], 10, 7, true), roughness: 0.8, side: THREE.DoubleSide }),
      floor: M({ map: boardsTex([158, 104, 62], 7, 11, true), roughness: 0.6 }),
      tile: M({ map: tileTex('#e9eef0', '#b9c0c4', 4), roughness: 0.3 }),
      floorTile: M({ map: tileTex('#8b8f93', '#5e6266', 3), roughness: 0.45 }),
      beam: M({ color: 0x7a4a26, roughness: 0.8 }),
      frame: M({ color: 0xf2efe8, roughness: 0.5 }),        // window frames (white painted)
      door: M({ map: boardsTex([140, 88, 48], 6, 21, true), roughness: 0.7 }),
      ceramic: M({ color: 0xfbfbfb, roughness: 0.15 }),
      chrome: M({ color: 0xd8dde2, metalness: 1, roughness: 0.15 }),
      glass: new THREE.MeshPhysicalMaterial({ color: 0xdfeef4, roughness: 0.05, transparent: true, opacity: 0.18, depthWrite: false }),
      lamp: M({ color: 0xfff3dc, emissive: 0xffd9a0, emissiveIntensity: 1.6 }),
      iron: M({ color: 0x2a2624, roughness: 0.5, metalness: 0.6 }),
    };
  }

  // ------------------------------------------------------------------ geometry helpers
  box(w, h, d, mat, x, y, z, ry = 0, parent = this.scene) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z); m.rotation.y = ry; parent.add(m); return m;
  }
  plane(x0, z0, x1, z1, y, mat, down = false) {
    const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
    // uvs in metres
    const uv = g.attributes.uv, p = g.attributes.position;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (p.getX(i) + (x0 + x1) / 2), (p.getY(i) + (z0 + z1) / 2));
    const m = new THREE.Mesh(g, mat);
    m.rotation.x = down ? Math.PI / 2 : -Math.PI / 2; m.position.set((x0 + x1) / 2, y, (z0 + z1) / 2);
    if (down) m.scale.y = -1; // (keep the plane's extent the same after flipping)
    this.scene.add(m); return m;
  }
  /**
   * A wall slab along a -> b (plan points), from off0 to off1 along n = the left of a -> b, between y0 and the top
   * profile top(x, z); openings [{ u0, u1, y0, y1 }] (u along the wall from a): doors (y0 at the floor) notch the
   * outline, windows are holes.
   */
  slab(a, b, off0, off1, y0, top, openings, mat) {
    const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz), ux = dx / L, uz = dz / L;
    const sh = new THREE.Shape(), notch = openings.filter((o) => o.y0 <= y0 + 0.02).sort((p, q) => p.u0 - q.u0);
    sh.moveTo(0, y0);
    for (const o of notch) { sh.lineTo(o.u0, y0); sh.lineTo(o.u0, o.y1); sh.lineTo(o.u1, o.y1); sh.lineTo(o.u1, y0); }
    sh.lineTo(L, y0);
    // the top: sampled every 2 cm, collinear points dropped
    const pts = [];
    for (let i = Math.ceil(L / 0.02); i >= 0; i--) { const u = Math.min(L, i * 0.02); pts.push([u, top(a[0] + ux * u, a[1] + uz * u)]); }
    const keep = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      const p = keep[keep.length - 1], q = pts[i], r = pts[i + 1];
      if (Math.abs((q[1] - p[1]) * (r[0] - q[0]) - (r[1] - q[1]) * (q[0] - p[0])) > 1e-6) keep.push(q);
    }
    keep.push(pts[pts.length - 1]);
    for (const [u, y] of keep) sh.lineTo(u, y);
    for (const o of openings) if (o.y0 > y0 + 0.02) { const h = new THREE.Path(); h.moveTo(o.u0, o.y0); h.lineTo(o.u0, o.y1); h.lineTo(o.u1, o.y1); h.lineTo(o.u1, o.y0); h.lineTo(o.u0, o.y0); sh.holes.push(h); }
    const geo = new THREE.ExtrudeGeometry(sh, { depth: off1 - off0, bevelEnabled: false, curveSegments: 1 });
    geo.translate(0, 0, off0);
    const nx = -uz, nz = ux; // (X = along, Y = up, Z = n: right-handed)
    geo.applyMatrix4(new THREE.Matrix4().makeBasis(new THREE.Vector3(ux, 0, uz), new THREE.Vector3(0, 1, 0), new THREE.Vector3(nx, 0, nz)).setPosition(a[0], 0, a[1]));
    const m = new THREE.Mesh(geo, mat); this.scene.add(m); return m;
  }
  roomAt(x, z, level) {
    for (const r of ROOMS) if (r.level === level) for (const q of r.rects) if (x >= q.x0 && x <= q.x1 && z >= q.z0 && z <= q.z1) return r;
    return null;
  }
  // the solid parts of a wall a -> b on a level (door gaps left out), for walking and for the API
  addSolid(level, a, b, half, gaps, exterior, y0, y1) {
    const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz);
    let u = 0;
    const cuts = [...gaps].sort((p, q) => p[0] - q[0]);
    cuts.push([L, L]);
    for (const [g0, g1] of cuts) {
      if (g0 > u + 0.01) {
        const s = [a[0] + (dx * u) / L, a[1] + (dz * u) / L, a[0] + (dx * g0) / L, a[1] + (dz * g0) / L, half];
        this.solid[level].push(s);
        this.wallList.push({ ax: s[0], az: s[1], bx: s[2], bz: s[3], t: exterior ? T : 2 * half, y0, y1, storey: level === 'up' ? 1 : 0, exterior });
      }
      u = Math.max(u, g1);
    }
  }

  // ------------------------------------------------------------------ the view out (live portal, as the ski shop)
  buildPortal() {
    this.portalMat = new THREE.ShaderMaterial({
      uniforms: { tView: { value: null }, uHas: { value: 0 }, uVP: { value: new THREE.Vector4(0, 0, 1, 1) } },
      vertexShader: PORTAL_VERT, fragmentShader: PORTAL_FRAG,
    });
    this.vp = (r) => r.getCurrentViewport(this.portalMat.uniforms.uVP.value);
    this.portalCam = new THREE.PerspectiveCamera(70, 1, 0.1, 30000);
    this.lastShadow = 0;
  }
  /** Where the chalet you are in stands: { scene, frame: Object3D (the house frame), hide: () => Object3D[] }. */
  setWorld(o) { this.world = o && o.scene && o.frame ? o : null; }
  releasePortal() {
    if (this.portalRT) { this.portalRT.dispose(); this.portalRT = null; }
    this.portalMat.uniforms.tView.value = null;
    this.portalMat.uniforms.uHas.value = 0;
  }
  renderPortal() {
    const o = this.world, r = this.renderer;
    if (!o || !r) return;
    const cam = this.camera;
    cam.updateMatrixWorld();
    _frustum.setFromProjectionMatrix(_m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    if (!this.portalMeshes.some((m) => _frustum.intersectsBox(_box.setFromObject(m)))) return;
    const size = r.getDrawingBufferSize(_size);
    const k = Math.min(1, 1600 / Math.max(1, size.x));
    const w = Math.max(64, Math.round(size.x * k)), h = Math.max(64, Math.round(size.y * k));
    if (!this.portalRT) {
      this.portalRT = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: true, stencilBuffer: false });
      this.portalMat.uniforms.tView.value = this.portalRT.texture;
      this.lastShadow = 0;
    } else if (this.portalRT.width !== w || this.portalRT.height !== h) this.portalRT.setSize(w, h);
    const pc = this.portalCam;
    o.frame.updateMatrixWorld();
    _m.multiplyMatrices(o.frame.matrixWorld, cam.matrixWorld).decompose(pc.position, pc.quaternion, _s);
    pc.fov = cam.fov; pc.aspect = cam.aspect; pc.near = 0.1; pc.far = 30000;
    pc.updateProjectionMatrix();
    const hidden = (o.hide?.() || []).filter(Boolean), was = hidden.map((x) => x.visible);
    for (const x of hidden) x.visible = false;
    const prev = r.getRenderTarget(), auto = r.shadowMap.autoUpdate, now = performance.now();
    r.shadowMap.autoUpdate = false;
    r.shadowMap.needsUpdate = now - this.lastShadow > 3000;
    if (r.shadowMap.needsUpdate) this.lastShadow = now;
    try {
      r.setRenderTarget(this.portalRT);
      r.clear();
      r.render(o.scene, pc);
      this.portalMat.uniforms.uHas.value = 1;
    } catch (e) {
      console.warn('Chalet window view failed', e);
      this.world = null;
      this.portalMat.uniforms.uHas.value = 0;
    } finally {
      r.setRenderTarget(prev);
      r.shadowMap.autoUpdate = auto;
      r.shadowMap.needsUpdate = false;
      hidden.forEach((x, i) => { x.visible = was[i]; });
    }
  }

  // ------------------------------------------------------------------ floors and ceilings
  buildFloors() {
    const M = this.M, H = HOLE;
    // ground floor: planks everywhere, tiles in the bathroom
    this.plane(-IX, -IZ, IX, IZ, G, M.floor);
    for (const r of ROOMS) if (r.bath) for (const q of r.rects) this.plane(q.x0, q.z0, q.x1, q.z1, (r.level === 'up' ? FL : G) + 0.004, M.floorTile);
    // round the stairwell: the upper floor and the ground floor's timber ceiling
    const around = [[-IX, -IZ, IX, H.z0], [-IX, H.z1, IX, IZ], [-IX, H.z0, H.x0, H.z1], [H.x1, H.z0, IX, H.z1]];
    for (const [x0, z0, x1, z1] of around) { this.plane(x0, z0, x1, z1, FL, M.floor); this.plane(x0, z0, x1, z1, GC, M.ceiling, true); }
    // the stairwell's edges (the slab between the ceiling and the floor above)
    const sl = FL - GC, sy = (GC + FL) / 2;
    this.box(H.x1 - H.x0, sl, 0.04, M.beam, (H.x0 + H.x1) / 2, sy, H.z0);
    this.box(H.x1 - H.x0, sl, 0.04, M.beam, (H.x0 + H.x1) / 2, sy, H.z1);
    this.box(0.04, sl, H.z1 - H.z0, M.beam, H.x1, sy, (H.z0 + H.z1) / 2);
    // ground floor beams across the house (round the stairwell)
    for (let z = -IZ + 0.9; z < IZ - 0.5; z += 1.5) {
      if (z > H.z0 - 0.2 && z < H.z1 + 0.2) { this.box(IX - H.x1, 0.18, 0.16, M.beam, (H.x1 + IX) / 2, GC - 0.09, z); this.box(H.x0 + IX, 0.18, 0.16, M.beam, (H.x0 - IX) / 2, GC - 0.09, z); } else this.box(2 * IX, 0.18, 0.16, M.beam, 0, GC - 0.09, z);
    }
    // upstairs: the sloped timber ceiling (one ribbon per band: the dormers' band is flatter at the sides)
    const band = (z0, z1) => {
      const zm = (z0 + z1) / 2, prof = [];
      for (let x = -IX; x <= IX + 1e-6; x += 0.02) prof.push([x, ceilingUp(x, zm)]);
      const keep = [prof[0]];
      for (let i = 1; i < prof.length - 1; i++) { const p = keep[keep.length - 1], q = prof[i], r = prof[i + 1]; if (Math.abs((q[1] - p[1]) * (r[0] - q[0]) - (r[1] - q[1]) * (q[0] - p[0])) > 1e-6) keep.push(q); }
      keep.push(prof[prof.length - 1]);
      const pos = [], uv = [];
      let s = 0;
      for (let i = 0; i < keep.length - 1; i++) {
        const [xa, ya] = keep[i], [xb, yb] = keep[i + 1], l = Math.hypot(xb - xa, yb - ya);
        pos.push(xa, ya, z0, xb, yb, z0, xb, yb, z1, xa, ya, z0, xb, yb, z1, xa, ya, z1);
        uv.push(s, z0, s + l, z0, s + l, z1, s, z0, s + l, z1, s, z1);
        s += l;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.computeVertexNormals();
      this.scene.add(new THREE.Mesh(g, M.ceiling));
      return keep;
    };
    band(-IZ, DORMER.z0); band(DORMER.z0, DORMER.z1); band(DORMER.z1, IZ);
    // rafters on the slopes (outside the dormers) and the collar's purlins
    const xc = IX - (COLLAR - 1.2) / 0.94; // (where the slope meets the collar)
    for (let z = -IZ + 0.5; z < IZ - 0.3; z += 1.1) {
      if (z > DORMER.z0 - 0.1 && z < DORMER.z1 + 0.1) continue;
      for (const sx of [-1, 1]) {
        const xa = sx * IX, xb = sx * xc, ya = ceilingUp(xa, z), yb = ceilingUp(xb, z), l = Math.hypot(xb - xa, yb - ya);
        const m = this.box(l, 0.14, 0.1, M.beam, (xa + xb) / 2, (ya + yb) / 2 - 0.08, z);
        m.rotation.z = Math.atan2(yb - ya, xb - xa);
      }
      this.box(2 * xc, 0.14, 0.1, M.beam, 0, FL + COLLAR - 0.08, z);
    }
    for (const sx of [-1, 1]) this.box(0.14, 0.16, 2 * IZ, M.beam, sx * xc, FL + COLLAR - 0.09, 0);
  }

  // ------------------------------------------------------------------ walls, windows, doorways
  buildWalls() {
    const M = this.M;
    // exterior walls: the inner face on the line, T thick outward; windows: frame, cross bars, sill, the live view
    for (const W of EXTERIOR) {
      const L0 = exteriorLine(W.side), up = W.level === 'up';
      // the long walls run the full length (the corners), the gables between them
      const long = L0.axis === 'z', a = long ? [L0.a[0], -HZ] : L0.a, b = long ? [L0.b[0], HZ] : L0.b;
      const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz), ux = dx / L, uz = dz / L, nl = [-uz, ux];
      const outward = nl[0] * L0.n[0] + nl[1] * L0.n[1] > 0; // (is n-left outward?)
      const y0 = up ? FL : G;
      const top = up ? (x, z) => ceilingUp(Math.max(-IX, Math.min(IX, x)), Math.max(-IZ + 0.01, Math.min(IZ - 0.01, z))) : () => GC;
      const start = long ? a[1] : a[0];
      const ops = W.openings.map((o) => ({ ...o, u0: o.c - o.w / 2 - start, u1: o.c + o.w / 2 - start }));
      const mat = up ? M.timber : M.plaster;
      this.slab(a, b, outward ? 0 : -T, outward ? T : 0, y0, top, ops.filter((o) => o.kind !== 'front'), mat);
      // (the front door's opening: a notch, its leaf shut in it)
      if (ops.some((o) => o.kind === 'front')) { /* the slab above notched it: see below */ }
      for (const o of ops) {
        const uc = (o.u0 + o.u1) / 2, cx = a[0] + ux * uc, cz = a[1] + uz * uc, ry = Math.atan2(ux, uz) - Math.PI / 2; // (box local x along the wall)
        const nx = L0.n[0], nz = L0.n[1], w = o.u1 - o.u0, h = o.y1 - o.y0, ym = (o.y0 + o.y1) / 2;
        const at = (k) => [cx + nx * k, cz + nz * k]; // k: metres outward from the inner face
        if (o.kind === 'front') {
          const [x, z] = at(T * 0.7);
          const leaf = this.box(w, h, 0.06, M.door, x, ym, z, ry);
          leaf.userData.kind = 'door'; this.aimables.push(leaf);
          const [hx, hz] = at(T * 0.7 - 0.07);
          this.box(0.04, 0.04, 0.16, M.iron, hx + uz * 0 + ux * (w / 2 - 0.12), G + 1.05, hz + uz * (w / 2 - 0.12), ry);
          // casing round it inside
          const [fx, fz] = at(-0.015);
          this.box(0.08, h + 0.08, 0.04, M.beam, fx - ux * (w / 2 + 0.04), ym + 0.04, fz - uz * (w / 2 + 0.04), ry);
          this.box(0.08, h + 0.08, 0.04, M.beam, fx + ux * (w / 2 + 0.04), ym + 0.04, fz + uz * (w / 2 + 0.04), ry);
          this.box(w + 0.16, 0.08, 0.04, M.beam, fx, o.y1 + 0.04, fz, ry);
          this.doorAt = { x: cx - nx * 0.6, z: cz - nz * 0.6, nx, nz };
          continue;
        }
        // the frame (white, at the middle of the wall's depth), the cross bars, the glass (live view) outside them
        const [fx, fz] = at(T * 0.55), fd = 0.08, fw = 0.07;
        this.box(w, fw, fd, M.frame, fx, o.y1 - fw / 2, fz, ry);
        this.box(w, fw, fd, M.frame, fx, o.y0 + fw / 2, fz, ry);
        this.box(fw, h, fd, M.frame, fx - ux * (w / 2 - fw / 2), ym, fz - uz * (w / 2 - fw / 2), ry);
        this.box(fw, h, fd, M.frame, fx + ux * (w / 2 - fw / 2), ym, fz + uz * (w / 2 - fw / 2), ry);
        this.box(0.05, h, fd * 0.8, M.frame, fx, ym, fz, ry);
        this.box(w, 0.04, fd * 0.8, M.frame, fx, o.y0 + h * 0.62, fz, ry);
        const [gx, gz] = at(T * 0.55 + 0.05);
        const pane = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.02, h - 0.02), this.portalMat);
        pane.position.set(gx, ym, gz); pane.rotation.y = Math.atan2(-nx, -nz); // (facing in)
        this.scene.add(pane);
        // the sill inside
        const [sx, sz] = at(-0.06);
        this.box(w + 0.14, 0.04, T * 0.5 + 0.14, up ? M.beam : M.frame, sx + nx * (T * 0.25), o.y0 - 0.02, sz + nz * (T * 0.25), ry);
      }
      // walking: the inner face (the front door shut: solid)
      const half = 0.0;
      this.addSolid(W.level, a, b, half, [], true, y0, up ? FL + COLLAR : GC);
    }
    // interior walls: both faces, each its room's finish (tiles in the bathrooms)
    for (const W of INTERIOR) {
      const up = W.level === 'up', a = W.a, b = W.b, alongX = a[1] === b[1];
      const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz), ux = dx / L, uz = dz / L, nl = [-uz, ux];
      const y0 = up ? FL : G;
      const top = up ? (x, z) => Math.max(ceilingUp(x, z - 0.07), ceilingUp(x, z + 0.07), ceilingUp(x - 0.07, z), ceilingUp(x + 0.07, z)) : () => GC;
      const start = alongX ? a[0] : a[1];
      const ops = (W.openings || []).map((o) => ({ ...o, u0: o.c - o.w / 2 - start, u1: o.c + o.w / 2 - start }));
      const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
      const fin = (s) => { const r = this.roomAt(mx + nl[0] * 0.3 * s, mz + nl[1] * 0.3 * s, W.level); return r?.bath ? this.M.tile : up ? this.M.timber : this.M.plaster; };
      this.slab(a, b, 0, IT / 2, y0, top, ops, fin(1));
      this.slab(a, b, -IT / 2, 0, y0, top, ops, fin(-1));
      for (const o of ops) { // a timber casing round each doorway (both faces)
        const h = o.y1 - o.y0, ry = Math.atan2(ux, uz) - Math.PI / 2;
        for (const e of [o.u0, o.u1]) this.box(0.07, h + 0.03, IT + 0.05, M.beam, a[0] + ux * e, o.y0 + h / 2, a[1] + uz * e, ry);
        this.box(o.u1 - o.u0 + 0.14, 0.07, IT + 0.05, M.beam, a[0] + ux * (o.u0 + o.u1) / 2, o.y1 + 0.035, a[1] + uz * (o.u0 + o.u1) / 2, ry);
      }
      this.addSolid(W.level, a, b, IT / 2, ops.map((o) => [o.u0, o.u1]), false, y0, up ? FL + COLLAR : GC);
    }
    // upstairs railings round the stairwell
    for (const R of RAILS) {
      const [ax, az] = R.a, [bx, bz] = R.b, L = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / L, uz = (bz - az) / L, ry = Math.atan2(ux, uz) - Math.PI / 2;
      this.box(L + 0.06, 0.06, 0.08, M.beam, (ax + bx) / 2, FL + 1.0, (az + bz) / 2, ry);
      this.box(L, 0.05, 0.05, M.beam, (ax + bx) / 2, FL + 0.1, (az + bz) / 2, ry);
      for (let u = 0; u <= L + 1e-6; u += 0.13) this.box(0.035, 0.9, 0.035, M.beam, ax + ux * u, FL + 0.55, az + uz * u);
      this.addSolid('up', R.a, R.b, 0.05, [], false, FL, FL + 1.04);
    }
  }

  // ------------------------------------------------------------------ the stair (along z, at the back of the hall)
  buildStair() {
    const S = STAIR, n = S.steps, run = (S.z1 - S.z0) / n, rise = (FL - G) / n, w = S.x1 - S.x0, xm = (S.x0 + S.x1) / 2;
    for (let k = 0; k < n; k++) {
      const y1 = G + (k + 1) * rise, z = S.z0 + (k + 0.5) * run;
      this.box(w, y1 - G, run, this.M.plaster, xm, (G + y1) / 2, z);
      this.box(w + 0.02, 0.04, run + 0.03, this.M.beam, xm, y1 - 0.02, z + 0.015); // (the tread)
    }
    // the handrail on the open side (where the stair rises through the living room)
    const za = S.z0, zb = -1.2, ya = G + 0.95, yb = stairY(zb) + 0.95, L = Math.hypot(zb - za, yb - ya);
    const rail = this.box(0.06, 0.06, L, this.M.beam, S.x1 - 0.04, (ya + yb) / 2, (za + zb) / 2);
    rail.rotation.x = -Math.atan2(yb - ya, zb - za);
    this.box(0.08, 1.0, 0.08, this.M.beam, S.x1 - 0.04, G + 0.5, S.z0 + 0.05);
    // the stair's sides in the living room (walked against from the floor)
    this.solidStair = [[S.x0, S.z0, S.x0, -1.2, 0.02], [S.x1, S.z0, S.x1, -1.2, 0.02]];
  }

  // ------------------------------------------------------------------ the bathrooms: the sanitary ware only
  buildBathrooms() {
    const M = this.M;
    const toilet = (x, y, z, face) => { // face: yaw (the bowl's front)
      const g = new THREE.Group(); g.position.set(x, y, z); g.rotation.y = face; this.scene.add(g);
      const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.15, 0.4, 20), M.ceramic); bowl.position.set(0, 0.2, 0.08); bowl.scale.z = 1.3; g.add(bowl);
      const seat = new THREE.Mesh(new THREE.CylinderGeometry(0.21, 0.21, 0.03, 20), M.ceramic); seat.position.set(0, 0.42, 0.08); seat.scale.z = 1.3; g.add(seat);
      const tank = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.4, 0.17), M.ceramic); tank.position.set(0, 0.62, -0.2); g.add(tank);
      const fl = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.02, 0.05), M.chrome); fl.position.set(0, 0.83, -0.2); g.add(fl);
      return g;
    };
    const sink = (x, y, z, face) => {
      const g = new THREE.Group(); g.position.set(x, y, z); g.rotation.y = face; this.scene.add(g);
      const basin = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.16, 0.44), M.ceramic); basin.position.set(0, 0.84, 0.02); g.add(basin);
      const bowl = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.02, 0.3), new THREE.MeshStandardMaterial({ color: 0xe8ecef, roughness: 0.1 })); bowl.position.set(0, 0.93, 0.04); g.add(bowl);
      const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.12, 0.76, 16), M.ceramic); ped.position.set(0, 0.38, -0.02); g.add(ped);
      const tap = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.16, 10), M.chrome); tap.position.set(0, 1.0, -0.14); g.add(tap);
      const sp = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.12), M.chrome); sp.position.set(0, 1.07, -0.09); g.add(sp);
      return g;
    };
    // ground floor bathroom (x 1.4..IX, z 1.6..4.2): toilet on its west wall, the shower in the back corner, the
    // basin on the wall to the snug
    toilet(1.4 + 0.3, G, 2.65, Math.PI / 2);
    this.round.ground.push({ x: 1.82, z: 2.65, r: 0.32 });
    sink(3.05, G, 4.2 - 0.26, Math.PI);
    this.round.ground.push({ x: 3.05, z: 4.2 - 0.25, r: 0.3 });
    { // the shower: a low tray, two glass sides, the head and its riser
      const x0 = 1.4 + IT / 2, x1 = x0 + 0.95, z1 = 4.2 - IT / 2, z0 = z1 - 0.95;
      this.box(x1 - x0, 0.06, z1 - z0, M.ceramic, (x0 + x1) / 2, G + 0.03, (z0 + z1) / 2);
      this.box(0.012, 1.95, z1 - z0 - 0.45, M.glass, x1, G + 1.03, (z0 + z1) / 2 + 0.225);
      this.box(x1 - x0, 1.95, 0.012, M.glass, (x0 + x1) / 2, G + 1.03, z0);
      this.box(0.025, 1.3, 0.025, M.chrome, x0 + 0.06, G + 1.5, z1 - 0.3);
      const head = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.02, 20), M.chrome); head.position.set(x0 + 0.25, G + 2.15, z1 - 0.3); this.scene.add(head);
      this.box(0.22, 0.02, 0.02, M.chrome, x0 + 0.15, G + 2.16, z1 - 0.3);
      this.solid.ground.push([x1, z0, x1, z1 - 0.45, 0.02], [x0, z0, x1, z0, 0.02]);
    }
    // the upper bathroom (x -IX..-1.7, z -2.6..2.6, the dormer at its back wall): the bath along the back, the toilet
    // under the dormer's window, the basin on the stairwell's wall
    {
      const x0 = -IX, x1 = x0 + 0.78, z0 = -2.5, z1 = -0.8, h = 0.56, xm = (x0 + x1) / 2, zm = (z0 + z1) / 2;
      this.box(x1 - x0, h, z1 - z0, M.ceramic, xm, FL + h / 2, zm);
      const inner = this.box(x1 - x0 - 0.14, 0.02, z1 - z0 - 0.16, new THREE.MeshStandardMaterial({ color: 0xdfe8ec, roughness: 0.08 }), xm, FL + h - 0.06, zm);
      void inner;
      this.box(0.04, 0.24, 0.04, M.chrome, xm, FL + h + 0.12, z1 - 0.12);
      this.box(0.04, 0.04, 0.14, M.chrome, xm, FL + h + 0.24, z1 - 0.18);
      this.solid.up.push([x1, z0, x1, z1, 0.03], [x0, z1, x1, z1, 0.03]);
    }
    toilet(-IX + 0.3, FL, 0.6, Math.PI / 2);
    this.round.up.push({ x: -IX + 0.42, z: 0.6, r: 0.32 });
    sink(-1.7 - IT / 2 - 0.24, FL, -0.2, -Math.PI / 2);
    this.round.up.push({ x: -1.7 - 0.3, z: -0.2, r: 0.3 });
  }

  // ------------------------------------------------------------------ warm light: a lamp in every room
  buildLights() {
    const S = this.scene;
    S.add(new THREE.HemisphereLight(0xfff4e6, 0x9a8068, 1.25));
    S.add(new THREE.AmbientLight(0xffeedd, 0.35));
    for (const r of ROOMS) {
      const q = r.rects.reduce((a, b) => ((b.x1 - b.x0) * (b.z1 - b.z0) > (a.x1 - a.x0) * (a.z1 - a.z0) ? b : a));
      const x = (q.x0 + q.x1) / 2, z = (q.z0 + q.z1) / 2, up = r.level === 'up', y = up ? Math.min(ceilingUp(x, z), FL + COLLAR) - 0.05 : GC - 0.2;
      const area = (q.x1 - q.x0) * (q.z1 - q.z0);
      const L = new THREE.PointLight(0xffd8a8, 4 + area * 0.35, 14, 1.6);
      L.position.set(x, y - 0.35, z); S.add(L);
      const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.2, 0.14, 16, 1, true), this.M.lamp); shade.position.set(x, y - 0.3, z); S.add(shade);
      this.box(0.01, 0.25, 0.01, this.M.iron, x, y - 0.12, z);
    }
  }

  // ------------------------------------------------------------------ walking
  pushSegs(list, p) {
    for (const [ax, az, bx, bz, half] of list) {
      const ex = bx - ax, ez = bz - az, l2 = ex * ex + ez * ez || 1e-9;
      const t = Math.max(0, Math.min(1, ((p.x - ax) * ex + (p.z - az) * ez) / l2));
      const qx = ax + ex * t, qz = az + ez * t, dx = p.x - qx, dz = p.z - qz, d = Math.hypot(dx, dz), rr = R0 + half;
      if (d < rr) { if (d > 1e-5) { p.x = qx + (dx / d) * rr; p.z = qz + (dz / d) * rr; } else { p.x += -ez / Math.sqrt(l2) * rr; p.z += ex / Math.sqrt(l2) * rr; } }
    }
  }
  pushObjects(level, p) {
    for (const o of this.round[level]) { const dx = p.x - o.x, dz = p.z - o.z, d = Math.hypot(dx, dz), rr = o.r + R0; if (d < rr && d > 1e-5) { p.x = o.x + (dx / d) * rr; p.z = o.z + (dz / d) * rr; } }
    for (const e of this.placed) {
      const c = e.col;
      if (!c || e.level !== level) continue;
      if (c.r != null) { const dx = p.x - c.x, dz = p.z - c.z, d = Math.hypot(dx, dz), rr = c.r + R0; if (d < rr && d > 1e-5) { p.x = c.x + (dx / d) * rr; p.z = c.z + (dz / d) * rr; } continue; }
      const co = Math.cos(c.rot || 0), si = Math.sin(c.rot || 0), dx = p.x - c.x, dz = p.z - c.z;
      const lx = dx * co - dz * si, lz = dx * si + dz * co, ex = c.hw + R0, ez = c.hd + R0;
      if (Math.abs(lx) >= ex || Math.abs(lz) >= ez) continue;
      let nx = lx, nz = lz;
      if (ex - Math.abs(lx) < ez - Math.abs(lz)) nx = Math.sign(lx || 1) * ex; else nz = Math.sign(lz || 1) * ez;
      p.x = c.x + nx * co + nz * si; p.z = c.z - nx * si + nz * co;
    }
  }
  walk(dt) {
    const p = this.pos, q = this.prev.copy(p), S = STAIR, H = HOLE;
    p.addScaledVector(this.vel, dt);
    if (this.level === 'ground') {
      if (q.z <= S.z0 && p.z > S.z0 && p.x > S.x0 + 0.05 && p.x < S.x1 - 0.05) this.level = 'stair';
      else {
        for (let i = 0; i < 2; i++) { this.pushSegs(this.solid.ground, p); this.pushSegs(this.solidStair, p); this.pushObjects('ground', p); }
        if (p.x > S.x0 - R0 && p.x < S.x1 + R0 && p.z > S.z0 && p.z < -1.2) { // (under the stair: kept out at its foot)
          if (q.z <= S.z0) p.z = S.z0; else p.x = p.x < (S.x0 + S.x1) / 2 ? S.x0 - R0 : S.x1 + R0;
        }
      }
    }
    if (this.level === 'stair') {
      p.x = Math.max(S.x0 + R0, Math.min(S.x1 - R0, p.x));
      if (p.z < S.z0) this.level = 'ground';
      else if (p.z > S.z1) this.level = 'up';
    }
    if (this.level === 'up') {
      if (q.z >= H.z1 && p.z < H.z1 && p.x > H.x0 + 0.05 && p.x < H.x1 - 0.05) this.level = 'stair';
      else {
        for (let i = 0; i < 2; i++) { this.pushSegs(this.solid.up, p); this.pushObjects('up', p); }
        if (p.x > H.x0 && p.x < H.x1 + R0 && p.z > H.z0 - R0 && p.z < H.z1) { // (never into the stairwell but down the stair)
          if (q.x >= H.x1 + R0 - 0.01) p.x = H.x1 + R0; else if (q.z <= H.z0 - R0 + 0.01) p.z = H.z0 - R0; else p.z = H.z1;
        }
        // headroom under the slopes (the dormers' band: full height to the wall)
        const lim = p.z > DORMER.z0 && p.z < DORMER.z1 ? IX - R0 : 3.0;
        p.x = Math.max(-lim, Math.min(lim, p.x));
      }
    }
    p.x = Math.max(-IX + R0, Math.min(IX - R0, p.x));
    p.z = Math.max(-IZ + R0, Math.min(IZ - R0, p.z));
    p.y = this.level === 'up' ? FL : this.level === 'stair' ? stairY(p.z) : G;
  }

  // ------------------------------------------------------------------ per frame
  /** In through the front door (the hall, facing in). */
  enter() {
    this.active = true;
    const d = this.doorAt;
    this.pos.set(d.x - d.nx * 0.4, G, d.z - d.nz * 0.4); this.level = 'ground'; this.eyeY = G + EYE;
    this.yaw = Math.atan2(-d.nx, -d.nz); this.pitch = -0.05; this.vel.set(0, 0, 0);
  }
  leave() { this.active = false; this.releasePortal(); }
  /** The room you are in (its name for the HUD). */
  roomName() { return (this.level === 'stair' ? 'Stairs' : this.roomAt(this.pos.x, this.pos.z, this.level)?.name) || 'Chalet'; }

  /** Walk / look (input null: a panel is open). Returns what you can do: { kind: 'door', label } or null. */
  update(dt, input, sensitivity = 1) {
    if (input) {
      const sens = 0.0022 * sensitivity;
      this.yaw -= input.mdx * sens;
      this.pitch = Math.max(-1.3, Math.min(1.2, this.pitch - input.mdy * sens));
      const fw = (input.down('KeyW') ? 1 : 0) - (input.down('KeyS') ? 1 : 0), st = (input.down('KeyD') ? 1 : 0) - (input.down('KeyA') ? 1 : 0);
      const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw), want = _v.set(-fz * st + fx * fw, 0, fx * st + fz * fw);
      if (want.lengthSq()) want.normalize().multiplyScalar(2.3);
      this.vel.lerp(want, 1 - Math.exp(-dt * 10));
    } else this.vel.multiplyScalar(Math.exp(-dt * 10));
    this.walk(dt);
    this.eyeY += (this.pos.y + EYE - this.eyeY) * (1 - Math.exp(-dt * 14));
    this.camera.position.set(this.pos.x, this.eyeY, this.pos.z);
    const dir = new THREE.Vector3(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), Math.cos(this.yaw) * Math.cos(this.pitch));
    this.camera.lookAt(_v.copy(this.camera.position).add(dir));
    for (const cb of this.hooks) { try { cb(dt, input); } catch (e) { console.warn('chalet hook', e); } }
    this.renderPortal();
    if (!input) return null;
    // the front door: looked at, or stood right at it
    const d = this.doorAt, near = this.level === 'ground' && Math.hypot(this.pos.x - d.x, this.pos.z - d.z) < 1.0;
    const hit = new THREE.Raycaster(this.camera.position, dir, 0, 3).intersectObjects(this.aimables, false)[0];
    if (near || hit?.object.userData.kind === 'door') return { kind: 'door', label: 'Leave the chalet' };
    return null;
  }

  // ------------------------------------------------------------------ the build mode's hooks (see the API above)
  addObject(obj, col) {
    if (obj && obj.parent !== this.root) this.root.add(obj);
    const y0 = col?.y0 ?? obj?.position?.y ?? G;
    const e = { obj, col: col || null, level: y0 > (G + FL) / 2 ? 'up' : 'ground' };
    this.placed.add(e);
    return e;
  }
  removeObject(h) {
    if (!h) return;
    const e = h.obj ? h : [...this.placed].find((x) => x.obj === h);
    if (!e) { h.parent?.remove?.(h); return; }
    this.placed.delete(e);
    e.obj?.parent?.remove(e.obj);
  }
  onFrame(cb) { this.hooks.add(cb); return () => this.hooks.delete(cb); }
  storeys() {
    return ['ground', 'up'].map((level) => ({
      level, floorY: level === 'up' ? FL : G, ceilingY: level === 'up' ? FL + DORMER.h : GC,
      rects: ROOMS.filter((r) => r.level === level).flatMap((r) => r.rects.map((q) => ({ ...q, room: r.id }))),
    }));
  }
}

// ------------------------------------------------------------------ the API (live: game/chalets.js sets `room`)
const api = { room: null, owner: null };
export function setChaletInterior(room, owner) { api.room = room; api.owner = owner; }
export const chaletInteriorAPI = {
  get inside() { return !!api.room?.active; },
  get active() { return !!(api.room?.active && api.owner?.insideOwn?.()); },
  isActive() { return this.active; },
  get chalet() { return api.room?.active ? api.owner?.current || null : null; },
  get scene() { return api.room?.scene || null; },
  get root() { return api.room?.root || null; },
  get camera() { return api.room?.camera || null; },
  get player() { const r = api.room; return r ? { pos: r.pos, yaw: r.yaw, pitch: r.pitch, level: r.level, eye: r.eyeY } : null; },
  get storeys() { return api.room ? api.room.storeys() : []; },
  get walls() { return api.room ? api.room.wallList : []; },
  ceilingAt,
  addObject(obj, col) { return api.room?.addObject(obj, col) ?? null; },
  removeObject(h) { api.room?.removeObject(h); },
  onFrame(cb) {
    if (api.room) return api.room.onFrame(cb);
    const t = setInterval(() => { if (api.room) { clearInterval(t); api.room.onFrame(cb); } }, 500); // (before the room exists)
    return () => { clearInterval(t); api.room?.hooks.delete(cb); };
  },
};
if (typeof window !== 'undefined') window.chaletInteriorAPI = chaletInteriorAPI;
