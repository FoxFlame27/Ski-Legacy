// Walk-in ski shop: an old family-run Sporthaus in the village. Dark aged timber, plank floor and wool rugs,
// wrought-iron lanterns and a green tiled stove; the ski wall holds every pair on wooden pegs with a
// hand-lettered paper tag above each; old wooden skis, sepia photos and the painted shop sign above them.
// The small-paned windows and the glazed door look out on the real village (a live "portal" render of the
// world from where the shop stands). The clerk works the antique counter (brass bell, till, wall clock);
// the OUTFITS corner on the left wall shows your own skier on a podium between the clothing rails: look at
// it and press E to open the outfit shop (ui/outfitshop.js), which swings the camera round to the podium.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { makeSki, SKI_LENGTH } from '../player/skier.js';
import { SKIS } from './economy.js';
import { fitModel } from '../core/assets.js';
import { applyOutfit, outfitZones } from './outfits.js';
import { world } from '../world/world.js';
import { claimPortal, dropPortal } from './liveportal.js';

const W = 16, D = 8, H = 3.6; // room size (x, z, y): 16 m wide so the ski wall holds all 12 pairs
const HITBOX = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
const EYE = 1.62;
// OUTFITS corner: the podium your skier stands on, in front of the left wall between the rails
const PODIUM = new THREE.Vector3(-6.75, 0.16, -0.45);
const UP = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();
const _size = new THREE.Vector2(), _frustum = new THREE.Frustum(), _box = new THREE.Box3();

const SERIF = 'Georgia, "Times New Roman", serif';
const HAND = '"Bradley Hand", "Segoe Print", "Marker Felt", "Comic Sans MS", cursive';
// the front wall: four small-paned windows and the glazed door between them
const WINDOWS = [-4.7, -2.4, 2.4, 4.7], WIN_W = 1.4, WIN_Y0 = 0.95, WIN_Y1 = 2.35;
const DOOR_W = 1.15, DOOR_H = 2.2, DOOR_GLASS = { y0: 1.2, y1: 1.98, w: 0.78 };
const REVEAL = 0.3; // wall thickness at the openings (the glass sits on the outside face)
const SKI_LIFT = 0.1; // the skis stand on a low wooden plinth

// canvas text uses system fonts (Georgia, Bradley Hand); redraw once the page's fonts have settled
const fontsReady = typeof document !== 'undefined' && document.fonts ? document.fonts.ready.catch(() => null) : Promise.resolve();

function canvasTexture(w, h, draw, { text = false, srgb = true, repeat = null, aniso = 8 } = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  draw(g, w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
  t.userData.redraw = () => { g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, w, h); draw(g, w, h); t.needsUpdate = true; };
  if (text) fontsReady.then(() => t.userData.redraw());
  return t;
}

// seeded random so the wood looks the same every visit
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// Boards side by side (vertical in the canvas) with grain, knots, seams and age stains.
function drawBoards(g, w, h, { boards, gap = 2, base = [120, 82, 52], vary = 14, seed = 1, joints = true, aged = 0.5 }) {
  const r = rng(seed);
  const bw = w / boards;
  for (let i = 0; i < boards; i++) {
    const x = i * bw;
    const v = (r() - 0.5) * vary * 2;
    g.fillStyle = `rgb(${base[0] + v},${base[1] + v * 0.85},${base[2] + v * 0.7})`;
    g.fillRect(x, 0, bw, h);
    for (let k = 0; k < 30; k++) { // grain
      const gx = x + 2 + r() * (bw - 4), a = 0.04 + r() * 0.08;
      g.strokeStyle = r() < 0.6 ? `rgba(40,22,10,${a})` : `rgba(255,214,160,${a * 0.6})`;
      g.lineWidth = 0.6 + r() * 1.6;
      g.beginPath();
      g.moveTo(gx, 0);
      g.bezierCurveTo(gx + (r() - 0.5) * 7, h * 0.33, gx + (r() - 0.5) * 7, h * 0.66, gx + (r() - 0.5) * 5, h);
      g.stroke();
    }
    for (let k = 0; k < 2; k++) if (r() < 0.45) { // knots
      const ky = r() * h, kx = x + bw * (0.25 + r() * 0.5), kr = 4 + r() * 7;
      const kg = g.createRadialGradient(kx, ky, 0, kx, ky, kr);
      kg.addColorStop(0, 'rgba(30,16,6,0.55)'); kg.addColorStop(0.6, 'rgba(50,28,12,0.25)'); kg.addColorStop(1, 'rgba(50,28,12,0)');
      g.fillStyle = kg; g.fillRect(kx - kr, ky - kr, kr * 2, kr * 2);
    }
    for (let k = 0; k < 5 * aged; k++) { // age: darker patches
      const sy = r() * h, sh = 20 + r() * 80;
      const sg = g.createLinearGradient(0, sy, 0, sy + sh);
      sg.addColorStop(0, 'rgba(20,10,4,0)'); sg.addColorStop(0.5, `rgba(20,10,4,${0.08 + r() * 0.12})`); sg.addColorStop(1, 'rgba(20,10,4,0)');
      g.fillStyle = sg; g.fillRect(x, sy, bw, sh);
    }
    // board edges: a dark seam on one side, a worn highlight on the other
    g.fillStyle = 'rgba(14,7,2,0.85)'; g.fillRect(x, 0, gap, h);
    g.fillStyle = 'rgba(255,220,170,0.08)'; g.fillRect(x + gap, 0, 2, h);
    if (joints && r() < 0.8) { const jy = r() * h; g.fillStyle = 'rgba(14,7,2,0.7)'; g.fillRect(x, jy, bw, 2); }
  }
}
// the same boards running across the canvas (wall logs / planks)
function drawPlanksAcross(g, w, h, opts) {
  g.save(); g.translate(w, 0); g.rotate(Math.PI / 2);
  drawBoards(g, h, w, opts);
  g.restore();
}

const SKI_KIND = {
  rental: 'Rental', cruiser: 'Beginner', sport: 'All-mountain', park: 'Freestyle', powder: 'Freeride', touring: 'Touring',
  carver: 'Slalom', pro: 'Race · GS', gs: 'Race · GS', superg: 'Race · Super-G', elite: 'Race · Downhill', legend: 'Limited edition',
};
function fitFont(g, text, maxW, size, style, family) {
  let s = size;
  g.font = `${style} ${s}px ${family}`;
  while (g.measureText(text).width > maxW && s > 16) { s -= 2; g.font = `${style} ${s}px ${family}`; }
  return s;
}
// A hand-lettered paper tag on a string: rounded card with a punched hole, the category in small serif
// capitals, the name and price written in ink, and a red rubber stamp once you own the pair.
function drawTag(g, w, h, s, st) {
  g.clearRect(0, 0, w, h);
  const r = 18, x0 = 6, y0 = 6, x1 = w - 6, y1 = h - 6;
  g.beginPath();
  g.moveTo(x0 + r, y0); g.lineTo(x1 - r, y0); g.quadraticCurveTo(x1, y0, x1, y0 + r); g.lineTo(x1, y1 - r); g.quadraticCurveTo(x1, y1, x1 - r, y1);
  g.lineTo(x0 + r, y1); g.quadraticCurveTo(x0, y1, x0, y1 - r); g.lineTo(x0, y0 + r); g.quadraticCurveTo(x0, y0, x0 + r, y0); g.closePath();
  const pg = g.createLinearGradient(0, 0, w, h);
  pg.addColorStop(0, '#f3e6c4'); pg.addColorStop(1, '#e6d2a6');
  g.fillStyle = pg; g.fill();
  g.lineWidth = 3; g.strokeStyle = 'rgba(110,80,40,0.55)'; g.stroke();
  const rr = rng(s.price);
  for (let i = 0; i < 260; i++) { g.fillStyle = `rgba(120,86,40,${0.03 + rr() * 0.05})`; g.fillRect(rr() * w, rr() * h, 2 + rr() * 3, 2 + rr() * 3); }
  // the hole with its reinforcing ring, top middle
  g.fillStyle = '#c9b48a'; g.beginPath(); g.arc(w / 2, 30, 13, 0, Math.PI * 2); g.fill();
  g.globalCompositeOperation = 'destination-out'; g.beginPath(); g.arc(w / 2, 30, 7, 0, Math.PI * 2); g.fill();
  g.globalCompositeOperation = 'source-over';
  g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  g.font = `700 22px ${SERIF}`; g.fillStyle = '#8a2a1c';
  if ('letterSpacing' in g) g.letterSpacing = '4px';
  g.fillText((SKI_KIND[s.id] || (s.rent ? 'Rental' : 'Skis')).toUpperCase(), w / 2, 78);
  if ('letterSpacing' in g) g.letterSpacing = '0px';
  fitFont(g, s.name, w - 50, 46, '700', HAND);
  g.fillStyle = '#1f2a44';
  g.fillText(s.name, w / 2, 134);
  g.font = `700 52px ${HAND}`; g.fillStyle = '#8f1d14';
  g.fillText(`${s.rent ? 'Rent ' : ''}$${s.price.toLocaleString('en-US')}`, w / 2, 200);
  const pct = Math.round((s.speed - 1) * 100);
  g.font = `italic 20px ${SERIF}`; g.fillStyle = 'rgba(40,30,20,0.75)';
  g.fillText(`${pct ? `+${pct}% speed` : 'standard speed'} · ${Math.round(s.grip * 100)}% grip`, w / 2, 236);
  if (st?.owned || st?.equipped) { // rubber stamp
    g.save(); g.translate(w / 2, 150); g.rotate(-0.22);
    const label = st.equipped ? 'IN USE' : 'OWNED';
    g.font = `700 40px ${SERIF}`;
    const tw = g.measureText(label).width + 34;
    g.strokeStyle = 'rgba(176,28,24,0.85)'; g.lineWidth = 5;
    g.strokeRect(-tw / 2, -32, tw, 56);
    g.fillStyle = 'rgba(176,28,24,0.85)';
    if ('letterSpacing' in g) g.letterSpacing = '5px';
    g.fillText(label, 3, 9);
    g.restore();
  }
}

