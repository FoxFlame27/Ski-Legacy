// Secrets: hidden places in the resort's mountains, found by exploring: tunnels through ridges (an old miners'
// drift, a glacier cave), a hidden cirque behind a moraine, a couloir between cliffs with a frozen waterfall in a
// bay, a natural rock arch and a forest trail; since Oct 29 also a glacier cave on the Wolkenspitze, a smugglers' drift,
// a hidden powder bowl, the old smugglers' hut and a cliff-top pulpit (defineView). The only hints are in the world itself (an old wooden sign, a lantern
// at a portal, a cairn, faint old tracks); the first time you get into one the HUD says so, it pays a small reward
// and the save remembers it (save.secrets; the trail map marks the found ones, the stats screen counts them); finding
// them all pays ALL_FOUND_BONUS.
//
// How it fits together
//  - initSecrets() (boot, right after initLayout, before any terrain is built) shapes the terrain: world cuts
//    (world.addCut, see secrets/cuts.js) for the tunnels' trenches and cuttings, the couloir, the trails, a moraine,
//    and tree-free corridors
//  - new Secrets(...) builds each secret's meshes lazily as you come near (time-sliced, a few ms a frame; dropped
//    far away), keeps the tunnel lids in step with the terrain LOD, adds wall colliders and camera blockers, and
//    checks discoveries. Its materials are shared and compiled behind the boot's loading screen.
//
// A tunnel (defineTunnel) is cut-and-cover: a covered trench under the mountain (the coarse LODs and
// world.outsideHeight skip it, so from afar the mountain is whole; a lid -- an exact copy of the finest terrain mesh
// -- closes it from above), a tube mesh inside, and at each end an open cutting with rock (or ice) walls up to a
// headwall around the portal. Reusable for other tunnels:
//    const path = new Path(pts); const floor = keyProfile([[s, y], ...]);           // secrets/path.js
//    const cuts = tunnelCuts(path, { floor, sF0, sF1, s0, s1, Wi, Hc, half, kS });  // secrets/cuts.js
//    world.addCut(cuts.approach); world.addCut(cuts.mound); world.addCut(cuts.slot); // before the terrain is built
//    buildTubeSteps / buildPortal (secrets/tunnel.js), buildRockSkinsSteps for the cuttings' walls (rock.js),
//    buildLidSteps({ bounds: cuts.slot.bounds, cutAt }) and each frame updateLidVisibility(lid, terrain) (lid.js)
import * as THREE from 'three';
import { world } from './world.js';
import { layout } from './layout.js';
import { smoothstep, clamp, mulberry32 } from '../core/noise.js';
import { Path, keyProfile } from './secrets/path.js';
import { tunnelCuts, shapeCut, forestBand, ridgeFill } from './secrets/cuts.js';
import { buildIceBaySteps, buildArchSteps } from './secrets/features.js';
import { terrainProfile } from './secrets/path.js';
import { skinnedTrenchCut, buildRockSkinsSteps, iceRelief, skinRelief, skinLateral, rockSkinMaterial, APRON, skinSurface } from './secrets/rock.js';
import { fitModel } from '../core/assets.js';
import { meshGround } from '../modes/parkour/kit.js';
import { buildTubeSteps, buildPortal, tunnelMaterials, glacierIceMaterial, setLanternModel } from './secrets/tunnel.js';
import { lanternOnBracket, lampPost, lanternMaterial } from './meshylights.js';
import { buildLidSteps, updateLidVisibility, lidMaterial } from './secrets/lid.js';
import { oldSign, lanternPost, oldTracks, cairn, ropeLine, propMaterials } from './secrets/props.js';
import { featureMaterials } from './secrets/features.js';
import { slice, sharedMaterials } from './secrets/slice.js';
import { SECRET_LIST, secretEnabled } from './secrets/list.js';
import { propSeats } from '../game/seating.js';

export const ALL_FOUND_BONUS = 10000; // $ for finding every secret
const BUILD_R = 650, DROP_R = 1100; // build a secret's meshes within this distance of it, drop them beyond this
// a model's clone shares the loaded model's geometry: never disposed with a secret
const keep = (o) => { o.traverse((q) => { q.userData.secretKeep = true; }); return o; };

// ------------------------------------------------------------------ definitions
const defs = [];
const P = {};

/**
 * A tunnel through a ridge. pts: control points from the cutting's mouth on one side to the run-out on the other
 * (they must reach out to where the floor meets the terrain); floorKeys: [[s, y], ...] (s < 0 = from the end) or
 * null = from the terrain at both ends. The portals go where the mountain first / last stands portalRock m over
 * the floor; in front of each a cutting (rock or ice walls) leads in from where the floor meets the snow.
 */
