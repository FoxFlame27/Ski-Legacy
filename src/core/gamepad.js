// CONTROLLER (Nov 1 2026, the user: "make the game for controller so you can play on controller: Xbox, PS5, PS4 and
// Nintendo Switch, and make the controller vibrate e.g. when you land while skiing, crash in a car, get hit by a car").
// Polled once a frame from main.js (poll(), before the frame's update). Everything goes through the keyboard path, so
// every existing listener (pause, map, photo, interact, admin panels, menus) works unchanged:
//   - the left stick holds W A S D (and sets input.stickX / stickY, -1..1),
//   - the right stick turns the view (input.mdx / mdy like the mouse, with or without pointer lock),
//   - a button presses the game code of the action(s) bound to it (save.binds.pad over PAD_DEFAULTS, core/bindings.js)
//     as synthetic keydown / keyup events.
// While a menu / panel / dialog is open (setMenuMode) the d-pad and the left stick send the arrow keys (repeating),
// the confirm button Enter and the back button / Menu Escape. Buttons use the W3C "standard" layout (Chrome / Electron
// map Xbox, DualShock 4, DualSense and the Switch Pro controller to it).
//
// API for the UI: padInfo() / currentPad(), the 'padchange' event on window (detail: padInfo()), padActive(),
// onNextPadButton(cb) (rebinding), rumble(strong, weak, ms) and its presets.
import { save } from '../game/economy.js';
import { live } from './settings.js';
import { ACTIONS, bindsOf, padFamily } from './bindings.js';
import { fireKey } from './input.js';

const DEAD = 0.22;       // left stick deadzone (radial)
const LOOK_DEAD = 0.14;  // right stick deadzone
const LOOK_PX = 1150;    // right stick fully over: "mouse pixels" per second (the consumers apply the sensitivity)
const TRIG = 0.35;       // a trigger past this counts as pressed
const REPEAT_DELAY = 400, REPEAT_EVERY = 180; // menu navigation auto-repeat (ms)

let input = null;
let menuMode = () => false;
let padIndex = -1, padId = '', family = 'xbox';
let prev = [];                          // last frame's pressed state per button
const btnSent = new Map();              // button index -> codes its press holds (released with it)
const suppressed = new Set();           // buttons whose press went to onNextPadButton (ignored until released)
const holds = new Map();                // game code -> Set of sources holding it (one keydown / keyup per code)
let captureCb = null;
let lastPadAt = -1e9, lastKbAt = 0, lastT = 0;
let wasMenu = false;
const nav = { dir: null, next: 0 };     // menu navigation repeat
const stickDirs = { KeyW: false, KeyS: false, KeyA: false, KeyD: false };

/** Hook up the Input (main.js, once). */
export function attachInput(inp) { input = inp; }
/** main.js: true while a menu, panel or dialog wants the controller as arrows / Enter / Esc. */
export function setMenuMode(fn) { menuMode = typeof fn === 'function' ? fn : () => !!fn; }
let vehicleMode = () => false;
/**
 * main.js: true while you drive a car: like other games the SPRINT trigger (RT / R2 / ZR) is the gas
 * there too (it also holds W), the BRAKE trigger (LT / L2 / ZL) brakes / reverses (S).
 */
export function setVehicleMode(fn) { vehicleMode = typeof fn === 'function' ? fn : () => !!fn; }

/** The controller in use, or null. */
export function currentPad() {
  if (padIndex < 0) return null;
  try { return navigator.getGamepads?.()[padIndex] || null; } catch { return null; }
}
/** { connected, family: 'xbox' | 'ps' | 'switch', id, index } of the controller in use. */
export function padInfo() { return { connected: padIndex >= 0, family, id: padId, index: padIndex }; }
/** True while the controller was used more recently than the keyboard / mouse (show controller glyphs). */
export function padActive() { return padIndex >= 0 && lastPadAt > lastKbAt; }

/**
 * Rebinding: cb(buttonIndex) on the next controller button pressed (the press does nothing else, nor its release).
 * Returns a cancel function. Another call replaces the pending one.
 */
export function onNextPadButton(cb) {
  captureCb = typeof cb === 'function' ? cb : null;
  const mine = captureCb;
  return () => { if (captureCb === mine) captureCb = null; };
}

