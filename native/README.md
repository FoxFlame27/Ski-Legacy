# Ski Legacy — native C++ port

A portable C++20 rewrite of Ski Legacy (the Three.js / Electron game in `../src`), built so it can ship on
**Nintendo Switch** once the project has NintendoSDK access, and runs today on **macOS, Windows and Linux**.

**Phase 1** (engine core, the real terrain, the skier, forests) and **Phase 2** (the village and the resort: buildings,
props, signs, gondola and railway stations, all 18 gondolas and chairlifts in motion, boarding and riding them, day /
night lighting) are done. Later phases are listed at the end of this file.

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
models the game uses (`SL_PHASE1_MODELS` + `SL_PHASE2_MODELS` in `CMakeLists.txt`) and `native/data` (~32 MB) are
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
| `--autotest [--frames N] [--png out.png]` | headless check: load, ski a run for N frames, walk into a hotel (collision), board the Legacy Gondola, ride 30 s, fast-forward to the mid-station and get off; print stats, exit 0 / 1 (`out.png` + `out_village.png` + `out_ride.png`) |
| `--verify-heights` | compare the C++ terrain with reference samples taken from the JavaScript world |

### Headless test (Linux, Mesa llvmpipe)
```sh
SDL_AUDIODRIVER=dummy xvfb-run -a -s "-screen 0 1280x720x24" ./native/build/ski_legacy --autotest --frames 600 --png /tmp/frame.png
./native/build/ski_legacy --verify-heights
```
`SKI_LEGACY_DEBUG=noterrain,notrees,novillage,noskier` switches parts of the scene off for profiling (`novillage`: the
whole resort); `sidecam` looks at the rider from the side while riding, `chairtest` makes the autotest ride a chairlift.
`SKI_LEGACY_SHOT=x,y,z,tx,ty,tz` fixes the camera during the autotest's skiing phase (screenshots of a place).

Reference run (a Linux container without a GPU: Mesa llvmpipe software rendering on 4 CPU cores, 1280×720,
medium): world ready in ~7 s (the resort's canvases and 23 gondola stations are built at load); 600 frames = 10 s of
skiing down the Panorama run (54 km/h, a charged jump and landing), then the walk into a hotel (stopped at its wall)
and the gondola ride (30 s at 18 m/s, ×16 to the mid-station, off at its stair), 3-7 fps (software rasterisation; a
real GPU is orders of magnitude faster). See "Phase 2" below for the output.

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
nothing so far. Lifts: **E** (interact; controller: left button) at a station boards (at a mid-station: up, or down
while holding S); riding, **hold Space** fast-forwards ×16 (main.js), **E** gets you off while the cabin crawls
through a mid-station; you step out at the top / bottom automatically. Controllers are read by position (`SDL_HINT_GAMECONTROLLER_USE_BUTTON_LABELS=0`), so the
Switch Pro Controller's B is "bottom" exactly as in the web version. Rumble: landings, bumps, crashes.

---

## Architecture

```
native/
  CMakeLists.txt, cmake/Dependencies.cmake   build + pinned third-party code
  tools/export_world.mjs                     runs the JS world code in Node, writes native/data/ (then runs:)
  tools/export_resort.mjs, resort_hooks.mjs  builds the resort with the game's own modules in Node, writes resort.*
  data/                                      world.json, crag.bin, cuts.bin, resort.json, resort.bin, fonts/ (~32 MB)
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
                                             lifts (lifts.js motion + riding), gondola_station (gondolastation.js)
    engine/canvas2d, engine/mesh_kit         software 2D canvas (sign textures, stb_truetype), procedural geometry kit
    player/                                  player.js physics port, the skier rig (model, clips, procedural stance)
    game/                                    main loop, spawn, HUD, autotest
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
- Terrain cuts are baked data (re-export after JS changes); tunnels' covered cuts, the parkour regions and the roads'
  cuts (built at runtime in the web game) are not included. Trees ignore cuts' forest thinning (a few trees may
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
  hands (a shader on the game's hour) are missing (static faces). The Legacy Express's stations are not included (its
  line is built at runtime on the World Racing courses: Phase 3), nor platforms, track or trains.
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
| **3** | vehicles and transport: car physics (`drive.js`, damage, lights), roads with their terrain cuts and tunnels, traffic and parking, the ski bus and its routes, the railways (Wolkenspitzbahn, Legacy Express) with stations, snowmobile, helicopter |
| **4** | menus, HUD and economy: title / pause / settings (all web settings incl. rebinding UI with controller glyphs), trail map, money, shops, rentals, chalets and furnishing, save games through `Platform::writeSave` (same JSON shape as the web save) |
| **5** | gameplay: races (World Racing courses = terrain regions, gates, bots, leaderboards), jobs, police / prison / hospital, NPCs and crowds, parkour courses |
| **6** | multiplayer: keep the existing Node server (`server/`) and its protocol; write a C++ client (WebSocket over TLS, e.g. a small libwebsockets / IXWebSocket client behind the platform layer, since console sockets go through `nn::socket` / NEX) with interpolation of remote skiers, car rides, chat |
| **7** | audio (mixer, `public/audio` samples, Ogg decoding, 3D sound), weather / time of day / night lighting, snow FX, post (bloom, sun glare), and Switch performance: ASTC textures, packed vertices, GPU profiling, dynamic resolution, memory budget, Lotcheck pass |
