// Five more World Racing courses (RACE, WORLD RACING and free ride), each on its own mountain around the resort, built
// with the same kit as the first three (courses.js): World Cup nets with sponsor banners on both sides,
// blue dye lines, START / CHECKPOINT / FINISH arches, downhill gate flags, the finish arena. Designed to
// the clearer, easier standard (Oct 26): wide pistes, gentle pitches, no tight bends, wide gates set only
// a little off the line, grippy snow. Difficulty spread: two starter-friendly runs, two medium, one hard.
//
//   meadow      Sunny Meadow               Easy    short starter cruise, soft rollers, easy bends
//   forestgs    Black Forest Giant Slalom  Medium  three stretches of wide GS gates through tall pines
//   glaciersg   Glacier Super-G            Medium  long fast sweepers high on the glacier, a blue-ice traverse
//   floodlight  Floodlight Slalom          Easy    a short night slalom down a floodlit forest piste
//   eaglepeak   Eagle Peak Downhill        Hard    big-mountain downhill: steep start, cliff traverse, one big jump
import { kicker, rollers } from './sections.js';

const DEG = Math.PI / 180;

const START = [
  // start platform (13 m half-width: the 15-racer field lines up 9 abreast), then a ramp out of the gate
  { tag: 'start', len: 12, grade: 0.015, smooth: 8, w: 13, side: 'flat', forest: 0, anet: false },
];
const ramp = (grade = 0.3, len = 28) => ({ tag: 'startRamp', len, grade, smooth: 14, w: 13, side: 'flat', forest: 0, anet: false });
const ARENA = (inLen = 90, inGrade = 0.08, runout = 120) => [
  { tag: 'finishIn', len: inLen, grade: inGrade, smooth: 60, w: 20, side: 'arena', barrier: 'arena' },
  { tag: 'finish', len: 50, grade: 0.012, smooth: 40, w: 18, side: 'arena', barrier: 'arena', forest: 0 },
  { tag: 'runout', len: runout, grade: 0.004, smooth: 40, w: 22, side: 'arena', barrier: 'arena', forest: 0 },
];

const MEADOW = {
  id: 'meadow', name: 'Sunny Meadow', difficulty: 'Easy', theme: 'meadow',
  tagline: 'The starter run: a short, gentle cruise over wide sunny meadows, soft rollers and easy bends. Perfect for a first race.',
  center: { x: -6628, z: 3888 }, seed: 7101, treeline: 110, peaks: 340,
  track: { x0: -6600, z0: 4600, heading0: Math.PI * 1.04, y0: -160, vd: 18 },
  sections: [
    ...START, ramp(0.2, 26),
    { tag: 'meadow', len: 150, grade: 0.15, smooth: 40, w: 18, side: 'gentle', forest: 0.15 },
    { tag: 'sweep', len: 210, turn: 28, grade: 0.15, w: 20, side: 'gentle', forest: 0.2 },
    { tag: 'sweep', len: 210, turn: -32, grade: 0.16, w: 20, side: 'gentle', forest: 0.25 },
    ...rollers({ n: 3, h: 0.7, gap: 20, grade: 0.13, w: 18, side: 'gentle' }),
    { tag: 'glade', len: 190, turn: 24, grade: 0.15, w: 18, side: 'forest', forest: 0.55 },
    { tag: 'sweep', len: 190, turn: -26, grade: 0.15, w: 20, side: 'gentle', forest: 0.3 },
    { tag: 'zielhang', len: 120, grade: 0.18, smooth: 50, w: 22, side: 'arena', vd: 20 },
    ...ARENA(80, 0.06, 110),
  ],
  finishAt: 30,
  checkpointsAt: ['sweep#2', 'glade'],
};

