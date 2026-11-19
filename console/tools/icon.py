#!/usr/bin/env python3
"""Draw the 512×512 home-screen tile for Prospero Vault.

    python3 tools/icon.py ui/icon0.png

The console shows `sce_sys/icon0.png` at 512×512 and rounds the corners itself,
so this draws a square tile: the same mark the interface uses for its own
heading — a vault door, white on near-black with one blue ring — because a tile
that does not match the app it opens reads as a different app.

Written with the standard library only: no Pillow, no ImageMagick, nothing to
install on a build host. Edges are anti-aliased analytically (coverage from the
distance to each shape) rather than by supersampling, so it is quick.
"""

import math
import struct
import sys
import zlib

SIZE = 512
SS = 4  # not supersampling: kept for reference of the geometry scale

BG_TOP = (24, 26, 34)
BG_BOT = (10, 11, 14)
BLUE = (0, 112, 209)
WHITE = (245, 245, 247)


def clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return low if value < low else high if value > high else value


def sd_round_rect(x: float, y: float, cx: float, cy: float, hw: float, hh: float, r: float) -> float:
    qx = abs(x - cx) - (hw - r)
    qy = abs(y - cy) - (hh - r)
    outside = math.hypot(max(qx, 0.0), max(qy, 0.0))
    inside = min(max(qx, qy), 0.0)
    return outside + inside - r


def dist_to_segment(x: float, y: float, ax: float, ay: float, bx: float, by: float) -> float:
    vx, vy = bx - ax, by - ay
    wx, wy = x - ax, y - ay
    length = vx * vx + vy * vy
    t = 0.0 if length == 0 else clamp((wx * vx + wy * vy) / length)
    return math.hypot(wx - vx * t, wy - vy * t)


def stroke(distance: float, half_width: float) -> float:
    """Coverage of a band of `half_width` around `distance`."""
    return clamp(half_width + 0.5 - distance)


def mix(base, layer, alpha: float):
    return (
        base[0] + (layer[0] - base[0]) * alpha,
        base[1] + (layer[1] - base[1]) * alpha,
        base[2] + (layer[2] - base[2]) * alpha,
    )


def build_rows():
    cx = cy = SIZE / 2.0
    rows = []

    # The mark: a circle, a hub, eight spokes — the glyph in the UI's heading.
    ring_radius = 150.0
    door_radius = 112.0
    hub_radius = 26.0
    spoke_inner = 44.0
    spoke_outer = 92.0
    spokes = []
    for i in range(8):
        angle = math.radians(i * 45.0 + 22.5)
        dx, dy = math.cos(angle), math.sin(angle)
        spokes.append(
            (
                cx + dx * spoke_inner,
                cy + dy * spoke_inner,
                cx + dx * spoke_outer,
                cy + dy * spoke_outer,
            )
        )

    for py in range(SIZE):
        y = py + 0.5
        row = bytearray()
        # Vertical gradient across the tile, so it does not read as a flat fill.
        t = py / (SIZE - 1.0)
        ground = mix(BG_TOP, BG_BOT, t)
        for px in range(SIZE):
            x = px + 0.5

            colour = ground
            # Tile edge: the console rounds the corners, so this only needs to
            # kill the outermost pixels softly.
            edge = clamp(0.5 - sd_round_rect(x, y, cx, cy, cx - 1, cy - 1, 84.0))
            colour = mix((0, 0, 0), colour, edge)

            d = math.hypot(x - cx, y - cy)

            # One blue ring, the only accent in the whole tile.
            blue = stroke(abs(d - ring_radius) - 0.8, 2.2)
            if blue > 0.0:
                colour = mix(colour, BLUE, blue * edge)

            white = stroke(abs(d - door_radius) - 0.5, 3.4)
            white = max(white, stroke(d, hub_radius))
            for ax, ay, bx, by in spokes:
                white = max(white, stroke(dist_to_segment(x, y, ax, ay, bx, by) - 0.6, 3.0))
            if white > 0.0:
                colour = mix(colour, WHITE, white * edge)

            row += bytes((int(colour[0] + 0.5), int(colour[1] + 0.5), int(colour[2] + 0.5)))
        rows.append(bytes(row))

    return rows


def write_png(path: str, rows) -> None:
    def chunk(tag: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + tag
            + payload
            + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", SIZE, SIZE, 8, 2, 0, 0, 0)  # 8-bit RGB
    # Filter byte 0 (None) in front of every scanline; the image is smooth, so
    # deflate does the work.
    body = b"".join(b"\x00" + row for row in rows)

    with open(path, "wb") as handle:
        handle.write(b"\x89PNG\r\n\x1a\n")
        handle.write(chunk(b"IHDR", header))
        handle.write(chunk(b"IDAT", zlib.compress(body, 9)))
        handle.write(chunk(b"IEND", b""))


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2

    write_png(sys.argv[1], build_rows())
    print(f"icon: {sys.argv[1]} ({SIZE}x{SIZE})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
