# Ski Legacy — native C++ port

A portable C++20 rewrite of Ski Legacy (the Three.js / Electron game in `../src`), built so it can ship on
**Nintendo Switch** once the project has NintendoSDK access, and runs today on **macOS, Windows and Linux**.

**Phase 1** (engine core, the real terrain, the skier, forests), **Phase 2** (the village and the resort: buildings,
props, signs, gondola and railway stations, all 18 gondolas and chairlifts in motion, boarding and riding them, day /
night lighting) and **Phase 3** (roads, tunnels, car parks, your car, traffic, the ski buses, the Wolkenspitzbahn and
the Legacy Express) are done. Later phases are listed at the end of this file.

---

## Building

Dependencies are fetched by CMake (`FetchContent`) and pinned to exact tags; nothing has to be installed system-wide
except a compiler, CMake ≥ 3.20, Ninja (optional) and **Python 3** (glad generates the OpenGL loader at configure
time from the specification it ships; no network access is needed for that step).

```sh
cmake -S native -B native/build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build native/build
./native/build/ski_legacy                 # windowed, starts in the village
./native/build/ski_legacy --spawn piste   # starts at the top of a run
```

Run from anywhere inside the repository: the game finds `public/` (models) and `native/data/` (exported world data)
by walking up from the executable. For a self-contained folder, configure with `-DSL_COPY_ASSETS=ON`: the ~40 MB of
models the game uses (`SL_PHASE1_MODELS` + `SL_PHASE2_MODELS` + `SL_PHASE3_MODELS` in `CMakeLists.txt`, ~75 MB) and
`native/data` (~107 MB since Phase 3) are
copied to `assets/` next to the executable (not the whole 240 MB `public/`). `SKI_LEGACY_ASSETS=/path/to/assets`
overrides both.

### macOS (Mac mini M2 / MacBook Air)
```sh
xcode-select --install           # Apple clang + Python 3
brew install cmake ninja
cmake -S native -B native/build -G Ninja -DCMAKE_BUILD_TYPE=Release && cmake --build native/build
```
macOS supports OpenGL up to 4.1 core (deprecated but working on Apple silicon); the renderer uses nothing newer.
A Metal path, if ever wanted, is a new `gfx/` backend (see Architecture).

### Windows (Visual Studio 2022)
Install "Desktop development with C++" (includes CMake and Ninja) and Python 3 (python.org or the VS installer).
From a *x64 Native Tools* prompt:
```bat
cmake -S native -B native\build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build native\build
native\build\ski_legacy.exe
```
(or `cmake -S native -B native\build -G "Visual Studio 17 2022"` and open the solution).

### Linux
```sh
sudo apt install build-essential cmake ninja-build python3 libgl1-mesa-dev libx11-dev libxext-dev \
                 libasound2-dev libpulse-dev   # audio headers optional (SDL falls back to silence)
cmake -S native -B native/build -G Ninja -DCMAKE_BUILD_TYPE=Release && cmake --build native/build
```

### Command line
| option | |
|---|---|
| `--quality low\|medium\|high\|ultra` | graphics preset (terrain LOD, shadow map, tree distances, render scale) |
| `--spawn village\|piste` | start on the village plaza (as the web game) or at the top of a run |
| `--size 1600x900`, `--fullscreen`, `--no-vsync` | window |
| `--bindings binds.json` | rebinding, same shape as the web save's `binds` (`{"kb":{"jump":"KeyJ"},"pad":{"jump":1}}`) |
| `--neutral` | Khronos PBR Neutral tone mapping instead of ACES filmic |
| `--hour H` | time of day to start at (default 10:00; the clock runs 24 h in 16 min as in `sky.js`, frozen in the autotest) |
| `--autotest [--frames N] [--png out.png]` | headless check: load, ski a run for N frames, walk into a hotel (collision), board the Legacy Gondola, ride 30 s, fast-forward to the mid-station and get off; then (Phase 3) buy a car at the Autohaus and drive it 20 s along a valley road, check that a traffic car followed its lane, ride the ski bus, the Wolkenspitzbahn and the Legacy Express; print stats, exit 0 / 1 (`out.png` + `_village` `_ride` `_drive` `_bus` `_train` `_express`) |
| `--verify-heights` | compare the C++ terrain with reference samples taken from the JavaScript world |

### Headless test (Linux, Mesa llvmpipe)
```sh
SDL_AUDIODRIVER=dummy xvfb-run -a -s "-screen 0 1280x720x24" ./native/build/ski_legacy --autotest --frames 600 --png /tmp/frame.png
./native/build/ski_legacy --verify-heights
```
`SKI_LEGACY_DEBUG=noterrain,notrees,novillage,noskier` switches parts of the scene off for profiling (`novillage`: the
whole resort); `sidecam` looks at the rider from the side while riding, `chairtest` makes the autotest ride a chairlift,
`vehtest` starts the autotest with the Phase 3 vehicles (skipping the skiing, the hotel and the gondola).
`SKI_LEGACY_SHOT=x,y,z,tx,ty,tz` fixes the camera during the autotest's skiing phase (screenshots of a place).

