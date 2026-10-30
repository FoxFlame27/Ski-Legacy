// HUD + menus (DOM overlay). Deliberately minimal.
import { SKIS, GEAR_YOU_OWN, PRICES, save, writeSave } from '../game/economy.js';
import { brushSVG, brushClip } from './menu.js'; // (used at call time only: menu.js imports this module too)
import './travel.css';

const $ = (id) => document.getElementById(id);
const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
const fmtMoney = (n) => n.toLocaleString('en-US');

// The house-style card dialog (hud.dialog) and the travel map pickers (ui/travel.js): bus / train / gondola
// mid-station route maps, the heli-ski flight planner. Verified in the game 2026-10-27; ?nocards in the URL (or
// false here) brings back the plain dialogs.
export const CARD_DIALOG = !(typeof location !== 'undefined' && /[?&]nocards\b/.test(location.search));

// dialog choices that only close it ("Not now", "OK"...) sit below the cards as small brush buttons
const DISMISS = /^(not now|stay here|nothing,? thanks|no,? thanks|ok|okay|thanks|back|cancel|close|one moment|maybe later|keep going)$/i;
const isSecondary = (o) => o.secondary ?? (!o.sub && o.price == null && !o.state && DISMISS.test(String(o.label).replace(/<[^>]*>/g, '').trim()));
// the card's chip: price ($N, FREE) or state (ACTIVE...), and whether you are short of money for it
function chips(o) {
  let price = o.price, state = o.state || '', sub = o.sub || '';
  if (price == null && !state && sub) {
    const parts = sub.split(' · ');
    if (/^\$[\d,]+/.test(parts[0])) { price = parts.shift(); sub = parts.join(' · '); }
    else if (/^(free|active|day pass)$/i.test(parts[0])) { state = parts.shift(); sub = parts.join(' · '); }
  }
  const n = typeof price === 'number' ? price : parseInt(String(price ?? '').replace(/[$,]/g, ''), 10);
  if (price === 0) { state = state || 'Free'; price = null; }
  const priceHTML = price == null || price === '' ? '' : typeof price === 'number' ? `<small>$</small>${fmtMoney(price)}` : String(price).replace(/^\$/, '<small>$</small>');
  return { price: state ? '' : priceHTML, state, sub, short: !!o.disabled && !state && Number.isFinite(n) && save.money < n };
}
/** Race time m:ss.cc. Rounds to centiseconds first, so 59.996 s reads 1:00.00 (never 0:60.00). */
export const fmtTime = (t) => {
  if (!isFinite(t)) return 'DNF';
  const c = Math.round(Math.max(0, t) * 100), m = Math.floor(c / 6000);
  return `${m}:${((c - m * 6000) / 100).toFixed(2).padStart(5, '0')}`;
};
const setText = (id, v) => { const e = $(id); if (e.textContent !== v) e.textContent = v; };

/**
 * Every control, grouped for the menu's CONTROLS screen: [keys, action, detail?].
 * keys: key labels drawn as keycaps; '+' joins a combination.
 */
export const CONTROLS = [
  { title: 'ON THE SNOW', rows: [
    [['A', 'D'], 'Steer left / right', 'Pivot on the spot when stopped'],
    [['W'], 'Pole yourself on, tuck for speed', 'On the flat or standing still: W pushes with your poles'],
    [['S'], 'Brake', 'Snowplow, hockey stop when fast'],
    [['S', '+', 'A', 'D'], 'Skid turn'],
    [['SPACE'], 'Hold to crouch, release to jump', 'Tap for a small hop'],
  ] },
  { title: 'IN THE AIR', rows: [
    [['A', 'D'], 'Spin'],
    [['W'], 'Front flip'],
    [['S'], 'Back flip'],
    [['SHIFT'], 'Grab'],
  ], note: 'Flips need a jump or a kicker. Land a spin switch and you pivot back automatically.' },
  { title: 'GENERAL', rows: [
    [['MOUSE'], 'Look around'],
    [['E'], 'Interact'],
    [['R'], 'First / third person'],
    [['G'], 'Skis on / off'],
    [['M'], 'Trail map'],
    [['P'], 'Photo mode'],
    [['ESC'], 'Pause menu'],
    [['BACKSPACE'], 'Restart a race instantly'],
  ], note: 'On foot you can\'t climb steep slopes: take a lift, a gondola or the ski bus.' },
];

