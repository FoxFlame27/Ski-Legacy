// "Admin · new" (Oct 31 2026, the user: "can you add an admin panel, 'new', only for Icey27"). F10 or Ctrl+Shift+A
// opens it, Esc / F10 / Ctrl+Shift+A closes it; for anyone but the account Icey27 the keys do nothing at all.
// Multiplayer (the old panel "reverted immediately": the server owns money, the clock, prison, the police, the tow
// yard): every action is an 'admin' request the SERVER checks against your login (server.js adminOp / adminNew:
// Icey27 only, else 'forbidden'; rate-limited; every action in its log), and the server applies it to its own records
// and tells whoever it concerns ('money', 'clock', 'adminTp', 'adminRelease', 'adminNote', 'adminMsg'), so nothing
// reverts. Single player: only when this computer's saved account (net/session.js loadAccount) is Icey27, and only on
// your own game (money, time and weather, teleports, out of prison / the chase / the tow yard).
// Players (name, money, where; go to them, bring them), money for anyone by name (online or not), time and weather,
// kick, out of prison / chase over / car out of the tow yard, reset a player's progress (typed confirm), a server
// message banner for everyone, teleports to the village, the chalet village, the Autohaus, the medical centre, the
// police station and every gondola's summit. It never spawns a car or a helicopter (Oct 30, the user: "remove all
// admin spawned cars").
import './admin.css';
import './adminnew.css';
import { brushSVG, brushClip, esc } from './menu.js';
import { WEATHER } from '../world/sky.js';
import { world } from '../world/world.js';
import { layout } from '../world/layout.js';
import { busRoads } from '../game/bus/roads.js';
import { CHALET_PLACE } from '../game/bus/chaletroad.js';
import { isMP, MP } from '../net/mode.js';
import { net } from '../net/client.js';
import { loadAccount } from '../net/session.js';

