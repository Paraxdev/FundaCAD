"""Writes the 3DS fixtures in tests/fixtures: python gen_3ds.py <fixtures dir>.

threeds_two.3ds   Red (24 bit colour) and Blue (float colour) 10 mm cubes, Blue 30 mm along X,
                  its local matrix a translation and a mirror that must not move the points.
threeds_scaled.3ds  one 10 unit cube under a master scale of 2.5, so 25 mm.
"""
import struct
import sys
from pathlib import Path

V = [(0, 0, 0), (10, 0, 0), (10, 10, 0), (0, 10, 0), (0, 0, 10), (10, 0, 10), (10, 10, 10), (0, 10, 10)]
T = [(0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7), (0, 1, 5), (0, 5, 4), (1, 2, 6), (1, 6, 5), (2, 3, 7), (2, 7, 6), (3, 0, 4), (3, 4, 7)]


def chunk(cid, body=b"", *kids):
    body += b"".join(kids)
    return struct.pack("<HI", cid, 6 + len(body)) + body


def cstr(s):
    return s.encode() + b"\0"


def material(name, rgb):
    if all(isinstance(c, int) for c in rgb):
        col = chunk(0x0011, bytes(rgb))
    else:
        col = chunk(0x0010, struct.pack("<3f", *rgb))
    return chunk(0xAFFF, b"", chunk(0xA000, cstr(name)), chunk(0xA020, b"", col))


def cube(name, mat, dx, matrix=None):
    pts = b"".join(struct.pack("<3f", x + dx, y, z) for x, y, z in V)
    faces = b"".join(struct.pack("<4H", a, b, c, 7) for a, b, c in T)
    group = chunk(0x4130, cstr(mat) + struct.pack("<H", len(T)) + b"".join(struct.pack("<H", i) for i in range(len(T))))
    kids = [chunk(0x4110, struct.pack("<H", len(V)) + pts), chunk(0x4120, struct.pack("<H", len(T)) + faces, group)]
    if matrix:
        kids.append(chunk(0x4160, struct.pack("<12f", *matrix)))
    return chunk(0x4000, cstr(name), chunk(0x4100, b"", *kids))


def scene(*items, scale=None):
    head = [chunk(0x0100, struct.pack("<f", scale))] if scale else []
    return chunk(0x4D4D, b"", chunk(0x0002, struct.pack("<I", 3)), chunk(0x3D3D, b"", *head, *items))


def main(out):
    out = Path(out)
    mirror = (-1, 0, 0, 0, 1, 0, 0, 0, 1, 30, 0, 0)
    (out / "threeds_two.3ds").write_bytes(
        scene(material("Paint", (255, 0, 0)), material("Glass", (0.0, 0.0, 1.0)), cube("Red", "Paint", 0), cube("Blue", "Glass", 30, mirror))
    )
    (out / "threeds_scaled.3ds").write_bytes(scene(material("Grey", (128, 128, 128)), cube("Box", "Grey", 0), scale=2.5))


if __name__ == "__main__":
    main(sys.argv[1])