const FORESTGS = {
  id: 'forestgs', name: 'Black Forest Giant Slalom', difficulty: 'Medium', theme: 'forest',
  tagline: 'A giant slalom through tall pines: three stretches of wide, rhythmic gates on a steady pitch, two banked bends and a forest glade.',
  center: { x: 2122, z: 7155 }, seed: 7203, treeline: -50, peaks: 420,
  track: { x0: 1000, z0: 7600, heading0: Math.PI * 0.98 - 60 * DEG, y0: -370, vd: 22 },
  sections: [
    ...START, ramp(0.3),
    { tag: 'dropIn', len: 110, grade: 0.25, smooth: 36, w: 14, side: 'forest', forest: 0.6 },
    { tag: 'gs', len: 440, turn: -8, grade: 0.21, smooth: 60, w: 16, side: 'forest', forest: 0.9 },
    { tag: 'bend', len: 170, turn: 58, grade: 0.2, w: 16, bank: 7, side: 'forest', vd: 20 },
    { tag: 'glade', len: 260, turn: -18, grade: 0.22, w: 20, side: 'valley', forest: 0.4 },
    { tag: 'gs', len: 420, turn: 6, grade: 0.21, smooth: 60, w: 16, side: 'forest', forest: 0.9 },
    { tag: 'bend', len: 180, turn: -62, grade: 0.2, w: 16, bank: 7, side: 'forest', vd: 20 },
    { tag: 'schuss', len: 220, turn: 14, grade: 0.2, w: 18, side: 'forest', forest: 0.7, vd: 26 },
    { tag: 'gs', len: 360, turn: -6, grade: 0.21, smooth: 60, w: 16, side: 'forest', forest: 0.9 },
    { tag: 'zielhang', len: 150, grade: 0.28, smooth: 50, w: 22, side: 'arena', vd: 26 },
    ...ARENA(),
  ],
  finishAt: 30,
  checkpointsAt: ['gs', 'bend', 'gs#2', 'bend#2', 'gs#3'],
  slalom: { tag: 'gs', spacing: 72, offset: 1.4 },
};

const GLACIERSG = {
  id: 'glaciersg', name: 'Glacier Super-G', difficulty: 'Medium', theme: 'glacier',
  tagline: 'High on the glacier: long, fast sweeping turns on a wide-open ice field, rollers, wide super-G gates and a blue-ice traverse under the seracs.',
  center: { x: -6940, z: -1187 }, seed: 7307, treeline: 110, peaks: 600,
  track: { x0: -6600, z0: 200, heading0: Math.PI * 1.1, y0: 1210, vd: 30 },
  sections: [
    ...START, ramp(0.32),
    { tag: 'dropIn', len: 130, grade: 0.28, smooth: 40, w: 16, side: 'open', vd: 26 },
    { tag: 'sweep', len: 300, turn: -40, grade: 0.24, w: 24, side: 'open', bank: 4, vd: 30 },
    { tag: 'sweep', len: 320, turn: 46, grade: 0.25, w: 24, side: 'open', bank: 4, vd: 30 },
    ...rollers({ n: 4, h: 1.0, gap: 22, grade: 0.18, w: 22, side: 'open' }),
    { tag: 'sg', len: 560, turn: -12, grade: 0.22, smooth: 60, w: 22, side: 'open', vd: 30 },
    { tag: 'blueice', len: 240, turn: 18, grade: 0.18, w: 18, side: [{ kind: 'canyon', stepH: 16 }, 'open'], barrier: ['ice', 'bnet'], fric: 0.82 },
    { tag: 'sweep', len: 300, turn: 44, grade: 0.25, w: 24, side: 'open', bank: 4, vd: 30 },
    { tag: 'sweep', len: 300, turn: -38, grade: 0.24, w: 24, side: 'open', bank: 4, vd: 30 },
    { tag: 'moraine', len: 260, turn: 16, grade: 0.2, w: 20, side: 'valley', forest: 0.1, vd: 30 },
    { tag: 'zielhang', len: 160, grade: 0.3, smooth: 50, w: 24, side: 'arena', vd: 30 },
    ...ARENA(),
  ],
  finishAt: 30,
  checkpointsAt: ['sweep#2', 'rollers', 'sg', 'blueice', 'sweep#4', 'moraine'],
  slalom: { tag: 'sg', spacing: 110, offset: 1.8 },
};

const FLOODLIGHT = {
  id: 'floodlight', name: 'Floodlight Slalom', difficulty: 'Easy', theme: 'night', night: true,
  tagline: 'Racing under the lights: a short night slalom down a floodlit forest piste, wide gates, two gentle bends and a fast finish.',
  center: { x: 7786, z: -4745 }, seed: 7519, treeline: 970, peaks: 380,
  track: { x0: 8000, z0: -4000, heading0: Math.PI * 1.0, y0: 620, vd: 22 },
  sections: [
    ...START, ramp(0.26),
    { tag: 'dropIn', len: 100, grade: 0.22, smooth: 36, w: 15, side: 'forest', forest: 0.6 },
    { tag: 'slalom', len: 420, turn: 6, grade: 0.19, smooth: 60, w: 16, side: 'forest', forest: 0.85 },
    { tag: 'bend', len: 170, turn: -52, grade: 0.18, w: 16, bank: 6, side: 'forest', vd: 20 },
    { tag: 'slalom', len: 400, turn: -6, grade: 0.19, smooth: 60, w: 16, side: 'forest', forest: 0.85 },
    { tag: 'bend', len: 160, turn: 46, grade: 0.18, w: 16, bank: 6, side: 'forest', vd: 20 },
    { tag: 'zielhang', len: 140, grade: 0.24, smooth: 50, w: 22, side: 'arena', vd: 24 },
    ...ARENA(80, 0.07, 110),
  ],
  finishAt: 30,
  checkpointsAt: ['slalom', 'bend', 'slalom#2', 'bend#2'],
  slalom: { tag: 'slalom', spacing: 66, offset: 1.4 },
};

