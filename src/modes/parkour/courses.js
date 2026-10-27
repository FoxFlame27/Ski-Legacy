// World Racing: three purpose-built downhill ski-parkour courses, each on its own mountain around the resort
// (moved there on Oct 27: free ride races them where they stand, see freeworld.js; RACE / WORLD RACING use the
// same spots; the tracks are unchanged, only moved, turned and raised / lowered as a whole). A course = designed track (sections) + region heightfield around it + features (kickers,
// tunnel, bridge, frozen lake, slalom gates, checkpoints) + the meshes that dress it.
//
//   COURSES            cheap definitions for menus (id, name, tagline, difficulty, length, drop, par,
//                      medals)
//   getCourse(id)      the built course (lazy): registers its region / corridor / surfaces in the world
import { world } from '../../world/world.js';
import { makeRamp } from '../../world/ramps.js';
import { smoothstep, mulberry32 } from '../../core/noise.js';
import { Track, DS, BARRIER } from './track.js';
import { CourseRegion, regionBounds } from './region.js';
import { buildCourseMeshes } from './props.js';
import { portalDims } from './structures.js';
import { Track as RaceTrack, referenceTime } from '../race/bots.js';
import { kicker, rollers, DOWNHILL_LAND, BIG_LAND } from './sections.js';
import { NEW_COURSES, NEW_REF_TIMES } from './newcourses.js';
import { lookOf } from './looks.js';

const DEG = Math.PI / 180;
const START_S = 4; // racers line up at the start wand, just in front of the start house
const HOUSE_FRONT = 2.1; // m between the start line and the start house's open front (racers' ski tails clear it)

// ------------------------------------------------------------------ section helpers (sections.js)

// ------------------------------------------------------------------ course designs
// World Cup style: a wide groomed race piste (30-50 m) lined by red B-nets on both sides, tall A-nets
// on the outside of fast turns and above drops (track.js lays them out), narrowing only for the set
// pieces (narrow forest passage, cliff traverse, tunnel, bridge, ice gully).
const ALPINE = {
  id: 'alpine', name: 'Legacy World Downhill', difficulty: 'Hard', theme: 'alpine',
  tagline: 'The World Cup downhill: almost 7 km and 1,400 m of vertical. Forest, cliffs, a tunnel, a gorge bridge and a frozen lake.',
  center: { x: -2848, z: 3941 }, seed: 4101, treeline: 240, peaks: 460,
  track: { x0: -2200, z0: 1000, heading0: Math.PI * 1.08 + 150 * DEG, y0: 690, vd: 28 },
  sections: [
    // start platform (gate + the field lined up abreast), then a steep ramp to get going out of the gate
    { tag: 'start', len: 12, grade: 0.015, smooth: 8, w: 12, side: 'flat', forest: 0, anet: false },
    { tag: 'startRamp', len: 28, grade: 0.34, smooth: 14, w: 12, side: 'flat', forest: 0, anet: false },
    { tag: 'startHang', len: 150, grade: 0.33, smooth: 40, w: 13, side: 'open', vd: 24 },
    { tag: 'traverse', len: 140, turn: 18, grade: 0.2, w: 18, side: 'open' },
    // fast open S-turns above the treeline
    { tag: 'sturns', len: 230, turn: -48, grade: 0.23, w: 22, side: 'open', bank: 4, vd: 30 },
    { tag: 'sturns', len: 240, turn: 56, grade: 0.24, w: 22, side: 'open', bank: 5, vd: 30 },
    { tag: 'sturns', len: 240, turn: -56, grade: 0.23, w: 22, side: 'open', bank: 5, vd: 30 },
    { tag: 'sturns', len: 230, turn: 52, grade: 0.25, w: 22, side: 'open', bank: 5, vd: 30 },
    { tag: 'sturns', len: 220, turn: -40, grade: 0.22, w: 22, side: 'open', vd: 30 },
    { tag: 'sturns', len: 190, turn: 22, grade: 0.21, w: 20, side: 'open', vd: 30 },
    { tag: 'trans', len: 150, grade: 0.2, w: 17, side: 'valley', forest: 0.6 },
    // banked turns through the forest
    { tag: 'banked', len: 160, turn: 86, grade: 0.17, w: 14, bank: 9, side: 'forest', vd: 22 },
    { tag: 'banked', len: 60, grade: 0.19, w: 14, side: 'forest' },
    { tag: 'banked', len: 170, turn: -96, grade: 0.17, w: 14, bank: 9, side: 'forest', vd: 22 },
    { tag: 'banked', len: 60, grade: 0.19, w: 14, side: 'forest' },
    { tag: 'banked', len: 160, turn: 88, grade: 0.17, w: 14, bank: 9, side: 'forest', vd: 22 },
    { tag: 'banked', len: 50, grade: 0.19, w: 14, side: 'forest' },
    { tag: 'banked', len: 150, turn: -76, grade: 0.17, w: 14, bank: 8, side: 'forest', vd: 22 },
    // gates on an open glade
    { tag: 'slalom', len: 560, grade: 0.2, smooth: 60, w: 17, side: 'valley', forest: 0.45 },
    // narrow forest passage
    { tag: 'narrow', len: 320, turn: -40, grade: 0.17, w: 8, side: 'forest', vd: 18 },
    { tag: 'narrowOut', len: 90, turn: -46, grade: 0.17, w: 10, side: 'valley' },
    // traverse across a cliff face: rock wall above, sheer drop below (A-net over the drop)
    { tag: 'cliff', len: 480, turn: 8, grade: 0.13, w: 11, side: ['wall', 'drop'], barrier: ['rock', 'bnet'] },
    { tag: 'tunnelIn', len: 70, turn: 36, grade: 0.14, w: 9, side: 'ridge', anet: false },
    { tag: 'tunnel', len: 130, grade: 0.12, w: 7.5, side: 'ridge', barrier: 'tunnel' },
    { tag: 'tunnelOut', len: 80, turn: 25, grade: 0.15, w: 10, side: 'ridge', anet: false },
    { tag: 'bridgeIn', len: 50, grade: 0.08, w: 8.5, side: 'valley', anet: true },
    { tag: 'bridge', len: 96, grade: 0.06, smooth: 30, w: 8, side: 'valley', barrier: 'railing' },
    { tag: 'bridgeOut', len: 70, grade: 0.12, w: 12, side: 'valley', anet: true },
    // the steepest pitch of the course
    { tag: 'steep', len: 440, turn: -30, grade: 0.3, smooth: 50, w: 20, side: 'forest', forest: 0.75, vd: 30 },
    { tag: 'lakeIn', len: 150, turn: 10, grade: 0.2, smooth: 60, w: 16, side: 'gentle', forest: 0.6 },
    // frozen lake crossing: glare ice between plowed banks
    { tag: 'lake', len: 190, grade: 0, smooth: 24, w: 16, side: 'flat', barrier: 'snowbank', forest: 0.85 },
    { tag: 'lakeOut', len: 100, grade: 0.19, smooth: 30, w: 16, side: 'valley', forest: 0.6 },
    // two big downhill jumps: a small lip on a steep table sends you low and far over steep faces
    ...kicker({ h: 1.6, lip: 9, tableG: 0.36, w: 18, inrun: 40, inG: 0.25, land: DOWNHILL_LAND, out: 50, outG: 0.18 }),
    ...kicker({ h: 2.0, lip: 9, tableG: 0.36, w: 19, inrun: 40, inG: 0.25, land: [[0.6, 4], [0.6, 40], [0.8, 80], [0.5, 30], [0.35, 40]], out: 60, outG: 0.16 }),
    { tag: 'schuss', len: 320, turn: 32, grade: 0.18, w: 22, side: 'forest', forest: 0.6, vd: 30 },
    // the finish slope into the arena
    { tag: 'zielhang', len: 180, grade: 0.33, smooth: 50, w: 24, side: 'arena', vd: 30 },
    { tag: 'finishIn', len: 110, grade: 0.1, smooth: 60, w: 20, side: 'arena', barrier: 'arena' },
    { tag: 'finish', len: 50, grade: 0.012, smooth: 40, w: 18, side: 'arena', barrier: 'arena', forest: 0 },
    { tag: 'runout', len: 140, grade: 0.004, smooth: 40, w: 26, side: 'arena', barrier: 'arena', forest: 0 },
  ],
  finishAt: 30, // finish line meters into the 'finish' section
  checkpointsAt: ['sturns#3', 'sturns#6', 'banked#3', 'slalom', 'narrowOut', 'tunnelOut', 'steep', 'lakeOut', 'kickOut#2', 'zielhang'],
  slalom: { tag: 'slalom', spacing: 70, offset: 1.6 },
  tunnel: { tag: 'tunnel', ridge: 27, extent: 230 },
  tunnelName: 'LEGACY TUNNEL',
  bridge: { tag: 'bridge', depth: 64, floorHalf: 5, wallK: 2.3, len: 520 },
  lake: { tag: 'lake', across: 160, offset: 52, shore: 34 },
};

