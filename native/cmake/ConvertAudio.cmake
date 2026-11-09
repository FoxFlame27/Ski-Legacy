# The game's sounds (public/audio: AAC .m4a, the web game's format) -> Ogg Vorbis in native/data/audio, which the C++
# decodes with stb_vorbis (no AAC decoder in the native build: patents / licences, and one codec everywhere incl. the
# Switch). Run by the build when ffmpeg is found (SL_FFMPEG); only new or changed files are converted.
#   cmake -DSRC=.../public/audio -DDST=.../native/data/audio -DFFMPEG=ffmpeg -DSTAMP=... -P ConvertAudio.cmake
# Sound effects and announcer lines: mono, Vorbis q3 (~80 kbps); music: stereo, q1 (~80 kbps, streamed at run time).
# .ogg sources are copied as they are; CREDITS.txt (the licences) goes along.
file(GLOB_RECURSE _files RELATIVE "${SRC}" "${SRC}/*.m4a" "${SRC}/*.mp3" "${SRC}/*.wav" "${SRC}/*.ogg" "${SRC}/*.aac")
set(_n 0)
set(_skip 0)
foreach(f ${_files})
  string(REGEX REPLACE "\\.[^.]+$" ".ogg" _out "${f}")
  set(_in "${SRC}/${f}")
  set(_dst "${DST}/${_out}")
  if(EXISTS "${_dst}" AND NOT "${_in}" IS_NEWER_THAN "${_dst}")
    math(EXPR _skip "${_skip} + 1")
    continue()
  endif()
  get_filename_component(_dir "${_dst}" DIRECTORY)
  file(MAKE_DIRECTORY "${_dir}")
  if(f MATCHES "\\.ogg$")
    file(COPY "${_in}" DESTINATION "${_dir}")
  else()
    if(f MATCHES "^music/")
      set(_args -ac 2 -q:a 1)
    else()
      set(_args -ac 1 -q:a 3)
    endif()
    execute_process(COMMAND "${FFMPEG}" -nostdin -hide_banner -loglevel error -y -i "${_in}" -vn -map_metadata -1 -c:a libvorbis ${_args} "${_dst}"
                    RESULT_VARIABLE _rc)
    if(NOT _rc EQUAL 0)
      # an ffmpeg without libvorbis: its own (experimental) Vorbis encoder
      execute_process(COMMAND "${FFMPEG}" -nostdin -hide_banner -loglevel error -y -i "${_in}" -vn -map_metadata -1 -c:a vorbis -strict -2 -ac 2 "${_dst}"
                      RESULT_VARIABLE _rc)
    endif()
    if(NOT _rc EQUAL 0)
      file(REMOVE "${_dst}")
      message(WARNING "ConvertAudio: could not convert ${f} (the game plays its synthesized fallback)")
      continue()
    endif()
  endif()
  math(EXPR _n "${_n} + 1")
endforeach()
if(EXISTS "${SRC}/CREDITS.txt")
  file(COPY "${SRC}/CREDITS.txt" DESTINATION "${DST}")
endif()
message(STATUS "ConvertAudio: ${_n} converted, ${_skip} up to date -> ${DST}")
file(WRITE "${STAMP}" "${_n}\n")
