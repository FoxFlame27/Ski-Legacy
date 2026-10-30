// The AUTOHAUS configurator (src/game/carrental.js; was the car rental's: the cars are bought now), in the ski shop's outfit designer style (ui/outfitshop.js: white
// brush paper, blue italic condensed lettering, red accents, the live 3D preview to the right): step by step, PAINT ·
// WHEELS · PLATE · SUMMARY, then BUY (the cabin keeps its factory trim). The car is the one you opened it at (E at
// it, or the one the clerk sent you to): no switching models in here. Every choice shows at once on the
// real car on its showroom turntable (the camera swings round to it; drag to turn). Keyboard + mouse:
// left / right a step, up / down a choice, Enter next (BUY on the summary), Esc closes; on the plate you type.
// You may own several cars (up to garageMax), the same model more than once too: every car of yours is told apart by its
// plate. The main button always BUYS a new one (its own plate); a model you own opens on the summary, where MY CARS lists
// every car of yours (yours of this model first, marked): click one to put it in your bay (free), SELL on its row (half
// what you paid, click twice).
//   open({ cars: [{ id, label, kind, price, length }], cfg, current: cfg | null, money, cost(cfg) -> { base, extras, total },
//          preview(cfg, step), drag(dx, dy), rent(cfg) (buys it), close(), step?, owned: n (your cars of this model),
//          garage: [{ ...cfg, label, value, out }], garageMax, takeOut(plate), sell(plate), wreckFee, repairFull, towFee,
//          plateCheck?(plate) -> Promise<{ free } | null>, plateIssue?() -> Promise<plate | null> })   (multiplayer: plates are
//          unique across every player; the plate you type is checked with the server as you type, "taken" shows at once)
import './outfitshop.css'; // (its rows, tabs, detail card)
import './carrental.css';
import { brushSVG, brushClip, esc } from './menu.js';
import { PAINTS, RIMS, FINISH, PLATE_COST, paintOf, rimOf, cleanPlate, randomPlate } from '../game/carconfig.js';

const STEPS = [
  { id: 'paint', label: 'PAINT', one: 'PAINT' },
  { id: 'rims', label: 'WHEELS', one: 'WHEELS' }, { id: 'plate', label: 'PLATE', one: 'NUMBER PLATE' }, { id: 'sum', label: 'SUMMARY', one: 'YOUR CAR' },
];
const KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyS', 'KeyA', 'KeyD', 'Enter', 'NumpadEnter', 'Escape', 'Tab']);
const money = (v) => `$${Math.round(v || 0).toLocaleString('en-US')}`;
const css = (hex) => `#${hex.toString(16).padStart(6, '0')}`;
const plus = (v) => (v ? `+${money(v)}` : 'Included');

export class CarRentalUI {
  constructor({ hud = null, audio = null } = {}) {
    Object.assign(this, { hud, audio });
    this.view = null; this.el = null; this.step = 0;
    this.onKey = (e) => this.key(e);
  }
  get isOpen() { return !!this.view; }

  open(view) {
    if (!this.el) { this.el = document.createElement('div'); this.el.id = 'carrental'; this.el.hidden = true; document.body.appendChild(this.el); }
    this.view = view;
    this.cfg = { ...view.cfg, interior: 'orig' }; // (no trim step: the factory cabin, at no cost)
    this.step = view.step || 0;
    this.openedAt = performance.now();
    this.plateTaken = false; this.plateMine = false; this.plateSeq = 0; clearTimeout(this.plateT);
    // multiplayer: a random plate is the server's (nobody else has it); a custom one is checked
    this.sellArm = null; // (the plate of the car whose SELL was clicked once: click again to sell it)
    if (view.plateIssue && !this.cfg.custom) this.issuePlate();
    this.render(true);
    if (this.cfg.custom) this.checkPlate(this.cfg.plate, 0); // (after the first render: it updates the note in place)
    this.el.hidden = false;
    document.body.classList.add('carcfg-open');
    this.hud?.setBlocking?.('carrental', true);
    document.exitPointerLock?.();
    addEventListener('keydown', this.onKey, true);
    this.audio?.play?.('click');
    this.preview();
  }

  close(how = 'close') {
    if (!this.view) return;
    clearTimeout(this.plateT); this.plateSeq++;
    const v = this.view;
    this.view = null;
    this.closedAt = performance.now(); // (main.js: the pointer lock coming back just after must not open the pause menu)
    this.el.hidden = true; this.el.innerHTML = '';
    document.body.classList.remove('carcfg-open');
    this.hud?.setBlocking?.('carrental', false);
    removeEventListener('keydown', this.onKey, true);
    v.close?.(how);
  }

