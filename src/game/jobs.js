// Jobs: odd jobs around the resort that pay money, without cluttering the mountains. The only
// permanent props are a few wooden job boards (the village plaza and the mountain huts; five at most
// within 3 km of the village). Every parcel, injured skier, rescue sled or guest exists only while its
// job runs, and is cleaned up once you have moved on.
//   Delivery      pick up at the board, hand it over at a hut, lift station, patrol post or race start
//   Rescue        reach a skier down beside a piste: tow an injured one down in the patrol's akja (rescue
//                 sled), or lead a stuck beginner down (Oct 29: the rescue replaced lost & found)
//   Guide         lead a guest (who skis your own tracks) to a hut or down to the village
// Offers are the same all game day (deterministic per board, day and slot); a slot is re-pinned when
// its job is done, failed or dropped. Timers freeze whenever update() is told the game isn't active.
// The people jobs need are built while the game loads (a small pool, one per character), so taking a
// job never stalls a frame; they only block you at walking pace, so skiing up fast to someone you were
// sent to help can never end in the wipeout that fails the job.
import * as THREE from 'three';
import { world } from '../world/world.js';
import * as VillageMod from '../world/village.js'; // read-only: the night factor the village signs glow with
import * as TransitionMod from '../ui/transition.js'; // read-only: whether a fade covers the screen
import { Sites } from './jobs/sites.js';
import { generateOffers, failText, successText, fmtClock, shortOf, SKILLS, GUESTS, descentFor, hashStr } from './jobs/catalog.js';
import { makeBoard, makePack, makeItem, makeGlint, makeCrossedSkis, makeLyingSkis, makeRing, makeFallbackFigure, disposeProps, boardAssets, setPropModels, artWarmup, ITEMS, makeRescueSled, meshY } from './jobs/props.js';
import { Actor, Follower, RigPool } from './jobs/actors.js';
import { BackFit, PackFollow } from './jobs/pose.js';
import { edgeDist } from './jobs/sites.js';
import { JobBoardUI } from '../ui/jobboard.js';
import { PLAYER_CHARACTERS } from './characters.js';
const PLAYER_IDS = PLAYER_CHARACTERS.map((c) => c.id); // the bodies you can play (job people avoid their stock look)

// E at a board opens the notice-board UI (src/ui/jobboard.js); false = the plain dialog list
const BOARD_UI = true;

const CHARS = ['skier_blue', 'skier_red', 'skier_green', 'skier_orange', 'skier_black', 'skier_purple'];
const BOARD_R = 2.3;          // read a board from in front of it
const HAND_R = 2.8;           // hand a parcel over
const HELP_R = 2.6;           // kneel beside a skier in the snow
const ARRIVE_R = 5;           // guiding: arrived at the destination
const DOWN_R = 22;            // rescue: you are at the bottom with the skier you brought down
const DOWN_GUEST_R = 34;      // ...and they are with you
const TOW_ROPE = 3.4;         // rescue akja: the rope from your back to the sled (m)
const TOW_VMAX = 19;          // m/s (~68 km/h): faster than this is too rough a ride for the casualty
const TOW_ROUGH = 6;          // s over that speed (it recovers when you slow down) and the patrol takes over
const LINGER_R2 = 90 * 90;    // people and props stay until you are this far away (nobody vanishes in your face),
const LINGER_NEAR2 = 40 * 40; // or, after a while, once they are out of view at least this far off
const GLINT_R2 = 45 * 45;
const SOLID_R2 = 14 * 14;     // job people and the crossed skis block you only this close
const SOLID_V = 5;            // and below this speed (a bump at 7 m/s on skis is a crash)
const PACK = { hw: 0.155, h: 0.4, yc: -0.17, gap: 0.012 }; // the parcel pack on your back (props.packGeometry)
const PACK_BUDGET = 1500;     // back-of-the-jacket vertices measured per frame while fitting the pack
const packFits = new WeakMap(); // character mesh -> the pack's fit: the jacket points it rides on

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3();
const _m1 = new THREE.Matrix4(), _m2 = new THREE.Matrix4();
const _c = { x: 0, z: 0 }, _vd = { x: 0, z: 1 };

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const near = (p, q, r) => { const dx = p.x - q.x, dz = p.z - q.z; return dx * dx + dz * dz < r * r; };
const minutes = (s) => `${Math.max(1, Math.round(s / 60))} min`;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const round15 = (v) => Math.ceil(v / 15) * 15;
// who waits at a delivery, and what they say when it arrives
const ROLE_NAME = { chef: 'Chef', operator: 'Lift operator', patrol: 'Ski patrol', starter: 'Race starter', crew: 'Park crew' };
const THANKS = {
  fondue: 'There it is! The lunch crowd has been asking for fondue all morning.',
  bread: 'Still warm. Perfect, the soup is nearly ready.',
  cocoa: 'Hot chocolate, and it is still hot. You are a lifesaver.',
  firstaid: 'Great, we were down to our last bandage.',
  radio: 'New batteries. The radios will last the day now.',
  part: 'That is the bolt we were waiting for. The lift will run smoothly again in no time.',
  bibs: 'The bibs! Just in time, the racers are lining up.',
  shovels: 'Shovels! Now we can shape that kicker.',
};

