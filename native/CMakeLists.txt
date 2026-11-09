# Ski Legacy — native (C++20) port. See README.md.
#   cmake -S native -B native/build -G Ninja -DCMAKE_BUILD_TYPE=Release && cmake --build native/build
cmake_minimum_required(VERSION 3.20)
# CMake 4 (Homebrew, GitHub's macOS runners) refuses dependencies that still say cmake_minimum_required(< 3.5)
# (glad 0.1.36): let them configure with the 3.5 policies
set(CMAKE_POLICY_VERSION_MINIMUM 3.5 CACHE STRING "Minimum policy version for fetched dependencies")
project(SkiLegacy VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "" FORCE)
endif()

option(SL_COPY_ASSETS "Copy the assets the game needs next to the executable (assets/) for packaging" OFF)
set(SL_PLATFORM "sdl" CACHE STRING "Platform backend: sdl (desktop). A 'switch' backend is added once NintendoSDK access exists.")

include(cmake/Dependencies.cmake)

file(GLOB_RECURSE SL_SOURCES CONFIGURE_DEPENDS
  src/core/*.cpp src/core/*.h
  src/gfx/*.h src/gfx/gl/*.cpp src/gfx/gl/*.h
  src/engine/*.cpp src/engine/*.h
  src/world/*.cpp src/world/*.h
  src/player/*.cpp src/player/*.h
  src/game/*.cpp src/game/*.h
  src/net/*.cpp src/net/*.h
  src/platform/*.h)
if(SL_PLATFORM STREQUAL "sdl")
  file(GLOB SL_PLATFORM_SOURCES CONFIGURE_DEPENDS src/platform/sdl/*.cpp src/platform/sdl/*.h)
else()
  message(FATAL_ERROR "Unknown SL_PLATFORM '${SL_PLATFORM}'")
endif()

add_executable(ski_legacy src/main.cpp ${SL_SOURCES} ${SL_PLATFORM_SOURCES})
target_include_directories(ski_legacy PRIVATE src)
target_link_libraries(ski_legacy PRIVATE SDL2::SDL2-static SDL2::SDL2main glm::glm meshoptimizer webpdecoder glad
  nlohmann_json::nlohmann_json sl_headeronly libzstd_static sl_vorbis)
if(NOT TARGET webpdecoder)
  target_link_libraries(ski_legacy PRIVATE webp)
endif()
target_compile_definitions(ski_legacy PRIVATE
  SL_SOURCE_ROOT="${CMAKE_CURRENT_SOURCE_DIR}"
  GLM_FORCE_XYZW_ONLY GLM_ENABLE_EXPERIMENTAL
  $<$<BOOL:${WIN32}>:NOMINMAX _CRT_SECURE_NO_WARNINGS>)
if(MSVC)
  target_compile_options(ski_legacy PRIVATE /W4 /permissive- /Zc:__cplusplus /utf-8 /wd4100 /wd4244 /wd4267 /wd4305)
else()
  target_compile_options(ski_legacy PRIVATE -Wall -Wextra -Wno-unused-parameter -Wno-missing-field-initializers)
endif()
find_package(Threads REQUIRED)
target_link_libraries(ski_legacy PRIVATE Threads::Threads)
# (Phase 6) the multiplayer client's TLS (net/socket_stream.cpp); Winsock and the certificate store on Windows
target_link_libraries(ski_legacy PRIVATE mbedtls mbedx509 mbedcrypto)
if(WIN32)
  target_link_libraries(ski_legacy PRIVATE ws2_32 crypt32)
endif()
# (Phase 7) the macOS app bundle: "Ski Legacy.app" (Info.plist, the icon, the assets in Contents/Resources/assets).
# SL_MACOS_BUNDLE=ON builds it (the packaging does); OFF keeps a plain executable for development.
option(SL_MACOS_BUNDLE "macOS: build Ski Legacy.app (assets inside Contents/Resources)" OFF)
# where -DSL_COPY_ASSETS=ON gathers the assets: next to the executable, or inside the bundle's Resources
set(SL_ASSETS_DST "$<TARGET_FILE_DIR:ski_legacy>/assets")
if(APPLE AND SL_MACOS_BUNDLE)
  set(SL_ASSETS_DST "$<TARGET_BUNDLE_CONTENT_DIR:ski_legacy>/Resources/assets")
  set(SL_ICON ${CMAKE_CURRENT_SOURCE_DIR}/../build/icon.icns)
  set_target_properties(ski_legacy PROPERTIES
    MACOSX_BUNDLE ON
    OUTPUT_NAME "Ski Legacy"
    MACOSX_BUNDLE_INFO_PLIST ${CMAKE_CURRENT_SOURCE_DIR}/cmake/Info.plist.in
    MACOSX_BUNDLE_BUNDLE_NAME "Ski Legacy"
    MACOSX_BUNDLE_GUI_IDENTIFIER "com.foxflame27.skilegacy.native"
    MACOSX_BUNDLE_BUNDLE_VERSION "${PROJECT_VERSION}"
    MACOSX_BUNDLE_SHORT_VERSION_STRING "${PROJECT_VERSION}"
    MACOSX_BUNDLE_ICON_FILE icon.icns
    MACOSX_BUNDLE_COPYRIGHT "Ski Legacy")
  if(EXISTS ${SL_ICON})
    target_sources(ski_legacy PRIVATE ${SL_ICON})
    set_source_files_properties(${SL_ICON} PROPERTIES MACOSX_PACKAGE_LOCATION Resources)
  endif()
elseif(APPLE)
  set_target_properties(ski_legacy PROPERTIES MACOSX_BUNDLE OFF)
endif()
if(WIN32)
  set_target_properties(ski_legacy PROPERTIES OUTPUT_NAME "SkiLegacy" WIN32_EXECUTABLE ON)
  if(EXISTS ${CMAKE_CURRENT_SOURCE_DIR}/../build/icon.ico)
    file(WRITE ${CMAKE_BINARY_DIR}/ski_legacy.rc "IDI_ICON1 ICON \"${CMAKE_CURRENT_SOURCE_DIR}/../build/icon.ico\"\n")
    target_sources(ski_legacy PRIVATE ${CMAKE_BINARY_DIR}/ski_legacy.rc)
  endif()
endif()

# ---------------------------------------------------------------- the exported world data (native/data, generated)
# native/data/*.zst are not committed: the build runs the exporter (node tools/export_world.mjs, which runs
# export_resort.mjs / export_net.mjs / export_fonts.mjs) when they are missing or older than the exporter scripts or the
# game's JavaScript sources they read (~2 min). Needs Node.js (>= 22.15 for zstd; older Node writes uncompressed data)
# and the repository's node_modules (npm install in the repo root). SL_EXPORT_DATA=OFF skips the step (data provided).
option(SL_EXPORT_DATA "Regenerate native/data with Node when it is missing or out of date" ON)
set(SL_DATA_DIR ${CMAKE_CURRENT_SOURCE_DIR}/data)
set(SL_DATA_FILES world.json crag.bin cuts.bin regions.bin resort.json resort.bin transport.json transport.bin play.json play.bin)
set(SL_FONT_FILES barlow-condensed-500.ttf barlow-condensed-600.ttf barlow-condensed-700.ttf barlow-condensed-700-italic.ttf
  barlow-condensed-800-italic.ttf inter.ttf)
set(SL_DATA_OUTPUTS)
foreach(f ${SL_DATA_FILES})
  list(APPEND SL_DATA_OUTPUTS ${SL_DATA_DIR}/${f}.zst)
endforeach()
foreach(f ${SL_FONT_FILES})
  list(APPEND SL_DATA_OUTPUTS ${SL_DATA_DIR}/fonts/${f})
endforeach()
if(SL_EXPORT_DATA)
  find_program(SL_NODE NAMES node nodejs)
  set(_have_data ON)
  foreach(o ${SL_DATA_OUTPUTS})
    if(NOT EXISTS ${o})
      set(_have_data OFF)
    endif()
  endforeach()
  if(NOT SL_NODE)
    if(_have_data)
      message(WARNING "Node.js not found: native/data is used as it is (not regenerated when the JS changes)")
    else()
      message(FATAL_ERROR "native/data is missing and Node.js was not found. Install Node.js (>= 22.15) and run npm install "
        "in the repo root; the build then exports the world data (node native/tools/export_world.mjs).")
    endif()
  else()
    file(GLOB_RECURSE SL_JS_SOURCES CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/../src/*.js)
    file(GLOB SL_TOOL_SCRIPTS CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/tools/*.mjs)
    add_custom_command(OUTPUT ${SL_DATA_OUTPUTS}
      COMMAND ${CMAKE_COMMAND} -DROOT=${CMAKE_CURRENT_SOURCE_DIR}/.. -P ${CMAKE_CURRENT_SOURCE_DIR}/cmake/CheckNodeModules.cmake
      COMMAND ${SL_NODE} ${CMAKE_CURRENT_SOURCE_DIR}/tools/export_world.mjs
      DEPENDS ${SL_TOOL_SCRIPTS} ${SL_JS_SOURCES} ${CMAKE_CURRENT_SOURCE_DIR}/cmake/CheckNodeModules.cmake
      WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/..
      COMMENT "Exporting the world data with Node (native/data, ~2 min)"
      VERBATIM USES_TERMINAL)
    add_custom_target(sl_data ALL DEPENDS ${SL_DATA_OUTPUTS})
    add_dependencies(ski_legacy sl_data)
  endif()
endif()

# ---------------------------------------------------------------- (Phase 7) the sounds: public/audio -> native/data/audio
# The web game's recordings are AAC (.m4a); the native build decodes Ogg Vorbis (stb_vorbis), so the build converts them
# with ffmpeg (cmake/ConvertAudio.cmake: only new / changed files; ~1 min the first time). Without ffmpeg the game still
# runs and plays its synthesized sounds (as the web game does until its recordings load). SL_FFMPEG overrides the path.
find_program(SL_FFMPEG NAMES ffmpeg)
set(SL_AUDIO_SRC ${CMAKE_CURRENT_SOURCE_DIR}/../public/audio)
if(SL_FFMPEG AND EXISTS ${SL_AUDIO_SRC})
  file(GLOB_RECURSE SL_AUDIO_FILES CONFIGURE_DEPENDS ${SL_AUDIO_SRC}/*.m4a ${SL_AUDIO_SRC}/*.ogg ${SL_AUDIO_SRC}/*.mp3 ${SL_AUDIO_SRC}/*.wav)
  set(SL_AUDIO_STAMP ${SL_DATA_DIR}/audio/.converted)
  add_custom_command(OUTPUT ${SL_AUDIO_STAMP}
    COMMAND ${CMAKE_COMMAND} -DSRC=${SL_AUDIO_SRC} -DDST=${SL_DATA_DIR}/audio -DFFMPEG=${SL_FFMPEG} -DSTAMP=${SL_AUDIO_STAMP}
            -P ${CMAKE_CURRENT_SOURCE_DIR}/cmake/ConvertAudio.cmake
    DEPENDS ${SL_AUDIO_FILES} ${CMAKE_CURRENT_SOURCE_DIR}/cmake/ConvertAudio.cmake
    COMMENT "Converting public/audio to Ogg Vorbis (native/data/audio)" VERBATIM)
  add_custom_target(sl_audio ALL DEPENDS ${SL_AUDIO_STAMP})
  add_dependencies(ski_legacy sl_audio)
elseif(NOT EXISTS ${SL_DATA_DIR}/audio)
  message(WARNING "ffmpeg not found: public/audio is not converted (native/data/audio); the game plays synthesized sounds. "
    "Install ffmpeg (brew / apt / choco install ffmpeg) or set SL_FFMPEG.")
endif()

# ---------------------------------------------------------------- packaging: assets next to the executable
# Only the models the game loads (not the whole public/ folder) plus the exported world data (native/data). The list
# is derived from what the game actually loads: tools/list_models.mjs collects every model the exported data names
# (the resort's props, the transport's vehicles, the courses, job boards, snowmobiles, the furniture catalogue...) and
# every model the C++ names (literals, and names built from a literal prefix / suffix: "furniture/" + id, "skier_" +
# colour + "_rigged"), into ${CMAKE_BINARY_DIR}/models.txt (~150 models, ~160 MB). Without Node: the fallback list below.
set(SL_FALLBACK_MODELS skier_red_rigged skier_red_anims skier_blue_rigged skier_blue_anims ski_carver ski_rental pine_tree
  pine_tree2 rental_shop ticket_booth hotel_chalet lamp_post mountain_hut sign_pole map_board snow_cannon lift_tower
  chair_terminal chair_bullwheel christmas_tree wooden_bench wooden_barrel trash_bin market_stall fire_pit picnic_table
  outdoor_ski_rack wooden_sled firewood_pile snowman wooden_fence patrol_hut deck_chair gondola_cabin chairlift_chair
  car_bmw_x3 car_audi_rs6 car_vw_golf_gti car_tesla_m3 car_mercedes_sls car_porsche_taycan car_lamborghini_huracan
  car_toyota_gr_yaris car_audi_etron_gt car_mercedes_gls ski_bus_micruss rail_car2 bus_stop_sign parking_pay_machine
  parking_sign floodlight_head_c)
if(SL_COPY_ASSETS)
  set(_list ${CMAKE_BINARY_DIR}/models.txt)
  find_program(SL_NODE_COPY NAMES node nodejs)
  if(SL_NODE_COPY)
    file(GLOB_RECURSE _cpp CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/src/*.cpp ${CMAKE_CURRENT_SOURCE_DIR}/src/*.h)
    add_custom_command(OUTPUT ${_list}
      COMMAND ${SL_NODE_COPY} ${CMAKE_CURRENT_SOURCE_DIR}/tools/list_models.mjs ${_list}
      DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/tools/list_models.mjs ${_cpp} ${SL_DATA_OUTPUTS}
      COMMENT "Listing the models the game loads (models.txt)" VERBATIM)
  else()
    string(REPLACE ";" "\n" _fb "${SL_FALLBACK_MODELS}")
    file(WRITE ${_list} "${_fb}\n")
  endif()
  add_custom_target(sl_models ALL DEPENDS ${_list})
  add_dependencies(ski_legacy sl_models)
  add_custom_command(TARGET ski_legacy POST_BUILD
    COMMAND ${CMAKE_COMMAND} -DLIST=${_list} -DSRC=${CMAKE_CURRENT_SOURCE_DIR}/../public/models
            -DDST=${SL_ASSETS_DST} -DDATA=${CMAKE_CURRENT_SOURCE_DIR}/data -P ${CMAKE_CURRENT_SOURCE_DIR}/cmake/CopyAssets.cmake
    COMMENT "Copying the game's assets next to the executable (assets/)")
endif()

# ---------------------------------------------------------------- (Phase 7) install + package
# cmake --install native/build --prefix <dir> lays out a self-contained game (needs -DSL_COPY_ASSETS=ON, so the assets
# are gathered next to the executable first):
#   macOS (SL_MACOS_BUNDLE=ON): <dir>/Ski Legacy.app (assets in Contents/Resources/assets)
#   Windows: <dir>/SkiLegacy.exe + assets/        Linux: <dir>/ski_legacy + assets/ + ski-legacy.sh
# cpack (or the "package" target) zips it: Ski-Legacy-Native-<system>.zip / .tar.gz / .dmg (DragNDrop on macOS).
# .github/workflows/native.yml builds all three and publishes them as the rolling "latest-native" release.
if(APPLE AND SL_MACOS_BUNDLE)
  install(TARGETS ski_legacy BUNDLE DESTINATION . COMPONENT game)   # (the assets are inside it: Contents/Resources/assets)
else()
  install(TARGETS ski_legacy RUNTIME DESTINATION . COMPONENT game)
  if(SL_COPY_ASSETS)
    install(CODE "file(INSTALL DESTINATION \"\${CMAKE_INSTALL_PREFIX}\" TYPE DIRECTORY FILES \"$<TARGET_FILE_DIR:ski_legacy>/assets\")" COMPONENT game)
  endif()
  if(UNIX)
    install(PROGRAMS ${CMAKE_CURRENT_SOURCE_DIR}/cmake/ski-legacy.sh DESTINATION . COMPONENT game)
  endif()
endif()
install(FILES ${CMAKE_CURRENT_SOURCE_DIR}/cmake/PACKAGE-README.txt DESTINATION . RENAME README.txt COMPONENT game)

set(CPACK_PACKAGE_NAME "Ski-Legacy-Native")
set(CPACK_PACKAGE_VENDOR "Ski Legacy")
set(CPACK_PACKAGE_VERSION ${PROJECT_VERSION})
set(CPACK_PACKAGE_DESCRIPTION_SUMMARY "Ski Legacy (native C++ build)")
set(CPACK_PACKAGE_INSTALL_DIRECTORY "Ski Legacy")
# only the game's own files (the third-party projects' install rules -- headers, static libs -- stay out)
set(CPACK_COMPONENTS_ALL game)
set(CPACK_COMPONENTS_GROUPING ALL_COMPONENTS_IN_ONE)
set(CPACK_ARCHIVE_COMPONENT_INSTALL ON)
set(CPACK_DRAGNDROP_COMPONENT_INSTALL ON)
if(NOT APPLE)
  set(CPACK_COMPONENT_INCLUDE_TOPLEVEL_DIRECTORY ON)   # (the .zip / .tar.gz unpack into one folder; the .dmg holds the .app)
endif()
if(APPLE)
  set(CPACK_GENERATOR DragNDrop)
  set(CPACK_PACKAGE_FILE_NAME "Ski-Legacy-Native-Mac")
  set(CPACK_DMG_VOLUME_NAME "Ski Legacy")
elseif(WIN32)
  set(CPACK_GENERATOR ZIP)
  set(CPACK_PACKAGE_FILE_NAME "Ski-Legacy-Native-Windows")
else()
  set(CPACK_GENERATOR TGZ)
  set(CPACK_PACKAGE_FILE_NAME "Ski-Legacy-Native-Linux")
endif()
include(CPack)