function defineTunnel(o) {
  if (!secretEnabled(o.id)) return null; // (switched off in secrets/list.js)
  const { id, pts, style = 'mine', Wi = 4, Hs = 4, Hc = 5, D = 1.6, lampEvery = 12, portalRock = Hc + 3.2, kS = 3.2 } = o;
  const path = new Path(pts, { step: 1.5, reach: 60 });
  const L = path.length;
  const hT = (s) => { path.at(s, P); return world.height(P.x, P.z); };
  const keys = (o.floorKeys || [[0, hT(0) - 0.3], [L, hT(L) - 0.3]]).map(([s, y]) => [s < 0 ? L + s : s, y]);
  const floor = keyProfile(keys);
  // the portal planes: where the mountain first / last stands portalRock m over the floor
  let sF0 = o.sF0 ?? null, sF1 = o.sF1 ?? null;
  if (sF0 === null) for (let s = 0; s <= L; s += 0.5) if (hT(s) - floor(s) >= portalRock) { sF0 = s; break; }
  if (sF1 === null) for (let s = L; s >= 0; s -= 0.5) if (hT(s) - floor(s) >= portalRock) { sF1 = s; break; }
  if (sF0 === null || sF1 === null || sF1 - sF0 < 30) { console.warn(`secret ${id}: no ridge to tunnel through`); return null; }
  // the cuttings' mouths: where the floor comes up to the snow in front of each portal
  let s0 = 0, s1 = L;
  for (let s = sF0; s >= 0; s -= 0.5) if (hT(s) - floor(s) <= 0.25) { s0 = s; break; }
  for (let s = sF1; s <= L; s += 0.5) if (hT(s) - floor(s) <= 0.25) { s1 = s; break; }
  // the cuttings' floor half-width: flared at the mouth, the tube's width + a snow apron at the portal
  const half = (s) => {
    const t = s < sF0 ? clamp((sF0 - s) / Math.max(8, sF0 - s0), 0, 1) : s > sF1 ? clamp((s - sF1) / Math.max(8, s1 - sF1), 0, 1) : 0;
    return Wi + 2.0 + 2.6 * t * t + 0.3 * (0.5 + 0.5 * Math.sin(s * 0.21 + (o.seed || 1))); // (the walls' foot stays outside the tube)
  };
  const cuts = tunnelCuts(path, { floor, sF0, sF1, s0, s1, Wi, Hc, half, kS, gap: 1.6, cover: o.cover ?? 1.7, rough: o.rough ?? 1 });
  world.addCut(cuts.approach);
  world.addCut(cuts.mound);
  world.addCut(cuts.slot);
  // the mountain over the tube is ridden like a bridge deck: from above you stay on the lid (the outside surface),
  // inside the tube (far below it) you ride the trench floor
  const SQ = {};
  world.addSurface({
    bounds: cuts.slot.bounds,
    height(x, z) {
      path.project(x, z, SQ);
      if (SQ.dist === Infinity || SQ.s < sF0 - 1 || SQ.s > sF1 + 1) return null;
      // just in front of a portal the headwall's top and its snow cornice overhang the cutting a little: the mountain
      // as it was before the cutting holds you there (from the cutting's floor it is far overhead, so it never counts)
      if (SQ.s < sF0 || SQ.s > sF1) { cuts.approach.off = true; const h = world.outsideHeight(x, z); cuts.approach.off = false; return h; }
      if (cuts.slotSurface(SQ.s, Math.abs(SQ.d)) === Infinity) return null;
      return world.outsideHeight(x, z);
    },
    // anyone over the tube's crown is on the mountain (rough rock rising faster than a step never drops you inside)
    over(x, z) { path.project(x, z, SQ); return SQ.dist === Infinity ? Infinity : floor(SQ.s) + Hc + 1.2; },
  });
  // no trees or boulders in the cuttings, on the mound or over the portals
  const line = [];
  for (let s = Math.max(0, s0 - 10); s <= Math.min(L, s1 + 10); s += 6) { path.at(s, P); line.push([P.x, P.z]); }
  world.addCorridor(line, Wi + 12, 'lift');
  const sA = sF0 + D, sB = sF1 - D;
  const spec = { path, floor, sA, sB, depth: D, sF0, sF1, s0, s1, D, style, Wi, Hs, Hc, seed: o.seed || 1, lampEvery, half, kS };
  const mid = path.at((sF0 + sF1) / 2, {});
  return {
    ...o, kind: 'tunnel', path, floor, sF0, sF1, sA, sB, s0, s1, spec, cuts,
    center: { x: mid.x, z: mid.z }, radius: L / 2 + 60,
    // found once you are well inside the tube
    trigger: (p) => { path.project(p.x, p.z, P); return P.dist < Wi && P.s > sA + 6 && P.s < sB - 6 && Math.abs(p.y - floor(P.s)) < 6; },
    area: (p) => { path.project(p.x, p.z, P); return P.dist < Wi + 1.5 && P.s > sF0 && P.s < sF1; },
    // (a generator: the runtime spreads the work over frames)
    *build() {
      const group = new THREE.Group();
      group.name = `secret-${id}`;
      const tube = yield* buildTubeSteps(spec);
      group.add(tube.group);
      const colliders = [...tube.colliders];
      const lanterns = [];
      yield;
      // the mountain without the cuttings (the walls' rims and the headwalls' tops meet it)
      const natural = (x, z) => { cuts.approach.off = true; const h = world.outsideHeight(x, z); cuts.approach.off = false; return h; };
      for (const end of [0, 1]) {
        const portal = buildPortal(spec, end, { name: end === 0 ? o.portalName ?? o.name : o.portalName2 ?? o.portalName ?? o.name, year: o.year, heightAt: natural });
        group.add(portal.group);
        colliders.push(...portal.colliders);
        if (portal.group.userData.lantern) lanterns.push(portal.group.userData.lantern);
        yield;
      }
      // the cuttings' walls: rock (mine) or glacier ice with snow on the rims (ice)
      const ice = style === 'ice';
      const wallOpts = ice ? { relief: iceRelief, material: glacierIceMaterial(), lipMaterial: rockSkinMaterial(), uvScale: 6 } : {};
      const surfaces = [];
      for (const [a, b] of [[s0, sF0 + 2.5], [sF1 - 2.5, s1]]) {
        if (b - a < 3) continue;
        const skins = yield* buildRockSkinsSteps(path, { floor, half, s0: a, s1: b, kS, heightNoCut: natural, seed: (o.seed || 1) + (a > sF0 ? 5 : 0), ...wallOpts });
        group.add(skins.mesh);
        colliders.push(...skins.colliders);
        yield;
        surfaces.push(skinSurface(skins.mesh.geometry)); // (the lip, the rim and the face hold you: no falling into the hollow behind)
      }
      tube.group.traverse((m) => { if (m.name === 'secret-lantern-glass') lanterns.push(m); });
      const Q = {};
      const reachD = cuts.reach;
      // (wide only by the portal planes, where the slot leans back like the cuttings' walls)
      const near = (x, z) => { path.project(x, z, Q); if (Q.dist === Infinity || Q.s < sF0 - 4 || Q.s > sF1 + 4) return false; return Q.dist < (Q.s < sF0 + 8 || Q.s > sF1 - 8 ? reachD : cuts.slotHalf + 5); };
      const cutAt = (x, z) => { path.project(x, z, Q); return Q.dist === Infinity ? Infinity : cuts.slotSurface(Q.s, Math.abs(Q.d)); };
      const lid = yield* buildLidSteps({ bounds: cuts.slot.bounds, near, keep: lidRegions(path, sF0, sF1), cutAt });
      for (const c of lid.chunks) group.add(c.mesh);
      o.dress?.(group, colliders, lanterns, this);
      return { group, colliders, lids: [lid], blockers: [tube.blocker], lanterns, surfaces };
    },
  };
}

/**
 * A hidden bowl: found when you ride onto its floor (zone {x, z, r}). hut?: { x, z, yaw } an old hut on a small
 * flattened shelf (the Meshy mountain hut, small and weathered), with dressing from o.dress.
 */
function defineBowl(o) {
  if (!secretEnabled(o.id)) return null; // (switched off in secrets/list.js)
  const { id, zone, hut } = o;
  // a moraine: a natural ridge of rubble and snow closing the bowl off (o.moraine = { pts, top, flank })
  if (o.moraine) {
    const mp = new Path(o.moraine.pts, { step: 2, reach: 40 });
    world.addCut(ridgeFill(mp, { top: () => o.moraine.top, flank: o.moraine.flank ?? 1.2, rough: 1.2, ease: 8, reach: 30 }));
  }
  if (hut) {
    const y = world.height(hut.x, hut.z);
    const shelf = new Path([[hut.x - Math.sin(hut.yaw) * 2, hut.z - Math.cos(hut.yaw) * 2], [hut.x + Math.sin(hut.yaw) * 2, hut.z + Math.cos(hut.yaw) * 2]], { step: 1, reach: 40, smooth: false });
    world.addCut(shapeCut(shelf, { floor: () => y, half: 6.5, blend: 10, s0: -9, s1: shelf.length + 9, ease: 3 }));
    world.addCorridor([[hut.x - 1, hut.z], [hut.x + 1, hut.z]], 9, 'lift');
  }
  return {
    ...o, kind: 'bowl', center: { x: zone.x, z: zone.z }, radius: zone.r + 60,
    trigger: (p) => Math.hypot(p.x - zone.x, p.z - zone.z) < zone.r,
    area: (p) => Math.hypot(p.x - zone.x, p.z - zone.z) < zone.r + 25,
    *build(ctx) {
      const group = new THREE.Group();
      group.name = `secret-${id}`;
      const colliders = [], lanterns = [];
      const models = ctx.secrets.models || {};
      if (hut && models.mountain_hut) {
        const m = keep(fitModel(models.mountain_hut, { size: hut.size || 7.5, axis: 'x' }));
        m.position.set(hut.x, world.height(hut.x, hut.z) - 0.35, hut.z);
        m.rotation.y = hut.yaw;
        m.traverse((q) => { if (q.isMesh) { q.castShadow = true; q.receiveShadow = true; } });
        group.add(m);
        const sz = m.userData.size;
        colliders.push({ x: hut.x, z: hut.z, hw: sz.x * 0.45, hd: sz.z * 0.45, rot: -hut.yaw });
        const fx = Math.sin(hut.yaw), fz = Math.cos(hut.yaw), rx = fz, rz = -fx;
        // firewood stacked at the side, an old sled leaning by the door, a lantern on a post
        if (models.firewood_pile) {
          const w = keep(fitModel(models.firewood_pile, { size: 2.2, axis: 'xz' })), wx = hut.x + rx * (sz.x * 0.5 + 1.4) - fx * 1.2, wz = hut.z + rz * (sz.x * 0.5 + 1.4) - fz * 1.2;
          w.position.set(wx, meshGround(wx, wz) - 0.1, wz); w.rotation.y = hut.yaw + Math.PI / 2;
          group.add(w); colliders.push({ x: wx, z: wz, r: 1.1 });
        }
        if (models.wooden_sled) {
          const sl = keep(fitModel(models.wooden_sled, { size: 1.3, axis: 'xz' })), sx = hut.x + fx * (sz.z * 0.5 + 0.9) - rx * 2.2, sz2 = hut.z + fz * (sz.z * 0.5 + 0.9) - rz * 2.2;
          sl.position.set(sx, meshGround(sx, sz2) + 0.02, sz2); sl.rotation.y = hut.yaw + 0.4;
          group.add(sl);
        }
        const lx = hut.x + fx * (sz.z * 0.5 + 1.6) + rx * 2.6, lz = hut.z + fz * (sz.z * 0.5 + 1.6) + rz * 2.6;
        const lp = lanternPost(lx, lz, { seed: 9 });
        lp.rotation.y = hut.yaw;
        group.add(lp); colliders.push(...lp.userData.colliders); lanterns.push(lp.userData.lantern);
      }
      yield;
      o.dress?.(group, colliders, lanterns, this);
      return { group, colliders, lids: [], blockers: [], lanterns };
    },
  };
}