export class Jobs {
  /**
   * @param {object} o
   * @param {THREE.Scene} o.scene
   * @param {object} o.models        loaded GLTFs (any may be missing)
   * @param {object} o.player        Player (pos, vel, mode, rig, colliders, input)
   * @param {object} o.hud           HUD (flash, dialog)
   * @param {object} o.audio         Audio (play)
   * @param {object} o.save          save object; jobs keep their data in save.jobs
   * @param {() => void} o.writeSave
   * @param {(amount: number, label: string) => void} o.earn
   * @param {object} o.layout        world layout (lifts, huts, pistes, races, peaks, park)
   * @param {(charId: string, skiId: string) => object} o.makeRig
   * @param {object} [o.talk]        Talk (src/game/talk.js): dialogs as conversations
   */
  constructor({ scene, models, player, hud, audio, save, writeSave, earn, layout, makeRig, talk = null }) {
    this.scene = scene;
    this.talk = talk;       // conversations (camera move, the person turns to you); plain dialogs without it
    this.useBoardUI = BOARD_UI; // the notice-board UI at the boards (tests switch it on before it ships)
    this.boardUI = null;
    this.models = models || {};
    this.player = player;
    this.hud = hud;
    this.audio = audio;
    this.save = save || {};
    this.writeSave = writeSave || (() => {});
    this.earn = earn;
    this.layout = layout;
    this.makeRig = makeRig;
    this.colliders = player?.colliders || [];
    this.disposed = false;

    // save data (old saves have none)
    const sj = this.save.jobs && typeof this.save.jobs === 'object' ? this.save.jobs : (this.save.jobs = {});
    sj.v = 1;
    if (!sj.gens || typeof sj.gens !== 'object') sj.gens = {};
    sj.done = sj.done | 0; sj.failed = sj.failed | 0; sj.earned = sj.earned | 0;
    sj.day ??= this.save.day ?? 1;
    sj.active ??= null;
    this.sj = sj;

    this.chars = CHARS.filter((c) => this.models[`${c}_rigged`]);
    setPropModels(this.models);
    // the people for jobs: one rig per character, built now while the game loads (never mid-play)
    this.pool = typeof makeRig === 'function' && this.chars.length ? new RigPool(makeRig) : null;
    if (this.pool) this.pool.prebuild(this.chars);
    this.canRig = !!this.pool && this.pool.size > 0;
    // and the parcel pack fitted to every character's jacket now too (standing, on the pool's rigs),
    // and the posing code run once, so the first casualty or pack of a session never waits on the JIT
    for (const e of this.pool?.all || []) this.fitPackAtLoad(e.rig);
    this.warmPeople();

    // where boards stand and where jobs can send you
    this.sites = new Sites({ layout, colliders: this.colliders });
    this.estCache = new Map();
    this.ctx = { sites: this.sites, est: (a, b) => this.est(a, b), chars: this.chars, canRig: this.canRig };
    this.offerCache = new Map();

    // the boards: the only permanent props
    this.group = new THREE.Group();
    this.group.name = 'jobs';
    this.boards = this.sites.hubs.map((h) => this.buildBoard(h));
    scene?.add(this.group);

    // Shader warm-up: one of each job prop and every job person, far below the snow, caught by the
    // boot's renderer.compile and drawn unseen behind the menu for a few frames, so the first parcel,
    // lost glove or person of a session never stalls a frame compiling a material or uploading a texture.
    this.warm = new THREE.Group();
    this.warm.name = 'jobs-warmup';
    const warm = [makeGlint(), makeRing(0, 0), makeCrossedSkis(0, 0, 0), ...artWarmup()];
    for (const k of ['food', 'mail', 'patrol', 'tools', 'race']) warm.push(makePack(k)); // (builds every pack shape now, too)
    for (const k of Object.keys(ITEMS)) warm.push(makeItem(k, 0, 0, 0));
    if (!this.canRig) warm.push(makeFallbackFigure('stand'));
    for (const o of warm) {
      o.traverse((m) => { m.frustumCulled = false; m.castShadow = false; });
      this.warm.add(o);
    }
    // the job people too (their textures go up to the GPU now, not the moment one first appears)
    for (const e of this.pool?.all || []) this.warm.add(e.rig.root);
    this.warm.position.set(0, -6000, 0);
    this.warmFrames = 0;
    scene?.add(this.warm);

    // mission objects live in their own group, in the scene only while something is out there
    this.mgroup = new THREE.Group();
    this.mgroup.name = 'jobs-mission';
    this.things = [];           // { actor?, obj?, colliders: [], colOn, linger, t }
    this.job = null;
    this.cargo = null;          // { kind, mesh, rig, bone, key, fitter (measuring), follow (riding on the jacket) }
    this.item = null;           // { obj, glint, t }
    this.victim = null;         // rescue Actor
    this.recipient = null;      // delivery Actor (or a hand-over ring)
    this.guest = null;          // escort Actor
    this.follower = null;       // the guest, or the skier you bring down from a rescue, skiing behind you
    this.victimProps = null;    // their skis (and the patrol sled) beside a skier in the snow
    this.prompts = null;
    this.farT = 0;
    this.pending = null;        // delayed message { t, text, cls, sound }
    this.hudText = '';
    this.hudKey = -1;
    this.hudT = 0;
    this.lastOk = false;
    this.lastMode = null;
    this.checked = false;
    this.liftKind = null;       // last lift boarded ('lift' event), for the guide's message
    this.night = -1;            // last night factor applied to the board faces
    this._wp = { x: 0, z: 0, label: '' };
    this.restore();
  }

  // ---------------------------------------------------------------- boards
  buildBoard(h) {
    const m = makeBoard();
    // the posts never float: stand on the lower of the two post feet
    const fx = Math.cos(h.yaw) * 0.72, fz = -Math.sin(h.yaw) * 0.72;
    m.position.set(h.x, Math.min(world.height(h.x + fx, h.z + fz), world.height(h.x - fx, h.z - fz), world.height(h.x, h.z)) - 0.03, h.z);
    m.rotation.y = h.yaw;
    m.updateMatrixWorld(true);
    this.group.add(m);
    this.colliders.push(h.collider);
    const b = { hub: h, mesh: m, front: h.front };
    b.prompt = { label: 'Job board', act: () => this.openBoard(b) };
    return b;
  }

  // Boards placed before some later prop took their spot move to the next free one (runs once).
  recheckBoards() {
    if (!this.sites.syncColliders()) return;
    for (const b of this.boards) {
      const h = b.hub;
      if (!this.sites.boardBlocked(h)) continue;
      const n = this.sites.replace(h);
      if (!n) continue;
      h.x = n.x; h.z = n.z; h.yaw = n.yaw;
      h.front.x = n.front.x; h.front.z = n.front.z;
      h.collider.x = n.x; h.collider.z = n.z; h.collider.rot = -n.yaw;
      this.sites.obst.add(h.collider);
      for (const d of this.sites.dests) if (d.hubId === h.id) { d.x = h.front.x; d.z = h.front.z; d.yaw = h.yaw; }
      const fx = Math.cos(h.yaw) * 0.72, fz = -Math.sin(h.yaw) * 0.72;
      b.mesh.position.set(h.x, Math.min(world.height(h.x + fx, h.z + fz), world.height(h.x - fx, h.z - fz), world.height(h.x, h.z)) - 0.03, h.z);
      b.mesh.rotation.y = h.yaw;
      b.mesh.updateMatrixWorld(true);
      this.offerCache.clear();
      this.estCache.clear();
    }
  }

  // The warm-up group leaves the scene but nothing in it is disposed: disposing its materials released
  // shader programs three.js was still polling (GL_INVALID_VALUE warnings on every load) and threw the
  // warm-up away, so the real glint / stand-in compiled again later. They are a few small objects.
  dropWarmup() {
    if (!this.warm) return;
    for (const e of this.pool?.all || []) if (e.rig.root.parent === this.warm) this.warm.remove(e.rig.root);
    this.warm.parent?.remove(this.warm);
    this.warm = null;
  }

  boardById(id) { return this.boards.find((b) => b.hub.id === id) || null; }

  // travel-time estimate between two points (cached; the router samples the terrain)
  est(a, b) {
    const k = `${Math.round(a.x)},${Math.round(a.z)}>${Math.round(b.x)},${Math.round(b.z)}`;
    let t = this.estCache.get(k);
    if (t === undefined) { t = this.sites.router.est(a, b).t; this.estCache.set(k, t); }
    return t;
  }

  // today's offers on a board (new day = fresh offers)
  offersFor(hub) {
    const day = this.save.day ?? 1;
    if (this.sj.day !== day) { this.sj.day = day; this.sj.gens = {}; }
    const gens = this.sj.gens[hub.id] || [0, 0, 0];
    const key = `${day}|${gens.join(',')}`;
    const c = this.offerCache.get(hub.id);
    if (c && c.key === key) return c.offers;
    const offers = generateOffers(this.ctx, hub, day, gens);
    this.offerCache.set(hub.id, { key, offers });
    return offers;
  }

  // ---------------------------------------------------------------- dialogs
  // A dialog as a conversation with a person (the camera moves in on them); a plain dialog for anything
  // else (the job boards) or without Talk.
  dialog(speaker, head, say, options) {
    if (this.talk && speaker) this.talk.say(speaker, head, say, options);
    else this.hud.dialog(esc(head.role ? `${head.name} · ${head.role}` : head.name), say, options);
  }

  // a job person; `follow` people are posed by their Follower, which only turns them while they move
  personSpeaker(a, follow = false) {
    if (!a) return null;
    const sp = { id: a, anchor: a.pos, rig: a.rig || null, still: a.pose === 'down' };
    if (follow) sp.turn = (yaw, dt) => { a.heading += Math.atan2(Math.sin(yaw - a.heading), Math.cos(yaw - a.heading)) * Math.min(1, dt * 3); };
    return sp;
  }

  openBoard(b) {
    const hud = this.hud;
    if (!hud?.dialog || this.disposed) return;
    if (this.useBoardUI && typeof document !== 'undefined') { this.openBoardUI(b); return; }
    const hub = b.hub, head = { name: 'Job board', role: hub.name };
    const job = this.job;
    if (job) {
      this.dialog(null, head, esc(`You're on a job: ${job.title}. ${this.statusText()}`), [
        { label: 'Keep going', act: () => this.relock() },
        { label: 'Drop this job', sub: 'No pay', act: () => { this.cancel(); this.relock(); } },
      ]);
      return;
    }
    const offers = this.offersFor(hub);
    const opts = offers.map((o) => ({
      label: esc(o.title),
      sub: esc(`$${o.reward}${o.bonus ? ' + tip' : ''} · ${minutes(o.limit + (o.estDown ? o.estDown * 1.5 : 0))}`),
      act: () => this.openOffer(b, o),
    }));
    opts.push({ label: 'Not now', act: () => this.relock() });
    this.dialog(null, head, offers.length ? 'Odd jobs around the mountain. Paid when the job is done, with a tip for speed.' : 'Nothing pinned up right now. Check back later.', opts);
  }

