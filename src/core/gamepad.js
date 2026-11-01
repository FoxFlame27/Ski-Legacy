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
// Inside your chalet the map button (View / Share / Minus) presses the furnish code instead (F: build mode on / off).
// VIRTUAL MOUSE (Nov 1 2026, the user: "inside a chalet [Minus] should open the furniture menu, and you should be able
// to furnish with like a fake mouse that you can unlock by pressing the joystick down (clicking it) and re-lock by
// pressing it again"): the 'vmouse' button (left stick click; not while driving) shows a cursor the left stick moves
// (it doesn't walk then); the confirm button is the left mouse button, the back button the right one (in a menu: Esc),
// as real mouse events (pointer / mouse down, up, click, contextmenu, move) on the element under the cursor, so the
// DOM menus and the canvas handlers (build mode's raycast from the cursor) take them as from a mouse. It frees the
// mouse (input.cursorFree) like TAB does. Off again with the same button, on keyboard / mouse input, getting into a
// car, leaving the chalet or closing build mode; hidden while the pause menu is open.
//
// API for the UI: padInfo() / currentPad(), the 'padchange' event on window (detail: padInfo()), padActive(),
// onNextPadButton(cb) (rebinding), rumble(strong, weak, ms) and its presets.
import { save } from '../game/economy.js';
import { live } from './settings.js';
import { ACTIONS, bindsOf, padFamily, setPadFamily } from './bindings.js';
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
let build = null;
/** Chalet build mode registers itself (game/build/buildmode.js): .wasActive = inside your chalet, .on = building. */
export function setBuildMode(b) { build = b; }

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
  padIndex = gp ? i : -1; padId = gp?.id || ''; family = gp ? padFamily(gp.id) : 'xbox'; setPadFamily(family);
  prev = gp ? gp.buttons.map(pressedOf) : [];
  announce();
}
addEventListener('gamepadconnected', (e) => { if (padIndex < 0) choose(e.gamepad.index, e.gamepad); lastPadAt = performance.now(); announce(); });
addEventListener('gamepaddisconnected', (e) => {
  if (e.gamepad.index !== padIndex) return;
  vmSet(false); releaseAll(); padIndex = -1; padId = '';
  const any = [...(navigator.getGamepads?.() || [])].find((g) => g && g.connected);
  if (any) choose(any.index, any); else announce();
});
// keyboard / mouse used: the UI goes back to key glyphs, the cursor comes back
addEventListener('keydown', (e) => { if (e.isTrusted) lastKbAt = performance.now(); }, true);
addEventListener('mousedown', (e) => { if (e.isTrusted) lastKbAt = performance.now(); }, true); // (not the virtual mouse's)
addEventListener('mousemove', (e) => { if (e.isTrusted && Math.abs(e.movementX) + Math.abs(e.movementY) > 6) lastKbAt = performance.now(); }, true);
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
  // inside your chalet the map button opens / closes build mode (F) instead of the trail map
  if (pad.map === i && build?.wasActive) {
    const m = out.indexOf(ACTION_CODE.map), f = ACTION_CODE.furnish || 'KeyF';
    if (m >= 0) out.splice(m, 1);
    if (!out.includes(f)) out.push(f);
  }
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
  if (padId !== gp.id) { padId = gp.id; family = padFamily(gp.id); setPadFamily(family); announce(); }
  updateRumble(gp, now);

  const btn = gp.buttons.map(pressedOf), ax = gp.axes || [];
  const [lx, ly] = deadzone(ax[0] || 0, ax[1] || 0, DEAD);
  const [rx, ry, rm] = deadzone(ax[2] || 0, ax[3] || 0, LOOK_DEAD);
  if (btn.some(Boolean) || lx || ly || rx || ry) lastPadAt = now;

  const inMenu = !!safe(menuMode);
  const vehicle = !!safe(vehicleMode), g = window.__game;
  const paused = !!(g && (g.paused || !g.started || g.busIntro));
  // the virtual mouse: off in a car, on keyboard / mouse input, leaving the chalet, closing build mode
  const inside = !!build?.wasActive, building = !!build?.on;
  if (vm.on && (vehicle || lastKbAt > vm.at || inside !== vm.inside || (vm.building && !building))) vmSet(false);
  if (vm.on && building) vm.building = true;
  const vmLive = vm.on && !(inMenu && paused); // (the pause menu has its own navigation: hidden meanwhile)
  vmShow(vmLive);
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
      if (vm.down.has(i)) vmUp(i);
      const codes = btnSent.get(i);
      if (codes) { btnSent.delete(i); for (const c of codes) unhold('b' + i, c); }
      continue;
    }
    if (suppressed.has(i)) continue;
    if (captureCb) { const cb = captureCb; captureCb = null; suppressed.add(i); try { cb(i); } catch (err) { console.warn('gamepad: capture', err); } continue; }
    // the virtual mouse: its button toggles it (not in a car, not paused), confirm / back are the mouse buttons
    if (i === bindsOf(save).pad.vmouse && !vehicle && !(inMenu && paused)) { vmSet(!vm.on, inside, building); vmShow(vm.on); continue; }
    if (vmLive && (i === confirm || (i === back && !inMenu))) { vmDown(i, i === confirm ? 0 : 2); continue; }
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
    const sy = vmLive ? 0 : ly, sx = vmLive ? 0 : lx; // (the virtual mouse has the stick)
    const dir = btn[12] || sy < -0.5 ? 'ArrowUp' : btn[13] || sy > 0.5 ? 'ArrowDown' : btn[14] || sx < -0.5 ? 'ArrowLeft' : btn[15] || sx > 0.5 ? 'ArrowRight' : null;
    if (dir !== nav.dir) { nav.dir = dir; if (dir && !captureCb) { tap(dir); nav.next = now + REPEAT_DELAY; } }
    else if (dir && now >= nav.next && !captureCb) { tap(dir); nav.next = now + REPEAT_EVERY; }
    if (input) { input.stickX = 0; input.stickY = 0; }
    if (rm > 0 && vmLive) vmScroll(ry * rm, dt);
  } else if (input) {
    // left stick -> W A S D (a little hysteresis), its analog values for whoever wants them
    const wx = vmLive ? 0 : lx, wy = vmLive ? 0 : ly; // (the virtual mouse has the stick: you don't walk)
    input.stickX = wx; input.stickY = wy;
    const want = (v, was) => (was ? v > 0.28 : v > 0.4);
    const dirs = { KeyW: want(-wy, stickDirs.KeyW), KeyS: want(wy, stickDirs.KeyS), KeyA: want(-wx, stickDirs.KeyA), KeyD: want(wx, stickDirs.KeyD) };
    for (const code in dirs) {
      if (dirs[code] === stickDirs[code]) continue;
      stickDirs[code] = dirs[code];
      if (dirs[code]) hold('stick', code); else unhold('stick', code);
    }
    // right stick -> look (like the mouse; an ease-in curve for fine aiming); the virtual mouse over a scrolling list
    // (the furniture catalogue, a menu): it scrolls that instead, like the wheel
    if (rm > 0 && vmLive && vmScroll(ry * rm, dt)) { /* scrolled */ }
    else if (rm > 0) {
      // (rx / ry already have the magnitude rm: x rm squares it, the direction kept)
      const k = rm * LOOK_PX * dt * (live.padSens ?? 1); // (SETTINGS · controller look sensitivity)
      input.mdx += rx * k;
      input.mdy += (live.invertY ? -ry : ry) * k;
    }
    // held codes stay held (a keyboard keyup of the same key, or a focus loss, mustn't drop them)
    for (const code of holds.keys()) if (!input.keys.has(code)) input.keys.add(code);
  }
  if (vmLive) {
    vmMove(lx, ly, dt);
    // (back from the pause menu, or Esc took the mouse back: the virtual mouse keeps it free)
    if (!inMenu && vm.ownFree && !building && input && !input.cursorFree) input.cursorFree = true;
  }
  // the cursor hides while you play on the controller (pointer lock or not)
  const cv = input?.canvas;
  if (cv) {
    const hide = !inMenu && padActive() && !input.cursorFree && !vmLive;
    if (hide !== cv._padHide) { cv._padHide = hide; cv.style.cursor = hide ? 'none' : ''; }
  }
}
function safe(fn) { try { return fn(); } catch { return false; } }

