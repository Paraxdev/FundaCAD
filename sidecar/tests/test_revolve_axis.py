"""A revolve can spin about an edge of the model, and keeps spinning when it moves.

The axis used to be one of the three WORLD axes and nothing else, so anything
turned about a feature of the part had to be modelled at the origin and moved
afterwards — and moved again by hand every time the part changed. `axisEdge` is
a reference re-resolved on every rebuild, with the resolved line kept beside it
as a cache so an edge that stops resolving leaves the revolve where it was
rather than failing the feature and taking the body with it.

Run: uv run python tests/test_revolve_axis.py
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

from builder import rebuild, _solid_volume

PASS = "  ok"

W, H = 60.0, 20.0
R = 3.0            # the profile circle
PX, PZ = 45.0, 40.0  # where it sits, clear of the plate
EDGE_XY = (30.0, 30.0)  # a vertical edge of the plate

BLOCK = [
    {"id": "f1", "type": "sketch", "plane": "XY",
     "entities": [{"type": "rectangle", "id": "e0", "width": W, "height": W, "x": 0, "y": 0}]},
    {"id": "f2", "type": "extrude", "sketch": "f1", "distance": H,
     "operation": "new", "regions": [[0, 0, 0]], "hiddenBodies": []},
    {"id": "f3", "type": "sketch", "plane": "XZ",
     "entities": [{"type": "circle", "id": "c1", "radius": R, "x": PX, "y": PZ}]},
]
PROFILE = [PX, 0, PZ]


def build(rev):
    doc = {"parameters": {}, "paramDefs": {}, "version": 8, "features": [*BLOCK, rev]}
    part, errs, bodies = rebuild(doc, diagnostics=[])
    return errs, bodies


def spun(bodies):
    return bodies[-1]["shape"]


def centre_and_major(bodies):
    """Where the ring is centred in XY, and its major radius, read off the box."""
    bb = spun(bodies).bounding_box()
    cx, cy = (bb.min.X + bb.max.X) / 2, (bb.min.Y + bb.max.Y) / 2
    return (cx, cy), (bb.max.X - bb.min.X) / 2


def test_a_world_axis_still_works():
    errs, bodies = build({"id": "f4", "type": "revolve", "sketch": "f3", "axis": "Z",
                          "angle": 360, "operation": "new", "regions": [PROFILE]})
    assert errs == [], errs
    (cx, cy), major = centre_and_major(bodies)
    assert abs(cx) < 1e-6 and abs(cy) < 1e-6, (cx, cy)
    assert abs(major - (PX + R)) < 1e-6, major
    print(PASS, "a world axis spins about the world origin, as it always did")


def test_a_picked_edge_becomes_the_axis():
    """CONTROL against the test above: the edge is a line PARALLEL to Z, so a
    revolve that ignored `axisEdge` and fell through to `axis` would produce the
    world-Z ring exactly and pass any test that only checked the shape is a ring."""
    rev = {"id": "f4", "type": "revolve", "sketch": "f3", "axis": "Z",
           "axisEdge": {"kind": "edge", "by": "nearest", "point": [*EDGE_XY, H / 2]},
           "angle": 360, "operation": "new", "regions": [PROFILE]}
    errs, bodies = build(rev)
    assert errs == [], errs
    (cx, cy), major = centre_and_major(bodies)
    assert abs(cx - EDGE_XY[0]) < 1e-6 and abs(cy - EDGE_XY[1]) < 1e-6, (cx, cy)
    # farthest point of the profile from the edge, in XY
    far = (((PX + R) - EDGE_XY[0]) ** 2 + EDGE_XY[1] ** 2) ** 0.5
    assert abs(major - far) < 1e-6, (major, far)
    print(PASS, "a picked edge is the axis, not the world axis cached beside it")


def test_the_axis_follows_the_edge_when_the_part_changes():
    """The whole point of storing a reference rather than a line. Widen the plate
    and the edge moves; the ring has to move with it."""
    wider = [dict(BLOCK[0]), *BLOCK[1:]]
    wider[0] = {**BLOCK[0], "entities": [
        {"type": "rectangle", "id": "e0", "width": W + 20, "height": W, "x": 0, "y": 0}]}
    rev = {"id": "f4", "type": "revolve", "sketch": "f3", "axis": "Z",
           "axisEdge": {"kind": "edge", "by": "nearest", "point": [*EDGE_XY, H / 2]},
           "angle": 360, "operation": "new", "regions": [PROFILE]}
    doc = {"parameters": {}, "paramDefs": {}, "version": 8, "features": [*wider, rev]}
    _, errs, bodies = rebuild(doc, diagnostics=[])
    assert errs == [], errs
    (cx, cy), _ = centre_and_major(bodies)
    assert abs(cx - (W + 20) / 2) < 1e-6, f"the axis stayed at the old edge (x {cx})"
    assert abs(cy - EDGE_XY[1]) < 1e-6, cy
    print(PASS, "widening the plate moves the axis with the edge")


def test_an_edge_that_stops_resolving_falls_back_to_the_cache():
    """CONTROL that must fail if a lost reference raised: a revolve is often the
    body itself, and failing the feature deletes it from the screen. Falling back
    leaves it where the user last saw it."""
    rev = {"id": "f4", "type": "revolve", "sketch": "f3",
           "axis": {"origin": [0, 0, 0], "dir": [0, 0, 1]},
           "axisEdge": {"kind": "edge", "by": "nearest", "point": [9999, 9999, 9999]},
           "angle": 360, "operation": "new", "regions": [PROFILE]}
    errs, bodies = build(rev)
    assert errs == [], errs
    (cx, cy), major = centre_and_major(bodies)
    assert abs(cx) < 1e-6 and abs(cy) < 1e-6, (cx, cy)
    assert abs(major - (PX + R)) < 1e-6, major
    print(PASS, "an unresolvable edge falls back to the cached line, without an error")


def test_a_cached_line_can_be_any_line():
    """The cache is a full line, not a world axis in disguise: a saved revolve
    whose edge is gone has to keep an axis that was never axis-aligned."""
    rev = {"id": "f4", "type": "revolve", "sketch": "f3",
           "axis": {"origin": [20, 0, 0], "dir": [0, 0, 1]},
           "angle": 360, "operation": "new", "regions": [PROFILE]}
    errs, bodies = build(rev)
    assert errs == [], errs
    (cx, cy), _ = centre_and_major(bodies)
    assert abs(cx - 20) < 1e-6 and abs(cy) < 1e-6, (cx, cy)
    print(PASS, "an arbitrary cached line is spun about, not the nearest world axis")


if __name__ == "__main__":
    test_a_world_axis_still_works()
    test_a_picked_edge_becomes_the_axis()
    test_the_axis_follows_the_edge_when_the_part_changes()
    test_an_edge_that_stops_resolving_falls_back_to_the_cache()
    test_a_cached_line_can_be_any_line()
    print("ALL PASS")
