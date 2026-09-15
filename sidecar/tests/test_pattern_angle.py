"""A rectangular sketch pattern can march along an angled pair of axes.

`patternRect` gained an optional `angle` (degrees) that turns the grid's own
axes, so copy (i,j) sits at the source plus (i*spacingX, j*spacingY) rotated by
that angle. Absent or 0 it has to build exactly what it always did, otherwise
every saved document shifts by float noise the first time it is rebuilt.

The risk here is a split brain. The preview comes from src/sketch/pattern.ts
(expandPattern) and the solid from builder._expand_pattern, so the positions are
asserted against the same numbers tests/sketch/pattern.test.ts asserts.
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

import math
import sys
import traceback

from builder import _expand_pattern


def _val(v):
    return float(v)


SRC = {"type": "circle", "id": "c1", "radius": 2, "x": 0, "y": 0}


def _pat(**kw):
    p = {"id": "p1", "type": "patternRect", "sources": ["c1"],
         "countX": 3, "countY": 2, "spacingX": 10, "spacingY": 5}
    p.update(kw)
    return p


def _expand(**kw):
    return _expand_pattern(_pat(**kw), {"c1": SRC}, _val)


def test_no_angle_builds_what_it_always_did():
    plain, zero = _expand(), _expand(angle=0)
    assert plain == zero, (plain, zero)
    assert [(e["x"], e["y"]) for e in plain] == [(0, 5), (10, 0), (10, 5), (20, 0), (20, 5)], plain
    print("angle absent or 0 is exact OK")


def test_ninety_degrees_turns_a_row_into_a_column():
    """Degrees, not radians: a 90 that barely moves is the classic silent bug."""
    out = _expand(countY=1, angle=90)
    assert len(out) == 2, out
    for k, e in enumerate(out):
        assert abs(e["x"]) < 1e-12 and abs(e["y"] - (k + 1) * 10) < 1e-12, e
    print("90 degrees turns the 3-across row into a 3-up column OK")


def test_forty_five_puts_copy_one_on_the_diagonal():
    e = _expand(countX=2, countY=1, angle=45)[0]
    assert abs(e["x"] - 10 * math.cos(math.pi / 4)) < 1e-12, e
    assert abs(e["y"] - 10 * math.sin(math.pi / 4)) < 1e-12, e
    print("copy 1 sits at spacing * (cos45, sin45) OK")


def test_the_grid_matches_the_frontends_to_the_last_digit():
    """The same numbers tests/sketch/pattern.test.ts asserts. This is the seam."""
    want = [
        (-3.5355339059327373, 3.5355339059327378),
        (7.0710678118654755, 7.071067811865475),
        (3.535533905932738, 10.606601717798213),
        (14.142135623730951, 14.14213562373095),
        (10.606601717798213, 17.67766952966369),
    ]
    out = _expand(angle=45)
    assert len(out) == len(want), out
    for e, (wx, wy) in zip(out, want):
        assert abs(e["x"] - wx) < 1e-12 and abs(e["y"] - wy) < 1e-12, (e, wx, wy)
    assert [e["id"] for e in out] == [f"p1#{k}" for k in range(5)], out
    print("the angled grid agrees with the frontend OK")


if __name__ == "__main__":
    try:
        test_no_angle_builds_what_it_always_did()
        test_ninety_degrees_turns_a_row_into_a_column()
        test_forty_five_puts_copy_one_on_the_diagonal()
        test_the_grid_matches_the_frontends_to_the_last_digit()
        print("\nall pattern-angle tests passed")
    except Exception:
        traceback.print_exc()
        sys.exit(1)
