# Ski Legacy — native C++ port

A portable C++20 rewrite of Ski Legacy (the Three.js / Electron game in `../src`), built so it can ship on
**Nintendo Switch** once the project has NintendoSDK access, and runs today on **macOS, Windows and Linux**.

**Phase 1** (engine core, the real terrain, the skier, forests), **Phase 2** (the village and the resort: buildings,
props, signs, gondola and railway stations, all 18 gondolas and chairlifts in motion, boarding and riding them, day /
night lighting), **Phase 3** (roads, tunnels, car parks, your car, traffic, the ski buses, the Wolkenspitzbahn and
the Legacy Express), **Phase 4** (menus, HUD, trail map, the economy and saving), **Phase 5** (races, jobs and the
taxi, the police / prison / impound, the rescue and the hospital, chalets and build mode, people, snowmobiles, weather),
**Phase 6** (multiplayer: a C++ client for the game's Node server over wss://) and **Phase 7** (audio from the game's
recordings, visual polish, the Switch performance preset, packaging and the release workflow) are done. Where the port
stands against the JS game: "Status" near the end; what a Switch release still needs: "Nintendo Switch porting checklist".

---

## Building

Dependencies are fetched by CMake (`FetchContent`) and pinned to exact tags; nothing has to be installed system-wide
except a compiler, CMake ≥ 3.20, Ninja (optional), **Python 3** (glad generates the OpenGL loader at configure
time from the specification it ships; no network access is needed for that step), **Node.js ≥ 22.15** with the
repository's `node_modules` (`npm install` in the repo root): the exported world data is not committed, the build
makes it — and (Phase 7) **ffmpeg** to convert the game's sounds (`public/audio`, AAC) to Ogg Vorbis
(`native/data/audio`, ~1 min the first time; without ffmpeg the build warns and the game plays synthesized sounds).

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
brew install cmake ninja node ffmpeg && npm install
cmake -S native -B native/build -G Ninja -DCMAKE_BUILD_TYPE=Release && cmake --build native/build
```
macOS supports OpenGL up to 4.1 core (deprecated but working on Apple silicon); the renderer uses nothing newer.
A Metal path, if ever wanted, is a new `gfx/` backend (see Architecture).

### Windows (Visual Studio 2022)
Install "Desktop development with C++" (includes CMake and Ninja), Python 3 (python.org or the VS installer),
Node.js 22 LTS (nodejs.org) and ffmpeg (`winget install ffmpeg` or `choco install ffmpeg`), then `npm install` in the
repo root.
From a *x64 Native Tools* prompt:
```bat
cmake -S native -B native\build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build native\build
native\build\SkiLegacy.exe
```
(Phase 7: the executable is `SkiLegacy.exe`, a Windows-subsystem program with the game's icon: no console window; run
it from a terminal with `start /wait` or redirect its output to see the log.)
(or `cmake -S native -B native\build -G "Visual Studio 17 2022"` and open the solution).

### Linux
```sh
sudo apt install build-essential cmake ninja-build python3 ffmpeg libgl1-mesa-dev libx11-dev libxext-dev \
                 libasound2-dev libpulse-dev   # audio headers: without them SDL has no audio device (silent)
# Node.js >= 22.15 (nodejs.org / NodeSource), then in the repo root:
npm install
cmake -S native -B native/build -G Ninja -DCMAKE_BUILD_TYPE=Release && cmake --build native/build
```

### Packages (Phase 7)
```sh
# macOS: Ski Legacy.app (universal) in a .dmg
cmake -S native -B native/build-pkg -G Ninja -DCMAKE_BUILD_TYPE=Release -DSL_COPY_ASSETS=ON -DSL_MACOS_BUNDLE=ON \
      -DCMAKE_OSX_ARCHITECTURES="arm64;x86_64" && cmake --build native/build-pkg && (cd native/build-pkg && cpack)
