// Three EXPERT World Racing courses (Oct 29, the user: "3 more races where you can earn 10k but very hard"), each on
// untouched mountains far out in the ranges (no lift, road or express there: the helicopter flies you to the start
// house, freeworld.js lists them like the others). Built with the same kit as courses.js / newcourses.js: World Cup
// nets on both sides all the way, START / CHECKPOINT / FINISH arches, the finish arena, a start house. Designed to be
// hard: long, steep pitches (up to ~23 degrees), tight banked hairpins, narrow chutes and ice gullies barely wider
// than a racer's line, tight slalom gates set well off the line, and three jumps each. Their purse (the Medium AI
// field's 1st prize, freeworld.js) is $4,000: against the Superhard field a win pays $10,000.
//
//   devilsridge  Devil's Ridge Extreme     south-west range   knife-edge ridge, hairpins, a cliff traverse, 3 jumps
//   wolfgorge    Wolf Gorge Slalom         south-east range   tight slalom stretches, an ice gorge and a tunnel
//   skyfang      Sky Fang Downhill         eastern range      a glare-ice face, super-G gates, ice gullies, 3 jumps
import { kicker, rollers, DOWNHILL_LAND } from './sections.js';

const START = [{ tag: 'start', len: 12, grade: 0.015, smooth: 8, w: 13, side: 'flat', forest: 0, anet: false }];
const ramp = (grade = 0.4, len = 30) => ({ tag: 'startRamp', len, grade, smooth: 14, w: 13, side: 'flat', forest: 0, anet: false });
const ARENA = (inLen = 110, inGrade = 0.1, runout = 140) => [
  { tag: 'finishIn', len: inLen, grade: inGrade, smooth: 60, w: 20, side: 'arena', barrier: 'arena' },
  { tag: 'finish', len: 50, grade: 0.012, smooth: 40, w: 18, side: 'arena', barrier: 'arena', forest: 0 },
  { tag: 'runout', len: runout, grade: 0.004, smooth: 40, w: 22, side: 'arena', barrier: 'arena', forest: 0 },
];
const BIG = [[0.6, 4], [0.62, 40], [0.82, 80], [0.5, 30], [0.35, 40]]; // (a long landing hill for the fast jumps)
// a tight banked hairpin pair with a short link between (R ~ 40 m: you scrub speed or go into the nets)
const hairpins = (a, b, o = {}) => [
  { tag: 'hairpin', len: 86, turn: a, grade: 0.2, w: 11, bank: 14, side: o.side || 'forest', vd: 16, ...o },
  { tag: 'hairpinLink', len: 36, grade: 0.24, w: 11, side: o.side || 'forest', ...o },
  { tag: 'hairpin', len: 86, turn: b, grade: 0.2, w: 11, bank: 14, side: o.side || 'forest', vd: 16, ...o },
];

