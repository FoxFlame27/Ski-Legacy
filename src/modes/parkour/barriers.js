// Barriers along both sides of a course, World Cup style, continuous from start to finish:
//   inner row (piste edge)  red B-nets on slim aluminium poles. One continuous net run carries on in
//                           front of the boulders of 'rock' sections, the ice walls of 'ice' sections
//                           and the plowed banks of 'snowbank' sections; padded advertising boards
//                           around the finish arena ('arena'); the bridge railing and the tunnel walls
//                           take over on the structures (structures.js)
//   outer row (track.AN)    tall red A-nets on guyed steel posts on the outside of fast turns and above
//                           drops, padded posts at the run ends, big banners
// Placement: every post is planted on the snow surface as it is rendered (kit.meshGround: the 2 m
// terrain mesh), and continues 0.6-0.8 m below it; net panels hang post to post with their bottom edge
// buried 0.25 m in the snow and sampled every metre, so nothing floats and no gap opens under a net at
// any LOD. Runs start and end with a post (A-nets: a padded post) and B-net runs join seamlessly
// across inner types. Everything is merged per ~220 m chunk (one draw call per material per chunk).
import * as THREE from 'three';
import { world } from '../../world/world.js';
import { mulberry32 } from '../../core/noise.js';
import { boulderKit, withGround, BOULDER_VARIANTS } from '../../world/boulders.js';
import { MeshBuilder, tint, vcMaterial, canvasTexture, meshGround, FONT, BLUE } from './kit.js';
import { DS, BARRIER, INNER_OFFSET, NET_FRONT } from './track.js';
import { sponsorAtlas, bannerUV, pickBanner } from '../../world/sponsors.js';
import { netCut } from '../../world/resortdressing.js';
import { lookOf } from './looks.js';

const CHUNK = 220;
const RED = '#d9221c';
// B-net / A-net geometry (m)
const BNET = { H: 2.1, post: 2.25, sp: 4.2, bury: 0.25, deep: 0.6 };
const ANET = { H: 4.4, post: 4.6, sp: 5.5, bury: 0.3, deep: 0.8 };
const ICE_OFF = 2.7; // ice walls stand behind the B-net, at the foot of the canyon wall (u = 3.6)
const ROCK_OFF = 2.6; // boulders behind the B-net, at the foot of the rock wall (u = 4)

// ------------------------------------------------------------------ textures / materials
function netTexture(color = RED) {
  // knotted mesh (red, or the course's own colour) with a rope band along the top and a dense band at the
  // bottom (v = 0..1 = height)
  const dark = '#' + new THREE.Color(color).multiplyScalar(0.72).getHexString();
  return canvasTexture(256, 512, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.strokeStyle = color;
    g.lineWidth = 7;
    const cell = 32;
    for (let k = -h; k < w + h; k += cell) {
      g.beginPath(); g.moveTo(k, 0); g.lineTo(k + h, h); g.stroke();
      g.beginPath(); g.moveTo(k, 0); g.lineTo(k - h, h); g.stroke();
    }
    g.fillStyle = color;
    g.fillRect(0, 0, w, 20); g.fillRect(0, h - 14, w, 14);
    g.fillStyle = color === RED ? '#9e1612' : dark;
    g.fillRect(0, 20, w, 4); g.fillRect(0, h - 17, w, 3);
  }, { wrap: true, anisotropy: 8 });
}

