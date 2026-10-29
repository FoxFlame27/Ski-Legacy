// New transport in the layout (layout.js calls buildTransport once from initLayout, before the crag mask, the
// mid-stations, the towers, the nets, the bus stops and the procedural races): the Wolkenspitzbahn's ground works
// (roadbed, station pads, tree clearing, its line for the trail map), the Wolkenspitze's glacier lifts, runs and
// restaurant, the Wolkensee Gondola over to the Adlerhorn with the Seeabfahrt, and the Sonnenwiese beginner chair
// by the village. Pure layout (no THREE): it runs in Node too.
import { world } from './world.js';
import { RAIL, railAt, railBounds, railNearest, shapeRoadbed, planBridges, railDeckHeight } from './railroute.js';
import { WOLKENSPITZE } from './wolkenspitze.js';
import { LEGACY_PEAK, spinePoint } from './legacypeak.js';
import { smoothstep } from '../core/noise.js';

const _f = { x: 0, y: 0, z: 0, dx: 0, dz: 1, grade: 0, i: 0 };
const _n = { d: 0, s: 0, side: 0, i: 0 };
const beside = (s, lat) => { railAt(s, _f); return { x: _f.x - _f.dz * lat, z: _f.z + _f.dx * lat, y: _f.y }; };

/**
 * kit: helpers from layout.js { layout, addLift, addPiste, keepOut, routePiste, tracePath, faceUV, placeMid, BAND,
 * PISTE_WIDTH, VILLAGE_BUILDINGS }
 */
export function buildTransport(kit) {
  buildRailwayGround(kit);
  buildGlacier(kit);
  buildWolkensee(kit);
  buildSonnenwiese(kit);
}

// a routing face (layout.js routePiste): top -> bottom, u down the face, v across it
function face(id, top, bottom, halfW = 520, bowl = 380) {
  const dx = bottom.x - top.x, dz = bottom.z - top.z, l = Math.hypot(dx, dz);
  return { id, top: { x: top.x, z: top.z }, fx: dx / l, fz: dz / l, faceLen: l, bowl, halfW };
}
const P = WOLKENSPITZE.plateau, PC = Math.cos(P.rot), PS = Math.sin(P.rot);
// a point on the glacier plateau in its own frame (u up the glacier toward the back wall, v across it)
const plat = (u, v) => ({ x: P.x + u * PC - v * PS, z: P.z + u * PS + v * PC });

