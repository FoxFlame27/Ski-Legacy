// Gondola end stations, built (Nov 1 2026, the user: "also the gondola stop models are still super ugly, fix that":
// the Meshy D-Line stations are gone, models/gondola_station*.glb with them). Modelled on a modern Doppelmayr D-Line /
// Leitner station: a long clean hall over the cable loop on a stone-clad concrete plinth, the boarding deck up at the
// cabins' floor (the cabins hang 4.4 m over the station's ground), the two cabin channels cut into it round the
// bullwheel with the guide rail and the tyre conveyor over them, yellow edge lines and boarding gates, big glazed side
// walls and gables between slim steel frames, a gently vaulted roof on a warm timber soffit with a snow layer and LED
// strips under it, the operator's glass cabin, turnstiles (valley), the entrance stair up through the plinth, the ticket
// window (valley) and the lift's name on lit signs. The summit station is a little shorter, its roof flatter, without
// ticket window and turnstiles.
//
// Station frame (the same cable path and bullwheel as the Meshy station had): origin on the station's
// ground at the bullwheel's axis, +z down the line (the open portal the cabins ride out of), the cable lanes at
// x = +-side, the rope's half loop round the bullwheel on -z, y up. Built in a canonical layout with the entrance on -x
// and mirrored (mx = -1) when the other side has the better ground. Per material one merged mesh (base / steel /
// glass / lights) plus the signs: five draw calls a station.
// Colliders: the plinth (with a `top` at the deck: you walk on it from the stair, never step up onto it from the
// snow, cars stop at it), the glazed walls, the channel edges and the stairwell's balustrade (deck-high tops), the
// operator's cabin and the turnstiles; the deck and the stair are walkable surfaces (world.addSurface). Boarding stays
// the prompt within 20 m of the bullwheel (main.js), from the snow in front or up on the deck.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { world } from './world.js';
import { nightUniform } from './village.js';
import { quality } from '../engine/quality.js';

export const STATION_DECK = 4.35; // m: the boarding deck over the station's ground (the cabins' floor: rope 7.5 - cabin 3.1)
const DECK = STATION_DECK;
// (Nov 1 2026, the user: "the gondola stations are nice but a bit big": ~15-20 % less bulk: the hall 0.7 m narrower,
// ~3 m shorter behind the loop and 1 m shorter at the portal, the roof lower and flatter with less overhang; the cabin
// path, the bullwheel, the deck height and boarding unchanged)
const W2 = 6.5;   // half width of the plinth / hall (across the line)
const LANE = 1.3; // half width of a cabin channel round its rope
const WALL = 0.25;
const DIMS = { valley: { zb: -11.4, zf: 6.2, rise: 1.25 }, top: { zb: -10.8, zf: 5.6, rise: 1.0 } };

const C = {
  stone: '#77736c', laneFloor: '#5f615f', conc: '#a8a9a5', pave: '#c2c2bd', yellow: '#f1c40a', wood: '#b07f4f',
  snow: '#f3f6fa', steel: '#cdd2d7', white: '#e9ecee', anth: '#30353b', blue: '#1546c8', rubber: '#202326', dark: '#1d2126',
};

const _c = new THREE.Color(), _c2 = new THREE.Color(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4();
const _v = new THREE.Vector3(), _a = new THREE.Vector3(), _one = new THREE.Vector3(1, 1, 1), _Y = new THREE.Vector3(0, 1, 0);
const smooth = (t) => t * t * (3 - 2 * t);

// geometry per material, every part with vertex colours, merged at the end
class Kit {
  constructor() { this.parts = { base: [], metal: [], glass: [], light: [] }; }
  add(kind, g, col, colTop = null) {
    if (g.index) g = g.toNonIndexed();
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
    if (!g.attributes.normal) g.computeVertexNormals();
    const n = g.attributes.position.count, cols = new Float32Array(n * 3), nr = g.attributes.normal;
    _c.set(col); if (colTop) _c2.set(colTop);
    for (let i = 0; i < n; i++) {
      const c = colTop && nr.getY(i) > 0.6 ? _c2 : _c; // (colTop: the faces looking up: paving on a slab, treads on a step)
      cols[i * 3] = c.r; cols[i * 3 + 1] = c.g; cols[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    this.parts[kind].push(g);
    return g;
  }
  // an axis-aligned box from its extents (r: bevelled edges)
  box(kind, x0, x1, y0, y1, z0, z1, col, { r = 0, top = null } = {}) {
    if (x1 < x0) [x0, x1] = [x1, x0];
    const w = x1 - x0, h = y1 - y0, d = z1 - z0;
    if (w <= 0 || h <= 0 || d <= 0) return null;
    const rr = Math.min(r, w / 2 - 0.005, h / 2 - 0.005, d / 2 - 0.005);
    const g = rr > 0.005 ? new RoundedBoxGeometry(w, h, d, 1, rr) : new THREE.BoxGeometry(w, h, d);
    g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    return this.add(kind, g, col, top);
  }
  // a bar from a to b ([x, y, z]), square or round section s
  bar(kind, a, b, s, col, round = false) {
    _v.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const len = _v.length();
    if (len < 1e-3) return null;
    _v.multiplyScalar(1 / len);
    const g = round ? new THREE.CylinderGeometry(s / 2, s / 2, len, 8, 1) : new THREE.BoxGeometry(s, len, s);
    _q.setFromUnitVectors(_Y, _v);
    g.applyMatrix4(_m.compose(_a.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2), _q, _one));
    return this.add(kind, g, col);
  }
  // a horizontal sheet over x0..x1, z0..z1 (nx x nz cells), its height f(x, z); facing up (or down)
  sheet(kind, x0, x1, z0, z1, nx, nz, f, col, down = false) {
    const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0, nx, nz);
    g.rotateX(down ? Math.PI / 2 : -Math.PI / 2);
    g.translate((x0 + x1) / 2, 0, (z0 + z1) / 2);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) p.setY(i, f(p.getX(i), p.getZ(i)));
    g.computeVertexNormals();
    return this.add(kind, g, col);
  }
  // a slab: the polygon pts ([x, z]) from y0 up to y1
  slab(kind, pts, y0, y1, colSide, colTop, bevel = 0) {
    const shape = new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, -z)));
    const g = new THREE.ExtrudeGeometry(shape, { depth: y1 - y0 - 2 * bevel, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelOffset: -bevel, bevelSegments: 1, curveSegments: 1 });
    g.rotateX(-Math.PI / 2);
    g.translate(0, y0 + bevel, 0);
    return this.add(kind, g, colSide, colTop);
  }
  // a flat polygon ([x, y]) in the plane z (a gable's glass)
  shapeZ(kind, pts, z, col) {
    const g = new THREE.ShapeGeometry(new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y))));
    g.translate(0, 0, z);
    return this.add(kind, g, col);
  }
  // an upright quad from (x0, z0) to (x1, z1), y0..y1 (glass panes: the glass is two-sided)
  vquad(kind, x0, z0, x1, z1, y0, y1, col) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([x0, y0, z0, x1, y0, z1, x1, y1, z1, x0, y0, z0, x1, y1, z1, x0, y1, z0], 3));
    g.computeVertexNormals();
    return this.add(kind, g, col);
  }
  // a flat quad through four points ([x, y, z], in order round it: a sloping stair balustrade's glass)
  quad(kind, a, b, c, d, col) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([...a, ...b, ...c, ...a, ...c, ...d], 3));
    g.computeVertexNormals();
    return this.add(kind, g, col);
  }
  // flat half ring round the back (-z) at height y
  ring(kind, r0, r1, y, col) {
    const g = new THREE.RingGeometry(r0, r1, 32, 1, 0, Math.PI);
    g.rotateX(-Math.PI / 2);
    g.translate(0, y, 0);
    return this.add(kind, g, col);
  }
  // a half torus round the back (-z) at height y (radial 4: a square-ish section)
  arcTube(kind, r, tube, y, col, radial = 6) {
    const g = new THREE.TorusGeometry(r, tube, radial, 32, Math.PI);
    g.rotateX(-Math.PI / 2);
    g.translate(0, y, 0);
    return this.add(kind, g, col);
  }
  merge(kind, mirror) {
    const list = this.parts[kind];
    if (!list.length) return null;
    const g = mergeGeometries(list);
    list.forEach((p) => p.dispose());
    if (mirror) { g.scale(-1, 1, 1); flipWinding(g); }
    g.computeBoundingSphere();
    return g;
  }
}
function flipWinding(g) {
  for (const k of Object.keys(g.attributes)) {
    const a = g.attributes[k], s = a.itemSize, arr = a.array;
    for (let t = 0; t + 2 < a.count; t += 3) for (let j = 0; j < s; j++) {
      const i1 = (t + 1) * s + j, i2 = (t + 2) * s + j, tmp = arr[i1];
      arr[i1] = arr[i2]; arr[i2] = tmp;
    }
  }
}

// the shared materials: concrete / stone / paving / timber / snow (rough), steel (satin metal), glass (clear, a
// slight blue-green tint, the sky's reflections from scene.environment), LED light (dim by day, bright at night)
let MATS = null;
function nightScaled(m, day, night, key) {
  m.onBeforeCompile = (s) => {
    s.uniforms.uNight = nightUniform;
    s.fragmentShader = s.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uNight;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n  totalEmissiveRadiance *= ${day.toFixed(3)} + ${(night - day).toFixed(3)} * uNight;`);
  };
  m.customProgramCacheKey = () => key;
  return m;
}
function materials() {
  return (MATS ??= {
    base: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.84, metalness: 0 }),
    metal: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.34, metalness: 0.72 }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0x9dbdcc, roughness: 0.04, metalness: 0.05, ior: 1.5, specularIntensity: 1, envMapIntensity: 1.6, transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false }),
    light: nightScaled(new THREE.MeshStandardMaterial({ color: 0xfff8ee, emissive: 0xffecc8, emissiveIntensity: 2.4, roughness: 0.5 }), 0.3, 1, 'gst-light'),
  });
}

// the signs: one canvas per station (the lift's name and the station, TICKETS, ENTRANCE)
const SIGN_W = 1024, SIGN_H = 384, NAME_H = 170;
const UV = { name: [0, 1 - NAME_H / SIGN_H, 1, 1], tickets: [0, 0, 0.5, 0.5], entrance: [0.5, 0, 1, 0.5] };
// (extra: { h, draw(g, y0, { font, fit }) }: more canvas under the sign, drawn from y0 down: the mid-station's boards)
function signMaterial(name, sub, extra = null) {
  if (typeof document === 'undefined') return null;
  const cv = document.createElement('canvas');
  cv.width = SIGN_W; cv.height = SIGN_H + (extra ? extra.h : 0);
  const g = cv.getContext('2d');
  const font = (w, px) => `${w} ${px}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  const fit = (txt, w, px, max) => { let s = px; g.font = font(w, s); while (g.measureText(txt).width > max && s > 18) { s -= 2; g.font = font(w, s); } return s; };
  // the name board: anthracite, the house-blue square with a white gondola pictogram, the name, the station below
  g.fillStyle = C.dark; g.fillRect(0, 0, SIGN_W, NAME_H);
  g.fillStyle = C.blue; g.fillRect(0, 0, NAME_H, NAME_H);
  g.strokeStyle = '#ffffff'; g.lineWidth = 7; g.lineCap = 'round';
  g.beginPath(); g.moveTo(18, 46); g.lineTo(152, 30); g.stroke();
  g.beginPath(); g.moveTo(85, 38); g.lineTo(85, 66); g.stroke();
  g.fillStyle = '#ffffff';
  g.beginPath(); g.roundRect ? g.roundRect(46, 66, 78, 76, 14) : g.rect(46, 66, 78, 76); g.fill();
  g.fillStyle = C.blue; g.fillRect(56, 78, 58, 26);
  g.fillStyle = '#ffffff'; g.textBaseline = 'alphabetic'; g.textAlign = 'left';
  fit(name.toUpperCase(), 700, 82, SIGN_W - NAME_H - 60);
  g.fillText(name.toUpperCase(), NAME_H + 34, 104);
  g.fillStyle = '#a9bfd6';
  fit(sub.toUpperCase(), 500, 34, SIGN_W - NAME_H - 60);
  g.fillText(sub.toUpperCase(), NAME_H + 36, 150);
  g.fillStyle = C.blue; g.fillRect(NAME_H, NAME_H - 6, SIGN_W - NAME_H, 6);
  // TICKETS (blue) and ENTRANCE (anthracite)
  for (const [txt, x0, bg] of [['TICKETS', 0, C.blue], ['ENTRANCE', SIGN_W / 2, C.dark]]) {
    g.fillStyle = bg; g.fillRect(x0, SIGN_H - 192, SIGN_W / 2, 192);
    g.fillStyle = '#ffffff'; g.textAlign = 'center';
    fit(txt, 700, 80, SIGN_W / 2 - 60);
    g.fillText(txt, x0 + SIGN_W / 4, SIGN_H - 192 + 124);
  }
  if (extra) extra.draw(g, SIGN_H, { font, fit });
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return nightScaled(new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 1, roughness: 0.45, metalness: 0.1 }), 0.12, 0.7, 'gst-sign');
}
// a sign quad centred on c ([x, y, z]) facing n ([x, 0, z]), w x h, its part of the canvas uv [u0, v0, u1, v1]
function signQuad(out, c, n, w, h, uv) {
  const rx = n[2], rz = -n[0]; // right = up x n
  const p = (sx, sy) => [c[0] + rx * sx * w / 2, c[1] + sy * h / 2, c[2] + rz * sx * w / 2];
  const [a, b, cc, d] = [p(-1, -1), p(1, -1), p(1, 1), p(-1, 1)];
  out.pos.push(...a, ...b, ...cc, ...a, ...cc, ...d);
  for (let i = 0; i < 6; i++) out.nor.push(n[0], 0, n[2]);
  const [u0, v0, u1, v1] = uv;
  out.uv.push(u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1);
}

