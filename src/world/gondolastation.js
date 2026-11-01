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
// is gone; "not too big"; then the walk-in lobby in its plinth came out again: "the interior of the mid gondola
// station is super ugly": a solid station with a nice outside and an outside stair up to the platform.)
// A compact pass-through intermediate station in the same language as the end stations: a 20 m hall on a solid
// stone-clad plinth that the haul rope runs straight through at station height (the line is straight; lifts.js
// levels the rope to 7.5 m over the pad for +-13 m round the station), both ends open portals over the two cabin
// channels, sized from the real rope heights. The boarding deck at the cabins' floor along both outer platforms
// (boarding gates where the cabins crawl), the guide rails and tyre conveyors over both lanes, the operator's glass
// cabin on the island, glazed long walls and gables between slim steel frames, the flat vault of the roof just over
// both portals. The entrance side (mid.side: the nearby run) is a little wider than the far side, so its platform is
// a waiting area (a bench, a queue rail, next-cabin screens, pendant lights); a covered outside stair runs up the
// plinth on that side, rising up the line to a landing at a door through the long wall onto that platform; the
// lift's name over both portals and on the plinth, ENTRANCE at the stair, a ski rack by its foot.
// Frame: origin on the pad at the station's centre, +z up the line, the lanes at x = +-side, built with the stair on
// -x and mirrored (mx = -1) for the other side (mx = +1 puts it on lifts.js +sideV). Five draw calls.
// Colliders: the plinth (top at the deck: walked on up there, a wall from the snow), the long walls (a gap for the
// door), the end glazing over the outer platforms, the channels' edges (deck + 1.1 m), the stair's balustrade, the
// operator's cabin, the platform's bench and queue rail, the ski rack. Walkable: the stair (a ramp from the snow up
// to the landing) and the deck. Riders get off just in front of the stair's foot (lifts.js midExit / layout.js
// stopExit: 8.6 m out, 6.2 m down the line).
// (No z-fighting: no two parts share a face plane where both show; the deck's edge lines and the operator cabin's
// band stand >= 2.5 cm proud; the plinth is one solid block down past the lowest ground, so the pad's snow inside
// its footprint is buried, never level with a floor.)
const MID_WL = 7.2, MID_WR = 5.8, MID_HL = 10, STAIR_W = 1.6; // half widths (stair side / far side), half length

// the mid-station's extra canvas (under the usual sign): the next-cabin screen
const MID_EXTRA_H = 192;
const MPX = { screen: [0, 384, 384, 576] };
function drawMidExtra(g, y0, { font, fit }, o) {
  const [sx0] = MPX.screen;
  g.fillStyle = '#0b1016'; g.fillRect(sx0, y0, 384, 192);
  g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  g.fillStyle = C.yellow; g.font = font(700, 26); g.fillText('NEXT CABIN', sx0 + 20, y0 + 40);
  g.fillStyle = '#ffffff';
  for (const [k, lbl, t] of [[0, `▲ ${o.up || 'Summit'}`, '0:40'], [1, `▼ ${o.down || 'Valley'}`, '1:10']]) {
    const y = y0 + 96 + k * 60;
    fit(lbl, 600, 30, 250); g.fillText(lbl, sx0 + 20, y);
    g.font = font(700, 30); g.fillStyle = '#39c463'; g.fillText(t, sx0 + 290, y); g.fillStyle = '#ffffff';
  }
}

/**
 * o: { x, y, z: the station's centre on its pad, yaw (local +z up the line), mx (+1 / -1: the stair's side), side (the
 *      rope's offset), ropeY (rope height over the pad), carH, name (the lift), place (the station's name),
 *      up / down (where the cabins go: the next-cabin screens),
 *      ropeAt(z) -> [up-lane, down-lane] rope height over the pad z m along the line (either way) }
 * Returns { group, colliders, surfaces, stair: { x, z0, z1, y0 } (local: its centre line, foot, landing, foot height) }.
 */
