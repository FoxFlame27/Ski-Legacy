// Desktop platform backend: SDL2 (macOS, Windows, Linux).
#include "platform/platform.h"
#include "core/log.h"

#include <SDL.h>
#include <filesystem>
#include <fstream>
#include <memory>
#include <algorithm>
#include <iterator>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#if defined(_WIN32)
#define WIN32_LEAN_AND_MEAN
#define PSAPI_VERSION 2
#include <windows.h>
#include <psapi.h>
#elif defined(__APPLE__)
#include <mach/mach.h>
#include <sys/resource.h>
#else
#include <sys/resource.h>
#endif

namespace sl::platform {
namespace fs = std::filesystem;

// UTF-8 std::string -> path (std::filesystem::u8path is deprecated in C++20)
static fs::path u8(const std::string& s) {
  return fs::path(std::u8string(reinterpret_cast<const char8_t*>(s.data()), s.size()));
}

static Key mapScancode(SDL_Scancode s) {
  if (s >= SDL_SCANCODE_A && s <= SDL_SCANCODE_Z) return Key(int(Key::KeyA) + (s - SDL_SCANCODE_A));
  if (s >= SDL_SCANCODE_1 && s <= SDL_SCANCODE_9) return Key(int(Key::Digit1) + (s - SDL_SCANCODE_1));
  if (s >= SDL_SCANCODE_F1 && s <= SDL_SCANCODE_F12) return Key(int(Key::F1) + (s - SDL_SCANCODE_F1));
  switch (s) {
    case SDL_SCANCODE_0: return Key::Digit0;
    case SDL_SCANCODE_SPACE: return Key::Space;
    case SDL_SCANCODE_RETURN: case SDL_SCANCODE_KP_ENTER: case SDL_SCANCODE_RETURN2: return Key::Enter;
    case SDL_SCANCODE_ESCAPE: return Key::Escape;
    case SDL_SCANCODE_BACKSPACE: return Key::Backspace;
    case SDL_SCANCODE_TAB: return Key::Tab;
    case SDL_SCANCODE_LSHIFT: return Key::ShiftLeft;
    case SDL_SCANCODE_RSHIFT: return Key::ShiftRight;
    case SDL_SCANCODE_LCTRL: return Key::ControlLeft;
    case SDL_SCANCODE_RCTRL: return Key::ControlRight;
    case SDL_SCANCODE_LALT: return Key::AltLeft;
    case SDL_SCANCODE_RALT: return Key::AltRight;
    case SDL_SCANCODE_LGUI: return Key::MetaLeft;
    case SDL_SCANCODE_RGUI: return Key::MetaRight;
    case SDL_SCANCODE_UP: return Key::ArrowUp;
    case SDL_SCANCODE_DOWN: return Key::ArrowDown;
    case SDL_SCANCODE_LEFT: return Key::ArrowLeft;
    case SDL_SCANCODE_RIGHT: return Key::ArrowRight;
    case SDL_SCANCODE_LEFTBRACKET: return Key::BracketLeft;
    case SDL_SCANCODE_RIGHTBRACKET: return Key::BracketRight;
    default: return Key::Unknown;
  }
}
// the standard-layout position (platform.h) of an SDL controller button (-1: none; the triggers are axes)
static int padPosition(int b) {
  switch (b) {
    case SDL_CONTROLLER_BUTTON_A: return 0;
    case SDL_CONTROLLER_BUTTON_B: return 1;
    case SDL_CONTROLLER_BUTTON_X: return 2;
    case SDL_CONTROLLER_BUTTON_Y: return 3;
    case SDL_CONTROLLER_BUTTON_LEFTSHOULDER: return 4;
    case SDL_CONTROLLER_BUTTON_RIGHTSHOULDER: return 5;
    case SDL_CONTROLLER_BUTTON_BACK: return 8;
    case SDL_CONTROLLER_BUTTON_START: return 9;
    case SDL_CONTROLLER_BUTTON_LEFTSTICK: return 10;
    case SDL_CONTROLLER_BUTTON_RIGHTSTICK: return 11;
    case SDL_CONTROLLER_BUTTON_DPAD_UP: return 12;
    case SDL_CONTROLLER_BUTTON_DPAD_DOWN: return 13;
    case SDL_CONTROLLER_BUTTON_DPAD_LEFT: return 14;
    case SDL_CONTROLLER_BUTTON_DPAD_RIGHT: return 15;
    case SDL_CONTROLLER_BUTTON_GUIDE: return 16;
    default: return -1;
  }
}

class SdlPlatform final : public Platform {
public:
  SdlPlatform() {
    // buttons by position (south = A on every controller), as the game's bindings expect
    SDL_SetHint(SDL_HINT_GAMECONTROLLER_USE_BUTTON_LABELS, "0");
    SDL_SetHint(SDL_HINT_JOYSTICK_ALLOW_BACKGROUND_EVENTS, "1");
    // (macOS) the click that focuses the window also counts (it captures the mouse for looking)
    SDL_SetHint(SDL_HINT_MOUSE_FOCUS_CLICKTHROUGH, "1");
    if (SDL_Init(SDL_INIT_VIDEO | SDL_INIT_GAMECONTROLLER | SDL_INIT_EVENTS | SDL_INIT_TIMER) != 0)
      SL_ERROR("SDL_Init: %s", SDL_GetError());
    // SDL2 starts text input with the video subsystem on desktop. Left on, macOS sends every key through its input
    // method (the press-and-hold accent popup on a held letter, dead keys, IME candidates); the game reads keys by
    // position and turns text input on only while a text field has the focus (setTextInput).
    SDL_StopTextInput();
    if (SDL_InitSubSystem(SDL_INIT_HAPTIC) != 0) SL_WARN("no haptics: %s", SDL_GetError());
    freq_ = double(SDL_GetPerformanceFrequency());
    t0_ = SDL_GetPerformanceCounter();
  }
  ~SdlPlatform() override {
    closeAudio();
    for (auto* c : pads_) if (c) SDL_GameControllerClose(c);
    if (testJoy_) SDL_JoystickClose(testJoy_);
    if (ctx_) SDL_GL_DeleteContext(ctx_);
    if (win_) SDL_DestroyWindow(win_);
    SDL_Quit();
  }

