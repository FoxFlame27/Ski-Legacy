// three.js math, operation for operation (double precision, like JavaScript numbers): the skier rig (skier.js) and the
// crowd poses (fans.js) are ported on top of these so a C++ pose matches the JS one for the same inputs. Quaternions
// are glm::dquat (w, x, y, z constructor order!), matrices glm::dmat4 (column-major, as three's `elements`).
#pragma once
#include <glm/glm.hpp>
#include <glm/gtc/quaternion.hpp>
#include <algorithm>
#include <cmath>
#include <limits>

namespace sl::three {
using V3 = glm::dvec3;
using Q = glm::dquat;
using M4 = glm::dmat4;

constexpr double EPS = std::numeric_limits<double>::epsilon();   // Number.EPSILON
inline const V3 UP{0, 1, 0};

inline double clamp(double x, double a, double b) { return std::max(a, std::min(b, x)); }   // noise.js clamp
inline double lerp(double a, double b, double t) { return a + (b - a) * t; }
/// THREE.MathUtils.smoothstep(x, min, max)
inline double smoothstep(double x, double mn, double mx) {
  if (x <= mn) return 0;
  if (x >= mx) return 1;
  x = (x - mn) / (mx - mn);
  return x * x * (3 - 2 * x);
}
/// skier.js smoothT(x, a, b)
inline double smoothT(double x, double a, double b) { double t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
inline double ek(double h, double r) { return 1 - std::exp(-h * r); }

inline V3 normalize(const V3& v) { double l = glm::length(v); return l > 0 ? v / l : v; }   // Vector3.normalize (length || 1)
inline double lengthSq(const V3& v) { return glm::dot(v, v); }
inline V3 vlerp(const V3& a, const V3& b, double t) { return a + (b - a) * t; }
/// Vector3.applyQuaternion
inline V3 applyQ(const V3& v, const Q& q) {
  double vx = v.x, vy = v.y, vz = v.z, qx = q.x, qy = q.y, qz = q.z, qw = q.w;
  double tx = 2 * (qy * vz - qz * vy), ty = 2 * (qz * vx - qx * vz), tz = 2 * (qx * vy - qy * vx);
  return V3(vx + qw * tx + qy * tz - qz * ty, vy + qw * ty + qz * tx - qx * tz, vz + qw * tz + qx * ty - qy * tx);
}
/// Quaternion.multiply (a * b)
inline Q mul(const Q& a, const Q& b) {
  return Q(a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z, a.x * b.w + a.w * b.x + a.y * b.z - a.z * b.y,
           a.y * b.w + a.w * b.y + a.z * b.x - a.x * b.z, a.z * b.w + a.w * b.z + a.x * b.y - a.y * b.x);
}
inline Q conj(const Q& q) { return Q(q.w, -q.x, -q.y, -q.z); }   // Quaternion.invert
inline Q qnormalize(const Q& q) {
  double l = std::sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
  if (l == 0) return Q(1, 0, 0, 0);
  l = 1 / l;
  return Q(q.w * l, q.x * l, q.y * l, q.z * l);
}
/// Quaternion.setFromAxisAngle (axis normalized)
inline Q axisAngle(const V3& a, double angle) {
  double h = angle / 2, s = std::sin(h);
  return Q(std::cos(h), a.x * s, a.y * s, a.z * s);
}
inline V3 applyAxisAngle(const V3& v, const V3& axis, double angle) { return applyQ(v, axisAngle(axis, angle)); }
/// Quaternion.setFromUnitVectors
inline Q fromUnitVectors(const V3& f, const V3& t) {
  double r = glm::dot(f, t) + 1;
  Q q;
  if (r < EPS) {
    r = 0;
    if (std::fabs(f.x) > std::fabs(f.z)) q = Q(r, -f.y, f.x, 0);
    else q = Q(r, 0, -f.z, f.y);
  } else {
    q = Q(r, f.y * t.z - f.z * t.y, f.z * t.x - f.x * t.z, f.x * t.y - f.y * t.x);
  }
  return qnormalize(q);
}
/// Quaternion.slerp (this = a, toward b)
inline Q slerp(const Q& a, const Q& b, double t) {
  if (t == 0) return a;
  if (t == 1) return b;
  double x = a.x, y = a.y, z = a.z, w = a.w;
  double cosHalf = w * b.w + x * b.x + y * b.y + z * b.z;
  Q r;
  if (cosHalf < 0) { r = Q(-b.w, -b.x, -b.y, -b.z); cosHalf = -cosHalf; } else r = b;
  if (cosHalf >= 1.0) return a;
  double sqrSin = 1.0 - cosHalf * cosHalf;
  if (sqrSin <= EPS) {
    double s = 1 - t;
    return qnormalize(Q(s * w + t * r.w, s * x + t * r.x, s * y + t * r.y, s * z + t * r.z));
  }
  double sinHalf = std::sqrt(sqrSin), half = std::atan2(sinHalf, cosHalf);
  double ra = std::sin((1 - t) * half) / sinHalf, rb = std::sin(t * half) / sinHalf;
  return Q(w * ra + r.w * rb, x * ra + r.x * rb, y * ra + r.y * rb, z * ra + r.z * rb);
}
/// Quaternion.slerpFlat (AnimationMixer, keyframe interpolation): arrays [x, y, z, w]
inline void slerpFlat(double* dst, const double* s0, const double* s1, double t) {
  double x0 = s0[0], y0 = s0[1], z0 = s0[2], w0 = s0[3];
  const double x1 = s1[0], y1 = s1[1], z1 = s1[2], w1 = s1[3];
  if (t == 0) { dst[0] = x0; dst[1] = y0; dst[2] = z0; dst[3] = w0; return; }
  if (t == 1) { dst[0] = x1; dst[1] = y1; dst[2] = z1; dst[3] = w1; return; }
  if (w0 != w1 || x0 != x1 || y0 != y1 || z0 != z1) {
    double s = 1 - t;
    const double cs = x0 * x1 + y0 * y1 + z0 * z1 + w0 * w1, dir = cs >= 0 ? 1 : -1, sqrSin = 1 - cs * cs;
    if (sqrSin > EPS) {
      const double sn = std::sqrt(sqrSin), len = std::atan2(sn, cs * dir);
      s = std::sin(s * len) / sn;
      t = std::sin(t * len) / sn;
    }
    const double tDir = t * dir;
    x0 = x0 * s + x1 * tDir; y0 = y0 * s + y1 * tDir; z0 = z0 * s + z1 * tDir; w0 = w0 * s + w1 * tDir;
    if (s == 1 - t) {
      const double f = 1 / std::sqrt(x0 * x0 + y0 * y0 + z0 * z0 + w0 * w0);
      x0 *= f; y0 *= f; z0 *= f; w0 *= f;
    }
  }
  dst[0] = x0; dst[1] = y0; dst[2] = z0; dst[3] = w0;
}
/// Matrix4.compose
inline M4 compose(const V3& p, const Q& q, const V3& s) {
  const double x = q.x, y = q.y, z = q.z, w = q.w, x2 = x + x, y2 = y + y, z2 = z + z;
  const double xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
  M4 m;
  m[0] = glm::dvec4((1 - (yy + zz)) * s.x, (xy + wz) * s.x, (xz - wy) * s.x, 0);
  m[1] = glm::dvec4((xy - wz) * s.y, (1 - (xx + zz)) * s.y, (yz + wx) * s.y, 0);
  m[2] = glm::dvec4((xz + wy) * s.z, (yz - wx) * s.z, (1 - (xx + yy)) * s.z, 0);
  m[3] = glm::dvec4(p, 1);
  return m;
}
/// Quaternion.setFromRotationMatrix (upper 3x3 of m, assumed unscaled)
inline Q fromRotationMatrix(const M4& te) {
  const double m11 = te[0][0], m12 = te[1][0], m13 = te[2][0], m21 = te[0][1], m22 = te[1][1], m23 = te[2][1], m31 = te[0][2], m32 = te[1][2], m33 = te[2][2];
  const double trace = m11 + m22 + m33;
  if (trace > 0) {
    const double s = 0.5 / std::sqrt(trace + 1.0);
    return Q(0.25 / s, (m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s);
  } else if (m11 > m22 && m11 > m33) {
    const double s = 2.0 * std::sqrt(1.0 + m11 - m22 - m33);
    return Q((m32 - m23) / s, 0.25 * s, (m12 + m21) / s, (m13 + m31) / s);
  } else if (m22 > m33) {
    const double s = 2.0 * std::sqrt(1.0 + m22 - m11 - m33);
    return Q((m13 - m31) / s, (m12 + m21) / s, 0.25 * s, (m23 + m32) / s);
  }
  const double s = 2.0 * std::sqrt(1.0 + m33 - m11 - m22);
  return Q((m21 - m12) / s, (m13 + m31) / s, (m23 + m32) / s, 0.25 * s);
}
/// Matrix4.makeBasis(x, y, z) -> quaternion (Quaternion.setFromRotationMatrix of the basis)
inline Q basisQuat(const V3& x, const V3& y, const V3& z) {
  M4 m(1);
  m[0] = glm::dvec4(x, 0); m[1] = glm::dvec4(y, 0); m[2] = glm::dvec4(z, 0);
  return fromRotationMatrix(m);
}
/// Matrix4.decompose: the rotation part
inline Q decomposeQ(const M4& m) {
  double sx = glm::length(V3(m[0])), sy = glm::length(V3(m[1])), sz = glm::length(V3(m[2]));
  if (glm::determinant(m) < 0) sx = -sx;
  M4 r = m;
  r[0] *= 1 / sx; r[1] *= 1 / sy; r[2] *= 1 / sz;
  return fromRotationMatrix(r);
}
inline V3 decomposeS(const M4& m) {
  double sx = glm::length(V3(m[0])), sy = glm::length(V3(m[1])), sz = glm::length(V3(m[2]));
  if (glm::determinant(m) < 0) sx = -sx;
  return V3(sx, sy, sz);
}
inline V3 mulPoint(const M4& m, const V3& v) {   // Vector3.applyMatrix4 (affine)
  glm::dvec4 r = m * glm::dvec4(v, 1);
  return V3(r) / r.w;
}
/// Quaternion from an Euler (0, y, 0) (root.rotation.set(0, heading, 0))
inline Q yaw(double h) { return Q(std::cos(h / 2), 0, std::sin(h / 2), 0); }
/// quaternion angle between two rotations (deg)
inline double angleDeg(const Q& a, const Q& b) {
  double d = std::fabs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w) / std::max(1e-12, std::sqrt((a.x * a.x + a.y * a.y + a.z * a.z + a.w * a.w) * (b.x * b.x + b.y * b.y + b.z * b.z + b.w * b.w)));
  return 2 * std::acos(std::min(1.0, d)) * 180 / 3.14159265358979323846;
}

/// Symmetric 3x3 eigen-decomposition (Jacobi, skier.js eigen3): eigenvectors sorted by eigenvalue (desc)
inline void eigen3(const double in[3][3], V3 out[3]) {
  double a[3][3], v[3][3] = {{1, 0, 0}, {0, 1, 0}, {0, 0, 1}};
  for (int i = 0; i < 3; i++) for (int j = 0; j < 3; j++) a[i][j] = in[i][j];
  for (int it = 0; it < 50; it++) {
    int p = 0, q = 1;
    if (std::fabs(a[0][2]) > std::fabs(a[p][q])) { p = 0; q = 2; }
    if (std::fabs(a[1][2]) > std::fabs(a[p][q])) { p = 1; q = 2; }
    if (std::fabs(a[p][q]) < 1e-12) break;
    const double th = 0.5 * std::atan2(2 * a[p][q], a[q][q] - a[p][p]);
    const double c = std::cos(th), s = std::sin(th);
    for (int k = 0; k < 3; k++) { double akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
    for (int k = 0; k < 3; k++) { double apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
    for (int k = 0; k < 3; k++) { double vkp = v[k][p], vkq = v[k][q]; v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq; }
  }
  int idx[3] = {0, 1, 2};
  std::stable_sort(idx, idx + 3, [&](int i, int j) { return a[j][j] < a[i][i]; });
  for (int k = 0; k < 3; k++) out[k] = normalize(V3(v[0][idx[k]], v[1][idx[k]], v[2][idx[k]]));
}
} // namespace sl::three
