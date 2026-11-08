# Run before the data export (cmake -DROOT=<repo> -P CheckNodeModules.cmake): the exporters import the game's own
# modules and three.js from the repository's node_modules.
foreach(m three @fontsource/barlow-condensed @fontsource-variable/inter)
  if(NOT EXISTS "${ROOT}/node_modules/${m}/package.json")
    message(FATAL_ERROR "node_modules/${m} is missing: run `npm install` in the repo root (${ROOT}) so the build can export native/data.")
  endif()
endforeach()
