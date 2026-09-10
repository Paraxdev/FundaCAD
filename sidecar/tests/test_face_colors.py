"""Packing per-face colours small enough to keep.

This is the format a coloured import lives in: it goes into the saved document
and into the head frame of every rebuild reply, one entry per face, six figures
of them on a large assembly. So the two properties that matter are that it
round-trips exactly, and that it stays small on the shape real files have.

src/document/faceColors.ts holds the decoder for the other side of the wire, and
tests/document/faceColors.test.ts checks it against the fixtures below.
"""

from __future__ import annotations

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

import json

import face_colors

RED, WHITE, GREY = "#ff2b2b", "#ffffff", "#3b3b3b"

# The shapes both sides are checked against. Kept as data, and printed at the
# end, so the TypeScript test can be read beside this one and seen to use the
# same cases rather than a paraphrase of them.
CASES = [
    ("uniform", [RED] * 5),
    ("two runs", [RED, RED, WHITE, WHITE, WHITE]),
    ("holes", [RED, None, None, WHITE]),
    ("alternating", [RED, WHITE, RED, WHITE]),
    ("one face", [GREY]),
    # 826 pale faces and 16 red ones is the reference circuit board's actual
    # shape: nearly all of it one colour with the visible surfaces elsewhere.
    ("board-like", [WHITE] * 400 + [RED] * 16 + [WHITE] * 427),
]


def test_round_trip():
    for name, colors in CASES:
        enc = face_colors.encode(colors)
        assert enc is not None, name
        got = face_colors.decode(enc, len(colors))
        assert got == colors, f"{name}: {got[:8]} != {colors[:8]}"
    print("  round trip: %d cases" % len(CASES))


def test_nothing_to_say_costs_nothing():
    # The ordinary import. `None` rather than an empty packing, because the
    # caller's test is `if packed:` and an empty dict in the document would be a
    # key that means nothing and still has to be read, written and diffed.
    assert face_colors.encode([]) is None
    assert face_colors.encode([None, None, None]) is None
    assert face_colors.encode(None) is None


def test_packing_is_actually_small():
    # CONTROL on the whole idea. If this ever fails, the packing is not earning
    # its complexity and the list should just be sent raw.
    _name, board = CASES[-1]
    packed = len(json.dumps(face_colors.encode(board)))
    raw = len(json.dumps(board))
    assert packed < raw / 20, f"packed {packed} vs raw {raw}"
    print("  board-like: %d faces, %d bytes packed against %d raw" % (len(board), packed, raw))


def test_decode_survives_a_document_it_did_not_write():
    # Every one of these is something a hand-edited or older document can hold,
    # and none of them may raise in the middle of a rebuild.
    n = 4
    assert face_colors.decode(None, n) == [None] * n
    assert face_colors.decode({}, n) == [None] * n
    assert face_colors.decode({"palette": [RED], "runs": [[99, 0]]}, n) == [RED] * n
    assert face_colors.decode({"palette": [RED], "runs": [[2, 0]]}, n) == [RED, RED, None, None]
    assert face_colors.decode({"palette": [], "runs": [[2, 7]]}, n) == [None] * n
    assert face_colors.decode({"palette": [RED], "runs": [["x", 0]]}, n) == [None] * n
    assert face_colors.decode({"palette": [RED], "runs": [[2, 0]]}, 0) == []


def test_dominant():
    assert face_colors.dominant([RED, RED, WHITE]) == RED
    assert face_colors.dominant([None, None]) is None
    assert face_colors.dominant([]) is None
    # A tie goes to the colour that appears first, so the answer cannot depend
    # on dict iteration order.
    assert face_colors.dominant([WHITE, RED]) == WHITE
    assert face_colors.dominant([RED, WHITE]) == RED
    # Uncoloured faces do not vote. This is the fallback FOR them.
    assert face_colors.dominant([None, None, None, RED]) == RED


def test_fixtures_for_the_other_side():
    """Print the shared fixtures, so the TS test can be checked against them."""
    for name, colors in CASES:
        print("  %-12s %s" % (name, json.dumps(face_colors.encode(colors))))


if __name__ == "__main__":
    for fn in [v for k, v in sorted(globals().items()) if k.startswith("test_")]:
        print(fn.__name__)
        fn()
    print("face_colors OK")