const ICECANYON = {
  id: 'icecanyon', name: 'Ice Canyon', difficulty: 'Medium', theme: 'ice',
  tagline: 'A glacier downhill: wide open ice-field turns, then a canyon walled by blue ice, a frozen waterfall and an ice tunnel.',
  center: { x: 2596, z: -7507 }, seed: 5207, treeline: 500, peaks: 520,
  track: { x0: 600, z0: -7000, heading0: Math.PI * 1.2 - 60 * DEG, y0: 960, vd: 26 },
  sections: [
    // start platform (gate + the field lined up abreast), then a steep ramp to get going out of the gate
    { tag: 'start', len: 12, grade: 0.015, smooth: 8, w: 12, side: 'flat', forest: 0, anet: false },
    { tag: 'startRamp', len: 28, grade: 0.34, smooth: 14, w: 12, side: 'flat', forest: 0, anet: false },
    { tag: 'dropIn', len: 110, grade: 0.3, smooth: 36, w: 12, side: 'open', vd: 24 },
    // wide glacier turns
    { tag: 'glacier', len: 200, turn: 40, grade: 0.24, w: 18, side: 'open', bank: 4 },
    { tag: 'glacier', len: 210, turn: -55, grade: 0.25, w: 18, side: 'open', bank: 5 },
    { tag: 'glacier', len: 200, turn: 50, grade: 0.24, w: 18, side: 'open', bank: 5 },
    { tag: 'glacier', len: 180, turn: -30, grade: 0.23, w: 16, side: 'open' },
    // the ice cliffs close in: glare-ice chute
    { tag: 'icy', len: 260, turn: 10, grade: 0.22, w: 14, side: [{ kind: 'canyon', stepH: 34 }, { kind: 'canyon', stepH: 30 }], barrier: 'ice', fric: 0.78 },
    { tag: 'banked', len: 140, turn: 95, grade: 0.18, w: 13, bank: 16, side: 'canyon', barrier: 'ice', vd: 18 },
    { tag: 'banked', len: 50, grade: 0.2, w: 13, side: 'canyon', barrier: 'ice' },
    { tag: 'banked', len: 150, turn: -100, grade: 0.18, w: 13, bank: 16, side: 'canyon', barrier: 'ice', vd: 18 },
    { tag: 'banked', len: 50, grade: 0.2, w: 13, side: 'canyon', barrier: 'ice' },
    { tag: 'banked', len: 140, turn: 85, grade: 0.18, w: 13, bank: 15, side: 'canyon', barrier: 'ice', vd: 18 },
    // the canyon opens into a cirque under a frozen waterfall
    { tag: 'falls', len: 220, turn: -20, grade: 0.12, w: 14, side: [{ kind: 'canyon', stepH: 58, stepU0: 4, stepU1: 13 }, { kind: 'gentle', forest: 0.3 }], barrier: ['ice', 'bnet'] },
    { tag: 'chute', len: 230, turn: -15, grade: 0.3, smooth: 40, w: 12, side: 'canyon', barrier: 'ice', fric: 0.82 },
    { tag: 'tunnelIn', len: 60, grade: 0.15, w: 8.5, side: 'ridge', barrier: 'ice', anet: false },
    { tag: 'tunnel', len: 110, grade: 0.13, w: 7, side: 'ridge', barrier: 'tunnel' },
    { tag: 'tunnelOut', len: 60, turn: 20, grade: 0.16, w: 9, side: 'ridge', barrier: 'ice', anet: false },
    { tag: 'slalom', len: 440, turn: -6, grade: 0.22, smooth: 60, w: 15, side: [{ kind: 'canyon', stepH: 20 }, { kind: 'canyon', stepH: 24 }], barrier: 'ice' },
    // ice gully (widened and roughened: grippy enough to carve)
    { tag: 'gully', len: 140, turn: 40, grade: 0.24, w: 8.5, side: 'canyon', barrier: 'ice', fric: 0.82, vd: 16 },
    { tag: 'gully', len: 140, turn: -45, grade: 0.24, w: 8.5, side: 'canyon', barrier: 'ice', fric: 0.82, vd: 16 },
    { tag: 'bends', len: 140, turn: 55, grade: 0.22, w: 14, bank: 12, side: 'canyon', barrier: 'ice' },
    { tag: 'bends', len: 140, turn: -60, grade: 0.22, w: 14, bank: 12, side: 'canyon', barrier: 'ice' },
    { tag: 'exit', len: 320, turn: 25, grade: 0.2, w: 16, side: [{ kind: 'canyon', stepH: 14 }, { kind: 'canyon', stepH: 12 }], barrier: 'ice' },
    // out of the canyon: fast moraine turns and a schuss to the finish
    { tag: 'moraine', len: 300, turn: -30, grade: 0.21, w: 20, side: 'valley', forest: 0.3, vd: 30 },
    { tag: 'schuss', len: 260, turn: 20, grade: 0.18, w: 20, side: 'forest', forest: 0.5, vd: 30 },
    { tag: 'zielhang', len: 160, grade: 0.3, smooth: 50, w: 22, side: 'arena', vd: 30 },
    { tag: 'finishIn', len: 90, grade: 0.08, smooth: 60, w: 20, side: 'arena', barrier: 'arena' },
    { tag: 'finish', len: 50, grade: 0.012, smooth: 40, w: 18, side: 'arena', barrier: 'arena', forest: 0 },
    { tag: 'runout', len: 120, grade: 0.004, smooth: 40, w: 24, side: 'arena', barrier: 'arena', forest: 0 },
  ],
  finishAt: 30,
  checkpointsAt: ['glacier#3', 'icy', 'banked#5', 'chute', 'slalom', 'bends', 'moraine', 'zielhang'],
  slalom: { tag: 'slalom', spacing: 66, offset: 1.4 },
  tunnel: { tag: 'tunnel', ridge: 24, extent: 200, ice: true },
  tunnelName: 'GLACIER TUNNEL',
  waterfall: { tag: 'falls', at: 0.45, side: -1 },
};

