// The front-end menus and the in-game card dialogs (src/ui/menu.js, the card dialog of src/ui/hud.js, the shops).
//
//   MAIN        PLAY · CONTROLS · STATS · SETTINGS · QUIT (over the live world)
//   PLAY        SINGLEPLAYER · MULTIPLAYER (Phase 6: says so) · BACK; then CHOOSE YOUR SKIER the first time (MAN /
//               WOMAN on the 3D showcase, left / right or drag to turn) and START
//   PAUSE       RESUME · CONTROLS · STATS · SETTINGS · MAIN MENU · RETURN TO VILLAGE · QUIT GAME (Esc / Menu / +)
//   SETTINGS    menu.js SET_ROWS: graphics (the six presets, render scale, shadows, brightness, frame rate limit,
//               fullscreen), audio, controls, camera, HUD, player (skier, account, reset progress)
//   CONTROLS    every action with its keyboard key and controller button (Xbox / PlayStation / Switch glyphs, the
//               connected family or a preview), rebinding by capture, resets, and the reference of what each does
//   STATS       the career
//   DIALOG      the card dialog every shop / counter uses: a title, a line, options with price chips (short of money:
//               greyed), tabs (the outfit shop), close
// Navigation: the D-pad / left stick / arrows / W A S D move the focus (held: repeats), confirm / cancel per family
// (Switch: A right / B bottom), Enter / Space / Esc / Backspace, LB / RB or Q / E switch tabs; the mouse hovers, clicks
// and scrolls. House style: white paint strokes and brush-paper panels, blue italic condensed lettering, red labels.
#pragma once
#include "core/input.h"
#include "core/math.h"
#include "engine/ui.h"
#include "game/economy.h"
#include <functional>
#include <string>
#include <vector>

namespace sl {

/// menu input for one frame (game.cpp buildNav)
struct UiNav {
  bool up = false, down = false, left = false, right = false, confirm = false, cancel = false, menu = false;
  bool tabPrev = false, tabNext = false;
  float wheel = 0;
  vec2 mouse{-1};
  bool mouseMoved = false, click = false, mouseDown = false, rightClick = false;
  vec2 stickL{0}, stickR{0};      // analog (trail map pan)
  float zoomIn = 0, zoomOut = 0;  // triggers / keys held (trail map)
  std::vector<platform::Key> keys;    // keys pressed this frame (rebinding)
  int padButton = -1;                 // a controller button pressed this frame (rebinding)
  bool usingPad = false;
};

/// builds UiNav from the frame's events and the input state (auto-repeat for held directions)
class NavBuilder {
public:
  UiNav build(const platform::Events& ev, platform::Platform& p, const Input& in, double now);
private:
  double heldSince_[4] = {-1, -1, -1, -1}, lastRep_[4] = {0, 0, 0, 0};
};

struct DialogOption {
  std::string label, sub;
  int price = -1;                 // a $ chip (-1: none, 0: FREE)
  std::string state;              // a state chip (ACTIVE, EQUIPPED, DAY PASS...)
  bool disabled = false, secondary = false;
  uint32_t swatch = 0, swatch2 = 0;   // a colour tile (outfits), 0 = none
  std::function<void()> act;
};
struct Dialog {
  std::string kicker, title, say;
  std::vector<std::string> tabs;
  int tab = 0;
  std::vector<DialogOption> options;
  std::function<void(Dialog&)> rebuild;   // called on open, after every choice and on a tab change
  bool keepOpen = false;               // a choice leaves the dialog open (shops)
};

class Menus {
public:
  enum class Screen { None, Main, PlayMode, Showcase, Controls, Stats, Settings, Pause, Dialog, Confirm };
  struct Hooks {
    std::function<void()> start, resume, quit, mainMenu, village;
    std::function<void(const std::string& key)> setting;   // a SETTINGS value changed (already in the save)
    std::function<void(const std::string& id)> character;  // the showcase pick (skier_red / skier_blue)
    std::function<void(bool on)> showcase;                  // the 3D showcase on / off
    std::function<void(float dyaw)> spin;                   // drag / stick: turn the showcase skier
    std::function<void()> bindingsChanged;
    std::function<void()> resetProgress;
    std::function<void(const std::string& text, int kind)> flash;   // kind 0 good, 1 bad, 2 gold
  };

  Menus(Ui& ui, Save& save, Input& input, platform::Platform& plat) : ui_(ui), save_(save), input_(input), plat_(plat) {}
  Hooks hooks;
  bool inGame = false;              // the pause flavour (BACK goes to pause instead of main)

  void open(Screen s, int dir = 1);
  void close();
  bool isOpen() const { return screen_ != Screen::None; }
  Screen screen() const { return screen_; }
  /// opens a card dialog (rebuild() fills it)
  void openDialog(Dialog d);
  bool dialogOpen() const { return screen_ == Screen::Dialog; }
  /// the frame: input, then drawing (call between Ui::begin / end)
  void frame(const UiNav& nav, double dt, double now);
  /// (autotest) the focused item's label, and focusing an item by its label
  std::string focusedLabel() const;
  bool focusLabel(const std::string& label);
  /// (autotest / tests) the settings row index of a key
  float u() const { return u_; }
  std::string loading;              // "Loading the mountain..." while the world builds (main menu spinner)

private:
  struct Item {
    float x = 0, y = 0, w = 0, h = 0;
    std::string label;
    std::function<void()> activate;
    std::function<void(int)> adjust;            // left / right
    std::function<void(float)> clickAt;         // a click at fraction x (sliders, segments)
    bool disabled = false;
    bool inList = false;                        // in the scrolling list (hit only inside its viewport)
  };
  void drawShade(int mode);
  void drawLogo(bool big);
  void drawHints(const std::vector<std::pair<std::string, std::string>>& hints);
  void heading(float x, float y, const std::string& title, const std::string& sub);
  bool button(float x, float y, float minW, float h, float fontSize, const std::string& label, int seed, std::function<void()> act, bool disabled = false);
  void panel(float x, float y, float w, float h);

  void scrMain();
  void scrPlayMode();
  void scrShowcase(const UiNav& nav, double dt);
  void scrPause();
  void scrStats();
  void scrSettings();
  void scrControls();
  void scrDialog();
  void scrConfirm();
  void handle(const UiNav& nav);
  void back();
  void setFocus(int i);
  void controlsCapture(const UiNav& nav);
  void storeBinds();
  void pickChar(int i);

  Ui& ui_;
  Save& save_;
  Input& input_;
  platform::Platform& plat_;
  Screen screen_ = Screen::None;
  std::vector<Item> items_;
  int focus_ = 0, focusPrev_ = -1;
  std::vector<int> focusStack_;
  float u_ = 1, scroll_ = 0, scrollTarget_ = 0, listTop_ = 0, listH_ = 0, contentH_ = 0;
  double t_ = 0, enterT_ = 0;
  int dir_ = 1;
  Dialog dialog_;
  // showcase
  int chi_ = 1;
  vec2 dragLast_{-1};
  // controls
  int ctlCol_ = 0;
  platform::PadFamily ctlFamily_ = platform::PadFamily::Xbox;
  bool ctlFamilyPicked_ = false;
  int captureAction_ = -1, captureCol_ = 0;
  double captureT_ = 0;
  std::string ctlStatus_;
  bool ctlStatusBad_ = false;
  Screen ctlBack_ = Screen::None;
  // confirm
  std::string confirmText_;
  std::function<void()> confirmYes_;
  Screen confirmBack_ = Screen::Settings;
  std::string pendingQuality_;
};

} // namespace sl
