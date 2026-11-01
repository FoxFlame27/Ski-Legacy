// CONTROLS / BINDINGS (Nov 1 2026, the user: "make the game for controller (Xbox, PS5, PS4, Switch) ... add controls so
// you can change controls"). The game code keeps asking for the classic key codes (input.down('KeyW'), hit('KeyE'):
// the "game code" of an action). This table says which physical keyboard key and which controller button produce each
// game code. core/input.js translates: a pressed key / button -> the game code(s) bound to it. Rebinding only changes
// the table (stored in save.binds = { kb: { action: code }, pad: { action: buttonIndex } }; missing = default).
//
// Controller buttons use the W3C "standard" gamepad layout (Chrome / Electron map Xbox, DualShock 4, DualSense and the
// Switch Pro controller to it). By POSITION:
// (Inside your chalet the map button (View / Share / Minus) opens build mode instead: gamepad.js.)
//   0 bottom (Xbox A · PS Cross · Switch B)      1 right (Xbox B · PS Circle · Switch A)
//   2 left (Xbox X · PS Square · Switch Y)       3 top (Xbox Y · PS Triangle · Switch X)
//   4 LB · L1 · L     5 RB · R1 · R     6 LT · L2 · ZL     7 RT · R2 · ZR
//   8 View · Share/Create · Minus      9 Menu · Options · Plus      10 left stick click      11 right stick click
//   12 d-pad up   13 d-pad down   14 d-pad left   15 d-pad right   16 Xbox / PS / Home
// The left stick always moves (W A S D), the right stick always looks (mouse); they aren't rebindable.

/** Every rebindable action: id, label, the game code it produces, the menu group. */
export const ACTIONS = [
  // moving (keyboard rebindable; on a controller: the left stick)
  { id: 'forward', label: 'Forward · push / tuck · accelerate', code: 'KeyW', group: 'MOVE', stick: true },
  { id: 'back', label: 'Back · brake / reverse', code: 'KeyS', group: 'MOVE', stick: true },
  { id: 'left', label: 'Left · steer / spin', code: 'KeyA', group: 'MOVE', stick: true },
  { id: 'right', label: 'Right · steer / spin', code: 'KeyD', group: 'MOVE', stick: true },
  { id: 'jump', label: 'Jump (hold to crouch) · handbrake', code: 'Space', group: 'MOVE' },
  { id: 'sprint', label: 'Sprint · grab in the air · boost', code: 'ShiftLeft', group: 'MOVE' },
  { id: 'brake', label: 'Brake (controller trigger)', code: 'KeyS', group: 'MOVE', padOnly: true },
  // actions
  { id: 'interact', label: 'Interact · get in / out', code: 'KeyE', group: 'ACTIONS' },
  { id: 'view', label: 'First / third person', code: 'KeyR', group: 'ACTIONS' },
  { id: 'skis', label: 'Skis on / off', code: 'KeyG', group: 'ACTIONS' },
  { id: 'horn', label: 'Horn (car)', code: 'KeyH', group: 'ACTIONS' },
  { id: 'lights', label: 'Headlamp · car lights', code: 'KeyL', group: 'ACTIONS' },
  { id: 'lookback', label: 'Look back (car)', code: 'KeyC', group: 'ACTIONS' },
  { id: 'pickup', label: 'Pick up (chalet build mode)', code: 'KeyQ', group: 'ACTIONS' },
  { id: 'alt', label: 'Sell (chalet build mode)', code: 'KeyX', group: 'ACTIONS' },
  { id: 'unstuck', label: 'Unstuck car', code: 'KeyU', group: 'ACTIONS' },
  { id: 'restart', label: 'Restart race', code: 'Backspace', group: 'ACTIONS' },
  // context actions (ctx): only do something in one place, so on a controller they share a button with an action that
  // does nothing there (gamepad.js presses the codes of every action bound to the pressed button)
  { id: 'furnish', label: 'Furnish chalet · stand up (train) · flip car', code: 'KeyF', group: 'ACTIONS', ctx: true },
  { id: 'prevItem', label: 'Previous furniture (build mode)', code: 'BracketLeft', group: 'ACTIONS', ctx: true },
  { id: 'nextItem', label: 'Next furniture (build mode)', code: 'BracketRight', group: 'ACTIONS', ctx: true },
  { id: 'duty', label: 'Taxi: off duty (in your car)', code: 'KeyT', group: 'ACTIONS', ctx: true },
  // (Nov 1 2026, the user: "you should be able to furnish with like a fake mouse that you can unlock by pressing the
  // joystick down and re-lock by pressing it again"): controller only, a cursor the left stick moves (core/gamepad.js)
  { id: 'vmouse', label: 'Virtual mouse (chalet / menus)', code: '', group: 'ACTIONS', padOnly: true, ctx: true },
  // menus and screens
  { id: 'map', label: 'Trail map · furnish (controller, in your chalet)', code: 'KeyM', group: 'MENUS' },
  { id: 'pause', label: 'Pause menu', code: 'Escape', group: 'MENUS' },
];

export const ACTION = Object.fromEntries(ACTIONS.map((a) => [a.id, a]));

