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
import { TowMp } from './tow.js';
import { RescueMp } from './rescue.js';
import { SledMp } from './sled.js';
import { MpHeli } from './heli.js';
import { MpUI } from './ui.js';
import { MpTransit } from './transit.js';
import { DEVICE_PREFS } from '../game/economy.js';

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
    this.pose = { x: 0, y: 0, z: 0, yaw: 0, vx: 0, vy: 0, vz: 0, st: 0, crouch: 0, lean: 0, flags: 0, interior: null, hold: false }; // (hold: send nothing this time)
    this.interior = null;         // the interior the server approved for you
    this.clock = null;            // { hour, at, dayMs, weather }
    this.money = { server: 0, pending: 0 };
    this.pushT = null; this.pushed = {};
    this.race = { queued: null, queue: null, start: null };
    this.raceRows = []; this.boardT = 0;
    this.carRide = new CarRide(this); // your car shown to everyone, rides in other players' cars
    this.towMp = new TowMp(this);     // your tow truck shown to everyone (its pose, your car on its bed)
    this.rescueMp = new RescueMp(this); // your rescue helicopter and ambulance shown to everyone (net/rescue.js)
    this.sledMp = new SledMp(this);   // the snowmobile you drive shown to everyone (net/sled.js)
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
      d = await net.request('login', { v: PROTO, name: acc.name, token: acc.token, look: this.look(), plots: this.plots(), tt: this.transit.fingerprint() });
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
    this.byeReason = null; // (a 'kicked' / 'replaced' from an earlier session must not name the next one's loss)
    this.guests = Array.isArray(d.guests) ? d.guests : [];
    this.applyProfile(d.profile);
    this.applyPlot(d.chaletPlot, true);
    this.setWorld(d.world);
    { const day = this.dayNow(); if (day != null) this.c.save.day = day; } // (the world's day before the rental is placed: impound.js adopt)
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
      localTow: () => window.__game?.carRental?.truck || null, // (your own truck: the others' are not drawn over it in the TOW bay)
      localHeli: () => window.__game?.heli || null, // (your own helicopter on the pad: a rescue heli landing there is not drawn over it)
    });
    this.remotes = new RemotePlayers({
      scene: this.c.scene, makeRig: this.c.makeRig, applyOutfit: this.c.applyOutfit, getScene: this.c.getScene, fx: this.c.fx,
      now: () => net.serverNow(), selfPid: MP.pid, vehicles: this.vehicles,
    });
    for (const p of w.players) { MP.world.players.set(p.pid, { pid: p.pid, name: p.name, chalet: p.chalet }); this.remotes.add(p); }
    setTimeout(() => this.transit.checkVersions(w.players.filter((p) => p.pid !== MP.pid)), 3000);
    MP.seats.clear(); for (const s of w.seats || []) MP.seats.set(`${s.k}|${s.v}`, s.occ);
    MP.warps.clear(); for (const x of w.warps || []) MP.warps.set(x.key, { off: x.off, rate: x.rate, since: x.since });
    MP.heli = w.heli || null;
    MP.queues.clear(); for (const q of w.queues || []) MP.queues.set(q.race, q);
  }

  bind() {
    for (const off of this.offs) off();
    const on = (t, fn) => this.offs.push(net.on(t, fn));
    on('P', (rows) => this.remotes?.onRows(rows));
    on('join', (p) => { MP.world?.players.set(p.pid, { pid: p.pid, name: p.name, chalet: p.chalet }); this.remotes?.add(p); this.c.hud.flash(`${p.name} joined`, 'good', 2200); setTimeout(() => this.transit.checkVersions([p]), 2400); }); // (another game version: its trains run other times)
    on('leave', (p) => { MP.world?.players.delete(p.pid); this.remotes?.remove(p.pid); this.c.hud.flash(`${p.name} left`, 'good', 2200); });
    on('look', (d) => this.remotes?.setLook(d.pid, d.look));
    on('clock', (d) => { this.clock = d; });
    on('chalet', (d) => { if (d.owner) MP.chalets[d.id] = d.owner; else delete MP.chalets[d.id]; });
    on('chaletPlaced', (d) => this.applyPlot({ id: d.id, waiting: false }));
    on('guests', (d) => { if (d.kind === 'chaletVisit') this.guests = d.names || []; });
    // the server admin moved you next to another player (/admin/tp): not while driving, flying or inside
    on('adminTp', (d) => {
      const g = window.__game;
      if (!g?.player || !Number.isFinite(d?.x) || !Number.isFinite(d?.z)) return;
      // (nor on a train, the express, a bus, a sled, in someone's car or in a race: those keep their own seat and
      // state, and a teleport would leave them riding with you gone)
      if (g.drive?.active || g.heli?.active || g.interior?.active || g.chalets?.inside || g.carRental?.inside || g.prison?.inside || g.hospitalWard?.inside || g.railway?.riding || g.express?.riding
        || g.skibus?.riding || g.sleds?.active || g.modes?.active || this.carRide.ride || this.race.start) { this.c.hud.flash(`The server tried to move you to ${d.to} · get out first`, 'bad', 3000); return; }
      const off = 1.8, x = d.x - Math.sin(d.yaw || 0) * off, z = d.z - Math.cos(d.yaw || 0) * off;
      if (g.admin?.teleport) g.admin.teleport({ x, z, heading: d.yaw || 0, label: `Moved next to ${d.to}`, skis: false });
      else g.player.teleport(x, z, d.yaw || 0);
    });
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
    on('arrested', (d) => this.carRide.onArrested(d)); // (the driver of the car you ride in was arrested: you too)
    on('veh', (d) => this.remotes?.setVeh(d.pid, d.k, d.veh));
    on('raceProgress', (d) => { const r = this.race.start; if (r && r.rid === d.rid) { r.done.set(d.pid, d); if (d.closeAt) r.closeAt = d.closeAt; } });
    on('raceBoard', (d) => { const r = this.race.start; if (r && r.rid === d.rid) { r.board = d.rows; r.boardAt = performance.now(); } });
    on('raceQueue', (d) => {
      if (d.n) MP.queues.set(d.race, d); else MP.queues.delete(d.race);
      if (this.race.queued === d.race) this.race.queue = d;
      // waiting for the next race after a full one: in as soon as the queue has room
      if (this.race.waitNext === d.race && d.n < (d.max || 21) && !this.race.start) { this.race.waitNext = null; this.raceJoin(d.race); }
    });
    on('raceStart', (d) => this.onRaceStart(d));
    on('raceResult', (d) => this.onRaceResult(d));
    on('raceDropped', (d) => { if (this.race.queued === d.race) this.race.queued = null; this.c.hud.flash('Race · not enough money for the entry fee', 'bad', 3000); });
    on('bye', (d) => { this.byeReason = d?.reason; });
    on('status', (s) => { MP.status = s === 'open' ? 'online' : s; });
    on('reopen', () => this.relogin());
    on('lost', (d) => this.lost(d?.reason === 'kicked' || this.byeReason === 'kicked' ? 'You were kicked from the server.' : d?.reason === 'replaced' || this.byeReason === 'replaced' ? 'You logged in somewhere else.' : this.byeReason === 'restart' ? 'The server is restarting. Try again in a moment.' : 'Lost the connection to the server.'));
  }

  async relogin() {
    const acc = this.account();
    if (!acc || !MP.active) return;
    try {
      const d = await net.request('login', { v: PROTO, name: acc.name, token: acc.token, look: this.look(), plots: this.plots(), tt: this.transit.fingerprint() });
      MP.pid = d.pid; MP.chalets = d.chalets || {};
      this.byeReason = null; // (a 'restart' before this reconnect is not the reason for a later loss)
      this.setServerMoney(d.profile.money);
      this.guests = Array.isArray(d.guests) ? d.guests : []; // (resumed: your guests are still allowed in)
      this.applyPlot(d.chaletPlot, true);
      this.setWorld(d.world);
      if (this.interior) net.request('enter', { interior: this.interior }).catch(() => { this.interior = null; });
      // resumed: the server held you through the drop (same world and pid, seat, chalet plot, car, helicopter, race
      // entry): nothing to undo. Otherwise (away longer than the grace period) the rides start over
      if (!d.resumed) { this.carRide.reset(); this.heliMp.reset(); this.towMp.reset(); this.rescueMp.reset(); this.sledMp.reset(); }
      this.c.hud.flash(d.resumed ? 'Reconnected' : 'Reconnected · back in the world', 'good', 2000);
      net.emit('relogin', d); // (wave-2 systems: claim your seat again; the server keeps it if it held you)
      // a race that ended while you were away: its results now
      const r = this.race.start;
      if (r && d.lastRace?.rid === r.rid) this.onRaceResult(d.lastRace);
      else if (r && !(d.world.races || []).some((x) => x.rid === r.rid)) { this.race.start = null; this.ui?.setBoard(null); }
      this.raceAfterRelogin(d);
    } catch (e) {
      // the account itself is refused (bad token, old game version): back to the menu. Anything else (a timeout, the
      // socket dropping again): try the connection again
      if (e.code === 'bad_login' || e.code === 'proto' || !MP.active) this.lost(errText(e));
      else { console.warn('[mp] login after reconnect:', e.code || e.message); net.reconnect('relogin'); }
    }
  }

  /** After a login on a new connection: the race queue and a race start you may have missed meanwhile. The queue
   *  line follows the server (a login that did not resume left the queue; a countdown may have started or moved on),
   *  and a race that started during the drop with you on its grid is joined (a few seconds late at most) or given up
   *  (DNF), so the server never waits for a racer whose client never started. */
  raceAfterRelogin(d) {
    if (this.race.queued) {
      const q = MP.queues.get(this.race.queued);
      if (q && (q.names || []).includes(MP.name)) this.race.queue = q;
      else { this.race.queued = null; this.race.queue = null; }
    }
    if (this.race.start) return;
    const st = (d.world?.races || []).find((x) => x.grid?.some((g) => g.pid === MP.pid));
    if (!st) return;
    if (net.serverNow() - st.at < 20000) { this.onRaceStart(st); return; }
    net.request('raceFinish', { rid: st.rid, dnf: true }).catch(() => {});
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
    try { this.carRide.dispose(); this.towMp.dispose(); this.rescueMp.dispose(); this.sledMp.dispose(); this.heliMp.detach(); this.transit.stop(); } catch (e) { console.warn('[mp] vehicles', e); }
    for (const off of this.offs) off();
    this.offs.length = 0;
    clearTimeout(this.pushT); this.pushT = null;
    this.push(false, true);
    net.close('leave');
    this.remotes?.dispose(); this.remotes = null; this.vehicles = null;
    this.ui?.show(false);
    MP.active = false; MP.status = 'off'; MP.onSave = null; MP.world = null; MP.profile = null; MP.pid = 0; MP.chaletPlot = null;
    this.guests = []; this.ui?.setGuests(null);
    this.interior = null; this.race = { queued: null, queue: null, start: null }; this.byeReason = null;
    this.skipHeld = null; this.entering = false;
    MP.seats.clear(); MP.warps.clear(); MP.skip.clear(); MP.queues.clear(); MP.heli = null; MP.chalets = {};
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
      rental: car ? { id: car.id, paint: car.paint, interior: car.interior, rims: car.rims, plate: car.plate, custom: !!car.custom, ...(car.price != null ? { price: car.price } : {}) } : null,
      garage: (p.cars || []).map((c) => ({ id: c.id, paint: c.paint, interior: c.interior, rims: c.rims, plate: c.plate, custom: !!c.custom, ...(c.price != null ? { price: c.price } : {}) })), // (AUTOHAUS: every car you own; cars[0] is out)
      impound: car?.impound ? { day: car.impound.day, until: car.impound.until, bay: car.impound.bay | 0, plate: car.plate } : null, // (the server keeps it: impound.js)
      stats: { races: 0, wins: 0, topSpeed: 0, distance: 0, earned: 0, ...(p.stats || {}) },
      records: { ...(p.records || {}) }, raceBest: {}, secrets: [...(p.secrets || [])],
      dayPass: p.dayPass ?? -1, tickets: p.tickets || 0,
      pos: p.pos && Number.isFinite(p.pos.x) ? { ...p.pos } : null, // (where you were: kept on the server, Oct 30)
      wanted: p.wanted && Number.isFinite(p.wanted.h) ? { ...p.wanted } : null, // (a police chase you left in: police.js resumes it)
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
    const s = this.c.save, keep = {};
    // (this machine's settings changed while online stay: graphics, mouse, volume are not progress)
    for (const k of DEVICE_PREFS) if (s[k] !== undefined) keep[k] = s[k];
    for (const k of Object.keys(s)) delete s[k];
    Object.assign(s, this.spSave, keep);
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
      // (not stored: sent again with the next push. A timeout may still have arrived: profileSet is idempotent)
      else net.request('profileSet', { key, value }).catch((e) => { if (this.pushed[key] === j) delete this.pushed[key]; console.warn(`[mp] profile ${key}: ${e.code || e.message}`); });
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
    if (s.pos) send('pos', s.pos); // (where you were: back there at your next login)
    send('wanted', s.wanted || null); // (a police chase under way: it carries on at your next login, game/police.js)
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
      const msg = e.code === 'taken' ? `${e.data?.owner || 'Somebody'} already owns it` : e.code === 'plate_taken' ? `The plate ${e.data?.plate || ''} is taken` : e.code === 'garage_full' ? `Your garage is full (${e.data?.max || 10} cars) · sell one first (MY CARS)` : e.code === 'one_each' ? (MP.chaletPlot?.waiting ? 'You own a chalet · it comes back when a plot is free' : 'One chalet each') : errText(e);
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
  /** AUTOHAUS: buy a car (several, the same model too, up to catalog garageMax; it joins your garage and is the one out): the server prices it and keeps
   *  its plate unique. Resolves { car, cars } (cars: your garage, cars[0] out) or null. */
  async rentCar(cfg) {
    const d = await this.buy('car', { cfg });
    if (!d) return null;
    MP.profile.cars = d.cars || [d.car];
    this.c.audio?.play?.('cash');
    return { car: d.car, cars: MP.profile.cars };
  }
  /** Another car of yours out (free; the server moves it to cars[0]). Resolves your garage or null. */
  async switchCar(plate) {
    try { const d = await net.request('carSwitch', { plate }); MP.profile.cars = d.cars; return d.cars; }
    catch (e) { this.c.hud.flash(`Could not swap cars · ${errText(e)}`, 'bad', 2600); this.c.audio?.play?.('error'); return null; }
  }
  /** Sell a car of yours back (the server pays half what you paid). Resolves { cars, refund } or null. */
  async sellCar(plate) {
    this.guardMoney();
    try {
      const d = await net.request('carSell', { plate });
      this.setServerMoney(d.money);
      if (d.refund) this.c.hud.setMoney?.(this.c.save.money, d.refund);
      MP.profile.cars = d.cars;
      this.c.audio?.play?.('cash');
      return d;
    } catch (e) {
      if (e.data?.money != null) this.setServerMoney(e.data.money);
      this.c.hud.flash(`Could not sell it · ${errText(e)}`, 'bad', 2600); this.c.audio?.play?.('error');
      return null;
    }
  }
  /** The configurator's plate step: is this plate free? -> { plate, free, mine } (null offline / bad plate). */
  plateCheck(plate) { return net.request('plateCheck', { plate }).catch(() => null); }
  /** A random plate nobody has (the server's), or null. */
  plateIssue() { return net.request('plateIssue').then((d) => d.plate || null, () => null); }
  /** A car of yours gone for good (wrecked by the police): out of your garage on the server. Resolves your garage. */
  carEnded(cfg) {
    const left = (MP.profile?.cars || []).filter((c) => c.plate !== cfg?.plate);
    if (MP.profile) MP.profile.cars = left;
    if (!cfg?.plate) return Promise.resolve(left);
    return net.request('carReturn', { plate: cfg.plate }).then((d) => { if (MP.profile && d?.cars) MP.profile.cars = d.cars; return MP.profile?.cars || left; }, () => left);
  }
  /** The tow truck sets out for your car (carrental.js wrecked: 'wreck'; impound.js tow: 'tow'): the server charges
   *  its fee (CATALOG.wreckFee) and records the tow; home [x, y, z, yaw] is where the car ends (its own bay / impound
   *  bay `bay`). Resolves the server's answer { money, fee, impound, at } or null. */
  async tow(kind, home, bay) {
    this.guardMoney();
    try {
      const d = await net.request('tow', { kind, home, bay });
      this.setServerMoney(d.money);
      if (d.fee) this.c.hud.setMoney?.(this.c.save.money, -d.fee);
      const car = MP.profile?.cars?.[0];
      if (car) { car.at = d.at; if (d.impound) car.impound = d.impound; }
      return d;
    } catch (e) {
      if (e.data?.money != null) this.setServerMoney(e.data.money);
      if (e.code !== 'busy') console.warn('[mp] tow:', e.code || e.message);
      return e.data?.impound ? { impound: e.data.impound } : null;
    }
  }
  /** The truck has unloaded your car: the server's tow record ends. */
  towDone() { net.request('towDone').catch(() => {}); }
  /** THE WERKSTATT (game/werkstatt.js): repair your car (plate) at damage share `damage` (0..1): the server prices it
   *  (the same sum as carrental.js repairCost) and takes the money. Resolves { money, fee } or null (refused).
   *  flat 'clerk': the Autohaus clerk's flat-fee repair (the server's CLERK_REPAIR, carrental.js clerkDialog). */
  async repairCar(damage, plate, flat) {
    this.guardMoney();
    try {
      const d = await net.request('carRepair', flat ? { damage, plate, flat } : { damage, plate });
      this.setServerMoney(d.money);
      if (d.fee) this.c.hud.setMoney?.(this.c.save.money, -d.fee);
      return d;
    } catch (e) {
      if (e.data?.money != null) this.setServerMoney(e.data.money);
      this.c.hud.flash(e.code === 'money' ? `Not enough money for the repair${e.data?.fee ? ` ($${e.data.fee.toLocaleString('en-US')})` : ''}` : e.code === 'busy' ? 'The tow truck has your car' : `Could not repair it · ${errText(e)}`, 'bad', 2600);
      this.c.audio?.play?.('error');
      return null;
    }
  }

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
      // (every race needs at least 2 racers, the countdown runs 45 s once the second is in; alone: raceSolo)
      this.c.hud.flash(`In the race queue · at least ${Math.max(2, d?.need ?? 2)} racers · starts ${Math.round((d?.waitMs || 45000) / 1000)} s after the 2nd joins`, 'good', 3000);
      return true;
    } catch (e) {
      // a full field (21): wait for the next race (joined as soon as the queue has room) or race it alone
      if (e.code === 'race_full' && this.c.hud.dialog) {
        this.c.hud.dialog('Race full', `${e.data?.n ?? 21}/${e.data?.max ?? 21} racers are in. Wait for the next race, or ski it alone.`, [
          { label: 'Wait for the next race', sub: 'joined as soon as there is room', act: () => { this.race.waitNext = race; this.c.lock?.(); } },
          { label: 'Practice race (no prize)', sub: 'free · just you · starts at once', act: () => { this.raceSolo(race); this.c.lock?.(); } },
          { label: 'Not now', secondary: true, act: () => this.c.lock?.() },
        ]);
        return false;
      }
      this.c.hud.flash(errText(e), 'bad', 2400); return false;
    }
  }
  /** A practice race (Oct 30, the user: "you can race alone but you dont earn any money", "call it a practise race"):
   *  just you, at once (the server's 3-2-1 lead), out of any queue; no entry fee, no prize, nothing counted. */
  async raceSolo(race) {
    try {
      const d = await net.request('raceSolo', { race });
      this.race.queued = null; this.race.queue = null; this.race.waitNext = null;
      if (d?.rid != null && d.grid) this.onRaceStart(d); // (the broadcast raceStart may have come first: onRaceStart skips a repeat)
      this.c.hud.flash('Practice race · no prize', 'good', 2400);
      return true;
    } catch (e) { this.c.hud.flash(errText(e), 'bad', 2400); return false; }
  }
  raceLeave() { if (this.race.queued) { net.request('raceLeave').catch(() => {}); this.race.queued = null; this.race.queue = null; } }
  onRaceStart(d) {
    const me = d.grid.find((g) => g.pid === MP.pid);
    if (!me || this.race.start?.rid === d.rid) return; // (a practice race: its answer and its broadcast, once)
    this.race.queued = null; this.race.queue = null;
    this.race.start = { ...d, slot: me.slot, done: new Map(), board: null, got: net.serverNow(), seen: false }; this.race.finished = false; this.race.result = null;
    this.ui?.closeResults();
    this.c.onRaceStart?.({ ...d, slot: me.slot, n: d.grid.length, secondsToGo: () => (d.at - net.serverNow()) / 1000,
      // the race session's multiplayer hooks: the other racers, your finish at the line, the server's result
      mp: { rid: d.rid, field: () => this.raceField(), finish: (r) => this.raceFinished(r), result: () => this.raceResultFor(d.rid) } });
  }
  /** Your finish, sent AT THE LINE (the server checks the time against its own clock, so it must not wait for the
   *  results screen): time = official (penalties included), raw = the clock, pen = the gate penalties (s). The server
   *  ranks everybody and pays the prizes (raceResult). */
  raceFinished({ time, raw, pen, dnf }) {
    const r = this.race.start;
    if (!r || this.race.finished) return 0;
    this.race.finished = true;
    const ms = (v) => (Number.isFinite(v) ? Math.round(v * 1000) : null);
    const out = !!dnf || !Number.isFinite(time);
    const send = () => net.request('raceFinish', { rid: r.rid, time: ms(time), raw: ms(raw), pen: ms(pen) ?? 0, dnf: out });
    // (the line is crossed during a reconnect: sent once the connection is back)
    send().catch((e) => { if (e.code === 'offline' || e.code === 'timeout') net.once('relogin', () => send().catch(() => {})); });
    return 0; // (the prize comes with the server's result)
  }
  onRaceResult(d) {
    const mine = d.order.find((o) => o.pid === MP.pid) || d.order.find((o) => o.name === MP.name);
    if (!mine || this.race.start?.rid !== d.rid) return;
    this.race.start = null;
    this.race.result = { ...d, mine };
    this.ui?.setBoard(null);
    const s = this.c.save.stats;
    if (!d.practice) { // (a practice race counts for nothing)
      s.races = (s.races || 0) + 1;
      if (mine.place === 1 && !mine.dnf) s.wins = (s.wins || 0) + 1;
    }
    // the race's own results screen shows the server's standings (modes/race/session.js asks raceResultFor); only
    // when that session is gone (you left the course) the results card comes up instead
    const sess = window.__game?.modes?.session;
    if (!(sess?.mp && sess.mp.rid === d.rid && !sess.disposed)) {
      const course = window.__game?.modes?.course;
      const title = course?.id === d.race && course.name ? course.name : String(d.race || 'Race').replace(/[-_]/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
      this.ui?.results(title, d.order, mine.pid, d.practice ? 'PRACTICE RACE · NO PRIZE' : '');
    }
    if (d.practice) { this.c.hud.flash(`Practice race · no prize${mine.dnf ? ' · DNF' : Number.isFinite(mine.time) ? ` · ${(mine.time / 1000).toFixed(2)} s` : ''}`, 'good', 4200); return; }
    const ord = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th'}`;
    this.c.hud.flash(`Race over · ${ord(mine.place)} of ${d.order.length}${mine.dnf ? ' · DNF' : ''}${mine.prize ? ` · +$${mine.prize.toLocaleString('en-US')}` : ''}`, mine.place === 1 && !mine.dnf ? 'gold' : 'good', 4200);
  }
  /** The server's final result for race rid ({ rid, race, order, mine }), or null while it runs. */
  raceResultFor(rid) { const r = this.race.result; return r && r.rid === rid ? r : null; }
  /** The other racers as the race session's field: [{ pid, name, gate, s (m along the course), time (s) | null,
   *  dnf, off (connection dropped), finished }]: the server's live board, else (an older server) the finishers and
   *  where the other avatars are. */
  raceField() {
    const r = this.race.start, out = [];
    if (!r) return out;
    const track = window.__game?.modes?.session?.track;
    for (const e of r.grid) {
      if (e.pid === MP.pid || e.name === MP.name) continue;
      const b = r.board?.find((x) => x.pid === e.pid || x.name === e.name), fin = r.done.get(e.pid);
      let s = b && Number.isFinite(b.s) ? b.s : -Infinity;
      // (the avatar's own position is fresher than the board: used while it is connected and racing)
      const p = !b?.off && !(fin || b?.time != null || b?.dnf) ? this.remotes?.players.get(e.pid)?.pos : null;
      if (p && track?.nearestS) { const s2 = track.nearestS(p.x, p.z); if (Number.isFinite(s2) && Math.abs(s2 - s) < 400) s = Math.max(s, s2); else if (!b) s = s2; }
      const time = b?.time != null ? b.time / 1000 : fin && !fin.dnf ? fin.time / 1000 : null;
      out.push({ pid: e.pid, name: e.name, gate: b?.gate ?? 0, s, time, dnf: !!(b?.dnf || fin?.dnf), off: !!b?.off, left: !!b?.left, finished: time != null });
    }
    return out;
  }
  /** (older name, kept for callers) the other racers who have finished, as race-session result rows. */
  raceOthers() {
    return this.raceField().filter((o) => o.finished || o.dnf).map((o) => ({ name: o.name, time: o.dnf ? Infinity : o.time, me: false, kind: 'player', dnf: o.dnf }));
  }
  // Twice a second while you race: your progress to the server (gate index + metres along the course: the live board
  // and, should you drop out, where you got to). The race session's own HUD shows the standings; the overlay board
  // only comes up when you race without it (you left the course).
  // the last 30 s before the race closes (60 s after the first finisher, or its 10 min limit): a big countdown, so you
  // know whether you will make it before it is a DNF (Oct 30, the user)
  closeCountdown(now) {
    const r = this.race.start;
    const end = r ? Math.min(r.closeAt || Infinity, r.endAt || Infinity) : Infinity, left = end - now;
    const show = !!r && now >= r.at && !this.race.finished && left > 0 && left <= 30000;
    if (!show && !this.cdEl) return;
    if (!this.cdEl) {
      const el = document.createElement('div');
      el.id = 'race-close';
      el.style.cssText = 'position:absolute;top:calc(var(--u,1px)*120);left:50%;transform:translateX(-50%);padding:calc(var(--u,1px)*10) calc(var(--u,1px)*34) calc(var(--u,1px)*12);background:#fff;color:#d0342c;clip-path:var(--brush-b);filter:drop-shadow(0 6px 14px rgba(0,20,60,0.3));pointer-events:none;text-align:center;font-family:var(--num);font-style:italic;font-weight:700;z-index:12';
      el.innerHTML = '<div style="font-size:calc(var(--u,1px)*16);letter-spacing:0.08em;color:var(--blue,#1546c8)">FINISH BEFORE THE RACE CLOSES</div><div class="rc-t" style="font-size:calc(var(--u,1px)*58);line-height:1"></div><div style="font-size:calc(var(--u,1px)*15);color:var(--blue-dim,#4f72d4)">or it is a DNF</div>';
      (document.getElementById('hud') || document.body).appendChild(el);
      this.cdEl = el; this.cdT = el.querySelector('.rc-t');
    }
    if (this.cdEl.hidden === show) this.cdEl.hidden = !show;
    if (!show) return;
    const s = Math.ceil(left / 1000), txt = `0:${String(s).padStart(2, '0')}`;
    if (this.cdT.textContent !== txt) this.cdT.textContent = txt;
  }
  updateBoard(dt, now) {
    const r = this.race.start;
    if (!r || now < r.at) { if (this.ui?.lines.board) this.ui.setBoard(null); return; }
    if ((this.boardT += dt) < 0.5) return;
    this.boardT = 0;
    const sess = window.__game?.modes?.session;
    const mine = sess?.mp && sess.mp.rid === r.rid && !sess.disposed ? sess : null;
    // no race session for it (you left it from the pause menu, or it could not start here: another session was on):
    // you are out (DNF), so the server neither waits for you nor keeps you 'in_race' for the next queue
    if (mine) r.seen = true;
    else if (!this.race.finished && (r.seen || now > Math.max(r.at, r.got || 0) + 8000)) this.raceFinished({ dnf: true });
    if (mine && !this.race.finished && Number.isFinite(mine.ps)) net.send('raceProgress', { rid: r.rid, gate: Math.max(0, mine.nextGate | 0), s: Math.round(mine.ps * 10) / 10 });
    if (mine) { if (this.ui?.lines.board) this.ui.setBoard(null); return; }
    const rows = this.raceRows;
    rows.length = 0;
    for (const o of this.raceField()) rows.push({ name: o.name, me: false, time: o.time, dnf: o.dnf, off: o.off, gate: o.gate, s: o.s });
    const me = r.board?.find((x) => x.pid === MP.pid || x.name === MP.name);
    rows.push({ name: `${MP.name} (you)`, me: true, time: me?.time != null ? me.time / 1000 : null, dnf: !!me?.dnf || this.race.finished, gate: me?.gate ?? 0, s: me?.s ?? -Infinity });
    rows.sort((a, b) => (a.dnf - b.dnf) || ((a.time ?? Infinity) - (b.time ?? Infinity)) || (b.gate - a.gate) || (b.s - a.s));
    this.ui?.setBoard(rows);
  }
  raceLine(now) {
    const q = this.race.queue;
    if (this.race.queued && q) {
      if (q.n < Math.max(2, q.need ?? 2) || !q.startAt) return `RACE QUEUE · ${q.n}/${Math.max(2, q.need ?? 2)} · waiting for at least 2 racers`;
      return `RACE QUEUE · ${q.n}/${q.max || 21} racers · starting in ${Math.max(0, Math.ceil((q.startAt - now) / 1000))}s`;
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
    try { this.carRide.frame(dt); this.towMp.frame(dt); this.heliMp.frame(dt); this.rescueMp.frame(dt); this.sledMp.frame(dt); } catch (e) { console.warn('[mp] vehicles', e); }
    try { this.transit.update(); } catch (e) { console.warn('[mp] transit', e); }
    // presence
    this.sendAcc += dt;
    if (this.sendAcc >= 1 / SEND_HZ && net.open) {
      this.sendAcc = 0;
      const p = this.pose;
      p.hold = false;
      this.c.pose(p);
      this.carRide.pose(p); this.heliMp.pose(p); this.sledMp.pose(p); // (driving / flying: the vehicle's pose; riding with someone)
      // inside, the walk speed from the step since the last row (the rooms' avatars walk instead of gliding)
      const L = this.lastPos, now2 = performance.now(), sdt = Math.max(0.02, (now2 - L.t) / 1000);
      if (p.interior && p.interior === L.interior && !p.vx && !p.vz) { p.vx = (p.x - L.x) / sdt; p.vz = (p.z - L.z) / sdt; if (Math.hypot(p.vx, p.vz) > 6) p.vx = p.vz = 0; }
      L.x = p.x; L.z = p.z; L.interior = p.interior; L.t = now2;
      if (p.hold) { /* (a door fading: nothing to tell yet) */ } else if (p.interior !== this.interior) {
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
    this.closeCountdown(now);
    // (Oct 30, the user: "sometimes you get stuck in the race queue") the server's queue doesn't list you (a dropped
    // connection, a server restart, a missed message): not queued here either, after 4 s of that
    if (this.race.queued) {
      const q = MP.queues?.get(this.race.queued), mine = !!q?.names?.includes(MP.name);
      this.queueLost = mine ? 0 : (this.queueLost || 0) + dt;
      if (this.queueLost > 4) { this.queueLost = 0; this.race.queued = null; this.race.queue = null; this.c.hud?.flash?.('You are no longer in the race queue · join again at the start', 'bad', 3200); }
    } else this.queueLost = 0;
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
