// The multiplayer session: everything between "MULTIPLAYER" in the menu and LEAVE MULTIPLAYER.
//  - account: your unique name + its secret token, kept in localStorage per server URL (first launch: register)
//  - start(): connect, log in, join a world, swap the server profile into `save` (the single-player save is set
//    aside untouched and comes back on leave()), switch every AI system off, spawn the remote avatars
//  - update(dt) each frame: presence out at ~12 Hz, remote avatars (interpolated), the shared clock and weather,
//    the money guard, the status pill / race line
//  - the server-authoritative purchases (skis, outfits, chalets, the rental car and its plate) and payouts (jobs,
//    secrets, races) as small async helpers main.js and the game systems call
//  - wave 2: everyone's cars and helicopter copies (vehicles.js), car rides (carride.js), the helicopter pad
//    (heli.js), the race grid / live board / results card. See docs/multiplayer.md.
import { MP } from './mode.js';
import { net } from './client.js';
import { serverUrl } from './config.js';
import { PROTO, ST, F, ERR_TEXT, MAX_PLAYERS } from './protocol.js';
import { RemotePlayers } from './remote.js';
import { RemoteVehicles } from './vehicles.js';
import { CarRide } from './carride.js';
import { MpHeli } from './heli.js';
import { MpUI } from './ui.js';
import { MpTransit } from './transit.js';

const ACCOUNTS_KEY = 'ski-legacy-mp-accounts';
const SEND_HZ = 12;
const PUSH_DELAY = 1500; // ms: profile changes are pushed this long after the last writeSave()

export const errText = (e) => ERR_TEXT[e?.code] || e?.message || 'Something went wrong';

function readAccounts() { try { return JSON.parse(localStorage.getItem(ACCOUNTS_KEY) || '{}') || {}; } catch { return {}; } }
/** { name, token } stored for this server, or null (first launch: pick a name). */
export function loadAccount(url = serverUrl()) { const a = readAccounts()[url]; return a && a.name && a.token ? a : null; }
function storeAccount(url, acc) {
  const all = readAccounts();
  if (acc) all[url] = acc; else delete all[url];
  try { localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(all)); } catch { /* storage unavailable */ }
}

export class Multiplayer {
  /**
   * @param {object} c  main.js context:
   *   save, hud, audio, env, camera, scene, makeRig(charId, skiId), applyOutfit(rig, charId, outfit), getEquipped(save, charId),
   *   fx(id, rig, info, dt), pose(out) -> fills the local presence (see main.js mpPose), getScene(interiorId),
   *   setAI(on), applySave() (player / rental / HUD follow the swapped save), onLost(reason), onRaceStart(start),
   *   onKickInterior(id)
   */
  constructor(c) {
    this.c = c;
    this.url = serverUrl();
    this.ui = null;
    this.remotes = null;
    this.offs = [];
    this.sendAcc = 0;
    this.row = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    this.pose = { x: 0, y: 0, z: 0, yaw: 0, vx: 0, vy: 0, vz: 0, st: 0, crouch: 0, lean: 0, flags: 0, interior: null };
    this.interior = null;         // the interior the server approved for you
    this.clock = null;            // { hour, at, dayMs, weather }
    this.money = { server: 0, pending: 0 };
    this.pushT = null; this.pushed = {};
    this.race = { queued: null, queue: null, start: null };
    this.raceRows = []; this.boardT = 0;
    this.carRide = new CarRide(this); // your car shown to everyone, rides in other players' cars
    this.heliMp = new MpHeli(this);   // the helicopter pad and your copy
    this.transit = new MpTransit(this); // the shared trains, express, gondolas / chairlifts (and buses): seats, timelines
    this.vehicles = null;             // the other players' cars and helicopters (per world: setWorld)
    this.lastPos = { x: 0, z: 0, interior: null, t: 0 };
    // shared state for the wave-2 systems (live, kept current from the server's broadcasts)
    MP.seats = new Map();  // 'kind|id' -> [[seat, pid], ...]
    MP.warps = new Map();  // 'kind|line' -> { off, rate, since }
    MP.skip = new Map();   // 'kind|id' -> { holding, aboard, active }
    MP.heli = null;        // { copies: [{ id, name, since }], padAt, copyMs }
    MP.queues = new Map(); // race id -> { n, names, startAt }
  }

  account() { return loadAccount(this.url); }
  forgetAccount() { storeAccount(this.url, null); }

  // ---------------------------------------------------------------- connect / log in
  async ensureOpen() {
    if (net.open) return;
    await net.connect(this.url);
  }

