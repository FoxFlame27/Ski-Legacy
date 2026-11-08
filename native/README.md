# Ski Legacy — native C++ port

A portable C++20 rewrite of Ski Legacy (the Three.js / Electron game in `../src`), built so it can ship on
**Nintendo Switch** once the project has NintendoSDK access, and runs today on **macOS, Windows and Linux**.

**Phase 1** (engine core, the real terrain, the skier, forests), **Phase 2** (the village and the resort: buildings,
props, signs, gondola and railway stations, all 18 gondolas and chairlifts in motion, boarding and riding them, day /
night lighting), **Phase 3** (roads, tunnels, car parks, your car, traffic, the ski buses, the Wolkenspitzbahn and
the Legacy Express), **Phase 4** (menus, HUD, trail map, the economy and saving), **Phase 5** (races, jobs and the
taxi, the police / prison / impound, the rescue and the hospital, chalets and build mode, people, snowmobiles, weather)
and **Phase 6** (multiplayer: a C++ client for the game's Node server over wss://) are done. Phase 7 is listed at the
end of this file.

---

## Building

Dependencies are fetched by CMake (`FetchContent`) and pinned to exact tags; nothing has to be installed system-wide
except a compiler, CMake ≥ 3.20, Ninja (optional), **Python 3** (glad generates the OpenGL loader at configure
time from the specification it ships; no network access is needed for that step) and **Node.js ≥ 22.15** with the
repository's `node_modules` (`npm install` in the repo root): the exported world data is not committed, the build
makes it.

```sh
npm install                                # once, in the repo root (three.js, the fonts: the exporters need them)
cmake -S native -B native/build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build native/build                 # also exports native/data with Node when needed (~2-4 min the first time)
./native/build/ski_legacy                  # windowed, the main menu over the village
./native/build/ski_legacy --spawn piste    # starts at the top of a run
```

**The data step.** `native/data/*.zst` (and `data/fonts/`) are generated and git-ignored. A CMake custom command runs
`node native/tools/export_world.mjs` (which runs `export_resort.mjs` / `export_net.mjs` / `export_play.mjs` / `export_fonts.mjs`) whenever
an output is missing or older than the exporter scripts (`native/tools/*.mjs`) or any of the game's JavaScript sources
(`src/**/*.js`). It first checks that `node_modules` has three.js and the fonts and stops with "run npm install in the
repo root" if not; without Node at all the configure step stops when the data is missing (and only warns when it is
there). `-DSL_EXPORT_DATA=OFF` skips the step (data provided by other means). Node older than 22.15 has no zstd: it
writes the same files uncompressed (the game reads either).

**Data size.** Every exported file is zstd-compressed (level 19, a window up to 128 MB; the C++ inflates it in one shot
through `AssetPaths::readData`); the terrain-cut and course-region tiles are stored as planar-predicted, zig-zagged
int16 residuals in two byte planes (lossless after quantising to 1 mm / 5 mm: the physics surface still matches the
JS to 2.4 mm). 111.8 MB of `.bin` / `.json` became 28.0 MB of `.zst` (25 %): cuts 13.2 → 5.9 MB, regions 13.2 → 6.2,
transport 57.9 → 9.9, resort 24.1 → 5.3, world.json 2.2 → 0.5, crag 1.2 → 0.07. Phase 5 adds `play.json / .bin`
(the courses' meshes and the gameplay data): 64 MB → 11.2 MB packed.

Run from anywhere inside the repository: the game finds `public/` (models) and `native/data/` (exported world data)
by walking up from the executable. For a self-contained folder, configure with `-DSL_COPY_ASSETS=ON`: the models the
game loads and `native/data` (~40 MB) are copied to `assets/` next to the executable (not the whole `public/`), and the
game uses that folder first. The model list is derived from what the game actually loads: `tools/list_models.mjs`
collects every model the exported data names (the resort's props, the transport's cars and buses, the courses' pieces,
the job boards, the snowmobiles, the furniture catalogue) and every model the C++ names (literals, and names it builds
from a literal prefix / suffix: `"furniture/" + id`, `"skier_" + colour + "_rigged"`) into `build/models.txt`
(148 models, 158 MB today; regenerated when the data or a source file changes), and `cmake/CopyAssets.cmake` copies
them after the build (Node is needed for the list; without it a fallback list of the Phase 1-3 models is used). The
full autotest runs from such a folder without a single "model not found". `SKI_LEGACY_ASSETS=/path/to/assets`
overrides both.

### macOS (Mac mini M2 / MacBook Air)
```sh
xcode-select --install           # Apple clang + Python 3
brew install cmake ninja node && npm install
cmake -S native -B native/build -G Ninja -DCMAKE_BUILD_TYPE=Release && cmake --build native/build
```
macOS supports OpenGL up to 4.1 core (deprecated but working on Apple silicon); the renderer uses nothing newer.
A Metal path, if ever wanted, is a new `gfx/` backend (see Architecture).

### Windows (Visual Studio 2022)
Install "Desktop development with C++" (includes CMake and Ninja), Python 3 (python.org or the VS installer) and
Node.js 22 LTS (nodejs.org), then `npm install` in the repo root.
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
# Node.js >= 22.15 (nodejs.org / NodeSource), then in the repo root:
npm install
cmake -S native -B native/build -G Ninja -DCMAKE_BUILD_TYPE=Release && cmake --build native/build
```

### Command line
| option | |
|---|---|
| `--quality low\|medium\|high\|ultra` | graphics preset (terrain LOD, shadow map, tree distances, render scale); else the SETTINGS preset of the save |
| `--no-menu` | straight into the game (no main menu) |
| `--save name.json` | another save slot (default `ski-legacy-save-v1.json` in the platform's save directory) |
| `--spawn village\|piste` | start on the village plaza (as the web game) or at the top of a run |
| `--size 1600x900`, `--fullscreen`, `--no-vsync` | window |
| `--bindings binds.json` | rebinding, same shape as the web save's `binds` (`{"kb":{"jump":"KeyJ"},"pad":{"jump":1}}`) |
| `--neutral` | Khronos PBR Neutral tone mapping instead of ACES filmic |
| `--hour H` | time of day to start at (default 10:00; the clock runs 24 h in 16 min as in `sky.js`, frozen in the autotest) |
| `--autotest [--frames N] [--png out.png]` | headless check: load, ski a run for N frames, walk into a hotel (collision), board the Legacy Gondola, ride 30 s, fast-forward to the mid-station and get off; then (Phase 3) buy a car at the Autohaus and drive it 20 s along a valley road, check that a traffic car followed its lane, ride the ski bus, the Wolkenspitzbahn and the Legacy Express; (Phase 4) first the menus (main menu -> PLAY -> SINGLEPLAYER -> CHOOSE YOUR SKIER -> START; pause -> SETTINGS -> HUD size changed -> back), the ski shop (rent skis: money down), save + reload compared, the lift ticket and the car charged, and at the end the trail map; (Phase 5) a World Racing race started and finished (records saved and read back, back in the village), a job taken at the village board and delivered (money up), a police chase on foot into an arrest (ARRESTED, the jail timer, released at the station), a chalet bought and an armchair placed in build mode (saved), a weather change to heavy snow, a snowmobile ride; print stats, exit 0 / 1 (`out.png` + `_menu` `_showcase` `_settings` `_shop` `_village` `_ride` `_drive` `_bus` `_train` `_express` `_map` `_race` `_job` `_police` `_jail` `_build` `_weather` `_sled`). Uses its own fresh save (`autotest-save.json`) |
| `--verify-heights` | compare the C++ terrain with reference samples taken from the JavaScript world |
| `--server URL` | (Phase 6) the multiplayer server (else `SKI_LEGACY_SERVER`, else the game's `wss://138-199-163-183.sslip.io/ws`) |
| `--mptest URL [--mp-peers N] [--mp-seconds S]` | (Phase 6) the multiplayer check against a running server: the menus (PLAY -> MULTIPLAYER -> REGISTER a fresh name -> JOIN A WORLD), presence for S s (default 8), N other players seen (their avatars and name cards; a screenshot with `--png`), a ride in another player's car when one is parked, rental skis bought at the ski shop and a day pass at the ticket seller (checked against the server's own copy of the profile), chat, a dropped connection resumed, LEAVE MULTIPLAYER (the single-player save back); exit 0 / 1. Own save `mptest-save.json` |

