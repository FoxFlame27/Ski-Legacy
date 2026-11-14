// The house-style pieces the game's screens share (style.css): the paper panels with their drop shadows, the brush
// buttons with a keycap, medals, wrapped text, the key hint rows. Everything in drawable pixels; u = Ui::cssU().
#pragma once
#include "engine/ui.h"
#include <string>
#include <utility>
#include <vector>

namespace sl::uiw {

/// upper case (ASCII and the Latin-1 letters: ä ö ü é ...)
std::string upper(const std::string& s);
/// "1,234"
std::string thousands(long long v);
/// word-wraps to maxW (explicit \n kept)
std::vector<std::string> wrap(const Ui& ui, const std::string& s, float size, UiFont f, float maxW, float tracking = 0);
/// the text cut with an ellipsis so it fits maxW (text-overflow: ellipsis)
std::string ellipsis(const Ui& ui, const std::string& s, float size, UiFont f, float maxW, float tracking = 0);
/// .rh-panel / .paper: white paper with menu.js brushClip(seed, amp, side) and the panels' drop shadow
void paper(Ui& ui, float x, float y, float w, float h, int seed, float amp, float side, float u, const vec4& c = vec4(1), bool shadow = true);
/// .brush-btn (height h, font size fs, the label from padL): the paint stroke, the label, an optional keycap after it;
/// focused: shifted 14u, tilted 1 degree, the red bar. Returns its width (max(minW, the label's)).
float brushButtonWidth(Ui& ui, float minW, float h, float fs, const std::string& label, float u, const std::string& cap = "");
float brushButton(Ui& ui, float x, float y, float minW, float h, float fs, const std::string& label, int seed, bool focused, float u, const std::string& cap = "",
                  float alpha = 1, const vec4& fill = vec4(1), const vec4& ink = vec4(-1));
/// .medal: the ribbon and the disc (kind 1 gold, 2 silver, 3 bronze, 0 none: a dashed ring); m = the disc's diameter;
/// (x, y) = the top-left of its m x 1.22 m box
void medal(Ui& ui, float x, float y, float m, int kind, bool number = true);
/// a key hint row (.hint: keycaps + an upper-case label, 22u apart) from x; returns the x after it
struct Hint { std::vector<std::string> caps; std::string label; };
float hints(Ui& ui, float x, float y, float u, const std::vector<Hint>& hs, const vec4& col = vec4(1, 1, 1, 0.88f), const vec4& border = vec4(1, 1, 1, 0.7f), float maxX = 1e9f);

} // namespace sl::uiw
