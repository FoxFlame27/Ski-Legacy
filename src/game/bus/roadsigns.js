// The road signs (speedlimits.js plans them): Swiss style, a round speed limit sign (red ring, black figures) where
// the limit changes and red-bordered warning triangles before sharp bends, hairpins, winding stretches and steep
// grades, each on a galvanised post on the traffic's right, 1.9 m outside the plowed edge, facing the traffic it is
// for. Cheap: one canvas atlas with every face (and the grey backs), ONE instanced mesh for all the panels (a cell of
// the atlas per instance) and one for the posts; thin soft colliders (you bump and slide off, as off a snow pole).
import * as THREE from 'three';
import { world } from '../../world/world.js';
import { planRoadSigns } from './speedlimits.js';

const COLS = 6, ROWS = 4, CELL = 256;
const CELLS = ['30', '40', '50', '60', '80', '100', '120', 'curveL', 'curveR', 'hairpinL', 'hairpinR', 'windL', 'windR', 'steepDown8', 'steepDown10', 'steepDown12', 'steepUp8', 'steepUp10', 'steepUp12', 'backRound', 'backTri'];
const PANEL = 0.9;          // m: the panel's square (the round sign 0.8 m across, the triangle 0.9 m a side)
const PANEL_Y = 2.05;       // m over the road: the panel's centre

