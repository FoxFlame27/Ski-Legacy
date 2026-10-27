// Flight HUD while you fly the helicopter, in the house style (white brush panels, blue italic condensed
// numerals, red accents): speed + height above the snow bottom-right where the speedometer sits, the
// rotor gauge while it spools up, a prompt bottom-centre ("E  Jump out and ski" when low and slow over
// open snow) and the controls card bottom-left. It lives inside #hud, so the pause menu hides it too.
import { brushClip } from '../../ui/menu.js';
import { keysHTML } from '../../ui/hud.js';

const CSS = `
body.in-heli #speedo, body.in-heli #prompt, body.in-heli #ride-hint, body.in-heli #controls-hint { display: none !important; }
#heli-hud { position: absolute; inset: 0; pointer-events: none; }
#heli-hud .hh-panel { position: absolute; right: 22px; bottom: 22px; min-width: calc(var(--u) * 214); padding: calc(var(--u) * 10) calc(var(--u) * 28) calc(var(--u) * 14) calc(var(--u) * 40);
  text-align: right; color: var(--blue); animation: hudInR 0.5s cubic-bezier(.2,.9,.2,1) backwards; }
#heli-hud .hh-panel::after { content: ''; position: absolute; left: calc(var(--u) * 16); top: 32%; bottom: 32%; width: calc(var(--u) * 5); background: var(--red); }
#heli-hud .hh-row { display: flex; justify-content: flex-end; align-items: baseline; gap: calc(var(--u) * 8); }
#heli-hud .hh-row b { font: italic 700 calc(var(--u) * 56)/1 var(--num); font-variant-numeric: tabular-nums; }
#heli-hud .hh-row.alt { margin-top: calc(var(--u) * 4); }
#heli-hud .hh-row.alt b { font-size: calc(var(--u) * 40); }
#heli-hud .hh-row span { min-width: calc(var(--u) * 40); text-align: left; font: 800 var(--t-xs)/1 var(--ui); letter-spacing: 0.14em; color: var(--blue-dim); }
#heli-hud .hh-vs { display: inline-block; width: 0; height: 0; margin-right: calc(var(--u) * 2); border-left: calc(var(--u) * 6) solid transparent; border-right: calc(var(--u) * 6) solid transparent; opacity: 0; transition: opacity 0.2s; }
#heli-hud .hh-vs.up { border-bottom: calc(var(--u) * 9) solid var(--ok); opacity: 1; }
#heli-hud .hh-vs.down { border-top: calc(var(--u) * 9) solid var(--red); opacity: 1; }
#heli-hud .hh-rotor { display: flex; align-items: center; gap: calc(var(--u) * 10); margin-top: calc(var(--u) * 8); }
#heli-hud .hh-rotor[hidden] { display: none; }
#heli-hud .hh-rotor .rh-label { flex: none; }
#heli-hud .hh-bar { flex: 1; height: calc(var(--u) * 6); min-height: 4px; overflow: hidden; background: var(--blue-pale); transform: skewX(-20deg); }
#heli-hud .hh-bar i { display: block; height: 100%; background: var(--red); transform-origin: left center; transform: scaleX(0); }
#heli-hud .hh-prompt { position: absolute; left: 50%; bottom: 84px; transform: translateX(-50%); display: flex; align-items: center; gap: 10px; padding: 9px 22px 9px 12px;
  background: #fff; color: var(--blue); clip-path: var(--brush-b); filter: drop-shadow(0 6px 14px rgba(0, 20, 60, 0.28)); font-size: 14px; font-weight: 700; white-space: nowrap; }
#heli-hud .hh-prompt.nokey { padding-left: 22px; }
#heli-hud .hh-prompt .key { background: var(--blue); color: #fff; box-shadow: none; }
#heli-hud .hh-prompt.warn { color: var(--ko); }
#heli-hud .hh-keys { position: absolute; left: 22px; bottom: 92px; animation: hintIn 0.6s 0.4s cubic-bezier(.2,.9,.2,1) backwards; transition: opacity 0.6s ease, translate 0.6s ease; }
#heli-hud .hh-keys.out { opacity: 0; translate: calc(var(--u) * -24) 0; }
`;

