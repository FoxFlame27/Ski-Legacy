// BUTTON PROMPTS (Nov 1 2026, the user: "almost every menu you open still says Esc to open or W to move etc: fix that so
// it says Y to put on skis, + to Esc on Switch etc"). One place that knows what to call a key right now: the keyboard key
// (save.binds over the defaults) while you play on keyboard / mouse, the controller's button (Xbox / PlayStation /
// Switch names) while you play on a controller (gamepad.js padActive()). Swaps live when you switch device.
//
// Use in UI code:
//   K('interact')        -> 'E' or 'X' / '□' / 'Y'           (an action id from core/bindings.js ACTIONS, or a special:)
//   K('confirm') / K('cancel') / K('move') / K('look') / K('steer') / K('updown') / K('leftright') / K('esc')
//   kc('skis')           -> '<i class="kc" data-k="skis">G</i>'  (a keycap that re-labels itself when the device changes)
//   onPromptChange(fn)   -> fn() when the device / family / bindings change (re-render text that isn't a kc)
// And as a safety net, every keycap in the page (<i class="kc">E</i>, menu hints, HUD cards) whose text is a known key
// label is re-labelled automatically (installPromptSwap(), started on import): 'E' -> interact's button, 'ESC' -> the
// back / menu button, 'W' 'A' 'S' 'D' -> 'L STICK', 'MOUSE' -> 'R STICK', 'ENTER' -> confirm, arrows -> the d-pad.
import { ACTIONS, ACTION, bindsOf, padGlyph, keyLabel } from '../core/bindings.js';
import * as gp from '../core/gamepad.js';
import { save } from '../game/economy.js';

const isPad = () => { try { return !!gp.padActive?.(); } catch { return false; } };
const fam = () => { try { return gp.padInfo?.().family || 'xbox'; } catch { return 'xbox'; } };
/** Switch confirms with the right button (A, index 1) and backs out with the bottom one (B, index 0). */
const confirmIdx = (f) => (f === 'switch' ? 1 : 0);
const backIdx = (f) => (f === 'switch' ? 0 : 1);

/** Is the player using a controller right now? */
export const usingPad = () => isPad();
/** The controller family in use: 'xbox' | 'ps' | 'switch'. */
export const padFam = () => fam();

const SPECIAL_KB = { confirm: 'ENTER', cancel: 'ESC', esc: 'ESC', move: 'W A S D', steer: 'A D', look: 'MOUSE',
  updown: '↑ ↓', leftright: '← →', select: '↑ ↓', scroll: 'WHEEL' };
const SPECIAL_PAD = { move: 'L STICK', steer: 'L STICK', look: 'R STICK', updown: 'D-PAD', leftright: 'D-PAD',
  select: 'D-PAD', scroll: 'R STICK' };

/**
 * The label for an action or a special id on the current device.
 * @param {string} id  an ACTIONS id ('interact', 'skis', 'map', 'pause', ...) or a special ('confirm', 'back', 'move', ...)
 * @param {boolean} [pad]  force the controller (true) or keyboard (false) label
 */
export function K(id, pad = isPad()) {
  const f = fam();
  if (pad) {
    if (id === 'confirm') return padGlyph(confirmIdx(f), f);
    if (id === 'cancel') return padGlyph(backIdx(f), f);
    if (id === 'esc') return padGlyph(9, f);
    if (SPECIAL_PAD[id]) return SPECIAL_PAD[id];
    const a = ACTION[id];
    if (a?.stick) return 'L STICK';
    const i = bindsOf(save).pad[id];
    return Number.isInteger(i) ? padGlyph(i, f) : (a ? keyLabel(bindsOf(save).kb[id] || a.code) : String(id).toUpperCase());
  }
  if (SPECIAL_KB[id]) return SPECIAL_KB[id];
  const a = ACTION[id];
  if (!a) return String(id).toUpperCase();
  return keyLabel(bindsOf(save).kb[id] || a.code);
}

/** A keycap (HTML) for an action that re-labels itself when the device or bindings change. */
export const kc = (id) => { const t = K(id); return `<i class="kc${t.length > 1 ? ' kc-word' : ''}" data-k="${id}">${t}</i>`; };

