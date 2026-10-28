// The build-mode furniture catalogue: a column on the right in the menus' brush style (white paper, blue
// italic lettering, red markers), a rendered thumbnail of every Meshy model with its name and price, grouped by
// room. Browse it with the mouse: wheel over it scrolls, click a room tab, click a card to take it in hand.
// You keep walking (WASD) while it is open. Key hints run along the bottom, with the look / cursor mode chip.
import './buildmenu.css';
import { brushSVG, brushClip } from './menu.js';
import { CATEGORIES, FURNITURE } from '../game/build/catalog.js';
import { getThumb } from '../game/build/furniture.js';

const fmt = (n) => n.toLocaleString('en-US');
const kc = (k) => `<i class="kc">${k}</i>`;
const hint = (keys, label) => `<span class="hint">${keys}<em>${label}</em></span>`;

export class BuildMenu {
  constructor({ onSelect }) {
    this.onSelect = onSelect;
    this.index = -1; // selected index into FURNITURE (-1: nothing in hand)
    const el = (this.el = document.createElement('div'));
    el.id = 'build-menu';
    el.hidden = true;
    let seed = 700;
    el.innerHTML = `
      <div class="menu-title" style="width:calc(var(--u) * 230)">${brushSVG(7123, 250, 80)}<span>FURNISH</span></div>
      <div class="bm-sub"><span>Your chalet</span><span class="bm-money"></span></div>
      <div class="seg-brush bm-tabs">${CATEGORIES.map((c) => `<button tabindex="-1" data-cat="${c.id}">${c.name}</button>`).join('')}</div>
      <div class="bm-list">${CATEGORIES.map((c) => `
        <div class="bm-cat" data-cat-head="${c.id}">${c.name}</div>
        <div class="bm-grid">${FURNITURE.filter((f) => f.category === c.id).map((f) => `
          <div class="bm-card paper" data-id="${f.id}" style="--clip:${brushClip(seed++, 3, 4)}">
            <img class="bm-thumb loading" alt="" data-thumb="${f.id}">
            <div class="bm-name">${f.name}</div><div class="bm-price">$${fmt(f.price)}</div>
          </div>`).join('')}</div>`).join('')}
      </div>
      <div class="bm-status paper" style="--clip:${brushClip(911, 4, 4)}"></div>`;
    this.foot = document.createElement('div');
    this.foot.id = 'build-foot';
    this.foot.hidden = true;
    this.flashEl = Object.assign(document.createElement('div'), { id: 'build-flash' });
    this.cross = Object.assign(document.createElement('div'), { id: 'build-cross', hidden: true });
    document.body.append(el, this.foot, this.flashEl, this.cross);
    this.list = el.querySelector('.bm-list');
    this.statusEl = el.querySelector('.bm-status');
    this.cards = new Map([...el.querySelectorAll('.bm-card')].map((c) => [c.dataset.id, c]));
    el.addEventListener('mousedown', (e) => e.preventDefault()); // keep keyboard focus on the game
    el.addEventListener('click', (e) => {
      const card = e.target.closest('.bm-card');
      if (card) {
        const i = FURNITURE.findIndex((f) => f.id === card.dataset.id);
        return this.select(i === this.index ? -1 : i, false); // click the one in hand again: put it down
      }
      const tab = e.target.closest('.bm-tab, .bm-tabs button');
      if (tab) this.jumpCategory(tab.dataset.cat);
    });
    this.list.addEventListener('scroll', () => this.syncTabs(), { passive: true });
    this.setMode('cursor');
    this.refreshThumbs();
  }

  show(on) { this.el.hidden = !on; this.foot.hidden = !on; if (on) { this.refreshThumbs(); this.syncTabs(); } else this.cross.hidden = true; }
  /** Is this DOM node part of the menu (wheel / clicks over it belong to the menu, not the room)? */
  owns(node) { return !!node && this.el.contains(node); }

  /** 'cursor': mouse free to click the menu and place; 'look': mouse look (pointer locked). */
  setMode(mode) {
    this.mode = mode;
    this.cross.hidden = this.el.hidden || mode !== 'look';
    document.body.classList.toggle('build-cursor', mode === 'cursor' && !this.el.hidden);
    const look = mode === 'look';
    this.foot.innerHTML = [
      `<span class="bm-mode paper ${look ? 'look' : ''}" style="--clip:${brushClip(321, 4, 4)}">${look ? 'LOOK AROUND' : 'CURSOR'}</span>`,
      hint(kc('TAB'), look ? 'Free the mouse' : 'Look around'),
      look ? '' : hint(kc('RMB'), 'Hold to look'),
      hint(kc('WASD'), 'Walk'),
      hint(kc(look ? 'CLICK' : 'CLICK'), 'Buy &amp; place'),
      hint(kc('R') + kc('WHEEL'), 'Rotate'),
      hint(kc('Q'), 'Move'),
      hint(kc('X'), 'Sell 50%'),
      hint(kc('⌫'), 'Empty hand'),
      hint(kc('F'), 'Done'),
    ].join('');
  }

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
    if (this.statusEl.textContent !== (text || '')) this.statusEl.textContent = text || '';
    this.statusEl.classList.toggle('bad', bad);
  }

  /** Highlight the tab of the room whose cards are at the top of the scrolled list. */
  syncTabs() {
    const top = this.list.scrollTop + 8;
    let cur = CATEGORIES[0].id;
    for (const h of this.el.querySelectorAll('[data-cat-head]')) if (h.offsetTop - this.list.offsetTop <= top) cur = h.dataset.catHead;
    for (const t of this.el.querySelectorAll('.bm-tabs button')) t.classList.toggle('on', t.dataset.cat === cur);
  }
  jumpCategory(cat) {
    const head = this.el.querySelector(`[data-cat-head="${cat}"]`);
    if (head) this.list.scrollTo({ top: head.offsetTop - this.list.offsetTop - 4, behavior: 'smooth' });
  }

  select(i, scroll = true) {
    if (this.index >= 0) this.cards.get(FURNITURE[this.index].id)?.classList.remove('sel');
    this.index = i;
    if (i >= 0) {
      const card = this.cards.get(FURNITURE[i].id);
      card.classList.add('sel');
      if (scroll) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    this.onSelect?.(i >= 0 ? FURNITURE[i] : null);
  }

  /** Red flash on screen and a shake of the card (not enough money / doesn't fit). */
  deny(id) {
    const card = id && this.cards.get(id);
    if (card) { card.classList.remove('deny'); void card.offsetWidth; card.classList.add('deny'); }
    this.flashEl.classList.add('on');
    requestAnimationFrame(() => requestAnimationFrame(() => this.flashEl.classList.remove('on')));
  }
}
