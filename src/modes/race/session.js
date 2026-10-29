// Race session: RACE against a field of 14 AI racers, or WORLD RACING (time trial against your ghost), on any
// course object that implements the course contract (src/modes/parkour/courses.js).
//
//   const session = new RaceSession({ scene, course, mode: 'race' | 'trial', difficulty: 'easy' | 'medium' | 'hard' | 'superhard',
//     player, makeRig, botCharacters, audio, hud, raceHud, trails, spray, save, writeSave, onExit });
//   session.start();            // start grid, bots / ghost, countdown 3-2-1-GO
//   session.update(dt, input);  // every frame AFTER player.update()
//   session.respawn();          // back to the last checkpoint (behind a fade to dark)
//   session.restart();          // instant retry (also Backspace during a run)
//   session.onTrick(t);         // optional: trick points (shown in the results)
//   session.dispose();
//
// Flow: grid + countdown (player frozen) -> race (positions, splits, barriers, respawns, gates) ->
// finish (time, PB and ghost are saved right at the line; ski out) -> results (place, medal) ->
// onExit('retry' | 'next' | 'menu').
//
// Forgiving by design: barrier contact bounces the skier back into the track with the skis turned
// along the nets (only a near head-on slam knocks you down), brief excursions, slow sections and short
// hops never respawn you, and a real wipeout plays out, fades to dark, puts you back on the line at the
// last checkpoint and fades back in. The session owns wipeouts while it runs: the player's 'crash'
// event never reaches the host, so a race can never fall back to free ride's "back to the village".
//
// Broadcast presentation (src/game/presentation/*, overlay src/ui/presentation.js). While one runs the
// session poses the camera (and the rigs it shows) right after player.update(), in real time:
//   intro    first start of a session: ~8 s flyover down the course + start-gate crane into the chase
//            camera, letterbox + lower third (course, length, drop, difficulty, weather); skippable
//            (Space / Enter / click), then the countdown. Not on RETRY. o.intro === false turns it off.
//   podium   RACE: once the field is home, the top three on a podium in the finish run-out, confetti,
//            camera orbit; the results screen comes up over it.
//   replay   every racer is recorded (30 Hz ring buffer, last 60 s); the results screen offers WATCH
//            REPLAY (V): the last ~20 s with TV angles, slow motion through the finish and big airs.
// A photo finish asks the shared presentation time scale for slow motion (presentation.slowMo);
// main.js applies presentation.timeScale to the frame time.
import * as THREE from 'three';
import { world } from '../../world/world.js';
import { skierFX } from '../../fx/snowfx.js';
import { clamp, lerp, smoothstep } from '../../core/noise.js';
import { transition as sharedTransition } from '../../ui/transition.js';
import { brushSVG, esc, replay as replayAnim } from '../../ui/menu.js';
import { fmtTime } from '../../ui/hud.js';
import { presentationUI } from '../../ui/presentation.js';
import { presentation } from '../../game/presentation/index.js';
import { CourseIntro } from '../../game/presentation/intro.js';
import { ReplayBuffer, ReplayDirector, REPLAY_RATE } from '../../game/presentation/replay.js';
import { Podium } from '../../game/presentation/podium.js';
import { lockRig, unlockRig, poseRig, showRig } from '../../game/presentation/cinecam.js';
import { Track, createField, BotRacer, DIFFICULTY, referenceTime, RACE_SKI } from './bots.js';
import { GhostRecorder, GhostRunner, saveGhost, loadGhost } from './ghost.js';
import { submitTime, submitPlace, sessionMedals, getRecord, ordinal } from './records.js';
import { FarRacers, FAR_IN, FAR_OUT } from './farbots.js';
import { GateBars } from './gatebars.js';
import { CourseFloodlights } from './floodlights.js';

const LEAD_IN = 1.4;               // s on the grid before the "3"
const INTRO_LEAD_IN = 0.7;         // ...after the intro (the camera is already behind the racer)
const SKIP_KEYS = new Set(['Space', 'Enter', 'NumpadEnter']);
const PHOTO_GAP = 0.3;             // s between the player and a rival at the line = photo finish
const REPLAY_AFTER = 3.5;          // s of the ski-out recorded after the line
// Barriers (B-nets): the course keeps the skier inside its track, the session decides the bounce.
const CRASH_IMPACT = 16;           // m/s straight into the nets that knocks you down (30 m/s at ~32 deg)
const BOUNCE_SOFT = 0.42, BOUNCE_HARD = 0.22; // restitution off the nets: light touches .. hard hits
const SCRUB = 0.014, SCRUB_MAX = 0.2; // speed along the nets lost per m/s of impact, capped at 20 %
const DEFLECT_TOE = 0.12;          // skis turned parallel to the nets, toed ~7 deg back toward the track
const DEFLECT_FX = 0.35;           // rad of that turn the body shows and pivots out of (spray, no snap)
// Respawns, always behind a fade to dark, back to the last checkpoint.
const WIPEOUT_MIN = 0.9, WIPEOUT_MAX = 1.5; // s a wipeout plays before the fade (until the tumble ends)
const STUCK_TIME = 5, STUCK_PROGRESS = 3;   // no 3 m of progress down the course in 5 s = stuck
const OFF_MARGIN = 9, OFF_TIME = 1.5;       // m beyond the track edge (out of the barriers' reach), s
const FAR_MARGIN = 40, FAR_TIME = 0.8;      // way off the course
const FALL_BELOW = 7, FALL_TIME = 0.35;     // m below the track surface (off a bridge or cliff), s
const RESPAWN_SPEED = 8;           // m/s, rolling restart facing downhill
const RESPAWN_GRACE = 2;           // s after a respawn when no barrier hit can knock you down
const SETTLE_TIME = 0.18;          // s the screen stays dark after the move (camera + terrain settle)
const SETTLE_CAP_MS = 700;         // ...never longer in wall-clock time (paused game, terrain streaming)
const FADE_WATCHDOG = 2.5;         // s: a fade that never covers the screen -> respawn without it
const GATE_PENALTY = 0.5;          // s per missed slalom gate (forgiving: never a DNF; the next green bar shows the way)
// A gate is passed between its turning pole and its outer pole. Each pole carries a flag panel
// GATE_FLAG wide on its outer side (props.js). Missed = the skier's centre passes more than GATE_TOL
// inside the turning pole (straight down the middle) or that far outside the outer flag.
const GATE_FLAG = 0.75, GATE_TOL = 4; // (4 m: generous)
const RESULTS_DELAY = 2.6;         // s after the line before the results
const RESULTS_MAX_WAIT = 6;        // ...or longer while the field is about to finish
const MP_RESULTS_WAIT = 75;        // multiplayer: s after your finish to wait for the server's result (it closes a
                                   // race 60 s after the first finisher) before showing provisional standings
const FINISH_BRAKE = 9;            // m/s^2 ski-out after the line
// start grid (m): racers abreast GRID_FIRST / +GRID_SPACING beside the player, rows GRID_ROW apart,
// never closer than GRID_GAP to each other or GRID_EDGE to the barriers, and never inside any course
// mesh standing on the snow around the start (start house, wand posts, arch feet, boards, flags): a
// racer's footprint (skis RACER_HALF_LEN along, poles RACER_HALF_W across) keeps OBSTACLE_GAP from
// their real bounding boxes. Without meshes the start house record keeps HOUSE_HALF / HOUSE_REACH clear.
// (a full field of 15 lines up 9 abreast with 6 in the gaps of the second row, beside the start house)
const GRID_FIRST = 3.1, GRID_SPACING = 2.4, GRID_ROW = 2.4, GRID_GAP = 2.3, GRID_EDGE = 1.2;
const HOUSE_HALF = 3.7, HOUSE_REACH = 2.6;
const RACER_HALF_LEN = 0.95, RACER_HALF_W = 0.55, OBSTACLE_GAP = 0.25;
const OBS_REACH = 16, OBS_CELL = 0.25, OBS_LOW = 0.2, OBS_HIGH = 2.3; // start obstacle map (m)
const DEFAULT_CHARS = ['skier_orange', 'skier_black', 'skier_purple', 'skier_red', 'skier_blue', 'skier_green'];
export const FIELD_BOTS = 14;      // RACE: you + 14 AI racers
// Level of detail of the AI field (distances to the camera, m): every frame within LOD_FULL, 30 Hz poses
// within LOD_HALF, 15 Hz beyond; the far stand-in (farbots.js) past FAR_IN; racers off screen are not
// drawn unless closer than LOD_KEEP (their shadows can still fall into view); snow FX for the nearest
// FX_MAX racers. Countdown: the field stands still, so only the racers right beside the camera pose every
// frame.
const LOD_FULL = 30, LOD_HALF = 70, LOD_KEEP = 12, LOD_GONE = 900, FX_MAX = 6;
const BOT_SEP = 1.15;              // m between two AI racers' centres (shoulder to shoulder, poles out)