  bool createWindow(const WindowDesc& d) override {
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 4);
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 1);
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_CORE);
#ifdef __APPLE__
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_FLAGS, SDL_GL_CONTEXT_FORWARD_COMPATIBLE_FLAG);
#endif
    SDL_GL_SetAttribute(SDL_GL_DOUBLEBUFFER, 1);
    SDL_GL_SetAttribute(SDL_GL_DEPTH_SIZE, 24);
    SDL_GL_SetAttribute(SDL_GL_STENCIL_SIZE, 8);
    Uint32 flags = SDL_WINDOW_OPENGL | SDL_WINDOW_RESIZABLE | SDL_WINDOW_ALLOW_HIGHDPI;
    if (d.fullscreen) flags |= SDL_WINDOW_FULLSCREEN_DESKTOP;
    if (d.hidden) flags |= SDL_WINDOW_HIDDEN;
    win_ = SDL_CreateWindow(d.title.c_str(), SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED, d.width, d.height, flags);
    if (!win_) { SL_ERROR("SDL_CreateWindow: %s", SDL_GetError()); return false; }
    ctx_ = SDL_GL_CreateContext(win_);
    if (!ctx_) { SL_ERROR("OpenGL 4.1 core context: %s", SDL_GetError()); return false; }
    SDL_GL_MakeCurrent(win_, ctx_);
    SDL_GL_SetSwapInterval(d.vsync ? 1 : 0);
    SDL_StopTextInput();   // (window creation can start it again on some backends)
    return true;
  }
  void* glProcAddress(const char* name) override { return SDL_GL_GetProcAddress(name); }
  void swapBuffers() override { SDL_GL_SwapWindow(win_); }
  void drawableSize(int& w, int& h) const override { SDL_GL_GetDrawableSize(win_, &w, &h); }
  void setRelativeMouse(bool on) override { SDL_SetRelativeMouseMode(on ? SDL_TRUE : SDL_FALSE); rel_ = on; }
  bool relativeMouse() const override { return rel_; }

  void pollEvents(Events& e) override {
    e = Events{};
    SDL_Event ev;
    while (SDL_PollEvent(&ev)) {
      switch (ev.type) {
        case SDL_QUIT: e.quit = true; break;
        case SDL_WINDOWEVENT:
          if (ev.window.event == SDL_WINDOWEVENT_SIZE_CHANGED) e.resized = true;
          // (focus lost: every key counts as up; macOS never sends the key-ups of a Cmd+Tab)
          if (ev.window.event == SDL_WINDOWEVENT_FOCUS_LOST) { e.focusLost = true; std::fill(std::begin(keys_), std::end(keys_), false); }
          if (ev.window.event == SDL_WINDOWEVENT_FOCUS_GAINED) e.focusGained = true;
          break;
        case SDL_KEYDOWN:
        case SDL_KEYUP: {
          // keys by position (the scancode: KeyW is the key left of the third row's E on QWERTY, QWERTZ and AZERTY
          // alike, as the web game's KeyboardEvent.code)
          Key k = mapScancode(ev.key.keysym.scancode);
          if (k == Key::Unknown) break;
          bool down = ev.type == SDL_KEYDOWN;
          Uint16 mod = ev.key.keysym.mod;
          if (down && !ev.key.repeat) {
            // the desktop shortcuts: fullscreen (F11, Alt+Enter; Cmd+F / Ctrl+Cmd+F on macOS), quit (Cmd+Q: the app
            // menu sends SDL_QUIT already; this also covers a bundle without one)
#ifdef __APPLE__
            bool cmd = (mod & KMOD_GUI) != 0;
            if (cmd && k == Key::KeyF) { e.toggleFullscreen = true; break; }   // (not also F: furnish)
            if (cmd && k == Key::KeyQ) { e.quit = true; break; }
#endif
            if (k == Key::F11 || (k == Key::Enter && (mod & KMOD_ALT))) { e.toggleFullscreen = true; break; }
          }
          if (ev.key.repeat) { if (down) e.repeated.push_back(k); break; }
          keys_[size_t(k)] = down;
          (down ? e.pressed : e.released).push_back(k);
          break;
        }
        case SDL_TEXTINPUT:
          if (SDL_IsTextInputActive()) e.text += ev.text.text;
          break;
        case SDL_CONTROLLERBUTTONDOWN: {
          int b = padPosition(ev.cbutton.button);
          for (size_t i = 0; i < pads_.size() && b >= 0; i++)
            if (pads_[i] && SDL_JoystickInstanceID(SDL_GameControllerGetJoystick(pads_[i])) == ev.cbutton.which) e.padPressed.push_back({int(i), b});
          break;
        }
        case SDL_MOUSEMOTION:
          if (rel_) { e.mouseDX += float(ev.motion.xrel); e.mouseDY += float(ev.motion.yrel); }
          else e.mouseMoved = true;
          break;
        case SDL_MOUSEWHEEL: e.wheel += float(ev.wheel.preciseY); break;
        case SDL_MOUSEBUTTONDOWN: case SDL_MOUSEBUTTONUP: {
          uint8_t bit = ev.button.button == SDL_BUTTON_LEFT ? 1 : ev.button.button == SDL_BUTTON_RIGHT ? 2 : ev.button.button == SDL_BUTTON_MIDDLE ? 4 : 0;
          if (ev.type == SDL_MOUSEBUTTONDOWN) e.mousePressed |= bit; else e.mouseReleased |= bit;
          break;
        }
        case SDL_CONTROLLERDEVICEADDED: openPad(ev.cdevice.which); break;
        case SDL_CONTROLLERDEVICEREMOVED: closePad(ev.cdevice.which); break;
        default: break;
      }
    }
    // the pointer (window points -> drawable pixels: high-DPI displays)
    int mx = 0, my = 0, ww = 1, wh = 1, dw = 1, dh = 1;
    Uint32 mb = SDL_GetMouseState(&mx, &my);
    if (win_) { SDL_GetWindowSize(win_, &ww, &wh); SDL_GL_GetDrawableSize(win_, &dw, &dh); }
    e.mouseX = rel_ ? -1.f : float(mx) * float(dw) / float(std::max(1, ww));
    e.mouseY = rel_ ? -1.f : float(my) * float(dh) / float(std::max(1, wh));
    e.mouseButtons = uint8_t(((mb & SDL_BUTTON_LMASK) ? 1 : 0) | ((mb & SDL_BUTTON_RMASK) ? 2 : 0) | ((mb & SDL_BUTTON_MMASK) ? 4 : 0));
  }
  bool keyDown(Key k) const override { return keys_[size_t(k)]; }
  void setFullscreen(bool on) override { if (win_) SDL_SetWindowFullscreen(win_, on ? SDL_WINDOW_FULLSCREEN_DESKTOP : 0); }
  bool fullscreen() const override { return win_ && (SDL_GetWindowFlags(win_) & SDL_WINDOW_FULLSCREEN_DESKTOP) != 0; }
  void setVsync(bool on) override { SDL_GL_SetSwapInterval(on ? 1 : 0); }

  void setTextInput(bool on) override {
    if (on == bool(SDL_IsTextInputActive())) return;
    if (on) SDL_StartTextInput(); else SDL_StopTextInput();
  }
  bool textInputActive() const override { return SDL_IsTextInputActive(); }

  bool pushKey(Key k, bool down) override {
    SDL_Scancode sc = SDL_SCANCODE_UNKNOWN;
    for (int i = 1; i < SDL_NUM_SCANCODES && sc == SDL_SCANCODE_UNKNOWN; i++) if (mapScancode(SDL_Scancode(i)) == k) sc = SDL_Scancode(i);
    if (sc == SDL_SCANCODE_UNKNOWN) return false;
    SDL_Event ev{};
    ev.type = down ? SDL_KEYDOWN : SDL_KEYUP;
    ev.key.timestamp = SDL_GetTicks();
    ev.key.windowID = win_ ? SDL_GetWindowID(win_) : 0;
    ev.key.state = down ? SDL_PRESSED : SDL_RELEASED;
    ev.key.keysym.scancode = sc;
    ev.key.keysym.sym = SDL_GetKeyFromScancode(sc);
    return SDL_PushEvent(&ev) == 1;
  }

  bool testPad(bool attach) override {
#if SDL_VERSION_ATLEAST(2, 24, 0)
    if (attach) {
      if (testJoy_) return true;
      SDL_VirtualJoystickDesc d{};
      d.version = SDL_VIRTUAL_JOYSTICK_DESC_VERSION;
      d.type = SDL_JOYSTICK_TYPE_GAMECONTROLLER;
      d.naxes = SDL_CONTROLLER_AXIS_MAX;
      d.nbuttons = SDL_CONTROLLER_BUTTON_MAX;
      d.name = "Autotest controller";
      int idx = SDL_JoystickAttachVirtualEx(&d);
      if (idx < 0) { SL_WARN("virtual controller: %s", SDL_GetError()); return false; }
      testJoy_ = SDL_JoystickOpen(idx);
      return testJoy_ != nullptr;
    }
    if (!testJoy_) return false;
    SDL_JoystickID id = SDL_JoystickInstanceID(testJoy_);
    SDL_JoystickClose(testJoy_);
    testJoy_ = nullptr;
    for (int i = 0; i < SDL_NumJoysticks(); i++) if (SDL_JoystickGetDeviceInstanceID(i) == id) { SDL_JoystickDetachVirtual(i); break; }
    return true;
#else
    (void)attach;
    return false;
#endif
  }
  void testPadButton(int position, bool down) override {
#if SDL_VERSION_ATLEAST(2, 24, 0)
    if (!testJoy_) return;
    for (int b = 0; b < SDL_CONTROLLER_BUTTON_MAX; b++)
      if (padPosition(b) == position) SDL_JoystickSetVirtualButton(testJoy_, b, down ? SDL_PRESSED : SDL_RELEASED);
#else
    (void)position; (void)down;
#endif
  }

  int gamepadCount() const override { return int(pads_.size()); }
  void gamepad(int i, GamepadState& s) const override {
    s = GamepadState{};
    if (i < 0 || i >= int(pads_.size()) || !pads_[i]) return;
    SDL_GameController* c = pads_[i];
    s.connected = true;
    const char* nm = SDL_GameControllerName(c);
    s.name = nm ? nm : "";
    switch (SDL_GameControllerGetType(c)) {
      case SDL_CONTROLLER_TYPE_PS3: case SDL_CONTROLLER_TYPE_PS4: case SDL_CONTROLLER_TYPE_PS5:
        s.family = PadFamily::PlayStation; break;
      case SDL_CONTROLLER_TYPE_NINTENDO_SWITCH_PRO:
#if SDL_VERSION_ATLEAST(2, 24, 0)
      case SDL_CONTROLLER_TYPE_NINTENDO_SWITCH_JOYCON_LEFT: case SDL_CONTROLLER_TYPE_NINTENDO_SWITCH_JOYCON_RIGHT:
      case SDL_CONTROLLER_TYPE_NINTENDO_SWITCH_JOYCON_PAIR:
#endif
        s.family = PadFamily::Switch; break;
      default: s.family = PadFamily::Xbox; break;
    }
    auto ax = [&](SDL_GameControllerAxis a) { return std::max(-1.f, SDL_GameControllerGetAxis(c, a) / 32767.f); };
    s.leftX = ax(SDL_CONTROLLER_AXIS_LEFTX); s.leftY = ax(SDL_CONTROLLER_AXIS_LEFTY);
    s.rightX = ax(SDL_CONTROLLER_AXIS_RIGHTX); s.rightY = ax(SDL_CONTROLLER_AXIS_RIGHTY);
    auto b = [&](SDL_GameControllerButton btn) { return SDL_GameControllerGetButton(c, btn) ? 1.f : 0.f; };
    s.buttons[0] = b(SDL_CONTROLLER_BUTTON_A); s.buttons[1] = b(SDL_CONTROLLER_BUTTON_B);
    s.buttons[2] = b(SDL_CONTROLLER_BUTTON_X); s.buttons[3] = b(SDL_CONTROLLER_BUTTON_Y);
    s.buttons[4] = b(SDL_CONTROLLER_BUTTON_LEFTSHOULDER); s.buttons[5] = b(SDL_CONTROLLER_BUTTON_RIGHTSHOULDER);
    s.buttons[6] = std::max(0.f, ax(SDL_CONTROLLER_AXIS_TRIGGERLEFT));
    s.buttons[7] = std::max(0.f, ax(SDL_CONTROLLER_AXIS_TRIGGERRIGHT));
    s.buttons[8] = b(SDL_CONTROLLER_BUTTON_BACK); s.buttons[9] = b(SDL_CONTROLLER_BUTTON_START);
    s.buttons[10] = b(SDL_CONTROLLER_BUTTON_LEFTSTICK); s.buttons[11] = b(SDL_CONTROLLER_BUTTON_RIGHTSTICK);
    s.buttons[12] = b(SDL_CONTROLLER_BUTTON_DPAD_UP); s.buttons[13] = b(SDL_CONTROLLER_BUTTON_DPAD_DOWN);
    s.buttons[14] = b(SDL_CONTROLLER_BUTTON_DPAD_LEFT); s.buttons[15] = b(SDL_CONTROLLER_BUTTON_DPAD_RIGHT);
    s.buttons[16] = b(SDL_CONTROLLER_BUTTON_GUIDE);
  }
  void rumble(int i, float low, float high, uint32_t ms) override {
    if (i < 0 || i >= int(pads_.size()) || !pads_[i]) return;
    auto u16 = [](float v) { return Uint16(std::min(1.f, std::max(0.f, v)) * 65535.f); };
    SDL_GameControllerRumble(pads_[i], u16(low), u16(high), ms);
  }

  double timeSeconds() const override { return double(SDL_GetPerformanceCounter() - t0_) / freq_; }

  std::string executableDir() const override {
    char* p = SDL_GetBasePath();
    std::string s = p ? p : "./";
    SDL_free(p);
    return s;
  }
  bool readFile(const std::string& path, std::vector<uint8_t>& out) const override {
    std::ifstream f(u8(path), std::ios::binary);
    if (!f) return false;
    f.seekg(0, std::ios::end);
    out.resize(size_t(f.tellg()));
    f.seekg(0);
    f.read(reinterpret_cast<char*>(out.data()), std::streamsize(out.size()));
    return bool(f);
  }
  bool fileExists(const std::string& path) const override { std::error_code ec; return fs::exists(u8(path), ec); }
  std::string saveDir() override {
    char* p = SDL_GetPrefPath("SkiLegacy", "SkiLegacy");
    std::string s = p ? p : "./";
    SDL_free(p);
    return s;
  }
  bool writeSave(const std::string& name, const std::vector<uint8_t>& data) override {
    std::string tmp = saveDir() + name + ".tmp", dst = saveDir() + name;
    { std::ofstream f(u8(tmp), std::ios::binary); if (!f) return false; f.write((const char*)data.data(), data.size()); }
    std::error_code ec;
    fs::rename(u8(tmp), u8(dst), ec); // atomic replace: a crash never leaves half a save
    return !ec;
  }
  bool readSave(const std::string& name, std::vector<uint8_t>& out) override { return readFile(saveDir() + name, out); }

  std::string userName() const override {
    const char* u = SDL_getenv("USER");
    if (!u) u = SDL_getenv("USERNAME");
    return u ? u : "Player";
  }

  bool openAudio(int rate, int channels, AudioCallback cb) override {
    if (SDL_InitSubSystem(SDL_INIT_AUDIO) != 0) { SL_WARN("no audio: %s", SDL_GetError()); return false; }
    audioCb_ = std::move(cb);
    SDL_AudioSpec want{}, have{};
    want.freq = rate; want.format = AUDIO_F32SYS; want.channels = Uint8(channels); want.samples = 1024;
    want.callback = [](void* user, Uint8* stream, int len) {
      auto* self = static_cast<SdlPlatform*>(user);
      int ch = self->audioChannels_;
      self->audioCb_(reinterpret_cast<float*>(stream), len / int(sizeof(float) * ch), ch);
    };
    want.userdata = this;
    audioDev_ = SDL_OpenAudioDevice(nullptr, 0, &want, &have, 0);
    if (!audioDev_) { SL_WARN("no audio device: %s", SDL_GetError()); return false; }
    audioChannels_ = have.channels;
    SDL_PauseAudioDevice(audioDev_, 0);
    return true;
  }
  void closeAudio() override {
    if (audioDev_) { SDL_CloseAudioDevice(audioDev_); audioDev_ = 0; }
  }

  size_t memoryBytes() const override {
#if defined(_WIN32)
    PROCESS_MEMORY_COUNTERS pmc{};
    return GetProcessMemoryInfo(GetCurrentProcess(), &pmc, sizeof pmc) ? size_t(pmc.WorkingSetSize) : 0;
#elif defined(__APPLE__)
    mach_task_basic_info info{};
    mach_msg_type_number_t n = MACH_TASK_BASIC_INFO_COUNT;
    return task_info(mach_task_self(), MACH_TASK_BASIC_INFO, reinterpret_cast<task_info_t>(&info), &n) == KERN_SUCCESS ? size_t(info.resident_size) : 0;
#else
    return procStatus("VmRSS:");
#endif
  }
  size_t peakMemoryBytes() const override {
#if defined(_WIN32)
    PROCESS_MEMORY_COUNTERS pmc{};
    return GetProcessMemoryInfo(GetCurrentProcess(), &pmc, sizeof pmc) ? size_t(pmc.PeakWorkingSetSize) : 0;
#elif defined(__APPLE__)
    rusage ru{};
    getrusage(RUSAGE_SELF, &ru);
    return size_t(ru.ru_maxrss);   // (bytes on macOS)
#else
    size_t v = procStatus("VmHWM:");
    if (v) return v;
    rusage ru{};
    getrusage(RUSAGE_SELF, &ru);
    return size_t(ru.ru_maxrss) * 1024;
#endif
  }