/** Keycaps for a list of key labels (drawn with CSS, no icon font). */
export const keysHTML = (keys) => keys.map((k) => (k === '+' ? '<b class="kc-plus">+</b>' : `<i class="kc${k.length > 1 ? ' kc-word' : ''}">${k}</i>`)).join('');

// first-time hint: the essentials, bottom-left, once per save (save.tutorial)
const HINT_ROWS = [
  [keysHTML(['A', 'D']), 'Steer'],
  [keysHTML(['W', 'S']), 'Go / tuck · brake'],
  [keysHTML(['SPACE']), 'Hold, release to jump'],
  ['<em class="ch-label">IN THE AIR</em>', `${keysHTML(['A', 'D'])} spin <i class="ch-dot"></i> ${keysHTML(['W', 'S'])} flip <i class="ch-dot"></i> ${keysHTML(['SHIFT'])} grab`],
  [keysHTML(['M']), 'Trail map'],
  [keysHTML(['ESC']), 'Pause · all controls'],
];

export class HUD {
  constructor() {
    this.el = $('hud');
    this.flashTimer = null;
    this.blockers = new Set();
    this.panelOpen = false;
    this.onClose = null;
    this.hintShown = false;
  }

  // panelOpen is true while a panel card is open OR any other modal (e.g. the race results)
  // blocks gameplay: main.js disables input and skips the auto-pause while it is set.
  get panelOpen() { return this._panelOpen || this.blockers.size > 0; }
  set panelOpen(v) { this._panelOpen = !!v; }
  setBlocking(key, on) { if (on) this.blockers.add(key); else this.blockers.delete(key); }

  // the very first time the HUD appears for a save, the controls hint comes up with it
  show() {
    this.el.hidden = false;
    if (save.tutorial !== false && !this.hintShown) this.controlsHint();
  }

  /**
   * Controls hint card (bottom-left): turn, tuck/brake, jump, air tricks, Esc for the full list.
   * Shown automatically once per save by show(); main.js may call it again any time.
   * @param {number} [ms=15000]  how long it stays up
   */
  controlsHint(ms = 15000) {
    let el = $('controls-hint');
    if (!el) {
      el = document.createElement('div');
      el.id = 'controls-hint';
      this.el.appendChild(el);
    }
    this.hintShown = true;
    el.innerHTML = `<div class="ch-card paper"><div class="ch-head">CONTROLS</div>${HINT_ROWS.map(([k, t]) => `<div class="ch-row"><span class="ch-keys">${k}</span><span class="ch-do">${t}</span></div>`).join('')}</div>`;
    el.classList.remove('out');
    el.hidden = false;
    clearTimeout(this.hintSeenT);
    clearTimeout(this.hintT);
    // counts as seen once it has been up for a few seconds
    this.hintSeenT = setTimeout(() => { save.tutorial = false; writeSave(); }, 6000);
    this.hintAt = performance.now();
    this.hintT = setTimeout(() => this.fadeHint(), ms);
    // walking counts too (the HUD speed reads 0 on foot): a held movement key after 3 s
    if (!this.hintKeys) {
      this.hintKeys = true;
      addEventListener('keydown', (e) => {
        if (this.hintAt && MOVE_KEYS.has(e.code) && performance.now() - this.hintAt > 3000) this.fadeHint();
      });
    }
  }

