// SKI_LEGACY_DEBUG=uitest (with --autotest --png): every UI screen in turn, a screenshot of each, then quit.
#pragma once
#include "engine/ui.h"
#include "game/menus.h"
#include <string>
#include <vector>

namespace sl {
/// the sample screens after the trail map's and the route picker's (game.cpp drives those itself)
const std::vector<std::string>& uiTestScreens();
void uiTestDraw(Ui& ui, const UiNav& nav, const Input& in, const std::string& name, double age, double now);
} // namespace sl