function iceMaterial() {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.14, metalness: 0, envMapIntensity: 1.35, transparent: true, opacity: 0.9 });
  m.onBeforeCompile = (s) => {
    s.fragmentShader = s.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      {
        // fake translucency: light scattering through thin ice glows at grazing angles and at the crest
        float fres = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), 3.0);
        totalEmissiveRadiance += vColor.rgb * vec3(0.55, 0.8, 1.0) * (0.06 + 0.42 * fres);
      }`);
  };
  m.customProgramCacheKey = () => 'parkour-ice-wall';
  return m;
}

// ------------------------------------------------------------------ main
export function buildBarriers(course, models = {}) {
  const T = course.track;
  const group = new THREE.Group();
  group.name = 'barriers';
  const mats = {
    solid: vcMaterial({ roughness: 0.7, metalness: 0.15 }),
    net: new THREE.MeshStandardMaterial({ color: 0xffffff, map: netTexture(lookOf(course).colors?.net || RED), roughness: 0.85, side: THREE.DoubleSide, alphaToCoverage: true, transparent: false }),
    ice: iceMaterial(),
    banner: new THREE.MeshStandardMaterial({ map: sponsorAtlas(), roughness: 0.6, side: THREE.DoubleSide }), // sponsors + house banners (world/sponsors.js)
  };
  if (!mats.net.map) { mats.net.color.set(lookOf(course).colors?.net || RED); mats.net.transparent = true; mats.net.opacity = 0.55; mats.net.alphaToCoverage = false; }
  else {
    // without MSAA alpha to coverage does nothing and the holes rendered black: cut them out (see netCut)
    mats.net.onBeforeCompile = (sh) => {
      sh.uniforms.uNetCut = netCut;
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uNetCut;')
        .replace('#include <alphatest_fragment>', `
          if (uNetCut > 0.5) {
            // close: the holes are cut out; further away (small mips) the mesh is a solid band in its own red
            vec2 tdx = dFdx(vMapUv * vec2(256.0, 512.0)), tdy = dFdy(vMapUv * vec2(256.0, 512.0));
            float netFar = smoothstep(1.2, 2.6, max(0.0, 0.5 * log2(max(dot(tdx, tdx), dot(tdy, tdy)))));
            diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb / max(sampledDiffuseColor.a, 0.1) * 0.48, netFar);
            if (diffuseColor.a < 0.5 * (1.0 - netFar)) discard;
          }
          #include <alphatest_fragment>`);
    };
    mats.net.customProgramCacheKey = () => 'parkour-net-cut3';
  }
  if (!mats.banner.map) mats.banner.color.set(0xf4f6fb);

  // boulders: the world's procedural granite (world/boulders.js), two detail levels
  const kit = boulderKit();

  const chunks = new Map();
  const chunk = (s) => {
    const k = Math.max(0, Math.floor(s / CHUNK));
    let c = chunks.get(k);
    if (!c) {
      c = { solid: new MeshBuilder(), net: new MeshBuilder({ uv: true }), ice: new MeshBuilder(), banner: new MeshBuilder({ uv: true }), rocks: [] };
      chunks.set(k, c);
    }
    return c;
  };
  // layout record for the tests: posts [x, base, z, top, kind] and net samples [s, x, z, bottom, top, kind]
  const layout = { posts: [], nets: [], runs: [[], []] };
  const ctx = { T, course, chunk, layout, rnd: mulberry32(course.def.seed * 31 + 7), kit };

  for (let side = 0; side < 2; side++) {
    const sg = side ? 1 : -1;
    const BAR = T.BAR[side];
    // --- inner row: runs of one "front" (B-net across bnet/rock/ice/snowbank, boards, fence)
    const front = (code) => (NET_FRONT.has(code) ? 'net' : code === BARRIER.arena ? 'arena' : code === BARRIER.fence ? 'fence' : null);
    eachRun(T.n, (i) => front(BAR[i]), (kind, i0, i1) => {
      if (!kind) return;
      const [sA, sB] = runSpan(T, i0, i1, course);
      if (sB - sA < 1) return;
      layout.runs[side].push({ kind, s0: sA, s1: sB });
      const line = edgeLine(T, sA, sB, sg, () => INNER_OFFSET[BARRIER.bnet]);
      const rnd = mulberry32((course.def.seed * 31 + side * 7 + i0) >>> 0);
      if (kind === 'net') buildNet(ctx, line, BNET, rnd, 'b');
      else if (kind === 'arena') buildBoards(ctx, line, rnd);
      else buildFence(ctx, line, rnd);
    });
    // --- decorations behind the B-net: boulders at rock walls, ice walls at canyon walls
    eachRun(T.n, (i) => (BAR[i] === BARRIER.rock || BAR[i] === BARRIER.ice ? BAR[i] : 0), (code, i0, i1) => {
      if (!code) return;
      const [sA, sB] = runSpan(T, i0, i1, course);
      if (sB - sA < 4) return;
      const rnd = mulberry32((course.def.seed * 17 + side * 5 + i0) >>> 0);
      if (code === BARRIER.ice) buildIce(ctx, edgeLine(T, sA, sB, sg, () => ICE_OFF), rnd);
      else buildRocks(ctx, edgeLine(T, sA, sB, sg, () => ROCK_OFF), rnd);
    });
    // --- outer row: A-nets
    const AOFF = T.AOFF[side];
    eachRun(T.n, (i) => T.AN[side][i], (on, i0, i1) => {
      if (!on) return;
      const sA = i0 * DS, sB = Math.min(T.length, i1 * DS);
      if (sB - sA < 20) return;
      const line = edgeLine(T, sA, sB, sg, (s) => T.sAt(AOFF, s));
      buildNet(ctx, line, ANET, mulberry32((course.def.seed * 13 + side * 3 + i0) >>> 0), 'a');
    });
  }
  // inner-row coverage of the structures (for the continuity tests)
  for (let side = 0; side < 2; side++) {
    if (course.bridge) layout.runs[side].push({ kind: 'railing', s0: course.bridge.s0, s1: course.bridge.s1 });
    if (course.tunnel) layout.runs[side].push({ kind: 'tunnel', s0: course.tunnel.s0, s1: course.tunnel.s1 });
    layout.runs[side].sort((a, b) => a.s0 - b.s0);
  }

  // assemble chunk meshes
  const dummy = new THREE.Object3D();
  for (const c of chunks.values()) {
    const add = (b, mat, cast = true) => {
      if (!b.I.length) return null;
      const m = new THREE.Mesh(b.build(), mat);
      m.castShadow = cast; m.receiveShadow = true;
      group.add(m);
      return m;
    };
    add(c.solid, mats.solid);
    add(c.net, mats.net, false);
    add(c.ice, mats.ice);
    add(c.banner, mats.banner);
    if (c.rocks.length) {
      // LOD around the chunk centre: the detailed boulders near, the light ones beyond; one instanced mesh
      // per shape variant, each instance with its snow line (aGround, world space) for the drift at its foot
      let cx = 0, cy = 0, cz = 0;
      for (const r of c.rocks) { cx += r.x; cy += r.y; cz += r.z; }
      cx /= c.rocks.length; cy /= c.rocks.length; cz /= c.rocks.length;
      const lod = new THREE.LOD();
      lod.position.set(cx, cy, cz);
      for (const [geos, dist] of [[kit.hi, 0], [kit.lo, 160]]) {
        const level = new THREE.Group();
        for (let v = 0; v < BOULDER_VARIANTS; v++) {
          const list = c.rocks.filter((r) => r.v === v);
          if (!list.length) continue;
          const im = new THREE.InstancedMesh(withGround(geos[v], list.length), kit.material, list.length);
          const ground = im.geometry.attributes.aGround;
          list.forEach((r, k) => {
            dummy.position.set(r.x - cx, r.y - cy, r.z - cz);
            dummy.rotation.set(r.rx, r.ry, r.rz);
            dummy.scale.set(r.s * r.sx, r.s * r.sy, r.s);
            dummy.updateMatrix();
            im.setMatrixAt(k, dummy.matrix);
            ground.setXYZ(k, r.gx, r.gz, r.gh);
          });
          im.castShadow = dist === 0; im.receiveShadow = true;
          im.computeBoundingSphere();
          level.add(im);
        }
        lod.addLevel(level, dist);
      }
      group.add(lod);
    }
  }
  group.userData.materials = mats;
  group.userData.layout = layout;
  return group;
}

