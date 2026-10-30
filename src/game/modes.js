// Game modes: FREE RIDE in the open-world resort and RACE (vs AI bots, just for fun: no prize money) on the
// purpose-built courses far away from the resort, started from the RACING stand in Legacy Village
// (ui/racestand.js; WORLD RACING, the time trial, is gone as a mode: Oct 27). Owns the teleports between them:
// the branded transition card covers the screen while a course is built and the terrain around it streams in.
import { RaceSession } from '../modes/race/session.js';
import { COURSES, getCourse } from '../modes/parkour/courses.js';
import { applyCourseAtmosphere, restoreCourseAtmosphere } from '../modes/parkour/looks.js';

export class Modes {
  /**
   * @param {object} o
   * @param {THREE.Scene} o.scene
   * @param {object} o.models
   * @param {object} o.player
   * @param {(charId: string, skiId: string) => object} o.makeRig
   * @param {() => string[]} o.botCharacters   character ids the AI field may wear
   * @param {object} o.audio, o.hud, o.raceHud, o.transition, o.trails, o.spray
   * @param {object} o.save
   * @param {() => void} o.writeSave
   * @param {(x: number, z: number) => Promise<void>} o.stream   pre-stream terrain + trees around a point
   * @param {() => Promise<void>} o.toMenu   back to the main menu (called behind the transition card)
   * @param {() => Promise<void>} [o.toWorld]  a fun race's VILLAGE / ESC: back to free ride at the RACING stand (ditto)
   * @param {(info: object) => void} [o.onResult]  a finished run (prize money etc.)
   */
  constructor(o) {
    Object.assign(this, o);
    this.session = null;
    this.course = null;
    this.group = null;
    this.current = null; // { mode, courseId, difficulty }
  }

  get active() { return !!this.session; }

  /** Course list for the RACING stand (best finish, PB + medal). */
  list() {
    return COURSES.map((c) => ({
      id: c.id, name: c.name, tagline: c.tagline, difficulty: c.difficulty, length: c.length, drop: c.drop,
      par: c.par, medals: c.medals, record: this.save.records?.[c.id] || null,
    }));
  }

  // Build (once) and show a course; the previous one is torn down so only one course lives in memory.
  load(courseId) {
    if (this.course?.id === courseId) return this.course;
    this.unload();
    const course = getCourse(courseId);
    this.group = course.build(this.scene, this.models);
    if (this.group && !this.group.parent) this.scene.add(this.group);
    this.course = course;
    // the course's own time of day, weather and haze while it is loaded (looks.js; restored in unload)
    try { applyCourseAtmosphere(courseId); } catch (e) { console.warn('Course atmosphere failed', e); }
    return course;
  }

  unload() {
    try { restoreCourseAtmosphere(); } catch (e) { console.warn('Course atmosphere restore failed', e); }
    if (!this.course) return;
    this.group?.parent?.remove(this.group);
    this.course.dispose?.();
    this.course = this.group = null;
  }

  /** Start a race (just for fun, no prize money): teleport to the course behind the transition card.
   *  `covered` runs once the card covers the screen. */
  async start({ courseId, difficulty = 'medium' }, covered) {
    const def = COURSES.find((c) => c.id === courseId) || COURSES[0];
    this.current = { mode: 'race', courseId: def.id, difficulty };
    const label = `RACE · ${def.name}`;
    await this.transition.teleport(label, async () => { covered?.(); await this.begin(); });
  }

  // Everything that happens while the screen is covered.
  async begin() {
    const { mode, courseId, difficulty } = this.current;
    this.end();
    const course = this.load(courseId);
    this.player.teleport(course.start.x, course.start.z, course.start.heading);
    await this.stream(course.start.x, course.start.z);
    this.session = new RaceSession({
      scene: this.scene, course, mode, difficulty, botCount: this.botCount, // (undefined: the full field)
      player: this.player, makeRig: this.makeRig, botCharacters: this.botCharacters(),
      audio: this.audio, hud: this.hud, raceHud: this.raceHud, trails: this.trails, spray: this.spray,
      save: this.save, writeSave: this.writeSave,
      stream: this.stream, // terrain around a respawn checkpoint streams while the screen is dark
      weather: () => window.__game?.env?.weatherLabel, // shown on the race intro card
      // RETRY / NEXT / VILLAGE (the stand's race ends back at the stand in free ride, not in a menu)
      choices: this.toWorld ? [['retry', 'RETRY', 'R'], ['next', 'NEXT', 'ENTER'], ['menu', 'VILLAGE', 'ESC']] : null,
      onExit: (choice) => this.exit(choice),
    });
    this.session.start();
  }

