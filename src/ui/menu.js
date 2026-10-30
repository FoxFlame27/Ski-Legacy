// Front-end menus over the live 3D world:
//   Main (PLAY · CONTROLS · STATS · SETTINGS · QUIT): PLAY opens the character select (MAN or WOMAN on the 3D
//   showcase) and its START drops you into free ride (no mode chooser any more, Oct 27: RACE "just for fun" lives
//   at the RACING stand in Legacy Village, ui/racestand.js; WORLD RACING is gone). PLAY first asks SINGLEPLAYER or
//   MULTIPLAYER (Oct 29): multiplayer asks for your unique name on first launch (mpName), then connects (mpStatus /
//   mpError) while main.js and net/session.js log in,
// plus stats, settings and the in-game pause menu.
// House style: white paint-brush strokes with blue italic condensed lettering.
// Every size is expressed in the CSS unit --u (1u = 1px on a 1280x800 canvas, see style.css),
// so each screen fits anything from 1024x640 up to 2880x1800 without overflowing.
import { save, writeSave, resetSave, skiById } from '../game/economy.js';
import { QUALITY_ORDER, QUALITY_LABELS, normalizeQuality } from '../engine/quality.js';
import { fmtTime, CONTROLS, keysHTML } from './hud.js';
import { PLAYER_CHARACTERS } from '../game/characters.js';

// ------------------------------------------------------------------ brush art

/** Deterministic pseudo-random sequence for the hand-painted shapes. */
export function rng(seed) {
  let s = seed * 9301 + 49297;
  return () => ((s = (s * 233280 + 49297) % 2147483647) / 2147483647);
}

/**
 * Vertical band (fractions of the stroke height) a label's ink must stay inside. The stroke body is
 * solid paint from edge to edge everywhere left of brushTextEnd(); this band only keeps the letters
 * clear of the gently wavy top and bottom edges (they never come closer than 0.157 / 0.843).
 */
export const TEXT_BAND = [0.2, 0.8];

const TAIL_NOTCH = 0.16; // max depth of the valleys between bristle fingers (x tail length)
const tailLength = (w, h) => Math.min(w * 0.24, h * 0.62);

/** Fraction of the stroke width where the bristle tail begins: labels must end before it. */
export function brushTextEnd(w = 420, h = 96) {
  return (w - tailLength(w, h) * (1 + TAIL_NOTCH)) / w;
}

const n1 = (v) => v.toFixed(1);

// smooth curve through a polyline whose first point is the current pen position
function smoothTo(P) {
  let s = '';
  for (let i = 1; i < P.length - 1; i++) {
    s += ` Q${n1(P[i][0])},${n1(P[i][1])} ${n1((P[i][0] + P[i + 1][0]) / 2)},${n1((P[i][1] + P[i + 1][1]) / 2)}`;
  }
  const L = P[P.length - 1];
  return `${s} L${n1(L[0])},${n1(L[1])}`;
}

/**
 * A paint stroke as an inline SVG (stretched to its box with preserveAspectRatio="none").
 * Blunt left start, gently wobbling edges and a bristle tail fanning out on the right.
 * The body is ONE solid shape: no dry-brush slits, streaks or loose hairs anywhere, so nothing can
 * ever run through a label. The brush character lives only in the silhouette (wavy edges, uneven
 * bristle fingers), and the valleys between the fingers stop right of brushTextEnd().
 * @param {number} seed  shape seed (same seed = same stroke)
 * @param {number} w, h  viewBox size; keep the aspect close to the element's box
 * @param {{fill?: string, cls?: string}} [opt]
 */
export function brushSVG(seed = 1, w = 420, h = 96, opt = {}) {
  const fill = opt.fill || '#fff';
  const cls = opt.cls || 'brush';
  const r = rng(seed);
  r();
  const tail = tailLength(w, h);
  const x1 = w - tail; // bristles start here
  const xa = Math.min(h * 0.16, w * 0.06); // blunt left cap meets the long edges here
  const ph = [r() * 6.283, r() * 6.283, r() * 6.283, r() * 6.283];
  const top = (x) => h * 0.12 + Math.sin((x / w) * 5.1 + ph[0]) * h * 0.022 + Math.sin((x / w) * 12.7 + ph[1]) * h * 0.011;
  const bot = (x) => h * 0.88 + Math.sin((x / w) * 4.3 + ph[2]) * h * 0.022 + Math.sin((x / w) * 11.3 + ph[3]) * h * 0.011;

  // long edges, sampled left -> right (jitter is tiny: the edge never approaches the text band)
  const N = Math.max(8, Math.round((x1 - xa) / (h * 0.42)));
  const T = [], B = [];
  for (let i = 0; i <= N; i++) {
    const x = xa + ((x1 - xa) * i) / N;
    T.push([x, top(x) + (r() - 0.5) * h * 0.008]);
    B.push([x, bot(x) + (r() - 0.5) * h * 0.008]);
  }

  // outline, clockwise on screen: top edge -> bristle tail -> bottom edge -> blunt cap
  let d = `M${n1(T[0][0])},${n1(T[0][1])}${smoothTo(T)}`;
  const yT = T[N][1], yB = B[N][1];
  // bristle tail: 8-12 fingers of uneven width and length; the valleys between them stay shallow
  // (at most TAIL_NOTCH x tail), i.e. always right of the label limit
  const F = 8 + Math.floor(r() * 5);
  const wts = [];
  let sum = 0;
  for (let k = 0; k < F; k++) { const v = 0.45 + r() * 1.1; wts.push(v); sum += v; }
  let y0 = yT, acc = 0;
  for (let k = 0; k < F; k++) {
    acc += wts[k];
    const y1 = k === F - 1 ? yB : yT + ((yB - yT) * acc) / sum;
    const ym = y0 + (y1 - y0) * (0.35 + r() * 0.3);
    const outer = k === 0 || k === F - 1;
    const len = tail * (outer ? 0.25 + r() * 0.35 : 0.3 + r() * 0.7);
    const tipX = Math.min(w - 1, x1 + len);
    d += ` Q${n1(x1 + len * 0.55)},${n1(y0 + (ym - y0) * 0.25)} ${n1(tipX)},${n1(ym)}`;
    if (k < F - 1) {
      const notch = x1 - tail * TAIL_NOTCH * r();
      d += ` Q${n1(x1 + len * 0.45)},${n1(y1 - (y1 - ym) * 0.35)} ${n1(notch)},${n1(y1)}`;
    } else d += ` Q${n1(x1 + len * 0.5)},${n1(y1 - (y1 - ym) * 0.25)} ${n1(x1)},${n1(yB)}`;
    y0 = y1;
  }
  B.reverse();
  d += smoothTo(B);
  const capX = h * (0.015 + r() * 0.03);
  const capY = h * (0.5 + (r() - 0.5) * 0.06);
  d += ` Q${n1(capX + h * 0.02)},${n1(h * 0.86)} ${n1(capX)},${n1(capY)}`;
  d += ` Q${n1(capX + h * 0.02)},${n1(h * 0.14)} ${n1(T[0][0])},${n1(T[0][1])} Z`;

  return `<svg class="${cls}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}" fill="${fill}"/></svg>`;
}

