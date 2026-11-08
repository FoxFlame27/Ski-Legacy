// Math helpers on top of glm (angles, damping, the small vector utilities the game code uses everywhere).
#pragma once
#include <glm/glm.hpp>
#include <glm/gtc/matrix_transform.hpp>
#include <glm/gtc/quaternion.hpp>
#include <glm/gtc/type_ptr.hpp>
#include <cmath>

namespace sl {
using glm::vec2; using glm::vec3; using glm::vec4; using glm::mat3; using glm::mat4; using glm::quat;
using glm::dvec2; using glm::dvec3; using glm::ivec2;

constexpr double PI = 3.14159265358979323846;
constexpr double TAU = 2 * PI;
constexpr double DEG = PI / 180;

/// Wrap an angle to (-pi, pi].
inline double wrapPi(double a) {
  a = std::fmod(a + PI, TAU);
  if (a < 0) a += TAU;
  return a - PI;
}
/// Exponential approach of an angle toward `b` (k = rate * dt).
inline double dampAngle(double a, double b, double k) { return a + wrapPi(b - a) * (1 - std::exp(-k)); }
inline double damp(double k) { return 1 - std::exp(-k); }
inline double sign(double x) { return x > 0 ? 1.0 : (x < 0 ? -1.0 : 0.0); }

/// Exact critically damped spring step toward `target` (player.js spring()).
inline void springStep(double& x, double& v, double target, double w, double dt) {
  double d = x - target, e = std::exp(-w * dt), c = v + w * d;
  x = target + (d + c * dt) * e;
  v = (v - c * w * dt) * e;
}
} // namespace sl
