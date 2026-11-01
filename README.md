# Ski-Legacy

## Windows

The Windows version is one file, `Ski Legacy.exe`: a portable app (64-bit, Windows 10 and 11). There is nothing to install. It unpacks itself and starts the game.

### Building it

- **On your Mac:** run `npm run app:win`. You get `release/Ski Legacy.exe` (about 250 MB). It builds on macOS (and Linux) without wine, with the game icon included. The first build downloads the Windows Electron and NSIS tools, so it takes a few minutes.
- **On GitHub:** every push to `legacy-express` builds it on a Windows machine (`.github/workflows/windows.yml`). You can also start it from the **Actions** tab (**Windows build**, then **Run workflow**). The newest build is always at
  https://github.com/FoxFlame27/Ski-Legacy/releases/download/latest-windows/Ski-Legacy.exe
  and it is also attached to each run as the `Ski-Legacy-Windows` artifact (GitHub zips artifacts).
- To change the icon, update `build/icon.png`, then run `npm run app:win:icon` to rebuild `build/icon.ico`.

### Playing it (for friends)

1. Download `Ski Legacy.exe` (or `Ski-Legacy.exe`) and double-click it. The first start takes a few seconds while it unpacks.
2. The game is not code-signed, so Windows SmartScreen may say **"Windows protected your PC"**. Click **More info**, then **Run anyway**. Windows only asks the first time.
3. The game opens fullscreen. Press **F11** for a window, and **Alt+F4** (or Quit in the game menu) to close it. Saves and settings stay on the PC (in `%APPDATA%\Ski Legacy`), and multiplayer works the same as on the Mac.