  /** First launch: register a unique name (throws with .code 'name_taken' / 'name_invalid' / ...). */
  async register(name) {
    await this.ensureOpen();
    const d = await net.request('register', { name });
    storeAccount(this.url, { name: d.name, token: d.token });
    return d.name;
  }

  /** Log in with the stored account and enter multiplayer. Throws (with .code) when it cannot. */
  async start() {
    const acc = this.account();
    if (!acc) { const e = new Error('no account'); e.code = 'no_account'; throw e; }
    await this.ensureOpen();
    let d;
    try {
      d = await net.request('login', { v: PROTO, name: acc.name, token: acc.token, look: this.look(), plots: this.plots() });
    } catch (e) {
      if (e.code === 'bad_login') this.forgetAccount(); // (the server has no such name / key: pick a name again)
      throw e;
    }
    this.enter(d);
    return d;
  }

  /** Your character / outfit / skis changed: everyone's avatar of you follows. */
  sendLook() { if (MP.active) net.send('look', this.look()); }

  look() {
    const s = this.c.save, ch = s.character;
    let o = null;
    try { o = this.c.getEquipped(s, ch); } catch { o = null; }
    return { c: ch, o, s: s.skis || 'rental' };
  }

  enter(d) {
    MP.active = true;
    MP.name = d.name;
    MP.pid = d.pid;
    MP.catalog = d.catalog;
    MP.chalets = d.chalets || {};
    MP.status = 'online';
    this.applyProfile(d.profile);
    this.applyPlot(d.chaletPlot, true);
    this.setWorld(d.world);
    this.ui ||= new MpUI();
    this.ui.show(true);
    this.bind();
    this.c.setAI(false);
    MP.onSave = () => this.schedulePush();
    this.c.applySave();
    this.heliMp.attach();
    this.transit.start();
    net.send('look', this.look());
    this.push(true);
  }

  setWorld(w) {
    MP.world = { id: w.id, max: w.max || MAX_PLAYERS, players: new Map() };
    this.clock = w.clock;
    this.remotes?.dispose();
    this.vehicles = new RemoteVehicles({
      scene: this.c.scene, models: () => window.__game?.models, camera: () => this.c.camera,
      localCar: () => this.carRide.localCar(), selfName: () => MP.name,
      colliders: this.c.colliders, ridingPid: () => this.carRide.ride?.pid, // (their cars are solid: you can't walk or drive through them)
      transitSeat: (k, v, n, out) => this.transit.seat(k, v, n, out), // (riders of the shared trains, cabins, buses)
    });
    this.remotes = new RemotePlayers({
      scene: this.c.scene, makeRig: this.c.makeRig, applyOutfit: this.c.applyOutfit, getScene: this.c.getScene, fx: this.c.fx,
      now: () => net.serverNow(), selfPid: MP.pid, vehicles: this.vehicles,
    });
    for (const p of w.players) { MP.world.players.set(p.pid, { pid: p.pid, name: p.name, chalet: p.chalet }); this.remotes.add(p); }
    MP.seats.clear(); for (const s of w.seats || []) MP.seats.set(`${s.k}|${s.v}`, s.occ);
    MP.warps.clear(); for (const x of w.warps || []) MP.warps.set(x.key, { off: x.off, rate: x.rate, since: x.since });
    MP.heli = w.heli || null;
    MP.queues.clear(); for (const q of w.queues || []) MP.queues.set(q.race, q);
  }

