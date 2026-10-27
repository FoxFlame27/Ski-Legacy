// Job board UI: E at a job board opens the board itself up close: a wooden frame with a cork face, a
// header plank (JOBS · place) and the day's jobs pinned on it as paper notes (what it is, the brief, the
// pay and tip, the time, how hard). A note lifts when you point at it; a click takes it off the board as
// a bigger card with TAKE THE JOB / BACK. Your current job hangs on the board as a yellow note with
// CANCEL JOB. Esc or a click beside the board closes it (and backs out of a card first).
// While it is open it blocks the game like a panel (hud.setBlocking): no input, no pause menu on Esc.
// The job logic stays in src/game/jobs.js, which hands over plain data and callbacks:
//   open({ place, offers: [{ id, type, title, brief, client, reward, bonus, minutes, diff }],
//          current: { title, type, status, client } | null, take(id), cancel(), close() })
import './jobboard.css';
import { brushSVG, brushClip, esc } from './menu.js';

const ICONS = {
  // a parcel with tape
  delivery: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5z"/><path d="M3.5 7.5 12 12l8.5-4.5M12 12v9M7.8 5.2l8.4 4.5"/></svg>',
  // the patrol's cross
  rescue: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><circle cx="12" cy="12" r="9.2"/><path d="M10 6.8h4v3.2h3.2v4H14v3.2h-4V14H6.8v-4H10z" fill="currentColor" stroke="none"/></svg>',
  // a magnifying glass
  lost: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5.5 5.5"/></svg>',
  // a guide's flag
  escort: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V3.5"/><path d="M5 4h12l-3 4 3 4H5" fill="currentColor" fill-opacity="0.18"/></svg>',
};
const KIND = { delivery: 'Delivery', rescue: 'Rescue', lost: 'Lost & found', escort: 'Guide' };
const DIFF = [null, ['Easy', '#129a46'], ['Medium', '#1546c8'], ['Hard', '#d0342c']]; // piste colours
const CLOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
const PINS = ['#d0342c', '#1546c8', '#e09a00', '#129a46'];
const TILT = [-2.2, 1.7, -1.2, 2.4, -1.8];
const money = (v) => `$${Math.round(v || 0).toLocaleString('en-US')}`;

function root() {
  let el = document.getElementById('jobboard');
  if (!el) {
    el = document.createElement('div');
    el.id = 'jobboard';
    el.hidden = true;
    document.body.appendChild(el);
  }
  return el;
}

const diffHTML = (d) => {
  const [label, c] = DIFF[d] || DIFF[2];
  return `<span class="jb-diff" style="--dc:${c}">${[1, 2, 3].map((k) => `<i class="${k <= d ? '' : 'off'}"></i>`).join('')}${label}</span>`;
};

export class JobBoardUI {
  /** @param {{ hud?: object, audio?: object }} o */
  constructor({ hud = null, audio = null } = {}) {
    this.hud = hud;
    this.audio = audio;
    this.view = null;
    this.el = null;
    this.onKey = (e) => this.key(e);
  }

  get isOpen() { return !!this.view; }

  open(view) {
    this.el ??= root();
    this.view = view;
    this.render();
    this.el.hidden = false;
    this.hud?.setBlocking?.('jobboard', true);
    document.exitPointerLock?.();
    addEventListener('keydown', this.onKey, true);
    this.audio?.play?.('click');
  }

  close(how = 'close') {
    if (!this.view) return;
    const v = this.view;
    this.view = null;
    this.el.hidden = true;
    this.el.innerHTML = '';
    this.hud?.setBlocking?.('jobboard', false);
    removeEventListener('keydown', this.onKey, true);
    if (how === 'close') v.close?.();
  }

  key(e) {
    if (!this.view || e.code !== 'Escape') return;
    e.preventDefault(); e.stopPropagation();
    if (!this.el.querySelector('.jb-detail').hidden) this.back();
    else this.close();
  }

