#!/bin/bash
# Re-export Meshy GLBs for the game from the untouched originals in assets-src/raw.
# Full 2048px PBR textures (WebP) keep models crisp up close; meshopt compresses geometry.
cd "$(dirname "$0")/.."
mkdir -p assets-src/raw
for f in public/models/*.glb; do
  name=$(basename "$f")
  raw="assets-src/raw/$name"
  size=$(stat -f%z "$f")
  # a file without meshopt compression is a fresh Meshy download: it becomes the new original
  if ! grep -aq "EXT_meshopt_compression" "$f"; then cp "$f" "$raw"; touch "$raw"; fi
done
for raw in assets-src/raw/*.glb; do
  name=$(basename "$raw")
  out="public/models/$name"
  if [ -n "$1" ] || [ ! -f "$out" ] || [ "$raw" -nt "$out" ] || ! grep -aq "EXT_meshopt_compression" "$out"; then
    tsize=2048
    case "$name" in *_anims.glb|*_walk.glb|*_run.glb) tsize=64;; esac
    npx gltf-transform optimize "$raw" "$out" --texture-compress webp --texture-size $tsize --compress meshopt --simplify false --instance false --join false 2>&1 | grep -iE "^error" 
    echo "exported $name -> $(( $(stat -f%z "$out") / 1024 )) KB"
  fi
done
