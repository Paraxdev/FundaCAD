"""A small GIF89a encoder for the manual's animations, standard library only.

Frames come in as raw RGBA bytes of one size. One palette of at most 255 colours is
cut from all of them (median cut), index 255 marks a pixel that did not change since
the frame before, and every frame after the first stores only the rectangle that changed.
"""
import struct
import sys
from array import array
from collections import Counter

TRANSPARENT = 255
MAX_COLOURS = 255
# Past this many distinct colours the keys drop to 6 bits a channel, so the cut stays quick.
EXACT_LIMIT = 65536
_COARSE = bytes(b & 0xFC for b in range(256))


def _keys(rgba: bytes, coarse: bool) -> array:
    a = array("I" if array("I").itemsize == 4 else "L")
    a.frombytes(rgba.translate(_COARSE) if coarse else rgba)
    if sys.byteorder == "big":
        a.byteswap()
    return a


def _rgb(key: int, coarse: bool) -> tuple[int, int, int]:
    # A coarse key sits at the bottom of its bucket, the middle of it is closer on average.
    lift = 2 if coarse else 0
    return (key & 0xFF) + lift, ((key >> 8) & 0xFF) + lift, ((key >> 16) & 0xFF) + lift


def _cut(counts: Counter, coarse: bool, size: int) -> tuple[list, dict]:
    """Median cut: splits the box with the widest channel spread times its pixels until there are `size`."""
    def stats(items):
        lo, hi = [255] * 3, [0] * 3
        n = 0
        for key, c in items:
            rgb = _rgb(key, coarse)
            for i in range(3):
                lo[i] = min(lo[i], rgb[i])
                hi[i] = max(hi[i], rgb[i])
            n += c
        spans = [hi[i] - lo[i] for i in range(3)]
        ch = spans.index(max(spans))
        return spans[ch] * n, ch, n

    boxes = [(list(counts.items()),) + stats(counts.items())]
    while len(boxes) < size:
        best = max(range(len(boxes)), key=lambda i: boxes[i][1])
        items, score, ch, n = boxes[best]
        if score == 0:
            break
        items.sort(key=lambda kc: _rgb(kc[0], coarse)[ch])
        half, run, at = n / 2, 0, 1
        for at, (_, c) in enumerate(items, 1):
            run += c
            if run >= half:
                break
        at = min(max(at, 1), len(items) - 1)
        a, b = items[:at], items[at:]
        boxes[best] = (a,) + stats(a)
        boxes.append((b,) + stats(b))

    palette, lut = [], {}
    for index, (items, *_) in enumerate(boxes):
        n = sum(c for _, c in items)
        sums = [0, 0, 0]
        for key, c in items:
            rgb = _rgb(key, coarse)
            for i in range(3):
                sums[i] += rgb[i] * c
            lut[key] = index
        palette.append(tuple(min(255, round(s / n)) for s in sums))
    return palette, lut


def _lzw(indices: bytes, min_size: int = 8) -> bytes:
    clear, end = 1 << min_size, (1 << min_size) + 1
    out = bytearray()
    acc = nbits = 0
    size = min_size + 1
    table: dict[int, int] = {}
    free = end + 1

    def emit(code: int, width: int):
        nonlocal acc, nbits
        acc |= code << nbits
        nbits += width
        while nbits >= 8:
            out.append(acc & 0xFF)
            acc >>= 8
            nbits -= 8

    emit(clear, size)
    prefix = indices[0]
    for c in indices[1:]:
        key = (prefix << 8) | c
        code = table.get(key)
        if code is not None:
            prefix = code
            continue
        emit(prefix, size)
        if free < 4096:
            # The decoder widens its codes one entry later than the table grows, so this tracks it.
            if free > (1 << size) - 1 and size < 12:
                size += 1
            table[key] = free
            free += 1
        else:
            emit(clear, size)
            table.clear()
            free = end + 1
            size = min_size + 1
        prefix = c
    emit(prefix, size)
    if free > (1 << size) - 1 and size < 12:
        size += 1
    emit(end, size)
    if nbits:
        out.append(acc & 0xFF)
    return bytes(out)