# Windows (VS 2022): SkiLegacy.exe + assets/ in a .zip
cmake -S native -B native\build-pkg -G "Visual Studio 17 2022" -A x64 -DSL_COPY_ASSETS=ON && cmake --build native\build-pkg --config Release && cd native\build-pkg && cpack -C Release
# Linux: ski_legacy + ski-legacy.sh + assets/ in a .tar.gz
cmake -S native -B native/build-pkg -G Ninja -DCMAKE_BUILD_TYPE=Release -DSL_COPY_ASSETS=ON && cmake --build native/build-pkg && (cd native/build-pkg && cpack)
```
-> `Ski-Legacy-Native-Mac.dmg` / `-Windows.zip` / `-Linux.tar.gz` in the build folder (`cmake --install <build>
--prefix <dir>` gives the unpacked folder). The GitHub workflow `.github/workflows/native.yml` does exactly this on
macOS, Windows and Linux runners for every push to legacy-express touching `native/**` (and on demand) and publishes the
three files as the rolling `latest-native` release.

### Command line
| option | |
|---|---|
| `--quality switch\|super\|performance\|balanced\|high\|ultra\|superultra` (and the old `low` / `medium`) | graphics preset (Phase 8: the look, see "Graphics overhaul"; default `auto`: Balanced) (terrain LOD, shadow map, tree distances, render scale; Phase 7: texture cap / compression, triangle budget, LOD scale, NPC density, lights, simplified shaders, dynamic resolution); else the SETTINGS preset of the save. `switch` = the Nintendo Switch budget |
| `--no-menu` | straight into the game (no main menu) |
| `--no-intro` | no boot intro (the SKI LEGACY logo clip, Icecold Studio: `game/intro.cpp`, a port of `src/ui/intro.js`, `introclip.js`, `studioident.js`; any key, a click or a controller button skips it). It plays before the world loads (loading holds the main thread for seconds at a time), then the black loading screen fades up; never with `--no-menu`, `--autotest`, `--mptest`, `--verify-*`, `--rig-shots` |
| `--save name.json` | another save slot (default `ski-legacy-save-v1.json` in the platform's save directory) |
| `--spawn village\|piste` | start on the village plaza (as the web game) or at the top of a run |
| `--size 1600x900`, `--fullscreen`, `--no-vsync` | window |
| `--bindings binds.json` | rebinding, same shape as the web save's `binds` (`{"kb":{"jump":"KeyJ"},"pad":{"jump":1}}`) |
| `--neutral` | Khronos PBR Neutral tone mapping (default on Ultra / Super Ultra; ACES filmic below) |
| `--hour H` | time of day to start at (default 10:00; the clock runs 24 h in 16 min as in `sky.js`, frozen in the autotest) |
| `--autotest [--frames N] [--png out.png]` | headless check: load, ski a run for N frames, walk into a hotel (collision), board the Legacy Gondola, ride 30 s, fast-forward to the mid-station and get off; then (Phase 3) buy a car at the Autohaus and drive it 20 s along a valley road, check that a traffic car followed its lane, then the cars on the player's path (real SDL key / controller events: walk to the Autohaus, buy the cheapest car, E in, W 10 s, E out, the same with the controller; 30 s of traffic round the village), ride the ski bus, the Wolkenspitzbahn and the Legacy Express; (Phase 4) first the menus (main menu -> PLAY -> SINGLEPLAYER -> CHOOSE YOUR SKIER -> START; pause -> SETTINGS -> HUD size changed -> back), the ski shop (rent skis: money down), save + reload compared, the lift ticket and the car charged, and at the end the trail map; (Phase 5) a World Racing race started and finished (records saved and read back, back in the village), a job taken at the village board and delivered (money up), a police chase on foot into an arrest (ARRESTED, the jail timer, released at the station), a chalet bought and an armchair placed in build mode (saved), a weather change to heavy snow, a snowmobile ride; (Phase 7) the audio running throughout (with SDL's dummy driver the mixer still renders: samples decoded, one-shots, music tracks, frames mixed), the outfit applied, two night shots at 21:30 (the plaza's lamps and flags, a snow gun spraying), the `[perf]` report (CPU ms per system, draw calls, triangles, GPU memory, RSS / peak RSS, streaming); print stats, exit 0 / 1 (`out.png` + `_menu` `_showcase` `_settings` `_shop` `_village` `_ride` `_drive` `_cars` `_traffic` `_bus` `_train` `_express` `_map` `_race` `_job` `_police` `_jail` `_build` `_weather` `_sled` `_night` `_spray`). Uses its own fresh save (`autotest-save.json`) |
| `--verify-heights` | compare the C++ terrain with reference samples taken from the JavaScript world |
| `--verify-poses [ref.json]` | the skier rig (`player/skier_rig.cpp`, a port of `skier.js`) against the JavaScript one: `node native/tools/ref_poses.mjs` builds the game's own SkierRig in Node (real three.js, the rigged GLB, its clips, the skis and poles) on a test plane and replays timelines (standing, walking, running, carrying, skiing, carving with pole plants, tuck, snowplough, hockey stop, a jump, a flip with grabs and a spin, crashes and getting up, seated on a chair / bench / car seat / snowmobile; first person: the gloves-and-poles view model on a camera path while skiing with pole plants, a jump and the landing, walking with the arms folded away, a wipeout hiding body and gear; in a car: seatLegs on the taxi's fare / a passenger / another player at the wheel in a pitched, rolled car, drive.js placeRig in the cockpit and the chase view, the traffic's seated figures as CarPeople.bakeOne poses them and fill places them), writing every frame's input and, every 0.25 s, every bone's local rotation / position, the skis' and poles' transforms, the clips' playback times and blend weights (default `native/data/poses_ref.json`; `SL_POSE_CHAR=skier_blue` for another character). The C++ replays the same inputs and compares: PASS under 1 degree / 5 mm everywhere and the same timing. Then the crowd people (`player/fans_rig`, fans.js): the same script bakes the eight fan_* characters with fans.js's own FanKit and writes `fans_ref.json` beside it (`SL_POSE_ONLY=fans`: only that file): every keyframe, the rest skeleton, the hands, the legs, the carry, the jacket key, the three LODs' counts / reworked skin weights / recolour mask / sampled vertices, the village's 56 people from mulberry32(6612) and eight people replaying scripted pose inputs (standing, walking, stopping, talking, a phone, pointing, the watch, the skis on the shoulder), compared bone by bone the same way |
| `--rig-shots out.png` | the characters posed on their own, no world (`out_<what>.png`): your skier through the rig's poses, an outfit and a kit baked, everyone else standing / walking / skiing |
| `--server URL` | (Phase 6) the multiplayer server (else `SKI_LEGACY_SERVER`, else the game's `wss://138-199-163-183.sslip.io/ws`) |
| `--mptest URL [--mp-peers N] [--mp-seconds S]` | (Phase 6) the multiplayer check against a running server: the menus (PLAY -> MULTIPLAYER -> REGISTER a fresh name -> JOIN A WORLD), presence for S s (default 8), N other players seen (their avatars and name cards; a screenshot with `--png`), a ride in another player's car when one is parked, rental skis bought at the ski shop and a day pass at the ticket seller (checked against the server's own copy of the profile), chat, a dropped connection resumed, LEAVE MULTIPLAYER (the single-player save back); exit 0 / 1. Own save `mptest-save.json` |

### Headless test (Linux, Mesa llvmpipe)
```sh
SDL_AUDIODRIVER=dummy xvfb-run -a -s "-screen 0 1280x720x24" ./native/build/ski_legacy --autotest --frames 600 --png /tmp/frame.png
./native/build/ski_legacy --verify-heights
```
(Phase 7: the audio runs in the autotest too — with `SDL_AUDIODRIVER=dummy` the mixer renders into SDL's dummy device;
without any audio device the game runs silent and the check passes as "no device".)
`SKI_LEGACY_DEBUG=noterrain,notrees,novillage,noskier` switches parts of the scene off for profiling (`novillage`: the
whole resort); `sidecam` looks at the rider from the side while riding, `chairtest` makes the autotest ride a chairlift,
`vehtest` starts the autotest with the Phase 3 vehicles (skipping the skiing, the hotel and the gondola), `cartest`
straight with the cars on the player's path (see "The cars on the player's path" below), `maptest`
straight with the trail map, `p5test` straight with the Phase 5 checks.
`uitest` (with `--autotest --png out.png`) shows every UI screen in turn and writes `out_ui_<name>.png` (the trail map at three zooms, its legend and tooltip, the route pickers, then sample states of the race HUD / results, the WANTED box, the build catalogue, the shop, the job board, the racing stand, a card dialog and the menus), then quits; `SKI_LEGACY_UISTEP=<name>` starts at that sample screen (`SKI_LEGACY_UIONLY=1`: only it).
`fpview` skis the autotest's run in first person (the hands on the poles in `out.png`), `carside` looks at your car (else the nearest traffic car) from a low side view (the boots in the footwell, not under the sill).
`introtest` with `--autotest --png out.png` draws only the boot intro's frames at fixed times (`out_intro_<ms>.png`; `SKI_LEGACY_INTRO_TIMES=50,150,...` for other times) and quits before the world loads: the frames to hold against the web game's (`SKI_LEGACY_DPR=2` for the Retina layout); without `--png` it plays the intro once in real time with its sound and prints the frame rate.
`SKI_LEGACY_SHOT=x,y,z,tx,ty,tz` fixes the camera during the autotest's skiing phase (screenshots of a place).
`SKI_LEGACY_SHOTS="name:x,y,z,tx,ty,tz[,hour[,weather]];..."` holds several cameras in one run (heights above the
ground with `SKI_LEGACY_SHOT_GROUND=1`; `SKI_LEGACY_SHOT_FRAMES` frames each, default 45; written to `out_<name>.png`;
an hour and a weather id per shot: `...,8,clear;...,16.8,mist`), `SKI_LEGACY_WEATHER=mist|heavy|fog|...` starts in a
weather, settled and held; `SKI_LEGACY_DEBUG=shotonly` ends the autotest after the skiing phase (then the night
shots), `nohud` hides the HUD, `spraytest` throws the skis' full powder plumes all the time.

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
  cmake/ConvertAudio.cmake                   (Phase 7) public/audio (AAC) -> data/audio (Ogg Vorbis) with ffmpeg
  cmake/Info.plist.in, ski-legacy.sh,        (Phase 7) the macOS bundle's plist, the Linux launcher, the packages' README
    PACKAGE-README.txt                       (install / CPack rules at the end of CMakeLists.txt)
  data/  (generated, git-ignored)            world.json, crag.bin, cuts.bin, regions.bin, resort.json / .bin,
                                             transport.json / .bin, each as .zst (~28 MB); fonts/; audio/ (Phase 7, 25 MB)
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
                                             job system, asset paths + zstd data reading, log, perf (CPU ms per system)
    engine/                                  asset manager (cgltf + meshoptimizer + libwebp), models / skinning /
                                             animation, renderer (shadow map, PBR, terrain, sky, tone mapping, HUD;
                                             Phase 7: point / spot lights, bloom, screen effects, per-instance tint),
                                             audio (Phase 7: the mixer, audio.js's sound design, stb_vorbis), quality
                                             presets (+ switch), shaders, texcompress (BC1 / BC3 with stb_dxt)
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
                                             people (+ PeopleSim), snowmobile, weather, shapes; (Phase 7) scenefx (lamps'
                                             light pools, car lights and plates, snowmaking, flags, snowcats); (Phase 6) mp_session
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
origin), so 10 km from the village nothing jitters. (Phase 8 rebuilt the passes, see "Graphics overhaul": snow trail map,
IBL environment, 1-4 shadow cascades, MSAA HDR main pass, clouds, particles, glare, GTAO / shafts, mip bloom, tone map +
grade, FXAA + sharpen.) Before it: one directional shadow map fitted round the player and
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

### The mountains' rocks (Nov 2026)
Five Meshy-made rocks (`tools/meshy-rocks.mjs` -> `public/models/rocks/`: a granite boulder, a limestone block, a long
gneiss slab, a tall granite crag, a scree heap; ~2.3-4.9k triangles, 1024 px webp base colour / normal / roughness,
meshopt) replace the web game's procedural boulders on the mountains, placed by `world/vegetation.js` `rockSpot`:
crags and big bedrock slabs on the steep faces (slope > 0.9), slabs and big boulders breaking out of ridges and convex
shoulders, boulders at the tree line and in the open forest, a few off the runs on steeper slopes and very few on
gentle open ground, a talus heap with a block or two below rock walls; never on or beside the runs, race courses,
lift lines, roads and car parks (their corridors), stations, huts and buildings (pads), the village, the railways'
formations. The C++ (`world/scenery.cpp` `rockSpot` / `placeRock`) places them from the same grid points and hashes
(the 64 m cells the trees use, on the worker threads), draws them as matrix instances of the GLBs with meshoptimizer
LODs (full mesh close, 25 % to `rockR` — 80 / 150 / 230 / 300 / 340 / 400 m by preset as quality.js `veg.rockR` —,
8 % for the crags and outcrops out to twice that), shadows, and the rock shading (`shading` 4: a snow cap on the
faces open to the sky, dust on ledges, a drift banked against the foot from the terrain plane each instance carries,
damp rock above it, more snow while it snows; the terrain's snow white). Colliders as the JS: rocks showing more than
0.55 m above the snow stop the skier (a jump clears their top), lower ones are skied over; cars collide with them.
`--verify-heights` also places the rocks of 160 reference cells (`data/rocks_ref.json`, written by
`tools/export_rocks.mjs` from the game's own `genCell`) and matches them one by one.

### Known gaps (Phase 1, as updated by Phase 2)
- No huts' interiors, roads, cars, people, races, menus, economy, saves in use, network (lifts, stations and the
  village: Phase 2).
- Terrain cuts are baked data (re-export after JS changes); tunnels' covered cuts are left out (Phase 3 added the
  roads' and the Legacy Express's cuts and the courses' regions). Trees ignore cuts' forest thinning (a few trees may
  stand on the railway bed). (Nov 2026: the mountains' rocks are in, see "The mountains' rocks".)
- No freestyle tricks or park features (the physics treat jumps as plain airs), no other skiers to bump into.
- The skier's pose is a few procedural layers on the clips, not `skier.js`'s full rig (poles, pole plants,
  gloves-and-poles first-person view are missing).
- Time of day and night lights came with Phase 2; still no weather, clouds, snowfall.
- Audio is synthesised (no `public/audio` samples yet). *(Phase 7: the recordings, see below.)*
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
**The snow on the roads** (Nov 15 2026, the user: "there should be snow on the road so it's more realistic"; the roads
were bare grey asphalt): bus.js `snowCover`, the shader patch the web game lays over its road, car-park and junction
materials, is ported into the mesh shader (`shading` 8): packed snow in large world-space patches, tyre tracks worn
down to the asphalt that wander across the lane, vary in width and fade out on fully snowed-over stretches, ragged
ploughed snow along both edges, slush (darker, glossier) and bare patches; the markings and tracks fade where a road
runs into a car park (its `aEnd`, exported in the strip's vertex colour), the car parks and junction mouths get the
same snow without tracks or edges. `export_resort.mjs` tags these materials (`roadsnow-road` / `-lot` / `-mouth`). The
plough berms beside the roads are the terrain's (roads.js `berm`, in the exported cuts).

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
cockpit camera with mouse look. The **Autohaus** (carrental.js): the ten cars for sale stand only inside the hall, on their
turntables and on the mezzanine (see "The Autohaus, 1:1" below): E at its sliding doors, then E at a car; the car you
buy waits in a bay of the car park beside the hall, yours to drive; every other parked car says where to buy one.

**Traffic** (`game/traffic.cpp`, traffic.js): 12 cars on the valley roads + 6 on the scenic network (models drawn by
cars.js's spawn weights, seeded), each on its right-hand lane at speedlimits.js's target times its driver's factor,
braking for the bends ahead, following at a time gap (`followV` / `lookFor`), stopping for you, your car and the buses,
turning at junctions onto the car parks' access roads, parking a while and driving out again, turning round before a
bus stop's dead end (the lane offset carries it across), lane offsets steered (`toRoad`), knocked aside when hit;
about six kept round you, recycled out of sight. **Parked cars**: parking.js's 102, solid.

**The cars on the player's path** (a later fix, after "cars don't work" on the Mac build): **E** beside your car to get
out put you straight back in (the same press was also read by the "Drive ..." prompt that the frame showed once you
stood beside the car), so you could never leave it — the press is used up now. The traffic keeps traffic.js's
bookkeeping: what is "in sight" is judged by the camera's facing (it was the direction the camera last *moved*, so a
camera at rest froze it), the far cars come back 150-420 m round you out of sight and clear of the others (`recycle`),
at the start every other car is parked and later 6 in 10 come back parked, trips end out of sight, a car without
headway for 5 minutes is parked elsewhere, the scenic network's cars stay on it; all 18 cars on every preset, the
preset's traffic share (`npcScale`: switch 0.5) setting how many are kept round you (`NEAR_WANT` 6 x the share, at least
2). **People in the cars** (carpeople.js): a driver at the wheel of every car that drives within 70 m, a front passenger
45 % of the time, one or two in the back 22 / 8 % (none in the two-seaters), the game's skiers seated on each model's
measured seats (`SEATS`); parked traffic cars are empty. The sale card says **Not enough money** (you have $N) / **Garage
full** on its buy button, as ui/carrental.js does: a new save's $500 buys no car (the Golf GTI is $11,250, the jobs
and the races pay, as in the web game). The autotest checks all of it the way a player does it (`game/cartest.cpp`,
after the Phase 3 drive; `SKI_LEGACY_DEBUG=cartest` alone): every input is a real event pushed through SDL
(`SDL_PushEvent` key events; an SDL virtual game controller for the pad), the menus reading the real keys too — walk
from the plaza to the Autohaus with W A S D and Shift (relative to the camera), **E** at its sliding doors, round the
cars on show to the cheapest one (the view turned at it: the test's stand-in for the mouse, `Player::setLook`), **E**
(the configurator on that very car, the camera on its turntable), its price granted, **Enter** on "Buy it" (money down
by the price, the car in a bay), back to the doors and **E** out, walk to the car in the car park, **E** in, **W** held
10 s steering with **A** / **D** out of the car park and along the road (> 40 km/h), **S** to a stop, **E** out; then
the controller's **X** in, **RT** 5 s with the left stick steering, **LT** to a stop, **X** out; then 30 s on the
plaza: at least 3 traffic cars driving 15+ m within 300 m of it (drawn: within the 300 m draw distance), the parked
cars and buses there counted, a screenshot (`_traffic`) beside the nearest one with its driver (`_cars`: the drive).

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

### The Autohaus, 1:1 (`game/showroom.*`, Nov 2026)

`carrental.js` sells cars in one place only, inside the hall; so does the C++ now (the row of sale cars in the car
park is gone; `Drive::Parked::forSale`, `saleIndex`, `buyRequest` with it). What `game/showroom.cpp` adds to the
exported room (`export_rooms.mjs`, `Interiors::Room::Autohaus`):

- **Going in / out** as `carrental.js` `interaction` / `enter` / `leave`: the prompt "Autohaus" within 2.6 m of the
  sliding doors (not anywhere near the hall), a fade; out again 0.8 m in front of the doors, facing the road.
- **The cars on show**: each in its display paint (in that paint's finish) with a canton plate (`setPlates`), the price
  stands; the crosshair on one within 7 m: "Buy <car>" (a model you own: "<car> · yours: n · buy another · take it
  out · sell"); the cars upstairs only from up there. You are not drawn in the room (its own scene in the web game).
- **The configurator on that car** (`carrentalroom.js` `configure` / `orbit` / `cfgCamera`, hooked to
  `CarCfgView::preview` / `drag`): the camera leaves your eyes for the car's turntable, per step from `SHOT` (paint,
  wheels, plate from behind, summary), 45 degrees, a slow drift, drag to turn, kept inside the hall and under the
  mezzanine / the roof, the car framed right of the panel (the web's view offset: the camera turned by the same
  amount); every click repaints the car, tints its rims (`RIMS`: the wheels' metal, tyres and brakes stay black) and
  puts your plate on it. What you buy keeps it: `Save::Car::rims` (saved as `rims`, as the web save), the paint's
  **finish** (`FINISH`: roughness, metalness, clear coat) and the rims on your car outside too
  (`VehicleModels::dressed`, `Drive::dress`).
- **The salesman** (`clerkDialog`): turns to you within 6 m; E: "Autohaus · Salesman": **Car of the day** (one of his
  three lines with the price; a gold arrow bobbing and turning over that car and a ring round it for 45 s or until you
  open it: `guide`), **Repair my car** $500 flat for your car that is out (the reasons it is refused as the web's),
  Bye.
- **The sliding doors** open as you come in and when you walk up to them (`setDoors`, eased), each leaf its own model.
- **The floor**: the web game lays its stone tiles 80 % opaque over a `Reflector`. Here the hall, the cars, their
  plates and the windows' view are drawn a second time mirrored under the floor (double-sided copies of the models:
  mirrored triangles wind the other way) and the tiles, still 80 % opaque, over them. No renderer change.
- **The view out**: live through the glass, as the web game's (`game/window_view`, see "The windows' view" below):
  the yard, the tow trucks, the road's traffic and the mountains from where you stand in the hall, the hall itself
  left out; in the polished floor once more upside down, as the web game's Reflector shows the window planes.
- **Outside**: the three tow trucks (`towtruck.js buildTowTruck`: the 508 D with its star and beacons, exported) in
  their TOW bays with their colliders, the potted spruces either side of the door (the exporter loaded no
  `pine_tree` before), the cars on show seen through the glass as real car models in their paints.
- **Metal in the room**: the renderer lights interiors without an environment map, so bare metal turned black (the
  Tesla on show, the turntables' steel rims): display cars stand in their paint's finish, the room's steel trims are
  exported mostly diffuse. The cars' alloy wheels still read darker than in the web game.

`SKI_LEGACY_DEBUG=autohaus,shotonly` with `--autotest --png out.png` writes `out_<name>.png` from the web reference
shots' viewpoints: outside (front, left, right, the door, the tow bays), in the showroom (the way in with the doors
open, the windows, the floor, the salesman, a car, the stair, upstairs, the marker, the salesman's talk) and the
configurator's steps (`SKI_LEGACY_CAR=<model>`, `SKI_LEGACY_PAINT=<id>` for another car / paint).

### The cockpit, 1:1 (Nov 2026)

Checked car by car against the web game (`SKI_LEGACY_DEBUG=cockpittest,shotonly` with `--autotest --frames 2650 --png
out.png`: every Autohaus model parked in a bay, `out_<car>_<view>.png` ahead / down at your hands / left / right /
back / the wheel turned / the chase view; `SKI_LEGACY_CAR=<model>` for one car; it logs your eye point in the car's
frame). The eye point (`drive.js placeRig` `d.eyeRig`) agrees to the millimetre in all ten cars, the views overlay.
What differed and is ported now:

- **The steering wheel turns** (`drive.js updateBody`: -steer x 3 about its column, ~100 degrees at full lock). The
  web game splits the wheel's triangles off the model (`cars.js splitWheels` / `findSteering`: by name, or by shape
  round a hint); the exporter writes their middles per car (`net.cars[].steer`, also for the `_full` models), the C++
  takes exactly those triangles out of the body when it splits the road wheels (`VehicleModel::steer`) and
  `VehicleDraw::addCar` turns them. All ten cars and the three `_full` models: every triangle found again.
- **The hands hold the wheel where it is**: the web game takes the wheel's centre, rake and rim radius from the
  model (`t.steering`: rake 0.25 in the GLS .. 0.54 in the sports cars, rims 0.16 .. 0.19 m); the C++ took the centre
  from the seat hints' table and one rake / radius for every car. Now the exported values (`CarTemplate::wheel`): the
  Tesla's full model sat you 6 cm too far forward (its hint row's wheel is not the one the web game measures), and
  the hands were off the rim in the cars with a steep or a flat column. The traffic's drivers too.
- **The field of view** follows SETTINGS' FOV in both car cameras (72 / 62 + setting - 65), as `drive.js`.

Not ported: the web's dome light (`cabinLight`), the interior trims, the Tesla's lit screen graphic.

### The trains from inside, 1:1 (Nov 2026)

Compared with the web game from the seat and from six cameras standing in the car, in both trains
(`SKI_LEGACY_DEBUG=traintest,shotonly` with `--autotest --frames 5250 --png out.png`: the Wolkenspitzbahn boarded at
the valley station, then the Legacy Express: `out_rail_<view>.png` / `out_express_<view>.png`: ahead, left, right,
hard left, down, up, across the aisle; `w_fwd` / `w_back` along the aisle, `w_bay`, `w_rear`, `w_ceil`, `w_floor`;
`moving` under way and `tunnel` in the first tunnel). The cabins themselves (`train.js buildCar`, the Express's Meshy
seats, tables and racks: `expressinterior.js`) were exported already and stand where the web game's do. What differed:

- **You board into the seat view** (`railway.js` / `express.js` `board`: `view = 'seat'`; R: outside). The C++ put you
  in the chase view, so the cabin was a key press away.
- **The seat camera** is the web game's: the eye 0.76 m over the seat in the **car's own frame** (it leans with the
  car on the grade and in curves; it was a world-up camera at the player's position), you look round to the side
  windows (+-100 degrees, pitch -0.9 .. 1.0), the head leaning forward and away from the pane as you turn, 72 degrees
  (was 68), no easing back.
- **The passengers** (`railway.js seatPassengers`): skiers on 21 to 27 of a car's 48 seats, never the rider's front
  row, in `seatpose.js`'s relaxed poses (hands on the thighs, in the lap, arms folded, over a phone), the head turned
  to the window or the neighbour. The exporter runs the web game's own seeded choice (seat, look, pose, turn, size),
  so the same skier sits in the same seat; the C++ poses them with its port of `poseSeated` (`CarSeatRef::Bench`) in
  the seat's frame. The Express carries the same passengers (`copyPassengers`). Single player only, as the web game.
- **The surfaces' textures**: `train.js cabinPatch` textures the cabin in its shader (the wall panels' mottled plastic,
  the woven fabric, the floor's speckle, the ceiling's perforated panels, brushed metal: one data texture, triplanar,
  tiles per metre by a per-vertex kind). Shader patches are not captured, so the C++ cabin was flat colour.
  `tools/train_detail.mjs` bakes the same texels through the same mixes into one tiling map per kind and gives each
  face its main axis's coordinates.
- **The cabin's own light** (`uCabin`: 0.3 by day, up to 1.2 at night and in a tunnel): the light strips' emission
  follows it and four warm lamps along the ceiling of your car carry the light in a tunnel (the cabin was black
  there).
- **The windows from inside**: `glassIn` is a 13 % tint; the renderer's glass mirrored the sky at full strength on it
  and lit it with the sun (milky panes on the sunny side): no mirror on the inner panes, a quarter of the tint.

- **Walking about in the Legacy Express** (`express.js updateWalk` / `standUp` / `sitDown` / `walkCamera`,
  `game/train_views.cpp`; the web game has it in the Express only): **E** stands you up into the aisle beside your
  seat (prompt "Stand up") and sits you down on the nearest free seat within 1.6 m ("Sit down"; a seat a passenger has
  is not free); at a stop on the way, where E is for getting off, it is **F**. W A S D / the stick walk relative to the
  camera at 1.6 m/s (Shift x1.5) in the car's own frame, so you stay on the moving train; you slide along the seat
  pairs, the tables, the glass screens and the walls (`walkBoxes` / `walkMove`), from the rear wall to the cab door,
  in the car you boarded. **R** switches between the orbit round you (pulled in at the walls, the ceiling and the end
  walls) and your eyes (1.6 m over the floor), 70 degrees. In third person your skier walks on the car's floor.
- **The chase camera in tunnels** (`railway.js` / `express.js applyCamera`): the old outside camera kept its orbit and
  went through the tunnel lining and the mountain. Now, as the web game, wherever the orbit's sight line or the
  camera itself would be in the rock (a tunnel within 60 / 70 m, a cutting, a shoulder) it follows the track just
  behind the last car: on the tube's axis 4.6 m over the rail in a tunnel (rigid there), 7.5 / 8 m in a cutting, and
  keeps doing so 1.2 s after the way is clear. The mouse swings the orbit, the wheel zooms (14-70 m, the Express
  18-110 m); it no longer eases back by itself.
- **The camera beside the line** (`express.js trackside` / `pickSpot`; the Express's third view: R goes round seat,
  outside, trackside, as `VIEWS`): it waits on the embankment 170 m and more ahead (beside a viaduct: out from the
  deck), alternating sides, follows the train going by with a long lens (16-62 degrees: the set about a third of the
  frame), and moves on once the train has passed, the view is blocked for 0.6 s or the train is 1.1 km off; in a
  tunnel there is no spot: the chase camera. The web game shows no hint for it and uses the view key / button (R),
  so does the C++.

Not ported: the Express's live trip display (the screens over the cab door show the Wolkenspitzbahn's line map in both
trains), the passengers' phones, the people waiting on the platforms, getting off the Express at a stop on the way,
the station-roof rule of the Wolkenspitzbahn's chase camera. In third person the walker is drawn as one of the
resort's skiers in your character's suit, not in your own outfit.

### Known gaps (Phase 3)
- **Courses' regions** come as an 8 m grid (mean 0.48 m, max ~4 m off the JS inside the regions, exact on roads and
  roadbeds); the courses themselves (gates, ramps, props) are Phase 5. Outside the regions `--verify-heights` now
  reads up to 0.24 m on `height` (the roads' benches and berms between 2 m grid points; `meshHeight`, the physics
  surface, is still exact to 2.5 mm). The data grew to ~107 MB (regions 13 MB, cuts 13 MB, transport 58 MB): to be
  compressed / baked for the Switch package (Phase 7).
- **Cars**: no moving wheels or steering wheel, no dents (damage is a number), no headlights / tail lights / light
  pools (the L key only toggles the flag), no engine / tyre / horn sounds (audio is Phase 7), no tyre tracks *(Phase 7:
  wheels, lights, light pools, sounds, paint and plates done)*; the
  cockpit view showed the car's own interior only as far as its GLB has one (the `_full` models, your seated body with
  its hands on the turning wheel: done since, see "The cockpit, 1:1"); paint colours of the parked / traffic cars are the models' own; the Werkstatt, the tow truck's job, police, taxi and bad
  drivers are not ported (Phase 3; later phases and "The Autohaus, 1:1" below port most of them).
- Knocked poles, signs, lamps and broken guardrail sections lose their colliders for 90 s but stay drawn.
- **Traffic** turns into a car park bay and out of it without the arcs (it appears in / leaves the bay), the scenic
  roads' cars drive them as ordinary roads (no `scenicWalk` round the roundabouts), no tow zones, trains / helicopter
  blockers, no swerving past a car stopped in the lane, no cars put ahead of the bus you ride (`aroundBus`); *(later:
  people in the cars, see "The cars on the player's path")*.
- **Buses**: they overtake and push through as bus.js (clearAhead / steerShift / poseBus / ramContact: stop short of what stands in the lane, the horn, pull out round it after 3 s when the other lane is clear, drive on through after 20 s), but the people about (NPC skiers, villagers), the trains and the police / tow vehicles are not among their obstacles yet; the fleet runs bus.js's slotted timetable (exported, see Phase 6 "The ski buses on the shared timeline"), no
  passengers or driver, no turn-round fade at intermediate stops (the seat view inside the Micruss and the R chase
  view are there).
- **Trains**: the Express wears the Wolkenspitzbahn's red (no Legacy blue livery: *Phase 7 paints it blue*), no seated passengers; the default
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
  preset needs a restart; music volume, bloom, camera shake and screen effects are stored but have nothing to drive yet
  *(Phase 7: all four drive something now)*;
  no virtual mouse.
- **Shops**: ~~one card dialog instead of the walk-in ski shop and the outfit shop's 3D podium~~ *(the walk-in shop,
  the podium and the kits: see "The rooms, inside and outside, as the web game")*; outfits are bought and
  stored but not yet applied to the skier's materials; the skis' speed / grip don't change the physics yet
  *(Phase 7: outfits shown, ski stats in the physics)*.
- **Cars**: the configurator has no interior step (trims); the tow trucks stand in their bays but do not drive out
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
medal), the prize, career stats; OK and a fade back to Legacy Village (modes.js exitFree). **The AI field** (`game/race_bots`, bots.js + aistate.js ported): the course model (racing line as an elastic band inside
the track and the gates' windows, each racer's own plan, curvature and ground profile), the field of 14 calibrated against
the ideal player's reference run (twelve halvings per racer on a 1D run with the live physics), the live racers at a fixed
120 Hz step (lateral speed and acceleration bounded by the edges' grip, gravity from the real height change, drag, the
tuck, skating out of the start, take-offs and landings), race craft (traffic, overtaking lanes, side-by-side spacing,
mistakes, the +-3 % rubber band), the start grid, the racers' separation and the shoulder contact with you, parking lanes
and the hockey stop after the line (session.js). Each racer has its own skier rig posed from its own motion (AISkierAnim:
edge from the lateral acceleration, crouch, tuck, pole plants at the turn transitions, double-pole pushes), every frame
within 30 m, at 30 / 15 Hz beyond (carried rigidly in between). **The gates** carry their red / blue flags (the
instance colours are baked by the exporter) and gatebars.js's striped ribbon between the poles: green ahead, the next
one pulsing, grey once passed, red when missed. **The race guide** (raceguide.js): off the bus or a train at a stop with a race within 600 m
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

**The helicopter, the rescue, the ambulance, the ward** (`game/heli`, `heli_flight`, `rescue`, `ambulance`,
`hospital_ward`, `player/skier_rig_bed`: heli.js, heli/flight.js, model.js, pad.js, zones.js, hud.js, fx.js, rescue.js,
ambulance.js, hospitalroom.js, ported one to one). `export_play.mjs` runs the game's own modules and writes what they
build: the helipad (the deck with its painted H and its snowy rim, edge lights, the heli-ski hut and its sign, the mast,
the windsock, its colliders and walkable deck), the helicopter's parts (the Meshy airframe with its static rotor head
cut away by model.js, the mast, the ski basket, the main rotor's hub and blade, the tail rotor, the two blur discs with
their painted textures), FRAME / ANCHORS, the drop zones and the race courses' landing spots, the ambulance's fit and
its way to the medical centre (Ambulance.plan + setPath), and the medical centre inside as hospitalroom.js builds it
(one mesh with its painted textures: floors, panelled walls, ceilings and beams, the windows' frames, curtains, sills
and radiators, the glass doors, the bed-head units, boards and signs; the Meshy furniture as placed; the window / door
panes; what the walker bumps into; the chairs; the mattress tops measured on the bed model).
- *The flight model* is flight.js (Flight, HomePilot, autopilot and its terrain look-ahead): the same numbers and order
  of operations, so the rescue lands on the same spot, at the same heading, as the web game's.
- *The model*: the airframe at the flight's attitude (Euler YXZ: pitch, yaw, roll), the main rotor spinning clockwise
  seen from above at 26 rad/s x rpm, the tail rotor about its own axis at 120 rad/s x rpm, the blades drooping at rest and
  fading into the blur discs as it spools up (no crisp blade shadows above 45 %), nav lights, beacons and strobes, the
  downwash's powder cloud close to the snow.
- *Heli-ski*: E on the pad or at the hut's door opens the flight planner (ui/travel.js's chart, `TrailMap::heliTravel`: the
  drop zones by distance, the race courses' landing spots, a free flight; $1,500; without skis a notice, short of money
  FLY refuses); you sit in the pilot's seat; W / S speed, A / D
  turn, Space climbs, Shift sinks, the mouse looks round the chase camera; the turbine spools up (~5 s), the ground
  cushion sets it down; "Land here" / "Too steep to land" / "Trees below" / "Lift line below" / "Too close to buildings"
  from the spot below (it holds a hover over what it may not land on); E gets you out beside the door (landed) or jumps
  you out (hovering under 6 m over a slope too steep to land on); the landed helicopter waits, idling 25 s (E beside it
  flies on, free), its pilot flies it home once you are 650 m away or from the pad's prompt; the flight panel (km/h,
  height, climb arrow, the rotor bar while it spools up), its prompt, the controls card; the compass on the drop zone.
- *The rescue* (the second wipeout, or a vehicle hit at 45+ km/h: free) is called at the crash: you stay lying where
  you fell (the fall's own get-up waits). The helicopter flies in on its glide path, picks flat open snow within 33 m
  (slope, trees, colliders, lift lines: pickSpot) and lands with its right door toward you, a fade and you are in the
  passenger seat; in the trees or on a steep slope it hovers and winches you up. The shot from the snow beside you, then
  the chase camera; the pad; the ambulance waiting beside it (blue and red light bars flashing) takes you along the
  Rettungsweg with its own shot and chase camera, steering round what is in the way, to the medical centre's canopy;
  the bill ($300 + $25 per earlier rescue, at most $1,000; a vehicle's fault: free). Hold Space: four times as fast.
  Watchdogs (150 s to be picked up, 45 s without getting closer) take you straight to the medical centre.
- *The ward*: you wake up in bed 2 behind the fade: the eyelids part, blink and open over 3.6 s (the web's keyframes),
  a warm haze clears; your body lies flat on the mattress (bedArms: the arms by the side, the legs along the bed), the
  view from the pillow (the mouse turns the head; the view key: from beside the bed); the RECOVERING card with its
  clock (20 s), then FIT AGAIN and E gets you up; the visitors' chairs (E sits / stands), the way out through the glass
  doors to the forecourt ("Get well soon"). E at the door outside visits. The windows and the glass doors show the
  village live, as the web game's LivePortal (`game/window_view`): the forecourt under the canopy through the doors,
  the snow and the trees behind the house through the ward's windows.
- Debug runs (with `--autotest --png out.png`, a screenshot per stage and the checks logged, `[helitest] PASS`):
  `SKI_LEGACY_DEBUG=rescuetest` (a wipeout on the mountain, the landing, the flight, the ambulance, the ward, out of the
  doors; `SKI_LEGACY_SPOT=493,-393`: the wipeout on a steep slope instead, so it hovers and winches you up), `ambtest` (from the pad on), `wardtest` (the ward only), `helitest` (the base, the planner, a flight, a
  landing, getting out), `helicheck` (no skis / no money at the desk, the chart with a race course, the drop zone's
  smoke, the skis in the basket, jumping out of the hover with the drop, the pilot flying home, leaving it 650 m behind,
  calling it back, both watchdogs, a visitor's chair, leaving mid-rescue and coming back); `--hour 22` for the night; with `,fadetest` added the real fades run.

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
within 220 m, the lighter LOD past 35 m, shadows within 40 m. **The townsfolk** (`game/townsfolk.cpp` + `player/fans_rig`,
townsfolk.js / peoplesim.js / fans.js): the village's 56 people are fans.js's crowd people, not skier rigs: each fan_*
character baked as FanKit does it (the 20-bone skeleton, the hands' axes and grip measured from the mesh, the Meshy legs'
bind look, every keyframe posed with fans.js's two-bone IK: relaxed stances on either leg, hands held / on the hips, the
twelve phases of its own walking cycle at 1.16 m a stride, talking with the hands, a phone, pointing, a shrug, a glance at
the watch, skis carried over the right shoulder; the three LOD meshes with the arm weights reworked by geodesic distance
(separateArms, cleanWeights), the recolour mask and the jacket's own hue), each frame a normalized quaternion blend of a
few keyframes (walk phases by speed, the weight shifting leg to leg standing, gestures in their own rhythm while talking,
held poses eased in and out) with the head turn split over chest / neck / head; the jackets recoloured per person
(chroma-keyed in the mesh shader, the folds kept), the textured LOD within 18 m and the vertex-coloured ones to 50 m and
170 m (screen-door cross-fades, fading in at the doors), posed every frame near and every 2nd-8th frame further out, a
soft contact shade under each (multiplied onto the snow), no shadows; the characters, sizes, personalities and colours
from townsfolk.js's own mulberry32(6612) draws. Their village: plans (off to the gondola with the skis on the shoulder,
back from the slopes, the market stalls, the fire pit, the tree with a phone, the trail map pointing out a run, the
ticket booth, the shop's window, the bus stop's waiting area), a third in twos, people stopped together chatting, the
path ring round the tree, walking round each other, you, the lamps and walls (peoplesim.js), fewer at night; thrown by
your car (the rigid throw: somersault, bounce, tumble, lying, getting up). Skiers carving down the pistes near you are
Npcs'.

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
- **Races**: no ghosts (the time trial mode is gone in the web game too); of the broadcast presentation the payoff is
  ported (`game/race_cine.*`: the replay buffer, the podium with its confetti and orbit, the results over it, WATCH
  REPLAY behind the brush stinger with the trackside / heli / chase / finish cameras and slow motion, back to the
  results; `SKI_LEGACY_DEBUG=racetest --autotest --png out.png` plays it out and writes `out_rt_<stage>.png`), the intro
  flyover and the photo finish's / big airs' world slow motion are not; the trackside camera does not know tunnels /
  bridges (the course features are not exported); no far stand-ins for the racers (rigs to 400 m), no snow spray / tracks behind them, no
  floodlit night course (the masts are exported, the night and their light pools are not set up), no RACE AGAIN; the course meshes stand everywhere (the web game builds them within
  1.7 km); the low-poly spectators of props.js are replaced by the character crowd.
- **Jobs**: the people are drawn but have no lines of dialogue beyond the flash texts; the guest follows a simplified
  trail; no pack fitting to the jacket (a box on your back); no job board notice-board UI (the card dialog); the taxi's
  passengers don't sit visibly in the car and walk straight to the door; no lost & found.
- **Police**: no roadblocks or spike strips, no PIT / T-bone choreography beyond aiming at the rear quarter, no radio
  road names (compass only), no siren audio (Phase 7), no chalet raids, no slow motion; patrol cars don't brake for the
  bends or avoid obstacles off the roads.
- **Interiors**: the ski shop, the chalet (both floors) and the police station are the web game's own rooms now, with
  their windows onto the world (see "The rooms, inside and outside, as the web game"); the build mode furnishes the
  chalet's ground floor only.
- **Helicopter / rescue**: the landing light's
  pool is a spot light on the snow and a faint cone (not model.js's draped decal); the drop zone's smoke drifts on a
  steady breeze (the windsock stands); the wall clocks stand; the ambulance looks round at the cars and what is solid
  near it (no speeds of what it meets); multiplayer: other players' rescues (net/rescue.js `veh` rows), patients and
  visitors are not shown or sent; a rescue is carried on after you leave and come back in single player (the save's
  `rescue`), not from the server's profile.
- **People**: shared pose phases (no per-person IK, head tracking or getting-hit animation); no railway station people.
  The townsfolk are fans.js's crowd people (above), but the race spectators (crowds.js: cheering, flags, cowbells) are
  not; nor townsfolk.js's people at the other lift bases / bus stops; a villager knocked over near you gets the rigid
  throw, not peoplehits.js's SkierRig ragdoll (crowdFall).
- Snowmobiles are free to take (as snowmobile.js: no rental counter); the rider uses the seated rig, not skier.js's
  handlebar IK. (`-DSL_COPY_ASSETS=ON` lists every model the game loads since Phase 6.)
- The trail map shows no races, jobs, chalets or the police yet.
- Not ported yet: snowcats and ploughs, snowmaking spray, flags, the parkour mode, multiplayer bits of all of the above.

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

**Linked like the JS (Nov 2026, round 4)**: the Legacy Express's speed profile is exported at full precision
(`express.V64`): its loop is the web game's to the nanosecond, so at the same server time every client places every
train at the same spot (before, the float profile drifted 60-325 m off after ~10^6 loops of the server clock). The
others riding a train / the Express sit in their seat of the car as drawn here (`seatWorld`, no lagging presence);
on a ski bus too (the buses are on the shared timeline since: see below). Riding a
bus / train your skis are stowed and the seat view shows your own seated body (head folded away). The police come at
road speed (police.js vRoad x the rubber band, 25 m/s over the snow) and turn round on a road leading away; every unit
sent out is logged (`police: unit N out ...`, the chase every 5 s). Ramming a bus calls the police like any vehicle.
The user's rule: riding in a wanted player's car you are wanted with them (their stars, the WANTED box), and stay
wanted on your own after getting out until you escape or are caught; still aboard when they get away, so do you; the
stars go in your presence row (the others' name cards show them). A race's start takes you off any ride first (a car,
the bus, a train, a lift, the snowmobile, the helicopter, an interior); the results screen shows the server's prize
when it arrives; the race card shows the server's 14-racer cap and its join window (30 s). `profileSet` now also
sends `pos` (your last outdoor spot), `wanted` (a chase under way, carried on at the next login) and `rescue` (null);
your snowmobile goes out as `veh sled` (driving, then where you left it).

**The ski buses on the shared timeline (Nov 2026)** (`game/buses.*`, bus.js buildFleet / fleetDrive / updateFleet and
the multiplayer part, net/transit.js busGate / busTry, server.js busHold): the fleet's timetable is the web game's own,
exported at full precision by `export_net.mjs` (transport.json `fleet`: per bus its round `R<n>`, cycle, phase and its
two ways as `fleetDir` built them: the joined trips, the speed profile, the stops' marks, the knots in double
precision; bus 0's bay at the depot). Where a bus is is a function of the clock alone (single player: the fleet's own
clock, as the JS; online: each round's shared timeline `bus|R<n>`, `lineTime`), so a native and a web client place
every bus at the same spot. Near you a bus drives itself (`fleetDrive`: the timetable less a delay of its own while
held up, catching up after, LATE_HOLD at a stop it got to late, two at one stop queued one behind the other,
overtaking / pushing through as before); online a bus held up near you is reported (`busHold`, every 250 ms, cleared
once on time) and everyone else places it from the server's record (`holdAt` / `followStep`, eased); a client that
sees it run into something there takes it over (`mustTake`); the records standing are fetched on joining
(`busHolds`). Online you wait at the stop (E, a destination: "Ski bus to X · next bus in 2:10"; 25 m away cancels) for a
real bus that goes your way and get on once it stands there with 4 s left (`mpBuses`), in the seat the server gives
you (the others see you in that seat of that bus: `seatWorld`, seat ids `bus:<n>`), and ride it on its round until it
stands at your stop; SPACE speeds up the round's timeline while everyone aboard holds it (`skip` with `line R<n>`). Bus 0
(single player's own bus, in its depot bay) is out of the game online, as in the JS. The other players on foot and their
cars are among the buses' obstacles. `SKI_LEGACY_DEBUG=mplive`: `bus <from> <to>` (wait at a stop), `buslog`, and a
`[buslog]` line every 5 s of server time (every bus: x, z, speed, heading, stop, the hold-up records). Checked live on
a local server with two native clients and the web client (its fleet logged right after its own `updateFleet`): every
bus within 0.02 m (median) of the same place on all three at the same server time, 244 of 252 samples within 5 m
while one native player stood in a bus lane (the buses stopping, honking, overtaking, the three clients each driving
and reporting hold-ups the others followed); a native and the web player boarded the same bus at the village and each
saw the other seated in it ("Seat 1 / Seat 5 of 20 · 2 aboard"). The headless web client ran at ~4 fps (its frame step
capped at 50 ms), so the buses near it ran in slow motion there; the hold-ups carry that over to the others.

### Known gaps (Phase 6)
- **No world picker**: the protocol has none (the server assigns the fullest world with room); the MULTIPLAYER screen
  shows the server's world / player counts instead.
- **Accounts are name + server-issued token** (the JS game's scheme; there is no password to type). On Switch the
  name field wants the software keyboard applet (here: typed, or the suggested platform user name).
- **Races online are practice races** (`raceSolo`): the server's race queues (2-21 racers, the synced start, the live
  board, the results card with prize money) are not wired to the native race session yet.
- **Shared timelines**: the trains, the gondolas / chairlifts and the ski buses are on them (the buses: see "The ski
  buses on the shared timeline"); a full bus lets you ride standing instead of queueing you for the next one, and the
  native transit fingerprint (`tt`) is still `native-phase6`.
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

## What Phase 7 ports

**Audio** (`engine/audio`, a port of `src/core/audio.js`; behind `Platform::openAudio`, one 48 kHz float stream).
- **The recordings**: `public/audio` (the web game's AAC `.m4a`: 50 sound effects, 26 announcer / station-PA lines, 18
  music tracks; licences in `CREDITS.txt`) are converted by the build to **Ogg Vorbis** in `native/data/audio`
  (`cmake/ConvertAudio.cmake`, ffmpeg: mono q3 for effects and voice, stereo q1 for music; only new / changed files;
  ~1 min the first time; 25 MB) and decoded with **stb_vorbis** (the pinned stb commit, compiled once as C). No AAC
  decoder in the native build (licences / patents; one codec on every platform incl. the Switch). Without ffmpeg the
  build warns and the game plays the synthesized fallbacks, as the web game does until its files load.
- **Mixer**: sfx / music / voice buses -> master (`volume`) -> glue compressor (-12 dB, 6:1, 4 / 220 ms) -> the web game's
  soft clipper; the announcer ducks the music to 0.42 (and a close siren another -3 dB). Voices: samples with pitch,
  low / high pass (RBJ biquads), delays, sprites (the variations inside one file: `step`, `land`, `crash_car`...,
  `SPRITE_GAIN`), loops crossfaded into themselves (`loopify`), synthesized tones / filtered noise bursts / sweeps
  (`tone`, `burst`, `sweep`: every fallback of `play()`); continuous instruments: the police / ambulance two-tone
  siren, the helicopter rotor (brown noise chopped at 19 Hz + turbine whine), the snowmobile's two-stroke, the electric
  car (motor + inverter), the starter whir, turbo whistle, tyre squeal, the car horn. Commands and parameter snapshots
  go to the audio thread under one short mutex; finished music decoders are freed on the game thread.
- **What plays**: skiing (`setState`: the carve / scrape / powder loops by speed, edge, sideslip, ice and deep snow, the
  wind rush by speed (louder in a tuck / in the air), the mountain ambience by altitude, snowfall and the weather's
  wind), footsteps (the 20 `step` takes), pops, landings (the snow crunch + body thump + sub weight by impact), bumps,
  crashes (`bodyfall_heavy` + `snow_burst`, "Wipeout!" in a race); the car (`setCar`: the recorded engine loops
  `eng_<profile>_<i>` crossfaded equal-power and pitched by the rpm, per drive.js `sound` profile v8 / gti / i6 / i4 /
  v10 / i3t / v8s with the aliases; load filter; the starter recording timed to drive.js's crank; pops on gear changes,
  overrun crackle, blow-off; the electric cars' synth; the cabin low pass in the cockpit), doors, impacts by surface
  (`impact`: car, tree, building, rock, metal, net, snow: the recordings layered by amount), `carCrash`, guardrails;
  the **air horns** of the bus (two-tone, `bus` / `bus2`) and the trains (the Typhon chord, `train` / `train_short`)
  rendered once at start-up from `hornSpecs` (pulse trumpets a few cents apart, drive, formants, scoop / sag, hiss,
  "pfff") with the valley's echo, sounding as a bus pulls out of a stop / a train leaves a station near you; lifts
  (`lift_clunk` boarding, the motor hum riding); the police siren on the nearest chasing patrol car and the ambulance,
  the police / rescue helicopters' rotor (positional); the race's beeps, gate dings, misses, the finish, the crowd and
  the **announcer** (3-2-1-GO, checkpoint, first / second / third / personal best, gold / silver / bronze) and the
  Wolkenspitzbahn's recorded **PA** (departure up / down, arrival at Wolkensee / Wolkenplatt / the village, after the
  three-tone gong); menu ticks and clicks; cash / error at the till.
- **Music**: per context (`menu`, `freeride`, `race`, `results` (`results_win` once, then the loop), `chase` while you
  are wanted), weighted shuffle never repeating the last few, crossfades of 1.4 / 2.5 s, `MUSIC_LEVEL` / `TRACK_GAIN`;
  streamed from the Ogg file in memory (one decoder per deck, resampled to 48 kHz).
- **3D**: positional one-shots and instruments use Web Audio's `inverse` distance model (refDistance / rolloff),
  equal-power panning from the camera's right vector and air absorption (a low pass past 30 m).
- **Settings**: master / music / sound effects / announcer volumes (`voiceVolume` is a new SETTINGS row), "Mute in
  background" (`Events::focusLost` / the new `focusGained`), the pause fading the continuous sounds.

**Visual polish.**
- **Car wheels** (cars.js `splitWheels`): at load the cars' GLBs are kept on the CPU once (`ModelLoadOptions::keepCpu`)
  and each is split into a body and four wheels (centres from the meshes / materials named like wheels per quadrant,
  else from the ground contact; every triangle inside a wheel's cylinder goes to it, the paint stays on the body; the
  shared vertices stay shared), so near cars **roll** (your car from its speed, traffic from its odometer) and your
  front wheels **steer** (drive.js's steer angle); far cars keep the whole model's light LOD. 10 / 10 models split.
- **Headlights and light pools**: the renderer has point / spot lights now (a `Lights` uniform block, 16 a frame, 4 on
  Switch, the strongest near the camera chosen; diffuse with a windowed inverse-square falloff, in the mesh and
  terrain shaders). At night your car (and every traffic car) lights the road with two spots, its lamps glow (emissive
  quads, into the bloom), tail lights redden and brighten when braking; **lamp posts** (all 111 of the resort's,
  transport's and courses' `lamp_post`s) throw warm light pools on the snow; snowcats light their way.
- **Paint and plates** (carconfig.js): the instanced draw carries a per-instance colour; materials named like paint
  take it (`Material::paint`). Your cars wear the paint you bought (`save.garage[].paint`), parked and traffic cars the
  colours real cars come in, other players' cars their `cfg.paint`; near cars carry number plates (canvas textures in
  the game's font: "VS 123456", your own plate on yours, a canton plate on each car on show).
- **The Legacy Express in its blue livery**: the same railcar body as the Wolkenspitzbahn, its red repainted Legacy
  blue (#1546c8) per instance by a livery mode in the shader (the Wolkenspitzbahn stays red).
- **The orange slab on the Express village station canopy** was a renderer bug: the instanced procedural pieces in the
  packed 28-byte vertex layout (`resort.bin`'s meshes) were bound as if they were float vertices, so their colours came
  from the next vertex's position (an HDR orange glow) and their normals / uvs were garbage. `Primitive::packed` now
  selects the right attribute layout everywhere (also fixes the other instanced procedural pieces).
- **Forest thinning**: the railways' formations thin the forest as in the JS (`transport.js` / `expressground.js`
  `addCut({ forest })`): `World::forestCuts`, no trees on the Wolkenspitzbahn's or the Express's bed or right beside it
  (the forest over the tunnels stays).
- **Snowmaking** (snowmaking.js): at dusk and at night the five snow guns nearest you (of 168) blow a plume of fine snow
  (the JS's particle maths: a cone out of the fan, drag, sinking, drift downwind, spreading), one instanced draw.
- **Flags** (flags.js): the house-style masts (a row of three in the plaza, one each side of every World Cup finish,
  25 in all), the cloths in eight slices of a canvas texture (SKI LEGACY / LEGACY / WORLD CUP in the italic lettering,
  the bar) streaming downwind and rippling, harder in a storm.
- **Snowcats** (snowcats.js, condensed): `snowcat.glb` groomers working three runs at night (headlights and light
  pools), parked at the bottom by day.
- **Outfits on the skier** (outfits.js, condensed): the skier's albedo is recoloured per garment zone — jacket (torso
  and arms), trousers (hips and legs), helmet (the top of the head) — with zones from the skin weights rasterized into
  the texture's UV space; the texture's own shading kept (luminance against the zone's median). Bought outfits show at
  once (re-applied when the outfit or the character changes).
- **Ski stats in the physics** (player.js `this.ski`): the equipped skis' speed divides the glide friction and the
  drag (x speed² on the area), their grip multiplies the edge grip and the carve rate — the rental 1.0 / 1.0 up to the
  Legacy Gold Edition 1.12 / 1.25.
- **Poles in the hands**: `ski_pole.glb` from each fist to a tip planted beside and behind the boots while skiing.
- **Bloom, screen effects, camera shake** wired to SETTINGS: bloom (bright pass at quarter resolution, separable blur,
  threshold 3.0, strength 0.13 like post.js; a new "Bloom" row), speed streaks (a radial smear past ~65 km/h), the
  vignette, the white flash of a hard landing and the red edge of a crash ("Screen effects"), camera shake (a fine buzz
  at speed, jolts on landings, crashes and car knocks: "Camera shake"). NaN-safe now (a GGX term of a dot product a
  hair over 1 was NaN; the bloom spread those pixels into black blocks before the clamp).

**Performance for Switch-class hardware.**
- **`--quality switch`** (also a SETTINGS row, "Switch (handheld)") — modelled on the console (1280x720 handheld /
  1920x1080 docked, ~3.2 GB of its 4 GB for a game, Maxwell 256 cores at 0.3-0.77 GHz ≈ 0.2-0.4 TFLOPS, four A57 cores):
  textures capped at **512** and **BC1 / BC3 block-compressed** at load (`engine/texcompress`, stb_dxt; Maxwell
  samples BC natively; the signs' canvases too), a **90k-triangle budget per model** (the heavy GLBs — the police car
  750k, the chalet 538k, the GLS 520k — simplified with meshoptimizer and their vertex buffers compacted), shadow map
  1024 over 50 m with **single-tap PCF**, **simplified shaders** (`SL_LOW`: no normal maps past 30 m, no glints, 4 lights),
  LOD / cull distances x0.6 (props, course / resort meshes, flags, snowcats), trees 22 / 85 / 320 m, terrain LOD 1.05,
  far plane 14 km, **half the townsfolk, skiers and traffic**, 24 people drawn, **dynamic resolution** (60-100 % of the
  output, following the frame time toward 30 fps; off in the autotest).
- **Streaming**: the baked mesh chunks (the resort's, the transport's and the courses' meshes, 2450 of them) are kept
  zstd-packed on the CPU (92 MB raw -> 36 MB) and uploaded within ~1.8 km (x LOD scale) of the camera, nearest first, up
  to 6 MB a frame, released 400 m further out (on Switch's unified memory a released chunk is memory back); the course
  meshes no longer stand everywhere. The transport / play packs' parsed JSON and raw bins are dropped once read.
- **Leaner GPU data**: the procedural meshes (`mesh_kit`: track, guardrails, stations, kits) use the packed 28-byte
  vertex (was 44 bytes of floats), the wheel split shares vertices.
- **Measured in the autotest** (CPU ms per system per frame, mean / max; draw calls, triangles, GPU texture / buffer
  memory, RSS and its peak, the streaming counters): `[perf]` lines after the skiing and at the end, see below.

**Packaging.** `-DSL_COPY_ASSETS=ON` gathers the assets next to the executable (or into the bundle's `Contents/Resources`; 151 models, `native/data` incl. the
audio); `cmake --install` / `cpack` lay out and pack the game: macOS **Ski Legacy.app** (`-DSL_MACOS_BUNDLE=ON`:
`cmake/Info.plist.in`, the icon from `build/icon.icns`, the assets in `Contents/Resources/assets`, which `AssetPaths`
finds; universal arm64 + x86_64 with `CMAKE_OSX_ARCHITECTURES`) in a drag-to-Applications **.dmg**; Windows a folder
with **SkiLegacy.exe** (icon from `build/icon.ico`, no console) + `assets/` as **.zip**; Linux a folder with `ski_legacy`,
`ski-legacy.sh` and `assets/` as **.tar.gz**. **`.github/workflows/native.yml`** (workflow_dispatch + pushes to
legacy-express touching `native/**`) builds all three (npm ci for the data export, ffmpeg for the audio) and publishes
them as the rolling **`latest-native`** release: `Ski-Legacy-Native-Mac.dmg`, `Ski-Legacy-Native-Windows.zip`,
`Ski-Legacy-Native-Linux.tar.gz`. The Electron workflows are untouched.


**The checks** (`--autotest`, `--quality medium`, SDL's dummy audio driver, llvmpipe): every Phase 1-6 check as before,
plus:
```
quality: medium (textures <= 2048, shadow map 2048 over 80 m, LOD x1.00, far 30000 m, NPCs x1.00, 16 lights)
vehicles: 10 of 10 car models with their wheels split off (rolling / steering)
audio: 50 sound effects and 26 announcer lines decoded in 0.55 s (0 missing)
scene fx: 111 lamps, 168 snow guns, 25 flag masts, 3 snowcats
[autotest] outfit applied: {"jacket":"j_sunset","trousers":"t_navy"} -> recoloured
[autotest] race sound: count:3 / count:2 / count:1 / go / checkpoint / checkpoint / finish:record / medal:silver / results
[autotest] night: 33 lamps lit (the plaza), 5 snow guns spraying, 6 car headlights, 2 plates (behind a traffic car) -> ok
[autotest] audio: device open, 50 sound effects + 26 announcer lines decoded in 0.55 s (0 missing, 24.0 MB PCM), 37640192 frames mixed, 76 one-shots + 13 synthesized, peak 22 voices, 10 music tracks started (last 'ride_alive'), peak level 0.53 -> ok
[autotest] scene fx: 33 lamps lit, 6 car lights, 2 plates, 2 snow guns spraying, 25 flags, 3 snowcats; car wheels split: yes; outfit worn
[perf] quality 'medium': peak RSS 3582 MB (budget on Switch: well under 3 GB)
[autotest] PASS
```
`--quality switch` passes the same run (peak RSS 2166 MB); `--verify-heights` PASS; `--mptest` against a local server
with the JS peer PASS; `server/test.mjs` 415 passed (the server is unchanged).

### Performance (the autotest's `[perf]` report)

Measured on the reference container (Mesa **llvmpipe**: software rendering on 4 CPU cores, 1280x720; GPU memory
lives in system RAM there, so **RSS counts textures and buffers too** — the closest a PC gets to the Switch's unified
memory), the full `--autotest` (600 frames of skiing every frame rendered, then the walk, the gondola, the car, the
traffic, the bus, both trains, the race, the job, the police, the chalet, the weather, the snowmobile and the night
shots, every 4th / 8th frame rendered):

| | `--quality switch` | `--quality medium` (default) | medium before the Phase 7 memory work |
|---|---|---|---|
| world ready | 19.5 s | 20.2 s | 19.3 s |
| GPU textures at ready | **291 MB** (512, BC1/BC3) | 1545 MB | 1556 MB |
| GPU buffers at ready | **331 MB** | 508 MB | 723 MB |
| RSS at ready | 1601 MB | 2896 MB | 3272 MB |
| **peak RSS** (whole run) | **2166 MB** | 3582 MB | ~3.7 GB |
| skiing: draw calls (mean / max) | 189 / 231 | 355 / 585 | ~350 / 544 (3D only) |
| skiing: triangles (incl. shadow pass) | 2.25 M / 3.1 M | 4.36 M / 5.77 M | (not counted) |
| rest of the run: draw calls | 652 / 2047 | 770 / 2346 | — |
| rest of the run: triangles | 3.7 M / 7.4 M | 8.1 M / 13.9 M | — |
| mesh chunks resident (of 2450) | 364 (14 MB) | 550 (22 MB) | all |

CPU per frame by system while skiing (switch preset; this container's x86 cores): simulation (120 Hz) 0.02 ms, gameplay
0.01, vehicles 0.02, streaming 0.14 (max 0.9), audio 0.01 (the mixer itself runs on the audio thread: ~1-2 % of a
core), scene submit (culling, batching) 0.50 (max 1.0); the GL draw submission is not meaningful under llvmpipe (it
rasterises: 250 ms a frame). Over the rest of the run the maxima are one-off spikes (a race being set up: 350 ms of
gameplay; streaming a teleport's cells: 22 ms).

**To verify on Switch hardware** (none of this can be measured here): GPU time per pass at 720p handheld (307-384 MHz)
and 1080p docked with the SDK's profiler — the shadow pass and the terrain's ~1 M triangles a pass are the first
suspects, then the alpha-tested trees; whether 30 fps holds with dynamic resolution's 60 % floor; the CPU on four
~1 GHz A57s (expect the per-system times above x4-6, still a few ms; the draw-call spikes of ~2000 in the busiest
places — lift lines full of cabins, the race's props — want merging / more instancing if NVN submission shows up);
memory against the application heap after an hour of streaming; load times from the cartridge / SD card (BC at load
takes a few seconds: an offline ASTC / BC step removes it); thermals in handheld mode.

### Known gaps (Phase 7)
- **Audio**: the Express's spoken station announcements are text-to-speech in the web game (speechSynthesis): only the
  gong plays here (the Wolkenspitzbahn's recorded lines do play); no HRTF / reverb beyond the horns' valley echo, no
  doppler on the siren / rotor (a pitch factor is wired, fed 1); the helicopter you fly sounds as the rescue's (the rotor loop; no load / speed layers); the
  studio ident's synthesized ice hit (`iceHit`) and the cold-room hum are not ported; the sledding / rail-scrape loops
  are simplified to impacts. The mixer runs on the platform's callback thread with a mutex (fine on desktop and with
  `nn::audio`'s renderer thread; a lock-free queue would be the polish).
- **Wheels**: the steering wheel inside the cockpit does not turn (cars.js splits it off too), traffic's front wheels
  don't steer (they roll); no dents, tyre tracks, seated drivers. Wheel detection uses names / the ground contact: a
  model whose wheels are neither named nor touching the ground stays whole (all ten split today).
- **Lights**: diffuse only (no specular highlight from the lamps), no shadows from lamps / headlights, at most 16 lights
  a frame (4 on Switch) chosen by strength and distance; lamp heads glow by their models' night emissive, the Christmas
  tree's point light and the piste floodlights (pistelights.js streams them) are not added.
- **Outfits**: the zones come from the skin weights only (outfits.js also clusters the albedo's colours: accents,
  stripes, the goggle lens): jacket accents and lenses are not recoloured; the shop's 3D podium is still a card dialog.
- **Snowcats** follow the piste polylines (no grooming trail on the snow, no ploughs on the roads, no winch); flags
  stand where flags.js's first candidate is (no collider check), without colliders of their own.
- **Plates** are textures per plate text (a cache of 48); no custom-plate configurator.
- **Performance**: measured with Mesa llvmpipe (software rendering on 4 CPU cores) — the CPU times per system are real,
  the render times are not a GPU's. Dynamic resolution is off in the autotest. BC compression happens at load (a few
  seconds); an offline ASTC / BC step is the console way. The rail sweep and the guardrails are built at load and stay
  resident (~100 MB of vertices with the packed format); the resort's prop cells stay resident (instances are culled).
- **Packaging**: the macOS app is not signed / notarized (Gatekeeper: right-click, Open) and the Windows exe is not
  signed; the workflow has not run yet in this repository (written against the runners' current images: macOS with
  Homebrew ffmpeg, Windows with Chocolatey ffmpeg, Ubuntu 24.04 with apt); the universal macOS build compiles every
  dependency for both architectures (if mbedTLS's or libwebp's per-arch code ever objects, drop to arm64 only).

---

## Graphics overhaul (Phase 8: the look of the web game's Ultra, and past it)

The native renderer now ports the web game's realism tiers (`quality.fx` 0-4) shader for shader and adds what the
browser could not afford. Everything stays OpenGL 4.1 core (the Mac's limit) and camera-relative.

**Snow and rock** (`engine/shaders_terrain.h`): `terrain.js createTerrainMaterial` line by line — the wind-sculpted
relief picked by the pixel footprint (two noise octaves cross-faded, drift-shaped, calmer as the features grow), sastrugi,
grain at three scales, the cinematic micro relief, groomer corduroy and the 5.5 m groomer lanes, scraped ice on the
steeper pistes (more after freezing weather), the km-scale wind crust, couloirs and the cliff-bands' broken ledges
(the macro slope is now a vertex attribute, as `aMacro` in the JS), triplanar rock with buttresses, facets, strata,
cracks and snow on its sky-facing relief, far buttresses / gullies, the far forest tint, the shade (see "Colour" below),
sunlight cooling as it grazes, the subsurface terminator, the forward-scattering sheen, the HDR ice glints at up to
four cell sizes (prismatic up close). On top of the port: **2048 px tiling snow and rock maps baked on the GPU at
start-up** (periodic gradient / cellular noise: sintered grains, pits, crust; rock blocks, cracks, lichen; mip-mapped,
the GPU's maximum anisotropy) for crisp crystals right under the skis (faded out by 45 m), **height-blended snow / rock
edges** (snow fills the rock's hollows first) and triplanar rock detail near cliffs. The groomed-run data now also
reaches the 1-2 km terrain nodes, so the pistes read as smooth bright bands on the far slopes. (Nov 14) **Rock at every
distance**: the baked rock map (fractured blocks, cracks, ridged grain) is sampled at the scale the pixel footprint
asks for, two neighbouring scales cross-faded, so a wall has crisp blocks at 10 m and at 3 km (it was magnified
256 px noise beyond 90 m); **bedding**: banks and thin beds that dip a few degrees, lighter, darker and ochre bands,
their steps tilting the normal into ledges. **Snow**: the wind relief's hollows and the shade take the sky's blue
(not a grey stain), a stronger relief normal, crystals with wider tilts and brighter glints that shimmer as you move.

**Snow trails** (`world/snowtrails.*`, the renderer's trail map): a toroidal RGBA16F height map that follows you
(2048 px over 128 m on High / Ultra, 3072 over 150 m on Super Ultra, 512-1024 on the light presets: 4-6 cm texels),
scrolled by clearing the strips the window leaves. Stamps are max-blended quads drawn by a small shader per kind:
your **skis** (two grooves 9-10 cm wide that follow every carve, deeper on the edge, a wide scraped fan when you skid
or plough, a crater on landing, a sitzmark when you fall, with the berm the edge throws up), **boot prints** (sole,
heel, tread lugs, a lip of snow; alternating, longer strides running), the **snowmobile**'s cleated track and its two
skis, **car tyres** (block tread), and the resort's **skiers and walkers** (skis or boots from their speed). The
terrain shader reads it for normals, a parallax march into the grooves near the camera (Ultra), compressed
blue-grey snow with few crystals in the tracks, berms catching the light and, on Super Ultra, the grooves' own
shadows in low sun. The map fades on the GPU over a few minutes (faster in a snowfall). **Spray**: soft lit particles
off the edges in a hard carve, a hockey stop's fan (the snow it throws piles up as small mounds), the snowmobile's
rooster tail, powder on a landing (depth-faded, back-lit forward scattering, drawn after the resolve).

**Lighting** (`engine/shaders.h`): three.js's `MeshStandardMaterial` model (GGX with height-correlated Smith,
Schlick, the multi-scattering IBL split sum) so materials match the web game; the sky model of `sky.js
Environment.update` (halo, disc, dusk, twilight, Belt of Venus, cirrus, the hemisphere light and the IBL strength per
sun height and weather); **image-based lighting**: the `ENV_FRAG` environment rendered every frame into a mip-mapped
equirectangular map (reflections by roughness: glass, car paint, ice) and projected on the CPU into L2 spherical
harmonics (irradiance); **cascaded shadow maps**: 1-4 cascades in one atlas (fitted to the view as bounding spheres,
texel-snapped: no shimmer), 8-12-tap rotated Poisson PCF on hardware 2x2 PCF, cascade blending, normal + light offset
bias scaled by the texel, the coarser mesh LOD in the shadow pass, small casters skipped in the far cascades;
alpha-tested foliage casts its real shape; the lamps and
headlights now have a specular highlight; height fog / aerial perspective (`fog.js`) with sunlit haze toward the sun.

**Weather mist** (Nov 14; `shaders_fx.h kMistFS`, `world/groundmap.h`; Balanced and up): a half-resolution pass after
the resolve ray-marches a layer of mist over a height map of the ground round the camera (128 x 128 samples over
12 km, recomputed on a worker thread as you travel; its second channel is the valley floors' level). On fair days
thin bright wisps lie in the floors that are lower than their surroundings, more in the morning and evening, with
the village and the air you stand in kept clear; in **Misty** and **Freezing fog** weather a billowing sea of mist
fills the valleys to a ceiling a few hundred metres over their floors, the peaks standing out of it (ski down into
it: ~300 m of sight inside). It is lit by the sun with a forward-scattering lobe (the air glows toward the sun), by
the sky, by its own depth, and on High and up by the shadow cascades (shafts through the mist);
depth-aware blur and upsample. Most of sky.js's uniform mist term is left to this pass where it runs, and the sky
dome fogs along the same exponential atmosphere as the terrain. Everything follows the weather's eased values:
clear / misty / snow blend over ~20 s. `SKI_LEGACY_GFX=nomist` switches it off.

**Particles** (Nov 14): **snowfall** is drawn on the GPU as atmosphere.js's flakes (`kSnowVS`: 12-26 thousand seeded
quads in a 46 m box that wraps round the camera, one draw; each with its own fall speed, flutter, tumble and slow
eddies; a size in metres so the layers part with parallax, never under ~1.7 px — smaller ones thin out instead;
faded before the lens and at the far side of the box; sheared along their motion in a blizzard, thin falling lines
in sleet; lit by the sun, the sky and the lamps round them: warm flakes under the plaza's lanterns). **Powder**
(ski spray, landings, the snowmobile's tail, the snow guns' plumes) is made of small clouds: spheres of dust whose
edge is eaten by drifting noise, shaded as a volume (the sun wraps round, sky-blue shade, a back-lit rim), shadowed,
lit by lamps, soft against the scene's depth and before the lens; a plume is powder + a finer veil that rises above
it + the clumps the edge throws. By day a flake is at least half again as bright as the haze behind it, with a soft
blue-grey edge (42-60 thousand of them on Balanced / High): heavy snow and blizzards read against the sky, the
slopes and the trees.

**Car lights** (Nov 14, as `carlights.js` / `cars.js`): `tools/export_net.mjs` runs the game's own `carTemplate` on
each car model (on a copy whose materials carry the base colour maps' pixels, decoded with sharp: the colour-aware
`LAMP_RULES` read them) and exports the lamps: every lamp part's triangles in the car's frame with its kind (head,
high, drl, tail, third, brake, rev, ind, lensF, lensR), tier (core / tex / plain), boost and glass opacity, and the
halo anchors per kind and side. The C++ (`game/scenefx.cpp`) draws each part as an emission-only overlay through the
model's own colour map (`Material::additive`, shading 5) with `lampsOn`'s intensities (the K table: low beams, the
daytime running lights of a running car — the headlamps on models without DRLs —, tails, brake and third brake
light, reversing lights, the lenses' share), and `halos()`' sprites (the canvas gradient, sizes from the lamps'
boxes, shown only from in front of the lamp, dimmer by day), plus the spot light as the pool on the road from the
headlamps' own position. `SKI_LEGACY_DEBUG=lamptest` / `lampday` lights every car for screenshots. Not ported:
indicators / hazards (only wrecks use them in the JS), the daytime running lights of traffic by day (its poses do
not say which cars are running).

**Sky, clouds, sun**: `SKY_FRAG` ported (Rayleigh shading, twilight arch, halo, cirrus, the overcast deck's texture,
the limb-darkened HDR disc) plus stars, the Milky Way and the moon; the **clouds of atmosphere.js** (Nov 15 2026, the
user: "why are the clouds so ugly": the native ray-marched cumulus layer, 6 noisy steps on Balanced, blurry blobs, and its
sea-of-clouds pass are gone): `world/clouds` places them as the JS does (analyseCell / placeBanks / placeDrifters /
updateImpostors, the same hashes: valley-filling sea patches, cumulus banks leaning on the flanks, wisps in front of the
ridges, the ring on the far cloud sea, cumulus over the peaks on cloudy days 9 km+ out, the resort kept clear) round a
128 x 300 m toroidal height map built on a worker thread, and the renderer draws them (`engine/shaders_clouds.h`): the
eight shapes of `CELLS` (`engine/cloud_shapes.h`, the same mulberry32 spheres) ray-marched once at load into the
six-way-lit 1024 px impostor atlas (BAKE_FS, two RGBA8 maps), drawn as camera-facing cards relit for the sun or moon,
silver-lined toward the sun, soft where they meet the ground, in the height fog, capped per preset (quality.js clouds:
60 / 150 / 300 / 420); the **overcast deck** (four noise planes 26 m apart: low in snow, higher when cloudy, sunk
below the village in the sea-of-clouds weather with sky.js's grey day under it, a whiteout riding through it). No
cloud shadows (the JS has none). Still missing: backdrop.js's painted far ranges and their flat cloud sea (the ring
cards stand on it in the JS). Before / after / JS shots: clear, flurries, cloudy, heavy at noon from the village, down
the valley and from the summit, morning, dusk and night; the **sun glare** of `sunglare.js` (core, halo, 32-spike starburst; visibility from the depth round the sun)
into the HDR image so it blooms; **sun shafts** (post.js).

**Materials**: sRGB-correct base / emissive maps, the models' textures at the GPU's maximum anisotropy on High and
up, normal maps through derivative tangent frames, the **Meshy detail layer** of `core/meshylook.js` (triplanar
half-metre grain in the model's own space, the metalness clean-up, the roughness tweak), the **pine shading** of
`vegetation.js` (dark needles from the texture's luminance (green in the native build), snow on needles facing the sky, wind sway and branch
flutter, crown self-shadow and sky occlusion, translucent needles against the sun), **car paint** with a clear coat
(its own GGX lobe and sky reflection, Fresnel, metallic flakes), **glass** with Fresnel sky reflections, and
**alpha to coverage** under MSAA (anti-aliased needles and fences).

**Far field**: the **forest impostors** of `vegetation.js` — the same tree placement as the 3D forest (genCell) out
to 0.7-3 km by preset, drawn as one instanced draw of cylindrical billboards of a procedural conifer (the pines'
colours, snow on the tiers, lit and shadowed) that dissolve in where the 3D trees end.

**Post** (`engine/shaders_post.h`, `post.js`): HDR throughout; bloom from a 6-7 level mip chain (13-tap downsample
with a soft threshold and a Karis-averaged first level, tent upsample); **GTAO** (post.js's slices / steps / falloff,
half or full resolution, a depth-aware 4x4 blur and upsample); the final pass with **PBR Neutral** (Ultra and up, with
post.js's filmic contrast) or ACES, the broadcast grade, vignette, speed streaks, flash, dither; **MSAA** 4x / 8x
(High / Ultra) resolved before the post chain, then a contrast-adaptive sharpen. No blur filter anywhere: no temporal
filter, no FXAA (off on every preset; `SKI_LEGACY_GFX=fxaa` turns the 3.11 pass on for comparisons), no depth of
field, no radial blur at speed (post.js's is not ported: the streaks and the vignette carry the speed).

**Colour** (Nov 2026: "the image is too blue"): the native build no longer lights the world with the sky palette's
display colours. sky.js's IBL / hemisphere took the palette desaturated to 70 % — in linear light the cobalt zenith is
~7x bluer than red — so in the shade (lit by the sky alone) snow came out saturated blue, dark wood navy, and ACES
skewed asphalt and white paint toward purple; the terrain's "cold sky-blue shade" and grazing-sun cooling, the blue
subsurface term, the slate-blue rock, the navy pine needles and the ~10x-blue haze stacked on top. Now
(`renderer.cpp computeSky` / `beginFrame`): the sky lights with the palette's brightness and a ~11000 K skylight
colour (light, unsaturated blue; near-neutral under an overcast), the IBL's lower half carries the full bounce off
the sunlit snowfield (75 %, not 30-40 %: shaded facades stay neutral), the haze lights the far terrain at 40 % of its
saturation, the moon is a paler blue; in the shaders the snow albedo is near neutral, the shade / grazing / subsurface
/ groove tints keep their density but only a hint of cool, rock is grey, pines and far forests dark green, and the
grade's cool shadow push is halved. The visible sky, the sun and dusk's glow are unchanged. High now tone maps with
PBR Neutral as Ultra (white sunlit snow, no ACES hue skew); the rock has warm iron-stained strata, darker cool water
streaks and crevices; the far ranges' haze deepens to a clearer blue over several km.

**Sharpness** (Nov 2026: "the game is blurry", then "no blur at all"): Balanced and up draw the 3D at the drawable's
full (Retina) size, always (no dynamic resolution, no pixel budget), and anti-alias with MSAA 4x / 8x + alpha to
coverage and a contrast-adaptive sharpen. FXAA (whose subpixel pass smeared every texture) is off on every preset:
Performance / Super Performance use MSAA 2x; their 3D resolution below the output (render scale 0.85 / 0.6, a
2.4 / 1.6 MP budget, dynamic resolution toward 60 fps) is upscaled with a ringing-clamped Catmull-Rom filter and a
firmer sharpen, not a bilinear stretch. The simplified LODs no longer smear either: Meshy atlases are thousands of
tiny UV islands, so the lift cars' and the trees' LODs carry a colour per vertex taken from the base colour map
instead of sampling it (`ModelLoadOptions::lodVertexColor`), and the trees' LODs are made by vertex clustering as the
JS's `clusterDecimate` (`lodCluster`): whole branches with white snow at every distance instead of shredded grey-green
blobs from 40 m and pink polka-dot cabins from 32 m. Colour maps load at twice the models' budgets on High and up
(the 2048 px originals; with S3TC, which Apple's OpenGL lacks, on Balanced too, block-compressed). On Balanced
without S3TC only what you see closest keeps its 2048 px colour map (`ModelLoadOptions::colorTextureSize`): your
skier, your skis and the plaza's rental shop, hotel, ticket booth and market stalls: +125 MB of textures.
**LOD hand-overs** are dithered cross-fades (trees at 40 / 150 m and into the far-forest impostors, the lift cars at
32 / 110 m): within a band of 16 % of the distance the outgoing LOD keeps the pixels the incoming one drops, by
the same dither, so nothing pops. The gondola cabin's painted windows are tinted glass that mirrors the sky, a band
of ridges and the snowfield (shading 6). The terrain noise and detail maps use the GPU's maximum anisotropy from Balanced up, and the
baked snow crystal map reaches 50 m on Balanced (new) and 80 m on High and up (was 45 m).

**Presets** (`engine/quality.h`; the SETTINGS row has the web game's seven): `switch` (one 1024 shadow map with
single-tap PCF, SL_LOW, no MSAA / AO / shafts / clouds / detail maps, a 512 trail map, impostors to 700 m),
Super Performance / Performance (fx 0: the original look, one shadow map, MSAA 2x, a reduced 3D resolution, 512 trails), **Balanced** (fx 1, 2
cascades of 2048 to 160 m, MSAA 4x, the 1024 detail maps, a 1024 trail map, impostors to 1.4 km; the autotest's default),
**High** (fx 2, 3 cascades of 2048 to 320 m, MSAA 4x, PBR Neutral, half-res GTAO, shafts, glare, 2048 detail
maps and trails, impostors to 1.9 km), **Ultra** (fx 3, 4 cascades of 3072 to
480 m, MSAA 8x, full-res GTAO, PBR Neutral, impostors to 2.4 km), **Super Ultra** (fx 4, 4 cascades of
4096 to 640 m, GTAO with 4 slices, a 3072 trail map, groove shadows, impostors to 3 km). `--quality` takes all of them
(and the old low / medium); the first launch picks `auto`: Balanced everywhere (60 fps at Retina size on an M2; see the fps table below).
`SKI_LEGACY_GFX=noao,noshafts,noclouds,nomsaa,nofxaa,nobloom,notrails,nodetail,cascades=N,fx=N` switches parts off
for profiling; `SKI_LEGACY_TEXCAP=512` caps and block-compresses the models' textures (look tests on a busy machine).

**Cost by preset** (what each adds per frame; GPU memory of the render targets at 1920x1080; llvmpipe numbers are
software rendering on a shared 4-core container and only good for relative comparisons):
| preset | shadow pass | main pass | post | render-target memory |
|---|---|---|---|---|
| switch | 1 map, 1024 px, single tap | SL_LOW shaders (no glints, no far normal maps, 4 lights), trails (5 taps near) | tone map + grade | ~40 MB (shadow 4, trails 2) |
| Super Perf. / Performance | 1 map, 1024 px | fx 0 shaders, MSAA 2x, render scale 0.6 / 0.85 (Catmull-Rom upscale) | sharpen | ~60 MB |
| Balanced (the default; autotest) | 2 cascades x 2048 | MSAA 4x + A2C, fx 1 terrain, 1024 detail maps, 300 cloud cards, impostors 1.4 km, full resolution always | valley mist (11 steps, half-res), bloom, sharpen | ~210 MB (MSAA 100, shadow 32, trails 8, detail 11, mist 15) |
| High | 3 cascades x 2048 | MSAA 4x + A2C, fx 2, 2048 maps, colour maps at 2x the models' budgets, 420 cloud cards, glare | half-res GTAO (2 x 6), shafts, valley mist (16 steps, shadowed), bloom, PBR Neutral, sharpen | ~305 MB (MSAA 100, shadow 64, trails 32, detail 44, mist 15) |
| Ultra | 4 cascades x 3072 | MSAA 8x, fx 3 (parallax trails, far glints) | full-res GTAO (3 x 8), PBR Neutral | ~480 MB (MSAA 200, shadow 150) |
| Super Ultra | 4 cascades x 4096 | fx 4 (groove shadows), 3072 trail map, impostors 3 km | GTAO (4 x 10) | ~650 MB (shadow 270, trails 72) |

**Measured on a MacBook-class Apple M2 (8 GB)** (Nov 14 2026; OpenGL 4.1 on Metal, a 2316 x 1266 drawable = 2.9 MP,
vsync off, three fixed views held 100 frames each with `SKI_LEGACY_SHOTS`, other programs running; a 2560 x 1664
Retina panel has 1.45x the pixels):
| preset | top of a run | village plaza | valley with the village and forests | GPU textures |
|---|---|---|---|---|
| Super Performance | 411 fps | 289 | 194-211 | 1.63 GB |
| Performance | 394 | 250 | 307-320 | 1.67 GB |
| **Balanced** (default) | 214 | 116 | 118-123 | 1.97 GB |
| High | 224 | 119 | 96-130 | 2.62 GB |
| Ultra | 180 | 97 | 93-101 | 2.73 GB |

On llvmpipe (software GL, contended 4-core container) the skiing view runs at roughly 0.3-0.8 fps on Balanced at 1280x720
and 0.1-0.2 fps on High (MSAA, GTAO): a real GPU is two to three orders of magnitude faster. Software GL also grows
the process by ~1-1.5 GB while it JIT-compiles the bigger shader variants (the autotest's peak RSS).

### The forests' cost, and what Ultra / Super Ultra add (Nov 16 2026)

The user: "lag on High; keep the look, way better performance on High, Ultra and Super Ultra; Ultra and Super Ultra
should look WAY better". Measured with `SKI_LEGACY_DEBUG=hitchtest,shotonly SKI_LEGACY_GFX=res=2560x1440` (the
autotest's run in real time, vsync on, the 3D at 2560 x 1440 whatever the window) on the M2 MacBook (8 GB, fanless:
it throttles over back-to-back runs, so only runs taken one after the other are compared). Isolation runs
(`SKI_LEGACY_DEBUG=notrees / noterrain / novillage`, `SKI_LEGACY_GFX=nomsaa`) showed the main pass was the forests, and
that it was **geometry, not shading**: the triangle count moved the time, the shading did not.

- **A fourth tree LOD** (`scenery.cpp`, `quality.treeLod3`): the far trees past 1.4 x the mid distance (High 350 m,
  Ultra 490, Super Ultra 588) use a vertex clustering at 14 % of the height instead of the 8 % one (2,180 triangles a
  tree out to 900 m, where a tree is a few dozen pixels tall), dithered in like the other LODs. Side by side (the
  autotest's deterministic shots, amplified differences) the forests look the same. `SKI_LEGACY_GFX=lod3=<m>` and
  `lod3c=<fraction>` for A/B.
- **A pine program** (`SL_PINE`): the forests' shader with the pine shading only; the other kinds' inputs are
  constants, so only the varyings the pine reads leave the vertex stage (on a tiled GPU each varying of each vertex
  is written out and read back). `nopine` for A/B: ~15 % of the main pass.
- **The near trees' crowns get a depth prepass** (`kPrepassFS`: the LOD dither and the crowns' alpha to coverage),
  then the pine shading with `GL_EQUAL` and no discard (`invariant gl_Position`): each crown pixel shaded once. Only the
  alpha-tested LOD 0: drawing the clustered LODs twice cost more than it saved. `noprez` for A/B.
- **Opaque props and buildings** use a variant of the mesh program without the discards (`mesh_opaque`,
  `mesh_instmat_opaque`): a shader that may discard turns the GPU's hidden-surface removal off for all it draws.
- **The rocks are culled per instance** to the view and to the cascades they cast into, as the trees (`nocull`).

High, skiing (p50 / p95 / p99 ms, main pass GPU ms, triangles incl. shadows): before 66.7 / 83.5 / 84.5, 42.4 ms,
10.3 M; after 50.0 / 67.0 / 68.1, 29.5 ms, 8.3 M (the frame times are whole vsync intervals: 66.7 = 15 fps,
50 = 20 fps). The picture is the same. What is left on High at 2560 x 1440 is the terrain's shading (~13 ms of the main
pass; with the trees off the frame is still ~33 ms there), the forests (~10 ms), the mist (2.3), shadows (3.4), UI (2.9).
Skiing, p50 / p95 / p99 ms (main pass GPU ms; shadow pass ms; triangles a frame incl. shadows), back to back:
| preset | before | after the speed-ups | after + the Ultra look |
|---|---|---|---|
| Balanced | 50.0 / 51.4 / 52.0 (24.7; 2.0; 5.65 M) | 49.4 / 51.1 / 51.9 (20.8; 2.1; 5.59 M) | (unchanged) |
| High | 66.7 / 83.5 / 84.1 (42.5; 3.4; 10.3 M) | 50.0 / 67.0 / 68.4 (29.6; 3.3; 8.3 M) | (unchanged) |
| Ultra | 100.1 / 150.0 / 150.2 (69.5; 6.3; 18.3 M) | 83.3 / 100.1 / 116.7 (44.2; 6.3; 13.9 M) | 83.4 / 116.6 / 116.8 (44.5; 6.8; 14.5 M) |
| Super Ultra | 149.9 / 183.4 / 183.5 (92.4; 9.9; 26.8 M) | 100.1 / 150.0 / 151.1 (59.1; 9.6; 20.6 M) | 116.7 / 166.7 / 183.4 (61.8; 16.2; 28.3 M) |

(Frame times are whole vsync intervals: 50 ms = 20 fps. Not reached: 60 fps on High at 2560 x 1440 on this
machine; the village, driving and a room were not measured this round.)

**Ultra / Super Ultra** (High unchanged):
- **Contact-hardening soft shadows (PCSS)**: a blocker search in the shadow atlas (read as depths through a second,
  non-comparing sampler on unit 15: `Device::bindDepthRaw`; 8 taps on Ultra, 12 on Super Ultra), the penumbra from the
  caster's height over the ground and the sun's disc (0.53 deg, widened 1.6x for the air's forward scattering): a
  pole's or a trunk's shadow crisp at its foot and soft further out, a crown's shadow on the snow soft.
  `SKI_LEGACY_GFX=nopcss` / `pcss` to compare.
- **The forests cast further**: the trees out to the far LOD cast (as its coarse copy) into three cascades on Ultra,
  all four on Super Ultra (High: LOD 0-1 into the first two), so the forests out to ~480 / 640 m shade the snow
  beside them. (Every tree LOD into all four cascades cost Super Ultra 11 ms of shadow pass: not taken.)
- **Wider outdoor GTAO** (1.35x / 1.6x the radius): the sky hidden from the snow round a trunk, a hut's foot, a rock.
- **Neutral with a long shoulder** (`uToneMap` 2): the shoulder starts at 0.56 instead of 0.76 and rolls off longer, a
  hair less exposure: sunlit snow keeps its relief, wind ripples and sun-to-shade gradation instead of clipping flat
  white, as a camera sees it.

---

## Fix round 5 (Nov 2026): races' ground, the map's village, indoors, the bus cabin, tunnel roads, breakables

- **The courses' jumps and bridge are solid** (the user: "you sink through some parts of races"). The World Racing
  courses register their walkable surfaces (courses.js: every kicker / tabletop / roller's ramps.js surface, the gorge
  bridge's deck) before the resort is built, so neither the resort's nor the play pack's surfaces carried them: the C++
  skied through every jump drawn on a course and fell through the bridge. The bridge deck is now sampled into the play
  pack; the ramps go as their ramps.js parameters (`courses[].ramps`) and are shaped analytically (World::addRamp:
  the terrain under them plus profile / sideCurve, as makeRamp's surface.height; sampled at 0.25 m a kicker's lip was a
  2-3 m step a cell wide). Check: `SKI_LEGACY_DEBUG=sinktest SKI_LEGACY_SINKREF=ref.json --autotest`, where ref.json is
  the JS's world.groundHeight every metre along every course at five laterals (a Node script imports world.js,
  registers the courses as main.js does and samples them): every point where the C++ ground is more than 4 cm off is
  listed in runs with the course feature there.
- **Trail map**: the native village's 27 buildings were 27 squares over the plaza; it is one soft built-up area now
  (the convex outline round the buildings' footprints), under the roads, stops, stations and the places' icons.
- **No sprinting indoors** (the user's wish; the JS lets you): in a room, the Autohaus, the ward, walking in the Express.
- **The bus cabin** (bus.js MIC_INNER): plain standard shading (no Meshy detail layer: it turned the seats grainy and
  near black from the seat) and the cabin's own light as the railcars' (setCabinLight: its albedo as a soft emission,
  0.3 by day, up to 1.2 at night and in a tunnel).
- **Road tunnels**: no outdoor snow on the tube's road. resort.cpp packs how much snow each road vertex keeps into its
  colour (fading out 4..16 m past the portal, Transport::roadTunnelDepth's measure); the road snow shader drops the
  snow and slush there (the web game darkens it with its decal).
- **Breakables** (world/breakables.js, `game/breakfx.*`): a pole, sign or street lamp a car knocks is hidden where it
  stood (Resort::knockProp: the placed prop at the collider) and a copy of it flies off the bumper (the car's velocity,
  a kick up, a tumble), bounces on the snow up to three times, turns flat and lies there, with the clack (and a lamp's
  glass); a guardrail section broken through flies off as its own bent beam (RailSweep::sectionModel). After 90 s,
  once you are 25 m away or not looking (or 2 minutes later anyway), it stands again with its collider. At most 30
  down at once. `SKI_LEGACY_DEBUG=breaktest --autotest --frames 700 --png out.png`: the nearest knockable prop and
  guardrail to the plaza knocked, `out_brk_{pole,rail}_{before,fly,down,back}.png`.
- **Signs and poles fly off too** (they were baked into the merged meshes: only their colliders dropped). The exporter
  walks breakables.js's list (and adopts the piste markers as main.js does): every drawn part of a breakable (a road
  sign's post and its two panels, a snow pole and its tip, a reflector post's post / band / reflector, the scenic and P
  signs, the bollards, the piste markers' pole and top) goes out as an instance of a set of its own kind (the same
  geometry content and material: one set, instanced, one draw per 512 m cell; the road signs' atlas cell baked into
  the uv, so each sign face is its own set by cell), its `[set, instance]` pairs on its collider (`bp`; `bprop`: a GLB
  part too, found at the collider as before; `nid`: breakables.js's spot id). Resort::breakParts / hideParts hide
  each part (its instance's band 3, as knockProp), BreakFx throws a copy of all of them together. Counts: resort
  6640 parts (3320 piste markers) in 2 sets; transport 1235 parts in 39 sets (4 multi-material parts still baked).
  The pole threshold is breakables.js's 8 km/h now (was 30). The traffic's cars knock them too (BreakFx::sweepTraffic,
  breakables.js update: both ends of each car, local only). **Multiplayer**: your knocks go out as 'brk'
  { k: 'pole' | 'rail', id, v } (at most 10 a second), another player's (and the world snapshot's `brk` list on
  joining, flown forward by its age) knock the same pole / section here (Multiplayer host.onBrk -> BreakFx::remote).
  `SKI_LEGACY_DEBUG=brkdrive --autotest --frames 1600 --png out.png`: a Golf driven into a road sign by the village
  (45 km/h), a snow pole up a mountain road (45 km/h) and a guardrail there (125 km/h, 25-40 deg), by the car's own
  collisions: `out_brkdrive_{sign,pole,rail}_{before,fly,down,back}.png`.

## The rooms, inside and outside, as the web game (Nov 2026)

The web game builds every room you walk into as a scene of its own; `native/tools/export_rooms.mjs` runs those very
modules in Node and writes what they build into `play.json` (`rooms`): the scene as one model (the canvas textures
replayed, in the platform's Georgia where the web game paints in Georgia, letter spacing included), the collision the
JS walks on, the things you aim at, the lights with their roles, the glass, and where the room stands in the world.
`game/interiors*` draws and walks them; `game/window_view` gives the glass its view.

- **The windows' view** (`game/window_view`): **below High** (Super Performance, Performance, Balanced, Switch;
  `Quality::liveWindows`, fixed at start: a preset change restarts the game) no world is drawn for the glass: it is a
  misty, grey frosted pane seen from inside (shading 9 with metallic 1: the hour's soft light coming through, a bright
  cool grey by day, warmer and dimmer at dusk / dawn, a dark blue-grey at night, brighter toward the top, a faint
  mottled mist and frost creeping in from the frame; set against the room's exposure, so as bright in every room), and
  the world is streamed and simulated round you as before. **High, Ultra, Super Ultra**: live, as the web game's (liveportal.js; interior.js / chaletroom.js /
  carrentalroom.js renderPortal, prison.js, hospitalroom.js). The rooms stand at a quiet spot 21 km from the resort;
  every frame with a window in view your camera is carried to where the room stands outdoors (the same eye, direction
  and field of view; the police station's two wings each to their own place on the house) and the frame is drawn
  twice: first the world from there (`Renderer::endPortal`: the scene passes, culled and scissored to the part of the
  screen the windows cover, into an HDR picture at 0.75 of the frame's 3D resolution (`Renderer::portalScale`: its own
  depth and mist targets swapped in for the pass), without AO, bloom, glare or tone map, freed a few seconds after you
  leave; no trail map or sky-light pass of its own, the sun's shadows from the nearest cascade only (and only what
  shades that cascade submitted), not multisampled), then the room, whose window planes (a material of shading 9) show
  that picture: a hole in the wall onto the world with exact parallax, tone-mapped once with the room (the web game
  draws the chalets', the station's and the ward's at 40 % of the resolution every third frame). The world drawn for
  it is a lighter one (Nov 2026: the pass cost 60-100 ms of GPU time, rooms ran at 28-57 ms a frame; the forest round
  the chalets alone was 11 000 firs, 25 M triangles, every one drawn whichever way you looked): the trees, the rocks
  and the resort's props culled one by one to the windows' part of the view (or casting a shadow into it:
  `Scenery::submitView`, `Resort::submitPropsView`), the firs past 0.6 x the middle LOD distance as the far forest's
  impostors (fading over as the 3D firs fade out), the terrain's coarse grid (every other line; the models keep their
  outdoor LODs: the buildings' light copies are 6 % of the triangles, blobs across the square); and none at all
  while no pixel of the glass passed
  the depth test a few frames before (an occlusion query on the windows, `Renderer::windowsSeen`: a window behind
  the hall's wall cost the full pass). The world's pass runs every third frame in the chalets, the station and the ward (as the
  web game's), every other frame in the shop and the Autohaus (their glass fronts; the web game: every frame), up to
  two frames rarer while it is slow (`WindowView::rate`); in between the glass looks the picture up by direction from the camera it was
  drawn for (`Renderer::setPortalView`), so turning your head between two pictures does not drag the view along, and
  a turn that brings a window in from the edge of the screen draws at once. The house you are in
  is left out: the chalet and the station are not submitted for that pass, the ski shop, the Autohaus hall and the
  medical centre (baked into the resort's chunks) by a box the mesh shader discards in (`Renderer::setClipBox`; the
  snowflakes inside it too). **While you are inside, the world goes on round the house**: terrain, trees and resort
  cells are streamed round the carried camera and the townsfolk, the skiers, the traffic, the buses, the trains and the
  lifts are simulated round it (`windows.focus()`), so through the glass the people walk, the cars drive, the snow
  falls and the day turns to night. With no window in view the world is not drawn (the web game's test). Not ported:
  the shop's `nearClutter` (the web game hides the signboard and racks right in front of the shop in its view; here
  they are baked into the resort's chunks and stay). Debug: a room's test with `,winlive` holds every picture 4 s of
  game time and takes it again (`<name>_b.png`), logging the mean frame time of the first 2 s without the windows'
  view and of the last 2 s with it, and the GPU's time by pass (`window view: ...`: per drawn picture); `SKI_LEGACY_WINSHOT=a+b` only for the pictures whose name has a or b in it
  (outdoors too, for a baseline); `,noportal` switches the view off (the soft sky).
- **The ski shop** (`game/shoproom`, `game/outfitshop`; interior.js + main.js enterShop / exitShop / shopAction +
  ui/outfitshop.js): E within 3.2 m of the spot in front of the door (village.js), out again 2.2 m in front of it; the
  eye 1.62 m, 70 degrees, the crosshair; your own skier on the OUTFITS podium, dressed as equipped; **the outfit shop**
  with the camera swung round to the podium (outfitCameraPose), every row tried on the skier, a drag (the right stick)
  turns it, JACKETS / TROUSERS / HELMETS / GOGGLES / **KITS** (the eight kits, their pieces wearable once a kit is yours,
  the notes about goggles / second colours from the model's zones), buying and wearing in the web save's shape, the
  server's sale in multiplayer; **the clerk**: the conversation look (the portrait across the counter, the cinema bars,
  the name on a brush stroke, the line, THANKS), the clerk turning to you; the daylight following the sun, the
  lanterns brighter after dark, the stove's flicker, the wall clock keeping the game's time. Outside: the boards
  (SKI SHOP, SKI RENTAL SHOP and every other board painted in Georgia) in Georgia.
- **The chalets** (`game/interiors_chalet.cpp`, `game/chalets`; chaletroom.js + chalets.js): the house with **both
  floors**: the walls, floors and beamed ceilings, the open stair (a floor of its own while you are on it), the
  stairwell's rail, the roof's slope upstairs, the bathrooms' ware, the built-in lamps (the pool of six warm lights at
  the lamps nearest you, the lamps you bought among them), the fill by the hour; the **hinged doors** (E, or walking
  into one, opens it away from you; the leaf is solid wherever it stands; the front door: "Leave the chalet"); the HUD
  names the room ("Chalet 1 · Living room & kitchen"). The sale as chalets.js: "Chalet 3 for sale · $50,000", the
  card's text, one viewing per chalet (`save.chaletViewed`), "Go in · Chalet 3 (your chalet)", out in front of the
  steps. Outdoors the village as chalets.js builds it: picket fences, sheds, benches, snowmen, spruces, the PRIVAT
  parking bays and signs, house numbers, street lamps (their light pools at night), the windows lit from dusk, the
  houses' and fences' colliders.
- **The police station** (`game/interiors_prison.cpp`, `game/police`; prison.js + prisonoutside.js): the room's own
  frame, bounds and boxes (a prisoner between the cell's walls and the bars, a visitor in the corridor and the office),
  "Cell door · locked" / "Locked · 0:41 to go", "Leave the prison" facing the front door, the guard at his desk
  watching whoever comes near, "In prison · 0:45 · Speeding", "Released" at the door's spot; "Visit the prison"
  within 2.6 m of it. Outdoors the POLIZEI house as prisonoutside.js builds it (stone and larch, the board, the
  lantern, the banners, the potted spruces, the parking bays and signs, the roadside board), its colliders, the patrol
  car in the first bay.
- **The Werkstatt** (`game/werkstatt`; werkstatt.js): the garage as built there; your car in the yellow box and
  stopped (or you at the workbench with it standing there): "Repair · $500 · damage 37%", E pays, the car is held 4 s
  while the card's bar runs (bottom left: WERKSTATT · GARAGE, "Drive into the yellow box", "Stop the car",
  "Repairing… 60%"), then behind a fade the damage is gone.
- **The mountain huts** and **the ticket booth**: no rooms in the web game either; E within 3.5 m of the spot in front
  of a hut's door ("Mountain hut · hot chocolate $8", the MOUNTAIN HUT card's text), within 2.6 m of the booth's counter
  ("Talk to the ticket seller").

**The room's reflection** (Nov 16): the rooms were lit without an environment, so bare metal and gloss went black
(the shop's till, the rails, brass). An interior now draws an environment of its own (`Renderer::envRoom_`: the
room's warm light round you, the floor's below, three's RoomEnvironment as the web rooms set it), 35 % of the
ambient light coming that way (the hemisphere light gives up as much); the sky's environment map stays as it was for
the windows' view of the world.

**The ski shop's light, as the web game's (Nov 16, the user: "make the ski shop look WAY better").** Held against
interior.js from the same spots: (1) the jackets were lit by their own colours (the GLB's emissive map was replaced
by the albedo; the jacket rail's own map is black but for a few labels: pale, garbled jackets up close) — the room
loader now uses each GLB's own emissive map (`Material::glbEmissiveTex`); (2) the walls, floor and ceiling cast no
shadow in the web room, so the daylight comes in over them and lays the beams' shadows across the ski wall: the export
keeps those parts apart (`localModel(..., { shadows: true })`, `noShadow`; drawn as `shop:noshadow` without casting);
(3) the picture lights and the podium's key light are spots with their cones (export: `dir`, `angle`, `penumbra`), no
longer lighting the ceiling and the counter round them; the lanterns' falloff matched to three's I / d^decay at 2.5 m;
(4) the hemisphere's dark brown ground colour (the walls were lit as brightly as the floor) and three's RoomEnvironment
at 0.22 as a neutral light (`Lighting::roomEnv`: mostly the floor's and the varnish's sheen), so the wood reads brown
rather than orange and the counter no longer glows. Beyond the web game: ambient occlusion in every room on every
preset but Switch (`Renderer::aoLevel`: half resolution, 0.75 m radius: the corners, under the racks and shelves) and
relief on the painted boards from their own shading (`Material::bump`: the gaps sink in, the grain shows; faded out by
14 m). The room's mean colour from the five reference spots is now within a few % of the web game's.

Debug views (with `--autotest --png out.png`): `SKI_LEGACY_DEBUG=roomshop` (the shop from the web game's reference
spots (`rack`: close to the jacket rail), the conversation, the outfit shop's tabs: `out_in_<name>.png`, `out_talk.png`, `out_outfit_<tab>.png`),
`roomchalet` (`out_ch_<name>.png`: both floors), `roomprison` (`out_po_<name>.png`: visiting, then jailed and
released), `werktest` (a damaged car of yours in the Werkstatt's box, you at the workbench: the prompt, E, the repair
checked; then a hut's door and the ticket counter: `out_werk_<stage>.png`, `out_hut_prompt.png`).

Known gaps: the other players are not drawn in the windows' view; the ticket seller and the townsfolk talk in the card dialog,
not talk.js's conversation camera; the chalet's build mode still works the ground floor only; no police raid into a
chalet, no 30 s wait at a chalet's door during a chase; the prison's jail board (the lobby's top 3) shows the room's
first state; the station's and the Werkstatt's boards, lamps and windows come on with the night (their strengths by
day and at night exported per material), but the blue police lamp does not pulse.

**First person indoors (Nov 2026, the user: "you shouldn't be able to go in 3rd person mode inside buildings").** In
every room (the ski shop, the Autohaus, the chalets, the police station / prison, the medical centre's ward, in bed
too) and while walking about in a Legacy Express car, the view is your own eyes and the view key does nothing; the view
you had outside comes back when you leave (Interiors::enter / leave). The ward's "R: view" line is gone. (The web game
builds its rooms as first-person scenes too, but its ward has a camera beside the bed and its Express walk an orbit:
both left out here on purpose.)

**The jump on foot (Nov 2026, `player/foot_jump.cpp`).** player.js jumps on foot at once (4.4 m/s) and the walk / idle
carries on in the air. Here the knees load first (0.15 s from a stand, 0.075 s off a run, then the same take-off), and
the rig layers a procedural jump over the walk: the countermovement crouch with the arms back, the push-off (toes
pointed, the arms driving up; off a run the arm opposite the leading knee), the knees tucked in the air (off a run the
stride held), the legs reaching for the snow and the arms widening as it falls, the landing absorbed by the knees
(scaled by the drop, shallower off a run, the planted foot staying put), then back into the idle / walk / run. The other
players' walkers jump the same way (their height over the ground). `RigState::footJump` off (NPCs, `--verify-poses`)
leaves the rig as the JS. Frames: `SKI_LEGACY_RIGSHOTS=jump ./ski_legacy --rig-shots out.png` writes
`out_jump_{stand,run,sprint}[_js].png` (every 0.1 s from 0.3 s before the press; `_js`: the web game's jump;
`SKI_LEGACY_JUMPVIEW=front` for a three-quarter view).

## Moved sites (Nov 2026, village round 2, C++ only)

`native/tools/village/village_layout.mjs` can carry a whole site of the exported world elsewhere (`moveSite(name, from,
r, to, rot)`, written to `village.json` "moves"). `world/village.cpp` `applyMoves` runs on every pack as it loads:
props and instanced pieces, colliders (rot, top), walkable decks, the baked triangles whose centre lies within r of
`from` (copied into a mesh of their own, turned and raised), and the gameplay data's places in `play` / `net` (points
with x / z and their y, yaw and frame directions, `at` / `sock` spots, the prison's frames, a path leaving the site:
its first points carried, then on from the nearest of the rest). The relief under the new site copies the old ground
(raised by dy), so everything sits as it sat. The JS game is untouched; saves keep working (nothing of a site is saved
by position except a rescue in progress, which is on the mountain).

- **Heliport** (the pad, the rental hut, the windsock, the ambulance's bay): from (92, -128), at the end of the
  Bergbahnstrasse among chalets, to (170, 52) on the open meadow at the village's east edge (the medical centre 65 m
  south, the Adlerhorn Gondola's line 68 m north, the nearest building 37 m away, the east car park and road 25-30 m),
  reached on foot by the new
  Heliweg from the Adlerhornweg past the Gasthof Adlerhorn. Rental, flight, landing home, the rescue and the ambulance
  run unchanged (`SKI_LEGACY_DEBUG=helicheck` / `rescuetest` PASS: landed on the pad, the ambulance to the medical
  centre).

### Round 3: the Dorfstrasse, the Autohaus / police / Werkstatt in the village, footpaths, trees off the roads

- **The Dorfstrasse** (`village.json` "roads", `Village::addRoads`): the valley road used to end at the Legacy Village
  stop (the bus terminus, (4, 46)); a road now runs on from there along the depot road's bend, west between the Hotel
  Tirolerhof (now at z 33) and the Hotel Silberhorn (now at z 76) where the Silberhornweg was, and straight west along
  z 50 at the Oberdorf's foot to its end at (-172, 50) (~190 m, 30 km/h). It is appended to the transport pack's road
  network as it loads (heights from the drawn ground, smoothed; the relief is level across it), so the car's road
  surface and tarmac, the speed limit, police routing and traffic all have it; traffic on the valley road runs on into
  it at the stop and back (`Traffic` links: a main road's end meeting a village road's end). Drawn with the exported
  roads' own ribbon (`roadsnow-road`: the road snow look), left out where an exported road already lies; lamps by turns
  on both sides and the plough's banks along the edges; walkers have its south edge in the walking network.
  **Cut into the ground** (Nov 16): the ribbon was wound clockwise seen from above (culled: only its shadow was
  drawn), and in the west it crossed a piste's run-out whose exported cuts lift the ground up to 5 m over the layout's
  level. Now `Village::prepareRoads` levels the road along its middle (the C++ ground there, smoothed over +-16 m) and
  `World::height` (`Village::roadCut`) holds the ground 6 cm under that level across the ribbon and a flat 2.6 m
  shoulder, easing back over 5 m (cut and fill; only cut within 24 m of the valley road); the network line and the
  ribbon (3.5 cm over the level: the car's road surface) use the same level. Off with the relief (`--verify-heights`).
- **Sites moved onto it** (moves with a clip: only what lies short of the road in front of the old yard goes, so the
  valley road stays whole; play-data box colliders' `rot` now turn with a move): the **Autohaus** (134, 213) -> (-90, 33),
  the **police station / prison** (150, 262) -> (-124, 34), the **Werkstatt** (156, 293) -> (-152, 35), each turned so its
  yard faces the Dorfstrasse as it faced the valley road, at the same distance from the road's middle (17.0 / 16.0 /
  14.9 m; their floor level `y` is what lands on the new ground: the old yards stood in the valley road's cuts, so the
  copied ground is held 6 cm under it). Their buildings, rooms, doors, yards, tow trucks, patrol car bay, lots (frames and exits) and colliders go with
  them. The Autohaus car park (impound) stays on the valley road. The chalets Stadel and Haus Bergfrieden stand across
  the road now.
- **Footpaths**: the Postgasse and the Werkstattgasse from the Dorfstrasse up to the Kapellenweg; the Bahnhofstiege from
  the square's north-west corner straight up the terraces (ramps through the terrace walls at each terrace's level) to
  the Legacy Express station's exit.
- **Trees**: every layout tree is checked against all roads, car parks / yards (as moved), the moved sites and the
  footpaths, and moved off to the nearest clear spot (9 of 30 moved).
- Not done yet: the trail map draws its roads from `map.json` (the Dorfstrasse is not on it), the ski shop is not
  moved, the village core is not compacted.

### Round 4: the village audit (Nov 2026, the user: "there are houses on the train track in the village")

`SKI_LEGACY_DEBUG=villagecheck --autotest` (`game/villagecheck.h`) checks every village piece as placed (the buildings,
the props with their models' bounds: walls, lamps, trees by the trunk, benches, fountains, shelters; the relief; the
moved sites as discs) and logs each hit with its name and place, then PASS / FAIL:
`rail` (both railways' track envelope + 4.5 m for a house, + 4 m along the stations; not deep in a tunnel, but at its
portals), `road` (every road and bus leg with its shoulder, the car parks, the stops), `lift` (stations, towers, the cars
passing low over), `piste` (inside a piste / race corridor), `path` (on a paved footpath; the walking network into a
house or wall or up a step), `overlap` (houses, walls, trees / lamps / benches in them), `ground` (a house with the
drawn ground more than 0.9 m over its base or a corner floating, its door buried or hanging; small props on a step),
`relief` (the terraces raising a railway's bed, an exported road, a lift station). Before: 110 hits (rail 4, ground 17,
path 46, overlap 7, piste 3, road 2, relief 31); after: 0.
- **On the tracks**: the Bergbahnstrasse quarter (Hotel Walliserhof, Ski Service Pro, Chalet Bergkristall, Haus Enzian)
  stood on the Legacy Express's open cutting at its tunnel portal (47, -74); it is east of the line now, over the
  tunnel, the Bergbahnstrasse round the north of the church's knoll and over the tunnel 30 m past the portal.
  Intersport moved clear of the portal. The terraces' fade raised the Express's station track by up to 1.2 m: the
  railways' beds are kept things of the relief now.
- **Sunk houses**: every building has a pad (`village.json` "pads", `Village::prepareRoads` / `padLevel`): the drawn
  ground levelled under its footprint (+0.8 m) at the level in front of its door, easing back over 5 m (as the JS
  levels its buildings' sites). Off with the relief.
- **Clearances in the layout tool**: every building is settled (`buildingBlocked`: railways, pistes, roads and bus legs,
  car parks, lifts, footpaths, the other houses, the moved sites, the knoll, one terrace each) to the nearest clear spot;
  walls skip footpaths and houses by their ends too; lamps, trees, benches and fountains keep off houses, walls,
  paths, steps, pistes, roads and the railways. Stadel and Haus Bergfrieden left the Silberhorn piste for the
  Dorfstrasse's east part; the Kapellenweg and the Bahnhofweg ramp through the terrace walls; two new lanes south of
  the Dorfstrasse (Lärchenweg, Rathausweg); a paved path from every door to its street by a way clear of houses,
  walls and roads (`door <name>` in `paths`). `node native/tools/village/village_layout.mjs --dry` runs it without
  writing (its `AUDIT` lines: a quick version of the check).

## Status: the native port against the JavaScript game

| area | JS game (`src/`) | native (`native/`) |
|---|---|---|
| terrain, heights, cuts, regions | world.js, terrain.js | **ported** (`--verify-heights`: base heights and the physics surface within 2.5 mm of the JS, the regions on their 8 m grid), streamed quadtree LOD |
| skiing physics, crashes, walking | player.js | **ported** (fixed 120 Hz, the same constants), + ski stats (Phase 7) |
| skier rig | skier.js (full procedural rig, pole plants, first-person gloves) | clips + procedural stance, poles in the hands, outfits recoloured; no pole plants / first-person arms |
| trees, forest thinning | vegetation.js | **ported** (cells, LODs, the railways' thinning); no boulders / scree, no impostors |
| village, resort, signs, stations | village.js, decor.js, resortdressing.js, gondolastation.js, stationbuildings.js | **ported** (exported from the JS + the gondola stations as a C++ builder); no huts' interiors, no terrain park |
| lifts (18), riding | lifts.js | **ported** (exact motion, boarding, mid-stations, x16) |
| roads, tunnels, traffic, parking | roads.js, transport.js, traffic.js, parking.js | **ported** (traffic without the bay arcs / scenic walks) |
| your car, Autohaus, garage | drive.js, carrental.js, carconfig.js | **ported** physics, damage, wheels rolling / steering, lights, paint and its finish, rims, plates, the configurator on the showroom's car, the walk-in showroom (salesman, marker, sliding doors, mirror floor, the view out), the tow trucks parked; no interior trims, dents, tow job |
| ski bus, Wolkenspitzbahn, Legacy Express | bus.js, railway.js, express.js | **ported** (timetables, riding, x8 / x6 / x10, the blue Express livery, horns, the rail PA) |
| menus, HUD, settings, controls | menu.js, hud.js, settings.js, bindings.js | **ported** (all rows incl. rebinding, glyphs for Xbox / PlayStation / Switch, Bloom / Announcer added) |
| trail map | trailmap.js | **ported** (relief, pistes, lifts, roads, rails, markers, waypoint) |
| economy, shops, saves | economy.js, outfitshop.js, interior.js | **ported** (the same save JSON); the walk-in ski shop with the outfit podium, the kits, the clerk's conversation |
| races, records, prizes | modes/race, freeworld.js | **ported** (11 courses, bus races, stand, AI field, announcer); no broadcast presentation, no ghosts |
| jobs, taxi | jobs/*.js, taxi.js | **ported** (simplified dialogue, no lost & found) |
| police, prison, impound | police.js, prison.js, prisonoutside.js, impound.js | **ported** (chases, heli, arrest, jail, sirens; the station inside and outside as built by the web game); no roadblocks / spikes / raids |
| helicopter (heli-ski), rescue, ambulance, hospital ward | heli.js, heli/*.js, hospitalroom.js | **ported** (the flight model, pad, rotors, landing, the ward as built by the web game; a card flight planner, live window views) |
| chalets, build mode | chalets.js, chaletroom.js, build/* | **ported** (the house with both floors, its doors and lamps, the village's gardens and bays; the catalogue, virtual mouse; build mode on the ground floor) |
| people, crowds | townsfolk.js, peoplesim.js, fans.js, crowds.js | **ported** (the village's townsfolk as fans.js's crowd people; no spectators' cheering, no lift-base people) |
| snowmobiles | snowmobile.js | **ported** |
| weather, day / night | sky.js, atmosphere.js | **ported** (11 states, forecast, snowfall, lamps' light pools; Phase 8: the full sky shader, stars / moon, IBL; Nov 15 2026: atmosphere.js's cumulus impostors and overcast deck); no backdrop ranges |
| snowmaking, flags, snowcats | snowmaking.js, flags.js, snowcats.js | **ported** (Phase 7; snowcats condensed: no grooming trail, no ploughs) |
| audio | core/audio.js | **ported** (Phase 7: every recording, music, announcer, horns, 3D); the Express's text-to-speech PA lines are not spoken (gong only) |
| multiplayer | net/*.js against server/ | **ported** (the unchanged server; the other players as the game's own skier rig posed from their rows as remote.js poseOne: walking with / without skis, the skis on the back, carving, the tuck, in the air, a wipeout's tumble, seated; remote.js's playout delay, lead and smoothing; your rescue sent as net/rescue.js and the others' rescues drawn (helicopter, winch rope, the patient on the hook / in the cabin / hidden in the ambulance, the ambulance); flying your helicopter is state fly with its pose, the others' helicopters drawn; `SKI_LEGACY_DEBUG=mpshow --mptest URL --mp-peers 1` with `tools/browser/mp_show_peer.mjs` plays it all and writes `out_mpshow_<s>.png`. Not ported: the others' outfits (their character only) and ski model, the name card riding on the rig, the heli rental through the server (heliRent / the pad's `padAt`), tow trucks, police cars after another player, shared bus timelines (busHold / bus|R keys), a patient's bed pose in the ward). Nov 15 2026: the race queue with the others (raceJoin: the server's one start for everyone, the grid slots, the live progress, the server's ranking and prize; at most 14 humans: the client refuses the 15th; the server's 45 s countdown and 21 cap are its own), a race alone against the AI field pays its prize online too (entry and prize through the server's spend / earn), the world's weather settled at once on joining and kept during races, the online pill bottom left while racing, a ward bed per player (pid % 4) |
| parkour mode, terrain park, tricks | modes/parkour, park.js, tricks.js | **not ported** |
| post: bloom, streaks, vignette, AO, sun shafts, glare | engine/post.js, sunglare.js | **ported** (Phase 8: mip-chain bloom, GTAO, shafts, glare, PBR Neutral / ACES + grade, MSAA + FXAA + sharpen) |

## Nintendo Switch porting checklist

Nothing below can live in this repository (NDA); the code base is arranged so each item is one backend or one data
step. In order:

1. **Become a licensed developer**: register on the Nintendo Developer Portal (developer.nintendo.com), apply for the
   Nintendo Switch program as a company / sole trader with the game's pitch; sign the agreements. This unlocks the
   **NintendoSDK** (clang-based toolchain with a CMake toolchain file, the system libraries `nn::*`, the documentation),
   **dev kits** (SDEV / EDEV), the guidelines and **Lotcheck** submission, and the **SDL2 Switch port**.
2. **Graphics (`gfx/`)**: add `gfx/nvn/` (NVN: Nintendo's native API, best performance) or `gfx/vulkan/` (the SDK's
   Vulkan driver) implementing `gfx::Device` (`gfx/gfx.h`: buffers, textures incl. `createCompressedTexture` (BC1/BC3,
   or switch the offline step to **ASTC**), programs, vertex inputs, render targets, pipeline state, draws, the frame
   stats). Compile the GLSL in `engine/shaders.h` offline (the SDK's shader compiler / glslc to SPIR-V): one program per
   variant (`SKINNED`, `INSTANCED`, `INSTMAT`, `SL_LOW`, terrain, depth, sky, post, bloom, HUD, UI).
3. **Platform (`platform/`)**: the official **SDL2 Switch port** (then `platform/sdl/` mostly carries over), or
   `platform/switch/platform_switch.cpp` on `nn::*` — the contract is in `src/platform/switch/switch_platform.h`:
   display / operation mode (docked 1080p, handheld 720p) and resize events; Joy-Con (dual, single sideways, handheld)
   and Pro Controller through **`nn::hid`**, mapped by position (Switch B = index 0) and the **controller applet**
   (`nn::hid::ShowControllerSupport`); **HD Rumble**; the touch screen as the pointer in menus (optional); time;
   memory queries (`memoryBytes` / `peakMemoryBytes`); **audio** on `nn::audio` (the mixer is ours: one 48 kHz stream).
4. **Network (`net/`)**: replace `net/socket_stream.cpp` (BSD sockets + mbedTLS) with **`nn::socket`** + **`nn::ssl`**
   behind `net/stream.h`; initialise the network with **`nn::nifm`** (request the connection, show the error applet).
   Online play needs a **Nintendo Account**, a **Nintendo Switch Online** entitlement check, and Nintendo's online rules
   (or NEX / NPLN instead of our own server, per your agreement). Chat must be filterable / blockable (parental controls).
5. **Save data**: `writeSave` / `readSave` on **`nn::fs`** (`MountSaveData` for the preselected user, write to a temp
   file then rename, **`CommitSaveData`** after each write; declare the journal size in the `.nmeta`); the save is one
   ~10 KB JSON (`ski-legacy-save-v1.json`) written on purchases, settings and every 60 s.
6. **Account**: **`nn::account`** — the preselected user (`StartupUserAccount` in the `.nmeta`), its nickname for
   `userName()` (the multiplayer name field's suggestion; typed names go through the **software keyboard applet**
   `nn::swkbd`).
7. **ROM data**: package `assets/` (the 148 models, `data/` incl. `audio/`) into the ROM file system (`rom:/`, `MountRom`);
   for a smaller download and faster loads bake the GLBs' textures offline to ASTC / BC (the build's `texcompress` does
   BC at load today) and pre-build the trees' LODs.
8. **Lotcheck items** (the guidelines; plan for them from the start): Switch terms and **button glyphs** everywhere (the
   prompts already switch to Switch glyphs and A / B confirm / back for `PadFamily::Switch`; no keyboard / mouse text in
   menus), the controller applet when no controller is connected, **suspend / resume** (HOME button, sleep: pause the
   game, mute, stop rumble — `Events::focusLost` / `focusGained`; `nn::oe` messages for focus, operation mode, exit
   requests), no hangs on long play or bad networks, **loading screens** with progress and within the time limits, save
   data never corrupt on power loss (commit), the **memory limits** of the application heap (the switch preset's peak
   RSS below, measured with software rendering where GPU memory is counted too), user-visible **strings** localised per
   region and no unsupported characters, the error applet for network errors, **age ratings** (IARC, ESRB, PEGI, USK,
   CERO...: violence (police chases, car crashes) is mild; online interactions), the copyright / licences screen (the
   sounds' CREDITS.txt, the open-source libraries: SDL2 zlib, glm MIT, meshoptimizer MIT, libwebp BSD, stb public
   domain, cgltf MIT, nlohmann_json MIT, zstd BSD, mbedTLS Apache-2.0).
9. **Performance on the hardware** (to verify on a dev kit — see "Performance" below): 30 fps docked and handheld with
   the switch preset, GPU time per pass with the SDK's profiler, the CPU systems on the A57s (the simulation, streaming
   and audio on worker threads), dynamic resolution bounds, thermal throttling in handheld mode, memory below the heap
   limit after an hour of play (streaming in and out), the BC / ASTC choice, shader variants' cost.

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
| **7 (done)** | audio (a mixer on the platform stream, every `public/audio` recording as Ogg Vorbis, music playlists, the announcer and the rail PA, rendered air horns, 3D sound, volumes / mute in background); visual polish (wheels rolling / steering, headlights and lamp light pools, paint and plates, the Express livery, the canopy fix, forest thinning, snowmaking, flags, snowcats, outfits, ski stats, poles, bloom / screen effects / camera shake); the `switch` preset (512 BC textures, triangle budget, LOD bias, half the NPCs, simplified shaders, dynamic resolution), streaming of the mesh chunks, packed vertices, the `[perf]` report; packaging (.app / .dmg, .zip, .tar.gz) and `native.yml` (`latest-native`). Still open: on-hardware profiling, ASTC, Lotcheck, the not-ported features in the status table |
