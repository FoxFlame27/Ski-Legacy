// Multiplayer overlays in the house style: the status pill (world · players · connection), a line for the race queue,
// the live race board (every racer: place, name, time or "racing"), the race results card (the server's order, times
// and prize money), and the permission prompt ("Allow Bob to get in your car? · Y allow · N deny"). Plain DOM, styles
// injected once.
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
.mp-board{display:grid;grid-template-columns:auto 1fr auto;gap:calc(var(--u,1px)*2) calc(var(--u,1px)*10);min-width:calc(var(--u,1px)*200)}
.mp-board .me{color:#c8261c}
.mp-board i{font-style:normal;color:#0f2f6b;opacity:.75}
.mp-res{position:absolute;left:calc(var(--u,1px)*24);top:50%;transform:translateY(-50%);min-width:calc(var(--u,1px)*380);background:#fff;color:#0f2f6b;
  padding:calc(var(--u,1px)*16) calc(var(--u,1px)*22);border-radius:calc(var(--u,1px)*6);clip-path:polygon(1% 2%,99% 0,100% 97%,0 100%);
  box-shadow:0 6px 24px rgba(0,0,0,.25);pointer-events:auto;cursor:pointer;z-index:60}
.mp-res b.mp-h{display:block;color:#1f5fd1;font-style:italic;font-size:calc(var(--u,1px)*26);font-weight:700}
.mp-res small{display:block;font-size:calc(var(--u,1px)*13);letter-spacing:.08em;margin-bottom:calc(var(--u,1px)*10);opacity:.7}
.mp-res .mp-rows{display:grid;grid-template-columns:auto 1fr auto auto;gap:calc(var(--u,1px)*4) calc(var(--u,1px)*14);font-size:calc(var(--u,1px)*18);font-weight:600}
.mp-res .me{color:#c8261c}
.mp-res .prize{color:#1a8a3a}
.mp-ask .mp-time{height:calc(var(--u,1px)*3);background:#1f5fd1;margin-top:calc(var(--u,1px)*10);transform-origin:left;transition:transform linear}
`;

/** 83.456 s -> "1:23.45" */
export function fmtTime(t) {
  if (!Number.isFinite(t)) return '—';
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(2)}`;
}

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
    this.el.innerHTML = '<div class="mp-pill"><div class="mp-status"></div><div class="mp-race" hidden></div><div class="mp-skip" hidden></div><div class="mp-board" hidden></div></div>';
    document.body.appendChild(this.el);
    this.statusEl = this.el.querySelector('.mp-status');
    this.raceEl = this.el.querySelector('.mp-race');
    this.skipEl = this.el.querySelector('.mp-skip');
    this.boardEl = this.el.querySelector('.mp-board');
    this.asks = []; // queued permission prompts: { rid, text, resolve }
    this.cur = null;
    this.lines = { status: '', race: '', skip: '', board: '' };
    addEventListener('keydown', (e) => {
      if (!this.cur || e.repeat) return;
      if (e.code === 'KeyY') { e.preventDefault(); e.stopPropagation(); this.answer(true); }
      else if (e.code === 'KeyN') { e.preventDefault(); e.stopPropagation(); this.answer(false); }
    }, true);
  }

  show(on) { this.el.hidden = !on; if (!on) { this.closeAsk(); this.asks.length = 0; this.setBoard(null); this.closeResults(); } }

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

  /** The live race board: rows [{ name, me, time (s) | null, dnf }] in race order (null hides it). */
  setBoard(rows) {
    const html = rows?.length ? rows.map((r, i) => `<span>${i + 1}</span><span class="${r.me ? 'me' : ''}">${esc(r.name)}</span>`
      + `<span>${r.dnf ? '<i>DNF</i>' : Number.isFinite(r.time) ? fmtTime(r.time) : '<i>racing</i>'}</span>`).join('') : '';
    if (html === this.lines.board) return;
    this.lines.board = html;
    this.boardEl.innerHTML = html;
    this.boardEl.hidden = !html;
  }

  /** The race results from the server: { race name, order: [{ pid, name, place, time (ms), prize, dnf }] }. */
  results(title, order, selfPid) {
    this.closeResults();
    const box = document.createElement('div');
    box.className = 'mp-res';
    const rows = order.map((o) => `<span>${o.dnf ? '—' : o.place}</span><span class="${o.pid === selfPid ? 'me' : ''}">${esc(o.name)}</span>`
      + `<span>${o.dnf ? 'DNF' : fmtTime(o.time / 1000)}</span><span class="prize">${o.prize ? `+$${Math.round(o.prize).toLocaleString('en-US')}` : ''}</span>`).join('');
    box.innerHTML = `<b class="mp-h">${esc(title)}</b><small>RACE RESULTS · ${order.length} RACERS · CLICK TO CLOSE</small><div class="mp-rows">${rows}</div>`;
    box.addEventListener('click', () => this.closeResults());
    this.el.appendChild(box);
    this.resBox = box;
    this.resT = setTimeout(() => this.closeResults(), 20000);
  }
  closeResults() { clearTimeout(this.resT); this.resBox?.remove(); this.resBox = null; }

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