  /** FREE RIDE: race a course right where it stands on its mountain (E at its start house, see
   *  modes/parkour/freeworld.js): the same session as RACE (14 AI, intro, checkpoints, results), no teleport to a
   *  far map and no course atmosphere. o.result({ place, time, dnf }) -> prize money shown on the results card;
   *  o.retry() -> false when RACE AGAIN can't be paid. After the finish BACK TO START takes you up to the start again. */
  startFree(courseId, { difficulty = 'medium', result, retry, prizeMult, bots, syncGo, grid, others, mp, home } = {}) {
    this.end();
    // (a course object: a race laid on a piste, the ski bus's free races: modes/race/busraces.js)
    const course = typeof courseId === 'object' && courseId ? courseId : getCourse(courseId);
    this.group = course.build(this.scene, this.models); // (the free world built it already: reused)
    if (this.group && !this.group.parent) this.scene.add(this.group);
    this.course = course;
    this.current = { mode: 'race', courseId: course.id, difficulty, free: true, retry, home }; // (home: { label, place() } instead of BACK TO START)
    this.session = new RaceSession({
      scene: this.scene, course, mode: 'race', difficulty, botCount: bots ?? this.botCount, // (multiplayer: bots 0, syncGo: the shared start)
      player: this.player, makeRig: this.makeRig, botCharacters: this.botCharacters(),
      audio: this.audio, hud: this.hud, raceHud: this.raceHud, trails: this.trails, spray: this.spray,
      save: this.save, writeSave: this.writeSave, stream: this.stream, syncGo, grid, mp, // (multiplayer: grid { slot, n }, the server's; mp: the field and the result)
      weather: () => window.__game?.env?.weatherLabel,
      freeRide: { result, prizeMult, others, backLabel: home?.label }, // (prizeMult: the AI field's prize factor; others: multiplayer, the other racers' rows)
      onExit: (choice) => this.exitFree(choice),
    });
    this.session.start();
  }

  // RACE AGAIN (back to the start, entry fee as usual) or BACK TO START ('continue': standing at the start, no race)
  async exitFree(choice) {
    if (!this.current?.free) return;
    if (choice === 'retry' && this.current.retry?.() !== false && this.session?.restart) {
      await this.transition.fade(() => this.session?.restart());
      this.lock?.();
      return;
    }
    // CONTINUE: back up to the course's start (Oct 27, the user: "if you're done racing you return to the start of
    // the race, rn you're stuck at the end of the race and have to walk all the way back up"): you stand at the start
    // wand again, E races it again (or ski the course on your own)
    const s = this.session, c = this.course, s0 = c?.start?.s, home = this.current.home;
    await this.transition.fade(async () => {
      this.end();
      try {
        if (home?.place) await home.place(); // (a bus race: back to its board beside the bus stop)
        else if (s && Number.isFinite(s0)) { s.placePlayer(s0, 0, 0); await this.stream?.(this.player.pos.x, this.player.pos.z); }
      } catch (e) { console.warn('Race: back to the start failed', e); }
    });
    // (the course stays standing: the free world drops its meshes once you are far away)
    this.course = this.group = null;
    this.current = null;
    this.lock?.();
  }

  /** Results screen choice: 'retry' | 'next' | 'menu'. */
  async exit(choice) {
    if (!this.current) return;
    if (choice === 'retry') {
      // same rivals, fresh run (cheap); rebuild only if the session cannot restart itself
      await this.transition.fade(() => (this.session?.restart ? this.session.restart() : this.begin()));
      this.lock?.(); // the results screen released the mouse
    } else if (choice === 'next') {
      const i = COURSES.findIndex((c) => c.id === this.current.courseId);
      await this.start({ ...this.current, courseId: COURSES[(i + 1) % COURSES.length].id });
    } else if (this.toWorld) {
      await this.home();
    } else {
      await this.leave();
    }
  }

  /** A fun race's VILLAGE (results ESC, pause RETURN TO VILLAGE): back to free ride at the RACING stand. */
  async home() {
    if (!this.current) return;
    await this.transition.fade(async () => {
      this.end();
      this.unload(); // (the free-ride time of day and weather come back)
      this.current = null;
      await this.toWorld();
    });
    this.lock?.();
  }

  /** Abandon the session and go back to the main menu (pause menu MAIN MENU, results MENU). */
  async leave() {
    await this.transition.fade(async () => {
      this.end();
      this.unload();
      this.current = null;
      await this.toMenu();
    });
  }

  end() {
    this.session?.dispose();
    this.session = null;
    this.raceHud.hide();
  }

  update(dt, input) {
    this.session?.update(dt, input);
  }
}
