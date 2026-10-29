// Keyboard + pointer-lock mouse input.
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
      this.mdx += e.movementX; this.mdy += e.movementY;
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
