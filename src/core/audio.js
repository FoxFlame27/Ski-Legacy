// Game audio: recorded CC0 sound effects (public/audio/sfx), a context-driven soundtrack
// (public/audio/music), and a stadium-PA announcer (public/audio/voice). Sources and licenses:
// public/audio/CREDITS.txt.
//
// Everything degrades gracefully: until (or unless) a recording has loaded, the old procedural
// version of that sound plays instead, so a missing / slow file never silences the game.
//
// Mix:  sfx bus ─┐
//       music bus ┼─> master (save.volume) -> glue compressor -> soft clipper -> speakers
//       voice bus ┘   (the announcer ducks the music while it speaks)

import { weatherFx } from '../world/sky.js'; // (storm wind: blizzard / föhn, Oct 30 2026)

const BASE = './audio/';

// one-shot / loop recordings (mono AAC). Loaded in this order: the intro's sounds first.
const SFX = [
  'whoosh', 'slam', 'chime', 'click', 'tick',
  'ski_carve', 'ski_scrape', 'ski_powder', 'wind_rush', 'wind_mountain', 'lift_hum',
  'step', 'land', 'bodyfall', 'bodyfall_heavy', 'snow_burst', 'swish', 'cash', 'error', 'buzzer', 'ding',
  'beep', 'beep_go', 'horn', 'crowd', 'crowd_roar', 'lift_clunk',
  // vehicle impacts, by what was hit (audio.impact / carCrash)
  'crash_car', 'metal_hit', 'glass', 'wood_crack', 'branches', 'debris', 'rock_hit', 'metal_clang', 'metal_scrape', 'snow_thump',
  'car_start', 'car_door', // (the engine loops sfx/eng_*.m4a load when you first drive that car: engineRec)
];

// sprites: [offset s, duration s] of each variation inside one file
const SPRITES = {
  step: [[0, 0.56], [0.68, 0.42], [1.22, 0.56], [1.9, 0.56], [2.58, 0.56], [3.26, 0.45], [3.83, 0.56], [4.51, 0.56], [5.19, 0.45], [6.06, 0.45], [6.63, 0.38], [7.13, 0.45], [7.7, 0.39], [8.21, 0.45], [8.78, 0.45], [9.35, 0.45], [9.92, 0.45], [10.49, 0.45], [11.06, 0.45], [11.63, 0.45]],
  land: [[0, 1.336], [1.456, 0.757], [2.333, 1.133]],
  crash_car: [[0, 3.7], [3.9, 2.3], [6.4, 2.15]],
  metal_hit: [[0, 1.6], [1.8, 1.4]],
  glass: [[0, 1.3], [1.5, 1.3], [3, 1.6]],
  wood_crack: [[0, 0.85], [1.05, 0.9], [2.15, 0.9], [3.25, 2.25]], // (the last: a long splintering, for big hits)
  branches: [[0, 1.4], [1.6, 1.3]],
  metal_clang: [[0, 1.55], [1.75, 0.6]],
  snow_thump: [[0, 0.65], [0.85, 0.65], [1.7, 0.7], [2.6, 0.65]],
  car_door: [[0, 1], [1.2, 0.8]], // open, close
};
// loudness trims per sprite variation (the takes differ in density)
const SPRITE_GAIN = { crash_car: [1, 0.95, 0.72], glass: [1.25, 0.85, 0.8], wood_crack: [0.85, 1, 1.2, 1.3], metal_hit: [0.85, 1.3] };

/** Announcer lines (public/audio/voice/<key>.m4a). Course keys are the course ids. */
export const ANNOUNCER_KEYS = [
  'three', 'two', 'one', 'go', 'pb', 'checkpoint', 'first', 'second', 'third', 'gold', 'silver', 'bronze',
  'wipeout', 'finish', 'welcome', 'alpine', 'icecanyon', 'bigair',
  // train PA (Wolkenspitzbahn): station chime, then the line in German and English
  'rail_dep_up', 'rail_dep_down', 'rail_next_wolkensee', 'rail_next_wolkenplatt', 'rail_next_village',
  'rail_arr_wolkensee', 'rail_arr_wolkenplatt', 'rail_arr_village',
];
const VOICE_ALIAS = {
  3: 'three', 2: 'two', 1: 'one', '3': 'three', '2': 'two', '1': 'one',
  personalbest: 'pb', 'personal-best': 'pb', place1: 'first', place2: 'second', place3: 'third',
  'legacy-world-downhill': 'alpine', downhill: 'alpine', 'ice-canyon': 'icecanyon', 'big-air': 'bigair', 'big-air-line': 'bigair',
};

// soundtrack: playlists per context (tracks with `once` play a single time, then the list moves on).
// MUSIC_SHUFFLE contexts pick a weighted-random track each time instead (never one of the last few played);
// `w` is a track's relative weight (default 1): the older kart-game tracks sit low so they come up only now and then
const MUSIC = {
  menu: [{ name: 'menu_hitech' }],
  freeride: [
    { name: 'ride_alive' }, { name: 'ride_afterparty' }, { name: 'ride_feelgood' },
    { name: 'ride_robot' }, { name: 'ride_feet' }, { name: 'ride_energy' },
    { name: 'ride_rocknroll', w: 0.2 }, { name: 'ride_city', w: 0.2 },
  ],
  race: [{ name: 'race_fire' }, { name: 'race_sweat' }, { name: 'race_road' }, { name: 'race_punk', w: 0.2 }],
  results: [{ name: 'results_win', once: true }, { name: 'results_loop' }],
  // a police chase (game/police.js -> chaseMusic): tense, driving tracks while you are wanted
  chase: [{ name: 'chase_run' }, { name: 'chase_fight' }, { name: 'chase_intense' }],
};
const MUSIC_SHUFFLE = new Set(['freeride', 'race', 'chase']);
// how loud each context sits under the game (x music volume)
const MUSIC_LEVEL = { menu: 0.85, freeride: 0.45, race: 0.7, results: 0.8, chase: 0.7 };
// per-track loudness trim (the files are matched to about -17 dB RMS; the menu track peaks early)
const TRACK_GAIN = { menu_hitech: 1.35 };
export const MUSIC_CONTEXTS = Object.keys(MUSIC);