### Headless test (Linux, Mesa llvmpipe)
```sh
SDL_AUDIODRIVER=dummy xvfb-run -a -s "-screen 0 1280x720x24" ./native/build/ski_legacy --autotest --frames 600 --png /tmp/frame.png
./native/build/ski_legacy --verify-heights
```
`SKI_LEGACY_DEBUG=noterrain,notrees,novillage,noskier` switches parts of the scene off for profiling (`novillage`: the
whole resort); `sidecam` looks at the rider from the side while riding, `chairtest` makes the autotest ride a chairlift,
`vehtest` starts the autotest with the Phase 3 vehicles (skipping the skiing, the hotel and the gondola), `maptest`
straight with the trail map, `p5test` straight with the Phase 5 checks.
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
nothing so far. **Menus** (Phase 4): D-pad / left stick / arrows / W A S D move, the confirm button (Xbox A, PS ✕,
Switch A — the right button) / Enter / Space chooses, the back button (Xbox B, PS ○, Switch B) / Esc / Backspace goes
back, LB / RB or Q / E switch tabs, the mouse hovers, clicks and scrolls; **M** / View / Minus opens the trail map;
everything can be rebound under SETTINGS → CONTROLS (stored in the save).

**Phase 5:** **E** at a course's start house / a bus race board / the RACING stand opens the race card, at a job board the
offers, at a chalet's door the sale (or: go in), at the police station's / the medical centre's door a visit; **Backspace**
(d-pad down) is unused in races (no restart: you respawn at the last checkpoint after a wipeout); **T** ends a taxi shift;
in your chalet **F** (top button) opens build mode: **[ ]** (d-pad left / right) browse the catalogue, **Space** / click
places, **R** / the wheel turns, **Q** picks a piece up, **X** sells it, **E** toggles a lamp, **Backspace** empties your
hand, the left stick click switches the controller's virtual mouse. Snowmobile: **E** beside one, **W S A D**, **Shift**
boost, **Space** handbrake, **E** (stopped) off.