/**
 * Ragged hand-painted silhouette for panels and cards, as a CSS polygon().
 * Perpendicular raggedness is in --u so it looks the same on any panel size.
 * Use as an inline custom property: style="--clip:${brushClip(seed)}" (applied by the ::before paper).
 */
export function brushClip(seed = 1, amp = 6, side = 4) {
  const r = rng(seed + 7);
  r();
  const u = (v) => `calc(var(--u) * ${v.toFixed(1)})`;
  const NX = 14, NY = 5, pts = [];
  for (let i = 0; i <= NX; i++) pts.push(`${((i / NX) * 100).toFixed(1)}% ${u(r() * amp)}`);
  for (let j = 1; j < NY; j++) pts.push(`calc(100% - ${u(r() * side)}) ${((j / NY) * 100).toFixed(1)}%`);
  for (let i = NX; i >= 0; i--) pts.push(`${((i / NX) * 100).toFixed(1)}% calc(100% - ${u(r() * amp)})`);
  for (let j = NY - 1; j >= 1; j--) pts.push(`${u(r() * side)} ${((j / NY) * 100).toFixed(1)}%`);
  return `polygon(${pts.join(', ')})`;
}

export const MEDALS = ['gold', 'silver', 'bronze'];

/** CSS-drawn medal (ribbon + embossed disc). size in u; 'none' renders an empty dashed ring. */
export function medalHTML(medal, size = 48, extra = '') {
  const m = MEDALS.includes(medal) ? medal : 'none';
  const num = m === 'none' ? '' : `<b>${MEDALS.indexOf(m) + 1}</b>`;
  const cls = `medal ${m}${size < 36 ? ' sm' : ''}${extra ? ' ' + extra : ''}`;
  return `<span class="${cls}" style="--s:${size}"><i class="m-ribbon"></i><i class="m-disc">${num}</i></span>`;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Restart a CSS animation class on an element. */
export function replay(el, cls) {
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

const seedOf = (str) => [...String(str)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 9973, 17);
const fmtMoney = (v) => (v || 0).toLocaleString('en-US');

// ------------------------------------------------------------------ data

// used only if main.js provides no getCourses() hook
const FALLBACK_COURSES = [
  { id: 'alpine', name: 'Legacy World Downhill', tagline: 'The classic: long, fast and wide open.', difficulty: 'Medium' },
  { id: 'icecanyon', name: 'Ice Canyon', tagline: 'Frozen gorge, bridges, a tunnel and a lake.', difficulty: 'Hard' },
  { id: 'bigair', name: 'Big Air Line', tagline: 'Kickers, tabletops and rollers. Style pays.', difficulty: 'Easy' },
];

// the player characters: MAN and WOMAN (game/characters.js). No names and no stats: both ski exactly the
// same, and every look comes from the ski shop
function normalizeCharacters(list) {
  const src = Array.isArray(list) && list.length ? list : PLAYER_CHARACTERS;
  return src.map((c) => ({ id: c.id, label: String(c.label || c.body || c.id).toUpperCase() }));
}

// last menu choices (per viewer convenience; game progress lives in the save)
const PREFS_KEY = 'ski-legacy-menu';
function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {}; } catch { return {}; }
}
function savePrefs(p) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* storage unavailable */ }
}

// keyboard -> menu action (arrows + WASD navigate, Enter/Space confirm, Esc/Backspace go back)
const KEYMAP = {
  ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
  Enter: 'enter', NumpadEnter: 'enter', Space: 'enter', Escape: 'back', Backspace: 'back',
};