  preview() { try { this.view?.preview?.(this.cfg, STEPS[this.step].id); } catch (e) { console.warn('car preview', e); } }

  // ---------------------------------------------------------------- the choices of a step: { id, ...row } and which is on
  rows() {
    const v = this.view, s = STEPS[this.step].id, c = this.cfg;
    if (s === 'paint') return { list: PAINTS.map((p) => ({ id: p.id, name: p.label, sub: FINISH[p.finish].label, price: plus(FINISH[p.finish].cost), sw: `<i class="os-sw cr-sw-paint ${p.finish}" style="--c:${css(p.hex)}"></i>`, group: FINISH[p.finish].label })), on: c.paint, key: 'paint' };
    if (s === 'rims') return { list: RIMS.map((r) => ({ id: r.id, name: r.label, sub: r.id === 'orig' ? "The car's own alloys" : 'Painted alloys, tyres stay black', price: plus(r.cost), sw: `<i class="os-sw cr-sw-rim" style="--c:${r.id === 'orig' ? '#c9ced4' : css(r.hex)}"></i>` })), on: c.rims, key: 'rims' };
    return null;
  }

  pick(id) {
    const r = this.rows();
    if (!r || this.cfg[r.key] === id) return;
    this.cfg[r.key] = id;
    this.audio?.play?.('tick');
    this.preview();
    this.renderStep(false);
  }
  move(d) {
    const r = this.rows();
    if (!r) return;
    const i = r.list.findIndex((o) => o.id === r.on), n = r.list.length;
    this.pick(r.list[(((i + d) % n) + n) % n].id);
  }
  go(i) {
    const n = Math.max(0, Math.min(STEPS.length - 1, i));
    if (n === this.step) return;
    this.step = n;
    this.audio?.play?.('tick');
    this.render(false);
    this.preview();
  }
  next() { if (this.step < STEPS.length - 1) this.go(this.step + 1); else this.rent(); }
  /** Your garage holds no more cars (sell one first). */
  full() { const v = this.view; return !!v && (v.garage?.length || 0) >= (v.garageMax || Infinity); }
  rent() {
    const v = this.view, c = { ...this.cfg }, cost = v.cost(c);
    if (this.full()) { this.shake(); this.audio?.play?.('error'); this.hud?.flash?.(`Your garage is full (${v.garageMax} cars) · sell one first (MY CARS)`, 'bad', 3000); return; }
    if (this.plateTaken) { this.shake(); this.audio?.play?.('error'); this.go(STEPS.findIndex((s) => s.id === 'plate')); return; }
    if (v.money < cost.total) { this.shake(); this.audio?.play?.('error'); return; }
    this.close('rent');
    v.rent?.(c);
  }
  /** SELL on a MY CARS row: once arms it (SURE?), again sells that car (by its plate). */
  sell(plate) {
    const v = this.view, g = v?.garage?.find((x) => x.plate === plate);
    if (!g) return;
    if (this.sellArm !== plate) { this.sellArm = plate; this.audio?.play?.('tick'); this.render(false); return; } // (twice: sure?)
    this.close('sell'); v.sell?.(plate);
  }
  // ---------------------------------------------------------------- multiplayer plates (unique across every player)
  // (Oct 30, the user: "indicate already that the plate is taken while you are typing it"): at once against your own
  // cars (single player too: a plate is on one car only), then with the server (multiplayer: every player's plates)
  checkPlate(text, delay = 280) {
    const v = this.view;
    const key = (p) => String(p || '').replace(/[ -]/g, '').toUpperCase();
    this.plateMine = !!v?.garage?.some((g) => key(g.plate) === key(text));
    this.plateTaken = this.plateMine;
    this.plateNote(); this.renderDetail();
    if (!v?.plateCheck) return;
    const seq = ++this.plateSeq;
    clearTimeout(this.plateT);
    this.plateT = setTimeout(async () => {
      const r = await v.plateCheck(text);
      if (seq !== this.plateSeq || this.view !== v || !r) return;
      this.plateMine = this.plateMine || !!r.mine;
      this.plateTaken = r.free === false || this.plateMine; // (on another of your cars: taken for a new one too)
      this.plateNote();
      this.renderDetail();
    }, delay);
  }
  plateTakenText(plate) { return this.plateMine ? `${plate} is already on one of your cars · type another` : `${plate} is taken · type another`; }
  async issuePlate() {
    const v = this.view, seq = ++this.plateSeq;
    this.plateTaken = false; this.plateMine = false;
    const plate = await v.plateIssue();
    if (!plate || seq !== this.plateSeq || this.view !== v || this.cfg.custom) return;
    this.cfg.plate = plate;
    const inp = this.el?.querySelector('.cr-plate-in');
    if (inp) inp.value = plate;
    this.plateNote();
    this.preview(); this.renderDetail();
  }
  plateNote() {
    const el = this.el?.querySelector('.cr-plate-note');
    if (!el) return;
    el.classList.toggle('taken', !!this.plateTaken);
    el.textContent = this.plateTaken ? this.plateTakenText(this.cfg.plate) : this.cfg.custom ? `Your own text · ${plus(PLATE_COST)}` : 'A random local plate · included';
  }
  shake() { const b = this.el.querySelector('.os-act'); b?.classList.remove('nope'); void b?.offsetWidth; b?.classList.add('nope'); }