const BIGAIR = {
  id: 'bigair', name: 'Big Air Line', difficulty: 'Easy', theme: 'park',
  tagline: 'A wide-open jump downhill: kickers, tabletops, rollers and berms on a 40 m piste, finishing with one huge jump.',
  center: { x: 6396, z: 1784 }, seed: 6311, treeline: 420, peaks: 380,
  track: { x0: 5700, z0: 3900, heading0: Math.PI * 1.06, y0: 940, vd: 26 },
  sections: [
    // start platform (gate + the field lined up abreast), then a steep ramp to get going out of the gate
    { tag: 'start', len: 12, grade: 0.015, smooth: 8, w: 12, side: 'flat', forest: 0, anet: false },
    { tag: 'startRamp', len: 32, grade: 0.3, smooth: 14, w: 12, side: 'flat', forest: 0, anet: false },
    { tag: 'dropIn', len: 100, grade: 0.24, smooth: 34, w: 15, side: 'open' },
    ...rollers({ n: 4, h: 1.1, gap: 16, grade: 0.12, w: 16, side: 'open' }),
    ...kicker({ h: 2.4, lip: 11, tableG: 0.32, w: 16, inrun: 30, inG: 0.18, out: 60, outG: 0.08, land: BIG_LAND, side: 'open' }),
    { tag: 'berm', len: 130, turn: 72, grade: 0.1, w: 15, bank: 18, side: 'open', vd: 17 },
    { tag: 'flow', len: 220, turn: -30, grade: 0.15, w: 18, side: 'open', vd: 26 },
    ...kicker({ type: 'tabletop', h: 2.0, lip: 13, deck: 8, tableG: 0.3, w: 16, inrun: 30, inG: 0.18, out: 60, outG: 0.08, land: BIG_LAND, side: 'open' }),
    // a berm between features scrubs the speed a tabletop carries into the next kicker
    { tag: 'berm', len: 110, turn: 50, grade: 0.1, w: 15, bank: 14, side: 'open', vd: 17 },
    ...kicker({ h: 2.8, lip: 10, tableG: 0.34, w: 16, inrun: 30, inG: 0.18, out: 60, outG: 0.08, land: BIG_LAND, side: 'open' }),
    { tag: 'berm', len: 135, turn: -82, grade: 0.1, w: 15, bank: 18, side: 'open', vd: 17 },
    ...rollers({ n: 5, h: 1.15, gap: 16, grade: 0.12, w: 16 }),
    { tag: 'flow', len: 240, turn: 40, grade: 0.15, w: 18, side: 'valley', forest: 0.5, vd: 26 },
    ...kicker({ type: 'tabletop', h: 2.4, lip: 13, deck: 10, tableG: 0.3, w: 16, inrun: 30, inG: 0.18, out: 60, outG: 0.08, land: BIG_LAND }),
    { tag: 'berm', len: 110, turn: -45, grade: 0.1, w: 15, bank: 14, side: 'valley', vd: 17 },
    ...kicker({ h: 3.0, lip: 11, tableG: 0.34, w: 16, inrun: 30, inG: 0.18, out: 60, outG: 0.08, land: BIG_LAND }),
    { tag: 'berm', len: 125, turn: 64, grade: 0.1, w: 15, bank: 16, side: 'valley', vd: 17 },
    { tag: 'flow', len: 220, turn: -35, grade: 0.15, w: 18, side: 'forest', forest: 0.6, vd: 26 },
    ...kicker({ h: 2.6, lip: 10, tableG: 0.34, w: 16, inrun: 30, inG: 0.18, out: 60, outG: 0.08, land: BIG_LAND, side: 'forest', forest: 0.6 }),
    { tag: 'flow', len: 160, turn: 20, grade: 0.12, w: 18, side: 'forest', forest: 0.6, vd: 26 },
    { tag: 'berm', len: 130, turn: -70, grade: 0.1, w: 15, bank: 16, side: 'valley', vd: 17 },
    { tag: 'flow', len: 240, turn: 45, grade: 0.15, w: 18, side: 'valley', forest: 0.4, vd: 26 },
    ...kicker({ type: 'tabletop', h: 2.2, lip: 13, deck: 9, tableG: 0.3, w: 16, inrun: 30, inG: 0.18, out: 60, outG: 0.08, land: BIG_LAND }),
    { tag: 'berm', len: 125, turn: -60, grade: 0.1, w: 15, bank: 16, side: 'open', vd: 17 },
    // the final huge jump
    { tag: 'bigIn', len: 90, grade: 0.2, smooth: 40, w: 16, side: 'open' },
    ...kicker({ h: 3.4, lip: 10, tableG: 0.36, w: 17, inrun: 30, inG: 0.22, land: [[0.6, 4], [0.6, 40], [0.8, 75], [0.5, 30], [0.35, 40]], out: 50, outG: 0.12, side: 'open' }),
    { tag: 'finishIn', len: 80, grade: 0.07, smooth: 50, w: 18, side: 'arena', barrier: 'arena' },
    { tag: 'finish', len: 50, grade: 0.012, smooth: 40, w: 17, side: 'arena', barrier: 'arena', forest: 0 },
    { tag: 'runout', len: 120, grade: 0.004, smooth: 40, w: 22, side: 'arena', barrier: 'arena', forest: 0 },
  ],
  finishAt: 30,
  checkpointsAt: ['berm', 'berm#2', 'rollers#2', 'berm#4', 'berm#5', 'kickOut#6', 'berm#6', 'kickOut#7', 'berm#7'],
};