/**
 * A couloir between cliffs: a narrow slot through a ridge with rock walls (skins) either side. pts from the entry
 * to the exit; floorKeys [[s, y]...] (s < 0 from the end); half(s) floor half-width; kS wall steepness.
 */
function defineCouloir(o) {
  if (!secretEnabled(o.id)) return null; // (switched off in secrets/list.js)
  const { id, pts, kS = 3.2 } = o;
  const path = new Path(pts, { step: 1.5, reach: 60 });
  const L = path.length;
  const hT = (s) => { path.at(s, P); return world.height(P.x, P.z); };
  const floor = keyProfile((o.floorKeys || [[0, hT(0) - 0.3], [L, hT(L) - 0.3]]).map(([s, y]) => [s < 0 ? L + s : s, y]));
  let s0 = 0, s1 = L;
  for (let s = 0; s <= L; s += 0.5) if (hT(s) - floor(s) > 0.6) { s0 = Math.max(0, s - 1); break; }
  for (let s = L; s >= 0; s -= 0.5) if (hT(s) - floor(s) > 0.6) { s1 = Math.min(L, s + 1); break; }
  // floor half-width out to the walls' snow aprons (the skiable floor is ~1.6 m narrower each side); o.bay widens it
  // on one side over a stretch (a frozen waterfall's bay, defineIceBay)
  const base = o.half || ((s) => 6.3 + 1.2 * Math.sin(s * 0.045 + 1.3) + 0.6 * Math.sin(s * 0.13));
  const bay = o.bay || null;
  const bump = (s) => (bay ? smoothstep(bay.s0 - 10, bay.s0 + 1, s) * (1 - smoothstep(bay.s1 - 1, bay.s1 + 10, s)) : 0);
  const half = (s, side) => base(s) + (bay && side === bay.side ? bay.width * bump(s) : 0);
  const seed = o.seed || 1;
  // the walls' surface (the skins' lateral offset at height h over the floor), for whatever stands against them
  const wallAt = (s, h, side) => skinLateral(half(s, side), h, kS) + skinRelief(s, Math.max(h, APRON), side, seed) * (h < APRON ? Math.max(0, h) / APRON : 1);
  const cut = skinnedTrenchCut(path, { floor, half, s0, s1, kS });
  world.addCut(cut);
  if (o.runout) world.addCut(shapeCut(path, { floor, half: o.runout.half, blend: o.runout.blend, s0: o.runout.s0, s1: o.runout.s1, ease: 4 }));
  const line = [];
  for (let s = Math.max(0, s0 - 8); s <= Math.min(L, s1 + 8); s += 5) { path.at(s, P); line.push([P.x, P.z]); }
  world.addCorridor(line, 14, 'lift');
  const mid = path.at((s0 + s1) / 2, {});
  return {
    ...o, kind: 'couloir', path, floor, s0, s1, cut, base, half, wallAt, kS,
    center: { x: mid.x, z: mid.z }, radius: L / 2 + 50,
    trigger: (p) => { path.project(p.x, p.z, P); return P.dist < 6 && P.s > s0 + (s1 - s0) * 0.3 && P.s < s1 - (s1 - s0) * 0.2; },
    area: (p) => { path.project(p.x, p.z, P); return P.dist < 8 && P.s > s0 && P.s < s1; },
    *build() {
      const group = new THREE.Group();
      group.name = `secret-${id}`;
      const heightNoCut = (x, z) => { cut.off = true; const h = world.height(x, z); cut.off = false; return h; };
      const skins = yield* buildRockSkinsSteps(path, { floor, half, s0, s1, kS, heightNoCut, seed });
      group.add(skins.mesh);
      const colliders = [...skins.colliders], lanterns = [];
      yield;
      const surfaces = [skinSurface(skins.mesh.geometry)]; // (the rims and the walls' faces hold you)
      o.dress?.(group, colliders, lanterns, this);
      return { group, colliders, lids: [], blockers: [], lanterns, surfaces };
    },
  };
}

/**
 * A rideable trail shaped into the slope (cut / filled, blended into the terrain): returns { path, floor, cut }.
 * o: pts, half, blend, maxGrade, minGrade, start / end (floor heights or null = terrain), forest: forestBand options
 */
function shapedTrail(o) {
  const path = new Path(o.pts, { step: 2, reach: Math.max(18, (o.half ?? 3.2) + Math.max(o.blend ?? 8, o.blendL ?? 0, o.blendR ?? 0) + 6) });
  const raw = (x, z) => world.height(x, z);
  const floor = terrainProfile(path, raw, { step: 3, window: o.window ?? 30, minGrade: o.minGrade ?? 0.03, maxGrade: o.maxGrade ?? 0.32, start: o.start ?? null, end: o.end ?? null });
  const cut = shapeCut(path, { floor, half: o.half ?? 3.2, blend: o.blend ?? 8, blendL: o.blendL, blendR: o.blendR, s0: -4, s1: path.length + 4, ease: o.ease ?? 6, wave: o.wave ?? 0.6 });
  if (o.forest) cut.forest = forestBand(path, o.forest);
  cut.__trail = { path, floor, name: o.name || '' }; // (for the dev tools)
  world.addCut(cut);
  const line = [];
  for (let s = 0; s <= path.length; s += 5) { path.at(s, P); line.push([P.x, P.z]); }
  world.addCorridor(line, o.clear ?? (o.half ?? 3.2) + 1.5, 'lift');
  return { path, floor, cut };
}

/**
 * The frozen waterfall in a couloir's bay (the couloir defined with o.bay = { s0, s1, side, width }): the icefall on
 * the bay's back wall, a ledge, and an ice curtain along the couloir's wall line; found once you ride behind it.
 */
