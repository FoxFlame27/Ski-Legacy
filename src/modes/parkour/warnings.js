// Turn warnings: yellow chevron boards on the outside of every real bend of a course, so no turn comes as
// a surprise (race team, Oct 26: "way clearer where to go"), and STEEP boards on both sides before a pitch
// you cannot see over. Boards hang on the B-net like its sponsor boards (flat in front of the net, turned
// 15 deg toward the racers coming down), between the piste edge and the net where nobody skis; three per
// bend from its entry to the apex. Bends inside tunnels, on bridges and in the finish arena get none.
import * as THREE from 'three';
import { canvasTexture, meshGround, FONT } from './kit.js';
import { BARRIER, DS } from './track.js';

const MIN_ANGLE = 24 * Math.PI / 180; // a bend turning less than this needs no warning
const MAX_R = 320;                    // m: only real bends (gentle sweeps need none)
const BOARD_W = 1.25, BOARD_H = 0.68, BOARD_LIFT = 0.85; // m (on the 2.1 m B-net)
const TOE = 15 * Math.PI / 180; // boards turned this much from the net toward the oncoming racers
const SKIP = new Set([BARRIER.tunnel, BARRIER.railing, BARRIER.arena, BARRIER.none]);

function chevronTex(dir) {
  return canvasTexture(256, 136, (g, w, h) => {
    g.fillStyle = '#ffd21f'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#141414';
    g.fillRect(0, 0, w, 9); g.fillRect(0, h - 9, w, 9);
    // three chevrons pointing the way the course turns
    for (let k = 0; k < 3; k++) {
      const cx = 52 + k * 76;
      g.beginPath();
      if (dir > 0) { g.moveTo(cx - 26, 24); g.lineTo(cx + 16, h / 2); g.lineTo(cx - 26, h - 24); g.lineTo(cx - 4, h - 24); g.lineTo(cx + 38, h / 2); g.lineTo(cx - 4, 24); }
      else { g.moveTo(cx + 26, 24); g.lineTo(cx - 16, h / 2); g.lineTo(cx + 26, h - 24); g.lineTo(cx + 4, h - 24); g.lineTo(cx - 38, h / 2); g.lineTo(cx + 4, 24); }
      g.closePath(); g.fill();
    }
  });
}

function steepTex() {
  return canvasTexture(256, 136, (g, w, h) => {
    g.fillStyle = '#ffd21f'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#141414';
    g.fillRect(0, 0, w, 9); g.fillRect(0, h - 9, w, 9);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = `italic 700 74px ${FONT}`;
    g.fillText('STEEP', w / 2, h / 2 + 3);
  });
}

/** Where the slope steepens sharply (a crest you cannot see over): [{ s }] a little before the pitch. */
export function findSteeps(course) {
  const T = course.track, out = [];
  const busy = (s) => course.features.some((f) => ['kicker', 'tabletop', 'roller'].includes(f.type) && s > f.s0 - 50 && s < (f.land1 ?? f.s1) + 10);
  for (let s = 70; s < course.finishS - 90; s += 2) {
    const g = T.gradeAt(s);
    if (g < 0.27) continue;
    let gPrev = Infinity;
    for (let b = s - 50; b < s - 8; b += 4) gPrev = Math.min(gPrev, T.gradeAt(Math.max(0, b)));
    if (gPrev > 0.2 || busy(s)) continue;
    if (out.length && s - out[out.length - 1].s < 200) continue;
    out.push({ s: Math.max(40, s - 30) });
  }
  return out;
}