const DEFS = { alpine: ALPINE, icecanyon: ICECANYON, bigair: BIGAIR, ...NEW_COURSES };

// Reference (ideal run) times in seconds, measured in Node with referenceTime() on the registered
// courses (tests.mjs prints them). register() recomputes the real value and warns if they drift.
const REF_TIMES = { alpine: 206.21, icecanyon: 138.56, bigair: 169.86, ...NEW_REF_TIMES };
// Medal standards (and par) as multiples of that ideal run: gold needs a strong clean run, silver a
// solid one, bronze is within reach of a casual run with a mistake or two.
export const MEDAL_K = { par: 1.08, gold: 1.1, silver: 1.22, bronze: 1.38 };

// ------------------------------------------------------------------ course object
class Course {
  constructor(def) {
    this.def = def;
    this.id = def.id; this.name = def.name; this.tagline = def.tagline; this.theme = def.theme; this.difficulty = def.difficulty;
    this.track = new Track({ ...def.track, sections: def.sections });
    this.region = null;
    this.registered = false;
    this.group = null;
    const T = this.track;
    this.drop = T.drop;
    const fin = this.section('finish');
    this.finishS = fin.s0 + (def.finishAt ?? 30);
    this.length = this.finishS; // race distance start -> finish line
  }

  // first section with a tag ('tag#2' = second one)
  section(tag) {
    const [t, nth] = tag.split('#');
    let k = 0;
    for (const s of this.track.sections) if (s.tag === t && ++k === (Number(nth) || 1)) return s;
    return null;
  }
  sectionsTagged(tag) { return this.track.sections.filter((s) => s.tag === tag); }

