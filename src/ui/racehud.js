// Race HUD used by the race session: position, timer, checkpoints, distance to finish, speed,
// ghost delta, the 3-2-1-GO countdown, checkpoint splits, banners, trick popups and the results
// screen. Same house style as the menus: white brush panels with blue italic condensed numerals.
// All sizes are in the CSS unit --u (see style.css) so the layout scales with the window.
import { brushSVG, brushClip, medalHTML, esc, replay } from './menu.js';
import { fmtTime } from './hud.js';

export const ordinal = (n) => {
  const t = n % 100;
  if (t >= 11 && t <= 13) return 'TH';
  return ['TH', 'ST', 'ND', 'RD'][n % 10] || 'TH';
};
/** Signed time difference: −0.84 (ahead) / +1.20 (behind). */
export const fmtDelta = (d) => `${d < 0 ? '−' : '+'}${Math.abs(d).toFixed(2)}`;
/** Gap to the leader in a results table. */
export const fmtGap = (g) => (!Number.isFinite(g) || g < 0.005 ? '—' : g < 60 ? `+${g.toFixed(2)}` : `+${fmtTime(g)}`);
const fmtPts = (p) => Math.round(p || 0).toLocaleString('en-US');
const fmtDist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(2)}<small>KM</small>` : `${Math.max(0, Math.round(m))}<small>M</small>`);
const LANDINGS = { clean: 'CLEAN', sketchy: 'SKETCHY', crash: 'BAILED' };

function container(id) {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('div');
    el.id = id;
    document.body.appendChild(el);
  }
  return el;
}

export class RaceHud {
  /**
   * @param {object} [o]
   * @param {import('./hud.js').HUD} [o.hud]  while the results screen is up, hud.panelOpen stays true
   *        (main.js then disables gameplay input and does not auto-pause on the pointer-lock release)
   * @param {{play(name: string): void}} [o.audio]  UI ticks/clicks on the results buttons
   */
  constructor({ hud, audio } = {}) {
    this.hud = hud;
    this.audio = audio;
    this.root = container('racehud');
    this.resEl = container('race-results');
    this.resEl.hidden = true;
    this.visible = false;
    this.suspended = false; // panels stepped aside for the results screen (still in the race)
    this.retryPending = false; // RETRY picked: the panels come back with the new run's first update
    this.suspendTime = NaN; // last race clock shown (a smaller one after RETRY = the new run)
    this.modalOpen = false;
    this.mode = 'race';
    this.cps = 0;
    this.last = {};
    this.maxDist = 0;
    this.cdKey = null;
    this.noticeText = null;
    this.pending = null;
    this.trickN = 0;
    this.build();
  }

  build() {
    this.root.innerHTML = `
      <div class="rh-race" hidden>
        <div class="rh-left">
          <div class="rh-panel rh-pos" style="--clip:${brushClip(301, 4, 3)}">
            <div class="rh-label">POSITION</div>
            <div class="rh-pos-val"><b class="rh-pos-n">1</b><span class="rh-pos-suf">ST</span><span class="rh-pos-tot">/ 6</span></div>
          </div>
          <div class="rh-panel rh-pb" style="--clip:${brushClip(302, 4, 3)}" hidden>
            <div class="rh-label">PERSONAL BEST</div>
            <div class="rh-pb-val">—</div>
          </div>
          <div class="rh-panel rh-board" style="--clip:${brushClip(306, 4, 3)}" hidden></div>
        </div>
        <div class="rh-clock">
          <div class="rh-panel rh-timer" style="--clip:${brushClip(303, 3, 3)}"><span class="rh-time">0:00.00</span></div>
          <div class="rh-delta" hidden></div>
          <div class="rh-pen" hidden></div>
          <div class="rh-split"></div>
        </div>
        <div class="rh-panel rh-info" style="--clip:${brushClip(304, 4, 3)}">
          <div class="rh-course"></div>
          <div class="rh-row"><span class="rh-label">CHECKPOINT</span><b class="rh-cp">0 / 0</b></div>
          <div class="rh-row rh-next-row" hidden><span class="rh-label rh-next-l">NEXT</span><b class="rh-next"><i class="rh-arrow"></i><span class="rh-next-d">—</span></b></div>
          <div class="rh-row"><span class="rh-label">TO FINISH</span><b class="rh-dist">—</b></div>
        </div>
        <div class="rh-panel rh-speed" style="--clip:${brushClip(305, 4, 3)}">
          <div class="rh-speed-row"><b class="rh-kmh">0</b><span>KM/H</span></div>
          <div class="rh-prog"><i></i></div>
        </div>
      </div>
      <div class="rh-count"></div>
      <div class="rh-notice"></div>
      <div class="rh-trick"></div>
      <div class="rh-best"></div>`;
    const q = (s) => this.root.querySelector(s);
    this.$ = {
      race: q('.rh-race'), pos: q('.rh-pos'), posN: q('.rh-pos-n'), posSuf: q('.rh-pos-suf'), posTot: q('.rh-pos-tot'),
      pb: q('.rh-pb'), pbVal: q('.rh-pb-val'), board: q('.rh-board'), time: q('.rh-time'), delta: q('.rh-delta'), pen: q('.rh-pen'), split: q('.rh-split'),
      course: q('.rh-course'), cp: q('.rh-cp'), dist: q('.rh-dist'), kmh: q('.rh-kmh'), prog: q('.rh-prog i'),
      nextRow: q('.rh-next-row'), nextL: q('.rh-next-l'), nextD: q('.rh-next-d'), arrow: q('.rh-arrow'),
      count: q('.rh-count'), notice: q('.rh-notice'), trick: q('.rh-trick'), best: q('.rh-best'),
    };
  }

  /**
   * Show the race panels. In 'trial' the position panel is replaced by the personal best (if given).
   * Hides the free-roam HUD pieces (location, money, waypoint, speedometer) via body.in-race.
   * Optional: difficulty (label shown next to the course name), total (field size).
   */
  show({ courseName = '', mode = 'race', checkpoints = 0, laps, best, difficulty, total } = {}) {
    const $ = this.$;
    this.mode = mode === 'trial' ? 'trial' : 'race';
    this.cps = checkpoints || 0;
    this.laps = laps;
    this.last = {};
    this.maxDist = 0;
    $.course.textContent = difficulty ? `${courseName} · ${difficulty}` : courseName;
    $.cp.textContent = `0 / ${this.cps}`;
    $.time.textContent = fmtTime(0);
    $.dist.innerHTML = '—';
    $.kmh.textContent = '0';
    $.prog.style.transform = 'scaleX(0)';
    $.pos.hidden = this.mode !== 'race';
    $.posN.textContent = '1';
    $.posSuf.textContent = 'ST';
    $.posTot.textContent = total ? `/ ${total}` : '';
    $.pb.hidden = !(this.mode === 'trial' && Number.isFinite(best));
    if (Number.isFinite(best)) $.pbVal.textContent = fmtTime(best);
    $.board.hidden = true;
    $.board.innerHTML = '';
    $.delta.hidden = true;
    $.pen.hidden = true;
    $.split.innerHTML = '';
    $.race.hidden = false;
    $.pos.classList.remove('gain', 'lose');
    replay($.race, 'in');
    document.body.classList.add('in-race');
    this.visible = true;
    this.suspended = this.retryPending = false;
  }

  hide() {
    this.visible = false;
    this.suspended = this.retryPending = false;
    this.$.race.hidden = true;
    document.body.classList.remove('in-race');
    this.clearOverlays();
  }

  // The results screen covers the race: the panels step aside but body.in-race stays, so the
  // free-roam HUD (location, money, speedometer) never shows through. NEXT / MENU end in hide();
  // RETRY brings the panels back (see update()).
  suspend() {
    if (this.visible) this.suspended = true;
    this.visible = false;
    this.$.race.hidden = true;
    this.clearOverlays();
  }

  // back from a RETRY: same course and mode, fresh values
  resume() {
    const $ = this.$;
    this.visible = true;
    this.suspended = this.retryPending = false;
    this.last = {};
    this.maxDist = 0;
    $.board.hidden = true;
    $.board.innerHTML = '';
    $.delta.hidden = true;
    $.pen.hidden = true;
    $.pos.classList.remove('gain', 'lose');
    $.race.hidden = false;
    replay($.race, 'in');
    document.body.classList.add('in-race');
  }

  clearOverlays() {
    this.countdown(null);
    this.notice(null);
    clearTimeout(this.splitT);
    this.$.split.innerHTML = '';
  }

  /** Per frame. Only touches the DOM when a displayed value actually changes. */
  update(s = {}) {
    if (!this.visible) {
      // after RETRY the panels return as soon as the new run reports in (its clock went back)
      const fresh = Number.isFinite(s.time) && !(s.time >= this.suspendTime - 0.05);
      if (!this.retryPending || this.modalOpen || !fresh) return;
      this.resume();
    }
    const $ = this.$, L = this.last;
    const t = fmtTime(Number.isFinite(s.time) ? Math.max(0, s.time) : 0);
    if (t !== L.time) { $.time.textContent = t; L.time = t; }
    if (Number.isFinite(s.time)) this.suspendTime = s.time;

    if (this.mode === 'race' && s.position > 0 && (s.position !== L.pos || s.total !== L.total)) {
      const prev = L.pos;
      $.posN.textContent = String(s.position);
      $.posSuf.textContent = ordinal(s.position);
      $.posTot.textContent = s.total ? `/ ${s.total}` : '';
      if (prev && s.position !== prev) {
        // both classes off first: a stale .lose must never mask the next .gain (equal specificity)
        $.pos.classList.remove('gain', 'lose');
        replay($.pos, s.position < prev ? 'gain' : 'lose');
      }
      L.pos = s.position;
      L.total = s.total;
    }

    const cp = `${s.checkpoint ?? 0} / ${s.checkpoints ?? this.cps}`;
    if (cp !== L.cp) { $.cp.textContent = cp; L.cp = cp; }

    // what to ski for next: its name, how far, and an arrow pointing the way (relative to the view)
    const nx = s.next;
    if (nx && Number.isFinite(nx.dist)) {
      if (L.nextOn !== true) { $.nextRow.hidden = false; L.nextOn = true; }
      const lab = nx.label || 'NEXT';
      if (lab !== L.nextL) { $.nextL.textContent = lab; $.nextRow.classList.toggle('gate', lab === 'GATE'); L.nextL = lab; }
      const nd = fmtDist(nx.dist);
      if (nd !== L.nextD) { $.nextD.innerHTML = nd; L.nextD = nd; }
      const a = Math.round(Math.max(-170, Math.min(170, nx.angle || 0)) / 3) * 3;
      if (a !== L.arrow) { $.arrow.style.transform = `rotate(${a}deg)`; L.arrow = a; }
    } else if (L.nextOn !== false) { $.nextRow.hidden = true; L.nextOn = false; }

    if (Number.isFinite(s.distanceToFinish)) {
      const d = Math.max(0, s.distanceToFinish);
      this.maxDist = Math.max(this.maxDist, d);
      const ds = fmtDist(d);
      if (ds !== L.dist) { $.dist.innerHTML = ds; L.dist = ds; }
      const p = (this.maxDist > 0 ? 1 - d / this.maxDist : 0).toFixed(3);
      if (p !== L.prog) { $.prog.style.transform = `scaleX(${p})`; L.prog = p; }
    }

    if (Number.isFinite(s.speed)) {
      const k = String(Math.round(Math.abs(s.speed) * 3.6));
      if (k !== L.kmh) { $.kmh.textContent = k; L.kmh = k; }
    }

    const g = s.ghostDelta;
    if (Number.isFinite(g)) {
      const gs = fmtDelta(g);
      if (gs !== L.ghost) {
        $.delta.textContent = gs;
        $.delta.classList.toggle('behind', g > 0);
        $.delta.hidden = false;
        L.ghost = gs;
      }
    } else if (L.ghost != null) {
      $.delta.hidden = true;
      L.ghost = null;
    }

    // time penalties (already included in the clock), e.g. missed gates
    const pen = Number.isFinite(s.penalty) && s.penalty > 0 ? `+${s.penalty.toFixed(2)} PENALTY` : '';
    if (pen !== L.pen) {
      $.pen.textContent = pen;
      $.pen.hidden = !pen;
      if (pen) replay($.pen, 'hit');
      L.pen = pen;
    }

    // live standings (the session refreshes the array a few times per second)
    if (s.standings !== L.standings) {
      L.standings = s.standings;
      this.renderBoard(s.standings);
    }
  }

  // compact leaderboard under the position, six rows: the top six while you are among them; in a big field
  // further back the podium places, then the racer ahead of you, you and the racer behind
  renderBoard(list) {
    const el = this.$.board;
    if (!Array.isArray(list) || list.length < 2 || this.mode !== 'race') { el.hidden = true; return; }
    const n = list.length, me = list.findIndex((r) => r.me);
    let idx = [];
    for (let i = 0; i < Math.min(6, n); i++) idx.push(i);
    if (me >= 6) {
      const a = Math.min(me - 1, n - 3);
      idx = [0, 1, 2, a, a + 1, a + 2];
    }
    const rows = idx.map((i) => ({ ...list[i], pos: i + 1 }));
    el.innerHTML = rows.map((r, k) => `<div class="rb-row${r.me ? ' me' : ''}${k > 0 && r.pos - rows[k - 1].pos > 1 ? ' gap' : ''}"><span class="rb-p">${r.pos}</span>`
      + `<span class="rb-n">${esc(r.name)}</span><span class="rb-g">${r.pos === 1 ? 'LEAD' : fmtGap(r.gap)}</span></div>`).join('');
    el.hidden = false;
  }

  /** Big animated numeral: 3, 2, 1, 'GO' (or null to clear). Repeated calls with the same value are ignored. */
  countdown(v) {
    const el = this.$.count;
    const key = v === null || v === undefined || v === '' ? null : String(v).toUpperCase().replace(/!/g, '');
    if (key === this.cdKey) return;
    this.cdKey = key;
    clearTimeout(this.cdT);
    if (!key) { el.innerHTML = ''; return; }
    const go = key === 'GO';
    const art = go ? brushSVG(811, 460, 170, { fill: '#1546c8' }) : brushSVG(800 + (parseInt(key, 10) || 0), 300, 170);
    el.innerHTML = `<div class="rh-cd${go ? ' go' : ''}">${art}<span>${esc(key)}</span></div>`;
    // the numeral fades itself out; the node goes once the animation is done
    this.cdT = setTimeout(() => { el.innerHTML = ''; }, go ? 1200 : 1000);
  }

  /** Checkpoint split card under the timer: "CHECKPOINT 2/5 · ICE BRIDGE  0:41.32  −0.84". */
  checkpoint({ index, total, split, delta, name } = {}) {
    const el = this.$.split;
    const d = Number.isFinite(delta) ? `<span class="sp-delta ${delta > 0 ? 'behind' : 'ahead'}">${fmtDelta(delta)}</span>` : '';
    const label = `CHECKPOINT ${index ?? ''}${total ? `/${total}` : ''}`;
    el.innerHTML = `<div class="rh-panel sp-card" style="--clip:${brushClip(320 + ((index || 0) % 7), 3, 3)}">`
      + `<span class="sp-label">${label}${name ? `<em>${esc(name)}</em>` : ''}</span>`
      + `${Number.isFinite(split) ? `<b class="sp-time">${fmtTime(split)}</b>` : ''}${d}</div>`;
    clearTimeout(this.splitT);
    this.splitT = setTimeout(() => el.firstElementChild?.classList.add('out'), 2600);
  }

  /**
   * Centre banner ("WRONG WAY", "RESPAWN"...). Calling it again with the same text just keeps it up.
   * @param {string|null} text  null hides it
   * @param {number} [ms=1800]  0 = stay until notice(null)
   * @param {'info'|'bad'|'good'} [kind]  colour; guessed from the text when omitted
   */
  notice(text, ms = 1800, kind) {
    const el = this.$.notice;
    clearTimeout(this.noticeT);
    if (!text) { el.classList.remove('show'); this.noticeText = null; return; }
    if (text !== this.noticeText || !el.classList.contains('show')) {
      const k = kind || (/WRONG|MISSED|OUT OF|DNF|DISQUAL|CRASH/i.test(text) ? 'bad' : /RECORD|BEST|GOLD/i.test(text) ? 'good' : 'info');
      const len = String(text).length;
      const w = Math.round(Math.min(1100, 170 + len * 30));
      el.innerHTML = `<div class="rh-note ${k}" style="width:calc(var(--u) * ${Math.round(w * 0.84)})">${brushSVG(900 + (len % 7), w, 100)}<span>${esc(text)}</span></div>`;
      replay(el, 'show');
      this.noticeText = text;
    }
    if (ms > 0) this.noticeT = setTimeout(() => { el.classList.remove('show'); this.noticeText = null; }, ms);
  }

  /**
   * Trick popup: name, points, landing quality colour and the running trick score. A bailed trick
   * shows just its name and BAILED (no points). Works outside races too.
   */
  trick({ name = '', points = 0, total, landed = 'clean' } = {}) {
    const el = this.$.trick;
    const q = LANDINGS[landed] ? landed : 'clean';
    const bailed = q === 'crash';
    const card = document.createElement('div');
    card.className = `rh-panel tp ${q}`;
    card.style.setProperty('--clip', brushClip(340 + (this.trickN++ % 9), 4, 3));
    card.innerHTML = `<div class="tp-name">${esc(name)}</div>`
      + `<div class="tp-line">${bailed ? '' : `<b class="tp-pts">+${fmtPts(points)}</b>`}<span class="tp-q">${LANDINGS[q]}</span></div>`
      + (!bailed && Number.isFinite(total) && total > points ? `<div class="tp-total">SCORE <b>${fmtPts(total)}</b></div>` : '');
    el.replaceChildren(card);
    clearTimeout(this.trickT);
    this.trickT = setTimeout(() => {
      card.classList.add('out');
      setTimeout(() => card.remove(), 450);
    }, 2300);
  }

  /**
   * Personal best / milestone card (free ride, game/bests.js), under the trick popups:
   * a small kicker line, the title and the value with its unit.
   */
  best({ kicker = 'PERSONAL BEST', title = '', value = '', unit = '' } = {}) {
    const el = this.$.best;
    const card = document.createElement('div');
    card.className = 'rh-panel tp tp-best';
    card.style.setProperty('--clip', brushClip(360 + (this.trickN++ % 9), 4, 3));
    card.innerHTML = `<div class="tp-kick">${esc(kicker)}</div><div class="tp-name">${esc(title)}</div>`
      + `<div class="tp-line"><b class="tp-pts">${esc(String(value))}</b><span class="tp-q">${esc(unit)}</span></div>`;
    el.replaceChildren(card);
    clearTimeout(this.bestT);
    this.bestT = setTimeout(() => {
      card.classList.add('out');
      setTimeout(() => card.remove(), 450);
    }, 2800);
  }

  /**
   * Results screen. Resolves with the player's choice.
   * @param {object} o
   * @param {string} o.courseName
   * @param {'race'|'trial'} o.mode
   * @param {Array<{name: string, time: number, gap: number, me?: boolean, dnf?: boolean}>} o.rows  finishing order
   * @param {number|null} o.place  1-based (race); trial may pass null
   * @param {number} o.time  the player's time (non-finite = DNF)
   * @param {'gold'|'silver'|'bronze'|null} o.medal
   * @param {boolean} o.pb  new personal best
   * @param {number} [o.previousBest]
   * @param {number} [o.points]  trick points
   * @param {number} [o.penalty]  seconds of penalties included in the time
   * @param {string} [o.difficulty]  AI difficulty label (race)
   * @param {boolean} [o.canNext=true]  show NEXT (next course)
   * Trial rows may include reference rows: { kind: 'ghost' } (previous best) and { kind: 'medal', medal }.
   * @returns {Promise<'retry'|'next'|'menu'>}
   */
  results(o = {}) {
    const { courseName = '', mode = 'race', rows = [], place = null, time, medal = null, pb = false, previousBest, points, penalty, difficulty, canNext = true, prize, choices: custom } = o;
    this.pending?.('menu', true); // a stale results screen resolves (silently) first
    clearTimeout(this.resT);
    this.suspend();
    if (Number.isFinite(time)) this.suspendTime = Math.max(this.suspendTime || 0, time);
    this.$.trick.replaceChildren();
    const trial = mode === 'trial';
    const dnf = !Number.isFinite(time);
    const hasMedal = !dnf && ['gold', 'silver', 'bronze'].includes(medal);

    const hero = dnf ? '<b class="rr-big">DNF</b>'
      : trial || !(place > 0) ? `<b class="rr-big rr-clock">${fmtTime(time)}</b>`
      : `<b class="rr-big">${place}</b><span class="rr-suf">${ordinal(place)}</span>`;
    const lines = [];
    if (!dnf && !trial && place > 0) lines.push(`<div class="rr-line"><span>TIME</span><b>${fmtTime(time)}</b></div>`);
    if (trial && !dnf) lines.push(`<div class="rr-line"><span>MEDAL</span><b>${hasMedal ? medal.toUpperCase() : 'NONE'}</b></div>`);
    if (pb && !dnf) {
      const gain = Number.isFinite(previousBest) ? `<em>${fmtDelta(time - previousBest)}</em>` : '';
      lines.push(`<div class="rr-pb"><span>NEW PERSONAL BEST</span>${gain}</div>`);
    } else if (Number.isFinite(previousBest)) {
      const diff = dnf ? '' : `<em class="${time - previousBest > 0 ? 'behind' : 'ahead'}">${fmtDelta(time - previousBest)}</em>`;
      lines.push(`<div class="rr-line"><span>PERSONAL BEST</span><b>${fmtTime(previousBest)}</b>${diff}</div>`);
    }
    if (Number.isFinite(penalty) && penalty > 0) lines.push(`<div class="rr-line"><span>PENALTIES</span><b class="pen">+${penalty.toFixed(2)}</b></div>`);
    if (Number.isFinite(points) && points > 0) lines.push(`<div class="rr-line"><span>TRICK POINTS</span><b>${fmtPts(points)}</b></div>`);
    if (Number.isFinite(prize) && prize > 0) lines.push(`<div class="rr-line"><span>PRIZE MONEY</span><b class="prize">+$${Math.round(prize).toLocaleString('en-US')}</b></div>`);

    // race: finishing order with gaps to the winner; trial: you against your PB and the medal times
    // (the last column then reads from your side: red = you were slower, green = faster)
    const cell = (r, i, out) => {
      if (out) return '—';
      if (!trial) return String(i + 1);
      if (r.medal) return medalHTML(r.medal, 26);
      return r.kind === 'ghost' ? 'PB' : '';
    };
    const diffCell = (r, out) => {
      if (out) return '—';
      if (!trial) return fmtGap(r.gap);
      if (r.me || dnf) return '—';
      const dd = time - r.time;
      return `<em class="${dd > 0 ? 'behind' : 'ahead'}">${fmtDelta(dd)}</em>`;
    };
    // (a full 15-racer field gets the compact table: every row fits without scrolling)
    const table = rows.length ? `<div class="rh-panel rr-table${rows.length > 8 ? ' big' : ''}" style="--clip:${brushClip(360, 5, 4)}">
        <div class="rr-th"><span>${trial ? '' : 'POS'}</span><span>${trial ? 'RUN' : 'RACER'}</span><span>TIME</span><span>${trial ? 'YOU' : 'GAP'}</span></div>
        ${rows.map((r, i) => {
          const out = r.dnf || !Number.isFinite(r.time);
          return `<div class="rr-tr${r.me ? ' me' : ''}${out ? ' dnf' : ''}" style="animation-delay:${480 + i * (rows.length > 8 ? 40 : 70)}ms">`
            + `<span class="rr-p">${cell(r, i, out)}</span><span class="rr-n">${esc(r.name)}</span>`
            + `<span class="rr-t">${out ? 'DNF' : fmtTime(r.time)}</span><span class="rr-g">${diffCell(r, out)}</span></div>`;
        }).join('')}
      </div>` : '';

    // (open-world races bring their own: RACE AGAIN / BACK TO START)
    const choices = custom || [['retry', 'RETRY', 'R'], canNext ? ['next', 'NEXT', 'ENTER'] : null, ['menu', 'MENU', 'ESC']].filter(Boolean);
    const actions = choices.map(([id, label, key], i) => `<button class="brush-btn rr-btn" tabindex="-1" data-choice="${id}">${brushSVG(370 + i * 3)}<span>${label}<i class="kc">${key}</i></span></button>`).join('');

    const el = this.resEl;
    el.innerHTML = `<div class="rr-shade"></div>
      <div class="rr-wrap${table ? '' : ' solo'}">
        <div class="rr-hero">
          <div class="rr-kicker">${trial ? 'WORLD RACING' : 'RACE'}${difficulty && !trial ? ` · ${esc(String(difficulty).toUpperCase())}` : ''} · RESULTS</div>
          <div class="rr-course">${esc(courseName)}</div>
          <div class="rr-place${dnf ? ' dnf' : ''}${hasMedal ? ' medalled' : ''}">${brushSVG(355, 520, 200)}<div class="rr-place-txt">${hero}</div>${hasMedal ? medalHTML(medal, 104, 'shine') : ''}</div>
          <div class="rr-lines">${lines.join('')}</div>
        </div>
        ${table}
      </div>
      <div class="rr-actions">${actions}</div>`;
    el.classList.remove('out');
    el.hidden = false;
    replay(el, 'in');
    this.modalOpen = true;
    this.hud?.setBlocking?.('results', true);
    document.exitPointerLock?.();

    const buttons = [...el.querySelectorAll('[data-choice]')];
    let fi = Math.max(0, buttons.findIndex((b) => b.dataset.choice === (custom ? choices.find((c) => c[2] === 'ENTER')?.[0] : canNext ? 'next' : 'retry')));
    const focus = (i, silent = false) => {
      fi = (i + buttons.length) % buttons.length;
      buttons.forEach((b, j) => b.classList.toggle('is-focus', j === fi));
      if (!silent) this.audio?.play('tick');
    };
    focus(fi, true);
    const shownAt = performance.now();

    return new Promise((resolve) => {
      const onKey = (e) => {
        const k = e.code;
        if (!RESULT_KEYS.has(k)) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.repeat || performance.now() - shownAt < 600) return; // keys still held from the run
        if (k === 'Escape') finish((choices.find((c) => c[2] === 'ESC') || choices.find((c) => c[2] === 'ENTER') || choices.at(-1))[0]);
        else if (k === 'KeyR') { if (choices.some((c) => c[0] === 'retry')) finish('retry'); }
        else if (k === 'ArrowLeft' || k === 'KeyA') focus(fi - 1);
        else if (k === 'ArrowRight' || k === 'KeyD') focus(fi + 1);
        else finish(buttons[fi].dataset.choice);
      };
      const finish = (choice, silent = false) => {
        if (this.pending !== finish) return;
        this.pending = null;
        removeEventListener('keydown', onKey, true);
        if (!silent) this.audio?.play('click');
        // RETRY: the race panels come back with the new run (NEXT / MENU end in hide())
        this.retryPending = choice === 'retry' && this.suspended;
        this.closeResults();
        resolve(choice);
      };
      this.pending = finish;
      addEventListener('keydown', onKey, true);
      buttons.forEach((b, i) => {
        b.addEventListener('mouseenter', () => { if (fi !== i) focus(i); });
        b.addEventListener('mousedown', (e) => e.preventDefault());
        b.addEventListener('click', () => finish(b.dataset.choice));
      });
    });
  }

  closeResults() {
    this.modalOpen = false;
    this.hud?.setBlocking?.('results', false);
    const el = this.resEl;
    el.classList.add('out');
    clearTimeout(this.resT);
    this.resT = setTimeout(() => {
      el.hidden = true;
      el.classList.remove('out', 'in');
      el.innerHTML = '';
    }, 320);
  }
}

const RESULT_KEYS = new Set(['Enter', 'NumpadEnter', 'Space', 'Escape', 'KeyR', 'ArrowLeft', 'ArrowRight', 'KeyA', 'KeyD']);