// ------------------------------------------------------------------ runs and lines
// Calls fn(value, i0, i1) for every maximal run of equal key(i) over samples [i0, i1).
function eachRun(n, key, fn) {
  let i0 = 0, k0 = key(0);
  for (let i = 1; i <= n; i++) {
    const k = i < n ? key(i) : Symbol('end');
    if (k === k0) continue;
    fn(k0, i0, i);
    i0 = i; k0 = k;
  }
}
// Arc-length span of samples [i0, i1): runs meet at the section boundary between samples; next to a
// tunnel the nets stop at the portal headwall face, at the bridge they hand over to the railing.
function runSpan(T, i0, i1, course) {
  let sA = i0 * DS, sB = Math.min(T.length, i1 * DS);
  const tn = course.tunnel;
  if (tn) {
    if (Math.abs(sB - tn.s0) < DS * 1.5) sB = tn.s0 - 0.25;
    if (Math.abs(sA - tn.s1) < DS * 1.5) sA = tn.s1 + 0.25;
  }
  return [sA, sB];
}

// The snow a barrier stands on: the rendered surface, except where the 2 m terrain mesh cannot follow a
// vertical cut (tunnel trench at the portals): there the exact, lower floor (the post is then set into
// the rendered slope instead of standing on top of it).
function snowAt(x, z) {
  const m = meshGround(x, z), e = world.height(x, z);
  return m - e > 0.5 ? e : m;
}