// ------------------------------------------------------------------ the Wolkenplatt (glacier plateau)
// The train arrives under the glacier; its station building stands on the ice. From there the Firnfeld chair
// (an easy first ride) climbs the sunny side, the Gletscherjet gondola runs the length of the glacier from its
// lower end to the back of the cirque, and the Firnboden chair brings you from the lower glacier back up to the
// station. Runs: the blue Gletscherpiste down the middle, the green Firnweg past the station, the Sonnenplatte
// under the Firnfeld chair and the Wolkenplatt-Abfahrt from the station down to the Gletscherjet.
function buildGlacier({ layout, addLift, addPiste, routePiste, faceUV, BAND }) {
  const platt = RAIL.stations.find((st) => st.id === 'platt');
  const station = beside((platt.s0 + platt.s1) / 2, 0);
  // (procedural: like the backcountry lifts it gets no ski-bus stop, base sign or village wayfinding board: only
  // the Wolkenspitzbahn comes up here)
  const jet = addLift({ type: 'gondola', name: 'Gletscherjet', bottom: plat(-470, -150), top: plat(660, -40), price: 30, glacier: true, procedural: true,
    topName: 'the back of the glacier', bottomName: 'the lower glacier' });
  const firn = addLift({ type: 'chair', name: 'Firnfeld Chair', bottom: plat(40, 330), top: plat(470, 290), price: 20, glacier: true,
    topName: 'the Firnfeld', bottomName: 'Wolkenplatt station' });
  // back up from the lower glacier to the station (a beginner's loop: the green down, the chair up)
  addLift({ type: 'chair', name: 'Firnboden Chair', bottom: plat(-430, -30), top: plat(-70, 100), price: 20, glacier: true,
    topName: 'Wolkenplatt station', bottomName: 'the lower glacier' });
  // the glacier restaurant beside the station building, its terrace facing down the glacier toward the village
  const hp = plat(6, 178);
  const hut = { x: hp.x, z: hp.z, name: 'Gletscherrestaurant', label: 'Wolkenplatt · Gletscherrestaurant', yaw: Math.atan2(-hp.x, -hp.z) };
  world.addPad({ x: hut.x, z: hut.z, r: 16, blend: 20 });
  layout.huts.push(hut);
  const blocked = [[station.x, station.z, 36], [hut.x, hut.z, 28]];
  const F = face('wolkenplatt', jet.top, jet.bottom, 560, 420);
  const uv = (p, du = 0, dv = 0) => { const [u, v] = faceUV(F, p.x, p.z); return [u + du, v + dv]; };
  const routed = [];
  const route = (m, a, b, diff, o = {}) => {
    const [gMin, gMax] = BAND[diff];
    const pts = routePiste(m, a, b, { gMin, gMax, avoid: routed.map((r) => ({ pts: r })), blocked, ...o });
    routed.push(pts);
    return pts;
  };
  // the blue down the middle of the glacier, the green round by the station
  const blue = route(F, uv(jet.top, 42, -8), uv(jet.bottom, -34, -6), 1, { side: -1 });
  const green = route(F, uv(jet.top, 42, 14), uv(firn.bottom, -6, -26), 0, { turnCost: 10 });
  const down = route(F, uv(firn.bottom, 20, -30), uv(jet.bottom, -30, 16), 0, { turnCost: 20 });
  const F2 = face('firnfeld', firn.top, firn.bottom, 300, 220);
  const plate = route(F2, [34, 6], [F2.faceLen - 24, 14], 0, { turnCost: 20 });
  // one run per lift (decluttered Oct 27): the green Firnweg from the Gletscherjet's top doubled the blue, so it
  // is only routed (the other runs keep their lines) and never laid out
  void green;
  const pistes = [
    addPiste('Gletscherpiste', 1, blue, { peak: 'wolkenspitze', number: 41 }),
    addPiste('Sonnenplatte', 0, plate, { peak: 'wolkenspitze', number: 43 }),
    addPiste('Wolkenplatt-Abfahrt', 0, down, { peak: 'wolkenspitze', number: 44 }),
  ];
  // ski patrol by the Gletscherjet's top station
  const pp = plat(616, -110);
  world.addPad({ x: pp.x, z: pp.z, r: 6, blend: 10 });
  layout.peaks.push({ id: 'wolkenspitze', name: 'Wolkenspitze', lift: jet, hut, pistes, patrol: { x: pp.x, z: pp.z }, summit: { x: WOLKENSPITZE.summit.x, z: WOLKENSPITZE.summit.z }, station });
}