const KEYCAPS = {
  updown: '<i class="kc kc-arrow up"></i><i class="kc kc-arrow down"></i>',
  leftright: '<i class="kc kc-arrow left"></i><i class="kc kc-arrow right"></i>',
  enter: '<i class="kc">ENTER</i>',
  esc: '<i class="kc">ESC</i>',
};
const hintsHTML = (list) => list.map(([k, label]) => `<span class="hint"${/back/i.test(label) ? ' data-hint-back style="cursor:pointer;pointer-events:auto"' : ''}>${KEYCAPS[k] || ''}<em>${label}</em></span>`).join(''); // (ESC · BACK is clickable)

// ------------------------------------------------------------------ menu

export class Menu {
  /**
   * @param {object} o
   * @param {Array<{id, body?, label?}>} o.characters  the player characters to choose from (MAN, WOMAN)
   * @param {(sel: {mode: 'free', courseId: null, character: string}) => void} o.onStart  PLAY / START: into free ride
   * @param {(charId: string|null) => void} [o.onShowcase]  show / swap / remove the 3D showcase skier
   * @param {(deltaYaw: number) => void} [o.onShowcaseSpin]  drag on the showcase turns the skier (radians)
   * @param {() => Array<{id, name, tagline, difficulty, length, drop, par?, medals?, record?: {best, medal}}>} [o.getCourses]
   * @param {() => void} [o.onMainMenu]  pause menu -> MAIN MENU (can also be given to showPause)
   * @param {() => void} [o.onPlay]  legacy: called when onStart is not provided
   */
  constructor(o = {}) {
    this.el = document.getElementById('menu');
    this.audio = o.audio;
    this.characters = o.characters;
    this.chars = normalizeCharacters(o.characters);
    this.onStart = o.onStart;
    this.onShowcase = o.onShowcase;
    this.onShowcaseSpin = o.onShowcaseSpin;
    this.getCourses = o.getCourses;
    this.onMainMenu = o.onMainMenu;
    this.onPlay = o.onPlay;
    this.onQuality = o.onQuality;
    this.onSens = o.onSens;
    this.onVolume = o.onVolume;
    this.mpActive = o.mpActive;           // () => true while in multiplayer (settings hide "Reset all progress")
    this.onMultiplayer = o.onMultiplayer; // MULTIPLAYER ... START: main.js connects (see mpName / mpStatus / mpError)
    this.onMpName = o.onMpName;           // the name typed on first launch -> main.js registers it
    this.onMpCancel = o.onMpCancel;       // BACK while connecting
    this.mpMode = false;                  // PLAY -> MULTIPLAYER picked (the showcase's START then goes online)
    this.mpState = { error: '', text: '', value: '' };
    this.prefs = loadPrefs();
    this.sel = { mode: 'free', courseId: null };
    this.ready = false;
    this.load = { f: 0, t: 'Loading world' };
    this.inGame = false;
    this.screen = null;
    this.cur = null; // { name, def, el }
    this.focusables = [];
    this.fi = -1;
    this.chi = 0;
    this.showcaseOn = false;
    this.starting = false;
    this.built = false;
  }

  // persistent chrome: shades, logo, screen stage, footer with key hints
  ensureChrome() {
    if (this.built && this.stage?.isConnected) return;
    this.el.innerHTML = `
      <div class="menu-shades"><div class="shade shade-left"></div><div class="shade shade-full"></div><div class="shade shade-show"></div></div>
      <div class="menu-logo"><div class="ml-ski">SKI</div><div class="ml-legacy">LEGACY</div></div>
      <div class="menu-mark"><b>SKI</b><span>LEGACY</span></div>
      <div class="menu-stage"></div>
      <div class="menu-foot"><div class="menu-hints"></div><div class="menu-credit">Icecold Studio</div></div>`;
    this.stage = this.el.querySelector('.menu-stage');
    this.hintsEl = this.el.querySelector('.menu-hints');
    this.hintsEl.addEventListener('click', (e) => { if (e.target.closest('[data-hint-back]')) this.back(false); });
    if (this.built) return;
    this.built = true;
    // capture phase: the menu owns the keyboard while it is visible (game input never sees these keys)
    this.downKeys = new Set();
    addEventListener('keydown', (e) => this.onKey(e), true);
    addEventListener('keyup', (e) => this.downKeys.delete(e.code), true);
    addEventListener('blur', () => this.downKeys.clear());
  }

  /** Main menu (out of game). Also used to come back from the pause menu's MAIN MENU. */
  show() {
    this.ensureChrome();
    clearTimeout(this.hideT);
    this.el.hidden = false;
    this.el.classList.remove('leaving', 'paused');
    document.body.classList.add('menu-open');
    this.inGame = false;
    this.starting = false;
    this.pauseHandlers = null;
    this.go('main', 0);
  }

  hide() {
    this.leaveShowcase();
    clearTimeout(this.hideT);
    this.el.classList.add('leaving');
    this.hideT = setTimeout(() => {
      this.el.hidden = true;
      this.el.classList.remove('leaving');
      document.body.classList.remove('menu-open');
    }, 500);
  }

  setLoading(f, text) {
    this.load = { f, t: text };
    const t = this.el.querySelector('.menu-screen.current .spin-text');
    if (t) t.textContent = text;
  }

  setReady() {
    this.ready = true;
    // the buttons sweep in once the world is ready
    if (!this.el.hidden && this.cur?.name === 'main') this.go('main', 0);
  }