Reference run (a Linux container without a GPU: Mesa llvmpipe software rendering on 4 CPU cores, 1280×720,
medium): world ready in ~7 s (the resort's canvases and 23 gondola stations are built at load); 600 frames = 10 s of
skiing down the Panorama run (54 km/h, a charged jump and landing), then the walk into a hotel (stopped at its wall)
and the gondola ride (30 s at 18 m/s, ×16 to the mid-station, off at its stair), 3-7 fps (software rasterisation; a
real GPU is orders of magnitude faster). See "Phase 2" below for the output. Since Phase 3 the world is ready in ~14 s
(the transport pack, the swept track and guardrails, ten car models) and the run goes on with the drive, the traffic
check and the three rides: ~2000 frames in ~8 min at 4 fps, output under "Phase 3".

---

## Controls (same defaults as `src/core/bindings.js`)

| action | keyboard | controller (by position) |
|---|---|---|
| move / steer | W A S D, arrows | left stick |
| tuck (W at speed) / push off (W when slow) | W | stick forward |
| brake (snowplow / hockey stop) | S | stick back, LT / L2 / ZL |
| jump (hold to charge the pop) | Space | bottom button (A / Cross / Switch B) |
| sprint (on foot) | Shift | RT / R2 / ZR |
| skis on / off | G | top button (Y / Triangle / Switch X) |
| first / third person | R | RB / R1 / R |
| look | mouse (click to capture) | right stick |
| pause | Esc | Menu / Options / + |

All 24 actions of the web game are mapped (interact, horn, lights, map, ...); the ones without gameplay yet do
nothing so far.

**Vehicles (Phase 3, drive.js's keys):** **E** beside your car drives it (at the Autohaus: buys one, see below), **E** at
a standstill gets out; **W** / RT throttle, **S** / LT brake then reverse, **A D** / left stick steer (analog),
**Space** / bottom button handbrake, **R** chase / cockpit view, **C** / LS look back, **H** horn, **L** lights,
**U** unstuck (slow, every 10 s: onto the nearest clear lane), **F** flip back onto the wheels. At a bus stop or a
Legacy Express station **E** rides, **[ ]** (controller: d-pad left / right) choose the destination; at a
Wolkenspitzbahn station E boards (at a halt: up, or down while holding S), E gets off at a halt; **hold Space** runs the
bus x8, the Wolkenspitzbahn x6, the Express x10 (as the web game). Rumble: knocks, crashes, landings, guardrails. Lifts: **E** (interact; controller: left button) at a station boards (at a mid-station: up, or down
while holding S); riding, **hold Space** fast-forwards ×16 (main.js), **E** gets you off while the cabin crawls
through a mid-station; you step out at the top / bottom automatically. Controllers are read by position (`SDL_HINT_GAMECONTROLLER_USE_BUTTON_LABELS=0`), so the
Switch Pro Controller's B is "bottom" exactly as in the web version. Rumble: landings, bumps, crashes.

---

## Architecture

```
native/
  CMakeLists.txt, cmake/Dependencies.cmake   build + pinned third-party code
  tools/export_world.mjs                     runs the JS world code in Node, writes native/data/ (then runs:)
  tools/export_resort.mjs, resort_hooks.mjs  builds the resort and the transport with the game's own modules in Node,
                                             writes resort.* and transport.* (export_net.mjs: the vehicles' data)
  data/                                      world.json, crag.bin, cuts.bin, regions.bin, resort.json / .bin,
                                             transport.json / .bin, fonts/ (~107 MB)
  src/
    main.cpp                                 command line
    platform/platform.h                      THE platform interface (window/surface, input, rumble, time,
                                             files + save data, user, audio)
    platform/sdl/platform_sdl.cpp            desktop implementation (SDL2)
    platform/switch/switch_platform.h        contract for the Switch implementation (no code: NDA)
    gfx/gfx.h                                thin rendering interface (buffers, textures, programs, vertex inputs,
                                             render targets, pipeline state, draws)
    gfx/gl/gl_device.cpp                     OpenGL 4.1 core backend (glad)
    core/                                    noise.js port, input mapping (bindings.js), job system, asset paths, log
    engine/                                  asset manager (cgltf + meshoptimizer + libwebp), models / skinning /
                                             animation, renderer (shadow map, PBR, terrain, sky, tone mapping, HUD),
                                             procedural audio, quality presets, shaders
    world/                                   world.js / wolkenspitze.js / legacypeak.js height port, quadtree terrain,
                                             scenery (trees from vegetation.js, colliders), resort (Phase 2 data),
                                             lifts (lifts.js motion + riding), gondola_station (gondolastation.js),
                                             transport (roads, decks, timetables' data), rail_sweep (the track)
    engine/canvas2d, engine/mesh_kit         software 2D canvas (sign textures, stb_truetype), procedural geometry kit
    player/                                  player.js physics port, the skier rig (model, clips, procedural stance)
    game/                                    main loop, spawn, HUD, autotest; vehicles (models, instanced draw),
                                             drive (drive.js + the Autohaus), traffic, buses, trains (Wolkenspitzbahn,
                                             Legacy Express)
```

**Layering.** `game → player/world → engine → gfx + platform`. Only `platform/sdl` includes SDL; only `gfx/gl`
includes OpenGL. Engine and game code never see an OS or GPU API, which is what makes a console port a matter of
adding two backends.

**Main loop.** Events → input mapping → fixed 120 Hz simulation ticks (the web game's own `SUBSTEP`, so the physics
behave identically at any frame rate) → per-frame animation and camera with the drawn position interpolated between
the last two ticks → streaming (terrain, trees) → render. Edge-triggered inputs (a jump press) are seen by exactly
one tick.

**Renderer.** Everything is drawn camera-relative (world coordinates in double on the CPU, the camera at the GPU
origin), so 10 km from the village nothing jitters. Passes: one directional shadow map fitted round the player and
texel-snapped (PCF 3×3); an HDR main pass (terrain, metal/rough PBR meshes — static, skinned (64 joints) and
instanced — and the sky gradient of `sky.js`); ACES filmic (three.js's) or Khronos Neutral tone mapping with sRGB
output; a HUD of `stb_easy_font` text. Lighting is the web game's clear-day palette (sun 6.0 warm white, the sky
gradient zenith / mid / horizon, the exponential height fog of `fog.js` with its valley haze and aerial
perspective, exposure 0.72). Normal maps use derivative-based tangent frames (the GLBs carry no tangents).

**Assets.** GLBs load directly from `public/models`: `EXT_meshopt_compression` buffer views are decoded with
meshoptimizer (attributes / triangles / indices + octahedral / quaternion / exponential filters),
`KHR_mesh_quantization` attributes are unpacked to float, `EXT_texture_webp` images are decoded with libwebp (in
parallel), skins and animation clips are read and retargeted by bone name (the skier's `_anims.glb` clips drive its
`_rigged.glb`). Trees get two extra LODs from meshoptimizer (`meshopt_simplify`, `meshopt_simplifySloppy` for the far
one), buildings one.

**World fidelity.** `noise.js` (mulberry32 permutation, simplex, fbm, ridged, `hash2` with `Math.imul` semantics) and
the analytic height function (`world.js` `baseHeight` with the three resort massifs, crags and crag mask, valley and
village plateau; the Wolkenspitze; Legacy Peak) are ported line by line in double precision. What is data in the JS
(flattened pads, piste / lift corridors, the crag mask, the Wolkenspitze trough) or a closure that would be a large
port for Phase 1 (the terrain *cuts*: piste grading, freeride bowls, the railway roadbed) is exported by
`tools/export_world.mjs`, the cuts as sparse tiles of height deltas on the 2 m physics grid. `--verify-heights`
checks 409 points against the JS: base terrain within 2.5 mm, the physics surface (`meshHeight`) within 2.5 mm, the
full height (with cuts, between grid vertices) within 6 cm.

Re-export after changing anything under `src/world/`:
```sh
node native/tools/export_world.mjs      # ~35 s
```

---

## What Phase 1 ports

- **Terrain**: exact heights (above); streamed quadtree LOD exactly like `terrain.js` (3×3 roots of 16 km, split while
  closer than size × lodK, 64×64 quads per node, 128 m nodes = the 2 m physics grid with the same triangulation,
  band-limited coarse nodes, skirts), built on worker threads. Snow shading: wind-packed variation from the same
  tileable noise texture as `terrain.js`, groomer corduroy along the runs (corridor direction per vertex), groomed
  pads, rock on steep faces with strata, distant forest tint, sun glints.
- **Player** (`player.js`): the whole skiing model — fixed 1/120 s steps, glide friction / drag / tuck, carve-rate
  steering with 0.1 s response, edge grip vs. skid, carve drag, snowplow and hockey-stop braking with the parked
  state, edges holding a stopped skier unless pointed down the hill, W push-off, ground following with STICK and
  take-off over crests, groomed runs forgiving rock bands, charged pops with coyote time, landings judged on impact
  and sideways angle, compression impacts, crashes (tumble / roll / slam, slide, lie, get up), collisions with
  buildings, lamp posts, tree trunks and soft tree crowns. On foot: camera-relative walking, the 30° / 50° grade
  limits with slip-back, sprint, jumps. Third-person camera (auto-follow, ground avoidance, speed FOV, landing dip,
  buffeting) and a simplified first-person helmet cam.
- **Skier**: `skier_red_rigged.glb` with the Idle / walk / run clips blended by speed, a procedural ski stance on top
  (crouch, knee / hip flexion, forward lean, tuck, absorption, inclination into the turn), the crash tumble, skis.
- **Trees**: `vegetation.js` placement ported exactly (6.5 m jittered grid, `hash2`, forest density, piste and pad
  clearances, sizes 7–21 m, two pine models) — the forests stand where they stand in the web game; instanced with
  three LODs.
- **Village**: rental shop, ticket booth, the eight hotels, the plaza's 18 lamp posts and the mountain huts at the
  positions, sizes and orientations of `village.js` / `layout.js`, with their colliders (superseded by Phase 2's
  resort data; the Phase 1 placements in `world.json` are only used when `resort.json` is missing).
- **Engine**: platform layer, gfx interface + GL backend, input mapping with all web bindings and rebinding,
  rumble, job system, asset manager, PBR + skinning + instancing renderer, shadows, sky, fog, tone mapping, HUD,
  procedural wind / ski / thud audio, quality presets, save-data API.

### Known gaps (Phase 1, as updated by Phase 2)
- No huts' interiors, roads, cars, people, races, menus, economy, saves in use, network (lifts, stations and the
  village: Phase 2).
- Terrain cuts are baked data (re-export after JS changes); tunnels' covered cuts are left out (Phase 3 added the
  roads' and the Legacy Express's cuts and the courses' regions). Trees ignore cuts' forest thinning (a few trees may
  stand on the railway bed). No boulders / scree yet.
- No freestyle tricks or park features (the physics treat jumps as plain airs), no other skiers to bump into.
- The skier's pose is a few procedural layers on the clips, not `skier.js`'s full rig (poles, pole plants,
  gloves-and-poles first-person view are missing).
- Time of day and night lights came with Phase 2; still no weather, clouds, snowfall.
- Audio is synthesised (no `public/audio` samples yet).
- Meshy models' baked emissive is ignored (as the web game's materials do); the night glow is `addNightGlow`'s.


