// The World Racing courses in FREE RIDE (Oct 27, the user: "replace all the races in free world with the races of
// the race game mode, on the mountains, exactly those race tracks"). The eight courses stand on the mountains
// around the resort (their defs in courses.js / newcourses.js place them there; RACE and WORLD RACING use the same
// spots). Their regions shape the terrain, so every course is registered while the game loads, before any terrain
// is built (registerFreeWorldCourses; the heightfield rasters stay resident). Their meshes (nets, start house,
// tunnel, bridge, arena, floodlight masts...) are only built while you are within ~1.7 km and dropped again past
// ~2.6 km (FreeCourses.update). E at a start house races the course against the 14 AI exactly like RACE mode
// (game/modes.js startFree reuses modes/race/session.js); after the finish you ski on from the finish area.
import { COURSES, getCourse } from './courses.js';

const BUILD_D = 1700;  // m from the course line: build its meshes
const DROP_D = 2600;   // m: dispose them again
const START_R = 24;    // m around the start line: E races the course

// entry fee and prize money, like the old open-world races (1st / 2nd / 3rd: 100 % / 40 % / 15 %)
// (Oct 29 rebalance: the prize follows the course's length, perKm $ a km for 1st, never under min, so a 1.3 km
// sprint no longer pays like a 6.7 km downhill. A win pays a few jobs' worth: Easy $600-1,500, Medium
// $1,250-2,300, Hard $3,200-4,700. The entry fee is a small stake, refunded many times over by a podium.)
const DIFF = {
  Easy: { label: 'Easy', color: '#2fbf5b', entry: 0, perKm: 300, min: 600, ai: 'easy' },
  Medium: { label: 'Medium', color: '#2f7bff', entry: 50, perKm: 500, min: 1000, ai: 'medium' },
  Hard: { label: 'Hard', color: '#e23b3b', entry: 150, perKm: 700, min: 2000, ai: 'medium' },
  Expert: { label: 'Expert', color: '#141414', entry: 300, perKm: 900, min: 3000, ai: 'hard' },
};
export const PRIZE_SHARE = [1, 0.4, 0.15];
/** 1st place prize for a course of difficulty D and length L (m), in round $50s. */
export const coursePrize = (D, L) => Math.round(Math.max(D.min, (D.perKm * L) / 1000) / 50) * 50;

/** Register every course (region, corridor, surfaces) before the terrain is built: one per task, so the page
 *  stays responsive while the models load. */
export async function registerFreeWorldCourses() {
  const t0 = performance.now();
  for (const c of COURSES) {
    try { getCourse(c.id); } catch (e) { console.warn(`Free world: course ${c.id} failed to register`, e); }
    await new Promise((r) => setTimeout(r, 0));
  }
  return Math.round(performance.now() - t0);
}

let entries = null;
/** The courses as free-ride sites: { id, name, course, D, reward, start, finish, pts (line every ~30 m), heli } */
export function freeCourses() {
  if (entries) return entries;
  entries = [];
  for (const c of COURSES) {
    let course;
    try { course = getCourse(c.id); } catch { continue; }
    const D = DIFF[course.difficulty] || DIFF.Medium;
    const L = course.length || course.track.length;
    const reward = coursePrize(D, L);
    const T = course.track, pts = [];
    for (let i = 0; i < T.n; i += 15) pts.push([T.X[i], T.Z[i]]);
    pts.push([T.X[T.n - 1], T.Z[T.n - 1]]);
    // where the heli sets you down: on the flat start shoulder beside the line-up, clear of the start house
    const w = T.sAt(T.W, course.start.s);
    const hp = T.pointAt(course.start.s + 6, -(w + 20));
    entries.push({
      id: c.id, name: course.name, course, D, reward, length: L, drop: Math.round(course.drop),
      start: course.start, finish: course.finish, pts,
      heli: { name: course.name, x: hp.x, z: hp.z, heading: course.start.heading, vertical: Math.round(course.drop), course: c.id },
    });
  }
  return entries;
}

// distance from (x, z) to a course line (sampled every ~30 m)
function lineDist(e, x, z) {
  let d2 = Infinity;
  const p = e.pts;
  for (let i = 0; i < p.length; i += 1) {
    const dx = p[i][0] - x, dz = p[i][1] - z, q = dx * dx + dz * dz;
    if (q < d2) d2 = q;
  }
  return Math.sqrt(d2);
}

