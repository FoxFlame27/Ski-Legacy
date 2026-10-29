// Boot intro: the SKI LEGACY logo clip (src/ui/introclip.js) -> Icecold Studio.
// Canvas clip + DOM/CSS scenes + WebAudio hits; skippable with any key or click.
import '@fontsource-variable/source-serif-4/opsz.css'; // calm editorial serif for the studio + mountain cards
import { IntroClip, CLIP_MS } from './introclip.js';
import { StudioIdent, STUDIO_MS, STUDIO_LEAVE_MS } from './studioident.js';

const wait = (ms, sig) => new Promise((res) => {
  const t = setTimeout(res, ms);
  sig.onSkip.push(() => { clearTimeout(t); res(); });
});

export class Intro {
  constructor(audio) {
    this.audio = audio;
    this.el = document.getElementById('intro');
    this.sig = { skipped: false, onSkip: [] };
    this.scheduled = Promise.resolve(); // (play() replaces it: resolves once the timeline is laid out)
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
    s.style.animation = `introOut ${ms}ms ease forwards`; // (an animation: it wins over a scene's timed fade-in)
    await wait(ms, this.sig);
    s.remove();
  }

  // Oct 29, the user: "Icecold Studio takes very long to load". The game boots on the main thread while the intro
  // plays and blocks it for seconds, so timers (the clip's end, the studio's start) fired late. Now the whole
  // timeline is laid out as soon as the clip's first frame is up: the clip's fade-out and the studio's fade-in and
  // ident are CSS animations with delays (the compositor runs them on time) and the ice hit is on the audio clock.
  // `scheduled` resolves then; main.js holds the boot until it does (at most 2.5 s).
  async play() {
    const sig = this.sig;
    let sched;
    this.scheduled = new Promise((r) => (sched = r));
    this.el.hidden = false;
    addEventListener('keydown', this.skip, { once: true });
    this.el.addEventListener('pointerdown', this.skip, { once: true });
    const hint = document.createElement('div');
    hint.className = 'intro-skip';
    hint.textContent = 'Press any key to skip';
    this.el.appendChild(hint);

    let clipS = null, studioS = null, clip = null, ident = null, total = 0;
    try {
      // 1 -- the logo clip: the skier jumps, the camera whips back to the SKI LEGACY badge (src/ui/introclip.js)
      let at = 0; // s from now: the clip's end (its 0.5 s fade-out starts there)
      if (!sig.skipped) {
        clipS = this.scene('', 'scene-clip');
        clip = new IntroClip(clipS, this.audio);
        sig.onSkip.push(() => clip.stop());
        if (await clip.start()) at = CLIP_MS / 1000;
        clipS.style.setProperty('--out', `${at}s`);
        clipS.classList.add('timed');
      }
      // 2 -- Icecold Studio: the ICECOLD logotype freezes into existence (src/ui/studioident.js), from the clip's end
      if (!sig.skipped) {
        studioS = this.scene('', 'scene-studio timed');
        studioS.style.setProperty('--in', `${at + 0.5}s`);
        ident = new StudioIdent(studioS, this.audio);
        sig.onSkip.push(() => ident.stop());
        await ident.start(at + 0.5);
        total = (at + 0.5) * 1000 + STUDIO_MS;
      }
    } finally { sched(); }

    if (!sig.skipped) await wait(total, sig);
    clip?.stop(); clipS?.remove();
    if (studioS) await this.leave(studioS, STUDIO_LEAVE_MS);
    ident?.stop();

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
