// Key code names shared by every platform backend.
#include "platform/platform.h"
#include <cstring>

namespace sl::platform {

static const char* const kKeyNames[] = {
  "", "KeyA", "KeyB", "KeyC", "KeyD", "KeyE", "KeyF", "KeyG", "KeyH", "KeyI", "KeyJ", "KeyK", "KeyL", "KeyM", "KeyN",
  "KeyO", "KeyP", "KeyQ", "KeyR", "KeyS", "KeyT", "KeyU", "KeyV", "KeyW", "KeyX", "KeyY", "KeyZ",
  "Digit0", "Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7", "Digit8", "Digit9",
  "Space", "Enter", "Escape", "Backspace", "Tab", "ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "AltLeft",
  "AltRight", "MetaLeft", "MetaRight", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "BracketLeft", "BracketRight",
  "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
};
static_assert(sizeof(kKeyNames) / sizeof(kKeyNames[0]) == size_t(Key::Count), "key name table out of sync");

Key keyFromCode(const std::string& code) {
  for (size_t i = 1; i < size_t(Key::Count); i++) if (code == kKeyNames[i]) return Key(i);
  return Key::Unknown;
}
const char* keyCode(Key k) { return size_t(k) < size_t(Key::Count) ? kKeyNames[size_t(k)] : ""; }

} // namespace sl::platform
