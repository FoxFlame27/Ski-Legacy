# Third-party dependencies, fetched at configure time and pinned to exact tags / commits.
# Everything is built from source as static libraries, so the same tree builds on macOS, Windows and Linux
# (and, later, against the Nintendo toolchain: SDL2 has an official Switch port for licensed developers).
include(FetchContent)
set(FETCHCONTENT_QUIET ON)
set(FETCHCONTENT_UPDATES_DISCONNECTED ON)

# ---------------------------------------------------------------- SDL2: window, GL context, input, rumble, audio
set(SDL_SHARED OFF CACHE BOOL "" FORCE)
set(SDL_STATIC ON CACHE BOOL "" FORCE)
set(SDL_TEST OFF CACHE BOOL "" FORCE)
set(SDL2_DISABLE_INSTALL ON CACHE BOOL "" FORCE)
set(SDL2_DISABLE_SDL2MAIN OFF CACHE BOOL "" FORCE)
set(SDL_STATIC_PIC ON CACHE BOOL "" FORCE)
# subsystems the game does not use
set(SDL_RENDER OFF CACHE BOOL "" FORCE)
set(SDL_SENSOR OFF CACHE BOOL "" FORCE)
set(SDL_LOCALE OFF CACHE BOOL "" FORCE)
set(SDL_POWER OFF CACHE BOOL "" FORCE)
set(SDL_VULKAN OFF CACHE BOOL "" FORCE)
FetchContent_Declare(SDL2
  GIT_REPOSITORY https://github.com/libsdl-org/SDL.git
  GIT_TAG release-2.30.10
  GIT_SHALLOW TRUE)