  // In-game pause (Esc): same brush look over the frozen world.
  // handlers: { onResume, onMainMenu?, onRestart?, onVillage?, onQuit? } (buttons appear per handler)
  showPause(handlers = {}) {
    this.ensureChrome();
    clearTimeout(this.hideT);
    this.pauseHandlers = handlers;
    this.inGame = true;
    this.starting = false; // Esc right after START: the pause menu must respond at once
    this.el.hidden = false;
    this.el.classList.remove('leaving');
    this.el.classList.add('paused');
    document.body.classList.add('menu-open');
    this.go('pause', 0);
  }

  hidePause() {
    this.el.hidden = true;
    this.el.classList.remove('paused');
    document.body.classList.remove('menu-open');
  }

  /**
   * Where main.js should stand the showcase skier: the middle of the free area right of the panel,
   * in normalized screen coordinates (x 0..1 from the left, y 0..1 from the top).
   */
  showcaseAnchor() {
    const W = innerWidth || 1, H = innerHeight || 1;
    const el = this.cur?.name === 'showcase' ? this.cur.el : null;
    const panel = el?.querySelector('.sc-panel')?.getBoundingClientRect();
    if (panel && panel.width > 0) {
      const left = panel.right, right = W * 0.96;
      return { x: (left + right) / 2 / W, y: 0.56, left: left / W, right: 0.96, height: H };
    }
    return { x: 0.68, y: 0.56, left: 0.4, right: 0.96, height: H };
  }

  // ---------------------------------------------------------------- screens

  btn(label, act, seed, cls = '') {
    return `<button class="brush-btn ${cls}" data-act="${act}" data-f data-stagger tabindex="-1">${brushSVG(seed)}<span>${esc(label)}</span></button>`;
  }

  // screen title: a brush strip sized to its text, with an optional white subtitle
  head(title, sub) {
    const w = Math.round(Math.min(760, 150 + title.length * 26));
    return `<div class="menu-head">
        <div class="menu-title" data-stagger style="width:calc(var(--u) * ${Math.round(w * 0.9)})">${brushSVG(seedOf(title), w, 100)}<span>${esc(title)}</span></div>
        ${sub ? `<div class="menu-sub" data-stagger>${esc(sub)}</div>` : ''}
      </div>`;
  }

  buildScreen(name) {
    switch (name) {
      case 'showcase': return this.scrShowcase();
      case 'controls': return this.scrControls();
      case 'stats': return this.scrStats();
      case 'settings': return this.scrSettings();
      case 'pause': return this.scrPause();
      case 'playmode': return this.scrPlayMode();
      case 'mpname': return this.scrMpName();
      case 'mpwait': return this.scrMpWait();
      default: return this.scrMain();
    }
  }

  scrMain() {
    if (!this.ready) {
      return { logo: 'big', shade: 'left', hints: [], html: `<div class="menu-col">
        <div class="menu-spinner"><div class="spin"></div><div class="spin-text">${esc(this.load.t)}</div></div></div>` };
    }
    return {
      logo: 'big', shade: 'left', hints: [['updown', 'Select'], ['enter', 'Confirm']],
      html: `<div class="menu-col">${this.btn('PLAY', 'play', 3, 'big')}${this.btn('CONTROLS', 'controls', 31)}${this.btn('STATS', 'stats', 7)}`
        + `${this.btn('SETTINGS', 'settings', 11)}${this.btn('QUIT', 'quit', 13, 'small')}</div>`,
    };
  }

  // PLAY: single player (the free ride as always) or multiplayer (the shared free ride, up to 15 per world)
  scrPlayMode() {
    return {
      logo: 'big', shade: 'left', hints: [['updown', 'Select'], ['enter', 'Confirm'], ['esc', 'Back']],
      html: `<div class="menu-col">${this.btn('SINGLEPLAYER', 'single', 41, 'big')}${this.btn('MULTIPLAYER', 'multi', 43, 'big')}${this.btn('BACK', 'back', 13, 'small')}</div>`,
      back: () => this.go('main', -1),
    };
  }

  // first multiplayer launch: your name (unique for good; the server says when it is taken)
  scrMpName() {
    const st = this.mpState;
    return {
      logo: 'small', shade: 'left', hints: [['enter', 'Continue'], ['esc', 'Back']],
      html: `${this.head('MULTIPLAYER', 'Pick your name · it is yours for good')}
        <div class="sc-panel" data-stagger style="--clip:${brushClip(146, 6, 4)}">
          <div class="mp-head">YOUR NAME</div>
          <input class="mpn-input" maxlength="16" spellcheck="false" autocomplete="off" placeholder="3-16 letters" value="${esc(st.value || '')}">
          <div class="mpn-err">${esc(st.error || '')}</div>
          <div class="sc-note">Other players see it above your head and over your chalet. Letters, digits, spaces, _ and -.</div>
        </div>
        <div class="sc-actions">${this.btn('CONTINUE', 'mpname', 47, 'big')}</div>`,
      after: (el) => {
        const inp = el.querySelector('.mpn-input');
        setTimeout(() => { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }, 60);
        inp.addEventListener('input', () => { this.mpState.value = inp.value; });
      },
      keys: { enter: () => this.action('mpname'), up: () => {}, down: () => {} },
      back: () => { this.onMpCancel?.(); this.go('playmode', -1); },
    };
  }