// Points along one side of the track at lateral w + off(s), every ~1 m, on the rendered snow surface.
function edgeLine(T, sA, sB, sg, off) {
  const pts = [];
  let len = 0, px = 0, pz = 0;
  const p = {};
  const n = Math.max(1, Math.ceil(sB - sA));
  for (let k = 0; k <= n; k++) {
    const s = sA + ((sB - sA) * k) / n;
    const w = T.sAt(T.W, s);
    T.pointAt(s, sg * (w + off(s)), p);
    if (pts.length) len += Math.hypot(p.x - px, p.z - pz);
    const tx = Math.sin(p.heading), tz = Math.cos(p.heading);
    pts.push({ s, x: p.x, z: p.z, y: snowAt(p.x, p.z), l: len, tx, tz, nx: -tz * sg, nz: tx * sg, w });
    px = p.x; pz = p.z;
  }
  return { pts, len };
}
// point on the barrier line at arc length l (linear interpolation), ground on the rendered surface
function lineAt(line, l, out = {}) {
  const P = line.pts;
  let lo = 0, hi = P.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (P[mid].l < l) lo = mid; else hi = mid; }
  const a = P[lo], b = P[hi];
  const t = b.l > a.l ? Math.min(1, Math.max(0, (l - a.l) / (b.l - a.l))) : 0;
  out.x = a.x + (b.x - a.x) * t; out.z = a.z + (b.z - a.z) * t; out.s = a.s + (b.s - a.s) * t;
  out.y = snowAt(out.x, out.z);
  out.tx = a.tx; out.tz = a.tz; out.nx = a.nx; out.nz = a.nz;
  return out;
}

// ------------------------------------------------------------------ nets (B-net / A-net)
const WHITE = new THREE.Color(1, 1, 1);
// Post stations (arc length) along a line: regular spacing, with extra posts wherever the snow between
// two posts departs more than 0.3 m from the straight line between their feet (bumps, berms, dips), so
// panels stay a constant height above the snow.
function postStations(line, sp) {
  const n = Math.max(1, Math.round(line.len / sp));
  const q = {}, g = (l) => lineAt(line, l, q).y;
  const st = [0];
  const split = (la, lb, depth) => {
    const ya = g(la), yb = g(lb);
    let dev = 0;
    for (let l = la + 0.5; l < lb - 0.25; l += 0.5) dev = Math.max(dev, Math.abs(g(l) - (ya + ((yb - ya) * (l - la)) / (lb - la))));
    if (dev > 0.3 && lb - la > 1.4 && depth < 3) { const m = (la + lb) / 2; split(la, m, depth + 1); split(m, lb, depth + 1); } else st.push(lb);
  };
  for (let k = 0; k < n; k++) split((k * line.len) / n, ((k + 1) * line.len) / n, 0);
  return st;
}