// ---- VIRTUAL MOUSE --------------------------------------------------------------------------------------------------
const VM_PX = 900; // px / s with the stick fully over (at 1080 px tall; scaled with the window), more after holding it
const vm = { on: false, x: 0, y: 0, at: 0, inside: false, building: false, ownFree: false, savedFree: false, accel: 0,
  down: new Map(), el: null, shown: false, hoverEl: null };
/** Is the virtual mouse on (build mode aims from it)? */
export function vmouseOn() { return vm.on; }
/** Where it points (client px), or null. */
export function vmousePos() { return vm.on ? { x: vm.x, y: vm.y } : null; }

function vmSet(on, inside = false, building = false) {
  if (on === vm.on) return;
  if (on) {
    Object.assign(vm, { on: true, at: performance.now(), inside, building, accel: 0 });
    if (!vm.x && !vm.y) { vm.x = innerWidth / 2; vm.y = innerHeight / 2; } // (first time: where the centre dot was)
    vm.x = Math.min(innerWidth - 2, Math.max(0, vm.x)); vm.y = Math.min(innerHeight - 2, Math.max(0, vm.y));
    // free the mouse like TAB does (build mode does it itself: it switches to CURSOR mode)
    vm.ownFree = !building && !!input;
    if (vm.ownFree) {
      vm.savedFree = input.cursorFree;
      input.cursorFree = true;
      try { if (document.pointerLockElement) document.exitPointerLock(); } catch { /* */ }
    }
    vmEvent('pointermove', 0, 0); vmEvent('mousemove', 0, 0); // (build mode learns where it points)
  } else {
    vm.on = false;
    for (const i of [...vm.down.keys()]) vmUp(i);
    if (vm.ownFree && input && !build?.on) {
      input.cursorFree = vm.savedFree;
      if (!input.cursorFree && build?.wasActive) input.lock();
    }
    vm.ownFree = false; vm.building = false;
    vmHover(null);
  }
  try { dispatchEvent(new CustomEvent('vmousechange', { detail: { on } })); } catch { /* */ }
}

