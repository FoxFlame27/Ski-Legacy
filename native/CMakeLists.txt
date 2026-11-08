# Ski Legacy — native (C++20) port. See README.md.
#   cmake -S native -B native/build -G Ninja -DCMAKE_BUILD_TYPE=Release && cmake --build native/build
cmake_minimum_required(VERSION 3.20)
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
  src/platform/*.h)
if(SL_PLATFORM STREQUAL "sdl")
  file(GLOB SL_PLATFORM_SOURCES CONFIGURE_DEPENDS src/platform/sdl/*.cpp src/platform/sdl/*.h)
else()
  message(FATAL_ERROR "Unknown SL_PLATFORM '${SL_PLATFORM}'")
endif()

add_executable(ski_legacy src/main.cpp ${SL_SOURCES} ${SL_PLATFORM_SOURCES})
target_include_directories(ski_legacy PRIVATE src)
target_link_libraries(ski_legacy PRIVATE SDL2::SDL2-static SDL2::SDL2main glm::glm meshoptimizer webpdecoder glad
  nlohmann_json::nlohmann_json sl_headeronly libzstd_static)
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
if(APPLE)
  set_target_properties(ski_legacy PROPERTIES MACOSX_BUNDLE OFF)
endif()

# ---------------------------------------------------------------- the exported world data (native/data, generated)
# native/data/*.zst are not committed: the build runs the exporter (node tools/export_world.mjs, which runs
# export_resort.mjs / export_net.mjs / export_fonts.mjs) when they are missing or older than the exporter scripts or the
# game's JavaScript sources they read (~2 min). Needs Node.js (>= 22.15 for zstd; older Node writes uncompressed data)
# and the repository's node_modules (npm install in the repo root). SL_EXPORT_DATA=OFF skips the step (data provided).
option(SL_EXPORT_DATA "Regenerate native/data with Node when it is missing or out of date" ON)
set(SL_DATA_DIR ${CMAKE_CURRENT_SOURCE_DIR}/data)
set(SL_DATA_FILES world.json crag.bin cuts.bin regions.bin resort.json resort.bin transport.json transport.bin)
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

# ---------------------------------------------------------------- packaging: assets next to the executable
# Only the models the game loads (not the whole 240 MB public/ folder) plus the exported world data (native/data:
# world.json, crag.bin, cuts.bin, regions.bin, resort.json / .bin, transport.json / .bin, fonts/).
set(SL_PHASE1_MODELS skier_red_rigged skier_red_anims ski_carver ski_pole pine_tree pine_tree2 rental_shop
  ticket_booth hotel_chalet lamp_post mountain_hut)
# Phase 2: the resort's props (export_resort.mjs lists them in resort.json), the lift cars, the chair bullwheel's
# material
set(SL_PHASE2_MODELS sign_pole map_board snow_cannon lift_tower chair_terminal chair_bullwheel christmas_tree
  wooden_bench wooden_barrel trash_bin market_stall fire_pit picnic_table outdoor_ski_rack wooden_sled firewood_pile
  snowman wooden_fence patrol_hut deck_chair gondola_cabin chairlift_chair)
# Phase 3: the cars (traffic, parked, the Autohaus, yours), the Micruss ski bus, the railcar's Meshy body, the
# transport's props (transport.json) and the GLB materials its baked meshes use
set(SL_PHASE3_MODELS car_bmw_x3 car_audi_rs6 car_vw_golf_gti car_tesla_m3 car_mercedes_sls car_porsche_taycan
  car_lamborghini_huracan car_toyota_gr_yaris car_audi_etron_gt car_mercedes_gls ski_bus_micruss rail_car2 bus_stop_sign
  parking_pay_machine parking_sign floodlight_head_c)
if(SL_COPY_ASSETS)
  set(_dst $<TARGET_FILE_DIR:ski_legacy>/assets)
  set(_cmds)
  foreach(m ${SL_PHASE1_MODELS} ${SL_PHASE2_MODELS} ${SL_PHASE3_MODELS})
    list(APPEND _cmds COMMAND ${CMAKE_COMMAND} -E copy_if_different
      ${CMAKE_CURRENT_SOURCE_DIR}/../public/models/${m}.glb ${_dst}/models/${m}.glb)
  endforeach()
  add_custom_command(TARGET ski_legacy POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E make_directory ${_dst}/models ${_dst}/data
    ${_cmds}
    COMMAND ${CMAKE_COMMAND} -E copy_directory ${CMAKE_CURRENT_SOURCE_DIR}/data ${_dst}/data
    COMMENT "Copying the game's assets to ${_dst}")
endif()