  // ---------------------------------------------------------------- DOM
  render(first) {
    this.el.innerHTML = `
      <div class="os-shade"></div>
      <div class="os-drag cr-drag" aria-hidden="true"></div>
      <div class="os-col cr-col${first ? ' in' : ''}">
        <div class="menu-head os-head">
          <div class="menu-title" style="width:calc(var(--u) * 330)">${brushSVG(4327, 360, 100)}<span>AUTOHAUS</span></div>
          <div class="menu-sub">Build your car · yours for good</div>
        </div>
        <div class="seg-brush os-tabs cr-steps">${STEPS.map((t, i) => `<button tabindex="-1" data-step="${i}" class="${i === this.step ? 'on' : ''}${i < this.step ? ' done' : ''}"><i>${i + 1}</i>${t.label}</button>`).join('')}</div>
        <div class="os-list cr-list"></div>
        <div class="os-detail cr-detail paper" style="--clip:${brushClip(517, 5, 4)}"></div>
      </div>
      <div class="os-foot">
        <span class="hint"><i class="kc kc-arrow left"></i><i class="kc kc-arrow right"></i><em>Step</em></span>
        <span class="hint"><i class="kc kc-arrow up"></i><i class="kc kc-arrow down"></i><em>Choose</em></span>
        <span class="hint"><i class="kc">ENTER</i><em>Next · buy</em></span>
        <span class="hint"><i class="kc">ESC</i><em>Close</em></span>
        <span class="hint"><em>Drag to turn</em></span>
      </div>`;
    this.renderStep(true);
    this.bind();
  }

