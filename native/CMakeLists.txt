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
  nlohmann_json::nlohmann_json sl_headeronly)
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

# ---------------------------------------------------------------- packaging: assets next to the executable
# Only the models the game loads (not the whole 240 MB public/ folder) plus the exported world data (native/data:
# world.json, crag.bin, cuts.bin, resort.json, resort.bin, fonts/).
set(SL_PHASE1_MODELS skier_red_rigged skier_red_anims ski_carver ski_pole pine_tree pine_tree2 rental_shop
  ticket_booth hotel_chalet lamp_post mountain_hut)
# Phase 2: the resort's props (export_resort.mjs lists them in resort.json), the lift cars, the chair bullwheel's
# material
set(SL_PHASE2_MODELS sign_pole map_board snow_cannon lift_tower chair_terminal chair_bullwheel christmas_tree
  wooden_bench wooden_barrel trash_bin market_stall fire_pit picnic_table outdoor_ski_rack wooden_sled firewood_pile
  snowman wooden_fence patrol_hut deck_chair gondola_cabin chairlift_chair)
if(SL_COPY_ASSETS)
  set(_dst $<TARGET_FILE_DIR:ski_legacy>/assets)
  set(_cmds)
  foreach(m ${SL_PHASE1_MODELS} ${SL_PHASE2_MODELS})
    list(APPEND _cmds COMMAND ${CMAKE_COMMAND} -E copy_if_different
      ${CMAKE_CURRENT_SOURCE_DIR}/../public/models/${m}.glb ${_dst}/models/${m}.glb)
  endforeach()
  add_custom_command(TARGET ski_legacy POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E make_directory ${_dst}/models ${_dst}/data
    ${_cmds}
    COMMAND ${CMAKE_COMMAND} -E copy_directory ${CMAKE_CURRENT_SOURCE_DIR}/data ${_dst}/data
    COMMENT "Copying the game's assets to ${_dst}")
endif()