function drawAtlas() {
  const cv = document.createElement('canvas');
  cv.width = COLS * CELL; cv.height = ROWS * CELL;
  const g = cv.getContext('2d');
  const C = CELL / 2;
  const tri = (pad) => { // an equilateral triangle, point up, rounded corners
    const R = C - pad, h = R * 1.5, w = h / Math.sqrt(3);
    const top = C - R, bot = top + h * 1.1;
    g.beginPath(); g.moveTo(C, top); g.lineTo(C + w * 1.1, bot); g.lineTo(C - w * 1.1, bot); g.closePath();
  };
  const triSign = () => {
    g.lineJoin = 'round';
    tri(14); g.fillStyle = '#c8102e'; g.fill(); g.lineWidth = 18; g.strokeStyle = '#c8102e'; g.stroke();
    tri(44); g.fillStyle = '#ffffff'; g.fill(); g.lineWidth = 8; g.strokeStyle = '#ffffff'; g.stroke();
  };
  const arrow = (pts, head = true) => { // a thick black pictogram line, an arrowhead at its end
    g.strokeStyle = '#111'; g.fillStyle = '#111'; g.lineWidth = 15; g.lineCap = 'round'; g.lineJoin = 'round';
    g.beginPath(); g.moveTo(pts[0][0], pts[0][1]);
    if (pts.length === 4) g.bezierCurveTo(pts[1][0], pts[1][1], pts[2][0], pts[2][1], pts[3][0], pts[3][1]);
    else for (const p of pts.slice(1)) g.lineTo(p[0], p[1]);
    g.stroke();
    if (!head) return;
    const [ax, ay] = pts[pts.length - 2], [bx, by] = pts[pts.length - 1], a = Math.atan2(by - ay, bx - ax), L = 26;
    g.beginPath(); g.moveTo(bx + Math.cos(a) * 12, by + Math.sin(a) * 12);
    g.lineTo(bx + Math.cos(a + 2.5) * L, by + Math.sin(a + 2.5) * L); g.lineTo(bx + Math.cos(a - 2.5) * L, by + Math.sin(a - 2.5) * L); g.closePath(); g.fill();
  };
  CELLS.forEach((name, k) => {
    const cx = (k % COLS) * CELL, cy = Math.floor(k / COLS) * CELL;
    g.save(); g.translate(cx, cy);
    g.beginPath(); g.rect(0, 0, CELL, CELL); g.clip();
    const mir = name.endsWith('L') ? -1 : 1;
    if (/^\d+$/.test(name)) {
      g.beginPath(); g.arc(C, C, C - 18, 0, Math.PI * 2); g.fillStyle = '#c8102e'; g.fill();
      g.beginPath(); g.arc(C, C, C - 46, 0, Math.PI * 2); g.fillStyle = '#ffffff'; g.fill();
      g.fillStyle = '#111'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.font = `bold ${name.length > 2 ? 78 : 100}px Arial, Helvetica, sans-serif`;
      g.fillText(name, C, C + 6);
    } else if (name === 'backRound') {
      g.beginPath(); g.arc(C, C, C - 18, 0, Math.PI * 2); g.fillStyle = '#8d9196'; g.fill();
    } else if (name === 'backTri') {
      g.lineJoin = 'round'; tri(14); g.fillStyle = '#8d9196'; g.fill(); g.lineWidth = 18; g.strokeStyle = '#8d9196'; g.stroke();
    } else {
      triSign();
      g.save(); g.translate(C, 0); g.scale(mir, 1); g.translate(-C, 0); // (the left-hand ones mirrored)
      if (name.startsWith('curve')) arrow([[C - 14, 196], [C - 14, 140], [C - 10, 112], [C + 30, 96]]);
      else if (name.startsWith('hairpin')) arrow([[C - 22, 198], [C - 22, 96], [C + 34, 82], [C + 34, 150]]);
      else if (name.startsWith('wind')) arrow([[C - 24, 200], [C + 46, 160], [C - 52, 130], [C + 18, 84]]);
      g.restore();
      if (name.startsWith('steep')) {
        const down = name.startsWith('steepDown'), pct = name.replace(/\D/g, '');
        g.fillStyle = '#111';
        g.beginPath(); // the slope: high on the left going down, high on the right going up
        if (down) { g.moveTo(C - 50, 136); g.lineTo(C + 52, 190); g.lineTo(C - 50, 190); } else { g.moveTo(C + 50, 136); g.lineTo(C - 52, 190); g.lineTo(C + 50, 190); }
        g.closePath(); g.fill();
        g.font = 'bold 40px Arial, Helvetica, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(`${pct}%`, C + (down ? 14 : -14), 116);
      }
    }
    g.restore();
  });
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

const cellOf = (s) => {
  if (s.kind === 'limit') return CELLS.indexOf(String(s.val));
  if (s.kind === 'steepDown' || s.kind === 'steepUp') return CELLS.indexOf(`${s.kind}${s.val}`);
  return CELLS.indexOf(s.kind);
};

/** The signs along every road into group (+ their colliders). Returns the plan (for the HUD / debugging). */
export function buildRoadSigns(group, colliders = null) {
  // (never on top of a prop already standing there: a give-way sign, a bench, a lamp; the guardrails' thin boxes are
  // in front of the signs' line and don't count)
  const busy = (x, z) => (colliders || []).some((c) => !c.rail && !c.traffic && Number.isFinite(c.x) && Math.abs(c.x - x) < 6 && Math.abs(c.z - z) < 6
    && Math.hypot(c.x - x, c.z - z) < 0.9 + (c.r ?? Math.min(2.5, Math.max(c.hw || 0, c.hd || 0))));
  const plan = planRoadSigns().filter((s) => cellOf(s) >= 0 && !busy(s.x, s.z));
  if (!plan.length || typeof document === 'undefined') return plan;
  const MH = (x, z) => (world.meshHeight ? world.meshHeight(x, z) : world.height(x, z));
  const tex = drawAtlas();
  const mat = new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.5, roughness: 0.55, metalness: 0.05 });
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aCell;')
      .replace('#include <uv_vertex>', `#include <uv_vertex>\n  vMapUv = vMapUv * vec2(${(1 / COLS).toFixed(6)}, ${(1 / ROWS).toFixed(6)}) + aCell;`);
    // (retroreflective sheeting: a little of its own colour in the dark)
    sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += diffuseColor.rgb * 0.12;');
  };
  mat.customProgramCacheKey = () => 'roadsign-atlas';
  const geo = new THREE.PlaneGeometry(PANEL, PANEL);
  const n = plan.length * 2, im = new THREE.InstancedMesh(geo, mat, n), cells = new Float32Array(n * 2);
  const posts = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.035, 0.035, 1, 6).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.4, metalness: 0.6 }), plan.length);
  const o = new THREE.Object3D();
  const setCell = (k, c) => { cells[k * 2] = (c % COLS) / COLS; cells[k * 2 + 1] = 1 - (Math.floor(c / COLS) + 1) / ROWS; };
  plan.forEach((s, k) => {
    const ground = MH(s.x, s.z), top = s.y0 + PANEL_Y, fx = Math.sin(s.yaw), fz = Math.cos(s.yaw);
    const round = s.kind === 'limit';
    // the face toward the traffic, the grey back 1.5 cm behind it
    o.position.set(s.x, top, s.z); o.rotation.set(0, s.yaw, 0); o.scale.set(1, 1, 1); o.updateMatrix();
    im.setMatrixAt(k * 2, o.matrix); setCell(k * 2, cellOf(s));
    o.position.set(s.x - fx * 0.015, top, s.z - fz * 0.015); o.rotation.set(0, s.yaw + Math.PI, 0); o.updateMatrix();
    im.setMatrixAt(k * 2 + 1, o.matrix); setCell(k * 2 + 1, CELLS.indexOf(round ? 'backRound' : 'backTri'));
    // the post: from 0.3 m in the ground to the panel's middle, just behind it
    const y0 = Math.min(ground, s.y0) - 0.3;
    o.position.set(s.x - fx * 0.05, y0, s.z - fz * 0.05); o.rotation.set(0, 0, 0); o.scale.set(1, Math.max(0.5, top + 0.1 - y0), 1); o.updateMatrix();
    posts.setMatrixAt(k, o.matrix);
    colliders?.push({ x: s.x, z: s.z, r: 0.08, h: PANEL_Y + 0.45, top: top + 0.45, soft: true, pole: true });
  });
  geo.setAttribute('aCell', new THREE.InstancedBufferAttribute(cells, 2));
  im.name = 'road-signs'; posts.name = 'road-sign-posts';
  posts.castShadow = true; // (the panels' alpha cut-out would cast a square shadow: none)
  im.computeBoundingSphere?.(); posts.computeBoundingSphere?.();
  group.add(im, posts);
  return plan;
}
