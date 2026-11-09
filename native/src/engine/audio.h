// Game audio (Phase 7): a port of src/core/audio.js on the platform's audio stream.
//
//   samples   public/audio (CC0 sound effects, the soundtrack, the stadium-PA announcer; CREDITS.txt) converted by the
//             build to Ogg Vorbis in native/data/audio (cmake/ConvertAudio.cmake, ffmpeg) and decoded with stb_vorbis:
//             sound effects and announcer lines into memory (int16, on a loader thread at start-up), music streamed
//   mixer     sfx / music / voice buses -> master (save.volume) -> glue compressor -> soft clipper, the announcer
//             ducking the music (and a close siren too); sample voices with pitch, low / high pass, delay, sprites
//             (variations inside one file), loops crossfaded into themselves (loopify), synthesized voices (tones,
//             filtered noise bursts: the web game's procedural fallbacks) and continuous instruments (the police
//             siren, the helicopter rotor, the snowmobile's two-stroke, the electric car, tyre squeal), air horns
//             rendered once at start-up (horn()), the music decks crossfading through per-context playlists
//   3D        positional sounds: inverse-distance attenuation (refDistance / rolloff like Web Audio's 'inverse'),
//             equal-power panning from the listener's right vector, air absorption (a low pass with distance)
//   threads   the game thread queues commands and parameter snapshots under one short mutex; the audio thread (the
//             platform callback) renders. Nothing outside platform/ opens a device: Platform::openAudio.
// Everything degrades gracefully, as in the web game: a sample that is missing (no ffmpeg at build time, or still
// loading) plays its synthesized version; no audio device -> silent (the game runs on).
#pragma once
#include "core/math.h"
#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

namespace sl {
namespace platform { class Platform; }
class AssetPaths;

namespace audio_detail { struct Mixer; struct Sample; }

class Audio {
public:
  Audio();
  ~Audio();
  /// Opens the stream and starts loading the samples (on a thread). false: no device (silent; calls are no-ops).
  bool start(platform::Platform& p, const AssetPaths& paths);
  void stop(platform::Platform& p);
  bool running() const { return running_.load(); }
  /// (autotest) waits for the loader thread
  void waitLoaded();

  // ---- settings (save.volume, musicVolume, sfxVolume, voiceVolume, muteUnfocused)
  void setVolumes(float master, float music, float sfx, float voice);
  void setFocused(bool focused, bool muteUnfocused);
  void setPaused(bool paused);   // the game paused: the continuous sounds fade, one-shots go on

  // ---- the listener (the camera) for positional sounds
  void setListener(const dvec3& pos, const vec3& forward);

  // ---- the skier's continuous mix (audio.js setState + setSki), every frame
  struct State {
    float speed = 0, sideslip = 0, altitude = 0, snow = 0, weatherWind = 0;
    bool grounded = true, skiing = false, riding = false, indoor = false;
    float edge = 0, ice = 0, powder = 0;
    bool tuck = false, air = false;
  };
  void setState(const State& s);

  // ---- one-shots
  struct Shot {
    float vol = 1, rate = 1, delay = 0, offset = 0, dur = 0, lp = 0, hp = 0;
    int sprite = -2;          // -2: whole file, -1: a random variation, >= 0: that variation
    std::vector<int> pick;    // a random one of these variations
    int bus = 0;              // 0 sfx, 2 voice
    const dvec3* at = nullptr;   // positional (world)
    float ref = 12, rolloff = 1;
  };
  bool shot(const std::string& name, const Shot& o);
  bool shot(const std::string& name, float vol = 1, float rate = 1) { Shot s; s.vol = vol; s.rate = rate; return shot(name, s); }
  /// audio.js play(): beep go gate miss finish crowd horn cash click tick error step land jump pop spin trick thud
  /// crash board whoosh slam chime soft
  void play(const std::string& name, float amount = 1, const dvec3* at = nullptr);
  /// a vehicle hitting something: car tree building rock metal net snow
  void impact(const std::string& kind, float amount, const dvec3* at = nullptr);
  void carCrash(float amount, const dvec3* at = nullptr);
  void ramHit(float amount, bool glass = true);
  /// police.js: radio spikes star door
  void police(const std::string& name);
  /// air horns: bus bus2 bus_short train train_long train_short (rendered once at start-up), at a place or here
  void horn(const std::string& kind, const dvec3* at = nullptr, float vol = 1);
  /// the announcer (voice/<key>): three two one go pb checkpoint first second third gold silver bronze wipeout finish
  /// welcome alpine icecanyon bigair rail_*; ducks the music. false if that line is missing.
  bool announce(const std::string& key, float delay = 0, float vol = 1);
  /// a station PA's three-tone gong (the Express's spoken lines are text-to-speech in the web game: not here)
  void paGong();
  void carStart(bool electric);
  void carDoor(bool open);