  // the hint slides away: its time is up, or you set off (frame(): moving after it has been up 3 s), so it never
  // sits over the first-person gloves for long
  fadeHint() {
    const el = $('controls-hint');
    clearTimeout(this.hintT);
    if (this.hintAt && performance.now() - this.hintAt > 3000) { clearTimeout(this.hintSeenT); save.tutorial = false; writeSave(); }
    this.hintAt = 0;
    if (!el || el.hidden) return;
    el.classList.add('out');
    this.hintT = setTimeout(() => { el.hidden = true; el.classList.remove('out'); }, 600);
  }

  setMoney(v, delta) {
    setText('money-val', fmtMoney(v));
    if (delta) {
      const d = $('money-delta');
      d.textContent = (delta > 0 ? '+' : '−') + fmtMoney(Math.abs(delta));
      d.style.color = delta > 0 ? 'var(--good)' : 'var(--bad)';
      d.classList.add('show');
      clearTimeout(this.mdT);
      this.mdT = setTimeout(() => d.classList.remove('show'), 1600);
    }
  }

  // (Oct 30 2026, the user: a small forecast line in the weather area, "Later: Blizzard", and the avalanche danger
  // level as "a small HUD line"; both "small and unobtrusive": one dim line under the clock, refreshed twice a second)
  wxLine() {
    const now = performance.now();
    if (now - (this.wxAt || 0) < 500) return;
    this.wxAt = now;
    let el = this.wxEl;
    if (!el) {
      const clock = document.getElementById('clock');
      if (!clock) return;
      el = this.wxEl = document.createElement('div');
      el.id = 'wx-sub';
      el.style.cssText = 'font-size:10px;opacity:.62;margin-top:1px;font-variant-numeric:tabular-nums;';
      clock.after(el);
    }
    const env = globalThis.__game?.env;
    if (!env) return;
    const lv = env.avalancheLevel, fc = env.forecastLabel || '';
    const AV = ['', 'low', 'moderate', 'considerable', 'high'];
    const txt = [fc, lv ? `Avalanche ${lv} · ${AV[lv]}` : ''].filter(Boolean).join('  ·  ');
    if (el.textContent !== txt) el.textContent = txt;
  }

  frame({ speed, loc, time, weather, ski, prompt, promptKey = 'E', objective, heading, waypoint, speedo = true }) {
    const sp = $('speedo');
    if (sp.hidden === speedo) sp.hidden = !speedo; // (hidden while riding: lifts, train, bus, heli)
    if (this.hintAt && speed > 2 && performance.now() - this.hintAt > 3000) this.fadeHint();
    setText('speed-val', String(Math.round(speed * 3.6)));
    setText('loc', loc);
    setText('clock', `${time} · ${weather}`);
    this.wxLine();
    setText('ski-name', ski);
    const p = $('prompt');
    if (prompt) { p.hidden = false; setText('prompt-text', prompt); p.querySelector('.key').textContent = promptKey; } else p.hidden = true;
    setText('objective', objective || '');
    const wp = $('waypoint');
    if (waypoint) {
      wp.hidden = false;
      let d = waypoint.ang - heading;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      $('wp-arrow').style.transform = `rotate(${(-d * 180) / Math.PI}deg)`;
      setText('wp-text', `${waypoint.label} · ${waypoint.dist < 1000 ? Math.round(waypoint.dist) + ' m' : (waypoint.dist / 1000).toFixed(1) + ' km'}`);
    } else wp.hidden = true;
  }

  prompt(text) { const p = $('prompt'); if (text) { p.hidden = false; setText('prompt-text', text); } else p.hidden = true; }

  flash(text, cls = 'good', ms = 1800) {
    const f = $('flash');
    if (!text) return;
    f.textContent = text;
    f.className = 'show ' + cls;
    clearTimeout(this.flashTimer);
    // (the user: "make all notifications stay longer", twice: every message at least 5.5 s, the longer ones 2.25x)
    this.flashTimer = setTimeout(() => (f.className = ''), Math.max(5500, ms * 2.25));
  }