/** A painted signboard: coloured board, gilt border and serif lettering (with an optional line under it). */
function paintedSign(text, { w = 3, h = 0.5, bg = '#1f3b2b', fg = '#e2bd62', sub = '', px = 1024, emissive = 0.06 } = {}) {
  const cw = px, ch = Math.round((px * h) / w);
  const tex = canvasTexture(cw, ch, (g) => {
    const bgG = g.createLinearGradient(0, 0, 0, ch);
    bgG.addColorStop(0, bg); bgG.addColorStop(1, shade(bg, -0.25));
    g.fillStyle = bgG; g.fillRect(0, 0, cw, ch);
    const r = rng(cw + ch);
    for (let i = 0; i < 400; i++) { g.fillStyle = `rgba(0,0,0,${r() * 0.08})`; g.fillRect(r() * cw, r() * ch, 1 + r() * 6, 1); }
    const b = Math.max(6, ch * 0.07);
    g.strokeStyle = fg; g.lineWidth = b * 0.45; g.strokeRect(b, b, cw - 2 * b, ch - 2 * b);
    g.lineWidth = 1.5; g.strokeRect(b * 1.9, b * 1.9, cw - 3.8 * b, ch - 3.8 * b);
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = fg;
    fitFont(g, text, cw * 0.8, Math.round(ch * (sub ? 0.42 : 0.56)), '700', SERIF);
    if ('letterSpacing' in g) g.letterSpacing = `${Math.round(ch * 0.04)}px`;
    g.shadowColor = 'rgba(0,0,0,0.45)'; g.shadowOffsetY = 2; g.shadowBlur = 2;
    g.fillText(text, cw / 2, sub ? ch * 0.43 : ch * 0.53);
    if (sub) {
      g.font = `italic ${Math.round(ch * 0.15)}px ${SERIF}`;
      if ('letterSpacing' in g) g.letterSpacing = `${Math.round(ch * 0.03)}px`;
      g.fillText(sub, cw / 2, ch * 0.76);
    }
  }, { text: true });
  return new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: emissive }));
}
function shade(hex, k) {
  const c = new THREE.Color(hex);
  c.offsetHSL(0, 0, k * 0.4);
  return `#${c.getHexString()}`;
}