function buildNet(ctx, line, N, rnd, kind) {
  const { chunk, layout } = ctx;
  const ST = postStations(line, N.sp);
  const n = ST.length - 1;
  const a = {}, b = {}, q = {};
  const pole = kind === 'a' ? tint('#3b4048') : tint('#c3c8cf'), cap = tint(RED), strut = tint('#4a5058');
  const padBlue = tint(BLUE), padWhite = tint('#f2f4f8'), padRed = tint(RED);
  const pr = kind === 'a' ? 0.055 : 0.03, ps = kind === 'a' ? 7 : 5;
  let bannerAt = (kind === 'a' ? 12 : 8) + rnd() * 14;
  for (let k = 0; k <= n; k++) {
    lineAt(line, ST[k], a);
    const c = chunk(a.s);
    // post: planted on the rendered snow, continuing below it
    c.solid.at(a.x, a.y - N.deep, a.z).cyl(0, 0, 0, pr, pr * 0.85, N.post + N.deep, ps, pole, { top: false });
    c.solid.at(a.x, a.y + N.post, a.z).cyl(0, 0, 0, pr * 1.25, pr * 1.25, 0.07, ps, cap);
    layout.posts.push(a.x, a.y, a.z, a.y + N.post, kind === 'a' ? 1 : 0);
    if (kind === 'a') {
      // guy strut to a ground anchor 2.4 m outside, and padded posts at the run ends
      const gx = a.x + a.nx * 2.4, gz = a.z + a.nz * 2.4, gy = meshGround(gx, gz);
      c.solid.at(0, 0, 0).rod(a.x + a.nx * 0.05, a.y + 3.3, a.z + a.nz * 0.05, gx, gy - 0.3, gz, 0.022, 5, strut);
      if (k === 0 || k === n) {
        c.solid.at(a.x, a.y - 0.2, a.z).cyl(0, 0, 0, 0.3, 0.3, 2.2, 14, padBlue, { colTop: padRed });
        c.solid.at(a.x, a.y + 1.15, a.z).cyl(0, 0, 0, 0.31, 0.31, 0.32, 14, padWhite, { top: false });
        c.solid.at(a.x, a.y + 2.0, a.z).cyl(0, 0, 0, 0.31, 0.31, 0.2, 14, padRed, { colTop: padRed });
      }
    }
    if (k === n) break;
    lineAt(line, ST[k + 1], b);
    // net panel: top hangs from the post tops with a slight sag, bottom buried in the snow; columns
    // ~1 m apart so the bottom edge follows the snow
    const sp = ST[k + 1] - ST[k];
    const seg = Math.max(1, Math.round(sp));
    const topA = a.y + N.H, topB = b.y + N.H;
    const base = c.net.count;
    for (let j = 0; j <= seg; j++) {
      const t = j / seg;
      lineAt(line, ST[k] + t * sp, q);
      const top = topA + (topB - topA) * t - (kind === 'a' ? 0.16 : 0.08) * (sp / N.sp) * 4 * t * (1 - t);
      const bot = q.y - N.bury;
      const u = ST[k] + t * sp;
      c.net.at(0, 0, 0);
      c.net.v(q.x, bot, q.z, q.nx, 0, q.nz, WHITE, u / (kind === 'a' ? 1.5 : 1), -N.bury / N.H);
      c.net.v(q.x, top, q.z, q.nx, 0, q.nz, WHITE, u / (kind === 'a' ? 1.5 : 1), (top - q.y) / N.H);
      if (j < seg || k === n - 1) layout.nets.push(q.s, q.x, q.z, bot, top, kind === 'a' ? 1 : 0);
    }
    for (let j = 0; j < seg; j++) { const i = base + j * 2; c.net.quad(i, i + 2, i + 3, i + 1); }
    // sponsor banners tied onto the net, following the slope of the net (one every few panels)
    const l0 = ST[k];
    if (l0 > bannerAt && l0 + (kind === 'a' ? 6.2 : 3.6) < line.len - 1) {
      bannerAt = l0 + (kind === 'a' ? 16 + rnd() * 12 : 10 + rnd() * 8);
      const row = pickBanner(ctx.course.id, rnd);
      if (kind === 'a') addBanner(c.banner, line, l0 + 0.6, 6, 1.25, 2.55, 0.06, row);
      else addBanner(c.banner, line, l0 + 0.3, 3.5, 0.8, 0.32, 0.05, row);
    }
  }
}

