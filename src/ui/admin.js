// Admin panel (free ride only): F2 or ` (backquote) opens it, Esc / F2 / ` closes it. Money, time of day and
// weather, teleports to every lift station, peak, race start, the park, the helipad and the ski-bus stops,
// unlock everything, a speed boost, HUD on / off, a free-fly camera, the day pass. Same house style as the
// menus: white brush paper, blue italic condensed lettering, red section labels. Money goes through the save.
import './admin.css';
import * as THREE from 'three';
import { brushSVG, brushClip, esc } from './menu.js';
import { SKIS } from '../game/economy.js';
import { OUTFIT_ITEMS, OUTFIT_KITS, ensureOutfits } from '../game/outfits.js';
import { WEATHER } from '../world/sky.js';
import { world } from '../world/world.js';
import { isMP, MP } from '../net/mode.js';
import { loadAccount } from '../net/session.js';

// (Oct 30, the user: "remove the admin panel for everyone, single player too, except for the player Rafael"): only the
// account named Rafael opens it (multiplayer: the name you're logged in with; single player: this computer's saved
// multiplayer account); for everybody else F2 / ` does nothing at all (no message)
const ADMINS = new Set(['rafael']);
export function isAdmin() {
  let name = isMP() ? MP.name : null;
  if (!name) { try { name = loadAccount()?.name || null; } catch { name = null; } }
  return !!name && ADMINS.has(String(name).trim().toLowerCase());
}