// the shared roof of a station hall: warm larch soffit underneath, satin white fascias, the snow on top (thick in
// the middle, rounded over the edges); a shallow vault across the hall from zr0 to zr1
const ROOF_T = 0.38; // the roof's thickness
const roofEaves = (rMax) => Math.max(9.4, rMax + 2.0); // the vault's eaves: over the rope (and the grips) by 2 m
const portalHeader = (ropeY, rMax) => Math.max(ropeY + 1.35, rMax + 1.25); // a portal's header beam: over the conveyor
function hallRoof(K, Wr, roofTop, roofBot, zr0, zr1) {
  const clamp = THREE.MathUtils.clamp;
  K.sheet('base', -Wr, Wr, zr0, zr1, 28, 1, (x) => roofBot(x), C.wood, true);
  for (const sx of [-1, 1]) K.box('metal', sx * Wr - 0.06, sx * Wr, roofBot(Wr) - 0.02, roofTop(Wr) + 0.01, zr0, zr1, C.white);
  const n = 14, top = [], bot = [];
  for (let i = 0; i <= n; i++) { const x = -Wr + (2 * Wr * i) / n; top.push([x, roofTop(x) + 0.01]); bot.unshift([x, roofBot(x) - 0.02]); }
  const section = [...top, ...bot];
  K.shapeZ('metal', section, zr1, C.white);
  K.add('metal', new THREE.ShapeGeometry(new THREE.Shape(section.map(([x, y]) => new THREE.Vector2(x, y)))).rotateY(Math.PI).translate(0, 0, zr0), C.white);
  K.sheet('base', -Wr - 0.04, Wr + 0.04, zr0 - 0.04, zr1 + 0.04, 40, Math.max(10, Math.round((zr1 - zr0) / 1.6)), (x, z) => {
    const d = Math.min(Wr - Math.abs(x), z - zr0, zr1 - z), xr = clamp(x, -Wr, Wr);
    if (d <= 0.02) return roofTop(xr) - 0.035;
    return roofTop(xr) + 0.05 + 0.24 * smooth(Math.min(1, d / 0.8)) + 0.025 * Math.sin(x * 1.7 + z * 0.9) * Math.min(1, d);
  }, C.snow);
}
// downlights in a portal's canopy, z m along the line
function downlights(K, roofBot, z) {
  for (const x of [-4.5, -2.25, 0, 2.25, 4.5]) {
    const g = new THREE.CylinderGeometry(0.13, 0.13, 0.04, 12);
    g.translate(x, roofBot(x) - 0.02, z);
    K.add('light', g, C.white);
  }
}
// the cabins' guide rail and the tyre conveyor over both lanes (x = +-s) from z0 to z1, hung from the roof
function conveyors(K, s, ropeY, roofBot, z0, z1) {
  const yr = ropeY + 0.5, ycv = ropeY + 1.0;
  for (const sx of [-1, 1]) {
    const x = sx * s;
    K.box('metal', x - 0.06, x + 0.06, yr - 0.1, yr + 0.1, z0, z1, C.steel);
    K.box('metal', x - 0.22, x + 0.22, ycv - 0.18, ycv + 0.18, z0, z1, C.anth);
    for (let z = z0 + 0.8; z < z1; z += 3) K.bar('metal', [x, ycv + 0.18, z], [x, roofBot(x) - 0.2, z], 0.1, C.steel);
    for (let z = z0 + 0.4; z < z1 - 0.2; z += 0.9) {
      const g = new THREE.CylinderGeometry(0.17, 0.17, 0.12, 10);
      g.rotateZ(Math.PI / 2);
      g.translate(x, ycv - 0.3, z);
      K.add('metal', g, C.rubber);
    }
  }
}
// one merged mesh per material (mirrored for mx = -1) plus the signs (sm: their material, q: their quads), placed
function assemble(K, mx, sm, q, px, py, pz, yaw) {
  const M = materials();
  const group = new THREE.Group();
  group.name = 'gondola-station';
  for (const k of ['base', 'metal', 'glass', 'light']) {
    const g = K.merge(k, mx < 0);
    if (!g) continue;
    const m = new THREE.Mesh(g, M[k]);
    m.castShadow = k === 'base' || k === 'metal';
    m.receiveShadow = k === 'base' || k === 'metal';
    if (k === 'glass') { m.renderOrder = 1; m.userData.noCollide = true; }
    group.add(m);
  }
  if (sm && q.pos.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(q.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(q.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(q.uv, 2));
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, sm);
    m.receiveShadow = true;
    group.add(m);
  }
  group.position.set(px, py, pz);
  group.rotation.y = yaw;
  group.updateMatrix();
  for (const c of group.children) { c.updateMatrix(); c.matrixAutoUpdate = false; }
  group.updateMatrixWorld(true);
  return group;
}

/**
 * Build one gondola end station.
 * o: { x, y, z: the bullwheel's foot (the station's ground), yaw (local +z down the line), top (summit station),
 *      side (the rope's offset), ropeY (rope height over the ground), carH (cabin height), name, place,
 *      ropeAt(z) -> [up-lane, down-lane] rope height over the station's ground z m out along the line, blocked(x, z) }
 * Returns { group, colliders, back (m from the bullwheel to the back wall), shaftScale (the bullwheel's height scale:
 * its drive shaft up to the soffit), surfaces }.
 */
