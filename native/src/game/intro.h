// The boot intro (src/ui/intro.js): the SKI LEGACY logo clip, then the Icecold Studio ident, on black.
//   the clip (src/ui/introclip.js, 4.25 s)  the skier from the logo takes off and rises into his logo pose, the camera
//       whips back to reveal the whole badge on blue, SKI slams in, LEGACY and its rule sweep in under it. The web
//       game draws it on a 2D canvas from the layers in public/intro/clip (bg, backdrop, skier, ski, legacy, clip.json);
//       here the same layers go through the GPU 2D layer (engine/ui) at the drawable's resolution: the camera and the
//       skier's pose, the motion blur (six exposures summed in a render target), the zoom blur (a running average of
//       exposures), powder, speed streaks, flakes, the sun's bloom, the vignette, the light sweep, the impact
//   0.5 s to black, then the ident (src/ui/studioident.js + style.css .sd-*, 2.35 s): the ICECOLD logotype wiped in by
//       a frost edge, the flash-freeze on the hit (audio.js iceHit), a glint, sparks, STUDIO tracking in; 0.55 s out
// Any key, a click or a controller button skips. Then the screen passed as `after` fades up from black (0.5 s).
#pragma once
#include <functional>
#include <string>

namespace sl {
class AssetPaths;
class Audio;
class Ui;
namespace gfx { class Device; }
namespace platform { class Platform; }

struct IntroOptions {
  /// (debug: SKI_LEGACY_DEBUG=introtest with --autotest --png out.png) frames at fixed times -> out_intro_<ms>.png,
  /// nothing else; the times (ms) come from SKI_LEGACY_INTRO_TIMES ("50,150,...") or a default list
  std::string testPng;
  /// what shows once the intro is over (the loading screen): draws its frame, calls `over` (the intro's black veil
  /// lifting, the skip hint) last and presents it
  std::function<void(const std::function<void()>& over)> after;
};

/// Plays the intro in its own loop (the window and the audio are up; the world is not loaded yet).
/// false: the window was closed.
bool playIntro(platform::Platform& plat, gfx::Device& dev, Ui& ui, Audio& audio, const AssetPaths& paths, const IntroOptions& opt);

} // namespace sl
