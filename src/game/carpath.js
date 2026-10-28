// Car paths driven like a car: a polyline's corners rounded into circular arcs the car can drive (a fillet of radius
// r, cut back at most half of a leg, the whole of a leg at the path's ends), a speed for each point (slower in the
// tight bends, lateral acceleration A_LAT, braking in time, DEC), and a pure-pursuit follower on the bicycle model
// (yaw rate = v / wheelbase * tan(steer), the steering angle and its rate limited): no heading ever jumps. Used by
// traffic.js (junction turns, car parks, bays, three-point turns); anything else that drives (a tow truck, a rental
// car) can drive the same way. No imports: testable in Node.
export const MAX_STEER = 0.6, STEER_RATE = 1.5, A_LAT = 2.2, DEC = 2.5;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** [{x, z}] -> a dense polyline (~step m) with every corner a circular arc (radius r, less where the legs are short). */
export function roundPath(pts, r = 5, step = 0.5) {
  const P = [];
  for (const p of pts) if (!P.length || Math.hypot(p.x - P[P.length - 1].x, p.z - P[P.length - 1].z) > 0.05) P.push({ x: p.x, z: p.z });
  const out = [P[0]];
  const line = (a, b) => { const l = Math.hypot(b.x - a.x, b.z - a.z), n = Math.max(1, Math.ceil(l / step)); for (let k = 1; k <= n; k++) out.push({ x: a.x + (b.x - a.x) * k / n, z: a.z + (b.z - a.z) * k / n }); };
  let prev = P[0];
  for (let i = 1; i < P.length - 1; i++) {
    const A = P[i - 1], B = P[i], C = P[i + 1], l1 = Math.hypot(B.x - A.x, B.z - A.z), l2 = Math.hypot(C.x - B.x, C.z - B.z);
    const u1x = (B.x - A.x) / l1, u1z = (B.z - A.z) / l1, u2x = (C.x - B.x) / l2, u2z = (C.z - B.z) / l2;
    const th = Math.acos(clamp(u1x * u2x + u1z * u2z, -1, 1)), cr = u1x * u2z - u1z * u2x;
    if (th < 0.02 || th > 3.0) { line(prev, B); prev = B; continue; } // (straight on; a cusp stays a point)
    const t2 = Math.tan(th / 2), d = Math.min(r * t2, l1 * (i === 1 ? 1 : 0.5), l2 * (i === P.length - 2 ? 1 : 0.5)), R = d / t2;
    const E1 = { x: B.x - u1x * d, z: B.z - u1z * d };
    line(prev, E1);
    // the centre: from E1 square to the leg, toward the turn
    const s = cr > 0 ? 1 : -1, ox = E1.x - u1z * s * R, oz = E1.z + u1x * s * R;
    const a0 = Math.atan2(E1.z - oz, E1.x - ox), n = Math.max(2, Math.ceil((R * th) / step));
    for (let k = 1; k <= n; k++) { const a = a0 + s * th * k / n; out.push({ x: ox + Math.cos(a) * R, z: oz + Math.sin(a) * R }); }
    prev = out[out.length - 1];
  }
  if (P.length > 1) line(prev, P[P.length - 1]);
  return out;
}

/** From p0 heading h0 ({x, z} unit) to p3 heading h3: the two lines meet -> one arc (radius up to r) between them; else an S (cubic Bézier). */
export function linkPath(p0, h0, p3, h3, r = 9, step = 0.5) {
  const den = h0.x * h3.z - h0.z * h3.x, dx = p3.x - p0.x, dz = p3.z - p0.z;
  if (Math.abs(den) > 0.15) {
    const t = (dx * h3.z - dz * h3.x) / den, u = (dx * h0.z - dz * h0.x) / den; // p0 + h0 t = p3 - h3 u
    if (t > 0.3 && u > 0.3 && t < 80 && u < 80) return roundPath([p0, { x: p0.x + h0.x * t, z: p0.z + h0.z * t }, p3], r, step);
  }
  const L = Math.hypot(dx, dz) * 0.4, out = [{ x: p0.x, z: p0.z }], n = Math.max(4, Math.ceil(Math.hypot(dx, dz) * 1.3 / step));
  const c1 = { x: p0.x + h0.x * L, z: p0.z + h0.z * L }, c2 = { x: p3.x - h3.x * L, z: p3.z - h3.z * L };
  for (let k = 1; k <= n; k++) {
    const t = k / n, a = (1 - t) ** 3, b = 3 * (1 - t) ** 2 * t, c = 3 * (1 - t) * t * t, e = t ** 3;
    out.push({ x: a * p0.x + b * c1.x + c * c2.x + e * p3.x, z: a * p0.z + b * c1.z + c * c2.z + e * p3.z });
  }
  return out;
}