// ------------------------------------------------------------------ Wolkensee: the gondola over to the Adlerhorn
// From the halt by the lake a gondola climbs to the Adlerhorn ridge beside the Adlerhorn top station, so the
// railway and the Adlerhorn's runs link up; the black Seeabfahrt runs back down to the lake through the forest.
function buildWolkensee({ layout, addLift, addPiste, routePiste, BAND }) {
  const see = RAIL.stations.find((st) => st.id === 'see');
  const b = beside((see.s0 + see.s1) / 2 + 14, see.side * 50);
  const g = addLift({ type: 'gondola', name: 'Wolkensee Gondola', bottom: { x: b.x, z: b.z }, top: { x: 2362, z: -702 }, price: 30,
    topName: 'the Adlerhorn ridge', bottomName: 'Wolkensee' });
  // its base shares the halt's level (one flat forecourt: the halt's ground never slopes away under its building)
  const bpad = world.pads.find((pd) => pd.x === g.bottom.x && pd.z === g.bottom.z);
  if (bpad) { railAt((see.s0 + see.s1) / 2, _f); bpad.h = _f.y - 0.12; g.bottom.y = world.height(g.bottom.x, g.bottom.z); }
  // the top station sits a little into the ridge's north side (its pad 12 m below the crest there), so the run
  // drops off it without a steep embankment
  const pad = world.pads.find((pd) => pd.x === g.top.x && pd.z === g.top.z);
  if (pad) { pad.h -= 12; g.top.y = world.height(g.top.x, g.top.z); }
  const F = face('seeabfahrt', g.top, g.bottom, 460, 320);
  const adler = layout.pistes.filter((p) => p.peak === 'adlerhorn');
  // keep well off the ridge west of the Adlerhorn top station: the Adlertor (a secret passage, secrets.js) is there
  const ADLERTOR = [[2286, -628], [2246, -662], [2205, -688], [2168, -700], [2128, -694], [2088, -676], [2054, -650], [2034, -622], [2026, -596]];
  const blocked = ADLERTOR.map(([x, z]) => [x, z, 70]);
  const [gMin, gMax] = BAND[3];
  const pts = routePiste(F, [46, 16], [F.faceLen - 34, -24], { gMin, gMax, side: 1, avoid: adler, blocked, turnCost: 6, steepCost: 120, sideHill: 1.5 });
  const piste = addPiste('Seeabfahrt', 3, pts, { peak: 'adlerhorn', number: 14 });
  layout.peaks.find((pk) => pk.id === 'adlerhorn')?.pistes.push(piste);
}

// ------------------------------------------------------------------ Sonnenwiese: a first chairlift by the village
// On the sunny, gentle east side of the valley just below the village: a short chair and a wide green run
// (the first lift for a beginner, a short walk from the plaza).
function buildSonnenwiese({ layout, addLift, addPiste, routePiste, BAND }) {
  const c = addLift({ type: 'chair', name: 'Sonnenwiese Chair', bottom: { x: 392, z: 806 }, top: { x: 336, z: 362 }, price: 20,
    topName: 'Legacy Village', bottomName: 'the Sonnenwiese' });
  const F = face('sonnenwiese', c.top, c.bottom, 260, 200);
  const [gMin, gMax] = BAND[0];
  const pts = routePiste(F, [30, 18], [F.faceLen - 22, 20], { gMin, gMax, side: 1, turnCost: 30 });
  const piste = addPiste('Sonnenwiese', 0, pts, { number: 5 });
  layout.peaks.push({ id: 'sonnenwiese', name: 'Sonnenwiese', lift: null, pistes: [piste] });
}