function vmShow(show) {
  if (show === vm.shown) return;
  vm.shown = show;
  if (show && !vm.el && typeof document !== 'undefined') {
    const st = document.createElement('style');
    st.textContent = `#vmouse{position:fixed;left:0;top:0;width:30px;height:30px;z-index:2147483000;pointer-events:none;
      will-change:transform;filter:drop-shadow(0 2px 3px rgba(0,0,0,.45))}#vmouse[hidden]{display:none}
      body.vmouse-on,body.vmouse-on *{cursor:none!important}
      body.vmouse-on .vm-hover{outline:2px solid rgba(46,120,255,.7);outline-offset:2px}`;
    document.head.append(st);
    vm.el = document.createElement('div');
    vm.el.id = 'vmouse';
    vm.el.innerHTML = '<svg viewBox="0 0 24 24" width="30" height="30"><path d="M3 2 L3 19.5 L7.6 15.4 L10.6 22.2 L13.9 20.8 L10.9 14.1 L17 14.1 Z" fill="#fff" stroke="#14213d" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.body.append(vm.el);
  }
  if (vm.el) { vm.el.hidden = !show; vmPlace(); }
  document.body?.classList.toggle('vmouse-on', show);
  if (!show) vmHover(null);
}
function vmPlace() { if (vm.el) vm.el.style.transform = `translate(${vm.x - 3}px, ${vm.y - 2}px)`; }