  // ---------- races ----------
  raceStart(race) {
    $('race-hud').hidden = false;
    setText('race-name', `${race.name} · ${race.D.label}`);
  }
  raceCountdown(t) { setText('countdown', t); }
  raceUpdate({ time, penalty, gate, gates, pos, rows, next }) {
    setText('race-time', fmtTime(time));
    setText('race-pen', penalty ? `+${penalty.toFixed(2)}s penalty` : '');
    setText('race-gate', `Gate ${Math.min(gate + 1, gates)}/${gates} · P${pos}`);
    // the next gate (or the finish): how far, and an arrow pointing the way to ski
    let nx = $('race-next');
    if (!nx) {
      nx = document.createElement('div');
      nx.id = 'race-next';
      nx.innerHTML = '<i class="rh-arrow"></i><span></span>';
      $('race-gate').after(nx);
    }
    nx.hidden = !next;
    if (next) {
      const t = `${next.label} · ${Math.max(0, Math.round(next.dist))} m`;
      const sp = nx.lastChild;
      if (sp.textContent !== t) sp.textContent = t;
      const a = Math.round(Math.max(-170, Math.min(170, next.angle || 0)) / 3) * 3;
      if (nx.dataset.a !== String(a)) { nx.firstChild.style.transform = `rotate(${a}deg)`; nx.dataset.a = String(a); }
    }
    const html = rows.map((r, i) => `<li class="${r.me ? 'me' : ''}">${r.pos ?? i + 1}. ${r.name}${r.time ? ' ' + fmtTime(r.time) : ''}</li>`).join('');
    if ($('race-rows').innerHTML !== html) $('race-rows').innerHTML = html;
  }
  raceEnd() { $('race-hud').hidden = true; setText('countdown', ''); }

  rideHint(name) {
    const h = $('ride-hint');
    if (name) { h.hidden = false; setText('ride-name', name); } else h.hidden = true;
  }

  // ---------- panels ----------
  open(html, onClose, cls = '') {
    $('panel-card').className = `card${cls ? ' ' + cls : ''}`;
    $('panel-card').innerHTML = html;
    $('panel').hidden = false;
    this.panelOpen = true;
    this.onClose = onClose;
    document.exitPointerLock?.();
  }
  close() {
    $('panel').hidden = true;
    this.panelOpen = false;
    const cb = this.onClose; this.onClose = null;
    cb?.();
  }

  shop({ onBuy, onEquip }) {
    const rows = SKIS.map((s) => {
      const has = save.owned.includes(s.id);
      const eq = save.skis === s.id;
      const btn = eq ? '<button class="btn" disabled>Equipped</button>'
        : has ? `<button class="btn" data-equip="${s.id}">Equip</button>`
        : `<button class="btn primary" data-buy="${s.id}" ${save.money < s.price ? 'disabled' : ''}>${s.rent ? 'Rent' : 'Buy'}</button>`;
      const pct = Math.round((s.speed - 1) * 100);
      return `<div class="row"><img src="./thumbs/${s.model}.png" alt=""><div class="grow"><div class="name">${s.name}</div>
        <div class="desc">${pct ? `+${pct}% speed` : 'Standard speed'} · ${Math.round(s.grip * 100)}% grip</div></div>
        <div class="price">${has ? '' : '$' + fmtMoney(s.price)}</div>${btn}</div>`;
    }).join('');
    this.open(`<h2>Ski Shop</h2>
      <div class="sub">You have $${fmtMoney(save.money)} · already packed: ${GEAR_YOU_OWN.join(', ').toLowerCase()}</div>
      ${rows}
      <div class="actions"><button class="btn" data-close>Close</button></div>`);
    this.bind({ onBuy, onEquip });
  }