  renderStep(full) {
    const v = this.view, c = this.cfg, s = STEPS[this.step].id, list = this.el.querySelector('.cr-list'), r = this.rows();
    this.el.querySelectorAll('[data-step]').forEach((b, i) => { b.classList.toggle('on', i === this.step); b.classList.toggle('done', i < this.step); });
    if (r) {
      if (full || !list.querySelector('.os-row')) {
        let last = '';
        list.innerHTML = r.list.map((o, i) => {
          const head = o.group && o.group !== last ? `<div class="cr-group">${esc((last = o.group).toUpperCase())}</div>` : '';
          return `${head}<button class="os-row paper" tabindex="-1" data-row="${esc(o.id)}" style="--clip:${brushClip(600 + i * 7, 4, 3)};animation-delay:${40 + i * 22}ms">
            ${o.sw}<span class="os-main"><b class="os-name">${esc(o.name)}</b><small class="os-sub">${esc(o.sub)}</small></span>
            ${o.tag ? `<em class="os-tag worn">${o.tag}</em>` : ''}<b class="os-price">${esc(o.price)}</b></button>`;
        }).join('');
        list.querySelectorAll('.os-row').forEach((b) => {
          b.addEventListener('mouseenter', () => b.classList.add('hover'));
          b.addEventListener('mouseleave', () => b.classList.remove('hover'));
          b.addEventListener('click', () => this.pick(b.dataset.row));
          b.addEventListener('dblclick', () => this.next());
        });
      }
      list.querySelectorAll('.os-row').forEach((b) => b.classList.toggle('sel', b.dataset.row === r.on));
      list.querySelector('.os-row.sel')?.scrollIntoView?.({ block: 'nearest' });
      // (the car's own swatch shows the paint you chose)
    } else if (s === 'plate') {
      list.innerHTML = `<div class="cr-plate-wrap">
          <div class="cr-plate"><i class="cr-ch"></i><input class="cr-plate-in" maxlength="8" spellcheck="false" autocomplete="off" value="${esc(c.plate)}"><i class="cr-ch cr-ct"></i></div>
          <div class="cr-plate-acts">
            <button class="brush-btn mid cr-mini" data-random tabindex="-1">${brushSVG(391, 220, 60, { fill: '#dfe7fb' })}<span>RANDOM</span></button>
            <span class="cr-plate-note${this.plateTaken ? ' taken' : ''}">${this.plateTaken ? esc(this.plateTakenText(c.plate)) : c.custom ? `Your own text · ${plus(PLATE_COST)}` : 'A random local plate · included'}</span>
          </div>
          <p class="os-note">Type your own: 1 to 8 letters and digits. It goes on the front and the back.</p>
        </div>`;
      const inp = list.querySelector('.cr-plate-in');
      inp.addEventListener('input', () => {
        const t = cleanPlate(inp.value);
        if (t !== inp.value) inp.value = t;
        if (!t.replace(/[ -]/g, '')) return;
        this.cfg.plate = t; this.cfg.custom = true;
        this.checkPlate(t);
        this.preview(); this.renderDetail();
      });
      list.querySelector('[data-random]').addEventListener('click', () => {
        this.cfg.plate = randomPlate(); this.cfg.custom = false; inp.value = this.cfg.plate;
        this.plateTaken = false; this.plateMine = false; this.plateNote();
        if (this.view.plateIssue) this.issuePlate(); // (multiplayer: one nobody has)
        this.audio?.play?.('tick'); this.preview(); this.renderDetail();
      });
      setTimeout(() => { inp.focus(); inp.select(); }, 30);
    } else {
      // the summary: every choice and what it costs
      const car = v.cars.find((o) => o.id === c.id), p = paintOf(c.paint), w = rimOf(c.rims), cost = v.cost(c);
      const line = (k, name, price, sw = '') => `<div class="cr-sum-row"${k >= 0 ? ` data-go="${k}"` : ' data-fixed'}>${sw}<span><small>${k >= 0 ? STEPS[k].label : 'CAR'}</small><b>${esc(name)}</b></span><em>${esc(price)}</em></div>`;
      list.innerHTML = `<div class="cr-sum paper" style="--clip:${brushClip(733, 4, 3)}">
          ${line(-1, car.label, money(car.price))}
          ${line(0, `${p.label} · ${FINISH[p.finish].label}`, plus(FINISH[p.finish].cost), `<i class="os-sw cr-sw-paint ${p.finish}" style="--c:${css(p.hex)}"></i>`)}
          ${line(1, w.label, plus(w.cost))}
          ${line(2, c.plate, c.custom ? plus(PLATE_COST) : 'Included')}
          <div class="cr-sum-tot"><span>TOTAL</span><b>${money(cost.total)}</b></div>
          <ul class="cr-terms"><li>Yours for good · it waits in your bay at the Autohaus · E to drive</li><li>Up to ${v.garageMax || 10} cars, the same model more than once too · each its own plate · one out at a time (MY CARS: pick which) · sell one back for half what you paid</li><li>Dents and damage: the Werkstatt next door repairs it · up to <b>${money(v.repairFull ?? 1700)}</b> (15 % of the list price at 100 % damage)</li><li>Wreck it: <b>${money(v.wreckFee ?? 3200)}</b> (tow ${money(v.towFee ?? 1500)} + full repair) · the tow truck brings it back repaired · rammed off by the police: not repaired, it is gone</li></ul>
        </div>
        ${v.garage?.length ? `<div class="cr-sum cr-garage paper" style="--clip:${brushClip(741, 4, 3)}"><div class="cr-group">MY CARS · <b>${v.garage.length} / ${v.garageMax || 10}</b></div>${v.garage.map((g) => `<div class="cr-sum-row${g.id === c.id ? ' mine' : ''}" data-car="${esc(g.plate)}"><i class="os-sw cr-sw-paint ${paintOf(g.paint).finish}" style="--c:${css(paintOf(g.paint).hex)}"></i><span><small>${esc(g.plate)} · ${esc(paintOf(g.paint).label)} · RESALE ${money(g.value)}</small><b>${esc(g.label)}</b></span><em>${g.out ? 'IN YOUR BAY' : 'TAKE OUT'}</em><button class="cr-car-sell${this.sellArm === g.plate ? ' armed' : ''}" tabindex="-1" data-sell="${esc(g.plate)}">${this.sellArm === g.plate ? `SURE? +${money(g.value)}` : 'SELL'}</button></div>`).join('')}</div>` : ''}`;
      list.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => this.go(+b.dataset.go)));
      list.querySelectorAll('[data-sell]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); this.sell(b.dataset.sell); }));
      list.querySelectorAll('[data-car]').forEach((b) => b.addEventListener('click', () => {
        const g = v.garage.find((x) => x.plate === b.dataset.car);
        if (!g || g.out) { this.shake(); this.audio?.play?.('error'); return; }
        this.close('takeout'); v.takeOut?.(g.plate);
      }));
    }
    this.renderDetail();
  }

  renderDetail() {
    const v = this.view, c = this.cfg, s = STEPS[this.step], cost = v.cost(c), last = this.step === STEPS.length - 1;
    const car = v.cars.find((o) => o.id === c.id), full = last && this.full();
    const broke = last && v.money < cost.total;
    const title = { paint: paintOf(c.paint).label, rims: rimOf(c.rims).label, plate: c.plate, sum: car.label }[s.id];
    // (the label: one short word, the step it leads to small underneath; BUY with its price (another one of a model you
    // own too); your cars: MY CARS on the summary)
    const taken = last && this.plateTaken;
    const label = last ? (full ? 'GARAGE FULL' : taken ? 'PLATE TAKEN' : broke ? 'NOT ENOUGH MONEY' : `BUY${v.owned ? ' ANOTHER' : ''} · ${money(cost.total)}`) : `NEXT<small>${STEPS[this.step + 1].label}</small>`;
    const ready = !(last && (full || broke || taken));
    const det = this.el.querySelector('.cr-detail');
    det.innerHTML = `
      <div class="os-kicker">${esc(car.label.toUpperCase())}${v.owned ? ` · YOU HAVE ${v.owned}` : ''} · STEP ${this.step + 1} OF ${STEPS.length} · ${s.one}</div>
      <div class="os-title">${esc(title)}</div>
      <div class="cr-bill">
        <span class="cr-bill-l"><small>${esc(car.label)} ${money(cost.base)}${cost.extras ? ` · extras ${money(cost.extras)}` : ''}</small><b>${money(cost.total)}</b></span>
        <span class="cr-bill-r"><small>YOUR MONEY</small><b>${money(v.money)}</b></span>
      </div>
      <div class="os-actrow cr-actrow">
        ${this.step ? `<button class="brush-btn mid cr-back" tabindex="-1">${brushSVG(379, 120, 74, { fill: '#dfe7fb' })}<span>BACK</span></button>` : ''}
        <button class="brush-btn mid os-act${ready ? ' ready' : ''}" tabindex="-1">${brushSVG(377, 300, 74, { fill: ready ? (last ? '#c8261c' : '#1546c8') : '#dfe7fb' })}<span class="${last ? '' : 'cr-next'}">${label}</span></button>
      </div>`;
    det.querySelector('.os-act').addEventListener('click', () => (last ? this.rent() : this.next()));
    det.querySelector('.cr-back')?.addEventListener('click', () => this.go(this.step - 1));
  }

  bind() {
    this.el.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => this.go(+b.dataset.step)));
    const drag = this.el.querySelector('.cr-drag');
    let last = null;
    drag.addEventListener('pointerdown', (e) => { last = [e.clientX, e.clientY]; drag.setPointerCapture?.(e.pointerId); drag.classList.add('dragging'); });
    drag.addEventListener('pointermove', (e) => { if (!last) return; this.view?.drag?.((e.clientX - last[0]) * 0.008, (e.clientY - last[1]) * 0.006); last = [e.clientX, e.clientY]; });
    const end = () => { last = null; drag.classList.remove('dragging'); };
    drag.addEventListener('pointerup', end); drag.addEventListener('pointercancel', end);
    this.el.addEventListener('mousedown', (e) => { if (e.target.closest?.('button')) e.preventDefault(); });
  }

  key(e) {
    if (!this.view) return;
    const typing = e.target?.classList?.contains('cr-plate-in');
    if (e.code === 'Escape') { e.preventDefault(); e.stopPropagation(); if (!e.repeat) this.close(); return; }
    if (typing) {
      e.stopPropagation(); // (the game never sees what you type; the field does)
      if (e.code === 'Enter' || e.code === 'NumpadEnter') { e.preventDefault(); e.target.blur(); this.next(); }
      else if (e.code === 'ArrowDown' || e.code === 'ArrowUp' || e.code === 'Tab') { e.preventDefault(); e.target.blur(); }
      return;
    }
    if (!KEYS.has(e.code)) return;
    e.preventDefault(); e.stopPropagation();
    if (performance.now() - this.openedAt < 250 && !e.repeat && e.code === 'Enter') return;
    const c = e.code;
    if (c === 'ArrowUp' || c === 'KeyW') this.move(-1);
    else if (c === 'ArrowDown' || c === 'KeyS') this.move(1);
    else if (c === 'ArrowLeft' || c === 'KeyA') this.go(this.step - 1);
    else if (c === 'ArrowRight' || c === 'KeyD' || c === 'Tab') this.go(this.step + 1);
    else if (!e.repeat) this.next();
  }
}