const DEVILSRIDGE = {
  id: 'devilsridge', name: "Devil's Ridge Extreme", difficulty: 'Expert', theme: 'bigmountain', purse: 4000,
  tagline: 'Expert only: a 42 % start pitch, a knife-edge ridge between two drops, tight banked hairpins, a cliff traverse, an ice fall and three big jumps.',
  center: { x: -8600, z: -7590 }, seed: 8101, treeline: 120, peaks: 720,
  track: { x0: -8050, z0: -5320, heading0: Math.PI, y0: 1760, vd: 30 },
  sections: [
    ...START, ramp(0.42),
    { tag: 'startHang', len: 160, grade: 0.42, smooth: 40, w: 12, side: 'open', vd: 26 },
    { tag: 'sturns', len: 200, turn: -62, grade: 0.34, w: 16, side: 'open', bank: 6, vd: 28 },
    { tag: 'sturns', len: 200, turn: 70, grade: 0.35, w: 16, side: 'open', bank: 6, vd: 28 },
    { tag: 'sturns', len: 190, turn: -60, grade: 0.34, w: 16, side: 'open', bank: 6, vd: 28 },
    ...kicker({ h: 1.8, lip: 9, tableG: 0.38, w: 15, inrun: 40, inG: 0.28, land: DOWNHILL_LAND, out: 50, outG: 0.2, side: 'open' }),
    // the knife-edge: the ridge falls away on both sides, A-nets over both drops
    { tag: 'ridge', len: 300, turn: 10, grade: 0.22, w: 9, side: ['drop', 'drop'], barrier: 'bnet', vd: 24 },
    { tag: 'ridgeOut', len: 100, turn: -35, grade: 0.25, w: 11, side: 'valley' },
    ...hairpins(112, -116),
    { tag: 'hairpinLink', len: 36, grade: 0.24, w: 11, side: 'forest' },
    { tag: 'hairpin', len: 86, turn: 100, grade: 0.2, w: 11, bank: 14, side: 'forest', vd: 16 },
    // the wall: the steepest pitch, straight down the fall line
    { tag: 'wall', len: 300, turn: -14, grade: 0.4, smooth: 40, w: 16, side: 'open', vd: 30 },
    ...kicker({ h: 2.2, lip: 9, tableG: 0.38, w: 18, inrun: 40, inG: 0.26, land: BIG, out: 60, outG: 0.18 }),
    { tag: 'gates', len: 420, grade: 0.3, smooth: 60, w: 14, side: 'forest', forest: 0.5 },
    { tag: 'chute', len: 260, turn: 40, grade: 0.28, w: 7.5, side: 'forest', vd: 18 },
    { tag: 'chuteOut', len: 90, turn: -42, grade: 0.24, w: 10, side: 'valley' },
    { tag: 'cliff', len: 300, turn: -8, grade: 0.16, w: 9, side: ['wall', 'drop'], barrier: ['rock', 'bnet'] },
    { tag: 'icefall', len: 200, turn: 30, grade: 0.34, w: 12, side: 'canyon', barrier: 'ice', fric: 0.8, vd: 22 },
    { tag: 'sturns', len: 150, turn: -44, grade: 0.3, w: 15, side: 'forest', bank: 6, vd: 26 },
    { tag: 'gates', len: 340, turn: -6, grade: 0.31, smooth: 60, w: 14, side: 'forest', forest: 0.6 },
    ...rollers({ n: 5, h: 1.4, gap: 14, grade: 0.26, w: 14, side: 'forest' }),
    ...kicker({ h: 2.0, lip: 9, tableG: 0.36, w: 18, inrun: 40, inG: 0.25, land: BIG, out: 60, outG: 0.16 }),
    { tag: 'zielhang', len: 180, grade: 0.36, smooth: 50, w: 22, side: 'arena', vd: 30 },
    ...ARENA(),
  ],
  finishAt: 30,
  checkpointsAt: ['sturns#3', 'ridge', 'hairpin#3', 'wall', 'gates', 'cliff', 'icefall', 'gates#2', 'rollers', 'kickOut#3'],
  slalom: { tag: 'gates', spacing: 34, offset: 3.2 },
};

const WOLFGORGE = {
  id: 'wolfgorge', name: 'Wolf Gorge Slalom', difficulty: 'Expert', theme: 'forest', purse: 4000,
  tagline: 'Expert only: three long stretches of tight slalom gates on a steep forest face, an ice gorge, a tunnel, hairpins and a narrow chute.',
  center: { x: 9050, z: -10100 }, seed: 8203, treeline: 260, peaks: 620,
  track: { x0: 8600, z0: -8320, heading0: Math.PI, y0: 1760, vd: 26 },
  sections: [
    ...START, ramp(0.4),
    { tag: 'dropIn', len: 120, grade: 0.38, smooth: 36, w: 13, side: 'forest', forest: 0.4, vd: 24 },
    { tag: 'slalom', len: 520, turn: -6, grade: 0.32, smooth: 60, w: 14, side: 'forest', forest: 0.8 },
    { tag: 'bend', len: 96, turn: 100, grade: 0.22, w: 11, bank: 14, side: 'forest', vd: 16 },
    { tag: 'slalom', len: 480, turn: 6, grade: 0.33, smooth: 60, w: 14, side: 'forest', forest: 0.8 },
    // the gorge: blue-ice walls either side, barely wider than a racing line
    { tag: 'gorge', len: 240, turn: -64, grade: 0.28, w: 8, side: 'canyon', barrier: 'ice', fric: 0.8, vd: 18 },
    { tag: 'gorge', len: 200, turn: -36, grade: 0.28, w: 8, side: 'canyon', barrier: 'ice', fric: 0.8, vd: 18 },
    { tag: 'tunnelIn', len: 60, grade: 0.16, w: 8.5, side: 'ridge', barrier: 'ice', anet: false },
    { tag: 'tunnel', len: 120, grade: 0.14, w: 7, side: 'ridge', barrier: 'tunnel' },
    { tag: 'tunnelOut', len: 60, turn: 20, grade: 0.18, w: 9, side: 'ridge', barrier: 'ice', anet: false },
    { tag: 'steep', len: 300, turn: -10, grade: 0.4, smooth: 40, w: 16, side: 'open', vd: 28 },
    ...kicker({ h: 2.0, lip: 9, tableG: 0.38, w: 16, inrun: 40, inG: 0.26, land: BIG, out: 60, outG: 0.18, side: 'open' }),
    ...hairpins(-110, 106),
    { tag: 'slalom', len: 460, grade: 0.32, smooth: 60, w: 14, side: 'forest', forest: 0.8 },
    { tag: 'chute', len: 240, turn: -35, grade: 0.3, w: 7.5, side: 'forest', vd: 18 },
    { tag: 'chuteOut', len: 80, turn: 30, grade: 0.22, w: 11, side: 'valley' },
    ...rollers({ n: 6, h: 1.5, gap: 12, grade: 0.28, w: 13, side: 'forest' }),
    ...kicker({ h: 1.8, lip: 9, tableG: 0.36, w: 18, inrun: 40, inG: 0.25, land: DOWNHILL_LAND, out: 50, outG: 0.16 }),
    { tag: 'zielhang', len: 160, grade: 0.34, smooth: 50, w: 22, side: 'arena', vd: 28 },
    ...ARENA(100, 0.1, 130),
  ],
  finishAt: 30,
  checkpointsAt: ['slalom', 'bend', 'slalom#2', 'gorge#2', 'tunnelOut', 'steep', 'hairpin#2', 'slalom#3', 'chuteOut', 'rollers'],
  slalom: { tag: 'slalom', spacing: 32, offset: 3.4 },
  tunnel: { tag: 'tunnel', ridge: 24, extent: 200, ice: true },
  tunnelName: 'WOLF GORGE TUNNEL',
};

