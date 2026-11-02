# Ski Legacy on Steam

The game is Steam-ready: optional Steamworks (achievements, rich presence, overlay), folder builds for Windows,
macOS and Linux / Steam Deck, and SteamPipe upload scripts. What is left is the account side and filling in the IDs.
Steamworks pages and rules change: where a number or a menu name below differs from the current
[Steamworks documentation](https://partner.steamgames.com/doc/home), the docs win.

## What is in the repo

| File | What it does |
| --- | --- |
| `electron/steam.cjs` | Main process: finds the App ID, `restartAppIfNecessary`, `steamworks.init`, the overlay, the IPC calls. Never crashes without Steam. |
| `electron/preload.cjs` | Gives the page `window.steam = { available, playerName, onDeck, unlock(id), setStat(name, v), richPresence(key, val), overlayActive() }`. |
| `src/core/steam.js` | The 23 achievements and where they unlock (no-ops without Steam), rich presence (`#Status_Location`). |
| `steam/achievements.md` | The table to enter in Steamworks (API name, name, description) and the icon spec. |
| `steam/rich_presence_english.vdf` | Rich presence localization file to upload. |
| `steam/app_build_APPID.vdf`, `steam/depot_build_{windows,mac,linux}.vdf` | SteamPipe templates (placeholders). |
| `steam/make-vdf.mjs` (`npm run steam:vdf`) | Writes filled-in SteamPipe scripts to `steam/output/scripts/` from the IDs in `package.json`. |
| `.github/workflows/steam.yml` | Manual-only CI: builds the three Steam folders as artifacts (no upload, no secrets). |

## 1. Your part in Steamworks (one time)

1. Create a Steamworks partner account: <https://partner.steamgames.com/> (Steam account with Steam Guard, legal
   name / company, bank and **tax interview**, identity verification).
2. Pay the **Steam Direct fee** (USD 100 per game, recoupable after USD 1,000 gross revenue).
3. You get an **App ID** (e.g. 3456780). In *App Admin -> SteamPipe -> Depots* create (or rename the default) depots,
   one per OS, and note their **depot IDs** (usually App ID + 1, + 2, + 3):
   - Windows depot: *Operating system* = Windows, 64-bit
   - macOS depot: *Operating system* = macOS
   - Linux depot: *Operating system* = Linux + SteamOS
4. *App Admin -> Installation -> General* **Launch options** (one per OS):
   - Windows: executable `Ski Legacy.exe`, OS Windows
   - macOS: executable `Ski Legacy.app`, OS macOS
   - Linux: executable `ski-legacy`, OS Linux + SteamOS
5. *Stats & Achievements*: enter the achievements from `steam/achievements.md` (API names exactly), upload icons, **Publish**.
6. *Community -> Rich Presence*: upload `steam/rich_presence_english.vdf`.
7. Publish the app configuration changes (*Publish* tab) every time you change settings.

## 2. Put the IDs in the project

In `package.json`:

```json
"steam": { "appId": 3456780, "depots": { "windows": 3456781, "mac": 3456782, "linux": 3456783 }, "buildDesc": "Ski Legacy", "setLive": "" }
```

The IDs are not secret. Your Steam login is never stored in the repo (SteamCMD asks for it).
Environment variables override the file: `STEAM_APP_ID`, `STEAM_DEPOT_WINDOWS`, `STEAM_DEPOT_MAC`, `STEAM_DEPOT_LINUX`, `STEAM_SET_LIVE`.

`steam.appId` is only used by Steam builds (`npm run steam:*` sets `"steamBuild": true` in the packaged
package.json). The GitHub `.exe` / `.dmg` builds (`windows.yml`, `mac.yml`) never start Steam.

## 3. Test Steamworks locally (before you have your App ID too)

- With the Steam client running and logged in: `STEAM_APP_ID=480 npm run app` (480 = Valve's *Spacewar* test app;
  achievements will not match, but init, your player name and the Shift+Tab overlay can be checked). With your own App ID
  (which your account owns once it exists) achievements unlock for real; reset them in Steamworks while testing.
