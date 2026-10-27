// Outfit shop (the OUTFITS corner of the walk-in ski shop): jackets, trousers, helmets, goggle lenses and
// full kits for your skier. The shop camera swings round to your skier on the podium, so every row you
// pick is previewed live on the real 3D model; buy once, wear it on the man and the woman (each keeps its
// own look). Same house style as the menus: white brush paper, blue italic condensed lettering, red
// accents. Keyboard + mouse, Esc closes.
import './outfitshop.css';
import { brushSVG, brushClip, esc } from './menu.js';
import { OUTFIT_ITEMS, OUTFIT_KITS, OUTFIT_SLOTS, outfitItem, ownsOutfit, getEquipped, setEquipped, ensureOutfits } from '../game/outfits.js';

const TABS = [
  { id: 'jacket', label: 'JACKETS', one: 'JACKET' }, { id: 'trousers', label: 'TROUSERS', one: 'TROUSERS' }, { id: 'helmet', label: 'HELMETS', one: 'HELMET' },
  { id: 'lens', label: 'GOGGLES', one: 'GOGGLE LENS' }, { id: 'kit', label: 'KITS', one: 'FULL KIT' },
];
const FINISH = { matte: 'Matte', satin: 'Satin', gloss: 'Gloss', chrome: 'Chrome' };
const KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyS', 'KeyA', 'KeyD', 'Enter', 'NumpadEnter', 'Space', 'KeyE', 'Escape', 'Backspace']);
const money = (v) => `$${Math.round(v || 0).toLocaleString('en-US')}`;

/** Little CSS swatch for a row: two-tone tile, helmet dome, lens pill or kit stripes. */
function swatch(it, slot) {
  if (!it) return '<i class="os-sw os-sw-orig"></i>';
  if (slot === 'kit') return `<i class="os-sw os-sw-kit">${[it.jacket.base, it.jacket.accent, it.trousers.base, it.helmet.color, it.lens.tint].map((c) => `<b style="background:${c}"></b>`).join('')}</i>`;
  if (slot === 'helmet') return `<i class="os-sw os-sw-helmet ${it.finish}" style="--c:${it.color}"></i>`;
  if (slot === 'lens') return `<i class="os-sw os-sw-lens${it.mirror > 0.6 ? ' mirror' : ''}" style="--c:${it.tint}"></i>`;
  return `<i class="os-sw os-sw-tone" style="--a:${it.base};--b:${it.accent || it.base}"></i>`;
}

function subline(it, slot) {
  if (!it) return 'The original piece, free';
  if (slot === 'kit') return it.desc;
  if (slot === 'helmet') return `${FINISH[it.finish] || 'Gloss'} finish`;
  if (slot === 'lens') return it.mirror > 0.6 ? 'Mirror coating' : it.mirror > 0.2 ? 'Tinted lens' : 'Clear lens';
  if (it.kit) return 'From the ' + outfitItem(it.kit).name + ' kit';
  return it.accent && it.accent !== it.base ? 'Two-tone' : 'Solid';
}

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

export class OutfitShop {
  /**
   * @param {object} o
   * @param {object} o.save  the save object (save.outfits is created / repaired here)
   * @param {() => void} o.writeSave
   * @param {(amount: number) => boolean} o.spend  takes the money (shows "Not enough money" itself)
   * @param {object} [o.hud]  hud.setBlocking keeps gameplay input off while the shop is open
   * @param {{play(name: string): void}} [o.audio]
   * @param {import('../game/interior.js').ShopInterior} [o.interior]  podium preview + camera
   * @param {() => string} o.getCharacter  current player character id (the man's or the woman's model)
   * @param {(charId: string) => void} [o.onEquip]  the equipped outfit changed (dress the player's rig)
   * @param {() => void} [o.onClose]  e.g. lock the pointer again
   */
  constructor({ save, writeSave, spend, hud, audio, interior, getCharacter, onEquip, onClose }) {
    Object.assign(this, { save, writeSave, spend, hud, audio, interior, getCharacter, onEquip, onClose });
    this.el = container('outfit-shop');
    this.isOpen = false;
    this.tab = 0;
    this.fi = 0;
    this.keyHandler = (e) => this.onKey(e);
    ensureOutfits(save);
    interior?.attachOutfitShop?.(this);
    if (interior && !interior.attachOutfitShop) interior.outfitShop = this;
  }