// ------------------------------------------------------------------ the railway's ground works
function buildRailwayGround({ layout, keepOut }) {
  // viaducts where the line flies over a dip (decided on the natural ground, before the roadbed exists)
  planBridges((x, z) => world.height(x, z));
  // station pads: flat ground beside the platforms (the roadbed cut keeps the track bed below them)
  for (const st of RAIL.stations) {
    if (st.underground) continue;
    const len = st.s1 - st.s0, mid = (st.s0 + st.s1) / 2;
    railAt(mid, _f);
    const y = _f.y - 0.12;
    for (let s = st.s0 + 8; s <= st.s1 - 8; s += Math.max(16, (len - 16) / 6)) {
      const p = beside(s, st.side * 9);
      world.addPad({ x: p.x, z: p.z, r: 9, blend: 14, h: y });
    }
    if (st.id === 'tal' || st.halt) { // (the valley station's, a halt's building)
      const p = beside(mid, st.side * (st.id === 'tal' ? 13 : 10));
      world.addPad({ x: p.x, z: p.z, r: st.id === 'tal' ? 15 : 9, blend: 16, h: y });
    }
  }
  // the roadbed (cuttings, embankments, portal cuts), and no trees on it or right beside it
  world.addCut({
    bounds: railBounds,
    apply: (x, z, h) => shapeRoadbed(x, z, h),
    forest: (x, z, f) => {
      const n = railNearest(x, z, _n);
      if (!n) return f;
      // inside tunnels the forest above stays
      for (const t of RAIL.tunnels) if (n.s > t.s0 + 20 && n.s < t.s1 - (t.end ? -1e9 : 20)) return f;
      return f * smoothstep(7, 14, n.d);
    },
  });
  // the track bed, the viaducts' decks and the platforms are walked on (not the formation under them)
  world.addLineSurface((s, o) => railAt(s, o), RAIL.length, railDeckHeight);
  // the top station's building on the glacier above the rock hall: a flat terrace
  const platt = RAIL.stations.find((st) => st.id === 'platt');
  const top = beside((platt.s0 + platt.s1) / 2, 0);
  world.addPad({ x: top.x, z: top.z, r: 22, blend: 26 });
  // (the ski bus stops at Wolkensee by the Wolkensee Gondola's base, beside the halt: layout.js planBusStops)
  // the line for the trail map: centre line every 20 m (with a tunnel flag), the stations
  const inT = (s) => RAIL.tunnels.some((t) => s > t.s0 && s < t.s1);
  const pts = [];
  for (let s = 0; s <= RAIL.length; s += 20) { railAt(Math.min(s, RAIL.length), _f); pts.push([_f.x, _f.z, inT(s) ? 1 : 0]); }
  layout.railway = { name: 'Wolkenspitzbahn', pts, stations: RAIL.stations.map((st) => { const p = beside((st.s0 + st.s1) / 2, 0); return { id: st.id, name: st.name, x: p.x, z: p.z }; }) };
  // procedural races keep off the whole line and the mountain
  for (let s = 0; s < RAIL.length - 100; s += 100) {
    const a = beside(s, 0), b = beside(Math.min(RAIL.length, s + 100), 0);
    keepOut(a.x, a.z, b.x, b.z, 140);
  }
  const W = WOLKENSPITZE;
  keepOut(W.summit.x - 1500, W.summit.z + 300, W.summit.x + 800, W.summit.z - 900, 2200);
}

// ------------------------------------------------------------------ Legacy Peak (4,000 m, legacypeak.js)
// The highest mountain of the game, behind the main mountain. The Legacy Peak Gondola runs from the main mountain's
// crown, a short walk north of the Legacy Gondola's top station (ride that up from the village first), to the summit
// station on the dome at 4,000 m (the Gipfelhütte 4000 beside it). The Legacy Peak Run comes down the Gipfelgrat (the
// broad spur round the cirque), past the gondola's bottom station onto the main face and all the way down to Legacy
// Village, where the main runs finish. (noBus: no ski-bus stop on a mountain top; noMid: no mid-station over the cirque.)
export function buildLegacyPeak({ layout, addLift, addPiste, routePiste, BAND, VILLAGE_BUILDINGS, BUNNY_TOP }) {
  const S = LEGACY_PEAK.summit, legacy = layout.lifts.find((l) => l.main);
  const bottom = { x: 150, z: -2330 };
  const lift = addLift({ type: 'gondola', name: 'Legacy Peak Gondola', bottom, top: { x: S.x, z: S.z }, price: 60, noBus: true, noMid: true, peakLift: true,
    topName: 'Legacy Peak 4000', bottomName: 'the Legacy summit' });
  // one long free span over the cirque, like a tramway's: no towers planned every 240 m (lifts.js raises them over the
  // highest ground near them, 300-400 m tall on the summit's south face); lifts.js stands the few it needs (by the
  // summit dome's shoulder) where the cabins would come within 4.5 m of the ground
  lift.towers = [];
  // the summit restaurant on the dome, its terrace facing south over the resort; ski patrol on the other side
  const hut = { x: S.x + 46, z: S.z + 62, name: 'Gipfelhütte 4000', label: 'Legacy Peak 4000 · Gipfelhütte', yaw: 0, peak: LEGACY_PEAK.id };
  world.addPad({ x: hut.x, z: hut.z, r: 16, blend: 20 });
  layout.huts.push(hut);
  const patrol = { x: S.x - 52, z: S.z + 40 };
  world.addPad({ x: patrol.x, z: patrol.z, r: 6, blend: 10 });
  // the run: one routing face from the summit to the village (u down it, v across), routed in two legs: down the spur
  // to its foot by the gondola's bottom station, then down the main face (keeping off its runs) to the village
  const end = { x: 0, z: -120 };
  const F = face('legacypeak', S, end, 1150, 4000);
  const uv = (p) => { const tx = p.x - F.top.x, tz = p.z - F.top.z; return [tx * F.fx + tz * F.fz, tz * F.fx - tx * F.fz]; };
  const avoid = layout.pistes.map((p) => ({ pts: p.pts }));
  const blocked = [
    ...VILLAGE_BUILDINGS.map(([x, z]) => [x, z, 48]), BUNNY_TOP,
    [legacy.top.x, legacy.top.z, 46], [bottom.x, bottom.z, 44], [hut.x, hut.z, 30], [patrol.x, patrol.z, 14],
    ...layout.huts.filter((h) => !h.peak).map((h) => [h.x, h.z, 30]),
    ...(legacy.mid ? [[legacy.mid.x, legacy.mid.z, 30]] : []),
  ];
  const [gMin, gMax] = BAND[2];
  const foot = spinePoint(LEGACY_PEAK.spineLength - 60);
  const a = routePiste(F, uv(spinePoint(70)), uv(foot), { gMin, gMax, avoid, blocked, turnCost: 14, steepCost: 60 });
  const b = routePiste(F, uv(foot), uv(end), { gMin, gMax, avoid, blocked, turnCost: 10 });
  F.grid = null;
  const pts = [...a, ...b.slice(1)];
  const piste = addPiste('Legacy Peak Run', 2, pts, { peak: LEGACY_PEAK.id, number: 50 });
  layout.peaks.push({ id: LEGACY_PEAK.id, name: 'Legacy Peak 4000', lift, hut, pistes: [piste], patrol, summit: { x: S.x, z: S.z }, alt: LEGACY_PEAK.alt });
  return lift;
}

