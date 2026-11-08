// Nintendo Switch platform backend — CONTRACT ONLY (no code: the NintendoSDK is under NDA).
//
// Once the project is accepted into the Nintendo Developer Portal and has the NintendoSDK, add
// platform/switch/platform_switch.cpp implementing sl::platform::Platform (platform/platform.h) and build with
// -DSL_PLATFORM=switch using Nintendo's CMake toolchain. Nothing else in the code base talks to the OS.
// What each part must provide, and the NintendoSDK area it maps to:
//
//  Window / surface
//    - createWindow: the display layer (nn::vi) + the GPU device. The engine renders through gfx::Device
//      (gfx/gfx.h); add gfx/nvn/ (NVN, Nintendo's native API) or use the Vulkan driver the SDK provides and add a
//      gfx/vulkan/ backend. glProcAddress() returns nullptr there. Docked 1920x1080 / handheld 1280x720: drawableSize
//      reports the current mode (operation mode change notifications -> Events::resized).
//    - swapBuffers: present via the NVN window / Vulkan swapchain with vsync.
//
//  Input (nn::hid)
//    - Joy-Con (dual, single sideways), Pro Controller, handheld mode. Map them to GamepadState in the W3C
//      standard POSITION layout used by the game (platform.h): Switch B = index 0 (bottom), A = 1 (right), Y = 2,
//      X = 3, L/R = 4/5, ZL/ZR = 6/7 (digital on Switch: report 0 or 1), Minus/Plus = 8/9, stick clicks 10/11,
//      d-pad 12-15, Home is reserved by the system (index 16 never fires).
//    - Controller applet (nn::hid::ShowControllerSupport) when no controller is connected / to pick players.
//    - keyDown(): always false (no keyboard); setRelativeMouse(): no-op.
//
//  Rumble (nn::hid vibration)
//    - rumble(low, high, ms): HD Rumble amplitude/frequency pairs (low band ~160 Hz, high band ~320 Hz).
//
//  File system / save data (nn::fs)
//    - readFile: the read-only ROM file system ("rom:/" mounted with nn::fs::MountRom); package assets/ there.
//    - saveDir/writeSave/readSave: the user's save data ("save:/" via nn::fs::MountSaveData for the preselected
//      account), commit after every write (nn::fs::CommitSaveData). Keep saves small; journal size is declared in
//      the application's .nmeta.
//
//  User account (nn::account)
//    - userName(): nickname of the preselected user (StartupUserAccount in .nmeta). Online play needs a Nintendo
//      Account + Nintendo Switch Online (NEX / NPLN or your own servers per the guidelines).
//
//  Audio (nn::audio)
//    - openAudio: an audio renderer / audio out stream at 48 kHz pulling from the callback.
//
//  Time
//    - timeSeconds: nn::os::GetSystemTick() converted to seconds.
//
//  Lifecycle (no equivalent on desktop; add to Events)
//    - focus / suspend (HOME menu, sleep): pause the game, stop rumble, mute audio (nn::oe messages).
//
// SDL2 also has an official Switch port available to licensed developers through Nintendo's developer portal; using
// it, most of the above comes for free and platform/sdl/ can be reused with a GL->NVN/Vulkan gfx backend.
#pragma once