function defineIceBay(o) {
  if (!secretEnabled(o.id)) return null; // (switched off in secrets/list.js)
  const c = defs.find((q) => q.id === o.couloir);
  if (!c || !c.bay) { console.warn(`secret ${o.id}: no couloir bay`); return null; }
  const { path, floor, bay, base, wallAt } = c;
  const side = bay.side, s0 = bay.s0, s1 = bay.s1, Q = {};
  const curtainAt = (s) => base(s) - 0.3;
  const passage = (s) => (curtainAt(s) + wallAt(s, 0, side)) / 2;
  const mid = path.at((s0 + s1) / 2, {});
  return {
    ...o, kind: 'icefall', path, floor, s0, s1,
    center: { x: mid.x, z: mid.z }, radius: (s1 - s0) / 2 + 80,
    trigger: (p) => { path.project(p.x, p.z, Q); return Q.dist !== Infinity && Q.s > s0 + 9 && Q.s < s1 - 9 && Math.abs(Q.d * side - passage(Q.s)) < 2.6 && Math.abs(p.y - floor(Q.s)) < 4; },
    area: (p) => { path.project(p.x, p.z, Q); return Q.dist !== Infinity && Q.s > s0 + 4 && Q.s < s1 - 4 && Q.d * side > curtainAt(Q.s) - 1; },
    *build() {
      // the rim of the bay's back wall (where the skin meets the mountain), for the icefall's top
      const heightNoCut = (x, z) => { c.cut.off = true; const h = world.height(x, z); c.cut.off = false; return h; };
      const rimAt = (s) => {
        path.at(s, P);
        const y = floor(s);
        for (let h = 4; h < 120; h += 1.5) { const L = wallAt(s, h, side), X = P.x + P.rx * side * L, Z = P.z + P.rz * side * L; if (y + h >= heightNoCut(X, Z)) return h; }
        return 120;
      };
      const r = yield* buildIceBaySteps({ path, floor, s0, s1, side, curtainAt, wallAt: (s, h) => wallAt(s, h, side), rimAt, ledgeH: o.ledgeH ?? 9, seed: o.seed || 1 });
      const group = r.group, colliders = [...r.colliders], lanterns = [];
      o.dress?.(group, colliders, lanterns, this);
      return { group, colliders, lids: [], blockers: [], lanterns };
    },
  };
}

/**
 * A natural rock arch over a line you ski: pts through the arch (it stands at arcLen `at` along them), a shaped
 * floor under it, the way on as a trail.
 */
function defineArch(o) {
  if (!secretEnabled(o.id)) return null; // (switched off in secrets/list.js)
  const { id, pts, span = 15, clear = 10 } = o;
  const trail = shapedTrail({ name: `${id} trail`, pts, half: o.half ?? 4.5, blend: o.blend ?? 9, blendL: o.blendL, blendR: o.blendR, maxGrade: o.maxGrade ?? 0.36, minGrade: o.minGrade, window: o.window ?? 26, clear: span / 2 + 6 });
  const { path, floor } = trail;
  let sAt = o.at ?? path.length * 0.4;
  if (o.atPoint) { path.project(o.atPoint[0], o.atPoint[1], P); sAt = P.s; }
  const c = path.at(sAt, {});
  const yaw = Math.atan2(c.tx, c.tz);
  return {
    ...o, kind: 'arch', path, floor,
    center: { x: c.x, z: c.z }, radius: path.length / 2 + 60,
    trigger: (p) => { path.project(p.x, p.z, P); return P.dist < span / 2 - 1 && Math.abs(P.s - sAt) < 4; },
    area: (p) => Math.hypot(p.x - c.x, p.z - c.z) < 25,
    *build() {
      const r = yield* buildArchSteps({ at: { x: c.x, z: c.z }, yaw, span, clear, thick: o.thick ?? 6.5, depth: o.depth ?? 9, heightAt: (x, z) => world.height(x, z), seed: o.seed || 1 });
      const group = r.group, colliders = [...r.colliders], lanterns = [];
      o.dress?.(group, colliders, lanterns, this);
      return { group, colliders, lids: [], blockers: [], lanterns };
    },
  };
}

/**
 * A hidden trail through dense forest: a narrow rideable lane (shaped), trees boosted either side, an old hut in a
 * clearing on the way (o.hut: arc length + side), found once you are well along it. Optional:
 *  - o.spot = { s, d, kind, r?, view? }: a glade beside the lane, levelled and cleared, dressed with Meshy props
 *    (kind 'firepit' | 'picnic' | 'view' | 'hut' | 'woodpile'; view: [x, z] the benches look toward)
 *  - o.lanternEvery: m between the Meshy lantern posts along the lane (sides alternating; they glow at dusk)
 *  - o.head: the trailhead's carved arrow sign (on the Meshy signpost) and a lantern post, by the trail's start
 */
function defineTrail(o) {
  if (!secretEnabled(o.id)) return null; // (switched off in secrets/list.js)
  const { id, pts } = o;
  const trail = shapedTrail({ name: `${id} trail`, pts, half: o.half ?? 3.0, blend: 7, maxGrade: o.maxGrade ?? 0.28, minGrade: 0.035, window: 24, forest: { clear: 4.2, band: 30, density: 0.95 }, clear: 4.5 });
  const { path, floor } = trail;
  const L = path.length;
  let hutAt = null;
  if (o.hut) {
    const q = path.point(o.hut.s, o.hut.d, {}), y = world.height(q.x, q.z);
    hutAt = { x: q.x, z: q.z, yaw: Math.atan2(-o.hut.d * q.rx, -o.hut.d * q.rz) };
    // a little clearing, levelled around the hut
    const pad = new Path([[q.x - 1, q.z], [q.x + 1, q.z]], { step: 1, reach: 40, smooth: false });
    world.addCut(shapeCut(pad, { floor: () => y, half: 6, blend: 8, s0: -10, s1: pad.length + 10, ease: 3 }));
    world.addCorridor([[q.x - 1, q.z], [q.x + 1, q.z]], 13, 'lift');
  }
  // the glade beside the lane: levelled and cleared; its bank ends before the lane (the lane's floor stays smooth)
  let spot = null;
  if (o.spot) {
    const q = path.point(o.spot.s, o.spot.d, {}), y = world.height(q.x, q.z), r = o.spot.r ?? 5.5;
    const blend = Math.max(2.5, Math.abs(o.spot.d) - r - (o.half ?? 3.0) - 1.5);
    const pad = new Path([[q.x - 1, q.z], [q.x + 1, q.z]], { step: 1, reach: 40, smooth: false });
    world.addCut(shapeCut(pad, { floor: () => y, half: r, blend, s0: -r, s1: pad.length + r, ease: 3 }));
    world.addCorridor([[q.x - 1, q.z], [q.x + 1, q.z]], r + 2.5, 'lift');
    const t = path.point(o.spot.s, 0, {});
    spot = { ...o.spot, x: q.x, z: q.z, r, toTrail: Math.atan2(t.x - q.x, t.z - q.z) };
  }
  // lanterns along the lane, just off it, facing it (none by the glade: it has its own)
  const lamps = [];
  if (o.lanternEvery) {
    const off = (o.half ?? 3.0) + 2.0;
    let side = 1;
    for (let s = 10 + o.lanternEvery * 0.6; s < L - 12; s += o.lanternEvery) {
      if (spot && Math.abs(s - spot.s) < 18) continue;
      const q = path.point(s, side * off, {}), c = path.point(s, 0, {});
      lamps.push({ x: q.x, z: q.z, yaw: Math.atan2(c.x - q.x, c.z - q.z) });
      side = -side;
    }
  }
  const mid = path.at(L / 2, {});
  return {
    ...o, kind: 'trail', path, floor, hutAt, spot,
    center: { x: mid.x, z: mid.z }, radius: L / 2 + 60,
    trigger: (p) => { path.project(p.x, p.z, P); return P.dist < 5 && P.s > L * 0.35 && P.s < L * 0.9; },
    area: (p) => { path.project(p.x, p.z, P); return P.dist < 7 && P.s > 0 && P.s < L; },
    *build(ctx) {
      const group = new THREE.Group();
      group.name = `secret-${id}`;
      const colliders = [], lanterns = [];
      const models = ctx.secrets.models || {};
      if (hutAt && models.mountain_hut) {
        const m = keep(fitModel(models.mountain_hut, { size: 6.6, axis: 'x' }));
        m.position.set(hutAt.x, world.height(hutAt.x, hutAt.z) - 0.3, hutAt.z);
        m.rotation.y = hutAt.yaw;
        m.traverse((q) => { if (q.isMesh) { q.castShadow = true; q.receiveShadow = true; } });
        group.add(m);
        const sz = m.userData.size;
        colliders.push({ x: hutAt.x, z: hutAt.z, hw: sz.x * 0.45, hd: sz.z * 0.45, rot: -hutAt.yaw });
        const fx = Math.sin(hutAt.yaw), fz = Math.cos(hutAt.yaw), rx = fz, rz = -fx;
        if (models.firewood_pile) {
          const w = keep(fitModel(models.firewood_pile, { size: 2.0, axis: 'xz' })), wx = hutAt.x - rx * (sz.x * 0.5 + 1.3), wz = hutAt.z - rz * (sz.x * 0.5 + 1.3);
          w.position.set(wx, meshGround(wx, wz) - 0.1, wz); w.rotation.y = hutAt.yaw - Math.PI / 2;
          group.add(w); colliders.push({ x: wx, z: wz, r: 1.0 });
        }
        const lx = hutAt.x + fx * (sz.z * 0.5 + 1.5) + rx * 2.4, lz = hutAt.z + fz * (sz.z * 0.5 + 1.5) + rz * 2.4;
        const lp = lanternPost(lx, lz, { seed: 13 });
        lp.rotation.y = hutAt.yaw;
        group.add(lp); colliders.push(...lp.userData.colliders); lanterns.push(lp.userData.lantern);
      }
      yield;
      if (spot) { dressSpot(spot, models, group, colliders, lanterns); yield; }
      for (let i = 0; i < lamps.length; i++) {
        const l = lamps[i], lp = lanternPost(l.x, l.z, { seed: 31 + i });
        lp.rotation.y = l.yaw;
        group.add(lp); colliders.push(...lp.userData.colliders); lanterns.push(lp.userData.lantern);
      }
      if (o.head) {
        // the trailhead: a carved arrow sign on the Meshy signpost on one side, a lantern post on the other
        const side = o.headSide ?? 1, q = path.point(7, side * ((o.half ?? 3.0) + 2.3), {}), n = path.point(32, 0, {});
        const sign = oldSign(q.x, q.z, Math.atan2(n.x - q.x, n.z - q.z), o.head, { seed: o.seed || 61, w: 0.5 + o.head.length * 0.11, pole: models.sign_pole });
        group.add(sign); colliders.push(...sign.userData.colliders);
        const k = path.point(3, -side * ((o.half ?? 3.0) + 2.0), {}), c = path.point(3, 0, {});
        const lp = lanternPost(k.x, k.z, { seed: 71 });
        lp.rotation.y = Math.atan2(c.x - k.x, c.z - k.z);
        group.add(lp); colliders.push(...lp.userData.colliders); lanterns.push(lp.userData.lantern);
      }
      o.dress?.(group, colliders, lanterns, this);
      return { group, colliders, lids: [], blockers: [], lanterns };
    },
  };
}