  // connecting / joining a world, or what went wrong
  scrMpWait() {
    const st = this.mpState;
    return {
      logo: 'small', shade: 'left', hints: [['esc', 'Back']],
      html: `${this.head('MULTIPLAYER', st.error ? 'Could not join' : 'Joining a world')}
        <div class="menu-col">${st.error ? `<div class="mpw-text bad">${esc(st.error)}</div>`
          : `<div class="menu-spinner"><div class="spin"></div><div class="spin-text">${esc(st.text || 'Connecting…')}</div></div>`}
          ${this.btn('BACK', 'back', 13, 'small')}</div>`,
      back: () => { this.onMpCancel?.(); this.mpMode = false; this.starting = false; this.go('playmode', -1); },
    };
  }

  /** main.js: ask for a name (error: the server's reason the last one was refused). */
  mpName(error = '') { this.mpState.error = error; this.starting = false; this.go('mpname', error ? 0 : 1); }
  /** main.js: connecting / logging in (the spinner's text). */
  mpStatus(text) {
    const wasError = !!this.mpState.error;
    this.mpState.error = ''; this.mpState.text = text;
    const t = !wasError && this.cur?.name === 'mpwait' ? this.cur.el.querySelector('.spin-text') : null;
    if (t) t.textContent = text; else this.go('mpwait', 1);
  }
  /** main.js: it failed (the menu shows why, BACK returns to SINGLEPLAYER / MULTIPLAYER). */
  mpError(text) { this.mpState.error = text; this.starting = false; this.go('mpwait', 0); }

  // keyboard reference: three white panels (on the snow / in the air / general)
  scrControls() {
    const panels = CONTROLS.map((g, i) => `<div class="menu-panel ctl-panel" data-stagger style="--clip:${brushClip(170 + i, 5, 4)}">
        <div class="mp-head">${esc(g.title)}</div>
        ${g.rows.map(([keys, label, sub]) => `<div class="ctl-row"><span class="ctl-keys">${keysHTML(keys)}</span>`
          + `<span class="ctl-do">${esc(label)}${sub ? `<small>${esc(sub)}</small>` : ''}</span></div>`).join('')}
        ${g.note ? `<div class="ctl-note">${esc(g.note)}</div>` : ''}
      </div>`).join('');
    return {
      logo: 'small', shade: 'full', hints: [['esc', 'Back']],
      html: `${this.head('CONTROLS', 'Keyboard and mouse')}<div class="ctl-wrap">${panels}</div>`,
      back: () => this.go(this.inGame ? 'pause' : 'main', -1),
    };
  }

  fetchCourses() {
    let list = null;
    try { list = this.getCourses?.(); } catch (e) { console.warn('getCourses failed', e); }
    if (!Array.isArray(list) || !list.length) list = FALLBACK_COURSES.map((c) => ({ ...c, record: save.records?.[c.id] || null }));
    return list;
  }

  // Character select: MAN or WOMAN. main.js stands the chosen skier in 3D (ski stance, dressed as equipped)
  // in the free area on the right; the panel only holds the two choices: every look is bought in the ski
  // shop, and nothing differs in how they ski (no names, no stats).
  scrShowcase() {
    this.chi = Math.max(0, this.chars.findIndex((c) => c.id === save.character));
    const picks = this.chars.map((c, i) => `<button class="${i === this.chi ? 'on' : ''}" tabindex="-1" data-act="pick:${i}">${esc(c.label)}</button>`).join('');
    const spin = typeof this.onShowcaseSpin === 'function';
    return {
      logo: 'small', shade: 'show',
      hints: [['leftright', 'Man / woman'], ['enter', 'Start'], ['esc', 'Back'], ...(spin ? [['', 'Drag to rotate']] : [])],
      html: `${spin ? '<div class="sc-drag" aria-hidden="true"></div>' : ''}${this.head('CHOOSE YOUR SKIER', this.mpMode && !this.inGame ? 'Multiplayer free ride · up to 15 per world' : 'Free ride · the open resort')}
        <div class="sc-panel" data-stagger style="--clip:${brushClip(140, 6, 4)}">
          <div class="seg-brush sc-pick">${picks}</div>
          <div class="sc-note">Customize your look in the ski shop: jackets, trousers, helmets and goggles.</div>
        </div>
        <div class="sc-actions">${this.btn('START', 'start', 17, 'big')}</div>`,
      after: (el) => {
        // drag across the free area to turn the 3D skier (main.js applies the yaw)
        const drag = el.querySelector('.sc-drag');
        if (drag) {
          let lastX = null;
          drag.addEventListener('pointerdown', (e) => { lastX = e.clientX; drag.setPointerCapture?.(e.pointerId); drag.classList.add('dragging'); });
          drag.addEventListener('pointermove', (e) => {
            if (lastX === null) return;
            this.onShowcaseSpin?.((e.clientX - lastX) * 0.012);
            lastX = e.clientX;
          });
          const end = () => { lastX = null; drag.classList.remove('dragging'); };
          drag.addEventListener('pointerup', end);
          drag.addEventListener('pointercancel', end);
        }
      },
      // left / right pick MAN / WOMAN; Enter presses the highlighted button (START by default)
      keys: { left: () => this.pickChar(this.chi - 1), right: () => this.pickChar(this.chi + 1), up: () => {}, down: () => {} },
      back: () => this.go(this.inGame ? 'settings' : 'playmode', -1), // (opened from SETTINGS in game: back there)
    };
  }

