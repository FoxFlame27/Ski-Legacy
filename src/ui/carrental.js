// The CAR RENTAL counter (src/game/carrental.js): E at a car on display or at the clerk opens the rental card, in the
// job board's style (a warm wooden frame, a paper card, brush buttons): the five models down the left (name, what it
// is, the day rate), the chosen one's paint swatches, the price and RENT. Your current rental shows as "IN THE YARD".
// It blocks the game like a panel (hud.setBlocking); Esc or a click beside it closes it.
//   open({ cars: [{ id, label, kind, price, length }], paints: [{ id, label, hex }], pick: id, paint: id,
//          money, current: { id, paint } | null, rent(id, paint), close() })
import './jobboard.css'; // (its brush buttons)
import './carrental.css';
import { brushSVG, esc } from './menu.js';

const money = (v) => `$${Math.round(v || 0).toLocaleString('en-US')}`;
const css = (hex) => `#${hex.toString(16).padStart(6, '0')}`;

export class CarRentalUI {
  constructor({ hud = null, audio = null } = {}) {
    Object.assign(this, { hud, audio });
    this.view = null; this.el = null;
    this.onKey = (e) => { if (this.view && e.code === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(); } };
  }
  get isOpen() { return !!this.view; }

  open(view) {
    if (!this.el) { this.el = document.createElement('div'); this.el.id = 'carrental'; this.el.hidden = true; document.body.appendChild(this.el); this.el.addEventListener('click', (e) => this.click(e)); }
    this.view = view;
    this.render();
    this.el.hidden = false;
    this.hud?.setBlocking?.('carrental', true);
    document.exitPointerLock?.();
    addEventListener('keydown', this.onKey, true);
    this.audio?.play?.('click');
  }

  close(how = 'close') {
    if (!this.view) return;
    const v = this.view;
    this.view = null;
    this.el.hidden = true; this.el.innerHTML = '';
    this.hud?.setBlocking?.('carrental', false);
    removeEventListener('keydown', this.onKey, true);
    v.close?.(how);
  }

  click(e) {
    const v = this.view;
    if (!v) return;
    if (!e.target.closest('.cr-board')) { this.audio?.play?.('click'); this.close(); return; }
    const car = e.target.closest('[data-car]'), paint = e.target.closest('[data-paint]');
    if (car) { v.pick = car.dataset.car; this.audio?.play?.('click'); this.render(); return; }
    if (paint) { v.paint = paint.dataset.paint; this.audio?.play?.('click'); this.render(); return; }
    if (e.target.closest('[data-close]')) { this.audio?.play?.('click'); this.close(); return; }
    if (e.target.closest('[data-rent]')) { const id = v.pick, p = v.paint, f = v.rent; this.close('rent'); f?.(id, p); }
  }

  render() {
    const v = this.view, c = v.cars.find((o) => o.id === v.pick) || v.cars[0], p = v.paints.find((o) => o.id === v.paint) || v.paints[0];
    const cur = v.current, same = cur && cur.id === c.id && cur.paint === p.id, broke = v.money < c.price;
    const list = v.cars.map((o) => `<button class="cr-car${o.id === c.id ? ' on' : ''}" data-car="${o.id}">
        <span class="cr-name">${esc(o.label)}</span><span class="cr-kind">${esc(o.kind)}</span><b>${money(o.price)}</b>
        ${cur?.id === o.id ? '<i class="cr-tag">IN THE YARD</i>' : ''}</button>`).join('');
    const swatches = v.paints.map((o) => `<button class="cr-sw${o.id === p.id ? ' on' : ''}" data-paint="${o.id}" title="${esc(o.label)}" style="--sw:${css(o.hex)}"></button>`).join('');
    this.el.innerHTML = `<div class="cr-board">
      <div class="cr-plank">CAR RENTAL <em>· Legacy Village</em></div>
      <div class="cr-body">
        <div class="cr-list">${list}</div>
        <div class="cr-card">
          <div class="cr-kicker">${esc(c.kind)} · ${c.length.toFixed(1)} m</div>
          <h3 class="cr-title">${esc(c.label)}</h3>
          <div class="cr-paint"><span>Paint</span><b>${esc(p.label)}</b></div>
          <div class="cr-sws">${swatches}</div>
          <ul class="cr-terms"><li>Waits for you in the yard out front · E to drive</li><li>One car at a time: renting another returns this one</li><li>Wreck it and it costs <b>$1,000</b> · the tow truck fetches it</li></ul>
          <div class="cr-price"><span>Rental</span><b>${money(c.price)}</b></div>
          <div class="cr-acts">
            <button class="jb-btn cr-btn" data-rent ${same || broke ? 'disabled' : ''}>${brushSVG(81, 300, 60, { fill: '#1546c8' })}<span>${same ? 'ALREADY YOURS' : broke ? 'NOT ENOUGH MONEY' : `RENT · ${money(c.price)}`}</span></button>
            <button class="jb-btn light cr-btn" data-close>${brushSVG(82, 300, 60, { fill: '#e9eefb' })}<span>NOT NOW</span></button>
          </div>
        </div>
      </div></div>`;
  }
}