// engine characters for the car you drive (audio.setCar profile): firing pulses per cycle, uneven-firing burble,
// pulse-to-pulse roughness, phase scatter, grit under load, brightness, exhaust boom (Hz), turbo, pops, level
const CAR_SOUND = {
  v8: { cyl: 8, uneven: 0.75, rough: 0.35, scatter: 0.6, grit: 1.6, bright: 0.9, boom: 85, turbo: 0.6, pops: 1, vol: 1.1 },
  gti: { cyl: 4, uneven: 0.3, rough: 0.4, scatter: 0.7, grit: 1.3, bright: 1.25, boom: 120, turbo: 1, pops: 0.8, vol: 1 },
  i6: { cyl: 6, uneven: 0.08, rough: 0.12, scatter: 0.4, grit: 0.5, bright: 0.85, boom: 100, turbo: 0.5, pops: 0, vol: 0.8 },
  i4: { cyl: 4, uneven: 0.18, rough: 0.2, scatter: 0.5, grit: 0.6, bright: 0.8, boom: 115, turbo: 0, pops: 0, vol: 0.8 },
  // the Huracán's V10 (even firing, a high shriek), the GR Yaris's turbo three (a lumpy thrum, a big turbo), the GLS's
  // V8 (smooth and hushed: no burble, no pops)
  v10: { cyl: 10, uneven: 0.25, rough: 0.25, scatter: 0.45, grit: 1.2, bright: 1.25, boom: 105, turbo: 0, pops: 1, vol: 1.1 },
  i3t: { cyl: 3, uneven: 0.4, rough: 0.4, scatter: 0.6, grit: 1.1, bright: 1.1, boom: 100, turbo: 1, pops: 0.6, vol: 0.95 },
  v8s: { cyl: 8, uneven: 0.35, rough: 0.12, scatter: 0.35, grit: 0.6, bright: 0.75, boom: 80, turbo: 0.4, pops: 0, vol: 0.85 },
};
// recorded engines (CREDITS.txt): per profile, the rpm each loop sfx/eng_<profile>_<i>.m4a was recorded at (a steady
// stretch of a real engine: idle, then held revs / dyno pulls). Played as loops crossfaded and pitched by the revs.
// v8: a V8 idling and holding revs; gti: a turbo four on a dyno; i6: an inline six idling (+ the dyno four, lower and
// smoother, for the upper revs); i4: a Dacia / Renault Duster idling and revving. The Tesla keeps its synthesized whine.
const ENGINE_REC = { v8: [960, 3330], gti: [885, 3150, 4860, 6180], i6: [720, 2960, 4570], i4: [750, 3630] };
// profiles with no recording of their own: another's loops, played as if recorded at these rpm (lower: pitched up).
// v10: the V8's, a fifth higher (a V10 fires 10 times per two turns: the V8's note at 4/5 of the revs); i3t: the turbo
// four's, a little lower (three cylinders); v8s: the V8's as they are (the quieter character: CAR_SOUND)
const ENGINE_ALIAS = { v10: ['v8', 0.8], i3t: ['gti', 1.12], v8s: ['v8', 1] };
const ENGINE_REC_LEVEL = 2;
const START_CATCH = 1.96; // s into sfx/car_start.m4a where the engine catches (drive.js cranks for 0.85 s)
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export class Audio {
  constructor() {
    this.ctx = null;
    this.volume = 0.8;
    this.musicVolume = 0.7;
    this.sfxVolume = 1;
    this.ski = { edge: 0, skid: 0, air: false, tuck: false, ice: 0 }; // detail from the player (setSki)
    this.buf = {};          // decoded recordings by name
    this.voice = {};        // decoded announcer lines by key
    this.loops = {};        // running sample loops (carve, scrape, ...)
    this.musicCtx = null;   // 'menu' | 'freeride' | 'race' | 'results' | 'chase' | null
    this.deck = null;       // the playing music track
    this.autoAnnounce = true; // crash in a race -> "Wipeout!"
    this.failed = new Set();
  }

  // Per-frame skiing detail from the player: edge angle (rad), skid 0..1, airborne, tuck, ice 0..1,
  // optional powder 0..1 (deep / off-piste snow).
  setSki(s) { this.ski = s; }

  /** Esc / pause menu: every sound stops and the music holds its place; it all carries on on resume. */
  setPaused(p) {
    if (this.paused === p) return;
    this.paused = p;
    if (!this.ctx) return;
    if (p) { this.ctx.suspend(); this.deck?.el?.pause(); }
    else { this.ctx.resume(); if (this.deck?.el?.paused && !this.deck.stopping) this.deck.el.play().catch(() => {}); }
  }

  init() {
    if (this.ctx) {
      if (this.paused) return;
      this.ctx.resume();
      // a track that the browser refused to start before the first user gesture
      if (this.deck?.el?.paused && !this.deck.stopping) this.deck.el.play().catch(() => {});
      return;
    }
    const ctx = (this.ctx = new (window.AudioContext || window.webkitAudioContext)());
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    // glue: a gentle bus compressor, then a soft clipper so the sum never hard-clips
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12; comp.knee.value = 10; comp.ratio.value = 6; comp.attack.value = 0.004; comp.release.value = 0.22;
    const clip = ctx.createWaveShaper();
    const n = 2048, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1, a = Math.abs(x); curve[i] = a < 0.8 ? x : Math.sign(x) * (0.8 + 0.2 * Math.tanh((a - 0.8) / 0.2)); }
    clip.curve = curve; clip.oversample = '2x';
    this.master.connect(comp).connect(clip).connect(ctx.destination);

    this.sfx = ctx.createGain(); this.sfx.gain.value = this.sfxVolume; this.sfx.connect(this.master);
    this.musicBus = ctx.createGain(); this.musicBus.gain.value = this.musicVolume; this.musicBus.connect(this.master);
    this.duck = ctx.createGain(); // announcer ducking, then a little under a near siren (setSiren)
    this.sirenDuck = ctx.createGain(); this.duck.connect(this.sirenDuck).connect(this.musicBus);
    this.voiceBus = ctx.createGain(); this.voiceBus.gain.value = 0.95; this.voiceBus.connect(this.master);

    // shared noise buffers (procedural fallbacks + helicopter)
    const len = ctx.sampleRate * 2;
    const white = ctx.createBuffer(1, len, ctx.sampleRate);
    const brown = ctx.createBuffer(1, len, ctx.sampleRate);
    const w = white.getChannelData(0), b = brown.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      w[i] = Math.random() * 2 - 1;
      last = (last + 0.02 * w[i]) / 1.02;
      b[i] = last * 3.5;
    }
    this.white = white; this.brown = brown;

    // procedural loops: used only until the recorded loops have loaded
    const loop = (buf, type, freq, q) => {
      const src = ctx.createBufferSource();
      src.buffer = buf; src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = type; f.frequency.value = freq; f.Q.value = q;
      const g = ctx.createGain(); g.gain.value = 0;
      src.connect(f).connect(g).connect(this.sfx);
      src.start();
      return { f, g };
    };
    this.wind = loop(brown, 'lowpass', 500, 0.7);
    this.whistle = loop(white, 'bandpass', 1400, 8);
    this.carve = loop(white, 'bandpass', 2600, 0.9);
    this.scrape = loop(white, 'highpass', 3500, 0.7);
    this.hum = loop(brown, 'lowpass', 120, 1.5);
    this.ambient = loop(brown, 'bandpass', 300, 0.5);

    // browsers start the context suspended until the first click / key press: unlock on it
    const unlock = () => {
      if (this.paused) return;
      if (ctx.state !== 'running') ctx.resume();
      if (this.deck?.el?.paused && !this.deck.stopping) this.deck.el.play().catch(() => {});
      if (ctx.state === 'running' && !this.deck?.el?.paused) { removeEventListener('pointerdown', unlock, true); removeEventListener('keydown', unlock, true); }
    };
    addEventListener('pointerdown', unlock, true);
    addEventListener('keydown', unlock, true);

    this.loadAll();
    setTimeout(() => { try { this.prerenderHorns(); } catch { /* (the recorded horn then) */ } }, 1200); // (the air horns: horn())
    if (this.musicCtx) { const c = this.musicCtx; this.musicCtx = null; this.music(c); }
  }

  // ---------------------------------------------------------------- loading
  async fetchBuffer(path) {
    const r = await fetch(BASE + path);
    if (!r.ok) throw new Error(`${r.status} ${path}`);
    const data = await r.arrayBuffer();
    return await new Promise((res, rej) => {
      const p = this.ctx.decodeAudioData(data, res, rej); // callback form: works everywhere
      if (p && p.catch) p.catch(rej);
    });
  }

  async loadAll() {
    // intro sounds first, then the rest a few at a time (keeps the boot network / CPU smooth)
    const queue = [...SFX];
    const worker = async () => {
      while (queue.length) {
        const name = queue.shift();
        try {
          this.buf[name] = await this.fetchBuffer(`sfx/${name}.m4a`);
          this.onLoaded(name);
        } catch (e) {
          this.failed.add(name);
          console.warn('[audio] could not load', name, '- using the synthesized fallback', e?.message || e);
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    for (const key of ANNOUNCER_KEYS) {
      try { this.voice[key] = await this.fetchBuffer(`voice/${key}.m4a`); } catch (e) { console.warn('[audio] announcer line missing', key, e?.message || e); }
    }
  }

  onLoaded(name) {
    const L = { ski_carve: 'carve', ski_scrape: 'scrape', ski_powder: 'powder', wind_rush: 'rush', wind_mountain: 'mountain', lift_hum: 'hum' }[name];
    if (!L) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.loopify(this.buf[name], 0.35);
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = { carve: 'lowpass', scrape: 'highpass', powder: 'lowpass', rush: 'lowpass', mountain: 'highpass', hum: 'lowpass' }[L];
    f.frequency.value = { carve: 6000, scrape: 300, powder: 1500, rush: 1200, mountain: 90, hum: 2400 }[L];
    f.Q.value = 0.6;
    const g = ctx.createGain(); g.gain.value = 0;
    src.connect(f).connect(g).connect(this.sfx);
    src.start(0, Math.random() * src.buffer.duration * 0.9);
    this.loops[L] = { src, f, g };
    delete this.buf[name]; // the loop keeps its own (crossfaded) copy
  }

  // Make a seamless loop: drop the codec's edge padding, then crossfade the tail into the head.
  loopify(b, xf = 0.3) {
    const sr = b.sampleRate, edge = Math.round(0.06 * sr), X = Math.round(xf * sr);
    const n = b.length - 2 * edge, out = this.ctx.createBuffer(b.numberOfChannels, n - X, sr);
    for (let c = 0; c < b.numberOfChannels; c++) {
      const a = b.getChannelData(c).subarray(edge, edge + n), o = out.getChannelData(c);
      for (let i = 0; i < n - X; i++) o[i] = a[i];
      for (let i = 0; i < X; i++) { const t = i / X; o[i] = a[i] * Math.sin(t * Math.PI / 2) + a[n - X + i] * Math.cos(t * Math.PI / 2); }
    }
    return out;
  }

  // ---------------------------------------------------------------- continuous mix (every frame)
  setState({ speed = 0, grounded = true, sideslip = 0, skiing = false, riding = false, altitude = 0, snow = 0, indoor = false }) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const k = 0.12;
    const sk = this.ski;
    const L = this.loops;
    const wind = Math.min(1, speed / 30);
    // wind: louder with the head in the airflow (tuck) and in the air
    const gust = skiing ? (sk.tuck ? 1.12 : 1) * (sk.air ? 1.2 : 1) : 1;
    const on = skiing && grounded ? 1 : 0;
    const edge = Math.min(1, (sk.edge || 0) / 0.9);
    const ice = sk.ice || 0;
    const slip = clamp(sideslip, 0, 1.5);

    // --- wind rushing past (speed)
    if (L.rush) {
      L.rush.g.gain.setTargetAtTime(indoor ? 0 : (0.03 + wind * wind * 1.25) * gust, t, k);
      L.rush.f.frequency.setTargetAtTime(500 + wind * wind * 7000, t, k);
      L.rush.src.playbackRate.setTargetAtTime(0.85 + wind * 0.3, t, 0.3);
      this.wind.g.gain.setTargetAtTime(0, t, k); this.whistle.g.gain.setTargetAtTime(0, t, k);
    } else {
      this.wind.g.gain.setTargetAtTime((0.05 + wind * wind * 0.55) * gust + snow * 0.08 + altitude * 0.00004 + weatherFx.wind * 0.1 * (indoor ? 0 : 1), t, k); // (+ a blizzard's / föhn's storm wind, Oct 30 2026)
      this.wind.f.frequency.setTargetAtTime(300 + wind * 1400, t, k);
      this.whistle.g.gain.setTargetAtTime(Math.max(0, wind - 0.4) * 0.05 * gust, t, k);
      this.whistle.f.frequency.setTargetAtTime(900 + wind * 1600, t, k);
    }
    // --- mountain ambience: always there outdoors, more in snowfall and up high
    if (L.mountain) {
      // (Oct 30 2026, the user: "wind audio louder in blizzard/föhn": weatherFx.wind, sky.js)
      L.mountain.g.gain.setTargetAtTime(indoor ? 0 : clamp(0.12 + snow * 0.3 + altitude * 0.0001 + weatherFx.wind * 0.16, 0, 0.6), t, 0.6);
      this.ambient.g.gain.setTargetAtTime(0, t, 0.5);
    } else this.ambient.g.gain.setTargetAtTime(indoor ? 0 : 0.03, t, 0.5);

    // --- carving: snow hiss that grows louder and brighter as the edges bite
    const carveLv = on * Math.min(1.2, speed * 0.06) * (0.55 + edge * 0.45 + slip * 0.35) * (1 - ice * 0.35);
    if (L.carve) {
      L.carve.g.gain.setTargetAtTime(carveLv, t, k * 0.5);
      L.carve.f.frequency.setTargetAtTime(2200 + speed * 220 + edge * 3000 + ice * 3000, t, k);
      L.carve.src.playbackRate.setTargetAtTime(0.8 + Math.min(1, speed / 28) * 0.35 + edge * 0.05, t, k);
      this.carve.g.gain.setTargetAtTime(0, t, k);
    } else {
      this.carve.g.gain.setTargetAtTime(on * Math.min(0.32, speed * 0.016) * (0.55 + edge * 0.5 + sideslip * 0.5), t, k * 0.5);
      this.carve.f.frequency.setTargetAtTime(1500 + speed * 60 + edge * 900, t, k);
    }
    // --- skidding / braking / snowplough scrape: harsher and higher on ice
    const scrapeLv = on * Math.min(1.4, Math.pow(slip, 1.3) * speed * 0.12) * (1 + ice * 0.4);
    if (L.scrape) {
      L.scrape.g.gain.setTargetAtTime(scrapeLv, t, k * 0.4);
      L.scrape.f.frequency.setTargetAtTime(250 + ice * 1800, t, k);
      L.scrape.src.playbackRate.setTargetAtTime(0.85 + Math.min(1, speed / 25) * 0.25 + ice * 0.25, t, k);
      this.scrape.g.gain.setTargetAtTime(0, t, k);
    } else {
      this.scrape.g.gain.setTargetAtTime(on * Math.min(0.32, sideslip * speed * 0.04) * (1 + ice * 0.6), t, k * 0.5);
      this.scrape.f.frequency.setTargetAtTime(3200 + ice * 2600, t, k);
    }
    // --- powder: soft muffled body under the skis (always a little, full in deep snow)
    if (L.powder) {
      const deep = clamp(sk.powder ?? 0, 0, 1);
      L.powder.g.gain.setTargetAtTime(on * Math.min(1, speed * 0.04) * (0.18 + deep * 0.9) * (1 - ice), t, k);
      L.powder.f.frequency.setTargetAtTime(900 + speed * 80, t, k);
    }
    // --- lift / gondola motor and cable
    if (L.hum) {
      L.hum.g.gain.setTargetAtTime(riding ? 0.55 : 0, t, 0.5);
      this.hum.g.gain.setTargetAtTime(0, t, 0.4);
    } else this.hum.g.gain.setTargetAtTime(riding ? 0.25 : 0, t, 0.4);
  }

  // ---------------------------------------------------------------- procedural voices (fallbacks)
  tone(freq, dur, type = 'sine', vol = 0.3, slide = 0, delay = 0) {
    const ctx = this.ctx, t = ctx.currentTime + delay;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.sfx);
    o.start(t); o.stop(t + dur + 0.05);
  }

  burst(dur, freq, vol = 0.4, type = 'lowpass') {
    const ctx = this.ctx, t = ctx.currentTime;
    const s = ctx.createBufferSource(); s.buffer = this.white;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq;
    const g = ctx.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    s.connect(f).connect(g).connect(this.sfx);
    s.start(t, Math.random()); s.stop(t + dur + 0.05);
  }

  // filtered-noise sweep (whooshes, icy shimmer)
  sweep(dur, f0, f1, vol) {
    const ctx = this.ctx, t = ctx.currentTime;
    const s = ctx.createBufferSource(); s.buffer = this.white;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 1.2;
    f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + dur * 0.6); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(this.sfx);
    s.start(t, Math.random()); s.stop(t + dur + 0.05);
  }

  // ---------------------------------------------------------------- recorded one-shots
  /**
   * Play a recording. Returns false when it isn't loaded (the caller then uses the fallback).
   * @param {string} name
   * @param {{vol?: number, rate?: number, delay?: number, offset?: number, dur?: number, lp?: number, hp?: number, sprite?: boolean}} [o]
   */
  shot(name, { vol = 1, rate = 1, delay = 0, offset = 0, dur, lp, hp, sprite = false, out } = {}) {
    const b = this.buf[name];
    if (!b || vol <= 0) return !!b;
    const ctx = this.ctx, t = ctx.currentTime + delay;
    // sprite: true = a random variation, or an array of the variations to pick from
    if (sprite) {
      const s = SPRITES[name], pick = Array.isArray(sprite) ? sprite : null;
      const i = pick ? pick[(Math.random() * pick.length) | 0] : (Math.random() * s.length) | 0;
      const [o, d] = s[Math.min(i, s.length - 1)]; offset = o; dur = d + 0.06; vol *= SPRITE_GAIN[name]?.[i] ?? 1;
    }
    const s = ctx.createBufferSource(); s.buffer = b; s.playbackRate.value = rate;
    let node = s;
    if (lp) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp; node = node.connect(f); }
    if (hp) { const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hp; node = node.connect(f); }
    const g = ctx.createGain(); g.gain.value = vol;
    node.connect(g).connect(out || this.sfx);
    if (dur) {
      const end = t + dur / rate;
      g.gain.setValueAtTime(vol, Math.max(t, end - 0.03));
      g.gain.linearRampToValueAtTime(0, end);
      s.start(t, offset, dur);
    } else s.start(t, offset);
    return true;
  }

  setVolume(v) { this.volume = v; if (this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02); }
  /** Music volume 0..1, separate from the master / SFX volume. */
  setMusicVolume(v) { this.musicVolume = clamp(+v || 0, 0, 1); if (this.musicBus) this.musicBus.gain.setTargetAtTime(this.musicVolume, this.ctx.currentTime, 0.05); }
  /** Sound-effects volume 0..1 (everything but music and announcer). */
  setSfxVolume(v) { this.sfxVolume = clamp(+v || 0, 0, 1); if (this.sfx) this.sfx.gain.setTargetAtTime(this.sfxVolume, this.ctx.currentTime, 0.05); }

  // ---------------------------------------------------------------- helicopter (src/game/heli.js): turbine whine + rotor blade slap
  // Built the first time a helicopter is heard. The rotor is brown noise chopped by a pulse train at the
  // blade-passing rate (the "wop-wop"), plus its low thump; the turbine a rising whine and a hiss.
  heliNodes() {
    const ctx = this.ctx;
    const bus = ctx.createGain(); bus.gain.value = 0;
    const air = ctx.createBiquadFilter(); air.type = 'lowpass'; air.frequency.value = 14000; air.Q.value = 0.4; // air absorption with distance
    bus.connect(air).connect(this.sfx);
    // pulse train: equal cosine harmonics -> a sharp periodic slap
    const re = new Float32Array(24), im = new Float32Array(24);
    for (let k = 1; k < 24; k++) re[k] = Math.pow(0.93, k);
    const pulse = ctx.createOscillator();
    pulse.setPeriodicWave(ctx.createPeriodicWave(re, im));
    pulse.frequency.value = 0;
    // chopped noise: the gain swings with the pulse
    const src = ctx.createBufferSource(); src.buffer = this.brown; src.loop = true;
    const chopF = ctx.createBiquadFilter(); chopF.type = 'lowpass'; chopF.frequency.value = 500; chopF.Q.value = 0.8;
    const chop = ctx.createGain(); chop.gain.value = 0;
    const depth = ctx.createGain(); depth.gain.value = 0;
    src.connect(chopF).connect(chop).connect(bus);
    pulse.connect(depth).connect(chop.gain);
    // thump: the pulse itself through a low-pass (felt more than heard)
    const thumpF = ctx.createBiquadFilter(); thumpF.type = 'lowpass'; thumpF.frequency.value = 160; thumpF.Q.value = 0.9;
    const thump = ctx.createGain(); thump.gain.value = 0;
    pulse.connect(thumpF).connect(thump).connect(bus);
    // turbine whine (two detuned tones) and the intake / exhaust hiss
    const wh1 = ctx.createOscillator(); wh1.type = 'sine';
    const wh2 = ctx.createOscillator(); wh2.type = 'triangle';
    const whine = ctx.createGain(); whine.gain.value = 0;
    wh1.connect(whine); wh2.connect(whine); whine.connect(bus);
    const hsrc = ctx.createBufferSource(); hsrc.buffer = this.white; hsrc.loop = true;
    const hissF = ctx.createBiquadFilter(); hissF.type = 'bandpass'; hissF.frequency.value = 1500; hissF.Q.value = 0.6;
    const hiss = ctx.createGain(); hiss.gain.value = 0;
    hsrc.connect(hissF).connect(hiss).connect(bus);
    for (const n of [pulse, src, wh1, wh2, hsrc]) n.start();
    return { bus, air, pulse, chopF, chop, depth, thump, wh1, wh2, whine, hissF, hiss };
  }

  /**
   * Helicopter mix, every frame while one exists.
   * @param {object} s
   * @param {number} s.rpm      rotor / turbine speed 0..1 (spool-up and shut-down sweep the pitch)
   * @param {number} [s.load]   0..1 collective (climbing, hard manoeuvres): deeper, harder blade slap
   * @param {number} [s.speed]  airspeed (m/s): the slap sharpens and rises a little at speed
   * @param {number} [s.dist]   distance to the listener (m)
   * @param {number} [s.doppler] pitch factor from the closing speed (1 = none)
   * @param {boolean} [s.inside] you are flying it (closer, fuller, a little muffled by the cabin)
   * @param {boolean} [s.paused]
   */
  setHeli({ rpm = 0, load = 0, speed = 0, dist = 0, doppler = 1, inside = false, paused = false } = {}) {
    if (!this.ctx) return;
    if (!this.heli) { if (rpm < 0.01) return; this.heli = this.heliNodes(); }
    const H = this.heli, t = this.ctx.currentTime, k = 0.06;
    const near = inside ? 1 : 1 / (1 + Math.pow(dist / 45, 1.2));
    const on = paused ? 0 : 1;
    const r = Math.max(0, rpm), sp = Math.min(1, speed / 60);
    const pitch = doppler * (1 + sp * 0.06);
    H.bus.gain.setTargetAtTime(on * near * (inside ? 1.1 : 1.3) * Math.min(1, r * 3), t, paused ? 0.05 : 0.12);
    H.air.frequency.setTargetAtTime(inside ? 5200 : 14000 / (1 + dist / 140), t, k);
    // rotor: 4 blades at 6.4 rev/s at full speed
    const bpf = 4 * 6.4 * r * pitch;
    H.pulse.frequency.setTargetAtTime(Math.max(0.01, bpf), t, k);
    const slap = r * r * (0.55 + 0.45 * load + 0.25 * sp);
    H.chop.gain.setTargetAtTime(0.18 * slap, t, k);
    H.depth.gain.setTargetAtTime(0.32 * slap, t, k);
    H.chopF.frequency.setTargetAtTime((380 + 520 * load + 400 * sp) * pitch, t, k);
    H.thump.gain.setTargetAtTime(0.5 * slap * (inside ? 1.2 : 1), t, k);
    // turbine: a starter whine that climbs to a steady scream
    const n1 = Math.pow(r, 0.8);
    H.wh1.frequency.setTargetAtTime((260 + 3900 * n1) * pitch, t, k);
    H.wh2.frequency.setTargetAtTime((190 + 2050 * n1) * pitch, t, k);
    H.whine.gain.setTargetAtTime((0.008 + 0.02 * n1) * (inside ? 1.3 : 0.8) * Math.min(1, r * 5), t, k);
    H.hissF.frequency.setTargetAtTime((700 + 1600 * n1) * pitch, t, k);
    H.hiss.gain.setTargetAtTime(0.07 * n1 * (0.7 + 0.3 * load), t, k);
  }

  // ---------------------------------------------------------------- snowmobile (src/game/snowmobile.js): a two-stroke engine
  // Built the first time you drive one: a buzzy sawtooth at the firing rate with a square sub-octave, through a
  // low-pass that opens with the throttle, a little rasp (band-passed noise) and the track's rumble on the snow.
  sledNodes() {
    const ctx = this.ctx;
    const bus = ctx.createGain(); bus.gain.value = 0;
    bus.connect(this.sfx);
    const o1 = ctx.createOscillator(); o1.type = 'sawtooth';
    const o2 = ctx.createOscillator(); o2.type = 'square';
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 600; lp.Q.value = 2.2;
    const eng = ctx.createGain(); eng.gain.value = 0;
    const sub = ctx.createGain(); sub.gain.value = 0.35;
    o1.connect(lp); o2.connect(sub).connect(lp); lp.connect(eng).connect(bus);
    const rs = ctx.createBufferSource(); rs.buffer = this.white; rs.loop = true;
    const rf = ctx.createBiquadFilter(); rf.type = 'bandpass'; rf.frequency.value = 900; rf.Q.value = 1.4;
    const rasp = ctx.createGain(); rasp.gain.value = 0;
    rs.connect(rf).connect(rasp).connect(bus);
    const ts = ctx.createBufferSource(); ts.buffer = this.brown; ts.loop = true;
    const tf = ctx.createBiquadFilter(); tf.type = 'lowpass'; tf.frequency.value = 260;
    const track = ctx.createGain(); track.gain.value = 0;
    ts.connect(tf).connect(track).connect(bus);
    for (const n of [o1, o2, rs, ts]) n.start();
    return { bus, o1, o2, lp, eng, rf, rasp, tf, track };
  }

  /** Snowmobile engine, every frame while you drive (on: false fades it out). rpm 0..1, load 0..1 (throttle), speed m/s. */
  setSled({ on = false, rpm = 0, load = 0, speed = 0, paused = false } = {}) {
    if (!this.ctx) return;
    if (!this.sled) { if (!on) return; this.sled = this.sledNodes(); }
    const N = this.sled, t = this.ctx.currentTime, k = 0.05;
    const live = on && !paused ? 1 : 0;
    N.bus.gain.setTargetAtTime(live * 0.55, t, on ? 0.08 : 0.25);
    const f = 38 + 150 * rpm;
    N.o1.frequency.setTargetAtTime(f, t, k);
    N.o2.frequency.setTargetAtTime(f * 0.5, t, k);
    N.lp.frequency.setTargetAtTime(380 + 2400 * rpm * (0.45 + 0.55 * load), t, k);
    N.eng.gain.setTargetAtTime(0.09 + 0.12 * load, t, k);
    N.rf.frequency.setTargetAtTime(700 + 1600 * rpm, t, k);
    N.rasp.gain.setTargetAtTime(0.02 + 0.05 * load * rpm, t, k);
    N.track.gain.setTargetAtTime(Math.min(0.35, speed / 30) * 0.5, t, k);
    N.tf.frequency.setTargetAtTime(160 + speed * 9, t, k);
  }

  // ---------------------------------------------------------------- ambulance siren (game/heli/rescue.js): European two-tone
  // "tatü-tata": two horn tones a fourth apart (440 / 587 Hz), 0.6 s each, a square + saw through a horn-like band-pass;
  // softer and duller with distance, its pitch shifted by the closing speed (doppler).
  sirenNodes() {
    const ctx = this.ctx;
    const bus = ctx.createGain(); bus.gain.value = 0;
    const air = ctx.createBiquadFilter(); air.type = 'lowpass'; air.frequency.value = 9000;
    bus.connect(air).connect(this.sfx);
    const o1 = ctx.createOscillator(); o1.type = 'square';
    const o2 = ctx.createOscillator(); o2.type = 'sawtooth';
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1100; bp.Q.value = 0.7;
    const g1 = ctx.createGain(); g1.gain.value = 0.05; const g2 = ctx.createGain(); g2.gain.value = 0.04;
    o1.connect(g1).connect(bp); o2.connect(g2).connect(bp); bp.connect(bus);
    o1.start(); o2.start();
    return { bus, air, o1, o2 };
  }

  /** Siren, every frame while it sounds (on: false fades it out at once). dist (m) from the listener, doppler pitch factor. */
  setSiren({ on = false, dist = 10, doppler = 1, paused = false } = {}) {
    if (!this.ctx) return;
    if (!this.siren) { if (!on) return; this.siren = this.sirenNodes(); }
    const N = this.siren, t = this.ctx.currentTime;
    const live = on && !paused ? 1 : 0;
    const lv = live * 0.9 / (1 + Math.pow(dist / 35, 1.3));
    N.bus.gain.setTargetAtTime(lv, t, on ? 0.05 : 0.04);
    this.sirenDuck?.gain.setTargetAtTime(1 - 0.3 * clamp(lv / 0.5, 0, 1), t, 0.3); // the music ~3 dB down under a close siren
    N.air.frequency.setTargetAtTime(9000 / (1 + dist / 90), t, 0.1);
    const f = (Math.floor(t / 0.6) % 2 ? 587 : 440) * doppler;
    N.o1.frequency.setTargetAtTime(f, t, 0.012);
    N.o2.frequency.setTargetAtTime(f * 1.003, t, 0.012);
  }

  // ---------------------------------------------------------------- air horns: the bus and the trains (Oct 30 2026, the user:
  // "make the horn of the bus and train super realistic like in real life"). Both are pneumatic: compressed air
  // through a diaphragm (a buzzing pulse, rich in harmonics) into flared trumpets whose bells pick out a few
  // resonances (formants). So each trumpet is a pulse-like wave (HORN_WAVE: harmonics of a narrow pulse, a
  // little mis-shapen), two copies a few cents apart (the beating of two real trumpets), driven slightly into
  // saturation (the brassy blare), then through the bell's band-passes. The valve: the pitch scoops up from flat as
  // the pressure builds (with a hiss of air), sags a touch while the reservoir drains, and drops as it closes, a
  // "pfff" of exhausting air after it. Rendered ONCE per pattern with an OfflineAudioContext (prerenderHorns, a
  // second after init) and played as buffers: no graph per honk beyond source -> air low-pass -> level / echo send.
  //  - bus: a coach's two-tone air horn (Setra / Mercedes Travego / MAN Lion's style): two trumpets together, a
  //    deep, slightly sour major third (~218 / 279 Hz), a hard quick blare.
  //  - train: an Alpine loco's Typhon (ÖBB Taurus / SBB Re 460 style): a strong, slightly detuned chord (F#-A-C#,
  //    ~370 / 440 / 556 Hz), a slower valve with more air, subtle beating in the sustain, a long airy release.
  // Patterns: bus (one blare), bus2 (an impatient short + long), bus_short (a tap: a greeting), train (long-short,
  // the "Achtung" at stations and crossings), train_long (one long warning blast: you are on the line close ahead),
  // train_short (a single toot: a stopped train nudging you off the track).
  hornSpecs() {
    const bus = {
      tones: [{ f: 218, g: 1 }, { f: 279, g: 0.85 }], det: 6, duty: 0.27, tilt: 0.75,
      formants: [[520, 1.4, 1], [1150, 2, 0.8], [2400, 2.6, 0.45], [3600, 3, 0.18]], body: 0.35, hp: 130, lp: 7500, drive: 2.4,
      scoop: 0.07, rise: 0.055, sag: 0.012, drop: 0.11, atk: 0.022, rel: 0.085, flutter: [9.5, 0.05],
      hiss: [0.3, 3800, 0.035], leak: 0.025, pfff: [0.28, 0.09],
    };
    const train = {
      tones: [{ f: 370 * 1.003, g: 0.5 }, { f: 440 * 0.996, g: 1 }, { f: 556, g: 0.9 }], det: 4, duty: 0.36, tilt: 0.85,
      formants: [[720, 1.2, 1], [1450, 1.8, 0.7], [2900, 2.4, 0.35]], body: 0.4, hp: 210, lp: 8500, drive: 1.9,
      scoop: 0.12, rise: 0.11, sag: 0.008, drop: 0.15, atk: 0.05, rel: 0.16, flutter: [6, 0.035],
      hiss: [0.4, 3000, 0.06], leak: 0.03, pfff: [0.34, 0.15],
    };
    return {
      bus: { ...bus, blasts: [[0.02, 0.85]] },
      bus2: { ...bus, blasts: [[0.02, 0.22], [0.37, 0.7]] },
      bus_short: { ...bus, blasts: [[0.02, 0.3]] },
      train: { ...train, blasts: [[0.03, 1.5], [1.85, 0.5]] },
      train_long: { ...train, blasts: [[0.03, 2.4]] },
      train_short: { ...train, blasts: [[0.03, 0.45]] },
    };
  }
  /** Render every horn pattern once (offline, in parallel); this.hornBufs fills as each finishes. */
  prerenderHorns() {
    if (this.hornBufs || !this.ctx) return;
    this.hornBufs = {};
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OAC) return;
    for (const [k, P] of Object.entries(this.hornSpecs())) {
      try { this.renderHorn(OAC, P).then((b) => { this.hornBufs[k] = b; }).catch((e) => console.warn('[audio] horn render', k, e?.message || e)); }
      catch (e) { console.warn('[audio] horn render', k, e?.message || e); }
    }
  }
  renderHorn(OAC, P) {
    const sr = this.ctx.sampleRate, [lt, ld] = P.blasts[P.blasts.length - 1], len = lt + ld + P.rel + 0.5;
    const oc = new OAC(1, Math.ceil(len * sr), sr);
    // the diaphragm's buzz: harmonics of a narrow pulse (its nulls give the honk), tilted, a little uneven
    const N = 48, re = new Float32Array(N), im = new Float32Array(N);
    for (let k = 1; k < N; k++) im[k] = (Math.abs(Math.sin(Math.PI * k * P.duty)) + 0.12) / Math.pow(k, P.tilt) * (1 + 0.15 * Math.sin(k * 2.3));
    const wave = oc.createPeriodicWave(re, im);
    // saturation (asymmetric: the blare) -> bell resonances + a little of the raw buzz -> high-pass / low-pass
    const mix = oc.createGain(), drive = oc.createWaveShaper(), curve = new Float32Array(1024), o = 0.2, dv = P.drive;
    for (let i = 0; i < 1024; i++) { const x = (i / 1023) * 2 - 1; curve[i] = (Math.tanh(dv * (x + o)) - Math.tanh(dv * o)) / Math.tanh(dv); }
    drive.curve = curve; drive.oversample = '4x';
    const hp = oc.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = P.hp; hp.Q.value = 0.8;
    const lp = oc.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = P.lp; lp.Q.value = 0.5;
    const out = oc.createGain(); out.gain.value = 1; hp.connect(lp).connect(out).connect(oc.destination);
    mix.connect(drive);
    const body = oc.createGain(); body.gain.value = P.body; drive.connect(body).connect(hp);
    for (const [f, q, g] of P.formants) {
      const bp = oc.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = q;
      const gg = oc.createGain(); gg.gain.value = g * 1.6; drive.connect(bp).connect(gg).connect(hp);
    }
    // air: one noise buffer for the hiss, the leak and the exhaust
    const nb = oc.createBuffer(1, Math.ceil(len * sr), sr), nd = nb.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    const noise = (type, f, q) => {
      const s = oc.createBufferSource(); s.buffer = nb;
      const fl = oc.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q;
      const g = oc.createGain(); g.gain.value = 0; s.connect(fl).connect(g).connect(out); s.start(0);
      return g.gain;
    };
    const hiss = noise('bandpass', P.hiss[1], 0.7), leak = noise('bandpass', 5200, 0.9), pf = noise('highpass', 1300, 0.6);
    const tones = P.tones.reduce((s, x) => s + x.g, 0);
    for (const [t0, d] of P.blasts) {
      const t1 = t0 + d, end = t1 + P.rel;
      // the valve's envelope: a fast rise with a little overshoot, the sustain sagging with the pressure, a short close
      const env = oc.createGain(), e = env.gain;
      e.setValueAtTime(0, t0); e.linearRampToValueAtTime(1.12, t0 + P.atk); e.setTargetAtTime(1, t0 + P.atk, 0.05);
      e.setValueAtTime(1, Math.max(t0 + P.atk + 0.06, t1 - 0.05)); e.linearRampToValueAtTime(0.9, t1);
      e.setTargetAtTime(0, t1, P.rel / 3.5);
      // flutter: the diaphragm's unsteadiness (a slow wobble of level), in series so it is silent between blasts
      const fl = oc.createGain(); fl.gain.value = 1;
      const lfo = oc.createOscillator(); lfo.frequency.value = P.flutter[0];
      const ld2 = oc.createGain(); ld2.gain.value = P.flutter[1]; lfo.connect(ld2).connect(fl.gain);
      lfo.start(t0); lfo.stop(end + 0.05);
      fl.connect(env).connect(mix);
      for (const T of P.tones) for (const side of [-1, 1]) {
        const osc = oc.createOscillator(); osc.setPeriodicWave(wave);
        const fq = osc.frequency, f = T.f * (1 + side * 0.0004);
        fq.setValueAtTime(f * (1 - P.scoop), t0);
        fq.exponentialRampToValueAtTime(f, t0 + P.rise);
        fq.linearRampToValueAtTime(f * (1 - P.sag), t1);
        fq.exponentialRampToValueAtTime(f * (1 - P.drop), end);
        osc.detune.value = side * P.det + (Math.random() - 0.5) * 2;
        const og = oc.createGain(); og.gain.value = (T.g / tones) * 0.55;
        osc.connect(og).connect(fl); osc.start(t0); osc.stop(end + 0.05);
      }
      // the hiss as the valve cracks open, the air leaking past the diaphragm, the exhaust "pfff" as it shuts
      hiss.setValueAtTime(0, t0); hiss.linearRampToValueAtTime(P.hiss[0], t0 + 0.008); hiss.setTargetAtTime(P.hiss[0] * 0.08, t0 + 0.012, P.hiss[2]);
      hiss.setTargetAtTime(0, t1, 0.02);
      leak.setValueAtTime(0, t0); leak.linearRampToValueAtTime(P.leak, t0 + P.atk * 2); leak.setTargetAtTime(0, t1, 0.03);
      pf.setValueAtTime(0, t1); pf.linearRampToValueAtTime(P.pfff[0], t1 + 0.025); pf.setTargetAtTime(0, t1 + 0.03, P.pfff[1]);
    }
    return oc.startRendering().then((b) => {
      const d = b.getChannelData(0);
      let pk = 1e-6;
      for (let i = 0; i < d.length; i++) pk = Math.max(pk, Math.abs(d[i]));
      const k = 0.9 / pk;
      for (let i = 0; i < d.length; i++) d[i] *= k;
      return b;
    });
  }
  // the valley's answer: a stereo impulse response of the open air between mountains - a diffuse tail and slap-back
  // echoes off the slopes (0.4-2.7 s: faces 70-460 m away), each duller and wider than the last. Built once, shared.
  valleyEcho() {
    if (this.valley) return this.valley;
    const ctx = this.ctx, sr = ctx.sampleRate, n = Math.round(3.2 * sr);
    const b = ctx.createBuffer(2, n, sr);
    const echoes = [[0.42, 0.5], [0.78, 0.36], [1.27, 0.26], [1.9, 0.16], [2.65, 0.09]];
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < n; i++) { const t = i / sr; d[i] = (Math.random() * 2 - 1) * 0.07 * Math.exp(-t / 0.75) * Math.min(1, t / 0.05); }
      for (const [at, a] of echoes) {
        const i0 = Math.round((at + (c ? 0.013 : -0.009) * (1 + at)) * sr), w = Math.round((0.015 + 0.02 * at) * sr);
        for (let j = 0; j < w * 3 && i0 + j < n; j++) d[i0 + j] += (Math.random() * 2 - 1) * a * Math.exp(-j / w);
      }
      let lp = 0; // darker the later (the air and the snow soak up the highs)
      for (let i = 0; i < n; i++) { lp += (d[i] - lp) * (0.5 - 0.42 * (i / n)); d[i] = lp; }
    }
    const conv = ctx.createConvolver(); conv.buffer = b;
    const ret = ctx.createGain(); ret.gain.value = 0.9;
    conv.connect(ret).connect(this.sfx);
    return (this.valley = conv);
  }
  /**
   * Sound an air horn (hornSpecs: 'bus', 'bus2', 'bus_short', 'train', 'train_long', 'train_short') heard from dist m:
   * quieter with distance, its highs soaked up by the air, more of the mountains' echo the farther off it is; doppler
   * (a pitch factor from the closing speed) shifts it. Until the buffers have rendered: the recorded air horn.
   */
  horn(kind = 'bus', { dist = 0, vol = 1, doppler = 1, delay = 0 } = {}) {
    if (!this.ctx) return false;
    if (!this.hornBufs) this.prerenderHorns();
    const train = kind.startsWith('train'), d = Math.max(0, Number.isFinite(dist) ? dist : 0);
    const ref = train ? 70 : 24, base = clamp(vol, 0, 1.5) * (train ? 0.62 : 0.5);
    const g = base / (1 + Math.pow(d / ref, 1.3));
    const B = this.hornBufs?.[kind];
    try {
      if (!B) return this.shot('horn', { vol: 0.3 * clamp(g * 2, 0.1, 1), rate: train ? 1.2 : 0.8, lp: clamp(16000 / (1 + d / 90), 900, 16000) }) || (this.tone(train ? 440 : 220, 0.8, 'sawtooth', 0.06 * clamp(g * 2, 0.1, 1)), true);
      const ctx = this.ctx, t = ctx.currentTime + delay;
      const s = ctx.createBufferSource(); s.buffer = B; s.playbackRate.value = clamp(doppler || 1, 0.85, 1.18);
      const air = ctx.createBiquadFilter(); air.type = 'lowpass'; air.frequency.value = clamp(17000 / (1 + d / 80), 700, 17000); air.Q.value = 0.5;
      const dry = ctx.createGain(); dry.gain.value = g;
      const wet = ctx.createGain(); wet.gain.value = base * (train ? 0.34 : 0.22) * (0.35 + 0.65 * clamp(d / 250, 0, 1)) / (1 + Math.pow(d / (ref * 2.6), 1.1));
      s.connect(air); air.connect(dry).connect(this.sfx); air.connect(wet).connect(this.valleyEcho());
      s.start(t);
      s.onended = () => { try { s.disconnect(); air.disconnect(); dry.disconnect(); wet.disconnect(); } catch { /* gone */ } };
      return true;
    } catch { return false; }
  }

  // ---------------------------------------------------------------- the car you drive (src/game/drive.js)
  // A combustion engine from its exhaust pulses: one oscillator at the engine's cycle (two turns of the crank) with a
  // custom wave whose harmonics are the firing order of that engine (four, six or eight pulses a cycle, the uneven ones
  // that make a V8 burble), through a soft-clip (grit under load), the exhaust's boom (peaking) and a low-pass that
  // opens with revs and throttle; noise chopped at the firing rate (each pulse's roughness), intake rush and a turbo
  // whistle under load, a rumble at the firing rate; pops on gear changes and crackle on the overrun (sporty ones).
  // Profiles: v8 (RS6) and gti (Golf) sporty, i6 (X3) and i4 (Dacia) smooth. Electric (Tesla): motor and inverter
  // whine rising with speed. Starter: a motor whirring through compression strokes, then the catch (drive.js revs).
  // Inside the car the whole lot is muffled (cabin low-pass). Tyre squeal and horn as before.
  carWave(profile) {
    this.carWaves ||= {};
    if (this.carWaves[profile]) return this.carWaves[profile];
    const P = CAR_SOUND[profile] || CAR_SOUND.i4, N = 64;
    const re = new Float32Array(N), im = new Float32Array(N);
    let seed = 7 + profile.length * 13;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let k = 1; k < N; k++) {
      let a = 0;
      if (k % P.cyl === 0) a = 1 / Math.pow(k / P.cyl, 0.85);                       // the firing pulses
      else if ((2 * k) % P.cyl === 0) a = P.uneven / Math.pow(k / P.cyl, 0.6);       // half orders (burble)
      else a = P.rough * rnd() / Math.pow(k, 0.55);                                  // cylinder-to-cylinder scatter
      const ph = rnd() * Math.PI * 2 * P.scatter;
      re[k] = a * Math.cos(ph); im[k] = a * Math.sin(ph);
    }
    return (this.carWaves[profile] = this.ctx.createPeriodicWave(re, im));
  }
  carNodes() {
    const ctx = this.ctx;
    const bus = ctx.createGain(); bus.gain.value = 0;
    const cabin = ctx.createBiquadFilter(); cabin.type = 'lowpass'; cabin.frequency.value = 9000; cabin.Q.value = 0.5;
    bus.connect(cabin).connect(this.sfx);
    // engine core: cycle oscillator -> grit -> exhaust boom -> low-pass -> level
    const osc = ctx.createOscillator();
    const pre = ctx.createGain(); pre.gain.value = 1;
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = (i / 1023) * 2 - 1; curve[i] = Math.tanh(x * 2.2) / Math.tanh(2.2); }
    shaper.curve = curve; shaper.oversample = '2x';
    const boom = ctx.createBiquadFilter(); boom.type = 'peaking'; boom.frequency.value = 110; boom.Q.value = 1.1; boom.gain.value = 7;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 500; lp.Q.value = 0.9;
    const eng = ctx.createGain(); eng.gain.value = 0;
    osc.connect(pre).connect(shaper).connect(boom).connect(lp).connect(eng).connect(bus);
    // each pulse's roughness: noise, band-passed round the firing rate's upper harmonics, chopped at the firing rate
    const ns = ctx.createBufferSource(); ns.buffer = this.white; ns.loop = true;
    const nbp = ctx.createBiquadFilter(); nbp.type = 'bandpass'; nbp.frequency.value = 400; nbp.Q.value = 0.8;
    const chop = ctx.createGain(); chop.gain.value = 0;
    const lfo = ctx.createOscillator(); lfo.type = 'sawtooth';
    const lfoDepth = ctx.createGain(); lfoDepth.gain.value = 0;
    lfo.connect(lfoDepth).connect(chop.gain);
    ns.connect(nbp).connect(chop).connect(lp);
    // the rumble (felt more than heard) at the firing rate
    const sub = ctx.createOscillator(); sub.type = 'sine';
    const subg = ctx.createGain(); subg.gain.value = 0; sub.connect(subg).connect(eng);
    // intake rush and turbo whistle under load
    const is = ctx.createBufferSource(); is.buffer = this.white; is.loop = true; is.loopStart = 0.37;
    const ibp = ctx.createBiquadFilter(); ibp.type = 'bandpass'; ibp.frequency.value = 1200; ibp.Q.value = 0.6;
    const ig = ctx.createGain(); ig.gain.value = 0; is.connect(ibp).connect(ig).connect(bus);
    const tw = ctx.createOscillator(); tw.type = 'sine';
    const twg = ctx.createGain(); twg.gain.value = 0; tw.connect(twg).connect(bus);
    // starter motor: a whir chopped by the compression strokes
    const st = ctx.createOscillator(); st.type = 'sawtooth'; st.frequency.value = 165;
    const stbp = ctx.createBiquadFilter(); stbp.type = 'bandpass'; stbp.frequency.value = 700; stbp.Q.value = 1.3;
    const stg = ctx.createGain(); stg.gain.value = 0;
    const stl = ctx.createOscillator(); stl.type = 'sine'; stl.frequency.value = 8.5;
    const stlD = ctx.createGain(); stlD.gain.value = 0; stl.connect(stlD).connect(stg.gain);
    st.connect(stbp).connect(stg).connect(bus);
    // electric: motor whine (two partials), inverter whine, a hum
    const ew = ctx.createOscillator(); ew.type = 'sine';
    const ew2 = ctx.createOscillator(); ew2.type = 'triangle';
    const inv = ctx.createOscillator(); inv.type = 'sine';
    const ewg = ctx.createGain(); ewg.gain.value = 0;
    const ew2g = ctx.createGain(); ew2g.gain.value = 0.35;
    const invg = ctx.createGain(); invg.gain.value = 0;
    ew.connect(ewg); ew2.connect(ew2g).connect(ewg); ewg.connect(bus); inv.connect(invg).connect(bus);
    // tyres and horn
    const sqs = ctx.createBufferSource(); sqs.buffer = this.white; sqs.loop = true; sqs.loopStart = 0.71;
    const sq = ctx.createBiquadFilter(); sq.type = 'bandpass'; sq.frequency.value = 1300; sq.Q.value = 6;
    const sqg = ctx.createGain(); sqg.gain.value = 0; sqs.connect(sq).connect(sqg).connect(bus);
    const h1 = ctx.createOscillator(); h1.type = 'square'; h1.frequency.value = 420;
    const h2 = ctx.createOscillator(); h2.type = 'square'; h2.frequency.value = 528;
    const hf = ctx.createBiquadFilter(); hf.type = 'bandpass'; hf.frequency.value = 900; hf.Q.value = 0.8;
    const hg = ctx.createGain(); hg.gain.value = 0;
    h1.connect(hf); h2.connect(hf); hf.connect(hg).connect(bus);
    for (const n of [osc, ns, lfo, sub, is, tw, st, stl, ew, ew2, inv, sqs, h1, h2]) n.start();
    return { bus, cabin, osc, pre, boom, lp, eng, nbp, chop, lfo, lfoDepth, sub, subg, ibp, ig, tw, twg, stg, stlD, stl, ew, ew2, inv, ewg, invg, sq, sqg, hg, profile: null, boost: 0, lastShift: false, lastLoad: 0 };
  }

  /** The car: on, rpm (~800-6500), load 0..1, electric, squeal 0..1, horn, speed (m/s), profile (CAR_SOUND key),
   *  shift (a gear change under way), inside (cockpit: muffled), crank 0..1 (starter), firing 0..1 (engine running). */
  setCar({ on = false, rpm = 800, load = 0, electric = false, squeal = 0, horn = false, speed = 0, paused = false, profile = 'i4', shift = false, inside = false, crank = 0, firing = 1 } = {}) {
    if (!this.ctx) return;
    if (!this.car) { if (!on) return; this.car = this.carNodes(); }
    const N = this.car, t = this.ctx.currentTime, k = 0.035, live = on && !paused ? 1 : 0;
    if (live) this.carLive = performance.now();
    // getting out: the door opens and shuts
    if (!on && N.wasOn) { N.wasOn = false; this.shot('car_door', { sprite: [0], vol: 0.4 }); this.shot('car_door', { sprite: [1], vol: 0.45, delay: 0.9 }); }
    if (on) N.wasOn = true;
    const P = CAR_SOUND[profile] || CAR_SOUND.i4;
    if (!electric && N.profile !== profile) { N.osc.setPeriodicWave(this.carWave(profile)); N.profile = profile; }
    N.bus.gain.setTargetAtTime(live * 0.22 * P.vol, t, on ? 0.06 : 0.2);
    N.cabin.frequency.setTargetAtTime(inside ? 1500 : 9000, t, 0.08);
    const r = Math.max(60, rpm), cyc = r / 120, fire = cyc * P.cyl, x = Math.min(1, r / 6500);
    const ice = electric ? 0 : firing;
    // the recorded engine once its loops have loaded (engineRec); the synthesized one below until then / if they fail
    let R = null;
    try { R = on && !paused ? this.engineRec(electric ? null : profile) : this.engRec; } catch (e) { R = null; } // (paused: defaults, keep the car's)
    const syn = R ? 0 : 1;
    // the engine: pitch from the revs; brighter and grittier with throttle; a dip while the gears change
    const dip = shift ? 0.45 : 1;
    N.osc.frequency.setTargetAtTime(cyc, t, k);
    N.pre.gain.setTargetAtTime(0.7 + load * P.grit, t, k);
    N.boom.frequency.setTargetAtTime(P.boom + x * 60, t, 0.1);
    N.lp.frequency.setTargetAtTime((P.bright * (180 + r * 0.22) + load * 1500 * P.bright * x + 120) * (shift ? 0.6 : 1), t, k);
    N.eng.gain.setTargetAtTime(syn * ice * dip * (0.34 + 0.22 * load + 0.12 * x), t, shift ? 0.02 : k);
    N.nbp.frequency.setTargetAtTime(fire * 3.2 + 180, t, k);
    N.lfo.frequency.setTargetAtTime(fire, t, k);
    const rough = syn * ice * P.rough * (0.05 + 0.1 * load);
    N.chop.gain.setTargetAtTime(rough, t, k); N.lfoDepth.gain.setTargetAtTime(rough, t, k);
    N.sub.frequency.setTargetAtTime(fire, t, k);
    N.subg.gain.setTargetAtTime(ice * 0.35 * (1 - x * 0.6), t, k);
    N.ibp.frequency.setTargetAtTime(700 + r * 0.45, t, k);
    N.ig.gain.setTargetAtTime(syn * ice * load * x * 0.05, t, 0.08);
    if (R) {
      // the two loops either side of the revs, crossfaded (equal power), each pitched from its own rpm to the revs
      const L = R.loops;
      let i = 0;
      while (i < L.length - 1 && r > L[i + 1].rpm) i++;
      const w = i < L.length - 1 ? clamp((r - L[i].rpm) / (L[i + 1].rpm - L[i].rpm), 0, 1) : 0;
      for (let j = 0; j < L.length; j++) {
        L[j].g.gain.setTargetAtTime(j === i ? Math.cos(w * Math.PI / 2) : j === i + 1 ? Math.sin(w * Math.PI / 2) : 0, t, 0.04);
        L[j].src.playbackRate.setTargetAtTime(clamp(r / L[j].rpm, 0.45, 2.4), t, 0.03);
      }
      // load: on the throttle the full, raw sound; off it (overrun, coasting) quieter and darker; gear changes dip
      R.tone.frequency.setTargetAtTime((1100 + 9000 * load * load + 2500 * x) * (shift ? 0.5 : 1), t, 0.05);
      R.shelf.gain.setTargetAtTime(inside ? 7 : 2, t, 0.1); // (the cabin's boom inside)
      R.out.gain.setTargetAtTime((crank > 0 ? 0 : ice) * dip * (0.5 + 0.5 * load) * ENGINE_REC_LEVEL, t, shift ? 0.02 : 0.05);
    }
    // turbo: spools with load and revs, whistles; lifting off at boost: the blow-off valve
    if (P.turbo && !electric) {
      const want = load > 0.3 ? Math.min(1, x * 1.3) : 0;
      N.boost += (want - N.boost) * (want > N.boost ? 0.04 : 0.25);
      N.tw.frequency.setTargetAtTime(1800 + N.boost * 4200, t, 0.05);
      N.twg.gain.setTargetAtTime(ice * N.boost * 0.010 * P.turbo, t, 0.05);
      if (N.lastLoad > 0.5 && load < 0.2 && N.boost > 0.45) this.carBurst(0.9 * N.boost * P.turbo, 2400, 0.35, 'highpass');
    } else N.twg.gain.setTargetAtTime(0, t, 0.05);
    // gear change: a pop from the exhaust (sporty); overrun at high revs: crackle
    if (shift && !N.lastShift && !electric && P.pops) this.carBurst(0.7 * P.pops, 650, 0.07);
    if (!electric && P.pops && load < 0.05 && r > 3200 && live && Math.random() < 0.06 * P.pops * x) this.carBurst(0.25 + Math.random() * 0.35, 500 + Math.random() * 700, 0.04);
    N.lastShift = shift; N.lastLoad = load;
    // starter motor: the recording (cranking, then the catch, timed to drive.js's), the synthesized whir until it loads
    if (crank > 0 && live && !electric) {
      if (!N.cranking) { N.cranking = true; N.recCrank = this.shot('car_start', { offset: START_CATCH - 0.85, dur: 1.4, vol: 3, out: N.bus }); }
    } else N.cranking = false;
    const synCrank = N.cranking && N.recCrank ? 0 : 1;
    N.stg.gain.setTargetAtTime(synCrank * live * crank * 0.22, t, 0.03); N.stlD.gain.setTargetAtTime(synCrank * live * crank * 0.18, t, 0.03);
    N.stl.frequency.setTargetAtTime(Math.max(4, (r / 60) * (P.cyl / 2)), t, 0.05);
    // electric
    const ev = electric ? 1 : 0, sp = Math.max(0, speed);
    N.ew.frequency.setTargetAtTime(90 + sp * 52, t, k); N.ew2.frequency.setTargetAtTime(180 + sp * 104, t, k);
    N.ewg.gain.setTargetAtTime(ev * (0.05 + 0.2 * Math.min(1, sp / 25) * (0.35 + 0.65 * load)), t, k);
    N.inv.frequency.setTargetAtTime(2400 + sp * 30, t, k);
    N.invg.gain.setTargetAtTime(ev * (sp > 0.3 ? 0.016 + 0.024 * load : 0.006), t, k);
    N.sq.frequency.setTargetAtTime(1150 + Math.sin(t * 23) * 120, t, 0.02);
    N.sqg.gain.setTargetAtTime(0.38 * Math.min(1, squeal), t, 0.05);
    N.hg.gain.setTargetAtTime(horn && live ? 0.3 : 0, t, 0.015);
  }
  // The recorded engine of a car profile (ENGINE_REC), loaded the first time you drive that car; null until its loops
  // have loaded (or when they failed / for the electric car: the synthesized engine plays then).
  engineRec(profile) {
    const [file, k] = ENGINE_ALIAS[profile] || [profile, 1];
    if (!profile || !ENGINE_REC[file]) { this.dropEngineRec(); return null; }
    this.engBufs ||= {};
    const set = this.engBufs[profile];
    if (set === undefined) {
      this.engBufs[profile] = null; // (loading)
      Promise.all(ENGINE_REC[file].map((rpm, i) => this.fetchBuffer(`sfx/eng_${file}_${i}.m4a`)
        .then((b) => ({ buf: this.loopify(b, clamp((b.duration - 0.12) * 0.25, 0.03, 0.12)), rpm: rpm * k }))))
        .then((s) => { this.engBufs[profile] = s; })
        .catch((e) => { this.engBufs[profile] = false; console.warn('[audio] engine recordings missing for', profile, '- synthesized engine', e?.message || e); });
      return null;
    }
    if (!set) return null;
    if (this.engRec?.profile !== profile) { this.dropEngineRec(); this.engRec = this.engRecNodes(profile, set); }
    return this.engRec;
  }
  // one looping source per rpm step (each through its own level), a load filter, a low shelf, into the car's bus (so
  // the cabin low-pass muffles it in the cockpit view)
  engRecNodes(profile, set) {
    const ctx = this.ctx;
    const out = ctx.createGain(); out.gain.value = 0;
    const tone = ctx.createBiquadFilter(); tone.type = 'lowpass'; tone.frequency.value = 3000; tone.Q.value = 0.5;
    const shelf = ctx.createBiquadFilter(); shelf.type = 'lowshelf'; shelf.frequency.value = 180; shelf.gain.value = 2;
    tone.connect(shelf).connect(out).connect(this.car.bus);
    const loops = set.map(({ buf, rpm }) => {
      const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
      const g = ctx.createGain(); g.gain.value = 0;
      src.connect(g).connect(tone);
      src.start(0, Math.random() * buf.duration);
      return { src, g, rpm };
    });
    return { profile, out, tone, shelf, loops };
  }
  dropEngineRec() {
    const R = this.engRec;
    if (!R) return;
    this.engRec = null;
    for (const l of R.loops) { try { l.src.stop(); } catch { /* (not started) */ } }
    try { R.out.disconnect(); } catch { /* (already) */ }
  }
  // a short burst of filtered noise from the exhaust or the turbo (pops, crackle, blow-off)
  carBurst(amount, freq, dur, type = 'bandpass') {
    try {
      const ctx = this.ctx, t = ctx.currentTime, N = this.car;
      const src = ctx.createBufferSource(); src.buffer = this.white;
      const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = type === 'bandpass' ? 1.2 : 0.7;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.5 * amount, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
      src.connect(f).connect(g).connect(N?.bus || this.sfx);
      src.start(t, Math.random() * 1.5); src.stop(t + dur + 0.05);
    } catch { /* (a missed pop is fine) */ }
  }
  /**
   * A vehicle hitting something, by what it hit: 'car' (metal crunch, glass), 'tree' (wood cracking, branches, snow
   * falling off), 'building' (a heavy thud, plaster), 'rock' (a stone knock, a scrape), 'metal' (lift tower, pole,
   * guardrail: a clang, a scrape), 'net' (a soft whoomp), 'snow' (a deep snow thump). amount 0..1: a light knock up
   * to a big layered crash.
   */
  impact(kind = 'snow', amount = 0.5) {
    if (!this.ctx) return;
    try { if (this.impactRec(kind, amount)) return; } catch { /* (the synthesized version below) */ }
    try {
      const ctx = this.ctx, t = ctx.currentTime, a = Math.max(0.08, Math.min(1, amount)), big = a > 0.55;
      const burst = (type, freq, q, vol, dur, at = 0, sweep = 0) => {
        const src = ctx.createBufferSource(); src.buffer = this.white;
        const f = ctx.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq, t + at); f.Q.value = q;
        if (sweep) f.frequency.exponentialRampToValueAtTime(Math.max(40, freq * sweep), t + at + dur);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t + at); g.gain.linearRampToValueAtTime(vol, t + at + 0.004); g.gain.exponentialRampToValueAtTime(0.0005, t + at + dur);
        src.connect(f).connect(g).connect(this.sfx);
        src.start(t + at, Math.random() * 1.2); src.stop(t + at + dur + 0.05);
      };
      const tone = (type, f0, f1, vol, dur, at = 0) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = type; o.frequency.setValueAtTime(f0, t + at); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + at + dur);
        g.gain.setValueAtTime(0, t + at); g.gain.linearRampToValueAtTime(vol, t + at + 0.006); g.gain.exponentialRampToValueAtTime(0.0005, t + at + dur);
        o.connect(g).connect(this.sfx); o.start(t + at); o.stop(t + at + dur + 0.05);
      };
      if (kind === 'car') { if (big) this.carCrash(a); else { tone('sine', 70, 40, 0.5 * a, 0.25); burst('bandpass', 700, 2, 0.45 * a, 0.18); burst('highpass', 4500, 1, 0.12 * a, 0.08, 0.05); } return; }
      if (kind === 'tree') {
        tone('sine', 85, 45, 0.6 * a, 0.3);                                            // the trunk's thud
        burst('bandpass', 1800, 3, 0.55 * a, 0.09); burst('bandpass', 2600, 4, 0.4 * a, 0.06, 0.03); // the crack
        if (big) for (let i = 0; i < 5; i++) burst('bandpass', 1200 + Math.random() * 2000, 5, 0.22 * a, 0.05, 0.06 + i * 0.05 + Math.random() * 0.03); // splinters
        burst('highpass', 3500, 0.7, 0.12 * a, 0.5, 0.05);                              // branches rustling
        burst('lowpass', 350, 0.7, 0.3 * a, 0.9, 0.25);                                 // snow sliding off, falling
        return;
      }
      if (kind === 'building') {
        tone('sine', 60, 30, 0.85 * a, 0.5); burst('lowpass', 500, 0.8, 0.55 * a, 0.35);
        for (let i = 0; i < (big ? 6 : 2); i++) burst('bandpass', 700 + Math.random() * 900, 2, 0.18 * a, 0.08, 0.05 + Math.random() * 0.3); // plaster, boards
        return;
      }
      if (kind === 'rock') {
        burst('bandpass', 900, 8, 0.7 * a, 0.12); tone('sine', 140, 90, 0.4 * a, 0.18);  // the knock
        burst('bandpass', 2200, 1.5, 0.22 * a, 0.35, 0.04, 0.6);                        // the scrape
        return;
      }
      if (kind === 'metal') {
        for (const [f, v] of [[420, 0.3], [1130, 0.18], [1870, 0.12], [2710, 0.07]]) tone('sine', f, f * 0.995, v * a, 0.9);
        burst('bandpass', 3000, 2, 0.2 * a, 0.3, 0.02, 0.7);                            // the scrape
        return;
      }
      if (kind === 'net') { burst('lowpass', 260, 0.7, 0.45 * a, 0.3); burst('bandpass', 900, 0.8, 0.08 * a, 0.25); return; }
      // snow, terrain
      tone('sine', 75, 38, 0.6 * a, 0.3); burst('lowpass', 280, 0.7, 0.5 * a, 0.45); burst('highpass', 2500, 0.7, 0.06 * a, 0.3, 0.02);
    } catch { /* (silent) */ }
  }

  // impact() from the recordings (public/audio/sfx: crash_car, metal_hit, glass, wood_crack, branches, debris, rock_hit,
  // metal_clang, metal_scrape, snow_thump): louder, fuller and a touch lower the harder the hit, layered for big ones.
  // false while that surface's recordings aren't loaded (the synthesized version plays instead).
  impactRec(kind, amount) {
    const B = this.buf, a = clamp(Number.isFinite(amount) ? amount : 0.5, 0.08, 1), big = a > 0.55;
    const rnd = (lo, hi) => lo + Math.random() * (hi - lo);
    const lp = 1800 + 16000 * a * a;   // soft knocks duller, big hits the full range
    const heavy = 1.04 - 0.1 * a;      // bigger: a little lower, heavier
    const sub = (f0, f1, v, d) => this.tone(f0, d, 'sine', v, f1 / f0); // the weight the recordings lack
    // in the car you drive, its body dents too
    const body = () => { if (performance.now() - (this.carLive || 0) < 600 && a > 0.3) this.shot('metal_hit', { sprite: true, vol: 0.1 + 0.3 * a, rate: rnd(0.78, 0.92), lp: 2500 + 4000 * a }); };
    switch (kind) {
      case 'car': // metal on metal: a dent; a big one is the full crash (crunch, glass, thud)
        if (!B.crash_car || !B.metal_hit) return false;
        if (big) { this.carCrash(a); return true; }
        this.shot('metal_hit', { sprite: true, vol: 0.3 + 0.6 * a, rate: rnd(0.95, 1.1) * heavy, lp });
        sub(90, 45, 0.25 * a, 0.25);
        return true;
      case 'tree': // the trunk cracking, branches thrashing, snow sliding off
        if (!B.wood_crack || !B.branches) return false;
        this.shot('wood_crack', { sprite: [0, 1, 2], vol: 0.45 + 0.55 * a, rate: rnd(0.92, 1.06) * heavy, lp });
        if (big) this.shot('wood_crack', { sprite: [3], vol: 0.65 * a, rate: rnd(0.9, 1), delay: rnd(0.05, 0.1), lp });
        this.shot('branches', { sprite: true, vol: 0.5 + 0.7 * a, rate: rnd(0.9, 1.1), delay: rnd(0.03, 0.07) });
        if (a > 0.3) this.shot('snow_burst', { vol: 0.35 * a, rate: rnd(0.9, 1.05), delay: rnd(0.18, 0.3), lp: 1600 });
        sub(85, 42, 0.45 * a, 0.3);
        body();
        return true;
      case 'building': // a heavy thud into the wall, then plaster / boards coming down
        if (!B.debris) return false;
        this.shot('bodyfall_heavy', { vol: 0.5 + 0.5 * a, rate: rnd(0.8, 0.9), lp: 900 });
        this.shot('debris', { vol: (big ? 0.55 : 0.22) * (0.5 + a), rate: rnd(0.95, 1.05) * heavy, lp: big ? lp : 1500 });
        sub(62, 30, 0.7 * a, 0.45);
        body();
        return true;
      case 'rock': // a stone knock (and a second as it grinds past, on big hits)
        if (!B.rock_hit) return false;
        this.shot('rock_hit', { vol: 0.45 + 0.55 * a, rate: rnd(0.82, 0.95) * heavy, lp });
        if (big) this.shot('rock_hit', { vol: 0.3 * a, rate: rnd(0.6, 0.7), delay: rnd(0.06, 0.1), lp: 2500 });
        sub(120, 60, 0.35 * a, 0.2);
        body();
        return true;
      case 'metal': // pole, lift tower, guardrail: a clang and a scrape
        if (!B.metal_clang || !B.metal_scrape) return false;
        this.shot('metal_clang', { sprite: true, vol: 0.35 + 0.55 * a, rate: rnd(0.85, 1.05) * heavy, lp });
        if (a > 0.35) this.shot('metal_scrape', { vol: 0.55 * a, rate: rnd(0.9, 1.05), delay: 0.03, lp });
        body();
        return true;
      case 'net': // the net giving: a soft, muffled whoomp
        if (!B.snow_thump) return false;
        this.shot('snow_thump', { sprite: true, vol: 0.25 + 0.35 * a, rate: rnd(0.75, 0.85), lp: 900 });
        this.burst(0.3, 260, 0.35 * a);
        return true;
      default: // snow, terrain: a deep snow thump (and a burst of snow on big ones)
        if (!B.snow_thump) return false;
        this.shot('snow_thump', { sprite: true, vol: 0.4 + 0.6 * a, rate: rnd(0.9, 1.05) * heavy, lp: 1500 + 9000 * a });
        if (big) this.shot('snow_burst', { vol: 0.4 * a, rate: rnd(0.95, 1.08), delay: 0.02 });
        sub(75, 38, 0.4 * a, 0.3);
        return true;
    }
  }

  /**
   * A car glancing off a guardrail (a steel W-beam on posts): not a bell-like clang but a dull, heavy sheet-steel
   * bonk / thud with a short grind of paint and metal, louder, lower and fuller by the speed into the rail (amount
   * 0..1); `along` (m/s, the speed along the rail) adds a longer scrape tail. The slide itself: setRailScrape().
   */
  railHit(amount = 0.4, along = 0) {
    if (!this.ctx) return;
    const a = clamp(Number.isFinite(amount) ? amount : 0.4, 0.06, 1), rnd = (lo, hi) => lo + Math.random() * (hi - lo);
    const B = this.buf, slide = clamp(along / 25, 0, 1);
    try {
      if (B.metal_hit) {
        // the body panel and the rail's beam: the dent recording, slowed and dulled (no ring)
        this.shot('metal_hit', { sprite: true, vol: 0.25 + 0.6 * a, rate: rnd(0.62, 0.74) - 0.08 * a, lp: 1400 + 3200 * a });
        if (B.metal_scrape && (a > 0.15 || slide > 0.2)) this.shot('metal_scrape', { vol: (0.2 + 0.4 * a) * (0.5 + slide), rate: rnd(0.85, 1), delay: 0.02, dur: 0.25 + 0.5 * slide, lp: 3500 + 4000 * a });
        this.tone(78, 0.28 + 0.15 * a, 'sine', 0.45 * a, 0.5);   // the weight of it
        if (performance.now() - (this.carLive || 0) < 600 && a > 0.5) this.shot('crash_car', { sprite: [1], vol: 0.25 * a, rate: rnd(0.95, 1.05), dur: 0.6, lp: 5000 });
        return;
      }
      // synthesized: a damped sheet-steel thump (low inharmonic modes dying fast) and a gritty band of noise
      const ctx = this.ctx, t = ctx.currentTime;
      for (const [f, v, d] of [[96, 0.5, 0.3], [187, 0.28, 0.18], [342, 0.16, 0.12], [611, 0.08, 0.08]]) {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'triangle'; o.frequency.setValueAtTime(f * (1 + 0.1 * a), t); o.frequency.exponentialRampToValueAtTime(f * 0.8, t + d);
        g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(v * a, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0005, t + d);
        o.connect(g).connect(this.sfx); o.start(t); o.stop(t + d + 0.05);
      }
      const src = ctx.createBufferSource(); src.buffer = this.white;
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1100 + 900 * a; f.Q.value = 1.4;
      const g = ctx.createGain(), dur = 0.18 + 0.4 * slide;
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.3 * a, t + 0.006); g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
      src.connect(f).connect(g).connect(this.sfx); src.start(t, Math.random()); src.stop(t + dur + 0.05);
    } catch { /* (silent) */ }
  }

  /**
   * The scrape loop while a car slides along a guardrail: speed (m/s along the rail), 0 = silent. A grinding band of
   * the metal_scrape recording (looped; filtered noise until it loads), pitch and loudness rising with the speed, with a
   * chatter as the panel catches on the rail's posts and joints.
   */
  setRailScrape(speed = 0) {
    if (!this.ctx) return;
    const v = Math.max(0, +speed || 0), on = v > 0.8;
    if (this.railScr && !this.railScr.rec && !this.railScr.on && this.buf.metal_scrape?.duration > 0.8) { // (the recording has loaded since)
      try { this.railScr.src.stop(); this.railScr.lfo.stop(); this.railScr.g.disconnect(); } catch { /* (gone) */ }
      this.railScr = null;
    }
    if (!this.railScr) {
      if (!on) return;
      try {
        const ctx = this.ctx, B = this.buf.metal_scrape, rec = !!(B && B.duration > 0.8);
        const src = ctx.createBufferSource(); src.buffer = rec ? this.loopify(B, 0.15) : this.white; src.loop = true;
        const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 280; hp.Q.value = 0.7;
        const bp = ctx.createBiquadFilter(); bp.type = rec ? 'lowpass' : 'bandpass'; bp.frequency.value = rec ? 5000 : 1600; bp.Q.value = rec ? 0.7 : 1.1;
        const chat = ctx.createGain(); chat.gain.value = 1;
        const lfo = ctx.createOscillator(), depth = ctx.createGain(); lfo.type = 'sawtooth'; lfo.frequency.value = 4; depth.gain.value = 0.35;
        lfo.connect(depth).connect(chat.gain); lfo.start();
        const g = ctx.createGain(); g.gain.value = 0;
        src.connect(hp).connect(bp).connect(chat).connect(g).connect(this.sfx);
        src.start(0, rec ? Math.random() * src.buffer.duration * 0.8 : Math.random());
        this.railScr = { src, bp, lfo, g, rec, on: false };
      } catch { return; }
    }
    const N = this.railScr, t = this.ctx.currentTime, k = clamp(v / 22, 0, 1);
    N.on = on;
    N.g.gain.setTargetAtTime(on ? (0.12 + 0.38 * k) * (N.rec ? 1 : 0.6) : 0, t, on ? 0.03 : 0.08);
    N.src.playbackRate.setTargetAtTime(N.rec ? 0.75 + 0.45 * k : 1, t, 0.05);
    N.bp.frequency.setTargetAtTime(N.rec ? 2500 + 6000 * k : 1200 + 1400 * k, t, 0.05);
    N.lfo.frequency.setTargetAtTime(Math.max(1, v / 2.2), t, 0.1); // (posts every ~2 m)
  }

  /** A car crash: a crunch of metal, glass breaking and a heavy thud (amount 0..1). */
  carCrash(amount = 1) {
    if (!this.ctx) return;
    const B = this.buf;
    if (B.crash_car && B.glass) {
      try {
        const a = clamp(Number.isFinite(amount) ? amount : 1, 0.3, 1), rnd = (lo, hi) => lo + Math.random() * (hi - lo);
        this.shot('crash_car', { sprite: true, vol: 0.6 + 0.4 * a, rate: rnd(0.92, 1.02) });                     // the crunch
        this.shot('glass', { sprite: true, vol: 0.35 + 0.45 * a, rate: rnd(0.95, 1.08), delay: rnd(0.04, 0.1) }); // windows
        this.shot('metal_hit', { sprite: true, vol: 0.4 * a, rate: rnd(0.7, 0.8), lp: 3000 });                    // the body folding
        if (a > 0.7) this.shot('metal_scrape', { vol: 0.4 * a, rate: rnd(0.8, 0.95), delay: rnd(0.25, 0.4), lp: 6000 }); // sliding on
        this.tone(72, 0.5, 'sine', 0.8 * a, 32 / 72);                                                               // the thud
        return;
      } catch { /* (the synthesized crash below) */ }
    }
    try {
      const ctx = this.ctx, t = ctx.currentTime, a = Math.max(0.3, Math.min(1, amount));
      const burst = (type, freq, q, vol, dur, at = 0) => {
        const src = ctx.createBufferSource(); src.buffer = this.white;
        const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t + at); g.gain.linearRampToValueAtTime(vol, t + at + 0.006); g.gain.exponentialRampToValueAtTime(0.0005, t + at + dur);
        src.connect(f).connect(g).connect(this.sfx);
        src.start(t + at, Math.random() * 1.2); src.stop(t + at + dur + 0.05);
      };
      // the thud: a low thump falling in pitch
      const o = ctx.createOscillator(), og = ctx.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(72, t); o.frequency.exponentialRampToValueAtTime(32, t + 0.4);
      og.gain.setValueAtTime(0, t); og.gain.linearRampToValueAtTime(0.9 * a, t + 0.008); og.gain.exponentialRampToValueAtTime(0.0005, t + 0.5);
      o.connect(og).connect(this.sfx); o.start(t); o.stop(t + 0.55);
      // the crunch: metal folding (low and mid noise, a few grinding pulses)
      burst('lowpass', 900, 0.8, 0.8 * a, 0.45);
      for (let i = 0; i < 4; i++) burst('bandpass', 400 + Math.random() * 900, 2.5, 0.35 * a, 0.12 + Math.random() * 0.1, 0.03 + i * 0.07 + Math.random() * 0.03);
      // glass: bright tinkles scattering after the hit
      for (let i = 0; i < 9; i++) burst('highpass', 3500 + Math.random() * 4000, 1, 0.16 * a * (1 - i / 12), 0.05 + Math.random() * 0.08, 0.08 + Math.random() * 0.45);
    } catch { /* (silent crash) */ }
  }
  // ---------------------------------------------------------------- the police chase (game/police.js)
  /** A police ram / you smashing into a patrol car (amount 0..1): the crash, a long grinding scrape of metal, glass
   *  bursting (glass), a deep boom you feel more than hear. */
  ramHit(amount = 0.6, glass = true) {
    if (!this.ctx) return;
    const a = clamp(Number.isFinite(amount) ? amount : 0.6, 0.1, 1), B = this.buf, rnd = (lo, hi) => lo + Math.random() * (hi - lo);
    try {
      this.carCrash(Math.max(0.35, a));
      if (B.metal_scrape) this.shot('metal_scrape', { vol: 0.3 + 0.45 * a, rate: rnd(0.68, 0.85), delay: 0.04, dur: 0.45 + 0.7 * a, lp: 4000 + 3000 * a });
      else this.sweep(0.5 + 0.6 * a, 2800, 800, 0.16 * a);
      if (glass && B.glass) this.shot('glass', { sprite: true, vol: 0.25 + 0.45 * a, rate: rnd(1.0, 1.18), delay: rnd(0.07, 0.15) });
      else if (glass) for (let i = 0; i < 6; i++) this.tone(3200 + Math.random() * 3800, 0.05 + Math.random() * 0.06, 'triangle', 0.035 * a, 0.9, 0.06 + Math.random() * 0.35);
      this.tone(46, 0.55 + 0.35 * a, 'sine', 0.75 * a, 0.55); // (the boom)
    } catch { /* (silent) */ }
  }
  /** Short police sounds: 'radio' (a squelch and a chirp before a line of chatter), 'spikes' (tyres bursting on a
   *  spike strip: a bang and the hiss of the air), 'star' (the wanted level going up). */
  police(name) {
    if (!this.ctx) return;
    try {
      if (name === 'radio') { this.burst(0.09, 2300, 0.07, 'bandpass'); this.tone(1720, 0.045, 'square', 0.02, 1, 0.06); this.burst(0.05, 2600, 0.04, 'bandpass'); return; }
      if (name === 'spikes') { this.burst(0.08, 900, 0.7, 'lowpass'); this.tone(90, 0.2, 'sine', 0.5, 0.5); this.sweep(0.7, 6000, 2500, 0.12); return; }
      if (name === 'star') { this.tone(660, 0.12, 'square', 0.03); this.tone(880, 0.16, 'square', 0.03, 1, 0.1); }
      // (Oct 31 2026, the user: the police "will come inside to arrest you": police.js raidStep) three hard knocks, then
      // the front door banging open
      if (name === 'door') { for (let i = 0; i < 3; i++) { this.tone(78, 0.16, 'sine', 0.6, 0.55, i * 0.26); this.tone(190, 0.05, 'triangle', 0.12, 0.6, i * 0.26); } this.tone(55, 0.45, 'sine', 0.75, 0.45, 1.05); this.tone(120, 0.12, 'square', 0.06, 0.5, 1.05); }
    } catch { /* (silent) */ }
  }
  /** The police helicopter over you, every frame while it flies (on: false fades it): the rotor's beat (amplitude-
   *  modulated brown noise at the blade rate), a turbine whine; dist (m), doppler pitch factor. */
  setChopper({ on = false, dist = 80, doppler = 1, paused = false } = {}) {
    if (!this.ctx) return;
    if (!this.chopper) {
      if (!on) return;
      try {
        const ctx = this.ctx;
        const src = ctx.createBufferSource(); src.buffer = this.brown; src.loop = true;
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 700; lp.Q.value = 0.8;
        const am = ctx.createGain(); am.gain.value = 0.55;
        const lfo = ctx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 19;
        const depth = ctx.createGain(); depth.gain.value = 0.5; lfo.connect(depth).connect(am.gain);
        const wh = ctx.createOscillator(); wh.type = 'sine'; wh.frequency.value = 2900;
        const wg = ctx.createGain(); wg.gain.value = 0.006;
        const bus = ctx.createGain(); bus.gain.value = 0;
        src.connect(lp).connect(am).connect(bus); wh.connect(wg).connect(bus); bus.connect(this.sfx);
        src.start(0, Math.random()); lfo.start(); wh.start();
        this.chopper = { bus, lfo, wh, lp };
      } catch { return; }
    }
    const N = this.chopper, t = this.ctx.currentTime, live = on && !paused ? 1 : 0;
    N.bus.gain.setTargetAtTime(live * 1.6 / (1 + Math.pow(Math.max(0, dist) / 55, 1.3)), t, 0.15);
    N.lfo.frequency.setTargetAtTime(19 * doppler, t, 0.1);
    N.wh.frequency.setTargetAtTime(2900 * doppler, t, 0.1);
    N.lp.frequency.setTargetAtTime(400 + 9000 / (1 + dist / 60), t, 0.2);
  }
  /** Getting in: an electric car's chime (a combustion engine's start is setCar's crank / firing, driven by drive.js). */
  carStart(electric) {
    if (!this.ctx) return;
    try { this.shot('car_door', { sprite: [1], vol: 0.5, delay: 0.35 }); } catch { /* (no door) */ } // shut behind you
    if (!electric) return;
    this.tone(659, 0.22, 'sine', 0.05); this.tone(988, 0.35, 'sine', 0.045, 0, 0.12);
  }

  // ---------------------------------------------------------------- named sound effects
  play(name, amount = 1) {
    if (!this.ctx) return;
    const a = clamp(Number.isFinite(amount) ? amount : 1, 0, 1);
    const rnd = (lo, hi) => lo + Math.random() * (hi - lo);
    switch (name) {
      // race timing
      case 'beep': if (!this.shot('beep', { vol: 0.42 })) this.tone(660, 0.25, 'square', 0.12); break;
      case 'go': if (!this.shot('beep_go', { vol: 0.45 })) this.tone(1320, 0.6, 'square', 0.14); break;
      case 'gate': if (!this.shot('ding', { vol: 0.26, rate: 1.12 })) this.tone(1800, 0.06, 'sine', 0.08); break;
      case 'miss': if (!this.shot('buzzer', { vol: 0.22 })) this.tone(220, 0.35, 'sawtooth', 0.1, 0.6); break;
      case 'finish':
        if (!this.shot('beep_go', { vol: 0.4, rate: 1.19 })) { this.tone(880, 0.2, 'triangle', 0.2); this.tone(1175, 0.4, 'triangle', 0.2, 0, 0.16); }
        if (this.musicCtx === 'race') this.play('crowd', 0.9); // the grandstand at the finish line
        break;
      case 'crowd': {
        const roar = this.buf.crowd_roar && Math.random() < 0.4;
        if (!this.shot(roar ? 'crowd_roar' : 'crowd', { vol: 0.5 * Math.max(0.3, a), rate: rnd(0.97, 1.03) })) this.sweep(1.6, 400, 1200, 0.08 * a);
        break;
      }
      case 'horn': if (!this.shot('horn', { vol: 0.3 * a })) this.tone(440, 0.8, 'sawtooth', 0.06); break;
      // shop / UI
      case 'cash': if (!this.shot('cash', { vol: 0.42 })) { this.tone(1500, 0.08, 'square', 0.08); this.tone(2200, 0.25, 'square', 0.08, 0, 0.07); } break;
      case 'click': if (!this.shot('click', { vol: 0.3 })) this.tone(900, 0.04, 'sine', 0.08); break;
      case 'tick': if (!this.shot('tick', { vol: 0.07, rate: rnd(0.97, 1.03) })) this.tone(1400, 0.03, 'sine', 0.04); break;
      case 'error': if (!this.shot('error', { vol: 0.3 })) this.tone(180, 0.25, 'square', 0.08); break;
      // body / snow
      case 'step': if (!this.shot('step', { sprite: true, vol: rnd(0.3, 0.42), rate: rnd(0.92, 1.08) })) this.burst(0.09, 900 + Math.random() * 400, 0.12); break;
      case 'land': {
        // the body's weight into the snow: a crunch of snow, a body thump on hard landings, and a low thud
        const v = Math.max(0.1, a);
        if (this.shot('land', { sprite: true, vol: 0.22 + 0.6 * v, rate: rnd(1.12, 1.2) - 0.25 * v, lp: 2500 + 9000 * v })) {
          if (v > 0.45) this.shot('bodyfall_heavy', { vol: (v - 0.45) * 1.1, rate: rnd(0.95, 1.05), lp: 1800 });
          this.tone(62 + 30 * (1 - v), 0.14 + v * 0.2, 'sine', 0.08 + v * 0.22, 0.55); // sub weight the recording lacks
        } else {
          this.tone(68 + 40 * (1 - v), 0.16 + v * 0.22, 'sine', 0.2 + v * 0.5, 0.55);
          this.burst(0.1 + v * 0.18, 650 + v * 550, 0.16 + v * 0.36);
          this.burst(0.07 + v * 0.1, 2600, 0.05 + v * 0.12, 'highpass');
        }
        break;
      }
      case 'jump':
        if (this.shot('swish', { vol: 0.16, rate: rnd(1.2, 1.35) })) this.shot('step', { sprite: true, vol: 0.18, rate: 1.1 });
        else this.burst(0.15, 2500, 0.12, 'highpass');
        break;
      case 'pop': {
        // skis snapping off the snow: a crunch and a short lift of air, bigger with a full charge
        const v = Math.max(0.2, a);
        if (this.shot('swish', { vol: 0.08 + 0.16 * v, rate: 1.0 + 0.3 * v })) this.shot('land', { sprite: true, vol: 0.12 + 0.14 * v, rate: 1.45, hp: 300 });
        else { this.burst(0.07, 1000, 0.16 + 0.14 * v); this.tone(150, 0.1, 'triangle', 0.06 + 0.07 * v, 1.7); this.sweep(0.28, 500, 2400, 0.05 + 0.08 * v); }
        break;
      }
      case 'spin': if (!this.shot('swish', { vol: 0.06 + 0.14 * a, rate: rnd(0.8, 0.95) + 0.2 * a })) this.sweep(0.4, 380, 2600, 0.05 + 0.1 * a); break;
      case 'trick': {
        // a trick stomped: a bright two-note sting (quieter for a sketchy landing)
        const v = 0.1 + 0.14 * a;
        if (this.shot('ding', { vol: v })) this.shot('ding', { vol: v * 0.85, rate: 1.5, delay: 0.085 });
        else { this.tone(1046.5, 0.3, 'sine', 0.035 + 0.045 * a); this.tone(1568, 0.55, 'sine', (0.035 + 0.045 * a) * 0.85, 0, 0.085); }
        break;
      }
      case 'thud': if (!this.shot('bodyfall', { vol: 0.2 + 0.55 * a, rate: rnd(0.9, 1.1), lp: 1500 + 6000 * a })) { this.tone(58, 0.22, 'sine', 0.3 * a, 0.6); this.burst(0.14, 520, 0.22 * a); } break;
      case 'crash':
        if (this.shot('bodyfall_heavy', { vol: 0.85 })) { this.shot('snow_burst', { vol: 0.55, rate: rnd(0.95, 1.08) }); this.tone(55, 0.35, 'sine', 0.25, 0.6); }
        else { this.burst(0.7, 400, 0.6); this.burst(0.5, 2000, 0.25, 'highpass'); }
        if (this.autoAnnounce && this.musicCtx === 'race') this.announce('wipeout', { delay: 0.35 });
        break;
      // lifts
      case 'board': if (!this.shot('lift_clunk', { vol: 0.5 })) this.tone(140, 0.5, 'sine', 0.3, 0.7); break;
      // intro / stingers
      case 'whoosh': if (!this.shot('whoosh', { vol: 0.6 })) this.sweep(0.55, 300, 3200, 0.35); break;
      case 'slam': if (!this.shot('slam', { vol: 0.95 })) { this.tone(58, 1.4, 'sine', 0.9, 0.5); this.tone(110, 0.5, 'triangle', 0.4, 0.4); this.burst(0.9, 900, 0.7); this.burst(0.25, 4000, 0.3, 'highpass'); } break;
      case 'chime': if (!this.shot('chime', { vol: 0.5 })) { [1568, 2093, 2637, 3136].forEach((f, i) => this.tone(f, 1.6, 'sine', 0.07, 0, i * 0.09)); this.sweep(1.2, 6000, 2000, 0.06); } break;
      case 'soft': if (!this.shot('chime', { vol: 0.32, rate: 0.75, lp: 3200 })) { this.tone(392, 1.6, 'sine', 0.08); this.tone(523, 1.4, 'sine', 0.07, 0, 0.12); this.tone(659, 1.4, 'sine', 0.06, 0, 0.24); } break;
      case 'icecold': this.iceHit(0); break;
    }
  }

  // ---------------------------------------------------------------- Icecold Studio ident (src/ui/studioident.js)
  /**
   * The studio ident's sound, fully synthesized and scheduled on the audio clock: frost crackling in (glassy
   * ticks moving left to right with the letters) and a breath of air drawn in, then the freeze hit `hitAt`
   * seconds from now -- an ice crack, a low thump, a glassy ping, the "singing ice" chirp of a frozen lake and
   * a few settling crystals, in a large cold room.
   * @param {number} [hitAt] seconds from now to the hit
   * @returns {{stop: (fade?: number) => void} | null} stop() fades it out (a skipped intro)
   */
  iceHit(hitAt = 0) {
    const ctx = this.ctx;
    if (!ctx || !this.sfx) return null;
    const sr = ctx.sampleRate, t0 = ctx.currentTime + 0.01, hit = t0 + Math.max(0, hitAt);
    const rnd = (a, b) => a + Math.random() * (b - a);
    const out = ctx.createGain(); out.gain.value = 0.85; out.connect(this.sfx);
    const room = ctx.createConvolver(); room.buffer = this.iceRoom || (this.iceRoom = this.coldRoom(2.8));
    const wet = ctx.createGain(); wet.gain.value = 0.3; wet.connect(room).connect(out);
    const srcs = [];
    // route a source: dry level + reverb send, optional high-pass / pan
    const route = (node, at, end, { gain = 1, send = 0, hp = 0, pan = 0 } = {}) => {
      let n = node;
      if (hp) { const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hp; f.Q.value = 0.6; n = n.connect(f); }
      if (pan && ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = pan; n = n.connect(p); }
      const g = ctx.createGain(); g.gain.value = gain; n.connect(g); g.connect(out);
      if (send) { const s = ctx.createGain(); s.gain.value = send; g.connect(s).connect(wet); }
      if (node.start) { node.start(at); if (end) node.stop(end); srcs.push(node); }
      return g;
    };
    const buffer = (dur, fill) => {
      const b = ctx.createBuffer(2, Math.max(1, Math.round(dur * sr)), sr);
      fill(b.getChannelData(0), b.getChannelData(1));
      const s = ctx.createBufferSource(); s.buffer = b;
      return s;
    };
    // a damped ring (+ a click of noise) added into a channel
    const ring = (d, at, f, dec, amp, click = 0) => {
      const i0 = Math.round(at * sr), n = Math.min(d.length - i0, Math.round(dec * 7 * sr)), w = 6.2832 * f / sr, ph = Math.random() * 6.28;
      for (let i = 0; i < n; i++) d[i0 + i] += amp * Math.exp(-i / (dec * sr)) * (Math.sin(ph + w * i) + (i < click ? Math.random() * 2 - 1 : 0));
    };

    // 1. frost: glassy ticks, sparse then dense, panned left to right as the letters freeze
    const lead = hit - t0;
    if (lead > 0.15) {
      const s = buffer(lead, (L, R) => {
        for (let t = 0.05; t < lead - 0.015;) {
          const u = t / lead, pan = Math.max(-1, Math.min(1, -0.75 + 1.5 * u + rnd(-0.3, 0.3)));
          const amp = rnd(0.2, 1) ** 2 * (0.25 + 0.75 * u) * 0.3, f = rnd(2800, 9500), dec = rnd(0.0015, 0.007);
          ring(L, t, f, dec, amp * Math.cos((pan + 1) * Math.PI / 4), 10);
          ring(R, t, f, dec, amp * Math.sin((pan + 1) * Math.PI / 4), 10);
          t += rnd(0.3, 1.7) / (24 + 330 * u * u);
        }
      });
      route(s, t0, 0, { gain: 0.9, send: 0.5, hp: 1500 });
    }
    // 2. a breath of air drawn in, cut dead on the hit
    if (lead > 0.3) {
      const s = ctx.createBufferSource(); s.buffer = this.white; s.loop = true;
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 0.9;
      const a = Math.max(t0, hit - 0.55);
      f.frequency.setValueAtTime(900, a); f.frequency.exponentialRampToValueAtTime(5600, hit);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, a); g.gain.exponentialRampToValueAtTime(0.055, hit - 0.01); g.gain.linearRampToValueAtTime(0, hit);
      s.connect(f).connect(g);
      route(g, 0, 0, { send: 0.2 });
      s.start(a, Math.random()); s.stop(hit + 0.02); srcs.push(s);
    }
    // 3. the crack: a splintering cluster of snaps over a short noisy body
    {
      const ev = [];
      for (let t = 0, a = 1; t < 0.14 && a > 0.04; t += rnd(0.002, 0.014) * (1 + t * 10), a *= rnd(0.5, 0.82)) ev.push([t, a, rnd(1700, 4300), rnd(0.0007, 0.0028)]);
      const s = buffer(0.32, (L, R) => {
        for (const [t, a, f, dec] of ev) { const p = rnd(-0.5, 0.5); ring(L, t, f, dec, a * (0.9 - p * 0.4), 40); ring(R, t + 0.0004, f * 1.01, dec, a * (0.9 + p * 0.4), 40); }
        for (let i = 0; i < L.length; i++) { const e = 0.24 * Math.exp(-i / (0.03 * sr)); L[i] += (Math.random() * 2 - 1) * e; R[i] += (Math.random() * 2 - 1) * e; }
      });
      route(s, hit, 0, { gain: 0.42, send: 0.45, hp: 700 });
    }
    // 4. thump: weight you hear on laptop speakers too (starts at 150 Hz, drops to the sub)
    {
      const o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(150, hit); o.frequency.exponentialRampToValueAtTime(44, hit + 0.24);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, hit); g.gain.exponentialRampToValueAtTime(0.62, hit + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, hit + 0.62);
      o.connect(g);
      route(g, 0, 0);
      o.start(hit); o.stop(hit + 0.66); srcs.push(o);
    }
    // 5. glassy ping: an inharmonic struck-ice partial set (+ a detuned twin for shimmer)
    for (const [r, a, dec] of [[1, 0.06, 1.7], [1.0035, 0.035, 2.2], [2.76, 0.026, 0.7], [5.4, 0.013, 0.34]]) {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = 1975 * r;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, hit); g.gain.exponentialRampToValueAtTime(a, hit + 0.003); g.gain.exponentialRampToValueAtTime(0.0001, hit + dec);
      o.connect(g);
      route(g, 0, 0, { gain: 1, send: 0.7 });
      o.start(hit); o.stop(hit + dec + 0.05); srcs.push(o);
    }
    // 6. singing ice: the dispersive "pew" a frozen lake makes when it cracks, and its echo
    for (const [d, f0, f1, a] of [[0.015, 4800, 520, 0.03], [0.16, 3500, 430, 0.014]]) {
      const o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(f0, hit + d); o.frequency.exponentialRampToValueAtTime(f1, hit + d + 0.2);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, hit + d); g.gain.exponentialRampToValueAtTime(a, hit + d + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, hit + d + 0.3);
      o.connect(g);
      route(g, 0, 0, { gain: 0.5, send: 1.4 });
      o.start(hit + d); o.stop(hit + d + 0.32); srcs.push(o);
    }
    // 7. crystals settling after it: a few tiny high pings, scattered
    {
      const s = buffer(1.4, (L, R) => {
        for (let k = 0; k < 9; k++) {
          const t = rnd(0.07, 1.05), f = rnd(3200, 7800), dec = rnd(0.03, 0.12), a = rnd(0.012, 0.035), p = rnd(-0.9, 0.9);
          ring(L, t, f, dec, a * (1 - p) * 0.7, 0); ring(R, t, f, dec, a * (1 + p) * 0.7, 0);
        }
      });
      route(s, hit, 0, { gain: 1, send: 0.8 });
    }
    // 8. cold air: a high hiss that dies away
    {
      const s = ctx.createBufferSource(); s.buffer = this.white; s.loop = true;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, hit); g.gain.exponentialRampToValueAtTime(0.03, hit + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, hit + 1.2);
      s.connect(g);
      route(g, 0, 0, { gain: 1, send: 0.6, hp: 6500 });
      s.start(hit, Math.random()); s.stop(hit + 1.25); srcs.push(s);
    }

    const end = setTimeout(() => out.disconnect(), (hit - ctx.currentTime + 3.5) * 1000);
    return {
      stop: (fade = 0.06) => {
        const t = ctx.currentTime;
        out.gain.cancelScheduledValues(t); out.gain.setValueAtTime(out.gain.value, t); out.gain.linearRampToValueAtTime(0, t + fade);
        clearTimeout(end);
        setTimeout(() => { for (const s of srcs) { try { s.stop(); } catch { /* not started / done */ } } out.disconnect(); }, (fade + 0.05) * 1000);
      },
    };
  }

  // stereo impulse response of a large cold room (the ident's reverb): bright early, darker as it dies
  coldRoom(dur) {
    const ctx = this.ctx, sr = ctx.sampleRate, n = Math.round(dur * sr);
    const b = ctx.createBuffer(2, n, sr);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr, x = (Math.random() * 2 - 1) * Math.exp(-t / 0.6) * Math.min(1, t / 0.015);
        lp += (x - lp) * (0.6 - 0.45 * (i / n));
        d[i] = lp;
      }
    }
    return b;
  }

  // ---------------------------------------------------------------- announcer
  /**
   * Stadium-PA announcer. Keys: ANNOUNCER_KEYS ('three','two','one','go','pb','checkpoint','first','second',
   * 'third','gold','silver','bronze','wipeout','finish','welcome', and the course ids 'alpine','icecanyon','bigair').
   * Numbers 1..3 map to the countdown. A new line cuts off the previous one. The music ducks under it.
   * @param {string|number} key
   * @param {{delay?: number, vol?: number}} [o]
   * @returns {boolean} false when the line isn't available (yet)
   */
  announce(key, { delay = 0, vol = 1 } = {}) {
    if (!this.ctx) return false;
    const k = VOICE_ALIAS[key] || String(key).toLowerCase();
    const b = this.voice[k];
    if (!b) return false;
    const ctx = this.ctx, t = ctx.currentTime + delay;
    if (this.speaking) { try { this.speaking.g.gain.setTargetAtTime(0, t, 0.02); this.speaking.s.stop(t + 0.1); } catch { /* already stopped */ } }
    const s = ctx.createBufferSource(); s.buffer = b;
    const g = ctx.createGain(); g.gain.value = vol;
    s.connect(g).connect(this.voiceBus);
    s.start(t);
    this.speaking = { s, g };
    s.onended = () => { if (this.speaking?.s === s) this.speaking = null; };
    // duck the soundtrack under the voice
    const d = this.duck.gain;
    d.cancelScheduledValues(t);
    d.setTargetAtTime(0.42, t, 0.04);
    d.setTargetAtTime(1, t + Math.max(0.3, b.duration - 0.6), 0.35);
    return true;
  }

  // ---------------------------------------------------------------- train PA (spoken)
  /**
   * A station announcement in the computer's own voices (the browser's / Electron's speechSynthesis: on a Mac the
   * system voices, German then English like the Wolkenspitzbahn's recorded lines): a three-tone gong, then each line in
   * turn. lines: [{ text, lang: 'de' | 'en' }]. The music ducks under it. Silently nothing where there is no speech.
   * @returns {boolean} false when it can't speak (nothing played)
   */
  pa(lines) {
    const S = typeof window !== 'undefined' ? window.speechSynthesis : null;
    if (!S || !this.ctx || !lines?.length) return false;
    try {
      S.cancel();
      // the gong: three falling tones (a station's PA chime)
      [784, 659, 523].forEach((f, i) => this.tone(f, 1.1, 'sine', 0.08, 0, i * 0.32));
      const voices = S.getVoices(), pick = (lang, names) => voices.find((v) => names.includes(v.name)) || voices.find((v) => v.lang?.toLowerCase().startsWith(lang));
      const V = { de: pick('de', ['Anna', 'Petra', 'Markus', 'Helena']), en: pick('en', ['Daniel', 'Serena', 'Samantha', 'Karen']) };
      const t = this.ctx.currentTime, d = this.duck.gain;
      d.cancelScheduledValues(t); d.setTargetAtTime(0.42, t, 0.06);
      this.paSpeaking = true;
      const us = lines.map((l, i) => {
        const u = new SpeechSynthesisUtterance(l.text);
        u.lang = l.lang === 'de' ? 'de-DE' : 'en-GB';
        if (V[l.lang]) u.voice = V[l.lang];
        u.rate = 0.96; u.volume = Math.min(1, this.volume * 1.1);
        if (i === lines.length - 1) u.onend = u.onerror = () => { this.paSpeaking = false; try { d.setTargetAtTime(1, this.ctx.currentTime + 0.2, 0.35); } catch { /* closed */ } };
        return u;
      });
      setTimeout(() => us.forEach((u) => S.speak(u)), 1100); // (after the gong; speechSynthesis queues them in order)
      return true;
    } catch { this.paSpeaking = false; return false; }
  }

  // ---------------------------------------------------------------- music
  /**
   * Switch the soundtrack context with a crossfade: 'menu' | 'freeride' | 'race' | 'results' | 'chase' | null (silence).
   * Calling with the current context does nothing (safe to call every frame).
   */
  music(context) {
    const c = context && MUSIC[context] ? context : null;
    if (c === this.musicCtx && (this.deck || !c)) return;
    this.musicCtx = c;
    if (!this.ctx) return; // started by init()
    this.fadeDeck(this.deck, c === 'results' ? 0.5 : 1.4);
    this.deck = null;
    if (!c) return;
    this.playlist = { ctx: c, i: MUSIC_SHUFFLE.has(c) ? this.pickTrack(c) : 0 };
    this.startTrack(MUSIC[c][this.playlist.i], c === 'results' ? 0.15 : 1.2);
  }

  /**
   * Police chase (game/police.js, every frame): the 'chase' tracks while it is on, only in place of the freeride music
   * (never over a race, the menu or results); back to the freeride music when it is over. Crossfaded like music().
   */
  chaseMusic(on) {
    if (on) { if (this.musicCtx === 'freeride') this.music('chase'); }
    else if (this.musicCtx === 'chase') this.music('freeride');
  }

  // weighted shuffle (MUSIC_SHUFFLE contexts): skips `once` tracks and the last few played in this context
  pickTrack(c) {
    const list = MUSIC[c], wt = (i) => list[i].w ?? 1;
    const recent = ((this.musicRecent ||= {})[c] ||= []);
    const pool = list.map((t, i) => i).filter((i) => !list[i].once);
    const keep = Math.min(3, pool.length >> 1), avoid = keep ? recent.slice(-keep) : [];
    let cand = pool.filter((i) => !avoid.includes(i));
    if (!cand.length) cand = pool;
    let r = Math.random() * cand.reduce((s, i) => s + wt(i), 0), pick = cand[cand.length - 1];
    for (const i of cand) { r -= wt(i); if (r < 0) { pick = i; break; } }
    recent.push(pick);
    if (recent.length > 4) recent.shift();
    return pick;
  }

  startTrack(track, fadeIn = 1.2) {
    if (this.musicMode === 'buffer') { this.startBufferTrack(track, fadeIn); return; }
    const ctx = this.ctx;
    const el = new window.Audio();
    el.preload = 'auto';
    el.src = `${BASE}music/${track.name}.m4a`;
    let src;
    try { src = ctx.createMediaElementSource(el); } catch (e) { this.musicMode = 'buffer'; this.startBufferTrack(track, fadeIn); return; }
    const deck = this.newDeck(track, fadeIn);
    deck.el = el; deck.src = src;
    src.connect(deck.g);
    // near the end: crossfade into the next track of the playlist (or the same one again)
    el.addEventListener('timeupdate', () => {
      if (deck.next || deck.stopping || this.deck !== deck || !Number.isFinite(el.duration)) return;
      const xf = track.once ? 0.05 : 2.5;
      if (el.duration - el.currentTime < xf) { deck.next = true; this.nextTrack(xf); }
    });
    el.addEventListener('ended', () => { if (this.deck === deck && !deck.next) { deck.next = true; this.nextTrack(0.05); } });
    // watchdog: a stream that stalls right at its end (no 'ended') still moves the playlist on
    let lastT = -1;
    deck.watch = setInterval(() => {
      if (deck.stopping || this.deck !== deck) { clearInterval(deck.watch); return; }
      const t = el.currentTime;
      if (!deck.next && !el.paused && t === lastT && Number.isFinite(el.duration) && el.duration - t < 1.2) { deck.next = true; this.nextTrack(0.3); }
      lastT = t;
    }, 1000);
    // streaming refused (e.g. a custom app:// protocol without media support): decode the files instead
    el.addEventListener('error', () => {
      if (this.deck !== deck || deck.stopping) return;
      console.warn('[audio] music stream failed, decoding instead:', track.name);
      this.musicMode = 'buffer';
      this.fadeDeck(deck, 0.05);
      this.deck = null;
      this.startBufferTrack(track, fadeIn);
    });
    el.play().catch(() => { /* before a user gesture (browser): init() / the first click retries */ });
  }

  newDeck(track, fadeIn) {
    const ctx = this.ctx, g = ctx.createGain();
    g.connect(this.duck);
    const deck = { el: null, src: null, g, track, ctx: this.musicCtx, stopping: false, next: false };
    this.deck = deck;
    const level = (MUSIC_LEVEL[deck.ctx] ?? 0.4) * (TRACK_GAIN[track.name] ?? 1), t = ctx.currentTime;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + fadeIn);
    return deck;
  }

  // fallback path: the whole track decoded into memory (only used if streaming fails)
  async startBufferTrack(track, fadeIn) {
    const deck = this.newDeck(track, fadeIn);
    let b;
    try { b = await this.fetchBuffer(`music/${track.name}.m4a`); } catch (e) { console.warn('[audio] could not load music', track.name, e?.message || e); return; }
    if (this.deck !== deck || deck.stopping) return;
    const s = this.ctx.createBufferSource(); s.buffer = b;
    s.connect(deck.g); s.start();
    deck.src = s;
    const xf = track.once ? 0.05 : 2.5;
    deck.timer = setTimeout(() => { if (this.deck === deck && !deck.next) { deck.next = true; this.nextTrack(xf); } }, Math.max(0, b.duration - xf) * 1000);
  }

  nextTrack(xf) {
    const P = this.playlist, list = MUSIC[P?.ctx];
    if (!list || P.ctx !== this.musicCtx) return;
    // skip the one-shot intros (e.g. the results fanfare) when wrapping around
    let i = P.i + 1;
    if (MUSIC_SHUFFLE.has(P.ctx)) i = this.pickTrack(P.ctx);
    else if (i >= list.length) { i = list.findIndex((x) => !x.once); if (i < 0) i = 0; }
    P.i = i;
    this.fadeDeck(this.deck, xf);
    this.startTrack(list[i], Math.max(0.05, xf));
  }

  fadeDeck(deck, sec) {
    if (!deck || deck.stopping) return;
    deck.stopping = true;
    clearInterval(deck.watch); clearTimeout(deck.timer);
    const t = this.ctx.currentTime;
    deck.g.gain.cancelScheduledValues(t);
    deck.g.gain.setValueAtTime(deck.g.gain.value, t);
    deck.g.gain.linearRampToValueAtTime(0, t + sec);
    setTimeout(() => {
      if (deck.el) { deck.el.pause(); deck.el.removeAttribute('src'); deck.el.load(); }
      else try { deck.src?.stop(); } catch { /* not started */ }
      deck.src?.disconnect(); deck.g.disconnect();
    }, sec * 1000 + 150);
  }
}