  tickets({ onBuy }) {
    const pass = save.dayPass === save.day;
    this.open(`<h2>Lift Tickets</h2>
      <div class="sub">You have $${fmtMoney(save.money)}${pass ? ' · day pass active' : ''}</div>
      <div class="row"><div class="grow"><div class="name">Gondola ride</div><div class="desc">Pay at the gondola</div></div><div class="price">$${PRICES.gondola}</div></div>
      <div class="row"><div class="grow"><div class="name">Chairlift ride</div><div class="desc">Pay at any chairlift</div></div><div class="price">$${PRICES.chair}+</div></div>
      <div class="row"><div class="grow"><div class="name">Day pass</div><div class="desc">Unlimited rides until midnight</div></div><div class="price">$${PRICES.dayPass}</div>
        <button class="btn primary" data-buy="daypass" ${pass || save.money < PRICES.dayPass ? 'disabled' : ''}>${pass ? 'Active' : 'Buy'}</button></div>
      <div class="actions"><button class="btn" data-close>Close</button></div>`);
    this.bind({ onBuy });
  }

  // Resort race card. An entry of 0 (easy races, and main.js passes 0 for your first race) reads FREE.
  // race.ai (optional, the start houses' races): { levels: [{ key, label, mult }], pick, prizeOf(key) } -> an AI field
  // picker (left / right or a click); the prizes follow the pick and onStart(key) gets it.
  raceIntro(race, best, { onStart, onClose, onPractice }) { // (onPractice: a "Practice race (no prize)" button: alone, free)
    const fee = race.D.entry || 0;
    const broke = save.money < fee;
    const firstFree = !fee && (save.stats?.races || 0) === 0;
    const ai = race.ai || null;
    let pick = ai ? (ai.levels.some((l) => l.key === ai.pick) ? ai.pick : ai.levels[0].key) : null;
    const prize = () => (ai ? ai.prizeOf(pick) : race.reward);
    const prizes = () => {
      const r = prize();
      return `<div class="stat">1st place<b>$${fmtMoney(r)}</b></div>
        <div class="stat">2nd / 3rd<b>$${fmtMoney(Math.round(r * (race.shares?.[1] ?? 0.4)))} / $${fmtMoney(Math.round(r * (race.shares?.[2] ?? 0.15)))}</b></div>${race.finisher ? `
        <div class="stat">Any finish<b>${race.finisher}</b></div>` : ''}`; // (a bus race: every finisher is paid)
    };
    const aiRow = ai ? `<div class="sub" style="margin-top:12px">AI field · the harder the rivals, the bigger the prize</div>
      <div class="ri-ai" style="display:flex;gap:8px;margin-top:6px">${ai.levels.map((l) => `<button class="btn${l.key === pick ? ' primary' : ''}" data-ai="${l.key}" style="flex:1 1 0;min-width:0;padding-left:4px;padding-right:4px">${l.label}<small style="display:block;opacity:0.8;font-size:11px">×${l.mult} · $${fmtMoney(ai.prizeOf(l.key))}</small></button>`).join('')}</div>` : '';
    this.open(`<h2>${race.name}</h2>
      <div class="sub">${race.D.label} · ${Math.round(race.length)} m · ${race.gates.length ? race.gates.length + ' gates · ' : ''}14 opponents</div>
      <div class="grid">
        <span class="ri-prizes" style="display:contents">${prizes()}</span>
        <div class="stat entry${fee ? '' : ' free'}">Entry<b>${fee ? '$' + fmtMoney(fee) : 'FREE'}</b>${firstFree ? '<em>First race on the house</em>' : ''}</div>
        <div class="stat">Your best<b>${best ? fmtTime(best) : '—'}</b></div>
      </div>
      ${aiRow}
      <div class="sub" style="margin-top:14px">Ski through every gate (through the green bar between its two flags) and beat the 14 racers to the finish. A missed gate only adds half a second.</div>
      ${broke ? `<div class="sub" style="color:#ff8a80;font-weight:700">You need $${fmtMoney(fee)} for the entry fee — you have $${fmtMoney(save.money)}. Win easier races first.</div>` : ''}
      <div class="actions"><button class="btn" data-close>Cancel · Esc</button>${onPractice ? '<button class="btn" data-practice>Practice race (no prize) · P</button>' : ''}<button class="btn primary" data-start ${broke ? 'disabled' : ''}>Start · Enter</button></div>`, onClose);
    const card = $('panel-card');
    const startBtn = card.querySelector('[data-start]');
    const setAi = (k) => {
      if (!ai || !ai.levels.some((l) => l.key === k)) return;
      pick = k;
      card.querySelectorAll('[data-ai]').forEach((b) => b.classList.toggle('primary', b.dataset.ai === k));
      const box = card.querySelector('.ri-prizes');
      if (box) box.innerHTML = prizes();
    };
    const stepAi = (d) => {
      if (!ai) return;
      const i = ai.levels.findIndex((l) => l.key === pick);
      setAi(ai.levels[Math.max(0, Math.min(ai.levels.length - 1, i + d))].key);
    };
    card.querySelectorAll('[data-ai]').forEach((b) => b.addEventListener('click', () => setAi(b.dataset.ai)));
    const go = () => { if (startBtn.disabled) return; removeEventListener('keydown', keys); this.close(); onStart(pick); };
    const practice = () => { if (!onPractice) return; removeEventListener('keydown', keys); this.close(); onPractice(); };
    card.querySelector('[data-practice]')?.addEventListener('click', practice);
    // keyboard: Enter or E starts, Esc cancels, left / right pick the AI field
    const keys = (e) => {
      if (!this.panelOpen) { removeEventListener('keydown', keys); return; }
      if (e.code === 'Enter' || e.code === 'KeyE') { e.preventDefault(); go(); }
      else if (onPractice && e.code === 'KeyP') { e.preventDefault(); practice(); }
      else if (e.code === 'Escape') { removeEventListener('keydown', keys); this.close(); }
      else if (ai && (e.code === 'ArrowLeft' || e.code === 'KeyA')) { e.preventDefault(); stepAi(-1); }
      else if (ai && (e.code === 'ArrowRight' || e.code === 'KeyD')) { e.preventDefault(); stepAi(1); }
    };
    setTimeout(() => addEventListener('keydown', keys), 150); // ignore the E press that opened the card
    startBtn.addEventListener('click', go);
    this.bind({});
  }