**Multiplayer (Phase 6):** **E** beside another player's car asks them for a ride (they answer **Y** / **N**, controller
d-pad up / down; you sit in the seat the server gives you, **E** gets out); at another player's chalet door **E** asks to
visit; **Enter** opens the chat line (Enter sends, Esc closes); the pause menu lists the world's players and has LEAVE
MULTIPLAYER.

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
  tools/export_play.mjs                      (Phase 5) the courses (meshes + lines, gates, checkpoints, prizes), the bus
                                             races, the RACING stand, the job sites, taxi places, the police / hospital /
                                             impound sites, the chalets and their plan, the furniture catalogue -> play.*
  tools/export_fonts.mjs, datafile.mjs       the UI fonts (WOFF / WOFF2 -> TTF); zstd writing + the grid filter
  tools/list_models.mjs, cmake/CopyAssets.cmake   (Phase 6) the models the game loads -> build/models.txt; the
                                             -DSL_COPY_ASSETS=ON copy
  tools/mp_peer.mjs                          (Phase 6) a JS test player for --mptest (walks, chats, parks a car, says yes)
  cmake/CheckNodeModules.cmake               the data step's "run npm install" check
  data/  (generated, git-ignored)            world.json, crag.bin, cuts.bin, regions.bin, resort.json / .bin,
                                             transport.json / .bin, each as .zst (~28 MB); fonts/
  src/
    main.cpp                                 command line
    platform/platform.h                      THE platform interface (window/surface, input, rumble, time,
                                             files + save data, user, audio)
    platform/sdl/platform_sdl.cpp            desktop implementation (SDL2)
    platform/switch/switch_platform.h        contract for the Switch implementation (no code: NDA)
    gfx/gfx.h                                thin rendering interface (buffers, textures, programs, vertex inputs,
                                             render targets, pipeline state, draws)
    gfx/gl/gl_device.cpp                     OpenGL 4.1 core backend (glad)
    core/                                    noise.js port, input mapping (bindings.js), button prompts (prompts.js),
                                             job system, asset paths + zstd data reading, log
    engine/                                  asset manager (cgltf + meshoptimizer + libwebp), models / skinning /
                                             animation, renderer (shadow map, PBR, terrain, sky, tone mapping, HUD),
                                             procedural audio, quality presets, shaders
    world/                                   world.js / wolkenspitze.js / legacypeak.js height port, quadtree terrain,
                                             scenery (trees from vegetation.js, colliders), resort (Phase 2 data),
                                             lifts (lifts.js motion + riding), gondola_station (gondolastation.js),
                                             transport (roads, decks, timetables' data), rail_sweep (the track)
    engine/canvas2d, engine/mesh_kit         software 2D canvas (sign textures, stb_truetype), procedural geometry kit
    engine/ui                                the immediate-mode 2D layer (SDF text, shapes, the house style)
    player/                                  player.js physics port, the skier rig (model, clips, procedural stance)
    net/                                     (Phase 6) stream.h: THE network interface (TCP / TLS byte stream; desktop:
                                             socket_stream.cpp = BSD sockets / Winsock + mbedTLS, a Switch build swaps in
                                             nn::socket + nn::ssl), websocket (RFC 6455 client on a worker thread, HTTP GET),
                                             client (client.js: events, requests, clock sync, reconnects), protocol.h
    game/                                    main loop, spawn, HUD, autotest; vehicles (models, instanced draw),
                                             drive (drive.js + the Autohaus), traffic, buses, trains (Wolkenspitzbahn,
                                             Legacy Express); (Phase 4) menus, hud, trailmap, economy (+ save); (Phase 5)
                                             play (the shared context) / play_data, races, jobs (+ taxi), police (+ prison,
                                             vehicle / people hits), rescue (+ hospital), chalets (+ build mode), interiors,
                                             people (+ PeopleSim), snowmobile, weather, shapes; (Phase 6) mp_session
                                             (session.js: account, login, the save swap, presence, the server economy,
                                             seats, rides, chat), mp_view (the other players drawn, name cards, overlays)
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

## What Phase 4 ports

**The 2D layer** (`engine/ui`): an immediate-mode UI drawn after the 3D frame in a handful of draws — rectangles,
rounded rectangles and outlines (signed distance in the shader, anti-aliased), circles, triangles, polygons, lines,
gradients, textured quads, a CPU clip stack for scrolling lists — and text from signed-distance glyph atlases (one
2048² R8 atlas baked at start-up with stb_truetype, so any size stays crisp) in the game's own fonts:
`export_fonts.mjs` converts **Barlow Condensed** 500 / 600 / 700 / 700 italic / 800 italic (`@fontsource`, WOFF) and
**Inter** (`@fontsource-variable/inter`, WOFF2: Brotli plus a port of the glyf / loca transform) to TTF. The house
style is approximated with it: menu.js's paint strokes (blunt cap, wavy edges, the bristle tail, seeded per label),
the `--brush-a` / `--brush-b` paper silhouettes, ragged paper panels, blue italic condensed lettering, red section
labels, keycaps (`.kc`) with the PlayStation symbols and arrows drawn as shapes.

**Menus** (`game/menus`, menu.js): the main menu over the live world (a slow orbit over the village; a loading
screen while the world builds) — PLAY · CONTROLS · STATS · SETTINGS · QUIT; PLAY → SINGLEPLAYER / MULTIPLAYER (Phase 6) → CHOOSE YOUR SKIER the first time (MAN / WOMAN on the 3D showcase: the skier on the plaza, left / right
picks, drag or the right stick turns it; the rig reloads `skier_red` / `skier_blue`) → START. Pause (Esc / Menu /
Options / +): RESUME · CONTROLS · STATS · SETTINGS · MAIN MENU · RETURN TO VILLAGE · QUIT GAME; the simulation stops
under it. **SETTINGS** has menu.js's rows: graphics (the six presets — applied at the next start, as the web game
restarts —, render scale and shadows live, brightness, frame rate limit, fullscreen), audio (master / effects drive
the procedural audio; music has nothing to drive yet), controls (sensitivity, controller look sensitivity, invert Y,
vibration), camera (field of view, starting view, camera shake, screen effects), HUD (full / minimal / off, size,
km/h / mph, 12 / 24 h clock, player names, show FPS), player (change skier, account — a stub that names the
platform user —, reset all progress with a confirmation). **CONTROLS**: every action of `bindings.js` with its
keyboard key and controller button, the controller family (the connected one, or Xbox / PlayStation / Switch to
preview) with `prompts.js`'s glyphs, left / right picks the column, Enter captures the next key (a taken key is
swapped) or button, resets per device, and a reference panel of what each control does; bindings are stored in the
save's `binds` as the web game does. STATS: the career. Every screen is navigable with the D-pad / left stick
(held: repeats), the family's confirm / back buttons (Switch: A right / B bottom, `core/prompts` `confirmButton`),
LB / RB (Q / E) for tabs, the keyboard (arrows / W A S D, Enter / Space, Esc / Backspace) and the mouse (hover,
click, wheel, sliders and segments by click). Button names follow the device in use live (`prompts::K()`).

**HUD** (`game/hud`, hud.js): white brush pills with blue italic lettering — location (village / the nearest run /
backcountry / the lift you ride), clock · weather, the objective line (rent skis, buy a pass), the waypoint arrow and
distance to a trail-map mark, the flash line (good / bad / gold, ≥ 5.5 s), money with the last change fading beside
it, the speedometer with your skis or car, the interaction prompt with its keycap, the ride hint, the controls hint
card once per save (`save.tutorial`), FPS; all scaled by the HUD size setting and switched by the HUD mode.

**Trail map** (`game/trailmap`, trailmap.js condensed; M / View / Minus): the relief shaded from the terrain itself
(trailmap.js `buildTile`: hillshade from the north-west, rock, forest tint, contours) at two levels computed on the
worker threads at start-up; roads (valley grey, scenic amber, access), the Wolkenspitzbahn and the Legacy Express
(violet, dashed in tunnels), pistes in their grade colours with names zoomed in, lifts with names, huts, bus stops,
stations, services (ski shop, tickets, Autohaus, Werkstatt, medical centre, police), car parks, summits, your car and
you; drag / wheel or left stick / triggers to pan and zoom, R / Y back to you, a click (or confirm) marks a place
(the HUD's waypoint points there), hover / centre tooltips, a legend.

**Economy and saving** (`game/economy`, economy.js): the save in the web game's JSON shape (money, skis, owned,
character, dayPass, tickets, day, hour, stats, records, quality, tutorial, outfits, binds, garage, rental, rescues
and the flat device settings of `DEVICE_PREFS`; unknown keys kept as they were) through `Platform::writeSave`
(`ski-legacy-save-v1.json`, atomic), written on every purchase / setting and every 60 s (autosave), on quit and on
MAIN MENU. Prices and charges, from the JS: the **ski shop** at the rental shop (all twelve `SKIS`, rent / buy /
equip) with the outfit tabs (jackets, trousers, helmets, goggle lenses: buy once, wear per character); the **ticket
seller** (day pass $150 for the game day, gondola tickets $50); **lifts** charge their `layout.js` price (skis
needed first; a day pass or a gondola ticket covers them; riding down is free); the **Wolkenspitzbahn** uphill $50 and
the **Legacy Express** $75 unless you have the pass; the **Autohaus**: E at a car for sale opens its card (price,
garage count; up to 10 cars, a plate each), the car waits in a free bay of the Autohaus car park, MY CARS at the
counter sells one back for half; the **Werkstatt**: drive in and stop, repair priced by the damage (`repairCost`:
$5 steps up to $500); a **wreck** costs the tow + repair ($2,000, even into the red) and the car comes back to the
Autohaus repaired 20 s later; a car of yours **left on a road** with you 250 m away for 60 s is towed ($500); the
**rescue**: the second wipeout within 3 min (no lift ride between) brings you round at the medical centre for
rescue.js's fee ($300 + $25 per earlier rescue, at most $1,000); a hot chocolate at the huts ($8). Midnight is a new
day (the pass runs out).

