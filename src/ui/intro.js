// Boot intro: the SKI LEGACY logo clip (src/ui/introclip.js) -> Icecold Studio -> Made with Claude.
// Canvas clip + DOM/CSS scenes + WebAudio hits; skippable with any key or click.
import '@fontsource-variable/source-serif-4/opsz.css'; // calm editorial serif for the studio + Claude cards
import { IntroClip, CLIP_MS } from './introclip.js';
import { StudioIdent, STUDIO_MS, STUDIO_LEAVE_MS } from './studioident.js';

const wait = (ms, sig) => new Promise((res) => {
  const t = setTimeout(res, ms);
  sig.onSkip.push(() => { clearTimeout(t); res(); });
});

// Claude-style spark mark: rounded rays radiating from the center.
export function claudeMark(size = 120, color = '#fff') {
  const rays = 12;
  let paths = '';
  for (let i = 0; i < rays; i++) {
    const a = (i / rays) * Math.PI * 2 + (i % 2 ? 0.08 : 0);
    const len = i % 3 === 0 ? 46 : i % 3 === 1 ? 40 : 34;
    const x2 = 50 + Math.cos(a) * len, y2 = 50 + Math.sin(a) * len;
    const x1 = 50 + Math.cos(a) * 6, y1 = 50 + Math.sin(a) * 6;
    paths += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${color}" stroke-width="${i % 3 === 0 ? 9 : 8}" stroke-linecap="round"/>`;
  }
  return `<svg class="claude-mark" width="${size}" height="${size}" viewBox="0 0 100 100">${paths}</svg>`;
}

export class Intro {
  constructor(audio) {
    this.audio = audio;
    this.el = document.getElementById('intro');
    this.sig = { skipped: false, onSkip: [] };
    this.skip = () => {
      if (this.sig.skipped) return;
      this.sig.skipped = true;
      for (const f of this.sig.onSkip) f();
    };
  }

  scene(html, cls) {
    const s = document.createElement('div');
    s.className = 'intro-scene ' + cls;
    s.innerHTML = html;
    this.el.appendChild(s);
    return s;
  }

  async leave(s, ms = 600) {
    s.classList.add('leave');
    await wait(ms, this.sig);
    s.remove();
  }

  async play() {
    const sig = this.sig;
    this.el.hidden = false;
    addEventListener('keydown', this.skip, { once: true });
    this.el.addEventListener('pointerdown', this.skip, { once: true });
    const hint = document.createElement('div');
    hint.className = 'intro-skip';
    hint.textContent = 'Press any key to skip';
    this.el.appendChild(hint);

    // 1 -- the logo clip: the skier jumps, the camera whips back to the SKI LEGACY badge (src/ui/introclip.js)
    if (!sig.skipped) {
      const s = this.scene('', 'scene-clip');
      const clip = new IntroClip(s, this.audio);
      sig.onSkip.push(() => clip.stop());
      if (await clip.start()) await wait(CLIP_MS, sig);
      await this.leave(s, 500);
      clip.stop();
    }

    // 2 -- Icecold Studio: the ICECOLD logotype freezes into existence (src/ui/studioident.js)
    if (!sig.skipped) {
      const s = this.scene('', 'scene-studio');
      const ident = new StudioIdent(s, this.audio);
      sig.onSkip.push(() => ident.stop());
      const ok = await ident.start();
      if (!ok && !sig.skipped) ident.fallback();
      if (!sig.skipped) await wait(STUDIO_MS, sig);
      await this.leave(s, STUDIO_LEAVE_MS);
      ident.stop();
    }

    // 3 -- Made with Claude
    if (!sig.skipped) {
      const s = this.scene(`
        <div class="claude">
          ${claudeMark(132)}
          <div class="claude-made">Made with</div>
          <div class="claude-name">Claude</div>
        </div>`, 'scene-claude');
      requestAnimationFrame(() => s.classList.add('in'));
      this.audio?.play('soft');
      await wait(2300, sig);
      await this.leave(s, 700);
    }

    removeEventListener('keydown', this.skip);
    this.el.classList.add('done');
    await new Promise((r) => setTimeout(r, sig.skipped ? 250 : 500));
    this.el.hidden = true;
    this.el.innerHTML = '';
  }

  // snow dust kicked up by the impact
  dust(canvas) {
    const w = (canvas.width = innerWidth), h = (canvas.height = innerHeight);
    const g = canvas.getContext('2d');
    const parts = Array.from({ length: 220 }, () => {
      const a = Math.random() * Math.PI * 2, sp = 2 + Math.random() * 9;
      return { x: w / 2 + (Math.random() - 0.5) * w * 0.5, y: h * 0.53 + (Math.random() - 0.5) * 40, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.5 - 1.5, r: 1 + Math.random() * 3.5, life: 1 };
    });
    const step = () => {
      g.clearRect(0, 0, w, h);
      let alive = 0;
      for (const p of parts) {
        if (p.life <= 0) continue;
        alive++;
        p.x += p.vx; p.y += p.vy; p.vx *= 0.96; p.vy = p.vy * 0.96 + 0.05; p.life -= 0.012;
        g.globalAlpha = Math.max(0, p.life) * 0.9;
        g.fillStyle = '#fff';
        g.beginPath(); g.arc(p.x, p.y, p.r, 0, 7); g.fill();
      }
      if (alive && canvas.isConnected) requestAnimationFrame(step);
    };
    step();
  }
}