export function buildGondolaStation(o) {
  const { x: px, y: py, z: pz, yaw, top, side: s, ropeY, carH, ropeAt, blocked } = o;
  const D = DIMS[top ? 'top' : 'valley'], ZB = D.zb, ZF = D.zf;
  const Ro = s + LANE, Ri = s - LANE;
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const toW = (mx, x, z) => { const X = x * mx; return { x: px + X * cy + z * sy, z: pz - X * sy + z * cy }; };
  const clamp = THREE.MathUtils.clamp;

  // the rope over the first metres out of the portal: the roof and the portal clear its highest point, the channel
  // floors its lowest cabin; the guide rail runs as far as the rope stays level
  let rMax = ropeY, rMin = ropeY, zFlat = ZF - 0.4;
  for (let z = 0; z <= ZF + 2.6; z += 0.5) {
    const [a, b] = ropeAt(z);
    rMax = Math.max(rMax, a, b);
    if (z <= ZF + 0.5) rMin = Math.min(rMin, a, b);
    if (Math.max(Math.abs(a - ropeY), Math.abs(b - ropeY)) > 0.25) zFlat = Math.min(zFlat, z - 0.5);
  }
  zFlat = Math.max(1.5, zFlat);
  const lf = clamp(rMin - carH - 0.5, 0.4, DECK - 1.1); // the channels' floor

  // the entrance: a door in the long side at the back corner, the stair straight in and up to the deck; on the side
  // whose ground at the door is nearest the station's (and free)
  const zs0 = ZB + 0.5, zs1 = ZB + 2.7, zd = (zs0 + zs1) / 2;
  const doorG = (mx) => { const q = toW(mx, -W2 - 1.4, zd); return world.height(q.x, q.z) - py; };
  const score = (mx) => { const q = toW(mx, -W2 - 1.4, zd); return Math.abs(doorG(mx)) + (blocked?.(q.x, q.z) ? 20 : 0); };
  const mx = score(1) <= score(-1) ? 1 : -1;
  const gd = clamp(doorG(mx), -6, DECK - 1.2);
  const xs0 = -W2 + 1.0, run = clamp((DECK - gd) / 0.6, 4, 2 * W2 - 2.6), xt = xs0 + run;
  // the plinth goes down past the lowest ground under it
  let gMin = Math.min(gd, 0);
  for (const gx of [-W2, 0, W2]) for (const gz of [ZB, (ZB + ZF) / 2, ZF]) { const q = toW(mx, gx, gz); gMin = Math.min(gMin, world.height(q.x, q.z) - py); }
  const yb = gMin - 0.8;

  // the roof: a shallow vault across the hall, overhanging the walls, cantilevered out over the portal
  const Wr = W2 + 0.6, R = D.rise, E = roofEaves(rMax);
  const roofTop = (x) => E + R * (1 - (x / Wr) ** 2), roofBot = (x) => roofTop(x) - ROOF_T;
  const zr0 = ZB - 0.6, zr1 = ZF + 1.4;
  const pt = portalHeader(ropeY, rMax); // the portal's header (over the grips and the conveyor)
  const curve = (x0, x1, dy = 0, n = 14) => { const out = []; for (let i = 0; i <= n; i++) { const x = x0 + ((x1 - x0) * i) / n; out.push([x, roofBot(x) - dy]); } return out; };
  const arc = (r, from, to, n = 18) => { const out = []; for (let i = 0; i <= n; i++) { const t = from + ((to - from) * i) / n; out.push([r * Math.cos(t), -r * Math.sin(t)]); } return out; };

  const K = new Kit();
  // ---------------------------------------------------------------- plinth, deck, channels, stair
  const notch = [[-W2, zs0], [xt, zs0], [xt, zs1], [-W2, zs1]];
  K.slab('base', [[W2, ZF], [W2, ZB], [-W2, ZB], ...notch, [-W2, ZF]], yb, lf, C.stone, C.laneFloor);
  K.slab('base', [[W2, ZF], [W2, ZB], [-W2, ZB], ...notch, [-W2, ZF], [-Ro, ZF], ...arc(Ro, Math.PI, 0), [Ro, ZF]], lf, DECK, C.conc, C.pave, 0.04);
  K.slab('base', [[Ri, ZF], ...arc(Ri, 0, Math.PI), [-Ri, ZF]], lf, DECK, C.conc, C.pave, 0.04);
  // stone cladding courses round the plinth's foot (a slightly darker band, then the shadow joint under the deck)
  for (const sx of [-1, 1]) K.box('base', sx * W2 - 0.03, sx * W2 + 0.03, lf - 0.08, lf - 0.02, sx < 0 ? zs1 : ZB, ZF, C.dark);
  K.box('base', -W2, W2, lf - 0.08, lf - 0.02, ZB - 0.03, ZB + 0.03, C.dark);
  // the stair up through the plinth (a landing inside the door, then the flight to the deck)
  const rise = DECK - gd, nSteps = Math.max(3, Math.round(rise / 0.175)), dxs = run / nSteps;
  K.box('base', -W2, xs0, yb, gd, zs0 + 0.01, zs1 - 0.01, C.conc, { top: C.pave });
  for (let i = 0; i < nSteps; i++) K.box('base', xs0 + i * dxs, xs0 + (i + 1) * dxs, yb, gd + (rise * (i + 1)) / nSteps, zs0 + 0.01, zs1 - 0.01, C.conc, { top: C.pave });
  for (const z of [zs0 + 0.09, zs1 - 0.09]) K.bar('metal', [xs0, gd + 0.95, z], [xt, DECK + 0.95, z], 0.05, C.steel, true);
  // the door: lintel, frame, the glass leaves slid open, a canopy with a light under it
  const doorH = Math.min(2.6, DECK - gd - 0.3);
  K.box('base', -W2, -W2 + 0.4, gd + doorH, DECK, zs0, zs1, C.conc);
  for (const z of [zs0 + 0.05, zs1 - 0.05]) K.box('metal', -W2 - 0.02, -W2 + 0.14, gd, gd + doorH, z - 0.05, z + 0.05, C.anth);
  K.box('metal', -W2 - 0.02, -W2 + 0.14, gd + doorH - 0.1, gd + doorH, zs0, zs1, C.anth);
  K.vquad('glass', -W2 + 0.2, zs0 + 0.05, -W2 + 0.2, zs0 + 0.55, gd, gd + doorH - 0.1, C.white);
  K.vquad('glass', -W2 + 0.2, zs1 - 0.55, -W2 + 0.2, zs1 - 0.05, gd, gd + doorH - 0.1, C.white);
  const canY = Math.min(gd + doorH + 0.25, DECK - 0.35);
  K.box('metal', -W2 - 1.4, -W2, canY, canY + 0.14, zs0 - 0.5, zs1 + 0.5, C.white, { r: 0.03 });
  K.box('base', -W2 - 1.36, -W2, canY + 0.14, canY + 0.24, zs0 - 0.46, zs1 + 0.46, C.snow, { r: 0.04 });
  K.box('light', -W2 - 1.1, -W2 - 0.9, canY - 0.02, canY, zs0, zs1, C.white);
  // the ticket window (valley: in the plinth beside the entrance, lit, its sign above)
  const tickets = !top && gd + 3.25 < DECK - 1.05;
  if (tickets) {
    const t0 = ZB + 3.6, t1 = ZB + 8.6;
    K.box('metal', -W2 - 0.02, -W2 + 0.02, gd + 0.85, gd + 2.45, t0 - 0.08, t1 + 0.08, C.anth);
    K.vquad('glass', -W2 - 0.06, t0, -W2 - 0.06, t1, gd + 0.9, gd + 2.4, C.white);
    K.box('metal', -W2 - 0.35, -W2, gd + 0.95, gd + 1.0, t0, t1, C.steel); // the counter
    K.box('light', -W2 - 0.09, -W2 - 0.04, gd + 2.33, gd + 2.38, t0 + 0.1, t1 - 0.1, C.white);
    for (let k = 0; k <= 4; k++) K.box('metal', -W2 - 0.09, -W2 - 0.03, gd + 0.9, gd + 2.4, t0 + ((t1 - t0) * k) / 4 - 0.03, t0 + ((t1 - t0) * k) / 4 + 0.03, C.anth);
  }
  // the machine room's louvres in the plinth on the far side
  for (const [z0, z1] of [[ZB + 3, ZB + 6], [-2.5, 0.5]]) {
    K.box('metal', W2 - 0.02, W2 + 0.02, 0.5, 2.3, z0, z1, C.dark);
    for (let k = 0; k < 7; k++) K.box('metal', W2, W2 + 0.07, 0.62 + k * 0.25, 0.68 + k * 0.25, z0 + 0.05, z1 - 0.05, C.anth);
  }

  // ---------------------------------------------------------------- the platform
  // yellow edge lines along the channels (0.3 m in from the edge)
  for (const sx of [-1, 1]) {
    K.box('base', sx * (Ro + 0.3), sx * (Ro + 0.45), DECK, DECK + 0.012, 0, ZF - 0.25, C.yellow);
    K.box('base', sx * (Ri - 0.45), sx * (Ri - 0.3), DECK, DECK + 0.012, 0, ZF - 0.25, C.yellow);
  }
  K.ring('base', Ro + 0.3, Ro + 0.45, DECK + 0.012, C.yellow);
  K.ring('base', Ri - 0.45, Ri - 0.3, DECK + 0.012, C.yellow);
  // the outer edge: a glass balustrade round the back and along the lanes, the boarding gates in between
  const rb = Ro + 0.1, yb0 = DECK + 0.08, yb1 = DECK + 1.0;
  for (let k = 0; k < 8; k++) {
    const t0 = (Math.PI * k) / 8, t1 = (Math.PI * (k + 1)) / 8;
    K.vquad('glass', rb * Math.cos(t0), -rb * Math.sin(t0), rb * Math.cos(t1), -rb * Math.sin(t1), yb0, yb1, C.white);
    K.bar('metal', [rb * Math.cos(t0), DECK, -rb * Math.sin(t0)], [rb * Math.cos(t0), yb1 + 0.04, -rb * Math.sin(t0)], 0.05, C.steel, true);
  }
  K.arcTube('metal', rb, 0.03, yb1 + 0.04, C.steel);
  for (const sx of [-1, 1]) {
    const x = sx * rb;
    K.bar('metal', [x, DECK, 0], [x, yb1 + 0.04, 0], 0.05, C.steel, true);
    K.vquad('glass', x, 3.7, x, ZF - 0.25, yb0, yb1, C.white);
    for (let z = 3.7; z <= ZF - 0.2; z += Math.max(1, (ZF - 3.95) / 2)) K.bar('metal', [x, DECK, z], [x, yb1 + 0.04, z], 0.05, C.steel, true);
    K.bar('metal', [x, yb1 + 0.04, 3.7], [x, yb1 + 0.04, ZF - 0.25], 0.06, C.steel, true);
    // boarding gates: two yellow posts, two glass flaps with yellow top rails
    for (const z of [0.2, 3.6]) K.box('metal', x - 0.09, x + 0.09, DECK, DECK + 1.15, z - 0.09, z + 0.09, C.yellow, { r: 0.03 });
    K.box('light', x - 0.095, x + 0.095, DECK + 1.15, DECK + 1.17, 0.13, 0.27, C.white);
    for (const [z0, z1] of [[0.3, 1.88], [1.92, 3.5]]) {
      K.vquad('glass', x, z0, x, z1, DECK + 0.25, DECK + 0.95, C.white);
      K.box('metal', x - 0.03, x + 0.03, DECK + 0.93, DECK + 0.99, z0, z1, C.yellow);
    }
  }
  // the operator's console on the island
  K.box('metal', -0.45, 0.45, DECK, DECK + 1.05, 0.6, 1.3, C.anth, { r: 0.04 });
  K.box('light', -0.35, 0.35, DECK + 1.05, DECK + 1.07, 0.7, 1.2, C.white);
  K.box('metal', -0.08, 0.08, DECK, DECK + 1.3, 2.4, 2.56, C.yellow, { r: 0.03 }); // the emergency stop's post
  // the operator's glass cabin (behind the loop, on the entrance side)
  const bx0 = -W2 + 0.4, bx1 = -W2 + 3.4, bz0 = ZB + 3.1, bz1 = ZB + 6.0, bh = DECK + 2.7;
  K.box('metal', bx0, bx1, DECK, DECK + 0.95, bz0, bz1, C.anth, { r: 0.04 });
  for (const [x0, z0, x1, z1] of [[bx0, bz0, bx1, bz0], [bx1, bz0, bx1, bz1], [bx1, bz1, bx0, bz1], [bx0, bz1, bx0, bz0]]) K.vquad('glass', x0, z0, x1, z1, DECK + 0.95, bh, C.white);
  for (const [x, z] of [[bx0, bz0], [bx1, bz0], [bx1, bz1], [bx0, bz1]]) K.box('metal', x - 0.06, x + 0.06, DECK + 0.9, bh, z - 0.06, z + 0.06, C.anth);
  K.box('metal', bx0 - 0.2, bx1 + 0.2, bh, bh + 0.2, bz0 - 0.2, bz1 + 0.2, C.white, { r: 0.04 });
  K.box('metal', bx0 - 0.21, bx1 + 0.21, bh + 0.02, bh + 0.1, bz0 - 0.21, bz1 + 0.21, C.blue);
  K.box('light', bx0 + 0.4, bx1 - 0.4, bh - 0.03, bh, (bz0 + bz1) / 2 - 0.05, (bz0 + bz1) / 2 + 0.05, C.white);
  K.box('metal', bx0 + 0.1, bx1 - 0.1, DECK + 0.95, DECK + 1.0, bz1 - 0.6, bz1 - 0.1, C.steel); // its desk at the window
  // the turnstiles (valley): a row across the deck behind the loop, the glass wings swung open
  const zt = -6.2, gates = []; // (~1 m behind the loop's balustrade)
  if (!top) for (let i = 0; i < 7; i++) {
    const x = -2.6 + i * 1.25;
    gates.push(x);
    K.box('metal', x - 0.11, x + 0.11, DECK, DECK + 1.0, zt - 0.45, zt + 0.45, C.anth, { r: 0.03 });
    K.box('light', x - 0.07, x + 0.07, DECK + 1.0, DECK + 1.015, zt - 0.3, zt + 0.1, C.white);
    K.vquad('glass', x + 0.14, zt - 0.35, x + 0.14, zt + 0.3, DECK + 0.45, DECK + 0.98, C.white);
  }
  // the stairwell's balustrade on the deck
  K.vquad('glass', -W2 + 0.2, zs1 + 0.06, xt, zs1 + 0.06, DECK + 0.08, DECK + 1.0, C.white);
  K.bar('metal', [-W2 + 0.2, DECK + 1.03, zs1 + 0.06], [xt, DECK + 1.03, zs1 + 0.06], 0.06, C.steel, true);
  K.bar('metal', [xt, DECK, zs1 + 0.06], [xt, DECK + 1.03, zs1 + 0.06], 0.05, C.steel, true);

  // ---------------------------------------------------------------- the hall: frames, glass, roof
  const nb = Math.max(4, Math.round((ZF - ZB - 0.4) / 4.2)), zc = [];
  for (let i = 0; i <= nb; i++) zc.push(ZB + 0.2 + ((ZF - ZB - 0.4) * i) / nb);
  const xc = W2 - 0.2, yW = roofBot(W2 - 0.08) - 0.02;
  for (const z of zc) {
    for (const sx of [-1, 1]) K.box('metal', sx * xc - 0.15, sx * xc + 0.15, DECK, roofBot(xc), z - 0.15, z + 0.15, C.steel, { r: 0.04 });
    // the arched rafter under the soffit
    const n = 10;
    for (let k = 0; k < n; k++) {
      const x0 = -xc + (2 * xc * k) / n, x1 = -xc + (2 * xc * (k + 1)) / n;
      K.bar('metal', [x0, roofBot(x0) - 0.13, z], [x1, roofBot(x1) - 0.13, z], 0.2, C.steel);
    }
  }
  // the long glazed walls: a pane per bay, the sill, the rail-high transom, a mid mullion
  for (const sx of [-1, 1]) {
    const x = sx * (W2 - 0.08);
    for (let i = 0; i < nb; i++) {
      const z0 = zc[i] + 0.15, z1 = zc[i + 1] - 0.15, zm = (z0 + z1) / 2;
      K.vquad('glass', x, z0, x, z1, DECK + 0.1, yW, C.white);
      K.box('metal', x - 0.04, x + 0.04, DECK + 0.02, yW, zm - 0.04, zm + 0.04, C.anth);
    }
    for (const y of [DECK + 0.1, DECK + 1.1, yW - 0.04]) K.box('metal', x - 0.05, x + 0.05, y - 0.04, y + 0.04, zc[0], zc[nb], C.anth);
  }
  // the back gable: glass up into the vault, mullions every ~2.4 m
  const zg0 = ZB + 0.12;
  K.shapeZ('glass', [[-W2, DECK + 0.1], [W2, DECK + 0.1], ...curve(W2, -W2, 0.02)], zg0, C.white);
  for (let k = 1; k < 6; k++) { const x = -W2 + (2 * W2 * k) / 6; K.box('metal', x - 0.04, x + 0.04, DECK, roofBot(x) - 0.02, zg0 - 0.04, zg0 + 0.04, C.anth); }
  for (const y of [DECK + 0.1, DECK + 1.1]) K.box('metal', -W2, W2, y - 0.04, y + 0.04, zg0 - 0.05, zg0 + 0.05, C.anth);
  // the front: the open portal over the channels between two steel posts, the header beam (house blue), glass above
  // it and full height either side over the outer platforms
  const zg1 = ZF - 0.12, xa = Ro + 0.15;
  for (const sx of [-1, 1]) {
    const pts = [[xa, DECK + 0.1], [W2, DECK + 0.1], ...curve(W2, xa, 0.02)];
    K.shapeZ('glass', sx > 0 ? pts : pts.map(([x, y]) => [-x, y]), zg1, C.white);
    K.box('metal', sx * (Ro + 0.12) - 0.15, sx * (Ro + 0.12) + 0.15, DECK, pt, zg1 - 0.15, zg1 + 0.15, C.steel, { r: 0.04 });
    K.box('metal', sx * (W2 * 0.5 + xa * 0.5) - 0.04, sx * (W2 * 0.5 + xa * 0.5) + 0.04, DECK, roofBot(W2 * 0.5 + xa * 0.5), zg1 - 0.04, zg1 + 0.04, C.anth);
    K.box('metal', sx * xa, sx * W2, DECK + 1.06, DECK + 1.14, zg1 - 0.05, zg1 + 0.05, C.anth);
  }
  if (roofBot(xa) - 0.1 > pt + 0.45) K.shapeZ('glass', [[-xa, pt + 0.4], [xa, pt + 0.4], ...curve(xa, -xa, 0.02)], zg1, C.white);
  K.box('metal', -W2, W2, pt, pt + 0.4, ZF - 0.35, ZF + 0.05, C.blue, { r: 0.04 });
  K.box('light', -Ro, Ro, pt - 0.02, pt, ZF - 0.2, ZF - 0.1, C.white);
  // the island's nose: a low steel rail across its front
  K.bar('metal', [-Ri + 0.15, DECK + 0.95, ZF - 0.15], [Ri - 0.15, DECK + 0.95, ZF - 0.15], 0.06, C.steel, true);
  for (const x of [-Ri + 0.15, Ri - 0.15]) K.bar('metal', [x, DECK, ZF - 0.15], [x, DECK + 0.98, ZF - 0.15], 0.05, C.steel, true);
  hallRoof(K, Wr, roofTop, roofBot, zr0, zr1);
  // LED strips under the soffit and downlights in the portal's canopy
  for (const x of [-xc + 0.8, -1.1, 1.1, xc - 0.8]) K.box('light', x - 0.05, x + 0.05, roofBot(x) - 0.05, roofBot(x) - 0.015, ZB + 0.4, ZF + 1.1, C.white);
  downlights(K, roofBot, ZF + 0.8);

  // ---------------------------------------------------------------- the cable loop: guide rail, tyre conveyor
  const yr = ropeY + 0.5, ycv = ropeY + 1.0;
  conveyors(K, s, ropeY, roofBot, 0, zFlat);
  K.arcTube('metal', s, 0.08, yr, C.steel);
  K.arcTube('metal', s, 0.22, ycv, C.anth, 4);
  for (const t of [Math.PI / 4, Math.PI / 2, (3 * Math.PI) / 4]) {
    const x = s * Math.cos(t), z = -s * Math.sin(t);
    K.bar('metal', [x, ycv + 0.18, z], [x, roofBot(x) - 0.2, z], 0.1, C.steel);
  }

  // the name boards' backing plates over the portal and on the back gable
  const sh = Math.min(1.0, roofBot(3.3) - pt - 0.55), rb3 = roofBot(3.3);
  if (sh > 0.4) {
    K.box('metal', -sh * 3 - 0.1, sh * 3 + 0.1, pt + 0.4, pt + 0.5 + sh, ZF - 0.12, ZF + 0.05, C.dark);
    K.box('metal', -sh * 3 - 0.1, sh * 3 + 0.1, rb3 - 0.4 - sh, rb3 - 0.3, ZB - 0.05, ZB + 0.12, C.dark);
  }

  // ---------------------------------------------------------------- meshes
  // the signs (built in the mirrored frame, so the letters read the right way round)
  const place = String(o.place || '').replace(/^the\s+/i, '');
  const sub = (top ? 'Summit station' : 'Valley station') + (place && !/^summit$/i.test(place) ? ' · ' + place : '');
  const q = { pos: [], nor: [], uv: [] }, X = (x) => x * mx;
  if (sh > 0.4) {
    signQuad(q, [0, pt + 0.45 + sh / 2, ZF + 0.07], [0, 0, 1], sh * 6, sh, UV.name);
    signQuad(q, [0, rb3 - 0.35 - sh / 2, ZB - 0.07], [0, 0, -1], sh * 6, sh, UV.name);
  }
  signQuad(q, [X(-W2 - 0.04), DECK - 0.55, ZB + 6.5], [-mx, 0, 0], 5.4, 0.9, UV.name);
  signQuad(q, [X(W2 + 0.04), DECK - 0.55, (ZB + ZF) / 2], [mx, 0, 0], 5.4, 0.9, UV.name);
  if (canY + 0.95 < DECK - 0.1) signQuad(q, [X(-W2 - 0.04), canY + 0.6, zd], [-mx, 0, 0], 1.8, 0.675, UV.entrance);
  if (tickets) signQuad(q, [X(-W2 - 0.04), gd + 2.85, ZB + 6.1], [-mx, 0, 0], 1.6, 0.6, UV.tickets);
  const group = assemble(K, mx, signMaterial(o.name || 'Gondola', sub), q, px, py, pz, yaw);

  // ---------------------------------------------------------------- colliders
  const cols = [];
  const yA = (y) => py + y;
  const boxC = (x0, x1, z0, z1, extra = {}) => {
    const q = toW(mx, (x0 + x1) / 2, (z0 + z1) / 2);
    cols.push({ x: q.x, z: q.z, hw: Math.abs(x1 - x0) / 2, hd: (z1 - z0) / 2, rot: -yaw, ...extra });
  };
  boxC(-W2, W2, zs1, ZF, { top: yA(DECK - 0.05) }); // the plinth (walked on from the deck)
  boxC(xt, W2, zs0, zs1, { top: yA(DECK - 0.05) }); // ... beside the stair's head
  boxC(-W2, W2, ZB, zs0 - 0.04);                    // the back wall (plinth + glass gable)
  boxC(W2 - WALL, W2, ZB, ZF);                       // the long glazed walls (the entrance side: from the stairwell on)
  boxC(-W2, -W2 + WALL, zs1, ZF);
  boxC(Ro + 0.1, W2, ZF - 0.3, ZF); boxC(-W2, -Ro - 0.1, ZF - 0.3, ZF); // the front glazing over the outer platforms
  const edgeTop = { top: yA(DECK + 1.1) };
  boxC(Ro, Ro + 0.2, -0.1, ZF, edgeTop); boxC(-Ro - 0.2, -Ro, -0.1, ZF, edgeTop); // the channels' edges
  for (let k = 0; k < 6; k++) {
    const t = (Math.PI * (k + 0.5)) / 6, r = Ro + 0.1, q = toW(mx, r * Math.cos(t), -r * Math.sin(t));
    cols.push({ x: q.x, z: q.z, hw: r * Math.sin(Math.PI / 12) + 0.08, hd: 0.1, rot: -(yaw + mx * (t - Math.PI / 2)), ...edgeTop });
  }
  boxC(-W2, xt, zs1 - 0.04, zs1 + 0.14, { top: yA(DECK + 1.0) }); // the stairwell's balustrade
  boxC(bx0, bx1, bz0, bz1);                                        // the operator's cabin
  for (const x of gates) boxC(x - 0.13, x + 0.13, zt - 0.45, zt + 0.45, { top: yA(DECK + 1.0) });

  // ---------------------------------------------------------------- walkable: the deck, the island, the stair
  const cs = [[-W2 - 1, ZB], [W2, ZB], [-W2 - 1, ZF], [W2, ZF]].map(([x, z]) => toW(mx, x, z));
  const surf = world.addSurface({
    bounds: { minx: Math.min(...cs.map((c) => c.x)) - 0.5, maxx: Math.max(...cs.map((c) => c.x)) + 0.5, minz: Math.min(...cs.map((c) => c.z)) - 0.5, maxz: Math.max(...cs.map((c) => c.z)) + 0.5 },
    height(x, z) {
      const dx = x - px, dz = z - pz, lx = (dx * cy - dz * sy) * mx, lz = dx * sy + dz * cy;
      if (lz < ZB || lz > ZF + 0.02 || lx < -W2 - 0.05 || lx > W2) return null;
      if (lz >= zs0 && lz <= zs1 && lx < xt) return lx < xs0 ? py + gd : py + gd + ((lx - xs0) / run) * (DECK - gd);
      const r = lz < 0 ? Math.hypot(lx, lz) : Math.abs(lx);
      if (r > Ri && r < Ro) return null; // (the channels: the balustrades keep you out)
      return py + DECK;
    },
  });

  // the bullwheel's drive shaft (bullwheelGeometry: 7.15 m over the rope at scale 1) up to the soffit
  const shaftScale = clamp((roofBot(0) - 0.05 - ropeY) / 7.15, 0.3, 1.2);
  return { group, colliders: cols, back: -ZB, shaftScale, surfaces: [surf] };
}

