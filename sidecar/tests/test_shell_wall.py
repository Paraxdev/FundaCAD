"""Extruding the WALL of a shell cross-section, not the hole inside it.

Run:  ../.venv/Scripts/python.exe test_shell_wall.py

Two rectangles, one inside the other, is how a shell cross-section is drawn. The
region between them is the wall; the region inside the inner rectangle is a
separate cell that happens to be much larger. Selecting the wall and extruding it
has to produce the wall.

This is a REGRESSION guard rather than a fix. The path here resolves a region
from the stored interior point, which is by definition a point in the material
and outside every hole, so it lands in the wall cell and the smallest-containing
cell rule keeps it there. What this pins is that it stays that way.

The failure it guards against is specific and has been shipped elsewhere:
deriving the region's anchor from the entities that BOUND it instead. A
region's boundary list names its outer loop, and an outer rectangle's four lines
rebuild as exactly one face, so a "did I get a single face?" guard passes and the
centre of that face is returned. That centre is inside the hole, and the extrude
then produces the inner block. A face-count guard cannot catch it either, because
the circle version of the same drawing gives two faces and refuses correctly
while the rectangle version gives one and sails through.

The area check below is the reason a "largest face" heuristic cannot be the fix:
on these dimensions the hole is nearly twice the wall.
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

from builder import rebuild

PASS = "  ok"

OUTER = 100.0
INNER = 80.0
DEPTH = 10.0

WALL_AREA = OUTER * OUTER - INNER * INNER   # 3600
HOLE_AREA = INNER * INNER                   # 6400


def _shell_sketch():
    """Two concentric rectangles on XY, centred on the origin."""
    return {"id": "s", "type": "sketch", "plane": "XY", "entities": [
        {"type": "rectangle", "id": "outer", "width": OUTER, "height": OUTER},
        {"type": "rectangle", "id": "inner", "width": INNER, "height": INNER}]}


def _extrude(region_point):
    doc = {"parameters": {}, "features": [
        _shell_sketch(),
        {"id": "e", "type": "extrude", "sketch": "s", "distance": DEPTH,
         "operation": "new", "regions": [region_point]}]}
    part, err, bodies = rebuild(doc)
    assert not err, f"rebuild reported {err}"
    assert part is not None, "no solid"
    return part


def test_the_wall_extrudes_as_the_wall():
    # A point in the material: between the two rectangles, on the +x side.
    wall_point = [(INNER / 2 + OUTER / 2) / 2, 0, 0]
    assert INNER / 2 < wall_point[0] < OUTER / 2, "the test's own anchor is not in the wall"

    part = _extrude(wall_point)
    want = WALL_AREA * DEPTH
    got = part.volume
    assert abs(got - want) < 1.0, (
        f"extruding the shell wall gave {got:.0f}mm3; the wall is {want:.0f} and "
        f"the inner block would be {HOLE_AREA * DEPTH:.0f}")
    print(f"{PASS} the wall extrudes as the wall: {got:.0f}mm3, hole would be "
          f"{HOLE_AREA * DEPTH:.0f}")


def test_the_hole_is_still_selectable_on_its_own():
    """The counter-check. If the wall test passed because holes are ignored
    outright, this would produce the wall too, and the pair would prove nothing
    about which cell was chosen."""
    part = _extrude([0, 0, 0])  # dead centre, inside the inner rectangle
    want = HOLE_AREA * DEPTH
    got = part.volume
    assert abs(got - want) < 1.0, (
        f"a point inside the inner rectangle should extrude that cell "
        f"({want:.0f}mm3), got {got:.0f}")
    print(f"{PASS} a point in the inner cell still extrudes the inner cell: {got:.0f}mm3")


def test_the_hole_is_the_larger_cell():
    """Why 'pick the largest face' cannot stand in for this. Stated as a fact
    about the numbers so it survives someone changing the dimensions."""
    assert HOLE_AREA > WALL_AREA, (
        "these dimensions no longer make the hole larger than the wall, so the "
        "tests above no longer rule out a largest-face heuristic")
    print(f"{PASS} the hole ({HOLE_AREA:.0f}mm2) is larger than the wall "
          f"({WALL_AREA:.0f}mm2), so area cannot pick the region")


if __name__ == "__main__":
    print("shell wall region:")
    test_the_hole_is_the_larger_cell()
    test_the_wall_extrudes_as_the_wall()
    test_the_hole_is_still_selectable_on_its_own()
    print("all shell wall tests passed")