  bind() {
    for (const off of this.offs) off();
    const on = (t, fn) => this.offs.push(net.on(t, fn));
    on('P', (rows) => this.remotes?.onRows(rows));
    on('join', (p) => { MP.world?.players.set(p.pid, { pid: p.pid, name: p.name, chalet: p.chalet }); this.remotes?.add(p); this.c.hud.flash(`${p.name} joined`, 'good', 2200); });
    on('leave', (p) => { MP.world?.players.delete(p.pid); this.remotes?.remove(p.pid); this.c.hud.flash(`${p.name} left`, 'good', 2200); });
    on('look', (d) => this.remotes?.setLook(d.pid, d.look));
    on('clock', (d) => { this.clock = d; });
    on('chalet', (d) => { if (d.owner) MP.chalets[d.id] = d.owner; else delete MP.chalets[d.id]; });
    on('chaletPlaced', (d) => this.applyPlot({ id: d.id, waiting: false }));
    on('guests', (d) => { if (d.kind === 'chaletVisit') this.guests = d.names || []; });
    on('money', (d) => { this.setServerMoney(d.v); if (d.delta > 0) this.c.hud.setMoney(this.c.save.money, d.delta); });
    on('seats', (d) => { const k = `${d.k}|${d.v}`; if (d.occ.length) MP.seats.set(k, d.occ); else MP.seats.delete(k); });
    on('skip', (d) => { MP.skip.set(`${d.k}|${d.v}`, d); });
    on('warp', (d) => { MP.warps.set(d.key, { off: d.off, rate: d.rate, since: d.since }); });
    on('heli', (d) => { MP.heli = d; });
    on('permAsk', (d) => this.onPermAsk(d));
    on('permClosed', (d) => this.ui?.cancel(d.rid));
    on('permRevoked', (d) => this.c.hud.flash(d.kind === 'carRide' ? `${d.owner} took back the car ride` : `${d.owner} took back the chalet visit`, 'bad', 3000));
    on('kickInterior', (d) => { this.interior = null; this.c.onKickInterior?.(d.interior); });
    on('seatLost', (d) => { this.carRide.onSeatLost(d); this.c.onSeatLost?.(d); });
    on('veh', (d) => this.remotes?.setVeh(d.pid, d.k, d.veh));
    on('raceProgress', (d) => { const r = this.race.start; if (r && r.rid === d.rid) r.done.set(d.pid, d); });
    on('raceQueue', (d) => { if (d.n) MP.queues.set(d.race, d); else MP.queues.delete(d.race); if (this.race.queued === d.race) this.race.queue = d; });
    on('raceStart', (d) => this.onRaceStart(d));
    on('raceResult', (d) => this.onRaceResult(d));
    on('raceDropped', (d) => { if (this.race.queued === d.race) this.race.queued = null; this.c.hud.flash('Race · not enough money for the entry fee', 'bad', 3000); });
    on('bye', (d) => { this.byeReason = d?.reason; });
    on('status', (s) => { MP.status = s === 'open' ? 'online' : s; });
    on('reopen', () => this.relogin());
    on('lost', (d) => this.lost(d?.reason === 'replaced' || this.byeReason === 'replaced' ? 'You logged in somewhere else.' : this.byeReason === 'restart' ? 'The server is restarting. Try again in a moment.' : 'Lost the connection to the server.'));
  }

  async relogin() {
    const acc = this.account();
    if (!acc || !MP.active) return;
    try {
      const d = await net.request('login', { v: PROTO, name: acc.name, token: acc.token, look: this.look(), plots: this.plots() });
      MP.pid = d.pid; MP.chalets = d.chalets || {};
      this.setServerMoney(d.profile.money);
      this.guests = [];
      this.applyPlot(d.chaletPlot, true);
      this.setWorld(d.world);
      if (this.interior) net.request('enter', { interior: this.interior }).catch(() => { this.interior = null; });
      // resumed: the server held you through the drop (same world and pid, seat, chalet plot, car, helicopter, race
      // entry): nothing to undo. Otherwise (away longer than the grace period) the rides start over
      if (!d.resumed) { this.carRide.reset(); this.heliMp.reset(); }
      this.c.hud.flash(d.resumed ? 'Reconnected' : 'Reconnected · back in the world', 'good', 2000);
      net.emit('relogin', d); // (wave-2 systems: claim your seat again; the server keeps it if it held you)
      // a race that ended while you were away: its results now
      const r = this.race.start;
      if (r && d.lastRace?.rid === r.rid) this.onRaceResult(d.lastRace);
      else if (r && !(d.world.races || []).some((x) => x.rid === r.rid)) { this.race.start = null; this.ui?.setBoard(null); }
    } catch (e) {
      // the account itself is refused (bad token, old game version): back to the menu. Anything else (a timeout, the
      // socket dropping again): try the connection again
      if (e.code === 'bad_login' || e.code === 'proto' || !MP.active) this.lost(errText(e));
      else { console.warn('[mp] login after reconnect:', e.code || e.message); net.reconnect('relogin'); }
    }
  }

  lost(reason) {
    if (!MP.active) return;
    this.leave();
    this.c.onLost?.(reason);
  }

  /** Back to single player: the local save returns exactly as it was. */
  leave() {
    if (!MP.active) return;
    if (this.race.start && !this.race.finished) net.send('raceFinish', { rid: this.race.start.rid, dnf: true });
    try { this.carRide.dispose(); this.heliMp.detach(); this.transit.stop(); } catch (e) { console.warn('[mp] vehicles', e); }
    for (const off of this.offs) off();
    this.offs.length = 0;
    clearTimeout(this.pushT); this.pushT = null;
    this.push(false, true);
    net.close('leave');
    this.remotes?.dispose(); this.remotes = null; this.vehicles = null;
    this.ui?.show(false);
    MP.active = false; MP.status = 'off'; MP.onSave = null; MP.world = null; MP.profile = null; MP.pid = 0; MP.chaletPlot = null;
    this.guests = []; this.ui?.setGuests(null);
    this.interior = null; this.race = { queued: null, queue: null, start: null };
    this.restoreSave();
    this.c.setAI(true);
    this.c.applySave();
  }