  // The board up close: today's offers as pinned notes, your current job with CANCEL JOB.
  openBoardUI(b) {
    const hub = b.hub, job = this.job;
    const offers = this.offersFor(hub).filter((o) => !job || o.id !== job.id);
    let extra = [];
    try { extra = (this.extraOffers?.(hub) || []).filter(Boolean); } catch (e) { console.warn('Jobs: extra offers', e); } // (main.js: the taxi's note)
    this.boardUI ??= new JobBoardUI({ hud: this.hud, audio: this.audio });
    this.refreshHud();
    this.boardUI.open({
      place: hub.kind === 'village' ? 'Legacy Village' : hub.name,
      offers: offers.map((o) => ({
        id: o.id, type: o.type, title: o.title, brief: o.brief, client: o.client, reward: o.reward, bonus: o.bonus,
        minutes: minutes(o.limit + (o.estDown ? o.estDown * 1.5 : 0)), diff: this.difficulty(o),
      })).concat(extra),
      current: job ? { title: job.title, type: job.type, client: job.client, status: this.hudLine() || this.statusText() } : null,
      take: (id) => {
        const x = extra.find((e) => e.id === id); // (a note pinned by another system: the taxi's)
        if (x) { try { x.take?.(); } catch (e) { console.warn('Jobs: extra offer', e); } this.relock(); return; }
        const o = offers.find((q) => q.id === id); if (!o || !this.accept(o)) this.relock();
      },
      cancel: () => { this.cancel(); this.relock(); },
      close: () => this.relock(),
    });
  }

  // how hard a job is, for the board: how long it takes (a rescue's descent included), a beginner to guide
  difficulty(o) {
    const t = (o.est || 0) + (o.estDown || 0);
    let d = t < 360 ? 1 : t < 720 ? 2 : 3; // a long ride isn't hard in itself: most jobs read Easy / Medium
    if (o.type === 'escort' && o.guest?.skill === 'beginner') d = Math.min(3, d + 1);
    return d;
  }

  openOffer(b, o) {
    const tip = o.bonus ? ` + up to $${o.bonus} tip` : '';
    this.dialog(null, { name: o.client }, esc(`${o.brief} You have ${fmtClock(o.limit)}${o.down ? ' to reach them' : ''}.`), [
      { label: 'Take the job', sub: esc(`$${o.reward}${tip}`), act: () => { if (!this.accept(o)) this.relock(); } },
      { label: 'Back', act: () => this.openBoard(b) },
    ]);
  }

  // A guide job's guest says hello beside the board (true: that dialog is open now).
  greetGuest() {
    const job = this.job, a = this.guest;
    if (!job || job.type !== 'escort' || !a?.rig || !this.talk) return false;
    const g = job.guest, to = job.dest.kind === 'board' && job.dest.hubId === 'village' ? 'the village' : job.dest.to || shortOf(job.dest);
    const line = g.skill === 'beginner' ? `Hi, I'm ${g.name}! I'm still new to skiing, so please don't go too fast. I'll follow your tracks to ${to}.`
      : g.skill === 'strong' ? `Hey, I'm ${g.name}. I need to get to ${to} quickly, so don't hold back. I'll keep up.`
      : `Hi, I'm ${g.name}. Lead the way to ${to}, I'll stay right in your tracks.`;
    this.dialog(this.personSpeaker(a, true), { name: g.name, role: 'Ski school guest' }, esc(line), [
      { label: "Let's go", sub: esc(`to ${shortOf(job.dest)}`), act: () => this.relock() },
    ]);
    return true;
  }

  // the guide's guest at the destination: goodbye, then paid
  sayGoodbye() {
    const job = this.job, a = this.guest;
    if (!job || job.type !== 'escort') return;
    if (!a?.rig || !this.talk) { this.complete(); return; }
    const g = job.guest;
    this.dialog(this.personSpeaker(a, true), { name: g.name, role: 'Ski school guest' }, esc(g.skill === 'beginner'
      ? 'We made it! Thank you for being so patient with me.'
      : 'Thanks for showing me the way. That was a great run!'), [
      { label: 'Goodbye', act: () => { this.complete(); this.relock(); } },
    ]);
  }

  // a delivery: the person waiting for it takes it from you
  handOver() {
    const job = this.job, a = this.recipient;
    if (!job || job.type !== 'delivery') return;
    if (!a?.rig || !this.talk) { this.complete(); return; }
    const d = job.dest, noun = this.cargoNoun(job);
    this.dialog(this.personSpeaker(a), { name: ROLE_NAME[d.role] || 'Recipient', role: d.place || d.label }, esc(THANKS[job.cargo] || 'That is the one we were waiting for. Thank you!'), [
      { label: esc(`Hand over the ${noun}`), act: () => { this.complete(); this.relock(); } },
    ]);
  }

  // a rescue: talk to the skier in the snow, then they get up and ski down with you
  helpVictim() {
    const job = this.job, v = this.victim;
    if (!job || job.type !== 'rescue' || job.phase === 'down') return;
    if (!v?.rig || !this.talk) { this.complete(); return; }
    job.down ??= descentFor(this.sites, job.spot) || this.villageDown();
    const name = this.victimName(job), stuck = job.variant === 'stuck', to = job.down.to || job.down.label;
    if (!stuck && this.victimProps?.sled) {
      // the akja: they can't ski on that knee, you tow them down in the patrol's rescue sled
      this.dialog(this.personSpeaker(v), { name, role: 'Skier down' }, esc(`Ow... I twisted my knee badly, I can't ski on it. The patrol left their sled here. Can you get me in and take me down to ${to}?`), [
        { label: 'Load them into the akja', sub: esc(`tow it to ${job.down.short || job.down.label} · ski smoothly`), act: () => { this.startTow(); this.relock(); } },
        { label: 'One moment', act: () => this.relock() },
      ]);
      return;
    }
    const line = stuck
      ? `Thank you for coming! My skis came off and I keep sinking in this deep snow. Can you help me up and show me the way down to ${to}?`
      : `Ow... I twisted my knee when I fell. I think I can still ski if we take it slowly. Will you take me down to ${to}?`;
    this.dialog(this.personSpeaker(v), { name, role: stuck ? 'Stuck in the snow' : 'Skier down' }, esc(line), [
      { label: 'Ski down together', sub: esc(`to ${job.down.short || job.down.label}`), act: () => { this.startDescent(); this.relock(); } },
      { label: 'One moment', act: () => this.relock() },
    ]);
  }

  victimName(job) {
    return job.spot?.name || GUESTS[hashStr(`${job.id || ''}|${job.spot?.x}`) % GUESTS.length];
  }

  villageDown() {
    const b = this.boardById('village');
    const p = b ? b.front : { x: 0, z: -4 };
    return { kind: 'board', id: 'board:village', x: p.x, z: p.z, label: 'Legacy Village', short: 'the village', to: 'Legacy Village' };
  }

  // back into the game after a dialog button (a click is a user gesture, so pointer lock is allowed)
  relock() { try { this.player?.input?.lock?.(); } catch { /* not available */ } }

  statusText() {
    const job = this.job;
    if (!job) return '';
    return `${fmtClock(job.limit - job.elapsed)} left.`;
  }