  // Build gameplay data + register the map in the world (once).
  register() {
    if (this.registered) return this;
    this.registered = true;
    const T = this.track, def = this.def;
    T.locate(T.X[0], T.Z[0]); // build the projection grid now

    // --- line samples (contract format)
    this.line = new Array(T.n);
    for (let i = 0; i < T.n; i++) this.line[i] = { s: i * DS, x: T.X[i], z: T.Z[i], y: T.Y[i], w: T.W[i], heading: T.H[i], bank: T.B[i] };

    // --- features
    this.features = [];
    this.ramps = [];
    const feat = (o) => { this.features.push(o); return o; };
    const regionFeatures = { tunnels: [], gorges: [], lakes: [], flats: [] };
    for (const s of T.sections) {
      if (s.tag === 'narrow') feat({ type: 'narrow', s0: s.s0, s1: s.s1 });
      if (s.tag === 'cliff') feat({ type: 'cliff', s0: s.s0, s1: s.s1 });
      if ((s.bank || 0) >= 12) feat({ type: 'bank', s0: s.s0, s1: s.s1, bank: s.bank, turn: s.turn });
    }
    // gates: every section with the slalom tag (a giant slalom sets several gate stretches)
    if (def.slalom) for (const sec of this.sectionsTagged(def.slalom.tag)) feat({ type: 'slalom', s0: sec.s0, s1: sec.s1 });
    // tunnel: ridge + trench in the heightfield, tube/portal meshes in build()
    if (def.tunnel) {
      const sec = this.section(def.tunnel.tag);
      const wIn = T.sAt(T.W, (sec.s0 + sec.s1) / 2) + 0.9;
      const tn = { s0: sec.s0, s1: sec.s1, height: def.tunnel.ridge, extent: def.tunnel.extent, inner: wIn, cutHalf: wIn + 0.75, ice: !!def.tunnel.ice };
      tn.portal = portalDims(tn); // the portal facade, also shaping the ridge face around it (region.js)
      regionFeatures.tunnels.push(tn);
      feat({ type: 'tunnel', s0: sec.s0, s1: sec.s1, halfWidth: wIn, height: 7.4 });
      this.tunnel = tn;
    }
    // bridge over a gorge
    if (def.bridge) {
      const sec = this.section(def.bridge.tag), b = def.bridge;
      const sm = (sec.s0 + sec.s1) / 2;
      const m = T.pointAt(sm, 0);
      const tx = Math.sin(m.heading), tz = Math.cos(m.heading);
      const ax = -tz, az = tx; // gorge axis = the track's right vector
      const g = {
        mx: m.x, mz: m.z, tx, tz, ax, az, len: b.len, floorHalf: b.floorHalf, wallK: b.wallK,
        floorY: m.y - b.depth, depth: b.depth, fall: 0,
      };
      // the ravine meanders away from the bridge (straight right under it)
      const ph = mulberry32(def.seed + 5);
      const p1 = ph() * 6.28, p2 = ph() * 6.28;
      g.meander = (a) => (38 * Math.sin(a / 95 + p1) + 16 * Math.sin(a / 41 + p2) - 38 * Math.sin(p1) - 16 * Math.sin(p2)) * smoothstep(25, 140, Math.abs(a));
      // the floor runs down toward the lower side of the mountain
      const hA = this.trackSideHeight(m, ax, az, 300), hB = this.trackSideHeight(m, -ax, -az, 300);
      g.fall = hA < hB ? 0.07 : -0.07;
      const R = b.len + 140;
      g.box = { minx: m.x - R, maxx: m.x + R, minz: m.z - R, maxz: m.z + R };
      this._gorge = g;
      regionFeatures.gorges.push(g);
      const rim = b.floorHalf + b.depth / b.wallK;
      feat({ type: 'bridge', s0: sec.s0, s1: sec.s1, mid: sm, rim, depth: b.depth });
      this.bridge = { s0: sec.s0, s1: sec.s1, mid: sm, rim, gorge: g, w: T.sAt(T.W, sm) };
    }
    // frozen lake
    if (def.lake) {
      const sec = this.section(def.lake.tag), L = def.lake;
      const sm = (sec.s0 + sec.s1) / 2;
      const m = T.pointAt(sm, 0);
      const tx = Math.sin(m.heading), tz = Math.cos(m.heading), rx = -tz, rz = tx;
      const off = L.offset; // lake center offset to the right of the track
      const cx = m.x + rx * off, cz = m.z + rz * off;
      const a = (sec.s1 - sec.s0) / 2 - 22, bb = L.across;
      const rnd = mulberry32(def.seed + 77);
      const harm = [1, 2, 3, 4, 6, 9].map((k) => ({ k, a: (rnd() - 0.5) * 0.34 / k ** 0.6, p: rnd() * 6.283 }));
      const lake = {
        cx, cz, tx, tz, rx, rz, a, b: bb, off, level: m.y, shore: L.shore, s0: sec.s0, s1: sec.s1,
        // signed distance (approx, m) to the noisy elliptical shore; the shore is exact where the
        // track crosses it so the crossing stays inside the flat stretch of the track
        sdf(x, z) {
          const dx = x - cx, dz = z - cz;
          const lt = dx * tx + dz * tz, ln = dx * rx + dz * rz;
          const q = Math.sqrt((lt / a) ** 2 + (ln / bb) ** 2);
          const ang = Math.atan2(ln / bb, lt / a);
          let nz = 0;
          for (const hm of harm) nz += hm.a * Math.sin(hm.k * ang + hm.p);
          nz *= smoothstep(26, 70, Math.abs(ln + off));
          return (q / (1 + nz) - 1) * Math.min(a, bb);
        },
      };
      const R = Math.max(a, bb) * 1.35 + L.shore + 20;
      lake.box = { minx: cx - R, maxx: cx + R, minz: cz - R, maxz: cz + R };
      regionFeatures.lakes.push(lake);
      // where the track is actually on the ice (inside the shoreline)
      let i0 = -1, i1 = -1;
      for (let s = sec.s0 - 30; s < sec.s1 + 30; s += 0.5) {
        const p = T.pointAt(s, 0);
        if (lake.sdf(p.x, p.z) < -0.6) { if (i0 < 0) i0 = s; i1 = s; }
      }
      lake.ice0 = i0; lake.ice1 = i1;
      feat({ type: 'lake', s0: i0, s1: i1, level: m.y });
      this.lake = lake;
    }
    // flat pads: start house platform, finish arena structures
    const start = T.pointAt(START_S, 0);
    this.start = { s: START_S, x: start.x, z: start.z, y: start.y, heading: start.heading };
    const f = T.pointAt(this.finishS, 0);
    this.finish = { s: this.finishS, x: f.x, z: f.z, y: f.y, heading: f.heading };
    this.flats = regionFeatures.flats;
    this.planStructures();

    // --- region (replaces the placeholder that reserved the area at load) + corridor
    this.region = new CourseRegion(T, { id: def.id, seed: def.seed, center: def.center, treeline: def.treeline, peaks: def.peaks, features: regionFeatures, ...(lookOf(def.id).terrain || {}) });
    const slot = world.regions.indexOf(this.placeholder);
    if (slot >= 0) world.regions[slot] = this.region; else world.addRegion(this.region);
    if (!this.corridorAdded) this.addCorridor();
    // keep the frozen lake clear of trees and boulders: tree-clearing (ungroomed) corridors over the ice
    if (this.lake) {
      const L = this.lake, lines = [];
      for (let o = -L.b; o <= L.b; o += 40) {
        if (Math.abs(o + L.off) < 35) continue; // the race corridor itself covers the track across the ice
        lines.push([[L.cx - L.tx * L.a * 1.1 + L.rx * o, L.cz - L.tz * L.a * 1.1 + L.rz * o], [L.cx + L.tx * L.a * 1.1 + L.rx * o, L.cz + L.tz * L.a * 1.1 + L.rz * o]]);
      }
      for (const ln of lines) world.addCorridor(ln, 24, 'lift');
    }

    // --- ramps (kickers, tabletops, rollers) on the track; their surfaces are walkable
    for (const s of T.sections) {
      if (s.ramp) {
        const r = s.ramp;
        const sb = s.s0 + r.base;
        const p = T.pointAt(sb, 0);
        const w = T.sAt(T.W, sb);
        const opts = { x: p.x, z: p.z, heading: p.heading, type: r.type, height: r.h, lip: r.lip, width: Math.max(5, 2 * w - 1.2), deckLength: r.deck };
        const ramp = makeRamp(opts);
        ramp.opts = opts;
        ramp.mesh.material.userData.shared = true; // ramps.js shares one snow material
        const lipS = sb + (r.type === 'tabletop' ? ramp.params.upLen : ramp.params.length);
        this.ramps.push(ramp);
        feat({ type: r.type, s0: sb, s1: sb + ramp.params.length, lipS, lip: ramp.lip.clone(), height: r.h, lipDeg: r.lip, width: ramp.params.width, land0: s.s1, land1: this.landingEnd(s), ramp });
      }
      if (s.rollers) {
        const r = s.rollers;
        for (let k = 0; k < r.n; k++) {
          const sb = s.s0 + r.gap + k * (r.len + r.gap);
          const p = T.pointAt(sb, 0);
          const w = T.sAt(T.W, sb);
          const opts = { x: p.x, z: p.z, heading: p.heading, type: 'roller', height: r.h, width: Math.max(5, 2 * w - 1.2), length: r.len };
          const ramp = makeRamp(opts);
          ramp.opts = opts;
          ramp.mesh.material.userData.shared = true;
          this.ramps.push(ramp);
          feat({ type: 'roller', s0: sb, s1: sb + r.len, height: r.h, ramp });
        }
      }
    }
    // takeoff data for bots / replays: the real lip angle from the built surface (+ up, - down)
    for (const f of this.features) {
      if (!f.lipS) continue;
      const hd = f.ramp.params.heading, fx = Math.sin(hd), fz = Math.cos(hd), L = f.lip;
      const y1 = world.groundHeight(L.x - fx * 0.4, L.z - fz * 0.4, L.y + 1), y0 = world.groundHeight(L.x - fx * 0.8, L.z - fz * 0.8, L.y + 1);
      f.takeoffAngle = Math.atan2(y1 - y0, 0.4);
      f.lipY = L.y;
    }
    // --- bridge deck: a walkable surface over the gorge
    if (this.bridge) this.registerBridgeSurface();

    // --- checkpoints (index 0 = start), gates
    this.checkpoints = [{ index: 0, ...this.start, name: 'START' }];
    const cps = [];
    for (const tag of def.checkpointsAt || []) {
      const sec = this.section(tag);
      if (sec) cps.push(sec.s0 + Math.min(14, sec.len * 0.2));
    }
    cps.sort((a, b) => a - b);
    let k = 1;
    for (const s of cps) {
      // in course order, at least 250 m apart and clear of the finish
      if (s - this.checkpoints[this.checkpoints.length - 1].s < 250 || this.finishS - s < 200) continue;
      const p = T.pointAt(s, 0);
      this.checkpoints.push({ index: k, s, x: p.x, z: p.z, y: p.y, heading: p.heading, name: `CHECKPOINT ${k}` });
      k++;
    }
    this.gates = [];
    if (def.slalom) {
      const sp = def.slalom.spacing;
      let side = 1, n = 0;
      for (const sec of this.sectionsTagged(def.slalom.tag)) for (let s = sec.s0 + sp; s < sec.s1 - 15; s += sp) {
        // no gate where the piste bends or narrows (a gate there forces a sharp zig-zag)
        if (Math.abs(T.sAt(T.K, s)) > 1 / 280 || T.sAt(T.W, s) < 11) continue;
        const p = T.pointAt(s, 0);
        const rx = -Math.cos(p.heading), rz = Math.sin(p.heading);
        const w = T.sAt(T.W, s);
        const off = side * Math.min(def.slalom.offset, w - 6);
        const q = T.pointAt(s, off);
        this.gates.push({ s, x: q.x, z: q.z, y: q.y, side, color: n % 2 ? 'blue' : 'red', nx: rx, nz: rz, width: 8 });
        side = -side; n++;
      }
    }
    if (def.waterfall) {
      const sec = this.section(def.waterfall.tag);
      this.waterfall = { s: sec.s0 + sec.len * def.waterfall.at, side: def.waterfall.side };
    }
    this.dhGates = this.planDownhillGates();
    // --- par time + medal standards from the race AI's ideal reference run (racing line, tucked,
    // 'pro' race skis): the same physics the bots and the time trial are rated with, so the targets are
    // reachable and consistent across courses
    let ref = REF_TIMES[this.id];
    try { ref = referenceTime(new RaceTrack(this), { speed: 1.06, grip: 1.16 }); } catch (e) { console.warn('World Racing: reference run failed, using the stored reference time', e); }
    this.setTimes(ref);
    return this;
  }

