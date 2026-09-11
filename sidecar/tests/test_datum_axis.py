"""A datum axis can be anchored to a model edge, and keeps following it.

A datum axis is reference geometry with no body. Anchored to a straight edge by
`axisEdge`, the sidecar re-resolves that edge on every rebuild and reports the
resolved line in the `datum_marks` header, so the axis FOLLOWS the part instead
of freezing where the edge used to be. A baked axis (no `axisEdge`) sits at a
coordinate the document already carries and is deliberately absent from the
header. This mirrors test_revolve_axis.py, one layer down: there the resolved
edge aims a revolve, here it places a datum.

Run: uv run python tests/test_datum_axis.py
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

from builder import rebuild

PASS = "  ok"

W, H = 60.0, 20.0
EDGE_XY = (30.0, 30.0)  # a vertical edge of the plate, a line parallel to Z
EDGE_SEL = {"kind": "edge", "by": "nearest", "point": [*EDGE_XY, H / 2]}

BLOCK = [
    {"id": "f1", "type": "sketch", "plane": "XY",
     "entities": [{"type": "rectangle", "id": "e0", "width": W, "height": W, "x": 0, "y": 0}]},
    {"id": "f2", "type": "extrude", "sketch": "f1", "distance": H,
     "operation": "new", "regions": [[0, 0, 0]], "hiddenBodies": []},
]


def marks(features):
    dm = {}
    doc = {"parameters": {}, "paramDefs": {}, "version": 8, "features": features}
    _, errs, _ = rebuild(doc, diagnostics=[], datum_marks_out=dm)
    return errs, dm


def test_an_edge_anchored_axis_resolves_to_the_edge_line():
    da = {"id": "da", "type": "datumAxis", "origin": [0, 0, 0], "dir": [0, 0, 1],
          "axisEdge": EDGE_SEL}
    errs, dm = marks([*BLOCK, da])
    assert errs == [], errs
    assert "da" in dm and dm["da"]["kind"] == "axis", dm
    o, d = dm["da"]["origin"], dm["da"]["dir"]
    assert abs(o[0] - EDGE_XY[0]) < 1e-6 and abs(o[1] - EDGE_XY[1]) < 1e-6, o
    assert abs(abs(d[2]) - 1) < 1e-6 and abs(d[0]) < 1e-6 and abs(d[1]) < 1e-6, d
    print(PASS, "an edge-anchored axis reports the edge's own line, not its baked cache")


def test_the_axis_follows_the_edge_when_the_part_changes():
    """The whole point of a reference over a line: widen the plate, the +x edge
    moves from x=30 to x=(W+20)/2=40, and the datum has to move with it."""
    wider = [{**BLOCK[0], "entities": [
        {"type": "rectangle", "id": "e0", "width": W + 20, "height": W, "x": 0, "y": 0}]},
        BLOCK[1]]
    da = {"id": "da", "type": "datumAxis", "origin": [EDGE_XY[0], EDGE_XY[1], 0],
          "dir": [0, 0, 1], "axisEdge": EDGE_SEL}
    errs, dm = marks([*wider, da])
    assert errs == [], errs
    assert "da" in dm, dm
    assert abs(dm["da"]["origin"][0] - (W + 20) / 2) < 1e-6, \
        f'the axis stayed at the old edge (x {dm["da"]["origin"][0]})'
    print(PASS, "widening the plate moves the datum axis with the edge")


def test_a_baked_axis_is_not_in_the_header():
    """CONTROL: a baked axis (no axisEdge) resolves to nothing here on purpose,
    the frontend draws it straight from the document's own coordinates."""
    da = {"id": "db", "type": "datumAxis", "origin": [1, 2, 3], "dir": [0, 1, 0]}
    errs, dm = marks([*BLOCK, da])
    assert errs == [], errs
    assert "db" not in dm, dm
    print(PASS, "a baked axis stays out of the follow header")


def test_an_edge_that_stops_resolving_falls_back():
    """CONTROL: an anchor that resolves to nothing is not an error and is simply
    absent from the header, so the frontend falls back to the baked line rather
    than the datum vanishing."""
    da = {"id": "dc", "type": "datumAxis", "origin": [0, 0, 0], "dir": [0, 0, 1],
          "axisEdge": {"kind": "edge", "by": "nearest", "point": [9999, 9999, 9999]}}
    errs, dm = marks([*BLOCK, da])
    assert errs == [], errs
    assert "dc" not in dm, dm
    print(PASS, "an unresolvable anchor falls back to the cache, without an error")


if __name__ == "__main__":
    test_an_edge_anchored_axis_resolves_to_the_edge_line()
    test_the_axis_follows_the_edge_when_the_part_changes()
    test_a_baked_axis_is_not_in_the_header()
    test_an_edge_that_stops_resolving_falls_back()
    print("\nall datum-axis tests passed")
