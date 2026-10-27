// Branded screen transitions.
//   teleport(label, fn): white brush strokes paint across the screen, an opaque title card
//     ("WORLD RACING · Ice Canyon") covers the teleport + terrain streaming done in fn(), then the
//     strokes wipe off to the right revealing the new place.
//   fade(fn): a dip to dark and back; while it is dark the round logo shows with a loading circle under it.
// Only transform / opacity animate, so the wipe and the loading bar stay smooth on the compositor
// even while the main thread is busy streaming the new area.
import { brushSVG } from './menu.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STROKES = 6;
const COVER_MS = 720; // 6 strokes x 45 ms stagger + 420 ms travel, then the card has settled
const REVEAL_MS = 820; // card out, 140 ms pause, strokes leave (stagger + travel)
const FADE_MS = 340;

export class Transition {
  constructor() {
    this.el = null;
    this.queue = Promise.resolve();
    this.active = false; // true while anything is covering the screen (main.js: skip auto-pause)
  }

  // built lazily on first use (no DOM access at import time)
  ensure() {
    if (this.el) return;
    let el = document.getElementById('transition');
    if (!el) {
      el = document.createElement('div');
      el.id = 'transition';
      document.body.appendChild(el);
    }
    let strokes = '';
    for (let i = 0; i < STROKES; i++) {
      const top = ((i * 100) / STROKES - 2.5).toFixed(2), height = (100 / STROKES + 5).toFixed(2);
      strokes += `<div class="tr-stroke" style="--i:${i};top:${top}%;height:${height}%">${brushSVG(500 + i * 7, 1600, 200)}</div>`;
    }
    el.innerHTML = `<div class="tr-strokes">${strokes}</div><div class="tr-solid"></div>
      <div class="tr-card"><div class="tr-kicker"></div><div class="tr-title"></div><div class="tr-bar"><i></i></div></div>
      <div class="tr-mark"><b>SKI</b> LEGACY</div><div class="tr-fade"></div>
      <div class="tr-load"><img class="tr-logo" src="ui/logo.webp" alt=""><i class="tr-spin"></i></div>`;
    el.hidden = true;
    this.el = el;
    this.$kicker = el.querySelector('.tr-kicker');
    this.$title = el.querySelector('.tr-title');
  }

  /**
   * Cover the screen with the branded card, await fn() while covered, then reveal.
   * @param {string} label  'KICKER · Title' (e.g. 'WORLD RACING · Ice Canyon') or just a title
   * @param {() => any} fn  teleport / streaming work (may be async)
   * @param {{minMs?: number, kicker?: string}} [opts]  minimum time the card stays up after covering (default 650 ms);
   *        kicker: the small line over the title (else the label's part before ' · ')
   * @returns {Promise<any>} fn's result (rejects if fn throws; the screen is revealed either way)
   */
  teleport(label, fn, opts) {
    return this.enqueue(() => this.runTeleport(label, fn, opts));
  }

  /** Dip to dark, await fn(), fade back. Returns fn's result. opts.color overrides the dark tint. */
  fade(fn, opts) {
    return this.enqueue(() => this.runFade(fn, opts));
  }

  // transitions never overlap: each waits for the previous one to finish
  enqueue(job) {
    const p = this.queue.then(job, job);
    this.queue = p.catch(() => {});
    return p;
  }

  async runTeleport(label = '', fn, { minMs = 650, kicker: kick } = {}) {
    this.ensure();
    const parts = String(label).split(/\s+[·|]\s+/);
    const kicker = kick ?? (parts.length > 1 ? parts[0] : ''); // (opts.kicker: the whole label is the title)
    const title = kick != null ? String(label) : parts.length > 1 ? parts.slice(1).join(' · ') : parts[0];
    this.$kicker.textContent = kicker;
    this.$title.textContent = title;
    this.$title.classList.toggle('long', title.length > 14); // e.g. "Legacy World Downhill" stays on one line
    const el = this.el;
    el.className = 'tr-teleport';
    el.hidden = false;
    this.active = true;
    void el.offsetWidth; // start from the off-screen state
    el.classList.add('cover');
    await sleep(COVER_MS);
    const t0 = performance.now();
    try {
      return await fn?.();
    } finally {
      const left = minMs - (performance.now() - t0);
      if (left > 0) await sleep(left);
      el.classList.add('reveal');
      await sleep(REVEAL_MS);
      el.hidden = true;
      el.className = '';
      this.active = false;
    }
  }

  async runFade(fn, { color } = {}) {
    this.ensure();
    const el = this.el;
    el.className = 'tr-fading';
    if (color) el.style.setProperty('--fade', color);
    el.hidden = false;
    this.active = true;
    void el.offsetWidth;
    el.classList.add('dark');
    await sleep(FADE_MS);
    try {
      return await fn?.();
    } finally {
      el.classList.remove('dark');
      await sleep(FADE_MS + 40);
      el.hidden = true;
      el.className = '';
      el.style.removeProperty('--fade');
      this.active = false;
    }
  }
}

export const transition = new Transition();
