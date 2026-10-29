// Boot intro: the SKI LEGACY logo clip (src/ui/introclip.js) -> Icecold Studio -> a mountain card.
// Canvas clip + DOM/CSS scenes + WebAudio hits; skippable with any key or click.
import '@fontsource-variable/source-serif-4/opsz.css'; // calm editorial serif for the studio + mountain cards
import { IntroClip, CLIP_MS } from './introclip.js';
import { StudioIdent, STUDIO_MS, STUDIO_LEAVE_MS } from './studioident.js';

const wait = (ms, sig) => new Promise((res) => {
  const t = setTimeout(res, ms);
  sig.onSkip.push(() => { clearTimeout(t); res(); });
});

// The intro's mountain mark: three snowy peaks drawn as one line (it draws itself in: stroke-dashoffset), and a sun.
export function peaksMark(w = 220) {
  return `<svg class="peaks-mark" width="${w}" height="${Math.round(w * 0.5)}" viewBox="0 0 220 110" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
    <circle class="peaks-sun" cx="168" cy="26" r="12" stroke="#ff4d3d"/>
    <path class="peaks-line" pathLength="1" d="M6 100 L58 34 L78 58 L112 14 L146 62 L162 46 L214 100"/>
    <path class="peaks-snow" pathLength="1" d="M47 48 L58 34 L68 47 M101 28 L112 14 L124 30"/>
  </svg>`;
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

    // 3 -- a mountain card: the peaks drawn in, the line, and a word before the game (headphones on)
    if (!sig.skipped) {
      const s = this.scene(`
        <div class="peakcard">
          ${peaksMark()}
          <div class="peak-title">SKI LEGACY</div>
          <div class="peak-sub">Best played with headphones</div>
        </div>`, 'scene-peaks');
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