function announce() {
  try { dispatchEvent(new CustomEvent('padchange', { detail: padInfo() })); } catch { /* (old browsers) */ }
}
function choose(i, gp) {
  if (padIndex === i && padId === (gp?.id || '')) return;
  releaseAll();
  padIndex = gp ? i : -1; padId = gp?.id || ''; family = gp ? padFamily(gp.id) : 'xbox';
  prev = gp ? gp.buttons.map(pressedOf) : [];
  announce();
}
addEventListener('gamepadconnected', (e) => { if (padIndex < 0) choose(e.gamepad.index, e.gamepad); lastPadAt = performance.now(); announce(); });
addEventListener('gamepaddisconnected', (e) => {
  if (e.gamepad.index !== padIndex) return;
  releaseAll(); padIndex = -1; padId = '';
  const any = [...(navigator.getGamepads?.() || [])].find((g) => g && g.connected);
  if (any) choose(any.index, any); else announce();
});
// keyboard / mouse used: the UI goes back to key glyphs, the cursor comes back
addEventListener('keydown', (e) => { if (e.isTrusted) lastKbAt = performance.now(); }, true);
addEventListener('mousedown', () => { lastKbAt = performance.now(); }, true);
addEventListener('mousemove', (e) => { if (Math.abs(e.movementX) + Math.abs(e.movementY) > 6) lastKbAt = performance.now(); }, true);
addEventListener('blur', () => releaseAll());

function pressedOf(b, i) {
  if (!b) return false;
  if (i === 6 || i === 7) return b.value > TRIG || (b.pressed && b.value === 0 && b.touched !== false);
  return b.pressed || b.value > 0.5;
}

function hold(src, code) {
  let s = holds.get(code);
  if (!s) holds.set(code, (s = new Set()));
  if (s.has(src)) return;
  s.add(src);
  if (s.size === 1) fireKey('keydown', code);
}
function unhold(src, code) {
  const s = holds.get(code);
  if (!s || !s.delete(src)) return;
  if (!s.size) { holds.delete(code); fireKey('keyup', code); }
}
function releaseAll() {
  for (const code of [...holds.keys()]) { holds.delete(code); fireKey('keyup', code); }
  btnSent.clear();
  for (const k in stickDirs) stickDirs[k] = false;
  if (input) { input.stickX = 0; input.stickY = 0; }
  nav.dir = null;
}
const tap = (code) => { fireKey('keydown', code); fireKey('keyup', code); };

// codes the actions bound to a button produce
function codesFor(i) {
  const pad = bindsOf(save).pad, out = [];
  for (const id in pad) if (pad[id] === i && !out.includes(ACTION_CODE[id])) out.push(ACTION_CODE[id]); // (every action on it: ctx ones share)
  if (pad.sprint === i && safe(vehicleMode) && !out.includes('KeyW')) out.push('KeyW'); // (the gas pedal)
  return out.filter(Boolean);
}
const ACTION_CODE = Object.fromEntries(ACTIONS.map((a) => [a.id, a.code]));

function deadzone(x, y, dz) {
  const m = Math.hypot(x, y);
  if (m < dz) return [0, 0, 0];
  const k = Math.min(1, (m - dz) / (1 - dz)) / m;
  return [x * k, y * k, Math.min(1, (m - dz) / (1 - dz))];
}