// A trail's glade dressed with the Meshy props (sp: { x, z, toTrail, kind, view? }): offsets (dx right, dz toward the
// lane) in the glade's own frame; every prop stands on the snow as the terrain renders it.
function dressSpot(sp, models, group, colliders, lanterns) {
  const fx = Math.sin(sp.toTrail), fz = Math.cos(sp.toTrail), rx = fz, rz = -fx;
  const at = (dx, dz) => [sp.x + rx * dx + fx * dz, sp.z + rz * dx + fz * dz];
  const put = (name, dx, dz, face, size, axis = 'xz', r = 0, sink = 0.05) => {
    if (!models[name]) return null;
    const [x, z] = at(dx, dz);
    const m = keep(fitModel(models[name], { size, axis }));
    m.position.set(x, meshGround(x, z) - sink, z);
    // face: [x, z] the model's front (+z) turns to, or a yaw offset from facing the lane
    m.rotation.y = Array.isArray(face) ? Math.atan2(face[0] - x, face[1] - z) : sp.toTrail + face;
    m.traverse((q) => { if (q.isMesh) { q.castShadow = true; q.receiveShadow = true; } });
    group.add(m);
    if (r) colliders.push({ x, z, r });
    propSeats(name, m, size); // (benches: you can sit on them)
    return m;
  };
  const lantern = (dx, dz, seed) => {
    const [x, z] = at(dx, dz), lp = lanternPost(x, z, { seed });
    lp.rotation.y = Math.atan2(sp.x - x, sp.z - z); // (its lantern toward the glade)
    group.add(lp); colliders.push(...lp.userData.colliders); lanterns.push(lp.userData.lantern);
  };
  const C = [sp.x, sp.z];
  if (sp.kind === 'firepit') {
    // a fire pit with benches round it, firewood stacked at the back
    put('fire_pit', 0, 0, 0.4, 1.6, 'xz', 0.8, 0.08);
    put('wooden_bench', -2.8, 0.3, C, 1.8, 'xz', 0.7);
    put('wooden_bench', 2.6, -0.9, C, 1.8, 'xz', 0.7);
    put('firewood_pile', -1.4, -3.6, 0.15, 2.0, 'xz', 1.0, 0.1);
    lantern(2.9, 2.6, 41);
  } else if (sp.kind === 'picnic') {
    put('picnic_table', -1.9, 0.4, 0.35, 2.0, 'xz', 1.0);
    put('picnic_table', 2.3, -1.3, -0.5, 2.0, 'xz', 1.0);
    put('wooden_sled', 0.4, -3.4, 1.2, 1.25, 'xz', 0, 0);
    lantern(3.6, 2.2, 43);
  } else if (sp.kind === 'view') {
    // two benches looking out over the valley, a lantern beside them
    const V = sp.view || C;
    put('wooden_bench', -1.3, -0.6, V, 1.8, 'xz', 0.7);
    put('wooden_bench', 1.5, -0.2, V, 1.8, 'xz', 0.7);
    lantern(-3.2, 1.2, 45);
  } else if (sp.kind === 'woodpile') {
    // a woodcutters' stack in the trees: firewood, an old sled, a bench to rest on
    put('firewood_pile', -1.8, -1.6, 0.1, 2.2, 'xz', 1.1, 0.1);
    put('firewood_pile', 1.0, -2.2, -0.2, 2.0, 'xz', 1.0, 0.1);
    put('wooden_sled', 2.4, 0.4, 0.9, 1.25, 'xz', 0, 0);
    put('wooden_bench', -2.6, 1.6, 0, 1.8, 'xz', 0.7);
    lantern(3.4, 2.4, 47);
  } else if (sp.kind === 'hut') {
    // an old woodcutters' hut facing the lane: firewood at its side, a sled by the door, a lantern
    const m = put('mountain_hut', 0, -1.5, 0, 6.6, 'x', 0, 0.3);
    if (m) {
      const sz = m.userData.size, [hx, hz] = at(0, -1.5);
      colliders.push({ x: hx, z: hz, hw: sz.x * 0.45, hd: sz.z * 0.45, rot: -sp.toTrail });
      put('firewood_pile', -(sz.x * 0.5 + 1.3), -1.5, -Math.PI / 2, 2.0, 'xz', 1.0, 0.1);
      put('wooden_sled', sz.x * 0.5 - 0.6, sz.z * 0.5 + 0.6 - 1.5, 0.5, 1.25, 'xz', 0, 0);
      lantern(sz.x * 0.5 + 1.6, sz.z * 0.5 + 0.9 - 1.5, 49);
    }
  }
}

/**
 * A viewpoint: a small level pad (o.at) on a cliff top or a shoulder, two benches looking out toward o.look and a
 * lantern (dressSpot 'view'); found once you stand on it (o.trigR m).
 */