const SKYFANG = {
  id: 'skyfang', name: 'Sky Fang Downhill', difficulty: 'Expert', theme: 'glacier', purse: 4000,
  tagline: 'Expert only: a glare-ice start face, super-G gates set wide off the line, two ice gullies, a cliff traverse, hairpins and three big jumps.',
  center: { x: 11360, z: 220 }, seed: 8307, treeline: 160, peaks: 700,
  track: { x0: 11500, z0: -1820, heading0: 0, y0: 1480, vd: 30 },
  sections: [
    ...START, ramp(0.44),
    { tag: 'iceFace', len: 200, grade: 0.42, smooth: 40, w: 14, side: 'open', fric: 0.85, vd: 30 },
    { tag: 'sturns', len: 220, turn: 58, grade: 0.36, w: 16, side: 'open', bank: 6, vd: 28 },
    { tag: 'sturns', len: 220, turn: -64, grade: 0.36, w: 16, side: 'open', bank: 6, vd: 28 },
    ...kicker({ h: 2.2, lip: 9, tableG: 0.38, w: 18, inrun: 40, inG: 0.26, land: BIG, out: 60, outG: 0.18, side: 'open' }),
    { tag: 'sg', len: 500, turn: 8, grade: 0.32, smooth: 60, w: 16, side: 'open' },
    { tag: 'gully', len: 160, turn: 45, grade: 0.3, w: 8, side: 'canyon', barrier: 'ice', fric: 0.8, vd: 16 },
    { tag: 'gully', len: 160, turn: -50, grade: 0.3, w: 8, side: 'canyon', barrier: 'ice', fric: 0.8, vd: 16 },
    { tag: 'cliff', len: 320, turn: 6, grade: 0.18, w: 9, side: ['drop', 'wall'], barrier: ['bnet', 'rock'] },
    ...kicker({ h: 1.8, lip: 9, tableG: 0.36, w: 16, inrun: 40, inG: 0.25, land: DOWNHILL_LAND, out: 50, outG: 0.2 }),
    ...hairpins(-110, 114, { side: 'valley', forest: 0.3 }),
    { tag: 'sg', len: 420, grade: 0.33, smooth: 60, w: 16, side: 'valley', forest: 0.3 },
    { tag: 'steep', len: 260, grade: 0.4, smooth: 40, w: 18, side: 'forest', forest: 0.6, vd: 30 },
    ...kicker({ h: 2.0, lip: 9, tableG: 0.36, w: 18, inrun: 40, inG: 0.25, land: BIG, out: 60, outG: 0.16 }),
    { tag: 'schuss', len: 200, turn: -12, grade: 0.28, w: 18, side: 'forest', forest: 0.6, vd: 30 },
    { tag: 'zielhang', len: 170, grade: 0.36, smooth: 50, w: 22, side: 'arena', vd: 30 },
    ...ARENA(),
  ],
  finishAt: 30,
  checkpointsAt: ['sturns#2', 'sg', 'gully#2', 'cliff', 'hairpin#2', 'sg#2', 'steep', 'schuss'],
  slalom: { tag: 'sg', spacing: 46, offset: 3.6 },
};

/** The expert course definitions, in menu order. */
export const EXTREME_COURSES = { devilsridge: DEVILSRIDGE, wolfgorge: WOLFGORGE, skyfang: SKYFANG };

// Reference (ideal run) times in seconds, measured in Node with referenceTime() on the registered courses
// (the menus show par / medals from these before a course is built; register() recomputes them).
export const EXTREME_REF_TIMES = { devilsridge: 162.14, wolfgorge: 164.9, skyfang: 133.03 };