export function buildGondolaMidStation(o) {
  const { x: px, y: py, z: pz, yaw, side: s, ropeY, carH, ropeAt } = o;
  const mx = o.mx < 0 ? -1 : 1, WL = MID_WL, WR = MID_WR, HL = MID_HL, Ro = s + LANE, Ri = s - LANE;
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
  const lf = clamp(rMin - carH - 0.5, 0.4, DECK - 1.1); // the channels' floor

  // the hall's bays (steel frames every ~4 m); the door onto the waiting platform in the last bay but one toward +z
  const nb = Math.max(4, Math.round((2 * HL - 0.4) / 4.2)), zc = [];
  for (let i = 0; i <= nb; i++) zc.push(-HL + 0.2 + ((2 * HL - 0.4) * i) / nb);
  const dc = (zc[nb - 2] + zc[nb - 1]) / 2, d0 = dc - 0.9, d1 = dc + 0.9, doorH = 2.5;

  // the stair: up the outside of the plinth on -x, toward +z, to the landing at the door
  const xo = -WL - STAIR_W, xi = -WL, xm = (xo + xi) / 2, LAND0 = d0 - 0.25, LAND1 = d1 + 0.2;
  const gd = clamp(gAt(xm, LAND0 - 7.4), -3, DECK - 1.2);
  const rise = DECK - gd, nSteps = Math.max(3, Math.round(rise / 0.175)), rr = rise / nSteps, dzs = 0.29, run = nSteps * dzs, zFoot = LAND0 - run;
  const stairY = (lz) => Math.min(DECK, gd + ((lz - zFoot) / run) * rise + rr / 2); // (through the nosings' middle)
  let gMin = Math.min(gd, 0);
  for (const gx of [-WL, 0, WR, xo]) for (const gz of [-HL, -HL / 2, 0, HL / 2, HL, zFoot]) gMin = Math.min(gMin, gAt(gx, gz));
  const yb = gMin - 0.8;

  // the roof: the same shallow vault over the (slightly asymmetric) hall, just over both portals
  const xc0 = (WR - WL) / 2, Wr = (WL + WR) / 2 + 0.45, R = 1.0, E = roofEaves(rMax);
  const roofTop = (x) => E + R * (1 - ((x - xc0) / Wr) ** 2), roofBot = (x) => roofTop(x) - ROOF_T;
  const zr1 = HL + 0.9, zr0 = -zr1;
  const pt = portalHeader(ropeY, rMax);
  const curve = (x0, x1, dy = 0, n = 14) => { const out = []; for (let i = 0; i <= n; i++) { const x = x0 + ((x1 - x0) * i) / n; out.push([x, roofBot(x) - dy]); } return out; };

  const K = new Kit();
  const bench = (x0, x1, z0, z1, y0, back = 0) => { // a timber bench on two steel frames (back: -1 / +1 the side of a backrest on x)
    K.box('base', x0, x1, y0 + 0.42, y0 + 0.47, z0, z1, C.wood, { r: 0.015 });
    for (const z of [z0 + 0.25, z1 - 0.25]) K.box('metal', x0 + 0.04, x1 - 0.04, y0, y0 + 0.42, z - 0.03, z + 0.03, C.anth);
    if (back) { const xb = back < 0 ? x0 : x1 - 0.05; K.box('base', xb, xb + 0.05, y0 + 0.55, y0 + 0.88, z0, z1, C.wood, { r: 0.015 }); }
  };

  // ---------------------------------------------------------------- plinth, deck, channels
  // one solid block from under the lowest ground up to the channels' floor, the deck's slabs on it
  K.box('base', -WL, WR, yb, lf, -HL, HL, C.stone, { top: C.laneFloor });
  for (const [x0, x1] of [[Ro, WR], [-WL, -Ro], [-Ri, Ri]]) K.box('base', x0, x1, lf, DECK, -HL, HL, C.conc, { r: 0.04, top: C.pave });
  // the shadow joint round the plinth's top (one colour: where the strips cross at the corners nothing shows)
  for (const x of [-WL, WR]) K.box('base', x - 0.03, x + 0.03, lf - 0.08, lf - 0.02, -HL - 0.03, HL + 0.03, C.dark);
  for (const sz of [-1, 1]) K.box('base', -WL - 0.03, WR + 0.03, lf - 0.08, lf - 0.02, sz * HL - 0.03, sz * HL + 0.03, C.dark);
  // the machine rooms' louvres in the plinth on the far side (the frame 2 cm proud of the stone, the slats on it)
  for (const [z0, z1] of [[-8.2, -5.2], [5.2, 8.2]]) {
    K.box('metal', WR - 0.02, WR + 0.02, 0.5, 2.3, z0, z1, C.dark);
    for (let k = 0; k < 7; k++) K.box('metal', WR, WR + 0.07, 0.62 + k * 0.25, 0.68 + k * 0.25, z0 + 0.05, z1 - 0.05, C.anth);
  }

  // ---------------------------------------------------------------- the outside stair
  // the landing's stone block, the flight (solid down into the ground), glass balustrade, handrails, the canopy
  K.box('base', xo, xi, yb, DECK, LAND0, LAND1, C.stone, { top: C.pave });
  for (let k = 0; k < nSteps; k++) K.box('base', xo, xi - 0.01, yb, gd + rr * (k + 1), zFoot + k * dzs, Math.min(LAND0, zFoot + (k + 1) * dzs + 0.005), C.conc, { top: C.pave });
  const xg = xo + 0.06, yh = 0.95;
  K.quad('glass', [xg, gd + 0.1, zFoot + 0.15], [xg, DECK + 0.1, LAND0], [xg, DECK + 1.0, LAND0], [xg, gd + 1.0, zFoot + 0.15], C.white);
  K.vquad('glass', xg, LAND0, xg, LAND1 - 0.06, DECK + 0.08, DECK + 1.0, C.white);
  K.vquad('glass', xg, LAND1 - 0.06, xi, LAND1 - 0.06, DECK + 0.08, DECK + 1.0, C.white);
  K.bar('metal', [xg, gd + yh + 0.08, zFoot + 0.15], [xg, DECK + yh + 0.08, LAND0], 0.06, C.steel, true);
  K.bar('metal', [xg, DECK + yh + 0.08, LAND0], [xg, DECK + yh + 0.08, LAND1 - 0.06], 0.06, C.steel, true);
  K.bar('metal', [xg, DECK + yh + 0.08, LAND1 - 0.06], [xi, DECK + yh + 0.08, LAND1 - 0.06], 0.06, C.steel, true);
  for (let k = 0; k <= 3; k++) { const t = k / 3, z = zFoot + 0.15 + (LAND0 - zFoot - 0.15) * t, y = gd + (DECK - gd) * t; K.bar('metal', [xg, y, z], [xg, y + yh + 0.08, z], 0.05, C.steel, true); }
  K.bar('metal', [xg, DECK, LAND1 - 0.06], [xg, DECK + yh + 0.08, LAND1 - 0.06], 0.05, C.steel, true);
  K.bar('metal', [xi - 0.09, gd + 0.9, zFoot], [xi - 0.09, DECK + 0.9, LAND0], 0.05, C.steel, true); // the wall's handrail
  const canY = DECK + 2.75;
  K.box('metal', xo - 0.25, xi, canY, canY + 0.14, LAND0 - 0.5, LAND1 + 0.3, C.white, { r: 0.03 });
  K.box('base', xo - 0.21, xi, canY + 0.14, canY + 0.24, LAND0 - 0.46, LAND1 + 0.26, C.snow, { r: 0.04 });
  K.box('light', xo + 0.5, xo + 0.7, canY - 0.02, canY, LAND0, LAND1 - 0.2, C.white);
  // the door through the long wall onto the waiting platform: frame, lintel, the glass leaves slid open
  for (const z of [d0, d1]) K.box('metal', -WL - 0.02, -WL + 0.14, DECK, DECK + doorH, z - 0.05, z + 0.05, C.anth);
  K.box('metal', -WL - 0.02, -WL + 0.14, DECK + doorH - 0.1, DECK + doorH, d0 + 0.05, d1 - 0.05, C.anth);
  K.vquad('glass', -WL + 0.2, d0 + 0.05, -WL + 0.2, d0 + 0.5, DECK, DECK + doorH - 0.1, C.white);
  K.vquad('glass', -WL + 0.2, d1 - 0.5, -WL + 0.2, d1 - 0.05, DECK, DECK + doorH - 0.1, C.white);
  // a ski rack against the plinth by the stair's foot: two rails on posts (sunk a little into the snow), skis in it
  const rz0 = -HL + 0.6, rz1 = Math.min(zFoot - 3.0, rz0 + 2.0), rg = gAt(-WL - 0.4, (rz0 + rz1) / 2) - 0.05;
  if (rz1 - rz0 > 0.8) {
    const x0 = -WL - 0.7, x1 = -WL - 0.15;
    for (const z of [rz0, rz1]) K.box('metal', x0, x0 + 0.06, rg, rg + 1.3, z - 0.03, z + 0.03, C.anth);
    for (const y of [0.5, 1.25]) K.box('metal', x0, x0 + 0.06, rg + y, rg + y + 0.05, rz0, rz1, C.steel);
    const cols = ['#b3262b', C.blue, C.yellow, C.dark, C.white, C.steel];
    for (let i = 0, n = Math.floor((rz1 - rz0 - 0.2) / 0.26); i < n; i++) {
      const z = rz0 + 0.18 + i * 0.26, c = cols[i % cols.length];
      for (const dz of [0, 0.08]) K.bar('base', [x1, rg + 0.07, z + dz], [x0 + 0.09, rg + 1.75, z + dz], 0.07, c);
    }
  }

  // ---------------------------------------------------------------- the platforms
  const zl = HL - 0.25;
  for (const sx of [-1, 1]) { // the yellow edge lines (2.5 cm proud of the paving: no flicker far off)
    K.box('base', sx * (Ro + 0.3), sx * (Ro + 0.45), DECK, DECK + 0.025, -zl, zl, C.yellow);
    K.box('base', sx * (Ri - 0.45), sx * (Ri - 0.3), DECK, DECK + 0.025, -zl, zl, C.yellow);
  }
  // the outer platforms' edge: glass balustrades toward both ends, the boarding gates where the cabins crawl
  const rb = Ro + 0.1, yb0 = DECK + 0.08, yb1 = DECK + 1.0, zg = 3.6, ze = HL - 0.3;
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
  // the operator's glass cabin on the island, between the crawling cabins (the blue band 3 cm proud of its roof)
  const bx = Ri - 0.85, bz = 1.7, bh = DECK + 2.6;
  K.box('metal', -bx, bx, DECK, DECK + 0.95, -bz, bz, C.anth, { r: 0.04 });
  for (const [x0, z0, x1, z1] of [[-bx, -bz, bx, -bz], [bx, -bz, bx, bz], [bx, bz, -bx, bz], [-bx, bz, -bx, -bz]]) K.vquad('glass', x0, z0, x1, z1, DECK + 0.95, bh, C.white);
  for (const [x, z] of [[-bx, -bz], [bx, -bz], [bx, bz], [-bx, bz]]) K.box('metal', x - 0.06, x + 0.06, DECK + 0.9, bh, z - 0.06, z + 0.06, C.anth);
  K.box('metal', -bx - 0.2, bx + 0.2, bh, bh + 0.2, -bz - 0.2, bz + 0.2, C.white, { r: 0.04 });
  K.box('metal', -bx - 0.23, bx + 0.23, bh + 0.03, bh + 0.11, -bz - 0.23, bz + 0.23, C.blue);
  K.box('light', -0.05, 0.05, bh - 0.03, bh, -bz + 0.4, bz - 0.4, C.white);
  for (const sx of [-1, 1]) K.box('metal', sx * (bx - 0.5) - 0.4, sx * (bx - 0.5) + 0.4, DECK + 0.95, DECK + 1.0, -bz + 0.2, bz - 0.2, C.steel); // the desks at the windows
  for (const sz of [-1, 1]) K.box('metal', -0.08, 0.08, DECK, DECK + 1.3, sz * (bz + 1.2) - 0.08, sz * (bz + 1.2) + 0.08, C.yellow, { r: 0.03 }); // emergency stops
  // the waiting platform (stair side): a bench along the glass, the queue rail along the gates, two double-sided
  // next-cabin screens and pendant lights hung from the rafters
  const xw = -WL + 0.36, bz0 = -HL + 1.2, bz1 = bz0 + 3.4;
  bench(xw, xw + 0.48, bz0, bz1, DECK, -1);
  const xq = -rb - 1.4, zq0 = -3.2, zq1 = 0.6;
  for (let k = 0; k <= 3; k++) { const z = zq0 + ((zq1 - zq0) * k) / 3; K.bar('metal', [xq, DECK, z], [xq, DECK + 0.95, z], 0.06, C.steel, true); }
  K.box('metal', xq - 0.02, xq + 0.02, DECK + 0.82, DECK + 0.9, zq0, zq1, C.yellow);
  const xsc = (-WL + 0.3 - rb) / 2, ysc = DECK + 2.75, screens = [-4.9, 1.2];
  for (const z of screens) {
    K.box('metal', xsc - 0.7, xsc + 0.7, ysc - 0.37, ysc + 0.37, z - 0.05, z + 0.05, C.dark, { r: 0.02 });
    for (const dx of [-0.5, 0.5]) K.bar('metal', [xsc + dx, ysc + 0.37, z], [xsc + dx, roofBot(xsc + dx) - 0.12, z], 0.03, C.steel, true);
  }
  for (const z of [-HL + 1.4, -6.4, -3.2, -0.6, 2.6, HL - 2.4]) {
    K.bar('metal', [xsc, roofBot(xsc) - 0.12, z], [xsc, DECK + 3.36, z], 0.025, C.anth, true);
    const g = new THREE.CylinderGeometry(0.1, 0.26, 0.24, 14, 1, true); g.translate(xsc, DECK + 3.24, z); K.add('metal', g, C.anth);
    const l = new THREE.CylinderGeometry(0.2, 0.2, 0.02, 14); l.translate(xsc, DECK + 3.13, z); K.add('light', l, C.white);
  }

  // ---------------------------------------------------------------- the hall: frames, glass, roof
  const xcL = -WL + 0.2, xcR = WR - 0.2;
  for (const z of zc) {
    for (const x of [xcL, xcR]) K.box('metal', x - 0.15, x + 0.15, DECK, roofBot(x), z - 0.15, z + 0.15, C.steel, { r: 0.04 });
    const n = 10;
    for (let k = 0; k < n; k++) {
      const x0 = xcL + ((xcR - xcL) * k) / n, x1 = xcL + ((xcR - xcL) * (k + 1)) / n;
      K.bar('metal', [x0, roofBot(x0) - 0.13, z], [x1, roofBot(x1) - 0.13, z], 0.2, C.steel);
    }
  }
  // the long glazed walls: a pane per bay, the sill, the rail-high transom, a mid mullion (on -x round the door)
  const cutDoor = (z0, z1, sx) => (sx > 0 || z1 <= d0 - 0.1 || z0 >= d1 + 0.1 ? [[z0, z1]] : [[z0, d0 - 0.1], [d1 + 0.1, z1]].filter(([a, b]) => b - a > 0.2));
  for (const sx of [-1, 1]) {
    const x = sx < 0 ? -WL + 0.08 : WR - 0.08, yW = roofBot(x) - 0.02;
    for (let i = 0; i < nb; i++) {
      const z0 = zc[i] + 0.15, z1 = zc[i + 1] - 0.15, zm = (z0 + z1) / 2;
      for (const [a, b] of cutDoor(z0, z1, sx)) K.vquad('glass', x, a, x, b, DECK + 0.1, yW, C.white);
      if (sx > 0 || zm < d0 - 0.1 || zm > d1 + 0.1) K.box('metal', x - 0.04, x + 0.04, DECK + 0.02, yW - 0.04, zm - 0.04, zm + 0.04, C.anth);
    }
    for (const y of [DECK + 0.1, DECK + 1.1]) for (const [a, b] of cutDoor(zc[0], zc[nb], sx)) K.box('metal', x - 0.05, x + 0.05, y - 0.04, y + 0.04, a, b, C.anth);
    K.box('metal', x - 0.05, x + 0.05, yW - 0.08, yW, zc[0], zc[nb], C.anth);
    if (sx < 0 && DECK + doorH < yW - 0.3) K.vquad('glass', x, d0 - 0.1, x, d1 + 0.1, DECK + doorH, yW - 0.08, C.white); // (over the door)
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

  // ---------------------------------------------------------------- meshes: the signs and screens
  const q = { pos: [], nor: [], uv: [] }, X = (x) => x * mx;
  const TOT = SIGN_H + MID_EXTRA_H, ks = SIGN_H / TOT;
  const uvS = ([u0, v0, u1, v1]) => [u0, 1 - (1 - v0) * ks, u1, 1 - (1 - v1) * ks];
  const uvP = ([x0, y0, x1, y1]) => [x0 / SIGN_W, 1 - y1 / TOT, x1 / SIGN_W, 1 - y0 / TOT];
  if (sh > 0.4) for (const sz of [-1, 1]) signQuad(q, [X(xc0), pt + 0.45 + sh / 2, sz * (HL + 0.07)], [0, 0, sz], sh * 6, sh, uvS(UV.name));
  const zSign = Math.max(-HL + 2.5, Math.min(zFoot + 1.0, (zFoot - HL) / 2 + 0.5)); // the stair side, by its foot (over the rack)
  signQuad(q, [X(-WL - 0.04), DECK - 0.55, zSign], [-mx, 0, 0], 4.4, 0.733, uvS(UV.name));
  signQuad(q, [X(WR + 0.04), DECK - 0.55, 0], [mx, 0, 0], 5.4, 0.9, uvS(UV.name));   // the far side
  signQuad(q, [X(xo - 0.04), DECK - 1.0, (LAND0 + LAND1) / 2], [-mx, 0, 0], 1.8, 0.675, uvS(UV.entrance));
  for (const z of screens) for (const sz of [-1, 1]) signQuad(q, [X(xsc), ysc, z + sz * 0.055], [0, 0, sz], 1.3, 0.65, uvP(MPX.screen));
  const place = String(o.place || 'Mid-station');
  const sub = /mid-?station/i.test(place) ? place : `Mid-station · ${place}`;
  const sm = signMaterial(o.name || 'Gondola', sub, { h: MID_EXTRA_H, draw: (g, y0, f) => drawMidExtra(g, y0, f, o) });
  const group = assemble(K, mx, sm, q, px, py, pz, yaw);

  // ---------------------------------------------------------------- colliders
  const cols = [];
  const yA = (y) => py + y;
  const boxC = (x0, x1, z0, z1, extra = {}) => {
    if (x1 < x0) [x0, x1] = [x1, x0];
    const c = toW((x0 + x1) / 2, (z0 + z1) / 2);
    cols.push({ x: c.x, z: c.z, hw: (x1 - x0) / 2, hd: (z1 - z0) / 2, rot: -yaw, ...extra });
  };
  boxC(-WL, WR, -HL, HL, { top: yA(DECK - 0.05) });   // the plinth (walked on from the deck)
  boxC(WR - WALL, WR, -HL, HL);                        // the long glazed walls (the door's gap on -x)
  boxC(-WL, -WL + WALL, -HL, d0); boxC(-WL, -WL + WALL, d1, HL);
  for (const sz of [-1, 1]) {                          // the end glazing over the outer platforms
    const z0 = sz * (HL - 0.3), z1 = sz * HL;
    boxC(Ro + 0.1, WR, Math.min(z0, z1), Math.max(z0, z1)); boxC(-WL, -Ro - 0.1, Math.min(z0, z1), Math.max(z0, z1));
  }
  const edgeTop = { top: yA(DECK + 1.1) };
  boxC(Ro, Ro + 0.2, -HL, HL, edgeTop); boxC(-Ro - 0.2, -Ro, -HL, HL, edgeTop); // the channels' edges
  boxC(xo - 0.02, xo + 0.14, zFoot + 0.3, LAND1, { top: yA(DECK + 1.0) });       // the stair's balustrade
  boxC(xo, xi, LAND1 - 0.14, LAND1 + 0.02, { top: yA(DECK + 1.0) });
  boxC(-bx, bx, -bz, bz);                                                        // the operator's cabin
  boxC(xw, xw + 0.48, bz0, bz1, { top: yA(DECK + 0.47) });                       // the bench, the queue rail
  boxC(xq - 0.05, xq + 0.05, zq0, zq1, { top: yA(DECK + 0.95) });
  if (rz1 - rz0 > 0.8) boxC(-WL - 0.75, -WL, rz0 - 0.05, rz1 + 0.05, { top: yA(rg + 1.3) }); // the ski rack

  // ---------------------------------------------------------------- walkable: the platforms, the island, the stair
  const cs = [[xo - 0.5, -HL], [WR, -HL], [xo - 0.5, HL], [WR, HL]].map(([x, z]) => toW(x, z));
  const surf = world.addSurface({
    bounds: { minx: Math.min(...cs.map((c) => c.x)) - 0.5, maxx: Math.max(...cs.map((c) => c.x)) + 0.5, minz: Math.min(...cs.map((c) => c.z)) - 0.5, maxz: Math.max(...cs.map((c) => c.z)) + 0.5 },
    height(x, z) {
      const dx = x - px, dz = z - pz, lx = (dx * cy - dz * sy) * mx, lz = dx * sy + dz * cy;
      if (lx < -WL - 0.02) {
        if (lx < xo - 0.05 || lz < zFoot || lz > LAND1) return null;
        return py + (lz >= LAND0 ? DECK : stairY(lz)); // (the stair, the landing)
      }
      if (lz < -HL || lz > HL || lx > WR || lx < -WL) return null;
      const r = Math.abs(lx);
      if (r > Ri && r < Ro) return null; // (the channels: the balustrades keep you out)
      return py + DECK;
    },
  });
  return { group, colliders: cols, surfaces: [surf], stair: { x: xm, z0: zFoot, z1: LAND0, y0: gd } };
}