/** Default keyboard key per action (a KeyboardEvent.code). */
export const KB_DEFAULTS = Object.fromEntries(ACTIONS.filter((a) => !a.padOnly).map((a) => [a.id, a.code]));

/**
 * Default controller button per action (standard-layout index), modelled on how other games do it: the right trigger
 * (RT / R2 / ZR) with the stick forward sprints, bottom button jumps, left button interacts. A button may carry
 * several actions (the ctx ones join another): it presses all their codes.
 */
export const PAD_DEFAULTS = {
  jump: 0,      // A · Cross · B
  interact: 2,  // X · Square · Y
  skis: 3,      // Y · Triangle · X
  horn: 1,      // B · Circle · A
  sprint: 7,    // RT · R2 · ZR
  brake: 6,     // LT · L2 · ZL
  view: 5,      // RB · R1 · R (switch first / third person, like other games)
  alt: 11,      // right stick click (sell in chalet build mode)
  pickup: 4,    // LB · L1 · L
  lights: 15,   // d-pad right
  lookback: 10, // left stick click
  unstuck: 14,  // d-pad left
  restart: 13,  // d-pad down
  map: 8,       // View · Share · Minus
  pause: 9,     // Menu · Options · Plus
  // context actions, sharing a button with one that does nothing in that place:
  furnish: 3,   // with skis (Y): F in your chalet (skis can't go on in there), in a train seat, in a flipped car
  duty: 4,      // with pickup (LB): taxi off duty while you drive (pickup is chalet build mode only)
  prevItem: 14, // with unstuck (d-pad left): browse the furniture in build mode (unstuck is the car only)
  nextItem: 15, // with lights (d-pad right): (car lights / headlamp aren't used inside the chalet)
  vmouse: 10,   // with lookback (left stick click): the virtual mouse on / off when you aren't driving
};

// (Nov 1 2026, the user: "also make the Home button on Switch unstuck, and something else on the other controllers"):
// per controller family on top of PAD_DEFAULTS. Switch Home and the PS button reach the game (index 16); the Xbox
// button doesn't (Windows Game Bar / macOS take it), so Xbox keeps unstuck on the d-pad left.
export const FAMILY_PAD = { switch: {}, ps: {}, xbox: {} }; // (Nov 1 2026, the user: "nvm keep unstuck's old button": d-pad left on every controller)
let activeFamily = 'xbox';
/** gamepad.js tells which controller family is in use (its defaults differ a little: FAMILY_PAD). */
export function setPadFamily(f) { activeFamily = FAMILY_PAD[f] ? f : 'xbox'; }
/** The default controller buttons for a family (the one in use by default). */
export const padDefaults = (f = activeFamily) => ({ ...PAD_DEFAULTS, ...(FAMILY_PAD[f] || {}) });

/** The current bindings (save.binds over the defaults). */
export function bindsOf(save) {
  const b = save?.binds || {};
  // (old saves may still carry ids of actions that are gone, e.g. the removed photo mode: only known ids count)
  const known = (o) => Object.fromEntries(Object.entries(o || {}).filter(([id]) => ACTION[id]));
  return { kb: { ...KB_DEFAULTS, ...known(b.kb) }, pad: { ...padDefaults(), ...known(b.pad) } };
}

/** Controller family from Gamepad.id: 'xbox' | 'ps' | 'switch' (default xbox glyphs). */
export function padFamily(id = '') {
  const s = String(id).toLowerCase();
  if (/054c|playstation|dualsense|dualshock|wireless controller|ps4|ps5/.test(s)) return 'ps';
  if (/057e|nintendo|switch|pro controller|joy-con/.test(s)) return 'switch';
  return 'xbox';
}

const GLYPHS = {
  xbox: ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'VIEW', 'MENU', 'LS', 'RS', 'D↑', 'D↓', 'D←', 'D→', 'XBOX'],
  ps: ['✕', '○', '□', '△', 'L1', 'R1', 'L2', 'R2', 'SHARE', 'OPTIONS', 'L3', 'R3', 'D↑', 'D↓', 'D←', 'D→', 'PS'],
  switch: ['B', 'A', 'Y', 'X', 'L', 'R', 'ZL', 'ZR', '−', '+', 'LS', 'RS', 'D↑', 'D↓', 'D←', 'D→', 'HOME'],
};

/** Button label for a standard-layout index on a controller family. */
export const padGlyph = (i, family = 'xbox') => (GLYPHS[family] || GLYPHS.xbox)[i] ?? `B${i}`;

/** Readable label for a KeyboardEvent.code ('KeyW' -> 'W', 'ShiftLeft' -> 'SHIFT', 'Space' -> 'SPACE'). */
export function keyLabel(code = '') {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `NUM ${code.slice(6)}`;
  const m = { ShiftLeft: 'SHIFT', ShiftRight: 'R SHIFT', ControlLeft: 'CTRL', ControlRight: 'R CTRL', AltLeft: 'ALT',
    AltRight: 'R ALT', MetaLeft: 'CMD', MetaRight: 'R CMD', Space: 'SPACE', Escape: 'ESC', Backspace: 'BACKSPACE',
    Enter: 'ENTER', Tab: 'TAB', BracketLeft: '[', BracketRight: ']', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', CapsLock: 'CAPS' };
  return m[code] || code.toUpperCase();
}
