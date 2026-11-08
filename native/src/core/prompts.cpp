#include "core/prompts.h"
#include <cctype>
#include <cstring>

namespace sl::prompts {
using platform::Key;
using platform::PadFamily;

const char* padGlyph(int i, PadFamily f) {
  static const char* xbox[] = {"A", "B", "X", "Y", "LB", "RB", "LT", "RT", "VIEW", "MENU", "LS", "RS", "D\xE2\x86\x91", "D\xE2\x86\x93", "D\xE2\x86\x90", "D\xE2\x86\x92", "XBOX"};
  static const char* ps[] = {"\xE2\x9C\x95", "\xE2\x97\x8B", "\xE2\x96\xA1", "\xE2\x96\xB3", "L1", "R1", "L2", "R2", "SHARE", "OPTIONS", "L3", "R3", "D\xE2\x86\x91", "D\xE2\x86\x93", "D\xE2\x86\x90", "D\xE2\x86\x92", "PS"};
  static const char* sw[] = {"B", "A", "Y", "X", "L", "R", "ZL", "ZR", "\xE2\x88\x92", "+", "LS", "RS", "D\xE2\x86\x91", "D\xE2\x86\x93", "D\xE2\x86\x90", "D\xE2\x86\x92", "HOME"};
  if (i < 0 || i > 16) return "\xE2\x80\x94";
  return f == PadFamily::PlayStation ? ps[i] : f == PadFamily::Switch ? sw[i] : xbox[i];
}

std::string keyLabel(Key k) {
  std::string c = platform::keyCode(k);
  if (c.empty()) return "\xE2\x80\x94";
  if (c.rfind("Key", 0) == 0) return c.substr(3);
  if (c.rfind("Digit", 0) == 0) return c.substr(5);
  struct M { const char* code; const char* label; };
  static const M m[] = {{"ShiftLeft", "SHIFT"}, {"ShiftRight", "R SHIFT"}, {"ControlLeft", "CTRL"}, {"ControlRight", "R CTRL"}, {"AltLeft", "ALT"},
    {"AltRight", "R ALT"}, {"MetaLeft", "CMD"}, {"MetaRight", "R CMD"}, {"Space", "SPACE"}, {"Escape", "ESC"}, {"Backspace", "BACKSPACE"},
    {"Enter", "ENTER"}, {"Tab", "TAB"}, {"BracketLeft", "["}, {"BracketRight", "]"}, {"ArrowUp", "\xE2\x86\x91"}, {"ArrowDown", "\xE2\x86\x93"},
    {"ArrowLeft", "\xE2\x86\x90"}, {"ArrowRight", "\xE2\x86\x92"}};
  for (const M& e : m) if (c == e.code) return e.label;
  std::string u = c;
  for (char& ch : u) ch = char(std::toupper(static_cast<unsigned char>(ch)));
  return u;
}

const char* familyName(PadFamily f) { return f == PadFamily::PlayStation ? "PLAYSTATION" : f == PadFamily::Switch ? "SWITCH" : "XBOX"; }

Action actionFromId(const std::string& id) {
  for (size_t i = 0; i < kActionCount; i++) if (id == actionInfo(Action(i)).id) return Action(i);
  return Action::Count;
}

static bool isStick(Action a) { return a == Action::Forward || a == Action::Back || a == Action::Left || a == Action::Right; }

std::string K(const Input& in, Action a, int pad) { return K(in, actionInfo(a).id, pad); }

std::string K(const Input& in, const std::string& id, int pad) {
  bool usePad = pad < 0 ? in.usingGamepad() : pad > 0;
  PadFamily f = in.padFamily();
  if (usePad) {
    if (id == "confirm") return padGlyph(confirmButton(f), f);
    if (id == "cancel") return padGlyph(backButton(f), f);
    if (id == "esc") return padGlyph(9, f);
    if (id == "move" || id == "steer") return "L STICK";
    if (id == "look" || id == "scroll") return "R STICK";
    if (id == "updown" || id == "leftright" || id == "select") return "D-PAD";
    Action a = actionFromId(id);
    if (a == Action::Count) { std::string u = id; for (char& ch : u) ch = char(std::toupper(static_cast<unsigned char>(ch))); return u; }
    if (isStick(a)) return "L STICK";
    int b = in.pad[size_t(a)];
    return b >= 0 ? padGlyph(b, f) : keyLabel(in.kb[size_t(a)]);
  }
  if (id == "confirm") return "ENTER";
  if (id == "cancel" || id == "esc") return "ESC";
  if (id == "move") return "W A S D";
  if (id == "steer") return "A D";
  if (id == "look") return "MOUSE";
  if (id == "updown" || id == "select") return "\xE2\x86\x91 \xE2\x86\x93";
  if (id == "leftright") return "\xE2\x86\x90 \xE2\x86\x92";
  if (id == "scroll") return "WHEEL";
  Action a = actionFromId(id);
  if (a == Action::Count) { std::string u = id; for (char& ch : u) ch = char(std::toupper(static_cast<unsigned char>(ch))); return u; }
  return keyLabel(in.kb[size_t(a)]);
}

std::string bindLabel(const Input& in, Action a, bool pad, PadFamily f) {
  if (pad) {
    static const char* dir[] = {"L STICK \xE2\x86\x91", "L STICK \xE2\x86\x93", "L STICK \xE2\x86\x90", "L STICK \xE2\x86\x92"};
    if (isStick(a)) return dir[size_t(a)];
    int b = in.pad[size_t(a)];
    return b < 0 ? "\xE2\x80\x94" : padGlyph(b, f);
  }
  if (actionInfo(a).padOnly) return "\xE2\x80\x94";
  return keyLabel(in.kb[size_t(a)]);
}

} // namespace sl::prompts