// ------------------------------------------------------------------ the mid-station
// (Nov 1 2026, the user: "the MID stations — fix those!": the Meshy hall on its podium, models/gondola_terminal.glb,
// is gone; then: "make it so you can go inside, and there's a nice interior AND a good outside" and "not too big".)
// A compact pass-through intermediate station in the same language as the end stations: a 20 m hall that the haul
// rope runs straight through at station height (the line is straight; lifts.js levels the rope to 7.5 m over the pad
// for +-13 m round the station), both ends open portals over the two cabin channels, the boarding deck at the cabins'
// floor along both outer platforms (boarding gates where the cabins crawl), the guide rails and tyre conveyors over
// both lanes, the operator's glass cabin on the island, glazed long walls and gables between slim steel frames, the
// vaulted roof just over both portals. The entrance side (mid.side: the nearby run) is a little wider than the far
// side, so its platform is a waiting area (benches, a queue rail, next-cabin screens, pendant lights).
// The plinth under the deck is a walk-in hall: a lobby behind a glazed stone front with sliding doors under a lit
// canopy, stone-tiled floor, timber-lined walls, a warm timber ceiling with light panels at 3.6 m (under the cabin
// channels' floor), the info / ticket desk, a lift-and-piste status board (the lift and the runs round the station),
// lift-pass gates, the lift core's door, benches, ski racks, lockers, vending machines, and the stair up along the
// glazed front into the stairwell opening in the deck (a glass balustrade round it) onto the waiting platform. The
// back-of-house (machine room) strip on the far side keeps its louvres.
// Frame: origin on the pad at the station's centre, +z up the line, the lanes at x = +-side, built with the entrance
// on -x and mirrored (mx = -1) for the other side (mx = +1 puts it on lifts.js +sideV). Six draw calls.
// Colliders: the plinth walls (a gap at the doors, closed to vehicles only), the lobby's furniture, the stair's side
// and the gates (tops under the deck: walked over up there); the deck level's own colliders (the channels' edges, the
// stairwell's balustrade, the wall over the doors, the operator's cabin, the platform's benches and rail) are returned
// as `deckColliders`: lifts.js parks them while the player is down in the lobby (colliders have no bottom, so they
// would wall it off). Walkable: the lobby floor, the stair (a ramp up to the deck) and the deck. Riders get off in
// front of the doors (lifts.js midExit: 10.6 m out, 1.8 m down the line).
const MID_WL = 7.2, MID_WR = 5.8, MID_HL = 10, PW = 0.35; // half widths (entrance side / far side), half length, wall
export const MID_DECK_UP = 2.5; // m over the pad: above it the deck level's colliders are in place (lifts.js)
const MC = { tileA: '#9b968e', tileB: '#7f7b74', ceil: '#cfa77a', lining: '#b9864f', oak: '#a8723f', plaster: '#ebe5da', red: '#b3262b' };
const DIFF_COL = ['#2fa84f', '#1f6fd6', '#d62b2b', '#15181c'];