// Glass: the panes show the world outside, rendered live from where the shop stands in the village (a second
// camera, matched to yours, behind the real facade). gl_FragCoord indexes that render.
const PORTAL_VERT = `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const PORTAL_FRAG = `
  uniform sampler2D tView;
  uniform float uHas;
  uniform vec4 uVP;
  uniform vec3 uTint;
  varying vec2 vUv;
  void main() {
    vec2 suv = (gl_FragCoord.xy - uVP.xy) / uVP.zw;
    vec3 view = texture2D(tView, suv).rgb;
    // fallback (no world yet): blue sky over snow
    vec3 sky = mix(vec3(1.6, 1.75, 1.95), vec3(0.16, 0.34, 1.0), smoothstep(0.35, 1.0, vUv.y));
    vec3 c = mix(sky, view, uHas);
    gl_FragColor = vec4(c * uTint, 1.0);
  }`;

export class ShopInterior {
  /**
   * @param {object} o
   * @param {() => object} o.makeRig  the clerk's rig
   * @param {(charId: string) => object} [o.makeCharRig]  a rig of the player's skier for the OUTFITS podium
   * @param {() => string} [o.getCharacter]  the player's current character id
   * @param {(charId: string) => object} [o.getOutfit]  what that skier wears (outfits.js getEquipped)
   * @param {object} [o.outside]  the world seen through the windows:
   *   { scene, env, door: Vector3 (in front of the shop door), front: Vector3 (the way the shop faces), hide: () => Object3D[] }
   */
  constructor({ renderer, models, makeRig, getSkiState, makeCharRig, getCharacter, getOutfit, outside }) {
    this._active = false;
    this.renderer = renderer;
    this.makeCharRig = makeCharRig || null;
    this.getCharacter = getCharacter || (() => null);
    this.getOutfit = getOutfit || (() => null);
    this.outfitShop = null; // set by OutfitShop: the corner becomes interactive
    this.view = null; // outfit view: { t, from: {pos, quat}, spin } while the outfit shop is open
    this.mannequin = null; this.mannequinChar = null;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a110a);
    this.camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 100);
    this.getSkiState = getSkiState;
    this.yaw = Math.PI; this.pitch = -0.08;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.target = null;
    this.obstacles = [];
    this.plaques = [];
    this.textures = [];
    this.flames = [];

    const pmrem = new THREE.PMREMGenerator(renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.scene.environmentIntensity = 0.22;

    this.buildMaterials();
    this.buildRoom();
    this.buildFrontWall();
    this.buildLights();
    this.buildDisplays(models);
    this.buildCounter(makeRig, models);
    this.buildStove(models);
    this.buildFurnishing(models);
    this.buildOutfitCorner();
    this.setOutside(outside);
    addEventListener('resize', () => { this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix(); });
  }

  // main.js flips this off when you leave: the live window view frees its render target
  get active() { return this._active; }
  set active(v) {
    this._active = !!v;
    if (!this._active) this.releasePortal();
  }

  // ------------------------------------------------------------------ materials
  buildMaterials() {
    // aged timber walls: wide planks laid across, dark honey brown
    const wallTex = canvasTexture(512, 1024, (g, w, h) => drawPlanksAcross(g, w, h, { boards: 12, gap: 3, base: [116, 77, 46], vary: 13, seed: 3, aged: 0.6 }), { repeat: [W / 2, 1] });
    this.timber = new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.82 });
    // old floorboards, waxed: a little lighter and warmer than the walls
    const floorTex = canvasTexture(1024, 1024, (g, w, h) => drawBoards(g, w, h, { boards: 7, gap: 3, base: [128, 88, 54], vary: 14, seed: 7, aged: 1 }), { repeat: [W / 2.4, D / 2.4], aniso: 16 });
    this.floorMat = new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.62, envMapIntensity: 0.5 });
    this.beam = new THREE.MeshStandardMaterial({ color: 0x3a2516, roughness: 0.78 });
    this.darkWood = new THREE.MeshStandardMaterial({ color: 0x4a2f1c, roughness: 0.55 });
    this.honey = new THREE.MeshStandardMaterial({ color: 0x9a6534, roughness: 0.42 });
    this.iron = new THREE.MeshStandardMaterial({ color: 0x1d1b19, roughness: 0.55, metalness: 0.7 });
    this.brass = new THREE.MeshStandardMaterial({ color: 0xc89a4a, roughness: 0.28, metalness: 1 });
    this.paint = new THREE.MeshStandardMaterial({ color: 0xe8dcc0, roughness: 0.6 }); // window frames
    this.textures.push(wallTex, floorTex);
  }

  // ------------------------------------------------------------------ room
  buildRoom() {
    const add = (m, recv = true) => { m.receiveShadow = recv; this.scene.add(m); return m; };
    const floor = add(new THREE.Mesh(new THREE.PlaneGeometry(W, D), this.floorMat));
    floor.rotation.x = -Math.PI / 2;
    const back = add(new THREE.Mesh(new THREE.PlaneGeometry(W, H), this.timber)); back.position.set(0, H / 2, -D / 2);
    const sideTex = this.timber.map.clone(); sideTex.repeat.set(D / 2, 1); sideTex.needsUpdate = true;
    const sideMat = new THREE.MeshStandardMaterial({ map: sideTex, roughness: 0.82 });
    const left = add(new THREE.Mesh(new THREE.PlaneGeometry(D, H), sideMat)); left.position.set(-W / 2, H / 2, 0); left.rotation.y = Math.PI / 2;
    const right = add(new THREE.Mesh(new THREE.PlaneGeometry(D, H), sideMat)); right.position.set(W / 2, H / 2, 0); right.rotation.y = -Math.PI / 2;
    // ceiling: dark boards between heavy beams
    const ceilTex = canvasTexture(512, 512, (g, w, h) => drawBoards(g, w, h, { boards: 4, gap: 3, base: [84, 54, 32], vary: 10, seed: 19, aged: 1 }), { repeat: [W / 2, 1] });
    this.textures.push(ceilTex);
    const ceil = add(new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshStandardMaterial({ map: ceilTex, roughness: 0.9 })), false);
    ceil.position.y = H; ceil.rotation.x = Math.PI / 2;
    for (let x = -W / 2 + 1.1; x < W / 2; x += 2.2) {
      const b = add(new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.3, D), this.beam));
      b.position.set(x, H - 0.15, 0);
      b.castShadow = true;
    }
    // a heavy wall plate along the top of every wall, a skirting board along the bottom
    for (const [len, x, z, ry] of [[W, 0, -D / 2, 0], [D, -W / 2, 0, Math.PI / 2], [D, W / 2, 0, Math.PI / 2], [W, 0, D / 2, 0]]) {
      const plate = add(new THREE.Mesh(new THREE.BoxGeometry(len, 0.22, 0.12), this.beam));
      plate.position.set(x, H - 0.11, z); plate.rotation.y = ry;
      if (z !== D / 2) {
        const sk = add(new THREE.Mesh(new THREE.BoxGeometry(len, 0.12, 0.05), this.beam));
        sk.position.set(x, 0.06, z); sk.rotation.y = ry;
      }
    }
    // soft contact shade where the floor meets the walls (cheap ambient occlusion)
    const shadeTex = canvasTexture(16, 128, (g, w, h) => {
      const grad = g.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, 'rgba(20,10,4,0.45)'); grad.addColorStop(0.35, 'rgba(20,10,4,0.16)'); grad.addColorStop(1, 'rgba(20,10,4,0)');
      g.fillStyle = grad; g.fillRect(0, 0, w, h);
    });
    this.shadeMat = new THREE.MeshBasicMaterial({ map: shadeTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
    // (ry turns the strip so its dark edge lies against the wall: the room side is (sin ry, cos ry))
    for (const [len, x, z, ry] of [[W, 0, -D / 2, 0], [D, -W / 2, 0, Math.PI / 2], [D, W / 2, 0, -Math.PI / 2], [W, 0, D / 2, Math.PI]]) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(len, 0.7), this.shadeMat);
      m.rotation.set(-Math.PI / 2, ry, 0, 'YXZ');
      m.position.set(x + Math.sin(ry) * 0.35, 0.004, z + Math.cos(ry) * 0.35);
      this.scene.add(m);
    }
  }

  // The front wall: timber with four deep window openings (painted frames, 3 x 3 small panes, a gingham
  // valance and a geranium on each sill) and a glazed door. One live view plane sits behind all the glass.
  buildFrontWall() {
    const zf = D / 2;
    const add = (m) => { this.scene.add(m); return m; };
    // the wall: one shape with holes for the windows and the door
    const shape = new THREE.Shape();
    shape.moveTo(-W / 2, 0); shape.lineTo(W / 2, 0); shape.lineTo(W / 2, H); shape.lineTo(-W / 2, H); shape.closePath();
    const rect = (x0, y0, x1, y1) => { const p = new THREE.Path(); p.moveTo(x0, y0); p.lineTo(x0, y1); p.lineTo(x1, y1); p.lineTo(x1, y0); p.closePath(); return p; };
    for (const x of WINDOWS) shape.holes.push(rect(x - WIN_W / 2, WIN_Y0, x + WIN_W / 2, WIN_Y1));
    shape.holes.push(rect(-DOOR_W / 2, 0, DOOR_W / 2, DOOR_H));
    const geo = new THREE.ShapeGeometry(shape);
    // shape UVs are in metres: scale them to the timber texture (tiles 2 m wide, H tall)
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / 2, uv.getY(i) / H);
    const wallTex = this.timber.map.clone(); wallTex.repeat.set(1, 1); wallTex.needsUpdate = true;
    const front = add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.82 })));
    front.rotation.y = Math.PI; front.position.z = zf; // faces into the room (x mirrors: the layout is symmetric)
    front.castShadow = true; front.receiveShadow = true;

    // the live view: one plane just outside the wall's outer face, covering every opening
    this.portalMat = new THREE.ShaderMaterial({
      uniforms: { tView: { value: null }, uHas: { value: 0 }, uVP: { value: new THREE.Vector4(0, 0, 1, 1) }, uTint: { value: new THREE.Color(0.93, 0.94, 0.92) } },
      vertexShader: PORTAL_VERT, fragmentShader: PORTAL_FRAG,
    });
    const span = WINDOWS[WINDOWS.length - 1] + WIN_W / 2 + 0.1;
    const glass = add(new THREE.Mesh(new THREE.PlaneGeometry(span * 2, WIN_Y1 + 0.1), this.portalMat));
    glass.position.set(0, (WIN_Y1 + 0.1) / 2, zf + REVEAL + 0.02); glass.rotation.y = Math.PI;
    glass.onBeforeRender = (r) => r.getCurrentViewport(this.portalMat.uniforms.uVP.value);
    this.portalMesh = glass;
    // reveals: the opening's sides, head and sill in dark wood (the wall is REVEAL thick)
    const box = (w, h, d, x, y, z, mat, cast = true) => { const m = add(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat)); m.position.set(x, y, z); m.castShadow = cast; m.receiveShadow = true; return m; };
    const zr = zf + REVEAL / 2;
    const gingham = this.ginghamTexture();
    for (const x of WINDOWS) {
      const wy = (WIN_Y0 + WIN_Y1) / 2, wh = WIN_Y1 - WIN_Y0;
      box(0.05, wh, REVEAL, x - WIN_W / 2 - 0.025, wy, zr, this.beam);
      box(0.05, wh, REVEAL, x + WIN_W / 2 + 0.025, wy, zr, this.beam);
      box(WIN_W + 0.1, 0.05, REVEAL, x, WIN_Y1 + 0.025, zr, this.beam);
      box(WIN_W + 0.24, 0.05, REVEAL + 0.16, x, WIN_Y0 - 0.025, zf + REVEAL / 2 - 0.08, this.honey); // deep sill
      // painted sash: frame + 2 x 2 glazing bars = 3 x 3 small panes, on the outer face
      const zs = zf + REVEAL - 0.03;
      box(WIN_W, 0.06, 0.05, x, WIN_Y1 - 0.03, zs, this.paint); box(WIN_W, 0.07, 0.05, x, WIN_Y0 + 0.035, zs, this.paint);
      box(0.06, wh, 0.05, x - WIN_W / 2 + 0.03, wy, zs, this.paint); box(0.06, wh, 0.05, x + WIN_W / 2 - 0.03, wy, zs, this.paint);
      box(0.07, wh, 0.05, x, wy, zs, this.paint); // the meeting stile of the two casements
      for (const f of [1 / 3, 2 / 3]) box(WIN_W, 0.03, 0.035, x, WIN_Y0 + wh * f, zs - 0.005, this.paint);
      for (const s of [-1, 1]) box(0.03, wh, 0.035, x + s * WIN_W / 4, wy, zs - 0.005, this.paint);
      // red-and-white gingham valance across the top of the window
      const val = add(new THREE.Mesh(new THREE.PlaneGeometry(WIN_W + 0.2, 0.34), new THREE.MeshStandardMaterial({ map: gingham, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.9 })));
      val.position.set(x, WIN_Y1 - 0.13, zf - 0.04); val.rotation.y = Math.PI;
      box(WIN_W + 0.32, 0.018, 0.018, x, WIN_Y1 + 0.03, zf - 0.05, this.brass, false);
      this.geranium(x + 0.32, WIN_Y0, zf + 0.04);
    }
    // the door: a timber door with a glazed upper panel (4 small panes), brass handle; EXIT painted above
    const dshape = new THREE.Shape();
    dshape.moveTo(-DOOR_W / 2, 0); dshape.lineTo(DOOR_W / 2, 0); dshape.lineTo(DOOR_W / 2, DOOR_H); dshape.lineTo(-DOOR_W / 2, DOOR_H); dshape.closePath();
    const G = DOOR_GLASS;
    dshape.holes.push(rect(-G.w / 2, G.y0, G.w / 2, G.y1));
    const dgeo = new THREE.ExtrudeGeometry(dshape, { depth: 0.06, bevelEnabled: false });
    const duv = dgeo.attributes.uv;
    for (let i = 0; i < duv.count; i++) duv.setXY(i, duv.getX(i) / 2, duv.getY(i) / H);
    const doorTex = this.timber.map.clone(); doorTex.repeat.set(1, 1); doorTex.rotation = 0; doorTex.needsUpdate = true;
    this.door = new THREE.Group();
    const slab = new THREE.Mesh(dgeo, new THREE.MeshStandardMaterial({ map: doorTex, color: 0xb08a68, roughness: 0.7 }));
    slab.rotation.y = Math.PI; slab.position.z = zf + REVEAL - 0.02;
    this.door.add(slab);
    const zd = zf + REVEAL - 0.1;
    const dbox = (w, h, d, x, y, z, mat) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); m.castShadow = true; this.door.add(m); return m; };
    dbox(G.w, 0.03, 0.03, 0, (G.y0 + G.y1) / 2, zd + 0.06, this.paint);
    dbox(0.03, G.y1 - G.y0, 0.03, 0, (G.y0 + G.y1) / 2, zd + 0.06, this.paint);
    for (const y of [0.35, 0.8]) dbox(0.8, 0.34, 0.02, 0, y, zd + 0.01, this.darkWood); // raised panels
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.035, 16, 10), this.brass);
    knob.position.set(-0.42, 1.02, zd - 0.01);
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.22, 0.012), this.brass);
    plate.position.set(-0.42, 1.0, zd + 0.012);
    this.door.add(knob, plate);
    // door reveals
    for (const s of [-1, 1]) dbox(0.06, DOOR_H, REVEAL, s * (DOOR_W / 2 + 0.03), DOOR_H / 2, zr, this.beam);
    dbox(DOOR_W + 0.12, 0.06, REVEAL, 0, DOOR_H + 0.03, zr, this.beam);
    this.scene.add(this.door);
    // aim anywhere at the door to leave
    this.doorHit = new THREE.Mesh(new THREE.BoxGeometry(DOOR_W + 0.3, DOOR_H + 0.2, 0.6), HITBOX);
    this.doorHit.position.set(0, DOOR_H / 2, zf - 0.1);
    this.doorHit.userData.kind = 'door';
    this.scene.add(this.doorHit);
    const exit = paintedSign('AUSGANG · EXIT', { w: 0.9, h: 0.2, bg: '#5b1a14', fg: '#ecd7a8', px: 512 });
    exit.position.set(0, DOOR_H + 0.3, zf - 0.02); exit.rotation.y = Math.PI;
    this.scene.add(exit);
  }

  ginghamTexture() {
    const t = canvasTexture(256, 64, (g, w, h) => {
      g.clearRect(0, 0, w, h);
      // scalloped hem
      g.beginPath(); g.moveTo(0, 0); g.lineTo(w, 0); g.lineTo(w, h * 0.72);
      const n = 8;
      for (let i = n; i > 0; i--) g.quadraticCurveTo(w * (i - 0.5) / n, h * 1.02, w * (i - 1) / n, h * 0.72);
      g.closePath(); g.save(); g.clip();
      g.fillStyle = '#f4eee2'; g.fillRect(0, 0, w, h);
      const s = 8;
      for (let y = 0; y < h; y += s) for (let x = 0; x < w; x += s) {
        const a = ((x / s) % 2 === 0 ? 0.5 : 0) + ((y / s) % 2 === 0 ? 0.5 : 0);
        if (a) { g.fillStyle = `rgba(178,32,28,${a * 0.9})`; g.fillRect(x, y, s, s); }
      }
      g.restore();
    });
    t.wrapS = THREE.RepeatWrapping;
    this.textures.push(t);
    return t;
  }

  // A clay pot of red geraniums on a window sill.
  geranium(x, y, z) {
    const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.075, 0.16, 16), new THREE.MeshStandardMaterial({ color: 0xa4532e, roughness: 0.85 }));
    pot.position.set(x, y + 0.08, z);
    const leafMat = new THREE.MeshStandardMaterial({ color: 0x3f6b2c, roughness: 0.8 });
    const bloomMat = new THREE.MeshStandardMaterial({ color: 0xd8302a, roughness: 0.7 });
    const g = new THREE.Group();
    g.add(pot);
    const r = rng(Math.round(x * 100) + 7);
    for (let i = 0; i < 7; i++) {
      const l = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), leafMat);
      l.scale.set(1, 0.55, 1);
      l.position.set(x + (r() - 0.5) * 0.2, y + 0.19 + r() * 0.06, z + (r() - 0.5) * 0.16);
      g.add(l);
    }
    for (let i = 0; i < 5; i++) {
      const b = new THREE.Mesh(new THREE.IcosahedronGeometry(0.045, 0), bloomMat);
      b.position.set(x + (r() - 0.5) * 0.22, y + 0.27 + r() * 0.09, z + (r() - 0.5) * 0.16);
      g.add(b);
    }
    g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    this.scene.add(g);
  }

  // Daylight through the windows (follows the time of day), lanterns, picture lights on the ski wall.
  buildLights() {
    this.hemi = new THREE.HemisphereLight(0xffe2bf, 0x2a1a0e, 0.55);
    this.scene.add(this.hemi);
    const day = new THREE.DirectionalLight(0xfff1dc, 3.2);
    day.position.set(4.5, 8.5, 12);
    day.target.position.set(-0.5, 0, -1.5);
    day.castShadow = true;
    day.shadow.mapSize.set(1024, 1024);
    Object.assign(day.shadow.camera, { left: -10, right: 10, top: 7, bottom: -7, near: 1, far: 34 });
    day.shadow.bias = -0.0005;
    day.shadow.normalBias = 0.02;
    this.daylight = day;
    this.scene.add(day, day.target);
    // wrought-iron lanterns hanging from the beams: a warm point light in each
    this.lamps = [];
    for (const [x, z] of [[-4.7, -0.2], [-0.3, -0.2], [4.1, 1.4], [-2.5, 2.2]]) this.lantern(x, z);
    // picture lights over the ski wall
    for (const x of [-4.2, 0.6, 5.0]) {
      const s = new THREE.SpotLight(0xffd29a, 9, 8, 0.85, 0.85, 1.6);
      s.position.set(x, H - 0.35, -D / 2 + 1.3);
      s.target.position.set(x, 1.2, -D / 2);
      this.scene.add(s, s.target);
    }
    // wall sconces (glow only)
    for (const [x, z, ry] of [[-W / 2 + 0.06, 2.6, Math.PI / 2], [W / 2 - 0.06, -0.6, -Math.PI / 2], [-W / 2 + 0.06, -3.4, Math.PI / 2]]) this.sconce(x, 2.15, z, ry);
  }

  lantern(x, z) {
    const y = 2.62;
    const g = new THREE.Group();
    const chain = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, H - 0.3 - y - 0.25, 5), this.iron);
    chain.position.y = (H - 0.3 - y) / 2 + 0.12;
    g.add(chain);
    const glass = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.28, 0.2), new THREE.MeshStandardMaterial({ color: 0xffe2b0, emissive: 0xffb45e, emissiveIntensity: 2.6, roughness: 0.3 }));
    g.add(glass);
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.32, 0.022), this.iron);
      post.position.set(sx * 0.11, 0, sz * 0.11);
      g.add(post);
    }
    const cap = new THREE.Mesh(new THREE.ConeGeometry(0.19, 0.14, 4), this.iron);
    cap.rotation.y = Math.PI / 4; cap.position.y = 0.22;
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.03, 0.26), this.iron);
    base.position.y = -0.16;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.008, 6, 12), this.iron);
    ring.position.y = 0.32;
    g.add(cap, base, ring);
    g.position.set(x, y, z);
    this.scene.add(g);
    const L = new THREE.PointLight(0xffbf7a, 5, 10, 1.5);
    L.position.set(x, y - 0.02, z);
    this.scene.add(L);
    this.lamps.push(L);
  }

  sconce(x, y, z, ry) {
    const g = new THREE.Group();
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.22, 0.02), this.iron);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 0.18), this.iron);
    arm.position.set(0, -0.04, 0.09);
    const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.03, 0.05, 10), this.iron);
    cup.position.set(0, -0.02, 0.18);
    const candle = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.1, 8), new THREE.MeshStandardMaterial({ color: 0xf3ead2, roughness: 0.6 }));
    candle.position.set(0, 0.05, 0.18);
    const flame = new THREE.Mesh(new THREE.SphereGeometry(0.022, 8, 6), new THREE.MeshStandardMaterial({ color: 0xffe0a0, emissive: 0xffa848, emissiveIntensity: 4 }));
    flame.scale.y = 1.6; flame.position.set(0, 0.125, 0.18);
    g.add(plate, arm, cup, candle, flame);
    g.position.set(x, y, z); g.rotation.y = ry;
    this.scene.add(g);
    this.flames.push(flame);
  }

  // ------------------------------------------------------------------ ski wall
  buildDisplays(models) {
    this.displays = [];
    const wallZ = -D / 2;
    // the painted shop sign in the middle, old wooden skis crossed and sepia photographs either side
    const sign = paintedSign('SKI LEGACY', { w: 4.4, h: 0.66, sub: 'Sporthaus  ·  Skiverleih  ·  seit 1931', px: 1024 });
    sign.position.set(0, 2.98, wallZ + 0.04);
    const signBack = new THREE.Mesh(new THREE.BoxGeometry(4.56, 0.8, 0.05), this.beam);
    signBack.position.set(0, 2.98, wallZ + 0.012);
    this.scene.add(sign, signBack);
    this.vintageSkis(-3.45, 2.98, wallZ); this.vintageSkis(3.45, 2.98, wallZ);
    [[-6.55, 0], [-4.9, 1], [4.9, 2], [6.55, 3]].forEach(([x, k]) => this.photo(x, 2.96, wallZ, k));
    // a wooden rail with pegs, and the low plinth the skis stand on
    const rail = new THREE.Mesh(new THREE.BoxGeometry(W - 1.4, 0.1, 0.07), this.darkWood);
    rail.position.set(0, 1.5, wallZ + 0.04); rail.castShadow = true;
    const plinth = new THREE.Mesh(new THREE.BoxGeometry(W - 1.4, SKI_LIFT, 0.36), this.darkWood);
    plinth.position.set(0, SKI_LIFT / 2, wallZ + 0.2);
    plinth.castShadow = plinth.receiveShadow = true;
    this.scene.add(rail, plinth);
    const pegGeo = new THREE.CylinderGeometry(0.018, 0.022, 0.2, 10);
    const string = new THREE.MeshBasicMaterial({ color: 0x8a7a5a });

    // the pairs, in price order
    const span = W - 2.4, step = span / Math.max(1, SKIS.length - 1);
    SKIS.forEach((s, i) => {
      const gltf = models[s.model] || models[s.fallback];
      if (!gltf) return;
      const group = new THREE.Group();
      const x = -span / 2 + i * step;
      for (const dx of [-0.3, 0, 0.3]) { // turned wooden pegs either side of each ski
        const peg = new THREE.Mesh(pegGeo, this.honey);
        peg.rotation.x = Math.PI / 2; peg.position.set(x + dx, 1.5, wallZ + 0.16);
        peg.castShadow = true;
        this.scene.add(peg);
      }
      for (const dx of [-0.15, 0.15]) {
        const ski = makeSki(gltf);
        // tip up, top sheet facing into the room, leaning back against the wall
        ski.rotation.set(-Math.PI / 2 + 0.06, Math.PI, 0, 'YXZ');
        ski.position.set(x + dx, SKI_LENGTH / 2 + 0.04 + SKI_LIFT, wallZ + 0.16);
        ski.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.material = o.material.clone(); } });
        group.add(ski);
      }
      // the paper tag on a string from a brass nail
      const tw = Math.min(0.62, step - 0.3), th = tw * 256 / 384;
      const tagTex = canvasTexture(384, 256, (g, w, h) => drawTag(g, w, h, s, this.getSkiState?.(s.id)), { text: true });
      this.textures.push(tagTex);
      const tag = new THREE.Mesh(new THREE.PlaneGeometry(tw, th), new THREE.MeshStandardMaterial({ map: tagTex, alphaTest: 0.5, roughness: 0.85, side: THREE.DoubleSide }));
      const ty = 2.12, tilt = ((i * 37) % 7 - 3) * 0.012;
      tag.position.set(x, ty, wallZ + 0.07); tag.rotation.z = tilt;
      tag.castShadow = true;
      const nail = new THREE.Mesh(new THREE.SphereGeometry(0.012, 8, 6), this.brass);
      nail.position.set(x, ty + th / 2 + 0.11, wallZ + 0.03);
      for (const sx of [-1, 1]) { // the string: two strands from the nail to the punched hole
        const holeY = ty + th / 2 - th * 30 / 256;
        const len = Math.hypot(0.03, ty + th / 2 + 0.11 - holeY);
        const st = new THREE.Mesh(new THREE.CylinderGeometry(0.0025, 0.0025, len, 4), string);
        st.position.set(x + sx * 0.015, (ty + th / 2 + 0.11 + holeY) / 2, wallZ + 0.06);
        st.rotation.z = sx * Math.atan2(0.03, len);
        this.scene.add(st);
      }
      this.scene.add(tag, nail);
      this.plaques.push({ id: s.id, tex: tagTex, sig: '' });
      // generous invisible hit area around the pair + tag so aiming is easy
      const hit = new THREE.Mesh(new THREE.BoxGeometry(Math.min(1.2, step - 0.04), 2.6, 0.5), HITBOX);
      hit.position.set(x, 1.3, wallZ + 0.3);
      group.add(hit);
      group.userData = { kind: 'ski', id: s.id, name: s.name };
      this.scene.add(group);
      this.displays.push(group);
    });
  }

  // a crossed pair of old hickory skis with leather straps, tips curled up
  vintageSkis(cx, cy, wallZ) {
    const wood = new THREE.MeshStandardMaterial({ color: 0x8a5428, roughness: 0.38 });
    const leather = new THREE.MeshStandardMaterial({ color: 0x3a2214, roughness: 0.7 });
    for (const s of [-1, 1]) {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.075, 1.45, 0.02), wood);
      const tip = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.16, 0.02), wood);
      tip.position.set(0, 0.78, 0.035); tip.rotation.x = -0.6;
      const strap = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.12, 0.035), leather);
      strap.position.set(0, -0.1, 0.012);
      g.add(body, tip, strap);
      g.rotation.z = s * 0.95;
      g.position.set(cx, cy, wallZ + 0.04 + (s > 0 ? 0.025 : 0));
      g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      this.scene.add(g);
    }
  }

  // an old sepia photograph in a dark frame: k picks the motif
  photo(x, y, wallZ, k) {
    const w = 0.62, h = 0.46;
    const tex = canvasTexture(320, 240, (g, cw, ch) => {
      const sky = g.createLinearGradient(0, 0, 0, ch);
      sky.addColorStop(0, '#e9dcc0'); sky.addColorStop(1, '#cbb68f');
      g.fillStyle = sky; g.fillRect(0, 0, cw, ch);
      const r = rng(k * 31 + 5);
      const ridge = (y0, amp, col) => {
        g.fillStyle = col; g.beginPath(); g.moveTo(0, ch);
        for (let i = 0; i <= 12; i++) g.lineTo((i / 12) * cw, y0 - (i % 2 ? amp * (0.5 + r()) : amp * r() * 0.4));
        g.lineTo(cw, ch); g.closePath(); g.fill();
      };
      ridge(ch * 0.55, ch * 0.32, '#9f8a66');
      ridge(ch * 0.72, ch * 0.16, '#7f6a4a');
      g.fillStyle = '#efe4cc'; g.fillRect(0, ch * 0.78, cw, ch * 0.22);
      g.fillStyle = '#3a2c1c';
      if (k === 0 || k === 2) { // a skier mid-turn
        const sx = cw * (k ? 0.62 : 0.4), sy = ch * 0.74;
        g.beginPath(); g.ellipse(sx, sy - 26, 6, 13, 0.4, 0, Math.PI * 2); g.fill();
        g.beginPath(); g.arc(sx + 4, sy - 44, 5, 0, Math.PI * 2); g.fill();
        g.fillRect(sx - 26, sy - 10, 52, 3);
      } else if (k === 1) { // a little village with a church
        for (let i = 0; i < 6; i++) { const hx = 40 + i * 42 + r() * 10; g.fillRect(hx, ch * 0.72, 22, 16); g.beginPath(); g.moveTo(hx - 4, ch * 0.72); g.lineTo(hx + 11, ch * 0.66); g.lineTo(hx + 26, ch * 0.72); g.fill(); }
        g.fillRect(cw * 0.5, ch * 0.58, 8, 40); g.beginPath(); g.moveTo(cw * 0.5 - 2, ch * 0.58); g.lineTo(cw * 0.5 + 4, ch * 0.48); g.lineTo(cw * 0.5 + 10, ch * 0.58); g.fill();
      } else { // racers at a start line with flags
        for (let i = 0; i < 4; i++) { const fx = 50 + i * 70; g.fillRect(fx, ch * 0.6, 3, 50); g.fillRect(fx + 3, ch * 0.6, 18, 11); }
        for (let i = 0; i < 3; i++) { const px = 90 + i * 60; g.beginPath(); g.arc(px, ch * 0.7, 5, 0, Math.PI * 2); g.fill(); g.fillRect(px - 5, ch * 0.72, 10, 22); }
      }
      // grain, vignette and the white border of an old print
      for (let i = 0; i < 1400; i++) { g.fillStyle = `rgba(60,40,20,${r() * 0.08})`; g.fillRect(r() * cw, r() * ch, 1.5, 1.5); }
      const vg = g.createRadialGradient(cw / 2, ch / 2, ch * 0.3, cw / 2, ch / 2, cw * 0.62);
      vg.addColorStop(0, 'rgba(60,40,20,0)'); vg.addColorStop(1, 'rgba(60,40,20,0.45)');
      g.fillStyle = vg; g.fillRect(0, 0, cw, ch);
      g.strokeStyle = '#efe6d2'; g.lineWidth = 14; g.strokeRect(0, 0, cw, ch);
    });
    this.textures.push(tex);
    const pic = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5 }));
    pic.position.set(x, y, wallZ + 0.035);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(w + 0.08, h + 0.08, 0.04), this.beam);
    frame.position.set(x, y, wallZ + 0.012);
    frame.castShadow = true;
    this.scene.add(pic, frame);
  }

  // redraw the tags whose owned / equipped state changed
  refreshPlaques() {
    for (const p of this.plaques) {
      const st = this.getSkiState?.(p.id);
      const sig = st ? `${st.owned ? 1 : 0}${st.equipped ? 1 : 0}` : '';
      if (sig !== p.sig) { p.sig = sig; p.tex.userData.redraw(); }
    }
  }

  // ------------------------------------------------------------------ counter, shelves, clock
  buildCounter(makeRig, models) {
    const cx = 4.45, cz = 1.4, len = 3.2;
    let dep = 0.72, top = 1.05;
    const g = new THREE.Group();
    // the Meshy counter (shop_counter: its front run, honey wood with raised panels; the model's shelf unit and
    // computer are cut off), 3.2 m long, its customer side (the model's +z) facing the room (-x)
    if (models.shop_counter) {
      const m = fitModel(models.shop_counter, { size: len, axis: 'x' });
      m.name = 'shop-counter';
      dep = m.userData.size.z; top = m.userData.size.y; // (its worktop: the bell, till and ledger stand on it)
      m.rotation.y = -Math.PI / 2;
      m.position.set(cx - 0.36 + dep / 2, 0, cz);
      g.add(m);
    }
    // brass bell, an old brass till, a ledger and trail maps
    const bellBase = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.055, 0.02, 20), this.darkWood);
    bellBase.position.set(cx - 0.2, top + 0.01, cz - 0.35);
    const bell = new THREE.Mesh(new THREE.SphereGeometry(0.045, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), this.brass);
    bell.position.set(cx - 0.2, top + 0.02, cz - 0.35);
    const knobB = new THREE.Mesh(new THREE.SphereGeometry(0.01, 8, 6), this.brass);
    knobB.position.set(cx - 0.2, top + 0.072, cz - 0.35);
    g.add(bellBase, bell, knobB);
    const till = new THREE.Group();
    const tb = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.16, 0.4), this.brass);
    tb.position.y = 0.08;
    const tt = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.14, 0.36), this.brass);
    tt.position.set(0.05, 0.22, 0); tt.rotation.z = 0.35;
    const disp = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.08, 0.22), this.darkWood);
    disp.position.set(0.1, 0.33, 0);
    const drawer = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.06, 0.42), this.darkWood);
    drawer.position.y = 0.02;
    till.add(tb, tt, disp, drawer);
    till.position.set(cx + 0.08, top, cz + 0.75);
    g.add(till);
    const ledger = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.035, 0.32), new THREE.MeshStandardMaterial({ color: 0x5a1a14, roughness: 0.6 }));
    ledger.position.set(cx - 0.05, top + 0.018, cz - 0.95); ledger.rotation.y = 0.12;
    const pages = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.02, 0.3), new THREE.MeshStandardMaterial({ color: 0xece0c2, roughness: 0.9 }));
    pages.position.set(cx - 0.05, top + 0.04, cz - 0.95); pages.rotation.y = 0.12;
    g.add(ledger, pages);
    g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    this.scene.add(g);
    if (models.ski_goggles) { // goggles on the counter
      const gm = fitModel(models.ski_goggles, { size: 0.2, axis: 'xz' });
      gm.position.set(cx - 0.12, top, cz + 0.05); gm.rotation.y = -Math.PI / 2 + 0.3;
      gm.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      this.scene.add(gm);
    }
    this.counterBox = { minX: cx - 0.36 - 0.06, maxX: cx - 0.36 + dep, minZ: cz - len / 2 - 0.05, maxZ: cz + len / 2 + 0.05 };

    // shelves behind the counter: wax tins, boxed goggles, folded sweaters
    const sx = W / 2 - 0.2, sz0 = -0.1, sz1 = 2.9, shH = 2.3;
    const shelf = new THREE.Group();
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.02, shH, sz1 - sz0), this.beam);
    back.position.set(sx + 0.17, shH / 2, (sz0 + sz1) / 2);
    shelf.add(back);
    for (const z of [sz0, (sz0 + sz1) / 2, sz1]) {
      const side = new THREE.Mesh(new THREE.BoxGeometry(0.36, shH, 0.04), this.darkWood);
      side.position.set(sx, shH / 2, z);
      shelf.add(side);
    }
    const colors = [0xa8322a, 0x2c4f7c, 0xd6b45a, 0x3d6b3a, 0xe8dcc4, 0x7a3f22];
    const r = rng(41);
    for (const y of [0.45, 0.95, 1.45, 1.95]) {
      const board = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.035, sz1 - sz0), this.honey);
      board.position.set(sx, y, (sz0 + sz1) / 2);
      shelf.add(board);
      for (let z = sz0 + 0.14; z < sz1 - 0.12;) {
        const tin = r() < 0.45, wz = tin ? 0.11 : 0.16 + r() * 0.14;
        if (Math.abs(z - (sz0 + sz1) / 2) < 0.08 + wz / 2) { z += 0.16; continue; }
        const mat = new THREE.MeshStandardMaterial({ color: colors[Math.floor(r() * colors.length)], roughness: tin ? 0.35 : 0.8, metalness: tin ? 0.5 : 0 });
        const item = tin ? new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.1, 14), mat) : new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.1 + r() * 0.14, wz), mat);
        item.position.set(sx - 0.02, y + 0.018 + (tin ? 0.05 : item.geometry.parameters.height / 2), z + wz / 2);
        shelf.add(item);
        z += wz + 0.04 + r() * 0.05;
      }
    }
    shelf.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    this.scene.add(shelf);
    // the wall clock above the shelves: its hands keep the game's time
    this.clock = this.wallClock(W / 2 - 0.05, 2.85, (sz0 + sz1) / 2);
    this.finishCounter(makeRig);
  }

  wallClock(x, y, z) {
    const g = new THREE.Group();
    const face = canvasTexture(256, 256, (c, w, h) => {
      c.fillStyle = '#efe5cc'; c.beginPath(); c.arc(128, 128, 126, 0, Math.PI * 2); c.fill();
      c.strokeStyle = '#2a1d12'; c.lineWidth = 3; c.beginPath(); c.arc(128, 128, 112, 0, Math.PI * 2); c.stroke();
      c.fillStyle = '#2a1d12'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.font = `700 26px ${SERIF}`;
      ['XII', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI'].forEach((n, i) => {
        const a = (i / 12) * Math.PI * 2;
        c.fillText(n, 128 + Math.sin(a) * 92, 128 - Math.cos(a) * 92);
      });
      for (let i = 0; i < 60; i++) { const a = (i / 60) * Math.PI * 2; c.fillRect(128 + Math.sin(a) * 108 - 1, 128 - Math.cos(a) * 108 - 1, i % 5 ? 2 : 4, i % 5 ? 2 : 4); }
    }, { text: true });
    this.textures.push(face);
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.27, 0.06, 40), this.darkWood);
    rim.rotation.z = Math.PI / 2;
    const bezel = new THREE.Mesh(new THREE.TorusGeometry(0.235, 0.014, 8, 40), this.brass);
    bezel.rotation.y = -Math.PI / 2; bezel.position.x = -0.032;
    const dial = new THREE.Mesh(new THREE.CircleGeometry(0.23, 40), new THREE.MeshStandardMaterial({ map: face, roughness: 0.6 }));
    dial.rotation.y = -Math.PI / 2; dial.position.x = -0.031;
    const handMat = new THREE.MeshStandardMaterial({ color: 0x1a120b, roughness: 0.5 });
    const hour = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.12, 0.016), handMat);
    hour.geometry.translate(0, 0.05, 0);
    const minute = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.18, 0.01), handMat);
    minute.geometry.translate(0, 0.08, 0);
    const hands = new THREE.Group();
    hands.add(hour, minute);
    hands.rotation.y = -Math.PI / 2; hands.position.x = -0.04;
    hour.position.z = 0; minute.position.z = -0.004;
    g.add(rim, bezel, dial, hands);
    g.position.set(x, y, z);
    this.scene.add(g);
    return { hour, minute };
  }

  finishCounter(makeRig) {
    this.clerk = makeRig();
    this.clerk.setSkisVisible(false);
    this.clerk.addTo(this.scene);
    this.clerk.root.position.set(5.15, 0, 1.4);
    this.clerkHit = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.9, 0.9), HITBOX);
    this.clerkHit.position.set(5.15, 0.95, 1.4);
    this.clerkHit.userData.kind = 'clerk';
    this.scene.add(this.clerkHit);
  }

  // The green tiled stove (Kachelofen) in the front-right corner, with firewood beside it.
  buildStove(models) {
    const sx = 7.2, sz = 3.3, w = 1.2, d = 1.0, h = 1.8;
    const tiles = canvasTexture(256, 256, (g, cw, ch) => {
      g.fillStyle = '#e9e0c8'; g.fillRect(0, 0, cw, ch);
      const r = rng(13), n = 4, t = cw / n;
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        const gx = i * t + 4, gy = j * t + 4, s = t - 8;
        const v = (r() - 0.5) * 18;
        const tg = g.createRadialGradient(gx + s * 0.35, gy + s * 0.3, 2, gx + s / 2, gy + s / 2, s * 0.75);
        tg.addColorStop(0, `rgb(${92 + v},${136 + v},${96 + v})`); tg.addColorStop(1, `rgb(${40 + v},${82 + v},${56 + v})`);
        g.fillStyle = tg; g.fillRect(gx, gy, s, s);
        g.strokeStyle = 'rgba(255,255,255,0.18)'; g.lineWidth = 2; g.strokeRect(gx + 3, gy + 3, s - 6, s - 6);
      }
    }, { repeat: [1.5, 1.8] });
    this.textures.push(tiles);
    const glaze = new THREE.MeshStandardMaterial({ map: tiles, roughness: 0.25, envMapIntensity: 1.2 });
    const cream = new THREE.MeshStandardMaterial({ color: 0xe6dcc4, roughness: 0.35 });
    const g = new THREE.Group();
    const base = new THREE.Mesh(new THREE.BoxGeometry(w + 0.1, 0.2, d + 0.1), cream);
    base.position.y = 0.1;
    const body = new THREE.Mesh(new THREE.BoxGeometry(w, h - 0.35, d), glaze);
    body.position.y = 0.2 + (h - 0.35) / 2;
    const cornice = new THREE.Mesh(new THREE.BoxGeometry(w + 0.14, 0.15, d + 0.14), cream);
    cornice.position.y = h - 0.075;
    const crown = new THREE.Mesh(new THREE.BoxGeometry(w - 0.1, 0.12, d - 0.1), glaze);
    crown.position.y = h + 0.06;
    // the iron door with the fire glowing through its slots, facing the room
    const door = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.34, 0.36), this.iron);
    door.position.set(-w / 2 - 0.015, 0.55, 0);
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.05), new THREE.MeshStandardMaterial({ color: 0xff8a3a, emissive: 0xff6a1a, emissiveIntensity: 3 }));
    glow.rotation.y = -Math.PI / 2; glow.position.set(-w / 2 - 0.032, 0.5, 0);
    const glow2 = glow.clone(); glow2.position.y = 0.6;
    this.flames.push(glow, glow2);
    g.add(base, body, cornice, crown, door, glow, glow2);
    // a bench by the stove (Ofenbank): the Meshy rustic bench, along its side
    if (models.shop_bench) {
      const bench = fitModel(models.shop_bench, { size: d + 0.3, axis: 'xz' });
      bench.rotation.y = Math.PI / 2;
      bench.position.set(-w / 2 - 0.42, 0, -0.1);
      g.add(bench);
    }
    g.position.set(sx, 0, sz);
    g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    this.scene.add(g);
    // a little firelight on the floor in front of it
    this.fire = new THREE.PointLight(0xff8a3a, 1.2, 3.2, 1.6);
    this.fire.position.set(sx - w / 2 - 0.35, 0.5, sz);
    this.scene.add(this.fire);
    this.obstacles.push({ x: sx, z: sz, r: 0.75 }, { x: sx - 0.9, z: sz - 0.2, r: 0.35 });
    if (models.firewood_pile) {
      const f = fitModel(models.firewood_pile, { size: 0.8, axis: 'xz' });
      f.position.set(5.7, 0, D / 2 - 0.4); f.rotation.y = 0.2;
      f.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      this.scene.add(f);
      this.obstacles.push({ x: 5.7, z: D / 2 - 0.4, r: 0.4 });
    }
  }

  // Racks, shelves, rugs and an old table so the shop feels like a real village store.
  buildFurnishing(models) {
    const put = (name, x, z, yaw, size, axis = 'xz', r = size * 0.45) => {
      if (!models[name]) return null;
      const m = fitModel(models[name], { size, axis });
      m.position.set(x, 0, z);
      m.rotation.y = yaw;
      m.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      this.scene.add(m);
      if (r) this.obstacles.push({ x, z, r });
      return m;
    };
    // left wall: the OUTFITS corner, clothing rails either side of the podium, helmets + goggles in the front corner
    put('jacket_rail', -W / 2 + 0.72, -2.75, Math.PI / 2, 1.7);
    put('jacket_rail', -W / 2 + 0.72, 1.85, Math.PI / 2, 1.7);
    put('helmet_shelf', -W / 2 + 1.25, D / 2 - 0.32, Math.PI, 1.6);
    // right wall: boots, a bench to try them on, a barrel and the old wooden sled
    put('boot_rack', W / 2 - 0.42, -2.4, -Math.PI / 2, 2.0);
    {
      // the bench to try boots on (the Meshy rustic bench, along the wall)
      const bx = W / 2 - 1.7, bz = -2.4;
      if (put('shop_bench', bx, bz, Math.PI / 2, 1.5, 'xz', 0)) this.obstacles.push({ x: bx, z: bz - 0.45, r: 0.35 }, { x: bx, z: bz + 0.45, r: 0.35 });
    }
    put('wooden_barrel', 4.95, D / 2 - 0.5, 0.4, 0.6, 'xz', 0.45);
    put('wooden_sled', -3.2, D / 2 - 0.45, 0.06, 1.2, 'xz', 0.45);
    put('glove_bin', -1.95, D / 2 - 0.75, 0.25, 0.9);

    // a traditional red wool rug in the middle, a striped rag runner at the door
    const rugTex = canvasTexture(512, 256, (g, w, h) => {
      g.fillStyle = '#7d1d18'; g.fillRect(0, 0, w, h);
      const r = rng(5);
      for (let i = 0; i < 2400; i++) { g.fillStyle = `rgba(${r() < 0.5 ? '0,0,0' : '255,200,160'},${0.03 + r() * 0.05})`; g.fillRect(r() * w, r() * h, 2, 2); }
      g.strokeStyle = '#e6d3a6'; g.lineWidth = 10; g.strokeRect(14, 14, w - 28, h - 28);
      g.strokeStyle = '#1f3b5a'; g.lineWidth = 6; g.strokeRect(30, 30, w - 60, h - 60);
      g.fillStyle = '#e6d3a6';
      for (let i = 0; i < 7; i++) { g.save(); g.translate(76 + i * 60, 128); g.rotate(Math.PI / 4); g.fillRect(-13, -13, 26, 26); g.fillStyle = '#1f3b5a'; g.fillRect(-6, -6, 12, 12); g.fillStyle = '#e6d3a6'; g.restore(); }
    });
    const runTex = canvasTexture(256, 512, (g, w, h) => {
      const cols = ['#b8402f', '#e9dfc6', '#2f4f74', '#e9dfc6', '#6b8a3c', '#e9dfc6'];
      for (let y = 0, i = 0; y < h; i++) { const sh = 14 + ((i * 7) % 4) * 6; g.fillStyle = cols[i % cols.length]; g.fillRect(0, y, w, sh); y += sh; }
      const r = rng(9);
      for (let i = 0; i < 1600; i++) { g.fillStyle = `rgba(0,0,0,${r() * 0.07})`; g.fillRect(r() * w, r() * h, 3, 1.5); }
    });
    this.textures.push(rugTex, runTex);
    const rug = new THREE.Mesh(new THREE.PlaneGeometry(3.8, 1.9), new THREE.MeshStandardMaterial({ map: rugTex, roughness: 0.95 }));
    rug.rotation.x = -Math.PI / 2; rug.position.set(0.4, 0.005, -0.5); rug.receiveShadow = true;
    const runner = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 2.0), new THREE.MeshStandardMaterial({ map: runTex, roughness: 0.95 }));
    runner.rotation.x = -Math.PI / 2; runner.position.set(0, 0.006, D / 2 - 1.15); runner.receiveShadow = true;
    this.scene.add(rug, runner);

    // an old farmhouse table: goggles, gloves and beanies laid out
    // (the Meshy farmhouse table, 0.8 m high)
    const tx = -3.5, tz = 1.45;
    if (!models.farm_table) return;
    const tg = fitModel(models.farm_table, { size: 0.8, axis: 'y' });
    tg.position.set(tx, 0, tz);
    tg.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    this.scene.add(tg);
    const topY = tg.userData.size.y;
    this.obstacles.push({ x: tx - 0.5, z: tz, r: 0.5 }, { x: tx + 0.5, z: tz, r: 0.5 });
    const onTable = (name, dx, dz, yaw, size) => {
      if (!models[name]) return;
      const m = fitModel(models[name], { size, axis: 'xz' });
      m.position.set(tx + dx, topY + 0.005, tz + dz); m.rotation.y = yaw;
      m.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      this.scene.add(m);
    };
    onTable('ski_goggles', -0.62, -0.12, 0.3, 0.22);
    onTable('ski_goggles', -0.3, 0.16, -0.2, 0.22);
    onTable('beanie', 0.05, -0.1, 0.4, 0.26);
    onTable('beanie', 0.38, 0.15, -0.5, 0.26);
    onTable('ski_glove', 0.7, -0.12, 1.1, 0.28);
  }

  // The OUTFITS corner: a wooden podium in front of a red-painted panel with the OUTFITS lettering in a
  // carved frame, a lantern-light on it, and one hit area over the whole corner (rails and helmet shelf too).
  buildOutfitCorner() {
    const x0 = -W / 2;
    const c = canvasTexture(512, 768, (g, w, h) => {
      const grad = g.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, '#9a2c22'); grad.addColorStop(1, '#6e1d16');
      g.fillStyle = grad; g.fillRect(0, 0, w, h);
      const r = rng(17);
      for (let i = 0; i < 900; i++) { g.fillStyle = `rgba(0,0,0,${r() * 0.07})`; g.fillRect(r() * w, r() * h, 1 + r() * 8, 1); }
      // painted border with little hearts in the corners (Bauernmalerei)
      g.strokeStyle = '#e8d3a2'; g.lineWidth = 6; g.strokeRect(26, 26, w - 52, h - 52);
      g.lineWidth = 2; g.strokeRect(40, 40, w - 80, h - 80);
      g.fillStyle = '#e8d3a2';
      for (const [hx, hy] of [[40, 40], [w - 40, 40], [40, h - 40], [w - 40, h - 40]]) {
        g.beginPath(); g.moveTo(hx, hy + 9); g.bezierCurveTo(hx - 14, hy - 2, hx - 6, hy - 14, hx, hy - 5); g.bezierCurveTo(hx + 6, hy - 14, hx + 14, hy - 2, hx, hy + 9); g.fill();
      }
      g.textAlign = 'center'; g.textBaseline = 'middle';
      fitFont(g, 'OUTFITS', w * 0.72, 104, '700', SERIF);
      if ('letterSpacing' in g) g.letterSpacing = '6px';
      g.shadowColor = 'rgba(0,0,0,0.4)'; g.shadowOffsetY = 2;
      g.fillText('OUTFITS', w / 2, 130);
      g.shadowColor = 'transparent';
      g.font = `italic 26px ${SERIF}`; if ('letterSpacing' in g) g.letterSpacing = '2px';
      g.fillText('Jackets · Helmets · Goggles', w / 2, 196);
    }, { text: true });
    this.textures.push(c);
    const panel = new THREE.Mesh(new THREE.BoxGeometry(0.05, 3.0, 2.2), new THREE.MeshStandardMaterial({ map: c, roughness: 0.7 }));
    panel.position.set(x0 + 0.03, 1.62, PODIUM.z);
    panel.receiveShadow = true;
    this.scene.add(panel);
    for (const [h, d, y, z] of [[0.1, 2.36, 3.15, PODIUM.z], [3.0, 0.1, 1.62, PODIUM.z - 1.13], [3.0, 0.1, 1.62, PODIUM.z + 1.13]]) {
      const f = new THREE.Mesh(new THREE.BoxGeometry(0.1, h, d), this.darkWood);
      f.position.set(x0 + 0.07, y, z);
      f.castShadow = true;
      this.scene.add(f);
    }
    // podium: an old round platform of honey-coloured boards with a dark rim
    const top = new THREE.Mesh(new THREE.CylinderGeometry(0.66, 0.66, 0.1, 48), this.honey);
    top.position.set(PODIUM.x, PODIUM.y - 0.05, PODIUM.z);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.62, 0.07, 48), this.beam);
    base.position.set(PODIUM.x, 0.035, PODIUM.z);
    for (const m of [top, base]) { m.castShadow = true; m.receiveShadow = true; this.scene.add(m); }
    // a lantern on an iron bracket lights the corner
    const can = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.11, 0.18, 12), this.iron);
    can.position.set(PODIUM.x + 0.9, H - 0.55, PODIUM.z);
    can.rotation.z = -0.55;
    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.075, 16), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffc37a, emissiveIntensity: 3 }));
    lens.position.set(0, -0.091, 0); lens.rotation.x = Math.PI / 2;
    can.add(lens);
    this.scene.add(can);
    const key = new THREE.SpotLight(0xffd7a0, 14, 7, 0.6, 0.6, 1.5);
    key.position.copy(can.position);
    key.target.position.set(PODIUM.x, 1.0, PODIUM.z);
    this.scene.add(key, key.target);
    this.obstacles.push({ x: PODIUM.x, z: PODIUM.z, r: 0.72 });
    // look anywhere at the corner: podium, backdrop, both rails, the helmet shelf
    const hit = (w, h, d, x, y, z) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), HITBOX); m.position.set(x, y, z); m.userData.kind = 'outfits'; this.scene.add(m); return m; };
    this.outfitHits = [hit(1.9, 2.9, 6.4, x0 + 0.95, 1.45, -0.45), hit(2.4, 2.1, 0.8, x0 + 1.25, 1.05, D / 2 - 0.42)];
  }

  // ------------------------------------------------------------------ the view outside
  /** Where the shop stands in the world (see the constructor's `outside`). */
  setOutside(o) {
    this.outside = o && o.scene && o.door && o.front ? o : null;
    if (!this.outside) return;
    const f = _v.copy(o.front).setY(0).normalize();
    const yaw = Math.atan2(f.x, f.z);
    // the glass sits on the facade (the door point is 1.6 m in front of it); room +z = the way the shop faces
    const facade = o.door.clone().addScaledVector(f, -1.4);
    const gy = world.groundHeight(o.door.x, o.door.z);
    this.toWorld = new THREE.Matrix4().compose(new THREE.Vector3(facade.x, gy, facade.z), new THREE.Quaternion().setFromAxisAngle(UP, yaw), new THREE.Vector3(1, 1, 1))
      .multiply(new THREE.Matrix4().makeTranslation(0, 0, -D / 2));
    this.portalCam = new THREE.PerspectiveCamera(70, 1, 0.1, 30000);
    this.lastShadow = 0;
  }

  // Props standing right in front of the shop (its signboard, ski racks, benches, lamps) would fill the
  // glass: they stay out of the window view so it opens onto the plaza and the mountains.
  nearClutter() {
    if (this._near) return this._near;
    const o = this.outside, list = [];
    const fx = o.front.x, fz = o.front.z, fl = Math.hypot(fx, fz) || 1, f = [fx / fl, fz / fl];
    const P = new THREE.Vector3(), size = new THREE.Vector3(), box = new THREE.Box3();
    const near = (obj) => {
      obj.getWorldPosition(P);
      const rx = P.x - o.door.x, rz = P.z - o.door.z;
      const a = rx * f[0] + rz * f[1], b = -rx * f[1] + rz * f[0];
      return a > -3 && a < 7.5 && Math.abs(b) < 8.5;
    };
    const small = (obj) => { box.setFromObject(obj); box.getSize(size); return Math.max(size.x, size.z) < 9 && size.y < 12; };
    const skip = (obj) => obj.isInstancedMesh || obj.isPoints || obj.isLine || obj.isSprite || obj.isLight || obj.isCamera;
    for (const t of o.scene.children) {
      if (skip(t)) continue;
      if (t.children.length < 2) { if (near(t) && small(t)) list.push(t); continue; }
      for (const c of t.children) if (!skip(c) && near(c) && small(c)) list.push(c);
    }
    return (this._near = list);
  }

  releasePortal() {
    if (this.portalRT) { this.portalRT.dispose(); this.portalRT = null; }
    this.portalMat.uniforms.tView.value = null;
    this.portalMat.uniforms.uHas.value = 0;
    dropPortal(this);
  }

  // Render the village from the matching spot outside into the storefront's view (only while the glass is
  // in view). The world's shadows are refreshed every few seconds, not every frame.
  renderPortal() {
    const o = this.outside, r = this.renderer;
    if (!o || !r || this.portalOff) return; // (portalOff: switched off for this session after slow frames, as the chalets')
    const cam = this.camera;
    cam.updateMatrixWorld();
    _m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_m);
    _box.setFromObject(this.portalMesh);
    if (!_frustum.intersectsBox(_box)) return;
    claimPortal(this); // (one live window view at a time: game/liveportal.js)
    const size = r.getDrawingBufferSize(_size);
    const k = Math.min(1, 1800 / Math.max(1, size.x)); // a 1440p-class view is plenty for the glass
    const w = Math.max(64, Math.round(size.x * k)), h = Math.max(64, Math.round(size.y * k));
    if (!this.portalRT) {
      this.portalRT = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: true, stencilBuffer: false });
      this.portalMat.uniforms.tView.value = this.portalRT.texture;
      this.lastShadow = 0;
    } else if (this.portalRT.width !== w || this.portalRT.height !== h) this.portalRT.setSize(w, h);
    // the outside camera: yours, carried to where the shop stands; its near plane skips the shop's own footprint
    const pc = this.portalCam;
    _m.multiplyMatrices(this.toWorld, cam.matrixWorld).decompose(pc.position, pc.quaternion, _s);
    const toGlass = Math.max(0, D / 2 - cam.position.z);
    pc.fov = cam.fov; pc.aspect = cam.aspect;
    pc.near = Math.max(0.1, toGlass * 0.45);
    pc.far = 30000;
    pc.updateProjectionMatrix();
    const hidden = [...(o.hide?.() || []), ...this.nearClutter()];
    const was = hidden.map((h) => h && h.visible);
    for (const h of hidden) if (h) h.visible = false;
    const prev = r.getRenderTarget(), auto = r.shadowMap.autoUpdate, now = performance.now();
    r.shadowMap.autoUpdate = false;
    r.shadowMap.needsUpdate = now - this.lastShadow > 3000;
    if (r.shadowMap.needsUpdate) this.lastShadow = now;
    try {
      const t0 = performance.now();
      r.setRenderTarget(this.portalRT);
      r.clear();
      r.render(o.scene, pc);
      this.portalMat.uniforms.uHas.value = 1;
      // a slow machine: the view out costing over ~45 ms again and again switches it off (a soft sky instead)
      const ms = performance.now() - t0;
      this.portalSlow = ms > 45 ? (this.portalSlow || 0) + 1 : Math.max(0, (this.portalSlow || 0) - 1);
      if (this.portalSlow > 6) { this.portalOff = true; this.portalMat.uniforms.uHas.value = 0; console.warn('shop windows: live view off (slow)'); }
    } catch (e) {
      console.warn('Shop window view failed', e);
      this.outside = null;
      this.portalMat.uniforms.uHas.value = 0;
    } finally {
      r.setRenderTarget(prev);
      r.shadowMap.autoUpdate = auto;
      r.shadowMap.needsUpdate = false;
      hidden.forEach((h, i) => { if (h) h.visible = was[i]; });
    }
  }

  // daylight through the windows follows the sun outside (soft at dawn and dusk, off at night); the lanterns
  // glow a little brighter after dark, the stove flickers and the wall clock keeps the game's time
  updateLight() {
    const env = this.outside?.env;
    const day = env ? env.dayFactor ?? 1 : 1, night = env ? env.nightFactor ?? 0 : 0;
    const cloud = env ? Math.min(1, env.cloud ?? 0) : 0;
    this.daylight.intensity = 3.2 * day * (1 - cloud * 0.55);
    if (env?.sun?.color) this.daylight.color.copy(env.sun.color).lerp(_c.set(0xfff1dc), 0.55);
    this.hemi.intensity = 0.4 + 0.25 * day;
    for (const L of this.lamps) L.intensity = 5 + night * 1.5;
    const t = performance.now() * 0.001;
    const flick = 0.85 + Math.sin(t * 7.3) * 0.08 + Math.sin(t * 13.1 + 1.7) * 0.05 + Math.sin(t * 2.1) * 0.04;
    if (this.fire) this.fire.intensity = 1.2 * flick;
    for (const f of this.flames) f.material.emissiveIntensity = (f.material.userData.base ??= f.material.emissiveIntensity) * flick;
    if (this.clock && env) {
      const h = env.hour;
      this.clock.hour.rotation.z = -((h % 12) / 12) * Math.PI * 2;
      this.clock.minute.rotation.z = -(h % 1) * Math.PI * 2;
    }
  }

  // ------------------------------------------------------------------ podium skier + outfit view
  // Your skier on the podium (dressed as equipped; the outfit shop previews on it).
  ensureMannequin() {
    const id = this.getCharacter?.();
    if (!id || !this.makeCharRig) return null;
    if (this.mannequin && this.mannequinChar === id) return this.mannequin;
    if (this.mannequin) this.mannequin.removeFrom(this.scene);
    let rig = null;
    try { rig = this.makeCharRig(id); } catch (e) { console.warn('No podium skier', e); }
    if (!rig) return null;
    rig.setSkisVisible?.(false);
    rig.setCarry?.(false);
    rig.addTo(this.scene);
    rig.root.position.copy(PODIUM);
    this.mannequin = rig;
    this.mannequinChar = id;
    this.mannequinLift = PODIUM.y - world.groundHeight(PODIUM.x, PODIUM.z); // the pose stands on the terrain under the shop
    this.mannequinYaw = Math.PI / 2 + 0.3;
    return rig;
  }

  /** Dress the podium skier: equipped ids, a look, or null (original clothes). */
  previewOutfit(outfit) {
    const rig = this.ensureMannequin();
    if (rig) applyOutfit(rig, this.mannequinChar, outfit);
  }

  /** Garment zones of the podium skier's model ({ jacket, ..., lens } flags), null when unknown. */
  mannequinZones() {
    const rig = this.ensureMannequin();
    return rig ? outfitZones(rig) : null;
  }

  // Outfit view: the camera swings from your eyes to a framing of the podium (skier on the right of the
  // screen, the panel on the left) and back when the shop closes.
  outfitView(on) {
    if (on) {
      this.ensureMannequin();
      this.view = { t: 0, on: true, spin: 0, from: { pos: this.camera.position.clone(), quat: this.camera.quaternion.clone(), fov: this.camera.fov } };
    } else if (this.view) {
      this.view.on = false;
      this.view.back = { pos: this.camera.position.clone(), quat: this.camera.quaternion.clone(), fov: this.camera.fov };
      this.view.t = 0;
    }
  }

  spinMannequin(d) { if (this.view) this.view.spin += d; }

  // Talking to the clerk: the same conversation look as outside (talk.js): the camera eases in to a portrait
  // of the clerk across the counter, the clerk turns to you, cinema bars slide in and the dialog card sits on
  // the left. main.js opens the dialog; the view ends by itself when the dialog closes.
  talkView(on) {
    const bars = typeof document !== 'undefined' ? document.getElementById('talk-bars') : null;
    if (on) {
      this.view = { kind: 'talk', t: 0, on: true, spin: 0, from: { pos: this.camera.position.clone(), quat: this.camera.quaternion.clone(), fov: this.camera.fov } };
      bars?.classList.add('on');
      document.getElementById('panel')?.classList.add('talk');
      const hud = document.getElementById('hud');
      hud?.classList.remove('talk-show'); hud?.classList.add('talk-hide');
    } else if (this.view?.kind === 'talk' && this.view.on) {
      this.view.on = false;
      this.view.back = { pos: this.camera.position.clone(), quat: this.camera.quaternion.clone(), fov: this.camera.fov };
      this.view.t = 0;
      bars?.classList.remove('on');
      document.getElementById('panel')?.classList.remove('talk', 'talk-right');
      const hud = document.getElementById('hud');
      hud?.classList.remove('talk-hide'); hud?.classList.add('talk-show');
    }
  }

  // portrait of the clerk from across the counter: the face on the right third, a little above centre
  talkCameraPose(outPos, outQuat) {
    const c = this.clerk.root.position, fov = 38;
    const face = _v.set(c.x, 1.6, c.z);
    outPos.set(c.x - 2.05, 1.58, c.z - 0.55);
    const fwd = face.clone().sub(outPos).normalize();
    const half = Math.atan(Math.tan(THREE.MathUtils.degToRad(fov / 2)) * this.camera.aspect);
    fwd.applyAxisAngle(UP, Math.atan(Math.min(0.4, 0.24 * this.camera.aspect) * Math.tan(half)));
    outQuat.setFromRotationMatrix(new THREE.Matrix4().lookAt(outPos, outPos.clone().add(fwd), UP));
    return fov;
  }

  /** The outfit shop that opens from the OUTFITS corner (until one is attached the corner is just decor). */
  attachOutfitShop(shop) { this.outfitShop = shop; this.aimables = null; }

  // camera pose that frames the podium with the skier at ~68% of the screen width
  outfitCameraPose(outPos, outQuat) {
    const aspect = this.camera.aspect;
    const fov = 40;
    const focus = _v.set(PODIUM.x, PODIUM.y + 0.86, PODIUM.z);
    const dir = _w.set(1, 0, 0.22).normalize();
    outPos.copy(focus).addScaledVector(dir, 3.45).add(new THREE.Vector3(0, 0.3, 0));
    const fwd = focus.clone().sub(outPos).normalize();
    const half = Math.atan(Math.tan(THREE.MathUtils.degToRad(fov / 2)) * aspect);
    const shift = Math.atan(Math.min(0.36, 0.22 * aspect) * Math.tan(half)); // narrower windows shift less
    fwd.applyAxisAngle(UP, shift);
    const m = new THREE.Matrix4().lookAt(outPos, outPos.clone().add(fwd), UP);
    outQuat.setFromRotationMatrix(m);
    return fov;
  }

  enter() {
    this.active = true;
    this.pos.set(0, 0, D / 2 - 1.4);
    this.yaw = Math.PI; this.pitch = -0.05;
    this.vel.set(0, 0, 0);
    this.view = null;
    this.lastShadow = 0;
    this._near = null;
    this.refreshPlaques();
    this.plaqueT = 0;
    // your skier, dressed as equipped, waits on the podium
    if (this.ensureMannequin()) this.previewOutfit(this.getOutfit?.(this.mannequinChar) || null);
  }

  // podium skier: relaxed standing pose, turned to the camera in the outfit view (drag spins it)
  poseMannequin(dt) {
    const rig = this.mannequin;
    if (!rig) return;
    let heading = Math.PI / 2 - 0.3;
    if (this.view && this.view.kind !== 'talk') {
      const c = this.camera.position;
      const toCam = Math.atan2(c.x - PODIUM.x, c.z - PODIUM.z) + 0.38;
      const k = this.view.on ? THREE.MathUtils.smoothstep(this.view.t, 0, 0.5) : 1 - THREE.MathUtils.smoothstep(this.view.t, 0, 0.5);
      heading = heading + (toCam - heading) * k + this.view.spin * k;
    }
    this.mannequinYaw += Math.atan2(Math.sin(heading - this.mannequinYaw), Math.cos(heading - this.mannequinYaw)) * (1 - Math.exp(-dt * 6));
    rig.update(dt, { mode: 'idle', heading: this.mannequinYaw, speed: 0, crouch: 0, lean: 0, plow: 0, normal: UP, airY: this.mannequinLift });
  }

  // camera during the outfit view and its way back to your eyes
  updateView(dt) {
    const v = this.view;
    v.t += dt;
    const pos = new THREE.Vector3(), quat = new THREE.Quaternion();
    const fov = v.kind === 'talk' ? this.talkCameraPose(pos, quat) : this.outfitCameraPose(pos, quat);
    const k = THREE.MathUtils.smoothstep(v.t, 0, 0.65);
    if (v.on) {
      this.camera.position.lerpVectors(v.from.pos, pos, k);
      this.camera.quaternion.slerpQuaternions(v.from.quat, quat, k);
      this.camera.fov = v.from.fov + (fov - v.from.fov) * k;
    } else {
      const eye = new THREE.Vector3(this.pos.x, EYE, this.pos.z);
      const dir = new THREE.Vector3(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), Math.cos(this.yaw) * Math.cos(this.pitch));
      const back = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(eye, eye.clone().add(dir), UP));
      this.camera.position.lerpVectors(v.back.pos, eye, k);
      this.camera.quaternion.slerpQuaternions(v.back.quat, back, k);
      this.camera.fov = v.back.fov + (70 - v.back.fov) * k;
      if (k >= 1) this.view = null;
    }
    this.camera.updateProjectionMatrix();
  }

  // returns null or an action describing what the crosshair is on
  update(dt, input, sensitivity = 1) {
    this.poseMannequin(dt);
    this.updateLight();
    this.plaqueT = (this.plaqueT || 0) + dt;
    if (this.plaqueT > 0.4) { this.plaqueT = 0; this.refreshPlaques(); }
    if (this.view) { // the outfit shop / a conversation has the camera: no walking, nothing to aim at
      if (this.view.kind === 'talk' && this.view.on && document.getElementById('panel')?.hidden) this.talkView(false);
      this.updateView(dt);
      // in a conversation the clerk turns to you
      const c = this.clerk.root.position, cam = this.camera.position;
      const want = this.view?.kind === 'talk' && this.view.on ? Math.atan2(cam.x - c.x, cam.z - c.z) : -Math.PI / 2; // (updateView may have ended the view)
      this.clerkYaw = (this.clerkYaw ?? -Math.PI / 2) + Math.atan2(Math.sin(want - (this.clerkYaw ?? -Math.PI / 2)), Math.cos(want - (this.clerkYaw ?? -Math.PI / 2))) * (1 - Math.exp(-dt * 5));
      this.clerk.update(dt, { mode: 'idle', heading: this.clerkYaw, speed: 0, crouch: 0, lean: 0, plow: 0, normal: UP });
      this.renderPortal();
      return null;
    }
    const sens = 0.0022 * sensitivity;
    this.yaw -= input.mdx * sens;
    this.pitch = Math.max(-1.3, Math.min(1.2, this.pitch - input.mdy * sens));
    const fw = (input.down('KeyW') ? 1 : 0) - (input.down('KeyS') ? 1 : 0);
    const st = (input.down('KeyD') ? 1 : 0) - (input.down('KeyA') ? 1 : 0);
    const f = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const r = new THREE.Vector3(-f.z, 0, f.x);
    const want = f.multiplyScalar(fw).addScaledVector(r, st);
    if (want.lengthSq()) want.normalize().multiplyScalar(2.2);
    this.vel.lerp(want, 1 - Math.exp(-dt * 10));
    this.pos.addScaledVector(this.vel, dt);
    // furniture first, then the counter and the walls (a push off a plant can never put you through a wall)
    for (const o of this.obstacles) {
      const dx = this.pos.x - o.x, dz = this.pos.z - o.z, d = Math.hypot(dx, dz), rr = o.r + 0.3;
      if (d < rr && d > 1e-4) { this.pos.x = o.x + (dx / d) * rr; this.pos.z = o.z + (dz / d) * rr; }
    }
    const c = this.counterBox;
    if (this.pos.x > c.minX - 0.35 && this.pos.z > c.minZ && this.pos.z < c.maxZ) this.pos.x = c.minX - 0.35;
    this.pos.x = Math.max(-W / 2 + 0.4, Math.min(W / 2 - 0.4, this.pos.x));
    this.pos.z = Math.max(-D / 2 + 0.65, Math.min(D / 2 - 0.4, this.pos.z));

    this.camera.position.set(this.pos.x, EYE + Math.sin(this.pos.x * 2 + this.pos.z * 2) * 0.01, this.pos.z);
    const dir = new THREE.Vector3(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), Math.cos(this.yaw) * Math.cos(this.pitch));
    this.camera.lookAt(this.camera.position.clone().add(dir));

    this.clerkYaw = (this.clerkYaw ?? -Math.PI / 2) + Math.atan2(Math.sin(-Math.PI / 2 - (this.clerkYaw ?? -Math.PI / 2)), Math.cos(-Math.PI / 2 - (this.clerkYaw ?? -Math.PI / 2))) * (1 - Math.exp(-dt * 5));
    this.clerk.update(dt, { mode: 'idle', heading: this.clerkYaw, speed: 0, crouch: 0, lean: 0, plow: 0, normal: UP });
    this.renderPortal();

    // what is the player looking at?
    const ray = new THREE.Raycaster(this.camera.position, dir, 0, 6);
    // the things you can aim at, collected once (rebuilt when the outfit shop attaches)
    this.aimables ||= [...this.displays, this.doorHit, this.clerkHit, ...(this.outfitShop ? this.outfitHits : [])];
    const hits = ray.intersectObjects(this.aimables, true);
    let target = null;
    if (hits.length) {
      let o = hits[0].object;
      while (o && !o.userData.kind) o = o.parent;
      if (o) target = o;
    }
    // highlight the hovered skis
    for (const d of this.displays) {
      const on = d === target;
      d.traverse((m) => { if (m.isMesh && m.material !== HITBOX) m.material.emissive?.setHex(on ? 0x2a2a2a : 0x000000); });
    }
    if (!target) return null;
    const kind = target.userData.kind;
    if (kind === 'door') return { kind, label: 'Leave the shop' };
    if (kind === 'clerk') return { kind, label: 'Talk to the shop clerk' };
    if (kind === 'outfits') {
      // the outfit shop opens right here (main.js only needs to know about skis, the door and the clerk)
      if (input.hit?.('KeyE')) { this.outfitShop.open(); return null; }
      return { kind, label: 'Outfits · jackets, helmets, goggles' };
    }
    const s = this.getSkiState(target.userData.id);
    const label = s.equipped ? `${target.userData.name} · equipped`
      : s.owned ? `Equip ${target.userData.name}`
      : `${s.rent ? 'Rent' : 'Buy'} ${target.userData.name} · $${s.price}${s.canAfford ? '' : ' (not enough money)'}`;
    return { kind, id: target.userData.id, label, disabled: s.equipped || (!s.owned && !s.canAfford) };
  }
}

const _c = new THREE.Color();
