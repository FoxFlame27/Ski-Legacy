// The CAR RENTAL configurator (src/game/carrental.js), in the ski shop's outfit designer style (ui/outfitshop.js: white
// brush paper, blue italic condensed lettering, red accents, the live 3D preview to the right): step by step, CAR ·
// PAINT · INTERIOR · WHEELS · PLATE · SUMMARY, then RENT. Every choice shows at once on the real car on its showroom
// turntable (the camera swings round to it; the interior from the driver's seat; drag to turn). Keyboard + mouse:
// left / right a step, up / down a choice, Enter next (RENT on the summary), Esc closes; on the plate you type.
//   open({ cars: [{ id, label, kind, price, length }], cfg, current: cfg | null, money, cost(cfg) -> { base, extras, total },
//          preview(cfg, step), drag(dx, dy), rent(cfg), close() })
import './outfitshop.css'; // (its rows, tabs, detail card)
import './carrental.css';
import { brushSVG, brushClip, esc } from './menu.js';
import { PAINTS, INTERIORS, RIMS, FINISH, PLATE_COST, paintOf, interiorOf, rimOf, cleanPlate, randomPlate } from '../game/carconfig.js';

const STEPS = [
  { id: 'car', label: 'CAR', one: 'THE CAR' }, { id: 'paint', label: 'PAINT', one: 'PAINT' }, { id: 'interior', label: 'INTERIOR', one: 'INTERIOR' },
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
    this.cfg = { ...view.cfg };
    this.step = view.step || 0;
    this.openedAt = performance.now();
    this.render(true);
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
    const v = this.view;
    this.view = null;
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
    if (s === 'car') return { list: v.cars.map((o) => ({ id: o.id, name: o.label, sub: `${o.kind} · ${o.length.toFixed(1)} m`, price: money(o.price), sw: `<i class="os-sw cr-sw-car" style="--c:${css(paintOf(c.paint).hex)}"></i>`, tag: v.current?.id === o.id ? 'IN THE YARD' : '' })), on: c.id, key: 'id' };
    if (s === 'paint') return { list: PAINTS.map((p) => ({ id: p.id, name: p.label, sub: FINISH[p.finish].label, price: plus(FINISH[p.finish].cost), sw: `<i class="os-sw cr-sw-paint ${p.finish}" style="--c:${css(p.hex)}"></i>`, group: FINISH[p.finish].label })), on: c.paint, key: 'paint' };
    if (s === 'interior') return { list: INTERIORS.map((t) => ({ id: t.id, name: t.label, sub: t.sub, price: plus(t.cost), sw: t.amt ? `<i class="os-sw cr-sw-trim${t.pattern ? ' pat' : ''}" style="--c:${css(t.hex)};--a:${css(t.accent || t.hex)}"></i>` : '<i class="os-sw os-sw-orig"></i>' })), on: c.interior, key: 'interior' };
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
  rent() {
    const v = this.view, c = { ...this.cfg }, cost = v.cost(c);
    if (v.money < cost.total) { this.shake(); this.audio?.play?.('error'); return; }
    this.close('rent');
    v.rent?.(c);
  }
  shake() { const b = this.el.querySelector('.os-act'); b?.classList.remove('nope'); void b?.offsetWidth; b?.classList.add('nope'); }

  // ---------------------------------------------------------------- DOM
  render(first) {
    this.el.innerHTML = `
      <div class="os-shade"></div>
      <div class="os-drag cr-drag" aria-hidden="true"></div>
      <div class="os-col cr-col${first ? ' in' : ''}">
        <div class="menu-head os-head">
          <div class="menu-title" style="width:calc(var(--u) * 330)">${brushSVG(4327, 360, 100)}<span>CAR RENTAL</span></div>
          <div class="menu-sub">Build the car you drive</div>
        </div>
        <div class="seg-brush os-tabs cr-steps">${STEPS.map((t, i) => `<button tabindex="-1" data-step="${i}" class="${i === this.step ? 'on' : ''}${i < this.step ? ' done' : ''}"><i>${i + 1}</i>${t.label}</button>`).join('')}</div>
        <div class="os-list cr-list"></div>
        <div class="os-detail cr-detail paper" style="--clip:${brushClip(517, 5, 4)}"></div>
      </div>
      <div class="os-foot">
        <span class="hint"><i class="kc kc-arrow left"></i><i class="kc kc-arrow right"></i><em>Step</em></span>
        <span class="hint"><i class="kc kc-arrow up"></i><i class="kc kc-arrow down"></i><em>Choose</em></span>
        <span class="hint"><i class="kc">ENTER</i><em>Next · rent</em></span>
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
            <span class="cr-plate-note">${c.custom ? `Your own text · ${plus(PLATE_COST)}` : 'A random local plate · included'}</span>
          </div>
          <p class="os-note">Type your own: 1 to 8 letters and digits. It goes on the front and the back.</p>
        </div>`;
      const inp = list.querySelector('.cr-plate-in');
      inp.addEventListener('input', () => {
        const t = cleanPlate(inp.value);
        if (t !== inp.value) inp.value = t;
        if (!t.replace(/[ -]/g, '')) return;
        this.cfg.plate = t; this.cfg.custom = true;
        list.querySelector('.cr-plate-note').textContent = `Your own text · ${plus(PLATE_COST)}`;
        this.preview(); this.renderDetail();
      });
      list.querySelector('[data-random]').addEventListener('click', () => {
        this.cfg.plate = randomPlate(); this.cfg.custom = false; inp.value = this.cfg.plate;
        list.querySelector('.cr-plate-note').textContent = 'A random local plate · included';
        this.audio?.play?.('tick'); this.preview(); this.renderDetail();
      });
      setTimeout(() => { inp.focus(); inp.select(); }, 30);
    } else {
      // the summary: every choice and what it costs
      const car = v.cars.find((o) => o.id === c.id), p = paintOf(c.paint), t = interiorOf(c.interior), w = rimOf(c.rims), cost = v.cost(c);
      const line = (k, name, price, sw = '') => `<div class="cr-sum-row" data-go="${k}">${sw}<span><small>${STEPS[k].label}</small><b>${esc(name)}</b></span><em>${esc(price)}</em></div>`;
      list.innerHTML = `<div class="cr-sum paper" style="--clip:${brushClip(733, 4, 3)}">
          ${line(0, car.label, money(car.price))}
          ${line(1, `${p.label} · ${FINISH[p.finish].label}`, plus(FINISH[p.finish].cost), `<i class="os-sw cr-sw-paint ${p.finish}" style="--c:${css(p.hex)}"></i>`)}
          ${line(2, t.label, plus(t.cost))}
          ${line(3, w.label, plus(w.cost))}
          ${line(4, c.plate, c.custom ? plus(PLATE_COST) : 'Included')}
          <div class="cr-sum-tot"><span>TOTAL</span><b>${money(cost.total)}</b></div>
          <ul class="cr-terms"><li>Waits in the yard out front · E to drive</li><li>One car at a time: renting another returns yours</li><li>Wreck it and it costs <b>$1,000</b> · the tow truck fetches it</li></ul>
        </div>`;
      list.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => this.go(+b.dataset.go)));
    }
    this.renderDetail();
  }

  renderDetail() {
    const v = this.view, c = this.cfg, s = STEPS[this.step], cost = v.cost(c), last = this.step === STEPS.length - 1;
    const car = v.cars.find((o) => o.id === c.id);
    const same = v.current && ['id', 'paint', 'interior', 'rims', 'plate'].every((k) => v.current[k] === c[k]);
    const broke = last && v.money < cost.total;
    const title = { car: car.label, paint: paintOf(c.paint).label, interior: interiorOf(c.interior).label, rims: rimOf(c.rims).label, plate: c.plate, sum: car.label }[s.id];
    const label = last ? (same ? 'ALREADY YOURS' : broke ? 'NOT ENOUGH MONEY' : `RENT · ${money(cost.total)}`) : `NEXT · ${STEPS[this.step + 1].label}`;
    const ready = !(last && (same || broke));
    const det = this.el.querySelector('.cr-detail');
    det.innerHTML = `
      <div class="os-kicker">STEP ${this.step + 1} OF ${STEPS.length} · ${s.one}</div>
      <div class="os-title">${esc(title)}</div>
      <div class="cr-bill"><span>${esc(car.label)} ${money(cost.base)}${cost.extras ? ` · extras ${money(cost.extras)}` : ''}</span><b>${money(cost.total)}</b></div>
      <div class="os-actrow">
        ${this.step ? `<button class="brush-btn mid cr-back" tabindex="-1">${brushSVG(379, 120, 74, { fill: '#dfe7fb' })}<span>BACK</span></button>` : ''}
        <button class="brush-btn mid os-act${ready ? ' ready' : ''}" tabindex="-1" ${last && same ? 'disabled' : ''}>${brushSVG(377, 300, 74, { fill: ready ? (last ? '#c8261c' : '#1546c8') : '#dfe7fb' })}<span>${label}</span></button>
        <div class="os-wallet"><span>YOUR MONEY</span><b>${money(v.money)}</b></div>
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