  get charId() { return this.getCharacter?.() || 'skier_blue'; }

  /** Rows of the current tab: the original piece first (not for kits), then the catalogue. */
  rows() {
    const slot = TABS[this.tab].id;
    if (slot === 'kit') return OUTFIT_KITS.map((k) => ({ id: k.id, it: outfitItem(k.id), slot }));
    const items = OUTFIT_ITEMS.filter((it) => it.slot === slot).map((it) => ({ id: it.id, it, slot }));
    // pieces of kits you own can be worn on their own
    const kitPieces = OUTFIT_KITS.filter((k) => ownsOutfit(this.save, k.id)).map((k) => ({ id: `${k.id}.${slot}`, it: outfitItem(`${k.id}.${slot}`), slot }));
    return [{ id: null, it: null, slot }, ...kitPieces, ...items];
  }

  open() {
    if (this.isOpen) return;
    this.isOpen = true;
    this.equipped = getEquipped(this.save, this.charId);
    const zones = this.interior?.mannequinZones?.() || null;
    this.zones = zones;
    // start on the tab / row of what you wear
    this.tab = 0;
    this.selectRow(this.indexOfEquipped(), true);
    this.render(true);
    this.el.hidden = false;
    this.el.classList.remove('out');
    document.body.classList.add('outfit-open');
    this.hud?.setBlocking?.('outfits', true);
    document.exitPointerLock?.();
    this.interior?.outfitView?.(true);
    this.preview();
    this.openedAt = performance.now();
    addEventListener('keydown', this.keyHandler, true);
    this.audio?.play('click');
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    removeEventListener('keydown', this.keyHandler, true);
    this.el.classList.add('out');
    clearTimeout(this.hideT);
    this.hideT = setTimeout(() => { if (!this.isOpen) { this.el.hidden = true; this.el.innerHTML = ''; } }, 280);
    document.body.classList.remove('outfit-open');
    this.hud?.setBlocking?.('outfits', false);
    this.interior?.previewOutfit?.(getEquipped(this.save, this.charId));
    this.interior?.outfitView?.(false);
    this.audio?.play('click');
    this.onClose?.();
  }

  indexOfEquipped() {
    const slot = TABS[this.tab].id;
    const rows = this.rows();
    if (slot === 'kit') {
      const i = rows.findIndex((r) => OUTFIT_SLOTS.every((s) => this.equipped[s] === `${r.id}.${s}`));
      return Math.max(0, i);
    }
    return Math.max(0, rows.findIndex((r) => r.id === this.equipped[slot]));
  }

  selectRow(i, silent = false) {
    const n = this.rows().length;
    this.fi = ((i % n) + n) % n;
    if (!silent) { this.audio?.play('tick'); this.preview(); this.renderSelection(); }
  }

  switchTab(d) {
    this.tab = (this.tab + d + TABS.length) % TABS.length;
    this.fi = this.indexOfEquipped();
    this.audio?.play('tick');
    this.render(false);
    this.preview();
  }

  // the podium skier wears what you wear, with the selected row tried on
  preview() {
    const r = this.rows()[this.fi];
    const look = { ...this.equipped };
    if (r.slot === 'kit') for (const s of OUTFIT_SLOTS) look[s] = `${r.id}.${s}`;
    else look[r.slot] = r.id;
    // try-ons need no ownership: resolve straight to colours
    const resolved = {};
    for (const s of OUTFIT_SLOTS) resolved[s] = look[s] ? outfitItem(look[s]) : null;
    this.interior?.previewOutfit?.(resolved);
  }