function vmEvent(type, dx, dy, extra = {}, target = null) {
  if (typeof document === 'undefined') return null;
  const t = target || document.elementFromPoint(vm.x, vm.y) || document.body;
  const pointer = type.startsWith('pointer') && typeof PointerEvent === 'function';
  const init = { bubbles: true, cancelable: true, composed: true, view: window, clientX: vm.x, clientY: vm.y, screenX: vm.x,
    screenY: vm.y, movementX: dx, movementY: dy, button: 0, buttons: [...vm.down.values()].reduce((m, d) => m | (d.button === 2 ? 2 : 1), 0), ...extra };
  if (pointer) Object.assign(init, { pointerId: 1, pointerType: 'mouse', isPrimary: true });
  try { t.dispatchEvent(pointer ? new PointerEvent(type, init) : new MouseEvent(type, init)); } catch (err) { console.warn('vmouse', err); }
  return t;
}
function vmHover(el) {
  const h = el?.closest?.('button, a, [role="button"], .bm-card, .menu-item, .cb-cell, input, select, label') || null;
  if (h === vm.hoverEl) return;
  vm.hoverEl?.classList.remove('vm-hover');
  vm.hoverEl = h;
  h?.classList.add('vm-hover');
}
function vmMove(lx, ly, dt) {
  const m = Math.hypot(lx, ly);
  vm.accel = m > 0.92 ? Math.min(1, vm.accel + dt * 1.4) : Math.max(0, vm.accel - dt * 5);
  if (m > 0) {
    const v = VM_PX * Math.max(0.6, innerHeight / 1080) * (0.12 * m + 0.88 * m * m) * (1 + 0.8 * vm.accel); // (fine near the centre)
    const ox = vm.x, oy = vm.y;
    vm.x = Math.min(innerWidth - 2, Math.max(0, vm.x + (lx / m) * v * dt));
    vm.y = Math.min(innerHeight - 2, Math.max(0, vm.y + (ly / m) * v * dt));
    const dx = Math.round(vm.x - ox), dy = Math.round(vm.y - oy);
    if (vm.x !== ox || vm.y !== oy) {
      vmPlace();
      if (!document.pointerLockElement) { vmEvent('pointermove', dx, dy); vmHover(vmEvent('mousemove', dx, dy)); }
    }
  } else if (!vm.hoverEl && vm.shown) vmHover(document.elementFromPoint(vm.x, vm.y));
}
/** Scroll the scrollable box under the virtual mouse (v -1..1 up / down). False when there is none. */
function vmScroll(v, dt) {
  let el = document.elementFromPoint(vm.x, vm.y);
  for (; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
    if (el.scrollHeight <= el.clientHeight + 1) continue;
    const oy = getComputedStyle(el).overflowY;
    if (oy !== 'auto' && oy !== 'scroll') continue;
    if (Math.abs(v) > 0.05) el.scrollTop += v * 1400 * Math.max(0.6, innerHeight / 1080) * dt;
    return true;
  }
  return false;
}
function vmDown(i, button) {
  const ex = { button, buttons: button === 2 ? 2 : 1 };
  vm.down.set(i, { button, target: null });
  vmEvent('pointerdown', 0, 0, ex);
  const t = vmEvent('mousedown', 0, 0, ex);
  vm.down.get(i).target = t;
  if (button === 0 && t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) t.focus?.();
}
function vmUp(i) {
  const d = vm.down.get(i);
  vm.down.delete(i);
  if (!d) return;
  const ex = { button: d.button, buttons: 0 };
  vmEvent('pointerup', 0, 0, ex);
  const t = vmEvent('mouseup', 0, 0, ex);
  if (d.button === 2) { vmEvent('contextmenu', 0, 0, { button: 2, buttons: 0 }); return; }
  // a click where it went down and came up (the element, or one inside the other)
  const c = !d.target || !t ? t : d.target.contains(t) ? d.target : t.contains(d.target) ? t : null;
  if (c && vm.on) vmEvent('click', 0, 0, { button: 0, buttons: 0, detail: 1 }, c);
}

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
