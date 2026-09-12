"""Shell hollows a solid, and a CLOSED shell hollows it too.

Run:  python test_shell.py

Shelling with faces to open has always worked. Shelling with NO faces opened,
a sealed hollow, silently did the wrong thing: build123d's offset with no
openings shrinks the solid inward (a Minkowski offset), and OCCT's MakeThickSolid
cannot seal a void it has no open face to reach through, so both left a smaller
SOLID with no wall at all. A 40x40x20 box asked for a 2.5mm shell came back a
35x35x15 solid, no error, and nothing downstream could tell.

So the closed case carves the inward-offset inner solid out of the original
instead: outer minus inner is the wall. These pin that the envelope is kept and
the body is actually hollow.
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

import sys
import traceback

from build123d import Box

from builder import _shell

from OCP.BRepCheck import BRepCheck_Analyzer

PASS = "  ok"


def _bbox(shape):
    s = shape.bounding_box().size
    return (round(s.X, 3), round(s.Y, 3), round(s.Z, 3))


def test_a_closed_shell_keeps_the_envelope_and_hollows():
    box = Box(40, 40, 20)
    out = _shell(box, 2.5, [])
    # the OUTER shape is untouched: a shell adds an inner void, it does not shrink
    assert _bbox(out) == (40.0, 40.0, 20.0), _bbox(out)
    # 2.5mm walls: 32000 outer minus the 35x35x15 inner void = 13625
    assert abs(out.volume - 13625.0) < 1.0, out.volume
    # a sealed hollow is one solid bounded by two shells (outer + inner void)
    solids = out.solids()
    assert len(solids) == 1, len(solids)
    assert len(solids[0].shells()) == 2, len(solids[0].shells())
    assert BRepCheck_Analyzer(out.wrapped).IsValid(), "hollow is not a valid solid"
    print(PASS, "a closed shell keeps its 40x40x20 envelope and hollows to 13625 mm3")


def test_an_opened_shell_still_works():
    # The path that always worked must keep working: open the top face, and the
    # box becomes an open box (bbox unchanged, one shell, thin walls).
    box = Box(40, 40, 20)
    top = max(box.faces(), key=lambda f: f.center().Z)
    out = _shell(box, 2.5, [top])
    assert _bbox(out) == (40.0, 40.0, 20.0), _bbox(out)
    assert out.volume < 20000, out.volume  # hollow, not solid
    assert BRepCheck_Analyzer(out.wrapped).IsValid(), "opened shell invalid"
    print(PASS, "an opened shell still hollows and opens its face")


def test_a_wall_thicker_than_the_body_is_refused_not_silently_solid():
    # 30mm wall on a 40x40x20 box leaves no interior; that must raise the
    # "too thick" message, not hand back a mystery solid.
    box = Box(40, 40, 20)
    try:
        _shell(box, 30, [])
    except ValueError as ex:
        assert "thick" in str(ex).lower() or "wall" in str(ex).lower(), str(ex)
        print(PASS, "a wall thicker than the body is refused, not silently solid")
        return
    raise AssertionError("a 30mm wall on a 20mm-deep box should have raised")


if __name__ == "__main__":
    try:
        test_a_closed_shell_keeps_the_envelope_and_hollows()
        test_an_opened_shell_still_works()
        test_a_wall_thicker_than_the_body_is_refused_not_silently_solid()
        print("\nall shell tests passed")
    except Exception:
        traceback.print_exc()
        sys.exit(1)