---

## What Phase 2 ports

**How the resort gets here.** `tools/export_resort.mjs` (run by `export_world.mjs`, or alone: ~15 s) does not
re-derive anything: it builds the resort with the game's own modules in Node — `new Village`, `new Lifts`, `new Decor`,
`buildResortDressing` on the layout of `layout.js`, after `initSecrets()` and `planPisteFences()` like `main.js`, then
the Wolkenspitzbahn's `buildStations` — with real THREE, GLBs loaded geometry-only (textures stripped, meshopt decoded)
and a recording canvas stub, and walks the scene they built. Node loader hooks (`resort_hooks.mjs`) patch a few lines
as the modules load, only to *tag* what is built: `fitModel` / `bakeGeometry` record which GLB and which fit every
mesh came from, `addNightGlow` and `nightScaled` record each material's night response, the gondola station builders
record their parameters, `registerStation` hands over the railway stations' colliders and paving. Out come:
- **props**: every placed GLB — the rental shop, ticket booth, eight hotels, mountain huts, the 18 plaza lamp posts,
  167 snow cannons, 132 lift towers, 18 chair terminals, signposts' larch poles, the trail map board, the Christmas
  tree, benches, barrels, bins, market stalls, fire pit, picnic tables, ski racks, sled, firewood, snowmen, fences,
  patrol huts, 56 deck chairs on the terraces (7 221 instances of 24 models) — each as its exact model-space → world
  matrix (positions, rotations, scales, the per-tower slimming, everything), plus the night glow it wears;