// the mid-station's extra canvas (under the usual sign): the status board, the next-cabin screen, four small signs
const MID_EXTRA_H = 640;
const MPX = { board: [0, 384, 640, 1024], screen: [640, 384, 1024, 576], info: [640, 576, 1024, 688], cabins: [640, 688, 1024, 800], cafe: [640, 800, 1024, 912], lockers: [640, 912, 1024, 1024] };
function drawMidExtra(g, y0, { font, fit }, o) {
  const name = String(o.name || 'Gondola');
  // the status board (640 x 640): the lift, its stops and the runs round the station
  g.fillStyle = '#121a22'; g.fillRect(0, y0, 640, 640);
  g.fillStyle = C.blue; g.fillRect(0, y0, 640, 92);
  g.fillStyle = '#ffffff'; g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  fit(name.toUpperCase(), 700, 50, 590); g.fillText(name.toUpperCase(), 26, y0 + 64);
  g.fillStyle = '#a9bfd6'; g.font = font(600, 24); g.fillText('LIFT & PISTE STATUS', 26, y0 + 128);
  g.fillStyle = '#2b3946'; g.fillRect(26, y0 + 142, 588, 3);
  const rows = [{ name: name, lift: true }, ...(o.runs || []).slice(0, 6)];
  rows.forEach((r, i) => {
    const y = y0 + 196 + i * 62;
    if (r.lift) { g.fillStyle = C.blue; g.fillRect(26, y - 34, 40, 40); g.fillStyle = '#fff'; g.fillRect(36, y - 22, 20, 18); }
    else { g.fillStyle = DIFF_COL[Math.max(0, Math.min(3, r.diff | 0))]; g.beginPath(); g.arc(46, y - 14, 18, 0, Math.PI * 2); g.fill(); if ((r.diff | 0) === 3) { g.strokeStyle = '#d9dde2'; g.lineWidth = 3; g.stroke(); } }
    g.fillStyle = '#ffffff'; fit(r.name, 600, 32, 400); g.fillText(r.name, 84, y);
    g.fillStyle = '#39c463'; g.beginPath(); g.arc(560, y - 12, 9, 0, Math.PI * 2); g.fill();
    g.font = font(700, 22); g.textAlign = 'right'; g.fillText('OPEN', 540, y - 4); g.textAlign = 'left';
  });
  g.fillStyle = '#7f93a8'; fit(`${o.place || 'Mid-station'}  ·  ↑ ${o.up || 'Summit'}  ·  ↓ ${o.down || 'Valley'}`, 500, 22, 590);
  g.fillText(`${o.place || 'Mid-station'}  ·  ↑ ${o.up || 'Summit'}  ·  ↓ ${o.down || 'Valley'}`, 26, y0 + 618);
  // the next-cabin screen (384 x 192)
  const [sx0, sy0] = MPX.screen;
  g.fillStyle = '#0b1016'; g.fillRect(sx0, sy0, 384, 192);
  g.fillStyle = C.yellow; g.font = font(700, 26); g.fillText('NEXT CABIN', sx0 + 20, sy0 + 40);
  g.fillStyle = '#ffffff';
  for (const [k, lbl, t] of [[0, `▲ ${o.up || 'Summit'}`, '0:40'], [1, `▼ ${o.down || 'Valley'}`, '1:10']]) {
    const y = sy0 + 96 + k * 60;
    fit(lbl, 600, 30, 250); g.fillText(lbl, sx0 + 20, y);
    g.font = font(700, 30); g.fillStyle = '#39c463'; g.fillText(t, sx0 + 290, y); g.fillStyle = '#ffffff';
  }
  // the small signs (384 x 112 each)
  for (const [key, txt, bg] of [['info', 'INFO · TICKETS', C.blue], ['cabins', 'CABINS  ▸', C.dark], ['cafe', 'CAFÉ · SNACKS', '#7a4a24'], ['lockers', 'LOCKERS', C.dark]]) {
    const [x0, yy0] = MPX[key];
    g.fillStyle = bg; g.fillRect(x0, yy0, 384, 112);
    g.fillStyle = '#ffffff'; g.textAlign = 'center';
    fit(txt, 700, 50, 340); g.fillText(txt, x0 + 192, yy0 + 74);
    g.textAlign = 'left';
  }
}

/**
 * o: { x, y, z: the station's centre on its pad, yaw (local +z up the line), mx (+1 / -1: the entrance's side), side
 *      (the rope's offset), ropeY (rope height over the pad), carH, name (the lift), place (the station's name),
 *      up / down (where the cabins go), runs ([{ name, diff }]: the runs round the station, for the status board),
 *      ropeAt(z) -> [up-lane, down-lane] rope height over the pad z m along the line (either way) }
 * Returns { group, colliders, deckColliders (a subset of colliders: the deck level's), surfaces }.
 */