export class FreeCourses {
  /**
   * @param {object} o { scene, models, modes, colliders }
   */
  constructor(o) {
    this.scene = o.scene;
    this.colliders = o.colliders || null; // (main.js's shared array: the night courses' floodlight masts while they stand)
    this.models = o.models;
    this.modes = o.modes;
    this.t = 0;
    this.near = null; // the nearest course entry (within BUILD_D) with its meshes up
    this.warned = false;
  }

  // (the old open-world races' interface: nothing runs outside a Modes session any more)
  get active() { return null; }
  abort() {}
  nearestRace() { return null; }

  /** Build / drop course meshes by distance (twice a second). Safe to call every frame. */
  update(dt, player) {
    try {
      this.t -= dt;
      if (this.t > 0) return;
      this.t = 0.5;
      const list = freeCourses();
      const m = this.modes;
      const sessionCourse = m?.course || null;
      this.syncMasts(list);
      // RACE / WORLD RACING from the menu: only that course stands
      if (m?.active && !m.current?.free) {
        for (const e of list) if (e.course !== sessionCourse && e.course.group) e.course.dispose();
        this.near = null;
        return;
      }
      if (!player) return;
      const p = player.pos;
      let near = null, nd = Infinity, built = false;
      for (const e of list) {
        e.d = lineDist(e, p.x, p.z);
        if (e.d < nd) { nd = e.d; near = e; }
        if (e.course === sessionCourse) continue;
        if (e.d > DROP_D && e.course.group) e.course.dispose();
      }
      for (const e of list) {
        if (built || e.d > BUILD_D || e.course.group) continue;
        e.course.build(this.scene, this.models); // (one course per tick: a build takes a moment)
        built = true;
      }
      this.near = near && nd < BUILD_D && near.course.group ? near : null;
    } catch (e) {
      if (!this.warned) { this.warned = true; console.warn('Free world courses: update failed', e); }
    }
  }

  // a course's props outside its nets (a night course's floodlight masts, the finish's grandstands, timing board and
  // patrol hut, lamp posts, snow cannons: props.js course.solids) are solid while its meshes stand: registered on
  // build, removed again on dispose (checked every tick)
  syncMasts(list) {
    const C = this.colliders;
    if (!C) return;
    for (const e of list) {
      const up = !!e.course.group;
      if (up && !e.mastCols) { e.mastCols = [...(e.course.floodlights || []).map((m) => ({ x: m.x, z: m.z, r: 0.2, h: 11 })), ...(e.course.solids || [])]; C.push(...e.mastCols); }
      else if (!up && e.mastCols) {
        const gone = new Set(e.mastCols);
        let j = 0;
        for (let i = 0; i < C.length; i++) if (!gone.has(C[i])) C[j++] = C[i];
        C.length = j;
        e.mastCols = null;
      }
    }
  }

  /** The course whose start line you stand at (E races it), or null. */
  nearStart(p) {
    try {
      for (const e of freeCourses()) {
        const s = e.start;
        if (Math.abs(p.x - s.x) > START_R || Math.abs(p.z - s.z) > START_R) continue;
        if (Math.hypot(p.x - s.x, p.z - s.z) < START_R && Math.abs((p.y ?? s.y) - s.y) < 12 && e.course.group) return e;
      }
    } catch (e) {
      if (!this.warned) { this.warned = true; console.warn('Free world courses: start lookup failed', e); }
    }
    return null;
  }

  /** Prize money for a finishing place (1-based). */
  prize(e, place, dnf) { return dnf ? 0 : Math.round(e.reward * (PRIZE_SHARE[place - 1] ?? 0)); }

  /** Crowd target for crowds.js: the nearest built course while you are close to its finish arena. */
  crowdCourse(p) {
    const e = this.near;
    if (!e || !e.course.group || Math.hypot(p.x - e.finish.x, p.z - e.finish.z) > 700) return null;
    return e;
  }

  /** Trail map / flight planner: the course starts. */
  mapMarkers() {
    return freeCourses().map((e) => ({ x: e.start.x, z: e.start.z, kind: 'race', label: e.name, color: e.D.color }));
  }
}