  status(r) {
    if (r.slot === 'kit') {
      const owned = ownsOutfit(this.save, r.id);
      const worn = OUTFIT_SLOTS.every((s) => this.equipped[s] === `${r.id}.${s}`);
      return { owned, worn };
    }
    const owned = r.id === null || ownsOutfit(this.save, r.id);
    return { owned, worn: (this.equipped[r.slot] || null) === r.id };
  }

  act() {
    const r = this.rows()[this.fi];
    const st = this.status(r);
    if (st.worn) { this.audio?.play('tick'); return; }
    if (!st.owned) {
      const price = r.it.price;
      if (!this.spend?.(price)) { this.shake(); return; } // spend() shows "Not enough money"
      ensureOutfits(this.save).owned.push(r.id);
      this.hud?.flash?.(`${r.it.name} bought`, 'gold', 1800);
    } else this.audio?.play('click');
    setEquipped(this.save, this.charId, r.slot, r.id);
    this.writeSave?.();
    this.equipped = getEquipped(this.save, this.charId);
    this.onEquip?.(this.charId);
    this.render(false);
    this.preview();
    const btn = this.el.querySelector('.os-act');
    btn?.classList.remove('pop'); void btn?.offsetWidth; btn?.classList.add('pop');
  }

  shake() {
    const btn = this.el.querySelector('.os-act');
    btn?.classList.remove('nope'); void btn?.offsetWidth; btn?.classList.add('nope');
  }

  // ---------------------------------------------------------------- DOM

  render(first) {
    this.el.innerHTML = `
      <div class="os-shade"></div>
      <div class="os-drag" aria-hidden="true"></div>
      <div class="os-col${first ? ' in' : ''}">
        <div class="menu-head os-head">
          <div class="menu-title" style="width:calc(var(--u) * 252)">${brushSVG(4321, 280, 100)}<span>OUTFITS</span></div>
          <div class="menu-sub">Make your skier yours</div>
        </div>
        <div class="seg-brush os-tabs">${TABS.map((t, i) => `<button tabindex="-1" data-tab="${i}" class="${i === this.tab ? 'on' : ''}">${t.label}</button>`).join('')}</div>
        <div class="os-list"></div>
        <div class="os-detail paper" style="--clip:${brushClip(511, 5, 4)}"></div>
      </div>
      <div class="os-foot">
        <span class="hint"><i class="kc kc-arrow left"></i><i class="kc kc-arrow right"></i><em>Category</em></span>
        <span class="hint"><i class="kc kc-arrow up"></i><i class="kc kc-arrow down"></i><em>Choose</em></span>
        <span class="hint"><i class="kc">ENTER</i><em>Buy / wear</em></span>
        <span class="hint"><i class="kc">ESC</i><em>Close</em></span>
        <span class="hint"><em>Drag to turn</em></span>
      </div>`;
    this.renderList();
    this.renderSelection();
    this.bind();
  }

  renderList() {
    const list = this.el.querySelector('.os-list');
    list.innerHTML = this.rows().map((r, i) => {
      const st = this.status(r);
      const tag = st.worn ? '<em class="os-tag worn">WEARING</em>' : st.owned ? '<em class="os-tag">OWNED</em>' : `<b class="os-price">${money(r.it.price)}</b>`;
      return `<button class="os-row paper" tabindex="-1" data-row="${i}" style="--clip:${brushClip(600 + i * 7, 4, 3)};animation-delay:${60 + i * 35}ms">
          ${swatch(r.it, r.slot)}
          <span class="os-main"><b class="os-name">${esc(r.it ? r.it.name : 'Original')}</b><small class="os-sub">${esc(subline(r.it, r.slot))}</small></span>
          ${tag}</button>`;
    }).join('');
    list.querySelectorAll('.os-row').forEach((b) => {
      b.addEventListener('mouseenter', () => b.classList.add('hover'));
      b.addEventListener('mouseleave', () => b.classList.remove('hover'));
      b.addEventListener('click', () => { const i = +b.dataset.row; if (i !== this.fi) this.selectRow(i); });
      b.addEventListener('dblclick', () => this.act());
    });
  }