/** Bends of a track: [{ s0, s1, apex, dir (+1 right, -1 left), angle }] */
export function findBends(T, s1Max = Infinity) {
  const out = [];
  let run = null;
  const flush = () => {
    if (run && run.angle >= MIN_ANGLE) out.push(run);
    run = null;
  };
  for (let i = 0; i < T.n; i++) {
    const k = T.K[i], s = i * DS;
    if (s > s1Max) break;
    const dir = k < 0 ? 1 : -1; // K < 0 = right turn (heading decreases)
    if (Math.abs(k) < 1 / MAX_R) { flush(); continue; }
    if (run && run.dir !== dir) flush();
    if (!run) run = { s0: s, s1: s, apex: s, kMax: 0, dir, angle: 0 };
    run.s1 = s;
    run.angle += Math.abs(k) * DS;
    if (Math.abs(k) > run.kMax) { run.kMax = Math.abs(k); run.apex = s; }
  }
  flush();
  return out;
}

// a board on the net at course distance s on side `lat` (-1 left, +1 right): centre and facing yaw
function onNet(T, s, lat) {
  const w = T.sAt(T.W, s), p = T.pointAt(s, lat * (w + 0.3));
  const h = p.heading, tx = Math.sin(h), tz = Math.cos(h), rx = -Math.cos(h), rz = Math.sin(h);
  // facing: into the track (-lat * right), turned TOE toward up the course (-tangent)
  const nx = -lat * rx * Math.cos(TOE) - tx * Math.sin(TOE), nz = -lat * rz * Math.cos(TOE) - tz * Math.sin(TOE);
  return { x: p.x, z: p.z, yaw: Math.atan2(nx, nz) };
}

export function buildTurnWarnings(course, group) {
  const T = course.track;
  const bends = findBends(T, course.finishS - 60);
  const spots = { 1: [], [-1]: [], 0: [] };
  // steep pitches ahead: a STEEP board on each side, where there is a barrier to stand it in front of
  for (const st of findSteeps(course)) {
    for (const lat of [-1, 1]) {
      const side = lat < 0 ? 0 : 1;
      if (SKIP.has(T.codeAt(T.BAR[side], st.s))) continue;
      spots[0].push(onNet(T, st.s, lat));
    }
  }
  for (const b of bends) {
    const side = b.dir > 0 ? 0 : 1; // the outside of a right turn is the left side (0)
    const lat = b.dir > 0 ? -1 : 1; // track lateral (+ right of travel): left = -
    const len = Math.max(30, b.apex - b.s0);
    for (const f of [0, 0.5, 1]) {
      const s = Math.max(b.s0 - 12, 20) + len * f;
      if (s > course.finishS - 60 || s < 40) continue;
      if (SKIP.has(T.codeAt(T.BAR[side], s))) continue;
      spots[b.dir].push(onNet(T, s, lat));
    }
  }
  const faceGeo = new THREE.PlaneGeometry(BOARD_W, BOARD_H);
  faceGeo.translate(0, BOARD_LIFT + BOARD_H / 2, 0.04);
  const backGeo = new THREE.BoxGeometry(BOARD_W + 0.06, BOARD_H + 0.06, 0.05);
  backGeo.translate(0, BOARD_LIFT + BOARD_H / 2, 0);
  const postMat = new THREE.MeshStandardMaterial({ color: 0x2f3440, roughness: 0.6, metalness: 0.25 });
  const d = new THREE.Object3D();
  let count = 0;
  for (const dir of [1, -1, 0]) {
    const list = spots[dir];
    if (!list.length) continue;
    const faceMat = new THREE.MeshStandardMaterial({ map: dir ? chevronTex(dir) : steepTex(), color: 0xffffff, roughness: 0.55 });
    const face = new THREE.InstancedMesh(faceGeo, faceMat, list.length);
    const back = new THREE.InstancedMesh(backGeo, postMat, list.length);
    list.forEach((sp, k) => {
      d.position.set(sp.x, meshGround(sp.x, sp.z), sp.z); d.rotation.set(0, sp.yaw, 0); d.updateMatrix();
      face.setMatrixAt(k, d.matrix); back.setMatrixAt(k, d.matrix);
      count++;
    });
    for (const m of [face, back]) { m.castShadow = true; m.receiveShadow = true; m.computeBoundingSphere(); m.name = 'turn-warning'; group.add(m); }
  }
  return count;
}
