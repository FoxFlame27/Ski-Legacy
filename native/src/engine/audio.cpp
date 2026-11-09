// Game audio: see audio.h. The sound design (levels, filters, which recording for what) follows src/core/audio.js.
#include "engine/audio.h"
#include "core/assets_path.h"
#include "core/log.h"
#include "platform/platform.h"

#define STB_VORBIS_HEADER_ONLY
#include <stb_vorbis.c>

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <cstring>

namespace sl {
namespace audio_detail {

constexpr int kRate = 48000;
constexpr float kPi = 3.14159265f;

struct Sample {
  std::vector<int16_t> pcm;   // mono
  int rate = 44100;
  size_t frames() const { return pcm.size(); }
  double seconds() const { return double(pcm.size()) / rate; }
};

// RBJ biquad (transposed direct form II), stereo state
struct Biquad {
  float b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
  float z1[2] = {0, 0}, z2[2] = {0, 0};
  enum { LP = 1, HP = 2, BP = 3, PEAK = 4, LOWSHELF = 5 };
  void set(int type, float f, float q, float gainDb = 0) {
    f = std::clamp(f, 10.f, kRate * 0.45f);
    q = std::max(q, 0.05f);
    float w = 2 * kPi * f / kRate, cw = std::cos(w), sw = std::sin(w), al = sw / (2 * q), A = std::pow(10.f, gainDb / 40);
    float B0 = 1, B1 = 0, B2 = 0, A0 = 1, A1 = 0, A2 = 0;
    switch (type) {
      case LP: B0 = (1 - cw) / 2; B1 = 1 - cw; B2 = B0; A0 = 1 + al; A1 = -2 * cw; A2 = 1 - al; break;
      case HP: B0 = (1 + cw) / 2; B1 = -(1 + cw); B2 = B0; A0 = 1 + al; A1 = -2 * cw; A2 = 1 - al; break;
      case BP: B0 = al; B1 = 0; B2 = -al; A0 = 1 + al; A1 = -2 * cw; A2 = 1 - al; break;
      case PEAK: B0 = 1 + al * A; B1 = -2 * cw; B2 = 1 - al * A; A0 = 1 + al / A; A1 = -2 * cw; A2 = 1 - al / A; break;
      case LOWSHELF: {
        float s = 2 * std::sqrt(A) * al;
        B0 = A * ((A + 1) - (A - 1) * cw + s); B1 = 2 * A * ((A - 1) - (A + 1) * cw); B2 = A * ((A + 1) - (A - 1) * cw - s);
        A0 = (A + 1) + (A - 1) * cw + s; A1 = -2 * ((A - 1) + (A + 1) * cw); A2 = (A + 1) + (A - 1) * cw - s;
        break;
      }
      default: break;
    }
    b0 = B0 / A0; b1 = B1 / A0; b2 = B2 / A0; a1 = A1 / A0; a2 = A2 / A0;
  }
  float run(float x, int c = 0) {
    float y = b0 * x + z1[c];
    z1[c] = b1 * x - a1 * y + z2[c];
    z2[c] = b2 * x - a2 * y;
    return y;
  }
};

/// What a play command carries (game thread -> audio thread)
struct VoiceP {
  std::shared_ptr<const Sample> s;
  uint8_t src = 0;    // 0 sample, 1 tone, 2 noise
  uint8_t bus = 0;    // 0 sfx, 2 voice
  uint8_t wave = 0;   // tone: 0 sine 1 square 2 saw 3 triangle; noise: 0 white 1 brown
  uint8_t filt = 0;   // tone / noise: 0 none, Biquad::LP / HP / BP
  bool loop = false;
  float vol = 1, rate = 1, pan = 0, lp = 0, hp = 0, delay = 0, offset = 0, dur = 0;
  float f0 = 440, f1 = 440, q = 0.7f, atk = 0.004f, endGain = 0.001f;
  bool sweepEnv = false;   // sweep(): exponential rise to vol at 60 %, then down
};

struct Voice {
  int id = 0;
  VoiceP p;
  double pos = 0, start = 0, end = 0;   // source frames
  int64_t delayLeft = 0;
  float t = 0;
  float g = 0, tg = 0, r = 1, tr = 1, pan = 0, tpan = 0, lp = 0, tlp = 0, hp = 0, thp = 0, tau = 0.05f;
  float lpSet = -1, hpSet = -1;
  Biquad flp, fhp, fx;
  uint32_t noise = 22222;
  float brown = 0, phase = 0;
  bool stopping = false, done = false;
  float stopTau = 0.05f;
};

struct Cmd {
  enum T : uint8_t { Play, Set, Stop, Deck, DeckFade } t = Play;
  int id = 0;
  VoiceP p;
  float tau = 0.05f, level = 1, fade = 1;
  stb_vorbis* vb = nullptr;
  std::shared_ptr<std::vector<uint8_t>> data;
  int deck = 0;
};

/// continuous instruments' parameters (game thread snapshot)
struct Inst {
  float sirenGain = 0, sirenAir = 9000, sirenDoppler = 1, sirenPan = 0;
  float chopGain = 0, chopDoppler = 1, chopLp = 700, chopPan = 0;
  float sledGain = 0, sledF = 40, sledLp = 380, sledEng = 0.1f, sledRasp = 0, sledRf = 700, sledTrack = 0, sledTf = 160;
  float carBus = 0, cabinLp = 9000, synEng = 0, engF = 30, engLp = 400, subG = 0, subF = 60;
  float evGain = 0, evF = 90, invGain = 0, invF = 2400, sqGain = 0, hornGain = 0, crankGain = 0, crankF = 10, turboGain = 0, turboF = 1800;
  float windGain = 0, windLp = 500, whistleGain = 0, whistleF = 1400, carveGain = 0, carveF = 2600, scrapeGain = 0, scrapeF = 3500, humGain = 0, ambGain = 0;
  float paused = 0;
};

struct Deck {
  int id = 0;
  stb_vorbis* vb = nullptr;
  std::shared_ptr<std::vector<uint8_t>> data;
  int ch = 2, rate = 44100;
  float g = 0, tg = 1, fadeStep = 0;   // gain ramps linearly by fadeStep per frame toward tg
  bool stopping = false, ended = false;
  int64_t total = 0, played = 0;        // source frames
  float buf[2048 * 2];
  int bufN = 0, bufPos = 0;
  float prev[2] = {0, 0}, cur[2] = {0, 0};
  double frac = 0;
  bool fetch(float* o) {   // the next source frame
    if (bufPos >= bufN) {
      bufN = stb_vorbis_get_samples_float_interleaved(vb, 2, buf, 2048 * 2);
      bufPos = 0;
      if (bufN <= 0) { bufN = 0; return false; }
    }
    o[0] = buf[bufPos * 2]; o[1] = buf[bufPos * 2 + 1];
    bufPos++; played++;
    return true;
  }
};

struct Mixer {
  std::mutex mu;
  std::vector<Cmd> queue;
  Inst inst;
  float vol[4] = {0.8f, 0.7f, 1, 0.95f};   // master, music, sfx, voice
  float muteTarget = 1;
  std::vector<stb_vorbis*> graveyard;
  std::atomic<int> deckEnding{0};          // the id of the current deck when it is near its end
  std::atomic<int64_t> frames{0};
  std::atomic<int> active{0}, peakVoices{0};
  std::atomic<float> peak{0};
  std::atomic<float> sirenLevel{0};
  float nearEndSec = 2.5f;
  // audio thread
  std::vector<Voice> voices;
  std::vector<Deck*> decks;
  Inst in;
  float cvol[4] = {0.8f, 0.7f, 1, 0.95f}, mute = 1, duck = 1, sirenDuck = 1, compEnv = 0;
  // instrument state
  float sPh1 = 0, sPh2 = 0, cPh = 0, cWh = 0, slPh1 = 0, slPh2 = 0, ePh = 0, evPh1 = 0, evPh2 = 0, invPh = 0, sqPh = 0, hPh1 = 0, hPh2 = 0, stPh = 0, twPh = 0, subPh = 0, whPh = 0;
  Biquad sirenBp, sirenAir, chopLp, slLp, slRf, slTf, engLpF, cabin, windLp, whistleBp, carveBp, scrapeHp, humLp, ambBp, carBp, hornBp;
  float brownA = 0, brownB = 0;
  uint32_t nz = 987654321u;
  float white() { nz ^= nz << 13; nz ^= nz >> 17; nz ^= nz << 5; return float(int32_t(nz)) * (1.f / 2147483648.f); }