function defineView(o) {
  if (!secretEnabled(o.id)) return null; // (switched off in secrets/list.js)
  const { id, at, look, r = 5 } = o;
  const y = world.height(at.x, at.z);
  const pad = new Path([[at.x - 1, at.z], [at.x + 1, at.z]], { step: 1, reach: 40, smooth: false });
  world.addCut(shapeCut(pad, { floor: () => y, half: r, blend: o.blend ?? 5, s0: -r, s1: pad.length + r, ease: 3 }));
  world.addCorridor([[at.x - 1, at.z], [at.x + 1, at.z]], r + 3, 'lift');
  // (dressSpot's frame: toTrail points away from the view, the benches sit on the view side looking out)
  const sp = { x: at.x, z: at.z, r, kind: 'view', view: look, toTrail: Math.atan2(at.x - look[0], at.z - look[1]) };
  return {
    ...o, kind: 'view', center: { x: at.x, z: at.z }, radius: 60,
    trigger: (p) => Math.hypot(p.x - at.x, p.z - at.z) < (o.trigR ?? 9) && Math.abs(p.y - y) < 5,
    area: (p) => Math.hypot(p.x - at.x, p.z - at.z) < 22,
    *build(ctx) {
      const group = new THREE.Group();
      group.name = `secret-${id}`;
      const colliders = [], lanterns = [];
      dressSpot(sp, ctx.secrets.models || {}, group, colliders, lanterns);
      yield;
      o.dress?.(group, colliders, lanterns, this);
      return { group, colliders, lids: [], blockers: [], lanterns };
    },
  };
}

// Where a tunnel's lid may lie: between the two portal planes (in front of them are the open cuttings).
function lidRegions(path, sF0, sF1) {
  const plane = (s, dir) => { const p = path.point(s, 0, {}); return { x: p.x, z: p.z, nx: p.tx * dir, nz: p.tz * dir }; };
  return [[plane(sF0, 1), plane(sF1, -1)]];
}