/** Read the controller and feed the Input. Called once a frame (main.js loop). */
export function poll() {
  const now = performance.now(), dt = Math.min(0.1, Math.max(0, (now - (lastT || now)) / 1000));
  lastT = now;
  let pads;
  try { pads = navigator.getGamepads?.(); } catch { pads = null; }
  if (!pads) return;
  // the controller in use: the current one, or any other one a button is pressed on
  for (const g of pads) {
    if (!g || !g.connected || g.index === padIndex) continue;
    if (padIndex < 0 || !pads[padIndex] || g.buttons.some((b, i) => pressedOf(b, i))) { choose(g.index, g); break; }
  }
  const gp = padIndex >= 0 ? pads[padIndex] : null;
  if (!gp || !gp.connected) return;
  if (padId !== gp.id) { padId = gp.id; family = padFamily(gp.id); announce(); }
  updateRumble(gp, now);

  const btn = gp.buttons.map(pressedOf), ax = gp.axes || [];
  const [lx, ly] = deadzone(ax[0] || 0, ax[1] || 0, DEAD);
  const [rx, ry, rm] = deadzone(ax[2] || 0, ax[3] || 0, LOOK_DEAD);
  if (btn.some(Boolean) || lx || ly || rx || ry) lastPadAt = now;

  const inMenu = !!safe(menuMode);
  if (inMenu !== wasMenu) { // (what was held for the game is let go; nothing held carries into the menu or out of it)
    wasMenu = inMenu;
    for (const code of [...holds.keys()]) { holds.delete(code); fireKey('keyup', code); }
    btnSent.clear();
    for (const k in stickDirs) stickDirs[k] = false;
    for (let i = 0; i < btn.length; i++) if (btn[i]) suppressed.add(i); // (a held button acts again only once pressed again)
    nav.dir = null;
  }

  // buttons: presses and releases
  const confirm = family === 'switch' ? 1 : 0, back = family === 'switch' ? 0 : 1; // (Switch: A (right) confirms, B goes back)
  for (let i = 0; i < btn.length; i++) {
    const on = btn[i], was = !!prev[i];
    if (on === was) continue;
    if (!on) { // released
      suppressed.delete(i);
      const codes = btnSent.get(i);
      if (codes) { btnSent.delete(i); for (const c of codes) unhold('b' + i, c); }
      continue;
    }
    if (suppressed.has(i)) continue;
    if (captureCb) { const cb = captureCb; captureCb = null; suppressed.add(i); try { cb(i); } catch (err) { console.warn('gamepad: capture', err); } continue; }
    if (inMenu) {
      if (i >= 12 && i <= 15) continue; // (the d-pad: navigation below)
      if (i === confirm) tap('Enter');
      else if (i === back || i === 9) tap('Escape');
      else {
        // the screens' own toggles still work from a menu (the map button closes the map)
        const pad = bindsOf(save).pad;
        if (pad.map === i) tap(ACTION_CODE.map || 'KeyM');
        else if (pad.photo === i) tap(ACTION_CODE.photo || 'KeyP');
      }
      continue;
    }
    const codes = codesFor(i);
    if (codes.length) { btnSent.set(i, codes); for (const c of codes) hold('b' + i, c); }
  }
  prev = btn;

  if (inMenu) {
    // d-pad / left stick: arrows with auto-repeat
    const dir = btn[12] || ly < -0.5 ? 'ArrowUp' : btn[13] || ly > 0.5 ? 'ArrowDown' : btn[14] || lx < -0.5 ? 'ArrowLeft' : btn[15] || lx > 0.5 ? 'ArrowRight' : null;
    if (dir !== nav.dir) { nav.dir = dir; if (dir && !captureCb) { tap(dir); nav.next = now + REPEAT_DELAY; } }
    else if (dir && now >= nav.next && !captureCb) { tap(dir); nav.next = now + REPEAT_EVERY; }
    if (input) { input.stickX = 0; input.stickY = 0; }
  } else if (input) {
    // left stick -> W A S D (a little hysteresis), its analog values for whoever wants them
    input.stickX = lx; input.stickY = ly;
    const want = (v, was) => (was ? v > 0.28 : v > 0.4);
    const dirs = { KeyW: want(-ly, stickDirs.KeyW), KeyS: want(ly, stickDirs.KeyS), KeyA: want(-lx, stickDirs.KeyA), KeyD: want(lx, stickDirs.KeyD) };
    for (const code in dirs) {
      if (dirs[code] === stickDirs[code]) continue;
      stickDirs[code] = dirs[code];
      if (dirs[code]) hold('stick', code); else unhold('stick', code);
    }
    // right stick -> look (like the mouse; an ease-in curve for fine aiming)
    if (rm > 0) {
      // (rx / ry already have the magnitude rm: x rm squares it, the direction kept)
      const k = rm * LOOK_PX * dt * (live.padSens ?? 1); // (SETTINGS · controller look sensitivity)
      input.mdx += rx * k;
      input.mdy += (live.invertY ? -ry : ry) * k;
    }
    // held codes stay held (a keyboard keyup of the same key, or a focus loss, mustn't drop them)
    for (const code of holds.keys()) if (!input.keys.has(code)) input.keys.add(code);
  }
  // the cursor hides while you play on the controller (pointer lock or not)
  const cv = input?.canvas;
  if (cv) {
    const hide = !inMenu && padActive() && !input.cursorFree;
    if (hide !== cv._padHide) { cv._padHide = hide; cv.style.cursor = hide ? 'none' : ''; }
  }
}
function safe(fn) { try { return fn(); } catch { return false; } }

