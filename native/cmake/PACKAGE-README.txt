Ski Legacy - native build (C++, OpenGL 4.1)

  macOS:   open the disk image and drag "Ski Legacy" into Applications. The app is not signed: the first time,
           right-click it, Open, Open (or: xattr -cr "/Applications/Ski Legacy.app").
  Windows: unzip anywhere and run SkiLegacy.exe (keep the assets folder next to it).
  Linux:   untar anywhere and run ./ski-legacy.sh (or ./ski_legacy). Needs OpenGL 4.1 and SDL's usual X11 / Wayland
           and ALSA / PulseAudio libraries.

Command line: --quality switch|low|medium|high|ultra, --fullscreen, --size 1600x900, --no-menu, --hour 21
Saves: the platform's per-user folder (macOS ~/Library/Application Support/SkiLegacy/SkiLegacy, Windows
%APPDATA%\SkiLegacy\SkiLegacy, Linux ~/.local/share/SkiLegacy/SkiLegacy).
Sounds: CC0 / licensed recordings, see assets/data/audio/CREDITS.txt.
