# Ski Legacy — native C++ port

A portable C++20 rewrite of Ski Legacy (the Three.js / Electron game in `../src`), built so it can ship on
**Nintendo Switch** once the project has NintendoSDK access, and runs today on **macOS, Windows and Linux**.

This is **Phase 1**: engine core, the real terrain, the skier, forests and the village. Later phases are listed at
the end of this file.

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
by walking up from the executable. For a self-contained folder, configure with `-DSL_COPY_ASSETS=ON`: the ~17 MB of
models Phase 1 uses and `native/data` are copied to `assets/` next to the executable (not the whole 240 MB
`public/`). `SKI_LEGACY_ASSETS=/path/to/assets` overrides both.

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
| `--autotest [--frames N] [--png out.png]` | headless check: load, ski a run for N frames, print stats, exit 0 / 1 |
| `--verify-heights` | compare the C++ terrain with reference samples taken from the JavaScript world |

### Headless test (Linux, Mesa llvmpipe)
```sh
SDL_AUDIODRIVER=dummy xvfb-run -a -s "-screen 0 1280x720x24" ./native/build/ski_legacy --autotest --frames 600 --png /tmp/frame.png
./native/build/ski_legacy --verify-heights
```
`SKI_LEGACY_DEBUG=noterrain,notrees,novillage,noskier` switches parts of the scene off for profiling.

Reference run (a Linux container without a GPU: Mesa llvmpipe software rendering on 4 CPU cores, 1280×720,
medium): world ready in ~2 s; 600 frames = 10 s of skiing down the Panorama run reach 54 km/h with a charged jump
and landing, ~3 fps (software rasterisation; a real GPU is orders of magnitude faster).

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
nothing in Phase 1. Controllers are read by position (`SDL_HINT_GAMECONTROLLER_USE_BUTTON_LABELS=0`), so the
Switch Pro Controller's B is "bottom" exactly as in the web version. Rumble: landings, bumps, crashes.

---

## Architecture

```
native/
  CMakeLists.txt, cmake/Dependencies.cmake   build + pinned third-party code
  tools/export_world.mjs                     runs the JS world code in Node, writes native/data/
  data/                                      world.json, crag.bin, cuts.bin (generated, ~8 MB)
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
                                             scenery (trees from vegetation.js, village buildings from village.js)
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
  positions, sizes and orientations of `village.js` / `layout.js`, with their colliders.
- **Engine**: platform layer, gfx interface + GL backend, input mapping with all web bindings and rebinding,
  rumble, job system, asset manager, PBR + skinning + instancing renderer, shadows, sky, fog, tone mapping, HUD,
  procedural wind / ski / thud audio, quality presets, save-data API.

### Known gaps (Phase 1)
- No lifts, gondolas, stations, huts' interiors, roads, cars, people, races, menus, economy, saves in use, network.
- Terrain cuts are baked data (re-export after JS changes); tunnels' covered cuts, the parkour regions and the roads'
  cuts (built at runtime in the web game) are not included. Trees ignore cuts' forest thinning (a few trees may
  stand on the railway bed). No boulders / scree yet.
- No freestyle tricks or park features (the physics treat jumps as plain airs), no other skiers to bump into.
- The skier's pose is a few procedural layers on the clips, not `skier.js`'s full rig (poles, pole plants,
  gloves-and-poles first-person view are missing).
- Sky is the clear-day palette only (no time of day, weather, clouds, night lights, snowfall).
- Audio is synthesised (no `public/audio` samples yet).
- Meshy models' baked emissive is ignored (as the web game's materials do); no night glow.

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
| **1 (this)** | engine core, platform + gfx layers, exact terrain, skier physics + camera, trees, village buildings, HUD, autotest |
| **2** | the resort: gondolas and chairlifts (cables, cabins, towers, stations, mid-stations, riding + seats from `lifts.js` / `transport.js`), lift stations and huts with interiors, piste signs / nets / fences, snow cannons, the terrain park and kickers (`park.js`, tricks scoring from `tricks.js`), boulders, the full `skier.js` rig (poles, pole plants, first-person gloves) |
| **3** | vehicles and transport: car physics (`drive.js`, damage, lights), roads with their terrain cuts and tunnels, traffic and parking, the ski bus and its routes, the railways (Wolkenspitzbahn, Legacy Express) with stations, snowmobile, helicopter |
| **4** | menus, HUD and economy: title / pause / settings (all web settings incl. rebinding UI with controller glyphs), trail map, money, shops, rentals, chalets and furnishing, save games through `Platform::writeSave` (same JSON shape as the web save) |
| **5** | gameplay: races (World Racing courses = terrain regions, gates, bots, leaderboards), jobs, police / prison / hospital, NPCs and crowds, parkour courses |
| **6** | multiplayer: keep the existing Node server (`server/`) and its protocol; write a C++ client (WebSocket over TLS, e.g. a small libwebsockets / IXWebSocket client behind the platform layer, since console sockets go through `nn::socket` / NEX) with interpolation of remote skiers, car rides, chat |
| **7** | audio (mixer, `public/audio` samples, Ogg decoding, 3D sound), weather / time of day / night lighting, snow FX, post (bloom, sun glare), and Switch performance: ASTC textures, packed vertices, GPU profiling, dynamic resolution, memory budget, Lotcheck pass |