  // ---------------------------------------------------------------- the save swap
  applyProfile(p) {
    const s = this.c.save;
    this.spSave = JSON.parse(JSON.stringify(s));
    MP.profile = p;
    const car = p.cars?.[0];
    Object.assign(s, {
      money: p.money, owned: [...(p.owned || [])], skis: p.skis ?? null,
      outfits: { owned: [...(p.outfits?.owned || [])], equipped: { ...(p.outfits?.equipped || {}) } },
      chalet: p.chalet ? JSON.parse(JSON.stringify(p.chalet)) : null,
      rental: car ? { id: car.id, paint: car.paint, interior: car.interior, rims: car.rims, plate: car.plate, custom: !!car.custom } : null,
      stats: { races: 0, wins: 0, topSpeed: 0, distance: 0, earned: 0, ...(p.stats || {}) },
      records: { ...(p.records || {}) }, raceBest: {}, secrets: [...(p.secrets || [])],
      dayPass: p.dayPass ?? -1, tickets: p.tickets || 0,
      pos: null, // (where you were is single player only)
    });
    // (the character you picked in the menu is the one you play)
    this.money = { server: p.money, pending: 0 };
    this.expected = p.money;
  }
  /** Your chalet's plot from the server ({ id, waiting }): it stands there while you are online. Offline its plot was
   *  free; back, you get the old plot if it is free, else another one (your furniture comes along), else you wait for
   *  one ('chaletPlaced'). While you wait, save.chalet.id is null: you own it, it is just not placed. */
  applyPlot(p, first = false) {
    const s = this.c.save;
    MP.chaletPlot = p || { id: null, waiting: false };
    if (!s.chalet || !p) return;
    s.chalet.id = p.id ?? null;
    if (MP.profile?.chalet) MP.profile.chalet.id = p.id ?? null;
    const name = (id) => window.__game?.chalets?.houses?.find((h) => h.id === id)?.name || 'a chalet';
    if (p.waiting) this.c.hud.flash('Every chalet plot is taken · your chalet comes back when one is free', 'bad', 4200);
    else if (p.id != null && !first) this.c.hud.flash(`Your chalet is back · ${name(p.id)}`, 'good', 3600);
    else if (p.id != null && p.moved) this.c.hud.flash(`Your old plot was taken · your chalet is now ${name(p.id)}`, 'good', 4200);
    if (p.id != null) s.chalet.name = name(p.id);
  }
  /** The chalet village's house plots (the server learns them from the game). */
  plots() { const h = window.__game?.chalets?.houses; return Array.isArray(h) && h.length ? h.map((x) => x.id) : undefined; }
  /** Visiting: the owner's furniture for the chalet on plot `id` (you need their ok), or null. */
  async chaletFurniture(id) {
    try { const d = await net.request('chaletFurniture', { id }); return Array.isArray(d.chalet?.furniture) ? d.chalet.furniture : []; }
    catch { return null; }
  }
  /** Send a guest out of your chalet (the owner's guest list). */
  revokeGuest(name) {
    net.request('permRevoke', { kind: 'chaletVisit', guest: name }).then(() => this.c.hud.flash(`${name} has to leave your chalet`, 'good', 2400), () => {});
  }
  /** The in-game day of the world clock (everyone in multiplayer shares it), or null. */
  dayNow(now = net.serverNow()) {
    const c = this.clock;
    if (!c || !Number.isFinite(c.day)) return null;
    return c.day + Math.floor((c.hour + ((now - c.at) / c.dayMs) * 24) / 24);
  }

  restoreSave() {
    if (!this.spSave) return;
    const s = this.c.save;
    for (const k of Object.keys(s)) delete s[k];
    Object.assign(s, this.spSave);
    this.spSave = null;
  }