// ------------------------------------------------------------------ the Hochalm: from the bus to the Wolkenspitzbahn
// (Oct 29, the user: "the Hochalm bus station leads nowhere, there should be a ski piste leading down to a train stop
// that connects with the Wolkenspitzbahn and then back to the village".) The Hochalm car park (the end of the
// Hochalmstrasse, scenicloop.js: the bus's Hochalm stop) lies in the Ostal, below the Wolkenspitzbahn's whole line
// (the Gipfelblick and the Adlerhorn are in between), so the way down to the train starts with a lift:
//  1. the Hochalm Gondola from beside the car park over the Passstrasse up to the Kamm, its top station on the shelf
//     the Hirschalm's runs cross from the Hirschalm Chair's top (its groomed apron reaches them: sectors.js);
//  2. the Hirschalm's runs down to the basin, the Adlerblick Chair up to the Adlerhorn (its base beside the runs' ends);
//  3. the red Adlerwald run from the Adlerhorn ridge (the Wolkensee Gondola's top station, where the Seeabfahrt starts
//     too) down the north face to the Wolkenspitzbahn's Adlerwald halt (railroute.js), whose trains take you back
//     down to Legacy Village (the next one in at most ~6 min, via Wolkensee).
// (The road planner never sees the gondola (offRoad: roads.js buildObstacles), so the Hochalmstrasse, the Passstrasse
// and the car park keep their lines; its towers stand at fixed spots clear of them, checked in Node against the
// planned roads; the bottom station has no groomed apron.)
const HOCHALM_TOWERS = [50, 190, 420, 670, 760, 900, 1310]; // m along the line (25+ m off every road and lot; none on the Kamm's steep south face)
export function buildHochalm({ layout, addLift, addPiste, routePiste, BAND }) {
  const top = { x: 3300, z: 950 }, bottom = { x: 3462, z: 2396 };
  // the bottom station stands at the car park's west end, dug into the slope; its cut stays tight (20 m) so the road's
  // ground is untouched. The Hochalmstrasse's cutting, carved after the layout (roads.js), takes the ground there down
  // to the car park's level (~110 m): the station is set on that ground when the lifts are built (bottomOnRoad)
  const pad = world.addPad({ x: bottom.x, z: bottom.z, r: 12, blend: 20, h: 122 });
  pad.blend = 20; // (addPad widens a pad's blend on a slope: not here)
  const lift = addLift({ type: 'gondola', name: 'Hochalm Gondola', bottom, top, price: 30, noBus: true, noMid: true, noBottomPad: true, offRoad: true, bottomOnRoad: true,
    noCorridor: true, topName: 'the Kamm', bottomName: 'the Hochalm' });
  // the top station's terrace at the shelf's own level (527 m: the runs cross it there), dug into the rise west of it
  // (the ground at layout time still has the rock bands the crag mask clears later: addPad would set it 20 m higher,
  // and its bank would drop onto the runs)
  const tpad = world.pads.find((pd) => pd.x === top.x && pd.z === top.z);
  if (tpad) { tpad.h = 527; tpad.blend = 34; lift.top.y = world.height(top.x, top.z); }
  const at = (u) => [bottom.x + lift.dir[0] * u, bottom.z + lift.dir[1] * u];
  lift.towers = HOCHALM_TOWERS.map((u) => { const [x, z] = at(u); return { u, x, z }; });
  // the cleared strip under the line only where it runs clear of the roads (a road may not cross one): from the car
  // park's slope over the first ridge, and from the Passstrasse's valley up the Kamm's south face to the top
  world.addCorridor([at(40), at(250)], 9, 'lift');
  world.addCorridor([at(1060), [top.x, top.z]], 9, 'lift');
  buildAdlerwald({ layout, addPiste, routePiste, BAND });
  return lift;
}