  raceResult(res, prize) {
    const { race, place, rows, dnf, total } = res;
    const ord = ['1st', '2nd', '3rd', '4th'][place - 1];
    this.open(`<h2>${race.name}</h2>
      <div class="result-place" style="color:${dnf ? 'var(--bad)' : place === 1 ? 'var(--gold)' : '#fff'}">${dnf ? 'DNF' : ord}</div>
      <div class="sub">${dnf ? 'You left the course.' : `Time ${fmtTime(total)}`}${prize ? ` · won $${fmtMoney(prize)}` : ''}</div>
      <ol>${rows.map((r) => `<li style="${r.me ? 'color:var(--gold)' : ''}">${r.name} — ${fmtTime(r.time)}</li>`).join('')}</ol>
      <div class="actions"><button class="btn primary" data-close>Continue</button></div>`);
    this.bind({});
  }

  pause({ onQuality, onSens, onReset, onQuit, onTime, stats }) {
    this.open(`<h2>Paused</h2>
      <div class="grid" style="margin-top:14px">
        <div class="stat">Races won<b>${stats.wins} / ${stats.races}</b></div>
        <div class="stat">Top speed<b>${Math.round(stats.topSpeed * 3.6)} km/h</b></div>
        <div class="stat">Distance<b>${(stats.distance / 1000).toFixed(1)} km</b></div>
        <div class="stat">Prize money<b>$${fmtMoney(stats.earned)}</b></div>
      </div>
      <h3>Settings</h3>
      <div class="ctl">
        <b>Graphics</b><select id="q-sel">${['low', 'medium', 'high', 'ultra'].map((q) => `<option value="${q}" ${save.quality === q ? 'selected' : ''}>${q[0].toUpperCase() + q.slice(1)}</option>`).join('')}</select>
        <b>Mouse</b><input id="sens" type="range" min="0.3" max="2.5" step="0.1" value="${save.sensitivity}">
        <b>Time of day</b><span><button class="btn" data-time="7">Dawn</button> <button class="btn" data-time="12">Noon</button> <button class="btn" data-time="17.5">Dusk</button> <button class="btn" data-time="22">Night</button></span>
      </div>
      <h3>Controls</h3>
      <div class="ctl">
        ${CONTROLS.map((g) => g.rows.map(([k, label]) => `<b>${g.title === 'IN THE AIR' ? 'Air · ' : ''}${k.join(' ')}</b>${label}`).join('')).join('')}
      </div>
      <div class="actions"><button class="btn" data-reset>Reset progress</button><button class="btn" data-quit>Quit</button><button class="btn primary" data-close>Resume</button></div>`);
    const card = $('panel-card');
    card.querySelector('#q-sel').addEventListener('change', (e) => onQuality(e.target.value));
    card.querySelector('#sens').addEventListener('input', (e) => onSens(parseFloat(e.target.value)));
    card.querySelector('[data-reset]').addEventListener('click', onReset);
    card.querySelector('[data-quit]').addEventListener('click', onQuit);
    card.querySelectorAll('[data-time]').forEach((b) => b.addEventListener('click', () => onTime(parseFloat(b.dataset.time))));
    this.bind({});
  }