  // the parts of the profile the player owns (no money, nothing bought), pushed when they change
  schedulePush() {
    if (this.pushT) return;
    this.pushT = setTimeout(() => { this.pushT = null; this.push(); }, PUSH_DELAY);
  }
  push(force = false, last = false) {
    if (!MP.active || !net.open) return;
    const s = this.c.save;
    const send = (key, value) => {
      const j = JSON.stringify(value ?? null);
      if (!force && this.pushed[key] === j) return;
      this.pushed[key] = j;
      if (last) net.send('profileSet', { key, value }); // (leaving: no answers awaited, sent before the socket closes)
      else net.request('profileSet', { key, value }).catch((e) => console.warn(`[mp] profile ${key}: ${e.code || e.message}`));
    };
    send('character', s.character);
    if (s.skis) send('skis', s.skis);
    if (s.outfits?.equipped) send('outfitsEquipped', s.outfits.equipped);
    if (s.chalet && MP.profile?.chalet) send('chalet', s.chalet);
    send('stats', { topSpeed: s.stats?.topSpeed || 0, distance: s.stats?.distance || 0, longestJump: s.stats?.longestJump || 0, bestAir: s.stats?.bestAir || 0 });
    send('records', s.records || {});
    send('secrets', s.secrets || []);
    send('dayPass', s.dayPass ?? -1);
    send('tickets', s.tickets || 0);
  }

  // ---------------------------------------------------------------- money: the server's number wins
  // Any drop of save.money (spend(), a fee taken straight off the save...) is sent as a spend the server checks;
  // any rise that did not come from the server (the admin panel, a cheat, an old code path) is undone.
  setServerMoney(v) {
    if (!Number.isFinite(v)) return;
    this.money.server = v;
    this.expected = v - this.money.pending;
    this.c.save.money = this.expected;
    this.c.hud.setMoney?.(this.c.save.money);
  }
  guardMoney() {
    const s = this.c.save;
    if (s.money === this.expected) return;
    if (s.money > this.expected) { s.money = this.expected; this.c.hud.setMoney?.(s.money); return; }
    const amount = Math.round(this.expected - s.money);
    this.expected = s.money;
    if (amount <= 0) return;
    this.money.pending += amount;
    net.request('spend', { amount, reason: 'game' }).then(
      (d) => { this.money.pending -= amount; this.setServerMoney(d.money); },
      (e) => { this.money.pending -= amount; this.setServerMoney(e.data?.money ?? this.money.server); if (e.code === 'money') this.c.hud.flash('Not enough money (server)', 'bad', 2200); },
    );
  }

  /** Jobs / secrets pay out through the server (limits per payout and per hour). Resolves true when paid. */
  async earn(amount, source = 'job') {
    try { const d = await net.request('earn', { amount: Math.round(amount), source }); this.setServerMoney(d.money); return true; }
    catch (e) { if (e.data?.money != null) this.setServerMoney(e.data.money); this.c.hud.flash(`Payout refused · ${e.code === 'cap' ? 'hourly limit reached' : errText(e)}`, 'bad', 2600); return false; }
  }

  /** A purchase the server checks: kind 'skis' | 'outfit' | 'chalet' | 'car'. Resolves the server's answer or null. */
  async buy(kind, data) {
    this.guardMoney();
    try {
      const d = await net.request('buy', { kind, ...data });
      if (d.money != null) this.setServerMoney(d.money);
      return d;
    } catch (e) {
      if (e.data?.money != null) this.setServerMoney(e.data.money);
      const msg = e.code === 'taken' ? `${e.data?.owner || 'Somebody'} already owns it` : e.code === 'plate_taken' ? `The plate ${e.data?.plate || ''} is taken` : e.code === 'one_each' ? (MP.chaletPlot?.waiting ? 'You own a chalet · it comes back when a plot is free' : 'One chalet each') : errText(e);
      this.c.hud.flash(msg, 'bad', 2600);
      this.c.audio?.play?.('error');
      return null;
    }
  }
  async buySkis(id) {
    const d = await this.buy('skis', { id });
    if (!d) return false;
    const s = this.c.save;
    s.owned = d.owned; MP.profile.owned = d.owned;
    this.c.audio?.play?.('cash');
    return true;
  }
  async buyOutfit(id) {
    const d = await this.buy('outfit', { id });
    if (!d) return false;
    this.c.save.outfits.owned = [...d.outfits.owned];
    MP.profile.outfits = d.outfits;
    this.c.audio?.play?.('cash');
    return true;
  }
  async buyChalet(h, meta = { plan: 2, layout: 3 }) {
    const d = await this.buy('chalet', { id: h.id, name: h.name, meta });
    if (!d) return false;
    this.c.save.chalet = JSON.parse(JSON.stringify(d.chalet));
    MP.profile.chalet = d.chalet;
    MP.chalets[h.id] = MP.name;
    this.c.audio?.play?.('cash');
    this.c.hud.flash(`${h.name} is yours · E at its front door to go in`, 'good', 3400);
    return true;
  }
  /** The rental car (one at a time): the server prices it and keeps its plate unique. */
  async rentCar(cfg) {
    const d = await this.buy('car', { cfg });
    if (!d) return null;
    MP.profile.cars = [d.car];
    this.c.audio?.play?.('cash');
    return d.car;
  }
  /** The configurator's plate step: is this plate free? -> { plate, free, mine } (null offline / bad plate). */
  plateCheck(plate) { return net.request('plateCheck', { plate }).catch(() => null); }
  /** A random plate nobody has (the server's), or null. */
  plateIssue() { return net.request('plateIssue').then((d) => d.plate || null, () => null); }
  carEnded(cfg) { if (cfg?.plate) net.request('carReturn', { plate: cfg.plate }).catch(() => {}); if (MP.profile) MP.profile.cars = []; }