const ADMIN_NAME = 'icey27'; // (the name key; the server's ADMIN_KEYS is what counts in multiplayer)
const WEATHERS = Object.keys(WEATHER || { clear: 1, cloudy: 1, light: 1, heavy: 1, mist: 1 });
const money = (v) => `${v < 0 ? '-' : ''}$${Math.abs(Math.round(v || 0)).toLocaleString('en-US')}`;
const hhmm = (h) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`;
const ERR = {
  forbidden: 'not allowed (Icey27 only)', rate: 'too fast, wait a moment', no_player: 'no player by that name', not_online: 'not online',
  self: 'not on yourself', other_world: 'in another world', no_position: 'no position yet', inside: 'inside a building', bad_amount: 'bad amount',
  bad_value: 'bad value', confirm: 'type the name again to confirm', bad_op: 'the server needs an update', unknown_type: 'the server needs an update',
};

/** True when this game is Icey27's: logged in as Icey27 (multiplayer) or this computer's saved account (single player). */
export function isAdminNew() {
  let name = isMP() ? MP.name : null;
  if (!name) { try { name = loadAccount()?.name || null; } catch { name = null; } }
  return !!name && String(name).trim().toLowerCase() === ADMIN_NAME;
}

function container(id) {
  let el = document.getElementById(id);
  if (!el) { el = document.createElement('div'); el.id = id; el.hidden = true; document.body.appendChild(el); }
  return el;
}

/** A server message across the top of the screen for a few seconds (everyone gets it: 'adminMsg'). */
export function adminBanner(text, from = '') {
  const el = container('admin-banner');
  el.innerHTML = `<div class="anb paper" style="--clip:${brushClip(5303, 4, 3)}"><b>SERVER MESSAGE${from ? ` · ${esc(from)}` : ''}</b><span>${esc(text)}</span></div>`;
  el.hidden = false;
  el.classList.remove('out'); void el.offsetWidth; el.classList.add('in');
  clearTimeout(adminBanner.t);
  adminBanner.t = setTimeout(() => { el.classList.add('out'); setTimeout(() => { if (el.classList.contains('out')) el.hidden = true; }, 400); }, 8000);
}

export class AdminNew {
  /**
   * @param {object} o  save, writeSave, hud (flash, setMoney, setBlocking), audio, env (hour, setWeather), input (lock),
   *   transition, ctx: live getters (started, paused, player, lifts, admin: the old panel, whose teleport() is reused)
   */
  constructor(o) {
    Object.assign(this, o);
    this.el = container('adminnew');
    this.isOpen = false;
    this.players = [];
    this.result = '';
    this.target = '';
    this.confirming = false;
    addEventListener('keydown', (e) => this.onKey(e), true);
    addEventListener('ski-admin', (e) => this.onServer(e.detail || {})); // (net/session.js: what the server sends)
  }

  // ------------------------------------------------------------------ open / close
  onKey(e) {
    const hit = e.code === 'F10' || (e.code === 'KeyA' && e.ctrlKey && e.shiftKey);
    if (hit) {
      if (!isAdminNew()) return; // (anyone else: nothing at all)
      e.preventDefault(); e.stopPropagation();
      if (!e.repeat) this.toggle();
      return;
    }
    if (!this.isOpen) return;
    if (e.code === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(); return; }
    if (e.code === 'Enter' && document.activeElement?.dataset?.enter) { e.preventDefault(); this.act(document.activeElement.dataset.enter); }
  }
  toggle() {
    if (this.isOpen) return this.close();
    const c = this.ctx;
    if (!c.started || c.paused || this.transition?.active || (this.hud.panelOpen && !this.isOpen)) return false;
    return this.open();
  }
  open() {
    if (this.isOpen || !isAdminNew()) return false;
    this.isOpen = true;
    this.hud.setBlocking('adminnew', true);
    document.body.classList.add('admin-open');
    document.exitPointerLock?.();
    this.confirming = false;
    this.render(true);
    this.el.hidden = false;
    this.el.classList.remove('out');
    this.audio?.play('click');
    clearInterval(this.tick);
    this.tick = setInterval(() => this.live(), 250);
    this.refreshPlayers();
    return true;
  }
  close(relock = true) {
    if (!this.isOpen) return;
    this.isOpen = false;
    clearInterval(this.tick);
    this.el.classList.add('out');
    clearTimeout(this.hideT);
    this.hideT = setTimeout(() => { if (!this.isOpen) { this.el.hidden = true; this.el.innerHTML = ''; } }, 220);
    this.hud.setBlocking('adminnew', false);
    document.body.classList.remove('admin-open');
    if (relock) this.input.lock();
  }

  // ------------------------------------------------------------------ the server
  /** An admin request (multiplayer): the server's answer, or null (refused: the reason shows in the panel). */
  async op(op, data = {}) {
    const m = window.__game?.multiplayer;
    if (!isMP() || !m) { this.say('Not connected', true); return null; }
    try {
      const d = await net.request('admin', { op, ...data });
      if (d?.clock && m) m.clock = d.clock;
      return d || {};
    } catch (e) {
      this.say(`${op} · ${ERR[e?.code] || e?.code || e?.message || 'refused'}`, true);
      return null;
    }
  }
  /** What the server sends this player (net/session.js passes it on): banners, notes, releases. */
  onServer({ t, d = {}, mp }) {
    if (t === 'adminMsg') { adminBanner(String(d.text || ''), d.from); this.audio?.play('board'); return; }
    if (t === 'adminNote') {
      this.hud.flash(String(d.text || ''), 'gold', 4000);
      // (your progress was reset: the kick that follows says why, not "kicked")
      if (d.bye && mp?.c) { const c = mp.c, was = c.onLost; c.onLost = (why) => { c.onLost = was; was?.call(c, d.text || why); }; }
      return;
    }
    if (t === 'adminRelease') this.releaseLocal(d.what);
  }
  /** Out of prison / the chase over / your cars out of the tow yard, here (the server already cleared its records). */
  releaseLocal(what) {
    const g = window.__game || {};
    try {
      if (what === 'jail' && g.prison) { if (isMP() && MP.profile) { delete MP.profile.jailUntil; delete MP.profile.jailReason; } if (g.prison.active || g.prison.inside) { g.prison.active = false; g.prison.release(); } return true; }
      if (what === 'chase' && g.police) { if (g.police.w) g.police.end('admin'); else g.police.forget?.(); if (isMP() && MP.profile) delete MP.profile.wanted; return true; }
      if (what === 'impound' && g.carRental) {
        const R = g.carRental; // (impound.js update(): a record past its time goes back to your bay)
        for (const e of [R.current, ...(R.kept || [])]) if (e?.impound) e.impound.until = 0;
        if (this.save.impound) this.save.impound.until = 0;
        for (const car of (isMP() && MP.profile?.cars) || []) delete car.impound;
        return true;
      }
    } catch (e) { console.warn('admin release', what, e); }
    return false;
  }

  // ------------------------------------------------------------------ actions
  say(text, bad = false) {
    this.result = text; this.resultBad = bad;
    const r = this.el.querySelector('.an-result');
    if (r) { r.textContent = text; r.classList.toggle('bad', bad); }
    if (bad) this.audio?.play('error');
  }
  name() { const v = this.el.querySelector('.an-name')?.value; if (v != null) this.target = v.trim(); return this.target; }
  me() { return isMP() ? MP.name : loadAccount()?.name || 'Icey27'; }

  async refreshPlayers() {
    if (!isMP()) return;
    const d = await this.op('players');
    if (!d || !this.isOpen) return;
    this.players = d.players || [];
    const box = this.el.querySelector('.an-players');
    if (box) box.innerHTML = this.playerRows();
  }

  async give(sign) {
    const raw = Math.floor(Number(String(this.el.querySelector('.an-amount')?.value || '').replace(/[^0-9]/g, '')));
    if (!(raw > 0)) { this.say('Enter an amount', true); return; }
    const amount = sign * Math.min(10000000, raw);
    if (!isMP()) { // (single player: your own money)
      const s = this.save, v = Math.max(Math.min(s.money, 0), Math.min(99999999, s.money + amount));
      const delta = v - s.money;
      s.money = v; this.hud.setMoney(s.money, delta); this.writeSave();
      this.audio?.play('cash');
      this.say(`${delta >= 0 ? 'Gave' : 'Took'} ${money(Math.abs(delta))} · you have ${money(v)}`);
      return;
    }
    const name = this.name() || this.me();
    const d = await this.op('give', { name, amount });
    if (!d) return;
    this.audio?.play('cash');
    this.say(`${d.delta >= 0 ? 'Gave' : 'Took'} ${money(Math.abs(d.delta))} ${d.delta >= 0 ? 'to' : 'from'} ${d.name} · now ${money(d.balance)}${d.online ? '' : ' (offline)'}`);
    this.refreshPlayers();
  }

  setHour(h) {
    h = ((h % 24) + 24) % 24;
    this.env.hour = h;
    if (!isMP()) { this.save.hour = h; this.writeSave(); return; }
    window.__game?.multiplayer?.adminClock?.(h); // (the sky follows at once; the server's 'clock' confirms it)
    this.mpHour = h;
    if (!this.mpHourT) {
      const send = () => { const v = this.mpHour; this.mpHour = null; if (v != null) this.op('time', { hour: v }).then((d) => { if (d) this.say(`Time · ${hhmm(v)} for everyone in your world`); }); };
      send();
      this.mpHourT = setTimeout(() => { this.mpHourT = null; send(); }, 250);
    }
  }
  async setWeather(w) {
    this.env.setWeather(w);
    if (!isMP()) { this.env.weatherTimer = 300; this.say(`Weather · ${WEATHER?.[w]?.label || w}`); this.render(false); return; }
    window.__game?.multiplayer?.adminClock?.(null, w);
    const d = await this.op('weather', { w });
    if (d) this.say(`Weather · ${WEATHER?.[w]?.label || w} for everyone in your world (5 min)`);
    if (this.isOpen) this.render(false);
  }

  async release(what) {
    const label = { jail: 'out of prison', chase: 'chase called off', impound: 'car out of the tow yard' }[what];
    if (!isMP()) { const done = this.releaseLocal(what); this.say(done ? `You · ${label}` : 'Nothing to release', !done); return; }
    const name = this.name();
    if (!name) { this.say('Type or pick a player name first', true); return; }
    const d = await this.op('release', { name, what });
    if (d) this.say(`${d.name} · ${label}${d.was ? '' : ' (there was nothing to release)'}${d.online ? '' : ' (offline)'}`);
    this.refreshPlayers();
  }
  async kick() {
    const name = this.name();
    if (!name) { this.say('Type or pick a player name first', true); return; }
    const d = await this.op('kick', { name });
    if (d) this.say(`${d.kicked} was kicked`);
    this.refreshPlayers();
  }
  async reset() {
    const name = this.name();
    if (!name) { this.say('Type or pick a player name first', true); return; }
    if (!this.confirming) { this.confirming = true; this.render(false); this.el.querySelector('.an-confirm')?.focus(); return; }
    const confirm = this.el.querySelector('.an-confirm')?.value || '';
    const d = await this.op('reset', { name, confirm });
    this.confirming = false;
    this.render(false);
    if (d) this.say(`${d.name}'s progress was reset${d.online ? ' (kicked: they start fresh when they join)' : ''}`);
    this.refreshPlayers();
  }
  async broadcast() {
    const inp = this.el.querySelector('.an-msg'), text = String(inp?.value || '').trim();
    if (!text) { this.say('Type a message first', true); return; }
    const d = await this.op('say', { text });
    if (d) { if (inp) inp.value = ''; this.say(`Message sent to ${d.n} player${d.n === 1 ? '' : 's'}`); }
  }
  async tpPlayer(name, here) {
    const d = await this.op(here ? 'tpHere' : 'tpTo', { name });
    if (!d) return;
    if (here) { this.say(`${d.moved} is on the way to you`); return; }
    const off = 1.8;
    this.teleport({ label: `Next to ${d.to}`, x: d.x - Math.sin(d.yaw || 0) * off, z: d.z - Math.cos(d.yaw || 0) * off, heading: d.yaw || 0, skis: false });
  }

  // ------------------------------------------------------------------ teleports
  /** The named places: { label, sub, x, z, heading, skis }. */
  places() {
    const g = window.__game || {}, out = [];
    const add = (label, sub, x, z, heading = 0) => { if (Number.isFinite(x) && Number.isFinite(z)) out.push({ label, sub, x, z, heading, skis: false }); };
    add('Legacy Village', 'The plaza', 4, 34, Math.PI);
    const cv = layout.chaletVillage?.center || CHALET_PLACE;
    add('Chalet village', 'The Chaletweg', cv?.x, cv?.z);
    const ah = g.carRental?.door;
    add('Autohaus', 'The showroom door', ah?.x, ah?.z);
    const H = busRoads.hospital;
    add('Medical centre', 'The front door', H?.ex, H?.ez, H ? Math.atan2(H.dirx || 0, H.dirz || 1) : 0);
    const pd = g.prison?.door;
    add('Police station', 'Police / Prison', pd?.x, pd?.z, pd?.yaw || 0);
    for (const line of this.ctx.lifts?.lines || g.lifts?.lines || []) { // (every gondola's top station, facing downhill)
      const s = line.spec;
      if (s?.type !== 'gondola' || !s.top || !line.dir) continue;
      const k = (line.cfg?.stationSize || 12) * 0.5 + 9, sv = line.sideV || { x: 0, z: 0 };
      const x = s.top.x + line.dir.x * k + sv.x * 4, z = s.top.z + line.dir.z * k + sv.z * 4;
      const [gx, gz] = world.gradient(x, z);
      add(s.name, s.topName ? `Summit · ${s.topName}` : 'Summit', x, z, Math.hypot(gx, gz) > 0.03 ? Math.atan2(-gx, -gz) : Math.atan2(line.dir.x, line.dir.z));
    }
    return out;
  }
  teleport(p) {
    const g = window.__game || {};
    if (g.drive?.active || g.heli?.active || g.interior?.active || g.chalets?.inside || g.carRental?.inside || g.prison?.inside || g.railway?.riding || g.express?.riding || g.skibus?.riding || g.sleds?.active || g.modes?.active || g.races?.active) {
      this.say('Get out first (vehicle, ride, race or inside)', true); return;
    }
    const old = this.ctx.admin;
    if (!old?.teleport) { this.say('Teleport unavailable', true); return; }
    this.close(true);
    old.teleport(p); // (the old panel's: off a lift, the fade, the world streamed in; multiplayer: logged on the server)
  }

  // ------------------------------------------------------------------ UI
  live() {
    if (!this.isOpen) return;
    const t = this.el.querySelector('[data-live="time"]');
    if (t) t.textContent = hhmm(this.env.hour);
    const r = this.el.querySelector('.an-hour');
    if (r && document.activeElement !== r) r.value = this.env.hour.toFixed(2);
    const m = this.el.querySelector('[data-live="money"]');
    if (m) m.textContent = money(this.save.money);
    this.plT = (this.plT || 0) + 1;
    if (this.plT % 12 === 0) this.refreshPlayers(); // (every 3 s)
  }
  playerRows() {
    if (!isMP()) return '<div class="an-empty">Single player · your own game only</div>';
    if (!this.players.length) return '<div class="an-empty">Nobody online in your world</div>';
    const me = String(MP.name || '').toLowerCase();
    return this.players.map((p) => {
      const tags = [p.jailed && 'PRISON', p.wanted && 'WANTED', p.impound && 'TOW YARD', p.inside && 'INSIDE'].filter(Boolean).map((t) => `<i class="an-tag">${t}</i>`).join('');
      const pos = p.pos ? `${Math.round(p.pos[0])}, ${Math.round(p.pos[2])}` : '—';
      const self = String(p.name).toLowerCase() === me;
      return `<div class="an-pl"><button class="an-pick" tabindex="-1" data-pick="${esc(p.name)}"><span class="ad-pl-name">${esc(p.name)}${self ? ' <small>(you)</small>' : ''}</span>
        <span class="an-meta">${money(p.money)} <i class="ch-dot"></i> ${pos}${tags}</span></button>
        ${self ? '' : `<span class="an-acts"><button class="ad-btn an-sm" tabindex="-1" data-go="${esc(p.name)}">GO TO</button><button class="ad-btn an-sm" tabindex="-1" data-bring="${esc(p.name)}">BRING</button></span>`}</div>`;
    }).join('');
  }
  render(anim = true) {
    const env = this.env, mp = isMP(), w = 330;
    const seg = (items) => `<div class="seg">${items.map(([label, act, on]) => `<button tabindex="-1" data-act="${act}" class="${on ? 'on' : ''}">${esc(label)}</button>`).join('')}</div>`;
    this.placeList = this.places();
    const places = this.placeList.map((p, i) => `<button class="ad-place" tabindex="-1" data-tp="${i}"><span class="ad-pl-name">${esc(p.label)}</span><span class="ad-pl-sub">${esc(p.sub || '')}</span></button>`).join('');
    const names = this.players.map((p) => `<option value="${esc(p.name)}">`).join('');
    this.el.className = anim ? 'in' : '';
    this.el.innerHTML = `<div class="ad-shade"></div>
      <div class="ad-wrap">
        <div class="ad-col">
          <div class="menu-head">
            <div class="menu-title" style="width:calc(var(--u) * ${Math.round(w * 0.9)})">${brushSVG(2710, w, 100)}<span>ADMIN · NEW</span></div>
            <div class="menu-sub ad-sub">${esc(this.me())} <i class="ch-dot"></i> ${mp ? `World ${MP.world?.id ?? '?'} · applied by the server` : 'Single player · your own game'} <i class="ch-dot"></i> <i class="kc">F10</i> or <i class="kc kc-word">ESC</i> to close</div>
          </div>
          <div class="menu-panel ad-panel" style="--clip:${brushClip(2711, 5, 4)}">
            <div class="mp-head">${mp ? 'PLAYER' : 'YOU'}</div>
            ${mp ? `<div class="mp-row"><span>Name</span><span class="ad-set"><input class="ad-amount an-name" list="an-names" type="text" placeholder="Player name" spellcheck="false" maxlength="16" value="${esc(this.target)}"><datalist id="an-names">${names}</datalist></span></div>` : `<div class="mp-row"><span>Balance</span><b data-live="money">${money(this.save.money)}</b></div>`}
            <div class="mp-row"><span>Money</span><span class="ad-set"><input class="ad-amount an-amount" type="text" inputmode="numeric" placeholder="Amount" spellcheck="false" data-enter="give"><button class="ad-btn" data-act="give" tabindex="-1">GIVE</button><button class="ad-btn an-alt" data-act="take" tabindex="-1">TAKE</button></span></div>
            <div class="mp-row"><span>Release</span>${seg([['Prison', 'rel:jail'], ['Police chase', 'rel:chase'], ['Tow yard', 'rel:impound']])}</div>
            ${mp ? `<div class="mp-row"><span>Kick</span><button class="ad-btn an-alt" data-act="kick" tabindex="-1">KICK</button></div>
            <div class="mp-row"><span>Progress</span>${this.confirming
              ? `<span class="ad-set"><input class="ad-amount an-confirm" type="text" placeholder="Type the name again" spellcheck="false" data-enter="reset"><button class="ad-btn an-danger" data-act="reset" tabindex="-1">RESET</button><button class="ad-btn an-alt" data-act="noreset" tabindex="-1">CANCEL</button></span>`
              : '<button class="ad-btn an-danger" data-act="reset" tabindex="-1">RESET…</button>'}</div>` : ''}
            <div class="an-result${this.resultBad ? ' bad' : ''}">${esc(this.result)}</div>
          </div>
          <div class="menu-panel ad-panel" style="--clip:${brushClip(2712, 5, 4)}">
            <div class="mp-head">${mp ? 'WORLD' : 'TIME &amp; WEATHER'}</div>
            <div class="mp-row"><span>Time <b class="ad-time" data-live="time">${hhmm(env.hour)}</b></span><input class="ad-hour an-hour" type="range" min="0" max="23.99" step="0.05" value="${env.hour.toFixed(2)}"></div>
            <div class="mp-row"><span>Jump to</span>${seg([['Dawn', 'h:7'], ['Noon', 'h:12'], ['Dusk', 'h:17.6'], ['Night', 'h:22']])}</div>
            <div class="mp-row ad-wx"><span>Weather</span>${seg(WEATHERS.map((k) => [WEATHER?.[k]?.label || k, `w:${k}`, env.weather === k]))}</div>
            ${mp ? `<div class="mp-row"><span>Message</span><span class="ad-set"><input class="ad-amount an-msg" type="text" placeholder="To everyone on the server" spellcheck="false" maxlength="140" data-enter="say"><button class="ad-btn" data-act="say" tabindex="-1">SEND</button></span></div>` : ''}
          </div>
        </div>
        <div class="ad-col ad-right an-right">
          <div class="menu-panel ad-panel an-plist" style="--clip:${brushClip(2713, 5, 4)}">
            <div class="mp-head">PLAYERS ONLINE</div>
            <div class="an-players ad-list">${this.playerRows()}</div>
          </div>
          <div class="menu-panel ad-panel ad-tp" style="--clip:${brushClip(2714, 5, 4)}">
            <div class="mp-head">TELEPORT</div>
            <div class="ad-list">${places}</div>
          </div>
        </div>
      </div>`;
    this.bind();
  }
  bind() {
    const el = this.el;
    el.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => this.act(b.dataset.act)));
    el.querySelectorAll('[data-tp]').forEach((b) => b.addEventListener('click', () => this.teleport(this.placeList[+b.dataset.tp])));
    el.querySelector('.an-players')?.addEventListener('click', (e) => {
      const b = e.target.closest?.('button');
      if (!b) return;
      if (b.dataset.pick != null) { this.target = b.dataset.pick; const n = el.querySelector('.an-name'); if (n) n.value = this.target; this.audio?.play('click'); }
      else if (b.dataset.go != null) this.tpPlayer(b.dataset.go, false);
      else if (b.dataset.bring != null) this.tpPlayer(b.dataset.bring, true);
    });
    el.querySelector('.an-name')?.addEventListener('input', (e) => { this.target = e.target.value.trim(); });
    const hr = el.querySelector('.an-hour');
    hr?.addEventListener('input', () => { this.setHour(parseFloat(hr.value)); this.live(); });
    el.addEventListener('mousedown', (e) => { if (e.target.closest?.('button')) e.preventDefault(); });
  }
  act(a) {
    this.audio?.play('click');
    if (a === 'give') return this.give(1);
    if (a === 'take') return this.give(-1);
    if (a.startsWith('rel:')) return this.release(a.slice(4));
    if (a === 'kick') return this.kick();
    if (a === 'reset') return this.reset();
    if (a === 'noreset') { this.confirming = false; return this.render(false); }
    if (a === 'say') return this.broadcast();
    if (a.startsWith('h:')) { this.setHour(parseFloat(a.slice(2))); return this.live(); }
    if (a.startsWith('w:')) return this.setWeather(a.slice(2));
  }
}