  render() {
    const v = this.view, cur = v.current;
    const notes = v.offers.map((o, i) => this.noteHTML(o, i, !!cur)).join('');
    const current = cur ? `<div class="jb-note current" style="--clip:${brushClip(91, 5, 3)};--d:0s">
        <i class="jb-pin" style="--pin:#d0342c"></i><span class="jb-stamp">YOUR JOB</span>
        <div class="jb-kind">${ICONS[cur.type] || ''}${esc(KIND[cur.type] || 'Job')}</div>
        <h3 class="jb-title">${esc(cur.title)}</h3>
        ${cur.client ? `<div class="jb-from">${esc(cur.client)}</div>` : ''}
        <div class="jb-status">${esc(cur.status || '')}</div>
        <div class="jb-acts">
          <button class="jb-btn danger" data-cancel>${brushSVG(77, 300, 60, { fill: '#d0342c' })}<span>CANCEL JOB</span></button>
          <button class="jb-btn light" data-close>${brushSVG(78, 300, 60, { fill: '#e9eefb' })}<span>KEEP GOING</span></button>
        </div></div>` : '';
    this.el.innerHTML = `<div class="jb-board">
        <div class="jb-plank"><b>Jobs</b> · <em>${esc(v.place || '')}</em></div>
        <div class="jb-cork">${current}${notes || (cur ? '' : '<div class="jb-empty">Nothing pinned up right now.<br>Check back later.</div>')}</div>
        <div class="jb-detail" hidden></div>
        <div class="jb-hint">Click a note to read it <kbd>Esc</kbd> close</div>
      </div>`;
    const board = this.el.querySelector('.jb-board');
    this.el.onclick = (e) => {
      if (!board.contains(e.target)) { this.audio?.play?.('click'); this.close(); return; }
      const note = e.target.closest('.jb-note[data-id]');
      if (note && !note.classList.contains('busy')) { this.audio?.play?.('click'); this.showDetail(note.dataset.id); return; }
      if (note) { this.audio?.play?.('error'); return; }
      if (e.target.closest('[data-cancel]')) { this.audio?.play?.('click'); const f = v.cancel; this.close('cancel'); f?.(); return; }
      if (e.target.closest('[data-close]')) { this.audio?.play?.('click'); this.close(); return; }
      if (e.target.classList.contains('jb-detail')) this.back();
    };
  }

  noteHTML(o, i, busy) {
    const tip = o.bonus ? '<small>+ TIP</small>' : '';
    return `<button class="jb-note${busy ? ' busy' : ''}" data-id="${esc(o.id)}" title="${busy ? 'Finish or cancel your current job first' : ''}"
        style="--r:${TILT[i % TILT.length]}deg;--clip:${brushClip(31 + i * 7, 5, 3)};--d:${(0.06 + i * 0.06).toFixed(2)}s">
        <i class="jb-pin" style="--pin:${PINS[i % PINS.length]}"></i>
        <div class="jb-kind">${ICONS[o.type] || ''}${esc(KIND[o.type] || 'Job')}</div>
        <h3 class="jb-title">${esc(o.title)}</h3>
        <p class="jb-brief">${esc(o.brief)}</p>
        <div class="jb-foot"><span class="jb-pay">${money(o.reward)}${tip}</span>
          <span class="jb-side"><span class="jb-time">${CLOCK}${esc(o.minutes)}</span>${diffHTML(o.diff)}</span></div>
      </button>`;
  }

  showDetail(id) {
    const v = this.view, o = v.offers.find((x) => String(x.id) === String(id));
    if (!o) return;
    const busy = !!v.current;
    const d = this.el.querySelector('.jb-detail');
    d.innerHTML = `<div class="jb-card" style="--clip:${brushClip(57, 7, 4)}">
        <i class="jb-pin" style="--pin:${PINS[v.offers.indexOf(o) % PINS.length]}"></i>
        <div class="jb-kind">${ICONS[o.type] || ''}${esc(KIND[o.type] || 'Job')}</div>
        <h3 class="jb-title">${esc(o.title)}</h3>
        <div class="jb-from">${esc(o.client)}</div>
        <p class="jb-brief">${esc(o.brief)}</p>
        <div class="jb-facts">
          <span class="jb-fact">Pay<b>${money(o.reward)}</b></span>
          <span class="jb-fact">Tip<b class="tip">${o.bonus ? `up to ${money(o.bonus)}` : '—'}</b></span>
          <span class="jb-fact">Time<b>${esc(o.minutes)}</b></span>
          <span class="jb-fact">Difficulty<b>${diffHTML(o.diff)}</b></span>
        </div>
        ${busy ? '<div class="jb-note-busy">You are already on a job: finish it or cancel it first.</div>' : ''}
        <div class="jb-acts">
          <button class="jb-btn" data-take ${busy ? 'disabled' : ''}>${brushSVG(61, 300, 60, { fill: '#1546c8' })}<span>TAKE THE JOB</span></button>
          <button class="jb-btn light" data-back>${brushSVG(62, 300, 60, { fill: '#e9eefb' })}<span>BACK</span></button>
        </div></div>`;
    d.hidden = false;
    d.querySelector('[data-take]').onclick = (e) => {
      e.stopPropagation();
      if (busy) return;
      this.audio?.play?.('click');
      const take = v.take;
      this.close('take');
      take?.(o.id);
    };
    d.querySelector('[data-back]').onclick = (e) => { e.stopPropagation(); this.audio?.play?.('click'); this.back(); };
  }

  back() {
    const d = this.el?.querySelector('.jb-detail');
    if (!d) return;
    d.hidden = true;
    d.innerHTML = '';
  }
}