const OPEN_KEYS = new Set(['F2', 'Backquote']);
const FLY_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'KeyC', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight', 'KeyT', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
const WEATHERS = Object.keys(WEATHER || { clear: 1, cloudy: 1, light: 1, heavy: 1, mist: 1 });
const BOOST = { speed: 1.6, grip: 1.25 };
const money = (v) => `$${Math.round(v || 0).toLocaleString('en-US')}`;
const hhmm = (h) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`;
const _e = new THREE.Euler(0, 0, 0, 'YXZ');

function container(id) {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('div');
    el.id = id;
    el.hidden = true;
    document.body.appendChild(el);
  }
  return el;
}

export class AdminPanel {
  /**
   * @param {object} o
   * @param {object} o.save  @param {() => void} o.writeSave
   * @param {object} o.hud   setMoney, flash, setBlocking
   * @param {object} [o.audio]
   * @param {object} o.env   hour, setWeather, weather
   * @param {object} o.layout  lifts, peaks, races, park
   * @param {object} o.input   lock(), keys, mdx / mdy
   * @param {THREE.PerspectiveCamera} o.camera  the world camera (free-fly moves it)
   * @param {object} [o.transition]  fade() for teleports
   * @param {(x: number, z: number) => Promise} [o.streamAround]
   * @param {(id: string) => void} [o.equipSkis]
   * @param {object} o.ctx  live getters: player, modes, races, interior, heli, lifts, skibus, jobs, started, paused
   */
  constructor(o) {
    Object.assign(this, o);
    this.el = container('admin');
    this.isOpen = false;
    this.boost = false;
    this.hudOff = false;
    this.fly = null;
    this.streamPos = null; // set while flying: main.js streams the world around the free camera
    this.baseSki = null;
    addEventListener('keydown', (e) => this.onKey(e), true);
    document.addEventListener('pointerlockchange', () => {
      // Esc while flying releases the pointer: back to the panel
      if (this.fly && !document.pointerLockElement) { this.stopFly(); this.open(true); }
    });
  }

  // ------------------------------------------------------------------ open / close
  /** Why the panel can't open right now (null = it can). */
  refusal() {
    const c = this.ctx;
    if (!isAdmin()) return 'menu'; // (not an admin: silently nothing)
    if (!c.started || c.paused || this.transition?.active) return 'menu';
    if (c.modes?.active || c.races?.active) return 'Admin panel · free ride only';
    if (c.interior?.active) return 'Admin panel · not inside the shop';
    if (window.__game?.prison?.active) return 'Admin panel · not while in prison';
    if (window.__game?.prison?.inside) return 'Admin panel · not inside the prison';
    if (c.heli?.active || c.heli?.state === 'boarding') return 'Admin panel · not while flying the helicopter';
    if (this.hud.panelOpen && !this.isOpen) return 'menu';
    if (document.getElementById('map') && !document.getElementById('map').hidden) return 'menu';
    return null;
  }

  toggle() {
    if (this.isOpen) return this.close();
    if (this.fly) { this.stopFly(); return this.close(); }
    const why = this.refusal();
    if (why) { if (why !== 'menu') { this.hud.flash(why, 'bad', 2200); this.audio?.play('error'); } return false; }
    return this.open();
  }

  open(fromFly = false) {
    if (this.isOpen) return true;
    if (!fromFly && this.refusal()) return false;
    this.isOpen = true;
    this.hud.setBlocking('admin', true); // before the pointer is released: no pause menu, no gameplay input
    document.body.classList.add('admin-open');
    document.exitPointerLock?.();
    this.render();
    this.el.hidden = false;
    this.el.classList.remove('out');
    this.audio?.play('click');
    clearInterval(this.tick);
    this.tick = setInterval(() => this.refreshLive(), 250);
    return true;
  }

  close(relock = true) {
    if (!this.isOpen) return;
    this.isOpen = false;
    clearInterval(this.tick);
    this.el.classList.add('out');
    clearTimeout(this.hideT);
    this.hideT = setTimeout(() => { if (!this.isOpen) { this.el.hidden = true; this.el.innerHTML = ''; } }, 220);
    this.hud.setBlocking('admin', false);
    document.body.classList.remove('admin-open');
    if (relock) this.input.lock();
  }

  onKey(e) {
    if (OPEN_KEYS.has(e.code)) {
      if (e.repeat) return;
      if (document.activeElement?.tagName === 'INPUT' && e.code === 'Backquote' && document.activeElement.type !== 'range') return; // typing
      e.preventDefault(); e.stopPropagation();
      this.toggle();
      return;
    }
    if (this.isOpen && e.code === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(); return; }
    if (this.isOpen && e.code === 'Enter' && document.activeElement?.classList.contains('ad-amount')) { e.preventDefault(); this.setMoney(); return; }
    if (this.fly && FLY_KEYS.has(e.code)) {
      if (e.code === 'KeyT' && !e.repeat) this.dropHere();
      e.preventDefault(); // the game itself is blocked while flying (hud blocker): these keys only fly
    }
  }

  // ------------------------------------------------------------------ actions
  addMoney(n) {
    const s = this.save;
    s.money = Math.max(0, Math.round(s.money + n));
    this.hud.setMoney(s.money, n);
    this.writeSave();
    this.audio?.play('cash');
    this.refreshLive();
  }

  setMoney() {
    const inp = this.el.querySelector('.ad-amount');
    const v = Math.floor(Number(String(inp?.value || '').replace(/[^0-9.]/g, '')));
    if (!Number.isFinite(v)) { this.audio?.play('error'); return; }
    const s = this.save, d = Math.min(99999999, Math.max(0, v)) - s.money;
    s.money += d;
    this.hud.setMoney(s.money, d);
    this.writeSave();
    this.audio?.play('cash');
    if (inp) inp.value = '';
    this.refreshLive();
  }

  setHour(h) {
    this.env.hour = ((h % 24) + 24) % 24;
    this.save.hour = this.env.hour;
    this.writeSave();
  }

  setWeather(w) {
    this.env.setWeather(w);
    this.env.weatherTimer = 300; // hold it a while before the weather moves on by itself
    this.render(false);
  }

  unlockSkis() {
    const s = this.save;
    for (const k of SKIS) if (!s.owned.includes(k.id)) s.owned.push(k.id);
    this.writeSave();
    // no skis yet: put on the best pair so you can head straight out
    if (!s.skis && this.equipSkis) this.equipSkis(SKIS[SKIS.length - 1].id);
    this.hud.flash('All skis unlocked', 'gold', 2000);
    this.audio?.play('cash');
    this.render(false);
  }

  unlockOutfits() {
    const o = ensureOutfits(this.save);
    for (const id of [...OUTFIT_ITEMS.map((i) => i.id), ...OUTFIT_KITS.map((k) => k.id)]) if (!o.owned.includes(id)) o.owned.push(id);
    this.writeSave();
    this.hud.flash('All outfits unlocked', 'gold', 2000);
    this.audio?.play('cash');
    this.render(false);
  }

  givePass() {
    this.save.dayPass = this.save.day;
    this.writeSave();
    this.hud.flash('Day pass active', 'gold', 2000);
    this.render(false);
  }

  resetPass() {
    this.save.dayPass = -1;
    this.save.tickets = 0;
    this.writeSave();
    this.hud.flash('Day pass and tickets reset', 'good', 2000);
    this.render(false);
  }

  setBoost(on) {
    this.boost = !!on;
    if (!on) this.restoreSki();
    this.render(false);
  }

  setHud(off) {
    this.hudOff = !!off;
    document.body.classList.toggle('admin-hide-hud', this.hudOff);
    this.render(false);
  }

  // ski physics multipliers while the boost is on (free ride only; equipping new skis keeps it on)
  applyBoost() {
    const p = this.ctx.player;
    if (!p?.ski) return;
    const racing = this.ctx.modes?.active || this.ctx.races?.active;
    // (never in multiplayer: a boost switched on in free ride used to stay on after joining a world, 1.6x speed)
    if (this.boost && !racing && !isMP()) {
      if (!p.ski._boost) {
        this.baseSki = p.ski;
        p.ski = { ...p.ski, speed: (p.ski.speed || 1) * BOOST.speed, grip: (p.ski.grip || 1) * BOOST.grip, _boost: true };
      }
    } else this.restoreSki();
  }

  restoreSki() {
    const p = this.ctx.player;
    if (p?.ski?._boost) p.ski = this.baseSki || { speed: 1, grip: 1 };
    this.baseSki = null;
  }

  // ------------------------------------------------------------------ spawn a car
  // a random car of the fleet (carrental.js spawnFree: free, drivable like a rental) parked just beside you, facing
  // the way you face: in front, at either side, behind (then a bit further out), wherever its whole footprint is clear
  // ground (no building, tree, car or you in it) and fairly level
  spawnCar() {
    const c = this.ctx, pl = c.player, rental = c.carRental, drive = c.drive;
    const fail = (m) => { this.hud.flash(m, 'bad', 2200); this.audio?.play('error'); };
    if (!pl || !rental?.spawnFree) return fail('No cars available');
    if (drive?.active || c.sleds?.active || c.heli?.active || pl.mode === 'sit' || pl.mode === 'fall') return fail('Get out first');
    if (rental.inside || c.chalets?.inside) return fail('Not indoors');
    const yaw = pl.heading || 0, fx = Math.sin(yaw), fz = Math.cos(yaw), rx = -fz, rz = fx;
    const HL = 2.65, HW = 1.05; // (the longest car, 5.2 m, with a margin)
    const px = pl.pos.x, pz = pl.pos.z, py = pl.pos.y;
    const ok = (x, z) => {
      if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
      // not on you
      const dx = px - x, dz = pz - z;
      if (Math.abs(dx * rx + dz * rz) < HW + 0.7 && Math.abs(dx * fx + dz * fz) < HL + 0.7) return false;
      const hs = [];
      for (const a of [-1, 0, 1]) for (const b of [-1, -0.5, 0, 0.5, 1]) {
        const sx = x + rx * a * HW + fx * b * HL, sz = z + rz * a * HW + fz * b * HL;
        if (drive?.clearAt && !drive.clearAt(sx, sz, 0.3)) return false;
        hs.push(world.groundHeight(sx, sz, py + 1.5));
      }
      return Math.max(...hs) - Math.min(...hs) < 1.4;
    };
    const cands = [];
    for (const k of [1, 1.8, 2.8]) {
      cands.push([px + fx * (HL + 1.2) * k, pz + fz * (HL + 1.2) * k]); // in front
      cands.push([px + rx * (HW + 1.4) * k + fx * 0.5, pz + rz * (HW + 1.4) * k + fz * 0.5]); // beside, right
      cands.push([px - rx * (HW + 1.4) * k + fx * 0.5, pz - rz * (HW + 1.4) * k + fz * 0.5]); // beside, left
      cands.push([px - fx * (HL + 1.2) * k, pz - fz * (HL + 1.2) * k]); // behind
    }
    const spot = cands.find(([x, z]) => ok(x, z));
    if (!spot) return fail('No room for a car here');
    const [x, z] = spot;
    const e = rental.spawnFree({ x, z, yaw, y: world.groundHeight(x, z, py + 1.5) });
    if (!e) return fail('No cars available');
    this.close(true);
    this.hud.flash(`${e.label || 'Car'} · walk up and press E to drive`, 'good', 2600);
  }

  // ------------------------------------------------------------------ teleports
  /** Every place you can jump to: { group, label, sub, x, z, heading, skis }. */
  places() {
    const out = [], L = this.layout, c = this.ctx;
    const downhill = (x, z, fallback) => {
      const [gx, gz] = world.gradient(x, z);
      return Math.hypot(gx, gz) > 0.03 ? Math.atan2(-gx, -gz) : fallback;
    };
    const add = (group, label, sub, x, z, heading, skis) => { if (Number.isFinite(x) && Number.isFinite(z)) out.push({ group, label, sub, x, z, heading, skis }); };
    add('VILLAGE', 'Legacy Village', 'The plaza', 4, 34, Math.PI, false);
    // lift stations: where riders step off, facing downhill (lifts.js uses the same spot)
    for (const line of c.lifts?.lines || []) {
      const s = line.spec;
      if (!s?.bottom || !s?.top || !line.dir) continue;
      for (const top of [false, true]) {
        const end = top ? s.top : s.bottom;
        const d = line.dir.clone().multiplyScalar(top ? 1 : -1);
        const k = (line.cfg?.stationSize || 12) * 0.5 + 9;
        const sv = line.sideV || { x: 0, z: 0 };
        const x = end.x + d.x * k + sv.x * 4, z = end.z + d.z * k + sv.z * 4;
        add('LIFTS', s.name, top ? (s.topName ? `Top · ${s.topName}` : 'Top station') : (s.bottomName ? `Base · ${s.bottomName}` : 'Base station'), x, z, downhill(x, z, Math.atan2(d.x, d.z)), top);
      }
    }
    // peaks: the summit restaurant terrace, on the side of the top station
    for (const pk of L.peaks || []) {
      const h = pk.hut, t = pk.lift?.top;
      if (!h) continue;
      let x = h.x, z = h.z;
      if (t) { const dx = t.x - h.x, dz = t.z - h.z, l = Math.hypot(dx, dz) || 1; x += (dx / l) * 13; z += (dz / l) * 13; } else x += 13;
      add('PEAKS', `${pk.name}`, h.name || 'Summit', x, z, downhill(x, z, 0), false); // flat terrace: skis on your shoulder
    }
    // open-world race starts, facing down the course
    for (const r of L.races || []) {
      if (!r.start) continue;
      const nx = r.path?.[3] || r.path?.[1];
      const head = nx ? Math.atan2(nx[0] - r.start.x, nx[1] - r.start.z) : downhill(r.start.x, r.start.z, 0);
      add('RACES', r.name, `${r.D?.label || ''}${r.reward ? ` · $${r.reward.toLocaleString('en-US')}` : ''}`, r.start.x, r.start.z, head, true);
    }
    // the park drop-in
    const pk = L.park;
    if (pk?.drop) add('PARK & HELI', 'Legacy Park', 'Drop-in', pk.drop.x, pk.drop.z, downhill(pk.drop.x, pk.drop.z, pk.heading ?? 0), true);
    // the heli-ski hut at the helipad
    const pad = c.heli?.pad;
    if (pad?.hut?.door) {
      const f = pad.hut.front || { x: 0, z: 1 };
      const x = pad.hut.door.x + f.x * 1.8, z = pad.hut.door.z + f.z * 1.8;
      add('PARK & HELI', 'Helipad', 'Heli-ski hut', x, z, Math.atan2(pad.x - x, pad.z - z), false);
    }
    // the secret places, found or not (this is the admin panel): at the way in, facing in
    for (const d of c.secrets?.defs || []) {
      const p0 = d.pts?.[0], p1 = d.pts?.[1];
      const x = p0 ? p0[0] : d.center?.x, z = p0 ? p0[1] : d.center?.z;
      const head = p0 && p1 ? Math.atan2(p1[0] - p0[0], p1[1] - p0[1]) : downhill(x, z, 0);
      add('SECRETS', d.name, c.secrets.isFound?.(d.id) ? 'Found' : 'Not found yet', x, z, head, true);
    }
    // the Wolkenspitzbahn's stations: on the platform (the top station's way out onto the glacier terrace)
    for (const st of c.railway?.stations?.list || []) {
      const p = st.exit || st.board;
      if (!p) continue;
      add('RAILWAY', st.name, `Wolkenspitzbahn${Number.isFinite(st.alt) ? ` · ${st.alt} m` : ''}`, p.x, p.z, p.heading ?? downhill(p.x, p.z, 0), false);
    }
    // ski-bus stops: off the bus in front of the shelter
    for (const s of c.skibus?.stops || []) {
      const x = s.x + Math.sin(s.heading) * 2.5, z = s.z + Math.cos(s.heading) * 2.5;
      add('SKI BUS', s.name, 'Bus stop', x, z, s.heading, false);
    }
    return out;
  }

  async teleport(p) {
    this.close(true); // locks the pointer again inside the click
    const c = this.ctx, pl = c.player, hw = c.hospitalWard;
    if (hw?.role === 'patient') { this.hud.flash('Not while you are in the hospital bed', 'bad', 2600); return; } // (Oct 30, the user)
    const go = async () => {
      if (pl.mode === 'sit') { // riding a lift: step off first
        if (c.lifts) { c.lifts.ride = null; c.lifts.timeScale = 1; }
        pl.seat = null; pl.mode = 'walk';
        pl.rig.setSkisVisible(pl.hasSkis);
        if (pl.viewBeforeRide) { pl.view = pl.viewBeforeRide; pl.viewBeforeRide = null; }
      }
      c.jobs?.onEvent?.('teleport'); // a running delivery / rescue ends when you jump away
      if (hw?.inside) hw.reset(); // (visiting the medical centre: out of its scene)
      pl.frozen = false;
      if (!p.skis) pl.setSkisOn(false);
      pl.teleport(p.x, p.z, p.heading);
      if (p.skis && pl.hasSkis) pl.setSkisOn(true);
      await this.streamAround?.(p.x, p.z);
    };
    if (this.transition?.fade) await this.transition.fade(go); else await go();
    this.hud.flash(`${p.label}${p.sub && p.group !== 'RACES' ? ` · ${p.sub}` : ''}`, 'good', 2200);
  }

  // ------------------------------------------------------------------ free-fly camera
  startFly() {
    const cam = this.camera;
    _e.setFromQuaternion(cam.quaternion, 'YXZ');
    this.fly = { pos: cam.position.clone(), yaw: _e.y, pitch: _e.x, fov: cam.fov, speed: 14 };
    this.streamPos = this.fly.pos;
    this.close(false);
    this.hud.setBlocking('freecam', true); // gameplay ignores the keys; we read them raw
    this.input.lock();
    document.body.classList.add('admin-flying');
    this.flyHint(true);
  }

  stopFly() {
    if (!this.fly) return;
    this.fly = null;
    this.streamPos = null;
    this.hud.setBlocking('freecam', false);
    document.body.classList.remove('admin-flying');
    this.flyHint(false);
  }

  // T while flying: drop the skier on the snow under the camera
  dropHere() {
    const f = this.fly;
    if (!f) return;
    const pl = this.ctx.player, x = f.pos.x, z = f.pos.z, head = f.yaw + Math.PI;
    this.stopFly();
    if (pl.mode === 'sit') return;
    if (this.ctx.hospitalWard?.inside) { this.hud.flash(this.ctx.hospitalWard.role === 'patient' ? 'Not while you are in the hospital bed' : 'Leave the medical centre first', 'bad', 2600); return; }
    this.ctx.jobs?.onEvent?.('teleport');
    pl.frozen = false;
    pl.teleport(x, z, head);
    if (pl.hasSkis && !pl.isFlatHere?.()) pl.setSkisOn(true);
    this.hud.flash('Dropped here', 'good', 1600);
  }

  flyHint(on) {
    let el = document.getElementById('admin-fly');
    if (!on) { if (el) el.hidden = true; return; }
    if (!el) { el = document.createElement('div'); el.id = 'admin-fly'; document.body.appendChild(el); }
    const k = (t) => `<i class="kc${t.length > 1 ? ' kc-word' : ''}">${t}</i>`;
    el.innerHTML = `<div class="ad-fly paper" style="--clip:${brushClip(77, 4, 3)}"><b>FREE CAMERA</b>
      <span>${k('W')}${k('A')}${k('S')}${k('D')} fly</span><span>${k('SPACE')} / ${k('C')} up · down</span><span>${k('SHIFT')} fast</span>
      <span>${k('T')} drop here</span><span>${k('ESC')} back</span></div>`;
    el.hidden = false;
  }

  /** Every frame (after the player has placed the camera): boost + free-fly camera. */
  update(dt) {
    this.applyBoost();
    const f = this.fly;
    if (!f) return;
    // a race, the shop or the helicopter took over: stop flying
    const c = this.ctx;
    if (c.modes?.active || c.races?.active || c.interior?.active || c.heli?.active || !c.started) { this.stopFly(); return; }
    const inp = this.input, K = inp.keys, sens = 0.0022 * (this.save.sensitivity || 1);
    f.yaw -= inp.mdx * sens;
    f.pitch = Math.max(-1.5, Math.min(1.5, f.pitch - inp.mdy * sens));
    const fw = (K.has('KeyW') || K.has('ArrowUp') ? 1 : 0) - (K.has('KeyS') || K.has('ArrowDown') ? 1 : 0);
    const st = (K.has('KeyD') || K.has('ArrowRight') ? 1 : 0) - (K.has('KeyA') || K.has('ArrowLeft') ? 1 : 0);
    const up = (K.has('Space') || K.has('KeyE') ? 1 : 0) - (K.has('KeyC') || K.has('KeyQ') ? 1 : 0);
    const fast = K.has('ShiftLeft') || K.has('ShiftRight') ? 6 : 1;
    if (inp.wheel) f.speed = Math.max(3, Math.min(120, f.speed * (inp.wheel < 0 ? 1.2 : 1 / 1.2)));
    const cy = Math.cos(f.yaw), sy = Math.sin(f.yaw), cp = Math.cos(f.pitch), sp = Math.sin(f.pitch);
    // camera looks down -Z: forward = (-sin yaw cos pitch, sin pitch, -cos yaw cos pitch)
    const v = f.speed * fast * dt;
    f.pos.x += (-sy * cp * fw + cy * st) * v;
    f.pos.y += (sp * fw + up) * v;
    f.pos.z += (-cy * cp * fw - sy * st) * v;
    const ground = world.height(f.pos.x, f.pos.z) + 1.2;
    if (f.pos.y < ground) f.pos.y = ground;
    const cam = this.camera;
    cam.position.copy(f.pos);
    cam.quaternion.setFromEuler(_e.set(f.pitch, f.yaw, 0, 'YXZ'));
    cam.fov = 65;
    cam.updateProjectionMatrix();
  }

  // ------------------------------------------------------------------ UI
  refreshLive() {
    if (!this.isOpen) return;
    const m = this.el.querySelector('[data-live="money"]');
    if (m) m.textContent = money(this.save.money);
    const t = this.el.querySelector('[data-live="time"]');
    if (t) t.textContent = hhmm(this.env.hour);
    const r = this.el.querySelector('.ad-hour');
    if (r && document.activeElement !== r) r.value = this.env.hour.toFixed(2);
  }

  render(anim = true) {
    const s = this.save, env = this.env;
    const ownsAllSkis = SKIS.every((k) => s.owned.includes(k.id));
    const o = ensureOutfits(s);
    const ownsAllOutfits = [...OUTFIT_ITEMS, ...OUTFIT_KITS].every((i) => o.owned.includes(i.id));
    const pass = s.dayPass === s.day;
    const seg = (items) => `<div class="seg">${items.map(([label, act, on]) => `<button tabindex="-1" data-act="${act}" class="${on ? 'on' : ''}">${esc(label)}</button>`).join('')}</div>`;
    const places = this.places();
    let group = '';
    const rows = places.map((p, i) => {
      const head = p.group !== group ? `<div class="ad-group">${esc((group = p.group))}</div>` : '';
      return `${head}<button class="ad-place" tabindex="-1" data-tp="${i}"><span class="ad-pl-name">${esc(p.label)}</span><span class="ad-pl-sub">${esc(p.sub || '')}</span></button>`;
    }).join('');
    this.placeList = places;
    const title = 'ADMIN', w = 300;
    this.el.className = anim ? 'in' : '';
    this.el.innerHTML = `<div class="ad-shade"></div>
      <div class="ad-wrap">
        <div class="ad-col">
          <div class="menu-head">
            <div class="menu-title" style="width:calc(var(--u) * ${Math.round(w * 0.9)})">${brushSVG(41, w, 100)}<span>${title}</span></div>
            <div class="menu-sub ad-sub">Free ride tools <i class="ch-dot"></i> <i class="kc">F2</i> or <i class="kc">\`</i> or <i class="kc kc-word">ESC</i> to close</div>
          </div>
          <div class="menu-panel ad-panel" style="--clip:${brushClip(171, 5, 4)}">
            <div class="mp-head">MONEY</div>
            <div class="mp-row"><span>Balance</span><b data-live="money">${money(s.money)}</b></div>
            <div class="mp-row"><span>Add</span>${seg([['+1,000', 'm1k'], ['+10,000', 'm10k'], ['+100,000', 'm100k']])}</div>
            <div class="mp-row"><span>Set to</span><span class="ad-set"><input class="ad-amount" type="text" inputmode="numeric" placeholder="${s.money}" spellcheck="false"><button class="ad-btn" data-act="mset" tabindex="-1">SET</button></span></div>
          </div>
          <div class="menu-panel ad-panel" style="--clip:${brushClip(172, 5, 4)}">
            <div class="mp-head">TIME &amp; WEATHER</div>
            <div class="mp-row"><span>Time <b class="ad-time" data-live="time">${hhmm(env.hour)}</b></span><input class="ad-hour" type="range" min="0" max="23.99" step="0.05" value="${env.hour.toFixed(2)}"></div>
            <div class="mp-row"><span>Jump to</span>${seg([['Dawn', 'h:7'], ['Noon', 'h:12'], ['Dusk', 'h:17.6'], ['Night', 'h:22']])}</div>
            <div class="mp-row ad-wx"><span>Weather</span>${seg(WEATHERS.map((k) => [WEATHER?.[k]?.label || k, `w:${k}`, env.weather === k]))}</div>
          </div>
          <div class="menu-panel ad-panel" style="--clip:${brushClip(173, 5, 4)}">
            <div class="mp-head">PLAYER</div>
            <div class="mp-row"><span>Speed boost</span>${seg([['Off', 'boost:0', !this.boost], ['On', 'boost:1', this.boost]])}</div>
            <div class="mp-row"><span>HUD</span>${seg([['Shown', 'hud:0', !this.hudOff], ['Hidden', 'hud:1', this.hudOff]])}</div>
            <div class="mp-row"><span>Free camera</span><button class="ad-btn" data-act="fly" tabindex="-1">FLY</button></div>
            <div class="mp-row"><span>Snowmobile</span><button class="ad-btn" data-act="sled" tabindex="-1">SPAWN HERE</button></div>
            <div class="mp-row"><span>Car</span><button class="ad-btn" data-act="car" tabindex="-1">SPAWN CAR</button></div>
            <div class="mp-row"><span>Helicopter</span><button class="ad-btn" data-act="heli" tabindex="-1">SPAWN HERE</button></div>
            <div class="mp-row"><span>Unlock</span>${seg([['All skis', 'skis', ownsAllSkis], ['All outfits', 'outfits', ownsAllOutfits]])}</div>
            <div class="mp-row"><span>Day pass</span>${seg([[pass ? 'Active' : 'Give pass', 'pass', pass], ['Reset pass & tickets', 'unpass']])}</div>
          </div>
        </div>
        <div class="ad-col ad-right">
          <div class="menu-panel ad-panel ad-tp" style="--clip:${brushClip(174, 5, 4)}">
            <div class="mp-head">TELEPORT</div>
            <div class="ad-list">${rows}</div>
          </div>
        </div>
      </div>`;
    this.bind();
  }

  bind() {
    const el = this.el;
    el.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => this.act(b.dataset.act)));
    el.querySelectorAll('[data-tp]').forEach((b) => b.addEventListener('click', () => this.teleport(this.placeList[+b.dataset.tp])));
    const hr = el.querySelector('.ad-hour');
    hr?.addEventListener('input', () => { this.setHour(parseFloat(hr.value)); this.refreshLive(); });
    // clicks on buttons don't steal focus from the game (keys keep working)
    el.addEventListener('mousedown', (e) => { if (e.target.closest?.('button')) e.preventDefault(); });
  }

  act(a) {
    this.audio?.play('click');
    if (a === 'm1k') return this.addMoney(1000);
    if (a === 'm10k') return this.addMoney(10000);
    if (a === 'm100k') return this.addMoney(100000);
    if (a === 'mset') return this.setMoney();
    if (a.startsWith('h:')) { this.setHour(parseFloat(a.slice(2))); return this.refreshLive(); }
    if (a.startsWith('w:')) return this.setWeather(a.slice(2));
    if (a.startsWith('boost:')) return this.setBoost(a.endsWith('1'));
    if (a.startsWith('hud:')) return this.setHud(a.endsWith('1'));
    if (a === 'fly') return this.startFly();
    if (a === 'sled') return this.ctx.sleds?.spawnNear?.(this.ctx.player);
    if (a === 'car') return this.spawnCar();
    if (a === 'heli') { if (this.ctx.heli?.spawnNear?.(this.ctx.player) === false) this.hud?.flash?.('The helicopter is busy right now', 'bad', 2000); return; }
    if (a === 'skis') return this.unlockSkis();
    if (a === 'outfits') return this.unlockOutfits();
    if (a === 'pass') return this.givePass();
    if (a === 'unpass') return this.resetPass();
  }
}