  // ---------------------------------------------------------------- job lifecycle
  accept(o) {
    if (this.job || this.disposed) return false;
    const job = JSON.parse(JSON.stringify(o));
    job.elapsed = 0; job.found = false; job.helped = false;
    job.day = this.save.day ?? 1;
    this.job = job;
    this.sj.active = job;
    this.startMission(job);
    this.writeSave();
    this.audio?.play?.('chime');
    this.hud?.flash?.(`Job taken · ${job.short}`, 'good', 2400);
    this.hudKey = -1; this.refreshHud();
    return job.type === 'escort' ? this.greetGuest() : false;
  }

  // a saved job picks up where it was (a guide job or a rescue on the way down can't: the person isn't
  // with you after a restart)
  restore() {
    const a = this.sj.active;
    if (!a || typeof a !== 'object') { this.sj.active = null; return; }
    const okPos = (p) => p && Number.isFinite(p.x) && Number.isFinite(p.z) && Number.isFinite(world.height(p.x, p.z));
    // (an old save's lost & found job is dropped: that job is gone, the rescue took its place)
    const valid = ['delivery', 'rescue'].includes(a.type) && okPos(a.dest) && Number.isFinite(a.elapsed) && Number.isFinite(a.limit) &&
      (a.type !== 'rescue' || (okPos(a.spot) && a.phase !== 'down')) && a.day === (this.save.day ?? 1) &&
      (a.dest.kind !== 'board' || this.boardById(a.dest.hubId));
    if (!valid) { this.sj.active = null; return; }
    this.job = a;
    this.startMission(a);
  }

  startMission(job) {
    const P = (label, act) => ({ label, act });
    const mine = this.save.character;
    if (job.type === 'delivery') {
      this.cargo = { kind: job.pack || 'food', mesh: null, rig: null, bone: null, fitter: null, key: null };
      const d = job.dest;
      const again = d.npc ? this.reclaim(d.x, d.z) : null;
      if (again) this.recipient = again.actor || null; // the same patroller / chef, still there from the last job
      else if (d.npc) {
        // the chef / operator / patroller waits there; without a character model a soft ring marks the spot
        const char = this.charFor(d.char);
        if (char) this.spareRig();
        let a = char ? new Actor({ pool: this.pool, group: this.mgroup, char, avoid: mine, pose: 'stand', x: d.x, z: d.z, heading: d.yaw || 0 }) : null;
        if (a && !a.rig) {
          if (a.rigFailed) this.noRigs();
          a.dispose(); a = null;
        }
        if (a) {
          this.recipient = a;
          this.addThing({ actor: a, colliders: [a.collider] });
        } else this.addThing({ obj: makeRing(d.x, d.z) });
      }
      this.prompts = { hand: P(`Hand over the ${this.cargoNoun(job)}`, () => this.handOver()) };
    } else if (job.type === 'rescue') {
      const s = job.spot, stuck = job.variant === 'stuck';
      // sitting in the snow where they fell (posed and measured against the snow while still out of sight)
      this.spareRig();
      this.victim = new Actor({
        pool: this.pool, group: this.mgroup, char: this.charFor(s.char || this.chars[0]), avoid: mine, pose: 'down',
        variant: stuck ? 'stuck' : 'injured', x: s.x, z: s.z, heading: s.heading, side: s.side, jacket: '#c8321f',
      });
      if (this.victim.rigFailed) this.noRigs();
      const thing = { actor: this.victim, colliders: [this.victim.collider] };
      const h = this.victim.heading, fx = Math.sin(h), fz = Math.cos(h);
      const vp = (this.victimProps = { skis: null, skisCol: null, sled: null, sledCol: null });
      if (!stuck) {
        // their skis crossed upright in the snow a couple of metres uphill, a little toward the piste
        // edge (out of the line you come down on): the real "skier down" sign
        const e = s.edge || 0, ex = -Math.cos(s.heading) * e, ez = Math.sin(s.heading) * e;
        let kx = s.x - fx * 2.4 + ex, kz = s.z - fz * 2.4 + ez;
        if (!e || !this.sites.ok(kx, kz, { clear: 0.6 })) { kx = s.x - fx * 2.4; kz = s.z - fz * 2.4; }
        thing.obj = vp.skis = makeCrossedSkis(kx, kz, h);
        thing.colliders.push(vp.skisCol = { x: kx, z: kz, r: 0.3 });
        // the patrol's rescue sled waits beside them (when the model is there)
        let sx = s.x + fz * 1.7, sz = s.z - fx * 1.7;
        if (!this.sites.ok(sx, sz, { clear: 1.2 })) { sx = s.x - fz * 1.7; sz = s.z + fx * 1.7; }
        const sled = makeRescueSled(sx, sz, h + Math.PI / 2);
        if (sled) {
          const grp = new THREE.Group();
          grp.add(thing.obj, sled);
          thing.obj = grp;
          vp.sled = sled;
          thing.colliders.push(vp.sledCol = { x: sx, z: sz, r: 0.9 });
        }
      } else {
        // a beginner who came out of their skis: they sit beside them
        let lx = s.x - fz * 1.1, lz = s.z + fx * 1.1;
        if (!this.sites.ok(lx, lz, { clear: 0.6 })) { lx = s.x + fz * 1.1; lz = s.z - fx * 1.1; }
        thing.obj = vp.skis = makeLyingSkis(lx, lz, h + 0.15);
      }
      this.addThing(thing);
      this.prompts = { help: P(stuck ? 'Help them back up' : 'Help the injured skier', () => this.helpVictim()) };
    } else if (job.type === 'escort') {
      const b = this.boardById(job.board);
      const at = b ? this.sites.besideBoard(b.hub) : { x: this.player.pos.x + 2, z: this.player.pos.z + 2, yaw: 0 };
      const g = job.guest;
      this.spareRig();
      this.guest = new Actor({ pool: this.pool, group: this.mgroup, char: this.charFor(g.char), avoid: mine, pose: 'ski', x: at.x, z: at.z, heading: at.yaw });
      if (this.guest.rigFailed) this.noRigs();
      this.guest.prep = 0;
      const S = SKILLS[g.skill] || SKILLS.steady;
      this.follower = new Follower(this.guest, { vmax: S.vmax, plow: S.plow });
      this.addThing({ actor: this.guest, follow: true });
      this.farT = 0;
      this.prompts = {
        drop: P(`Say goodbye to ${g.name}`, () => this.sayGoodbye()),
        wait: P(`Wait for ${g.name} to catch up`, () => this.hud?.flash?.(`${g.name} is still on the way`, 'good', 1600)),
      };
    }
  }

  // a person from the last job still standing on this spot (they simply take the next parcel too)
  reclaim(x, z) {
    _c.x = x; _c.z = z;
    for (const t of this.things) {
      const person = t.actor?.rig && t.actor.pose === 'stand' && near(t.actor.pos, _c, 1);
      const ring = !t.actor && t.obj?.name === 'job-ring' && near(t.obj.position, _c, 1);
      if (!t.linger || !(person || ring)) continue;
      t.linger = false; t.t = 0;
      return t;
    }
    return null;
  }

  // every pooled rig in use (people lingering from earlier jobs): the farthest of them goes, so a new
  // person never means building a rig mid-play
  spareRig() {
    if (!this.pool || this.pool.free.length) return;
    const p = this.player.pos;
    let far = null, fd = -1;
    for (const t of this.things) {
      if (!t.linger || !t.actor?.rig) continue;
      const d = (t.actor.pos.x - p.x) ** 2 + (t.actor.pos.z - p.z) ** 2;
      if (d > fd) { fd = d; far = t; }
    }
    if (far) this.dropThing(far);
  }

  // a character could not be built: no more guide jobs this session (a stand-in is fine for someone
  // waiting or sitting in the snow, not for a guest skiing behind you)
  noRigs() {
    if (!this.canRig) return;
    this.canRig = false; this.ctx.canRig = false; this.offerCache.clear();
  }