const EAGLEPEAK = {
  id: 'eaglepeak', name: 'Eagle Peak Downhill', difficulty: 'Hard', theme: 'bigmountain',
  tagline: 'The big-mountain downhill: more than 1,100 m of vertical from Eagle Peak, a steep start, a cliff-side traverse, fast forest turns and one huge jump before the finish.',
  center: { x: -2956, z: -4345 }, seed: 7411, treeline: 60, peaks: 640,
  track: { x0: -2400, z0: -2200, heading0: Math.PI * 1.07 - 30 * DEG, y0: 1160, vd: 30 },
  sections: [
    ...START, ramp(0.34),
    { tag: 'startHang', len: 170, grade: 0.32, smooth: 40, w: 15, side: 'open', vd: 26 },
    { tag: 'sturns', len: 250, turn: -46, grade: 0.25, w: 22, side: 'open', bank: 5, vd: 30 },
    { tag: 'sturns', len: 260, turn: 52, grade: 0.26, w: 22, side: 'open', bank: 5, vd: 30 },
    { tag: 'sturns', len: 250, turn: -48, grade: 0.25, w: 22, side: 'open', bank: 5, vd: 30 },
    { tag: 'face', len: 320, turn: 22, grade: 0.28, smooth: 50, w: 24, side: 'open', vd: 32 },
    { tag: 'sturns', len: 260, turn: -44, grade: 0.25, w: 22, side: 'open', bank: 5, vd: 30 },
    { tag: 'shoulder', len: 200, turn: 16, grade: 0.2, w: 18, side: 'open' },
    // traverse along a cliff band: rock wall above, the drop below behind A-nets
    { tag: 'cliff', len: 420, turn: -6, grade: 0.14, w: 12, side: ['drop', 'wall'], barrier: ['bnet', 'rock'] },
    { tag: 'cliffOut', len: 120, turn: 30, grade: 0.18, w: 14, side: 'valley' },
    { tag: 'steep', len: 380, turn: -20, grade: 0.3, smooth: 50, w: 22, side: 'forest', forest: 0.7, vd: 30 },
    { tag: 'banked', len: 180, turn: 70, grade: 0.18, w: 16, bank: 8, side: 'forest', vd: 22 },
    { tag: 'banked', len: 60, grade: 0.2, w: 16, side: 'forest' },
    { tag: 'banked', len: 190, turn: -74, grade: 0.18, w: 16, bank: 8, side: 'forest', vd: 22 },
    { tag: 'gladeTurns', len: 260, turn: -40, grade: 0.24, w: 22, side: 'forest', forest: 0.5, bank: 4, vd: 30 },
    { tag: 'gladeTurns', len: 260, turn: 44, grade: 0.24, w: 22, side: 'forest', forest: 0.5, bank: 4, vd: 30 },
    { tag: 'schuss', len: 340, turn: 18, grade: 0.2, w: 22, side: 'forest', forest: 0.6, vd: 32 },
    // the big jump: a small lip on a steep table, a long landing hill (downhill profile, see sections.js)
    ...kicker({ h: 2.0, lip: 9, tableG: 0.36, w: 20, inrun: 40, inG: 0.25, land: [[0.6, 4], [0.6, 40], [0.8, 80], [0.5, 30], [0.35, 40]], out: 60, outG: 0.16 }),
    { tag: 'zielhang', len: 180, grade: 0.32, smooth: 50, w: 24, side: 'arena', vd: 30 },
    ...ARENA(110, 0.1, 140),
  ],
  finishAt: 30,
  checkpointsAt: ['sturns#2', 'face', 'shoulder', 'cliff', 'steep', 'banked#3', 'gladeTurns#2', 'kickOut'],
};

/** The new course definitions, in menu order (easy first). */
export const NEW_COURSES = { meadow: MEADOW, floodlight: FLOODLIGHT, forestgs: FORESTGS, glaciersg: GLACIERSG, eaglepeak: EAGLEPEAK };

// Reference (ideal run) times in seconds, measured in Node with referenceTime() on the registered courses
// (the menus show par / medals from these before a course is built; register() recomputes them).
export const NEW_REF_TIMES = { meadow: 66.7, floodlight: 60.25, forestgs: 82.17, glaciersg: 99.76, eaglepeak: 132.15 };
