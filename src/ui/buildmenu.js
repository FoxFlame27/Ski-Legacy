// The build-mode furniture catalog: a scrollable panel on the right with a rendered thumbnail of every
// Meshy model, its name and price, grouped by room. You keep walking while it is open (no pointer
// unlock needed: wheel / arrow keys browse it; with the cursor free you can also click cards).
import './buildmenu.css';
import { CATEGORIES, FURNITURE } from '../game/build/catalog.js';
import { getThumb } from '../game/build/furniture.js';

const fmt = (n) => n.toLocaleString('en-US');

export class BuildMenu {
  constructor({ onSelect }) {
    this.onSelect = onSelect;
    this.index = -1; // selected index into FURNITURE (-1: nothing in hand)
    const el = (this.el = document.createElement('div'));
    el.id = 'build-menu';
    el.hidden = true;
    el.innerHTML = `
      <div class="bm-head"><span class="bm-title">Build mode</span><span class="bm-money"></span></div>
      <div class="bm-tabs">${CATEGORIES.map((c) => `<button class="bm-tab" data-cat="${c.id}">${c.name}</button>`).join('')}</div>
      <div class="bm-status"></div>
      <div class="bm-list">${CATEGORIES.map((c) => `
        <div class="bm-cat" data-cat-head="${c.id}">${c.name}</div>
        <div class="bm-grid">${FURNITURE.filter((f) => f.category === c.id).map((f) => `
          <div class="bm-card" data-id="${f.id}">
            <img class="bm-thumb loading" alt="" data-thumb="${f.id}">
            <div class="bm-name">${f.name}</div><div class="bm-price">$${fmt(f.price)}</div>
          </div>`).join('')}</div>`).join('')}
      </div>
      <div class="bm-keys">
        <b>Wheel</b>/<b>↑</b><b>↓</b> browse · <b>←</b><b>→</b> room<br>
        <b>Click</b>/<b>Enter</b> buy &amp; place · <b>R</b> rotate (hold <b>R</b>+wheel: fine)<br>
        <b>Q</b> move · <b>X</b> sell (50%) · <b>RMB</b>/<b>⌫</b> empty hand · <b>F</b> exit
      </div>`;
    this.flashEl = Object.assign(document.createElement('div'), { id: 'build-flash' });
    this.cross = Object.assign(document.createElement('div'), { id: 'build-cross', hidden: true });
    document.body.append(el, this.flashEl, this.cross);
    this.list = el.querySelector('.bm-list');
    this.cards = new Map([...el.querySelectorAll('.bm-card')].map((c) => [c.dataset.id, c]));
    el.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus / pointer lock on the game
    el.addEventListener('click', (e) => {
      const card = e.target.closest('.bm-card');
      if (card) return this.select(FURNITURE.findIndex((f) => f.id === card.dataset.id));
      const tab = e.target.closest('.bm-tab');
      if (tab) this.jumpCategory(tab.dataset.cat);
    });
    this.refreshThumbs();
  }

  show(on) { this.el.hidden = !on; this.cross.hidden = !on; if (on) this.refreshThumbs(); }

  refreshThumbs() {
    for (const img of this.el.querySelectorAll('img[data-thumb]')) {
      const url = getThumb(img.dataset.thumb);
      if (url && img.src !== url) { img.src = url; img.classList.remove('loading'); }
    }
  }
  setThumb(id, url) {
    const img = this.el.querySelector(`img[data-thumb="${id}"]`);
    if (img) { img.src = url; img.classList.remove('loading'); }
  }

  setMoney(money) {
    this.el.querySelector('.bm-money').textContent = `$${fmt(money)}`;
    for (const f of FURNITURE) this.cards.get(f.id).classList.toggle('short', money < f.price);
  }
  status(text, bad = false) {
    const s = this.el.querySelector('.bm-status');
    s.textContent = text || '';
    s.classList.toggle('bad', bad);
  }

  /** Move the selection by `d` items (wraps). */
  step(d) {
    const n = FURNITURE.length;
    this.select(this.index < 0 ? (d > 0 ? 0 : n - 1) : (this.index + d + n) % n);
  }
  stepCategory(d) {
    const cur = this.index < 0 ? -1 : CATEGORIES.findIndex((c) => c.id === FURNITURE[this.index].category);
    const next = CATEGORIES[(cur + d + CATEGORIES.length) % CATEGORIES.length];
    this.jumpCategory(next.id);
  }
  jumpCategory(cat) { this.select(FURNITURE.findIndex((f) => f.category === cat)); }

  select(i) {
    if (this.index >= 0) this.cards.get(FURNITURE[this.index].id)?.classList.remove('sel');
    this.index = i;
    for (const t of this.el.querySelectorAll('.bm-tab')) t.classList.toggle('on', i >= 0 && t.dataset.cat === FURNITURE[i].category);
    if (i >= 0) {
      const card = this.cards.get(FURNITURE[i].id);
      card.classList.add('sel');
      // keep the card in view (and its room header when it's the first of the room)
      const head = this.el.querySelector(`[data-cat-head="${FURNITURE[i].category}"]`);
      const first = FURNITURE.findIndex((f) => f.category === FURNITURE[i].category) === i;
      const top = (first ? head : card).offsetTop - this.list.offsetTop;
      const bottom = card.offsetTop - this.list.offsetTop + card.offsetHeight;
      if (top < this.list.scrollTop) this.list.scrollTop = top - 4;
      else if (bottom > this.list.scrollTop + this.list.clientHeight) this.list.scrollTop = bottom - this.list.clientHeight + 4;
    }
    this.onSelect?.(i >= 0 ? FURNITURE[i] : null);
  }

  /** Red flash on screen and on the card (not enough money). */
  deny(id) {
    const card = id && this.cards.get(id);
    if (card) { card.classList.remove('deny'); void card.offsetWidth; card.classList.add('deny'); }
    this.flashEl.classList.add('on');
    requestAnimationFrame(() => requestAnimationFrame(() => this.flashEl.classList.remove('on')));
  }
}
