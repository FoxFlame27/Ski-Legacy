// Travel UI: where E at a stop, a station or the helipad takes you.
// RoutePicker draws the line on a house-style map (the trail map's relief, pistes and lifts underneath), its
// stops, where you are, and the destinations as a list beside it. Hover or the arrow keys highlight a stop (the
// route there lights up, with its name, ride time and price), click or Enter rides there, Esc cancels.
// Used by the ski bus, the Wolkenspitzbahn and gondola mid-stations; the heli-ski desk opens it as a pilot's
// chart (mode 'chart': range rings round the helipad, flight lines to the drop zones, a flight plan card).
// While open it blocks the game like a panel (hud.setBlocking('travel')): no input, no pause menu on Esc; the
// pointer is released, and the chosen ride locks it again (main.js's actions call input.lock()).
//
//   picker.open({ mode: 'route' | 'chart', title, kicker, sub, from: { name, x, z }, lines: [[[x, z]...]...],
//                 lineStyle: 'bus' | 'rail' | 'lift', stops: [{ name, x, z }],
//                 dests: [{ name, x, z, path?: [[x, z]...], meta, price?: number|string, tag?: string, short?, act }],
//                 home?: { x, z } (chart), go: 'RIDE' | 'FLY', goNote?, goDisabled?, onCancel? })
import './travel.css';
import { TrailMap, NAVY, RED, BLUE, FONT } from './trailmap.js';
import { MAIN_SUMMIT } from '../world/world.js';
import { layout } from '../world/layout.js';
import { PISTE_COLORS } from '../world/resortdressing.js';
import { brushSVG, brushClip, esc } from './menu.js';

