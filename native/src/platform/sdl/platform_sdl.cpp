// Desktop platform backend: SDL2 (macOS, Windows, Linux).
#include "platform/platform.h"
#include "core/log.h"

#include <SDL.h>
#include <filesystem>
#include <fstream>
#include <memory>
#include <algorithm>

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
    case SDL_SCANCODE_RETURN: return Key::Enter;
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

class SdlPlatform final : public Platform {
public:
  SdlPlatform() {
    // buttons by position (south = A on every controller), as the game's bindings expect
    SDL_SetHint(SDL_HINT_GAMECONTROLLER_USE_BUTTON_LABELS, "0");
    SDL_SetHint(SDL_HINT_JOYSTICK_ALLOW_BACKGROUND_EVENTS, "1");
    if (SDL_Init(SDL_INIT_VIDEO | SDL_INIT_GAMECONTROLLER | SDL_INIT_EVENTS | SDL_INIT_TIMER) != 0)
      SL_ERROR("SDL_Init: %s", SDL_GetError());
    if (SDL_InitSubSystem(SDL_INIT_HAPTIC) != 0) SL_WARN("no haptics: %s", SDL_GetError());
    freq_ = double(SDL_GetPerformanceFrequency());
    t0_ = SDL_GetPerformanceCounter();
  }
  ~SdlPlatform() override {
    closeAudio();
    for (auto* c : pads_) if (c) SDL_GameControllerClose(c);
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
          if (ev.window.event == SDL_WINDOWEVENT_FOCUS_LOST) e.focusLost = true;
          break;
        case SDL_KEYDOWN:
        case SDL_KEYUP: {
          Key k = mapScancode(ev.key.keysym.scancode);
          if (k == Key::Unknown) break;
          if (ev.key.repeat) { if (ev.type == SDL_KEYDOWN) e.repeated.push_back(k); break; }
          keys_[size_t(k)] = ev.type == SDL_KEYDOWN;
          (ev.type == SDL_KEYDOWN ? e.pressed : e.released).push_back(k);
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

private:
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
  double freq_ = 1;
  Uint64 t0_ = 0;
  SDL_AudioDeviceID audioDev_ = 0;
  int audioChannels_ = 2;
  AudioCallback audioCb_;
};

std::unique_ptr<Platform> createPlatform() { return std::make_unique<SdlPlatform>(); }

} // namespace sl::platform