- **meshes**: all procedural geometry (sign boards and their posts, piste signposts, markers and their tops, safety
  nets, rope lines, race arches / boards, haul ropes, bullwheels, the chair bullwheel remapped onto its column, tower
  padding, the cobble paths, the railway station buildings and canopy...) baked per material and 256 m cell (28-byte
  vertices), repeated pieces (3 323 piste markers, chair bullwheels) as instances; materials with colours, PBR terms,
  vertex colours, emissive and its day / night factors;
- **canvases**: every canvas texture (village signs, signposts' atlas, the sponsors / nets, the cobble texture, the
  railway stations' tiled stone / timber / boards) as its recorded drawing commands, replayed at load by
  `engine/canvas2d` (fill / stroke / paths / arcs / clip / text) with **Barlow Condensed** — the game's own sign font,
  converted from `@fontsource/barlow-condensed` (WOFF → TTF, OFL licence) into `native/data/fonts/`; the exporter's
  `measureText` uses the same font's advance widths, so text the JS fitted to a board fits in C++ too;
- **lifts**: per line the stations, the supports after `LiftLine.fitClearance` raised / added towers, the cars'
  starting places (after `spreadByTime`), the exit spots (`updateRide`'s end exit, `midExit`);
- **gondola stations**: the parameters of `buildGondolaStation` / `buildGondolaMidStation` (place, yaw, mirror side,
  the rope heights over the station);
- **colliders** (5 668: buildings, lamps, signs, nets (soft), towers and padding, stations' plinths / walls /
  balustrades with their tops) and **walkable surfaces** (the gondola stations' decks, islands and stairs, the railway
  stations' paving) sampled on a 0.25 m grid.

**Gondola stations** (`world/gondola_station.cpp`) are a line-by-line C++ port of `gondolastation.js` on a C++ version
of its `Kit` (`engine/mesh_kit`: boxes, bars, sheets f(x, z), extruded slabs with ear-clipping, flat shapes, quads,
rings, half tori; merged per material, mirrored for the other side): the valley / summit halls on their stone plinths,
the boarding deck at the cabins' floor with the channels round the bullwheel, yellow edge lines, glass balustrades and
boarding gates, the entrance stair through the plinth, door, canopy, ticket window and turnstiles (valley), operator's
cabin, steel frames, glazed walls and gables, the vaulted timber roof under snow, LED strips and downlights, the guide
rail and tyre conveyor round the loop; the mid-stations with their outside stair, waiting platform, bench, queue rail,
next-cabin screens, pendant lights and ski rack. Their sign canvas (the house-blue gondola pictogram, the lift's name,
the station, TICKETS, ENTRANCE, the NEXT CABIN screen) is drawn with the C++ canvas.

**Lifts** (`world/lifts.cpp`, a port of `lifts.js`): the haul rope (`cableAt`: sagging spans between the supports,
levelled through the mid-station), line speeds (gondola 18 m/s, chairs 8 m/s), car spacing, the mid-station crawl
(`speedAt`: 0.1 × speed within ±9 m, ramped over 36 m, sub-stepped `advance`), the gentle swing (steady in the
station), cabins / chairs (`gondola_cabin.glb`, `chairlift_chair.glb`, 522 + 430 cars) drawn instanced with three
levels of detail (full within 32 m, lighter to 110 m, light beyond), lines further than 2.5 km + half their length not
animated. **Riding** as `main.js` / `lifts.js`: the prompt within 20 m (gondola) / 13 m (chair) of a station, `board()`
brings the next car to the boarding point (shifting the whole loop by the same time, as lifts.js does), the rider sits
in `seatFor`'s seat (gondola: back bench facing forward, skis in the outside rack, third-person view; chair: seat right
of centre, skis on the feet) in a seated pose, the camera follows tightly (≥ 8 m), Space ×16 (×2 through a
mid-station), "Get off at <mid-station>" while crawling through it, and on arrival you stand up at lifts.js's exit
spot facing downhill. Every lift also takes you down from its top station.

**Village, buildings, colliders.** Everything listed above stands where the web game puts it; the player collides
with the exported colliders (a 32 m grid; soft ones bump like nets) and walks up the gondola stations' stairs onto
their decks (`World::groundHeight` with the sampled surfaces, the same `yHint + 0.6` rule as `world.js`).

**Day / night.** `--hour` / a running clock (24 h in 16 min, `sky.js`): the sun's path and the time-of-day palette of
`sky.js` (zenith / mid / horizon / glow / fog / sun colour and intensity / ambient, keyed by the sun's height), a
moon key light after dusk, and the village's `nightUniform` (`max(night, (1 - day) × 0.6)`) driving the night glow
of lit windows and lanterns (`addNightGlow`'s warm-texel test, per prop strength: hotels 3.2, lamps 6, shop 2.5),
signs lit at night (× 0.25), the stations' LED strips / downlights (0.3 → 1), sign boards (0.12 → 0.7), railway
windows, lamps and posters (their `nightScaled` factors).

**Performance.** Props are drawn with matrix instancing per model and 512 m cell (two LODs from meshoptimizer,
per-instance distance selection, re-sorted every 8 m), procedural meshes merged per material and cell with distance /
frustum / shadow-box culling, the cars instanced in three LODs; glass is the only transparent pass (sorted).

Autotest output (llvmpipe, 1280×720, medium; abridged):
```
resort: 7221 props in 28 sets, 440 mesh chunks, 23 gondola stations, 33 canvases, 5668 colliders, 27 surfaces
[autotest] skied 78 m along the run (42 m from the start), dropped 18 m, top speed 53.7 km/h, 1 landings, 0 crashes
[autotest] collision: walked 6.6 m toward the hotel for 6 s, stopped at (57.0, 27.8), outside the building -> blocked by its wall
[autotest] lift: boarded Legacy Gondola (gondola, 2050 m, 18 m/s, 64 cabins)
[autotest] ride t= 29.8s  progress  26.1%  seat=(     6.0,   356.8,   -604.5)  x1
[autotest] lift: off after 32.1 s riding (0.0% -> 52.1%) at (-3.4, 526.6, -1139.8), 0.0 m from the mid-station exit, mode ski
[autotest] 984 frames (48.4 s simulated) in 308.6 s wall: avg 3.2 fps
[autotest] ski ok, building collision ok, gondola ride ok
[autotest] PASS
```

### Known gaps (Phase 2)
- **Railway station buildings** (`stationbuildings.js`) are exported as baked geometry with their canvas textures
  replayed, not ported as a C++ builder (the gondola stations are); their normal maps and the station clocks' moving
  hands (a shader on the game's hour) are missing (static faces). The platforms, track, trains and the Legacy Express came with
  Phase 3.
- Prices, tickets and the day pass are not charged (the economy is Phase 4); the mid-station's up / down choice is
  "E = up, S + E = down" instead of the dialog / trail-map card. No multiplayer dwell / shared timeline.
- The seated pose is a few bends on the rig (no IK onto the seat edge / footrest as `skier.js`); the gondola cabin's
  interior is not meant to be seen up close (as in the web game, third person while riding).
- Canvas replay covers what the resort's canvases use (no gradients, patterns or drawImage); sponsor logos are images
  the browser loads (left blank); Georgia / Arial sign text is drawn in Barlow Condensed.
- Lamp light pools on the snow (`pistelights.js` street lamps), the Christmas tree's point light, snowmaking spray,
  flags, crowds, snowcats, the terrain park, piste floodlights and the continuous piste fences (streamed in the web game)
  are not in yet; RoundedBox bevels are plain boxes; no cabin interiors.
- The resort data is ~24 MB (`resort.bin` 16 MB, `resort.json` 7 MB, mostly the canvases' command lists): fine for
  desktop, to be compressed / baked to textures for the Switch package (Phase 7).

---

## What Phase 3 ports

**How the transport gets here.** Both exporters now plan the world in `main.js`'s order before anything is built: the
piste fences, `planBusRoads` (roads.js: the A* roads, car parks, lay-bys, the scenic roads and their roundabouts, the
chalet village, the road tunnels, the depot, the Autohaus / Werkstatt sites), `registerFreeWorldCourses` (the World
Racing courses' regions own the terrain inside their bounds), `planExpressScenery` and `buildExpressGround` (the Legacy
Express's line is fitted on that final ground). So:
- `export_world.mjs` writes the roads' and the Express's cuts, pads and corridors with the rest (cuts.bin), and the
  courses' **regions** as 8 m tiles of height deltas over base + pads with their forest density (`regions.bin`); the
  2 m cut tiles are taken against the C++'s own interpolation of the regions, so on roads, roadbeds and pistes the C++
  height matches the JS at every grid point. `--verify-heights` reports the region points separately.
- `export_resort.mjs` (one process for both packs now, `makePack()`) builds the resort as before (now on the planned
  roads, as decor.js expects), then the transport with the game's own modules — `SkiBus` (stop signs, `BusLine`'s road
  strips, guardrails, snow poles and reflector posts, road signs, scenic props, the depot), `ParkingLots`,
  `RoadTunnels` (every tube, portal and rock cut built at once), `buildRailway` (tunnel linings and lamps, portals,
  viaducts), the rail stations' platforms, `buildExpressTrack` (every viaduct, portal and station; the 65 km of bed,
  rails and sleepers are swept in C++ instead: captured they were ~150 MB), the frozen lakes, the Autohaus hall
  (`CarRental.buildOutside`) and the medical centre — and captures it like the resort into `transport.json / .bin`
  (instance lists over 64 go to the bin as float32; instanced meshes sharing a geometry are merged; vehicles and
  additive light pools and the shader-bent guardrail sections are left out).
- `export_net.mjs` adds `net`: every road's centre line with speedlimits.js's profile (signed limit, braked envelopes
  of the limit and the bends both ways), stops, bus legs, car parks and bays, junctions, lay-bys, the 12 263 guardrail
  lines, the road tunnels' tubes, the parked cars, per car model the fit `cars.js fitCar` computes (nose +z, wheels on
  y 0, real length) with the nodes it leaves out and its glass materials, drive.js's `CAR_SPECS` / `MASS` / `DRIVE`,
  the Autohaus prices; the Micruss's fit, glass, paint and seats; the Wolkenspitzbahn (line, stations with their door /
  exit spots, tunnels, viaducts, passing loop, speed profile, timetable constants, the railcar: the Meshy body's
  stretch as a matrix, the procedural cabin / underframe / bogie / far LOD as local meshes, the rider's seat); the
  Legacy Express (ring, stations, tunnels, viaducts, speed profile).

**Roads** (`world/transport.cpp`): roads.js `roadAt`, `laneDistance`, the road's smooth surface for
`World::groundHeight` (`world.roadSurface`: the exact height + 3.5 cm across the ploughed width, eased into the drawn
terrain over the shoulder; inside a road tunnel below its crown the tube's floor, so cars and people go through the
mountain while the terrain stays whole over it), drive.js's `onTarmac`, the speed limit where you are, the railways'
walkable track decks (railroute.js `railDeckHeight`, expressroute.js `expressDeckHeight`) as `World` decks.

**Your car** (`game/drive.cpp`, drive.js): the bicycle model step by step — the automatic gearbox (P / D / R, six ratios
and the final drive, shift points that hold a gear downhill, the electric cars' single gear and power limit), the
torque curve, engine braking, the pedals pressed progressively, load transfer, the friction circle per axle with
traction control / ABS, the handbrake locking the rear, the slip-angle tyre curve, ESC, hill hold, the walking-pace
blend, air drag setting each car's top speed, surfaces (tarmac, shoulder, groomed piste, snow), crests (small jumps,
landings), the rest anchor (no creeping out when wedged). Collisions: tree trunks / crowns, the resort's and the
transport's colliders, terrain walls (a knock / crash into the mountain), the guardrails (a glancing slide with
restitution and friction; over 100 km/h and 15° into it they break and you go through, 90 s), breakable poles, signs
and street lamps (knocked away, the lamp over 100 km/h), other cars and the buses (`obb` + impulses: the traffic car
is knocked aside, a parked car slides to a stop, a bus is a 12 t wall). Damage: knock / crash / wrecked (at 100 % or
150 km/h, rolling over on a slope), unstuck (U), flip back (F), the springs (pitch and roll from the four wheels' snow,
squat, dive and lean), the chase camera (lags into turns, pulls back with speed, eases behind, look back) and the
cockpit camera with mouse look. The **Autohaus** (carrental.js): the ten cars for sale stand in its car park's bays; E
buys one (free until the economy, Phase 4), then it is yours to drive; every other parked car says where to buy one.

**Traffic** (`game/traffic.cpp`, traffic.js): 12 cars on the valley roads + 6 on the scenic network (models drawn by
cars.js's spawn weights, seeded), each on its right-hand lane at speedlimits.js's target times its driver's factor,
braking for the bends ahead, following at a time gap (`followV` / `lookFor`), stopping for you, your car and the buses,
turning at junctions onto the car parks' access roads, parking a while and driving out again, turning round before a
bus stop's dead end (the lane offset carries it across), lane offsets steered (`toRoad`), knocked aside when hit;
about six kept round you, recycled out of sight. **Parked cars**: parking.js's 102, solid.

**Ski buses** (`game/buses.cpp`, bus.js): the network as a tree rooted at the village (`parent`, `toRoot`, `legs`, both
roads and bus legs), each trip with `leg()`'s speed profile (cruise, the bends, from and to a standstill in the
bays), the Micruss on its axles in the right-hand lane (`poseBus`), the fleet of 8 (bus 0 waits at the village, the
others go round village -> a stop -> village with a dwell), braking for the traffic, your car, you and each other.
Riding: E at a stop (choose the destination), the bus waiting there (or bus 0) takes you, a window seat, the legs
driven in turn, Space x8, out by the front door.

**Wolkenspitzbahn** (`game/trains.cpp`, railway.js / railroute.js): the timetable exactly (`tripS` with the halts'
dwells, `trainState`, `boardingU`, the cycle and the termini dwells that put both meetings on the passing loop), two
trains of four cars placed between their bogies (the down train on the loop's second track), boarding at a station's
door (the timetable jumps so a train stands there), the next stop / halts / get off / arrive, Space x6.

**Legacy Express** (express.js): the segment timetable both ways (dwell, run, ... from the speed profile's running
times), 16 trains (8 each way, double track), four cars each with the flipped cabs, boarding at any station for a
chosen destination (the quicker way round; that direction's timetable shifted so a train stands at the platform),
the ride, Space x10.

**The track** (`world/rail_sweep.cpp`): the Wolkenspitzbahn's bed (ballast, the tunnels' slab, the loop's second
track) and the Express's (the double-track ballast prism, slabs on the viaducts and in the tubes, the tubes' lining),
both lines' rails, swept along the lines in 250 m chunks with railtrack.js / expresstrack.js's cross-sections; 212 481
sleepers instanced within 320 m of the camera. The roads' **guardrails** are swept here too, from busRoads.rails (bus.js bends
its rail sections along their lines in the vertex shader with per-instance Hermite attributes, which a capture cannot
keep): a galvanised two-band beam 0.45-0.8 m over the ground with a post every 2 m, per 256 m cell.

**Performance**: every car / bus / railcar of a model in one instanced draw per LOD per frame (`VehicleDraw`: matrix
instancing, the car models' meshoptimizer LOD past 70 m, the railcars' exported far mesh past 220 / 420 m, nothing past
300 m (traffic) / 4.5 km (trains)); the traffic not simulated beyond 600 m and updated at a quarter of the rate past
300 m; the track chunks drawn by distance (rails 800 m, linings 900 m, bed 2.6 km); the car textures capped at
512 px. (`MatrixInstanceBatch` now builds its vertex inputs in node order: multi-node GLBs whose nodes reference their
meshes out of order drew parts with another node's transform.)

Autotest output (llvmpipe, 1280×720, medium; the full run, abridged):
```
world: 313 pads, 24795 corridor segments, 6049 cut tiles, 4015 region tiles, crag 648x916
resort + transport: 31819 props (7245 resort), 1231 mesh chunks, 23 gondola stations, 14790 colliders, 54 surfaces
transport: 20 roads, 10 bus legs, 13 stops, 17 car parks, 12263 guardrail lines, 6 road tunnels, 102 parked cars, 10 car models; rail ok (4 stations), express ok (9 stations)
rail sweep: 292 track chunks, 212481 sleepers
guardrails: 11175 lines swept in 106 cells
drive: 112 parked cars (10 for sale at the Autohaus)
traffic: 18 cars on 2 roads (3 access roads, 3 junctions, 7 scenic roads)
buses: 8 in the fleet, 13 stops
railway: Wolkenspitzbahn, 2 trains of 4 cars, cycle 691 s (trip 263 s)
express: Legacy Express, 16 trains, 9 stations, a round 1419 s
world ready in 13.60 s ...
[autotest] drive: BMW X3 bought at the Autohaus, on road 1 (3855 m long) at (329.7, -219.6, 1539.5)
[autotest] drive t=  5.8s  pos=(   291.7,  -225.8,   1574.5)  ground  -225.8  speed= 75.2 km/h  BMW X3 - D2 - limit 50 km/h
[autotest] drive t=  9.8s  pos=(   306.0,  -237.2,   1654.1)  ground  -237.2  speed= 78.9 km/h  BMW X3 - D2 - limit 80 km/h
[autotest] drive: 359 m in 20.0 s, top 80.6 km/h, deepest below the ground 0.00 m, damage 0% -> ok
[autotest] traffic: 18 cars, 10 driving; the furthest moved 291 m along its road, 1.6 m off the centre line (its lane: 1.6 m) -> ok
[autotest] bus t= 19.7s  at (   118.7,     2.9,    224.7)   63.7 km/h  [Ski bus to Sonnenkopf Gondola - 1.8 km - 64 km/h]
[autotest] bus: rode 24.0 s, moved 290 m -> ok
[autotest] train t= 22.2s  at (  1367.4,   222.0,  -1101.7)    0.0 km/h  [Wolkensee - get off here]
[autotest] train: rode 32.0 s, moved 2743 m -> ok
[autotest] express: rode 24.0 s, moved 4439 m -> ok
[autotest] 1995 frames (149.5 s simulated) in 478.6 s wall: avg 4.2 fps
[autotest] ski ok, building collision ok, gondola ride ok
[autotest] drive ok, traffic ok, bus ok, Wolkenspitzbahn ok, Legacy Express ok
[autotest] PASS
```

### Known gaps (Phase 3)
- **Courses' regions** come as an 8 m grid (mean 0.48 m, max ~4 m off the JS inside the regions, exact on roads and
  roadbeds); the courses themselves (gates, ramps, props) are Phase 5. Outside the regions `--verify-heights` now
  reads up to 0.24 m on `height` (the roads' benches and berms between 2 m grid points; `meshHeight`, the physics
  surface, is still exact to 2.5 mm). The data grew to ~107 MB (regions 13 MB, cuts 13 MB, transport 58 MB): to be
  compressed / baked for the Switch package (Phase 7).
- **Cars**: no moving wheels or steering wheel, no dents (damage is a number), no headlights / tail lights / light
  pools (the L key only toggles the flag), no engine / tyre / horn sounds (audio is Phase 7), no tyre tracks; the
  cockpit view shows the car's own interior only as far as its GLB has one (no `_full` models, no seated driver's
  hands); paint colours of the parked / traffic cars are the models' own; the Autohaus showroom (inside), the
  configurator, the garage / selling, the Werkstatt, the tow truck, police, taxi and bad drivers are not ported.
- Knocked poles, signs, lamps and broken guardrail sections lose their colliders for 90 s but stay drawn.
- **Traffic** turns into a car park bay and out of it without the arcs (it appears in / leaves the bay), the scenic
  roads' cars drive them as ordinary roads (no `scenicWalk` round the roundabouts), no tow zones, trains / helicopter
  blockers, people in the cars.
- **Buses**: no overtaking / ramming, the fleet's rounds are a simple rotation (not bus.js's slotted timetable), no
  passengers or driver, no turn-round fade at intermediate stops (the seat view inside the Micruss and the R chase
  view are there).
