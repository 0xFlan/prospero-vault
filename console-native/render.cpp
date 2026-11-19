// Prospero Vault native title: VideoOut framebuffer and text renderer.
//
// The pixel layout is the console's tiled RGBA8 format. This is a new
// implementation for Vault; it only uses the public VideoOut entry points.

#include "render.hpp"

#include <cstddef>

extern "C"
{
    std::size_t sceKernelGetDirectMemorySize();
    int sceKernelAllocateDirectMemory(long long search_start, long long search_end,
                                      std::size_t length, std::size_t alignment, int memory_type,
                                      long long *physical_address);
    int sceKernelMapDirectMemory(void **address, std::size_t length, int protection, int flags,
                                 long long physical_address, std::size_t alignment);
    int sceKernelUsleep(unsigned int microseconds);
    int sceSystemServiceHideSplashScreen();
    int sceVideoOutOpen(int user_id, int bus_type, int index, const void *param);
    int sceVideoOutSetFlipRate(int handle, int rate);
    int sceVideoOutSubmitFlip(int handle, int buffer_index, unsigned int flip_mode,
                              long long flip_argument);
    int sceVideoOutWaitVblank(int handle);
    int sceVideoOutSetBufferAttribute2(void *attribute, unsigned long long pixel_format,
                                       unsigned int tiling_mode, unsigned int width,
                                       unsigned int height, unsigned long long option,
                                       unsigned int dcc_control, unsigned long long dcc_clear_color);
    int sceVideoOutRegisterBuffers2(int handle, int set_index, int buffer_index_start,
                                    void *buffers, int buffer_count, void *attribute, int category,
                                    void *option);
}