  /**
   * A dialog as a house-style card: a brush title, the line said, and the choices as big paper cards (name,
   * what it is, the price or its state); "not now"-type choices sit below as small brush buttons. Conversations
   * (talk.js) put the same card beside the person. Mouse or keys: arrows move, Enter / Space choose, 1-9 pick a
   * card directly, Esc walks away (nothing chosen).
   * @param {string} who   title (HTML; talk.js passes its name tag)
   * @param {string} say   the line (HTML)
   * @param {Array<{label, sub?, price?: number|string, state?: string, disabled?, secondary?, close?, act?}>} options
   *        price: a number reads $N (0 = FREE); without price / state a sub starting "$N · ..." or
   *        "free · ..." / "active · ..." is split into the chip and the rest.
   * @param {{kicker?: string}} [o]
   */
  dialog(who, say, options, { kicker = '' } = {}) {
    if (!CARD_DIALOG) return this.dialogClassic(who, say, options);
    const talking = String(who).includes('talk-name');
    const plain = String(who).replace(/<[^>]*>/g, '');
    const w = Math.max(220, Math.round(plain.length * 26 + 110));
    const title = talking ? who
      : `<div class="dlg-title" style="width:calc(var(--u) * ${Math.round(w * 0.92)})">${brushSVG(plain.length * 7 + 3, w, 100)}<span>${who}</span></div>`;
    const prim = [], sec = [];
    options.forEach((o, i) => (isSecondary(o) ? sec : prim).push(i));
    const card = (i, n) => {
      const o = options[i], c = chips(o);
      const foot = c.price ? `<span class="do-price">${c.price}</span>` : c.state ? `<span class="do-state${/free/i.test(c.state) ? ' free' : ''}">${c.state}</span>` : '';
      const note = c.short ? `<span class="do-note">You have $${fmtMoney(save.money)}</span>` : '';
      return `<button class="dlg-opt" data-opt="${i}" style="--i:${n};--clip:${brushClip(60 + i * 5, 6, 4)}" ${o.disabled ? 'disabled' : ''}>
        <span class="do-key"><i class="kc">${n + 1}</i></span>
        <span class="do-body"><span class="do-title">${o.label}</span>${c.sub ? `<span class="do-sub">${c.sub}</span>` : ''}</span>
        ${foot || note ? `<span class="do-foot">${foot}${note}</span>` : ''}<i class="do-bar"></i></button>`;
    };
    this.open(`<div class="dialog dlg">${kicker ? `<div class="dlg-kicker"><i></i>${kicker}</div>` : ''}<div class="who">${title}</div><div class="say">${say || ''}</div>
      ${prim.length ? `<div class="dlg-cards">${prim.map((i, n) => card(i, n)).join('')}</div>` : ''}
      <div class="dlg-foot">${sec.map((i) => `<button class="dlg-sec" data-opt="${i}" ${options[i].disabled ? 'disabled' : ''}>${options[i].label}</button>`).join('')}
        <span class="dlg-hints">${prim.length > 1 ? `<span class="hint"><i class="kc kc-arrow left"></i><i class="kc kc-arrow right"></i><em>Choose</em></span>` : ''}${prim.length ? '<span class="hint"><i class="kc">ENTER</i><em>Select</em></span>' : ''}<span class="hint"><i class="kc">ESC</i><em>Close</em></span></span></div></div>`,
    undefined, 'dlg-card-host');
    const root = $('panel-card').querySelector('.dialog');
    const btns = [...root.querySelectorAll('[data-opt]')];
    const pick = (b) => {
      if (!b || b.disabled) return;
      const o = options[+b.dataset.opt];
      removeEventListener('keydown', keys, true);
      if (o.close !== false) this.close();
      o.act?.();
    };
    let fi = -1;
    const live = () => btns.filter((b) => !b.disabled);
    const focus = (b) => { fi = btns.indexOf(b); btns.forEach((x) => x.classList.toggle('is-focus', x === b)); };
    focus(live()[0] || null);
    btns.forEach((b) => {
      b.addEventListener('click', () => pick(b));
      b.addEventListener('mouseenter', () => { if (!b.disabled) focus(b); });
    });
    // keys (capture: the game never sees them while the card is up). Esc walks away (nothing chosen).
    const t0 = performance.now();
    const keys = (e) => {
      if (!this.panelOpen || !root.isConnected) { removeEventListener('keydown', keys, true); return; }
      const k = e.code;
      if (k === 'Escape') { removeEventListener('keydown', keys, true); this.close(); return; }
      if (performance.now() - t0 < 150 || e.repeat) return; // (not the key press that opened it)
      const L = live();
      let used = true;
      if (k === 'ArrowRight' || k === 'ArrowDown' || k === 'Tab') focus(L[(L.indexOf(btns[fi]) + 1) % L.length]);
      else if (k === 'ArrowLeft' || k === 'ArrowUp') focus(L[(L.indexOf(btns[fi]) - 1 + L.length) % L.length]);
      else if (k === 'Enter' || k === 'NumpadEnter' || k === 'Space') pick(btns[fi]);
      else if (/^Digit[1-9]$/.test(k)) { const i = prim[+k.slice(5) - 1]; if (i !== undefined) pick(root.querySelector(`.dlg-opt[data-opt="${i}"]`)); }
      else used = false;
      if (used) { e.preventDefault(); e.stopImmediatePropagation(); }
    };
    addEventListener('keydown', keys, true);
  }