- **Trains**: the Express wears the Wolkenspitzbahn's red (no Legacy blue livery), no seated passengers; the default
  view is the chase camera (in a tunnel: close behind the train, the sky and sun faded out, no terrain drawn) — R gives
  the seat view in the procedural cabin, whose lounge seat looks at the dark cab partition (the JS's glazed cab and
  the Express's Meshy seats are not reproduced); no trains braking for you on the track, no clocks / departure boards; the Express's stations and the Wolkenspitzbahn's platforms are captured
  meshes (their furniture's colliders as exported).
- The road tunnels' lids are left out (the C++ terrain keeps the mountain whole over the tubes), no terrain clip
  volumes at the railway portals (the tubes' lining is drawn inside the mountain); snowmobiles and the helicopter are
  not ported yet.

---

## Nintendo Switch plan

What has to come from Nintendo (none of it can be in this repository):
1. **Nintendo Developer Portal account** and acceptance as a licensed Switch developer (company / sole trader,
   game pitch). This gives the **NintendoSDK** (toolchain: clang-based, CMake toolchain file), documentation,
   **dev kits** (SDEV / EDEV hardware) and the Developer Portal forums.
2. **Graphics**: NVN (Nintendo's native low-level API, best performance) or the **Vulkan** driver the SDK provides.
   Add `gfx/nvn/` (or `gfx/vulkan/`) implementing `gfx::Device`; compile the GLSL in `engine/shaders.h` offline
   with the SDK's shader compiler (the programs are already split into the same handful of variants).
3. **SDL2 Switch port** (official, available to licensed developers through the portal) — or a native
   `platform/switch/platform_switch.cpp` written against `nn::*`. The contract each part must meet is documented in
   `src/platform/switch/switch_platform.h`: display / operation mode (docked 1080p, handheld 720p), **Joy-Con /
   Pro Controller** via `nn::hid` mapped by position, controller applet, **HD Rumble**, **file system** (`rom:`
   for the packaged `assets/`, **save data** `save:` per user with commit), **user account** (preselected user's
   nickname), **audio** (`nn::audio`), time, suspend / resume.
4. **Lotcheck**: Nintendo's certification. Plan for the guidelines from the start: correct controller UI terms and
   button glyphs per region, the controller applet, save data commit and size limits, behaviour when suspended /
   resumed / the console sleeps, no crashes or hangs on long play, loading-screen times, age ratings (IARC / per
   region), and online rules if Phase 6 ships online (Nintendo Account, NSO, network service agreements).
5. **Performance budget**: Tegra X1 — target 30 fps (docked 1080p dynamic-res, handheld 720p). The engine is built
   for it: quality presets (`--quality low` ≈ handheld), render scale for dynamic resolution, worker threads for
   streaming (3 cores), instancing, LODs, a single shadow map. Phase 7 adds ASTC textures, packed vertex formats and
   GPU profiling on the dev kit.

---

## Phase plan

| phase | content |
|---|---|
| **1 (done)** | engine core, platform + gfx layers, exact terrain, skier physics + camera, trees, village buildings, HUD, autotest |
| **2 (done)** | the village and resort (every building, prop, sign, signpost, net, marker, snow cannon of `village.js` / `decor.js` / `resortdressing.js`), gondola stations (C++ port) and railway station buildings, gondolas and chairlifts in motion with boarding and riding, colliders and walkable decks, day / night |
| **2b** | still to do from the old Phase 2 list: huts' interiors, the terrain park and kickers (`park.js`, tricks scoring from `tricks.js`), boulders, the full `skier.js` rig (poles, pole plants, first-person gloves), streamed piste fences, flags, crowds, snowcats |
| **3 (done)** | vehicles and transport: car physics (`drive.js`, damage), roads with their terrain cuts and tunnels, traffic and parking, the Autohaus, the ski bus and its routes, the railways (Wolkenspitzbahn, Legacy Express) with stations and swept track; still open: snowmobile, helicopter, car lights / sounds / wheels |
| **4** | menus, HUD and economy: title / pause / settings (all web settings incl. rebinding UI with controller glyphs), trail map, money, shops, rentals, chalets and furnishing, save games through `Platform::writeSave` (same JSON shape as the web save) |
| **5** | gameplay: races (World Racing courses = terrain regions, gates, bots, leaderboards), jobs, police / prison / hospital, NPCs and crowds, parkour courses |
| **6** | multiplayer: keep the existing Node server (`server/`) and its protocol; write a C++ client (WebSocket over TLS, e.g. a small libwebsockets / IXWebSocket client behind the platform layer, since console sockets go through `nn::socket` / NEX) with interpolation of remote skiers, car rides, chat |
| **7** | audio (mixer, `public/audio` samples, Ogg decoding, 3D sound), weather / time of day / night lighting, snow FX, post (bloom, sun glare), and Switch performance: ASTC textures, packed vertices, GPU profiling, dynamic resolution, memory budget, Lotcheck pass |