  // MAN / WOMAN (left / right keys stop at the ends, like the difficulty switch)
  pickChar(i, silent = false) {
    const n = this.chars.length;
    if (!n || this.cur?.name !== 'showcase') return;
    i = Math.max(0, Math.min(n - 1, i));
    if (i === this.chi) return;
    this.chi = i;
    const c = this.chars[i];
    save.character = c.id; // written to disk on START
    const btns = [...this.cur.el.querySelectorAll('.sc-pick [data-act^="pick:"]')];
    btns.forEach((b, j) => b.classList.toggle('on', j === i));
    if (btns[i]) replay(btns[i], 'kick');
    if (this.showcaseOn) this.onShowcase?.(c.id);
    if (!silent) this.audio?.play('tick');
  }

  enterShowcase() {
    this.showcaseOn = true;
    this.onShowcase?.(this.chars[this.chi]?.id ?? null);
  }

  leaveShowcase() {
    if (!this.showcaseOn) return;
    this.showcaseOn = false;
    this.onShowcase?.(null);
  }

  // PLAY (straight into free ride as the saved skier) and the character screen's START
  start() {
    if (this.cur?.name !== 'showcase') this.chi = Math.max(0, this.chars.findIndex((x) => x.id === save.character));
    const c = this.chars[this.chi];
    if (this.starting || !c) return;
    this.starting = true;
    save.character = c.id;
    if (this.cur?.name === 'showcase') save.characterChosen = true;
    writeSave();
    savePrefs(this.prefs);
    const payload = { mode: this.mpMode && !this.inGame ? 'mp' : 'free', courseId: null, character: c.id };
    if (payload.mode === 'mp') { this.onMultiplayer?.(payload); setTimeout(() => { this.starting = false; }, 600); return; }
    // the showcase skier stays until main.js hides the menu (hide() calls onShowcase(null)),
    // so it never pops out before a transition has covered the screen
    if (this.onStart) this.onStart(payload);
    else this.onPlay?.(payload);
    // if main.js did not take us out of the menu, re-arm START instead of locking it forever
    setTimeout(() => { this.starting = false; }, 1500);
  }

  scrStats() {
    const st = save.stats;
    const ski = save.skis ? skiById(save.skis)?.name || '—' : 'None yet';
    const rows = [
      ['Money', `$${fmtMoney(save.money)}`], ['Races won', `${st.wins} / ${st.races}`],
      ['Top speed', `${Math.round(st.topSpeed * 3.6)} km/h`],
      ['Longest jump', st.longestJump >= 1 ? `${Math.round(st.longestJump)} m` : '—'], ['Biggest air', st.bestAir >= 0.1 ? `${st.bestAir.toFixed(1)} s` : '—'],
      ['Distance skied', `${(st.distance / 1000).toFixed(1)} km`],
      ['Prize money', `$${fmtMoney(st.earned)}`], ['Skis', ski], ['Day', String(save.day)],
    ];
    const recs = this.fetchCourses().map((c) => {
      const r = c.record || {};
      return `<div class="mp-row"><span class="mp-name">${esc(c.name)}</span><span class="mp-rec">${Number.isFinite(r.best) ? `<b>${fmtTime(r.best)}</b>` : '<em>No time</em>'}${medalHTML(r.medal, 28)}</span></div>`;
    }).join('');
    return {
      logo: 'small', shade: 'left', hints: [['esc', 'Back']],
      html: `${this.head('STATS', 'Your career on the mountain')}
        <div class="stats-wrap">
          <div class="menu-panel" data-stagger style="--clip:${brushClip(150, 5, 4)}"><div class="mp-head">CAREER</div>
            ${rows.map(([k, v]) => `<div class="mp-row"><span>${k}</span><b>${esc(v)}</b></div>`).join('')}</div>
          <div class="menu-panel" data-stagger style="--clip:${brushClip(151, 5, 4)}"><div class="mp-head">COURSE RECORDS</div>${recs}</div>
        </div>`,
      back: () => this.go(this.inGame ? 'pause' : 'main', -1),
    };
  }

  scrSettings() {
    const qs = QUALITY_ORDER; // super performance, performance, balanced, high, ultra (engine/quality.js)
    const q = normalizeQuality(save.quality) || 'high';
    this.pendingQ = q;
    return {
      logo: 'small', shade: 'left',
      hints: [['updown', 'Select'], ['leftright', 'Adjust'], ['enter', 'Apply'], ['esc', 'Back']],
      html: `${this.head('SETTINGS', 'Performance runs smoothest on laptops, Super Performance on 8 GB / older Macs · changing the graphics restarts the game')}
        <div class="menu-panel settings" data-stagger style="--clip:${brushClip(160, 5, 4)}">
          <div class="mp-row" data-f data-row="quality"><span>Graphics</span><div class="seg">${qs.map((x) => `<button tabindex="-1" data-q="${x}" class="${q === x ? 'on' : ''}">${QUALITY_LABELS[x]}</button>`).join('')}</div></div>
          <div class="mp-row" data-f data-row="sens"><span>Mouse sensitivity</span><input class="m-sens" type="range" min="0.3" max="2.5" step="0.1" value="${save.sensitivity}"></div>
          <div class="mp-row" data-f data-row="vol"><span>Volume</span><input class="m-vol" type="range" min="0" max="1" step="0.05" value="${save.volume ?? 0.8}"></div>
          <div class="mp-row" data-f data-row="skier"><span>Skier</span><button class="mp-skier" tabindex="-1">Change skier</button></div>
          ${this.mpActive?.() ? '' : '<div class="mp-row" data-f data-row="reset"><span>Progress</span><button class="mp-danger" tabindex="-1">Reset all progress</button></div>'}
        </div>`,
      after: (el) => this.bindSettings(el),
      keys: { left: () => this.adjustSetting(-1), right: () => this.adjustSetting(1), enter: () => this.activateSetting() },
      back: () => this.go(this.inGame ? 'pause' : 'main', -1),
    };
  }