// ---- the safety net: re-label keycaps written with a fixed key ------------------------------------------------
// keyboard label (as the UI prints it) -> action / special id
function labelMap() {
  const m = new Map();
  const b = bindsOf(save);
  for (const a of ACTIONS) if (!a.padOnly) m.set(keyLabel(b.kb[a.id] || a.code), a.id);
  // the defaults too (UI text written before rebinding existed)
  for (const a of ACTIONS) if (!a.padOnly && !m.has(keyLabel(a.code))) m.set(keyLabel(a.code), a.id);
  for (const [k, v] of Object.entries({ ESC: 'esc', ENTER: 'confirm', MOUSE: 'look', 'W A S D': 'move', WASD: 'move',
    'A D': 'steer', 'A / D': 'steer', '↑ ↓': 'updown', '← →': 'leftright', '↑': 'updown', '↓': 'updown', '←': 'leftright',
    '→': 'leftright', SHIFT: 'sprint', SPACE: 'jump', BACKSPACE: 'restart', W: 'forward', A: 'left', S: 'back', D: 'right' })) {
    if (!m.has(k) || ['W', 'A', 'S', 'D'].includes(k)) m.set(k, v);
  }
  return m;
}

const SEL = '.kc, .keycap, kbd, .key'; // (.key: the interaction prompt, index.html #prompt)
let lastState = '';
function stateKey() { return `${isPad() ? 'pad' : 'kb'}:${fam()}:${JSON.stringify(save?.binds || {})}`; }

function relabel(el, map, pad) {
  if (el.closest?.('[data-no-swap]')) return;
  if (el.dataset.k) { const t = K(el.dataset.k, pad); if (el.textContent !== t) el.textContent = t; return; }
  if (el.children.length) return; // (an icon keycap: leave it)
  // the game wrote a new key into it (el.textContent = 'G'): that's the new keyboard label
  if (el.dataset.kb == null || (el._swapT != null && el.textContent !== el._swapT)) el.dataset.kb = el.textContent.trim();
  const orig = el.dataset.kb;
  const id = map.get(orig.toUpperCase());
  const t = pad && id ? K(id, true) : orig;
  el._swapT = t;
  if (el.textContent !== t) el.textContent = t;
  if (el.classList.contains('kc')) el.classList.toggle('kc-word', t.length > 1);
}

function sweep(root = document) {
  const map = labelMap(), pad = isPad();
  if (root.matches?.(SEL)) relabel(root, map, pad);
  root.querySelectorAll?.(SEL).forEach((el) => relabel(el, map, pad));
}

const listeners = new Set();
/** fn() whenever the device, the controller family or the bindings change. Returns an unsubscribe function. */
export function onPromptChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/**
 * A canvas texture (THREE.CanvasTexture) whose drawing names a key (draw(g, w, h) uses K()): drawn again when the
 * device or the bindings change (world signs: "Press E · pick a course" -> "Press X · pick a course"). Returns tex.
 */
export function liveKeyTexture(tex, draw) {
  const ref = typeof WeakRef === 'function' ? new WeakRef(tex) : { deref: () => tex };
  const off = onPromptChange(() => {
    const t = ref.deref(), c = t?.image;
    if (!t || !c?.getContext) { off(); return; }
    c.width = c.width; // (clears it and resets the context state)
    draw(c.getContext('2d'), c.width, c.height);
    t.needsUpdate = true;
  });
  return tex;
}

let installed = false;
export function installPromptSwap() {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  const start = () => {
    new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) if (n.nodeType === 1) sweep(n);
        // text changed inside an existing keycap (textContent / innerText set by the game)
        const t = m.target.nodeType === 1 ? m.target : m.target.parentElement;
        const cap = t?.closest?.(SEL);
        if (cap) relabel(cap, labelMap(), isPad());
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
    sweep();
  };
  if (document.body) start(); else addEventListener('DOMContentLoaded', start, { once: true });
  const check = () => {
    const s = stateKey();
    if (s !== lastState) {
      lastState = s;
      document.body?.classList.toggle('using-pad', isPad());
      if (document.body) sweep();
      for (const fn of listeners) { try { fn(); } catch (e) { console.warn('prompt change', e); } }
    }
  };
  setInterval(check, 250);
  addEventListener('padchange', check);
  addEventListener('bindschange', check);
}
installPromptSwap();