  // ---- continuous sources (every frame while they sound; on = false fades them)
  struct Car {
    bool on = false, electric = false, horn = false, shift = false, inside = false;
    float rpm = 800, load = 0, squeal = 0, speed = 0, crank = 0, firing = 1;
    std::string profile = "i4";   // drive.js CAR_SPECS sound: v8 gti i6 i4 v10 i3t v8s
  };
  void setCar(const Car& c);
  void setSled(bool on, float rpm, float load, float speed);
  void setSiren(bool on, const dvec3& pos, float doppler = 1);
  void setChopper(bool on, const dvec3& pos, float doppler = 1);
  /// a lift's motor and cable heard from outside (the nearest station), 0..1
  void setLiftNear(float level);

  // ---- music: menu freeride race results chase, "" = silence (crossfades; safe every frame)
  void music(const std::string& context);
  void chaseMusic(bool on);
  const std::string& musicContext() const { return musicCtx_; }

  /// once per frame: the playlist, the snapshot of every continuous parameter to the audio thread
  void update(double dt);

  struct Stats {
    bool device = false;
    int samples = 0, voiceLines = 0, failed = 0;   // loaded / failed files
    size_t sampleBytes = 0;
    int64_t framesMixed = 0;
    int shots = 0, synth = 0, peakVoices = 0, tracksStarted = 0;
    std::string track;
    float peak = 0;          // the loudest output sample so far (after the clipper)
    double loadSeconds = 0;
  };
  Stats stats() const;

private:
  std::shared_ptr<const audio_detail::Sample> sample(const std::string& name) const;
  void tone(float f, float dur, int wave, float vol, float slide = 1, float delay = 0, const dvec3* at = nullptr);
  void burst(float dur, float freq, float vol, int filt = 1, float q = 0.7f, float delay = 0, float sweep = 1, const dvec3* at = nullptr);
  void sweep(float dur, float f0, float f1, float vol);
  void spatial(const dvec3& p, float ref, float rolloff, float& gain, float& pan, float& lp) const;
  void loadAll();
  void ensureLoops();
  void startTrack(int idx, float fadeIn);
  int pickTrack(const std::string& c);
  void engineLoops(const std::string& profile);

  std::unique_ptr<audio_detail::Mixer> mx_;
  platform::Platform* plat_ = nullptr;
  const AssetPaths* paths_ = nullptr;
  std::atomic<bool> running_{false};
  std::thread loader_;
  mutable std::mutex bankMu_;
  std::unordered_map<std::string, std::shared_ptr<const audio_detail::Sample>> bank_;
  std::atomic<int> loaded_{0}, failed_{0}, voiceLines_{0};
  std::atomic<bool> loadDone_{false};
  std::atomic<double> loadSeconds_{0};
  // listener
  dvec3 lpos_{0};
  vec3 lright_{1, 0, 0}, lfwd_{0, 0, 1};
  // the skier's loops (ids in the mixer), started once their samples are in
  int loopCarve_ = 0, loopScrape_ = 0, loopPowder_ = 0, loopRush_ = 0, loopMountain_ = 0, loopHum_ = 0;
  State st_;
  bool paused_ = false;
  float liftNear_ = 0;
  // car
  Car car_;
  bool carWasOn_ = false, cranking_ = false, lastShift_ = false;
  float boost_ = 0, lastLoad_ = 0;
  std::string engProfile_;
  struct EngLoop { int id = 0; float rpm = 1000; };
  std::vector<EngLoop> eng_;
  // music
  std::string musicCtx_;
  int deckTrack_ = -1, curDeck_ = 0;
  std::unordered_map<std::string, std::vector<int>> recent_;
  uint32_t rng_ = 0x2545F491u;
  float rnd(float lo, float hi) { rng_ ^= rng_ << 13; rng_ ^= rng_ >> 17; rng_ ^= rng_ << 5; return lo + (hi - lo) * float(rng_ & 0xffffff) / float(0x1000000); }
  int shots_ = 0, synth_ = 0, tracks_ = 0;
};

} // namespace sl