  // rough terrain height `d` m to one side of a track point (the track's own design, before the region)
  trackSideHeight(m, dx, dz, d) {
    const T = this.track;
    // nearest centreline samples on that side give the valley's general slope
    let best = 0, bd = Infinity;
    const x = m.x + dx * d, z = m.z + dz * d;
    for (let i = 0; i < T.n; i += 5) { const e = (T.X[i] - x) ** 2 + (T.Z[i] - z) ** 2; if (e < bd) { bd = e; best = i; } }
    return T.Y[best];
  }

  // end of the landing hill after a jump table (knuckle + faces + transition)
  landingEnd(table) {
    const secs = this.track.sections;
    let k = secs.indexOf(table) + 1;
    while (k < secs.length && (secs[k].tag === 'kickLand' || secs[k].tag === 'kickTrans')) k++;
    return secs[k - 1].s1;
  }

  // Where the start house and finish-area buildings stand (flattened pads in the region).
  planStructures() {
    const T = this.track, st = this.start;
    const flat = (x, z, yaw, hw, hd, h, blend = 10) => {
      const f = { x, z, cos: Math.cos(yaw), sin: Math.sin(yaw), hw, hd, h, blend, reach: Math.max(hw, hd) * 1.5 + blend };
      this.flats.push(f);
      return f;
    };
    // start house on the plateau behind the gate: its open front HOUSE_FRONT m behind the start line, clear
    // of the ski tails of the racers lined up abreast (props.js seats the real model by its own depth)
    const hs = START_S - HOUSE_FRONT - 2.2;
    const hp = T.pointAt(hs, 0);
    this.startHouse = { x: hp.x, z: hp.z, y: T.surfaceY(hs, 0), heading: st.heading, s: hs, front: START_S - HOUSE_FRONT };
    // finish arena: grandstand on the left, timing board + patrol hut on the right
    const fs = this.finishS;
    const w = T.sAt(T.W, fs);
    const mk = (s, lat, out = {}) => {
      const p = T.pointAt(s, lat);
      out.x = p.x; out.z = p.z; out.heading = p.heading; out.y = T.surfaceY(s, Math.sign(lat) * w);
      return out;
    };
    this.arena = {
      grandstand: mk(fs + 30, -(w + 14.5)),
      grandstand2: mk(fs - 34, -(w + 14)),
      board: mk(fs + 8, w + 11),
      hut: mk(fs + 52, w + 14),
    };
    const A = this.arena;
    flat(A.grandstand.x, A.grandstand.z, -A.grandstand.heading, 15, 12.5, A.grandstand.y, 12);
    flat(A.grandstand2.x, A.grandstand2.z, -A.grandstand2.heading, 13, 12.5, A.grandstand2.y, 12);
    flat(A.board.x, A.board.z, -A.board.heading, 7, 4, A.board.y, 10);
    flat(A.hut.x, A.hut.z, -A.hut.heading, 6, 6, A.hut.y, 10);
  }

  // Reserve the map area as soon as the game loads (cheap): procedural races / lifts never spawn
  // inside it, and the groomed corridor exists before any terrain there is generated. The terrain
  // stays the procedural world until the course is built (getCourse).
  reserve() {
    if (this.placeholder) return;
    const bounds = regionBounds(this.track, this.def.center);
    this.placeholder = { id: this.id + '-reserved', bounds, height: (x, z, spacing) => world.baseHeight(x, z, spacing) };
    world.addRegion(this.placeholder);
    this.addCorridor();
  }