// A banner on the track side of a net / board line, `front` m in front of it: its bottom edge follows
// the snow (y0 above it at both ends), so on a slope it is the sheared rectangle a tied banner makes.
// Uses row `row` of the banner atlas.
function addBanner(b, line, l0, len, h, y0, front, row) {
  const p0 = lineAt(line, l0, {}), p1 = lineAt(line, l0 + len, {});
  const tx = -p0.nx, tz = -p0.nz; // toward the track
  const ya = p0.y + y0, yb = p1.y + y0;
  const ax = p0.x + tx * front, az = p0.z + tz * front, bx = p1.x + tx * front, bz = p1.z + tz * front;
  const { u0, u1, v0, v1 } = bannerUV(row);
  // the text must read left-to-right from the track: u runs from the viewer's left to right
  const right = (bx - ax) * tz - (bz - az) * tx > 0; // is b to the right of a viewer on the track?
  const ua = right ? u0 : u1, ub = right ? u1 : u0;
  b.at(0, 0, 0);
  const i0 = b.v(ax, ya, az, tx, 0, tz, WHITE, ua, v0);
  const i1 = b.v(bx, yb, bz, tx, 0, tz, WHITE, ub, v0);
  const i2 = b.v(bx, yb + h, bz, tx, 0, tz, WHITE, ub, v1);
  const i3 = b.v(ax, ya + h, az, tx, 0, tz, WHITE, ua, v1);
  windToward(b, i0, i1, i2, i3, tx, 0, tz);
  // back side: plain border colour of the row
  const vb = v1 - 0.002, ubk = u0 + 0.004; // a corner pixel: the banner's background colour
  const j0 = b.v(ax - tx * 0.01, ya, az - tz * 0.01, -tx, 0, -tz, WHITE, ubk, vb);
  const j1 = b.v(bx - tx * 0.01, yb, bz - tz * 0.01, -tx, 0, -tz, WHITE, ubk, vb);
  const j2 = b.v(bx - tx * 0.01, yb + h, bz - tz * 0.01, -tx, 0, -tz, WHITE, ubk, vb);
  const j3 = b.v(ax - tx * 0.01, ya + h, az - tz * 0.01, -tx, 0, -tz, WHITE, ubk, vb);
  windToward(b, j0, j1, j2, j3, -tx, 0, -tz);
}

