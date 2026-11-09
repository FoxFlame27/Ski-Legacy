#!/bin/sh
# Ski Legacy (native) launcher: runs the game from its own folder (the assets/ folder next to it).
cd "$(dirname "$0")" && exec ./ski_legacy "$@"