  addCorridor() {
    this.corridorAdded = true;
    const T = this.track;
    // consecutive runs of similar width share one corridor (6 m segments). The corridor spans the
    // whole barrier zone (track.CLR: B-nets, A-nets and their clearance), so vegetation keeps trees and
    // boulders outside the nets; the groomed shading fades out just past the B-nets.
    let run = [], wRun = -1;
    const flush = () => { if (run.length > 1) world.addCorridor(run, wRun, 'race', { name: this.name, course: this.id }); };
    for (let i = 0; i < T.n; i += 3) {
      const w = Math.round(T.W[i] + Math.max(1.6, Math.max(T.CLR[0][i], T.CLR[1][i]) - 3));
      if (wRun >= 0 && Math.abs(w - wRun) > 0.5) { run.push([T.X[i], T.Z[i]]); flush(); run = [run[run.length - 1]]; }
      wRun = w;
      run.push([T.X[i], T.Z[i]]);
    }
    run.push([T.X[T.n - 1], T.Z[T.n - 1]]);
    flush();
  }

  registerBridgeSurface() {
    const T = this.track, B = this.bridge;
    const s0 = B.mid - B.rim - 12, s1 = B.mid + B.rim + 12;
    B.deck0 = s0; B.deck1 = s1;
    let mnx = Infinity, mxx = -Infinity, mnz = Infinity, mxz = -Infinity;
    for (let s = s0; s <= s1; s += 2) for (const l of [-B.w - 2, B.w + 2]) {
      const p = T.pointAt(s, l);
      mnx = Math.min(mnx, p.x); mxx = Math.max(mxx, p.x); mnz = Math.min(mnz, p.z); mxz = Math.max(mxz, p.z);
    }
    const self = this;
    this.bridgeSurface = {
      bounds: { minx: mnx, maxx: mxx, minz: mnz, maxz: mxz },
      feature: 'bridge',
      height(x, z) {
        const p = T.locate(x, z, (s0 + s1) / 2);
        if (p.far || p.s < s0 || p.s > s1) return null;
        const w = T.sAt(T.W, p.s) + 0.4;
        if (Math.abs(p.v) > w) return null;
        return T.surfaceY(p.s, p.v) + self.deckLift(p.s);
      },
    };
    world.addSurface(this.bridgeSurface);
  }
  // deck top sits a hair above the track profile mid-span, flush (embedded) at both abutments
  deckLift(s) {
    const B = this.bridge;
    return 0.04 * smoothstep(B.deck0, B.deck0 + 3, s) * (1 - smoothstep(B.deck1 - 3, B.deck1, s));
  }

  // ------------------------------------------------------------------ gameplay API
  // Projection onto the centerline: { s, lateral, w, y, heading, inside }
  project(x, z, hintS, out = {}) {
    const T = this.track;
    const p = T.locate(x, z, hintS ?? -1);
    if (p.far) {
      // far from the course: fall back to a global search
      const q = T.locate(x, z, -1);
      if (q.far) { out.s = 0; out.lateral = 1e4; out.w = T.W[0]; out.y = T.Y[0]; out.heading = T.H[0]; out.inside = false; out.far = true; return out; }
    }
    const i = p.i, t = p.t;
    out.s = p.s; out.lateral = p.v; out.far = false;
    out.w = T.W[i] + (T.W[i + 1] - T.W[i]) * t;
    out.y = T.surfaceY(p.s, p.v) + (this.bridge && p.s > this.bridge.deck0 && p.s < this.bridge.deck1 ? this.deckLift(p.s) : 0);
    out.heading = T.H[i] + (T.H[i + 1] - T.H[i]) * t;
    out.inside = Math.abs(p.v) <= out.w;
    return out;
  }

  pointAt(s, lateral = 0, out = {}) { return this.track.pointAt(s, lateral, out); }

  // Ice / glare sections: grip multiplier (1 = normal snow, ~0.6 on the frozen lake)
  frictionAt(s) {
    let f = this.track.sAt(this.track.FR, s);
    const L = this.lake;
    if (L && s > L.ice0 - 3 && s < L.ice1 + 3) f = Math.min(f, 1 - 0.4 * smoothstep(L.ice0 - 3, L.ice0 + 1, s) * (1 - smoothstep(L.ice1 - 1, L.ice1 + 3, s)));
    return f;
  }

  // Barrier collision: keeps the skier inside the track width (barriers on both sides). Reflects and
  // damps the lateral velocity; returns the impact speed so callers can crash on big hits.
  constrain(pos, vel, hintS) {
    const T = this.track;
    const res = this._cres || (this._cres = { hit: false, side: 0, impact: 0, s: 0 });
    res.hit = false; res.side = 0; res.impact = 0;
    const p = T.locate(pos.x, pos.z, hintS ?? -1);
    if (p.far) return res;
    res.s = p.s;
    const i = p.i, t = p.t;
    const w = T.W[i] + (T.W[i + 1] - T.W[i]) * t;
    const lim = w - 0.3;
    const av = Math.abs(p.v);
    // closing boards at the end of the finish run-out
    const sMax = T.length - 2.2;
    if (p.s > sMax && av < w + 9) {
      const tx = Math.sin(T.H[T.n - 1]), tz = Math.cos(T.H[T.n - 1]);
      const along = p.s - sMax;
      pos.x -= tx * along; pos.z -= tz * along;
      const vt = vel.x * tx + vel.z * tz;
      if (vt > 0) { vel.x -= tx * vt * 1.25; vel.z -= tz * vt * 1.25; res.impact = vt; }
      res.hit = true; res.side = 0;
      if (av <= lim) return res;
    }
    if (av <= lim || av > w + 9) return res; // inside, or far off the course (respawn handles that)
    const side = p.v > 0 ? 1 : -1;
    // segment frame
    const ex = T.X[i + 1] - T.X[i], ez = T.Z[i + 1] - T.Z[i], el = Math.sqrt(ex * ex + ez * ez) || 1;
    const rx = -ez / el, rz = ex / el; // right of travel
    const push = av - lim;
    pos.x -= rx * push * side; pos.z -= rz * push * side;
    const vl = vel.x * rx + vel.z * rz; // lateral velocity (+ right)
    if (vl * side > 0) {
      const impact = Math.abs(vl);
      const e = impact > 8 ? 0.18 : 0.32; // restitution: hard hits bounce less (energy goes into the nets)
      vel.x -= rx * vl * (1 + e); vel.z -= rz * vl * (1 + e);
      // scrub some speed along the barrier, more for harder hits
      const keep = Math.max(0.55, 1 - impact * 0.035);
      const vt = vel.x * (ex / el) + vel.z * (ez / el);
      vel.x -= (ex / el) * vt * (1 - keep); vel.z -= (ez / el) * vt * (1 - keep);
      res.impact = impact;
    }
    res.hit = true; res.side = side;
    return res;
  }

