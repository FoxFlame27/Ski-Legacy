// Keyboard + pointer-lock mouse input (and, through core/gamepad.js, the controller).
import { live } from './settings.js';
import { save } from '../game/economy.js';
import { ACTIONS, bindsOf } from './bindings.js';

// ---- KEYBOARD REBINDING (Nov 1 2026, the user: "add controls so you can change controls") -------------------------
// The game code keeps checking the classic codes (input.down('KeyW'), every `e.code === 'KeyM'` listener). A capture
// listener on window, registered before everything else (at import), turns the physical key into the game code(s) of
// the action(s) it is bound to (save.binds.kb, read live) and re-dispatches it as a synthetic event; the original key
// of an action that moved elsewhere no longer produces that action's code while you play (jump on J: Space no longer
// jumps). Synthetic events (isTrusted false: these and the controller's) are never remapped again.

// keys that also run the menus: never blocked (Esc still closes things when PAUSE moved to another key)
const UI_KEYS = new Set(['Escape', 'Enter', 'NumpadEnter', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab']);
let remapPaused = false;
let inputRef = null; // the Input (its `enabled`: blocking moved keys only while you play)
let table = null, tableKey = '';
const sent = new Map(); // physical code -> game codes its keydown produced (its keyup releases the same)

/** Pause the keyboard remap (the CONTROLS screen while it waits for the key to bind). */
export function setRemapPaused(v) { remapPaused = !!v; }
/** Drop the cached table (it rebuilds itself when save.binds changes anyway). */
export function bindingsChanged() { table = null; }

function remapTable() {
  const key = JSON.stringify(save?.binds?.kb || null);
  if (table && key === tableKey) return table;
  const kb = bindsOf(save).kb, out = new Map(), moved = new Set();
  for (const a of ACTIONS) {
    if (a.padOnly) continue;
    const p = kb[a.id];
    if (p) { if (!out.has(p)) out.set(p, new Set()); out.get(p).add(a.code); }
    if (p !== a.code && !UI_KEYS.has(a.code)) moved.add(a.code);
  }
  for (const a of ACTIONS) if (!a.padOnly && kb[a.id] === a.code) moved.delete(a.code); // (still on its own key for another action)
  tableKey = key; table = { out, moved };
  return table;
}

/** The KeyboardEvent.key for a code (synthetic events carry a plausible one). */
export function keyOf(code = '') {
  if (code.startsWith('Key')) return code.slice(3).toLowerCase();
  if (code.startsWith('Digit')) return code.slice(5);
  return { Space: ' ', ShiftLeft: 'Shift', ShiftRight: 'Shift', ControlLeft: 'Control', ControlRight: 'Control', AltLeft: 'Alt',
    AltRight: 'Alt', MetaLeft: 'Meta', MetaRight: 'Meta', NumpadEnter: 'Enter' }[code] || code;
}

/** Dispatch a synthetic key event (what the focused element would get from a real key). */
export function fireKey(type, code, opts = {}, target = null) {
  const t = target || document.activeElement || document.body || window;
  const ev = new KeyboardEvent(type, { code, key: keyOf(code), bubbles: true, cancelable: true, composed: true, ...opts });
  try { t.dispatchEvent(ev); } catch (err) { console.warn('input: synthetic key', err); }
  return ev;
}

const typing = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
function remap(e) {
  if (!e.isTrusted || remapPaused || typing(e.target) || !e.code) return;
  const down = e.type === 'keydown';
  let codes;
  if (down) {
    const { out, moved } = remapTable();
    const g = out.get(e.code);
    if (g && !(g.size === 1 && g.has(e.code))) codes = [...g];
    else if (!g && moved.has(e.code) && inputRef?.enabled) codes = []; // (an action's old key: blocked while you play)
    else { sent.delete(e.code); return; }
    sent.set(e.code, codes);
  } else {
    codes = sent.get(e.code);
    if (!codes) return;
    sent.delete(e.code);
  }
  e.stopImmediatePropagation();
  e.preventDefault();
  const mods = { repeat: e.repeat, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey };
  for (const c of codes) fireKey(e.type, c, mods, e.target);
}
addEventListener('keydown', remap, true);
addEventListener('keyup', remap, true);
addEventListener('blur', () => sent.clear());

// down(code): held · hit(code): pressed this frame · up(code): released this frame.
export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.pressed = new Set();
    this.released = new Set();
    this.mdx = 0; this.mdy = 0; this.wheel = 0;
    this.locked = false;
    this.enabled = true;
    // cursorFree: the mouse is deliberately free (e.g. chalet build mode): a click on the canvas doesn't grab it
    // back, and losing pointer lock doesn't open the pause menu (main.js overlayOpen). lookDrag: mouse movement
    // still turns the view while the pointer is free (build mode: hold the right button to look around).
    this.cursorFree = false;
    this.lookDrag = false;
    // the controller's left stick, -1..1 after its deadzone (core/gamepad.js; 0 without one): analog extras only,
    // the stick also holds W A S D like the keys
    this.stickX = 0; this.stickY = 0;
    inputRef = this;
    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (e.target?.classList?.contains('mpn-input')) return; // (typing your multiplayer name: no game keys, no preventDefault)
      this.keys.add(e.code);
      this.pressed.add(e.code);
      if (['Space', 'Tab', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
    });
    addEventListener('keyup', (e) => {
      if (this.keys.delete(e.code)) this.released.add(e.code);
    });
    // losing focus drops every key without reporting releases (no accidental jumps)
    addEventListener('blur', () => { this.keys.clear(); this.released.clear(); });
    addEventListener('mousemove', (e) => {
      if (!this.locked && !this.lookDrag) return;
      this.mdx += e.movementX; this.mdy += live.invertY ? -e.movementY : e.movementY; // (SETTINGS · Invert mouse Y)
    });
    addEventListener('wheel', (e) => { this.wheel += Math.sign(e.deltaY); }, { passive: true });
    document.addEventListener('pointerlockchange', () => { this.locked = document.pointerLockElement === canvas; });
    canvas.addEventListener('click', () => { if (this.enabled && !this.locked && !this.cursorFree) this.lock(); });
  }
  // (no-op while the mouse is deliberately free: an overlay closing mustn't grab it back from build mode)
  lock() { if (!this.cursorFree) this.canvas.requestPointerLock?.()?.catch?.(() => {}); }
  unlock() { if (document.pointerLockElement) document.exitPointerLock(); }
  down(code) { return this.enabled && this.keys.has(code); }
  hit(code) { return this.enabled && this.pressed.has(code); }
  up(code) { return this.enabled && this.released.has(code); }
  endFrame() { this.pressed.clear(); this.released.clear(); this.mdx = 0; this.mdy = 0; this.wheel = 0; }
}