// the red Adlerwald run: from the Wolkensee Gondola's top station on the Adlerhorn ridge down the north face, through
// the forest, onto the Adlerwald halt's square beside its platform
function buildAdlerwald({ layout, addPiste, routePiste, BAND }) {
  const halt = RAIL.stations.find((st) => st.id === 'wald');
  const g = layout.lifts.find((l) => l.name === 'Wolkensee Gondola');
  if (!halt || !g) return null;
  // the end: the square beside the platform's up-valley end, where the trough's floor lies a little above the platform
  // (it runs out level onto the square; the halt's building stands by the platform's middle)
  const end = beside(halt.s1 - 12, halt.side * 24);
  const F = face('adlerwald', g.top, end, 520, 600);
  const uv = (p) => { const tx = p.x - F.top.x, tz = p.z - F.top.z; return [tx * F.fx + tz * F.fz, tz * F.fx - tx * F.fz]; };
  // keep off the line itself (and the viaduct before the halt), the Adlertor on the ridge (secrets.js: wolkensee above)
  const blocked = [];
  for (let s = halt.s0 - 400; s <= halt.s1 + 200; s += 16) { const p = beside(s, 0); blocked.push([p.x, p.z, 16]); }
  const ADLERTOR = [[2286, -628], [2246, -662], [2205, -688], [2168, -700], [2128, -694], [2088, -676], [2054, -650], [2034, -622], [2026, -596]];
  for (const [x, z] of ADLERTOR) blocked.push([x, z, 70]);
  blocked.push([g.top.x - 60, g.top.z - 40, 45]); // (not west along the ridge: the top station's terrace drops off steeply there)
  const [gMin, gMax] = BAND[2];
  // (it leaves the top station eastward, away from the Seeabfahrt, which leaves it westward)
  const pts = routePiste(F, [44, 24], uv(end), { gMin, gMax, side: 1, avoid: layout.pistes.map((p) => ({ pts: p.pts })), blocked, turnCost: 8, steepCost: 60 });
  F.grid = null;
  const piste = addPiste('Adlerwald', 2, pts, { peak: 'adlerhorn', number: 15, to: 'wald' });
  layout.peaks.find((pk) => pk.id === 'adlerhorn')?.pistes.push(piste);
  return piste;
}
