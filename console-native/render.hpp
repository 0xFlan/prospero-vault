#pragma once

#include <cstdint>

namespace vault
{
struct Canvas
{
    std::uint32_t *pixels;
    unsigned width;
    unsigned height;

    void clear(std::uint32_t color) const;
    void rect(int x, int y, int w, int h, std::uint32_t color) const;
    void text(int x, int y, const char *value, int scale, std::uint32_t color) const;
};

using DrawFn = void (*)(const Canvas &);
using TickFn = void (*)();

// Owns VideoOut, the two framebuffers and the presentation loop. Never returns.
void run(DrawFn draw, TickFn tick);

std::uint32_t rgb(unsigned r, unsigned g, unsigned b);
} // namespace vault