  void apply(std::vector<Cmd>& cmds);
  void render(float* out, int n, int ch);
  void renderVoice(Voice& v, float* sfxL, float* sfxR, float* vcL, float* vcR, int n);
  void renderInstruments(float* L, float* R, int n);
};

void Mixer::apply(std::vector<Cmd>& cmds) {
  for (Cmd& c : cmds) {
    switch (c.t) {
      case Cmd::Play: {
        if (c.id) for (auto& v : voices) if (v.id == c.id && !v.stopping) { v.stopping = true; v.stopTau = 0.02f; v.id = 0; }
        Voice v;
        v.id = c.id;
        v.p = c.p;
        v.delayLeft = int64_t(c.p.delay * kRate);
        if (v.p.src == 0 && v.p.s) {
          double fr = double(v.p.s->frames());
          v.start = std::clamp(double(c.p.offset) * v.p.s->rate, 0.0, fr - 1);
          v.end = v.p.dur > 0 ? std::min(fr, v.start + double(c.p.dur) * v.p.s->rate) : fr;
          v.pos = v.start;
          if (v.p.loop) { v.start = 0; v.end = fr; v.pos = std::fmod(std::fabs(double(c.p.offset)) * v.p.s->rate, std::max(1.0, fr - 2)); }
        }
        v.g = v.tg = c.p.vol; v.r = v.tr = c.p.rate; v.pan = v.tpan = c.p.pan; v.lp = v.tlp = c.p.lp; v.hp = v.thp = c.p.hp;
        if (v.p.loop) v.g = 0;   // loops fade in from silence
        v.tau = c.tau;
        v.noise = nz ^ uint32_t(voices.size() * 2654435761u);
        if (v.noise == 0) v.noise = 1;
        if (v.p.filt) v.fx.set(v.p.filt, v.p.f0, v.p.q);
        voices.push_back(v);
        break;
      }
      case Cmd::Set:
        for (auto& v : voices) if (v.id == c.id && !v.stopping) { v.tg = c.p.vol; v.tr = c.p.rate; v.tpan = c.p.pan; v.tlp = c.p.lp; v.thp = c.p.hp; v.tau = c.tau; }
        break;
      case Cmd::Stop:
        for (auto& v : voices) if (v.id == c.id && !v.stopping) { v.stopping = true; v.stopTau = c.tau; v.id = 0; }
        break;
      case Cmd::Deck: {
        Deck* d = new Deck;
        d->id = c.deck; d->vb = c.vb; d->data = c.data;
        stb_vorbis_info vi = stb_vorbis_get_info(c.vb);
        d->ch = vi.channels; d->rate = int(vi.sample_rate);
        d->total = int64_t(stb_vorbis_stream_length_in_samples(c.vb));
        d->g = 0; d->tg = c.level; d->fadeStep = c.level / std::max(1.f, c.fade * kRate);
        d->fetch(d->prev); d->fetch(d->cur);
        decks.push_back(d);
        break;
      }
      case Cmd::DeckFade:
        for (Deck* d : decks) if (d->id == c.deck || c.deck == 0) { if (!d->stopping) { d->stopping = true; d->tg = 0; d->fadeStep = std::max(d->g, 0.01f) / std::max(1.f, c.fade * kRate); } }
        break;
    }
  }
}

static float wave(int w, float ph) {   // ph 0..1
  switch (w) {
    case 1: return ph < 0.5f ? 0.8f : -0.8f;
    case 2: return 2 * ph - 1;
    case 3: return 4 * std::fabs(ph - 0.5f) - 1;
    default: return std::sin(2 * kPi * ph);
  }
}

void Mixer::renderVoice(Voice& v, float* sfxL, float* sfxR, float* vcL, float* vcR, int n) {
  const float blk = float(n) / kRate;
  // parameter smoothing for this block (setTargetAtTime): start and end values, ramped linearly inside the block
  float a = 1 - std::exp(-blk / std::max(v.tau, 1e-3f));
  float g0 = v.g;
  if (v.stopping) v.tg = 0, a = 1 - std::exp(-blk / std::max(v.stopTau, 1e-3f));
  v.g += (v.tg - v.g) * a;
  if (v.stopping && v.g < 1e-4f) { v.done = true; return; }
  v.r += (v.tr - v.r) * a;
  v.pan += (v.tpan - v.pan) * a;
  v.lp += (v.tlp - v.lp) * a;
  v.hp += (v.thp - v.hp) * a;
  if (v.lp > 0 && std::fabs(v.lp - v.lpSet) > 1) { v.flp.set(Biquad::LP, v.lp, 0.707f); v.lpSet = v.lp; }
  if (v.hp > 0 && std::fabs(v.hp - v.hpSet) > 1) { v.fhp.set(Biquad::HP, v.hp, 0.707f); v.hpSet = v.hp; }
  float pl = std::cos((v.pan + 1) * kPi / 4), pr = std::sin((v.pan + 1) * kPi / 4);
  float* L = v.p.bus == 2 ? vcL : sfxL;
  float* R = v.p.bus == 2 ? vcR : sfxR;
  const Sample* s = v.p.s.get();
  double step = s ? double(v.r) * s->rate / kRate : 0;
  for (int i = 0; i < n; i++) {
    if (v.delayLeft > 0) { v.delayLeft--; continue; }
    float gi = g0 + (v.g - g0) * (float(i) / n);
    float x = 0;
    if (v.p.src == 0) {
      if (!s) { v.done = true; return; }
      if (v.pos >= v.end - 1) {
        if (v.p.loop) v.pos -= (v.end - 1 - v.start);
        else { v.done = true; break; }
      }
      size_t k = size_t(v.pos);
      float fr = float(v.pos - double(k));
      x = (s->pcm[k] + (s->pcm[k + 1] - s->pcm[k]) * fr) * (1.f / 32768.f);
      if (v.p.dur > 0 && !v.p.loop) {   // fade the end of a sprite / a cut (30 ms)
        double left = (v.end - v.pos) / s->rate;
        if (left < 0.03) x *= float(left / 0.03);
      }
      v.pos += step;
    } else {
      float dur = std::max(v.p.dur, 1e-3f);
      if (v.t >= dur + 0.05f) { v.done = true; break; }
      float u = std::min(1.f, v.t / dur);
      float env;
      if (v.p.sweepEnv) env = u < 0.6f ? 0.0001f * std::pow(v.p.vol / 0.0001f, u / 0.6f) : v.p.vol * std::pow(0.0001f / v.p.vol, (u - 0.6f) / 0.4f);
      else env = (v.t < v.p.atk ? v.p.vol * v.t / v.p.atk : v.p.vol * std::pow(v.p.endGain / std::max(v.p.vol, 1e-4f), std::min(1.f, (v.t - v.p.atk) / std::max(dur - v.p.atk, 1e-3f))));
      if (v.t > dur) env = 0;
      float f = v.p.f1 != v.p.f0 ? v.p.f0 * std::pow(v.p.f1 / v.p.f0, u) : v.p.f0;
      if (v.p.src == 1) {
        x = wave(v.p.wave, v.phase) * env;
        v.phase += f / kRate;
        v.phase -= std::floor(v.phase);
      } else {
        v.noise ^= v.noise << 13; v.noise ^= v.noise >> 17; v.noise ^= v.noise << 5;
        float w = float(int32_t(v.noise)) * (1.f / 2147483648.f);
        if (v.p.wave == 1) { v.brown = (v.brown + 0.02f * w) / 1.02f; w = v.brown * 3.5f; }
        if (v.p.filt) {
          if (v.p.f1 != v.p.f0 && (i & 31) == 0) v.fx.set(v.p.filt, f, v.p.q);
          w = v.fx.run(w);
        }
        x = w * env;
      }
      v.t += 1.f / kRate;
      gi = 1;
    }
    if (v.lp > 0) x = v.flp.run(x);
    if (v.hp > 0) x = v.fhp.run(x);
    x *= gi;
    L[i] += x * pl;
    R[i] += x * pr;
  }
}

void Mixer::renderInstruments(float* L, float* R, int n) {
  const Inst& P = in;
  float live = 1 - P.paused;
  // siren: European two-tone (440 / 587 Hz, 0.6 s each), square + saw through a horn band-pass, softer with distance
  if (P.sirenGain > 1e-4f) {
    sirenBp.set(Biquad::BP, 1100, 0.7f);
    sirenAir.set(Biquad::LP, P.sirenAir, 0.707f);
    double t = double(frames.load()) / kRate;
    float pl = std::cos((P.sirenPan + 1) * kPi / 4), pr = std::sin((P.sirenPan + 1) * kPi / 4);
    for (int i = 0; i < n; i++) {
      double ti = t + double(i) / kRate;
      float f = (int(std::floor(ti / 0.6)) % 2 ? 587.f : 440.f) * P.sirenDoppler;
      sPh1 += f / kRate; sPh1 -= std::floor(sPh1);
      sPh2 += f * 1.003f / kRate; sPh2 -= std::floor(sPh2);
      float x = sirenAir.run(sirenBp.run(0.05f * wave(1, sPh1) / 0.8f + 0.04f * wave(2, sPh2))) * P.sirenGain * live;
      L[i] += x * pl; R[i] += x * pr;
    }
  }
  // helicopter: brown noise chopped at the blade rate (19 Hz) through a low pass, a turbine whine
  if (P.chopGain > 1e-4f) {
    chopLp.set(Biquad::LP, P.chopLp, 0.8f);
    float pl = std::cos((P.chopPan + 1) * kPi / 4), pr = std::sin((P.chopPan + 1) * kPi / 4);
    for (int i = 0; i < n; i++) {
      brownA = (brownA + 0.02f * white()) / 1.02f;
      cPh += 19 * P.chopDoppler / kRate; cPh -= std::floor(cPh);
      cWh += 2900 * P.chopDoppler / kRate; cWh -= std::floor(cWh);
      float am = 0.55f + 0.5f * std::sin(2 * kPi * cPh);
      float x = (chopLp.run(brownA * 3.5f) * am + 0.006f * std::sin(2 * kPi * cWh)) * P.chopGain * live;
      L[i] += x * pl; R[i] += x * pr;
    }
  }
  // snowmobile: a buzzy saw at the firing rate + a square an octave down, a low pass opening with the throttle,
  // rasp (band-passed noise) and the track's rumble
  if (P.sledGain > 1e-4f) {
    slLp.set(Biquad::LP, P.sledLp, 0.9f);
    slRf.set(Biquad::BP, P.sledRf, 1.2f);
    slTf.set(Biquad::LP, P.sledTf, 0.7f);
    for (int i = 0; i < n; i++) {
      slPh1 += P.sledF / kRate; slPh1 -= std::floor(slPh1);
      slPh2 += P.sledF * 0.5f / kRate; slPh2 -= std::floor(slPh2);
      float w = white();
      float x = (slLp.run(wave(2, slPh1) * 0.7f + wave(1, slPh2) * 0.4f) * P.sledEng + slRf.run(w) * P.sledRasp + slTf.run(w) * P.sledTrack) * P.sledGain * live;
      L[i] += x; R[i] += x;
    }
  }
  // the car: the synthesized engine (until / unless its recordings load), electric motor + inverter, starter, turbo,
  // tyre squeal, horn; through the cabin low pass
  if (P.carBus > 1e-4f) {
    engLpF.set(Biquad::LP, P.engLp, 0.8f);
    cabin.set(Biquad::LP, P.cabinLp, 0.6f);
    carBp.set(Biquad::BP, 1150, 3);
    hornBp.set(Biquad::BP, 600, 0.8f);
    for (int i = 0; i < n; i++) {
      float x = 0;
      if (P.synEng > 1e-4f) {
        ePh += P.engF / kRate; ePh -= std::floor(ePh);
        float pulse = 0; for (int h = 1; h <= 8; h++) pulse += std::sin(2 * kPi * ePh * h * 4) / h;   // firing harmonics
        x += engLpF.run(std::tanh(pulse * 0.8f)) * P.synEng;
      }
      if (P.subG > 1e-4f) { subPh += P.subF / kRate; subPh -= std::floor(subPh); x += std::sin(2 * kPi * subPh) * P.subG * 0.3f; }
      if (P.evGain > 1e-4f) {
        evPh1 += P.evF / kRate; evPh1 -= std::floor(evPh1);
        evPh2 += P.evF * 2 / kRate; evPh2 -= std::floor(evPh2);
        x += (std::sin(2 * kPi * evPh1) * 0.6f + std::sin(2 * kPi * evPh2) * 0.4f) * P.evGain;
      }
      if (P.invGain > 1e-4f) { invPh += P.invF / kRate; invPh -= std::floor(invPh); x += wave(1, invPh) * P.invGain; }
      if (P.crankGain > 1e-4f) { stPh += P.crankF / kRate; stPh -= std::floor(stPh); x += (wave(2, stPh) * 0.5f + white() * 0.3f) * P.crankGain * (0.6f + 0.4f * std::sin(2 * kPi * stPh)); }
      if (P.turboGain > 1e-5f) { twPh += P.turboF / kRate; twPh -= std::floor(twPh); x += std::sin(2 * kPi * twPh) * P.turboGain; }
      if (P.sqGain > 1e-4f) { sqPh += (1150 + 120 * std::sin(float(frames.load() + i) * 23.f / kRate)) / kRate; sqPh -= std::floor(sqPh); x += carBp.run(wave(2, sqPh) * 0.6f + white() * 0.3f) * P.sqGain; }
      if (P.hornGain > 1e-4f) {
        hPh1 += 420.f / kRate; hPh1 -= std::floor(hPh1);
        hPh2 += 500.f / kRate; hPh2 -= std::floor(hPh2);
        x += hornBp.run(wave(2, hPh1) + wave(2, hPh2)) * P.hornGain * 0.5f;
      }
      x = cabin.run(x) * P.carBus * live;
      L[i] += x; R[i] += x;
    }
  }
  // procedural skiing loops (only until the recorded loops have loaded / if they are missing)
  if (P.windGain + P.whistleGain + P.carveGain + P.scrapeGain + P.humGain + P.ambGain > 1e-4f) {
    windLp.set(Biquad::LP, P.windLp, 0.7f);
    whistleBp.set(Biquad::BP, P.whistleF, 8);
    carveBp.set(Biquad::BP, P.carveF, 0.9f);
    scrapeHp.set(Biquad::HP, P.scrapeF, 0.7f);
    humLp.set(Biquad::LP, 120, 1.5f);
    ambBp.set(Biquad::BP, 300, 0.5f);
    for (int i = 0; i < n; i++) {
      float w = white();
      brownB = (brownB + 0.02f * w) / 1.02f;
      float b = brownB * 3.5f;
      float x = windLp.run(b) * P.windGain + whistleBp.run(w) * P.whistleGain + carveBp.run(w) * P.carveGain + scrapeHp.run(w) * P.scrapeGain +
                humLp.run(b) * P.humGain + ambBp.run(b) * P.ambGain;
      x *= live;
      L[i] += x; R[i] += x;
    }
  }
}

void Mixer::render(float* out, int n, int ch) {
  std::vector<Cmd> cmds;
  {
    std::lock_guard<std::mutex> lk(mu);
    cmds.swap(queue);
    in = inst;
    for (int k = 0; k < 4; k++) cvol[k] = vol[k];
  }
  apply(cmds);
  std::vector<stb_vorbis*> dead;
  constexpr int B = 256;
  float sL[B], sR[B], vL[B], vR[B], mL[B], mR[B];
  int done = 0;
  while (done < n) {
    int m = std::min(B, n - done);
    std::fill(sL, sL + m, 0.f); std::fill(sR, sR + m, 0.f); std::fill(vL, vL + m, 0.f); std::fill(vR, vR + m, 0.f);
    std::fill(mL, mL + m, 0.f); std::fill(mR, mR + m, 0.f);
    bool speaking = false;
    for (auto& v : voices) { if (!v.done) renderVoice(v, sL, sR, vL, vR, m); if (v.p.bus == 2 && !v.done) speaking = true; }
    renderInstruments(sL, sR, m);
    // music decks (resampled to the output rate)
    for (Deck* d : decks) {
      if (d->ended) continue;
      double step = double(d->rate) / kRate;
      for (int i = 0; i < m; i++) {
        if (d->g != d->tg) { d->g = d->tg > d->g ? std::min(d->tg, d->g + d->fadeStep) : std::max(d->tg, d->g - d->fadeStep); }
        float l = d->prev[0] + (d->cur[0] - d->prev[0]) * float(d->frac), r = d->prev[1] + (d->cur[1] - d->prev[1]) * float(d->frac);
        mL[i] += l * d->g; mR[i] += r * d->g;
        d->frac += step;
        while (d->frac >= 1) {
          d->frac -= 1;
          d->prev[0] = d->cur[0]; d->prev[1] = d->cur[1];
          if (!d->fetch(d->cur)) { d->ended = true; break; }
        }
        if (d->ended) break;
      }
      if (d->stopping && d->g <= 0) d->ended = true;
      if (!d->stopping && d->total > 0 && double(d->total - d->played) / d->rate < nearEndSec) deckEnding = d->id;
      else if (!d->stopping && d->ended) deckEnding = d->id;
    }
    // ducking: the announcer (0.42), a close siren (-3 dB)
    float blk = float(m) / kRate;
    float dt = speaking ? 0.42f : 1.f;
    duck += (dt - duck) * (1 - std::exp(-blk / (speaking ? 0.04f : 0.35f)));
    float st = 1 - 0.3f * std::clamp(in.sirenGain / 0.5f, 0.f, 1.f);
    sirenDuck += (st - sirenDuck) * (1 - std::exp(-blk / 0.3f));
    float mt = muteTarget;
    float* o = out + size_t(done) * ch;
    for (int i = 0; i < m; i++) {
      mute += (mt - mute) * 0.002f;
      float gM = cvol[0] * mute;
      float l = (sL[i] * cvol[2] + mL[i] * cvol[1] * duck * sirenDuck + vL[i] * cvol[3]) * gM;
      float r = (sR[i] * cvol[2] + mR[i] * cvol[1] * duck * sirenDuck + vR[i] * cvol[3]) * gM;
      // glue compressor (threshold -12 dB, ratio 6, attack 4 ms, release 220 ms)
      float lev = std::max(std::fabs(l), std::fabs(r));
      compEnv += (lev - compEnv) * (lev > compEnv ? 1 - std::exp(-1.f / (0.004f * kRate)) : 1 - std::exp(-1.f / (0.22f * kRate)));
      const float thr = 0.25f;
      if (compEnv > thr) { float gr = thr * std::pow(compEnv / thr, 1.f / 6) / compEnv; l *= gr; r *= gr; }
      auto clip = [](float x) { float a = std::fabs(x); return a < 0.8f ? x : std::copysign(0.8f + 0.2f * std::tanh((a - 0.8f) / 0.2f), x); };
      l = clip(l); r = clip(r);
      float pk = std::max(std::fabs(l), std::fabs(r));
      if (pk > peak.load(std::memory_order_relaxed)) peak.store(pk, std::memory_order_relaxed);
      if (ch == 1) o[i] = 0.5f * (l + r);
      else { o[i * ch] = l; o[i * ch + 1] = r; for (int c = 2; c < ch; c++) o[i * ch + c] = 0; }
    }
    done += m;
  }
  voices.erase(std::remove_if(voices.begin(), voices.end(), [](const Voice& v) { return v.done; }), voices.end());
  for (size_t i = 0; i < decks.size();) {
    if (decks[i]->ended) { dead.push_back(decks[i]->vb); delete decks[i]; decks.erase(decks.begin() + long(i)); }
    else i++;
  }
  int act = int(voices.size());
  active = act;
  if (act > peakVoices.load()) peakVoices = act;
  frames += n;
  if (!dead.empty()) { std::lock_guard<std::mutex> lk(mu); graveyard.insert(graveyard.end(), dead.begin(), dead.end()); }
}

} // namespace audio_detail

using namespace audio_detail;

namespace {
// the sound effect files (public/audio/sfx), in audio.js's load order
const char* kSfx[] = {
  "whoosh", "slam", "chime", "click", "tick", "ski_carve", "ski_scrape", "ski_powder", "wind_rush", "wind_mountain", "lift_hum",
  "step", "land", "bodyfall", "bodyfall_heavy", "snow_burst", "swish", "cash", "error", "buzzer", "ding",
  "beep", "beep_go", "horn", "crowd", "crowd_roar", "lift_clunk",
  "crash_car", "metal_hit", "glass", "wood_crack", "branches", "debris", "rock_hit", "metal_clang", "metal_scrape", "snow_thump",
  "car_start", "car_door",
  "eng_v8_0", "eng_v8_1", "eng_gti_0", "eng_gti_1", "eng_gti_2", "eng_gti_3", "eng_i6_0", "eng_i6_1", "eng_i6_2", "eng_i4_0", "eng_i4_1",
};
const char* kVoice[] = {
  "three", "two", "one", "go", "pb", "checkpoint", "first", "second", "third", "gold", "silver", "bronze",
  "wipeout", "finish", "welcome", "alpine", "icecanyon", "bigair",
  "rail_dep_up", "rail_dep_down", "rail_next_wolkensee", "rail_next_wolkenplatt", "rail_next_village",
  "rail_arr_wolkensee", "rail_arr_wolkenplatt", "rail_arr_village",
};
struct Sprite { float o, d; };
const std::unordered_map<std::string, std::vector<Sprite>>& sprites() {
  static const std::unordered_map<std::string, std::vector<Sprite>> S = {
    {"step", {{0, 0.56f}, {0.68f, 0.42f}, {1.22f, 0.56f}, {1.9f, 0.56f}, {2.58f, 0.56f}, {3.26f, 0.45f}, {3.83f, 0.56f}, {4.51f, 0.56f}, {5.19f, 0.45f}, {6.06f, 0.45f},
              {6.63f, 0.38f}, {7.13f, 0.45f}, {7.7f, 0.39f}, {8.21f, 0.45f}, {8.78f, 0.45f}, {9.35f, 0.45f}, {9.92f, 0.45f}, {10.49f, 0.45f}, {11.06f, 0.45f}, {11.63f, 0.45f}}},
    {"land", {{0, 1.336f}, {1.456f, 0.757f}, {2.333f, 1.133f}}},
    {"crash_car", {{0, 3.7f}, {3.9f, 2.3f}, {6.4f, 2.15f}}},
    {"metal_hit", {{0, 1.6f}, {1.8f, 1.4f}}},
    {"glass", {{0, 1.3f}, {1.5f, 1.3f}, {3, 1.6f}}},
    {"wood_crack", {{0, 0.85f}, {1.05f, 0.9f}, {2.15f, 0.9f}, {3.25f, 2.25f}}},
    {"branches", {{0, 1.4f}, {1.6f, 1.3f}}},
    {"metal_clang", {{0, 1.55f}, {1.75f, 0.6f}}},
    {"snow_thump", {{0, 0.65f}, {0.85f, 0.65f}, {1.7f, 0.7f}, {2.6f, 0.65f}}},
    {"car_door", {{0, 1}, {1.2f, 0.8f}}},
  };
  return S;
}
float spriteGain(const std::string& n, int i) {
  static const std::unordered_map<std::string, std::vector<float>> G = {
    {"crash_car", {1, 0.95f, 0.72f}}, {"glass", {1.25f, 0.85f, 0.8f}}, {"wood_crack", {0.85f, 1, 1.2f, 1.3f}}, {"metal_hit", {0.85f, 1.3f}}};
  auto it = G.find(n);
  return it != G.end() && i < int(it->second.size()) ? it->second[size_t(i)] : 1.f;
}
// soundtrack (audio.js MUSIC): per context, tracks with weights; `once` plays a single time
struct Track { const char* name; float w; bool once; };
const std::unordered_map<std::string, std::vector<Track>>& musicLists() {
  static const std::unordered_map<std::string, std::vector<Track>> M = {
    {"menu", {{"menu_hitech", 1, false}}},
    {"freeride", {{"ride_alive", 1, false}, {"ride_afterparty", 1, false}, {"ride_feelgood", 1, false}, {"ride_robot", 1, false}, {"ride_feet", 1, false},
                  {"ride_energy", 1, false}, {"ride_rocknroll", 0.2f, false}, {"ride_city", 0.2f, false}}},
    {"race", {{"race_fire", 1, false}, {"race_sweat", 1, false}, {"race_road", 1, false}, {"race_punk", 0.2f, false}}},
    {"results", {{"results_win", 1, true}, {"results_loop", 1, false}}},
    {"chase", {{"chase_run", 1, false}, {"chase_fight", 1, false}, {"chase_intense", 1, false}}},
  };
  return M;
}
float musicLevel(const std::string& c) { return c == "menu" ? 0.85f : c == "freeride" ? 0.45f : c == "race" ? 0.7f : c == "results" ? 0.8f : c == "chase" ? 0.7f : 0.4f; }
bool shuffled(const std::string& c) { return c == "freeride" || c == "race" || c == "chase"; }
// engine characters (CAR_SOUND) and the recordings' rpm (ENGINE_REC, ENGINE_ALIAS)
struct CarSound { int cyl; float rough, grit, bright, turbo, pops, vol; };
CarSound carSound(const std::string& p) {
  if (p == "v8") return {8, 0.35f, 1.6f, 0.9f, 0.6f, 1, 1.1f};
  if (p == "gti") return {4, 0.4f, 1.3f, 1.25f, 1, 0.8f, 1};
  if (p == "i6") return {6, 0.12f, 0.5f, 0.85f, 0.5f, 0, 0.8f};
  if (p == "v10") return {10, 0.25f, 1.2f, 1.25f, 0, 1, 1.1f};
  if (p == "i3t") return {3, 0.4f, 1.1f, 1.1f, 1, 0.6f, 0.95f};
  if (p == "v8s") return {8, 0.12f, 0.6f, 0.75f, 0.4f, 0, 0.85f};
  return {4, 0.2f, 0.6f, 0.8f, 0, 0, 0.8f};
}
void engineRec(const std::string& profile, std::string& file, std::vector<float>& rpms) {
  float k = 1;
  file = profile;
  if (profile == "v10") { file = "v8"; k = 0.8f; }
  else if (profile == "i3t") { file = "gti"; k = 1.12f; }
  else if (profile == "v8s") { file = "v8"; k = 1; }
  static const std::unordered_map<std::string, std::vector<float>> R = {
    {"v8", {960, 3330}}, {"gti", {885, 3150, 4860, 6180}}, {"i6", {720, 2960, 4570}}, {"i4", {750, 3630}}};
  rpms.clear();
  auto it = R.find(file);
  if (it != R.end()) for (float r : it->second) rpms.push_back(r * k);
}
// the skier's loops: the recording, the loop crossfade (loopify, s)
bool isLoop(const std::string& n) { return n == "ski_carve" || n == "ski_scrape" || n == "ski_powder" || n == "wind_rush" || n == "wind_mountain" || n == "lift_hum" || n.rfind("eng_", 0) == 0; }

// Make a seamless loop: drop the codec's edge padding (60 ms), then crossfade the tail into the head (audio.js loopify)
void loopify(Sample& s, float xf) {
  size_t edge = size_t(0.06 * s.rate), X = size_t(xf * s.rate);
  if (s.pcm.size() < 2 * edge + 2 * X + 16) return;
  size_t n = s.pcm.size() - 2 * edge;
  std::vector<int16_t> o(n - X);
  const int16_t* a = s.pcm.data() + edge;
  for (size_t i = 0; i < n - X; i++) o[i] = a[i];
  for (size_t i = 0; i < X; i++) {
    float t = float(i) / X;
    o[i] = int16_t(std::clamp(a[i] * std::sin(t * kPi / 2) + a[n - X + i] * std::cos(t * kPi / 2), -32768.f, 32767.f));
  }
  s.pcm.swap(o);
}

// The air horns (audio.js hornSpecs / renderHorn), rendered once: pulse-like trumpets a few cents apart, driven into
// saturation, through the bells' formants; the valve scooping the pitch up, the sag while the reservoir drains, a hiss
// of air on opening and a "pfff" as it closes.
struct HornSpec {
  std::vector<std::pair<float, float>> tones;   // f, gain
  float det, duty;
  std::vector<std::array<float, 3>> formants;   // f, q, gain
  float body, hp, lp, drive, scoop, rise, sag, atk, rel, hissT, hissF, hissG, pfffT, pfffG;
  std::vector<std::pair<float, float>> blasts;  // start, length
};
std::shared_ptr<Sample> renderHorn(const HornSpec& P) {
  float total = 0;
  for (auto& b : P.blasts) total = std::max(total, b.first + b.second);
  total += P.rel + P.pfffT + 0.3f;
  auto s = std::make_shared<Sample>();
  s->rate = kRate;
  size_t N = size_t(total * kRate);
  std::vector<float> buf(N, 0.f);
  std::vector<Biquad> F(P.formants.size());
  for (size_t i = 0; i < F.size(); i++) F[i].set(Biquad::BP, P.formants[i][0], P.formants[i][1]);
  Biquad hp, lp, hiss, pf;
  hp.set(Biquad::HP, P.hp, 0.7f); lp.set(Biquad::LP, P.lp, 0.7f); hiss.set(Biquad::BP, P.hissF, 1.2f); pf.set(Biquad::LP, 1400, 0.7f);
  std::vector<float> ph(P.tones.size() * 2, 0.f);
  uint32_t nz = 1234567u;
  float flutter = 0;
  for (size_t i = 0; i < N; i++) {
    float t = float(i) / kRate;
    // pressure: the blasts' envelopes
    float env = 0, since = 1e9f, after = 1e9f;
    for (auto& b : P.blasts) {
      float u = t - b.first;
      if (u < 0) continue;
      float e = u < b.second ? std::min(1.f, u / P.atk) : std::exp(-(u - b.second) / (P.rel * 0.35f));
      env = std::max(env, e);
      if (u < b.second) since = std::min(since, u);
      else after = std::min(after, u - b.second);
    }
    nz ^= nz << 13; nz ^= nz >> 17; nz ^= nz << 5;
    float w = float(int32_t(nz)) * (1.f / 2147483648.f);
    float x = 0;
    if (env > 1e-4f) {
      float scoop = since < 1e8f ? 1 - P.scoop * std::exp(-since / P.rise) - P.sag * std::min(1.f, since / 1.5f) : 1 - P.scoop * 0.6f;
      flutter = std::sin(t * 2 * kPi * 7) * 0.003f;
      for (size_t k = 0; k < P.tones.size(); k++)
        for (int c = 0; c < 2; c++) {
          float f = P.tones[k].first * scoop * (1 + flutter) * std::pow(2.f, (c ? P.det : -P.det) / 1200.f);
          float& q = ph[k * 2 + size_t(c)];
          q += f / kRate; q -= std::floor(q);
          x += (q < P.duty ? 1.f : -P.duty / (1 - P.duty)) * P.tones[k].second * 0.5f;
        }
      x = std::tanh(x * P.drive) / std::tanh(P.drive);
      float y = x * P.body;
      for (size_t k = 0; k < F.size(); k++) y += F[k].run(x) * P.formants[k][2] * 2;
      x = lp.run(hp.run(y)) * env;
      if (since < P.hissT) x += hiss.run(w) * P.hissG * (1 - since / P.hissT) * 4;
    }
    if (after < P.pfffT) x += pf.run(w) * P.pfffG * (1 - after / P.pfffT);
    buf[i] = x;
  }
  float pk = 1e-4f;
  for (float v : buf) pk = std::max(pk, std::fabs(v));
  s->pcm.resize(N);
  for (size_t i = 0; i < N; i++) s->pcm[i] = int16_t(std::clamp(buf[i] / pk * 0.85f * 32767.f, -32768.f, 32767.f));
  return s;
}
std::vector<std::pair<std::string, HornSpec>> hornSpecs() {
  HornSpec bus{{{218, 1}, {279, 0.85f}}, 6, 0.27f, {{520, 1.4f, 1}, {1150, 2, 0.8f}, {2400, 2.6f, 0.45f}, {3600, 3, 0.18f}}, 0.35f, 130, 7500, 2.4f,
               0.07f, 0.055f, 0.012f, 0.022f, 0.085f, 0.3f, 3800, 0.035f, 0.28f, 0.09f, {}};
  HornSpec train{{{370 * 1.003f, 0.5f}, {440 * 0.996f, 1}, {556, 0.9f}}, 4, 0.36f, {{720, 1.2f, 1}, {1450, 1.8f, 0.7f}, {2900, 2.4f, 0.35f}}, 0.4f, 210, 8500, 1.9f,
                 0.12f, 0.11f, 0.008f, 0.05f, 0.16f, 0.4f, 3000, 0.06f, 0.34f, 0.15f, {}};
  auto with = [](HornSpec h, std::vector<std::pair<float, float>> b) { h.blasts = std::move(b); return h; };
  return {{"bus", with(bus, {{0.02f, 0.85f}})}, {"bus2", with(bus, {{0.02f, 0.22f}, {0.37f, 0.7f}})}, {"bus_short", with(bus, {{0.02f, 0.3f}})},
          {"train", with(train, {{0.03f, 1.5f}, {1.85f, 0.5f}})}, {"train_long", with(train, {{0.03f, 2.4f}})}, {"train_short", with(train, {{0.03f, 0.45f}})}};
}
} // namespace

// ==================================================================================================== game thread
Audio::Audio() : mx_(std::make_unique<Mixer>()) {}
Audio::~Audio() {
  if (loader_.joinable()) loader_.join();
  if (mx_) {
    for (Deck* d : mx_->decks) { stb_vorbis_close(d->vb); delete d; }
    for (stb_vorbis* v : mx_->graveyard) stb_vorbis_close(v);
  }
}

bool Audio::start(platform::Platform& p, const AssetPaths& paths) {
  plat_ = &p;
  paths_ = &paths;
  Mixer* m = mx_.get();
  running_ = p.openAudio(kRate, 2, [m](float* out, int frames, int ch) { m->render(out, frames, ch); });
  if (!running_) return false;
  loader_ = std::thread([this] { loadAll(); });
  return true;
}

void Audio::stop(platform::Platform& p) {
  if (running_) p.closeAudio();
  running_ = false;
  if (loader_.joinable()) loader_.join();
}

void Audio::waitLoaded() { if (loader_.joinable()) loader_.join(); }

void Audio::loadAll() {
  auto t0 = std::chrono::steady_clock::now();
  std::string root = paths_->dataRoot + "/audio/";
  auto decode = [&](const std::string& rel) -> std::shared_ptr<Sample> {
    std::vector<uint8_t> b;
    if (!plat_->readFile(root + rel + ".ogg", b) || b.empty()) return nullptr;
    int ch = 0, rate = 0;
    short* out = nullptr;
    int n = stb_vorbis_decode_memory(b.data(), int(b.size()), &ch, &rate, &out);
    if (n <= 0 || !out) return nullptr;
    auto s = std::make_shared<Sample>();
    s->rate = rate;
    s->pcm.resize(size_t(n));
    if (ch == 1) std::memcpy(s->pcm.data(), out, size_t(n) * 2);
    else for (int i = 0; i < n; i++) { int acc = 0; for (int c = 0; c < ch; c++) acc += out[i * ch + c]; s->pcm[size_t(i)] = int16_t(acc / ch); }
    free(out);
    return s;
  };
  // the horns first (they need no files)
  for (auto& [k, spec] : hornSpecs()) {
    auto s = renderHorn(spec);
    std::lock_guard<std::mutex> lk(bankMu_);
    bank_["horn_" + k] = s;
  }
  int missing = 0;
  for (const char* n : kSfx) {
    if (!running_) return;
    auto s = decode(std::string("sfx/") + n);
    if (!s) { failed_++; missing++; continue; }
    std::string name = n;
    if (isLoop(name)) loopify(*s, name.rfind("eng_", 0) == 0 ? std::clamp(float((s->seconds() - 0.12) * 0.25), 0.03f, 0.12f) : 0.35f);
    std::lock_guard<std::mutex> lk(bankMu_);
    bank_[name] = s;
    loaded_++;
  }
  for (const char* n : kVoice) {
    if (!running_) return;
    auto s = decode(std::string("voice/") + n);
    if (!s) { failed_++; missing++; continue; }
    std::lock_guard<std::mutex> lk(bankMu_);
    bank_[std::string("voice:") + n] = s;
    voiceLines_++;
  }
  loadSeconds_ = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
  if (missing == int(std::size(kSfx) + std::size(kVoice)))
    SL_WARN("audio: no recordings in %s (built without ffmpeg?): the synthesized sounds play instead", root.c_str());
  else
    SL_INFO("audio: %d sound effects and %d announcer lines decoded in %.2f s (%d missing)", loaded_.load(), voiceLines_.load(), loadSeconds_.load(), missing);
  loadDone_ = true;
}

std::shared_ptr<const Sample> Audio::sample(const std::string& name) const {
  std::lock_guard<std::mutex> lk(bankMu_);
  auto it = bank_.find(name);
  return it == bank_.end() ? nullptr : it->second;
}

void Audio::setVolumes(float master, float music, float sfx, float voice) {
  std::lock_guard<std::mutex> lk(mx_->mu);
  mx_->vol[0] = std::clamp(master, 0.f, 1.f); mx_->vol[1] = std::clamp(music, 0.f, 1.f);
  mx_->vol[2] = std::clamp(sfx, 0.f, 1.f); mx_->vol[3] = std::clamp(voice, 0.f, 1.f);
}
void Audio::setFocused(bool focused, bool muteUnfocused) {
  std::lock_guard<std::mutex> lk(mx_->mu);
  mx_->muteTarget = focused || !muteUnfocused ? 1.f : 0.f;
}
void Audio::setPaused(bool p) { paused_ = p; }

void Audio::setListener(const dvec3& pos, const vec3& fwd) {
  lpos_ = pos;
  vec3 f = glm::length(vec2(fwd.x, fwd.z)) > 1e-4f ? glm::normalize(vec3(fwd.x, 0, fwd.z)) : vec3(0, 0, 1);
  lfwd_ = f;
  lright_ = vec3(-f.z, 0, f.x);
}

void Audio::spatial(const dvec3& p, float ref, float rolloff, float& gain, float& pan, float& lp) const {
  vec3 d = vec3(p - lpos_);
  float dist = glm::length(d);
  gain = ref / (ref + rolloff * (std::max(dist, ref) - ref));   // Web Audio 'inverse'
  if (dist > 1e-3f) {
    float side = glm::dot(d / dist, lright_);
    pan = std::clamp(side * 0.85f, -0.85f, 0.85f) * std::min(1.f, dist / 3.f);
  } else pan = 0;
  lp = dist > 30 ? std::clamp(20000.f / (1 + (dist - 30) / 120), 900.f, 20000.f) : 0;
}

bool Audio::shot(const std::string& name, const Shot& o) {
  if (!running_ || o.vol <= 0) return running_ && sample(name) != nullptr;
  auto s = sample(o.bus == 2 ? "voice:" + name : name);
  if (!s) return false;
  Cmd c;
  c.p.s = s;
  c.p.bus = uint8_t(o.bus);
  c.p.vol = o.vol; c.p.rate = o.rate; c.p.delay = o.delay; c.p.offset = o.offset; c.p.dur = o.dur; c.p.lp = o.lp; c.p.hp = o.hp;
  if (o.sprite != -2 || !o.pick.empty()) {
    auto it = sprites().find(name);
    if (it != sprites().end()) {
      const auto& S = it->second;
      int i = !o.pick.empty() ? o.pick[size_t(rnd(0, float(o.pick.size()) - 0.001f))] : o.sprite >= 0 ? o.sprite : int(rnd(0, float(S.size()) - 0.001f));
      i = std::clamp(i, 0, int(S.size()) - 1);
      c.p.offset = S[size_t(i)].o; c.p.dur = S[size_t(i)].d + 0.06f; c.p.vol *= spriteGain(name, i);
    }
  }
  if (o.at) {
    float g, pan, lp;
    spatial(*o.at, o.ref, o.rolloff, g, pan, lp);
    if (g < 0.003f) return true;
    c.p.vol *= g; c.p.pan = pan;
    if (lp > 0) c.p.lp = c.p.lp > 0 ? std::min(c.p.lp, lp) : lp;
  }
  shots_++;
  std::lock_guard<std::mutex> lk(mx_->mu);
  mx_->queue.push_back(std::move(c));
  return true;
}

void Audio::tone(float f, float dur, int wave, float vol, float slide, float delay, const dvec3* at) {
  if (!running_) return;
  Cmd c;
  c.p.src = 1; c.p.wave = uint8_t(wave); c.p.f0 = f; c.p.f1 = f * (slide > 0 ? slide : 1); c.p.dur = dur; c.p.vol = vol; c.p.delay = delay; c.p.atk = 0.002f;
  if (at) { float g, pan, lp; spatial(*at, 12, 1, g, pan, lp); c.p.vol *= g; c.p.pan = pan; }
  synth_++;
  std::lock_guard<std::mutex> lk(mx_->mu);
  mx_->queue.push_back(std::move(c));
}
void Audio::burst(float dur, float freq, float vol, int filt, float q, float delay, float sweep, const dvec3* at) {
  if (!running_) return;
  Cmd c;
  c.p.src = 2; c.p.filt = uint8_t(filt); c.p.f0 = freq; c.p.f1 = freq * sweep; c.p.q = q; c.p.dur = dur; c.p.vol = vol; c.p.delay = delay;
  if (at) { float g, pan, lp; spatial(*at, 12, 1, g, pan, lp); c.p.vol *= g; c.p.pan = pan; }
  synth_++;
  std::lock_guard<std::mutex> lk(mx_->mu);
  mx_->queue.push_back(std::move(c));
}
void Audio::sweep(float dur, float f0, float f1, float vol) {
  if (!running_) return;
  Cmd c;
  c.p.src = 2; c.p.filt = Biquad::BP; c.p.f0 = f0; c.p.f1 = f1; c.p.q = 1.2f; c.p.dur = dur; c.p.vol = vol; c.p.sweepEnv = true;
  synth_++;
  std::lock_guard<std::mutex> lk(mx_->mu);
  mx_->queue.push_back(std::move(c));
}

void Audio::play(const std::string& name, float amount, const dvec3* at) {
  if (!running_) return;
  float a = std::clamp(std::isfinite(amount) ? amount : 1.f, 0.f, 1.f);
  Shot s;
  s.at = at;
  auto sh = [&](const char* n, float vol, float rate = 1) { Shot o = s; o.vol = vol; o.rate = rate; return shot(n, o); };
  if (name == "beep") { if (!sh("beep", 0.42f)) tone(660, 0.25f, 1, 0.12f); }
  else if (name == "go") { if (!sh("beep_go", 0.45f)) tone(1320, 0.6f, 1, 0.14f); }
  else if (name == "gate") { if (!sh("ding", 0.26f, 1.12f)) tone(1800, 0.06f, 0, 0.08f); }
  else if (name == "miss") { if (!sh("buzzer", 0.22f)) tone(220, 0.35f, 2, 0.1f, 0.6f); }
  else if (name == "finish") {
    if (!sh("beep_go", 0.4f, 1.19f)) { tone(880, 0.2f, 3, 0.2f); tone(1175, 0.4f, 3, 0.2f, 1, 0.16f); }
    if (musicCtx_ == "race") play("crowd", 0.9f);
  } else if (name == "crowd") {
    bool roar = rnd(0, 1) < 0.4f && sample("crowd_roar");
    if (!sh(roar ? "crowd_roar" : "crowd", 0.5f * std::max(0.3f, a), rnd(0.97f, 1.03f))) sweep(1.6f, 400, 1200, 0.08f * a);
  } else if (name == "horn") { if (!sh("horn", 0.3f * a)) tone(440, 0.8f, 2, 0.06f); }
  else if (name == "cash") { if (!sh("cash", 0.42f)) { tone(1500, 0.08f, 1, 0.08f); tone(2200, 0.25f, 1, 0.08f, 1, 0.07f); } }
  else if (name == "click") { if (!sh("click", 0.3f)) tone(900, 0.04f, 0, 0.08f); }
  else if (name == "tick") { if (!sh("tick", 0.07f, rnd(0.97f, 1.03f))) tone(1400, 0.03f, 0, 0.04f); }
  else if (name == "error") { if (!sh("error", 0.3f)) tone(180, 0.25f, 1, 0.08f); }
  else if (name == "step") {
    Shot o = s; o.sprite = -1; o.vol = rnd(0.3f, 0.42f); o.rate = rnd(0.92f, 1.08f);
    if (!shot("step", o)) burst(0.09f, 900 + rnd(0, 400), 0.12f, Biquad::LP, 0.7f, 0, 1, at);
  } else if (name == "land") {
    float v = std::max(0.1f, a);
    Shot o = s; o.sprite = -1; o.vol = 0.22f + 0.6f * v; o.rate = rnd(1.12f, 1.2f) - 0.25f * v; o.lp = 2500 + 9000 * v;
    if (shot("land", o)) {
      if (v > 0.45f) { Shot b = s; b.vol = (v - 0.45f) * 1.1f; b.rate = rnd(0.95f, 1.05f); b.lp = 1800; shot("bodyfall_heavy", b); }
      tone(62 + 30 * (1 - v), 0.14f + v * 0.2f, 0, 0.08f + v * 0.22f, 0.55f, 0, at);
    } else {
      tone(68 + 40 * (1 - v), 0.16f + v * 0.22f, 0, 0.2f + v * 0.5f, 0.55f, 0, at);
      burst(0.1f + v * 0.18f, 650 + v * 550, 0.16f + v * 0.36f, Biquad::LP, 0.7f, 0, 1, at);
      burst(0.07f + v * 0.1f, 2600, 0.05f + v * 0.12f, Biquad::HP, 0.7f, 0, 1, at);
    }
  } else if (name == "jump") {
    if (sh("swish", 0.16f, rnd(1.2f, 1.35f))) { Shot o = s; o.sprite = -1; o.vol = 0.18f; o.rate = 1.1f; shot("step", o); }
    else burst(0.15f, 2500, 0.12f, Biquad::HP);
  } else if (name == "pop") {
    float v = std::max(0.2f, a);
    if (sh("swish", 0.08f + 0.16f * v, 1.0f + 0.3f * v)) { Shot o = s; o.sprite = -1; o.vol = 0.12f + 0.14f * v; o.rate = 1.45f; o.hp = 300; shot("land", o); }
    else { burst(0.07f, 1000, 0.16f + 0.14f * v); tone(150, 0.1f, 3, 0.06f + 0.07f * v, 1.7f); sweep(0.28f, 500, 2400, 0.05f + 0.08f * v); }
  } else if (name == "spin") { if (!sh("swish", 0.06f + 0.14f * a, rnd(0.8f, 0.95f) + 0.2f * a)) sweep(0.4f, 380, 2600, 0.05f + 0.1f * a); }
  else if (name == "trick") {
    float v = 0.1f + 0.14f * a;
    if (sh("ding", v)) { Shot o = s; o.vol = v * 0.85f; o.rate = 1.5f; o.delay = 0.085f; shot("ding", o); }
    else { tone(1046.5f, 0.3f, 0, 0.035f + 0.045f * a); tone(1568, 0.55f, 0, (0.035f + 0.045f * a) * 0.85f, 1, 0.085f); }
  } else if (name == "thud") {
    Shot o = s; o.vol = 0.2f + 0.55f * a; o.rate = rnd(0.9f, 1.1f); o.lp = 1500 + 6000 * a;
    if (!shot("bodyfall", o)) { tone(58, 0.22f, 0, 0.3f * a, 0.6f, 0, at); burst(0.14f, 520, 0.22f * a, Biquad::LP, 0.7f, 0, 1, at); }
  } else if (name == "crash") {
    if (sh("bodyfall_heavy", 0.85f)) { sh("snow_burst", 0.55f, rnd(0.95f, 1.08f)); tone(55, 0.35f, 0, 0.25f, 0.6f, 0, at); }
    else { burst(0.7f, 400, 0.6f); burst(0.5f, 2000, 0.25f, Biquad::HP); }
    if (musicCtx_ == "race") announce("wipeout", 0.35f);
  } else if (name == "board") { if (!sh("lift_clunk", 0.5f)) tone(140, 0.5f, 0, 0.3f, 0.7f); }
  else if (name == "whoosh") { if (!sh("whoosh", 0.6f)) sweep(0.55f, 300, 3200, 0.35f); }
  else if (name == "slam") { if (!sh("slam", 0.95f)) { tone(58, 1.4f, 0, 0.9f, 0.5f); tone(110, 0.5f, 3, 0.4f, 0.4f); burst(0.9f, 900, 0.7f); } }
  else if (name == "chime") { if (!sh("chime", 0.5f)) { const float F[4] = {1568, 2093, 2637, 3136}; for (int i = 0; i < 4; i++) tone(F[i], 1.6f, 0, 0.07f, 1, i * 0.09f); } }
  else if (name == "soft") { Shot o = s; o.vol = 0.32f; o.rate = 0.75f; o.lp = 3200; if (!shot("chime", o)) { tone(392, 1.6f, 0, 0.08f); tone(523, 1.4f, 0, 0.07f, 1, 0.12f); } }
}

void Audio::impact(const std::string& kind, float amount, const dvec3* at) {
  if (!running_) return;
  float a = std::clamp(std::isfinite(amount) ? amount : 0.5f, 0.08f, 1.f);
  bool big = a > 0.55f;
  float lp = 1800 + 16000 * a * a, heavy = 1.04f - 0.1f * a;
  auto S = [&](float vol, float rate, float lpv = 0, float delay = 0, int sprite = -2, std::vector<int> pick = {}) {
    Shot o; o.at = at; o.vol = vol; o.rate = rate; o.lp = lpv; o.delay = delay; o.sprite = sprite; o.pick = std::move(pick); return o;
  };
  auto sub = [&](float f0, float f1, float v, float d) { tone(f0, d, 0, v, f1 / f0, 0, at); };
  bool body = car_.on && a > 0.3f;
  auto bodyHit = [&]() { if (body) shot("metal_hit", S(0.1f + 0.3f * a, rnd(0.78f, 0.92f), 2500 + 4000 * a, 0, -1)); };
  if (kind == "car") {
    if (big) { carCrash(a, at); return; }
    if (shot("metal_hit", S(0.3f + 0.6f * a, rnd(0.95f, 1.1f) * heavy, lp, 0, -1))) { sub(90, 45, 0.25f * a, 0.25f); return; }
    tone(70, 0.25f, 0, 0.5f * a, 40.f / 70); burst(0.18f, 700, 0.45f * a, Biquad::BP, 2);
  } else if (kind == "tree") {
    if (shot("wood_crack", S(0.45f + 0.55f * a, rnd(0.92f, 1.06f) * heavy, lp, 0, -1, {0, 1, 2}))) {
      if (big) shot("wood_crack", S(0.65f * a, rnd(0.9f, 1), lp, rnd(0.05f, 0.1f), -1, {3}));
      shot("branches", S(0.5f + 0.7f * a, rnd(0.9f, 1.1f), 0, rnd(0.03f, 0.07f), -1));
      if (a > 0.3f) shot("snow_burst", S(0.35f * a, rnd(0.9f, 1.05f), 1600, rnd(0.18f, 0.3f)));
      sub(85, 42, 0.45f * a, 0.3f);
      bodyHit();
      return;
    }
    tone(85, 0.3f, 0, 0.6f * a, 45.f / 85); burst(0.09f, 1800, 0.55f * a, Biquad::BP, 3); burst(0.5f, 3500, 0.12f * a, Biquad::HP, 0.7f, 0.05f);
  } else if (kind == "building") {
    if (sample("debris")) {
      shot("bodyfall_heavy", S(0.5f + 0.5f * a, rnd(0.8f, 0.9f), 900));
      shot("debris", S((big ? 0.55f : 0.22f) * (0.5f + a), rnd(0.95f, 1.05f) * heavy, big ? lp : 1500));
      sub(62, 30, 0.7f * a, 0.45f);
      bodyHit();
      return;
    }
    tone(60, 0.5f, 0, 0.85f * a, 0.5f); burst(0.35f, 500, 0.55f * a, Biquad::LP, 0.8f);
  } else if (kind == "rock") {
    if (shot("rock_hit", S(0.45f + 0.55f * a, rnd(0.82f, 0.95f) * heavy, lp))) {
      if (big) shot("rock_hit", S(0.3f * a, rnd(0.6f, 0.7f), 2500, rnd(0.06f, 0.1f)));
      sub(120, 60, 0.35f * a, 0.2f);
      bodyHit();
      return;
    }
    burst(0.12f, 900, 0.7f * a, Biquad::BP, 8); tone(140, 0.18f, 0, 0.4f * a, 90.f / 140);
  } else if (kind == "metal") {
    if (shot("metal_clang", S(0.35f + 0.55f * a, rnd(0.85f, 1.05f) * heavy, lp, 0, -1))) {
      if (a > 0.35f) shot("metal_scrape", S(0.55f * a, rnd(0.9f, 1.05f), lp, 0.03f));
      bodyHit();
      return;
    }
    const float F[4][2] = {{420, 0.3f}, {1130, 0.18f}, {1870, 0.12f}, {2710, 0.07f}};
    for (auto& f : F) tone(f[0], 0.9f, 0, f[1] * a, 0.995f);
  } else if (kind == "net") {
    if (shot("snow_thump", S(0.25f + 0.35f * a, rnd(0.75f, 0.85f), 900, 0, -1))) { burst(0.3f, 260, 0.35f * a); return; }
    burst(0.3f, 260, 0.45f * a); burst(0.25f, 900, 0.08f * a, Biquad::BP, 0.8f);
  } else {
    if (shot("snow_thump", S(0.4f + 0.6f * a, rnd(0.9f, 1.05f) * heavy, 1500 + 9000 * a, 0, -1))) {
      if (big) shot("snow_burst", S(0.4f * a, rnd(0.95f, 1.08f), 0, 0.02f));
      sub(75, 38, 0.4f * a, 0.3f);
      return;
    }
    tone(75, 0.3f, 0, 0.6f * a, 38.f / 75); burst(0.45f, 280, 0.5f * a);
  }
}

void Audio::carCrash(float amount, const dvec3* at) {
  if (!running_) return;
  float a = std::clamp(std::isfinite(amount) ? amount : 1.f, 0.3f, 1.f);
  Shot o; o.at = at;
  o.sprite = -1; o.vol = 0.6f + 0.4f * a; o.rate = rnd(0.92f, 1.02f);
  if (shot("crash_car", o)) {
    o.vol = 0.35f + 0.45f * a; o.rate = rnd(0.95f, 1.08f); o.delay = rnd(0.04f, 0.1f); shot("glass", o);
    o.vol = 0.4f * a; o.rate = rnd(0.7f, 0.8f); o.lp = 3000; o.delay = 0; shot("metal_hit", o);
    if (a > 0.7f) { Shot q; q.at = at; q.vol = 0.4f * a; q.rate = rnd(0.8f, 0.95f); q.delay = rnd(0.25f, 0.4f); q.lp = 6000; shot("metal_scrape", q); }
    tone(72, 0.5f, 0, 0.8f * a, 32.f / 72, 0, at);
    return;
  }
  tone(72, 0.5f, 0, 0.9f * a, 32.f / 72);
  burst(0.45f, 900, 0.8f * a, Biquad::LP, 0.8f);
  for (int i = 0; i < 4; i++) burst(0.12f + rnd(0, 0.1f), 400 + rnd(0, 900), 0.35f * a, Biquad::BP, 2.5f, 0.03f + i * 0.07f);
  for (int i = 0; i < 9; i++) burst(0.05f + rnd(0, 0.08f), 3500 + rnd(0, 4000), 0.16f * a * (1 - i / 12.f), Biquad::HP, 1, 0.08f + rnd(0, 0.45f));
}

void Audio::ramHit(float amount, bool glass) {
  float a = std::clamp(amount, 0.1f, 1.f);
  carCrash(std::max(0.35f, a));
  Shot o; o.vol = 0.3f + 0.45f * a; o.rate = rnd(0.68f, 0.85f); o.delay = 0.04f; o.dur = 0.45f + 0.7f * a; o.lp = 4000 + 3000 * a;
  if (!shot("metal_scrape", o)) sweep(0.5f + 0.6f * a, 2800, 800, 0.16f * a);
  if (glass) { Shot g; g.sprite = -1; g.vol = 0.25f + 0.45f * a; g.rate = rnd(1.0f, 1.18f); g.delay = rnd(0.07f, 0.15f); shot("glass", g); }
  tone(46, 0.55f + 0.35f * a, 0, 0.75f * a, 0.55f);
}

void Audio::police(const std::string& name) {
  if (name == "radio") { burst(0.09f, 2300, 0.07f, Biquad::BP); tone(1720, 0.045f, 1, 0.02f, 1, 0.06f); burst(0.05f, 2600, 0.04f, Biquad::BP); }
  else if (name == "spikes") { burst(0.08f, 900, 0.7f); tone(90, 0.2f, 0, 0.5f, 0.5f); sweep(0.7f, 6000, 2500, 0.12f); }
  else if (name == "star") { tone(660, 0.12f, 1, 0.03f); tone(880, 0.16f, 1, 0.03f, 1, 0.1f); }
  else if (name == "door") { for (int i = 0; i < 3; i++) { tone(78, 0.16f, 0, 0.6f, 0.55f, i * 0.26f); tone(190, 0.05f, 3, 0.12f, 0.6f, i * 0.26f); } tone(55, 0.45f, 0, 0.75f, 0.45f, 1.05f); }
}

void Audio::horn(const std::string& kind, const dvec3* at, float vol) {
  if (!running_) return;
  bool train = kind.rfind("train", 0) == 0;
  float d = at ? float(glm::length(*at - lpos_)) : 0.f;
  float ref = train ? 70.f : 24.f, base = std::clamp(vol, 0.f, 1.5f) * (train ? 0.62f : 0.5f);
  float g = base / (1 + std::pow(d / ref, 1.3f));
  float pan = 0, gg, lpd;
  if (at) spatial(*at, ref, 1, gg, pan, lpd);
  float air = std::clamp(17000 / (1 + d / 80), 700.f, 17000.f);
  auto s = sample("horn_" + kind);
  if (!s) { Shot o; o.vol = 0.3f * std::clamp(g * 2, 0.1f, 1.f); o.rate = train ? 1.2f : 0.8f; o.lp = air; if (!shot("horn", o)) tone(train ? 440.f : 220.f, 0.8f, 2, 0.06f); return; }
  auto push = [&](float gain, float delay, float lp) {
    Cmd c; c.p.s = s; c.p.vol = gain; c.p.pan = pan; c.p.delay = delay; c.p.lp = lp;
    std::lock_guard<std::mutex> lk(mx_->mu);
    mx_->queue.push_back(std::move(c));
  };
  push(g * 1.2f, 0, air < 16000 ? air : 0);
  // the valley's echo: later, darker, more of it the farther off the horn is
  float wet = base * (train ? 0.34f : 0.22f) * (0.35f + 0.65f * std::clamp(d / 250, 0.f, 1.f)) / (1 + std::pow(d / (ref * 2.6f), 1.1f));
  const float E[4][2] = {{0.42f, 0.5f}, {0.78f, 0.36f}, {1.27f, 0.26f}, {1.9f, 0.16f}};
  for (auto& e : E) push(wet * e[1] * 1.2f, e[0], std::min(air, 4000.f / (1 + e[0])));
  shots_++;
}

bool Audio::announce(const std::string& key, float delay, float vol) {
  if (!running_) return false;
  std::string k = key;
  if (k == "3") k = "three"; else if (k == "2") k = "two"; else if (k == "1") k = "one";
  else if (k == "personalbest" || k == "personal-best") k = "pb";
  else if (k == "place1") k = "first"; else if (k == "place2") k = "second"; else if (k == "place3") k = "third";
  else if (k == "legacy-world-downhill" || k == "downhill") k = "alpine"; else if (k == "ice-canyon") k = "icecanyon";
  else if (k == "big-air" || k == "big-air-line") k = "bigair";
  auto s = sample("voice:" + k);
  if (!s) return false;
  Cmd stop; stop.t = Cmd::Stop; stop.id = -77; stop.tau = 0.02f;   // the line being spoken stops
  Cmd c; c.id = -77; c.p.s = s; c.p.bus = 2; c.p.vol = vol; c.p.delay = delay;
  shots_++;
  std::lock_guard<std::mutex> lk(mx_->mu);
  mx_->queue.push_back(stop);
  mx_->queue.push_back(std::move(c));
  return true;
}

void Audio::paGong() { const float F[3] = {784, 659, 523}; for (int i = 0; i < 3; i++) tone(F[i], 1.1f, 0, 0.08f, 1, i * 0.32f); }

void Audio::carStart(bool electric) {
  Shot o; o.pick = {1}; o.vol = 0.5f; o.delay = 0.35f;
  shot("car_door", o);
  if (electric) { tone(659, 0.22f, 0, 0.05f); tone(988, 0.35f, 0, 0.045f, 1, 0.12f); }
}
void Audio::carDoor(bool open) { Shot o; o.pick = {open ? 0 : 1}; o.vol = open ? 0.4f : 0.45f; shot("car_door", o); }

void Audio::setState(const State& s) { st_ = s; }
void Audio::setCar(const Car& c) { car_ = c; }
void Audio::setLiftNear(float level) { liftNear_ = level; }

void Audio::setSled(bool on, float rpm, float load, float speed) {
  std::lock_guard<std::mutex> lk(mx_->mu);
  Inst& I = mx_->inst;
  float live = on && !paused_ ? 1.f : 0.f;
  I.sledGain = live * 0.55f;
  I.sledF = 38 + 150 * rpm;
  I.sledLp = 380 + 2400 * rpm * (0.45f + 0.55f * load);
  I.sledEng = 0.09f + 0.12f * load;
  I.sledRf = 700 + 1600 * rpm;
  I.sledRasp = 0.02f + 0.05f * load * rpm;
  I.sledTrack = std::min(0.35f, speed / 30) * 0.5f;
  I.sledTf = 160 + speed * 9;
}
void Audio::setSiren(bool on, const dvec3& pos, float doppler) {
  float g = 0, pan = 0, lp = 0;
  float dist = float(glm::length(pos - lpos_));
  if (on) spatial(pos, 12, 1, g, pan, lp);
  std::lock_guard<std::mutex> lk(mx_->mu);
  Inst& I = mx_->inst;
  I.sirenGain = on && !paused_ ? 0.9f / (1 + std::pow(dist / 35, 1.3f)) : 0.f;
  I.sirenAir = 9000 / (1 + dist / 90);
  I.sirenDoppler = doppler;
  I.sirenPan = pan;
}
void Audio::setChopper(bool on, const dvec3& pos, float doppler) {
  float g = 0, pan = 0, lp = 0;
  float dist = float(glm::length(pos - lpos_));
  if (on) spatial(pos, 12, 1, g, pan, lp);
  std::lock_guard<std::mutex> lk(mx_->mu);
  Inst& I = mx_->inst;
  I.chopGain = on && !paused_ ? 1.6f / (1 + std::pow(std::max(0.f, dist) / 55, 1.3f)) : 0.f;
  I.chopDoppler = doppler;
  I.chopLp = 400 + 9000 / (1 + dist / 60);
  I.chopPan = pan;
}

void Audio::engineLoops(const std::string& profile) {
  if (engProfile_ == profile && !eng_.empty()) return;
  for (auto& e : eng_) { Cmd c; c.t = Cmd::Stop; c.id = e.id; c.tau = 0.1f; std::lock_guard<std::mutex> lk(mx_->mu); mx_->queue.push_back(c); }
  eng_.clear();
  engProfile_ = profile;
  std::string file;
  std::vector<float> rpms;
  engineRec(profile, file, rpms);
  std::vector<std::shared_ptr<const Sample>> ss;
  for (size_t i = 0; i < rpms.size(); i++) { auto s = sample("eng_" + file + "_" + std::to_string(i)); if (!s) return; ss.push_back(s); }
  static int nextId = 1000;
  for (size_t i = 0; i < ss.size(); i++) {
    Cmd c; c.id = ++nextId; c.p.s = ss[i]; c.p.loop = true; c.p.vol = 0; c.p.offset = -rnd(0, float(ss[i]->seconds())); c.tau = 0.04f;
    eng_.push_back({c.id, rpms[i]});
    std::lock_guard<std::mutex> lk(mx_->mu);
    mx_->queue.push_back(std::move(c));
  }
}

void Audio::ensureLoops() {
  auto start = [&](int& id, const char* name, float lp, float hp) {
    if (id) return;
    auto s = sample(name);
    if (!s) return;
    static int next = 100;
    Cmd c; c.id = id = ++next; c.p.s = s; c.p.loop = true; c.p.vol = 0; c.p.lp = lp; c.p.hp = hp; c.p.offset = -rnd(0, float(s->seconds()) * 0.9f);
    std::lock_guard<std::mutex> lk(mx_->mu);
    mx_->queue.push_back(std::move(c));
  };
  start(loopCarve_, "ski_carve", 6000, 0);
  start(loopScrape_, "ski_scrape", 0, 300);
  start(loopPowder_, "ski_powder", 1500, 0);
  start(loopRush_, "wind_rush", 1200, 0);
  start(loopMountain_, "wind_mountain", 0, 90);
  start(loopHum_, "lift_hum", 2400, 0);
}

int Audio::pickTrack(const std::string& c) {
  const auto& list = musicLists().at(c);
  auto& recent = recent_[c];
  std::vector<int> pool;
  for (int i = 0; i < int(list.size()); i++) if (!list[size_t(i)].once) pool.push_back(i);
  int keep = std::min(3, int(pool.size()) >> 1);
  std::vector<int> cand;
  for (int i : pool) {
    bool avoid = false;
    for (int k = 0; k < keep && k < int(recent.size()); k++) if (recent[recent.size() - 1 - size_t(k)] == i) avoid = true;
    if (!avoid) cand.push_back(i);
  }
  if (cand.empty()) cand = pool;
  float total = 0;
  for (int i : cand) total += list[size_t(i)].w;
  float r = rnd(0, total);
  int pick = cand.back();
  for (int i : cand) { r -= list[size_t(i)].w; if (r < 0) { pick = i; break; } }
  recent.push_back(pick);
  if (recent.size() > 4) recent.erase(recent.begin());
  return pick;
}

void Audio::startTrack(int idx, float fadeIn) {
  const auto& list = musicLists().at(musicCtx_);
  const Track& t = list[size_t(idx)];
  deckTrack_ = idx;
  std::vector<uint8_t> b;
  if (!plat_->readFile(paths_->dataRoot + "/audio/music/" + t.name + ".ogg", b) || b.empty()) return;
  auto data = std::make_shared<std::vector<uint8_t>>(std::move(b));
  int err = 0;
  stb_vorbis* vb = stb_vorbis_open_memory(data->data(), int(data->size()), &err, nullptr);
  if (!vb) { SL_WARN("audio: could not open music %s (%d)", t.name, err); return; }
  static int deckId = 0;
  Cmd c; c.t = Cmd::Deck; c.vb = vb; c.data = data; c.deck = curDeck_ = ++deckId;
  c.level = musicLevel(musicCtx_) * (std::string(t.name) == "menu_hitech" ? 1.35f : 1.f);
  c.fade = fadeIn;
  tracks_++;
  std::lock_guard<std::mutex> lk(mx_->mu);
  mx_->nearEndSec = t.once ? 0.05f : 2.5f;
  mx_->deckEnding = 0;
  mx_->queue.push_back(std::move(c));
}

void Audio::music(const std::string& context) {
  std::string c = musicLists().count(context) ? context : std::string();
  if (c == musicCtx_) return;
  musicCtx_ = c;
  if (!running_) return;
  { Cmd f; f.t = Cmd::DeckFade; f.deck = 0; f.fade = c == "results" ? 0.5f : 1.4f; std::lock_guard<std::mutex> lk(mx_->mu); mx_->queue.push_back(f); }
  deckTrack_ = -1;
  curDeck_ = 0;
  if (c.empty()) return;
  startTrack(shuffled(c) ? pickTrack(c) : 0, c == "results" ? 0.15f : 1.2f);
}
void Audio::chaseMusic(bool on) {
  if (on) { if (musicCtx_ == "freeride") music("chase"); }
  else if (musicCtx_ == "chase") music("freeride");
}

void Audio::update(double dt) {
  if (!running_) return;
  Mixer& M = *mx_;
  ensureLoops();
  // ---- the playlist: near a track's end, crossfade into the next
  if (!musicCtx_.empty() && deckTrack_ >= 0 && curDeck_ != 0 && M.deckEnding.load() == curDeck_) {
    M.deckEnding = 0;
    const auto& list = musicLists().at(musicCtx_);
    bool once = list[size_t(deckTrack_)].once;
    int i = deckTrack_ + 1;
    if (shuffled(musicCtx_)) i = pickTrack(musicCtx_);
    else if (i >= int(list.size())) { i = 0; for (int k = 0; k < int(list.size()); k++) if (!list[size_t(k)].once) { i = k; break; } }
    float xf = once ? 0.05f : 2.5f;
    { Cmd f; f.t = Cmd::DeckFade; f.deck = 0; f.fade = xf; std::lock_guard<std::mutex> lk(M.mu); M.queue.push_back(f); }
    startTrack(i, std::max(0.05f, xf));
  }
  // finished decks: their decoders freed here (not on the audio thread)
  std::vector<stb_vorbis*> dead;
  { std::lock_guard<std::mutex> lk(M.mu); dead.swap(M.graveyard); }
  for (stb_vorbis* v : dead) stb_vorbis_close(v);

  // ---- the skier's continuous mix (audio.js setState)
  const State& s = st_;
  float pz = paused_ ? 0.f : 1.f;
  float wind = std::min(1.f, s.speed / 30);
  float gust = s.skiing ? (s.tuck ? 1.12f : 1.f) * (s.air ? 1.2f : 1.f) : 1.f;
  float on = s.skiing && s.grounded ? 1.f : 0.f;
  float edge = std::min(1.f, s.edge / 0.9f), ice = s.ice, slip = std::clamp(s.sideslip, 0.f, 1.5f);
  std::vector<Cmd> cmds;
  auto set = [&](int id, float vol, float rate, float lp, float hp, float tau) {
    if (!id) return;
    Cmd c; c.t = Cmd::Set; c.id = id; c.p.vol = vol * pz; c.p.rate = rate; c.p.lp = lp; c.p.hp = hp; c.tau = tau;
    cmds.push_back(c);
  };
  const float k = 0.12f;
  set(loopRush_, s.indoor ? 0.f : (0.03f + wind * wind * 1.25f) * gust, 0.85f + wind * 0.3f, 500 + wind * wind * 7000, 0, k);
  set(loopMountain_, s.indoor ? 0.f : std::clamp(0.12f + s.snow * 0.3f + s.altitude * 0.0001f + s.weatherWind * 0.16f, 0.f, 0.6f), 1, 0, 90, 0.6f);
  float carveLv = on * std::min(1.2f, s.speed * 0.06f) * (0.55f + edge * 0.45f + slip * 0.35f) * (1 - ice * 0.35f);
  set(loopCarve_, carveLv, 0.8f + std::min(1.f, s.speed / 28) * 0.35f + edge * 0.05f, 2200 + s.speed * 220 + edge * 3000 + ice * 3000, 0, k * 0.5f);
  float scrapeLv = on * std::min(1.4f, std::pow(slip, 1.3f) * s.speed * 0.12f) * (1 + ice * 0.4f);
  set(loopScrape_, scrapeLv, 0.85f + std::min(1.f, s.speed / 25) * 0.25f + ice * 0.25f, 0, 250 + ice * 1800, k * 0.4f);
  set(loopPowder_, on * std::min(1.f, s.speed * 0.04f) * (0.18f + std::clamp(s.powder, 0.f, 1.f) * 0.9f) * (1 - ice), 1, 900 + s.speed * 80, 0, k);
  set(loopHum_, s.riding ? 0.55f : liftNear_ * 0.35f, 1, 2400, 0, 0.5f);

  // ---- the car (audio.js setCar)
  const Car& c = car_;
  bool live = c.on && !paused_;
  if (!c.on && carWasOn_) { carWasOn_ = false; carDoor(true); Shot o; o.pick = {1}; o.vol = 0.45f; o.delay = 0.9f; shot("car_door", o); }
  if (c.on) carWasOn_ = true;
  CarSound P = carSound(c.profile);
  float r = std::max(60.f, c.rpm), cyc = r / 120, fire = cyc * P.cyl, x = std::min(1.f, r / 6500);
  float iceF = c.electric ? 0.f : c.firing;
  if (live && !c.electric) engineLoops(c.profile);
  bool rec = !eng_.empty() && !c.electric;
  float dip = c.shift ? 0.45f : 1.f;
  if (rec) {
    size_t i = 0;
    while (i + 1 < eng_.size() && r > eng_[i + 1].rpm) i++;
    float w = i + 1 < eng_.size() ? std::clamp((r - eng_[i].rpm) / (eng_[i + 1].rpm - eng_[i].rpm), 0.f, 1.f) : 0.f;
    float out = (live ? 1.f : 0.f) * (c.crank > 0 ? 0.f : iceF) * dip * (0.5f + 0.5f * c.load) * 2 * 0.22f * P.vol;   // (ENGINE_REC_LEVEL 2, the car bus 0.22 x level)
    float tone = (1100 + 9000 * c.load * c.load + 2500 * x) * (c.shift ? 0.5f : 1);
    if (c.inside) tone = std::min(tone, 1500.f);
    for (size_t j = 0; j < eng_.size(); j++) {
      float g = j == i ? std::cos(w * kPi / 2) : j == i + 1 ? std::sin(w * kPi / 2) : 0.f;
      Cmd cm; cm.t = Cmd::Set; cm.id = eng_[j].id; cm.p.vol = g * out; cm.p.rate = std::clamp(r / eng_[j].rpm, 0.45f, 2.4f); cm.p.lp = tone; cm.tau = c.shift ? 0.02f : 0.04f;
      cmds.push_back(cm);
    }
  } else if (!eng_.empty()) {
    for (auto& e : eng_) { Cmd cm; cm.t = Cmd::Set; cm.id = e.id; cm.p.vol = 0; cm.p.rate = 1; cm.tau = 0.2f; cmds.push_back(cm); }
  }
  // starter: the recording (cranking, then the catch), the synthesized whir until it loads
  if (c.crank > 0 && live && !c.electric) {
    if (!cranking_) { cranking_ = true; Shot o; o.offset = 1.96f - 0.85f; o.dur = 1.4f; o.vol = 0.66f; if (!shot("car_start", o)) cranking_ = false; }
  } else if (c.crank <= 0) cranking_ = false;
  if (P.turbo > 0 && !c.electric) {
    float want = c.load > 0.3f ? std::min(1.f, x * 1.3f) : 0.f;
    boost_ += (want - boost_) * (want > boost_ ? 0.04f : 0.25f);
    if (lastLoad_ > 0.5f && c.load < 0.2f && boost_ > 0.45f && live) burst(0.35f, 2400, 0.5f * 0.9f * boost_ * P.turbo * 0.22f, Biquad::HP);
  }
  if (c.shift && !lastShift_ && !c.electric && P.pops > 0 && live) burst(0.07f, 650, 0.5f * 0.7f * P.pops * 0.22f, Biquad::BP, 1.2f);
  if (!c.electric && P.pops > 0 && c.load < 0.05f && r > 3200 && live && rnd(0, 1) < 0.06f * P.pops * x) burst(0.04f, 500 + rnd(0, 700), 0.5f * (0.25f + rnd(0, 0.35f)) * 0.22f, Biquad::BP, 1.2f);
  lastShift_ = c.shift; lastLoad_ = c.load;
  {
    std::lock_guard<std::mutex> lk(M.mu);
    Inst& I = M.inst;
    I.paused = paused_ ? 1.f : 0.f;
    I.carBus = live ? 0.22f * P.vol : 0.f;
    I.cabinLp = c.inside ? 1500 : 9000;
    I.synEng = rec ? 0.f : iceF * dip * (0.34f + 0.22f * c.load + 0.12f * x);
    I.engF = cyc;
    I.engLp = P.bright * (180 + r * 0.22f) + c.load * 1500 * P.bright * x + 120;
    I.subF = fire; I.subG = iceF * 0.35f * (1 - x * 0.6f) * (rec ? 0.4f : 1.f);
    float sp = std::max(0.f, c.speed), ev = c.electric ? 1.f : 0.f;
    I.evF = 90 + sp * 52; I.evGain = ev * (0.05f + 0.2f * std::min(1.f, sp / 25) * (0.35f + 0.65f * c.load));
    I.invF = 2400 + sp * 30; I.invGain = ev * (sp > 0.3f ? 0.016f + 0.024f * c.load : 0.006f);
    I.sqGain = 0.38f * std::min(1.f, c.squeal);
    I.hornGain = c.horn && live ? 0.3f : 0.f;
    I.crankGain = c.crank > 0 && live && !c.electric && !cranking_ ? 0.22f * c.crank : 0.f;
    I.crankF = std::max(4.f, (r / 60) * (P.cyl / 2.f));
    I.turboF = 1800 + boost_ * 4200; I.turboGain = c.electric ? 0.f : iceF * boost_ * 0.010f * P.turbo;
    // procedural skiing loops until the recordings are in
    bool haveRec = loopRush_ != 0;
    I.windGain = haveRec ? 0.f : (0.05f + wind * wind * 0.55f) * gust + s.snow * 0.08f + s.weatherWind * 0.1f * (s.indoor ? 0.f : 1.f);
    I.windLp = 300 + wind * 1400;
    I.whistleGain = haveRec ? 0.f : std::max(0.f, wind - 0.4f) * 0.05f * gust; I.whistleF = 900 + wind * 1600;
    I.carveGain = loopCarve_ ? 0.f : on * std::min(0.32f, s.speed * 0.016f) * (0.55f + edge * 0.5f + s.sideslip * 0.5f);
    I.carveF = 1500 + s.speed * 60 + edge * 900;
    I.scrapeGain = loopScrape_ ? 0.f : on * std::min(0.32f, s.sideslip * s.speed * 0.04f) * (1 + ice * 0.6f);
    I.scrapeF = 3200 + ice * 2600;
    I.humGain = loopHum_ ? 0.f : (s.riding ? 0.25f : 0.f);
    I.ambGain = loopMountain_ ? 0.f : (s.indoor ? 0.f : 0.03f);
    for (auto& cm : cmds) M.queue.push_back(std::move(cm));
  }
  (void)dt;
}

Audio::Stats Audio::stats() const {
  Stats s;
  s.device = running_;
  s.samples = loaded_; s.voiceLines = voiceLines_; s.failed = failed_;
  {
    std::lock_guard<std::mutex> lk(bankMu_);
    for (auto& [k, v] : bank_) s.sampleBytes += v->pcm.size() * 2;
  }
  s.framesMixed = mx_->frames.load();
  s.shots = shots_; s.synth = synth_; s.peakVoices = mx_->peakVoices.load(); s.tracksStarted = tracks_;
  if (!musicCtx_.empty() && deckTrack_ >= 0) s.track = musicLists().at(musicCtx_)[size_t(deckTrack_)].name;
  s.peak = mx_->peak.load();
  s.loadSeconds = loadSeconds_;
  return s;
}

} // namespace sl