- Or put a `steam_appid.txt` with just the number in the project folder (gitignored, never packaged, excluded from
  depots). Steam's rule: release builds get the App ID from Steam itself, `steam_appid.txt` is for development only.
- The console prints `[steam] ready · app N` or why Steam was skipped. In DevTools (Ctrl+Shift+I): `window.steam`.
- A packaged Steam build started outside Steam asks Steam to launch it and quits (`restartAppIfNecessary`); a
  `steam_appid.txt` next to the executable, `STEAM_APP_ID`, or `STEAM_NO_RESTART=1` turns that off for testing.

## 4. Build the Steam folders

Steam wants a plain folder per OS (no installer, no portable exe):

| Command | Run on | Output folder (depot content) |
| --- | --- | --- |
| `npm run steam:win` | Windows (or Linux/Mac with Wine) | `release/steam/win/win-unpacked/` |
| `npm run steam:mac` | a Mac (codesign) | `release/steam/mac/mac-universal/Ski Legacy.app` (Intel + Apple Silicon) |
| `npm run steam:linux` | Linux (or Mac) | `release/steam/linux/linux-unpacked/` (Steam Deck / SteamOS) |

Or run the **Steam builds** workflow on GitHub (Actions -> Steam builds -> Run workflow) and download the three
artifacts: Windows is the folder itself; mac and Linux come as a `.tar` inside the artifact zip (to keep symlinks and
the executable bit): `mkdir -p release/steam/linux/linux-unpacked && tar -xf Ski-Legacy-Steam-Linux.tar -C release/steam/linux/linux-unpacked`
(mac: `release/steam/mac/mac-universal`).

Notes:
- The native Steamworks binaries (`node_modules/steamworks.js/dist/<os>/`) are copied into each build, only the
  current OS's (asar is off, so they load as plain files).
- macOS: the app is signed **ad hoc** (`codesign --sign -`), like the dmg. That is enough for Steam on Apple Silicon
  (Steam does not require notarization), but Gatekeeper may still warn on some systems. For a smoother experience use a
  paid Apple Developer ID: set `build.mac.identity` to it and enable `hardenedRuntime` + notarization in electron-builder.
  Upload the mac depot **from a Mac** (SteamCMD on macOS keeps the symlinks inside `Electron Framework.framework`).
- Linux / Steam Deck: if the native Linux build refuses to start under Steam with a "SUID sandbox helper" error
  (Chromium's sandbox inside the Steam Linux Runtime), add `--no-sandbox` as the Linux launch option's *Arguments*
  in Steamworks. Alternatively ship only the Windows depot and let the Deck run it through Proton (*Steam Play*):
  test both and keep whichever runs better.

## 5. Upload with SteamPipe (SteamCMD)

1. Download SteamCMD: <https://developer.valvesoftware.com/wiki/SteamCMD> (Windows zip, `brew install --cask steamcmd`,
   or the Linux tarball). The Steamworks SDK (*tools/ContentBuilder*) has it too.
2. Give the Steam account that uploads the *Edit App Metadata* and *Publish App Changes To Steam* permissions
   (Steamworks -> Users & Permissions). A separate build account with Steam Guard is recommended.
3. Build the folders (step 4), then:

   ```sh
   npm run steam:vdf                       # writes steam/output/scripts/app_build_<APPID>.vdf (+ depot scripts)
   steamcmd +login <steam_user> +run_app_build "<full path printed above>" +quit
   ```

   The first login asks for your password and the Steam Guard code; later logins are cached. (Without the generator:
   copy `steam/app_build_APPID.vdf` and the depot templates, replace `APPID` / `WIN_DEPOT` / `MAC_DEPOT` / `LINUX_DEPOT`.)
4. Steamworks -> *App Admin -> SteamPipe -> Builds*: the new build appears. **Set it live on the `default` branch**
   (or a `beta` branch first; `"setLive": "beta"` in package.json does that automatically for a non-default branch).
   Steam does not let a script set `default` live for released apps on its own: do it on that page.
5. Install through your Steam library and play it once per OS before release.

## 6. Steam Deck (Verified) checklist

