"""Which way a sketch profile faces, and therefore which way it extrudes.

Run:  python test_profile_orientation.py

A face inherits its orientation from the direction its wire runs, so a loop
wound clockwise makes a face pointing the opposite way from the sketch plane it
was drawn on. An extrude follows the face, so such a profile is pushed out of
the BACK of its own plane.

Every primitive (rectangle, circle, polygon) is wound anticlockwise by
construction and was never affected. The free-form branch is: a hand-drawn
polyline traced clockwise, and `slot`, whose edges are emitted right-side-first
and so are clockwise every single time.

It hid for as long as it did because the wrong direction still WORKS on a base
plane through the origin: a body centred there is on both sides of the sketch,
so a cut that goes backwards cuts anyway. Move the sketch onto a face, where
there is material on one side only, and the same slot removes nothing. Both
cases are here, because a fix verified only on the plane where it never failed
proves nothing.
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

import sys
import traceback

from build123d import Box, Pos

from builder import _build_sketch, _entity_edges, _face_from_wire, _faces_from_edges

VAL = float

SLOT = {"type": "slot", "x1": 0, "y1": -8, "x2": 0, "y2": 8, "width": 6}
# The plane of a wall face at y = -30, looking into the material.
WALL = {"origin": [0, -30, 0], "normal": [0, 1, 0], "xdir": [1, 0, 0]}


def sketch_normal(plane, entity):
    r = _build_sketch({"id": "s", "type": "sketch", "plane": plane, "entities": [entity]}, VAL)
    faces = r["sketch"].faces()
    assert len(faces) == 1, f"expected one profile face, got {len(faces)}"
    n = faces[0].normal_at()
    return (round(n.X, 6), round(n.Y, 6), round(n.Z, 6))


def test_a_slot_faces_the_way_its_plane_does():
    assert sketch_normal("XY", SLOT) == (0, 0, 1), sketch_normal("XY", SLOT)
    assert sketch_normal(WALL, SLOT) == (0, 1, 0), sketch_normal(WALL, SLOT)


def test_the_slot_wire_really_is_the_wrong_way_round():
    """THE CONTROL. Without the reversal the face points backwards, so a test
    that only asserted the fixed value could pass against geometry that was
    never wound the offending way in the first place."""
    edges = _entity_edges(SLOT, VAL)
    from build123d import Wire

    wires = Wire.combine(edges)
    assert len(wires) == 1
    raw = _face_from_wire(wires[0])
    assert raw.normal_at().Z < 0, "a slot's wire is no longer clockwise; this test is moot"
    fixed = _faces_from_edges(edges)
    assert len(fixed) == 1
    assert fixed[0].normal_at().Z > 0
    # and reversing is not resizing
    assert abs(fixed[0].area - raw.area) < 1e-9


def test_a_clockwise_polyline_is_turned_round_too():
    """The general case the slot is one instance of: the same square traced
    both ways has to come out facing the same direction."""
    ccw = [
        {"type": "line", "x1": -5, "y1": -5, "x2": 5, "y2": -5},
        {"type": "line", "x1": 5, "y1": -5, "x2": 5, "y2": 5},
        {"type": "line", "x1": 5, "y1": 5, "x2": -5, "y2": 5},
        {"type": "line", "x1": -5, "y1": 5, "x2": -5, "y2": -5},
    ]
    cw = [{**e, "x1": e["x2"], "y1": e["y2"], "x2": e["x1"], "y2": e["y1"]} for e in ccw]
    for name, ents in (("anticlockwise", ccw), ("clockwise", cw)):
        r = _build_sketch({"id": "s", "type": "sketch", "plane": WALL, "entities": ents}, VAL)
        n = r["sketch"].faces()[0].normal_at()
        assert (round(n.X, 6), round(n.Y, 6), round(n.Z, 6)) == (0, 1, 0), f"{name}: {n}"


def test_a_primitive_is_left_exactly_as_it_was():
    """Rectangles, circles and polygons were already right, and the fix must not
    be reaching them at all — they never go through the free-form branch."""
    for entity in (
        {"type": "rectangle", "width": 6, "height": 22, "x": 0, "y": 0},
        {"type": "circle", "radius": 4, "x": 0, "y": 0},
        {"type": "polygon", "x": 0, "y": 0, "radius": 6, "sides": 6, "angle": 0},
    ):
        assert sketch_normal(WALL, entity) == (0, 1, 0), entity["type"]


def test_a_slot_on_a_wall_actually_cuts_it():
    """The end to end case, which is what a vent slot in an enclosure is.

    The wall is 3mm of material starting at the sketch plane. Extruding 10mm
    the right way removes a slot's worth of it; the wrong way removes nothing
    at all, which is exactly what the bug reported."""
    wall = Pos(0, -28.5, 0) * Box(60, 3, 40)
    before = wall.volume
    r = _build_sketch({"id": "s", "type": "sketch", "plane": WALL, "entities": [SLOT]}, VAL)
    from build123d import extrude

    cutter = extrude(r["sketch"], amount=10)
    after = (wall - cutter).volume
    removed = before - after
    # the slot is 6 wide, 16 between centres -> 22 x 6 with round ends, x 3 deep
    assert removed > 300, f"removed only {removed:.1f} mm3"
    assert abs(removed - r["sketch"].area * 3) < 1e-3, removed


def main():
    failed = 0
    for name, fn in sorted(globals().items()):
        if not name.startswith("test_") or not callable(fn):
            continue
        try:
            fn()
            print(f"PASS {name}")
        except Exception:
            failed += 1
            print(f"FAIL {name}")
            traceback.print_exc()
    print("profile orientation:", "OK" if not failed else f"{failed} FAILED")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