  // a character for a job person: never the one you are playing
  charFor(c) {
    if (!this.chars.length) return null;
    const mine = this.save.character;
    if (!c || !this.chars.includes(c)) c = this.chars[0];
    if (c === mine) return this.chars.find((x) => x !== mine && !PLAYER_IDS.includes(x)) || this.chars.find((x) => x !== mine) || c;
    return c;
  }

  cargoNoun(job) {
    const n = { fondue: 'fondue cheese', bread: 'bread', cocoa: 'hot chocolate', mail: 'mail bag', firstaid: 'first-aid kit', radio: 'batteries', part: 'spare part', bibs: 'race bibs', shovels: 'shovels' };
    return n[job.cargo] || 'parcel';
  }

  removeItem() {
    if (!this.item) return;
    const t = this.things.find((e) => e.obj === this.item.obj);
    if (t) this.dropThing(t);
    this.item.glint.material.dispose();
    this.item = null;
  }

  addThing(t) {
    t.colliders ??= [];
    t.colOn = false;
    t.linger = false; t.t = 0;
    if (t.obj) this.mgroup.add(t.obj);
    this.things.push(t);
    if (!this.mgroup.parent && this.scene) this.scene.add(this.mgroup);
  }

  dropThing(t) {
    const i = this.things.indexOf(t);
    if (i >= 0) this.things.splice(i, 1);
    this.setSolid(t, false);
    t.actor?.dispose();
    if (t.obj) this.mgroup.remove(t.obj);
    if (!this.things.length && this.mgroup.parent) this.mgroup.parent.remove(this.mgroup);
  }

  // a thing's colliders in or out of the player's colliders
  setSolid(t, on) {
    if (t.colOn === on) return;
    t.colOn = on;
    for (const c of t.colliders) {
      const k = this.colliders.indexOf(c);
      if (on && k < 0) this.colliders.push(c);
      else if (!on && k >= 0) this.colliders.splice(k, 1);
    }
  }

  complete() {
    const job = this.job;
    if (!job || this.disposed) return;
    if (job.type === 'escort' && !this.guestArrived()) return;
    let tip = 0;
    if (job.bonus && job.par) {
      const k = job.elapsed <= job.par ? 1 : clamp((job.limit - job.elapsed) / Math.max(1, job.limit - job.par), 0, 1);
      tip = Math.round((job.bonus * k) / 5) * 5;
    }
    const total = job.reward + tip;
    this.sj.done++;
    this.sj.earned += total;
    if (job.type === 'rescue') { job.helped = true; if (job.variant === 'stuck' && job.phase !== 'down') this.victim?.getUp(); }
    this.endJob('done');
    try { this.earn?.(total, `Job: ${job.title}`); } catch (e) { console.warn('Jobs: earn failed', e); }
    this.hud?.flash?.(successText(job, total, tip), 'gold', 3000);
    this.audio?.play?.('finish');
  }

  fail(reason) {
    const job = this.job;
    if (!job) return;
    const text = failText(job, reason);
    const down = job.type === 'rescue' && job.phase === 'down';
    const person = down ? this.things.find((t) => t.actor && t.actor === this.victim) : null;
    this.sj.failed++;
    this.endJob('failed');
    if (down && reason === 'crash') {
      // bringing someone down: a fall ends it at once (the message comes up during the tumble, right
      // after the wipeout's own; the person is gone once the fade to the village covers the screen)
      this.pending = { text, cls: 'bad', sound: 'error', t: 0.4, age: 0, now: true, ms: 3600 };
      if (person) person.dropOnCover = true;
      return;
    }
    // After a wipeout the screen fades to the village and back (a race start covers it too): the
    // message waits until nothing covers the screen and you are back on your feet, then a moment more.
    if (reason === 'crash' || reason === 'teleport') this.pending = { text, cls: 'bad', sound: 'error', t: 1, age: 0 };
    else { this.hud?.flash?.(text, 'bad', 3200); this.audio?.play?.('error'); }
  }

  cancel() {
    if (!this.job) return;
    this.endJob('dropped');
    this.hud?.flash?.('Job dropped', 'good', 1800);
  }

  endJob(outcome) {
    const job = this.job;
    if (!job) return;
    // re-pin that board slot (only while it is still the same day's board)
    if (job.board && job.slot !== undefined && this.sj.day === job.day) {
      const g = (this.sj.gens[job.board] ||= [0, 0, 0]);
      g[job.slot] = (g[job.slot] || 0) + 1;
    }
    this.job = null;
    this.sj.active = null;
    this.detachCargo();
    this.removeItem();
    // people stay where they are until you have moved on; the guest (or the skier you brought down)
    // stops and turns to say goodbye (one still riding the lift behind you simply never steps out)
    const fa = this.guest || this.victim;
    if (fa && this.follower) {
      const a = fa, st = a.st, walking = this.follower.walking;
      const t = this.things.find((e) => e.actor === a);
      if (this.follower.hidden) { if (t) this.dropThing(t); } else {
        a.pose = walking ? 'stand' : 'ski';
        st.mode = walking ? 'idle' : 'ski'; st.speed = 0; st.lean = 0; st.plow = 0; st.crouch = walking ? 0 : 0.25;
      }
    }
    for (const t of this.things) { t.linger = true; t.t = 0; t.follow = false; }
    this.follower = null; this.guest = null; this.victim = null; this.recipient = null; this.victimProps = null; this.tow = null;
    this.prompts = null;
    this.farT = 0;
    this.writeSave();
    this.hudKey = -1; this.refreshHud();
    void outcome;
  }

  // ---------------------------------------------------------------- cargo on your back
  // The pack rides on your jacket. Where it goes is measured on each character's own mesh while the
  // game loads (the back of a puffy jacket, a hood, a backpack the model already wears): five points of
  // the jacket it rests on, plus a grid of the outermost points under it. Every frame the pack is
  // placed on those five points and pushed out over any of the others bulging through it, so it stays
  // on the back in every pose (tucks, tumbles, walking), whatever bones the character's skinning moves
  // that part of the jacket with.
  attachCargo() {
    const c = this.cargo;
    if (!c) return;
    if (c.mesh?.parent) c.mesh.parent.remove(c.mesh);
    const rig = this.player?.rig;
    c.rig = rig; c.fitter = null; c.follow = null; c.bone = null;
    const b = rig?.b, bone = b?.spine2 || b?.spine1;
    if (!bone || !b.spine0 || !b.neck || !rig.root) return; // HUD only
    c.mesh ??= makePack(c.kind);
    c.mesh.matrixAutoUpdate = false;
    c.bone = bone;
    c.key = rig.skinned?.geometry || null;
    const fit = c.key && packFits.get(c.key);
    if (fit) this.followJacket(c, rig, fit);
    else c.fitter = new BackFit(rig, PACK); // a character the pool has no rig for: measured now, a few frames
  }

  // fit the pack to a pooled rig's jacket, standing in its relaxed pose (at load time)
  fitPackAtLoad(rig) {
    const key = rig?.skinned?.geometry;
    if (!key || packFits.has(key) || !rig.b?.neck || !rig.b.spine0) return;
    try {
      const st = { mode: 'idle', heading: 0, speed: 0, crouch: 0, lean: 0, plow: 0, normal: _v2.set(0, 1, 0), carry: false };
      rig.root.position.set(0, world.height(0, -4), -4);
      for (let i = 0; i < 4; i++) rig.update(1 / 30, st);
      rig.root.updateMatrixWorld(true);
      const f = new BackFit(rig, PACK);
      while (!f.step(1e9));
      const fit = f.result();
      if (fit?.anchors) packFits.set(key, fit);
    } catch (err) { console.warn('Jobs: pack fit failed', err?.message || err); }
    rig.root.position.set(0, 0, 0);
    rig.snapPose?.();
    if (Array.isArray(rig.fx)) rig.fx.length = 0;
  }