def _blocks(data: bytes) -> bytes:
    parts = [bytes([len(data[i:i + 255])]) + data[i:i + 255] for i in range(0, len(data), 255)]
    return b"".join(parts) + b"\x00"


def _first_diff(a: bytes, b: bytes) -> int:
    lo, hi = 0, len(a)
    while lo < hi:
        mid = (lo + hi) // 2
        if a[lo:mid + 1] == b[lo:mid + 1]:
            lo = mid + 1
        else:
            hi = mid
    return lo


def _changed(cur: bytes, prev: bytes, w: int, h: int):
    rows = [y for y in range(h) if cur[y * w:(y + 1) * w] != prev[y * w:(y + 1) * w]]
    if not rows:
        return None
    x0, x1 = w, 0
    for y in rows:
        a, b = cur[y * w:(y + 1) * w], prev[y * w:(y + 1) * w]
        x0 = min(x0, _first_diff(a, b))
        x1 = max(x1, w - _first_diff(a[::-1], b[::-1]))
    return x0, rows[0], x1, rows[-1] + 1


def write_gif(path, frames, loop: int = 0) -> dict:
    """Writes `frames`, a list of (width, height, rgba, delay_ms), and returns what it wrote."""
    if not frames:
        raise ValueError("a GIF needs at least one frame")
    w, h = frames[0][0], frames[0][1]
    for fw, fh, rgba, _ in frames:
        if (fw, fh) != (w, h) or len(rgba) != fw * fh * 4:
            raise ValueError(f"every frame must be {w}x{h} RGBA, one is {fw}x{fh} with {len(rgba)} bytes")

    counts = Counter()
    for _, _, rgba, _ in frames:
        counts.update(_keys(rgba, False))
    coarse = len(counts) > EXACT_LIMIT
    if coarse:
        counts = Counter()
        for _, _, rgba, _ in frames:
            counts.update(_keys(rgba, True))
    palette, lut = _cut(counts, coarse, MAX_COLOURS)

    images = [bytes(map(lut.__getitem__, _keys(rgba, coarse))) for _, _, rgba, _ in frames]
    out = bytearray(b"GIF89a")
    out += struct.pack("<HHBBB", w, h, 0xF7, 0, 0)
    table = bytearray()
    for rgb in palette + [(0, 0, 0)] * (256 - len(palette)):
        table += bytes(rgb)
    out += table
    out += b"\x21\xFF\x0BNETSCAPE2.0\x03\x01" + struct.pack("<H", loop) + b"\x00"

    kept = []
    prev = None
    for img, (_, _, _, delay) in zip(images, frames):
        rect = (0, 0, w, h) if prev is None else _changed(img, prev, w, h)
        if rect is None:
            kept[-1][2] += delay
            continue
        kept.append([img, rect, delay, prev])
        prev = img

    for img, (x0, y0, x1, y1), delay, before in kept:
        rw = x1 - x0
        rows = []
        for y in range(y0, y1):
            row = img[y * w + x0:y * w + x1]
            if before is not None:
                old = before[y * w + x0:y * w + x1]
                row = bytes(TRANSPARENT if a == b else a for a, b in zip(row, old))
            rows.append(row)
        flags = (1 << 2) | (1 if before is not None else 0)
        cs = max(2, round(delay / 10))
        out += b"\x21\xF9\x04" + struct.pack("<BHB", flags, cs, TRANSPARENT) + b"\x00"
        out += b"\x2C" + struct.pack("<HHHHB", x0, y0, rw, y1 - y0, 0)
        out += b"\x08" + _blocks(_lzw(b"".join(rows)))
    out += b"\x3B"
    with open(path, "wb") as f:
        f.write(out)
    return {"frames": len(kept), "colours": len(palette), "coarse": coarse, "bytes": len(out), "size": (w, h)}