Autotest output (llvmpipe, 1280×720, medium; the Phase 4 lines and the summary):
```
world ready in 15.29 s (the trail map's relief builds on the worker threads meanwhile)
[autotest] menu: main menu -> PLAY -> SINGLEPLAYER -> CHOOSE YOUR SKIER (MAN, WOMAN) -> START: ok
[autotest] settings: HUD size 100% -> 105% (right on the focused row) -> ok
[autotest] shop: rented the Rental Carver: $500 -> $450, skis 'rental' -> ok
[autotest] save: wrote autotest-save.json, reloaded: money $450 (expected $450), skis 'rental', HUD size 1.05, character skier_blue -> ok
[autotest] skied 80 m along the run (42 m from the start), dropped 19 m, top speed 53.9 km/h, final 53.9 km/h, 1 landings, 0 crashes
[autotest] lift ticket: $450 -> $400 (the Legacy Gondola's price $50, no day pass) -> ok
[autotest] autohaus: bought the BMW X3: $25400 -> $2900 (price $22500), garage 1 -> ok
...
[autotest] map: open, relief ready yes, 73 items drawn, hover 'Bus stop · Legacy Village' -> ok
[autotest] 2097 frames (157.8 s simulated) in 544.9 s wall: avg 3.8 fps
[autotest] ski ok, building collision ok, gondola ride ok
[autotest] drive ok, traffic ok, bus ok, Wolkenspitzbahn ok, Legacy Express ok
[autotest] menus ok, settings ok, shop ok, save / reload ok, lift / car charges ok, trail map ok
[autotest] PASS
```

### Known gaps (Phase 4)
- **Look**: the brush shapes are approximations of the SVG / CSS ones (no drop-shadow filter, the strokes' bristle
  tails are coarser), no screen transitions beyond a slide-in, no menu sounds (audio is Phase 7); the Inter font is the
  variable font's default instance (weight 400: no bold Inter), no kerning (GPOS).
- **Menus**: MULTIPLAYER and the account were stubs (Phase 6 made them real, with a typed name field); the graphics
  preset needs a restart; music volume, bloom, camera shake and screen effects are stored but have nothing to drive yet;
  no virtual mouse.
- **Shops**: one card dialog instead of the walk-in ski shop and the outfit shop's 3D podium; outfits are bought and
  stored but not yet applied to the skier's materials; the skis' speed / grip don't change the physics yet; no kits.
- **Cars**: no configurator (paint, rims, interior, custom plates), no showroom interior or salesman, no tow truck
  driving (the car reappears), the impound is a fee when it is towed rather than a yard you pay at.
- **Rescue**: no helicopter or ambulance ride (you come round at the medical centre), no hospital ward; no jobs or
  race prizes to earn money yet (Phase 5), so a new save has $500 and the autotest grants itself the car's price.
- **Trail map**: no layer switches, races, jobs, secrets or road names; labels are placed without collision tests; one
  relief level pair (no 128 m detail tiles).
- No chalets or furnishing (moved to Phase 5).

---

## What Phase 5 ports

**How the gameplay data gets here.** `export_resort.mjs` builds a third pack after the transport, `play.json / .bin`
(`export_play.mjs`), again with the game's own modules: every World Racing course is registered and *built*
(`course.build`: start house, START / checkpoint / FINISH arches, the B- and A-nets, slalom gates, tunnels, bridges,
grandstands, timing boards, floodlight masts... captured like the resort, 20 540 props and 1 233 mesh chunks with their
colliders), the ski bus's three free races (`BusRaces`: their piste courses' meshes and the race boards beside the stops),
the RACING stand placed by `RaceStand`'s own rules, `new Sites(...)` (jobs/sites.js: the 6 boards, 54 destinations, 1 963
piste-side spots, the router's lifts), the taxi's 22 places (`Taxi.buildPlaces`), the police station / prison, the
Autohaus car park with its impound row, the heli pad and the medical centre (busRoads), the 18 chalets (`Chalets.plan`),
the chalet's ground floor (`chaletlayout.js planLayout`) and the furniture catalogue (`build/catalog.js`). Per course: the
line every 2 m (x, y, z, half width, heading, curvature), start / finish / checkpoints, the gates, the prize (freeworld.js
`coursePrize`), par and medals (courses.js REF_TIMES x MEDAL_K).

**Races** (`game/races`): E at a course's start house (within 24 m) opens the race card: the AI field (Easy / Medium / Hard
/ Superhard: freeworld.js AI_LEVELS, the prize x 0.6 / 1 / 1.6 / 2.5, the entry fee), a practice run (alone, no prize);
the bus races' boards: free entry, every finisher paid (busracedefs.js busRacePrize: podium 100 / 70 / 50 %, else 40 %
under par, 30 %); the RACING stand in the village: any course, just for fun, a fade and you stand at its start. The session
(session.js condensed): the grid, 1.4 s and 3-2-1-GO (held), the clock, checkpoints with the split against the fastest AI
racer, slalom gates between the turning pole and the outer pole (missed: +0.5 s, the next gate's green bar), the B-nets
bouncing you back into the track (restitution, a little speed scrubbed), respawns at the last checkpoint behind a fade
(a wipeout after 1.4 s, stuck 5 s, off the course 9 m for 1.5 s, fallen 7 m below it), WRONG WAY, the finish (time from the
line crossing), the ski-out brake, the results card after 2.6 s (or when the field is home), records.js `submitTime` /
`submitPlace` into `save.records[course]` (best, medal by time, splits, runs, best place, best place per field, race
medal), the prize, career stats; OK and a fade back to Legacy Village (modes.js exitFree). **The AI field**: 14 racers on
bots.js DIFFICULTY's paces; each follows a speed profile of the course itself (lateral grip 17.5 m/s² in its curvature,
gravity down its grade, drag, braking room: a forward and a backward pass) scaled so the run takes the course's reference
time x its pace, weaving across the track, braking into the finish area; drawn as the six skier characters (tuck / carve,
leaning into the turns). **The race guide** (raceguide.js): off the bus or a train at a stop with a race within 600 m
(the bus race of that stop first): the waypoint, the objective line with the distance, a tall glowing pillar over it and
pennant poles every 30 m on the way; it ends there, after 180 s or when you wander off. The crowd stands along a course's
finish while you are within 700 m of it.

**Jobs** (`game/jobs`): job_board.glb at the six hubs; E: catalog.js `generateOffers` ported exactly (FNV over the UTF-16
id `board|day|slot|re-pins`, mulberry32, the slots' types, CARGO's pools and kinds, the rescue's `descentFor`, the guide's
SKILLS, pay / tip / par / limit), with the Router's travel-time estimates (sites.js: downhill / flat / uphill, via any lift);
the same three offers all game day, a slot re-pinned when its job ends (`save.jobs.gens`). Delivery: the pack on your back,
the destination's person and a glowing ring, handed over within 3 m (the tip scales down from par to the limit), a
wipeout loses it; rescue: the casualty lying by the piste with the crossed skis, then the akja towed behind you (over 19 m/s
for 6 s: too rough) or the stuck beginner following your tracks down to the hut / lift / village; guide: the guest skis
your tracks at their skill's pace (lost after 20 s over 150 m). Fail texts and success texts from catalog.js. **Taxi**
(taxi.js): the TAXI note on every board (a car of your own needed), the dispatcher's fare at one of the nearer places, they
walk to your car when you stop within 16 m, the destination 900 m+ away, the tariff ($60 + $180 a km + $15 per 100 m
climbed, $150-2,200), the time limit, tips for quick (under 70 %) and smooth (no knocks) rides, late: -25 %, a crash:
half; knocks make them complain; a police chase ends the fare; T ends the shift.

