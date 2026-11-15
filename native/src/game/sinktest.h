#pragma once

namespace sl {
class World;
/// (debug: SKI_LEGACY_DEBUG=sinktest) the courses' physics ground against the web game's (game/sinktest.cpp); 0 = PASS
int runSinkTest(World& world, const char* refPath);
}
