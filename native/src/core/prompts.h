// BUTTON PROMPTS (src/ui/prompts.js K() / kc() and core/bindings.js padGlyph / keyLabel): what to call a key right now.
// The keyboard key (the bindings over the defaults) while you play on keyboard / mouse, the controller's button (Xbox /
// PlayStation / Switch names) while you play on a controller; swaps live when the device changes (Input tracks the
// device in use). Switch confirms with the right button (A, index 1) and backs out with the bottom one (B, index 0).
#pragma once
#include "core/input.h"
#include <string>

namespace sl::prompts {

/// bindings.js GLYPHS: the label of standard-layout button i on a family (PlayStation symbols as UTF-8 ✕ ○ □ △)
const char* padGlyph(int button, platform::PadFamily f);
/// bindings.js keyLabel ('KeyW' -> 'W', ShiftLeft -> 'SHIFT', Space -> 'SPACE')
std::string keyLabel(platform::Key k);
const char* familyName(platform::PadFamily f);    // XBOX / PLAYSTATION / SWITCH
inline int confirmButton(platform::PadFamily f) { return f == platform::PadFamily::Switch ? 1 : 0; }
inline int backButton(platform::PadFamily f) { return f == platform::PadFamily::Switch ? 0 : 1; }

/// K(id): an action id ('interact', 'skis', 'map', 'pause', ...) or a special ('confirm', 'cancel', 'esc', 'move',
/// 'steer', 'look', 'updown', 'leftright', 'select', 'scroll'). pad: -1 = the device in use, 0 keyboard, 1 controller.
std::string K(const Input& in, const std::string& id, int pad = -1);
std::string K(const Input& in, Action a, int pad = -1);
/// the label of an action's binding (CONTROLS screen / reference): keyboard key, or the family's glyph ('L STICK ↑'
/// for the movement rows on a controller)
std::string bindLabel(const Input& in, Action a, bool pad, platform::PadFamily f);
/// action from its id ('jump' -> Action::Jump); Action::Count when unknown
Action actionFromId(const std::string& id);

} // namespace sl::prompts