**Police** (`game/police`): wanted when your car hits traffic / a parked car / a person at 25+ km/h, a patrol car at 15+,
or speeding 40 km/h over the limit past the station; police.js TUNING and LEVELS (cars, reinforcements, road speed,
catch-up, ram gaps, sight range, the escape time). Patrol cars (car1.glb in its POLIZEI livery, the flashing blue roof
bar) appear out of sight 260-420 m away on the roads behind you, follow the roads while far (the lane toward you), cut
straight at you when close (or when a road leads nowhere), ram the rear quarter while you flee (the impacts are drive.js's
own bash: knocks, crashes, damage; hitting them raises the heat). Stop with them within 40 m: pulled over, the officer
(police_officer_rigged.glb) walks to your window: pay $1,000 (+$500 for each earlier fine / arrest) or drive off. Not
stopping within 6 s of them reaching you: fleeing (2 stars, then a star every 36 s in sight). Escape: out of every patrol
car's sight (line of sight through the terrain, a road tunnel hides you) and the helicopter's: SEARCHING after 2.5 s,
escaped after the level's time (x2.2 on foot); seen again: half the time kept. The helicopter (4+ stars or 45 s fleeing:
heli_body.glb, 72 m up, 64 m/s) keeps over you with its searchlight cone. Arrested when boxed in (two cars within 12 m for
10 s), stopped while fleeing with them close, or caught by the officer on foot (he runs 6.9 m/s, slowed on steep ground,
gives up beyond reach): the ARRESTED banner (the word slamming in, red / blue at the edges), $3,000 (+$1,000 each time),
45 s in prison. **Prison** (prison.js): the cell block as an interior (three cells behind the bars, bunks, toilets, the
guard's desk and the visiting desk, the front office): "In prison · 0:45", walking the cell, released at the station's
door; `save.jail` resumes a sentence after a reload; E at the station's door visits it (the visitors' book: a local
leaderboard of visits, arrests, fines, the longest sentence). **Hits** (vehiclehits.js / peoplehits.js): traffic, the
buses and patrol cars running into you on foot or on skis knock you over along their line (launchFor's arc), under
35 km/h a bump, 35-45 km/h a strike (the second: the rescue), 45+ km/h the rescue at once; 2 s safe after; your car
throws the village's people (they lie and get up), $12 per km/h (200-1,500) and the police. **Impound** (impound.js):
your car left empty on a road or out on the snow (not in a car park, a lay-by or the chalet village) with you 40 m+ away
for 2 minutes is towed to the impound row of the Autohaus car park ($1,500, the wreck fee), locked until the next game day
("Impounded · available tomorrow"; `save.impound`). (Replaces Phase 4's 60 s / 250 m / $500.)

**Rescue** (`game/rescue`, heli/rescue.js + ambulance.js + hospitalroom.js): instead of the fade, the rescue helicopter
comes from its pad (from 1.5 km+ it starts on its way, 800 m out), cruises 45 m up, hovers 12 m over you and winches you
up (2.6 + 4.2 s), flies you home (the chase camera, Space x4), the ambulance at the pad drives the Rettungsweg (the road
roads.js planned for it) to the medical centre with its blue lights, the bill (rescue.js), and you come round in a bed of
the ward (four beds, the Meshy hospital furniture): RECOVERING for 8 s, then E gets you up and out of the front doors; a
watchdog (45 s without getting closer) sends you straight to the medical centre. E at its door visits the ward.

**Chalets** (`game/chalets`): the 18 chalets (chalet.glb within 60 m, chalet_lo.glb beyond) by their plan frames; E at a
door: buy ($50,000, one each, `save.chalet` in the web shape), look inside, or go into yours. The interior: chaletplan.js's
ground floor (the walls split at the windows and doors, the stair block), oak floor, larch ceiling, the front door leads
out. **Build mode** (buildmode.js / placement.js / catalog.js): the furnish button opens the catalogue (the six rooms'
tabs, all 45 pieces and prices), the item in hand follows the centre dot (or the cursor: the controller's virtual mouse,
gamepad.js, the left stick moves it, confirm clicks) as a blue / red blueprint ghost on the 0.25 m grid (placement.js
`onFloor`, SAT `boxesOverlap`, `boxHitsWall`, the stair block; small decor sits on furniture; wall items hang where the aim
meets a wall (`rayWall`) at their mount height; ceiling lamps hang from the ceiling); the Meshy furniture GLBs fitted by
`fitScales` (height exact, footprint within -23 / +30 %, rugs laid flat, long sides turned); place (bought), move (Q), sell
(X, half back), lamps on / off (E, glowing bulbs), all in `save.chalet.furniture` (the house frame).

**People** (`game/people`): one renderer for every person: the six skier characters (with skis), the eight fan_*
townsfolk and the police officer, posed from shared poses built once per character (idle and walking / running cycles in
phases, a skiing crouch, a tuck, seated, lying, waving: the skier_*_anims clips retargeted by bone name), the nearest 48
within 220 m, the lighter LOD past 35 m, shadows within 40 m. **PeopleSim**: 56 townsfolk walking between the hotels'
doors, the ski shop, the gondola, the market, the fire pit, the tree, the trail map, the bus stop (round the colliders,
lingering at the sights, fewer at night), skiers carving down the pistes near you; knocked over by your car.

**Snowmobiles** (`game/snowmobile`, snowmobile.js): 15 parked (five in the village, the rest at the huts and lift bases),
E to ride, SLED's handling (throttle / boost / brake / reverse, traction-limited climbing, skids on ice and side slopes,
crests, bumps off trees and colliders, thrown off at 12.5 m/s straight in), the chase camera, E (stopped) off.

**Weather** (`game/weather`, sky.js): the eleven states (clear, flurries, cloudy, light / heavy snow, misty, blizzard,
föhn, wet snow, freezing fog, sea of clouds), NEXT's progression with the hold times, the forecast in the HUD ("Later:
Blizzard"), the eased snow / cloud / mist / wind / clear-air / wet / frost values, the overcast deck greying the sky by the
hour's light level, sky.js's fog formula (whiter in snow and mist), the sun dimmed behind cloud, the gusts on the skis,
the falling snow (2 200 flakes at heavy snow in a box round the camera, blown sideways in a blizzard); held during a race.

Autotest output (llvmpipe, 1280×720, medium; the Phase 5 lines and the summary):
```
play: 20540 props, 1233 mesh chunks, 272 canvases, 11018 colliders
play: 11 courses, 3 bus races, 6 job boards, 54 destinations, 1963 spots, 22 taxi places, 18 chalets, 45 furniture items
people: 15 characters (6 skiers, 8 townsfolk, the police officer)
snowmobiles: 15 parked (5 in the village)
world ready in 21.61 s ...
[autotest] race: Sunny Meadow (Easy, 1317 m, 190 m drop, par 72.0 s, entry $0, 0 gates, 3 checkpoints) -> started
[autotest] race: finished in 1:18.14, place 7, money $4775 -> $3275
[autotest] race: records[meadow] = {"best":78.14,"bestRace":7,"byDifficulty":{"medium":7},"medal":"silver","raceMedal":null,"runs":1,"splits":[30.25,46.547]}, in the save file yes -> ok
[autotest] race: OK -> back in Legacy Village (4, 34) ok
[autotest] job board Legacy Village: Fondue cheese to Sonnenkopf Hütte · delivery · $1130 (+340 tip) · limit 810 s
[autotest] job board Legacy Village: Skier down · Hasenweg · rescue · $2200 (+550 tip) · limit 810 s
[autotest] job board Legacy Village: Guide Yuki to Adlerhorn Hütte · escort · $1190 (+360 tip) · limit 795 s
[autotest] job: delivered: money $3275 -> $4745 (+1470; reward $1130 + tip), jobs done 0 -> 1 -> ok
[autotest] police: wanted (fleeing 2*) at (57, 110)
[autotest] police: ARRESTED after 32.9 s
[autotest] police: jail timer 45.0 s -> 41.0 s, in the cell yes -> ok
[autotest] police: released outside the station (142, 264) ok; record {"arrests":1,"fined":3000,"longest":45.0} -> ok
[autotest] chalet: bought Chalet 1: $61745 -> $11745, inside yes -> ok
[autotest] chalet: build mode, placed the Wingback Armchair at (-2.97, -5.03): $11745 -> $10845, 1 pieces -> ok
[autotest] chalet: left it (outside), in the save: {"furniture":[{"id":"armchair",...}],"id":0,"layout":3,"name":"Chalet 1","owned":true,...} -> ok
[autotest] weather: Heavy snow, snow 0.30, cloud 0.30, fog density 0.000214, 1 change(s) -> ok
[autotest] snowmobile: rode 12 m in 2 s, top 42 km/h -> ok
[autotest] 4522 frames (308.4 s simulated) in 785.8 s wall: avg 5.8 fps
[autotest] ski ok, building collision ok, gondola ride ok
[autotest] drive ok, traffic ok, bus ok, Wolkenspitzbahn ok, Legacy Express ok
[autotest] menus ok, settings ok, shop ok, save / reload ok, lift / car charges ok, trail map ok
[autotest] race + records ok, job ok, police chase + jail ok, chalet + furniture ok, weather ok, snowmobile ok
[autotest] PASS
```

### Known gaps (Phase 5)
- **Races**: no ghosts (the time trial mode is gone in the web game too), no broadcast presentation (intro flyover, podium,
  replays, photo finish), the AI racers follow a speed profile (bots.js simulates each racer's own physics, lines, jumps and
  mistakes), no contact between racers, no RACE AGAIN; the course meshes stand everywhere (the web game builds them within
  1.7 km); the low-poly spectators of props.js are replaced by the character crowd.
- **Jobs**: the people are drawn but have no lines of dialogue beyond the flash texts; the guest follows a simplified
  trail; no pack fitting to the jacket (a box on your back); no job board notice-board UI (the card dialog); the taxi's
  passengers don't sit visibly in the car and walk straight to the door; no lost & found.
- **Police**: no roadblocks or spike strips, no PIT / T-bone choreography beyond aiming at the rear quarter, no radio
  road names (compass only), no siren audio (Phase 7), no chalet raids, no slow motion; patrol cars don't brake for the
  bends or avoid obstacles off the roads.
- **Interiors** are boxes and the game's furniture GLBs at a quiet spot (not chaletroom.js / prison.js / hospitalroom.js's
  modelled rooms with their windows onto the real world, LivePortal); only the chalet's ground floor; placed lamps glow but
  don't light the room (no point lights yet); the hospital bed view is the standing first-person view.