namespace vault
{
namespace
{
constexpr unsigned kWidth = 1920;
constexpr unsigned kHeight = 1080;
constexpr std::size_t kFrameBytes = 0x1000000;
constexpr std::size_t kMemoryBytes = kFrameBytes * 2;
constexpr std::size_t kMemoryAlignment = 0x200000;
constexpr std::size_t kFlushBytes = 1920ull * 1080ull * 4ull;
constexpr int kMemoryType = 3;
constexpr int kMapProtection = 0x33;
constexpr unsigned long long kPixelFormat = 0x8000000022000000ull;

struct VideoBuffer
{
    void *data;
    void *metadata;
    void *reserved0;
    void *reserved1;
};

struct VideoAttribute
{
    unsigned char reserved[80];
};

struct Glyph
{
    char character;
    unsigned char rows[7];
};

constexpr Glyph kGlyphs[] = {
    {' ', {0, 0, 0, 0, 0, 0, 0}},        {'0', {14, 17, 19, 21, 25, 17, 14}},
    {'1', {4, 12, 4, 4, 4, 4, 14}},      {'2', {14, 17, 1, 2, 4, 8, 31}},
    {'3', {30, 1, 1, 14, 1, 1, 30}},     {'4', {2, 6, 10, 18, 31, 2, 2}},
    {'5', {31, 16, 16, 30, 1, 1, 30}},   {'6', {14, 16, 16, 30, 17, 17, 14}},
    {'7', {31, 1, 2, 4, 8, 8, 8}},       {'8', {14, 17, 17, 14, 17, 17, 14}},
    {'9', {14, 17, 17, 15, 1, 1, 14}},   {'A', {14, 17, 17, 31, 17, 17, 17}},
    {'B', {30, 17, 17, 30, 17, 17, 30}}, {'C', {14, 17, 16, 16, 16, 17, 14}},
    {'D', {30, 17, 17, 17, 17, 17, 30}}, {'E', {31, 16, 16, 30, 16, 16, 31}},
    {'F', {31, 16, 16, 30, 16, 16, 16}}, {'G', {14, 17, 16, 23, 17, 17, 14}},
    {'H', {17, 17, 17, 31, 17, 17, 17}}, {'I', {31, 4, 4, 4, 4, 4, 31}},
    {'J', {7, 2, 2, 2, 18, 18, 12}},     {'K', {17, 18, 20, 24, 20, 18, 17}},
    {'L', {16, 16, 16, 16, 16, 16, 31}}, {'M', {17, 27, 21, 21, 17, 17, 17}},
    {'N', {17, 25, 21, 19, 17, 17, 17}}, {'O', {14, 17, 17, 17, 17, 17, 14}},
    {'P', {30, 17, 17, 30, 16, 16, 16}}, {'Q', {14, 17, 17, 17, 21, 18, 13}},
    {'R', {30, 17, 17, 30, 20, 18, 17}}, {'S', {15, 16, 16, 14, 1, 1, 30}},
    {'T', {31, 4, 4, 4, 4, 4, 4}},       {'U', {17, 17, 17, 17, 17, 17, 14}},
    {'V', {17, 17, 17, 17, 17, 10, 4}},  {'W', {17, 17, 17, 21, 21, 21, 10}},
    {'X', {17, 17, 10, 4, 10, 17, 17}},  {'Y', {17, 17, 10, 4, 4, 4, 4}},
    {'Z', {31, 1, 2, 4, 8, 16, 31}},     {'.', {0, 0, 0, 0, 0, 12, 12}},
    {'-', {0, 0, 0, 31, 0, 0, 0}},       {':', {0, 12, 12, 0, 12, 12, 0}},
    {'/', {1, 1, 2, 4, 8, 16, 16}},      {'!', {4, 4, 4, 4, 4, 0, 4}},
    {'?', {14, 17, 1, 2, 4, 0, 4}},      {',', {0, 0, 0, 0, 12, 4, 8}},
    {'\'', {4, 4, 8, 0, 0, 0, 0}},       {'(', {2, 4, 8, 8, 8, 4, 2}},
    {')', {8, 4, 2, 2, 2, 4, 8}},        {'[', {14, 8, 8, 8, 8, 8, 14}},
    {']', {14, 2, 2, 2, 2, 2, 14}},      {'%', {17, 18, 4, 4, 8, 9, 17}},
    {'+', {0, 4, 4, 31, 4, 4, 0}},       {'*', {0, 10, 4, 31, 4, 10, 0}},
};

std::size_t tiled_offset(unsigned x, unsigned y)
{
    const unsigned offset = ((y << 4) & 0x70u) ^ ((y << 5) & 0xf00u) ^ ((y << 9) & 0x1000u) ^
                            ((y << 8) & 0x4000u) ^ ((x << 2) & 0xcu) ^ ((x << 5) & 0x380u) ^
                            ((x << 4) & 0x400u) ^ ((x << 6) & 0x800u) ^ ((x << 9) & 0xa000u);
    const unsigned blocks_per_row = (kWidth + 127u) >> 7;
    const unsigned block = (y >> 7) * blocks_per_row + (x >> 7);
    return (static_cast<std::size_t>(block) << 16) + offset;
}

void pixel(const Canvas &canvas, int x, int y, std::uint32_t color)
{
    if (x < 0 || y < 0 || static_cast<unsigned>(x) >= canvas.width ||
        static_cast<unsigned>(y) >= canvas.height)
    {
        return;
    }
    auto *bytes = reinterpret_cast<unsigned char *>(canvas.pixels);
    *reinterpret_cast<std::uint32_t *>(
        bytes + tiled_offset(static_cast<unsigned>(x), static_cast<unsigned>(y))) = color;
}

const Glyph &glyph_for(char character)
{
    if (character >= 'a' && character <= 'z')
    {
        character = static_cast<char>(character - 'a' + 'A');
    }
    for (const Glyph &glyph : kGlyphs)
    {
        if (glyph.character == character)
        {
            return glyph;
        }
    }
    return kGlyphs[0];
}

void flush_range(void *address, std::size_t length)
{
    auto *at = static_cast<unsigned char *>(address);
    const auto *end = at + length;
    for (; at < end; at += 64)
    {
        __asm__ volatile("clflush (%0)" : : "r"(at) : "memory");
    }
    __asm__ volatile("mfence" ::: "memory");
}
} // namespace

std::uint32_t rgb(unsigned r, unsigned g, unsigned b)
{
    // The console's RGBA8 surface stores R in the low byte (0xAABBGGRR).
    return 0xff000000u | (b << 16) | (g << 8) | r;
}

void Canvas::clear(std::uint32_t color) const
{
    rect(0, 0, static_cast<int>(width), static_cast<int>(height), color);
}

void Canvas::rect(int x, int y, int w, int h, std::uint32_t color) const
{
    const int left = x < 0 ? 0 : x;
    const int top = y < 0 ? 0 : y;
    const int right = x + w > static_cast<int>(width) ? static_cast<int>(width) : x + w;
    const int bottom = y + h > static_cast<int>(height) ? static_cast<int>(height) : y + h;
    for (int row = top; row < bottom; ++row)
    {
        for (int column = left; column < right; ++column)
        {
            pixel(*this, column, row, color);
        }
    }
}

void Canvas::text(int x, int y, const char *value, int scale, std::uint32_t color) const
{
    if (scale < 1)
    {
        scale = 1;
    }
    for (const char *at = value; *at; ++at)
    {
        if (*at == '\n')
        {
            x = 0;
            y += 8 * scale;
            continue;
        }
        const Glyph &glyph = glyph_for(*at);
        for (int row = 0; row < 7; ++row)
        {
            for (int column = 0; column < 5; ++column)
            {
                if ((glyph.rows[row] & (1u << (4 - column))) != 0)
                {
                    rect(x + column * scale, y + row * scale, scale, scale, color);
                }
            }
        }
        x += 6 * scale;
    }
}

void run(DrawFn draw, TickFn tick)
{
    (void)sceSystemServiceHideSplashScreen();
    const int video = sceVideoOutOpen(0xff, 0, 0, nullptr);
    if (video < 0)
    {
        for (;;)
        {
            sceKernelUsleep(1000000);
        }
    }

    const std::size_t pool = sceKernelGetDirectMemorySize();
    if (pool < kMemoryBytes)
    {
        for (;;)
        {
            sceKernelUsleep(1000000);
        }
    }

    long long physical = 0;
    if (sceKernelAllocateDirectMemory(0, static_cast<long long>(pool), kMemoryBytes,
                                      kMemoryAlignment, kMemoryType, &physical) < 0)
    {
        for (;;)
        {
            sceKernelUsleep(1000000);
        }
    }

    void *mapped = nullptr;
    if (sceKernelMapDirectMemory(&mapped, kMemoryBytes, kMapProtection, 0, physical,
                                 kMemoryAlignment) < 0)
    {
        for (;;)
        {
            sceKernelUsleep(1000000);
        }
    }

    auto *first = static_cast<unsigned char *>(mapped);
    auto *second = first + kFrameBytes;

    Canvas first_canvas{reinterpret_cast<std::uint32_t *>(first), kWidth, kHeight};
    Canvas second_canvas{reinterpret_cast<std::uint32_t *>(second), kWidth, kHeight};
    draw(first_canvas);
    draw(second_canvas);
    flush_range(first, kFlushBytes);
    flush_range(second, kFlushBytes);

    VideoBuffer buffers[2] = {{first, nullptr, nullptr, nullptr},
                              {second, nullptr, nullptr, nullptr}};
    VideoAttribute attribute{};
    (void)sceVideoOutSetFlipRate(video, 0);
    sceVideoOutSetBufferAttribute2(&attribute, kPixelFormat, 0, kWidth, kHeight, 0, 0, 0);
    if (sceVideoOutRegisterBuffers2(video, 0, 0, buffers, 2, &attribute, 0, nullptr) < 0)
    {
        for (;;)
        {
            sceKernelUsleep(1000000);
        }
    }
    if (sceVideoOutSubmitFlip(video, 0, 1, 1) < 0)
    {
        for (;;)
        {
            sceKernelUsleep(1000000);
        }
    }
    (void)sceVideoOutWaitVblank(video);

    int index = 0;
    for (;;)
    {
        index ^= 1;
        if (tick)
        {
            tick();
        }
        Canvas &canvas = index == 0 ? first_canvas : second_canvas;
        draw(canvas);
        flush_range(index == 0 ? first : second, kFlushBytes);
        (void)sceVideoOutSubmitFlip(video, index, 1, 1);
        (void)sceVideoOutWaitVblank(video);
        (void)sceKernelUsleep(8000);
    }
}
} // namespace vault