  // pose a skier sitting in the snow (both kinds) and let a pack ride along for a while, off-screen
  warmPeople() {
    const e = this.pool?.free[0];
    if (!e) return;
    try {
      const g = new THREE.Group();
      for (const variant of ['injured', 'stuck']) {
        const a = new Actor({ pool: this.pool, group: g, char: e.char, pose: 'down', variant, x: 26, z: -64, heading: 0, side: 1 });
        while (a.prep > 0) a.prepStep();
        a.dispose();
      }
      const fit = packFits.get(e.rig.skinned?.geometry);
      if (fit) { const pf = new PackFollow(e.rig, fit); for (let i = 0; i < 200; i++) pf.update(_m1); }
    } catch (err) { console.warn('Jobs: warm-up failed', err?.message || err); }
  }

  followJacket(c, rig, fit) {
    c.follow = new PackFollow(rig, fit);
    rig.root.add(c.mesh);
    if (!c.follow.update(c.mesh.matrix)) c.mesh.visible = false;
  }

  detachCargo() {
    const c = this.cargo;
    if (!c) return;
    if (c.mesh?.parent) c.mesh.parent.remove(c.mesh);
    this.cargo = null;
  }

  updateCargo() {
    const c = this.cargo;
    if (!c) return;
    const rig = this.player?.rig;
    if (c.rig !== rig) this.attachCargo(); // first frame, or the character was swapped
    if (c.fitter) {
      if (!c.fitter.step(PACK_BUDGET)) return;
      const fit = c.fitter.result();
      if (fit?.anchors) {
        if (c.key) packFits.set(c.key, fit);
        this.followJacket(c, rig, fit);
      } else {
        // nothing measurable (no skinned mesh): on the chest bone, behind it by the rig's own measure
        const f = c.fitter.frame();
        _m1.makeBasis(f.side, f.up, f.back).setPosition(_v1.copy(f.c).addScaledVector(f.back, (rig.backDepth || 0.13) + PACK.gap).addScaledVector(f.up, PACK.yc));
        c.mesh.matrix.copy(_m2.copy(c.bone.matrixWorld).invert().multiply(_m1));
        c.bone.add(c.mesh);
      }
      c.fitter = null;
    }
    if (!c.mesh?.parent) return;
    const ok = c.follow ? c.follow.update(c.mesh.matrix) : true;
    // hidden while skis are strapped to your back, sitting on a lift (in your lap, clear of the chair's
    // backrest) and with your body hidden in first person
    c.mesh.visible = ok && !rig?.carry && this.player.mode !== 'sit' && rig?.body?.visible !== false;
  }

  // ---------------------------------------------------------------- per frame
  update(dt, { active = true } = {}) {
    if (this.disposed) return;
    if (this.warm && ++this.warmFrames > 3) this.dropWarmup(); // drawn a few frames (behind the menu): done
    if (!active) return; // menus, the shop, race sessions: the clock stands still
    if (!this.checked) { this.checked = true; this.recheckBoards(); this.dropWarmup(); }
    const pl = this.player, p = pl.pos;
    // a crash in free ride is a wipeout back to the village: time-critical jobs end politely (also
    // when main.js doesn't report it). Other jumps (the ski bus, back to the village from the menu)
    // are travel: jobs carry on and a guide's guest simply comes along.
    if (pl.mode === 'fall' && !pl.fall?.bump && this.lastOk && this.lastMode !== 'fall') this.onEvent('crash', { auto: true }); // (a bump into somebody is no wipeout)
    this.lastMode = pl.mode; this.lastOk = true;

    if (this.pending) {
      const m = this.pending;
      m.age += dt;
      const covered = !m.now && m.age < 20 && (pl.mode === 'fall' || TransitionMod.transition?.active === true);
      if (covered) m.t = 1; else m.t -= dt;
      if (m.t <= 0) {
        this.pending = null;
        this.hud?.flash?.(m.text, m.cls, m.ms || 3200);
        if (m.sound) this.audio?.play?.(m.sound);
      }
    }

    const job = this.job;
    if (job) {
      job.elapsed += dt;
      if (job.limit && job.elapsed > job.limit) this.fail('late');
      else if (job.type === 'escort' && this.follower) this.updateEscort(dt);
      else if (job.type === 'rescue' && job.phase === 'down') this.updateRescue(dt);
    }

    // job people and props: posed with level of detail, solid only near you at walking pace, removed
    // once you've moved on
    const slow = pl.mode !== 'fall' && (pl.speed ?? Math.hypot(pl.vel?.x || 0, pl.vel?.z || 0)) < SOLID_V;
    for (let i = this.things.length - 1; i >= 0; i--) {
      const t = this.things[i];
      if (t.actor && !t.follow) t.actor.update(dt, p);
      const o = t.actor ? t.actor.pos : t.obj?.position;
      const dx = o ? o.x - p.x : 1e9, dz = o ? o.z - p.z : 1e9, d2 = dx * dx + dz * dz;
      if (t.colliders.length) this.setSolid(t, slow && d2 < SOLID_R2 && !(t.actor && t.actor.prep > 0));
      if (t.dropOnCover && TransitionMod.transition?.active === true) { this.dropThing(t); continue; }
      if (t.linger) {
        t.t += dt;
        if (d2 > LINGER_R2 || (t.t > 150 && d2 > LINGER_NEAR2 && this.outOfView(dx, dz))) this.dropThing(t);
      }
    }
    if (this.item) this.updateGlint(dt, p);
    this.updateCargo();
    // board faces glow faintly at night, exactly like the village's own signs
    const night = VillageMod.nightUniform?.value ?? 0;
    if (night !== this.night) { this.night = night; boardAssets().faceMat.emissiveIntensity = night * 0.25; }

    this.hudT -= dt;
    if (this.hudT <= 0) this.refreshHud();
  }

  // a direction (from the player) well outside what the camera shows
  outOfView(dx, dz) {
    const pl = this.player, v = _vd;
    if (pl.view === 'first') { const y = (pl.heading || 0) + (pl.lookYaw || 0); v.x = Math.sin(y); v.z = Math.cos(y); } else if (Number.isFinite(pl.camYaw)) { v.x = -Math.sin(pl.camYaw); v.z = -Math.cos(pl.camYaw); } else { const y = pl.heading || 0; v.x = Math.sin(y); v.z = Math.cos(y); }
    return (v.x * dx + v.z * dz) / (Math.hypot(dx, dz) || 1) < -0.1;
  }

  updateEscort(dt) {
    const f = this.follower;
    const gap = f.update(dt, this.player);
    if (f.boarded) {
      const kind = this.liftKind === 'chair' ? 'chair' : this.liftKind === 'gondola' ? 'cabin' : 'one';
      this.hud?.flash?.(`${this.job.guest.name} takes the next ${kind}`, 'good', 2200);
      this.liftKind = null;
    }
    if (f.hidden) { this.farT = 0; return; }
    if (gap > 300) {
      this.farT += dt;
      if (this.farT > 8 || gap > 600) this.fail('lost');
    } else this.farT = 0;
  }

  // ---------------------------------------------------------------- rescue: skiing them down
  // "Ski down together": they get up (the crash get-up), click into their skis and follow you down to
  // the lift / hut / village at the bottom, beside your line or a few metres behind, at your pace (up to
  // what they can ski). Left far behind they rejoin your track out of sight. Both of you at the
  // bottom = done; a crash on the way = failed at once.
  startDescent() {
    const job = this.job, v = this.victim;
    if (!job || job.type !== 'rescue' || job.phase === 'down' || !v?.rig || this.disposed) return;
    job.down ??= descentFor(this.sites, job.spot) || this.villageDown();
    job.phase = 'down';
    const estDown = this.est(v.pos, job.down);
    job.limit = job.elapsed + round15(estDown * 2.2 + 90);
    job.par = job.elapsed + Math.round(estDown * 1.3);
    v.getUp();
    this.farT = 0;
    this.writeSave();
    this.audio?.play?.('soft');
    this.hud?.flash?.(`Lead ${this.victimName(job)} down to ${job.down.short || job.down.label} · stay close`, 'good', 3000);
    this.hudKey = -1; this.refreshHud();
  }