- **Rescue**: no landing on flat snow (always the winch), no rope physics; the ambulance follows the road's centre lane
  without dodging.
- **People**: shared pose phases (no per-person IK, head tracking or getting-hit animation); no railway station people,
  no fans.js keyframes (cheering, flags), no chat groups.
- Snowmobiles are free to take (as snowmobile.js: no rental counter); the rider uses the seated rig, not skier.js's
  handlebar IK. (`-DSL_COPY_ASSETS=ON` lists every model the game loads since Phase 6.)
- The trail map shows no races, jobs, chalets or the police yet.
- Not ported yet: the player's helicopter (heli/*: flights, pads), snowcats and ploughs, snowmaking spray, flags, the
  parkour mode, multiplayer bits of all of the above.

---

## What Phase 6 ports

Multiplayer against the **existing Node server** (`server/`, unchanged: its 415 tests still pass), speaking the JS game's
protocol exactly (`src/net/protocol.js`, `server/lib/server.js`, `docs/multiplayer.md`): JSON text frames `{ t, d, id? }`,
answers `{ t: 'res', id, ok, d | err }`, presence rows `[ts, x, y, z, yaw, vx, vy, vz, state, crouch, lean, flags]` with
the same state enum and flag bits (air, tuck, skis on / carried, car, lights, wreck, sled, paused, the wanted stars,
the wipeout's packed tumble), the server stamping pid, vehicle (`kind:id:seat`) and interior.

**The network layer** (`src/net/`). `stream.h` is the one interface a console port replaces: a blocking TCP / TLS byte
stream with timeouts. The desktop implementation (`socket_stream.cpp`) is BSD sockets / Winsock (non-blocking, `poll`)
with **mbedTLS 3.6.2** (FetchContent, the release tarball, pinned by SHA-256) for `wss://`: TLS 1.2 / 1.3, the
certificate chain and the host name verified against the system's bundle (`SSL_CERT_FILE`, the usual Linux / BSD /
macOS paths, the Windows ROOT store) plus the two Let's Encrypt roots built in (`ca_roots.h`: the server's Caddy
certificate is Let's Encrypt, so it verifies on any machine). On Switch the same interface goes on `nn::socket` (or
NEX's transport) with `nn::ssl`. `websocket.cpp` is a small RFC 6455 client (the HTTP upgrade with the
`Sec-WebSocket-Accept` check, masked frames, fragments, ping -> pong for the server's heartbeat, the close handshake and
its codes; 1006 for a dropped line) on a detached worker thread, so DNS, connects and TLS never stall a frame; plus a
one-shot HTTP GET (the server's `/health`). `client.cpp` is `client.js`: events, requests with ids and timeouts (a late
frame extends them, as the JS does for a busy main thread), clock sync (ping / pong every 2 s, the best of 10 samples by
round trip, small corrections eased in, a jump restarts), the liveness check (20 s of silence: reconnect), reconnects
with the same backoff (0.3 / 1 / 2 / 3 / 5 s for up to 120 s, then "Connection lost"), close code 1000 for LEAVE (the
server lets you go at once) and 4000 for a stale socket (the server holds you for a minute).