  bindSettings(el) {
    el.querySelectorAll('[data-q]').forEach((b) => b.addEventListener('click', () => {
      this.audio?.play('click');
      if (b.dataset.q !== save.quality) this.onQuality?.(b.dataset.q);
    }));
    const sens = el.querySelector('.m-sens'), vol = el.querySelector('.m-vol');
    sens.addEventListener('input', () => this.onSens?.(parseFloat(sens.value)));
    vol.addEventListener('input', () => { save.volume = parseFloat(vol.value); writeSave(); this.onVolume?.(save.volume); });
    // sliders give the keyboard back to the menu once released
    for (const s of [sens, vol]) s.addEventListener('change', () => s.blur());
    el.querySelector('.mp-skier')?.addEventListener('click', () => { this.audio?.play('click'); this.go('showcase', 1); });
    const reset = el.querySelector('.mp-danger');
    reset?.addEventListener('click', () => {
      this.audio?.play('click');
      if (reset.dataset.confirm) resetSave();
      else { reset.dataset.confirm = '1'; reset.textContent = 'Click again to confirm'; }
    });
  }

  adjustSetting(d) {
    const row = this.focusables[this.fi];
    const kind = row?.dataset.row;
    if (kind === 'quality') {
      const bs = [...row.querySelectorAll('[data-q]')];
      const qs = bs.map((b) => b.dataset.q);
      const i = Math.max(0, Math.min(qs.length - 1, qs.indexOf(this.pendingQ) + d));
      this.pendingQ = qs[i];
      bs.forEach((b) => b.classList.toggle('pending', b.dataset.q === this.pendingQ && this.pendingQ !== save.quality));
      this.audio?.play('tick');
    } else if (kind === 'sens' || kind === 'vol') {
      const inp = row.querySelector('input');
      const step = parseFloat(inp.step) || 0.1;
      const v = Math.min(parseFloat(inp.max), Math.max(parseFloat(inp.min), parseFloat(inp.value) + d * step));
      inp.value = String(Math.round(v * 100) / 100);
      inp.dispatchEvent(new Event('input'));
      this.audio?.play('tick');
    }
  }

  activateSetting() {
    const row = this.focusables[this.fi];
    const kind = row?.dataset.row;
    if (kind === 'quality') { if (this.pendingQ && this.pendingQ !== save.quality) this.onQuality?.(this.pendingQ); }
    else if (kind === 'skier') row.querySelector('.mp-skier').click();
    else if (kind === 'reset') row.querySelector('.mp-danger').click();
    else if (row?.dataset.act) row.click();
  }

  scrPause() {
    const h = this.pauseHandlers || {};
    const items = [['RESUME', 'resume', 'big']];
    if (h.onRestart) items.push(['RESTART', 'restart']);
    items.push(['CONTROLS', 'controls']);
    // at most 7 rows: STATS gives way when both RESTART and RETURN TO VILLAGE are offered
    if (!(h.onRestart && h.onVillage)) items.push(['STATS', 'stats']);
    items.push(['SETTINGS', 'settings']);
    if (h.onLeaveMP) items.push(['LEAVE MULTIPLAYER', 'leavemp', 'wide']);
    else if (h.onMainMenu || this.onMainMenu) items.push(['MAIN MENU', 'mainmenu']);
    if (h.onVillage) items.push(['RETURN TO VILLAGE', 'village', 'wide']);
    items.push(['QUIT GAME', 'quit', 'small']);
    const seeds = { resume: 5, restart: 29, controls: 31, stats: 7, settings: 11, mainmenu: 23, leavemp: 23, village: 19, quit: 13 };
    const roomy = items.length <= 5;
    return {
      logo: roomy ? 'big' : 'small', shade: 'left', cls: roomy ? '' : 'tight',
      hints: [['updown', 'Select'], ['enter', 'Confirm'], ['esc', 'Resume']],
      html: `<div class="menu-col compact">${items.map(([l, a, c]) => this.btn(l, a, seeds[a], c || '')).join('')}</div>`,
      back: () => this.action('resume'),
    };
  }

  // ---------------------------------------------------------------- navigation

  /** Switch screens with a slide/fade (dir 1 = forward, -1 = back, 0 = crossfade). */
  go(name, dir = 1) {
    this.ensureChrome();
    const def = this.buildScreen(name);
    this.screen = name;
    this.el.dataset.screen = name;
    this.el.dataset.shade = def.shade || 'left';
    this.el.classList.toggle('logo-big', def.logo === 'big');
    this.hintsEl.innerHTML = hintsHTML(def.hints || []);

    this.stage.querySelectorAll('.menu-screen.exit').forEach((s) => s.remove());
    const prev = this.stage.querySelector('.menu-screen.current');
    const el = document.createElement('div');
    el.className = `menu-screen scr-${name}${def.cls ? ' ' + def.cls : ''}`;
    el.style.setProperty('--dir', String(dir));
    el.innerHTML = def.html;
    el.querySelectorAll('[data-stagger]').forEach((x, i) => { x.style.animationDelay = `${70 + i * 60}ms`; });
    this.stage.appendChild(el);
    if (prev) {
      prev.classList.remove('current');
      prev.style.setProperty('--dir', String(dir));
      prev.classList.add('exit');
      prev.inert = true;
      setTimeout(() => prev.remove(), 450);
    }
    el.classList.add('enter');
    void el.offsetWidth; // apply the start state so the slide-in transitions
    el.classList.remove('enter');
    el.classList.add('current');

    this.cur = { name, def, el };
    this.bindScreen(el);
    def.after?.(el);
    this.fi = -1;
    this.setFocus(def.focus ?? 0, true);
    // the 3D showcase skier follows the character screen
    if (name === 'showcase') this.enterShowcase();
    else this.leaveShowcase();
  }

