"""Per-face colours, packed small enough to live in the document.

A STEP written by a mechanical CAD system routinely colours FACES rather than
products: the reference PN532 assembly attaches a style to all 1,803 of its
faces and only a near-useless per-product default to its 29 products, so a
reader that only looks at product labels renders a red circuit board as a
uniform pale grey. The colours have to travel per face or they are not the
file's colours at all.

Per face is also a lot of them. The import feature carries this list in the
DOCUMENT, which is saved, loaded and sent over the wire on every rebuild, and a
3,000-body assembly has six figures of faces. So the list is packed twice over:
a palette (a file has a handful of distinct colours, not one per face) and
run-length encoding (faces of one colour are contiguous, because they are the
faces of one feature of one part). The reference file's 843-face circuit board
packs to 3 palette entries and a few dozen runs.

Pure list-to-list arithmetic, no OCCT: what a face IS lives in step_assembly,
where to put the answer lives in mesh_import, and this is only the shape of the
thing in between. `decode` is mirrored by src/document/faceColors.ts, and
test_face_colors.py checks the two agree on the same fixtures.
"""
from __future__ import annotations

#: The index a run carries for "this face has no colour of its own". Not None,
#: because these end up in JSON and a small int keeps a run two numbers wide.
NO_COLOR = -1


def encode(colors):
    """Pack a per-face colour list into {"palette": [...], "runs": [[n, i], ...]}.

    `colors` is one entry per face, in the shape's own face order: a "#rrggbb"
    string or None. Returns None when NO face carries a colour, which is the
    ordinary case (a modelled part, a mesh import, a STEP with no styles) and
    the one that must add nothing at all to the document.

    Run indices point into `palette`, or are NO_COLOR. The run lengths sum to
    len(colors), which is what lets `decode` rebuild the list without being told
    how long it was, and what lets a caller check the packing against the face
    count it already has.
    """
    if not colors or not any(c for c in colors):
        return None
    palette = []
    seen = {}
    runs = []
    for c in colors:
        if c:
            i = seen.get(c)
            if i is None:
                i = seen[c] = len(palette)
                palette.append(c)
        else:
            i = NO_COLOR
        if runs and runs[-1][1] == i:
            runs[-1][0] += 1
        else:
            runs.append([1, i])
    return {"palette": palette, "runs": runs}


def decode(enc, count):
    """Unpack to exactly `count` entries of "#rrggbb" or None.

    Tolerant on purpose. This reads a field of a saved document, which may have
    been written by an older build, hand-edited, or truncated, and the honest
    answer to a run that overruns is "those faces have no colour", never a
    raised exception in the middle of a rebuild. A run naming a palette slot
    that is not there is read the same way.
    """
    out = [None] * max(0, int(count))
    if not isinstance(enc, dict):
        return out
    palette = enc.get("palette") or []
    at = 0
    for run in enc.get("runs") or []:
        try:
            n, i = int(run[0]), int(run[1])
        except (TypeError, ValueError, IndexError):
            break
        if n <= 0:
            continue
        hexed = palette[i] if 0 <= i < len(palette) else None
        for k in range(at, min(at + n, len(out))):
            out[k] = hexed
        at += n
        if at >= len(out):
            break
    return out


def dominant(colors):
    """The colour to treat as the whole shape's own, or None.

    By face COUNT, not by area. Area is the better answer to "what colour does
    this part look" and it is not affordable here: it costs a surface
    integration per face, six figures of them on a large assembly, at import
    time where nothing else needs one. It matters less than it sounds like it
    should, because this is only the fallback for faces the file did not colour,
    and a file that colours faces at all colours nearly all of them (1,803 of
    1,803 on the reference assembly).
    """
    tally = {}
    for c in colors or ():
        if c:
            tally[c] = tally.get(c, 0) + 1
    if not tally:
        return None
    # max() over the items, with the count first, so ties fall to the colour
    # that appears earliest rather than to whichever way the dict happens to
    # iterate. A tie is a real possibility (two colours, half the faces each).
    best = None
    for c in colors:
        if c and (best is None or tally[c] > tally[best]):
            best = c
    return best