**The session** (`game/mp_session`, session.js):
- **Accounts** as the JS does them: a unique name registered once; the server issues a secret token (there is no
  password in this protocol), stored per server URL through `Platform::writeSave` (`ski-legacy-mp-accounts.json`, the
  JS game's `localStorage['ski-legacy-mp-accounts']`); `bad_login` forgets it (pick a name again); rename (every 15 days)
  and delete go through the same token-checked `accountRename` / `accountDelete`.
- **Joining**: `login { v, name, token, look, plots, tt }`; the server puts you in the fullest world with room (up to 50
  players; it was 15 when the plan was written): the protocol has no world list, so the MULTIPLAYER screen shows the
  server's `/health` (worlds, players online) and the pause menu lists your world and its players. A login after a drop
  resumes the held player (same world, pid, seat, chalet plot, car).
- **The save swap**: the server profile goes into the save (money, skis, outfits, the chalet, the garage with each
  car's damage and the tow yard, stats, records, secrets, the day pass and tickets, where you were, a sentence you left
  in); the single-player save is set aside untouched and comes back on leave, keeping this machine's settings
  (economy.js DEVICE_PREFS). While online the save file only receives the device settings (`Save::mpWrite`); the parts
  the player owns go to the server with `profileSet` 1.5 s after a change.
- **Server-authoritative economy** exactly as the JS: the **money guard** (any drop of the money is a `spend` the server
  checks, game charges may go into debt down to -$100,000; a rise that did not come from the server is undone); skis,
  outfits, cars (the server prices them and issues a plate nobody has), chalets: `buy`; MY CARS: `carSell`, driving
  another of your cars: `carSwitch`; the Werkstatt: `carRepair` (the server's price); crash damage: `carDamage`; a wreck
  or a car left on a road: `tow` / `towDone` (the server's fee, its tow yard); job payouts and furniture sold back: `earn`
  (`job` / `sell`, the server's caps); races are practice races (`raceSolo` / `raceFinish`, no fee, no prize).
- **Police**: an arrest is the server's sentence (`jail`) and then `policeArrest` (your passengers and anyone who rode
  with you in the chase go to prison too); `arrested` jails you when the driver you rode with is caught; a sentence
  left unserved puts you back in the cell at the next login.
- **The world's clock and weather** from the server (the hour, the in-game day the day pass counts, the weather and its
  forecast in the HUD), and the **Wolkenspitzbahn / Legacy Express on the shared timelines** (`lineTime`: the server
  clock plus each line's speed-up): every client places every train at the same spot; nobody jumps the timetable, you
  board a train standing at the platform, and SPACE speeds the line up only while everyone aboard holds it (`skip`).
- **Seats** in the server's registry on the bus / train / Express / cabin / chair you ride (`seatClaim` with the
  vehicle's seat count, `seatRelease`), so the others see you seated in it and a full vehicle says so.
- **Car rides** (carride.js): your car out (`veh` with its spot, or driven: your presence is the car's pose with
  steering, lights, wreck, the wanted stars) and your other cars parked (`parked`) are shown to everyone; beside another
  player's car **E** asks the owner (`perm carRide`; they get "Allow X to get in your car?" Y / N), the server seats you
  (seat 1 front, 2.. back) and you ride in that seat of their car as it is drawn here; **E** gets out; `seatLost` (the
  owner left or took it back) puts you out. The players riding in your car sit in its seats.
- **Chalets of others**: the global registry (who owns which plot), buying through the server (one each), visiting
  another player's chalet with their yes (`perm chaletVisit`, `chaletFurniture`: their furniture inside, `enter` with the
  server's approval), your guest list, `kickInterior`.
- **Interiors**: you are shown only to players in the same interior (`enter`: `prison`, `hospital`, `chalet:<plot>`).
- **Admin**: the banner (`adminMsg`) across the top, notes (`adminNote`), releases, `adminTp`.
- **Chat**: the server relays it (the JS game has no chat UI yet; here **Enter** opens a chat line, the last lines show
  bottom left).
- **Leaving**: LEAVE MULTIPLAYER (the profile pushed, close 1000), the server kicking you / another login (4001) /
  a restart / 120 s without a connection: back to the main menu with the reason.

**The other players** (`game/mp_view`, remote.js / vehicles.js): each as the game's character for their look (People:
skiing with skis on, the tuck, walking or running by their speed, seated on a lift / bus / train / sled, lying after a
wipeout), from a 16-row ring of their presence played out ~120-400 ms behind the server's clock (the delay follows each
player's lag, row spacing and jitter, eased), a short extrapolation when rows are late; their car (model from the
server's `veh` record) driven or parked, their other cars, their snowmobile; a name card over each head within 150 m
(PAUSED, WANTED stars; SETTINGS -> Player names); the status pill (name · world · players, "reconnecting..."), the
owner's Y / N prompt with its 30 s bar, the admin banner, chat. Traffic, the townsfolk and the race field are off
online (the other players instead), as `setAI(false)` does in the JS.

**Menus**: PLAY -> **MULTIPLAYER**: the server and its worlds (`/health`), your name (registered: JOIN A WORLD, USE
ANOTHER NAME; else a name field, typed, the platform's user name suggested) -> REGISTER -> JOIN A WORLD; the pause menu
online: the players and LEAVE MULTIPLAYER; SETTINGS -> Account shows your multiplayer name.

**Connecting to the real server**: just PLAY -> MULTIPLAYER (the default is the game's server,
`wss://138-199-163-183.sslip.io/ws`, TLS verified with the built-in Let's Encrypt roots); `--server wss://host/ws` or
`SKI_LEGACY_SERVER` for another one, `ws://` for a local one:
```sh
cd server && npm install && PORT=8787 npm start      # ws://127.0.0.1:8787 (data in server/data)
./native/build/ski_legacy --server ws://127.0.0.1:8787/ws
```

**The test** (`--mptest`), against a local server with the JS test player (`tools/mp_peer.mjs`, which earns two job
payouts, buys a Golf through the server, parks it on the plaza and says yes to everything):
```sh
(cd server && PORT=8790 DATA_DIR=/tmp/sl-mp node index.js &)
node native/tools/mp_peer.mjs ws://127.0.0.1:8790/ws 100 car &
SDL_AUDIODRIVER=dummy xvfb-run -a -s "-screen 0 1280x720x24" ./native/build/ski_legacy --mptest ws://127.0.0.1:8790/ws --mp-peers 1 --png /tmp/mp.png
```
```
[mptest] MULTIPLAYER screen: server ws://127.0.0.1:8790/ws, Online · 1 world · 1 players · you join the fullest world with room (up to 50)
[mptest] registered 'Native5695' (token stored for ws://127.0.0.1:8790/ws)
[mptest] joined world 1 as Native5695 (pid 2): 1 other player(s), money $500 (server), clock 10.13 h, weather clear
[mptest] presence: 95 rows sent in 8.0 s (11.9 / s, 71937 frames), at (7.0, -0.0, 0.4), rtt 2 ms
[mptest] remote player JsPeer1830 (pid 1): at (-1.0, -0.0, 33.3), state 0, flags 0x0, look {"c":"skier_red","o":null,"s":"rental"}, 34 m away, delay 171 ms -> drawn
[mptest] car ride: JsPeer1830's car_vw_golf_gti parked at (16.0, 24.0): walking up to it
[mptest] car ride: prompt 'Ask JsPeer1830 for a ride'
[mptest] car ride: seated in JsPeer1830's car, seat 1 (the server's registry: car|JsPeer1830)
[mptest] car ride: got out at (16.2, 22.6), seat released -> ok
[mptest] buy: Rental Carver at the ski shop: money $500 -> $450 here, the server's profile: money $450, owned ["rental"], skis rental -> ok
[mptest] day pass: $450 -> $300, the server's profile: money $300, dayPass 3502 (world day 3502) -> ok
[mptest] chat: sent and relayed back (1 line(s))
[mptest] connection dropped (no close frame): reconnecting...
[mptest] reconnected after 1.0 s: resumed, world 1, pid 2, 1 other player(s), status 'Native5695 · WORLD 1 · 2/50 PLAYERS'
[mptest] left multiplayer: back at the main menu, the single-player save back (money $1234, expected $1234) -> ok
[mptest] PASS
[peer] Native5695 asks carRide: allowed
[peer] Native5695 is riding in my car (car:JsPeer1830:1)
[peer] chat Native5695: hello from the native client
[peer] saw Native5695 (pid 2): 254 presence rows, last at (15.0, -0.2, -44.0) state 0 flags 33554432
[peer] PASS: the native player was seen
```
Two native clients against each other (`--mptest ... --mp-peers 1` twice) see each other the same way (both PASS). With
`--png` the test writes `_mp` (the other player and their name card) and `_car` (riding in their car, drawn from their
`veh` record). The single-player autotest is unchanged and still passes, now run from the `-DSL_COPY_ASSETS=ON` folder
(no "model not found"):
```
assets: .../native/build/assets | data: .../native/build/assets/data
world ready in 22.18 s: 315 terrain nodes, 1908 trees in range, 29404 resort props, 18 lifts, 766 MB textures
[autotest] 4522 frames (308.4 s simulated) in 811.9 s wall: avg 5.6 fps
[autotest] ski ok, building collision ok, gondola ride ok
[autotest] drive ok, traffic ok, bus ok, Wolkenspitzbahn ok, Legacy Express ok
[autotest] menus ok, settings ok, shop ok, save / reload ok, lift / car charges ok, trail map ok
[autotest] race + records ok, job ok, police chase + jail ok, chalet + furniture ok, weather ok, snowmobile ok (people drawn 18)
[autotest] PASS
```

### Known gaps (Phase 6)
- **No world picker**: the protocol has none (the server assigns the fullest world with room); the MULTIPLAYER screen
  shows the server's world / player counts instead.
- **Accounts are name + server-issued token** (the JS game's scheme; there is no password to type). On Switch the
  name field wants the software keyboard applet (here: typed, or the suggested platform user name).
- **Races online are practice races** (`raceSolo`): the server's race queues (2-21 racers, the synced start, the live
  board, the results card with prize money) are not wired to the native race session yet.
- **Shared timelines**: the trains are on them; the gondolas / chairlifts and the ski buses still run on the local
  clock (lifts.js / bus.js's time-based placement and the shared bus hold-ups are not ported), so a remote rider is
  drawn where their own client puts their seat (their presence), not in your local cabin; the bus seat registry uses
  `bus:1..7` by the local bus index.
- **Remote vehicles**: cars are drawn from their model id (no paint / rims / plate / dents, no seated driver model,
  no wheels turning, no lights); the tow truck, patrol cars chasing them, the rescue helicopter / ambulance and rented
  helicopters of other players (`veh` tow / police / rescue / heli) are not drawn; the helicopter pad (`heliRent`) is
  not ported (the player helicopter is not ported at all yet).
- **Interiors** are the native boxes at a quiet spot (Phase 5): two native clients see each other inside, but a JS
  client inside the same chalet has other room coordinates.
- A car in the server's tow yard (3 minutes) shows as "available tomorrow" (the next world day, 16 minutes) until then;
  the server's impound bay number is not used.
- Knocked poles / guardrails (`brk`), the transit version check (`tt`: sent as `native-phase6`, so JS clients warn that
  this player's lifts and buses run at other times), the jail board posters, the guests' "send out" buttons (the list is
  shown) and the admin panels are not ported. Bodies of other players don't collide with you.
- The `/health` request and the WebSocket run on worker threads; a Switch build replaces `net/socket_stream.cpp` and
  must still meet Nintendo's online requirements (Nintendo Account, NSO entitlement, the network service agreement).

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
   region), and online rules for Phase 6's multiplayer (Nintendo Account, NSO, network service agreements; the socket
   and TLS layer is `net/stream.h`: implement it on `nn::socket` / NEX with `nn::ssl`).
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
| **4 (done)** | menus, HUD and economy: title / pause / settings (the web settings incl. rebinding UI with controller glyphs), trail map, money, ski / outfit shop, tickets and day pass, lift / train charges, the Autohaus garage, Werkstatt, tow and rescue fees, save games through `Platform::writeSave` (the web save's JSON shape), autosave; the data step in the build, zstd data |
| **5 (done)** | gameplay: races (the World Racing courses with their meshes, the bus races, the RACING stand, practice, the AI field, records, prizes, the race guide), jobs and the taxi, police / prison / impound, vehicle and people hits, the rescue helicopter + ambulance + hospital, chalets and build mode (virtual mouse), townsfolk / skiers / crowds, snowmobiles, weather and snowfall; still open: the player helicopter, parkour mode, snowcats / snowmaking / flags |
| **6 (done)** | multiplayer: the existing Node server (`server/`, unchanged) and its protocol; a C++ client (`net/`: an RFC 6455 WebSocket over TLS with mbedTLS behind `net/stream.h`, the one file a Switch build swaps for `nn::socket` / `nn::ssl` / NEX), accounts, worlds, presence with interpolated remote skiers / walkers / cars / sleds and name cards, the server-authoritative economy, police / jail / impound, chalets of others, car rides, transit seats, the shared train timelines, the world clock / weather, chat, the admin banner, reconnects; `--mptest`. Still open: race queues, lift / bus shared timelines, the other players' tow / police / rescue / helicopters |
| **7** | audio (mixer, `public/audio` samples, Ogg decoding, 3D sound), weather / time of day / night lighting, snow FX, post (bloom, sun glare), and Switch performance: ASTC textures, packed vertices, GPU profiling, dynamic resolution, memory budget, Lotcheck pass |