  bindScreen(el) {
    this.focusables = [...el.querySelectorAll('[data-f]')];
    this.focusables.forEach((b, i) => b.addEventListener('mouseenter', () => this.setFocus(i)));
    el.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => {
      if (b.disabled || !el.classList.contains('current') || this.starting) return;
      this.audio?.play('click');
      this.action(b.dataset.act, true);
    }));
    // buttons never take DOM focus: the menu handles the keyboard itself
    el.addEventListener('mousedown', (e) => { if (e.target.closest?.('button')) e.preventDefault(); });
  }

  setFocus(i, silent = false) {
    const list = this.focusables, n = list.length;
    if (!n) { this.fi = -1; return; }
    i = ((i % n) + n) % n;
    if (i === this.fi) return;
    list.forEach((b, j) => b.classList.toggle('is-focus', j === i));
    this.fi = i;
    if (!silent) this.audio?.play('tick');
  }

  moveFocus(d) {
    const n = this.focusables.length;
    if (!n) return;
    let i = Math.max(0, this.fi);
    for (let k = 0; k < n; k++) {
      i = (i + d + n) % n;
      if (!this.focusables[i].disabled) break;
    }
    this.setFocus(i);
  }

  back(sound = true) {
    const b = this.cur?.def.back;
    if (!b) return;
    if (sound) this.audio?.play('click');
    b();
  }

  onKey(e) {
    if (this.el.hidden || !this.cur?.el.isConnected || this.el.classList.contains('leaving')) return;
    const a = KEYMAP[e.code];
    if (!a) return;
    // a slider the mouse is still holding keeps its own arrow keys
    if (document.activeElement?.tagName === 'INPUT' && (a === 'left' || a === 'right')) return;
    if (document.activeElement?.classList?.contains('mpn-input') && (a !== 'enter' && a !== 'back' || e.code === 'Space' || e.code === 'Backspace')) return; // (typing a name: W A S D, Space, Backspace are letters)
    e.preventDefault();
    e.stopPropagation();
    // START was pressed: main.js is taking us into the game (a transition may be covering the
    // screen), so the menu must not navigate away underneath it
    if (this.starting) return;
    // auto-repeat only counts for keys pressed while the menu is open (a steering key still held
    // from gameplay must not spin the focus), and never for confirm / back
    if (!e.repeat) this.downKeys.add(e.code);
    else if (!this.downKeys.has(e.code) || a === 'enter' || a === 'back') return;
    const keys = this.cur.def.keys || {};
    if (keys[a]) { keys[a](); return; }
    if (a === 'up' || a === 'left') this.moveFocus(-1);
    else if (a === 'down' || a === 'right') this.moveFocus(1);
    else if (a === 'enter') {
      const b = this.focusables[this.fi];
      if (b && !b.disabled) b.click();
    } else if (a === 'back') this.back();
  }

  action(act, fromClick = false) {
    const [a, arg] = String(act).split(':');
    switch (a) {
      // the MAN / WOMAN choice only the first time (Oct 28, the user); later it's under SETTINGS · Skier
      case 'play': return this.go('playmode', 1);
      case 'single': this.mpMode = false; return save.characterChosen ? this.start() : this.go('showcase', 1);
      case 'multi': this.mpMode = true; return save.characterChosen ? this.start() : this.go('showcase', 1);
      case 'mpname': {
        const v = String(this.cur?.el.querySelector('.mpn-input')?.value || '').trim().replace(/\s+/g, ' ');
        if (!/^[A-Za-z0-9_ -]{3,16}$/.test(v) || !/[A-Za-z0-9]/.test(v)) { this.mpState.value = v; return this.mpName('Names are 3-16 letters, digits, spaces, _ or -.'); }
        this.mpState.value = v;
        return this.onMpName?.(v);
      }
      case 'leavemp': return this.pauseHandlers?.onLeaveMP?.();
      case 'skier': return this.go('showcase', 1);
      case 'controls': return this.go('controls', 1);
      case 'stats': return this.go('stats', 1);
      case 'settings': return this.go('settings', 1);
      case 'back': return this.back(!fromClick);
      case 'pick': return this.pickChar(Number(arg), fromClick);
      case 'start': return this.start();
      case 'resume': return this.pauseHandlers?.onResume?.();
      case 'restart': return this.pauseHandlers?.onRestart?.();
      case 'mainmenu': return (this.pauseHandlers?.onMainMenu || this.onMainMenu)?.();
      case 'village': return this.pauseHandlers?.onVillage?.();
      case 'quit':
        this.pauseHandlers?.onQuit?.();
        return window.close();
      default: return undefined;
    }
  }
}
