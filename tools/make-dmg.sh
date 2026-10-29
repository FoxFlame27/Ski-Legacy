#!/usr/bin/env bash
# Ski Legacy: a shareable .dmg (macOS only: hdiutil, codesign). Run from the game's folder:  npm run app:dmg
# Builds the app (npm run app:package), signs it ad hoc (no Apple developer account: Apple Silicon Macs refuse to
# start an app whose signature is broken, and packaging changes the Electron app), then packs it with an
# Applications shortcut into release/Ski Legacy.dmg.
# Whoever you send it to: open the .dmg, drag Ski Legacy into Applications, then the first time right-click the app,
# Open, Open (it is not from the App Store, so macOS asks once). If macOS says it is "damaged":
#   xattr -cr "/Applications/Ski Legacy.app"
set -euo pipefail
cd "$(dirname "$0")/.."

APP="release/Ski Legacy-darwin-arm64/Ski Legacy.app"
STAGE="release/dmg"
DMG="release/Ski Legacy.dmg"

npm run app:package
codesign --force --deep --sign - "$APP"
rm -rf "$STAGE" "$DMG"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "Ski Legacy" -srcfolder "$STAGE" -ov -format UDZO "$DMG"
rm -rf "$STAGE"
echo
echo "Done: $(pwd)/$DMG ($(du -h "$DMG" | cut -f1))"
echo "It runs on Apple Silicon Macs (M1 and newer)."