// emit quad (a,b,c,d) with the winding whose geometric normal points along (dx,dy,dz)
function windToward(b, i0, i1, i2, i3, dx, dy, dz) {
  const P = b.P;
  const ux = P[i1 * 3] - P[i0 * 3], uy = P[i1 * 3 + 1] - P[i0 * 3 + 1], uz = P[i1 * 3 + 2] - P[i0 * 3 + 2];
  const vx = P[i3 * 3] - P[i0 * 3], vy = P[i3 * 3 + 1] - P[i0 * 3 + 1], vz = P[i3 * 3 + 2] - P[i0 * 3 + 2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  if (nx * dx + ny * dy + nz * dz >= 0) b.quad(i0, i1, i2, i3);
  else b.quad(i0, i3, i2, i1);
}

// ------------------------------------------------------------------ timber fence (start plateaus of
// custom layouts; the World Cup courses use B-nets)
function buildFence(ctx, line, rnd) {
  const SP = 3;
  const n = Math.max(1, Math.round(line.len / SP));
  const sp = line.len / n;
  const a = {}, b = {};
  const snow = tint('#f4f7fc');
  for (let k = 0; k <= n; k++) {
    lineAt(line, k * sp, a);
    const c = ctx.chunk(a.s);
    const wood = tint('#6d533b', 0.12, a.x + a.z);
    const pH = 1.32 + rnd() * 0.08;
    c.solid.at(a.x, a.y - 0.45, a.z, rnd() * 6).cyl(0, 0, 0, 0.085, 0.075, pH + 0.45, 7, wood, { colTop: snow });
    c.solid.at(a.x, a.y + pH, a.z).cyl(0, 0, 0, 0.082, 0.035, 0.07, 7, snow, { colTop: snow });
    ctx.layout.posts.push(a.x, a.y, a.z, a.y + pH, 2);
    if (k === n) break;
    lineAt(line, (k + 1) * sp, b);
    const rail = tint('#7a5d42', 0.1, a.z * 3.1);
    for (const [hh, r] of [[0.5, 0.055], [1.02, 0.06]]) {
      const ya = a.y + hh, yb = b.y + hh;
      c.solid.at(0, 0, 0).rod(a.x, ya, a.z, b.x, yb, b.z, r, 6, rail);
      c.solid.at(0, 0, 0).rod(a.x, ya + r * 0.8, a.z, b.x, yb + r * 0.8, b.z, r * 0.62, 5, snow);
    }
  }
}

// ------------------------------------------------------------------ boulders behind the B-net
function buildRocks(ctx, line, rnd) {
  const a = {};
  for (let l = rnd() * 1.5; l < line.len; l += 1.6 + rnd() * 1.4) {
    lineAt(line, l, a);
    const c = ctx.chunk(a.s);
    const s = 1.1 + rnd() * 0.9;
    const back = rnd() * 0.8; // a little further out, never toward the net
    const x = a.x + a.nx * back, z = a.z + a.nz * back;
    // lowest ground under the boulder's footprint so it never floats (wall foot, berms)
    let g = Infinity;
    for (const [u, v] of [[0, 0], [0.4, 0], [-0.4, 0], [0, 0.4], [0, -0.4]]) g = Math.min(g, meshGround(x + a.tx * s * u + a.nx * s * v, z + a.tz * s * u + a.nz * s * v));
    const sy = 0.8 + rnd() * 0.35;
    if (ctx.kit) {
      // a boulder settled 20 % into the snow (its origin is the middle of its base)
      const v = Math.min(BOULDER_VARIANTS - 1, Math.floor(rnd() * BOULDER_VARIANTS));
      const height = ctx.kit.height[v] * s * sy;
      const gh = meshGround(x, z), gx = (meshGround(x + 0.5, z) - meshGround(x - 0.5, z)), gz = (meshGround(x, z + 0.5) - meshGround(x, z - 0.5));
      c.rocks.push({ x, y: g - height * 0.2, z, s, v, sx: 0.95 + rnd() * 0.3, sy, rx: (rnd() - 0.5) * 0.16, ry: rnd() * 6.28, rz: (rnd() - 0.5) * 0.16, gx, gz, gh });
    } else {
      const seed = rnd() * 100;
      const rock = tint('#5f5a54', 0.12, seed);
      const dark = rock.clone().multiplyScalar(0.6), snow = tint('#eef3fa');
      const height = s * sy;
      c.solid.at(x, g + height * 0.3, z, rnd() * 6.28, (rnd() - 0.5) * 0.25, 0, s * (0.9 + rnd() * 0.35), height, s);
      c.solid.blob(0, 0, 0, (nx, ny, nz) => 0.5 * (1 + 0.16 * Math.sin(nx * 5.1 + seed) * Math.cos(nz * 4.3 - seed) + 0.1 * Math.sin(ny * 9 + seed * 2)), 1,
        (px, py, pz, ny) => (ny > 0.62 ? snow : ny < -0.2 ? dark : rock));
    }
  }
}

// ------------------------------------------------------------------ ice walls behind the B-net
function buildIce(ctx, line, rnd) {
  const STEP = 1.25;
  const n = Math.max(1, Math.round(line.len / STEP));
  const st = line.len / n;
  const P = [];
  for (let k = 0; k <= n; k++) {
    const p = lineAt(line, k * st, {});
    p.h = 2.2 + 0.5 * Math.sin(k * 0.37 + rnd() * 0.5) + rnd() * 0.6; // jagged crest
    p.lean = (rnd() - 0.5) * 0.12;
    P.push(p);
  }
  const deep = tint('#2f78b3'), mid = tint('#7fc4ec'), light = tint('#d6f1ff'), snow = tint('#f3f8ff');
  for (let k = 0; k < n; k++) {
    const a = P[k], b = P[k + 1];
    const c = ctx.chunk(a.s);
    // cross-section: inner face (toward the track), crest, outer face; flat-shaded facets
    const sec = (p) => {
      const tOut = 0.85, top = 0.32;
      return {
        b0: [p.x, p.y - 0.35, p.z],
        t0: [p.x + p.nx * (0.12 + p.lean), p.y + p.h, p.z + p.nz * (0.12 + p.lean)],
        t1: [p.x + p.nx * (0.12 + top + p.lean), p.y + p.h - 0.08, p.z + p.nz * (0.12 + top + p.lean)],
        b1: [p.x + p.nx * tOut, p.y - 0.35, p.z + p.nz * tOut],
      };
    };
    const A = sec(a), B = sec(b);
    const tx = -a.nx, tz = -a.nz; // toward the track
    face(c.ice, A.b0, B.b0, B.t0, A.t0, deep, light, tx, 0.2, tz);
    face(c.ice, A.t0, B.t0, B.t1, A.t1, snow, snow, 0, 1, 0);
    face(c.ice, A.t1, B.t1, B.b1, A.b1, light, mid, -tx, 0.2, -tz);
    if (k === 0) cap(c.ice, A, -a.tx, -a.tz, deep, light);
    if (k === n - 1) cap(c.ice, B, b.tx, b.tz, deep, light);
  }
}
// end cap of an ice wall run (the wall's cross-section), facing along (dx, dz)
function cap(b, S, dx, dz, c0, c1) {
  b.at(0, 0, 0);
  const n = [dx, 0, dz];
  const i0 = b.v(...S.b0, ...n, c0), i1 = b.v(...S.t0, ...n, c1), i2 = b.v(...S.t1, ...n, c1), i3 = b.v(...S.b1, ...n, c0);
  windToward(b, i0, i1, i2, i3, dx, 0, dz);
}
// one flat-shaded quad with a vertical colour gradient (bottom c0 -> top c1), wound to face (dx,dy,dz)
function face(b, p0, p1, p2, p3, c0, c1, dx, dy, dz) {
  const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
  const vx = p3[0] - p0[0], vy = p3[1] - p0[1], vz = p3[2] - p0[2];
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  if (nx * dx + ny * dy + nz * dz < 0) { nx = -nx; ny = -ny; nz = -nz; }
  const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
  b.at(0, 0, 0);
  const i0 = b.v(p0[0], p0[1], p0[2], nx, ny, nz, c0);
  const i1 = b.v(p1[0], p1[1], p1[2], nx, ny, nz, c0);
  const i2 = b.v(p2[0], p2[1], p2[2], nx, ny, nz, c1);
  const i3 = b.v(p3[0], p3[1], p3[2], nx, ny, nz, c1);
  windToward(b, i0, i1, i2, i3, nx, ny, nz);
}

// ------------------------------------------------------------------ finish-area boards
// Padded advertising boards (blue frame, printed banner face) on two feet, each level and set into
// the snow at its uphill end, stepping down the slope board by board.
function buildBoards(ctx, line, rnd) {
  const { chunk, course, layout } = ctx;
  const L = 3.0, H = 1.0;
  const n = Math.max(1, Math.round(line.len / L));
  const sp = line.len / n;
  const a = {}, b = {};
  const white = tint('#f3f5fa'), blue = tint(BLUE), frame = tint('#30343c');
  for (let k = 0; k < n; k++) {
    lineAt(line, k * sp, a); lineAt(line, (k + 1) * sp - 0.08, b);
    const c = chunk(a.s);
    const y = Math.min(a.y, b.y, meshGround((a.x + b.x) / 2, (a.z + b.z) / 2));
    const yaw = Math.atan2(b.x - a.x, b.z - a.z);
    const cx = (a.x + b.x) / 2, cz = (a.z + b.z) / 2;
    c.solid.at(cx, y, cz, yaw);
    c.solid.box(0, H / 2 + 0.02, 0, 0.26, H + 0.04, sp - 0.08, white, blue);
    c.solid.box(0, 0.04, 0, 0.6, 0.12, sp * 0.9, frame);
    layout.posts.push(cx, y, cz, y + H, 3);
    // printed face: a level banner on the board (both ends at the board's own level)
    boardFace(c.banner, a, b, y + 0.14, H * 0.84, pickBanner(course.id, rnd));
  }
}
function boardFace(bb, a, b, y, h, row) {
  const tx = -a.nx, tz = -a.nz, f = 0.135;
  const ax = a.x + tx * f, az = a.z + tz * f, bx = b.x + tx * f, bz = b.z + tz * f;
  const { u0, u1, v0, v1 } = bannerUV(row);
  const right = (bx - ax) * tz - (bz - az) * tx > 0;
  const ua = right ? u0 : u1, ub = right ? u1 : u0;
  bb.at(0, 0, 0);
  const i0 = bb.v(ax, y, az, tx, 0, tz, WHITE, ua, v0), i1 = bb.v(bx, y, bz, tx, 0, tz, WHITE, ub, v0);
  const i2 = bb.v(bx, y + h, bz, tx, 0, tz, WHITE, ub, v1), i3 = bb.v(ax, y + h, az, tx, 0, tz, WHITE, ua, v1);
  windToward(bb, i0, i1, i2, i3, tx, 0, tz);
}

export { lineAt, edgeLine, windToward, WHITE };