Controller support and button prompts already exist (Xbox / PlayStation glyphs, rebinding). Before requesting review:
- **Default controller config**: in Steamworks -> *Steam Input* set "Gamepad with ... support" and that the game uses
  its own controller support; test that the game never shows keyboard prompts while a pad is used.
- **Resolution 1280x800 (16:10)**: run the game in a 1280x800 window and check the HUD, menus, shop and race cards fit
  and are not cut off; the game opens fullscreen (fine on the Deck).
- **Text size**: Valve asks that the smallest text be at least ~9 px tall at 1280x800 (12 px recommended). Check the
  HUD, prompts, the trail map and small labels. `window.steam.onDeck` (`steamOnDeck()` in `src/core/steam.js`) is there
  if you want a bigger UI scale on the Deck.
- **Text input**: any text field (multiplayer name, chat) must bring up the on-screen keyboard; Steam can do it via
  `utils.showGamepadTextInput` in steamworks.js, not wired yet.
- **No launcher, no mouse-only screens**, no external browser windows needed to play, sensible default graphics
  (the quality auto-detect) and 30+ fps.
- Pause when the overlay or the Steam button menu opens (the game pauses on focus loss / pointer-lock loss).
- Battery / suspend: the game should survive the Deck going to sleep and waking up.

## 7. Store page assets (check current sizes in Steamworks -> Store Page -> Graphical Assets)

| Asset | Size (px) |
| --- | --- |
| Header capsule | 920 x 430 |
| Small capsule | 462 x 174 |
| Main capsule | 1232 x 706 |
| Vertical capsule | 748 x 896 |
| Page background (optional) | 1438 x 810 |
| Library capsule | 600 x 900 |
| Library header | 920 x 430 |
| Library hero | 3840 x 1240 (no text, no logo) |
| Library logo | 1280 wide and/or 720 tall, transparent PNG |
| Screenshots | at least 5, 1920 x 1080 (16:9), gameplay only |
| Trailer | at least 1 recommended, 1920 x 1080 MP4 |
| Community icon | 184 x 184 JPG |
| Client icon / shortcut | .ico (16-256), Linux PNG icons; `build/icon.ico`, `build/icon.png` can be reused |
| Event / announcement cover | 800 x 450; header 1920 x 622 |
| Achievement icons | 256 x 256 each, achieved + unachieved (see `steam/achievements.md`) |

Capsules must show the game's logo / art only (no review quotes, awards or discount text on the base capsules).

## 8. Before release

- Store page, pricing, content survey (mature content: the game has police chases, crashes, jail), age ratings
  questionnaire (IARC, free in Steamworks), system requirements (Electron/Chromium + WebGL2: Windows 10+, macOS 11+,
  a GPU with WebGL2), privacy policy if multiplayer collects data.
- "Coming Soon" page must be live at least 2 weeks before release; the build and the store page both go through
  Valve review (a few business days each).
- **Content survey: AI-generated content.** Valve requires disclosing pre-generated AI content; many 3D models were
  made with Meshy (`tools/meshy-*.mjs`). Disclose it, and check your Meshy plan allows commercial use of the models.
- **Trademarks and third-party assets** (not changed, decide before release, ideally with legal advice):
  - The Autohaus sells real, named cars (`src/game/carrental.js`: VW Golf GTI, Tesla Model 3, BMW X3, Toyota GR Yaris,
    Audi RS6 / e-tron GT, Mercedes-Benz GLS / SLS AMG, Porsche Taycan, Lamborghini Huracán) with recognisable models
    and badges. Car makers license their names and designs to games; unlicensed use is a common reason for takedowns.
    Usual fix: fictional names ("Vulcan GT") and debadged / altered models.
  - The car models themselves come from BeamNG mods, Sketchfab and "TNR" kits (comments in `src/game/cars.js`): check
    each model's licence allows commercial redistribution (many mods do not, or are rips).
  - Sponsor banners use real logos (`src/world/sponsors.js`: Nike, Adidas, Puma, Red Bull, Rolex, Audi, Oakley,
    Salomon, Rossignol, Fischer, The North Face, GoPro, Coca-Cola, Milka, Swatch, Samsung, Toyota, Visa, BMW):
    implies endorsement; replace with fictional brands for a commercial release.
