// Branded screen transitions (src/ui/transition.js + style.css #transition): the scenes between two places.
//   fade()           a dip to dark and back; while it is dark the round logo shows with a loading circle under it
//   teleport(label)  six white brush strokes paint across the screen, an opaque title card ("WORLD RACING" over
//                    "ICE CANYON", a running bar, the SKI LEGACY mark) stays while the new place streams in, then the
//                    strokes wipe off to the right
// The web game awaits the move behind the cover; here the move has already happened when the transition is asked for,
// so while the cover comes in the renderer holds the last frame (Renderer::holdFrame): the old place stays on screen
// until it is covered, the new one is revealed.
#pragma once
#include "engine/ui.h"
#include <string>

namespace sl {
class AssetPaths;
namespace platform { class Platform; }

class Transition {
public:
  void init(gfx::Device& dev, platform::Platform& plat, const AssetPaths& paths);
  /// a dip to dark (FADE_MS in, the logo and the loading circle, FADE_MS out)
  void fade();
  /// the title card: 'KICKER · Title' or just a title
  void teleport(const std::string& label);
  /// advances the clocks (wall time)
  void update(double dt);
  /// true while anything covers the screen (no auto-pause, no input into the world)
  bool active() const { return kind_ != Kind::None; }
  /// the cover is still coming in: the renderer keeps showing the frame from before the move
  bool holdsFrame() const { return kind_ != Kind::None && t_ < coverTime(); }
  /// the cover is complete and still there (dark, the logo up): what is drawn now is not seen
  bool covered() const { return kind_ != Kind::None && t_ >= coverTime() && t_ < coverTime() + holdTime(); }
  /// draws the overlay over everything (call last, between Ui::begin / end)
  void draw(Ui& ui);
  /// (tests) jumps to a moment of the running transition
  void seek(double t) { t_ = t; }

private:
  enum class Kind { None, Fade, Teleport };
  double coverTime() const;
  double holdTime() const;
  double total() const;
  Kind kind_ = Kind::None;
  double t_ = 0;
  std::string kicker_, title_;
  gfx::Texture logo_{};
};

} // namespace sl
