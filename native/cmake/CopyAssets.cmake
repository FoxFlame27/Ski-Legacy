# -DSL_COPY_ASSETS=ON, after the build: the models the game loads (LIST: one name per line, made by
# tools/list_models.mjs from the exported data and the C++ sources) from SRC (public/models) to DST (assets/models),
# and native/data to assets/data. Only changed files are copied; models no longer listed are left alone.
#   cmake -DLIST=models.txt -DSRC=.../public/models -DDST=.../assets -DDATA=.../native/data -P CopyAssets.cmake
file(STRINGS "${LIST}" _models)
set(_n 0)
foreach(m ${_models})
  if(m STREQUAL "")
    continue()
  endif()
  if(NOT EXISTS "${SRC}/${m}.glb")
    message(FATAL_ERROR "SL_COPY_ASSETS: ${SRC}/${m}.glb is missing")
  endif()
  get_filename_component(_dir "${DST}/models/${m}.glb" DIRECTORY)
  file(MAKE_DIRECTORY "${_dir}")
  file(COPY "${SRC}/${m}.glb" DESTINATION "${_dir}")
  math(EXPR _n "${_n} + 1")
endforeach()
file(MAKE_DIRECTORY "${DST}/data")
file(COPY "${DATA}/" DESTINATION "${DST}/data")
message(STATUS "SL_COPY_ASSETS: ${_n} models and native/data in ${DST}")