# ---------------------------------------------------------------- glm: math
set(GLM_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(GLM_BUILD_INSTALL OFF CACHE BOOL "" FORCE)
FetchContent_Declare(glm
  GIT_REPOSITORY https://github.com/g-truc/glm.git
  GIT_TAG 1.0.1
  GIT_SHALLOW TRUE)

# ---------------------------------------------------------------- meshoptimizer: EXT_meshopt_compression decode + LOD simplification
set(MESHOPT_BUILD_DEMO OFF CACHE BOOL "" FORCE)
set(MESHOPT_BUILD_GLTFPACK OFF CACHE BOOL "" FORCE)
set(MESHOPT_BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
FetchContent_Declare(meshoptimizer
  GIT_REPOSITORY https://github.com/zeux/meshoptimizer.git
  GIT_TAG v0.22
  GIT_SHALLOW TRUE)

# ---------------------------------------------------------------- libwebp: the GLB textures are EXT_texture_webp (decoder only)
foreach(opt WEBP_BUILD_ANIM_UTILS WEBP_BUILD_CWEBP WEBP_BUILD_DWEBP WEBP_BUILD_GIF2WEBP WEBP_BUILD_IMG2WEBP
            WEBP_BUILD_VWEBP WEBP_BUILD_WEBPINFO WEBP_BUILD_WEBPMUX WEBP_BUILD_EXTRAS WEBP_BUILD_WEBP_JS
            WEBP_BUILD_LIBWEBPMUX WEBP_BUILD_FUZZTEST)
  set(${opt} OFF CACHE BOOL "" FORCE)
endforeach()
set(WEBP_ENABLE_SWAP_16BIT_CSP OFF CACHE BOOL "" FORCE)
FetchContent_Declare(libwebp
  GIT_REPOSITORY https://github.com/webmproject/libwebp.git
  GIT_TAG v1.4.0
  GIT_SHALLOW TRUE)

# ---------------------------------------------------------------- glad: OpenGL 4.1 core loader (macOS tops out at 4.1)
# glad 0.1.x generates the loader with Python 3 from the specification it ships (GLAD_REPRODUCIBLE: no download).
set(GLAD_PROFILE "core" CACHE STRING "" FORCE)
set(GLAD_API "gl=4.1" CACHE STRING "" FORCE)
set(GLAD_GENERATOR "c" CACHE STRING "" FORCE)
set(GLAD_EXTENSIONS "GL_EXT_texture_filter_anisotropic,GL_ARB_texture_filter_anisotropic,GL_KHR_debug" CACHE STRING "" FORCE)
set(GLAD_REPRODUCIBLE ON CACHE BOOL "" FORCE)
set(GLAD_INSTALL OFF CACHE BOOL "" FORCE)
FetchContent_Declare(glad
  GIT_REPOSITORY https://github.com/Dav1dde/glad.git
  GIT_TAG v0.1.36
  GIT_SHALLOW TRUE)

# ---------------------------------------------------------------- zstd: native/data is shipped zstd-compressed (*.zst)
set(ZSTD_BUILD_PROGRAMS OFF CACHE BOOL "" FORCE)
set(ZSTD_BUILD_SHARED OFF CACHE BOOL "" FORCE)
set(ZSTD_BUILD_STATIC ON CACHE BOOL "" FORCE)
set(ZSTD_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(ZSTD_BUILD_CONTRIB OFF CACHE BOOL "" FORCE)
set(ZSTD_LEGACY_SUPPORT OFF CACHE BOOL "" FORCE)
set(ZSTD_MULTITHREAD_SUPPORT OFF CACHE BOOL "" FORCE)
FetchContent_Declare(zstd
  GIT_REPOSITORY https://github.com/facebook/zstd.git
  GIT_TAG v1.5.6
  GIT_SHALLOW TRUE
  SOURCE_SUBDIR build/cmake)

# ---------------------------------------------------------------- mbedTLS: TLS for the multiplayer client (wss://, Phase 6)
# The release tarball (generated sources included: no Perl / Python step). Only the libraries: no programs, no tests.
# Linked by net/ (socket_stream.cpp); a Switch build swaps that file for nn::socket + nn::ssl and drops this.
set(ENABLE_PROGRAMS OFF CACHE BOOL "" FORCE)
set(ENABLE_TESTING OFF CACHE BOOL "" FORCE)
set(MBEDTLS_FATAL_WARNINGS OFF CACHE BOOL "" FORCE)
set(USE_SHARED_MBEDTLS_LIBRARY OFF CACHE BOOL "" FORCE)
set(USE_STATIC_MBEDTLS_LIBRARY ON CACHE BOOL "" FORCE)
set(DISABLE_PACKAGE_CONFIG_AND_INSTALL ON CACHE BOOL "" FORCE)
set(GEN_FILES OFF CACHE BOOL "" FORCE)
FetchContent_Declare(mbedtls
  URL https://github.com/Mbed-TLS/mbedtls/releases/download/mbedtls-3.6.2/mbedtls-3.6.2.tar.bz2
  URL_HASH SHA256=8b54fb9bcf4d5a7078028e0520acddefb7900b3e66fec7f7175bb5b7d85ccdca
  DOWNLOAD_EXTRACT_TIMESTAMP TRUE)

# ---------------------------------------------------------------- header-only libraries
FetchContent_Declare(cgltf
  GIT_REPOSITORY https://github.com/jkuhlmann/cgltf.git
  GIT_TAG v1.15
  GIT_SHALLOW TRUE)
# stb has no release tags: pinned to a commit (stb_image, stb_image_write, stb_easy_font)
FetchContent_Declare(stb
  GIT_REPOSITORY https://github.com/nothings/stb.git
  GIT_TAG 4e9b368bfc071e97206ea5c6adba68dd0cbf8897)
FetchContent_Declare(json
  URL https://github.com/nlohmann/json/releases/download/v3.11.3/json.tar.xz
  URL_HASH SHA256=d6c65aca6b1ed68e7a182f4757257b107ae403032760ed6ef121c9d55e81757d
  DOWNLOAD_EXTRACT_TIMESTAMP TRUE)

FetchContent_MakeAvailable(SDL2 glm meshoptimizer libwebp glad json zstd mbedtls)
FetchContent_GetProperties(cgltf)
if(NOT cgltf_POPULATED)
  FetchContent_Populate(cgltf)
endif()
FetchContent_GetProperties(stb)
if(NOT stb_POPULATED)
  FetchContent_Populate(stb)
endif()

# (Phase 7) Ogg Vorbis decoding for the audio (stb_vorbis, the same pinned stb commit), compiled once as C
add_library(sl_vorbis STATIC ${stb_SOURCE_DIR}/stb_vorbis.c)
set_target_properties(sl_vorbis PROPERTIES FOLDER "third_party" POSITION_INDEPENDENT_CODE ON)
if(MSVC)
  target_compile_options(sl_vorbis PRIVATE /W0)
else()
  target_compile_options(sl_vorbis PRIVATE -w)
endif()

add_library(sl_headeronly INTERFACE)
target_include_directories(sl_headeronly SYSTEM INTERFACE ${cgltf_SOURCE_DIR} ${stb_SOURCE_DIR} ${libwebp_SOURCE_DIR}/src ${zstd_SOURCE_DIR}/lib)

# quiet the third-party code
foreach(t SDL2-static meshoptimizer webp webpdecode webpdsp webputils sharpyuv glad libzstd_static mbedtls mbedx509 mbedcrypto everest p256m)
  if(TARGET ${t})
    set_target_properties(${t} PROPERTIES FOLDER "third_party")
    if(MSVC)
      target_compile_options(${t} PRIVATE /W0)
    else()
      target_compile_options(${t} PRIVATE -w)
    endif()
  endif()
endforeach()