export function buildGondolaMidStation(o) {
  const { x: px, y: py, z: pz, yaw, side: s, ropeY, carH, ropeAt } = o;
  const mx = o.mx < 0 ? -1 : 1, WL = MID_WL, WR = MID_WR, HL = MID_HL, Ro = s + LANE, Ri = s - LANE;
  const lite = (quality.fx ?? 1) <= 0; // (Performance / Super: the lobby's small props left out)
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const toW = (x, z) => { const X = x * mx; return { x: px + X * cy + z * sy, z: pz - X * sy + z * cy }; };
  const gAt = (x, z) => { const q = toW(x, z); return world.height(q.x, q.z) - py; };
  const clamp = THREE.MathUtils.clamp;

  // the rope through the hall and a little past both portals: the portals and the roof clear its highest point, the
  // channel floors its lowest cabin; the guide rails run as far as it stays level
  let rMax = ropeY, rMin = ropeY, zF = HL - 0.4, zB = -HL + 0.4;
  for (let z = 0; z <= HL + 2.6; z += 0.5) for (const sg of [1, -1]) {
    const [a, b] = ropeAt(sg * z);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    rMax = Math.max(rMax, a, b);
    if (z <= HL + 0.5) rMin = Math.min(rMin, a, b);
    if (Math.max(Math.abs(a - ropeY), Math.abs(b - ropeY)) > 0.25) {
      if (sg > 0) zF = Math.min(zF, z - 0.5); else zB = Math.max(zB, 0.5 - z);
    }
  }
  zF = Math.max(1.5, zF); zB = Math.min(-1.5, zB);
  // the channels' floor: just under the cabins (lifts.js keeps the rope level through the station, so this is
  // DECK - 0.45), the lobby's ceiling under it
  const lf = clamp(rMin - carH - 0.5, 2.9, DECK - 0.45);
  const CEIL = Math.min(3.6, lf - 0.25), YS = CEIL + 0.04; // the lobby's ceiling, the deck slabs' soffit

  // the ground: the plinth goes down past the lowest of it, the lobby's floor just over the highest inside
  let gMin = 0, gIn = 0;
  for (const gx of [-WL - 2.5, -WL, -WL / 2, 0, WR / 2, WR]) for (const gz of [-HL, -HL / 2, 0, HL / 2, HL]) {
    const g = gAt(gx, gz);
    gMin = Math.min(gMin, g);
    if (gx >= -WL && Math.abs(gz) < HL) gIn = Math.max(gIn, g);
  }
  const yb = gMin - 0.8, yf = clamp(gIn + 0.08, 0.08, 0.45);

  // the lobby's plan: inside the walls x0i..x1i, |z| < zi; the back-of-house wall at xB; the stair along the glazed
  // front (x0i..xsI), its foot at zS0 by the +z end, rising toward -z to the deck at zS1; the deck's stairwell
  // opening over it from zS1 to zO (where the stair is ~1.45 m up: headroom under the ceiling before it)
  const x0i = -WL + PW, zi = HL - PW, xB = 2.6, xsI = -Ro - 0.7;
  const rise = DECK - yf, nSt = Math.max(12, Math.round(rise / 0.178)), rr = rise / nSt, dzs = 0.28, run = nSt * dzs;
  const zS0 = zi - 1.05, zS1 = zS0 - run, zO = zS0 - Math.floor(1.45 / rr) * dzs;
  const stairY = (lz) => yf + clamp((zS0 - lz) / run, 0, 1) * rise;
  const zD0 = -3.0, zD1 = -0.6, doorH = 2.6;               // the doors (centred 1.8 m down the line: lifts.js midExit)
  const gx0 = -3.85, gx1 = -2.95, gatesZ = [zi - 2.1, zi - 1.1, zi - 0.1]; // the lift-pass gates (walked through toward -x)
  const lc = { x0: -5.35, x1: gx0, z0: zi - 3.35, z1: zi - 2.2 }; // the lift core (its door faces the gates' side)

  // the roof: the same shallow vault over the (slightly asymmetric) hall, just over both portals
  const xc0 = (WR - WL) / 2, Wr = (WL + WR) / 2 + 0.45, R = 1.0, E = roofEaves(rMax);
  const roofTop = (x) => E + R * (1 - ((x - xc0) / Wr) ** 2), roofBot = (x) => roofTop(x) - ROOF_T;
  const zr1 = HL + 0.9, zr0 = -zr1;
  const pt = portalHeader(ropeY, rMax);
  const curve = (x0, x1, dy = 0, n = 14) => { const out = []; for (let i = 0; i <= n; i++) { const x = x0 + ((x1 - x0) * i) / n; out.push([x, roofBot(x) - dy]); } return out; };

  const K = new Kit();
  const bench = (x0, x1, z0, z1, y0, back = 0) => { // a timber bench on two steel frames (back: -1 / +1 the side of a backrest on x)
    K.box('base', x0, x1, y0 + 0.42, y0 + 0.47, z0, z1, MC.oak, { r: 0.015 });
    for (const z of [z0 + 0.25, z1 - 0.25]) K.box('metal', x0 + 0.04, x1 - 0.04, y0, y0 + 0.42, z - 0.03, z + 0.03, C.anth);
    if (back) { const xb = back < 0 ? x0 : x1 - 0.05; K.box('base', xb, xb + 0.05, y0 + 0.55, y0 + 0.88, z0, z1, MC.oak, { r: 0.015 }); }
  };
  const skiRack = (x0, x1, z0, z1, y0, skis) => { // two rails on posts, skis leaning in it
    for (const z of [z0, z1]) K.box('metal', x0, x0 + 0.06, y0, y0 + 1.25, z - 0.03, z + 0.03, C.anth);
    for (const y of [0.45, 1.2]) K.box('metal', x0, x0 + 0.06, y0 + y, y0 + y + 0.05, z0, z1, C.steel);
    if (skis && !lite) {
      const cols = [MC.red, C.blue, C.yellow, C.dark, C.white, C.steel];
      for (let i = 0, n = Math.floor((z1 - z0) / 0.24); i < n; i++) {
        const z = z0 + 0.15 + i * 0.24, c = cols[i % cols.length];
        K.bar('base', [x1, y0 + 0.02, z], [x0 + 0.08, y0 + 1.7, z], 0.07, c);
        K.bar('base', [x1, y0 + 0.02, z + 0.08], [x0 + 0.08, y0 + 1.7, z + 0.08], 0.07, c);
      }
    }
  };

  // ---------------------------------------------------------------- the plinth: foundation, walls, deck slabs
  K.box('base', -WL, WR, yb, 0, -HL, HL, C.stone);
  // walls up to the deck slabs' soffit, with openings ([a, b, sill, head] along the wall): stone outside, timber inside
  const wallZ = (x0, x1, zA, zBb, ops, col) => {
    let z = zA;
    for (const [a, b, y0, y1] of ops) {
      K.box('base', x0, x1, 0, YS, z, a, col);
      if (y0 > 0.01) K.box('base', x0, x1, 0, y0, a, b, col);
      K.box('base', x0, x1, y1, YS, a, b, col);
      z = b;
    }
    K.box('base', x0, x1, 0, YS, z, zBb, col);
  };
  const wallX = (z0, z1, xA, xBb, ops, col) => {
    let x = xA;
    for (const [a, b, y0, y1] of ops) {
      K.box('base', x, a, 0, YS, z0, z1, col);
      if (y0 > 0.01) K.box('base', a, b, 0, y0, z0, z1, col);
      K.box('base', a, b, y1, YS, z0, z1, col);
      x = b;
    }
    K.box('base', x, xBb, 0, YS, z0, z1, col);
  };
  // the glazed front (entrance side): stone piers, tall windows into the lobby, the doors
  const front = [[-9.4, -6.6, 0.3, 3.2], [-6.0, -3.6, 0.3, 3.2], [zD0, zD1, 0, 3.0], [0.0, 2.6, 0.3, 3.2], [3.2, 6.0, 0.3, 3.2], [6.6, 9.4, 0.3, 3.2]];
  wallZ(-WL, -WL + 0.2, -HL, HL, front, C.stone);
  wallZ(-WL + 0.2, x0i, -zi, zi, front, MC.lining);
  const xg = -WL + 0.17;
  for (const [a, b, y0, y1] of front) {
    if (a === zD0) continue;
    K.vquad('glass', xg, a, xg, b, y0, y1, C.white);
    for (const y of [y0, y1 - 0.06]) K.box('metal', xg - 0.05, xg + 0.05, y, y + 0.06, a, b, C.anth);
    for (const z of [a + 0.03, (a + b) / 2, b - 0.03]) K.box('metal', xg - 0.05, xg + 0.05, y0, y1, z - 0.03, z + 0.03, C.anth);
  }
  // the doors: frame, the glass leaves slid open, the transom, the door operator's box inside
  for (const z of [zD0 + 0.05, zD1 - 0.05]) K.box('metal', -WL - 0.02, -WL + 0.3, 0, 3.0, z - 0.05, z + 0.05, C.anth);
  K.box('metal', -WL - 0.02, -WL + 0.3, doorH, doorH + 0.1, zD0, zD1, C.anth);
  K.vquad('glass', xg, zD0, xg, zD1, doorH + 0.1, 3.0, C.white);
  K.vquad('glass', -WL + 0.26, zD0 + 0.1, -WL + 0.26, zD0 + 0.7, yf, doorH, C.white);
  K.vquad('glass', -WL + 0.26, zD1 - 0.7, -WL + 0.26, zD1 - 0.1, yf, doorH, C.white);
  K.box('metal', x0i, x0i + 0.22, doorH + 0.12, doorH + 0.34, zD0 - 0.1, zD1 + 0.1, C.steel);
  // the far side (back-of-house, the machine room): stone, its louvres
  K.box('base', WR - 0.2, WR, 0, YS, -HL, HL, C.stone);
  for (const [z0, z1] of [[-7, -4], [4, 7]]) {
    K.box('metal', WR - 0.02, WR + 0.02, 0.5, 2.3, z0, z1, C.dark);
    for (let k = 0; k < 7; k++) K.box('metal', WR, WR + 0.07, 0.62 + k * 0.25, 0.68 + k * 0.25, z0 + 0.05, z1 - 0.05, C.anth);
  }
  // both ends: stone under the portals, a window band into the lobby
  const endOps = [[-6.2, -3.9, 0.9, 3.0], [-2.8, 1.8, 0.9, 3.0]];
  for (const sz of [-1, 1]) {
    const zo0 = sz > 0 ? HL - 0.2 : -HL, zo1 = zo0 + 0.2, zl0 = sz > 0 ? zi : -HL + 0.2, zl1 = zl0 + 0.15;
    wallX(zo0, zo1, -WL, WR, endOps, C.stone);
    wallX(zl0, zl1, x0i, xB, endOps, MC.lining);
    const zw = sz * (HL - 0.1);
    for (const [a, b, y0, y1] of endOps) {
      K.vquad('glass', a, zw, b, zw, y0, y1, C.white);
      for (const y of [y0, y1 - 0.06]) K.box('metal', a, b, y, y + 0.06, zw - 0.05, zw + 0.05, C.anth);
      for (let k = 0, n = Math.max(1, Math.round((b - a) / 1.5)); k <= n; k++) { const x = a + ((b - a) * k) / n; K.box('metal', x - 0.03, x + 0.03, y0, y1, zw - 0.05, zw + 0.05, C.anth); }
    }
  }
  // the shadow joint under the deck slabs, round the outside
  for (const [x0, x1] of [[-WL - 0.03, -WL + 0.03], [WR - 0.03, WR + 0.03]]) K.box('base', x0, x1, YS - 0.06, YS, -HL, HL, C.dark);
  for (const sz of [-1, 1]) K.box('base', -WL, WR, YS - 0.06, YS, sz * HL - 0.03, sz * HL + 0.03, C.dark);
  // the deck slabs (the stairwell's opening left out of the entrance side's), the island, the channels' floors
  const slab = (x0, x1, z0, z1) => K.box('base', x0, x1, YS, DECK, z0, z1, C.conc, { r: 0.04, top: C.pave });
  slab(-WL, -Ro, -HL, zS1); slab(-WL, -Ro, zO, HL); slab(-WL, x0i, zS1, zO); slab(xsI, -Ro, zS1, zO);
  slab(-Ri, Ri, -HL, HL); slab(Ro, WR, -HL, HL);
  for (const sx of [-1, 1]) K.box('base', sx * Ri, sx * Ro, YS, lf, -HL, HL, C.conc, { top: C.laneFloor });

  // ---------------------------------------------------------------- the lobby
  // floor: stone tiles (a two-tone checker), the doormat
  K.box('base', x0i, xB, 0, yf, -zi, zi, MC.tileA);
  if (!lite) for (let ix = 0, x = x0i; x < xB - 0.05; ix++, x += 1.2) for (let iz = 0, z = -zi; z < zi - 0.05; iz++, z += 1.2) {
    if ((ix + iz) & 1) K.box('base', x, Math.min(x + 1.2, xB), yf, yf + 0.006, z, Math.min(z + 1.2, zi), MC.tileB);
  }
  K.box('base', x0i, x0i + 1.5, yf, yf + 0.014, zD0 + 0.1, zD1 - 0.1, C.dark);
  // the back-of-house wall (timber), its staff door
  K.box('base', xB, xB + 0.25, 0, CEIL, -zi, zi, MC.lining);
  K.box('metal', xB - 0.03, xB, yf, yf + 2.15, 6.0, 6.95, C.anth);
  // the timber ceiling (the stairwell open), its light panels
  K.box('base', x0i, xB, CEIL, YS, -zi, zS1, MC.ceil); K.box('base', x0i, xB, CEIL, YS, zO, zi, MC.ceil); K.box('base', xsI, xB, CEIL, YS, zS1, zO, MC.ceil);
  for (const x of [-4.1, -1.5, 1.1]) for (let z = -8.4; z <= 8.41; z += 2.4) K.box('light', x - 0.3, x + 0.3, CEIL - 0.02, CEIL, z - 0.6, z + 0.6, C.white);
  // the stair: solid stone steps with oak treads up along the glazed front, a glass balustrade on its open side,
  // handrails; its opening in the deck with the glass balustrade round it
  for (let k = 0; k < nSt; k++) K.box('base', x0i, xsI, 0, yf + rr * (k + 1), zS0 - (k + 1) * dzs, zS0 - k * dzs + 0.004, C.conc, { top: MC.oak });
  const xr = xsI + 0.03, zq = zS0 - 0.3;
  K.quad('glass', [xr, stairY(zq) + 0.12, zq], [xr, DECK + 0.12, zS1], [xr, DECK + 1.0, zS1], [xr, stairY(zq) + 1.0, zq], C.white);
  K.bar('metal', [xr, stairY(zq) + 1.03, zq], [xr, DECK + 1.03, zS1], 0.05, C.steel, true);
  for (let k = 0; k <= 4; k++) { const z = zq + ((zS1 - zq) * k) / 4, y = stairY(z); K.bar('metal', [xr, y, z], [xr, y + 1.05, z], 0.045, C.steel, true); }
  K.bar('metal', [x0i + 0.07, yf + 0.9, zS0], [x0i + 0.07, DECK + 0.9, zS1], 0.045, C.steel, true);
  const yb0 = DECK + 0.08, yb1 = DECK + 1.0, zo = zO + 0.04;
  K.vquad('glass', xr, zS1 + 0.05, xr, zo, yb0, yb1, C.white);
  K.vquad('glass', x0i, zo, xr, zo, yb0, yb1, C.white);
  K.bar('metal', [xr, yb1 + 0.04, zS1 + 0.05], [xr, yb1 + 0.04, zo], 0.06, C.steel, true);
  K.bar('metal', [x0i, yb1 + 0.04, zo], [xr, yb1 + 0.04, zo], 0.06, C.steel, true);
  for (const [x, z] of [[xr, zS1 + 0.05], [xr, (zS1 + zo) / 2], [xr, zo], [x0i + 0.05, zo]]) K.bar('metal', [x, DECK, z], [x, yb1 + 0.04, z], 0.05, C.steel, true);
  // the lift core (plaster, steel doors, the call button, the floor indicator)
  K.box('base', lc.x0, lc.x1, yf, CEIL, lc.z0, lc.z1, MC.plaster);
  K.box('metal', lc.x0 + 0.25, lc.x0 + 1.15, yf, yf + 2.15, lc.z1, lc.z1 + 0.03, C.steel);
  K.box('metal', lc.x0 + 0.18, lc.x0 + 1.22, yf, yf + 2.25, lc.z1 - 0.01, lc.z1 + 0.02, C.anth);
  K.box('light', lc.x0 + 1.28, lc.x0 + 1.36, yf + 1.0, yf + 1.15, lc.z1, lc.z1 + 0.03, C.white);
  K.box('light', lc.x0 + 0.5, lc.x0 + 0.9, yf + 2.32, yf + 2.4, lc.z1, lc.z1 + 0.03, C.white);
  // the lift-pass gates: three cabinets, the readers, the glass wings swung open
  for (const [i, z] of gatesZ.entries()) {
    K.box('metal', gx0, gx1, yf, yf + 1.0, z - 0.1, z + 0.1, C.anth, { r: 0.03 });
    K.box('light', gx0 + 0.1, gx0 + 0.5, yf + 1.0, yf + 1.015, z - 0.06, z + 0.06, C.white);
    K.box('metal', gx1 - 0.25, gx1 - 0.05, yf + 1.0, yf + 1.12, z - 0.08, z + 0.08, C.yellow, { r: 0.02 });
    if (i < gatesZ.length - 1) K.vquad('glass', (gx0 + gx1) / 2 - 0.2, z + 0.1, (gx0 + gx1) / 2 - 0.05, z + 0.38, yf + 0.4, yf + 0.95, C.white);
  }
  for (const z of [gatesZ[0] + 0.5, gatesZ[2] - 0.5]) K.bar('metal', [(gx0 + gx1) / 2, 3.0, z], [(gx0 + gx1) / 2, CEIL, z], 0.03, C.steel, true); // (the CABINS sign's hangers)
  // the info / ticket desk (oak, a white top, two screens), the lift's name on the wall behind it
  K.box('base', -4.6, -0.4, yf, yf + 1.05, -7.0, -6.4, MC.oak, { r: 0.02 });
  K.box('base', -4.7, -0.3, yf + 1.05, yf + 1.1, -7.05, -6.3, C.white, { r: 0.015 });
  K.box('light', -4.5, -0.5, yf + 0.9, yf + 0.94, -6.31, -6.29, C.white);
  for (const x of [-3.4, -1.6]) { K.box('metal', x - 0.28, x + 0.28, yf + 1.2, yf + 1.55, -6.88, -6.84, C.dark); K.box('metal', x - 0.03, x + 0.03, yf + 1.1, yf + 1.2, -6.88, -6.84, C.anth); }
  K.box('metal', -4.4, -0.6, 2.45, 3.25, -zi, -zi + 0.04, C.dark);
  for (const x of [-3.3, -1.7]) K.bar('metal', [x, 2.9, -6.7], [x, CEIL, -6.7], 0.03, C.steel, true); // (the INFO sign's hangers)
  // benches, ski racks, lockers, vending machines (and a bistro table)
  bench(-1.0, -0.5, -4.4, -1.6, yf); bench(-1.0, -0.5, 0.6, 3.4, yf);
  skiRack(x0i + 0.02, x0i + 0.6, -6.3, -3.7, yf, true);
  K.box('metal', xB - 0.5, xB, yf, yf + 2.0, 1.4, 5.4, C.steel);
  K.box('base', xB - 0.52, xB, yf + 2.0, yf + 2.05, 1.38, 5.42, MC.oak);
  if (!lite) {
    for (let z = 1.8; z < 5.39; z += 0.4) K.box('metal', xB - 0.51, xB - 0.49, yf + 0.04, yf + 1.96, z - 0.008, z + 0.008, C.anth);
    K.box('metal', xB - 0.51, xB - 0.49, yf + 0.99, yf + 1.01, 1.4, 5.4, C.anth);
  }
  for (const [z0, z1, col] of [[7.4, 8.4, MC.red], [8.5, 9.5, C.blue]]) {
    K.box('base', xB - 0.8, xB, yf, yf + 1.85, z0, z1, col, { r: 0.03 });
    K.box('light', xB - 0.82, xB - 0.8, yf + 0.85, yf + 1.7, z0 + 0.1, z1 - 0.32, C.white);
    K.box('metal', xB - 0.83, xB - 0.8, yf + 0.25, yf + 0.45, z0 + 0.1, z1 - 0.1, C.dark);
  }
  if (!lite) {
    const g = new THREE.CylinderGeometry(0.04, 0.04, 1.05, 8); g.translate(0.6, yf + 0.525, 8.0); K.add('metal', g, C.anth);
    const t = new THREE.CylinderGeometry(0.36, 0.36, 0.04, 20); t.translate(0.6, yf + 1.07, 8.0); K.add('base', t, MC.oak);
    const f = new THREE.CylinderGeometry(0.25, 0.25, 0.03, 16); f.translate(0.6, yf + 0.015, 8.0); K.add('metal', f, C.anth);
  }
  // the status board's frame on the back-of-house wall, facing the doors
  K.box('metal', xB - 0.06, xB, 1.0, 3.2, -2.9, -0.7, C.dark);

  // ---------------------------------------------------------------- outside the doors
  // the canopy (white steel, snow on it, lit underneath, two tie rods), ski racks either side, a bench, two bollards
  const cz0 = zD0 - 0.6, cz1 = zD1 + 0.6, cx = -WL - 1.6;
  K.box('metal', cx, -WL, 2.85, 3.3, cz0, cz1, C.white, { r: 0.03 });
  K.box('base', cx + 0.04, -WL, 3.3, 3.4, cz0 + 0.04, cz1 - 0.04, C.snow, { r: 0.04 });
  K.box('light', cx + 0.3, -WL - 0.2, 2.83, 2.85, cz0 + 0.3, cz1 - 0.3, C.white);
  for (const z of [cz0 + 0.12, cz1 - 0.12]) K.bar('metal', [cx + 0.15, 3.3, z], [-WL, 3.6, z], 0.04, C.steel, true);
  skiRack(-WL - 0.75, -WL - 0.2, -6.4, -4.2, Math.max(0, gAt(-WL - 0.5, -5.3)), true);
  skiRack(-WL - 0.75, -WL - 0.2, 0.8, 2.8, Math.max(0, gAt(-WL - 0.5, 1.8)), true);
  bench(-WL - 0.65, -WL - 0.2, 3.5, 5.6, Math.max(0, gAt(-WL - 0.4, 4.5)), 1);
  const bollards = [[-WL - 1.9, zD0 - 0.4], [-WL - 1.9, zD1 + 0.4]];
  for (const [x, z] of bollards) {
    const g0 = gAt(x, z);
    const g = new THREE.CylinderGeometry(0.1, 0.12, 0.9, 10); g.translate(x, g0 + 0.45, z); K.add('metal', g, C.anth);
    const l = new THREE.CylinderGeometry(0.09, 0.09, 0.12, 10); l.translate(x, g0 + 0.84, z); K.add('light', l, C.white);
  }

  // ---------------------------------------------------------------- the platforms
  const zl = HL - 0.25;
  for (const sx of [-1, 1]) {
    K.box('base', sx * (Ro + 0.3), sx * (Ro + 0.45), DECK, DECK + 0.012, -zl, zl, C.yellow);
    K.box('base', sx * (Ri - 0.45), sx * (Ri - 0.3), DECK, DECK + 0.012, -zl, zl, C.yellow);
  }
  // the outer platforms' edge: glass balustrades toward both ends, the boarding gates where the cabins crawl
  const rb = Ro + 0.1, zg = 3.6, ze = HL - 0.3;
  for (const sx of [-1, 1]) {
    const x = sx * rb;
    for (const [z0, z1] of [[-ze, -zg - 0.1], [zg + 0.1, ze]]) {
      K.vquad('glass', x, z0, x, z1, yb0, yb1, C.white);
      const n = Math.max(1, Math.round((z1 - z0) / 2));
      for (let k = 0; k <= n; k++) { const z = z0 + ((z1 - z0) * k) / n; K.bar('metal', [x, DECK, z], [x, yb1 + 0.04, z], 0.05, C.steel, true); }
      K.bar('metal', [x, yb1 + 0.04, z0], [x, yb1 + 0.04, z1], 0.06, C.steel, true);
    }
    for (const z of [-zg + 0.1, 0, zg - 0.1]) {
      K.box('metal', x - 0.09, x + 0.09, DECK, DECK + 1.15, z - 0.09, z + 0.09, C.yellow, { r: 0.03 });
      K.box('light', x - 0.095, x + 0.095, DECK + 1.15, DECK + 1.17, z - 0.07, z + 0.07, C.white);
    }
    for (const [z0, z1] of [[-zg + 0.2, -1.77], [-1.73, -0.1], [0.1, 1.73], [1.77, zg - 0.2]]) {
      K.vquad('glass', x, z0, x, z1, DECK + 0.25, DECK + 0.95, C.white);
      K.box('metal', x - 0.03, x + 0.03, DECK + 0.93, DECK + 0.99, z0, z1, C.yellow);
    }
  }
  // the island's noses: a low steel rail across each end
  for (const sz of [-1, 1]) {
    const z = sz * (HL - 0.15);
    K.bar('metal', [-Ri + 0.15, DECK + 0.95, z], [Ri - 0.15, DECK + 0.95, z], 0.06, C.steel, true);
    for (const x of [-Ri + 0.15, Ri - 0.15]) K.bar('metal', [x, DECK, z], [x, DECK + 0.98, z], 0.05, C.steel, true);
  }
  // the operator's glass cabin on the island, between the crawling cabins
  const bx = Ri - 0.85, bz = 1.7, bh = DECK + 2.6;
  K.box('metal', -bx, bx, DECK, DECK + 0.95, -bz, bz, C.anth, { r: 0.04 });
  for (const [x0, z0, x1, z1] of [[-bx, -bz, bx, -bz], [bx, -bz, bx, bz], [bx, bz, -bx, bz], [-bx, bz, -bx, -bz]]) K.vquad('glass', x0, z0, x1, z1, DECK + 0.95, bh, C.white);
  for (const [x, z] of [[-bx, -bz], [bx, -bz], [bx, bz], [-bx, bz]]) K.box('metal', x - 0.06, x + 0.06, DECK + 0.9, bh, z - 0.06, z + 0.06, C.anth);
  K.box('metal', -bx - 0.2, bx + 0.2, bh, bh + 0.2, -bz - 0.2, bz + 0.2, C.white, { r: 0.04 });
  K.box('metal', -bx - 0.21, bx + 0.21, bh + 0.02, bh + 0.1, -bz - 0.21, bz + 0.21, C.blue);
  K.box('light', -0.05, 0.05, bh - 0.03, bh, -bz + 0.4, bz - 0.4, C.white);
  for (const sx of [-1, 1]) K.box('metal', sx * (bx - 0.5) - 0.4, sx * (bx - 0.5) + 0.4, DECK + 0.95, DECK + 1.0, -bz + 0.2, bz - 0.2, C.steel); // the desks at the windows
  for (const sz of [-1, 1]) K.box('metal', -0.08, 0.08, DECK, DECK + 1.3, sz * (bz + 1.2) - 0.08, sz * (bz + 1.2) + 0.08, C.yellow, { r: 0.03 }); // emergency stops
  // the waiting platform (entrance side): a bench along the glass, the queue rail along the gates, two double-sided
  // next-cabin screens and pendant lights hung from the rafters
  bench(x0i, x0i + 0.48, -8.8, -5.4, DECK, -1);
  const xq = -6.2, zq0 = -3.2, zq1 = 0.6;
  for (let k = 0; k <= 3; k++) { const z = zq0 + ((zq1 - zq0) * k) / 3; K.bar('metal', [xq, DECK, z], [xq, DECK + 0.95, z], 0.06, C.steel, true); }
  K.box('metal', xq - 0.02, xq + 0.02, DECK + 0.82, DECK + 0.9, zq0, zq1, C.yellow);
  const xsc = -5.95, ysc = DECK + 2.75, screens = [-4.9, 4.4];
  for (const z of screens) {
    K.box('metal', xsc - 0.7, xsc + 0.7, ysc - 0.37, ysc + 0.37, z - 0.05, z + 0.05, C.dark, { r: 0.02 });
    for (const dx of [-0.5, 0.5]) K.bar('metal', [xsc + dx, ysc + 0.37, z], [xsc + dx, roofBot(xsc + dx) - 0.12, z], 0.03, C.steel, true);
  }
  for (const z of [-8.4, -6.4, -2.4, -0.4, 2.6, 7.6]) {
    K.bar('metal', [xsc, roofBot(xsc) - 0.12, z], [xsc, DECK + 3.36, z], 0.025, C.anth, true);
    if (!lite) { const g = new THREE.CylinderGeometry(0.1, 0.26, 0.24, 14, 1, true); g.translate(xsc, DECK + 3.24, z); K.add('metal', g, C.anth); }
    const l = new THREE.CylinderGeometry(0.2, 0.2, 0.02, 14); l.translate(xsc, DECK + 3.13, z); K.add('light', l, C.white);
  }

  // ---------------------------------------------------------------- the hall: frames, glass, roof
  const nb = Math.max(4, Math.round((2 * HL - 0.4) / 4.2)), zc = [];
  for (let i = 0; i <= nb; i++) zc.push(-HL + 0.2 + ((2 * HL - 0.4) * i) / nb);
  const xcL = -WL + 0.2, xcR = WR - 0.2;
  for (const z of zc) {
    for (const x of [xcL, xcR]) K.box('metal', x - 0.15, x + 0.15, DECK, roofBot(x), z - 0.15, z + 0.15, C.steel, { r: 0.04 });
    const n = 10;
    for (let k = 0; k < n; k++) {
      const x0 = xcL + ((xcR - xcL) * k) / n, x1 = xcL + ((xcR - xcL) * (k + 1)) / n;
      K.bar('metal', [x0, roofBot(x0) - 0.13, z], [x1, roofBot(x1) - 0.13, z], 0.2, C.steel);
    }
  }
  // the long glazed walls: a pane per bay, the sill, the rail-high transom, a mid mullion
  for (const x of [-WL + 0.08, WR - 0.08]) {
    const yW = roofBot(x) - 0.02;
    for (let i = 0; i < nb; i++) {
      const z0 = zc[i] + 0.15, z1 = zc[i + 1] - 0.15, zm = (z0 + z1) / 2;
      K.vquad('glass', x, z0, x, z1, DECK + 0.1, yW, C.white);
      K.box('metal', x - 0.04, x + 0.04, DECK + 0.02, yW, zm - 0.04, zm + 0.04, C.anth);
    }
    for (const y of [DECK + 0.1, DECK + 1.1, yW - 0.04]) K.box('metal', x - 0.05, x + 0.05, y - 0.04, y + 0.04, zc[0], zc[nb], C.anth);
  }
  // both ends: the open portal over the channels between two steel posts, the header beam (house blue), glass above
  // it and full height either side over the outer platforms
  const xa = Ro + 0.15;
  for (const sz of [-1, 1]) {
    const zg1 = sz * (HL - 0.12);
    for (const sx of [-1, 1]) {
      const Ws = sx < 0 ? WL : WR, xmu = sx * (Ws + xa) / 2;
      K.shapeZ('glass', [[sx * xa, DECK + 0.1], [sx * Ws, DECK + 0.1], ...curve(sx * Ws, sx * xa, 0.02)], zg1, C.white);
      K.box('metal', sx * (Ro + 0.12) - 0.15, sx * (Ro + 0.12) + 0.15, DECK, pt, zg1 - 0.15, zg1 + 0.15, C.steel, { r: 0.04 });
      K.box('metal', xmu - 0.04, xmu + 0.04, DECK, roofBot(xmu), zg1 - 0.04, zg1 + 0.04, C.anth);
      K.box('metal', sx * xa, sx * Ws, DECK + 1.06, DECK + 1.14, zg1 - 0.05, zg1 + 0.05, C.anth);
    }
    if (Math.min(roofBot(-xa), roofBot(xa)) - 0.1 > pt + 0.45) K.shapeZ('glass', [[-xa, pt + 0.4], [xa, pt + 0.4], ...curve(xa, -xa, 0.02)], zg1, C.white);
    const zA = sz * (HL - 0.35), zBm = sz * (HL + 0.05);
    K.box('metal', -WL, WR, pt, pt + 0.4, Math.min(zA, zBm), Math.max(zA, zBm), C.blue, { r: 0.04 });
    K.box('light', -Ro, Ro, pt - 0.02, pt, sz * (HL - 0.15) - 0.05, sz * (HL - 0.15) + 0.05, C.white);
  }
  // the roof (built round its own centre line, the hall's middle)
  const KR = new Kit();
  hallRoof(KR, Wr, (x) => roofTop(x + xc0), (x) => roofBot(x + xc0), zr0, zr1);
  for (const k of Object.keys(KR.parts)) for (const g of KR.parts[k]) K.parts[k].push(g.translate(xc0, 0, 0));
  for (const x of [xcL + 0.8, xc0 - 1.1, xc0 + 1.1, xcR - 0.8]) K.box('light', x - 0.05, x + 0.05, roofBot(x) - 0.05, roofBot(x) - 0.015, zr0 + 0.3, zr1 - 0.3, C.white);
  for (const sz of [-1, 1]) downlights(K, roofBot, sz * (HL + 0.6));

  // ---------------------------------------------------------------- the rope's lanes: guide rails, tyre conveyors
  conveyors(K, s, ropeY, roofBot, zB, zF);

  // the name boards' backing plates over both portals (centred on the hall)
  const sh = Math.min(1.0, Math.min(roofBot(xc0 - 3.2), roofBot(xc0 + 3.2)) - pt - 0.55);
  if (sh > 0.4) for (const sz of [-1, 1]) {
    const z0 = sz * (HL - 0.12), z1 = sz * (HL + 0.05);
    K.box('metal', xc0 - sh * 3 - 0.1, xc0 + sh * 3 + 0.1, pt + 0.4, pt + 0.5 + sh, Math.min(z0, z1), Math.max(z0, z1), C.dark);
  }

  // ---------------------------------------------------------------- meshes: the signs, boards and screens
  const q = { pos: [], nor: [], uv: [] }, X = (x) => x * mx;
  const TOT = SIGN_H + MID_EXTRA_H, ks = SIGN_H / TOT;
  const uvS = ([u0, v0, u1, v1]) => [u0, 1 - (1 - v0) * ks, u1, 1 - (1 - v1) * ks];
  const uvP = ([x0, y0, x1, y1]) => [x0 / SIGN_W, 1 - y1 / TOT, x1 / SIGN_W, 1 - y0 / TOT];
  if (sh > 0.4) for (const sz of [-1, 1]) signQuad(q, [X(xc0), pt + 0.45 + sh / 2, sz * (HL + 0.07)], [0, 0, sz], sh * 6, sh, uvS(UV.name));
  signQuad(q, [X(-WL - 0.04), 3.97, (zD0 + zD1) / 2], [-mx, 0, 0], 3.6, 0.6, uvS(UV.name));       // over the doors
  signQuad(q, [X(WR + 0.04), 3.95, 0], [mx, 0, 0], 4.2, 0.7, uvS(UV.name));                       // the far side
  signQuad(q, [X(cx - 0.02), 3.075, (zD0 + zD1) / 2], [-mx, 0, 0], 1.2, 0.45, uvS(UV.entrance)); // the canopy's front
  signQuad(q, [X(xB - 0.07), 2.1, -1.8], [-mx, 0, 0], 2.0, 2.0, uvP(MPX.board));                  // the status board
  signQuad(q, [X(-2.5), 2.85, -zi + 0.05], [0, 0, 1], 3.6, 0.6, uvS(UV.name));                    // behind the desk
  signQuad(q, [X(-2.5), 2.75, -6.7], [0, 0, 1], 1.6, 0.47, uvP(MPX.info));
  signQuad(q, [X((gx0 + gx1) / 2 + 0.02), 2.8, gatesZ[1]], [mx, 0, 0], 1.4, 0.41, uvP(MPX.cabins));
  signQuad(q, [X(xB - 0.01), 2.5, 8.45], [-mx, 0, 0], 1.4, 0.41, uvP(MPX.cafe));
  signQuad(q, [X(xB - 0.01), 2.5, 3.4], [-mx, 0, 0], 1.2, 0.35, uvP(MPX.lockers));
  for (const z of screens) for (const sz of [-1, 1]) signQuad(q, [X(xsc), ysc, z + sz * 0.055], [0, 0, sz], 1.3, 0.65, uvP(MPX.screen));
  const place = String(o.place || 'Mid-station');
  const sub = /mid-?station/i.test(place) ? place : `Mid-station · ${place}`;
  const sm = signMaterial(o.name || 'Gondola', sub, { h: MID_EXTRA_H, draw: (g, y0, f) => drawMidExtra(g, y0, f, { ...o, place }) });
  const group = assemble(K, mx, sm, q, px, py, pz, yaw);

  // ---------------------------------------------------------------- colliders
  const cols = [], deck = [];
  const yA = (y) => py + y;
  const boxC = (x0, x1, z0, z1, extra = {}) => {
    if (x1 < x0) [x0, x1] = [x1, x0];
    const c = toW((x0 + x1) / 2, (z0 + z1) / 2);
    const col = { x: c.x, z: c.z, hw: (x1 - x0) / 2, hd: (z1 - z0) / 2, rot: -yaw, ...extra };
    cols.push(col);
    return col;
  };
  const deckC = (...a) => deck.push(boxC(...a));
  // the plinth's walls (the hall's long glass walls and end glazing stand on them), the doors' gap: vehicles only
  boxC(-WL, x0i, -HL, zD0); boxC(-WL, x0i, zD1, HL);
  boxC(-WL - 0.2, x0i, zD0, zD1, { carOnly: true });
  boxC(WR - PW, WR, -HL, HL);
  for (const sz of [-1, 1]) boxC(-WL, WR, sz > 0 ? zi : -HL, sz > 0 ? HL : -zi);
  boxC(xB, xB + 0.25, -zi, zi);                                    // the back-of-house wall
  // the lobby: the stair's open side and the end under its head (tops under the deck), the lift core, the gates,
  // the desk, benches, racks, lockers, vending machines, the bistro table
  const under = { top: yA(3.0) };
  boxC(xsI - 0.1, xsI + 0.05, zS1 - 0.15, zS0, under);
  boxC(x0i, xsI + 0.05, zS1 - 0.15, zS1, under);
  boxC(lc.x0, lc.x1, lc.z0, lc.z1, under);
  for (const z of gatesZ) boxC(gx0, gx1, z - 0.1, z + 0.1, { top: yA(yf + 1.0) });
  boxC(-4.7, -0.3, -7.05, -6.3, { top: yA(yf + 1.1) });
  for (const [z0, z1] of [[-4.4, -1.6], [0.6, 3.4]]) boxC(-1.0, -0.5, z0, z1, { top: yA(yf + 0.47) });
  boxC(x0i, x0i + 0.6, -6.3, -3.7, { top: yA(yf + 1.25) });
  boxC(xB - 0.5, xB, 1.4, 5.4, { top: yA(yf + 2.05) });
  boxC(xB - 0.8, xB, 7.4, 9.5, { top: yA(yf + 1.85) });
  if (!lite) { const t = toW(0.6, 8.0); cols.push({ x: t.x, z: t.z, r: 0.36, top: yA(yf + 1.09) }); }
  // outside: the racks, the bench, the bollards
  for (const [z0, z1] of [[-6.4, -4.2], [0.8, 2.8]]) boxC(-WL - 0.75, -WL - 0.15, z0, z1, { top: yA(Math.max(0, gAt(-WL - 0.5, (z0 + z1) / 2)) + 1.25) });
  boxC(-WL - 0.65, -WL - 0.15, 3.5, 5.6, { top: yA(Math.max(0, gAt(-WL - 0.4, 4.5)) + 0.47) });
  for (const [x, z] of bollards) { const b = toW(x, z); cols.push({ x: b.x, z: b.z, r: 0.14, top: yA(gAt(x, z) + 0.9) }); }
  // the deck level (lifts.js parks these while the player is in the lobby): the wall over the doors, the channels'
  // edges, the stairwell's balustrade, the operator's cabin, the waiting platform's bench and queue rail
  deckC(-WL, x0i, zD0, zD1);
  const edgeTop = { top: yA(DECK + 1.1) };
  deckC(Ro, Ro + 0.2, -HL, HL, edgeTop); deckC(-Ro - 0.2, -Ro, -HL, HL, edgeTop);
  deckC(xsI - 0.1, xsI + 0.05, zS1, zO + 0.1, { top: yA(DECK + 1.0) });
  deckC(x0i, xsI + 0.05, zO, zO + 0.12, { top: yA(DECK + 1.0) });
  deckC(-bx, bx, -bz, bz);
  deckC(x0i, x0i + 0.48, -8.8, -5.4, { top: yA(DECK + 0.47) });
  deckC(xq - 0.05, xq + 0.05, zq0, zq1, { top: yA(DECK + 0.95) });

  // ---------------------------------------------------------------- walkable: the lobby floor, the stair, the deck
  const local = (x, z) => { const dx = x - px, dz = z - pz; return [(dx * cy - dz * sy) * mx, dx * sy + dz * cy]; };
  const cs = [[-WL - 2.5, -HL - 1], [WR + 1, -HL - 1], [-WL - 2.5, HL + 1], [WR + 1, HL + 1]].map(([x, z]) => toW(x, z));
  const bounds = { minx: Math.min(...cs.map((c) => c.x)), maxx: Math.max(...cs.map((c) => c.x)), minz: Math.min(...cs.map((c) => c.z)), maxz: Math.max(...cs.map((c) => c.z)) };
  const surfaces = [
    world.addSurface({ bounds, height(x, z) { // the lobby's floor (and the doors' threshold)
      const [lx, lz] = local(x, z);
      return lx >= -WL - 0.05 && lx <= WR && Math.abs(lz) <= HL ? py + yf : null;
    } }),
    world.addSurface({ bounds, height(x, z) { // the stair: a ramp from the lobby's floor up to the deck
      const [lx, lz] = local(x, z);
      return lx >= x0i - 0.05 && lx <= xsI + 0.02 && lz >= zS1 && lz <= zS0 + 0.02 ? py + stairY(lz) : null;
    } }),
    world.addSurface({ bounds, height(x, z) { // the deck: the platforms and the island, not the channels nor the stairwell
      const [lx, lz] = local(x, z);
      if (lz < -HL || lz > HL || lx < -WL || lx > WR) return null;
      const r = Math.abs(lx);
      if (r > Ri && r < Ro) return null; // (the channels: the balustrades keep you out)
      if (lx > x0i - 0.02 && lx < xsI + 0.02 && lz > zS1 && lz < zO) return null; // (the stairwell)
      return py + DECK;
    } }),
  ];
  return { group, colliders: cols, deckColliders: deck, surfaces, stair: { x: (x0i + xsI) / 2, z0: zS0, z1: zS1, yf } };
}