  // the plain dialog (title, line, a list of choices): used while CARD_DIALOG is off
  dialogClassic(who, say, options) {
    this.open(`<div class="dialog"><div class="who">${who}</div><div class="say">${say}</div>
      ${options.map((o, i) => `<button class="btn opt" data-opt="${i}" ${o.disabled ? 'disabled' : ''}>${o.label}<span>${o.sub || ''}</span></button>`).join('')}</div>`);
    $('panel-card').querySelectorAll('[data-opt]').forEach((b) => b.addEventListener('click', () => {
      const o = options[+b.dataset.opt];
      if (o.close !== false) this.close();
      o.act?.();
    }));
    const card = $('panel-card').querySelector('.dialog');
    const keys = (e) => {
      if (!this.panelOpen || !card.isConnected) { removeEventListener('keydown', keys); return; }
      if (e.code === 'Escape') { removeEventListener('keydown', keys); this.close(); }
    };
    setTimeout(() => addEventListener('keydown', keys), 150); // (not the key press that opened it)
  }

  bind({ onBuy, onEquip }) {
    const card = $('panel-card');
    card.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => this.close()));
    card.querySelectorAll('[data-buy]').forEach((b) => b.addEventListener('click', () => onBuy?.(b.dataset.buy)));
    card.querySelectorAll('[data-equip]').forEach((b) => b.addEventListener('click', () => onEquip?.(b.dataset.equip)));
  }
}