const seedOf = (str) => [...String(str)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 9973, 17);
const fmtKm = (km) => (km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`);
export const fmtMin = (min) => (min < 1.5 ? '1 min' : `${Math.round(min)} min`);

function travelRoot() {
  let el = document.getElementById('travel');
  if (!el) {
    el = document.createElement('div');
    el.id = 'travel';
    el.hidden = true;
    document.body.appendChild(el);
  }
  return el;
}

let shared = null;
/** The one picker (it owns #travel): main.js and heli.js both open it through here. */
export function travelPicker(o) {
  shared ??= new RoutePicker(o);
  return shared;
}

export class RoutePicker extends TrailMap {
  constructor({ hud, player, audio } = {}) {
    super({ player, root: travelRoot() });
    this.hud = hud;
    this.audio = audio;
    this.o = null;
    this.fi = 0;
    this.onKey = (e) => this.key(e);
  }

  get isOpen() { return !!this.o; }

  // (TrailMap's constructor calls this; the head and the list are filled in by open())
  build() {
    const r = this.root;
    r.innerHTML = `
      <div class="tv-head"></div>
      <div class="tv-body">
        <div class="tv-map paper" style="--clip:${brushClip(181, 3, 4)}">
          <canvas class="tv-canvas"></canvas>
          <div class="tm-scale"><i></i><span></span></div>
        </div>
        <div class="tv-side menu-panel" style="--clip:${brushClip(183, 5, 4)}">
          <div class="mp-head tv-lh">STOPS</div>
          <div class="tv-list"></div>
          <div class="tv-plan"></div>
          <button class="tv-go"><span></span></button>
          <button class="tv-cancel"><i class="kc">ESC</i>Cancel</button>
        </div>
      </div>
      <div class="tv-hints">
        <span class="hint"><i class="kc kc-arrow up"></i><i class="kc kc-arrow down"></i><em>Choose</em></span>
        <span class="hint"><i class="kc">ENTER</i><em class="tv-hgo">Ride</em></span>
        <span class="hint"><i class="kc kc-word">CLICK</i><em>A stop on the map</em></span>
        <span class="hint"><i class="kc">ESC</i><em>Cancel</em></span>
      </div>`;
    this.canvas = r.querySelector('.tv-canvas');
    this.g = this.canvas.getContext('2d');
    this.$scale = r.querySelector('.tm-scale');
    this.$head = r.querySelector('.tv-head');
    this.$list = r.querySelector('.tv-list');
    this.$plan = r.querySelector('.tv-plan');
    this.$go = r.querySelector('.tv-go');
    this.$lh = r.querySelector('.tv-lh');
    this.$hgo = r.querySelector('.tv-hgo');
    this.$go.addEventListener('click', () => this.choose(this.fi));
    r.querySelector('.tv-cancel').addEventListener('click', () => this.cancel());
    this.$list.addEventListener('click', (e) => { const b = e.target.closest('.tv-dest'); if (b) this.choose(+b.dataset.i); });
    this.$list.addEventListener('mousemove', (e) => { const b = e.target.closest('.tv-dest'); if (b && +b.dataset.i !== this.fi) this.focus(+b.dataset.i); });
    const cv = this.canvas;
    cv.addEventListener('pointermove', (e) => {
      const s = this.spotAt(e);
      cv.classList.toggle('pick', !!s);
      if (s && s.i !== undefined && s.i !== this.fi) this.focus(s.i);
    });
    cv.addEventListener('click', (e) => { const s = this.spotAt(e); if (s && s.i !== undefined) this.choose(s.i); });
    addEventListener('resize', () => { if (this.isOpen) { this.resize(); this.fit(); } });
  }

  open(o) {
    if (this.o) this.close();
    this.o = o;
    const r = this.root;
    r.classList.toggle('chart', o.mode === 'chart');
    const title = String(o.title || '').toUpperCase(), w = Math.max(240, Math.round(title.length * 25 + 120));
    this.$head.innerHTML = `
      <div class="menu-title" style="width:calc(var(--u) * ${Math.round(w * 0.92)})">${brushSVG(seedOf(title), w, 100)}<span>${esc(title)}</span></div>
      <div>${o.kicker ? `<div class="tv-kick"><i></i>${esc(o.kicker)}</div>` : ''}<div class="menu-sub">${o.sub || ''}</div></div>`;
    this.$lh.textContent = o.listHead || (o.mode === 'chart' ? 'DESTINATIONS' : 'WHERE TO?');
    this.$hgo.textContent = o.go === 'FLY' ? 'Fly' : 'Ride';
    this.$list.innerHTML = o.dests.map((d, i) => {
      const pr = d.tag ? `<span class="tv-pr tag${/free/i.test(d.tag) ? ' free' : ''}">${esc(d.tag)}</span>`
        : d.price !== undefined && d.price !== null ? `<span class="tv-pr${d.short ? ' short' : ''}">${esc(typeof d.price === 'number' ? `$${d.price}` : d.price)}</span>` : '';
      return `<button class="tv-dest" data-i="${i}"><i class="tv-dot${d.dot ? ' ' + d.dot : ''}"></i><span class="tv-dn"><b>${esc(d.name)}</b>${d.meta ? `<em>${esc(d.meta)}</em>` : ''}</span>${pr}</button>`;
    }).join('');
    r.hidden = false;
    this.hud?.setBlocking?.('travel', true);
    document.exitPointerLock?.();
    // (registered on open, after main.js's own capture listener: Esc still counts as closing an overlay there)
    addEventListener('keydown', this.onKey, true);
    this.audio?.play?.('click');
    document.body.classList.add('tv-open');
    this.resize();
    this.fit();
    this.focus(Math.max(0, Math.min(o.dests.length - 1, o.focus ?? 0)));
    this.buildTiles(45); // (a head start on the relief: the game waits behind the map anyway)
    cancelAnimationFrame(this.raf);
    const loop = () => {
      if (!this.isOpen) return;
      this.buildTiles(12);
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  close() {
    if (!this.o) return;
    this.o = null;
    this.root.hidden = true;
    document.body.classList.remove('tv-open');
    cancelAnimationFrame(this.raf);
    removeEventListener('keydown', this.onKey, true);
    this.hud?.setBlocking?.('travel', false);
  }

  cancel() {
    const o = this.o;
    this.close();
    o?.onCancel?.();
  }

  choose(i) {
    const o = this.o, d = o?.dests[i];
    if (!d || d.disabled || (o.goDisabled && o.goDisabled(d))) { this.audio?.play?.('error'); return; }
    this.close();
    d.act?.();
  }

  focus(i) {
    const o = this.o;
    if (!o) return;
    this.fi = i;
    this.$list.querySelectorAll('.tv-dest').forEach((b, k) => b.classList.toggle('sel', k === i));
    this.$list.children[i]?.scrollIntoView?.({ block: 'nearest' });
    const d = o.dests[i];
    const goLabel = o.goLabel ? o.goLabel(d) : `${o.go || 'RIDE'} · ${d.name}`;
    this.$go.firstElementChild.textContent = goLabel;
    this.$go.classList.toggle('long', goLabel.length > 17);
    const off = d.disabled || (o.goDisabled && o.goDisabled(d));
    this.$go.disabled = !!off;
    this.$plan.innerHTML = o.plan ? o.plan(d) : '';
  }

  key(e) {
    if (!this.isOpen) return;
    const k = e.code;
    const n = this.o.dests.length;
    let used = true;
    if (k === 'Escape') this.cancel();
    else if (k === 'ArrowUp' || k === 'ArrowLeft' || k === 'KeyW' || k === 'KeyA') this.focus((this.fi + n - 1) % n);
    else if (k === 'ArrowDown' || k === 'ArrowRight' || k === 'KeyS' || k === 'KeyD' || k === 'Tab') this.focus((this.fi + 1) % n);
    else if ((k === 'Enter' || k === 'NumpadEnter' || k === 'Space') && !e.repeat) this.choose(this.fi);
    else if (/^Digit[1-9]$/.test(k) && !e.repeat) { const i = +k.slice(5) - 1; if (i < n) { this.focus(i); this.choose(i); } }
    else if (k === 'KeyE' || k === 'KeyM') { /* (swallowed: the game must not see them while choosing) */ }
    else used = false;
    if (used) { e.preventDefault(); e.stopImmediatePropagation(); }
  }

  // the whole line (every stop, the paths, you) in view, with room for the labels
  fit() {
    const o = this.o;
    if (!o) return;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    const add = (x, z) => { if (!Number.isFinite(x) || !Number.isFinite(z)) return; x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); };
    for (const s of o.stops || []) add(s.x, s.z);
    for (const d of o.dests) if (d.x !== undefined) add(d.x, d.z);
    if (o.from) add(o.from.x, o.from.z);
    if (o.home) add(o.home.x, o.home.z);
    for (const L of o.lines || []) for (const p of L) add(p[0], p[1]);
    if (!Number.isFinite(x0)) { x0 = x1 = this.player.pos.x; z0 = z1 = this.player.pos.z; }
    const pad = o.mode === 'chart' ? 0.16 : 0.13;
    const w = Math.max(400, x1 - x0), h = Math.max(300, z1 - z0);
    const s = Math.min((this.W * (1 - 2 * pad)) / w, (this.H * (1 - 2 * pad)) / h);
    this.view.s = Math.min(1.2, Math.max(0.03, s));
    this.view.x = (x0 + x1) / 2;
    this.view.z = (z0 + z1) / 2;
  }

  // ---------------------------------------------------------------- drawing
  draw() {
    const o = this.o, g = this.g, v = this.view, W = this.W, H = this.H, now = performance.now();
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.fillStyle = '#eef2fa';
    g.fillRect(0, 0, W, H);
    this.X = (x) => (x - v.x) * v.s + W / 2;
    this.Z = (z) => (z - v.z) * v.s + H / 2;
    this.drawRelief(now);
    this.boxes = []; this.queue = []; this.spots = [];
    const chart = o.mode === 'chart';
    // a soft wash calms the relief so the line reads first (a little more on the pilot's chart)
    g.fillStyle = chart ? 'rgba(250,252,255,0.42)' : 'rgba(255,255,255,0.22)';
    g.fillRect(0, 0, W, H);
    if (chart) this.drawGrid();
    this.drawVillage();
    this.drawContext(chart);
    this.drawSummits();
    if (chart) this.drawChart(now); else this.drawRoute(now);
    this.drawPlayer(now);
    this.placeLabels();
    this.drawScale();
  }

  // pistes and lifts, thin and quiet (where you'll ski once you get there)
  drawContext(chart) {
    const g = this.g;
    g.save();
    g.lineCap = 'round'; g.lineJoin = 'round';
    g.globalAlpha = chart ? 0.35 : 0.55;
    for (const p of layout.pistes) {
      this.path(p.pts);
      g.strokeStyle = PISTE_COLORS[p.diff]; g.lineWidth = 2.6;
      g.stroke();
    }
    g.globalAlpha = chart ? 0.35 : 0.6;
    g.strokeStyle = NAVY; g.lineWidth = 1.4;
    for (const l of layout.lifts) {
      g.beginPath(); g.moveTo(this.X(l.bottom.x), this.Z(l.bottom.z)); g.lineTo(this.X(l.top.x), this.Z(l.top.z)); g.stroke();
    }
    g.restore();
  }

  drawSummits() {
    const g = this.g;
    for (const p of layout.peaks) {
      const sm = p.summit || (p.id === 'legacy' ? MAIN_SUMMIT : null);
      if (!sm) continue;
      const x = this.X(sm.x), y = this.Z(sm.z);
      if (!this.inView(x, y)) continue;
      g.fillStyle = NAVY; g.strokeStyle = '#fff'; g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(x, y - 6); g.lineTo(x + 6, y + 4); g.lineTo(x - 6, y + 4); g.closePath(); g.fill(); g.stroke();
      this.reserve(x, y, 7);
      this.label(p.name.toUpperCase(), x, y, { size: 15, color: 'rgba(21,33,74,0.8)', prio: 6, cands: [[0, 16, 'center'], [0, -16, 'center'], [11, 0, 'left'], [-11, 0, 'right']] });
    }
  }

  // the line, the trip to the highlighted stop, the stops
  drawRoute(now) {
    const o = this.o, g = this.g, d = o.dests[this.fi], style = o.lineStyle || 'bus';
    g.save();
    g.lineCap = 'round'; g.lineJoin = 'round';
    for (const L of o.lines || []) {
      this.path(L);
      g.setLineDash([]);
      g.strokeStyle = 'rgba(255,255,255,0.96)'; g.lineWidth = style === 'lift' ? 7 : 9; g.stroke();
      if (style === 'rail') {
        g.strokeStyle = '#1b1f27'; g.lineWidth = 5; g.stroke();
        g.setLineDash([5, 7]); g.strokeStyle = '#fff'; g.lineWidth = 1.8; g.stroke();
      } else {
        g.strokeStyle = style === 'lift' ? NAVY : BLUE; g.lineWidth = style === 'lift' ? 3 : 4.5; g.stroke();
      }
    }
    // a transfer (no road there): only a dashed line, no route
    if (d?.transfer && d.path?.length > 1) {
      this.path(d.path);
      g.setLineDash([2, 12]); g.strokeStyle = '#fff'; g.lineWidth = 7; g.stroke();
      g.setLineDash([2, 12]); g.strokeStyle = RED; g.lineWidth = 3.5; g.stroke();
      g.setLineDash([]);
    } else if (d?.path?.length > 1) {
      // the trip: red, with a slow march along it toward the stop
      this.path(d.path);
      g.setLineDash([]);
      g.strokeStyle = '#fff'; g.lineWidth = 12; g.stroke();
      g.strokeStyle = RED; g.lineWidth = 6.5; g.stroke();
      g.setLineDash([3, 13]); g.lineDashOffset = -now / 45;
      g.strokeStyle = 'rgba(255,255,255,0.95)'; g.lineWidth = 3; g.stroke();
      g.setLineDash([]); g.lineDashOffset = 0;
    }
    g.restore();
    // stops: white rings; the highlighted one red and breathing; where you are: navy with YOU ARE HERE
    const fromName = o.from?.name;
    for (const s of o.stops || []) {
      const x = this.X(s.x), y = this.Z(s.z);
      if (!this.inView(x, y)) continue;
      const di = o.dests.findIndex((q) => q.name === s.name);
      const here = s.name === fromName, sel = di === this.fi && di >= 0;
      if (sel) {
        const ph = (now / 1300) % 1;
        g.strokeStyle = `rgba(226,35,26,${0.55 * (1 - ph)})`; g.lineWidth = 2.5;
        g.beginPath(); g.arc(x, y, 11 + ph * 20, 0, Math.PI * 2); g.stroke();
      }
      const r = sel ? 10 : here ? 8.5 : 7.5;
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2);
      g.fillStyle = sel ? RED : here ? NAVY : '#fff'; g.fill();
      g.lineWidth = sel || here ? 3 : 3.2; g.strokeStyle = sel || here ? '#fff' : (style === 'rail' ? '#1b1f27' : style === 'lift' ? NAVY : BLUE); g.stroke();
      if (here) { g.beginPath(); g.arc(x, y, 3, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill(); }
      this.reserve(x, y, r + 2);
      if (di >= 0) this.spots.push({ x, y, r: Math.max(16, r + 6), i: di });
      const cands = this.around(r + 2, 6);
      if (sel) this.label(s.name.toUpperCase(), x, y, { size: 22, color: RED, prio: -2, force: true, cands });
      else if (here) this.label('YOU ARE HERE', x, y, { size: 16, color: NAVY, prio: -1, force: true, cands });
      else this.label(s.name, x, y, { size: 16, color: style === 'rail' ? '#1b1f27' : style === 'lift' ? NAVY : BLUE, prio: 0, cands });
    }
  }

  // the pilot's chart: a 1 km grid, range rings and a compass rose round the helipad, flight lines to each zone
  drawGrid() {
    const g = this.g, v = this.view, STEP = 1000;
    const wx0 = v.x - this.W / 2 / v.s, wx1 = v.x + this.W / 2 / v.s, wz0 = v.z - this.H / 2 / v.s, wz1 = v.z + this.H / 2 / v.s;
    g.save();
    g.strokeStyle = 'rgba(21,70,200,0.13)'; g.lineWidth = 1;
    g.beginPath();
    for (let x = Math.ceil(wx0 / STEP) * STEP; x <= wx1; x += STEP) { const px = Math.round(this.X(x)) + 0.5; g.moveTo(px, 0); g.lineTo(px, this.H); }
    for (let z = Math.ceil(wz0 / STEP) * STEP; z <= wz1; z += STEP) { const py = Math.round(this.Z(z)) + 0.5; g.moveTo(0, py); g.lineTo(this.W, py); }
    g.stroke();
    g.restore();
  }

  drawChart(now) {
    const o = this.o, g = this.g, s = this.view.s, H0 = o.home, d = o.dests[this.fi];
    const hx = this.X(H0.x), hy = this.Z(H0.z);
    g.save();
    // range rings every km, labelled where they leave the top of the rose
    g.setLineDash([2, 6]); g.lineWidth = 1.4; g.strokeStyle = 'rgba(21,70,200,0.45)';
    for (let km = 1; km <= 6; km++) {
      const r = km * 1000 * s;
      if (r > Math.hypot(this.W, this.H)) break;
      g.beginPath(); g.arc(hx, hy, r, 0, Math.PI * 2); g.stroke();
      const lx = hx + r * Math.cos(-Math.PI * 0.32), ly = hy + r * Math.sin(-Math.PI * 0.32);
      if (this.inView(lx, ly, -20)) this.label(`${km} KM`, lx, ly, { size: 13, weight: 700, color: 'rgba(21,70,200,0.75)', prio: 8 });
    }
    g.setLineDash([]);
    // compass rose: ticks every 10 deg, longer every 30, N up (map north is -z)
    const R = 46;
    g.strokeStyle = 'rgba(21,33,74,0.7)'; g.lineWidth = 1.2;
    g.beginPath(); g.arc(hx, hy, R, 0, Math.PI * 2); g.stroke();
    for (let a = 0; a < 360; a += 10) {
      const t = (a * Math.PI) / 180, l = a % 90 === 0 ? 12 : a % 30 === 0 ? 8 : 4;
      g.beginPath(); g.moveTo(hx + Math.sin(t) * R, hy - Math.cos(t) * R); g.lineTo(hx + Math.sin(t) * (R - l), hy - Math.cos(t) * (R - l)); g.stroke();
    }
    g.fillStyle = RED;
    g.beginPath(); g.moveTo(hx, hy - R - 11); g.lineTo(hx + 5, hy - R - 1); g.lineTo(hx - 5, hy - R - 1); g.closePath(); g.fill();
    g.font = `italic 700 14px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 3; g.strokeStyle = 'rgba(255,255,255,0.95)'; g.strokeText('N', hx, hy - R - 21); g.fillStyle = NAVY; g.fillText('N', hx, hy - R - 21);
    this.boxes.push([hx - R - 4, hy - R - 30, hx + R + 4, hy + R + 4]);
    // flight lines: thin dashed to every zone, the planned one solid red with an arrowhead
    for (let i = 0; i < o.dests.length; i++) {
      const q = o.dests[i];
      if (q.x === undefined) continue;
      const x = this.X(q.x), y = this.Z(q.z);
      if (i === this.fi) continue;
      g.setLineDash([6, 7]); g.strokeStyle = 'rgba(21,33,74,0.42)'; g.lineWidth = 1.6;
      g.beginPath(); g.moveTo(hx, hy); g.lineTo(x, y); g.stroke();
    }
    g.setLineDash([]);
    if (d && d.x !== undefined) {
      const x = this.X(d.x), y = this.Z(d.z), len = Math.hypot(x - hx, y - hy), ux = (x - hx) / (len || 1), uy = (y - hy) / (len || 1);
      const ex = x - ux * 14, ey = y - uy * 14;
      g.lineCap = 'round';
      g.strokeStyle = '#fff'; g.lineWidth = 8; g.beginPath(); g.moveTo(hx + ux * R, hy + uy * R); g.lineTo(ex, ey); g.stroke();
      g.strokeStyle = RED; g.lineWidth = 3.5; g.beginPath(); g.moveTo(hx + ux * R, hy + uy * R); g.lineTo(ex, ey); g.stroke();
      g.setLineDash([2, 14]); g.lineDashOffset = -now / 40; g.strokeStyle = '#fff'; g.lineWidth = 2; g.beginPath(); g.moveTo(hx + ux * R, hy + uy * R); g.lineTo(ex, ey); g.stroke();
      g.setLineDash([]); g.lineDashOffset = 0;
      // arrowhead
      g.fillStyle = RED; g.strokeStyle = '#fff'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(ex + ux * 6, ey + uy * 6); g.lineTo(ex - ux * 9 - uy * 7, ey - uy * 9 + ux * 7); g.lineTo(ex - ux * 9 + uy * 7, ey - uy * 9 - ux * 7); g.closePath(); g.stroke(); g.fill();
      // heading + distance along the line
      const brg = Math.round((((Math.atan2(d.x - H0.x, -(d.z - H0.z)) * 180) / Math.PI) + 360) % 360);
      let ang = Math.atan2(uy, ux);
      if (ang > Math.PI / 2) ang -= Math.PI; else if (ang < -Math.PI / 2) ang += Math.PI;
      const mx = (hx + x) / 2, my = (hy + y) / 2, nx = -Math.sin(ang), ny = Math.cos(ang);
      this.label(`${String(brg).padStart(3, '0')}°  ·  ${fmtKm(d.km)}`, mx, my, { size: 16, color: RED, prio: -1, force: true, cands: [[nx * 14, ny * 14, 'center', ang], [-nx * 14, -ny * 14, 'center', ang]] });
    }
    g.restore();
    // the helipad
    g.fillStyle = '#fff'; g.strokeStyle = RED; g.lineWidth = 2.5;
    g.beginPath(); g.arc(hx, hy, 11, 0, Math.PI * 2); g.fill(); g.stroke();
    g.fillStyle = RED; g.font = `italic 700 15px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('H', hx, hy + 0.5);
    this.label('HELI-SKI BASE', hx, hy, { size: 15, color: RED, prio: -1, force: true, cands: [[0, R + 16, 'center'], [R + 10, 0, 'left'], [-R - 10, 0, 'right']] });
    // drop zones: peaks; the planned one red and breathing
    for (let i = 0; i < o.dests.length; i++) {
      const q = o.dests[i];
      if (q.x === undefined) continue;
      const x = this.X(q.x), y = this.Z(q.z), sel = i === this.fi;
      if (!this.inView(x, y)) continue;
      if (sel) {
        const ph = (now / 1300) % 1;
        g.strokeStyle = `rgba(226,35,26,${0.55 * (1 - ph)})`; g.lineWidth = 2.5;
        g.beginPath(); g.arc(x, y, 12 + ph * 22, 0, Math.PI * 2); g.stroke();
      }
      const k = sel ? 11 : 8;
      g.fillStyle = sel ? RED : '#fff'; g.strokeStyle = sel ? '#fff' : RED; g.lineWidth = 2.5;
      g.beginPath(); g.moveTo(x, y - k); g.lineTo(x + k * 0.95, y + k * 0.7); g.lineTo(x - k * 0.95, y + k * 0.7); g.closePath(); g.fill(); g.stroke();
      this.reserve(x, y, k + 2);
      this.spots.push({ x, y, r: 18, i });
      const cands = this.around(k + 2, 6);
      if (sel) this.label(q.name.toUpperCase(), x, y, { size: 22, color: RED, prio: -2, force: true, cands });
      else this.label(q.name, x, y, { size: 16, color: '#8f1414', prio: 0, cands });
    }
  }

  spotAt(e) {
    const rc = this.canvas.getBoundingClientRect(), px = e.clientX - rc.left, py = e.clientY - rc.top;
    let best = null, bd = 1e9;
    for (const s of this.spots || []) { const d = Math.hypot(s.x - px, s.y - py) - s.r; if (d < 6 && d < bd) { bd = d; best = s; } }
    return best;
  }
}
