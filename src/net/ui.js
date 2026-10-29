// Multiplayer overlays in the house style: the status pill (world · players · connection), a line for the race queue,
// and the permission prompt ("Bob wants to ride in your car · Y allow · N deny"). Plain DOM, styles injected once.
import { esc } from '../ui/menu.js';

const CSS = `
#mp-ui{position:fixed;inset:0;pointer-events:none;z-index:40;font-family:'Barlow Condensed',system-ui,sans-serif}
#mp-ui[hidden]{display:none}
.mp-pill{position:absolute;top:calc(var(--u,1px)*14);right:calc(var(--u,1px)*18);display:flex;flex-direction:column;align-items:flex-end;gap:calc(var(--u,1px)*6)}
.mp-pill>div{background:rgba(255,255,255,.92);color:#1f5fd1;font-style:italic;font-weight:700;letter-spacing:.04em;
  font-size:calc(var(--u,1px)*15);padding:calc(var(--u,1px)*4) calc(var(--u,1px)*12);border-radius:calc(var(--u,1px)*4);
  clip-path:polygon(2% 0,100% 4%,98% 100%,0 94%);box-shadow:0 2px 10px rgba(0,0,0,.15)}
.mp-pill .mp-bad{color:#c4262e}
.mp-pill .mp-race{color:#0f2f6b}
.mp-ask{position:absolute;left:50%;top:calc(var(--u,1px)*90);transform:translateX(-50%);min-width:calc(var(--u,1px)*360);
  background:#fff;color:#0f2f6b;padding:calc(var(--u,1px)*14) calc(var(--u,1px)*22);border-radius:calc(var(--u,1px)*6);
  clip-path:polygon(1% 3%,99% 0,100% 96%,0 100%);box-shadow:0 6px 24px rgba(0,0,0,.25);text-align:center;pointer-events:auto}
.mp-ask b{display:block;color:#1f5fd1;font-style:italic;font-size:calc(var(--u,1px)*24);font-weight:700;margin-bottom:calc(var(--u,1px)*8)}
.mp-ask .mp-keys{display:flex;justify-content:center;gap:calc(var(--u,1px)*18);font-size:calc(var(--u,1px)*17);font-weight:600}
.mp-ask button{font:inherit;border:0;background:#1f5fd1;color:#fff;font-style:italic;font-weight:700;padding:calc(var(--u,1px)*4) calc(var(--u,1px)*14);cursor:pointer}
.mp-ask button.no{background:#e9eef8;color:#0f2f6b}
.mp-ask .mp-time{height:calc(var(--u,1px)*3);background:#1f5fd1;margin-top:calc(var(--u,1px)*10);transform-origin:left;transition:transform linear}
`;

export class MpUI {
  constructor() {
    if (!document.getElementById('mp-ui-css')) {
      const st = document.createElement('style');
      st.id = 'mp-ui-css'; st.textContent = CSS;
      document.head.appendChild(st);
    }
    this.el = document.createElement('div');
    this.el.id = 'mp-ui';
    this.el.hidden = true;
    this.el.innerHTML = '<div class="mp-pill"><div class="mp-status"></div><div class="mp-race" hidden></div><div class="mp-skip" hidden></div></div>';
    document.body.appendChild(this.el);
    this.statusEl = this.el.querySelector('.mp-status');
    this.raceEl = this.el.querySelector('.mp-race');
    this.skipEl = this.el.querySelector('.mp-skip');
    this.asks = []; // queued permission prompts: { rid, text, resolve }
    this.cur = null;
    this.lines = { status: '', race: '', skip: '' };
    addEventListener('keydown', (e) => {
      if (!this.cur || e.repeat) return;
      if (e.code === 'KeyY') { e.preventDefault(); e.stopPropagation(); this.answer(true); }
      else if (e.code === 'KeyN') { e.preventDefault(); e.stopPropagation(); this.answer(false); }
    }, true);
  }

  show(on) { this.el.hidden = !on; if (!on) { this.closeAsk(); this.asks.length = 0; } }

  setStatus(text, bad = false) {
    if (text === this.lines.status && bad === this.statusBad) return;
    this.lines.status = text; this.statusBad = bad;
    this.statusEl.textContent = text;
    this.statusEl.classList.toggle('mp-bad', bad);
  }
  /** The race queue / countdown line ('' hides it). */
  setRace(text) { if (text !== this.lines.race) { this.lines.race = text; this.raceEl.textContent = text; this.raceEl.hidden = !text; } }
  /** The shared-transport speed-up line, e.g. "Hold SPACE to speed up (2/3 holding)" ('' hides it). */
  setSkip(text) { if (text !== this.lines.skip) { this.lines.skip = text; this.skipEl.textContent = text; this.skipEl.hidden = !text; } }

  /** A permission prompt; resolves true (allow) / false (deny or timeout). Several queue up one after another. */
  ask(rid, text, timeoutMs = 30000) {
    return new Promise((resolve) => {
      this.asks.push({ rid, text, resolve, until: performance.now() + timeoutMs - 1000 });
      if (!this.cur) this.nextAsk();
    });
  }
  /** The server closed a prompt (the asker left, timed out): drop it. */
  cancel(rid) {
    if (this.cur?.rid === rid) { this.cur.resolve(null); this.closeAsk(); this.nextAsk(); return; }
    const i = this.asks.findIndex((a) => a.rid === rid);
    if (i >= 0) { this.asks[i].resolve(null); this.asks.splice(i, 1); }
  }
  nextAsk() {
    const a = this.asks.shift();
    if (!a) return;
    const left = a.until - performance.now();
    if (left <= 0) { a.resolve(false); this.nextAsk(); return; }
    this.cur = a;
    const box = document.createElement('div');
    box.className = 'mp-ask';
    box.innerHTML = `<b>${esc(a.text)}</b><div class="mp-keys"><button class="yes">Y · ALLOW</button><button class="no">N · DENY</button></div><div class="mp-time"></div>`;
    box.querySelector('.yes').addEventListener('click', () => this.answer(true));
    box.querySelector('.no').addEventListener('click', () => this.answer(false));
    this.el.appendChild(box);
    this.box = box;
    const bar = box.querySelector('.mp-time');
    bar.style.transitionDuration = `${left}ms`;
    requestAnimationFrame(() => { bar.style.transform = 'scaleX(0)'; });
    this.askT = setTimeout(() => this.answer(false), left);
  }
  answer(allow) {
    const a = this.cur;
    if (!a) return;
    this.closeAsk();
    a.resolve(allow);
    this.nextAsk();
  }
  closeAsk() {
    clearTimeout(this.askT);
    this.box?.remove();
    this.box = null;
    this.cur = null;
  }
}