// ---- RUMBLE ---------------------------------------------------------------------------------------------------------
// rumble(strong, weak, ms): the low (strong) and high (weak) frequency motors, 0..1. A weaker call while a stronger
// effect still runs is dropped (the big crash isn't cut short by its own little bumps). Off with SETTINGS · Vibration
// (live.vibration === false) or without a controller.
let active = { until: 0, mag: 0 };
let level = { strong: 0, weak: 0, at: 0 }; // continuous rumble (rough ground, a skid): set each frame by rumble.hold
let levelSentAt = 0;
function play(gp, strong, weak, ms) {
  try {
    const a = gp.vibrationActuator;
    if (a?.playEffect) { a.playEffect('dual-rumble', { startDelay: 0, duration: ms, strongMagnitude: strong, weakMagnitude: weak })?.catch?.(() => {}); return true; }
    const h = gp.hapticActuators?.[0];
    if (h?.pulse) { h.pulse(Math.max(strong, weak), ms)?.catch?.(() => {}); return true; }
  } catch { /* (no haptics) */ }
  return false;
}
export function rumble(strong = 0.5, weak = strong, ms = 200) {
  if (live.vibration === false) return;
  const gp = currentPad();
  if (!gp) return;
  const now = performance.now(), mag = Math.max(strong, weak);
  if (now < active.until && mag < active.mag * 0.8) return;
  strong = Math.min(1, Math.max(0, strong)); weak = Math.min(1, Math.max(0, weak)); ms = Math.max(20, Math.min(5000, ms));
  if (play(gp, strong, weak, ms)) active = { until: now + ms, mag };
}
const c01 = (x) => Math.min(1, Math.max(0, x));
/** Landing (skis, a car back on its wheels): k 0..1 how hard. */
rumble.land = (k = 0.5) => { k = c01(k); if (k > 0.04) rumble(0.15 + 0.75 * k, 0.25 + 0.6 * k, 90 + 220 * k); };
/** A wipeout / a car crash: k 0..1 how hard. */
rumble.crash = (k = 1) => { k = c01(k); rumble(0.45 + 0.55 * k, 0.6 + 0.4 * k, 260 + 420 * k); };
/** Hit by a car / bus / police ram: k 0..1. */
rumble.hit = (k = 1) => { k = c01(k); rumble(0.7 + 0.3 * k, 0.8 + 0.2 * k, 380 + 380 * k); };
/** A knock, a bump, something snapped off: k 0..1. */
rumble.bump = (k = 0.4) => { k = c01(k); if (k > 0.03) rumble(0.1 + 0.6 * k, 0.3 + 0.5 * k, 70 + 130 * k); };
/** A light tick (jump take-off, footstep landing). */
rumble.tick = (k = 0.25) => { k = c01(k); rumble(0.05 + 0.2 * k, 0.15 + 0.4 * k, 50 + 40 * k); };
/** Continuous rumble for this frame (rough ground, a skid): call every frame while it lasts. */
rumble.hold = (strong = 0, weak = 0) => {
  const now = performance.now();
  if (now - level.at > 50) { level.strong = 0; level.weak = 0; }
  level.strong = Math.max(level.strong, c01(strong)); level.weak = Math.max(level.weak, c01(weak)); level.at = now;
};
function updateRumble(gp, now) {
  if (now - level.at > 80 || live.vibration === false || safe(menuMode)) return;
  const mag = Math.max(level.strong, level.weak);
  if (mag < 0.03 || now < active.until || now - levelSentAt < 90) return;
  levelSentAt = now;
  play(gp, level.strong, level.weak, 130);
}
