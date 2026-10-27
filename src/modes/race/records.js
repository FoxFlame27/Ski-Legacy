// Race records: medals, personal bests and result bookkeeping for RACE and WORLD RACING.
// Pure logic (no DOM), so it runs in Node tests as well as in the game.
//
// save.records[courseId] = {
//   best,        // personal best time on the course in seconds (any mode), or null
//   medal,       // best medal earned by TIME (course medal standards), or null
//   bestRace,    // best finishing place against the AI field (1 = won), or null
//   raceMedal,   // best medal earned by PLACE in race mode, or null
//   byDifficulty,// { easy, medium, hard }: best place per difficulty
//   splits,      // checkpoint split times of the PB run (seconds from GO)
//   runs,        // finished runs on this course
// }
//
// A finished run is committed in two steps so nothing is lost when the player restarts or quits
// between the finish line and the results screen: submitTime() at the line (PB, time medal, splits),
// submitPlace() once the field's order is known (race mode). submitResult() does both at once.

export const MEDALS = ['gold', 'silver', 'bronze'];
const RANK = { gold: 3, silver: 2, bronze: 1 };

export const medalRank = (m) => RANK[m] || 0;
export const betterMedal = (a, b) => (medalRank(b) > medalRank(a) ? b : a || null);

// Race mode: podium places earn the medals.
export function medalForPlace(place) {
  return place === 1 ? 'gold' : place === 2 ? 'silver' : place === 3 ? 'bronze' : null;
}

// Time standards of a course. Falls back to standards derived from par when a course has none.
export function courseMedals(course) {
  const m = course?.medals;
  if (m && Number.isFinite(m.gold) && Number.isFinite(m.silver) && Number.isFinite(m.bronze)) return m;
  const par = course?.par > 0 ? course.par : null;
  return par ? { gold: par * 1.02, silver: par * 1.08, bronze: par * 1.16 } : null;
}

// Standards derived from the time of an ideal run (reference skier on race skis): gold needs a strong
// clean run, silver a solid one, bronze a casual one (same factors as courses.js MEDAL_K). Rounded to
// tenths like course standards.
export function medalsFromReference(ref) {
  const r = (k) => Math.round(ref * k * 10) / 10;
  return { gold: r(1.1), silver: r(1.22), bronze: r(1.38) };
}

/**
 * Medal standards the session uses: the course's own, unless they are out of reach (gold faster
 * than an ideal run on race skis, which happens when a course's par model misses jump speed checks).
 * @param {object} course
 * @param {number} [idealTime]  reference time of an ideal run (bots.js referenceTime)
 */
export function sessionMedals(course, idealTime) {
  const m = courseMedals(course);
  if (!(idealTime > 0)) return m;
  if (!m || m.gold < idealTime || !(m.gold < m.silver && m.silver < m.bronze)) return medalsFromReference(idealTime);
  return m;
}

// World Racing: medal by time against the course standards.
export function medalForTime(time, medals) {
  if (!Number.isFinite(time) || !medals) return null;
  if (time <= medals.gold) return 'gold';
  if (time <= medals.silver) return 'silver';
  if (time <= medals.bronze) return 'bronze';
  return null;
}

export function getRecord(save, courseId) {
  return save?.records?.[courseId] || null;
}

// The record of a course with every field present (older saves only have { best, medal, bestRace }).
function recordOf(save, courseId) {
  save.records ??= {};
  const prev = save.records[courseId] || {};
  const rec = {
    best: prev.best ?? null, medal: prev.medal ?? null, bestRace: prev.bestRace ?? null,
    raceMedal: prev.raceMedal ?? null, byDifficulty: { ...(prev.byDifficulty || {}) },
    splits: prev.splits || null, runs: prev.runs || 0,
  };
  save.records[courseId] = rec;
  return rec;
}

/**
 * Step 1, at the finish line: run count, personal best (+ its splits) and the medal by time.
 * @param {object} save
 * @param {string} courseId
 * @param {object} run  { time, splits?, medals?, dnf? }
 * @returns {{ pb: boolean, previousBest: number|null, medal: string|null, newMedal: boolean, record: object }}
 *   medal = medal by time (what a time trial shows)
 */
export function submitTime(save, courseId, run) {
  const rec = recordOf(save, courseId);
  const previousBest = rec.best;
  const prevMedal = rec.medal;
  const finished = !run.dnf && Number.isFinite(run.time) && run.time > 0;
  let pb = false, medal = null;
  if (finished) {
    rec.runs++;
    if (previousBest === null || run.time < previousBest) {
      pb = true;
      rec.best = run.time;
      if (run.splits?.length) rec.splits = run.splits.map((t) => Math.round(t * 1000) / 1000);
    }
    medal = medalForTime(run.time, run.medals);
    rec.medal = betterMedal(rec.medal, medal);
  }
  return { pb, previousBest, medal, newMedal: medalRank(rec.medal) > medalRank(prevMedal), record: rec };
}

/**
 * Step 2, race mode once the order is known: best place (overall and per difficulty), medal by place.
 * @param {object} run  { place, difficulty?, dnf? }
 * @returns {{ medal: string|null, newMedal: boolean, record: object }}
 */
export function submitPlace(save, courseId, run) {
  const rec = recordOf(save, courseId);
  const prevMedal = rec.raceMedal;
  let medal = null;
  if (!run.dnf && run.place > 0) {
    medal = medalForPlace(run.place);
    rec.raceMedal = betterMedal(rec.raceMedal, medal);
    if (rec.bestRace === null || run.place < rec.bestRace) rec.bestRace = run.place;
    const d = run.difficulty;
    if (d && (!rec.byDifficulty[d] || run.place < rec.byDifficulty[d])) rec.byDifficulty[d] = run.place;
  }
  return { medal, newMedal: medalRank(rec.raceMedal) > medalRank(prevMedal), record: rec };
}

/**
 * Store a finished run in save.records in one go (the caller writes the save).
 * @param {object} save    the save object (src/game/economy.js)
 * @param {string} courseId
 * @param {object} run     { mode: 'race'|'trial', time, place?, difficulty?, splits?, medals?, dnf? }
 * @returns {{ pb: boolean, previousBest: number|null, record: object, medal: string|null, newMedal: boolean }}
 *   medal = the medal this run earns on the results screen (race: by place, trial: by time)
 */
export function submitResult(save, courseId, run) {
  const t = submitTime(save, courseId, run);
  if (run.mode !== 'race') return { pb: t.pb, previousBest: t.previousBest, record: t.record, medal: t.medal, newMedal: t.newMedal };
  const p = submitPlace(save, courseId, { ...run, dnf: run.dnf || !Number.isFinite(run.time) });
  return { pb: t.pb, previousBest: t.previousBest, record: p.record, medal: p.medal, newMedal: p.newMedal };
}

// ---------------------------------------------------------------- formatting helpers
// 83.456 -> "1:23.46" (rounded to hundredths first, so 59.996 reads "1:00.00", never "0:60.00")
export function formatTime(t) {
  if (!Number.isFinite(t)) return 'DNF';
  const c = Math.round(Math.max(0, t) * 100);
  const m = Math.floor(c / 6000), s = (c - m * 6000) / 100;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

// -0.84 -> "-0.84", 1.2 -> "+1.20" (uses a real minus sign for typography)
export function formatDelta(d) {
  if (!Number.isFinite(d)) return '';
  return (d < 0 ? '−' : '+') + Math.abs(d).toFixed(2);
}

export function ordinal(n) {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'TH' : ['TH', 'ST', 'ND', 'RD'][n % 10] || 'TH';
  return n + s;
}