/** A dense path made drivable: arc lengths S, the speed allowed at each point V (bends, braking to vEnd at its end). */
export function prepPath(P, { vMax = 3.6, vEnd = 0 } = {}) {
  const n = P.length, S = new Float32Array(n), V = new Float32Array(n), K = new Float32Array(n);
  for (let i = 1; i < n; i++) S[i] = S[i - 1] + Math.hypot(P[i].x - P[i - 1].x, P[i].z - P[i - 1].z);
  for (let i = 1; i < n - 1; i++) {
    const a = Math.atan2(P[i].x - P[i - 1].x, P[i].z - P[i - 1].z), b = Math.atan2(P[i + 1].x - P[i].x, P[i + 1].z - P[i].z);
    K[i] = Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a))) / Math.max(0.05, (S[i + 1] - S[i - 1]) / 2);
  }
  for (let i = 0; i < n; i++) { let k = 0; for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) k = Math.max(k, K[j]); V[i] = Math.min(vMax, Math.sqrt(A_LAT / Math.max(1e-4, k))); }
  V[n - 1] = Math.min(V[n - 1], vEnd);
  for (let i = n - 2; i >= 0; i--) V[i] = Math.min(V[i], Math.sqrt(V[i + 1] ** 2 + 2 * DEC * (S[i + 1] - S[i])));
  P.S = S; P.V = V; P.vEnd = vEnd; P.dense = true;
  return P;
}

/** Waypoints [{x, z}] for a car (first = where it stands) -> a prepped path: points already behind it dropped, corners rounded. */
export function carPath(c, pts, { r = 5, vMax = 3.6, vEnd = 0 } = {}) {
  const f = c.rev ? -1 : 1, hx = Math.sin(c.yaw) * f, hz = Math.cos(c.yaw) * f, P = pts.slice();
  while (P.length > 2 && (P[1].x - c.x) * hx + (P[1].z - c.z) * hz < 1) P.splice(1, 1);
  return prepPath(roundPath(P, r), { vMax, vEnd });
}

/**
 * One step along prepped path P for car c { x, z, yaw, v, rev, wheelBase, lotSteer, pi }: pure pursuit to a point
 * ahead on the path (steering angle within MAX_STEER, turned at most STEER_RATE rad/s), the speed it may drive (the
 * bends ahead, vCap, easing to a stop at a path's end), the bicycle model. Returns true at the path's end.
 */
export function followPath(c, P, dt, vCap = Infinity) {
  const n = P.length, last = P[n - 1];
  // progress: the nearest point (forward only, within a few metres)
  let i = c.pi || 0, best = Infinity;
  for (let j = i, e = Math.min(n - 1, i + 24); j <= e; j++) { const d = Math.hypot(P[j].x - c.x, P[j].z - c.z); if (d < best) { best = d; i = j; } }
  c.pi = i;
  const rem = P.S[n - 1] - P.S[i], toEnd = Math.hypot(last.x - c.x, last.z - c.z);
  const fwd = c.rev ? -1 : 1, hx = Math.sin(c.yaw) * fwd, hz = Math.cos(c.yaw) * fwd;
  if (P.vEnd > 0 ? rem < 0.6 : rem < 0.6 && (toEnd < 0.35 || ((last.x - c.x) * hx + (last.z - c.z) * hz < 0 && toEnd < 0.9))) return true;
  // the look-ahead point (further at speed)
  const ld = c.rev ? 2.4 : clamp(2.6 + 0.4 * c.v, 3, 6.5);
  let j = i;
  while (j < n - 1 && P.S[j] - P.S[i] < ld) j++;
  const dx = P[j].x - c.x, dz = P[j].z - c.z, L = Math.max(2.2, Math.hypot(dx, dz));
  const alpha = Math.atan2(dx * hz - dz * hx, dx * hx + dz * hz); // (+ = left of the travel direction)
  const want = clamp(Math.atan2(2 * c.wheelBase * Math.sin(alpha), L), -MAX_STEER, MAX_STEER) * fwd; // (reversing: the wheels the other way)
  const st = c.lotSteer || 0;
  c.lotSteer = st + clamp(want - st, -dt * STEER_RATE, dt * STEER_RATE);
  // the speed: the bends ahead (the profile), anything in the way (vCap), to a stop at the end
  let vt = Math.min(P.V[i], vCap);
  if (!(P.vEnd > 0)) vt = Math.min(vt, Math.sqrt(Math.max(0, 2 * 1.2 * (Math.min(rem, toEnd + 0.3) - 0.25))) + 0.15);
  c.v = Math.max(0, c.v + clamp(vt - c.v, -3.2 * dt, 1.4 * dt));
  c.brake = vt < c.v - 0.2 ? 1 : 0;
  c.yaw += (c.v / c.wheelBase) * Math.tan(c.lotSteer) * fwd * dt;
  c.yaw = Math.atan2(Math.sin(c.yaw), Math.cos(c.yaw));
  c.x += Math.sin(c.yaw) * c.v * dt * fwd; c.z += Math.cos(c.yaw) * c.v * dt * fwd;
  return false;
}