function hashStr(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// Stand-in for transition.fade(fn) when the game's transition is not available: a plain dark overlay
// over the page, or (headless, e.g. Node tests) no visual at all. Same contract: fn runs while covered.
function overlayFade(fn) {
  if (typeof document === 'undefined' || !document.body) return Promise.resolve().then(fn);
  let el = document.getElementById('race-fade');
  if (!el) {
    el = document.createElement('div');
    el.id = 'race-fade';
    el.style.cssText = 'position:fixed;inset:0;background:#050b16;opacity:0;pointer-events:none;z-index:9000;transition:opacity 0.34s ease';
    document.body.appendChild(el);
  }
  void el.offsetWidth; // start from transparent
  el.style.opacity = '1';
  return sleep(360).then(fn).finally(() => { el.style.opacity = '0'; });
}

// Checkpoints sorted by distance; index 0 is always the start (respawn target before the first split).
function normalizeCheckpoints(course, tr) {
  const list = (course.checkpoints || [])
    .filter((c) => c && Number.isFinite(c.s) && c.s < tr.finishS - 5)
    .map((c) => ({ ...c }))
    .sort((a, b) => a.s - b.s);
  if (!list.length || list[0].s > tr.s0 + 5) list.unshift({ index: 0, s: tr.s0, name: 'Start' });
  const out = [];
  for (const c of list) if (!out.length || c.s - out[out.length - 1].s > 20) out.push(c);
  return out;
}

export class RaceSession {
  constructor(o) {
    this.scene = o.scene;
    this.course = o.course;
    this.player = o.player;
    this.makeRig = o.makeRig;
    this.audio = o.audio;
    this.hud = o.hud;
    this.raceHud = o.raceHud;
    this.trails = o.trails;
    this.spray = o.spray;
    this.save = o.save || { records: {} };
    this.writeSave = o.writeSave;
    this.onExit = o.onExit;
    this.freeRide = o.freeRide || null; // free ride (the course on its mountain): prize money, RACE AGAIN / CONTINUE
    this.choices = o.choices || null;   // the results buttons for RACE (else RETRY / NEXT / MENU)
    this.mode = o.mode === 'trial' ? 'trial' : 'race';
    this.difficulty = DIFFICULTY[o.difficulty] ? o.difficulty : 'medium';
    this.botCharacters = o.botCharacters?.length ? o.botCharacters : DEFAULT_CHARS;
    this.botCount = this.mode === 'race' ? (o.botCount ?? FIELD_BOTS) : 0;
    this.courseId = String(this.course?.id ?? 'course');
    this.active = false;
    this.finished = false;
    this.disposed = false;
    this.state = 'idle'; // idle | countdown | racing | finished | results
    this.bots = [];
    this.ghost = null;
    this.attempt = 0;
    this.points = 0;
    this.overtakes = 0;
    this.respawns = 0;
    this.resultsToken = 0;
    this.missed = new Set(); // indices of missed slalom gates (this attempt)
    this.fx = this.trails ? { trails: this.trails, spray: this.spray, skierFX } : null;
    this.racers = [];
    this.order = [];
    this.prevOrder = [];
    this.avoid = [];
    this._pr = {};
    this._v0 = { x: 0, y: 0, z: 0 };
    this._bf = {};
    this.groundNormal = (x, z, y, out) => world.groundNormal(x, z, y + 0.5, out);
    // Respawns fade through the game's branded transition (src/ui/transition.js) unless one is passed in
    // (tests pass a stub, null = built-in overlay). Optional o.stream(x, z) pre-streams terrain + trees at
    // the respawn point while the screen is dark.
    this.transition = o.transition !== undefined ? o.transition : typeof document !== 'undefined' ? sharedTransition : null;
    this.stream = typeof o.stream === 'function' ? o.stream : null;
    this.pending = null; // respawn in progress: { reason, phase: 'wait' | 'fading', since, fadeAt }
    this.settle = null;  // dark hold after the move: { until (race clock), resolve }
    this.crashes = 0;    // wipeouts this attempt (the player's 'crash' events, taken over by the session)
    // broadcast presentation
    // multiplayer: syncGo() -> seconds until the shared GO (server clock); the countdown is timed to it, no intro
    this.syncGo = typeof o.syncGo === 'function' ? o.syncGo : null;
    // multiplayer: your slot on the start grid (the server's raceStart grid: { slot, n }), so racers never overlap
    this.mpGrid = o.grid && Number.isInteger(o.grid.slot) ? { slot: Math.max(0, o.grid.slot), n: Math.max(1, o.grid.n | 0) } : null;
    // multiplayer: { rid, field() -> the other racers [{ name, gate, s, time, dnf, off }], finish({ time, raw, pen, dnf })
    // (sent at the line), result() -> the server's final { order, mine } or null }. The server decides the places.
    this.mp = o.mp && typeof o.mp.field === 'function' ? o.mp : null;
    this.introEnabled = o.intro !== false && !this.syncGo;
    this.introDone = false;
    this.weather = o.weather; // string or () => string for the intro's lower third
    this.ui = o.presentationUI !== undefined ? o.presentationUI : typeof document !== 'undefined' ? presentationUI : null;
    this.cine = null;    // { kind: 'intro' | 'podium' | 'replay', director }
    this.replayBuf = null;
    this.skipOff = null;
  }

  /** True while a respawn is under way (wipeout playing, fade, or dark hold). */
  get respawning() { return !!this.pending || !!this.settle; }

  // ------------------------------------------------------------------ setup
  start() {
    if (this.disposed) return;
    if (!this.track) this.track = new Track(this.course);
    const tr = this.track;
    this.cps = normalizeCheckpoints(this.course, tr);
    // the course's medal standards, unless they are out of reach of an ideal run on race skis
    this.idealTime = referenceTime(tr, RACE_SKI);
    this.medals = sessionMedals(this.course, this.idealTime);
    if (this.mode === 'race' && !this.bots.length) this.spawnBots();
    if (this.mode === 'trial' && !this.ghost) this.loadGhost();
    if (!this.guideLat) this.buildGuide();
    if (!this.gateBars) this.buildGateBars();
    // a floodlit night course: night falls, the masts light the snow (floodlights.js)
    if (this.course.def?.night && !this.floodlights && this.scene?.isObject3D) {
      try { this.floodlights = new CourseFloodlights(this.scene, this.course, this.course.group); } catch (e) { console.warn('Race: floodlights failed', e); }
    }
    this.preparePlayer();
    this.showHud();
    this.reset();
    this.active = true;
    this.audio?.music?.('race');
    if (this.introEnabled && !this.introDone) this.beginIntro();
    if (!this.cine) this.audio?.announce?.(this.courseId); // (after the intro flyover otherwise)
  }

  // Race HUD panels (again after a RETRY: the results screen hides them). Shows the current PB.
  showHud() {
    this.raceHud?.show?.({
      courseName: this.course.name, mode: this.mode, checkpoints: this.cps.length - 1,
      best: getRecord(this.save, this.courseId)?.best ?? undefined,
      difficulty: this.mode === 'race' && !this.mp ? DIFFICULTY[this.difficulty].label : null, total: this.fieldSize(),
    });
  }
  /** Racers in this race: you, the AI field, and in multiplayer the other players. */
  fieldSize() { return this.bots.length + 1 + (this.mp ? Math.max(0, (this.mpGrid?.n || 1) - 1) : 0); }
  /** Multiplayer: the other players (safe: [] without). */
  mpField() {
    if (!this.mp) return [];
    try { return this.mp.field() || []; } catch (e) { console.warn('Race: multiplayer field', e); return []; }
  }
  /** Multiplayer: the server's final result for this race, or null. */
  mpResult() {
    if (!this.mp) return null;
    try { return this.mp.result?.() || null; } catch { return null; }
  }

  spawnBots() {
    const tr = this.track;
    const seed = hashStr(this.courseId + ':' + this.difficulty); // same rivals on every retry
    const { specs, refTime } = createField(tr, { difficulty: this.difficulty, count: this.botCount, seed, playerSki: this.player.ski });
    this.refTime = refTime;
    // outfits: rotate the racer characters, avoiding the player's own look where possible
    const mine = this.save.character;
    const chars = this.botCharacters.filter((c) => c !== mine);
    const pool = chars.length ? chars : this.botCharacters;
    const worn = [];
    specs.forEach((sp, i) => {
      // a character whose model failed to load falls through to the next outfit
      let rig = null, char = pool[i % pool.length];
      for (let k = 0; k < pool.length && !rig; k++) {
        char = pool[(i + k) % pool.length];
        try { rig = this.makeRig?.(char, sp.ski) || null; } catch (e) { console.warn('Race: bot rig failed', char, e?.message || e); }
      }
      if (rig) {
        rig.setCarry?.(false);
        rig.setSkisVisible?.(true);
        rig.addTo(this.scene);
      }
      const b = new BotRacer(sp, tr, { rig, fxId: 3000 + i * 4 });
      b.char = char;
      worn.push(char);
      this.bots.push(b);
    });
    // far racers are drawn as one instanced stand-in each (a skinned rig + IK per racer is the expensive
    // part of a 15-racer field)
    try { if (this.scene?.isObject3D && this.bots.length) this.far = new FarRacers(this.scene, worn); } catch (e) { console.warn('Race: far racers failed', e); this.far = null; }
  }

  /**
   * The line the HUD's NEXT arrow points along (no arrows on the snow: the user asked for them gone): the
   * racing line where it must be held (through every gate, lined up for narrow kickers) and a gentle,
   * centred version of it elsewhere.
   */
  buildGuide() {
    try {
      const tr = this.track, plan = tr.planFor(0.6, 0);
      this.guideLat = (s) => tr.sample(plan, s);
    } catch (e) { console.warn('Race: guide line failed', e); this.guideLat = () => 0; }
  }

  // Green bars between the flags of every gate (gatebars.js), in course order like track.gates.
  buildGateBars() {
    const G = (this.course.gates || []).filter((g) => g && Number.isFinite(g.x) && Number.isFinite(g.z));
    if (!G.length || !this.scene?.isObject3D) return;
    try {
      const order = G.map((g) => ({ g, s: Number.isFinite(g.s) ? g.s : this.track.nearestS(g.x, g.z) })).sort((a, b) => a.s - b.s);
      this.gateBars = new GateBars(this.scene, order.map(({ g }) => {
        const w = g.width || 5, d = g.side || 1;
        return { ax: g.x, az: g.z, bx: g.x + g.nx * d * w, bz: g.z + g.nz * d * w };
      }));
      this.gateBars.next(0);
    } catch (e) { console.warn('Race: gate bars failed', e); this.gateBars = null; }
  }

  loadGhost() {
    const g = loadGhost(this.courseId);
    this.ghostData = g;
    this.ghostSplits = g?.meta?.splits || getRecord(this.save, this.courseId)?.splits || null;
    // where the ghost's run collected gate penalties (its official time = raw time + these)
    this.ghostPen = Array.isArray(g?.meta?.penalties) ? g.meta.penalties.filter(Number.isFinite) : [];
    if (!g) return;
    let rig = null;
    try { rig = this.makeRig?.(g.meta.char || this.save.character || this.botCharacters[0], g.meta.ski || this.save.skis || 'pro') || null; } catch (e) { console.warn('Race: ghost rig failed', e); }
    this.ghost = new GhostRunner({ scene: this.scene, rig, run: g.run, opacity: 0.35 });
    this.ghost.player.buildProgress((x, z, hint) => this.projectXZ(x, z, hint));
  }

  preparePlayer() {
    const pl = this.player;
    if (this.prepared) return;
    this.prepared = true;
    // race skis are on the house if you don't own a pair yet (given back in dispose)
    this.lentSkis = !pl.hasSkis;
    pl.hasSkis = true;
    pl.setSkisOn?.(true);
    pl.mode = 'ski';
    pl.rig?.setSkisVisible?.(true);
    // never auto-unclip on the course's flat start or finish areas
    this.prevAutoSkisOff = pl.autoSkisOff;
    this.prevZones = pl.skiZones;
    if ('autoSkisOff' in pl) pl.autoSkisOff = false;
    else {
      // older player controllers: mark the whole course as a ski zone instead
      const zones = [...(pl.skiZones || [])];
      const fr = {};
      for (let s = this.track.s0; s < this.track.finishS + 120; s += 40) {
        this.track.frame(s, fr);
        zones.push({ x: fr.x, z: fr.z, r: fr.w + 25 });
      }
      pl.skiZones = zones;
    }
  }

  // Everyone back on the grid, countdown from the top.
  reset() {
    this.attempt++;
    this.resultsToken++; // a results screen of an earlier attempt can no longer exit the session
    this.endCine(); // a podium / replay of the previous attempt (an intro is cut short)
    presentation.cancel();
    const tracks = this.bots.length + 1;
    if (!this.replayBuf || this.replayBuf.tracks !== tracks) this.replayBuf = new ReplayBuffer(tracks);
    else this.replayBuf.reset();
    this.photoDone = false;
    this.podiumDone = false;
    this.resultsArgs = null;
    this.mpWaitShown = false; this.mpShown = null;
    this.clock = -(LEAD_IN + 3);
    if (this.syncGo) { const s = this.syncGo(); if (Number.isFinite(s)) this.clock = -Math.max(0.5, s); }
    this.state = 'countdown';
    this.lastCount = null;
    this.goHidden = false;
    this.finished = false;
    this.playerFinished = false;
    this.resultsAt = Infinity;
    this.finalTime = null;
    this.rawTime = null;
    this.timeRes = null;
    this.placeRes = null;
    this.placeDone = false;
    this.lastCp = 0;
    this.nextCp = 1;
    this.splits = [];
    this.nextGate = 0;
    this.missed.clear();
    if (this.gateBars) { this.gateBars.reset(); this.gateBars.next(0); }
    this.penalty = 0;
    this.points = 0;
    this.offT = 0; this.fellT = 0; this.wrongT = 0; this.wrongShown = -99; this.invuln = 0;
    // a respawn of the previous attempt is void (its fade callback finds nothing pending)
    this.pending = null;
    this.endSettle();
    this.ghostDelta = undefined;
    this.overtakes = 0;
    this.respawns = 0;
    this.crashes = 0;
    this.lastImpact = 0;
    this.rank = null;
    this.standingsT = 0;
    this.standingsCache = [];
    this.run = null;
    this.rec = new GhostRecorder();
    this.parkCount = 0;
    this.prevOrder.length = 0;
    // start grid: the player at the start wand, the field abreast and staggered behind
    const mpSlot = this.mpGrid ? this.mpGrid.slot : 0;
    const slots = this.gridSlots(Math.max(this.bots.length + 1, this.mpGrid ? Math.max(this.mpGrid.n, mpSlot + 1) : 0));
    const me = slots[mpSlot];
    if (mpSlot) { slots.splice(mpSlot, 1); slots.splice(0, 0, me); } // (bots, if any, take the other slots)
    this.bots.forEach((b, i) => {
      const sl = slots[i + 1];
      b.reset(sl.s, sl.lat, this.attempt);
      b.cpNext = 1;
      b.splits = [];
      b.parked = false;
      b.parkRank = 0;
    });
    this.placePlayer(me.s, me.lat, 0);
    this.progS = me.s; // stuck detection: best progress so far and when it last moved on
    this.progT = 0;
    this.player.frozen = true;
    this.player.hold = true; // the player controller keeps a grounded skier still in the start gate
    this.grid = { pos: this.player.pos.clone(), heading: this.player.heading };
    this.raceHud?.countdown?.(null);
    // first frame of the bots/ghost so they stand on the grid right away
    this.updateBots(0.0001, this.clock);
    if (this.ghost) this.ghost.update(this.clock, 0.0001, this.cameraPos(), this.groundNormal, this.player.pos);
  }

  /**
   * Start grid, slot 0 = the player at the start wand (course.start, centre of the track). The field
   * lines up abreast on both sides like a ski-cross start and in staggered rows behind when the track
   * is too narrow; every slot stays clear of the start house, the other racers and the barriers.
   * @returns {Array<{ s: number, lat: number, row: number }>} lateral left-positive
   */
  gridSlots(n) {
    const tr = this.track, c = this.course;
    const s0 = Number.isFinite(c.start?.s) ? c.start.s : tr.s0 + 4;
    const obs = this.startObstacles(s0);
    const house = !obs && Number.isFinite(c.startHouse?.s) ? c.startHouse.s : null;
    const side = hashStr(this.courseId) & 1 ? 1 : -1; // which side an odd racer out stands on
    const slots = [{ s: s0, lat: 0, row: 0 }];
    const fits = (s, lat) => {
      if (Math.abs(lat) > tr.halfWidth(s) - GRID_EDGE) return false;
      if (house !== null && Math.abs(s - house) < HOUSE_REACH && Math.abs(lat) < HOUSE_HALF) return false;
      if (this.blockedAt(obs, s0, s, lat)) return false;
      for (const q of slots) if (Math.hypot(q.s - s, q.lat - lat) < GRID_GAP) return false;
      return true;
    };
    // lanes of a row, nearest the centre first: even rows 0, 3.1, 5.7 ... (the player owns 0 in the
    // front row), odd rows in the gaps of the row in front: 1.55, 4.4, 7.0 ...
    const lanesOf = (row) => {
      const out = [];
      if (row % 2) {
        out.push(GRID_FIRST / 2);
        for (let l = GRID_FIRST + GRID_SPACING / 2; l < 30; l += GRID_SPACING) out.push(l);
      } else {
        if (row > 0) out.push(0);
        for (let l = GRID_FIRST; l < 30; l += GRID_SPACING) out.push(l);
      }
      return out.flatMap((l) => (l === 0 ? [0] : [side * l, -side * l]));
    };
    for (let row = 0; row < 10 && slots.length < n; row++) {
      const s = s0 - row * GRID_ROW;
      for (const lat of lanesOf(row)) {
        if (slots.length >= n) break;
        if (fits(s, lat)) slots.push({ s, lat, row });
      }
    }
    // a track too narrow for the whole field: the rest queue up behind on the centre line
    for (let k = 1; slots.length < n; k++) slots.push({ s: s0 - (10 + k) * GRID_ROW, lat: 0, row: 10 + k });
    return slots;
  }

  /**
   * Where the course meshes stand on the snow around the start, in the start's track frame (s along,
   * lateral left-positive): a set of occupied OBS_CELL cells built from the real triangles of every mesh
   * (start house, wand posts, arch feet, boards, flags) between OBS_LOW and OBS_HIGH above the snow, so
   * an arch only blocks its feet and a roof overhead blocks nothing. Snow decals are left out.
   * @returns {{ cells: Set<number>, cell: (s: number, lat: number) => number } | null}
   */
  startObstacles(s0) {
    if (this._startObs !== undefined) return this._startObs;
    this._startObs = null;
    const g = this.course?.group;
    if (!g?.isObject3D) return null;
    const tr = this.track, fr = tr.frame(s0, {});
    const fx = Math.sin(fr.h), fz = Math.cos(fr.h);
    const R = OBS_REACH, C = OBS_CELL, N = Math.ceil((2 * R) / C);
    const cells = new Set();
    const key = (i, j) => i * 4096 + j;
    const cell = (a, l) => key(Math.floor((a + R) / C), Math.floor((l + R) / C));
    const gy = (a) => tr.frame(s0 + a, this._obsFr || (this._obsFr = {})).y;
    const v = new THREE.Vector3(), m = new THREE.Matrix4(), im = new THREE.Matrix4();
    const A = [0, 0, 0], L = [0, 0, 0], Y = [0, 0, 0];
    const box = new THREE.Box3();
    g.updateMatrixWorld(true);
    const mark = (a0, a1, l0, l1) => {
      const i0 = Math.max(0, Math.floor((a0 + R) / C)), i1 = Math.min(N - 1, Math.floor((a1 + R) / C));
      const j0 = Math.max(0, Math.floor((l0 + R) / C)), j1 = Math.min(N - 1, Math.floor((l1 + R) / C));
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) cells.add(key(i, j));
    };
    const tri = (pos, ia, ib, ic, mw) => {
      let lo = Infinity, hi = -Infinity;
      const idx = [ia, ib, ic];
      for (let k = 0; k < 3; k++) {
        v.fromBufferAttribute(pos, idx[k]).applyMatrix4(mw);
        const dx = v.x - fr.x, dz = v.z - fr.z;
        A[k] = dx * fx + dz * fz; L[k] = dx * fr.nx + dz * fr.nz; Y[k] = v.y;
      }
      const a0 = Math.min(A[0], A[1], A[2]), a1 = Math.max(A[0], A[1], A[2]);
      if (a1 < -R || a0 > R) return;
      const l0 = Math.min(L[0], L[1], L[2]), l1 = Math.max(L[0], L[1], L[2]);
      if (l1 < -R || l0 > R) return;
      const base = gy((a0 + a1) / 2);
      for (let k = 0; k < 3; k++) { lo = Math.min(lo, Y[k] - base); hi = Math.max(hi, Y[k] - base); }
      if (hi < OBS_LOW || lo > OBS_HIGH) return;
      mark(a0, a1, l0, l1);
    };
    g.traverse((o) => {
      if (!o.isMesh || o.isSkinnedMesh || !o.geometry?.attributes?.position) return;
      const geo = o.geometry, pos = geo.attributes.position, index = geo.index;
      if (!geo.boundingBox) geo.computeBoundingBox();
      const n = o.isInstancedMesh ? o.count : 1;
      for (let k = 0; k < n; k++) {
        if (o.isInstancedMesh) { o.getMatrixAt(k, im); m.multiplyMatrices(o.matrixWorld, im); } else m.copy(o.matrixWorld);
        // quick reject: the whole (instance's) mesh far from the start
        box.copy(geo.boundingBox).applyMatrix4(m);
        const cx = (box.min.x + box.max.x) / 2 - fr.x, cz = (box.min.z + box.max.z) / 2 - fr.z;
        const rad = Math.hypot(box.max.x - box.min.x, box.max.z - box.min.z) / 2;
        if (Math.hypot(cx, cz) - rad > R * 1.5) continue;
        const tris = index ? index.count / 3 : pos.count / 3;
        for (let t = 0; t < tris; t++) {
          if (index) tri(pos, index.getX(t * 3), index.getX(t * 3 + 1), index.getX(t * 3 + 2), m);
          else tri(pos, t * 3, t * 3 + 1, t * 3 + 2, m);
        }
      }
    });
    this._startObs = { cells, cell, reach: R, size: C };
    return this._startObs;
  }

  // Does a racer standing at (s, lat) of the start frame (s0) touch a course mesh?
  blockedAt(obs, s0, s, lat) {
    if (!obs) return false;
    const L = RACER_HALF_LEN + OBSTACLE_GAP, W = RACER_HALF_W + OBSTACLE_GAP, C = obs.size;
    for (let a = s - s0 - L; a <= s - s0 + L + 1e-6; a += C / 2) {
      for (let l = lat - W; l <= lat + W + 1e-6; l += C / 2) if (obs.cells.has(obs.cell(a, l))) return true;
    }
    return false;
  }

  placePlayer(s, latL, speed) {
    const tr = this.track, pl = this.player;
    const fr = tr.frame(s, {});
    const x = fr.x + fr.nx * latL, z = fr.z + fr.nz * latL;
    pl.teleport(x, z, fr.h, fr.y); // the track level picks the deck on bridges (resets air / trick state)
    pl.pos.y = tr.ground(x, z, fr.y + 0.5, fr.y);
    pl.vel.set(Math.sin(fr.h), 0, Math.cos(fr.h)).multiplyScalar(speed);
    if (speed > 0 && 'parked' in pl) pl.parked = false; // a rolling restart, not a parked skier
    pl.mode = 'ski';
    pl.air = false;
    pl.airTime = 0;
    pl.fallT = 0;
    if (typeof pl.steer === 'number') pl.steer = 0;
    if (typeof pl.lean === 'number') pl.lean = 0;
    pl.camYaw = fr.h + Math.PI;
    pl.camPitch = -0.14;
    pl.camPos?.set(x - Math.sin(fr.h) * 5, pl.pos.y + 2.6, z - Math.cos(fr.h) * 5);
    this.ps = s;
    this.prevS = s;
    this.platL = latL;
    this.prevLat = latL;
  }

  // ------------------------------------------------------------------ frame
  update(dt, input) {
    if (!this.active || this.disposed) return;
    this.takeCrashEvents();
    if (!(dt > 0)) return;
    if (input?.hit?.('Backspace') && this.state !== 'results' && !this.mp) { this.restart(); return; } // (no restarts in a shared race)
    this.floodlights?.update(dt);
    if (this.state === 'intro') { this.updateIntro(dt); return; }
    this.clock += dt;
    const T = this.clock;
    if (this.state === 'countdown') this.updateCountdown(T, dt);
    else this.updatePlayer(dt, T);
    this.updateRespawn(T);
    this.updateBots(dt, T);
    this.updateGhost(dt, T);
    if (this.state !== 'results') this.updateHud(T, dt);
    if (this.state === 'finished' && T >= this.resultsAt && !this.cine) this.maybeShowResults(T);
    if (this.mp) this.updateMp(T);
    this.recordReplay(T);
    this.gateBars?.update(dt);
    // podium / replay: rigs and camera, after everything else has moved this frame (real time: the
    // presentation time scale is 1 while a cinematic runs)
    if (this.cine) this.updateCine(dt / Math.max(0.05, presentation.timeScale));
    this.takeCrashEvents(); // e.g. a barrier slam this frame
  }

  // ------------------------------------------------------------------ presentation
  // Intro: the field waits in the start gate while the camera flies the course; then the countdown.
  beginIntro() {
    const camera = this.player.camera;
    if (!camera || !this.ui) { this.introDone = true; return; }
    let director;
    try {
      director = new CourseIntro({
        track: this.track, course: this.course, camera, player: this.player, heading: this.grid.heading,
        ui: this.ui, info: this.introInfo(), audio: this.audio, waiting: () => this.covered(),
      });
    } catch (e) {
      console.warn('Race: intro failed', e);
      this.introDone = true;
      return;
    }
    this.cine = { kind: 'intro', director };
    this.state = 'intro';
    presentation.cancel();
    presentation.cinematic = 'intro';
    lockRig(this.player.rig);
    this.ui.cinematic(true);
    this.addSkipKeys(() => director.skip());
  }

  // true while the branded transition still covers the screen (the intro waits for the reveal)
  covered() {
    const tr = this.transition, el = tr?.el;
    if (!tr?.active || !el) return false;
    return (el.classList.contains('cover') && !el.classList.contains('reveal')) || el.classList.contains('dark');
  }

  introInfo() {
    const c = this.course, tr = this.track;
    const len = Number.isFinite(c.length) ? c.length : tr.finishS - tr.s0;
    const stats = [['LENGTH', len >= 1000 ? `${(len / 1000).toFixed(1)}<small>KM</small>` : `${Math.round(len)}<small>M</small>`]];
    if (Number.isFinite(c.drop)) stats.push(['DROP', `${Math.round(c.drop).toLocaleString('en-US')}<small>M</small>`]);
    const diff = String(c.difficulty || '').trim();
    if (diff) stats.push(['RATING', `<i class="diff-sign ${esc(diff.toLowerCase())}"></i>${esc(diff)}`]);
    let weather = typeof this.weather === 'function' ? this.weather() : this.weather;
    if (!weather) weather = globalThis.__game?.env?.weatherLabel;
    if (weather) stats.push(['WEATHER', esc(weather)]);
    const kicker = this.mode === 'race'
      ? `RACE · ${DIFFICULTY[this.difficulty].label} · ${this.bots.length + 1} RACERS`
      : 'WORLD RACING · TIME TRIAL';
    return { kicker: kicker.toUpperCase(), title: c.name, stats };
  }

  updateIntro(dt) {
    const pl = this.player, c = this.cine;
    // the field waits in the start gate
    pl.pos.copy(this.grid.pos);
    pl.vel.set(0, 0, 0);
    pl.heading = this.grid.heading;
    pl.frozen = true;
    if (pl.mode !== 'ski') pl.mode = 'ski';
    this.updateBots(dt, this.clock);
    this.updateGhost(dt, this.clock);
    const D = c.director;
    if (!D.update(dt)) { this.endIntro(); return; }
    // the announcer names the course as the crane settles behind the racer
    if (!this.courseCalled && D.t > D.duration - 2.2) { this.courseCalled = true; this.audio?.announce?.(this.courseId); }
    // the racer is on show (first person hides the body) until the camera reaches the first-person eye
    if (pl.view === 'first' && D.t > D.duration - 0.5) unlockRig(pl.rig);
    else if (pl.rig?.__cine) {
      const st = this._introSt || (this._introSt = {});
      Object.assign(st, pl.rigState);
      st.fp = false;
      poseRig(pl.rig, pl.pos.x, pl.pos.y, pl.pos.z, dt, st);
    }
  }

  endIntro() {
    this.endCine();
    this.state = 'countdown';
    this.clock = -(INTRO_LEAD_IN + 3);
    // skipped before the announcer named the course: name it now, with time for it before the "three"
    if (!this.courseCalled) { this.courseCalled = true; this.audio?.announce?.(this.courseId); this.clock -= 1.2; }
    this.lastCount = null;
    const race = this.raceHud?.$?.race;
    if (race && !race.hidden) replayAnim(race, 'in'); // the race panels slide in now
  }

  /** Skip keys (Space / Enter, + Escape in replays) and a click run fn while a cinematic plays. */
  addSkipKeys(fn, escape = false) {
    this.removeSkipKeys();
    if (typeof addEventListener === 'undefined') return;
    const t0 = performance.now();
    const ready = () => performance.now() - t0 > 400; // keys still held from before
    const onKey = (e) => {
      if (!(SKIP_KEYS.has(e.code) || (escape && e.code === 'Escape')) || e.repeat || !ready()) return;
      e.preventDefault();
      e.stopPropagation(); // never reaches the game input (no jump) or the menus
      fn();
    };
    const onDown = (e) => { if (e.button === 0 && ready()) fn(); };
    addEventListener('keydown', onKey, true);
    addEventListener('mousedown', onDown, true);
    this.skipOff = () => { removeEventListener('keydown', onKey, true); removeEventListener('mousedown', onDown, true); };
  }

  removeSkipKeys() {
    this.skipOff?.();
    this.skipOff = null;
  }

  /** End whatever cinematic runs and hand every rig and the camera back to the game. */
  endCine() {
    const c = this.cine;
    this.cine = null;
    presentation.cinematic = null;
    this.removeSkipKeys();
    if (!c) return;
    if (c.kind === 'intro') { this.introDone = true; c.director.skip(); }
    try { c.director.dispose?.(); } catch (e) { console.warn('Race: presentation cleanup failed', e); }
    const rig = this.player.rig;
    unlockRig(rig);
    showRig(rig, true);
    rig?.setSkisVisible?.(true);
    rig?.snapPose?.();
    for (const b of this.bots) {
      if (!b.rig) continue;
      showRig(b.rig, b.visible !== false);
      b.rig.setSkisVisible?.(true);
      b.animAcc = 1; // a fresh pose on the next animate (not the carried cinematic one)
    }
    this.ui?.reset();
    this.hud?.setBlocking?.('replay', false);
  }

  updateCine(dt) {
    const c = this.cine;
    if (c.kind === 'podium') {
      const showing = c.director.update(dt);
      if (!showing && !c.resultsUp) {
        // the results come up over the podium (the scene keeps going behind them)
        c.resultsUp = true;
        this.removeSkipKeys();
        this.ui?.cinematic(false);
        this.showResults();
      }
    } else if (c.kind === 'replay' && !c.ending) {
      if (!c.director.update(dt)) this.finishReplay();
    }
  }

  // Every racer into the replay ring buffer at REPLAY_RATE (from GO until a little after the line).
  recordReplay(T) {
    const B = this.replayBuf;
    if (!B || T < 0 || this.cine?.kind === 'replay' || (this.state !== 'racing' && this.state !== 'finished')) return;
    if (this.playerFinished && T > this.finishClock + REPLAY_AFTER) return;
    if (!B.due(T)) return;
    const pl = this.player;
    B.write(0, pl.pos, pl.rigState || pl, pl.mode === 'fall');
    const bs = this._botRec || (this._botRec = {});
    this.bots.forEach((b, i) => {
      const a = b.anim || {};
      bs.heading = b.heading; bs.speed = b.v; bs.crouch = a.crouch ?? 0.2; bs.lean = b.lean; bs.edge = b.edge;
      bs.skid = b.skidYaw; bs.tuck = !!a.tuck; bs.air = !!(b.air && b.airT > 0.1); bs.plow = 0;
      B.write(i + 1, b.pos, bs, false);
    });
  }

  // A rival reaching the line within PHOTO_GAP of the player: slow motion through the finish.
  checkPhotoFinish(s, vS, T) {
    const tr = this.track;
    const ttl = (tr.finishS - s) / Math.max(1, vS);
    if (!(ttl > 0 && ttl < 0.45)) return;
    for (const b of this.bots) {
      const bt = b.finished ? b.finishTime - T : (tr.finishS - b.s) / Math.max(1, b.v);
      if (Math.abs(bt - ttl) < PHOTO_GAP) {
        this.photoDone = true;
        presentation.slowMo({ scale: 0.3, easeIn: 0.12, hold: 1.0, easeOut: 0.45, reason: 'photo' });
        return;
      }
    }
  }

  // Finishing order with the rigs: [{ rig, name, time, me }]
  rankedRacers() {
    const list = [{ rig: this.player.rig, name: 'You', time: this.finalTime, me: true }];
    for (const b of this.bots) {
      let time = b.finished ? b.finishTime : NaN;
      if (!b.finished) { try { time = b.projectFinish(); } catch { time = NaN; } }
      list.push({ rig: b.rig, name: b.name, time, me: false });
    }
    const key = (r) => (Number.isFinite(r.time) ? r.time : Infinity);
    return list.sort((a, b) => key(a) - key(b));
  }

  // RACE: the top three on the podium before the results.
  startPodium() {
    this.podiumDone = true;
    const camera = this.player.camera;
    if (!camera || !this.ui) return false;
    const ranked = this.rankedRacers();
    const top = ranked.slice(0, 3);
    const hide = ranked.slice(3).map((r) => r.rig).filter(Boolean);
    let director;
    try {
      director = new Podium({
        scene: this.scene, track: this.track, camera, top, hide, spray: this.spray, ui: this.ui, audio: this.audio,
        info: {
          kicker: `PODIUM · ${DIFFICULTY[this.difficulty].label}`.toUpperCase(), title: this.course.name,
          rows: top.map((r, i) => ({ place: i + 1, name: r.name, time: Number.isFinite(r.time) ? fmtTime(r.time) : 'DNF', me: r.me })),
        },
      });
    } catch (e) {
      console.warn('Race: podium failed', e);
      return false;
    }
    lockRig(this.player.rig);
    this.audio?.music?.('results');
    this.cine = { kind: 'podium', director };
    presentation.cancel();
    presentation.cinematic = 'podium';
    this.ui.cinematic(true);
    this.addSkipKeys(() => director.skip());
    return true;
  }

  // WATCH REPLAY on the results screen (button + V). Returns a cleanup for the key listener.
  offerReplay() {
    const B = this.replayBuf;
    if (typeof document === 'undefined' || !B || B.count < REPLAY_RATE * 2 || !this.player.camera || !this.ui) return null;
    const host = document.querySelector('#race-results .rr-actions');
    if (!host) return null;
    const btn = document.createElement('button');
    btn.className = 'brush-btn rr-btn pres-replay-btn';
    btn.tabIndex = -1;
    btn.dataset.choice = 'replay';
    btn.innerHTML = `${brushSVG(379)}<span>WATCH REPLAY<i class="kc">V</i></span>`;
    host.prepend(btn);
    const pick = () => { const fin = this.raceHud?.pending; if (typeof fin === 'function') fin('replay'); };
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', pick);
    btn.addEventListener('mouseenter', () => {
      for (const b of host.querySelectorAll('.is-focus')) b.classList.remove('is-focus');
      btn.classList.add('is-focus');
      this.audio?.play?.('tick');
    });
    btn.addEventListener('mouseleave', () => btn.classList.remove('is-focus'));
    const t0 = performance.now();
    const onKey = (e) => {
      if (e.code !== 'KeyV' || e.repeat || performance.now() - t0 < 600) return;
      e.preventDefault();
      e.stopPropagation();
      pick();
    };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  }

  async startReplay() {
    if (this.disposed) return;
    const token = this.resultsToken;
    this.hud?.setBlocking?.('replay', true); // gameplay input off (no mouse look) while it plays
    presentation.cancel();
    await this.ui?.sting('REPLAY');
    if (this.disposed || token !== this.resultsToken) { this.hud?.setBlocking?.('replay', false); return; }
    this.endCine(); // the podium behind the results
    this.hud?.setBlocking?.('replay', true);
    const director = new ReplayDirector({
      buffer: this.replayBuf, track: this.track, course: this.course, camera: this.player.camera, ui: this.ui,
      project: (x, z, hint) => this.projectXZ(x, z, hint),
      racers: [{ rig: this.player.rig }, ...this.bots.map((b) => ({ rig: b.rig }))],
      finishClock: this.playerFinished ? this.finishClock : NaN,
      clockText: (t) => fmtTime(clamp(t, 0, Number.isFinite(this.rawTime) ? this.rawTime : t)),
    });
    lockRig(this.player.rig);
    this.cine = { kind: 'replay', director, token };
    presentation.cinematic = 'replay';
    this.ui.cinematic(true);
    this.ui.badge(true);
    this.ui.skipHint('SKIP');
    this.addSkipKeys(() => this.finishReplay(), true);
  }

  async finishReplay() {
    const c = this.cine;
    if (!c || c.kind !== 'replay' || c.ending) return;
    c.ending = true;
    this.removeSkipKeys();
    await this.ui?.sting('REPLAY');
    if (this.cine !== c) return; // restarted / disposed meanwhile
    this.endCine();
    if (!this.disposed && c.token === this.resultsToken) this.presentResults();
  }

  // While a session runs it owns wipeouts (fade + respawn at the checkpoint): the player's 'crash'
  // events are taken out of player.events before the host reads them, so the host's free-ride wipeout
  // handling (fade back to the village) can never fire during a race.
  takeCrashEvents() {
    const ev = this.player.events;
    if (!ev?.length) return;
    let j = 0;
    for (let i = 0; i < ev.length; i++) {
      if (ev[i] === 'crash') this.crashes++;
      else ev[j++] = ev[i];
    }
    ev.length = j;
  }

  updateCountdown(T, dt) {
    const pl = this.player;
    // hold the player in the start gate
    pl.pos.copy(this.grid.pos);
    pl.vel.set(0, 0, 0);
    pl.heading = this.grid.heading;
    pl.frozen = true;
    if (pl.mode !== 'ski') pl.mode = 'ski';
    if (T >= -3) {
      const c = Math.min(3, Math.ceil(-T));
      if (c >= 1 && c !== this.lastCount) {
        this.lastCount = c;
        this.raceHud?.countdown?.(c);
        this.audio?.play?.('beep');
        this.audio?.announce?.(c);
      }
    }
    if (T >= 0) this.go(T, dt);
  }

  go(T, dt) {
    this.state = 'racing';
    this.player.frozen = false;
    this.player.hold = false;
    this.player.startPush?.(); // out of the gate with a few strong pushes
    this.raceHud?.countdown?.('GO');
    this.audio?.play?.('go');
    this.audio?.announce?.('go');
    for (const b of this.bots) { b.go(); b.acc = T - dt; } // this frame simulates exactly T seconds of race
  }

  updatePlayer(dt, T) {
    const pl = this.player, tr = this.track, c = this.course;
    if (!this.goHidden && T >= 1.3) { this.goHidden = true; this.raceHud?.countdown?.(null); } // after the GO fade
    this.invuln = Math.max(0, this.invuln - dt);
    // skis stay on during a race
    if (pl.mode === 'walk') { pl.setSkisOn?.(true); pl.mode = 'ski'; }

    // barriers: the course puts the skier back inside its track, the session decides the bounce
    let pr = this.projectPlayer();
    const v0 = this._v0; // velocity before the contact
    v0.x = pl.vel.x; v0.y = pl.vel.y; v0.z = pl.vel.z;
    const hit = typeof c.constrain === 'function' ? c.constrain(pl.pos, pl.vel, pr.s) : this.fallbackConstrain(pr);
    if (hit?.hit) {
      this.barrierContact(v0, hit, pr);
      pr = this.projectPlayer(); // where the barrier left the skier
    }

    const s = pr.s;
    const vS = (s - this.prevS) / dt;
    // snow under the player (ice sections): the player's ski physics read frictionScale
    if (typeof c.frictionAt === 'function') pl.frictionScale = c.frictionAt(s) ?? 1;
    if (this.state === 'racing') {
      this.checkCheckpoints(s, vS, T);
      this.checkGates(s, pr.lat);
      if (!this.photoDone && this.mode === 'race' && !this.playerFinished && this.bots.length) this.checkPhotoFinish(s, vS, T);
      if (!this.playerFinished && s >= tr.finishS && Math.abs(pr.lat) <= pr.w + 3 && s - this.prevS < 80) {
        this.finishPlayer(T - Math.max(0, s - tr.finishS) / Math.max(1, vS), T);
      } else {
        this.rec.record(T, {
          x: pl.pos.x, y: pl.pos.y, z: pl.pos.z, heading: pl.heading, crouch: pl.crouch, lean: pl.lean, plow: pl.plow,
          tuck: pl.tuck, air: pl.air, fall: pl.mode === 'fall',
        });
        this.checkRespawn(dt, pr, T);
      }
    }
    if (this.playerFinished) this.skiOut(dt);
    this.prevS = pr.s;
    this.ps = pr.s;
    this.platL = pr.lat;
    this.prevLat = pr.lat;
  }

  // After the line (controls off): brake to a stop and swerve gently around racers stopped ahead.
  skiOut(dt) {
    const pl = this.player, sp = pl.speed;
    if (sp > 0.01) pl.vel.multiplyScalar(Math.max(0, sp - FINISH_BRAKE * dt) / sp);
    if (sp < 1.5 || pl.air || pl.mode !== 'ski') return;
    const fx = pl.vel.x / sp, fz = pl.vel.z / sp;
    let steer = 0;
    for (const b of this.bots) {
      const dx = b.pos.x - pl.pos.x, dz = b.pos.z - pl.pos.z;
      const ahead = dx * fx + dz * fz;
      if (ahead < 0.3 || ahead > sp * 1.6 + 6 || b.v > sp - 0.5) continue;
      const left = dx * fz - dz * fx; // + = the racer is on my left
      const clear = 2.2 - Math.abs(left);
      if (clear > 0) steer += (left >= 0 ? -1 : 1) * clear / Math.max(1.5, ahead);
    }
    if (!steer) return;
    // heading and velocity turn together (heading + = left), so the skis carve the swerve
    const a = clamp(steer * sp * 0.5, -0.35, 0.35) * dt, ca = Math.cos(a), sa = Math.sin(a);
    pl.heading += a;
    const vx = pl.vel.x, vz = pl.vel.z;
    pl.vel.x = vx * ca + vz * sa;
    pl.vel.z = -vx * sa + vz * ca;
  }

  /** Course progress of the player: { s, lat (left +), w, y, inside, h }. */
  projectPlayer() {
    const pl = this.player;
    return this.projectFull(pl.pos.x, pl.pos.z, this.ps, this._pr);
  }

  projectFull(x, z, hint, out) {
    const c = this.course, tr = this.track;
    if (typeof c.project === 'function') {
      const p = c.project(x, z, hint);
      if (p?.far) {
        // nowhere near the course: keep the last progress, flag it as off course
        const fr = tr.frame(Number.isFinite(hint) ? hint : tr.s0, {});
        out.s = fr.s; out.lat = 1e4; out.w = fr.w; out.y = fr.y; out.inside = false; out.h = fr.h;
        return out;
      }
      if (p && Number.isFinite(p.s)) {
        out.s = p.s;
        out.lat = (p.lateral || 0) * tr.latSign;
        out.w = Number.isFinite(p.w) ? p.w : tr.halfWidth(p.s);
        out.y = Number.isFinite(p.y) ? p.y : tr.frame(p.s, {}).y;
        out.inside = p.inside ?? Math.abs(out.lat) <= out.w + 0.5;
        out.h = Number.isFinite(p.heading) ? p.heading : tr.frame(p.s, {}).h;
        return out;
      }
    }
    return tr.project(x, z, hint, out);
  }

  projectXZ(x, z, hint) { return this.projectFull(x, z, hint, {}); }

  /**
   * Barrier contact, tuned to forgive. The course has already put the skier back inside the track; the
   * velocity is rebuilt here from the one before the contact (v0): glancing touches slide along the nets
   * losing a little speed, harder hits bounce back into the track, and skis left pointing into the nets
   * are turned parallel to them (the body pivots out of it with a spray, so nobody grinds along the
   * barrier fighting the controls). Only a near head-on slam (> CRASH_IMPACT m/s straight into the nets)
   * knocks the skier down; never within RESPAWN_GRACE s of a respawn.
   * @param {{x:number,y:number,z:number}} v0  player velocity before course.constrain()
   * @param {{hit:boolean, side:number, impact:number, s?:number}} hit  course.constrain() result
   * @param {{s:number, lat:number}} pr  the player's projection before the contact
   */
  barrierContact(v0, hit, pr) {
    const pl = this.player, tr = this.track;
    if (!hit.side) return; // the closing boards at the end of the finish run-out: the course's stop stands
    const fr = tr.frame(Number.isFinite(hit.s) ? hit.s : pr.s, this._bf);
    // which barrier: from where the skier now stands (any lateral convention), + = the left one
    const latNow = (pl.pos.x - fr.x) * fr.nx + (pl.pos.z - fr.z) * fr.nz;
    const side = Math.sign(latNow) || Math.sign(hit.side * tr.latSign) || 1;
    const ox = fr.nx * side, oz = fr.nz * side; // unit vector into the nets
    const into = v0.x * ox + v0.z * oz;
    if (!(into > 0)) return; // sliding along or away from the nets: the position fix was all it took
    this.lastImpact = into;
    const ax = v0.x - ox * into, az = v0.z - oz * into; // velocity along the nets
    // the nets always catch the skier (the player asked for no wipeouts against nets): a hard hit only
    // costs more speed and a softer, damped bounce back into the track
    const e = lerp(BOUNCE_SOFT, BOUNCE_HARD, smoothstep(3, 14, into)) * (into > CRASH_IMPACT ? 0.5 : 1);
    const keep = 1 - Math.min(into > CRASH_IMPACT ? 0.45 : SCRUB_MAX, into * SCRUB);
    pl.vel.x = ax * keep - ox * into * e;
    pl.vel.z = az * keep - oz * into * e;
    if (pl.mode === 'ski' && !pl.air) this.deflectSkis(ox, oz, ax * keep, az * keep, fr, into);
    if (into > 2.5) {
      this.audio?.play?.('land', Math.min(1, into / 12));
      pl.shake = Math.max(pl.shake || 0, Math.min(0.6, into / 14));
    }
  }

  // Skis pointing into the nets turn parallel to them (toed slightly back toward the track), so the
  // edges carry the skier away instead of steering straight back into the barrier.
  deflectSkis(ox, oz, ax, az, fr, impact) {
    const pl = this.player;
    const fx = Math.sin(pl.heading), fz = Math.cos(pl.heading);
    if (fx * ox + fz * oz <= 0.02) return; // already running along or away from the nets
    // along the nets in the direction of travel (the skis' own sense when barely moving along them)
    let dx = ax, dz = az;
    const al = Math.hypot(dx, dz);
    if (al > 1) { dx /= al; dz /= al; } else {
      const tx = Math.sin(fr.h), tz = Math.cos(fr.h), sg = fx * tx + fz * tz >= 0 ? 1 : -1;
      dx = tx * sg; dz = tz * sg;
    }
    const target = Math.atan2(dx - ox * DEFLECT_TOE, dz - oz * DEFLECT_TOE);
    const maxTurn = lerp(0.3, 1.3, smoothstep(1.5, 8, impact)); // a light scrape only nudges the skis
    const turn = clamp(wrapAngle(target - pl.heading), -maxTurn, maxTurn);
    pl.heading += turn;
    // the body keeps part of the old angle and pivots out of it (kept small: a take-off right after
    // folds this offset back into the heading, and it must never spoil the landing)
    if (typeof pl.yawFx === 'number') {
      pl.yawFx = wrapAngle(pl.yawFx - clamp(turn, -DEFLECT_FX, DEFLECT_FX));
      pl.yawFxV = 0;
    }
  }

  // Barriers for courses without constrain(): keep the skier inside the track width (the session's
  // barrierContact() handles the bounce). Returns a constrain()-style result.
  fallbackConstrain(pr) {
    const pl = this.player, lim = pr.w - 0.35;
    const res = this._fres || (this._fres = { hit: false, side: 0, impact: 0, s: 0 });
    res.hit = false; res.side = 0; res.impact = 0; res.s = pr.s;
    if (Math.abs(pr.lat) <= lim) return res;
    const side = Math.sign(pr.lat);
    const nx = Math.cos(pr.h) * side, nz = -Math.sin(pr.h) * side; // outward (left normal * side)
    const over = Math.abs(pr.lat) - lim;
    pl.pos.x -= nx * over; pl.pos.z -= nz * over;
    res.hit = true;
    res.side = side * this.track.latSign; // in the course's own lateral convention, like constrain()
    res.impact = Math.max(0, pl.vel.x * nx + pl.vel.z * nz);
    return res;
  }

  checkCheckpoints(s, vS, T) {
    if (s - this.prevS > 80) return; // projection jump, not a real crossing
    while (this.nextCp < this.cps.length && s >= this.cps[this.nextCp].s) {
      const k = this.nextCp, cp = this.cps[k];
      const split = T - Math.max(0, s - cp.s) / Math.max(1, vS) + this.penalty;
      this.splits[k - 1] = split;
      this.lastCp = k;
      this.nextCp++;
      let delta = null;
      if (this.mode === 'trial') {
        const pb = this.ghostSplits?.[k - 1];
        if (Number.isFinite(pb)) delta = split - pb;
      } else {
        // gap to the fastest racer through this split
        let best = Infinity;
        for (const b of this.bots) if (Number.isFinite(b.splits?.[k - 1])) best = Math.min(best, b.splits[k - 1]);
        if (best < Infinity) delta = split - best;
      }
      this.raceHud?.checkpoint?.({ index: k, total: this.cps.length - 1, split, delta, name: cp.name });
      this.audio?.play?.('gate');
      this.audio?.announce?.('checkpoint');
    }
  }

  /**
   * Slalom gates: passed between the turning pole and the outer pole (tick); skiing past on the
   * inside of the turning pole or outside the outer flag is a miss (+2 s). The lateral is taken
   * exactly at the gate line, interpolated between the last two frames.
   */
  checkGates(s, lat) {
    const gates = this.track.gates;
    while (this.nextGate < gates.length && s >= gates[this.nextGate].s) {
      const gi = this.nextGate++, g = gates[gi];
      if (s - this.prevS > 80) continue; // projection jump, not a real crossing
      const f = s > this.prevS ? clamp((g.s - this.prevS) / (s - this.prevS), 0, 1) : 1;
      const l = this.prevLat + (lat - this.prevLat) * f;
      const u = (l - g.latA) * g.dir; // 0 = turning pole, g.span = outer pole
      if (u < -GATE_TOL || u > g.span + GATE_FLAG + GATE_TOL) {
        this.missed.add(gi);
        this.gateBars?.set(gi, 'missed');
        this.penalty = this.missed.size * GATE_PENALTY;
        this.notice(`MISSED GATE  +${GATE_PENALTY.toFixed(2)} · AIM FOR THE GREEN`, 'bad');
        this.audio?.play?.('miss');
      } else { this.audio?.play?.('tick'); this.gateBars?.set(gi, 'passed'); }
    }
    this.gateBars?.next(this.nextGate);
  }

  /**
   * When to send the player back to the last checkpoint: a wipeout, no progress down the course for
   * STUCK_TIME s, standing well outside the barriers, or having fallen well below the track. Everything
   * short of that is forgiven: bumps, slow sections, brief excursions and hops never respawn anyone.
   */
  checkRespawn(dt, pr, T) {
    const pl = this.player;
    if (this.pending) return;
    if (pl.mode === 'fall') { this.requestRespawn('crash'); return; }
    // stuck: no real progress for a while (slow but moving on is fine, so is flying)
    if (pr.s > this.progS + STUCK_PROGRESS) { this.progS = pr.s; this.progT = T; } else if (pl.air) this.progT = T;
    if (T - this.progT > STUCK_TIME) { this.requestRespawn('stuck'); return; }
    // off course: out of the barriers' reach on the snow (never mid-air: the flight may bring you back)
    const outBy = Math.abs(pr.lat) - pr.w;
    const off = !pl.air && outBy > OFF_MARGIN;
    this.offT = off ? this.offT + dt : Math.max(0, this.offT - dt);
    if (this.offT > (outBy > FAR_MARGIN ? FAR_TIME : OFF_TIME)) { this.requestRespawn('off'); return; }
    // fell off the course (bridge, cliff): well below the track surface, not on the way up
    const below = pl.pos.y < pr.y - FALL_BELOW && !(pl.air && pl.vel.y > 0);
    this.fellT = below ? this.fellT + dt : 0;
    if (this.fellT > FALL_TIME) { this.requestRespawn('fell'); return; }
    // wrong way warning
    const along = pl.vel.x * Math.sin(pr.h) + pl.vel.z * Math.cos(pr.h);
    this.wrongT = along < -2 ? this.wrongT + dt : Math.max(0, this.wrongT - dt * 2);
    if (this.wrongT > 1.2 && T - this.wrongShown > 3) { this.wrongShown = T; this.notice('WRONG WAY', 'bad'); }
  }

  /** Back to the last checkpoint, behind a fade to dark (public: e.g. a respawn key). */
  respawn(reason = 'manual') {
    if (this.requestRespawn(reason)) this.fadeOut(this.pending, this.clock); // nothing to watch: fade now
  }

  // Queue a respawn; updateRespawn() runs the sequence. False when one is under way or not racing.
  requestRespawn(reason) {
    if (this.pending || this.disposed || !this.active || this.state !== 'racing' || this.playerFinished) return false;
    this.pending = { reason, phase: 'wait', since: this.clock, fadeAt: 0 };
    return true;
  }

  /**
   * Respawn sequence: the wipeout plays out (until the tumble ends, WIPEOUT_MIN..WIPEOUT_MAX s), the
   * screen fades to dark, the player is moved while it is covered (coveredRespawn), holds dark for
   * SETTLE_TIME and fades back in. The race clock keeps running: a crash costs time, not the run.
   */
  updateRespawn(T) {
    if (this.settle && this.clock >= this.settle.until) this.endSettle();
    const p = this.pending;
    if (!p) return;
    if (p.phase === 'wait') {
      if (p.reason === 'crash') {
        const pl = this.player, down = T - p.since;
        const tumbling = pl.mode === 'fall' && pl.fall?.state === 'tumble';
        if (down < WIPEOUT_MIN || (tumbling && down < WIPEOUT_MAX)) return;
      }
      this.fadeOut(p, T);
    } else if (T - p.fadeAt > FADE_WATCHDOG) {
      // the screen never covered (transition busy or broken): respawn without the fade
      this.respawnNow(p.reason);
    }
  }

  // Fade to dark through the game's transition (or the built-in overlay); the move happens when covered.
  fadeOut(p, T) {
    if (!p || p.phase !== 'wait') return;
    p.phase = 'fading';
    p.fadeAt = T;
    const covered = () => this.coveredRespawn(p);
    const failed = (e) => {
      console.warn('Race: respawn fade failed', e);
      if (this.pending === p) this.respawnNow(p.reason); // never leave the player lying in the snow
    };
    let job;
    try {
      const tr = this.transition;
      job = typeof tr?.fade === 'function' ? tr.fade(covered) : overlayFade(covered);
    } catch (e) { failed(e); return; }
    Promise.resolve(job).catch(failed);
  }

  // The screen is dark: move the player, then keep it dark a moment while the camera and the terrain
  // around the checkpoint settle (bounded by SETTLE_CAP_MS so a paused game never holds the dark).
  async coveredRespawn(p) {
    if (this.pending !== p || this.disposed) return; // superseded (restart, dispose, finish, watchdog)
    if (!this.respawnNow(p.reason)) return;
    const pos = this.player.pos;
    const waits = [new Promise((resolve) => { this.settle = { until: this.clock + SETTLE_TIME, resolve }; })];
    if (this.stream) waits.push(Promise.resolve().then(() => this.stream(pos.x, pos.z)).catch(() => {}));
    await Promise.race([Promise.all(waits), sleep(SETTLE_CAP_MS)]);
    this.endSettle();
  }

  endSettle() {
    const st = this.settle;
    this.settle = null;
    st?.resolve();
  }

  /** Move the player to the last checkpoint: on the line, facing downhill, rolling at a modest speed. */
  respawnNow(reason = 'manual') {
    this.pending = null;
    if (!this.active || this.disposed || this.state !== 'racing' || this.playerFinished) return false;
    const tr = this.track, pl = this.player;
    const cp = this.cps[this.lastCp] || this.cps[0];
    const s = Math.max(tr.s0 + 2, cp.s + 2);
    this.placePlayer(s, this.respawnLane(s), RESPAWN_SPEED);
    pl.frozen = false;
    pl.hold = false;
    this.rec.cut();
    this.replayBuf?.cut(0);
    // the gates ahead are back in play: a miss there (e.g. sliding through after a crash) is refunded
    const gi = tr.gates.findIndex((g) => g.s >= s);
    this.nextGate = gi < 0 ? tr.gates.length : gi;
    for (const k of [...this.missed]) if (k >= this.nextGate) this.missed.delete(k);
    if (this.gateBars) { for (let k = this.nextGate; k < tr.gates.length; k++) this.gateBars.set(k, 'ahead'); this.gateBars.next(this.nextGate); }
    this.penalty = this.missed.size * GATE_PENALTY;
    this.offT = 0; this.fellT = 0; this.wrongT = 0;
    this.progS = s; this.progT = this.clock;
    this.invuln = RESPAWN_GRACE;
    this.respawns++;
    this.lastRespawn = reason;
    this.notice('RESPAWN', 'info');
    this.audio?.play?.('whoosh');
    return true;
  }

  // Lateral spot (left-positive) for a respawn: the centre line, unless a racer is about to come
  // through there; then the free lane nearest the centre.
  respawnLane(s) {
    const lim = this.track.halfWidth(s) - 1.5;
    let best = 0, bestScore = -Infinity;
    for (const lat of [0, 2.5, -2.5, 5, -5]) {
      if (Math.abs(lat) > lim) continue;
      let clear = 3; // m of side clearance that counts (enough to stay out of a passing racer's way)
      for (const b of this.bots) {
        if (b.finished || b.s < s - 60 || b.s > s + 10) continue; // only racers about to pass the spot
        clear = Math.min(clear, Math.abs(b.lat - lat));
      }
      const score = clear - Math.abs(lat) * 0.3;
      if (score > bestScore) { bestScore = score; best = lat; }
    }
    return best;
  }

  finishPlayer(rawTime, T) {
    this.playerFinished = true;
    this.finished = true;
    this.state = 'finished';
    this.pending = null; // e.g. a wipeout sliding over the line: the run counts, no respawn
    this.rawTime = Math.max(0, rawTime);
    this.finalTime = this.rawTime + this.penalty;
    this.player.frozen = true;
    this.audio?.play?.('finish');
    this.rec.record(T, {
      x: this.player.pos.x, y: this.player.pos.y, z: this.player.pos.z, heading: this.player.heading,
      crouch: this.player.crouch, lean: this.player.lean, plow: this.player.plow, tuck: this.player.tuck, air: this.player.air, fall: false,
    });
    this.run = this.rec.finish(this.rawTime);
    this.finishClock = T;
    this.resultsAt = T + RESULTS_DELAY;
    // the time counts right away: PB, time medal and ghost are saved at the line (a restart or a quit
    // before the results screen loses nothing); the place follows once the field is home
    this.commitTime();
    // multiplayer: the finish goes to the server right at the line (it checks the time against its own clock)
    if (this.mp) { try { this.mp.finish?.({ time: this.finalTime, raw: this.rawTime, pen: this.penalty, dnf: false }); } catch (e) { console.warn('Race: multiplayer finish', e); } }
    const ahead = this.bots.filter((b) => b.finished && b.finishTime < this.finalTime).length
      + this.mpField().filter((o) => o.finished && !o.dnf).length; // (players home before you: the server has their time)
    if (this.mode === 'race' && !this.penalty) this.notice(ordinal(ahead + 1), ahead < 3 ? 'good' : 'info');
    else if (this.mode === 'trial' && this.timeRes?.pb) this.notice('NEW RECORD', 'good');
    else this.notice('FINISH');
    // finishers still sliding into my ski-out lane pick another one (stopped ones are skied around)
    for (const b of this.bots) {
      if (b.parked && !b.stopped && Math.abs(b.parkLat - this.platL) < 2.6) b.setParking(b.parkRank || 1, this.parkAvoid(b), this.platL);
    }
  }

  commitTime() {
    if (this.timeRes) return this.timeRes;
    this.timeRes = submitTime(this.save, this.courseId, { time: this.finalTime, splits: this.splits, medals: this.medals });
    if (this.timeRes.pb && this.run) {
      const gates = this.track.gates;
      saveGhost(this.courseId, this.run, {
        char: this.save.character, ski: this.save.skis, splits: this.splits.slice(), official: this.finalTime, penalty: this.penalty,
        penalties: [...this.missed].map((k) => gates[k]?.s).filter(Number.isFinite),
      });
    }
    this.persist();
    return this.timeRes;
  }

  // Race place, medal by place and best-place records (once per run).
  commitPlace(place) {
    if (this.placeDone) return this.placeRes;
    this.placeDone = true;
    this.placeRes = submitPlace(this.save, this.courseId, { place, difficulty: this.difficulty });
    this.persist();
    return this.placeRes;
  }

  // A finished run whose results screen never came up (restart / quit in the ski-out): book the place
  // from the field's real and projected finishing times, exactly as the results screen would.
  flushPending() {
    if (!this.playerFinished || this.state === 'results' || this.mode !== 'race' || this.placeDone) return;
    const rows = this.raceRows();
    this.commitPlace(rows.findIndex((r) => r.me) + 1);
  }

  persist() {
    try { this.writeSave?.(); } catch (e) { console.warn('Race: save failed', e); }
  }

  maybeShowResults(T) {
    // multiplayer: the server places everyone; wait for its result (the live standings stay up meanwhile)
    if (this.mp && !this.mpResult() && T < this.finishClock + MP_RESULTS_WAIT) {
      if (!this.mpWaitShown) { this.mpWaitShown = true; this.notice('WAITING FOR THE OTHER RACERS', 'info'); }
      return;
    }
    // give the field a moment to come home (real times instead of projections)
    if (this.mode === 'race' && T < this.finishClock + RESULTS_MAX_WAIT) {
      const close = this.bots.some((b) => !b.finished && (this.track.finishS - b.s) / Math.max(8, b.v) < this.finishClock + RESULTS_MAX_WAIT - T);
      if (close) return;
    }
    if (this.mode === 'race' && !this.mp && !this.podiumDone && this.startPodium()) return; // results after the podium (not in multiplayer: the other racers are not ours to pose)
    this.showResults();
  }

  showResults() {
    if (this.state === 'results') return;
    this.state = 'results';
    const race = this.mode === 'race';
    const res = this.mpResult();
    this.mpShown = res ? 'final' : this.mp ? 'provisional' : null;
    const rows = race ? (res ? this.mpRows(res) : this.raceRows()) : this.trialRows();
    const place = res?.mine ? res.mine.place : race ? rows.findIndex((r) => r.me) + 1 : 1;
    const tres = this.playerFinished ? this.commitTime() : { pb: false, previousBest: getRecord(this.save, this.courseId)?.best, medal: null };
    const out = !this.playerFinished || !!res?.mine?.dnf; // (multiplayer: the race closed before you were home)
    const pres = race ? (out ? { medal: null, newMedal: false } : this.commitPlace(place)) : null;
    const medal = race ? pres.medal : tres.medal;
    if (tres.pb || medal === 'gold') this.audio?.play?.('chime');
    // the stadium announcer: place, medal, personal best (once; not again after a replay)
    const A = this.audio;
    A?.music?.('results');
    if (race && !out && place >= 1 && place <= 3) A?.announce?.(['first', 'second', 'third'][place - 1]);
    if (medal) A?.announce?.(medal, { delay: 1.4 });
    if (tres.pb) A?.announce?.('pb', { delay: 2.6 });
    this.lastResult = { pb: tres.pb, previousBest: tres.previousBest, medal, newMedal: race ? pres.newMedal : tres.newMedal, record: getRecord(this.save, this.courseId), rows, place };
    this.resultsArgs = {
      courseName: this.course.name, mode: this.mode, rows, place, time: this.finalTime, medal,
      pb: tres.pb, previousBest: tres.previousBest, points: this.points || undefined, penalty: this.penalty,
      difficulty: race ? DIFFICULTY[this.difficulty].label : null, medals: this.medals,
    };
    if (res?.mine) {
      // multiplayer: the server's place, prize money (already paid by the server) and standings
      if (res.mine.prize > 0) this.resultsArgs.prize = res.mine.prize;
      if (res.mine.dnf) this.resultsArgs.time = NaN;
      this.resultsArgs.difficulty = `MULTIPLAYER · ${rows.length} RACERS`;
      this.resultsArgs.canNext = false;
      this.resultsArgs.choices = [['continue', 'BACK TO START', 'ENTER']];
    } else if (this.mp) {
      this.resultsArgs.difficulty = 'MULTIPLAYER · PROVISIONAL';
      this.resultsArgs.canNext = false;
      this.resultsArgs.choices = [['continue', 'BACK TO START', 'ENTER']];
    } else if (this.freeRide) {
      // free ride: the podium earns prize money (paid once per run), then RACE AGAIN or BACK TO START (Modes.exitFree)
      try {
        const prize = this.freeRide.result?.({ place: race ? place : 0, time: this.finalTime, dnf: !Number.isFinite(this.finalTime) });
        if (prize > 0) this.resultsArgs.prize = prize;
        if (Number.isFinite(this.freeRide.prizeMult) && race) this.resultsArgs.prizeMult = this.freeRide.prizeMult; // (the AI field's factor)
      } catch (e) { console.warn('Race: free-ride result failed', e); }
      this.resultsArgs.canNext = false;
      this.resultsArgs.choices = [['retry', 'RACE AGAIN', 'R'], ['continue', 'BACK TO START', 'ENTER']];
    } else if (this.choices) this.resultsArgs.choices = this.choices;
    this.presentResults();
  }

  // The results screen (again after a replay). RETRY / NEXT / MENU end the run via onExit; WATCH
  // REPLAY plays the replay and comes back here.
  presentResults() {
    if (!this.resultsArgs) return;
    const token = this.resultsToken;
    let p = null;
    try {
      p = this.raceHud?.results?.(this.resultsArgs);
    } catch (e) { console.error('Race: results failed', e); }
    let off = null;
    try { off = this.offerReplay(); } catch (e) { console.warn('Race: replay offer failed', e); }
    // only the results of the current attempt may end it (a restart in between invalidates them)
    const live = () => !this.disposed && token === this.resultsToken;
    Promise.resolve(p).then((choice) => {
      off?.();
      if (!live()) return;
      if (choice === 'replay') this.startReplay();
      else this.onExit?.(choice || 'menu');
    }, () => { off?.(); if (live()) this.onExit?.('menu'); });
  }

  // Multiplayer: the server's final order as results rows (everyone, in its places; DNF last, by how far they got).
  mpRows(res) {
    const rows = res.order.map((o) => ({
      name: o === res.mine ? 'You' : o.name, time: o.dnf || !Number.isFinite(o.time) ? Infinity : o.time / 1000,
      me: o === res.mine, kind: 'player', dnf: !!o.dnf, place: o.place,
    }));
    const lead = rows.find((r) => Number.isFinite(r.time))?.time;
    for (const r of rows) r.gap = Number.isFinite(r.time) && Number.isFinite(lead) ? r.time - lead : NaN;
    return rows;
  }

  // Multiplayer, every frame: the server's result ends the race for you too (closed 60 s after the first finisher:
  // still out on the course = DNF), and replaces provisional standings shown after a long wait.
  updateMp(T) {
    const res = this.mpResult();
    if (!res) return;
    if (!this.playerFinished && this.state !== 'results' && (this.state === 'racing' || this.state === 'countdown')) {
      this.finished = true;
      this.state = 'finished';
      this.pending = null;
      this.finalTime = NaN; this.rawTime = NaN;
      this.player.frozen = true;
      this.finishClock = T;
      this.resultsAt = T;
      this.notice('RACE OVER', 'info');
      return;
    }
    if (this.state === 'results' && this.mpShown === 'provisional' && !this.cine) {
      this.resultsToken++; // (the provisional screen's buttons no longer end the run)
      this.state = 'finished';
      this.showResults();
    }
  }

  raceRows() {
    const rows = [{ name: 'You', time: this.finalTime, me: true, kind: 'player', dnf: !Number.isFinite(this.finalTime) }];
    if (this.mp) {
      // multiplayer, provisional: the other players home (their server times), then the rest by progress
      for (const o of this.mpField()) rows.push({ name: o.name, time: o.finished ? o.time : Infinity, me: false, kind: 'player', dnf: !o.finished, s: o.s });
    } else {
      // (older callers: the other players who have finished)
      try { for (const r of this.freeRide?.others?.() || []) rows.push(r); } catch (e) { console.warn('Race: other racers', e); }
    }
    for (const b of this.bots) {
      const time = b.finished ? b.finishTime : b.projectFinish();
      rows.push({ name: b.name, time, me: false, kind: 'bot', dnf: !Number.isFinite(time), projected: !b.finished });
    }
    // (by time; not home yet: by how far down the course)
    rows.sort((a, b) => ((a.time - b.time) || 0) || ((b.s ?? 0) - (a.s ?? 0)));
    for (const r of rows) r.gap = r.time - rows[0].time;
    return rows;
  }

  trialRows() {
    const rows = [{ name: 'You', time: this.finalTime, me: true, kind: 'player', dnf: false }];
    const prev = this.timeRes ? this.timeRes.previousBest : getRecord(this.save, this.courseId)?.best;
    if (Number.isFinite(prev)) rows.push({ name: 'Personal best', time: prev, me: false, kind: 'ghost', dnf: false });
    if (this.medals) {
      for (const m of ['gold', 'silver', 'bronze']) {
        rows.push({ name: m[0].toUpperCase() + m.slice(1), time: this.medals[m], me: false, kind: 'medal', medal: m, dnf: false });
      }
    }
    rows.sort((a, b) => a.time - b.time);
    for (const r of rows) r.gap = r.time - rows[0].time;
    return rows;
  }

  // ------------------------------------------------------------------ AI field
  updateBots(dt, T) {
    if (!this.bots.length) return;
    const pl = this.player;
    // traffic snapshot (bots + player; bots also steer around a player stopping in the finish area)
    const racers = this.racers;
    racers.length = 0;
    for (const b of this.bots) racers.push(b.racer || (b.racer = { self: b, s: 0, lat: 0, v: 0 }));
    for (const b of this.bots) { b.racer.s = b.s; b.racer.lat = b.lat; b.racer.v = b.v; }
    if (this.state !== 'idle') {
      const me = this.meRacer || (this.meRacer = { self: 'player', s: 0, lat: 0, v: 0 });
      me.s = this.ps; me.lat = this.platL; me.v = pl.speed;
      racers.push(me);
    }
    // mild rubber band so races stay close: +-3%, after the start, until the player is home
    for (const b of this.bots) {
      let rb = 1;
      if (this.state === 'racing' && T > 8 && !b.finished) {
        const gapT = (b.s - this.ps) / Math.max(12, (b.v + pl.speed) * 0.5);
        if (gapT > 1.5) rb = 1 - 0.03 * smoothstep(1.5, 7, gapT);
        else if (gapT < -1.5) rb = 1 + 0.025 * smoothstep(1.5, 7, -gapT);
      }
      b.rbTarget = rb;
    }
    for (const b of this.bots) b.update(dt, racers);
    if (this.state !== 'countdown' && this.state !== 'intro') this.botSeparation();
    // splits, finishes, parking lanes in the finish area
    for (const b of this.bots) {
      while (b.cpNext < this.cps.length && b.s >= this.cps[b.cpNext].s && b.running) {
        const cp = this.cps[b.cpNext];
        b.splits[b.cpNext - 1] = b.t - Math.max(0, b.s - cp.s) / Math.max(1, b.sRate);
        b.cpNext++;
      }
      if (b.finished && !b.parked) {
        b.parked = true;
        b.parkRank = ++this.parkCount;
        b.setParking(b.parkRank, this.parkAvoid(b), this.playerFinished ? this.platL : null);
      }
    }
    if (this.state === 'racing' && T > 8) this.countOvertakes();
    if (this.state !== 'countdown') this.botContact();
    // animation + snow FX (a podium or a replay poses the rigs itself, and shows no stand-ins)
    if (this.cine && this.cine.kind !== 'intro') { this.far?.begin(); this.far?.end(); return; }
    const countdown = this.state === 'countdown' && T > -1;
    this.updateLOD();
    for (const b of this.bots) b.animate(dt, b.lod.d, b.lod.fx ? this.fx : null, countdown, b.lod);
  }

  /**
   * Level of detail of the AI field, from the camera (the chase camera, first person, the intro crane):
   * full-rate poses nearby, fewer pose solves further out, the instanced far stand-in past FAR_IN, and no
   * rig at all for racers off screen (three.js never frustum-culls skinned meshes) unless they are close
   * enough for their shadow to fall into view. Snow FX (spray, tracks) for the nearest FX_MAX racers.
   */
  updateLOD() {
    const cam = this.player.camera, cp = this.cameraPos();
    let fr = null;
    if (cam?.isCamera) {
      cam.updateMatrixWorld();
      const m = this._lodM || (this._lodM = new THREE.Matrix4());
      fr = this._frustum || (this._frustum = new THREE.Frustum());
      fr.setFromProjectionMatrix(m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    }
    const sph = this._lodS || (this._lodS = new THREE.Sphere(new THREE.Vector3(), 2.4));
    const near = this._lodNear || (this._lodNear = []);
    near.length = 0;
    const still = this.state === 'countdown' || this.state === 'intro';
    for (let i = 0; i < this.bots.length; i++) {
      const b = this.bots[i];
      const L = b.lod || (b.lod = { d: 0, show: true, far: false, view: true, step: 0, fx: false });
      const d = Math.hypot(b.pos.x - cp.x, b.pos.y - cp.y, b.pos.z - cp.z);
      L.d = d;
      L.far = !!this.far && d > (L.far ? FAR_OUT : FAR_IN);
      if (fr) { sph.center.set(b.pos.x, b.pos.y + 0.9, b.pos.z); L.view = fr.intersectsSphere(sph); } else L.view = true;
      L.show = !L.far && d < LOD_GONE && (L.view || d < LOD_KEEP);
      L.step = still ? (d < LOD_KEEP ? 0 : 1 / 15) : d < LOD_FULL ? 0 : d < LOD_HALF ? 1 / 30 : 1 / 15;
      L.fx = false;
      if (L.show && d < 140) near.push(i);
    }
    if (near.length > FX_MAX) near.sort((a, c) => this.bots[a].lod.d - this.bots[c].lod.d);
    for (let k = 0; k < Math.min(FX_MAX, near.length); k++) this.bots[near[k]].lod.fx = true;
    const F = this.far;
    if (F) {
      F.begin();
      for (let i = 0; i < this.bots.length; i++) {
        const b = this.bots[i], L = b.lod;
        if (L.far && L.view && L.d < LOD_GONE) F.put(i, b.pos, b.heading, b.lean);
      }
      F.end();
    }
  }

  // AI racers never ski through each other: a pair closer than BOT_SEP (course coordinates, both on the
  // snow) is pushed apart sideways, half each, and the one behind checks its speed a little (a shoulder
  // bump, as with the player). Their race craft (bots.js decide) keeps such contacts rare; this is the
  // safety net for a full 15-racer field squeezing through gates and narrow passages.
  botSeparation() {
    const B = this.bots, R = BOT_SEP;
    for (let i = 0; i < B.length; i++) {
      const a = B[i];
      if (!a.started) continue;
      for (let j = i + 1; j < B.length; j++) {
        const b = B[j];
        if (!b.started) continue;
        const ds = b.s - a.s;
        if (ds > R || ds < -R) continue;
        const dl = b.lat - a.lat;
        if (dl > R || dl < -R || ds * ds + dl * dl >= R * R) continue;
        const need = Math.sqrt(R * R - ds * ds) - Math.abs(dl); // lateral gap still missing
        if (!(need > 0)) continue;
        const sg = dl > 0.01 ? 1 : dl < -0.01 ? -1 : (i + j) % 2 ? 1 : -1;
        // (sideways only while either is in the air: a hop over a roller keeps its speed)
        const back = a.s < b.s ? a : b, cut = (a.finished && b.finished) || a.air || b.air ? 0 : 0.25;
        a.bump(-sg * need * 0.5, back === a ? cut : 0);
        b.bump(sg * need * 0.5, back === b ? cut : 0);
      }
    }
  }

  // Lanes a finisher must keep clear of: the player's ski-out lane and the lanes of parked racers.
  parkAvoid(except) {
    const a = this.avoid;
    a.length = 0;
    if (this.playerFinished) a.push(this.platL);
    for (const b of this.bots) if (b !== except && b.parked) a.push(b.parkLat);
    return a;
  }

  // Positions changes (passes) among all racers, for stats / tests.
  countOvertakes() {
    const order = this.order;
    order.length = 0;
    for (const r of this.racers) order.push(r);
    order.sort((a, b) => this.keyOf(b) - this.keyOf(a));
    const prev = this.prevOrder;
    if (prev.length === order.length) {
      for (let i = 0; i < order.length; i++) {
        const j = prev.indexOf(order[i]);
        if (j > i && !(order[i].self.finished)) this.overtakes += j - i;
      }
    }
    prev.length = 0;
    for (const r of order) prev.push(r);
  }

  keyOf(r) {
    if (r.self === 'player') return this.playerFinished ? 1e7 - this.finalTime : this.ps;
    return r.self.finished ? 1e7 - r.self.finishTime : r.self.s;
  }

  // Soft contact between the player and the bots: shoulder bumps, never a pile-up. In the finish area
  // a finisher sliding into the stopped player gives way (the player is never shoved around there).
  botContact() {
    const pl = this.player;
    if (pl.mode !== 'ski') return;
    const R = 0.9;
    for (const b of this.bots) {
      const dx = pl.pos.x - b.pos.x, dz = pl.pos.z - b.pos.z, d2 = dx * dx + dz * dz;
      if (d2 > R * R || Math.abs(pl.pos.y - b.pos.y) > 1.6) continue;
      const d = Math.sqrt(d2) || 0.01, nx = dx / d, nz = dz / d;
      if (this.playerFinished && b.finished) {
        b.nudge(-nx * (R - d), -nz * (R - d));
        b.v *= 0.5;
        continue;
      }
      if (this.state === 'results') continue;
      pl.pos.x = b.pos.x + nx * R; pl.pos.z = b.pos.z + nz * R;
      const vn = (pl.vel.x - b.vel.x) * nx + (pl.vel.z - b.vel.z) * nz;
      if (vn < 0) {
        pl.vel.x -= nx * vn * 1.2; pl.vel.z -= nz * vn * 1.2;
        b.v = Math.max(0, b.v - Math.min(2, -vn * 0.3));
        if (-vn > 2) this.audio?.play?.('land', Math.min(0.6, -vn / 10));
      }
    }
  }

  // ------------------------------------------------------------------ ghost
  // Where the view is rendered from: the real camera (chase or first person), else the player.
  cameraPos() {
    const pl = this.player;
    return pl.camera?.position || pl.camPos || pl.pos;
  }

  updateGhost(dt, T) {
    if (!this.ghost) return;
    this.ghost.update(T, dt, this.cameraPos(), this.groundNormal, this.player.pos);
    if (this.state === 'racing' && T > 0.5) {
      const tg = this.ghost.player.timeAt(this.ps);
      if (tg === null) { this.ghostDelta = undefined; return; }
      // compare official times: both runs carry their gate penalties up to this point of the course
      let gp = 0;
      for (const s of this.ghostPen) if (s <= this.ps) gp += GATE_PENALTY;
      this.ghostDelta = T + this.penalty - (tg + gp);
    }
  }

  // ------------------------------------------------------------------ HUD
  position() {
    if (this.mode !== 'race') return 1;
    const mine = this.playerFinished ? 1e7 - this.finalTime : this.ps;
    let p = 1;
    for (const b of this.bots) if ((b.finished ? 1e7 - b.finishTime : b.s) > mine) p++;
    // multiplayer: players home before you, or further down the course (a racer who left counts behind you)
    for (const o of this.mpField()) if (!o.dnf && (o.finished ? 1e7 - o.time : o.s) > mine) p++;
    return p;
  }

  // Live standings (every 0.25 s): [{ name, me, gap }] where gap is seconds behind the leader.
  standings(dt) {
    this.standingsT -= dt;
    if (this.standingsT > 0) return this.standingsCache;
    this.standingsT = 0.25;
    const list = [{ name: 'You', me: true, s: this.ps, v: this.player.speed, time: this.playerFinished ? this.finalTime : null }];
    for (const b of this.bots) list.push({ name: b.name, me: false, s: b.s, v: b.v, time: b.finished ? b.finishTime : null });
    // multiplayer: everyone by progress (gate + metres along the course; finishers by time; DNF / left at the end)
    for (const o of this.mpField()) list.push({ name: o.dnf ? `${o.name} · DNF` : o.off ? `${o.name} · …` : o.name, me: false, s: o.dnf ? -1e6 + (Number.isFinite(o.s) ? o.s : 0) : Number.isFinite(o.s) ? o.s : -1e6, v: 20, time: o.finished ? o.time : null, dnf: o.dnf });
    list.sort((a, b) => (b.time !== null ? 1e7 - b.time : b.s) - (a.time !== null ? 1e7 - a.time : a.s));
    const lead = list[0];
    this.standingsCache = list.map((r) => ({
      name: r.name, me: r.me,
      gap: r.dnf ? NaN : r === lead ? 0 : r.time !== null && lead.time !== null ? r.time - lead.time : Math.max(0, (lead.s - r.s) / Math.max(10, r.v)),
    }));
    return this.standingsCache;
  }

  /**
   * What to ski for next, for the HUD: the next slalom gate when one is close, else the next checkpoint
   * (or the finish), with the distance along the course and the direction to go: the bearing, relative to
   * the camera's view, of the guide line ~35 m ahead (or of the gate itself), in degrees (+ = right).
   */
  nextTarget() {
    const tr = this.track, s = this.ps, out = this._next || (this._next = { label: '', dist: 0, angle: 0 });
    const gate = tr.gates[this.nextGate];
    let ts, lat = null;
    if (gate && gate.s - s < 70 && gate.s > s - 2) {
      out.label = 'GATE'; ts = gate.s; lat = gate.latA + gate.dir * Math.min(gate.span, 4) * 0.5;
    } else if (this.nextCp < this.cps.length) {
      out.label = `CHECKPOINT ${this.nextCp}`; ts = this.cps[this.nextCp].s;
    } else { out.label = 'FINISH'; ts = tr.finishS; }
    out.dist = Math.max(0, ts - s);
    const aim = lat !== null && out.dist < 35 ? ts : Math.min(ts, s + 35);
    const f = tr.frame(aim, this._nf || (this._nf = {}));
    const l = lat !== null && aim === ts ? lat : this.guideLat ? this.guideLat(aim) : 0;
    const x = f.x + f.nx * l, z = f.z + f.nz * l;
    const cam = this.player.camera, cp = this.cameraPos();
    let yaw = this.player.heading;
    if (cam?.getWorldDirection) { const d = cam.getWorldDirection(this._nd || (this._nd = new THREE.Vector3())); yaw = Math.atan2(d.x, d.z); }
    out.angle = (-wrapAngle(Math.atan2(x - cp.x, z - cp.z) - yaw) * 180) / Math.PI;
    return out;
  }

  updateHud(T, dt) {
    if (!this.raceHud?.update) return;
    const pl = this.player;
    this.raceHud.update({
      next: this.state === 'racing' && !this.playerFinished ? this.nextTarget() : null,
      time: this.playerFinished ? this.finalTime : Math.max(0, T) + this.penalty,
      position: this.position(),
      total: this.fieldSize(),
      checkpoint: this.lastCp,
      checkpoints: this.cps.length - 1,
      distanceToFinish: Math.max(0, this.track.finishS - this.ps),
      speed: pl.speed,
      ghostDelta: this.ghostDelta,
      penalty: this.penalty,
      mode: this.mode,
      standings: this.mode === 'race' ? this.standings(dt) : undefined,
    });
  }

  notice(text, kind) {
    if (this.raceHud?.notice) this.raceHud.notice(text, 1800, kind);
    else this.hud?.flash?.(text, kind === 'bad' ? 'bad' : 'gold', 1600);
  }

  // ------------------------------------------------------------------ misc
  /** Trick callback (main.js may route player.onTrick here): points are listed in the results. */
  onTrick(t) {
    if (t && Number.isFinite(t.points) && t.landed !== 'crash') this.points += t.points;
  }

  /** Instant retry: same field, fresh mistakes; in a time trial the (possibly new) ghost is reloaded. */
  restart() {
    if (this.disposed) return;
    this.flushPending();
    if (this.mode === 'trial') {
      this.ghost?.dispose();
      this.ghost = null;
      this.loadGhost();
    }
    this.showHud();
    this.reset();
    this.active = true;
    this.audio?.music?.('race');
  }

  dispose() {
    if (this.disposed) return;
    this.flushPending();
    this.endCine();
    this.ui?.reset();
    presentation.cancel();
    this.audio?.music?.('freeride');
    this.disposed = true;
    this.active = false;
    this.pending = null; // a respawn fade still in flight finds nothing to do
    this.endSettle();
    for (const b of this.bots) {
      b.rig?.removeFrom(this.scene);
      this.trails?.emit?.(b.fxId, null, null, 0, false);
      this.trails?.emit?.(b.fxId + 1, null, null, 0, false);
    }
    this.bots.length = 0;
    this.far?.dispose();
    this.far = null;
    this.gateBars?.dispose();
    this.gateBars = null;
    this.floodlights?.dispose();
    this.floodlights = null;
    this.ghost?.dispose();
    this.ghost = null;
    this.raceHud?.countdown?.(null);
    this.raceHud?.hide?.();
    const pl = this.player;
    pl.frozen = false;
    pl.hold = false;
    pl.frictionScale = 1;
    if (this.prepared) {
      pl.skiZones = this.prevZones;
      if (this.prevAutoSkisOff !== undefined) pl.autoSkisOff = this.prevAutoSkisOff;
      if (this.lentSkis) {
        pl.setSkisOn?.(false);
        pl.hasSkis = false;
        pl.rig?.setSkisVisible?.(false);
      }
    }
  }
}