  // up on their feet: their skis go on and they ski behind you
  startFollower() {
    const job = this.job, v = this.victim;
    const t = this.things.find((e) => e.actor === v);
    if (!t) return;
    const vp = this.victimProps || {};
    // their own skis now on their feet (the pair in the snow is gone); the sled stays for the patrol
    if (vp.skis?.parent) vp.skis.parent.remove(vp.skis);
    this.setSolid(t, false);
    t.colliders = [];
    if (t.obj) { this.mgroup.remove(t.obj); t.obj = null; }
    if (vp.sled) {
      // the sled stays where it is, on its own, until you have moved on
      vp.sled.parent?.remove(vp.sled);
      const rest = { obj: vp.sled, colliders: vp.sledCol ? [vp.sledCol] : [] };
      this.addThing(rest);
      rest.linger = true;
    }
    v.pose = 'ski';
    const stuck = job.variant === 'stuck';
    this.follower = new Follower(v, {
      vmax: stuck ? 13 : 14, plow: stuck, want: 0.9, minGap: 0.5, side: 3,
      clear: (x, z) => this.clearAt(x, z), catchUp: true, camera: this.player.camera,
    });
    t.follow = true;
    this.farT = 0;
  }

  // ---------------------------------------------------------------- rescue: the akja
  // "Load them into the akja": the casualty sits in the patrol's rescue sled (their skis go in with them) and
  // you tow it down on a rope to the lift / hut / village at the bottom, where the patrol takes over. The sled
  // trails TOW_ROPE behind you, follows the snow (pitched to the slope) and swings round behind you on turns.
  // Too fast (over TOW_VMAX for TOW_ROUGH s) or a crash and the patrol takes over: the job fails.
  startTow() {
    const job = this.job, v = this.victim, vp = this.victimProps;
    if (!job || job.type !== 'rescue' || job.phase === 'down' || !v?.rig || !vp?.sled || this.disposed) return;
    job.down ??= descentFor(this.sites, job.spot) || this.villageDown();
    job.phase = 'down'; job.tow = true; job.rough = 0;
    const estDown = this.est(v.pos, job.down);
    job.limit = job.elapsed + round15(estDown * 2.4 + 90);
    job.par = job.elapsed + Math.round(estDown * 1.4);
    // the crossed skis go into the sled; the casualty and the sled leave the spot together
    const t = this.things.find((e) => e.actor === v);
    if (t) {
      this.setSolid(t, false);
      t.colliders = [];
      if (t.obj) { this.mgroup.remove(t.obj); t.obj = null; }
      t.follow = true; // posed here, not by the job loop
    }
    while (v.prep > 0) v.prepStep();
    v.setVisible(true);
    const sled = vp.sled;
    sled.parent?.remove(sled);
    sled.rotation.order = 'YZX';
    const sz = sled.userData.size, alongX = !sz || sz.x >= sz.z;
    const half = Math.max(0.6, ((alongX ? sz?.x : sz?.z) || 2.3) / 2 - 0.15);
    const st = { obj: sled, colliders: [] };
    this.addThing(st);
    st.follow = true;
    this.tow = { sled, alongX, half, x: sled.position.x, z: sled.position.z, yaw: Math.atan2(this.player.pos.x - sled.position.x, this.player.pos.z - sled.position.z), warn: false };
    this.placeTow(0);
    this.farT = 0;
    this.writeSave();
    this.audio?.play?.('soft');
    this.hud?.flash?.(`${this.victimName(job)} is in the akja · tow them down to ${job.down.short || job.down.label}`, 'good', 3200);
    this.hudKey = -1; this.refreshHud();
  }

  // the sled on its rope behind you, and the casualty sitting in it
  placeTow(dt) {
    const T = this.tow, p = this.player.pos, v = this.victim;
    let dx = T.x - p.x, dz = T.z - p.z, d = Math.hypot(dx, dz);
    if (d > 40) {
      // a jump (a lift, a fade): the sled turns up right behind you
      const h = this.player.heading || 0;
      dx = -Math.sin(h); dz = -Math.cos(h); d = 1;
      T.x = p.x + dx * TOW_ROPE; T.z = p.z + dz * TOW_ROPE;
    } else if (d > TOW_ROPE) {
      T.x = p.x + (dx / d) * TOW_ROPE; T.z = p.z + (dz / d) * TOW_ROPE;
    }
    // the sled points at you (its long axis along the rope), eased so it doesn't snap round when you stop
    if (d > 0.3) {
      const want = Math.atan2(-dx, -dz);
      let dy = want - T.yaw; dy -= Math.round(dy / (Math.PI * 2)) * Math.PI * 2;
      T.yaw += dt > 0 ? dy * Math.min(1, dt * 6) : dy;
    }
    const fx = Math.sin(T.yaw), fz = Math.cos(T.yaw);
    const yF = meshY(T.x + fx * T.half, T.z + fz * T.half), yB = meshY(T.x - fx * T.half, T.z - fz * T.half);
    const y = Math.max(meshY(T.x, T.z), (yF + yB) / 2) - 0.02, pitch = Math.atan2(yF - yB, 2 * T.half);
    const s = T.sled;
    s.position.set(T.x, y, T.z);
    // the model's long axis (x or z) along the rope, tipped to the slope
    if (T.alongX) { s.rotation.order = 'YZX'; s.rotation.set(0, T.yaw - Math.PI / 2, pitch); } else { s.rotation.order = 'YXZ'; s.rotation.set(-pitch, T.yaw, 0); }
    if (v?.rig) {
      // sitting in it facing you, a little back from the middle so the legs fit
      const bx = T.x - fx * 0.35, bz = T.z - fz * 0.35;
      v.pos.set(bx, y + 0.16 - Math.sin(pitch) * 0.35, bz);
      v.heading = T.yaw;
      v.rig.root.position.copy(v.pos);
      v.rig.root.rotation.set(0, T.yaw, 0);
    }
  }

  updateTow(dt) {
    const job = this.job, T = this.tow, pl = this.player;
    this.placeTow(dt);
    // too fast is too rough for the casualty: a warning, then the patrol takes over
    const sp = pl.speed ?? Math.hypot(pl.vel?.x || 0, pl.vel?.z || 0);
    job.rough = Math.max(0, (job.rough || 0) + (sp > TOW_VMAX ? dt : -dt * 0.5));
    const warn = sp > TOW_VMAX;
    if (warn && !T.warn) { this.hud?.flash?.(`Easy! Too fast for ${this.victimName(job)} in the akja`, 'bad', 1800); this.audio?.play?.('error'); }
    if (warn !== T.warn) { T.warn = warn; this.hudKey = -1; }
    if (job.rough > TOW_ROUGH) { this.fail('rough'); return; }
    if (near(pl.pos, job.down, DOWN_R) && near(T, job.down, DOWN_GUEST_R)) this.complete();
  }

  // open snow a person can ski over: no tree, rock, net, sign or building within reach
  clearAt(x, z) {
    if (this.player.vegetation?.collide?.(x, z, 1.0)) return false;
    for (const c of this.colliders) {
      const reach = (c.r ?? Math.max(c.hw, c.hd)) + 1.2;
      if (Math.abs(x - c.x) > reach || Math.abs(z - c.z) > reach) continue;
      if (edgeDist(c, x, z) < 0.9) return false;
    }
    return true;
  }

