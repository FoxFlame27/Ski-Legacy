// Platform layer: everything the game needs from the OS / console, behind one small interface.
//
// The desktop implementation is SDL2 (platform/sdl/). A Nintendo Switch implementation (platform/switch/, see
// switch_platform.h for the contract) replaces it without touching engine or game code. Nothing outside platform/
// may include SDL or any OS header.
#pragma once
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace sl::platform {

// ---------------------------------------------------------------- keys
// Physical keys, named after the browser's KeyboardEvent.code values the JavaScript game binds (core/bindings.js),
// so the same binding tables work on both sides.
enum class Key : uint8_t {
  Unknown = 0,
  KeyA, KeyB, KeyC, KeyD, KeyE, KeyF, KeyG, KeyH, KeyI, KeyJ, KeyK, KeyL, KeyM, KeyN, KeyO, KeyP, KeyQ, KeyR, KeyS,
  KeyT, KeyU, KeyV, KeyW, KeyX, KeyY, KeyZ,
  Digit0, Digit1, Digit2, Digit3, Digit4, Digit5, Digit6, Digit7, Digit8, Digit9,
  Space, Enter, Escape, Backspace, Tab, ShiftLeft, ShiftRight, ControlLeft, ControlRight, AltLeft, AltRight,
  MetaLeft, MetaRight, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, BracketLeft, BracketRight,
  F1, F2, F3, F4, F5, F6, F7, F8, F9, F10, F11, F12,
  Count
};
/// "KeyW" -> Key::KeyW (Unknown if not a known code).
Key keyFromCode(const std::string& code);
const char* keyCode(Key k);

// ---------------------------------------------------------------- gamepads
// Buttons by POSITION in the W3C "standard" gamepad layout, exactly as core/bindings.js documents them:
//   0 bottom (Xbox A / PS Cross / Switch B)   1 right (B / Circle / A)   2 left (X / Square / Y)   3 top (Y / Triangle / X)
//   4 LB/L1/L  5 RB/R1/R  6 LT/L2/ZL  7 RT/R2/ZR  8 View/Share/Minus  9 Menu/Options/Plus  10 LS  11 RS
//   12 up  13 down  14 left  15 right  16 Xbox/PS/Home
enum class PadFamily : uint8_t { Xbox, PlayStation, Switch };
constexpr int kPadButtons = 17;
struct GamepadState {
  bool connected = false;
  PadFamily family = PadFamily::Xbox;
  float leftX = 0, leftY = 0, rightX = 0, rightY = 0; // -1..1, +Y = down (stick pulled toward you), like the web API
  float buttons[kPadButtons] = {};                    // 0..1 (triggers are analog)
  std::string name;
};

// ---------------------------------------------------------------- window / events
struct WindowDesc {
  std::string title = "Ski Legacy";
  int width = 1280, height = 720;
  bool fullscreen = false;
  bool vsync = true;
  bool hidden = false;
};

struct Events {
  bool quit = false;
  bool resized = false;
  bool focusLost = false;
  bool focusGained = false;   // (Phase 7: the audio mutes while unfocused, when the setting says so)
  float mouseDX = 0, mouseDY = 0, wheel = 0;
  // (Phase 4, menus) the pointer in drawable pixels (top-left origin) while it is not captured, and button edges
  float mouseX = -1, mouseY = -1;
  bool mouseMoved = false;
  uint8_t mouseButtons = 0;                  // held: bit 0 left, 1 right, 2 middle
  uint8_t mousePressed = 0, mouseReleased = 0; // edges this frame (same bits)
  std::vector<Key> pressed, released; // edges this frame (keyboard)
  std::vector<Key> repeated;          // key auto-repeat this frame (menus: held arrows step through lists)
  /// controller buttons that went down this frame (by position, per controller index), from the OS's button events:
  /// a press and release between two frames (a quick tap at a low frame rate) is still seen
  struct PadPress { int pad; int button; };
  std::vector<PadPress> padPressed;
  std::string text;                   // typed text (UTF-8) while text input is on (setTextInput): the layout's letters
  bool toggleFullscreen = false;      // the desktop's fullscreen shortcut (F11, Alt+Enter; Cmd+F on macOS)
};

// ---------------------------------------------------------------- audio
/// Fills `frames` interleaved float frames of `channels` channels. Called on the audio thread.
using AudioCallback = std::function<void(float* out, int frames, int channels)>;

/// The whole platform. One instance, created by createPlatform().
class Platform {
public:
  virtual ~Platform() = default;

  // window + GPU surface (OpenGL 4.1 core context on desktop; an NVN/Vulkan device on console)
  virtual bool createWindow(const WindowDesc& desc) = 0;
  virtual void* glProcAddress(const char* name) = 0;  // GL loader hook (nullptr on non-GL backends)
  virtual void swapBuffers() = 0;
  virtual void drawableSize(int& w, int& h) const = 0;
  virtual void setRelativeMouse(bool on) = 0;   // capture the mouse for looking (the game asks on a click in play)
  virtual bool relativeMouse() const = 0;
  /// (Phase 4, SETTINGS) desktop: borderless fullscreen / windowed, vsync. A console ignores both (always full screen).
  virtual void setFullscreen(bool on) = 0;
  virtual bool fullscreen() const = 0;
  virtual void setVsync(bool on) = 0;

  // input
  virtual void pollEvents(Events& out) = 0;
  virtual bool keyDown(Key k) const = 0;
  virtual int gamepadCount() const = 0;
  virtual void gamepad(int index, GamepadState& out) const = 0;
  /// Rumble: low / high frequency motor strength 0..1 for `ms` milliseconds (HD Rumble on Switch).
  virtual void rumble(int index, float low, float high, uint32_t ms) = 0;
  /// Text entry (a name field, the chat): on while a text field has the focus, off otherwise (SDL turns it on at
  /// start-up on desktop; left on, macOS routes every key through its input method). Typed text arrives in Events::text.
  virtual void setTextInput(bool) {}
  virtual bool textInputActive() const { return false; }
  /// (autotest) a key event pushed through the OS / SDL event queue, seen by the next pollEvents like a real key
  virtual bool pushKey(Key, bool) { return false; }
  /// (autotest) a virtual controller attached / detached (false: not supported), its buttons pressed by position
  virtual bool testPad(bool) { return false; }
  virtual void testPadButton(int, bool) {}

  // time
  virtual double timeSeconds() const = 0;   // monotonic

  // file system: read-only game data (rom: on Switch) and a writable save area (save: on Switch)
  virtual std::string executableDir() const = 0;
  virtual bool readFile(const std::string& path, std::vector<uint8_t>& out) const = 0;
  virtual bool fileExists(const std::string& path) const = 0;
  virtual std::string saveDir() = 0;         // per-user writable directory (created on demand)
  virtual bool writeSave(const std::string& name, const std::vector<uint8_t>& data) = 0;
  virtual bool readSave(const std::string& name, std::vector<uint8_t>& out) = 0;

  // user account (nickname of the signed-in user; the Switch preselects an account at boot)
  virtual std::string userName() const = 0;

  // audio output stream (48 kHz float stereo requested); false if no device (the game runs silent)
  virtual bool openAudio(int sampleRate, int channels, AudioCallback cb) = 0;
  virtual void closeAudio() = 0;

  // (Phase 7) memory in use / the peak so far (resident set; on Switch: the heap the application reserved)
  virtual size_t memoryBytes() const = 0;
  virtual size_t peakMemoryBytes() const = 0;
};

/// Creates the platform for this build (SDL2 on desktop).
std::unique_ptr<Platform> createPlatform();

} // namespace sl::platform