private:
#if !defined(_WIN32) && !defined(__APPLE__)
  static size_t procStatus(const char* key) {
    FILE* f = std::fopen("/proc/self/status", "r");
    if (!f) return 0;
    char line[256];
    size_t kb = 0;
    while (std::fgets(line, sizeof line, f))
      if (std::strncmp(line, key, std::strlen(key)) == 0) { kb = size_t(std::strtoull(line + std::strlen(key), nullptr, 10)); break; }
    std::fclose(f);
    return kb * 1024;
  }
#endif
  void openPad(int deviceIndex) {
    if (!SDL_IsGameController(deviceIndex)) return;
    SDL_GameController* c = SDL_GameControllerOpen(deviceIndex);
    if (!c) return;
    for (auto*& slot : pads_) if (!slot) { slot = c; SL_INFO("controller: %s", SDL_GameControllerName(c)); return; }
    pads_.push_back(c);
    SL_INFO("controller: %s", SDL_GameControllerName(c));
  }
  void closePad(SDL_JoystickID id) {
    for (auto*& c : pads_)
      if (c && SDL_JoystickInstanceID(SDL_GameControllerGetJoystick(c)) == id) { SDL_GameControllerClose(c); c = nullptr; }
  }

  SDL_Window* win_ = nullptr;
  SDL_GLContext ctx_ = nullptr;
  bool keys_[size_t(Key::Count)] = {};
  bool rel_ = false;
  std::vector<SDL_GameController*> pads_;
  SDL_Joystick* testJoy_ = nullptr;   // (autotest) the virtual controller
  double freq_ = 1;
  Uint64 t0_ = 0;
  SDL_AudioDeviceID audioDev_ = 0;
  int audioChannels_ = 2;
  AudioCallback audioCb_;
};

std::unique_ptr<Platform> createPlatform() { return std::make_unique<SdlPlatform>(); }

} // namespace sl::platform
