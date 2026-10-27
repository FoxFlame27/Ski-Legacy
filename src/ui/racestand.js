// RACING stand UI (Oct 27: RACE moved off the main menu into Legacy Village, "like jobs"): E at the stand opens it
// up close in the job board's look (ui/jobboard.css: wooden frame, cork face, header plank). Left, the courses as
// rows on a paper note (difficulty, your best finish); right, the picked course as a card: its facts, the AI
// difficulty (EASY / MEDIUM / HARD) and START RACE, with the stamp "Just for fun · no prize money" (races for money
// are the free-ride races at the courses' start houses). Keys: up / down course, left / right difficulty, Enter
// start, Esc close. Blocks the game like a panel while open (hud.setBlocking).
//   open({ courses: [{ id, name, tagline, difficulty, length, drop, record }], courseId, difficulty,
//          start(courseId, difficulty), close() })
import './jobboard.css';
import './racestand.css';
import { brushSVG, brushClip, esc, medalHTML } from './menu.js';
import { fmtTime } from './hud.js';

const DIFFS = [['easy', 'EASY'], ['medium', 'MEDIUM'], ['hard', 'HARD']];
const ord = (n) => (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');
const len = (m) => (!Number.isFinite(m) ? '—' : m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);
const sign = (d) => `<i class="diff-sign ${esc(String(d || '').toLowerCase())}"></i>`;

function root() {
  let el = document.getElementById('racestand');
  if (!el) {
    el = document.createElement('div');
    el.id = 'racestand';
    el.hidden = true;
    document.body.appendChild(el);
  }
  return el;
}

export class RaceStandUI {
  /** @param {{ hud?: object, audio?: object }} o */
  constructor({ hud = null, audio = null } = {}) {
    this.hud = hud;
    this.audio = audio;
    this.view = null;
    this.el = null;
    this.i = 0;
    this.diff = 'medium';
    this.onKey = (e) => this.key(e);
  }

  get isOpen() { return !!this.view; }

  open(view) {
    if (!view?.courses?.length) return;
    this.el ??= root();
    this.view = view;
    this.i = Math.max(0, view.courses.findIndex((c) => c.id === view.courseId));
    this.diff = DIFFS.some(([d]) => d === view.difficulty) ? view.difficulty : 'medium';
    this.render();
    this.el.hidden = false;
    this.hud?.setBlocking?.('racestand', true);
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
    this.hud?.setBlocking?.('racestand', false);
    removeEventListener('keydown', this.onKey, true);
    if (how === 'close') v.close?.();
  }

  key(e) {
    if (!this.view) return;
    const k = e.code;
    const act = {
      Escape: () => this.close(), Backspace: () => this.close(),
      ArrowUp: () => this.pick(this.i - 1), KeyW: () => this.pick(this.i - 1),
      ArrowDown: () => this.pick(this.i + 1), KeyS: () => this.pick(this.i + 1),
      ArrowLeft: () => this.step(-1), KeyA: () => this.step(-1),
      ArrowRight: () => this.step(1), KeyD: () => this.step(1),
      Enter: () => this.start(), NumpadEnter: () => this.start(), Space: () => this.start(),
    }[k];
    if (!act) return;
    e.preventDefault(); e.stopPropagation();
    if (e.repeat && (k === 'Enter' || k === 'NumpadEnter' || k === 'Space' || k === 'Escape')) return;
    act();
  }

  render() {
    const v = this.view;
    const rows = v.courses.map((c, i) => {
      const place = Number(c.record?.bestRace);
      return `<button class="rs-row${i === this.i ? ' sel' : ''}" data-i="${i}" style="--clip:${brushClip(120 + i * 7, 3, 2)}">
          <span class="rs-num">${String(i + 1).padStart(2, '0')}</span>
          <span class="rs-name"><b>${esc(c.name)}</b><small>${esc(c.tagline || '')}</small></span>
          <span class="rs-lvl">${sign(c.difficulty)}${place > 0 ? `<em>${place}${ord(place)}</em>` : ''}</span>
        </button>`;
    }).join('');
    this.el.innerHTML = `<div class="jb-board rs-board">
        <div class="jb-plank"><b>Racing</b> · <em>just for fun</em></div>
        <div class="jb-cork rs-cork">
          <div class="rs-list" style="--clip:${brushClip(31, 5, 3)}"><i class="jb-pin" style="--pin:#1546c8"></i>
            <div class="jb-kind">Courses</div><div class="rs-rows">${rows}</div></div>
          <div class="rs-card" style="--clip:${brushClip(57, 6, 4)}"><i class="jb-pin" style="--pin:#d0342c"></i><div class="rs-detail"></div>
            <div class="rs-diffs-l">AI difficulty</div>
            <div class="rs-diffs">${DIFFS.map(([d, l]) => `<button data-diff="${d}" class="${d === this.diff ? 'on' : ''}">${l}</button>`).join('')}</div>
            <div class="rs-fun"><span class="jb-stamp rs-stamp">JUST FOR FUN · NO PRIZE MONEY</span>
              <p>Race 14 AI rivals on any course, as often as you like. Want prize money? Race the courses at their start houses on the mountain.</p></div>
            <div class="jb-acts">
              <button class="jb-btn" data-start>${brushSVG(61, 300, 60, { fill: '#1546c8' })}<span>START RACE</span></button>
              <button class="jb-btn light" data-close>${brushSVG(62, 300, 60, { fill: '#e9eefb' })}<span>CLOSE</span></button>
            </div>
          </div>
        </div>
        <div class="jb-hint"><kbd>↑</kbd><kbd>↓</kbd> course <kbd>←</kbd><kbd>→</kbd> difficulty <kbd>Enter</kbd> start <kbd>Esc</kbd> close</div>
      </div>`;
    this.detail();
    const board = this.el.querySelector('.jb-board');
    this.el.onclick = (e) => {
      if (!board.contains(e.target)) { this.audio?.play?.('click'); this.close(); return; }
      const row = e.target.closest('.rs-row');
      if (row) { this.pick(Number(row.dataset.i)); return; }
      const d = e.target.closest('[data-diff]');
      if (d) { this.setDiff(d.dataset.diff); return; }
      if (e.target.closest('[data-start]')) { this.start(); return; }
      if (e.target.closest('[data-close]')) { this.audio?.play?.('click'); this.close(); }
    };
  }

  detail() {
    const c = this.view.courses[this.i], rec = c.record || {};
    const place = Number(rec.bestRace);
    this.el.querySelector('.rs-detail').innerHTML = `
      <div class="jb-kind">Race · vs 14 AI · course ${String(this.i + 1).padStart(2, '0')}</div>
      <h3 class="jb-title">${esc(c.name)}</h3>
      <p class="jb-brief">${esc(c.tagline || '')}</p>
      <div class="jb-facts">
        <span class="jb-fact">Length<b>${len(c.length)}</b></span>
        <span class="jb-fact">Drop<b>${Number.isFinite(c.drop) ? `${Math.round(c.drop)} m` : '—'}</b></span>
        <span class="jb-fact">Level<b>${sign(c.difficulty)} ${esc(c.difficulty || '—')}</b></span>
        <span class="jb-fact">Best<b>${place > 0 ? `${place}${ord(place)} ${medalHTML(rec.raceMedal, 22)}` : Number.isFinite(rec.best) ? fmtTime(rec.best) : '—'}</b></span>
      </div>`;
  }

  pick(i) {
    const n = this.view.courses.length;
    i = ((i % n) + n) % n;
    if (i === this.i) return;
    this.i = i;
    this.el.querySelectorAll('.rs-row').forEach((r, j) => r.classList.toggle('sel', j === i));
    this.el.querySelector('.rs-row.sel')?.scrollIntoView?.({ block: 'nearest' });
    this.detail();
    this.audio?.play?.('tick');
  }

  setDiff(d) {
    if (d === this.diff || !DIFFS.some(([x]) => x === d)) return;
    this.diff = d;
    this.el.querySelectorAll('[data-diff]').forEach((b) => b.classList.toggle('on', b.dataset.diff === d));
    this.audio?.play?.('tick');
  }

  step(s) {
    const k = DIFFS.findIndex(([d]) => d === this.diff);
    this.setDiff(DIFFS[Math.max(0, Math.min(DIFFS.length - 1, k + s))][0]);
  }

  start() {
    const v = this.view, c = v?.courses[this.i];
    if (!c) return;
    this.audio?.play?.('click');
    const diff = this.diff;
    this.close('start');
    v.start?.(c.id, diff);
  }
}