  renderSelection() {
    const rows = this.rows();
    const r = rows[this.fi];
    this.el.querySelectorAll('.os-row').forEach((b, i) => b.classList.toggle('sel', i === this.fi));
    this.el.querySelector('.os-row.sel')?.scrollIntoView?.({ block: 'nearest' });
    const st = this.status(r);
    const broke = !st.owned && this.save.money < r.it.price;
    const label = st.worn ? 'WEARING' : st.owned ? 'WEAR' : `BUY ${money(r.it.price)}`;
    const ready = !st.worn && !broke; // blue brush = a press does something
    const noLens = r.slot === 'lens' && r.id && this.zones && !this.zones.lens;
    const notes = [];
    if (noLens) notes.push('Your skier wears no goggles, so the lens does not show');
    else if (r.slot === 'jacket' && r.it?.accent && this.zones && !this.zones.jacketAccent) notes.push('This jacket has no second colour panel, so it takes the main colour only');
    if (r.slot === 'kit') notes.push('Jacket, trousers, helmet and lens. Each piece can be worn on its own once bought');
    const det = this.el.querySelector('.os-detail');
    det.innerHTML = `
      <div class="os-kicker">${TABS[this.tab].one}${st.worn ? ' · WEARING' : st.owned ? ' · OWNED' : ''}</div>
      <div class="os-title">${esc(r.it ? r.it.name : 'Original')}</div>
      ${notes.map((n) => `<div class="os-note">${esc(n)}</div>`).join('')}
      <div class="os-actrow">
        <button class="brush-btn mid os-act${ready ? ' ready' : ''}${st.worn ? ' done' : ''}${broke ? ' broke' : ''}" tabindex="-1">${brushSVG(377, 300, 74, { fill: ready ? '#1546c8' : '#dfe7fb' })}<span>${label}</span></button>
        <div class="os-wallet"><span>YOUR MONEY</span><b>${money(this.save.money)}</b></div>
      </div>`;
    det.classList.remove('swap'); void det.offsetWidth; det.classList.add('swap');
    det.querySelector('.os-act').addEventListener('click', () => this.act());
  }

  bind() {
    this.el.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
      const i = +b.dataset.tab;
      if (i !== this.tab) this.switchTab(i - this.tab);
    }));
    // drag across the free area to turn your skier
    const drag = this.el.querySelector('.os-drag');
    let lastX = null;
    drag.addEventListener('pointerdown', (e) => { lastX = e.clientX; drag.setPointerCapture?.(e.pointerId); drag.classList.add('dragging'); });
    drag.addEventListener('pointermove', (e) => {
      if (lastX === null) return;
      this.interior?.spinMannequin?.((e.clientX - lastX) * 0.012);
      lastX = e.clientX;
    });
    const end = () => { lastX = null; drag.classList.remove('dragging'); };
    drag.addEventListener('pointerup', end);
    drag.addEventListener('pointercancel', end);
    this.el.addEventListener('mousedown', (e) => { if (e.target.closest?.('button')) e.preventDefault(); });
  }

  onKey(e) {
    if (!this.isOpen || !KEYS.has(e.code)) return;
    e.preventDefault();
    e.stopPropagation(); // the game never sees these keys while the shop is open
    if (performance.now() - this.openedAt < 250 && !e.repeat) { if (e.code === 'KeyE') return; } // the E that opened the shop
    const c = e.code;
    if (c === 'Escape' || c === 'Backspace') { if (!e.repeat) this.close(); return; }
    if (c === 'ArrowUp' || c === 'KeyW') this.selectRow(this.fi - 1);
    else if (c === 'ArrowDown' || c === 'KeyS') this.selectRow(this.fi + 1);
    else if (c === 'ArrowLeft' || c === 'KeyA') this.switchTab(-1);
    else if (c === 'ArrowRight' || c === 'KeyD') this.switchTab(1);
    else if (!e.repeat) this.act();
  }
}