// The secrets, west to east. Every coordinate was picked on the terrain (tools in the scratchpad): reachable from a
// lift by skiing, rideable and gentle inside, with a way back to the runs.
const MAKERS = [
  // Legacy summit: an old miners' drift from the shoulder south-west of the top station, under the crown, into
  // the hidden Schattenkar bowl
  () => defineTunnel({
    id: 'knappenstollen', name: 'Knappenstollen', portalName: 'Knappenstollen', year: 'anno 1887', reward: 1000, style: 'mine', seed: 3,
    pts: [[-160, -1952], [-178, -1972], [-214, -2010], [-262, -2066], [-318, -2130], [-370, -2186], [-412, -2228], [-446, -2258], [-474, -2282]],
    dress(group, colliders, lanterns, def) {
      // faint old tracks from beside the top station down to the portal, and an old arrow sign where they leave
      const tr = [[-30, -2112], [-70, -2080], [-112, -2048], [-150, -2012], [-176, -1986], [-198, -1996], [-214, -2012]];
      group.add(oldTracks(tr, { seed: 5, wander: 0.9 }));
      const sign = oldSign(-24, -2104, Math.atan2(-70 + 24, -2080 + 2104), 'Alter Stollen', { seed: 4, w: 1.45 });
      group.add(sign); colliders.push(...sign.userData.colliders);
    },
  }),
  // the hidden bowl the Knappenstollen comes out in: untracked powder, an old miners' hut
  () => defineBowl({
    id: 'schattenkar', name: 'Schattenkar', reward: 500,
    // the hollow the drift comes out in: an old miners' hut on its north side, its west and north closed by a
    // moraine (the cirque's floor beyond drops away into a basin you could not ride out of); the way on is the
    // Teufelsrinne to the south
    zone: { x: -462, z: -2276, r: 30 },
    hut: { x: -456, z: -2302, yaw: Math.atan2(-470 + 456, -2268 + 2302), size: 7.2 },
    moraine: { pts: [[-487, -2240], [-496, -2262], [-496, -2286], [-486, -2310], [-468, -2328], [-448, -2340], [-428, -2346]], top: 972.5, flank: 1.25 },
  }),
  // out of the Schattenkar to the south: a narrow slot between cliffs through the bowl's rim, onto the main face
  () => defineCouloir({
    id: 'teufelsrinne', name: 'Teufelsrinne', reward: 750, seed: 7,
    pts: [[-468, -2266], [-486, -2222], [-490, -2176], [-473, -2132], [-449, -2092], [-439, -2051], [-441, -2012], [-447, -1978], [-456, -1948], [-460, -1934], [-464, -1918], [-467, -1902]],
    floorKeys: [[0, 961.5], [180, 940], [344, 868.2], [374, 842.5]],
    // a bay on its west wall for the frozen waterfall (defineIceBay below; off while the Eisfall-Grotte is)
    bay: secretEnabled('eisfall') ? { s0: 92, s1: 140, side: 1, width: 7 } : null,
    // where the gully opens onto the main face: a smooth roll-over instead of the face's rocky lip
    runout: { s0: 336, s1: 378, half: 5, blend: 9 },
    dress(group, colliders, lanterns, def) {
      // a cairn where the slot opens off the bowl
      const p = def.path.point(def.s0 + 6, -6.5, {});
      const c = cairn(p.x, p.z, { seed: 3 });
      group.add(c); colliders.push(...c.userData.colliders);
    },
  }),
  // in the Teufelsrinne: a frozen waterfall pours down the gully's west wall into a bay; ride behind its ice
  // curtain (in at one end, out at the other)
  () => defineIceBay({ id: 'eisfall', name: 'Eisfall-Grotte', reward: 750, couloir: 'teufelsrinne', seed: 17, ledgeH: 9 }),
  // Silberhorn: a glacier cave under the summit's ice cap. Faint old tracks lead from the top station past the
  // hut into a hollow below the plateau's south-west rim; the cave runs north under the plateau (clear of the
  // station and every run) and comes out on the north face, a short ride above the red Gratweg
  () => defineTunnel({
    id: 'silbergrotte', name: 'Silbergrotte', reward: 1000, style: 'ice', seed: 11, Wi: 4.2, Hs: 3.4, Hc: 5.6, cover: 1.6,
    pts: [[-2306, -114], [-2311, -99], [-2322, -90], [-2336, -89], [-2347, -97], [-2352, -114], [-2352, -140], [-2353, -175], [-2355, -220], [-2359, -270], [-2363, -310], [-2362, -338], [-2350, -356], [-2328, -364], [-2300, -364]],
    // (over 4.5 % all through: on flatter snow the game takes your skis off when you stop)
    floorKeys: [[0, 765.4], [50, 763.2], [-1, 744.2]],
    dress(group, colliders, lanterns, def) {
      // faint tracks from the station's west side, past the hut, round the bend to the cave; a cairn on the bend
      const tr = [[-2314, -192], [-2315, -168], [-2311, -144], [-2307, -126]];
      for (let s = 0; s <= def.sF0 - 3; s += 3) { const q = def.path.point(s, 0.5 * Math.sin(s * 0.17), {}); tr.push([q.x, q.z]); }
      group.add(oldTracks(tr, { seed: 23, wander: 0.5 }));
      const p = def.path.point(36, -7, {});
      const c = cairn(p.x, p.z, { seed: 21, size: 0.9 });
      group.add(c); colliders.push(...c.userData.colliders);
    },
  }),
  // Adlerhorn: a natural rock arch on the shoulder north-west of the top station: from the top, down the open slope
  // and under the arch, then a gentle traverse back onto the blue Sonnenhang (between its net and the Super-G's)
  () => defineArch({
    id: 'adlertor', name: 'Adlertor', reward: 500, seed: 5, span: 15, clear: 10.5,
    pts: [[2283, -606], [2262, -628], [2238, -651], [2212, -673], [2186, -690], [2160, -697], [2134, -686], [2106, -664], [2078, -641], [2052, -620], [2032, -603]],
    // (a narrow bench across the slope, its downhill bank eased out over 12 m)
    atPoint: [2163, -697], window: 12, half: 3.6, blendL: 6, blendR: 12, maxGrade: 0.62, minGrade: 0.02,
    dress(group, colliders, lanterns, def) {
      const q = def.path.point(10, 6.5, {});
      const sign = oldSign(q.x, q.z, Math.atan2(def.path.point(40, 0, {}).x - q.x, def.path.point(40, 0, {}).z - q.z), 'Adlertor', { seed: 31, w: 1.2 });
      group.add(sign); colliders.push(...sign.userData.colliders);
    },
  }),
  // Legacy Valley: the old foresters' path through the pines at the foot of the valley's west wall, from the
  // edge of the woods south-west of the village (where the ground starts to fall) down to the Valley Chair,
  // past the Försterhütte
  () => defineTrail({
    id: 'foersterweg', name: 'Försterweg', reward: 500,
    pts: [[-322, 291], [-348, 322], [-392, 380], [-430, 470], [-447, 560], [-450, 660], [-440, 760], [-420, 860], [-392, 960], [-350, 1050], [-286, 1130], [-200, 1200], [-110, 1262]],
    hut: { s: 474, d: -11 },
    dress(group, colliders, lanterns, def) {
      const q = def.path.point(8, 5.5, {}), n = def.path.point(30, 0, {});
      const sign = oldSign(q.x, q.z, Math.atan2(n.x - q.x, n.z - q.z), 'Försterweg', { seed: 51, w: 1.35 });
      group.add(sign); colliders.push(...sign.userData.colliders);
    },
  }),
  // ---- Oct 29 (the user: "add more secrets"): five more, out on untouched slopes away from the runs, the roads,
  // the chalets, the express and the race courses (picked on the terrain with the scratchpad tools: tunnels where a
  // ridge stands 16-50 m over a 5-13 % floor, the bowl where its rim rises all round but one side)
  // Wolkenspitze, high on its south-east shoulder: a glacier cave through a rock rib, entered from a notch reached
  // along the slope from the south. A cairn marks the notch; faint old tracks lead there
  () => defineTunnel({
    id: 'kristallgrotte', name: 'Kristallgrotte', reward: 1000, style: 'ice', seed: 19, Wi: 4.2, Hs: 3.4, Hc: 5.6, cover: 1.6,
    pts: [[4430, -4472], [4404, -4430], [4378, -4388], [4353, -4346], [4327, -4304]],
    dress(group, colliders, lanterns, def) {
      const tr = [];
      for (let k = 0; k <= 10; k++) tr.push([4436 + k * 1.5 + 2 * Math.sin(k * 0.9), -4590 + k * 11]);
      for (let s = 0; s <= Math.max(0, def.sF0 - 3); s += 3) { const q = def.path.point(s, 0.5 * Math.sin(s * 0.2), {}); tr.push([q.x, q.z]); }
      group.add(oldTracks(tr, { seed: 37, wander: 0.6 }));
      const p = def.path.point(2, 7, {});
      const c = cairn(p.x, p.z, { seed: 33, size: 0.95 });
      group.add(c); colliders.push(...c.userData.colliders);
    },
  }),
  // the forested hills south of the Legacy summit: an old drift through a spur (the miners left it, the smugglers
  // used it), from a hollow at its head out onto the slope east of it. An old carved sign by the hollow
  () => defineTunnel({
    id: 'schmugglerstollen', name: 'Schmugglerstollen', portalName: 'Schmugglerstollen', year: 'anno 1902', reward: 1000, style: 'mine', seed: 23,
    pts: [[1458, -3884], [1504, -3901], [1550, -3919], [1596, -3936], [1642, -3954]],
    dress(group, colliders, lanterns, def) {
      const tr = [[1420, -3990], [1428, -3962], [1438, -3936], [1447, -3912]];
      for (let s = 0; s <= Math.max(0, def.sF0 - 3); s += 3) { const q = def.path.point(s, 0.4 * Math.sin(s * 0.23), {}); tr.push([q.x, q.z]); }
      group.add(oldTracks(tr, { seed: 41, wander: 0.8 }));
      const q = def.path.point(4, -6.5, {}), n = def.path.point(30, 0, {});
      const sign = oldSign(q.x, q.z, Math.atan2(n.x - q.x, n.z - q.z), 'Alter Stollen', { seed: 43, w: 1.45 });
      group.add(sign); colliders.push(...sign.userData.colliders);
    },
  }),
  // a hidden bowl south-east of there: a cirque whose rim rises 60-130 m on every side but the south, untracked
  // powder on its floor. A cairn on the north rim where you drop in, faint tracks down into it
  () => defineBowl({
    id: 'pulverkessel', name: 'Pulverkessel', reward: 750,
    zone: { x: 2280, z: -4520, r: 42 },
    dress(group, colliders, lanterns) {
      const c = cairn(2283, -4406, { seed: 47, size: 1.05 });
      group.add(c); colliders.push(...c.userData.colliders);
      const tr = [];
      for (let k = 0; k <= 16; k++) tr.push([2284 + 3 * Math.sin(k * 0.7), -4412 - k * 6]);
      group.add(oldTracks(tr, { seed: 49, wander: 1.0 }));
    },
  }),
  // west of the Silberhorn, in a hollow under the ridge to Eagle Peak: the old smugglers' hut, its door to the open
  // north-west side. Faint old tracks come down to it from the ridge, a cairn where they leave it
  () => defineBowl({
    id: 'schmugglerhuette', name: 'Schmugglerhütte', reward: 750,
    zone: { x: -4600, z: -380, r: 30 },
    hut: { x: -4581, z: -385, yaw: 285 * Math.PI / 180, size: 7.0 },
    dress(group, colliders, lanterns) {
      const tr = [];
      for (let k = 0; k <= 14; k++) tr.push([-4520 - k * 4.5 + 2 * Math.sin(k * 0.8), -262 - k * 7.5]);
      group.add(oldTracks(tr, { seed: 53, wander: 0.9 }));
      const c = cairn(-4517, -255, { seed: 55, size: 0.9 });
      group.add(c); colliders.push(...c.userData.colliders);
    },
  }),
  // Wolkenspitze's west face: a pulpit on the cliff top, 250 m of air below it, two benches looking out over the
  // valley. An old sign and a cairn on the way down to it from the north
  () => defineView({
    id: 'wolkenkanzel', name: 'Wolkenkanzel', reward: 500,
    at: { x: 2843, z: -4157 }, look: [2698, -4301], r: 5,
    dress(group, colliders, lanterns) {
      const sign = oldSign(2846, -4130, Math.atan2(2843 - 2846, -4157 + 4130), 'Wolkenkanzel', { seed: 57, w: 1.4 });
      group.add(sign); colliders.push(...sign.userData.colliders);
      const c = cairn(2838, -4070, { seed: 59, size: 0.9 });
      group.add(c); colliders.push(...c.userData.colliders);
      group.add(oldTracks([[2838, -4062], [2841, -4085], [2844, -4106], [2847, -4126], [2849, -4140]], { seed: 61, wander: 0.6 }));
    },
  }),
];

export function initSecrets() {
  if (defs.length) return defs;
  // dev switch: ?nosecrets loads the world without them (A/B checks)
  if (typeof location !== 'undefined' && /[?&]nosecrets\b/.test(location.search)) return defs;
  const t0 = performance.now();
  for (const make of MAKERS) { const d = make(); if (d) defs.push(d); }
  layout.timings && (layout.timings.secrets = Math.round(performance.now() - t0));
  return defs;
}
export const secretDefs = () => defs;