  // Par and medal standards from the reference time of an ideal run (seconds, 0.1 s steps).
  setTimes(ref) {
    const r = (t) => Math.round(t * 10) / 10;
    this.refTime = ref;
    this.par = r(ref * MEDAL_K.par);
    this.medals = { gold: r(ref * MEDAL_K.gold), silver: r(ref * MEDAL_K.silver), bronze: r(ref * MEDAL_K.bronze) };
    const known = REF_TIMES[this.id];
    if (known && Math.abs(known / ref - 1) > 0.01) console.warn(`World Racing: ${this.id} reference time ${ref.toFixed(1)} s differs from the menu table (${known} s)`);
  }

  // Downhill gates (visual): pairs of red panels at both piste edges with a blue dye line across, at
  // every turn apex of the open race piste and at least every ~130 m, clear of the set pieces.
  planDownhillGates() {
    const T = this.track, out = [];
    const busy = (s) => s < 70 || s > this.finishS - 70
      || this.features.some((f) => ['kicker', 'tabletop', 'roller', 'tunnel', 'bridge', 'lake', 'slalom', 'narrow'].includes(f.type) && s > f.s0 - 25 && s < (f.land1 ?? f.s1) + 15)
      || this.checkpoints.some((c) => Math.abs(c.s - s) < 30)
      || (this.tunnel && s > this.tunnel.s0 - 40 && s < this.tunnel.s1 + 40)
      || (this.bridge && s > this.bridge.deck0 - 30 && s < this.bridge.deck1 + 30);
    const ok = (s) => !busy(s) && T.sAt(T.W, s) >= 8 && !out.some((g) => Math.abs(g.s - s) < 400);
    // apexes of the real bends only: local maxima of |curvature| over +-30 m (no flags on straights)
    for (let i = 15; i < T.n - 15; i++) {
      const k = Math.abs(T.K[i]);
      if (k < 1 / 300) continue;
      let peak = true;
      for (let j = i - 15; j <= i + 15; j++) if (Math.abs(T.K[j]) > k) { peak = false; break; }
      if (peak && ok(i * DS)) out.push({ s: i * DS });
    }
    out.sort((a, b) => a.s - b.s);
    return out;
  }

  // ------------------------------------------------------------------ meshes
  build(scene, models = {}) {
    if (!this.registered) this.register();
    if (this.group) { if (!this.group.parent) scene.add(this.group); return this.group; }
    this.group = buildCourseMeshes(this, models);
    for (const r of this.ramps) {
      if (!r.mesh.geometry.attributes.position) {
        // rebuilt after a dispose: fresh mesh, same registered surface
        r.mesh = makeRamp({ ...r.opts, register: false }).mesh;
        r.mesh.material.userData.shared = true;
      }
      this.group.add(r.mesh);
    }
    scene.add(this.group);
    return this.group;
  }

  dispose() {
    if (!this.group) return;
    this.group.parent?.remove(this.group);
    const seen = new Set();
    this.group.traverse((o) => {
      if (o.geometry && !seen.has(o.geometry)) { seen.add(o.geometry); if (!o.userData.keepGeometry) o.geometry.dispose(); }
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of mats) {
        if (seen.has(m) || m.userData?.shared) continue;
        seen.add(m);
        for (const key of ['map', 'alphaMap', 'emissiveMap']) if (m[key] && !m[key].userData?.shared) m[key].dispose();
        m.dispose();
      }
    });
    for (const r of this.ramps) r.mesh = { geometry: { attributes: {} } };
    this.group = null;
  }
}

// ------------------------------------------------------------------ exports
const cache = new Map();
const meta = new Map();

// Reserve every course's map area at load (see Course.reserve).
for (const d of Object.values(DEFS)) {
  const c = new Course(d);
  c.reserve();
  meta.set(d.id, c);
}

// Cheap definitions for menus: length / drop come from the designed track.
// par / medals: the built course's values, or (before it is built) the reference times measured by
// the Node tests with the same race physics (REF_TIMES), so menus can show the targets instantly.
export const COURSES = Object.values(DEFS).map((d) => ({
  id: d.id, name: d.name, tagline: d.tagline, theme: d.theme, difficulty: d.difficulty, center: d.center,
  get length() { return courseMeta(d.id).length; },
  get drop() { return courseMeta(d.id).drop; },
  get par() { return timesOf(d.id).par; },
  get medals() { return timesOf(d.id).medals; },
}));

function timesOf(id) {
  const c = cache.get(id);
  if (c?.medals) return c;
  const ref = REF_TIMES[id], r = (t) => Math.round(t * 10) / 10;
  return { par: r(ref * MEDAL_K.par), medals: { gold: r(ref * MEDAL_K.gold), silver: r(ref * MEDAL_K.silver), bronze: r(ref * MEDAL_K.bronze) } };
}

function courseMeta(id) {
  if (cache.has(id)) return cache.get(id);
  if (!meta.has(id)) meta.set(id, new Course(DEFS[id]));
  return meta.get(id);
}

// The built course: track, region, corridor, surfaces registered in the world (lazy, cached).
export function getCourse(id) {
  if (!DEFS[id]) throw new Error('Unknown course ' + id);
  if (!cache.has(id)) {
    const c = meta.get(id) || new Course(DEFS[id]);
    meta.delete(id);
    c.register();
    cache.set(id, c);
  }
  return cache.get(id);
}

// Models the courses can use (all optional; procedural fallbacks exist). main.js may preload these.
// (the START / FINISH arches and the safety nets are procedural, in the house style)
// (the tunnel portals are procedural stonework now: the Meshy 'tunnel_portal' arch is no longer loaded)
export const COURSE_MODELS = ['grandstand', 'timing_board', 'start_house', 'patrol_hut', 'lamp_post', 'snow_cannon', 'snowmobile'];

export { DEFS as COURSE_DEFS, Course, BARRIER };
