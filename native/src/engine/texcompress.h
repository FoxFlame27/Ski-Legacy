// (Phase 7) block compression of textures at load (the 'switch' preset): BC1 (RGB, 4 bits a pixel: 1/8 of RGBA8) or
// BC3 (RGBA, 8 bits: 1/4) with stb_dxt, the mip chain built on the CPU (box filter). The Switch's Maxwell GPU samples
// BC1-7 natively (as every desktop GPU does through EXT_texture_compression_s3tc); ASTC would be the console's
// alternative from an offline asset step.
#pragma once
#include <cstdint>
#include <vector>

namespace sl {
/// Compresses an RGBA8 image (top row first) with its mips; `alpha` out: BC3 used (some texel's alpha < 250), else BC1.
void compressBC(const uint8_t* rgba, int w, int h, std::vector<std::vector<uint8_t>>& levels, bool& alpha);
} // namespace sl