const KEYS = [
  [keysHTML(['W', 'S']), 'Speed up · slow down'],
  [keysHTML(['A', 'D']), 'Turn'],
  [keysHTML(['SPACE']), 'Climb'],
  [keysHTML(['SHIFT']), 'Descend · land on flat snow'],
  [keysHTML(['MOUSE']), 'Look around'],
  [keysHTML(['E']), 'Get out · or jump out hovering low'],
];

export class HeliHud {
  constructor() {
    this.el = null;
    this.last = {};
  }

  build() {
    if (this.el) return;
    if (!document.getElementById('heli-hud-css')) {
      const st = document.createElement('style');
      st.id = 'heli-hud-css';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    const el = document.createElement('div');
    el.id = 'heli-hud';
    el.hidden = true;
    el.innerHTML = `
      <div class="rh-panel hh-panel" style="--clip:${brushClip(361, 4, 3)}">
        <div class="hh-row"><b class="hh-kmh">0</b><span>KM/H</span></div>
        <div class="hh-row alt"><i class="hh-vs"></i><b class="hh-alt">0</b><span>M ALT</span></div>
        <div class="hh-rotor" hidden><span class="rh-label">ROTOR</span><div class="hh-bar"><i></i></div></div>
      </div>
      <div class="hh-prompt" hidden><span class="key">E</span><span class="hh-ptext"></span></div>
      <div class="hh-keys" hidden><div class="ch-card paper"><div class="ch-head">HELICOPTER</div>${KEYS.map(([k, t]) => `<div class="ch-row"><span class="ch-keys">${k}</span><span class="ch-do">${t}</span></div>`).join('')}</div></div>`;
    (document.getElementById('hud') || document.body).appendChild(el);
    const q = (s) => el.querySelector(s);
    this.$ = { kmh: q('.hh-kmh'), alt: q('.hh-alt'), vs: q('.hh-vs'), rotor: q('.hh-rotor'), bar: q('.hh-bar i'), prompt: q('.hh-prompt'), key: q('.hh-prompt .key'), ptext: q('.hh-ptext'), keys: q('.hh-keys') };
    this.el = el;
  }

  /** Show / hide the flight HUD (and swap out the speedometer and prompt of the free-ride HUD). */
  show(on, keysMs = 14000) {
    this.build();
    document.body.classList.toggle('in-heli', on);
    this.el.hidden = !on;
    this.last = {};
    clearTimeout(this.keysT);
    const k = this.$.keys;
    if (on && keysMs > 0) {
      k.hidden = false; k.classList.remove('out');
      this.keysT = setTimeout(() => { k.classList.add('out'); this.keysT = setTimeout(() => { k.hidden = true; }, 650); }, keysMs);
    } else k.hidden = true;
  }

  /**
   * Per frame; touches the DOM only when a value changes.
   * @param {{speed: number, agl: number, vs: number, rpm: number, prompt: string|null, key: string|null, warn: boolean}} s
   */
  update(s) {
    if (!this.el || this.el.hidden) return;
    const $ = this.$, L = this.last;
    const kmh = String(Math.round(s.speed * 3.6));
    if (kmh !== L.kmh) { $.kmh.textContent = kmh; L.kmh = kmh; }
    const alt = String(Math.max(0, Math.round(s.agl)));
    if (alt !== L.alt) { $.alt.textContent = alt; L.alt = alt; }
    const vs = s.vs > 0.8 ? 'up' : s.vs < -0.8 ? 'down' : '';
    if (vs !== L.vs) { $.vs.className = `hh-vs ${vs}`; L.vs = vs; }
    const spool = s.rpm < 0.995;
    if (spool !== L.spool) { $.rotor.hidden = !spool; L.spool = spool; }
    if (spool) {
      const r = s.rpm.toFixed(3);
      if (r !== L.rpm) { $.bar.style.transform = `scaleX(${r})`; L.rpm = r; }
    }
    const pk = `${s.prompt}|${s.key}|${s.warn}`;
    if (pk !== L.prompt) {
      L.prompt = pk;
      $.prompt.hidden = !s.prompt;
      if (s.prompt) {
        $.ptext.textContent = s.prompt;
        $.key.hidden = !s.key;
        if (s.key) $.key.textContent = s.key;
        $.prompt.classList.toggle('nokey', !s.key);
        $.prompt.classList.toggle('warn', !!s.warn);
      }
    }
  }
}