// ------------------------------------------------------------------ runtime
export class Secrets {
  /**
   * @param {object} o  scene, terrain, colliders (shared list), cameraBlockers (player's list), hud, audio, save,
   *   writeSave, earn(amount), propDetail?
   */
  constructor(o) {
    Object.assign(this, o);
    setLanternModel(o.models?.lamp_post); // (the tunnels' and huts' lanterns are the Meshy lamp post's)
    initSecrets();
    this.defs = defs;
    this.built = new Map(); // id -> { group, colliders, lids, blockers, lanterns }
    this.blockersOn = new Set();
    this.save.secrets = Array.isArray(this.save.secrets) ? this.save.secrets.filter((id) => SECRET_LIST.some((s) => s.id === id)) : [];
    this.t = 0;
    this.checkT = 0;
    this.current = null; // secret you are in (for the location name)
    // shader warm-up: one tiny mesh per material the builds use, far under the snow, caught by the boot's
    // renderer.compile and drawn unseen for a few frames (their textures go up to the GPU too), so building a
    // secret later never stalls a frame compiling a program
    if (this.scene && this.defs.length) {
      tunnelMaterials(); featureMaterials(); propMaterials(); lidMaterial();
      const geo = new THREE.BoxGeometry(0.2, 0.2, 0.2), n = geo.attributes.position.count;
      geo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(n * 3).fill(1), 3));
      geo.setAttribute('aData', new THREE.Float32BufferAttribute(new Float32Array(n * 4), 4));
      geo.setAttribute('aMacro', new THREE.Float32BufferAttribute(new Float32Array(n), 1));
      geo.setAttribute('aLight', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
      this.warm = new THREE.Group();
      this.warm.name = 'secrets-warmup';
      for (const m of sharedMaterials()) { const q = new THREE.Mesh(geo, m); q.frustumCulled = false; this.warm.add(q); }
      // the Meshy lanterns' programs: in a tunnel (instanced, interior), at a portal (instanced), on a post
      const lp = this.models?.lamp_post, fx = lanternOnBracket(lp, 0.6), post = lampPost(lp, 2.6);
      if (fx && post) {
        for (const interior of [true, false]) {
          const q = new THREE.InstancedMesh(geo, lanternMaterial(lp, fx, { deSnow: interior, interior }), 1);
          q.frustumCulled = false; this.warm.add(q);
        }
        const q = new THREE.Mesh(geo, lanternMaterial(lp, post, {}));
        q.frustumCulled = false; this.warm.add(q);
      }
      this.warm.position.set(0, -6000, 0);
      this.scene.add(this.warm);
      this.warmFrames = 0;
    }
  }

  get found() { return this.save.secrets; }
  isFound(id) { return this.save.secrets.includes(id); }

  update(dt, { player, camera, env, active = true }) {
    this.t += dt;
    if (this.warm && ++this.warmFrames > 3) { this.scene.remove(this.warm); this.warm.children[0]?.geometry.dispose(); this.warm = null; }
    const cam = camera.position, pp = player.pos;
    // stream: the nearest secret within reach is built a few ms per frame; far ones are dropped
    let want = null, wantD = Infinity;
    for (const d of this.defs) {
      const dc = Math.min(Math.hypot(cam.x - d.center.x, cam.z - d.center.z), Math.hypot(pp.x - d.center.x, pp.z - d.center.z)) - d.radius;
      const b = this.built.get(d.id);
      if (!b && dc < BUILD_R && dc < wantD) { want = d; wantD = dc; }
      else if (b && dc > DROP_R) this.drop(d);
      if (this.job?.def === d && dc > DROP_R) this.job = null;
    }
    if (!this.job && want) this.job = { def: want, it: want.build({ secrets: this }) };
    if (this.job) this.stepJob(this.budgetMs ?? 3);
    // lids follow the terrain LOD; camera blockers only near a tunnel
    for (const [id, b] of this.built) {
      for (const lid of b.lids) updateLidVisibility(lid, this.terrain);
      const d = this.defs.find((q) => q.id === id);
      const near = Math.hypot(pp.x - d.center.x, pp.z - d.center.z) < d.radius + 40;
      for (const bl of b.blockers) {
        const on = this.blockersOn.has(bl);
        if (near && !on) { this.cameraBlockers.push(bl); this.blockersOn.add(bl); }
        else if (!near && on) { const i = this.cameraBlockers.indexOf(bl); if (i >= 0) this.cameraBlockers.splice(i, 1); this.blockersOn.delete(bl); }
      }
      // lanterns: a soft flicker, brighter at dusk
      const night = env ? Math.max(env.nightFactor || 0, 1 - (env.dayFactor ?? 1)) : 0;
      for (let i = 0; i < b.lanterns.length; i++) {
        const m = b.lanterns[i].material;
        m.emissiveIntensity = (1.5 + night * 2.2) * (0.9 + 0.1 * Math.sin(this.t * 7.3 + i * 1.7) * Math.sin(this.t * 3.1 + i));
      }
    }
    // discoveries (4x a second is plenty)
    this.checkT += dt;
    if (this.checkT > 0.25 && active) {
      this.checkT = 0;
      this.current = null;
      for (const d of this.defs) {
        if (Math.abs(pp.x - d.center.x) > d.radius + 30 || Math.abs(pp.z - d.center.z) > d.radius + 30) continue;
        if (d.area?.(pp)) this.current = d;
        if (!this.isFound(d.id) && d.trigger(pp)) this.discover(d);
      }
    }
  }

  // run the current build for up to `budget` ms (the whole build when budget = Infinity)
  stepJob(budget) {
    slice.until = performance.now() + budget; // (the builders' loops yield once it is past)
    try {
      while (this.job && performance.now() < slice.until) {
        const r = this.job.it.next();
        if (r.done) { this.finish(this.job.def, r.value); this.job = null; }
      }
    } finally { slice.until = Infinity; }
  }
  finish(d, b) {
    this.scene.add(b.group);
    b.group.updateMatrixWorld(true);
    this.colliders.push(...b.colliders);
    for (const sf of b.surfaces || []) world.addSurface(sf);
    this.propDetail?.add?.(b.group);
    this.built.set(d.id, b);
  }
  /** build every secret near (x, z) right away (behind a loading card or a fade: teleports, tests) */
  buildNear(x, z, r = BUILD_R) {
    for (const d of this.defs) {
      if (this.built.has(d.id) || Math.hypot(x - d.center.x, z - d.center.z) - d.radius > r) continue;
      if (this.job?.def !== d) this.job = { def: d, it: d.build({ secrets: this }) };
      this.stepJob(Infinity);
    }
  }

  drop(d) {
    const b = this.built.get(d.id);
    if (!b) return;
    this.scene.remove(b.group);
    for (const c of b.colliders) { const i = this.colliders.indexOf(c); if (i >= 0) this.colliders.splice(i, 1); }
    for (const sf of b.surfaces || []) world.removeSurface(sf);
    for (const bl of b.blockers) { const i = this.cameraBlockers.indexOf(bl); if (i >= 0) this.cameraBlockers.splice(i, 1); this.blockersOn.delete(bl); bl.geometry.dispose(); }
    // (geometry is the secret's own unless it is a model's; materials are shared, but carved boards have their
    // own canvas texture)
    b.group.traverse((o) => {
      if (!o.isMesh || o.userData.secretKeep) return;
      o.geometry?.dispose();
      if (o.material?.map?.userData?.secretOwn) o.material.map.dispose();
    });
    this.built.delete(d.id);
  }

  discover(d) {
    this.save.secrets.push(d.id);
    const n = this.save.secrets.length, total = SECRET_LIST.length;
    this.hud.flash(`Secret found · ${d.name} (${n}/${total})`, 'gold', 3400);
    this.earn?.(d.reward || 500);
    // every secret found: the big finder's bonus (Oct 29: $10,000, with five more secrets out there)
    if (n === total) setTimeout(() => { this.hud.flash(`Every secret found · +$${ALL_FOUND_BONUS.toLocaleString('en-US')}`, 'gold', 3800); this.earn?.(ALL_FOUND_BONUS); }, 3800);
    this.writeSave();
  }

  /** the secret you are in, once you have found it (main.js shows it as the location) */
  locationName() { return this.current && this.isFound(this.current.id) ? this.current.name : null; }

  /** found secrets for the trail map */
  mapMarkers() {
    return this.defs.filter((d) => this.isFound(d.id)).map((d) => ({ x: d.center.x, z: d.center.z, label: d.name }));
  }
}