  // ---------------------------------------------------------------- interiors and permissions
  /** Tell the server which interior you are in (null = outdoors). Resolves false when it refuses (a chalet). */
  async setInterior(id) {
    if (id === this.interior) return true;
    try { await net.request('enter', { interior: id }); this.interior = id; return true; }
    catch (e) { return false; }
  }
  /** Ask an owner: kind 'carRide' (to: name) or 'chaletVisit' (ref: chalet id). Resolves { allow } (false on error). */
  async ask(kind, { to, ref } = {}) {
    try { return await net.request('perm', { kind, to, ref }, 40000); }
    catch (e) { this.c.hud.flash(errText(e), 'bad', 2400); return { allow: false, error: e.code }; }
  }
  async onPermAsk(d) {
    const text = d.kind === 'carRide' ? `Allow ${d.from} to get in your car?` : `${d.from} wants to visit your chalet`;
    this.c.audio?.play?.('tick');
    const allow = await this.ui.ask(d.rid, text, d.timeoutMs || 30000);
    if (allow === null) return; // (closed by the server)
    net.request('permAnswer', { rid: d.rid, allow }).catch(() => {});
  }

  // ---------------------------------------------------------------- races (queue, synced start, server results)
  async raceJoin(race) {
    try {
      const d = await net.request('raceJoin', { race });
      this.race.queued = race; this.race.queue = d; this.race.finished = false;
      this.c.hud.flash('In the race queue · at least 2 racers', 'good', 2600);
      return true;
    } catch (e) { this.c.hud.flash(errText(e), 'bad', 2400); return false; }
  }
  raceLeave() { if (this.race.queued) { net.request('raceLeave').catch(() => {}); this.race.queued = null; this.race.queue = null; } }
  onRaceStart(d) {
    const me = d.grid.find((g) => g.pid === MP.pid);
    if (!me) return;
    this.race.queued = null; this.race.queue = null;
    this.race.start = { ...d, slot: me.slot, done: new Map() }; this.race.finished = false;
    this.ui?.closeResults();
    this.c.onRaceStart?.({ ...d, slot: me.slot, n: d.grid.length, secondsToGo: () => (d.at - net.serverNow()) / 1000 });
  }
  /** The race session's result callback: the server ranks everybody and pays the prizes (raceResult). */
  raceFinished({ time, dnf }) {
    const r = this.race.start;
    if (!r || this.race.finished) return 0;
    this.race.finished = true;
    net.request('raceFinish', { rid: r.rid, time: Number.isFinite(time) ? Math.round(time * 1000) : null, dnf: !!dnf || !Number.isFinite(time) }).catch(() => {});
    return 0; // (the prize comes with the server's result)
  }
  onRaceResult(d) {
    const mine = d.order.find((o) => o.pid === MP.pid);
    if (!mine || this.race.start?.rid !== d.rid) return;
    this.race.start = null;
    this.ui?.setBoard(null);
    const course = window.__game?.modes?.course;
    const title = course?.id === d.race && course.name ? course.name : String(d.race || 'Race').replace(/[-_]/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
    this.ui?.results(title, d.order, MP.pid); // (everyone's times and prize money, from the server)
    const s = this.c.save.stats;
    s.races = (s.races || 0) + 1;
    if (mine.place === 1) s.wins = (s.wins || 0) + 1;
    const ord = (n) => `${n}${n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'}`;
    this.c.hud.flash(mine.dnf ? 'Race over · DNF' : `Race over · ${ord(mine.place)} of ${d.order.length}${mine.prize ? ` · +$${mine.prize.toLocaleString('en-US')}` : ''}`, mine.place === 1 ? 'gold' : 'good', 4200);
  }
  /** The other racers who have finished, as rows for the race's own results table (modes/race/session.js). */
  raceOthers() {
    const r = this.race.start, out = [];
    if (!r) return out;
    for (const p of r.done.values()) if (p.pid !== MP.pid) out.push({ name: p.name, time: p.dnf ? Infinity : p.time / 1000, me: false, kind: 'player', dnf: !!p.dnf });
    return out;
  }
  // the live race board: finished racers by time, then everyone still racing by how far down the course they are
  // (twice a second)
  updateBoard(dt, now) {
    const r = this.race.start;
    if (!r || now < r.at) { if (this.ui?.lines.board) this.ui.setBoard(null); return; }
    if ((this.boardT += dt) < 0.5) return;
    this.boardT = 0;
    const g = window.__game, track = g?.modes?.session?.track, rows = this.raceRows;
    rows.length = 0;
    for (const e of r.grid) {
      const fin = r.done.get(e.pid), me = e.pid === MP.pid;
      let s = -Infinity;
      if (!fin && track?.nearestS) {
        const p = me ? g.player.pos : this.remotes?.players.get(e.pid)?.pos;
        if (p) s = track.nearestS(p.x, p.z);
      }
      rows.push({ name: me ? `${e.name} (you)` : e.name, me, time: fin && !fin.dnf ? fin.time / 1000 : null, dnf: !!fin?.dnf, s });
    }
    rows.sort((a, b) => (a.dnf - b.dnf) || ((a.time ?? Infinity) - (b.time ?? Infinity)) || (b.s - a.s));
    this.ui?.setBoard(rows);
  }
  raceLine(now) {
    const q = this.race.queue;
    if (this.race.queued && q) {
      if (q.n < 2 || !q.startAt) return `RACE QUEUE · ${q.n}/2 · waiting for players`;
      return `RACE QUEUE · ${q.n} racers · starting in ${Math.max(0, Math.ceil((q.startAt - now) / 1000))}s`;
    }
    const r = this.race.start;
    if (r && now < r.at) return `RACE · GO in ${Math.max(0, Math.ceil((r.at - now) / 1000))}s`;
    return '';
  }

  // ---------------------------------------------------------------- shared transport (wave-2 hooks)
  /** A seat on a shared vehicle: kind 'bus' | 'train' | 'express' | 'gondola' | 'chair' | 'heli' | 'car' | 'sled',
   *  id: the vehicle (a car: its owner's name). The server gives the lowest free seat (n: seats it has, seat: a
   *  preferred one). Resolves { seat, v } or null (full / no permission: flashed). One seat per player. */
  async claimSeat(k, v, { n, seat, quiet = false } = {}) {
    try { return await net.request('seatClaim', { k, v, n, seat }); }
    catch (e) { if (!quiet) this.c.hud.flash(errText(e), 'bad', 2400); return null; }
  }
  releaseSeat() { this.skipHeld = null; return net.request('seatRelease').catch(() => {}); }
  /** [[seat, pid], ...] taken on a vehicle (from the server's 'seats' broadcasts). */
  seatsOf(k, v) { return MP.seats.get(`${k}|${v}`) || []; }
  /** SPACE held / released on your shared vehicle (call every frame: only changes are sent). rate: the single-player
   *  fast-forward rate of that vehicle; line: the timeline it warps ('kind|line' in MP.warps; default: the vehicle). */
  holdSkip(k, v, on, { rate = 16, line } = {}) {
    on = !!on;
    const h = this.skipHeld;
    if (h && h.k === k && h.v === v && h.on === on) return; // (no allocation while nothing changes)
    this.skipHeld = { k, v, on };
    net.request('skip', { k, v, on, rate, line }).catch(() => {});
  }
  /** The HUD line for the speed-up on a shared vehicle ('' when alone aboard). */
  skipLine(k, v) {
    const s = MP.skip.get(`${k}|${v}`);
    if (!s || s.aboard <= 1) return '';
    return s.active ? `Speeding up · everyone is holding SPACE` : `Hold SPACE to speed up (${s.holding}/${s.aboard} holding)`;
  }
  /** Helicopter copies at the pad: resolves { id } or null (not_yet: d.waitMs). */
  async heliRent() {
    try { const d = await net.request('heliRent'); this.setServerMoney(d.money); return d; }
    catch (e) { this.c.hud.flash(e.code === 'not_yet' ? `Next helicopter in ${Math.ceil((e.data?.waitMs || 0) / 60000)} min` : errText(e), 'bad', 2600); return null; }
  }
  heliReturn() { return net.request('heliReturn').catch(() => {}); }

  // ---------------------------------------------------------------- shared timelines (wave-2 transport)
  /** ms on a line's shared timeline (server clock + its speed-up so far): every client places the vehicles of
   *  `kind|line` from this. */
  lineTime(key, now = net.serverNow()) {
    const w = MP.warps.get(key);
    return w ? now + w.off + (w.rate - 1) * (now - w.since) : now;
  }
  /** The world's hour now (shared by everyone in it). */
  hourNow(now = net.serverNow()) {
    const c = this.clock;
    if (!c) return null;
    return (((c.hour + ((now - c.at) / c.dayMs) * 24) % 24) + 24) % 24;
  }

  /** main.js: the shared transport systems ({ railway, express, lifts, skibus, player, expressRate }) for net/transit.js. */
  attachTransit(sys) { this.transit.attach(sys); }

  /** E near another player's car: "Ask <owner> for a ride" (main.js findInteraction). */
  carInteraction(pos) { return MP.active ? this.carRide.interaction(pos) : null; }

  /** Late in the frame, after your car moved (main.js, after drive.update): the players riding in your car, and you
   *  riding in someone else's (E gets out). input: null while a menu is open. */
  late(dt, input) {
    if (!MP.active) return;
    if (this.view) this.remotes?.late(dt, this.view);
    this.carRide.late(dt, input);
  }

  /** Inside your own chalet with guests: the guest list, each with "send out" (TAB frees the mouse to click). */
  guestUI() {
    const own = !!window.__game?.chalets?.insideOwn?.();
    const list = own && this.guests?.length ? this.guests : null;
    this.revokeFn ||= (name) => this.revokeGuest(name);
    this.ui?.setGuests(list, this.revokeFn);
  }

  // ---------------------------------------------------------------- every frame
  update(dt, view) {
    if (!MP.active) return;
    const now = net.serverNow();
    // the shared clock and weather
    const env = this.c.env, h = this.hourNow(now);
    if (h != null) {
      env.hour = h;
      env.weatherTimer = 1e9; // (the server moves the weather on)
      if (this.clock.weather && env.weather !== this.clock.weather) env.setWeather(this.clock.weather);
    }
    const day = this.dayNow(now), s = this.c.save;
    if (day != null && s.day !== day) s.day = day; // (the day pass and the jobs count the world's days)
    this.guestUI();
    this.guardMoney();
    try { this.carRide.frame(dt); this.heliMp.frame(dt); } catch (e) { console.warn('[mp] vehicles', e); }
    try { this.transit.update(); } catch (e) { console.warn('[mp] transit', e); }
    // presence
    this.sendAcc += dt;
    if (this.sendAcc >= 1 / SEND_HZ && net.open) {
      this.sendAcc = 0;
      const p = this.pose;
      this.c.pose(p);
      this.carRide.pose(p); this.heliMp.pose(p); // (driving / flying: the vehicle's pose; riding with someone)
      // inside, the walk speed from the step since the last row (the rooms' avatars walk instead of gliding)
      const L = this.lastPos, now2 = performance.now(), sdt = Math.max(0.02, (now2 - L.t) / 1000);
      if (p.interior && p.interior === L.interior && !p.vx && !p.vz) { p.vx = (p.x - L.x) / sdt; p.vz = (p.z - L.z) / sdt; if (Math.hypot(p.vx, p.vz) > 6) p.vx = p.vz = 0; }
      L.x = p.x; L.z = p.z; L.interior = p.interior; L.t = now2;
      if (p.interior !== this.interior) {
        // into / out of an interior: the server approves it first (a chalet needs its owner's ok); until then no
        // presence goes out (nobody sees you outdoors at the interior's coordinates)
        if (!this.entering) {
          const want = p.interior;
          this.entering = true;
          this.setInterior(want).then((ok) => { this.entering = false; if (!ok) this.c.onKickInterior?.(want); });
        }
      } else {
        const r = this.row;
        r[0] = Math.round(now); r[1] = p.x; r[2] = p.y; r[3] = p.z; r[4] = p.yaw; r[5] = p.vx; r[6] = p.vy; r[7] = p.vz;
        r[8] = p.st; r[9] = p.crouch; r[10] = p.lean; r[11] = p.flags;
        net.sendPresence(r);
      }
    }
    this.remotes?.update(dt, view);
    this.view = view;
    this.updateBoard(dt, now);
    // the status pill
    const w = MP.world;
    if (this.ui) {
      if (MP.status === 'reconnecting') this.ui.setStatus('MULTIPLAYER · reconnecting…', true);
      else this.ui.setStatus(`${MP.name} · WORLD ${w?.id ?? '-'} · ${(w?.players.size || 1)}/${w?.max || MAX_PLAYERS} PLAYERS`);
      this.ui.setRace(this.raceLine(now));
    }
  }
}

export { ST, F };
