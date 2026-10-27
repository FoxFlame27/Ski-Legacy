// Broadcast overlay for the race presentation (intro flyover, replays, podium): letterbox bars, the
// lower-third caption, the REPLAY badge, the skip hint and the brush-stroke stinger that covers cuts.
// Same house style as the race HUD: white brush panels, blue italic Barlow Condensed, red accents.
// Sized in the CSS unit --u (style.css). Everything lives in #pres, above the race HUD and below the
// results screen and the transitions; body.pres-cine hides the race HUD while a cinematic runs.
import { brushSVG, brushClip, esc } from './menu.js';
import './presentation.css';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STING_COVER_MS = 450; // the strokes cover the screen from here...
const STING_MS = 900;       // ...and are gone at the end

export class PresentationUI {
  constructor() {
    this.el = null;
    this.l3T = 0;
  }

  // built lazily on first use (no DOM access at import time)
  ensure() {
    if (this.el || typeof document === 'undefined') return !!this.el;
    const el = document.createElement('div');
    el.id = 'pres';
    el.innerHTML = `<div class="pres-bar top"></div><div class="pres-bar bot"></div>
      <div class="pres-l3"></div><div class="pres-rb-wrap"></div>
      <div class="pres-skip"><span class="ps-label"></span><i class="kc">SPACE</i></div>
      <div class="pres-sting"></div>`;
    document.body.appendChild(el);
    this.el = el;
    const q = (s) => el.querySelector(s);
    this.$ = { l3: q('.pres-l3'), rb: q('.pres-rb-wrap'), skip: q('.pres-skip'), skipLabel: q('.ps-label'), sting: q('.pres-sting') };
    return true;
  }

  /** Cinematic mode: hides the race HUD (body.pres-cine) and shows / hides the letterbox bars. */
  cinematic(on, bars = on) {
    if (!this.ensure()) return;
    document.body.classList.toggle('pres-cine', !!on);
    this.el.classList.toggle('lb', !!bars);
  }

  /** "SKIP  [SPACE]" in the bottom bar (null hides it). */
  skipHint(label) {
    if (!this.ensure()) return;
    if (label) this.$.skipLabel.textContent = label;
    this.$.skip.classList.toggle('on', !!label);
  }

  /**
   * Broadcast lower third.
   * @param {object} o
   * @param {string} o.kicker   red tab ("RACE · HARD")
   * @param {string} o.title    course name
   * @param {Array<[string, string]>} [o.stats]  [label, value HTML] cells
   * @param {Array<{place:number, name:string, time:string, me?:boolean}>} [o.rows]  standings (podium)
   */
  lowerThird({ kicker = '', title = '', stats = [], rows = [] } = {}) {
    if (!this.ensure()) return;
    clearTimeout(this.l3T);
    const cells = stats.map(([label, value]) => `<div class="pl3-stat"><span>${esc(label)}</span><b>${value}</b></div>`).join('');
    const list = rows.map((r) => `<div class="pl3-row${r.me ? ' me' : ''}"><b class="pl3-p">${r.place}</b>`
      + `<span class="pl3-n">${esc(r.name)}</span><b class="pl3-t">${esc(r.time)}</b></div>`).join('');
    this.$.l3.innerHTML = `${kicker ? `<div class="pl3-kick">${esc(kicker)}</div>` : ''}
      <div class="rh-panel pl3-main" style="--clip:${brushClip(611, 4, 3)}">
        <div class="pl3-title">${esc(title)}</div>
        ${cells ? `<div class="pl3-stats">${cells}</div>` : ''}
        ${list ? `<div class="pl3-rows">${list}</div>` : ''}
      </div>`;
    const l3 = this.$.l3;
    l3.classList.remove('out', 'in');
    void l3.offsetWidth;
    l3.classList.add('in');
  }

  hideLowerThird() {
    if (!this.el) return;
    const l3 = this.$.l3;
    if (!l3.classList.contains('in')) return;
    l3.classList.add('out');
    clearTimeout(this.l3T);
    this.l3T = setTimeout(() => { l3.classList.remove('in', 'out'); l3.innerHTML = ''; }, 420);
  }

  /** REPLAY badge (top left) with the race clock of the replayed moment; null hides it. */
  badge(on) {
    if (!this.ensure()) return;
    const w = this.$.rb;
    if (!on) { w.innerHTML = ''; this.badgeEl = null; return; }
    w.innerHTML = `<div class="rh-panel pres-rb" style="--clip:${brushClip(612, 4, 3)}"><i class="prb-dot"></i><b class="prb-word">REPLAY</b><span class="prb-time"></span></div>
      <div class="prb-slow">SLOW MOTION</div>`;
    this.badgeEl = { time: w.querySelector('.prb-time'), slow: w.querySelector('.prb-slow'), lastT: '', lastS: null };
  }

  badgeTime(text, slow = false) {
    const b = this.badgeEl;
    if (!b) return;
    if (text !== b.lastT) { b.time.textContent = text; b.lastT = text; }
    if (slow !== b.lastS) { b.slow.classList.toggle('on', slow); b.lastS = slow; }
  }

  /**
   * Brush-stroke stinger across the screen (a cut happens behind it).
   * @returns {Promise<void>} resolves when the strokes cover the screen
   */
  sting(label = 'REPLAY') {
    if (!this.ensure()) return Promise.resolve();
    const el = this.$.sting;
    el.innerHTML = `<div class="ps-stroke s0">${brushSVG(631, 1700, 260, { fill: '#1546c8' })}</div>`
      + `<div class="ps-stroke s1">${brushSVG(632, 1700, 300)}<span>${esc(label)}</span></div>`
      + `<div class="ps-stroke s2">${brushSVG(633, 1700, 260, { fill: '#ff4d3d' })}</div>`;
    el.classList.remove('go');
    void el.offsetWidth;
    el.classList.add('go');
    clearTimeout(this.stingT);
    this.stingT = setTimeout(() => { el.classList.remove('go'); el.innerHTML = ''; }, STING_MS + 60);
    return sleep(STING_COVER_MS);
  }

  /** Everything off (session end / restart). */
  reset() {
    if (!this.el) return;
    this.cinematic(false);
    this.skipHint(null);
    this.badge(null);
    clearTimeout(this.l3T);
    this.$.l3.classList.remove('in', 'out');
    this.$.l3.innerHTML = '';
  }
}

export const presentationUI = new PresentationUI();