  updateRescue(dt) {
    const job = this.job, v = this.victim;
    if (!v) return;
    if (this.tow) { this.updateTow(dt); return; }
    if (!this.follower) {
      if (v.pose === 'stand') this.startFollower();
      return;
    }
    const f = this.follower;
    const gap = f.update(dt, this.player);
    if (f.hidden) { this.farT = 0; return; }
    // both of you at the bottom
    const d = job.down;
    if (near(this.player.pos, d, DOWN_R) && near(v.pos, d, DOWN_GUEST_R)) { this.complete(); return; }
    // (they rejoin your track out of sight, so this takes leaving them behind on purpose)
    if (gap > 400) {
      this.farT += dt;
      if (this.farT > 12 || gap > 900) this.fail('lost');
    } else this.farT = 0;
  }

  updateGlint(dt, p) {
    const it = this.item;
    it.t += dt;
    const o = it.obj.position, dx = o.x - p.x, dz = o.z - p.z, d2 = dx * dx + dz * dz;
    const vis = d2 < GLINT_R2;
    it.glint.visible = vis;
    if (!vis) return;
    // an occasional sparkle, like sun catching glass or a buckle
    const s = Math.max(0, Math.sin(it.t * 2.2)), k = s * s * s * s * s * s * s * s;
    it.glint.material.opacity = 0.18 + 0.8 * k;
    it.glint.scale.setScalar(0.28 + 0.32 * k);
  }

  guestArrived() {
    const a = this.guest;
    if (!a || !this.job || this.follower?.hidden) return false;
    return near(a.pos, this.destPoint(this.job), 30);
  }

  // where a job's destination is right now (a board may have moved to a free spot after loading)
  destPoint(job) {
    const d = job.dest;
    if (d.kind === 'board') { const b = this.boardById(d.hubId); if (b) return b.front; }
    return d;
  }

  // ---------------------------------------------------------------- E prompts
  interaction(pos) {
    if (this.disposed) return null;
    const pl = this.player;
    if (pl && (pl.mode === 'sit' || pl.mode === 'fall')) return null;
    const job = this.job, P = this.prompts;
    if (job && P) {
      if (job.type === 'delivery') {
        if (near(pos, this.destPoint(job), job.dest.npc ? HAND_R : BOARD_R + 0.4)) return P.hand;
      } else if (job.type === 'rescue') {
        if (this.victim && job.phase !== 'down' && near(pos, this.victim.center(_c), HELP_R)) return P.help;
      } else if (job.type === 'escort') {
        if (near(pos, this.destPoint(job), ARRIVE_R)) return this.guestArrived() ? P.drop : P.wait;
      }
    }
    const boards = this.boards;
    for (let i = 0; i < boards.length; i++) if (near(pos, boards[i].front, BOARD_R)) return boards[i].prompt;
    return null;
  }

  // ---------------------------------------------------------------- compass waypoint
  waypoint(pos) {
    const job = this.job;
    if (!job || this.disposed) return null;
    const w = this._wp;
    if (job.type === 'escort' && this.guest && !this.follower?.hidden && this.follower?.gap > 90) {
      w.x = this.guest.pos.x; w.z = this.guest.pos.z; w.label = job.guest.name;
    } else if (job.type === 'rescue' && job.phase === 'down' && job.down) {
      const f = this.follower, far = f && !f.hidden && f.gap > 90 && this.victim;
      w.x = far ? this.victim.pos.x : job.down.x; w.z = far ? this.victim.pos.z : job.down.z;
      w.label = far ? this.victimName(job) : job.down.label;
    } else if (job.type === 'rescue' && this.victim) {
      w.x = this.victim.pos.x; w.z = this.victim.pos.z; w.label = job.dest.label;
    } else {
      const b = job.dest.kind === 'board' ? this.boardById(job.dest.hubId) : null, d = this.destPoint(job);
      w.x = d.x; w.z = d.z;
      w.label = b ? (b.hub.kind === 'village' ? 'Job board · village' : `Job board · ${b.hub.name}`) : job.dest.label;
    }
    void pos;
    return w;
  }

  // ---------------------------------------------------------------- map
  mapMarkers() {
    const out = this.boards.map((b) => ({ x: b.hub.x, z: b.hub.z, kind: 'board', label: 'Jobs' }));
    const job = this.job;
    if (job) {
      const w = this.waypoint(this.player.pos);
      if (w) out.push({ x: w.x, z: w.z, kind: 'target', label: w.label });
    }
    return out;
  }

  // ---------------------------------------------------------------- HUD line
  hudLine() { return this.hudText; }

  refreshHud() {
    this.hudT = 0.25;
    const job = this.job;
    if (!job) { this.hudText = ''; this.hudKey = -1; return; }
    const left = Math.max(0, job.limit - job.elapsed), sec = Math.ceil(left);
    let state = 0, extra = 0;
    if ((job.type === 'escort' || (job.type === 'rescue' && job.phase === 'down')) && this.follower) {
      const gap = this.follower.gap;
      if (this.follower.hidden) state = 7;
      else if (gap > (job.type === 'rescue' ? 35 : 90)) { state = 8; extra = Math.round(gap / 10); }
    } else if (job.type === 'rescue' && job.phase === 'down') state = job.tow ? (this.tow?.warn ? 11 : 10) : 9;
    const key = sec * 1000 + state * 100 + extra;
    if (key === this.hudKey) return;
    this.hudKey = key;
    const t = fmtClock(left);
    switch (job.type) {
      case 'delivery': this.hudText = `${job.short} to ${job.dest.short || shortOf(job.dest)} · ${t} left`; break;
      case 'rescue': {
        if (job.phase !== 'down') { this.hudText = `${job.short} · ${job.spot.piste} · ${t} left`; break; }
        const name = this.victimName(job), to = job.down?.short || 'the bottom';
        if (job.tow) { this.hudText = this.tow?.warn ? `Slow down · too fast for ${name} in the akja · ${t} left` : `Akja · tow ${name} down to ${to} · ${t} left`; break; }
        if (state === 8) this.hudText = `Wait for ${name} · ${extra * 10} m behind`;
        else if (state === 9) this.hudText = `${name} is getting up · ${t} left`;
        else this.hudText = `Bring ${name} down to ${to} · ${t} left`;
        break;
      }
      case 'escort': {
        const name = job.guest.name;
        if (state === 7) this.hudText = `${name} is right behind you · ${t} left`;
        else if (state === 8) this.hudText = `Wait for ${name} · ${extra * 10} m behind`;
        else this.hudText = `Guiding ${name} to ${job.dest.short || shortOf(job.dest)} · ${t} left`;
        break;
      }
      default: this.hudText = '';
    }
  }

  // ---------------------------------------------------------------- events
  /**
   * 'crash'    wipeout (faded back to the village): time-critical jobs end politely. Also detected
   *            on its own from the player's fall.
   * 'teleport' a forced move that should end time-critical jobs (e.g. starting a race session).
   *            Not for the ski bus or lifts: those are travel, jobs carry on.
   * 'lift'     boarded a lift ({ line }); only names the lift in the guide's message.
   */
  onEvent(name, data) {
    const job = this.job;
    if (!job || this.disposed) return;
    if (name === 'crash' || name === 'teleport') {
      this.fail(name);
    } else if (name === 'lift') {
      // which kind of lift you boarded (the guide's guest says so; the ride itself is seen from the
      // player sitting down, so a boarding that fell through changes nothing)
      const type = data?.line?.spec?.type ?? data?.spec?.type ?? data?.type;
      this.liftKind = type === 'chair' ? 'chair' : 'gondola';
    }
  }

  // ---------------------------------------------------------------- teardown
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    // a running job stays in the save and resumes next session; everything in the world goes
    this.detachCargo();
    this.removeItem();
    this.dropWarmup();
    for (const t of this.things.slice()) this.dropThing(t);
    this.mgroup.parent?.remove(this.mgroup);
    this.scene?.remove(this.group);
    for (const b of this.boards) {
      const i = this.colliders.indexOf(b.hub.collider);
      if (i >= 0) this.colliders.splice(i, 1);
    }
    this.boards.length = 0;
    this.follower = null; this.guest = null; this.victim = null; this.recipient = null;
    this.pool?.dispose();
    disposeProps();
  }
}
